-- 최신 사용자 검색 정책. 기존 SQL 이력/공고/등록 장소 원본은 수정하지 않는다.
begin;
create function private.search_v2_text(p_text text)
returns text language sql immutable set search_path='' as $$
  select lower(btrim(regexp_replace(coalesce(p_text,''), U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g')));
$$;
create function private.search_v2_timestamp(p_text text)
returns timestamptz language plpgsql immutable set search_path='' as $$
declare v_result timestamptz;
begin
  if p_text is null or p_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
    or left(p_text,4)='0000' then
    raise exception 'invalid_search_timestamp' using errcode='22023';
  end if;
  begin v_result:=p_text::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'invalid_search_timestamp' using errcode='22023';
  end;
  if not isfinite(v_result) then raise exception 'invalid_search_timestamp' using errcode='22023'; end if;
  return v_result;
end; $$;
create function private.search_v2_cost(p_kind text,p_amount bigint)
returns jsonb language plpgsql immutable set search_path='' as $$
begin
  if p_kind is null and p_amount is null then return null; end if;
  if p_kind='free' and p_amount=0 then return jsonb_build_object('kind','free'); end if;
  if p_kind in ('paid_request','paid_offer') and p_amount between 1 and 9007199254740991 then
    return jsonb_build_object('kind',p_kind,'amount',p_amount,'direction',
      case when p_kind='paid_request' then 'author_to_applicant' else 'applicant_to_author' end);
  end if;
  raise exception 'invalid_post_cost' using errcode='P0001';
end; $$;
revoke all on function private.search_v2_text(text),private.search_v2_timestamp(text),private.search_v2_cost(text,bigint)
  from public,anon,authenticated,service_role;

create function public.search_public_posts_v2(p_filters jsonb,p_cursor jsonb,p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_uid uuid:=auth.uid();
  v_member boolean:=auth.role()='authenticated' and auth.uid() is not null;
  v_query text; v_category text; v_cost text; v_availability text; v_age text; v_sort text;
  v_start timestamptz; v_end timestamptz; v_cursor_at timestamptz; v_cursor_id uuid;
  v_key text; v_result jsonb;
begin
  if p_filters is null or jsonb_typeof(p_filters)<>'object' or p_limit is null or p_limit not between 1 and 50
    or p_filters-array['query','category','cost','availability','periodStart','periodEnd','authorAge','sort']<>'{}'::jsonb then
    raise exception 'invalid_search_input' using errcode='22023';
  end if;
  for v_key in select jsonb_object_keys(p_filters) loop
    if jsonb_typeof(p_filters->v_key)<>'string' and not (v_key in ('category','periodStart','periodEnd') and p_filters->v_key='null'::jsonb) then
      raise exception 'invalid_search_input' using errcode='22023';
    end if;
  end loop;
  if char_length(coalesce(p_filters->>'query',''))>300 then
    raise exception 'invalid_search_query' using errcode='22023';
  end if;
  v_query:=private.search_v2_text(p_filters->>'query');
  v_category:=p_filters->>'category'; v_cost:=coalesce(p_filters->>'cost','all');
  v_availability:=coalesce(p_filters->>'availability','all'); v_age:=coalesce(p_filters->>'authorAge','all');
  v_sort:=coalesce(p_filters->>'sort','created_desc');
  if (v_category is not null and v_category not in ('지금','전시','축제','식사','운동','여행','클래스','산책','스터디','공연','쇼핑','기타'))
    or v_cost not in ('all','free','paid') or v_availability not in ('all','recruiting')
    or v_age not in ('all','20s','30s','40plus') or v_sort not in ('created_desc','starts_asc') then
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
      and (v_age='all' or (v_age='20s' and public.korean_age(pr.birth_date) between 20 and 29)
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
    'canApply',coalesce(coalesce(v_member,false) and s.display_state='recruiting' and s.cost_type='free'
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
 'Public dong-level cards; anonymous period allowed, detailed age requires member; created DESC or starts ASC plus UUID ASC keyset. Existing RPCs are preserved.';
commit;
