-- 민규 C: 배정된 사람이 명시한 판정·원 사건 정정의 원자 연결 후보.
-- 통지/이의/최종 종결 시각은 만들지 않는다. SQL70~73와 기존 owner helper는 불변.
begin;
do $$declare own oid;name text;f regprocedure;t regclass;g text;begin
 select proowner,pg_get_userbyid(proowner)into strict own,name from pg_proc where oid='private.require_assigned_report_operator(uuid)'::regprocedure;
 if name in('anon','authenticated','service_role','authenticator')then raise exception 'adjudication_owner_incompatible'using errcode='55000';end if;
 foreach g in array array['anon','authenticated','service_role','authenticator']loop
  if pg_has_role(g,name,'USAGE')or pg_has_role(g,name,'SET')then raise exception 'adjudication_owner_incompatible'using errcode='55000';end if;
 end loop;
 if not has_schema_privilege(name,'private','USAGE')or not has_schema_privilege(name,'auth','USAGE')then raise exception 'adjudication_owner_incompatible'using errcode='55000';end if;
 foreach f in array array['auth.uid()'::regprocedure,'auth.jwt()'::regprocedure,'auth.role()'::regprocedure,'private.require_assigned_report_operator(uuid)'::regprocedure,'private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)'::regprocedure,'private.resolve_appointment_review(uuid,uuid,bigint,uuid,text)'::regprocedure,'private.profile_retired(uuid)'::regprocedure,'private.general_sanction_epoch_end(timestamptz)'::regprocedure]loop
  if not has_function_privilege(name,f,'EXECUTE')then raise exception 'adjudication_owner_incompatible'using errcode='55000';end if;
 end loop;
 foreach t in array array['private.member_reports'::regclass,'public.appointments'::regclass,'private.naver_accounts'::regclass,'public.profiles'::regclass,'private.member_episodes'::regclass,'private.naver_identity_keys'::regclass,'private.safety_incidents'::regclass,'private.safety_incident_report_links'::regclass]loop
  if not has_table_privilege(name,t,'SELECT')or not has_table_privilege(name,t,'UPDATE')or
    (select relrowsecurity and not((relowner=own and not relforcerowsecurity)or(select rolsuper or rolbypassrls from pg_roles where oid=own))from pg_class where oid=t)then raise exception 'adjudication_owner_incompatible'using errcode='55000';end if;
 end loop;
 foreach t in array array['public.posts'::regclass,'public.join_requests'::regclass,'public.chat_messages'::regclass,'private.appointment_member_episodes'::regclass,'private.appointment_review_holds'::regclass,'private.safety_incident_subjects'::regclass,'private.safety_incident_revisions'::regclass,'private.safety_sanction_applications'::regclass]loop
  if not has_table_privilege(name,t,'SELECT')or(select relrowsecurity and not((relowner=own and not relforcerowsecurity)or(select rolsuper or rolbypassrls from pg_roles where oid=own))from pg_class where oid=t)then raise exception 'adjudication_owner_incompatible'using errcode='55000';end if;
 end loop;
 if not has_table_privilege(name,'private.report_access_audit','INSERT')or not has_sequence_privilege(name,'private.report_access_audit_id_seq','USAGE')then raise exception 'adjudication_owner_incompatible'using errcode='55000';end if;
 if not has_table_privilege(name,'private.safety_incident_report_links','INSERT')then raise exception 'adjudication_owner_incompatible'using errcode='55000';end if;
end;$$;
create table private.assigned_report_adjudications(
 actor_id uuid not null,client_request_id uuid not null,report_id uuid not null references private.member_reports(id)on delete cascade,
 decision_id uuid not null unique,input_sha256 text not null check(input_sha256~'^[a-f0-9]{64}$'),
 result_version bigint not null check(result_version between 2 and 9007199254740991),
 incident_id uuid references private.safety_incidents(id),incident_revision bigint not null check(incident_revision between 0 and 9007199254740991),
 happened_at timestamptz not null default clock_timestamp(),primary key(actor_id,client_request_id)
);
alter table private.assigned_report_adjudications enable row level security;
revoke all on private.assigned_report_adjudications from public,anon,authenticated,service_role;

