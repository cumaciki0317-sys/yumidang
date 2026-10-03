-- 무료 공고 관리·최종 동의 생명주기. 기존 행을 일괄 종료하거나 다시 인증하지 않는다.
begin;

create table private.match_consent_lifecycle (
  request_id uuid primary key references private.match_consents(request_id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  condition_version text not null,
  requested_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null check(status in ('awaiting_consent','accepted','expired','withdrawn','declined','invalidated')),
  ended_at timestamptz,
  constraint match_consent_expiry_order check(expires_at>requested_at),
  constraint match_consent_end_state check((status='awaiting_consent')=(ended_at is null))
);
create unique index match_consent_one_active_per_post on private.match_consent_lifecycle(post_id)
  where status='awaiting_consent';
create index match_consent_due on private.match_consent_lifecycle(expires_at,post_id) where status='awaiting_consent';
create table private.match_lifecycle_events (
  event_key text not null,
  request_id uuid not null references public.join_requests(id) on delete cascade,
  kind text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(event_key,request_id,kind)
);
alter table private.match_consent_lifecycle enable row level security;
alter table private.match_lifecycle_events enable row level security;
revoke all on private.match_consent_lifecycle,private.match_lifecycle_events from public,anon,authenticated,service_role;
alter table public.notifications add column event_data jsonb not null default '{}'::jsonb;
alter table public.notifications drop constraint notifications_kind_allowed;
alter table public.notifications add constraint notifications_kind_allowed check(kind in
  ('join_request','appointment_completed','match_consent_requested','match_confirmed','match_consent_ended',
   'post_conditions_changed','post_deleted','match_not_selected'));

-- 기존 알림 유일키를 유지한다. 새 이벤트가 있을 때만 같은 관계의 알림을 다시 미확인으로 표시한다.
create function private.notify_match_lifecycle(p_request_id uuid,p_kind text,p_event_key text,p_data jsonb)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  insert into private.match_lifecycle_events(event_key,request_id,kind) values(p_event_key,p_request_id,p_kind)
    on conflict do nothing;
  if not found then return; end if;
  insert into public.notifications(recipient_id,kind,join_request_id,created_at,event_data)
    select u.id,p_kind,r.id,clock_timestamp(),p_data from public.join_requests r
      join public.posts p on p.id=r.post_id join public.profiles u on u.id in(r.requester_id,p.author_id)
      where r.id=p_request_id
    on conflict(recipient_id,kind,join_request_id) do update
      set created_at=excluded.created_at,read_at=null,event_data=excluded.event_data;
end; $$;

create function private.lock_match_post_requests(p_post_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  -- 호출자는 공고를 먼저 잠근다. 이후 신청 UUID 순서 → 동의 UUID 순서다.
  perform 1 from public.join_requests where post_id=p_post_id order by id for update;
  perform 1 from private.match_consents c join public.join_requests r on r.id=c.request_id
    where r.post_id=p_post_id order by c.request_id for update of c;
  perform 1 from private.match_consent_lifecycle where post_id=p_post_id order by request_id for update;
end; $$;

create function private.end_match_consent(p_request_id uuid,p_status text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare l private.match_consent_lifecycle;
begin
  if p_status not in ('expired','withdrawn','declined','invalidated') then raise exception 'invalid_transition' using errcode='22023'; end if;
  update private.match_consent_lifecycle set status=p_status,ended_at=clock_timestamp()
    where request_id=p_request_id and status='awaiting_consent' returning * into l;
  if found then
    perform private.notify_match_lifecycle(p_request_id,'match_consent_ended',l.condition_version,
      jsonb_build_object('status',p_status,'conditionVersion',l.condition_version));
  end if;
end; $$;

create function private.expire_post_match_consents(p_post_id uuid)
returns integer language plpgsql volatile security definer set search_path='' as $$
declare l private.match_consent_lifecycle; n integer:=0;
begin
  for l in select * from private.match_consent_lifecycle where post_id=p_post_id
    and status='awaiting_consent' and expires_at<=clock_timestamp() order by request_id loop
    perform private.end_match_consent(l.request_id,'expired'); n:=n+1;
  end loop;
  return n;
end; $$;

create function public.expire_match_consents(p_limit integer default 100)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_post uuid; n integer:=0;
begin
  if p_limit is null or p_limit not between 1 and 1000 then raise exception 'invalid_input' using errcode='22023'; end if;
  for v_post in select distinct post_id from private.match_consent_lifecycle
    where status='awaiting_consent' and expires_at<=clock_timestamp() order by post_id limit p_limit loop
    perform 1 from public.posts where id=v_post for update skip locked;
    if found then
      perform private.lock_match_post_requests(v_post);
      n:=n+private.expire_post_match_consents(v_post);
    end if;
  end loop;
  return jsonb_build_object('expiredCount',n);
end; $$;

create or replace function private.match_conditions(p_post_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('postId',id,'title',title,'description',description,'category',category,
    'startsAt',starts_at,'endsAt',ends_at,'publicArea',public_area,'preferenceNote',preference_note,'tags',to_jsonb(tags),
    'costType',cost_type,'amount',amount,'paymentDirection','none') from public.posts where id=p_post_id;
$$;

create function private.match_consent_json(p_request_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c private.match_consents; l private.match_consent_lifecycle;
begin
  select * into c from private.match_consents where request_id=p_request_id;
  if not found then return jsonb_build_object('consent',null); end if;
  select * into l from private.match_consent_lifecycle where request_id=p_request_id and condition_version=c.condition_version;
  return jsonb_build_object('requestId',p_request_id,'conditionVersion',c.condition_version,'conditions',c.conditions,
    'requestedAt',c.requested_at,'expiresAt',l.expires_at,
    'status',case when c.accepted_at is not null then 'accepted' when l.request_id is null then 'renewal_required' else l.status end);
end; $$;

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
    or exists(select 1 from public.appointments where post_id=p.id) then raise exception 'match_conflict' using errcode='40001'; end if;
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
    values(p_request_id,p.id,v_version,v_now,least(v_now+interval '24 hours',p.starts_at),'awaiting_consent',null)
    on conflict(request_id) do update set condition_version=excluded.condition_version,requested_at=excluded.requested_at,
      expires_at=excluded.expires_at,status=excluded.status,ended_at=null;
  perform private.notify_match_lifecycle(p_request_id,'match_consent_requested',v_version,
    jsonb_build_object('conditionVersion',v_version,'status','awaiting_consent','expiresAt',least(v_now+interval '24 hours',p.starts_at)));
  return private.match_consent_json(p_request_id);
end; $$;

create or replace function public.get_match_consent(p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); v_post uuid;
begin
  if private.request_role(p_request_id) is null then raise exception 'request_unavailable' using errcode='P0002'; end if;
  select post_id into v_post from public.join_requests where id=p_request_id;
  perform 1 from public.posts where id=v_post for update;
  perform private.lock_match_post_requests(v_post);
  perform private.expire_post_match_consents(v_post);
  return private.match_consent_json(p_request_id);
end; $$;

create function private.end_match_consent_for_member(p_request_id uuid,p_condition_version text,p_status text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); r public.join_requests; p public.posts;
  c private.match_consents; l private.match_consent_lifecycle; v_already boolean;
begin
  select * into r from public.join_requests where id=p_request_id;
  select * into p from public.posts where id=r.post_id for update;
  if p.id is null or (p_status='withdrawn' and p.author_id<>v_uid) or (p_status='declined' and r.requester_id<>v_uid) then
    raise exception 'request_unavailable' using errcode='P0002';
  end if;
  perform private.lock_match_post_requests(p.id);
  perform private.expire_post_match_consents(p.id);
  select * into c from private.match_consents where request_id=p_request_id;
  select * into l from private.match_consent_lifecycle where request_id=p_request_id;
  if p_condition_version is null or c.condition_version is distinct from p_condition_version
    or l.condition_version is distinct from p_condition_version or c.accepted_at is not null then
    raise exception 'condition_conflict' using errcode='40001';
  end if;
  v_already:=l.status<>'awaiting_consent';
  if l.status='awaiting_consent' then perform private.end_match_consent(p_request_id,p_status);
  elsif l.status not in(p_status,'expired') then raise exception 'match_conflict' using errcode='40001'; end if;
  select * into l from private.match_consent_lifecycle where request_id=p_request_id;
  return jsonb_build_object('requestId',p_request_id,'conditionVersion',p_condition_version,'status',l.status,'alreadyEnded',v_already);
end; $$;
create function public.withdraw_match_consent(p_request_id uuid,p_condition_version text)
returns jsonb language sql volatile security definer set search_path='' as $$
  select private.end_match_consent_for_member(p_request_id,p_condition_version,'withdrawn');
$$;
create function public.decline_match_consent(p_request_id uuid,p_condition_version text)
returns jsonb language sql volatile security definer set search_path='' as $$
  select private.end_match_consent_for_member(p_request_id,p_condition_version,'declined');
$$;

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
  select * into v_appointment from public.appointments where post_id=v_post.id;
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


create function private.assert_service_post_input(p_input jsonb)
returns void language plpgsql stable security definer set search_path='' as $$
declare v_key text;
begin
  if p_input is null or jsonb_typeof(p_input)<>'object'
    or not p_input ?& array['title','description','category','startsAt','endsAt','recruitmentEndsAt','publicArea',
      'registeredPlaceName','registeredAddress','meetingDetail','preferenceNote','tags','costType','amount']
    or p_input - array['title','description','category','startsAt','endsAt','recruitmentEndsAt','publicArea',
      'registeredPlaceName','registeredAddress','meetingDetail','preferenceNote','tags','costType','amount'] <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode='22023';
  end if;
  foreach v_key in array array['title','description','category','startsAt','endsAt','recruitmentEndsAt','publicArea','registeredAddress','meetingDetail','costType'] loop
    if jsonb_typeof(p_input->v_key) is distinct from 'string' then raise exception 'invalid_input' using errcode='22023'; end if;
  end loop;
  foreach v_key in array array['registeredPlaceName','preferenceNote'] loop
    if jsonb_typeof(p_input->v_key) not in ('string','null') then raise exception 'invalid_input' using errcode='22023'; end if;
  end loop;
  if p_input->>'costType'<>'free' then raise exception 'bank_integration_unavailable' using errcode='PT503'; end if;
  if p_input->'amount'<>'0'::jsonb or jsonb_typeof(p_input->'tags')<>'array'
    or jsonb_array_length(p_input->'tags')>5 then raise exception 'invalid_input' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_input->'tags') t where jsonb_typeof(t)<>'string') then
    raise exception 'invalid_input' using errcode='22023';
  end if;
  if char_length(btrim(p_input->>'registeredAddress')) not between 1 and 300
    or char_length(coalesce(p_input->>'registeredPlaceName',''))>200
    or not isfinite((p_input->>'startsAt')::timestamptz)
    or not isfinite((p_input->>'endsAt')::timestamptz)
    or not isfinite((p_input->>'recruitmentEndsAt')::timestamptz) then
    raise exception 'invalid_input' using errcode='22023';
  end if;
  if (p_input->>'startsAt')::timestamptz<=clock_timestamp()
    or (p_input->>'endsAt')::timestamptz<=(p_input->>'startsAt')::timestamptz
    or (p_input->>'recruitmentEndsAt')::timestamptz>(p_input->>'startsAt')::timestamptz then
    raise exception 'invalid_input' using errcode='22023';
  end if;
exception when invalid_datetime_format or datetime_field_overflow then
  raise exception 'invalid_input' using errcode='22023';
end; $$;

create function private.set_post_lifecycle_updated_at()
returns trigger language plpgsql set search_path='' as $$
begin new.updated_at:=clock_timestamp(); return new; end; $$;
drop trigger posts_set_updated_at on public.posts;
create trigger posts_set_updated_at before update on public.posts for each row execute function private.set_post_lifecycle_updated_at();

create function public.update_service_post(p_post_id uuid,p_input jsonb,p_expected_updated_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); p public.posts; v_tags text[]; v_old text; v_request uuid; v_event text;
begin
  perform private.assert_naver_activity_allowed();
  if p_expected_updated_at is null or not isfinite(p_expected_updated_at) then raise exception 'invalid_input' using errcode='22023'; end if;
  perform private.assert_service_post_input(p_input);
  select * into p from public.posts where id=p_post_id and author_id=v_uid and status<>'deleted' for update;
  if not found then raise exception 'post_unavailable' using errcode='P0002'; end if;
  if p.updated_at<>p_expected_updated_at or exists(select 1 from public.appointments where post_id=p.id)
    or p.starts_at<=clock_timestamp() then raise exception 'post_conflict' using errcode='40001'; end if;
  perform private.lock_match_post_requests(p.id);
  perform private.expire_post_match_consents(p.id);
  v_old:=private.match_condition_version(p.id);
  select coalesce(array_agg(value),'{}'::text[]) into v_tags from jsonb_array_elements_text(p_input->'tags');
  update public.posts set title=p_input->>'title',description=p_input->>'description',category=p_input->>'category',
    starts_at=(p_input->>'startsAt')::timestamptz,ends_at=(p_input->>'endsAt')::timestamptz,
    recruitment_ends_at=(p_input->>'recruitmentEndsAt')::timestamptz,public_area=p_input->>'publicArea',
    preference_note=p_input->>'preferenceNote',tags=v_tags,cost_type='free',amount=0 where id=p.id returning * into p;
  update public.post_private_details set exact_location=p_input->>'meetingDetail' where post_id=p.id;
  if not found then insert into public.post_private_details(post_id,exact_location) values(p.id,p_input->>'meetingDetail'); end if;
  perform public.set_post_search_location(p.id,p_input->>'registeredPlaceName',p_input->>'registeredAddress');
  -- 최초 생성 재시도용 service_post_inputs는 원본 그대로 보존한다.
  if v_old is distinct from private.match_condition_version(p.id) then
    v_event:=gen_random_uuid()::text;
    for v_request in select id from public.join_requests where post_id=p.id and status='pending' order by id loop
      perform private.end_match_consent(v_request,'invalidated');
      perform private.notify_match_lifecycle(v_request,'post_conditions_changed',v_event,jsonb_build_object('status','conditions_changed'));
    end loop;
  end if;
  return jsonb_build_object('postId',p.id,'status',p.status,'updatedAt',p.updated_at);
exception when check_violation or not_null_violation then raise exception 'invalid_input' using errcode='22023';
end; $$;

create function public.close_service_post(p_post_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); p public.posts;
begin
  select * into p from public.posts where id=p_post_id and author_id=v_uid and status<>'deleted' for update;
  if not found then raise exception 'post_unavailable' using errcode='P0002'; end if;
  if p.status='recruiting' then update public.posts set status='closed' where id=p.id returning * into p;
  elsif p.status<>'closed' then raise exception 'post_conflict' using errcode='40001'; end if;
  return jsonb_build_object('postId',p.id,'status',p.status,'updatedAt',p.updated_at);
end; $$;

create function public.delete_service_post(p_post_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); p public.posts; v_request uuid;
begin
  select * into p from public.posts where id=p_post_id and author_id=v_uid for update;
  if not found then raise exception 'post_unavailable' using errcode='P0002'; end if;
  if p.status='deleted' then return jsonb_build_object('postId',p.id,'status',p.status,'updatedAt',p.updated_at); end if;
  -- 삭제는 확정 약속의 취소가 아니다. 종료 시각 이전 확정 이력은 그대로 보호한다.
  if p.ends_at>clock_timestamp() and exists(select 1 from public.appointments where post_id=p.id) then
    raise exception 'appointment_active' using errcode='40001';
  end if;
  perform private.lock_match_post_requests(p.id);
  for v_request in select id from public.join_requests where post_id=p.id and status='pending' order by id loop
    perform private.end_match_consent(v_request,'invalidated');
    update public.join_requests set status='not_selected' where id=v_request;
    perform private.notify_match_lifecycle(v_request,'post_deleted',p.id::text,jsonb_build_object('status','deleted'));
  end loop;
  update public.posts set status='deleted' where id=p.id returning * into p;
  return jsonb_build_object('postId',p.id,'status',p.status,'updatedAt',p.updated_at);
end; $$;

create or replace function public.withdraw_join_request(p_request_id uuid)
returns table(id uuid,status text,updated_at timestamptz)
language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); r public.join_requests; p public.posts;
begin
  select * into r from public.join_requests where public.join_requests.id=p_request_id;
  select * into p from public.posts where public.posts.id=r.post_id for update;
  if p.id is null or r.requester_id<>v_uid then raise exception 'request_unavailable' using errcode='P0002'; end if;
  perform private.lock_match_post_requests(p.id);
  select * into r from public.join_requests where public.join_requests.id=p_request_id;
  if r.status='pending' then
    perform private.end_match_consent(p_request_id,'withdrawn');
    update public.join_requests j set status='withdrawn' where j.id=p_request_id returning j.* into r;
  elsif r.status<>'withdrawn' then raise exception 'invalid_transition' using errcode='22023'; end if;
  return query select r.id,r.status,r.updated_at;
end; $$;

create or replace function public.decline_join_request(p_request_id uuid)
returns table(id uuid,status text,updated_at timestamptz)
language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); r public.join_requests; p public.posts;
begin
  select * into r from public.join_requests where public.join_requests.id=p_request_id;
  select * into p from public.posts where public.posts.id=r.post_id for update;
  if p.id is null or p.author_id<>v_uid then raise exception 'request_unavailable' using errcode='P0002'; end if;
  perform private.lock_match_post_requests(p.id);
  select * into r from public.join_requests where public.join_requests.id=p_request_id;
  if r.status='pending' then
    perform private.end_match_consent(p_request_id,'declined');
    update public.join_requests j set status='declined' where j.id=p_request_id returning j.* into r;
  elsif r.status<>'declined' then raise exception 'invalid_transition' using errcode='22023'; end if;
  return query select r.id,r.status,r.updated_at;
end; $$;

create or replace function public.request_service_post(p_post_id uuid,p_message text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); p public.posts; v_result jsonb;
begin
  perform private.assert_naver_activity_allowed();
  select * into p from public.posts where id=p_post_id and status<>'deleted' for update;
  if not found then raise exception 'post_unavailable' using errcode='P0002'; end if;
  if p.cost_type is distinct from 'free' then raise exception 'bank_integration_unavailable' using errcode='PT503'; end if;
  if p.status<>'recruiting' or p.recruitment_ends_at<=clock_timestamp() or p.starts_at<=clock_timestamp()
    or exists(select 1 from public.appointments where post_id=p.id) then raise exception 'recruitment_closed' using errcode='40001'; end if;
  perform private.lock_match_post_requests(p.id);
  select to_jsonb(r) into v_result from public.create_join_request(p_post_id,p_message) r;
  return v_result;
end; $$;

-- 취소·불발·분쟁은 정확한 장소를 열람하는 확정 관계로 취급하지 않는다.
create or replace function private.is_confirmed_companion(p_post_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.appointments ap join public.join_requests r on r.id=ap.join_request_id
    where ap.post_id=p_post_id and ap.status in('confirmed','completed') and r.requester_id=auth.uid());
$$;
create or replace function public.get_service_post(p_post_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); p public.posts; v_details jsonb; v_names jsonb; v_result jsonb; v_pair boolean;
begin
  select * into p from public.posts where id=p_post_id and status<>'deleted';
  if not found then raise exception 'post_unavailable' using errcode='P0002'; end if;
  v_pair:=v_uid is not null and exists(select 1 from public.appointments ap join public.join_requests r on r.id=ap.join_request_id
    where ap.post_id=p.id and ap.status in('confirmed','completed') and v_uid in(p.author_id,r.requester_id));
  select jsonb_build_object('postId',p.id,'title',p.title,'description',p.description,'category',p.category,
    'startsAt',p.starts_at,'endsAt',p.ends_at,'recruitmentEndsAt',p.recruitment_ends_at,'updatedAt',p.updated_at,
    'publicArea',p.public_area,'status',p.status,'costType',p.cost_type,'amount',p.amount,
    'preferenceNote',p.preference_note,'tags',to_jsonb(p.tags),
    'authorDisplayName',case when v_uid is null then '동행-'||replace(p.id::text,'-','')
      when v_pair or p.author_id=v_uid then pr.real_name else public.mask_real_name(pr.real_name) end)
    into v_result from public.profiles pr where pr.id=p.author_id;
  if v_uid is not null and (p.author_id=v_uid or v_pair) then
    select jsonb_build_object('registeredPlaceName',l.registered_place_name,'registeredAddress',l.registered_address,
      'meetingDetail',d.exact_location) into v_details from private.post_search_locations l
      join public.post_private_details d on d.post_id=l.post_id where l.post_id=p.id;
    select jsonb_agg(jsonb_build_object('userId',pr.id,'realName',pr.real_name) order by pr.id) into v_names
      from public.profiles pr where pr.id=p.author_id or (v_pair and pr.id in(
        select r.requester_id from public.appointments ap join public.join_requests r on r.id=ap.join_request_id
          where ap.post_id=p.id and ap.status in('confirmed','completed')));
    v_result:=v_result||jsonb_build_object('privateDetails',v_details,'participantNames',v_names);
  end if;
  return v_result;
end; $$;

create or replace function public.list_my_notifications(p_limit integer,p_before uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); v_before public.notifications; v_result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_input' using errcode='22023'; end if;
  if p_before is not null then
    select * into v_before from public.notifications where id=p_before and recipient_id=v_uid;
    if not found then raise exception 'cursor_unavailable' using errcode='P0002'; end if;
  end if;
  with candidates as materialized(select * from public.notifications where recipient_id=v_uid
    and(p_before is null or (created_at,id)<(v_before.created_at,v_before.id)) order by created_at desc,id desc limit p_limit+1),
    page as(select * from candidates order by created_at desc,id desc limit p_limit)
  select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('notificationId',id,'kind',kind,
    'requestId',join_request_id,'createdAt',created_at,'readAt',read_at,'eventData',event_data) order by created_at desc,id desc) from page),'[]'::jsonb),
    'nextCursor',case when (select count(*) from candidates)>p_limit then(select id from page order by created_at,id limit 1) else null end)
    into v_result;
  return v_result;
