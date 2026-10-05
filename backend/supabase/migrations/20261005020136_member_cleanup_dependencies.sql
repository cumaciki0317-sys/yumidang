-- Auth hard delete는 같은 탈퇴 건의 모든 Storage 작업 완료 이후에만 진행한다.
-- 선행 lifecycle55는 immutable이며, 외부 승인 gate/5개 RPC ACL은 닫힌 상태를 보존한다.
begin;
create or replace function private.assert_member_cleanup_storage_completed(p_withdrawal_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  if exists(select 1 from private.member_cleanup_tasks s where s.withdrawal_id=p_withdrawal_id
    and s.kind='storage_object' and s.state<>'completed') then
    raise exception 'storage_cleanup_incomplete' using errcode='40001';
  end if;
end; $$;
do $$declare fn_owner text;begin
  select pg_get_userbyid(proowner) into fn_owner from pg_proc
    where oid='public.check_member_cleanup_task(uuid,uuid,uuid,uuid)'::regprocedure;
  execute format('alter function private.assert_member_cleanup_storage_completed(uuid) owner to %I',fn_owner);
end; $$;
revoke all on function private.assert_member_cleanup_storage_completed(uuid) from public,anon,authenticated,service_role;
create or replace function public.claim_member_cleanup_task(p_worker_run_token uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare t private.member_cleanup_tasks;n timestamptz;tok uuid:=gen_random_uuid();begin
  if not coalesce((select external_deletion_approved from private.member_cleanup_guard where singleton),false) then
    raise exception 'member_cleanup_not_approved' using errcode='55000';end if;
  perform private.assert_current_worker_run(p_worker_run_token);n:=clock_timestamp();
  select * into t from private.member_cleanup_tasks where (state='pending' or (state='running' and lease_expires_at<=n))
    and (kind<>'auth_user' or not exists(select 1 from private.member_cleanup_tasks s
      where s.withdrawal_id=member_cleanup_tasks.withdrawal_id and s.kind='storage_object' and s.state<>'completed'))
    order by id for update skip locked limit 1;
  if not found then return null;end if;
  update private.member_cleanup_tasks set state='running',lease_token=tok,worker_run_token=p_worker_run_token,lease_expires_at=n+interval '60 seconds' where id=t.id;
  perform private.assert_current_worker_run(p_worker_run_token);
  return jsonb_build_object('taskId',t.id,'leaseToken',tok,'expiresAt',n+interval '60 seconds','kind',t.kind,
    'profileId',t.profile_id,'bucketId',t.bucket_id,'objectName',t.object_name,'objectId',t.object_id);
end; $$;

create or replace function public.check_member_cleanup_task(p_task_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_object_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare t private.member_cleanup_tasks;begin
  if not coalesce((select external_deletion_approved from private.member_cleanup_guard where singleton),false) then
    raise exception 'member_cleanup_not_approved' using errcode='55000';end if;
  perform private.assert_current_worker_run(p_worker_run_token);
  select * into t from private.member_cleanup_tasks where id=p_task_id for share;
  if not found or t.state<>'running' or t.lease_token is distinct from p_lease_token or t.worker_run_token is distinct from p_worker_run_token
    or t.lease_expires_at<=clock_timestamp() or t.object_id is distinct from p_object_id
    or not exists(select 1 from private.member_retirements r where r.withdrawal_id=t.withdrawal_id and r.profile_id=t.profile_id and r.state='pending_cleanup') then
    raise exception 'state_conflict' using errcode='40001';end if;
  if t.kind='auth_user' then perform private.assert_member_cleanup_storage_completed(t.withdrawal_id);end if;
  if t.kind='storage_object' and exists(select 1 from storage.objects o
    where (o.id=t.object_id or (o.bucket_id=t.bucket_id and o.name=t.object_name))
      and (o.id is distinct from t.object_id or o.bucket_id is distinct from t.bucket_id or o.name is distinct from t.object_name
        or not (coalesce(o.owner_id=t.profile_id::text,false) or split_part(o.name,'/',1)=t.profile_id::text))) then
    raise exception 'state_conflict' using errcode='40001';end if;
  perform private.assert_current_worker_run(p_worker_run_token);
  return jsonb_build_object('taskId',t.id,'leaseToken',t.lease_token,'expiresAt',t.lease_expires_at,'kind',t.kind,
    'profileId',t.profile_id,'bucketId',t.bucket_id,'objectName',t.object_name,'objectId',t.object_id);
end; $$;

create or replace function public.complete_member_cleanup_task(p_task_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_object_id uuid,p_evidence_sha256 text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare t private.member_cleanup_tasks;begin
  if not coalesce((select external_deletion_approved from private.member_cleanup_guard where singleton),false) then
    raise exception 'member_cleanup_not_approved' using errcode='55000';end if;
  perform public.check_member_cleanup_task(p_task_id,p_lease_token,p_worker_run_token,p_object_id);
  if public.get_member_cleanup_delete_ack(p_task_id,p_lease_token,p_worker_run_token,p_object_id) is null then
    raise exception 'deletion_ack_required' using errcode='40001';end if;
  select * into t from private.member_cleanup_tasks where id=p_task_id for update;
  if not found or t.state<>'running' or t.lease_token is distinct from p_lease_token or t.worker_run_token is distinct from p_worker_run_token
    or t.lease_expires_at<=clock_timestamp() or t.object_id is distinct from p_object_id then raise exception 'state_conflict' using errcode='40001';end if;
  if p_evidence_sha256 is null or p_evidence_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'invalid_deletion_evidence' using errcode='22023';end if;
  if t.kind='storage_object' and exists(select 1 from storage.objects where bucket_id=t.bucket_id and (id=t.object_id or name=t.object_name)) then
    raise exception 'object_metadata_still_present' using errcode='40001';end if;
  if t.kind='auth_user' then perform private.assert_member_cleanup_storage_completed(t.withdrawal_id);end if;
  if t.kind='auth_user' and exists(select 1 from auth.users where id=t.profile_id) then raise exception 'auth_user_still_present' using errcode='40001';end if;
  update private.member_cleanup_tasks set state='completed',lease_token=null,worker_run_token=null,lease_expires_at=null,evidence_sha256=p_evidence_sha256,completed_at=clock_timestamp() where id=t.id;
  if not exists(select 1 from private.member_cleanup_tasks where withdrawal_id=t.withdrawal_id and state<>'completed') then
    update private.member_retirements set state='completed',completed_at=clock_timestamp() where withdrawal_id=t.withdrawal_id;
  end if;
  perform private.assert_current_worker_run(p_worker_run_token);
  return jsonb_build_object('status','applied');
end; $$;
revoke all on function public.claim_member_cleanup_task(uuid),
 public.check_member_cleanup_task(uuid,uuid,uuid,uuid),
 public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
create or replace function public.retire_my_account(p_withdrawal_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=auth.uid();s text;e uuid;r private.member_retirements;n timestamptz; x record;begin
  if u is null or auth.role()<>'authenticated' or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then
    raise exception 'login_required' using errcode='28000';end if;
  if p_withdrawal_id is null then raise exception 'invalid_withdrawal' using errcode='22023';end if;
  -- 일반 회원 공유 가드 대신 처음부터 배타 잠금을 잡아 동시 탈퇴 재시도를 직렬화한다.
  select subject into s from private.naver_accounts where user_id=u;
  if s is null then
    select * into r from private.member_retirements where profile_id=u;
    if found and r.withdrawal_id=p_withdrawal_id then
      return jsonb_build_object('withdrawalId',r.withdrawal_id,'status',case when r.state='completed' then 'completed' else 'processing' end,'memberAccessRevoked',true);
    end if;
    raise exception 'naver_account_required' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(s,98214));
  perform 1 from private.naver_accounts where subject=s and user_id=u for update;
  if not found then
    select * into r from private.member_retirements where profile_id=u;
    if found and r.withdrawal_id=p_withdrawal_id then
      return jsonb_build_object('withdrawalId',r.withdrawal_id,'status',case when r.state='completed' then 'completed' else 'processing' end,'memberAccessRevoked',true);
    end if;
    raise exception 'state_conflict' using errcode='40001';end if;
  perform 1 from public.profiles where id=u for update;
  select id into e from private.member_episodes where profile_id=u and ended_at is null for update;
  if e is null then
    select * into r from private.member_retirements where profile_id=u;
    if found and r.withdrawal_id=p_withdrawal_id then
      return jsonb_build_object('withdrawalId',r.withdrawal_id,'status',case when r.state='completed' then 'completed' else 'processing' end,'memberAccessRevoked',true);
    end if;
    raise exception 'active_episode_required' using errcode='42501';
  end if;
  -- 최초 요청만 실제 삭제 pipeline 준비를 요구한다. 기존 영수증 재시도는 위에서 반환한다.
  perform 1 from private.member_cleanup_guard where singleton and external_deletion_approved for share;
  if not found or not (
    has_function_privilege('service_role','public.claim_member_cleanup_task(uuid)','EXECUTE') and
    has_function_privilege('service_role','public.check_member_cleanup_task(uuid,uuid,uuid,uuid)','EXECUTE') and
    has_function_privilege('service_role','public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)','EXECUTE') and
    has_function_privilege('service_role','public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)','EXECUTE') and
    has_function_privilege('service_role','public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)','EXECUTE')) then
    raise exception 'member_cleanup_pipeline_not_ready' using errcode='55000';
  end if;
  -- pair locks precede post/appointment locks, matching block/reopen/first-chat order.
  for x in select distinct least(p.author_id,j.requester_id) a,greatest(p.author_id,j.requester_id) b
    from public.posts p join public.join_requests j on j.post_id=p.id where u in(p.author_id,j.requester_id) order by a,b loop
    perform private.lock_member_pair(x.a,x.b);
  end loop;
  perform 1 from public.posts p where p.author_id=u or exists(select 1 from public.join_requests j where j.post_id=p.id and j.requester_id=u) order by p.id for update;
  perform 1 from public.appointments ap join public.posts p on p.id=ap.post_id join public.join_requests j on j.id=ap.join_request_id
    where u in(p.author_id,j.requester_id) order by ap.id for update of ap;
  if exists(select 1 from public.appointments ap join public.posts p on p.id=ap.post_id join public.join_requests j on j.id=ap.join_request_id
    where u in(p.author_id,j.requester_id) and ap.status='confirmed') then
    raise exception 'active_appointment_blocks_retirement' using errcode='40001';end if;
  n:=clock_timestamp();
  -- AI 원문 없이 기존 동의 철회를 적용한다. 신규 활동 자격 검사를 추가하지 않는다.
  perform public.withdraw_my_ai_processing('exploration');
  perform public.withdraw_my_ai_processing('review_summary');
  insert into private.member_retirements(profile_id,withdrawal_id,episode_id,retired_at) values(u,p_withdrawal_id,e,n);
  insert into private.member_cleanup_tasks(withdrawal_id,kind,profile_id,bucket_id,object_name,object_id)
    select p_withdrawal_id,'storage_object',u,o.bucket_id,o.name,o.id from storage.objects o
    where o.bucket_id='profile-images' and (o.owner_id=u::text or split_part(o.name,'/',1)=u::text);
  insert into private.member_cleanup_tasks(withdrawal_id,kind,profile_id) values(p_withdrawal_id,'auth_user',u);
  insert into private.retired_post_retention(post_id,withdrawn_profile_id,retained_until)
    select id,u,n+interval '1 year' from public.posts where author_id=u;
  insert into private.conversation_retention(request_id)
    select j.id from public.join_requests j join public.posts p on p.id=j.post_id where u in(j.requester_id,p.author_id) on conflict do nothing;
  update public.join_requests j set status='withdrawn' where status in('pending','not_selected')
    and (requester_id=u or exists(select 1 from public.posts p where p.id=j.post_id and p.author_id=u));
  update private.match_consent_lifecycle l set status='withdrawn',ended_at=n where l.status='awaiting_consent'
    and exists(select 1 from public.posts p join public.join_requests j on j.id=l.request_id
      where p.id=l.post_id and (p.author_id=u or j.requester_id=u));
  insert into private.retired_post_bodies(post_id,body,retained_until)
    select id,jsonb_build_object('title',title,'description',description,'preferenceNote',preference_note,'tags',tags),n+interval '1 year'
    from public.posts where author_id=u;
  insert into private.retired_consent_bodies(request_id,conditions,retained_until)
    select c.request_id,private.public_retained_consent_body(c.conditions),n+interval '1 year' from private.match_consents c
      join public.join_requests j on j.id=c.request_id join public.posts p on p.id=j.post_id
      where p.author_id=u or j.requester_id=u on conflict do nothing;
  update private.match_consents c set condition_fingerprint=null,conditions=private.public_retained_consent_body(c.conditions)||jsonb_build_object('title','개인정보 가림 검토 중','description','개인정보 가림 검토 중','preferenceNote',null,'tags','[]'::jsonb)
    where exists(select 1 from private.retired_consent_bodies b where b.request_id=c.request_id)
      and exists(select 1 from public.join_requests j join public.posts p on p.id=j.post_id where j.id=c.request_id and u in(p.author_id,j.requester_id));
  update public.posts set title='개인정보 가림 검토 중',description='개인정보 가림 검토 중',preference_note=null,tags='{}',
    status=case when status='recruiting' then 'closed' else status end where author_id=u;
  -- 약속은 취소하지 않는다. 탈퇴 참여자의 대기 제안만 닫고 구조화 장소 및 파생 hash는 즉시 삭제한다.
  update private.appointment_schedule_changes c set
    status=case when c.status='awaiting_response' then 'cancelled' else c.status end,
    resolved_at=case when c.status='awaiting_response' then n else c.resolved_at end,
    new_location_input=null,new_location_fingerprint=null,old_location_fingerprint=null
    where exists(select 1 from public.appointments ap join public.posts p on p.id=ap.post_id
      join public.join_requests j on j.id=ap.join_request_id where ap.id=c.appointment_id and u in(p.author_id,j.requester_id));
  delete from public.post_private_details where post_id in(select id from public.posts where author_id=u);
  delete from private.post_search_locations where post_id in(select id from public.posts where author_id=u);
  delete from private.service_post_inputs where post_id in(select id from public.posts where author_id=u);
  delete from private.profile_traits where profile_id=u;
  delete from private.signup_eligibility where user_id=u;
  delete from private.institutional_email_verifications where user_id=u;
  delete from private.female_referral_codes where owner_id=u;
  update public.profiles set real_name=null,birth_date=null,gender=null,avatar_url=null,bio=null where id=u;
  update private.member_episodes set ended_at=n where id=e;
  delete from private.naver_sessions where user_id=u;
  delete from auth.sessions where user_id=u;
  update private.naver_accounts set user_id=null,auth_email=gen_random_uuid()::text||'@naver.yumidang.invalid',
    real_name=null,birth_date=null,gender=null,verification_status='information_required',completed_at=null where subject=s;
  return jsonb_build_object('withdrawalId',p_withdrawal_id,'status','processing','memberAccessRevoked',true);
end; $$;
revoke all on function public.retire_my_account(uuid) from public,anon,authenticated,service_role;
grant execute on function public.retire_my_account(uuid) to authenticated;
commit;
