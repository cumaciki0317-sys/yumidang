-- 민규 C: source71 이후 명시 검토 시작 후보. 실제 SQL/HTTP/두 세션은 NOT_RUN.
-- 판정/운영자 계정을 생성하지 않고 owner 합성 원장만 준비한다. Auth/Storage 자료와 설정은 전체 rollback한다.
begin;
set local storage.allow_delete_query='true';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[]) on conflict(id) do nothing;
create function pg_temp.safety_uid(n integer) returns uuid language sql immutable as $$
 select ('fe910000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.safety_session(n integer) returns uuid language sql immutable as $$
 select ('fe920000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
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
 perform public.resolve_naver_account('review-start-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;end;$$;
reset role;
insert into auth.users(id,email)select pg_temp.safety_uid(i),a.auth_email from generate_series(1,2)i
 join private.naver_accounts a on a.subject='review-start-sql-'||i;
insert into auth.sessions(id,user_id)select pg_temp.safety_session(i),pg_temp.safety_uid(i)from generate_series(1,2)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.safety_uid(i)::text||'/fe930000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.safety_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,2)i;
set local role service_role;
do $$declare i integer;begin for i in 1..2 loop
 perform public.record_naver_session('review-start-sql-'||i,pg_temp.safety_uid(i),pg_temp.safety_session(i));end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..2 loop
 perform pg_temp.safety_actor(i);
 assert public.complete_naver_signup(pg_temp.safety_uid(i)::text||'/fe930000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
 assert public.get_my_safety_state()='{"permanent":false,"restrictedUntil":null,"hasWarning":false,"sanctions":[]}'::jsonb;
end loop;end;$$;
reset role;


insert into auth.users(id,email)values(pg_temp.safety_uid(3),'review-staff@test.invalid'),(pg_temp.safety_uid(4),'foreign-review-staff@test.invalid');
insert into auth.sessions(id,user_id)values(pg_temp.safety_session(3),pg_temp.safety_uid(3)),(pg_temp.safety_session(4),pg_temp.safety_uid(4));
create function pg_temp.review_request(n integer)returns uuid language sql immutable as $$select('fe940000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create temp table review_cases(n integer primary key,post_id uuid,appointment_id uuid,report_id uuid,result jsonb);
grant all on review_cases to authenticated;
create temp table review_function_baseline as select p.oid,p.proowner,p.proacl,md5(pg_get_functiondef(p.oid))body from pg_proc p where p.oid in(
 'private.require_assigned_report_operator(uuid)'::regprocedure,'private.enter_appointment_review(uuid,uuid)'::regprocedure,
 'public.get_assigned_member_report(uuid)'::regprocedure,'private.assigned_report_capture_storage_read_allowed(text,text)'::regprocedure);
set local role authenticated;
do $$declare i integer;p uuid;j uuid;a uuid;c jsonb;rid uuid;begin
 for i in 1..2 loop
  p:=gen_random_uuid();perform pg_temp.safety_actor(1);
  perform public.create_service_post(p,jsonb_build_object('title','합성 검토 시작','description','격리 검토 회귀','category','산책',
   'startsAt',clock_timestamp()+make_interval(days=>i*3),'endsAt',clock_timestamp()+make_interval(days=>i*3,hours=>2),
   'recruitmentEndsAt',clock_timestamp()+make_interval(days=>i*3,hours=>-1),'publicArea','서울특별시 강남구 역삼동',
   'registeredPlaceName','가상 검토 장소','registeredAddress','서울특별시 강남구 가상주소','meetingDetail','가상 입구',
   'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0));
  perform pg_temp.safety_actor(2);j:=(public.request_service_post(p,gen_random_uuid(),'합성 신청')->>'id')::uuid;
  perform pg_temp.safety_actor(1);c:=public.propose_match(j);
  perform pg_temp.safety_actor(2);a:=(public.accept_match(j,c->>'conditionVersion')->>'appointmentId')::uuid;
  perform pg_temp.safety_actor(1);
  rid:=(public.submit_member_report(gen_random_uuid(),'appointment',a,'offline',array['other'],'합성 약속 신고','{}',false)->>'reportId')::uuid;
  insert into review_cases(n,post_id,appointment_id,report_id)values(i,p,a,rid);
 end loop;
 rid:=(public.submit_member_report(gen_random_uuid(),'member',pg_temp.safety_uid(2),'offline',array['spam'],'합성 일반 신고','{}',false)->>'reportId')::uuid;
 insert into review_cases(n,report_id)values(3,rid);
 rid:=(public.submit_member_report(gen_random_uuid(),'member',pg_temp.safety_uid(2),'offline',array['spam'],'합성 안전 정수 경계','{}',false)->>'reportId')::uuid;
 insert into review_cases(n,report_id)values(4,rid);
end;$$;
reset role;
do $$begin
 assert not exists(select 1 from private.report_review_start_receipts);
 assert not exists(select 1 from private.appointment_review_holds where report_id in(select report_id from review_cases));
 assert(select bool_and(review_version=1 and status='received')from private.member_reports where id in(select report_id from review_cases));
end;$$;
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',(select report_id from review_cases where n=1),pg_temp.review_request(1)),'42501');
reset role;
select private.set_report_operator_approval(pg_temp.safety_uid(3),true);
select private.set_report_operator_approval(pg_temp.safety_uid(4),true);
select private.set_report_operator_assignment(pg_temp.safety_uid(4),(select report_id from review_cases where n=2),true);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',(select report_id from review_cases where n=1),pg_temp.review_request(1)),'42501');
select pg_temp.safety_actor(4);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',(select report_id from review_cases where n=1),pg_temp.review_request(1)),'42501');
reset role;
select private.set_report_operator_assignment(pg_temp.safety_uid(3),report_id,true)from review_cases;
-- 별도 bare Auth 직원3에 회원 profile/Naver가 없어도 명시 승인/배정이면 시작 가능하다.
set local role authenticated;
select pg_temp.safety_actor(3);
do $$declare r jsonb;retry jsonb;rid uuid:=(select report_id from review_cases where n=1);begin
 r:=public.start_assigned_report_review(rid,pg_temp.review_request(1),1);
 assert(select count(*)from jsonb_object_keys(r))=5;
 assert r->>'reportId'=rid::text and r->>'status'='reviewing'and r->>'version'='2'and not(r->>'alreadyApplied')::boolean and r->>'holdId'is not null;
 update review_cases set result=r where n=1;
 retry:=public.start_assigned_report_review(rid,pg_temp.review_request(1),1);
 assert retry=r||jsonb_build_object('alreadyApplied',true);
 perform pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,2)',rid,pg_temp.review_request(1)),'40001');
 perform pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',rid,pg_temp.review_request(10)),'40001');
 -- 같은 actor/request를 다른 배정 신고에 재사용하는 것도 거절한다.
 perform pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',(select report_id from review_cases where n=3),pg_temp.review_request(1)),'40001');
end;$$;
reset role;
do $$declare rid uuid:=(select report_id from review_cases where n=1);begin
 assert(select count(*)=1 from private.report_review_start_receipts where report_id=rid);
 assert(select status='reviewing'and review_version=2 and final_closed_at is null and retention_due_at is null from private.member_reports where id=rid);
 assert(select count(*)=1 from private.appointment_review_holds where report_id=rid and state='reviewing');
 assert private.appointment_review_held((select appointment_id from review_cases where n=1));
 assert not exists(select 1 from private.completion_reservations where appointment_id=(select appointment_id from review_cases where n=1));
 assert not exists(select 1 from private.safety_incidents);
 assert not exists(select 1 from private.safety_appeals);
 assert not exists(select 1 from private.safety_sanction_applications);
end;$$;
-- 일반 신고는 상태/감사만 바꾸며 약속 보류·분쟁·제재를 자동 생성하지 않는다.
set local role authenticated;
select pg_temp.safety_actor(3);
do $$declare r jsonb;begin
 r:=public.start_assigned_report_review((select report_id from review_cases where n=3),pg_temp.review_request(3),1);
 assert r->>'holdId'is null and r->>'version'='2';
end;$$;
reset role;
do $$begin assert not exists(select 1 from private.appointment_review_holds where report_id=(select report_id from review_cases where n=3));end;$$;
-- 안전 정수 마지막 버전은 정상 성공하며 그 다음 변경은 상태/영수증을 쓰지 않는다.
-- version 직접 이동은 owner 합성 수치 fixture이며 실제 처리 횟수를 주장하지 않는다.
update private.member_reports set review_version=9007199254740990 where id=(select report_id from review_cases where n=4);
set local role authenticated;
select pg_temp.safety_actor(3);
do $$declare r jsonb;rid uuid:=(select report_id from review_cases where n=4);begin
 r:=public.start_assigned_report_review(rid,pg_temp.review_request(40),9007199254740990);
 assert(r->>'version')::bigint=9007199254740991 and r->>'status'='reviewing'and r->>'holdId'is null;
 perform pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,9007199254740991)',rid,pg_temp.review_request(41)),'22023');
 perform pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,9007199254740992)',rid,pg_temp.review_request(42)),'22023');
 perform pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,9007199254740990)',rid,pg_temp.review_request(43)),'40001');
 assert(public.start_assigned_report_review(rid,pg_temp.review_request(40),9007199254740990)->>'version')::bigint=9007199254740991;
end;$$;
reset role;
select pg_temp.safety_failure(format('update private.member_reports set status=''more_evidence''where id=%L',(select report_id from review_cases where n=4)),'55000');
select pg_temp.safety_failure(format('update private.member_reports set review_version=9007199254740992 where id=%L',(select report_id from review_cases where n=4)),'23514');
do $$declare rid uuid:=(select report_id from review_cases where n=4);begin
 assert(select status='reviewing'and review_version=9007199254740991 from private.member_reports where id=rid);
 assert(select count(*)=1 from private.report_review_start_receipts where report_id=rid);
 assert not exists(select 1 from private.appointment_review_holds where report_id=rid);
 assert not exists(select 1 from private.report_review_start_receipts where request_id in(pg_temp.review_request(41),pg_temp.review_request(42),pg_temp.review_request(43)));
end;$$;
-- 완료 보류 후 영수증/audit 저장이 실패하면 report/hold/예약 모두 원상복구해야 한다.
create function pg_temp.reject_review_receipt()returns trigger language plpgsql as $$begin raise exception 'synthetic_receipt_failure'using errcode='55000';end;$$;
create trigger synthetic_review_receipt_failure before insert on private.report_review_start_receipts for each row execute function pg_temp.reject_review_receipt();
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',(select report_id from review_cases where n=2),pg_temp.review_request(2)),'55000');
reset role;
drop trigger synthetic_review_receipt_failure on private.report_review_start_receipts;
do $$begin
 assert(select status='received'and review_version=1 from private.member_reports where id=(select report_id from review_cases where n=2));
 assert not exists(select 1 from private.appointment_review_holds where report_id=(select report_id from review_cases where n=2));
 assert exists(select 1 from private.completion_reservations where appointment_id=(select appointment_id from review_cases where n=2));
 assert not exists(select 1 from private.report_review_start_receipts where request_id=pg_temp.review_request(2));
end;$$;
-- 시작 guard 뒤 session이 만료돼도 마지막 guard가 상태/hold/예약 전체를 rollback한다.
create function pg_temp.expire_review_session()returns trigger language plpgsql as $$begin
 if new.id=(select report_id from review_cases where n=2)then
  update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=pg_temp.safety_session(3);
 end if;return new;
end;$$;
create trigger synthetic_review_session_expiry after update of status on private.member_reports for each row execute function pg_temp.expire_review_session();
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',(select report_id from review_cases where n=2),pg_temp.review_request(2)),'28000');
reset role;
drop trigger synthetic_review_session_expiry on private.member_reports;
do $$begin
 assert(select status='received'and review_version=1 from private.member_reports where id=(select report_id from review_cases where n=2));
 assert not exists(select 1 from private.appointment_review_holds where report_id=(select report_id from review_cases where n=2));
 assert exists(select 1 from private.completion_reservations where appointment_id=(select appointment_id from review_cases where n=2));
 assert(select not_after is null from auth.sessions where id=pg_temp.safety_session(3));
end;$$;
-- 실제 공개 취소 RPC 이후 검토 진입 불가. 내부 helper 실패도 전체 report 변경을 rollback한다.
set local role authenticated;
select pg_temp.safety_actor(1);
select public.cancel_appointment((select appointment_id from review_cases where n=2),gen_random_uuid(),'일정이 변경됐어요');
select pg_temp.safety_actor(3);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',(select report_id from review_cases where n=2),pg_temp.review_request(2)),'55000');
reset role;
do $$begin assert(select status='received'and review_version=1 from private.member_reports where id=(select report_id from review_cases where n=2));end;$$;
-- 이미 성공한 요청이어도 승인/배정/세션 회수 후에는 영수증 재조회 권한이 없다.
select private.set_report_operator_assignment(pg_temp.safety_uid(3),(select report_id from review_cases where n=1),false);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',(select report_id from review_cases where n=1),pg_temp.review_request(1)),'42501');
reset role;
select private.set_report_operator_assignment(pg_temp.safety_uid(3),(select report_id from review_cases where n=1),true);
select private.set_report_operator_approval(pg_temp.safety_uid(3),false);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',(select report_id from review_cases where n=1),pg_temp.review_request(1)),'42501');
reset role;
select private.set_report_operator_approval(pg_temp.safety_uid(3),true);
update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=pg_temp.safety_session(3);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',(select report_id from review_cases where n=1),pg_temp.review_request(1)),'28000');
reset role;
update auth.sessions set not_after=null where id=pg_temp.safety_session(3);
set local role authenticated;
select pg_temp.safety_actor(3);
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_uid(3),'session_id',pg_temp.safety_session(4))::text,true);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',(select report_id from review_cases where n=1),pg_temp.review_request(1)),'28000');
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_uid(3),'session_id',pg_temp.safety_session(3),'is_anonymous',true)::text,true);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',(select report_id from review_cases where n=1),pg_temp.review_request(1)),'28000');
reset role;
delete from auth.sessions where id=pg_temp.safety_session(3);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',(select report_id from review_cases where n=1),pg_temp.review_request(1)),'28000');
reset role;
-- 자격 있는 일반 회원도 명시 직원 승인이 없으면 mutation을 호출할 수 없다.
set local role authenticated;
select pg_temp.safety_actor(1);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,1)',(select report_id from review_cases where n=2),pg_temp.review_request(20)),'42501');
select pg_temp.safety_actor(4);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,0)',(select report_id from review_cases where n=2),pg_temp.review_request(20)),'22023');
reset role;
-- 일반 신고 추가자료 상태 뒤 명시 재검토만 새 version을 만든다. 기존 owner 상태 의미는 보존한다.
insert into auth.sessions(id,user_id)values(pg_temp.safety_session(3),pg_temp.safety_uid(3));
update private.member_reports set status='more_evidence'where id=(select report_id from review_cases where n=3);
set local role authenticated;
select pg_temp.safety_actor(3);
do $$declare r jsonb;begin
 r:=public.start_assigned_report_review((select report_id from review_cases where n=3),pg_temp.review_request(30),3);
 assert r->>'version'='4'and r->>'holdId'is null;
