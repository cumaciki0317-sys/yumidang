-- 민규: source81 DELETE 전송 의도 후속 회귀 후보. source79 과거 PASS와 별도이며 실제 Provider 증거가 아니다.
begin;
set local plpgsql.check_asserts='on';
set local storage.allow_delete_query='true';
select set_config('request.jwt.claims','{"role":"service_role"}',true);
create temp table purge_old_functions as select oid,proowner,proacl::text acl,proconfig::text config,prosrc from pg_proc
 where oid in('public.get_my_report(uuid)'::regprocedure,'private.assert_current_worker_job(uuid,uuid,uuid)'::regprocedure,
 'private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)'::regprocedure);
create function pg_temp.purge_id(p_number integer)returns uuid language sql immutable as $$select('cf790000-0000-4000-8000-'||lpad(p_number::text,12,'0'))::uuid$$;
create function pg_temp.purge_error(p_command text,p_expected text)returns void language plpgsql as $$declare actual text;begin
 begin execute p_command;exception when others then get stacked diagnostics actual=returned_sqlstate;end;
 assert actual=p_expected,'report_purge_expected_error';
end;$$;
insert into auth.users(id,email)select pg_temp.purge_id(x),'purge-fixture-'||x||'@test.invalid'from generate_series(1,2)x;
insert into public.profiles(id,real_name,birth_date,gender)select pg_temp.purge_id(x),'합성회원','1990-01-01','female'from generate_series(1,2)x;
-- 정확 최소 no_show hold의 report SET NULL/종결시각 보존을 위한 owner 약속 fixture.
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
values(pg_temp.purge_id(60),pg_temp.purge_id(1),'합성 약속','보관 검증','산책',now()+interval '3 days',now()+interval '3 days 2 hours',now()+interval '2 days','서울특별시 강남구 역삼동','recruiting');
insert into public.join_requests(id,post_id,requester_id,message,status)values(pg_temp.purge_id(61),pg_temp.purge_id(60),pg_temp.purge_id(2),'합성 신청','pending');
insert into public.appointments(id,post_id,join_request_id,status,confirmed_at)values(pg_temp.purge_id(62),pg_temp.purge_id(60),pg_temp.purge_id(61),'confirmed',now());
insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,status,hide_target,fingerprint,final_closed_at,retention_due_at)
select pg_temp.purge_id(10+x),pg_temp.purge_id(1),e.id,pg_temp.purge_id(20+x),case x when 1 then 'appointment'else 'member'end,case x when 1 then pg_temp.purge_id(62)else pg_temp.purge_id(2)end,'online',array['other'],'resolved',x=2,repeat('a',64),
 statement_timestamp()-interval '2161 hours',statement_timestamp()-interval '2161 hours'+interval '2160 hours'
from generate_series(1,3)x join private.member_episodes e on e.profile_id=pg_temp.purge_id(1)and e.ended_at is null;
-- 먼저 도래한 숨김 보류 20건이 LIMIT을 소비해 뒤의 eligible 신고를 굶기지 않아야 한다.
insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,status,hide_target,fingerprint,final_closed_at,retention_due_at)
select pg_temp.purge_id(100+x),pg_temp.purge_id(1),e.id,pg_temp.purge_id(200+x),'member',pg_temp.purge_id(2),'online',array['other'],'resolved',true,repeat('a',64),
 statement_timestamp()-interval '2170 hours',statement_timestamp()-interval '2170 hours'+interval '2160 hours'
from generate_series(1,20)x join private.member_episodes e on e.profile_id=pg_temp.purge_id(1)and e.ended_at is null;
insert into private.appointment_review_holds(report_id,appointment_id,state,resolved_at,decision_id)
values(pg_temp.purge_id(11),pg_temp.purge_id(62),'no_show',now(),pg_temp.purge_id(63));
insert into private.member_report_details(report_id,description)select pg_temp.purge_id(10+x),'파기할 합성 설명'from generate_series(1,3)x;
insert into private.report_capture_assets(id,owner_id,owner_episode_id,object_name,state,report_id,uploaded_at)
select pg_temp.purge_id(30+x),pg_temp.purge_id(1),e.id,pg_temp.purge_id(1)::text||'/'||pg_temp.purge_id(30+x)::text||case x when 1 then '.png'else '.webp'end,
 'attached',pg_temp.purge_id(11),clock_timestamp()from generate_series(1,2)x join private.member_episodes e on e.profile_id=pg_temp.purge_id(1)and e.ended_at is null;
