-- 민규 전용 로컬 합성 자료. 실제 역할·세션·RPC를 검사하고 모든 자료를 rollback한다.
begin;
-- schema-only 격리 DB의 필수 Storage metadata만 준비한다. 객체 파일·운영 자료는 만들지 않는다.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('profile-images','profile-images',false,5242880,array['image/jpeg','image/png','image/webp'])
  on conflict(id) do nothing;
set local storage.allow_delete_query='true';
create function pg_temp.block_uid(n integer) returns uuid language sql immutable as $$
  select ('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.block_session(n integer) returns uuid language sql immutable as $$
  select ('a2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.block_actor(n integer,unregistered boolean default false) returns void language plpgsql as $$
declare u uuid:=pg_temp.block_uid(n);s uuid:=case when unregistered then 'a2000000-0000-4000-8000-000000000099'::uuid else pg_temp.block_session(n) end;
begin
  perform set_config('request.jwt.claim.sub',u::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',u,'session_id',s)::text,true);
end; $$;
create function pg_temp.block_input(n integer) returns jsonb language sql volatile as $$
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
  for i in 1..5 loop perform public.resolve_naver_account('memberblocks-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;
end $$;
reset role;

insert into auth.users(id,email) select pg_temp.block_uid(i),a.auth_email from generate_series(1,5) i
  join private.naver_accounts a on a.subject='memberblocks-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.block_session(i),pg_temp.block_uid(i) from generate_series(1,5) i;
insert into auth.sessions(id,user_id) values('a2000000-0000-4000-8000-000000000099',pg_temp.block_uid(1));
insert into storage.objects(bucket_id,name,owner_id,metadata)
  select 'profile-images',pg_temp.block_uid(i)::text||'/a3000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
    pg_temp.block_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,5) i;
set local role service_role;
do $$ declare i integer;begin
  for i in 1..5 loop perform public.record_naver_session('memberblocks-sql-'||i,pg_temp.block_uid(i),pg_temp.block_session(i));end loop;
end $$;
reset role;
set local role authenticated;
do $$ declare i integer;begin
  for i in 1..5 loop
    perform pg_temp.block_actor(i);
    assert public.complete_naver_signup(pg_temp.block_uid(i)::text||'/a3000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
  end loop;
end $$;
reset role;

-- 최신 계약은 최소 응답만 반환하며 private 원본·직접 쓰기를 통한 우회를 막는다.
-- 차단과 해제가 기존 후기 평가·한마디·공개 근거를 변경하지 않는지 실제 행을 비교한다.
create temp table block_review_before(review_id uuid,review_row jsonb,publication_row jsonb);
do $$ declare p uuid:=gen_random_uuid();r uuid:=gen_random_uuid();a uuid:=gen_random_uuid();v uuid:=gen_random_uuid();begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
    values(p,pg_temp.block_uid(1),'합성 과거 후기','차단 불변 검증','산책',now()-interval '4 days',now()-interval '3 days',now()-interval '5 days','서울특별시 강남구 역삼동','closed');
  insert into public.join_requests(id,post_id,requester_id,message,status)
    values(r,p,pg_temp.block_uid(2),'합성 과거 신청','matched');
  insert into public.appointments(id,post_id,join_request_id,status,confirmed_at,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
    values(a,p,r,'completed',now()-interval '4 days',now()-interval '2 days','automatic',now()-interval '2 days',now()-interval '1 day',now()+interval '3 days');
  insert into public.appointment_reviews(id,appointment_id,reviewer_id,rating,comment,experience)
    values(v,a,pg_temp.block_uid(1),4,'합성 보존 후기','positive');
  insert into block_review_before select v,to_jsonb(x),to_jsonb(y)
    from public.appointment_reviews x left join private.review_publication y on y.review_id=x.id where x.id=v;
end $$;
do $$ declare fn text;begin
  foreach fn in array array['private.request_service_post_without_blocks(uuid,uuid,text)',
    'private.send_conversation_message_without_blocks(uuid,uuid,text)','private.propose_match_without_blocks(uuid)',
    'private.accept_match_without_blocks(uuid,text)','private.get_public_profile_without_blocks(uuid)',
    'private.get_service_post_without_blocks(uuid)'] loop
    assert not has_function_privilege('authenticated',fn,'EXECUTE'),fn;
    assert not has_function_privilege('anon',fn,'EXECUTE'),fn;
    assert not has_function_privilege('service_role',fn,'EXECUTE'),fn;
  end loop;
  assert not has_table_privilege('authenticated','private.member_blocks','INSERT');
  assert not has_column_privilege('authenticated','public.chat_messages','content','INSERT');
  assert not has_table_privilege('authenticated','public.join_requests','INSERT');
  assert not has_function_privilege('anon','public.block_member(uuid)','EXECUTE');
  assert not has_function_privilege('service_role','public.block_member(uuid)','EXECUTE');
end $$;
create temp table block_cases(post_a uuid,post_b uuid,post_appointment uuid,request_a uuid,request_appointment uuid,appointment_id uuid,
  message_id uuid,consent_version text,original_consent jsonb);
grant all on block_cases to authenticated,anon;
set local role authenticated;
do $$ declare a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); r uuid; rc uuid; ap uuid; m uuid:=gen_random_uuid(); v jsonb;begin
  perform pg_temp.block_actor(1); perform public.create_service_post(a,pg_temp.block_input(1));
  perform public.create_service_post(c,pg_temp.block_input(3));
  perform pg_temp.block_actor(2);perform public.create_service_post(b,pg_temp.block_input(2));
  r:=(public.request_service_post(a,m,'합성 첫 채팅')->>'id')::uuid;
  rc:=(public.request_service_post(c,gen_random_uuid(),'합성 확정 약속 채팅')->>'id')::uuid;
  perform pg_temp.block_actor(1);v:=public.propose_match(rc);
  perform pg_temp.block_actor(2);ap:=(public.accept_match(rc,v->>'conditionVersion')->>'appointmentId')::uuid;
  perform pg_temp.block_actor(1);v:=public.propose_match(r);
  insert into block_cases values(a,b,c,r,rc,ap,m,v->>'conditionVersion',v);
  assert public.block_member(pg_temp.block_uid(2))=jsonb_build_object('targetId',pg_temp.block_uid(2),'blocked',true,'alreadyApplied',false);
  assert public.block_member(pg_temp.block_uid(2))->>'alreadyApplied'='true';
  assert public.block_member(pg_temp.block_uid(3))->>'blocked'='true';
  v:=public.list_my_blocks(1,null);assert jsonb_array_length(v->'items')=1;
  assert (v->>'nextCursor')::uuid=pg_temp.block_uid(2);
  assert public.list_my_blocks(1,(v->>'nextCursor')::uuid)#>>'{items,0,targetId}'=pg_temp.block_uid(3)::text;
  perform pg_temp.expect_failure(format('select public.block_member(%L)',pg_temp.block_uid(1)),array['22023']);
  perform pg_temp.expect_failure('select public.block_member(''ffffffff-ffff-4fff-8fff-ffffffffffff'')',array['PT404']);
  perform pg_temp.expect_failure(format('select public.request_service_post(%L,%L,%L)',b,gen_random_uuid(),'차단 뒤 신청'),array['42501']);
  perform pg_temp.expect_failure(format('select public.send_conversation_message(%L,%L,%L)',r,gen_random_uuid(),'차단 뒤 새 메시지'),array['42501']);
  perform pg_temp.expect_failure(format('select public.propose_match(%L)',r),array['42501']);
  assert (select can_send from public.get_conversation(r))=false;
  assert jsonb_array_length(public.list_conversation_messages(r,10)->'items')=1;
  assert exists(select 1 from public.list_my_appointments() where appointment_id=ap);
  assert (select status from public.get_appointment_state(ap))='confirmed';
  perform pg_temp.expect_failure(format('select public.get_public_profile(%L)',pg_temp.block_uid(2)),array['P0002']);
  perform pg_temp.expect_failure(format('select public.get_public_profile_reviews(%L,5,null)',pg_temp.block_uid(2)),array['P0002']);
  perform pg_temp.expect_failure(format('select public.get_visible_review_summary(%L)',pg_temp.block_uid(2)),array['P0002']);
  perform pg_temp.expect_failure(format('select public.get_service_post(%L)',b),array['P0002']);
  assert public.get_service_post(c)->>'postId'=c::text,'existing appointment context hidden';
  assert exists(select 1 from storage.objects where owner_id=pg_temp.block_uid(2)::text),'active appointment image hidden';
  assert not exists(select 1 from storage.objects where owner_id=pg_temp.block_uid(3)::text),'blocked profile image readable';
  assert public.get_post_author_traits(array[b])->'items'='[]'::jsonb;
  assert not exists(select 1 from public.get_post_author_cards(array[b]));
  assert not exists(select 1 from public.get_post_author_discovery_cards(array[b]));
  perform pg_temp.expect_failure(format('select public.get_post_author_profile(%L)',b),array['P0002']);
  assert not exists(select 1 from public.posts where id=b),'raw posts RLS bypass';
  v:=public.search_public_posts_v2('2026-10-05',null,'{}',null,10);
  assert not exists(select 1 from jsonb_array_elements(v->'items') x where x->>'id'=b::text),'search exposes blocked author';
  perform pg_temp.block_actor(2);
  perform pg_temp.expect_failure(format('select public.request_service_post(%L,%L,%L)',a,gen_random_uuid(),'반대방향 신청'),array['42501']);
  perform pg_temp.expect_failure(format('select public.send_conversation_message(%L,%L,%L)',r,gen_random_uuid(),'반대방향 메시지'),array['42501']);
  perform pg_temp.expect_failure(format('select public.accept_match(%L,%L)',r,(select consent_version from block_cases)),array['42501']);
  assert public.request_service_post(a,m,'합성 첫 채팅')->>'alreadySent'='true','historical successful retry blocked';
  assert public.get_service_post(c)->>'postId'=c::text;
  assert public.block_member(pg_temp.block_uid(1))->>'blocked'='true';
  perform pg_temp.block_actor(1);assert public.unblock_member(pg_temp.block_uid(2))->>'blocked'='false';
  perform pg_temp.expect_failure(format('select public.send_conversation_message(%L,%L,%L)',r,gen_random_uuid(),'상대 차단 유지'),array['42501']);
  perform pg_temp.block_actor(2);assert public.unblock_member(pg_temp.block_uid(1))->>'blocked'='false';
  assert public.send_conversation_message(r,gen_random_uuid(),'양쪽 해제 뒤 메시지')->>'alreadySent'='false';
  perform public.withdraw_join_request(r);
  assert public.cancel_appointment(ap,gen_random_uuid(),'합성 별도 취소')->>'status'='cancelled';
  perform public.block_member(pg_temp.block_uid(1));perform public.unblock_member(pg_temp.block_uid(1));
  assert(select status from public.join_requests where id=r)='withdrawn','unblock restored ended request';
  assert (select status from public.get_appointment_state(ap))='cancelled','unblock restored cancelled appointment';
end $$;
reset role;
-- 기존 작성자 RPC도 실제 회원 조회만 허용한다. 신규 네이버 활동 자격은 요구하지 않는다.
set local role authenticated;
do $$ declare p uuid:=(select post_a from block_cases);call_sql text;claims jsonb;begin
  foreach call_sql in array array[
    format('select * from public.get_post_author_profile(%L)',p),
    format('select * from public.get_post_author_cards(array[%L::uuid])',p),
    format('select * from public.get_post_author_discovery_cards(array[%L::uuid])',p)
  ] loop
    perform pg_temp.block_actor(1);
    perform set_config('request.jwt.claims',(auth.jwt()||'{"is_anonymous":true}'::jsonb)::text,true);
    perform pg_temp.expect_failure(call_sql,array['28000']);
    perform set_config('request.jwt.claim.sub','ffffffff-ffff-4fff-8fff-fffffffffff1',true);
    perform set_config('request.jwt.claims','{"role":"authenticated","sub":"ffffffff-ffff-4fff-8fff-fffffffffff1"}',true);
    perform pg_temp.expect_failure(call_sql,array['P0002']);
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
    perform pg_temp.expect_failure(call_sql,array['28000']);
    perform pg_temp.block_actor(1);
    perform set_config('request.jwt.claims',(auth.jwt()||'{"role":"anon"}'::jsonb)::text,true);
    perform pg_temp.expect_failure(call_sql,array['28000']);
  end loop;
  perform pg_temp.block_actor(1);
  assert exists(select 1 from public.get_post_author_profile(p));
  assert exists(select 1 from public.get_post_author_cards(array[p]));
  assert exists(select 1 from public.get_post_author_discovery_cards(array[p]));
  perform pg_temp.block_actor(5,true);
  assert exists(select 1 from public.get_post_author_profile(p));
  assert exists(select 1 from public.get_post_author_cards(array[p]));
  assert exists(select 1 from public.get_post_author_discovery_cards(array[p]));
end $$;
reset role;
do $$ begin
  assert not exists(select 1 from block_review_before b
    left join public.appointment_reviews r on r.id=b.review_id
    left join private.review_publication p on p.review_id=b.review_id
    where to_jsonb(r) is distinct from b.review_row or to_jsonb(p) is distinct from b.publication_row),
    'block/unblock changed historical review or publication';
end $$;
-- 신규 네이버 활동 자격이 없는 세션도 본인 인증의 차단 관리에 접근할 수 있다.
set local role authenticated;
do $$ begin
  perform pg_temp.block_actor(5,true);
  assert public.block_member(pg_temp.block_uid(4))->>'blocked'='true';
  assert public.unblock_member(pg_temp.block_uid(4))->>'blocked'='false';
end $$;
reset role;
-- 익명 검색은 차단 관계를 숨긴다고 보장하지 않는다. 일반 공개 계약은 유지한다.
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true),set_config('request.jwt.claim.sub','',true);
do $$ declare f block_cases; v jsonb;begin
  select * into f from block_cases;
  perform pg_temp.expect_failure(format('select * from public.get_post_author_profile(%L)',f.post_a),array['42501']);
  perform pg_temp.expect_failure(format('select * from public.get_post_author_cards(array[%L::uuid])',f.post_a),array['42501']);
  perform pg_temp.expect_failure(format('select * from public.get_post_author_discovery_cards(array[%L::uuid])',f.post_a),array['42501']);
  v:=public.search_public_posts_v2('2026-10-05',null,'{}',null,10);
  assert exists(select 1 from jsonb_array_elements(v->'items') x where x->>'id'=f.post_b::text);
  assert public.get_service_post(f.post_b)->>'postId'=f.post_b::text;
end $$;
reset role;
rollback;
