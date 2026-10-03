-- 민규: 종현 제안 04·05 채택. source_events만 저장하고 events는 typed view다.
-- 전제: 원본 20260929100000_event_storage.sql. 기존 ID·record·이력은 보존한다.
begin;

-- 기존 검사보다 약하게 만들지 않고 공식 링크 부재(null)만 명시 허용한다.
create function private.valid_source_event_v2(p_event jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare
  v_keys text[]:=array['provider','sourceId','sourceStatus','title','category','region','placeName','publicAddress','admission','sourceUrl','collectedAt','precision'];
  v_key text; v_limit integer; v_admission jsonb; v_url text; v_host text; v_port text;
begin
  if p_event is null or jsonb_typeof(p_event)<>'object' or octet_length(p_event::text)>65536 then return false; end if;
  if p_event->>'precision'='date' then v_keys:=v_keys||array['startsOn','endsOn'];
  elsif p_event->>'precision'='instant' then v_keys:=v_keys||array['startsAt','endsAt'];
  else return false; end if;
  if not p_event ?& v_keys or p_event-v_keys<>'{}'::jsonb then return false; end if;
  foreach v_key in array v_keys loop
    if v_key='admission' then continue; end if;
    if v_key in ('category','region','placeName','publicAddress','sourceUrl') and p_event->v_key='null'::jsonb then continue; end if;
    if jsonb_typeof(p_event->v_key)<>'string' then return false; end if;
  end loop;
  if p_event->>'provider' !~ '^[a-z0-9][a-z0-9_-]{0,79}$'
    or not private.event_public_text_v1(p_event->>'sourceId',200)
    or not private.event_public_text_v1(p_event->>'title',500)
    or p_event->>'sourceStatus' not in ('active','cancelled') then return false; end if;
  foreach v_key in array array['category','region','placeName','publicAddress'] loop
    v_limit:=case when v_key='placeName' then 300 when v_key='publicAddress' then 1000 else 100 end;
    if p_event->v_key<>'null'::jsonb and not private.event_public_text_v1(p_event->>v_key,v_limit) then return false; end if;
  end loop;
  v_admission:=p_event->'admission';
  if jsonb_typeof(v_admission)<>'object' then return false; end if;
  if v_admission->>'kind' in ('unknown','free') then
    if v_admission<>jsonb_build_object('kind',v_admission->>'kind') then return false; end if;
  elsif v_admission->>'kind'='described' then
    if not v_admission ?& array['kind','text'] or v_admission-array['kind','text']<>'{}'::jsonb
      or jsonb_typeof(v_admission->'text')<>'string'
      or not private.event_public_text_v1(v_admission->>'text',2000) then return false; end if;
  else return false; end if;
  v_url:=p_event->>'sourceUrl';
  if v_url is not null then
  if char_length(v_url)>2048 or v_url ~ '[[:space:][:cntrl:]<>"\\]'
    or v_url !~ '^https?://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?([/?#].*)?$'
    or v_url ~* '[?&#](api[_-]?key|service[_-]?key|access[_-]?token|key|token|auth|authorization|secret|password|credential|signature|sig)(=|&|#|$)'
    or v_url ~ '[?&#][^=&#]*%[^=&#]*=' then return false; end if;
  -- DNS/IPv4 공개 URL만 받으며 userinfo는 위 authority 문법에서 거절한다.
  v_host:=substring(v_url from '^https?://([^/?#:]+)');
  if v_host ~ '(^[.-]|[.-]$|\.\.|\.-|-\.)' then return false; end if;
  -- 알려진 공급사 API URL은 query뿐 아니라 path에도 키가 들어가므로 공개 출처로 받지 않는다.
  if lower(v_host) in ('openapi.seoul.go.kr','apis.data.go.kr')
    or (lower(v_host) in ('kopis.or.kr','www.kopis.or.kr')
      and v_url ~* '^https?://[^/?#]+/openapi([/?#]|$)') then return false; end if;
  v_port:=substring(v_url from '^https?://[^/?#:]+:([0-9]+)');
  if v_port is not null and v_port::integer not between 1 and 65535 then return false; end if;
  end if;
  perform private.event_instant_v1(p_event->>'collectedAt');
  if p_event->>'precision'='date' then
    if private.event_calendar_date_v1(p_event->>'endsOn')<private.event_calendar_date_v1(p_event->>'startsOn') then return false; end if;
    -- endsOn은 포함 날짜이며 저장 시 임의 시각으로 변환하지 않는다.
    if p_event->>'endsOn'='9999-12-31' then return false; end if;
  elsif private.event_instant_v1(p_event->>'endsAt')<=private.event_instant_v1(p_event->>'startsAt') then return false;
  end if;
  return true;
exception when invalid_parameter_value or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
  return false;
end; $$;

revoke all on function private.valid_source_event_v2(jsonb) from public,anon,authenticated,service_role;
alter table private.source_events drop constraint source_events_record_valid;
alter table private.source_events add constraint source_events_record_valid
  check(private.valid_source_event_v2(record));

-- 별도 normalized data 사본을 만들지 않는다. 외부 역할은 view도 직접 읽지 못한다.
create view private.events as
  select id,provider,source_id,record->>'sourceStatus' as source_status,record->>'title' as title,
    record->>'category' as category,record->>'region' as region,record->>'placeName' as place_name,
    record->>'publicAddress' as public_address,record->'admission' as admission,
    record->>'precision' as precision,
    case when record->>'precision'='date' then private.event_calendar_date_v1(record->>'startsOn') end as starts_on,
    case when record->>'precision'='date' then private.event_calendar_date_v1(record->>'endsOn') end as ends_on,
    case when record->>'precision'='instant' then private.event_instant_v1(record->>'startsAt') end as starts_at,
    case when record->>'precision'='instant' then private.event_instant_v1(record->>'endsAt') end as ends_at,
    record->>'sourceUrl' as source_url,collected_at
  from private.source_events;
revoke all on private.events from public,anon,authenticated,service_role;

-- 모든 저장 RPC가 동일 검증·identity 잠금 순서·실저장소를 사용한다.
create function private.upsert_canonical_events(p_events jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_event jsonb; v_received integer; v_inserted integer:=0; v_updated integer:=0; v_rows integer;
begin
  if p_events is null or jsonb_typeof(p_events)<>'array' then
    raise exception 'INVALID_EVENT_BATCH' using errcode='22023';
  end if;
  v_received:=jsonb_array_length(p_events);
  if v_received>1000 or octet_length(p_events::text)>8388608 then
    raise exception 'INVALID_EVENT_BATCH' using errcode='22023';
  end if;
  -- 쓰기 전에 전체 배치를 검사한다. 한 항목 실패도 부분 성공으로 바꾸지 않는다.
  for v_event in select value from jsonb_array_elements(p_events) loop
    if not private.valid_source_event_v2(v_event) then
      raise exception 'INVALID_EVENT_RECORD' using errcode='22023';
    end if;
  end loop;
  if (select count(*) from (select distinct e->>'provider',e->>'sourceId' from jsonb_array_elements(p_events) e) d)<>v_received then
    raise exception 'DUPLICATE_EVENT_IDENTITY' using errcode='22023';
  end if;
  for v_event in select value from jsonb_array_elements(p_events) order by value->>'provider',value->>'sourceId' loop
    insert into private.source_events(provider,source_id,collected_at,record)
      values(v_event->>'provider',v_event->>'sourceId',private.event_instant_v1(v_event->>'collectedAt'),v_event)
      on conflict(provider,source_id) do nothing;
    get diagnostics v_rows=row_count;
    if v_rows=1 then v_inserted:=v_inserted+1;
    else
      update private.source_events set record=v_event,collected_at=private.event_instant_v1(v_event->>'collectedAt')
        where provider=v_event->>'provider' and source_id=v_event->>'sourceId'
          and collected_at<private.event_instant_v1(v_event->>'collectedAt');
      get diagnostics v_rows=row_count;
      v_updated:=v_updated+v_rows;
    end if;
  end loop;
  return jsonb_build_object('receivedCount',v_received,'insertedCount',v_inserted,'updatedCount',v_updated,
    'staleCount',v_received-v_inserted-v_updated);
end; $$;
revoke all on function private.upsert_canonical_events(jsonb) from public,anon,authenticated,service_role;
create function public.upsert_events(p_events jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  if p_events is null or jsonb_typeof(p_events)<>'array' then
    raise exception 'INVALID_EVENT_BATCH' using errcode='22023';
  end if;
  -- 신규 wire는 종현 E repository의 provider 형식과 일치시킨다.
  -- 구형 넓은 provider 기록·v1 writer는 그대로 보존한다.
  if exists(select 1 from jsonb_array_elements(p_events) e
    where jsonb_typeof(e->'provider') is distinct from 'string'
      or e->>'provider' !~ '^[a-z0-9][a-z0-9-]{0,31}$') then
    raise exception 'INVALID_EVENT_RECORD' using errcode='22023';
  end if;
  return private.upsert_canonical_events(p_events);
end; $$;
-- Deprecated v1 호환: 신규 호출은 upsert_events를 사용한다. 과거 응답은 보존한다.
create or replace function public.upsert_source_events_v1(p_events jsonb)
returns jsonb language sql volatile security definer set search_path='' as $$
  select jsonb_build_object('savedCount',(v.result->>'insertedCount')::integer+(v.result->>'updatedCount')::integer)
    from (select private.upsert_canonical_events(p_events) as result) v;
$$;

-- 행사명·장소명·공개 주소 검색용 정규화. event-service/events.ts normalizeEventKeyword와 같은 규칙(앞뒤 공백 제거, 연속 공백 1개, 소문자).
create function private.event_keyword(p_value text)
returns text language sql immutable set search_path = '' as $$
  select lower(btrim(regexp_replace(p_value, '[[:space:]]+', ' ', 'g'), ' '));
$$;

-- 날짜 정밀도의 검색 경계: 한국 달력 날짜 00:00(+09:00).
create function private.event_seoul_day_start(p_day date)
returns timestamptz language sql immutable set search_path = '' as $$
  select (p_day::timestamp at time zone 'Asia/Seoul');
$$;

create function private.event_date(p_value jsonb)
returns date language plpgsql immutable set search_path='' as $$
begin
  if jsonb_typeof(p_value) is distinct from 'string' then
    raise exception 'invalid_event_date' using errcode='22023';
  end if;
  return private.event_calendar_date_v1(p_value #>> '{}');
end; $$;
create function private.event_instant(p_value jsonb)
returns timestamptz language plpgsql immutable set search_path='' as $$
begin
  if jsonb_typeof(p_value) is distinct from 'string' then
    raise exception 'invalid_event_instant' using errcode='22023';
  end if;
  return private.event_instant_v1(p_value #>> '{}');
end; $$;

revoke all on function private.event_keyword(text), private.event_seoul_day_start(date), private.event_date(jsonb),
  private.event_instant(jsonb) from public, anon, authenticated, service_role;

-- 공개 조회. selectEvents와 같은 모드·진행 중·기간 겹침·취소 제외 + 키워드(행사명/장소명/공개 주소 중 한 필드 부분 일치)
-- + region/category 정확 일치. 정렬: 진행 중(최근 시작) → 예정(빠른 시작) → 종료(최근 종료), 동률 id.
-- 필터·정렬 후 keyset 페이지. 커서 {rank, key, id}: rank = 상태 그룹, key = 그룹 내 정렬값(epoch 초, 부호 포함 문자열).
-- 커서는 스냅샷이 아니다. 시간이 지나 상태 그룹이 바뀐 행은 다음 페이지 경계에서 누락·중복될 수 있다.
create function public.list_public_events(p_filters jsonb, p_cursor jsonb, p_limit integer)
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
    where e.source_status <> 'cancelled' and e.provider ~ '^[a-z0-9][a-z0-9-]{0,31}$'
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

create function public.list_event_filter_values()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'regions', coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'value', region, 'count', n) order by provider, region)
      from (select provider, region, count(*) n from private.events where source_status = 'active' and provider ~ '^[a-z0-9][a-z0-9-]{0,31}$' and region is not null
        group by provider, region) r), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'value', category, 'count', n) order by provider, category)
      from (select provider, category, count(*) n from private.events where source_status = 'active' and provider ~ '^[a-z0-9][a-z0-9-]{0,31}$' and category is not null
        group by provider, category) c), '[]'::jsonb));
