-- 최신 SQL109 합성 DB 계약: 제한 역할, 영속 배정, 최초 dispatch CAS,
-- 실제 idle claim 증거와 같은 원 requestId 완료 조회. 외부 모델/HTTP 없음.
begin;
set local plpgsql.check_asserts=on;
do $$begin
 assert not exists(select 1 from private.worker_jobs);
 assert not exists(select 1 from private.worker_invocations);
 assert (select not enabled from private.worker_invocation_control where singleton);
 assert (select not enabled from private.worker_runtime_atomic_control where singleton);
 assert not has_function_privilege('service_role','public.prepare_queue_invocation(uuid,uuid,text,integer,integer)','EXECUTE');
 assert not has_function_privilege('service_role','public.mark_review_summary_insufficient(uuid,uuid,text,uuid,text)','EXECUTE');
 assert not has_function_privilege('service_role','public.publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text,uuid,text)','EXECUTE');
end;$$;
create role ym_summary_invocation_synthetic login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant ym_summary_invocation_synthetic to postgres with admin false, inherit false, set true;
grant usage on schema public to ym_summary_invocation_synthetic;
grant execute on function public.acquire_worker_run(integer,uuid),
 public.prepare_queue_invocation(uuid,uuid,text,integer,integer),
 public.claim_queue_invocation_dispatch(uuid,uuid,text,integer,integer),
 public.get_queue_invocation(uuid),public.complete_queue_invocation(uuid),
 public.claim_supported_job(uuid,integer,uuid,text[])
 to ym_summary_invocation_synthetic;
update private.worker_runtime_atomic_control set enabled=true where singleton;
update private.worker_invocation_control set enabled=true where singleton;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role ym_summary_invocation_synthetic;
do $$declare req uuid:=gen_random_uuid();run uuid;v jsonb;finished jsonb;code text;begin
 assert current_user='ym_summary_invocation_synthetic';
 assert not has_schema_privilege(current_user,'private','USAGE');
 assert not has_table_privilege(current_user,'private.worker_invocations','SELECT');
 assert not pg_has_role(current_user,'service_role','USAGE');
 assert not pg_has_role(current_user,'service_role','SET');
 assert not has_function_privilege(current_user,'public.publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text,uuid,text)','EXECUTE');
 run:=(public.acquire_worker_run(180,null)->>'token')::uuid;
 assert run is not null;
 v:=public.prepare_queue_invocation(req,run,'review_summary',1,180000);
 assert v->>'state'='prepared' and v->>'fresh'='true';
 assert public.prepare_queue_invocation(req,run,'review_summary',1,180000)->>'fresh'='false';
 begin perform public.prepare_queue_invocation(req,run,'review_summary',2,180000);
 exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code='40001';code:=null;
 begin perform public.complete_queue_invocation(req);
 exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code='55000';
 assert public.claim_queue_invocation_dispatch(req,run,'review_summary',1,180000)->>'claimed'='true';
 assert public.claim_queue_invocation_dispatch(req,run,'review_summary',1,180000)->>'claimed'='false';
 assert public.claim_supported_job(gen_random_uuid(),180,run,array['review_summary'])='{"job":null}'::jsonb;
 finished:=public.complete_queue_invocation(req);
 assert finished->>'state'='completed';
 assert (finished->'result'->'counts'->>'claimed')::integer=0;
 assert public.get_queue_invocation(req)=finished;
 assert public.complete_queue_invocation(req)=finished;
end;$$;
reset role;
do $$begin
 assert (select count(*)=1 from private.worker_invocations where state='completed' and dispatch_started and claim_calls=1 and idle_seen);
 assert not exists(select 1 from private.worker_invocation_jobs);
 assert not exists(select 1 from private.worker_runtime_job_slots);
end;$$;
rollback;
do $$begin
 assert not exists(select 1 from pg_roles where rolname='ym_summary_invocation_synthetic');
 assert not exists(select 1 from private.worker_invocations);
 assert (select not enabled from private.worker_invocation_control where singleton);
 assert (select not enabled from private.worker_runtime_atomic_control where singleton);
 assert not has_function_privilege('service_role','public.prepare_queue_invocation(uuid,uuid,text,integer,integer)','EXECUTE');
end;$$;
select 'CURRENT_SUMMARY_INVOCATION:limited_role_durable_dispatch_idle_completion_rollback';
