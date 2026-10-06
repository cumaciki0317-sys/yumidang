-- 민규: source65+40900 후보 회귀. 격리 단일TX SQL 회귀 통과. HTTP/두 세션 실행 NOT_RUN. owner 상태전환은 합성 fixture이며 직원 권한 증거가 아니다.
-- 실행은 제품 migration 적용 후 이 파일 전체 owner TX rollback이다. 실제 DB 시계/사용자 접수 시각을 변경하지 않는다.
begin;
set local plpgsql.check_asserts=on;
set local lock_timeout='3s';
set local statement_timeout='15s';
create temp table review_hold_baseline as select
 (select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil)order by oid)from pg_roles)roles,
 (select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members)memberships,
 (select external_deletion_approved from private.member_cleanup_guard where singleton)guard,
 (select to_jsonb(g)from private.global_worker_run g where singleton)worker;
create temp table review_hold_catalog_baseline as select
 (select jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,p.proconfig)order by p.oid)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private'))functions,
 (select coalesce(jsonb_agg(version order by version),'[]')from supabase_migrations.schema_migrations)history,
 (select coalesce(jsonb_agg(to_jsonb(a)order by migration_version),'[]')from private.appointment_safety_sync_audit a)audit;
set local storage.allow_delete_query='true';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[]) on conflict(id) do nothing;
create function pg_temp.review_hold_uid(n integer) returns uuid language sql immutable as $$
 select ('fd810000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.review_hold_session(n integer) returns uuid language sql immutable as $$
 select ('fd820000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.review_hold_actor(n integer) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.review_hold_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.review_hold_uid(n),'session_id',pg_temp.review_hold_session(n))::text,true);
end;$$;
create function pg_temp.review_hold_failure(command text,expected text) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code is not distinct from expected,format('expected %s, actual %s',expected,code);
end;$$;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.resolve_naver_account('change-review_hold-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;end;$$;
reset role;
insert into auth.users(id,email) select pg_temp.review_hold_uid(i),a.auth_email from generate_series(1,4)i
 join private.naver_accounts a on a.subject='change-review_hold-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.review_hold_session(i),pg_temp.review_hold_uid(i) from generate_series(1,4)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.review_hold_uid(i)::text||'/fd830000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.review_hold_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,4)i;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.record_naver_session('change-review_hold-sql-'||i,pg_temp.review_hold_uid(i),pg_temp.review_hold_session(i));end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..4 loop
 perform pg_temp.review_hold_actor(i);
 assert public.complete_naver_signup(pg_temp.review_hold_uid(i)::text||'/fd830000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
end loop;end;$$;
reset role;

create temp table review_hold_cases(n integer primary key,p uuid,ap uuid,r1 uuid,r2 uuid,h1 uuid,h2 uuid);
grant all on review_hold_cases to authenticated;
set local role authenticated;
do $$declare i integer;p_id uuid;r_id uuid;ap_id uuid;c jsonb;input jsonb;begin
 for i in 1..7 loop
 p_id:=gen_random_uuid();
 input:=jsonb_build_object('title','합성 완료 검토','description','격리 검토 회귀','category','산책',
 'startsAt',clock_timestamp()+make_interval(days=>i*3),'endsAt',clock_timestamp()+make_interval(days=>i*3,hours=>2),
 'recruitmentEndsAt',clock_timestamp()+make_interval(days=>i*3,hours=>-1),'publicArea','서울특별시 강남구 역삼동',
 'registeredPlaceName','가상 검토 장소','registeredAddress','서울특별시 강남구 가상주소','meetingDetail','가상 입구',
 'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0);
 perform pg_temp.review_hold_actor(1);perform public.create_service_post(p_id,input);
 perform pg_temp.review_hold_actor(2);r_id:=(public.request_service_post(p_id,gen_random_uuid(),'합성 신청')->>'id')::uuid;
 perform pg_temp.review_hold_actor(1);c:=public.propose_match(r_id);
 perform pg_temp.review_hold_actor(2);ap_id:=(public.accept_match(r_id,c->>'conditionVersion')->>'appointmentId')::uuid;
 insert into review_hold_cases(n,p,ap)values(i,p_id,ap_id);
 end loop;
end;$$;
reset role;
-- 모든 일정 조정은 owner 합성 fixture이며 DB 시계나 원문을 위조하지 않는다. 기한 fixture와 검토 중 합의 변경 fixture를 구분한다.
update public.posts set starts_at=statement_timestamp()-interval'3 hours',ends_at=statement_timestamp()-interval'1 hour',
 recruitment_ends_at=statement_timestamp()-interval'4 hours'where id in(select p from review_hold_cases where n in(1,3,5,6,7));
update public.posts set starts_at=statement_timestamp()-interval'3 days',ends_at=statement_timestamp()-interval'2 days',
 recruitment_ends_at=statement_timestamp()-interval'4 days'where id in(select p from review_hold_cases where n in(2,4));

create function pg_temp.review_hold_report(a_id uuid,label text)returns uuid language plpgsql as $$declare id uuid;begin
 id:=(public.submit_member_report(gen_random_uuid(),'appointment',a_id,'offline',array['other'],'합성 검토 '||label,'{}',false)->>'reportId')::uuid;
 return id;
end;$$;
set local role authenticated;
do $$declare c review_hold_cases;begin
 perform pg_temp.review_hold_actor(1);
 for c in select *from review_hold_cases loop
  update review_hold_cases set r1=pg_temp.review_hold_report(c.ap,c.n::text||'-first')where n=c.n;
 end loop;
 update review_hold_cases set r2=pg_temp.review_hold_report(ap,'second')where n=2;
end;$$;
reset role;
-- 접수만으로 hold/reservation/원장을 바꾸지 않는다는 실제 저장 경계.
do $$begin
 assert not exists(select 1 from private.appointment_review_holds where appointment_id in(select ap from review_hold_cases)),'report receipt does not become appointment dispute';
 assert(select count(*)=7 from private.completion_reservations where appointment_id in(select ap from review_hold_cases)),'receipt preserves completion reservations';
 assert(select count(*)=14 and bool_and(current_revision=1)from private.safety_appointment_results where appointment_id in(select ap from review_hold_cases)),'receipt preserves result facts';
 perform pg_temp.review_hold_failure(format('select private.enter_appointment_review(%L,%L)',(select r1 from review_hold_cases where n=1),(select ap from review_hold_cases where n=1)),'55000');
end;$$;
-- 명시 owner 검토 상태 준비. 접수자/모델이 판정하지 않으며 helper가 report 최종 종결·90일을 시작하지 않는다.
update private.member_reports set status='reviewing'where id in(select r1 from review_hold_cases);
update private.member_reports set status='more_evidence'where id=(select r2 from review_hold_cases where n=2);
do $$declare c review_hold_cases;x jsonb;before jsonb;begin
 for c in select *from review_hold_cases where n in(1,2,4,6)loop
  x:=private.enter_appointment_review(c.r1,c.ap);
  assert x->>'state'='reviewing' and x->>'version'='1' and x->>'deduplicated'='false','explicit owner enter';
  update review_hold_cases set h1=(x->>'holdId')::uuid where n=c.n;
  before:=(select to_jsonb(h)from private.appointment_review_holds h where hold_id=(x->>'holdId')::uuid);
  assert private.enter_appointment_review(c.r1,c.ap)->>'deduplicated'='true','enter retry deduplicated';
  assert before=(select to_jsonb(h)from private.appointment_review_holds h where hold_id=(x->>'holdId')::uuid),'enter retry immutable';
 end loop;
 select *into c from review_hold_cases where n=2;x:=private.enter_appointment_review(c.r2,c.ap);
 update review_hold_cases set h2=(x->>'holdId')::uuid where n=2;
 assert(select count(*)=4 and bool_and(status='confirmed' and completed_at is null and completion_method is null and review_deadline_at is null)
 from public.appointments where id in(select ap from review_hold_cases where n in(1,2,4,6))),'pre-completion hold manufactures no completion fields';
 assert not exists(select 1 from private.completion_reservations where appointment_id in(select ap from review_hold_cases where n in(1,2,4,6))),'held reservations absent';
 -- 장애로 남은 예약을 owner fixture로 주입해도 실제 예약 실행이 보류를 재검사하고 제거한다.
 insert into private.completion_reservations(appointment_id,due_at)
  select case_row.ap,post_row.ends_at+interval'24 hours'from review_hold_cases case_row join public.posts post_row on post_row.id=case_row.p where case_row.n=2;
 assert(select public.execute_completion_reservation(appointment_id,generation)->>'status'='stale'from private.completion_reservations where appointment_id=(select ap from review_hold_cases where n=2)),'stale queued reservation cannot bypass hold';
 assert not exists(select 1 from private.completion_reservations where appointment_id=(select ap from review_hold_cases where n=2)),'held stale reservation removed';

 assert(select count(*)=8 and bool_and(r.outcome='pending')from private.safety_appointment_results h join private.safety_appointment_result_revisions r
 on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision where h.appointment_id in(select ap from review_hold_cases where n in(1,2,4,6))),'held first results pending without guilt';
 assert not exists(select 1 from private.member_reports where id in(select r1 from review_hold_cases)and(final_closed_at is not null or retention_due_at is not null)),'enter does not final-close report';
 assert(select status='more_evidence' and final_closed_at is null from private.member_reports where id=(select r2 from review_hold_cases where n=2)),'explicit more-evidence hold leaves report status intact';
end;$$;
set local role authenticated;
do $$begin perform pg_temp.review_hold_actor(1);
 perform pg_temp.review_hold_failure(format('select public.confirm_appointment_completion(%L)',(select ap from review_hold_cases where n=2)),'22023');
 perform pg_temp.review_hold_failure(format('select public.submit_appointment_review(%L,5,''합성 보류 후기'',''positive'',''{}'')',(select ap from review_hold_cases where n=2)),'22023');
end;$$;
reset role;
do $$begin
 assert not private.can_submit_appointment_review((select ap from review_hold_cases where n=2),pg_temp.review_hold_uid(1),clock_timestamp()),'held review write guard';
 perform private.complete_due_appointments(clock_timestamp(),100);
 assert(select status='confirmed' and completed_at is null from public.appointments where id=(select ap from review_hold_cases where n=2)),'batch automatic completion skips held expired appointment';
end;$$;
\echo PASS explicit reviewing guard; no receipt conversion; manual/automatic/review pending

-- 원 기한 전 마지막 정상 해소: 실제 완료 없이 원 기한 예약을 복원한다.
do $$declare c review_hold_cases;decision uuid:=gen_random_uuid();x jsonb;before jsonb;begin
 select *into c from review_hold_cases where n=1;
 x:=private.resolve_appointment_review(c.h1,c.ap,1,decision,'normal');
 assert x->>'state'='normal' and x->>'version'='2','normal owner fact';
 assert(select status='confirmed' and completed_at is null and review_deadline_at is null from public.appointments where id=c.ap),'before due remains not complete';
 assert(select r.due_at=p.ends_at+interval'24 hours'from private.completion_reservations r join public.posts p on p.id=c.p where r.appointment_id=c.ap),'original deadline restored without review extension';
 before:=(select to_jsonb(r)from private.completion_reservations r where appointment_id=c.ap);
 assert private.resolve_appointment_review(c.h1,c.ap,1,decision,'normal')->>'deduplicated'='true','resolution lost-response retry';
 assert before=(select to_jsonb(r)from private.completion_reservations r where appointment_id=c.ap),'retry retains generation and due';
 assert not exists(select 1 from private.appointment_review_windows where appointment_id=c.ap),'closed window removed';
end;$$;
\echo PASS before due normal restores original24h reservation and retry generation

-- 다중 hold의 마지막 정상 해소 때만 기한이 지났다면 최초 실제 완료와 7일을 시작한다.
do $$declare c review_hold_cases;first_decision uuid:=gen_random_uuid();last_decision uuid:=gen_random_uuid();before jsonb;begin
 select *into c from review_hold_cases where n=2;
 perform private.resolve_appointment_review(c.h1,c.ap,1,first_decision,'normal');
 assert private.appointment_review_held(c.ap),'another hold still pending';
 assert(select status='confirmed' and completed_at is null from public.appointments where id=c.ap),'one hold resolution cannot complete';
 assert exists(select 1 from private.appointment_review_windows where appointment_id=c.ap),'window stays until all reviews clear';
 perform private.resolve_appointment_review(c.h2,c.ap,1,last_decision,'normal');
 assert(select status='completed' and completion_method='automatic' and completed_at>=statement_timestamp()
 and review_deadline_at=completed_at+interval'7 days'from public.appointments where id=c.ap),'first actual completion time begins seven days';
 assert not exists(select 1 from public.appointment_completion_confirmations where appointment_id=c.ap),'recognition creates no personal confirmations';
 assert(select count(*)=2 from public.notifications n join public.appointments a on a.join_request_id=n.join_request_id where a.id=c.ap and n.kind='appointment_completed'),'two one-time completion notices';
 assert(select count(*)=2 and bool_and(r.outcome='completed' and r.origin='appointment')from private.safety_appointment_results h join private.safety_appointment_result_revisions r
 on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision where h.appointment_id=c.ap),'first completion updates auto-origin results';
 before:=(select to_jsonb(a)from public.appointments a where id=c.ap);
 assert private.resolve_appointment_review(c.h2,c.ap,1,last_decision,'normal')->>'deduplicated'='true','completed resolution retry';
 assert before=(select to_jsonb(a)from public.appointments a where id=c.ap),'completed time and review deadline immutable on retry';
 assert not exists(select 1 from private.appointment_review_windows where appointment_id=c.ap),'last normal removes window';
end;$$;
\echo PASS multi-hold original deadline elapsed actual first completion and7d only once

-- 기존 완료/공개 유지와 override, legacy 분쟁 교차 보류.
set local role authenticated;
do $$declare c review_hold_cases;begin select *into c from review_hold_cases where n=3;
 perform pg_temp.review_hold_actor(1);perform public.confirm_appointment_completion(c.ap);
 perform pg_temp.review_hold_actor(2);perform public.confirm_appointment_completion(c.ap);
 perform pg_temp.review_hold_actor(1);perform public.submit_appointment_review(c.ap,5,'합성 공개 후기','positive','{}');
 perform pg_temp.review_hold_actor(2);perform public.submit_appointment_review(c.ap,5,'합성 숨김 후기','positive','{}');
end;$$;
reset role;
update private.review_publication pub set is_public=false,publication_source='override'
 from public.appointment_reviews r where r.id=pub.review_id and r.appointment_id=(select ap from review_hold_cases where n=3)and r.reviewer_id=pg_temp.review_hold_uid(2);
update public.appointments set review_deadline_at=clock_timestamp()+interval'30 minutes'where id=(select ap from review_hold_cases where n=3);
create temp table review_hold_completed_before as select completed_at,completion_method from public.appointments where id=(select ap from review_hold_cases where n=3);
do $$declare c review_hold_cases;x jsonb;begin select *into c from review_hold_cases where n=3;
 x:=private.enter_appointment_review(c.r1,c.ap);update review_hold_cases set h1=(x->>'holdId')::uuid where n=3;
 assert not private.review_release_ready(c.ap),'new publication held';
 assert(select private.is_review_public_eligible(r.id)from public.appointment_reviews r where r.appointment_id=c.ap and r.reviewer_id=pg_temp.review_hold_uid(1)),'already public stays visible';
 assert(select not private.is_review_public_eligible(r.id)and not pub.is_public and pub.publication_source='override'
 from public.appointment_reviews r join private.review_publication pub on pub.review_id=r.id where r.appointment_id=c.ap and r.reviewer_id=pg_temp.review_hold_uid(2)),'override remains hidden';
 assert(select bool_and(r.outcome='pending')from private.safety_appointment_results h join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision where h.appointment_id=c.ap),'completed result held in same TX';
end;$$;
set local role authenticated;
do $$begin perform pg_temp.review_hold_actor(1);perform public.raise_appointment_dispute((select ap from review_hold_cases where n=3),'합성 기존 분쟁');end;$$;
reset role;
do $$declare c review_hold_cases;before timestamptz;resume_before timestamptz;resume_after timestamptz;begin select *into c from review_hold_cases where n=3;
 select review_deadline_at into before from public.appointments where id=c.ap;
 perform private.resolve_appointment_review(c.h1,c.ap,1,gen_random_uuid(),'normal');
 assert private.appointment_review_held(c.ap),'legacy dispute still blocks last report hold';
 assert(select review_deadline_at=before and status='disputed'from public.appointments where id=c.ap),'cross hold does not resume period';
 assert exists(select 1 from private.appointment_review_windows where appointment_id=c.ap),'cross hold keeps saved window';
 resume_before:=clock_timestamp();
 perform private.resolve_appointment_dispute(c.ap,'actual_meetup',clock_timestamp());
 resume_after:=clock_timestamp();
 assert not private.appointment_review_held(c.ap),'legacy normal finally clears total hold';
 assert(select a.completed_at=b.completed_at and a.completion_method=b.completion_method and a.status='completed'
 and a.review_deadline_at>=resume_before+interval'24 hours'
 and a.review_deadline_at<=resume_after+interval'24 hours'
 from public.appointments a cross join review_hold_completed_before b where a.id=c.ap),'existing completion preserved and minimum24h restored';
 assert(select bool_and(r.outcome='completed')from private.safety_appointment_results h join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision where h.appointment_id=c.ap),'normal restoration updates automatic origin';
 assert(select private.is_review_public_eligible(r.id)from public.appointment_reviews r where r.appointment_id=c.ap and r.reviewer_id=pg_temp.review_hold_uid(1)),'public review preserved after resume';
 assert not exists(select 1 from private.appointment_review_windows where appointment_id=c.ap),'cross last resolution window removed';
end;$$;
\echo PASS already-public/override preservation and legacy cross-hold min24h resume

-- 노쇼 최소 사실은 report 원문 90일 파기와 분리한다. 자동 귀책/제재를 만들지 않는다.
do $$declare c review_hold_cases;decision uuid:=gen_random_uuid();before jsonb;begin select *into c from review_hold_cases where n=4;
 perform private.resolve_appointment_review(c.h1,c.ap,1,decision,'no_show');
 assert private.appointment_review_held(c.ap),'no show remains a completion hold';
 assert(select status='confirmed' and completed_at is null and completion_method is null from public.appointments where id=c.ap),'no show fact does not fake completion fields';
 assert not exists(select 1 from private.completion_reservations where appointment_id=c.ap),'no show excludes reservation';
 assert private.resolve_appointment_review(c.h1,c.ap,1,decision,'no_show')->>'deduplicated'='true','no show decision retry';
 perform pg_temp.review_hold_failure(format('select private.resolve_appointment_review(%L,%L,1,%L,''normal'')',c.h1,c.ap,gen_random_uuid()),'40001');
 -- 최종 종결은 별도 owner 합성 fixture이며 제품 helper가 기한을 시작했다는 증거가 아니다.
 update private.member_reports set status='resolved',final_closed_at=statement_timestamp()-interval'2184 hours',retention_due_at=statement_timestamp()-interval'24 hours'where id=c.r1;
 delete from private.member_reports where id=c.r1;
 assert not exists(select 1 from private.member_report_details where report_id=c.r1),'report original can be purged';
 assert(select report_id is null and state='no_show'from private.appointment_review_holds where hold_id=c.h1),'purge removes report link but keeps independent minimum fact';
 perform private.sync_completion_reservation(c.ap);
 assert private.appointment_review_held(c.ap)and not exists(select 1 from private.completion_reservations where appointment_id=c.ap),'purge cannot reactivate automatic completion';
 perform private.complete_due_appointments(clock_timestamp(),100);
 assert(select status='confirmed' and completed_at is null from public.appointments where id=c.ap),'expired no-show fact remains excluded after report purge';
 assert(select bool_and(r.outcome='pending')from private.safety_appointment_results h join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision where h.appointment_id=c.ap),'no show no automatic guilt or exemption';
 assert not exists(select 1 from private.safety_sanction_applications),'no automatic sanction';
 -- 원문 삭제 후 owner 명시 정정은 독립 hold key로 가능하다. 새 직원/API 접근권한은 없다.
 perform private.resolve_appointment_review(c.h1,c.ap,2,gen_random_uuid(),'normal');
 assert not private.appointment_review_held(c.ap),'purged-report independent fact can be explicitly corrected';
end;$$;
\echo PASS report/details purge leaves no-show automatic exclusion; independent owner correction

-- 기존 분쟁의 노쇼 종결과 새 report 정상 해소가 교차해도 정상 완료/후기 재개를 만들지 않는다.
set local role authenticated;
do $$declare c review_hold_cases;begin select *into c from review_hold_cases where n=7;
 perform pg_temp.review_hold_actor(1);perform public.confirm_appointment_completion(c.ap);
 perform pg_temp.review_hold_actor(2);perform public.confirm_appointment_completion(c.ap);
 perform pg_temp.review_hold_actor(1);perform public.raise_appointment_dispute(c.ap,'합성 기존 노쇼 검토');
end;$$;
reset role;
do $$declare c review_hold_cases;x jsonb;before timestamptz;begin select *into c from review_hold_cases where n=7;
 x:=private.enter_appointment_review(c.r1,c.ap);update review_hold_cases set h1=(x->>'holdId')::uuid where n=7;
 select review_deadline_at into before from public.appointments where id=c.ap;
 perform private.resolve_appointment_review((x->>'holdId')::uuid,c.ap,1,gen_random_uuid(),'normal');
 assert private.appointment_review_held(c.ap),'open legacy cross-hold persists';
 perform private.resolve_appointment_dispute(c.ap,'no_show',clock_timestamp());
 assert private.appointment_review_held(c.ap),'legacy no-show cross-hold persists after report normal';
 assert(select status='no_show' and review_deadline_at=before from public.appointments where id=c.ap),'legacy no-show does not resume review period';
 assert exists(select 1 from private.appointment_review_windows where appointment_id=c.ap),'no-show cross-hold keeps saved window';
 assert not exists(select 1 from private.completion_reservations where appointment_id=c.ap),'no-show cross-hold cannot schedule automatic completion';
end;$$;
\echo PASS legacy open/no-show prevents report-normal completion and review resume

-- 오류는 전체 rollback하고 예상 성공으로 대체하지 않는다.
create function pg_temp.review_hold_snapshot(a_id uuid)returns jsonb language sql as $$
 select jsonb_build_object('appointment',(select to_jsonb(a)from public.appointments a where id=a_id),
 'holds',(select jsonb_agg(to_jsonb(h)order by hold_id)from private.appointment_review_holds h where appointment_id=a_id),
 'window',(select to_jsonb(w)from private.appointment_review_windows w where appointment_id=a_id),
 'reservation',(select to_jsonb(r)from private.completion_reservations r where appointment_id=a_id),
 'results',(select jsonb_agg(to_jsonb(h)order by identity_id)from private.safety_appointment_results h where appointment_id=a_id),
 'revisions',(select jsonb_agg(to_jsonb(r)order by identity_id,revision)from private.safety_appointment_result_revisions r where appointment_id=a_id));$$;
do $$declare c review_hold_cases;before jsonb;begin select *into c from review_hold_cases where n=5;
 before:=pg_temp.review_hold_snapshot(c.ap);
 begin perform private.enter_appointment_review(c.r1,c.ap);raise exception 'synthetic_rollback'using errcode='40001';exception when serialization_failure then null;end;
 assert before=pg_temp.review_hold_snapshot(c.ap),'enter rollback restores appointments/window/reservation/result revisions';
end;$$;
-- owner의 합성 최신 합의 시각 fixture이며 회원 HTTP의 쌍방 일정 수락 증거로 확대하지 않는다.
do $$declare c review_hold_cases;old_due timestamptz;new_due timestamptz;begin
 select *into c from review_hold_cases where n=6;
 -- 아직 reviewing인 hold에서 조기 report 종결 거절을 먼저 검증한다.
 perform pg_temp.review_hold_failure(format('update private.member_reports set status=''resolved'' where id=%L',c.r1),'55000');
 assert(select status='reviewing'and final_closed_at is null from private.member_reports where id=c.r1) is true,'active review cannot silently final-close report';
 select original_due_at into old_due from private.appointment_review_windows where appointment_id=c.ap;
 update public.posts set ends_at=ends_at+interval'1 hour'where id=c.p;
 select ends_at+interval'24 hours'into new_due from public.posts where id=c.p;
 assert old_due is not null and new_due is not null and new_due>clock_timestamp()and new_due<>old_due,'fixture has changed future agreed due';
 perform private.resolve_appointment_review(c.h1,c.ap,1,gen_random_uuid(),'normal');
 assert(select status='confirmed'and completed_at is null and review_deadline_at is null from public.appointments where id=c.ap) is true,'future latest agreed due preserves precompletion';
 assert(select due_at=new_due from private.completion_reservations where appointment_id=c.ap) is true,'reservation follows latest agreed end plus24h';
 assert not exists(select 1 from private.appointment_review_windows where appointment_id=c.ap),'successful future resolution clears review window';
end;$$;
do $$declare c review_hold_cases;hold_id uuid;old_due timestamptz;new_due timestamptz;resolved_before timestamptz;resolved_after timestamptz;begin
 select *into c from review_hold_cases where n=5;
 hold_id:=(private.enter_appointment_review(c.r1,c.ap)->>'holdId')::uuid;
 select original_due_at into old_due from private.appointment_review_windows where appointment_id=c.ap;
 update public.posts set starts_at=statement_timestamp()-interval'3 days',ends_at=statement_timestamp()-interval'2 days',recruitment_ends_at=statement_timestamp()-interval'4 days'where id=c.p;
 select ends_at+interval'24 hours'into new_due from public.posts where id=c.p;
 assert old_due is not null and new_due is not null and old_due>clock_timestamp()and new_due<clock_timestamp()and new_due<>old_due,'fixture changes future capture to elapsed latest agreed due';
 resolved_before:=clock_timestamp();
 perform private.resolve_appointment_review(hold_id,c.ap,1,gen_random_uuid(),'normal');
 resolved_after:=clock_timestamp();
 assert(select status='completed'and completion_method='automatic'and completed_at between resolved_before and resolved_after and review_deadline_at=completed_at+interval'7 days'from public.appointments where id=c.ap) is true,'elapsed latest agreed due establishes actual first completion plus7d';
 assert not exists(select 1 from private.completion_reservations where appointment_id=c.ap),'elapsed reservation executed';
 assert not exists(select 1 from private.appointment_review_windows where appointment_id=c.ap),'successful elapsed resolution clears review window';
 assert(select count(*)=2 and bool_and(r.outcome='completed'and r.origin='appointment')from private.safety_appointment_results h join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision where h.appointment_id=c.ap) is true,'normal recognition syncs actual completion facts';
end;$$;
\echo PASS rollback; reviewing report cannot prematurely final-close; latest agreed future/elapsed due

do $$declare name text;signature text;begin
 foreach name in array array['anon','authenticated','service_role','yumidang_worker_queue']loop
  foreach signature in array array['private.appointment_review_held(uuid)','private.enter_appointment_review(uuid,uuid)',
   'private.resolve_appointment_review(uuid,uuid,bigint,uuid,text)','private.resume_appointment_review_if_clear(uuid)','private.guard_appointment_review_report_state()']loop
   assert not has_function_privilege(name,signature,'EXECUTE'),'owner-only hold functions ACL';
  end loop;
  assert not has_table_privilege(name,'private.appointment_review_holds','SELECT,INSERT,UPDATE,DELETE'),'hold metadata no member/raw access';
  assert not has_table_privilege(name,'private.appointment_review_windows','SELECT,INSERT,UPDATE,DELETE'),'window no member/raw access';
 end loop;
 assert not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))acl
 where p.oid in('private.enter_appointment_review(uuid,uuid)'::regprocedure,'private.resolve_appointment_review(uuid,uuid,bigint,uuid,text)'::regprocedure)
 and acl.grantee=0 and acl.privilege_type='EXECUTE'),'PUBLIC direct calls closed';
 assert not exists(select 1 from private.safety_sanction_applications),'no sanction facts inferred';
 assert(select functions from review_hold_catalog_baseline)=(select jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,p.proconfig)order by p.oid)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private')),'runtime preserves public/private function OID owner ACL config';
 assert(select history from review_hold_catalog_baseline)=(select coalesce(jsonb_agg(version order by version),'[]')from supabase_migrations.schema_migrations),'runtime history unchanged';
 assert(select audit from review_hold_catalog_baseline)=(select coalesce(jsonb_agg(to_jsonb(a)order by migration_version),'[]')from private.appointment_safety_sync_audit a),'source65 sync migration audit unchanged';

 assert(select roles from review_hold_baseline)=(select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil)order by oid)from pg_roles),'global role flags unchanged';
 assert(select memberships from review_hold_baseline)=(select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members),'global memberships unchanged';
 assert(select guard from review_hold_baseline)is not distinct from(select external_deletion_approved from private.member_cleanup_guard where singleton),'cleanup guard unchanged';
 assert(select worker from review_hold_baseline)is not distinct from(select to_jsonb(g)from private.global_worker_run g where singleton),'global worker unchanged';
end;$$;
select 'NOT_RUN actual two-session enter/completion race; HTTP/operator provisioning';
rollback;
