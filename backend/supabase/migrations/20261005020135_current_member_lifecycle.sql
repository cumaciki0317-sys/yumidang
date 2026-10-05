-- 민규 생애주기 초안. 운영·법적 보관 승인/Storage 삭제 worker는 별도 연결하며 가짜 삭제 성공을 반환하지 않는다.
begin;
create table private.member_retirements(
  profile_id uuid primary key references public.profiles(id),
  withdrawal_id uuid not null unique,
  episode_id uuid not null references private.member_episodes(id),
  retired_at timestamptz not null default clock_timestamp(),
  state text not null default 'pending_cleanup' check(state in('pending_cleanup','completed')),
  completed_at timestamptz,
  check((state='completed')=(completed_at is not null))
);
create table private.member_cleanup_tasks(
  id uuid primary key default gen_random_uuid(),
  withdrawal_id uuid not null references private.member_retirements(withdrawal_id),
  kind text not null check(kind in('storage_object','auth_user')),
  profile_id uuid not null,
  bucket_id text,
  object_name text,
  object_id uuid,
  state text not null default 'pending' check(state in('pending','running','completed')),
  lease_token uuid,
  worker_run_token uuid,
  lease_expires_at timestamptz,
  evidence_sha256 text check(evidence_sha256 is null or evidence_sha256 ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz,
  check((kind='storage_object' and bucket_id='profile-images' and object_name is not null and object_id is not null)
    or (kind='auth_user' and bucket_id is null and object_name is null and object_id is null)),
  check((state='running')=(lease_token is not null and worker_run_token is not null and lease_expires_at is not null)),
  check((state='completed')=(completed_at is not null and evidence_sha256 is not null))
);
create unique index member_cleanup_auth_unique on private.member_cleanup_tasks(withdrawal_id) where kind='auth_user';
create unique index member_cleanup_object_unique on private.member_cleanup_tasks(object_id) where kind='storage_object';
create table private.member_cleanup_delete_acks(
  receipt_id uuid not null unique default gen_random_uuid(),
  task_id uuid primary key references private.member_cleanup_tasks(id) on delete cascade,
  withdrawal_id uuid not null,
  profile_id uuid not null,
  kind text not null check(kind in('storage_object','auth_user')),
  object_id uuid,
  ack_sha256 text not null check(ack_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_lease_token uuid not null,
  recorded_worker_run_token uuid not null,
  recorded_at timestamptz not null default clock_timestamp(),
  check((kind='storage_object' and object_id is not null) or (kind='auth_user' and object_id is null))
);
create table private.retired_post_retention(
  post_id uuid primary key references public.posts(id) on delete cascade,
  withdrawn_profile_id uuid not null references public.profiles(id),
  retained_until timestamptz not null,
  free_text_review_state text not null default 'pending_review' check(free_text_review_state in('pending_review','masked'))
);
create table private.retired_post_bodies(
  post_id uuid primary key references public.posts(id) on delete cascade,
  body jsonb not null,
  retained_until timestamptz not null
);
create table private.retired_consent_bodies(
  request_id uuid primary key references private.match_consents(request_id) on delete cascade,
  conditions jsonb not null,
  retained_until timestamptz not null
);
create table private.member_cleanup_guard(
  singleton boolean primary key default true check(singleton),
  external_deletion_approved boolean not null default false
);
insert into private.member_cleanup_guard(singleton) values(true);
create table private.conversation_retention(
  request_id uuid primary key references public.join_requests(id) on delete cascade,
  procedure_closed_at timestamptz,
  purge_after timestamptz
);
-- 역사 party는 보존하고 실제 PII를 NULL로 삭제한다. Auth 삭제 cascade를 분리한다.
alter table public.profiles drop constraint profiles_id_fkey;
alter table public.profiles alter column real_name drop not null;
alter table public.profiles alter column birth_date drop not null;
create function private.profile_retired(p_profile_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.member_retirements where profile_id=p_profile_id);
$$;
create function private.assert_not_retired_caller()
returns void language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=auth.uid();e uuid;begin
  if auth.role()='authenticated' and u is not null then
    -- Naver callback과 동일하게 account→profile→episode 순서를 지킨다.
    perform 1 from private.naver_accounts where user_id=u order by subject for share;
    perform 1 from public.profiles where id=u for key share;
    -- 최초 사진 등록에는 아직 profile/episode가 없다.
    select id into e from private.member_episodes where profile_id=u and ended_at is null for share;
    if private.profile_retired(u) then raise exception 'account_retired' using errcode='42501';end if;
  end if;
end; $$;
create or replace function private.require_member_uid()
returns uuid language plpgsql volatile set search_path='' as $$
declare u uuid:=auth.uid();begin
  if u is null or coalesce(auth.role(),'')<>'authenticated' or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then
    raise exception 'login_required' using errcode='28000';end if;
  perform private.assert_not_retired_caller();
  return u;
end; $$;
create or replace function private.require_service_profile()
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_member_uid();begin
  if not exists(select 1 from public.profiles where id=u) then raise exception 'profile_required' using errcode='42501';end if;
  return u;
end; $$;
create function private.live_native_caller()
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=auth.uid();begin
  if auth.role()<>'authenticated' or u is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then return false;end if;
  perform 1 from private.naver_accounts where user_id=u order by subject for share;
  perform 1 from public.profiles where id=u for key share;
  perform 1 from private.member_episodes where profile_id=u and ended_at is null for share;
  return not private.profile_retired(u);
end; $$;
create function private.enforce_retired_profile_shape()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if private.profile_retired(new.id) then
    if new.real_name is not null or new.birth_date is not null or new.gender is not null or new.avatar_url is not null or new.bio is not null then
      raise exception 'retired_profile_pii' using errcode='42501';end if;
  elsif new.real_name is null or new.birth_date is null then
    raise exception 'active_profile_required' using errcode='23514';
  end if;
  return new;
end; $$;
create trigger retired_profile_shape before insert or update on public.profiles
  for each row execute function private.enforce_retired_profile_shape();
-- 동일 Naver subject의 안전 연결과 새 Auth 별칭을 분리한다.
-- 식별값의 최소 보관 종료 조건과 법적 근거는 별도 확인한다.
alter table private.naver_accounts alter column real_name drop not null;
alter table private.naver_accounts alter column birth_date drop not null;
alter table private.naver_accounts alter column gender drop not null;
-- 공개 동의 계약의 알려진 scalar/string-array key만 보관한다.
-- 정확 장소 key와 중첩 객체는 보관하지 않으며 자유문 가림 완료는 별도다.
alter table private.match_consents alter column condition_fingerprint drop not null;
create function private.public_retained_consent_body(p_conditions jsonb)
returns jsonb language sql immutable security definer set search_path='' as $$
  select coalesce(jsonb_object_agg(k,v),'{}'::jsonb) from jsonb_each(case when jsonb_typeof(p_conditions)='object' then p_conditions else '{}'::jsonb end) e(k,v)
  where (k in('postId','title','description','category','startsAt','endsAt','publicArea','costType','paymentDirection')
      and jsonb_typeof(v) in('string','null'))
    or (k='preferenceNote' and jsonb_typeof(v) in('string','null'))
    or (k='amount' and jsonb_typeof(v) in('number','null'))
    or (k='tags' and jsonb_typeof(v)='array' and not exists(
      select 1 from jsonb_array_elements(case when jsonb_typeof(v)='array' then v else '[]'::jsonb end) x where jsonb_typeof(x)<>'string'));
$$;
-- 기존 Naver trigger의 owner-only 내부 호출을 보존한다. 역할/사용자 ACL을 열지 않는다.
do $$ declare owner_name text;begin
  select pg_get_userbyid(proowner) into owner_name from pg_proc where oid='private.enforce_naver_new_activity()'::regprocedure;
  execute format('alter function private.public_retained_consent_body(jsonb) owner to %I',owner_name);
end $$;
create or replace function private.enforce_naver_new_activity()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_author uuid; v_requester uuid;
begin
  -- 정확한 탈퇴 개인정보 정리만 허용한다. 새 동의/수락·사용자 flag 우회가 아니다.
  if tg_table_schema='private' and tg_table_name='match_consents' and tg_op='UPDATE' then
    if private.profile_retired(auth.uid()) and private.request_role(new.request_id) is not null
      and row(new.request_id,new.condition_version,new.requested_by,new.requested_at,new.accepted_at)
        is not distinct from row(old.request_id,old.condition_version,old.requested_by,old.requested_at,old.accepted_at)
      and new.condition_fingerprint is null
      and new.conditions=private.public_retained_consent_body(old.conditions)||jsonb_build_object(
        'title','개인정보 가림 검토 중','description','개인정보 가림 검토 중','preferenceNote',null,'tags','[]'::jsonb) then
      return new;
    end if;
  end if;
  -- SECURITY DEFINER RPC 안에서도 실제 JWT 역할을 확인한다. 서비스 유지보수는 그대로 허용한다.
  if auth.role()='authenticated' then
    perform private.assert_naver_activity_allowed();
    if tg_table_name='appointments' then
      select p.author_id,r.requester_id into v_author,v_requester from public.posts p
        join public.join_requests r on r.post_id=p.id where p.id=new.post_id and r.id=new.join_request_id;
      perform private.assert_naver_member_qualified(v_author);
      perform private.assert_naver_member_qualified(v_requester);
    end if;
  end if;
  return new;
end; $$;
create function public.retire_my_account(p_withdrawal_id uuid)
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
-- 검증된 worker가 실제 Storage 삭제/재조회404와 Auth 삭제를 확인한 뒤 완료를 등록한다.
-- DB metadata 부재만으로 파일 삭제를 증명하지 않는다. 사용자 RPC에서는 완료 등록을 허용하지 않는다.
create function public.claim_member_cleanup_task(p_worker_run_token uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare t private.member_cleanup_tasks;n timestamptz;tok uuid:=gen_random_uuid();begin
  if not coalesce((select external_deletion_approved from private.member_cleanup_guard where singleton),false) then
    raise exception 'member_cleanup_not_approved' using errcode='55000';end if;
  perform private.assert_current_worker_run(p_worker_run_token);n:=clock_timestamp();
  select * into t from private.member_cleanup_tasks where state='pending' or (state='running' and lease_expires_at<=n)
    order by id for update skip locked limit 1;
  if not found then return null;end if;
  update private.member_cleanup_tasks set state='running',lease_token=tok,worker_run_token=p_worker_run_token,lease_expires_at=n+interval '60 seconds' where id=t.id;
  perform private.assert_current_worker_run(p_worker_run_token);
  return jsonb_build_object('taskId',t.id,'leaseToken',tok,'expiresAt',n+interval '60 seconds','kind',t.kind,
    'profileId',t.profile_id,'bucketId',t.bucket_id,'objectName',t.object_name,'objectId',t.object_id);
end; $$;
-- 외부 삭제 직전 재검사와 삭제 후 완료 재시도가 같은 정확 task를 사용한다.
-- 객체 부재 자체는 실패가 아니다. 같은 이름의 재생성 객체는 삭제하지 않는다.
create function public.check_member_cleanup_task(p_task_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_object_id uuid)
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
  if t.kind='storage_object' and exists(select 1 from storage.objects o
    where (o.id=t.object_id or (o.bucket_id=t.bucket_id and o.name=t.object_name))
      and (o.id is distinct from t.object_id or o.bucket_id is distinct from t.bucket_id or o.name is distinct from t.object_name
        or not (coalesce(o.owner_id=t.profile_id::text,false) or split_part(o.name,'/',1)=t.profile_id::text))) then
    raise exception 'state_conflict' using errcode='40001';end if;
  perform private.assert_current_worker_run(p_worker_run_token);
  return jsonb_build_object('taskId',t.id,'leaseToken',t.lease_token,'expiresAt',t.lease_expires_at,'kind',t.kind,
    'profileId',t.profile_id,'bucketId',t.bucket_id,'objectName',t.object_name,'objectId',t.object_id);
end; $$;
-- 실제 exact DELETE200 응답의 hash를 현재 lease에서 먼저 보관한다.
-- API 응답 소실 또는 여기 기록하기 전 장애는 증거 없는 실패로 남는다.
create function public.get_member_cleanup_delete_ack(p_task_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_object_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare t private.member_cleanup_tasks;a private.member_cleanup_delete_acks;begin
  perform public.check_member_cleanup_task(p_task_id,p_lease_token,p_worker_run_token,p_object_id);
  select * into t from private.member_cleanup_tasks where id=p_task_id;
  select * into a from private.member_cleanup_delete_acks where task_id=p_task_id;
  if not found then return null;end if;
  if a.withdrawal_id is distinct from t.withdrawal_id or a.profile_id is distinct from t.profile_id
    or a.kind is distinct from t.kind or a.object_id is distinct from t.object_id then
    raise exception 'state_conflict' using errcode='40001';end if;
  return jsonb_build_object('receiptId',a.receipt_id,'taskId',a.task_id,'kind',a.kind,'objectId',a.object_id,'evidenceSha256',a.ack_sha256);
end; $$;
create function public.record_member_cleanup_delete_ack(p_task_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_object_id uuid,p_ack_sha256 text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare t private.member_cleanup_tasks;result jsonb;begin
  perform public.check_member_cleanup_task(p_task_id,p_lease_token,p_worker_run_token,p_object_id);
  if p_ack_sha256 is null or p_ack_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'invalid_deletion_ack' using errcode='22023';end if;
  select * into t from private.member_cleanup_tasks where id=p_task_id;
  insert into private.member_cleanup_delete_acks(task_id,withdrawal_id,profile_id,kind,object_id,ack_sha256,recorded_lease_token,recorded_worker_run_token)
    values(t.id,t.withdrawal_id,t.profile_id,t.kind,t.object_id,p_ack_sha256,p_lease_token,p_worker_run_token) on conflict(task_id) do nothing;
  result:=public.get_member_cleanup_delete_ack(p_task_id,p_lease_token,p_worker_run_token,p_object_id);
  perform private.assert_current_worker_run(p_worker_run_token);
  return result;
end; $$;
create function public.complete_member_cleanup_task(p_task_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_object_id uuid,p_evidence_sha256 text)
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
  if t.kind='auth_user' and exists(select 1 from auth.users where id=t.profile_id) then raise exception 'auth_user_still_present' using errcode='40001';end if;
  update private.member_cleanup_tasks set state='completed',lease_token=null,worker_run_token=null,lease_expires_at=null,evidence_sha256=p_evidence_sha256,completed_at=clock_timestamp() where id=t.id;
  if not exists(select 1 from private.member_cleanup_tasks where withdrawal_id=t.withdrawal_id and state<>'completed') then
    update private.member_retirements set state='completed',completed_at=clock_timestamp() where withdrawal_id=t.withdrawal_id;
  end if;
  perform private.assert_current_worker_run(p_worker_run_token);
  return jsonb_build_object('status','applied');
end; $$;
-- 다음 부분은 ACL/RLS·공개 회원 RPC의 정적 가드와 역사 읽기 연결이다.
create table private.naver_identity_keys(
  id uuid primary key default gen_random_uuid(),
  subject text not null unique references private.naver_accounts(subject) on delete restrict
);
alter table private.member_episodes add column identity_id uuid references private.naver_identity_keys(id);
insert into private.naver_identity_keys(subject) select subject from private.naver_accounts;
update private.member_episodes e set identity_id=k.id from private.naver_accounts a join private.naver_identity_keys k on k.subject=a.subject where a.user_id=e.profile_id;
create unique index member_episodes_identity_active on private.member_episodes(identity_id) where ended_at is null and identity_id is not null;
create function private.member_safety_identity(p_profile_id uuid)
returns uuid language sql stable security definer set search_path='' as $$
  select identity_id from private.member_episodes where profile_id=p_profile_id order by started_at desc,id desc limit 1;
$$;
create function private.bind_member_identity()
returns trigger language plpgsql security definer set search_path='' as $$
declare u uuid;begin
  if tg_table_schema='public' then u:=new.id;
  else
    insert into private.naver_identity_keys(subject) values(new.subject) on conflict do nothing;
    u:=new.user_id;
  end if;
  update private.member_episodes e set identity_id=k.id from private.naver_accounts a join private.naver_identity_keys k on k.subject=a.subject
    where a.user_id=u and e.profile_id=u and e.ended_at is null;
  return new;
end; $$;
create trigger z_member_identity_profile after insert on public.profiles for each row execute function private.bind_member_identity();
create trigger member_identity_naver after insert or update of user_id on private.naver_accounts for each row execute function private.bind_member_identity();
create function private.lock_live_pair_episodes(p_a uuid,p_b uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  perform 1 from private.naver_accounts where user_id in(p_a,p_b) order by subject for share;
  perform 1 from public.profiles where id in(p_a,p_b) order by id for key share;
  perform 1 from private.member_episodes where profile_id in(p_a,p_b) and ended_at is null order by profile_id for share;
  if private.profile_retired(p_a) or private.profile_retired(p_b) then raise exception 'account_retired' using errcode='42501';end if;
end; $$;
create function private.lock_live_post_pair(p_post_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare a uuid;begin
  select author_id into a from public.posts where id=p_post_id;
  if a is not null then perform private.lock_live_pair_episodes(auth.uid(),a);end if;
end; $$;
create function private.lock_live_request_pair(p_request_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare a uuid;b uuid;begin
  select p.author_id,r.requester_id into a,b from public.join_requests r join public.posts p on p.id=r.post_id where r.id=p_request_id;
  if a is not null then perform private.lock_live_pair_episodes(a,b);end if;
end; $$;
create function private.live_post_ids(p_ids uuid[])
returns uuid[] language sql stable security definer set search_path='' as $$
  select coalesce(array_agg(id),'{}') from public.posts where id=any(p_ids) and not private.profile_retired(author_id);
$$;
create function private.require_active_public_profile(p_profile_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  perform 1 from private.naver_accounts where user_id=p_profile_id order by subject for share;
  perform 1 from public.profiles where id=p_profile_id for key share;
  perform 1 from private.member_episodes where profile_id=p_profile_id and ended_at is null for share;
  if private.profile_retired(p_profile_id) then raise exception 'profile_unavailable' using errcode='P0002';end if;
end; $$;
create or replace function private.review_belongs_current_episode(p_review_id uuid,p_profile_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select coalesce(private.active_member_episode(p_profile_id),
    (select episode_id from private.member_retirements where profile_id=p_profile_id))=
    case when rv.reviewer_id=p.author_id then ae.requester_episode_id else ae.author_episode_id end
    from public.appointment_reviews rv join public.appointments ap on ap.id=rv.appointment_id
    join public.posts p on p.id=ap.post_id join private.appointment_member_episodes ae on ae.appointment_id=ap.id
    where rv.id=p_review_id),false);
$$;
create function private.closed_conversation_retention_open(p_request_id uuid)
returns boolean language sql volatile security definer set search_path='' as $$
  select not exists(select 1 from private.conversation_retention where request_id=p_request_id)
    or coalesce((select purge_after is null or clock_timestamp()<purge_after from private.conversation_retention where request_id=p_request_id),true);
$$;
create function private.require_conversation_retention(p_request_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  if not private.closed_conversation_retention_open(p_request_id) then raise exception 'conversation_unavailable' using errcode='P0002';end if;
end; $$;
-- member shape/RLS object writes also close stale signed JWT native paths.
create function private.guard_native_storage_mutation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if auth.role()='authenticated' then perform private.require_member_uid();end if;
  if tg_op='DELETE' then return old;end if;return new;
end; $$;
create trigger a_retired_storage_mutation before insert or update or delete on storage.objects
  for each row execute function private.guard_native_storage_mutation();
create function private.retired_storage_target(p_owner_id text,p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.member_retirements r
    where r.profile_id::text=p_owner_id or r.profile_id::text=split_part(p_name,'/',1));
$$;
create policy retired_member_storage on storage.objects as restrictive for all to authenticated
  using(private.live_native_caller()) with check(private.live_native_caller());
create policy retired_target_storage on storage.objects as restrictive for select to authenticated
  using(bucket_id<>'profile-images' or (not private.retired_storage_target(owner_id,name)));
create policy retired_author_public_visibility on public.posts as restrictive for select to anon,authenticated
  using(not private.profile_retired(author_id));
create policy retired_conversation_retention on public.chat_messages as restrictive for select to authenticated
  using(private.closed_conversation_retention_open(join_request_id));
-- 명시한 회원 table에만 RLS를 추가한다. 일반 순수 함수·날짜 utility는 바꾸지 않는다.
do $$ declare t text;begin
  foreach t in array array['profiles','posts','join_requests','chat_messages','appointments','appointment_reviews',
    'appointment_completion_confirmations','appointment_disputes','post_private_details','notifications'] loop
    execute format('create policy retired_member_native_gate on public.%I as restrictive for all to authenticated using(private.live_native_caller()) with check(private.live_native_caller())',t);
  end loop;
end $$;


create function private.request_other_retired(p_request_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select private.profile_retired(case when j.requester_id=auth.uid() then p.author_id else j.requester_id end)
    from public.join_requests j join public.posts p on p.id=j.post_id where j.id=p_request_id),false);
$$;
create or replace function private.can_send_message(p_request_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.join_requests r join public.posts p on p.id=r.post_id
    where r.id=p_request_id and (r.requester_id=auth.uid() or p.author_id=auth.uid()) and p.status<>'deleted'
      and not private.profile_retired(p.author_id) and not private.profile_retired(r.requester_id)
      and not private.members_blocked(p.author_id,r.requester_id)
      and ((r.status='pending' and clock_timestamp()<p.starts_at) or (r.status='matched'
        and exists(select 1 from public.appointments ap where ap.join_request_id=r.id and ap.status<>'cancelled'))));
$$;
create function private.can_read_profile_image_before_member_retirement(p_bucket_id text,p_name text,p_owner_id text)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid; v_claims jsonb;
begin
  v_uid:=auth.uid(); v_claims:=coalesce(auth.jwt(),'{}'::jsonb);
  if v_uid is null or auth.role() is distinct from 'authenticated'
    or jsonb_typeof(v_claims) is distinct from 'object'
    or (v_claims?'is_anonymous' and v_claims->'is_anonymous' is distinct from 'false'::jsonb)
    or p_bucket_id is distinct from 'profile-images' or p_name is null or p_owner_id is null
  then return false; end if;
  -- Storage 행의 owner_id와 경로를 함께 확인한다. 임의 prefix나 다른 회원의 경로를 허용하지 않는다.
  if p_owner_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_name !~ ('^'||p_owner_id||'/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]jpg$')
  then return false; end if;
  -- 본인 신규 업로드/교체 전 사진은 가입 완료나 profiles 생성 전에 읽을 수 있어야 한다.
  if p_owner_id=v_uid::text then return true; end if;
  -- 기존 제한 회원도 profiles가 있으면 일반 읽기를 유지한다. 새 활동의 네이버 자격을 요구하지 않는다.
  if private.members_blocked(v_uid,p_owner_id::uuid) and not exists(
    select 1 from public.appointments ap join public.join_requests r on r.id=ap.join_request_id
      join public.posts p on p.id=ap.post_id where ap.status in('confirmed','disputed')
        and ((p.author_id=v_uid and r.requester_id=p_owner_id::uuid)
          or(p.author_id=p_owner_id::uuid and r.requester_id=v_uid))
  ) then return false; end if;
  return exists(select 1 from public.profiles viewer where viewer.id=v_uid)
    and exists(select 1 from public.profiles target where target.id::text=p_owner_id and target.avatar_url=p_name);
exception when invalid_text_representation then
  -- 잘못된 JWT UID/JSON은 접근을 거절한다. 그 외 DB 오류도 성공으로 대체하지 않는다.
  return false;
end; $$;
-- 기존 함수의 실제 소유자를 유지해 원본 helper를 owner-only로 호출한다.
do $$ declare owner_name text;begin
  select pg_get_userbyid(proowner) into owner_name from pg_proc where oid='private.can_read_profile_image(text,text,text)'::regprocedure;
  execute format('alter function private.can_read_profile_image_before_member_retirement(text,text,text) owner to %I',owner_name);
end $$;
revoke all on function private.can_read_profile_image_before_member_retirement(text,text,text) from public,anon,authenticated,service_role;
create or replace function private.can_read_profile_image(p_bucket_id text,p_name text,p_owner_id text)
returns boolean language sql stable security definer set search_path='' as $$
  select not private.profile_retired(auth.uid()) and not private.retired_storage_target(p_owner_id,p_name)
    and private.can_read_profile_image_before_member_retirement(p_bucket_id,p_name,p_owner_id);
$$;

-- 정적 회원 RPC: accept_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_condition_version text)
alter function public.accept_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_condition_version text) set schema private;
alter function private.accept_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_condition_version text) rename to accept_appointment_schedule_change_before_member_retirement;
revoke all on function private.accept_appointment_schedule_change_before_member_retirement(p_appointment_id uuid, p_change_id uuid, p_condition_version text) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.accept_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_condition_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.accept_appointment_schedule_change_before_member_retirement($1,$2,$3);
end;
$function$;

revoke all on function public.accept_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_condition_version text) from public,anon,authenticated,service_role;
grant execute on function public.accept_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_condition_version text) to authenticated;

-- 정적 회원 RPC: accept_match(p_request_id uuid, p_condition_version text)
alter function public.accept_match(p_request_id uuid, p_condition_version text) set schema private;
alter function private.accept_match(p_request_id uuid, p_condition_version text) rename to accept_match_before_member_retirement;
revoke all on function private.accept_match_before_member_retirement(p_request_id uuid, p_condition_version text) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.accept_match(p_request_id uuid, p_condition_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  perform private.lock_live_request_pair($1);
  return private.accept_match_before_member_retirement($1,$2);
end;
$function$;

revoke all on function public.accept_match(p_request_id uuid, p_condition_version text) from public,anon,authenticated,service_role;
grant execute on function public.accept_match(p_request_id uuid, p_condition_version text) to authenticated;

-- 정적 회원 RPC: block_member(p_target_id uuid)
alter function public.block_member(p_target_id uuid) set schema private;
alter function private.block_member(p_target_id uuid) rename to block_member_before_member_retirement;
revoke all on function private.block_member_before_member_retirement(p_target_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.block_member(p_target_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  -- 차단 INSERT의 target FK 잠금을 pair advisory보다 먼저 확보한다.
  perform 1 from public.profiles where id in(auth.uid(),$1) order by id for key share;
  return private.block_member_before_member_retirement($1);
end;
$function$;

revoke all on function public.block_member(p_target_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.block_member(p_target_id uuid) to authenticated;

-- 정적 회원 RPC: cancel_appointment(p_appointment_id uuid, p_cancellation_id uuid, p_reason text)
alter function public.cancel_appointment(p_appointment_id uuid, p_cancellation_id uuid, p_reason text) set schema private;
alter function private.cancel_appointment(p_appointment_id uuid, p_cancellation_id uuid, p_reason text) rename to cancel_appointment_before_member_retirement;
revoke all on function private.cancel_appointment_before_member_retirement(p_appointment_id uuid, p_cancellation_id uuid, p_reason text) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.cancel_appointment(p_appointment_id uuid, p_cancellation_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.cancel_appointment_before_member_retirement($1,$2,$3);
end;
$function$;

revoke all on function public.cancel_appointment(p_appointment_id uuid, p_cancellation_id uuid, p_reason text) from public,anon,authenticated,service_role;
grant execute on function public.cancel_appointment(p_appointment_id uuid, p_cancellation_id uuid, p_reason text) to authenticated;

-- 정적 회원 RPC: close_service_post(p_post_id uuid)
alter function public.close_service_post(p_post_id uuid) set schema private;
alter function private.close_service_post(p_post_id uuid) rename to close_service_post_before_member_retirement;
revoke all on function private.close_service_post_before_member_retirement(p_post_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.close_service_post(p_post_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.close_service_post_before_member_retirement($1);
end;
$function$;

revoke all on function public.close_service_post(p_post_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.close_service_post(p_post_id uuid) to authenticated;

-- 정적 회원 RPC: complete_naver_signup(p_avatar_path text, p_interests text[], p_conversation_styles text[], p_mbti text)
alter function public.complete_naver_signup(p_avatar_path text, p_interests text[], p_conversation_styles text[], p_mbti text) set schema private;
alter function private.complete_naver_signup(p_avatar_path text, p_interests text[], p_conversation_styles text[], p_mbti text) rename to complete_naver_signup_before_member_retirement;
revoke all on function private.complete_naver_signup_before_member_retirement(p_avatar_path text, p_interests text[], p_conversation_styles text[], p_mbti text) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.complete_naver_signup(p_avatar_path text, p_interests text[], p_conversation_styles text[], p_mbti text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- 가입 완료는 account를 갱신하므로 공유→배타 승격 없이 처음부터 배타 잠금을 잡는다.
  perform 1 from private.naver_accounts where user_id=auth.uid() order by subject for update;
  perform private.require_member_uid();
  return private.complete_naver_signup_before_member_retirement($1,$2,$3,$4);
end;
$function$;

revoke all on function public.complete_naver_signup(p_avatar_path text, p_interests text[], p_conversation_styles text[], p_mbti text) from public,anon,authenticated,service_role;
grant execute on function public.complete_naver_signup(p_avatar_path text, p_interests text[], p_conversation_styles text[], p_mbti text) to authenticated;

-- 정적 회원 RPC: confirm_appointment_completion(p_appointment_id uuid)
alter function public.confirm_appointment_completion(p_appointment_id uuid) set schema private;
alter function private.confirm_appointment_completion(p_appointment_id uuid) rename to confirm_appointment_completion_before_member_retirement;
revoke all on function private.confirm_appointment_completion_before_member_retirement(p_appointment_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.confirm_appointment_completion(p_appointment_id uuid)
 RETURNS TABLE(appointment_id uuid, status text, completed_at timestamp with time zone, completion_method text, my_confirmed_at timestamp with time zone, completion_notified_at timestamp with time zone, dispute_deadline_at timestamp with time zone, completed_by_me boolean, can_dispute boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select * from private.confirm_appointment_completion_before_member_retirement($1);
end;
$function$;

revoke all on function public.confirm_appointment_completion(p_appointment_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.confirm_appointment_completion(p_appointment_id uuid) to authenticated;

-- 정적 회원 RPC: create_service_post(p_post_id uuid, p_input jsonb)
alter function public.create_service_post(p_post_id uuid, p_input jsonb) set schema private;
alter function private.create_service_post(p_post_id uuid, p_input jsonb) rename to create_service_post_before_member_retirement;
revoke all on function private.create_service_post_before_member_retirement(p_post_id uuid, p_input jsonb) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.create_service_post(p_post_id uuid, p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.create_service_post_before_member_retirement($1,$2);
end;
$function$;

revoke all on function public.create_service_post(p_post_id uuid, p_input jsonb) from public,anon,authenticated,service_role;
grant execute on function public.create_service_post(p_post_id uuid, p_input jsonb) to authenticated;

-- 정적 회원 RPC: decline_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_condition_version text)
alter function public.decline_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_condition_version text) set schema private;
alter function private.decline_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_condition_version text) rename to decline_appointment_schedule_change_before_member_retirement;
revoke all on function private.decline_appointment_schedule_change_before_member_retirement(p_appointment_id uuid, p_change_id uuid, p_condition_version text) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.decline_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_condition_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.decline_appointment_schedule_change_before_member_retirement($1,$2,$3);
end;
$function$;

revoke all on function public.decline_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_condition_version text) from public,anon,authenticated,service_role;
grant execute on function public.decline_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_condition_version text) to authenticated;

-- 정적 회원 RPC: decline_join_request(p_request_id uuid)
alter function public.decline_join_request(p_request_id uuid) set schema private;
alter function private.decline_join_request(p_request_id uuid) rename to decline_join_request_before_member_retirement;
revoke all on function private.decline_join_request_before_member_retirement(p_request_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.decline_join_request(p_request_id uuid)
 RETURNS TABLE(id uuid, status text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select * from private.decline_join_request_before_member_retirement($1);
end;
$function$;

revoke all on function public.decline_join_request(p_request_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.decline_join_request(p_request_id uuid) to authenticated;

-- 정적 회원 RPC: decline_match_consent(p_request_id uuid, p_condition_version text)
alter function public.decline_match_consent(p_request_id uuid, p_condition_version text) set schema private;
alter function private.decline_match_consent(p_request_id uuid, p_condition_version text) rename to decline_match_consent_before_member_retirement;
revoke all on function private.decline_match_consent_before_member_retirement(p_request_id uuid, p_condition_version text) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.decline_match_consent(p_request_id uuid, p_condition_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.decline_match_consent_before_member_retirement($1,$2);
end;
$function$;

revoke all on function public.decline_match_consent(p_request_id uuid, p_condition_version text) from public,anon,authenticated,service_role;
grant execute on function public.decline_match_consent(p_request_id uuid, p_condition_version text) to authenticated;

-- 정적 회원 RPC: delete_service_post(p_post_id uuid)
alter function public.delete_service_post(p_post_id uuid) set schema private;
alter function private.delete_service_post(p_post_id uuid) rename to delete_service_post_before_member_retirement;
revoke all on function private.delete_service_post_before_member_retirement(p_post_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.delete_service_post(p_post_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.delete_service_post_before_member_retirement($1);
end;
$function$;

revoke all on function public.delete_service_post(p_post_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.delete_service_post(p_post_id uuid) to authenticated;

-- 정적 회원 RPC: get_appointment_change_state(p_appointment_id uuid)
alter function public.get_appointment_change_state(p_appointment_id uuid) set schema private;
alter function private.get_appointment_change_state(p_appointment_id uuid) rename to get_appointment_change_state_before_member_retirement;
revoke all on function private.get_appointment_change_state_before_member_retirement(p_appointment_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_appointment_change_state(p_appointment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.get_appointment_change_state_before_member_retirement($1);
end;
$function$;

revoke all on function public.get_appointment_change_state(p_appointment_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_appointment_change_state(p_appointment_id uuid) to authenticated;

-- 정적 회원 RPC: get_appointment_review_state(p_appointment_id uuid)
alter function public.get_appointment_review_state(p_appointment_id uuid) set schema private;
alter function private.get_appointment_review_state(p_appointment_id uuid) rename to get_appointment_review_state_before_member_retirement;
revoke all on function private.get_appointment_review_state_before_member_retirement(p_appointment_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_appointment_review_state(p_appointment_id uuid)
 RETURNS TABLE(appointment_id uuid, appointment_completed boolean, deadline_at timestamp with time zone, hold_until timestamp with time zone, disputed boolean, can_write boolean, own_review jsonb, peer_submitted boolean, released boolean, release_reason text, peer_review jsonb, server_now timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select * from private.get_appointment_review_state_before_member_retirement($1);
end;
$function$;

revoke all on function public.get_appointment_review_state(p_appointment_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_appointment_review_state(p_appointment_id uuid) to authenticated;

-- 정적 회원 RPC: get_appointment_state(p_appointment_id uuid)
alter function public.get_appointment_state(p_appointment_id uuid) set schema private;
alter function private.get_appointment_state(p_appointment_id uuid) rename to get_appointment_state_before_member_retirement;
revoke all on function private.get_appointment_state_before_member_retirement(p_appointment_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_appointment_state(p_appointment_id uuid)
 RETURNS TABLE(appointment_id uuid, join_request_id uuid, my_role text, status text, confirmed_at timestamp with time zone, completed_at timestamp with time zone, completion_method text, completion_notified_at timestamp with time zone, dispute_deadline_at timestamp with time zone, completed_by_me boolean, can_dispute boolean, dispute_status text, post_id uuid, post_title text, post_starts_at timestamp with time zone, post_ends_at timestamp with time zone, post_public_area text, counterpart_masked_name text, counterpart_avatar_url text, my_completion_at timestamp with time zone, peer_completion_at timestamp with time zone, can_confirm_completion boolean, server_now timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select * from private.get_appointment_state_before_member_retirement($1);
end;
$function$;

revoke all on function public.get_appointment_state(p_appointment_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_appointment_state(p_appointment_id uuid) to authenticated;

-- 정적 회원 RPC: get_conversation(p_request_id uuid)
alter function public.get_conversation(p_request_id uuid) set schema private;
alter function private.get_conversation(p_request_id uuid) rename to get_conversation_before_member_retirement;
revoke all on function private.get_conversation_before_member_retirement(p_request_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_conversation(p_request_id uuid)
 RETURNS TABLE(request_id uuid, my_role text, request_status text, request_message text, request_created_at timestamp with time zone, post_id uuid, post_title text, post_starts_at timestamp with time zone, post_ends_at timestamp with time zone, post_public_area text, post_status text, counterpart_masked_name text, counterpart_avatar_url text, can_send boolean, appointment_id uuid, server_now timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  perform private.require_conversation_retention($1);
  return query select q.request_id,q.my_role,q.request_status,q.request_message,q.request_created_at,q.post_id,q.post_title,q.post_starts_at,q.post_ends_at,q.post_public_area,q.post_status,case when private.request_other_retired(q.request_id) then '탈퇴한 사용자입니다.' else q.counterpart_masked_name end,case when private.request_other_retired(q.request_id) then null else q.counterpart_avatar_url end,case when private.request_other_retired(q.request_id) then false else q.can_send end,q.appointment_id,q.server_now from private.get_conversation_before_member_retirement($1) q;
end;
$function$;

revoke all on function public.get_conversation(p_request_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_conversation(p_request_id uuid) to authenticated;

-- 정적 회원 RPC: get_match_consent(p_request_id uuid)
alter function public.get_match_consent(p_request_id uuid) set schema private;
alter function private.get_match_consent(p_request_id uuid) rename to get_match_consent_before_member_retirement;
revoke all on function private.get_match_consent_before_member_retirement(p_request_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_match_consent(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.get_match_consent_before_member_retirement($1);
end;
$function$;

revoke all on function public.get_match_consent(p_request_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_match_consent(p_request_id uuid) to authenticated;

-- 정적 회원 RPC: get_my_profile()
alter function public.get_my_profile() set schema private;
alter function private.get_my_profile() rename to get_my_profile_before_member_retirement;
revoke all on function private.get_my_profile_before_member_retirement() from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_my_profile()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.get_my_profile_before_member_retirement();
end;
$function$;

revoke all on function public.get_my_profile() from public,anon,authenticated,service_role;
grant execute on function public.get_my_profile() to authenticated;

-- 정적 회원 RPC: get_my_profile_traits()
alter function public.get_my_profile_traits() set schema private;
alter function private.get_my_profile_traits() rename to get_my_profile_traits_before_member_retirement;
revoke all on function private.get_my_profile_traits_before_member_retirement() from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_my_profile_traits()
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.get_my_profile_traits_before_member_retirement();
end;
$function$;

revoke all on function public.get_my_profile_traits() from public,anon,authenticated,service_role;
grant execute on function public.get_my_profile_traits() to authenticated;

-- 정적 회원 RPC: get_naver_signup_state()
alter function public.get_naver_signup_state() set schema private;
alter function private.get_naver_signup_state() rename to get_naver_signup_state_before_member_retirement;
revoke all on function private.get_naver_signup_state_before_member_retirement() from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_naver_signup_state()
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_member_uid();
  return private.get_naver_signup_state_before_member_retirement();
end;
$function$;

revoke all on function public.get_naver_signup_state() from public,anon,authenticated,service_role;
grant execute on function public.get_naver_signup_state() to authenticated;

-- 정적 회원 RPC: get_or_create_my_referral_code()
alter function public.get_or_create_my_referral_code() set schema private;
alter function private.get_or_create_my_referral_code() rename to get_or_create_my_referral_code_before_member_retirement;
revoke all on function private.get_or_create_my_referral_code_before_member_retirement() from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_or_create_my_referral_code()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.get_or_create_my_referral_code_before_member_retirement();
end;
$function$;

revoke all on function public.get_or_create_my_referral_code() from public,anon,authenticated,service_role;
grant execute on function public.get_or_create_my_referral_code() to authenticated;

-- 정적 회원 RPC: get_post_author_cards(p_post_ids uuid[])
alter function public.get_post_author_cards(p_post_ids uuid[]) set schema private;
alter function private.get_post_author_cards(p_post_ids uuid[]) rename to get_post_author_cards_before_member_retirement;
revoke all on function private.get_post_author_cards_before_member_retirement(p_post_ids uuid[]) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_post_author_cards(p_post_ids uuid[])
 RETURNS TABLE(post_id uuid, author_id uuid, masked_name text, avatar_url text)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_member_uid();
  if not exists(select 1 from public.profiles where id=auth.uid()) then raise exception 'profile_unavailable' using errcode='P0002';end if;
  return query select * from private.get_post_author_cards_before_member_retirement(private.live_post_ids($1));
end;
$function$;

revoke all on function public.get_post_author_cards(p_post_ids uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.get_post_author_cards(p_post_ids uuid[]) to authenticated;

-- 정적 회원 RPC: get_post_author_discovery_cards(p_post_ids uuid[])
alter function public.get_post_author_discovery_cards(p_post_ids uuid[]) set schema private;
alter function private.get_post_author_discovery_cards(p_post_ids uuid[]) rename to get_post_author_discovery_cards_before_member_retirement;
revoke all on function private.get_post_author_discovery_cards_before_member_retirement(p_post_ids uuid[]) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_post_author_discovery_cards(p_post_ids uuid[])
 RETURNS TABLE(post_id uuid, author_id uuid, masked_name text, avatar_url text, gender text, age integer)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_member_uid();
  if not exists(select 1 from public.profiles where id=auth.uid()) then raise exception 'profile_unavailable' using errcode='P0002';end if;
  return query select * from private.get_post_author_discovery_cards_before_member_retirement(private.live_post_ids($1));
end;
$function$;

revoke all on function public.get_post_author_discovery_cards(p_post_ids uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.get_post_author_discovery_cards(p_post_ids uuid[]) to authenticated;

-- 정적 회원 RPC: get_post_author_profile(p_post_id uuid)
alter function public.get_post_author_profile(p_post_id uuid) set schema private;
alter function private.get_post_author_profile(p_post_id uuid) rename to get_post_author_profile_before_member_retirement;
revoke all on function private.get_post_author_profile_before_member_retirement(p_post_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_post_author_profile(p_post_id uuid)
 RETURNS TABLE(masked_name text, gender text, age integer, avatar_url text, bio text)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_member_uid();
  if not exists(select 1 from public.profiles where id=auth.uid()) then raise exception 'profile_unavailable' using errcode='P0002';end if;
  if not exists(select 1 from public.posts where id=$1 and not private.profile_retired(author_id)) then raise exception 'profile_unavailable' using errcode='P0002';end if;
  return query select * from private.get_post_author_profile_before_member_retirement($1);
end;
$function$;

revoke all on function public.get_post_author_profile(p_post_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_post_author_profile(p_post_id uuid) to authenticated;

-- 정적 회원 RPC: get_post_author_traits(p_post_ids uuid[])
alter function public.get_post_author_traits(p_post_ids uuid[]) set schema private;
alter function private.get_post_author_traits(p_post_ids uuid[]) rename to get_post_author_traits_before_member_retirement;
revoke all on function private.get_post_author_traits_before_member_retirement(p_post_ids uuid[]) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_post_author_traits(p_post_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.get_post_author_traits_before_member_retirement(private.live_post_ids($1));
end;
$function$;

revoke all on function public.get_post_author_traits(p_post_ids uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.get_post_author_traits(p_post_ids uuid[]) to authenticated;

-- 정적 회원 RPC: get_public_profile(p_profile_id uuid)
alter function public.get_public_profile(p_profile_id uuid) set schema private;
alter function private.get_public_profile(p_profile_id uuid) rename to get_public_profile_before_member_retirement;
revoke all on function private.get_public_profile_before_member_retirement(p_profile_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_public_profile(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  perform private.require_active_public_profile($1);
  return private.get_public_profile_before_member_retirement($1);
end;
$function$;

revoke all on function public.get_public_profile(p_profile_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_public_profile(p_profile_id uuid) to authenticated;

-- 정적 회원 RPC: get_public_profile_reviews(p_profile_id uuid, p_limit integer, p_before uuid)
alter function public.get_public_profile_reviews(p_profile_id uuid, p_limit integer, p_before uuid) set schema private;
alter function private.get_public_profile_reviews(p_profile_id uuid, p_limit integer, p_before uuid) rename to get_public_profile_reviews_before_member_retirement;
revoke all on function private.get_public_profile_reviews_before_member_retirement(p_profile_id uuid, p_limit integer, p_before uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_public_profile_reviews(p_profile_id uuid, p_limit integer, p_before uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.get_public_profile_reviews_before_member_retirement($1,$2,$3);
end;
$function$;

revoke all on function public.get_public_profile_reviews(p_profile_id uuid, p_limit integer, p_before uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_public_profile_reviews(p_profile_id uuid, p_limit integer, p_before uuid) to authenticated;

-- 정적 회원 RPC: get_request_counterpart_profile(p_request_id uuid)
alter function public.get_request_counterpart_profile(p_request_id uuid) set schema private;
alter function private.get_request_counterpart_profile(p_request_id uuid) rename to get_request_counterpart_profile_before_member_retirement;
revoke all on function private.get_request_counterpart_profile_before_member_retirement(p_request_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_request_counterpart_profile(p_request_id uuid)
 RETURNS TABLE(masked_name text, age integer, avatar_url text, bio text)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select case when private.request_other_retired($1) then '탈퇴한 사용자입니다.' else q.masked_name end,case when private.request_other_retired($1) then null else q.age end,case when private.request_other_retired($1) then null else q.avatar_url end,case when private.request_other_retired($1) then null else q.bio end from private.get_request_counterpart_profile_before_member_retirement($1) q;
end;
$function$;

revoke all on function public.get_request_counterpart_profile(p_request_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_request_counterpart_profile(p_request_id uuid) to authenticated;

-- 정적 회원 RPC: get_review_praise_catalog()
alter function public.get_review_praise_catalog() set schema private;
alter function private.get_review_praise_catalog() rename to get_review_praise_catalog_before_member_retirement;
revoke all on function private.get_review_praise_catalog_before_member_retirement() from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_review_praise_catalog()
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.get_review_praise_catalog_before_member_retirement();
end;
$function$;

revoke all on function public.get_review_praise_catalog() from public,anon,authenticated,service_role;
grant execute on function public.get_review_praise_catalog() to authenticated;

-- 정적 회원 RPC: get_service_post(p_post_id uuid)
alter function public.get_service_post(p_post_id uuid) set schema private;
alter function private.get_service_post(p_post_id uuid) rename to get_service_post_before_member_retirement;
revoke all on function private.get_service_post_before_member_retirement(p_post_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_service_post(p_post_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb;names jsonb;begin
  perform private.assert_not_retired_caller();
  if exists(select 1 from public.posts p where p.id=$1 and private.profile_retired(p.author_id)) then
    if auth.uid() is null or not exists(select 1 from public.join_requests j where j.post_id=$1 and j.requester_id=auth.uid())
      or not exists(select 1 from private.retired_post_retention where post_id=$1 and retained_until>clock_timestamp()) then
      raise exception 'post_unavailable' using errcode='P0002';end if;
  end if;
  result:=private.get_service_post_before_member_retirement($1);
  if exists(select 1 from public.posts where id=$1 and private.profile_retired(author_id)) then
    result:=result||jsonb_build_object('authorDisplayName','탈퇴한 사용자입니다.');
  end if;
  if jsonb_typeof(result->'participantNames')='array' then
    select jsonb_agg(case when private.profile_retired((n->>'userId')::uuid) then n||jsonb_build_object('realName','탈퇴한 사용자입니다.') else n end)
      into names from jsonb_array_elements(result->'participantNames') n;
    result:=result||jsonb_build_object('participantNames',names);
  end if;
  return result;
end;
$function$;

revoke all on function public.get_service_post(p_post_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_service_post(p_post_id uuid) to authenticated,anon;

-- 정적 회원 RPC: get_visible_review_summary(p_profile_id uuid)
alter function public.get_visible_review_summary(p_profile_id uuid) set schema private;
alter function private.get_visible_review_summary(p_profile_id uuid) rename to get_visible_review_summary_before_member_retirement;
revoke all on function private.get_visible_review_summary_before_member_retirement(p_profile_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_visible_review_summary(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  perform private.require_active_public_profile($1);
  return private.get_visible_review_summary_before_member_retirement($1);
end;
$function$;

revoke all on function public.get_visible_review_summary(p_profile_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_visible_review_summary(p_profile_id uuid) to authenticated;

-- 정적 회원 RPC: leave_conversation(p_request_id uuid)
alter function public.leave_conversation(p_request_id uuid) set schema private;
alter function private.leave_conversation(p_request_id uuid) rename to leave_conversation_before_member_retirement;
revoke all on function private.leave_conversation_before_member_retirement(p_request_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.leave_conversation(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.leave_conversation_before_member_retirement($1);
end;
$function$;

revoke all on function public.leave_conversation(p_request_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.leave_conversation(p_request_id uuid) to authenticated;

-- 정적 회원 RPC: list_conversation_messages(p_request_id uuid, p_limit integer, p_before uuid)
alter function public.list_conversation_messages(p_request_id uuid, p_limit integer, p_before uuid) set schema private;
alter function private.list_conversation_messages(p_request_id uuid, p_limit integer, p_before uuid) rename to list_conversation_messages_before_member_retirement;
revoke all on function private.list_conversation_messages_before_member_retirement(p_request_id uuid, p_limit integer, p_before uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.list_conversation_messages(p_request_id uuid, p_limit integer, p_before uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  perform private.require_conversation_retention($1);
  return private.list_conversation_messages_before_member_retirement($1,$2,$3);
end;
$function$;

revoke all on function public.list_conversation_messages(p_request_id uuid, p_limit integer, p_before uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_conversation_messages(p_request_id uuid, p_limit integer, p_before uuid) to authenticated;

-- 정적 회원 RPC: list_conversations()
alter function public.list_conversations() set schema private;
alter function private.list_conversations() rename to list_conversations_before_member_retirement;
revoke all on function private.list_conversations_before_member_retirement() from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.list_conversations()
 RETURNS TABLE(request_id uuid, my_role text, request_status text, post_id uuid, post_title text, post_starts_at timestamp with time zone, counterpart_masked_name text, counterpart_avatar_url text, last_message text, last_message_at timestamp with time zone, last_activity_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select q.request_id,q.my_role,q.request_status,q.post_id,q.post_title,q.post_starts_at,case when private.request_other_retired(q.request_id) then '탈퇴한 사용자입니다.' else q.counterpart_masked_name end,case when private.request_other_retired(q.request_id) then null else q.counterpart_avatar_url end,q.last_message,q.last_message_at,q.last_activity_at from private.list_conversations_before_member_retirement() q where private.closed_conversation_retention_open(q.request_id);
end;
$function$;

revoke all on function public.list_conversations() from public,anon,authenticated,service_role;
grant execute on function public.list_conversations() to authenticated;

-- 정적 회원 RPC: list_my_appointments()
alter function public.list_my_appointments() set schema private;
alter function private.list_my_appointments() rename to list_my_appointments_before_member_retirement;
revoke all on function private.list_my_appointments_before_member_retirement() from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.list_my_appointments()
 RETURNS TABLE(appointment_id uuid, post_id uuid, join_request_id uuid, my_role text, status text, confirmed_at timestamp with time zone, post_title text, post_starts_at timestamp with time zone, post_ends_at timestamp with time zone, post_public_area text, counterpart_masked_name text, counterpart_avatar_url text, server_now timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select q.appointment_id,q.post_id,q.join_request_id,q.my_role,q.status,q.confirmed_at,q.post_title,q.post_starts_at,q.post_ends_at,q.post_public_area,case when private.request_other_retired(q.join_request_id) then '탈퇴한 사용자입니다.' else q.counterpart_masked_name end,case when private.request_other_retired(q.join_request_id) then null else q.counterpart_avatar_url end,q.server_now from private.list_my_appointments_before_member_retirement() q;
end;
$function$;

revoke all on function public.list_my_appointments() from public,anon,authenticated,service_role;
grant execute on function public.list_my_appointments() to authenticated;

-- 정적 회원 RPC: list_my_blocks(p_limit integer, p_before uuid)
alter function public.list_my_blocks(p_limit integer, p_before uuid) set schema private;
alter function private.list_my_blocks(p_limit integer, p_before uuid) rename to list_my_blocks_before_member_retirement;
revoke all on function private.list_my_blocks_before_member_retirement(p_limit integer, p_before uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.list_my_blocks(p_limit integer DEFAULT 20, p_before uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.list_my_blocks_before_member_retirement($1,$2);
end;
$function$;

revoke all on function public.list_my_blocks(p_limit integer, p_before uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_my_blocks(p_limit integer, p_before uuid) to authenticated;

-- 정적 회원 RPC: list_my_notifications(p_limit integer, p_before uuid)
alter function public.list_my_notifications(p_limit integer, p_before uuid) set schema private;
alter function private.list_my_notifications(p_limit integer, p_before uuid) rename to list_my_notifications_before_member_retirement;
revoke all on function private.list_my_notifications_before_member_retirement(p_limit integer, p_before uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.list_my_notifications(p_limit integer, p_before uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.list_my_notifications_before_member_retirement($1,$2);
end;
$function$;

revoke all on function public.list_my_notifications(p_limit integer, p_before uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_my_notifications(p_limit integer, p_before uuid) to authenticated;

-- 정적 회원 RPC: list_received_join_requests()
alter function public.list_received_join_requests() set schema private;
alter function private.list_received_join_requests() rename to list_received_join_requests_before_member_retirement;
revoke all on function private.list_received_join_requests_before_member_retirement() from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.list_received_join_requests()
 RETURNS TABLE(id uuid, post_id uuid, post_title text, post_starts_at timestamp with time zone, post_status text, requester_masked_name text, requester_age integer, requester_avatar_url text, message text, status text, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select * from private.list_received_join_requests_before_member_retirement();
end;
$function$;

revoke all on function public.list_received_join_requests() from public,anon,authenticated,service_role;
grant execute on function public.list_received_join_requests() to authenticated;

-- 정적 회원 RPC: list_sent_join_requests()
alter function public.list_sent_join_requests() set schema private;
alter function private.list_sent_join_requests() rename to list_sent_join_requests_before_member_retirement;
revoke all on function private.list_sent_join_requests_before_member_retirement() from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.list_sent_join_requests()
 RETURNS TABLE(id uuid, post_id uuid, post_title text, post_starts_at timestamp with time zone, post_ends_at timestamp with time zone, post_public_area text, post_status text, author_masked_name text, message text, status text, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select * from private.list_sent_join_requests_before_member_retirement();
end;
$function$;

revoke all on function public.list_sent_join_requests() from public,anon,authenticated,service_role;
grant execute on function public.list_sent_join_requests() to authenticated;

-- 정적 회원 RPC: mark_all_my_notifications_read()
alter function public.mark_all_my_notifications_read() set schema private;
alter function private.mark_all_my_notifications_read() rename to mark_all_my_notifications_read_before_member_retirement;
revoke all on function private.mark_all_my_notifications_read_before_member_retirement() from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.mark_all_my_notifications_read()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  perform private.mark_all_my_notifications_read_before_member_retirement();
  return;
end;
$function$;

revoke all on function public.mark_all_my_notifications_read() from public,anon,authenticated,service_role;
grant execute on function public.mark_all_my_notifications_read() to authenticated;

-- 정적 회원 RPC: mark_my_notification_read(p_notification_id uuid)
alter function public.mark_my_notification_read(p_notification_id uuid) set schema private;
alter function private.mark_my_notification_read(p_notification_id uuid) rename to mark_my_notification_read_before_member_retirement;
revoke all on function private.mark_my_notification_read_before_member_retirement(p_notification_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.mark_my_notification_read(p_notification_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  perform private.mark_my_notification_read_before_member_retirement($1);
  return;
end;
$function$;

revoke all on function public.mark_my_notification_read(p_notification_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.mark_my_notification_read(p_notification_id uuid) to authenticated;

-- 정적 회원 RPC: propose_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_expected_updated_at timestamp with time zone)
alter function public.propose_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_expected_updated_at timestamp with time zone) set schema private;
alter function private.propose_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_expected_updated_at timestamp with time zone) rename to propose_appointment_schedule_change_before_member_retirement;
revoke all on function private.propose_appointment_schedule_change_before_member_retirement(p_appointment_id uuid, p_change_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_expected_updated_at timestamp with time zone) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.propose_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_expected_updated_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.propose_appointment_schedule_change_before_member_retirement($1,$2,$3,$4,$5);
end;
$function$;

revoke all on function public.propose_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_expected_updated_at timestamp with time zone) from public,anon,authenticated,service_role;
grant execute on function public.propose_appointment_schedule_change(p_appointment_id uuid, p_change_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_expected_updated_at timestamp with time zone) to authenticated;

-- 정적 회원 RPC: propose_match(p_request_id uuid)
alter function public.propose_match(p_request_id uuid) set schema private;
alter function private.propose_match(p_request_id uuid) rename to propose_match_before_member_retirement;
revoke all on function private.propose_match_before_member_retirement(p_request_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.propose_match(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  perform private.lock_live_request_pair($1);
  return private.propose_match_before_member_retirement($1);
end;
$function$;

revoke all on function public.propose_match(p_request_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.propose_match(p_request_id uuid) to authenticated;

-- 정적 회원 RPC: raise_appointment_dispute(p_appointment_id uuid, p_reason text)
alter function public.raise_appointment_dispute(p_appointment_id uuid, p_reason text) set schema private;
alter function private.raise_appointment_dispute(p_appointment_id uuid, p_reason text) rename to raise_appointment_dispute_before_member_retirement;
revoke all on function private.raise_appointment_dispute_before_member_retirement(p_appointment_id uuid, p_reason text) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.raise_appointment_dispute(p_appointment_id uuid, p_reason text)
 RETURNS TABLE(appointment_id uuid, status text, raised_at timestamp with time zone, review_deadline_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select * from private.raise_appointment_dispute_before_member_retirement($1,$2);
end;
$function$;

revoke all on function public.raise_appointment_dispute(p_appointment_id uuid, p_reason text) from public,anon,authenticated,service_role;
grant execute on function public.raise_appointment_dispute(p_appointment_id uuid, p_reason text) to authenticated;

-- 정적 회원 RPC: reopen_service_post(p_post_id uuid)
alter function public.reopen_service_post(p_post_id uuid) set schema private;
alter function private.reopen_service_post(p_post_id uuid) rename to reopen_service_post_before_member_retirement;
revoke all on function private.reopen_service_post_before_member_retirement(p_post_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.reopen_service_post(p_post_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.reopen_service_post_before_member_retirement($1);
end;
$function$;

revoke all on function public.reopen_service_post(p_post_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.reopen_service_post(p_post_id uuid) to authenticated;

-- 정적 회원 RPC: request_service_post(p_post_id uuid, p_message_id uuid, p_message text)
alter function public.request_service_post(p_post_id uuid, p_message_id uuid, p_message text) set schema private;
alter function private.request_service_post(p_post_id uuid, p_message_id uuid, p_message text) rename to request_service_post_before_member_retirement;
revoke all on function private.request_service_post_before_member_retirement(p_post_id uuid, p_message_id uuid, p_message text) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.request_service_post(p_post_id uuid, p_message_id uuid, p_message text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  if not exists(select 1 from private.first_chat_applications f join public.chat_messages m on m.id=f.message_id join public.join_requests r on r.id=f.request_id where f.message_id=$2 and m.sender_id=auth.uid() and r.post_id=$1 and m.content=btrim($3)) then perform private.lock_live_post_pair($1);end if;
  return private.request_service_post_before_member_retirement($1,$2,$3);
end;
$function$;

revoke all on function public.request_service_post(p_post_id uuid, p_message_id uuid, p_message text) from public,anon,authenticated,service_role;
grant execute on function public.request_service_post(p_post_id uuid, p_message_id uuid, p_message text) to authenticated;

-- 정적 회원 RPC: search_public_posts(p_query text, p_date date, p_category text, p_area text, p_after_starts_at timestamp with time zone, p_after_id uuid, p_limit integer)
alter function public.search_public_posts(p_query text, p_date date, p_category text, p_area text, p_after_starts_at timestamp with time zone, p_after_id uuid, p_limit integer) set schema private;
alter function private.search_public_posts(p_query text, p_date date, p_category text, p_area text, p_after_starts_at timestamp with time zone, p_after_id uuid, p_limit integer) rename to search_public_posts_before_member_retirement;
revoke all on function private.search_public_posts_before_member_retirement(p_query text, p_date date, p_category text, p_area text, p_after_starts_at timestamp with time zone, p_after_id uuid, p_limit integer) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.search_public_posts(p_query text DEFAULT NULL::text, p_date date DEFAULT NULL::date, p_category text DEFAULT NULL::text, p_area text DEFAULT NULL::text, p_after_starts_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.assert_not_retired_caller();
  return private.search_public_posts_before_member_retirement($1,$2,$3,$4,$5,$6,$7);
end;
$function$;

revoke all on function public.search_public_posts(p_query text, p_date date, p_category text, p_area text, p_after_starts_at timestamp with time zone, p_after_id uuid, p_limit integer) from public,anon,authenticated,service_role;
grant execute on function public.search_public_posts(p_query text, p_date date, p_category text, p_area text, p_after_starts_at timestamp with time zone, p_after_id uuid, p_limit integer) to authenticated,anon;

-- 정적 회원 RPC: search_public_posts_v2(p_contract_version text, p_region text, p_filters jsonb, p_cursor jsonb, p_limit integer)
alter function public.search_public_posts_v2(p_contract_version text, p_region text, p_filters jsonb, p_cursor jsonb, p_limit integer) set schema private;
alter function private.search_public_posts_v2(p_contract_version text, p_region text, p_filters jsonb, p_cursor jsonb, p_limit integer) rename to search_public_posts_v2_before_member_retirement;
revoke all on function private.search_public_posts_v2_before_member_retirement(p_contract_version text, p_region text, p_filters jsonb, p_cursor jsonb, p_limit integer) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.search_public_posts_v2(p_contract_version text, p_region text, p_filters jsonb, p_cursor jsonb, p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.assert_not_retired_caller();
  return private.search_public_posts_v2_before_member_retirement($1,$2,$3,$4,$5);
end;
$function$;

revoke all on function public.search_public_posts_v2(p_contract_version text, p_region text, p_filters jsonb, p_cursor jsonb, p_limit integer) from public,anon,authenticated,service_role;
grant execute on function public.search_public_posts_v2(p_contract_version text, p_region text, p_filters jsonb, p_cursor jsonb, p_limit integer) to authenticated,anon;

-- 정적 회원 RPC: send_conversation_message(p_request_id uuid, p_message_id uuid, p_content text)
alter function public.send_conversation_message(p_request_id uuid, p_message_id uuid, p_content text) set schema private;
alter function private.send_conversation_message(p_request_id uuid, p_message_id uuid, p_content text) rename to send_conversation_message_before_member_retirement;
revoke all on function private.send_conversation_message_before_member_retirement(p_request_id uuid, p_message_id uuid, p_content text) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.send_conversation_message(p_request_id uuid, p_message_id uuid, p_content text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  if not exists(select 1 from public.chat_messages m where m.id=$2 and m.join_request_id=$1 and m.sender_id=auth.uid() and m.content=btrim($3)) then perform private.lock_live_request_pair($1);end if;
  return private.send_conversation_message_before_member_retirement($1,$2,$3);
end;
$function$;

revoke all on function public.send_conversation_message(p_request_id uuid, p_message_id uuid, p_content text) from public,anon,authenticated,service_role;
grant execute on function public.send_conversation_message(p_request_id uuid, p_message_id uuid, p_content text) to authenticated;

-- 정적 회원 RPC: set_my_profile_avatar(p_avatar_path text)
alter function public.set_my_profile_avatar(p_avatar_path text) set schema private;
alter function private.set_my_profile_avatar(p_avatar_path text) rename to set_my_profile_avatar_before_member_retirement;
revoke all on function private.set_my_profile_avatar_before_member_retirement(p_avatar_path text) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.set_my_profile_avatar(p_avatar_path text)
 RETURNS TABLE(avatar_url text, previous_avatar_path text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select * from private.set_my_profile_avatar_before_member_retirement($1);
end;
$function$;

revoke all on function public.set_my_profile_avatar(p_avatar_path text) from public,anon,authenticated,service_role;
grant execute on function public.set_my_profile_avatar(p_avatar_path text) to authenticated;

-- 정적 회원 RPC: set_my_profile_traits(p_interests text[], p_conversation_styles text[], p_mbti text)
alter function public.set_my_profile_traits(p_interests text[], p_conversation_styles text[], p_mbti text) set schema private;
alter function private.set_my_profile_traits(p_interests text[], p_conversation_styles text[], p_mbti text) rename to set_my_profile_traits_before_member_retirement;
revoke all on function private.set_my_profile_traits_before_member_retirement(p_interests text[], p_conversation_styles text[], p_mbti text) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.set_my_profile_traits(p_interests text[], p_conversation_styles text[], p_mbti text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.set_my_profile_traits_before_member_retirement($1,$2,$3);
end;
$function$;

revoke all on function public.set_my_profile_traits(p_interests text[], p_conversation_styles text[], p_mbti text) from public,anon,authenticated,service_role;
grant execute on function public.set_my_profile_traits(p_interests text[], p_conversation_styles text[], p_mbti text) to authenticated;

-- 정적 회원 RPC: submit_appointment_review(p_appointment_id uuid, p_rating integer, p_comment text, p_experience text, p_praises text[])
alter function public.submit_appointment_review(p_appointment_id uuid, p_rating integer, p_comment text, p_experience text, p_praises text[]) set schema private;
alter function private.submit_appointment_review(p_appointment_id uuid, p_rating integer, p_comment text, p_experience text, p_praises text[]) rename to submit_appointment_review_before_member_retirement;
revoke all on function private.submit_appointment_review_before_member_retirement(p_appointment_id uuid, p_rating integer, p_comment text, p_experience text, p_praises text[]) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.submit_appointment_review(p_appointment_id uuid, p_rating integer, p_comment text, p_experience text, p_praises text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.submit_appointment_review_before_member_retirement($1,$2,$3,$4,$5);
end;
$function$;

revoke all on function public.submit_appointment_review(p_appointment_id uuid, p_rating integer, p_comment text, p_experience text, p_praises text[]) from public,anon,authenticated,service_role;
grant execute on function public.submit_appointment_review(p_appointment_id uuid, p_rating integer, p_comment text, p_experience text, p_praises text[]) to authenticated;

-- 정적 회원 RPC: unblock_member(p_target_id uuid)
alter function public.unblock_member(p_target_id uuid) set schema private;
alter function private.unblock_member(p_target_id uuid) rename to unblock_member_before_member_retirement;
revoke all on function private.unblock_member_before_member_retirement(p_target_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.unblock_member(p_target_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.unblock_member_before_member_retirement($1);
end;
$function$;

revoke all on function public.unblock_member(p_target_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.unblock_member(p_target_id uuid) to authenticated;

-- 정적 회원 RPC: update_service_post(p_post_id uuid, p_input jsonb, p_expected_updated_at timestamp with time zone)
alter function public.update_service_post(p_post_id uuid, p_input jsonb, p_expected_updated_at timestamp with time zone) set schema private;
alter function private.update_service_post(p_post_id uuid, p_input jsonb, p_expected_updated_at timestamp with time zone) rename to update_service_post_before_member_retirement;
revoke all on function private.update_service_post_before_member_retirement(p_post_id uuid, p_input jsonb, p_expected_updated_at timestamp with time zone) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.update_service_post(p_post_id uuid, p_input jsonb, p_expected_updated_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.update_service_post_before_member_retirement($1,$2,$3);
end;
$function$;

revoke all on function public.update_service_post(p_post_id uuid, p_input jsonb, p_expected_updated_at timestamp with time zone) from public,anon,authenticated,service_role;
grant execute on function public.update_service_post(p_post_id uuid, p_input jsonb, p_expected_updated_at timestamp with time zone) to authenticated;

-- 정적 회원 RPC: withdraw_join_request(p_request_id uuid)
alter function public.withdraw_join_request(p_request_id uuid) set schema private;
alter function private.withdraw_join_request(p_request_id uuid) rename to withdraw_join_request_before_member_retirement;
revoke all on function private.withdraw_join_request_before_member_retirement(p_request_id uuid) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.withdraw_join_request(p_request_id uuid)
 RETURNS TABLE(id uuid, status text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select * from private.withdraw_join_request_before_member_retirement($1);
end;
$function$;

revoke all on function public.withdraw_join_request(p_request_id uuid) from public,anon,authenticated,service_role;
grant execute on function public.withdraw_join_request(p_request_id uuid) to authenticated;

-- 정적 회원 RPC: withdraw_match_consent(p_request_id uuid, p_condition_version text)
alter function public.withdraw_match_consent(p_request_id uuid, p_condition_version text) set schema private;
alter function private.withdraw_match_consent(p_request_id uuid, p_condition_version text) rename to withdraw_match_consent_before_member_retirement;
revoke all on function private.withdraw_match_consent_before_member_retirement(p_request_id uuid, p_condition_version text) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.withdraw_match_consent(p_request_id uuid, p_condition_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.withdraw_match_consent_before_member_retirement($1,$2);
end;
$function$;

revoke all on function public.withdraw_match_consent(p_request_id uuid, p_condition_version text) from public,anon,authenticated,service_role;
grant execute on function public.withdraw_match_consent(p_request_id uuid, p_condition_version text) to authenticated;

-- 정적 회원 RPC: withdraw_my_ai_processing(p_kind text)
alter function public.withdraw_my_ai_processing(p_kind text) set schema private;
alter function private.withdraw_my_ai_processing(p_kind text) rename to withdraw_my_ai_processing_before_member_retirement;
revoke all on function private.withdraw_my_ai_processing_before_member_retirement(p_kind text) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.withdraw_my_ai_processing(p_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return private.withdraw_my_ai_processing_before_member_retirement($1);
end;
$function$;

revoke all on function public.withdraw_my_ai_processing(p_kind text) from public,anon,authenticated,service_role;
grant execute on function public.withdraw_my_ai_processing(p_kind text) to authenticated;

-- 장소 변경 6인자 계약도 같은 활성 회원 가드를 적용한다. 장소 SQL이 선행한다.
alter function public.propose_appointment_schedule_change(uuid,uuid,timestamptz,timestamptz,timestamptz,jsonb) set schema private;
alter function private.propose_appointment_schedule_change(uuid,uuid,timestamptz,timestamptz,timestamptz,jsonb)
  rename to propose_appointment_schedule_change_before_member_retirement;
revoke all on function private.propose_appointment_schedule_change_before_member_retirement(uuid,uuid,timestamptz,timestamptz,timestamptz,jsonb)
  from public,anon,authenticated,service_role;
create function public.propose_appointment_schedule_change(p_appointment_id uuid,p_change_id uuid,p_starts_at timestamptz,p_ends_at timestamptz,p_expected_updated_at timestamptz,p_location jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  perform private.require_service_profile();
  return private.propose_appointment_schedule_change_before_member_retirement($1,$2,$3,$4,$5,$6);
end; $$;
revoke all on function public.propose_appointment_schedule_change(uuid,uuid,timestamptz,timestamptz,timestamptz,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.propose_appointment_schedule_change(uuid,uuid,timestamptz,timestamptz,timestamptz,jsonb) to authenticated;

-- 관련 절차의 최종 종료 확인은 운영 workflow가 owner-only로 연결한다.
-- 미확인 종료 시각을 현재 시각으로 대체하지 않는다.
create function private.record_member_retention_closure(p_request_id uuid,p_closed_at timestamptz)
returns void language plpgsql volatile security definer set search_path='' as $$
declare n timestamptz;last_at timestamptz;begin
  if p_closed_at is null or not isfinite(p_closed_at) or p_closed_at>clock_timestamp() then
    raise exception 'invalid_procedure_closure' using errcode='22023';end if;
  select greatest(j.created_at,j.updated_at,coalesce(max(m.created_at),j.created_at)) into last_at
    from public.join_requests j left join public.chat_messages m on m.join_request_id=j.id
    where j.id=p_request_id group by j.id;
  if last_at is null then raise exception 'request_unavailable' using errcode='P0002';end if;
  select greatest(procedure_closed_at,p_closed_at) into n from private.conversation_retention where request_id=p_request_id for update;
  if not found then raise exception 'retention_not_requested' using errcode='22023';end if;
  update private.conversation_retention set procedure_closed_at=n,purge_after=greatest(last_at,n)+interval '1 year' where request_id=p_request_id;
end; $$;
create function private.purge_expired_member_retention()
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare r uuid;n timestamptz:=clock_timestamp();b integer;c integer:=0;begin
  delete from private.retired_post_bodies where retained_until<=n;get diagnostics b=row_count;
  delete from private.retired_consent_bodies where retained_until<=n;
  for r in select request_id from private.conversation_retention where purge_after<=n order by request_id for update loop
    delete from public.chat_messages where join_request_id=r;
    update public.join_requests set message='보관 기간이 종료된 대화입니다.' where id=r;
    c:=c+1;
  end loop;
  return jsonb_build_object('postBodiesRemoved',b,'conversationRecordsProcessed',c);
end; $$;
revoke all on function private.record_member_retention_closure(uuid,timestamptz),private.purge_expired_member_retention()
  from public,anon,authenticated,service_role;

-- 새 보관 원문/안전 연결/삭제 증거는 API에 노출하지 않는다.
alter table private.member_retirements enable row level security;
revoke all on private.member_retirements from public,anon,authenticated,service_role;
alter table private.member_cleanup_delete_acks enable row level security;
revoke all on private.member_cleanup_delete_acks from public,anon,authenticated,service_role;
alter table private.member_cleanup_tasks enable row level security;
revoke all on private.member_cleanup_tasks from public,anon,authenticated,service_role;
alter table private.retired_post_retention enable row level security;
revoke all on private.retired_post_retention from public,anon,authenticated,service_role;
alter table private.retired_post_bodies enable row level security;
revoke all on private.retired_post_bodies from public,anon,authenticated,service_role;
alter table private.retired_consent_bodies enable row level security;
revoke all on private.retired_consent_bodies from public,anon,authenticated,service_role;
alter table private.conversation_retention enable row level security;
revoke all on private.conversation_retention from public,anon,authenticated,service_role;
alter table private.member_cleanup_guard enable row level security;
revoke all on private.member_cleanup_guard from public,anon,authenticated,service_role;
alter table private.naver_identity_keys enable row level security;
revoke all on private.naver_identity_keys from public,anon,authenticated,service_role;
revoke all on function private.profile_retired(uuid) from public,anon,authenticated,service_role;
revoke all on function private.assert_not_retired_caller() from public,anon,authenticated,service_role;
revoke all on function private.live_native_caller() from public,anon,authenticated,service_role;
revoke all on function private.enforce_retired_profile_shape() from public,anon,authenticated,service_role;
revoke all on function private.member_safety_identity(uuid) from public,anon,authenticated,service_role;
revoke all on function private.bind_member_identity() from public,anon,authenticated,service_role;
revoke all on function private.lock_live_pair_episodes(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function private.lock_live_post_pair(uuid) from public,anon,authenticated,service_role;
revoke all on function private.lock_live_request_pair(uuid) from public,anon,authenticated,service_role;
revoke all on function private.live_post_ids(uuid[]) from public,anon,authenticated,service_role;
revoke all on function private.require_active_public_profile(uuid) from public,anon,authenticated,service_role;
revoke all on function private.closed_conversation_retention_open(uuid) from public,anon,authenticated,service_role;
revoke all on function private.require_conversation_retention(uuid) from public,anon,authenticated,service_role;
revoke all on function private.guard_native_storage_mutation() from public,anon,authenticated,service_role;
revoke all on function private.retired_storage_target(text,text) from public,anon,authenticated,service_role;
revoke all on function private.request_other_retired(uuid) from public,anon,authenticated,service_role;
revoke all on function private.can_read_profile_image(text,text,text) from public,anon,authenticated,service_role;
grant execute on function private.live_native_caller(),private.retired_storage_target(text,text),
  private.closed_conversation_retention_open(uuid),private.can_read_profile_image(text,text,text) to authenticated;
grant execute on function private.profile_retired(uuid) to anon,authenticated;
-- 기존 require_member_uid invoker 계약에는 공유 가드 실행 권한만 제공한다.
grant execute on function private.assert_not_retired_caller() to authenticated;
revoke all on function public.retire_my_account(uuid) from public,anon,authenticated,service_role;
grant execute on function public.retire_my_account(uuid) to authenticated;
revoke all on function public.claim_member_cleanup_task(uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text),public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
-- 삭제 worker 연결 및 승인 전에는 service_role도 실행하지 못한다.
commit;
