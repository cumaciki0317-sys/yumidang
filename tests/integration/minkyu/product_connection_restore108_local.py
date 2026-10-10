"""SQL108 격리 전체 복원·상세 파기 재적용. 원 DB는 읽기만 한다."""
import hashlib,json,re,subprocess,time,uuid
import queue_tls_environment as t

R=t.ROOT
NAME='yumidang-minkyu-production108-restore-v2'
REPLAY=NAME+'-replay'
BOOT='yumidang_production_recovery_bootstrap'
TABLES=('conversation_message_reads','conversation_read_states','member_cleanup_tasks',
        'member_cleanup_dispatches','member_cleanup_delete_acks','worker_runtime_intents')
FUNCTIONS=('public.claim_member_cleanup_ack_recovery(uuid,uuid)',
           'public.read_member_cleanup_recovery(uuid,integer)',
           'public.read_worker_runtime_pending_v2()')

def sql(name,query):
 return t.call(t.DOCKER+['exec','-i',name,'psql','-XqAt','-U',BOOT,'-d','postgres',
                       '-v','ON_ERROR_STOP=1'],query.encode())

def digest(run,table,where=''):
 value=run("select count(*)||':'||md5(coalesce(string_agg(row_to_json(t)::text,','order by row_to_json(t)::text),''))from private."+table+' t '+where+';')
 return value.decode().strip()

def snapshot(run,exclude=None):
 result={name:digest(run,name)for name in TABLES}
 for name in ('worker_runtime_atomic_control','member_cleanup_guard','global_worker_run'):
  result[name]=digest(run,name)
 result['runtime_results']=digest(run,'worker_runtime_results',
   "where request_id<>'"+exclude+"'" if exclude else '')
 result['external_pending']=digest(run,'worker_runtime_results',"where state='external_pending'")
 for signature in FUNCTIONS:
  # A SQL107-only restore cannot be labelled SQL108: missing functions fail here.
  result[signature]=run("select md5(pg_get_functiondef('"+signature+"'::regprocedure))||':'||coalesce(proacl::text,'NULL')from pg_proc where oid='"+signature+"'::regprocedure;").decode().strip()
 return result

def assert_closed(run):
 assert run("select not(select enabled from private.worker_runtime_atomic_control)and not(select external_deletion_approved from private.member_cleanup_guard)and not(select token is not null from private.global_worker_run);").decode().strip()=='t','CONTROL_OR_LEASE_NOT_CLOSED'
 for signature in FUNCTIONS:
  for role in ('anon','authenticated','service_role'):
   assert run("select has_function_privilege('"+role+"','"+signature+"','EXECUTE');").decode().strip()=='f','RECOVERY_EXEC_NOT_CLOSED'

def restore(name,dump,roles):
 # No exposed TCP port or bind mount; cron execution and host login stay disabled.
 t.call(t.DOCKER+['run','-d','--name',name,'--label','yumidang.owner=minkyu',
   '--user','postgres','--entrypoint','sh',t.IMAGE,'-c',
   'initdb -U '+BOOT+" -D /tmp/recovery-data --auth-local=trust --auth-host=reject && exec postgres -D /tmp/recovery-data -c listen_addresses='' -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off"])
 for _ in range(40):
  probe=subprocess.run(t.DOCKER+['exec',name,'pg_isready','-U',BOOT],capture_output=True,timeout=5)
  if probe.returncode==0:break
  time.sleep(.5)
 else:raise RuntimeError('RECOVERY_NOT_READY_INSPECT_BEFORE_RETRY')
 sql(name,roles)
 t.call(t.DOCKER+['exec','-i',name,'pg_restore','-U',BOOT,'-d','postgres',
                  '--single-transaction','--exit-on-error'],dump.read_bytes())
 assert sql(name,'show cron.launch_active_jobs;').decode().strip()=='off'
 assert sql(name,'show listen_addresses;').decode().strip()==''
 assert_closed(lambda query:sql(name,query))

def purge(run,key,fingerprint):
 token=str(uuid.uuid4())
 # This transaction rolls back gate changes if purge fails, without altering source.
 run("begin;set local statement_timeout='10s';set local request.jwt.claims='{\"role\":\"service_role\"}';update private.worker_runtime_atomic_control set enabled=true;update private.global_worker_run set token='"+token+"',expires_at=clock_timestamp()+interval'180 seconds'where singleton;select public.purge_worker_runtime_details('"+token+"',1);update private.worker_runtime_atomic_control set enabled=false;update private.global_worker_run set token=null,expires_at=null where singleton;commit;")
 assert run("select state||':'||(input is null and result is null)::text||':'||fingerprint from private.worker_runtime_results where request_id='"+key+"';").decode().strip()=='purged:true:'+fingerprint
 assert_closed(run)

def run():
 existing=t.call(t.DOCKER+['ps','-a','--format','{{.Names}}']).decode().splitlines()
 assert NAME not in existing and REPLAY not in existing,'EXISTING_RESTORE_PRESERVED_INSPECT_BEFORE_RETRY'
 labels=json.loads(t.call(t.DOCKER+['inspect','--format','{{json .Config.Labels}}',t.NAME]))
 assert labels.get('yumidang.owner')=='minkyu','SOURCE_OWNERSHIP_MISMATCH'
 assert_closed(t.sql)
 source_before=snapshot(t.sql)
 original=json.loads(t.sql("select json_build_object('id',request_id,'hash',fingerprint)from private.worker_runtime_results where state='completed'and input is not null and result is not null order by created_at limit 1;").decode())
 key=str(uuid.UUID(original['id']))
 dump=R/'production108-source-v2.dump'
 roles_path=R/'production108-roles-v2.sql'
 for path,args in ((dump,['pg_dump','-U','yumidang_tls_bootstrap','-d','postgres','-Fc']),
                   (roles_path,['pg_dumpall','-U','yumidang_tls_bootstrap','--roles-only','--no-role-passwords'])):
  assert not path.exists(),'EXISTING_BACKUP_PRESERVED'
  path.write_bytes(t.call(t.DOCKER+['exec',t.NAME,*args]));path.chmod(0o600)
 roles=re.sub(r' GRANTED BY [A-Za-z_][A-Za-z0-9_]*;',';',roles_path.read_text())
 roles='\n'.join(line for line in roles.splitlines()if not re.match(r'(CREATE|ALTER) ROLE yumidang_tls_bootstrap(?: |;)',line))
 restore(NAME,dump,roles)
 first=lambda query:sql(NAME,query)
 assert snapshot(first)==source_before,'FULL_RESTORE_CONTENT_OR_FUNCTION_ACL_MISMATCH'
 # Age only the disposable clone, then retain a pre-deletion backup for replay.
 # Older fixtures may already be due. Make this one the earliest and purge one.
 first("with age as(select least(clock_timestamp()-interval'720 hours',min(closed_at))-interval'1 hour' as closed from private.worker_runtime_results where state='completed')update private.worker_runtime_results set created_at=age.closed-interval'1 day',closed_at=age.closed from age where request_id='"+key+"';")
 preserved=snapshot(first,key)
 old_backup=R/'production108-before-purge-v2.dump'
 assert not old_backup.exists(),'EXISTING_OLD_BACKUP_PRESERVED'
 old_backup.write_bytes(t.call(t.DOCKER+['exec',NAME,'pg_dump','-U',BOOT,'-d','postgres','-Fc']));old_backup.chmod(0o600)
 purge(first,key,original['hash'])
 assert snapshot(first,key)==preserved,'UNRELATED_OR_PENDING_ROWS_CHANGED'
 restore(REPLAY,old_backup,roles)
 replay=lambda query:sql(REPLAY,query)
 assert replay("select state||':'||(input is not null and result is not null)::text from private.worker_runtime_results where request_id='"+key+"';").decode().strip()=='completed:true'
 assert snapshot(replay,key)==preserved,'OLD_BACKUP_PROTECTED_CONTENT_MISMATCH'
 purge(replay,key,original['hash'])
 assert snapshot(replay,key)==preserved,'REPLAY_CHANGED_PROTECTED_CONTENT'
 assert snapshot(t.sql)==source_before,'SOURCE_STATE_CHANGED'
 receipt={'fullSql108Restore':'PASS','sql108FunctionDefinitionsAndAclPreserved':True,
   'deletedDetailsRevivedByOldBackup':True,'reappliedPurge':'PASS',
   'minimumHashAndFullExternalPendingPreserved':True,'recoveryExecuteClosed':True,
   'cronActiveJobs':'off','connectionRowsTasksAndDispatchPreserved':True,
   'sourceDatabaseChanged':False,'operatingChanged':False,
   'sourceDumpSha256':hashlib.sha256(dump.read_bytes()).hexdigest(),
   'storageBinaryRestore':'NOT_RUN','fullQueueCli':'NOT_RUN'}
 p=R/'production108-restore-receipt.json';p.write_text(json.dumps(receipt));p.chmod(0o600)
 print(json.dumps(receipt))


def safe_storage_files(data):
 """업로드 volume의 일반 파일만 허용한다. 추출 전에 전체 archive를 검증한다."""
 import io,tarfile
 from pathlib import PurePosixPath
 result={}
 with tarfile.open(fileobj=io.BytesIO(data))as archive:
  for item in archive.getmembers():
   path=PurePosixPath(item.name)
   assert not path.is_absolute() and '..'not in path.parts and (item.isfile()or item.isdir()),'UNSAFE_STORAGE_ARCHIVE'
   key=str(path)
   assert key not in result,'DUPLICATE_STORAGE_ARCHIVE_FILE'
   if item.isfile():result[key]=hashlib.sha256(archive.extractfile(item).read()).hexdigest()
 return result

def read_database_row_digests(run):
 """읽기 한 statement의 비시스템 전체 테이블 digest. 공유 격리 검증 helper다."""
 tables=json.loads(run("select coalesce(json_agg(json_build_array(n.nspname,c.relname)order by n.nspname,c.relname),'[]')from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in('r','p','m')and left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema';"))
 queries=[]
 for schema,table in tables:
  relation='"'+schema.replace('"','""')+'"."'+table.replace('"','""')+'"'
  key=(schema+'.'+table).replace("'","''")
  queries.append("select '"+key+"' as key,count(*)||':'||md5(coalesce(string_agg(to_jsonb(x)::text,','order by to_jsonb(x)::text),''))as value from "+relation+' x')
 return json.loads(run("select coalesce(json_object_agg(key,value),'{}')from("+' union all '.join(queries)+")as digests;"))if queries else{}

