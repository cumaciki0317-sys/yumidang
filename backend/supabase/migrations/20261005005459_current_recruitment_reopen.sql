-- 정책 5-2: 작성자의 명시 재개만 이전 유효 신청을 복원한다.
-- 후속 차단 migration의 private.members_blocked를 런타임에 사용한다.
begin;
alter table public.appointments drop constraint appointments_one_per_post;
create unique index appointments_one_active_per_post on public.appointments(post_id) where status<>'cancelled';
alter table public.notifications drop constraint notifications_kind_allowed;
alter table public.notifications add constraint notifications_kind_allowed check(kind in
 ('join_request','appointment_completed','match_consent_requested','match_confirmed','match_consent_ended',
 'post_conditions_changed','post_deleted','match_not_selected','appointment_schedule_change_requested',
 'appointment_schedule_change_ended','appointment_cancelled','recruitment_reopened'));

-- 기존 취소 로그의 과거 일정은 추정하지 않는다. unknown 값은 운영 이력 조사 대상이다.
alter table private.appointment_cancellations
 add column cancelled_starts_at timestamptz,
 add column cancelled_ends_at timestamptz,
 add column cancelled_post_updated_at timestamptz,
 add column schedule_provenance text not null default 'unknown',
 add constraint cancellation_schedule_snapshot check
  ((schedule_provenance='unknown' and cancelled_starts_at is null and cancelled_ends_at is null and cancelled_post_updated_at is null)
   or (schedule_provenance='captured_at_cancellation' and cancelled_starts_at is not null and cancelled_ends_at is not null and cancelled_ends_at>cancelled_starts_at and cancelled_post_updated_at is not null));
create function private.capture_cancellation_schedule()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 select p.starts_at,p.ends_at,p.updated_at into new.cancelled_starts_at,new.cancelled_ends_at,new.cancelled_post_updated_at
 from public.appointments ap join public.posts p on p.id=ap.post_id where ap.id=new.appointment_id;
 if not found then raise exception 'appointment_unavailable' using errcode='PT404';end if;
 new.schedule_provenance:='captured_at_cancellation';
 return new;
end; $$;
create trigger capture_cancellation_schedule before insert on private.appointment_cancellations
 for each row execute function private.capture_cancellation_schedule();
revoke all on function private.capture_cancellation_schedule() from public,anon,authenticated,service_role;


create or replace function public.propose_match(p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); r public.join_requests; p public.posts;
  l private.match_consent_lifecycle; v_now timestamptz; v_version text; v_fingerprint text;
begin
  perform private.assert_naver_activity_allowed();
  select * into r from public.join_requests where id=p_request_id;
  select * into p from public.posts where id=r.post_id for update;
  if p.id is null or p.author_id<>v_uid or p.status='deleted' then raise exception 'request_unavailable' using errcode='P0002'; end if;
  perform private.lock_match_post_requests(p.id);
  perform private.expire_post_match_consents(p.id);
  select * into r from public.join_requests where id=p_request_id;
  if r.status<>'pending' or p.status not in ('recruiting','closed') or p.starts_at<=clock_timestamp()
    or exists(select 1 from public.appointments where post_id=p.id and status<>'cancelled') then raise exception 'match_conflict' using errcode='40001'; end if;
  if p.cost_type is distinct from 'free' then raise exception 'bank_integration_unavailable' using errcode='PT503'; end if;
  select * into l from private.match_consent_lifecycle where post_id=p.id and status='awaiting_consent';
  if found then
    if l.request_id<>p_request_id then raise exception 'active_consent_conflict' using errcode='40001'; end if;
    if l.condition_version<>(select condition_version from private.match_consents where request_id=p_request_id)
      or (select condition_fingerprint from private.match_consents where request_id=p_request_id) is distinct from private.match_condition_version(p.id) then
      raise exception 'condition_conflict' using errcode='40001';
    end if;
    return private.match_consent_json(p_request_id);
  end if;
  v_fingerprint:=private.match_condition_version(p.id);
  if v_fingerprint is null then raise exception 'location_required' using errcode='40001'; end if;
  v_now:=clock_timestamp(); v_version:=gen_random_uuid()::text;
  if v_now>=p.starts_at then raise exception 'match_conflict' using errcode='40001'; end if;
  insert into private.match_consents(request_id,condition_version,condition_fingerprint,conditions,requested_by,requested_at,accepted_at)
    values(p_request_id,v_version,v_fingerprint,private.match_conditions(p.id),v_uid,v_now,null)
    on conflict(request_id) do update set condition_version=excluded.condition_version,
      condition_fingerprint=excluded.condition_fingerprint,conditions=excluded.conditions,
      requested_by=excluded.requested_by,requested_at=excluded.requested_at,accepted_at=null;
  insert into private.match_consent_lifecycle(request_id,post_id,condition_version,requested_at,expires_at,status,ended_at)
    values(p_request_id,p.id,v_version,v_now,least(v_now+interval '6 hours',p.starts_at),'awaiting_consent',null)
    on conflict(request_id) do update set condition_version=excluded.condition_version,requested_at=excluded.requested_at,
      expires_at=excluded.expires_at,status=excluded.status,ended_at=null;
  perform private.notify_match_lifecycle(p_request_id,'match_consent_requested',v_version,
    jsonb_build_object('conditionVersion',v_version,'status','awaiting_consent','expiresAt',least(v_now+interval '6 hours',p.starts_at)));
  return private.match_consent_json(p_request_id);
