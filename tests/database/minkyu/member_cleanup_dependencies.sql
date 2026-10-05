-- source55 schema-only + 20136 독립 scratch. 합성 자료만 쓰며 모든 변경을 rollback한다.
begin;
insert into private.global_worker_run(singleton) values(true) on conflict do nothing;
insert into private.member_cleanup_guard(singleton) values(true) on conflict do nothing;
insert into storage.buckets(id,name,public) values('profile-images','profile-images',false) on conflict do nothing;
create function pg_temp.dep_id(n integer) returns uuid language sql immutable as $$
 select ('d1360000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.dep_reject(command text,expected text) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('unexpected SQLSTATE %s',code);
end; $$;
-- 문장 중간 global lease 만료는 완료 상태/retirement 갱신을 모두 rollback한다.
create function pg_temp.dep_delay_completion() returns trigger language plpgsql as $$
begin
 if current_setting('yumidang.dep_delay',true)='true' and new.kind='auth_user' and new.state='completed' then perform pg_sleep(1.1);end if;
 return new;
end; $$;
create trigger dep_delay_completion before update on private.member_cleanup_tasks for each row execute function pg_temp.dep_delay_completion();
insert into auth.users(id,email) select pg_temp.dep_id(n),pg_temp.dep_id(n)::text||'@naver.yumidang.invalid' from generate_series(1,3)n;
insert into public.profiles(id,real_name,birth_date,gender)
 select pg_temp.dep_id(n),'합성회원','1990-01-01','female' from generate_series(1,3)n;
insert into private.member_retirements(profile_id,withdrawal_id,episode_id)
 select pg_temp.dep_id(n),pg_temp.dep_id(100+n),private.active_member_episode(pg_temp.dep_id(n)) from generate_series(1,2)n;
insert into private.naver_accounts(subject,user_id,auth_email,real_name,birth_date,gender,verification_status)
 values('cleanup-readiness-fixture',pg_temp.dep_id(3),pg_temp.dep_id(3)::text||'@naver.yumidang.invalid','합성회원','1990-01-01','female','qualified');
-- Auth task UUID가 더 작아도 사진 작업이 먼저 선택되어야 한다.
insert into private.member_cleanup_tasks(id,withdrawal_id,kind,profile_id) values
 (pg_temp.dep_id(10),pg_temp.dep_id(101),'auth_user',pg_temp.dep_id(1));
insert into storage.objects(id,bucket_id,name,owner_id) values
 (pg_temp.dep_id(90),'profile-images',pg_temp.dep_id(1)::text||'/legacy-image.png',pg_temp.dep_id(1)::text);
insert into private.member_cleanup_tasks(id,withdrawal_id,kind,profile_id,bucket_id,object_name,object_id) values
 (pg_temp.dep_id(20),pg_temp.dep_id(101),'storage_object',pg_temp.dep_id(1),'profile-images',pg_temp.dep_id(1)::text||'/legacy-image.png',pg_temp.dep_id(90)),
 (pg_temp.dep_id(30),pg_temp.dep_id(102),'storage_object',pg_temp.dep_id(2),'profile-images',pg_temp.dep_id(2)::text||'/other.jpg',pg_temp.dep_id(91));
do $$declare f regprocedure;r text;begin
 foreach f in array array['private.assert_member_cleanup_storage_completed(uuid)'::regprocedure,
 'public.claim_member_cleanup_task(uuid)'::regprocedure,'public.check_member_cleanup_task(uuid,uuid,uuid,uuid)'::regprocedure,
 'public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)'::regprocedure] loop
  foreach r in array array['anon','authenticated','service_role'] loop
   assert not has_function_privilege(r,f,'EXECUTE');
  end loop;
 end loop;
 assert (select proowner from pg_proc where oid='private.assert_member_cleanup_storage_completed(uuid)'::regprocedure)=
        (select proowner from pg_proc where oid='public.check_member_cleanup_task(uuid,uuid,uuid,uuid)'::regprocedure);
end; $$;
select pg_temp.dep_reject('select public.claim_member_cleanup_task(pg_temp.dep_id(80))','55000');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update private.member_cleanup_guard set external_deletion_approved=true;
do $$declare g uuid;t jsonb;a jsonb;receipt jsonb;old_receipt jsonb;expiry timestamptz;begin
 g:=(public.acquire_worker_run(180,null)->>'token')::uuid;
 t:=public.claim_member_cleanup_task(g);
 assert t->>'taskId'=pg_temp.dep_id(20)::text and t->>'kind'='storage_object';
 assert public.check_member_cleanup_task((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,pg_temp.dep_id(90))=t;
 -- 인위적으로 오래된 Auth lease가 존재해도 check/ack/complete가 의존성을 거부한다.
 update private.member_cleanup_tasks set state='running',lease_token=pg_temp.dep_id(81),worker_run_token=g,lease_expires_at=clock_timestamp()+interval '60 seconds' where id=pg_temp.dep_id(10);
 perform pg_temp.dep_reject(format('select public.check_member_cleanup_task(%L,%L,%L,null)',pg_temp.dep_id(10),pg_temp.dep_id(81),g),'40001');
 perform pg_temp.dep_reject(format('select public.record_member_cleanup_delete_ack(%L,%L,%L,null,%L)',pg_temp.dep_id(10),pg_temp.dep_id(81),g,repeat('a',64)),'40001');
 perform pg_temp.dep_reject(format('select public.complete_member_cleanup_task(%L,%L,%L,null,%L)',pg_temp.dep_id(10),pg_temp.dep_id(81),g,repeat('b',64)),'40001');
 update private.member_cleanup_tasks set state='pending',lease_token=null,worker_run_token=null,lease_expires_at=null where id=pg_temp.dep_id(10);
 -- 합성 DELETE acknowledgement만 사용한다. 실제 provider 파일 삭제 증거라고 주장하지 않는다.
 receipt:=public.record_member_cleanup_delete_ack((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,pg_temp.dep_id(90),repeat('c',64));
 perform pg_temp.dep_reject(format('select public.complete_member_cleanup_task(%L,%L,%L,%L,%L)',t->>'taskId',t->>'leaseToken',g,pg_temp.dep_id(90),repeat('d',64)),'40001');
 perform set_config('storage.allow_delete_query','true',true);
 delete from storage.objects where id=pg_temp.dep_id(90);
 perform public.complete_member_cleanup_task((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,pg_temp.dep_id(90),repeat('d',64));
 a:=public.claim_member_cleanup_task(g);
 assert a->>'taskId'=pg_temp.dep_id(10)::text;
 assert public.check_member_cleanup_task((a->>'taskId')::uuid,(a->>'leaseToken')::uuid,g,null)=a;
 -- 다른 withdrawal의 미완료 사진은 이 Auth task를 막지 않는다.
 assert exists(select 1 from private.member_cleanup_tasks where id=pg_temp.dep_id(30) and state='pending');
 old_receipt:=public.record_member_cleanup_delete_ack((a->>'taskId')::uuid,(a->>'leaseToken')::uuid,g,null,repeat('e',64));
 -- 저장된 ack가 있어도 같은 withdrawal의 사진이 재처리 상태이면 완료 불가.
 update private.member_cleanup_tasks set state='pending',completed_at=null,evidence_sha256=null where id=pg_temp.dep_id(20);
 perform pg_temp.dep_reject(format('select public.get_member_cleanup_delete_ack(%L,%L,%L,null)',a->>'taskId',a->>'leaseToken',g),'40001');
 perform pg_temp.dep_reject(format('select public.complete_member_cleanup_task(%L,%L,%L,null,%L)',a->>'taskId',a->>'leaseToken',g,repeat('f',64)),'40001');
 update private.member_cleanup_tasks set state='completed',completed_at=clock_timestamp(),evidence_sha256=repeat('d',64) where id=pg_temp.dep_id(20);
 -- 현재 Storage owner에는 Auth FK가 없다. 실제 객체를 두고 Auth DELETE가 성공함을 rollback fixture로 관찰한다.
 insert into storage.objects(id,bucket_id,name,owner_id) values(pg_temp.dep_id(92),'profile-images',pg_temp.dep_id(1)::text||'/fk-probe.jpg',pg_temp.dep_id(1)::text);
 delete from auth.users where id=pg_temp.dep_id(1);
 assert exists(select 1 from storage.objects where id=pg_temp.dep_id(92) and owner_id=pg_temp.dep_id(1)::text);
 delete from storage.objects where id=pg_temp.dep_id(92);
 -- 기존 ack는 새 task lease에서 복구할 수 있다. 과거 lease는 거부된다.
 update private.member_cleanup_tasks set lease_expires_at=clock_timestamp()-interval '1 second' where id=pg_temp.dep_id(10);
 t:=public.claim_member_cleanup_task(g);
 assert t->>'taskId'=a->>'taskId' and t->>'leaseToken'<>a->>'leaseToken';
 perform pg_temp.dep_reject(format('select public.check_member_cleanup_task(%L,%L,%L,null)',a->>'taskId',a->>'leaseToken',g),'40001');
 assert public.get_member_cleanup_delete_ack((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,null)=old_receipt;
 select expires_at into expiry from private.global_worker_run where singleton;
 update private.global_worker_run set expires_at=clock_timestamp()-interval '1 second' where singleton;
 perform pg_temp.dep_reject(format('select public.complete_member_cleanup_task(%L,%L,%L,null,%L)',t->>'taskId',t->>'leaseToken',g,repeat('f',64)),'40001');
 assert (select state from private.member_cleanup_tasks where id=pg_temp.dep_id(10))='running';
 update private.global_worker_run set expires_at=clock_timestamp()+interval '1 second' where singleton;
 perform set_config('yumidang.dep_delay','true',true);
 perform pg_temp.dep_reject(format('select public.complete_member_cleanup_task(%L,%L,%L,null,%L)',t->>'taskId',t->>'leaseToken',g,repeat('f',64)),'40001');
 assert (select state from private.member_cleanup_tasks where id=pg_temp.dep_id(10))='running';
 assert (select state from private.member_retirements where withdrawal_id=pg_temp.dep_id(101))='pending_cleanup';
 assert exists(select 1 from private.member_cleanup_delete_acks where task_id=pg_temp.dep_id(10));
 perform set_config('yumidang.dep_delay','false',true);
 update private.global_worker_run set expires_at=expiry where singleton;
 perform public.complete_member_cleanup_task((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,null,repeat('f',64));
 assert (select state from private.member_retirements where withdrawal_id=pg_temp.dep_id(101))='completed';
 assert (select state from private.member_retirements where withdrawal_id=pg_temp.dep_id(102))='pending_cleanup';
 perform public.release_worker_run(g);
end; $$;

-- 최초 탈퇴 readiness, exact actor, 본인 영수증 재시도. 실제 DELETE pipeline은 열지 않는다.
select set_config('request.jwt.claim.sub',pg_temp.dep_id(3)::text,true);
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.dep_id(3),'is_anonymous',false)::text,true);
update private.member_cleanup_guard set external_deletion_approved=false;
set local role authenticated;
select pg_temp.dep_reject('select public.retire_my_account(pg_temp.dep_id(103))','55000');
reset role;
update private.member_cleanup_guard set external_deletion_approved=true;
select pg_temp.dep_reject('select public.retire_my_account(pg_temp.dep_id(103))','55000');
do $$declare f text;g text;functions text[]:=array['public.claim_member_cleanup_task(uuid)',
 'public.check_member_cleanup_task(uuid,uuid,uuid,uuid)','public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)',
 'public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)','public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)'];begin
 foreach f in array functions loop execute 'grant execute on function '||f||' to service_role';end loop;
 foreach f in array functions loop
  execute 'revoke execute on function '||f||' from service_role';
  perform pg_temp.dep_reject('select public.retire_my_account(pg_temp.dep_id(103))','55000');
  assert not exists(select 1 from private.member_retirements where profile_id=pg_temp.dep_id(3));
  execute 'grant execute on function '||f||' to service_role';
 end loop;
end; $$;
-- 승인/ACL이 준비되어도 anonymous claims와 잘못된 JWT 역할은 거부한다.
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.dep_id(3),'is_anonymous',true)::text,true);
set local role authenticated;
select pg_temp.dep_reject('select public.retire_my_account(pg_temp.dep_id(103))','28000');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('role','service_role','sub',pg_temp.dep_id(3))::text,true);
select pg_temp.dep_reject('select public.retire_my_account(pg_temp.dep_id(103))','28000');
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"authenticated","is_anonymous":false}',true);
set local role authenticated;
select pg_temp.dep_reject('select public.retire_my_account(pg_temp.dep_id(103))','28000');
reset role;
set local role anon;
select pg_temp.dep_reject('select public.retire_my_account(pg_temp.dep_id(103))','42501');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.dep_id(3)::text,true);
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.dep_id(3),'is_anonymous',false)::text,true);
set local role authenticated;
do $$declare x jsonb;begin
 x:=public.retire_my_account(pg_temp.dep_id(103));
 assert x->>'status'='processing' and (x->>'memberAccessRevoked')::boolean;
end; $$;
reset role;
update private.member_cleanup_guard set external_deletion_approved=false;
revoke execute on function public.claim_member_cleanup_task(uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),
 public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),
 public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text) from service_role;
set local role authenticated;
do $$begin assert public.retire_my_account(pg_temp.dep_id(103))->>'status'='processing';end; $$;
select pg_temp.dep_reject('select public.retire_my_account(pg_temp.dep_id(104))','42501');
reset role;
-- 다른 caller가 동일 withdrawal UUID를 알아도 해당 영수증을 받을 수 없다.
select set_config('request.jwt.claim.sub',pg_temp.dep_id(2)::text,true);
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.dep_id(2),'is_anonymous',false)::text,true);
set local role authenticated;
select pg_temp.dep_reject('select public.retire_my_account(pg_temp.dep_id(103))','42501');
reset role;
rollback;