-- 원문 대신 고정 party UUID/회차 metadata만 다루는 owner helper.
create function private.assigned_report_party_metadata(p_report private.member_reports)
returns jsonb language plpgsql stable security definer set search_path=''as $$
declare target uuid;ae uuid;ce uuid;author uuid;companion uuid;result jsonb;member_episode_row private.member_episodes;begin
 if p_report.target_type='appointment'then
  select p.author_id,j.requester_id,m.author_episode_id,m.requester_episode_id into author,companion,ae,ce
   from public.appointments a join public.posts p on p.id=a.post_id join public.join_requests j on j.id=a.join_request_id
   join private.appointment_member_episodes m on m.appointment_id=a.id where a.id=p_report.target_id;
  if not found then raise exception 'fixed_report_parties_unavailable'using errcode='55000';end if;
  select jsonb_agg(jsonb_build_object('role',x.role,'profileId',x.uid,'episodeId',e.id,'identityId',e.identity_id)order by x.role)into result
   from(values('author',author,ae),('companion',companion,ce))x(role,uid,episode)
   join private.member_episodes e on e.id=x.episode and e.profile_id=x.uid;
  if result is null or jsonb_array_length(result)<>2 or exists(select 1 from jsonb_array_elements(result)x where x->>'identityId'is null)then raise exception 'fixed_report_parties_unavailable'using errcode='55000';end if;
  return result;
 elsif p_report.target_type='member'then target:=p_report.target_id;
 elsif p_report.target_type='post'then select author_id into target from public.posts where id=p_report.target_id;
 elsif p_report.target_type='chat'then
  -- sender_id만 조회한다. 직원 chat body 읽기 API/ACL을 추가하지 않는다.
  select sender_id into target from public.chat_messages where id=p_report.target_id;
 elsif p_report.target_type='event'then return '[]'::jsonb;
 else raise exception 'report_target_mapping_unresolved'using errcode='55000';end if;
 if target is null or(select count(*)from private.member_episodes where profile_id=target)<>1 then raise exception 'fixed_report_parties_unavailable'using errcode='55000';end if;
 select *into strict member_episode_row from private.member_episodes where profile_id=target;
 if member_episode_row.identity_id is null then raise exception 'fixed_report_parties_unavailable'using errcode='55000';end if;
 return jsonb_build_array(jsonb_build_object('role','target','profileId',target,'episodeId',member_episode_row.id,'identityId',member_episode_row.identity_id));
end;$$;
create function private.assigned_report_incident(p_report_id uuid)
returns uuid language plpgsql stable security definer set search_path=''as $$
declare ids uuid[];begin
 select array_agg(incident_id order by incident_id)into ids from private.safety_incident_report_links where report_id=p_report_id;
 if coalesce(cardinality(ids),0)>1 then raise exception 'linked_incidents_ambiguous'using errcode='55000';end if;
 if cardinality(ids)=1 and exists(select 1 from private.safety_incident_report_links where incident_id=ids[1]and report_id<>p_report_id)then
  raise exception 'linked_reports_ambiguous'using errcode='55000';end if;
 return ids[1];
end;$$;

