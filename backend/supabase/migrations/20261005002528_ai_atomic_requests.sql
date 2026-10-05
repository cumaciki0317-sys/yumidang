-- 회원 AI 점유·첫 모델 차감·예산 예약. 원문/프롬프트/응답은 저장하지 않는다.
-- 가입 필수화와 법적 승인은 구현하지 않는다. 운영 외부 전송은 기본 차단한다.
-- 탐색 점유 180초는 자동 연장 없는 기술 값이며 운영 승인 증거가 아니다.
begin;
create table private.ai_processing_guard (
  singleton boolean primary key check(singleton), external_processing_allowed boolean not null default false
);
insert into private.ai_processing_guard values(true,false);
create table private.ai_member_processing (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  exploration_allowed boolean not null default false, summary_allowed boolean not null default false,
  exploration_withdrawn_at timestamptz, summary_withdrawn_at timestamptz,
  active_request_id uuid
);
create table private.ai_chat_requests (
  request_id uuid primary key, user_id uuid not null references public.profiles(id) on delete cascade,
  client_request_hash text not null check(client_request_hash ~ '^[0-9a-f]{64}$'),
  lease_token uuid not null, expires_at timestamptz not null check(isfinite(expires_at)),
  outcome text check(outcome in('finished','output_privacy')), finished_at timestamptz,
  output_retry_of uuid references private.ai_chat_requests(request_id), retry_request_id uuid,
  counted_day date, started_at timestamptz,
  unique(user_id,client_request_hash), check((outcome is null)=(finished_at is null)),
  check((counted_day is null)=(started_at is null))
);
create table private.ai_member_daily_usage (
  user_id uuid not null references public.profiles(id) on delete cascade, kst_day date not null,
  started_requests integer not null default 0 check(started_requests between 0 and 20),
  primary key(user_id,kst_day)
);
alter table private.ai_processing_guard enable row level security;
alter table private.ai_member_processing enable row level security;
alter table private.ai_chat_requests enable row level security;
alter table private.ai_member_daily_usage enable row level security;
revoke all on private.ai_processing_guard,private.ai_member_processing,private.ai_chat_requests,private.ai_member_daily_usage
  from public,anon,authenticated,service_role;

