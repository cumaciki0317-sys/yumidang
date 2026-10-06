-- 민규: 운영자의 명시적 동일 제재 연결. 회원/worker가 원 시작 시각을 선택하지 못한다.
begin;
create table private.cancellation_clock_lineage(
 destination_application_id uuid primary key references private.safety_sanction_applications(id)on delete cascade,
 predecessor_application_id uuid unique references private.safety_sanction_applications(id)on delete cascade,
 identity_id uuid not null references private.naver_identity_keys(id),destination_incident_id uuid not null references private.safety_incidents(id),
 destination_anchor_appointment_id uuid not null,source_episode_id uuid not null references private.member_episodes(id),
 kind text not null check(kind in('cancel_warning','cancel_restriction')),
 applied_at timestamptz not null,expires_at timestamptz,plan_sha256 text not null check(plan_sha256~'^[a-f0-9]{64}$'),
 check((kind='cancel_warning'and expires_at is null)or(kind='cancel_restriction'and expires_at=applied_at+interval'168 hours')));
create table private.cancellation_clock_repair_receipts(
 actor_id uuid not null references auth.users(id),client_request_id uuid not null,
 report_id uuid not null references private.member_reports(id)on delete cascade,
 fingerprint text not null check(fingerprint~'^[a-f0-9]{64}$'),result jsonb not null,primary key(actor_id,client_request_id));
alter table private.cancellation_clock_lineage enable row level security;
alter table private.cancellation_clock_repair_receipts enable row level security;
revoke all on private.cancellation_clock_lineage,private.cancellation_clock_repair_receipts from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
create function private.protect_retained_cancellation_clock_predecessor()
returns trigger language plpgsql security definer set search_path=''as $$begin
 if exists(select 1 from private.cancellation_clock_lineage l join private.safety_sanction_applications a on a.id=l.destination_application_id
 where l.predecessor_application_id=old.id and a.revoked_at is null and(a.expires_at is null or a.expires_at>clock_timestamp()))then
 raise exception 'cancellation_clock_lineage_retained'using errcode='55000';end if;
 return old;end;$$;
create trigger retained_cancellation_clock_predecessor before delete on private.safety_sanction_applications
 for each row execute function private.protect_retained_cancellation_clock_predecessor();
create function private.assigned_cancellation_clock_identity(p_report uuid)
returns uuid language plpgsql volatile security definer set search_path=''as $$
declare who uuid;identity uuid;r private.member_reports;c private.appointment_cancel_resolutions;a private.safety_appeals;begin
 who:=private.require_assigned_report_operator(p_report);
 if private.profile_retired(who)then raise exception 'operator_access_denied'using errcode='42501';end if;
 select ap.identity_id into identity from private.appointment_cancel_resolutions cr join private.safety_appeals ap on ap.id=cr.appeal_id
 where cr.report_id=p_report order by(cr.result_snapshot->>'reportVersion')::bigint desc limit 1;
 if identity is null then raise exception 'typed_decision_required'using errcode='55000';end if;
 perform private.lock_cancellation_identity(identity);
 select *into r from private.member_reports where id=p_report for update nowait;
 if not found or r.retention_due_at<=clock_timestamp()then raise exception 'report_unavailable'using errcode='PT404';end if;
 if r.final_closed_at is not null or r.status not in('reviewing','more_evidence')then raise exception 'state_conflict'using errcode='40001';end if;
 select *into c from private.appointment_cancel_resolutions where report_id=p_report order by(result_snapshot->>'reportVersion')::bigint desc limit 1;
 select *into a from private.safety_appeals where id=c.appeal_id;
 if a.identity_id is distinct from identity or a.report_id is distinct from r.id or a.state is distinct from c.outcome or a.resolved_at is null
 or a.kind is distinct from 'cancellation'or r.target_type is distinct from 'appointment'or r.target_id is distinct from a.appointment_id
 or r.reporter_episode_id is distinct from a.source_episode_id or private.assigned_report_incident(r.id)is not null
 or not exists(select 1 from private.member_episodes e where e.id=a.source_episode_id and e.identity_id=identity and e.profile_id=r.reporter_id)
 or not exists(select 1 from private.appointment_cancel_appeal_receipts ar where ar.appeal_id=a.id and ar.report_id=r.id and ar.source_episode_id=a.source_episode_id and ar.appointment_id=a.appointment_id)
 or not exists(select 1 from private.safety_appointment_results h join private.safety_appointment_result_revisions rv on rv.identity_id=h.identity_id and rv.appointment_id=h.appointment_id and rv.revision=h.current_revision
 where h.identity_id=identity and h.appointment_id=a.appointment_id and h.source_episode_id=a.source_episode_id and h.current_revision=(c.result_snapshot->>'resultRevision')::bigint and rv.decision_id=c.decision_id)
 or exists(select 1 from private.safety_appeals where report_id=r.id and state='reviewing')
 or exists(select 1 from private.appointment_review_holds where report_id=r.id and state='reviewing')then raise exception 'cancel_clock_relation_conflict'using errcode='40001';end if;
 return identity;end;$$;
