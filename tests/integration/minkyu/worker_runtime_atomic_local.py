"""SQL102/103 actual JWT→HTTPS→DB: loss, concurrency, restart read. Owned scratch only."""
import concurrent.futures,http.client,http.server,json,ssl,threading,urllib.request,urllib.error,uuid,subprocess,sys,time
from pathlib import Path
import queue_tls_environment as tls
R=tls.ROOT
state=json.loads(Path('/private/tmp/yumidang-release88-http-isolated/status-private.json').read_text())
assert state['API_URL']=='http://127.0.0.1:59621'
def post(url,args,token,drop=False):
 headers={'authorization':'Bearer '+token,'content-type':'application/json'}
 if drop:headers['x-test-drop']='yes'
 request=urllib.request.Request(url,data=json.dumps(args).encode(),headers=headers)
 try:
  with urllib.request.urlopen(request,context=ssl.create_default_context(cafile=str(R/'ca.crt')),timeout=15)as r:return r.status,json.loads(r.read())
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
def run():
 class Proxy(http.server.BaseHTTPRequestHandler):
  def do_POST(self):
   conn=http.client.HTTPConnection('127.0.0.1',61621,timeout=15)
   try:
    conn.request('POST',self.path,self.rfile.read(int(self.headers['content-length'])),{'authorization':self.headers['authorization'],'content-type':'application/json'})
    response=conn.getresponse();body=response.read()
    if self.headers.get('x-test-drop')=='yes':self.close_connection=True;return
    self.send_response(response.status);self.send_header('content-type','application/json');self.send_header('content-length',str(len(body)));self.end_headers();self.wfile.write(body)
   finally:conn.close()
  def log_message(self,*args):pass
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Proxy);ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(str(R/'server.crt'),str(R/'server.key'));server.socket=ctx.wrap_socket(server.socket,server_side=True)
 thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();base=f'https://127.0.0.1:{server.server_port}/rpc/'
 rpc=lambda name,args,token=None,drop=False:post(base+name,args,token or state['SERVICE_ROLE_KEY'],drop)
 global_token=str(uuid.uuid4());worker_id=str(uuid.uuid4());job_ids=[str(uuid.uuid4())for _ in range(3)];request_ids=[str(uuid.uuid4())for _ in range(3)]
 signatures='public.execute_worker_runtime_operation(uuid,uuid,text,jsonb),public.get_worker_runtime_operation(uuid),public.read_worker_runtime_slots(uuid),public.read_worker_runtime_retention_schedule(),public.purge_worker_runtime_details(uuid,integer),public.read_worker_runtime_recovery(uuid,integer)'
 def args(request_id):return{'p_request_id':request_id,'p_global_token':global_token,'p_operation':'job_claim','p_input':{'workerId':worker_id,'leaseSeconds':180,'supportedKinds':['review_summary']}}
 try:
  assert rpc('read_worker_runtime_slots',{'p_global_token':global_token})[0]in(401,403)
  sql="update private.worker_runtime_atomic_control set enabled=true where singleton;grant execute on function "+signatures+" to service_role;update private.global_worker_run set token='"+global_token+"',expires_at=clock_timestamp()+interval'180 seconds'where singleton;notify pgrst,'reload schema';"
  for job_id in job_ids:sql+="insert into private.worker_jobs(id,kind,dedupe_key,payload,available_at)values('"+job_id+"','review_summary','atomic103:"+job_id+"','{\"profileId\":\""+worker_id+"\",\"sourceRevision\":\"0\",\"modelVersion\":\"synthetic\",\"promptVersion\":\"synthetic\"}',clock_timestamp()-interval'100 years');"
  tls.sql(sql);time.sleep(.2)
  lost=False
  try:rpc('execute_worker_runtime_operation',args(request_ids[0]),drop=True)
  except http.client.RemoteDisconnected:lost=True
  assert lost
  with concurrent.futures.ThreadPoolExecutor(max_workers=6)as pool:rows=list(pool.map(lambda _:rpc('execute_worker_runtime_operation',args(request_ids[0])),range(6)))
  assert all(code==200 for code,_ in rows);result=rows[0][1];assert all(v==result for _,v in rows)and result['replayed']is True
  claimed=result['result']['job']['jobId'];assert claimed in job_ids
  assert rpc('read_worker_runtime_slots',{'p_global_token':global_token})[1]=={'used':1,'remaining':19}
  # Actual second process read: no mutation or receipt recreation.
  checked=subprocess.run([sys.executable,__file__,'--probe',base,request_ids[0]],capture_output=True,timeout=20)
  assert checked.returncode==0 and json.loads(checked.stdout)==result,'RESTART_READ_FAILED'
  changed=args(request_ids[0]);changed['p_input']={**changed['p_input'],'workerId':str(uuid.uuid4())}
  code,value=rpc('execute_worker_runtime_operation',changed);assert code>=400 and value.get('code')=='40001'
  assert rpc('execute_worker_runtime_operation',args(str(uuid.uuid4())),state['ANON_KEY'])[0]in(401,403)
  tls.sql("insert into private.worker_runtime_job_slots(global_token,job_id)select '"+global_token+"',gen_random_uuid()from generate_series(1,18);")
  with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:last=list(pool.map(lambda i:rpc('execute_worker_runtime_operation',args(request_ids[i])),[1,2]))
  assert all(code==200 for code,_ in last);assert sum(v['result']['job']is not None for _,v in last)==1
  assert rpc('read_worker_runtime_slots',{'p_global_token':global_token})[1]=={'used':20,'remaining':0}
  # Same request after global expiry remains read-only; new work is rejected.
  tls.sql("update private.global_worker_run set expires_at=clock_timestamp()-interval'1 second'where singleton;")
  assert rpc('execute_worker_runtime_operation',args(request_ids[0]))[1]==result
  code,value=rpc('execute_worker_runtime_operation',args(str(uuid.uuid4())));assert code>=400 and value.get('code')=='40001'
  receipt={'atomicHttpsJwt':'PASS','lostAfterCommitSixRetriesOneClaim':True,'newProcessSameResult':True,'lastSlotTwoRequestsOneWinner':True,'sameInputStableAfterExpiry':True,'differentInputAndAnonDenied':True,'automaticDeleteAckReplay':0,'operatingChanged':False}
  p=R/'atomic-http-receipt.json';p.write_text(json.dumps(receipt));p.chmod(0o600);print(json.dumps(receipt))
 finally:
  tls.sql("update private.worker_runtime_atomic_control set enabled=false where singleton;revoke execute on function "+signatures+" from service_role;update private.global_worker_run set token=null,expires_at=null where singleton and token='"+global_token+"';")
  server.shutdown();server.server_close();thread.join()
if __name__=='__main__':
 if sys.argv[1:2]==['--probe']:
  code,value=post(sys.argv[2]+'get_worker_runtime_operation',{'p_request_id':sys.argv[3]},state['SERVICE_ROLE_KEY']);assert code==200;print(json.dumps(value))
 else:run()
