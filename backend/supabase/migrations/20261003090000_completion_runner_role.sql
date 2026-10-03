-- 원형 Node 실행기는 아래 두 RPC와 LISTEN만 사용한다. 비밀 LOGIN은 운영 환경에서 별도 생성한다.
-- PostgreSQL LISTEN/NOTIFY에는 채널별 ACL이 없다. 채널 payload는 기존 빈 신호를 유지한다.
-- PUBLIC CONNECT/TEMP와 pg_catalog의 공용 기능은 전역 변경하지 않는다.
begin;
do $$
declare
  v_role oid; v_list oid:=to_regprocedure('public.list_completion_reservations()');
  v_execute oid:=to_regprocedure('public.execute_completion_reservation(uuid,uuid)');
  v_public oid:='public'::regnamespace; v_created boolean:=false;
begin
  if v_list is null or v_execute is null or exists(
    select 1 from pg_proc where oid in(v_list,v_execute)
    and (not prosecdef or proconfig is distinct from array['search_path=""']::text[])
  ) then raise exception 'completion_runner_rpc_not_ready' using errcode='42501'; end if;
  select oid into v_role from pg_roles where rolname='yumidang_completion_runner';
  if v_role is null then
    create role yumidang_completion_runner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    v_created:=true;
    select oid into v_role from pg_roles where rolname='yumidang_completion_runner';
  end if;
  -- 이름 충돌을 관리자 역할 변경이나 기존 멤버 자동 회수로 해결하지 않는다.
  if exists(select 1 from pg_roles where oid=v_role and (
    rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls
    or rolconnlimit<>-1 or rolvaliduntil is not null))
    or exists(select 1 from pg_auth_members m where m.member=v_role or (m.roleid=v_role and not (
      -- PostgreSQL 16+가 이번 CREATE ROLE에 자동 생성한 관리용 행만 허용한다.
      -- 로컬 합성 debug 역할에서 확인한 생성자 postgres / grantor=supabase_admin과 일치해야 한다.
      -- ADMIN=true / INHERIT=false / SET=false. 기존 역할의 멤버는 자동 인정하지 않는다.
      v_created and current_user='postgres' and m.member='postgres'::regrole
      and m.grantor='supabase_admin'::regrole and m.admin_option and not m.inherit_option and not m.set_option
      and exists(select 1 from pg_roles where oid=m.member and rolcreaterole and not rolsuper)
      and exists(select 1 from pg_roles where oid=m.grantor and rolsuper))))
    or exists(select 1 from pg_db_role_setting where setrole=v_role)
    or exists(select 1 from pg_shdepend where refclassid='pg_authid'::regclass and refobjid=v_role and deptype='o')
  then raise exception 'completion_runner_role_collision' using errcode='42501'; end if;
  -- 기존 동일 이름에 임의 객체 권한이나 향후 기본 권한이 있으면 fail closed한다.
  if exists(select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a where a.grantee=v_role)
    or exists(select 1 from pg_database d cross join lateral aclexplode(d.datacl) a where a.grantee=v_role)
    or exists(select 1 from pg_namespace n cross join lateral aclexplode(n.nspacl) a
      where a.grantee=v_role and (n.oid<>v_public or a.privilege_type<>'USAGE' or a.is_grantable))
    or exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a
      where a.grantee=v_role and (p.oid not in(v_list,v_execute) or a.privilege_type<>'EXECUTE' or a.is_grantable))
    or exists(select 1 from pg_class c cross join lateral aclexplode(c.relacl) a where a.grantee=v_role)
    or exists(select 1 from pg_attribute c cross join lateral aclexplode(c.attacl) a where a.grantee=v_role)
  then raise exception 'completion_runner_unexpected_grant' using errcode='42501'; end if;
  grant usage on schema public to yumidang_completion_runner;
  grant execute on function public.list_completion_reservations(),public.execute_completion_reservation(uuid,uuid)
    to yumidang_completion_runner;
  -- 명시 GRANT뿐 아니라 PUBLIC에서 얻는 실제 앱 권한도 검사한다. 전역 ACL을 임의 회수하지 않는다.
  if exists(select 1 from pg_namespace n where n.nspname !~ '^pg_' and n.nspname<>'information_schema'
      and has_schema_privilege(v_role,n.oid,'CREATE'))
    or has_schema_privilege(v_role,'private','USAGE')
    or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in('public','private','auth','storage','vault','realtime','cron','supabase_functions','supabase_migrations')
      and has_schema_privilege(v_role,n.oid,'USAGE') and has_function_privilege(v_role,p.oid,'EXECUTE')
      and p.oid not in(v_list,v_execute))
    or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in('public','private','auth','storage','vault','realtime','cron','supabase_functions','supabase_migrations')
      and has_schema_privilege(v_role,n.oid,'USAGE')
      and ((c.relkind='S' and has_sequence_privilege(v_role,c.oid,'USAGE,SELECT,UPDATE'))
        or (c.relkind in('r','p','v','m','f') and (
          has_table_privilege(v_role,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or has_any_column_privilege(v_role,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))))
  then raise exception 'completion_runner_unexpected_public_privilege' using errcode='42501'; end if;
end; $$;
commit;