end;$$;
reset role;
-- 권위있는 절차종결 workflow 성공이 아니라 기존 retention guard의 owner 합성 만료 fixture다.
update private.member_reports set status='resolved',final_closed_at=n.closed_at,
 retention_due_at=n.closed_at+interval'2160 hours'from(select clock_timestamp()-interval'91 days'closed_at)n where id=(select report_id from review_cases where n=3);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure(format('select public.start_assigned_report_review(%L,%L,3)',(select report_id from review_cases where n=3),pg_temp.review_request(30)),'PT404');
reset role;
-- 직원 Auth 삭제는 구조화 성공 영수증/audit를 cascade하지 않고 기존 배정 FK 계약을 지킨다.
delete from auth.users where id=pg_temp.safety_uid(3);
do $$begin
 assert(select count(*)=4 from private.report_review_start_receipts where actor_id=pg_temp.safety_uid(3));
 assert not exists(select 1 from private.report_operator_approvals where auth_user_id=pg_temp.safety_uid(3));
 assert exists(select 1 from private.report_operator_assignments where operator_uid is null and report_id=(select report_id from review_cases where n=1));
end;$$;
-- role/ACL/worker/guard 및 기존70/71 함수 본문 보존. 원문 권한·직원 운영 계정은 만들지 않는다.
do $$declare role_name text;begin
 foreach role_name in array array['anon','authenticated','service_role']loop
 assert not has_table_privilege(role_name,'private.report_review_start_receipts','SELECT');
 assert not has_table_privilege(role_name,'private.member_reports','UPDATE');
 assert not has_function_privilege(role_name,'private.bump_report_review_version()','EXECUTE');
 if role_name<>'authenticated'then assert not has_function_privilege(role_name,'public.start_assigned_report_review(uuid,uuid,bigint)','EXECUTE');end if;
 end loop;
 assert has_function_privilege('authenticated','public.start_assigned_report_review(uuid,uuid,bigint)','EXECUTE');
 assert not exists(select 1 from review_function_baseline b join pg_proc p on p.oid=b.oid where p.proowner<>b.proowner or p.proacl is distinct from b.proacl or md5(pg_get_functiondef(p.oid))<>b.body);
 assert(select roles from safety_catalog)=(select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls)order by rolname)from pg_roles);
 assert(select memberships from safety_catalog)=(select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members);
 assert(select guard from safety_catalog)is not distinct from(select external_deletion_approved from private.member_cleanup_guard where singleton);
 assert(select worker from safety_catalog)is not distinct from(select to_jsonb(g)from private.global_worker_run g where singleton);
end;$$;
select 'NOT_RUN actual SQL, HTTP, two-session serialization, real staff, notice/appeal';
rollback;
