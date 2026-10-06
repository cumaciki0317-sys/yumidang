-- 민규 C: source72 이후 현재 검토 버전 읽기 후보. 실제 SQL/HTTP/두 세션은 NOT_RUN.
-- 판정/운영자 계정을 생성하지 않고 owner 합성 원장만 준비한다. Auth/Storage 자료와 설정은 전체 rollback한다.
begin;
set local storage.allow_delete_query='true';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[]) on conflict(id) do nothing;
create function pg_temp.safety_uid(n integer) returns uuid language sql immutable as $$
 select ('fa910000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.safety_session(n integer) returns uuid language sql immutable as $$
 select ('fa920000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
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
 perform public.resolve_naver_account('review-state-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;end;$$;
reset role;
insert into auth.users(id,email)select pg_temp.safety_uid(i),a.auth_email from generate_series(1,2)i
 join private.naver_accounts a on a.subject='review-state-sql-'||i;
insert into auth.sessions(id,user_id)select pg_temp.safety_session(i),pg_temp.safety_uid(i)from generate_series(1,2)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.safety_uid(i)::text||'/fa930000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.safety_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,2)i;
set local role service_role;
do $$declare i integer;begin for i in 1..2 loop
 perform public.record_naver_session('review-state-sql-'||i,pg_temp.safety_uid(i),pg_temp.safety_session(i));end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..2 loop
 perform pg_temp.safety_actor(i);
 assert public.complete_naver_signup(pg_temp.safety_uid(i)::text||'/fa930000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
 assert public.get_my_safety_state()='{"permanent":false,"restrictedUntil":null,"hasWarning":false,"sanctions":[]}'::jsonb;
end loop;end;$$;
reset role;


insert into auth.users(id,email)values(pg_temp.safety_uid(3),'review-staff@test.invalid'),(pg_temp.safety_uid(4),'foreign-review-staff@test.invalid');
insert into auth.sessions(id,user_id)values(pg_temp.safety_session(3),pg_temp.safety_uid(3)),(pg_temp.safety_session(4),pg_temp.safety_uid(4));
create function pg_temp.review_request(n integer)returns uuid language sql immutable as $$select('fa940000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create temp table review_cases(n integer primary key,post_id uuid,appointment_id uuid,report_id uuid,result jsonb);
grant all on review_cases to authenticated;
create temp table review_function_baseline as select p.oid,p.proowner,p.proacl,md5(pg_get_functiondef(p.oid))body from pg_proc p where p.oid in(
 'private.require_assigned_report_operator(uuid)'::regprocedure,'private.enter_appointment_review(uuid,uuid)'::regprocedure,
 'public.get_assigned_member_report(uuid)'::regprocedure,'private.assigned_report_capture_storage_read_allowed(text,text)'::regprocedure,
 'public.start_assigned_report_review(uuid,uuid,bigint)'::regprocedure,'private.bump_report_review_version()'::regprocedure);
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

create function pg_temp.state_failure(p_report_id uuid,expected text)returns void language plpgsql as $$
declare count_before bigint;count_after bigint;code text;begin
 select count(*)into count_before from private.report_access_audit;
 begin perform public.get_assigned_report_review_state(p_report_id);exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('expected %s, actual %s',expected,code);
 select count(*)into count_after from private.report_access_audit;
 assert count_after=count_before,'failed read does not leave access audit';
end;$$;
-- owner 합성 helper만 audit count를 읽는다. 사용자 table privilege는 추가하지 않는다.
alter function pg_temp.state_failure(uuid,text)security definer;
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.state_failure((select report_id from review_cases where n=1),'42501');
reset role;
select private.set_report_operator_approval(pg_temp.safety_uid(3),true);
select private.set_report_operator_approval(pg_temp.safety_uid(4),true);
select private.set_report_operator_assignment(pg_temp.safety_uid(4),(select report_id from review_cases where n=2),true);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.state_failure((select report_id from review_cases where n=1),'42501');
select pg_temp.safety_actor(4);
select pg_temp.state_failure((select report_id from review_cases where n=1),'42501');
reset role;
select private.set_report_operator_assignment(pg_temp.safety_uid(3),report_id,true)from review_cases;
create function pg_temp.state_expect(p_case integer,status_value text,version_value bigint)returns void language plpgsql as $$
declare r jsonb;rid uuid:=(select report_id from review_cases where review_cases.n=p_case);begin
 r:=public.get_assigned_report_review_state(rid);
 assert(select count(*)from jsonb_object_keys(r))=3;
 assert r=jsonb_build_object('reportId',rid,'status',status_value,'version',version_value);
end;$$;
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.state_expect(1,'received',1);
select public.start_assigned_report_review((select report_id from review_cases where n=1),pg_temp.review_request(1),1);
select pg_temp.state_expect(1,'reviewing',2);
select public.start_assigned_report_review((select report_id from review_cases where n=3),pg_temp.review_request(3),1);
select pg_temp.state_expect(3,'reviewing',2);
reset role;
update private.member_reports set status='more_evidence'where id=(select report_id from review_cases where n=3);
set local role authenticated;
select pg_temp.safety_actor(3);
-- 현재값3을 읽는다. 이전 start receipt2를 현재 상태로 반환하지 않는다.
select pg_temp.state_expect(3,'more_evidence',3);
do $$declare r jsonb;begin r:=public.start_assigned_report_review((select report_id from review_cases where n=3),pg_temp.review_request(3),1);assert r->>'version'='2';end;$$;
select pg_temp.state_expect(3,'more_evidence',3);
reset role;
update private.member_reports set status='resolved'where id=(select report_id from review_cases where n=3);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.state_expect(3,'resolved',4);
reset role;
-- 초기값/마지막 안전 정수도 현재 version으로 반환한다. owner 수치 fixture는 실제 건수 증거가 아니다.
update private.member_reports set review_version=9007199254740991 where id=(select report_id from review_cases where n=4);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.state_expect(4,'received',9007199254740991);
reset role;
-- 실패 audit0은 owner wrapper 안에서만 측정한다. SECDEF는 current_user만 바꾸며 JWT role은 바꾸지 않는다.
select private.set_report_operator_assignment(pg_temp.safety_uid(3),(select report_id from review_cases where n=1),false);
select pg_temp.safety_actor(3);
select pg_temp.state_failure((select report_id from review_cases where n=1),'42501');
select private.set_report_operator_assignment(pg_temp.safety_uid(3),(select report_id from review_cases where n=1),true);
select private.set_report_operator_approval(pg_temp.safety_uid(3),false);
select pg_temp.state_failure((select report_id from review_cases where n=1),'42501');
select private.set_report_operator_approval(pg_temp.safety_uid(3),true);
update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=pg_temp.safety_session(3);
select pg_temp.state_failure((select report_id from review_cases where n=1),'28000');
update auth.sessions set not_after=null where id=pg_temp.safety_session(3);
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_uid(3),'session_id',pg_temp.safety_session(4))::text,true);
select pg_temp.state_failure((select report_id from review_cases where n=1),'28000');
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_uid(3),'session_id',pg_temp.safety_session(3),'is_anonymous',true)::text,true);
select pg_temp.state_failure((select report_id from review_cases where n=1),'28000');
select pg_temp.safety_actor(3);
delete from auth.sessions where id=pg_temp.safety_session(3);
select pg_temp.state_failure((select report_id from review_cases where n=1),'28000');
insert into auth.sessions(id,user_id)values(pg_temp.safety_session(3),pg_temp.safety_uid(3));
update private.member_reports set final_closed_at=n.closed_at,retention_due_at=n.closed_at+interval'2160 hours'
 from(select clock_timestamp()-interval'91 days'closed_at)n where id=(select report_id from review_cases where n=3);
select pg_temp.state_failure((select report_id from review_cases where n=3),'PT404');
-- qualified ordinary member도 승인/배정 없이 조회 못한다.
select pg_temp.safety_actor(1);
select pg_temp.state_failure((select report_id from review_cases where n=1),'42501');
select pg_temp.safety_actor(3);
select pg_temp.state_failure(null,'22023');
do $$declare role_name text;begin
 assert(select count(*)>0 from private.report_access_audit where actor_id=pg_temp.safety_uid(3)and action='report_read');
 foreach role_name in array array['anon','authenticated','service_role']loop
 assert not has_table_privilege(role_name,'private.member_reports','SELECT');
 assert not has_table_privilege(role_name,'private.report_access_audit','INSERT');
 if role_name<>'authenticated'then assert not has_function_privilege(role_name,'public.get_assigned_report_review_state(uuid)','EXECUTE');end if;
 end loop;
 assert has_function_privilege('authenticated','public.get_assigned_report_review_state(uuid)','EXECUTE');
 assert not exists(select 1 from review_function_baseline b join pg_proc p on p.oid=b.oid where p.proowner<>b.proowner or p.proacl is distinct from b.proacl or md5(pg_get_functiondef(p.oid))<>b.body);
 assert(select roles from safety_catalog)=(select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls)order by rolname)from pg_roles);
 assert(select memberships from safety_catalog)=(select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members);
 assert(select guard from safety_catalog)is not distinct from(select external_deletion_approved from private.member_cleanup_guard where singleton);
 assert(select worker from safety_catalog)is not distinct from(select to_jsonb(g)from private.global_worker_run g where singleton);
end;$$;
select 'NOT_RUN actual SQL/HTTP, two-session waits, retired-member integration, notice/appeal';
rollback;
