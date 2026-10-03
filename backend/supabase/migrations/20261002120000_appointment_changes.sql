-- 확정 후 시작 전 일정 변경·사유 취소. 제안만으로 기존 약속을 바꾸지 않는다.
begin;
create table private.appointment_schedule_changes (
  change_id uuid primary key,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  condition_version text not null unique default gen_random_uuid()::text,
  requested_by uuid not null references public.profiles(id),
  old_starts_at timestamptz not null,
  old_ends_at timestamptz not null,
  old_updated_at timestamptz not null,
  new_starts_at timestamptz not null,
  new_ends_at timestamptz not null,
  requested_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  status text not null default 'awaiting_response' check(status in('awaiting_response','accepted','declined','expired','cancelled')),
  resolved_at timestamptz,
  constraint appointment_schedule_change_order check(old_ends_at>old_starts_at and new_ends_at>new_starts_at),
  constraint appointment_schedule_change_expiry check(expires_at=least(old_starts_at,new_starts_at) and expires_at>requested_at),
  constraint appointment_schedule_change_state check((status='awaiting_response')=(resolved_at is null))
);
create unique index appointment_one_pending_schedule_change on private.appointment_schedule_changes(appointment_id) where status='awaiting_response';
create index appointment_schedule_changes_due on private.appointment_schedule_changes(expires_at,appointment_id) where status='awaiting_response';
create table private.appointment_cancellations (
  appointment_id uuid primary key references public.appointments(id) on delete cascade,
  cancellation_id uuid not null unique,
  cancelled_by uuid not null references public.profiles(id),
  reason text not null check(reason=btrim(reason) and char_length(reason) between 1 and 300),
  cancelled_at timestamptz not null default clock_timestamp()
);
alter table private.appointment_schedule_changes enable row level security;
alter table private.appointment_cancellations enable row level security;
revoke all on private.appointment_schedule_changes,private.appointment_cancellations from public,anon,authenticated,service_role;
alter table public.notifications drop constraint notifications_kind_allowed;
alter table public.notifications add constraint notifications_kind_allowed check(kind in
  ('join_request','appointment_completed','match_consent_requested','match_confirmed','match_consent_ended',
   'post_conditions_changed','post_deleted','match_not_selected','appointment_schedule_change_requested',
   'appointment_schedule_change_ended','appointment_cancelled'));

create function private.lock_appointment_for_change(p_appointment_id uuid)
returns public.appointments language plpgsql volatile security definer set search_path='' as $$
declare v_post uuid; ap public.appointments;
begin
  select post_id into v_post from public.appointments where id=p_appointment_id;
  if v_post is null then raise exception 'appointment_unavailable' using errcode='PT404'; end if;
  perform 1 from public.posts where id=v_post for update;
  perform private.lock_match_post_requests(v_post);
  select * into ap from public.appointments where id=p_appointment_id for update;
  perform 1 from private.appointment_schedule_changes where appointment_id=ap.id order by change_id for update;
  return ap;
end; $$;

create function private.appointment_schedule_response_open(p_change_id uuid,p_at timestamptz)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select c.status='awaiting_response' and ap.status='confirmed' and p_at<c.expires_at
    and p_at>=c.requested_at and p.starts_at=c.old_starts_at and p.ends_at=c.old_ends_at and p.updated_at=c.old_updated_at
    and not exists(select 1 from public.appointment_disputes d where d.appointment_id=ap.id and (d.status='open' or d.resolution='no_show'))
    from private.appointment_schedule_changes c join public.appointments ap on ap.id=c.appointment_id
    join public.posts p on p.id=ap.post_id where c.change_id=p_change_id),false);
$$;

