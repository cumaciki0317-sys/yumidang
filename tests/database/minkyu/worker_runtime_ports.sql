-- 전용 TLS scratch SQL100에서만 실행. 기존 행 변경은 모두 rollback.
begin;
create function pg_temp.reject(query text,expected text)returns void language plpgsql as $$
declare code text;begin
 begin execute query;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('unexpected_state:%s',code);
end;$$;
create temp table runtime_before as select md5(prosrc)body,proacl::text acl from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
insert into private.worker_jobs(kind,dedupe_key,payload,available_at)
values('review_summary','runtime100:test','{"profileId":"ab100000-0000-4000-8000-000000000003","sourceRevision":"0","modelVersion":"synthetic","promptVersion":"synthetic"}',clock_timestamp()-interval'1 minute');
update private.global_worker_run set token='ab100000-0000-4000-8000-000000000001',expires_at=clock_timestamp()+interval'180 seconds'where singleton;
do $$declare old jsonb;owned jsonb;expiry timestamptz;begin
 select expires_at into expiry from private.global_worker_run where singleton;
 old:=public.read_worker_queue_schedule('{}',null);
 owned:=public.read_worker_owned_queue_schedule('ab100000-0000-4000-8000-000000000001','{}',null);
 assert(old->>'nextDueAt')::timestamptz>=expiry;
 assert(owned->>'nextDueAt')::timestamptz<expiry;
 assert(select md5(prosrc)=b.body and proacl::text=b.acl from pg_proc p cross join runtime_before b where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure);
 assert not has_function_privilege('anon','public.read_worker_owned_queue_schedule(uuid,text[],text)','EXECUTE');
 assert not has_function_privilege('authenticated','public.read_worker_owned_queue_schedule(uuid,text[],text)','EXECUTE');
 assert not has_function_privilege('service_role','public.read_worker_owned_queue_schedule(uuid,text[],text)','EXECUTE');
 perform pg_temp.reject('select public.read_worker_owned_queue_schedule(null)','40001');
 perform pg_temp.reject('select public.read_worker_owned_queue_schedule(''ab100000-0000-4000-8000-000000000002'')','40001');
 assert public.read_report_terminal_maintenance_schedule()->>'ready'='false';
 assert public.read_report_terminal_maintenance_schedule()->'nextDueAt'='null'::jsonb;
end;$$;
update private.global_worker_run set expires_at=clock_timestamp()-interval'1 second'where singleton;
select pg_temp.reject('select public.read_worker_owned_queue_schedule(''ab100000-0000-4000-8000-000000000001'')','40001');
rollback;
