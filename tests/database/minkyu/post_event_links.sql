-- 민규: 합성 네이버 회원·행사·공고로 실제 RPC를 검사하며 모두 롤백한다.
begin;
create function pg_temp.link_uid(n integer) returns uuid language sql immutable as $$
  select ('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.link_session(n integer) returns uuid language sql immutable as $$
  select ('a1100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.link_actor(n integer,registered boolean default true) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',pg_temp.link_uid(n)::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.link_uid(n),
    'session_id',case when registered then pg_temp.link_session(n) else 'a1100000-0000-4000-8000-000000000099'::uuid end)::text,true);
end; $$;
create function pg_temp.link_input(n integer) returns jsonb language sql stable as $$
  select jsonb_build_object('title','합성 연결 공고 '||n,'description','검색 제외 소개 원문','category','공연',
    'startsAt',now()+make_interval(days=>n+3),'endsAt',now()+make_interval(days=>n+3,hours=>2),
    'recruitmentEndsAt',now()+make_interval(days=>n+2),
    'publicArea','서울특별시 강남구 역삼동','registeredPlaceName','비공개 등록 장소',
    'registeredAddress','비공개 등록 주소 123','meetingDetail','검색 제외 상세 만남 지점',
    'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0);
$$;
create function pg_temp.link_expect(command text,expected text) returns void language plpgsql as $$
declare code text;
begin
  begin execute command; exception when others then get stacked diagnostics code=returned_sqlstate; end;
  assert code=expected,'unexpected linked event permission/state';
end; $$;
create function pg_temp.link_event(source_id text,event_precision text default 'date',revision integer default 0)
returns jsonb language sql stable as $$
  select jsonb_build_object('provider','kopis','sourceId',source_id,'sourceStatus','active','title','합성 행사 '||source_id,
    'category','뮤지컬','region','서울','placeName','공식 공개 공연장','publicAddress','공식 제공처 공개 주소',
    'admission',jsonb_build_object('kind','unknown'),'sourceUrl',null,'precision',event_precision,
    'collectedAt',to_char((now()+make_interval(secs=>revision)) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    || case when event_precision='date' then jsonb_build_object('startsOn',to_char((now() at time zone 'Asia/Seoul')::date-1,'YYYY-MM-DD'),
      'endsOn',to_char((now() at time zone 'Asia/Seoul')::date+30,'YYYY-MM-DD'))
      else jsonb_build_object('startsAt',to_char((now()+interval '1 day') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'endsAt',to_char((now()+interval '2 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end;
$$;
create temp table link_events(name text primary key,event_id uuid,event jsonb);
create temp table link_cases(name text primary key,post_id uuid,input jsonb,event_id uuid,request_id uuid,
  version text,updated_at timestamptz,fingerprint text,detail jsonb);
grant all on link_events,link_cases to authenticated,service_role;
grant select on link_events,link_cases to anon;

set local role service_role;
do $$ declare n integer;begin
  for n in 1..3 loop perform public.resolve_naver_account('post-event-sql-'||n,'합성행사회원'||n,'F','1990-01-01');end loop;
end $$;
reset role;
insert into auth.users(id,email) select pg_temp.link_uid(n),a.auth_email from generate_series(1,3) n
  join private.naver_accounts a on a.subject='post-event-sql-'||n;
insert into auth.sessions(id,user_id) select pg_temp.link_session(n),pg_temp.link_uid(n) from generate_series(1,3) n;
insert into auth.sessions(id,user_id) values('a1100000-0000-4000-8000-000000000099',pg_temp.link_uid(1));
insert into storage.objects(bucket_id,name,owner_id,metadata)
  select 'profile-images',pg_temp.link_uid(n)::text||'/a1200000-0000-4000-8000-'||lpad(n::text,12,'0')||'.jpg',
    pg_temp.link_uid(n)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,3) n;
set local role service_role;
do $$ declare n integer;begin
  for n in 1..3 loop perform public.record_naver_session('post-event-sql-'||n,pg_temp.link_uid(n),pg_temp.link_session(n));end loop;
end $$;
reset role;
set local role authenticated;
do $$ declare n integer;begin
  for n in 1..3 loop
    perform pg_temp.link_actor(n);
    assert public.complete_naver_signup(pg_temp.link_uid(n)::text||'/a1200000-0000-4000-8000-'||lpad(n::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
  end loop;
end $$;
reset role;

insert into link_events(name,event) values
  ('date',pg_temp.link_event('date')),
  ('instant',pg_temp.link_event('instant','instant')),
  ('today',pg_temp.link_event('today')||jsonb_build_object('endsOn',to_char((now() at time zone 'Asia/Seoul')::date,'YYYY-MM-DD'))),
  ('cancelled',pg_temp.link_event('cancelled')||'{"sourceStatus":"cancelled"}'::jsonb),
  ('ended_date',pg_temp.link_event('ended-date')||jsonb_build_object('startsOn',to_char((now() at time zone 'Asia/Seoul')::date-3,'YYYY-MM-DD'),
    'endsOn',to_char((now() at time zone 'Asia/Seoul')::date-1,'YYYY-MM-DD'))),
  ('ended_instant',pg_temp.link_event('ended-instant','instant')||jsonb_build_object(
    'startsAt',to_char((now()-interval '2 hours') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char((now()-interval '1 hour') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
  ('legacy',pg_temp.link_event('legacy')||'{"provider":"legacy_provider"}'::jsonb);
set local role service_role;
do $$ begin
  assert public.upsert_events((select jsonb_agg(event order by name) from link_events where name<>'legacy'))->>'insertedCount'='6';
  assert public.upsert_source_events_v1(jsonb_build_array((select event from link_events where name='legacy')))->>'savedCount'='1';
end $$;
reset role;
update link_events f set event_id=e.id from private.source_events e
  where e.provider=f.event->>'provider' and e.source_id=f.event->>'sourceId';
do $$ declare signature text;begin
  assert not exists(select 1 from link_events where event_id is null);
  assert has_function_privilege('anon','public.get_service_post(uuid)','EXECUTE');
  assert has_function_privilege('authenticated','public.create_service_post(uuid,jsonb)','EXECUTE');
  assert not has_function_privilege('anon','public.create_service_post(uuid,jsonb)','EXECUTE');
  assert has_function_privilege('authenticated','public.update_service_post(uuid,jsonb,timestamp with time zone)','EXECUTE');
  foreach signature in array array['private.parse_post_event_id(jsonb)','private.assert_post_event_selectable(uuid)','private.project_post_linked_event(uuid)','private.match_condition_version(uuid)'] loop
    assert not has_function_privilege('anon',signature,'EXECUTE');
    assert not has_function_privilege('authenticated',signature,'EXECUTE');
    assert not has_function_privilege('service_role',signature,'EXECUTE');
  end loop;
  assert not has_table_privilege('anon','private.source_events','SELECT');
  assert not has_table_privilege('authenticated','private.events','SELECT');
end $$;
select 'PASS post_event_acl';

set local role authenticated;
select pg_temp.link_actor(1);
do $$ declare v_name text;number integer:=0;id uuid;input jsonb;detail jsonb;begin
  foreach v_name in array array['date','instant','today','plain','explicit_null'] loop
    number:=number+1;id:=gen_random_uuid();input:=pg_temp.link_input(number);
    if v_name in('date','instant','today') then input:=input||jsonb_build_object('eventId',(select event_id from link_events e where e.name=v_name));
    elsif v_name='explicit_null' then input:=input||'{"eventId":null}'::jsonb;end if;
    assert public.create_service_post(id,input)->>'alreadyCreated'='false';
    detail:=public.get_service_post(id);
    insert into link_cases(name,post_id,input,event_id,updated_at,detail)
      values(v_name,id,input,(input->>'eventId')::uuid,(detail->>'updatedAt')::timestamptz,detail);
    assert detail->'startsAt'=input->'startsAt' or (detail->>'startsAt')::timestamptz=(input->>'startsAt')::timestamptz;
    if input->>'eventId' is null then assert detail->'eventId'='null'::jsonb and detail->'linkedEvent'='null'::jsonb;
    else assert detail->>'eventId'=input->>'eventId' and detail#>>'{linkedEvent,id}'=input->>'eventId';end if;
  end loop;
  assert (select c.detail#>>'{linkedEvent,precision}'='date' and c.detail#>>'{linkedEvent,endsOn}'=e.event->>'endsOn'
    from link_cases c join link_events e on e.name=c.name where c.name='today');
  assert (select c.detail#>>'{linkedEvent,precision}'='instant' and not(c.detail->'linkedEvent'?'startsOn') from link_cases c where c.name='instant');
end $$;
reset role;
select 'PASS post_event_valid_selection';

set local role authenticated;
select pg_temp.link_actor(1);
do $$ declare value jsonb;v_name text;begin
  for value in select v from jsonb_array_elements('["",1,true,[],{},"not-a-uuid","00000000000040008000000000000000"]') e(v) loop
    perform pg_temp.link_expect(format('select public.create_service_post(%L,%L::jsonb)',gen_random_uuid(),pg_temp.link_input(1)||jsonb_build_object('eventId',value)),'22023');
  end loop;
  foreach v_name in array array['cancelled','ended_date','ended_instant','legacy'] loop
    perform pg_temp.link_expect(format('select public.create_service_post(%L,%L::jsonb)',gen_random_uuid(),
      pg_temp.link_input(1)||jsonb_build_object('eventId',(select event_id from link_events e where e.name=v_name))),'22023');
  end loop;
  perform pg_temp.link_expect(format('select public.create_service_post(%L,%L::jsonb)',gen_random_uuid(),
    pg_temp.link_input(1)||jsonb_build_object('eventId',gen_random_uuid())),'22023');
  perform pg_temp.link_expect(format('select public.create_service_post(%L,%L::jsonb)',gen_random_uuid(),
    pg_temp.link_input(1)||'{"eventId":null,"extra":true}'::jsonb),'22023');
end $$;
select pg_temp.link_actor(1,false);
do $$ begin
  perform pg_temp.link_expect(format('select public.create_service_post(%L,%L::jsonb)',gen_random_uuid(),
    pg_temp.link_input(1)||jsonb_build_object('eventId',(select event_id from link_events where name='date'))),'28000');
end $$;
reset role;
select 'PASS post_event_invalid_selection_and_naver';

-- 비정상 공급사 상태/정밀도는 canonical 저장 자체에서 거절한다. 제약을 해제하지 않는다.
set local role service_role;
do $$ declare bad jsonb;base jsonb:=pg_temp.link_event('malformed');begin
  foreach bad in array array[base-'sourceStatus',base||'{"sourceStatus":null}'::jsonb,
    base||'{"sourceStatus":"unknown"}'::jsonb,base-'precision',base||'{"precision":null}'::jsonb,
    base||'{"precision":"invalid"}'::jsonb,base-'endsOn'] loop
    perform pg_temp.link_expect(format('select public.upsert_events(%L::jsonb)',jsonb_build_array(bad)),'22023');
  end loop;
end $$;
reset role;
do $$ begin assert not exists(select 1 from private.source_events where provider='kopis' and source_id='malformed');end $$;
select 'PASS post_event_malformed_canonical_rejected';

set local role authenticated;
select pg_temp.link_actor(1);
do $$ declare c link_cases;begin
  for c in select * from link_cases loop assert public.create_service_post(c.post_id,c.input)->>'alreadyCreated'='true';end loop;
  select * into c from link_cases where name='plain';
  assert public.create_service_post(c.post_id,c.input||'{"eventId":null}'::jsonb)->>'alreadyCreated'='true';
  select * into c from link_cases where name='explicit_null';
  assert public.create_service_post(c.post_id,c.input-'eventId')->>'alreadyCreated'='true';
  select * into c from link_cases where name='date';
  perform pg_temp.link_expect(format('select public.create_service_post(%L,%L::jsonb)',c.post_id,
    c.input||jsonb_build_object('eventId',(select event_id from link_events where name='instant'))),'40001');
  perform pg_temp.link_expect(format('select public.create_service_post(%L,%L::jsonb)',c.post_id,c.input||'{"description":"다른 최초 입력"}'::jsonb),'40001');
end $$;
reset role;
do $$ begin
  assert not exists(select 1 from link_cases c join private.service_post_inputs i on i.post_id=c.post_id where i.input<>c.input);
  assert (select not(input?'eventId') from private.service_post_inputs where post_id=(select post_id from link_cases where name='plain'));
  assert (select private.match_condition_version(c.post_id)=md5((private.match_conditions(c.post_id)||jsonb_build_object(
      'address',l.registered_address,'place',l.registered_place_name,'detail',d.exact_location))::text)
    from link_cases c join public.post_private_details d on d.post_id=c.post_id
      left join private.post_search_locations l on l.post_id=c.post_id where c.name='plain');
end $$;
select 'PASS post_event_original_creation_idempotence';

set local role authenticated;
select pg_temp.link_actor(1);
do $$ declare c link_cases;detail jsonb;begin
  select * into c from link_cases where name='instant';
  perform public.update_service_post(c.post_id,c.input-'eventId',c.updated_at);
  detail:=public.get_service_post(c.post_id);
  assert detail->>'eventId'=c.event_id::text;
  perform pg_temp.link_expect(format('select public.update_service_post(%L,%L::jsonb,%L)',c.post_id,c.input,c.updated_at),'40001');
  perform pg_temp.link_expect(format('select public.update_service_post(%L,%L::jsonb,%L)',c.post_id,
    c.input||jsonb_build_object('eventId',(select event_id from link_events where name='cancelled')),detail->>'updatedAt'),'22023');
  perform public.update_service_post(c.post_id,c.input||'{"eventId":null}'::jsonb,(detail->>'updatedAt')::timestamptz);
  detail:=public.get_service_post(c.post_id);assert detail->'linkedEvent'='null'::jsonb and detail->'eventId'='null'::jsonb;
  perform public.update_service_post(c.post_id,c.input,(detail->>'updatedAt')::timestamptz);
  assert public.get_service_post(c.post_id)->>'eventId'=c.event_id::text;
  detail:=public.get_service_post(c.post_id);
  perform public.update_service_post(c.post_id,c.input||jsonb_build_object('eventId',(select event_id from link_events where name='today')),
    (detail->>'updatedAt')::timestamptz);
  detail:=public.get_service_post(c.post_id);
  assert detail->>'eventId'=(select event_id::text from link_events where name='today');
  perform public.update_service_post(c.post_id,c.input,(detail->>'updatedAt')::timestamptz);
  -- 연결 변경 뒤에도 원래 생성 입력의 재시도는 생성 당시 idempotence를 따른다.
  assert public.create_service_post(c.post_id,c.input)->>'alreadyCreated'='true';
  perform pg_temp.link_actor(3);
  perform pg_temp.link_expect(format('select public.update_service_post(%L,%L::jsonb,%L)',c.post_id,c.input,
    public.get_service_post(c.post_id)->>'updatedAt'),'P0002');
end $$;
reset role;
-- 관리자 SQL 역할은 지문만 읽고, 실제 RPC의 주체는 등록된 합성 JWT/session으로 지정한다.
do $$ declare p uuid:=gen_random_uuid();v_input jsonb;request jsonb;consent jsonb;old_version text;
  old_fingerprint text;new_event_id uuid;detail jsonb;v_request_id uuid;begin
  v_input:=pg_temp.link_input(6)||jsonb_build_object('eventId',(select event_id from link_events where name='date'));
  perform pg_temp.link_actor(1);perform public.create_service_post(p,v_input);
  perform pg_temp.link_actor(2);request:=public.request_service_post(p,'수동 행사 교체 합성 신청');v_request_id:=(request->>'id')::uuid;
  perform pg_temp.link_actor(1);consent:=public.propose_match(v_request_id);
  insert into link_cases(name,post_id,input,event_id,request_id) values('manual',p,v_input,(v_input->>'eventId')::uuid,v_request_id);
  -- A→B, 해제, 새 A 연결, 다시 해제. 마지막 null은 이후 제목 검색 fixture를 분리한다.
  foreach new_event_id in array array[(select event_id from link_events where name='instant'),null::uuid,
    (select event_id from link_events where name='date'),null::uuid] loop
    old_version:=consent->>'conditionVersion';old_fingerprint:=private.match_condition_version(p);
    detail:=public.get_service_post(p);
    perform public.update_service_post(p,v_input||jsonb_build_object('eventId',new_event_id),(detail->>'updatedAt')::timestamptz);
    assert private.match_condition_version(p)<>old_fingerprint;
    assert (select status='invalidated' from private.match_consent_lifecycle where private.match_consent_lifecycle.request_id=v_request_id);
    assert (select status='pending' from public.join_requests where id=v_request_id);
    assert (public.get_service_post(p)->>'startsAt')::timestamptz=(v_input->>'startsAt')::timestamptz;
    assert (public.get_service_post(p)->>'endsAt')::timestamptz=(v_input->>'endsAt')::timestamptz;
    perform pg_temp.link_actor(2);
    perform pg_temp.link_expect(format('select public.accept_match(%L,%L)',v_request_id,old_version),'40001');
    assert (select can_send from public.get_conversation(v_request_id));
    perform pg_temp.link_actor(1);consent:=public.propose_match(v_request_id);
    assert consent->>'status'='awaiting_consent' and consent->>'conditionVersion'<>old_version;
    assert (select condition_fingerprint=private.match_condition_version(p) from private.match_consents where private.match_consents.request_id=v_request_id);
  end loop;
  assert (select count(*) from private.match_lifecycle_events where private.match_lifecycle_events.request_id=v_request_id and kind='post_conditions_changed')=4;
  assert (select count(*) from public.notifications where join_request_id=v_request_id and kind='post_conditions_changed')=2;
  assert (select i.input=v_input from private.service_post_inputs i where i.post_id=p);
  -- 값 생략은 기존 선택 유지이며 새 동의를 무효화하지 않는다.
  old_fingerprint:=private.match_condition_version(p);old_version:=consent->>'conditionVersion';
  detail:=public.get_service_post(p);perform public.update_service_post(p,v_input-'eventId',(detail->>'updatedAt')::timestamptz);
  assert private.match_condition_version(p)=old_fingerprint;
  assert (select status='awaiting_consent' and condition_version=old_version from private.match_consent_lifecycle where private.match_consent_lifecycle.request_id=v_request_id);
end $$;
select 'PASS post_event_update_omission_clear_stale_owner';

set local role authenticated;
select pg_temp.link_actor(2);
do $$ declare c link_cases;request jsonb;consent jsonb;begin
  select * into c from link_cases where name='date';request:=public.request_service_post(c.post_id,'합성 행사 연결 신청');
  perform pg_temp.link_actor(1);consent:=public.propose_match((request->>'id')::uuid);
  update link_cases set request_id=(request->>'id')::uuid,version=consent->>'conditionVersion',
    updated_at=(public.get_service_post(post_id)->>'updatedAt')::timestamptz where name='date';
end $$;
reset role;
update link_cases set fingerprint=private.match_condition_version(post_id) where name='date';
set local role service_role;
do $$ declare event jsonb;begin
  event:=pg_temp.link_event('date','date',1)||jsonb_build_object('title','최신 연결 행사명',
    'placeName','변경 공식 공개 공연장','publicAddress','변경 공식 제공처 공개 주소','sourceStatus','cancelled',
    'startsOn',to_char((now() at time zone 'Asia/Seoul')::date+10,'YYYY-MM-DD'),
    'endsOn',to_char((now() at time zone 'Asia/Seoul')::date+20,'YYYY-MM-DD'));
  assert public.upsert_events(jsonb_build_array(event))->>'updatedCount'='1';
end $$;
reset role;
do $$ declare c link_cases;begin
  select * into c from link_cases where name='date';
  assert (select updated_at=c.updated_at and starts_at=(c.input->>'startsAt')::timestamptz
    and ends_at=(c.input->>'endsAt')::timestamptz and status='recruiting' from public.posts where id=c.post_id);
  assert private.match_condition_version(c.post_id)=c.fingerprint;
  assert (select status='awaiting_consent' from private.match_consent_lifecycle where request_id=c.request_id);
  assert not exists(select 1 from public.notifications where join_request_id=c.request_id and kind='post_conditions_changed');
  assert (select input=c.input from private.service_post_inputs where post_id=c.post_id);
  begin delete from private.source_events where id=c.event_id;raise exception 'linked source deletion allowed';
  exception when foreign_key_violation then null;end;
end $$;
select 'PASS post_event_provider_update_preserves_post_consent_history';

set local role anon;
do $$ declare detail jsonb;result jsonb;item jsonb;begin
  perform set_config('request.jwt.claim.sub','',true);perform set_config('request.jwt.claims','{"role":"anon"}',true);
  detail:=public.get_service_post((select post_id from link_cases where name='date'));
  assert detail#>>'{linkedEvent,title}'='최신 연결 행사명' and detail#>>'{linkedEvent,sourceStatus}'='cancelled';
  assert detail#>>'{linkedEvent,sourceUrl}' is null and detail#>>'{linkedEvent,admission,kind}'='unknown';
  assert not(detail?'privateDetails') and not(detail?'participantNames') and detail->>'authorDisplayName' like '동행-%';
  assert detail::text !~ '비공개 등록|검색 제외 상세|합성행사회원';
  result:=public.search_public_posts_v2('{"query":"최신 연결 행사명"}',null);
  assert jsonb_array_length(result->'items')=1;
  item:=result#>'{items,0}';
  assert (select count(*) from jsonb_object_keys(item))=9 and item ?& array['id','title','authorDisplayName','publicArea','startsAt','endsAt','cost','state','canApply'];
  assert item->>'id'=(select post_id::text from link_cases where name='date') and item->'canApply'='false'::jsonb;
  assert public.search_public_posts_v2('{"query":"합성 행사 date"}',null)->'items'='[]'::jsonb;
  assert public.search_public_posts_v2('{"query":"검색 제외 상세"}',null)->'items'='[]'::jsonb;
  assert not exists(select 1 from jsonb_array_elements(public.list_public_events('{"mode":"post_selection"}',null,50)->'items') e
    where e->>'id'=(select event_id::text from link_events where name='date'));
  perform pg_temp.link_expect('select 1 from private.source_events','42501');
  perform pg_temp.link_expect('select private.project_post_linked_event(null)','42501');
end $$;
reset role;
select 'PASS post_event_anonymous_latest_cancelled_and_search_wire';

set local role authenticated;
select pg_temp.link_actor(1);
do $$ declare c link_cases;detail jsonb;begin
  select * into c from link_cases where name='date';
  assert public.create_service_post(c.post_id,c.input)->>'alreadyCreated'='true';
  perform public.update_service_post(c.post_id,c.input,c.updated_at);
  detail:=public.get_service_post(c.post_id);
  assert detail#>>'{linkedEvent,sourceStatus}'='cancelled' and detail?'privateDetails';
  assert detail#>>'{privateDetails,registeredAddress}'='비공개 등록 주소 123';
  perform pg_temp.link_expect(format('select public.create_service_post(%L,%L::jsonb)',gen_random_uuid(),c.input),'22023');
  perform pg_temp.link_actor(2);
  assert public.search_public_posts_v2('{"query":"최신 연결 행사명","authorAge":{"min":19,"max":99}}',null)#>>'{items,0,canApply}'='false';
  assert not(public.get_service_post(c.post_id)?'privateDetails');
  perform public.accept_match(c.request_id,c.version);
  perform pg_temp.link_actor(1);
end $$;
reset role;
select 'PASS post_event_cancelled_existing_retry_update_and_confirm';

set local role authenticated;
do $$ declare c link_cases;detail jsonb;ap uuid;begin
  select * into c from link_cases where name='date';
  perform pg_temp.link_actor(2);detail:=public.get_service_post(c.post_id);
  assert detail?'privateDetails' and detail?'participantNames' and detail->>'authorDisplayName'='합성행사회원1';
  assert detail#>>'{linkedEvent,sourceStatus}'='cancelled';
  perform pg_temp.link_actor(3);detail:=public.get_service_post(c.post_id);
  assert not(detail?'privateDetails') and not(detail?'participantNames') and detail->>'authorDisplayName'<>'합성행사회원1';
end $$;
reset role;
set local role authenticated;
select pg_temp.link_actor(1);
do $$ declare c link_cases;ap uuid;begin
  select * into c from link_cases where name='date';
  -- 확정 후 입력 수정 차단은 행사 연결에도 동일하다.
  perform pg_temp.link_expect(format('select public.update_service_post(%L,%L::jsonb,%L)',c.post_id,c.input,
    public.get_service_post(c.post_id)->>'updatedAt'),'40001');
end $$;
reset role;
select 'PASS post_event_confirmed_permissions_and_update_gate';

set local role authenticated;
select pg_temp.link_actor(1);
do $$ declare c link_cases;ap uuid;detail jsonb;begin
  select * into c from link_cases where name='date';
  select id into ap from public.appointments where post_id=c.post_id;
  assert public.cancel_appointment(ap,gen_random_uuid(),'합성 약속 취소 검증')->>'status'='cancelled';
  perform pg_temp.link_actor(2);detail:=public.get_service_post(c.post_id);
  assert not(detail?'privateDetails') and not(detail?'participantNames');
  assert detail->>'authorDisplayName'<>'합성행사회원1' and detail#>>'{linkedEvent,sourceStatus}'='cancelled';
  perform pg_temp.link_actor(1);detail:=public.get_service_post(c.post_id);
  assert detail?'privateDetails' and detail#>>'{privateDetails,registeredAddress}'='비공개 등록 주소 123';
  assert jsonb_array_length(detail->'participantNames')=1;
end $$;
reset role;
select 'PASS post_event_cancelled_remasking';

-- 날짜 종료 뒤에도 기존 연결 표시·같은 입력 수정은 허용하며 새 선택만 막는다.
set local role service_role;
do $$ begin
  assert public.upsert_events(jsonb_build_array(pg_temp.link_event('instant','instant',1)||jsonb_build_object(
    'startsAt',to_char((now()-interval '2 hours') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char((now()-interval '1 hour') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))->>'updatedCount'='1';
end $$;
reset role;
set local role authenticated;
select pg_temp.link_actor(1);
do $$ declare c link_cases;detail jsonb;begin
  select * into c from link_cases where name='instant';detail:=public.get_service_post(c.post_id);
  assert detail#>>'{linkedEvent,state}'='ended';
  perform public.update_service_post(c.post_id,c.input,(detail->>'updatedAt')::timestamptz);
  assert public.get_service_post(c.post_id)#>>'{linkedEvent,state}'='ended';
  assert public.create_service_post(c.post_id,c.input)->>'alreadyCreated'='true';
end $$;
reset role;
do $$ begin
  assert not exists(select 1 from link_cases c join private.service_post_inputs i on i.post_id=c.post_id where i.input<>c.input);
end $$;
select 'PASS post_event_existing_ended_and_history';
rollback;
