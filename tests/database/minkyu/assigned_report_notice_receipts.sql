-- 민규 A: typed 판정/본인 통지/읽기/보관 연결 후보. 실제 실행 NOT_RUN.
-- 판정/운영자 계정을 생성하지 않고 owner 합성 원장만 준비한다. Auth/Storage 자료와 설정은 전체 rollback한다.
begin;
set local plpgsql.check_asserts=on;
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
-- 기존 실제 회원 생성/신고 접수/검토 시작 fixture. 담당자는 profile 없는 bare Auth3이다.
set local role authenticated;
select pg_temp.safety_actor(3);
select public.start_assigned_report_review(report_id,gen_random_uuid(),1)from review_cases;
reset role;
create temp table adjudication_results(n integer primary key,result jsonb);
grant all on adjudication_results to authenticated;
create function pg_temp.adjudicate(n integer,key integer,mode text,report_version bigint,hold_version bigint,incident_revision bigint,
 appointment_outcome text,incident_outcome text,responsible_role text,reason text,violation_class text,violation_type text)
returns jsonb language plpgsql as $$begin
 return public.adjudicate_assigned_member_report((select report_id from review_cases where review_cases.n=adjudicate.n),
 pg_temp.review_request(key),mode,report_version,hold_version,incident_revision,appointment_outcome,incident_outcome,responsible_role,reason,violation_class,violation_type);
end;$$;
-- 옛74 receipt는 typed/outcome을 추정해 backfill하지 않는다.
insert into private.assigned_report_adjudications(actor_id,client_request_id,report_id,decision_id,input_sha256,result_version,incident_revision)
 select pg_temp.safety_uid(3),pg_temp.review_request(499),report_id,gen_random_uuid(),repeat('a',64),3,0 from review_cases where n=4;
do $$begin
 assert not exists(select 1 from private.assigned_report_decisions);
 assert not exists(select 1 from private.member_decision_notices);
end;$$;
set local role authenticated;
select pg_temp.safety_actor(3);
do $$declare result jsonb;begin
 result:=pg_temp.adjudicate(1,501,'initial',2,1,0,'no_show','confirmed','companion','no_show','none',null);
 assert(select count(*)from jsonb_object_keys(result))=5;
 assert pg_temp.adjudicate(1,501,'initial',2,1,0,'no_show','confirmed','companion','no_show','none',null)=result||jsonb_build_object('alreadyApplied',true);
 insert into adjudication_results values(1,result);
 perform pg_temp.safety_failure($c$select pg_temp.adjudicate(1,501,'initial',2,1,0,'normal','none','none','no_action','none',null)$c$,'40001');
end;$$;
reset role;
do $$begin
 assert(select count(*)=1 from private.assigned_report_decisions);
 assert(select mode='initial'and appointment_outcome='no_show'and incident_outcome='confirmed'and responsible_role='companion'
  and violation_class='none'and violation_type is null and representative_reason_code='no_show'and report_version=3
  from private.assigned_report_decisions);
 assert(select count(*)=2 from private.member_decision_notices);
 assert(select violation_outcome is null and reason_code='no_show'and violation_class is null from private.member_decision_notices
  where recipient_episode_id=(select author_episode_id from private.appointment_member_episodes where appointment_id=(select appointment_id from review_cases where n=1)));
 assert(select violation_outcome='confirmed'and violation_class='none'and reason_code='no_show'from private.member_decision_notices
  where recipient_episode_id=(select requester_episode_id from private.appointment_member_episodes where appointment_id=(select appointment_id from review_cases where n=1)));
 assert not exists(select 1 from private.safety_sanction_applications where notified_at is not null);
 assert not exists(select 1 from private.member_reports where final_closed_at is not null or retention_due_at is not null);