create function private.cancellation_clock_state(p_report uuid,p_identity uuid)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare plan jsonb;facts jsonb;actions jsonb;begin
 plan:=private.current_cancellation_sanction_plan(p_identity);
 if plan->>'status'is distinct from 'ready'then raise exception 'cancellation_finalization_pending'using errcode='55000';end if;
 select coalesce(jsonb_agg(jsonb_build_array(h.appointment_id,h.current_revision,h.source_episode_id,h.agreed_starts_at,h.confirmed_at)order by h.appointment_id),'[]')into facts from private.safety_appointment_results h where h.identity_id=p_identity;
 select coalesce(jsonb_agg(x.value order by x.value->>'anchorAppointmentId'),'[]')into actions from jsonb_array_elements(plan->'actions')x
 where not exists(select 1 from private.cancellation_chain_effects m join private.effective_safety_subjects(p_identity)s on s.incident_id=m.incident_id
 join private.safety_sanction_applications ap on ap.incident_id=s.incident_id and ap.identity_id=p_identity and ap.revoked_at is null and ap.kind=x.value->>'kind'
 where m.identity_id=p_identity and m.anchor_appointment_id=(x.value->>'anchorAppointmentId')::uuid and s.cancellation_action=x.value->>'kind');
 return jsonb_build_object('reportId',p_report,'reportVersion',(select review_version from private.member_reports where id=p_report),
 'planFingerprint',encode(sha256(convert_to(jsonb_build_array(plan,facts)::text,'UTF8')),'hex'),'actions',actions);end;$$;
