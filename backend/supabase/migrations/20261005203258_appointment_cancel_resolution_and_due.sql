-- 민규 private v2 작성 중 후보: source77 위 취소 이의 해소/확정 prefix/DB fenced due. 실제 SQL NOT_RUN.
-- 공식 leaf203258 예약은 root가 생성했다. immutable 21810/21811/74..77은 수정하지 않는다.
begin;
create temp table cancel_resolution_function_baseline on commit drop as
 select oid,proowner,proacl::text acl,proconfig::text config,prosrc from pg_proc
 where oid in('private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)'::regprocedure,
 'private.recompute_safety_applications(uuid)'::regprocedure,'private.cancellation_sanction_plan(uuid)'::regprocedure,
 'private.require_member_decision_notice_episode()'::regprocedure,'private.require_assigned_report_operator(uuid)'::regprocedure);
do $$declare canonical_owner text;f record;g text;permission text;begin
 select pg_get_userbyid(proowner)into strict canonical_owner from cancel_resolution_function_baseline
 where oid='private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)'::regprocedure;
 if not exists(select 1 from pg_roles where rolname=canonical_owner and(rolsuper or rolbypassrls))then
  raise exception 'cancellation_owner_incompatible'using errcode='55000';end if;
 foreach g in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
  if pg_has_role(g,canonical_owner,'USAGE')or pg_has_role(g,canonical_owner,'SET')then raise exception 'cancellation_owner_incompatible'using errcode='55000';end if;
 end loop;
 foreach g in array array['private','public','auth']loop
  if not has_schema_privilege(canonical_owner,g,'USAGE')then raise exception 'cancellation_owner_permissions_invalid'using errcode='55000';end if;
 end loop;
 for f in select *from cancel_resolution_function_baseline loop
  if f.proowner<>(select proowner from cancel_resolution_function_baseline where oid='private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)'::regprocedure)
  or not has_function_privilege(canonical_owner,f.oid,'EXECUTE')then raise exception 'cancellation_owner_permissions_invalid'using errcode='55000';end if;
 end loop;
 -- 최신21811 이후 anchor이며 원21810 SHARE 본문을 현재 정의로 잘못 재사용하지 않는다.
 if not exists(select 1 from cancel_resolution_function_baseline where oid='private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)'::regprocedure
  and prosrc like '%order by a.subject for update of a nowait;%'and prosrc like '%order by id for update nowait;%'and prosrc like '%order by profile_id,id for update nowait;%')then
  raise exception 'cancellation_record_lock_source_changed'using errcode='55000';end if;
 if not has_function_privilege(canonical_owner,'private.assert_current_worker_job(uuid,uuid,uuid)','EXECUTE')then raise exception 'cancellation_worker_owner_permissions_invalid'using errcode='55000';end if;
 foreach g in array array['private.naver_accounts','public.profiles','private.member_episodes','private.naver_identity_keys',
 'private.safety_incidents','private.safety_incident_subjects','private.safety_appointment_results','private.safety_appointment_result_revisions',
 'private.safety_sanction_applications','private.worker_jobs','private.member_reports','private.safety_appeals','public.appointments']loop
  foreach permission in array array['SELECT','UPDATE']loop
   if not has_table_privilege(canonical_owner,g,permission)then raise exception 'cancellation_owner_permissions_invalid'using errcode='55000';end if;
  end loop;
 end loop;
 foreach g in array array['private.appointment_cancellations','private.appointment_cancel_appeal_receipts']loop
  if not has_table_privilege(canonical_owner,g,'SELECT')then raise exception 'cancellation_owner_permissions_invalid'using errcode='55000';end if;
 end loop;
 foreach g in array array['private.safety_incidents','private.safety_appointment_result_revisions','private.worker_jobs']loop
  if not has_table_privilege(canonical_owner,g,'INSERT')then raise exception 'cancellation_owner_permissions_invalid'using errcode='55000';end if;
 end loop;
 foreach g in array array['auth.role()','private.profile_retired(uuid)','private.assigned_report_incident(uuid)',
 'private.effective_safety_subjects(uuid)','private.sync_safety_incident_sweetness(uuid)',
 'private.decide_incident_sweetness(uuid,uuid,uuid,text,bigint,boolean)','private.require_verified_safety_episode(uuid,uuid)']loop
  if not has_function_privilege(canonical_owner,g,'EXECUTE')then raise exception 'cancellation_owner_permissions_invalid'using errcode='55000';end if;
 end loop;
end;$$;

create temp table cancellation_effective_baseline on commit drop as
 select oid,proowner,proacl::text acl,proconfig::text config,prosrc from pg_proc where oid='private.effective_safety_subjects(uuid)'::regprocedure;
do $$begin
 if not exists(select 1 from cancellation_effective_baseline where prosrc=$effective_source$
 with effective as(select distinct on(r.incident_id)r.* from private.safety_incident_revisions r
 where r.state<>'reviewing'order by r.incident_id,r.revision desc)
 select r.incident_id,r.revision,s.source_episode_id,s.confirmed_kinds,s.violation_class,s.violation_type,s.victim_identity_id,s.cancellation_action,
 (select min(h.decided_at)from private.safety_incident_revisions h join private.safety_incident_subjects hs on hs.incident_id=h.incident_id and hs.revision=h.revision
   where h.incident_id=r.incident_id and h.state='confirmed'and hs.identity_id=s.identity_id)
 from effective r join private.safety_incident_subjects s on s.incident_id=r.incident_id and s.revision=r.revision
 where r.state='confirmed'and s.identity_id=p_identity_id;
$effective_source$)then
  raise exception 'cancellation_effective_source_changed'using errcode='55000';end if;
 if (select proowner from cancellation_effective_baseline)<>(select proowner from cancel_resolution_function_baseline
  where oid='private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)'::regprocedure)then
  raise exception 'cancellation_effective_owner_incompatible'using errcode='55000';end if;
end;$$;

-- 기존 최소 결과/제재 연결 책임. 원문·report TTL을 복사하지 않으며 보고서 삭제로 효력을 되살리지 않는다.
create table private.cancellation_chain_effects(
 identity_id uuid not null references private.naver_identity_keys(id),
 anchor_appointment_id uuid not null,
 source_episode_id uuid not null references private.member_episodes(id),
 incident_id uuid not null unique references private.safety_incidents(id),
 primary key(identity_id,anchor_appointment_id),
 foreign key(identity_id,anchor_appointment_id)references private.safety_appointment_results(identity_id,appointment_id));
create table private.cancellation_safety_due(
 identity_id uuid primary key references private.naver_identity_keys(id),
 generation bigint not null default 1 check(generation between 1 and 9007199254740991),
 next_due_at timestamptz,
 policy_pending_code text check(policy_pending_code in('anchor_clock_transfer_unresolved','ended_episode_first_effect_unresolved','ordering_unknown')),
 updated_at timestamptz not null default clock_timestamp());
-- 해소 상세/멱등은 원report90d와 함께 파기한다. 최초 접수76 receipt와 별개다.
create table private.appointment_cancel_resolutions(
 decision_id uuid primary key,
 report_id uuid not null references private.member_reports(id)on delete cascade,
 appeal_id uuid not null references private.safety_appeals(id)on delete cascade,
 actor_id uuid not null,
 client_request_id uuid not null,
 input_sha256 text not null check(input_sha256~'^[a-f0-9]{64}$'),
 mode text not null check(mode in('initial','correction')),
 outcome text not null check(outcome in('accepted','rejected')),
 result_snapshot jsonb not null,
 decided_at timestamptz not null default clock_timestamp(),
 unique(actor_id,client_request_id));