def run_full_storage(*, resume_storage=False):
 """새 disposable DB/volume만 생성한다. 기존 source/복원 대상 자료는 삭제하지 않는다."""
 import base64,os,secrets
 from pathlib import Path
 root=Path('/private/tmp/yumidang-full108-20261009-v3')
 if resume_storage:
  assert root.is_dir()and root.resolve()==root and not(root.stat().st_mode&0o077),'PRIVATE_RECOVERY_REQUIRED'
  assert not(root/'receipt.json').exists()and not(root/'known-delete-dispatched.json').exists(),'NO_AUTOMATIC_DELETE_REPLAY'
 else:
  assert not root.exists(),'EXISTING_FULL_RECOVERY_PRESERVED'
  root.mkdir(mode=0o700)
 prefix='yumidang-minkyu-full108-20261009-v3'
 storage_source='yumidang-minkyu-runtime103-storage'
 database_names=[prefix+'-db',prefix+'-replay-db']
 storage_names=[prefix+'-storage',prefix+'-replay-storage']
 volumes=[name+'-files' for name in storage_names]
 bootstrap='yumidang_full108_bootstrap'
 def save(name,data):
  with os.fdopen(os.open(root/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb')as stream:stream.write(data)
 def call(args,data=None):
  process=subprocess.run(args,input=data,capture_output=True,timeout=120)
  if process.returncode:
   save('failure-'+str(uuid.uuid4())+'.log',process.stdout+process.stderr)
   raise RuntimeError('FULL_RECOVERY_FAILED_INSPECT_PRIVATE_ARTIFACTS_NO_RETRY')
  return process.stdout
 def docker(*args,data=None):return call(t.DOCKER+list(args),data)
 def dbsql(name,query,login=bootstrap):return docker('exec','-i',name,'psql','-XqAt','-U',login,'-d','postgres','-v','ON_ERROR_STOP=1',data=query.encode())
 source=lambda query:dbsql(t.NAME,query,'yumidang_tls_bootstrap')
 def closed(run):
  assert run("select not(select external_deletion_approved from private.member_cleanup_guard)and not(select enabled from private.worker_runtime_atomic_control)and not(select token is not null from private.global_worker_run);").decode().strip()=='t','SOURCE_OR_CLONE_CONTROLS_NOT_CLOSED'
  assert run('show cron.launch_active_jobs;').decode().strip()=='off'
 def rows(run):
  return read_database_row_digests(run)
 catalog_query=(Path(__file__).resolve().parents[3]/'tools/local/remote_schema_catalog.sql').read_text()
 def catalog(run):return json.loads(run(catalog_query))['static']
 def roles(run):
  value=json.loads(run("select json_build_object('roles',(select json_agg(json_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig)order by rolname)from pg_roles where rolname not like 'pg_%'and rolname not in('yumidang_tls_bootstrap','yumidang_full108_bootstrap')),'members',(select json_agg(json_build_array(parent.rolname,child.rolname,m.admin_option,m.inherit_option,m.set_option)order by parent.rolname,child.rolname)from pg_auth_members m join pg_roles parent on parent.oid=m.roleid join pg_roles child on child.oid=m.member));"))
  return value
 def normalized_catalog(expected,actual,run):
  # Dump/restore reparses CHECK trees. Permit only known checks after SQL reparsing proves the exact target hash.
  checks=[]
  for before,after in zip(expected['constraints'],actual['constraints']):
   if before==after:continue
   assert before['name']in{'general_sanction_appeal_receipts_reason_check','worker_jobs_dedupe_key_check'},'UNEXPECTED_CONSTRAINT_DIFFERENCE'
   assert {k:v for k,v in before.items()if k!='definitionMd5'}=={k:v for k,v in after.items()if k!='definitionMd5'},'CONSTRAINT_METADATA_CHANGED'
   identity=before['schema']+'.'+before['table'];constraint=before['name']
   definition=source("select pg_get_constraintdef(oid,false)from pg_constraint where conrelid='"+identity+"'::regclass and conname='"+constraint+"';").decode().strip()
   actual_hash=run("begin;set local search_path=pg_catalog;create temp table recovery_check(reason text,dedupe_key text);alter table recovery_check add constraint normalized "+definition+";select md5(pg_get_constraintdef(oid,false))from pg_constraint where conrelid='pg_temp.recovery_check'::regclass and conname='normalized';rollback;").decode().strip()
   assert actual_hash==after['definitionMd5'],'CONSTRAINT_REPARSE_MISMATCH'
   before['definitionMd5']=actual_hash;checks.append(constraint)
  assert expected==actual,'APPLICATION_CATALOG_MISMATCH'
  return checks
 def tar_storage(name):return docker('exec',name,'tar','-cf','-','-C','/mnt','.')
 existing=docker('ps','-a','--format','{{.Names}}').decode().splitlines()
 if resume_storage:
  assert set(existing).intersection(database_names+storage_names)in({database_names[0]},{database_names[0],storage_names[0]}),'UNEXPECTED_RESUME_TARGETS'
  assert json.loads((root/'started.json').read_text())['targets']==database_names,'RESUME_TARGET_MISMATCH'
 else:assert not any(name in existing for name in database_names+storage_names),'EXISTING_TARGET_PRESERVED'
 existing_volumes=docker('volume','ls','--format','{{.Name}}').decode().splitlines()
 if resume_storage:assert set(existing_volumes).intersection(volumes)=={volumes[0]},'UNEXPECTED_RESUME_VOLUMES'
 else:assert not any(name in existing_volumes for name in volumes),'EXISTING_VOLUME_PRESERVED'
 source_info=json.loads(docker('inspect',t.NAME))[0]
 storage_info=json.loads(docker('inspect',storage_source))[0]
 assert source_info['Config']['Labels'].get('yumidang.owner')=='minkyu'and storage_info['Config']['Labels'].get('yumidang.owner')=='minkyu','SOURCE_OWNER_MISMATCH'
 assert storage_info['State']['Running']and source_info['State']['Running'],'SOURCE_NOT_RUNNING'
 mounts=storage_info['Mounts'];assert len(mounts)==1 and mounts[0]['Type']=='volume'and mounts[0]['Destination']=='/mnt','UNEXPECTED_STORAGE_MOUNT'
 closed(source)
 assert source("select count(*)from pg_stat_activity where datname=current_database()and backend_type='client backend'and state='active'and pid<>pg_backend_pid();").decode().strip()=='0','SOURCE_BUSY'
 before_rows=rows(source);before_catalog=catalog(source);before_roles=roles(source)
 if resume_storage:
  recorded=json.loads((root/'source-comparison-private.json').read_text())
  assert recorded=={'rows':before_rows,'catalog':before_catalog,'roles':before_roles},'SOURCE_CHANGED_SINCE_BACKUP'
  dump=(root/'source.dump').read_bytes();role_dump=(root/'roles.sql').read_bytes();archive=(root/'storage.tar').read_bytes()
  file_hashes=safe_storage_files(archive)
  assert file_hashes==safe_storage_files(tar_storage(storage_source)),'SOURCE_STORAGE_CHANGED_SINCE_BACKUP'
 else:
  save('started.json',json.dumps({'source':t.NAME,'targets':database_names,'sourceChanged':False}).encode())
  save('source-comparison-private.json',json.dumps({'rows':before_rows,'catalog':before_catalog,'roles':before_roles}).encode())
  # All write guards/leases/cron are closed. Stop only the owned isolated Storage service for a coherent backup.
  try:
   docker('stop',storage_source)
   assert rows(source)==before_rows,'SOURCE_CHANGED_BEFORE_BACKUP'
   dump=docker('exec',t.NAME,'pg_dump','-U','yumidang_tls_bootstrap','-d','postgres','-Fc')
   role_dump=docker('exec',t.NAME,'pg_dumpall','-U','yumidang_tls_bootstrap','--roles-only','--no-role-passwords')
   archive=docker('run','--rm','--network','none','--entrypoint','tar','-v',mounts[0]['Name']+':/mnt:ro',storage_info['Image'],'-cf','-','-C','/mnt','.')
   file_hashes=safe_storage_files(archive);assert file_hashes,'EMPTY_STORAGE_BACKUP'
   assert rows(source)==before_rows,'SOURCE_CHANGED_DURING_BACKUP'
  finally:
   # A stop timeout can still mean STOPPED. Read actual state before recovering this owned service.
   stopped_info=json.loads(docker('inspect',storage_source))[0]
   if not stopped_info['State']['Running']:docker('start',storage_source)
  save('source.dump',dump);save('roles.sql',role_dump);save('storage.tar',archive)
 role_sql=re.sub(r' GRANTED BY [A-Za-z_][A-Za-z0-9_]*;',';',role_dump.decode())
 role_sql='\n'.join(line for line in role_sql.splitlines()if not re.match(r'(CREATE|ALTER) ROLE yumidang_tls_bootstrap(?: |;)',line))
 env=dict(item.split('=',1)for item in storage_info['Config']['Env'])
 key=env['SERVICE_KEY'] if 'SERVICE_KEY'in env else env['SERVICE_ROLE_KEY']
 # Secrets only in private env files/stdin. Never print env, connection strings or API responses.
 def start_db(name,backup):
  docker('run','-d','--name',name,'--label','yumidang.owner=minkyu','--user','postgres','--entrypoint','sh',t.IMAGE,'-c',
    'if [ ! -f /tmp/recovery-data/PG_VERSION ]; then initdb -U '+bootstrap+" -D /tmp/recovery-data --auth-local=trust --auth-host=reject || exit 1; fi; exec postgres -D /tmp/recovery-data -c listen_addresses='*' -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off")
  for _ in range(40):
   probe=subprocess.run(t.DOCKER+['exec',name,'pg_isready','-U',bootstrap],capture_output=True,timeout=5)
   if probe.returncode==0:break
   time.sleep(.5)
  else:raise RuntimeError('RESTORE_TARGET_NOT_READY')
  dbsql(name,role_sql)
  docker('exec','-i',name,'pg_restore','-U',bootstrap,'-d','postgres','--single-transaction','--exit-on-error',data=backup)
  closed(lambda q:dbsql(name,q))
 def wait_storage_ready(name):
  # Reads only: restarting a container does not imply its HTTP listener is ready.
  for _ in range(40):
   try:
    probe=subprocess.run(t.DOCKER+['exec',name,'node','-e',"fetch('http://127.0.0.1:5000/status',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],capture_output=True,timeout=15)
   except subprocess.TimeoutExpired:
    time.sleep(.5);continue
   if probe.returncode==0:return
   time.sleep(.5)
  raise RuntimeError('STORAGE_CLONE_NOT_READY')
 def start_storage(index,storage_backup):
  dbname=database_names[index];name=storage_names[index];volume=volumes[index]
  envfile=root/(str(index)+'-storage.env')
  if resume_storage and index==0:
   dbinfo=json.loads(docker('inspect',dbname))[0];volumeinfo=json.loads(docker('volume','inspect',volume))[0]
   assert dbinfo['Config']['Labels'].get('yumidang.owner')=='minkyu'and dbinfo['State']['Running'],'RESUME_DB_OWNER_OR_STATE_MISMATCH'
   assert not dbinfo['HostConfig']['PortBindings']and not dbinfo['Mounts'],'RESUME_DB_EXPOSURE_MISMATCH'
   assert volumeinfo['Labels'].get('yumidang.owner')=='minkyu','RESUME_VOLUME_OWNER_MISMATCH'
   assert dbsql(dbname,'show ssl;').decode().strip()=='on'and envfile.is_file()and not(envfile.stat().st_mode&0o077),'RESUME_TLS_CONFIG_REQUIRED'
   partial=docker('run','--rm','--network','none','--entrypoint','tar','-v',volume+':/mnt:ro',storage_info['Image'],'-cf','-','-C','/mnt','.')
   assert not safe_storage_files(partial),'PARTIAL_VOLUME_NOT_EMPTY_INSPECT_NO_REPLAY'
  else:
   ip=json.loads(docker('inspect',dbname))[0]['NetworkSettings']['Networks']['bridge']['IPAddress']
   password=secrets.token_hex(32)
   dbsql(dbname,"alter role supabase_storage_admin password '"+password+"';")
   ext=root/(str(index)+'-server.ext')
   ext.write_text('subjectAltName=DNS:localhost,IP:'+ip+'\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\n');ext.chmod(0o600)
   call(['openssl','req','-newkey','rsa:2048','-nodes','-keyout',str(root/(str(index)+'.key')),'-out',str(root/(str(index)+'.csr')),'-subj','/CN='+ip])
   call(['openssl','x509','-req','-in',str(root/(str(index)+'.csr')),'-CA',str(t.ROOT/'ca.crt'),'-CAkey',str(t.ROOT/'ca.key'),'-set_serial',str(int(uuid.uuid4())),'-out',str(root/(str(index)+'.crt')),'-days','1','-extfile',str(ext)])
   for suffix in ('crt','key'):docker('cp',str(root/(str(index)+'.'+suffix)),dbname+':/tmp/server.'+suffix)
   docker('exec','--user','root',dbname,'chown','postgres:postgres','/tmp/server.crt','/tmp/server.key')
   docker('exec',dbname,'chmod','600','/tmp/server.key')
   docker('exec','-i',dbname,'sh','-c',"cat > /tmp/recovery-data/pg_hba.conf",data=b'local all all trust\nhostssl all supabase_storage_admin 0.0.0.0/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\n')
   dbsql(dbname,"alter system set ssl='on';alter system set ssl_cert_file='/tmp/server.crt';alter system set ssl_key_file='/tmp/server.key';select pg_reload_conf();")
   for _ in range(40):
    if dbsql(dbname,'show ssl;').decode().strip()=='on':break
    time.sleep(.5)
   else:raise RuntimeError('TLS_CLONE_NOT_READY')
   local_env={**env,'DATABASE_URL':f'postgresql://supabase_storage_admin:{password}@{ip}:5432/postgres?sslmode=verify-full&sslrootcert=/ca.crt'}
   envfile=root/(str(index)+'-storage.env');save(envfile.name,'\n'.join(k+'='+v for k,v in local_env.items()).encode())
   docker('volume','create','--label','yumidang.owner=minkyu',volume)
  safe_storage_files(storage_backup)
  docker('run','--rm','-i','--network','none','--entrypoint','tar','-v',volume+':/mnt',storage_info['Image'],'-xf','-','-C','/mnt',data=storage_backup)
  docker('run','-d','--name',name,'--label','yumidang.owner=minkyu','--env-file',str(envfile),'-v',volume+':/mnt','-v',str(t.ROOT/'ca.crt')+':/ca.crt:ro',storage_info['Image'])
  wait_storage_ready(name)
 def object_request(index,method,path,data=None):
  script="""const crypto=require('node:crypto');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',async()=>{try{const x=JSON.parse(input);const r=await fetch('http://127.0.0.1:5000'+x.path,{method:x.method,headers:{authorization:'Bearer '+x.key,'content-type':'image/png'},...(x.data?{body:Buffer.from(x.data,'base64')}:{})});const b=Buffer.from(await r.arrayBuffer());process.stdout.write(JSON.stringify({status:r.status,sha256:crypto.createHash('sha256').update(b).digest('hex')}));}catch{process.exit(1);}});"""
  if method=='GET':path='/object/authenticated/'+path.removeprefix('/object/')
  value={'key':key,'method':method,'path':path}
  if data is not None:value['data']=base64.b64encode(data).decode()
  return json.loads(docker('exec','-i',storage_names[index],'node','-e',script,data=json.dumps(value).encode()))
 if not resume_storage:start_db(database_names[0],dump)
 first=lambda q:dbsql(database_names[0],q)
 assert rows(first)==before_rows,'ALL_TABLE_RESTORE_MISMATCH'
 assert roles(first)==before_roles,'ROLE_ATTRIBUTES_OR_MEMBERSHIPS_CHANGED'
 normalized_checks=normalized_catalog(json.loads(json.dumps(before_catalog)),catalog(first),first)
 if resume_storage and storage_names[0]in existing:
  ready_storage=json.loads(docker('inspect',storage_names[0]))[0]
  assert ready_storage['Config']['Labels'].get('yumidang.owner')=='minkyu'and ready_storage['State']['Running'],'RESUME_STORAGE_NOT_READY'
  assert not ready_storage['HostConfig']['PortBindings']and ready_storage['Image']==storage_info['Image'],'RESUME_STORAGE_EXPOSURE_OR_IMAGE_CHANGED'
  assert any(m['Type']=='volume'and m['Name']==volumes[0]and m['Destination']=='/mnt'for m in ready_storage['Mounts']),'RESUME_STORAGE_VOLUME_CHANGED'
  volume_owner=json.loads(docker('volume','inspect',volumes[0]))[0]['Labels'].get('yumidang.owner')
  assert volume_owner=='minkyu','RESUME_STORAGE_VOLUME_OWNER_CHANGED'
  wait_storage_ready(storage_names[0])
 else:start_storage(0,archive)
 assert first("select count(*)from pg_stat_ssl s join pg_stat_activity a using(pid)where ssl and a.usename='supabase_storage_admin';").decode().strip()!='0','STORAGE_DB_TLS_NOT_VERIFIED'
 assert safe_storage_files(tar_storage(storage_names[0]))==file_hashes,'STORAGE_BYTES_RESTORE_MISMATCH'
 assert rows(first)==before_rows,'STORAGE_START_CHANGED_ROWS'
 png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7S8AAAAASUVORK5CYII=')
 object_name='recovery108/'+str(uuid.uuid4())+'.png';path='/object/report-evidence/'+object_name
 assert object_request(0,'POST',path,png)['status']in(200,201),'CLONE_FIXTURE_UPLOAD_FAILED'
 assert object_request(0,'GET',path)['sha256']==hashlib.sha256(png).hexdigest(),'CLONE_FIXTURE_GET_FAILED'
 # Backup before known deletion in clone only, then restore to a second fresh clone.
 docker('stop',storage_names[0])
 replay_dump=docker('exec',database_names[0],'pg_dump','-U',bootstrap,'-d','postgres','-Fc')
 replay_archive=docker('run','--rm','--network','none','--entrypoint','tar','-v',volumes[0]+':/mnt:ro',storage_info['Image'],'-cf','-','-C','/mnt','.')
 replay_rows=rows(first)
 docker('start',storage_names[0])
 wait_storage_ready(storage_names[0])
 save('before-delete.dump',replay_dump);save('before-delete-storage.tar',replay_archive)
 # First transmission only: unknown/failure is preserved and never retried.
 save('known-delete-dispatched.json',json.dumps({'bucket':'report-evidence','name':object_name,'sha256':hashlib.sha256(png).hexdigest()}).encode())
 assert object_request(0,'DELETE',path)['status']==200,'CLONE_DELETE_UNKNOWN_NO_RETRY'
 assert object_request(0,'GET',path)['status']in(400,404),'CLONE_DELETE_ABSENCE_NOT_VERIFIED'
 save('known-delete-success.json',json.dumps({'bucket':'report-evidence','name':object_name,'response':200,'sha256':hashlib.sha256(png).hexdigest()}).encode())
 start_db(database_names[1],replay_dump)
 replay=lambda q:dbsql(database_names[1],q)
 assert rows(replay)==replay_rows,'OLD_BACKUP_ALL_TABLE_MISMATCH'
 assert roles(replay)==before_roles,'OLD_BACKUP_ROLE_MISMATCH'
 normalized_catalog(json.loads(json.dumps(before_catalog)),catalog(replay),replay)
 start_storage(1,replay_archive)
 assert safe_storage_files(tar_storage(storage_names[1]))==safe_storage_files(replay_archive),'OLD_BACKUP_FILE_SHA_MISMATCH'
 assert object_request(1,'GET',path)['sha256']==hashlib.sha256(png).hexdigest(),'DELETED_FILE_NOT_REVIVED'
 save('reapply-dispatched.json',json.dumps({'knownSuccessOnly':True,'name':object_name}).encode())
 assert object_request(1,'DELETE',path)['status']==200,'REAPPLY_DELETE_UNKNOWN_NO_RETRY'
 assert object_request(1,'GET',path)['status']in(400,404),'REAPPLY_ABSENCE_NOT_VERIFIED'
 assert replay("select count(*)from storage.objects where bucket_id='report-evidence'and name='"+object_name+"';").decode().strip()=='0','REAPPLY_METADATA_REMAINS'
 assert rows(first)==rows(replay),'UNRELATED_OR_UNKNOWN_DATA_CHANGED_AFTER_DELETE'
 for name in storage_names:
  assert safe_storage_files(tar_storage(name))==file_hashes,'DELETED_STORAGE_BYTES_REMAIN_OR_UNRELATED_FILE_CHANGED'
 closed(first);closed(replay);closed(source)
 assert rows(source)==before_rows and catalog(source)==before_catalog and roles(source)==before_roles,'SOURCE_DATABASE_CHANGED'
 assert safe_storage_files(tar_storage(storage_source))==file_hashes,'SOURCE_STORAGE_CHANGED'
 receipt={'status':'PASS','scope':'ISOLATED_SQL108_DB_AND_STORAGE','allTableDataDigestsExact':True,'tableCount':len(before_rows),
  'applicationCatalogAndAclExact':True,'checkExpressionsReparsed':normalized_checks,'roleAttributesAndMembershipsExact':True,
  'storageBinaryRestore':'PASS','storageDbTlsConnectionVerified':True,'fileCount':len(file_hashes),'knownDeletedBytesRevivedAndReapplied':True,'deletedStorageBytesAbsent':True,
  'readStatesDispatchAcksAndUnknownPreserved':True,'sourceDatabaseChanged':False,'sourceStorageBytesChanged':False,
  'sourceStorageRestartedForConsistentBackup':True,'cronActiveJobs':'off','fullQueueCli':'NOT_RUN',
  'priorV2UnconfirmedDeletePreservedAndNotRetried':True,'operatingChanged':False,'dumpSha256':hashlib.sha256(dump).hexdigest(),'storageArchiveSha256':hashlib.sha256(archive).hexdigest()}
 save('receipt.json',json.dumps(receipt,ensure_ascii=False,indent=2).encode())
 print(json.dumps(receipt,ensure_ascii=False))

FINAL_SQL = {
 'backend/supabase/migrations/20261009011400_worker_intent_confirmation.sql':'7ba321e924e02bfea41a244435a21a5fc52d71e049421e178ca72a91358065ed',
 'backend/supabase/migrations/20261009011500_member_cleanup_reconcile.sql':'74a0d3b2af807310f76dd77d8769f3177ca8f47cef2161ca4b44f194bbb73081',
 'backend/supabase/migrations/20261009011600_content_inspection_tickets.sql':'a3a7abf169d4edd2d86556def9823f5f56a2072796c3a9adcc1b46e1d23b58ec',
 'backend/supabase/migrations/20261009011700_member_retirement_receipt.sql':'bfa60e1169dc3752c54a53c5a4be462af5a40ef87ccd4e8477f724230fd41456',
 'backend/supabase/migrations/20261009024414_member_cleanup_unknown_discovery.sql':'7d96eb284ff8d71685c6d3fe0379e7c3310a7dca89912bf855020920c3012e9c',
 'backend/supabase/migrations/20261009031628_event_detail_projection.sql':'8b5b4af91067276fdfd27cd7340d30ff04f94ba632b029fa274885fde0be636c',
}
FINAL_FIXED = {
 'tests/integration/minkyu/member_cleanup_reconcile_local.py':'86ef272728d4f0e4cd8150cce6733944ba95bb69ef0a7563c580db3145133cbb',
 'tests/integration/minkyu/queue_tls_environment.py':'807448169be8228636f6091e3fee96d31c47be47a16a21457a2e7d4318d31ea6',
 'tools/local/prepare_production_backend.py':'cc2108bc22d65ee8bdd1aeab9248f47dc624874e9b7051faa3df2983135cf7af',
}
FINAL_SOURCE='yumidang-minkyu-event112-20261009-v1'
FINAL_STORAGE='yumidang-minkyu-runtime103-storage'
FINAL_SCOPE='SOURCE112_PLUS_EXPLICIT_114_115_116_117_118_119_DB_ROLES_STORAGE'


def final_canonical(value):
 return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()


def final_digest(value):
 return hashlib.sha256(value).hexdigest()


def final_regular(path, *, private=False):
 import os,stat
 from pathlib import Path
 assert path.is_absolute() and path.resolve()==path,'CANONICAL_REGULAR_PATH_REQUIRED'
 assert not any(p.is_symlink()for p in (path,*path.parents)),'SYMLINK_NOT_ALLOWED'
 info=path.stat()
 assert stat.S_ISREG(info.st_mode)and info.st_nlink==1,'REGULAR_SINGLE_LINK_REQUIRED'
 if private:
  parent=path.parent.stat()
  assert info.st_uid==os.getuid()and stat.S_IMODE(info.st_mode)==0o600,'PRIVATE_FILE_REQUIRED'
  assert parent.st_uid==os.getuid()and stat.S_IMODE(parent.st_mode)==0o700 and path.is_relative_to(Path('/private/tmp')),'PRIVATE_PARENT_REQUIRED'
 return path.read_bytes()


def final_graph(path):
 import importlib.util,sys
 from pathlib import Path
 def unique(pairs):
  result={}
  for k,v in pairs:
   assert k not in result,'DUPLICATE_GRAPH_KEY'
   result[k]=v
  return result
 data=final_regular(path,private=True);graph=json.loads(data,object_pairs_hook=unique)
 keys={'version','kind','approvedByRoot','dockerSlotReady','repo','files','closedArtifact','closedBindingSha256','closedReceiptSha256','sourceIds','sourceSnapshotSha256','sourceStorageFilesSha256'}
 assert isinstance(graph,dict)and set(graph)==keys and graph['version']==1 and graph['kind']=='FINAL_DB_STORAGE_RESTORE','EXACT_FINAL_GRAPH_REQUIRED'
 assert graph['approvedByRoot']is True and graph['dockerSlotReady']is True,'ROOT_GRAPH_AND_SLOT_REQUIRED'
 repo=Path(graph['repo']);assert repo.is_absolute()and repo.resolve()==repo,'CANONICAL_REPO_REQUIRED'
 required=set(FINAL_SQL)|set(FINAL_FIXED)|{'tests/integration/minkyu/product_connection_restore108_local.py','tools/local/prepare_current_policy.py','tools/local/prepare_edge.py','tools/local/prepare_database.py','tools/local/prepare_migrations.py','tools/local/compare_schema_catalog.py','tools/local/check_api_env.py'}
 assert set(graph['files'])==required,'EXACT_DRIVER_DEPENDENCIES_REQUIRED'
 for name,digest in graph['files'].items():
  assert re.fullmatch('[a-f0-9]{64}',digest)and '..'not in Path(name).parts and not Path(name).is_absolute(),'INVALID_GRAPH_FILE'
  assert final_digest(final_regular(repo/name))==digest,'FROZEN_DEPENDENCY_CHANGED'
 for name,digest in {**FINAL_SQL,**FINAL_FIXED}.items():assert graph['files'][name]==digest,'FIXED_SOURCE_CHANGED'
 assert graph['files']['tests/integration/minkyu/product_connection_restore108_local.py']==final_digest(Path(__file__).read_bytes()),'EXECUTING_DRIVER_CHANGED'
 for key in ('closedBindingSha256','closedReceiptSha256','sourceSnapshotSha256','sourceStorageFilesSha256'):
  assert isinstance(graph[key],str)and re.fullmatch('[a-f0-9]{64}',graph[key]),'EXPECTED_DIGEST_REQUIRED'
 assert set(graph['sourceIds'])=={FINAL_SOURCE,FINAL_STORAGE,t.NAME}and all(re.fullmatch('[a-f0-9]{64}',v)for v in graph['sourceIds'].values()),'EXACT_SOURCE_IDS_REQUIRED'
 # 고정된 도구만 import하며 임의 모듈이나 환경 승인은 없다.
 sys.path.insert(0,str(repo/'tools/local'))
 import prepare_production_backend as preparation
 assert Path(preparation.__file__).resolve()==repo/'tools/local/prepare_production_backend.py','WRONG_PREPARATION_MODULE'
 directory=Path(graph['closedArtifact'])
 manifest=preparation.verify_closed_artifact(directory,graph['closedBindingSha256']);binding=manifest['binding']
 assert preparation.inspect_product_sources(repo)==binding['productSources'],'CLOSED_PRODUCT_SOURCE_CHANGED'
 assert all(binding['reviewedMigrations'].get(k)==v for k,v in FINAL_SQL.items()),'CLOSED_SQL_PREFIX_MISMATCH'
 receipt=directory.parent/'receipt.json'
 assert final_digest(final_regular(receipt,private=True))==graph['closedReceiptSha256'],'CLOSED_RECEIPT_CHANGED'
 spec=importlib.util.spec_from_file_location('final_restore_fixed_helper',repo/'tests/integration/minkyu/member_cleanup_reconcile_local.py')
 helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
 return graph,final_digest(data),binding,helper


def run_final_storage(args):
 """원본 무중단 읽기와 새 두 복제본만 사용한다. UNKNOWN은 재전송하지 않는다."""
 import base64,ipaddress,os,secrets,traceback
 from pathlib import Path,PurePosixPath
 from urllib.parse import urlsplit
 graph,graph_sha,binding,helper=final_graph(args.graph_manifest)
 assert re.fullmatch('final-v[1-9][0-9]{0,5}',args.revision),'FRESH_FINAL_REVISION_REQUIRED'
 repo=Path(graph['repo']);root=Path('/private/tmp/yumidang-final-restore-20261010-'+args.revision)
 assert not root.exists()and not root.is_symlink(),'OLD_ARTIFACTS_AND_UNKNOWN_PRESERVED'
 root.mkdir(mode=0o700);run_id=str(uuid.uuid4());prefix='yumidang-minkyu-final-'+args.revision
 owned={};network=None;source_before=None;storage_before=None;storage_db_before=None;source_sequences=None;storage_db_sequences=None;passed=False;stage='source_preflight';receipt=None
 def save(name,value):
  assert '/'not in name and '..'not in name,'PRIVATE_ARTIFACT_NAME_REQUIRED'
  data=value if isinstance(value,bytes)else final_canonical(value)
  with os.fdopen(os.open(root/name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600),'wb')as f:f.write(data)
 def call(argv,data=None,timeout=120):
  r=subprocess.run(argv,input=data,capture_output=True,timeout=timeout)
  if r.returncode:
   # stdout/stderr에 SQL/DSN/keys/원문이 있을 수 있다. 원문 저장은 하지 않는다.
   save('failure-'+str(uuid.uuid4())+'.json',{'stage':stage,'returnCode':r.returncode})
   raise RuntimeError('FINAL_RESTORE_CALL_FAILED_NO_RETRY')
  return r.stdout
 def docker(*argv,data=None):return call(t.DOCKER+list(argv),data)
 def inspect(name):return json.loads(docker('inspect',name))[0]
 def query(name,statement):
  login='yumidang_tls_bootstrap'if name==t.NAME else BOOT
  return docker('exec','-i',name,'psql','-XqAt','-U',login,'-d','postgres','-v','ON_ERROR_STOP=1',data=statement.encode())
 def helper_call(argv,data=None):
  if t.NAME in argv and '-U'in argv:
   argv=list(argv);argv[argv.index('-U')+1]='yumidang_tls_bootstrap'
  return call(argv,data)
 helper.query=query;helper.call=helper_call
 def snap(name):return helper.normalized_snapshot(name)
 def sequences(name):
  # sequence 값은 table digest/schema-only dump에 없으므로 별도 읽기 비교한다.
  names=json.loads(query(name,"select coalesce(json_agg(json_build_array(n.nspname,c.relname)order by n.nspname,c.relname),'[]')from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S'and left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema';"))
  result={}
  for schema,table in names:
   relation='"'+schema.replace('"','""')+'"."'+table.replace('"','""')+'"'
   result[schema+'.'+table]=json.loads(query(name,'select json_build_array(last_value,is_called)from '+relation+';'))
  return result
 def closed(name):
  assert_closed(lambda q:query(name,q))
  assert query(name,'show cron.launch_active_jobs;').strip()==b'off','CRON_MUST_STAY_OFF'
  for table in ('worker_invocation_control','worker_intent_confirmation_control','event_collection_control','content_inspection_control','member_retirement_receipt_control'):
   if query(name,"select to_regclass('private."+table+"');").strip():
    assert query(name,'select not enabled from private.'+table+' where singleton;').strip()==b't','GUARD_NOT_CLOSED'
  for signature in ('public.read_member_cleanup_unknown_invocations(uuid,integer)','private.project_event_source_detail(uuid)'):
   if query(name,"select to_regprocedure('"+signature+"');").strip():
    for role in ('anon','authenticated','service_role','authenticator','yumidang_worker_queue'):
     assert query(name,"select not has_function_privilege('"+role+"','"+signature+"','EXECUTE');").strip()==b't','NEW_DISCOVERY_OR_HELPER_EXEC_OPEN'
    assert query(name,"select not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid='"+signature+"'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE');").strip()==b't','NEW_RPC_PUBLIC_EXEC_OPEN'
 def idle(name):
  assert query(name,"select count(*)from pg_stat_activity where datname=current_database()and backend_type='client backend'and state='active'and pid<>pg_backend_pid();").strip()==b'0','SOURCE_ACTIVE_CLIENTS_CLONE0_FAIL'
 def identity(name):
  info=inspect(name)
  assert info['Id']==graph['sourceIds'][name]and info['Config']['Labels'].get('yumidang.owner')=='minkyu'and info['State']['Running'],'EXACT_SOURCE_OWNER_ID_RUNNING_REQUIRED'
  return info
 def storage_proof():
  info=identity(FINAL_STORAGE);env=dict(v.split('=',1)for v in info['Config']['Env']if '='in v)
  assert env.get('STORAGE_BACKEND')=='file','FILE_STORAGE_SOURCE_REQUIRED'
  mounts=info['Mounts'];assert len(mounts)==1 and mounts[0]['Type']=='volume'and mounts[0]['Destination']=='/mnt','SOURCE_STORAGE_MOUNT_REQUIRED'
  archive=docker('exec',FINAL_STORAGE,'tar','-cf','-','-C','/mnt','.')
  files=safe_storage_files(archive);assert files,'SOURCE_STORAGE_EMPTY'
  proof={'id':info['Id'],'image':info['Image'],'envSha256':final_digest(final_canonical(info['Config']['Env'])),'hostConfigSha256':final_digest(final_canonical(info['HostConfig'])),'mounts':mounts,'files':files}
  return proof,env,archive
 def source_info_proof(name):
  x=identity(name)
  return {'id':x['Id'],'image':x['Image'],'envSha256':final_digest(final_canonical(x['Config']['Env'])),'mounts':x['Mounts'],'hostConfigSha256':final_digest(final_canonical(x['HostConfig']))}
 def memory(phase,minimum=1024):
  text=docker('exec',FINAL_SOURCE,'cat','/proc/meminfo').decode()
  found=re.findall(r'^MemAvailable:\s+([0-9]+) kB$',text,re.M)
  assert len(found)==1,'MEMORY_MEASUREMENT_REQUIRED'
  amount=int(found[0]);save('memory-'+phase+'.json',{'availableKiB':amount,'minimumMiB':minimum,'maxActiveDbStoragePairs':1})
  assert amount>=minimum*1024,'MEMORY_LOW_NO_NEW_START'
 def own_inspect(name):
  x=inspect(name);labels=x['Config'].get('Labels')or{}
  assert labels.get('yumidang.owner')=='minkyu'and labels.get('yumidang.recipe')=='final-restore'and labels.get('yumidang.run_id')==run_id,'UNOWNED_TARGET_NO_STOP'
  assert owned[name]is None or x['Id']==owned[name],'OWNED_TARGET_REPLACED'
  owned[name]=x['Id'];return x
 def labels():return ['--label','yumidang.owner=minkyu','--label','yumidang.recipe=final-restore','--label','yumidang.run_id='+run_id]
 def stop(name):
  x=own_inspect(name)
  if x['State']['Running']:docker('stop',x['Id'])
  x=own_inspect(name);assert not x['State']['Running']and not x['State']['OOMKilled'],'OWN_STOP_OR_MEMORY_FAILURE'
 def new_network():
  ids=docker('network','ls','-q').decode().split();used=[]
  if ids:
   for x in json.loads(docker('network','inspect',*ids)):
    for c in x.get('IPAM',{}).get('Config')or[]:
     if c.get('Subnet'):used.append(ipaddress.ip_network(c['Subnet'],strict=False))
  candidates=(ipaddress.ip_network('10.'+str(b)+'.'+str(i)+'.0/29')for b in range(231,240)for i in range(256))
  subnet=next((n for n in candidates if not any(n.overlaps(x)for x in used if x.version==4)),None)
  assert subnet is not None,'NO_FRESH_NONOVERLAPPING_SUBNET'
  name=prefix+'-net';save('network-intent.json',{'name':name,'subnet':str(subnet),'runId':run_id});docker('network','create','--internal','--subnet',str(subnet),*labels(),name)
  save('network.json',{'name':name,'subnet':str(subnet),'globalPrune':False});return name
 def roles_restore(name,role_dump):
  # 원 bootstrap 이름/속성을 유지하며 membership GRANTED BY도 그대로 복원한다.
  sql_text='\n'.join(line for line in role_dump.decode().splitlines()if not re.match(r'CREATE ROLE '+re.escape(BOOT)+r'(?: |;)',line))
  query(name,sql_text)
 def start_db(index,dump,role_dump):
  name=prefix+'-db'+str(index);memory('db'+str(index));owned[name]=None
  save('launch-db'+str(index)+'.json',{'name':name,'runId':run_id})
  raw=docker('run','-d','--pull=never','--network=none','--no-healthcheck','--memory','512m','--name',name,*labels(),'--user','postgres','--entrypoint','sh',t.IMAGE,'-c',
   'initdb -U '+BOOT+" -D /tmp/final-data --auth-local=trust --auth-host=reject && exec postgres -D /tmp/final-data -c listen_addresses='*' -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off -c shared_buffers=16MB -c max_connections=40")
  owned[name]=raw.decode().strip();assert re.fullmatch('[a-f0-9]{64}',owned[name]),'NEW_DB_ID_REQUIRED'
  for _ in range(60):
   p=subprocess.run(t.DOCKER+['exec',name,'pg_isready','-U',BOOT,'-d','postgres'],capture_output=True,timeout=5)
   if p.returncode==0:break
   time.sleep(.25)
  else:raise RuntimeError('NEW_DB_NOT_READY_NO_RESTART')
  roles_restore(name,role_dump);docker('exec','-i',name,'pg_restore','-U',BOOT,'-d','postgres','--single-transaction','--exit-on-error',data=dump)
  x=own_inspect(name);assert not x['Mounts']and not x['HostConfig'].get('PortBindings')and x['HostConfig']['NetworkMode']=='none','NEW_DB_ISOLATION_CHANGED'
  assert x['HostConfig']['Memory']==512*1024*1024 and x['Config']['Healthcheck']['Test']==['NONE'],'NEW_DB_CAPS_CHANGED'
  closed(name);return name
 def new_ca():
  call(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(root/'ca.key'),'-out',str(root/'ca.crt'),'-days','1','-subj','/CN=final-local-only','-addext','basicConstraints=critical,CA:TRUE'])
  for p in (root/'ca.key',root/'ca.crt'):p.chmod(0o600)
 def start_storage(index,dbname,archive,env,storage_image):
  memory('storage'+str(index),768);alias='final-db'+str(index);docker('network','connect','--alias',alias,network,dbname)
  password=secrets.token_hex(32);query(dbname,"alter role supabase_storage_admin password '"+password+"';")
  ext='leaf'+str(index)+'.ext';save(ext,('subjectAltName=DNS:'+alias+'\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:false\n').encode())
  call(['openssl','req','-newkey','rsa:2048','-nodes','-keyout',str(root/('leaf'+str(index)+'.key')),'-out',str(root/('leaf'+str(index)+'.csr')),'-subj','/CN='+alias])
  call(['openssl','x509','-req','-in',str(root/('leaf'+str(index)+'.csr')),'-CA',str(root/'ca.crt'),'-CAkey',str(root/'ca.key'),'-set_serial',str(int(uuid.uuid4())),'-out',str(root/('leaf'+str(index)+'.crt')),'-days','1','-extfile',str(root/ext)])
  for suffix in ('key','csr','crt'):(root/('leaf'+str(index)+'.'+suffix)).chmod(0o600)
  for suffix in ('key','crt'):docker('cp',str(root/('leaf'+str(index)+'.'+suffix)),dbname+':/tmp/server.'+suffix)
  docker('exec','--user','root',dbname,'chown','postgres:postgres','/tmp/server.key','/tmp/server.crt');docker('exec',dbname,'chmod','600','/tmp/server.key')
  docker('exec','-i',dbname,'sh','-c','cat > /tmp/final-data/pg_hba.conf',data=b'local all all trust\nhostssl postgres supabase_storage_admin 0.0.0.0/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n')
  query(dbname,"alter system set ssl='on';alter system set ssl_cert_file='/tmp/server.crt';alter system set ssl_key_file='/tmp/server.key';select pg_reload_conf();")
  for _ in range(40):
   if query(dbname,'show ssl;').strip()==b'on':break
   time.sleep(.25)
  else:raise RuntimeError('CLONE_TLS_REQUIRED')
  volume=prefix+'-files'+str(index);save('volume-intent'+str(index)+'.json',{'name':volume,'runId':run_id});docker('volume','create',*labels(),volume)
  volume_info=json.loads(docker('volume','inspect',volume))[0]
  assert all(volume_info['Labels'].get(k)==v for k,v in {'yumidang.owner':'minkyu','yumidang.recipe':'final-restore','yumidang.run_id':run_id}.items()),'UNOWNED_VOLUME_NO_EXTRACTION'
  utility=prefix+'-extract'+str(index);owned[utility]=None
  docker('run','--pull=never','--network=none','--no-healthcheck','--memory','64m','--name',utility,*labels(),'-i','--entrypoint','tar','--mount','type=volume,src='+volume+',dst=/mnt',storage_image,'-xf','-','-C','/mnt',data=archive)
  own_inspect(utility);stop(utility)
  clone_env={**env,'DATABASE_URL':'postgresql://supabase_storage_admin:'+password+'@'+alias+':5432/postgres?sslmode=verify-full&sslrootcert=/certs/ca.crt','NODE_EXTRA_CA_CERTS':'/certs/ca.crt','NODE_OPTIONS':'--max-old-space-size=128','POSTGREST_URL':'http://127.0.0.1:1','ENABLE_IMAGE_TRANSFORMATION':'false','S3_PROTOCOL_ENABLED':'false'}
  clone_env.pop('JWT_JWKS',None)
  assert all('\n'not in k+v and '\r'not in k+v and '\0'not in k+v for k,v in clone_env.items()),'SINGLE_LINE_PRIVATE_ENV_REQUIRED'
  envname='storage'+str(index)+'.env';save(envname,('\n'.join(k+'='+v for k,v in clone_env.items())+'\n').encode())
  name=prefix+'-storage'+str(index);owned[name]=None
  raw=docker('run','-d','--pull=never','--network',network,'--no-healthcheck','--memory','512m','--name',name,*labels(),'--env-file',str(root/envname),'--mount','type=volume,src='+volume+',dst=/mnt','--mount','type=bind,src='+str(root/'ca.crt')+',dst=/certs/ca.crt,readonly',storage_image)
  owned[name]=raw.decode().strip();assert re.fullmatch('[a-f0-9]{64}',owned[name]),'NEW_STORAGE_ID_REQUIRED'
  for _ in range(60):
   p=subprocess.run(t.DOCKER+['exec',name,'node','-e',"fetch('http://127.0.0.1:5000/status',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],capture_output=True,timeout=5)
   if p.returncode==0:break
   time.sleep(.5)
  else:raise RuntimeError('NEW_STORAGE_NOT_READY_NO_MUTATION')
  x=own_inspect(name);assert not x['HostConfig'].get('PortBindings')and x['HostConfig']['Memory']==512*1024*1024 and x['Config']['Healthcheck']['Test']==['NONE'],'STORAGE_CAPS_OR_EXPOSURE_CHANGED'
  assert len(x['Mounts'])==2 and any(m['Type']=='volume'and m['Name']==volume and m['Destination']=='/mnt'for m in x['Mounts'])and any(m['Type']=='bind'and m['Source']==str(root/'ca.crt')and m['Destination']=='/certs/ca.crt'and m['RW']is False for m in x['Mounts']),'STORAGE_MOUNTS_CHANGED'
  assert query(dbname,"select count(*)from pg_stat_ssl s join pg_stat_activity a using(pid)where s.ssl and a.usename='supabase_storage_admin';").strip()!=b'0','ACTUAL_STORAGE_DB_TLS_REQUIRED'
  return name
 def files(name):return safe_storage_files(docker('exec',name,'tar','-cf','-','-C','/mnt','.'))
 def request(name,method,path,key,data=None):
  script="""const c=require('node:crypto');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',async()=>{try{const x=JSON.parse(s);const r=await fetch('http://127.0.0.1:5000'+x.path,{method:x.method,headers:{authorization:'Bearer '+x.key,'content-type':'image/png'},...(x.data?{body:Buffer.from(x.data,'base64')}:{}) ,redirect:'error',signal:AbortSignal.timeout(10000)});const b=Buffer.from(await r.arrayBuffer());let missing=r.status===404;try{const j=JSON.parse(b);missing=missing||(r.status===400&&String(j.statusCode)==='404'&&j.error==='not_found')}catch{}process.stdout.write(JSON.stringify({status:r.status,sha256:c.createHash('sha256').update(b).digest('hex'),missing}));}catch{process.exit(1)}});"""
  if method=='GET':path='/object/authenticated/'+path.removeprefix('/object/')
  value={'method':method,'path':path,'key':key}
  if data is not None:value['data']=base64.b64encode(data).decode()
  return json.loads(docker('exec','-i',name,'node','-e',script,data=final_canonical(value)))
 try:
  save('approved-graph-private.json',graph);memory('before-source-backup')
  source_infos={n:source_info_proof(n)for n in (FINAL_SOURCE,t.NAME)}
  assert not inspect(FINAL_SOURCE)['Mounts']and not inspect(FINAL_SOURCE)['HostConfig'].get('PortBindings'),'SOURCE112_EXPOSURE_CHANGED'
  for n in (FINAL_SOURCE,t.NAME):closed(n);idle(n)
  for marker in ('worker_intent_confirmation_control','member_cleanup_reconciliations','content_inspection_control','member_retirement_receipt_control'):
   assert not query(FINAL_SOURCE,"select to_regclass('private."+marker+"');").strip(),'SOURCE_NOT112_PREFIX'
  assert query(FINAL_SOURCE,"select to_regclass('private.event_invocation_references')is not null and to_regprocedure('public.read_member_cleanup_unknown_invocations(uuid,integer)')is null and to_regprocedure('private.project_event_source_detail(uuid)')is null;").strip()==b't','SOURCE112_MARKERS_REQUIRED'
  source_before=snap(FINAL_SOURCE);storage_db_before=snap(t.NAME)
  source_sequences=sequences(FINAL_SOURCE);storage_db_sequences=sequences(t.NAME)
  save('source-sequences-private.json',source_sequences);save('storage-db-sequences-private.json',storage_db_sequences)
  assert len(source_before['rows'])==186 and final_digest(final_canonical(source_before))==graph['sourceSnapshotSha256'],'FROZEN_SOURCE112_SNAPSHOT_REQUIRED'
  storage_before,env,archive=storage_proof();assert final_digest(final_canonical(storage_before['files']))==graph['sourceStorageFilesSha256'],'FROZEN_STORAGE_BYTES_REQUIRED'
  host=urlsplit(env['DATABASE_URL']).hostname;old_info=identity(t.NAME)
  hosts={t.NAME}|{n['IPAddress']for n in old_info['NetworkSettings']['Networks'].values()}
  assert host in hosts,'STORAGE_DB_SOURCE_RELATION_UNPROVEN'
  storage_rows={k:v for k,v in source_before['rows'].items()if k.startswith('storage.')}
  assert storage_rows=={k:v for k,v in storage_db_before['rows'].items()if k.startswith('storage.')},'SOURCE_STORAGE_METADATA_MISMATCH_CLONE0'
  objects=json.loads(query(FINAL_SOURCE,"select coalesce(json_agg(json_build_array(bucket_id,name,version)order by bucket_id,name,version),'[]')from storage.objects;"))
  expected={str(PurePosixPath(env['TENANT_ID'])/b/n/v)for b,n,v in objects if v is not None}
  assert set(storage_before['files'])<=expected,'ORPHAN_SOURCE_BYTES_RELATION_UNPROVEN'
  save('source-relation-private.json',{'sourceInfos':source_infos,'storage':storage_before,'storageTables':storage_rows,'metadataObjects':len(objects),'actualFiles':len(storage_before['files']),'metadataWithoutBytes':len(expected-set(storage_before['files'])),'baselineMissingPreservedNotRepaired':True})
  save('source-before-private.json',source_before);save('storage-db-before-private.json',storage_db_before)
  for n in (FINAL_SOURCE,t.NAME):closed(n);idle(n)
  dump=docker('exec',FINAL_SOURCE,'pg_dump','-U',BOOT,'-d','postgres','-Fc');role_dump=docker('exec',FINAL_SOURCE,'pg_dumpall','-U',BOOT,'--roles-only','--no-role-passwords')
  assert not re.search(rb"\bPASSWORD\s+'",role_dump,re.I),'ROLE_PASSWORDS_NOT_BACKED_UP'
  assert snap(FINAL_SOURCE)==source_before and snap(t.NAME)==storage_db_before and sequences(FINAL_SOURCE)==source_sequences and sequences(t.NAME)==storage_db_sequences and storage_proof()[0]==storage_before,'QUIESCENT_SOURCE_CHANGED_CLONE0'
  for n in (FINAL_SOURCE,t.NAME):closed(n);idle(n)
  save('source.dump',dump);save('roles.sql',role_dump);save('source-storage.tar',archive)
  existing=docker('ps','-a','--format','{{.Names}}').decode().splitlines();assert not any(n.startswith(prefix+'-')for n in existing),'OLD_RECIPE_TARGET_PRESERVED'
  volumes=docker('volume','ls','--format','{{.Name}}').decode().splitlines();assert not any(n.startswith(prefix+'-')for n in volumes),'OLD_VOLUMES_PRESERVED'
  docker('image','inspect',t.IMAGE);docker('image','inspect',storage_before['image'])
  stage='restore_source';first=start_db(1,dump,role_dump);assert snap(first)==source_before and sequences(first)==source_sequences,'FULL_SOURCE_ROLE_GRANTOR_SEQUENCE_RESTORE_MISMATCH'
  stage='apply_prefix'
  for i,(name,digest)in enumerate(FINAL_SQL.items()):
   data=final_regular(repo/name);assert final_digest(data)==digest,'SQL_FROZEN_PREFIX_CHANGED'
   save('apply-intent-'+str(i)+'.json',{'path':name,'sha256':digest,'newCloneOnly':True})
   query(first,data.decode());closed(first)
   save('apply-success-'+str(i)+'.json',{'path':name,'sha256':digest})
  # 117가 추가한 generated fingerprint 한 열만 명시적으로 원행 비교에서 제외한다.
  final_before=snap(first);existing_rows=dict(final_before['rows'])
  existing_rows['private.member_retirements']=query(first,"select count(*)||':'||md5(coalesce(string_agg((to_jsonb(x)-'request_fingerprint')::text,','order by(to_jsonb(x)-'request_fingerprint')::text),''))from private.member_retirements x;").decode().strip()
  assert all(existing_rows.get(k)==v for k,v in source_before['rows'].items()),'PREFIX_CHANGED_ORIGINAL_OR_UNKNOWN_ROWS'
  assert final_before['roles']==source_before['roles'],'PREFIX_CHANGED_SOURCE_ROLES_GRANTORS'
  final_sequences=sequences(first);assert all(final_sequences.get(k)==v for k,v in source_sequences.items()),'PREFIX_CHANGED_ORIGINAL_SEQUENCES'
  save('final-schema-before-fixture-private.json',final_before)
  save('final-sequences-before-fixture-private.json',final_sequences)
  stage='clone_storage';network=new_network();new_ca();first_storage=start_storage(1,first,archive,env,storage_before['image'])
  assert snap(first)==final_before and sequences(first)==final_sequences and files(first_storage)==storage_before['files'],'CLONE_STORAGE_START_CHANGED_BACKUP_BASELINE'
  key=env.get('SERVICE_KEY')or env['SERVICE_ROLE_KEY'];object_name='final-recovery/'+str(uuid.uuid4())+'.png';path='/object/report-evidence/'+object_name
  png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7S8AAAAASUVORK5CYII=');png_sha=final_digest(png)
  stage='synthetic_clone_upload';save('upload-intent.json',{'freshCloneOnly':True,'object':object_name,'sha256':png_sha})
  assert request(first_storage,'POST',path,key,png)['status']in(200,201),'UPLOAD_UNKNOWN_NO_RETRY'
  assert request(first_storage,'GET',path,key)['sha256']==png_sha,'UPLOAD_BYTES_NOT_PROVEN'
  stop(first_storage);pre_delete=snap(first);pre_delete_sequences=sequences(first)
  save('final-sequences-before-delete-private.json',pre_delete_sequences)
  replay_dump=docker('exec',first,'pg_dump','-U',BOOT,'-d','postgres','-Fc')
  # 정지된 자기 volume만 읽는 별도 utility는 network-none이며 앱 재기동이 아니다.
  utility=prefix+'-archive';owned[utility]=None
  replay_archive=docker('run','--pull=never','--network=none','--no-healthcheck','--memory','64m','--name',utility,*labels(),'--entrypoint','tar','--mount','type=volume,src='+prefix+'-files1,dst=/mnt,readonly',storage_before['image'],'-cf','-','-C','/mnt','.')
  own_inspect(utility);stop(utility);safe_storage_files(replay_archive)
  assert snap(first)==pre_delete and sequences(first)==pre_delete_sequences,'CLONE_CHANGED_DURING_FINAL_BACKUP'
  save('final-before-delete.dump',replay_dump);save('final-before-delete-storage.tar',replay_archive)
  docker('start',owned[first_storage])
  # 재시작 뒤 준비 확인은 GET-only이며 DELETE intent 전이다.
  for _ in range(30):
   try:
    if request(first_storage,'GET',path,key)['sha256']==png_sha:break
   except (RuntimeError,subprocess.TimeoutExpired):pass
   time.sleep(.5)
  else:raise RuntimeError('READINESS_FAILED_NO_DELETE')
  stage='known_delete';save('known-delete-intent.json',{'object':object_name,'sha256':png_sha,'freshCloneOnly':True})
  assert request(first_storage,'DELETE',path,key)['status']==200,'DELETE_UNKNOWN_PRESERVED_NO_RETRY'
  assert request(first_storage,'GET',path,key)['missing'],'DELETE_ABSENCE_NOT_PROVEN'
  assert query(first,"select count(*)from storage.objects where bucket_id='report-evidence'and name='"+object_name+"';").strip()==b'0'and files(first_storage)==storage_before['files'],'DELETED_BYTES_OR_METADATA_REMAIN'
  known={'object':object_name,'bucket':'report-evidence','sha256':png_sha,'response':200,'absenceAndMetadataAndBytesProven':True,'scope':'SYNTHETIC_MANUAL_STORAGE_API_NOT_PRODUCT_ACK'};save('known-delete-success.json',known)
  first_result=snap(first);assert first_result==final_before and sequences(first)==final_sequences,'KNOWN_DELETE_CHANGED_BASELINE_OR_UNKNOWN'
  stop(first_storage);closed(first);stop(first)
  stage='old_final_backup_restore';second=start_db(2,replay_dump,role_dump);assert snap(second)==pre_delete and sequences(second)==pre_delete_sequences,'FINAL_BACKUP_FULL_ROWS_CATALOG_ROLES_GRANTORS_SEQUENCES_MISMATCH'
  second_storage=start_storage(2,second,replay_archive,env,storage_before['image'])
  assert files(second_storage)==safe_storage_files(replay_archive)and request(second_storage,'GET',path,key)['sha256']==png_sha,'KNOWN_DELETED_BYTES_NOT_REVIVED'
  stage='known_reapply';assert json.loads(final_regular(root/'known-delete-success.json',private=True))==known,'KNOWN_SUCCESS_PROOF_CHANGED'
  save('reapply-intent.json',{'knownSuccessOnly':True,'object':object_name,'sha256':png_sha,'restoreCloneOnly':True})
  assert request(second_storage,'DELETE',path,key)['status']==200,'REAPPLY_UNKNOWN_NO_RETRY'
  assert request(second_storage,'GET',path,key)['missing'],'REAPPLY_ABSENCE_NOT_PROVEN'
  assert query(second,"select count(*)from storage.objects where bucket_id='report-evidence'and name='"+object_name+"';").strip()==b'0','REAPPLY_METADATA_REMAINS'
  assert files(second_storage)==storage_before['files']and snap(second)==first_result and sequences(second)==final_sequences,'REAPPLY_CHANGED_UNRELATED_OR_UNKNOWN_ROWS_BYTES_SEQUENCES'
  save('restored-after-reapply-private.json',snap(second));closed(second)
  assert final_graph(args.graph_manifest)[1]==graph_sha,'ROOT_GRAPH_OR_CLOSED_BUNDLE_CHANGED'
  passed=True;receipt={'status':'PASS','scope':FINAL_SCOPE,'full118SchemaClaimed':False,'graphSha256':graph_sha,'closedBindingSha256':graph['closedBindingSha256'],'closedProductSha256':binding['productSourcesSha256'],'closedMigrationManifestSha256':binding['migrationManifestSha256'],'appliedSqlSha256':FINAL_SQL,'sourceTables':186,'restoredFinalTables':len(pre_delete['rows']),'storageFiles':len(storage_before['files']),'metadataWithoutBytesPreserved':len(expected-set(storage_before['files'])),'roleAttributesMembershipsAndGrantorsExact':True,'rolePasswords':'EXCLUDED_NEW_CLONE_STORAGE_SECRET_ONLY','sourceDumpSha256':final_digest(dump),'rolesDumpSha256':final_digest(role_dump),'finalBackupDumpSha256':final_digest(replay_dump),'storageArchiveSha256':final_digest(replay_archive),'knownSuccessListSha256':final_digest(final_canonical(known)),'knownSuccessRevivedAndReapplied':True,'unknownReadStatesTasksDispatchAndAcksPreserved':True,'sourceStopRestartOrWrite':0,'actualProductFirstDeleteAndAck':'NOT_RUN_MANUAL_CLONE_FILE_FIXTURE','operatingActivation':'NOT_RUN'}
  receipt.update({'sourceSequenceDataExact':True,'finalSequenceDataRestoredExact':True,'sourceSequencesSha256':final_digest(final_canonical(source_sequences)),'finalBackupSequencesSha256':final_digest(final_canonical(pre_delete_sequences)),'ownCloneStorageRestartedAfterBackup':True})
 except BaseException as error:
  save('failure-frames-private.json',{'stage':stage,'type':type(error).__name__,'frames':[{'file':Path(f.filename).name,'line':f.lineno,'function':f.name}for f in traceback.extract_tb(error.__traceback__)]})
  raise
 finally:
  same=False;all_stopped=True;all_closed=True
  try:
   if source_before is not None and storage_db_before is not None and storage_before is not None:
    after=snap(FINAL_SOURCE);old_after=snap(t.NAME);proof=storage_proof()[0]
    same=after==source_before and old_after==storage_db_before and sequences(FINAL_SOURCE)==source_sequences and sequences(t.NAME)==storage_db_sequences and proof==storage_before and all(source_info_proof(n)==v for n,v in source_infos.items())
    for n in (FINAL_SOURCE,t.NAME):closed(n);idle(n)
    save('source-after-private.json',after);save('storage-db-after-private.json',old_after)
  except BaseException:passed=False
  for name in reversed(list(owned)):
   try:
    x=own_inspect(name)
    if '-db'in name and x['State']['Running']:
     try:closed(name)
     except BaseException:all_closed=False
    stop(name)
   except BaseException:all_stopped=False
  save('finalization.json',{'passed':passed,'sourceWholeUnchanged':same,'allOwnedStopped':all_stopped,'allCloneGuardsClosed':all_closed,'ownedIds':owned,'sourceStopRestartWrite':0,'failedArtifactsAndUnknownPreserved':True})
 assert passed and same and all_stopped and all_closed,'FINAL_RESTORE_CLOSURE_NOT_PROVEN'
 save('receipt.json',receipt);print(json.dumps({'status':'PASS','scope':FINAL_SCOPE,'sourceTables':186,'sourceWholeUnchanged':True,'allOwnedStopped':True,'full118SchemaClaimed':False}))


def final_main(argv):
 import argparse
 from pathlib import Path
 p=argparse.ArgumentParser(description='최종 DB/역할/Storage 새 복원 분기. 기본은 계획만 출력한다.')
 p.add_argument('--final-storage',action='store_true',required=True);p.add_argument('--run',action='store_true');p.add_argument('--revision',default='final-v1');p.add_argument('--graph-manifest',type=Path)
 args=p.parse_args(argv)
 if not args.run:
  print(json.dumps({'status':'NOT_RUN','scope':FINAL_SCOPE,'sourceDb':FINAL_SOURCE,'sourceStorage':FINAL_STORAGE,'storageDb':t.NAME,'sourceTables':186,'requiredSql':FINAL_SQL,'requiredFixedHelpers':FINAL_FIXED,'rootGraphAndSlotRequired':True,'sourceStopRestartWrite':0,'wholeSourceRelationAndQuiescenceRequired':True,'metadataMissingBytesPreservedNotRepaired':True,'maxActiveDbStoragePairs':1,'memoryMinimumMiB':1024,'dbMemoryMiB':512,'storageMemoryMiB':512,'storageHeapMiB':128,'noHealthcheck':True,'full118SchemaClaimed':False,'unknownReplay':0}));return
 assert args.graph_manifest is not None,'APPROVED_GRAPH_REQUIRED'
 try:run_final_storage(args)
 except Exception:
  print(json.dumps({'status':'FAIL_PRESERVED','scope':FINAL_SCOPE,'sourceStopRestartWrite':0,'rawErrorsStored':False}));raise SystemExit(1)


PLATFORM_IMAGES={
 'db':'public.ecr.aws/supabase/postgres:17.6.1.165',
 'auth':'public.ecr.aws/supabase/gotrue:v2.196.0',
 'storage':'public.ecr.aws/supabase/storage-api:v1.70.3',
}
PLATFORM_UPSTREAM={
 'db':'73119f8bfae2bfb07ddfa18240ab8e5f56f737a8',
 'auth':'0204331ca41a5b49f076b6fa3dc6c0d20b996590',
 'storage':'288dd95c4c06f3df72a2369ea5196a8e400aeed7',
}
PLATFORM_PREFIXES={
 'db':('docker-entrypoint-initdb.d/','etc/postgresql/','etc/postgresql-custom/'),
 'auth':('usr/local/etc/auth/migrations/',),
 'storage':('app/migrations/','app/dist/'),
}
PLATFORM_EXACT={
 'db':('usr/local/bin/docker-entrypoint.sh','etc/postgresql.schema.sql'),
 'auth':('usr/local/bin/auth',),
 'storage':('app/package.json','app/package-lock.json'),
}
PLATFORM_SETTINGS=('DB_INSTALL_ROLES','DB_SUPER_USER','DB_ANON_ROLE',
 'DB_AUTHENTICATED_ROLE','DB_SERVICE_ROLE','DB_ALLOW_MIGRATION_REFRESH',
 'DB_MIGRATIONS_FREEZE_AT','DB_MIGRATIONS_STRATEGY','DATABASE_SEARCH_PATH',
 'DB_SEARCH_PATH','DATABASE_POSTGRES_VERSION','DATABASE_ENGINE',
 'IS_MULTITENANT','MULTITENANT','VECTOR_ENABLED','VECTOR_BUCKET_PROVIDER',
 'VECTOR_STORE_MIGRATIONS_ENABLED','VECTOR_DATABASE_CREATE','ICEBERG_ENABLED',
 'PG_QUEUE_ENABLE','ENABLE_QUEUE_EVENTS','PG_QUEUE_WORKERS_ENABLE')
PLATFORM_OWNER_QUERY="""with owners as(
 select jsonb_build_object('schema',n.nspname,'name',c.relname,'kind','table','owner',pg_get_userbyid(c.relowner),
 'acl',c.relacl::text,'securityDefiner',null,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'config',null)o,c.relowner owner_oid
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname in('public','private')and c.relkind in('r','p')
 union all select jsonb_build_object('schema',n.nspname,'name',p.oid::regprocedure::text,'kind','function','owner',pg_get_userbyid(p.proowner),
 'acl',p.proacl::text,'securityDefiner',p.prosecdef,'rls',null,'forceRls',null,'config',p.proconfig),p.proowner
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private'))
 select jsonb_build_object(
 'roleName',r.rolname,
 'roleAttributes',jsonb_build_object('rolname',r.rolname,'rolsuper',r.rolsuper,
 'rolinherit',r.rolinherit,'rolcreaterole',r.rolcreaterole,'rolcreatedb',r.rolcreatedb,
 'rolcanlogin',r.rolcanlogin,'rolreplication',r.rolreplication,'rolbypassrls',r.rolbypassrls,
 'rolconnlimit',r.rolconnlimit,'rolvaliduntil',r.rolvaliduntil,'rolconfig',r.rolconfig),
 'ownerRoles',(select jsonb_agg(jsonb_build_object('rolname',r2.rolname,'rolsuper',r2.rolsuper,
 'rolinherit',r2.rolinherit,'rolcreaterole',r2.rolcreaterole,'rolcreatedb',r2.rolcreatedb,
 'rolcanlogin',r2.rolcanlogin,'rolreplication',r2.rolreplication,'rolbypassrls',r2.rolbypassrls,
 'rolconnlimit',r2.rolconnlimit,'rolvaliduntil',r2.rolvaliduntil,'rolconfig',r2.rolconfig)order by r2.rolname)
 from pg_roles r2 where r2.oid in(select owner_oid from owners)),
 'objects',(select jsonb_agg(o order by o->>'schema',o->>'name',o->>'kind')from owners))
 from pg_roles r where r.oid=(select relowner from pg_class where oid='public.profiles'::regclass);"""


def platform_json(raw):
 def pairs(items):
  result={}
  for key,value in items:
   assert key not in result,'DUPLICATE_PLATFORM_JSON_KEY'
   result[key]=value
  return result
 return json.loads(raw,object_pairs_hook=pairs)


def platform_open(path):
 import os,stat
 from pathlib import Path
 assert isinstance(path,Path)and path.is_absolute()and path.resolve()==path and path.is_relative_to(Path('/private/tmp')),'PRIVATE_CANONICAL_INPUT_REQUIRED'
 assert not any(p.is_symlink()for p in (path,*path.parents)),'PLATFORM_SYMLINK_INPUT_REFUSED'
 parent=path.parent.stat()
 assert parent.st_uid==os.getuid()and stat.S_IMODE(parent.st_mode)==0o700,'PLATFORM_PRIVATE_PARENT_REQUIRED'
 descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  info=os.fstat(descriptor)
  assert stat.S_ISREG(info.st_mode)and info.st_nlink==1 and info.st_uid==os.getuid()and stat.S_IMODE(info.st_mode)==0o600,'PLATFORM_PRIVATE_REGULAR_REQUIRED'
  return os.fdopen(descriptor,'rb')
 except BaseException:
  os.close(descriptor);raise


def platform_hash_stream(stream,maximum=8*1024*1024*1024):
 digest=hashlib.sha256();size=0
 while True:
  block=stream.read(1024*1024)
  if not block:break
  size+=len(block);assert size<=maximum,'PLATFORM_STREAM_SIZE_LIMIT';digest.update(block)
 return digest.hexdigest()


def platform_name(name):
 from pathlib import PurePosixPath
 assert isinstance(name,str)and '\x00'not in name and '\\'not in name and not name.startswith('/'),'PLATFORM_ARCHIVE_PATH_REFUSED'
 while name.startswith('./'):name=name[2:]
 name=name.rstrip('/')
 assert name and all(p not in ('','.','..')for p in name.split('/'))and str(PurePosixPath(name))==name,'PLATFORM_ARCHIVE_ESCAPE_REFUSED'
 return name


def platform_selected(kind,name):
 return name in PLATFORM_EXACT[kind]or any(name.startswith(prefix)for prefix in PLATFORM_PREFIXES[kind])


def platform_oci_identity(data,inspection,saved,config_sha):
 index_type='application/vnd.oci.image.index.v1+json'
 manifest_type='application/vnd.oci.image.manifest.v1+json'
 config_type='application/vnd.oci.image.config.v1+json'
 layer_types=('application/vnd.oci.image.layer.v1.tar','application/vnd.oci.image.layer.v1.tar+gzip')
 def descriptor(value,expected_type,maximum):
  assert isinstance(value,dict)and value.get('mediaType')in expected_type,'EXACT_OCI_MEDIA_TYPE_REQUIRED'
  assert re.fullmatch('sha256:[a-f0-9]{64}',value.get('digest',''))and type(value.get('size'))is int and 0<value['size']<=maximum,'EXACT_OCI_DESCRIPTOR_REQUIRED'
  return value
 def blob(value):
  raw=data('blobs/sha256/'+value['digest'][7:],value['size'])
  assert len(raw)==value['size']and 'sha256:'+final_digest(raw)==value['digest'],'OCI_BLOB_DIGEST_SIZE_MISMATCH'
  return platform_json(raw)
 root=descriptor(inspection.get('Descriptor'),(index_type,),4*1024*1024)
 assert root['digest']==inspection['Id'],'OCI_INSPECT_ROOT_ID_MISMATCH'
 index=blob(root)
 assert index.get('schemaVersion')==2 and index.get('mediaType')==index_type and isinstance(index.get('manifests'),list)and 0<len(index['manifests'])<=32,'EXACT_OCI_INDEX_REQUIRED'
 choices=[d for d in index['manifests']if isinstance(d,dict)and d.get('platform',{}).get('os')==inspection['Os']and d.get('platform',{}).get('architecture')==inspection['Architecture']]
 assert len(choices)==1,'SINGLE_EXACT_CACHED_PLATFORM_REQUIRED'
 selected=descriptor(choices[0],(manifest_type,),4*1024*1024);manifest=blob(selected)
 assert manifest.get('schemaVersion')==2 and manifest.get('mediaType')==manifest_type,'EXACT_OCI_MANIFEST_REQUIRED'
 configuration=descriptor(manifest.get('config'),(config_type,),4*1024*1024)
 assert configuration['digest']=='sha256:'+config_sha and saved['Config']=='blobs/sha256/'+config_sha,'OCI_COMPAT_CONFIG_MISMATCH'
 blob(configuration)
 layers=manifest.get('layers')
 assert isinstance(layers,list)and len(layers)==len(saved['Layers']),'OCI_COMPAT_LAYER_COUNT_MISMATCH'
 for path,value in zip(saved['Layers'],layers):
  descriptor(value,layer_types,2*1024*1024*1024)
  assert path=='blobs/sha256/'+value['digest'][7:],'OCI_COMPAT_LAYER_ORDER_MISMATCH'
 return layers,{'kind':'OCI_INDEX_PLATFORM_MANIFEST_CONFIG','indexDigest':root['digest'],'indexBytes':root['size'],
  'platformManifestDigest':selected['digest'],'platformManifestBytes':selected['size'],'configDigest':configuration['digest'],'configBytes':configuration['size']}


def platform_bounded_layer(raw,media_type,budget,maximum=2*1024*1024*1024,aggregate=8*1024*1024*1024):
 import gzip
 from contextlib import contextmanager
 assert 0<maximum<=2*1024*1024*1024 and 0<aggregate<=8*1024*1024*1024,'FIXED_DECODE_BOUNDS_REQUIRED'
 class Reader:
  def __init__(self,stream):self.stream=stream;self.bytes=0;self.digest=hashlib.sha256()
  def read(self,size=-1):
   assert type(size)is int and 0<=size<=16*1024*1024,'BOUNDED_LAYER_READ_REQUIRED'
   if size==0:return b''
   block=self.stream.read(min(size,maximum-self.bytes+1,aggregate-budget['decodedBytes']+1))
   self.bytes+=len(block);budget['decodedBytes']+=len(block)
   assert self.bytes<=maximum and budget['decodedBytes']<=aggregate,'DECODED_LAYER_OR_AGGREGATE_LIMIT'
   self.digest.update(block);return block
 @contextmanager
 def managed():
  assert media_type in ('application/vnd.oci.image.layer.v1.tar','application/vnd.oci.image.layer.v1.tar+gzip'),'EXACT_LAYER_COMPRESSION_TYPE_REQUIRED'
  stream=gzip.GzipFile(fileobj=raw)if media_type.endswith('+gzip')else raw
  try:yield Reader(stream)
  finally:
   if stream is not raw:stream.close()
 return managed()


def platform_archive(kind,archive,inspection):
 import tarfile
 records={};aliases={};nodes={};layers=[];budget={'decodedBytes':0}
 alias_path='etc/postgresql-custom/conf.d';alias_target='etc/postgresql/postgresql.conf.d'
 with platform_open(archive)as file:
  assert file.seek(0,2)<=8*1024*1024*1024,'PLATFORM_ARCHIVE_SIZE_LIMIT'
  file.seek(0)
  archive_sha=platform_hash_stream(file);file.seek(0)
  with tarfile.open(fileobj=file,mode='r:')as outer:
   members={}
   for member in outer:
    name=platform_name(member.name)
    assert name not in members and (member.isfile()or member.isdir()),'PLATFORM_OUTER_DUPLICATE_OR_LINK'
    assert type(member.size)is int and 0<=member.size<=8*1024*1024*1024,'PLATFORM_OUTER_SIZE_INVALID'
    assert len(members)<20000,'PLATFORM_OUTER_LIMIT'
    members[name]=member
   def data(name,maximum):
    assert name in members and members[name].isfile()and members[name].size<=maximum,'PLATFORM_ARCHIVE_MEMBER_REQUIRED'
    with outer.extractfile(members[name])as value:
     raw=value.read(maximum+1)
     assert len(raw)==members[name].size,'PLATFORM_MEMBER_READ_SIZE_MISMATCH'
     return raw
   manifest=platform_json(data('manifest.json',1024*1024))
   assert isinstance(manifest,list)and len(manifest)==1,'SINGLE_CACHED_IMAGE_REQUIRED'
   manifest=manifest[0]
   assert set(manifest)<= {'Config','RepoTags','Layers','Parent'}and {'Config','Layers'}<=set(manifest),'DOCKER_SAVE_MANIFEST_REQUIRED'
   assert isinstance(manifest['Layers'],list)and 0<len(manifest['Layers'])<=100 and len(set(manifest['Layers']))==len(manifest['Layers']),'PLATFORM_LAYER_INVENTORY_INVALID'
   config_raw=data(platform_name(manifest['Config']),4*1024*1024);config=platform_json(config_raw)
   config_sha=final_digest(config_raw);oci_layers=None;identity={'kind':'LEGACY_CONFIG_IMAGE_ID','configDigest':'sha256:'+config_sha}
   if inspection['Id']!='sha256:'+config_sha:oci_layers,identity=platform_oci_identity(data,inspection,manifest,config_sha)
   elif inspection.get('Descriptor'):
    legacy_descriptor=inspection['Descriptor']
    assert legacy_descriptor.get('mediaType')=='application/vnd.oci.image.config.v1+json'and legacy_descriptor.get('digest')==inspection['Id']and type(legacy_descriptor.get('size'))is int and legacy_descriptor['size']==len(config_raw),'EXACT_LEGACY_CONFIG_DESCRIPTOR_REQUIRED'
   assert config.get('os')==inspection['Os']and config.get('architecture')==inspection['Architecture'],'CACHED_PLATFORM_MISMATCH'
   assert config.get('rootfs',{}).get('type')=='layers'and inspection.get('RootFS',{}).get('Type')=='layers','CACHED_ROOTFS_TYPE_MISMATCH'
   diff_ids=config['rootfs']['diff_ids']
   assert diff_ids==inspection['RootFS']['Layers']and len(diff_ids)==len(manifest['Layers']),'CACHED_ROOTFS_LAYERS_MISMATCH'
   saved_config=dict(config.get('config',{}));inspected_config=dict(inspection['Config'])
   normalization=[]
   if ('OnBuild'in saved_config)!=('OnBuild'in inspected_config)and saved_config.get('OnBuild')is None and inspected_config.get('OnBuild')is None:
    saved_config.pop('OnBuild',None);inspected_config.pop('OnBuild',None);normalization=['OnBuild_ABSENT_NULL_ONLY']
   assert saved_config==inspected_config,'CACHED_IMAGE_CONFIG_MISMATCH'
   for index,raw_name in enumerate(manifest['Layers']):
    name=platform_name(raw_name)
    assert name in members and members[name].isfile()and members[name].size<=2*1024*1024*1024,'PLATFORM_LAYER_MISSING_OR_TOO_LARGE'
    with outer.extractfile(members[name])as layer:
     layer_sha=platform_hash_stream(layer,2*1024*1024*1024)
    media_type='application/vnd.oci.image.layer.v1.tar'
    if oci_layers is not None:
     descriptor=oci_layers[index];media_type=descriptor['mediaType']
     assert descriptor['digest']=='sha256:'+layer_sha and descriptor['size']==members[name].size,'CACHED_COMPRESSED_LAYER_DIGEST_SIZE_MISMATCH'
    else:assert diff_ids[index]=='sha256:'+layer_sha,'CACHED_UNCOMPRESSED_LAYER_SHA_MISMATCH'
    changes={};alias_changes={};deletions=[];opaque=[];seen=set();types={}
    with outer.extractfile(members[name])as encoded,platform_bounded_layer(encoded,media_type,budget)as layer:
     with tarfile.open(fileobj=layer,mode='r|')as content:
      for entry in content:
       if entry.name in ('.','./'):continue
       path=platform_name(entry.name)
       assert not(kind=='db'and path.startswith(alias_path+'/')),'PLATFORM_ALIAS_DESCENDANT_REFUSED'
       assert path not in seen and len(seen)<500000,'PLATFORM_LAYER_DUPLICATE_OR_LIMIT'
       assert entry.isfile()or entry.isdir()or entry.issym()or entry.islnk(),'PLATFORM_UNEXPECTED_TAR_TYPE_REFUSED'
       assert type(entry.size)is int and 0<=entry.size<=256*1024*1024,'PLATFORM_LAYER_FILE_SIZE_LIMIT'
       assert entry.isfile()or entry.size==0,'PLATFORM_NON_FILE_PAYLOAD_REFUSED'
       seen.add(path);base=path.rsplit('/',1)[-1];parent=path.rsplit('/',1)[0]if '/'in path else ''
       if base.startswith('.wh.'):
        assert entry.isfile()and entry.size==0,'PLATFORM_WHITEOUT_ZERO_REGULAR_REQUIRED'
       if base=='.wh..wh..opq':opaque.append(parent);continue
       if base.startswith('.wh.'):
        target=(parent+'/'if parent else '')+base[4:]
        deletions.append(platform_name(target));continue
       if entry.issym()or entry.islnk():
        types[path]='link'
        if path==alias_path:
         assert kind=='db'and entry.issym()and entry.size==0 and entry.linkname=='/'+alias_target,'PLATFORM_EXACT_CONFIG_ALIAS_REQUIRED'
         alias_changes[path]={'type':'symlink','target':'/'+alias_target,'bytes':0,'mode':entry.mode,'uid':entry.uid,'gid':entry.gid,'layer':index,'layerSha256':layer_sha}
        else:assert not platform_selected(kind,path),'PLATFORM_SELECTED_LINK_REFUSED'
        continue
       types[path]='directory'if entry.isdir()else 'file'
       if not entry.isfile()or not platform_selected(kind,path):continue
       assert entry.size<=128*1024*1024,'PLATFORM_SELECTED_FILE_TOO_LARGE'
       with content.extractfile(entry)as value:sha=platform_hash_stream(value,128*1024*1024)
       changes[path]={'sha256':sha,'bytes':entry.size,'mode':entry.mode,'uid':entry.uid,'gid':entry.gid,'layer':index,'layerSha256':layer_sha}
     while layer.read(1024*1024):pass
     assert diff_ids[index]=='sha256:'+layer.digest.hexdigest(),'CACHED_DECODED_LAYER_DIFFID_MISMATCH'
     decoded_bytes=layer.bytes
    for prefix in deletions:
     records={p:v for p,v in records.items()if p!=prefix and not p.startswith(prefix+'/')}
     nodes={p:v for p,v in nodes.items()if p!=prefix and not p.startswith(prefix+'/')}
     aliases={p:v for p,v in aliases.items()if p!=prefix and not p.startswith(prefix+'/')}
    for prefix in opaque:
     records={p:v for p,v in records.items()if prefix and not p.startswith(prefix+'/')}
     nodes={p:v for p,v in nodes.items()if prefix and not p.startswith(prefix+'/')}
     aliases={p:v for p,v in aliases.items()if prefix and not p.startswith(prefix+'/')}
    # 모든 타입 전환을 반영한다. 허용 범위 밖의 파일도 허용 자손을 제거한다.
    for path,kind_of_node in types.items():
     if kind_of_node!='directory'or nodes.get(path)in ('file','link'):
      records={p:v for p,v in records.items()if p!=path and not p.startswith(path+'/')}
      nodes={p:v for p,v in nodes.items()if p!=path and not p.startswith(path+'/')}
      aliases={p:v for p,v in aliases.items()if p!=path and not p.startswith(path+'/')}
     elif kind_of_node=='directory':records.pop(path,None)
    nodes.update(types);assert len(nodes)<=500000,'PLATFORM_OVERLAY_NODE_LIMIT'
    records.update(changes);aliases.update(alias_changes)
    for path in set(records)|set(aliases):
     ancestors=path.split('/')[:-1]
     assert all(nodes.get('/'.join(ancestors[:index+1]))not in ('file','link')for index in range(len(ancestors))),'PLATFORM_SELECTED_NON_DIRECTORY_ANCESTOR_REFUSED'
    layers.append({'index':index,'sha256':layer_sha,'bytes':members[name].size,'mediaType':media_type,'uncompressedDiffId':diff_ids[index],'uncompressedBytes':decoded_bytes})
  file.seek(0);assert platform_hash_stream(file)==archive_sha,'PLATFORM_ARCHIVE_CHANGED_DURING_READ'
 for path,alias in aliases.items():
  assert kind=='db'and path==alias_path and nodes.get(path)=='link'and alias['target']=='/'+alias_target,'PLATFORM_FINAL_CONFIG_ALIAS_MISMATCH'
  assert nodes.get(alias_target)=='directory'and platform_selected(kind,alias_target+'/'),'PLATFORM_CONFIG_ALIAS_TARGET_DIRECTORY_REQUIRED'
  assert any(p.startswith(alias_target+'/')for p in records),'PLATFORM_CONFIG_ALIAS_TARGET_BYTES_REQUIRED'
  assert not any(p.startswith(path+'/')for p in nodes),'PLATFORM_ALIAS_DESCENDANT_REFUSED'
  parts=alias_target.split('/')[:-1]
  assert all(nodes.get('/'.join(parts[:i+1]))not in ('file','link')for i in range(len(parts))),'PLATFORM_CONFIG_ALIAS_TARGET_ANCESTOR_REFUSED'
 assert records,'PLATFORM_ALLOWLIST_EMPTY'
 required={'db':('docker-entrypoint-initdb.d/migrate.sh','usr/local/bin/docker-entrypoint.sh'),
           'auth':('usr/local/bin/auth',),
           'storage':('app/package.json','app/dist/start/server.js')}[kind]
 assert all(path in records for path in required),'PLATFORM_REQUIRED_EXECUTION_BYTES_MISSING'
 sql_files=sorted(path for path in records if path.endswith('.sql'))
 assert sql_files,'PLATFORM_INIT_SQL_INVENTORY_MISSING'
 return {'archiveSha256':archive_sha,'configSha256':config_sha,'identityChain':identity,'configNormalization':normalization,
  'savedConfigSha256':final_digest(final_canonical(config['config'])),'inspectedConfigSha256':final_digest(final_canonical(inspection['Config'])),
  'decodedArchiveBytes':budget['decodedBytes'],'layers':layers,'files':records,'configDirectoryAliases':aliases,
  'sqlFileLexicalInventory':sql_files,'executionOrder':'NOT_VERIFIED_RUNNER_REQUIRED',
  'embeddedSqlBinding':'NOT_VERIFIED_BINARY_HASH_ONLY'if kind=='auth'else 'NOT_APPLICABLE'}


def platform_owner(value):
 assert isinstance(value,dict)and set(value)=={'roleName','roleAttributes','ownerRoles','objects'},'EXACT_APP_OWNER_CATALOG_REQUIRED'
 role=value['roleName'];attrs=value['roleAttributes'];objects=value['objects']
 assert isinstance(role,str)and re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,62}',role),'ORIGINAL_APP_OWNER_REQUIRED'
 keys={'rolname','rolsuper','rolinherit','rolcreaterole','rolcreatedb','rolcanlogin','rolreplication','rolbypassrls','rolconnlimit','rolvaliduntil','rolconfig'}
 assert isinstance(attrs,dict)and set(attrs)==keys and attrs['rolname']==role,'EXACT_APP_ROLE_ATTRIBUTES_REQUIRED'
 assert all(type(attrs[k])is bool for k in keys-{'rolname','rolconnlimit','rolvaliduntil','rolconfig'}),'EXACT_APP_ROLE_BOOLEAN_REQUIRED'
 assert type(attrs['rolconnlimit'])is int and (attrs['rolvaliduntil']is None or isinstance(attrs['rolvaliduntil'],str))and (attrs['rolconfig']is None or isinstance(attrs['rolconfig'],list)),'EXACT_APP_ROLE_PRIMITIVES_REQUIRED'
 assert isinstance(objects,list)and objects,'APP_OWNER_OBJECT_EVIDENCE_REQUIRED'
 found=False;seen=set();sanitized=[];owners=set()
 for obj in objects:
  assert isinstance(obj,dict)and set(obj)=={'schema','name','kind','owner','acl','securityDefiner','rls','forceRls','config'}and obj['schema']in ('public','private')and obj['kind']in ('table','function'),'APP_OWNER_OBJECT_SHAPE_REQUIRED'
  assert all(isinstance(obj[k],str)and obj[k]and '\x00'not in obj[k]for k in ('schema','name','kind','owner')),'APP_OWNER_TEXT_REQUIRED'
  assert obj['acl']is None or isinstance(obj['acl'],str),'APP_OWNER_ACL_REQUIRED'
  if obj['kind']=='table':assert obj['securityDefiner']is None and type(obj['rls'])is bool and type(obj['forceRls'])is bool and obj['config']is None,'APP_TABLE_PRIVILEGE_SHAPE_REQUIRED'
  else:assert type(obj['securityDefiner'])is bool and obj['rls']is None and obj['forceRls']is None and (obj['config']is None or isinstance(obj['config'],list)and all(isinstance(v,str)for v in obj['config'])),'APP_DEFINER_PRIVILEGE_SHAPE_REQUIRED'
  identity=(obj['schema'],obj['name'],obj['kind']);assert identity not in seen,'APP_OWNER_DUPLICATE_REFUSED';seen.add(identity)
  if identity==('public','profiles','table'):assert obj['owner']==role,'INITIAL_PROFILES_OWNER_MISMATCH';found=True
  item=dict(obj);item['configSha256']=final_digest(final_canonical(item.pop('config')));sanitized.append(item);owners.add(obj['owner'])
 assert found,'INITIAL_PROFILES_OWNER_EVIDENCE_REQUIRED'
 result={**value,'roleAttributes':dict(attrs)}
 if attrs['rolconfig']is not None:assert all(isinstance(v,str)for v in attrs['rolconfig']),'APP_ROLE_CONFIG_SHAPE_REQUIRED'
 result['roleAttributes'].pop('rolconfig')
 result['roleAttributes']['rolconfigSha256']=final_digest(final_canonical(attrs['rolconfig']))
 owner_roles=value['ownerRoles'];assert isinstance(owner_roles,list),'APP_OWNER_ROLES_REQUIRED'
 mapped={}
 for other in owner_roles:
  assert isinstance(other,dict)and set(other)==keys and isinstance(other['rolname'],str)and other['rolname']not in mapped,'APP_OWNER_ROLE_CATALOG_REQUIRED'
  assert all(type(other[k])is bool for k in keys-{'rolname','rolconnlimit','rolvaliduntil','rolconfig'})and type(other['rolconnlimit'])is int,'APP_OWNER_ROLE_PRIMITIVES_REQUIRED'
  assert other['rolvaliduntil']is None or isinstance(other['rolvaliduntil'],str),'APP_OWNER_ROLE_EXPIRY_REQUIRED'
  assert other['rolconfig']is None or isinstance(other['rolconfig'],list)and all(isinstance(v,str)for v in other['rolconfig']),'APP_OWNER_ROLE_CONFIG_REQUIRED'
  item=dict(other);item['rolconfigSha256']=final_digest(final_canonical(item.pop('rolconfig')));mapped[other['rolname']]=item
 assert set(mapped)==owners and mapped[role]==result['roleAttributes'],'APP_OWNER_DISTRIBUTION_REQUIRED'
 result['ownerRoles']=mapped;result['objects']=sanitized
 result['canonicalApplicationRoleDecision']='NOT_DECIDED_SOURCE_CATALOG_ONLY'
 return result


def platform_collect(input_path,output_root):
 import os,stat
 from pathlib import Path
 with platform_open(input_path)as file:
  raw=file.read(1024*1024+1);assert len(raw)<=1024*1024,'PLATFORM_INPUT_LIMIT'
 value=platform_json(raw)
 assert isinstance(value,dict)and set(value)=={'version','kind','images','appOwnerCatalog'}and value['version']==1 and value['kind']=='CACHED_PLATFORM_OFFLINE_INPUT','EXACT_PLATFORM_INPUT_REQUIRED'
 assert isinstance(value['images'],dict)and set(value['images'])==set(PLATFORM_IMAGES),'EXACT_PLATFORM_IMAGE_SET_REQUIRED'
 owner_path=Path(value['appOwnerCatalog'])
 with platform_open(owner_path)as file:
  owner_raw=file.read(4*1024*1024+1);assert len(owner_raw)<=4*1024*1024,'APP_OWNER_INPUT_LIMIT'
 owner=platform_owner(platform_json(owner_raw));result={}
 for kind,item in value['images'].items():
  assert isinstance(item,dict)and set(item)=={'imageReference','inspectFile','archiveFile'}and item['imageReference']==PLATFORM_IMAGES[kind],'PLATFORM_IMAGE_ALLOWLIST_REFUSED'
  inspect_path=Path(item['inspectFile']);archive=Path(item['archiveFile'])
  with platform_open(inspect_path)as file:
   inspect_raw=file.read(4*1024*1024+1);assert len(inspect_raw)<=4*1024*1024,'PLATFORM_INSPECT_LIMIT'
  parsed=platform_json(inspect_raw)
  assert isinstance(parsed,list)and len(parsed)==1 and isinstance(parsed[0],dict),'ONE_IMAGE_INSPECT_REQUIRED'
  image=parsed[0]
  assert re.fullmatch('sha256:[a-f0-9]{64}',image.get('Id',''))and item['imageReference']in(image.get('RepoTags')or []),'CACHED_IMAGE_REFERENCE_REQUIRED'
  assert image.get('Os')=='linux'and image.get('Architecture')in ('amd64','arm64'),'EXPECTED_CACHED_LINUX_PLATFORM_REQUIRED'
  assert all(isinstance(v,str)and re.fullmatch('[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}',v)for v in(image.get('RepoDigests')or [])),'EXACT_REPO_DIGEST_SHAPE_REQUIRED'
  evidence=platform_archive(kind,archive,image)
  env=image['Config'].get('Env')or [];assert all(isinstance(v,str)and '='in v for v in env),'IMAGE_ENV_SHAPE_REQUIRED'
  settings={}
  for entry in env:
   key,text=entry.split('=',1)
   if key in PLATFORM_SETTINGS:
    assert key not in settings,'DUPLICATE_PLATFORM_SETTING';settings[key]={'sha256':final_digest(text.encode()),'state':'IMAGE_DEFAULT_NOT_RUNTIME_APPROVAL'}
  evidence.update({'imageReference':item['imageReference'],'imageId':image['Id'],'os':image['Os'],'architecture':image['Architecture'],
   'inspectSha256':final_digest(inspect_raw),'repoDigests':image.get('RepoDigests')or [],'configEnvironmentSha256':final_digest(final_canonical(env)),
   'sourceLabelsSha256':final_digest(final_canonical(image['Config'].get('Labels'))),'settings':settings,
   'upstreamReferenceCommit':PLATFORM_UPSTREAM[kind],'cachedCommitBinding':'NOT_VERIFIED',
   'runtimeSettings':'NOT_COLLECTED','buildProvenance':'NOT_VERIFIED_CONFIG_AND_BINARY_BYTES_ONLY'})
  result[kind]=evidence
 manifest={'version':1,'kind':'CACHED_PLATFORM_BYTE_MANIFEST','status':'COLLECTED_OFFLINE_BASELINE_NOT_VERIFIED',
  'activationAllowed':False,'full118Applied':False,'sourceChanges':0,'dockerCalls':0,'inputSha256':final_digest(raw),
  'appOwnerCatalogSha256':final_digest(owner_raw),'appOwner':owner,'images':result,'platformBaselineExecution':'NOT_RUN',
  'originalOwnerMustBePreserved':True,'runtimeSecretsIncluded':False}
 assert output_root.is_absolute()and output_root.parent.resolve()==output_root.parent and output_root.parent==Path('/private/tmp')and re.fullmatch('yumidang-platform-manifest-[A-Za-z0-9-]{1,80}',output_root.name),'FRESH_PRIVATE_OUTPUT_ROOT_REQUIRED'
 assert not output_root.exists()and not output_root.is_symlink(),'EXISTING_PLATFORM_OUTPUT_PRESERVED'
 output_root.mkdir(mode=0o700)
 parent=output_root.stat();assert parent.st_uid==os.getuid()and stat.S_IMODE(parent.st_mode)==0o700,'PLATFORM_OUTPUT_PRIVATE_REQUIRED'
 target=output_root/'manifest.json';descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(descriptor,'wb')as file:file.write(final_canonical(manifest))
 return {'status':manifest['status'],'manifestSha256':final_digest(final_canonical(manifest)),'dockerCalls':0,'activationAllowed':False,'full118Applied':False}


NATIVE_MANIFEST_SHA='7d699d68add889e18daeaf746ce2450490867546e8656a13c9dd8383c1f70de4'
NATIVE_SCOPE='CACHED_NATIVE_PLATFORM_ONLY_NO_APP_MIGRATIONS'


NATIVE_POSTGRES_EXE_PATH='/nix/store/shgvzk1xmsqc472mhcwc64jgncax5fkx-postgresql-and-plugins-17.6/bin/.postgres-wrapped'
NATIVE_POSTGRES_EXE_SHA='c6f1950a6ba2c4079fb7ffdd3d2ffaaf71540007c52de28167fd248a561117ab'
NATIVE_POSTGRES_PROOF_PATH='/private/tmp/yumidang-platform-baseline-20261010-native-v4/cached-postgres-executable-proof.json'
NATIVE_POSTGRES_PROOF_SHA='ba73ef173a5aa3efae32280cacb164316309a5ff3e577eaffd25356c7394412d'


def native_cached_postgres(proof,manifest):
 """기존 cached manifest와 별도 읽기 ELF 증거를 exact 바이트로 연결한다."""
 assert proof['status']=='PASS_CACHED_NATIVE_POSTGRES_BYTES_ONLY'and proof['platformManifestSha256']==NATIVE_MANIFEST_SHA,'NATIVE_CACHED_ELF_SCOPE_REQUIRED'
 db=manifest['images']['db']
 assert proof['cachedImageId']==db['imageId']and proof['archiveSha256']==db['archiveSha256']and proof['archiveBeforeAfterExact']is True,'NATIVE_CACHED_ELF_IMAGE_REQUIRED'
 assert proof['nativeV4OwnProcessExeNotObserved']is True and proof['nativePlatformPass']is False and proof['hostExtraction']==proof['dockerCalls']==proof['sourceQueries']==proof['starts']==0,'NATIVE_CACHED_ELF_OBSERVATION_SCOPE_REQUIRED'
 assert proof['layerCount']==len(db['layers'])and proof['decodedBytes']==db['decodedArchiveBytes'],'NATIVE_CACHED_ELF_LAYER_COUNT_REQUIRED'
 path=NATIVE_POSTGRES_EXE_PATH.lstrip('/');wrapper=path.rsplit('/',1)[0]+'/postgres'
 assert set(proof['files'])=={path,wrapper},'NATIVE_CACHED_ELF_EXACT_FILE_SET_REQUIRED'
 for name,sha,size,elf in((path,NATIVE_POSTGRES_EXE_SHA,11220480,True),(wrapper,'3d4c9002a1add7973bf07bf17c6773e5c805dd45cfd2d8b5ca01f6afd4ac034a',284,False)):
  value=proof['files'][name]
  assert value['type']=='regular'and value['sha256']==sha and type(value['bytes'])is int and value['bytes']==size and value['elfMagic']is elf,'NATIVE_CACHED_ELF_BYTES_REQUIRED'
  assert type(value['layerIndex'])is int and value['layerIndex']==3,'NATIVE_CACHED_ELF_EXACT_LAYER_REQUIRED'
  layer=db['layers'][value['layerIndex']]
  assert value['compressedLayerSha256']==layer['sha256']=='886d743b150d883f892b44e2461defc65788301d13bf96a39159e2a4b45d9fed'and value['uncompressedDiffId']==layer['uncompressedDiffId']=='sha256:fba9a9d77a47055a2f7458e3fbc4761e9a831dd187765718a8454906263a4ecd','NATIVE_CACHED_ELF_LAYER_BINDING_REQUIRED'
 assert proof['files'][wrapper]['execWrappedRelative']is True,'NATIVE_CACHED_POSTGRES_WRAPPER_REQUIRED'


def native_graph(path):
 """운영 승인과 앱 migration 입력을 대신하지 않는 전용 플랫폼 graph다."""
 from pathlib import Path
 with platform_open(path)as file:raw=file.read(1024*1024+1)
 assert len(raw)<=1024*1024,'NATIVE_GRAPH_SIZE_LIMIT'
 g=platform_json(raw)
 keys={'version','kind','approvedByRoot','dockerSlotReady','repo','files','platformManifest','platformManifestSha256','sourceId','sourceWholeSha256','sourceOwnerCatalogSha256','cachedPostgresExecutableProof','cachedPostgresExecutableProofSha256'}
 assert isinstance(g,dict)and set(g)==keys and type(g['version'])is int and g['version']==1 and g['kind']==NATIVE_SCOPE,'EXACT_NATIVE_GRAPH_REQUIRED'
 assert g['approvedByRoot']is True and g['dockerSlotReady']is True,'NATIVE_ROOT_GRAPH_AND_SLOT_REQUIRED'
 repo=Path(g['repo']);assert repo.is_absolute()and repo.resolve()==repo,'NATIVE_CANONICAL_REPO_REQUIRED'
 required={'tests/integration/minkyu/product_connection_restore108_local.py',*FINAL_FIXED.keys()}
 # 닫힌 source bundle 검증 도구를 실행하지 않는다. 고정 dependency 바이트만 확인한다.
 assert set(g['files'])==required,'EXACT_NATIVE_DEPENDENCIES_REQUIRED'
 for name,sha in g['files'].items():
  assert isinstance(sha,str)and re.fullmatch('[a-f0-9]{64}',sha),'NATIVE_FILE_SHA_REQUIRED'
  assert(repo/name).stat().st_size<=2*1024**2,'NATIVE_DEPENDENCY_SIZE_LIMIT'
  assert final_digest(final_regular(repo/name))==sha,'NATIVE_DEPENDENCY_CHANGED'
 for name,sha in FINAL_FIXED.items():assert g['files'][name]==sha,'NATIVE_FIXED_DEPENDENCY_CHANGED'
 assert g['files']['tests/integration/minkyu/product_connection_restore108_local.py']==final_digest(Path(__file__).read_bytes()),'NATIVE_EXECUTING_DRIVER_CHANGED'
 assert g['platformManifestSha256']==NATIVE_MANIFEST_SHA,'NATIVE_PROVED_MANIFEST_REQUIRED'
 with platform_open(Path(g['platformManifest']))as file:manifest_raw=file.read(4*1024**2+1)
 assert len(manifest_raw)<=4*1024**2,'NATIVE_MANIFEST_SIZE_LIMIT'
 assert final_digest(manifest_raw)==NATIVE_MANIFEST_SHA,'NATIVE_PLATFORM_MANIFEST_CHANGED'
 manifest=platform_json(manifest_raw)
 assert manifest['kind']=='CACHED_PLATFORM_BYTE_MANIFEST'and manifest['activationAllowed']is False and manifest['full118Applied']is False and manifest['platformBaselineExecution']=='NOT_RUN','NATIVE_MANIFEST_SCOPE_REQUIRED'
 assert set(manifest['images'])==set(PLATFORM_IMAGES),'NATIVE_EXACT_IMAGE_SET_REQUIRED'
 for kind,value in manifest['images'].items():
  assert value['imageReference']==PLATFORM_IMAGES[kind]and value['os']=='linux'and value['architecture']=='arm64','NATIVE_CACHED_PLATFORM_REQUIRED'
  assert re.fullmatch('sha256:[a-f0-9]{64}',value['imageId'])and value['identityChain']['kind']=='OCI_INDEX_PLATFORM_MANIFEST_CONFIG','NATIVE_IMMUTABLE_IMAGE_CHAIN_REQUIRED'
 for key in('sourceId','sourceWholeSha256','sourceOwnerCatalogSha256'):
  assert isinstance(g[key],str)and re.fullmatch('[a-f0-9]{64}',g[key]),'NATIVE_SOURCE_BINDING_REQUIRED'
 assert g['sourceOwnerCatalogSha256']==manifest['appOwnerCatalogSha256'],'NATIVE_ORIGINAL_OWNER_BINDING_REQUIRED'
 assert g['cachedPostgresExecutableProof']==NATIVE_POSTGRES_PROOF_PATH and g['cachedPostgresExecutableProofSha256']==NATIVE_POSTGRES_PROOF_SHA,'NATIVE_FIXED_CACHED_ELF_PROOF_REQUIRED'
 with platform_open(Path(g['cachedPostgresExecutableProof']))as file:proof_raw=file.read(65537)
 assert len(proof_raw)<=65536 and final_digest(proof_raw)==NATIVE_POSTGRES_PROOF_SHA,'NATIVE_CACHED_ELF_PROOF_CHANGED'
 native_cached_postgres(platform_json(proof_raw),manifest)
 return g,manifest,final_digest(raw)


def native_envs(password,secret):
 """임의 환경 파일·공급사 설정을 받지 않는다. 새 환경의 비밀만 생성한다."""
 from urllib.parse import quote
 url=lambda role:'postgresql://'+role+':'+quote(password,safe='')+'@mplatform-pg:5432/postgres?sslmode=verify-full&sslrootcert=/tmp/native-ca.crt'
 return {
  'db':{'POSTGRES_USER':'supabase_admin','POSTGRES_DB':'postgres','POSTGRES_HOST':'/var/run/postgresql','PGHOST':'/var/run/postgresql','PGDATA':'/tmp/native-data','POSTGRES_PASSWORD':password,'USE_DBMATE':''},
  'auth':{'GOTRUE_DB_DRIVER':'postgres','GOTRUE_DB_DATABASE_URL':url('supabase_auth_admin'),'GOTRUE_DB_NAMESPACE':'auth','GOTRUE_JWT_SECRET':secret,'GOTRUE_JWT_AUD':'authenticated','GOTRUE_SITE_URL':'https://native.invalid','API_EXTERNAL_URL':'https://native.invalid/auth/v1','GOTRUE_DISABLE_SIGNUP':'true','GOTRUE_EXTERNAL_EMAIL_ENABLED':'false','GOTRUE_EXTERNAL_PHONE_ENABLED':'false','GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED':'false','GOTRUE_LOG_LEVEL':'error'},
  'storage':{'DATABASE_URL':url('supabase_storage_admin'),'DATABASE_SSL_ROOT_CERT':'/tmp/native-ca.crt','AUTH_JWT_SECRET':secret,'ANON_KEY':'native-no-http','SERVICE_KEY':'native-no-http','STORAGE_BACKEND':'file','FILE_STORAGE_BACKEND_PATH':'/tmp/native-empty-storage','REGION':'local','GLOBAL_S3_BUCKET':'native-unused','MULTI_TENANT':'false','IS_MULTITENANT':'false','DB_INSTALL_ROLES':'false','DB_SUPER_USER':'supabase_admin','DB_ANON_ROLE':'anon','DB_AUTHENTICATED_ROLE':'authenticated','DB_SERVICE_ROLE':'service_role','DB_ALLOW_MIGRATION_REFRESH':'false','DB_MIGRATIONS_FREEZE_AT':'','DB_MIGRATIONS_STRATEGY':'on_request','PG_QUEUE_ENABLE':'false','ENABLE_QUEUE_EVENTS':'false','VECTOR_ENABLED':'false','VECTOR_STORE_MIGRATIONS_ENABLED':'false','VECTOR_DATABASE_CREATE':'false','VECTOR_BUCKET_PROVIDER':'s3','NODE_OPTIONS':'--max-old-space-size=64','LOG_LEVEL':'error','OTEL_ENABLED':'false'}
 }


def native_final_server(value):
 """임시 서버나 health만으로 최종 서버를 증명하지 않는다."""
 fields={'postmasterPid','pidStartedEpoch','serverStartedEpoch','configFile','dataDirectory','listenAddresses','cronClosed','sslEnabled','nativeCatalogReady'}
 if not isinstance(value,dict)or set(value)!=fields:return False
 if any(type(value[k])is not int for k in('postmasterPid','pidStartedEpoch','serverStartedEpoch')):return False
 return value['postmasterPid']==1 and value['pidStartedEpoch']>0 and abs(value['pidStartedEpoch']-value['serverStartedEpoch'])<=1 and value['configFile']=='/etc/postgresql/postgresql.conf'and value['dataDirectory']=='/tmp/native-data'and value['listenAddresses']=='*'and value['cronClosed']is True and value['sslEnabled']is True and value['nativeCatalogReady']is True


def run_native_platform(args):
 """검토 후 새 환경의 native migration만 한 번 실행한다. 앱 SQL·소스 쓰기는 없다."""
 import importlib.util,ipaddress,os,secrets,sys,traceback
 from pathlib import Path
 g,manifest,graph_sha=native_graph(args.graph_manifest)
 assert re.fullmatch('native-v[1-9][0-9]{0,5}',args.revision),'FRESH_NATIVE_REVISION_REQUIRED'
 root=Path('/private/tmp/yumidang-platform-baseline-20261010-'+args.revision)
 assert not root.exists()and not root.is_symlink(),'EXISTING_NATIVE_UNKNOWN_PRESERVED'
 root.mkdir(mode=0o700);run_id=str(uuid.uuid4());prefix='yumidang-minkyu-'+args.revision
 owned={};network=None;before=None;source_identity=None;passed=False;stage='source_preflight';receipt=None;owner_authority=[]
 def save(name,value):
  assert re.fullmatch('[A-Za-z0-9.-]+',name),'NATIVE_ARTIFACT_NAME_REQUIRED'
  data=value if isinstance(value,bytes)else final_canonical(value)
  with os.fdopen(os.open(root/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb')as f:f.write(data)
 def call(argv,data=None,timeout=120):
  r=subprocess.run(argv,input=data,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=timeout)
  assert r.returncode==0,'NATIVE_COMMAND_FAILED_NO_RETRY'
  assert len(r.stdout)<=64*1024**2,'NATIVE_RESPONSE_LIMIT'
  return r.stdout
 def docker(*argv,data=None,timeout=120):return call(t.DOCKER+list(argv),data,timeout)
 def inspect(name):
  value=platform_json(docker('inspect',name));assert len(value)==1,'NATIVE_ONE_CONTAINER_REQUIRED';return value[0]
 def query(name,statement):
  assert name==FINAL_SOURCE or name==owned.get('db'),'NATIVE_QUERY_SCOPE_REQUIRED'
  if name==FINAL_SOURCE:
   assert not re.search(r'\b(insert|update|delete|create|alter|drop|truncate|grant|revoke|nextval|setval)\b',statement,re.I),'NATIVE_SOURCE_WRITE_REFUSED'
   statement="begin read only;set local statement_timeout='30s';"+statement+'commit;'
  user=BOOT if name==FINAL_SOURCE else 'supabase_admin'
  return docker('exec','-i',name,'psql','-XqAt','-U',user,'-d','postgres','-v','ON_ERROR_STOP=1',data=statement.encode())
 repo=Path(g['repo']);sys.path.insert(0,str(repo/'tests/integration/minkyu'))
 spec=importlib.util.spec_from_file_location('native_fixed_snapshot',repo/'tests/integration/minkyu/member_cleanup_reconcile_local.py')
 helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
 def helper_call(argv,data=None):
  argv=list(argv);name=argv[argv.index('exec')+1]if 'exec'in argv else None
  if name=='-i':name=argv[argv.index('exec')+2]
  assert name in(FINAL_SOURCE,owned.get('db')),'NATIVE_HELPER_SCOPE_REQUIRED'
  if name==FINAL_SOURCE:assert 'pg_dump'in argv and '--schema-only'in argv,'NATIVE_SOURCE_HELPER_READONLY_REQUIRED'
  if '-U'in argv:argv[argv.index('-U')+1]=BOOT if name==FINAL_SOURCE else 'supabase_admin'
  return call(argv,data)
 helper.query=query;helper.call=helper_call
 def whole_source():
  names=platform_json(query(FINAL_SOURCE,"select coalesce(json_agg(json_build_array(n.nspname,c.relname)order by n.nspname,c.relname),'[]')from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S'and left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema';"));seq={}
  for schema,name in names:
   target='"'+schema.replace('"','""')+'"."'+name.replace('"','""')+'"'
   seq[schema+'.'+name]=platform_json(query(FINAL_SOURCE,'select json_build_array(last_value,is_called)from '+target+';'))
  return {'snapshot':helper.normalized_snapshot(FINAL_SOURCE),'sequences':seq}
 def source_closed():
  x=inspect(FINAL_SOURCE)
  assert x['Id']==g['sourceId']and x['State']['Running']and x['Config']['Labels'].get('yumidang.owner')=='minkyu','NATIVE_SOURCE_ID_OWNER_REQUIRED'
  assert_closed(lambda statement:query(FINAL_SOURCE,statement))
  assert query(FINAL_SOURCE,'show cron.launch_active_jobs;').strip()==b'off','NATIVE_SOURCE_CRON_REQUIRED'
  for table in('worker_invocation_control','worker_intent_confirmation_control','event_collection_control','content_inspection_control','member_retirement_receipt_control'):
   if query(FINAL_SOURCE,"select to_regclass('private."+table+"');").strip():assert query(FINAL_SOURCE,'select not enabled from private.'+table+' where singleton;').strip()==b't','NATIVE_SOURCE_CONTROL_OPEN'
  assert query(FINAL_SOURCE,"select count(*)from pg_stat_activity where datname=current_database()and backend_type='client backend'and state='active'and pid<>pg_backend_pid();").strip()==b'0','NATIVE_SOURCE_NOT_QUIESCENT'
  return {'id':x['Id'],'configSha256':final_digest(final_canonical(x['Config'])),'hostConfigSha256':final_digest(final_canonical(x['HostConfig'])),'mountsSha256':final_digest(final_canonical(x['Mounts'])),'startedAt':x['State']['StartedAt'],'restartCount':x['RestartCount']}
 def memory(phase):
  values=re.findall(r'^MemAvailable:\s+([0-9]+) kB$',docker('exec',FINAL_SOURCE,'cat','/proc/meminfo').decode(),re.M)
  assert len(values)==1,'NATIVE_MEMORY_MEASUREMENT_REQUIRED'
  amount=int(values[0]);save('memory-'+phase+'.json',{'availableKiB':amount,'minimumMiB':768,'dbMemoryMiB':512,'sequentialRunnerMemoryMiB':128,'maxConcurrentRunners':1})
  assert amount>=768*1024,'NATIVE_MEMORY_LOW_START0'
 def own_identity(kind):
  x=inspect(owned[kind]);labels=x['Config']['Labels']
  assert x['Id']==owned[kind]and x['Name']=='/'+prefix+'-'+kind and labels.get('yumidang.owner')=='minkyu'and labels.get('yumidang.run_id')==run_id and labels.get('yumidang.scope')==NATIVE_SCOPE,'NATIVE_OWN_ID_NAME_LABEL_REQUIRED'
  expected=manifest['images'][kind];assert x['Config']['Image']==expected['imageId'],'NATIVE_OWN_IMMUTABLE_IMAGE_REQUIRED'
  return x
 def own(kind):
  x=own_identity(kind)
  assert x['State'].get('OOMKilled')is False,'NATIVE_OWN_OOM_KILLED'
  host=x['HostConfig'];cap=(512 if kind=='db'else 128)*1024**2
  assert not host.get('PortBindings')and not host.get('Privileged')and host['Memory']==cap and host['MemorySwap']==cap and host['NanoCpus']==500000000 and host['PidsLimit']==128 and host['LogConfig']['Type']=='none'and x['Config']['Healthcheck']['Test']==['NONE'],'NATIVE_OWN_CAPS_NO_EXPOSURE_REQUIRED'
  rows=x['Config']['Env'];assert len({v.split('=',1)[0]for v in rows})==len(rows),'NATIVE_DUPLICATE_RUNTIME_ENV_REFUSED'
  env=dict(v.split('=',1)for v in rows)
  assert all(env.get(k)==v for k,v in native_envs(password,secret)[kind].items()),'NATIVE_RUNTIME_SETTINGS_CHANGED'
  assert all(m['Type']=='bind'and m['Destination']=='/tmp/native-ca.crt'and not m['RW']for m in x['Mounts'])and(kind!='db'or not x['Mounts']),'NATIVE_OWN_MOUNT_SCOPE_REQUIRED'
  assert set(x['NetworkSettings']['Networks'])=={prefix+'-net'}and host['NetworkMode']==prefix+'-net','NATIVE_INTERNAL_NETWORK_REQUIRED'
  fresh=platform_json(docker('network','inspect',network));assert len(fresh)==1,'NATIVE_ONE_OWN_NETWORK_REQUIRED';net=fresh[0]
  assert net['Id']==network and net['Name']==prefix+'-net'and net['Internal']is True and net['Labels'].get('yumidang.owner')=='minkyu'and net['Labels'].get('yumidang.run_id')==run_id and [v.get('Subnet')for v in net['IPAM']['Config']]==[str(subnet)],'NATIVE_FRESH_INTERNAL_NETWORK_IDENTITY_REQUIRED'
  state=x['State'];endpoint=x['NetworkSettings']['Networks'][prefix+'-net']
  never_started=state['Status']=='created'and state['Running']is False and state['Pid']==0 and state['ExitCode']==0 and state['StartedAt']==state['FinishedAt']=='0001-01-01T00:00:00Z'
  if never_started:
   assert endpoint['NetworkID']in('',network)and endpoint['EndpointID']=='','NATIVE_NEVER_STARTED_NETWORK_REQUIRED'
  else:assert endpoint['NetworkID']==network,'NATIVE_MATERIALIZED_NETWORK_ID_REQUIRED'
  return x
 def stop(kind):
  # ID/name/run/image를 먼저 고정한다. caps/OOM 실패도 자기 STOP을 막지 않는다.
  x=own_identity(kind);invalid=False
  try:own(kind)
  except BaseException:invalid=True
  if x['State']['Running']:docker('stop','--time','10',owned[kind])
  assert not own_identity(kind)['State']['Running'],'NATIVE_OWN_STOP_REQUIRED'
  assert not invalid,'NATIVE_OWN_INVARIANT_FAILED_STOPPED'
  own(kind)
 def observed_tls(kind):
  role='supabase_auth_admin'if kind=='auth'else'supabase_storage_admin'
  for _ in range(120):
   rows=platform_json(query(owned['db'],"select coalesce(json_agg(json_build_object('role',a.usename,'ssl',s.ssl,'protocol',s.version,'cipher',s.cipher,'bits',s.bits)),'[]')from pg_stat_activity a join pg_stat_ssl s using(pid)where a.usename='"+role+"'and a.client_addr is not null;"))
   if rows:
    assert all(r['role']==role and r['ssl']is True and r['protocol']in('TLSv1.2','TLSv1.3')and isinstance(r['cipher'],str)and re.fullmatch('[A-Za-z0-9_-]{1,128}',r['cipher'])and r['bits']>=128 for r in rows),'NATIVE_EXPECTED_ROLE_TLS_REQUIRED'
    save(kind+'-tls.json',{'expectedRole':role,'actualSessions':rows,'sslmode':'verify-full','serverAlias':'mplatform-pg'});return
   if not own(kind)['State']['Running']:break
   time.sleep(.05)
  raise AssertionError('NATIVE_ROLE_TLS_NOT_OBSERVED')
 def create(kind,command):
  memory(kind+'-start')
  image=manifest['images'][kind]['imageId'];name=prefix+'-'+kind
  argv=['create','--pull=never','--platform','linux/arm64','--name',name,'--network',prefix+'-net','--label','yumidang.owner=minkyu','--label','yumidang.run_id='+run_id,'--label','yumidang.scope='+NATIVE_SCOPE,'--no-healthcheck','--log-driver=none','--memory',('512m'if kind=='db'else'128m'),'--memory-swap',('512m'if kind=='db'else'128m'),'--cpus','0.5','--pids-limit','128','--env-file',str(root/(kind+'.env'))]
  if kind=='db':argv+=['--network-alias','mplatform-pg','--entrypoint','sh']
  else:argv+=['--user','0','--mount','type=bind,src='+str(root/'ca.crt')+',dst=/tmp/native-ca.crt,readonly','--entrypoint',('/usr/local/bin/auth'if kind=='auth'else'node')]
  raw=docker(*argv,image,*command).decode().strip();assert re.fullmatch('[a-f0-9]{64}',raw),'NATIVE_OWN_CREATE_ID_REQUIRED';owned[kind]=raw;own(kind)
  save(kind+'-intent.json',{'stage':stage,'id':raw,'imageId':image,'commandSha256':final_digest(final_canonical(command)),'runtimeEnvSha256':final_digest((root/(kind+'.env')).read_bytes()),'runId':run_id})
  if kind=='db':
   for filename in('server.key','server.crt','ca.crt'):docker('cp',str(root/filename),raw+':/tmp/native-'+filename)
  docker('start',raw)
 def native_state():
  db=owned['db'];assert query(db,'show cron.launch_active_jobs;').strip()==b'off','NATIVE_CRON_OPEN'
  assert query(db,"select to_regclass('public.profiles')is null and to_regclass('private.worker_jobs')is null and to_regclass('public.event_sources')is null and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private');").strip()==b't','NATIVE_APP_OBJECTS_PRESENT'
  assert query(db,"select not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname in('get_service_post','retire_my_account','list_public_events','prepare_queue_invocation'));").strip()==b't','NATIVE_APP_RPC_PRESENT'
  if query(db,"select to_regclass('supabase_migrations.schema_migrations');").strip():assert query(db,'select count(*)from supabase_migrations.schema_migrations;').strip()==b'0','NATIVE_APP_MIGRATION_HISTORY_PRESENT'
  assert query(db,'select count(*)from auth.users;').strip()==b'0','NATIVE_REAL_OR_SYNTHETIC_MEMBERS_PRESENT'
  actual_attrs={}
  for role,expected in manifest['appOwner']['ownerRoles'].items():
   assert re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,62}',role),'NATIVE_ORIGINAL_OWNER_NAME_REQUIRED'
   raw=platform_json(query(db,"select json_build_object('rolname',rolname,'rolsuper',rolsuper,'rolinherit',rolinherit,'rolcreaterole',rolcreaterole,'rolcreatedb',rolcreatedb,'rolcanlogin',rolcanlogin,'rolreplication',rolreplication,'rolbypassrls',rolbypassrls,'rolconnlimit',rolconnlimit,'rolvaliduntil',rolvaliduntil,'rolconfig',rolconfig)from pg_roles where rolname='"+role+"';"))
   raw['rolconfigSha256']=final_digest(final_canonical(raw.pop('rolconfig')))
   actual_attrs[role]=raw
   if raw!=expected:save('native-owner-attributes-mismatch-private.json',{'role':role,'actual':raw,'expected':expected,'automaticRepair':False})
   assert raw==expected,'NATIVE_ORIGINAL_OWNER_ATTRIBUTES_MISMATCH_NO_REPAIR'
  snap=helper.normalized_snapshot(db);owner_names=set(manifest['appOwner']['ownerRoles'])
  expected_rows=[r for r in before['snapshot']['roles']['memberships']if r[0]in owner_names or r[1]in owner_names]
  actual_rows=[r for r in snap['roles']['memberships']if r[0]in owner_names or r[1]in owner_names]
  actual_names={r['rolname']for r in snap['roles']['roles']}
  comparison={'stage':stage,'ownerAttributesExact':True,'sourceOwnerMemberships':expected_rows,'nativeOwnerMemberships':actual_rows,'membershipsExact':actual_rows==expected_rows,'sourceMembershipRolesAbsentFromNative':sorted({r[i]for r in expected_rows for i in(0,1)if r[i]not in actual_names}),'sourceMembershipGrantorsAbsentFromNative':sorted({r[2]for r in expected_rows if r[2]not in actual_names}),'automaticRepair':False,'canonicalAppApplicationReady':False}
  owner_authority.append(comparison);save('native-owner-authority-'+stage.replace('_','-')+'.json',comparison)
  return snap
 try:
  source_identity=source_closed();before=whole_source()
  assert len(before['snapshot']['rows'])==186 and final_digest(final_canonical(before))==g['sourceWholeSha256'],'NATIVE_SOURCE_186_WHOLE_BINDING_CHANGED'
  owner_raw=query(FINAL_SOURCE,PLATFORM_OWNER_QUERY)
  assert final_digest(owner_raw)==g['sourceOwnerCatalogSha256'],'NATIVE_SOURCE_OWNER_CHANGED'
  save('source-before-private.json',before);save('source-identity-private.json',source_identity)
  for kind,value in manifest['images'].items():
   x=platform_json(docker('image','inspect',value['imageId']))
   assert len(x)==1 and x[0]['Id']==value['imageId']and final_digest(final_canonical(x[0]['Config']))==value['inspectedConfigSha256'],'NATIVE_CACHED_IMAGE_ID_OR_CONFIG_CHANGED'
   assert x[0]['RootFS']['Layers']==[row['uncompressedDiffId']for row in value['layers']],'NATIVE_IMAGE_ROOTFS_CHANGED'
  existing=docker('ps','-a','--format','{{.Names}}').decode().splitlines()
  assert all(prefix+'-'+k not in existing for k in('db','auth','storage')),'NATIVE_EXISTING_CONTAINERS_PRESERVED'
  memory('prepare');password=secrets.token_hex(32);secret=secrets.token_hex(32)
  for kind,env in native_envs(password,secret).items():save(kind+'.env',''.join(k+'='+v+'\n'for k,v in env.items()).encode())
  stage='tls_prepare'
  call(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(root/'ca.key'),'-out',str(root/'ca.crt'),'-days','2','-subj','/CN=yumidang-native-test-ca','-addext','basicConstraints=critical,CA:true,pathlen:0','-addext','keyUsage=critical,keyCertSign,cRLSign'])
  call(['openssl','req','-newkey','rsa:2048','-nodes','-keyout',str(root/'server.key'),'-out',str(root/'server.csr'),'-subj','/CN=mplatform-pg'])
  save('server.ext',b'subjectAltName=DNS:mplatform-pg\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n')
  call(['openssl','x509','-req','-in',str(root/'server.csr'),'-CA',str(root/'ca.crt'),'-CAkey',str(root/'ca.key'),'-CAcreateserial','-out',str(root/'server.crt'),'-days','2','-extfile',str(root/'server.ext')])
  for p in root.iterdir():p.chmod(0o600)
  stage='network_create';ids=docker('network','ls','-q').decode().splitlines();used=[]
  if ids:
   for net in platform_json(docker('network','inspect',*ids)):
    for conf in net.get('IPAM',{}).get('Config')or[]:
     if conf.get('Subnet'):used.append(ipaddress.ip_network(conf['Subnet'],strict=True))
  candidates=(subnet for cidr in('172.29.0.0/16','10.231.0.0/16','10.232.0.0/16','192.168.240.0/20')for subnet in ipaddress.ip_network(cidr).subnets(new_prefix=28))
  subnet=next((v for v in candidates if all(v.version!=p.version or not v.overlaps(p)for p in used)),None)
  assert subnet is not None,'NATIVE_NO_FRESH_SUBNET'
  network=docker('network','create','--internal','--subnet',str(subnet),'--label','yumidang.owner=minkyu','--label','yumidang.run_id='+run_id,prefix+'-net').decode().strip()
  assert re.fullmatch('[a-f0-9]{64}',network),'NATIVE_NETWORK_ID_REQUIRED'
  net=platform_json(docker('network','inspect',network))[0]
  assert net['Id']==network and net['Name']==prefix+'-net'and net['Internal']is True and net['Labels'].get('yumidang.owner')=='minkyu'and net['Labels'].get('yumidang.run_id')==run_id and [v.get('Subnet')for v in net['IPAM']['Config']]==[str(subnet)],'NATIVE_OWN_INTERNAL_NETWORK_PROOF_REQUIRED'
  stage='native_pg_entrypoint'
  create('db',['-c','chown postgres:postgres /tmp/native-server.key /tmp/native-server.crt /tmp/native-ca.crt && chmod 600 /tmp/native-server.key /tmp/native-server.crt /tmp/native-ca.crt && exec /usr/local/bin/docker-entrypoint.sh "$@"','native-entrypoint','postgres','-D','/tmp/native-data','-c','config_file=/etc/postgresql/postgresql.conf','-c','data_directory=/tmp/native-data','-c','hba_file=/tmp/native-data/pg_hba.conf','-c','listen_addresses=*','-c','ssl=on','-c','ssl_cert_file=/tmp/native-server.crt','-c','ssl_key_file=/tmp/native-server.key','-c','cron.database_name=postgres','-c','cron.launch_active_jobs=off','-c','shared_buffers=16MB','-c','max_connections=40'])
  # PGHOST 보강은 실제 소켓 설정의 명시화이며 v3 실패 원인을 확정하지 않는다.
  readiness=[];ready=False;readiness_started=time.monotonic()
  final_server_query="select json_build_object('postmasterPid',split_part(pg_read_file('postmaster.pid',0,2048),E'\\n',1)::integer,'pidStartedEpoch',split_part(pg_read_file('postmaster.pid',0,2048),E'\\n',3)::bigint,'serverStartedEpoch',floor(extract(epoch from pg_postmaster_start_time()))::bigint,'configFile',current_setting('config_file'),'dataDirectory',current_setting('data_directory'),'listenAddresses',current_setting('listen_addresses'),'cronClosed',current_setting('cron.launch_active_jobs')='off','sslEnabled',current_setting('ssl')='on','nativeCatalogReady',to_regclass('auth.users')is not null and exists(select 1 from pg_roles where rolname='supabase_storage_admin')and exists(select 1 from pg_roles where rolname='postgres'and not rolsuper));"
  def readiness_probe(argv,limit=4096):
   try:
    result=subprocess.run(t.DOCKER+['exec','--user','postgres',owned['db']]+argv,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=5)
    assert len(result.stdout)<=limit,'NATIVE_READINESS_OUTPUT_LIMIT'
    return result.returncode,result.stdout
   except subprocess.TimeoutExpired:return None,b''
  try:
   for attempt in range(120):
    elapsed=time.monotonic()-readiness_started
    if elapsed>=120:break
    assert own('db')['State']['Running'],'NATIVE_PG_ENTRYPOINT_EXITED'
    default_code,_=readiness_probe(['pg_isready','-U','supabase_admin'])
    explicit_code,_=readiness_probe(['pg_isready','-h','/var/run/postgresql','-U','supabase_admin','-d','postgres'])
    pid_code,pid_body=readiness_probe(['cat','/proc/1/comm'],32)
    pid=next((v for v in('postgres','.postgres-wrapp','bash','sh','docker-entrypoi','tini')if pid_code==0 and pid_body==(v+'\n').encode('ascii')),'OTHER_OR_UNAVAILABLE')
    exe_code,exe_body=readiness_probe(['readlink','/proc/1/exe'],512)
    exe_sha_code=None;exe_sha_body=b''
    if exe_code==0 and exe_body==(NATIVE_POSTGRES_EXE_PATH+'\n').encode('ascii'):
     exe_sha_code,exe_sha_body=readiness_probe(['sha256sum','/proc/1/exe'],256)
    exe_exact=exe_code==0 and exe_body==(NATIVE_POSTGRES_EXE_PATH+'\n').encode('ascii')and exe_sha_code==0 and exe_sha_body==(NATIVE_POSTGRES_EXE_SHA+'  /proc/1/exe\n').encode('ascii')
    sql_code,sql_body=readiness_probe(['psql','-XqAt','-h','/var/run/postgresql','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1','-c',final_server_query])
    sql_status='NOT_READY';server=None
    if sql_code==0:
     try:server=platform_json(sql_body)
     except (ValueError,UnicodeError):sql_status='INVALID_JSON'
     else:
      if native_final_server(server):sql_status='EXACT_FINAL_SERVER'
      else:sql_status='WRONG_OR_TEMP_SERVER'
    readiness.append({'attempt':attempt+1,'elapsedMs':round(elapsed*1000),'defaultPgIsreadyCode':default_code,'explicitSocketPgIsreadyCode':explicit_code,'pid1Code':pid_code,'pid1Comm':pid,'pid1CommPurpose':'OBSERVATION_ONLY','exePathCode':exe_code,'exeShaCode':exe_sha_code,'exeProof':'EXACT_CACHED_POSTGRES'if exe_exact else'UNVERIFIED_PATH_OR_HASH','sqlCode':sql_code,'sqlProof':sql_status})
    if explicit_code==0 and exe_exact and sql_status=='EXACT_FINAL_SERVER':
     save('native-pid1-executable-proof.json',{'path':NATIVE_POSTGRES_EXE_PATH,'sha256':NATIVE_POSTGRES_EXE_SHA,'cachedProofSha256':NATIVE_POSTGRES_PROOF_SHA,'actualProc1ExeObserved':True,'exactPostmasterPid':server['postmasterPid']});save('native-final-server-proof.json',server);ready=True;break
    time.sleep(.5)
  finally:save('native-pg-readiness-private.json',{'maxAttempts':120,'maxAttemptStartElapsedMs':120000,'finalElapsedMs':round((time.monotonic()-readiness_started)*1000),'wholeRunOrIndividualProbeDeadline':'NOT_ENFORCED','defaultPgIsreadyPurpose':'OBSERVATION_ONLY','pid1CommPurpose':'OBSERVATION_ONLY','successRequires':['EXPLICIT_SOCKET_READY','EXACT_CACHED_PID1_EXECUTABLE','EXACT_FINAL_SERVER_SQL'],'explicitPgHostConfigured':True,'defaultCommandUsesConfiguredPgHost':True,'v3FailureCauseConfirmed':False,'samples':readiness})
  assert ready,'NATIVE_PG_FINAL_SERVER_NOT_READY'
  save('native-pg-private.json',native_state())
  stage='native_tls_configure'
  hba=b'local all all trust\nhostnossl all all 0.0.0.0/0 reject\nhostssl postgres supabase_auth_admin 0.0.0.0/0 scram-sha-256\nhostssl postgres supabase_storage_admin 0.0.0.0/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n'
  save('pg-hba.conf',hba);docker('cp',str(root/'pg-hba.conf'),owned['db']+':/tmp/native-data/pg_hba.conf')
  docker('exec','--user','root',owned['db'],'chown','postgres:postgres','/tmp/native-data/pg_hba.conf')
  for role in('supabase_auth_admin','supabase_storage_admin'):query(owned['db'],"alter role "+role+" password '"+password+"';")
  assert query(owned['db'],'select pg_reload_conf();').strip()==b't','NATIVE_HBA_RELOAD_FAILED'
  assert query(owned['db'],'show ssl;').strip()==b'on'and query(owned['db'],'show listen_addresses;').strip()==b'*','NATIVE_TLS_SETTINGS_NOT_EFFECTIVE'
  assert query(owned['db'],"select count(*)=2 and bool_and(type='hostssl'and auth_method='scram-sha-256')from pg_hba_file_rules where user_name&&array['supabase_auth_admin','supabase_storage_admin'];").strip()==b't','NATIVE_EXACT_HOSTSSL_RULES_REQUIRED'
  initial_auth=platform_json(query(owned['db'],"select coalesce(json_agg(version order by version),'[]')from auth.schema_migrations;"));save('native-auth-history-before.json',initial_auth)
  stage='native_auth_migrate';create('auth',['migrate'])
  observed_tls('auth')
  assert docker('wait',owned['auth'],timeout=180).strip()==b'0','NATIVE_AUTH_MIGRATE_FAILED_NO_RETRY';stop('auth')
  auth=platform_json(query(owned['db'],"select coalesce(json_agg(version order by version),'[]')from auth.schema_migrations;"))
  assert auth and set(initial_auth)<=set(auth),'NATIVE_AUTH_HISTORY_EMPTY_OR_LOST';save('native-auth-history.json',auth);save('native-after-auth-private.json',native_state())
  stage='native_storage_migrate';create('storage',['dist/scripts/migrate-call.js'])
  observed_tls('storage')
  assert docker('wait',owned['storage'],timeout=180).strip()==b'0','NATIVE_STORAGE_MIGRATE_FAILED_NO_RETRY';stop('storage')
  storage=platform_json(query(owned['db'],"select coalesce(json_agg(json_build_object('id',id,'name',name,'hash',hash)order by id),'[]')from storage.migrations;"))
  assert storage and len({x['id']for x in storage})==len(storage),'NATIVE_STORAGE_HISTORY_EMPTY_OR_DUPLICATE'
  assert query(owned['db'],"select(select count(*)from storage.objects)=0 and(select count(*)from storage.buckets)=0 and exists(select 1 from information_schema.columns where table_schema='storage'and table_name='objects'and column_name='owner_id')and to_regprocedure('auth.uid()')is not null;").strip()==b't','NATIVE_REQUIRED_SCHEMA_OR_EMPTY_STORAGE_FAILED'
  save('native-storage-history.json',storage);final=native_state();save('native-final-private.json',final)
  receipt={'status':'PASS_NATIVE_PLATFORM_ONLY','scope':NATIVE_SCOPE,'graphSha256':graph_sha,'platformManifestSha256':NATIVE_MANIFEST_SHA,'nativeImageIds':{k:v['imageId']for k,v in manifest['images'].items()},'nativeExecutionFiles':{k:{p:v['files'][p]['sha256']for p in paths}for k,paths in{'db':('usr/local/bin/docker-entrypoint.sh','docker-entrypoint-initdb.d/migrate.sh'),'auth':('usr/local/bin/auth',),'storage':('app/dist/scripts/migrate-call.js','app/dist/internal/database/migrations/migrate.js','app/dist/config.js')}.items()for v in[manifest['images'][k]]},'authHistoryCount':len(auth),'authHistorySha256':final_digest(final_canonical(auth)),'storageHistoryCount':len(storage),'storageHistorySha256':final_digest(final_canonical(storage)),'nativeFinalSnapshotSha256':final_digest(final_canonical(final)),'nativeTableCount':len(final['rows']),'nativeTlsProofSha256':{k:final_digest((root/(k+'-tls.json')).read_bytes())for k in('auth','storage')},'originalAppOwnerAttributesPreserved':True,'appMigrationsApplied':0,'full118Applied':False,'sourceTableCount':186,'sourceStopRestartWrite':0,'providerSignupDeleteAck':0,'httpQueueServerStarts':0,'cachedOfficialBuildSourceMapping':'NOT_VERIFIED','activationAllowed':False}
  receipt['cachedPostgresExecutableProofSha256']=NATIVE_POSTGRES_PROOF_SHA;receipt['nativePid1ExecutableProofSha256']=final_digest((root/'native-pid1-executable-proof.json').read_bytes());receipt['nativeFinalServerProofSha256']=final_digest((root/'native-final-server-proof.json').read_bytes())
  receipt['ownerAuthorityComparisonsSha256']=final_digest(final_canonical(owner_authority));receipt['originalAppOwnerMembershipsExact']=owner_authority[-1]['membershipsExact'];receipt['canonicalAppApplicationReady']=False
  receipt['canonicalAppHoldReasons']=[]if owner_authority[-1]['membershipsExact']else['SOURCE_NATIVE_OWNER_MEMBERSHIPS_DIFFER_REVIEW_REQUIRED']
  passed=True
 except BaseException as error:
  token=str(error)if type(error)is AssertionError else''
  save('failure-private.json',{'stage':stage,'type':type(error).__name__,'assertion':token if re.fullmatch('[A-Z][A-Z0-9_]{0,100}',token)else'FIXED_UNCLASSIFIED','frames':[{'file':Path(f.filename).name,'function':f.name,'line':f.lineno}for f in traceback.extract_tb(error.__traceback__)]})
 finally:
  same=False;stopped=True
  try:
   identity_after=source_closed();after=whole_source()if before is not None else None
   same=before is not None and identity_after==source_identity and after==before
   if after is not None:save('source-after-private.json',after)
  except BaseException:same=False
  # create 응답이 유실돼도 이 실행의 exact labels/name/image로만 자기 ID를 수집한다.
  try:
   ids=docker('ps','-a','-q','--no-trunc','--filter','label=yumidang.run_id='+run_id,'--filter','label=yumidang.scope='+NATIVE_SCOPE).decode().splitlines()
   for container_id in ids:
    assert re.fullmatch('[a-f0-9]{64}',container_id),'NATIVE_DISCOVERED_OWN_ID_REQUIRED'
    info=inspect(container_id);kind=next((k for k in('db','auth','storage')if info['Name']=='/'+prefix+'-'+k),None)
    assert kind is not None and(kind not in owned or owned[kind]==container_id),'NATIVE_DISCOVERED_OWN_NAME_REQUIRED'
    owned[kind]=container_id;own_identity(kind)
  except BaseException:stopped=False
  for kind in reversed(tuple(owned)):
   try:stop(kind)
   except BaseException:stopped=False
  final_own={};physical_stopped=True
  for kind in owned:
   try:
    info=own_identity(kind);final_own[kind]={'id':info['Id'],'running':info['State']['Running'],'oomKilled':info['State'].get('OOMKilled')}
    physical_stopped=physical_stopped and info['State']['Running']is False
    stopped=stopped and info['State'].get('OOMKilled')is False
   except BaseException:physical_stopped=False;stopped=False
  save('finalization.json',{'sourceWholeUnchanged':same,'ownedStopped':physical_stopped,'ownedAllInvariantsVerified':stopped,'finalOwnedStates':final_own,'sourceStopRestartWrite':0,'originalMutationRetries':0,'networkPreserved':network,'volumeOrUnknownRemoval':0})
 assert passed and same and stopped,'NATIVE_PLATFORM_FAILED_CLOSED_PRESERVED'
 receipt['sourceWholeUnchanged']=same;receipt['ownedStopped']=stopped;receipt['finalOwnedStates']=final_own;receipt['ownedOomKilledFalse']=all(x['oomKilled']is False for x in final_own.values());save('receipt.json',receipt)
 print(json.dumps({'status':receipt['status'],'receiptSha256':final_digest(final_canonical(receipt)),'sourceWholeUnchanged':same,'ownedStopped':stopped,'activationAllowed':False,'full118Applied':False}))


def native_main(argv):
 import argparse
 from pathlib import Path
 parser=argparse.ArgumentParser(description='검토된 cached native 플랫폼-only 초기화. 기본 NOT_RUN.')
 parser.add_argument('--platform-baseline',action='store_true',required=True);parser.add_argument('--run',action='store_true');parser.add_argument('--graph-manifest',type=Path);parser.add_argument('--revision')
 args=parser.parse_args(argv)
 if not args.run:
  assert args.graph_manifest is None and args.revision is None,'NATIVE_RUN_FLAGS_REQUIRED'
  print(json.dumps({'status':'NOT_RUN','scope':NATIVE_SCOPE,'platformManifestSha256':NATIVE_MANIFEST_SHA,'graphApprovedByRoot':False,'dockerSlotReady':False,'dockerCalls':0,'nativeCommands':{'pg':'cached docker-entrypoint native init','auth':'/usr/local/bin/auth migrate','storage':'node dist/scripts/migrate-call.js'},'dbMemoryMiB':512,'sequentialRunnerMemoryMiB':128,'minimumAvailableMiB':768,'appMigrationsApplied':0,'activationAllowed':False}));return
 assert args.graph_manifest is not None and args.revision is not None,'NATIVE_FROZEN_GRAPH_REVISION_REQUIRED'
 run_native_platform(args)


def platform_main(argv):
 import argparse
 from pathlib import Path
 parser=argparse.ArgumentParser(description='캐시 이미지 archive의 허용 파일만 읽는 offline 플랫폼 자료 수집. Docker 호출 없음.')
 parser.add_argument('--platform-manifest',action='store_true',required=True)
 parser.add_argument('--collect-offline',action='store_true');parser.add_argument('--input-bundle',type=Path);parser.add_argument('--output-root',type=Path)
 args=parser.parse_args(argv)
 if not args.collect_offline:
  assert args.input_bundle is None and args.output_root is None,'OFFLINE_INPUT_FLAG_REQUIRED'
  print(json.dumps({'status':'NOT_RUN','dockerCalls':0,'images':PLATFORM_IMAGES,'allowedPrefixes':PLATFORM_PREFIXES,'allowedExactFiles':PLATFORM_EXACT,
   'futureReadOnlyCommands':{kind:{'inspect':t.DOCKER+['image','inspect',reference],'save':t.DOCKER+['image','save','<exact inspected sha256:image ID>']}for kind,reference in PLATFORM_IMAGES.items()},
   'appOwnerReadOnlyCommand':t.DOCKER+['exec','-i',FINAL_SOURCE,'psql','-XqAt','-U',BOOT,'-d','postgres','-v','ON_ERROR_STOP=1'],
   'appOwnerReadOnlyQuery':PLATFORM_OWNER_QUERY,'outputsMustUsePrivate700Exclusive600':True,
   'sourceCommitBinding':'NOT_VERIFIED','pullStartBuildExecCreate':0,'rootReviewBeforeActualCollection':True}));return
 assert args.input_bundle is not None and args.output_root is not None,'OFFLINE_INPUT_AND_FRESH_OUTPUT_REQUIRED'
 try:print(json.dumps(platform_collect(args.input_bundle,args.output_root)))
 except Exception:
  print(json.dumps({'status':'FAIL_CLOSED_PLATFORM_INPUT','dockerCalls':0,'rawErrorsStored':False}));raise SystemExit(1)


CANONICAL_SCOPE='NATIVE_CANONICAL_119_APPLICATION_ONLY'
CANONICAL_RESERVATION_ROOT='/private/tmp/yumidang-canonical119-reservations-20261010'
CANONICAL_NATIVE_DRIVER_SHA='86af8198a2a2f1c1278176ac276e44b2d8c212d47c5c570b95d82fbd1ef950ec'
CANONICAL_NATIVE_GRAPH_SHA='b2570cb1c00d2f302bb1921f4fa8aaa1ffad53839bb53ce28b40d8df9c315d8b'
CANONICAL_NATIVE_ROOT='/private/tmp/yumidang-platform-baseline-20261010-native-v7'
CANONICAL_NATIVE_PROOFS={'receipt.json': '50cdf2d5aa99e4ddc98467c527263cf39009ee9355ff466bd45fb2b31fd46573', 'finalization.json': '8dd2b28bb49eb211d0dfcac48cc64742b9bc6d23128d0296bebfe48fdbf3eae0', 'native-final-private.json': 'd0bf464c2aa89e46ee3ea1f0d093948d74f369c7216271b1cc008764b0ec0f3c', 'db-intent.json': 'b78d00ad96ef2636d085328d43d811b21a70746c9da8ea818000ac6ace154bb9', 'native-pid1-executable-proof.json': 'cd21eff5b38dd6352ecd735577ea89e0e6a5b187f9832549e02fda24adf37e1d', 'native-final-server-proof.json': '8911c80e2b144d70eba45bcc53378580888617f33f4c9ba124c2e50287193e01', 'auth-tls.json': 'fea0bd6aa8ed1c0f8e6ac115db8c84f2c4410618f551be58930fdbe8b701b5da', 'storage-tls.json': '36f525cd4648edceca04eb54e9ec3c2394c215f16fb639ec69c7ebc646299197', 'native-owner-authority-native-storage-migrate.json': '7a546dd27288ff58ba11231f60754465f3da6b38331c66791620de6628d50656', 'native-auth-history.json': '1e6673dc3ca115d5ab0ce925e16a81fcbb0843ce89543b0d1e5bd4f6fc989eb7', 'native-storage-history.json': '033db193c28bd44145476e2363ff35cd79984c0f8fa9d83089abff23118cf121'}
CANONICAL_CLOSED_PLAN_SHA='3517ee07ddaba30d0d9cfa84366a6c99c29912a2c70dd58a2082cf391963903a'
CANONICAL_PRODUCT_SHA='95ed516fd7d78d9cca39efbb3db105a6b46c9ee612e3c7873d2fe7061ef76b56'
CANONICAL_PREPARATION={
 'tools/local/prepare_current_policy.py':'4237db5846d2f2d6db83ad288aefb7af6802a2349d13cdde3fcaa736485626d9',
 'tools/local/prepare_edge.py':'e3f9d3c7760eef4d8cb0eb1de557f6e89c58e5b80f01936209612ebf42613748',
}


def canonical_graph(path):
 """준비 자료·native 실제 결과·이번 적용 승인은 서로 다른 입력이다."""
 import ast
 from pathlib import Path
 def private_json(file,limit):
  with platform_open(file)as stream:raw=stream.read(limit+1)
  assert len(raw)<=limit,'CANONICAL_PRIVATE_INPUT_SIZE_LIMIT'
  return platform_json(raw),final_digest(raw)
 g,graph_sha=private_json(path,1024**2)
 keys={'version','kind','approvedByRoot','dockerSlotReady','repo','files','prepareManifest','prepareManifestSha256','preparedSqlRoot','nativeGraph','nativeGraphSha256','nativeRoot','nativeProofs','nativeStoppedIdentity','sourceId','sourceWholeSha256','closedPlan','closedPlanSha256'}
 assert isinstance(g,dict)and set(g)==keys and type(g['version'])is int and g['version']==1 and g['kind']==CANONICAL_SCOPE,'CANONICAL_EXACT_GRAPH_REQUIRED'
 assert g['approvedByRoot']is True and g['dockerSlotReady']is True,'CANONICAL_ROOT_AND_SLOT_REQUIRED'
 repo=Path(g['repo']);assert repo.is_absolute()and repo.resolve()==repo,'CANONICAL_REPO_REQUIRED'
 required={'tests/integration/minkyu/product_connection_restore108_local.py',*FINAL_FIXED,*CANONICAL_PREPARATION}
 assert set(g['files'])==required,'CANONICAL_EXACT_DEPENDENCIES_REQUIRED'
 for name,sha in g['files'].items():
  assert isinstance(sha,str)and re.fullmatch('[a-f0-9]{64}',sha),'CANONICAL_DEPENDENCY_SHA_REQUIRED'
  assert(repo/name).stat().st_size<=2*1024**2 and final_digest(final_regular(repo/name))==sha,'CANONICAL_DEPENDENCY_CHANGED'
 for name,sha in {**FINAL_FIXED,**CANONICAL_PREPARATION}.items():assert g['files'][name]==sha,'CANONICAL_FIXED_DEPENDENCY_CHANGED'
 assert g['files']['tests/integration/minkyu/product_connection_restore108_local.py']==final_digest(Path(__file__).read_bytes()),'CANONICAL_EXECUTING_DRIVER_CHANGED'
 # 고정 registry의 literal만 읽고 module을 import/execute하지 않는다.
 maps=[]
 for name,target,count in(('tools/local/prepare_edge.py','GATEWAY_REVIEWED_MIGRATIONS',41),('tools/local/prepare_current_policy.py','CURRENT_POLICY_REVIEWED',78)):
  nodes=[n.value for n in ast.parse(final_regular(repo/name)).body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id==target for t in n.targets)]
  assert len(nodes)==1,'CANONICAL_ONE_LITERAL_REGISTRY_REQUIRED'
  value=ast.literal_eval(nodes[0]);assert isinstance(value,dict)and len(value)==count,'CANONICAL_REGISTRY_COUNT_REQUIRED';maps.append(value)
 assert not set(maps[0])&set(maps[1]),'CANONICAL_REGISTRY_DUPLICATE'
 reviewed={**maps[0],**maps[1]};assert len(reviewed)==119,'CANONICAL_119_REQUIRED'
 # 현재 닫힌 준비물과 실제 앱 SQL 원 바이트를 연결하며 실행 승인으로 승격하지 않는다.
 plan,plan_sha=private_json(Path(g['closedPlan']),4*1024**2)
 assert plan_sha==g['closedPlanSha256']==CANONICAL_CLOSED_PLAN_SHA,'CANONICAL_CURRENT_CLOSED_PLAN_REQUIRED'
 assert plan['status']=='PREPARED_NOT_ACTIVATED'and plan['activationAllowed']is False and plan['operatingChanged']is False and plan['reviewedCount']==119 and plan['migrationManifestSha256']==final_digest(final_canonical(reviewed)),'CANONICAL_CLOSED_PLAN_SCOPE_REQUIRED'
 product=plan['productSources'];assert product['sha256']==CANONICAL_PRODUCT_SHA and product['deploymentVerified']is False and product['mode']=='working_tree_snapshot','CANONICAL_CURRENT_PRODUCT_REFERENCE_REQUIRED'
 inventory=product['files'];assert isinstance(inventory,list)and len(inventory)==162 and final_digest(final_canonical(inventory))==CANONICAL_PRODUCT_SHA,'CANONICAL_CURRENT_PRODUCT_INVENTORY_REQUIRED'
 names=[]
 for item in inventory:
  assert isinstance(item,dict)and set(item)=={'path','sha256','bytes'},'CANONICAL_PRODUCT_METADATA_REQUIRED'
  name=item['path'];assert isinstance(name,str)and (name in('backend/package.json','backend/package-lock.json','backend/supabase/config.toml')or re.fullmatch(r'backend/supabase/functions/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\.(?:ts|mjs|json)',name))and name not in names,'CANONICAL_PRODUCT_PATH_REQUIRED';names.append(name)
  assert type(item['bytes'])is int and 0<item['bytes']<=2*1024**2 and re.fullmatch('[a-f0-9]{64}',item['sha256']),'CANONICAL_PRODUCT_SIZE_SHA_REQUIRED'
  raw=final_regular(repo/name);assert len(raw)==item['bytes']and final_digest(raw)==item['sha256'],'CANONICAL_CURRENT_PRODUCT_BYTES_CHANGED'
 assert names==sorted(names),'CANONICAL_PRODUCT_ORDER_REQUIRED'
 prep,prep_sha=private_json(Path(g['prepareManifest']),4*1024**2)
 assert prep_sha==g['prepareManifestSha256'],'CANONICAL_PREPARE_MANIFEST_CHANGED'
 assert prep['status']=='READY'and prep['mode']=='current_policy_gateway'and prep['sql_execution']=='NOT_RUN'and prep['edge_execution']=='NOT_RUN'and prep['count']==prep['migration_count']==119 and prep['base_migration_count']==41 and prep['policy_migration_count']==78,'CANONICAL_PREPARATION_ONLY_SCOPE_REQUIRED'
 entries=prep['migrations'];assert isinstance(entries,list)and len(entries)==119,'CANONICAL_EXACT_ORDERED_INPUT_REQUIRED'
 sql_root=Path(g['preparedSqlRoot']);assert sql_root.is_absolute()and sql_root.resolve()==sql_root and sql_root.is_dir()and not sql_root.is_symlink(),'CANONICAL_PREPARED_SQL_ROOT_REQUIRED'
 payloads=[];seen=set();versions=[]
 for entry in entries:
  assert isinstance(entry,dict)and set(entry)=={'version','path','sha256','bytes'},'CANONICAL_ENTRY_SHAPE_REQUIRED'
  name=entry['path'];assert isinstance(name,str)and re.fullmatch(r'backend/supabase/migrations/[0-9]{14}_[a-z0-9_]+\.sql',name)and name in reviewed and name not in seen,'CANONICAL_REGISTERED_PATH_REQUIRED';seen.add(name)
  version=Path(name).name[:14];assert entry['version']==version and version not in versions,'CANONICAL_VERSION_REQUIRED';versions.append(version)
  assert entry['sha256']==reviewed[name]and type(entry['bytes'])is int and 0<entry['bytes']<=2*1024**2,'CANONICAL_EXACT_MIGRATION_METADATA_REQUIRED'
  original=final_regular(repo/name);prepared=final_regular(sql_root/Path(name).name)
  assert prepared==original and len(original)==entry['bytes']and final_digest(original)==entry['sha256'],'CANONICAL_ORIGINAL_SQL_BYTES_REQUIRED';payloads.append(original)
 assert seen==set(reviewed)and versions==sorted(versions)and [e['path']for e in entries]==sorted(reviewed),'CANONICAL_EXACT_119_ORDER_REQUIRED'
 ng,ng_sha=private_json(Path(g['nativeGraph']),1024**2);assert ng_sha==g['nativeGraphSha256']==CANONICAL_NATIVE_GRAPH_SHA,'CANONICAL_NATIVE_GRAPH_CHANGED'
 native_keys={'version','kind','approvedByRoot','dockerSlotReady','repo','files','platformManifest','platformManifestSha256','sourceId','sourceWholeSha256','sourceOwnerCatalogSha256','cachedPostgresExecutableProof','cachedPostgresExecutableProofSha256'}
 assert set(ng)==native_keys and type(ng['version'])is int and ng['version']==1 and ng['kind']==NATIVE_SCOPE and ng['approvedByRoot']is True and ng['dockerSlotReady']is True and ng['repo']==str(repo),'CANONICAL_REVIEWED_NATIVE_GRAPH_REQUIRED'
 assert ng['files']=={'tests/integration/minkyu/product_connection_restore108_local.py':CANONICAL_NATIVE_DRIVER_SHA,**FINAL_FIXED}and ng['platformManifestSha256']==NATIVE_MANIFEST_SHA,'CANONICAL_REVIEWED_NATIVE_INPUT_REQUIRED'
 platform,platform_sha=private_json(Path(ng['platformManifest']),4*1024**2);assert platform_sha==NATIVE_MANIFEST_SHA,'CANONICAL_PLATFORM_MANIFEST_CHANGED'
 assert ng['cachedPostgresExecutableProof']==NATIVE_POSTGRES_PROOF_PATH and ng['cachedPostgresExecutableProofSha256']==NATIVE_POSTGRES_PROOF_SHA,'CANONICAL_CACHED_EXECUTABLE_BINDING_REQUIRED'
 cached,cached_sha=private_json(Path(ng['cachedPostgresExecutableProof']),1024**2);assert cached_sha==NATIVE_POSTGRES_PROOF_SHA,'CANONICAL_CACHED_EXECUTABLE_PROOF_CHANGED';native_cached_postgres(cached,platform)
 native_root=Path(g['nativeRoot']);assert native_root.is_absolute()and native_root.resolve()==native_root and str(native_root)==CANONICAL_NATIVE_ROOT,'CANONICAL_NATIVE_ROOT_REQUIRED'
 proof_names=set(CANONICAL_NATIVE_PROOFS);assert g['nativeProofs']==CANONICAL_NATIVE_PROOFS,'CANONICAL_NATIVE_PROOF_SET_REQUIRED';proofs={}
 for name,sha in g['nativeProofs'].items():
  assert isinstance(sha,str)and re.fullmatch('[a-f0-9]{64}',sha),'CANONICAL_NATIVE_PROOF_SHA_REQUIRED'
  value,actual=private_json(native_root/name,8*1024**2);assert actual==sha,'CANONICAL_NATIVE_PROOF_CHANGED';proofs[name]=value
 receipt=proofs['receipt.json'];final=proofs['finalization.json'];baseline=proofs['native-final-private.json'];intent=proofs['db-intent.json'];identity=g['nativeStoppedIdentity']
 assert native_final_server(proofs['native-final-server-proof.json']),'CANONICAL_NATIVE_FINAL_SERVER_REQUIRED'
 exe=proofs['native-pid1-executable-proof.json'];assert exe=={'actualProc1ExeObserved':True,'cachedProofSha256':NATIVE_POSTGRES_PROOF_SHA,'exactPostmasterPid':1,'path':NATIVE_POSTGRES_EXE_PATH,'sha256':NATIVE_POSTGRES_EXE_SHA},'CANONICAL_NATIVE_PID1_EXECUTABLE_REQUIRED'
 for kind,role in(('auth','supabase_auth_admin'),('storage','supabase_storage_admin')):
  tls=proofs[kind+'-tls.json'];assert tls['expectedRole']==role and tls['sslmode']=='verify-full'and tls['serverAlias']=='mplatform-pg'and isinstance(tls['actualSessions'],list)and tls['actualSessions'],'CANONICAL_NATIVE_TLS_REQUIRED'
  assert all(s['role']==role and s['ssl']is True and s['protocol']in('TLSv1.2','TLSv1.3')and type(s['bits'])is int and s['bits']>=128 and isinstance(s['cipher'],str)and s['cipher']for s in tls['actualSessions']),'CANONICAL_NATIVE_TLS_SESSION_REQUIRED'
 assert receipt['authHistoryCount']==len(proofs['native-auth-history.json'])==77 and receipt['storageHistoryCount']==len(proofs['native-storage-history.json'])==63,'CANONICAL_NATIVE_HISTORY_COUNT_REQUIRED'
 assert receipt['authHistorySha256']==final_digest(final_canonical(proofs['native-auth-history.json']))and receipt['storageHistorySha256']==final_digest(final_canonical(proofs['native-storage-history.json'])),'CANONICAL_NATIVE_HISTORY_CHANGED'
 authority=proofs['native-owner-authority-native-storage-migrate.json'];assert authority['ownerAttributesExact']is True and authority['automaticRepair']is False and authority['nativeOwnerMemberships']==[r for r in baseline['roles']['memberships']if r[1]=='postgres'],'CANONICAL_NATIVE_AUTHORITY_REQUIRED'
 assert receipt['status']=='PASS_NATIVE_PLATFORM_ONLY'and receipt['scope']==NATIVE_SCOPE and receipt['graphSha256']==ng_sha and receipt['platformManifestSha256']==NATIVE_MANIFEST_SHA,'CANONICAL_ACTUAL_NATIVE_PASS_REQUIRED'
 assert receipt['appMigrationsApplied']==0 and receipt['full118Applied']is False and receipt['activationAllowed']is False and receipt['sourceWholeUnchanged']is True and receipt['sourceStopRestartWrite']==0 and receipt['ownedStopped']is True and receipt['ownedOomKilledFalse']is True and receipt['originalAppOwnerAttributesPreserved']is True,'CANONICAL_NATIVE_CLOSED_SCOPE_REQUIRED'
 assert final_digest(final_canonical(baseline))==receipt['nativeFinalSnapshotSha256']and len(baseline['rows'])==receipt['nativeTableCount']and receipt['nativeImageIds']=={k:v['imageId']for k,v in platform['images'].items()},'CANONICAL_NATIVE_SNAPSHOT_OR_IMAGES_CHANGED'
 assert final['sourceWholeUnchanged']is True and final['ownedStopped']is True and final['ownedAllInvariantsVerified']is True and final['finalOwnedStates']==receipt['finalOwnedStates']and final['sourceStopRestartWrite']==0,'CANONICAL_NATIVE_FINALIZATION_REQUIRED'
 assert set(identity)=={'id','name','runId','imageId','configSha256','hostConfigSha256','mountsSha256','networkId'},'CANONICAL_STOPPED_IDENTITY_REQUIRED'
 for key in('id','configSha256','hostConfigSha256','mountsSha256','networkId'):assert isinstance(identity[key],str)and re.fullmatch('[a-f0-9]{64}',identity[key]),'CANONICAL_IDENTITY_SHA_REQUIRED'
 revision=native_root.name.removeprefix('yumidang-platform-baseline-20261010-')
 assert identity['name']=='yumidang-minkyu-'+revision+'-db'and identity['imageId']==receipt['nativeImageIds']['db']and identity['id']==intent['id']==receipt['finalOwnedStates']['db']['id']and identity['runId']==intent['runId'],'CANONICAL_EXACT_NATIVE_DB_REQUIRED'
 assert receipt['finalOwnedStates']['db']=={'id':identity['id'],'running':False,'oomKilled':False}and intent['imageId']==identity['imageId'],'CANONICAL_NATIVE_DB_STOPPED_REQUIRED'
 assert g['sourceId']==ng['sourceId']and g['sourceWholeSha256']==ng['sourceWholeSha256'],'CANONICAL_PROTECTED_SOURCE_BINDING_REQUIRED'
 for key in('sourceId','sourceWholeSha256'):assert re.fullmatch('[a-f0-9]{64}',g[key]),'CANONICAL_SOURCE_SHA_REQUIRED'
 return g,entries,payloads,proofs,platform,graph_sha


def canonical_authority(before,after):
 """native grantor를 원 source 이름으로 바꾸거나 추가 권한을 숨기지 않는다."""
 roles={r['rolname']:r for r in before['roles']};actual={r['rolname']:r for r in after['roles']}
 new={'yumidang_completion_runner','yumidang_worker_queue'}
 assert not set(roles)&new and set(actual)==set(roles)|new,'CANONICAL_EXACT_TWO_NEW_ROLES_REQUIRED'
 assert all(actual[name]==value for name,value in roles.items()),'CANONICAL_NATIVE_ROLE_ATTRIBUTES_CHANGED'
 for name in new:
  r=actual[name]
  assert all(r[k]is False for k in('rolsuper','rolinherit','rolcreaterole','rolcreatedb','rolcanlogin','rolreplication','rolbypassrls'))and r['rolconnlimit']==-1 and r['rolvaliduntil']is None and r['rolconfig']is None,'CANONICAL_RUNNER_ROLE_NOT_CLOSED'
 expected=list(before['memberships'])+[[name,'postgres','supabase_admin',True,False,False]for name in sorted(new)]
 assert sorted(after['memberships'])==sorted(expected),'CANONICAL_NATIVE_GRANTORS_OR_OPTIONS_CHANGED'
 return {'nativeExistingRoleAttributesExact':True,'nativeExistingMembershipsExact':True,'newRunnerCount':2,'newRunnerGrantor':'supabase_admin','oldSourceGrantorsRelabeled':False,'source112AuthorityExact':'NOT_VERIFIED_DIFFERENT_BASELINE'}


def canonical_reserve(root,db,record):
 """완전 rollback이어도 과거 UNKNOWN 시도를 새 revision에서 재전송하지 않는다."""
 import os,stat
 from pathlib import Path
 assert root==Path(CANONICAL_RESERVATION_ROOT)and root.is_absolute()and root.resolve()==root,'CANONICAL_FIXED_RESERVATION_ROOT_REQUIRED'
 assert re.fullmatch('[a-f0-9]{64}',db),'CANONICAL_RESERVATION_DB_ID_REQUIRED'
 created=not root.exists()
 if created:root.mkdir(mode=0o700)
 info=root.stat();assert stat.S_ISDIR(info.st_mode)and stat.S_IMODE(info.st_mode)==0o700 and info.st_uid==os.getuid()and not any(p.is_symlink()for p in(root,*root.parents)),'CANONICAL_PRIVATE_RESERVATION_ROOT_REQUIRED'
 path=root/(db+'.json');raw=final_canonical(record)
 with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb')as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
 # 이전 parent sync 실패로 남은 root를 다시 써도 세 entry를 모두 동기화한다.
 for directory in(root,root.parent):
  descriptor=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:
   assert stat.S_ISDIR(os.fstat(descriptor).st_mode),'CANONICAL_SYNC_DIRECTORY_REQUIRED'
   os.fsync(descriptor)
  finally:os.close(descriptor)
 return final_digest(raw)


def run_canonical_application(args):
 """실제 native 자기 DB의 앱 적용. 기존 source/부분 복원과 범위를 합치지 않는다."""
 import importlib.util,os,sys,traceback
 from pathlib import Path
 g,entries,payloads,proofs,platform,graph_sha=canonical_graph(args.graph_manifest)
 assert re.fullmatch('canonical-v[1-9][0-9]{0,5}',args.revision),'CANONICAL_FRESH_REVISION_REQUIRED'
 root=Path('/private/tmp/yumidang-canonical-application-20261010-'+args.revision)
 assert not root.exists()and not root.is_symlink(),'CANONICAL_PRIOR_UNKNOWN_PRESERVED';root.mkdir(mode=0o700)
 target=g['nativeStoppedIdentity'];db=target['id'];stage='source_before';before=None;source_identity=None;started=False;passed=False;applied=[];receipt=None
 def save(name,value):
  assert re.fullmatch('[A-Za-z0-9.-]+',name),'CANONICAL_ARTIFACT_NAME_REQUIRED';raw=value if isinstance(value,bytes)else final_canonical(value)
  with os.fdopen(os.open(root/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb')as f:f.write(raw)
 def call(argv,data=None):
  result=subprocess.run(argv,input=data,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=180)
  assert result.returncode==0 and len(result.stdout)<=64*1024**2,'CANONICAL_COMMAND_FAILED_NO_REPLAY';return result.stdout
 def docker(*argv,data=None):return call(t.DOCKER+list(argv),data)
 def inspect(name):
  values=platform_json(docker('inspect',name));assert len(values)==1,'CANONICAL_ONE_EXACT_CONTAINER_REQUIRED';return values[0]
 def own_identity():
  x=inspect(db);labels=x['Config']['Labels']
  assert x['Id']==db and x['Name']=='/'+target['name']and labels.get('yumidang.owner')=='minkyu'and labels.get('yumidang.run_id')==target['runId']and labels.get('yumidang.scope')==NATIVE_SCOPE and x['Config']['Image']==target['imageId'],'CANONICAL_NATIVE_OWN_IDENTITY_REQUIRED';return x
 def own():
  x=own_identity();h=x['HostConfig']
  assert x['State'].get('OOMKilled')is False and h['Memory']==h['MemorySwap']==512*1024**2 and h['NanoCpus']==500000000 and h['PidsLimit']==128 and not h['PortBindings']and not x['Mounts']and h['LogConfig']['Type']=='none'and x['Config']['Healthcheck']['Test']==['NONE'],'CANONICAL_NATIVE_CAPS_REQUIRED'
  assert final_digest(final_canonical(x['Config']))==target['configSha256']and final_digest(final_canonical(h))==target['hostConfigSha256']and final_digest(final_canonical(x['Mounts']))==target['mountsSha256'],'CANONICAL_NATIVE_RUNTIME_CONFIG_CHANGED'
  assert [v['NetworkID']for v in x['NetworkSettings']['Networks'].values()]==[target['networkId']],'CANONICAL_NATIVE_NETWORK_CHANGED';return x
 def stop():
  x=own_identity();failed=False
  try:own()
  except BaseException:failed=True
  if x['State']['Running']:docker('stop','--time','15',db)
  assert own_identity()['State']['Running']is False,'CANONICAL_OWN_STOP_FAILED'
  assert not failed,'CANONICAL_OWN_INVARIANT_FAILED_BUT_STOPPED'
 def query(name,statement):
  assert name in(FINAL_SOURCE,db),'CANONICAL_QUERY_SCOPE_REQUIRED'
  assert not re.search(r'\b(insert|update|delete|create|alter|drop|truncate|grant|revoke|nextval|setval)\b',statement,re.I),'CANONICAL_QUERY_READONLY_REQUIRED'
  sql="begin read only;set local statement_timeout='30s';"+statement+'commit;'
  return docker('exec','-i',g['sourceId']if name==FINAL_SOURCE else db,'psql','-XqAt','-U',BOOT if name==FINAL_SOURCE else'supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1',data=sql.encode())
 repo=Path(g['repo']);sys.path.insert(0,str(repo/'tests/integration/minkyu'))
 spec=importlib.util.spec_from_file_location('canonical_fixed_snapshot',repo/'tests/integration/minkyu/member_cleanup_reconcile_local.py');helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
 def helper_call(argv,data=None):
  for name,user,identity in((FINAL_SOURCE,BOOT,g['sourceId']),(db,'supabase_admin',db)):
   if list(argv)==t.DOCKER+['exec',name,'pg_dump','-U',BOOT,'-d','postgres','--schema-only']:
    assert data is None,'CANONICAL_SCHEMA_DUMP_STDIN_REFUSED';return docker('exec',identity,'pg_dump','-U',user,'-d','postgres','--schema-only')
  raise AssertionError('CANONICAL_HELPER_SCHEMA_ONLY_REQUIRED')
 helper.query=query;helper.call=helper_call
 def source_whole():
  names=platform_json(query(FINAL_SOURCE,"select coalesce(json_agg(json_build_array(n.nspname,c.relname)order by n.nspname,c.relname),'[]')from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S'and left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema';"));seq={}
  for schema,name in names:
   target_name='"'+schema.replace('"','""')+'"."'+name.replace('"','""')+'"';seq[schema+'.'+name]=platform_json(query(FINAL_SOURCE,'select json_build_array(last_value,is_called)from '+target_name+';'))
  return {'snapshot':helper.normalized_snapshot(FINAL_SOURCE),'sequences':seq}
 def source_closed():
  x=inspect(g['sourceId']);assert x['Id']==g['sourceId']and x['Name']=='/'+FINAL_SOURCE and x['State']['Running']and x['Config']['Labels'].get('yumidang.owner')=='minkyu','CANONICAL_SOURCE_ID_REQUIRED'
  assert_closed(lambda sql:query(FINAL_SOURCE,sql));assert query(FINAL_SOURCE,'show cron.launch_active_jobs;').strip()==b'off','CANONICAL_SOURCE_CRON_REQUIRED'
  for table in('worker_invocation_control','worker_intent_confirmation_control','event_collection_control','content_inspection_control','member_retirement_receipt_control'):
   if query(FINAL_SOURCE,"select to_regclass('private."+table+"');").strip():assert query(FINAL_SOURCE,'select not enabled from private.'+table+' where singleton;').strip()==b't','CANONICAL_SOURCE_CONTROL_OPEN'
  assert query(FINAL_SOURCE,"select count(*)from pg_stat_activity where datname=current_database()and backend_type='client backend'and state='active'and pid<>pg_backend_pid();").strip()==b'0','CANONICAL_SOURCE_NOT_QUIESCENT'
  return {'id':x['Id'],'configSha256':final_digest(final_canonical(x['Config'])),'hostConfigSha256':final_digest(final_canonical(x['HostConfig'])),'mountsSha256':final_digest(final_canonical(x['Mounts'])),'startedAt':x['State']['StartedAt'],'restartCount':x['RestartCount']}
 def closed_app():
  assert query(db,'show cron.launch_active_jobs;').strip()==b'off','CANONICAL_CRON_OPEN'
  assert_closed(lambda sql:query(db,sql))
  for table in('worker_invocation_control','worker_intent_confirmation_control','event_collection_control','content_inspection_control','member_retirement_receipt_control'):
   assert query(db,'select not enabled from private.'+table+' where singleton;').strip()==b't','CANONICAL_CONTROL_NOT_CLOSED'
  assert query(db,"select(select count(*)from auth.users)=0 and(select count(*)from storage.objects)=0;").strip()==b't','CANONICAL_MEMBER_OR_STORAGE_FIXTURE_PRESENT'
  assert query(db,"select bool_and(not rolcanlogin and not rolsuper and not rolinherit and not rolcreaterole and not rolcreatedb and not rolreplication and not rolbypassrls)from pg_roles where rolname in('yumidang_completion_runner','yumidang_worker_queue');").strip()==b't','CANONICAL_RUNNER_PRIVILEGE_PROMOTION'
  assert query(db,"select not has_schema_privilege('yumidang_completion_runner','private','USAGE')and not has_schema_privilege('yumidang_worker_queue','private','USAGE');").strip()==b't','CANONICAL_RUNNER_PRIVATE_ACCESS'
 try:
  source_identity=source_closed();before=source_whole();assert len(before['snapshot']['rows'])==186 and final_digest(final_canonical(before))==g['sourceWholeSha256'],'CANONICAL_SOURCE_WHOLE_CHANGED'
  save('source-before-private.json',before);save('source-identity-private.json',source_identity)
  assert own()['State']['Running']is False,'CANONICAL_NATIVE_DB_NOT_STOPPED'
  mem=re.findall(r'^MemAvailable:\s+([0-9]+) kB$',docker('exec',g['sourceId'],'cat','/proc/meminfo').decode(),re.M)
  assert len(mem)==1,'CANONICAL_MEMORY_PROOF_REQUIRED';save('memory-before-start.json',{'availableKiB':int(mem[0]),'minimumMiB':768,'dbMiB':512,'newRunners':0});assert int(mem[0])>=768*1024,'CANONICAL_MEMORY_LOW_START0'
  save('restart-intent.json',{'id':db,'runId':target['runId'],'nativeReceiptSha256':g['nativeProofs']['receipt.json'],'restartCount':1,'applicationScope':CANONICAL_SCOPE})
  reservation=Path(CANONICAL_RESERVATION_ROOT)/(db+'.json')
  assert not reservation.exists()and not reservation.is_symlink(),'CANONICAL_PRIOR_APPLICATION_ATTEMPT_PRESERVED'
  stage='native_restart';started=True;docker('start',db)
  ready=False
  for _ in range(120):
   if not own()['State']['Running']:raise AssertionError('CANONICAL_NATIVE_DB_EXITED')
   result=subprocess.run(t.DOCKER+['exec','--user','postgres',db,'pg_isready','-h','/var/run/postgresql','-U','supabase_admin','-d','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
   if result.returncode==0:
    link=docker('exec','--user','postgres',db,'readlink','/proc/1/exe');binary=docker('exec','--user','postgres',db,'sha256sum','/proc/1/exe')
    assert link==(NATIVE_POSTGRES_EXE_PATH+'\n').encode('ascii')and binary==(NATIVE_POSTGRES_EXE_SHA+'  /proc/1/exe\n').encode('ascii'),'CANONICAL_RESTART_PID1_EXECUTABLE_REQUIRED'
    server=platform_json(query(db,"select json_build_object('postmasterPid',split_part(pg_read_file('postmaster.pid',0,2048),E'\\n',1)::integer,'pidStartedEpoch',split_part(pg_read_file('postmaster.pid',0,2048),E'\\n',3)::bigint,'serverStartedEpoch',floor(extract(epoch from pg_postmaster_start_time()))::bigint,'configFile',current_setting('config_file'),'dataDirectory',current_setting('data_directory'),'listenAddresses',current_setting('listen_addresses'),'cronClosed',current_setting('cron.launch_active_jobs')='off','sslEnabled',current_setting('ssl')='on','nativeCatalogReady',to_regclass('auth.users')is not null and exists(select 1 from pg_roles where rolname='supabase_storage_admin')and exists(select 1 from pg_roles where rolname='postgres'and not rolsuper));"));assert native_final_server(server),'CANONICAL_RESTART_FINAL_SERVER_REQUIRED'
    save('canonical-restart-server-proof.json',server);save('canonical-restart-executable-proof.json',{'actualProc1ExeObserved':True,'path':NATIVE_POSTGRES_EXE_PATH,'sha256':NATIVE_POSTGRES_EXE_SHA,'cachedProofSha256':NATIVE_POSTGRES_PROOF_SHA});ready=True;break
   time.sleep(.5)
  assert ready,'CANONICAL_NATIVE_DB_NOT_READY'
  baseline=helper.normalized_snapshot(db);assert baseline==proofs['native-final-private.json'],'CANONICAL_NATIVE_ROWS_CATALOG_ROLES_CHANGED_BEFORE_FIRST_WRITE';save('native-before-private.json',baseline)
  assert not {'yumidang_completion_runner','yumidang_worker_queue'}&{r['rolname']for r in baseline['roles']['roles']},'CANONICAL_RUNNER_PRECREATION_REFUSED'
  assert query(db,'select session_user=current_user and current_user=\'supabase_admin\';').strip()==b't','CANONICAL_NATIVE_SESSION_REQUIRED'
  # 원래 파일의 BEGIN/COMMIT를 바꾸지 않는다. 각 세션의 실제 role은 DDL 전에 확인한다.
  prelude="set role postgres;do $canonical_context$begin if session_user<>'supabase_admin'or current_user<>'postgres'or(select rolsuper from pg_roles where rolname=current_user)then raise exception 'canonical_application_role_invalid'using errcode='42501';end if;end;$canonical_context$;\n"
  stage='application_reservation'
  reservation_sha=canonical_reserve(Path(CANONICAL_RESERVATION_ROOT),db,{'scope':CANONICAL_SCOPE,'nativeDbId':db,'nativeReceiptSha256':g['nativeProofs']['receipt.json'],'graphSha256':graph_sha,'revision':args.revision,'migrationCount':119,'attempt':1,'noReplayAfterUnknown':True})
  save('application-reservation.json',{'path':str(reservation),'sha256':reservation_sha,'automaticRemoval':False})
  for entry,payload in zip(entries,payloads):
   stage='migration_'+entry['version'];own();version=entry['version'];save(version+'-intent.json',{'version':version,'path':entry['path'],'sha256':entry['sha256'],'bytes':entry['bytes'],'nativeDbId':db,'sessionUser':'supabase_admin','currentUser':'postgres','attempt':1,'result':'UNCONFIRMED_UNTIL_APPLIED_RECEIPT'})
   docker('exec','-i',db,'psql','-XqAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1',data=prelude.encode()+payload)
   own();applied.append(dict(entry));save(version+'-applied.json',{'version':version,'sha256':entry['sha256'],'nativeDbId':db,'commandExit':0,'storedIn':'PRIVATE_RECEIPT_NOT_DB_HISTORY'})
  stage='canonical_final_verify';closed_app();final=helper.normalized_snapshot(db);authority=canonical_authority(baseline['roles'],final['roles']);save('native-authority-after-app.json',authority)
  owner_raw=query(db,PLATFORM_OWNER_QUERY);owner=platform_owner(platform_json(owner_raw));assert owner['roleName']=='postgres'and set(owner['ownerRoles'])=={'postgres'}and owner['ownerRoles']==platform['appOwner']['ownerRoles'],'CANONICAL_ORIGINAL_APP_OWNER_ATTRIBUTES_REQUIRED'
  save('canonical-owner-private.json',owner_raw);save('canonical-final-private.json',final)
  assert len(applied)==119 and applied==entries,'CANONICAL_ALL_119_ONCE_REQUIRED'
  # 입력 증거를 다시 읽어 mutable 파일/receipt 변경을 성공으로 숨기지 않는다.
  recheck=canonical_graph(args.graph_manifest)
  assert recheck[0]==g and recheck[1]==entries and recheck[2]==payloads and recheck[3]==proofs and recheck[4]==platform and recheck[5]==graph_sha,'CANONICAL_INPUTS_CHANGED_AFTER_APPLY'
  receipt={'status':'PASS_NATIVE_CANONICAL_119_APPLICATION_ONLY','scope':CANONICAL_SCOPE,'graphSha256':graph_sha,'prepareManifestSha256':g['prepareManifestSha256'],'closedPlanSha256':g['closedPlanSha256'],'productSourcesReferenceSha256':CANONICAL_PRODUCT_SHA,'productRuntimeExecution':'NOT_RUN','nativeReceiptSha256':g['nativeProofs']['receipt.json'],'nativeDbId':db,'applicationReservationSha256':reservation_sha,'orderedAppliedMigrations':applied,'migrationCount':119,'canonicalFinalSnapshotSha256':final_digest(final_canonical(final)),'nativeAndCanonicalSnapshotScope':'ROWS_CATALOG_ROLES_ONLY','nativeSequenceStateCompared':False,'canonicalSequenceStateCaptured':False,'canonicalOwnerCatalogSha256':final_digest(owner_raw),'nativeAuthority':authority,'source112SubsetRestore':'SEPARATE_NOT_RUN_HERE','source112AllFixturesRestored':False,'oldSource39MissingStorageBytes':'UNRESOLVED_NOT_REPAIRED','operatingDataStorageBackup':'NOT_RUN','activationAllowed':False,'providerHttpAuthStorageDeleteAck':0,'originalMutationRetries':0,'sourceStopRestartWrite':0};passed=True
 except BaseException as error:
  token=str(error)if type(error)is AssertionError else''
  save('failure-private.json',{'stage':stage,'type':type(error).__name__,'assertion':token if re.fullmatch('[A-Z][A-Z0-9_]{0,100}',token)else'FIXED_UNCLASSIFIED','provenAppliedCount':len(applied),'currentIntentMayHaveApplied':stage.startswith('migration_'),'replay':False,'frames':[{'file':Path(f.filename).name,'function':f.name,'line':f.lineno}for f in traceback.extract_tb(error.__traceback__)]})
 finally:
  same=False;stopped=False;valid=True;state=None
  try:
   after=source_whole()if before is not None else None;same=before is not None and after==before and source_closed()==source_identity
   if after is not None:save('source-after-private.json',after)
  except BaseException:same=False
  try:
   if started:stop()
   else:own()
  except BaseException:valid=False
  try:
   x=own_identity();state={'id':db,'running':x['State']['Running'],'oomKilled':x['State'].get('OOMKilled')};stopped=state['running']is False;valid=valid and state['oomKilled']is False
  except BaseException:valid=False
  save('finalization.json',{'sourceWholeUnchanged':same,'sourceStopRestartWrite':0,'nativeDbRestartIntentCount':int(started),'exactOwnedStopped':stopped,'ownedAllInvariantsVerified':valid,'finalOwnedState':state,'provenAppliedCount':len(applied),'partialOrUnknownPreserved':not passed,'originalMutationRetries':0,'backupExecution':'NOT_RUN','activationAllowed':False})
 assert passed and same and stopped and valid,'CANONICAL_APPLICATION_FAILED_CLOSED_PRESERVED'
 receipt.update({'sourceWholeUnchanged':True,'exactOwnedStopped':True,'ownedOomKilledFalse':True,'nativeDbRestartCount':1});save('receipt.json',receipt)
 print(json.dumps({'status':receipt['status'],'receiptSha256':final_digest(final_canonical(receipt)),'migrationCount':119,'sourceWholeUnchanged':True,'exactOwnedStopped':True,'activationAllowed':False,'operatingDataStorageBackup':'NOT_RUN'}))


def canonical_main(argv):
 import argparse
 from pathlib import Path
 p=argparse.ArgumentParser(description='native 실제 PASS 이후 original119 앱 SQL 적용. 기본 NOT_RUN.')
 p.add_argument('--canonical-application',action='store_true',required=True);p.add_argument('--run',action='store_true');p.add_argument('--graph-manifest',type=Path);p.add_argument('--revision');a=p.parse_args(argv)
 if not a.run:
  assert a.graph_manifest is None and a.revision is None,'CANONICAL_RUN_FLAGS_REQUIRED'
  print(json.dumps({'status':'NOT_RUN','scope':CANONICAL_SCOPE,'migrationCount':119,'nativeActualPassRequired':True,'rootGraphAndSlotRequired':True,'approvedByRoot':False,'dockerSlotReady':False,'dockerCalls':0,'appMigrationExecution':'NOT_RUN','operatingDataStorageBackup':'NOT_RUN','oldSource39MissingStorageBytes':'UNRESOLVED','activationAllowed':False}));return
 assert a.graph_manifest is not None and a.revision is not None,'CANONICAL_GRAPH_REVISION_REQUIRED'
 run_canonical_application(a)



NATIVE_BACKUP_SCOPE='CANONICAL119_SYNTHETIC_LOGICAL_DB_STORAGE_RESTORE'
NATIVE_BACKUP_CANONICAL_ROOT='/private/tmp/yumidang-canonical-application-20261010-canonical-v1'
NATIVE_BACKUP_CANONICAL_GRAPH_SHA='3189698476147687ddfc866c9858ba940e8028cf2e6f4832c3ef6fc0f172ade3'
NATIVE_BACKUP_SOURCE_ID='497e5d1bc98835d4074a2fbb7ccb37575d539984c18f571d38b6d8fbec692c2f'
NATIVE_BACKUP_CANONICAL_PROOFS={'receipt.json':'fafeb72231850417dde552c00c39bb759baa536eacc5fcfb8e2cbf8551b20d4d','finalization.json':'62faad40d8bc685875d08912783080888a5ead38ea373407a262d4a14a58802e','canonical-final-private.json':'bc3736e55f5c684c3c30d0bb1dfff3c9087495e89bf2c724db08e6bed3ee2724','native-authority-after-app.json':'d1d9071b917c0179fe0a4206396c680ba7c3f2ea57741a4899fa5c1b97963fb9','native-before-private.json':'d0bf464c2aa89e46ee3ea1f0d093948d74f369c7216271b1cc008764b0ec0f3c'}
NATIVE_BACKUP_AUDITED_STORAGE={'app/dist/http/routes/object/getObject.js':'0ddb932b88274c2e8c46f4be5e10da4413a21bbb1de50518aa32cc626768e883','app/dist/http/routes/object/updateObject.js':'16cd4b5b390d6de6b0cc1b55495c237124c83c2e350ddd88b68e4313562188d3','app/dist/storage/database/pg.js':'c7550188a096c20bf0589e96e70d8ea387cc23018af262c385ce3c706cdaf20f','app/dist/storage/renderer/asset.js':'5f0958a32745c1c18340ec4c7b0c5b8830d6d1871bf006b45aa870382d2895ba','app/dist/storage/renderer/renderer.js':'7e19425fb59cea92be9851b5d08a01b1855f0e26279967eb1e802ce951fd721f','app/dist/storage/backend/file.js':'935dcd5f8f97a211c5663238dc1fea0697ac773579936f2ba78671eb945649da'}
NATIVE_BACKUP_ACL_QUERY="""select jsonb_build_object(
'database',(select jsonb_build_array(datname,pg_get_userbyid(datdba),pg_encoding_to_char(encoding),datcollate,datctype,datlocprovider,datlocale,datcollversion,datconnlimit,datallowconn,datistemplate,(select spcname from pg_tablespace where oid=dattablespace),shobj_description(oid,'pg_database'),(select coalesce(jsonb_agg(jsonb_build_array(provider,label)order by provider),'[]')from pg_shseclabel where objoid=pg_database.oid and classoid='pg_database'::regclass),case when datacl is null then null else array(select a::text from unnest(datacl)a order by a::text)end)from pg_database where datname=current_database()),
'schemas',(select jsonb_agg(jsonb_build_array(nspname,pg_get_userbyid(nspowner),case when nspacl is null then null else array(select a::text from unnest(nspacl)a order by a::text)end)order by nspname)from pg_namespace where left(nspname,3)<>'pg_'and nspname<>'information_schema'),
'relations',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,pg_get_userbyid(c.relowner),c.relrowsecurity,c.relforcerowsecurity,case when c.relacl is null then null else array(select a::text from unnest(c.relacl)a order by a::text)end)order by n.nspname,c.relname,c.relkind)from pg_class c join pg_namespace n on n.oid=c.relnamespace where left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema'),
'columns',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,a.attname,case when a.attacl is null then null else array(select x::text from unnest(a.attacl)x order by x::text)end)order by n.nspname,c.relname,a.attnum)from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where a.attnum>0 and not a.attisdropped and left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema'),
'functions',(select jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),pg_get_userbyid(p.proowner),p.prosecdef,p.proconfig,case when p.proacl is null then null else array(select a::text from unnest(p.proacl)a order by a::text)end)order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema'),
'defaults',(select coalesce(jsonb_agg(jsonb_build_array(pg_get_userbyid(d.defaclrole),coalesce(n.nspname,''),d.defaclobjtype,array(select a::text from unnest(d.defaclacl)a order by a::text))order by pg_get_userbyid(d.defaclrole),coalesce(n.nspname,''),d.defaclobjtype),'[]')from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace),
'dbRoleSettings',(select coalesce(jsonb_agg(jsonb_build_array(coalesce(d.datname,''),case when s.setrole=0 then''else pg_get_userbyid(s.setrole)end,s.setconfig)order by coalesce(d.datname,''),case when s.setrole=0 then''else pg_get_userbyid(s.setrole)end),'[]')from pg_db_role_setting s left join pg_database d on d.oid=s.setdatabase));"""
NATIVE_BACKUP_PERMISSION_QUERY="""select coalesce(jsonb_agg(jsonb_build_array(r.rolname,x.kind,x.name,x.privilege,x.allowed)order by r.rolname,x.kind,x.name,x.privilege),'[]')from(select rolname from pg_roles union select 'public')r cross join lateral(
 select 'database'kind,current_database()name,v privilege,has_database_privilege(r.rolname,current_database(),v)allowed from unnest(array['CONNECT','CREATE','TEMPORARY','CONNECT WITH GRANT OPTION','CREATE WITH GRANT OPTION','TEMPORARY WITH GRANT OPTION'])v
 union all select 'schema',nspname,v,has_schema_privilege(r.rolname,oid,v)from pg_namespace cross join unnest(array['USAGE','CREATE','USAGE WITH GRANT OPTION','CREATE WITH GRANT OPTION'])v where left(nspname,3)<>'pg_'and nspname<>'information_schema'
 union all select 'table',format('%I.%I',n.nspname,c.relname),v,has_table_privilege(r.rolname,c.oid,v)from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN','SELECT WITH GRANT OPTION','INSERT WITH GRANT OPTION','UPDATE WITH GRANT OPTION','DELETE WITH GRANT OPTION','TRUNCATE WITH GRANT OPTION','REFERENCES WITH GRANT OPTION','TRIGGER WITH GRANT OPTION','MAINTAIN WITH GRANT OPTION'])v where c.relkind in('r','p','v','m','f')and left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema'
 union all select 'column',format('%I.%I.%I',n.nspname,c.relname,a.attname),v,has_column_privilege(r.rolname,c.oid,a.attnum,v)from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace cross join unnest(array['SELECT','INSERT','UPDATE','REFERENCES','SELECT WITH GRANT OPTION','INSERT WITH GRANT OPTION','UPDATE WITH GRANT OPTION','REFERENCES WITH GRANT OPTION'])v where a.attnum>0 and not a.attisdropped and c.relkind in('r','p','v','m','f')and left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema'
 union all select 'sequence',format('%I.%I',n.nspname,c.relname),v,has_sequence_privilege(r.rolname,c.oid,v)from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join unnest(array['USAGE','SELECT','UPDATE','USAGE WITH GRANT OPTION','SELECT WITH GRANT OPTION','UPDATE WITH GRANT OPTION'])v where c.relkind='S'and left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema'
 union all select 'function',format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),v,has_function_privilege(r.rolname,p.oid,v)from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join unnest(array['EXECUTE','EXECUTE WITH GRANT OPTION'])v where left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema')x;"""


def native_backup_archive(raw):
 """전체 volume의 bounded tar를 검증한다. 파일 xattr는 별도 exact inventory다."""
 import io,tarfile
 from pathlib import PurePosixPath
 assert isinstance(raw,bytes)and len(raw)<=16*1024**2,'NATIVE_BACKUP_ARCHIVE_LIMIT'
 seen=set();kinds={};regular={};total=0
 with tarfile.open(fileobj=io.BytesIO(raw),mode='r:')as archive:
  for member in archive:
   assert len(seen)<512 and type(member.size)is int and 0<=member.size<=1024**2,'NATIVE_BACKUP_MEMBER_LIMIT'
   path=PurePosixPath(member.name);key=str(path)
   assert re.fullmatch('[A-Za-z0-9._/-]{1,512}',member.name)and '\\'not in member.name and not path.is_absolute()and '..'not in path.parts and key not in seen,'NATIVE_BACKUP_ARCHIVE_PATH_REQUIRED'
   assert(member.isfile()or member.isdir())and not(member.isfile()and key=='.'),'NATIVE_BACKUP_LINK_OR_TYPE_REFUSED';seen.add(key);kinds[key]='file'if member.isfile()else'directory'
   assert all(kinds.get(str(parent))!='file'for parent in path.parents)and not(member.isfile()and any(key+'/'==old[:len(key)+1]for old in seen if old!=key)),'NATIVE_BACKUP_FILE_ANCESTOR_REFUSED'
   assert not member.pax_headers and not(member.mode&0o7000)and member.uid>=0 and member.gid>=0,'NATIVE_BACKUP_ARCHIVE_METADATA_REFUSED'
   if member.isdir():assert member.size==0,'NATIVE_BACKUP_DIRECTORY_SIZE';continue
   total+=member.size;assert total<=4*1024**2,'NATIVE_BACKUP_TOTAL_FILE_LIMIT'
   stream=archive.extractfile(member);data=stream.read(member.size+1);assert len(data)==member.size,'NATIVE_BACKUP_SHORT_FILE'
   regular[key]={'sha256':final_digest(data),'bytes':len(data),'mode':member.mode,'uid':member.uid,'gid':member.gid}
 return regular


def native_backup_inventory(value):
 """tar 밖의 link count와 모든 xattr도 숨기지 않는다."""
 from pathlib import PurePosixPath
 assert isinstance(value,dict)and len(value)<=256,'NATIVE_BACKUP_FILE_INVENTORY_LIMIT'
 result={};total=0
 for name,item in value.items():
  p=PurePosixPath(name);assert re.fullmatch('[A-Za-z0-9._/-]{1,512}',name)and '\\'not in name and not p.is_absolute()and '..'not in p.parts and str(p)==name and name!='.','NATIVE_BACKUP_FILE_PATH_REQUIRED'
  assert isinstance(item,dict)and set(item)=={'sha256','bytes','mode','uid','gid','nlink','xattrs'},'NATIVE_BACKUP_FILE_METADATA_REQUIRED'
  assert re.fullmatch('[a-f0-9]{64}',item['sha256'])and all(type(item[k])is int and item[k]>=0 for k in('bytes','mode','uid','gid','nlink'))and item['nlink']==1 and item['bytes']<=1024**2 and item['mode']<=0o777,'NATIVE_BACKUP_FILE_LINK_MODE_SIZE_REQUIRED'
  attrs=item['xattrs'];assert isinstance(attrs,dict)and len(attrs)<=32,'NATIVE_BACKUP_XATTR_COUNT_LIMIT'
  for key,text in attrs.items():
   assert re.fullmatch('[A-Za-z0-9_.-]{1,128}',key)and isinstance(text,str)and len(text)<=8192,'NATIVE_BACKUP_XATTR_LIMIT'
   import base64
   data=base64.b64decode(text,validate=True);assert len(data)<=4096 and base64.b64encode(data).decode()==text,'NATIVE_BACKUP_XATTR_CANONICAL_REQUIRED'
  total+=item['bytes'];assert total<=4*1024**2,'NATIVE_BACKUP_FILE_TOTAL_LIMIT';result[name]=item
 return result


def native_backup_graph(path):
 """현재 canonical 증거·역할·실행 승인은 독립된 exact 입력이다."""
 import ast
 from pathlib import Path
 def read(p,limit=16*1024**2):
  with platform_open(Path(p))as f:raw=f.read(limit+1)
  assert len(raw)<=limit,'NATIVE_BACKUP_INPUT_LIMIT';return platform_json(raw),final_digest(raw)
 g,sha=read(path,1024**2);keys={'version','kind','approvedByRoot','dockerSlotReady','repo','files','canonicalGraph','canonicalGraphSha256','canonicalRoot','canonicalProofs','sourceIdentity','protectedSourceId','protectedSourceWholeSha256','platformManifest','platformManifestSha256','sourceStorageEnv','sourceStorageEnvSha256','sourceCaCert','sourceCaCertSha256','closedPlan','closedPlanSha256'}
 assert isinstance(g,dict)and set(g)==keys and type(g['version'])is int and g['version']==1 and g['kind']==NATIVE_BACKUP_SCOPE,'NATIVE_BACKUP_EXACT_GRAPH_REQUIRED'
 assert g['approvedByRoot']is True and g['dockerSlotReady']is True,'NATIVE_BACKUP_ROOT_AND_SLOT_REQUIRED'
 repo=Path(g['repo']);assert repo.is_absolute()and repo.resolve()==repo,'NATIVE_BACKUP_REPO_REQUIRED'
 required={'tests/integration/minkyu/product_connection_restore108_local.py',*FINAL_FIXED,*CANONICAL_PREPARATION};assert set(g['files'])==required,'NATIVE_BACKUP_EXACT_DEPENDENCIES'
 for name,digest in g['files'].items():assert re.fullmatch('[a-f0-9]{64}',digest)and final_digest(final_regular(repo/name))==digest,'NATIVE_BACKUP_DEPENDENCY_CHANGED'
 for name,digest in{**FINAL_FIXED,**CANONICAL_PREPARATION}.items():assert g['files'][name]==digest,'NATIVE_BACKUP_FIXED_DEPENDENCY_CHANGED'
 assert g['files']['tests/integration/minkyu/product_connection_restore108_local.py']==final_digest(Path(__file__).read_bytes()),'NATIVE_BACKUP_EXECUTING_DRIVER_CHANGED'
 cg,cgsha=read(g['canonicalGraph']);assert cgsha==g['canonicalGraphSha256']==NATIVE_BACKUP_CANONICAL_GRAPH_SHA and cg['repo']==str(repo)and cg['approvedByRoot']is True and cg['dockerSlotReady']is True,'NATIVE_BACKUP_CANONICAL_GRAPH_CHANGED'
 assert str(Path(g['canonicalRoot']))==NATIVE_BACKUP_CANONICAL_ROOT and g['canonicalProofs']==NATIVE_BACKUP_CANONICAL_PROOFS,'NATIVE_BACKUP_EXACT_CANONICAL_PROOFS'
 proofs={}
 for name,digest in NATIVE_BACKUP_CANONICAL_PROOFS.items():v,s=read(Path(g['canonicalRoot'])/name);assert s==digest,'NATIVE_BACKUP_CANONICAL_PROOF_CHANGED';proofs[name]=v
 receipt=proofs['receipt.json'];final=proofs['finalization.json'];baseline=proofs['canonical-final-private.json'];identity=g['sourceIdentity']
 assert receipt['status']=='PASS_NATIVE_CANONICAL_119_APPLICATION_ONLY'and receipt['migrationCount']==119 and receipt['graphSha256']==cgsha and receipt['activationAllowed']is False and receipt['sourceWholeUnchanged']is True,'NATIVE_BACKUP_ACTUAL_CANONICAL_REQUIRED'
 assert final['exactOwnedStopped']is True and final['ownedAllInvariantsVerified']is True and final['finalOwnedState']=={'id':NATIVE_BACKUP_SOURCE_ID,'running':False,'oomKilled':False}and len(baseline['rows'])==178,'NATIVE_BACKUP_STOPPED_178_SOURCE_REQUIRED'
 assert identity==cg['nativeStoppedIdentity']and identity['id']==NATIVE_BACKUP_SOURCE_ID,'NATIVE_BACKUP_EXACT_SOURCE_IDENTITY'
 assert g['protectedSourceId']==cg['sourceId']and g['protectedSourceWholeSha256']==cg['sourceWholeSha256'],'NATIVE_BACKUP_PROTECTED_SOURCE_BINDING'
 assert g['platformManifestSha256']==NATIVE_MANIFEST_SHA,'NATIVE_BACKUP_PLATFORM_DIGEST'
 platform,psha=read(g['platformManifest']);assert psha==NATIVE_MANIFEST_SHA,'NATIVE_BACKUP_PLATFORM_CHANGED'
 for name,digest in NATIVE_BACKUP_AUDITED_STORAGE.items():assert platform['images']['storage']['files'][name]['sha256']==digest,'NATIVE_BACKUP_AUDITED_STORAGE_BYTES_REQUIRED'
 for key,filename in(('sourceStorageEnv','storage.env'),('sourceCaCert','ca.crt')):
  assert g[key]==str(Path(CANONICAL_NATIVE_ROOT)/filename),'NATIVE_BACKUP_FIXED_PRIVATE_NATIVE_INPUT'
  raw=final_regular(Path(g[key]),private=True);assert len(raw)<=65536 and final_digest(raw)==g[key+'Sha256'],'NATIVE_BACKUP_PRIVATE_NATIVE_INPUT_CHANGED'
 env={}
 for line in final_regular(Path(g['sourceStorageEnv']),private=True).decode().splitlines():
  assert '='in line and '\0'not in line and '\r'not in line,'NATIVE_BACKUP_SINGLE_LINE_ENV_REQUIRED';key,value=line.split('=',1);assert re.fullmatch('[A-Z][A-Z0-9_]*',key)and key not in env,'NATIVE_BACKUP_ENV_KEY_REQUIRED';env[key]=value
 from urllib.parse import urlsplit,parse_qs
 url=urlsplit(env['DATABASE_URL']);params=parse_qs(url.query)
 assert url.scheme=='postgresql'and url.username=='supabase_storage_admin'and url.hostname=='mplatform-pg'and url.path=='/postgres'and params=={'sslmode':['verify-full'],'sslrootcert':['/tmp/native-ca.crt']}and env['DB_INSTALL_ROLES']=='false'and env['DB_ALLOW_MIGRATION_REFRESH']=='false'and env['PG_QUEUE_ENABLE']=='false','NATIVE_BACKUP_NATIVE_MINIMAL_TLS_ENV'
 plan,plan_sha=read(g['closedPlan']);assert plan_sha==g['closedPlanSha256']==CANONICAL_CLOSED_PLAN_SHA and plan['productSources']['sha256']==CANONICAL_PRODUCT_SHA and plan['activationAllowed']is False,'NATIVE_BACKUP_CURRENT_CLOSED_REFERENCE'
 product=plan['productSources'];assert product['deploymentVerified']is False and product['mode']=='working_tree_snapshot','NATIVE_BACKUP_PRODUCT_REFERENCE_REQUIRED'
 inventory=product['files'];assert isinstance(inventory,list)and len(inventory)==162 and final_digest(final_canonical(inventory))==CANONICAL_PRODUCT_SHA,'NATIVE_BACKUP_CURRENT_PRODUCT_INVENTORY_REQUIRED'
 names=[]
 for item in inventory:
  assert isinstance(item,dict)and set(item)=={'path','sha256','bytes'},'NATIVE_BACKUP_PRODUCT_METADATA_REQUIRED'
  name=item['path'];assert isinstance(name,str)and (name in('backend/package.json','backend/package-lock.json','backend/supabase/config.toml')or re.fullmatch(r'backend/supabase/functions/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\.(?:ts|mjs|json)',name))and name not in names,'NATIVE_BACKUP_PRODUCT_PATH_REQUIRED';names.append(name)
  assert type(item['bytes'])is int and 0<item['bytes']<=2*1024**2 and re.fullmatch('[a-f0-9]{64}',item['sha256']),'NATIVE_BACKUP_PRODUCT_SIZE_SHA_REQUIRED'
  raw=final_regular(repo/name);assert len(raw)==item['bytes']and final_digest(raw)==item['sha256'],'NATIVE_BACKUP_CURRENT_PRODUCT_BYTES_CHANGED'
 assert names==sorted(names),'NATIVE_BACKUP_PRODUCT_ORDER_REQUIRED'
 reviewed={}
 for name,key in(('tools/local/prepare_edge.py','GATEWAY_REVIEWED_MIGRATIONS'),('tools/local/prepare_current_policy.py','CURRENT_POLICY_REVIEWED')):
  nodes=[n.value for n in ast.parse(final_regular(repo/name)).body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id==key for t in n.targets)];assert len(nodes)==1,'NATIVE_BACKUP_LITERAL_REGISTRY';mapping=ast.literal_eval(nodes[0]);assert not set(reviewed)&set(mapping),'NATIVE_BACKUP_REGISTRY_DUPLICATE';reviewed.update(mapping)
 assert len(reviewed)==119 and final_digest(final_canonical(reviewed))==plan['migrationManifestSha256'],'NATIVE_BACKUP_ALL119_REFERENCE'
 assert all(final_digest(final_regular(repo/name))==digest for name,digest in reviewed.items()),'NATIVE_BACKUP_ORIGINAL119_CHANGED'
 return g,sha,proofs,platform,env


def native_backup_database_archive(toc,state):
 """native archive의 원 DB owner/ACL/settings 항목을 대상 쓰기 전에 확인한다."""
 assert isinstance(toc,bytes)and len(toc)<=4*1024**2,'NATIVE_BACKUP_TOC_LIMIT'
 database=state['rawAuthority']['database'];roles={r['rolname']for r in state['snapshot']['roles']['roles']};owner=database[1]
 assert database[0]=='postgres'and owner in roles,'NATIVE_BACKUP_ORIGINAL_DATABASE_OWNER_REQUIRED'
 entries={'database':[],'acl':[],'settings':[],'comment':[],'securityLabel':[]};seen=set()
 for line in toc.decode().splitlines():
  if not line.strip()or line.startswith(';'):continue
  m=re.fullmatch(r'([1-9][0-9]*); ([0-9]+) ([0-9]+) (.+)',line);assert m is not None,'NATIVE_BACKUP_NATIVE_TOC_FORMAT'
  number=int(m[1]);assert number not in seen,'NATIVE_BACKUP_TOC_DUPLICATE';seen.add(number);tail=m[4]
  kinds=[('DATABASE PROPERTIES - postgres ', 'settings'),('DATABASE - postgres ','database'),('ACL - DATABASE postgres ','acl'),('COMMENT - DATABASE postgres ','comment'),('SECURITY LABEL - DATABASE postgres ','securityLabel')]
  for prefix,key in kinds:
   if tail.startswith(prefix):
    assert tail[len(prefix):]in(owner,'','-')if key=='settings'else tail[len(prefix):]==owner,'NATIVE_BACKUP_TOC_DATABASE_OWNER_MISMATCH';entries[key].append(number);break
  else:assert not tail.startswith(('DATABASE ','ACL - DATABASE ','COMMENT - DATABASE ','SECURITY LABEL - DATABASE ')),'NATIVE_BACKUP_TOC_OTHER_DATABASE_REFUSED'
 assert len(entries['database'])==1,'NATIVE_BACKUP_EXACT_DATABASE_ARCHIVE_ENTRY'
 if database[-1]is not None:assert entries['acl'],'NATIVE_BACKUP_DATABASE_ACL_ARCHIVE_REQUIRED'
 if any(r[0]=='postgres'for r in state['rawAuthority']['dbRoleSettings']):assert entries['settings'],'NATIVE_BACKUP_DATABASE_SETTINGS_ARCHIVE_REQUIRED'
 if database[-3]is not None:assert entries['comment'],'NATIVE_BACKUP_DATABASE_COMMENT_ARCHIVE_REQUIRED'
 if database[-2]:assert entries['securityLabel'],'NATIVE_BACKUP_DATABASE_SECURITY_LABEL_ARCHIVE_REQUIRED'
 return {'database':'postgres','owner':owner,'tocEntries':entries,'tocSha256':final_digest(toc),'sourceAuthoritySha256':final_digest(final_canonical(state['rawAuthority'])),'metadataOrigin':'ORIGINAL_PG_DUMP_ARCHIVE','noSyntheticDatabaseMetadata':True}


def native_backup_state(query,helper,name):
 from pathlib import PurePosixPath
 value={'snapshot':helper.normalized_snapshot(name),'rawAuthority':platform_json(query(name,NATIVE_BACKUP_ACL_QUERY)),'effectivePrivileges':platform_json(query(name,NATIVE_BACKUP_PERMISSION_QUERY)),'sequences':{}}
 seq=platform_json(query(name,"select coalesce(json_agg(json_build_array(n.nspname,c.relname)order by n.nspname,c.relname),'[]')from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S'and left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema';"))
 for schema,table in seq:
  relation='"'+schema.replace('"','""')+'"."'+table.replace('"','""')+'"';value['sequences'][schema+'.'+table]=platform_json(query(name,'select json_build_array(last_value,is_called)from '+relation+';'))
 return value


def native_backup_reserve(source_id,phase,record):
 from pathlib import Path
 assert source_id==NATIVE_BACKUP_SOURCE_ID and phase in('source','target','known_delete','known_reapply'),'NATIVE_BACKUP_PHASE_REQUIRED'
 key=final_digest((NATIVE_BACKUP_SCOPE+':'+source_id+':'+phase).encode())
 return canonical_reserve(Path(CANONICAL_RESERVATION_ROOT),key,{**record,'scope':NATIVE_BACKUP_SCOPE,'sourceId':source_id,'phase':phase,'automaticRemoval':False,'noReplay':True})


def run_native_final_backup(args):
 """한 DB+Storage씩 직렬 검증한다. 운영 백업·실제 UNKNOWN 삭제라고 확대하지 않는다."""
 import base64,hmac,importlib.util,ipaddress,os,secrets,sys,traceback
 from pathlib import Path,PurePosixPath
 os.umask(0o077);g,gsha,proofs,platform,env=native_backup_graph(args.graph_manifest)
 assert re.fullmatch('native-final-v[1-9][0-9]{0,5}',args.revision),'NATIVE_BACKUP_FRESH_REVISION'
 root=Path('/private/tmp/yumidang-native-final-backup-20261010-'+args.revision);assert not root.exists()and not root.is_symlink(),'NATIVE_BACKUP_OLD_UNKNOWN_PRESERVED';root.mkdir(mode=0o700)
 source=g['sourceIdentity']['id'];protected=g['protectedSourceId'];rid=str(uuid.uuid4());prefix='yumidang-minkyu-'+args.revision;owned={};source_started=False;stage='protected_before';before=None;protected_identity=None;passed=False;restored=None;known=None;source_final=None;receipt=None;headers={};pending={}
 def save(name,value):
  assert re.fullmatch('[A-Za-z0-9.-]+',name),'NATIVE_BACKUP_ARTIFACT_NAME';raw=value if isinstance(value,bytes)else final_canonical(value)
  with os.fdopen(os.open(root/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
  for directory in(root,root.parent):
   fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
   try:os.fsync(fd)
   finally:os.close(fd)
 def call(argv,data=None,timeout=180):
  r=subprocess.run(argv,input=data,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=timeout);assert r.returncode==0 and len(r.stdout)<=64*1024**2,'NATIVE_BACKUP_COMMAND_FAILED_NO_RETRY';return r.stdout
 def docker(*argv,data=None):return call(t.DOCKER+list(argv),data)
 def inspect(id):
  x=platform_json(docker('inspect',id));assert len(x)==1,'NATIVE_BACKUP_ONE_INSPECT';return x[0]
 def source_own():
  x=inspect(source);target=g['sourceIdentity'];c=x['Config'];h=x['HostConfig'];l=c['Labels'];assert x['Id']==source and x['Name']=='/'+target['name']and c['Image']==target['imageId']and l.get('yumidang.owner')=='minkyu'and l.get('yumidang.run_id')==target['runId']and l.get('yumidang.scope')==NATIVE_SCOPE,'NATIVE_BACKUP_SOURCE_IDENTITY';return x
 def source_caps():
  x=source_own();c=x['Config'];h=x['HostConfig'];assert x['State']['OOMKilled']is False and final_digest(final_canonical(c))==g['sourceIdentity']['configSha256']and final_digest(final_canonical(h))==g['sourceIdentity']['hostConfigSha256']and final_digest(final_canonical(x['Mounts']))==g['sourceIdentity']['mountsSha256'],'NATIVE_BACKUP_SOURCE_CONFIG_CHANGED'
  assert h['Memory']==h['MemorySwap']==512*1024**2 and h['NanoCpus']==500000000 and h['PidsLimit']==128 and not x['Mounts']and not h['PortBindings']and h['LogConfig']['Type']=='none'and c['Healthcheck']['Test']==['NONE'],'NATIVE_BACKUP_SOURCE_CAPS';assert [v['NetworkID']for v in x['NetworkSettings']['Networks'].values()]==[g['sourceIdentity']['networkId']],'NATIVE_BACKUP_SOURCE_NETWORK';return x
 def own(id):
  x=inspect(id);l=x['Config']['Labels'];assert id in owned and x['Id']==id and x['Name']=='/'+owned[id]['name']and x['Config']['Image']==owned[id]['image']and l.get('yumidang.owner')=='minkyu'and l.get('yumidang.scope')==NATIVE_BACKUP_SCOPE and l.get('yumidang.run_id')==rid,'NATIVE_BACKUP_EXACT_OWN_ID';return x
 def caps(id):
  x=own(id);h=x['HostConfig'];expected=owned[id];assert x['State']['OOMKilled']is False and h['Memory']==h['MemorySwap']==expected['memory']*1024**2 and h['NanoCpus']==500000000 and h['PidsLimit']==128 and not h['PortBindings']and h['LogConfig']['Type']=='none'and x['Config']['Healthcheck']['Test']==['NONE'],'NATIVE_BACKUP_OWN_CAPS'
  assert h['Privileged']is False and not h.get('CapAdd')and not h.get('PublishAllPorts')and not h.get('Devices')and h['ReadonlyRootfs']is False,'NATIVE_BACKUP_EXTRA_PRIVILEGE_REFUSED'
  assert final_digest(final_canonical(x['Config']))==expected['config']and final_digest(final_canonical(h))==expected['host']and final_digest(final_canonical(x['Mounts']))==expected['mounts'],'NATIVE_BACKUP_OWN_CONFIG_MOUNTS_CHANGED'
  assert set(x['NetworkSettings']['Networks'])==set(expected['networks']),'NATIVE_BACKUP_OWN_NETWORK_CHANGED'
  for name,network_id in expected['networks'].items():
   actual=x['NetworkSettings']['Networks'][name]['NetworkID'];never=x['State']['Status']=='created'and x['State']['StartedAt']=='0001-01-01T00:00:00Z'and x['State']['FinishedAt']=='0001-01-01T00:00:00Z'and x['State']['Pid']==0 and x['State']['ExitCode']==0
   assert actual==network_id or(never and actual==''and h['NetworkMode']==name),'NATIVE_BACKUP_OWN_NETWORK_ID_REQUIRED'
   if name!='none':
    ni=platform_json(docker('network','inspect',network_id));assert len(ni)==1 and ni[0]['Id']==network_id and ni[0]['Name']==name and ni[0]['Internal']is True,'NATIVE_BACKUP_OWN_INTERNAL_NETWORK_REQUIRED'
    labels_expected={'yumidang.owner':'minkyu','yumidang.scope':NATIVE_SCOPE if network_id==g['sourceIdentity']['networkId']else NATIVE_BACKUP_SCOPE,'yumidang.run_id':g['sourceIdentity']['runId']if network_id==g['sourceIdentity']['networkId']else rid};assert all(ni[0]['Labels'].get(k)==v for k,v in labels_expected.items()),'NATIVE_BACKUP_NETWORK_LABEL_REQUIRED'
  return x
 def bind_config(id,network):
  x=own(id);h=x['HostConfig'];expected=owned[id];declared=expected['declaredMounts'];assert len(x['Mounts'])==len(declared),'NATIVE_BACKUP_EXACT_MOUNT_COUNT'
  for spec in declared:
   fields=dict(v.split('=',1)for v in spec.split(',')if '='in v);mount=next((m for m in x['Mounts']if m['Destination']==fields['dst']),None);assert mount is not None and mount['Type']==fields['type']and mount['RW']==('readonly'not in spec.split(','))and(mount.get('Name')==fields['src']if fields['type']=='volume'else mount['Source']==fields['src']),'NATIVE_BACKUP_DECLARED_MOUNT_REQUIRED'
  if expected['argv']is not None:assert x['Config']['Cmd']==expected['argv'],'NATIVE_BACKUP_DECLARED_COMMAND_REQUIRED'
  if expected['entrypoint']is not None:assert x['Config']['Entrypoint']==[expected['entrypoint']],'NATIVE_BACKUP_DECLARED_ENTRYPOINT_REQUIRED'
  if expected['user']is not None:assert x['Config']['User']==expected['user'],'NATIVE_BACKUP_DECLARED_USER_REQUIRED'
  assert h['NetworkMode']==network,'NATIVE_BACKUP_DECLARED_NETWORK_REQUIRED'
  ni=platform_json(docker('network','inspect',network));assert len(ni)==1 and ni[0]['Name']==network and(network=='none'or ni[0]['Internal']is True),'NATIVE_BACKUP_BIND_NETWORK'
  owned[id].update({'config':final_digest(final_canonical(x['Config'])),'host':final_digest(final_canonical(h)),'mounts':final_digest(final_canonical(x['Mounts'])),'networks':{network:ni[0]['Id']}})
 def stop(id):
  x=source_own()if id==source else own(id);invalid=False
  try:source_caps()if id==source else caps(id)
  except BaseException:invalid=True
  if x['State']['Running']:docker('stop','--time','15',id)
  state=(source_own()if id==source else own(id))['State'];assert state['Running']is False and state['OOMKilled']is False,'NATIVE_BACKUP_EXACT_STOP';assert not invalid,'NATIVE_BACKUP_INVALID_CONFIG_STOPPED_FAILURE'
 def query(id,statement,write=False):
  assert id in(source,protected,*owned),'NATIVE_BACKUP_QUERY_SCOPE'
  assert not write or id!=protected,'NATIVE_BACKUP_PROTECTED_WRITE_REFUSED'
  if write:assert id==source or owned[id]['kind']=='db','NATIVE_BACKUP_DB_WRITE_ONLY';sql=statement
  else:sql="begin read only;set local statement_timeout='30s';"+statement+'commit;'
  return docker('exec','-i',id,'psql','-XqAt','-h','/var/run/postgresql','-U',BOOT if id==protected else'supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1',data=sql.encode())
 repo=Path(g['repo']);sys.path.insert(0,str(repo/'tests/integration/minkyu'));spec=importlib.util.spec_from_file_location('native_final_fixed_helper',repo/'tests/integration/minkyu/member_cleanup_reconcile_local.py');helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
 helper.query=query
 def helper_call(argv,data=None):
  for id in(source,protected,*owned):
   if list(argv)==t.DOCKER+['exec',id,'pg_dump','-U',BOOT,'-d','postgres','--schema-only']:
    assert data is None,'NATIVE_BACKUP_SCHEMA_STDIN';return docker('exec',id,'pg_dump','-h','/var/run/postgresql','-U',BOOT if id==protected else'supabase_admin','-d','postgres','--schema-only')
  raise AssertionError('NATIVE_BACKUP_HELPER_SCOPE')
 helper.call=helper_call
 def closed(id):
  assert_closed(lambda sql:query(id,sql));assert query(id,'show cron.launch_active_jobs;').strip()==b'off','NATIVE_BACKUP_CRON_CLOSED'
  for table in('worker_invocation_control','worker_intent_confirmation_control','event_collection_control','content_inspection_control','member_retirement_receipt_control','worker_runtime_journal_control'):
   if query(id,"select to_regclass('private."+table+"');").strip():assert query(id,'select not enabled from private.'+table+' where singleton;').strip()==b't','NATIVE_BACKUP_CONTROL_OPEN'
  assert query(id,"select count(*)from pg_stat_activity where datname=current_database()and backend_type='client backend'and state='active'and pid<>pg_backend_pid();").strip()==b'0','NATIVE_BACKUP_ACTIVE_CLIENT'
 def protected_whole():
  x=inspect(protected);assert x['Id']==protected and x['Name']=='/'+FINAL_SOURCE and x['State']['Running']and x['Config']['Labels'].get('yumidang.owner')=='minkyu','NATIVE_BACKUP_PROTECTED_ID'
  closed(protected);v=native_backup_state(query,helper,protected);identity={'config':final_digest(final_canonical(x['Config'])),'host':final_digest(final_canonical(x['HostConfig'])),'mounts':final_digest(final_canonical(x['Mounts'])),'startedAt':x['State']['StartedAt'],'restartCount':x['RestartCount']};return v,identity
 def memory(phase):
  raw=docker('exec',protected,'cat','/proc/meminfo').decode();found=re.findall(r'^MemAvailable:\s+([0-9]+) kB$',raw,re.M);assert len(found)==1,'NATIVE_BACKUP_MEMORY_REQUIRED';amount=int(found[0]);save('memory-'+phase+'.json',{'availableKiB':amount,'minimumMiB':1024,'dbMiB':512,'storageMiB':512,'maxActiveTestDbs':1});assert amount>=1024*1024,'NATIVE_BACKUP_MEMORY_LOW_START0'
 def labels():return ['--label','yumidang.owner=minkyu','--label','yumidang.scope='+NATIVE_BACKUP_SCOPE,'--label','yumidang.run_id='+rid]
 def create(kind,image,argv,*,network='none',mounts=(),memory_mib=512,entrypoint=None,user=None,stdin=False,alias=None):
  memory(kind+'-before-create');name=prefix+'-'+kind;assert not docker('ps','-aq','--filter','name=^/'+name+'$').strip(),'NATIVE_BACKUP_OLD_CONTAINER'
  save('create-'+kind+'-intent.json',{'name':name,'imageId':image,'kind':kind,'runId':rid});cmd=['create','--pull=never','--no-healthcheck','--memory',str(memory_mib)+'m','--memory-swap',str(memory_mib)+'m','--cpus','0.5','--pids-limit','128','--log-driver','none','--network',network,'--name',name,*labels()]
  if alias:assert alias=='mplatform-target';cmd+=['--network-alias',alias]
  if entrypoint:cmd+=['--entrypoint',entrypoint]
  if user:assert user=='postgres';cmd+=['--user',user]
  if stdin:cmd+=['-i']
  for mount in mounts:cmd+=['--mount',mount]
  pending[name]={'kind':'db'if kind=='target-db'else kind,'name':name,'image':image,'memory':memory_mib,'declaredMounts':list(mounts),'argv':argv,'entrypoint':entrypoint,'user':user,'network':network};id=docker(*cmd,image,*argv)
  id=id.decode().strip();assert re.fullmatch('[a-f0-9]{64}',id)and id not in(source,protected,*owned),'NATIVE_BACKUP_CREATED_ID';owned[id]=dict(pending[name]);bind_config(id,network);caps(id);return id
 def start(id):memory(owned[id]['kind']+'-start');caps(id);save('start-'+owned[id]['kind']+'-intent.json',{'id':id,'runId':rid});docker('start',id);caps(id)
 def attached(id,data=None):
  kind=owned[id]['kind'];memory(kind+'-before-attached-start');caps(id);save('start-'+kind+'-intent.json',{'id':id,'runId':rid,'attached':True,'firstAttemptOnly':True});raw=docker('start','-ai'if data is not None else'-a',id,data=data);caps(id);assert own(id)['State']['ExitCode']==0,'NATIVE_BACKUP_ATTACHED_EXIT_FAILED';return raw
 def wait_db(id):
  for _ in range(120):
   x=source_caps()if id==source else caps(id);assert x['State']['Running'],'NATIVE_BACKUP_DB_EXITED'
   r=subprocess.run(t.DOCKER+['exec','--user','postgres',id,'pg_isready','-h','/var/run/postgresql','-U','supabase_admin','-d','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
   if r.returncode==0:return
   time.sleep(.5)
  raise AssertionError('NATIVE_BACKUP_DB_NOT_READY')
 def server_proof(id,source_scope):
  link=docker('exec','--user','postgres',id,'readlink','/proc/1/exe');binary=docker('exec','--user','postgres',id,'sha256sum','/proc/1/exe')
  assert link.strip()==NATIVE_POSTGRES_EXE_PATH.encode()and binary.split()==[NATIVE_POSTGRES_EXE_SHA.encode(),b'/proc/1/exe'],'NATIVE_BACKUP_EXACT_PID1_EXECUTABLE_REQUIRED'
  v=platform_json(query(id,"select json_build_object('postmasterPid',split_part(pg_read_file('postmaster.pid',0,2048),E'\\n',1)::integer,'pidStartedEpoch',split_part(pg_read_file('postmaster.pid',0,2048),E'\\n',3)::bigint,'serverStartedEpoch',floor(extract(epoch from pg_postmaster_start_time()))::bigint,'configFile',current_setting('config_file'),'dataDirectory',current_setting('data_directory'),'listenAddresses',current_setting('listen_addresses'),'cronClosed',current_setting('cron.launch_active_jobs')='off','sslEnabled',current_setting('ssl')='on','nativeCatalogReady',to_regclass('auth.users')is not null and exists(select 1 from pg_roles where rolname='supabase_storage_admin')and exists(select 1 from pg_roles where rolname='postgres'and not rolsuper));"))
  if source_scope:assert native_final_server(v),'NATIVE_BACKUP_SOURCE_FINAL_SERVER_REQUIRED'
  else:assert v['postmasterPid']==1 and type(v['pidStartedEpoch'])is int and v['pidStartedEpoch']>0 and abs(v['pidStartedEpoch']-v['serverStartedEpoch'])<=1 and v['configFile']=='/etc/postgresql/postgresql.conf'and v['dataDirectory']=='/tmp/native-final-data'and v['listenAddresses']=='*'and v['cronClosed']is True and v['nativeCatalogReady']is True,'NATIVE_BACKUP_TARGET_FINAL_SERVER_REQUIRED'
  return {'cachedExeProofSha256':NATIVE_POSTGRES_PROOF_SHA,'executableSha256':NATIVE_POSTGRES_EXE_SHA,'server':v}
 def volume(kind):
  name=prefix+'-'+kind+'-files';assert not docker('volume','ls','-q','--filter','name=^'+name+'$').strip(),'NATIVE_BACKUP_OLD_VOLUME';save('volume-'+kind+'-intent.json',{'name':name,'runId':rid});docker('volume','create',*labels(),name);x=platform_json(docker('volume','inspect',name));assert len(x)==1 and all(x[0]['Labels'].get(k)==v for k,v in{'yumidang.owner':'minkyu','yumidang.scope':NATIVE_BACKUP_SCOPE,'yumidang.run_id':rid}.items()),'NATIVE_BACKUP_VOLUME_IDENTITY';return name
 # Cached backend uses fs-xattr for content-type/cache-control; capture all attributes, not just bytes.
 inventory_js="""const fs=require('node:fs/promises'),p=require('node:path'),c=require('node:crypto'),x=require('fs-xattr');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',async()=>{try{const v=JSON.parse(s),out={};let count=0,total=0;const walk=async d=>{for(const n of(await fs.readdir(d)).sort()){if(++count>512)throw 0;const f=p.join(d,n),st=await fs.lstat(f);if(st.isDirectory()){await walk(f);continue}if(!st.isFile()||st.nlink!==1||st.size>1048576||(total+=st.size)>4194304)throw 0;const key=p.relative('/mnt',f);if(!/^[A-Za-z0-9._/-]+$/.test(key)||key.split('/').includes('..')||Object.keys(out).length>=256)throw 0;const bytes=await fs.readFile(f),attrs={};const names=await x.listAttributes(f);if(names.length>32)throw 0;for(const a of names.sort()){if(!/^[A-Za-z0-9_.-]{1,128}$/.test(a))throw 0;const b=await x.getAttribute(f,a);if(b.length>4096)throw 0;attrs[a]=b.toString('base64')}if(v.restore){const expected=v.restore[key];if(!expected||expected.sha256!==c.createHash('sha256').update(bytes).digest('hex'))throw 0;for(const[a,b]of Object.entries(expected.xattrs))await x.setAttribute(f,a,Buffer.from(b,'base64'));for(const a of names)if(!(a in expected.xattrs))throw 0;for(const a of Object.keys(expected.xattrs))attrs[a]=(await x.getAttribute(f,a)).toString('base64')}out[key]={sha256:c.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,mode:st.mode&4095,uid:st.uid,gid:st.gid,nlink:st.nlink,xattrs:attrs}}};await walk('/mnt');if(v.restore&&Object.keys(v.restore).length!==Object.keys(out).length)throw 0;process.stdout.write(JSON.stringify(out))}catch{process.exit(1)}});"""
 def inventory(id):caps(id);return native_backup_inventory(platform_json(docker('exec','-i',id,'node','-e',inventory_js,data=b'{}')))
 def request(id,method,path,jwt,data=None):
  caps(id);script="""const c=require('node:crypto');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',async()=>{try{const v=JSON.parse(s),r=await fetch('http://127.0.0.1:5000'+v.path,{method:v.method,headers:{authorization:'Bearer '+v.jwt,'content-type':'image/png','cache-control':'no-cache'},...(v.data?{body:Buffer.from(v.data,'base64')}:{}) ,redirect:'error',signal:AbortSignal.timeout(10000)});const b=Buffer.from(await r.arrayBuffer());if(b.length>1048576)throw 0;let missing=r.status===404;try{const j=JSON.parse(b);missing=missing||(r.status===400&&String(j.statusCode)==='404'&&['not_found','Bucket not found'].includes(j.error))}catch{}process.stdout.write(JSON.stringify({status:r.status,bytes:b.length,sha256:c.createHash('sha256').update(b).digest('hex'),contentType:r.headers.get('content-type'),cacheControl:r.headers.get('cache-control'),etag:r.headers.get('etag'),missing}))}catch{process.exit(1)}});"""
  value={'method':method,'path':path,'jwt':jwt}
  if data is not None:value['data']=base64.b64encode(data).decode()
  return platform_json(docker('exec','-i',id,'node','-e',script,data=final_canonical(value)))
 def checkpoint(id,storage=None):
  closed(id);value=native_backup_state(query,helper,id)
  if storage is not None:value['files']=inventory(storage)
  return value
 def storage_start(kind,db,vol,network,url,ca):
  memory(kind+'-before-api');base={**env,'DATABASE_URL':url,'DATABASE_SSL_ROOT_CERT':'/tmp/native-ca.crt','FILE_STORAGE_BACKEND_PATH':'/mnt','STORAGE_BACKEND':'file','STORAGE_FILE_ETAG_ALGORITHM':'md5','TUS_USE_FILE_VERSION_SEPARATOR':'false','GLOBAL_S3_BUCKET':'native-final','TENANT_ID':'nf'+rid.replace('-',''),'NODE_OPTIONS':'--max-old-space-size=128','PG_QUEUE_ENABLE':'false','ENABLE_QUEUE_EVENTS':'false','PG_QUEUE_WORKERS_ENABLE':'false','DB_INSTALL_ROLES':'false','DB_ALLOW_MIGRATION_REFRESH':'false','DB_MIGRATIONS_STRATEGY':'on_request','ENABLE_IMAGE_TRANSFORMATION':'false','S3_PROTOCOL_ENABLED':'false','WEBHOOK_URL':'','OTEL_ENABLED':'false','LOG_LEVEL':'error'}
  assert all('\n'not in k+v and '\r'not in k+v and '\0'not in k+v for k,v in base.items()),'NATIVE_BACKUP_ENV_ONE_LINE';envfile=kind+'.env';save(envfile,('\n'.join(k+'='+v for k,v in sorted(base.items()))+'\n').encode())
  name=prefix+'-'+kind;assert not docker('ps','-aq','--filter','name=^/'+name+'$').strip(),'NATIVE_BACKUP_OLD_API';pending[name]={'kind':kind,'name':name,'image':platform['images']['storage']['imageId'],'memory':512,'declaredMounts':['type=volume,src='+vol+',dst=/mnt','type=bind,src='+str(ca)+',dst=/tmp/native-ca.crt,readonly'],'argv':None,'entrypoint':None,'user':None,'network':network};save('create-'+kind+'-intent.json',{'name':name,'runId':rid,'image':platform['images']['storage']['imageId']});id=docker('create','--pull=never','--no-healthcheck','--memory','512m','--memory-swap','512m','--cpus','0.5','--pids-limit','128','--log-driver','none','--network',network,'--name',name,*labels(),'--env-file',str(root/envfile),'--mount','type=volume,src='+vol+',dst=/mnt','--mount','type=bind,src='+str(ca)+',dst=/tmp/native-ca.crt,readonly',platform['images']['storage']['imageId']).decode().strip();assert re.fullmatch('[a-f0-9]{64}',id)and id not in(source,protected,*owned),'NATIVE_BACKUP_API_ID';owned[id]=dict(pending[name]);bind_config(id,network);start(id)
  for _ in range(60):
   caps(id);r=subprocess.run(t.DOCKER+['exec',id,'node','-e',"fetch('http://127.0.0.1:5000/status',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
   if r.returncode==0:return id
   time.sleep(.5)
  raise AssertionError('NATIVE_BACKUP_API_NOT_READY_NO_WRITE')
 def tls(db):
  v=platform_json(query(db,"select coalesce(json_agg(json_build_object('role',a.usename,'ssl',s.ssl,'protocol',s.version,'cipher',s.cipher,'bits',s.bits)),'[]')from pg_stat_ssl s join pg_stat_activity a using(pid)where a.usename='supabase_storage_admin';"));assert v and all(s['role']=='supabase_storage_admin'and s['ssl']is True and s['protocol']in('TLSv1.2','TLSv1.3')and type(s['bits'])is int and s['bits']>=128 for s in v),'NATIVE_BACKUP_ACTUAL_TLS_REQUIRED';return v
 def object_rows(db):return platform_json(query(db,"select coalesce(json_agg(json_build_array(id,bucket_id,name,version)order by bucket_id,name),'[]')from storage.objects;"))
 def object_files(files,bucket,name):
  suffix=[bucket,*name.split('/')];return {k:v for k,v in files.items()if any(list(PurePosixPath(k).parts)[i:i+len(suffix)]==suffix for i in range(len(PurePosixPath(k).parts)-len(suffix)))}
 try:
  before,protected_identity=protected_whole();assert len(before['snapshot']['rows'])==186 and len(before['sequences'])==6 and final_digest(final_canonical({'snapshot':before['snapshot'],'sequences':before['sequences']}))==g['protectedSourceWholeSha256'],'NATIVE_BACKUP_PROTECTED_WHOLE_REQUIRED';save('protected-before-private.json',before)
  assert source_caps()['State']['Running']is False,'NATIVE_BACKUP_SOURCE_MUST_START_STOPPED';memory('source-before-start');source_reservation=native_backup_reserve(source,'source',{'revision':args.revision,'graphSha256':gsha});save('source-phase-reservation.json',{'sha256':source_reservation});save('source-start-intent.json',{'id':source,'singleRestart':True});source_started=True;docker('start',source);wait_db(source)
  save('source-final-server-proof.json',server_proof(source,True));initial=checkpoint(source);assert initial['snapshot']==proofs['canonical-final-private.json']and len(initial['snapshot']['rows'])==178,'NATIVE_BACKUP_CANONICAL_SOURCE_CHANGED';assert not object_rows(source)and query(source,'select count(*)from auth.users;').strip()==b'0','NATIVE_BACKUP_SYNTHETIC_EMPTY_MEMBER_BASELINE';assert query(source,'select count(*)from pg_largeobject_metadata;').strip()==b'0','NATIVE_BACKUP_LARGE_OBJECT_SCOPE_REFUSED';save('canonical-before-fixtures-private.json',initial)
  network=platform_json(docker('network','inspect',g['sourceIdentity']['networkId']));assert len(network)==1 and network[0]['Id']==g['sourceIdentity']['networkId']and network[0]['Internal']is True,'NATIVE_BACKUP_SOURCE_INTERNAL_NETWORK'
  assert network[0]['Labels'].get('yumidang.owner')=='minkyu'and network[0]['Labels'].get('yumidang.scope')==NATIVE_SCOPE and network[0]['Labels'].get('yumidang.run_id')==g['sourceIdentity']['runId'],'NATIVE_BACKUP_SOURCE_NETWORK_LABELS'
  for old_id in network[0].get('Containers',{}):assert old_id==source or inspect(old_id)['State']['Running']is False,'NATIVE_BACKUP_OTHER_NATIVE_SERVICE_RUNNING'
  save('source-ca.crt',final_regular(Path(g['sourceCaCert']),private=True));source_volume=volume('source');source_api=storage_start('source-api',source,source_volume,network[0]['Name'],env['DATABASE_URL'],root/'source-ca.crt')
  bucket='nf-'+rid[:8];profile=str(uuid.uuid4());known_name=str(uuid.uuid4())+'.png';unknown_name=str(uuid.uuid4())+'.png';unknown_id=str(uuid.uuid4());unknown_global=str(uuid.uuid4());unknown_ticket=str(uuid.uuid4());known_path='/object/'+bucket+'/'+known_name;unknown_path='/object/'+bucket+'/'+unknown_name
  secret=env['AUTH_JWT_SECRET'].encode();header=base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').rstrip(b'=');payload=base64.urlsafe_b64encode(final_canonical({'role':'service_role','sub':profile,'aud':'authenticated','exp':int(time.time())+3600})).rstrip(b'=');jwt=(header+b'.'+payload+b'.'+base64.urlsafe_b64encode(hmac.new(secret,header+b'.'+payload,hashlib.sha256).digest()).rstrip(b'=')).decode()
  probe=request(source_api,'GET','/object/authenticated/'+bucket+'/absent.png',jwt);assert probe['missing'],'NATIVE_BACKUP_ABSENT_STARTUP_GET';assert checkpoint(source)==initial and not inventory(source_api),'NATIVE_BACKUP_API_START_OR_GET_CHANGED_BASELINE';save('source-api-tls.json',tls(source))
  stage='synthetic_fixture';save('fixture-intent.json',{'profileId':profile,'bucket':bucket,'known':known_name,'unknown':unknown_name,'unknownRequestId':unknown_id,'scope':'SYNTHETIC_AUTH_SQL_NO_SIGNUP_NO_PHYSICAL_UNKNOWN_DELETE'})
  query(source,"begin;insert into auth.users(id,email)values('"+profile+"','"+profile+"@native-final.invalid');insert into storage.buckets(id,name,public)values('"+bucket+"','"+bucket+"',false);insert into private.worker_runtime_intents(request_id,ticket,operation,global_token,scope,fingerprint,state)values('"+unknown_id+"','"+unknown_ticket+"','report_storage','"+unknown_global+"',jsonb_build_object('kind','report_retention'),repeat('a',64),'unknown');insert into private.worker_invocations(request_id,global_token,kind,item_limit,fingerprint,state,dispatch_started,remaining_ms,deadline)values('"+unknown_id+"','"+unknown_global+"','report_retention',1,repeat('b',64),'unknown',true,60000,clock_timestamp()-interval'1 second');commit;",write=True)
  png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7S8AAAAASUVORK5CYII=');pngsha=final_digest(png);get_headers=lambda r:{k:r[k]for k in('contentType','cacheControl','etag')}
  for label,path in(('known',known_path),('unknown',unknown_path)):
   save('put-'+label+'-intent.json',{'method':'PUT','object':path,'sha256':pngsha,'firstAttemptOnly':True});result=request(source_api,'PUT',path,jwt,png);assert result['status']==200,'NATIVE_BACKUP_PUT_UNKNOWN_NO_RETRY';save('put-'+label+'-success.json',{'status':200,'object':path,'sha256':pngsha})
   previous=checkpoint(source,source_api);result=request(source_api,'GET',path.replace('/object/','/object/authenticated/',1),jwt);assert result['status']==200 and result['sha256']==pngsha and result['contentType']=='image/png','NATIVE_BACKUP_PUT_BYTES_REQUIRED';assert result['cacheControl']=='no-cache'and isinstance(result['etag'],str)and result['etag'],'NATIVE_BACKUP_STORED_HEADERS_REQUIRED';headers[path]=get_headers(result);assert checkpoint(source,source_api)==previous,'NATIVE_BACKUP_GET_CHANGED_DB_OR_FILES'
  prebackup=checkpoint(source,source_api);objects=object_rows(source);assert len(objects)==2 and {r[2]for r in objects}=={known_name,unknown_name},'NATIVE_BACKUP_FRESH_OBJECTS_ONLY'
  for object_id,b,name,version in objects:
   associated=object_files(prebackup['files'],b,name);assert len(associated)==1 and next(iter(associated.values()))['sha256']==pngsha and any(PurePosixPath(k).name==version for k in associated),'NATIVE_BACKUP_ALL_CURRENT_VERSION_BYTES_REQUIRED'
  assert len(prebackup['files'])==2,'NATIVE_BACKUP_UNACCOUNTED_VOLUME_FILE';save('before-delete-full-private.json',prebackup);save('response-headers-private.json',headers)
  stage='consistent_backup';stop(source_api);closed(source);dump=docker('exec',source,'pg_dump','-h','/var/run/postgresql','-U','supabase_admin','-d','postgres','-Fc');roles=docker('exec',source,'pg_dumpall','-h','/var/run/postgresql','-U','supabase_admin','--roles-only','--no-role-passwords');assert not re.search(rb"\bPASSWORD\s+'",roles,re.I),'NATIVE_BACKUP_PASSWORD_DUMP_REFUSED'
  utility=create('source-archive',platform['images']['storage']['imageId'],['-cf','-','-C','/mnt','.'],mounts=['type=volume,src='+source_volume+',dst=/mnt,readonly'],memory_mib=64,entrypoint='tar')
  # tar stdout is captured by attached start, never Docker logs (LogDriver=none).
  archive=attached(utility);assert own(utility)['State']['ExitCode']==0,'NATIVE_BACKUP_ARCHIVE_UTILITY_FAILED';stop(utility)
  archived=native_backup_archive(archive);assert archived=={k:{f:v for f,v in item.items()if f not in('nlink','xattrs')}for k,item in prebackup['files'].items()},'NATIVE_BACKUP_TAR_FILES_CHANGED'
  assert checkpoint(source)=={k:v for k,v in prebackup.items()if k!='files'},'NATIVE_BACKUP_SOURCE_CHANGED_DURING_DUMP';archive_database=native_backup_database_archive(docker('exec','-i',source,'pg_restore','--list',data=dump),prebackup);save('database-archive-metadata.json',archive_database);save('canonical-before-delete.dump',dump);save('roles-no-passwords.sql',roles);save('before-delete-storage.tar',archive)
  # A new utility reads the stopped API's volume; no protected source/service is restarted.
  meta_utility=create('source-metadata',platform['images']['storage']['imageId'],['-e',inventory_js],mounts=['type=volume,src='+source_volume+',dst=/mnt,readonly'],memory_mib=128,entrypoint='node',stdin=True)
  saved_inventory=native_backup_inventory(platform_json(attached(meta_utility,b'{}')));assert own(meta_utility)['State']['ExitCode']==0 and saved_inventory==prebackup['files'],'NATIVE_BACKUP_STOPPED_VOLUME_CHANGED';stop(meta_utility);save('backup-files-xattrs-private.json',saved_inventory)
  stage='known_delete';save('source-api-restart-intent.json',{'id':source_api,'afterBackup':True});memory('source-api-after-backup');docker('start',source_api)
  for _ in range(30):
   try:
    check=request(source_api,'GET',known_path.replace('/object/','/object/authenticated/',1),jwt)
    if check['status']==200 and check['sha256']==pngsha:break
   except (AssertionError,subprocess.TimeoutExpired):pass
   time.sleep(.5)
  else:raise AssertionError('NATIVE_BACKUP_GET_ONLY_READY_FAILED')
  assert checkpoint(source,source_api)==prebackup,'NATIVE_BACKUP_RESTART_OR_GET_CHANGED_BACKUP'
  delete_reservation=native_backup_reserve(source,'known_delete',{'revision':args.revision,'graphSha256':gsha});save('known-delete-intent.json',{'object':known_name,'bucket':bucket,'sha256':pngsha,'reservationSha256':delete_reservation,'attempt':1,'productAck':'NOT_RUN'})
  assert request(source_api,'DELETE',known_path,jwt)['status']==200,'NATIVE_BACKUP_DELETE_UNKNOWN_NO_RETRY'
  assert request(source_api,'GET',known_path.replace('/object/','/object/authenticated/',1),jwt)['missing'],'NATIVE_BACKUP_DELETE_GET_NOT_ABSENT'
  source_final=checkpoint(source,source_api);assert not object_files(source_final['files'],bucket,known_name)and {r[2]for r in object_rows(source)}=={unknown_name},'NATIVE_BACKUP_DELETE_ALL_VERSIONS_OR_METADATA_REMAIN'
  assert source_final['files']=={k:v for k,v in prebackup['files'].items()if k not in object_files(prebackup['files'],bucket,known_name)},'NATIVE_BACKUP_DELETE_CHANGED_UNRELATED_BYTES_OR_XATTRS'
  changed={k for k,v in prebackup['snapshot']['rows'].items()if source_final['snapshot']['rows'].get(k)!=v};assert changed=={'storage.objects'}and source_final['snapshot']['catalog']==prebackup['snapshot']['catalog']and source_final['snapshot']['roles']==prebackup['snapshot']['roles']and all(source_final[k]==prebackup[k]for k in('sequences','rawAuthority','effectivePrivileges')),'NATIVE_BACKUP_DELETE_CHANGED_UNRELATED_OR_UNKNOWN_DB'
  known={'status':200,'bucket':bucket,'object':known_name,'sha256':pngsha,'originalSourceId':source,'originalGraphSha256':gsha,'backupDumpSha256':final_digest(dump),'archiveSha256':final_digest(archive),'allAssociatedVersionsBytesAbsent':True,'metadataAbsent':True,'scope':'HISTORICAL_SYNTHETIC_STORAGE_HTTP_SUCCESS_NOT_PRODUCT_ACK'};save('known-delete-success.json',known);save('source-after-delete-full-private.json',source_final)
  stop(source_api);assert checkpoint(source)=={k:v for k,v in source_final.items()if k!='files'},'NATIVE_BACKUP_SOURCE_STOP_CHANGED_DB'
  final_meta=create('source-final-metadata',platform['images']['storage']['imageId'],['-e',inventory_js],mounts=['type=volume,src='+source_volume+',dst=/mnt,readonly'],memory_mib=128,entrypoint='node',stdin=True);final_files=native_backup_inventory(platform_json(attached(final_meta,b'{}')));assert own(final_meta)['State']['ExitCode']==0 and final_files==source_final['files'],'NATIVE_BACKUP_SOURCE_STOP_CHANGED_FILES';stop(final_meta);closed(source);stop(source);source_started=False;assert source_own()['State']['Running']is False,'NATIVE_BACKUP_SOURCE_STOP_BEFORE_TARGET'
  stage='target_restore';memory('target-before-create');target_reservation=native_backup_reserve(source,'target',{'revision':args.revision,'graphSha256':gsha});save('target-phase-reservation.json',{'sha256':target_reservation})
  ids=docker('network','ls','-q').decode().split();used=[]
  if ids:
   for x in platform_json(docker('network','inspect',*ids)):
    for entry in x.get('IPAM',{}).get('Config')or[]:
     if entry.get('Subnet'):used.append(ipaddress.ip_network(entry['Subnet'],strict=False))
  subnet=next((ipaddress.ip_network('10.'+str(b)+'.'+str(i)+'.0/29')for b in range(230,240)for i in range(256)if not any(ipaddress.ip_network('10.'+str(b)+'.'+str(i)+'.0/29').overlaps(n)for n in used if n.version==4)),None);assert subnet is not None,'NATIVE_BACKUP_NO_FRESH_SUBNET'
  net=prefix+'-net';save('network-intent.json',{'name':net,'subnet':str(subnet),'runId':rid});network_id=docker('network','create','--internal','--subnet',str(subnet),*labels(),net).decode().strip();assert re.fullmatch('[a-f0-9]{64}',network_id),'NATIVE_BACKUP_NEW_NETWORK_ID';netinfo=platform_json(docker('network','inspect',network_id));assert len(netinfo)==1 and netinfo[0]['Internal']is True and netinfo[0]['Id']==network_id,'NATIVE_BACKUP_NEW_INTERNAL_NETWORK'
  database=prebackup['rawAuthority']['database'];assert database[0]=='postgres'and database[1]in{r['rolname']for r in prebackup['snapshot']['roles']['roles']}and database[2]=='UTF8'and database[5]=='c'and database[6]is None and all(re.fullmatch('[A-Za-z0-9_.@-]{1,100}',v)for v in(database[3],database[4])),'NATIVE_BACKUP_DB_LOCALE_UNSUPPORTED_NO_REPAIR'
  init="initdb -U supabase_admin -D /tmp/native-final-data --auth-local=trust --auth-host=reject --encoding=UTF8 --lc-collate="+database[3]+" --lc-ctype="+database[4]+" && exec postgres -D /tmp/native-final-data -c config_file=/etc/postgresql/postgresql.conf -c data_directory=/tmp/native-final-data -c hba_file=/tmp/native-final-data/pg_hba.conf -c listen_addresses='*' -c unix_socket_directories=/var/run/postgresql -c ssl=off -c cron.database_name=postgres -c cron.launch_active_jobs=off -c shared_buffers=16MB -c max_connections=40"
  target=create('target-db',platform['images']['db']['imageId'],['-c',init],entrypoint='sh',user='postgres',network=net,alias='mplatform-target');start(target);wait_db(target)
  assert query(target,"select current_user='supabase_admin'and(select rolsuper from pg_roles where rolname=current_user);").strip()==b't','NATIVE_BACKUP_ORIGINAL_ADMIN_BOOTSTRAP_REQUIRED'
  source_admin=next(r for r in prebackup['snapshot']['roles']['roles']if r['rolname']=='supabase_admin');assert source_admin['rolsuper']is True,'NATIVE_BACKUP_NO_STRONGER_BOOTSTRAP_SUBSTITUTION'
  role_sql='\n'.join(line for line in roles.decode().splitlines()if not re.match(r'CREATE ROLE supabase_admin(?: |;)',line));save('roles-restore-intent.json',{'sha256':final_digest(role_sql.encode()),'grantedByPreserved':True,'originalAdminCreateOnlyExcluded':True});query(target,role_sql,write=True)
  actual_roles=helper.roles(target)
  for role in actual_roles['roles']:role.pop('oid',None)
  assert actual_roles==prebackup['snapshot']['roles'],'NATIVE_BACKUP_ORIGINAL_ROLES_BEFORE_DATABASE_RESTORE'
  assert target not in(source,protected)and owned[target]['kind']=='db'and owned[target]['image']==platform['images']['db']['imageId']and source_own()['State']['Running']is False,'NATIVE_BACKUP_FRESH_TARGET_DROP_SCOPE';caps(target)
  assert query(target,"select count(*)from pg_class c join pg_namespace n on n.oid=c.relnamespace where left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema'and c.relkind in('r','p','v','m','f','S');").strip()==b'0','NATIVE_BACKUP_TARGET_EMPTY_BEFORE_FORCE_DROP'
  assert query(target,'show cron.database_name;show cron.launch_active_jobs;').split()==[b'postgres',b'off'],'NATIVE_BACKUP_TARGET_CRON_RESTORE_DATABASE_REQUIRED'
  assert native_backup_database_archive(docker('exec','-i',target,'pg_restore','--list',data=dump),prebackup)==archive_database,'NATIVE_BACKUP_ORIGINAL_DATABASE_ARCHIVE_CHANGED'
  save('database-restore-intent.json',{'dumpSha256':final_digest(dump),'databaseArchiveMetadataSha256':final_digest(final_canonical(archive_database)),'singleTransaction':False,'recreatedFromOriginalArchive':True,'freshTargetOnlyForceDrop':True,'targetId':target,'attempt':1,'partialUnknownNoReplay':True})
  docker('exec',target,'dropdb','-h','/var/run/postgresql','-U','supabase_admin','--force','--maintenance-db=template1','postgres')
  docker('exec','-i',target,'pg_restore','-h','/var/run/postgresql','-U','supabase_admin','-d','template1','--create','--exit-on-error',data=dump)
  save('target-final-server-proof.json',server_proof(target,False));restored=checkpoint(target);assert restored=={k:v for k,v in prebackup.items()if k!='files'},'NATIVE_BACKUP_FULL_ROWS_ROLES_RAW_ACL_EFFECTIVE_SEQUENCE_RESTORE_MISMATCH';save('target-before-storage-full-private.json',restored)
  # New target TLS/credential only. The original canonical source role/config/secret is untouched.
  stage='target_storage';password=secrets.token_hex(32);query(target,"alter role supabase_storage_admin password '"+password+"';",write=True)
  for filename in('target-ca.key','target-ca.crt','target-server.key','target-server.csr','target-server.crt'):assert not(root/filename).exists(),'NATIVE_BACKUP_TLS_NO_OVERWRITE'
  call(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(root/'target-ca.key'),'-out',str(root/'target-ca.crt'),'-days','1','-subj','/CN=native-final-target-only','-addext','basicConstraints=critical,CA:TRUE'])
  call(['openssl','req','-newkey','rsa:2048','-nodes','-keyout',str(root/'target-server.key'),'-out',str(root/'target-server.csr'),'-subj','/CN=mplatform-target']);save('target-server.ext',b'subjectAltName=DNS:mplatform-target\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:false\n')
  call(['openssl','x509','-req','-in',str(root/'target-server.csr'),'-CA',str(root/'target-ca.crt'),'-CAkey',str(root/'target-ca.key'),'-set_serial',str(int(uuid.uuid4())),'-out',str(root/'target-server.crt'),'-days','1','-extfile',str(root/'target-server.ext')])
  for filename in('target-ca.key','target-ca.crt','target-server.key','target-server.csr','target-server.crt'):(root/filename).chmod(0o600)
  for suffix in('key','crt'):docker('cp',str(root/('target-server.'+suffix)),target+':/tmp/native-final-server.'+suffix)
  docker('exec','--user','root',target,'chown','postgres:postgres','/tmp/native-final-server.key','/tmp/native-final-server.crt');docker('exec',target,'chmod','600','/tmp/native-final-server.key')
  docker('exec','-i',target,'sh','-c','cat > /tmp/native-final-data/pg_hba.conf',data=b'local all all trust\nhostssl postgres supabase_storage_admin 0.0.0.0/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n');query(target,"alter system set ssl='on';alter system set ssl_cert_file='/tmp/native-final-server.crt';alter system set ssl_key_file='/tmp/native-final-server.key';select pg_reload_conf();",write=True)
  for _ in range(40):
   if query(target,'show ssl;').strip()==b'on':break
   time.sleep(.25)
  else:raise AssertionError('NATIVE_BACKUP_TARGET_TLS_REQUIRED')
  target_volume=volume('target');extract=create('target-extract',platform['images']['storage']['imageId'],['-xf','-','-C','/mnt'],entrypoint='tar',mounts=['type=volume,src='+target_volume+',dst=/mnt'],memory_mib=64,stdin=True);attached(extract,archive);assert own(extract)['State']['ExitCode']==0,'NATIVE_BACKUP_TAR_EXTRACT_FAILED';stop(extract)
  metadata=create('target-metadata',platform['images']['storage']['imageId'],['-e',inventory_js],entrypoint='node',mounts=['type=volume,src='+target_volume+',dst=/mnt'],memory_mib=128,stdin=True);result=native_backup_inventory(platform_json(attached(metadata,final_canonical({'restore':prebackup['files']}))));assert own(metadata)['State']['ExitCode']==0 and result==prebackup['files'],'NATIVE_BACKUP_FULL_FILES_XATTR_RESTORE';stop(metadata)
  assert checkpoint(target)==restored,'NATIVE_BACKUP_TARGET_TLS_OR_METADATA_CHANGED_DB'
  target_api=storage_start('target-api',target,target_volume,net,'postgresql://supabase_storage_admin:'+password+'@mplatform-target:5432/postgres?sslmode=verify-full&sslrootcert=/tmp/native-ca.crt',root/'target-ca.crt')
  assert source_own()['State']['Running']is False,'NATIVE_BACKUP_TWO_TEST_DBS_REFUSED'
  for path in(known_path,unknown_path):
   previous=checkpoint(target,target_api);r=request(target_api,'GET',path.replace('/object/','/object/authenticated/',1),jwt);assert r['status']==200 and r['sha256']==pngsha and get_headers(r)==headers[path],'NATIVE_BACKUP_REVIVED_FULL_BYTES_HEADERS_REQUIRED';assert checkpoint(target,target_api)==previous,'NATIVE_BACKUP_TARGET_GET_CHANGED_STATE'
  assert checkpoint(target,target_api)==prebackup,'NATIVE_BACKUP_API_STARTUP_CHANGED_RESTORE';save('target-api-tls.json',tls(target))
  stage='known_reapply';assert platform_json(final_regular(root/'known-delete-success.json',private=True))==known and known['status']==200 and known['allAssociatedVersionsBytesAbsent']is True and known['metadataAbsent']is True,'NATIVE_BACKUP_IMMUTABLE_KNOWN_SUCCESS_REQUIRED'
  reapply_reservation=native_backup_reserve(source,'known_reapply',{'revision':args.revision,'graphSha256':gsha,'knownSuccessSha256':final_digest(final_canonical(known))});save('known-reapply-intent.json',{'reservationSha256':reapply_reservation,'knownSuccessSha256':final_digest(final_canonical(known)),'targetId':target,'attempt':1,'unknownDeleteOrAck':'NOT_RUN'})
  assert request(target_api,'DELETE',known_path,jwt)['status']==200,'NATIVE_BACKUP_REAPPLY_UNKNOWN_NO_RETRY';assert request(target_api,'GET',known_path.replace('/object/','/object/authenticated/',1),jwt)['missing'],'NATIVE_BACKUP_REAPPLY_NOT_ABSENT';final_target=checkpoint(target,target_api)
  assert not object_files(final_target['files'],bucket,known_name)and final_target==source_final,'NATIVE_BACKUP_REAPPLY_NOT_EXACT_OR_UNKNOWN_CHANGED';save('target-after-reapply-full-private.json',final_target);stop(target_api);assert checkpoint(target)=={k:v for k,v in final_target.items()if k!='files'},'NATIVE_BACKUP_TARGET_STOP_CHANGED_DB'
  target_final_meta=create('target-final-metadata',platform['images']['storage']['imageId'],['-e',inventory_js],mounts=['type=volume,src='+target_volume+',dst=/mnt,readonly'],memory_mib=128,entrypoint='node',stdin=True);assert native_backup_inventory(platform_json(attached(target_final_meta,b'{}')))==final_target['files'],'NATIVE_BACKUP_TARGET_STOP_CHANGED_FILES';stop(target_final_meta);closed(target)
  assert native_backup_graph(args.graph_manifest)[1]==gsha,'NATIVE_BACKUP_INPUTS_CHANGED_AFTER_PHASES';passed=True
  receipt={'status':'PASS_CANONICAL119_SYNTHETIC_BACKUP_RESTORE','scope':NATIVE_BACKUP_SCOPE,'graphSha256':gsha,'canonicalReceiptSha256':NATIVE_BACKUP_CANONICAL_PROOFS['receipt.json'],'tableCount':178,'fullRoleAttrsMembershipGrantorsRawAclEffectivePrivilegesExact':True,'sequenceInventorySha256':final_digest(final_canonical(prebackup['sequences'])),'sequenceCount':len(prebackup['sequences']),'dumpSha256':final_digest(dump),'rolesNoPasswordsSha256':final_digest(roles),'archiveSha256':final_digest(archive),'fileXattrsInventorySha256':final_digest(final_canonical(prebackup['files'])),'knownDeleteSuccessSha256':final_digest(final_canonical(known)),'allVolumeFilesAndAssociatedVersionsRestored':True,'knownConfirmedStorageHttp200ReappliedOnce':True,'syntheticUnknownRowsAndBytesPreserved':True,'actualPhysicalUnknownDelete':'NOT_RUN_SYNTHETIC_DB_ROWS','productAckDeleteDispatch':'NOT_RUN','publicAuthSignup':'NOT_RUN_SYNTHETIC_AUTH_SQL','nativeSource39MissingStorageBytes':'UNRESOLVED_NOT_REPAIRED','liveOperatingDataStorageBackup':'NOT_RUN','stage6Complete':False,'activationAllowed':False,'rolePasswordsExcluded':True,'databaseRecreatedFromOriginalArchive':True,'restoreSingleTransaction':False,'nativeApplicationSqlReplay':0,'sourceCanonicalSyntheticDataChanged':True,'protectedSourceStopRestartWrite':0,'protectedStorage103Access':0,'serializedMaxActiveTestDbs':1,'storageHttpScope':'ISOLATED_LOOPBACK_HTTP_NOT_OPERATING_HTTPS','fileProofScope':'SHA_BYTES_MODE_UID_GID_NLINK_XATTRS_CONTENTTYPE_CACHECONTROL_ETAG_EQUALITY_CONFIGURED_MD5_NOT_MTIME_ATIME_CTIME_INODE_PHYSICAL_SNAPSHOT'}
 except BaseException as e:
  token=str(e)if type(e)is AssertionError else'';save('failure-private.json',{'stage':stage,'type':type(e).__name__,'assertion':token if re.fullmatch('[A-Z][A-Z0-9_]{0,120}',token)else'FIXED_UNCLASSIFIED','frames':[{'file':Path(f.filename).name,'line':f.lineno,'function':f.name}for f in traceback.extract_tb(e.__traceback__)],'noReplay':True,'partialUnknownPreserved':True})
 finally:
  same=False;valid=True;states={};discovery_failures=[];ids=[]
  try:
   if before is not None:
    after,identity=protected_whole();same=after==before and identity==protected_identity;save('protected-after-private.json',after)
  except BaseException:valid=False
  try:
   ids=docker('ps','-a','-q','--no-trunc','--filter','label=yumidang.run_id='+rid,'--filter','label=yumidang.scope='+NATIVE_BACKUP_SCOPE).decode().split()
  except BaseException:
   valid=False;discovery_failures.append({'code':'DISCOVERY_ENUMERATION_FAILED'})
  for id in ids:
   try:
    assert re.fullmatch('[a-f0-9]{64}',id)and id not in(source,protected),'NATIVE_BACKUP_DISCOVERY_ID'
    x=inspect(id);name=x['Name'][1:];assert name in pending,'NATIVE_BACKUP_DISCOVERY_EXACT_NAME'
    if id not in owned:owned[id]=dict(pending[name]);own(id);bind_config(id,pending[name]['network'])
   except BaseException:
    valid=False;discovery_failures.append({'code':'DISCOVERY_ID_RECOVERY_FAILED','id':id if re.fullmatch('[a-f0-9]{64}',id)else None})
  for id in reversed(list(owned)):
   try:stop(id)
   except BaseException:valid=False
  if source_started:
   try:stop(source)
   except BaseException:valid=False
  for id in(source,*owned):
   try:
    x=source_own()if id==source else own(id);states[id]={'running':x['State']['Running'],'oomKilled':x['State']['OOMKilled']};valid=valid and states[id]=={'running':False,'oomKilled':False}
   except BaseException:valid=False
  save('finalization.json',{'protectedSourceWholeUnchanged':same,'ownedAllInvariantsVerified':valid,'exactAllOwnedStopped':valid,'states':states,'discoveryFailures':discovery_failures,'canonicalSourceFixtureCleanup':0,'partialOrUnknownPreserved':not passed,'nativeSqlReplay':0,'protectedSourceStopRestartWrite':0,'liveOperatingBackup':'NOT_RUN','activationAllowed':False})
 assert passed and same and valid,'NATIVE_BACKUP_FAILED_CLOSED_NO_REPLAY'
 receipt.update({'protectedSourceWholeUnchanged':True,'exactAllOwnedStopped':True,'ownedOomKilledFalse':True});save('receipt.json',receipt);print(json.dumps({'status':receipt['status'],'receiptSha256':final_digest(final_canonical(receipt)),'tableCount':178,'protectedSourceWholeUnchanged':True,'exactAllOwnedStopped':True,'liveOperatingDataStorageBackup':'NOT_RUN','activationAllowed':False}))


def native_backup_main(argv):
 import argparse
 from pathlib import Path
 p=argparse.ArgumentParser(description='정규119개 앱 DB+합성 실제 파일 백업/복원. 기본 NOT_RUN.')
 p.add_argument('--native-final-backup',action='store_true',required=True);p.add_argument('--run',action='store_true');p.add_argument('--graph-manifest',type=Path);p.add_argument('--revision');a=p.parse_args(argv)
 if not a.run:
  assert a.graph_manifest is None and a.revision is None,'NATIVE_BACKUP_RUN_FLAGS_REQUIRED';print(json.dumps({'status':'NOT_RUN','scope':NATIVE_BACKUP_SCOPE,'approvedByRoot':False,'dockerSlotReady':False,'minimumAvailableMiB':1024,'dbMiB':512,'storageMiB':512,'maxActiveTestDbs':1,'dockerCalls':0,'appSQLReplay':0,'liveOperatingDataStorageBackup':'NOT_RUN','oldSource39MissingBytes':'UNRESOLVED','activationAllowed':False}));return
 assert a.graph_manifest is not None and a.revision is not None,'NATIVE_BACKUP_GRAPH_REVISION_REQUIRED';run_native_final_backup(a)


if __name__=='__main__':
 import sys
 if '--native-final-backup'in sys.argv[1:]:native_backup_main(sys.argv[1:])
 elif '--canonical-application'in sys.argv[1:]:canonical_main(sys.argv[1:])
 elif '--platform-baseline'in sys.argv[1:]:native_main(sys.argv[1:])
 elif '--platform-manifest'in sys.argv[1:]:platform_main(sys.argv[1:])
 elif '--final-storage'in sys.argv[1:]:final_main(sys.argv[1:])
 elif sys.argv[1:]==['--full-storage']:run_full_storage()
 elif sys.argv[1:]==['--resume-full-storage']:run_full_storage(resume_storage=True)
 elif not sys.argv[1:]:run()
 else:raise SystemExit('INVALID_ARGUMENTS')
