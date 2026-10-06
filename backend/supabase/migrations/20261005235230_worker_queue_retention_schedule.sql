-- 민규: source82 이후 큐 예약 후보. 실제 DB·J·Provider 실행은 아직 하지 않는다.
begin;
create temp table schedule83_baseline on commit drop as select oid,proowner,proacl::text acl,proconfig::text config,prosrc
 from pg_proc where oid in('public.read_worker_queue_schedule(text[],text)'::regprocedure,
 'public.read_worker_run_budget(uuid)'::regprocedure,'private.notify_worker_queue_changed()'::regprocedure,
 'private.supported_worker_kind_ready(text)'::regprocedure,'private.report_purge_eligible(uuid)'::regprocedure);
do $$declare own oid;owner_name text;r text;t regclass;sig regprocedure;begin
 select proowner,pg_get_userbyid(proowner)into strict own,owner_name from schedule83_baseline where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 if not exists(select 1 from pg_roles where oid=own and(rolsuper or rolbypassrls))or
 exists(select 1 from schedule83_baseline where proowner<>own)then raise exception 'schedule83_owner_incompatible'using errcode='55000';end if;
 foreach r in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
  if pg_has_role(r,own,'USAGE')or pg_has_role(r,own,'SET')then raise exception 'schedule83_owner_incompatible'using errcode='55000';end if;
 end loop;
 foreach r in array array['private','public','auth']loop
  if not has_schema_privilege(owner_name,r,'USAGE')then raise exception 'schedule83_owner_permissions'using errcode='55000';end if;
 end loop;
 foreach sig in array array['auth.role()'::regprocedure,'private.supported_worker_kind_ready(text)'::regprocedure,
 'private.report_purge_eligible(uuid)'::regprocedure]loop
  if not has_function_privilege(owner_name,sig,'EXECUTE')then raise exception 'schedule83_owner_permissions'using errcode='55000';end if;
 end loop;
 foreach t in array array['private.worker_jobs'::regclass,'private.global_worker_run'::regclass,'private.member_cleanup_tasks'::regclass,
 'private.member_retirements'::regclass,'private.member_cleanup_guard'::regclass,'private.cancellation_safety_due'::regclass,
 'private.cancellation_due_control'::regclass,'private.report_purge_control'::regclass,'private.member_reports'::regclass,
 'private.report_purge_closures'::regclass,'private.report_purge_tasks'::regclass,'private.report_purge_dispatches'::regclass,
 'private.report_purge_delete_acks'::regclass,'private.safety_appeals'::regclass,'private.appointment_review_holds'::regclass,
 'private.safety_incident_report_links'::regclass,'private.safety_incidents'::regclass,'private.safety_incident_revisions'::regclass,
 'private.safety_sanction_applications'::regclass]loop
  if not has_table_privilege(owner_name,t,'SELECT')then raise exception 'schedule83_owner_permissions'using errcode='55000';end if;
 end loop;
 if not has_table_privilege(owner_name,'private.cancellation_due_control','UPDATE')or
 not has_table_privilege(owner_name,'private.report_purge_control','UPDATE')then raise exception 'schedule83_owner_permissions'using errcode='55000';end if;
end;$$;
do $patch$declare body text;definition text;expected text:=$old_schedule$
declare n timestamptz:=clock_timestamp();v_due timestamptz;k text;held_until timestamptz;rotation integer;cleanup_ready boolean;
begin
 if auth.role() in('anon','authenticated')then raise exception 'worker_required'using errcode='42501';end if;
 if p_exclude_kinds is null or coalesce(array_ndims(p_exclude_kinds),1)<>1 or cardinality(p_exclude_kinds)>3
  or exists(select 1 from unnest(p_exclude_kinds)x where x is null or x not in('review_summary','event_sync','member_cleanup'))
  or(p_after_kind is not null and p_after_kind not in('review_summary','event_sync','member_cleanup'))then
  raise exception 'invalid_queue_schedule'using errcode='22023';end if;
 rotation:=case p_after_kind when 'review_summary'then 0 when 'event_sync'then 1 when 'member_cleanup'then 2 else -1 end;
 cleanup_ready:=coalesce((select external_deletion_approved from private.member_cleanup_guard where singleton),false)
  and has_function_privilege('service_role','public.claim_member_cleanup_task(uuid)','EXECUTE')
  and has_function_privilege('service_role','public.check_member_cleanup_task(uuid,uuid,uuid,uuid)','EXECUTE')
  and has_function_privilege('service_role','public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)','EXECUTE')
  and has_function_privilege('service_role','public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)','EXECUTE')
  and has_function_privilege('service_role','public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)','EXECUTE');
 -- 준비되지 않은 cleanup은 조회에서만 숨긴다. 기존 task/lease/state를 바꾸지 않는다.
 -- 실제 후보의 due만 읽는다. 조회가 claim/dispatch/성공한 것처럼 기록하지 않는다.
 with candidates as(
  select j.kind,case when j.status='running'then j.lease_expires_at else j.available_at end due
  from private.worker_jobs j where j.kind in('review_summary','event_sync')and j.status in('queued','retry_wait','running')
  union all
  select 'member_cleanup',case when t.state='pending'then n else t.lease_expires_at end
  from private.member_cleanup_tasks t join private.member_retirements r on r.withdrawal_id=t.withdrawal_id
   and r.profile_id=t.profile_id and r.state='pending_cleanup'
  where cleanup_ready and t.state in('pending','running')and(t.kind<>'auth_user'or not exists(select 1 from private.member_cleanup_tasks s
   where s.withdrawal_id=t.withdrawal_id and s.kind='storage_object'and s.state<>'completed'))
 ), kinds as(select kind,min(due)due from candidates where not(kind=any(p_exclude_kinds))group by kind),
 ordered as(select kind,due,case kind when 'review_summary'then 0 when 'event_sync'then 1 else 2 end ordinal from kinds)
 select kind,ordered.due into k,v_due from ordered
 order by case when ordered.due<=n then 0 else 1 end,
  case when ordered.due<=n and rotation>=0 then mod(ordinal-rotation+2,3)end,
  ordered.due,ordinal limit 1;
 select expires_at into held_until from private.global_worker_run where singleton and token is not null and expires_at>n;
 if v_due is not null and held_until is not null then v_due:=greatest(v_due,held_until);end if;
 return jsonb_build_object('serverNow',n,'nextDueAt',v_due,'nextKind',k);
