-- 2026-10-05 최신 정책: 한쪽 후기 작성 마감 공개·기존 공개 보존·확정 요청 6시간.
-- 과거 마이그레이션과 이미 확정된 약속·동의·원 후기·완료 시각은 변경하지 않는다.
begin;

create or replace function private.review_release_ready(p_appointment_id uuid)
returns boolean language sql volatile security definer set search_path='' as $$
  select coalesce((select ap.status='completed' and ap.completed_at is not null and clock_timestamp()>=ap.completed_at and p.author_id<>r.requester_id
    and (ap.completion_method='automatic' or (ap.completion_method='manual'
      and exists(select 1 from public.appointment_completion_confirmations c where c.appointment_id=ap.id and c.user_id=p.author_id)
      and exists(select 1 from public.appointment_completion_confirmations c where c.appointment_id=ap.id and c.user_id=r.requester_id)))
    and not exists(select 1 from public.appointment_disputes d where d.appointment_id=ap.id
      and (d.status='open' or d.resolution='no_show'))
    and exists(select 1 from public.appointment_reviews rv where rv.appointment_id=ap.id and rv.reviewer_id in(p.author_id,r.requester_id))
    and ((exists(select 1 from public.appointment_reviews rv where rv.appointment_id=ap.id and rv.reviewer_id=p.author_id)
      and exists(select 1 from public.appointment_reviews rv where rv.appointment_id=ap.id and rv.reviewer_id=r.requester_id))
      or (ap.review_deadline_at is not null and clock_timestamp()>=ap.review_deadline_at))
    from public.appointments ap join public.posts p on p.id=ap.post_id join public.join_requests r on r.id=ap.join_request_id
    where ap.id=p_appointment_id),false);
$$;


-- 공개를 시작할 조건과 이미 공개한 후기의 유지 조건은 별개다.
-- override=false는 운영자 숨김이며 policy의 시간 조건으로 다시 공개하지 않는다.
create or replace function private.is_review_public_eligible(p_review_id uuid)
returns boolean language sql volatile security definer set search_path='' as $$
  select coalesce((select rv.reviewer_id in(p.author_id,r.requester_id) and p.author_id<>r.requester_id
    and ap.completed_at is not null and clock_timestamp()>=ap.completed_at
    and ap.status in('completed','disputed')
    and (ap.completion_method='automatic' or (ap.completion_method='manual'
      and exists(select 1 from public.appointment_completion_confirmations c where c.appointment_id=ap.id and c.user_id=p.author_id)
      and exists(select 1 from public.appointment_completion_confirmations c where c.appointment_id=ap.id and c.user_id=r.requester_id)))
    and not exists(select 1 from public.appointment_disputes d where d.appointment_id=ap.id and d.resolution='no_show')
    and (pub.is_public or (pub.publication_source='policy' and private.review_release_ready(ap.id)))
    from public.appointment_reviews rv join private.review_publication pub on pub.review_id=rv.id
    join public.appointments ap on ap.id=rv.appointment_id join public.posts p on p.id=ap.post_id
    join public.join_requests r on r.id=ap.join_request_id where rv.id=p_review_id),false);
$$;

-- 열람 여부와 무관하게 이미 공개 조건을 충족한 후기를 보류 전 보존한다.
-- 조회 함수는 쓰지 않으며, 분쟁과 상태 전환이 원래 약속을 잠근 상태에서 물질화한다.
create function private.preserve_released_reviews_before_hold()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_ap uuid;
begin
  if tg_table_name='appointment_disputes' then
    if new.status<>'open' then return new; end if;
    v_ap:=new.appointment_id;
  else
    if new.status is not distinct from old.status or new.status<>'disputed' then return new; end if;
    v_ap:=old.id;
  end if;
  perform 1 from public.appointments where id=v_ap for update;
  if private.review_release_ready(v_ap) then
    update private.review_publication pub set is_public=true
      from public.appointment_reviews rv
      where rv.id=pub.review_id and rv.appointment_id=v_ap
        and pub.publication_source='policy' and not pub.is_public;
  end if;
  return new;
end; $$;
create trigger review_preserve_before_dispute before insert or update on public.appointment_disputes
  for each row execute function private.preserve_released_reviews_before_hold();
create trigger review_preserve_before_appointment_hold before update of status on public.appointments
  for each row execute function private.preserve_released_reviews_before_hold();
revoke all on function private.preserve_released_reviews_before_hold() from public,anon,authenticated,service_role;

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
    values(p_request_id,p.id,v_version,v_now,least(v_now+interval '6 hours',p.starts_at),'awaiting_consent',null)
    on conflict(request_id) do update set condition_version=excluded.condition_version,requested_at=excluded.requested_at,
      expires_at=excluded.expires_at,status=excluded.status,ended_at=null;
  perform private.notify_match_lifecycle(p_request_id,'match_consent_requested',v_version,
    jsonb_build_object('conditionVersion',v_version,'status','awaiting_consent','expiresAt',least(v_now+interval '6 hours',p.starts_at)));
  return private.match_consent_json(p_request_id);
end; $$;


-- 기존 대기 요청의 기한을 새 상한으로 줄이되 수락·종료 이력은 보존한다.
-- 이 SQL 자체는 요청을 종료하거나 약속을 완료하지 않는다. 조회/기존 만료 처리기가 종료한다.
update private.match_consent_lifecycle l
set expires_at=least(l.expires_at,l.requested_at+interval '6 hours',p.starts_at)
from public.posts p where p.id=l.post_id and l.status='awaiting_consent';
-- 과거 종료된 제안의 만료·해결 이력은 보존하고 대기 제안만 새 상한을 적용한다.
alter table private.appointment_schedule_changes drop constraint appointment_schedule_change_expiry;
update private.appointment_schedule_changes
set expires_at=least(expires_at,requested_at+interval '6 hours',old_starts_at,new_starts_at)
where status='awaiting_response';
alter table private.appointment_schedule_changes add constraint appointment_schedule_change_expiry
  check(expires_at>requested_at and expires_at<=least(old_starts_at,new_starts_at)
    and (status<>'awaiting_response' or expires_at<=requested_at+interval '6 hours'));

create or replace function public.propose_appointment_schedule_change(p_appointment_id uuid,p_change_id uuid,p_starts_at timestamptz,p_ends_at timestamptz,p_expected_updated_at timestamptz)
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
    values(p_change_id,ap.id,v_uid,p.starts_at,p.ends_at,p.updated_at,p_starts_at,p_ends_at,v_now,least(v_now+interval '6 hours',p.starts_at,p_starts_at)) returning * into c;
  perform private.notify_match_lifecycle(ap.join_request_id,'appointment_schedule_change_requested',c.condition_version,
    jsonb_build_object('status',c.status,'changeId',c.change_id,'conditionVersion',c.condition_version,'expiresAt',c.expires_at));
  return private.appointment_schedule_change_json(c.change_id)||jsonb_build_object('deduplicated',false);
end; $$;


comment on function private.review_release_ready(uuid) is '신규 공개: 실제 완료 후 양쪽 제출 즉시 또는 현재 후기 작성 마감 도래. 검토 중 신규 공개 보류.';
comment on function private.is_review_public_eligible(uuid) is '이미 공개된 후기는 검토 접수만으로 숨기지 않으며 운영 override 숨김을 우선한다. 무효·노쇼는 제외.';
commit;
