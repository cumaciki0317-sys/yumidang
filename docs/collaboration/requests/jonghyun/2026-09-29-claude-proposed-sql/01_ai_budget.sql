-- 종현 제안 SQL(민규 채택 필요). 정식 마이그레이션이 아니며 채택 시 BEGIN/COMMIT으로 감싼다.
-- 목적: AI 탐색·의미 비교·요약의 동시 모델 호출을 DB 행 잠금으로 원자 예약·정산한다.
-- 원문·사용자 ID·요청 내용을 저장하지 않는다. 한도 숫자는 운영자가 명시 설정하며 기본값이 없다.
-- 단위: 토큰 상한 단위(입력 UTF-8 바이트 + 고정 prompt 바이트 + 요청 최대 출력 토큰). 사용량 불명은 예약 전체를 소비로 유지한다.
create table private.ai_budget_ledgers (
  ledger_id text primary key check (ledger_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  unit_limit bigint not null check (unit_limit > 0),
  call_limit bigint not null check (call_limit > 0),
  reserved_units bigint not null default 0 check (reserved_units >= 0),
  charged_units bigint not null default 0 check (charged_units >= 0),
  open_calls bigint not null default 0 check (open_calls >= 0),
  settled_calls bigint not null default 0 check (settled_calls >= 0),
  unknown_usage_calls bigint not null default 0 check (unknown_usage_calls >= 0),
  updated_at timestamptz not null default clock_timestamp()
);
create table private.ai_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references private.ai_budget_ledgers(ledger_id) on delete cascade,
  provider_id text not null check (provider_id ~ '^[a-z0-9_.-]{1,32}$'),
  task text not null check (task in ('intent','preference_match','explanation','review_chunk','review_merge')),
  units bigint not null check (units > 0),
  created_at timestamptz not null default clock_timestamp()
);
create index ai_budget_reservations_ledger on private.ai_budget_reservations(ledger_id);
alter table private.ai_budget_ledgers enable row level security;
alter table private.ai_budget_reservations enable row level security;
revoke all on private.ai_budget_ledgers, private.ai_budget_reservations from public, anon, authenticated, service_role;

-- 운영자가 명시한 한도만 기록한다. 이미 소비한 양을 되돌리지 않으며 한도를 소비량 아래로 낮추면 새 예약만 막힌다.
create function public.configure_ai_budget_ledger(p_ledger_id text, p_unit_limit bigint, p_call_limit bigint)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_ledger_id is null or p_ledger_id !~ '^[A-Za-z0-9_.:-]{1,64}$' or p_unit_limit is null or p_unit_limit < 1
    or p_call_limit is null or p_call_limit < 1 then
    raise exception 'invalid_budget_ledger' using errcode = '22023';
  end if;
  insert into private.ai_budget_ledgers(ledger_id, unit_limit, call_limit) values (p_ledger_id, p_unit_limit, p_call_limit)
    on conflict (ledger_id) do update set unit_limit = excluded.unit_limit, call_limit = excluded.call_limit, updated_at = clock_timestamp();
  return jsonb_build_object('ledgerId', p_ledger_id, 'configured', true);
end; $$;

