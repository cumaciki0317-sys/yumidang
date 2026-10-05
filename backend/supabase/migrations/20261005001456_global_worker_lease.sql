-- 민규: 일일 즉시 워커와 큐 실행기가 공유하는 단일 점유. 자동 연장·원문 보관 없음.
begin;

create table private.global_worker_run (
  singleton boolean primary key default true check (singleton),
  token uuid,
  expires_at timestamptz,
  check ((token is null and expires_at is null) or
    (token is not null and expires_at is not null and isfinite(expires_at)))
);
insert into private.global_worker_run(singleton) values (true);
alter table private.global_worker_run enable row level security;
revoke all on private.global_worker_run from public, anon, authenticated, service_role;

-- 신규 점유는 직렬화한다. 기존 토큰 전달은 동일 점유 검증만 하며 만료 시각을 바꾸지 않는다.
create function public.acquire_worker_run(p_lease_seconds integer, p_existing_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_run private.global_worker_run; v_now timestamptz; v_token uuid; v_expires timestamptz;
begin
  if p_lease_seconds is null or p_lease_seconds not between 1 and 86400 then
    raise exception 'invalid_worker_lease' using errcode = '22023';
  end if;
  select * into strict v_run from private.global_worker_run where singleton for update;
  v_now := clock_timestamp();
  if p_existing_token is not null then
    if v_run.token is distinct from p_existing_token or v_run.expires_at is null or v_run.expires_at <= v_now then
      return null;
    end if;
    return jsonb_build_object('token', v_run.token, 'expiresAt', v_run.expires_at);
  end if;
  if v_run.token is not null and v_run.expires_at > v_now then return null; end if;
  v_token := gen_random_uuid();
  v_expires := v_now + make_interval(secs => p_lease_seconds);
  update private.global_worker_run set token = v_token, expires_at = v_expires where singleton;
  return jsonb_build_object('token', v_token, 'expiresAt', v_expires);
end; $$;

create function public.release_worker_run(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_run private.global_worker_run; v_now timestamptz;
begin
  select * into strict v_run from private.global_worker_run where singleton for update;
  v_now := clock_timestamp();
  if p_token is null or v_run.token is distinct from p_token or v_run.expires_at is null or v_run.expires_at <= v_now then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  update private.global_worker_run set token = null, expires_at = null where singleton;
  return jsonb_build_object('status', 'applied');
end; $$;

revoke all on function public.acquire_worker_run(integer,uuid), public.release_worker_run(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.acquire_worker_run(integer,uuid), public.release_worker_run(uuid) to service_role;

commit;
