"""현재 SQL99 DB+Storage 전체 복구 리허설. 고정 소유 target만 갱신, 알려진 삭제만 재적용."""
import hashlib,importlib.util,io,json,os,subprocess,sys,tarfile,tempfile,time,http.client,urllib.request,urllib.error
from pathlib import Path,PurePosixPath
R=Path('/private/tmp/yumidang-runner-recovery99');SOURCE='yumidang-release88-http';TARGET='yumidang-release92-restore';R.mkdir(mode=0o700,exist_ok=True)

spec=importlib.util.spec_from_file_location('h','/private/tmp/yumidang-native71-rollout-reviewed/apply.py');h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
s=json.loads(Path('/private/tmp/yumidang-release88-http-isolated/status-private.json').read_text());t=json.loads(Path('/private/tmp/yumidang-release94-recovery/target-status-private.json').read_text());assert s['API_URL']=='http://127.0.0.1:59621'and t['API_URL']=='http://127.0.0.1:60621'
def run(args,data=None,timeout=120):
 v=subprocess.run(h.BASE+args,input=data,capture_output=True,timeout=timeout)
 if v.returncode:(R/'recovery-failure-private.log').write_bytes(v.stdout+v.stderr);raise RuntimeError('RECOVERY_FAILED_NO_AUTOMATIC_RETRY')
 return v.stdout
key='recovery-fixture/release99-known-delete.jpg';photo=Path('/private/tmp/yumidang-report-retention-native82-info-fix-reviewed/profile.jpg').read_bytes();assert photo[:2]==b'\xff\xd8'
def storage(state,method,body=None):
 req=urllib.request.Request(state['API_URL']+'/storage/v1/object/profile-images/'+key,data=body,method=method,headers={'authorization':'Bearer '+state['SERVICE_ROLE_KEY'],'apikey':state['SERVICE_ROLE_KEY'],'content-type':'image/jpeg'})
 try:
  with urllib.request.urlopen(req,timeout=30)as response:return response.status,response.read()
 except urllib.error.HTTPError as e:return e.code,e.read()
def save(name,data,exclusive=False):
 p=R/name
 if exclusive:
  fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);temporary=None
 else:
  fd,temporary=tempfile.mkstemp(prefix='.receipt-',dir=R)
 try:
  with os.fdopen(fd,'wb')as output:
   output.write(data);output.flush();os.fsync(output.fileno())
  if temporary is not None:os.replace(temporary,p)
  directory=os.open(R,os.O_RDONLY)
  try:os.fsync(directory)
  finally:os.close(directory)
 finally:
  if temporary is not None and os.path.exists(temporary):os.unlink(temporary)
def files(data):
 result={}
 with tarfile.open(fileobj=io.BytesIO(data))as archive:
  for item in archive.getmembers():
   path=PurePosixPath(item.name);assert not path.is_absolute()and '..'not in path.parts and(item.isfile()or item.isdir())
   if item.isfile():result[item.name]=hashlib.sha256(archive.extractfile(item).read()).hexdigest()
 return result

CATALOG="select jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),md5(pg_get_functiondef(p.oid)),p.proowner,p.proacl::text,p.proconfig::text)order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private')and p.prokind='f';"
DDL="select jsonb_build_object('constraints',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,co.conname,pg_get_constraintdef(co.oid))order by n.nspname,c.relname,co.conname)from pg_constraint co join pg_class c on c.oid=co.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private')),'policies',(select jsonb_agg(to_jsonb(p)order by schemaname,tablename,policyname)from pg_policies p where schemaname in('public','private')),'triggers',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,pg_get_triggerdef(t.oid))order by n.nspname,c.relname,t.tgname)from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in('public','private')));"
ROWS="select jsonb_build_object('reads',(select jsonb_agg(to_jsonb(x)order by user_id,request_id)from private.conversation_read_states x),'hidden',(select jsonb_agg(to_jsonb(x)order by identity_id,target_type,target_id)from private.member_hidden_targets x),'results',(select jsonb_agg(to_jsonb(x)order by request_id)from private.ai_result_receipts x),'feedback',(select jsonb_agg(to_jsonb(x)order by feedback_id)from private.ai_feedback_receipts x),'control',(select jsonb_agg(to_jsonb(x))from private.ai_report_handling_control x));"
def wait_restored_bytes():
 for attempt in range(30):
  try:
   code,data=storage(t,'GET')
   if code==200:return code,data
   if code not in(502,503):raise AssertionError('RESTORED_BYTES_UNAVAILABLE')
  except (urllib.error.URLError,http.client.RemoteDisconnected):pass
  time.sleep(.5)
 raise RuntimeError('RESTORE_SERVICE_NOT_READY')
