-- 민규: 숫자 나이 검색의 실제 역할·경계·정렬·권한 회귀. 합성 자료는 모두 롤백한다.
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
  '숫자나이회귀 공고 '||n,'검색금지소개원문',case n when 4 then '식사' else '전시' end,
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

set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub','86000000-0000-4000-8000-000000000007',true);
  perform set_config('request.jwt.claims','{"role":"authenticated","sub":"86000000-0000-4000-8000-000000000007"}',true);
end $$;
do $$ declare r jsonb; begin
  r:=public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":19,"max":99}}',null);
  assert pg_temp.age_range_ids(r)=array[10,2,7,4,3,8,5,1], 'inclusive range or all-state order changed';
  assert pg_temp.age_range_ids(public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":19,"max":19}}',null))=array[7,1], '19 boundary missing';
  assert pg_temp.age_range_ids(public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":99,"max":99}}',null))=array[8,5], '99 boundary missing';
  assert pg_temp.age_range_ids(public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":19,"max":20}}',null))=array[10,2,7,1], 'range endpoints are exclusive';
  assert pg_temp.age_range_ids(public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":"all"}',null))=array[10,2,7,4,3,8,5,1,6], 'all incorrectly caps age100';
  assert public.search_public_posts_v2('{"query":"숫자나이회귀"}',null)=public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":"all"}',null), 'omitted all changed';
  assert public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":19.0,"max":1.9e1}}',null)
    =public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":19,"max":19}}',null), 'mathematical JSON integers differ';
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
      perform public.search_public_posts_v2(jsonb_build_object('query','숫자나이회귀','authorAge',bad),null);
      raise exception 'invalid numeric range accepted';
    exception when sqlstate '22023' then null; end;
  end loop;
  begin
    perform public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":19,"max":99},"caller":"member"}',null);
    raise exception 'caller discriminator accepted';
  exception when sqlstate '22023' then null; end;
end $$;
select 'PASS age_range_invalid_inputs';

do $$ begin
  assert public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":"20s"}',null)
    =public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":20,"max":29}}',null), '20s compatibility lost';
  assert public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":"30s"}',null)
    =public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":30,"max":39}}',null), '30s compatibility lost';
  assert pg_temp.age_range_ids(public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":"40plus"}',null))=array[8,5,6], 'legacy40plus upper bound changed';
end $$;
select 'PASS age_range_legacy_compatibility';

do $$ declare sort text; filters jsonb; page jsonb; cursor jsonb; item jsonb; seen integer[]; expected integer[]; n integer; calls integer; begin
  foreach sort in array array['created_desc','starts_asc'] loop
    expected:=case sort when 'created_desc' then array[10,2,7,4,3,8,5,1] else array[5,8,2,10,1,3,4,7] end;
    filters:=jsonb_build_object('query','숫자나이회귀','authorAge',jsonb_build_object('min',19,'max',99),'sort',sort);
    seen:='{}'; cursor:=null; calls:=0;
    loop
      page:=public.search_public_posts_v2(filters,cursor,2); calls:=calls+1;
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
  assert pg_temp.age_range_ids(public.search_public_posts_v2(filters||'{"availability":"recruiting"}',null))=array[7,4,3,5,1], 'availability did not intersect range';
  assert pg_temp.age_range_ids(public.search_public_posts_v2(filters||'{"cost":"free"}',null))=array[10,2,7,4,3,8,1], 'unknown cost inferred free';
  assert public.search_public_posts_v2(filters||'{"cost":"paid"}',null)='{"items":[],"nextCursor":null}'::jsonb, 'paid cards fabricated';
  assert pg_temp.age_range_ids(public.search_public_posts_v2(filters||'{"category":"식사"}',null))=array[4], 'category did not intersect range';
  start_at:=to_char((date_trunc('minute',now())+interval '6 days 1 hour') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  end_at:=to_char((date_trunc('minute',now())+interval '7 days 1 hour') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  assert pg_temp.age_range_ids(public.search_public_posts_v2(filters||jsonb_build_object('sort','starts_asc','periodStart',start_at,'periodEnd',end_at),null))=array[5,8,2,10], 'period grouping overrode chosen sort';
end $$;
select 'PASS age_range_combined_filters';

do $$ declare base jsonb; r jsonb; item jsonb; q text; begin
  base:=public.search_public_posts_v2('{"query":"숫자나이회귀"}',null);
  r:=public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":19,"max":99}}',null);
  assert not exists(select 1 from jsonb_array_elements(r->'items') e where e->'canApply'='true'::jsonb), 'legacy profile advertised application without Naver session';
  for item in select value from jsonb_array_elements(r->'items') loop
    assert (select count(*) from jsonb_object_keys(item))=9 and item ?& array['id','title','authorDisplayName','publicArea','startsAt','endsAt','cost','state','canApply'], 'range added private projection';
    assert item->>'authorDisplayName' ~ '^민[*]+[0-9]$', 'member card leaked full name';
    assert item::text !~ '민감작성자|birthDate|birth_date|authorAge|authorId|registeredAddress|비공개범위|검색금지만남상세|검색금지소개원문', 'range leaked private data';
    assert item->'canApply'=(select b->'canApply' from jsonb_array_elements(base->'items') b where b->>'id'=item->>'id'), 'age changed application decision';
  end loop;
  foreach q in array array['비공개범위장소','비공개범위주소'] loop
    r:=public.search_public_posts_v2(jsonb_build_object('query',q,'authorAge',jsonb_build_object('min',19,'max',19)),null);
    assert pg_temp.age_range_ids(r)=array[1] and r::text !~ '비공개범위', 'predicate source projected';
  end loop;
  foreach q in array array['검색금지만남상세','검색금지소개원문','민감작성자','성수동'] loop
    assert public.search_public_posts_v2(jsonb_build_object('query',q,'authorAge',jsonb_build_object('min',19,'max',99)),null)='{"items":[],"nextCursor":null}'::jsonb, 'forbidden field became searchable';
  end loop;
  begin perform 1 from private.post_search_locations; raise exception 'member raw source accessible';
  exception when insufficient_privilege then null; end;
end $$;
select 'PASS age_range_private_projection';
reset role;

set local role anon;
do $$ begin
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  perform set_config('request.headers','{"authorization":"Bearer synthetic-forged-token","x-user-id":"86000000-0000-4000-8000-000000000007","x-caller":"member"}',true);
end $$;
do $$ declare age_filter jsonb; item jsonb; begin
  foreach age_filter in array array['{"min":19,"max":99}'::jsonb,'{"min":99,"max":99}'::jsonb,'"20s"'::jsonb] loop
    begin
      perform public.search_public_posts_v2(jsonb_build_object('query','숫자나이회귀','authorAge',age_filter),null);
      raise exception 'anonymous/header spoofing bypassed range';
    exception when sqlstate '28000' then null; end;
  end loop;
  for item in select value from jsonb_array_elements(public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":"all"}',null)->'items') loop
    assert item->>'authorDisplayName' ~ '^동행[[:space:]]?[0-9]+$' and item->'canApply'='false'::jsonb, 'headers changed anonymous projection';
  end loop;
  assert pg_temp.age_range_ids(public.search_public_posts_v2('{"query":"숫자나이회귀"}',null))=array[10,2,7,4,3,8,5,1,6], 'anonymous all excludes age100';
  begin perform 1 from private.post_search_locations; raise exception 'anon raw source accessible';
  exception when insufficient_privilege then null; end;
end $$;
-- UID만으로 인증된 회원이 되지 않는다.
do $$ begin perform set_config('request.jwt.claim.sub','86000000-0000-4000-8000-000000000007',true); end $$;
do $$ begin
  perform public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":19,"max":99}}',null);
  raise exception 'anonymous UID bypassed range';
exception when sqlstate '28000' then null; end $$;
reset role;
set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
end $$;
do $$ begin
  perform public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":19,"max":99}}',null);
  raise exception 'role without UID bypassed range';
exception when sqlstate '28000' then null; end $$;
reset role;
select 'PASS age_range_anonymous_and_spoofing';

-- 아래 객체는 합성 SQL metadata fixture다. 실제 JPEG 업로드 성공을 대신하지 않는다.
insert into auth.sessions(id,user_id) values
('86400000-0000-4000-8000-000000000001','86000000-0000-4000-8000-000000000007'),
('86400000-0000-4000-8000-000000000002','86000000-0000-4000-8000-000000000007');
insert into private.naver_accounts(subject,user_id,real_name,birth_date,gender,verification_status,completed_at)
select 'age-range-qualified','86000000-0000-4000-8000-000000000007',real_name,birth_date,'female','qualified',now()
from public.profiles where id='86000000-0000-4000-8000-000000000007';
update auth.users set email=(select auth_email from private.naver_accounts where subject='age-range-qualified') where id='86000000-0000-4000-8000-000000000007';
insert into private.naver_sessions(session_id,user_id,subject) values
('86400000-0000-4000-8000-000000000001','86000000-0000-4000-8000-000000000007','age-range-qualified');
insert into storage.objects(bucket_id,name,owner_id,metadata) values
('profile-images','86000000-0000-4000-8000-000000000007/86500000-0000-4000-8000-000000000001.jpg','86000000-0000-4000-8000-000000000007','{"mimetype":"image/jpeg","size":100}');
update public.profiles set avatar_url='86000000-0000-4000-8000-000000000007/86500000-0000-4000-8000-000000000001.jpg' where id='86000000-0000-4000-8000-000000000007';
create function pg_temp.age_range_can_apply(p_expected boolean) returns void language plpgsql as $$
declare r jsonb; item jsonb; begin
  r:=public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":19,"max":99}}',null);
  select e into item from jsonb_array_elements(r->'items') e where e->>'id'='86100000-0000-4000-8000-000000000001';
  assert item is not null and item->'canApply'=to_jsonb(p_expected), 'card and canonical activity gate differ';
  assert not exists(select 1 from jsonb_array_elements(r->'items') e where right(e->>'id',12)::integer in(2,5,7,8,10) and e->'canApply'='true'::jsonb), 'other card restrictions weakened';
end $$;
create function pg_temp.age_range_claim(p_session text,p_anonymous boolean default false) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub','86000000-0000-4000-8000-000000000007',true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub','86000000-0000-4000-8000-000000000007','session_id',p_session,'is_anonymous',p_anonymous)::text,true);
end $$;
do $$ begin
  assert not has_function_privilege('anon','private.can_start_naver_activity()','EXECUTE');
  assert not has_function_privilege('authenticated','private.can_start_naver_activity()','EXECUTE');
  assert not has_function_privilege('service_role','private.can_start_naver_activity()','EXECUTE');
end $$;
set local role authenticated;
select pg_temp.age_range_claim('86400000-0000-4000-8000-000000000001');
select pg_temp.age_range_can_apply(true);
do $$ begin
  perform set_config('request.jwt.claims','{"role":"authenticated","sub":"86000000-0000-4000-8000-000000000007","session_id":"86400000-0000-4000-8000-000000000001"}',true);
  perform pg_temp.age_range_can_apply(true);
end $$;
select pg_temp.age_range_claim('86400000-0000-4000-8000-000000000002');
select pg_temp.age_range_can_apply(false);
do $$ declare anonymous_claim jsonb; item jsonb; begin
  foreach anonymous_claim in array array['true'::jsonb,'"false"'::jsonb,'null'::jsonb,'0'::jsonb,'{}'::jsonb] loop
    perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub','86000000-0000-4000-8000-000000000007','session_id','86400000-0000-4000-8000-000000000001','is_anonymous',anonymous_claim)::text,true);
    begin
      perform public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":19,"max":99}}',null);
      raise exception 'guest/malformed claim obtained numeric member filter';
    exception when sqlstate '28000' then null; end;
    for item in select value from jsonb_array_elements(public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":"all"}',null)->'items') loop
      assert item->'canApply'='false'::jsonb and item->>'authorDisplayName' ~ '^동행[[:space:]]?[0-9]+$', 'guest/malformed claim obtained member projection';
    end loop;
  end loop;
end $$;
select pg_temp.age_range_claim('synthetic-invalid-session');
select pg_temp.age_range_can_apply(false);
select pg_temp.age_range_claim('86400000-0000-4000-8000-000000000001');
reset role;
update private.naver_accounts set verification_status='ineligible' where subject='age-range-qualified';
set local role authenticated;
select pg_temp.age_range_can_apply(false);
reset role;
update private.naver_accounts set verification_status='qualified',completed_at=null where subject='age-range-qualified';
set local role authenticated;
select pg_temp.age_range_can_apply(false);
reset role;
update private.naver_accounts set completed_at=now() where subject='age-range-qualified';
update public.profiles set avatar_url=null where id='86000000-0000-4000-8000-000000000007';
set local role authenticated;
select pg_temp.age_range_can_apply(false);
reset role;
update public.profiles set avatar_url='synthetic-invalid-avatar' where id='86000000-0000-4000-8000-000000000007';
set local role authenticated;
select pg_temp.age_range_can_apply(false);
reset role;
update public.profiles set avatar_url='86000000-0000-4000-8000-000000000007/86500000-0000-4000-8000-000000000099.jpg' where id='86000000-0000-4000-8000-000000000007';
set local role authenticated;
select pg_temp.age_range_can_apply(false);
reset role;
update public.profiles set avatar_url='86000000-0000-4000-8000-000000000007/86500000-0000-4000-8000-000000000001.jpg' where id='86000000-0000-4000-8000-000000000007';
update storage.objects set owner_id='86000000-0000-4000-8000-000000000001' where bucket_id='profile-images' and name='86000000-0000-4000-8000-000000000007/86500000-0000-4000-8000-000000000001.jpg';
set local role authenticated;
select pg_temp.age_range_can_apply(false);
reset role;
update storage.objects set owner_id='86000000-0000-4000-8000-000000000007',metadata='{"mimetype":"image/png","size":100}' where bucket_id='profile-images' and name='86000000-0000-4000-8000-000000000007/86500000-0000-4000-8000-000000000001.jpg';
set local role authenticated;
select pg_temp.age_range_can_apply(false);
reset role;
update storage.objects set metadata='{"mimetype":"image/jpeg","size":0}' where bucket_id='profile-images' and name='86000000-0000-4000-8000-000000000007/86500000-0000-4000-8000-000000000001.jpg';
set local role authenticated;
select pg_temp.age_range_can_apply(false);
reset role;
-- canonical 사진 검사의 예상 밖 numeric overflow를 false로 축소하지 않는지 확인한다.
update storage.objects set metadata=jsonb_build_object('mimetype','image/jpeg','size',repeat('9',140000)) where bucket_id='profile-images' and name='86000000-0000-4000-8000-000000000007/86500000-0000-4000-8000-000000000001.jpg';
set local role authenticated;
do $$ begin
  perform public.search_public_posts_v2('{"query":"숫자나이회귀","authorAge":{"min":19,"max":99}}',null);
  raise exception 'unexpected canonical error hidden as false';
exception when sqlstate '22003' then null; end $$;
reset role;
update storage.objects set metadata='{"mimetype":"image/jpeg","size":100}' where bucket_id='profile-images' and name='86000000-0000-4000-8000-000000000007/86500000-0000-4000-8000-000000000001.jpg';
set local role authenticated;
select pg_temp.age_range_can_apply(true);
reset role;
delete from auth.sessions where id='86400000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.age_range_can_apply(false);
reset role;
select 'PASS age_range_naver_can_apply';

do $$ begin
  assert (select count(*) from public.posts where id::text like '86100000-%')=10, 'search changed posts';
  assert (select count(*) from public.profiles where id::text like '86000000-%')=7, 'search changed profiles';
  assert (select cost_type is null and amount is null from public.posts where id='86100000-0000-4000-8000-000000000005'), 'range backfilled unknown cost';
  assert (select exact_location='검색금지만남상세 3층' from public.post_private_details where post_id='86100000-0000-4000-8000-000000000001'), 'private detail mutated';
end $$;
select 'PASS age_range_storage_preserved';
rollback;
