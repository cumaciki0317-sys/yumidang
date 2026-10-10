"""SQL103 full isolated restore and mandatory deleted-detail reapplication."""
import json,re,time,uuid,subprocess
import queue_tls_environment as t
R=t.ROOT;NAME='yumidang-minkyu-runtime103-restore';BOOT='yumidang_recovery_bootstrap'
def sql(query):return t.call(t.DOCKER+['exec','-i',NAME,'psql','-XqAt','-U',BOOT,'-d','postgres','-v','ON_ERROR_STOP=1'],query.encode())
def purge(run,token):
 return run("begin;set local request.jwt.claims='{\"role\":\"service_role\"}';update private.worker_runtime_atomic_control set enabled=true;update private.global_worker_run set token='"+token+"',expires_at=clock_timestamp()+interval'180 seconds'where singleton;select public.purge_worker_runtime_details('"+token+"',20);update private.worker_runtime_atomic_control set enabled=false;update private.global_worker_run set token=null,expires_at=null where singleton;commit;")
def run():
 assert NAME not in t.call(t.DOCKER+['ps','-a','--format','{{.Names}}']).decode().splitlines(),'EXISTING_RESTORE_PRESERVED'
 original=json.loads(t.sql("select json_build_object('id',request_id,'hash',fingerprint)from private.worker_runtime_results where state='completed'order by created_at limit 1;").decode());key=original['id']
 t.sql("update private.worker_runtime_results set created_at=now()-interval'31 days',closed_at=now()-interval'30 days'where request_id='"+key+"';")
 before=t.sql("select json_build_object('minimum',count(*),'unknown',count(*)filter(where state='external_pending'))from private.worker_runtime_results;").decode()
 for filename,args in [('runtime103-before-purge.dump',['pg_dump','-U','yumidang_tls_bootstrap','-d','postgres','-Fc']),('runtime103-roles.sql',['pg_dumpall','-U','yumidang_tls_bootstrap','--roles-only','--no-role-passwords'])]:
  p=R/filename;p.write_bytes(t.call(t.DOCKER+['exec',t.NAME,*args]));p.chmod(0o600)
 purge(t.sql,str(uuid.uuid4()))
 assert t.sql("select state||':'||(input is null and result is null)::text from private.worker_runtime_results where request_id='"+key+"';").decode().strip()=='purged:true'
 t.call(t.DOCKER+['run','-d','--name',NAME,'--label','yumidang.owner=minkyu','--user','postgres','-p','127.0.0.1:61632:5432','--entrypoint','sh',t.IMAGE,'-c',"initdb -U "+BOOT+" -D /tmp/recovery-data --auth-local=trust --auth-host=reject && exec postgres -D /tmp/recovery-data -c listen_addresses='*' -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off"])
 for _ in range(40):
  r=subprocess.run(t.DOCKER+['exec',NAME,'pg_isready','-U',BOOT],capture_output=True,timeout=5)
  if r.returncode==0:break
  time.sleep(.5)
 else:raise RuntimeError('RECOVERY_NOT_READY')
 roles=(R/'runtime103-roles.sql').read_text();roles=re.sub(r' GRANTED BY [A-Za-z_][A-Za-z0-9_]*;',';',roles)
 # Target bootstrap is the only source-only role omitted; restored application role ACLs stay exact.
 roles='\n'.join(line for line in roles.splitlines()if not re.match(r'(CREATE|ALTER) ROLE yumidang_tls_bootstrap(?: |;)',line))
 sql(roles)
 t.call(t.DOCKER+['exec','-i',NAME,'pg_restore','-U',BOOT,'-d','postgres','--single-transaction','--exit-on-error'],(R/'runtime103-before-purge.dump').read_bytes())
 assert sql("select state||':'||(input is not null and result is not null)::text from private.worker_runtime_results where request_id='"+key+"';").decode().strip()=='completed:true'
 purge(sql,str(uuid.uuid4()))
 assert sql("select state||':'||(input is null and result is null)::text||':'||fingerprint from private.worker_runtime_results where request_id='"+key+"';").decode().strip()=='purged:true:'+original['hash']
 after=sql("select json_build_object('minimum',count(*),'unknown',count(*)filter(where state='external_pending'))from private.worker_runtime_results;").decode();assert json.loads(before)==json.loads(after)
 assert sql("select enabled from private.worker_runtime_atomic_control;").decode().strip()=='f'
 assert sql("select has_function_privilege('authenticated','public.execute_worker_runtime_operation(uuid,uuid,text,jsonb)','EXECUTE');").decode().strip()=='f'
 receipt={'fullRuntime103Restore':'PASS','deletedDetailsRevivedByOldBackup':True,'reappliedPurge':'PASS','minimumHashAndUnknownPreserved':True,'applicationExecuteClosed':True,'cronActiveJobs':'off','operatingChanged':False}
 p=R/'runtime103-restore-receipt.json';p.write_text(json.dumps(receipt));p.chmod(0o600);print(json.dumps(receipt))
if __name__=='__main__':run()
