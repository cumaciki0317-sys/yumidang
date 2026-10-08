"""고정 민규 합성 환경의 응답 유실·경쟁·기존 소비자 검증. 키/원문 출력 없음."""
import base64,concurrent.futures,http.server,json,runpy,secrets,subprocess,sys,threading,urllib.request,urllib.error,uuid
from pathlib import Path
REPO=Path(__file__).resolve().parents[3];STATE=Path('/private/tmp/yumidang-runner-recovery99');STATE.mkdir(mode=0o700,exist_ok=True)
s=json.loads(Path('/private/tmp/yumidang-release88-http-isolated/status-private.json').read_text());assert s['API_URL']=='http://127.0.0.1:59621'
BASE=['docker','--host','unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock','exec','-i','supabase_db_yumidang-release88-http','psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
def sql(q):
 r=subprocess.run(BASE,input=q,text=True,capture_output=True,timeout=90)
 if r.returncode:(STATE/'sql-error-private.log').write_text(r.stderr);raise RuntimeError('LOCAL_SQL_FAILED')
 return r.stdout.strip()
def rpc(name,body):
 req=urllib.request.Request(s['API_URL']+'/rest/v1/rpc/'+name,data=json.dumps(body).encode(),headers={'authorization':'Bearer '+s['SERVICE_ROLE_KEY'],'apikey':s['SERVICE_ROLE_KEY'],'content-type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=30)as r:return r.status,json.loads(r.read())
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
def helpful_lost_response(f):
 payload={**f['payload'],'clientRequestId':'lost-helpful-'+str(uuid.uuid4())}
 class Lost(http.server.BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def do_POST(self):
   req=urllib.request.Request('http://127.0.0.1:59641/functions/v1/ai-chat/feedback',data=self.rfile.read(int(self.headers['content-length'])),headers={'authorization':self.headers['authorization'],'content-type':'application/json'},method='POST')
   with urllib.request.urlopen(req,timeout=30)as response:assert response.status==200;response.read()
   self.close_connection=True
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Lost);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 try:
  req=urllib.request.Request('http://127.0.0.1:'+str(server.server_port)+'/feedback',data=json.dumps(payload).encode(),headers={'authorization':'Bearer '+f['TOKENS'][1],'content-type':'application/json'},method='POST')
  try:urllib.request.urlopen(req,timeout=30);raise AssertionError('AI_RESPONSE_NOT_DROPPED')
  except (urllib.error.URLError,__import__('http').client.RemoteDisconnected):pass
  persisted=sql("select feedback_id from private.ai_feedback_receipts where user_id='"+f['uid'](1)+"'and client_hash=encode(sha256(convert_to('"+payload['clientRequestId']+"','UTF8')),'hex');")
  assert persisted
  with concurrent.futures.ThreadPoolExecutor(max_workers=6)as pool:replies=list(pool.map(lambda _:f['ai_request'](payload),range(6)))
  assert all(code==200 and body['data']['feedbackId']==persisted for code,body in replies)
  assert len({json.dumps(body['data'],sort_keys=True)for _,body in replies})==1
 finally:server.shutdown();server.server_close();thread.join()
 (STATE/'helpful-response-loss-receipt.json').write_text(json.dumps({'actualTcpResponseLostAfterCommit':True,'retrySixSameFeedbackId':True}))
 return payload
if '--acquire' in sys.argv:
 code,body=rpc('acquire_worker_run',{'p_lease_seconds':180,'p_existing_token':None});assert code==200;print(json.dumps(body));raise SystemExit()
# Reuse the current actual member/Storage flow, not a separate fake authentication implementation.
sql("delete from public.chat_messages where content='응답 유실 합성 메시지'and sender_id='fda10000-0000-4000-8000-000000000002';")
f=runpy.run_path(str(REPO/'tests/integration/minkyu/additional_backend_local.py'));receipt={}
if '--helpful-loss-only'in sys.argv:
 helpful_lost_response(f);print('actual AI HTTP response-loss/replay PASS');raise SystemExit()
# Two OS processes compete for the real singleton through two actual HTTP connections.
assert sql('select count(*)from private.global_worker_run where token is not null and expires_at>clock_timestamp();')=='0'
with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:
 def acquire(_):return json.loads(subprocess.run([sys.executable,__file__,'--acquire'],capture_output=True,text=True,check=True).stdout)
 outcomes=list(pool.map(acquire,range(2)))
winners=[x for x in outcomes if x];assert len(winners)==1
winner=winners[0];assert rpc('release_worker_run',{'p_token':winner['token']})[0]==200
code,_=rpc('read_worker_run_budget',{'p_worker_run_token':winner['token']});assert code in(403,409)
sql("begin;select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);do $$begin begin perform public.read_worker_run_budget('"+winner['token']+"');raise exception 'stale_accepted';exception when sqlstate '40001'then null;end;end;$$;rollback;")
receipt['twoProcessGlobalCompetition']='PASS';receipt['staleGlobalTokenRejected']='PASS'
# Actual TCP response loss: upstream commit happens, then the test proxy closes without a response.
class Drop(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  body=self.rfile.read(int(self.headers['content-length']))
  req=urllib.request.Request('http://127.0.0.1:59642/functions/v1/service-api'+self.path,data=body,headers={'authorization':self.headers['authorization'],'content-type':'application/json'},method='POST')
  with urllib.request.urlopen(req,timeout=30)as response:assert response.status==200;response.read()
  self.close_connection=True
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Drop);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
try:
 msg=str(uuid.uuid4());f['checked'](f['path']+'/messages',2,{'messageId':msg,'content':'응답 유실 합성 메시지'},'POST')
 req=urllib.request.Request('http://127.0.0.1:'+str(server.server_port)+f['path']+'/read',data=json.dumps({'lastReadMessageId':msg}).encode(),headers={'authorization':'Bearer '+f['TOKENS'][1],'content-type':'application/json'},method='POST')
 try:urllib.request.urlopen(req,timeout=30);raise AssertionError('RESPONSE_NOT_DROPPED')
 except (urllib.error.URLError,__import__('http').client.RemoteDisconnected):pass
 a=f['checked'](f['path']+'/read',1,{'lastReadMessageId':msg},'POST');b=f['checked'](f['path']+'/read',1,{'lastReadMessageId':msg},'POST');assert a==b and a['last_read_message_id']==msg
 receipt['readCommittedResponseLostReplay']='PASS'
finally:
 server.shutdown();server.server_close();thread.join()
 sql("delete from public.chat_messages where id='"+msg+"'and sender_id='"+f['uid'](2)+"';")
 f['checked'](f['path']+'/read',1,{'lastReadMessageId':f['later']},'POST')
# AI helpful response loss occurs after the existing J handler has committed acceptance.
payload=helpful_lost_response(f);receipt['helpfulCommittedResponseLostReplaySix']='PASS'
# Race expired helpful purge with new/replayed requests. Expiry data is synthetic and preserved as expired.
expired=str(uuid.uuid4());sql("insert into private.ai_chat_requests select (jsonb_populate_record(null::private.ai_chat_requests,to_jsonb(r)||jsonb_build_object('request_id','"+expired+"','client_request_hash',encode(sha256(convert_to('"+expired+"','UTF8')),'hex'),'lease_token','"+str(uuid.uuid4())+"'))).*from private.ai_chat_requests r where request_id='"+f['ai_id']+"';insert into private.ai_result_receipts(request_id,user_id,available_at)values('"+expired+"','"+f['uid'](1)+"',clock_timestamp()-interval'91 days');")
with concurrent.futures.ThreadPoolExecutor(max_workers=3)as pool:
 def race(n):
  if n==0:return rpc('purge_expired_ai_feedback',{'p_limit':100})[0]
  return f['ai_request']({**payload,'requestId':expired,'clientRequestId':'expired-'+str(n)})[0]
 results=list(pool.map(race,range(3)))
assert results==[200,404,404];receipt['helpfulExpiryPurgeRace']='PASS'
# Fresh native Naver-qualified synthetic members have no pending appointment history.
prefix=uuid.uuid4().hex[:8];session_prefix=uuid.uuid4().hex[:8];photo_prefix=uuid.uuid4().hex[:8];subject='worker-recovery-'+prefix+'-'
prelude=(REPO/'tests/database/minkyu/assigned_report_notice_receipts.sql').read_text().split('insert into auth.users(id,email)values(pg_temp.safety_uid(3)')[0]
prelude=prelude.replace('fe910000',prefix).replace('fe920000',session_prefix).replace('fe930000',photo_prefix).replace('review-start-sql-',subject)
sql(prelude+'commit;')
worker_uid=lambda n:prefix+'-0000-4000-8000-'+str(n).zfill(12)
# Temporary local capabilities. Snapshot and restore exact ACLs/control values in finally.
names=['enqueue_report_retention_purges','claim_report_retention_task','check_report_retention_task','get_report_retention_delete_ack','record_report_retention_delete_ack','complete_report_retention_task','purge_report_retention_terminal_receipts','begin_report_retention_delete','claim_supported_job','read_worker_run_budget','enqueue_cancellation_safety_due','process_cancellation_safety_due','claim_member_cleanup_task','check_member_cleanup_task','get_member_cleanup_delete_ack','record_member_cleanup_delete_ack','complete_member_cleanup_task']
functions=json.loads(sql("select json_agg(json_build_object('signature',p.oid::regprocedure::text,'granted',has_function_privilege('service_role',p.oid,'EXECUTE')))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname=any(array"+str(names).replace('"',"'")+"::text[]);"))
guards=json.loads(sql("select json_build_object('report',(select enabled from private.report_purge_control where singleton),'cancel',(select enabled from private.cancellation_due_control where singleton));"));assert guards=={'report':False,'cancel':False}
(STATE/'capability-restore.json').write_text(json.dumps({'functions':functions,'guards':guards}));(STATE/'capability-restore.json').chmod(0o600)
def consumer(kind,mode='success',report_id=None):
 (STATE/'consumer-input.json').write_text(json.dumps({'kind':kind,'reportId':report_id}))
 command=['/opt/homebrew/bin/deno','run','--config',str(REPO/'backend/supabase/functions/deno.json'),'--allow-net=127.0.0.1:59621','--allow-read=/private/tmp/yumidang-runner-recovery99,/private/tmp/yumidang-release88-http-isolated/status-private.json','--allow-write=/private/tmp/yumidang-runner-recovery99',str(REPO/'tests/integration/minkyu/safety_consumers_local.ts'),mode]
 r=subprocess.run(command,capture_output=True,text=True,timeout=120);(STATE/'consumer-private.log').write_text(r.stdout+r.stderr)
 if r.returncode:raise RuntimeError('CONSUMER_FAILED_READ_PRIVATE_LOG')
 return json.loads((STATE/('consumer-'+mode+'-'+kind+'.json')).read_text())
try:
 sql('begin;'+''.join('grant execute on function '+x['signature']+' to service_role;'for x in functions)+'update private.report_purge_control set enabled=true;update private.cancellation_due_control set enabled=true;commit;')
 # Real Auth JWT for a separate synthetic member; race helpful acceptance against retirement.
 retiring=worker_uid(1);password=secrets.token_urlsafe(30)
 email=sql("select email from auth.users where id='"+retiring+"';")
 sql("update auth.users set instance_id='00000000-0000-0000-0000-000000000000',aud='authenticated',role='authenticated',created_at=clock_timestamp(),updated_at=clock_timestamp(),email_confirmed_at=clock_timestamp(),confirmation_token='',recovery_token='',email_change_token_new='',email_change='',email_change_token_current='',phone_change='',phone_change_token='',reauthentication_token='',encrypted_password=crypt('"+password+"',gen_salt('bf'))where id='"+retiring+"';")
 req=urllib.request.Request(s['API_URL']+'/auth/v1/token?grant_type=password',data=json.dumps({'email':email,'password':password}).encode(),headers={'apikey':s['ANON_KEY'],'content-type':'application/json'})
 with urllib.request.urlopen(req,timeout=30)as response:session=json.loads(response.read())
 token=session['access_token'];claims=json.loads(base64.urlsafe_b64decode(token.split('.')[1]+'=='))
 assert rpc('record_naver_session',{'p_subject':subject+'1','p_user_id':retiring,'p_session_id':claims['session_id']})[0]==200
 f['TOKENS'][4]=token;request_id=str(uuid.uuid4());lease=str(uuid.uuid4())
 sql("insert into private.ai_member_processing(user_id,active_request_id)values('"+retiring+"','"+request_id+"');insert into private.ai_chat_requests(request_id,user_id,client_request_hash,lease_token,expires_at)values('"+request_id+"','"+retiring+"',repeat('d',64),'"+lease+"',clock_timestamp()+interval'3 minutes');")
 assert rpc('record_ai_chat_result_available',{'p_user_id':retiring,'p_request_id':request_id,'p_lease_token':lease})[0]==200
 assert rpc('finish_ai_chat_request',{'p_user_id':retiring,'p_request_id':request_id,'p_lease_token':lease,'p_outcome':'finished'})[0]==200
 helpful={'clientRequestId':str(uuid.uuid4()),'requestId':request_id,'action':'helpful'};assert f['ai_request'](helpful,4)[0]==200
 def retire():
  req=urllib.request.Request(s['API_URL']+'/rest/v1/rpc/retire_my_account',data=json.dumps({'p_withdrawal_id':str(uuid.uuid4())}).encode(),headers={'apikey':s['ANON_KEY'],'authorization':'Bearer '+token,'content-type':'application/json'})
  try:
   with urllib.request.urlopen(req,timeout=30)as response:response.read();return response.status
  except urllib.error.HTTPError as error:return error.code
 sql('update private.member_cleanup_guard set external_deletion_approved=true;')
 try:
  with concurrent.futures.ThreadPoolExecutor(max_workers=3)as pool:
   results=list(pool.map(lambda n:retire()if n==0 else f['ai_request'](helpful,4)[0],range(3)))
  assert results[0]==200 and all(c in(200,401,403)for c in results[1:])
  assert sql("select count(*)from private.ai_feedback_receipts where user_id='"+retiring+"'and action='helpful';")=='0'
  assert sql("select count(*)from private.ai_result_receipts where user_id='"+retiring+"';")=='0'
 finally:sql('update private.member_cleanup_guard set external_deletion_approved=false;')
 receipt['helpfulRetirementRaceActualJwt']='PASS'
 # Actual uploaded capture/closed AI report produced by the real HTTP path above.
 rid=f['capture_rid']
 op='/operator/reports/'+rid
 started=f['checked'](op+'/review/start',3,{'clientRequestId':str(uuid.uuid4()),'expectedVersion':1},'POST')
 decision=f['checked'](op+'/adjudications',3,{'clientRequestId':str(uuid.uuid4()),'mode':'initial','expectedReportVersion':started['version'],'expectedHoldVersion':None,'expectedIncidentRevision':0,'appointmentOutcome':'unchanged','incidentOutcome':'none','responsibleRole':'none','representativeReasonCode':'no_action','violationClass':'none','violationType':None},'POST')
 f['checked'](op+'/final-closures',3,{'clientRequestId':str(uuid.uuid4()),'expectedReportVersion':decision['version'],'expectedIncidentRevision':0,'resolutionSummary':'합성 소비자 검증 종결'},'POST')
 sql("with t as(select clock_timestamp()-interval'91 days'as c)update private.member_reports set final_closed_at=t.c,retention_due_at=t.c+interval'2160 hours'from t where id='"+rid+"';")
 sql("update private.ai_report_handling_control set enabled=true;")
 try:
  with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:
   running=pool.submit(consumer,'report_retention','success',rid)
   competing=pool.submit(f['ai_request'],f['capture_report'])
   r=running.result();duplicate=competing.result()
  assert duplicate[0]in(200,404)
  assert f['ai_request'](f['capture_report'])[0]==404
 finally:sql("update private.ai_report_handling_control set enabled=false;")
 receipt['reportPurgeReceptionRace']='PASS'
 assert r['deletes']==1 and r['external']==0 and r['status']=='completed'
 assert sql("select count(*)from private.member_reports where id='"+rid+"';")=='0';receipt['actualReportConsumerStorageAckMetadata']='PASS'
 # A synthetic due queue row with no incident exercises the real cancellation reconciliation path.
 identity=sql("select identity_id from private.member_episodes where profile_id='"+worker_uid(2)+"'and ended_at is null;")
 sql("insert into private.cancellation_safety_due(identity_id,next_due_at)values('"+identity+"',clock_timestamp()-interval'500 days')on conflict(identity_id)do update set generation=private.cancellation_safety_due.generation+1,next_due_at=excluded.next_due_at;")
 r=consumer('cancellation_safety');assert r['external']==0 and r['status']=='completed';receipt['actualCancellationConsumer']='PASS'
 # Actual DELETE / ACK response loss, then a new OS process reads preserved state.
 def close_report(rid):
  sql("select private.set_report_operator_assignment('"+f['uid'](3)+"','"+rid+"',true);")
  op='/operator/reports/'+rid
  started=f['checked'](op+'/review/start',3,{'clientRequestId':str(uuid.uuid4()),'expectedVersion':1},'POST')
  decision=f['checked'](op+'/adjudications',3,{'clientRequestId':str(uuid.uuid4()),'mode':'initial','expectedReportVersion':started['version'],'expectedHoldVersion':None,'expectedIncidentRevision':0,'appointmentOutcome':'unchanged','incidentOutcome':'none','responsibleRole':'none','representativeReasonCode':'no_action','violationClass':'none','violationType':None},'POST')
  f['checked'](op+'/final-closures',3,{'clientRequestId':str(uuid.uuid4()),'expectedReportVersion':decision['version'],'expectedIncidentRevision':0,'resolutionSummary':'합성 장애 검증 종결'},'POST')
 for index,mode in enumerate(['drop-delete','drop-ack']):
  asset=str(uuid.uuid4());f['checked']('/report-captures',1,{'assetId':asset,'extension':'png'},'POST')
  name=f['uid'](1)+'/'+asset+'.png'
  req=urllib.request.Request(s['API_URL']+'/storage/v1/object/report-evidence/'+name,data=f['image'],method='POST',headers={'apikey':s['ANON_KEY'],'authorization':'Bearer '+f['TOKENS'][1],'content-type':'image/png'})
  with urllib.request.urlopen(req,timeout=30)as response:assert response.status==200
  f['checked']('/report-captures/'+asset+'/confirm',1,{},'POST')
  report={'clientRequestId':str(uuid.uuid4()),'requestId':f['ai_id'],'action':'report','confirmed':True,'attachment':{'kind':'capture','assetId':asset}}
  sql('update private.ai_report_handling_control set enabled=true;')
  try:code,value=f['ai_request'](report);assert code==200 and value['data']['status']=='accepted'
  finally:sql('update private.ai_report_handling_control set enabled=false;')
  rid=sql("select report_id from private.ai_feedback_receipts where feedback_id='"+value['data']['feedbackId']+"';");close_report(rid)
  days=600+index*100
  sql("with t as(select clock_timestamp()-interval'"+str(days)+" days'as c)update private.member_reports set final_closed_at=t.c,retention_due_at=t.c+interval'2160 hours'from t where id='"+rid+"';")
  first=consumer('report_retention',mode,rid);assert first['status']=='unknown'and first['deletes']==1
  # Advance only this synthetic job/task lease clock; original dispatch/ACK intent remains untouched.
  sql("update private.worker_jobs set lease_expires_at=clock_timestamp()-interval'1 second'where kind='report_retention'and payload->>'reportId'='"+rid+"'and status='running';update private.report_purge_tasks set lease_expires_at=clock_timestamp()-interval'1 second'where closure_id in(select id from private.report_purge_closures where report_id='"+rid+"')and state='running';")
  second=consumer('report_retention','resume-'+mode,rid);assert second['deletes']==0 and second['external']==0
  if mode=='drop-delete':
   assert second['status']=='unknown'and sql("select count(*)from private.member_reports where id='"+rid+"';")=='1'
  else:
   assert second['result']['status']=='completed_by_handler'and sql("select count(*)from private.member_reports where id='"+rid+"';")=='0'
  receipt[mode+'RestartNoExtraDelete']='PASS'
 assert 'unknown'in(STATE/'consumer-journal.jsonl').read_text();receipt['durableTestJournalPreserved']='PASS'
finally:
 sql('begin;'+''.join(('grant execute on function '+x['signature']+' to service_role;'if x['granted']else'revoke all on function '+x['signature']+' from service_role;')for x in functions)+'update private.report_purge_control set enabled=false;update private.cancellation_due_control set enabled=false;commit;')
receipt['capabilitiesRestoredClosed']=True
(STATE/'faults-consumers-receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
