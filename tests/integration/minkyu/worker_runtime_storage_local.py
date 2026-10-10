"""SQL102 Storage dispatch/ACK with isolated real file-backend Storage API. No automatic replay."""
import base64,hmac,hashlib,http.client,http.server,json,secrets,ssl,threading,time,urllib.request,urllib.error,uuid
from pathlib import Path
import queue_tls_environment as t
from worker_runtime_atomic_local import state,post
R=t.ROOT;NAME='yumidang-minkyu-runtime103-storage';VOLUME='yumidang-minkyu-runtime103-storage-files'
SIGNATURES='public.execute_worker_runtime_operation(uuid,uuid,text,jsonb),public.get_worker_runtime_operation(uuid),public.read_worker_runtime_recovery(uuid,integer),public.read_worker_runtime_slots(uuid),public.enqueue_report_retention_purges(uuid,integer),public.claim_report_retention_task(uuid,uuid,uuid),public.check_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid),public.get_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid),public.record_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid,text),public.complete_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid,text),public.purge_report_retention_terminal_receipts(uuid,integer),public.begin_report_retention_delete(uuid,uuid,uuid,uuid,uuid,uuid)'
def setup():
 assert NAME not in t.call(t.DOCKER+['ps','-a','--format','{{.Names}}']).decode().splitlines(),'EXISTING_STORAGE_PRESERVED'
 source=json.loads(t.call(t.DOCKER+['inspect','supabase_storage_yumidang-release88-http']))[0]
 env=dict(v.split('=',1)for v in source['Config']['Env']if '='in v);assert env['STORAGE_BACKEND']=='file'
 db=json.loads(t.call(t.DOCKER+['inspect',t.NAME]))[0];ip=db['NetworkSettings']['Networks']['bridge']['IPAddress'];assert ip
 # Extend only owned test certificate SAN to the private Docker IP; retain strict verification.
 p=R/'storage-server.ext';p.write_text((R/'server.ext').read_text().replace('IP:127.0.0.1','IP:127.0.0.1,IP:'+ip));p.chmod(0o600)
 t.call(['openssl','x509','-req','-in',str(R/'server.csr'),'-CA',str(R/'ca.crt'),'-CAkey',str(R/'ca.key'),'-CAcreateserial','-out',str(R/'server.crt'),'-days','2','-extfile',str(p)])
 t.call(t.DOCKER+['cp',str(R/'server.crt'),t.NAME+':/tmp/server.crt']);t.call(t.DOCKER+['exec','--user','root',t.NAME,'chown','postgres:postgres','/tmp/server.crt'])
 password=secrets.token_urlsafe(36)
 t.sql("alter role supabase_storage_admin password '"+password+"';select pg_reload_conf();")
 t.call(t.DOCKER+['exec',t.NAME,'sh','-c',"printf 'local all all trust\nhostssl all yumidang_queue_tls_login,authenticator,supabase_storage_admin 0.0.0.0/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\n' > /tmp/queue-data/pg_hba.conf"]);t.sql('select pg_reload_conf();')
 env['DATABASE_URL']=f'postgresql://supabase_storage_admin:{password}@{ip}:5432/postgres?sslmode=verify-full&sslrootcert=/ca.crt'
 env['NODE_EXTRA_CA_CERTS']='/ca.crt';env['ENABLE_IMAGE_TRANSFORMATION']='false';env['S3_PROTOCOL_ENABLED']='false';env.pop('IMGPROXY_URL',None)
 private=R/'storage-private.env';private.write_text('\n'.join(k+'='+v for k,v in env.items()));private.chmod(0o600)
 t.call(t.DOCKER+['volume','create',VOLUME])
 t.call(t.DOCKER+['create','--name',NAME,'--label','yumidang.owner=minkyu','-p','127.0.0.1:61623:5000','--env-file',str(private),'-v',VOLUME+':/mnt',source['Config']['Image']])
 ca=R/'ca.crt';ca.chmod(0o644)
 try:t.call(t.DOCKER+['cp',str(ca),NAME+':/ca.crt'])
 finally:ca.chmod(0o600)
 t.call(t.DOCKER+['start',NAME]);print(json.dumps({'isolatedStorageCreated':NAME,'backend':'file','operatingChanged':False}))
def storage(method,path,data=None,headers=None):
 request=urllib.request.Request('http://127.0.0.1:61623'+path,data=data,method=method,headers={'authorization':'Bearer '+state['SERVICE_ROLE_KEY'],**(headers or {})})
 try:
  with urllib.request.urlopen(request,timeout=10)as r:return r.status,r.read()
 except urllib.error.HTTPError as e:return e.code,e.read()
