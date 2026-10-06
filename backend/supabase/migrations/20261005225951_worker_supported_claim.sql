-- 민규: 지원하지 않는 작업은 점유 전에 제외한다. 신규 실행 권한은 열지 않는다.
begin;
create temp table supported_claim_baseline on commit drop as
 select oid,proowner,proacl::text acl,proconfig::text config from pg_proc
 where oid in('public.claim_job(uuid,integer)'::regprocedure,'public.claim_job(uuid,integer,uuid)'::regprocedure);
do $$declare own text;r text;t regclass;begin
 select pg_get_userbyid(proowner)into strict own from supported_claim_baseline where oid='public.claim_job(uuid,integer,uuid)'::regprocedure;
 if not exists(select 1 from pg_roles where rolname=own and(rolsuper or rolbypassrls))or
 exists(select 1 from supported_claim_baseline where pg_get_userbyid(proowner)<>own)then
 raise exception 'supported_claim_owner_incompatible'using errcode='55000';end if;
 foreach r in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
 if pg_has_role(r,own,'USAGE')or pg_has_role(r,own,'SET')then raise exception 'supported_claim_owner_incompatible'using errcode='55000';end if;
 end loop;
 foreach r in array array['private','public','auth']loop
 if not has_schema_privilege(own,r,'USAGE')then raise exception 'supported_claim_owner_incompatible'using errcode='55000';end if;end loop;
 if not has_function_privilege(own,'auth.role()','EXECUTE')or
 not has_function_privilege(own,'private.assert_current_worker_run(uuid)','EXECUTE')or
 not has_function_privilege(own,'private.assert_current_worker_job(uuid,uuid,uuid)','EXECUTE')then
 raise exception 'supported_claim_owner_incompatible'using errcode='55000';end if;
 foreach t in array array['private.worker_jobs'::regclass,'private.global_worker_run'::regclass,'private.worker_job_run_fences'::regclass]loop
 if not has_table_privilege(own,t,'SELECT')or not has_table_privilege(own,t,'UPDATE')then raise exception 'supported_claim_owner_incompatible'using errcode='55000';end if;end loop;
 if not has_table_privilege(own,'private.worker_job_run_fences','INSERT')then raise exception 'supported_claim_owner_incompatible'using errcode='55000';end if;
end;$$;

-- 없는 후속 모듈은 준비되지 않은 것으로 처리한다. 존재하는데 읽기 권한이 없는 오류는 삼키지 않는다.
-- SHARE는 승인 철회와 이번 점유를 직렬화한다. 실행 RPC의 재검사도 계속 필요하다.
create function private.supported_worker_kind_ready(p_kind text)returns boolean
 language plpgsql volatile security definer set search_path=''as $$
declare enabled boolean;sig text;proc regprocedure;signatures text[];begin
 if p_kind='review_summary'then return true;
 elsif p_kind='cancellation_safety'then
 if to_regclass('private.cancellation_due_control')is null then return false;end if;
 execute 'select enabled from private.cancellation_due_control where singleton for share'into enabled;
 signatures:=array['public.enqueue_cancellation_safety_due(integer,uuid)','public.process_cancellation_safety_due(uuid,bigint,uuid,uuid,uuid)'];
 elsif p_kind='report_retention'then
 if to_regclass('private.report_purge_control')is null then return false;end if;
 execute 'select enabled from private.report_purge_control where singleton for share'into enabled;
 signatures:=array['public.enqueue_report_retention_purges(uuid,integer)','public.claim_report_retention_task(uuid,uuid,uuid)',
 'public.check_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid)','public.get_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid)',
 'public.record_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid,text)','public.complete_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid,text)',
 'public.purge_report_retention_terminal_receipts(uuid,integer)'];
 else return false;end if;
 if enabled is distinct from true then return false;end if;
 foreach sig in array signatures loop
 proc:=to_regprocedure(sig);
 if proc is null or not has_function_privilege('service_role',proc,'EXECUTE')then return false;end if;
 end loop;return true;
end;$$;

