-- 민규: 독립 선택 동의. 기존 summary_allowed는 동의 증거로 승계하지 않는다.
begin;
alter table private.ai_member_processing
 add column summary_view_allowed boolean not null default false,
 add column summary_generate_allowed boolean not null default false,
 add column summary_source_allowed boolean not null default false;
create function public.get_my_ai_consents() returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_service_profile(); m private.ai_member_processing;
begin
 select * into m from private.ai_member_processing where user_id=u;
 return jsonb_build_object('exploration',coalesce(m.exploration_allowed,false),
 'summary_view',coalesce(m.summary_view_allowed,false),'summary_generate',coalesce(m.summary_generate_allowed,false),
 'summary_source',coalesce(m.summary_source_allowed,false));
end; $$;
create function public.set_my_ai_consent(p_kind text,p_allowed boolean) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_service_profile(); m private.ai_member_processing; target uuid; changed boolean;
begin
 if p_kind is null or p_kind not in('exploration','summary_view','summary_generate','summary_source') or p_allowed is null then
  raise exception 'invalid_ai_consent' using errcode='22023'; end if;
 insert into private.ai_member_processing(user_id) values(u) on conflict do nothing;
 select * into m from private.ai_member_processing where user_id=u for update;
 changed:=case p_kind when 'exploration' then m.exploration_allowed when 'summary_view' then m.summary_view_allowed
  when 'summary_generate' then m.summary_generate_allowed else m.summary_source_allowed end is distinct from p_allowed;
 if not changed then return public.get_my_ai_consents(); end if;
 if p_kind='exploration' then
  update private.ai_member_processing set exploration_allowed=p_allowed,
   exploration_withdrawn_at=case when p_allowed then null else clock_timestamp() end,
   active_request_id=case when p_allowed then active_request_id else null end where user_id=u;
 elsif p_kind='summary_view' then
  update private.ai_member_processing set summary_view_allowed=p_allowed where user_id=u;
 elsif p_kind='summary_generate' then
  update private.ai_member_processing set summary_generate_allowed=p_allowed where user_id=u;
 else
  update private.ai_member_processing set summary_source_allowed=p_allowed where user_id=u;
 end if;
 -- 열람 변경은 다른 프로필을 건드리지 않는다. 생성·원문 변경은 먼저 숨기고 재생성을 요청한다.
 if p_kind in('summary_generate','summary_source') then
  for target in select distinct affected.uid from (
   select u uid where p_kind='summary_generate'
   union all
   select case when rv.reviewer_id=p.author_id then jr.requester_id else p.author_id end
    from public.appointment_reviews rv join public.appointments ap on ap.id=rv.appointment_id
    join public.posts p on p.id=ap.post_id join public.join_requests jr on jr.id=ap.join_request_id
    where p_kind='summary_source' and rv.reviewer_id=u
  ) affected order by affected.uid loop
   insert into private.review_summary_state(profile_id) values(target) on conflict do nothing;
   update private.review_summary_state set revision=revision+1,fingerprint=null,visible_summary_id=null where profile_id=target;
   delete from private.review_summary_checkpoints where profile_id=target;
   if exists(select 1 from private.ai_member_processing where user_id=target and summary_generate_allowed) then
    insert into private.review_refresh_outbox(profile_id) values(target) on conflict(profile_id) do update set requested_at=clock_timestamp();
   else delete from private.review_refresh_outbox where profile_id=target; end if;
  end loop;
 end if;
 return public.get_my_ai_consents();
end; $$;
-- 구형 전체 요약 철회 호출은 호환 유지한다. 새 소비자는 세 항목을 각각 설정한다.
create or replace function public.withdraw_my_ai_processing(p_kind text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_service_profile(); target uuid;
begin
 if p_kind='exploration' then perform public.set_my_ai_consent('exploration',false);
 elsif p_kind='review_summary' then
  -- 동의 → 모든 영향 projection(UUID순) 잠금. 세 setter의 순차 부분집합 잠금은 서로 후기 작성한
  -- 두 회원의 동시 전체 철회에서 A→B / B→A 잠금 역전을 만들 수 있다.
  insert into private.ai_member_processing(user_id) values(u) on conflict do nothing;
  perform 1 from private.ai_member_processing where user_id=u for update;
  for target in select distinct affected.uid from (
   select u uid union all
   select case when rv.reviewer_id=p.author_id then jr.requester_id else p.author_id end
    from public.appointment_reviews rv join public.appointments ap on ap.id=rv.appointment_id
    join public.posts p on p.id=ap.post_id join public.join_requests jr on jr.id=ap.join_request_id
    where rv.reviewer_id=u
  ) affected order by affected.uid loop
   insert into private.review_summary_state(profile_id) values(target) on conflict do nothing;
   perform 1 from private.review_summary_state where profile_id=target for update;
  end loop;
  perform public.set_my_ai_consent('summary_view',false);
  perform public.set_my_ai_consent('summary_generate',false);
  perform public.set_my_ai_consent('summary_source',false);
  update private.ai_member_processing set summary_allowed=false,summary_withdrawn_at=coalesce(summary_withdrawn_at,clock_timestamp()) where user_id=private.require_service_profile();
 else raise exception 'invalid_ai_processing_kind' using errcode='22023'; end if;
 return jsonb_build_object('withdrawn',true);
end; $$;
create or replace function private.review_summary_sources(p_profile_id uuid)
returns jsonb language sql volatile security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('reviewId',rv.id,'text',btrim(rv.comment)) order by rv.id),'[]'::jsonb)
  from public.appointment_reviews rv join public.appointments ap on ap.id=rv.appointment_id
  join public.posts p on p.id=ap.post_id join public.join_requests jr on jr.id=ap.join_request_id
  join private.ai_member_processing author_consent on author_consent.user_id=rv.reviewer_id and author_consent.summary_source_allowed
  join private.ai_member_processing target_consent on target_consent.user_id=p_profile_id and target_consent.summary_generate_allowed
  where rv.reviewer_id in(p.author_id,jr.requester_id) and p.author_id<>jr.requester_id
    and (case when rv.reviewer_id=p.author_id then jr.requester_id else p.author_id end)=p_profile_id
    and nullif(btrim(rv.comment),'') is not null and private.is_review_public_eligible(rv.id) and private.review_belongs_current_episode(rv.id,p_profile_id);
