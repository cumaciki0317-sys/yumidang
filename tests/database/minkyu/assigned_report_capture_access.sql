-- 민규: source70 이후 배정 신고 증거 Storage RLS 회귀 후보. 실제 실행은 NOT_RUN.
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

create function pg_temp.capture_actor(n integer,op text)returns void language plpgsql as $$begin
 perform pg_temp.safety_actor(n);perform set_config('storage.operation',op,true);end;$$;
create function pg_temp.capture_visible()returns boolean language sql volatile as $$select exists(select 1 from storage.objects where bucket_id='report-evidence'and name=pg_temp.safety_uid(1)::text||'/fc760000-0000-4000-8000-000000000001.png');$$;
-- 상위 탈퇴 restrictive false나 원 회원 guard42501 모두 내용 미반환이다. 예상외 DB 오류는 성공으로 삼키지 않는다.
create function pg_temp.capture_denied()returns boolean language plpgsql as $$begin
 begin return not pg_temp.capture_visible();exception when sqlstate '28000'or sqlstate '42501'then return true;end;
end;$$;
-- 실제 회원의 기존 own attached GET와 canonical metadata 접근을 보존한다.
set local role authenticated;
select pg_temp.capture_actor(1,'storage.object.get_authenticated');
do $$begin assert pg_temp.capture_visible();end;$$;
select pg_temp.capture_actor(2,'storage.object.get_authenticated');
do $$begin assert not pg_temp.capture_visible();end;$$;
select pg_temp.capture_actor(3,'storage.object.get_authenticated');
do $$begin assert not pg_temp.capture_visible();end;$$;
reset role;
select private.set_report_operator_approval(pg_temp.safety_uid(3),true);
select private.set_report_operator_approval(pg_temp.safety_uid(4),true);
select private.set_report_operator_assignment(pg_temp.safety_uid(4),'fc750000-0000-4000-8000-000000000099',true);
set local role authenticated;
select pg_temp.capture_actor(3,'storage.object.get_authenticated');
do $$begin assert not pg_temp.capture_visible();end;$$;
reset role;
select private.set_report_operator_assignment(pg_temp.safety_uid(3),'fc750000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$declare op text;begin
 foreach op in array array['storage.object.get_authenticated','object.get_authenticated_info','object.head_authenticated_info']loop
 perform pg_temp.capture_actor(3,op);assert pg_temp.capture_visible(),'nonmember assigned staff read blocked';end loop;
 foreach op in array array['','storage.object.sign','storage.object.sign_many','storage.object.sign_upload_url','storage.object.upload_signed','storage.render.image_authenticated','storage.render.image_sign','storage.s3.object.get','storage.tus.upload.create','storage.object.list','storage.object.copy','storage.object.upload_update','storage.object.delete','storage.object.delete_many','storage.object.upload']loop
 perform pg_temp.capture_actor(3,op);assert not pg_temp.capture_visible(),'staff non-read operation exposed';end loop;
 -- 승인된 다른 사건 담당도 이 첨부를 읽지 못한다.
 perform pg_temp.capture_actor(4,'storage.object.get_authenticated');assert not pg_temp.capture_visible();
 -- 회원 owner도 새로운 signed bearer를 발급할 SELECT가 없다.
 perform pg_temp.capture_actor(1,'storage.object.sign');assert not pg_temp.capture_visible();
end;$$;
reset role;
do $$begin assert exists(select 1 from private.report_access_audit where actor_id=pg_temp.safety_uid(3)and report_id='fc750000-0000-4000-8000-000000000001'and action='storage_read');end;$$;
-- member reserved upload/delete 정책은 교체하지 않는다. attached 삭제/덮어쓰기는 기존 규칙대로 차단된다.
set local role authenticated;
select pg_temp.capture_actor(1,'storage.object.upload');
select public.reserve_report_capture('fc760000-0000-4000-8000-000000000002','png');
insert into storage.objects(bucket_id,name,owner_id,metadata)values('report-evidence',pg_temp.safety_uid(1)::text||'/fc760000-0000-4000-8000-000000000002.png',pg_temp.safety_uid(1)::text,'{"mimetype":"image/png","size":128}');
select public.confirm_report_capture('fc760000-0000-4000-8000-000000000002');
select public.cancel_report_capture('fc760000-0000-4000-8000-000000000002');
select pg_temp.capture_actor(1,'storage.object.delete_many');
delete from storage.objects where bucket_id='report-evidence'and name=pg_temp.safety_uid(1)::text||'/fc760000-0000-4000-8000-000000000002.png';
do $$begin assert not exists(select 1 from storage.objects where bucket_id='report-evidence'and name=pg_temp.safety_uid(1)::text||'/fc760000-0000-4000-8000-000000000002.png');end;$$;
select pg_temp.capture_actor(1,'storage.object.sign_upload_url');
select public.reserve_report_capture('fc760000-0000-4000-8000-000000000003','png');
select pg_temp.safety_failure(format('insert into storage.objects(bucket_id,name,owner_id,metadata)values(''report-evidence'',%L,%L,''{"mimetype":"image/png","size":128}'')',pg_temp.safety_uid(1)::text||'/fc760000-0000-4000-8000-000000000003.png',pg_temp.safety_uid(1)::text),'42501');
reset role;
-- 70 승인/배정/세션 회수와 만료를 실제 boolean RLS에서 검사한다.
select private.set_report_operator_assignment(pg_temp.safety_uid(3),'fc750000-0000-4000-8000-000000000001',false);
set local role authenticated;
select pg_temp.capture_actor(3,'storage.object.get_authenticated');
do $$begin assert not pg_temp.capture_visible();end;$$;
reset role;
select private.set_report_operator_assignment(pg_temp.safety_uid(3),'fc750000-0000-4000-8000-000000000001',true);
select private.set_report_operator_approval(pg_temp.safety_uid(3),false);
set local role authenticated;
select pg_temp.capture_actor(3,'storage.object.get_authenticated');
do $$begin assert not pg_temp.capture_visible();end;$$;
reset role;
select private.set_report_operator_approval(pg_temp.safety_uid(3),true);
update auth.sessions set not_after=clock_timestamp()-interval '1 second'where id=pg_temp.safety_session(3);
set local role authenticated;
select pg_temp.capture_actor(3,'storage.object.get_authenticated');
do $$begin assert not pg_temp.capture_visible();end;$$;
reset role;
update auth.sessions set not_after=null where id=pg_temp.safety_session(3);
-- 별도 반환 DTO가 아니라 실효 RLS가 잘못된 MIME/size/object owner를 거절해야 한다.
update storage.objects set metadata='{"mimetype":"image/png","size":5242881}'where bucket_id='report-evidence'and name=pg_temp.safety_uid(1)::text||'/fc760000-0000-4000-8000-000000000001.png';
set local role authenticated;
select pg_temp.capture_actor(3,'storage.object.get_authenticated');
do $$begin assert not pg_temp.capture_visible();end;$$;
reset role;
update storage.objects set metadata='{"mimetype":"application/octet-stream","size":128}'where bucket_id='report-evidence'and name=pg_temp.safety_uid(1)::text||'/fc760000-0000-4000-8000-000000000001.png';
set local role authenticated;
select pg_temp.capture_actor(3,'storage.object.get_authenticated');
do $$begin assert not pg_temp.capture_visible();end;$$;
reset role;
update storage.objects set metadata='{"mimetype":"image/png","size":128}',owner_id=pg_temp.safety_uid(2)::text where bucket_id='report-evidence'and name=pg_temp.safety_uid(1)::text||'/fc760000-0000-4000-8000-000000000001.png';
set local role authenticated;
select pg_temp.capture_actor(3,'storage.object.get_authenticated');
do $$begin assert not pg_temp.capture_visible();end;$$;
reset role;
update storage.objects set owner_id=pg_temp.safety_uid(1)::text where bucket_id='report-evidence'and name=pg_temp.safety_uid(1)::text||'/fc760000-0000-4000-8000-000000000001.png';
-- 현재 회원인 신고자1도 명시적으로 staff승인/본인 사건 배정을 가진 fixture다.
-- 같은UID가 탈퇴하면 신규 staff예외를 주지 않고 상위retired_member_storage 거절을 보존한다.
select private.set_report_operator_approval(pg_temp.safety_uid(1),true);
select private.set_report_operator_assignment(pg_temp.safety_uid(1),'fc750000-0000-4000-8000-000000000001',true);
-- 실제 신고자 탈퇴 뒤 증거는 제출 상태로 남고 다른 배정 담당자의 읽기는 유지한다.
update private.member_cleanup_guard set external_deletion_approved=true where singleton;
grant execute on function public.claim_member_cleanup_task(uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)to service_role;
set local role authenticated;
select pg_temp.capture_actor(1,'storage.object.get_authenticated');
select public.retire_my_account('fc770000-0000-4000-8000-000000000001');
do $$begin assert pg_temp.capture_denied(),'retired own staff stale access exposed';end;$$;
reset role;
do $$begin
 assert not exists(select 1 from auth.sessions where user_id=pg_temp.safety_uid(1));
 assert exists(select 1 from private.report_operator_approvals where auth_user_id=pg_temp.safety_uid(1)and revoked_at is null);
 assert exists(select 1 from private.report_operator_assignments where operator_uid=pg_temp.safety_uid(1)and report_id='fc750000-0000-4000-8000-000000000001'and revoked_at is null);
end;$$;
-- 탈퇴UID에 신규session을owner합성으로넣어도Storage퇴회경계의예외를만들지않는다. 실제직원로그인증거는아니다.
insert into auth.sessions(id,user_id)values('fc720000-0000-4000-8000-000000000101',pg_temp.safety_uid(1));
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.safety_uid(1)::text,true);
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_uid(1),'session_id','fc720000-0000-4000-8000-000000000101','is_anonymous',false)::text,true);
select set_config('storage.operation','storage.object.get_authenticated',true);
do $$begin assert pg_temp.capture_denied(),'retired own staff fresh-session access exposed';end;$$;
select pg_temp.capture_actor(3,'storage.object.get_authenticated');
do $$begin assert pg_temp.capture_visible(),'retired reporter evidence lost';end;$$;
reset role;
update private.member_cleanup_guard set external_deletion_approved=false where singleton;
revoke all on function public.claim_member_cleanup_task(uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)from service_role;
-- 신고의 이의 포함 최종종결+90일이 지나면 staff도 읽지 못한다. 미래/현재값을 가짜 절차종결로 자동 추정하지 않는다.
with anchor as(select clock_timestamp()as at)update private.member_reports set status='resolved',final_closed_at=anchor.at-interval '2184 hours',retention_due_at=anchor.at-interval '24 hours'from anchor where id='fc750000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.capture_actor(3,'storage.object.get_authenticated');
do $$begin assert not pg_temp.capture_visible(),'expired report evidence exposed';end;$$;
reset role;
do $$begin
 assert has_function_privilege('authenticated','private.assigned_report_capture_storage_read_allowed(text,text)','EXECUTE');
 assert not has_function_privilege('anon','private.assigned_report_capture_storage_read_allowed(text,text)','EXECUTE');
 assert not has_function_privilege('service_role','private.assigned_report_capture_storage_read_allowed(text,text)','EXECUTE');
 assert not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid='private.assigned_report_capture_storage_read_allowed(text,text)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE');
 assert not has_function_privilege('authenticated','private.require_assigned_report_operator(uuid)','EXECUTE');
 assert not has_function_privilege('authenticated','private.assigned_report_capture_json(uuid,uuid)','EXECUTE');
 assert not has_table_privilege('authenticated','private.member_report_details','SELECT');
 assert(select roles from safety_catalog)=(select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls)order by rolname)from pg_roles);
 assert(select memberships from safety_catalog)=(select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members);
 assert(select guard from safety_catalog)is not distinct from(select external_deletion_approved from private.member_cleanup_guard where singleton);
 assert(select worker from safety_catalog)is not distinct from(select to_jsonb(g)from private.global_worker_run g where singleton);
end;$$;
select 'NOT_RUN actual SQL, Storage binary/API, signed routes, serialization, HTTP, real staff assignment';
rollback;
