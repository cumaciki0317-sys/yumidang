-- 민규 전용 로컬 합성 자료. 실제 역할·세션·RPC를 검사하고 모든 자료를 rollback한다.
begin;
-- schema-only 복사본에서도 재현되도록 합성 회원이 참조하는 최소 사전을 transaction 안에 준비한다.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[])
  on conflict(id) do nothing;
insert into private.review_praise_catalog(code,label,is_active,display_order)
  values('punctual','시간을 잘 지켜요',true,1)
  on conflict(code) do nothing;
set local storage.allow_delete_query='true';
create function pg_temp.match_uid(n integer) returns uuid language sql immutable as $$
  select ('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.match_session(n integer) returns uuid language sql immutable as $$
  select ('a2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.match_actor(n integer,unregistered boolean default false) returns void language plpgsql as $$
declare u uuid:=pg_temp.match_uid(n);s uuid:=case when unregistered then 'a2000000-0000-4000-8000-000000000099'::uuid else pg_temp.match_session(n) end;
begin
  perform set_config('request.jwt.claim.sub',u::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',u,'session_id',s)::text,true);
end; $$;
create function pg_temp.match_input(n integer) returns jsonb language sql volatile as $$
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
  assert code=any(expected), 'unexpected permission/state result';
end; $$;
create temp table matching_cases(name text primary key,post_id uuid,input jsonb,r1 uuid,r2 uuid,version text,old_updated timestamptz);
grant all on matching_cases to authenticated,service_role;

-- 실제 자격 예약·세션 등록·사진·명시 완료를 거친 합성 회원 다섯 명.
set local role service_role;
do $$ declare i integer;begin
  for i in 1..5 loop perform public.resolve_naver_account('reopen-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;
end $$;
reset role;
insert into auth.users(id,email) select pg_temp.match_uid(i),a.auth_email from generate_series(1,5) i
  join private.naver_accounts a on a.subject='reopen-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.match_session(i),pg_temp.match_uid(i) from generate_series(1,5) i;
insert into auth.sessions(id,user_id) values('a2000000-0000-4000-8000-000000000099',pg_temp.match_uid(1));
insert into storage.objects(bucket_id,name,owner_id,metadata)
  select 'profile-images',pg_temp.match_uid(i)::text||'/a3000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
    pg_temp.match_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,5) i;
set local role service_role;
do $$ declare i integer;begin
  for i in 1..5 loop perform public.record_naver_session('reopen-sql-'||i,pg_temp.match_uid(i),pg_temp.match_session(i));end loop;
end $$;
reset role;
set local role authenticated;
do $$ declare i integer;begin
  for i in 1..5 loop
    perform pg_temp.match_actor(i);
    assert public.complete_naver_signup(pg_temp.match_uid(i)::text||'/a3000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
  end loop;
end $$;
reset role;


create temp table reopen_case(p uuid,r2 uuid,r3 uuid,r4 uuid,r5 uuid,ap uuid,new_ap uuid,input jsonb,old_start timestamptz,old_end timestamptz,message_id uuid);
grant all on reopen_case to authenticated;
set local role authenticated;
do $$ declare p uuid:=gen_random_uuid();input jsonb:=pg_temp.match_input(1);r2 uuid;r3 uuid;r4 uuid;r5 uuid;c jsonb;ap uuid;m uuid:=gen_random_uuid();begin
 perform pg_temp.match_actor(1);perform public.create_service_post(p,input);
 perform pg_temp.match_actor(2);r2:=(public.request_service_post(p,gen_random_uuid(),'첫 신청')->>'id')::uuid;
 perform pg_temp.match_actor(3);r3:=(public.request_service_post(p,m,'복원할 첫 채팅')->>'id')::uuid;
 perform pg_temp.match_actor(4);r4:=(public.request_service_post(p,gen_random_uuid(),'거절할 신청')->>'id')::uuid;
 perform pg_temp.match_actor(5);r5:=(public.request_service_post(p,gen_random_uuid(),'본인 철회 신청')->>'id')::uuid;perform public.withdraw_join_request(r5);
 perform pg_temp.match_actor(1);perform public.decline_join_request(r4);c:=public.propose_match(r2);
 perform pg_temp.match_actor(2);ap:=(public.accept_match(r2,c->>'conditionVersion')->>'appointmentId')::uuid;
 insert into reopen_case values(p,r2,r3,r4,r5,ap,null,input,(input->>'startsAt')::timestamptz,(input->>'endsAt')::timestamptz,m);
 perform pg_temp.match_actor(3);assert not(select can_send from public.get_conversation(r3));
 perform pg_temp.match_actor(1);perform pg_temp.expect_failure(format('select public.reopen_service_post(%L)',p),array['40001']);
 perform pg_temp.match_actor(2);perform public.cancel_appointment(ap,gen_random_uuid(),'합성 사유 취소');
 perform pg_temp.expect_failure(format('select public.reopen_service_post(%L)',p),array['P0002']);
end $$;
reset role;
do $$ declare c reopen_case;begin select * into c from reopen_case;
 assert(select status='closed' from public.posts where id=c.p);
 assert(select status='not_selected' from public.join_requests where id=c.r3);
 assert(select status='declined' from public.join_requests where id=c.r4);
 assert(select status='withdrawn' and withdrawn_at is not null from public.join_requests where id=c.r5);
 assert(select cancelled_starts_at=c.old_start and cancelled_ends_at=c.old_end and schedule_provenance='captured_at_cancellation' from private.appointment_cancellations where appointment_id=c.ap);
 perform pg_temp.expect_failure(format('update private.appointment_cancellations set cancelled_ends_at=null where appointment_id=%L',c.ap),array['23514']);
 -- 이전 철회 후 유효 재신청의 철회 시각은 지우지 않는다. 현 상태만 복원 판단에 사용한다.
 update public.join_requests set withdrawn_at=clock_timestamp()-interval '2 minutes' where id=c.r3;
 insert into private.conversation_visibility(user_id,request_id) values(pg_temp.match_uid(3),c.r3);
end $$;
select 'PASS 모집 종료/거절/철회 구분, 취소만으로 재개하지 않음, 취소 snapshot';

set local role authenticated;
do $$ declare c reopen_case;result jsonb;n integer;begin select * into c from reopen_case;perform pg_temp.match_actor(1);
 result:=public.reopen_service_post(c.p);assert result->>'status'='recruiting' and (result->>'restoredCount')::int=1 and result->>'alreadyReopened'='false';
 result:=public.reopen_service_post(c.p);assert result->>'alreadyReopened'='true' and (result->>'restoredCount')::int=0;
 perform pg_temp.match_actor(3);assert(select can_send from public.get_conversation(c.r3));
 assert (public.request_service_post(c.p,c.message_id,'복원할 첫 채팅')->>'id')::uuid=c.r3;
 perform public.send_conversation_message(c.r3,gen_random_uuid(),'복원된 기존 채팅');
end $$;
reset role;
do $$ declare c reopen_case;begin select * into c from reopen_case;
 assert(select status='pending' and withdrawn_at is not null from public.join_requests where id=c.r3);
 assert(select status='matched' from public.join_requests where id=c.r2);
 assert(select count(*)=1 from private.first_chat_applications where message_id=c.message_id and request_id=c.r3);
 assert not exists(select 1 from private.conversation_visibility where request_id=c.r3);
 assert(select count(*)=2 from public.notifications where join_request_id=c.r3 and kind='recruitment_reopened');
 assert(select count(*)=1 from private.match_lifecycle_events where request_id=c.r3 and kind='recruitment_reopened');
end $$;
select 'PASS 명시 재개/동일 채팅/첫 메시지 receipt/이력/알림 및 반복 재개';

-- 모집 기한이 지나면 자동 연장하지 않는다. 작성자가 직접 수정한 뒤 재개한다.
update public.posts set status='closed',recruitment_ends_at=clock_timestamp()-interval '1 minute' where id=(select p from reopen_case);
set local role authenticated;
do $$ declare c reopen_case;v_input jsonb;result jsonb;begin select * into c from reopen_case;perform pg_temp.match_actor(1);
 perform pg_temp.expect_failure(format('select public.reopen_service_post(%L)',c.p),array['40001']);
 v_input:=c.input||jsonb_build_object('startsAt',c.old_start+interval '1 day','endsAt',c.old_end+interval '1 day','recruitmentEndsAt',c.old_start);
 -- 조회 계약과 별개로 optimistic version은 공고 입력에 저장된 시각을 사용한다.
 update reopen_case set input=v_input;
end $$;
reset role;
-- 공개 get_service_post 반환은 updatedAt 대신 snapshot 등을 사용할 수 있으므로 실제 DB version만 합성 fixture로 전달한다.
alter table reopen_case add column expected timestamptz;
update reopen_case set expected=(select updated_at from public.posts where id=p);
set local role authenticated;
do $$ declare c reopen_case;result jsonb;begin select * into c from reopen_case;perform pg_temp.match_actor(1);
 perform public.update_service_post(c.p,c.input,c.expected);perform public.reopen_service_post(c.p);
 assert(select post_starts_at=c.old_start and post_ends_at=c.old_end from public.get_appointment_state(c.ap));
 assert(select post_starts_at=c.old_start and post_ends_at=c.old_end from public.list_my_appointments() where appointment_id=c.ap);
 result:=public.get_appointment_change_state(c.ap);
 assert (result->>'startsAt')::timestamptz=c.old_start and result->>'scheduleProvenance'='captured_at_cancellation';
 result:=public.propose_match(c.r3);perform pg_temp.match_actor(3);
 update reopen_case set new_ap=(public.accept_match(c.r3,result->>'conditionVersion')->>'appointmentId')::uuid;
end $$;
reset role;
do $$ declare c reopen_case;begin select * into c from reopen_case;
 assert c.new_ap<>c.ap;
 assert(select count(*)=2 from public.appointments where post_id=c.p);
 assert(select status='cancelled' from public.appointments where id=c.ap);
 assert(select count(*)=1 from public.appointments where post_id=c.p and status<>'cancelled');
end $$;
select 'PASS 기한 갱신 후 재개/취소 과거 일정 유지/새 약속 확정';

-- 이전 snapshot 없는 취소는 새 공고 일정을 과거 일정으로 노출하지 않는다.
update private.appointment_cancellations set cancelled_starts_at=null,cancelled_ends_at=null,cancelled_post_updated_at=null,schedule_provenance='unknown' where appointment_id=(select ap from reopen_case);
set local role authenticated;
do $$ declare c reopen_case;begin select * into c from reopen_case;perform pg_temp.match_actor(1);
 assert(select post_starts_at is null and post_ends_at is null from public.get_appointment_state(c.ap));
 assert(select post_starts_at is null and post_ends_at is null from public.list_my_appointments() where appointment_id=c.ap);
 assert public.get_appointment_change_state(c.ap)->>'scheduleProvenance'='unknown';
 perform pg_temp.expect_failure(format('select public.reopen_service_post(%L)',c.p),array['40001']);
end $$;
reset role;
select 'PASS 이전 미상 일정 구분 및 새 활성 약속 재개 차단';

-- 차단된 종료 신청은 명시 모집 재개로도 자동 복원하지 않는다.
set local role authenticated;
do $$ declare p uuid:=gen_random_uuid();r2 uuid;r3 uuid;c jsonb;ap uuid;begin
 perform pg_temp.match_actor(1);perform public.create_service_post(p,pg_temp.match_input(2));
 perform pg_temp.match_actor(2);r2:=(public.request_service_post(p,gen_random_uuid(),'확정할 신청')->>'id')::uuid;
 perform pg_temp.match_actor(3);r3:=(public.request_service_post(p,gen_random_uuid(),'차단된 종료 신청')->>'id')::uuid;
 perform pg_temp.match_actor(1);c:=public.propose_match(r2);
 perform pg_temp.match_actor(2);ap:=(public.accept_match(r2,c->>'conditionVersion')->>'appointmentId')::uuid;
 perform public.cancel_appointment(ap,gen_random_uuid(),'합성 취소');
 insert into matching_cases(name,post_id,r1,r2) values('blocked',p,r2,r3);
end $$;
reset role;
insert into private.member_blocks(blocker_id,blocked_id) values(pg_temp.match_uid(1),pg_temp.match_uid(3));
set local role authenticated;
do $$ declare p uuid;result jsonb;begin select post_id into p from matching_cases where name='blocked';perform pg_temp.match_actor(1);
 result:=public.reopen_service_post(p);assert (result->>'restoredCount')::int=0;
end $$;
reset role;
do $$ begin assert(select status='not_selected' from public.join_requests where id=(select r2 from matching_cases where name='blocked'));end $$;
select 'PASS 차단된 종료 신청 자동 복원 제외';
-- 현행 partial unique는 pending만 제한하므로 같은 회원의 과거 종료 이력이 공존할 수 있다.
insert into public.join_requests(post_id,requester_id,message,status)
 select post_id,pg_temp.match_uid(4),'합성 구 자료 거절','declined' from matching_cases where name='blocked';
insert into public.join_requests(post_id,requester_id,message,status)
 select post_id,pg_temp.match_uid(4),'합성 구 자료 모집 종료','not_selected' from matching_cases where name='blocked';
insert into public.join_requests(post_id,requester_id,message,status,created_at)
 select post_id,pg_temp.match_uid(5),'합성 구 자료 본인 철회','withdrawn',clock_timestamp()+interval '1 minute' from matching_cases where name='blocked';
insert into public.join_requests(post_id,requester_id,message,status)
 select post_id,pg_temp.match_uid(5),'합성 구 자료 모집 종료','not_selected' from matching_cases where name='blocked';
update public.posts set status='closed' where id=(select post_id from matching_cases where name='blocked');
set local role authenticated;
do $$ declare p uuid;result jsonb;begin select post_id into p from matching_cases where name='blocked';perform pg_temp.match_actor(1);
 result:=public.reopen_service_post(p);assert (result->>'restoredCount')::int=0;
end $$;
reset role;
do $$ begin assert(select count(*)=2 from public.join_requests where post_id=(select post_id from matching_cases where name='blocked')
 and requester_id in(pg_temp.match_uid(4),pg_temp.match_uid(5)) and status='not_selected');end $$;
select 'PASS 구 자료 다른 신청의 현재 거절/철회 상태 복원 제외';
-- 동일 회원의 여러 종료 이력: 현재 pending을 보존하고 전체 최신 유효 종료 신청만 복원한다.
create temp table legacy_reopen(p uuid,pending_request uuid,older_request uuid,newest_request uuid,valid_reapplication uuid,new_ap uuid);
grant all on legacy_reopen to authenticated;
do $$ declare p uuid;pending_id uuid;newest uuid;valid uuid;old_id uuid;begin
 select post_id,r2 into p,old_id from matching_cases where name='blocked';
 insert into public.join_requests(post_id,requester_id,message,status)
 values(p,pg_temp.match_uid(2),'합성 현재 유효 신청','pending') returning id into pending_id;
 insert into public.join_requests(post_id,requester_id,message,status,created_at)
 values(p,pg_temp.match_uid(2),'합성 과거 종료 보존','not_selected',clock_timestamp()+interval '10 seconds');
 insert into public.join_requests(post_id,requester_id,message,status,created_at)
 values(p,pg_temp.match_uid(3),'합성 최신 종료 신청','not_selected',clock_timestamp()+interval '10 seconds') returning id into newest;
 insert into public.join_requests(post_id,requester_id,message,status,created_at)
 values(p,pg_temp.match_uid(5),'합성 철회 후 최신 재신청 종료','not_selected',clock_timestamp()+interval '2 minutes') returning id into valid;
 insert into legacy_reopen values(p,pending_id,old_id,newest,valid,null);
 update public.posts set status='closed' where id=p;
end $$;
set local role authenticated;
do $$ declare c legacy_reopen;result jsonb;begin select * into c from legacy_reopen;perform pg_temp.match_actor(1);
 perform public.unblock_member(pg_temp.match_uid(3));
 result:=public.reopen_service_post(c.p);assert (result->>'restoredCount')::int=2;
end $$;
reset role;
do $$ declare c legacy_reopen;begin select * into c from legacy_reopen;
 assert(select status='pending' from public.join_requests where id=c.pending_request);
 assert(select status='not_selected' from public.join_requests where id=c.older_request);
 assert(select status='pending' from public.join_requests where id=c.newest_request);
 assert(select status='pending' from public.join_requests where id=c.valid_reapplication);
 assert(select count(*)=3 from public.join_requests where post_id=c.p and status='pending');
end $$;
set local role authenticated;
do $$ declare c legacy_reopen;result jsonb;begin select * into c from legacy_reopen;perform pg_temp.match_actor(1);
 result:=public.propose_match(c.newest_request);perform pg_temp.match_actor(3);
 update legacy_reopen set new_ap=(public.accept_match(c.newest_request,result->>'conditionVersion')->>'appointmentId')::uuid;
end $$;
reset role;
do $$ declare c legacy_reopen;begin select * into c from legacy_reopen;
 assert(select status='confirmed' from public.appointments where id=c.new_ap);
 assert(select status='not_selected' from public.join_requests where id=c.valid_reapplication);
 assert(select count(*)=2 from public.appointments where post_id=c.p);
end $$;
select 'PASS pending 공존/최신 종료 하나만 복원/과거 철회 후 유효 재신청/후속 재확정';


-- 삭제·시작 경과 공고는 재개하지 않는다.
set local role authenticated;
do $$ declare p uuid:=gen_random_uuid();begin perform pg_temp.match_actor(1);perform public.create_service_post(p,pg_temp.match_input(3));
 insert into matching_cases(name,post_id) values('gate',p);end $$;
reset role;
update public.posts set status='closed',starts_at=clock_timestamp()-interval '1 minute',recruitment_ends_at=clock_timestamp()-interval '2 minutes' where id=(select post_id from matching_cases where name='gate');
set local role authenticated;
do $$ declare p uuid;begin select post_id into p from matching_cases where name='gate';perform pg_temp.match_actor(1);
 perform pg_temp.expect_failure(format('select public.reopen_service_post(%L)',p),array['40001']);end $$;
reset role;
update public.posts set status='deleted' where id=(select post_id from matching_cases where name='gate');
set local role authenticated;
do $$ declare p uuid;begin select post_id into p from matching_cases where name='gate';perform pg_temp.match_actor(1);
 perform pg_temp.expect_failure(format('select public.reopen_service_post(%L)',p),array['P0002']);end $$;
reset role;
select 'PASS 시작 경과/삭제 재개 차단';
set local role anon;
select pg_temp.expect_failure('select public.reopen_service_post(gen_random_uuid())',array['42501']);
reset role;
select 'PASS 익명 실행 권한 제외';
rollback;
