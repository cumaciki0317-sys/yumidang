-- 작성자 만 나이 숫자 범위만 확장한다. 기존 검색 SQL/장소 원본/행사 연결은 보존한다.
-- authorAge 생략 또는 'all': 상한 없음. 회원 {min,max}: 19~99의 수학적 정수, 양끝 포함.
-- 20s/30s/40plus는 종현 검색 계약 전환까지 과도기 호환으로 유지한다.
-- canApply도 실제 신청과 같은 네이버 세션/자격/사진 검사를 사용한다. 다른 카드 조건은 보존한다.
begin;
create function private.can_start_naver_activity()
returns boolean language plpgsql stable security definer set search_path='' as $$
begin
  perform private.assert_naver_activity_allowed();
  return true;
exception when sqlstate '28000' or sqlstate '42501' or sqlstate '22023' then
  -- 기존 인증/사진 검사의 명시적 거절만 false다. 권한·저장소 등 다른 DB 오류는 숨기지 않는다.
  if (sqlstate='28000' and sqlerrm in ('login_required','naver_session_required'))
    or (sqlstate='42501' and sqlerrm in ('naver_signup_required','profile_image_not_owned'))
    or (sqlstate='22023' and sqlerrm in ('invalid_profile_image_path','profile_image_missing','invalid_profile_image_object')) then
    return false;
  end if;
  raise;
end; $$;
revoke all on function private.can_start_naver_activity() from public,anon,authenticated,service_role;

create or replace function public.search_public_posts_v2(p_filters jsonb,p_cursor jsonb,p_limit integer default 20)
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
    if v_age not in ('all','20s','30s','40plus') then
      raise exception 'invalid_search_filter' using errcode='22023';
    end if;
  end if;
  v_sort:=coalesce(p_filters->>'sort','created_desc');
  if (v_category is not null and v_category not in ('지금','전시','축제','식사','운동','여행','클래스','산책','스터디','공연','쇼핑','기타'))
    or v_cost not in ('all','free','paid') or v_availability not in ('all','recruiting')
    or v_age not in ('all','range','20s','30s','40plus') or v_sort not in ('created_desc','starts_asc') then
    raise exception 'invalid_search_filter' using errcode='22023';
  end if;
  if not coalesce(v_member,false) and v_age<>'all' then
    raise exception 'login_required' using errcode='28000';
  end if;
  if ((p_filters->>'periodStart') is null)<>((p_filters->>'periodEnd') is null) then
    raise exception 'invalid_search_period' using errcode='22023';
  end if;
  if p_filters->>'periodStart' is not null then
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
    where p.status<>'deleted'
      and (v_category is null or p.category=v_category)
      and (v_cost='all' or (v_cost='free' and p.cost_type='free') or (v_cost='paid' and p.cost_type in ('paid_request','paid_offer')))
      and (v_start is null or (p.starts_at<v_end and p.ends_at>v_start))
      and (v_age='all' or (v_age='range' and public.korean_age(pr.birth_date) between v_age_min and v_age_max)
        or (v_age='20s' and public.korean_age(pr.birth_date) between 20 and 29)
        or (v_age='30s' and public.korean_age(pr.birth_date) between 30 and 39)
        or (v_age='40plus' and public.korean_age(pr.birth_date)>=40))
      and (v_query='' or strpos(private.search_v2_text(p.title),v_query)>0
        or strpos(private.search_v2_text(l.registered_place_name),v_query)>0
        or strpos(private.search_v2_text(l.registered_address),v_query)>0)
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
      else '동행 '||(('x'||left(replace(s.id::text,'-',''),8))::bit(32)::bigint)::text end,
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
revoke all on function public.search_public_posts_v2(jsonb,jsonb,integer) from public,anon,authenticated,service_role;
grant execute on function public.search_public_posts_v2(jsonb,jsonb,integer) to anon,authenticated,service_role;
comment on function public.search_public_posts_v2(jsonb,jsonb,integer) is
 '작성자 만 나이 숫자 범위 19~99 포함, 전체는 상한 없음. 비회원은 나이 전체만. 기존 연령대는 과도기 호환이며 정렬/기간/keyset/공개 카드 권한은 보존한다.';
commit;
