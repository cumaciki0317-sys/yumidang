-- 민규: 완료 작업의 dedupe 키가 다음 취소 예약을 막지 않도록 새 기한의 세대를 증가시킨다.
-- 기존 적용 원본·24시간 정책·권한은 보존한다. 세대 상한 초과는 기존 CHECK로 전체 트랜잭션을 거절한다.
begin;
create temp table cancellation_next_due_baseline on commit drop as
 select oid,proowner,proacl::text acl,proconfig::text config,prosrc from pg_proc
 where oid='private.finish_cancellation_due(uuid,jsonb)'::regprocedure;
do $$begin
 if (select enabled from private.cancellation_due_control where singleton)is distinct from false then
 raise exception 'cancellation_next_due_requires_closed_control'using errcode='55000';end if;
 if has_function_privilege('service_role','public.process_cancellation_safety_due(uuid,bigint,uuid,uuid,uuid)','EXECUTE')then
 raise exception 'cancellation_next_due_requires_closed_execute'using errcode='55000';end if;
end;$$;
do $patch$declare expected text:=$expected$
declare next_due timestamptz;pending_code text:=p_plan->>'policyPending';begin
 if pending_code is null and p_plan->>'status'='held'then
  select r.cancellation_at+interval'24 hours'into next_due from private.safety_appointment_results h
  join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
  where h.identity_id=p_identity_id and h.appointment_id=(p_plan->>'heldAppointmentId')::uuid and r.outcome='own_cancel'and r.appeal_state='none'
   and r.cancellation_at+interval'24 hours'>clock_timestamp();end if;
 update private.cancellation_safety_due set next_due_at=next_due,policy_pending_code=pending_code,updated_at=clock_timestamp()where identity_id=p_identity_id;
end;$expected$;definition text;current_body text;begin
 select prosrc,pg_get_functiondef(oid)into strict current_body,definition from pg_proc
 where oid='private.finish_cancellation_due(uuid,jsonb)'::regprocedure;
 if current_body is distinct from expected then raise exception 'cancellation_next_due_source_changed'using errcode='55000';end if;
 execute replace(definition,current_body,replace(current_body,$old$ update private.cancellation_safety_due set next_due_at=next_due,policy_pending_code=pending_code,updated_at=clock_timestamp()where identity_id=p_identity_id;$old$,$new$ -- 새로 예약한 기한만 새 점유 세대를 사용한다. 같은 기한 재처리와 기한 제거는 원 세대를 유지한다.
 update private.cancellation_safety_due set
 generation=case when next_due is not null and next_due_at is distinct from next_due then generation+1 else generation end,
 next_due_at=next_due,policy_pending_code=pending_code,updated_at=clock_timestamp()where identity_id=p_identity_id;$new$));
end;$patch$;
do $$begin
 if exists(select 1 from cancellation_next_due_baseline b join pg_proc p on p.oid=b.oid
 where p.proowner is distinct from b.proowner or p.proacl::text is distinct from b.acl or p.proconfig::text is distinct from b.config)then
 raise exception 'cancellation_next_due_metadata_changed'using errcode='55000';end if;
end;$$;
commit;
