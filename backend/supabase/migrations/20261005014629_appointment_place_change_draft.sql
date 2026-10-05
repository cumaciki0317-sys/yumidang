-- 독립 장소 변경 초안. main50 source 불변, 운영/원본 적용 보류: receipt 계약과 51 철회 선행 검토 필요.
-- 기본 기능만 별도 schema-only 장소 DB에서 검증하며 마감 접수 계약 완료로 주장하지 않는다.
-- 장소 입력은 대기 제안에만 보존하고 수락 뒤 현재 공고 위치를 사용한다.
begin;
alter table private.appointment_schedule_changes
 add column new_location_input jsonb,
 add column new_location_fingerprint text,
 add column old_location_fingerprint text,
 add column location_changed boolean not null default false,
 add constraint appointment_change_location_input check(new_location_input is null or
   (location_changed and status='awaiting_response' and jsonb_typeof(new_location_input)='object'));

create function private.validate_appointment_location(p_input jsonb)
returns jsonb language plpgsql immutable security definer set search_path='' as $$
declare v_key text;v_area text;v_address text;v_detail text;v_place text;v_region text;
begin
 if p_input is null then return null;end if;
 if jsonb_typeof(p_input) is distinct from 'object'
  or not p_input ?& array['publicArea','registeredPlaceName','registeredAddress','meetingDetail']
  or p_input-array['publicArea','registeredPlaceName','registeredAddress','meetingDetail']<>'{}'::jsonb then
  raise exception 'invalid_location' using errcode='22023';end if;
 foreach v_key in array array['publicArea','registeredAddress','meetingDetail'] loop
  if jsonb_typeof(p_input->v_key) is distinct from 'string' then raise exception 'invalid_location' using errcode='22023';end if;
 end loop;
 if jsonb_typeof(p_input->'registeredPlaceName') not in('string','null') then raise exception 'invalid_location' using errcode='22023';end if;
 v_area:=btrim(p_input->>'publicArea');v_address:=btrim(p_input->>'registeredAddress');v_detail:=btrim(p_input->>'meetingDetail');
 v_place:=nullif(btrim(p_input->>'registeredPlaceName'),'');
 v_region:=private.post_search_region(v_area);
 if char_length(v_area) not between 1 and 60 or char_length(v_address) not between 1 and 300
  or char_length(v_detail) not between 2 and 300 or char_length(v_place)>200
  or v_region is null or v_region not in('서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시','경기도','강원특별자치도','충청북도','충청남도','전북특별자치도','전라남도','경상북도','경상남도','제주특별자치도') then
  raise exception 'invalid_location' using errcode='22023';end if;
 return jsonb_build_object('publicArea',v_area,'registeredPlaceName',v_place,'registeredAddress',v_address,'meetingDetail',v_detail);
end; $$;
create function private.appointment_location_fingerprint(p_post_id uuid)
returns text language sql stable security definer set search_path='' as $$
 select encode(sha256(convert_to(jsonb_build_object('publicArea',p.public_area,'registeredPlaceName',l.registered_place_name,
  'registeredAddress',l.registered_address,'meetingDetail',d.exact_location)::text,'UTF8')),'hex')
 from public.posts p left join private.post_search_locations l on l.post_id=p.id
 left join public.post_private_details d on d.post_id=p.id where p.id=p_post_id;
$$;
revoke all on function private.validate_appointment_location(jsonb),private.appointment_location_fingerprint(uuid)
 from public,anon,authenticated,service_role;


create or replace function private.appointment_schedule_response_open(p_change_id uuid,p_at timestamptz)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select c.status='awaiting_response' and ap.status='confirmed' and p_at<c.expires_at
    and p_at>=c.requested_at
    and (c.old_location_fingerprint is null or c.old_location_fingerprint=private.appointment_location_fingerprint(p.id))
    and p.starts_at=c.old_starts_at and p.ends_at=c.old_ends_at and p.updated_at=c.old_updated_at
    and not exists(select 1 from public.appointment_disputes d where d.appointment_id=ap.id and (d.status='open' or d.resolution='no_show'))
    from private.appointment_schedule_changes c join public.appointments ap on ap.id=c.appointment_id
    join public.posts p on p.id=ap.post_id where c.change_id=p_change_id),false);
$$;