create function public.get_assigned_report_adjudication_state(p_report_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare actor uuid;r private.member_reports;h private.appointment_review_holds;i uuid;rev bigint:=0;begin
 if p_report_id is null then raise exception 'invalid_input'using errcode='22023';end if;
 actor:=private.require_assigned_report_operator(p_report_id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 select *into r from private.member_reports where id=p_report_id for share;
 if not found or r.retention_due_at<=clock_timestamp()then raise exception 'report_unavailable'using errcode='PT404';end if;
 i:=private.assigned_report_incident(r.id);
 if i is not null then select current_revision into rev from private.safety_incidents where id=i;end if;
 if r.target_type='appointment'then select *into h from private.appointment_review_holds where report_id=r.id and appointment_id=r.target_id;end if;
 if r.review_version not between 1 and 9007199254740991 or rev not between 0 and 9007199254740991 or(h.hold_id is not null and h.version not between 1 and 9007199254740991)then raise exception 'adjudication_state_invalid'using errcode='55000';end if;
 perform private.require_assigned_report_operator(r.id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 if r.retention_due_at<=clock_timestamp()then raise exception 'report_unavailable'using errcode='PT404';end if;
 insert into private.report_access_audit(actor_id,report_id,action)values(actor,r.id,'report_read');
 return jsonb_build_object('reportId',r.id,'status',r.status,'version',r.review_version,'holdVersion',h.version,'incidentRevision',rev);
end;$$;

create function public.adjudicate_assigned_member_report(p_report_id uuid,p_client_request_id uuid,p_mode text,
 p_expected_report_version bigint,p_expected_hold_version bigint,p_expected_incident_revision bigint,
 p_appointment_outcome text,p_incident_outcome text,p_responsible_role text,p_representative_reason_code text,p_violation_class text,p_violation_type text)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare actor uuid;snapshot private.member_reports;r private.member_reports;h private.appointment_review_holds;
 prior private.assigned_report_adjudications;parties jsonb;again jsonb;selected jsonb;subjects jsonb:='[]';
 incident uuid;previous_incident uuid;decision uuid:=gen_random_uuid();rev bigint:=0;ids uuid[];episodes uuid[];
 victim uuid;hash text;kinds text[];selected_subject jsonb;is_previous boolean;new_version bigint;begin
 if p_report_id is null or p_client_request_id is null or p_expected_report_version is null or p_expected_report_version not between 1 and 9007199254740990
  or p_expected_incident_revision is null or p_expected_incident_revision not between 0 and 9007199254740990
  or(p_expected_hold_version is not null and p_expected_hold_version not between 1 and 9007199254740990)
  or p_mode is null or p_mode not in('initial','correction')or p_appointment_outcome is null or p_appointment_outcome not in('normal','no_show','unchanged')
  or p_incident_outcome is null or p_incident_outcome not in('none','confirmed','invalidated')or p_responsible_role is null or p_responsible_role not in('none','author','companion','both','target')
  or p_violation_class is null or p_violation_class not in('none','minor','major')or p_representative_reason_code is null then raise exception 'invalid_input'using errcode='22023';end if;
 if p_incident_outcome in('none','invalidated')then
  if p_responsible_role<>'none'or p_violation_class<>'none'or p_violation_type is not null then raise exception 'invalid_input'using errcode='22023';end if;
  if p_incident_outcome='none'and p_representative_reason_code='no_action'and p_appointment_outcome='no_show'then raise exception 'invalid_input'using errcode='22023';end if;
  if(p_incident_outcome='none'and not(p_representative_reason_code='no_action' or(p_representative_reason_code='no_show'and p_appointment_outcome='no_show')))
    or(p_incident_outcome='invalidated'and(p_mode<>'correction'or p_representative_reason_code<>'decision_corrected'))then raise exception 'invalid_input'using errcode='22023';end if;
 else
  if p_responsible_role='none'then raise exception 'invalid_input'using errcode='22023';end if;
  if p_violation_class='none'then
   if p_violation_type is not null or p_appointment_outcome<>'no_show'or p_representative_reason_code<>'no_show'then raise exception 'invalid_input'using errcode='22023';end if;
  elsif p_violation_class='minor'then
   if p_violation_type is null or p_violation_type not in('spam','rule_violation')or p_representative_reason_code<>p_violation_type then raise exception 'invalid_input'using errcode='22023';end if;
  else
   if p_violation_type is null or p_violation_type not in('sexual_harassment','threat','violence','stalking','privacy_exposure','sexual_exploitation')or p_representative_reason_code<>p_violation_type then raise exception 'invalid_input'using errcode='22023';end if;
  end if;
 end if;
 actor:=private.require_assigned_report_operator(p_report_id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 hash:=encode(sha256(convert_to(jsonb_build_array(p_report_id,p_mode,p_expected_report_version,p_expected_hold_version,p_expected_incident_revision,p_appointment_outcome,p_incident_outcome,p_responsible_role,p_representative_reason_code,p_violation_class,p_violation_type)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_client_request_id::text,171606));
 select *into snapshot from private.member_reports where id=p_report_id;
 if not found or snapshot.retention_due_at<=clock_timestamp()then raise exception 'report_unavailable'using errcode='PT404';end if;
 select *into prior from private.assigned_report_adjudications where actor_id=actor and client_request_id=p_client_request_id;
 if found then
  if prior.report_id<>p_report_id or prior.input_sha256<>hash then raise exception 'adjudication_request_conflict'using errcode='40001';end if;
  perform 1 from private.member_reports where id=p_report_id and(retention_due_at is null or retention_due_at>clock_timestamp())for share;
  if not found then raise exception 'report_unavailable'using errcode='PT404';end if;
  perform private.require_assigned_report_operator(p_report_id);
  if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
  if exists(select 1 from private.member_reports where id=p_report_id and retention_due_at<=clock_timestamp())then raise exception 'report_unavailable'using errcode='PT404';end if;
  return jsonb_build_object('reportId',prior.report_id,'status','reviewing','version',prior.result_version,'decisionId',prior.decision_id,'alreadyApplied',true);
 end if;
 previous_incident:=private.assigned_report_incident(p_report_id);incident:=previous_incident;
 if incident is null and p_incident_outcome='confirmed'then incident:=gen_random_uuid();end if;
 if incident is not null then perform pg_advisory_xact_lock(hashtextextended(incident::text,21810));end if;
 parties:=private.assigned_report_party_metadata(snapshot);
 if snapshot.target_type='appointment'then
  if p_expected_hold_version is null or p_responsible_role='target'then raise exception 'invalid_input'using errcode='22023';end if;
 else
  if p_expected_hold_version is not null or p_appointment_outcome<>'unchanged'or p_responsible_role not in('none','target')then raise exception 'invalid_input'using errcode='22023';end if;
 end if;
 if snapshot.target_type='event'and p_incident_outcome<>'none'then raise exception 'event_operator_workflow_unresolved'using errcode='55000';end if;
 select coalesce(jsonb_agg(x order by x->>'identityId'),'[]')into selected from jsonb_array_elements(parties)x
  where p_responsible_role='both'or x->>'role'=p_responsible_role;
 if p_incident_outcome='confirmed'and jsonb_array_length(selected)=0 then raise exception 'responsible_party_unavailable'using errcode='55000';end if;
 select array_agg(distinct identity order by identity)into ids from(
  select(x->>'identityId')::uuid identity from jsonb_array_elements(parties)x
  union select identity_id from private.safety_incident_subjects where incident_id=incident)q;
 select array_agg(distinct episode order by episode)into episodes from(
  select(x->>'episodeId')::uuid episode from jsonb_array_elements(parties)x
  union select source_episode_id from private.safety_incident_subjects where incident_id=incident
  union select id from private.member_episodes where ended_at is null and identity_id=any(ids))q where episode is not null;
 -- 21811과 같은 incident→account→profile→episode→identity를 선점한다.
 perform 1 from private.naver_accounts a join private.naver_identity_keys k on k.subject=a.subject where k.id=any(ids)order by a.subject for update of a nowait;
 perform 1 from public.profiles where id in(select profile_id from private.member_episodes where id=any(episodes))order by id for update nowait;
 perform 1 from private.member_episodes where id=any(episodes)order by profile_id,id for update nowait;
 perform 1 from private.naver_identity_keys where id=any(ids)order by id for update;
 if snapshot.target_type='appointment'then perform 1 from public.appointments where id=snapshot.target_id for update nowait;end if;
 select *into r from private.member_reports where id=p_report_id for update nowait;
 if not found or r.retention_due_at<=clock_timestamp()then raise exception 'report_unavailable'using errcode='PT404';end if;
 again:=private.assigned_report_party_metadata(r);
 if r.target_type is distinct from snapshot.target_type or r.target_id is distinct from snapshot.target_id or again<>parties
   or private.assigned_report_incident(r.id)is distinct from previous_incident then raise exception 'adjudication_target_conflict'using errcode='40001';end if;
 if r.review_version<>p_expected_report_version or r.status not in('reviewing','more_evidence')or r.final_closed_at is not null then raise exception 'adjudication_state_conflict'using errcode='40001';end if;
 if previous_incident is not null then select current_revision into rev from private.safety_incidents where id=previous_incident for update;end if;
 if rev<>p_expected_incident_revision then raise exception 'adjudication_incident_conflict'using errcode='40001';end if;
 select exists(select 1 from private.assigned_report_adjudications where report_id=r.id)into is_previous;
 if(p_mode='initial'and(is_previous or rev>0))or(p_mode='correction'and not(is_previous or rev>0))then raise exception 'adjudication_mode_conflict'using errcode='40001';end if;
 if r.target_type='appointment'then
  select *into h from private.appointment_review_holds where report_id=r.id and appointment_id=r.target_id for update;
  if not found or h.version<>p_expected_hold_version then raise exception 'adjudication_hold_conflict'using errcode='40001';end if;
 end if;
 if p_incident_outcome='invalidated'and(previous_incident is null or rev=0)then raise exception 'adjudication_incident_conflict'using errcode='40001';end if;
 if p_incident_outcome='none'and previous_incident is not null then
  -- 원 사건 효과를 남긴 채 normal/no-action으로 표시하지 않는다.
  raise exception 'existing_incident_requires_explicit_correction'using errcode='55000';end if;
 if previous_incident is not null and exists(select 1 from private.safety_incident_subjects s where s.incident_id=incident and not exists(select 1 from jsonb_array_elements(parties)x where(x->>'identityId')::uuid=s.identity_id and(x->>'episodeId')::uuid=s.source_episode_id))then raise exception 'original_incident_party_unresolved'using errcode='55000';end if;
 if p_incident_outcome='confirmed'then
  if p_violation_class='minor'and exists(select 1 from jsonb_array_elements(selected)x join private.safety_incident_subjects s on s.identity_id=(x->>'identityId')::uuid
    join private.safety_incident_revisions sr on sr.incident_id=s.incident_id and sr.revision=s.revision
    join private.safety_incidents si on si.id=s.incident_id and si.current_revision=s.revision
    where s.incident_id<>incident and sr.state='confirmed'and s.violation_class='minor'and clock_timestamp()<private.general_sanction_epoch_end(sr.decided_at))then
   -- notified_at만으로 재발 시각을 증명하지 않는다. 기존 core의 7d/30d 추정을 실행하지 않는다.
   raise exception 'minor_recurrence_notice_evidence_unresolved'using errcode='55000';end if;
  for selected_subject in select value from jsonb_array_elements(selected)loop
   kinds:=array[]::text[];
   if p_appointment_outcome='no_show'then kinds:=array_append(kinds,'no_show');end if;
   if p_violation_class='major'then kinds:=array_append(kinds,'major_violation');end if;
   victim:=null;
   -- 책임 당사자 선택만으로 피해자를 확정하지 않는다. 목격 신고 가능성을 보존한다.
   subjects:=subjects||jsonb_build_array(jsonb_build_object('identityId',selected_subject->>'identityId','sourceEpisodeId',selected_subject->>'episodeId','confirmedKinds',to_jsonb(kinds),'violationClass',p_violation_class,'violationType',p_violation_type,'victimIdentityId',victim,'cancellationAction',null));
  end loop;
  rev:=private.record_incident_revision(incident,decision,rev,'confirmed',p_representative_reason_code,actor,subjects);
  if previous_incident is null then insert into private.safety_incident_report_links(incident_id,report_id)values(incident,r.id);end if;
 elsif p_incident_outcome='invalidated'then
  rev:=private.record_incident_revision(incident,decision,rev,'invalidated',p_representative_reason_code,actor,'[]'::jsonb);
 end if;
 if r.target_type='appointment'and p_appointment_outcome<>'unchanged'then
  perform private.resolve_appointment_review(h.hold_id,r.target_id,h.version,decision,p_appointment_outcome);
 end if;
 update private.member_reports set status='reviewing',review_version=r.review_version+1,updated_at=clock_timestamp()where id=r.id returning review_version into new_version;
 if new_version<>p_expected_report_version+1 then raise exception 'adjudication_version_invalid'using errcode='55000';end if;
 perform private.require_assigned_report_operator(r.id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 if exists(select 1 from private.member_reports where id=r.id and retention_due_at<=clock_timestamp())then raise exception 'report_unavailable'using errcode='PT404';end if;
 insert into private.assigned_report_adjudications(actor_id,client_request_id,report_id,decision_id,input_sha256,result_version,incident_id,incident_revision)
  values(actor,p_client_request_id,r.id,decision,hash,new_version,incident,rev);
 return jsonb_build_object('reportId',r.id,'status','reviewing','version',new_version,'decisionId',decision,'alreadyApplied',false);
exception when lock_not_available then raise exception 'adjudication_state_conflict'using errcode='40001';end;$$;

do $$declare name text;f regprocedure;begin
 select pg_get_userbyid(proowner)into strict name from pg_proc where oid='private.require_assigned_report_operator(uuid)'::regprocedure;
 execute format('alter table private.assigned_report_adjudications owner to %I',name);
 foreach f in array array['private.assigned_report_party_metadata(private.member_reports)'::regprocedure,'private.assigned_report_incident(uuid)'::regprocedure,
  'public.get_assigned_report_adjudication_state(uuid)'::regprocedure,'public.adjudicate_assigned_member_report(uuid,uuid,text,bigint,bigint,bigint,text,text,text,text,text,text)'::regprocedure]loop
  execute format('alter function %s owner to %I',f,name);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 end loop;
end;$$;
grant execute on function public.get_assigned_report_adjudication_state(uuid),public.adjudicate_assigned_member_report(uuid,uuid,text,bigint,bigint,bigint,text,text,text,text,text,text)to authenticated;
commit;