end;$$;
create temp table notice_test_refs(author_notice uuid,companion_notice uuid,first_read timestamptz);
grant all on notice_test_refs to authenticated;
insert into notice_test_refs(author_notice,companion_notice)
 select(select id from private.member_decision_notices where recipient_episode_id=(select author_episode_id from private.appointment_member_episodes where appointment_id=(select appointment_id from review_cases where n=1))),
 (select id from private.member_decision_notices where recipient_episode_id=(select requester_episode_id from private.appointment_member_episodes where appointment_id=(select appointment_id from review_cases where n=1)));
set local role authenticated;
select pg_temp.safety_actor(2);
do $$declare page jsonb;item jsonb;again jsonb;begin
 page:=public.list_my_decision_notices(1,null);assert jsonb_array_length(page->'items')=1 and page->>'nextCursor'is null;
 item:=page->'items'->0;assert(select count(*)from jsonb_object_keys(item))=9;
 assert not(item?'reportId'or item?'decisionId'or item?'identityId'or item?'recipientEpisodeId'or item?'responsibleRole'or item?'actorId');
 assert item->>'noticeId'=(select companion_notice::text from notice_test_refs)and item->>'firstReadAt'is null;
 item:=public.read_my_decision_notice((select companion_notice from notice_test_refs));again:=public.read_my_decision_notice((select companion_notice from notice_test_refs));
 assert item=again and item->>'firstReadAt'is not null;
 update notice_test_refs set first_read=(item->>'firstReadAt')::timestamptz;
 perform pg_temp.safety_failure(format('select public.read_my_decision_notice(%L)',(select author_notice from notice_test_refs)),'PT404');
 perform pg_temp.safety_failure(format('select public.list_my_decision_notices(1,%L)',(select author_notice from notice_test_refs)),'PT404');
end;$$;
reset role;
-- 명시 normal+major와 invalidation은 원 판정과 각각의 event를 보존한다.
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.adjudicate(1,502,'correction',3,2,1,'normal','confirmed','companion','threat','major','threat');
select pg_temp.safety_actor(2);
do $$begin
 assert(public.get_my_safety_state()->>'permanent')::boolean;
 assert jsonb_array_length(public.list_my_decision_notices(100,null)->'items')=2;
 assert public.read_my_decision_notice((select companion_notice from notice_test_refs))->>'firstReadAt'is not null;
end;$$;
select pg_temp.safety_actor(3);
select pg_temp.adjudicate(1,503,'correction',4,3,2,'normal','invalidated','none','decision_corrected','none',null);
reset role;
do $$begin
 assert(select count(*)=3 from private.assigned_report_decisions);
 assert(select count(*)=6 from private.member_decision_notices);
 assert(select count(*)=1 from private.member_decision_notices where violation_outcome='invalidated'and reason_code='decision_corrected');
 assert(select first_read_at=(select first_read from notice_test_refs)from private.member_decision_notices where id=(select companion_notice from notice_test_refs));
 assert not exists(select 1 from private.safety_sanction_applications where notified_at is not null);
end;$$;
-- confirmed 책임자 author→companion 정정으로 이전 본인 효과가 해제된 사실도 기록한다.
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.adjudicate(1,506,'correction',5,4,3,'unchanged','confirmed','author','violence','major','violence');
select pg_temp.adjudicate(1,507,'correction',6,4,4,'unchanged','confirmed','companion','threat','major','threat');
reset role;
do $$begin
 assert(select count(*)=1 from private.member_decision_notices notice_row join private.assigned_report_decisions decision_row using(decision_id)
  where decision_row.report_id=(select report_id from review_cases where n=1)and decision_row.incident_revision=5
   and notice_row.recipient_episode_id=(select author_episode_id from private.appointment_member_episodes where appointment_id=(select appointment_id from review_cases where n=1))
   and notice_row.violation_outcome='invalidated'and notice_row.reason_code='decision_corrected'and notice_row.violation_class is null and notice_row.violation_type is null);
 assert(select count(*)=1 from private.member_decision_notices notice_row join private.assigned_report_decisions decision_row using(decision_id)
  where decision_row.incident_revision=5 and notice_row.violation_outcome='confirmed'and notice_row.reason_code='threat');
 assert private.current_member_sweetness(pg_temp.safety_uid(1))=15;
