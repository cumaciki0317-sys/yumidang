-- 민규 전용 로컬 합성 자료. 실제 역할·세션·RPC를 검사하고 모든 자료를 rollback한다.
begin;
set local storage.allow_delete_query='true';
create function pg_temp.match_uid(n integer) returns uuid language sql immutable as $$
  select ('81000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.match_session(n integer) returns uuid language sql immutable as $$
  select ('82000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.match_actor(n integer,unregistered boolean default false) returns void language plpgsql as $$
declare u uuid:=pg_temp.match_uid(n);s uuid:=case when unregistered then '82000000-0000-4000-8000-000000000099'::uuid else pg_temp.match_session(n) end;
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
  for i in 1..5 loop perform public.resolve_naver_account('matching-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;
end $$;
reset role;
insert into auth.users(id,email) select pg_temp.match_uid(i),a.auth_email from generate_series(1,5) i
  join private.naver_accounts a on a.subject='matching-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.match_session(i),pg_temp.match_uid(i) from generate_series(1,5) i;
insert into auth.sessions(id,user_id) values('82000000-0000-4000-8000-000000000099',pg_temp.match_uid(1));
insert into storage.objects(bucket_id,name,owner_id,metadata)
  select 'profile-images',pg_temp.match_uid(i)::text||'/83000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
    pg_temp.match_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,5) i;
set local role service_role;
do $$ declare i integer;begin
  for i in 1..5 loop perform public.record_naver_session('matching-sql-'||i,pg_temp.match_uid(i),pg_temp.match_session(i));end loop;
end $$;
reset role;
set local role authenticated;
do $$ declare i integer;begin
  for i in 1..5 loop
    perform pg_temp.match_actor(i);
    assert public.complete_naver_signup(pg_temp.match_uid(i)::text||'/83000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
  end loop;
end $$;
reset role;

do $$ begin
  assert has_function_privilege('authenticated','public.update_service_post(uuid,jsonb,timestamp with time zone)','EXECUTE');
  assert has_function_privilege('authenticated','public.withdraw_match_consent(uuid,text)','EXECUTE');
  assert not has_function_privilege('anon','public.propose_match(uuid)','EXECUTE');
  assert not has_function_privilege('authenticated','public.expire_match_consents(integer)','EXECUTE');
  assert has_function_privilege('service_role','public.expire_match_consents(integer)','EXECUTE');
  assert not has_function_privilege('authenticated','private.end_match_consent(uuid,text)','EXECUTE');
  assert not has_table_privilege('authenticated','private.match_consent_lifecycle','UPDATE');
  assert not has_table_privilege('service_role','private.match_lifecycle_events','SELECT');
end $$;
set local role authenticated;
select pg_temp.match_actor(1,true);
do $$ begin
  perform pg_temp.expect_failure(format('select public.create_service_post(%L,%L::jsonb)',gen_random_uuid(),pg_temp.match_input(1)),array['28000']);
  perform pg_temp.expect_failure('select public.expire_match_consents(10)',array['42501']);
  perform pg_temp.expect_failure('select public.confirm_match(''84000000-0000-4000-8000-000000000099'')',array['42501']);
  perform pg_temp.expect_failure('select 1 from private.match_consent_lifecycle',array['42501']);
end $$;
reset role;
select 'MATCHING_CHECK:acl_naver_direct_bypass';

-- 공고당 활성 동의 한 명. 그 밖의 신청·채팅은 종료하지 않는다.
set local role authenticated;
do $$ declare p uuid:=gen_random_uuid();a jsonb;b jsonb;c jsonb;begin
  perform pg_temp.match_actor(1);
  insert into matching_cases(name,post_id,input) values('single',p,pg_temp.match_input(2));
  perform public.create_service_post(p,(select input from matching_cases where name='single'));
  perform pg_temp.match_actor(2);a:=public.request_service_post(p,'첫 가상 동행 신청');
  perform pg_temp.match_actor(3);b:=public.request_service_post(p,'둘째 가상 동행 신청');
  update matching_cases set r1=(a->>'id')::uuid,r2=(b->>'id')::uuid where name='single';
  perform pg_temp.match_actor(1);c:=public.propose_match((a->>'id')::uuid);
  update matching_cases set version=c->>'conditionVersion' where name='single';
  assert c->>'status'='awaiting_consent' and c?'requestedAt' and c?'expiresAt';
  assert (c->>'expiresAt')::timestamptz=(c->>'requestedAt')::timestamptz+interval '24 hours';
  assert public.propose_match((a->>'id')::uuid)->>'conditionVersion'=c->>'conditionVersion';
  perform pg_temp.expect_failure(format('select public.propose_match(%L)',b->>'id'),array['40001']);
  perform pg_temp.match_actor(3);
  assert public.send_conversation_message((b->>'id')::uuid,gen_random_uuid(),'계속 대화할 수 있음')->>'alreadySent'='false';
  assert (select can_send from public.get_conversation((b->>'id')::uuid));
  assert not(public.get_service_post(p)?'privateDetails');
end $$;
reset role;
do $$ declare x matching_cases;begin
  select * into x from matching_cases where name='single';
  assert (select count(*) from private.match_consent_lifecycle where post_id=x.post_id and status='awaiting_consent')=1;
  assert (select count(*) from public.join_requests where post_id=x.post_id and status='pending')=2;
  assert not exists(select 1 from public.appointments where post_id=x.post_id);
  assert (select count(*) from public.notifications where join_request_id=x.r1 and kind='match_consent_requested')=2;
end $$;
select 'MATCHING_CHECK:single_active_pending_chats';

-- 동의 철회/거절은 신청 철회/거절과 구분하며 새 버전 재요청을 허용한다.
set local role authenticated;
do $$ declare x matching_cases;c jsonb;d jsonb;begin
  select * into x from matching_cases where name='single';
  perform pg_temp.match_actor(2);
  perform pg_temp.expect_failure(format('select public.withdraw_match_consent(%L,%L)',x.r1,x.version),array['P0002']);
  perform pg_temp.match_actor(1);
  d:=public.withdraw_match_consent(x.r1,x.version);assert d->>'status'='withdrawn' and d->>'alreadyEnded'='false';
  assert public.withdraw_match_consent(x.r1,x.version)->>'alreadyEnded'='true';
  c:=public.propose_match(x.r1);assert c->>'conditionVersion'<>x.version;
  perform pg_temp.match_actor(2);
  d:=public.decline_match_consent(x.r1,c->>'conditionVersion');assert d->>'status'='declined';
  assert (select can_send from public.get_conversation(x.r1));
  assert public.send_conversation_message(x.r1,gen_random_uuid(),'동의 거절 후에도 대화 유지')->>'alreadySent'='false';
  perform pg_temp.match_actor(1);c:=public.propose_match(x.r1);
  update matching_cases set version=c->>'conditionVersion' where name='single';
end $$;
reset role;
do $$ declare x matching_cases;begin select * into x from matching_cases where name='single';
  assert (select status from public.join_requests where id=x.r1)='pending';
  assert (select count(*) from public.notifications where join_request_id=x.r1 and kind='match_consent_ended')=2;
  assert (select count(*) from private.match_lifecycle_events where request_id=x.r1 and kind='match_consent_ended')=2;
end $$;
select 'MATCHING_CHECK:withdraw_decline_consent_not_application';

-- 만료는 요청+24시간/시작의 최소값. 늦은 동의는 실패하고 유효 신청은 재요청한다.
update private.match_consent_lifecycle set requested_at=clock_timestamp()-interval '25 hours',expires_at=clock_timestamp()-interval '1 hour'
  where request_id=(select r1 from matching_cases where name='single');
set local role authenticated;
do $$ declare x matching_cases;c jsonb;begin select * into x from matching_cases where name='single';
  perform pg_temp.match_actor(2);assert public.get_match_consent(x.r1)->>'status'='expired';
  perform pg_temp.expect_failure(format('select public.accept_match(%L,%L)',x.r1,x.version),array['40001']);
  perform pg_temp.match_actor(1);c:=public.propose_match(x.r1);assert c->>'conditionVersion'<>x.version;
  update matching_cases set version=c->>'conditionVersion' where name='single';
end $$;
reset role;
set local role authenticated;
do $$ declare p uuid:=gen_random_uuid();i jsonb;a jsonb;c jsonb;begin
  i:=pg_temp.match_input(1)||jsonb_build_object('startsAt',clock_timestamp()+interval '2 hours','endsAt',clock_timestamp()+interval '3 hours','recruitmentEndsAt',clock_timestamp()+interval '1 hour');
  perform pg_temp.match_actor(1);perform public.create_service_post(p,i);
  perform pg_temp.match_actor(4);a:=public.request_service_post(p,'시작 우선 만료 검증 신청');
  perform pg_temp.match_actor(1);c:=public.propose_match((a->>'id')::uuid);
  assert (c->>'expiresAt')::timestamptz=(i->>'startsAt')::timestamptz;
  insert into matching_cases(name,post_id,input,r1,version) values('short-expiry',p,i,(a->>'id')::uuid,c->>'conditionVersion');
end $$;
reset role;
update private.match_consent_lifecycle set requested_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 minute'
  where request_id=(select r1 from matching_cases where name='short-expiry');
set local role service_role;
do $$ begin assert public.expire_match_consents(100)->>'expiredCount'='1';assert public.expire_match_consents(100)->>'expiredCount'='0';end $$;
reset role;
select 'MATCHING_CHECK:expiry_reproposal_version';

-- 핵심 변경은 동의를 무효화하며 신청/대화 보존. 오래된 timestamp·타인 수정 차단.
set local role authenticated;
do $$ declare x matching_cases;r jsonb;t timestamptz;i jsonb;begin select * into x from matching_cases where name='single';
  perform pg_temp.match_actor(1);r:=public.get_service_post(x.post_id);t:=(r->>'updatedAt')::timestamptz;
  assert t is not null;update matching_cases set old_updated=t where name='single';
  i:=x.input||jsonb_build_object('title','수정된 가상 조건','description','변경된 활동 내용','meetingDetail','새 비공개 입구');
  r:=public.update_service_post(x.post_id,i,t);assert r->>'postId'=x.post_id::text;
  perform pg_temp.expect_failure(format('select public.update_service_post(%L,%L::jsonb,%L::timestamptz)',x.post_id,i||'{"title":"오래된 재수정"}'::jsonb,t),array['40001']);
  perform pg_temp.match_actor(2);assert public.get_match_consent(x.r1)->>'status'='invalidated';
  perform pg_temp.expect_failure(format('select public.accept_match(%L,%L)',x.r1,x.version),array['40001']);
  assert (select can_send from public.get_conversation(x.r1));
  perform pg_temp.expect_failure(format('select public.update_service_post(%L,%L::jsonb,%L::timestamptz)',x.post_id,i,t),array['P0002']);
  perform pg_temp.match_actor(5);perform pg_temp.expect_failure(format('select public.get_match_consent(%L)',x.r1),array['P0002']);
  perform pg_temp.match_actor(1);r:=public.get_service_post(x.post_id);t:=(r->>'updatedAt')::timestamptz;
  -- 비핵심 모집 마감 시각만 바꾸어도 timestamp 동시 수정 검사는 유지한다.
  i:=i||jsonb_build_object('recruitmentEndsAt',clock_timestamp()+interval '1 day');
  perform public.update_service_post(x.post_id,i,t);
  update matching_cases set input=i where name='single';
end $$;
reset role;
do $$ declare x matching_cases;begin select * into x from matching_cases where name='single';
  assert (select count(*) from public.join_requests where post_id=x.post_id and status='pending')=2;
  assert (select count(*) from public.notifications where kind='post_conditions_changed' and join_request_id in(x.r1,x.r2))=4;
  assert (select count(*) from public.chat_messages where join_request_id in(x.r1,x.r2))>=2;
  assert not exists(select 1 from public.notifications where kind='post_conditions_changed' and event_data::text~'비공개|가상주소');
end $$;
select 'MATCHING_CHECK:core_update_invalidation_optimistic';

-- 수동 마감은 새 신청만 차단하고 기존 신청은 제안/거절/재요청/수락 가능.
set local role authenticated;
do $$ declare x matching_cases;c jsonb;begin select * into x from matching_cases where name='single';
  perform pg_temp.match_actor(1);assert public.close_service_post(x.post_id)->>'status'='closed';
  perform pg_temp.match_actor(4);perform pg_temp.expect_failure(format('select public.request_service_post(%L,''마감 후 새 신청'')',x.post_id),array['40001']);
  perform pg_temp.match_actor(1);c:=public.propose_match(x.r1);
  perform pg_temp.match_actor(2);assert public.decline_match_consent(x.r1,c->>'conditionVersion')->>'status'='declined';
  perform pg_temp.match_actor(1);c:=public.propose_match(x.r1);update matching_cases set version=c->>'conditionVersion' where name='single';
  perform pg_temp.match_actor(2);assert public.accept_match(x.r1,c->>'conditionVersion')->>'alreadyConfirmed'='false';
end $$;
reset role;
select 'MATCHING_CHECK:closed_existing_request_finalization';

-- 확정은 한 건, 미선정 대화 읽기 전용, 비밀 주소/실명 제외, 알림 중복 금지.
set local role authenticated;
do $$ declare x matching_cases;r jsonb;begin select * into x from matching_cases where name='single';
  perform pg_temp.match_actor(2);assert public.accept_match(x.r1,x.version)->>'alreadyConfirmed'='true';
  assert public.get_service_post(x.post_id)?'privateDetails';
  perform pg_temp.match_actor(3);r:=public.get_service_post(x.post_id);assert not(r?'privateDetails') and not(r?'participantNames');
  assert not(select can_send from public.get_conversation(x.r2));
  assert jsonb_array_length(public.list_conversation_messages(x.r2,10)->'items')>=1;
  perform pg_temp.expect_failure(format('select public.send_conversation_message(%L,%L,''종료 후 전송'')',x.r2,gen_random_uuid()),array['42501']);
  perform pg_temp.expect_failure(format('select public.accept_match(%L,%L)',x.r2,x.version),array['40001']);
  perform pg_temp.match_actor(1);perform pg_temp.expect_failure(format('select public.delete_service_post(%L)',x.post_id),array['40001']);
end $$;
reset role;
do $$ declare x matching_cases;begin select * into x from matching_cases where name='single';
  assert (select count(*) from public.appointments where post_id=x.post_id)=1;
  assert (select status from public.join_requests where id=x.r2)='not_selected';
  assert (select count(*) from public.notifications where join_request_id=x.r1 and kind='match_confirmed')=2;
  assert (select count(*) from public.notifications where join_request_id=x.r2 and kind='match_not_selected')=2;
end $$;
select 'MATCHING_CHECK:confirmation_losers_idempotency';

-- 삭제는 숨김+미확정 관계 종료. 합성 메시지와 과거 기록은 보존한다.
set local role authenticated;
do $$ declare p uuid:=gen_random_uuid();a jsonb;c jsonb;begin
  perform pg_temp.match_actor(1);perform public.create_service_post(p,pg_temp.match_input(5));
  perform pg_temp.match_actor(4);a:=public.request_service_post(p,'삭제될 공고 기존 신청');
  perform public.send_conversation_message((a->>'id')::uuid,gen_random_uuid(),'삭제 전 보존될 메시지');
  perform pg_temp.match_actor(1);c:=public.propose_match((a->>'id')::uuid);
  assert public.delete_service_post(p)->>'status'='deleted';
  assert public.delete_service_post(p)->>'status'='deleted';
  insert into matching_cases(name,post_id,r1) values('deleted',p,(a->>'id')::uuid);
  perform pg_temp.match_actor(4);perform pg_temp.expect_failure(format('select public.get_service_post(%L)',p),array['P0002']);
  assert not(select can_send from public.get_conversation((a->>'id')::uuid));
  assert jsonb_array_length(public.list_conversation_messages((a->>'id')::uuid,10)->'items')=1;
  perform pg_temp.expect_failure(format('select public.send_conversation_message(%L,%L,''삭제 후 전송'')',a->>'id',gen_random_uuid()),array['42501']);
  perform pg_temp.expect_failure(format('select public.accept_match(%L,%L)',a->>'id',c->>'conditionVersion'),array['P0002']);
end $$;
reset role;
do $$ declare x matching_cases;begin select * into x from matching_cases where name='deleted';
  assert exists(select 1 from public.posts where id=x.post_id and status='deleted');
  assert exists(select 1 from public.join_requests where id=x.r1 and status='not_selected');
  assert (select count(*) from public.notifications where join_request_id=x.r1 and kind='post_deleted')=2;
  assert exists(select 1 from public.chat_messages where join_request_id=x.r1);
end $$;
select 'MATCHING_CHECK:deletion_visibility_read_only_preservation';

-- 본인 신청 철회는 재신청 허용, 작성자 신청 거절은 재신청 금지.
set local role authenticated;
do $$ declare p uuid:=gen_random_uuid();a jsonb;b jsonb;v_old uuid;begin
  perform pg_temp.match_actor(1);perform public.create_service_post(p,pg_temp.match_input(6));
  perform pg_temp.match_actor(4);a:=public.request_service_post(p,'철회 후 재신청할 회원');v_old:=(a->>'id')::uuid;
  perform public.send_conversation_message(v_old,gen_random_uuid(),'철회 전 메시지');
  perform public.withdraw_join_request(v_old);
  assert not(select can_send from public.get_conversation(v_old));
  b:=public.request_service_post(p,'철회 후 새 동행을 재신청합니다');
  assert (b->>'id')::uuid<>v_old;
  insert into matching_cases(name,post_id,r1,r2) values('reapply',p,v_old,(b->>'id')::uuid);
  perform pg_temp.match_actor(5);a:=public.request_service_post(p,'가상 신청 거절 검증 회원');
  perform pg_temp.match_actor(1);perform public.decline_join_request((a->>'id')::uuid);
  perform pg_temp.match_actor(5);perform pg_temp.expect_failure(format('select public.request_service_post(%L,''거절 후 재신청 시도'')',p),array['42501']);
end $$;
reset role;
do $$ declare x matching_cases;begin select * into x from matching_cases where name='reapply';
  assert exists(select 1 from public.join_requests where id=x.r1 and status='withdrawn');
  assert exists(select 1 from public.chat_messages where join_request_id=x.r1);
  assert exists(select 1 from public.join_requests where id=x.r2 and status='pending');
end $$;
select 'MATCHING_CHECK:withdraw_reapply_decline_ban';

-- 미검증/누락·타인/대체 세션은 직접 RPC 호출로 신규 활동을 우회하지 못한다.
set local role authenticated;
do $$ declare x matching_cases;begin select * into x from matching_cases where name='reapply';
  perform pg_temp.match_actor(1,true);perform pg_temp.expect_failure(format('select public.propose_match(%L)',x.r2),array['28000']);
end $$;
reset role;
set local role service_role;
select public.resolve_naver_account('matching-sql-1',null,'F','1990-01-01');
reset role;
set local role authenticated;
do $$ declare x matching_cases;begin select * into x from matching_cases where name='reapply';
  perform pg_temp.match_actor(1);assert public.get_naver_signup_state()->>'status'='information_required';
  assert public.get_my_profile()?'userId' or public.get_my_profile()?'id';
  perform pg_temp.expect_failure(format('select public.propose_match(%L)',x.r2),array['42501']);
  perform pg_temp.expect_failure(format('select public.create_service_post(%L,%L::jsonb)',gen_random_uuid(),pg_temp.match_input(7)),array['42501']);
end $$;
reset role;
set local role service_role;
select public.resolve_naver_account('matching-sql-1','합성회원1','F','1990-01-01');
reset role;
set local role authenticated;
do $$ declare x matching_cases;c jsonb;begin select * into x from matching_cases where name='reapply';
  perform pg_temp.match_actor(1);c:=public.propose_match(x.r2);update matching_cases set version=c->>'conditionVersion' where name='reapply';
end $$;
reset role;
set local role service_role;
select public.resolve_naver_account('matching-sql-4',null,'F','1990-01-01');
reset role;
set local role authenticated;
do $$ declare x matching_cases;begin select * into x from matching_cases where name='reapply';
  perform pg_temp.match_actor(4);perform pg_temp.expect_failure(format('select public.accept_match(%L,%L)',x.r2,x.version),array['42501']);
  assert (select can_send from public.get_conversation(x.r2));
end $$;
reset role;
select 'MATCHING_CHECK:information_requalification_gate';
rollback;
