-- 민규: 배정된 운영자의 명시적 최종 종결. 읽기/안내 준비는 종결 시계를 만들지 않는다.
begin;
create table private.assigned_report_final_closures(
 actor_id uuid not null references auth.users(id),client_request_id uuid not null,
 report_id uuid not null unique references private.member_reports(id)on delete cascade,
 fingerprint text not null check(fingerprint~'^[a-f0-9]{64}$'),result jsonb not null,
 primary key(actor_id,client_request_id));
alter table private.assigned_report_final_closures enable row level security;
revoke all on private.assigned_report_final_closures from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
create function public.final_close_assigned_member_report(p_report_id uuid,p_client_request_id uuid,p_expected_report_version bigint,p_expected_incident_revision bigint,p_resolution_summary text)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare actor uuid;r private.member_reports;receipt private.assigned_report_final_closures;d private.assigned_report_decisions;
 fingerprint text;current_revision bigint;closed timestamptz;result jsonb;begin
 if p_report_id is null or p_client_request_id is null or p_expected_report_version is null or p_expected_report_version not between 1 and 9007199254740990
 or p_expected_incident_revision is null or p_expected_incident_revision not between 0 and 9007199254740990
 or p_resolution_summary is null or length(p_resolution_summary)not between 1 and 4000 or p_resolution_summary<>btrim(p_resolution_summary)or p_resolution_summary~'[[:cntrl:]]'then
 raise exception 'invalid_report_closure'using errcode='22023';end if;
 actor:=private.require_assigned_report_operator(p_report_id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_report_id,p_expected_report_version,p_expected_incident_revision,p_resolution_summary)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_client_request_id::text,160000));
 select *into receipt from private.assigned_report_final_closures where actor_id=actor and client_request_id=p_client_request_id;
 select *into r from private.member_reports where id=p_report_id for update nowait;
 if not found or(r.retention_due_at is not null and r.retention_due_at<=clock_timestamp())then raise exception 'report_unavailable'using errcode='PT404';end if;
 if receipt.report_id is not null then
  if receipt.fingerprint<>fingerprint then raise exception 'request_conflict'using errcode='40001';end if;
  perform private.require_assigned_report_operator(p_report_id);
  if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
  return receipt.result||jsonb_build_object('alreadyApplied',true);
 end if;
 if r.review_version<>p_expected_report_version or r.final_closed_at is not null or r.status not in('reviewing','more_evidence')then raise exception 'state_conflict'using errcode='40001';end if;
 select *into d from private.assigned_report_decisions where report_id=r.id order by report_version desc limit 1;
 if not found then raise exception 'typed_decision_required'using errcode='55000';end if;
 if d.incident_id is null then current_revision:=0;
 else select i.current_revision into current_revision from private.safety_incidents i where i.id=d.incident_id for share nowait;end if;
 if current_revision is distinct from p_expected_incident_revision or d.incident_revision is distinct from current_revision then raise exception 'state_conflict'using errcode='40001';end if;
 if exists(select 1 from private.appointment_review_holds where report_id=r.id and state='reviewing')or
 exists(select 1 from private.safety_appeals where report_id=r.id and state='reviewing')then raise exception 'report_review_pending'using errcode='55000';end if;
 -- 현재 제재에 대한 성공 제공 기한 또는 이미 행사한 이의권만 인정한다. first_read/available_at은 사용하지 않는다.
 if exists(select 1 from private.safety_sanction_applications a
  where a.incident_id=d.incident_id and a.decision_revision=current_revision and a.revoked_at is null
   and a.kind in('general_warning','general_7d','general_30d','permanent')
   and exists(select 1 from private.effective_safety_subjects(a.identity_id)e where e.incident_id=a.incident_id and e.decision_revision=a.decision_revision)
   and not exists(select 1 from private.safety_appeals ap join private.general_sanction_appeal_receipts gr on gr.appeal_id=ap.id join private.member_decision_notices n on n.id=gr.notice_id join private.assigned_report_decisions nd on nd.decision_id=n.decision_id where ap.report_id=r.id and ap.kind='general'and ap.sanction_id=a.id and ap.state in('accepted','rejected')and ap.resolved_at is not null and nd.decision_id=d.decision_id and nd.incident_revision=a.decision_revision)
   and not exists(select 1 from private.general_notice_deliveries nd where nd.sanction_id=a.id and nd.provided_at is not null and nd.deadline_at<=clock_timestamp() and exists(select 1 from private.member_decision_notices n where n.id=nd.notice_id and n.decision_id=d.decision_id)))then
  raise exception 'general_appeal_window_pending'using errcode='55000';end if;
 -- 취소 이의의 미완료 마감 검사는 별도 계약이 연결되기 전 종결하지 않는다.
 if d.appointment_id is not null and exists(select 1 from private.safety_appointment_results ar left join private.safety_appointment_result_revisions rv on rv.identity_id=ar.identity_id and rv.appointment_id=ar.appointment_id and rv.revision=ar.current_revision where ar.appointment_id=d.appointment_id and (rv.appeal_state='reviewing' or (rv.outcome='own_cancel' and rv.appeal_state='none')))then
  raise exception 'cancellation_finalization_pending'using errcode='55000';end if;
 perform private.require_assigned_report_operator(p_report_id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 closed:=clock_timestamp();
 update private.member_reports set status='resolved',final_closed_at=closed,retention_due_at=closed+interval '2160 hours',resolution_summary=p_resolution_summary,
 updated_at=closed where id=r.id returning *into r;
 result:=jsonb_build_object('reportId',r.id,'status',r.status,'version',r.review_version,'finalClosedAt',r.final_closed_at,'retentionDueAt',r.retention_due_at,'alreadyApplied',false);
 insert into private.assigned_report_final_closures values(actor,p_client_request_id,r.id,fingerprint,result);
 return result;
exception when lock_not_available or unique_violation then raise exception 'state_conflict'using errcode='40001';end;$$;
do $$declare own text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='private.require_assigned_report_operator(uuid)'::regprocedure;
 if own in('anon','authenticated','service_role','authenticator')then raise exception 'closure_owner_incompatible'using errcode='55000';end if;
 execute format('alter table private.assigned_report_final_closures owner to %I',own);
 execute format('alter function public.final_close_assigned_member_report(uuid,uuid,bigint,bigint,text)owner to %I',own);
end;$$;
revoke all on function public.final_close_assigned_member_report(uuid,uuid,bigint,bigint,text)from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
grant execute on function public.final_close_assigned_member_report(uuid,uuid,bigint,bigint,text)to authenticated;
commit;