def run():
 for _ in range(40):
  try:
   code,_=storage('GET','/status')
   if code==200:break
  except (OSError,http.client.HTTPException):pass
  time.sleep(.25)
 else:raise RuntimeError('ISOLATED_STORAGE_NOT_READY')
 calls={'DELETE':0,'ACK':0}
 class Proxy(http.server.BaseHTTPRequestHandler):
  def do_POST(self):self.forward('POST')
  def do_DELETE(self):self.forward('DELETE')
  def forward(self,method):
   is_storage=self.path.startswith('/storage/');path=self.path.removeprefix('/storage')if is_storage else self.path
   conn=http.client.HTTPConnection('127.0.0.1',61623 if is_storage else 61621,timeout=15)
   try:
    body=self.rfile.read(int(self.headers.get('content-length','0')))
    if is_storage and method=='DELETE':calls['DELETE']+=1
    if not is_storage and b'report_delete_ack'in body:calls['ACK']+=1
    conn.request(method,path,body,{'authorization':self.headers['authorization'],'content-type':self.headers.get('content-type','application/json')})
    response=conn.getresponse();value=response.read()
    if self.headers.get('x-test-drop')=='yes':self.close_connection=True;return
    self.send_response(response.status);self.send_header('content-type','application/json');self.send_header('content-length',str(len(value)));self.end_headers();self.wfile.write(value)
   finally:conn.close()
  def log_message(self,*args):pass
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Proxy);ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(str(R/'server.crt'),str(R/'server.key'));server.socket=ctx.wrap_socket(server.socket,server_side=True)
 thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();base=f'https://127.0.0.1:{server.server_port}'
 token=str(uuid.uuid4());members=[str(uuid.uuid4())for _ in range(2)];reports=[str(uuid.uuid4())for _ in range(2)];assets=[str(uuid.uuid4())for _ in range(3)]
 report_by_asset=[reports[0],reports[0],reports[1]];paths=[members[0]+'/'+a+'.png'for a in assets]
 png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF3sAAAAASUVORK5CYII=')
 def rpc(name,args):
  code,value=post(base+'/rpc/'+name,args,state['SERVICE_ROLE_KEY']);assert code==200,(name,code,value.get('code')if isinstance(value,dict)else'type');return value
 def execute(op,args,request_id=None):return rpc('execute_worker_runtime_operation',{'p_request_id':request_id or str(uuid.uuid4()),'p_global_token':token,'p_operation':op,'p_input':args})
 try:
  # Prior failed synthetic fixtures are excluded; production/source data is never touched.
  t.sql("update private.member_reports set final_closed_at=now()+interval'100 years',retention_due_at=now()+interval'100 years'+interval'2160 hours'where reporter_id in(select id from auth.users where email like 'runtime103-%@test.invalid')and not exists(select 1 from private.worker_jobs j where j.payload->>'reportId'=private.member_reports.id::text);")
  sql=''
  for m in members:sql+="insert into auth.users(id,email)values('"+m+"','runtime103-"+m+"@test.invalid');insert into public.profiles(id,real_name,birth_date,gender)values('"+m+"','합성회원','1990-01-01','female');"
  for r in reports:sql+="insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,status,hide_target,fingerprint,final_closed_at,retention_due_at)select '"+r+"','"+members[0]+"',id,gen_random_uuid(),'member','"+members[1]+"','online',array['other'],'resolved',false,repeat('a',64),now()-interval'100 years',now()-interval'100 years'+interval'2160 hours'from private.member_episodes where profile_id='"+members[0]+"'and ended_at is null;"
  t.sql(sql)
  for a,r,path in zip(assets,report_by_asset,paths):
   code,_=storage('POST','/object/report-evidence/'+path,png,{'content-type':'image/png'});assert code==200,'UPLOAD_FAILED'
   t.sql("update storage.objects set owner_id='"+members[0]+"'where bucket_id='report-evidence'and name='"+path+"';insert into private.report_capture_assets(id,owner_id,owner_episode_id,object_name,state,report_id,uploaded_at)select '"+a+"','"+members[0]+"',id,'"+path+"','attached','"+r+"',clock_timestamp()from private.member_episodes where profile_id='"+members[0]+"'and ended_at is null;")
  t.sql("update private.worker_runtime_atomic_control set enabled=true;update private.report_purge_control set enabled=true;update private.global_worker_run set token='"+token+"',expires_at=clock_timestamp()+interval'180 seconds'where singleton;grant execute on function "+SIGNATURES+" to service_role;notify pgrst,'reload schema';")
  time.sleep(.2);assert execute('due_enqueue',{'kind':'report_retention','limit':20})['result']['enqueued']>=2
  t.sql("update private.worker_jobs set available_at=clock_timestamp()-interval'100 years'where kind='report_retention'and payload->>'reportId'in('"+"','".join(reports)+"');")
  pending_request=None;successful_children=0
  for _ in range(2):
   job=execute('job_claim',{'workerId':members[0],'leaseSeconds':180,'supportedKinds':['report_retention']})['result']['job'];assert job is not None
   job_id=job['jobId'];job_lease=job['leaseToken'];report_id=job['payload']['reportId'];assert report_id in reports
   n=2 if report_id==reports[0]else 1
   for child in range(n):
    claimed=execute('report_task_claim',{'jobId':job_id,'jobLeaseToken':job_lease})['result'];assert claimed['kind']=='storage_object'and 'objectName'not in claimed
    fence={'taskId':claimed['taskId'],'taskLeaseToken':claimed['taskLeaseToken'],'jobId':job_id,'jobLeaseToken':job_lease,'objectId':claimed['objectId']}
    task=rpc('check_report_retention_task',{'p_task_id':fence['taskId'],'p_task_lease_token':fence['taskLeaseToken'],'p_job_id':job_id,'p_job_lease_token':job_lease,'p_global_token':token,'p_object_id':fence['objectId']})
    request_id=str(uuid.uuid4());begin=execute('report_delete_begin',fence,request_id);assert begin['replayed']is False and begin['result']['alreadyApplied']is False
    uncertain=report_id==reports[0]and child==0
    request=urllib.request.Request(base+'/storage/object/report-evidence',data=json.dumps({'prefixes':[task['objectName']]}).encode(),method='DELETE',headers={'authorization':'Bearer '+state['SERVICE_ROLE_KEY'],'content-type':'application/json',**({'x-test-drop':'yes'}if uncertain else {})})
    try:
     with urllib.request.urlopen(request,context=ssl.create_default_context(cafile=str(R/'ca.crt')),timeout=10)as response:assert response.status==200;response.read()
     assert not uncertain
    except http.client.RemoteDisconnected:assert uncertain
    absence_code,absence_body=storage('GET','/object/authenticated/report-evidence/'+task['objectName'])
    absence=json.loads(absence_body);assert absence_code in(400,404)and (absence.get('statusCode')in('404',404)or absence.get('error')in('not_found','Not Found')),'ABSENCE_NOT_PROVEN'
    if uncertain:
     before=dict(calls);again=execute('report_delete_begin',fence,request_id);assert again['replayed']is True
     assert calls==before;pending_request=request_id
     # Existing claim fence must not re-dispatch this uncertain task.
    else:
     ack_input={**fence,'ackSha256':hashlib.sha256(json.dumps({'taskId':fence['taskId'],'objectId':fence['objectId']}).encode()).hexdigest()}
     if successful_children==0:
      ack_request=str(uuid.uuid4());lost=False
      try:post(base+'/rpc/execute_worker_runtime_operation',{'p_request_id':ack_request,'p_global_token':token,'p_operation':'report_delete_ack','p_input':ack_input},state['SERVICE_ROLE_KEY'],drop=True)
      except http.client.RemoteDisconnected:lost=True
      assert lost
      ack_result=rpc('get_worker_runtime_operation',{'p_request_id':ack_request});assert ack_result['state']=='completed'and ack_result['result']['ackSha256']==ack_input['ackSha256']
     else:execute('report_delete_ack',ack_input)
     completed=execute('report_task_complete',{**fence,'evidenceSha256':hashlib.sha256(json.dumps(fence,sort_keys=True).encode()).hexdigest()});assert completed['result']['status']=='completed';successful_children+=1
   if report_id==reports[1]:
    metadata=execute('report_task_claim',{'jobId':job_id,'jobLeaseToken':job_lease})['result'];assert metadata['kind']=='report_metadata'
    final=execute('report_task_complete',{'taskId':metadata['taskId'],'taskLeaseToken':metadata['taskLeaseToken'],'jobId':job_id,'jobLeaseToken':job_lease,'objectId':None,'evidenceSha256':hashlib.sha256(metadata['taskId'].encode()).hexdigest()});assert final['result']['status']=='completed'
   assert rpc('read_worker_runtime_slots',{'p_global_token':token})['used']<=2
  assert pending_request is not None and successful_children==2 and calls=={'DELETE':3,'ACK':2}
  rows=rpc('read_worker_runtime_recovery',{'p_after_request_id':None,'p_limit':20})['pending'];assert any(r['requestId']==pending_request for r in rows)
  assert rpc('get_worker_runtime_operation',{'p_request_id':pending_request})['state']=='external_pending'
  t.sql("update private.worker_runtime_results set created_at=clock_timestamp()-interval'1 year'where request_id='"+pending_request+"';")
  receipt={'realIsolatedStorage':'PASS','actualDeletes':3,'actualAcks':2,'uncertainDeleteExtraTransmissions':0,'uncertainAckExtraTransmissions':0,'twoAttachmentsOneQueueJob':True,'successfulReportFinalization':True,'unknownRetainedForRecovery':True,'operatingChanged':False}
  p=R/'storage-atomic-receipt.json';p.write_text(json.dumps(receipt));p.chmod(0o600);print(json.dumps(receipt))
 finally:
  t.sql("update private.worker_runtime_atomic_control set enabled=false;update private.report_purge_control set enabled=false;revoke execute on function "+SIGNATURES+" from service_role;update private.global_worker_run set token=null,expires_at=null where singleton and token='"+token+"';")
  server.shutdown();server.server_close();thread.join()
if __name__=='__main__':
 import sys
 if sys.argv[1:]==['--setup']:setup()
 else:run()