$$;
create or replace function public.reserve_review_summary_model(p_ledger_id text,p_provider_id text,p_task text,p_units bigint,
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
    perform 1 from private.ai_member_processing where user_id=u for update;
    if not exists(select 1 from private.ai_member_processing where user_id=u
      and (u<>p_target_user_id or summary_generate_allowed)
      and (not exists(select 1 from public.appointment_reviews where id=any(p_source_review_ids) and reviewer_id=u) or summary_source_allowed)) then
      return jsonb_build_object('status','consent_revoked'); end if;
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

create or replace function private.current_summary_preflight(p_job_id uuid,p_lease_token uuid,p_worker_run_token uuid,
  p_contract_version text,p_external_processing boolean)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare j private.worker_jobs; target uuid;
begin
  if p_contract_version is distinct from '2026-10-05' then
    raise exception 'unsupported_summary_contract' using errcode='22023';
  end if;
  select * into j from private.worker_jobs where id=p_job_id;
  if not found or j.kind<>'review_summary' then raise exception 'summary_lease_lost' using errcode='40001'; end if;
  target:=(j.payload->>'profileId')::uuid;
  perform 1 from private.ai_member_processing m where m.user_id in (
    select target union select rv.reviewer_id from public.appointment_reviews rv
      join public.appointments ap on ap.id=rv.appointment_id
      join public.posts p on p.id=ap.post_id join public.join_requests r on r.id=ap.join_request_id
      where case when rv.reviewer_id=p.author_id then r.requester_id else p.author_id end=target
  ) order by m.user_id for update;
  perform private.assert_current_worker_job(p_job_id,p_lease_token,p_worker_run_token);
  j:=private.summary_job_for_lease(p_job_id,p_lease_token);
  if j.id is null then raise exception 'summary_lease_lost' using errcode='40001'; end if;
  if not exists(select 1 from private.ai_member_processing where user_id=target and summary_generate_allowed) then return false; end if;
  if p_external_processing and not exists(select 1 from private.ai_processing_guard where singleton and external_processing_allowed) then
    -- 운영 승인은 revision 변화가 아니다. 정상 stale로 종료시키지 않고 점유/중간 저장을 보존한다.
    raise exception 'ai_processing_not_approved' using errcode='55000';
  end if;
  return true;
end; $$;
create or replace function public.get_visible_review_summary(p_profile_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_service_profile();
begin
 perform private.require_active_public_profile(p_profile_id);
 if not exists(select 1 from private.ai_member_processing where user_id=u and summary_view_allowed) then
  return jsonb_build_object('summary',null); end if;
 return private.get_visible_review_summary_before_member_retirement(p_profile_id);
end; $$;
-- 읽기 전용 사전 상태. 공급사 예산/네트워크 예약 가능성을 보장하지 않는다.
create function public.get_my_ai_availability() returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_service_profile(); at_time timestamptz:=clock_timestamp();
 day_kst date; remaining integer; m private.ai_member_processing; reason text;
begin
 day_kst:=(at_time at time zone 'Asia/Seoul')::date;
 select * into m from private.ai_member_processing where user_id=u;
 select greatest(0,20-coalesce((select started_requests from private.ai_member_daily_usage where user_id=u and kst_day=day_kst),0)) into remaining;
 reason:=case
  when not coalesce((select external_processing_allowed from private.ai_processing_guard where singleton),false) then 'processing_disabled'
  when not coalesce(m.exploration_allowed,false) then 'consent_required'
  when exists(select 1 from private.ai_chat_requests where request_id=m.active_request_id and user_id=u and outcome is null and expires_at>at_time) then 'concurrent'
  when remaining=0 then 'daily_limit' else null end;
 return jsonb_build_object('estimatedEligible',reason is null,'reason',reason,'remaining',remaining,
  'kstDay',day_kst,'checkedAt',at_time,'resetsAt',((day_kst+1)::timestamp at time zone 'Asia/Seoul'),
  'requestAuthoritative',true);
end; $$;
revoke all on function public.get_my_ai_availability() from public,anon,authenticated,service_role;
grant execute on function public.get_my_ai_availability() to authenticated;
revoke all on function public.get_my_ai_consents(),public.set_my_ai_consent(text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.get_my_ai_consents(),public.set_my_ai_consent(text,boolean) to authenticated;
commit;
