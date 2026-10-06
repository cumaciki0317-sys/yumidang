-- 민규: source79 이후 빈 합성 큐 전용. 실제 운영·회원 자료에 실행하지 않는다.
begin;
set local plpgsql.check_asserts=on;
do $$begin
 if exists(select 1 from private.worker_jobs)or exists(select 1 from private.worker_job_run_fences)
 or exists(select 1 from private.global_worker_run where token is not null)then raise exception 'scratch_worker_must_be_idle';end if;
 if to_regclass('private.report_purge_control')is null then raise exception 'source79_required';end if;
end;$$;
create temp table claim_role_baseline as select md5(jsonb_agg(to_jsonb(r)order by oid)::text)hash from pg_roles r;
create temp table claim_table_acl_baseline as select oid,relacl::text acl from pg_class where relnamespace in('public'::regnamespace,'private'::regnamespace);
create function pg_temp.expect_code(sql text,code text)returns void language plpgsql as $$
declare got text;begin
 begin execute sql;exception when others then get stacked diagnostics got=returned_sqlstate;end;
 assert got=code,'expected_sqlstate';
end;$$;
do $$declare role_name text;sig text;begin
 foreach role_name in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
 foreach sig in array array['public.claim_supported_job(uuid,integer,uuid,text[])',
 'private.claim_supported_worker_job(uuid,integer,uuid,text[])','private.supported_worker_kind_ready(text)']loop
 assert not has_function_privilege(role_name,sig,'EXECUTE'),'new_claim_acl_must_be_closed';end loop;end loop;
 assert not has_function_privilege('service_role','public.claim_job(uuid,integer)','EXECUTE'),'legacy2_closed';
 assert has_function_privilege('service_role','public.claim_job(uuid,integer,uuid)','EXECUTE'),'legacy3_compatible';
end;$$;
-- 테스트 트랜잭션에서만 신규 공개 포트를 준비한다. private helper는 grant하지 않는다.
grant execute on function public.claim_supported_job(uuid,integer,uuid,text[])to service_role;
create temp table claim_fixture_ids(kind text,state text,id uuid primary key);
create temp table claim_unsupported_snapshot as select j.*from private.worker_jobs j where false;

