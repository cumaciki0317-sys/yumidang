-- 민규: 본인 콘텐츠 숨김. 필수 약속/신고/안내 관리는 유지.
begin;
create function private.member_content_hidden(p_type text,p_id uuid)returns boolean
language sql stable security definer set search_path=''as $$
 select case when auth.role()='authenticated'and auth.uid()is not null and(not(auth.jwt()?'is_anonymous')or auth.jwt()->'is_anonymous'='false'::jsonb)
 then exists(select 1 from private.member_hidden_targets h join private.member_episodes ep on ep.identity_id=h.identity_id
 where ep.profile_id=auth.uid()and ep.ended_at is null and h.target_type=p_type and h.target_id=p_id)else false end;
$$;
create function private.conversation_content_hidden(p_id uuid)returns boolean
language sql stable security definer set search_path=''as $$
 select exists(select 1 from public.appointments a where a.join_request_id=p_id and private.member_content_hidden('appointment',a.id));
$$;
revoke all on function private.member_content_hidden(text,uuid),private.conversation_content_hidden(uuid)from public,anon,authenticated,service_role;
create or replace function private.search_public_posts_v2_before_member_retirement(p_contract_version text,p_region text,p_filters jsonb,p_cursor jsonb,p_limit integer default 10)
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
    where p.status<>'deleted' and not private.member_content_hidden('post',p.id)
      and (not coalesce(v_member,false) or not private.members_blocked(v_uid,p.author_id))
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
create or replace function public.list_public_events(p_filters jsonb, p_cursor jsonb, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_week_start timestamptz; v_week_end timestamptz;
  v_mode text; v_ongoing_only boolean := false; v_keyword text := ''; v_region text; v_category text;
  v_period_start timestamptz; v_period_end timestamptz; v_period_start_day date; v_period_end_day date;
  v_cursor_rank integer; v_cursor_key numeric; v_cursor_id uuid;
  v_result jsonb;
begin
  if p_filters is null or jsonb_typeof(p_filters) <> 'object' or p_limit is null or p_limit not between 1 and 50
    or exists (select 1 from jsonb_object_keys(p_filters) k where k not in ('mode','period','ongoingOnly','query','region','category')) then
    raise exception 'invalid_event_query' using errcode = '22023';
  end if;
  v_mode := p_filters->>'mode';
  if jsonb_typeof(p_filters->'mode') is distinct from 'string' or v_mode not in ('overlapping','new_this_week','post_selection') then
    raise exception 'invalid_event_mode' using errcode = '22023';
  end if;
  if p_filters ? 'ongoingOnly' then
    if jsonb_typeof(p_filters->'ongoingOnly') <> 'boolean' then raise exception 'invalid_event_filter' using errcode = '22023'; end if;
    v_ongoing_only := (p_filters->>'ongoingOnly')::boolean;
  end if;
  if p_filters ? 'query' then
    if jsonb_typeof(p_filters->'query') <> 'string' then raise exception 'invalid_event_filter' using errcode = '22023'; end if;
    v_keyword := private.event_keyword(p_filters->>'query');
  end if;
  if p_filters ? 'region' then
    if jsonb_typeof(p_filters->'region') <> 'string' or btrim(p_filters->>'region') = '' then
      raise exception 'invalid_event_filter' using errcode = '22023';
    end if;
    v_region := p_filters->>'region';
  end if;
  if p_filters ? 'category' then
    if jsonb_typeof(p_filters->'category') <> 'string' or btrim(p_filters->>'category') = '' then
      raise exception 'invalid_event_filter' using errcode = '22023';
    end if;
    v_category := p_filters->>'category';
  end if;
  if p_filters ? 'period' then
    if jsonb_typeof(p_filters->'period') <> 'object'
      or (select array_agg(k order by k) from jsonb_object_keys(p_filters->'period') k) is distinct from array['end','start'] then
      raise exception 'invalid_query_period' using errcode = '22023';
    end if;
    v_period_start_day := private.event_date(p_filters->'period'->'start');
    v_period_end_day := private.event_date(p_filters->'period'->'end');
    if v_period_end_day < v_period_start_day then raise exception 'invalid_query_period' using errcode = '22023'; end if;
    v_period_start := private.event_seoul_day_start(v_period_start_day);
    v_period_end := private.event_seoul_day_start(v_period_end_day + 1);
  end if;
  if p_cursor is not null and jsonb_typeof(p_cursor) <> 'null' then
    if jsonb_typeof(p_cursor) <> 'object'
      or (select array_agg(k order by k) from jsonb_object_keys(p_cursor) k) is distinct from array['id','key','rank']
      or jsonb_typeof(p_cursor->'rank') <> 'number' or p_cursor->>'rank' not in ('0','1','2')
      or jsonb_typeof(p_cursor->'key') <> 'string' or p_cursor->>'key' !~ '^-?[0-9]{1,12}(\.[0-9]{1,6})?$'
      or jsonb_typeof(p_cursor->'id') <> 'string'
      or p_cursor->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_event_cursor' using errcode = '22023';
    end if;
    v_cursor_rank := (p_cursor->>'rank')::integer;
    v_cursor_key := (p_cursor->>'key')::numeric;
    v_cursor_id := (p_cursor->>'id')::uuid;
  end if;
  -- 한국 월요일 00:00 ~ 다음 월요일 00:00.
  v_week_start := private.event_seoul_day_start(v_today - (extract(isodow from v_today)::integer - 1));
  v_week_end := v_week_start + interval '7 days';

  with base as (
    select e.*,
      case when e.precision = 'date' then private.event_seoul_day_start(e.starts_on) else e.starts_at end as iv_start,
      case when e.precision = 'date' then private.event_seoul_day_start(e.ends_on + 1) else e.ends_at end as iv_end
    from private.events e
    -- 신규 reader의 provider 지원 범위만 공개한다. legacy는 원본/v1 조회에 보존한다.
    where e.source_status <> 'cancelled' and not private.member_content_hidden('event',e.id) and e.provider ~ '^[a-z0-9][a-z0-9-]{0,31}$'
  ), staged as (
    select b.*, case when v_now < b.iv_start then 1 when v_now >= b.iv_end then 2 else 0 end as grp
    from base b
  ), filtered as (
    select s.*,
      case s.grp when 0 then -extract(epoch from s.iv_start) when 1 then extract(epoch from s.iv_start)
        else -extract(epoch from s.iv_end) end as sort_key
    from staged s
    where (v_period_start is null or (s.iv_start < v_period_end and s.iv_end > v_period_start))
      and (not v_ongoing_only or s.grp = 0)
      and (v_mode <> 'post_selection' or s.grp <> 2)
      and (v_mode <> 'new_this_week' or (s.iv_start >= v_week_start and s.iv_start < v_week_end and s.grp <> 2))
      and (v_region is null or s.region = v_region)
      and (v_category is null or s.category = v_category)
      and (v_keyword = '' or strpos(private.event_keyword(s.title), v_keyword) > 0
        or (s.place_name is not null and strpos(private.event_keyword(s.place_name), v_keyword) > 0)
        or (s.public_address is not null and strpos(private.event_keyword(s.public_address), v_keyword) > 0))
  ), paged as (
    select f.* from filtered f
    where v_cursor_rank is null or (f.grp, f.sort_key, f.id) > (v_cursor_rank, v_cursor_key, v_cursor_id)
    order by f.grp, f.sort_key, f.id
    limit p_limit + 1
  ), numbered as (
    select p.*, row_number() over (order by p.grp, p.sort_key, p.id) as n from paged p
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', n.id, 'provider', n.provider, 'sourceId', n.source_id, 'sourceStatus', n.source_status,
        'title', n.title, 'category', n.category, 'region', n.region, 'placeName', n.place_name,
        'publicAddress', n.public_address, 'admission', n.admission, 'sourceUrl', n.source_url,
        'collectedAt', to_char(n.collected_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'state', case n.grp when 0 then 'ongoing' when 1 then 'upcoming' else 'ended' end,
        'precision', n.precision)
        || case when n.precision = 'date'
          then jsonb_build_object('startsOn', to_char(n.starts_on, 'YYYY-MM-DD'), 'endsOn', to_char(n.ends_on, 'YYYY-MM-DD'))
          else jsonb_build_object('startsAt', to_char(n.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'endsAt', to_char(n.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end
        order by n.n) from numbered n where n.n <= p_limit), '[]'::jsonb),
    'nextCursor', (select jsonb_build_object('rank', n.grp, 'key', n.sort_key::text, 'id', n.id)
      from numbered n where n.n = p_limit and exists (select 1 from numbered m where m.n = p_limit + 1)))
  into v_result;
  return v_result;
end; $$;
create or replace function public.list_conversation_messages(p_request_id uuid,p_limit integer,p_before uuid default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); v_before public.chat_messages; v_result jsonb;
begin
  perform private.require_conversation_retention(p_request_id);
  if private.request_role(p_request_id) is null then raise exception 'request_unavailable' using errcode='P0002'; end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_input' using errcode='22023'; end if;
  if p_before is not null then
    select * into v_before from public.chat_messages where id=p_before and join_request_id=p_request_id and private.conversation_message_readable(id) and not private.member_content_hidden('chat',id);
    if not found then raise exception 'cursor_unavailable' using errcode='P0002'; end if;
  end if;
  with candidates as materialized(select * from public.chat_messages where join_request_id=p_request_id and private.conversation_message_readable(id) and not private.member_content_hidden('chat',id)
    and(p_before is null or (created_at,id)<(v_before.created_at,v_before.id)) order by created_at desc,id desc limit p_limit+1),
    page as(select * from candidates order by created_at desc,id desc limit p_limit)
  select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('messageId',id,'senderId',sender_id,
    'content',content,'createdAt',created_at) order by created_at desc,id desc) from page),'[]'::jsonb),
    'nextCursor',case when (select count(*) from candidates)>p_limit then(select id from page order by created_at,id limit 1) else null end)
    into v_result;
  return v_result;
