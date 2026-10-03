-- 민규: 공고의 선택 행사 UUID만 저장하고 조회 때 canonical 최신 정보를 투영한다.
-- 동행 입력/일정·기존 이름/정확장소 권한·검색9필드·숫자범위·신청가능 게이트를 보존한다.
-- 선행 RPC의 본문을 좁게 확장하며 기존 생성 입력 이력은 다시 쓰지 않는다.
begin;
alter table public.posts add column source_event_id uuid
  references private.source_events(id) on delete restrict;
create index posts_source_event_idx on public.posts(source_event_id) where source_event_id is not null;
comment on column public.posts.source_event_id is '연결 행사 UUID. 표시 정보는 canonical 최신 조회, 동행 일정 자동 변경 없음.';

create function private.parse_post_event_id(p_value jsonb)
returns uuid language plpgsql immutable set search_path='' as $$
begin
  if p_value is null or p_value='null'::jsonb then return null; end if;
  if jsonb_typeof(p_value)<>'string' or (p_value#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_event_id' using errcode='22023';
  end if;
  return (p_value#>>'{}')::uuid;
end; $$;

create function private.assert_post_event_selectable(p_event_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare e private.source_events; v_now timestamptz;
begin
  if p_event_id is null then return; end if;
  -- 변경/삭제와 경합하는 새 선택만 잠근다. 기존 연결의 취소/종료 조회는 막지 않는다.
  select * into e from private.source_events where id=p_event_id for share;
  if not found then raise exception 'event_unavailable' using errcode='22023'; end if;
  v_now:=clock_timestamp();
  if not coalesce(private.valid_source_event_v2(e.record),false)
    or e.provider !~ '^[a-z0-9][a-z0-9-]{0,31}$' or (e.record->>'sourceStatus') is distinct from 'active'
    or coalesce(e.record->>'precision','') not in('date','instant')
    or (e.record->>'precision'='date' and private.event_calendar_date_v1(e.record->>'endsOn')<(v_now at time zone 'Asia/Seoul')::date)
    or (e.record->>'precision'='instant' and private.event_instant_v1(e.record->>'endsAt')<=v_now) then
    raise exception 'event_unavailable' using errcode='22023';
  end if;
end; $$;

create function private.project_post_linked_event(p_event_id uuid)
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
  from private.events e where e.id=p_event_id;
$$;
revoke all on function private.parse_post_event_id(jsonb),private.assert_post_event_selectable(uuid),private.project_post_linked_event(uuid)
  from public,anon,authenticated,service_role;

create or replace function public.create_service_post(p_post_id uuid,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid := private.require_service_profile(); v_post public.posts;
  v_key text; v_tags text[]; v_input jsonb; v_prior jsonb; v_event_id uuid;
begin
  if p_post_id is null or p_input is null or jsonb_typeof(p_input)<>'object'
    or not p_input ?& array['title','description','category','startsAt','endsAt','recruitmentEndsAt','publicArea',
      'registeredPlaceName','registeredAddress','meetingDetail','preferenceNote','tags','costType','amount']
    or p_input - array['title','description','category','startsAt','endsAt','recruitmentEndsAt','publicArea',
      'registeredPlaceName','registeredAddress','meetingDetail','preferenceNote','tags','costType','amount','eventId'] <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode='22023';
  end if;
  foreach v_key in array array['title','description','category','startsAt','endsAt','recruitmentEndsAt','publicArea','registeredAddress','meetingDetail','costType'] loop
    if jsonb_typeof(p_input->v_key) is distinct from 'string' then raise exception 'invalid_input' using errcode='22023'; end if;
  end loop;
  foreach v_key in array array['registeredPlaceName','preferenceNote'] loop
    if jsonb_typeof(p_input->v_key) not in ('string','null') then raise exception 'invalid_input' using errcode='22023'; end if;
  end loop;
  if p_input->>'costType'<>'free' then raise exception 'bank_integration_unavailable' using errcode='PT503'; end if;
  if p_input->'amount'<>'0'::jsonb or jsonb_typeof(p_input->'tags')<>'array'
    or jsonb_array_length(p_input->'tags')>5 then raise exception 'invalid_input' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_input->'tags') t where jsonb_typeof(t)<>'string') then
    raise exception 'invalid_input' using errcode='22023';
  end if;
  if char_length(btrim(p_input->>'registeredAddress')) not between 1 and 300
    or char_length(coalesce(p_input->>'registeredPlaceName',''))>200
    or not isfinite((p_input->>'startsAt')::timestamptz)
    or not isfinite((p_input->>'endsAt')::timestamptz)
    or not isfinite((p_input->>'recruitmentEndsAt')::timestamptz) then
    raise exception 'invalid_input' using errcode='22023';
  end if;
  v_event_id:=private.parse_post_event_id(p_input->'eventId');
  -- 같은 생성 키의 원래 입력을 보존한다. 행사 취소 뒤 동일 재시도도 허용한다.
  perform pg_advisory_xact_lock(hashtextextended(p_post_id::text, 320));
  select input into v_prior from private.service_post_inputs where post_id=p_post_id;
  if found then
    if (v_prior||jsonb_build_object('eventId',coalesce(v_prior->'eventId','null'::jsonb)))
      <> (p_input||jsonb_build_object('eventId',coalesce(p_input->'eventId','null'::jsonb)))
      or not exists(select 1 from public.posts where id=p_post_id and author_id=v_uid) then
      raise exception 'post_conflict' using errcode='40001';
    end if;
    return jsonb_build_object('postId',p_post_id,'alreadyCreated',true);
  end if;
  if exists(select 1 from public.posts where id=p_post_id) then raise exception 'post_conflict' using errcode='40001'; end if;
  perform private.assert_post_event_selectable(v_event_id);
  select coalesce(array_agg(value),'{}'::text[]) into v_tags from jsonb_array_elements_text(p_input->'tags');
  select * into v_post from public.create_post(p_post_id,p_input->>'title',p_input->>'description',p_input->>'category',
    (p_input->>'startsAt')::timestamptz,(p_input->>'endsAt')::timestamptz,(p_input->>'recruitmentEndsAt')::timestamptz,
    p_input->>'publicArea',p_input->>'meetingDetail',p_input->>'preferenceNote',v_tags,'any');
  update public.posts set cost_type='free',amount=0,source_event_id=v_event_id where id=p_post_id;
  perform public.set_post_search_location(p_post_id,p_input->>'registeredPlaceName',p_input->>'registeredAddress');
  insert into private.service_post_inputs(post_id,input) values(p_post_id,p_input);
  return jsonb_build_object('postId',p_post_id,'alreadyCreated',false);
exception when invalid_datetime_format or datetime_field_overflow or check_violation or not_null_violation then
  raise exception 'invalid_input' using errcode='22023';
end;
$$;

-- 사용자 수동 선택 UUID만 동의 지문에 포함한다. 공급사 최신 필드는 포함하지 않는다.
-- 연결 없는 기존 공고는 기존 JSON/해시를 그대로 유지한다.
create or replace function private.match_condition_version(p_post_id uuid)
returns text language sql stable security definer set search_path='' as $$
  select md5((private.match_conditions(p_post_id)||jsonb_build_object('address',l.registered_address,
    'place',l.registered_place_name,'detail',d.exact_location)
    ||case when p.source_event_id is null then '{}'::jsonb else jsonb_build_object('eventId',p.source_event_id) end)::text)
  from public.post_private_details d left join private.post_search_locations l on l.post_id=d.post_id
    join public.posts p on p.id=d.post_id
  where d.post_id=p_post_id;
$$;

create or replace function public.update_service_post(p_post_id uuid,p_input jsonb,p_expected_updated_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); p public.posts; v_tags text[]; v_old text; v_request uuid; v_event text; v_event_id uuid; v_old_event_id uuid;
begin
  perform private.assert_naver_activity_allowed();
  if p_expected_updated_at is null or not isfinite(p_expected_updated_at) then raise exception 'invalid_input' using errcode='22023'; end if;
  perform private.assert_service_post_input(p_input-'eventId');
  v_event_id:=private.parse_post_event_id(p_input->'eventId');
  select * into p from public.posts where id=p_post_id and author_id=v_uid and status<>'deleted' for update;
  if not found then raise exception 'post_unavailable' using errcode='P0002'; end if;
  if p.updated_at<>p_expected_updated_at or exists(select 1 from public.appointments where post_id=p.id)
    or p.starts_at<=clock_timestamp() then raise exception 'post_conflict' using errcode='40001'; end if;
  v_old_event_id:=p.source_event_id;
  if not(p_input?'eventId') then v_event_id:=p.source_event_id; end if;
  if v_event_id is distinct from p.source_event_id then
    perform private.assert_post_event_selectable(v_event_id);
  end if;
  perform private.lock_match_post_requests(p.id);
  perform private.expire_post_match_consents(p.id);
  v_old:=private.match_condition_version(p.id);
  select coalesce(array_agg(value),'{}'::text[]) into v_tags from jsonb_array_elements_text(p_input->'tags');
  update public.posts set title=p_input->>'title',description=p_input->>'description',category=p_input->>'category',
    starts_at=(p_input->>'startsAt')::timestamptz,ends_at=(p_input->>'endsAt')::timestamptz,
    recruitment_ends_at=(p_input->>'recruitmentEndsAt')::timestamptz,public_area=p_input->>'publicArea',
    preference_note=p_input->>'preferenceNote',tags=v_tags,cost_type='free',amount=0,source_event_id=v_event_id where id=p.id returning * into p;
  update public.post_private_details set exact_location=p_input->>'meetingDetail' where post_id=p.id;
  if not found then insert into public.post_private_details(post_id,exact_location) values(p.id,p_input->>'meetingDetail'); end if;
  perform public.set_post_search_location(p.id,p_input->>'registeredPlaceName',p_input->>'registeredAddress');
  -- 최초 생성 재시도용 service_post_inputs는 원본 그대로 보존한다.
  if v_old is distinct from private.match_condition_version(p.id) or v_event_id is distinct from v_old_event_id then
    v_event:=gen_random_uuid()::text;
    for v_request in select id from public.join_requests where post_id=p.id and status='pending' order by id loop
      perform private.end_match_consent(v_request,'invalidated');
      perform private.notify_match_lifecycle(v_request,'post_conditions_changed',v_event,jsonb_build_object('status','conditions_changed'));
    end loop;
  end if;
  return jsonb_build_object('postId',p.id,'status',p.status,'updatedAt',p.updated_at);
exception when check_violation or not_null_violation then raise exception 'invalid_input' using errcode='22023';
end; $$;

create or replace function public.get_service_post(p_post_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); p public.posts; v_details jsonb; v_names jsonb; v_result jsonb; v_pair boolean;
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
    'authorDisplayName',case when v_uid is null then '동행-'||replace(p.id::text,'-','')
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
    left join private.events linked_event on linked_event.id=p.source_event_id
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

-- CREATE OR REPLACE는 기존 공개 RPC ACL을 유지한다. 직접 source 테이블/view 권한은 추가하지 않는다.
-- 공급사 행사 갱신은 posts.updated_at·match_condition_version·동행 일정에 전파하지 않는다.
commit;
