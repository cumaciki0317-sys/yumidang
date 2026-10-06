-- 민규: source69 이후 승인 담당 접근 SQL 회귀 후보. 실제 실행은 NOT_RUN.
-- 판정/운영자 계정을 생성하지 않고 owner 합성 원장만 준비한다. Auth/Storage 자료와 설정은 전체 rollback한다.
begin;
set local storage.allow_delete_query='true';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[]) on conflict(id) do nothing;
create function pg_temp.safety_uid(n integer) returns uuid language sql immutable as $$
 select ('fc710000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.safety_session(n integer) returns uuid language sql immutable as $$
 select ('fc720000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.safety_actor(n integer) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.safety_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_uid(n),'session_id',pg_temp.safety_session(n))::text,true);
end;$$;
create function pg_temp.safety_failure(command text,expected text) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('expected %s, actual %s',expected,code);
end;$$;
create temp table safety_catalog as select
 (select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls)order by rolname)from pg_roles)roles,
 (select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members)memberships,
 (select external_deletion_approved from private.member_cleanup_guard where singleton)guard,
 (select to_jsonb(g)from private.global_worker_run g where singleton)worker;
set local role service_role;
do $$declare i integer;begin for i in 1..2 loop
 perform public.resolve_naver_account('operator-access-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;end;$$;
reset role;
insert into auth.users(id,email)select pg_temp.safety_uid(i),a.auth_email from generate_series(1,2)i
 join private.naver_accounts a on a.subject='operator-access-sql-'||i;
insert into auth.sessions(id,user_id)select pg_temp.safety_session(i),pg_temp.safety_uid(i)from generate_series(1,2)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.safety_uid(i)::text||'/fc730000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.safety_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,2)i;
set local role service_role;
do $$declare i integer;begin for i in 1..2 loop
 perform public.record_naver_session('operator-access-sql-'||i,pg_temp.safety_uid(i),pg_temp.safety_session(i));end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..2 loop
 perform pg_temp.safety_actor(i);
 assert public.complete_naver_signup(pg_temp.safety_uid(i)::text||'/fc730000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
 assert public.get_my_safety_state()='{"permanent":false,"restrictedUntil":null,"hasWarning":false,"sanctions":[]}'::jsonb;
end loop;end;$$;
reset role;

insert into auth.users(id,email)values(pg_temp.safety_uid(3),'synthetic-staff@test.invalid'),(pg_temp.safety_uid(4),'synthetic-other-staff@test.invalid');
insert into auth.sessions(id,user_id)values(pg_temp.safety_session(3),pg_temp.safety_uid(3)),(pg_temp.safety_session(4),pg_temp.safety_uid(4));
insert into storage.buckets(id,name,public)values('report-evidence','report-evidence',false)on conflict(id)do nothing;
-- 최신 retention trigger도 실제 신고자1→타인2 권한으로 실행한다. trigger를 끄거나 권한 검사를 생략하지 않는다.
select pg_temp.safety_actor(1);
insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,hide_target,fingerprint)
 select 'fc750000-0000-4000-8000-000000000001',pg_temp.safety_uid(1),e.id,'fc750000-0000-4000-8000-000000000002','member',pg_temp.safety_uid(2),'offline',array['spam'],false,repeat('a',64)
 from private.member_episodes e where e.profile_id=pg_temp.safety_uid(1)and ended_at is null;
insert into private.member_report_details(report_id,description)values('fc750000-0000-4000-8000-000000000001','본인이 제출한 합성 설명');
insert into private.report_capture_assets(id,owner_id,owner_episode_id,object_name,state,report_id,uploaded_at)
 select 'fc760000-0000-4000-8000-000000000001',pg_temp.safety_uid(1),e.id,pg_temp.safety_uid(1)::text||'/fc760000-0000-4000-8000-000000000001.png','attached','fc750000-0000-4000-8000-000000000001',clock_timestamp()
 from private.member_episodes e where e.profile_id=pg_temp.safety_uid(1)and ended_at is null;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 values('report-evidence',pg_temp.safety_uid(1)::text||'/fc760000-0000-4000-8000-000000000001.png',pg_temp.safety_uid(1)::text,'{"mimetype":"image/png","size":128}');
-- 별도 존재 사건은 담당4에만 배정한다. 이미 승인된 다른 담당의 cross-case 읽기도 거절해야 한다.
insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,hide_target,fingerprint)
 select 'fc750000-0000-4000-8000-000000000099',pg_temp.safety_uid(1),e.id,'fc750000-0000-4000-8000-000000000098','member',pg_temp.safety_uid(2),'offline',array['spam'],false,repeat('b',64)
 from private.member_episodes e where e.profile_id=pg_temp.safety_uid(1)and ended_at is null;