def verify_ddl(expected):
 actual=h.query(DDL)
 assert actual['policies']==expected['policies']and actual['triggers']==expected['triggers']
 normalized=[]
 allowed={'general_sanction_appeal_receipts_reason_check','worker_jobs_dedupe_key_check'}
 for row in expected['constraints']:
  if row in actual['constraints']:normalized.append(row);continue
  assert row[2]in allowed,'UNEXPECTED_CONSTRAINT_DIFF'
  # PG dump/restore reparses and flattens nested AND nodes. Reparse the source CHECK,
  # not a blanket removal of parentheses; preserve types and SQL semantics.
  definition=h.query("begin;create temp table recovery_check(reason text,dedupe_key text);alter table recovery_check add constraint normalized "+row[3]+";select to_jsonb(pg_get_constraintdef(oid))from pg_constraint where conrelid='pg_temp.recovery_check'::regclass and conname='normalized';rollback;")
  normalized.append([*row[:3],definition])
 assert normalized==actual['constraints'],'CONSTRAINT_SEMANTIC_MISMATCH'
 return sum(a!=b for a,b in zip(expected['constraints'],normalized))
def finish_storage(sourcefiles,services,protected=None):
 run(['start','supabase_storage_'+TARGET],timeout=30)
 run(['exec','supabase_storage_'+TARGET,'sh','-c','find /mnt -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'])
 run(['exec','-i','supabase_storage_'+TARGET,'tar','-xf','-','-C','/mnt'],(R/'source99-storage.tar').read_bytes())
 assert files(run(['exec','supabase_storage_'+TARGET,'tar','-cf','-','-C','/mnt','.']))==sourcefiles
 run(['start',*services],timeout=90)
 finalize_restored_storage(protected)
def finalize_restored_storage(protected=None):
 code,data=wait_restored_bytes();assert code==200 and data==photo
 assert not(R/'reapply-dispatch.json').exists(),'NO_AUTOMATIC_DELETE_REDISPATCH'
 save('reapply-dispatch.json',json.dumps({'knownDeleteOnly':True,'bucket':'profile-images','name':key}).encode(),exclusive=True)
 assert storage(t,'DELETE')[0]==200,'RESTORED_DELETE_UNKNOWN_NO_RETRY';assert storage(t,'GET')[0]in(400,404)
 assert h.query("select to_jsonb(not exists(select 1 from storage.objects where bucket_id='profile-images'and name='"+key+"'));")is True
 if protected is not None:assert h.protected_containers(list(protected))==protected
 receipt={'status':'PASS','fullDatabaseDumpRestored':True,'allTableCountsExact':True,'functionsOwnersAclSearchPathExact':True,'constraintsEquivalent':True,'checkExpressionsReparsed':2,'policiesTriggersExact':True,'readsHiddenAiReceiptsExact':True,'storageBytesExact':True,'knownDeletedBytesRestoredThenReapplied':True,'unknownDeletionReplayed':False,'operatingChanged':False,'target':TARGET,'pendingJournalNotReplayed':True}
 save('recovery99-receipt.json',json.dumps(receipt,indent=2).encode());print(json.dumps(receipt))