create function public.acquire_ai_chat_request(p_user_id uuid,p_request_id uuid,p_client_request_id text,p_output_retry_of uuid,p_contract_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare m private.ai_member_processing;r private.ai_chat_requests;prior private.ai_chat_requests;v_now timestamptz;v_day date;v_token uuid;
begin
  if p_user_id is null or p_request_id is null or p_client_request_id is null or char_length(p_client_request_id) not between 1 and 128
    or p_contract_version is distinct from '2026-10-05' then raise exception 'invalid_ai_request' using errcode='22023';end if;
  if not exists(select 1 from public.profiles where id=p_user_id) then return jsonb_build_object('status','consent_revoked');end if;
  insert into private.ai_member_processing(user_id) values(p_user_id) on conflict do nothing;
  select * into m from private.ai_member_processing where user_id=p_user_id for update;
  if not m.exploration_allowed then return jsonb_build_object('status','consent_revoked');end if;
  v_now:=clock_timestamp();v_day:=(v_now at time zone 'Asia/Seoul')::date;
  select * into r from private.ai_chat_requests where request_id=p_request_id;
  if found then
    if r.user_id<>p_user_id or r.client_request_hash<>encode(sha256(convert_to(p_client_request_id,'UTF8')),'hex') or r.output_retry_of is distinct from p_output_retry_of then
      raise exception 'ai_request_conflict' using errcode='23505';end if;
    if r.outcome is null and r.expires_at>v_now and m.active_request_id=r.request_id then
      return jsonb_build_object('status','acquired','leaseToken',r.lease_token,'expiresAt',r.expires_at);end if;
    raise exception 'ai_request_closed' using errcode='23505';
  end if;
  if exists(select 1 from private.ai_chat_requests where user_id=p_user_id and client_request_hash=encode(sha256(convert_to(p_client_request_id,'UTF8')),'hex')) then
    raise exception 'ai_request_conflict' using errcode='23505';end if;
  if exists(select 1 from private.ai_chat_requests where request_id=m.active_request_id and outcome is null and expires_at>v_now) then
    return jsonb_build_object('status','concurrent');end if;
  if coalesce((select started_requests from private.ai_member_daily_usage where user_id=p_user_id and kst_day=v_day),0)>=20 then
    return jsonb_build_object('status','daily_limit');end if;
  if p_output_retry_of is not null then
    select * into prior from private.ai_chat_requests where request_id=p_output_retry_of for update;
    if prior.request_id is null or prior.user_id<>p_user_id or prior.outcome is distinct from 'output_privacy'
      or prior.started_at is null or prior.output_retry_of is not null or prior.retry_request_id is not null then
      return jsonb_build_object('status','retry_exhausted');end if;
  end if;
  v_token:=gen_random_uuid();
  insert into private.ai_chat_requests(request_id,user_id,client_request_hash,lease_token,expires_at,output_retry_of)
    values(p_request_id,p_user_id,encode(sha256(convert_to(p_client_request_id,'UTF8')),'hex'),v_token,v_now+interval '180 seconds',p_output_retry_of);
  update private.ai_member_processing set active_request_id=p_request_id where user_id=p_user_id;
  if p_output_retry_of is not null then update private.ai_chat_requests set retry_request_id=p_request_id where request_id=p_output_retry_of;end if;
  return jsonb_build_object('status','acquired','leaseToken',v_token,'expiresAt',v_now+interval '180 seconds');
end;$$;

create function public.finish_ai_chat_request(p_user_id uuid,p_request_id uuid,p_lease_token uuid,p_outcome text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare m private.ai_member_processing;r private.ai_chat_requests;
begin
  if p_user_id is null or p_request_id is null or p_lease_token is null or p_outcome is null or p_outcome not in('finished','output_privacy') then
    raise exception 'invalid_ai_finish' using errcode='22023';end if;
  select * into m from private.ai_member_processing where user_id=p_user_id for update;
  select * into r from private.ai_chat_requests where request_id=p_request_id for update;
  if r.request_id is null or r.user_id<>p_user_id or r.lease_token<>p_lease_token then raise exception 'ai_request_lease_lost' using errcode='40001';end if;
  if r.outcome is not null then
    if r.outcome<>p_outcome then raise exception 'ai_request_conflict' using errcode='40001';end if;
    return jsonb_build_object('finished',true);end if;
  if m.active_request_id is distinct from p_request_id or r.expires_at<=clock_timestamp() then raise exception 'ai_request_lease_lost' using errcode='40001';end if;
  if p_outcome='output_privacy' and r.started_at is null then raise exception 'invalid_ai_output_outcome' using errcode='22023';end if;
  update private.ai_chat_requests set outcome=p_outcome,finished_at=clock_timestamp() where request_id=p_request_id;
  update private.ai_member_processing set active_request_id=null where user_id=p_user_id and active_request_id=p_request_id;
  return jsonb_build_object('finished',true);
end;$$;

create function public.reserve_ai_chat_model(p_ledger_id text,p_provider_id text,p_task text,p_units bigint,
  p_user_id uuid,p_request_id uuid,p_lease_token uuid,p_contract_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare m private.ai_member_processing;r private.ai_chat_requests;v_day date;v_now timestamptz;v_count integer;v_result jsonb;
begin
  if p_contract_version is distinct from '2026-10-05' or p_task is null or p_task not in('intent','preference_match','explanation')
    or p_user_id is null or p_request_id is null or p_lease_token is null then raise exception 'invalid_ai_scope' using errcode='22023';end if;
  select * into m from private.ai_member_processing where user_id=p_user_id for update;
  if m.user_id is null or not m.exploration_allowed then return jsonb_build_object('status','consent_revoked');end if;
  select * into r from private.ai_chat_requests where request_id=p_request_id for update;
  v_now:=clock_timestamp();
  if r.request_id is null or r.user_id<>p_user_id or r.lease_token<>p_lease_token or r.outcome is not null
    or r.expires_at<=v_now or m.active_request_id is distinct from p_request_id then return jsonb_build_object('status','lease_lost');end if;
  -- 외부 전송 승인과 동의를 혼동하지 않는다. 운영 비활성은 상태를 조작하지 않고 명시 실패한다.
  if not coalesce((select external_processing_allowed from private.ai_processing_guard where singleton),false) then
    raise exception 'ai_processing_not_approved' using errcode='55000';end if;
  -- 원장 잠금 대기 중 만료·한국시간 자정이 지나갈 수 있다. 실제 예약 뒤 DB 시각으로 재검사한다.
  begin
    v_result:=public.reserve_ai_budget(p_ledger_id,p_provider_id,p_task,p_units);
    if v_result->>'reservationId' is null then return v_result;end if;
    v_now:=clock_timestamp();
    if r.expires_at<=v_now then raise exception 'ai_request_lease_lost' using errcode='40001';end if;
    if r.counted_day is null then
      v_day:=(v_now at time zone 'Asia/Seoul')::date;
      insert into private.ai_member_daily_usage(user_id,kst_day) values(p_user_id,v_day) on conflict do nothing;
      select started_requests into v_count from private.ai_member_daily_usage where user_id=p_user_id and kst_day=v_day for update;
      if v_count>=20 then raise exception 'ai_daily_limit' using errcode='P0020';end if;
      update private.ai_member_daily_usage set started_requests=started_requests+1 where user_id=p_user_id and kst_day=v_day;
      update private.ai_chat_requests set counted_day=v_day,started_at=v_now where request_id=p_request_id;
    end if;
  exception
    when sqlstate '40001' then return jsonb_build_object('status','lease_lost');
    when sqlstate 'P0020' then return jsonb_build_object('status','daily_limit');
  end;
  return v_result;
end;$$;

-- AI 근거에서 철회 작성자 제외. 일반 공개 후기와 동행·계정은 유지한다.
create or replace function private.review_summary_sources(p_profile_id uuid)
returns jsonb language sql volatile security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('reviewId',rv.id,'text',btrim(rv.comment)) order by rv.id),'[]'::jsonb)
  from public.appointment_reviews rv join public.appointments ap on ap.id=rv.appointment_id
  join public.posts p on p.id=ap.post_id join public.join_requests jr on jr.id=ap.join_request_id
  join private.ai_member_processing author_consent on author_consent.user_id=rv.reviewer_id and author_consent.summary_allowed
  join private.ai_member_processing target_consent on target_consent.user_id=p_profile_id and target_consent.summary_allowed
  where rv.reviewer_id in(p.author_id,jr.requester_id) and p.author_id<>jr.requester_id
    and (case when rv.reviewer_id=p.author_id then jr.requester_id else p.author_id end)=p_profile_id
    and nullif(btrim(rv.comment),'') is not null and private.is_review_public_eligible(rv.id);
$$;

create function public.reserve_review_summary_model(p_ledger_id text,p_provider_id text,p_task text,p_units bigint,
  p_job_id uuid,p_lease_token uuid,p_target_user_id uuid,p_source_revision text,p_worker_run_token uuid,
  p_model_version text,p_prompt_version text,p_source_review_ids uuid[],p_contract_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare j private.worker_jobs;s jsonb;v_ids uuid[];u uuid;v_run private.global_worker_run;
begin
  if p_contract_version is distinct from '2026-10-05' or p_task is null or p_task not in('review_chunk','review_merge')
    or p_target_user_id is null or p_worker_run_token is null or p_source_review_ids is null
    or p_model_version is null or p_prompt_version is null or p_source_revision is null then raise exception 'invalid_summary_scope' using errcode='22023';end if;
  -- 동의를 UUID 순서로 잠근 뒤 projection → job → budget을 잠근다.
  for u in select distinct ids.uid from (select p_target_user_id uid union all
    select reviewer_id from public.appointment_reviews where id=any(p_source_review_ids)) ids order by ids.uid loop
    perform 1 from private.ai_member_processing where user_id=u and summary_allowed for update;
    if not found then return jsonb_build_object('status','consent_revoked');end if;
  end loop;
  select * into v_run from private.global_worker_run where singleton for update;
  if v_run.token is distinct from p_worker_run_token or v_run.expires_at is null or v_run.expires_at<=clock_timestamp() then
    return jsonb_build_object('status','lease_lost');end if;
  j:=private.summary_job_for_lease(p_job_id,p_lease_token);
  if j.id is null then return jsonb_build_object('status','lease_lost');end if;
  -- 동일 전역 점유과 작업 점유의 실제 연결을 검사한다. 이전 run의 lease는 재사용하지 않는다.
  begin
    perform private.assert_current_worker_job(p_job_id,p_lease_token,p_worker_run_token);
  exception when sqlstate '40001' then return jsonb_build_object('status','lease_lost');
  end;
  if j.payload->>'profileId' is distinct from p_target_user_id::text or j.payload->>'sourceRevision' is distinct from p_source_revision
    or j.payload->>'modelVersion' is distinct from p_model_version or j.payload->>'promptVersion' is distinct from p_prompt_version then
    return jsonb_build_object('status','stale_revision');end if;
  s:=private.summary_job_snapshot(j);
  if s is null or s->>'sourceRevision' is distinct from p_source_revision then return jsonb_build_object('status','stale_revision');end if;
  select coalesce(array_agg((x->>'reviewId')::uuid order by x->>'reviewId'),'{}') into v_ids from jsonb_array_elements(s->'reviews') x;
  if cardinality(v_ids)<3 then return jsonb_build_object('status','insufficient_reviews');end if;
  if array_position(p_source_review_ids,null) is not null or cardinality(p_source_review_ids)<>(select count(distinct id) from unnest(p_source_review_ids) id)
    or cardinality(p_source_review_ids)<>cardinality(v_ids) or not(p_source_review_ids@>v_ids and p_source_review_ids<@v_ids) then
    return jsonb_build_object('status','invalid_evidence');end if;
  if j.lease_expires_at<=clock_timestamp() or v_run.expires_at<=clock_timestamp() then return jsonb_build_object('status','lease_lost');end if;
  if not coalesce((select external_processing_allowed from private.ai_processing_guard where singleton),false) then
    raise exception 'ai_processing_not_approved' using errcode='55000';end if;
  begin
    s:=public.reserve_ai_budget(p_ledger_id,p_provider_id,p_task,p_units);
    perform private.assert_current_worker_job(p_job_id,p_lease_token,p_worker_run_token);
    if j.lease_expires_at<=clock_timestamp() then raise exception 'summary_lease_lost' using errcode='40001';end if;
    return s;
  exception when sqlstate '40001' then return jsonb_build_object('status','lease_lost');
  end;
end;$$;

create function public.withdraw_my_ai_processing(p_kind text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile();u uuid;
begin
  if p_kind is null or p_kind not in('exploration','review_summary') then raise exception 'invalid_ai_processing_kind' using errcode='22023';end if;
  insert into private.ai_member_processing(user_id) values(v_uid) on conflict do nothing;
  perform 1 from private.ai_member_processing where user_id=v_uid for update;
  if p_kind='exploration' then
    update private.ai_member_processing set exploration_allowed=false,exploration_withdrawn_at=coalesce(exploration_withdrawn_at,clock_timestamp()),active_request_id=null where user_id=v_uid;
  else
    if exists(select 1 from private.ai_member_processing where user_id=v_uid and summary_withdrawn_at is not null and not summary_allowed) then
      return jsonb_build_object('withdrawn',true);end if;
    update private.ai_member_processing set summary_allowed=false,summary_withdrawn_at=coalesce(summary_withdrawn_at,clock_timestamp()) where user_id=v_uid;
    for u in select distinct uid from (
      select v_uid uid union all select case when rv.reviewer_id=p.author_id then jr.requester_id else p.author_id end
      from public.appointment_reviews rv join public.appointments ap on ap.id=rv.appointment_id
      join public.posts p on p.id=ap.post_id join public.join_requests jr on jr.id=ap.join_request_id where rv.reviewer_id=v_uid
    ) ids order by uid loop
      insert into private.review_summary_state(profile_id) values(u) on conflict do nothing;
      update private.review_summary_state set revision=revision+1,fingerprint=null,visible_summary_id=null where profile_id=u;
      delete from private.review_summary_checkpoints where profile_id=u;
      if u<>v_uid then insert into private.review_refresh_outbox(profile_id) values(u) on conflict(profile_id) do update set requested_at=clock_timestamp();
      else delete from private.review_refresh_outbox where profile_id=u;end if;
    end loop;
  end if;
  return jsonb_build_object('withdrawn',true);
end;$$;
revoke all on function public.acquire_ai_chat_request(uuid,uuid,text,uuid,text),public.finish_ai_chat_request(uuid,uuid,uuid,text),
  public.reserve_ai_chat_model(text,text,text,bigint,uuid,uuid,uuid,text),
  public.reserve_review_summary_model(text,text,text,bigint,uuid,uuid,uuid,text,uuid,text,text,uuid[],text),public.withdraw_my_ai_processing(text)
  from public,anon,authenticated,service_role;
grant execute on function public.acquire_ai_chat_request(uuid,uuid,text,uuid,text),public.finish_ai_chat_request(uuid,uuid,uuid,text),
  public.reserve_ai_chat_model(text,text,text,bigint,uuid,uuid,uuid,text),
  public.reserve_review_summary_model(text,text,text,bigint,uuid,uuid,uuid,text,uuid,text,text,uuid[],text) to service_role;
grant execute on function public.withdraw_my_ai_processing(text) to authenticated;
-- generic 예약은 점유·개인 쿼터·동의 범위 우회를 허용하지 않는다. 새 SECURITY DEFINER 예약만 내부 호출한다.
revoke all on function public.reserve_ai_budget(text,text,text,bigint) from public,anon,authenticated,service_role;
commit;
