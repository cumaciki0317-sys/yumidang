"""격리 회원·실제 Storage DELETE ACK 준비. 운영/Auth 실제 로그인은 변경하지 않는다."""
import base64,hashlib,json,secrets,sys,uuid
from pathlib import Path
from urllib.request import Request,urlopen
import queue_tls_environment as t
R=t.ROOT;FILE=R/'member-ack-recovery-private.json'
SIGNATURES='public.claim_member_cleanup_ack_recovery(uuid,uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)'
PREPARE_SIGNATURES='public.claim_member_cleanup_task(uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)'
def save(state):
 FILE.write_text(json.dumps(state));FILE.chmod(0o600)
def preflight(existing=False):
 assert existing or not FILE.exists(),'EXISTING_RECOVERY_PRESERVED_INSPECT_BEFORE_RETRY'
 ready=t.sql("select to_regprocedure('public.claim_member_cleanup_ack_recovery(uuid,uuid)')is not null and not(select enabled from private.worker_runtime_atomic_control)and not(select external_deletion_approved from private.member_cleanup_guard)and not(select token is not null and expires_at>clock_timestamp()from private.global_worker_run)and not exists(select 1 from pg_stat_activity where datname=current_database()and pid<>pg_backend_pid()and state<>'idle');").decode().strip()
 assert ready=='t','ISOLATED_ENVIRONMENT_NOT_IDLE_AND_CLOSED'
 for signature in (SIGNATURES+','+PREPARE_SIGNATURES).split(',public.'):
  signature=signature if signature.startswith('public.')else 'public.'+signature
  # Splitting on schema rather than commas preserves each RPC's argument list.
  assert t.sql("select has_function_privilege('service_role','"+signature+"','EXECUTE');").decode().strip()=='f','PREEXISTING_EXEC_PRESERVED'
def evidence(task_id):
 value=t.sql("select json_build_object('dispatch',row_to_json(d),'ack',row_to_json(a))from private.member_cleanup_dispatches d join private.member_cleanup_delete_acks a on a.task_id=d.task_id where d.task_id='"+task_id+"';")
 return hashlib.sha256(value).hexdigest()
def prepare():
 preflight()
 prefix=uuid.uuid4().hex[:8];uid=prefix+'-0000-4000-8000-000000000002'
 state={'phase':'before_seed','memberId':uid,'prefix':prefix,'signatures':SIGNATURES,'globalToken':str(uuid.uuid4()),'originalLease':str(uuid.uuid4()),'withdrawalId':str(uuid.uuid4())};save(state)
 seed=Path('tests/database/minkyu/assigned_report_notice_receipts.sql').read_text().split("insert into auth.users(id,email)values(pg_temp.safety_uid(3)")[0]
 seed=seed.replace('fe910000',prefix).replace('fe920000',prefix[:6]+'aa').replace('fe930000',prefix[:6]+'bb').replace('review-start-sql-','recovery108-'+prefix+'-')
 t.sql(seed+'commit;')
 state['phase']='seed_committed';save(state)
 keys=json.loads(Path('/private/tmp/yumidang-release88-http-isolated/status-private.json').read_text());service=keys['SERVICE_ROLE_KEY']
 name=uid+'/'+str(uuid.uuid4())+'.jpg'
 state['objectName']=name;state['phase']='before_upload';save(state)
 # Real Storage owns the metadata and binary creation/deletion. A synthetic file contains no user data.
 data=base64.b64decode('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAB//2Q==')
 headers={'Authorization':'Bearer '+service,'apikey':service,'Content-Type':'image/jpeg'}
 with urlopen(Request('http://127.0.0.1:61623/object/profile-images/'+name,data=data,headers=headers,method='POST'),timeout=10)as r:assert r.status==200
 object_id=t.sql("select id from storage.objects where bucket_id='profile-images'and name='"+name+"';").decode().strip();assert uuid.UUID(object_id)
 state['objectId']=object_id;state['phase']='before_withdrawal';save(state)
 finish(state)
