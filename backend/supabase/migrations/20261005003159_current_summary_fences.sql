-- 민규: 2026-10-05 요약 계약. 원문 없는 점유·동의·revision 검증을 기존 원자 게시 로직과 연결한다.
begin;

-- 잠금 순서: 작성자/대상 동의(UUID순) → 전역 실행 → 대상 projection → job.
-- 동의 철회도 동의 → projection 순서로 진행한다. target/author 원문 자격은 AI 원천 필터가 확인한다.
create function private.current_summary_preflight(p_job_id uuid,p_lease_token uuid,p_worker_run_token uuid,
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
  if not exists(select 1 from private.ai_member_processing where user_id=target and summary_allowed) then return false; end if;
  if p_external_processing and not exists(select 1 from private.ai_processing_guard where singleton and external_processing_allowed) then
    -- 운영 승인은 revision 변화가 아니다. 정상 stale로 종료시키지 않고 점유/중간 저장을 보존한다.
    raise exception 'ai_processing_not_approved' using errcode='55000';
  end if;
  return true;
end; $$;
revoke all on function private.current_summary_preflight(uuid,uuid,uuid,text,boolean) from public,anon,authenticated,service_role;

create function public.load_review_summary_source(p_job_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_contract_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; j private.worker_jobs;
begin
  if not private.current_summary_preflight(p_job_id,p_lease_token,p_worker_run_token,p_contract_version,true) then
    return jsonb_build_object('status','stale_revision');
  end if;
  result:=public.load_review_summary_source(p_job_id,p_lease_token);
  select * into strict j from private.worker_jobs where id=p_job_id;
  if result->>'status'='applied' then
    if result->>'sourceRevision' is distinct from j.payload->>'sourceRevision' then
      result:=jsonb_build_object('status','stale_revision');
    else result:=result||jsonb_build_object('processingAllowed',true); end if;
  end if;
  perform private.assert_current_worker_job(p_job_id,p_lease_token,p_worker_run_token);
  return result;
exception when serialization_failure then return jsonb_build_object('status','lease_lost');
end; $$;

create function public.load_review_summary_checkpoint(p_job_id uuid,p_lease_token uuid,p_source_revision text,
  p_worker_run_token uuid,p_contract_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb;
begin
  if not private.current_summary_preflight(p_job_id,p_lease_token,p_worker_run_token,p_contract_version,true) then
    return jsonb_build_object('status','stale_revision');
  end if;
  result:=public.load_review_summary_checkpoint(p_job_id,p_lease_token,p_source_revision);
  perform private.assert_current_worker_job(p_job_id,p_lease_token,p_worker_run_token);
  return result;
exception when serialization_failure then return jsonb_build_object('status','lease_lost');
end; $$;

create function public.save_review_summary_checkpoint(p_job_id uuid,p_lease_token uuid,p_source_revision text,p_checkpoint jsonb,
  p_worker_run_token uuid,p_contract_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb;
begin
  if not private.current_summary_preflight(p_job_id,p_lease_token,p_worker_run_token,p_contract_version,true) then
    return jsonb_build_object('status','stale_revision');
  end if;
  result:=public.save_review_summary_checkpoint(p_job_id,p_lease_token,p_source_revision,p_checkpoint);
  perform private.assert_current_worker_job(p_job_id,p_lease_token,p_worker_run_token);
  return result;
exception when serialization_failure then return jsonb_build_object('status','lease_lost');
end; $$;

create function public.discard_review_summary_checkpoint(p_job_id uuid,p_lease_token uuid,p_source_revision text,
  p_worker_run_token uuid,p_contract_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb;
begin
  -- 철회 뒤에도 자기 점유의 private checkpoint 폐기는 허용한다. 원문이나 요약은 반환하지 않는다.
  perform private.current_summary_preflight(p_job_id,p_lease_token,p_worker_run_token,p_contract_version,false);
  result:=public.discard_review_summary_checkpoint(p_job_id,p_lease_token,p_source_revision);
  perform private.assert_current_worker_job(p_job_id,p_lease_token,p_worker_run_token);
  return result;
exception when serialization_failure then return jsonb_build_object('status','lease_lost');
end; $$;

create function public.mark_review_summary_insufficient(p_job_id uuid,p_lease_token uuid,p_source_revision text,
  p_worker_run_token uuid,p_contract_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb;
begin
  if not private.current_summary_preflight(p_job_id,p_lease_token,p_worker_run_token,p_contract_version,false) then
    return jsonb_build_object('status','stale_revision');
  end if;
  result:=public.mark_review_summary_insufficient(p_job_id,p_lease_token,p_source_revision);
  perform private.assert_current_worker_job(p_job_id,p_lease_token,p_worker_run_token);
  return result;
exception when serialization_failure then return jsonb_build_object('status','lease_lost');
end; $$;

create function public.publish_review_summary_for_job(p_job_id uuid,p_lease_token uuid,p_source_revision text,
  p_evidence_review_ids uuid[],p_summary text,p_model_version text,p_prompt_version text,
  p_worker_run_token uuid,p_contract_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb;
begin
  if not private.current_summary_preflight(p_job_id,p_lease_token,p_worker_run_token,p_contract_version,true) then
    return jsonb_build_object('status','stale_revision');
  end if;
  if p_summary is null or char_length(btrim(p_summary)) not between 1 and 300 then
    raise exception 'invalid_current_summary' using errcode='22023';
  end if;
  result:=public.publish_review_summary_for_job(p_job_id,p_lease_token,p_source_revision,p_evidence_review_ids,
    p_summary,p_model_version,p_prompt_version);
  perform private.assert_current_worker_job(p_job_id,p_lease_token,p_worker_run_token);
  return result;
exception when serialization_failure then return jsonb_build_object('status','lease_lost');
end; $$;

-- 구형 unfenced 함수는 owner 내부 호출용으로만 남긴다. service_role도 직접 실행할 수 없다.
revoke all on function public.load_public_review_snapshot(uuid),public.publish_review_summary(uuid,text,uuid[],text,text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.load_review_summary_source(uuid,uuid),public.load_review_summary_checkpoint(uuid,uuid,text),
  public.save_review_summary_checkpoint(uuid,uuid,text,jsonb),public.discard_review_summary_checkpoint(uuid,uuid,text),
  public.mark_review_summary_insufficient(uuid,uuid,text),public.publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.load_review_summary_source(uuid,uuid,uuid,text),public.load_review_summary_checkpoint(uuid,uuid,text,uuid,text),
  public.save_review_summary_checkpoint(uuid,uuid,text,jsonb,uuid,text),public.discard_review_summary_checkpoint(uuid,uuid,text,uuid,text),
  public.mark_review_summary_insufficient(uuid,uuid,text,uuid,text),public.publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.load_review_summary_source(uuid,uuid,uuid,text),public.load_review_summary_checkpoint(uuid,uuid,text,uuid,text),
  public.save_review_summary_checkpoint(uuid,uuid,text,jsonb,uuid,text),public.discard_review_summary_checkpoint(uuid,uuid,text,uuid,text),
  public.mark_review_summary_insufficient(uuid,uuid,text,uuid,text),public.publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text,uuid,text)
  to service_role;
commit;
