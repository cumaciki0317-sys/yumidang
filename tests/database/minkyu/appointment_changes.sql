-- 확정 일정 변경·취소의 실제 역할/세션 검사. 합성 자료와 DDL은 전부 rollback한다.
begin;
create function pg_temp.change_uid(n integer) returns uuid language sql immutable as $$
 select ('61000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.change_actor(n integer,unregistered boolean default false) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',pg_temp.change_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.change_uid(n),
   'session_id',case when unregistered then '62000000-0000-4000-8000-000000000099' else
     '62000000-0000-4000-8000-'||lpad(n::text,12,'0') end)::text,true);
end; $$;
create function pg_temp.change_expect(command text,expected text[]) returns void language plpgsql as $$
declare code text;
begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=any(expected),'unexpected schedule permission/state result';
end; $$;
create temp table change_cases(n integer primary key,post_id uuid,request_id uuid,appointment_id uuid,
 old_start timestamptz,old_end timestamptz,updated_at timestamptz,change_id uuid,version text,
 new_start timestamptz,new_end timestamptz,generation uuid,cancellation_id uuid);
grant all on change_cases to authenticated,service_role;
set local role service_role;
do $$ declare n integer;begin
 for n in 1..5 loop perform public.resolve_naver_account('appointment-change-sql-'||n,'합성 일정회원'||n,'F','1990-01-01');end loop;
end $$;
reset role;
insert into auth.users(id,email) select pg_temp.change_uid(n),a.auth_email from generate_series(1,5) n
 join private.naver_accounts a on a.subject='appointment-change-sql-'||n;
insert into auth.users(id) values(pg_temp.change_uid(6));
insert into auth.sessions(id,user_id) select ('62000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,pg_temp.change_uid(n) from generate_series(1,6) n;
insert into auth.sessions(id,user_id) values('62000000-0000-4000-8000-000000000099',pg_temp.change_uid(1));
insert into public.profiles(id,real_name,birth_date,gender) values(pg_temp.change_uid(6),'합성 기존회원','1990-01-01','female');
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.change_uid(n)::text||'/63000000-0000-4000-8000-'||lpad(n::text,12,'0')||'.jpg',
 pg_temp.change_uid(n)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,5) n;
