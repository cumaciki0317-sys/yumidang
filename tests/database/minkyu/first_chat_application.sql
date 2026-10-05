-- 민규 전용 로컬 합성 자료. 실제 역할·세션·RPC를 검사하고 모든 자료를 rollback한다.
begin;
-- schema-only 격리 DB의 필수 Storage metadata만 준비한다. 객체 파일·운영 자료는 만들지 않는다.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('profile-images','profile-images',false,5242880,array['image/jpeg','image/png','image/webp'])
  on conflict(id) do nothing;
set local storage.allow_delete_query='true';
create function pg_temp.first_uid(n integer) returns uuid language sql immutable as $$
  select ('91000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.first_session(n integer) returns uuid language sql immutable as $$
  select ('92000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.first_actor(n integer,unregistered boolean default false) returns void language plpgsql as $$
declare u uuid:=pg_temp.first_uid(n);s uuid:=case when unregistered then '92000000-0000-4000-8000-000000000099'::uuid else pg_temp.first_session(n) end;
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
  for i in 1..5 loop perform public.resolve_naver_account('firstchat-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;
end $$;
reset role;

insert into auth.users(id,email) select pg_temp.first_uid(i),a.auth_email from generate_series(1,5) i
  join private.naver_accounts a on a.subject='firstchat-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.first_session(i),pg_temp.first_uid(i) from generate_series(1,5) i;
insert into auth.sessions(id,user_id) values('92000000-0000-4000-8000-000000000099',pg_temp.first_uid(1));
insert into storage.objects(bucket_id,name,owner_id,metadata)
  select 'profile-images',pg_temp.first_uid(i)::text||'/93000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
    pg_temp.first_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,5) i;
set local role service_role;
do $$ declare i integer;begin
  for i in 1..5 loop perform public.record_naver_session('firstchat-sql-'||i,pg_temp.first_uid(i),pg_temp.first_session(i));end loop;
end $$;
reset role;
set local role authenticated;
do $$ declare i integer;begin
  for i in 1..5 loop
    perform pg_temp.first_actor(i);
    assert public.complete_naver_signup(pg_temp.first_uid(i)::text||'/93000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
  end loop;
end $$;
reset role;

do $$ begin
  assert has_function_privilege('authenticated','public.request_service_post(uuid,uuid,text)','EXECUTE');
  assert not has_function_privilege('anon','public.request_service_post(uuid,uuid,text)','EXECUTE');
  assert not has_function_privilege('authenticated','public.request_service_post(uuid,text)','EXECUTE');
  assert not has_function_privilege('authenticated','public.create_join_request(uuid,text)','EXECUTE');
  assert not has_table_privilege('authenticated','private.first_chat_applications','SELECT');
end; $$;

create temp table first_chat_results(post_id uuid,request_id uuid,message_id uuid);
grant all on first_chat_results to authenticated;
set local role authenticated;
do $$ declare p uuid; a jsonb; b jsonb; m uuid:=gen_random_uuid(); begin
  perform pg_temp.first_actor(1);
  p:=gen_random_uuid(); perform public.create_service_post(p,pg_temp.first_input(1));
  perform pg_temp.expect_failure(format('select public.request_service_post(%L,%L,%L)',p,m,'내 공고'),array['42501']);
  perform pg_temp.first_actor(2);
  a:=public.request_service_post(p,m,'안');
  assert a->>'status'='pending' and a->>'alreadySent'='false';
  assert (select count(*) from public.chat_messages where join_request_id=(a->>'id')::uuid)=1;
  assert public.list_conversation_messages((a->>'id')::uuid,10)#>>'{items,0,content}'='안';
  b:=public.request_service_post(p,m,'안');
  assert b->>'alreadySent'='true' and b->>'id'=a->>'id';
  perform pg_temp.expect_failure(format('select public.request_service_post(%L,%L,%L)',p,m,'변조'),array['40001']);
  perform pg_temp.expect_failure(format('select public.create_join_request(%L,%L)',p,'구형 신청 소개'),array['42501']);
  perform pg_temp.expect_failure(format('select public.request_service_post(%L,%L)',p,'구형 신청 소개'),array['42501']);
  perform public.leave_conversation((a->>'id')::uuid);
  perform public.withdraw_join_request((a->>'id')::uuid);
  b:=public.request_service_post(p,m,'안');
  assert b->>'alreadySent'='true';
  assert (select status from public.join_requests where id=(a->>'id')::uuid)='withdrawn','retry reactivated request';
  perform pg_temp.expect_failure(format('select public.request_service_post(%L,%L,%L)',p,gen_random_uuid(),'재신청'),array['40001']);
  insert into first_chat_results values(p,(a->>'id')::uuid,m);
end; $$;
reset role;
update public.join_requests set withdrawn_at=clock_timestamp()-interval '61 seconds'
  where id=(select request_id from first_chat_results);
set local role authenticated;
do $$ declare f first_chat_results; a jsonb; begin
  select * into f from first_chat_results;
  perform pg_temp.first_actor(2);
  a:=public.request_service_post(f.post_id,gen_random_uuid(),'재신청 채팅');
  assert (a->>'id')::uuid=f.request_id and a->>'already_existed'='true','new conversation created';
  assert (select count(*) from public.chat_messages where join_request_id=f.request_id)=2;
  assert (select message from public.join_requests where id=f.request_id)='안','historical header replaced';
  assert exists(select 1 from public.list_conversations() where request_id=f.request_id),'conversation remains hidden';
  perform pg_temp.first_actor(1); perform public.decline_join_request(f.request_id);
  perform pg_temp.first_actor(2);
  perform pg_temp.expect_failure(format('select public.request_service_post(%L,%L,%L)',f.post_id,gen_random_uuid(),'거절 후 재신청'),array['42501']);
end; $$;
reset role;

-- 실제 chat insert 오류가 신청·알림까지 rollback하는지 확인한다.
create function pg_temp.reject_first_chat() returns trigger language plpgsql as $$ begin
  if new.content='강제 저장 실패' then raise exception 'fixture_chat_rejected' using errcode='23514'; end if;
  return new;
end; $$;
create trigger fixture_chat_rejected before insert on public.chat_messages
  for each row execute function pg_temp.reject_first_chat();
set local role authenticated;
do $$ declare p uuid; begin
  perform pg_temp.first_actor(1);p:=gen_random_uuid();perform public.create_service_post(p,pg_temp.first_input(2));
  perform pg_temp.first_actor(3);
  perform pg_temp.expect_failure(format('select public.request_service_post(%L,%L,%L)',p,gen_random_uuid(),'강제 저장 실패'),array['23514']);
  assert not exists(select 1 from public.join_requests where post_id=p),'request committed without message';
  perform pg_temp.first_actor(3,true);
  perform pg_temp.expect_failure(format('select public.request_service_post(%L,%L,%L)',p,gen_random_uuid(),'세션 미등록'),array['28000']);
end; $$;
reset role;
rollback;
