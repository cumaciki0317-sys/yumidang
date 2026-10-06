-- 민규 C: source74 판정·정정 원자 SQL 후보. 실제 실행 NOT_RUN.
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
-- 첫 노쇼 사실만으로 귀책을 추정하지 않는다. 명시 companion 책임에만 -3을 적용한다.
set local role authenticated;
select pg_temp.safety_actor(3);
do $$declare r jsonb;s jsonb;begin
 r:=pg_temp.adjudicate(1,101,'initial',2,1,0,'no_show','confirmed','companion','no_show','none',null);
 assert(select count(*)from jsonb_object_keys(r))=5;
 assert r->>'status'='reviewing'and(r->>'version')::bigint=3 and not(r->>'alreadyApplied')::boolean;
 insert into adjudication_results values(1,r);
 assert pg_temp.adjudicate(1,101,'initial',2,1,0,'no_show','confirmed','companion','no_show','none',null)=r||jsonb_build_object('alreadyApplied',true);
 s:=public.get_assigned_report_adjudication_state((select report_id from review_cases where n=1));
 assert(select count(*)from jsonb_object_keys(s))=5;
 assert s->>'version'='3'and s->>'holdVersion'='2'and s->>'incidentRevision'='1';
 perform pg_temp.safety_failure($c$select pg_temp.adjudicate(1,101,'initial',2,1,0,'normal','none','none','no_action','none',null)$c$,'40001');
 perform pg_temp.safety_failure($c$select pg_temp.adjudicate(1,111,'correction',2,2,1,'normal','invalidated','none','decision_corrected','none',null)$c$,'40001');
 perform pg_temp.safety_failure($c$select pg_temp.adjudicate(1,112,'correction',3,1,1,'normal','invalidated','none','decision_corrected','none',null)$c$,'40001');
 perform pg_temp.safety_failure($c$select pg_temp.adjudicate(1,113,'correction',3,2,0,'normal','invalidated','none','decision_corrected','none',null)$c$,'40001');
 perform pg_temp.safety_failure($c$select pg_temp.adjudicate(1,114,'correction',3,2,1,'normal','none','none','no_action','none',null)$c$,'55000');
end;$$;
reset role;
do $$declare i uuid;begin
 select incident_id into i from private.safety_incident_report_links where report_id=(select report_id from review_cases where n=1);
 assert(select current_revision=1 from private.safety_incidents where id=i);
 assert(select count(*)=1 from private.assigned_report_adjudications where report_id=(select report_id from review_cases where n=1));
 assert private.current_member_sweetness(pg_temp.safety_uid(2))=12;
 assert private.current_member_sweetness(pg_temp.safety_uid(1))=15;
 assert not exists(select 1 from private.safety_sanction_applications where incident_id=i);
 assert not exists(select 1 from private.safety_incident_subjects where incident_id=i and victim_identity_id is not null);
 assert(select state='no_show'and version=2 from private.appointment_review_holds where report_id=(select report_id from review_cases where n=1));
end;$$;
-- 같은 사건 normal+major는 정상 동행과 안전 위반을 별개로 처리하고 기존 노쇼 감점을 제외한다.
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.adjudicate(1,102,'correction',3,2,1,'normal','confirmed','companion','threat','major','threat');
reset role;
do $$declare i uuid;begin
 select incident_id into i from private.safety_incident_report_links where report_id=(select report_id from review_cases where n=1);
 assert(select current_revision=2 from private.safety_incidents where id=i);
 assert private.current_member_sweetness(pg_temp.safety_uid(2))=5;
 assert(select count(*)=1 from private.safety_sanction_applications where incident_id=i and kind='permanent'and revoked_at is null and notified_at is null);
 assert(select state='normal'and version=3 from private.appointment_review_holds where report_id=(select report_id from review_cases where n=1));
end;$$;
-- 원 사건·원 회차 무효 정정은 공개/통지/최종 종결 시각을 만들지 않고 점수를 재계산한다.
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.adjudicate(1,103,'correction',4,3,2,'normal','invalidated','none','decision_corrected','none',null);
reset role;
do $$declare i uuid;begin
 select incident_id into i from private.safety_incident_report_links where report_id=(select report_id from review_cases where n=1);
 assert(select current_revision=3 from private.safety_incidents where id=i);
 assert private.current_member_sweetness(pg_temp.safety_uid(2))=15;
 assert not exists(select 1 from private.safety_sanction_applications where incident_id=i and revoked_at is null);
 assert(select bool_and(source_episode_id=(select requester_episode_id from private.appointment_member_episodes where appointment_id=(select appointment_id from review_cases where n=1)))from private.safety_incident_subjects where incident_id=i);
 assert(select status='reviewing'and review_version=5 and final_closed_at is null and retention_due_at is null from private.member_reports where id=(select report_id from review_cases where n=1));
