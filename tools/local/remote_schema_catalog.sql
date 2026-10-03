-- 원격/로컬 20개 이력의 읽기 전용 비교 자료. 기대 앱 테이블 14개·함수 46개이며 추가 객체도 숨기지 않는다.
-- 사용자 행, 키, 함수 본문, 정책식, cron 명령 원문을 반환하지 않는다. OID는 이름으로 정규화한다.
-- deparse 재현성을 위해 이 트랜잭션의 search_path만 pg_catalog로 고정한다. 영구 설정/DDL 변경은 없다.
with settings as materialized (
  select pg_catalog.set_config('search_path','pg_catalog',true) as deparse_path
), app_schemas as materialized (
  select n.* from pg_catalog.pg_namespace n cross join settings
  where n.nspname in('public','private')
), app_tables as materialized (
  select c.*,n.nspname as schema_name from pg_catalog.pg_class c join app_schemas n on n.oid=c.relnamespace
  where c.relkind in('r','p','v','m','f','S') and not exists(
    select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_class'::regclass
      and d.objid=c.oid and d.deptype='e')
), app_functions as materialized (
  select p.*,n.nspname as schema_name from pg_catalog.pg_proc p join app_schemas n on n.oid=p.pronamespace
  where not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_proc'::regclass
    and d.objid=p.oid and d.deptype='e')
), normalized_policies as (
  select n.nspname as schema_name,c.relname as table_name,p.polname as name,
    p.polcmd::text as command,p.polpermissive as permissive,
    coalesce((select jsonb_agg(case when r=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(r)::text end
      order by case when r=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(r)::text end)
      from unnest(p.polroles) r),'[]'::jsonb) as roles,
    case when p.polqual is null then null else md5(pg_catalog.pg_get_expr(p.polqual,p.polrelid,false)) end as using_md5,
    case when p.polwithcheck is null then null else md5(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid,false)) end as check_md5
  from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where c.oid in(select oid from app_tables)
    or (n.nspname='storage' and c.relname='objects')
), schema_grants as (
  select n.nspname as schema,a.* from app_schemas n
  cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
), table_grants as (
  select c.schema_name as schema,c.relname as table_name,a.* from app_tables c
  cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,
    pg_catalog.acldefault(case when c.relkind='S' then 'S'::"char" else 'r'::"char" end,c.relowner))) a
), column_grants as (
  select c.schema_name as schema,c.relname as table_name,x.attname as column_name,a.*
  from app_tables c join pg_catalog.pg_attribute x on x.attrelid=c.oid and x.attnum>0 and not x.attisdropped
  cross join lateral pg_catalog.aclexplode(x.attacl) a
), default_grants as (
  select pg_catalog.pg_get_userbyid(d.defaclrole)::text as owner,
    case when d.defaclnamespace=0 then null else n.nspname::text end as schema,
    d.defaclobjtype::text as object_type,a.*
  from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace
  cross join lateral pg_catalog.aclexplode(d.defaclacl) a
  where d.defaclnamespace=0 or n.nspname in('public','private')
), grant_records as (
  select 'schemaGrants'::text as category,jsonb_build_object('schema',schema,
    'grantor',pg_catalog.pg_get_userbyid(grantor),'grantee',case when grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(grantee)::text end,
    'privilege',privilege_type,'isGrantable',is_grantable) as entry from schema_grants
  union all select 'tableGrants',jsonb_build_object('schema',schema,'table',table_name,
    'grantor',pg_catalog.pg_get_userbyid(grantor),'grantee',case when grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(grantee)::text end,
    'privilege',privilege_type,'isGrantable',is_grantable) from table_grants
  union all select 'columnGrants',jsonb_build_object('schema',schema,'table',table_name,'column',column_name,
    'grantor',pg_catalog.pg_get_userbyid(grantor),'grantee',case when grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(grantee)::text end,
    'privilege',privilege_type,'isGrantable',is_grantable) from column_grants
  union all select 'defaultGrants',jsonb_build_object('owner',owner,'schema',schema,'objectType',object_type,
    'grantor',pg_catalog.pg_get_userbyid(grantor),'grantee',case when grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(grantee)::text end,
    'privilege',privilege_type,'isGrantable',is_grantable) from default_grants
)
select jsonb_build_object(
  'formatVersion',1,
  'context',jsonb_build_object('serverVersionNum',current_setting('server_version_num')::integer,
    'serverVersion',current_setting('server_version'),'deparseSearchPath',(select deparse_path from settings)),
  'operational',jsonb_build_object('cron',coalesce((select jsonb_agg(jsonb_build_object(
    'name',jobname,'schedule',schedule,'active',active,'commandMd5',md5(command)) order by jobname,schedule,active,md5(command))
    from cron.job where jobname='yumidang-auto-complete-appointments'),'[]'::jsonb)),
  'static',jsonb_build_object(
    'schemas',coalesce((select jsonb_agg(jsonb_build_object('schema',nspname,'owner',pg_catalog.pg_get_userbyid(nspowner))
      order by nspname) from app_schemas),'[]'::jsonb),
    'tables',coalesce((select jsonb_agg(jsonb_build_object('schema',schema_name,'table',relname,'kind',relkind::text,
      'owner',pg_catalog.pg_get_userbyid(relowner),'rls',relrowsecurity,'forceRls',relforcerowsecurity)
      order by schema_name,relname) from app_tables),'[]'::jsonb),
    'columns',coalesce((select jsonb_agg(jsonb_build_object('schema',c.schema_name,'table',c.relname,'column',a.attname,
      'position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
      'identity',a.attidentity::text,'generated',a.attgenerated::text,
      'collation',case when co.oid is null then null else cn.nspname||'.'||co.collname end,
      'defaultMd5',case when d.oid is null then null else md5(pg_catalog.pg_get_expr(d.adbin,d.adrelid,false)) end)
      order by c.schema_name,c.relname,a.attnum)
      from app_tables c join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      left join pg_catalog.pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      left join pg_catalog.pg_collation co on co.oid=a.attcollation
      left join pg_catalog.pg_namespace cn on cn.oid=co.collnamespace),'[]'::jsonb),
    'indexes',coalesce((select jsonb_agg(jsonb_build_object('schema',c.schema_name,'table',c.relname,'name',ic.relname,
      'method',am.amname,'unique',i.indisunique,'primary',i.indisprimary,'valid',i.indisvalid,'ready',i.indisready,
      'keyCount',i.indnkeyatts,'definitionMd5',md5(pg_catalog.pg_get_indexdef(i.indexrelid,0,false)))
      order by c.schema_name,c.relname,ic.relname)
      from app_tables c join pg_catalog.pg_index i on i.indrelid=c.oid
      join pg_catalog.pg_class ic on ic.oid=i.indexrelid join pg_catalog.pg_am am on am.oid=ic.relam),'[]'::jsonb),
    'constraints',coalesce((select jsonb_agg(jsonb_build_object('schema',t.schema_name,'table',t.relname,'name',c.conname,
      'type',c.contype::text,'validated',c.convalidated,'deferrable',c.condeferrable,'initiallyDeferred',c.condeferred,
      'definitionMd5',md5(pg_catalog.pg_get_constraintdef(c.oid,false)),
      'foreignTarget',case when f.oid is null then null else fn.nspname||'.'||f.relname end)
      order by t.schema_name,t.relname,c.conname)
      from app_tables t join pg_catalog.pg_constraint c on c.conrelid=t.oid
      left join pg_catalog.pg_class f on f.oid=c.confrelid left join pg_catalog.pg_namespace fn on fn.oid=f.relnamespace),'[]'::jsonb),
    'policies',coalesce((select jsonb_agg(jsonb_build_object('schema',schema_name,'table',table_name,'name',name,
      'command',command,'permissive',permissive,'roles',roles,'usingMd5',using_md5,'checkMd5',check_md5)
      order by schema_name,table_name,name) from normalized_policies where schema_name in('public','private')),'[]'::jsonb),
    'storagePolicies',coalesce((select jsonb_agg(jsonb_build_object('schema',schema_name,'table',table_name,'name',name,
      'command',command,'permissive',permissive,'roles',roles,'usingMd5',using_md5,'checkMd5',check_md5)
      order by schema_name,table_name,name) from normalized_policies where schema_name='storage'),'[]'::jsonb),
    'triggers',coalesce((select jsonb_agg(jsonb_build_object('schema',c.schema_name,'table',c.relname,'name',t.tgname,
      'enabled',t.tgenabled::text,'definitionMd5',md5(pg_catalog.pg_get_triggerdef(t.oid,false)))
      order by c.schema_name,c.relname,t.tgname)
      from app_tables c join pg_catalog.pg_trigger t on t.tgrelid=c.oid where not t.tgisinternal),'[]'::jsonb),
    'functions',coalesce((select jsonb_agg(jsonb_build_object('schema',p.schema_name,'name',p.proname,
      'identityArguments',pg_catalog.pg_get_function_identity_arguments(p.oid),'result',pg_catalog.pg_get_function_result(p.oid),
      'argumentsMd5',md5(pg_catalog.pg_get_function_arguments(p.oid)),'kind',p.prokind::text,'language',l.lanname,
      'owner',pg_catalog.pg_get_userbyid(p.proowner),'volatility',p.provolatile::text,'definer',p.prosecdef,
      'strict',p.proisstrict,'parallel',p.proparallel::text,'bodyMd5',md5(p.prosrc),
      'searchPath',(select substring(x from 13) from unnest(p.proconfig) x where x like 'search_path=%'),
      'configurationMd5',case when p.proconfig is null then null else md5(to_json(p.proconfig)::text) end,
      'acl',coalesce((select jsonb_agg(jsonb_build_object('grantor',pg_catalog.pg_get_userbyid(a.grantor),
        'grantee',case when a.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee)::text end,
        'privilege',a.privilege_type,'isGrantable',a.is_grantable)
        order by pg_catalog.pg_get_userbyid(a.grantor),case when a.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee)::text end,
          a.privilege_type,a.is_grantable)
        from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a),'[]'::jsonb))
      order by p.schema_name,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid))
      from app_functions p join pg_catalog.pg_language l on l.oid=p.prolang),'[]'::jsonb),
    'schemaGrants',coalesce((select jsonb_agg(entry order by entry::text) from grant_records where category='schemaGrants'),'[]'::jsonb),
    'tableGrants',coalesce((select jsonb_agg(entry order by entry::text) from grant_records where category='tableGrants'),'[]'::jsonb),
    'columnGrants',coalesce((select jsonb_agg(entry order by entry::text) from grant_records where category='columnGrants'),'[]'::jsonb),
    'defaultGrants',coalesce((select jsonb_agg(entry order by entry::text) from grant_records where category='defaultGrants'),'[]'::jsonb),
    'migrationVersions',coalesce((select jsonb_agg(version order by version) from supabase_migrations.schema_migrations),'[]'::jsonb)
  )
) as catalog;