create function private.claim_supported_worker_job(p_worker_id uuid,p_lease_seconds integer,p_worker_run_token uuid,p_supported_kinds text[])
 returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare j private.worker_jobs;ready text[]:='{}';k text;expiry timestamptz;n timestamptz;begin
 if p_worker_id is null or p_lease_seconds is null or p_lease_seconds not between 1 and 86400 or
 p_supported_kinds is null or coalesce(array_ndims(p_supported_kinds),1)<>1 or cardinality(p_supported_kinds)not between 1 and 3 or
 exists(select 1 from unnest(p_supported_kinds)x where x is null or x not in('review_summary','cancellation_safety','report_retention'))or
 (select count(distinct x)from unnest(p_supported_kinds)x)<>cardinality(p_supported_kinds)then
 raise exception 'invalid_supported_claim'using errcode='22023';end if;
 perform private.assert_current_worker_run(p_worker_run_token);
 -- 고정 문자열 대신 종류 정렬로 승인 행 잠금 순서를 통일한다.
 for k in select x from unnest(p_supported_kinds)x order by x loop
 if private.supported_worker_kind_ready(k)then ready:=array_append(ready,k);end if;end loop;
 n:=clock_timestamp();
 select *into j from private.worker_jobs where kind=any(ready)and
 ((status in('queued','retry_wait')and available_at<=n)or(status='running'and lease_expires_at<=n))
 order by case when status='running'then lease_expires_at else available_at end,id for update skip locked limit 1;
 if not found then perform private.assert_current_worker_run(p_worker_run_token);return jsonb_build_object('job',null);end if;
 perform private.assert_current_worker_run(p_worker_run_token);
 n:=clock_timestamp();
 select least(n+make_interval(secs=>p_lease_seconds),expires_at)into expiry from private.global_worker_run where singleton;
 if expiry is null or expiry<=n or not private.supported_worker_kind_ready(j.kind)then raise exception 'state_conflict'using errcode='40001';end if;
 update private.worker_jobs set status='running',worker_id=p_worker_id,lease_token=gen_random_uuid(),lease_expires_at=expiry,
 attempt=attempt+1,updated_at=n where id=j.id returning *into j;
 insert into private.worker_job_run_fences(job_id,job_lease_token,worker_run_token)values(j.id,j.lease_token,p_worker_run_token)
 on conflict(job_id)do update set job_lease_token=excluded.job_lease_token,worker_run_token=excluded.worker_run_token;
 perform private.assert_current_worker_job(j.id,j.lease_token,p_worker_run_token);
 if not private.supported_worker_kind_ready(j.kind)then raise exception 'state_conflict'using errcode='40001';end if;
 return jsonb_build_object('job',jsonb_build_object('jobId',j.id,'kind',j.kind,'payload',j.payload,'leaseToken',j.lease_token,
 'leaseExpiresAt',j.lease_expires_at,'attempt',j.attempt,'failedAttempts',j.failed_attempts));
end;$$;

create function public.claim_supported_job(p_worker_id uuid,p_lease_seconds integer,p_worker_run_token uuid,p_supported_kinds text[])
 returns jsonb language plpgsql volatile security definer set search_path=''as $$begin
 if auth.role()is distinct from'service_role'then raise exception 'worker_required'using errcode='42501';end if;
 return private.claim_supported_worker_job(p_worker_id,p_lease_seconds,p_worker_run_token,p_supported_kinds);
end;$$;

-- 두 기존 OID/서명/ACL은 보존한다. 리뷰 소비자가 읽지 못하는 kind는 처음부터 선택하지 않는다.
create or replace function public.claim_job(p_worker_id uuid,p_lease_seconds integer,p_worker_run_token uuid)
 returns jsonb language plpgsql volatile security definer set search_path=''as $$begin
 return private.claim_supported_worker_job(p_worker_id,p_lease_seconds,p_worker_run_token,array['review_summary']);end;$$;
-- 외부 EXEC는 계속 닫혀 있다. owner 직접 호출도 현재 전역 점유가 없으면 거절한다.
create or replace function public.claim_job(p_worker_id uuid,p_lease_seconds integer)
 returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_token uuid;begin
 select g.token into v_token from private.global_worker_run g where singleton;
 return private.claim_supported_worker_job(p_worker_id,p_lease_seconds,v_token,array['review_summary']);end;$$;

do $$declare own text;f regprocedure;t regclass;begin
 select pg_get_userbyid(proowner)into strict own from supported_claim_baseline where oid='public.claim_job(uuid,integer,uuid)'::regprocedure;
 -- optional control에 SHARE 잠금 권한이 없는 분리 owner 배포는 적용 단계에서 명시적으로 중단한다.
 foreach t in array array[to_regclass('private.cancellation_due_control'),to_regclass('private.report_purge_control')]loop
 if t is not null and(not has_table_privilege(own,t,'SELECT')or not has_table_privilege(own,t,'UPDATE'))then raise exception 'supported_claim_owner_incompatible'using errcode='55000';end if;end loop;
 foreach f in array array['private.supported_worker_kind_ready(text)'::regprocedure,
 'private.claim_supported_worker_job(uuid,integer,uuid,text[])'::regprocedure,'public.claim_supported_job(uuid,integer,uuid,text[])'::regprocedure]loop
 execute format('alter function %s owner to %I',f,own);
 execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f);
 end loop;
 if exists(select 1 from supported_claim_baseline b left join pg_proc p on p.oid=b.oid
 where p.oid is null or p.proowner<>b.proowner or p.proacl::text is distinct from b.acl or p.proconfig::text is distinct from b.config)then
 raise exception 'legacy_claim_metadata_changed'using errcode='55000';end if;
end;$$;
commit;
