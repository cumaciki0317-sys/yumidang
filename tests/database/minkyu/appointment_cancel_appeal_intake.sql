-- 민규: source75+76 본인 취소 이의 SQL 후보 회귀. 실제 SQL 실행 NOT_RUN.
-- 본인 업로드 blob·HTTP·운영 판정·실제 두 세션 경합 증거가 아니다. 전체 owner TX rollback.
-- 완료 시각 fixture는 owner가 과거 일정으로 조정하며 실제 DB 시계·서버 수신 시각은 변경하지 않는다.
begin;
set local plpgsql.check_asserts=on;
create temp table cancel_appeal_baseline as select
 (select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil)order by oid)from pg_roles)roles,
 (select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members)memberships,
 (select external_deletion_approved from private.member_cleanup_guard where singleton)guard,
 (select to_jsonb(g)from private.global_worker_run g where singleton)worker;
set local storage.allow_delete_query='true';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[]) on conflict(id) do nothing;
create function pg_temp.cancel_appeal_uid(n integer) returns uuid language sql immutable as $$
 select ('fc910000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.cancel_appeal_session(n integer) returns uuid language sql immutable as $$
 select ('fc920000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.cancel_appeal_actor(n integer) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.cancel_appeal_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.cancel_appeal_uid(n),'session_id',pg_temp.cancel_appeal_session(n))::text,true);
end;$$;
create function pg_temp.cancel_appeal_failure(command text,expected text) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('expected %s, actual %s',expected,code);
end;$$;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.resolve_naver_account('change-cancel_appeal-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;end;$$;
reset role;
insert into auth.users(id,email) select pg_temp.cancel_appeal_uid(i),a.auth_email from generate_series(1,4)i
 join private.naver_accounts a on a.subject='change-cancel_appeal-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.cancel_appeal_session(i),pg_temp.cancel_appeal_uid(i) from generate_series(1,4)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.cancel_appeal_uid(i)::text||'/fc930000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.cancel_appeal_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,4)i;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.record_naver_session('change-cancel_appeal-sql-'||i,pg_temp.cancel_appeal_uid(i),pg_temp.cancel_appeal_session(i));end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..4 loop
 perform pg_temp.cancel_appeal_actor(i);
 assert public.complete_naver_signup(pg_temp.cancel_appeal_uid(i)::text||'/fc930000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
end loop;end;$$;
reset role;

create temp table cancel_appeal_general_baseline as select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]'::jsonb)fingerprint from private.safety_appeals a where kind='general';
create temp table cancel_appeal_cases(n integer primary key,post_id uuid,appointment_id uuid,report_id uuid,request_id uuid,initial_revision bigint,result jsonb);
grant all on cancel_appeal_cases to authenticated;
set local role authenticated;
do $$declare i integer;p uuid;j uuid;a uuid;conditions jsonb;rid uuid;begin
 for i in 1..8 loop
 p:=gen_random_uuid();perform pg_temp.cancel_appeal_actor(1);
 perform public.create_service_post(p,jsonb_build_object('title','합성 취소 이의','description','로컬 합성 검증','category','산책',
 'startsAt',clock_timestamp()+make_interval(days=>i*3),'endsAt',clock_timestamp()+make_interval(days=>i*3,hours=>2),
 'recruitmentEndsAt',clock_timestamp()+make_interval(days=>i*3,hours=>-1),'publicArea','서울특별시 강남구 역삼동',
 'registeredPlaceName','합성 장소','registeredAddress','서울특별시 강남구 합성주소','meetingDetail','합성 입구',
 'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0));
 perform pg_temp.cancel_appeal_actor(2);j:=(public.request_service_post(p,gen_random_uuid(),'합성 신청')->>'id')::uuid;
 perform pg_temp.cancel_appeal_actor(1);conditions:=public.propose_match(j);
 perform pg_temp.cancel_appeal_actor(2);a:=(public.accept_match(j,conditions->>'conditionVersion')->>'appointmentId')::uuid;
 perform pg_temp.cancel_appeal_actor(1);perform public.cancel_appointment(a,gen_random_uuid(),'합성 이의 사유');
 rid:=(public.submit_member_report(gen_random_uuid(),'appointment',a,'offline',array['other'],'합성 취소 사유','{}',false)->>'reportId')::uuid;
 insert into cancel_appeal_cases(n,post_id,appointment_id,report_id,request_id)values(i,p,a,rid,gen_random_uuid());
 end loop;
end;$$;
reset role;
update cancel_appeal_cases case_row set initial_revision=head.current_revision from private.safety_appointment_results head join private.member_episodes ep on ep.id=head.source_episode_id
 where case_row.appointment_id=head.appointment_id and ep.profile_id=pg_temp.cancel_appeal_uid(1);
create temp table cancel_appeal_original as select head.identity_id,head.appointment_id,head.source_episode_id,head.agreed_starts_at,head.confirmed_at,cancel_row.cancelled_at
 from private.safety_appointment_results head join private.member_episodes ep on ep.id=head.source_episode_id join private.appointment_cancellations cancel_row on cancel_row.appointment_id=head.appointment_id
 where ep.profile_id=pg_temp.cancel_appeal_uid(1)and head.appointment_id in(select appointment_id from cancel_appeal_cases);
create function pg_temp.cancel_appeal_call(n integer,expected bigint default null,request uuid default null,report uuid default null)returns jsonb language sql as $$
 select public.submit_appointment_cancel_appeal(case_row.appointment_id,coalesce(request,case_row.request_id),coalesce(expected,case_row.initial_revision),coalesce(report,case_row.report_id))from cancel_appeal_cases case_row where case_row.n=$1;$$;
create function pg_temp.cancel_appeal_snapshot()returns jsonb language sql as $$
 select jsonb_build_object('appeals',(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]')from private.safety_appeals a),
 'receipts',(select coalesce(jsonb_agg(to_jsonb(r)order by client_request_id),'[]')from private.appointment_cancel_appeal_receipts r),
 'heads',(select coalesce(jsonb_agg(to_jsonb(h)order by identity_id,appointment_id),'[]')from private.safety_appointment_results h),
 'revisions',(select coalesce(jsonb_agg(to_jsonb(r)order by identity_id,appointment_id,revision),'[]')from private.safety_appointment_result_revisions r),
 'effects',(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]')from private.safety_sanction_applications a));$$;
-- absent 조회도 실제 본인 취소 관계를 검사한다. 상대 존재/귀책을 공개하지 않는다.
set local role authenticated;
select pg_temp.cancel_appeal_actor(1);
do $$declare item jsonb;begin
 item:=public.get_my_appointment_cancel_appeal((select appointment_id from cancel_appeal_cases where n=1));
 assert(select count(*)from jsonb_object_keys(item))=8;
 assert item->'appealId'='null'::jsonb and item->'state'='null'::jsonb and item->'receivedAt'='null'::jsonb and item->'resolvedAt'='null'::jsonb;
 assert(item->>'deadlineAt')::timestamptz=(item->>'cancelledAt')::timestamptz+interval'24 hours';
end;$$;
select pg_temp.cancel_appeal_actor(2);
select pg_temp.cancel_appeal_failure(format('select public.get_my_appointment_cancel_appeal(%L)',(select appointment_id from cancel_appeal_cases where n=1)),'PT404');
select pg_temp.cancel_appeal_actor(1);
do $$declare item jsonb;begin
 item:=pg_temp.cancel_appeal_call(1);assert(select count(*)from jsonb_object_keys(item))=9;
 assert item->>'state'='reviewing'and item->'alreadyApplied'='false'::jsonb and item->'resolvedAt'='null'::jsonb;
 assert(item->>'receivedAt')::timestamptz<(item->>'deadlineAt')::timestamptz;
 update cancel_appeal_cases set result=item where n=1;
 assert pg_temp.cancel_appeal_call(1)=item||jsonb_build_object('alreadyApplied',true);
 perform pg_temp.cancel_appeal_failure(format('select pg_temp.cancel_appeal_call(1,%s)',(select initial_revision+1 from cancel_appeal_cases where n=1)),'40001');
 perform pg_temp.cancel_appeal_failure('select pg_temp.cancel_appeal_call(1,null,null,(select report_id from cancel_appeal_cases where n=2))','40001');
 perform pg_temp.cancel_appeal_failure('select pg_temp.cancel_appeal_call(1,null,gen_random_uuid())','55000');
 perform pg_temp.cancel_appeal_failure('select pg_temp.cancel_appeal_call(2,0)','22023');
 perform pg_temp.cancel_appeal_failure('select pg_temp.cancel_appeal_call(2,9007199254740991)','22023');
 perform pg_temp.cancel_appeal_failure('select pg_temp.cancel_appeal_call(2,999)','40001');
 perform pg_temp.cancel_appeal_failure('select pg_temp.cancel_appeal_call(3,null,null,(select report_id from cancel_appeal_cases where n=4))','PT404');
end;$$;
reset role;
do $$declare source_row record;current_row record;begin
 assert(select count(*)from private.safety_appeals)=1;assert(select count(*)from private.appointment_cancel_appeal_receipts)=1;
 assert not exists(select 1 from private.safety_sanction_applications);
 for source_row in select *from cancel_appeal_original loop
 select head.source_episode_id,head.agreed_starts_at,head.confirmed_at,cancel_row.cancelled_at into current_row from private.safety_appointment_results head join private.appointment_cancellations cancel_row on cancel_row.appointment_id=head.appointment_id where head.identity_id=source_row.identity_id and head.appointment_id=source_row.appointment_id;
 assert current_row.source_episode_id=source_row.source_episode_id and current_row.agreed_starts_at=source_row.agreed_starts_at and current_row.confirmed_at=source_row.confirmed_at and current_row.cancelled_at=source_row.cancelled_at;
 end loop;
 assert(select appeal_state from private.safety_appointment_result_revisions where appointment_id=(select appointment_id from cancel_appeal_cases where n=1)and appeal_state='reviewing')='reviewing';
 assert private.cancellation_sanction_plan((select identity_id from private.member_episodes where profile_id=pg_temp.cancel_appeal_uid(1)and ended_at is null))->>'status'='held';
 perform pg_temp.cancel_appeal_failure('delete from private.member_reports where id=(select report_id from cancel_appeal_cases where n=1)','55000');
 perform pg_temp.cancel_appeal_failure('update private.member_reports set status=''resolved'',final_closed_at=clock_timestamp(),retention_due_at=clock_timestamp()+interval''2160 hours''where id=(select report_id from cancel_appeal_cases where n=1)','55000');
end;$$;
-- DB 접수 경계의 exact equal/late/early. DB clock 자체는 변경하지 않는다.
create function pg_temp.cancel_appeal_age(p_case_number integer,p_offset_value interval)returns void language plpgsql as $$begin
 update private.appointment_cancellations set cancelled_at=statement_timestamp()-interval'24 hours'+p_offset_value where appointment_id=(select case_row.appointment_id from cancel_appeal_cases case_row where case_row.n=p_case_number);
 update private.safety_appointment_result_revisions set cancellation_at=statement_timestamp()-interval'24 hours'+p_offset_value where appointment_id=(select case_row.appointment_id from cancel_appeal_cases case_row where case_row.n=p_case_number)and outcome='own_cancel';
end;$$;
do $$begin
 perform pg_temp.cancel_appeal_age(2,interval'0 seconds');perform pg_temp.cancel_appeal_actor(1);set local role authenticated;
 perform pg_temp.cancel_appeal_failure('select pg_temp.cancel_appeal_call(2)','22023');reset role;
 perform pg_temp.cancel_appeal_age(2,interval'-1 microsecond');set local role authenticated;
 perform pg_temp.cancel_appeal_failure('select pg_temp.cancel_appeal_call(2)','22023');reset role;
 perform pg_temp.cancel_appeal_age(2,interval'1 microsecond');set local role authenticated;
 update cancel_appeal_cases set result=pg_temp.cancel_appeal_call(2)where n=2;assert(select result->>'state'from cancel_appeal_cases where n=2)='reviewing';reset role;
end;$$;
-- INSERT 대기 뒤 새 session 검사가 실패하면 appeal/revision/receipt가 전부 원복한다.
create function pg_temp.cancel_appeal_expire_session()returns trigger language plpgsql as $$begin
 update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=pg_temp.cancel_appeal_session(1);return new;end;$$;
create trigger test_cancel_appeal_session after insert on private.appointment_cancel_appeal_receipts for each row execute function pg_temp.cancel_appeal_expire_session();
create temp table cancel_appeal_before_failure as select pg_temp.cancel_appeal_snapshot()value;
set local role authenticated;select pg_temp.cancel_appeal_actor(1);
select pg_temp.cancel_appeal_failure('select pg_temp.cancel_appeal_call(3)','28000');reset role;
drop trigger test_cancel_appeal_session on private.appointment_cancel_appeal_receipts;
do $$begin assert pg_temp.cancel_appeal_snapshot()=(select value from cancel_appeal_before_failure);assert(select not_after is null from auth.sessions where id=pg_temp.cancel_appeal_session(1));end;$$;
-- 신규 신청이 없는 상태에서도 본인 관리 권한은 자격 누락으로 막지 않는다.
update private.naver_accounts set verification_status='information_required'where user_id=pg_temp.cancel_appeal_uid(1);
set local role authenticated;select pg_temp.cancel_appeal_actor(1);
do $$begin assert public.get_my_appointment_cancel_appeal((select appointment_id from cancel_appeal_cases where n=1))->>'state'='reviewing';end;$$;
reset role;update private.naver_accounts set verification_status='qualified'where user_id=pg_temp.cancel_appeal_uid(1);
-- exact early 접수의 원래 deadline은 이미 지났지만 replay는 접수 성공 사실을 반환한다.
set local role authenticated;select pg_temp.cancel_appeal_actor(1);
do $$begin assert pg_temp.cancel_appeal_call(2)=(select result||jsonb_build_object('alreadyApplied',true)from cancel_appeal_cases where n=2);end;$$;reset role;
-- MAXSAFE-1 결과원장 CAS→MAXSAFE. owner metadata 경계이며 실제 정책 사건을 새로 만들지 않는다.
update private.safety_appointment_result_revisions set revision=9007199254740990 where appointment_id=(select appointment_id from cancel_appeal_cases where n=5)and outcome='own_cancel';
update private.safety_appointment_results set current_revision=9007199254740990 where appointment_id=(select appointment_id from cancel_appeal_cases where n=5)and source_episode_id=(select id from private.member_episodes where profile_id=pg_temp.cancel_appeal_uid(1)and ended_at is null);
update cancel_appeal_cases set initial_revision=9007199254740990 where n=5;
set local role authenticated;select pg_temp.cancel_appeal_actor(1);
do $$begin assert(pg_temp.cancel_appeal_call(5)->>'resultRevision')::bigint=9007199254740991;end;$$;reset role;
-- TTL 만료/최종 종결은 owner 합성 fixture다. accepted/rejected 운영 handler의 증거가 아니다.
update private.safety_appeals set state='rejected',resolved_at=clock_timestamp()where appointment_id=(select appointment_id from cancel_appeal_cases where n=2);
with times as(select clock_timestamp()-interval'1 second'as due)update private.member_reports set status='resolved',final_closed_at=times.due-interval'2160 hours',retention_due_at=times.due from times where id=(select report_id from cancel_appeal_cases where n=2);
set local role authenticated;select pg_temp.cancel_appeal_actor(1);
select pg_temp.cancel_appeal_failure('select pg_temp.cancel_appeal_call(2)','PT404');
select pg_temp.cancel_appeal_failure('select public.get_my_appointment_cancel_appeal((select appointment_id from cancel_appeal_cases where n=2))','PT404');reset role;
-- accepted-exempt는 원문report 수명과 독립이다. 합성owner 최소결과를 등록하고 report CASCADE 뒤 보존을 검사한다.
update private.safety_appeals set state='accepted',resolved_at=clock_timestamp()where appointment_id=(select appointment_id from cancel_appeal_cases where n=2);
update private.safety_appointment_result_revisions set outcome='exempt',cancellation_at=null,appeal_state='none',origin='operator'where appointment_id=(select appointment_id from cancel_appeal_cases where n=2)and appeal_state='reviewing';
set local role authenticated;select pg_temp.cancel_appeal_actor(1);
-- 만료 보관 상세의 replay는 accepted가 되어도 거절한다.
select pg_temp.cancel_appeal_failure('select pg_temp.cancel_appeal_call(2)','PT404');reset role;
delete from private.member_reports where id=(select report_id from cancel_appeal_cases where n=2);
do $$begin assert not exists(select 1 from private.safety_appeals where appointment_id=(select appointment_id from cancel_appeal_cases where n=2));assert exists(select 1 from private.safety_appointment_result_revisions where appointment_id=(select appointment_id from cancel_appeal_cases where n=2)and outcome='exempt');end;$$;
-- 보관 후 no-appeal은 상세 부재를 뜻한다. 최소 exempt 결과와 원 cancellation 사실은 그대로 조회한다.
set local role authenticated;select pg_temp.cancel_appeal_actor(1);
do $$declare item jsonb;begin item:=public.get_my_appointment_cancel_appeal((select appointment_id from cancel_appeal_cases where n=2));
 assert item->'appealId'='null'::jsonb and item->'state'='null'::jsonb;assert item->>'cancelledAt'is not null;
 assert(item->>'resultRevision')::bigint=(select initial_revision+1 from cancel_appeal_cases where n=2);end;$$;reset role;
-- 기존 general 집합의 지문 및 nullable 열을 검사한다. 일반 이의 handler의 검증은 아니다.
do $$begin
 assert(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]'::jsonb)from private.safety_appeals a where kind='general')=(select fingerprint from cancel_appeal_general_baseline);
 assert(select count(*)from pg_attribute where attrelid='private.safety_appeals'::regclass and attname in('report_id','source_episode_id')and not attnotnull)=2;
end;$$;
-- 종료회차 및 새회차로 과거취소 접수 권한을 복원하지 않는다.
create temp table cancel_appeal_old_episode as select id,identity_id from private.member_episodes where profile_id=pg_temp.cancel_appeal_uid(1)and ended_at is null;
update private.member_episodes set ended_at=clock_timestamp()where id in(select id from cancel_appeal_old_episode);
insert into private.member_episodes(profile_id,identity_id)select pg_temp.cancel_appeal_uid(1),identity_id from cancel_appeal_old_episode;
set local role authenticated;select pg_temp.cancel_appeal_actor(1);
select pg_temp.cancel_appeal_failure('select pg_temp.cancel_appeal_call(4)','55000');reset role;
delete from private.member_episodes where profile_id=pg_temp.cancel_appeal_uid(1)and ended_at is null;
update private.member_episodes set ended_at=null where id in(select id from cancel_appeal_old_episode);
-- 탈퇴 metadata는 owner 합성 fixture다. 실제 Auth/provider 탈퇴의 증거는 아니다.
insert into private.member_retirements(profile_id,withdrawal_id,episode_id,retired_at)
 select pg_temp.cancel_appeal_uid(1),gen_random_uuid(),id,clock_timestamp()from cancel_appeal_old_episode;
set local role authenticated;select pg_temp.cancel_appeal_actor(1);
select pg_temp.cancel_appeal_failure('select pg_temp.cancel_appeal_call(4)','42501');
select pg_temp.cancel_appeal_failure('select public.get_my_appointment_cancel_appeal((select appointment_id from cancel_appeal_cases where n=1))','42501');reset role;
delete from private.member_retirements where profile_id=pg_temp.cancel_appeal_uid(1);
-- 권한·역할·guard·worker를 열지 않는다.
do $$declare sig text;role_name text;begin
 for sig in select unnest(array['public.submit_appointment_cancel_appeal(uuid,uuid,bigint,uuid)','public.get_my_appointment_cancel_appeal(uuid)'])loop
 foreach role_name in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
 assert has_function_privilege(role_name,sig,'EXECUTE')=(role_name='authenticated');end loop;end loop;
 foreach role_name in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
 assert not has_table_privilege(role_name,'private.appointment_cancel_appeal_receipts','SELECT');
 assert not has_table_privilege(role_name,'private.safety_appeals','SELECT');
 assert not has_function_privilege(role_name,'private.require_own_cancel_appeal_context(uuid,uuid)','EXECUTE');end loop;
 assert(select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil)order by oid)from pg_roles)=(select roles from cancel_appeal_baseline);
 assert(select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members)is not distinct from(select memberships from cancel_appeal_baseline);
 assert not exists(select 1 from private.safety_sanction_applications);
 assert(select external_deletion_approved from private.member_cleanup_guard where singleton)=(select guard from cancel_appeal_baseline);
 assert(select to_jsonb(g)from private.global_worker_run g where singleton)=(select worker from cancel_appeal_baseline);
end;$$;
rollback;