end;$$;
-- notice 저장 실패도 기존 판정/receipt/hold/제재 전체를 되돌린다.
create function pg_temp.reject_notice()returns trigger language plpgsql as $$begin raise exception 'synthetic_notice_failure'using errcode='55000';end;$$;
create trigger synthetic_notice_failure before insert on private.member_decision_notices for each row execute function pg_temp.reject_notice();
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure($c$select pg_temp.adjudicate(2,504,'initial',2,1,0,'normal','confirmed','author','violence','major','violence')$c$,'55000');
reset role;
drop trigger synthetic_notice_failure on private.member_decision_notices;
do $$begin
 assert(select review_version=2 from private.member_reports where id=(select report_id from review_cases where n=2));
 assert(select state='reviewing'and version=1 from private.appointment_review_holds where report_id=(select report_id from review_cases where n=2));
 assert not exists(select 1 from private.assigned_report_adjudications where client_request_id=pg_temp.review_request(504));
 assert not exists(select 1 from private.assigned_report_decisions where report_id=(select report_id from review_cases where n=2));
 assert private.current_member_sweetness(pg_temp.safety_uid(1))=15;
end;$$;
-- notice INSERT/trigger 뒤 최종 직원 session·보관 clock을 재검사한다.
create function pg_temp.expire_notice_staff_session()returns trigger language plpgsql as $$begin
 update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=pg_temp.safety_session(3);return new;end;$$;
create trigger synthetic_notice_staff_expiry after insert on private.member_decision_notices for each row execute function pg_temp.expire_notice_staff_session();
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure($c$select pg_temp.adjudicate(2,509,'initial',2,1,0,'normal','none','none','no_action','none',null)$c$,'28000');
reset role;
drop trigger synthetic_notice_staff_expiry on private.member_decision_notices;
do $$begin
 assert(select not_after is null from auth.sessions where id=pg_temp.safety_session(3));
 assert not exists(select 1 from private.assigned_report_adjudications where client_request_id=pg_temp.review_request(509));
 assert(select state='reviewing'and version=1 from private.appointment_review_holds where report_id=(select report_id from review_cases where n=2));
end;$$;
-- incident none도 명시 불발 사실을 typed로 남긴다. 담당자/귀책을 추정하지 않는다.
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.adjudicate(2,505,'initial',2,1,0,'no_show','none','none','no_show','none',null);
reset role;
do $$begin
 assert(select incident_outcome='none'and incident_id is null and responsible_role='none'and appointment_outcome='no_show'
  from private.assigned_report_decisions where report_id=(select report_id from review_cases where n=2));
 assert(select count(*)=2 from private.member_decision_notices notice_row join private.assigned_report_decisions decision_row using(decision_id)
  where decision_row.report_id=(select report_id from review_cases where n=2)and notice_row.violation_outcome is null);
end;$$;
-- 만료된 미삭제 report: list 제외·자기cursor/ACK PT404, 파기 지연이 열람 연장이 아니다.
with expiry_time as(select clock_timestamp()-interval'1 second'due_at)
 update private.member_reports set status='resolved',final_closed_at=expiry_time.due_at-interval'2160 hours',retention_due_at=expiry_time.due_at
 from expiry_time where id=(select report_id from review_cases where n=1);
set local role authenticated;
select pg_temp.safety_actor(2);
do $$begin
 assert jsonb_array_length(public.list_my_decision_notices(100,null)->'items')=1;
 perform pg_temp.safety_failure(format('select public.list_my_decision_notices(1,%L)',(select companion_notice from notice_test_refs)),'PT404');
 perform pg_temp.safety_failure(format('select public.read_my_decision_notice(%L)',(select companion_notice from notice_test_refs)),'PT404');