end; $$;

create or replace function public.accept_match(p_request_id uuid,p_condition_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); v_request public.join_requests; v_post public.posts;
  v_consent private.match_consents; v_lifecycle private.match_consent_lifecycle; v_appointment public.appointments; v_participant uuid; v_other uuid;
begin
  perform private.assert_naver_activity_allowed();
  select * into v_request from public.join_requests where id=p_request_id;
  if not found or v_request.requester_id<>v_uid then raise exception 'request_unavailable' using errcode='P0002'; end if;
  select * into v_post from public.posts where id=v_request.post_id for update;
  if v_post.status='deleted' then raise exception 'request_unavailable' using errcode='P0002'; end if;
  perform private.lock_match_post_requests(v_post.id);
  perform private.expire_post_match_consents(v_post.id);
  -- 기존 양 당사자 UUID 순서의 일정 잠금을 재사용한다.
  for v_participant in select id from public.profiles where id in(v_uid,v_post.author_id) order by id loop
    perform pg_advisory_xact_lock(hashtextextended(v_participant::text,321));
  end loop;
  select * into v_request from public.join_requests where id=p_request_id for update;
  select * into v_consent from private.match_consents where request_id=p_request_id for update;
  select * into v_lifecycle from private.match_consent_lifecycle where request_id=p_request_id;
  if v_consent.request_id is null or p_condition_version is null or p_condition_version<>v_consent.condition_version then
    raise exception 'condition_conflict' using errcode='40001';
  end if;
  select * into v_appointment from public.appointments where post_id=v_post.id and status<>'cancelled';
  if found then
    if v_appointment.join_request_id<>p_request_id or v_consent.accepted_at is null then raise exception 'match_conflict' using errcode='40001'; end if;
    return jsonb_build_object('appointmentId',v_appointment.id,'postId',v_post.id,'requestId',p_request_id,'status',v_appointment.status,'alreadyConfirmed',true);
  end if;
  if v_lifecycle.request_id is null or v_lifecycle.condition_version<>p_condition_version or v_lifecycle.status<>'awaiting_consent'
    or v_lifecycle.expires_at<=clock_timestamp() then raise exception 'condition_conflict' using errcode='40001'; end if;
  if v_post.cost_type is distinct from 'free' then raise exception 'bank_integration_unavailable' using errcode='PT503'; end if;
  if v_request.status<>'pending' or v_post.status not in ('recruiting','closed') or v_post.starts_at<=clock_timestamp()
    or private.match_condition_version(v_post.id) is distinct from v_consent.condition_fingerprint then raise exception 'condition_conflict' using errcode='40001'; end if;
  if exists(select 1 from public.appointments ap join public.posts p on p.id=ap.post_id
    join public.join_requests jr on jr.id=ap.join_request_id
    where ap.status='confirmed' and (p.author_id in(v_uid,v_post.author_id) or jr.requester_id in(v_uid,v_post.author_id))
      and tstzrange(p.starts_at,p.ends_at,'[)') && tstzrange(v_post.starts_at,v_post.ends_at,'[)')) then
    raise exception 'schedule_conflict' using errcode='40001';
  end if;
  insert into public.appointments(post_id,join_request_id) values(v_post.id,p_request_id) returning * into v_appointment;
  update public.join_requests set status='matched' where id=p_request_id;
  update public.posts set status='closed' where id=v_post.id;
  update private.match_consents set accepted_at=clock_timestamp() where request_id=p_request_id;
  update private.match_consent_lifecycle set status='accepted',ended_at=clock_timestamp() where request_id=p_request_id;
  for v_other in select id from public.join_requests where post_id=v_post.id and id<>p_request_id and status='pending' order by id loop
    perform private.end_match_consent(v_other,'invalidated');
    update public.join_requests set status='not_selected' where id=v_other;
    perform private.notify_match_lifecycle(v_other,'match_not_selected',v_appointment.id::text,jsonb_build_object('status','not_selected'));
  end loop;
  insert into public.notifications(recipient_id,kind,join_request_id)
    values(v_uid,'match_confirmed',p_request_id),(v_post.author_id,'match_confirmed',p_request_id)
    on conflict(recipient_id,kind,join_request_id) do nothing;
  return jsonb_build_object('appointmentId',v_appointment.id,'postId',v_post.id,'requestId',p_request_id,'status',v_appointment.status,'alreadyConfirmed',false);