do $$declare global_token uuid;worker uuid:=gen_random_uuid();k text;st text;v_id uuid;payload jsonb;
 result jsonb;lease uuid;old_lease uuid;review_id uuid;global_expiry timestamptz;sig text;begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 global_token:=(public.acquire_worker_run(180,null)->>'token')::uuid;
 select expires_at into global_expiry from private.global_worker_run where singleton;
 foreach k in array array['cancellation_safety','report_retention']loop
 foreach st in array array['queued','retry_wait','running']loop
 payload:=case k when 'cancellation_safety'then jsonb_build_object('identityId',gen_random_uuid(),'generation',1)
 else jsonb_build_object('reportId',gen_random_uuid(),'closureProofId',gen_random_uuid())end;
 insert into private.worker_jobs(kind,dedupe_key,payload,status,available_at,worker_id,lease_token,lease_expires_at)
 values(k,'synthetic-scope-'||gen_random_uuid(),payload,st,clock_timestamp()-interval '2 days',
 case when st='running'then worker end,case when st='running'then gen_random_uuid()end,
 case when st='running'then clock_timestamp()-interval '1 day'end)returning worker_jobs.id into v_id;
 insert into claim_fixture_ids values(k,st,v_id);
 end loop;end loop;
 insert into claim_unsupported_snapshot select j.*from private.worker_jobs j;
 -- 리뷰가 없으면 기존 두 overload 모두 NULL이며 지원하지 않는 큐는 만지지 않는다.
 assert public.claim_job(worker,180,global_token)='{"job":null}'::jsonb;
 assert public.claim_job(worker,180)='{"job":null}'::jsonb;
 assert not exists((select *from claim_unsupported_snapshot except select *from private.worker_jobs)
 union all(select *from private.worker_jobs except select *from claim_unsupported_snapshot));
 assert not exists(select 1 from private.worker_job_run_fences);
 -- 등록된 supportedKinds도 승인false인 종류는 점유하지 않는다.
 assert public.claim_supported_job(worker,180,global_token,array['cancellation_safety','report_retention'])='{"job":null}'::jsonb;
 foreach sig in array array['null::text[]','array[]::text[]','array[''review_summary'',''review_summary'']',
 'array[''review_summary'',null]','array[''event_sync'']','array[[''review_summary'']]']loop
 perform pg_temp.expect_code(format('select public.claim_supported_job(%L::uuid,180,%L::uuid,%s)',worker,global_token,sig),'22023');end loop;
 perform pg_temp.expect_code(format('select public.claim_supported_job(%L::uuid,180,%L::uuid,array[''review_summary''])',worker,gen_random_uuid()),'40001');
 -- 기존 legacy3 wire7/lease clamp/failedAttempts 및 만료 재점유와 옛 점유 거절.
 insert into private.worker_jobs(kind,dedupe_key,payload,available_at,failed_attempts)values('review_summary','synthetic-review-'||gen_random_uuid(),
 jsonb_build_object('profileId',gen_random_uuid(),'sourceRevision','0','modelVersion','synthetic','promptVersion','synthetic'),clock_timestamp(),2)
 returning worker_jobs.id into review_id;
 execute 'set local role service_role';
 result:=public.claim_job(worker,86400,global_token)->'job';
 execute 'reset role';lease:=(result->>'leaseToken')::uuid;
 assert result-array['jobId','kind','payload','leaseToken','leaseExpiresAt','attempt','failedAttempts']='{}'::jsonb
 and (select count(*)from jsonb_object_keys(result))=7;
 assert(result->>'jobId')::uuid=review_id and result->>'kind'='review_summary'and(result->>'failedAttempts')::bigint=2;
 assert(result->>'leaseExpiresAt')::timestamptz<=global_expiry;
 old_lease:=lease;
 update private.worker_jobs set lease_expires_at=clock_timestamp()-interval '1 second'where worker_jobs.id=review_id;
 result:=public.claim_supported_job(worker,180,global_token,array['review_summary'])->'job';lease:=(result->>'leaseToken')::uuid;
 assert lease<>old_lease and(result->>'attempt')::bigint=2;
 perform pg_temp.expect_code(format('select public.complete_job(%L::uuid,%L::uuid,%L::uuid)',review_id,old_lease,global_token),'40001');
 perform public.complete_job(review_id,lease,global_token);
 assert not exists(select 1 from private.worker_job_run_fences where job_id=review_id);
 assert not exists(select 1 from claim_unsupported_snapshot s join private.worker_jobs j on j.id=s.id where to_jsonb(j)<>to_jsonb(s));
 -- kind readiness: 승인만 true여도 누락 EXEC가 있으면 선택하지 않는다.
 update private.cancellation_due_control set enabled=true where singleton;
 update private.report_purge_control set enabled=true where singleton;
 assert public.claim_supported_job(worker,180,global_token,array['cancellation_safety','report_retention'])='{"job":null}'::jsonb;
 -- 필요한 RPC 모두 owner에 의해 합성 준비한 뒤만 점유한다. 전체 ROLLBACK으로 닫힌 상태를 복원한다.
 foreach sig in array array['public.enqueue_cancellation_safety_due(integer,uuid)','public.process_cancellation_safety_due(uuid,bigint,uuid,uuid,uuid)',
 'public.enqueue_report_retention_purges(uuid,integer)','public.claim_report_retention_task(uuid,uuid,uuid)',
 'public.check_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid)','public.get_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid)',
 'public.record_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid,text)','public.complete_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid,text)',
 'public.purge_report_retention_terminal_receipts(uuid,integer)']loop
 execute format('grant execute on function %s to service_role',sig);end loop;
 -- terminal 30일 정리 EXEC가 폐쇄된 경우도 새 report 점유를 막는다.
 revoke execute on function public.purge_report_retention_terminal_receipts(uuid,integer)from service_role;
 assert public.claim_supported_job(worker,180,global_token,array['report_retention'])='{"job":null}'::jsonb;
 grant execute on function public.purge_report_retention_terminal_receipts(uuid,integer)to service_role;
 -- control 행이 없어도 NULL 승인을 true처럼 처리하지 않는다. owner 합성 변경을 즉시 rollback한다.
 begin
 delete from private.report_purge_control where singleton;
 delete from private.cancellation_due_control where singleton;
 assert public.claim_supported_job(worker,180,global_token,array['cancellation_safety','report_retention'])='{"job":null}'::jsonb;
 assert public.claim_job(worker,180,global_token)='{"job":null}'::jsonb;
 raise exception 'synthetic_guard_restore'using errcode='P0001';
 exception when raise_exception then null;end;
 assert(select enabled from private.report_purge_control where singleton);
 assert(select enabled from private.cancellation_due_control where singleton);
 -- 일부 EXEC 철회도 준비되지 않은 종류를 NULL로 숨긴다.
 revoke execute on function public.complete_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid,text)from service_role;
 assert public.claim_supported_job(worker,180,global_token,array['report_retention'])='{"job":null}'::jsonb;
 grant execute on function public.complete_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid,text)to service_role;
 execute 'set local role service_role';
 result:=public.claim_supported_job(worker,180,global_token,array['report_retention'])->'job';
 execute 'reset role';
 assert result->>'kind'='report_retention';v_id:=(result->>'jobId')::uuid;lease:=(result->>'leaseToken')::uuid;
 assert exists(select 1 from private.worker_job_run_fences where job_id=v_id and job_lease_token=lease and worker_run_token=global_token);
 perform public.complete_job(v_id,lease,global_token);
 result:=public.claim_supported_job(worker,180,global_token,array['cancellation_safety'])->'job';
 assert result->>'kind'='cancellation_safety';v_id:=(result->>'jobId')::uuid;lease:=(result->>'leaseToken')::uuid;
 perform public.complete_job(v_id,lease,global_token);
 -- oldclaim은 oldclaim은 승인된 신규 종류가 있어도 남은 신규 작업을 점유하지 않는다.
 assert public.claim_job(worker,180,global_token)='{"job":null}'::jsonb;
 assert public.claim_job(worker,180)='{"job":null}'::jsonb;
 perform public.release_worker_run(global_token);
 perform pg_temp.expect_code(format('select public.claim_job(%L::uuid,180,%L::uuid)',worker,global_token),'40001');
 perform pg_temp.expect_code(format('select public.claim_job(%L::uuid,180)',worker),'40001');
