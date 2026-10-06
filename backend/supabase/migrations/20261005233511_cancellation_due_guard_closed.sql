-- 민규: 취소 due 실행 제어 행 부재도 거절한다. 기존78 원본·정책·권한은 변경하지 않는다.
begin;
create temp table cancel_guard_baseline on commit drop as
select oid,proowner,proacl::text acl,proconfig::text config,prosrc from pg_proc where oid in(
'public.enqueue_cancellation_safety_due(integer,uuid)'::regprocedure,
'public.process_cancellation_safety_due(uuid,bigint,uuid,uuid,uuid)'::regprocedure);
do $$declare enabled boolean;begin
 select c.enabled into enabled from private.cancellation_due_control c where c.singleton for share;
 if enabled is distinct from false then raise exception 'cancel_guard_update_requires_closed_control'using errcode='55000';end if;
 if exists(select 1 from cancel_guard_baseline b where has_function_privilege('service_role',b.oid,'EXECUTE'))then
  raise exception 'cancel_guard_update_requires_closed_execute'using errcode='55000';end if;
end;$$;
do $patch$declare body text;definition text;expected text:=$cancel_expected$
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
end;$cancel_expected$;begin
 select p.prosrc,pg_get_functiondef(p.oid)into strict body,definition from pg_proc p where p.oid='public.enqueue_cancellation_safety_due(integer,uuid)'::regprocedure;
 if body is distinct from expected then raise exception 'cancel_guard_source_changed'using errcode='55000';end if;
 execute replace(definition,body,replace(body,'if not(select enabled from private.cancellation_due_control where singleton)then','if (select enabled from private.cancellation_due_control where singleton)is distinct from true then'));
end;$patch$;
do $patch$declare body text;definition text;expected text:=$cancel_expected$
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
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$cancel_expected$;begin
 select p.prosrc,pg_get_functiondef(p.oid)into strict body,definition from pg_proc p where p.oid='public.process_cancellation_safety_due(uuid,bigint,uuid,uuid,uuid)'::regprocedure;
 if body is distinct from expected then raise exception 'cancel_guard_source_changed'using errcode='55000';end if;
 execute replace(definition,body,replace(body,'if not(select enabled from private.cancellation_due_control where singleton)then','if (select enabled from private.cancellation_due_control where singleton)is distinct from true then'));
end;$patch$;
do $$begin
 if exists(select 1 from cancel_guard_baseline b left join pg_proc p on p.oid=b.oid where p.oid is null or p.proowner<>b.proowner
 or p.proacl::text is distinct from b.acl or p.proconfig::text is distinct from b.config
 or p.prosrc is distinct from replace(b.prosrc,'if not(select enabled from private.cancellation_due_control where singleton)then','if (select enabled from private.cancellation_due_control where singleton)is distinct from true then'))then
 raise exception 'cancel_guard_metadata_changed'using errcode='55000';end if;
end;$$;
commit;