insert into storage.objects(id,bucket_id,name,owner_id,metadata)
select pg_temp.purge_id(40+x),'report-evidence',a.object_name,a.owner_id::text,
 jsonb_build_object('mimetype',case x when 1 then 'image/png'else 'image/webp'end,'size',5242880)
from generate_series(1,2)x join private.report_capture_assets a on a.id=pg_temp.purge_id(30+x);
create temp table purge_context(global_token uuid,job_id uuid,job_token uuid,task jsonb);
do $$declare g uuid;j uuid;lease uuid:=pg_temp.purge_id(50);v jsonb;role_name text;f record;before_jobs jsonb;sig text;begin
 assert current_setting('plpgsql.check_asserts')='on';
 assert not(select enabled from private.report_purge_control where singleton);
 for f in select oid::regprocedure signature from pg_proc where proname in('enqueue_report_retention_purges','claim_report_retention_task','check_report_retention_task','get_report_retention_delete_ack','record_report_retention_delete_ack','complete_report_retention_task','purge_report_retention_terminal_receipts','begin_report_retention_delete')loop
  foreach role_name in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
   assert not has_function_privilege(role_name,f.signature,'EXECUTE'),'report_purge_acl_closed';
  end loop;
 end loop;
 perform pg_temp.purge_error('select public.enqueue_report_retention_purges(null,20)','55000');
 delete from private.report_purge_control;
 perform pg_temp.purge_error('select public.enqueue_report_retention_purges(null,20)','55000');
 perform pg_temp.purge_error('select public.claim_report_retention_task(null,null,null)','55000');
 perform pg_temp.purge_error('select public.complete_report_retention_task(null,null,null,null,null,null,null)','55000');
 perform pg_temp.purge_error('select public.purge_report_retention_terminal_receipts(null,20)','55000');
 insert into private.report_purge_control values(true,false);
 assert not(select enabled from private.report_purge_control where singleton);

 g:=(public.acquire_worker_run(180,null)->>'token')::uuid;assert g is not null;
 update private.report_purge_control set enabled=true where singleton;
 perform pg_temp.purge_error(format('select public.enqueue_report_retention_purges(%L,21)',g),'22023');
 v:=public.enqueue_report_retention_purges(g,20);assert v=jsonb_build_object('enqueued',2);
 assert not exists(select 1 from private.report_purge_closures where report_id=pg_temp.purge_id(12)),'hidden_report_held';
 assert(select count(*)=3 from private.report_purge_tasks t join private.report_purge_closures c on c.id=t.closure_id where c.report_id=pg_temp.purge_id(11));
 select id into strict j from private.worker_jobs where kind='report_retention'and payload->>'reportId'=pg_temp.purge_id(11)::text;
 -- readiness7만 열린 상태는 queued 작업·attempt·token·fence를 변경하지 않는다.
 begin
  foreach sig in array array['public.enqueue_report_retention_purges(uuid,integer)','public.claim_report_retention_task(uuid,uuid,uuid)',
  'public.check_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid)','public.get_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid)',
  'public.record_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid,text)','public.complete_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid,text)',
  'public.purge_report_retention_terminal_receipts(uuid,integer)']loop
   execute format('grant execute on function %s to service_role',sig);
  end loop;
  assert not has_function_privilege('service_role','public.begin_report_retention_delete(uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE');
  assert not private.supported_worker_kind_ready('report_retention');
  select jsonb_agg(to_jsonb(job_row)order by job_row.id)into before_jobs from private.worker_jobs job_row where job_row.kind='report_retention';
  v:=public.claim_supported_job(pg_temp.purge_id(51),60,g,array['report_retention']);
  assert v=jsonb_build_object('job',null);
  assert(select jsonb_agg(to_jsonb(job_row)order by job_row.id)=before_jobs from private.worker_jobs job_row where job_row.kind='report_retention');
  assert not exists(select 1 from private.worker_job_run_fences);
  execute 'grant execute on function public.begin_report_retention_delete(uuid,uuid,uuid,uuid,uuid,uuid)to service_role';
  assert private.supported_worker_kind_ready('report_retention');
  v:=public.claim_supported_job(pg_temp.purge_id(51),60,g,array['report_retention']);
  assert jsonb_typeof(v->'job')='object'and v->'job'->>'kind'='report_retention';
  assert(v->'job'->'payload'->>'reportId')::uuid in(pg_temp.purge_id(11),pg_temp.purge_id(13));
  assert exists(select 1 from private.worker_job_run_fences fence_row where fence_row.job_id=(v->'job'->>'jobId')::uuid and fence_row.worker_run_token=g);
  raise exception 'readiness_fixture_rollback'using errcode='P0001';
 exception when raise_exception then null;end;
 assert not has_function_privilege('service_role','public.begin_report_retention_delete(uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE');
 assert(select status='queued'and attempt=0 and lease_token is null from private.worker_jobs where id=j);
 -- 아래 직접 owner 점유는 task/dispatch 회귀를 위한 별도 fixture이며 J 실행 증거가 아니다.

 update private.worker_jobs set status='running',worker_id=pg_temp.purge_id(51),lease_token=lease,lease_expires_at=clock_timestamp()+interval '120 seconds'where id=j;
 insert into private.worker_job_run_fences values(j,lease,g);
 insert into purge_context values(g,j,lease,null);
