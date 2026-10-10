-- SQL115 합성 scratch 전용 rollback. 외부 HTTP/Storage/Auth DELETE를 호출하지 않는다.
-- 합성 ACK/evidence는 DB 계약 검증용이며 실제 외부 GET/404 검증 PASS를 의미하지 않는다.
begin;
do $$declare f regprocedure;role_name text;begin
 if exists(select 1 from private.worker_jobs)or exists(select 1 from private.worker_invocations)or exists(select 1 from private.worker_runtime_intents)or exists(select 1 from private.worker_runtime_results)or exists(select 1 from private.member_cleanup_tasks)or exists(select 1 from private.member_cleanup_reconciliations)then raise exception 'empty_synthetic_scratch_required';end if;
 foreach f in array array['public.begin_member_cleanup_reconcile(uuid,uuid,uuid,uuid)'::regprocedure,'public.get_member_cleanup_reconcile(uuid)'::regprocedure,'public.finish_member_cleanup_reconcile(uuid,text)'::regprocedure,'public.complete_queue_invocation(uuid)'::regprocedure]loop
  foreach role_name in array array['anon','authenticated','service_role','yumidang_worker_queue']loop assert not has_function_privilege(role_name,f,'EXECUTE');end loop;
 end loop;
 assert not(select enabled from private.worker_invocation_control where singleton);
 assert not(select external_deletion_approved from private.member_cleanup_guard where singleton);
 assert(select relrowsecurity from pg_class where oid='private.member_cleanup_reconciliations'::regclass);
 assert not has_table_privilege('service_role','private.member_cleanup_reconciliations','SELECT,INSERT,UPDATE,DELETE');