create function private.appointment_schedule_change_json(p_change_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('appointmentId',appointment_id,'changeId',change_id,'conditionVersion',condition_version,'status',status,
    'oldSchedule',jsonb_build_object('startsAt',old_starts_at,'endsAt',old_ends_at),
    'newSchedule',jsonb_build_object('startsAt',new_starts_at,'endsAt',new_ends_at),
    'requestedByMe',requested_by=auth.uid(),'requestedAt',requested_at,'expiresAt',expires_at,'resolvedAt',resolved_at)
    from private.appointment_schedule_changes where change_id=p_change_id;
$$;

create function private.end_appointment_schedule_change(p_change_id uuid,p_status text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare c private.appointment_schedule_changes; v_request uuid;
begin
  if p_status not in('accepted','declined','expired','cancelled') then raise exception 'invalid_transition' using errcode='22023'; end if;
  update private.appointment_schedule_changes set status=p_status,resolved_at=clock_timestamp()
    where change_id=p_change_id and status='awaiting_response' returning * into c;
  if not found then return false; end if;
  select join_request_id into v_request from public.appointments where id=c.appointment_id;
  perform private.notify_match_lifecycle(v_request,'appointment_schedule_change_ended',c.condition_version,
    jsonb_build_object('status',p_status,'changeId',c.change_id,'conditionVersion',c.condition_version));
  return true;
end; $$;

create function private.expire_appointment_schedule_changes(p_appointment_id uuid)
returns integer language plpgsql volatile security definer set search_path='' as $$
declare c private.appointment_schedule_changes; n integer:=0;
begin
  for c in select * from private.appointment_schedule_changes where appointment_id=p_appointment_id
    and status='awaiting_response' and expires_at<=clock_timestamp() order by change_id loop
    if private.end_appointment_schedule_change(c.change_id,'expired') then n:=n+1; end if;
  end loop;
  return n;
end; $$;

create function public.get_appointment_change_state(p_appointment_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); ap public.appointments; p public.posts;
  v_change uuid; c private.appointment_cancellations; v_result jsonb;
begin
  if private.appointment_role(p_appointment_id) is null then raise exception 'appointment_unavailable' using errcode='PT404'; end if;
  ap:=private.lock_appointment_for_change(p_appointment_id);
  perform private.expire_appointment_schedule_changes(ap.id);
  select * into p from public.posts where id=ap.post_id;
  select change_id into v_change from private.appointment_schedule_changes where appointment_id=ap.id order by requested_at desc,change_id desc limit 1;
  select * into c from private.appointment_cancellations where appointment_id=ap.id;
  v_result:=jsonb_build_object('appointmentId',ap.id,'status',ap.status,'startsAt',p.starts_at,'endsAt',p.ends_at,'updatedAt',p.updated_at,
    'change',private.appointment_schedule_change_json(v_change),'cancellation',
    case when c.appointment_id is null then null else jsonb_build_object('cancellationId',c.cancellation_id,'reason',c.reason,
      'cancelledAt',c.cancelled_at,'cancelledByMe',c.cancelled_by=v_uid) end);
  return v_result;
end; $$;

create function public.propose_appointment_schedule_change(p_appointment_id uuid,p_change_id uuid,p_starts_at timestamptz,p_ends_at timestamptz,p_expected_updated_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); ap public.appointments; p public.posts; c private.appointment_schedule_changes;
  v_now timestamptz;
begin
  perform private.assert_naver_activity_allowed();
  if p_change_id is null or p_starts_at is null or p_ends_at is null or p_expected_updated_at is null
    or not isfinite(p_starts_at) or not isfinite(p_ends_at) or not isfinite(p_expected_updated_at) or p_ends_at<=p_starts_at then
    raise exception 'invalid_schedule' using errcode='22023';
  end if;
  if private.appointment_role(p_appointment_id) is null then raise exception 'appointment_unavailable' using errcode='PT404'; end if;
  ap:=private.lock_appointment_for_change(p_appointment_id);
  perform pg_advisory_xact_lock(hashtextextended(p_change_id::text,323));
  select * into c from private.appointment_schedule_changes where change_id=p_change_id;
  if found then
    if c.appointment_id<>ap.id or c.requested_by<>v_uid or c.new_starts_at<>p_starts_at or c.new_ends_at<>p_ends_at or c.old_updated_at<>p_expected_updated_at then
      raise exception 'schedule_change_conflict' using errcode='40001';
    end if;
    perform private.expire_appointment_schedule_changes(ap.id);
    return private.appointment_schedule_change_json(c.change_id)||jsonb_build_object('deduplicated',true);
  end if;
  perform private.expire_appointment_schedule_changes(ap.id);
  select * into p from public.posts where id=ap.post_id;
  v_now:=clock_timestamp();
  if ap.status<>'confirmed' or p.starts_at<=v_now or p_starts_at<=v_now or p.updated_at<>p_expected_updated_at
    or exists(select 1 from private.appointment_schedule_changes where appointment_id=ap.id and status='awaiting_response')
    or exists(select 1 from public.appointment_disputes where appointment_id=ap.id and (status='open' or resolution='no_show')) then
    raise exception 'schedule_change_conflict' using errcode='40001';
  end if;
  insert into private.appointment_schedule_changes(change_id,appointment_id,requested_by,old_starts_at,old_ends_at,old_updated_at,
    new_starts_at,new_ends_at,requested_at,expires_at)
    values(p_change_id,ap.id,v_uid,p.starts_at,p.ends_at,p.updated_at,p_starts_at,p_ends_at,v_now,least(p.starts_at,p_starts_at)) returning * into c;
  perform private.notify_match_lifecycle(ap.join_request_id,'appointment_schedule_change_requested',c.condition_version,
    jsonb_build_object('status',c.status,'changeId',c.change_id,'conditionVersion',c.condition_version,'expiresAt',c.expires_at));
  return private.appointment_schedule_change_json(c.change_id)||jsonb_build_object('deduplicated',false);
end; $$;

create function public.accept_appointment_schedule_change(p_appointment_id uuid,p_change_id uuid,p_condition_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); ap public.appointments; p public.posts;
  c private.appointment_schedule_changes; v_author uuid; v_requester uuid; v_person uuid;
begin
  perform private.assert_naver_activity_allowed();
  if private.appointment_role(p_appointment_id) is null then raise exception 'appointment_unavailable' using errcode='PT404'; end if;
  ap:=private.lock_appointment_for_change(p_appointment_id);
  select * into c from private.appointment_schedule_changes where change_id=p_change_id and appointment_id=ap.id;
  if c.change_id is null or p_condition_version is null or c.condition_version<>p_condition_version then raise exception 'schedule_change_conflict' using errcode='40001'; end if;
  if c.requested_by=v_uid then raise exception 'counterparty_required' using errcode='42501'; end if;
  if c.status='accepted' then return private.appointment_schedule_change_json(c.change_id)||jsonb_build_object('deduplicated',true); end if;
  select p0.author_id,r.requester_id into v_author,v_requester from public.posts p0 join public.join_requests r on r.id=ap.join_request_id where p0.id=ap.post_id;
  for v_person in select id from public.profiles where id in(v_author,v_requester) order by id loop
    perform pg_advisory_xact_lock(hashtextextended(v_person::text,321));
  end loop;
  perform private.assert_naver_member_qualified(v_author);
  perform private.assert_naver_member_qualified(v_requester);
  if not private.appointment_schedule_response_open(c.change_id,clock_timestamp()) then raise exception 'schedule_change_conflict' using errcode='40001'; end if;
  if exists(select 1 from public.appointments other_ap join public.posts other_p on other_p.id=other_ap.post_id
    join public.join_requests other_r on other_r.id=other_ap.join_request_id
    where other_ap.id<>ap.id and other_ap.status='confirmed'
      and (other_p.author_id in(v_author,v_requester) or other_r.requester_id in(v_author,v_requester))
      and tstzrange(other_p.starts_at,other_p.ends_at,'[)') && tstzrange(c.new_starts_at,c.new_ends_at,'[)')) then
    raise exception 'schedule_conflict' using errcode='40001';
  end if;
  -- 기존 공고의 종료 변경 트리거가 예약 시각·generation을 갱신한다. 별도 예약 원장을 만들지 않는다.
  update public.posts set starts_at=c.new_starts_at,ends_at=c.new_ends_at,
    recruitment_ends_at=least(recruitment_ends_at,c.new_starts_at) where id=ap.post_id;
  perform private.end_appointment_schedule_change(c.change_id,'accepted');
  return private.appointment_schedule_change_json(c.change_id)||jsonb_build_object('deduplicated',false);
end; $$;

create function public.decline_appointment_schedule_change(p_appointment_id uuid,p_change_id uuid,p_condition_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); ap public.appointments; c private.appointment_schedule_changes; v_dedup boolean;
begin
  if private.appointment_role(p_appointment_id) is null then raise exception 'appointment_unavailable' using errcode='PT404'; end if;
  ap:=private.lock_appointment_for_change(p_appointment_id);
  perform private.expire_appointment_schedule_changes(ap.id);
  select * into c from private.appointment_schedule_changes where change_id=p_change_id and appointment_id=ap.id;
  if c.change_id is null or p_condition_version is null or c.condition_version<>p_condition_version then raise exception 'schedule_change_conflict' using errcode='40001'; end if;
  if c.requested_by=v_uid then raise exception 'counterparty_required' using errcode='42501'; end if;
  v_dedup:=c.status<>'awaiting_response';
  if c.status='awaiting_response' then perform private.end_appointment_schedule_change(c.change_id,'declined');
  elsif c.status not in('declined','expired') then raise exception 'schedule_change_conflict' using errcode='40001'; end if;
  return private.appointment_schedule_change_json(c.change_id)||jsonb_build_object('deduplicated',v_dedup);
end; $$;

create function public.cancel_appointment(p_appointment_id uuid,p_cancellation_id uuid,p_reason text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); ap public.appointments; p public.posts;
  c private.appointment_cancellations; v_reason text:=btrim(coalesce(p_reason,'')); v_change uuid; v_dedup boolean:=false;
begin
  if p_cancellation_id is null or char_length(v_reason) not between 1 and 300 then raise exception 'invalid_cancellation' using errcode='22023'; end if;
  if private.appointment_role(p_appointment_id) is null then raise exception 'appointment_unavailable' using errcode='PT404'; end if;
  ap:=private.lock_appointment_for_change(p_appointment_id);
  perform pg_advisory_xact_lock(hashtextextended(p_cancellation_id::text,324));
  select * into c from private.appointment_cancellations where cancellation_id=p_cancellation_id or appointment_id=ap.id;
  if found then
    if c.appointment_id<>ap.id or c.cancellation_id<>p_cancellation_id or c.cancelled_by<>v_uid or c.reason<>v_reason then
      raise exception 'cancellation_conflict' using errcode='40001';
    end if;
    v_dedup:=true;
  else
    select * into p from public.posts where id=ap.post_id;
    if ap.status<>'confirmed' or clock_timestamp()>=p.starts_at then raise exception 'cancellation_conflict' using errcode='40001'; end if;
    insert into private.appointment_cancellations(appointment_id,cancellation_id,cancelled_by,reason)
      values(ap.id,p_cancellation_id,v_uid,v_reason) returning * into c;
    perform private.expire_appointment_schedule_changes(ap.id);
    for v_change in select change_id from private.appointment_schedule_changes where appointment_id=ap.id and status='awaiting_response' order by change_id loop
      perform private.end_appointment_schedule_change(v_change,'cancelled');
    end loop;
    -- 기존 상태/요약/예약 트리거가 원자적으로 공개 무효화와 자동 완료 예약 삭제를 처리한다.
    update public.appointments set status='cancelled' where id=ap.id;
    perform private.notify_match_lifecycle(ap.join_request_id,'appointment_cancelled',p_cancellation_id::text,
      jsonb_build_object('appointmentId',ap.id,'status','cancelled','cancellationId',p_cancellation_id));
  end if;
  return jsonb_build_object('appointmentId',ap.id,'status','cancelled','cancellationId',c.cancellation_id,
    'reason',c.reason,'cancelledAt',c.cancelled_at,'deduplicated',v_dedup);
end; $$;

create function public.expire_appointment_changes(p_limit integer default 100)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_ap_id uuid; v_post uuid; ap public.appointments; n integer:=0;
begin
  if p_limit is null or p_limit not between 1 and 1000 then raise exception 'invalid_limit' using errcode='22023'; end if;
  for v_ap_id in select distinct appointment_id from private.appointment_schedule_changes
    where status='awaiting_response' and expires_at<=clock_timestamp() order by appointment_id limit p_limit loop
    select post_id into v_post from public.appointments where id=v_ap_id;
    perform 1 from public.posts where id=v_post for update skip locked;
    if found then
      ap:=private.lock_appointment_for_change(v_ap_id);
      n:=n+private.expire_appointment_schedule_changes(ap.id);
    end if;
  end loop;
  return jsonb_build_object('expiredCount',n);
end; $$;

-- 취소 후 메시지는 읽기만 유지한다. 다른 기존 대화 상태의 전송 기준은 보존한다.
create or replace function private.can_send_message(p_request_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.join_requests r join public.posts p on p.id=r.post_id
    where r.id=p_request_id and (r.requester_id=auth.uid() or p.author_id=auth.uid()) and p.status<>'deleted'
      and ((r.status='pending' and clock_timestamp()<p.starts_at) or (r.status='matched'
        and exists(select 1 from public.appointments ap where ap.join_request_id=r.id and ap.status<>'cancelled'))));
$$;
revoke all on function private.lock_appointment_for_change(uuid),private.appointment_schedule_response_open(uuid,timestamptz),
  private.appointment_schedule_change_json(uuid),private.end_appointment_schedule_change(uuid,text),private.expire_appointment_schedule_changes(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.get_appointment_change_state(uuid),public.propose_appointment_schedule_change(uuid,uuid,timestamptz,timestamptz,timestamptz),
  public.accept_appointment_schedule_change(uuid,uuid,text),public.decline_appointment_schedule_change(uuid,uuid,text),public.cancel_appointment(uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.get_appointment_change_state(uuid),public.propose_appointment_schedule_change(uuid,uuid,timestamptz,timestamptz,timestamptz),
  public.accept_appointment_schedule_change(uuid,uuid,text),public.decline_appointment_schedule_change(uuid,uuid,text),public.cancel_appointment(uuid,uuid,text) to authenticated;
revoke all on function public.expire_appointment_changes(integer) from public,anon,authenticated,service_role;
grant execute on function public.expire_appointment_changes(integer) to service_role;
comment on table private.appointment_schedule_changes is '동일 조건 재시도와 상대 동의를 검증하는 일정 변경 이력. 수락 전 원본 일정은 유지한다.';
comment on table private.appointment_cancellations is '시작 전 당사자 사유 취소. 노쇼·제재·분쟁 판정 근거를 자동 확정하지 않는다.';
commit;