end;$$;
-- TTL/다시 열린 상태/closure revision 변화는 보관 snapshot 사용을 막는다.
do $$declare ctx purge_context;c uuid;old_version bigint;begin
 select *into strict ctx from purge_context;
 select id into strict c from private.report_purge_closures where report_id=pg_temp.purge_id(11);
 begin
  update private.member_reports set status='reviewing',final_closed_at=null,retention_due_at=null where id=pg_temp.purge_id(11);
  perform pg_temp.purge_error(format('select private.report_purge_assert_closure(%L)',c),'55000');
  raise exception 'fixture_rollback'using errcode='P0001';
 exception when raise_exception then null;end;
 assert private.report_purge_eligible(pg_temp.purge_id(11));
 perform pg_temp.purge_error(format('delete from private.member_reports where id=%L',pg_temp.purge_id(11)),'55000');
 perform pg_temp.purge_error(format('delete from private.report_purge_tasks where closure_id=%L',c),'55000');
 perform pg_temp.purge_error(format('insert into storage.objects(bucket_id,name)select bucket_id,object_name from private.report_purge_tasks where closure_id=%L and kind=''storage_object''limit 1',c),'40001');
end;$$;
-- 첫 ACK 보존, 부재만으로 완료 불가, 만료 후 새 lease가 같은 ACK를 사용한다.
do $$declare ctx purge_context;v jsonb;ack jsonb;again jsonb;dispatch jsonb;task_id uuid;object_id uuid;token uuid;i integer;begin
 select *into strict ctx from purge_context;
 for i in 1..2 loop
  v:=public.claim_report_retention_task(ctx.job_id,ctx.job_token,ctx.global_token);
  assert (select count(*)=12 from jsonb_object_keys(v))and v->>'kind'='storage_object';
  task_id:=(v->>'taskId')::uuid;object_id:=(v->>'objectId')::uuid;token:=(v->>'taskLeaseToken')::uuid;
  -- 정확 존재 task로 false 및 control 행 부재를 검사한다. fence를 열지 않는 55000 거절이어야 한다.
  update private.report_purge_control set enabled=false where singleton;
  perform pg_temp.purge_error(format('select public.check_report_retention_task(%L,%L,%L,%L,%L,%L)',task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id),'55000');
  delete from private.report_purge_control;
  perform pg_temp.purge_error(format('select public.check_report_retention_task(%L,%L,%L,%L,%L,%L)',task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id),'55000');
  perform pg_temp.purge_error(format('select public.get_report_retention_delete_ack(%L,%L,%L,%L,%L,%L)',task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id),'55000');
  perform pg_temp.purge_error(format('select public.record_report_retention_delete_ack(%L,%L,%L,%L,%L,%L,%L)',task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id,repeat('a',64)),'55000');
  insert into private.report_purge_control values(true,true);
  assert not exists(select 1 from private.report_purge_delete_acks ack_row where ack_row.task_id=(v->>'taskId')::uuid);

  assert public.get_report_retention_delete_ack(task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id)is null;
  perform pg_temp.purge_error(format('select public.check_report_retention_task(%L,%L,%L,%L,%L,%L)',task_id,token,ctx.job_id,pg_temp.purge_id(99),ctx.global_token,object_id),'40001');
  perform pg_temp.purge_error(format('select public.complete_report_retention_task(%L,%L,%L,%L,%L,%L,%L)',task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id,repeat('b',64)),'55000');
  perform pg_temp.purge_error(format('select public.record_report_retention_delete_ack(%L,%L,%L,%L,%L,%L,%L)',task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id,repeat('a',64)),'55000');
  dispatch:=public.begin_report_retention_delete(task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id);
  assert(select count(*)=3 from jsonb_object_keys(dispatch));
  assert(dispatch->>'taskId')::uuid=task_id and not(dispatch->>'alreadyApplied')::boolean;
  again:=public.begin_report_retention_delete(task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id);
  assert again->>'dispatchId'=dispatch->>'dispatchId'and(again->>'alreadyApplied')::boolean;
  perform pg_temp.purge_error(format('update private.report_purge_dispatches set dispatched_at=clock_timestamp()where task_id=%L',task_id),'40001');
  perform pg_temp.purge_error(format('delete from private.report_purge_dispatches where task_id=%L',task_id),'55000');
  -- durable 의도만 있고 ACK가 없을 때는 task가 만료돼도 새 dispatch를 주지 않는다.
  begin
   update private.report_purge_tasks set lease_expires_at=clock_timestamp()-interval '1 second'where id=task_id;
   assert not exists(select 1 from private.report_purge_delete_acks ack_row where ack_row.task_id=(v->>'taskId')::uuid);
   if i=1 then
    -- 다른 미전송 task는 별도로 점유 가능하다. 원 intent task는 고정된 채 유지한다.
    again:=public.claim_report_retention_task(ctx.job_id,ctx.job_token,ctx.global_token);
    assert(again->>'taskId')::uuid<>task_id;
    perform pg_temp.purge_error(format('select public.claim_report_retention_task(%L,%L,%L)',ctx.job_id,ctx.job_token,ctx.global_token),'55000');
   else
    perform pg_temp.purge_error(format('select public.claim_report_retention_task(%L,%L,%L)',ctx.job_id,ctx.job_token,ctx.global_token),'55000');
   end if;
   perform pg_temp.purge_error(format('select public.record_report_retention_delete_ack(%L,%L,%L,%L,%L,%L,%L)',task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id,repeat('a',64)),'40001');
   raise exception 'dispatch_fixture_rollback'using errcode='P0001';
  exception when raise_exception then null;end;
  assert(select lease_token=token and lease_expires_at>clock_timestamp()from private.report_purge_tasks where id=task_id);
  ack:=public.record_report_retention_delete_ack(task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id,repeat('a',64));
  assert(select count(*)=5 from jsonb_object_keys(ack));
  assert public.record_report_retention_delete_ack(task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id,repeat('a',64))=ack;
  perform pg_temp.purge_error(format('select public.record_report_retention_delete_ack(%L,%L,%L,%L,%L,%L,%L)',task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id,repeat('b',64)),'40001');
  assert public.get_report_retention_delete_ack(task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id)=ack;
  update private.report_purge_tasks set lease_expires_at=clock_timestamp()-interval '1 second'where id=task_id;
  perform pg_temp.purge_error(format('select public.check_report_retention_task(%L,%L,%L,%L,%L,%L)',task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id),'40001');
  v:=public.claim_report_retention_task(ctx.job_id,ctx.job_token,ctx.global_token);assert(v->>'taskId')::uuid=task_id;
  token:=(v->>'taskLeaseToken')::uuid;
  perform pg_temp.purge_error(format('select public.begin_report_retention_delete(%L,%L,%L,%L,%L,%L)',task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id),'55000');
  perform pg_temp.purge_error(format('select public.record_report_retention_delete_ack(%L,%L,%L,%L,%L,%L,%L)',task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id,repeat('a',64)),'55000');
  assert public.get_report_retention_delete_ack(task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id)=ack;
  -- owner metadata DELETE + 합성 hash이다. 실제 DELETE 응답/물리 bytes 제거 증거로 사용하지 않는다.
  delete from storage.objects where id=object_id;
  perform pg_temp.purge_error(format('insert into storage.objects(id,bucket_id,name)values(%L,%L,%L)',pg_temp.purge_id(80+i),v->>'bucketId',v->>'objectName'),'40001');
  again:=public.complete_report_retention_task(task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id,repeat('c',64));
  assert again=jsonb_build_object('taskId',task_id,'status','completed','alreadyApplied',false);
  assert(public.complete_report_retention_task(task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id,repeat('c',64))->>'alreadyApplied')::boolean;
  perform pg_temp.purge_error(format('select public.complete_report_retention_task(%L,%L,%L,%L,%L,%L,%L)',task_id,token,ctx.job_id,ctx.job_token,ctx.global_token,object_id,repeat('d',64)),'40001');
  assert(select evidence_sha256=repeat('c',64)from private.report_purge_tasks where id=task_id);
 end loop;
 update purge_context set task=public.claim_report_retention_task(ctx.job_id,ctx.job_token,ctx.global_token);
 assert(select task->>'kind'='report_metadata'and task->>'objectId'is null and task->>'assetId'is null from purge_context);
