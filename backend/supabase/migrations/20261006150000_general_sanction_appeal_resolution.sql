-- 민규: 배정된 운영자의 일반 이의 명시 심사. 제재 결과를 자동 추정하지 않는다.
begin;
create table private.general_sanction_appeal_resolutions(
 actor_id uuid not null references auth.users(id),client_request_id uuid not null,
 report_id uuid not null references private.member_reports(id)on delete cascade,
 appeal_id uuid not null unique references private.safety_appeals(id)on delete cascade,
 fingerprint text not null check(fingerprint~'^[a-f0-9]{64}$'),result jsonb not null check(jsonb_typeof(result)='object'),
 primary key(actor_id,client_request_id));
alter table private.general_sanction_appeal_resolutions enable row level security;
revoke all on private.general_sanction_appeal_resolutions from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
create function public.resolve_assigned_general_sanction_appeal(
 p_report_id uuid,p_appeal_id uuid,p_client_request_id uuid,p_expected_report_version bigint,p_expected_hold_version bigint,p_expected_incident_revision bigint,
 p_outcome text,p_appointment_outcome text,p_incident_outcome text,p_responsible_role text,p_representative_reason_code text,p_violation_class text,p_violation_type text)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare actor uuid;receipt private.general_sanction_appeal_resolutions;appeal private.safety_appeals;report private.member_reports;
 fingerprint text;state jsonb;decision jsonb;result jsonb;begin
 if p_report_id is null or p_appeal_id is null or p_client_request_id is null or p_expected_report_version is null or p_expected_report_version not between 1 and 9007199254740990
 or p_expected_incident_revision is null or p_expected_incident_revision not between 1 and 9007199254740990 or p_outcome is null or p_outcome not in('accepted','rejected')then
  raise exception 'invalid_general_resolution'using errcode='22023';end if;
 actor:=private.require_assigned_report_operator(p_report_id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_report_id,p_appeal_id,p_expected_report_version,p_expected_hold_version,p_expected_incident_revision,p_outcome,p_appointment_outcome,p_incident_outcome,p_responsible_role,p_representative_reason_code,p_violation_class,p_violation_type)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_client_request_id::text,150000));
 select *into receipt from private.general_sanction_appeal_resolutions where actor_id=actor and client_request_id=p_client_request_id;
 if found then
  if receipt.fingerprint<>fingerprint then raise exception 'request_conflict'using errcode='40001';end if;
  perform 1 from private.member_reports where id=p_report_id and(retention_due_at is null or retention_due_at>clock_timestamp())for share nowait;
  if not found then raise exception 'report_unavailable'using errcode='PT404';end if;
  perform private.require_assigned_report_operator(p_report_id);
  if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
  return receipt.result||jsonb_build_object('alreadyApplied',true);
 end if;
 select *into appeal from private.safety_appeals where id=p_appeal_id and kind='general'and report_id=p_report_id;
 if not found or appeal.state<>'reviewing'or not exists(select 1 from private.general_sanction_appeal_receipts where appeal_id=appeal.id and report_id=p_report_id and episode_id=appeal.source_episode_id)then
  raise exception 'appeal_unavailable'using errcode='PT404';end if;
 if not exists(select 1 from private.general_sanction_appeal_receipts g join private.member_decision_notices n on n.id=g.notice_id
  join private.assigned_report_decisions d on d.decision_id=n.decision_id join private.safety_sanction_applications a on a.id=appeal.sanction_id
  where g.appeal_id=appeal.id and d.report_id=p_report_id and d.incident_id=a.incident_id and d.incident_revision=p_expected_incident_revision
  and a.decision_revision=d.incident_revision and a.revoked_at is null and a.identity_id=appeal.identity_id and a.source_episode_id=appeal.source_episode_id)then
  raise exception 'state_conflict'using errcode='40001';end if;
 select jsonb_build_object('version',r.review_version,'holdVersion',(select h.version from private.appointment_review_holds h where h.report_id=r.id and h.appointment_id=r.target_id),'incidentRevision',(select i.current_revision from private.safety_incidents i where i.id=private.assigned_report_incident(r.id)))into state from private.member_reports r where r.id=p_report_id;
 if(state->>'version')::bigint<>p_expected_report_version or(state->>'incidentRevision')::bigint<>p_expected_incident_revision
 or(state->>'holdVersion')::bigint is distinct from p_expected_hold_version then raise exception 'state_conflict'using errcode='40001';end if;
 -- 인용 심사는 원 판정 입력 계약을 명시해서 전달한다.
 if p_outcome='accepted'then
  if p_incident_outcome is null or p_incident_outcome not in('confirmed','invalidated')then raise exception 'invalid_general_resolution'using errcode='22023';end if;
  -- 기존 판정의 incident/account/profile/episode/identity/appointment/report 잠금 순서를 먼저 따른다.
  decision:=public.adjudicate_assigned_member_report(p_report_id,p_client_request_id,'correction',p_expected_report_version,p_expected_hold_version,p_expected_incident_revision,
   p_appointment_outcome,p_incident_outcome,p_responsible_role,p_representative_reason_code,p_violation_class,p_violation_type);
 else
  if p_appointment_outcome is not null or p_incident_outcome is not null or p_responsible_role is not null or p_representative_reason_code is not null or p_violation_class is not null or p_violation_type is not null then
   raise exception 'invalid_general_resolution'using errcode='22023';end if;
 end if;
 select *into report from private.member_reports where id=p_report_id for update nowait;
 if report.id is null or report.status not in('reviewing','more_evidence')or report.retention_due_at<=clock_timestamp()or report.final_closed_at is not null or report.review_version<>p_expected_report_version+(case when p_outcome='accepted'then 1 else 0 end) then
  raise exception 'state_conflict'using errcode='40001';end if;
 select *into appeal from private.safety_appeals where id=p_appeal_id and kind='general'and report_id=p_report_id for update nowait;
 if not found or appeal.state<>'reviewing'then raise exception 'state_conflict'using errcode='40001';end if;
 if p_outcome='rejected'then
  state:=public.get_assigned_report_adjudication_state(p_report_id);
  if(state->>'incidentRevision')::bigint<>p_expected_incident_revision then raise exception 'state_conflict'using errcode='40001';end if;
  update private.member_reports set review_version=review_version+1,updated_at=clock_timestamp()where id=p_report_id returning *into report;
 end if;
 update private.safety_appeals set state=p_outcome,resolved_at=clock_timestamp()where id=p_appeal_id;
 perform private.require_assigned_report_operator(p_report_id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 result:=jsonb_build_object('reportId',p_report_id,'appealId',p_appeal_id,'appealState',p_outcome,'reportVersion',report.review_version,'decisionId',decision->'decisionId','alreadyApplied',false);
 insert into private.general_sanction_appeal_resolutions values(actor,p_client_request_id,p_report_id,p_appeal_id,fingerprint,result);
 return result;
exception when lock_not_available or unique_violation then raise exception 'state_conflict'using errcode='40001';end;$$;
do $$declare own text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='private.require_assigned_report_operator(uuid)'::regprocedure;
 execute format('alter table private.general_sanction_appeal_resolutions owner to %I',own);
 execute format('alter function public.resolve_assigned_general_sanction_appeal(uuid,uuid,uuid,bigint,bigint,bigint,text,text,text,text,text,text,text)owner to %I',own);
end;$$;
revoke all on function public.resolve_assigned_general_sanction_appeal(uuid,uuid,uuid,bigint,bigint,bigint,text,text,text,text,text,text,text)from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
grant execute on function public.resolve_assigned_general_sanction_appeal(uuid,uuid,uuid,bigint,bigint,bigint,text,text,text,text,text,text,text)to authenticated;
commit;