end; $old_schedule$;replacement text:=$new_schedule$
declare n timestamptz:=clock_timestamp();v_due timestamptz;k text;held_until timestamptz;rotation integer;
 cleanup_ready boolean;cancel_ready boolean;report_ready boolean;
 all_kinds constant text[]:=array['review_summary','event_sync','member_cleanup','cancellation_safety','report_retention'];
begin
 if auth.role()in('anon','authenticated')then raise exception 'worker_required'using errcode='42501';end if;
 if p_exclude_kinds is null or coalesce(array_ndims(p_exclude_kinds),1)<>1 or cardinality(p_exclude_kinds)>5
  or exists(select 1 from unnest(p_exclude_kinds)x where x is null or not(x=any(all_kinds)))
  or(p_after_kind is not null and not(p_after_kind=any(all_kinds)))then
  raise exception 'invalid_queue_schedule'using errcode='22023';end if;
 rotation:=coalesce(array_position(all_kinds,p_after_kind)-1,-1);
 cleanup_ready:=coalesce((select external_deletion_approved from private.member_cleanup_guard where singleton),false)
  and has_function_privilege('service_role','public.claim_member_cleanup_task(uuid)','EXECUTE')
  and has_function_privilege('service_role','public.check_member_cleanup_task(uuid,uuid,uuid,uuid)','EXECUTE')
  and has_function_privilege('service_role','public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)','EXECUTE')
  and has_function_privilege('service_role','public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)','EXECUTE')
  and has_function_privilege('service_role','public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)','EXECUTE');
 cancel_ready:=private.supported_worker_kind_ready('cancellation_safety');
 report_ready:=private.supported_worker_kind_ready('report_retention');
 with candidates as(
  select j.kind,case when j.status='running'then j.lease_expires_at else j.available_at end due
  from private.worker_jobs j where j.kind in('review_summary','event_sync')and j.status in('queued','retry_wait','running')
  union all
  select 'member_cleanup',case when t.state='pending'then n else t.lease_expires_at end
  from private.member_cleanup_tasks t join private.member_retirements r on r.withdrawal_id=t.withdrawal_id
   and r.profile_id=t.profile_id and r.state='pending_cleanup'
  where cleanup_ready and t.state in('pending','running')and(t.kind<>'auth_user'or not exists(select 1 from private.member_cleanup_tasks s
   where s.withdrawal_id=t.withdrawal_id and s.kind='storage_object'and s.state<>'completed'))
  union all
  select j.kind,case when j.status='running'then j.lease_expires_at else j.available_at end
  from private.worker_jobs j where cancel_ready and j.kind='cancellation_safety'and j.status in('queued','retry_wait','running')
  union all
  select 'cancellation_safety',d.next_due_at from private.cancellation_safety_due d
  where cancel_ready and d.next_due_at is not null and not exists(select 1 from private.worker_jobs j
   where j.kind='cancellation_safety'and j.payload=jsonb_build_object('identityId',d.identity_id,'generation',d.generation)
    )
  union all
  select j.kind,case when j.status='running'then j.lease_expires_at else j.available_at end
  from private.worker_jobs j join private.report_purge_closures c on j.payload=jsonb_build_object('reportId',c.report_id,'closureProofId',c.id)
  where report_ready and j.kind='report_retention'and j.status in('queued','retry_wait','running')
   and private.report_purge_eligible(c.report_id)
   and not exists(select 1 from private.report_purge_tasks t join private.report_purge_dispatches d on d.task_id=t.id
    where t.closure_id=c.id and t.state<>'completed'and not exists(select 1 from private.report_purge_delete_acks a
     where a.task_id=d.task_id and a.asset_id=d.asset_id and a.object_id=d.object_id))
  union all
  select 'report_retention',r.retention_due_at from private.member_reports r where report_ready and r.status='resolved'and r.final_closed_at is not null
  and isfinite(r.final_closed_at)and r.retention_due_at=r.final_closed_at+interval '2160 hours'
  and r.review_version between 1 and 9007199254740991 and not r.hide_target
  and not exists(select 1 from private.appointment_review_holds h where h.report_id=r.id and h.state='reviewing')
  and not exists(select 1 from private.safety_appeals a where a.report_id=r.id and a.state='reviewing')
  and not exists(select 1 from private.safety_incident_report_links l join private.safety_sanction_applications s on s.incident_id=l.incident_id where l.report_id=r.id)
  and not exists(select 1 from private.safety_incident_report_links l join private.safety_incidents i on i.id=l.incident_id
   join private.safety_incident_revisions v on v.incident_id=i.id and v.revision=i.current_revision where l.report_id=r.id and v.state='reviewing')
   and not exists(select 1 from private.report_purge_closures c where c.report_id=r.id)
 ), kinds as(select kind,min(due)due from candidates where due is not null and isfinite(due)and not(kind=any(p_exclude_kinds))group by kind),
 ordered as(select kind,due,array_position(all_kinds,kind)-1 ordinal from kinds)
 select kind,ordered.due into k,v_due from ordered
 order by case when ordered.due<=n then 0 else 1 end,
  case when ordered.due<=n and rotation>=0 then mod(ordinal-rotation+4,5)end,
  ordered.due,ordinal limit 1;
 select expires_at into held_until from private.global_worker_run where singleton and token is not null and expires_at>n;
 if v_due is not null and held_until is not null then v_due:=greatest(v_due,held_until);end if;
 return jsonb_build_object('serverNow',n,'nextDueAt',v_due,'nextKind',k);