end;$$;
create function pg_temp.member_rec_id(n integer)returns uuid language sql immutable as $$select('d1150000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.member_rec_reject(command text,expected text)returns void language plpgsql as $$declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('unexpected SQLSTATE %s expected %s',code,expected);
end;$$;
do $$begin
 assert not exists(select 1 from auth.users where id in(pg_temp.member_rec_id(1),pg_temp.member_rec_id(2),pg_temp.member_rec_id(3)));
 assert not exists(select 1 from public.profiles where id in(pg_temp.member_rec_id(1),pg_temp.member_rec_id(2),pg_temp.member_rec_id(3)));
end;$$;
insert into auth.users(id,email)select pg_temp.member_rec_id(n),pg_temp.member_rec_id(n)::text||'@member-reconcile.invalid'from generate_series(1,3)n;
insert into public.profiles(id,real_name,birth_date,gender)select pg_temp.member_rec_id(n),'합성회원','1990-01-01','female'from generate_series(1,3)n;
insert into private.member_retirements(profile_id,withdrawal_id,episode_id)select pg_temp.member_rec_id(n),pg_temp.member_rec_id(100+n),private.active_member_episode(pg_temp.member_rec_id(n))from generate_series(1,3)n;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.role','service_role',true);
update private.worker_invocation_control set enabled=true where singleton;
update private.worker_runtime_atomic_control set enabled=true where singleton;
update private.member_cleanup_guard set external_deletion_approved=true where singleton;
insert into private.global_worker_run(singleton,token,expires_at)values(true,pg_temp.member_rec_id(80),clock_timestamp()+interval'180 seconds')on conflict(singleton)do update set token=excluded.token,expires_at=excluded.expires_at;
insert into private.member_cleanup_tasks(id,withdrawal_id,kind,profile_id,bucket_id,object_name,object_id)values(pg_temp.member_rec_id(20),pg_temp.member_rec_id(101),'storage_object',pg_temp.member_rec_id(1),'profile-images',pg_temp.member_rec_id(1)::text||'/synthetic.png',pg_temp.member_rec_id(200));
do $$declare t jsonb;begin
 perform public.prepare_queue_invocation(pg_temp.member_rec_id(890),pg_temp.member_rec_id(80),'member_cleanup',5,30000);
 perform public.claim_queue_invocation_dispatch(pg_temp.member_rec_id(890),pg_temp.member_rec_id(80),'member_cleanup',5,30000);
 t:=public.claim_member_cleanup_task(pg_temp.member_rec_id(80));
 perform public.begin_member_cleanup_delete((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,pg_temp.member_rec_id(80),(t->>'objectId')::uuid);
 perform public.record_member_cleanup_delete_ack((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,pg_temp.member_rec_id(80),(t->>'objectId')::uuid,repeat('a',64));
 perform public.mark_queue_invocation_unknown(pg_temp.member_rec_id(890));
end;$$;
create temporary table original_member_proof as select to_jsonb(d)dispatch,to_jsonb(a)ack,j.lease_token original_job_lease,v.global_token original_invocation_token,v.deadline original_deadline
 from private.member_cleanup_dispatches d join private.member_cleanup_delete_acks a on a.task_id=d.task_id join private.worker_jobs j on j.id=d.task_id join private.worker_invocations v on v.request_id=pg_temp.member_rec_id(890)where d.task_id=pg_temp.member_rec_id(20);
-- 만료된 원 token은 성공 증거가 아니다. 별도 현재 global을 부여하며 원 invocation/fence는 보존한다.
update private.member_cleanup_tasks set lease_expires_at=clock_timestamp()-interval'1 second'where id=pg_temp.member_rec_id(20);
update private.worker_jobs set lease_expires_at=clock_timestamp()-interval'1 second'where id=pg_temp.member_rec_id(20);
update private.global_worker_run set token=pg_temp.member_rec_id(81),expires_at=clock_timestamp()+interval'180 seconds'where singleton;
savepoint no_ack;
delete from private.member_cleanup_delete_acks where task_id=pg_temp.member_rec_id(20);
select pg_temp.member_rec_reject('select public.begin_member_cleanup_reconcile(pg_temp.member_rec_id(900),pg_temp.member_rec_id(890),pg_temp.member_rec_id(20),pg_temp.member_rec_id(81))','40001');
do $$begin assert not exists(select 1 from private.member_cleanup_reconciliations);end;$$;
rollback to savepoint no_ack;
savepoint wrong_ack;
update private.member_cleanup_delete_acks set recorded_worker_run_token=pg_temp.member_rec_id(82)where task_id=pg_temp.member_rec_id(20);
select pg_temp.member_rec_reject('select public.begin_member_cleanup_reconcile(pg_temp.member_rec_id(900),pg_temp.member_rec_id(890),pg_temp.member_rec_id(20),pg_temp.member_rec_id(81))','40001');
rollback to savepoint wrong_ack;
savepoint slot_cap;
insert into private.worker_runtime_job_slots(global_token,job_id)select pg_temp.member_rec_id(81),md5('reconcile115slot'||n)::uuid from generate_series(1,20)n;
select pg_temp.member_rec_reject('select public.begin_member_cleanup_reconcile(pg_temp.member_rec_id(900),pg_temp.member_rec_id(890),pg_temp.member_rec_id(20),pg_temp.member_rec_id(81))','40001');
do $$begin
 assert not exists(select 1 from private.member_cleanup_reconciliations);
 assert(select lease_token=original_job_lease from private.member_cleanup_tasks cross join original_member_proof where id=pg_temp.member_rec_id(20));
end;$$;
rollback to savepoint slot_cap;
do $$declare b jsonb;again jsonb;r private.member_cleanup_reconciliations;t private.member_cleanup_tasks;expiry timestamptz;begin
 select expires_at into expiry from private.global_worker_run where singleton;
 b:=public.begin_member_cleanup_reconcile(pg_temp.member_rec_id(900),pg_temp.member_rec_id(890),pg_temp.member_rec_id(20),pg_temp.member_rec_id(81));
 assert(b->>'fresh')::boolean and b->>'state'='prepared';
 select *into r from private.member_cleanup_reconciliations where recovery_request_id=pg_temp.member_rec_id(900);
 assert r.original_global_token=pg_temp.member_rec_id(80)and r.recovery_global_token=pg_temp.member_rec_id(81);
 assert r.original_job_lease_token<>r.recovery_lease_token;
 assert r.recovery_expires_at<=expiry;
 select *into t from private.member_cleanup_tasks where id=r.task_id;
 again:=public.begin_member_cleanup_reconcile(pg_temp.member_rec_id(900),pg_temp.member_rec_id(890),pg_temp.member_rec_id(20),pg_temp.member_rec_id(81));
 assert not(again->>'fresh')::boolean and again->'task'='null'::jsonb;
 assert(select lease_token=t.lease_token and lease_expires_at=t.lease_expires_at from private.member_cleanup_tasks where id=t.id);
 assert(select count(*)=1 from private.worker_runtime_job_slots where global_token=pg_temp.member_rec_id(81));
 assert(select count(*)=1 from private.worker_runtime_job_slots where global_token=pg_temp.member_rec_id(80));
 assert(select global_token=original_invocation_token and deadline=original_deadline from private.worker_invocations cross join original_member_proof where request_id=r.invocation_request_id);
 assert(select lease_token=original_job_lease from private.worker_jobs cross join original_member_proof where id=r.job_id);
 assert(select effect is null and settled_status is null from private.worker_invocation_jobs where request_id=r.invocation_request_id);
 assert not(public.get_member_cleanup_reconcile(r.recovery_request_id)::text like '%objectName%');
 assert(select expires_at=expiry from private.global_worker_run where singleton);
end;$$;
select pg_temp.member_rec_reject('select public.begin_member_cleanup_reconcile(pg_temp.member_rec_id(900),pg_temp.member_rec_id(890),pg_temp.member_rec_id(20),pg_temp.member_rec_id(82))','40001');
savepoint wrong_target;
update private.member_cleanup_tasks set object_name=pg_temp.member_rec_id(1)::text||'/changed.png'where id=pg_temp.member_rec_id(20);
select pg_temp.member_rec_reject('select public.finish_member_cleanup_reconcile(pg_temp.member_rec_id(900),repeat(''b'',64))','40001');
rollback to savepoint wrong_target;
savepoint metadata_present;
insert into storage.buckets(id,name,public)values('profile-images','profile-images',false)on conflict do nothing;
insert into storage.objects(id,bucket_id,name,owner_id)values(pg_temp.member_rec_id(200),'profile-images',pg_temp.member_rec_id(1)::text||'/synthetic.png',pg_temp.member_rec_id(1)::text);
select pg_temp.member_rec_reject('select public.finish_member_cleanup_reconcile(pg_temp.member_rec_id(900),repeat(''b'',64))','40001');
do $$begin
 assert(select state='prepared'from private.member_cleanup_reconciliations where recovery_request_id=pg_temp.member_rec_id(900));
 assert(select status='running'from private.worker_jobs where id=pg_temp.member_rec_id(20));
end;$$;
rollback to savepoint metadata_present;
savepoint expired_recovery;
update private.global_worker_run set expires_at=clock_timestamp()-interval'1 second'where singleton;
select pg_temp.member_rec_reject('select public.finish_member_cleanup_reconcile(pg_temp.member_rec_id(900),repeat(''b'',64))','40001');
rollback to savepoint expired_recovery;
savepoint expired_task_recovery;
update private.member_cleanup_reconciliations set recovery_expires_at=clock_timestamp()-interval'1 second'where recovery_request_id=pg_temp.member_rec_id(900);
select pg_temp.member_rec_reject('select public.finish_member_cleanup_reconcile(pg_temp.member_rec_id(900),repeat(''b'',64))','55000');
rollback to savepoint expired_task_recovery;
do $$declare p jsonb;v jsonb;expiry timestamptz;begin
 select expires_at into expiry from private.global_worker_run where singleton;
 p:=public.finish_member_cleanup_reconcile(pg_temp.member_rec_id(900),repeat('b',64));assert p->>'state'='completed';
 assert(select state='unknown'from private.worker_invocations where request_id=pg_temp.member_rec_id(890));
 assert(select status='succeeded'and lease_token is null from private.worker_jobs where id=pg_temp.member_rec_id(20));
 assert(select settled_status='succeeded'and effect is null from private.worker_invocation_jobs where request_id=pg_temp.member_rec_id(890));
 assert(select count(*)=1 from private.worker_invocation_jobs where request_id=pg_temp.member_rec_id(890));
 assert(select to_jsonb(d)=o.dispatch and to_jsonb(a)=o.ack from private.member_cleanup_dispatches d join private.member_cleanup_delete_acks a on a.task_id=d.task_id cross join original_member_proof o where d.task_id=pg_temp.member_rec_id(20));
 assert public.get_member_cleanup_reconcile(pg_temp.member_rec_id(900))=p;
 assert public.finish_member_cleanup_reconcile(pg_temp.member_rec_id(900),repeat('b',64))=p;
 assert not(public.begin_member_cleanup_reconcile(pg_temp.member_rec_id(900),pg_temp.member_rec_id(890),pg_temp.member_rec_id(20),pg_temp.member_rec_id(81))->>'fresh')::boolean;
 perform pg_temp.member_rec_reject('select public.finish_member_cleanup_reconcile(pg_temp.member_rec_id(900),repeat(''c'',64))','40001');
 v:=public.complete_queue_invocation(pg_temp.member_rec_id(890));assert v->>'state'='completed';
 assert v->'result'->'counts'='{"claimed":1,"succeeded":1,"retried":0,"failed":0,"superseded":0,"yielded":0}'::jsonb;
 assert v->>'globalToken'=pg_temp.member_rec_id(80)::text;
 assert public.get_queue_invocation(pg_temp.member_rec_id(890))=v;assert public.complete_queue_invocation(pg_temp.member_rec_id(890))=v;
 assert not(public.read_worker_runtime_pending_v2()->>'hasPending')::boolean;
 assert(select expires_at=expiry from private.global_worker_run where singleton);
end;$$;
-- 최신112/114 이전 완료 delegate를 보존한다.
do $$declare req uuid:=pg_temp.member_rec_id(891);tok uuid:=pg_temp.member_rec_id(81);begin
 perform public.prepare_queue_invocation(req,tok,'review_summary',1,30000);perform public.claim_queue_invocation_dispatch(req,tok,'review_summary',1,30000);
 assert public.claim_supported_job(pg_temp.member_rec_id(90),180,tok,array['review_summary'])='{"job":null}'::jsonb;
 assert(public.complete_queue_invocation(req)->'result'->'counts'->>'claimed')::integer=0;
end;$$;
-- Auth row 부재도 기존 완료 계약으로 확인한다. SQL fixture metadata만 rollback 범위에서 바꾼다.
savepoint auth_reconcile;
insert into private.member_cleanup_tasks(id,withdrawal_id,kind,profile_id)values(pg_temp.member_rec_id(40),pg_temp.member_rec_id(103),'auth_user',pg_temp.member_rec_id(3));
do $$declare t jsonb;p jsonb;before_ack jsonb;before_dispatch jsonb;begin
 perform public.prepare_queue_invocation(pg_temp.member_rec_id(893),pg_temp.member_rec_id(81),'member_cleanup',1,30000);perform public.claim_queue_invocation_dispatch(pg_temp.member_rec_id(893),pg_temp.member_rec_id(81),'member_cleanup',1,30000);
 t:=public.claim_member_cleanup_task(pg_temp.member_rec_id(81));assert t->>'kind'='auth_user';
 perform public.begin_member_cleanup_delete((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,pg_temp.member_rec_id(81),null);
 perform public.record_member_cleanup_delete_ack((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,pg_temp.member_rec_id(81),null,repeat('d',64));
 select to_jsonb(a)into before_ack from private.member_cleanup_delete_acks a where task_id=pg_temp.member_rec_id(40);
 select to_jsonb(d)into before_dispatch from private.member_cleanup_dispatches d where task_id=pg_temp.member_rec_id(40);
 perform public.mark_queue_invocation_unknown(pg_temp.member_rec_id(893));
 update private.member_cleanup_tasks set lease_expires_at=clock_timestamp()-interval'1 second'where id=pg_temp.member_rec_id(40);
 update private.worker_jobs set lease_expires_at=clock_timestamp()-interval'1 second'where id=pg_temp.member_rec_id(40);
 update private.global_worker_run set token=pg_temp.member_rec_id(83),expires_at=clock_timestamp()+interval'180 seconds'where singleton;
 p:=public.begin_member_cleanup_reconcile(pg_temp.member_rec_id(902),pg_temp.member_rec_id(893),pg_temp.member_rec_id(40),pg_temp.member_rec_id(83));assert(p->>'fresh')::boolean;
 perform pg_temp.member_rec_reject('select public.finish_member_cleanup_reconcile(pg_temp.member_rec_id(902),repeat(''e'',64))','40001');
 assert(select state='prepared'from private.member_cleanup_reconciliations where recovery_request_id=pg_temp.member_rec_id(902));
 delete from auth.users where id=pg_temp.member_rec_id(3);
 assert(public.finish_member_cleanup_reconcile(pg_temp.member_rec_id(902),repeat('e',64))->>'state')='completed';
 assert(public.complete_queue_invocation(pg_temp.member_rec_id(893))->>'state')='completed';
 assert(select effect is null and settled_status='succeeded'from private.worker_invocation_jobs where request_id=pg_temp.member_rec_id(893));
 assert(select to_jsonb(a)=before_ack from private.member_cleanup_delete_acks a where task_id=pg_temp.member_rec_id(40));
 assert(select to_jsonb(d)=before_dispatch from private.member_cleanup_dispatches d where task_id=pg_temp.member_rec_id(40));
end;$$;
rollback to savepoint auth_reconcile;
-- ACK 없는 원 UNKNOWN은 계속 보류한다. 외부 부재나 만료만으로 성공을 만들지 않는다.
insert into private.member_cleanup_tasks(id,withdrawal_id,kind,profile_id,bucket_id,object_name,object_id)values(pg_temp.member_rec_id(30),pg_temp.member_rec_id(102),'storage_object',pg_temp.member_rec_id(2),'profile-images',pg_temp.member_rec_id(2)::text||'/synthetic.png',pg_temp.member_rec_id(201));
do $$declare t jsonb;begin
 perform public.prepare_queue_invocation(pg_temp.member_rec_id(892),pg_temp.member_rec_id(81),'member_cleanup',1,30000);perform public.claim_queue_invocation_dispatch(pg_temp.member_rec_id(892),pg_temp.member_rec_id(81),'member_cleanup',1,30000);
 t:=public.claim_member_cleanup_task(pg_temp.member_rec_id(81));perform public.begin_member_cleanup_delete((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,pg_temp.member_rec_id(81),(t->>'objectId')::uuid);
 perform public.mark_queue_invocation_unknown(pg_temp.member_rec_id(892));
end;$$;
update private.member_cleanup_tasks set lease_expires_at=clock_timestamp()-interval'1 second'where id=pg_temp.member_rec_id(30);
update private.worker_jobs set lease_expires_at=clock_timestamp()-interval'1 second'where id=pg_temp.member_rec_id(30);
update private.global_worker_run set token=pg_temp.member_rec_id(82),expires_at=clock_timestamp()+interval'180 seconds'where singleton;
select pg_temp.member_rec_reject('select public.begin_member_cleanup_reconcile(pg_temp.member_rec_id(901),pg_temp.member_rec_id(892),pg_temp.member_rec_id(30),pg_temp.member_rec_id(82))','40001');
select pg_temp.member_rec_reject('select public.claim_member_cleanup_task(pg_temp.member_rec_id(82))','55000');
select pg_temp.member_rec_reject('select public.complete_queue_invocation(pg_temp.member_rec_id(892))','55000');
do $$begin
 assert not exists(select 1 from private.member_cleanup_reconciliations where invocation_request_id=pg_temp.member_rec_id(892));
 assert not exists(select 1 from private.member_cleanup_delete_acks where task_id=pg_temp.member_rec_id(30));
 assert(select state='unknown'from private.worker_invocations where request_id=pg_temp.member_rec_id(892));
 assert(select effect is null and settled_status is null from private.worker_invocation_jobs where request_id=pg_temp.member_rec_id(892));
 assert(public.read_worker_runtime_pending_v2()->>'hasPending')::boolean;
end;$$;
rollback;