end; $$;

revoke all on function private.notify_match_lifecycle(uuid,text,text,jsonb),private.lock_match_post_requests(uuid),
  private.end_match_consent(uuid,text),private.expire_post_match_consents(uuid),private.match_consent_json(uuid),
  private.end_match_consent_for_member(uuid,text,text),private.assert_service_post_input(jsonb),private.set_post_lifecycle_updated_at()
  from public,anon,authenticated,service_role;
revoke all on function public.expire_match_consents(integer) from public,anon,authenticated,service_role;
grant execute on function public.expire_match_consents(integer) to service_role;
revoke all on function public.update_service_post(uuid,jsonb,timestamptz),public.close_service_post(uuid),public.delete_service_post(uuid),
  public.withdraw_match_consent(uuid,text),public.decline_match_consent(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.update_service_post(uuid,jsonb,timestamptz),public.close_service_post(uuid),public.delete_service_post(uuid),
  public.withdraw_match_consent(uuid,text),public.decline_match_consent(uuid,text) to authenticated;
revoke all on function public.confirm_match(uuid),public.create_post(uuid,text,text,text,timestamptz,timestamptz,timestamptz,text,text,text,text[],text),
  public.create_join_request(uuid,text) from public,anon,authenticated,service_role;
revoke insert,update,delete on public.posts,public.join_requests,public.appointments,public.post_private_details from anon,authenticated;
-- 기존 SELECT/RLS와 관계 정리 RPC 실행 권한은 보존한다.
comment on table private.match_consent_lifecycle is '새로 요청한 최종 동의의 버전·24시간/시작시각 만료·종료. 과거 consent 이력 자동 전환 없음.';
comment on table private.match_lifecycle_events is '생명주기 알림 중복 방지용 사건 식별자. 원문·주소·실명 저장 없음.';
commit;
