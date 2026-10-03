-- 민규: 종현 제안 01·03 채택. 과거 이력·공개 정책·별도 게시 RPC를 보존한다.
-- 실제 회원 원문의 외부 전송은 보관 조건·사용자 확인 전 보류한다.
-- 한도·lease·실행량의 운영 기본값, 자동 TTL, 작업 kind 확장을 추가하지 않는다.
begin;

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
  if v_ledger.reserved_units::numeric + v_ledger.charged_units + p_units > v_ledger.unit_limit
    or v_ledger.open_calls::numeric + v_ledger.settled_calls + 1 > v_ledger.call_limit then
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
declare v_ledger_id text; v_units bigint; v_charge bigint; v_total numeric; v_ledger private.ai_budget_ledgers;
begin
  if p_reservation_id is null or p_outcome is null or p_outcome not in ('usage_reported','usage_unknown')
    or (p_outcome = 'usage_reported' and (p_input_tokens is null or p_output_tokens is null or p_input_tokens < 0 or p_output_tokens < 0))
    or (p_outcome = 'usage_unknown' and (p_input_tokens is not null or p_output_tokens is not null)) then
    raise exception 'invalid_budget_settlement' using errcode = '22023';
  end if;
  select ledger_id into v_ledger_id from private.ai_budget_reservations where id = p_reservation_id;
  if not found then raise exception 'budget_reservation_settled' using errcode = 'P0001'; end if;
  -- 예약과 같은 잠금 순서: 원장 → 예약 행.
  select * into v_ledger from private.ai_budget_ledgers where ledger_id = v_ledger_id for update;
  delete from private.ai_budget_reservations where id = p_reservation_id returning units into v_units;
  if not found then raise exception 'budget_reservation_settled' using errcode = 'P0001'; end if;
  v_total := case when p_outcome = 'usage_reported' then p_input_tokens::numeric + p_output_tokens else v_units::numeric end;
  if v_total > 9223372036854775807::numeric
    or v_ledger.charged_units::numeric + v_total > 9223372036854775807::numeric
    or v_ledger.settled_calls = 9223372036854775807
    or (p_outcome = 'usage_unknown' and v_ledger.unknown_usage_calls = 9223372036854775807) then
    raise exception 'invalid_budget_settlement' using errcode = '22023';
  end if;
  v_charge := v_total::bigint;
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

-- 1. 작업 큐 상태·실패 횟수 -------------------------------------------------------------
alter table private.worker_jobs add column failed_attempts bigint not null default 0
  constraint worker_jobs_failed_attempts_check check (failed_attempts >= 0);
do $$
declare v_name text; v_count integer := 0;
begin
  for v_name in select conname from pg_catalog.pg_constraint
    where conrelid = 'private.worker_jobs'::regclass and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ~ 'status'
      and pg_catalog.pg_get_constraintdef(oid) ~ 'queued'
  loop
    execute format('alter table private.worker_jobs drop constraint %I', v_name);
    v_count := v_count + 1;
  end loop;
  if v_count <> 1 then raise exception 'worker_status_constraint_unavailable'; end if;
end; $$;
alter table private.worker_jobs add constraint worker_jobs_status_check
  check (status in ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'superseded'));
do $$
declare v_name text; v_count integer := 0;
begin
  for v_name in select conname from pg_catalog.pg_constraint
    where conrelid = 'private.worker_jobs'::regclass and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ~ 'status'
      and pg_catalog.pg_get_constraintdef(oid) ~ 'completed_at'
  loop
    execute format('alter table private.worker_jobs drop constraint %I', v_name);
    v_count := v_count + 1;
  end loop;
  if v_count <> 1 then raise exception 'worker_completion_constraint_unavailable'; end if;
end; $$;
alter table private.worker_jobs add constraint worker_jobs_terminal_completed_at
  check ((status in ('succeeded', 'failed', 'superseded')) = (completed_at is not null));