end;
$$;

create or replace function public.update_service_post(p_post_id uuid,p_input jsonb,p_expected_updated_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); p public.posts; v_tags text[]; v_old text; v_request uuid; v_event text; v_event_id uuid; v_old_event_id uuid;
begin
  perform private.assert_naver_activity_allowed();
  if p_expected_updated_at is null or not isfinite(p_expected_updated_at) then raise exception 'invalid_input' using errcode='22023'; end if;
  perform private.assert_service_post_input(p_input-'eventId');
  v_event_id:=private.parse_post_event_id(p_input->'eventId');
  select * into p from public.posts where id=p_post_id and author_id=v_uid and status<>'deleted' for update;
  if not found then raise exception 'post_unavailable' using errcode='P0002'; end if;
  if p.updated_at<>p_expected_updated_at or exists(select 1 from public.appointments where post_id=p.id and status<>'cancelled')
    or p.starts_at<=clock_timestamp() then raise exception 'post_conflict' using errcode='40001'; end if;
  v_old_event_id:=p.source_event_id;
  if not(p_input?'eventId') then v_event_id:=p.source_event_id; end if;
  if v_event_id is distinct from p.source_event_id then
    perform private.assert_post_event_selectable(v_event_id);
  end if;
  perform private.lock_match_post_requests(p.id);
  perform private.expire_post_match_consents(p.id);
  v_old:=private.match_condition_version(p.id);
  select coalesce(array_agg(value),'{}'::text[]) into v_tags from jsonb_array_elements_text(p_input->'tags');
  update public.posts set title=p_input->>'title',description=p_input->>'description',category=p_input->>'category',
    starts_at=(p_input->>'startsAt')::timestamptz,ends_at=(p_input->>'endsAt')::timestamptz,
    recruitment_ends_at=(p_input->>'recruitmentEndsAt')::timestamptz,public_area=p_input->>'publicArea',
    preference_note=p_input->>'preferenceNote',tags=v_tags,cost_type='free',amount=0,source_event_id=v_event_id where id=p.id returning * into p;
  update public.post_private_details set exact_location=p_input->>'meetingDetail' where post_id=p.id;
  if not found then insert into public.post_private_details(post_id,exact_location) values(p.id,p_input->>'meetingDetail'); end if;
  perform public.set_post_search_location(p.id,p_input->>'registeredPlaceName',p_input->>'registeredAddress');
  -- 최초 생성 재시도용 service_post_inputs는 원본 그대로 보존한다.
  if v_old is distinct from private.match_condition_version(p.id) or v_event_id is distinct from v_old_event_id then
    v_event:=gen_random_uuid()::text;
    for v_request in select id from public.join_requests where post_id=p.id and status='pending' order by id loop
      perform private.end_match_consent(v_request,'invalidated');
      perform private.notify_match_lifecycle(v_request,'post_conditions_changed',v_event,jsonb_build_object('status','conditions_changed'));
    end loop;
  end if;
  return jsonb_build_object('postId',p.id,'status',p.status,'updatedAt',p.updated_at);
