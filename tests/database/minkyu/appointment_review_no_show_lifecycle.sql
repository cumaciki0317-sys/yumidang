-- 민규: source66+41000 후보 회귀. 실제 SQL/HTTP/두 세션 실행 NOT_RUN. owner 상태전환은 합성 fixture이며 직원 권한 증거가 아니다.
-- 실행은 제품 migration 적용 후 이 파일 전체 owner TX rollback이다. 실제 DB 시계/사용자 접수 시각을 변경하지 않는다.
begin;
set local plpgsql.check_asserts=on;
set local lock_timeout='3s';
set local statement_timeout='15s';
create temp table review_no_show_baseline as select
 (select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil)order by oid)from pg_roles)roles,
 (select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members)memberships,
 (select external_deletion_approved from private.member_cleanup_guard where singleton)guard,
 (select to_jsonb(g)from private.global_worker_run g where singleton)worker;
create temp table review_no_show_catalog_baseline as select
 (select jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,p.proconfig)order by p.oid)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private'))functions,
 (select coalesce(jsonb_agg(version order by version),'[]')from supabase_migrations.schema_migrations)history,
 (select coalesce(jsonb_agg(to_jsonb(a)order by migration_version),'[]')from private.appointment_safety_sync_audit a)audit;
set local storage.allow_delete_query='true';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[]) on conflict(id) do nothing;
create function pg_temp.review_no_show_uid(n integer) returns uuid language sql immutable as $$
 select ('fa910000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.review_no_show_session(n integer) returns uuid language sql immutable as $$
 select ('fa920000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.review_no_show_actor(n integer) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.review_no_show_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.review_no_show_uid(n),'session_id',pg_temp.review_no_show_session(n))::text,true);
end;$$;
create function pg_temp.review_no_show_failure(command text,expected text) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code is not distinct from expected,format('expected %s, actual %s',expected,code);
end;$$;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.resolve_naver_account('change-review_no_show-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;end;$$;
reset role;
insert into auth.users(id,email) select pg_temp.review_no_show_uid(i),a.auth_email from generate_series(1,4)i
 join private.naver_accounts a on a.subject='change-review_no_show-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.review_no_show_session(i),pg_temp.review_no_show_uid(i) from generate_series(1,4)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.review_no_show_uid(i)::text||'/fa930000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.review_no_show_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,4)i;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.record_naver_session('change-review_no_show-sql-'||i,pg_temp.review_no_show_uid(i),pg_temp.review_no_show_session(i));end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..4 loop
 perform pg_temp.review_no_show_actor(i);
 assert public.complete_naver_signup(pg_temp.review_no_show_uid(i)::text||'/fa930000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
end loop;end;$$;
reset role;

create temp table review_no_show_cases(n integer primary key,p uuid,ap uuid,r1 uuid,r2 uuid,h1 uuid,h2 uuid);
grant all on review_no_show_cases to authenticated;
set local role authenticated;
do $$declare i integer;p_id uuid;r_id uuid;ap_id uuid;c jsonb;input jsonb;begin
 for i in 1..8 loop
 p_id:=gen_random_uuid();
 input:=jsonb_build_object('title','합성 완료 검토','description','격리 검토 회귀','category','산책',
 'startsAt',clock_timestamp()+make_interval(days=>i*3),'endsAt',clock_timestamp()+make_interval(days=>i*3,hours=>2),
 'recruitmentEndsAt',clock_timestamp()+make_interval(days=>i*3,hours=>-1),'publicArea','서울특별시 강남구 역삼동',
 'registeredPlaceName','가상 검토 장소','registeredAddress','서울특별시 강남구 가상주소','meetingDetail','가상 입구',
 'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0);
 perform pg_temp.review_no_show_actor(case when i in(7,8) then 3 else 1 end);perform public.create_service_post(p_id,input);
 perform pg_temp.review_no_show_actor(case when i in(7,8) then 4 else 2 end);r_id:=(public.request_service_post(p_id,gen_random_uuid(),'합성 신청')->>'id')::uuid;
 perform pg_temp.review_no_show_actor(case when i in(7,8) then 3 else 1 end);c:=public.propose_match(r_id);
 perform pg_temp.review_no_show_actor(case when i in(7,8) then 4 else 2 end);ap_id:=(public.accept_match(r_id,c->>'conditionVersion')->>'appointmentId')::uuid;
 insert into review_no_show_cases(n,p,ap)values(i,p_id,ap_id);
 end loop;
end;$$;
reset role;
-- 모든 일정 조정은 owner 합성 fixture이며 DB 시계나 원문을 위조하지 않는다. 기한 fixture와 검토 중 합의 변경 fixture를 구분한다.
update public.posts set starts_at=statement_timestamp()-interval'3 hours',ends_at=statement_timestamp()-interval'1 hour',
 recruitment_ends_at=statement_timestamp()-interval'4 hours'where id in(select p from review_no_show_cases where review_no_show_cases.n in(1,3,5,6,7,8));
update public.posts set starts_at=statement_timestamp()-interval'3 days',ends_at=statement_timestamp()-interval'2 days',
 recruitment_ends_at=statement_timestamp()-interval'4 days'where id in(select p from review_no_show_cases where review_no_show_cases.n in(2,4));

create function pg_temp.review_no_show_report(a_id uuid,label text)returns uuid language plpgsql as $$declare id uuid;begin
 id:=(public.submit_member_report(gen_random_uuid(),'appointment',a_id,'offline',array['other'],'합성 검토 '||label,'{}',false)->>'reportId')::uuid;
 return id;
end;$$;
set local role authenticated;
do $$declare c review_no_show_cases;begin
 perform pg_temp.review_no_show_actor(1);
 for c in select *from review_no_show_cases loop
  perform pg_temp.review_no_show_actor(case when c.n in(7,8) then 3 else 1 end);
  update review_no_show_cases set r1=pg_temp.review_no_show_report(c.ap,c.n::text||'-first')where review_no_show_cases.n=c.n;
 end loop;
 -- 독립 사례7에서 회원3으로 바뀐 세션을 사례2의 실제 당사자1로 다시 고정한다. 두 신고는 판정 전에 접수한다.
 perform pg_temp.review_no_show_actor(1);
 update review_no_show_cases set r2=pg_temp.review_no_show_report(ap,'second')where review_no_show_cases.n=2;
 perform pg_temp.review_no_show_actor(3);
 update review_no_show_cases set r2=pg_temp.review_no_show_report(ap,'pending-second')where review_no_show_cases.n=8;
end;$$;
reset role;

create temp table no_show_incident_baseline as select
 (select count(*)from private.sweetness_incidents) incidents,
 (select count(*)from private.sweetness_incident_decisions) decisions;
-- 기존 실제 완료/공개 후기의 무효·정정 계산은 별도 사례3으로 확인한다.
set local role authenticated;
do $$declare c review_no_show_cases;begin select *into c from review_no_show_cases where review_no_show_cases.n=3;
 perform pg_temp.review_no_show_actor(1);perform public.confirm_appointment_completion(c.ap);
 perform pg_temp.review_no_show_actor(2);perform public.confirm_appointment_completion(c.ap);
 perform pg_temp.review_no_show_actor(1);perform public.submit_appointment_review(c.ap,5,'합성 노쇼 정정 후기','positive','{}');
 perform pg_temp.review_no_show_actor(2);perform public.submit_appointment_review(c.ap,5,'합성 노쇼 상대 후기','positive','{}');
end;$$;
reset role;
create temp table no_show_completed_baseline as select id,completed_at,completion_method,completed_by_user_id,
 completion_notified_at,dispute_deadline_at,review_deadline_at from public.appointments where id=(select ap from review_no_show_cases where review_no_show_cases.n=3);
create temp table no_show_metric_baseline as select private.current_member_sweetness(pg_temp.review_no_show_uid(1)) sweetness,
 private.completed_appointment_count(pg_temp.review_no_show_uid(1)) completed;

-- legacy 분쟁과 명시 신고 hold의 교차 정정도 같은 최종 상태를 사용한다.
set local role authenticated;
do $$begin perform pg_temp.review_no_show_actor(1);
 perform public.raise_appointment_dispute((select ap from review_no_show_cases where review_no_show_cases.n=3),'합성 노쇼 교차 검토');
end;$$;
reset role;
update private.member_reports set status='reviewing'where id in(select r1 from review_no_show_cases);
update private.member_reports set status='more_evidence'where id in(select r2 from review_no_show_cases where review_no_show_cases.n in(2,8));
do $$declare c review_no_show_cases;x jsonb;begin for c in select *from review_no_show_cases where review_no_show_cases.n in(1,2,3,7,8)loop
 x:=private.enter_appointment_review(c.r1,c.ap);
 update review_no_show_cases set h1=(x->>'holdId')::uuid where review_no_show_cases.n=c.n;
 end loop;
 for c in select *from review_no_show_cases where review_no_show_cases.n in(2,8)loop
  x:=private.enter_appointment_review(c.r2,c.ap);
  update review_no_show_cases set h2=(x->>'holdId')::uuid where review_no_show_cases.n=c.n;
 end loop;
end;$$;

-- 완료 전 노쇼는 종결 상태이며 완료 필드는 만들지 않는다. 조회·기한·귀책은 별도다.
do $$declare c review_no_show_cases;decision uuid:=gen_random_uuid();before jsonb;state jsonb;begin
 select *into c from review_no_show_cases where review_no_show_cases.n=1;
 perform private.resolve_appointment_review(c.h1,c.ap,1,decision,'no_show');
 assert(select status='no_show' and completed_at is null and completion_method is null and completed_by_user_id is null
 and completion_notified_at is null and dispute_deadline_at is null and review_deadline_at is null from public.appointments where id=c.ap) is true;
 assert not exists(select 1 from private.completion_reservations where appointment_id=c.ap);
 assert private.member_retention_request_terminal((select join_request_id from public.appointments where id=c.ap));
 assert not private.can_submit_appointment_review(c.ap,pg_temp.review_no_show_uid(1),clock_timestamp());
 before:=(select to_jsonb(a)from public.appointments a where id=c.ap);
 assert private.resolve_appointment_review(c.h1,c.ap,1,decision,'no_show')->>'deduplicated'='true';
 assert before=(select to_jsonb(a)from public.appointments a where id=c.ap);
 -- report 미종결은 아직 보관 차단. 최종종결이 동행판정과 자동 동기화되지 않는다.
 state:=private.member_retention_state(c.p);assert ((state->>'blocked')::boolean) is true;
 assert(select status='reviewing' and final_closed_at is null from private.member_reports where id=c.r1) is true;
 perform private.resolve_appointment_review(c.h1,c.ap,2,gen_random_uuid(),'normal');
 assert(select status='confirmed' and completed_at is null from public.appointments where id=c.ap) is true;
 assert exists(select 1 from private.completion_reservations where appointment_id=c.ap);
end;$$;
\echo PASS no-show terminal no fake completion and normal correction before due

-- 다중 hold: 마지막 normal까지 완료하지 않고 실제 최초 완료 시각/7일을 보존한다.
do $$declare c review_no_show_cases;n timestamptz;begin select *into c from review_no_show_cases where review_no_show_cases.n=2;
 perform private.resolve_appointment_review(c.h1,c.ap,1,gen_random_uuid(),'no_show');
 perform private.resolve_appointment_review(c.h1,c.ap,2,gen_random_uuid(),'normal');
 assert(select status='confirmed' and completed_at is null from public.appointments where id=c.ap) is true;
 assert private.appointment_review_held(c.ap);
 n:=clock_timestamp();perform private.resolve_appointment_review(c.h2,c.ap,1,gen_random_uuid(),'normal');
 assert(select status='completed' and completed_at>=n and review_deadline_at=completed_at+interval'7 days'from public.appointments where id=c.ap) is true;
end;$$;
\echo PASS no-show correction preserves remaining hold and first actual completion

-- 이미 완료된 동행의 노쇼 정정: 기존 시각 유지, 완료횟수/기존 후기 기여 제외 및 정상 복구.
do $$declare c review_no_show_cases;rev_before jsonb;begin select *into c from review_no_show_cases where review_no_show_cases.n=3;
 assert private.current_member_sweetness(pg_temp.review_no_show_uid(1))=(select sweetness from no_show_metric_baseline),'reviewing alone keeps prior contribution';
 perform private.resolve_appointment_review(c.h1,c.ap,1,gen_random_uuid(),'no_show');
 assert(select a.status='no_show' and a.completed_at=b.completed_at and a.completion_method=b.completion_method
 and a.completed_by_user_id is not distinct from b.completed_by_user_id and a.completion_notified_at=b.completion_notified_at
 from public.appointments a cross join no_show_completed_baseline b where a.id=c.ap) is true;
 assert(select bool_and(not private.review_finally_valid(id)and not private.is_review_public_eligible(id))from public.appointment_reviews where appointment_id=c.ap) is true;
 assert private.current_member_sweetness(pg_temp.review_no_show_uid(1))=(select sweetness-2 from no_show_metric_baseline);
 -- 사례2가 새 완료1회이므로 사례3무효 후에는 원 완료횟수와 같아야 한다.
 assert private.completed_appointment_count(pg_temp.review_no_show_uid(1))=(select completed from no_show_metric_baseline);
 assert not exists(select 1 from private.review_summary_state where profile_id in(pg_temp.review_no_show_uid(1),pg_temp.review_no_show_uid(2))and visible_summary_id is not null);
 perform private.resolve_appointment_dispute(c.ap,'actual_meetup',clock_timestamp());
 assert(select status='no_show'from public.appointments where id=c.ap) is true,'legacy normal cannot override another final no-show';
 perform private.resolve_appointment_review(c.h1,c.ap,2,gen_random_uuid(),'normal');
 assert(select a.status='completed' and a.completed_at=b.completed_at and a.completion_method=b.completion_method
 from public.appointments a cross join no_show_completed_baseline b where a.id=c.ap) is true;
 assert private.current_member_sweetness(pg_temp.review_no_show_uid(1))=(select sweetness from no_show_metric_baseline);
 assert private.completed_appointment_count(pg_temp.review_no_show_uid(1))=(select completed+1 from no_show_metric_baseline);
end;$$;
\echo PASS prior completion preserved; final no-show removes contributions/count without incidents

-- 독립 회원3/4: 최종노쇼는 회원3 탈퇴를 막지 않고 회원4는 활성 상태를 유지한다. 신고 자료 파기와 최소 종결 metadata는 분리한다.
do $$declare c review_no_show_cases;before jsonb;after jsonb;closed timestamptz;report_closed timestamptz;begin select *into c from review_no_show_cases where review_no_show_cases.n=7;
 before:=private.member_retention_state(c.p);
 perform private.resolve_appointment_review(c.h1,c.ap,1,gen_random_uuid(),'no_show');
 after:=private.member_retention_state(c.p);
 assert before->>'metadataSha256'<>after->>'metadataSha256';
 select resolved_at into closed from private.appointment_review_holds where hold_id=c.h1;
 assert (((after->>'latestClosedAt')::timestamptz)>=closed) is true;
 assert exists(select 1 from private.appointment_review_holds where hold_id=c.h1 and state='no_show');
 -- owner 최소종결 fixture: 법적 승인이나 운영 90일 경과 증거가 아니다.
 update private.member_reports set status='resolved',final_closed_at=x.n,retention_due_at=x.n+interval'2160 hours' from(select clock_timestamp() n)x where id=c.r1;
 after:=private.member_retention_state(c.p);assert not(after->>'blocked')::boolean;
 select final_closed_at into report_closed from private.member_reports where id=c.r1;
 delete from private.member_reports where id=c.r1;
 assert(select report_id is null and resolved_at=closed and report_closed_at=report_closed and state='no_show'from private.appointment_review_holds where hold_id=c.h1) is true;
 after:=private.member_retention_state(c.p);assert not(after->>'blocked')::boolean;
 assert (((after->>'latestClosedAt')::timestamptz)>=greatest(closed,report_closed)) is true;
end;$$;
-- 독립 사례8도 최종노쇼로 종결하되 다른 명시 검토는 남겨 마지막 해소를 검증한다.
do $$declare c review_no_show_cases;begin select *into c from review_no_show_cases where review_no_show_cases.n=8;
 perform private.resolve_appointment_review(c.h1,c.ap,1,gen_random_uuid(),'no_show');
 assert(select status='no_show' and completed_at is null from public.appointments where id=c.ap) is true;
end;$$;
-- 최초 탈퇴의 실제 readiness 계약을 owner 합성 단일TX에서만 준비한다. 외부 삭제 호출은0이다.
do $$declare signature text;begin
 assert(select guard=false from review_no_show_baseline) is true,'fixture requires source66 guard closed';
 foreach signature in array array['public.claim_member_cleanup_task(uuid)',
 'public.check_member_cleanup_task(uuid,uuid,uuid,uuid)','public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)',
 'public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)','public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)']loop
  assert not has_function_privilege('service_role',signature,'EXECUTE'),'fixture requires cleanup ACL closed';
  execute format('grant execute on function %s to service_role',signature);
 end loop;
 update private.member_cleanup_guard set external_deletion_approved=true where singleton;
end;$$;
set local role authenticated;
do $$begin
 perform pg_temp.review_no_show_actor(3);assert (public.retire_my_account(gen_random_uuid())->>'memberAccessRevoked'='true') is true;
end;$$;
reset role;
do $$declare signature text;begin
 update private.member_cleanup_guard set external_deletion_approved=false where singleton;
 foreach signature in array array['public.claim_member_cleanup_task(uuid)',
 'public.check_member_cleanup_task(uuid,uuid,uuid,uuid)','public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)',
 'public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)','public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)']loop
  execute format('revoke all on function %s from service_role',signature);
 end loop;
 assert(select functions=(select jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,p.proconfig)order by p.oid)
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private'))from review_no_show_catalog_baseline) is true,'cleanup ACL exact baseline restored';
end;$$;
\echo PASS final no-show permits one-party retirement; other participant remains active

-- 실제 closure RPC의 지문/1년 계산: 운영 clock·신고 원문·배치를 위조하지 않는다.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$declare c review_no_show_cases;g uuid;receipt uuid:=gen_random_uuid();request_key uuid;n timestamptz;generation_key bigint;begin
 select *into c from review_no_show_cases where review_no_show_cases.n=7;
 select join_request_id into request_key from public.appointments where id=c.ap;
 select active_generation into generation_key from private.conversation_retention where request_id=request_key;
 g:=(public.acquire_worker_run(180,null)->>'token')::uuid;assert g is not null;
 n:=clock_timestamp();
 perform private.record_member_retention_closure(c.p,request_key,receipt,n,repeat('c',64),g,generation_key);
 assert private.member_retention_receipt_current(receipt,c.p,request_key,generation_key);
 assert(select purge_after=greatest(last_activity_at,n)+interval'1 year'
 from private.conversation_retention_generations v where v.request_id=request_key and v.generation=generation_key) is true;
 -- owner 최소 metadata 변경 fixture: 오래된 closure를 최신판정으로 재사용하지 않는다.
 update private.appointment_review_holds set version=version+1 where hold_id=c.h1;
 assert not private.member_retention_receipt_current(receipt,c.p,request_key,generation_key);
 update private.appointment_review_holds set version=version-1 where hold_id=c.h1;
 assert private.member_retention_receipt_current(receipt,c.p,request_key,generation_key);
 assert public.release_worker_run(g)->>'status'='applied';
end;$$;
\echo PASS actual closure fingerprint and one-year retention with metadata invalidation

-- 사용자 확정 사례: 한 명 탈퇴한 완료전 노쇼를 정상정정 시각에 첫 실제완료 처리한다.
create temp table retired_normal_completed_snapshot(a jsonb,decision uuid);
do $$declare c review_no_show_cases;decision uuid:=gen_random_uuid();n timestamptz;after_at timestamptz;begin
 select *into c from review_no_show_cases where review_no_show_cases.n=7;n:=clock_timestamp();
 assert private.profile_retired(pg_temp.review_no_show_uid(3));assert not private.profile_retired(pg_temp.review_no_show_uid(4));
 perform private.resolve_appointment_review(c.h1,c.ap,2,decision,'normal');after_at:=clock_timestamp();
 assert(select status='completed' and completion_method='automatic' and completed_by_user_id is null
 and completed_at between n and after_at and completion_notified_at=completed_at
 and dispute_deadline_at=completed_at+interval'24 hours' and review_deadline_at=completed_at+interval'7 days'
 from public.appointments where id=c.ap) is true;
 assert not exists(select 1 from public.appointment_completion_confirmations where appointment_id=c.ap);
 assert not exists(select 1 from private.completion_reservations where appointment_id=c.ap);
 assert(select count(*)=1 from private.appointment_review_normal_completions where appointment_id=c.ap and decision_id=decision) is true;
 assert(select count(*)=1 and bool_and(recipient_id=pg_temp.review_no_show_uid(4))from public.notifications
 where join_request_id=(select join_request_id from public.appointments where id=c.ap)and kind='appointment_completed') is true;
 assert(select count(*)=2 and bool_and(r.outcome='completed' and r.origin='appointment')from private.safety_appointment_results h
 join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
 where h.appointment_id=c.ap) is true;
 insert into retired_normal_completed_snapshot select to_jsonb(a),decision from public.appointments a where id=c.ap;
 assert private.resolve_appointment_review(c.h1,c.ap,2,decision,'normal')->>'deduplicated'='true';
 assert(select to_jsonb(a)=b.a from public.appointments a cross join retired_normal_completed_snapshot b where a.id=c.ap) is true;
 assert private.completed_appointment_count(pg_temp.review_no_show_uid(4))=1;
 assert private.completed_appointment_count(pg_temp.review_no_show_uid(3))=0;
 assert(select (private.conversation_generation_state(a.join_request_id,1)->>'blocked')::boolean from public.appointments a where a.id=c.ap) is true;
end;$$;
set local role authenticated;
do $$declare c review_no_show_cases;begin select *into c from review_no_show_cases where review_no_show_cases.n=7;
 perform pg_temp.review_no_show_actor(3);
 perform pg_temp.review_no_show_failure(format('select public.submit_appointment_review(%L,5,''탈퇴 후기 금지'',''positive'',''{}'')',c.ap),'42501');
 perform pg_temp.review_no_show_actor(4);
 perform public.submit_appointment_review(c.ap,5,'합성 정상정정 후기','positive','{}');
end;$$;
reset role;
do $$declare c review_no_show_cases;begin select *into c from review_no_show_cases where review_no_show_cases.n=7;
 assert(select count(*)=1 and bool_and(reviewer_id=pg_temp.review_no_show_uid(4))from public.appointment_reviews where appointment_id=c.ap) is true;
end;$$;
\echo PASS retired normal correction creates first actual completion and active-only notices/review

-- 다른 보류가 남으면 탈퇴 프로필의 confirmed 약속을 재생성하지 않는다.
do $$declare c review_no_show_cases;n timestamptz;begin select *into c from review_no_show_cases where review_no_show_cases.n=8;
 perform private.resolve_appointment_review(c.h1,c.ap,2,gen_random_uuid(),'normal');
 assert(select status='no_show' and completed_at is null from public.appointments where id=c.ap) is true;
 assert private.appointment_review_held(c.ap);
 assert not exists(select 1 from private.appointment_review_normal_completions where appointment_id=c.ap);
 assert not exists(select 1 from private.completion_reservations where appointment_id=c.ap);
 n:=clock_timestamp();perform private.resolve_appointment_review(c.h2,c.ap,1,gen_random_uuid(),'normal');
 assert(select status='completed' and completed_at>=n and review_deadline_at=completed_at+interval'7 days'from public.appointments where id=c.ap) is true;
 assert(select count(*)=2 and bool_and(r.outcome='completed')from private.safety_appointment_results h
 join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision where h.appointment_id=c.ap) is true;
 assert not exists(select 1 from public.notifications where recipient_id=pg_temp.review_no_show_uid(3)and kind='appointment_completed');
 assert private.completed_appointment_count(pg_temp.review_no_show_uid(4))=2;
end;$$;
\echo PASS another hold delays retired normal completion until last normal decision

-- 새 helper는 owner만 호출한다. fixture 전체는 끝에서 rollback하며 외부 Auth/Storage 삭제를 호출하지 않는다.
do $$declare actor text;signature text;begin
 foreach actor in array array['anon','authenticated','service_role','yumidang_worker_queue']loop
  assert not has_table_privilege(actor,'private.appointment_review_normal_completions','SELECT,INSERT,UPDATE,DELETE');
  foreach signature in array array['private.sync_appointment_review_terminal_state(uuid)',
  'private.extend_retention_appointment_review_state(jsonb,uuid[])',
  'private.preserve_appointment_review_report_closure()']loop
   assert not has_function_privilege(actor,signature,'EXECUTE');
  end loop;
 end loop;
 assert(select (select count(*)from private.sweetness_incidents)=b.incidents from no_show_incident_baseline b) is true;
 assert(select (select count(*)from private.sweetness_incident_decisions)=b.decisions from no_show_incident_baseline b) is true;
 assert(select roles=(select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil)order by oid)from pg_roles)
 and memberships=(select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members)
 and guard=(select external_deletion_approved from private.member_cleanup_guard where singleton)
 and worker=(select to_jsonb(g)from private.global_worker_run g where singleton)from review_no_show_baseline) is true;
end;$$;
\echo PASS owner-only no automatic incident no role/guard/worker changes
rollback;
