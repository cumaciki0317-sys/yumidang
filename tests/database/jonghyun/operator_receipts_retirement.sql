-- 종현: 승인3의 native SQL 책임 후보. 아직 NOT_RUN이며 실제 직원/API/Auth DELETE/Storage 증거가 아니다.
-- owner가 만든 합성 영수증은 FK/키 보존 검사만 한다. 판정·이의·종결 workflow 성공으로 집계하지 않는다.
-- 정식 격리 target/새 migration pins 준비 후 owner TX에서만 실행하며 모든 변경은 ROLLBACK한다.
begin;
set local plpgsql.check_asserts=on;
set local storage.allow_delete_query='true';
create function pg_temp.operator_uid(n integer)returns uuid language sql immutable as $$
 select ('fa140000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.operator_sid(n integer)returns uuid language sql immutable as $$
 select ('fa140001-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.operator_actor(n integer)returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.operator_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.operator_uid(n),
  'session_id',pg_temp.operator_sid(n),'is_anonymous',false)::text,true);
end;$$;
create function pg_temp.operator_failure(command text,expected text)returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('expected %s, actual %s',expected,code);
end;$$;
create temp table operator_catalog as select
 (select jsonb_agg(to_jsonb(r)order by oid)from pg_roles r)roles,
 (select jsonb_agg(to_jsonb(m)order by roleid,member,grantor)from pg_auth_members m)memberships,
 (select to_jsonb(g)from private.global_worker_run g where singleton)worker;
do $$declare t regclass;begin
 foreach t in array array['private.assigned_report_final_closures'::regclass,
  'private.general_sanction_appeal_resolutions'::regclass,'private.cancellation_clock_repair_receipts'::regclass]loop
  assert not exists(select 1 from pg_constraint where conrelid=t and contype='f'and confrelid='auth.users'::regclass);
  assert exists(select 1 from pg_constraint c where conrelid=t and contype='p'and
   (select array_agg(a.attname::text order by k.n)from unnest(c.conkey)with ordinality k(att,n)
    join pg_attribute a on a.attrelid=t and a.attnum=k.att)=array['actor_id','client_request_id']);
  assert exists(select 1 from pg_constraint where conrelid=t and contype='f'and confrelid='private.member_reports'::regclass and confdeltype='c');
  assert(select relrowsecurity from pg_class where oid=t);
  assert not has_table_privilege('authenticated',t,'SELECT');
 end loop;
 assert exists(select 1 from pg_constraint where conrelid='private.report_operator_approvals'::regclass and confrelid='auth.users'::regclass and confdeltype='c');
 assert exists(select 1 from pg_constraint where conrelid='private.report_operator_assignments'::regclass and confrelid='auth.users'::regclass and confdeltype='n');
 assert exists(select 1 from pg_constraint where conrelid='private.general_sanction_appeal_resolutions'::regclass and confrelid='private.safety_appeals'::regclass and confdeltype='c');
end;$$;

-- 1/2는 신고자/대상,3은 일반 회원 직원. 기존 네이버/사진/가입 계약으로 합성 준비한다.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg'])on conflict(id)do nothing;
set local role service_role;
do $$declare i integer;begin for i in 1..3 loop
 perform public.resolve_naver_account('operator-retirement-sql-'||i,'합성회원'||i,'F','1990-01-01');
end loop;end;$$;
reset role;
insert into auth.users(id,email)select pg_temp.operator_uid(i),a.auth_email from generate_series(1,3)i
 join private.naver_accounts a on a.subject='operator-retirement-sql-'||i;
insert into auth.sessions(id,user_id)select pg_temp.operator_sid(i),pg_temp.operator_uid(i)from generate_series(1,3)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.operator_uid(i)::text||'/'||pg_temp.operator_uid(i)::text||'.jpg',
 pg_temp.operator_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,3)i;
set local role service_role;
do $$declare i integer;begin for i in 1..3 loop
 perform public.record_naver_session('operator-retirement-sql-'||i,pg_temp.operator_uid(i),pg_temp.operator_sid(i));
end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..3 loop
 perform pg_temp.operator_actor(i);
 assert public.complete_naver_signup(pg_temp.operator_uid(i)::text||'/'||pg_temp.operator_uid(i)::text||'.jpg','{}','{}',null)->>'status'='ready';