$$;
revoke all on function public.list_event_filter_values() from public, anon, authenticated, service_role;
grant execute on function public.list_event_filter_values() to anon, authenticated, service_role;

revoke all on function public.upsert_events(jsonb), public.upsert_source_events_v1(jsonb),
  public.list_public_events(jsonb,jsonb,integer) from public,anon,authenticated,service_role;
grant execute on function public.upsert_events(jsonb),public.upsert_source_events_v1(jsonb) to service_role;
grant execute on function public.list_public_events(jsonb,jsonb,integer) to anon,authenticated,service_role;

-- S14 회원 공개 프로필. U13에 따라 본인 프로필 RPC는 변경하지 않는다.
create function public.get_public_profile(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=private.require_member_uid(); v_profile public.profiles; v_traits private.profile_traits; v_full_name boolean;
begin
  if not exists(select 1 from public.profiles where id=v_uid) then
    raise exception 'profile_required' using errcode='P0002';
  end if;
  if p_profile_id is null then raise exception 'invalid_profile_id' using errcode='22023'; end if;
  select * into v_profile from public.profiles where id=p_profile_id;
  if not found then raise exception 'profile_unavailable' using errcode='P0002'; end if;
  v_full_name:=v_uid=p_profile_id or exists(
    select 1 from public.appointments ap join public.posts p on p.id=ap.post_id
    join public.join_requests r on r.id=ap.join_request_id
    where ap.status in('confirmed','completed') and p.author_id<>r.requester_id
      and ((p.author_id=v_uid and r.requester_id=p_profile_id) or (r.requester_id=v_uid and p.author_id=p_profile_id)));
  select * into v_traits from private.profile_traits where profile_id=p_profile_id;
  return jsonb_build_object('profileId',v_profile.id,
    'displayName',case when v_full_name then v_profile.real_name else public.mask_real_name(v_profile.real_name) end,
    'age',public.korean_age(v_profile.birth_date),'gender',v_profile.gender,'avatarPath',v_profile.avatar_url,'bio',v_profile.bio,
    'interests',coalesce(to_jsonb(v_traits.interests),'[]'::jsonb),
    'conversationStyles',coalesce(to_jsonb(v_traits.conversation_styles),'[]'::jsonb),'mbti',v_traits.mbti,
    'completedCount',private.completed_appointment_count(p_profile_id));
end; $$;
revoke all on function public.get_public_profile(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_public_profile(uuid) to authenticated;
commit;