end;
$$;
CREATE OR REPLACE FUNCTION public.list_conversations()
 RETURNS TABLE(request_id uuid, my_role text, request_status text, post_id uuid, post_title text, post_starts_at timestamp with time zone, counterpart_masked_name text, counterpart_avatar_url text, last_message text, last_message_at timestamp with time zone, last_activity_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select q.request_id,q.my_role,q.request_status,q.post_id,q.post_title,q.post_starts_at,case when private.request_other_retired(q.request_id) then '탈퇴한 사용자입니다.' else q.counterpart_masked_name end,case when private.request_other_retired(q.request_id) then null else q.counterpart_avatar_url end,m.content,m.created_at,greatest(m.created_at,g.last_activity_at) from private.list_conversations_before_member_retirement() q left join lateral(select z.content,z.created_at from public.chat_messages z where z.join_request_id=q.request_id and private.conversation_message_readable(z.id) and not private.member_content_hidden('chat',z.id)order by z.created_at desc,z.id desc limit 1)m on true left join lateral(select v.last_activity_at from private.conversation_retention_generations v where v.request_id=q.request_id order by v.generation desc limit 1)g on true where private.closed_conversation_retention_open(q.request_id) order by greatest(m.created_at,g.last_activity_at)desc nulls last,q.request_id;
end;
$function$;
do $wrap$declare spec record;sig regprocedure;args text;ret text;returns_set boolean;call text;newname text;body text;grants text[];role_name text;begin
 for spec in select *from(values
 ('get_service_post','uuid','post'),('get_public_profile','uuid','member'),
 ('get_public_profile_reviews','uuid,integer,uuid','member'),('get_visible_review_summary','uuid','member'),
 ('get_conversation','uuid','chat'),('list_conversation_messages','uuid,integer,uuid','chat'),
 ('list_conversations','','chat-list'))v(name,types,target)loop
 sig:=format('public.%I(%s)',spec.name,spec.types)::regprocedure;
 select pg_get_function_arguments(sig),pg_get_function_result(sig),proretset into args,ret,returns_set from pg_proc where oid=sig;
 grants:=array[]::text[];foreach role_name in array array['anon','authenticated','service_role']loop
 if has_function_privilege(role_name,sig,'execute')then grants:=array_append(grants,role_name);end if;end loop;
 newname:=spec.name||'_before_content_hidden';
 execute format('alter function %s set schema private',sig);
 execute format('alter function private.%I(%s) rename to %I',spec.name,spec.types,newname);
 execute format('revoke all on function private.%I(%s)from public,anon,authenticated,service_role',newname,spec.types);
 call:=case when spec.types=''then''when spec.types='uuid'then'$1'else'$1,$2,$3'end;
 if spec.target='chat-list'then
 body:=format('begin return query select c.*from private.%I()c where not private.conversation_content_hidden(c.request_id);end;',newname);
 else
 body:=format('begin if %s then raise exception ''content_unavailable''using errcode=''PT404'';end if;%s private.%I(%s);end;',
 case when spec.target='chat'then'private.conversation_content_hidden($1)'else format('private.member_content_hidden(%L,$1)',spec.target)end,
 case when returns_set then'return query select *from'else'return'end,newname,call);
 end if;
 execute format('create function public.%I(%s)returns %s language plpgsql volatile security definer set search_path=''''as %L',spec.name,args,ret,body);
 execute format('revoke all on function public.%I(%s)from public,anon,authenticated,service_role',spec.name,spec.types);
 foreach role_name in array grants loop execute format('grant execute on function public.%I(%s)to %I',spec.name,spec.types,role_name);end loop;
 end loop;
end;$wrap$;
-- 본인 공고 관리는 콘텐츠 필터와 별도로 유지한다.
do $$declare definition text;begin
 select pg_get_functiondef('public.list_my_service_posts(integer,uuid)'::regprocedure)into definition;
 if strpos(definition,'public.get_service_post(id)')=0 then raise exception 'own_post_source_mismatch';end if;
 execute replace(definition,'public.get_service_post(id)','private.get_service_post_before_content_hidden(id)');
end;$$;
-- 숨긴 메시지의 읽음 식별자도 반환하지 않는다.
do $$declare definition text;begin
 select pg_get_functiondef('public.mark_conversation_read(uuid,uuid)'::regprocedure)into definition;
 if strpos(definition,'and private.conversation_message_readable(id);')=0 then raise exception 'mark_read_source_mismatch';end if;
 execute replace(definition,'and private.conversation_message_readable(id);','and private.conversation_message_readable(id)and not private.member_content_hidden(''chat'',id);');
 select pg_get_functiondef('private.conversation_read_dto(uuid)'::regprocedure)into definition;
 if strpos(definition,'and private.conversation_message_readable(marker.id)')=0 then raise exception 'read_marker_source_mismatch';end if;
 execute replace(definition,'and private.conversation_message_readable(marker.id)','and private.conversation_message_readable(marker.id)and not private.member_content_hidden(''chat'',marker.id)');
end;$$;
create or replace function private.project_post_linked_event(p_event_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',e.id,'provider',e.provider,'sourceId',e.source_id,'sourceStatus',e.source_status,
    'title',e.title,'category',e.category,'region',e.region,'placeName',e.place_name,'publicAddress',e.public_address,
    'admission',e.admission,'sourceUrl',e.source_url,
    'collectedAt',to_char(e.collected_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'state',case when now() < case when e.precision='date' then private.event_seoul_day_start(e.starts_on) else e.starts_at end then 'upcoming'
      when now() >= case when e.precision='date' then private.event_seoul_day_start(e.ends_on+1) else e.ends_at end then 'ended' else 'ongoing' end,
    'precision',e.precision)
    || case when e.precision='date' then jsonb_build_object('startsOn',to_char(e.starts_on,'YYYY-MM-DD'),'endsOn',to_char(e.ends_on,'YYYY-MM-DD'))
      else jsonb_build_object('startsAt',to_char(e.starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'endsAt',to_char(e.ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end
  from private.events e where e.id=p_event_id and not private.member_content_hidden('event',e.id);
$$;
-- 원래 JWT로 테이블을 직접 조회해 콘텐츠 필터를 우회하지 않는다.
grant execute on function private.member_content_hidden(text,uuid),private.conversation_content_hidden(uuid)to authenticated;
create policy member_hidden_post_select on public.posts as restrictive for select to authenticated using(not private.member_content_hidden('post',id));
create policy member_hidden_profile_select on public.profiles as restrictive for select to authenticated using(id=auth.uid()or not private.member_content_hidden('member',id));
create policy member_hidden_message_select on public.chat_messages as restrictive for select to authenticated using(not private.member_content_hidden('chat',id)and not private.conversation_content_hidden(join_request_id));
do $$declare definition text;begin
 select pg_get_functiondef('private.conversation_read_dto(uuid)'::regprocedure)into definition;
 if strpos(definition,'and private.conversation_message_readable(m.id)')=0 then raise exception 'read_dto_source_mismatch';end if;
 execute replace(definition,'and private.conversation_message_readable(m.id)','and private.conversation_message_readable(m.id)and not private.member_content_hidden(''chat'',m.id)');
end;$$;
commit;