def finish(state):
 keys=json.loads(Path('/private/tmp/yumidang-release88-http-isolated/status-private.json').read_text());service=keys['SERVICE_ROLE_KEY']
 uid=state['memberId'];object_id=state['objectId'];name=state['objectName']
 headers={'Authorization':'Bearer '+service,'apikey':service,'Content-Type':'image/jpeg'}
 session_id=t.sql("select id from auth.sessions where user_id='"+uid+"'limit 1;").decode().strip();uuid.UUID(session_id)
 withdrawal=state['withdrawalId'];global_token=state['globalToken'];lease=state['originalLease']
 t.sql("begin;update private.member_cleanup_guard set external_deletion_approved=true;grant execute on function "+PREPARE_SIGNATURES+" to service_role;set local role authenticated;select set_config('request.jwt.claims',jsonb_build_object('sub','"+uid+"','role','authenticated','session_id','"+session_id+"')::text,true);select public.retire_my_account('"+withdrawal+"');reset role;update private.member_cleanup_guard set external_deletion_approved=false;revoke execute on function "+PREPARE_SIGNATURES+" from service_role;commit;")
 task_id=t.sql("select id from private.member_cleanup_tasks where withdrawal_id='"+withdrawal+"'and object_id='"+object_id+"';").decode().strip();assert uuid.UUID(task_id)
 state['taskId']=task_id;state['phase']='before_dispatch';save(state)
 t.sql("begin;set local lock_timeout='3s';do $$begin perform 1 from private.global_worker_run where singleton for update;if exists(select 1 from private.global_worker_run where singleton and token is not null)or(select enabled from private.worker_runtime_atomic_control)or(select external_deletion_approved from private.member_cleanup_guard)then raise exception 'PREEXISTING_RUN_PRESERVED';end if;end$$;set local request.jwt.claims='{\"role\":\"service_role\"}';update private.worker_runtime_atomic_control set enabled=true;update private.member_cleanup_guard set external_deletion_approved=true;update private.global_worker_run set token='"+global_token+"',expires_at=clock_timestamp()+interval'180 seconds'where singleton;update private.member_cleanup_tasks set state='running',lease_token='"+lease+"',worker_run_token='"+global_token+"',lease_expires_at=clock_timestamp()+interval'60 seconds'where id='"+task_id+"';select public.begin_member_cleanup_delete('"+task_id+"','"+lease+"','"+global_token+"','"+object_id+"');commit;")
 state['phase']='before_delete';save(state)
 with urlopen(Request('http://127.0.0.1:61623/object/profile-images',data=json.dumps({'prefixes':[name]}).encode(),headers={**headers,'Content-Type':'application/json'},method='DELETE'),timeout=10)as r:
  deleted=json.load(r);assert len(deleted)==1 and deleted[0]['id']==object_id
 state['phase']='delete_observed_before_ack';save(state)
 t.sql("begin;set local request.jwt.claims='{\"role\":\"service_role\"}';select public.record_member_cleanup_delete_ack('"+task_id+"','"+lease+"','"+global_token+"','"+object_id+"',repeat('a',64));update private.member_cleanup_tasks set lease_expires_at=clock_timestamp()-interval'1 second'where id='"+task_id+"';grant execute on function "+SIGNATURES+" to service_role;notify pgrst,'reload schema';commit;")
 state.update({'phase':'ack_prepared','serviceKey':service,'anonKey':keys['ANON_KEY'],'internalSecret':secrets.token_urlsafe(36),'evidenceHash':evidence(task_id)});save(state)
 print('REAL_STORAGE_DELETE_AND_ACK_PREPARED_OPERATING_UNCHANGED')
def resume_before_withdrawal():
 state=json.loads(FILE.read_text())
 assert state['phase']=='closed'and 'objectId'in state and 'taskId'not in state,'INSPECT_UNKNOWN_STAGE_NO_AUTOMATIC_REPLAY'
 preflight(existing=True)
 uid=str(uuid.UUID(state['memberId']));obj=str(uuid.UUID(state['objectId']));withdrawal=str(uuid.UUID(state['withdrawalId']))
 ready=t.sql("select exists(select 1 from storage.objects where id='"+obj+"'and bucket_id='profile-images'and name='"+state['objectName']+"')and exists(select 1 from auth.sessions where user_id='"+uid+"')and not exists(select 1 from private.member_cleanup_tasks where withdrawal_id='"+withdrawal+"');").decode().strip()
 assert ready=='t','PREWITHDRAWAL_STATE_NOT_PROVEN'
 state['phase']='before_withdrawal';save(state);finish(state)
def close():
 f=json.loads(FILE.read_text());token=f['globalToken'];uuid.UUID(token)
 # A transaction locks and checks the token before closing this fixture's gates.
 t.sql("begin;set local lock_timeout='3s';set local statement_timeout='8s';do $$begin perform 1 from private.global_worker_run where singleton for update;if exists(select 1 from private.global_worker_run where singleton and token is not null and token<>'"+token+"')then raise exception 'FOREIGN_GLOBAL_TOKEN_PRESERVED';end if;end$$;update private.worker_runtime_atomic_control set enabled=false;update private.member_cleanup_guard set external_deletion_approved=false;revoke execute on function "+SIGNATURES+" from service_role;update private.global_worker_run set token=null,expires_at=null where singleton and token='"+token+"';commit;")
 assert t.sql("select not(select enabled from private.worker_runtime_atomic_control)and not(select external_deletion_approved from private.member_cleanup_guard)and not(select token is not null from private.global_worker_run);").decode().strip()=='t'
 for signature in SIGNATURES.split(',public.'):
  signature=signature if signature.startswith('public.')else 'public.'+signature
  assert t.sql("select has_function_privilege('service_role','"+signature+"','EXECUTE');").decode().strip()=='f'
 if f.get('evidenceHash'):
  assert evidence(f['taskId'])==f['evidenceHash'],'ACK_OR_DISPATCH_CHANGED'
  f['taskState']=t.sql("select state from private.member_cleanup_tasks where id='"+f['taskId']+"';").decode().strip()
 f['phaseBeforeClose']=f['phase'];f['phase']='closed';save(f);print('RECOVERY_TEST_GATES_CLOSED_ACK_DISPATCH_PRESERVED')
if __name__=='__main__':
 if sys.argv[1:]==['--close']:close()
 elif sys.argv[1:]==['--resume-before-withdrawal']:resume_before_withdrawal()
 elif not sys.argv[1:]:prepare()
 else:raise RuntimeError('INVALID_ACTION')