end;$$;
-- 첫 minor 경고만 지원한다. 안내 전 다음 사건의 7d/30d를 추정하지 않는다.
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.adjudicate(3,301,'initial',2,null,0,'unchanged','confirmed','target','spam','minor','spam');
select pg_temp.safety_failure($c$select pg_temp.adjudicate(4,401,'initial',2,null,0,'unchanged','confirmed','target','spam','minor','spam')$c$,'55000');
select pg_temp.safety_failure($c$select pg_temp.adjudicate(4,402,'initial',2,null,0,'unchanged','confirmed','target','threat','minor','threat')$c$,'22023');
select pg_temp.safety_failure($c$select pg_temp.adjudicate(4,403,'initial',2,null,0,'unchanged','confirmed','none','spam','minor','spam')$c$,'22023');
select pg_temp.safety_failure($c$select pg_temp.adjudicate(4,404,'initial',2,1,0,'unchanged','confirmed','target','spam','minor','spam')$c$,'22023');
select pg_temp.safety_failure($c$select pg_temp.adjudicate(4,405,'initial',9007199254740991,null,0,'unchanged','none','none','no_action','none',null)$c$,'22023');
select pg_temp.safety_failure($c$select pg_temp.adjudicate(4,406,'initial',2,null,9007199254740991,'unchanged','none','none','no_action','none',null)$c$,'22023');
reset role;
do $$begin
 assert(select count(*)=1 from private.safety_sanction_applications where kind='general_warning'and revoked_at is null and notified_at is null);
 assert not exists(select 1 from private.safety_sanction_applications where kind in('general_7d','general_30d'));
 assert(select status='reviewing'and review_version=2 from private.member_reports where id=(select report_id from review_cases where n=4));
 assert not exists(select 1 from private.safety_incident_report_links where report_id=(select report_id from review_cases where n=4));
end;$$;
-- 접수 상태만으로 판정하지 않는다. 선행 start/version이 필요하다.
-- receipt INSERT 실패면 중대 제재/당도/hold/report version 모두 rollback한다.
create function pg_temp.reject_adjudication_receipt()returns trigger language plpgsql as $$begin raise exception 'synthetic_receipt_failure'using errcode='55000';end;$$;
create trigger synthetic_adjudication_receipt_failure before insert on private.assigned_report_adjudications for each row execute function pg_temp.reject_adjudication_receipt();
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure($c$select pg_temp.adjudicate(2,201,'initial',2,1,0,'normal','confirmed','author','violence','major','violence')$c$,'55000');
reset role;
drop trigger synthetic_adjudication_receipt_failure on private.assigned_report_adjudications;
do $$begin
 assert(select review_version=2 and status='reviewing'from private.member_reports where id=(select report_id from review_cases where n=2));
 assert(select state='reviewing'and version=1 from private.appointment_review_holds where report_id=(select report_id from review_cases where n=2));
 assert not exists(select 1 from private.safety_incident_report_links where report_id=(select report_id from review_cases where n=2));
 assert private.current_member_sweetness(pg_temp.safety_uid(1))=15;
end;$$;
-- 최종 session guard 실패도 전체 원장을 rollback한다. trigger는 같은 TX 합성 시험이다.
create function pg_temp.expire_adjudication_session()returns trigger language plpgsql as $$begin
 if new.id=(select report_id from review_cases where n=2)then update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=pg_temp.safety_session(3);end if;return new;end;$$;
create trigger synthetic_adjudication_session_expiry after update of review_version on private.member_reports for each row execute function pg_temp.expire_adjudication_session();
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure($c$select pg_temp.adjudicate(2,202,'initial',2,1,0,'normal','confirmed','author','violence','major','violence')$c$,'28000');
reset role;
drop trigger synthetic_adjudication_session_expiry on private.member_reports;
do $$begin
 assert(select not_after is null from auth.sessions where id=pg_temp.safety_session(3));
 assert(select review_version=2 from private.member_reports where id=(select report_id from review_cases where n=2));
 assert not exists(select 1 from private.assigned_report_adjudications where report_id=(select report_id from review_cases where n=2));