end;$$;
create function pg_temp.purge_inject_failure()returns trigger language plpgsql as $$begin raise exception 'synthetic_failure'using errcode='XX000';end;$$;
create trigger purge_injected_delete before delete on private.member_reports for each row execute function pg_temp.purge_inject_failure();
do $$declare ctx purge_context;begin
 select *into strict ctx from purge_context;
 perform pg_temp.purge_error(format('select public.complete_report_retention_task(%L,%L,%L,%L,%L,null,%L)',ctx.task->>'taskId',ctx.task->>'taskLeaseToken',ctx.job_id,ctx.job_token,ctx.global_token,repeat('e',64)),'XX000');
 assert(select count(*)=2 from private.report_capture_assets where report_id=pg_temp.purge_id(11));
 assert exists(select 1 from private.member_report_details where report_id=pg_temp.purge_id(11));
 assert(select count(*)=2 from private.report_purge_delete_acks),'failed_metadata_delete_atomic';
end;$$;
drop trigger purge_injected_delete on private.member_reports;
do $$declare ctx purge_context;v jsonb;begin
 select *into strict ctx from purge_context;
 v:=public.complete_report_retention_task((ctx.task->>'taskId')::uuid,(ctx.task->>'taskLeaseToken')::uuid,ctx.job_id,ctx.job_token,ctx.global_token,null,repeat('e',64));
 assert v=jsonb_build_object('taskId',(ctx.task->>'taskId')::uuid,'status','completed','alreadyApplied',false);
 assert not exists(select 1 from private.member_reports where id=pg_temp.purge_id(11));
 assert not exists(select 1 from private.member_report_details where report_id=pg_temp.purge_id(11));
 assert exists(select 1 from private.appointment_review_holds where appointment_id=pg_temp.purge_id(62)and report_id is null and state='no_show'and report_closed_at is not null);
 assert private.appointment_review_held(pg_temp.purge_id(62));
 assert(select status='confirmed'and completed_at is null from public.appointments where id=pg_temp.purge_id(62));
 assert not exists(select 1 from private.report_capture_assets where report_id=pg_temp.purge_id(11));
 assert not exists(select 1 from private.report_purge_delete_acks);
 assert not exists(select 1 from private.report_purge_dispatches);
 assert(select count(*)=1 from private.report_purge_closures),'unrelated_report_preserved';
 assert(public.complete_report_retention_task((ctx.task->>'taskId')::uuid,(ctx.task->>'taskLeaseToken')::uuid,ctx.job_id,ctx.job_token,ctx.global_token,null,repeat('e',64))->>'alreadyApplied')::boolean;
 assert(select status='succeeded'from private.worker_jobs where id=ctx.job_id);
 assert(select completed_at=(select completed_at from private.worker_jobs where id=ctx.job_id)and expires_at=completed_at+interval '720 hours'from private.report_purge_terminal_receipts where job_id=ctx.job_id);
 perform pg_temp.purge_error(format('select public.complete_report_retention_task(%L,%L,%L,%L,%L,null,%L)',ctx.task->>'taskId',ctx.task->>'taskLeaseToken',ctx.job_id,ctx.job_token,ctx.global_token,repeat('f',64)),'40001');
 -- 새 전역 점유에서 원 완료 증거만 읽는다. 원 running task write fence를 부활시키지 않는다.
 assert public.release_worker_run(ctx.global_token)->>'status'='applied';
 ctx.global_token:=(public.acquire_worker_run(180,null)->>'token')::uuid;
 assert(public.complete_report_retention_task((ctx.task->>'taskId')::uuid,(ctx.task->>'taskLeaseToken')::uuid,ctx.job_id,ctx.job_token,ctx.global_token,null,repeat('e',64))->>'alreadyApplied')::boolean;
 update private.report_purge_terminal_receipts set completed_at=statement_timestamp()-interval '721 hours',expires_at=statement_timestamp()-interval '1 hour'where job_id=ctx.job_id;
 perform pg_temp.purge_error(format('select public.complete_report_retention_task(%L,%L,%L,%L,%L,null,%L)',ctx.task->>'taskId',ctx.task->>'taskLeaseToken',ctx.job_id,ctx.job_token,ctx.global_token,repeat('e',64)),'PT404');
 assert public.purge_report_retention_terminal_receipts(ctx.global_token,20)=jsonb_build_object('purged',1);
 assert not exists(select 1 from private.report_purge_terminal_receipts);
 -- 첨부 없는 별도 신고도 metadata task로만 완료하며 타 신고를 잘못 삭제하지 않는다.
 select id into strict ctx.job_id from private.worker_jobs where kind='report_retention'and payload->>'reportId'=pg_temp.purge_id(13)::text;
 ctx.job_token:=pg_temp.purge_id(90);
 update private.worker_jobs set status='running',worker_id=pg_temp.purge_id(51),lease_token=ctx.job_token,lease_expires_at=clock_timestamp()+interval '120 seconds'where id=ctx.job_id;
 insert into private.worker_job_run_fences values(ctx.job_id,ctx.job_token,ctx.global_token);
 v:=public.claim_report_retention_task(ctx.job_id,ctx.job_token,ctx.global_token);assert v->>'kind'='report_metadata';
 assert public.complete_report_retention_task((v->>'taskId')::uuid,(v->>'taskLeaseToken')::uuid,ctx.job_id,ctx.job_token,ctx.global_token,null,repeat('e',64))->>'status'='completed';
 assert not exists(select 1 from private.member_reports where id=pg_temp.purge_id(13));
 assert exists(select 1 from private.member_reports where id=pg_temp.purge_id(12)and hide_target);
 update private.report_purge_control set enabled=false where singleton;
 assert public.release_worker_run(ctx.global_token)->>'status'='applied';
 assert not exists(select 1 from purge_old_functions b join pg_proc p on p.oid=b.oid where p.proowner<>b.proowner or p.proacl::text is distinct from b.acl or p.proconfig::text is distinct from b.config or p.prosrc<>b.prosrc);
end;$$;
rollback;
