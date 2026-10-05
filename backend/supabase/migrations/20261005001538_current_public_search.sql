-- 민규: 최신 검색 계약. 이전 RPC를 제거해 과도기 연령대/익명 이름/일정 우회를 닫는다.
-- 등록된 공개 지역의 시·도만 정규화한다. 상세 지점·작성자 개인정보는 검색 반환에 포함하지 않는다.
-- 기존 공고의 이전 분류는 역사 자료로 보존하며 새 쓰기에는 현재 16개만 허용한다.
begin;
alter table public.posts drop constraint posts_category_allowed;
create function private.enforce_current_post_content()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' or new.category is distinct from old.category then
    if new.category not in ('지금이당','전시','축제','팝업','공연','영화','맛집','카페','쇼핑','여행','운동','산책','게임','반려동물','스터디','기타') then
      raise exception 'invalid_post_category' using errcode='22023';
    end if;
  end if;
  if tg_op='INSERT' or new.title is distinct from old.title then
    if char_length(new.title)>50 then raise exception 'invalid_post_title' using errcode='22023'; end if;
  end if;
  return new;
end; $$;
revoke all on function private.enforce_current_post_content() from public,anon,authenticated,service_role;
create trigger current_post_content before insert or update on public.posts
 for each row execute function private.enforce_current_post_content();
alter table public.post_private_details drop constraint post_private_details_location_length;
alter table public.post_private_details add constraint post_private_details_location_length
 check(exact_location=btrim(exact_location) and char_length(exact_location) between 2 and 300);
create function private.post_search_region(p_public_area text)
returns text language sql immutable set search_path='' as $$
 select case split_part(btrim(p_public_area),' ',1)
   when '서울' then '서울특별시' when '부산' then '부산광역시' when '대구' then '대구광역시'
   when '인천' then '인천광역시' when '광주' then '광주광역시' when '대전' then '대전광역시'
   when '울산' then '울산광역시' when '세종' then '세종특별자치시' when '경기' then '경기도'
   when '강원' then '강원특별자치도' when '강원도' then '강원특별자치도'
   when '충북' then '충청북도' when '충남' then '충청남도'
   when '전북' then '전북특별자치도' when '전라북도' then '전북특별자치도'
   when '전남' then '전라남도' when '경북' then '경상북도' when '경남' then '경상남도'
   when '제주' then '제주특별자치도' else split_part(btrim(p_public_area),' ',1) end;
$$;
revoke all on function private.post_search_region(text) from public,anon,authenticated,service_role;
drop function public.search_public_posts_v2(jsonb,jsonb,integer);
create function public.search_public_posts_v2(p_contract_version text,p_region text,p_filters jsonb,p_cursor jsonb,p_limit integer default 10)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_uid uuid:=auth.uid();
  -- 누락은 기존 회원과 호환한다. 게스트와 boolean이 아닌 claim은 회원 필터를 사용하지 못한다.
  v_member boolean:=auth.role()='authenticated' and auth.uid() is not null
    and (not (auth.jwt()?'is_anonymous') or auth.jwt()->'is_anonymous'='false'::jsonb);
  v_query text; v_category text; v_cost text; v_availability text; v_age text; v_sort text;
  v_start timestamptz; v_end timestamptz; v_cursor_at timestamptz; v_cursor_id uuid;
  v_key text; v_result jsonb;
  v_age_min integer; v_age_max integer; v_min_numeric numeric; v_max_numeric numeric;
  v_can_start_activity boolean;
