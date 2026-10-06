-- 민규: SQL91 일반 종결을 보존하고 정확히 해소된 취소 전용 신고를 연결한다.
begin;
create function private.assert_cancellation_report_finalizable(p_report uuid,p_identity uuid,p_expected_revision bigint)
returns void language plpgsql volatile security definer set search_path=''as $$
declare r private.member_reports;c private.appointment_cancel_resolutions;a private.safety_appeals;
 h private.safety_appointment_results;v private.safety_appointment_result_revisions;ep private.member_episodes;
 anchor_revision bigint;plan jsonb;begin
 select *into strict r from private.member_reports where id=p_report;
 select *into c from private.appointment_cancel_resolutions where report_id=p_report order by(result_snapshot->>'reportVersion')::bigint desc limit 1;
 if not found then raise exception 'typed_decision_required'using errcode='55000';end if;
 select *into a from private.safety_appeals where id=c.appeal_id for share nowait;
 select *into h from private.safety_appointment_results where identity_id=p_identity and appointment_id=a.appointment_id for share nowait;
 select *into v from private.safety_appointment_result_revisions where identity_id=h.identity_id and appointment_id=h.appointment_id and revision=h.current_revision;
 select *into ep from private.member_episodes where id=a.source_episode_id;
 if p_identity is null or a.identity_id is distinct from p_identity or a.report_id is distinct from r.id or a.kind is distinct from 'cancellation'
 or r.target_type is distinct from 'appointment'or r.target_id is distinct from a.appointment_id
 or r.reporter_episode_id is distinct from a.source_episode_id or r.reporter_id is distinct from ep.profile_id
 or ep.identity_id is distinct from h.identity_id or h.source_episode_id is distinct from a.source_episode_id
 or h.ordering_provenance is distinct from 'agreed_snapshot' or h.current_revision is distinct from(c.result_snapshot->>'resultRevision')::bigint
 or v.decision_id is distinct from c.decision_id or a.state is distinct from c.outcome or a.resolved_at is null
 or(c.outcome='accepted'and(v.outcome is distinct from 'exempt'or v.appeal_state is distinct from 'none'))
 or(c.outcome='rejected'and(v.outcome is distinct from 'own_cancel'or v.appeal_state is distinct from 'resolved'))
 or not exists(select 1 from private.appointment_cancel_appeal_receipts ar where ar.appeal_id=a.id and ar.report_id=r.id and ar.source_episode_id=h.source_episode_id and ar.appointment_id=h.appointment_id)
 or private.assigned_report_incident(r.id)is not null then raise exception 'cancel_closure_relation_conflict'using errcode='40001';end if;
 select coalesce(max(i.current_revision),0)into anchor_revision from private.cancellation_chain_effects m join private.safety_incidents i on i.id=m.incident_id where m.identity_id=p_identity and m.anchor_appointment_id=h.appointment_id;
 if anchor_revision is distinct from p_expected_revision then raise exception 'state_conflict'using errcode='40001';end if;
 plan:=private.current_cancellation_sanction_plan(p_identity);
 if plan->>'status'is distinct from 'ready' or exists(select 1 from private.cancellation_safety_due where identity_id=p_identity and policy_pending_code is not null)then
 raise exception 'cancellation_finalization_pending'using errcode='55000';end if;
end;$$;
-- Exact anchors prevent silently rewriting a different reviewed implementation.
do $$declare definition text;anchor text;replacement text;own text;begin
 select pg_get_functiondef('public.final_close_assigned_member_report(uuid,uuid,bigint,bigint,text)'::regprocedure),pg_get_userbyid(proowner)into strict definition,own from pg_proc where oid='public.final_close_assigned_member_report(uuid,uuid,bigint,bigint,text)'::regprocedure;
 anchor:='fingerprint text;current_revision bigint;closed timestamptz;result jsonb;begin';
 if(length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'closure_patch_anchor_unavailable';end if;
 definition:=replace(definition,anchor,'fingerprint text;current_revision bigint;closed timestamptz;result jsonb;cancel_identity uuid;begin');
 anchor:=' select *into r from private.member_reports where id=p_report_id for update nowait;';
 replacement:=' if not exists(select 1 from private.assigned_report_decisions where report_id=p_report_id)then
  select a.identity_id into cancel_identity from private.appointment_cancel_resolutions cr join private.safety_appeals a on a.id=cr.appeal_id where cr.report_id=p_report_id order by(cr.result_snapshot->>''reportVersion'')::bigint desc limit 1;
  if cancel_identity is not null then perform private.lock_cancellation_identity(cancel_identity);end if;
 end if;
 select *into r from private.member_reports where id=p_report_id for update nowait;';
 if(length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'closure_patch_anchor_unavailable';end if;
 definition:=replace(definition,anchor,replacement);
 anchor:=' if not found then raise exception ''typed_decision_required''using errcode=''55000'';end if;
 if d.incident_id is null then current_revision:=0;
 else select i.current_revision into current_revision from private.safety_incidents i where i.id=d.incident_id for share nowait;end if;
 if current_revision is distinct from p_expected_incident_revision or d.incident_revision is distinct from current_revision then raise exception ''state_conflict''using errcode=''40001'';end if;';
 replacement:=' if not found then
  perform private.assert_cancellation_report_finalizable(r.id,cancel_identity,p_expected_incident_revision);
  current_revision:=p_expected_incident_revision;
 else
  if d.incident_id is null then current_revision:=0;
  else select i.current_revision into current_revision from private.safety_incidents i where i.id=d.incident_id for share nowait;end if;
  if current_revision is distinct from p_expected_incident_revision or d.incident_revision is distinct from current_revision then raise exception ''state_conflict''using errcode=''40001'';end if;
 end if;';
 if(length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'closure_patch_anchor_unavailable';end if;
 execute replace(definition,anchor,replacement);
 execute format('alter function private.assert_cancellation_report_finalizable(uuid,uuid,bigint)owner to %I',own);
end;$$;
revoke all on function private.assert_cancellation_report_finalizable(uuid,uuid,bigint)from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
commit;
