-- SQL110 합성 scratch 전용. 외부 HTTP/Storage/Auth 물리 DELETE는 호출하지 않는다.
-- 아래 ACK는 RPC/DB 결합 검사용 합성 receipt이며 실제 외부 삭제 검증 결과가 아니다.
begin;
do $$declare f regprocedure;r text;begin
 if exists(select 1 from private.worker_jobs)or exists(select 1 from private.worker_invocations)or exists(select 1 from private.worker_runtime_intents)or exists(select 1 from private.worker_runtime_results)or exists(select 1 from private.member_cleanup_tasks)then raise exception 'empty_synthetic_scratch_required';end if;
 foreach f in array array['public.claim_member_cleanup_task(uuid)'::regprocedure,'public.begin_member_cleanup_delete(uuid,uuid,uuid,uuid)'::regprocedure,'public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)'::regprocedure,'public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)'::regprocedure,'public.complete_queue_invocation(uuid)'::regprocedure]loop
  foreach r in array array['anon','authenticated','service_role','yumidang_worker_queue']loop assert not has_function_privilege(r,f,'EXECUTE');end loop;
 end loop;
 assert not(select enabled from private.worker_invocation_control where singleton);
 assert not(select external_deletion_approved from private.member_cleanup_guard where singleton);
end;$$;
create function pg_temp.member_inv_id(n integer)returns uuid language sql immutable as $$select('d1100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.member_inv_reject(command text,expected text)returns void language plpgsql as $$declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('unexpected SQLSTATE %s expected %s',code,expected);
end;$$;
insert into auth.users(id,email)select pg_temp.member_inv_id(n),pg_temp.member_inv_id(n)::text||'@member-invocation.invalid'from generate_series(1,3)n;
insert into public.profiles(id,real_name,birth_date,gender)select pg_temp.member_inv_id(n),'합성회원','1990-01-01','female'from generate_series(1,3)n;
insert into private.member_retirements(profile_id,withdrawal_id,episode_id)select pg_temp.member_inv_id(n),pg_temp.member_inv_id(100+n),private.active_member_episode(pg_temp.member_inv_id(n))from generate_series(1,3)n;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.role','service_role',true);
update private.worker_invocation_control set enabled=true where singleton;
update private.worker_runtime_atomic_control set enabled=true where singleton;
update private.member_cleanup_guard set external_deletion_approved=true where singleton;
insert into private.global_worker_run(singleton,token,expires_at)values(true,pg_temp.member_inv_id(80),clock_timestamp()+interval'180 seconds')on conflict(singleton)do update set token=excluded.token,expires_at=excluded.expires_at;
select pg_temp.member_inv_reject('select public.prepare_queue_invocation(pg_temp.member_inv_id(901),pg_temp.member_inv_id(80),''member_cleanup'',11,30000)','22023');
-- 존재하지 않는 합성 object ID를 사용한다. Storage 대상/본문을 생성·삭제하지 않는다.
insert into private.member_cleanup_tasks(id,withdrawal_id,kind,profile_id,bucket_id,object_name,object_id)values(pg_temp.member_inv_id(20),pg_temp.member_inv_id(101),'storage_object',pg_temp.member_inv_id(1),'profile-images',pg_temp.member_inv_id(1)::text||'/synthetic.png',pg_temp.member_inv_id(200));
do $$declare req uuid:=pg_temp.member_inv_id(900);tok uuid:=pg_temp.member_inv_id(80);t jsonb;old_lease uuid;v jsonb;expiry timestamptz;begin
 select expires_at into expiry from private.global_worker_run where singleton;
 perform public.prepare_queue_invocation(req,tok,'member_cleanup',2,30000);
 assert(public.claim_queue_invocation_dispatch(req,tok,'member_cleanup',2,30000)->>'claimed')::boolean;
 t:=public.claim_member_cleanup_task(tok);old_lease:=(t->>'leaseToken')::uuid;
 assert(t->>'taskId')::uuid=pg_temp.member_inv_id(20);
 assert(select id=(payload->>'taskId')::uuid and kind='member_cleanup'from private.worker_jobs where id=pg_temp.member_inv_id(20));
 assert(t->>'expiresAt')::timestamptz<=expiry;
 assert(t->>'expiresAt')::timestamptz<=(select deadline from private.worker_invocations where request_id=req);
 -- dispatch 이전의 만료만 재점유 가능하다. 오래된 lease의 효과를 새 lease에 복사하지 않는다.
 update private.member_cleanup_tasks set lease_expires_at=clock_timestamp()-interval'1 second'where id=pg_temp.member_inv_id(20);
 update private.worker_jobs set lease_expires_at=clock_timestamp()-interval'1 second'where id=pg_temp.member_inv_id(20);
 t:=public.claim_member_cleanup_task(tok);assert(t->>'leaseToken')::uuid<>old_lease;
 assert(select count(*)=2 from private.worker_invocation_jobs where request_id=req);
 assert(select settled_status='superseded'and effect is null from private.worker_invocation_jobs where request_id=req and job_lease_token=old_lease);
 assert(select settled_status is null and effect is null from private.worker_invocation_jobs where request_id=req and job_lease_token=(t->>'leaseToken')::uuid);
 assert(select count(*)=1 from private.worker_runtime_job_slots where global_token=tok);
 perform pg_temp.member_inv_reject(format('select public.complete_queue_invocation(%L::uuid)',req),'55000');
 v:=public.begin_member_cleanup_delete((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,tok,(t->>'objectId')::uuid);assert not(v->>'alreadyDispatched')::boolean;
 v:=public.record_member_cleanup_delete_ack((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,tok,(t->>'objectId')::uuid,repeat('a',64));
 update private.member_cleanup_delete_acks set recorded_worker_run_token=pg_temp.member_inv_id(81)where task_id=pg_temp.member_inv_id(20);
 perform pg_temp.member_inv_reject(format('select public.complete_member_cleanup_task(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L)',t->>'taskId',t->>'leaseToken',tok,t->>'objectId',repeat('b',64)),'40001');
 update private.member_cleanup_delete_acks set recorded_worker_run_token=tok where task_id=pg_temp.member_inv_id(20);
 assert public.complete_member_cleanup_task((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,tok,(t->>'objectId')::uuid,repeat('b',64))='{"status":"applied"}'::jsonb;
 v:=public.complete_queue_invocation(req);assert v->>'state'='completed';assert v->'result'->'counts'='{"claimed":1,"succeeded":1,"retried":0,"failed":0,"superseded":0,"yielded":0}'::jsonb;
 assert public.get_queue_invocation(req)=v;assert public.complete_queue_invocation(req)=v;
 assert(select expires_at=expiry from private.global_worker_run where singleton);
 assert not exists(select 1 from private.worker_job_run_fences where job_id=pg_temp.member_inv_id(20));
end;$$;
-- 기존 6종 중 review 완료 위임을 검증한다.
do $$declare req uuid:=pg_temp.member_inv_id(902);tok uuid:=pg_temp.member_inv_id(80);begin
 perform public.prepare_queue_invocation(req,tok,'review_summary',1,30000);perform public.claim_queue_invocation_dispatch(req,tok,'review_summary',1,30000);
 assert public.claim_supported_job(pg_temp.member_inv_id(90),180,tok,array['review_summary'])='{"job":null}'::jsonb;
 assert(public.complete_queue_invocation(req)->'result'->'counts'->>'claimed')::integer=0;
end;$$;
savepoint member_cap;
insert into private.worker_runtime_job_slots(global_token,job_id)select pg_temp.member_inv_id(80),md5('member110slot'||n)::uuid from generate_series(1,19)n;
insert into private.member_cleanup_tasks(id,withdrawal_id,kind,profile_id,bucket_id,object_name,object_id)values(pg_temp.member_inv_id(30),pg_temp.member_inv_id(102),'storage_object',pg_temp.member_inv_id(2),'profile-images',pg_temp.member_inv_id(2)::text||'/synthetic.png',pg_temp.member_inv_id(201));
do $$declare req uuid:=pg_temp.member_inv_id(903);tok uuid:=pg_temp.member_inv_id(80);begin
 perform public.prepare_queue_invocation(req,tok,'member_cleanup',1,30000);perform public.claim_queue_invocation_dispatch(req,tok,'member_cleanup',1,30000);
 perform pg_temp.member_inv_reject(format('select public.claim_member_cleanup_task(%L::uuid)',tok),'40001');
 assert(select state='pending'and lease_token is null from private.member_cleanup_tasks where id=pg_temp.member_inv_id(30));
 assert not exists(select 1 from private.worker_jobs where id=pg_temp.member_inv_id(30));
 assert(select count(*)=20 from private.worker_runtime_job_slots where global_token=tok);
end;$$;
rollback to savepoint member_cap;
savepoint member_collision;
insert into private.member_cleanup_tasks(id,withdrawal_id,kind,profile_id,bucket_id,object_name,object_id)values(pg_temp.member_inv_id(30),pg_temp.member_inv_id(102),'storage_object',pg_temp.member_inv_id(2),'profile-images',pg_temp.member_inv_id(2)::text||'/synthetic.png',pg_temp.member_inv_id(201));
insert into private.worker_jobs(id,kind,dedupe_key,payload,available_at)values(pg_temp.member_inv_id(30),'review_summary','synthetic-collision',jsonb_build_object('profileId',pg_temp.member_inv_id(2),'sourceRevision','0','modelVersion','synthetic','promptVersion','synthetic'),clock_timestamp());
do $$declare req uuid:=pg_temp.member_inv_id(904);tok uuid:=pg_temp.member_inv_id(80);begin
 perform public.prepare_queue_invocation(req,tok,'member_cleanup',1,30000);perform public.claim_queue_invocation_dispatch(req,tok,'member_cleanup',1,30000);
 perform pg_temp.member_inv_reject(format('select public.claim_member_cleanup_task(%L::uuid)',tok),'40001');
 assert(select kind='review_summary'and status='queued'from private.worker_jobs where id=pg_temp.member_inv_id(30));
 assert(select state='pending'from private.member_cleanup_tasks where id=pg_temp.member_inv_id(30));
end;$$;
rollback to savepoint member_collision;
-- ACK 없는 미확정 DELETE intent는 새 claim/전송 허가가 되지 않는다.
insert into private.member_cleanup_tasks(id,withdrawal_id,kind,profile_id,bucket_id,object_name,object_id)values(pg_temp.member_inv_id(40),pg_temp.member_inv_id(103),'storage_object',pg_temp.member_inv_id(3),'profile-images',pg_temp.member_inv_id(3)::text||'/synthetic.png',pg_temp.member_inv_id(202));
do $$declare req uuid:=pg_temp.member_inv_id(905);tok uuid:=pg_temp.member_inv_id(80);t jsonb;before_dispatch jsonb;begin
 perform public.prepare_queue_invocation(req,tok,'member_cleanup',1,30000);perform public.claim_queue_invocation_dispatch(req,tok,'member_cleanup',1,30000);
 t:=public.claim_member_cleanup_task(tok);perform public.begin_member_cleanup_delete((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,tok,(t->>'objectId')::uuid);
 select to_jsonb(d)into before_dispatch from private.member_cleanup_dispatches d where task_id=(t->>'taskId')::uuid;
 perform public.mark_queue_invocation_unknown(req);
 perform pg_temp.member_inv_reject(format('select public.begin_member_cleanup_delete(%L::uuid,%L::uuid,%L::uuid,%L::uuid)',t->>'taskId',t->>'leaseToken',tok,t->>'objectId'),'55000');
 perform pg_temp.member_inv_reject(format('select public.claim_member_cleanup_task(%L::uuid)',tok),'55000');
 perform pg_temp.member_inv_reject(format('select public.complete_queue_invocation(%L::uuid)',req),'55000');
 assert(select to_jsonb(d)=before_dispatch from private.member_cleanup_dispatches d where task_id=(t->>'taskId')::uuid);
 assert not exists(select 1 from private.member_cleanup_delete_acks where task_id=(t->>'taskId')::uuid);
 assert(public.read_worker_runtime_pending_v2()->>'hasPending')::boolean;
 assert(public.get_queue_invocation(req)->>'state')='unknown';
end;$$;
rollback;