end loop;end;$$;
reset role;
-- Auth-only 비회원 직원의 기존 허용 범위에는 새 profile/네이버 가입을 요구하지 않는다.
insert into auth.users(id,email)values(pg_temp.operator_uid(4),'synthetic-staff@test.invalid');
insert into auth.sessions(id,user_id)values(pg_temp.operator_sid(4),pg_temp.operator_uid(4));
select pg_temp.operator_actor(1);
insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,hide_target,fingerprint)
 select pg_temp.operator_uid(10),pg_temp.operator_uid(1),e.id,pg_temp.operator_uid(11),'member',pg_temp.operator_uid(2),'offline',array['spam'],false,repeat('a',64)
 from private.member_episodes e where profile_id=pg_temp.operator_uid(1)and ended_at is null;
insert into private.member_report_details(report_id,description)values(pg_temp.operator_uid(10),'합성 직원 탈퇴 FK 검사');
do $$declare closed timestamptz:=clock_timestamp();begin
 update private.member_reports set status='resolved',final_closed_at=closed,retention_due_at=closed+interval'2160 hours'
  where id=pg_temp.operator_uid(10);
end;$$;
select private.set_report_operator_approval(pg_temp.operator_uid(3),true);
select private.set_report_operator_approval(pg_temp.operator_uid(4),true);
select private.set_report_operator_assignment(pg_temp.operator_uid(3),pg_temp.operator_uid(10),true);
select private.set_report_operator_assignment(pg_temp.operator_uid(4),pg_temp.operator_uid(10),true);
insert into private.safety_appeals(id,identity_id,kind,appointment_id,received_at,deadline_at,report_id,source_episode_id)
 select pg_temp.operator_uid(12),e.identity_id,'cancellation',pg_temp.operator_uid(13),clock_timestamp(),clock_timestamp()+interval'1 day',pg_temp.operator_uid(10),e.id
 from private.member_episodes e where profile_id=pg_temp.operator_uid(1)and ended_at is null;
insert into private.assigned_report_final_closures values(pg_temp.operator_uid(3),pg_temp.operator_uid(14),pg_temp.operator_uid(10),repeat('b',64),'{"syntheticSchemaFixture":true}');
insert into private.general_sanction_appeal_resolutions values(pg_temp.operator_uid(3),pg_temp.operator_uid(15),pg_temp.operator_uid(10),pg_temp.operator_uid(12),repeat('c',64),'{"syntheticSchemaFixture":true}');
insert into private.cancellation_clock_repair_receipts values(pg_temp.operator_uid(3),pg_temp.operator_uid(16),pg_temp.operator_uid(10),repeat('d',64),'{"syntheticSchemaFixture":true}');
create temp table operator_receipts_before as select
 (select to_jsonb(r)from private.assigned_report_final_closures r where report_id=pg_temp.operator_uid(10))closure,
 (select to_jsonb(r)from private.general_sanction_appeal_resolutions r where report_id=pg_temp.operator_uid(10))appeal,
 (select to_jsonb(r)from private.cancellation_clock_repair_receipts r where report_id=pg_temp.operator_uid(10))repair,
 (select jsonb_build_array(final_closed_at,retention_due_at)from private.member_reports where id=pg_temp.operator_uid(10))clock,
 (select to_jsonb(a)from private.report_operator_approvals a where auth_user_id=pg_temp.operator_uid(4))other_approval,
 (select to_jsonb(a)from private.report_operator_assignments a where operator_uid=pg_temp.operator_uid(4))other_assignment;
-- native Auth row/일반 탈퇴의 SQL 효과만 검사한다. 외부 삭제 worker/완료 ACK는 실행하지 않는다.
update private.member_cleanup_guard set external_deletion_approved=true where singleton;
grant execute on function public.claim_member_cleanup_task(uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),
 public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),
 public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)to service_role;
set local role authenticated;
select pg_temp.operator_actor(4);
select public.get_assigned_member_report(pg_temp.operator_uid(10));
select pg_temp.operator_actor(3);
do $$declare result jsonb;begin
 result:=public.retire_my_account(pg_temp.operator_uid(17));
 assert result->>'status'='processing'and result->>'memberAccessRevoked'='true';
end;$$;
reset role;
do $$declare n timestamptz;begin
 select retired_at into strict n from private.member_retirements where profile_id=pg_temp.operator_uid(3);
 assert(select revoked_at=n from private.report_operator_approvals where auth_user_id=pg_temp.operator_uid(3));
 assert not exists(select 1 from private.report_operator_assignments where operator_uid=pg_temp.operator_uid(3)and revoked_at is distinct from n);
 assert(select other_approval from operator_receipts_before)=(select to_jsonb(a)from private.report_operator_approvals a where auth_user_id=pg_temp.operator_uid(4));
 assert(select other_assignment from operator_receipts_before)=(select to_jsonb(a)from private.report_operator_assignments a where operator_uid=pg_temp.operator_uid(4));