begin
  if p_contract_version is distinct from '2026-10-05' then
    raise exception 'unsupported_search_contract' using errcode='22023';
  end if;
  if p_region is not null and p_region not in ('서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시','경기도','강원특별자치도','충청북도','충청남도','전북특별자치도','전라남도','경상북도','경상남도','제주특별자치도') then
    raise exception 'invalid_search_region' using errcode='22023';
  end if;
  if p_filters is null or jsonb_typeof(p_filters)<>'object' or p_limit is null or p_limit not between 1 and 50
    or p_filters-array['query','category','cost','availability','periodStart','periodEnd','authorAge','sort']<>'{}'::jsonb then
    raise exception 'invalid_search_input' using errcode='22023';
  end if;
  for v_key in select jsonb_object_keys(p_filters) loop
    if jsonb_typeof(p_filters->v_key)<>'string'
      and not (v_key='authorAge' and jsonb_typeof(p_filters->v_key)='object')
      and not (v_key in ('category','periodStart','periodEnd') and p_filters->v_key='null'::jsonb) then
      raise exception 'invalid_search_input' using errcode='22023';
    end if;
  end loop;
  if char_length(coalesce(p_filters->>'query',''))>300 then
    raise exception 'invalid_search_query' using errcode='22023';
  end if;
  v_query:=private.search_v2_text(p_filters->>'query');
  v_category:=p_filters->>'category'; v_cost:=coalesce(p_filters->>'cost','all');
  v_availability:=coalesce(p_filters->>'availability','all');
  if jsonb_typeof(p_filters->'authorAge')='object' then
    if not ((p_filters->'authorAge')?&array['min','max'])
      or (p_filters->'authorAge')-array['min','max']<>'{}'::jsonb
      or jsonb_typeof(p_filters->'authorAge'->'min')<>'number'
      or jsonb_typeof(p_filters->'authorAge'->'max')<>'number' then
      raise exception 'invalid_search_age_range' using errcode='22023';
    end if;
    -- JSONB의 정확한 숫자 비교로 범위를 먼저 검사한다. 거대한 숫자를 integer로 변환하지 않는다.
    if p_filters->'authorAge'->'min'<'19'::jsonb or p_filters->'authorAge'->'min'>'99'::jsonb
      or p_filters->'authorAge'->'max'<'19'::jsonb or p_filters->'authorAge'->'max'>'99'::jsonb then
      raise exception 'invalid_search_age_range' using errcode='22023';
    end if;
    v_min_numeric:=(p_filters->'authorAge'->>'min')::numeric;
    v_max_numeric:=(p_filters->'authorAge'->>'max')::numeric;
    if v_min_numeric<>trunc(v_min_numeric) or v_max_numeric<>trunc(v_max_numeric)
      or v_min_numeric>v_max_numeric then
      raise exception 'invalid_search_age_range' using errcode='22023';
    end if;
    v_age_min:=v_min_numeric::integer; v_age_max:=v_max_numeric::integer; v_age:='range';
  else
    v_age:=coalesce(p_filters->>'authorAge','all');
    if v_age<>'all' then
      raise exception 'invalid_search_filter' using errcode='22023';
    end if;
  end if;
  v_sort:=coalesce(p_filters->>'sort','created_desc');
  if (v_category is not null and v_category not in ('지금이당','전시','축제','팝업','공연','영화','맛집','카페','쇼핑','여행','운동','산책','게임','반려동물','스터디','기타'))
    or v_cost not in ('all','free','paid') or v_availability not in ('all','recruiting')
    or v_age not in ('all','range') or v_sort not in ('created_desc','starts_asc') then
    raise exception 'invalid_search_filter' using errcode='22023';
  end if;
  if not coalesce(v_member,false) and v_age<>'all' then
    raise exception 'login_required' using errcode='28000';
  end if;
  if ((p_filters->>'periodStart') is null)<>((p_filters->>'periodEnd') is null) then
    raise exception 'invalid_search_period' using errcode='22023';
  end if;
  if p_filters->>'periodStart' is not null then
    if not coalesce(v_member,false) then raise exception 'login_required' using errcode='28000'; end if;
    v_start:=private.search_v2_timestamp(p_filters->>'periodStart');
    v_end:=private.search_v2_timestamp(p_filters->>'periodEnd');
    if v_start>=v_end then raise exception 'invalid_search_period' using errcode='22023'; end if;
  end if;
  if p_cursor is not null and p_cursor<>'null'::jsonb then
    if jsonb_typeof(p_cursor)<>'object' or not (p_cursor?&array['sortAt','id'])
      or p_cursor-array['sortAt','id']<>'{}'::jsonb
      or jsonb_typeof(p_cursor->'sortAt')<>'string' or jsonb_typeof(p_cursor->'id')<>'string'
      or (p_cursor->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_search_cursor' using errcode='22023';
    end if;
    v_cursor_at:=private.search_v2_timestamp(p_cursor->>'sortAt');
    v_cursor_id:=(p_cursor->>'id')::uuid;
  end if;
  v_can_start_activity:=private.can_start_naver_activity();

  with source as materialized (
    select p.id,p.title,p.public_area,p.starts_at,p.ends_at,p.created_at,p.author_id,p.cost_type,p.amount,
      p.partner_gender,pr.real_name,pr.birth_date,
      case when ap.status='confirmed' then 'confirmed'
        when ap.status in ('completed','cancelled','disputed','no_show') then 'closed'
        when p.status='closed' then 'closed'
        when p.status='expired' or p.recruitment_ends_at<=now() or p.starts_at<=now() then 'expired'
        else 'recruiting' end as display_state,
      case when v_sort='created_desc' then p.created_at else p.starts_at end as sort_at
    from public.posts p join public.profiles pr on pr.id=p.author_id
    left join public.appointments ap on ap.post_id=p.id
    left join private.post_search_locations l on l.post_id=p.id
    left join private.events linked_event on linked_event.id=p.source_event_id
    where p.status<>'deleted'
      and (v_category is null or p.category=v_category)
      and (p_region is null or private.post_search_region(p.public_area)=p_region)
      and (v_cost='all' or (v_cost='free' and p.cost_type='free') or (v_cost='paid' and p.cost_type in ('paid_request','paid_offer')))
      and (v_start is null or (p.starts_at<v_end and p.ends_at>v_start))
      and (v_age='all' or (v_age='range' and public.korean_age(pr.birth_date) between v_age_min and v_age_max))
      and (v_query='' or strpos(private.search_v2_text(p.title),v_query)>0
        or strpos(private.search_v2_text(l.registered_place_name),v_query)>0
        or strpos(private.search_v2_text(l.registered_address),v_query)>0
        or strpos(private.search_v2_text(linked_event.title),v_query)>0)
  ), candidates as materialized (
    select s.* from source s
    where (v_availability='all' or s.display_state='recruiting')
      and (v_cursor_at is null or
        (v_sort='created_desc' and (s.sort_at<v_cursor_at or (s.sort_at=v_cursor_at and s.id>v_cursor_id))) or
        (v_sort='starts_asc' and (s.sort_at>v_cursor_at or (s.sort_at=v_cursor_at and s.id>v_cursor_id))))
    order by case when v_sort='created_desc' then s.sort_at end desc,
      case when v_sort='starts_asc' then s.sort_at end asc,s.id asc limit p_limit+1
  ), page as materialized (
    select c.*,row_number() over(order by case when v_sort='created_desc' then c.sort_at end desc,
      case when v_sort='starts_asc' then c.sort_at end asc,c.id asc) as page_position
    from candidates c order by case when v_sort='created_desc' then c.sort_at end desc,
      case when v_sort='starts_asc' then c.sort_at end asc,c.id asc limit p_limit
  )
  select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
    'id',s.id,'title',s.title,
    'authorDisplayName',case when coalesce(v_member,false) then public.mask_real_name(s.real_name)
      else null end,
    'publicArea',s.public_area,
    'startsAt',to_char(s.starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'endsAt',to_char(s.ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'cost',private.search_v2_cost(s.cost_type,s.amount),'state',s.display_state,
    'canApply',coalesce(coalesce(v_member,false) and v_can_start_activity and s.display_state='recruiting' and s.cost_type='free'
      and s.author_id<>v_uid and exists(select 1 from public.profiles me where me.id=v_uid
        and (s.partner_gender='any' or me.gender=s.partner_gender))
      and not exists(select 1 from public.join_requests r where r.post_id=s.id and r.requester_id=v_uid
        and r.status in ('pending','declined')),false)
    ) order by s.page_position) from page s),'[]'::jsonb),
    'nextCursor',case when (select count(*) from candidates)>p_limit then
      (select jsonb_build_object('sortAt',to_char(s.sort_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'id',s.id)
       from page s order by s.page_position desc limit 1) else null end) into v_result;
  return v_result;