create function public.reserve_ai_budget(p_ledger_id text, p_provider_id text, p_task text, p_units bigint)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_ledger private.ai_budget_ledgers; v_id uuid;
begin
  if p_ledger_id is null or p_ledger_id !~ '^[A-Za-z0-9_.:-]{1,64}$' or p_provider_id is null or p_provider_id !~ '^[a-z0-9_.-]{1,32}$'
    or p_task is null or p_task not in ('intent','preference_match','explanation','review_chunk','review_merge')
    or p_units is null or p_units < 1 then
    raise exception 'invalid_budget_input' using errcode = '22023';
  end if;
  -- 같은 원장의 동시 예약은 이 행 잠금으로 직렬화된다.
  select * into v_ledger from private.ai_budget_ledgers where ledger_id = p_ledger_id for update;
  if not found then raise exception 'budget_ledger_unavailable' using errcode = 'P0002'; end if;
  if v_ledger.reserved_units + v_ledger.charged_units + p_units > v_ledger.unit_limit
    or v_ledger.open_calls + v_ledger.settled_calls + 1 > v_ledger.call_limit then
    return jsonb_build_object('reservationId', null);
  end if;
  insert into private.ai_budget_reservations(ledger_id, provider_id, task, units)
    values (p_ledger_id, p_provider_id, p_task, p_units) returning id into v_id;
  update private.ai_budget_ledgers set reserved_units = reserved_units + p_units, open_calls = open_calls + 1,
    updated_at = clock_timestamp() where ledger_id = p_ledger_id;
  return jsonb_build_object('reservationId', v_id);
end; $$;

-- usage_reported: 공급사가 보고한 입력+출력 토큰을 소비로 기록(예약보다 클 수 있음).
-- usage_unknown: 예약 단위 전체를 소비로 기록. 어느 경우에도 예약 행은 한 번만 정산된다.
create function public.settle_ai_budget(p_reservation_id uuid, p_outcome text, p_input_tokens bigint, p_output_tokens bigint)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_ledger_id text; v_units bigint; v_charge bigint;
begin
  if p_reservation_id is null or p_outcome is null or p_outcome not in ('usage_reported','usage_unknown')
    or (p_outcome = 'usage_reported' and (p_input_tokens is null or p_output_tokens is null or p_input_tokens < 0 or p_output_tokens < 0))
    or (p_outcome = 'usage_unknown' and (p_input_tokens is not null or p_output_tokens is not null)) then
    raise exception 'invalid_budget_settlement' using errcode = '22023';
  end if;
  select ledger_id into v_ledger_id from private.ai_budget_reservations where id = p_reservation_id;
  if not found then raise exception 'budget_reservation_settled' using errcode = 'P0001'; end if;
  -- 예약과 같은 잠금 순서: 원장 → 예약 행.
  perform 1 from private.ai_budget_ledgers where ledger_id = v_ledger_id for update;
  delete from private.ai_budget_reservations where id = p_reservation_id returning units into v_units;
  if not found then raise exception 'budget_reservation_settled' using errcode = 'P0001'; end if;
  v_charge := case when p_outcome = 'usage_reported' then p_input_tokens + p_output_tokens else v_units end;
  update private.ai_budget_ledgers set reserved_units = reserved_units - v_units, charged_units = charged_units + v_charge,
    open_calls = open_calls - 1, settled_calls = settled_calls + 1,
    unknown_usage_calls = unknown_usage_calls + case when p_outcome = 'usage_unknown' then 1 else 0 end,
    updated_at = clock_timestamp() where ledger_id = v_ledger_id;
  return jsonb_build_object('settled', true);
end; $$;

-- 원장 상태 조회(운영자·검증용). 원문·호출자 정보가 없다.
create function public.get_ai_budget_ledger(p_ledger_id text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ledgerId', ledger_id, 'unitLimit', unit_limit, 'callLimit', call_limit,
    'reservedUnits', reserved_units, 'chargedUnits', charged_units, 'openCalls', open_calls,
    'settledCalls', settled_calls, 'unknownUsageCalls', unknown_usage_calls)
  from private.ai_budget_ledgers where ledger_id = p_ledger_id;
$$;

revoke all on function public.configure_ai_budget_ledger(text, bigint, bigint), public.reserve_ai_budget(text, text, text, bigint),
  public.settle_ai_budget(uuid, text, bigint, bigint), public.get_ai_budget_ledger(text) from public, anon, authenticated, service_role;
grant execute on function public.configure_ai_budget_ledger(text, bigint, bigint), public.reserve_ai_budget(text, text, text, bigint),
  public.settle_ai_budget(uuid, text, bigint, bigint), public.get_ai_budget_ledger(text) to service_role;
