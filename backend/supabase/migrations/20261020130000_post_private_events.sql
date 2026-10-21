-- 민규: 공고 전용 직접 입력 행사. 공용 source_events 행을 만들지 않는다.
begin;
create function private.normalize_post_manual_event(p_value jsonb) returns jsonb
language plpgsql immutable security definer set search_path='' as $$
declare k text; v jsonb;
begin
 if p_value is null or p_value='null'::jsonb then return null; end if;
 if jsonb_typeof(p_value)<>'object' or not p_value ?& array['title','placeName','publicAddress','publicAddressConfirmed']
  or p_value-array['title','placeName','publicAddress','publicAddressConfirmed']<>'{}'::jsonb then
  raise exception 'invalid_manual_event' using errcode='22023'; end if;
 foreach k in array array['title','placeName','publicAddress'] loop
  if jsonb_typeof(p_value->k) is distinct from 'string' or p_value->>k ~ '[<>[:cntrl:]]' then
   raise exception 'invalid_manual_event' using errcode='22023'; end if;
 end loop;
 v:=jsonb_build_object('title',btrim(p_value->>'title'),'placeName',btrim(p_value->>'placeName'),
  'publicAddress',btrim(p_value->>'publicAddress'),'publicAddressConfirmed',p_value->'publicAddressConfirmed');
 if char_length(v->>'title') not between 1 and 200 or char_length(v->>'placeName')>200
  or char_length(v->>'publicAddress')>300 or jsonb_typeof(v->'publicAddressConfirmed') is distinct from 'boolean'
  or (v->>'publicAddress'<>'' and v->'publicAddressConfirmed'<>'true'::jsonb) then
  raise exception 'invalid_manual_event' using errcode='22023'; end if;
 return v;
end; $$;
create table private.post_manual_events (
 post_id uuid primary key references public.posts(id) on delete cascade,
 current_event jsonb, creation_event jsonb,
 check(current_event is null or private.normalize_post_manual_event(current_event)=current_event),
 check(creation_event is null or private.normalize_post_manual_event(creation_event)=creation_event)
);
alter table private.post_manual_events enable row level security;
revoke all on private.post_manual_events from public,anon,authenticated,service_role;

