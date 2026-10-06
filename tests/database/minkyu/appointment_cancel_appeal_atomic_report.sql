-- 민규: source76+77 원자 신고/이의 SQL 후보 회귀. 실제 SQL 실행 NOT_RUN.
-- 본인 업로드 blob·HTTP·운영 판정·실제 두 세션 경합 증거가 아니다. 전체 owner TX rollback.
-- 완료 시각 fixture는 owner가 과거 일정으로 조정하며 실제 DB 시계·서버 수신 시각은 변경하지 않는다.
begin;
set local plpgsql.check_asserts=on;
create temp table atomic_appeal_baseline as select
 (select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil)order by oid)from pg_roles)roles,
 (select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members)memberships,
 (select external_deletion_approved from private.member_cleanup_guard where singleton)guard,
 (select to_jsonb(g)from private.global_worker_run g where singleton)worker;
set local storage.allow_delete_query='true';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[]) on conflict(id) do nothing;
create function pg_temp.atomic_appeal_uid(n integer) returns uuid language sql immutable as $$
 select ('fd910000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.atomic_appeal_session(n integer) returns uuid language sql immutable as $$
 select ('fd920000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.atomic_appeal_actor(n integer) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.atomic_appeal_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.atomic_appeal_uid(n),'session_id',pg_temp.atomic_appeal_session(n))::text,true);
end;$$;
create function pg_temp.atomic_appeal_failure(command text,expected text) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('expected %s, actual %s',expected,code);
end;$$;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.resolve_naver_account('change-atomic_appeal-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;end;$$;
reset role;
insert into auth.users(id,email) select pg_temp.atomic_appeal_uid(i),a.auth_email from generate_series(1,4)i
 join private.naver_accounts a on a.subject='change-atomic_appeal-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.atomic_appeal_session(i),pg_temp.atomic_appeal_uid(i) from generate_series(1,4)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.atomic_appeal_uid(i)::text||'/fd930000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.atomic_appeal_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,4)i;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.record_naver_session('change-atomic_appeal-sql-'||i,pg_temp.atomic_appeal_uid(i),pg_temp.atomic_appeal_session(i));end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..4 loop
 perform pg_temp.atomic_appeal_actor(i);
 assert public.complete_naver_signup(pg_temp.atomic_appeal_uid(i)::text||'/fd930000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
end loop;end;$$;
reset role;

create temp table atomic_appeal_general_baseline as select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]'::jsonb)fingerprint from private.safety_appeals a where kind='general';
create temp table atomic_appeal_cases(n integer primary key,post_id uuid,appointment_id uuid,report_id uuid,request_id uuid,initial_revision bigint,result jsonb);
grant all on atomic_appeal_cases to authenticated;
set local role authenticated;
do $$declare i integer;p uuid;j uuid;a uuid;conditions jsonb;rid uuid;begin
 for i in 1..8 loop
 p:=gen_random_uuid();perform pg_temp.atomic_appeal_actor(1);
 perform public.create_service_post(p,jsonb_build_object('title','합성 취소 이의','description','로컬 합성 검증','category','산책',
 'startsAt',clock_timestamp()+make_interval(days=>i*3),'endsAt',clock_timestamp()+make_interval(days=>i*3,hours=>2),
 'recruitmentEndsAt',clock_timestamp()+make_interval(days=>i*3,hours=>-1),'publicArea','서울특별시 강남구 역삼동',
 'registeredPlaceName','합성 장소','registeredAddress','서울특별시 강남구 합성주소','meetingDetail','합성 입구',
 'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0));
 perform pg_temp.atomic_appeal_actor(2);j:=(public.request_service_post(p,gen_random_uuid(),'합성 신청')->>'id')::uuid;
 perform pg_temp.atomic_appeal_actor(1);conditions:=public.propose_match(j);
 perform pg_temp.atomic_appeal_actor(2);a:=(public.accept_match(j,conditions->>'conditionVersion')->>'appointmentId')::uuid;
 perform pg_temp.atomic_appeal_actor(1);perform public.cancel_appointment(a,gen_random_uuid(),'합성 이의 사유');
 rid:=(public.submit_member_report(gen_random_uuid(),'appointment',a,'offline',array['other'],'합성 취소 사유','{}',false)->>'reportId')::uuid;
 insert into atomic_appeal_cases(n,post_id,appointment_id,report_id,request_id)values(i,p,a,rid,gen_random_uuid());
 end loop;
end;$$;
reset role;
update atomic_appeal_cases case_row set initial_revision=head.current_revision from private.safety_appointment_results head join private.member_episodes ep on ep.id=head.source_episode_id
 where case_row.appointment_id=head.appointment_id and ep.profile_id=pg_temp.atomic_appeal_uid(1);
create temp table atomic_appeal_original as select head.identity_id,head.appointment_id,head.source_episode_id,head.agreed_starts_at,head.confirmed_at,cancel_row.cancelled_at
 from private.safety_appointment_results head join private.member_episodes ep on ep.id=head.source_episode_id join private.appointment_cancellations cancel_row on cancel_row.appointment_id=head.appointment_id
 where ep.profile_id=pg_temp.atomic_appeal_uid(1)and head.appointment_id in(select appointment_id from atomic_appeal_cases);
-- 앞선 원신고는 독립 포트 충돌 검사 자료다. 원자 제출은 별도 request key를 쓴다.
create function pg_temp.atomic_appeal_call(p_case_number integer,p_expected bigint default null,p_description text default '합성 원자 접수',p_assets uuid[]default '{}',p_hide boolean default false,p_request uuid default null)
returns jsonb language sql as $$select public.submit_appointment_cancel_appeal_with_report(case_row.appointment_id,coalesce(p_request,case_row.request_id),coalesce(p_expected,case_row.initial_revision),array['other'],p_description,p_assets,p_hide)
 from atomic_appeal_cases case_row where case_row.n=p_case_number;$$;
create function pg_temp.atomic_appeal_snapshot()returns jsonb language sql as $$select jsonb_build_object(
 'reports',(select coalesce(jsonb_agg(to_jsonb(r)order by id),'[]')from private.member_reports r),
 'details',(select coalesce(jsonb_agg(to_jsonb(d)order by report_id),'[]')from private.member_report_details d),
 'assets',(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]')from private.report_capture_assets a),
 'audit',(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]')from private.report_access_audit a),
 'appeals',(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]')from private.safety_appeals a),
 'receipts',(select coalesce(jsonb_agg(to_jsonb(r)order by client_request_id),'[]')from private.appointment_cancel_appeal_receipts r),
 'bindings',(select coalesce(jsonb_agg(to_jsonb(b)order by client_request_id),'[]')from private.appointment_cancel_appeal_report_bindings b),
 'heads',(select coalesce(jsonb_agg(to_jsonb(h)order by identity_id,appointment_id),'[]')from private.safety_appointment_results h),
 'revisions',(select coalesce(jsonb_agg(to_jsonb(r)order by identity_id,appointment_id,revision),'[]')from private.safety_appointment_result_revisions r),
 'storage',(select coalesce(jsonb_agg(to_jsonb(o)order by id),'[]')from storage.objects o),
 'sanctions',(select coalesce(jsonb_agg(to_jsonb(s)order by id),'[]')from private.safety_sanction_applications s));$$;
set local role authenticated;select pg_temp.atomic_appeal_actor(1);
do $$declare response jsonb;begin
 response:=pg_temp.atomic_appeal_call(1);assert(select count(*)from jsonb_object_keys(response))=10;
 assert response->>'state'='reviewing'and response->'alreadyApplied'='false'::jsonb and response->'resolvedAt'='null'::jsonb;
 assert(response->>'receivedAt')::timestamptz<(response->>'deadlineAt')::timestamptz;
 update atomic_appeal_cases set result=response where n=1;
 assert pg_temp.atomic_appeal_call(1)=response||jsonb_build_object('alreadyApplied',true);
 perform pg_temp.atomic_appeal_failure('select pg_temp.atomic_appeal_call(1,null,''수정된 설명'')','40001');
 perform pg_temp.atomic_appeal_failure('select pg_temp.atomic_appeal_call(1,null,''합성 원자 접수'',''{}'',true)','40001');
 perform pg_temp.atomic_appeal_failure('select pg_temp.atomic_appeal_call(1,999)','40001');
 perform pg_temp.atomic_appeal_failure('select pg_temp.atomic_appeal_call(1,null,''합성 원자 접수'',''{}'',false,gen_random_uuid())','55000');
end;$$;
select pg_temp.atomic_appeal_actor(2);
select pg_temp.atomic_appeal_failure('select pg_temp.atomic_appeal_call(2)','PT404');reset role;
do $$begin
 assert(select count(*)from private.appointment_cancel_appeal_report_bindings)=1;
 assert(select count(*)from private.safety_appeals)=1;
 assert exists(select 1 from private.member_reports r join private.member_report_details d on d.report_id=r.id where r.id=(select(result->>'reportId')::uuid from atomic_appeal_cases where n=1)
 and r.reporter_id=pg_temp.atomic_appeal_uid(1)and r.target_type='appointment'and r.context='offline'and d.description='합성 원자 접수');
 assert not exists(select 1 from private.safety_sanction_applications);
end;$$;
-- 첨부는 예약/업로드 metadata로 준비한다. 실제 Storage bytes 업로드 증거가 아니다.
create temp table atomic_appeal_asset(id uuid primary key);insert into atomic_appeal_asset values(gen_random_uuid());grant select on atomic_appeal_asset to authenticated;
set local role authenticated;select pg_temp.atomic_appeal_actor(1);
select public.reserve_report_capture((select id from atomic_appeal_asset),'jpg');reset role;
insert into storage.objects(bucket_id,name,owner_id,metadata)select 'report-evidence',pg_temp.atomic_appeal_uid(1)::text||'/'||id::text||'.jpg',pg_temp.atomic_appeal_uid(1)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from atomic_appeal_asset;
set local role authenticated;select pg_temp.atomic_appeal_actor(1);select public.confirm_report_capture((select id from atomic_appeal_asset));reset role;
create temp table atomic_appeal_failure_snapshot as select pg_temp.atomic_appeal_snapshot()value;
-- report/details/첨부 전이를 진행해도 후속 CAS 실패면 모두 원복한다. 준비 파일/첨부는 uploaded로 남는다.
set local role authenticated;select pg_temp.atomic_appeal_actor(1);
select pg_temp.atomic_appeal_failure('select pg_temp.atomic_appeal_call(2,999,''합성 원자 접수'',array[(select id from atomic_appeal_asset)],true)','40001');reset role;
do $$begin assert pg_temp.atomic_appeal_snapshot()=(select value from atomic_appeal_failure_snapshot);
 assert(select state from private.report_capture_assets where id=(select id from atomic_appeal_asset))='uploaded';end;$$;
-- 같은 outer statement 안에서 마감 =/1µs 이후/1µs 이전을 검증한다. DB 시계는 바꾸지 않는다.
do $$declare case_number integer;deadline_offset interval;before_snapshot jsonb;response jsonb;begin
 for case_number in select unnest(array[3,7,8])loop
 deadline_offset:=case case_number when 3 then interval '0 microseconds'when 7 then interval '-1 microsecond'else interval '1 microsecond'end;
 update private.appointment_cancellations set cancelled_at=statement_timestamp()-interval '24 hours'+deadline_offset
  where appointment_id=(select appointment_id from atomic_appeal_cases where n=case_number);
 update private.safety_appointment_result_revisions revision_row set cancellation_at=cancel_row.cancelled_at
  from private.appointment_cancellations cancel_row where revision_row.appointment_id=cancel_row.appointment_id
  and revision_row.appointment_id=(select appointment_id from atomic_appeal_cases where n=case_number)and revision_row.outcome='own_cancel';
 before_snapshot:=pg_temp.atomic_appeal_snapshot();
 execute 'set local role authenticated';perform pg_temp.atomic_appeal_actor(1);
 if case_number=8 then
  response:=pg_temp.atomic_appeal_call(case_number);
  assert(response->>'receivedAt')::timestamptz=statement_timestamp();
  assert(response->>'deadlineAt')::timestamptz=statement_timestamp()+interval '1 microsecond';
  update atomic_appeal_cases set result=response where n=case_number;
 else
  perform pg_temp.atomic_appeal_failure(format('select pg_temp.atomic_appeal_call(%s,null,''합성 원자 접수'',array[(select id from atomic_appeal_asset)],true)',case_number),'22023');
 end if;
 execute 'reset role';
 if case_number<>8 then assert pg_temp.atomic_appeal_snapshot()=before_snapshot;
  assert(select state from private.report_capture_assets where id=(select id from atomic_appeal_asset))='uploaded';
 else assert exists(select 1 from private.appointment_cancel_appeal_report_bindings where client_request_id=(select request_id from atomic_appeal_cases where n=case_number));end if;
 end loop;
end;$$;
-- report 독립 request를 원자 wrapper 성공으로 채택하지 않는다.
set local role authenticated;select pg_temp.atomic_appeal_actor(1);
reset role;
-- owner가 독립 신고 request key만 temp fixture로 전달한다.
create temp table atomic_appeal_conflict_request as select client_request_id from private.member_reports where id=(select report_id from atomic_appeal_cases where n=4);grant select on atomic_appeal_conflict_request to authenticated;
set local role authenticated;select pg_temp.atomic_appeal_actor(1);
select pg_temp.atomic_appeal_failure('select pg_temp.atomic_appeal_call(4,null,''합성 원자 접수'',''{}'',false,(select client_request_id from atomic_appeal_conflict_request))','40001');reset role;
-- 사유 배열 순서만 바뀌면 정규화 hash가 같으며 원응답을 재사용한다.
set local role authenticated;select pg_temp.atomic_appeal_actor(1);
do $$declare case_row atomic_appeal_cases;response jsonb;begin
 select *into case_row from atomic_appeal_cases where n=4;
 response:=public.submit_appointment_cancel_appeal_with_report(case_row.appointment_id,case_row.request_id,case_row.initial_revision,array['other','no_show'],'합성 원자 접수','{}',false);
 assert public.submit_appointment_cancel_appeal_with_report(case_row.appointment_id,case_row.request_id,case_row.initial_revision,array['no_show','other'],'합성 원자 접수','{}',false)=response||jsonb_build_object('alreadyApplied',true);
end;$$;reset role;
-- 첨부가 정당하게 붙는 정상 원자 제출. 이후 재시도는 첨부를 재첨부하지 않는다.
set local role authenticated;select pg_temp.atomic_appeal_actor(1);
do $$declare response jsonb;begin response:=pg_temp.atomic_appeal_call(2,null,'합성 원자 접수',array[(select id from atomic_appeal_asset)],true);
 update atomic_appeal_cases set result=response where n=2;
 assert pg_temp.atomic_appeal_call(2,null,'합성 원자 접수',array[(select id from atomic_appeal_asset)],true)=response||jsonb_build_object('alreadyApplied',true);end;$$;reset role;
do $$begin assert(select state from private.report_capture_assets where id=(select id from atomic_appeal_asset))='attached';
 assert(select hide_target from private.member_reports where id=(select(result->>'reportId')::uuid from atomic_appeal_cases where n=2));end;$$;
-- binding INSERT 대기 후 session clock 만료는 report+appeal+binding 전체를 원복한다.
create function pg_temp.atomic_appeal_expire_session()returns trigger language plpgsql as $$begin
 update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=pg_temp.atomic_appeal_session(1);return new;end;$$;
create trigger test_atomic_appeal_session after insert on private.appointment_cancel_appeal_report_bindings for each row execute function pg_temp.atomic_appeal_expire_session();
update atomic_appeal_failure_snapshot set value=pg_temp.atomic_appeal_snapshot();
set local role authenticated;select pg_temp.atomic_appeal_actor(1);
select pg_temp.atomic_appeal_failure('select pg_temp.atomic_appeal_call(5)','28000');reset role;
drop trigger test_atomic_appeal_session on private.appointment_cancel_appeal_report_bindings;
do $$begin assert pg_temp.atomic_appeal_snapshot()=(select value from atomic_appeal_failure_snapshot);assert(select not_after is null from auth.sessions where id=pg_temp.atomic_appeal_session(1));end;$$;
update private.naver_accounts set verification_status='information_required'where user_id=pg_temp.atomic_appeal_uid(1);
set local role authenticated;select pg_temp.atomic_appeal_actor(1);
do $$begin assert pg_temp.atomic_appeal_call(1)->'alreadyApplied'='true'::jsonb;end;$$;reset role;
update private.naver_accounts set verification_status='qualified'where user_id=pg_temp.atomic_appeal_uid(1);
-- 상세 만료는 원 성공에도 PT404이며 다시 만들지 않는다. 실제 종결 handler는 아닌 owner fixture다.
update private.safety_appeals set state='rejected',resolved_at=clock_timestamp()where id=(select(result->>'appealId')::uuid from atomic_appeal_cases where n=1);
with t as(select clock_timestamp()-interval'1 second'due)update private.member_reports set status='resolved',final_closed_at=t.due-interval'2160 hours',retention_due_at=t.due from t where id=(select(result->>'reportId')::uuid from atomic_appeal_cases where n=1);
update atomic_appeal_failure_snapshot set value=pg_temp.atomic_appeal_snapshot();
set local role authenticated;select pg_temp.atomic_appeal_actor(1);
select pg_temp.atomic_appeal_failure('select pg_temp.atomic_appeal_call(1)','PT404');reset role;
do $$begin assert pg_temp.atomic_appeal_snapshot()=(select value from atomic_appeal_failure_snapshot);end;$$;
-- 원report 파기와 binding 수명은 같지만 최소 결과는 별도다. 원문 없는 최소 결과로 새 접수를 추정하지 않는다.
update private.safety_appeals set state='accepted',resolved_at=clock_timestamp()where id=(select(result->>'appealId')::uuid from atomic_appeal_cases where n=1);
update private.safety_appointment_result_revisions set outcome='exempt',cancellation_at=null,appeal_state='none',origin='operator'
 where appointment_id=(select appointment_id from atomic_appeal_cases where n=1)and appeal_state='reviewing';
delete from private.member_reports where id=(select(result->>'reportId')::uuid from atomic_appeal_cases where n=1);
update atomic_appeal_failure_snapshot set value=pg_temp.atomic_appeal_snapshot();
set local role authenticated;select pg_temp.atomic_appeal_actor(1);
select pg_temp.atomic_appeal_failure('select pg_temp.atomic_appeal_call(1)','40001');
select pg_temp.atomic_appeal_failure('select pg_temp.atomic_appeal_call(1,(select(result->>''resultRevision'')::bigint from atomic_appeal_cases where n=1))','55000');
select pg_temp.atomic_appeal_failure('select pg_temp.atomic_appeal_call(6,null,''합성 원자 접수'',array[gen_random_uuid()])','42501');reset role;
do $$begin assert pg_temp.atomic_appeal_snapshot()=(select value from atomic_appeal_failure_snapshot);
 assert exists(select 1 from private.safety_appointment_result_revisions where appointment_id=(select appointment_id from atomic_appeal_cases where n=1)and outcome='exempt');
 assert not exists(select 1 from private.appointment_cancel_appeal_report_bindings where client_request_id=(select request_id from atomic_appeal_cases where n=1));end;$$;
-- private raw binding/함수 ACL 및 역할·worker/guard 불변.
do $$declare role_name text;begin
 foreach role_name in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
 assert has_function_privilege(role_name,'public.submit_appointment_cancel_appeal_with_report(uuid,uuid,bigint,text[],text,uuid[],boolean)','EXECUTE')=(role_name='authenticated');
 assert not has_table_privilege(role_name,'private.appointment_cancel_appeal_report_bindings','SELECT');end loop;
 assert(select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil)order by oid)from pg_roles)=(select roles from atomic_appeal_baseline);
 assert(select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members)is not distinct from(select memberships from atomic_appeal_baseline);
 assert not exists(select 1 from private.safety_sanction_applications);
 assert(select external_deletion_approved from private.member_cleanup_guard where singleton)=(select guard from atomic_appeal_baseline);
 assert(select to_jsonb(g)from private.global_worker_run g where singleton)=(select worker from atomic_appeal_baseline);
end;$$;
rollback;
