-- 실행 준비만: source56 +40100 전용 scratch에서 합성 BEGIN/ROLLBACK으로 검증할 예정이다.
-- 운영 활성화·실제 LISTEN/외부 삭제·event_sync 실행 성공을 증명하지 않는다.
begin;
insert into private.global_worker_run(singleton)values(true)on conflict do nothing;
create function pg_temp.queue_id(n integer)returns uuid language sql immutable as $$select('d4010000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.queue_reject(command text,expected text)returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('unexpected SQLSTATE %s',code);
end; $$;
select set_config('request.jwt.claims','{}',true);
do $$declare x jsonb;r text;f regprocedure;own oid;owner_name text;t regclass;begin
 select proowner,pg_get_userbyid(proowner)into own,owner_name from pg_proc where oid='public.acquire_worker_run(integer,uuid)'::regprocedure;
 assert(select rolsuper or rolbypassrls from pg_roles where oid=own);
 assert owner_name not in('anon','authenticated','service_role','authenticator');
 foreach r in array array['anon','authenticated','service_role','authenticator']loop assert not pg_has_role(r,own,'USAGE')and not pg_has_role(r,own,'SET');end loop;
 assert has_schema_privilege(owner_name,'private','USAGE')and has_schema_privilege(owner_name,'public','USAGE');
 assert has_schema_privilege(owner_name,'auth','USAGE')and has_function_privilege(owner_name,'auth.role()','EXECUTE');
 assert has_function_privilege(owner_name,'private.assert_current_worker_run(uuid)','EXECUTE');
 foreach t in array array['private.worker_jobs'::regclass,'private.member_cleanup_tasks'::regclass,
 'private.member_cleanup_guard'::regclass,'private.member_retirements'::regclass,'private.global_worker_run'::regclass]loop
  assert has_table_privilege(owner_name,t,'SELECT');
 end loop;
 assert has_table_privilege(owner_name,'private.global_worker_run','UPDATE');
 assert(select proowner=own from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure);
 assert(select proowner=own from pg_proc where oid='public.read_worker_run_budget(uuid)'::regprocedure);
 foreach f in array array['public.read_worker_queue_schedule(text[],text)'::regprocedure,'public.read_worker_run_budget(uuid)'::regprocedure,'private.notify_worker_queue_changed()'::regprocedure]loop
  foreach r in array array['anon','authenticated','service_role']loop assert not has_function_privilege(r,f,'EXECUTE');end loop;
 end loop;
 x:=public.read_worker_queue_schedule();
 assert(select count(*)from jsonb_object_keys(x))=3;
 assert x->'nextDueAt'='null'::jsonb and x->'nextKind'='null'::jsonb;
 assert isfinite((x->>'serverNow')::timestamptz);
 perform pg_temp.queue_reject('select public.read_worker_queue_schedule(null,null)','22023');
 perform pg_temp.queue_reject('select public.read_worker_queue_schedule(array[null::text],null)','22023');
 perform pg_temp.queue_reject('select public.read_worker_queue_schedule(array[''other''],null)','22023');
 perform pg_temp.queue_reject('select public.read_worker_queue_schedule(''{}'', ''other'')','22023');
 perform pg_temp.queue_reject('select public.read_worker_queue_schedule(array[[''event_sync'']],null)','22023');
 perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 perform pg_temp.queue_reject('select public.read_worker_queue_schedule()','42501');
 perform pg_temp.queue_reject('select public.read_worker_run_budget(null)','42501');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform pg_temp.queue_reject('select public.read_worker_run_budget(null)','40001');
end; $$;
-- cleanup due는 실제 기존 task 테이블에서 읽는다. 가짜 provider 삭제 완료는 호출하지 않는다.
insert into auth.users(id)values(pg_temp.queue_id(1)),(pg_temp.queue_id(2));
insert into public.profiles(id,real_name,birth_date,gender)values(pg_temp.queue_id(1),'합성 정리 회원','1990-01-01','female'),(pg_temp.queue_id(2),'합성 요약 회원','1990-01-01','female');
insert into private.member_retirements(profile_id,withdrawal_id,episode_id)
 values(pg_temp.queue_id(1),pg_temp.queue_id(41),private.active_member_episode(pg_temp.queue_id(1)));
insert into private.member_cleanup_tasks(id,withdrawal_id,kind,profile_id,bucket_id,object_name,object_id)
 values(pg_temp.queue_id(11),pg_temp.queue_id(41),'storage_object',pg_temp.queue_id(1),'profile-images',pg_temp.queue_id(1)::text||'/synthetic.jpg',pg_temp.queue_id(51)),
 (pg_temp.queue_id(12),pg_temp.queue_id(41),'auth_user',pg_temp.queue_id(1),null,null,null);
select public.enqueue_job('review_summary','synthetic-queue-schedule',jsonb_build_object('profileId',pg_temp.queue_id(2),'sourceRevision','0','modelVersion','synthetic','promptVersion','synthetic'),clock_timestamp()-interval'1 hour');
-- 승인/5개 service ACL 준비는 이 rollback transaction의 합성 owner fixture에만 적용한다.
do $$declare x jsonb;f regprocedure;begin
 x:=public.read_worker_queue_schedule(array['review_summary'],null);assert x->'nextKind'='null'::jsonb;
 update private.member_cleanup_guard set external_deletion_approved=true where singleton;
 x:=public.read_worker_queue_schedule(array['review_summary'],null);assert x->'nextKind'='null'::jsonb;
 foreach f in array array['public.claim_member_cleanup_task(uuid)'::regprocedure,
 'public.check_member_cleanup_task(uuid,uuid,uuid,uuid)'::regprocedure,
 'public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)'::regprocedure,
 'public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)'::regprocedure,
 'public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)'::regprocedure]loop
  execute format('grant execute on function %s to service_role',f);
 end loop;
 x:=public.read_worker_queue_schedule(array['review_summary'],null);assert x->>'nextKind'='member_cleanup';
 -- 각각 하나라도 닫히면 due를 숨기며 기존 task는 그대로다.
 foreach f in array array['public.claim_member_cleanup_task(uuid)'::regprocedure,
 'public.check_member_cleanup_task(uuid,uuid,uuid,uuid)'::regprocedure,
 'public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)'::regprocedure,
 'public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)'::regprocedure,
 'public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)'::regprocedure]loop
  execute format('revoke execute on function %s from service_role',f);
  x:=public.read_worker_queue_schedule(array['review_summary'],null);assert x->'nextKind'='null'::jsonb;
  execute format('grant execute on function %s to service_role',f);
 end loop;
 update private.member_cleanup_guard set external_deletion_approved=false where singleton;
 x:=public.read_worker_queue_schedule(array['review_summary'],null);assert x->'nextKind'='null'::jsonb;
 assert(select count(*)from private.member_cleanup_tasks where withdrawal_id=pg_temp.queue_id(41)and state='pending')=2;
 update private.member_cleanup_guard set external_deletion_approved=true where singleton;
end; $$;
do $$declare x jsonb;v_token uuid;expiry timestamptz;first_budget bigint;second_budget bigint;lease jsonb;begin
 x:=public.read_worker_queue_schedule();assert x->>'nextKind'='review_summary';
 x:=public.read_worker_queue_schedule('{}','review_summary');assert x->>'nextKind'='member_cleanup';
 x:=public.read_worker_queue_schedule('{}','member_cleanup');assert x->>'nextKind'='review_summary';
 x:=public.read_worker_queue_schedule(array['review_summary'],'event_sync');assert x->>'nextKind'='member_cleanup';
 x:=public.read_worker_queue_schedule(array['review_summary','event_sync','member_cleanup'],null);assert x->'nextDueAt'='null'::jsonb and x->'nextKind'='null'::jsonb;
 -- 조회 슬롯은 행사 kind를 확장하지 않는다. 현행 enqueue/DB/J 포트의 행사 선행 gap은 유지한다.
 perform pg_temp.queue_reject(format('select public.enqueue_job(''event_sync'',''synthetic-event-gap'',%L::jsonb,clock_timestamp())','{"provider":"synthetic","windowStart":"2026-10-05","windowEnd":"2026-10-05"}'),'22023');
 -- Auth가 pending이어도 Storage running 만료보다 앞서 due가 되지 않는다.
 update private.member_cleanup_tasks set state='running',lease_token=pg_temp.queue_id(61),worker_run_token=pg_temp.queue_id(62),lease_expires_at=clock_timestamp()+interval'30 seconds'where id=pg_temp.queue_id(11);
 x:=public.read_worker_queue_schedule(array['review_summary'],null);
 assert x->>'nextKind'='member_cleanup'and(x->>'nextDueAt')::timestamptz>(x->>'serverNow')::timestamptz;
 assert(x->>'nextDueAt')::timestamptz=(select lease_expires_at from private.member_cleanup_tasks where id=pg_temp.queue_id(11));
 -- 합성 metadata 전이로만 due 의존을 검증한다. 실제 삭제 증거로 취급하지 않는다.
 update private.member_cleanup_tasks set state='completed',lease_token=null,worker_run_token=null,lease_expires_at=null,evidence_sha256=repeat('a',64),completed_at=clock_timestamp()where id=pg_temp.queue_id(11);
 x:=public.read_worker_queue_schedule(array['review_summary'],null);assert(x->>'nextDueAt')::timestamptz=(x->>'serverNow')::timestamptz;
 update private.member_cleanup_tasks set state='running',lease_token=pg_temp.queue_id(63),worker_run_token=pg_temp.queue_id(64),lease_expires_at=clock_timestamp()-interval'1 second'where id=pg_temp.queue_id(12);
 x:=public.read_worker_queue_schedule(array['review_summary'],null);assert(x->>'nextDueAt')::timestamptz<(x->>'serverNow')::timestamptz;
 -- 전역 점유 중에는 같은 즉시 due를 반복 반환하지 않는다. 획득2key는 유지한다.
 lease:=public.acquire_worker_run(180,null);assert(select count(*)from jsonb_object_keys(lease))=2;v_token:=(lease->>'token')::uuid;
 select expires_at into expiry from private.global_worker_run where singleton;
 x:=public.read_worker_queue_schedule();assert(x->>'nextDueAt')::timestamptz=expiry;
 x:=public.read_worker_run_budget(v_token);assert(select count(*)from jsonb_object_keys(x))=1;
 first_budget:=(x->>'remainingMs')::bigint;assert first_budget between 1 and 180000;
 perform pg_sleep(0.01);second_budget:=(public.read_worker_run_budget(v_token)->>'remainingMs')::bigint;assert second_budget<first_budget;
 assert(select expires_at from private.global_worker_run where singleton)=expiry;
 perform pg_temp.queue_reject(format('select public.read_worker_run_budget(%L)',pg_temp.queue_id(65)),'40001');
 update private.global_worker_run set expires_at=clock_timestamp()-interval'1 second'where singleton;
 perform pg_temp.queue_reject(format('select public.read_worker_run_budget(%L)',v_token),'40001');
 x:=public.read_worker_queue_schedule();assert(x->>'nextDueAt')::timestamptz<=(x->>'serverNow')::timestamptz;
 update private.global_worker_run set expires_at=expiry where singleton;
 perform public.release_worker_run(v_token);
 assert(select token is null and expires_at is null from private.global_worker_run where singleton);
end; $$;
-- native role ACL은 열지 않고 현재 닫힘만 검사한다.
set local role authenticated;
select pg_temp.queue_reject('select public.read_worker_queue_schedule()','42501');
select pg_temp.queue_reject('select public.read_worker_run_budget(null)','42501');
reset role;
do $$begin
 assert(select count(*)from pg_trigger where not tgisinternal and tgname in('worker_queue_schedule_jobs','worker_queue_schedule_cleanup','worker_queue_schedule_global','worker_queue_schedule_approval'))=4;
 assert(select prosrc not ilike '%new.%'and prosrc not ilike '%old.%'from pg_proc where oid='private.notify_worker_queue_changed()'::regprocedure);
end; $$;
rollback;
