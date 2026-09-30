-- 종현 제안 SQL 03(민규 채택 필요). 정식 마이그레이션이 아니며 채택 시 BEGIN/COMMIT으로 감싼다.
-- 전제: 정식 마이그레이션 28개(20260929120000 포함) 적용 상태. 01_ai_budget.sql과 독립이며 함께 적용할 수 있다.
-- 목적(설계 5.5·5.6):
--   1) 작업 큐: 점유 횟수(attempt)와 실제 실패 횟수(failed_attempts) 분리, 종결 상태 failed/superseded,
--      정상 양보 yield_job(실패 미증가), 실패 종결 fail_job, 새 revision 대체 supersede_job.
--   2) 원문 없는 비공개 중간 저장(checkpoint)과 점유 토큰·DB 시각·revision·근거 전체집합을 확인하는 요약 RPC.
--   3) 게시+중간 저장 삭제+(jobId, sourceRevision) 게시 표식을 한 트랜잭션으로 처리해 settle 전 중단 뒤 재실행을 멱등화.
--   4) 공개 원문 변경(revision 증가) 트랜잭션에서 이전 revision 중간 저장 삭제. 기존 outbox 동작은 그대로 보존.
-- 운영 수치(lease·재시도·지연·동시성·실행당 한도)는 이 SQL에 두지 않는다. 호출자가 명시 설정으로 전달한다.
-- 방치된 중간 저장의 운영 보관기간(TTL)은 팀 검토 중이라 자동 삭제를 만들지 않는다.
-- 게시·폐기·revision 변경·실패 종결·대체 종결·성공 완료 때의 삭제는 아래 RPC가 보장한다.
-- 요약 RPC 잠금 순서: 투영 상태 행(review_summary_state) → 작업 행(worker_jobs) → checkpoint/표식.
-- 재등록의 projection → enqueue_job 순서와 일치한다. 작업 조회는 잠금 없이 식별만 하고,
-- 두 잠금을 획득한 뒤 현재 토큰·만료·프로필을 다시 검사한다.
--   원문 변경 경로는 작업 행을 잠그지 않는다(약속 → 투영 상태 → outbox → checkpoint).

-- 1. 작업 큐 상태·실패 횟수 -------------------------------------------------------------
alter table private.worker_jobs add column failed_attempts bigint not null default 0
  constraint worker_jobs_failed_attempts_check check (failed_attempts >= 0);
alter table private.worker_jobs drop constraint worker_jobs_status_check;
alter table private.worker_jobs add constraint worker_jobs_status_check
  check (status in ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'superseded'));
-- 기존 이름 worker_jobs_check1: (status = 'succeeded') = (completed_at is not null)
alter table private.worker_jobs drop constraint worker_jobs_check1;
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
  from public, anon, authenticated;
-- create or replace는 기존 ACL을 유지하지만 채택 시 명시적으로 다시 확인한다.
revoke all on function public.claim_job(uuid, integer), public.complete_job(uuid, uuid),
  public.retry_job(uuid, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.claim_job(uuid, integer), public.complete_job(uuid, uuid),
  public.retry_job(uuid, uuid, timestamptz, text), public.yield_job(uuid, uuid, timestamptz),
  public.fail_job(uuid, uuid, text), public.supersede_job(uuid, uuid),
  public.load_review_summary_source(uuid, uuid), public.load_review_summary_checkpoint(uuid, uuid, text),
  public.save_review_summary_checkpoint(uuid, uuid, text, jsonb), public.discard_review_summary_checkpoint(uuid, uuid, text),
  public.mark_review_summary_insufficient(uuid, uuid, text),
  public.publish_review_summary_for_job(uuid, uuid, text, uuid[], text, text, text)
  to service_role;
