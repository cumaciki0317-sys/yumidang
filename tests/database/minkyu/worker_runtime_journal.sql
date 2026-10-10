begin;
create function pg_temp.reject(query text,expected text)returns void language plpgsql as $$
declare code text;begin begin execute query;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('unexpected_state:%s',code);end;$$;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select pg_temp.reject('select public.prepare_worker_runtime_intent(''ab101000-0000-4000-8000-000000000001'',''cycle'',''ab101000-0000-4000-8000-000000000002'',''{}'')','55000');
update private.worker_runtime_journal_control set enabled=true where singleton;
update private.global_worker_run set token='ab101000-0000-4000-8000-000000000002',expires_at=clock_timestamp()+interval'180 seconds'where singleton;
do $$declare a jsonb;b jsonb;begin
 a:=public.prepare_worker_runtime_intent('ab101000-0000-4000-8000-000000000001','cycle','ab101000-0000-4000-8000-000000000002','{"kind":"report_retention"}');
 b:=public.prepare_worker_runtime_intent('ab101000-0000-4000-8000-000000000001','cycle','ab101000-0000-4000-8000-000000000002','{"kind":"report_retention"}');assert a=b;
 perform pg_temp.reject('select public.prepare_worker_runtime_intent(''ab101000-0000-4000-8000-000000000001'',''cycle'',''ab101000-0000-4000-8000-000000000002'',''{"kind":"review_summary"}'')','40001');
 perform pg_temp.reject('select public.prepare_worker_runtime_intent(''ab101000-0000-4000-8000-000000000003'',''cycle'',''ab101000-0000-4000-8000-000000000002'',''{"rawText":"forbidden"}'')','22023');
 assert public.read_worker_runtime_pending()->>'hasPending'='true';
 assert public.observe_worker_runtime_intent('ab101000-0000-4000-8000-000000000001',false)->>'state'='unknown';
 perform pg_temp.reject('select public.observe_worker_runtime_intent(''ab101000-0000-4000-8000-000000000001'',true)','40001');
 perform pg_temp.reject('select public.observe_worker_runtime_intent(null,false)','22023');
 assert public.read_worker_runtime_pending()->>'hasPending'='true';
 assert(select count(*)=1 from private.worker_runtime_intents where request_id='ab101000-0000-4000-8000-000000000001');
 assert not has_table_privilege('service_role','private.worker_runtime_intents','SELECT');
 assert not has_function_privilege('authenticated','public.prepare_worker_runtime_intent(uuid,text,uuid,jsonb,uuid)','EXECUTE');
 assert not has_function_privilege('service_role','public.prepare_worker_runtime_intent(uuid,text,uuid,jsonb,uuid)','EXECUTE');
end;$$;
select set_config('request.jwt.claims','{"role":"authenticated"}',true);
select pg_temp.reject('select public.read_worker_runtime_pending()','42501');
rollback;
