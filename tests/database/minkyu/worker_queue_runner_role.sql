-- 전용 NOLOGIN 후보 적용 후 새 격리 DB에서만 실행한다. 현재 NOT_RUN.
-- supabase_admin owner의 SET SESSION AUTHORIZATION은 password/LOGIN 실제 접속 증거가 아니다.
-- 역할/멤버십을 생성·수정하지 않으며 합성 singleton과 lease는 전체 rollback한다.
begin;
insert into private.global_worker_run(singleton,token,expires_at)
 select true,null,null where not exists(select 1 from private.global_worker_run where singleton);
do $$declare r oid:='yumidang_worker_queue'::regrole;f regprocedure;owner_id oid;t regclass;begin
 assert exists(select 1 from pg_roles where oid=r and not(rolcanlogin or rolinherit or rolsuper or rolcreatedb
  or rolcreaterole or rolreplication or rolbypassrls)and rolconnlimit=-1 and rolvaliduntil is null);
 assert not exists(select 1 from pg_auth_members where member=r);
 assert not exists(select 1 from pg_db_role_setting where setrole=r);
 assert not exists(select 1 from pg_shdepend where refclassid='pg_authid'::regclass and refobjid=r and deptype='o');
 assert not pg_has_role('anon',r,'USAGE')and not pg_has_role('anon',r,'SET');
 assert not pg_has_role('authenticated',r,'USAGE')and not pg_has_role('authenticated',r,'SET');
 assert not pg_has_role('service_role',r,'USAGE')and not pg_has_role('service_role',r,'SET');
 assert not pg_has_role('authenticator',r,'USAGE')and not pg_has_role('authenticator',r,'SET');
 assert not pg_has_role(r,'yumidang_completion_runner','USAGE')and not pg_has_role(r,'yumidang_completion_runner','SET');
 assert has_database_privilege(r,current_database(),'CONNECT');
 assert has_schema_privilege(r,'public','USAGE')and not has_schema_privilege(r,'public','CREATE');
 assert not has_schema_privilege(r,'private','USAGE')and not has_schema_privilege(r,'auth','USAGE')
  and not has_schema_privilege(r,'storage','USAGE');
 assert(select count(*)from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'and has_function_privilege(r,p.oid,'EXECUTE'))=3;
 foreach f in array array['public.read_worker_queue_schedule(text[],text)'::regprocedure,
  'public.acquire_worker_run(integer,uuid)'::regprocedure,'public.release_worker_run(uuid)'::regprocedure]loop
  assert has_function_privilege(r,f,'EXECUTE');select proowner into owner_id from pg_proc where oid=f;
  assert not pg_has_role(r,owner_id,'USAGE')and not pg_has_role(r,owner_id,'SET');
 end loop;
 foreach f in array array['public.read_worker_run_budget(uuid)'::regprocedure,
  'public.claim_member_cleanup_task(uuid)'::regprocedure,'public.list_completion_reservations()'::regprocedure]loop
  assert not has_function_privilege(r,f,'EXECUTE');
 end loop;
 foreach t in array array['public.profiles'::regclass,'private.worker_jobs'::regclass,
  'private.global_worker_run'::regclass,'private.member_cleanup_tasks'::regclass,'auth.users'::regclass,'storage.objects'::regclass]loop
  assert not has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
 end loop;
 assert(select token is null and expires_at is null from private.global_worker_run where singleton);
 assert not exists(select 1 from private.worker_jobs);
end;$$;
create function pg_temp.queue_role_denied(command text)returns void language plpgsql as $$declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code='42501',format('unexpected SQLSTATE %s',code);
end;$$;
grant execute on function pg_temp.queue_role_denied(text)to yumidang_worker_queue;
set session authorization yumidang_worker_queue;
listen yumidang_worker_jobs;
select set_config('request.jwt.claims','{}',true);
do $$declare x jsonb;lease jsonb;again jsonb;token uuid;begin
 assert current_user='yumidang_worker_queue';
 x:=public.read_worker_queue_schedule('{}',null);
 assert(select count(*)from jsonb_object_keys(x))=3;
 assert x->'nextDueAt'='null'::jsonb and x->'nextKind'='null'::jsonb;
 lease:=public.acquire_worker_run(180,null);assert(select count(*)from jsonb_object_keys(lease))=2;
 token:=(lease->>'token')::uuid;assert token is not null;
 again:=public.acquire_worker_run(180,token);assert again=lease;
 assert public.release_worker_run(token)->>'status'='applied';
 assert public.release_worker_run(token)->>'status'='lease_lost';
end;$$;
select pg_temp.queue_role_denied('set role authenticated');
select pg_temp.queue_role_denied('set role service_role');
select pg_temp.queue_role_denied('set role authenticator');
select pg_temp.queue_role_denied('set role yumidang_completion_runner');
select pg_temp.queue_role_denied('select public.read_worker_run_budget(null)');
select pg_temp.queue_role_denied('select public.claim_member_cleanup_task(null)');
select pg_temp.queue_role_denied('select public.list_completion_reservations()');
select pg_temp.queue_role_denied('select public.get_my_profile()');
select pg_temp.queue_role_denied('select * from public.profiles');
select pg_temp.queue_role_denied('select * from private.worker_jobs');
select pg_temp.queue_role_denied('select * from auth.users');
select pg_temp.queue_role_denied('select * from storage.objects');
select pg_temp.queue_role_denied('create table public.queue_role_escape(id integer)');
reset session authorization;
unlisten *;
do $$begin
 assert(select token is null and expires_at is null from private.global_worker_run where singleton);
 assert not exists(select 1 from pg_auth_members where member='yumidang_worker_queue'::regrole);
 assert not exists(select 1 from private.worker_jobs);
end;$$;
rollback;
