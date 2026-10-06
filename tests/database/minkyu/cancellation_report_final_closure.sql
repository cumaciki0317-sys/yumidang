-- 민규: SQL93 취소 전용 신고 종결의 실제 DB 회귀. 전체 TX rollback.
-- 본인 업로드 blob·HTTP·운영 판정·실제 두 세션 경합 증거가 아니다. 전체 owner TX rollback.
-- 완료 시각 fixture는 owner가 과거 일정으로 조정하며 실제 DB 시계·서버 수신 시각은 변경하지 않는다.
begin;
set local plpgsql.check_asserts=on;
-- 최신 지원 종류 점유는 취소의 두 실행 권한을 모두 요구한다. outer ROLLBACK으로 원복한다.

create temp table resolution_case_baseline as select
 (select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil)order by oid)from pg_roles)roles,
 (select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members)memberships,
 (select external_deletion_approved from private.member_cleanup_guard where singleton)guard,
 (select to_jsonb(g)from private.global_worker_run g where singleton)worker;
set local storage.allow_delete_query='true';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[]) on conflict(id) do nothing;
create function pg_temp.resolution_case_uid(n integer) returns uuid language sql immutable as $$
 select ('fc810000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.resolution_case_session(n integer) returns uuid language sql immutable as $$
 select ('fc820000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.resolution_case_actor(n integer) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.resolution_case_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.resolution_case_uid(n),'session_id',pg_temp.resolution_case_session(n))::text,true);
end;$$;
create function pg_temp.resolution_case_failure(command text,expected text) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('expected %s, actual %s',expected,code);
end;$$;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.resolve_naver_account('change-resolution_case-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;end;$$;
reset role;
insert into auth.users(id,email) select pg_temp.resolution_case_uid(i),a.auth_email from generate_series(1,4)i
 join private.naver_accounts a on a.subject='change-resolution_case-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.resolution_case_session(i),pg_temp.resolution_case_uid(i) from generate_series(1,4)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.resolution_case_uid(i)::text||'/fc830000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.resolution_case_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,4)i;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.record_naver_session('change-resolution_case-sql-'||i,pg_temp.resolution_case_uid(i),pg_temp.resolution_case_session(i));end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..4 loop
 perform pg_temp.resolution_case_actor(i);
 assert public.complete_naver_signup(pg_temp.resolution_case_uid(i)::text||'/fc830000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
end loop;end;$$;
reset role;

create temp table resolution_case_general_baseline as select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]'::jsonb)fingerprint from private.safety_appeals a where kind='general';
create temp table resolution_case_cases(n integer primary key,post_id uuid,appointment_id uuid,report_id uuid,request_id uuid,initial_revision bigint,result jsonb);
grant all on resolution_case_cases to authenticated;
set local role authenticated;
do $$declare i integer;p uuid;j uuid;a uuid;conditions jsonb;rid uuid;begin
 for i in 1..1 loop
 p:=gen_random_uuid();perform pg_temp.resolution_case_actor(1);
 perform public.create_service_post(p,jsonb_build_object('title','합성 취소 이의','description','로컬 합성 검증','category','산책',
 'startsAt',clock_timestamp()+make_interval(days=>i*3),'endsAt',clock_timestamp()+make_interval(days=>i*3,hours=>2),
 'recruitmentEndsAt',clock_timestamp()+make_interval(days=>i*3,hours=>-1),'publicArea','서울특별시 강남구 역삼동',
 'registeredPlaceName','합성 장소','registeredAddress','서울특별시 강남구 합성주소','meetingDetail','합성 입구',
 'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0));
 perform pg_temp.resolution_case_actor(2);j:=(public.request_service_post(p,gen_random_uuid(),'합성 신청')->>'id')::uuid;
 perform pg_temp.resolution_case_actor(1);conditions:=public.propose_match(j);
 perform pg_temp.resolution_case_actor(2);a:=(public.accept_match(j,conditions->>'conditionVersion')->>'appointmentId')::uuid;
 perform pg_temp.resolution_case_actor(1);perform public.cancel_appointment(a,gen_random_uuid(),'합성 이의 사유');
 rid:=(public.submit_member_report(gen_random_uuid(),'appointment',a,'offline',array['other'],'합성 취소 사유','{}',false)->>'reportId')::uuid;
 insert into resolution_case_cases(n,post_id,appointment_id,report_id,request_id)values(i,p,a,rid,gen_random_uuid());
 end loop;
end;$$;
reset role;
update resolution_case_cases case_row set initial_revision=head.current_revision from private.safety_appointment_results head join private.member_episodes ep on ep.id=head.source_episode_id
 where case_row.appointment_id=head.appointment_id and ep.profile_id=pg_temp.resolution_case_uid(1);
do $$begin
 assert (select count(*)=1 and bool_and(initial_revision=2) from resolution_case_cases), 'fixture_original_cancel_revision';
end;$$;
create temp table resolution_case_original as select head.identity_id,head.appointment_id,head.source_episode_id,head.agreed_starts_at,head.confirmed_at,cancel_row.cancelled_at
 from private.safety_appointment_results head join private.member_episodes ep on ep.id=head.source_episode_id join private.appointment_cancellations cancel_row on cancel_row.appointment_id=head.appointment_id
 where ep.profile_id=pg_temp.resolution_case_uid(1)and head.appointment_id in(select appointment_id from resolution_case_cases);
-- 앞선 원신고는 독립 포트 충돌 검사 자료다. 원자 제출은 별도 request key를 쓴다.

set local role authenticated;select pg_temp.resolution_case_actor(1);
update resolution_case_cases set result=public.submit_appointment_cancel_appeal_with_report(appointment_id,request_id,initial_revision,array['other'],'합성 종결 검증','{}',false);
reset role;
select private.set_report_operator_approval(pg_temp.resolution_case_uid(3),true);
select private.set_report_operator_assignment(pg_temp.resolution_case_uid(3),(result->>'reportId')::uuid,true)from resolution_case_cases;
set local role authenticated;select pg_temp.resolution_case_actor(3);
do $$declare c resolution_case_cases;k uuid:=gen_random_uuid();value jsonb;decision jsonb;begin
 select *into strict c from resolution_case_cases;
 perform pg_temp.resolution_case_failure(format('select public.final_close_assigned_member_report(%L,gen_random_uuid(),1,0,%L)',c.result->>'reportId','아직 검토 중'),'40001');
 decision:=public.resolve_assigned_appointment_cancel_appeal((c.result->>'reportId')::uuid,(c.result->>'appealId')::uuid,gen_random_uuid(),'initial',1,3,0,'rejected');
 perform pg_temp.resolution_case_failure(format('select public.final_close_assigned_member_report(%L,gen_random_uuid(),2,1,%L)',c.result->>'reportId','버전 충돌'),'40001');
 value:=public.final_close_assigned_member_report((c.result->>'reportId')::uuid,k,2,0,'합성 취소 이의 최종 종결');
 assert value->>'status'='resolved'and value->>'version'='3';
 assert(value->>'retentionDueAt')::timestamptz=(value->>'finalClosedAt')::timestamptz+interval'2160 hours';
 assert public.final_close_assigned_member_report((c.result->>'reportId')::uuid,k,2,0,'합성 취소 이의 최종 종결')=value||jsonb_build_object('alreadyApplied',true);
end;$$;
reset role;
rollback;