end; $$;

revoke all on function public.search_public_posts_v2(text,text,jsonb,jsonb,integer) from public,anon,authenticated,service_role;
grant execute on function public.search_public_posts_v2(text,text,jsonb,jsonb,integer) to anon,authenticated,service_role;
comment on function public.search_public_posts_v2(text,text,jsonb,jsonb,integer) is
 '2026-10-05 계약: 공식17시도·16분류·만19~99범위/전체상한없음·기본10. 익명 이름null·나이/일정전체. 등록주소/연결행사명 일치와 반환권한을 분리.';
-- 상세 조회도 익명 이름을 별칭으로 대체하지 않는다.
create or replace function public.get_service_post(p_post_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=case when auth.role()='authenticated' and auth.uid() is not null
  and (not(auth.jwt()?'is_anonymous') or auth.jwt()->'is_anonymous'='false'::jsonb) then auth.uid() else null end; p public.posts; v_details jsonb; v_names jsonb; v_result jsonb; v_pair boolean;
begin
  select * into p from public.posts where id=p_post_id and status<>'deleted';
  if not found then raise exception 'post_unavailable' using errcode='P0002'; end if;
  v_pair:=v_uid is not null and exists(select 1 from public.appointments ap join public.join_requests r on r.id=ap.join_request_id
    where ap.post_id=p.id and ap.status in('confirmed','completed') and v_uid in(p.author_id,r.requester_id));
  select jsonb_build_object('postId',p.id,'title',p.title,'description',p.description,'category',p.category,
    'startsAt',p.starts_at,'endsAt',p.ends_at,'recruitmentEndsAt',p.recruitment_ends_at,'updatedAt',p.updated_at,
    'publicArea',p.public_area,'status',p.status,'costType',p.cost_type,'amount',p.amount,
    'preferenceNote',p.preference_note,'tags',to_jsonb(p.tags),
    'eventId',p.source_event_id,'linkedEvent',private.project_post_linked_event(p.source_event_id),
    'authorDisplayName',case when v_uid is null then null
      when v_pair or p.author_id=v_uid then pr.real_name else public.mask_real_name(pr.real_name) end)
    into v_result from public.profiles pr where pr.id=p.author_id;
  if v_uid is not null and (p.author_id=v_uid or v_pair) then
    select jsonb_build_object('registeredPlaceName',l.registered_place_name,'registeredAddress',l.registered_address,
      'meetingDetail',d.exact_location) into v_details from private.post_search_locations l
      join public.post_private_details d on d.post_id=l.post_id where l.post_id=p.id;
    select jsonb_agg(jsonb_build_object('userId',pr.id,'realName',pr.real_name) order by pr.id) into v_names
      from public.profiles pr where pr.id=p.author_id or (v_pair and pr.id in(
        select r.requester_id from public.appointments ap join public.join_requests r on r.id=ap.join_request_id
          where ap.post_id=p.id and ap.status in('confirmed','completed')));
    v_result:=v_result||jsonb_build_object('privateDetails',v_details,'participantNames',v_names);
  end if;
  return v_result;
end; $$;

commit;