end;$$;
-- 같은 사건의 다른 신고 링크는 다른 사건을 묵시 정정하는 것을 차단한다.
insert into private.safety_incident_report_links(incident_id,report_id)select incident_id,(select report_id from review_cases where n=4)from private.safety_incident_report_links where report_id=(select report_id from review_cases where n=3);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure($c$select pg_temp.adjudicate(3,302,'correction',3,null,1,'unchanged','invalidated','none','decision_corrected','none',null)$c$,'55000');
reset role;
delete from private.safety_incident_report_links where report_id=(select report_id from review_cases where n=4);
-- 같은 사건 minor→major 정정은 원 사건을 유지한다. 경고에서 새 영구 제한으로 바뀌는 시각은 기존 helper가 결정한다.
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.adjudicate(3,303,'correction',3,null,1,'unchanged','confirmed','target','privacy_exposure','major','privacy_exposure');
reset role;
do $$begin
 assert private.current_member_sweetness(pg_temp.safety_uid(2))=5;
 assert(select count(*)=1 from private.safety_sanction_applications where kind='permanent'and revoked_at is null and notified_at is null);
 assert not exists(select 1 from private.member_reports where final_closed_at is not null or retention_due_at is not null);
 assert not exists(select 1 from private.safety_appeals);
end;$$;
-- 같은 사건 major→major 정정은 이미 적용된 제한 시각을 재시작하지 않는다.
create temp table adjudication_period_baseline as
 select a.id,a.applied_at,a.expires_at from private.safety_sanction_applications a
 join private.safety_incident_report_links l on l.incident_id=a.incident_id
 where l.report_id=(select report_id from review_cases where n=3)and a.kind='permanent'and a.revoked_at is null;
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.adjudicate(3,304,'correction',4,null,2,'unchanged','confirmed','target','threat','major','threat');
reset role;
do $$begin
 assert(select count(*)=1 from adjudication_period_baseline);
 assert(select bool_and(a.applied_at=b.applied_at and a.expires_at is not distinct from b.expires_at)
  from adjudication_period_baseline b join private.safety_sanction_applications a using(id));
 assert(select current_revision=3 from private.safety_incidents where id=(select incident_id from private.safety_incident_report_links where report_id=(select report_id from review_cases where n=3)));
 assert private.current_member_sweetness(pg_temp.safety_uid(2))=5;
end;$$;
-- 종료 회차에 처음 효과를 적용하는 미정 경로는 새 사건/receipt 없이 거절한다.
update private.member_episodes set ended_at=clock_timestamp()where profile_id=pg_temp.safety_uid(2)and ended_at is null;
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure($c$select pg_temp.adjudicate(4,409,'initial',2,null,0,'unchanged','confirmed','target','violence','major','violence')$c$,'55000');
reset role;
do $$begin
 assert not exists(select 1 from private.assigned_report_adjudications where report_id=(select report_id from review_cases where n=4));
 assert not exists(select 1 from private.safety_incident_report_links where report_id=(select report_id from review_cases where n=4));
 assert(select review_version=2 from private.member_reports where id=(select report_id from review_cases where n=4));
end;$$;
update private.member_episodes set ended_at=null where profile_id=pg_temp.safety_uid(2);
-- 보고 안전 정수 경계. none/no-action은 불필요한 책임을 받지 않는다.
update private.member_reports set review_version=9007199254740990 where id=(select report_id from review_cases where n=4);
set local role authenticated;
select pg_temp.safety_actor(3);
do $$declare r jsonb;begin
 r:=pg_temp.adjudicate(4,407,'initial',9007199254740990,null,0,'unchanged','none','none','no_action','none',null);
 assert(r->>'version')::bigint=9007199254740991;