end;$$;
reset role;
update private.member_reports set status='reviewing',final_closed_at=null,retention_due_at=null where id=(select report_id from review_cases where n=1);
-- 목록 query 후 final memberguard에서 만료가 생기는 합성 hook: final TTL 검사 누락을 잡는다.
create temp table notice_guard_definition as select pg_get_functiondef('private.require_member_decision_notice_episode()'::regprocedure)definition;
create temp table notice_guard_calls(n integer);insert into notice_guard_calls values(0);
do $$declare owner_name text;begin
 select pg_get_userbyid(proowner)into strict owner_name from pg_proc where oid='private.require_member_decision_notice_episode()'::regprocedure;
 execute format('grant all on notice_guard_calls,notice_guard_definition,review_cases to %I',owner_name);
end;$$;
create function pg_temp.expire_list_report_after_guard()returns void language plpgsql as $$declare calls integer;expiry timestamptz;begin
 update notice_guard_calls set n=n+1 returning n into calls;
 if calls=2 then
  expiry:=clock_timestamp()-interval'1 second';
  update private.member_reports set status='resolved',final_closed_at=expiry-interval'2160 hours',retention_due_at=expiry
   where id=(select report_id from review_cases where n=1);
 end if;
end;$$;
do $$declare definition_text text;begin
 select definition into definition_text from notice_guard_definition;
 assert(length(definition_text)-length(replace(definition_text,' return episode;','')))/length(' return episode;')=1;
 execute replace(definition_text,' return episode;',' perform pg_temp.expire_list_report_after_guard(); return episode;');
end;$$;
set local role authenticated;
select pg_temp.safety_actor(2);
select pg_temp.safety_failure('select public.list_my_decision_notices(100,null)','PT404');
reset role;
do $$declare definition_text text;begin
 select definition into definition_text from notice_guard_definition;execute definition_text;
 assert(select n=0 from notice_guard_calls);
 assert(select retention_due_at is null from private.member_reports where id=(select report_id from review_cases where n=1));
end;$$;
alter table notice_test_refs add column unread_notice uuid;
update notice_test_refs set unread_notice=(select notice_row.id from private.member_decision_notices notice_row join private.assigned_report_decisions decision_row using(decision_id)
 where decision_row.incident_revision=3 and notice_row.violation_outcome='invalidated');
-- ACK UPDATE/trigger 뒤 session 만료는 firstRead와 만료변경 전체를 rollback한다.
create function pg_temp.expire_notice_member_session()returns trigger language plpgsql as $$begin
 update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=pg_temp.safety_session(2);return new;end;$$;
create trigger synthetic_notice_member_expiry after update on private.member_decision_notices for each row execute function pg_temp.expire_notice_member_session();
set local role authenticated;
select pg_temp.safety_actor(2);
select pg_temp.safety_failure(format('select public.read_my_decision_notice(%L)',(select unread_notice from notice_test_refs)),'28000');
reset role;
drop trigger synthetic_notice_member_expiry on private.member_decision_notices;
do $$begin
 assert(select not_after is null from auth.sessions where id=pg_temp.safety_session(2));
 assert(select first_read_at is null from private.member_decision_notices where id=(select unread_notice from notice_test_refs));
end;$$;
-- ACK UPDATE 뒤 report 만료 역시 notice UPDATE 전체 rollback이다.
create function pg_temp.expire_notice_report()returns trigger language plpgsql as $$declare expiry timestamptz:=clock_timestamp()-interval'1 second';begin
 update private.member_reports set status='resolved',final_closed_at=expiry-interval'2160 hours',retention_due_at=expiry
 where id=(select report_id from review_cases where n=1);return new;end;$$;
create trigger synthetic_notice_report_expiry after update on private.member_decision_notices for each row execute function pg_temp.expire_notice_report();
set local role authenticated;
select pg_temp.safety_actor(2);
select pg_temp.safety_failure(format('select public.read_my_decision_notice(%L)',(select unread_notice from notice_test_refs)),'PT404');
reset role;
drop trigger synthetic_notice_report_expiry on private.member_decision_notices;
do $$begin
 assert(select retention_due_at is null from private.member_reports where id=(select report_id from review_cases where n=1));
 assert(select first_read_at is null from private.member_decision_notices where id=(select unread_notice from notice_test_refs));