create or replace function private.appointment_schedule_change_json(p_change_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('appointmentId',appointment_id,'changeId',change_id,'conditionVersion',condition_version,'status',status,
    'oldSchedule',jsonb_build_object('startsAt',old_starts_at,'endsAt',old_ends_at),
    'newSchedule',jsonb_build_object('startsAt',new_starts_at,'endsAt',new_ends_at),
    'requestedByMe',requested_by=auth.uid(),'requestedAt',requested_at,'expiresAt',expires_at,'resolvedAt',resolved_at)
    || case when location_changed then jsonb_build_object('locationChanged',true,
      'newLocation',case when status='awaiting_response' and exists(select 1 from public.appointments ap
        join public.posts p on p.id=ap.post_id join public.join_requests r on r.id=ap.join_request_id
        where ap.id=private.appointment_schedule_changes.appointment_id and ap.status='confirmed' and auth.role()='authenticated'
          and auth.uid() in(p.author_id,r.requester_id)
          and (not(auth.jwt()?'is_anonymous') or auth.jwt()->'is_anonymous'='false'::jsonb)) then new_location_input else null end)
      else '{}'::jsonb end
    from private.appointment_schedule_changes where change_id=p_change_id;
$$;

create or replace function private.end_appointment_schedule_change(p_change_id uuid,p_status text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare c private.appointment_schedule_changes; v_request uuid;
begin
  if p_status not in('accepted','declined','expired','cancelled','withdrawn') then raise exception 'invalid_transition' using errcode='22023'; end if;
  update private.appointment_schedule_changes set status=p_status,resolved_at=clock_timestamp(),new_location_input=null
    where change_id=p_change_id and status='awaiting_response' returning * into c;
  if not found then return false; end if;
  select join_request_id into v_request from public.appointments where id=c.appointment_id;
  perform private.notify_match_lifecycle(v_request,'appointment_schedule_change_ended',c.condition_version,
    jsonb_build_object('status',p_status,'changeId',c.change_id,'conditionVersion',c.condition_version));
  return true;
end; $$;

create or replace function public.propose_appointment_schedule_change(p_appointment_id uuid,p_change_id uuid,p_starts_at timestamptz,p_ends_at timestamptz,p_expected_updated_at timestamptz,p_location jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); ap public.appointments; p public.posts; c private.appointment_schedule_changes;
  v_now timestamptz;v_location jsonb;v_location_fingerprint text;
begin
  perform private.assert_naver_activity_allowed();
  v_location:=private.validate_appointment_location(p_location);
  v_location_fingerprint:=encode(sha256(convert_to(coalesce(v_location,'null'::jsonb)::text,'UTF8')),'hex');
  if p_change_id is null or p_starts_at is null or p_ends_at is null or p_expected_updated_at is null
    or not isfinite(p_starts_at) or not isfinite(p_ends_at) or not isfinite(p_expected_updated_at) or p_ends_at<=p_starts_at then
    raise exception 'invalid_schedule' using errcode='22023';
  end if;
  if private.appointment_role(p_appointment_id) is null then raise exception 'appointment_unavailable' using errcode='PT404'; end if;
  ap:=private.lock_appointment_for_change(p_appointment_id);
  perform pg_advisory_xact_lock(hashtextextended(p_change_id::text,323));
  select * into c from private.appointment_schedule_changes where change_id=p_change_id;
  if found then
    if c.appointment_id<>ap.id or c.requested_by<>v_uid or c.new_starts_at<>p_starts_at or c.new_ends_at<>p_ends_at or c.old_updated_at<>p_expected_updated_at
      or (c.new_location_fingerprint is null and v_location is not null)
      or (c.new_location_fingerprint is not null and c.new_location_fingerprint<>v_location_fingerprint) then
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
    new_starts_at,new_ends_at,requested_at,expires_at,new_location_input,new_location_fingerprint,old_location_fingerprint,location_changed)
    values(p_change_id,ap.id,v_uid,p.starts_at,p.ends_at,p.updated_at,p_starts_at,p_ends_at,v_now,least(v_now+interval '6 hours',p.starts_at,p_starts_at),
      v_location,v_location_fingerprint,private.appointment_location_fingerprint(p.id),v_location is not null) returning * into c;
  perform private.notify_match_lifecycle(ap.join_request_id,'appointment_schedule_change_requested',c.condition_version,
    jsonb_build_object('status',c.status,'changeId',c.change_id,'conditionVersion',c.condition_version,'expiresAt',c.expires_at));
  return private.appointment_schedule_change_json(c.change_id)||jsonb_build_object('deduplicated',false);
end; $$;

-- 기존 일정 전용 호출의 인수와 의미를 유지한다. 새로운 body의 location만 추가 overload로 연결한다.
create or replace function public.propose_appointment_schedule_change(p_appointment_id uuid,p_change_id uuid,p_starts_at timestamptz,p_ends_at timestamptz,p_expected_updated_at timestamptz)
returns jsonb language sql volatile security definer set search_path='' as $$
 select public.propose_appointment_schedule_change(p_appointment_id,p_change_id,p_starts_at,p_ends_at,p_expected_updated_at,null::jsonb);
$$;
revoke all on function public.propose_appointment_schedule_change(uuid,uuid,timestamptz,timestamptz,timestamptz,jsonb)
 from public,anon,service_role;
grant execute on function public.propose_appointment_schedule_change(uuid,uuid,timestamptz,timestamptz,timestamptz,jsonb) to authenticated;


create or replace function public.accept_appointment_schedule_change(p_appointment_id uuid,p_change_id uuid,p_condition_version text)
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
    recruitment_ends_at=least(recruitment_ends_at,c.new_starts_at),
    public_area=case when c.location_changed then c.new_location_input->>'publicArea' else public_area end where id=ap.post_id;
  if c.location_changed then
    perform public.set_post_search_location(ap.post_id,c.new_location_input->>'registeredPlaceName',c.new_location_input->>'registeredAddress');
    update public.post_private_details set exact_location=c.new_location_input->>'meetingDetail' where post_id=ap.post_id;
    if not found then raise exception 'location_unavailable' using errcode='40001';end if;
  end if;
  perform private.end_appointment_schedule_change(c.change_id,'accepted');
  return private.appointment_schedule_change_json(c.change_id)||jsonb_build_object('deduplicated',false);
end; $$;

comment on column private.appointment_schedule_changes.new_location_input
 is '대기 중 새 장소 입력. 공개 검색·알림에 넣지 않으며 제안 종료 시 정리한다. 과거 장소 원문 이력을 추가하지 않는다.';
commit;