create function public.get_assigned_cancellation_clock_state(p_report_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare identity uuid;actor uuid;result jsonb;begin
 if p_report_id is null then raise exception 'invalid_input'using errcode='22023';end if;
 identity:=private.assigned_cancellation_clock_identity(p_report_id);
 result:=private.cancellation_clock_state(p_report_id,identity);
 actor:=private.require_assigned_report_operator(p_report_id);
 if private.profile_retired(actor)or exists(select 1 from private.member_reports where id=p_report_id and retention_due_at<=clock_timestamp())then raise exception 'operator_access_denied'using errcode='42501';end if;
 return result;
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;
create function public.repair_assigned_cancellation_clocks(p_report_id uuid,p_client_request_id uuid,p_expected_report_version bigint,p_plan_fingerprint text,p_mappings jsonb)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare actor uuid;identity uuid;clock_state jsonb;mapping jsonb;action jsonb;old private.safety_sanction_applications;
 head private.safety_appointment_results;successor private.safety_sanction_applications;receipt private.cancellation_clock_repair_receipts;
 fingerprint text;incident uuid;rev bigint;episode uuid;predecessor uuid;desired_kind text;payload jsonb;plan jsonb;result jsonb;clock timestamptz;begin
 if p_report_id is null or p_client_request_id is null or p_expected_report_version is null or p_expected_report_version not between 1 and 9007199254740990
 or p_plan_fingerprint is null or p_plan_fingerprint!~'^[a-f0-9]{64}$'or p_mappings is null or jsonb_typeof(p_mappings)<>'array'or jsonb_array_length(p_mappings)not between 1 and 100 then raise exception 'invalid_clock_repair'using errcode='22023';end if;
 actor:=private.require_assigned_report_operator(p_report_id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_client_request_id::text,70200));
 fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_report_id,p_expected_report_version,p_plan_fingerprint,p_mappings)::text,'UTF8')),'hex');
 select *into receipt from private.cancellation_clock_repair_receipts where actor_id=actor and client_request_id=p_client_request_id;
 if found then
  if receipt.fingerprint<>fingerprint then raise exception 'request_conflict'using errcode='40001';end if;
  perform 1 from private.member_reports where id=receipt.report_id and(retention_due_at is null or retention_due_at>clock_timestamp())for share;
  if not found then raise exception 'report_unavailable'using errcode='PT404';end if;
  perform private.require_assigned_report_operator(p_report_id);
  if private.profile_retired(actor)or exists(select 1 from private.member_reports where id=p_report_id and retention_due_at<=clock_timestamp())then raise exception 'operator_access_denied'using errcode='42501';end if;
  return receipt.result||jsonb_build_object('alreadyApplied',true);
 end if;
 identity:=private.assigned_cancellation_clock_identity(p_report_id);clock_state:=private.cancellation_clock_state(p_report_id,identity);
 if clock_state->>'planFingerprint'is distinct from p_plan_fingerprint or(clock_state->>'reportVersion')::bigint is distinct from p_expected_report_version then raise exception 'state_conflict'using errcode='40001';end if;
 if jsonb_array_length(clock_state->'actions')<>jsonb_array_length(p_mappings)then raise exception 'clock_mapping_incomplete'using errcode='22023';end if;
 for mapping in select value from jsonb_array_elements(p_mappings)loop
  if jsonb_typeof(mapping)<>'object'or(select count(*)from jsonb_object_keys(mapping))<>2 or not(mapping?'anchorAppointmentId'and mapping?'predecessorApplicationId')
  or jsonb_typeof(mapping->'anchorAppointmentId')is distinct from 'string'or jsonb_typeof(mapping->'predecessorApplicationId')not in('null','string')then raise exception 'invalid_clock_mapping'using errcode='22023';end if;
 end loop;
 if(select count(distinct value->>'anchorAppointmentId')from jsonb_array_elements(p_mappings))<>jsonb_array_length(p_mappings)
 or exists(select 1 from jsonb_array_elements(p_mappings)m where not exists(select 1 from jsonb_array_elements(clock_state->'actions')a where a->>'anchorAppointmentId'=m->>'anchorAppointmentId'))then raise exception 'invalid_clock_mapping'using errcode='22023';end if;
 for action in select value from jsonb_array_elements(clock_state->'actions')order by value->>'anchorAppointmentId'loop
  select value into strict mapping from jsonb_array_elements(p_mappings)where value->>'anchorAppointmentId'=action->>'anchorAppointmentId';
  predecessor:=(mapping->>'predecessorApplicationId')::uuid;desired_kind:=action->>'kind';
  select *into strict head from private.safety_appointment_results where identity_id=identity and appointment_id=(action->>'anchorAppointmentId')::uuid;
  episode:=head.source_episode_id;
  if predecessor is not null then
   select *into old from private.safety_sanction_applications where id=predecessor for update nowait;
   if not found or old.identity_id<>identity or old.kind<>desired_kind or old.revoked_at is null or (old.correction_reason_code is null or old.correction_reason_code not in('incident_invalidated','cancellation_exception_corrected','decision_corrected'))
   or exists(select 1 from private.cancellation_clock_lineage where predecessor_application_id=old.id)
   or exists(select 1 from private.effective_safety_subjects(identity)where incident_id=old.incident_id)
   or exists(select 1 from private.cancellation_effect_suspensions where application_id=old.id and state='active')then raise exception 'clock_predecessor_conflict'using errcode='40001';end if;
   -- 동일 제재는 원 회차를 유지한다. 새 anchor의 현재 회차에 과거 감점을 옮기지 않는다.
   episode:=old.source_episode_id;
  end if;
  perform private.require_historical_safety_episode(identity,episode);
  select m.incident_id,i.current_revision into incident,rev from private.cancellation_chain_effects m join private.safety_incidents i on i.id=m.incident_id where m.identity_id=identity and m.anchor_appointment_id=head.appointment_id;
  if incident is null then incident:=gen_random_uuid();rev:=0;insert into private.safety_incidents(id)values(incident);
   insert into private.cancellation_chain_effects values(identity,head.appointment_id,episode,incident);
  else update private.cancellation_chain_effects set source_episode_id=episode where identity_id=identity and anchor_appointment_id=head.appointment_id;end if;
  payload:=jsonb_build_array(jsonb_build_object('identityId',identity,'sourceEpisodeId',episode,'confirmedKinds',case when desired_kind='cancel_restriction'then jsonb_build_array('cancel_sanction')else'[]'::jsonb end,
   'violationClass','cancellation','violationType',null,'victimIdentityId',null,'cancellationAction',desired_kind));
  perform private.record_incident_revision(incident,gen_random_uuid(),rev,'confirmed','explicit_cancellation_clock_lineage',actor,payload);
  select *into strict successor from private.safety_sanction_applications where identity_id=identity and incident_id=incident and kind=desired_kind and revoked_at is null for update;
  clock:=case when predecessor is null then clock_timestamp()else old.applied_at end;
  update private.safety_sanction_applications set applied_at=clock,expires_at=case when desired_kind='cancel_restriction'then clock+interval'168 hours'else null end where id=successor.id returning *into successor;
  insert into private.cancellation_clock_lineage values(successor.id,predecessor,identity,incident,head.appointment_id,episode,desired_kind,successor.applied_at,successor.expires_at,p_plan_fingerprint);
 end loop;
 perform private.recompute_safety_applications(identity);
 plan:=private.reconcile_cancellation_chain(identity,actor);
 if plan->>'status'is distinct from 'ready'or plan->>'policyPending'is not null or jsonb_array_length(private.cancellation_clock_state(p_report_id,identity)->'actions')<>0 then raise exception 'clock_repair_incomplete'using errcode='55000';end if;
 perform private.finish_cancellation_due(identity,plan);
 update private.member_reports set review_version=review_version+1,updated_at=clock_timestamp()where id=p_report_id;
 update private.member_cancellation_notices n set plan_state='corrected',has_cancellation_warning=exists(select 1 from private.safety_sanction_applications where identity_id=identity and kind='cancel_warning'and revoked_at is null),
 restricted_until=(select max(expires_at)from private.safety_sanction_applications where identity_id=identity and kind='cancel_restriction'and revoked_at is null and expires_at>clock_timestamp())
 where n.report_id=p_report_id and n.decision_id=(select decision_id from private.appointment_cancel_resolutions where report_id=p_report_id order by(result_snapshot->>'reportVersion')::bigint desc limit 1);
 perform private.require_assigned_report_operator(p_report_id);
 if private.profile_retired(actor)or exists(select 1 from private.member_reports where id=p_report_id and retention_due_at<=clock_timestamp())then raise exception 'operator_access_denied'using errcode='42501';end if;
 result:=jsonb_build_object('reportId',p_report_id,'reportVersion',p_expected_report_version+1,'repairedCount',jsonb_array_length(p_mappings),'alreadyApplied',false);
 insert into private.cancellation_clock_repair_receipts values(actor,p_client_request_id,p_report_id,fingerprint,result);
 return result;
exception when lock_not_available or unique_violation then raise exception 'state_conflict'using errcode='40001';when invalid_text_representation then raise exception 'invalid_clock_mapping'using errcode='22023';end;$$;
do $$declare own text;f regprocedure;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='private.require_assigned_report_operator(uuid)'::regprocedure;
 execute format('alter table private.cancellation_clock_lineage owner to %I',own);execute format('alter table private.cancellation_clock_repair_receipts owner to %I',own);
 foreach f in array array['private.protect_retained_cancellation_clock_predecessor()'::regprocedure,'private.assigned_cancellation_clock_identity(uuid)'::regprocedure,'private.cancellation_clock_state(uuid,uuid)'::regprocedure,'public.get_assigned_cancellation_clock_state(uuid)'::regprocedure,'public.repair_assigned_cancellation_clocks(uuid,uuid,bigint,text,jsonb)'::regprocedure]loop
 execute format('alter function %s owner to %I',f,own);execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f);end loop;
end;$$;
grant execute on function public.get_assigned_cancellation_clock_state(uuid),public.repair_assigned_cancellation_clocks(uuid,uuid,bigint,text,jsonb)to authenticated;
commit;
