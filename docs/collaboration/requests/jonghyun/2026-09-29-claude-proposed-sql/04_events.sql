-- 종현 제안 SQL(민규 채택 필요). 정식 마이그레이션이 아니며 채택 시 BEGIN/COMMIT으로 감싼다.
-- 목적: 외부 행사(제공처+원천 ID)의 저장·공개 조회. 5.4 설계.
-- 원칙:
--  * (provider, source_id) 유일. 서로 다른 제공처의 비슷한 제목을 병합하지 않는다.
--  * upsert만 한다. 한 페이지에 없다는 이유로 기존 행사를 삭제하지 않는다(삭제 경로 없음).
--  * 명시적 취소(cancelled)는 저장하되 공개 조회에서 숨긴다. 비용 미상은 {"kind":"unknown"} 그대로 저장한다(무료로 바꾸지 않음).
--  * 날짜 정밀도(date: 한국 달력 날짜, 종료일 포함)와 시각 정밀도(instant: 명시 offset, 종료 시각 제외)를 구분 저장한다.
--  * 시계: 조회 RPC는 한 호출 안에서 DB now()(트랜잭션 시작 시각) 하나만 사용한다. 호출자가 기준 시각을 보내지 않는다.
--    한국 날짜·주간은 now() at time zone 'Asia/Seoul'로 계산한다. selectEvents(event-service.ts)와 같은 규칙이다.
--  * p_limit 1..50은 기존 search_public_posts_v2의 기술 한도를 그대로 따른 것이며 새 운영 정책이 아니다.
create table private.events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  source_id text not null check (source_id <> '' and source_id = btrim(source_id) and source_id !~ '[[:cntrl:]]'),
  source_status text not null check (source_status in ('active', 'cancelled')),
  title text not null check (btrim(title) <> '' and title !~ '<[^>]*>'),
  category text check (category is null or (btrim(category) <> '' and category !~ '<[^>]*>')),
  region text check (region is null or (btrim(region) <> '' and region !~ '<[^>]*>')),
  place_name text check (place_name is null or place_name !~ '<[^>]*>'),
  public_address text check (public_address is null or public_address !~ '<[^>]*>'),
  admission jsonb not null check ((case when jsonb_typeof(admission) = 'object' then (
    admission in ('{"kind":"unknown"}'::jsonb, '{"kind":"free"}'::jsonb) or (
      admission->>'kind' = 'described' and jsonb_typeof(admission->'text') = 'string'
      and admission - 'kind' - 'text' = '{}'::jsonb
      and btrim(admission->>'text') <> '' and admission->>'text' !~ '<[^>]*>')) else false end) is true),
  precision text not null check (precision in ('date', 'instant')),
  starts_on date,
  ends_on date,
  starts_at timestamptz,
  ends_at timestamptz,
  source_url text check (source_url is null or source_url ~ '^https?://[^/@[:space:]]+(/[^[:space:]]*)?$'),
  collected_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_source_identity unique (provider, source_id),
  constraint events_timing check (
    (precision = 'date' and starts_on is not null and ends_on is not null and ends_on >= starts_on
      and starts_at is null and ends_at is null)
    or (precision = 'instant' and starts_at is not null and ends_at is not null and ends_at > starts_at
      and starts_on is null and ends_on is null))
);
alter table private.events enable row level security;
revoke all on private.events from public, anon, authenticated, service_role;

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
returns date language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_value) <> 'string' or p_value #>> '{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'invalid_event_date' using errcode = '22023';
  end if;
  begin
    if to_char((p_value #>> '{}')::date, 'YYYY-MM-DD') <> p_value #>> '{}' then
      raise exception 'invalid_event_date' using errcode = '22023';
    end if;
    return (p_value #>> '{}')::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception 'invalid_event_date' using errcode = '22023';
  end;
end; $$;

-- parseEventInstant와 같은 형식: 초까지 필수, 소수 1~3자리, Z 또는 ±HH:MM(-00:00 거절).
create function private.event_instant(p_value jsonb)
returns timestamptz language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  if jsonb_typeof(p_value) <> 'string' then raise exception 'invalid_event_instant' using errcode = '22023'; end if;
  v := p_value #>> '{}';
  if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
    or v ~ '-00:00$' then
    raise exception 'invalid_event_instant' using errcode = '22023';
  end if;
  perform private.event_date(to_jsonb(left(v, 10)));
  begin
    return v::timestamptz;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception 'invalid_event_instant' using errcode = '22023';
  end;
end; $$;

create function private.event_optional_text(p_value jsonb, p_allow_blank boolean)
returns text language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_value) = 'null' then return null; end if;
  if jsonb_typeof(p_value) <> 'string' or p_value #>> '{}' ~ '<[^>]*>'
    or (not p_allow_blank and btrim(p_value #>> '{}') = '') then
    raise exception 'invalid_event_public_text' using errcode = '22023';
  end if;
  return p_value #>> '{}';
end; $$;

revoke all on function private.event_keyword(text), private.event_seoul_day_start(date), private.event_date(jsonb),
  private.event_instant(jsonb), private.event_optional_text(jsonb, boolean) from public, anon, authenticated, service_role;

-- 내부 수집 전용. 한 페이지 단위 upsert. 삭제하지 않는다.
-- 반환: receivedCount(입력 건수), insertedCount, updatedCount, staleCount(이미 더 최근 수집본이 있어 덮어쓰지 않은 건수).
-- savedCount = insertedCount + updatedCount. 오래된 수집본(collected_at이 더 과거)은 최신 저장본을 되돌리지 않는다.
create function public.upsert_events(p_events jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_item jsonb; v_precision text; v_keys text[]; v_expected text[];
  v_inserted integer := 0; v_updated integer := 0; v_received integer; v_inserted_flag boolean;
  v_starts_on date; v_ends_on date; v_starts_at timestamptz; v_ends_at timestamptz; v_collected timestamptz;
  v_admission jsonb; v_source_url text;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'invalid_event_batch' using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_events);
  -- 같은 페이지 안의 중복 식별자는 조용히 합치지 않고 거절한다.
  if (select count(*) from (select distinct e->>'provider', e->>'sourceId' from jsonb_array_elements(p_events) e) d) <> v_received then
    raise exception 'duplicate_event_identity' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_events) loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'invalid_event_record' using errcode = '22023'; end if;
    v_precision := v_item->>'precision';
    select array_agg(k order by k) into v_keys from jsonb_object_keys(v_item) k;
    v_expected := case v_precision
      when 'date' then array['admission','category','collectedAt','endsOn','placeName','precision','provider','publicAddress',
        'region','sourceId','sourceStatus','sourceUrl','startsOn','title']
      when 'instant' then array['admission','category','collectedAt','endsAt','placeName','precision','provider','publicAddress',
        'region','sourceId','sourceStatus','sourceUrl','startsAt','title']
      else null end;
    if v_expected is null or v_keys is distinct from (select array_agg(x order by x) from unnest(v_expected) x) then
      raise exception 'invalid_event_record' using errcode = '22023';
    end if;
    if jsonb_typeof(v_item->'provider') <> 'string' or v_item->>'provider' !~ '^[a-z0-9][a-z0-9-]{0,31}$'
      or jsonb_typeof(v_item->'sourceId') <> 'string' or v_item->>'sourceId' = '' or v_item->>'sourceId' <> btrim(v_item->>'sourceId')
      or v_item->>'sourceId' ~ '[[:cntrl:]]'
      or jsonb_typeof(v_item->'title') <> 'string' or btrim(v_item->>'title') = '' or v_item->>'title' ~ '<[^>]*>'
      or jsonb_typeof(v_item->'sourceStatus') <> 'string' or v_item->>'sourceStatus' not in ('active', 'cancelled') then
      raise exception 'invalid_event_record' using errcode = '22023';
    end if;
    v_admission := v_item->'admission';
    -- CASE로 객체 연산을 보호한다. AND만으로는 평가 순서가 보장되지 않아 scalar에서 오류가 날 수 있다.
    if (case when jsonb_typeof(v_admission) = 'object' then (
      v_admission in ('{"kind":"unknown"}'::jsonb, '{"kind":"free"}'::jsonb) or (
      jsonb_typeof(v_admission) = 'object' and v_admission->>'kind' = 'described' and jsonb_typeof(v_admission->'text') = 'string'
      and v_admission - 'kind' - 'text' = '{}'::jsonb
      and btrim(v_admission->>'text') <> '' and v_admission->>'text' !~ '<[^>]*>')) else false end) is not true then
      raise exception 'invalid_event_admission' using errcode = '22023';
    end if;
    if jsonb_typeof(v_item->'sourceUrl') = 'null' then v_source_url := null;
    elsif jsonb_typeof(v_item->'sourceUrl') = 'string' and v_item->>'sourceUrl' ~ '^https?://[^/@[:space:]]+(/[^[:space:]]*)?$' then
      v_source_url := v_item->>'sourceUrl';
    else raise exception 'invalid_event_source_url' using errcode = '22023'; end if;
    v_collected := private.event_instant(v_item->'collectedAt');
    v_starts_on := null; v_ends_on := null; v_starts_at := null; v_ends_at := null;
    if v_precision = 'date' then
      v_starts_on := private.event_date(v_item->'startsOn');
      v_ends_on := private.event_date(v_item->'endsOn');
      if v_ends_on < v_starts_on then raise exception 'invalid_event_period' using errcode = '22023'; end if;
    else
      v_starts_at := private.event_instant(v_item->'startsAt');
      v_ends_at := private.event_instant(v_item->'endsAt');
      if v_ends_at <= v_starts_at then raise exception 'invalid_event_period' using errcode = '22023'; end if;
    end if;

    insert into private.events as e (provider, source_id, source_status, title, category, region, place_name, public_address,
      admission, precision, starts_on, ends_on, starts_at, ends_at, source_url, collected_at)
    values (v_item->>'provider', v_item->>'sourceId', v_item->>'sourceStatus', v_item->>'title',
      private.event_optional_text(v_item->'category', false), private.event_optional_text(v_item->'region', false),
      private.event_optional_text(v_item->'placeName', true), private.event_optional_text(v_item->'publicAddress', true),
      v_admission, v_precision, v_starts_on, v_ends_on, v_starts_at, v_ends_at, v_source_url, v_collected)
    on conflict (provider, source_id) do update set
      source_status = excluded.source_status, title = excluded.title, category = excluded.category, region = excluded.region,
      place_name = excluded.place_name, public_address = excluded.public_address, admission = excluded.admission,
      precision = excluded.precision, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
      starts_at = excluded.starts_at, ends_at = excluded.ends_at, source_url = excluded.source_url,
      collected_at = excluded.collected_at, updated_at = now()
      where excluded.collected_at >= e.collected_at
    returning (xmax = 0) into v_inserted_flag;
    if found then
      if v_inserted_flag then v_inserted := v_inserted + 1; else v_updated := v_updated + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('receivedCount', v_received, 'insertedCount', v_inserted, 'updatedCount', v_updated,
    'staleCount', v_received - v_inserted - v_updated);
end; $$;

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
    where e.source_status <> 'cancelled'
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

revoke all on function public.upsert_events(jsonb), public.list_public_events(jsonb, jsonb, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.upsert_events(jsonb) to service_role;
grant execute on function public.list_public_events(jsonb, jsonb, integer) to anon, authenticated, service_role;