create table private.member_cancellation_notices(
 id uuid primary key default gen_random_uuid(),
 report_id uuid not null references private.member_reports(id)on delete cascade,
 decision_id uuid not null references private.appointment_cancel_resolutions(decision_id)on delete cascade,
 recipient_identity_id uuid not null references private.naver_identity_keys(id),
 recipient_episode_id uuid not null references private.member_episodes(id),
 appointment_id uuid not null,
 appeal_state text check(appeal_state in('reviewing','accepted','rejected')),
 plan_state text not null check(plan_state in('held','applied','corrected','policy_pending')),
 eligible_count integer check(eligible_count>=0),provisional_count integer check(provisional_count>=0),
 has_cancellation_warning boolean not null,
 restricted_until timestamptz,
 available_at timestamptz not null default clock_timestamp(),first_read_at timestamptz,
 unique(decision_id,recipient_episode_id),
 check(first_read_at is null or first_read_at>=available_at));
-- 해소 notice 상세는 report/해소 receipt와 함께 파기한다. 외부 delivery 사실이 아니다.
-- 무report 자동 notice 상세의 목적종료 gate는 아직 없어 해당 영속 행/공개를 열지 않는다.

create function private.current_cancellation_sanction_plan(p_identity_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare row_result record;streak integer:=0;warning_seen boolean:=false;provisional integer:=0;
 actions jsonb:='[]';n timestamptz:=clock_timestamp();begin
 if exists(select 1 from private.safety_appointment_results where identity_id=p_identity_id and ordering_provenance='unknown')then
  return jsonb_build_object('status','ordering_unknown','actions',actions,'eligibleCount',null,'provisionalCount',null);end if;
 for row_result in select h.*,r.outcome,r.cancellation_at,r.appeal_state from private.safety_appointment_results h
 left join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
 where h.identity_id=p_identity_id order by h.agreed_starts_at,h.confirmed_at,h.appointment_id loop
  if row_result.outcome is null or row_result.outcome='pending'then
   return jsonb_build_object('status','held','heldAppointmentId',row_result.appointment_id,'actions',actions,'eligibleCount',streak,'provisionalCount',provisional);end if;
  if row_result.outcome='completed'then streak:=0;provisional:=0;
  elsif row_result.outcome='own_cancel'then
   provisional:=provisional+1;
   if row_result.appeal_state='reviewing'or(row_result.appeal_state='none'and n<row_result.cancellation_at+interval'24 hours')then
    return jsonb_build_object('status','held','heldAppointmentId',row_result.appointment_id,'actions',actions,'eligibleCount',streak,'provisionalCount',provisional);end if;
   streak:=streak+1;
   if streak=3 then
    actions:=actions||jsonb_build_array(jsonb_build_object('anchorAppointmentId',row_result.appointment_id,'kind',case when warning_seen then'cancel_restriction'else'cancel_warning'end));
    warning_seen:=true;streak:=0;provisional:=0;
   end if;
  end if;
 end loop;
 return jsonb_build_object('status','ready','actions',actions,'eligibleCount',streak,'provisionalCount',provisional);
end;$$;

-- incident advisory→account→profile→episode→identity. 신규 AP/result는 뒤에서NOWAIT만 한다.
create function private.lock_cancellation_identity(p_identity_id uuid)
returns void language plpgsql volatile security definer set search_path=''as $$
declare effect_row record;locked_incidents uuid[];begin
 select coalesce(array_agg(incident_id order by incident_id),'{}'::uuid[])into locked_incidents from private.cancellation_chain_effects where identity_id=p_identity_id;
 for effect_row in select incident_id from private.cancellation_chain_effects where identity_id=p_identity_id order by incident_id loop
  if not pg_try_advisory_xact_lock(hashtextextended(effect_row.incident_id::text,21810))then raise exception 'state_conflict'using errcode='40001';end if;end loop;
 perform 1 from private.naver_accounts a join private.naver_identity_keys k on k.subject=a.subject
  where k.id=p_identity_id order by a.subject for update of a nowait;
 perform 1 from public.profiles p where id in(select profile_id from private.member_episodes where identity_id=p_identity_id)order by id for update nowait;
 perform 1 from private.member_episodes where identity_id=p_identity_id order by profile_id,id for update nowait;
 perform 1 from private.naver_identity_keys where id=p_identity_id for update nowait;
 if not found then raise exception 'cancellation_identity_unavailable'using errcode='42501';end if;
 perform 1 from private.safety_appointment_results where identity_id=p_identity_id order by appointment_id for update nowait;
 if locked_incidents is distinct from(select coalesce(array_agg(incident_id order by incident_id),'{}'::uuid[])from private.cancellation_chain_effects where identity_id=p_identity_id)then
  raise exception 'cancellation_incident_lock_set_changed'using errcode='40001';end if;
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;

-- 보류 lineage는 정확한 원 application에 묶이고 신고 원문/보관 기간을 복제하지 않는다.
create table private.cancellation_effect_suspensions(
 application_id uuid primary key references private.safety_sanction_applications(id)on delete cascade,
 identity_id uuid not null references private.naver_identity_keys(id),
 incident_id uuid not null references private.safety_incidents(id),
 source_episode_id uuid not null references private.member_episodes(id),
 decision_revision bigint not null check(decision_revision between 1 and 9007199254740991),
 kind text not null check(kind in('cancel_warning','cancel_restriction')),
 original_applied_at timestamptz not null,original_expires_at timestamptz,
 restore_sweetness boolean not null,
 state text not null check(state in('active','restored','invalidated')),
 suspended_at timestamptz not null,finished_at timestamptz,
 check((state='active'and finished_at is null)or(state<>'active'and finished_at is not null)),
 check((kind='cancel_warning'and original_expires_at is null)or
  (kind='cancel_restriction'and original_expires_at=original_applied_at+interval'168 hours')));

create or replace function private.effective_safety_subjects(p_identity_id uuid)
returns table(incident_id uuid,decision_revision bigint,source_episode_id uuid,confirmed_kinds text[],
 violation_class text,violation_type text,victim_identity_id uuid,cancellation_action text,confirmed_at timestamptz)
language sql stable security definer set search_path='' as $$
 with effective as(select distinct on(r.incident_id)r.* from private.safety_incident_revisions r
 where r.state<>'reviewing'order by r.incident_id,r.revision desc)
 select r.incident_id,r.revision,s.source_episode_id,s.confirmed_kinds,s.violation_class,s.violation_type,s.victim_identity_id,s.cancellation_action,
 (select min(h.decided_at)from private.safety_incident_revisions h join private.safety_incident_subjects hs on hs.incident_id=h.incident_id and hs.revision=h.revision
   where h.incident_id=r.incident_id and h.state='confirmed'and hs.identity_id=s.identity_id)
 from effective r join private.safety_incident_subjects s on s.incident_id=r.incident_id and s.revision=r.revision
 where r.state='confirmed'and s.identity_id=p_identity_id
 and not(s.violation_class='cancellation'and exists(select 1 from private.cancellation_effect_suspensions lineage
  where lineage.identity_id=s.identity_id and lineage.incident_id=r.incident_id and lineage.state='active'));
$$;

-- 원 confirmed 사실 판정은 filtered effective helper와 별도로 읽는다.
create function private.raw_cancellation_subject(p_identity uuid,p_incident uuid)
returns table(decision_revision bigint,source_episode_id uuid,cancellation_action text)
language sql stable security definer set search_path=''as $$
 with latest as(select revision,state from private.safety_incident_revisions where incident_id=p_incident and state<>'reviewing'order by revision desc limit 1)
 select r.revision,s.source_episode_id,s.cancellation_action from latest r join private.safety_incident_subjects s
 on s.incident_id=p_incident and s.revision=r.revision where r.state='confirmed'and s.identity_id=p_identity and s.violation_class='cancellation';
$$;

-- 현재 최소 결과를 조회한다. report CASCADE가 다른 reviewing 근거를 없애지 않는다.
create function private.cancellation_review_blocks(p_identity uuid,p_anchor uuid)
returns boolean language sql stable security definer set search_path=''as $$
 select exists(select 1 from private.safety_appointment_results candidate_head
 join private.safety_appointment_result_revisions candidate_result
 on candidate_result.identity_id=candidate_head.identity_id and candidate_result.appointment_id=candidate_head.appointment_id and candidate_result.revision=candidate_head.current_revision
 join private.safety_appointment_results anchor_head on anchor_head.identity_id=candidate_head.identity_id and anchor_head.appointment_id=p_anchor
 where candidate_head.identity_id=p_identity and candidate_result.outcome='own_cancel'and candidate_result.appeal_state='reviewing'
 and(exists(select 1 from private.safety_appointment_results unknown_head where unknown_head.identity_id=p_identity and unknown_head.ordering_provenance='unknown')
  or(candidate_head.agreed_starts_at,candidate_head.confirmed_at,candidate_head.appointment_id)<=(anchor_head.agreed_starts_at,anchor_head.confirmed_at,anchor_head.appointment_id)));
$$;

create function private.suspend_cancellation_suffix(p_identity uuid)
returns void language plpgsql volatile security definer set search_path=''as $$
declare mapped record;application_row private.safety_sanction_applications;raw_subject record;lineage private.cancellation_effect_suspensions;begin
 for mapped in select *from private.cancellation_chain_effects where identity_id=p_identity order by incident_id loop
  if not private.cancellation_review_blocks(p_identity,mapped.anchor_appointment_id)then continue;end if;
  select *into raw_subject from private.raw_cancellation_subject(p_identity,mapped.incident_id);
  if not found then continue;end if;
  select *into application_row from private.safety_sanction_applications where identity_id=p_identity and incident_id=mapped.incident_id and revoked_at is null for update nowait;
  if not found then continue;end if;
  if application_row.kind not in('cancel_warning','cancel_restriction')or application_row.kind is distinct from raw_subject.cancellation_action
   or application_row.source_episode_id is distinct from mapped.source_episode_id or raw_subject.source_episode_id is distinct from mapped.source_episode_id
   or application_row.decision_revision is distinct from raw_subject.decision_revision then raise exception 'cancellation_suspension_relation_conflict'using errcode='40001';end if;
  select *into lineage from private.cancellation_effect_suspensions where application_id=application_row.id for update nowait;
  if found and(lineage.state='invalidated'or lineage.identity_id<>p_identity or lineage.incident_id<>mapped.incident_id
   or lineage.source_episode_id<>application_row.source_episode_id or lineage.kind<>application_row.kind
   or lineage.original_applied_at is distinct from application_row.applied_at or lineage.original_expires_at is distinct from application_row.expires_at)then
   raise exception 'cancellation_suspension_relation_conflict'using errcode='40001';end if;
  insert into private.cancellation_effect_suspensions(application_id,identity_id,incident_id,source_episode_id,decision_revision,kind,
   original_applied_at,original_expires_at,restore_sweetness,state,suspended_at)
  values(application_row.id,p_identity,mapped.incident_id,application_row.source_episode_id,application_row.decision_revision,application_row.kind,
   application_row.applied_at,application_row.expires_at,exists(select 1 from private.sweetness_incident_decisions prior_decision
    where prior_decision.incident_id=mapped.incident_id and prior_decision.recipient_episode_id=application_row.source_episode_id and prior_decision.kind='cancel_sanction'
    and prior_decision.is_valid and prior_decision.revision=(select max(latest_decision.revision)from private.sweetness_incident_decisions latest_decision
     where latest_decision.incident_id=prior_decision.incident_id and latest_decision.recipient_episode_id=prior_decision.recipient_episode_id and latest_decision.kind=prior_decision.kind)),
   'active',clock_timestamp())
  on conflict(application_id)do update set decision_revision=excluded.decision_revision,restore_sweetness=excluded.restore_sweetness,state='active',suspended_at=excluded.suspended_at,finished_at=null;
  -- 명시 임시보류 사유를 먼저 기록하여 generic recompute가 invalidated라고 오기록하지 않게 한다.
  update private.safety_sanction_applications set revoked_at=clock_timestamp(),correction_reason_code='cancellation_review_suspended'where id=application_row.id;
  perform private.sync_safety_incident_sweetness(mapped.incident_id);
 end loop;
 perform private.recompute_safety_applications(p_identity);
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;

-- 원 application을 generic recompute보다 먼저 복원한다. 새 기간/새 회차를 만들지 않는다.
create function private.restore_cancellation_suffix(p_identity uuid,p_plan jsonb)
returns void language plpgsql volatile security definer set search_path=''as $$
declare lineage private.cancellation_effect_suspensions;mapped private.cancellation_chain_effects;
 application_row private.safety_sanction_applications;raw_subject record;sweetness_revision bigint;prior_valid boolean;begin
 for lineage in select *from private.cancellation_effect_suspensions where identity_id=p_identity and state='active'order by incident_id,application_id for update nowait loop
  select *into strict mapped from private.cancellation_chain_effects where identity_id=p_identity and incident_id=lineage.incident_id;
  if private.cancellation_review_blocks(p_identity,mapped.anchor_appointment_id)then continue;end if;
  if not exists(select 1 from jsonb_array_elements(p_plan->'actions')desired_action
   where(desired_action->>'anchorAppointmentId')::uuid=mapped.anchor_appointment_id and desired_action->>'kind'=lineage.kind)then continue;end if;
  select *into raw_subject from private.raw_cancellation_subject(p_identity,lineage.incident_id);
  if not found or raw_subject.decision_revision<>lineage.decision_revision or raw_subject.source_episode_id<>lineage.source_episode_id
   or raw_subject.cancellation_action<>lineage.kind then raise exception 'cancellation_suspension_revision_conflict'using errcode='40001';end if;
  select *into application_row from private.safety_sanction_applications where id=lineage.application_id for update nowait;
  if not found or application_row.identity_id<>p_identity or application_row.incident_id<>lineage.incident_id
   or application_row.decision_revision<>lineage.decision_revision or application_row.source_episode_id<>lineage.source_episode_id
   or application_row.kind<>lineage.kind or application_row.applied_at is distinct from lineage.original_applied_at
   or application_row.expires_at is distinct from lineage.original_expires_at or application_row.correction_reason_code is distinct from 'cancellation_review_suspended'
   or application_row.revoked_at is null then raise exception 'cancellation_suspension_relation_conflict'using errcode='40001';end if;
  update private.cancellation_effect_suspensions set state='restored',finished_at=clock_timestamp()where application_id=lineage.application_id;
  update private.safety_sanction_applications set revoked_at=null,correction_reason_code=null where id=lineage.application_id;
  if lineage.restore_sweetness then
   if not exists(select 1 from private.sweetness_incidents where incident_id=lineage.incident_id and recipient_episode_id=lineage.source_episode_id)then
    raise exception 'cancellation_suspension_sweetness_unavailable'using errcode='55000';end if;
   select revision,is_valid into sweetness_revision,prior_valid from private.sweetness_incident_decisions
    where incident_id=lineage.incident_id and recipient_episode_id=lineage.source_episode_id and kind='cancel_sanction'order by revision desc limit 1;
   if not found then raise exception 'cancellation_suspension_sweetness_unavailable'using errcode='55000';end if;
   if not prior_valid then perform private.decide_incident_sweetness(gen_random_uuid(),lineage.incident_id,lineage.source_episode_id,'cancel_sanction',sweetness_revision+1,true);end if;
  end if;
 end loop;
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;

create function private.cancellation_review_suspension_changed()
returns trigger language plpgsql security definer set search_path=''as $$
declare current_result private.safety_appointment_result_revisions;begin
 select *into current_result from private.safety_appointment_result_revisions where identity_id=new.identity_id and appointment_id=new.appointment_id and revision=new.current_revision;
 if current_result.outcome='own_cancel'and current_result.appeal_state='reviewing'then
  perform private.lock_cancellation_identity(new.identity_id);
  perform private.suspend_cancellation_suffix(new.identity_id);
 end if;
 return new;
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;
create trigger cancellation_review_suspend_result after update of current_revision on private.safety_appointment_results
 for each row when(old.current_revision is distinct from new.current_revision)execute function private.cancellation_review_suspension_changed();

-- active lineage의 근거 행 삭제로 confirmed 효과가 다시 적용되는 경로는 열지 않는다.
-- 실제 보관 엔진의 종료 조건은 후속 연결이며 새로운 보관 기간을 정하지 않는다.
create function private.protect_active_cancellation_suspension()
returns trigger language plpgsql security definer set search_path=''as $$begin
 if exists(select 1 from private.cancellation_effect_suspensions where application_id=old.id and state='active')then
  raise exception 'cancellation_suspension_retention_pending'using errcode='55000';end if;
 return old;
end;$$;
create trigger cancellation_suspension_application_delete before delete on private.safety_sanction_applications
 for each row execute function private.protect_active_cancellation_suspension();

create function private.reconcile_cancellation_chain(p_identity_id uuid,p_actor uuid)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare plan jsonb;desired_action jsonb;effect_row record;head private.safety_appointment_results;
 incident uuid;revision bigint;kind text;payload jsonb;policy_pending text;changed boolean:=false;removed boolean:=false;
 held_order record;current_order record;begin
 perform private.suspend_cancellation_suffix(p_identity_id);
 plan:=private.current_cancellation_sanction_plan(p_identity_id);
 perform private.restore_cancellation_suffix(p_identity_id,plan);
 if plan->>'status'='ordering_unknown'then
  return plan||jsonb_build_object('policyPending','ordering_unknown','changed',false);end if;
 if plan->>'status'='held'then select agreed_starts_at,confirmed_at,appointment_id into held_order
  from private.safety_appointment_results where identity_id=p_identity_id and appointment_id=(plan->>'heldAppointmentId')::uuid;end if;
 -- 확정 prefix 내부에서 빠진 효과만 무효화한다. held 뒤의 아직미정효과를 임의로 정정하지 않는다.
 for effect_row in select m.*,i.current_revision from private.cancellation_chain_effects m join private.safety_incidents i on i.id=m.incident_id
 where m.identity_id=p_identity_id order by m.anchor_appointment_id loop
  select agreed_starts_at,confirmed_at,appointment_id into current_order from private.safety_appointment_results
   where identity_id=p_identity_id and appointment_id=effect_row.anchor_appointment_id;
  if plan->>'status'='held'then
   if(current_order.agreed_starts_at,current_order.confirmed_at,current_order.appointment_id)>=(held_order.agreed_starts_at,held_order.confirmed_at,held_order.appointment_id)then continue;end if;
  end if;
  if not exists(select 1 from jsonb_array_elements(plan->'actions')x where(x->>'anchorAppointmentId')::uuid=effect_row.anchor_appointment_id
    and exists(select 1 from private.safety_incident_subjects old_subject where old_subject.incident_id=effect_row.incident_id and old_subject.revision=effect_row.current_revision and old_subject.cancellation_action=x->>'kind'))then
   -- 이미 무효화된 anchor도 재시도 때 이력으로 인식해 새시계로 효과를 만들지 않는다.
   removed:=true;
   if exists(select 1 from private.raw_cancellation_subject(p_identity_id,effect_row.incident_id))then
    if effect_row.current_revision not between 1 and 9007199254740990 then raise exception 'cancellation_incident_revision_unavailable'using errcode='55000';end if;
    perform private.record_incident_revision(effect_row.incident_id,gen_random_uuid(),effect_row.current_revision,'invalidated','cancellation_exception_corrected',p_actor,'[]');
    update private.safety_sanction_applications application_row set correction_reason_code='cancellation_exception_corrected'
     where application_row.id in(select application_id from private.cancellation_effect_suspensions where identity_id=p_identity_id and incident_id=effect_row.incident_id and state='active');
    update private.cancellation_effect_suspensions set state='invalidated',finished_at=clock_timestamp()
     where identity_id=p_identity_id and incident_id=effect_row.incident_id and state='active';changed:=true;
   end if;
  end if;
 end loop;
 for desired_action in select value from jsonb_array_elements(plan->'actions')loop
  select *into head from private.safety_appointment_results where identity_id=p_identity_id and appointment_id=(desired_action->>'anchorAppointmentId')::uuid;
  kind:=desired_action->>'kind';
  select m.incident_id,i.current_revision into incident,revision from private.cancellation_chain_effects m join private.safety_incidents i on i.id=m.incident_id
   where m.identity_id=p_identity_id and m.anchor_appointment_id=head.appointment_id;
  if incident is not null and exists(select 1 from private.effective_safety_subjects(p_identity_id)s where s.incident_id=incident and s.cancellation_action=kind)then continue;end if;
  -- anchor가 옮겨진 후의 새로운 효과시계/경고승계는 미정이다. 잘못된 기존효과철회는 위에서 완료한다.
  if removed or(incident is not null and exists(select 1 from private.safety_incident_subjects where incident_id=incident and cancellation_action is distinct from kind))then
   policy_pending:='anchor_clock_transfer_unresolved';exit;end if;
  if exists(select 1 from private.member_episodes where id=head.source_episode_id and ended_at is not null)then
   policy_pending:='ended_episode_first_effect_unresolved';exit;end if;
  perform private.require_verified_safety_episode(p_identity_id,head.source_episode_id);
  if incident is null then
   incident:=gen_random_uuid();revision:=0;insert into private.safety_incidents(id)values(incident);
   insert into private.cancellation_chain_effects values(p_identity_id,head.appointment_id,head.source_episode_id,incident);end if;
  payload:=jsonb_build_array(jsonb_build_object('identityId',p_identity_id,'sourceEpisodeId',head.source_episode_id,
   'confirmedKinds',case when kind='cancel_restriction'then jsonb_build_array('cancel_sanction')else'[]'::jsonb end,
   'violationClass','cancellation','violationType',null,'victimIdentityId',null,'cancellationAction',kind));
  if revision not between 0 and 9007199254740990 then raise exception 'cancellation_incident_revision_unavailable'using errcode='55000';end if;
  perform private.record_incident_revision(incident,gen_random_uuid(),revision,'confirmed','cancellation_prefix_confirmed',p_actor,payload);
  changed:=true;
 end loop;
 return plan||jsonb_build_object('policyPending',policy_pending,'changed',changed);
end;$$;

create function private.cancellation_due_changed()
returns trigger language plpgsql security definer set search_path=''as $$begin
 insert into private.cancellation_safety_due(identity_id,generation,next_due_at)values(new.identity_id,1,clock_timestamp())
 on conflict(identity_id)do update set generation=private.cancellation_safety_due.generation+1,next_due_at=clock_timestamp(),policy_pending_code=null,updated_at=clock_timestamp();
 perform pg_notify('yumidang_cancellation_due','changed');return new;
end;$$;
create trigger cancellation_due_result_changed after insert or update of current_revision on private.safety_appointment_results
 for each row execute function private.cancellation_due_changed();

create function private.finish_cancellation_due(p_identity_id uuid,p_plan jsonb)
returns void language plpgsql security definer set search_path=''as $$
declare next_due timestamptz;pending_code text:=p_plan->>'policyPending';begin
 if pending_code is null and p_plan->>'status'='held'then
  select r.cancellation_at+interval'24 hours'into next_due from private.safety_appointment_results h
  join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
  where h.identity_id=p_identity_id and h.appointment_id=(p_plan->>'heldAppointmentId')::uuid and r.outcome='own_cancel'and r.appeal_state='none'
   and r.cancellation_at+interval'24 hours'>clock_timestamp();end if;
 update private.cancellation_safety_due set next_due_at=next_due,policy_pending_code=pending_code,updated_at=clock_timestamp()where identity_id=p_identity_id;
end;$$;

create function private.record_cancellation_notice(p_identity_id uuid,p_episode uuid,p_appointment uuid,p_report uuid,p_decision uuid,p_appeal_state text,p_plan jsonb,p_corrected boolean)
returns void language plpgsql security definer set search_path=''as $$
declare warning boolean;restricted timestamptz;begin
 select coalesce(bool_or(kind='cancel_warning'),false),max(expires_at)filter(where kind='cancel_restriction'and expires_at>clock_timestamp())
 into warning,restricted from private.safety_sanction_applications where identity_id=p_identity_id and revoked_at is null;
 insert into private.member_cancellation_notices(report_id,decision_id,recipient_identity_id,recipient_episode_id,appointment_id,
  appeal_state,plan_state,eligible_count,provisional_count,has_cancellation_warning,restricted_until)
 values(p_report,p_decision,p_identity_id,p_episode,p_appointment,p_appeal_state,
  case when p_plan->>'policyPending'is not null then'policy_pending'when p_corrected then'corrected'when p_plan->>'status'='held'then'held'else'applied'end,
  (p_plan->>'eligibleCount')::integer,(p_plan->>'provisionalCount')::integer,warning,restricted);
end;$$;

create function public.resolve_assigned_appointment_cancel_appeal(p_report_id uuid,p_appeal_id uuid,p_client_request_id uuid,p_mode text,
 p_expected_report_version bigint,p_expected_result_revision bigint,p_expected_incident_revision bigint,p_outcome text)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare actor uuid;fingerprint text;prior private.appointment_cancel_resolutions;
 snapshot private.safety_appeals;appeal_row private.safety_appeals;report_row private.member_reports;
 head private.safety_appointment_results;cancel_row private.appointment_cancellations;episode_row private.member_episodes;
 old_result private.safety_appointment_result_revisions;decision uuid:=gen_random_uuid();incident_revision bigint:=0;result jsonb;plan jsonb;
begin
 if p_report_id is null or p_appeal_id is null or p_client_request_id is null or p_mode is null or p_mode not in('initial','correction')
 or p_outcome is null or p_outcome not in('accepted','rejected')or p_expected_report_version is null or p_expected_report_version not between 1 and 9007199254740990
 or p_expected_result_revision is null or p_expected_result_revision not between 1 and 9007199254740990
 or p_expected_incident_revision is null or p_expected_incident_revision not between 0 and 9007199254740990 then raise exception 'invalid_cancel_resolution'using errcode='22023';end if;
 actor:=private.require_assigned_report_operator(p_report_id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_report_id,p_appeal_id,p_mode,p_expected_report_version,p_expected_result_revision,p_expected_incident_revision,p_outcome)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_client_request_id::text,203258));
 select *into prior from private.appointment_cancel_resolutions where actor_id=actor and client_request_id=p_client_request_id;
 if found then
  if prior.input_sha256<>fingerprint then raise exception 'cancel_resolution_request_conflict'using errcode='40001';end if;
  perform 1 from private.member_reports where id=prior.report_id and(retention_due_at is null or retention_due_at>clock_timestamp())for share;
  if not found then raise exception 'report_unavailable'using errcode='PT404';end if;
  perform private.require_assigned_report_operator(p_report_id);
  if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
  if exists(select 1 from private.member_reports where id=p_report_id and retention_due_at<=clock_timestamp())then raise exception 'report_unavailable'using errcode='PT404';end if;
  return prior.result_snapshot||jsonb_build_object('alreadyApplied',true);
 end if;
 select *into snapshot from private.safety_appeals where id=p_appeal_id and report_id=p_report_id and kind='cancellation';
 if not found then raise exception 'appeal_unavailable'using errcode='PT404';end if;
 perform private.lock_cancellation_identity(snapshot.identity_id);
 perform 1 from public.appointments where id=snapshot.appointment_id for update nowait;
 select *into head from private.safety_appointment_results where identity_id=snapshot.identity_id and appointment_id=snapshot.appointment_id for update nowait;
 select *into report_row from private.member_reports where id=p_report_id for update nowait;
 if not found or report_row.retention_due_at<=clock_timestamp()then raise exception 'report_unavailable'using errcode='PT404';end if;
 select *into appeal_row from private.safety_appeals where id=p_appeal_id for update nowait;
 select *into episode_row from private.member_episodes where id=appeal_row.source_episode_id;
 select *into cancel_row from private.appointment_cancellations where appointment_id=appeal_row.appointment_id;
 if appeal_row.report_id is distinct from p_report_id or appeal_row.identity_id is distinct from snapshot.identity_id
 or appeal_row.appointment_id is distinct from snapshot.appointment_id or report_row.reporter_episode_id is distinct from appeal_row.source_episode_id
 or report_row.target_type<>'appointment'or report_row.target_id is distinct from appeal_row.appointment_id
 or report_row.reporter_id is distinct from episode_row.profile_id or cancel_row.cancelled_by is distinct from episode_row.profile_id
 or episode_row.identity_id is distinct from head.identity_id
 or head.source_episode_id is distinct from appeal_row.source_episode_id or head.ordering_provenance<>'agreed_snapshot'
 or not exists(select 1 from private.appointment_cancel_appeal_receipts where appeal_id=appeal_row.id and report_id=report_row.id and source_episode_id=head.source_episode_id)then
  raise exception 'cancel_resolution_relation_conflict'using errcode='40001';end if;
 -- 종료 회차도 해소/명백한 오효과 철회를 처리한다. 새 최초 효과만 reconcile이 보류한다.
 if episode_row.ended_at is null then perform private.require_verified_safety_episode(head.identity_id,head.source_episode_id);end if;
 if report_row.review_version<>p_expected_report_version or head.current_revision<>p_expected_result_revision
 or report_row.status not in('reviewing','more_evidence','received')or report_row.final_closed_at is not null then raise exception 'cancel_resolution_state_conflict'using errcode='40001';end if;
 select coalesce(max(i.current_revision),0)into incident_revision from private.cancellation_chain_effects m join private.safety_incidents i on i.id=m.incident_id
  where m.identity_id=head.identity_id and m.anchor_appointment_id=head.appointment_id;
 if incident_revision<>p_expected_incident_revision then raise exception 'cancel_resolution_incident_conflict'using errcode='40001';end if;
 if private.assigned_report_incident(report_row.id)is not null then raise exception 'cancel_report_other_incident_unresolved'using errcode='55000';end if;
 if p_mode='correction'and not exists(select 1 from private.appointment_cancel_resolutions where report_id=report_row.id and appeal_id=appeal_row.id)then raise exception 'cancel_correction_original_decision_unavailable'using errcode='55000';end if;
 if(p_mode='initial'and appeal_row.state<>'reviewing')or(p_mode='correction'and appeal_row.state='reviewing')then raise exception 'cancel_resolution_mode_conflict'using errcode='40001';end if;
 select *into old_result from private.safety_appointment_result_revisions where identity_id=head.identity_id and appointment_id=head.appointment_id and revision=head.current_revision;
 if not found or old_result.outcome not in('own_cancel','exempt')or(old_result.outcome='own_cancel'and old_result.cancellation_at is distinct from cancel_row.cancelled_at)then
  raise exception 'cancel_result_unresolved'using errcode='55000';end if;
 insert into private.safety_appointment_result_revisions(identity_id,appointment_id,revision,decision_id,outcome,cancellation_at,appeal_state,reason_code,origin)
 values(head.identity_id,head.appointment_id,head.current_revision+1,decision,case when p_outcome='accepted'then'exempt'else'own_cancel'end,
  case when p_outcome='rejected'then cancel_row.cancelled_at else null end,case when p_outcome='rejected'then'resolved'else'none'end,
  case when p_outcome='accepted'then'cancellation_exception_accepted'else'cancellation_exception_rejected'end,'operator');
 update private.safety_appointment_results set current_revision=head.current_revision+1 where identity_id=head.identity_id and appointment_id=head.appointment_id;
 update private.safety_appeals set state=p_outcome,resolved_at=clock_timestamp()where id=appeal_row.id;
 plan:=private.reconcile_cancellation_chain(head.identity_id,actor);
 perform private.finish_cancellation_due(head.identity_id,plan);
 update private.member_reports set status='reviewing',review_version=review_version+1,updated_at=clock_timestamp()where id=report_row.id;
 result:=jsonb_build_object('reportId',report_row.id,'appealId',appeal_row.id,'decisionId',decision,'reportVersion',p_expected_report_version+1,
  'resultRevision',head.current_revision+1,'appealState',p_outcome,'alreadyApplied',false);
 insert into private.appointment_cancel_resolutions values(decision,report_row.id,appeal_row.id,actor,p_client_request_id,fingerprint,p_mode,p_outcome,result,clock_timestamp());
 perform private.record_cancellation_notice(head.identity_id,head.source_episode_id,head.appointment_id,report_row.id,decision,p_outcome,plan,p_mode='correction');
 perform private.require_assigned_report_operator(report_row.id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 if exists(select 1 from private.member_reports where id=report_row.id and retention_due_at<=clock_timestamp())then raise exception 'report_unavailable'using errcode='PT404';end if;
 return result;
exception when lock_not_available or unique_violation then raise exception 'state_conflict'using errcode='40001';end;$$;

create function public.get_assigned_appointment_cancel_appeal_resolution_state(p_report_id uuid,p_appeal_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare actor uuid;report_row private.member_reports;appeal_row private.safety_appeals;head private.safety_appointment_results;revision bigint;result jsonb;begin
 if p_report_id is null or p_appeal_id is null then raise exception 'invalid_cancel_resolution'using errcode='22023';end if;
 actor:=private.require_assigned_report_operator(p_report_id);
 select *into report_row from private.member_reports where id=p_report_id and(retention_due_at is null or retention_due_at>clock_timestamp())for share;
 if not found then raise exception 'report_unavailable'using errcode='PT404';end if;
 select *into appeal_row from private.safety_appeals where id=p_appeal_id and report_id=p_report_id and kind='cancellation'for share;
 if not found then raise exception 'appeal_unavailable'using errcode='PT404';end if;
 select *into head from private.safety_appointment_results where identity_id=appeal_row.identity_id and appointment_id=appeal_row.appointment_id;
 if not found or head.current_revision not between 1 and 9007199254740991 or report_row.review_version not between 1 and 9007199254740991 then raise exception 'cancel_resolution_state_unavailable'using errcode='55000';end if;
 select coalesce(max(i.current_revision),0)into revision from private.cancellation_chain_effects m join private.safety_incidents i on i.id=m.incident_id
  where m.identity_id=head.identity_id and m.anchor_appointment_id=head.appointment_id;
 if revision not between 0 and 9007199254740991 then raise exception 'cancel_resolution_state_unavailable'using errcode='55000';end if;
 result:=jsonb_build_object('reportId',report_row.id,'appealId',appeal_row.id,'reportVersion',report_row.review_version,'resultRevision',head.current_revision,'incidentRevision',revision,'appealState',appeal_row.state);
 perform private.require_assigned_report_operator(p_report_id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 if exists(select 1 from private.member_reports where id=p_report_id and retention_due_at<=clock_timestamp())then raise exception 'report_unavailable'using errcode='PT404';end if;
 return result;
end;$$;

-- 운영 연결 준비 여부는 기존 global lease나 정책기간을 변경하지 않는다. 기본 false/ACL 폐쇄다.
create table private.cancellation_due_control(
 singleton boolean primary key default true check(singleton),enabled boolean not null default false);
insert into private.cancellation_due_control(singleton,enabled)values(true,false);

-- 기존 review_summary 검증식을 그대로 보존하고 DB kind/payload의 두 CHECK만 좁게 확장한다.
do $$declare old_payload text;old_kind text;begin
 select pg_get_expr(conbin,conrelid)into strict old_kind from pg_constraint where conrelid='private.worker_jobs'::regclass and conname='worker_jobs_kind_check';
 select pg_get_expr(conbin,conrelid)into strict old_payload from pg_constraint where conrelid='private.worker_jobs'::regclass and conname='worker_jobs_payload_check';
 if regexp_replace(old_kind,'\s','','g')<>'(kind=''review_summary''::text)'then raise exception 'cancellation_worker_kind_source_changed'using errcode='55000';end if;
 alter table private.worker_jobs drop constraint worker_jobs_kind_check;
 alter table private.worker_jobs add constraint worker_jobs_kind_check check(kind in('review_summary','cancellation_safety'));
 alter table private.worker_jobs drop constraint worker_jobs_payload_check;
 execute format('alter table private.worker_jobs add constraint worker_jobs_payload_check check(case when kind=''review_summary'' then (%s) when kind=''cancellation_safety'' then coalesce(jsonb_typeof(payload)=''object'' and payload ?& array[''identityId'',''generation''] and payload-array[''identityId'',''generation'']=''{}''::jsonb and jsonb_typeof(payload->''identityId'')=''string'' and (payload->>''identityId'')~''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'' and case when jsonb_typeof(payload->''generation'')=''number'' and (payload->>''generation'')~''^[1-9][0-9]{0,15}$'' then (payload->>''generation'')::numeric<=9007199254740991 else false end,false)else false end)',old_payload);
end;$$;
create function public.enqueue_cancellation_safety_due(p_limit integer,p_worker_run_token uuid)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare due_row private.cancellation_safety_due;enqueued integer:=0;begin
 if auth.role()is distinct from'service_role'then raise exception 'worker_access_denied'using errcode='42501';end if;
 if not(select enabled from private.cancellation_due_control where singleton)then raise exception 'cancellation_due_not_enabled'using errcode='55000';end if;
 if p_limit is null or p_limit not between 1 and 20 or p_worker_run_token is null then raise exception 'invalid_cancellation_due'using errcode='22023';end if;
 perform private.assert_current_worker_run(p_worker_run_token);
 for due_row in select *from private.cancellation_safety_due where next_due_at<=clock_timestamp()order by next_due_at,identity_id limit p_limit for update skip locked loop
  insert into private.worker_jobs(kind,dedupe_key,payload,available_at)values('cancellation_safety','cancellation_safety:'||due_row.identity_id::text||':'||due_row.generation::text,
   jsonb_build_object('identityId',due_row.identity_id,'generation',due_row.generation),due_row.next_due_at)on conflict(kind,dedupe_key)do nothing;
  if found then enqueued:=enqueued+1;end if;
 end loop;
 perform private.assert_current_worker_run(p_worker_run_token);
 return jsonb_build_object('enqueued',enqueued);
end;$$;

create function public.process_cancellation_safety_due(p_identity_id uuid,p_expected_generation bigint,p_job_id uuid,p_job_lease_token uuid,p_worker_run_token uuid)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare queue_row private.cancellation_safety_due;job_row private.worker_jobs;plan jsonb;result jsonb;begin
 if auth.role()is distinct from'service_role'then raise exception 'worker_access_denied'using errcode='42501';end if;
 if not(select enabled from private.cancellation_due_control where singleton)then raise exception 'cancellation_due_not_enabled'using errcode='55000';end if;
 if p_identity_id is null or p_job_id is null or p_job_lease_token is null or p_worker_run_token is null or p_expected_generation is null or p_expected_generation not between 1 and 9007199254740991 then
  raise exception 'invalid_cancellation_due'using errcode='22023';end if;
 perform private.assert_current_worker_job(p_job_id,p_job_lease_token,p_worker_run_token);
 select *into job_row from private.worker_jobs where id=p_job_id for update nowait;
 if not found or job_row.kind<>'cancellation_safety'or job_row.payload is distinct from jsonb_build_object('identityId',p_identity_id,'generation',p_expected_generation)then raise exception 'state_conflict'using errcode='40001';end if;
 perform private.lock_cancellation_identity(p_identity_id);
 select *into queue_row from private.cancellation_safety_due where identity_id=p_identity_id for update nowait;
 if not found or queue_row.generation<>p_expected_generation then raise exception 'state_conflict'using errcode='40001';end if;
 if queue_row.next_due_at is null or queue_row.next_due_at>clock_timestamp()then
  result:=jsonb_build_object('status','not_due','generation',queue_row.generation,'changed',false);
 else
  -- actor_reference는 검증된 global token이다. 직원/신고자 identity로 가장하지 않는다.
  plan:=private.reconcile_cancellation_chain(p_identity_id,p_worker_run_token);
  perform private.finish_cancellation_due(p_identity_id,plan);
  result:=jsonb_build_object('status',case when plan->>'policyPending'is not null then'policy_pending'when plan->>'status'='held'then'held'else'applied'end,
   'generation',queue_row.generation,'changed',(plan->>'changed')::boolean);
 end if;
 -- lock/trigger/효과 처리 중 DB 마감이 지났으면 전체 TX를 되돌린다. 토큰 연장/새점유는 없다.
 perform private.assert_current_worker_job(p_job_id,p_job_lease_token,p_worker_run_token);
 return result;
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;

-- 기존 원결과가 있는 identity만 재계산 대상으로 등록한다. unknown 순서는 processor가 보류한다.
insert into private.cancellation_safety_due(identity_id,next_due_at)
 select distinct identity_id,clock_timestamp()from private.safety_appointment_results;

create function private.cancellation_notice_dto(p_notice private.member_cancellation_notices)
returns jsonb language sql stable security definer set search_path=''as $$
 select jsonb_build_object('noticeId',p_notice.id,'appointmentId',p_notice.appointment_id,'appealState',p_notice.appeal_state,
 'planState',p_notice.plan_state,'eligibleCount',p_notice.eligible_count,'provisionalCount',p_notice.provisional_count,
 'hasCancellationWarning',p_notice.has_cancellation_warning,'restrictedUntil',p_notice.restricted_until,
 'availableAt',p_notice.available_at,'firstReadAt',p_notice.first_read_at);
$$;
-- report 없는 자동 상세는 정확한 목적종료/파기 연결이 없으므로 member 조회/ACK를 열지 않는다.
-- report 연결 상세는 기존 report90d에 함께 파기하며 batch 지연에도 현재 TTL을 검사한다.
create function private.cancellation_notice_available(p_notice_id uuid,p_episode uuid)
returns boolean language sql volatile security definer set search_path=''as $$
 select exists(select 1 from private.member_cancellation_notices n join private.member_reports r on r.id=n.report_id
 join private.member_episodes e on e.id=n.recipient_episode_id
 where n.id=p_notice_id and e.id=p_episode and e.ended_at is null and e.identity_id=n.recipient_identity_id
 and(r.retention_due_at is null or r.retention_due_at>clock_timestamp()));
$$;
create function public.list_my_cancellation_notices(p_limit integer default 20,p_before uuid default null)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare episode uuid:=private.require_member_decision_notice_episode();cursor_row private.member_cancellation_notices;result jsonb;item jsonb;begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_input'using errcode='22023';end if;
 if p_before is not null then
  if not private.cancellation_notice_available(p_before,episode)then raise exception 'notice_unavailable'using errcode='PT404';end if;
  select *into cursor_row from private.member_cancellation_notices where id=p_before;
 end if;
 with selected as(select n.*from private.member_cancellation_notices n where private.cancellation_notice_available(n.id,episode)
  and(p_before is null or(n.available_at,n.id)<(cursor_row.available_at,cursor_row.id))order by n.available_at desc,n.id desc limit p_limit+1),
 shown as(select *from selected order by available_at desc,id desc limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(private.cancellation_notice_dto(shown::private.member_cancellation_notices)order by available_at desc,id desc)from shown),'[]'::jsonb),
  'nextCursor',case when(select count(*)from selected)>p_limit then(select id from shown order by available_at,id limit 1)else null end)into result;
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'notice_episode_conflict'using errcode='40001';end if;
 for item in select value from jsonb_array_elements(result->'items')loop
  if not private.cancellation_notice_available((item->>'noticeId')::uuid,episode)then raise exception 'notice_unavailable'using errcode='PT404';end if;
 end loop;
 if(p_before is not null and not private.cancellation_notice_available(p_before,episode))or
  (result->>'nextCursor'is not null and not private.cancellation_notice_available((result->>'nextCursor')::uuid,episode))then raise exception 'notice_unavailable'using errcode='PT404';end if;
 return result;
end;$$;
create function public.read_my_cancellation_notice(p_notice_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare episode uuid:=private.require_member_decision_notice_episode();notice_row private.member_cancellation_notices;report_key uuid;begin
 if p_notice_id is null then raise exception 'invalid_input'using errcode='22023';end if;
 if not private.cancellation_notice_available(p_notice_id,episode)then raise exception 'notice_unavailable'using errcode='PT404';end if;
 select report_id into report_key from private.member_cancellation_notices where id=p_notice_id;
 perform 1 from private.member_reports where id=report_key for share;
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'notice_episode_conflict'using errcode='40001';end if;
 if not private.cancellation_notice_available(p_notice_id,episode)then raise exception 'notice_unavailable'using errcode='PT404';end if;
 select *into notice_row from private.member_cancellation_notices where id=p_notice_id and recipient_episode_id=episode for update;
 if not found then raise exception 'notice_unavailable'using errcode='PT404';end if;
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'notice_episode_conflict'using errcode='40001';end if;
 if not private.cancellation_notice_available(p_notice_id,episode)then raise exception 'notice_unavailable'using errcode='PT404';end if;
 update private.member_cancellation_notices set first_read_at=coalesce(first_read_at,clock_timestamp())where id=p_notice_id returning *into notice_row;
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'notice_episode_conflict'using errcode='40001';end if;
 if not private.cancellation_notice_available(p_notice_id,episode)then raise exception 'notice_unavailable'using errcode='PT404';end if;
 return private.cancellation_notice_dto(notice_row);
end;$$;

-- 신규 실체만 폐쇄한다. 기존 함수/역할/스키마/테이블 권한은 확대하지 않는다.
do $$declare owner_name text;function_row record;table_name text;gateway text;begin
 select pg_get_userbyid(proowner)into strict owner_name from cancel_resolution_function_baseline
 where oid='private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)'::regprocedure;
 foreach table_name in array array['cancellation_effect_suspensions','cancellation_chain_effects','cancellation_safety_due','cancellation_due_control','appointment_cancel_resolutions','member_cancellation_notices']loop
  execute format('alter table private.%I owner to %I',table_name,owner_name);
  execute format('alter table private.%I enable row level security',table_name);
  execute format('revoke all on table private.%I from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',table_name);
 end loop;
 for function_row in select oid::regprocedure signature from pg_proc where oid=any(array[
  'private.raw_cancellation_subject(uuid,uuid)'::regprocedure,'private.cancellation_review_blocks(uuid,uuid)'::regprocedure,
  'private.suspend_cancellation_suffix(uuid)'::regprocedure,'private.restore_cancellation_suffix(uuid,jsonb)'::regprocedure,
  'private.cancellation_review_suspension_changed()'::regprocedure,'private.protect_active_cancellation_suspension()'::regprocedure,
  'private.current_cancellation_sanction_plan(uuid)'::regprocedure,'private.lock_cancellation_identity(uuid)'::regprocedure,
  'private.reconcile_cancellation_chain(uuid,uuid)'::regprocedure,'private.cancellation_due_changed()'::regprocedure,
  'private.finish_cancellation_due(uuid,jsonb)'::regprocedure,'private.record_cancellation_notice(uuid,uuid,uuid,uuid,uuid,text,jsonb,boolean)'::regprocedure,
  'private.cancellation_notice_dto(private.member_cancellation_notices)'::regprocedure,'private.cancellation_notice_available(uuid,uuid)'::regprocedure,
  'public.resolve_assigned_appointment_cancel_appeal(uuid,uuid,uuid,text,bigint,bigint,bigint,text)'::regprocedure,
  'public.get_assigned_appointment_cancel_appeal_resolution_state(uuid,uuid)'::regprocedure,
  'public.process_cancellation_safety_due(uuid,bigint,uuid,uuid,uuid)'::regprocedure,'public.enqueue_cancellation_safety_due(integer,uuid)'::regprocedure,
  'public.list_my_cancellation_notices(integer,uuid)'::regprocedure,'public.read_my_cancellation_notice(uuid)'::regprocedure])loop
  execute format('alter function %s owner to %I',function_row.signature,owner_name);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',function_row.signature);
 end loop;
 -- staff guard는 공개 RPC 안에서 사용하며 owner 판정 helper는 계속 폐쇄한다.
 grant execute on function public.resolve_assigned_appointment_cancel_appeal(uuid,uuid,uuid,text,bigint,bigint,bigint,text),
  public.get_assigned_appointment_cancel_appeal_resolution_state(uuid,uuid),public.list_my_cancellation_notices(integer,uuid),public.read_my_cancellation_notice(uuid)to authenticated;
 if exists(select 1 from cancellation_effective_baseline old_function left join pg_proc current_function on current_function.oid=old_function.oid
  where current_function.oid is null or current_function.proowner is distinct from old_function.proowner
  or current_function.proacl::text is distinct from old_function.acl or current_function.proconfig::text is distinct from old_function.config)then
  raise exception 'cancellation_effective_metadata_changed'using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.effective_safety_subjects(uuid)'::regprocedure and prosrc=$effective_expected$
 with effective as(select distinct on(r.incident_id)r.* from private.safety_incident_revisions r
 where r.state<>'reviewing'order by r.incident_id,r.revision desc)
 select r.incident_id,r.revision,s.source_episode_id,s.confirmed_kinds,s.violation_class,s.violation_type,s.victim_identity_id,s.cancellation_action,
 (select min(h.decided_at)from private.safety_incident_revisions h join private.safety_incident_subjects hs on hs.incident_id=h.incident_id and hs.revision=h.revision
   where h.incident_id=r.incident_id and h.state='confirmed'and hs.identity_id=s.identity_id)
 from effective r join private.safety_incident_subjects s on s.incident_id=r.incident_id and s.revision=r.revision
 where r.state='confirmed'and s.identity_id=p_identity_id
 and not(s.violation_class='cancellation'and exists(select 1 from private.cancellation_effect_suspensions lineage
  where lineage.identity_id=s.identity_id and lineage.incident_id=r.incident_id and lineage.state='active'));
$effective_expected$)then
  raise exception 'cancellation_effective_body_changed'using errcode='55000';end if;
 if exists(select 1 from cancel_resolution_function_baseline old_function left join pg_proc current_function on current_function.oid=old_function.oid
  where current_function.oid is null or current_function.proowner is distinct from old_function.proowner
  or current_function.proacl::text is distinct from old_function.acl or current_function.proconfig::text is distinct from old_function.config
  or current_function.prosrc is distinct from old_function.prosrc)then raise exception 'existing_cancellation_function_changed'using errcode='55000';end if;
end;$$;
commit;
