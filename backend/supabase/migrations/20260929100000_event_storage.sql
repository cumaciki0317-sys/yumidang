-- 민규담당. 기존 이력/공고/행사 제공처 어댑터는 변경하지 않는다.
begin;

create function private.event_calendar_date_v1(p_value text)
returns date language plpgsql immutable set search_path='' as $$
declare v_date date;
begin
  if p_value is null or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or left(p_value,4)='0000' then
    raise exception 'INVALID_EVENT_DATE' using errcode='22023';
  end if;
  begin v_date:=p_value::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'INVALID_EVENT_DATE' using errcode='22023';
  end;
  if to_char(v_date,'YYYY-MM-DD')<>p_value then
    raise exception 'INVALID_EVENT_DATE' using errcode='22023';
  end if;
  return v_date;
end; $$;

create function private.event_instant_v1(p_value text)
returns timestamptz language plpgsql immutable set search_path='' as $$
declare v_parts text[]; v_date date; v_offset integer:=0; v_result timestamptz;
begin
  if p_value is null then raise exception 'INVALID_EVENT_INSTANT' using errcode='22023'; end if;
  v_parts:=regexp_match(p_value,'^([0-9]{4}-[0-9]{2}-[0-9]{2})T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(\.[0-9]{1,3})?(Z|[+-]([01][0-9]|2[0-3]):([0-5][0-9]))$');
  if v_parts is null or v_parts[6]='-00:00' then
    raise exception 'INVALID_EVENT_INSTANT' using errcode='22023';
  end if;
  v_date:=private.event_calendar_date_v1(v_parts[1]);
  if v_parts[6]<>'Z' then
    v_offset:=(v_parts[7]::integer*60+v_parts[8]::integer)*case when left(v_parts[6],1)='-' then -1 else 1 end;
  end if;
  -- 어댑터와 같은 최대 millisecond 정밀도. 시각·offset 원문은 record에 그대로 남긴다.
  v_result:=(v_date::timestamp at time zone 'UTC')
    +make_interval(hours=>v_parts[2]::integer,mins=>v_parts[3]::integer,
      secs=>(v_parts[4]||coalesce(v_parts[5],''))::double precision)
    -make_interval(mins=>v_offset);
  return v_result;
end; $$;

create function private.event_public_text_v1(p_value text,p_max integer)
returns boolean language sql immutable set search_path='' as $$
  select p_value is not null and char_length(p_value) between 1 and p_max
    and btrim(p_value)=p_value and p_value !~ '[[:cntrl:]<>]';
$$;

create function private.valid_source_event_v1(p_event jsonb)
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
    if v_key in ('category','region','placeName','publicAddress') and p_event->v_key='null'::jsonb then continue; end if;
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

create table private.source_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  source_id text not null,
  collected_at timestamptz not null,
  record jsonb not null,
  constraint source_events_identity_unique unique(provider,source_id),
  constraint source_events_record_valid check(private.valid_source_event_v1(record)),
  constraint source_events_identity_matches check(provider=record->>'provider' and source_id=record->>'sourceId'),
  constraint source_events_collection_matches check(collected_at=private.event_instant_v1(record->>'collectedAt'))
);
alter table private.source_events enable row level security;
revoke all on private.source_events from public,anon,authenticated,service_role;
create index source_events_active_filter on private.source_events ((record->>'region'),(record->>'category'),id)
  where record->>'sourceStatus'='active';

create function public.upsert_source_events_v1(p_events jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_event jsonb; v_saved integer:=0; v_rows integer;
begin
  if p_events is null or jsonb_typeof(p_events)<>'array' then
    raise exception 'INVALID_EVENT_BATCH' using errcode='22023';
  end if;
  if jsonb_array_length(p_events)>1000 or octet_length(p_events::text)>8388608 then
    raise exception 'INVALID_EVENT_BATCH' using errcode='22023';
  end if;
  for v_event in select value from jsonb_array_elements(p_events) loop
    if not private.valid_source_event_v1(v_event) then
      raise exception 'INVALID_EVENT_RECORD' using errcode='22023';
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(p_events) e
      group by e->>'provider',e->>'sourceId' having count(*)>1) then
    raise exception 'DUPLICATE_EVENT_SOURCE_IDENTITY' using errcode='22023';
  end if;
  -- 정렬된 잠금 순서로 여러 수집 batch가 같은 identity를 갱신할 때 역순 교착을 줄인다.
  for v_event in select value from jsonb_array_elements(p_events)
      order by (value->>'provider') collate "C",(value->>'sourceId') collate "C" loop
    insert into private.source_events as existing(provider,source_id,collected_at,record)
      values(v_event->>'provider',v_event->>'sourceId',private.event_instant_v1(v_event->>'collectedAt'),v_event)
      on conflict(provider,source_id) do update
        set collected_at=excluded.collected_at,record=excluded.record
        where excluded.collected_at>existing.collected_at;
    get diagnostics v_rows=row_count;
    v_saved:=v_saved+v_rows;
  end loop;
  return jsonb_build_object('savedCount',v_saved);
end; $$;

create function public.list_event_candidates_v1(p_region text default null,p_category text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  if (p_region is not null and not private.event_public_text_v1(p_region,100))
    or (p_category is not null and not private.event_public_text_v1(p_category,100)) then
    raise exception 'INVALID_EVENT_FILTER' using errcode='22023';
  end if;
  -- 하나의 statement snapshot으로 최대 1001개까지 읽어 초과를 검출한다. 잘린 목록을 반환하지 않는다.
  select coalesce(jsonb_agg(candidate.value order by candidate.id),'[]'::jsonb) into v_result
  from (select e.id,e.record||jsonb_build_object('id',e.id) as value
      from private.source_events e
      where e.record->>'sourceStatus'='active'
        and (p_region is null or e.record->>'region'=p_region)
        and (p_category is null or e.record->>'category'=p_category)
      order by e.id limit 1001) candidate;
  if jsonb_array_length(v_result)>1000 then
    raise exception 'EVENT_CANDIDATE_LIMIT_EXCEEDED' using errcode='54000';
  end if;
  return v_result;
end; $$;

revoke all on function private.event_calendar_date_v1(text),private.event_instant_v1(text),
  private.event_public_text_v1(text,integer),private.valid_source_event_v1(jsonb)
  from public,anon,authenticated,service_role;
revoke all on function public.upsert_source_events_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.upsert_source_events_v1(jsonb) to service_role;
revoke all on function public.list_event_candidates_v1(text,text) from public,anon,authenticated,service_role;
grant execute on function public.list_event_candidates_v1(text,text) to anon,authenticated,service_role;
commit;