end;$$;

-- 실제 trigger를 거친 중도 global 만료가 job UPDATE와 fence INSERT 전체를 되돌리는지 검증한다.
create function pg_temp.expire_claim_global()returns trigger language plpgsql as $$begin
 if new.dedupe_key='synthetic-expiry'and new.status='running'then
 update private.global_worker_run set expires_at=clock_timestamp()-interval '1 second'where singleton;end if;return new;end;$$;
create trigger synthetic_claim_expiry after update on private.worker_jobs for each row execute function pg_temp.expire_claim_global();
do $$declare tok uuid;v_id uuid;r jsonb;before_row jsonb;begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 tok:=(public.acquire_worker_run(180,null)->>'token')::uuid;
 insert into private.worker_jobs(kind,dedupe_key,payload,available_at)values('review_summary','synthetic-expiry',
 jsonb_build_object('profileId',gen_random_uuid(),'sourceRevision','0','modelVersion','synthetic','promptVersion','synthetic'),clock_timestamp())returning worker_jobs.id into v_id;
 select to_jsonb(j)into before_row from private.worker_jobs j where j.id=v_id;
 perform pg_temp.expect_code(format('select public.claim_supported_job(%L::uuid,180,%L::uuid,array[''review_summary''])',gen_random_uuid(),tok),'40001');
 assert(select to_jsonb(j)from private.worker_jobs j where j.id=v_id)=before_row;
 assert not exists(select 1 from private.worker_job_run_fences where job_id=v_id);
 assert(select expires_at>clock_timestamp()from private.global_worker_run where singleton);
 perform public.release_worker_run(tok);
end;$$;
-- 사용자와 큐 전용 LOGIN 경계는 준비 후에도 열지 않는다.
set local role authenticated;
select pg_temp.expect_code('select public.claim_supported_job(gen_random_uuid(),180,null,array[''review_summary''])','42501');
reset role;
do $$begin
 assert(select hash from claim_role_baseline)=(select md5(jsonb_agg(to_jsonb(r)order by oid)::text)from pg_roles r);
 assert not exists(select 1 from claim_table_acl_baseline b join pg_class c using(oid)where c.relacl::text is distinct from b.acl);
end;$$;
rollback;