end;$$;
select pg_temp.operator_failure(format('select private.set_report_operator_approval(%L,true)',pg_temp.operator_uid(3)),'42501');
select pg_temp.operator_failure(format('select private.set_report_operator_assignment(%L,%L,true)',pg_temp.operator_uid(3),pg_temp.operator_uid(10)),'42501');
select private.set_report_operator_approval(pg_temp.operator_uid(3),false);
select private.set_report_operator_assignment(pg_temp.operator_uid(3),pg_temp.operator_uid(10),false);
-- owner로 세션을 다시 만든 공격 모형도 retired guard를 우회하지 못한다. 실제 재발급이 아니다.
savepoint retired_guard_probe;
-- helper를 우회한 owner 재승인 모형으로 공통 retired guard를 독립 검사하고 바로 원복한다.
update private.report_operator_approvals set revoked_at=null where auth_user_id=pg_temp.operator_uid(3);
update private.report_operator_assignments set revoked_at=null where operator_uid=pg_temp.operator_uid(3);
insert into auth.sessions(id,user_id)values(pg_temp.operator_sid(3),pg_temp.operator_uid(3));
set local role authenticated;
select pg_temp.operator_actor(3);
select pg_temp.operator_failure(format('select public.get_assigned_member_report(%L)',pg_temp.operator_uid(10)),'42501');
select pg_temp.operator_failure(format('select public.get_assigned_report_capture(%L,%L)',pg_temp.operator_uid(10),pg_temp.operator_uid(18)),'42501');
reset role;
rollback to savepoint retired_guard_probe;
delete from auth.users where id=pg_temp.operator_uid(3);
do $$begin
 assert(select closure from operator_receipts_before)=(select to_jsonb(r)from private.assigned_report_final_closures r where report_id=pg_temp.operator_uid(10));
 assert(select appeal from operator_receipts_before)=(select to_jsonb(r)from private.general_sanction_appeal_resolutions r where report_id=pg_temp.operator_uid(10));
 assert(select repair from operator_receipts_before)=(select to_jsonb(r)from private.cancellation_clock_repair_receipts r where report_id=pg_temp.operator_uid(10));
 assert(select clock from operator_receipts_before)=(select jsonb_build_array(final_closed_at,retention_due_at)from private.member_reports where id=pg_temp.operator_uid(10));
 assert not exists(select 1 from private.report_operator_approvals where auth_user_id=pg_temp.operator_uid(3));
 assert exists(select 1 from private.report_operator_assignments where report_id=pg_temp.operator_uid(10)and operator_uid is null);
end;$$;
-- 같은 UID 재생성도 기존 퇴직 기록을 지우거나 권한으로 재사용하지 않는다.
insert into auth.users(id,email)values(pg_temp.operator_uid(3),'synthetic-old-uid@test.invalid');
select pg_temp.operator_failure(format('select private.set_report_operator_approval(%L,true)',pg_temp.operator_uid(3)),'42501');
select pg_temp.operator_failure(format('select private.set_report_operator_assignment(%L,%L,true)',pg_temp.operator_uid(3),pg_temp.operator_uid(10)),'42501');
do $$declare role_name text;begin
 foreach role_name in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
  assert not has_table_privilege(role_name,'private.assigned_report_final_closures','SELECT');
  assert not has_function_privilege(role_name,'private.revoke_retired_report_operator()','EXECUTE');
  assert not has_function_privilege(role_name,'private.set_report_operator_approval(uuid,boolean)','EXECUTE');
  assert not has_function_privilege(role_name,'private.set_report_operator_assignment(uuid,uuid,boolean)','EXECUTE');
 end loop;
 assert(select roles from operator_catalog)=(select jsonb_agg(to_jsonb(r)order by oid)from pg_roles r);
 assert(select memberships from operator_catalog)=(select jsonb_agg(to_jsonb(m)order by roleid,member,grantor)from pg_auth_members m);
 assert(select worker from operator_catalog)is not distinct from(select to_jsonb(g)from private.global_worker_run g where singleton);
end;$$;
select 'NOT_RUN actual native SQL; FK fixture only; two-session NOWAIT/40001, HTTP, Auth/Storage physical deletion, ACK and natural 90-day purge still require dedicated execution';
rollback;
