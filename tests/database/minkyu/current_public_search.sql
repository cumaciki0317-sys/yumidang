-- 민규: 최신 검색 RPC를 실제 로컬 Postgres 역할에서 검사한다. 개인정보 없는 합성 자료만 롤백한다.
begin;
do $$ begin perform set_config('request.jwt.claims','{"role":"service_role"}',true); end $$;
insert into auth.users(id)
select ('86000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,7) n;
insert into public.profiles(id,real_name,birth_date,gender)
select ('86000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'민감작성자'||n,
  (((transaction_timestamp() at time zone 'Asia/Seoul')::date)-make_interval(years=>ages[n]))::date,'female'
from generate_series(1,7) n cross join (select array[19,20,29,39,99,100,25] ages) a;
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,
  public_area,status,cost_type,amount,created_at)
select ('86100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('86000000-0000-4000-8000-'||lpad(author_n::text,12,'0'))::uuid,
  '숫자나이회귀 공고 '||n,'검색금지소개원문',case n when 4 then '맛집' else '전시' end,
  date_trunc('minute',now())+make_interval(days=>start_days)+make_interval(secs=>microseconds::double precision/1000000),
  date_trunc('minute',now())+make_interval(days=>start_days)+interval '2 hours'+make_interval(secs=>microseconds::double precision/1000000),
  case n when 10 then now()-interval '1 minute' else now()+interval '1 day' end,
  '서울특별시 성동구 성수동',status,
  case n when 5 then null else 'free' end,case n when 5 then null else 0 end,
  date_trunc('minute',now())-make_interval(days=>created_days)+make_interval(secs=>microseconds::double precision/1000000)
from (values
  (1,1,8,5,0,'recruiting'),(2,2,7,1,0,'closed'),(3,3,9,3,0,'recruiting'),
  (4,4,10,2,0,'recruiting'),(5,5,6,4,0,'recruiting'),(6,6,11,6,0,'recruiting'),
  (7,1,10,2,1,'recruiting'),(8,5,6,4,1,'closed'),(9,1,8,0,0,'deleted'),(10,2,7,0,0,'recruiting')
) f(n,author_n,start_days,created_days,microseconds,status);
insert into public.post_private_details(post_id,exact_location)
select ('86100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'검색금지만남상세 3층'
from generate_series(1,10) n;
insert into private.post_search_locations(post_id,registered_place_name,registered_address) values
('86100000-0000-4000-8000-000000000001','비공개범위장소','비공개범위주소 전용로 123');
insert into public.join_requests(id,post_id,requester_id,message,status) values
('86200000-0000-4000-8000-000000000007','86100000-0000-4000-8000-000000000007','86000000-0000-4000-8000-000000000007','숫자 범위 회귀 합성 신청입니다','pending'),
('86200000-0000-4000-8000-000000000008','86100000-0000-4000-8000-000000000008','86000000-0000-4000-8000-000000000007','숫자 범위 회귀 합성 신청입니다','matched');
insert into public.appointments(id,post_id,join_request_id,status) values
('86300000-0000-4000-8000-000000000008','86100000-0000-4000-8000-000000000008','86200000-0000-4000-8000-000000000008','confirmed');

create function pg_temp.age_range_ids(p_result jsonb) returns integer[] language sql immutable as $$
  select coalesce(array_agg(right(item->>'id',12)::integer order by ord),'{}'::integer[])
  from jsonb_array_elements(p_result->'items') with ordinality e(item,ord);
$$;
do $$ begin
  assert (select array_agg(public.korean_age(birth_date) order by id) from public.profiles where id::text like '86000000-%')=array[19,20,29,39,99,100,25], 'fixture birthdays do not produce boundary ages';
end $$;

create function pg_temp.current_search(p_filters jsonb,p_cursor jsonb default null,p_limit integer default 10,p_region text default null)
returns jsonb language sql as $$ select public.search_public_posts_v2('2026-10-05',p_region,p_filters,p_cursor,p_limit); $$;
-- 과거 자료는 원래 값을 보존하며 상태 변경을 허용한다. 신규 쓰기와 분리한 합성 역사 fixture.
alter table public.posts disable trigger current_post_content;
update public.posts set category='식사',title=repeat('가',60) where id='86100000-0000-4000-8000-000000000004';
alter table public.posts enable trigger current_post_content;
update public.posts set status='closed' where id='86100000-0000-4000-8000-000000000004';
do $$ begin
 assert (select category='식사' and char_length(title)=60 and status='closed' from public.posts where id='86100000-0000-4000-8000-000000000004'), 'historical row state update was blocked';
 begin update public.posts set category='클래스' where id='86100000-0000-4000-8000-000000000004'; raise exception 'legacy new category accepted'; exception when sqlstate '22023' then null; end;
 update public.posts set category='맛집',title=repeat('😀',50) where id='86100000-0000-4000-8000-000000000004';
 begin update public.posts set title=repeat('😀',51) where id='86100000-0000-4000-8000-000000000004'; raise exception '51 characters accepted'; exception when sqlstate '22023' then null; end;
 update public.posts set title='숫자나이회귀 공고 4',status='recruiting' where id='86100000-0000-4000-8000-000000000004';
 update public.post_private_details set exact_location=repeat('😀',300) where post_id='86100000-0000-4000-8000-000000000001';
 begin update public.post_private_details set exact_location=repeat('😀',301) where post_id='86100000-0000-4000-8000-000000000001'; raise exception '301 detail accepted'; exception when check_violation then null; end;
 update public.post_private_details set exact_location='검색금지만남상세 3층' where post_id='86100000-0000-4000-8000-000000000001';
end $$;
select 'PASS current_post_content_and_history';
do $$ declare e jsonb; eid uuid; v_category text; begin
 e:=jsonb_build_object('provider','kopis','sourceId','current-search-fixture','sourceStatus','active','title','행사검색전용',
  'category','뮤지컬','region','서울','placeName','공식 공개 장소','publicAddress','공식 제공처 공개 주소',
  'admission',jsonb_build_object('kind','unknown'),'sourceUrl',null,'precision','date',
  'startsOn','2099-01-01','endsOn','2099-01-02','collectedAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 insert into private.source_events(provider,source_id,collected_at,record)
 values('kopis','current-search-fixture',(e->>'collectedAt')::timestamptz,e) returning id into eid;
 update public.posts set source_event_id=eid where id='86100000-0000-4000-8000-000000000001';
 foreach v_category in array array['지금이당','전시','축제','팝업','공연','영화','맛집','카페','쇼핑','여행','운동','산책','게임','반려동물','스터디','기타'] loop
  update public.posts set category=v_category where id='86100000-0000-4000-8000-000000000001';
 end loop;
 update public.posts set category='전시' where id='86100000-0000-4000-8000-000000000001';
 insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status,cost_type,amount)
 select ('86110000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,author_id,'최신페이지 공고 '||n,description,
 category,starts_at,ends_at,recruitment_ends_at,public_area,'recruiting','free',0
 from public.posts cross join generate_series(1,11) n where id='86100000-0000-4000-8000-000000000001';
end $$;
set local role authenticated;
do $$ begin
 perform set_config('request.jwt.claim.sub','86000000-0000-4000-8000-000000000007',true);
 perform set_config('request.jwt.claims','{"role":"authenticated","sub":"86000000-0000-4000-8000-000000000007"}',true);
end $$;
do $$ declare r jsonb; begin
  r:=pg_temp.current_search('{"query":"숫자나이회귀","authorAge":{"min":19,"max":99}}',null);
  assert pg_temp.age_range_ids(r)=array[10,2,7,4,3,8,5,1], 'inclusive range or all-state order changed';
  assert pg_temp.age_range_ids(pg_temp.current_search('{"query":"숫자나이회귀","authorAge":{"min":19,"max":19}}',null))=array[7,1], '19 boundary missing';
  assert pg_temp.age_range_ids(pg_temp.current_search('{"query":"숫자나이회귀","authorAge":{"min":99,"max":99}}',null))=array[8,5], '99 boundary missing';
  assert pg_temp.age_range_ids(pg_temp.current_search('{"query":"숫자나이회귀","authorAge":{"min":19,"max":20}}',null))=array[10,2,7,1], 'range endpoints are exclusive';
  assert pg_temp.age_range_ids(pg_temp.current_search('{"query":"숫자나이회귀","authorAge":"all"}',null))=array[10,2,7,4,3,8,5,1,6], 'all incorrectly caps age100';
  assert pg_temp.current_search('{"query":"숫자나이회귀"}',null)=pg_temp.current_search('{"query":"숫자나이회귀","authorAge":"all"}',null), 'omitted all changed';
  assert pg_temp.current_search('{"query":"숫자나이회귀","authorAge":{"min":19.0,"max":1.9e1}}',null)
    =pg_temp.current_search('{"query":"숫자나이회귀","authorAge":{"min":19,"max":19}}',null), 'mathematical JSON integers differ';
end $$;
select 'PASS age_range_boundaries';

do $$ declare bad jsonb; begin
  for bad in select value from jsonb_array_elements('[
    {"min":30,"max":19},{"min":18,"max":99},{"min":19,"max":100},{"min":0,"max":0},
    {"min":19},{"max":99},{},{"min":"19","max":99},{"min":19,"max":"99"},
    {"min":null,"max":99},{"min":19,"max":null},{"min":19.1,"max":99},{"min":19,"max":98.9},
    {"min":true,"max":99},{"min":[],"max":99},{"min":{},"max":99},{"min":19,"max":99,"extra":true},
    {"min":99999999999999999999999999999999999999,"max":99},{"min":19,"max":1e1000},
    null,[],19,true,"19-99","19s","range"
  ]'::jsonb) loop
    begin
      perform pg_temp.current_search(jsonb_build_object('query','숫자나이회귀','authorAge',bad),null);
      raise exception 'invalid numeric range accepted';
    exception when sqlstate '22023' then null; end;
  end loop;
  begin
    perform pg_temp.current_search('{"query":"숫자나이회귀","authorAge":{"min":19,"max":99},"caller":"member"}',null);
    raise exception 'caller discriminator accepted';
  exception when sqlstate '22023' then null; end;
end $$;
select 'PASS age_range_invalid_inputs';

do $$ declare sort text; filters jsonb; page jsonb; cursor jsonb; item jsonb; seen integer[]; expected integer[]; n integer; calls integer; begin
  foreach sort in array array['created_desc','starts_asc'] loop
    expected:=case sort when 'created_desc' then array[10,2,7,4,3,8,5,1] else array[5,8,2,10,1,3,4,7] end;
    filters:=jsonb_build_object('query','숫자나이회귀','authorAge',jsonb_build_object('min',19,'max',99),'sort',sort);
    seen:='{}'; cursor:=null; calls:=0;
    loop
      page:=pg_temp.current_search(filters,cursor,2); calls:=calls+1;
      assert calls<=4, 'range cursor cycle';
      for item in select value from jsonb_array_elements(page->'items') loop
        n:=right(item->>'id',12)::integer;
        assert not(n=any(seen)), 'range keyset duplicate'; seen:=array_append(seen,n);
      end loop;
      cursor:=page->'nextCursor'; exit when cursor='null'::jsonb;
      assert (select count(*) from jsonb_object_keys(cursor))=2 and cursor ?& array['sortAt','id'], 'cursor projection expanded';
      assert cursor->>'id'=page#>>array['items',(jsonb_array_length(page->'items')-1)::text,'id'], 'cursor detached from page';
    end loop;
    assert calls=4 and seen=expected, 'filtered keyset lost order/microseconds/items';
  end loop;
end $$;
select 'PASS age_range_keyset_sort';

do $$ declare filters jsonb; start_at text; end_at text; begin
  filters:='{"query":"숫자나이회귀","authorAge":{"min":19,"max":99}}';
  assert pg_temp.age_range_ids(pg_temp.current_search(filters||'{"availability":"recruiting"}',null))=array[7,4,3,5,1], 'availability did not intersect range';
  assert pg_temp.age_range_ids(pg_temp.current_search(filters||'{"cost":"free"}',null))=array[10,2,7,4,3,8,1], 'unknown cost inferred free';
  assert pg_temp.current_search(filters||'{"cost":"paid"}',null)='{"items":[],"nextCursor":null}'::jsonb, 'paid cards fabricated';
  assert pg_temp.age_range_ids(pg_temp.current_search(filters||'{"category":"맛집"}',null))=array[4], 'category did not intersect range';
  start_at:=to_char((date_trunc('minute',now())+interval '6 days 1 hour') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  end_at:=to_char((date_trunc('minute',now())+interval '7 days 1 hour') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  assert pg_temp.age_range_ids(pg_temp.current_search(filters||jsonb_build_object('sort','starts_asc','periodStart',start_at,'periodEnd',end_at),null))=array[5,8,2,10], 'period grouping overrode chosen sort';
end $$;
select 'PASS age_range_combined_filters';

do $$ declare base jsonb; r jsonb; item jsonb; q text; begin
  base:=pg_temp.current_search('{"query":"숫자나이회귀"}',null);
  r:=pg_temp.current_search('{"query":"숫자나이회귀","authorAge":{"min":19,"max":99}}',null);
  assert not exists(select 1 from jsonb_array_elements(r->'items') e where e->'canApply'='true'::jsonb), 'legacy profile advertised application without Naver session';
  for item in select value from jsonb_array_elements(r->'items') loop
    assert (select count(*) from jsonb_object_keys(item))=9 and item ?& array['id','title','authorDisplayName','publicArea','startsAt','endsAt','cost','state','canApply'], 'range added private projection';
    assert item->>'authorDisplayName' ~ '^민[*]+[0-9]$', 'member card leaked full name';
    assert item::text !~ '민감작성자|birthDate|birth_date|authorAge|authorId|registeredAddress|비공개범위|검색금지만남상세|검색금지소개원문', 'range leaked private data';
    assert item->'canApply'=(select b->'canApply' from jsonb_array_elements(base->'items') b where b->>'id'=item->>'id'), 'age changed application decision';
  end loop;
  foreach q in array array['비공개범위장소','비공개범위주소'] loop
    r:=pg_temp.current_search(jsonb_build_object('query',q,'authorAge',jsonb_build_object('min',19,'max',19)),null);
    assert pg_temp.age_range_ids(r)=array[1] and r::text !~ '비공개범위', 'predicate source projected';
  end loop;
  foreach q in array array['검색금지만남상세','검색금지소개원문','민감작성자','성수동'] loop
    assert pg_temp.current_search(jsonb_build_object('query',q,'authorAge',jsonb_build_object('min',19,'max',99)),null)='{"items":[],"nextCursor":null}'::jsonb, 'forbidden field became searchable';
  end loop;
  begin perform 1 from private.post_search_locations; raise exception 'member raw source accessible';
  exception when insufficient_privilege then null; end;
end $$;
select 'PASS age_range_private_projection';
do $$ declare bad text; begin
 foreach bad in array array['20s','30s','40plus'] loop
  begin perform pg_temp.current_search(jsonb_build_object('authorAge',bad)); raise exception 'legacy age accepted'; exception when sqlstate '22023' then null; end;
 end loop;
 assert pg_temp.age_range_ids(pg_temp.current_search('{"query":"숫자나이회귀"}',null,10,'서울특별시'))=array[10,2,7,4,3,8,5,1,6];
 assert pg_temp.current_search('{"query":"숫자나이회귀"}',null,10,'부산광역시')='{"items":[],"nextCursor":null}'::jsonb;
 begin perform pg_temp.current_search('{}',null,10,'서울'); raise exception 'invalid region accepted'; exception when sqlstate '22023' then null; end;
 begin perform public.search_public_posts_v2('2026-09-30',null,'{}',null); raise exception 'old version accepted'; exception when sqlstate '22023' then null; end;
 begin perform public.search_public_posts_v2(null,null,'{}',null); raise exception 'null version accepted'; exception when sqlstate '22023' then null; end;
end $$;
reset role;
set local role authenticated;
do $$ declare r jsonb; begin
 r:=pg_temp.current_search('{"query":"최신페이지"}');
 assert jsonb_array_length(r->'items')=10 and r->'nextCursor'<>'null'::jsonb,'default10 page not enforced';
 assert jsonb_array_length(pg_temp.current_search('{"query":"최신페이지"}',r->'nextCursor')->'items')=1,'next page lost row';
 assert pg_temp.age_range_ids(pg_temp.current_search('{"query":"행사검색전용"}'))=array[1],'linked event title not searched';
 assert pg_temp.current_search('{"query":"행사검색전용"}')::text !~ '행사검색전용|sourceId|registeredAddress','event predicate leaked';
end $$;
reset role;
select 'PASS current_region_and_contract';
set local role anon;
do $$ declare item jsonb; begin
 perform set_config('request.jwt.claim.sub','',true);
 perform set_config('request.jwt.claims','{"role":"anon"}',true);
 for item in select value from jsonb_array_elements(pg_temp.current_search('{"query":"숫자나이회귀"}')->'items') loop
  assert item->'authorDisplayName'='null'::jsonb and item->'canApply'='false'::jsonb;
 end loop;
 assert public.get_service_post('86100000-0000-4000-8000-000000000001')->'authorDisplayName'='null'::jsonb;
 assert not(public.get_service_post('86100000-0000-4000-8000-000000000001')?'privateDetails');
 begin perform pg_temp.current_search('{"authorAge":{"min":19,"max":99}}'); raise exception 'anonymous age accepted'; exception when sqlstate '28000' then null; end;
 begin perform pg_temp.current_search('{"periodStart":"2026-10-06T00:00:00Z","periodEnd":"2026-10-07T00:00:00Z"}'); raise exception 'anonymous period accepted'; exception when sqlstate '28000' then null; end;
 begin perform 1 from private.post_search_locations; raise exception 'private table accessible'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
 perform set_config('request.jwt.claim.sub','86000000-0000-4000-8000-000000000001',true);
 perform set_config('request.jwt.claims','{"role":"authenticated","sub":"86000000-0000-4000-8000-000000000001","is_anonymous":true}',true);
 assert public.get_service_post('86100000-0000-4000-8000-000000000001')->'authorDisplayName'='null'::jsonb;
 assert not(public.get_service_post('86100000-0000-4000-8000-000000000001')?'participantNames');
 begin perform pg_temp.current_search('{"authorAge":{"min":19,"max":99}}'); raise exception 'guest age accepted'; exception when sqlstate '28000' then null; end;
end $$;
reset role;
select 'PASS current_anonymous_and_guest_privacy';
do $$ begin
 assert to_regprocedure('public.search_public_posts_v2(jsonb,jsonb,integer)') is null,'old bypass RPC retained';
 assert not has_function_privilege('anon','private.post_search_region(text)','execute');
 assert has_function_privilege('anon','public.search_public_posts_v2(text,text,jsonb,jsonb,integer)','execute');
end $$;
select 'PASS current_search_acl';
rollback;
