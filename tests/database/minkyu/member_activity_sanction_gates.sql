-- 신규21811 정적 준비 회귀. source55+20136+21810+21811 적용 이후만 실행한다. 아직 NOT_RUN.
begin;
-- schema-only 격리 DB의 필수 Storage metadata만 준비한다. 객체 파일·운영 자료는 만들지 않는다.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('profile-images','profile-images',false,5242880,array['image/jpeg','image/png','image/webp'])
  on conflict(id) do nothing;
set local storage.allow_delete_query='true';
create function pg_temp.first_uid(n integer) returns uuid language sql immutable as $$
  select ('e1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.first_session(n integer) returns uuid language sql immutable as $$
  select ('e2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.first_actor(n integer,unregistered boolean default false) returns void language plpgsql as $$
declare u uuid:=pg_temp.first_uid(n);s uuid:=case when unregistered then 'e2000000-0000-4000-8000-000000000099'::uuid else pg_temp.first_session(n) end;
begin
  perform set_config('request.jwt.claim.sub',u::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',u,'session_id',s)::text,true);
end; $$;
create function pg_temp.first_input(n integer) returns jsonb language sql volatile as $$
  select jsonb_build_object('title','합성 생명주기 공고','description','전용 로컬 검증 자료','category','산책',
    'startsAt',clock_timestamp()+make_interval(days=>n*3),'endsAt',clock_timestamp()+make_interval(days=>n*3,hours=>2),
    'recruitmentEndsAt',clock_timestamp()+make_interval(days=>n*3,hours=>-1),
    'publicArea','서울특별시 강남구 역삼동','registeredPlaceName','가상 장소','registeredAddress','비공개 가상주소 123',
    'meetingDetail','비공개 가상 입구','preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0);
$$;
create function pg_temp.expect_failure(command text,expected text[]) returns void language plpgsql as $$
declare code text;
begin
  begin execute command;
  exception when others then get stacked diagnostics code=returned_sqlstate; end;
  assert code=any(expected), format('unexpected SQLSTATE %s, expected %s',code,expected);
end; $$;
create temp table matching_cases(name text primary key,post_id uuid,input jsonb,r1 uuid,r2 uuid,version text,old_updated timestamptz);
grant all on matching_cases to authenticated,service_role;

-- 실제 자격 예약·세션 등록·사진·명시 완료를 거친 합성 회원 다섯 명.
set local role service_role;
do $$ declare i integer;begin
  for i in 1..5 loop perform public.resolve_naver_account('activitygate-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;
end $$;
reset role;

insert into auth.users(id,email) select pg_temp.first_uid(i),a.auth_email from generate_series(1,5) i
  join private.naver_accounts a on a.subject='activitygate-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.first_session(i),pg_temp.first_uid(i) from generate_series(1,5) i;
insert into auth.sessions(id,user_id) values('e2000000-0000-4000-8000-000000000099',pg_temp.first_uid(1));
insert into storage.objects(bucket_id,name,owner_id,metadata)
  select 'profile-images',pg_temp.first_uid(i)::text||'/e3000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
    pg_temp.first_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,5) i;
set local role service_role;
do $$ declare i integer;begin
  for i in 1..5 loop perform public.record_naver_session('activitygate-sql-'||i,pg_temp.first_uid(i),pg_temp.first_session(i));end loop;
end $$;
reset role;
set local role authenticated;
do $$ declare i integer;begin
  for i in 1..5 loop
    perform pg_temp.first_actor(i);
    assert public.complete_naver_signup(pg_temp.first_uid(i)::text||'/e3000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
  end loop;
end $$;
reset role;

create temp table activity_cases(n int primary key,p uuid,input jsonb,r uuid,v text,ap uuid);
grant all on activity_cases to authenticated;
set local role authenticated;
do $$declare i int;res jsonb;begin
 perform pg_temp.first_actor(1);
 for i in 1..4 loop
  insert into activity_cases(n,p,input)values(i,gen_random_uuid(),pg_temp.first_input(i));
  perform public.create_service_post((select p from activity_cases where activity_cases.n=i),(select input from activity_cases where activity_cases.n=i));
 end loop;
 perform pg_temp.first_actor(2);
 for i in 1..3 loop
  res:=public.request_service_post((select p from activity_cases where activity_cases.n=i),gen_random_uuid(),'합성 기존 대화');
  update activity_cases set r=(res->>'id')::uuid where activity_cases.n=i;
 end loop;
 perform public.withdraw_join_request((select r from activity_cases where n=3));
 perform pg_temp.first_actor(3);
 res:=public.request_service_post((select p from activity_cases where n=1),gen_random_uuid(),'복원 검증 신청');
 insert into activity_cases(n,p,input,r)select 5,p,input,(res->>'id')::uuid from activity_cases where n=1;
 perform pg_temp.first_actor(1);
 res:=public.propose_match((select r from activity_cases where n=1));
 update activity_cases set v=res->>'conditionVersion'where n=1;
 perform pg_temp.first_actor(2);
 res:=public.accept_match((select r from activity_cases where n=1),(select v from activity_cases where n=1));
 update activity_cases set ap=(res->>'appointmentId')::uuid where n=1;
end;$$;
reset role;
update public.join_requests set withdrawn_at=clock_timestamp()-interval'2 minutes'where id=(select r from activity_cases where n=3);
create function pg_temp.activity_decide(n int,member_n int,state text,expected bigint,kinds text[])returns bigint language plpgsql as $$
declare id uuid;ep uuid;begin
 select e.identity_id,e.id into id,ep from private.member_episodes e where e.profile_id=pg_temp.first_uid(member_n)and ended_at is null;
 return private.record_incident_revision(('e4000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,gen_random_uuid(),expected,state,'synthetic',pg_temp.first_uid(99),
 case when state='confirmed'then jsonb_build_array(jsonb_build_object('identityId',id,'sourceEpisodeId',ep,'confirmedKinds',to_jsonb(kinds)))else'[]'::jsonb end);
end;$$;
-- 실제 owner 판정으로 작성자 기간제 제재를 만든다. 직접 적용 행으로 성공을 흉내내지 않는다.
select pg_temp.activity_decide(1,1,'confirmed',0,array['cancel_sanction']);
set local role authenticated;
do $$declare q uuid;version text;begin
 perform pg_temp.first_actor(1);
 perform pg_temp.expect_failure(format('select public.create_service_post(%L,pg_temp.first_input(10))',gen_random_uuid()),array['42501']);
 perform pg_temp.expect_failure(format('select public.propose_match(%L)',(select r from activity_cases where n=2)),array['42501']);
 -- 이미 성공한 생성·확정 재시도는 새 활동이 아니다. DTO/기록을 그대로 재현한다.
 assert public.create_service_post((select p from activity_cases where n=1),(select input from activity_cases where n=1))->>'alreadyCreated'='true';
 perform public.get_appointment_state((select ap from activity_cases where n=1));
 perform public.send_conversation_message((select r from activity_cases where n=2),gen_random_uuid(),'제한 중 기존 채팅 허용');
 -- 상대방 제재 검사 정책을 임의 추가하지 않는다. 여기서는 정상 상대의 새로운 확정을 assertion하지 않는다.
end;$$;
reset role;
select pg_temp.activity_decide(2,2,'confirmed',0,array['cancel_sanction']);
set local role authenticated;
do $$declare res jsonb;begin
 perform pg_temp.first_actor(2);
 perform pg_temp.expect_failure(format('select public.request_service_post(%L,%L,%L)',(select p from activity_cases where n=4),gen_random_uuid(),'새 신청'),array['42501']);
 perform pg_temp.expect_failure(format('select public.request_service_post(%L,%L,%L)',(select p from activity_cases where n=3),gen_random_uuid(),'재신청'),array['42501']);
 -- 기존 pending의 첫채팅 진입점도 기존 채팅이다. 상태를 새로 만들거나 복원하지 않는다.
 res:=public.request_service_post((select p from activity_cases where n=2),gen_random_uuid(),'기존 pending 대화 유지');
 assert res->>'already_existed'='true';
 assert public.accept_match((select r from activity_cases where n=1),(select v from activity_cases where n=1))->>'alreadyConfirmed'='true';
 perform public.get_appointment_state((select ap from activity_cases where n=1));
 perform public.send_conversation_message((select r from activity_cases where n=2),gen_random_uuid(),'기존 메시지 유지');
end;$$;
reset role;
-- 기존 확정 관리의 취소·재개 후 실제 not_selected 신청을 복원한다.
set local role authenticated;
do $$declare res jsonb;begin
 perform pg_temp.first_actor(1);
 perform public.cancel_appointment((select ap from activity_cases where n=1),gen_random_uuid(),'합성 기존 약속 관리');
 res:=public.reopen_service_post((select p from activity_cases where n=1));
 assert(res->>'restoredCount')::int>=1;
 assert(select status='pending'from public.join_requests where id=(select r from activity_cases where n=5));
 perform pg_temp.expect_failure(format('select public.propose_match(%L)',(select r from activity_cases where n=5)),array['42501']);
end;$$;
reset role;
select pg_temp.activity_decide(5,3,'confirmed',0,array['cancel_sanction']);
-- 작성자 무효 정정은 즉시 다음 신규 요청을 허용하며 신청자의 제한은 유지한다.
select pg_temp.activity_decide(1,1,'invalidated',1,'{}');
set local role authenticated;
do $$declare res jsonb;begin
 perform pg_temp.first_actor(1);res:=public.propose_match((select r from activity_cases where n=2));
 update activity_cases set v=res->>'conditionVersion'where n=2;
 res:=public.propose_match((select r from activity_cases where n=5));
 update activity_cases set v=res->>'conditionVersion'where n=5;
 perform pg_temp.first_actor(3);
 perform pg_temp.expect_failure(format('select public.accept_match(%L,%L)',(select r from activity_cases where n=5),(select v from activity_cases where n=5)),array['42501']);
 perform pg_temp.first_actor(2);
 perform pg_temp.expect_failure(format('select public.accept_match(%L,%L)',(select r from activity_cases where n=2),(select v from activity_cases where n=2)),array['42501']);
end;$$;
reset role;
-- 복원된 신청도 새 accept를 허용하지 않는다. 작성자 상태만으로 상대 제재 정책을 결정하지 않는다.
do $$begin
 assert(select status='pending'from public.join_requests where id=(select r from activity_cases where n=2));
 assert not exists(select 1 from public.appointments where join_request_id=(select r from activity_cases where n=2));
end;$$;
-- 정확 종료 경계: owner 합성 시계를 이동한다. gate는 DB clock으로 >= 종료를 허용한다.
do $$declare v_identity uuid;t timestamptz:=clock_timestamp();begin
 select identity_id into v_identity from private.member_episodes where profile_id=pg_temp.first_uid(2)and ended_at is null;
 update private.safety_sanction_applications set applied_at=t-interval'168 hours',expires_at=t where identity_id=v_identity and revoked_at is null;
 perform pg_temp.first_actor(2);perform private.assert_new_member_activity_allowed();
end;$$;
-- 경고는 신규 활동을 막지 않는다. 영구제재도 신규활동 gate만 막고 기존 자료/후기 접근을 유지한다.
select private.record_incident_revision('e4000000-0000-4000-8000-000000000003',gen_random_uuid(),0,'confirmed','warning_only',pg_temp.first_uid(99),
 (select jsonb_build_array(jsonb_build_object('identityId',identity_id,'sourceEpisodeId',id,'confirmedKinds','[]'::jsonb,
 'violationClass','cancellation','violationType',null,'victimIdentityId',null,'cancellationAction','cancel_warning'))from private.member_episodes where profile_id=pg_temp.first_uid(2)and ended_at is null));
select pg_temp.first_actor(2);select private.assert_new_member_activity_allowed();
select pg_temp.activity_decide(4,2,'confirmed',0,array['major_violation']);
-- 실제 후기 입력은 제재 gate를 호출하지 않는 완료약속에 대해 검사한다.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
 values(pg_temp.first_uid(900),pg_temp.first_uid(1),'합성 완료약속','제재 관리 검증','산책',clock_timestamp()-interval'3 hours',clock_timestamp()-interval'1 hour',clock_timestamp()-interval'4 hours','서울특별시 강남구 역삼동','closed');
insert into public.join_requests(id,post_id,requester_id,message,status)values(pg_temp.first_uid(901),pg_temp.first_uid(900),pg_temp.first_uid(2),'기존 완료 대화','matched');
insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
 values(pg_temp.first_uid(902),pg_temp.first_uid(900),pg_temp.first_uid(901),'completed',clock_timestamp()-interval'1 hour','automatic',clock_timestamp()-interval'1 hour',clock_timestamp()+interval'23 hours',clock_timestamp()+interval'6 days');
set local role authenticated;
do $$begin
 perform pg_temp.first_actor(2);
 perform public.get_my_profile();perform public.get_appointment_state((select ap from activity_cases where n=1));
 perform public.submit_appointment_review(pg_temp.first_uid(902),5,'제한 중 허용되는 기존 후기','positive','{}');
 perform pg_temp.expect_failure(format('select public.create_service_post(%L,pg_temp.first_input(20))',gen_random_uuid()),array['42501']);
end;$$;
reset role;
-- owner 합성 바인딩으로 새 UUID/현재회차를 만든다. 실제 재가입 Auth 삭제 pipeline의 증거는 아니다.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update private.member_episodes set ended_at=clock_timestamp()where profile_id=pg_temp.first_uid(2)and ended_at is null;
insert into auth.users(id,email)values(pg_temp.first_uid(6),'activity-rejoin@test.invalid');
insert into auth.sessions(id,user_id)values(pg_temp.first_session(6),pg_temp.first_uid(6));
update private.naver_accounts set user_id=pg_temp.first_uid(6)where subject='activitygate-sql-2';
insert into private.naver_sessions(session_id,user_id,subject)values(pg_temp.first_session(6),pg_temp.first_uid(6),'activitygate-sql-2');
insert into storage.objects(bucket_id,name,owner_id,metadata)values('profile-images',pg_temp.first_uid(6)::text||'/e3000000-0000-4000-8000-000000000006.jpg',pg_temp.first_uid(6)::text,'{"mimetype":"image/jpeg","size":128}');
insert into public.profiles(id,real_name,birth_date,gender,avatar_url)values(pg_temp.first_uid(6),'합성 재가입','1990-01-01','female',pg_temp.first_uid(6)::text||'/e3000000-0000-4000-8000-000000000006.jpg');
do $$declare before_at timestamptz;begin
 select applied_at into before_at from private.safety_sanction_applications where incident_id='e4000000-0000-4000-8000-000000000004'and revoked_at is null;
 perform pg_temp.first_actor(6);
 perform pg_temp.expect_failure('select private.assert_new_member_activity_allowed()',array['42501']);
 assert private.current_member_sweetness(pg_temp.first_uid(6))=15;
 assert(select applied_at=before_at from private.safety_sanction_applications where incident_id='e4000000-0000-4000-8000-000000000004'and revoked_at is null);
 -- 종료회차 사건의 무효 정정은 현재회차 gate도 즉시 풀어야 한다.
 perform pg_temp.activity_decide(4,2,'invalidated',1,'{}');
 perform private.assert_new_member_activity_allowed();
 assert private.current_member_sweetness(pg_temp.first_uid(6))=15;
end;$$;
-- 닫힌 owner 별칭/legacy 경로가 direct native RPC 제재 우회를 제공하지 않는다.
do $$declare ro text;sig text;begin
 foreach ro in array array['anon','authenticated','service_role']loop
  assert not has_function_privilege(ro,'private.assert_new_member_activity_allowed()','EXECUTE');
  foreach sig in array array['private.create_service_post_before_member_retirement(uuid,jsonb)','private.request_service_post_without_blocks(uuid,uuid,text)','private.propose_match_without_blocks(uuid)','private.accept_match_without_blocks(uuid,text)']loop
   assert not has_function_privilege(ro,sig,'EXECUTE');
  end loop;
 end loop;
 assert not has_function_privilege('authenticated','public.request_service_post(uuid,text)','EXECUTE');
 assert not has_function_privilege('authenticated','public.create_join_request(uuid,text)','EXECUTE');
end;$$;
rollback;
