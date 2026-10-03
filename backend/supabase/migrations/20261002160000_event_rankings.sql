-- 민규: 공식 KOPIS 순위의 내부 최신 수집본만 보관한다. 공개 카드·행사 선택 정책은 추가하지 않는다.
begin;

create function private.valid_kopis_top10_snapshot(p_snapshot jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare
  v_period jsonb; v_item jsonb; v_index integer:=0; v_count integer;
  v_start date; v_end date; v_parts text[]; v_ids text[]:=array[]::text[];
begin
  if p_snapshot is null or jsonb_typeof(p_snapshot)<>'object' or octet_length(p_snapshot::text)>65536 then return false; end if;
  if not p_snapshot ?& array['mode','requestedPeriod','collectedAt','items']
    or p_snapshot-array['mode','requestedPeriod','collectedAt','items']<>'{}'::jsonb
    or jsonb_typeof(p_snapshot->'mode')<>'string' or p_snapshot->>'mode' not in ('all','musical')
    or jsonb_typeof(p_snapshot->'collectedAt')<>'string' then return false; end if;
  perform private.event_instant_v1(p_snapshot->>'collectedAt');
  v_period:=p_snapshot->'requestedPeriod';
  if jsonb_typeof(v_period)<>'object' or not v_period ?& array['start','end']
    or v_period-array['start','end']<>'{}'::jsonb
    or jsonb_typeof(v_period->'start')<>'string' or jsonb_typeof(v_period->'end')<>'string' then return false; end if;
  v_start:=private.event_calendar_date_v1(v_period->>'start');
  v_end:=private.event_calendar_date_v1(v_period->>'end');
  -- upstream의 최대 31일 기술 규격이다. 실제 7일·일일 수집 운영값을 대신 선택하지 않는다.
  if v_end<v_start or v_end-v_start>30 then return false; end if;
  if jsonb_typeof(p_snapshot->'items')<>'array' then return false; end if;
  v_count:=jsonb_array_length(p_snapshot->'items');
  if v_count not between 1 and 10 then return false; end if;
  for v_item in select value from jsonb_array_elements(p_snapshot->'items') loop
    v_index:=v_index+1;
    if jsonb_typeof(v_item)<>'object' or not v_item ?& array['rank','sourceId','title','genre','performancePeriodText','placeName','region']
      or v_item-array['rank','sourceId','title','genre','performancePeriodText','placeName','region']<>'{}'::jsonb then return false; end if;
    -- 작은 범위 확인 후에도 cast하지 않고 numeric 비교한다. 거대·분수 입력을 좁힌다.
    if jsonb_typeof(v_item->'rank')<>'number' or (v_item->>'rank')::numeric<>v_index then return false; end if;
    if jsonb_typeof(v_item->'sourceId')<>'string' or not private.event_public_text_v1(v_item->>'sourceId',200)
      or (v_item->>'sourceId')=any(v_ids) then return false; end if;
    v_ids:=array_append(v_ids,v_item->>'sourceId');
    if jsonb_typeof(v_item->'title')<>'string' or not private.event_public_text_v1(v_item->>'title',500)
      or jsonb_typeof(v_item->'genre')<>'string' or not private.event_public_text_v1(v_item->>'genre',100)
      or jsonb_typeof(v_item->'placeName')<>'string' or not private.event_public_text_v1(v_item->>'placeName',300)
      or jsonb_typeof(v_item->'region')<>'string' or not private.event_public_text_v1(v_item->>'region',100)
      or jsonb_typeof(v_item->'performancePeriodText')<>'string'
      or not private.event_public_text_v1(v_item->>'performancePeriodText',64) then return false; end if;
    if p_snapshot->>'mode'='musical' and v_item->>'genre'<>'뮤지컬' then return false; end if;
    v_parts:=regexp_match(v_item->>'performancePeriodText','^([0-9]{4})\.([0-9]{2})\.([0-9]{2})[ ]*~[ ]*([0-9]{4})\.([0-9]{2})\.([0-9]{2})$');
    if v_parts is null then return false; end if;
    if private.event_calendar_date_v1(v_parts[4]||'-'||v_parts[5]||'-'||v_parts[6])
      <private.event_calendar_date_v1(v_parts[1]||'-'||v_parts[2]||'-'||v_parts[3]) then return false; end if;
  end loop;
  return true;
exception when invalid_parameter_value or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
  return false;
end; $$;

create table private.kopis_top10_snapshots (
  mode text primary key check(mode in ('all','musical')),
  collected_at timestamptz not null,
  snapshot jsonb not null check(private.valid_kopis_top10_snapshot(snapshot)),
  check(snapshot->>'mode'=mode),
  check(private.event_instant_v1(snapshot->>'collectedAt')=collected_at)
);
alter table private.kopis_top10_snapshots enable row level security;

create function public.store_kopis_top10_snapshot(p_snapshot jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_mode text; v_collected timestamptz; v_old private.kopis_top10_snapshots%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
  if not private.valid_kopis_top10_snapshot(p_snapshot) then raise exception 'INVALID_KOPIS_SNAPSHOT' using errcode='22023'; end if;
  v_mode:=p_snapshot->>'mode'; v_collected:=private.event_instant_v1(p_snapshot->>'collectedAt');
  -- 모드별 신규 삽입도 같은 잠금에서 직렬화한다. 배열의 공식 순서는 바꾸지 않는다.
  perform pg_advisory_xact_lock(1600,case v_mode when 'all' then 1 else 2 end);
  select * into v_old from private.kopis_top10_snapshots where mode=v_mode for update;
  if found then
    if v_old.collected_at>v_collected then
      return jsonb_build_object('status','stale','itemCount',jsonb_array_length(v_old.snapshot->'items'),'deduplicated',false);
    elsif v_old.collected_at=v_collected then
      if v_old.snapshot<>p_snapshot then raise exception 'KOPIS_SNAPSHOT_CONFLICT' using errcode='40001'; end if;
      return jsonb_build_object('status','saved','itemCount',jsonb_array_length(v_old.snapshot->'items'),'deduplicated',true);
    end if;
  end if;
  insert into private.kopis_top10_snapshots(mode,collected_at,snapshot) values(v_mode,v_collected,p_snapshot)
    on conflict(mode) do update set collected_at=excluded.collected_at,snapshot=excluded.snapshot;
  return jsonb_build_object('status','saved','itemCount',jsonb_array_length(p_snapshot->'items'),'deduplicated',false);
end; $$;

create function public.get_kopis_top10_snapshot(p_mode text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_snapshot jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
  if p_mode is null or p_mode not in ('all','musical') then raise exception 'INVALID_KOPIS_MODE' using errcode='22023'; end if;
  select snapshot into v_snapshot from private.kopis_top10_snapshots where mode=p_mode;
  return jsonb_build_object('status',case when found then 'available' else 'unavailable' end,
    'mode',p_mode,'source','kopis','requestedPeriod',v_snapshot->'requestedPeriod',
    'responsePeriod',null,'periodVerification','requested_only',
    'collectedAt',v_snapshot->'collectedAt','items',coalesce(v_snapshot->'items','[]'::jsonb));
end; $$;

revoke all on private.kopis_top10_snapshots from public,anon,authenticated,service_role;
revoke all on function private.valid_kopis_top10_snapshot(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.store_kopis_top10_snapshot(jsonb),public.get_kopis_top10_snapshot(text) from public,anon,authenticated,service_role;
grant execute on function public.store_kopis_top10_snapshot(jsonb),public.get_kopis_top10_snapshot(text) to service_role;
comment on table private.kopis_top10_snapshots is '모드별 최신 공식 순위 수집본만 보관. 요청기간이며 upstream 기간 echo 검증·공개 카드·선택 정책은 포함하지 않는다.';

commit;
