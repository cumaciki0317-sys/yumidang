-- Owner-only fixture setup; public RPC probes run under actual anon/member roles.
-- Synthetic state/schedule combinations intentionally distinguish state and sort priorities.
-- No permanent data or permission changes survive this suite.
begin;
-- Owner setup uses maintenance claims; member probes below use actual authenticated role.
do $$ begin
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
end $$;
insert into auth.users(id)
select ('51000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,5) n;
insert into public.profiles(id,real_name,birth_date,gender)
select ('51000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  case n when 1 then '이십작성자' when 2 then '삼십작성자' when 3 then '사십작성자' else '조회회원' end,
  ((now() at time zone 'Asia/Seoul')::date-make_interval(years=>case n when 1 then 25 when 2 then 35 when 3 then 45 else 29 end))::date,
  'female'
from generate_series(1,5) n;

insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,
  recruitment_ends_at,public_area,status,cost_type,amount,created_at)
select ('52000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('51000000-0000-4000-8000-'||lpad((case when n in(2,7,10) then 2 when n in(3,8) then 3 else 1 end)::text,12,'0'))::uuid,
  '회귀검색 공고 '||n||case when n=1 then ' Alpha   BETA' else '' end,
  '소개전용검색금지',case when n=2 then '식사' else '전시' end,
  date_trunc('minute',now())+make_interval(days=>case n when 1 then 10 when 2 then 8 when 3 then 12 when 4 then 7 when 5 then 6 when 6 then 9 when 7 then 11 when 8 then 11 else 10 end)
    +case n when 9 then interval '1 microsecond' when 10 then interval '2 microseconds' else interval '0' end,
  date_trunc('minute',now())+make_interval(days=>case n when 1 then 10 when 2 then 8 when 3 then 12 when 4 then 7 when 5 then 6 when 6 then 9 when 7 then 11 when 8 then 11 else 10 end)
    +interval '2 hours'+case n when 9 then interval '1 microsecond' when 10 then interval '2 microseconds' else interval '0' end,
  case when n=4 then now()-interval '1 minute' else now()+interval '1 day' end,
  '서울특별시 성동구 성수동',
  case when n=5 then 'deleted' when n in(2,6,7,8) then 'closed' else 'recruiting' end,
  case when n=3 then null else 'free' end,case when n=3 then null else 0 end,
  date_trunc('minute',now())-make_interval(days=>case n when 2 then 1 when 4 then 2 when 6 then 3 when 3 then 4 when 7 then 5 when 8 then 6 else 7 end)
    +case when n in(9,10) then interval '2 microseconds' when n=1 then interval '1 microsecond' else interval '0' end
from generate_series(1,10) n;
insert into public.post_private_details(post_id,exact_location)
select ('52000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'만남상세검색금지 3층 안내'
from generate_series(1,10) n;
insert into private.post_search_locations(post_id,registered_place_name,registered_address) values
('52000000-0000-4000-8000-000000000001','PRIVATE   Gallery','비공개주소 전용로 123'),
('52000000-0000-4000-8000-000000000002','Percent%_Place','비공개다른주소 456');

insert into public.join_requests(id,post_id,requester_id,message,status)
select ('53000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('52000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  '51000000-0000-4000-8000-000000000004','함께 동행하고 싶어요 테스트',
  case n when 9 then 'pending' when 10 then 'declined' else 'matched' end
from unnest(array[6,7,8,9,10]) n;
insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,
  completion_notified_at,dispute_deadline_at,review_deadline_at)
select ('54000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('52000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('53000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  case n when 6 then 'confirmed' when 7 then 'completed' else 'cancelled' end,
  case when n=7 then now()-interval '2 days' end,
  case when n=7 then 'automatic' end,
  case when n=7 then now()-interval '2 days' end,
  case when n=7 then now()-interval '1 day' end,
  case when n=7 then now()+interval '5 days' end
from unnest(array[6,7,8]) n;

set local role anon;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$
declare
  v_result jsonb; v_item jsonb; v_page jsonb; v_cursor jsonb;
  v_filters jsonb; v_bad jsonb; v_ids integer[]; v_seen integer[];
  v_sort text; v_query text; v_expected integer[]; v_n integer; v_calls integer;
begin
  -- Default is all states, latest creation first. A closed post must precede recruiting posts.
  v_result:=public.search_public_posts_v2('{"query":"회귀검색"}',null);
  select array_agg(right(item->>'id',12)::integer order by ord) into v_ids
    from jsonb_array_elements(v_result->'items') with ordinality as e(item,ord);
  assert v_ids=array[2,4,6,3,7,8,9,10,1], 'default all/latest order lost or status precedence inserted';
  assert v_result->'nextCursor'='null'::jsonb, 'default page size unexpectedly truncated fixture';
  assert public.search_public_posts_v2('{"query":"회귀검색","category":null,"periodStart":null,"periodEnd":null}',null)=v_result,
    'nullable category/periods differ from omitted filters';
  assert v_result#>>'{items,0,state}'='closed', 'manual closed post became recruiting';
  assert v_result#>>'{items,1,state}'='expired', 'elapsed recruitment was not expired';
  assert v_result#>>'{items,2,state}'='confirmed', 'confirmed appointment did not override closed post';
  assert v_result#>>'{items,4,state}'='closed' and v_result#>>'{items,5,state}'='closed', 'completed/cancelled reason escaped as distinct public state';
  assert v_result#>'{items,3,cost}'='null'::jsonb, 'legacy unknown cost inferred free';
  assert public.search_public_posts_v2('{"query":"회귀검색","sort":"created_desc"}',null)=v_result,
    'omitted sort differs from latest creation default';

  for v_item in select value from jsonb_array_elements(v_result->'items') loop
    assert (select count(*) from jsonb_object_keys(v_item))=9
      and v_item ?& array['id','title','authorDisplayName','publicArea','startsAt','endsAt','cost','state','canApply'],
      'unexpected/missing public projection field';
    assert v_item->>'publicArea'='서울특별시 성동구 성수동', 'public neighborhood was stripped';
    assert v_item->>'authorDisplayName' ~ '^동행[[:space:]]?[0-9]+$', 'anonymous alias missing';
    assert v_item->'canApply'='false'::jsonb, 'anonymous can apply';
    assert v_item::text !~ '작성자|birth_date|birthDate|비공개주소|비공개다른주소|만남상세검색금지|registeredAddress|exact_location',
      'private fields or name leaked';
  end loop;
  assert public.search_public_posts_v2('{"query":"회귀검색"}',null)=v_result, 'anonymous projection unstable in same request context';

  v_result:=public.search_public_posts_v2('{"query":"회귀검색","sort":"starts_asc"}',null);
  select array_agg(right(item->>'id',12)::integer order by ord) into v_ids
    from jsonb_array_elements(v_result->'items') with ordinality as e(item,ord);
  assert v_ids=array[4,2,6,1,9,10,7,8,3], 'start order lost microseconds or adds status grouping';
  v_result:=public.search_public_posts_v2('{"query":"회귀검색","availability":"recruiting"}',null);
  select array_agg(right(item->>'id',12)::integer order by ord) into v_ids
    from jsonb_array_elements(v_result->'items') with ordinality as e(item,ord);
  assert v_ids=array[3,9,10,1], 'recruiting toggle did not preserve selected order';
  assert jsonb_array_length(public.search_public_posts_v2('{"query":"회귀검색","cost":"free"}',null)->'items')=8,
    'free filter admitted unknown or deleted';
  assert public.search_public_posts_v2('{"query":"회귀검색","cost":"paid"}',null)='{"items":[],"nextCursor":null}'::jsonb,
    'unimplemented paid data was fabricated';
  assert jsonb_array_length(public.search_public_posts_v2('{"query":"회귀검색","category":"식사"}',null)->'items')=1,
    'category filter ignored';

  -- Normalize each searchable field, but never concatenate fields or interpret SQL wildcards.
  foreach v_query in array array['  aLPHa beta  ','private gallery','비공개주소 전용로'] loop
    v_result:=public.search_public_posts_v2(jsonb_build_object('query',v_query),null);
    assert jsonb_array_length(v_result->'items')=1
      and v_result#>>'{items,0,id}'='52000000-0000-4000-8000-000000000001', 'title/place/address match failed';
    assert v_result::text !~ 'PRIVATE|비공개주소|만남상세검색금지', 'search predicate fields projected';
  end loop;
  foreach v_query in array array['%','_','%_'] loop
    v_result:=public.search_public_posts_v2(jsonb_build_object('query',v_query),null);
    assert jsonb_array_length(v_result->'items')=1
      and v_result#>>'{items,0,id}'='52000000-0000-4000-8000-000000000002', 'wildcard interpreted instead of literal';
  end loop;
  foreach v_query in array array['소개전용검색금지','만남상세검색금지','성수동','이십작성자','BETA PRIVATE','없는검색어'] loop
    assert public.search_public_posts_v2(jsonb_build_object('query',v_query),null)='{"items":[],"nextCursor":null}'::jsonb,
      'forbidden field/concatenated fields matched or empty response malformed';
  end loop;

  -- Anonymous periods are allowed; prior-overlapping posts stay first under starts_asc.
  v_filters:=jsonb_build_object('query','회귀검색','sort','starts_asc',
    'periodStart',to_char((date_trunc('minute',now())+interval '10 days 1 hour') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'periodEnd',to_char((date_trunc('minute',now())+interval '11 days 1 hour') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  v_result:=public.search_public_posts_v2(v_filters,null);
  select array_agg(right(item->>'id',12)::integer order by ord) into v_ids
    from jsonb_array_elements(v_result->'items') with ordinality as e(item,ord);
  assert v_ids=array[1,9,10,7,8], 'anonymous period failed or automatic period grouping changed requested sort';
  v_filters:=jsonb_build_object('query','회귀검색','sort','starts_asc',
    'periodStart',to_char((date_trunc('minute',now())+interval '10 days 2 hours 2 microseconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'periodEnd',to_char((date_trunc('minute',now())+interval '11 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  assert public.search_public_posts_v2(v_filters,null)='{"items":[],"nextCursor":null}'::jsonb,
    'touching-only intervals treated as positive overlap';

  -- Walk both keyset orders with tiny pages. Creation ties and adjacent microseconds span pages.
  foreach v_sort in array array['created_desc','starts_asc'] loop
    v_expected:=case v_sort when 'created_desc' then array[2,4,6,3,7,8,9,10,1] else array[4,2,6,1,9,10,7,8,3] end;
    v_filters:=jsonb_build_object('query','회귀검색','sort',v_sort);
    v_seen:='{}'::integer[]; v_cursor:=null; v_calls:=0;
    loop
      v_page:=public.search_public_posts_v2(v_filters,v_cursor,2);
      v_calls:=v_calls+1;
      assert v_calls<=5, 'cursor cycle';
      for v_item in select value from jsonb_array_elements(v_page->'items') loop
        v_n:=right(v_item->>'id',12)::integer;
        assert not(v_n=any(v_seen)), 'duplicate item across pages';
        v_seen:=array_append(v_seen,v_n);
      end loop;
      v_cursor:=v_page->'nextCursor';
      exit when v_cursor='null'::jsonb;
      assert (select count(*) from jsonb_object_keys(v_cursor))=2 and v_cursor ?& array['sortAt','id'], 'cursor format changed';
      assert v_cursor->>'id'=v_page#>>array['items',(jsonb_array_length(v_page->'items')-1)::text,'id'], 'cursor not anchored to last item';
    end loop;
    assert v_seen=v_expected, 'keyset pagination lost/duplicated/misordered rows';
    assert v_calls=5, 'unexpected page coverage';
  end loop;

  begin
    perform public.search_public_posts_v2('{"authorAge":"20s"}',null);
    raise exception 'anonymous age search allowed';
  exception when sqlstate '28000' then null; end;
  assert jsonb_array_length(public.search_public_posts_v2('{"query":"회귀검색","authorAge":"all"}','null'::jsonb)->'items')=9,
    'anonymous all age or JSON null cursor rejected';

  for v_bad in select value from jsonb_array_elements('[null,[],{"sort":"grouped"},{"caller":"member"},{"userId":"fake"},{"unknown":true},
    {"query":1},{"category":"invalid"},{"cost":"unknown"},{"availability":"open"},{"authorAge":"19s"},
    {"periodStart":"2026-01-01T00:00:00Z"},
    {"periodStart":"2026-01-01T00:00:00Z","periodEnd":null},
    {"periodStart":null,"periodEnd":"2026-01-02T00:00:00Z"},
    {"periodStart":"2026-01-02T00:00:00Z","periodEnd":"2026-01-01T00:00:00Z"},
    {"periodStart":"2026-01-01T00:00:00","periodEnd":"2026-01-02T00:00:00"}]'::jsonb) loop
    begin
      perform public.search_public_posts_v2(v_bad,null);
      raise exception 'invalid filter accepted';
    exception when invalid_parameter_value then null; end;
  end loop;
  begin
    perform public.search_public_posts_v2(jsonb_build_object('query',repeat('x',301)),null);
    raise exception 'oversize query accepted';
  exception when invalid_parameter_value then null; end;
  for v_bad in select value from jsonb_array_elements('[{},[],{"id":"52000000-0000-4000-8000-000000000001"},
    {"sortAt":"infinity","id":"52000000-0000-4000-8000-000000000001"},
    {"sortAt":"2026-01-01T00:00:00Z","id":"not-a-uuid"},
    {"sortAt":"2026-01-01T00:00:00Z","id":"52000000-0000-4000-8000-000000000001","periodGroup":0}]'::jsonb) loop
    begin
      perform public.search_public_posts_v2('{"query":"회귀검색"}',v_bad);
      raise exception 'invalid cursor accepted';
    exception when invalid_parameter_value then null; end;
  end loop;
  foreach v_n in array array[0,51,-1] loop
    begin
      perform public.search_public_posts_v2('{}',null,v_n);
      raise exception 'invalid limit accepted';
    exception when invalid_parameter_value then null; end;
  end loop;
  begin
    perform public.search_public_posts_v2('{}',null,null);
    raise exception 'null limit accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform 1 from private.post_search_locations;
    raise exception 'anonymous raw address read allowed';
  exception when insufficient_privilege then null; end;
end;
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','51000000-0000-4000-8000-000000000004',true);
select set_config('request.jwt.claims','{"role":"authenticated","sub":"51000000-0000-4000-8000-000000000004"}',true);
do $$
declare v_result jsonb; v_item jsonb;
begin
  v_result:=public.search_public_posts_v2('{"query":"회귀검색","authorAge":"20s"}',null);
  assert jsonb_array_length(v_result->'items')=4, 'legacy member age search was blocked';
  for v_item in select value from jsonb_array_elements(v_result->'items') loop
    assert v_item->'canApply'='false'::jsonb, 'unregistered legacy session advertised new activity';
  end loop;
  assert v_result#>>'{items,3,id}'='52000000-0000-4000-8000-000000000001',
    'eligible post missing from unregistered-session comparison';
end;
$$;
reset role;
select 'PASS public_search_v2_unregistered_session';

-- Synthetic SQL metadata verifies canonical permission; it does not simulate an actual JPEG upload.
do $$ begin
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
end $$;
insert into auth.sessions(id,user_id) values
('55000000-0000-4000-8000-000000000004','51000000-0000-4000-8000-000000000004');
insert into private.naver_accounts(subject,user_id,real_name,birth_date,gender,verification_status,completed_at)
select 'public-search-v2-qualified','51000000-0000-4000-8000-000000000004',real_name,birth_date,
  'female','qualified',now()
from public.profiles where id='51000000-0000-4000-8000-000000000004';
update auth.users set email=(select auth_email from private.naver_accounts where subject='public-search-v2-qualified')
where id='51000000-0000-4000-8000-000000000004';
insert into private.naver_sessions(session_id,user_id,subject) values
('55000000-0000-4000-8000-000000000004','51000000-0000-4000-8000-000000000004','public-search-v2-qualified');
insert into storage.objects(bucket_id,name,owner_id,metadata) values
('profile-images','51000000-0000-4000-8000-000000000004/56000000-0000-4000-8000-000000000004.jpg',
  '51000000-0000-4000-8000-000000000004','{"mimetype":"image/jpeg","size":100}');
update public.profiles set avatar_url='51000000-0000-4000-8000-000000000004/56000000-0000-4000-8000-000000000004.jpg'
where id='51000000-0000-4000-8000-000000000004';

set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub','51000000-0000-4000-8000-000000000004',true);
  perform set_config('request.jwt.claims','{"role":"authenticated","sub":"51000000-0000-4000-8000-000000000004","session_id":"55000000-0000-4000-8000-000000000004","is_anonymous":false}',true);
end $$;
do $$
declare v_result jsonb; v_item jsonb; v_ids integer[];
begin
  v_result:=public.search_public_posts_v2('{"query":"회귀검색","authorAge":"20s"}',null);
  select array_agg(right(item->>'id',12)::integer order by ord) into v_ids
    from jsonb_array_elements(v_result->'items') with ordinality as e(item,ord);
  assert v_ids=array[4,6,9,1], 'member age band incorrect';
  for v_item in select value from jsonb_array_elements(v_result->'items') loop
    assert v_item->>'authorDisplayName'='이***자', 'member name was not masked';
    assert not(v_item ?| array['birthDate','birth_date','age','realName','authorId','registeredAddress','meetingDetail']), 'age/private source returned';
    if v_item->>'id'='52000000-0000-4000-8000-000000000001' then
      assert v_item->'canApply'='true'::jsonb, 'eligible free post not applicable';
    else
      assert v_item->'canApply'='false'::jsonb, 'closed/expired/pending application admitted';
    end if;
  end loop;
  assert jsonb_array_length(public.search_public_posts_v2('{"query":"회귀검색","authorAge":"30s"}',null)->'items')=3, '30s band wrong';
  assert jsonb_array_length(public.search_public_posts_v2('{"query":"회귀검색","authorAge":"40plus"}',null)->'items')=2, '40plus band wrong';
  v_result:=public.search_public_posts_v2('{"query":"회귀검색"}',null);
  for v_item in select value from jsonb_array_elements(v_result->'items') loop
    if right(v_item->>'id',12)::integer in(3,10) then
      assert v_item->'canApply'='false'::jsonb, 'unknown cost or declined history admitted';
    end if;
  end loop;
  begin
    perform 1 from private.post_search_locations;
    raise exception 'member raw address read allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform public.set_post_search_location('52000000-0000-4000-8000-000000000001',null,'임의 주소');
    raise exception 'member search location write allowed';
  exception when insufficient_privilege then null; end;
end;
$$;
select set_config('request.jwt.claim.sub','51000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"role":"authenticated","sub":"51000000-0000-4000-8000-000000000001"}',true);
do $$
declare v_result jsonb;
begin
  v_result:=public.search_public_posts_v2('{"query":"Alpha beta"}',null);
  assert v_result#>'{items,0,canApply}'='false'::jsonb, 'author can apply to own post';
  assert v_result#>>'{items,0,authorDisplayName}'='이***자', 'own search card exposed full name';
end;
$$;
reset role;

do $$
begin
  assert (select count(*) from public.posts where id::text like '52000000-%' and public_area='서울특별시 성동구 성수동')=10,
    'stored public neighborhoods changed';
  assert (select count(*) from public.post_private_details where post_id::text like '52000000-%' and exact_location='만남상세검색금지 3층 안내')=10,
    'private legacy details changed';
  assert (select cost_type is null and amount is null from public.posts where id='52000000-0000-4000-8000-000000000003'),
    'legacy null cost was backfilled';
end;
$$;
select 'PASS public_search_v2_regression';
rollback;
