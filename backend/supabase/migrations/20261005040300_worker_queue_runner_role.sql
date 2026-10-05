-- 민규 후보: source60과 분리. 검토/적용/역할 생성/LOGIN provisioning은 아직 NOT_RUN.
-- 전용 DB 역할은 schedule/acquire/release와 LISTEN만 맡는다. cleanup/budget/관리 키는 별도다.
-- PUBLIC CONNECT/TEMP/pg_catalog와 채널별 ACL 없는 LISTEN은 전역 변경하지 않는다.
begin;
do $$
declare v_role oid;v_created boolean:=false;v_public oid:='public'::regnamespace;
 v_database oid;v_rpc oid[];v_owner oid;r text;
begin
 select oid into v_database from pg_database where datname=current_database();
 v_rpc:=array[to_regprocedure('public.read_worker_queue_schedule(text[],text)'),
  to_regprocedure('public.acquire_worker_run(integer,uuid)'),to_regprocedure('public.release_worker_run(uuid)')];
 if array_position(v_rpc,null)is not null or exists(select 1 from pg_proc where oid=any(v_rpc)
  and(not prosecdef or proconfig is distinct from array['search_path=""']::text[]))then
  raise exception 'worker_queue_rpc_not_ready'using errcode='42501';end if;
 select oid into v_role from pg_roles where rolname='yumidang_worker_queue';
 if v_role is null then
  create role yumidang_worker_queue nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  v_created:=true;select oid into v_role from pg_roles where rolname='yumidang_worker_queue';
 end if;
 -- 이름 충돌을 기존 역할/멤버십 변경으로 해결하지 않는다.
 if exists(select 1 from pg_roles where oid=v_role and(rolcanlogin or rolinherit or rolsuper or rolcreatedb
  or rolcreaterole or rolreplication or rolbypassrls or rolconnlimit<>-1 or rolvaliduntil is not null))
  or exists(select 1 from pg_auth_members m where m.member=v_role or(m.roleid=v_role and not(
   v_created and current_user='postgres'and m.member='postgres'::regrole and m.grantor='supabase_admin'::regrole
   and m.admin_option and not m.inherit_option and not m.set_option
   and exists(select 1 from pg_roles where oid=m.member and rolcreaterole and not rolsuper)
   and exists(select 1 from pg_roles where oid=m.grantor and rolsuper))))
  or exists(select 1 from pg_db_role_setting where setrole=v_role)
  or exists(select 1 from pg_shdepend where refclassid='pg_authid'::regclass and refobjid=v_role and deptype='o')then
  raise exception 'worker_queue_role_collision'using errcode='42501';end if;
 for v_owner in select distinct proowner from pg_proc where oid=any(v_rpc)loop
  if pg_has_role(v_role,v_owner,'USAGE')or pg_has_role(v_role,v_owner,'SET')then
   raise exception 'worker_queue_owner_membership'using errcode='42501';end if;
 end loop;
 if exists(select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl)a where a.grantee=v_role)
  or exists(select 1 from pg_database d cross join lateral aclexplode(d.datacl)a where a.grantee=v_role
   and(d.oid<>v_database or a.privilege_type<>'CONNECT'or a.is_grantable))
  or exists(select 1 from pg_namespace n cross join lateral aclexplode(n.nspacl)a where a.grantee=v_role
   and(n.oid<>v_public or a.privilege_type<>'USAGE'or a.is_grantable))
  or exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl)a where a.grantee=v_role
   and(p.oid<>all(v_rpc)or a.privilege_type<>'EXECUTE'or a.is_grantable))
  or exists(select 1 from pg_class c cross join lateral aclexplode(c.relacl)a where a.grantee=v_role)
  or exists(select 1 from pg_attribute c cross join lateral aclexplode(c.attacl)a where a.grantee=v_role)then
  raise exception 'worker_queue_unexpected_grant'using errcode='42501';end if;
 execute format('grant connect on database %I to yumidang_worker_queue',current_database());
 grant usage on schema public to yumidang_worker_queue;
 grant execute on function public.read_worker_queue_schedule(text[],text),public.acquire_worker_run(integer,uuid),
  public.release_worker_run(uuid)to yumidang_worker_queue;
 -- 새 명시 권한과 PUBLIC을 통한 실제 앱 권한을 함께 검사한다.
 if exists(select 1 from pg_namespace n where n.nspname!~'^pg_'and n.nspname<>'information_schema'
   and has_schema_privilege(v_role,n.oid,'CREATE'))
  or has_schema_privilege(v_role,'private','USAGE')
  or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname in('public','private','auth','storage','vault','realtime','cron','supabase_functions','supabase_migrations')
   and has_schema_privilege(v_role,n.oid,'USAGE')and has_function_privilege(v_role,p.oid,'EXECUTE')and p.oid<>all(v_rpc))
  or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname in('public','private','auth','storage','vault','realtime','cron','supabase_functions','supabase_migrations')
   and has_schema_privilege(v_role,n.oid,'USAGE')and((c.relkind='S'and has_sequence_privilege(v_role,c.oid,'USAGE,SELECT,UPDATE'))
   or(c.relkind in('r','p','v','m','f')and(has_table_privilege(v_role,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_any_column_privilege(v_role,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))))then
  raise exception 'worker_queue_unexpected_public_privilege'using errcode='42501';end if;
end;$$;
commit;
