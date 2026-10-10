-- SQL119 후속: 실제 공고 조회 RPC의 행사 상세와 공개 권한을 합성 DB 자료로 검사한다.
-- Auth 사용자/회원/공고/확정 상태는 직접 SQL fixture다. 실제 로그인·가입·등록·확정 성공 증거가 아니다.
-- 기존 행과 UNKNOWN을 비우지 않는다. trigger/권한/제어를 우회하지 않으며 모든 효과를 rollback한다.
begin;
create function pg_temp.post119_require(p_ok boolean,p_label text)returns void language plpgsql as $$begin
 if p_ok is distinct from true then raise exception 'post119_assertion:%',p_label;end if;
end;$$;
create temp table post119_actors(actor text primary key,user_id uuid not null unique,identity_id uuid not null unique,
 real_name text not null)on commit drop;
create temp table post119_fixture(key text primary key,value jsonb not null)on commit drop;
create temp table post119_baselines(phase text,actor text,body jsonb not null,primary key(phase,actor))on commit drop;
grant select on post119_actors,post119_fixture to anon,authenticated;
grant select,insert on post119_baselines to anon,authenticated;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claim.role','anon',true);
select set_config('request.jwt.claims','{"role":"anon"}',true);

do $$declare v_actor text;v_uid uuid;v_identity uuid;v_name text;v_subject text;
 v_event_id uuid;v_post_id uuid:=gen_random_uuid();v_source private.source_events;v_event jsonb;v_detail jsonb;
 v_stamp timestamptz:=clock_timestamp();v_day date:=(clock_timestamp()at time zone'Asia/Seoul')::date;
 v_sid text:='PFPOST119'||replace(gen_random_uuid()::text,'-','');v_cost text:=repeat('가격안내',2500);begin
 perform pg_temp.post119_require(to_regprocedure('private.project_event_source_detail(uuid)')is not null,'sql119_required');
 perform pg_temp.post119_require(not exists(select 1 from public.posts p where p.id=v_post_id),'fresh_post_id');
 foreach v_actor in array array['owner','participant','other']loop
  v_uid:=gen_random_uuid();v_subject:='post119-'||gen_random_uuid()::text;
  v_name:=case v_actor when'owner'then'합성작성자119'when'participant'then'합성참여자119'else'합성다른회원119'end;
  perform pg_temp.post119_require(not exists(select 1 from auth.users u where u.id=v_uid)
   and not exists(select 1 from public.profiles p where p.id=v_uid)
   and not exists(select 1 from private.member_episodes e where e.profile_id=v_uid),'fresh_actor_id');
  insert into auth.users(id,email)values(v_uid,gen_random_uuid()::text||'@post119.invalid');
  -- information_required는 실제 네이버 자격 확인이나 가입 완료를 가장하지 않는다.
  insert into private.naver_accounts(subject,user_id,verification_status)values(v_subject,v_uid,'information_required');
  insert into public.profiles(id,real_name,birth_date,gender)values(v_uid,v_name,'1990-01-01','female');
  select k.id into strict v_identity from private.naver_identity_keys k where k.subject=v_subject;
  perform pg_temp.post119_require(exists(select 1 from private.member_episodes e
   where e.profile_id=v_uid and e.identity_id=v_identity and e.ended_at is null),'fresh_active_identity_episode');
  insert into post119_actors values(v_actor,v_uid,v_identity,v_name);
 end loop;
 v_event:=jsonb_build_object('provider','kopis','sourceId',v_sid,'sourceStatus','active','title','합성 공고 연결 행사119',
  'category','대중음악','region','서울','placeName','공식 합성 공연장','publicAddress','공식 합성 공개 주소',
  'admission',jsonb_build_object('kind','free'),'sourceUrl',null,'collectedAt',
  to_char(v_stamp at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'precision','date',
  'startsOn',(v_day+1)::text,'endsOn',(v_day+20)::text);
 perform private.upsert_canonical_events(jsonb_build_array(v_event));
 select s.*into strict v_source from private.source_events s where s.provider='kopis'and s.source_id=v_sid;
 v_event_id:=v_source.id;
 v_detail:=jsonb_build_object('provider','kopis','sourceId',v_sid,'collectedAt',
  to_char((v_stamp+interval'1 minute')at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'admission',jsonb_build_object('kind','described','text',v_cost),
  'operatingInfo','합성 공고 운영 안내','description','합성 공고 행사 상세 설명',
  'posterUrl','https://www.kopis.or.kr/upload/post119.jpg');
 perform pg_temp.post119_require(private.merge_event_detail(v_source,v_detail),'fresh_full_detail_applied');
 insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,
  public_area,cost_type,amount,source_event_id)
 values(v_post_id,(select a.user_id from post119_actors a where a.actor='owner'),
  '합성 상세 연결 공고119','합성 공개 공고 설명','공연',v_stamp+interval'3 days',v_stamp+interval'3 days 2 hours',
  v_stamp+interval'2 days','서울특별시 강남구 역삼동','free',0,v_event_id);
 insert into private.post_search_locations(post_id,registered_place_name,registered_address)
 values(v_post_id,'비공개 합성 장소119','비공개 합성 주소119');
 insert into public.post_private_details(post_id,exact_location)values(v_post_id,'비공개 합성 만남 지점119');
 insert into post119_fixture values('postId',to_jsonb(v_post_id)),('eventId',to_jsonb(v_event_id)),
  ('fullPrice',to_jsonb(v_cost)),('publicEvent',public.get_public_event(v_event_id)),
  ('maskedName',to_jsonb(public.mask_real_name((select a.real_name from post119_actors a where a.actor='owner'))));
 perform pg_temp.post119_require(length(v_cost)=10000,'full_price_length');
 perform pg_temp.post119_require((select f.value#>>'{admission,text}'from post119_fixture f where f.key='publicEvent')=v_cost,'public_event_full_price');
end;$$;

create function pg_temp.post119_actor(p_actor text)returns void language plpgsql as $$declare v_uid uuid;begin
 if p_actor='anon'then
  perform set_config('request.jwt.claim.sub','',true);perform set_config('request.jwt.claim.role','anon',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
 else
  select a.user_id into strict v_uid from post119_actors a where a.actor=p_actor;
  perform set_config('request.jwt.claim.sub',v_uid::text,true);perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',v_uid,'is_anonymous',false)::text,true);
 end if;
end;$$;

create function pg_temp.post119_baseline(p_actor text,p_phase text)returns void language plpgsql as $$
declare v_post uuid;v_event uuid;v_row jsonb;v_public jsonb;v_owner text;v_name_count integer;v_private boolean;begin
 perform pg_temp.post119_actor(p_actor);
 select(f.value#>>'{}')::uuid into strict v_post from post119_fixture f where f.key='postId';
 select(f.value#>>'{}')::uuid into strict v_event from post119_fixture f where f.key='eventId';
 select a.real_name into strict v_owner from post119_actors a where a.actor='owner';
 v_row:=public.get_service_post(v_post);v_public:=public.get_public_event(v_event);
 perform pg_temp.post119_require(v_row->>'eventId'=v_event::text and v_row->'linkedEvent'=v_public,'post_actual_rpc_linked_equals_public_event');
 perform pg_temp.post119_require(v_public=(select f.value from post119_fixture f where f.key='publicEvent'),'public_event_same_fact');
 perform pg_temp.post119_require(v_row#>>'{linkedEvent,admission,text}'=(select f.value#>>'{}'from post119_fixture f where f.key='fullPrice'),
  'post_actual_rpc_full_price');
 perform pg_temp.post119_require(v_row#>>'{linkedEvent,operatingInfo}'='합성 공고 운영 안내'
  and v_row#>>'{linkedEvent,description}'='합성 공고 행사 상세 설명'
  and v_row#>>'{linkedEvent,posterUrl}'='https://www.kopis.or.kr/upload/post119.jpg','post_actual_rpc_all_detail_fields');
 v_private:=p_actor='owner'or(p_actor='participant'and p_phase='confirmed');
 if v_private then
  perform pg_temp.post119_require(v_row->>'authorDisplayName'=v_owner,'owner_or_confirmed_full_name');
  perform pg_temp.post119_require(v_row#>>'{privateDetails,registeredPlaceName}'='비공개 합성 장소119'
   and v_row#>>'{privateDetails,registeredAddress}'='비공개 합성 주소119'
   and v_row#>>'{privateDetails,meetingDetail}'='비공개 합성 만남 지점119','owner_or_confirmed_exact_private_fields');
  v_name_count:=case when p_phase='confirmed'then 2 else 1 end;
  perform pg_temp.post119_require(jsonb_array_length(v_row->'participantNames')=v_name_count,'allowed_participant_name_count');
  perform pg_temp.post119_require(exists(select 1 from jsonb_array_elements(v_row->'participantNames')n
   where n->>'userId'=(select a.user_id::text from post119_actors a where a.actor='owner')and n->>'realName'=v_owner),'owner_name_identity');
  if p_phase='confirmed'then
   perform pg_temp.post119_require(exists(select 1 from jsonb_array_elements(v_row->'participantNames')n
    join post119_actors a on a.actor='participant'and n->>'userId'=a.user_id::text and n->>'realName'=a.real_name),'confirmed_companion_name_identity');
  end if;
 else
  perform pg_temp.post119_require(not(v_row?'privateDetails')and not(v_row?'participantNames'),'unconfirmed_or_other_no_private_keys');
  perform pg_temp.post119_require(v_row::text not like'%비공개 합성%'and v_row::text not like'%'||v_owner||'%',
   'unconfirmed_or_other_no_raw_private_fields');
  if p_actor='anon'then
   perform pg_temp.post119_require(v_row->'authorDisplayName'='null'::jsonb,'anon_name_json_null');
  else
   perform pg_temp.post119_require(v_row->'authorDisplayName'=(select f.value from post119_fixture f where f.key='maskedName'),
    'nonparticipant_exact_masked_name');
  end if;
 end if;
 insert into post119_baselines(phase,actor,body)values(p_phase,p_actor,v_row);
end;$$;

set local role authenticated;
do $$declare v_actor text;begin
 foreach v_actor in array array['owner','participant','other']loop perform pg_temp.post119_baseline(v_actor,'recruiting');end loop;
end;$$;
reset role;
set local role anon;
select pg_temp.post119_baseline('anon','recruiting');
reset role;
select pg_temp.post119_actor('anon');
-- 확정된 관계만 직접 합성한다. 정상 신청/동의/확정 RPC 성공이나 네이버 가입 검증을 주장하지 않는다.
do $$declare v_post uuid;v_request uuid:=gen_random_uuid();v_appointment uuid:=gen_random_uuid();begin
 select(f.value#>>'{}')::uuid into strict v_post from post119_fixture f where f.key='postId';
 perform pg_temp.post119_require(not exists(select 1 from public.join_requests j where j.id=v_request)
  and not exists(select 1 from public.appointments a where a.id=v_appointment),'fresh_confirmed_relation_ids');
 insert into public.join_requests(id,post_id,requester_id,message,status)
 values(v_request,v_post,(select a.user_id from post119_actors a where a.actor='participant'),'합성 신청 상태 설명119','pending');
 insert into public.appointments(id,post_id,join_request_id,status)values(v_appointment,v_post,v_request,'confirmed');
 update public.join_requests j set status='matched'where j.id=v_request;
 update public.posts p set status='closed'where p.id=v_post;
 perform pg_temp.post119_require(exists(select 1 from private.appointment_member_episodes e where e.appointment_id=v_appointment),
  'confirmed_fixture_keeps_episode_trigger');
end;$$;
set local role authenticated;
do $$declare v_actor text;begin
 foreach v_actor in array array['owner','participant','other']loop perform pg_temp.post119_baseline(v_actor,'confirmed');end loop;
end;$$;
reset role;
set local role anon;
select pg_temp.post119_baseline('anon','confirmed');
reset role;
select pg_temp.post119_actor('anon');

create function pg_temp.post119_hidden(p_actor text,p_hidden_actor text)returns void language plpgsql as $$
declare v_post uuid;v_event uuid;v_row jsonb;v_baseline jsonb;v_unavailable boolean:=false;begin
 perform pg_temp.post119_actor(p_actor);
 select(f.value#>>'{}')::uuid into strict v_post from post119_fixture f where f.key='postId';
 select(f.value#>>'{}')::uuid into strict v_event from post119_fixture f where f.key='eventId';
 select b.body into strict v_baseline from post119_baselines b where b.phase='confirmed'and b.actor=p_actor;
 v_row:=public.get_service_post(v_post);
 perform pg_temp.post119_require(v_row-'linkedEvent'=v_baseline-'linkedEvent','event_hide_rest_post_dto_exact_unchanged');
 perform pg_temp.post119_require(v_row->>'eventId'=v_event::text,'event_hide_keeps_link_uuid');
 if p_actor=p_hidden_actor then
  perform pg_temp.post119_require(v_row->'linkedEvent'='null'::jsonb,'own_event_hide_linked_json_null');
  begin perform public.get_public_event(v_event);exception when sqlstate'PT404'then v_unavailable:=true;end;
  perform pg_temp.post119_require(v_unavailable,'own_event_hide_public_detail_pt404');
 else
  perform pg_temp.post119_require(v_row=v_baseline,'other_and_anon_whole_post_exact_unchanged');
  perform pg_temp.post119_require(v_row->'linkedEvent'=public.get_public_event(v_event),'other_and_anon_linked_detail_preserved');
 end if;
end;$$;

-- 각 사용자 선택은 별도 savepoint로 격리한다. 기존 숨김 삭제와 전체 비우기는 없다.
savepoint post119_owner_hide;
insert into private.member_hidden_targets(identity_id,target_type,target_id)
select a.identity_id,'event',(f.value#>>'{}')::uuid from post119_actors a cross join post119_fixture f
where a.actor='owner'and f.key='eventId';
set local role authenticated;
do $$declare v_actor text;begin foreach v_actor in array array['owner','participant','other']loop
 perform pg_temp.post119_hidden(v_actor,'owner');end loop;end;$$;
reset role;
set local role anon;
select pg_temp.post119_hidden('anon','owner');
reset role;
rollback to savepoint post119_owner_hide;

savepoint post119_participant_hide;
insert into private.member_hidden_targets(identity_id,target_type,target_id)
select a.identity_id,'event',(f.value#>>'{}')::uuid from post119_actors a cross join post119_fixture f
where a.actor='participant'and f.key='eventId';
set local role authenticated;
do $$declare v_actor text;begin foreach v_actor in array array['owner','participant','other']loop
 perform pg_temp.post119_hidden(v_actor,'participant');end loop;end;$$;
reset role;
set local role anon;
select pg_temp.post119_hidden('anon','participant');
reset role;
rollback to savepoint post119_participant_hide;

savepoint post119_other_hide;
insert into private.member_hidden_targets(identity_id,target_type,target_id)
select a.identity_id,'event',(f.value#>>'{}')::uuid from post119_actors a cross join post119_fixture f
where a.actor='other'and f.key='eventId';
set local role authenticated;
do $$declare v_actor text;begin foreach v_actor in array array['owner','participant','other']loop
 perform pg_temp.post119_hidden(v_actor,'other');end loop;end;$$;
reset role;
set local role anon;
select pg_temp.post119_hidden('anon','other');
reset role;
rollback to savepoint post119_other_hide;
select pg_temp.post119_actor('anon');
select 'POST119:'::text||jsonb_build_object('status','PASS','scope','ACTUAL_PUBLIC_GET_SERVICE_POST_SYNTHETIC_SQL_FIXTURES',
 'visibleContexts',8,'isolatedHiddenContexts',12,'fullPriceLength',10000,'privateFieldsPreserved',true,
 'realAuthLogin','NOT_RUN','normalSignup','NOT_RUN','normalPostCreate','NOT_RUN','normalConfirmation','NOT_RUN','actualHttp','NOT_RUN')::text;
rollback;