end;$$;
-- 자격누락/기능제한 중 본인 관리 읽기는 유지한다. 신규활동 gate를 notice에 붙이지 않는다.
update private.naver_accounts set verification_status='information_required' where user_id=pg_temp.safety_uid(2);
set local role authenticated;
select pg_temp.safety_actor(2);
do $$begin assert jsonb_array_length(public.list_my_decision_notices(100,null)->'items')=5;end;$$;
reset role;
-- 동일 identity의 새회차도 이전회차 notice를 읽거나 ACK하지 않는다.
update private.member_episodes set ended_at=clock_timestamp()where profile_id=pg_temp.safety_uid(2)and ended_at is null;
insert into private.member_episodes(profile_id,identity_id)
 select pg_temp.safety_uid(2),identity_id from private.member_episodes where profile_id=pg_temp.safety_uid(2)order by started_at desc limit 1;
set local role authenticated;
select pg_temp.safety_actor(2);
do $$begin
 assert public.list_my_decision_notices(10,null)='{"items":[],"nextCursor":null}'::jsonb;
 perform pg_temp.safety_failure(format('select public.read_my_decision_notice(%L)',(select companion_notice from notice_test_refs)),'PT404');
end;$$;
reset role;
-- 실제 탈퇴 RPC와 구 JWT 검증은 다른 통합검사다. 여기서는 원 guard가 retired를 거절하는지 검사한다.
insert into private.member_retirements(profile_id,withdrawal_id,episode_id,retired_at)
 select pg_temp.safety_uid(1),gen_random_uuid(),id,clock_timestamp()from private.member_episodes where profile_id=pg_temp.safety_uid(1)and ended_at is null;
set local role authenticated;
select pg_temp.safety_actor(1);
select pg_temp.safety_failure('select public.list_my_decision_notices(10,null)','42501');
reset role;
-- report 최종종결+90d 실제 삭제 대상과 같은 목적: 상세 decision/notice를 함께 파기한다.
with closing_time as(select clock_timestamp()-interval'91 days'closed_at)
 update private.member_reports set status='resolved',final_closed_at=closing_time.closed_at,retention_due_at=closing_time.closed_at+interval'2160 hours'
 from closing_time where id=(select report_id from review_cases where n=1);
delete from private.member_reports where id=(select report_id from review_cases where n=1);
do $$begin
 assert not exists(select 1 from private.assigned_report_decisions where report_id=(select report_id from review_cases where n=1));
 assert(select count(*)=1 from private.assigned_report_decisions);
 assert(select count(*)=2 from private.member_decision_notices);
 assert(select count(*)=1 from private.assigned_report_adjudications where client_request_id=pg_temp.review_request(499));
end;$$;
-- 폐쇄 table/helper와 authenticated-only member RPC. PUBLIC 상속도 실효권한으로 검사한다.
do $$declare role_name text;sig text;begin
 foreach role_name in array array['anon','authenticated','service_role','authenticator']loop
  assert not has_table_privilege(role_name,'private.assigned_report_decisions','SELECT');
  assert not has_table_privilege(role_name,'private.member_decision_notices','UPDATE');
  assert not has_function_privilege(role_name,'private.require_member_decision_notice_episode()','EXECUTE');
  assert not has_function_privilege(role_name,'private.member_decision_notice_dto(private.member_decision_notices)','EXECUTE');
  foreach sig in array array['public.list_my_decision_notices(integer,uuid)','public.read_my_decision_notice(uuid)']loop
   assert has_function_privilege(role_name,sig,'EXECUTE')=(role_name='authenticated');
  end loop;
 end loop;
 assert not exists(select 1 from notice_function_baseline b join pg_proc p on p.oid=b.oid
  where p.proowner<>b.proowner or p.proacl is distinct from b.proacl or p.proconfig is distinct from b.proconfig);
end;$$;
rollback;