-- 2. 비공개 중간 저장 ---------------------------------------------------------------------
-- 저장 허용 형태: {schemaVersion:1, sourceReviewIds:[uuid], nextReviewIndex:int,
--   nodes:[{sourceReviewIds:[uuid], claims:[{text, evidenceIds:[uuid]}], modelVersions:[label]}]}
-- 후기 원문 필드·작성자·임의 키를 허용하지 않는다. claims[].text는 모델이 생성한 중간 주장이다.
create function private.review_summary_checkpoint_shape_ok(p jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_label constant text := '^[A-Za-z0-9_.:/-]{1,128}$';
  v_all text[]; v_node_ids text[]; v_ids text[]; v_node jsonb; v_claim jsonb; v_value jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object'
    or not (p ?& array['schemaVersion', 'sourceReviewIds', 'nextReviewIndex', 'nodes'])
    or (p - array['schemaVersion', 'sourceReviewIds', 'nextReviewIndex', 'nodes']) <> '{}'::jsonb
    or p->'schemaVersion' <> '1'::jsonb
    or jsonb_typeof(p->'sourceReviewIds') <> 'array' or jsonb_typeof(p->'nodes') <> 'array'
    or jsonb_typeof(p->'nextReviewIndex') <> 'number' or (p->>'nextReviewIndex') !~ '^(0|[1-9][0-9]{0,8})$' then
    return false;
  end if;
  for v_value in select value from jsonb_array_elements(p->'sourceReviewIds') loop
    if jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') !~ v_uuid then return false; end if;
  end loop;
  select coalesce(array_agg(value), '{}') into v_all from jsonb_array_elements_text(p->'sourceReviewIds');
  if cardinality(v_all) <> (select count(distinct x) from unnest(v_all) x)
    or (p->>'nextReviewIndex')::bigint > cardinality(v_all) then
    return false;
  end if;
  for v_node in select value from jsonb_array_elements(p->'nodes') loop
    if jsonb_typeof(v_node) <> 'object'
      or not (v_node ?& array['sourceReviewIds', 'claims', 'modelVersions'])
      or (v_node - array['sourceReviewIds', 'claims', 'modelVersions']) <> '{}'::jsonb
      or jsonb_typeof(v_node->'sourceReviewIds') <> 'array' or jsonb_array_length(v_node->'sourceReviewIds') = 0
      or jsonb_typeof(v_node->'claims') <> 'array' or jsonb_array_length(v_node->'claims') = 0
      or jsonb_typeof(v_node->'modelVersions') <> 'array' or jsonb_array_length(v_node->'modelVersions') = 0 then
      return false;
    end if;
    for v_value in select value from jsonb_array_elements(v_node->'sourceReviewIds') loop
      if jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') !~ v_uuid then return false; end if;
    end loop;
    select array_agg(value) into v_node_ids from jsonb_array_elements_text(v_node->'sourceReviewIds');
    if cardinality(v_node_ids) <> (select count(distinct x) from unnest(v_node_ids) x) or not (v_node_ids <@ v_all) then
      return false;
    end if;
    for v_value in select value from jsonb_array_elements(v_node->'modelVersions') loop
      if jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') !~ v_label then return false; end if;
    end loop;
    for v_claim in select value from jsonb_array_elements(v_node->'claims') loop
      if jsonb_typeof(v_claim) <> 'object' or not (v_claim ?& array['text', 'evidenceIds'])
        or (v_claim - array['text', 'evidenceIds']) <> '{}'::jsonb
        or jsonb_typeof(v_claim->'text') <> 'string' or char_length(btrim(v_claim->>'text')) not between 1 and 4000
        or jsonb_typeof(v_claim->'evidenceIds') <> 'array' or jsonb_array_length(v_claim->'evidenceIds') = 0 then
        return false;
      end if;
      for v_value in select value from jsonb_array_elements(v_claim->'evidenceIds') loop
        if jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') !~ v_uuid then return false; end if;
      end loop;
      select array_agg(value) into v_ids from jsonb_array_elements_text(v_claim->'evidenceIds');
      if not (v_ids <@ v_node_ids) then return false; end if;
    end loop;
  end loop;
  return true;
end; $$;

-- job_id는 worker_jobs.id다. 작업 행은 삭제 API가 없고 기존 검사가 worker_jobs를 TRUNCATE하므로
-- FK를 두지 않는다. 쓰기는 모두 작업 행 잠금·토큰 확인 뒤 RPC에서만 수행한다.
create table private.review_summary_checkpoints (
  job_id uuid primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  source_revision bigint not null check (source_revision >= 0),
  model_version text not null check (model_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  prompt_version text not null check (prompt_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  checkpoint jsonb not null check (private.review_summary_checkpoint_shape_ok(checkpoint)),
  updated_at timestamptz not null default clock_timestamp()
);
create index review_summary_checkpoints_profile on private.review_summary_checkpoints (profile_id, source_revision);
-- (jobId, sourceRevision) 게시 표식. 원문·요약문을 복제하지 않는다.
create table private.review_summary_job_publications (
  job_id uuid not null,
  source_revision bigint not null check (source_revision >= 0),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  summary_id uuid not null references private.review_summaries(id) on delete cascade,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (job_id, source_revision)
);
alter table private.review_summary_checkpoints enable row level security;
alter table private.review_summary_job_publications enable row level security;
revoke all on private.review_summary_checkpoints, private.review_summary_job_publications
  from public, anon, authenticated, service_role;

-- 3. 원문 변경 시 이전 revision 중간 저장 삭제(기존 동작+삭제만 추가) ------------------------
create or replace function private.invalidate_appointment_review_summaries(p_appointment_ids uuid[])
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_profile_id uuid;
begin
  for v_profile_id in
    select distinct ids.id from public.appointments ap join public.posts p on p.id=ap.post_id
    join public.join_requests jr on jr.id=ap.join_request_id
    cross join lateral (values(p.author_id),(jr.requester_id)) ids(id)
    where ap.id=any(p_appointment_ids) order by ids.id
  loop
    insert into private.review_summary_state(profile_id) values(v_profile_id) on conflict do nothing;
    update private.review_summary_state set revision=revision+1,fingerprint=null,visible_summary_id=null where profile_id=v_profile_id;
    insert into private.review_refresh_outbox(profile_id) values(v_profile_id)
      on conflict(profile_id) do update set requested_at=clock_timestamp();
    -- revision이 증가했으므로 이 프로필의 기존 checkpoint는 모두 이전 revision이다.
    delete from private.review_summary_checkpoints where profile_id=v_profile_id;
  end loop;
end; $$;

create or replace function private.refresh_review_summary_state(p_profile_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_state private.review_summary_state; v_sources jsonb; v_fingerprint text;
begin
  if not exists(select 1 from public.profiles where id=p_profile_id) then
    raise exception 'profile_unavailable' using errcode='P0002';
  end if;
  insert into private.review_summary_state(profile_id) values(p_profile_id) on conflict do nothing;
  select * into v_state from private.review_summary_state where profile_id=p_profile_id for update;
  v_sources:=private.review_summary_sources(p_profile_id); v_fingerprint:=md5(v_sources::text);
  if v_state.fingerprint is distinct from v_fingerprint then
    update private.review_summary_state set revision=revision+1,fingerprint=v_fingerprint,visible_summary_id=null
      where profile_id=p_profile_id returning * into v_state;
    insert into private.review_refresh_outbox(profile_id) values(p_profile_id)
      on conflict(profile_id) do update set requested_at=clock_timestamp();
    delete from private.review_summary_checkpoints where profile_id=p_profile_id and source_revision<>v_state.revision;
  end if;
  return jsonb_build_object('profileId',p_profile_id,'sourceRevision',v_state.revision::text,
    'reviews',v_sources,'eligibleCount',jsonb_array_length(v_sources));
end; $$;

-- 4. 작업 전이 ---------------------------------------------------------------------------
-- 기존 반환 키 유지 + failedAttempts 추가. 종결 상태(failed/superseded)는 점유하지 않는다.
create or replace function public.claim_job(p_worker_id uuid, p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_job private.worker_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_worker_id is null or p_lease_seconds is null or p_lease_seconds not between 1 and 86400 then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  select * into v_job from private.worker_jobs
    where (status in ('queued', 'retry_wait') and available_at <= v_now)
       or (status = 'running' and lease_expires_at <= v_now)
    order by case when status = 'running' then lease_expires_at else available_at end, id
    for update skip locked limit 1;
  if not found then return jsonb_build_object('job', null); end if;
  v_now := clock_timestamp();
  update private.worker_jobs set status = 'running', worker_id = p_worker_id,
    lease_token = pg_catalog.gen_random_uuid(), lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
    attempt = attempt + 1, updated_at = v_now
    where id = v_job.id returning * into v_job;
  return jsonb_build_object('job', jsonb_build_object('jobId', v_job.id, 'kind', v_job.kind,
    'payload', v_job.payload, 'leaseToken', v_job.lease_token, 'leaseExpiresAt', v_job.lease_expires_at,
    'attempt', v_job.attempt, 'failedAttempts', v_job.failed_attempts));
end;
$$;

-- 현재 점유자 확인 공통부. 실패 시 state_conflict(P0001)로 기존 complete/retry와 같은 계약을 쓴다.
create function private.lock_running_job(p_job_id uuid, p_lease_token uuid)
returns private.worker_jobs language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare v_job private.worker_jobs%rowtype; v_now timestamptz;
begin
  select * into v_job from private.worker_jobs where id = p_job_id for update;
  v_now := clock_timestamp();
  if not found or v_job.status <> 'running' or p_lease_token is null
    or v_job.lease_token is distinct from p_lease_token or v_job.lease_expires_at <= v_now then
    raise exception using errcode = 'P0001', message = 'state_conflict';
  end if;
  return v_job;
end; $$;

create or replace function public.complete_job(p_job_id uuid, p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_job private.worker_jobs%rowtype; v_now timestamptz;
begin
  v_job := private.lock_running_job(p_job_id, p_lease_token);
  v_now := clock_timestamp();
  update private.worker_jobs set status = 'succeeded', worker_id = null, lease_token = null,
    lease_expires_at = null, completed_at = v_now, updated_at = v_now where id = v_job.id;
  delete from private.review_summary_checkpoints where job_id = v_job.id;
  return jsonb_build_object('jobId', v_job.id, 'status', 'succeeded');
end;
$$;

-- 실제 실패 재시도: failed_attempts 증가. 중간 저장은 재개를 위해 보존한다.
create or replace function public.retry_job(p_job_id uuid, p_lease_token uuid, p_available_at timestamptz, p_error_code text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_job private.worker_jobs%rowtype; v_now timestamptz;
begin
  if p_available_at is null or not isfinite(p_available_at) or p_error_code is null
    or p_error_code not in ('UPSTREAM_UNAVAILABLE', 'RATE_LIMITED', 'TIMEOUT', 'STATE_CHANGED', 'INTERNAL_ERROR') then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  v_job := private.lock_running_job(p_job_id, p_lease_token);
  v_now := clock_timestamp();
  if p_available_at < v_now then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  update private.worker_jobs set status = 'retry_wait', worker_id = null, lease_token = null,
    lease_expires_at = null, available_at = p_available_at, last_error_code = p_error_code,
    failed_attempts = failed_attempts + 1, updated_at = v_now where id = v_job.id;
  return jsonb_build_object('jobId', v_job.id, 'status', 'retry_wait');
end;
$$;

-- 정상 분할 양보·한도 소진 연기: 실패 횟수를 늘리지 않고 중간 저장을 보존한다.
-- p_available_at null이면 DB 현재 시각. 지정 시 DB 현재 시각 이상이어야 한다.
create function public.yield_job(p_job_id uuid, p_lease_token uuid, p_available_at timestamptz)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_job private.worker_jobs%rowtype; v_now timestamptz;
begin
  if p_available_at is not null and not isfinite(p_available_at) then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  v_job := private.lock_running_job(p_job_id, p_lease_token);
  v_now := clock_timestamp();
  if p_available_at is not null and p_available_at < v_now then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  update private.worker_jobs set status = 'queued', worker_id = null, lease_token = null,
    lease_expires_at = null, available_at = coalesce(p_available_at, v_now), updated_at = v_now
    where id = v_job.id;
  return jsonb_build_object('jobId', v_job.id, 'status', 'queued');
end;
$$;

-- 실패 종결: 실패 횟수 증가 + 종결 시각 + 중간 저장 삭제를 한 번에.
create function public.fail_job(p_job_id uuid, p_lease_token uuid, p_error_code text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_job private.worker_jobs%rowtype; v_now timestamptz;
begin
  if p_error_code is null
    or p_error_code not in ('UPSTREAM_UNAVAILABLE', 'RATE_LIMITED', 'TIMEOUT', 'STATE_CHANGED', 'INTERNAL_ERROR') then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  v_job := private.lock_running_job(p_job_id, p_lease_token);
  v_now := clock_timestamp();
  update private.worker_jobs set status = 'failed', worker_id = null, lease_token = null,
    lease_expires_at = null, last_error_code = p_error_code, failed_attempts = failed_attempts + 1,
    completed_at = v_now, updated_at = v_now where id = v_job.id;
  delete from private.review_summary_checkpoints where job_id = v_job.id;
  return jsonb_build_object('jobId', v_job.id, 'status', 'failed');
end;
$$;

-- 새 revision 등에 의한 대체 종결: 실패로 세지 않는다.
create function public.supersede_job(p_job_id uuid, p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_job private.worker_jobs%rowtype; v_now timestamptz;
begin
  v_job := private.lock_running_job(p_job_id, p_lease_token);
  v_now := clock_timestamp();
  update private.worker_jobs set status = 'superseded', worker_id = null, lease_token = null,
    lease_expires_at = null, completed_at = v_now, updated_at = v_now where id = v_job.id;
  delete from private.review_summary_checkpoints where job_id = v_job.id;
  return jsonb_build_object('jobId', v_job.id, 'status', 'superseded');
end;
$$;

-- 5. 요약 작업 RPC. 점유 손실·revision 불일치 등 예상 상태는 status 값으로 반환한다. -------------
-- 현재 요약 작업 점유자 확인. 없으면 null(id is null).
create function private.summary_job_for_lease(p_job_id uuid, p_lease_token uuid)
returns private.worker_jobs language plpgsql volatile security definer set search_path = '' as $$
declare v_job private.worker_jobs; v_now timestamptz; v_profile_id uuid;
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'invalid_summary_job' using errcode = '22023';
  end if;
  -- 작업 행을 먼저 잠그면 process_review_summary_refresh의 잠금 순서와 역전된다.
  select * into v_job from private.worker_jobs where id = p_job_id;
  if not found or v_job.kind <> 'review_summary' or v_job.status <> 'running'
    or v_job.lease_token is distinct from p_lease_token or v_job.lease_expires_at <= clock_timestamp() then
    return null;
  end if;
  v_profile_id := (v_job.payload->>'profileId')::uuid;
  insert into private.review_summary_state(profile_id)
    select id from public.profiles where id = v_profile_id on conflict do nothing;
  perform 1 from private.review_summary_state where profile_id = v_profile_id for update;
  select * into v_job from private.worker_jobs where id = p_job_id for update;
  v_now := clock_timestamp();
  if not found or v_job.kind <> 'review_summary' or v_job.status <> 'running'
    or v_job.lease_token is distinct from p_lease_token or v_job.lease_expires_at <= v_now
    or (v_job.payload->>'profileId')::uuid is distinct from v_profile_id then
    return null;
  end if;
  return v_job;
end; $$;

-- 호출자가 작업 payload와 다른 revision을 주장하면 입력 오류다.
create function private.require_job_revision(p_job private.worker_jobs, p_source_revision text)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_source_revision is null or p_source_revision !~ '^(0|[1-9][0-9]{0,18})$'
    or p_source_revision <> p_job.payload->>'sourceRevision' then
    raise exception 'invalid_summary_revision' using errcode = '22023';
  end if;
  if p_source_revision::numeric > 9223372036854775807::numeric then
    raise exception 'invalid_summary_revision' using errcode = '22023';
  end if;
end; $$;

-- 현재 공개 snapshot. 프로필이 사라졌으면 null(대체 대상).
create function private.summary_job_snapshot(p_job private.worker_jobs)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.profiles where id = (p_job.payload->>'profileId')::uuid) then return null; end if;
  return private.refresh_review_summary_state((p_job.payload->>'profileId')::uuid);
end; $$;

create function public.load_review_summary_source(p_job_id uuid, p_lease_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_job private.worker_jobs; v_snapshot jsonb;
begin
  v_job := private.summary_job_for_lease(p_job_id, p_lease_token);
  if v_job.id is null then return jsonb_build_object('status', 'lease_lost'); end if;
  v_snapshot := private.summary_job_snapshot(v_job);
  if v_snapshot is null then return jsonb_build_object('status', 'stale_revision'); end if;
  -- 게시 후 settle 전에 중단된 같은 작업·revision은 모델을 다시 호출하지 않고 완료 처리하게 한다.
  if v_snapshot->>'sourceRevision' = v_job.payload->>'sourceRevision' and exists(
      select 1 from private.review_summary_job_publications
      where job_id = v_job.id and source_revision = (v_job.payload->>'sourceRevision')::bigint) then
    return jsonb_build_object('status', 'already_published');
  end if;
  return jsonb_build_object('status', 'applied') || v_snapshot;
end; $$;

create function public.load_review_summary_checkpoint(p_job_id uuid, p_lease_token uuid, p_source_revision text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_job private.worker_jobs; v_snapshot jsonb; v_row private.review_summary_checkpoints;
begin
  v_job := private.summary_job_for_lease(p_job_id, p_lease_token);
  if v_job.id is null then return jsonb_build_object('status', 'lease_lost'); end if;
  perform private.require_job_revision(v_job, p_source_revision);
  v_snapshot := private.summary_job_snapshot(v_job);
  if v_snapshot is null or v_snapshot->>'sourceRevision' <> p_source_revision then
    return jsonb_build_object('status', 'stale_revision');
  end if;
  select * into v_row from private.review_summary_checkpoints where job_id = v_job.id;
  if not found then return jsonb_build_object('status', 'applied', 'checkpoint', null); end if;
  return jsonb_build_object('status', 'applied', 'checkpoint', jsonb_build_object(
    'profileId', v_row.profile_id, 'sourceRevision', v_row.source_revision::text,
    'modelVersion', v_row.model_version, 'promptVersion', v_row.prompt_version) || v_row.checkpoint);
end; $$;

create function public.save_review_summary_checkpoint(p_job_id uuid, p_lease_token uuid, p_source_revision text, p_checkpoint jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_job private.worker_jobs; v_snapshot jsonb; v_ids text[]; v_given text[];
begin
  if not private.review_summary_checkpoint_shape_ok(p_checkpoint) then
    raise exception 'invalid_summary_checkpoint' using errcode = '22023';
  end if;
  v_job := private.summary_job_for_lease(p_job_id, p_lease_token);
  if v_job.id is null then return jsonb_build_object('status', 'lease_lost'); end if;
  perform private.require_job_revision(v_job, p_source_revision);
  v_snapshot := private.summary_job_snapshot(v_job);
  if v_snapshot is null or v_snapshot->>'sourceRevision' <> p_source_revision then
    return jsonb_build_object('status', 'stale_revision');
  end if;
  if (v_snapshot->>'eligibleCount')::integer < 3 then return jsonb_build_object('status', 'insufficient_reviews'); end if;
  select coalesce(array_agg(x->>'reviewId'), '{}') into v_ids from jsonb_array_elements(v_snapshot->'reviews') x;
  select coalesce(array_agg(value), '{}') into v_given from jsonb_array_elements_text(p_checkpoint->'sourceReviewIds');
  -- 전체 근거 집합이 현재 공개 집합과 정확히 같아야 한다(형태 검사가 하위 근거 ⊆ 전체를 보장).
  if cardinality(v_given) <> cardinality(v_ids) or not (v_given @> v_ids and v_given <@ v_ids) then
    return jsonb_build_object('status', 'invalid_evidence');
  end if;
  -- 후기 원문을 그대로 복제한 주장은 저장하지 않는다(가능한 범위의 DB 검사; 의역 탐지는 아님).
  if exists(select 1 from jsonb_array_elements(p_checkpoint->'nodes') n
      cross join lateral jsonb_array_elements(n->'claims') c
      join jsonb_array_elements(v_snapshot->'reviews') r on btrim(r->>'text') = btrim(c->>'text')) then
    return jsonb_build_object('status', 'invalid_evidence');
  end if;
  if v_job.lease_expires_at <= clock_timestamp() then return jsonb_build_object('status', 'lease_lost'); end if;
  insert into private.review_summary_checkpoints(job_id, profile_id, source_revision, model_version, prompt_version, checkpoint)
    values (v_job.id, (v_job.payload->>'profileId')::uuid, p_source_revision::bigint,
      v_job.payload->>'modelVersion', v_job.payload->>'promptVersion', p_checkpoint)
    on conflict (job_id) do update set checkpoint = excluded.checkpoint, updated_at = clock_timestamp();
  return jsonb_build_object('status', 'applied');
end; $$;

create function public.discard_review_summary_checkpoint(p_job_id uuid, p_lease_token uuid, p_source_revision text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_job private.worker_jobs;
begin
  v_job := private.summary_job_for_lease(p_job_id, p_lease_token);
  if v_job.id is null then return jsonb_build_object('status', 'lease_lost'); end if;
  perform private.require_job_revision(v_job, p_source_revision);
  -- 자기 작업의 행만 삭제한다. 다른(새 revision) 작업의 중간 저장에는 영향이 없다.
  delete from private.review_summary_checkpoints where job_id = v_job.id;
  return jsonb_build_object('status', 'applied');
end; $$;

create function public.mark_review_summary_insufficient(p_job_id uuid, p_lease_token uuid, p_source_revision text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_job private.worker_jobs; v_snapshot jsonb;
begin
  v_job := private.summary_job_for_lease(p_job_id, p_lease_token);
  if v_job.id is null then return jsonb_build_object('status', 'lease_lost'); end if;
  perform private.require_job_revision(v_job, p_source_revision);
  v_snapshot := private.summary_job_snapshot(v_job);
  if v_snapshot is null or v_snapshot->>'sourceRevision' <> p_source_revision then
    return jsonb_build_object('status', 'stale_revision');
  end if;
  -- DB가 실제 적격 집합을 다시 센다. 3개 이상이면 호출자 판단과 모순이다.
  if (v_snapshot->>'eligibleCount')::integer >= 3 then return jsonb_build_object('status', 'invalid_evidence'); end if;
  update private.review_summary_state set visible_summary_id = null where profile_id = (v_job.payload->>'profileId')::uuid;
  delete from private.review_summary_checkpoints where job_id = v_job.id;
  return jsonb_build_object('status', 'applied');
end; $$;

-- 한 트랜잭션: 투영 상태 → 작업 행 잠금 → 토큰·DB 시각 → revision·근거 → 요약(멱등) → 표시·삭제·표식.
create function public.publish_review_summary_for_job(p_job_id uuid, p_lease_token uuid, p_source_revision text,
  p_evidence_review_ids uuid[], p_summary text, p_model_version text, p_prompt_version text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_job private.worker_jobs; v_snapshot jsonb; v_ids uuid[]; v_summary private.review_summaries;
  v_marker private.review_summary_job_publications;
begin
  if p_source_revision is null or p_source_revision !~ '^(0|[1-9][0-9]{0,18})$'
    or p_summary is null or char_length(btrim(p_summary)) not between 1 and 4000
    or p_model_version is null or p_model_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    or p_prompt_version is null or p_prompt_version !~ '^[A-Za-z0-9_.-]{1,64}$' then
    raise exception 'invalid_summary_input' using errcode = '22023';
  end if;
  v_job := private.summary_job_for_lease(p_job_id, p_lease_token);
  if v_job.id is null then return jsonb_build_object('status', 'lease_lost'); end if;
  perform private.require_job_revision(v_job, p_source_revision);
  if p_model_version <> v_job.payload->>'modelVersion' or p_prompt_version <> v_job.payload->>'promptVersion' then
    raise exception 'invalid_summary_version' using errcode = '22023';
  end if;
  v_snapshot := private.summary_job_snapshot(v_job);
  if v_snapshot is null or v_snapshot->>'sourceRevision' <> p_source_revision then
    return jsonb_build_object('status', 'stale_revision');
  end if;
  select coalesce(array_agg((x->>'reviewId')::uuid order by (x->>'reviewId')::uuid), '{}') into v_ids
    from jsonb_array_elements(v_snapshot->'reviews') x;
  if cardinality(v_ids) < 3 then return jsonb_build_object('status', 'insufficient_reviews'); end if;
  if p_evidence_review_ids is null or array_position(p_evidence_review_ids, null) is not null
    or cardinality(p_evidence_review_ids) <> (select count(distinct x) from unnest(p_evidence_review_ids) x)
    or cardinality(p_evidence_review_ids) <> cardinality(v_ids)
    or not (p_evidence_review_ids @> v_ids and p_evidence_review_ids <@ v_ids) then
    return jsonb_build_object('status', 'invalid_evidence');
  end if;
  select * into v_marker from private.review_summary_job_publications
    where job_id = v_job.id and source_revision = p_source_revision::bigint;
  if v_job.lease_expires_at <= clock_timestamp() then return jsonb_build_object('status', 'lease_lost'); end if;
  if found then
    -- 이미 같은 트랜잭션으로 게시·표시·삭제가 끝났다. 시각·표시·요약을 다시 쓰지 않는다.
    select * into strict v_summary from private.review_summaries where id = v_marker.summary_id;
    delete from private.review_summary_checkpoints where job_id = v_job.id;
    return jsonb_build_object('status', 'applied', 'summaryId', v_summary.id, 'sourceRevision', v_summary.source_revision::text,
      'sourceCount', cardinality(v_summary.evidence_review_ids), 'publishedAt', v_summary.published_at);
  end if;
  insert into private.review_summaries(profile_id, source_revision, evidence_review_ids, summary_text, model_version, prompt_version)
    values ((v_job.payload->>'profileId')::uuid, p_source_revision::bigint, v_ids, btrim(p_summary), p_model_version, p_prompt_version)
    on conflict (profile_id, source_revision, model_version, prompt_version) do nothing;
  select * into strict v_summary from private.review_summaries where profile_id = (v_job.payload->>'profileId')::uuid
    and source_revision = p_source_revision::bigint and model_version = p_model_version and prompt_version = p_prompt_version;
  update private.review_summary_state set visible_summary_id = v_summary.id where profile_id = v_summary.profile_id;
  delete from private.review_summary_checkpoints where job_id = v_job.id;
  insert into private.review_summary_job_publications(job_id, source_revision, profile_id, summary_id)
    values (v_job.id, p_source_revision::bigint, v_summary.profile_id, v_summary.id);
  return jsonb_build_object('status', 'applied', 'summaryId', v_summary.id, 'sourceRevision', v_summary.source_revision::text,
    'sourceCount', cardinality(v_ids), 'publishedAt', v_summary.published_at);
end; $$;

-- 6. 권한: 내부 서버(service_role)만. 보조 함수는 직접 실행 불가. ----------------------------
revoke all on function private.review_summary_checkpoint_shape_ok(jsonb), private.lock_running_job(uuid, uuid),
  private.summary_job_for_lease(uuid, uuid), private.require_job_revision(private.worker_jobs, text),
  private.summary_job_snapshot(private.worker_jobs)
  from public, anon, authenticated, service_role;
revoke all on function public.yield_job(uuid, uuid, timestamptz), public.fail_job(uuid, uuid, text),
  public.supersede_job(uuid, uuid), public.load_review_summary_source(uuid, uuid),
  public.load_review_summary_checkpoint(uuid, uuid, text), public.save_review_summary_checkpoint(uuid, uuid, text, jsonb),
  public.discard_review_summary_checkpoint(uuid, uuid, text), public.mark_review_summary_insufficient(uuid, uuid, text),
  public.publish_review_summary_for_job(uuid, uuid, text, uuid[], text, text, text)
  from public, anon, authenticated, service_role;
-- create or replace는 기존 ACL을 유지하지만 채택 시 명시적으로 다시 확인한다.
revoke all on function public.claim_job(uuid, integer), public.complete_job(uuid, uuid),
  public.retry_job(uuid, uuid, timestamptz, text) from public, anon, authenticated, service_role;
grant execute on function public.claim_job(uuid, integer), public.complete_job(uuid, uuid),
  public.retry_job(uuid, uuid, timestamptz, text), public.yield_job(uuid, uuid, timestamptz),
  public.fail_job(uuid, uuid, text), public.supersede_job(uuid, uuid),
  public.load_review_summary_source(uuid, uuid), public.load_review_summary_checkpoint(uuid, uuid, text),
  public.save_review_summary_checkpoint(uuid, uuid, text, jsonb), public.discard_review_summary_checkpoint(uuid, uuid, text),
  public.mark_review_summary_insufficient(uuid, uuid, text),
  public.publish_review_summary_for_job(uuid, uuid, text, uuid[], text, text, text)
  to service_role;

commit;