-- 비표출은 원천 삭제와 별개다. owner가 명시적으로 판정한 행만 기록한다.
-- 일반 수집 upsert는 이 판정을 지우거나 자동 재공개하지 않는다.
create table private.event_source_display (
 source_event_id uuid primary key references private.source_events(id) on delete restrict,
 is_public boolean not null default false
);
alter table private.event_source_display enable row level security;
revoke all on private.event_source_display from public,anon,authenticated,service_role;
create function private.post_event_source_hidden(p_event_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select private.member_content_hidden('event',p_event_id) or exists(
  select 1 from private.event_source_display where source_event_id=p_event_id and not is_public);
$$;

-- 기존 wrapper의 본인·자격·content ticket 검사 뒤에만 호출하는 내부 경계.
alter function private.create_service_post_before_content_inspection(uuid,jsonb) rename to create_post_before_manual_events;
create function private.create_service_post_before_content_inspection(p_post_id uuid,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; manual jsonb; original jsonb;
begin
 if p_input?'eventChangeId' then raise exception 'invalid_input' using errcode='22023'; end if;
 manual:=private.normalize_post_manual_event(p_input->'manualEvent');
 if manual is not null and not coalesce((select enabled from private.content_inspection_control where singleton),false) then
  raise exception 'manual_event_inspection_not_enabled' using errcode='55000'; end if;
 if manual is not null and private.parse_post_event_id(p_input->'eventId') is not null then
  raise exception 'invalid_event_selection' using errcode='22023'; end if;
 result:=private.create_post_before_manual_events(p_post_id,p_input-'manualEvent');
 if result->>'alreadyCreated'='true' then
  select creation_event into original from private.post_manual_events where post_id=p_post_id;
  if original is distinct from manual then raise exception 'post_conflict' using errcode='40001'; end if;
 else
  insert into private.post_manual_events(post_id,current_event,creation_event) values(p_post_id,manual,manual);
 end if;
 return result;
end; $$;

alter function private.match_conditions(uuid) rename to match_conditions_before_manual_event;
create function private.match_conditions(p_post_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select private.match_conditions_before_manual_event(p_post_id) ||
  coalesce((select jsonb_build_object('manualEvent',current_event) from private.post_manual_events
    where post_id=p_post_id and current_event is not null),'{}'::jsonb);
$$;

alter table private.appointment_schedule_changes
 add column event_changed boolean not null default false,
 add column new_event_input jsonb,
 add column event_fingerprint text,
 add column event_request_fingerprint text,
 add column event_applied_updated_at timestamptz,
 add constraint appointment_event_input_state check(new_event_input is null or
   (event_changed and status='awaiting_response' and jsonb_typeof(new_event_input)='object'));

alter function private.appointment_schedule_change_json(uuid) rename to change_json_before_manual_event;
create function private.appointment_schedule_change_json(p_change_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select private.change_json_before_manual_event(p_change_id) ||
  case when c.event_changed then jsonb_build_object('changeKind','event','eventFingerprint',c.event_fingerprint,
   'newEventInput',case when c.status='awaiting_response' and private.appointment_role(c.appointment_id) is not null
    then c.new_event_input else null end,
   'newLinkedEvent',case when c.status='awaiting_response' and private.appointment_role(c.appointment_id) is not null
    then private.project_post_linked_event(private.parse_post_event_id(c.new_event_input->'eventId')) else null end) else '{}'::jsonb end
 from private.appointment_schedule_changes c where c.change_id=p_change_id;
$$;
alter function private.end_appointment_schedule_change(uuid,text) rename to end_change_before_manual_event;
create function private.end_appointment_schedule_change(p_change_id uuid,p_status text) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare result boolean;
begin
 result:=private.end_change_before_manual_event(p_change_id,p_status);
 if result then update private.appointment_schedule_changes set new_event_input=null where change_id=p_change_id; end if;
 return result;
end; $$;
-- end_change_before_manual_event의 UPDATE가 상태 CHECK를 위반하지 않도록 같은 UPDATE에서 정리한다.
create function private.clear_finished_event_change() returns trigger language plpgsql set search_path='' as $$
begin if new.status<>'awaiting_response' then new.new_event_input:=null; end if; return new; end; $$;
create trigger clear_finished_event_change before update on private.appointment_schedule_changes
 for each row execute function private.clear_finished_event_change();

-- 제안 응답 유실 재시도는 소비된 검사 ticket도 같은 현재 상태를 판정한다.
create function private.post_event_change_result(p_post_id uuid,p_input jsonb,p_expected_updated_at timestamptz) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_service_profile(); c private.appointment_schedule_changes; ap public.appointments; stamp timestamptz;
begin
 select * into c from private.appointment_schedule_changes where change_id=private.parse_post_event_id(p_input->'eventChangeId');
 if c.change_id is null then raise exception 'schedule_change_conflict' using errcode='40001'; end if;
 ap:=private.lock_appointment_for_change(c.appointment_id);
 if ap.post_id<>p_post_id or c.requested_by<>u or not c.event_changed or c.old_updated_at is distinct from p_expected_updated_at
  or c.event_request_fingerprint is distinct from encode(sha256(convert_to(p_input::text,'UTF8')),'hex') then
  raise exception 'schedule_change_conflict' using errcode='40001'; end if;
 perform private.expire_appointment_schedule_changes(ap.id);
 select * into strict c from private.appointment_schedule_changes where change_id=(p_input->>'eventChangeId')::uuid;
 if c.status not in('awaiting_response','accepted','declined','expired','cancelled','withdrawn') then
  raise exception 'schedule_change_conflict' using errcode='40001'; end if;
 select updated_at into stamp from public.posts where id=p_post_id;
 if c.status='accepted' then
  if c.event_applied_updated_at is null then raise exception 'schedule_change_conflict' using errcode='40001'; end if;
  stamp:=c.event_applied_updated_at;
 end if;
 return jsonb_build_object('postId',p_post_id,'status',case when c.status='awaiting_response' then 'event_change_pending'
  else 'event_change_'||c.status end,'updatedAt',stamp);
end; $$;

alter function private.update_service_post_before_content_inspection(uuid,jsonb,timestamptz) rename to update_post_before_manual_events;
create function private.update_service_post_before_content_inspection(p_post_id uuid,p_input jsonb,p_expected_updated_at timestamptz) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_service_profile(); p public.posts; ap public.appointments;
 manual jsonb; event_id uuid; result jsonb; old_version text; delegated_version text; req uuid; marker text;
 v_change_id uuid; c private.appointment_schedule_changes; selection jsonb; current_input jsonb; t timestamptz;
begin
 perform private.assert_naver_activity_allowed();
 perform private.assert_service_post_input(p_input-array['eventId','manualEvent','eventChangeId']);
 select * into p from public.posts where id=p_post_id and author_id=u and status<>'deleted' for update;
 if not found then raise exception 'post_unavailable' using errcode='P0002'; end if;
 event_id:=case when p_input?'eventId' then private.parse_post_event_id(p_input->'eventId') else p.source_event_id end;
 select current_event into manual from private.post_manual_events where post_id=p_post_id;
 if p_input?'manualEvent' then
  manual:=private.normalize_post_manual_event(p_input->'manualEvent');
  if manual is not null and not coalesce((select enabled from private.content_inspection_control where singleton),false) then
   raise exception 'manual_event_inspection_not_enabled' using errcode='55000'; end if;
 end if;
 if p_input?'manualEvent' and manual is not null and not(p_input?'eventId') then event_id:=null; end if;
 if p_input?'eventId' and event_id is not null and not(p_input?'manualEvent') then manual:=null; end if;
 if event_id is not null and manual is not null then raise exception 'invalid_event_selection' using errcode='22023'; end if;
 if event_id is distinct from p.source_event_id then perform private.assert_post_event_selectable(event_id); end if;
 select * into ap from public.appointments where post_id=p.id and status='confirmed';
 if ap.id is not null then
  -- 확정 후의 기존 전체 수정은 유지한다. 명시적인 행사 제안만 별도로 허용한다.
  v_change_id:=private.parse_post_event_id(p_input->'eventChangeId');
  if v_change_id is null then raise exception 'post_conflict' using errcode='40001'; end if;
  ap:=private.lock_appointment_for_change(ap.id);
  perform pg_advisory_xact_lock(hashtextextended(v_change_id::text,323));
  selection:=jsonb_build_object('eventId',event_id,'manualEvent',manual);
  marker:=encode(sha256(convert_to(selection::text,'UTF8')),'hex');
  select * into c from private.appointment_schedule_changes where appointment_schedule_changes.change_id=v_change_id;
  if found then
   return private.post_event_change_result(p.id,p_input,p_expected_updated_at);
  end if;
  perform private.expire_appointment_schedule_changes(ap.id);
  t:=clock_timestamp();
  select jsonb_build_object('title',p.title,'description',p.description,'category',p.category,'startsAt',(p_input->>'startsAt')::timestamptz=p.starts_at,
   'endsAt',(p_input->>'endsAt')::timestamptz=p.ends_at,'recruitmentEndsAt',(p_input->>'recruitmentEndsAt')::timestamptz=p.recruitment_ends_at,
   'publicArea',p.public_area,'registeredPlaceName',l.registered_place_name,'registeredAddress',l.registered_address,
   'meetingDetail',d.exact_location,'preferenceNote',p.preference_note,'tags',to_jsonb(p.tags),'costType',p.cost_type,'amount',p.amount)
   into current_input from private.post_search_locations l join public.post_private_details d on d.post_id=l.post_id where l.post_id=p.id;
  if ap.status<>'confirmed' or p.updated_at is distinct from p_expected_updated_at or p.starts_at<=t
   or exists(select 1 from public.appointment_disputes where appointment_id=ap.id and (status='open' or resolution='no_show'))
   or exists(select 1 from private.appointment_schedule_changes where appointment_id=ap.id and status='awaiting_response')
   or current_input is null or (current_input-array['startsAt','endsAt','recruitmentEndsAt']) <>
      (p_input-array['eventId','manualEvent','eventChangeId','startsAt','endsAt','recruitmentEndsAt'])
   or current_input->'startsAt'<>'true'::jsonb or current_input->'endsAt'<>'true'::jsonb or current_input->'recruitmentEndsAt'<>'true'::jsonb then
   raise exception 'schedule_change_conflict' using errcode='40001'; end if;
  if selection=jsonb_build_object('eventId',p.source_event_id,'manualEvent',(select current_event from private.post_manual_events where post_id=p.id)) then
   raise exception 'invalid_event_selection' using errcode='22023'; end if;
  insert into private.appointment_schedule_changes(change_id,appointment_id,requested_by,old_starts_at,old_ends_at,old_updated_at,new_starts_at,new_ends_at,
   requested_at,expires_at,event_changed,new_event_input,event_fingerprint,event_request_fingerprint)
   values(v_change_id,ap.id,u,p.starts_at,p.ends_at,p.updated_at,p.starts_at,p.ends_at,t,least(t+interval '6 hours',p.starts_at),true,selection,marker,encode(sha256(convert_to(p_input::text,'UTF8')),'hex'));
  select join_request_id into req from public.appointments where id=ap.id;
  perform private.notify_match_lifecycle(req,'appointment_schedule_change_requested',(select condition_version from private.appointment_schedule_changes where appointment_schedule_changes.change_id=v_change_id),
   jsonb_build_object('status','awaiting_response','changeId',v_change_id,'changeKind','event'));
  return jsonb_build_object('postId',p.id,'status','event_change_pending','updatedAt',p.updated_at);
 end if;
 if p_input?'eventChangeId' then raise exception 'invalid_input' using errcode='22023'; end if;
 old_version:=private.match_condition_version(p.id);
 result:=private.update_post_before_manual_events(p.id,(p_input-array['manualEvent','eventChangeId'])||jsonb_build_object('eventId',event_id),p_expected_updated_at);
 delegated_version:=private.match_condition_version(p.id);
 insert into private.post_manual_events(post_id,current_event) values(p.id,manual)
  on conflict(post_id) do update set current_event=excluded.current_event;
 if old_version=delegated_version and old_version is distinct from private.match_condition_version(p.id) then
  marker:=gen_random_uuid()::text;
  for req in select id from public.join_requests where post_id=p.id and status='pending' order by id loop
   perform private.end_match_consent(req,'invalidated');
   perform private.notify_match_lifecycle(req,'post_conditions_changed',marker,jsonb_build_object('status','conditions_changed'));
  end loop;
 end if;
 return result;
end; $$;

-- 기존 수락은 행사 내용을 확인하지 않은 클라이언트이므로 행사 제안을 적용할 수 없다.
alter function public.accept_appointment_schedule_change(uuid,uuid,text) set schema private;
alter function private.accept_appointment_schedule_change(uuid,uuid,text) rename to accept_change_before_manual_event;
create function public.accept_appointment_schedule_change(p_appointment_id uuid,p_change_id uuid,p_condition_version text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
begin
 perform private.require_service_profile();
 if exists(select 1 from private.appointment_schedule_changes where change_id=p_change_id and event_changed) then
  raise exception 'event_change_explicit_accept_required' using errcode='40001'; end if;
 return private.accept_change_before_manual_event(p_appointment_id,p_change_id,p_condition_version);
end; $$;
create function public.accept_appointment_event_change(p_appointment_id uuid,p_change_id uuid,p_condition_version text,p_event_fingerprint text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare c private.appointment_schedule_changes; ap public.appointments; result jsonb; event_id uuid; manual jsonb;
begin
 perform private.require_service_profile();
 if private.appointment_role(p_appointment_id) is null then raise exception 'appointment_unavailable' using errcode='PT404'; end if;
 ap:=private.lock_appointment_for_change(p_appointment_id);
 select * into c from private.appointment_schedule_changes where change_id=p_change_id and appointment_id=ap.id;
 if c.change_id is null or not c.event_changed or p_event_fingerprint is null or c.event_fingerprint<>p_event_fingerprint then
  raise exception 'schedule_change_conflict' using errcode='40001'; end if;
 -- 수락된 재시도는 기존 member/상대·conditionVersion 검증을 통해서만 반환한다.
 if c.status='accepted' then return private.accept_change_before_manual_event(p_appointment_id,p_change_id,p_condition_version); end if;
 event_id:=private.parse_post_event_id(c.new_event_input->'eventId');
 manual:=private.normalize_post_manual_event(c.new_event_input->'manualEvent');
 perform private.assert_post_event_selectable(event_id);
 result:=private.accept_change_before_manual_event(p_appointment_id,p_change_id,p_condition_version);
 update public.posts set source_event_id=event_id where id=ap.post_id;
 update private.appointment_schedule_changes set event_applied_updated_at=(select updated_at from public.posts where id=ap.post_id) where change_id=c.change_id;
 insert into private.post_manual_events(post_id,current_event) values(ap.post_id,manual)
  on conflict(post_id) do update set current_event=excluded.current_event;
 return result;
end; $$;

do $$declare sig oid:='private.apply_content_inspection(text,uuid,jsonb)'::regprocedure; body text;
 anchor text:='if t.consumed_at is not null then'; replacement text;
begin
 body:=pg_get_functiondef(sig);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'event_content_retry_source_changed' using errcode='55000'; end if;
 replacement:=anchor||$retry$
  if p_action='post_update' and p_input->'p_input'?'eventChangeId' then
   return private.post_event_change_result((p_input->>'p_post_id')::uuid,p_input->'p_input',(p_input->>'p_expected_updated_at')::timestamptz);
  end if;$retry$;
 execute replace(body,anchor,replacement);
end $$;

-- 기존 공고 상세의 exact DTO는 보존하고 새 명시 조회만 확장한다.
create function public.get_service_post_event_link(p_post_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; manual jsonb;
begin
 -- 기존 상세의 탈퇴·숨김·공개 권한을 그대로 확인한다. 비공개 상세는 새 DTO에 복사하지 않는다.
 result:=public.get_service_post(p_post_id);
 select current_event into manual from private.post_manual_events where post_id=p_post_id;
 return jsonb_build_object('postId',p_post_id,'eventId',result->'eventId','manualEvent',manual,
  'linkedEvent',result->'linkedEvent','eventLinkState',case when result->>'eventId' is null then
   case when manual is null then 'none' else 'manual' end when result->'linkedEvent'='null'::jsonb then 'hidden' else 'linked' end);
end; $$;
alter function private.project_post_linked_event(uuid) rename to linked_event_before_manual_event;
create function private.project_post_linked_event(p_event_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select case when private.post_event_source_hidden(p_event_id) then null else private.linked_event_before_manual_event(p_event_id) end;
$$;
alter function private.assert_post_event_selectable(uuid) rename to selectable_event_before_manual_event;
create function private.assert_post_event_selectable(p_event_id uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
begin
 perform private.selectable_event_before_manual_event(p_event_id);
 if p_event_id is not null and private.post_event_source_hidden(p_event_id) then
  raise exception 'event_unavailable' using errcode='22023'; end if;
end; $$;
-- 현재 검색 구현의 검색 필드만 확장하고 익명/연령/페이지/권한 게이트는 보존한다.
do $$declare f oid:='private.search_public_posts_v2_before_member_retirement(text,text,jsonb,jsonb,integer)'::regprocedure;
 body text; anchor text:='or strpos(private.search_v2_text(linked_event.title),v_query)>0)'; replacement text;
begin
 body:=pg_get_functiondef(f);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'manual_event_search_source_changed' using errcode='55000'; end if;
 replacement:='or (not private.post_event_source_hidden(p.source_event_id) and strpos(private.search_v2_text(linked_event.title),v_query)>0)
        or strpos(private.search_v2_text((select current_event->>''title'' from private.post_manual_events where post_id=p.id)),v_query)>0)';
 execute replace(body,anchor,replacement);
end $$;
-- 목록·AI 후보·필터 집계도 같은 비표출 판정을 적용한다.
do $$declare sig text; body text; anchor text; replacement text; expected integer; actual integer;
begin
 foreach sig in array array['public.list_public_events(jsonb,jsonb,integer)',
  'public.list_event_candidates_v1(text,text)','public.list_event_filter_values()'] loop
  body:=pg_get_functiondef(sig::regprocedure);
  if sig='public.list_public_events(jsonb,jsonb,integer)' then
   anchor:='not private.member_content_hidden(''event'',e.id)'; replacement:='not private.post_event_source_hidden(e.id)'; expected:=1;
  elsif sig='public.list_event_candidates_v1(text,text)' then
   anchor:='where e.record->>''sourceStatus''=''active'''; replacement:=anchor||' and not private.post_event_source_hidden(e.id)'; expected:=1;
  else
   anchor:='where source_status = ''active'''; replacement:=anchor||' and not private.post_event_source_hidden(id)'; expected:=2;
  end if;
  actual:=(length(body)-length(replace(body,anchor,'')))/length(anchor);
  if actual<>expected then raise exception 'event_visibility_source_changed' using errcode='55000'; end if;
  execute replace(body,anchor,replacement);
 end loop;
end $$;
revoke all on function private.post_event_change_result(uuid,jsonb,timestamptz),private.post_event_source_hidden(uuid),private.normalize_post_manual_event(jsonb),private.create_service_post_before_content_inspection(uuid,jsonb),
 private.create_post_before_manual_events(uuid,jsonb),private.match_conditions(uuid),private.match_conditions_before_manual_event(uuid),
 private.appointment_schedule_change_json(uuid),private.change_json_before_manual_event(uuid),private.end_appointment_schedule_change(uuid,text),
 private.end_change_before_manual_event(uuid,text),private.clear_finished_event_change(),private.update_service_post_before_content_inspection(uuid,jsonb,timestamptz),
 private.update_post_before_manual_events(uuid,jsonb,timestamptz),private.accept_change_before_manual_event(uuid,uuid,text),
 private.project_post_linked_event(uuid),private.linked_event_before_manual_event(uuid),
 private.assert_post_event_selectable(uuid),private.selectable_event_before_manual_event(uuid) from public,anon,authenticated,service_role;
revoke all on function public.accept_appointment_schedule_change(uuid,uuid,text),public.accept_appointment_event_change(uuid,uuid,text,text),public.get_service_post_event_link(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.accept_appointment_schedule_change(uuid,uuid,text),public.accept_appointment_event_change(uuid,uuid,text,text) to authenticated;
grant execute on function public.get_service_post_event_link(uuid) to authenticated,anon;
commit;