end;$new_schedule$;purpose text:=$report_purpose$
 select exists(select 1 from private.member_reports r where r.id=p_report_id and r.status='resolved'and r.final_closed_at is not null
  and isfinite(r.final_closed_at)and r.retention_due_at=r.final_closed_at+interval '2160 hours'and r.retention_due_at<=clock_timestamp()
  and r.review_version between 1 and 9007199254740991 and not r.hide_target
  and not exists(select 1 from private.appointment_review_holds h where h.report_id=r.id and h.state='reviewing')
  and not exists(select 1 from private.safety_appeals a where a.report_id=r.id and a.state='reviewing')
  and not exists(select 1 from private.safety_incident_report_links l join private.safety_sanction_applications s on s.incident_id=l.incident_id where l.report_id=r.id)
  and not exists(select 1 from private.safety_incident_report_links l join private.safety_incidents i on i.id=l.incident_id
   join private.safety_incident_revisions v on v.incident_id=i.id and v.revision=i.current_revision where l.report_id=r.id and v.state='reviewing'));
$report_purpose$;begin
 select prosrc,pg_get_functiondef(oid)into strict body,definition from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 if body is distinct from expected or (select prosrc from pg_proc where oid='private.report_purge_eligible(uuid)'::regprocedure)is distinct from purpose then raise exception 'schedule83_source_changed'using errcode='55000';end if;
 execute replace(definition,body,replacement);
end;$patch$;
-- COMMIT 이후 빈 wake만 발생한다. terminal은 새 job/dispatch 종류로 가장하지 않는다.
create trigger worker_queue_retention_due after insert or update or delete on private.cancellation_safety_due for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_retention_cancel_control after insert or update or delete on private.cancellation_due_control for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_retention_report_control after insert or update or delete on private.report_purge_control for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_retention_reports after insert or update or delete on private.member_reports for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_retention_captures after insert or update or delete on private.report_capture_assets for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_retention_report_tasks after insert or update or delete on private.report_purge_tasks for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_retention_dispatch after insert or update or delete on private.report_purge_dispatches for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_retention_ack after insert or update or delete on private.report_purge_delete_acks for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_retention_terminal after insert or update or delete on private.report_purge_terminal_receipts for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_retention_appeals after insert or update or delete on private.safety_appeals for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_retention_holds after insert or update or delete on private.appointment_review_holds for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_retention_links after insert or update or delete on private.safety_incident_report_links for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_retention_incidents after insert or update or delete on private.safety_incidents for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_retention_revisions after insert or update or delete on private.safety_incident_revisions for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_retention_applications after insert or update or delete on private.safety_sanction_applications for each statement execute function private.notify_worker_queue_changed();
do $$begin
 if exists(select 1 from schedule83_baseline b left join pg_proc p on p.oid=b.oid where p.oid is null or p.proowner<>b.proowner
  or p.proacl::text is distinct from b.acl or p.proconfig::text is distinct from b.config
  or(b.oid<>'public.read_worker_queue_schedule(text[],text)'::regprocedure and p.prosrc is distinct from b.prosrc))then
  raise exception 'schedule83_metadata_changed'using errcode='55000';end if;
end;$$;
-- 권한/승인/기한/점유를 열거나 변경하지 않는다. ACL 변경 뒤 wake는 coordinator의 별도 빈 NOTIFY가 필요하다.
commit;
