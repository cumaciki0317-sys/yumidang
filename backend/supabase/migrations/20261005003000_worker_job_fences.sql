-- 민규: 전역 워커 점유와 개별 작업 점유를 묶는다. 원문·자동 연장·임의 모델 허용은 추가하지 않는다.
begin;

-- 기존 checkpoint와 동일하게 job FK를 두지 않는다. 운영 TRUNCATE는 제공하지 않는다.
-- 완료/재시도/양보/실패/대체 전이 시 지우고 재점유 시 현재 job lease로 교체한다.
create table private.worker_job_run_fences (
  job_id uuid primary key,
  job_lease_token uuid not null,
  worker_run_token uuid not null
);
alter table private.worker_job_run_fences enable row level security;
revoke all on private.worker_job_run_fences from public,anon,authenticated,service_role;

-- 반드시 다른 워커 관련 행보다 먼저 호출한다. 잠금은 호출 트랜잭션이 끝날 때까지 유지한다.
-- 기다린 후 DB 시각을 사용하며 기존 토큰 검증으로 만료 시각을 늘리지 않는다.
create function private.assert_current_worker_run(p_worker_run_token uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare v_run private.global_worker_run; v_now timestamptz;
begin
  select * into strict v_run from private.global_worker_run where singleton for update;
  v_now:=clock_timestamp();
  if p_worker_run_token is null or v_run.token is distinct from p_worker_run_token
    or v_run.expires_at is null or v_run.expires_at<=v_now then
    raise exception 'state_conflict' using errcode='40001';
  end if;
end; $$;

-- 이 검사는 전역 잠금과 정확한 claim 매핑을 확인한다. 개별 job 행 잠금은 호출자가 기존
-- projection→job→checkpoint 순서로 수행한다. 기존 terminal 함수는 job 잠금 뒤 다시 lease를 검사한다.
create function private.assert_current_worker_job(p_job_id uuid,p_lease_token uuid,p_worker_run_token uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare v_job private.worker_jobs; v_fence private.worker_job_run_fences; v_now timestamptz;
begin
  perform private.assert_current_worker_run(p_worker_run_token);
  select * into v_fence from private.worker_job_run_fences where job_id=p_job_id;
  if not found or p_lease_token is null or v_fence.job_lease_token is distinct from p_lease_token
    or v_fence.worker_run_token is distinct from p_worker_run_token then
    raise exception 'state_conflict' using errcode='40001';
  end if;
  select * into v_job from private.worker_jobs where id=p_job_id;
  v_now:=clock_timestamp();
  if not found or v_job.status<>'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at is null or v_job.lease_expires_at<=v_now then
    raise exception 'state_conflict' using errcode='40001';
  end if;
end; $$;
revoke all on function private.assert_current_worker_run(uuid),private.assert_current_worker_job(uuid,uuid,uuid)
 from public,anon,authenticated,service_role;

create function public.claim_job(p_worker_id uuid,p_lease_seconds integer,p_worker_run_token uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb; v_job_id uuid; v_job_token uuid;
begin
  perform private.assert_current_worker_run(p_worker_run_token);
  v_result:=public.claim_job(p_worker_id,p_lease_seconds);
  -- 개별 행 잠금 대기/트리거 실행 중 전역 lease가 만료됐다면 claim 전체를 rollback한다.
  perform private.assert_current_worker_run(p_worker_run_token);
  if v_result->'job'<>'null'::jsonb then
    v_job_id:=(v_result->'job'->>'jobId')::uuid;
    v_job_token:=(v_result->'job'->>'leaseToken')::uuid;
    insert into private.worker_job_run_fences(job_id,job_lease_token,worker_run_token)
      values(v_job_id,v_job_token,p_worker_run_token)
      on conflict(job_id) do update set job_lease_token=excluded.job_lease_token,worker_run_token=excluded.worker_run_token;
  end if;
  return v_result;
end; $$;

create function public.complete_job(p_job_id uuid,p_lease_token uuid,p_worker_run_token uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform private.assert_current_worker_job(p_job_id,p_lease_token,p_worker_run_token);
  v_result:=public.complete_job(p_job_id,p_lease_token);
  perform private.assert_current_worker_run(p_worker_run_token);
  delete from private.worker_job_run_fences where job_id=p_job_id;
  return v_result;
end; $$;

create function public.retry_job(p_job_id uuid,p_lease_token uuid,p_available_at timestamptz,p_error_code text,p_worker_run_token uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform private.assert_current_worker_job(p_job_id,p_lease_token,p_worker_run_token);
  v_result:=public.retry_job(p_job_id,p_lease_token,p_available_at,p_error_code);
  perform private.assert_current_worker_run(p_worker_run_token);
  delete from private.worker_job_run_fences where job_id=p_job_id;
  return v_result;
end; $$;

create function public.yield_job(p_job_id uuid,p_lease_token uuid,p_available_at timestamptz,p_worker_run_token uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform private.assert_current_worker_job(p_job_id,p_lease_token,p_worker_run_token);
  v_result:=public.yield_job(p_job_id,p_lease_token,p_available_at);
  perform private.assert_current_worker_run(p_worker_run_token);
  delete from private.worker_job_run_fences where job_id=p_job_id;
  return v_result;
end; $$;

create function public.fail_job(p_job_id uuid,p_lease_token uuid,p_error_code text,p_worker_run_token uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform private.assert_current_worker_job(p_job_id,p_lease_token,p_worker_run_token);
  v_result:=public.fail_job(p_job_id,p_lease_token,p_error_code);
  perform private.assert_current_worker_run(p_worker_run_token);
  delete from private.worker_job_run_fences where job_id=p_job_id;
  return v_result;
end; $$;

create function public.supersede_job(p_job_id uuid,p_lease_token uuid,p_worker_run_token uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform private.assert_current_worker_job(p_job_id,p_lease_token,p_worker_run_token);
  v_result:=public.supersede_job(p_job_id,p_lease_token);
  perform private.assert_current_worker_run(p_worker_run_token);
  delete from private.worker_job_run_fences where job_id=p_job_id;
  return v_result;
end; $$;

-- 기존 구현은 owner wrapper가 재사용한다. service_role 직접 호출은 fence 우회이므로 회수한다.
revoke all on function public.claim_job(uuid,integer),public.complete_job(uuid,uuid),
 public.retry_job(uuid,uuid,timestamptz,text),public.yield_job(uuid,uuid,timestamptz),
 public.fail_job(uuid,uuid,text),public.supersede_job(uuid,uuid)
 from public,anon,authenticated,service_role;
revoke all on function public.claim_job(uuid,integer,uuid),public.complete_job(uuid,uuid,uuid),
 public.retry_job(uuid,uuid,timestamptz,text,uuid),public.yield_job(uuid,uuid,timestamptz,uuid),
 public.fail_job(uuid,uuid,text,uuid),public.supersede_job(uuid,uuid,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.claim_job(uuid,integer,uuid),public.complete_job(uuid,uuid,uuid),
 public.retry_job(uuid,uuid,timestamptz,text,uuid),public.yield_job(uuid,uuid,timestamptz,uuid),
 public.fail_job(uuid,uuid,text,uuid),public.supersede_job(uuid,uuid,uuid)
 to service_role;
comment on table private.worker_job_run_fences is
 '원문 없는 job UUID/개별 점유 UUID/전역 점유 UUID 매핑. 전이 후 삭제, 만료 재점유 시 교체. 자동 연장 없음.';
commit;