insert into private.member_report_details(report_id,description)values('fc750000-0000-4000-8000-000000000099','다른 담당의 합성 설명');
-- 기본 승인0/배정0. 프로필이 없는 독립 Auth 직원 fixture를 사용하며 실제 담당 배정이 아니다.
do $$begin assert not exists(select 1 from private.report_operator_approvals);assert not exists(select 1 from private.report_operator_assignments);end;$$;
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure('select public.get_assigned_member_report(''fc750000-0000-4000-8000-000000000001'')','42501');
reset role;
select private.set_report_operator_approval(pg_temp.safety_uid(3),true);
select private.set_report_operator_approval(pg_temp.safety_uid(4),true);
select private.set_report_operator_assignment(pg_temp.safety_uid(4),'fc750000-0000-4000-8000-000000000099',true);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure('select public.get_assigned_member_report(''fc750000-0000-4000-8000-000000000001'')','42501');
reset role;
select private.set_report_operator_assignment(pg_temp.safety_uid(3),'fc750000-0000-4000-8000-000000000001',true);
set local role authenticated;
select pg_temp.safety_actor(3);
do $$declare r jsonb;a jsonb;begin
 r:=public.get_assigned_member_report('fc750000-0000-4000-8000-000000000001');
 assert(select count(*)from jsonb_object_keys(r))=6;
 assert r->>'description'='본인이 제출한 합성 설명'and jsonb_array_length(r->'assets')=1;
 assert not(r?|array['reporterId','targetId','identityId','chatHistory','actorReference']);
 a:=public.get_assigned_report_capture('fc750000-0000-4000-8000-000000000001','fc760000-0000-4000-8000-000000000001');
 assert(select count(*)from jsonb_object_keys(a))=7;
 assert a=r->'assets'->0 and a->>'bucket'='report-evidence'and a->>'byteSize'='128';
 perform pg_temp.safety_failure('select public.get_assigned_member_report(''fc750000-0000-4000-8000-000000000099'')','42501');
 perform pg_temp.safety_failure('select private.set_report_operator_approval(''fc710000-0000-4000-8000-000000000003'',true)','42501');
end;$$;
reset role;
do $$begin assert(select count(*)from private.report_access_audit where actor_id=pg_temp.safety_uid(3))=2;end;$$;
select private.set_report_operator_assignment(pg_temp.safety_uid(3),'fc750000-0000-4000-8000-000000000001',false);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure('select public.get_assigned_member_report(''fc750000-0000-4000-8000-000000000001'')','42501');
reset role;
select private.set_report_operator_assignment(pg_temp.safety_uid(3),'fc750000-0000-4000-8000-000000000001',true);
select private.set_report_operator_approval(pg_temp.safety_uid(3),false);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure('select public.get_assigned_member_report(''fc750000-0000-4000-8000-000000000001'')','42501');
reset role;
select private.set_report_operator_approval(pg_temp.safety_uid(3),true);
update auth.sessions set not_after=clock_timestamp()-interval '1 second'where id=pg_temp.safety_session(3);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure('select public.get_assigned_member_report(''fc750000-0000-4000-8000-000000000001'')','28000');
reset role;
update auth.sessions set not_after=null where id=pg_temp.safety_session(3);
set local role authenticated;
select pg_temp.safety_actor(3);
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_uid(3),'session_id',pg_temp.safety_session(3),'is_anonymous',true)::text,true);
select pg_temp.safety_failure('select public.get_assigned_member_report(''fc750000-0000-4000-8000-000000000001'')','28000');
reset role;
delete from auth.sessions where id=pg_temp.safety_session(3);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure('select public.get_assigned_member_report(''fc750000-0000-4000-8000-000000000001'')','28000');
reset role;
insert into auth.sessions(id,user_id)values(pg_temp.safety_session(3),pg_temp.safety_uid(3));
set local role authenticated;
select pg_temp.safety_actor(3);
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_uid(3),'session_id',pg_temp.safety_session(4))::text,true);
select pg_temp.safety_failure('select public.get_assigned_member_report(''fc750000-0000-4000-8000-000000000001'')','28000');
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_uid(3))::text,true);
select pg_temp.safety_failure('select public.get_assigned_member_report(''fc750000-0000-4000-8000-000000000001'')','28000');
select pg_temp.safety_actor(4);
select pg_temp.safety_failure('select public.get_assigned_member_report(''fc750000-0000-4000-8000-000000000001'')','42501');
reset role;
-- Auth harddelete가 승인/배정 FK에 막히지 않고 audit/사건 기록을 보존한다.
delete from auth.users where id=pg_temp.safety_uid(3);
do $$declare role_name text;begin
 assert not exists(select 1 from private.report_operator_approvals where auth_user_id=pg_temp.safety_uid(3));
 assert exists(select 1 from private.report_operator_assignments where report_id='fc750000-0000-4000-8000-000000000001'and operator_uid is null);
 assert(select count(*)from private.report_access_audit where actor_id=pg_temp.safety_uid(3))=2;
 foreach role_name in array array['anon','authenticated','service_role']loop
 assert not has_table_privilege(role_name,'private.report_operator_approvals','SELECT');
 assert not has_table_privilege(role_name,'private.report_operator_assignments','INSERT');
 assert not has_function_privilege(role_name,'private.set_report_operator_approval(uuid,boolean)','EXECUTE');
 assert not has_function_privilege(role_name,'private.set_report_operator_assignment(uuid,uuid,boolean)','EXECUTE');end loop;
 assert(select roles from safety_catalog)=(select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls)order by rolname)from pg_roles);
 assert(select memberships from safety_catalog)=(select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members);
 assert(select guard from safety_catalog)is not distinct from(select external_deletion_approved from private.member_cleanup_guard where singleton);
 assert(select worker from safety_catalog)is not distinct from(select to_jsonb(g)from private.global_worker_run g where singleton);
end;$$;
select 'NOT_RUN actual SQL, two-session serialization, Storage bytes, HTTP, real staff assignment, notice/appeal';
rollback;
