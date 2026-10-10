-- 민규 전용 로컬 합성 자료. 실제 역할·세션·RPC를 검사하고 모든 자료를 rollback한다.
begin;
-- PostgREST POST도 STABLE이면 READ ONLY다. 회원 상태 공유 잠금을 유지하는 조회의 실행 속성을 검사한다.
do $$ begin
 assert (select provolatile='v' from pg_proc where oid='public.get_my_content_inspection_ticket(uuid,uuid)'::regprocedure), 'ticket reader must retain retirement lock in POST writable transaction';
end; $$;
-- schema-only 격리 DB의 필수 Storage metadata만 준비한다. 객체 파일·운영 자료는 만들지 않는다.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('profile-images','profile-images',false,5242880,array['image/jpeg','image/png','image/webp'])
  on conflict(id) do nothing;
set local storage.allow_delete_query='true';
create function pg_temp.first_uid(n integer) returns uuid language sql immutable as $$
  select ('a1161000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.first_session(n integer) returns uuid language sql immutable as $$
  select ('a1162000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.first_actor(n integer,unregistered boolean default false) returns void language plpgsql as $$
declare u uuid:=pg_temp.first_uid(n);s uuid:=case when unregistered then 'a1162000-0000-4000-8000-000000000099'::uuid else pg_temp.first_session(n) end;
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

-- 여섯 번째 회원은 활성화 뒤 최초 가입을 검사하기 위해 profile 생성 전 상태로 둔다.
set local role service_role;
do $$ declare i integer;begin
  for i in 1..6 loop perform public.resolve_naver_account('content116-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;
end $$;
reset role;

insert into auth.users(id,email) select pg_temp.first_uid(i),a.auth_email from generate_series(1,6) i
  join private.naver_accounts a on a.subject='content116-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.first_session(i),pg_temp.first_uid(i) from generate_series(1,6) i;
insert into auth.sessions(id,user_id) values('a1162000-0000-4000-8000-000000000099',pg_temp.first_uid(1));
insert into storage.objects(bucket_id,name,owner_id,metadata)
  select 'profile-images',pg_temp.first_uid(i)::text||'/a1163000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
    pg_temp.first_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,6) i;
set local role service_role;
do $$ declare i integer;begin
  for i in 1..6 loop perform public.record_naver_session('content116-sql-'||i,pg_temp.first_uid(i),pg_temp.first_session(i));end loop;
end $$;
reset role;
set local role authenticated;
do $$ declare i integer;begin
  for i in 1..5 loop
    perform pg_temp.first_actor(i);
    assert public.complete_naver_signup(pg_temp.first_uid(i)::text||'/a1163000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
  end loop;
end $$;
reset role;

-- 승인값과 분류 출력은 합성 SQL fixture이며 실제 검사 품질/정책 승인이 아니다.
do $$ begin
 assert not(select enabled from private.content_inspection_control where singleton);
 assert not has_function_privilege('service_role','public.issue_content_inspection_ticket(uuid,uuid,text,uuid,jsonb,text,text,text)','EXECUTE');
 assert not has_table_privilege('authenticated','private.content_inspection_tickets','SELECT');
 assert not has_function_privilege('authenticated','private.execute_inspected_content(text,jsonb)','EXECUTE');
end; $$;
update private.content_inspection_control set enabled=true,policy_version='synthetic-policy',scanner_version='synthetic-scanner',max_ticket_seconds=60 where singleton;
grant execute on function public.issue_content_inspection_ticket(uuid,uuid,text,uuid,jsonb,text,text,text) to service_role;
create function pg_temp.content_ticket(a text,target uuid,input jsonb,decision text default 'allow',operation uuid default extensions.gen_random_uuid()) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare claims text:=current_setting('request.jwt.claims',true); u uuid:=auth.uid(); result jsonb;
begin
 perform set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,true);
 result:=public.issue_content_inspection_ticket(u,operation,a,target,input,decision,'synthetic-policy','synthetic-scanner');
 perform set_config('request.jwt.claims',claims,true);
 perform set_config('request.headers',jsonb_build_object('x-content-inspection-ticket',result->>'ticketId','x-content-operation-id',operation)::text,true);
 return result;
exception when others then perform set_config('request.jwt.claims',claims,true);raise;
end; $$;
create temp table content116_results(name text primary key, input jsonb, ticket jsonb, result jsonb);
grant all on content116_results to authenticated;
-- 최초 가입은 아직 profile이 없고, 외부 signup ticket 하나만 소비한다.
do $$begin assert not exists(select 1 from public.profiles where id=pg_temp.first_uid(6));end;$$;
set local role authenticated;
select pg_temp.first_actor(6);
do $$declare input jsonb;t jsonb;r jsonb;begin
 input:=jsonb_build_object('p_avatar_path',auth.uid()::text||'/a1163000-0000-4000-8000-000000000006.jpg','p_interests',jsonb_build_array('독서'),'p_conversation_styles',jsonb_build_array('차분한 대화'),'p_mbti','INFP');
 t:=pg_temp.content_ticket('signup_traits',auth.uid(),input);
 r:=public.complete_naver_signup(input->>'p_avatar_path',array['독서'],array['차분한 대화'],'INFP');
 assert r->>'status'='ready' and r->'interests'='["독서"]'::jsonb;
 assert public.complete_naver_signup(input->>'p_avatar_path',array['독서'],array['차분한 대화'],'INFP')=r;
 insert into content116_results values('first-signup',input,t,r);
end;$$;
reset role;
do $$begin
 assert exists(select 1 from public.profiles where id=pg_temp.first_uid(6));
 assert (select count(*) from private.content_inspection_tickets where user_id=pg_temp.first_uid(6))=1;
 assert (select consumed_at is not null from private.content_inspection_tickets where user_id=pg_temp.first_uid(6));
end;$$;
set local role authenticated;
select pg_temp.first_actor(1);
select set_config('request.headers','{}',true);
do $$ begin
 -- 실제 공개 작성 RPC8개 모두 ticket 없는 직접 호출을 거절한다.
 perform pg_temp.expect_failure($q$select public.create_service_post('a1164000-0000-4000-8000-000000000001',pg_temp.first_input(1))$q$,array['42501']);
 perform pg_temp.expect_failure($q$select public.update_service_post('a1164000-0000-4000-8000-000000000001',pg_temp.first_input(1),clock_timestamp())$q$,array['42501']);
 perform pg_temp.expect_failure($q$select public.set_my_profile_traits('{}','{}',null)$q$,array['42501']);
 perform pg_temp.expect_failure($q$select public.set_my_profile_preferences('{}','{}',null,'소개')$q$,array['42501']);
 perform pg_temp.expect_failure($q$select public.complete_naver_signup(null,'{}','{}',null)$q$,array['42501']);
 perform pg_temp.expect_failure($q$select public.submit_appointment_review('a1164000-0000-4000-8000-000000000001',5,'후기','good','{}')$q$,array['42501']);
 perform pg_temp.expect_failure($q$select public.request_service_post('a1164000-0000-4000-8000-000000000001','a1164000-0000-4000-8000-000000000002','메시지')$q$,array['42501']);
 perform pg_temp.expect_failure($q$select public.send_conversation_message('a1164000-0000-4000-8000-000000000001','a1164000-0000-4000-8000-000000000002','메시지')$q$,array['42501']);
end; $$;
do $$ declare input jsonb; t jsonb; r jsonb; changed jsonb; before_version timestamptz; begin
 input:=jsonb_build_object('p_interests',jsonb_build_array('산책'),'p_conversation_styles',jsonb_build_array('차분한 대화'),'p_mbti','INFP','p_bio','합성 소개');
 t:=pg_temp.content_ticket('profile_preferences',auth.uid(),input);
 r:=public.set_my_profile_preferences(array['산책'],array['차분한 대화'],'INFP','합성 소개');
 assert r->>'bio'='합성 소개';
 assert public.set_my_profile_preferences(array['산책'],array['차분한 대화'],'INFP','합성 소개')=r;
 perform pg_temp.expect_failure($q$select public.set_my_profile_preferences(array['산책'],array['차분한 대화'],'INFP','변조 소개')$q$,array['40001']);
 insert into content116_results values('preferences',input,t,r);
 -- 새 변경 이후 과거 성공 요청으로 성향을 되돌리지 않는다.
 changed:=input||jsonb_build_object('p_bio','새 소개');perform pg_temp.content_ticket('profile_preferences',auth.uid(),changed);
 perform public.set_my_profile_preferences(array['산책'],array['차분한 대화'],'INFP','새 소개');
 perform set_config('request.headers',jsonb_build_object('x-content-inspection-ticket',t->>'ticketId','x-content-operation-id',t->>'operationId')::text,true);
 perform pg_temp.expect_failure($q$select public.set_my_profile_preferences(array['산책'],array['차분한 대화'],'INFP','합성 소개')$q$,array['40001']);
 assert public.get_my_profile()->>'bio'='새 소개';
 input:=jsonb_build_object('p_interests',jsonb_build_array('전시'),'p_conversation_styles','[]'::jsonb,'p_mbti',null);
 perform pg_temp.content_ticket('profile_traits',auth.uid(),input);r:=public.set_my_profile_traits(array['전시'],'{}',null);assert r->'interests'='["전시"]'::jsonb;
 input:=jsonb_build_object('p_avatar_path',auth.uid()::text||'/a1163000-0000-4000-8000-000000000001.jpg','p_interests','[]'::jsonb,'p_conversation_styles','[]'::jsonb,'p_mbti',null);
 perform pg_temp.content_ticket('signup_traits',auth.uid(),input);r:=public.complete_naver_signup(input->>'p_avatar_path','{}','{}',null);assert r->>'status'='ready';
 assert public.complete_naver_signup(input->>'p_avatar_path','{}','{}',null)=r;
end; $$;
do $$ declare p uuid:='a1164000-0000-4000-8000-000000000001';input jsonb;args jsonb;t jsonb;r jsonb;updated timestamptz;begin
 input:=pg_temp.first_input(1);args:=jsonb_build_object('p_post_id',p,'p_input',input);t:=pg_temp.content_ticket('post_create',p,args);
 r:=public.create_service_post(p,input);assert r->>'alreadyCreated'='false';assert public.create_service_post(p,input)->>'alreadyCreated'='true';
 insert into content116_results values('post',args,t,r);
 select updated_at into updated from public.posts where id=p;
 input:=input||jsonb_build_object('title','수정 제목');args:=jsonb_build_object('p_post_id',p,'p_input',input,'p_expected_updated_at',updated);
 perform pg_temp.content_ticket('post_update',p,args);r:=public.update_service_post(p,input,updated);assert public.update_service_post(p,input,updated)=r;
 assert (select title from public.posts where id=p)='수정 제목';
end; $$;
select pg_temp.first_actor(2);
do $$ declare p uuid:='a1164000-0000-4000-8000-000000000001';m uuid:='a1164000-0000-4000-8000-000000000002';input jsonb;t jsonb;r jsonb;rid uuid;begin
 input:=jsonb_build_object('p_post_id',p,'p_message_id',m,'p_message','합성 첫 메시지');
 t:=pg_temp.content_ticket('application_message',p,input,'confirm_required',m);
 perform pg_temp.expect_failure(format('select public.request_service_post(%L,%L,%L)',p,m,'합성 첫 메시지'),array['40001']);
 perform public.confirm_my_content_inspection_ticket((t->>'ticketId')::uuid,m,'application_message',p,input);
 r:=public.request_service_post(p,m,'합성 첫 메시지');rid:=(r->>'id')::uuid;
 assert public.request_service_post(p,m,'합성 첫 메시지')->>'alreadySent'='true';
 insert into content116_results values('application',input,t,r);
 m:='a1164000-0000-4000-8000-000000000003';input:=jsonb_build_object('p_request_id',rid,'p_message_id',m,'p_content','합성 다음 메시지');
 t:=pg_temp.content_ticket('chat_message',rid,input,'allow',m);r:=public.send_conversation_message(rid,m,'합성 다음 메시지');assert public.send_conversation_message(rid,m,'합성 다음 메시지')->>'alreadySent'='true';
 insert into content116_results values('chat',input,t,r);
 -- 명확 차단은 사용자 확인으로 해제되지 않는다.
 m:='a1164000-0000-4000-8000-000000000004';input:=jsonb_build_object('p_request_id',rid,'p_message_id',m,'p_content','합성 차단 fixture');t:=pg_temp.content_ticket('chat_message',rid,input,'block',m);
 perform pg_temp.expect_failure(format('select public.confirm_my_content_inspection_ticket(%L,%L,%L,%L,%L::jsonb)',t->>'ticketId',m,'chat_message',rid,input),array['42501']);
 perform pg_temp.expect_failure(format('select public.send_conversation_message(%L,%L,%L)',rid,m,'합성 차단 fixture'),array['42501']);
 assert not exists(select 1 from public.chat_messages where id=m);
end; $$;
-- 다른 사용자의 ticket/operation은 호출자의 성공으로 사용할 수 없다.
-- 성공한 채팅도 target/action/message/operation이 달라지면 재사용할 수 없다.
do $$declare t jsonb;args jsonb;r uuid;m uuid;begin
 select ticket,input into t,args from content116_results where name='chat';r:=(args->>'p_request_id')::uuid;m:=(args->>'p_message_id')::uuid;
 perform set_config('request.headers',jsonb_build_object('x-content-inspection-ticket',t->>'ticketId','x-content-operation-id',t->>'operationId')::text,true);
 perform pg_temp.expect_failure(format('select public.send_conversation_message(%L,%L,%L)','a1164000-0000-4000-8000-000000000099',m,args->>'p_content'),array['40001']);
 perform pg_temp.expect_failure(format('select public.send_conversation_message(%L,%L,%L)',r,'a1164000-0000-4000-8000-000000000099',args->>'p_content'),array['40001']);
 perform pg_temp.expect_failure(format('select public.request_service_post(%L,%L,%L)',r,m,args->>'p_content'),array['40001']);
 perform pg_temp.expect_failure(format('select public.confirm_my_content_inspection_ticket(%L,%L,%L,%L,%L::jsonb)',t->>'ticketId',m,'review',r,args),array['40001']);
 perform set_config('request.headers',jsonb_build_object('x-content-inspection-ticket',t->>'ticketId','x-content-operation-id','a1164000-0000-4000-8000-000000000099')::text,true);
 perform pg_temp.expect_failure(format('select public.send_conversation_message(%L,%L,%L)',r,m,args->>'p_content'),array['42501']);
end;$$;
select pg_temp.first_actor(3);
do $$ declare t jsonb;begin
 select ticket into t from content116_results where name='preferences';
 perform set_config('request.headers',jsonb_build_object('x-content-inspection-ticket',t->>'ticketId','x-content-operation-id',t->>'operationId')::text,true);
 perform pg_temp.expect_failure($q$select public.set_my_profile_preferences(array['산책'],array['차분한 대화'],'INFP','합성 소개')$q$,array['42501']);
end; $$;
reset role;
do $$ begin
 assert not exists(select 1 from private.content_inspection_tickets where action in ('profile_traits','profile_preferences','signup_traits') and outcome is not null),'raw_profile_copy';
 assert (select count(*) from private.content_inspection_tickets where consumed_at is not null)>=7;
 assert not exists(select 1 from private.content_inspection_tickets where action='chat_message' and decision='block' and consumed_at is not null);
 assert not exists(select 1 from jsonb_object_keys((select to_jsonb(t) from private.content_inspection_tickets t limit 1)) k where k in ('input','raw_text','message','bio'));
end; $$;
-- 실제 원 저장 실패가 ticket 소비와 성향 변경을 함께 rollback한다.
set local role authenticated;
select pg_temp.first_actor(1);
do $$ declare input jsonb;t jsonb;before_traits jsonb;begin
 before_traits:=public.get_my_profile_traits();input:=jsonb_build_object('p_interests','[]'::jsonb,'p_conversation_styles','[]'::jsonb,'p_mbti','XXXX');
 t:=pg_temp.content_ticket('profile_traits',auth.uid(),input);
 perform pg_temp.expect_failure($q$select public.set_my_profile_traits('{}','{}','XXXX')$q$,array['22023']);
 assert public.get_my_profile_traits()=before_traits;
 assert not (public.get_my_content_inspection_ticket((t->>'ticketId')::uuid,(t->>'operationId')::uuid)->>'consumed')::boolean;
 insert into content116_results values('expired',input,t,null);
end; $$;
reset role;
update private.content_inspection_tickets set expires_at=clock_timestamp()-interval '1 second' where ticket_id=(select (ticket->>'ticketId')::uuid from content116_results where name='expired');
set local role authenticated;
select pg_temp.first_actor(1);
select pg_temp.expect_failure($q$select public.set_my_profile_traits('{}','{}','XXXX')$q$,array['40001']);
reset role;
-- 후기 성공과 동일 결과 재조회: 실제 작성 validator/공개 처리 계약을 통과한다.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)
values('a1164000-0000-4000-8000-000000000050',pg_temp.first_uid(3),'합성 후기 공고','후기 정상 작성 검증','산책',clock_timestamp()-interval'3 hours',clock_timestamp()-interval'1 hour',clock_timestamp()-interval'4 hours','서울특별시 강남구 역삼동');
insert into public.join_requests(id,post_id,requester_id,message,status)
values('a1164000-0000-4000-8000-000000000051','a1164000-0000-4000-8000-000000000050',pg_temp.first_uid(4),'합성 후기 신청','matched');
insert into public.appointments(id,post_id,join_request_id,status,confirmed_at)
values('a1164000-0000-4000-8000-000000000052','a1164000-0000-4000-8000-000000000050','a1164000-0000-4000-8000-000000000051','confirmed',clock_timestamp()-interval'4 hours');
set local role authenticated;
select pg_temp.first_actor(3);
select public.confirm_appointment_completion('a1164000-0000-4000-8000-000000000052');
select pg_temp.first_actor(4);
select public.confirm_appointment_completion('a1164000-0000-4000-8000-000000000052');
do $$declare ap uuid:='a1164000-0000-4000-8000-000000000052';args jsonb;t jsonb;r jsonb;begin
 args:=jsonb_build_object('p_appointment_id',ap,'p_rating',4,'p_comment','합성 경험 기반 후기','p_experience','neutral','p_praises','[]'::jsonb);
 t:=pg_temp.content_ticket('review',ap,args);r:=public.submit_appointment_review(ap,4,args->>'p_comment','neutral','{}');
 assert r->>'deduplicated'='false';
 assert public.submit_appointment_review(ap,4,args->>'p_comment','neutral','{}')=r||jsonb_build_object('deduplicated',true);
 insert into content116_results values('review',args,t,r);
end;$$;
reset role;
do $$begin
 assert (select count(*)from public.appointment_reviews where appointment_id='a1164000-0000-4000-8000-000000000052')=1;
 assert (select consumed_at is not null from private.content_inspection_tickets where ticket_id=(select (ticket->>'ticketId')::uuid from content116_results where name='review'));
end;$$;
-- 정책/검사기 버전 교체는 미소비 ticket을 닫고, 원 성공은 새 쓰기 없이 재조회한다.
set local role authenticated;
select pg_temp.first_actor(2);
do $$declare args jsonb;t jsonb;r uuid;begin
 select (input->>'p_request_id')::uuid into r from content116_results where name='chat';
 args:=jsonb_build_object('p_request_id',r,'p_message_id','a1164000-0000-4000-8000-000000000060','p_content','합성 버전 교체 전 메시지');
 t:=pg_temp.content_ticket('chat_message',r,args,'allow','a1164000-0000-4000-8000-000000000060');
 insert into content116_results values('version-pending',args,t,null);
end;$$;
reset role;
update private.content_inspection_control set policy_version='synthetic-policy-v2'where singleton;
set local role authenticated;
do $$declare args jsonb;begin select input into args from content116_results where name='version-pending';
 perform pg_temp.expect_failure(format('select public.send_conversation_message(%L,%L,%L)',args->>'p_request_id',args->>'p_message_id',args->>'p_content'),array['40001']);end;$$;
reset role;
update private.content_inspection_control set policy_version='synthetic-policy',scanner_version='synthetic-scanner-v2'where singleton;
update private.content_inspection_tickets set expires_at=clock_timestamp()-interval'1 second'where ticket_id=(select (ticket->>'ticketId')::uuid from content116_results where name='chat');
set local role authenticated;
do $$declare args jsonb;t jsonb;r jsonb;begin
 select input into args from content116_results where name='version-pending';
 perform pg_temp.expect_failure(format('select public.send_conversation_message(%L,%L,%L)',args->>'p_request_id',args->>'p_message_id',args->>'p_content'),array['40001']);
 select input,ticket,result into args,t,r from content116_results where name='chat';
 perform set_config('request.headers',jsonb_build_object('x-content-inspection-ticket',t->>'ticketId','x-content-operation-id',t->>'operationId')::text,true);
 assert public.send_conversation_message((args->>'p_request_id')::uuid,(args->>'p_message_id')::uuid,args->>'p_content')=r||jsonb_build_object('alreadySent',true);
end;$$;
reset role;
update private.content_inspection_control set scanner_version='synthetic-scanner'where singleton;
do $$begin
 assert not exists(select 1 from public.chat_messages where id='a1164000-0000-4000-8000-000000000060');
 assert (select consumed_at is null from private.content_inspection_tickets where ticket_id=(select (ticket->>'ticketId')::uuid from content116_results where name='version-pending'));
end;$$;
-- JWT 역할·anonymous·탈퇴 경계는 유효한 본인 ticket으로도 우회하지 않는다.
set local role authenticated;
select pg_temp.first_actor(5);
do $$declare args jsonb;t jsonb;begin
 args:=jsonb_build_object('p_interests','[]'::jsonb,'p_conversation_styles','[]'::jsonb,'p_mbti',null);
 t:=pg_temp.content_ticket('profile_traits',auth.uid(),args);insert into content116_results values('retired-pending',args,t,null);
end;$$;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.first_uid(5),'session_id',pg_temp.first_session(5),'is_anonymous',true)::text,true);
select pg_temp.expect_failure($q$select public.set_my_profile_traits('{}','{}',null)$q$,array['28000']);
reset role;
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select pg_temp.expect_failure($q$select public.set_my_profile_traits('{}','{}',null)$q$,array['42501']);
reset role;
insert into private.member_retirements(profile_id,withdrawal_id,episode_id)
values(pg_temp.first_uid(5),'a1164000-0000-4000-8000-000000000070',private.active_member_episode(pg_temp.first_uid(5)));
set local role authenticated;
select pg_temp.first_actor(5);
select pg_temp.expect_failure($q$select public.set_my_profile_traits('{}','{}',null)$q$,array['42501']);
reset role;
do $$begin
 assert (select consumed_at is null from private.content_inspection_tickets where ticket_id=(select (ticket->>'ticketId')::uuid from content116_results where name='retired-pending'));
 assert not exists(select 1 from private.content_inspection_tickets where action in('profile_traits','profile_preferences','signup_traits')and outcome is not null);
end;$$;
rollback;