def new_recovery():
 assert not(R/'recovery-started.json').exists(),'RECOVERY_NO_AUTOMATIC_REPEAT'
 names=h.docker_output(['ps','-a','--format','{{.Names}}']).splitlines();assert 'supabase_db_'+TARGET in names and 'supabase_storage_'+TARGET in names
 protected=h.protected_containers([n for n in names if not n.endswith('_'+TARGET)])
 h.CONTAINER='supabase_db_'+SOURCE
 assert h.query("select to_jsonb(not(select enabled from private.report_purge_control where singleton)and not(select enabled from private.cancellation_due_control where singleton)and not(select enabled from private.ai_report_handling_control where singleton));")is True
 # Preserve prior owned target artifacts as well, before any target change.
 save('prior-target.dump',run(['exec','supabase_db_'+TARGET,'pg_dump','-U','postgres','-d','postgres','-Fc']))
 save('prior-target-storage.tar',run(['exec','supabase_storage_'+TARGET,'tar','-cf','-','-C','/mnt','.']))
 save('recovery-started.json',json.dumps({'source':SOURCE,'target':TARGET,'operatingChanged':False,'knownDeleteOnly':True}).encode(),exclusive=True)
 assert storage(s,'POST',photo)[0]in(200,201);code,data=storage(s,'GET');assert code==200 and data==photo
 counts=h.all_counts();save('source-counts-private.json',json.dumps(counts).encode())
 expected={name:h.query(q)for name,q in [('functions',CATALOG),('ddl',DDL),('rows',ROWS)]};save('comparison-private.json',json.dumps(expected).encode())
 save('source99.dump',run(['exec',h.CONTAINER,'pg_dump','-U','postgres','-d','postgres','-Fc']))
 save('source99-storage.tar',run(['exec','supabase_storage_'+SOURCE,'tar','-cf','-','-C','/mnt','.']))
 sourcefiles=files((R/'source99-storage.tar').read_bytes());assert hashlib.sha256(photo).hexdigest()in sourcefiles.values()
 assert storage(s,'DELETE')[0]==200,'DELETE_UNKNOWN_NO_RETRY';code,_=storage(s,'GET');assert code in(400,404)
 save('known-deletion-manifest.json',json.dumps({'bucket':'profile-images','name':key,'response':200,'sha256':hashlib.sha256(photo).hexdigest()}).encode())
 own=[n for n in names if n.endswith('_'+TARGET)];db='supabase_db_'+TARGET;services=[n for n in own if n!=db]
 run(['stop',*services],timeout=90)
 clear="begin;do $$declare i record;begin for i in select pubname from pg_publication loop execute format('drop publication %I',i.pubname);end loop;for i in select evtname from pg_event_trigger loop execute format('drop event trigger %I',i.evtname);end loop;for i in select extname from pg_extension where extname<>'plpgsql'loop execute format('drop extension %I cascade',i.extname);end loop;for i in select nspname from pg_namespace where left(nspname,3)<>'pg_'and nspname<>'information_schema'loop execute format('drop schema if exists %I cascade',i.nspname);end loop;end;$$;create schema public authorization pg_database_owner;grant usage on schema public to public;commit;"
 run(['exec','-i',db,'psql','-XqAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1'],clear.encode())
 run(['exec','-i',db,'pg_restore','-U','supabase_admin','-d','postgres','--single-transaction','--exit-on-error'],(R/'source99.dump').read_bytes())
 h.CONTAINER=db;assert h.all_counts()==counts
 for name,q in [('functions',CATALOG),('rows',ROWS)]:assert h.query(q)==expected[name],name+'_RESTORE_MISMATCH'
 verify_ddl(expected['ddl'])
 finish_storage(sourcefiles,services,protected)

def resume_after_db_restore():
 assert(R/'recovery-started.json').exists()and not(R/'recovery99-receipt.json').exists()
 assert json.loads((R/'known-deletion-manifest.json').read_text())['response']==200
 names=h.docker_output(['ps','-a','--format','{{.Names}}']).splitlines()
 services=[n for n in names if n.endswith('_'+TARGET)and n!='supabase_db_'+TARGET]
 h.CONTAINER='supabase_db_'+TARGET
 expected=json.loads((R/'comparison-private.json').read_text())
 for name,q in [('functions',CATALOG),('rows',ROWS)]:assert h.query(q)==expected[name],name+'_RESUME_MISMATCH'
 verify_ddl(expected['ddl'])
 # Prior pg_restore and the table-count comparison succeeded before the CHECK formatting mismatch.
 finish_storage(files((R/'source99-storage.tar').read_bytes()),services)

def verify_restored_and_reapply():
 assert(R/'recovery-started.json').exists()and not(R/'recovery99-receipt.json').exists()
 h.CONTAINER='supabase_db_'+TARGET
 expected=json.loads((R/'comparison-private.json').read_text())
 for name,q in [('functions',CATALOG),('rows',ROWS)]:assert h.query(q)==expected[name],name+'_FINAL_MISMATCH'
 verify_ddl(expected['ddl'])
 assert files(run(['exec','supabase_storage_'+TARGET,'tar','-cf','-','-C','/mnt','.']))==files((R/'source99-storage.tar').read_bytes())
 finalize_restored_storage()

if '--verify-restored-storage-and-reapply'in sys.argv:verify_restored_and_reapply()
elif '--resume-after-db-restore'in sys.argv:resume_after_db_restore()
else:new_recovery()