set local role service_role;
do $$ declare n integer;begin
 for n in 1..5 loop perform public.record_naver_session('appointment-change-sql-'||n,pg_temp.change_uid(n),
   ('62000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid);end loop;
end $$;
reset role;
set local role authenticated;
do $$ declare n integer;p uuid;r jsonb;m jsonb;t timestamptz;author integer;peer integer;begin
 for n in 1..5 loop
  perform pg_temp.change_actor(n);
  assert public.complete_naver_signup(pg_temp.change_uid(n)::text||'/63000000-0000-4000-8000-'||lpad(n::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
 end loop;
 for n in 1..10 loop
  author:=case when n=10 then 3 else 1 end;peer:=case when n=9 then 3 else 2 end;
  p:=gen_random_uuid();t:=now()+make_interval(days=>n*5);
  perform pg_temp.change_actor(author);
  perform public.create_service_post(p,jsonb_build_object('title','합성 확정 일정','description','전용 로컬 검증 자료','category','산책',
   'startsAt',t,'endsAt',t+interval '2 hours','recruitmentEndsAt',t-interval '1 hour','publicArea','서울특별시 강남구 역삼동',
   'registeredPlaceName','가상 장소','registeredAddress','비공개 합성 주소','meetingDetail','비공개 합성 입구',
   'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0));
  perform pg_temp.change_actor(peer);r:=public.request_service_post(p,'가상 일정 검증 신청');
  perform pg_temp.change_actor(author);m:=public.propose_match((r->>'id')::uuid);
  perform pg_temp.change_actor(peer);m:=public.accept_match((r->>'id')::uuid,m->>'conditionVersion');
  insert into change_cases(n,post_id,request_id,appointment_id,old_start,old_end,updated_at,change_id,new_start,new_end,cancellation_id)
   select n,p,(r->>'id')::uuid,(m->>'appointmentId')::uuid,t,t+interval '2 hours',updated_at,gen_random_uuid(),
    t+interval '1 day',t+interval '1 day 2 hours',gen_random_uuid() from public.posts where id=p;
 end loop;
end $$;
reset role;
update change_cases c set generation=r.generation from private.completion_reservations r where r.appointment_id=c.appointment_id;

-- 제안만으로 기존 일정/예약은 바뀌지 않는다. 본인은 응답할 수 없고 외부인은 존재를 알 수 없다.
set local role authenticated;
do $$ declare c change_cases;r jsonb;begin
 select * into c from change_cases where n=1;perform pg_temp.change_actor(1);
 r:=public.propose_appointment_schedule_change(c.appointment_id,c.change_id,c.new_start,c.new_end,c.updated_at);
 update change_cases set version=r->>'conditionVersion' where n=1;
 assert r->>'status'='awaiting_response';
 perform pg_temp.change_expect(format('select public.accept_appointment_schedule_change(%L,%L,%L)',c.appointment_id,c.change_id,r->>'conditionVersion'),array['42501']);
 perform pg_temp.change_expect(format('select public.decline_appointment_schedule_change(%L,%L,%L)',c.appointment_id,c.change_id,r->>'conditionVersion'),array['42501']);
 perform pg_temp.change_actor(4);
 perform pg_temp.change_expect(format('select public.get_appointment_change_state(%L)',c.appointment_id),array['PT404']);
 perform pg_temp.change_actor(2);assert public.get_appointment_change_state(c.appointment_id) is not null;
end $$;
reset role;
do $$ declare c change_cases;begin
 select * into c from change_cases where n=1;
 assert (select starts_at=c.old_start and ends_at=c.old_end from public.posts where id=c.post_id);
 assert (select generation=c.generation and due_at=c.old_end+interval '24 hours' from private.completion_reservations where appointment_id=c.appointment_id);
 assert (select expires_at=least(old_starts_at,new_starts_at) from private.appointment_schedule_changes where change_id=c.change_id);
end $$;
select 'ORDERED_CHECK:schedule_proposal_keeps_original_peer_only';
update public.notifications set read_at=now() where kind='appointment_schedule_change_requested'
 and event_data->>'changeId'=(select change_id::text from change_cases where n=1);

-- 응답은 min(기존/새 시작) 직전까지이며 정각부터 닫힌다. 같은 입력 재시도/다른 입력 충돌.
set local role authenticated;
do $$ declare c change_cases;r jsonb;begin
 select * into c from change_cases where n=1;perform pg_temp.change_actor(1);
 r:=public.propose_appointment_schedule_change(c.appointment_id,c.change_id,c.new_start,c.new_end,c.updated_at);
 assert r->>'conditionVersion'=c.version;
 perform pg_temp.change_expect(format('select public.propose_appointment_schedule_change(%L,%L,%L::timestamptz,%L::timestamptz,%L::timestamptz)',
  c.appointment_id,c.change_id,c.new_start,c.new_end+interval '1 minute',c.updated_at),array['40001']);
 perform pg_temp.change_actor(2);
 perform pg_temp.change_expect(format('select public.accept_appointment_schedule_change(%L,%L,''stale-version'')',c.appointment_id,c.change_id),array['40001']);
 perform pg_temp.change_actor(1);select * into c from change_cases where n=4;
 update change_cases set new_start=old_start-interval '1 day',new_end=old_end-interval '1 day' where n=4;
 select * into c from change_cases where n=4;
 r:=public.propose_appointment_schedule_change(c.appointment_id,c.change_id,c.new_start,c.new_end,c.updated_at);
 update change_cases set version=r->>'conditionVersion' where n=4;
end $$;
reset role;
do $$ declare c change_cases;e timestamptz;begin
 for c in select * from change_cases where n in(1,4) loop
  select expires_at into e from private.appointment_schedule_changes where change_id=c.change_id;
  assert e=least(c.old_start,c.new_start);
  assert private.appointment_schedule_response_open(c.change_id,e-interval '1 microsecond');
  assert not private.appointment_schedule_response_open(c.change_id,e);
  assert not private.appointment_schedule_response_open(c.change_id,e+interval '1 microsecond');
 end loop;
 assert (select count(*) from public.notifications where kind='appointment_schedule_change_requested'
  and event_data->>'changeId'=(select change_id::text from change_cases where n=1) and read_at=now())=2;
end $$;
set local role authenticated;
do $$ declare c change_cases;begin
 select * into c from change_cases where n=10;perform pg_temp.change_actor(3);
 perform pg_temp.change_expect(format('select public.propose_appointment_schedule_change(%L,%L,%L::timestamptz,%L::timestamptz,%L::timestamptz)',
  c.appointment_id,c.change_id,c.new_start,c.new_end,c.updated_at-interval '1 microsecond'),array['40001']);
end $$;
reset role;
select 'ORDERED_CHECK:schedule_deadline_boundary_retries';

set local role authenticated;
do $$ declare c change_cases;r jsonb;begin
 select * into c from change_cases where n=1;perform pg_temp.change_actor(2);
 r:=public.accept_appointment_schedule_change(c.appointment_id,c.change_id,c.version);assert r->>'status'='accepted';
 assert public.accept_appointment_schedule_change(c.appointment_id,c.change_id,c.version)->>'status'='accepted';
end $$;
reset role;
do $$ declare c change_cases;g uuid;begin
 select * into c from change_cases where n=1;
 assert (select starts_at=c.new_start and ends_at=c.new_end from public.posts where id=c.post_id);
 select generation into g from private.completion_reservations where appointment_id=c.appointment_id;
 assert g<>c.generation;
 assert (select due_at=c.new_end+interval '24 hours' from private.completion_reservations where appointment_id=c.appointment_id);
 update change_cases set generation=g where n=1;
end $$;
set local role authenticated;
do $$ declare c change_cases;begin
 select * into c from change_cases where n=1;perform pg_temp.change_actor(2);
 perform public.accept_appointment_schedule_change(c.appointment_id,c.change_id,c.version);
end $$;
reset role;
do $$ declare c change_cases;begin
 select * into c from change_cases where n=1;
 assert (select generation=c.generation from private.completion_reservations where appointment_id=c.appointment_id);
end $$;
select 'ORDERED_CHECK:schedule_accept_reservation_generation';

-- 양 당사자의 이미 확정된 다른 약속과 새 일정이 겹치면 수락만 거절하고 기존 일정을 보존한다.
set local role authenticated;
do $$ declare c change_cases;r jsonb;i integer;begin
 for i in 2..3 loop
  update change_cases set new_start=(select old_start from change_cases where n=case when i=2 then 9 else 10 end),
   new_end=(select old_end from change_cases where n=case when i=2 then 9 else 10 end) where change_cases.n=i;
  select * into c from change_cases where change_cases.n=i;perform pg_temp.change_actor(1);
  r:=public.propose_appointment_schedule_change(c.appointment_id,c.change_id,c.new_start,c.new_end,c.updated_at);
  update change_cases set version=r->>'conditionVersion' where change_cases.n=i;
  perform pg_temp.change_actor(2);
  perform pg_temp.change_expect(format('select public.accept_appointment_schedule_change(%L,%L,%L)',c.appointment_id,c.change_id,r->>'conditionVersion'),array['40001']);
 end loop;
end $$;
reset role;
do $$ begin assert not exists(select 1 from change_cases c join public.posts p on p.id=c.post_id where c.n in(2,3) and (p.starts_at<>c.old_start or p.ends_at<>c.old_end));end $$;
select 'ORDERED_CHECK:schedule_both_participant_conflicts';

set local role authenticated;
do $$ declare c change_cases;begin
 select * into c from change_cases where n=4;perform pg_temp.change_actor(2);
 assert public.decline_appointment_schedule_change(c.appointment_id,c.change_id,c.version)->>'status'='declined';
 assert public.decline_appointment_schedule_change(c.appointment_id,c.change_id,c.version)->>'status'='declined';
 perform pg_temp.change_actor(1);select * into c from change_cases where n=6;
 update change_cases set version=public.propose_appointment_schedule_change(c.appointment_id,c.change_id,c.new_start,c.new_end,c.updated_at)->>'conditionVersion' where n=6;
end $$;
reset role;
-- 시간 경과를 합성 snapshot에 반영한다. expires=min(old/new start) 형상도 함께 보존한다.
update public.posts set starts_at=now()-interval '1 minute',ends_at=now()+interval '1 hour',recruitment_ends_at=now()-interval '1 hour'
 where id=(select post_id from change_cases where n=6);
update change_cases c set old_start=p.starts_at,old_end=p.ends_at,updated_at=p.updated_at from public.posts p where c.n=6 and p.id=c.post_id;
update private.appointment_schedule_changes s set old_starts_at=c.old_start,old_ends_at=c.old_end,old_updated_at=c.updated_at,
 requested_at=now()-interval '2 hours',expires_at=c.old_start from change_cases c where c.n=6 and s.change_id=c.change_id;
set local role service_role;
do $$ begin assert public.expire_appointment_changes(1000)->>'expiredCount'='1';assert public.expire_appointment_changes(1000)->>'expiredCount'='0';end $$;
reset role;
set local role authenticated;
do $$ declare c change_cases;begin
 select * into c from change_cases where n=6;perform pg_temp.change_actor(2);
 perform pg_temp.change_expect(format('select public.accept_appointment_schedule_change(%L,%L,%L)',c.appointment_id,c.change_id,c.version),array['40001']);
 assert public.decline_appointment_schedule_change(c.appointment_id,c.change_id,c.version)->>'status'='expired';
end $$;
reset role;
do $$ begin
 assert (select status='expired' from private.appointment_schedule_changes where change_id=(select change_id from change_cases where n=6));
 assert not exists(select 1 from change_cases c join public.posts p on p.id=c.post_id where c.n in(4,6) and (p.starts_at<>c.old_start or p.ends_at<>c.old_end));
end $$;
select 'ORDERED_CHECK:schedule_decline_expiry_keeps_original';

set local role authenticated;
do $$ declare c change_cases;r jsonb;begin
 select * into c from change_cases where n=5;perform pg_temp.change_actor(1);
 r:=public.propose_appointment_schedule_change(c.appointment_id,c.change_id,c.new_start,c.new_end,c.updated_at);
 update change_cases set version=r->>'conditionVersion' where n=5;
 perform pg_temp.change_actor(2);
 perform public.send_conversation_message(c.request_id,gen_random_uuid(),'취소 뒤에도 보존할 합성 대화');
 assert public.get_service_post(c.post_id)?'privateDetails';
 perform pg_temp.change_expect(format('select public.cancel_appointment(%L,%L,''   '')',c.appointment_id,c.cancellation_id),array['22023']);
 perform pg_temp.change_expect(format('select public.cancel_appointment(%L,%L,%L)',c.appointment_id,c.cancellation_id,repeat('a',301)),array['22023']);
 r:=public.cancel_appointment(c.appointment_id,c.cancellation_id,'  합성 일정 변경으로 취소  ');assert r->>'status'='cancelled';
 perform public.cancel_appointment(c.appointment_id,c.cancellation_id,'합성 일정 변경으로 취소');
 perform pg_temp.change_expect(format('select public.cancel_appointment(%L,%L,''다른 사유'')',c.appointment_id,c.cancellation_id),array['40001']);
 assert not(public.get_service_post(c.post_id)?'privateDetails');
 assert not(select can_send from public.get_conversation(c.request_id));
 assert jsonb_array_length(public.list_conversation_messages(c.request_id,10)->'items')=1;
 perform pg_temp.change_expect(format('select public.send_conversation_message(%L,%L,''취소 후 전송'')',c.request_id,gen_random_uuid()),array['42501']);
end $$;
reset role;
do $$ declare c change_cases;begin
 select * into c from change_cases where n=5;
 assert (select status='cancelled' and completed_at is null from public.appointments where id=c.appointment_id);
 assert (select reason='합성 일정 변경으로 취소' from private.appointment_cancellations where appointment_id=c.appointment_id);
 assert not exists(select 1 from private.completion_reservations where appointment_id=c.appointment_id);
 assert (select status='cancelled' from private.appointment_schedule_changes where change_id=c.change_id);
end $$;
select 'ORDERED_CHECK:cancellation_visibility_chat_reservation';

-- 기존 미검증 회원의 취소/열람은 허용하되 신규 활동과 일정 변경은 차단한다.
update public.posts set author_id=pg_temp.change_uid(6) where id=(select post_id from change_cases where n=7);
update public.posts set starts_at=now()-interval '1 minute',ends_at=now()+interval '1 hour',recruitment_ends_at=now()-interval '1 hour' where id=(select post_id from change_cases where n=8);
set local role authenticated;
do $$ declare c change_cases;begin
 select * into c from change_cases where n=7;perform pg_temp.change_actor(6);
 assert public.get_appointment_change_state(c.appointment_id) is not null;
 perform pg_temp.change_expect(format('select public.propose_appointment_schedule_change(%L,%L,%L::timestamptz,%L::timestamptz,%L::timestamptz)',
  c.appointment_id,c.change_id,c.new_start,c.new_end,c.updated_at),array['28000','42501']);
 perform pg_temp.change_expect(format('select public.request_service_post(%L,''가입 미검증 신규 신청'')',c.post_id),array['28000','42501']);
 assert public.cancel_appointment(c.appointment_id,c.cancellation_id,'합성 기존회원 취소')->>'status'='cancelled';
 perform pg_temp.change_actor(2);select * into c from change_cases where n=8;
 perform pg_temp.change_expect(format('select public.cancel_appointment(%L,%L,''시작 뒤 취소'')',c.appointment_id,c.cancellation_id),array['40001']);
 perform pg_temp.change_actor(1,true);select * into c from change_cases where n=2;
 perform pg_temp.change_expect(format('select public.propose_appointment_schedule_change(%L,%L,%L::timestamptz,%L::timestamptz,%L::timestamptz)',
  c.appointment_id,gen_random_uuid(),c.new_start,c.new_end,c.updated_at),array['28000','42501']);
end $$;
reset role;
-- 변경 제안자가 현재 자격을 잃으면 유효 세션을 가진 상대의 수락도 막는다.
update private.naver_accounts set verification_status='information_required' where user_id=pg_temp.change_uid(1);
set local role authenticated;
do $$ declare c change_cases;begin
 select * into c from change_cases where n=2;perform pg_temp.change_actor(2);
 perform pg_temp.change_expect(format('select public.accept_appointment_schedule_change(%L,%L,%L)',c.appointment_id,c.change_id,c.version),array['42501']);
end $$;
reset role;
update private.naver_accounts set verification_status='qualified' where user_id=pg_temp.change_uid(1);
select 'ORDERED_CHECK:legacy_cancellation_activity_gate';

do $$ begin
 assert not has_function_privilege('anon','public.cancel_appointment(uuid,uuid,text)','EXECUTE');
 assert not has_function_privilege('authenticated','public.expire_appointment_changes(integer)','EXECUTE');
 assert has_function_privilege('service_role','public.expire_appointment_changes(integer)','EXECUTE');
 assert not has_table_privilege('authenticated','private.appointment_schedule_changes','UPDATE');
 assert not has_table_privilege('service_role','private.appointment_cancellations','SELECT');
 assert not has_function_privilege('authenticated','private.appointment_schedule_response_open(uuid,timestamptz)','EXECUTE');
 assert (select count(*) from public.notifications where kind='appointment_schedule_change_requested' and event_data->>'changeId'=(select change_id::text from change_cases where n=1))=2;
 assert (select count(*) from public.notifications where kind='appointment_schedule_change_ended' and event_data->>'changeId'=(select change_id::text from change_cases where n=1))=2;
 assert (select count(*) from public.notifications where kind='appointment_cancelled' and event_data->>'cancellationId'=(select cancellation_id::text from change_cases where n=5))=2;
end $$;
set local role authenticated;
do $$ begin perform pg_temp.change_actor(1);perform pg_temp.change_expect('select public.expire_appointment_changes(10)',array['42501']);end $$;
reset role;
select 'ORDERED_CHECK:schedule_roles_notifications_deduplication';
rollback;