end;$$;
select pg_temp.safety_failure($c$select pg_temp.adjudicate(4,408,'correction',9007199254740991,null,0,'unchanged','none','none','no_action','none',null)$c$,'22023');
reset role;
-- 자격 회원·다른 직원·익명 JWT는 자신의 역할 외 판정 권한이 없다.
set local role authenticated;
select pg_temp.safety_actor(1);
select pg_temp.safety_failure($c$select pg_temp.adjudicate(2,211,'initial',2,1,0,'normal','none','none','no_action','none',null)$c$,'42501');
select pg_temp.safety_actor(4);
select pg_temp.safety_failure($c$select pg_temp.adjudicate(1,212,'correction',5,4,3,'normal','invalidated','none','decision_corrected','none',null)$c$,'42501');
select pg_temp.safety_actor(3);
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_uid(3),'session_id',pg_temp.safety_session(3),'is_anonymous',true)::text,true);
select pg_temp.safety_failure($c$select pg_temp.adjudicate(2,213,'initial',2,1,0,'normal','none','none','no_action','none',null)$c$,'28000');
select pg_temp.safety_actor(3);
select pg_temp.safety_failure($c$select pg_temp.adjudicate(2,214,'initial',2,1,0,'no_show','none','none','no_action','none',null)$c$,'22023');
reset role;

-- 직원 approval/session/assignment 이외를 권한으로 간주하지 않는다. 실패 read audit도 없다.
select private.set_report_operator_assignment(pg_temp.safety_uid(3),(select report_id from review_cases where n=2),false);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure($c$select pg_temp.adjudicate(2,203,'initial',2,1,0,'normal','none','none','no_action','none',null)$c$,'42501');
select pg_temp.safety_failure(format('select public.get_assigned_report_adjudication_state(%L)',(select report_id from review_cases where n=2)),'42501');
reset role;
select private.set_report_operator_assignment(pg_temp.safety_uid(3),(select report_id from review_cases where n=2),true);
select private.set_report_operator_approval(pg_temp.safety_uid(3),false);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure($c$select pg_temp.adjudicate(2,204,'initial',2,1,0,'normal','none','none','no_action','none',null)$c$,'42501');
reset role;
select private.set_report_operator_approval(pg_temp.safety_uid(3),true);
update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=pg_temp.safety_session(3);
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure($c$select pg_temp.adjudicate(2,205,'initial',2,1,0,'normal','none','none','no_action','none',null)$c$,'28000');
reset role;
update auth.sessions set not_after=null where id=pg_temp.safety_session(3);
-- 원문 없는 post author/chat sender metadata. 실제 신고와 공개 DTO를 덮어쓰지 않는다.
do $$declare r private.member_reports;p jsonb;mid uuid;begin
 select *into r from private.member_reports where id=(select report_id from review_cases where n=1);
 r.target_type:='post';r.target_id:=(select post_id from review_cases where n=1);p:=private.assigned_report_party_metadata(r);
 assert p->0->>'role'='target'and p->0->>'profileId'=pg_temp.safety_uid(1)::text;
 select id into mid from public.chat_messages where join_request_id=(select join_request_id from public.appointments where id=(select appointment_id from review_cases where n=1))order by id limit 1;
 r.target_type:='chat';r.target_id:=mid;p:=private.assigned_report_party_metadata(r);
 assert p->0->>'profileId'=pg_temp.safety_uid(2)::text;
 r.target_type:='event';p:=private.assigned_report_party_metadata(r);assert p='[]'::jsonb;
end;$$;
-- 전역 ACL/roles/기본 폐쇄 guard/worker는 변경하지 않는다.
do $$declare role_name text;sig text;begin
 assert(select(roles,memberships,guard,worker)=(
  (select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls)order by rolname)from pg_roles),
  (select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members),
  (select external_deletion_approved from private.member_cleanup_guard where singleton),(select to_jsonb(g)from private.global_worker_run g where singleton))from safety_catalog);
 foreach role_name in array array['anon','authenticated','service_role','authenticator']loop
  assert not has_table_privilege(role_name,'private.assigned_report_adjudications','SELECT');
  foreach sig in array array['private.assigned_report_party_metadata(private.member_reports)','private.assigned_report_incident(uuid)']loop assert not has_function_privilege(role_name,sig,'EXECUTE');end loop;
 end loop;
 foreach role_name in array array['anon','authenticated','service_role']loop
  assert has_function_privilege(role_name,'public.get_assigned_report_adjudication_state(uuid)','EXECUTE')=(role_name='authenticated');
  assert has_function_privilege(role_name,'public.adjudicate_assigned_member_report(uuid,uuid,text,bigint,bigint,bigint,text,text,text,text,text,text)','EXECUTE')=(role_name='authenticated');
 end loop;
end;$$;
rollback;