exception when check_violation or not_null_violation then raise exception 'invalid_input' using errcode='22023';
end; $$;

create or replace function public.get_appointment_state(p_appointment_id uuid)
returns table (
  appointment_id uuid, join_request_id uuid, my_role text, status text, confirmed_at timestamptz, completed_at timestamptz,
  completion_method text, completion_notified_at timestamptz, dispute_deadline_at timestamptz,
  completed_by_me boolean, can_dispute boolean, dispute_status text,
  post_id uuid, post_title text, post_starts_at timestamptz, post_ends_at timestamptz, post_public_area text,
  counterpart_masked_name text, counterpart_avatar_url text,
  my_completion_at timestamptz, peer_completion_at timestamptz, can_confirm_completion boolean, server_now timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := private.appointment_role(p_appointment_id);
begin
  if v_uid is null then
    raise exception 'login_required' using errcode = '28000';
  end if;
  if v_role is null then
    raise exception 'appointment_unavailable' using errcode = 'PT404';
  end if;
  return query
    select ap.id, ap.join_request_id, v_role, ap.status, ap.confirmed_at, ap.completed_at,
           ap.completion_method, ap.completion_notified_at, ap.dispute_deadline_at,
           ap.completed_by_user_id = v_uid,
           (ap.status = 'completed' and now() < ap.dispute_deadline_at
             and (ap.completion_method = 'automatic' or ap.completed_by_user_id <> v_uid)
             and d.appointment_id is null),
           d.status,
           p.id, p.title, case when ap.status='cancelled' then cancelled.cancelled_starts_at else p.starts_at end,
           case when ap.status='cancelled' then cancelled.cancelled_ends_at else p.ends_at end, p.public_area,
           public.mask_real_name(pr.real_name), pr.avatar_url,
           mine.confirmed_at, peer.confirmed_at,
           (ap.status = 'confirmed' and now() >= p.ends_at and mine.user_id is null and d.appointment_id is null),
           now()
    from public.appointments ap
    join public.posts p on p.id = ap.post_id
    left join private.appointment_cancellations cancelled on cancelled.appointment_id=ap.id
    join public.join_requests r on r.id = ap.join_request_id
    join public.profiles pr on pr.id = case when v_role = 'author' then r.requester_id else p.author_id end
    left join public.appointment_completion_confirmations mine on mine.appointment_id = ap.id and mine.user_id = v_uid
    left join public.appointment_completion_confirmations peer on peer.appointment_id = ap.id and peer.user_id <> v_uid
    left join public.appointment_disputes d on d.appointment_id = ap.id
    where ap.id = p_appointment_id;
end;
$$;

create or replace function public.list_my_appointments()
returns table (
  appointment_id uuid, post_id uuid, join_request_id uuid, my_role text, status text, confirmed_at timestamptz,
  post_title text, post_starts_at timestamptz, post_ends_at timestamptz, post_public_area text,
  counterpart_masked_name text, counterpart_avatar_url text, server_now timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select ap.id, ap.post_id, ap.join_request_id,
         case when p.author_id = (select auth.uid()) then 'author' else 'companion' end,
         ap.status, ap.confirmed_at, p.title,
         case when ap.status='cancelled' then cancelled.cancelled_starts_at else p.starts_at end,
         case when ap.status='cancelled' then cancelled.cancelled_ends_at else p.ends_at end, p.public_area,
         public.mask_real_name(pr.real_name), pr.avatar_url, now()
  from public.appointments ap
  join public.posts p on p.id = ap.post_id
  left join private.appointment_cancellations cancelled on cancelled.appointment_id=ap.id
  join public.join_requests r on r.id = ap.join_request_id
  join public.profiles pr on pr.id = case when p.author_id = (select auth.uid()) then r.requester_id else p.author_id end
  where p.author_id = (select auth.uid()) or r.requester_id = (select auth.uid())
  order by case when ap.status='cancelled' then cancelled.cancelled_starts_at else p.starts_at end desc nulls last, ap.id;
$$;

create or replace function public.get_appointment_change_state(p_appointment_id uuid)
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
  v_result:=jsonb_build_object('appointmentId',ap.id,'status',ap.status,'startsAt',case when ap.status='cancelled' then c.cancelled_starts_at else p.starts_at end,
    'endsAt',case when ap.status='cancelled' then c.cancelled_ends_at else p.ends_at end,
    'updatedAt',case when ap.status='cancelled' then c.cancelled_post_updated_at else p.updated_at end,
    'scheduleProvenance',case when ap.status='cancelled' then coalesce(c.schedule_provenance,'unknown') else 'current_post' end,
    'change',private.appointment_schedule_change_json(v_change),'cancellation',
    case when c.appointment_id is null then null else jsonb_build_object('cancellationId',c.cancellation_id,'reason',c.reason,
      'cancelledAt',c.cancelled_at,'cancelledByMe',c.cancelled_by=v_uid) end);
  return v_result;
end; $$;

create or replace function public.reopen_service_post(p_post_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); p public.posts; r record; v_requests uuid[]; v_event text:=gen_random_uuid()::text; v_count integer:=0;
begin
 perform private.assert_naver_activity_allowed();
 select * into p from public.posts where id=p_post_id and author_id=v_uid and status<>'deleted';
 if not found then raise exception 'post_unavailable' using errcode='P0002';end if;
 -- 차단/해제와 같은 pair → post 순서. 모든 기존 신청 pair를 전역 정규화 순으로 잠근다.
 select coalesce(array_agg(id),'{}'::uuid[]) into v_requests from public.join_requests where post_id=p.id;
 for r in select distinct least(v_uid,requester_id) a,greatest(v_uid,requester_id) b
   from public.join_requests where id=any(v_requests) order by a,b loop
   perform pg_advisory_xact_lock(hashtextextended(r.a::text||':'||r.b::text,324));
 end loop;
 select * into p from public.posts where id=p_post_id and author_id=v_uid and status<>'deleted' for update;
 if not found then raise exception 'post_unavailable' using errcode='P0002';end if;
 if p.starts_at<=clock_timestamp() or p.recruitment_ends_at<=clock_timestamp()
   or exists(select 1 from public.appointments where post_id=p.id and status<>'cancelled') then
   raise exception 'post_conflict' using errcode='40001';end if;
 if p.status='recruiting' then return jsonb_build_object('postId',p.id,'status',p.status,'updatedAt',p.updated_at,'restoredCount',0,'alreadyReopened',true);end if;
 if p.status<>'closed' or exists(select 1 from public.join_requests where post_id=p.id and status='not_selected' and not(id=any(v_requests))) then
   raise exception 'post_conflict' using errcode='40001';end if;
 perform private.lock_match_post_requests(p.id);
 perform private.expire_post_match_consents(p.id);
 update public.posts set status='recruiting' where id=p.id returning * into p;
 for r in select jr.id,jr.requester_id from public.join_requests jr
   where jr.post_id=p.id and jr.status='not_selected'
     and not exists(select 1 from public.join_requests newer where newer.post_id=p.id and newer.requester_id=jr.requester_id
       and (newer.created_at,newer.id)>(jr.created_at,jr.id))
     and not exists(select 1 from public.join_requests active where active.post_id=p.id and active.requester_id=jr.requester_id and active.status='pending')
   order by jr.id loop
   if private.members_blocked(v_uid,r.requester_id) or exists(
     select 1 from public.join_requests terminal where terminal.post_id=p.id and terminal.requester_id=r.requester_id
       and terminal.status='declined') then continue;end if;
   -- 최초 메시지/철회시각/거절/취소 및 약속 이력은 변경하지 않는다.
   update public.join_requests set status='pending' where id=r.id;
   delete from private.conversation_visibility where request_id=r.id;
   perform private.notify_match_lifecycle(r.id,'recruitment_reopened',v_event,jsonb_build_object('status','pending','postId',p.id));
   v_count:=v_count+1;
 end loop;
 return jsonb_build_object('postId',p.id,'status',p.status,'updatedAt',p.updated_at,'restoredCount',v_count,'alreadyReopened',false);
end; $$;
revoke all on function public.reopen_service_post(uuid) from public,anon,service_role;
grant execute on function public.reopen_service_post(uuid) to authenticated;
comment on function public.reopen_service_post(uuid) is '작성자의 명시 모집 재개. 기한 자동 연장 없이 유효 종료 신청과 기존 채팅을 복원한다.';
commit;
