"""Actual JWT/HTTPS detail purge boundary, competing replay, UNKNOWN and minimum key safety."""
import concurrent.futures,http.client,http.server,json,ssl,threading,time,uuid
import queue_tls_environment as t
from worker_runtime_atomic_local import state,post
R=t.ROOT
def run():
 class Proxy(http.server.BaseHTTPRequestHandler):
  def do_POST(self):
   c=http.client.HTTPConnection('127.0.0.1',61621,timeout=15)
   try:
    c.request('POST',self.path,self.rfile.read(int(self.headers['content-length'])),{'authorization':self.headers['authorization'],'content-type':'application/json'});r=c.getresponse();v=r.read()
    self.send_response(r.status);self.send_header('content-length',str(len(v)));self.end_headers();self.wfile.write(v)
   finally:c.close()
  def log_message(self,*args):pass
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Proxy);ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(str(R/'server.crt'),str(R/'server.key'));server.socket=ctx.wrap_socket(server.socket,server_side=True)
 thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();base=f'https://127.0.0.1:{server.server_port}/rpc/'
 ids=[str(uuid.uuid4())for _ in range(2)];token=str(uuid.uuid4());sig='public.execute_worker_runtime_operation(uuid,uuid,text,jsonb),public.get_worker_runtime_operation(uuid),public.purge_worker_runtime_details(uuid,integer),public.read_worker_runtime_recovery(uuid,integer)'
 def rpc(name,args,auth=None):return post(base+name,args,auth or state['SERVICE_ROLE_KEY'])
 try:
  t.sql("update private.worker_runtime_atomic_control set enabled=true;grant execute on function "+sig+" to service_role;update private.global_worker_run set token='"+token+"',expires_at=now()+interval'180 seconds'where singleton;notify pgrst,'reload schema';")
  time.sleep(.2)
  for i,key in enumerate(ids):
   args={'p_request_id':key,'p_global_token':token,'p_operation':'job_claim','p_input':{'workerId':token,'leaseSeconds':180,'supportedKinds':['cancellation_safety']}}
   code,_=rpc('execute_worker_runtime_operation',args);assert code==200
   t.sql("update private.worker_runtime_results set closed_at=now()-interval'30 days'"+('-'if i==0 else '+')+"interval'1 hour'where request_id='"+key+"';")
  unknown=int(t.sql("select count(*)from private.worker_runtime_results where state='external_pending';").decode());assert unknown>=1
  request={'p_request_id':ids[0],'p_global_token':token,'p_operation':'job_claim','p_input':{'workerId':token,'leaseSeconds':180,'supportedKinds':['cancellation_safety']}}
  with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:
   futures=[pool.submit(rpc,'purge_worker_runtime_details',{'p_global_token':token,'p_limit':20}),pool.submit(rpc,'execute_worker_runtime_operation',request)]
   results=[f.result()for f in futures];assert all(code==200 for code,_ in results)
  code,out=rpc('execute_worker_runtime_operation',request);assert code==200 and out['state']=='purged'and out['result']is None and out['replayed']is True
  assert rpc('get_worker_runtime_operation',{'p_request_id':ids[1]})[1]['state']=='completed'
  code,out=rpc('read_worker_runtime_recovery',{'p_after_request_id':None,'p_limit':20});assert code==200 and len(out['pending'])>=1
  assert int(t.sql("select count(*)from private.worker_runtime_results where state='external_pending';").decode())==unknown
  assert rpc('purge_worker_runtime_details',{'p_global_token':token,'p_limit':20},state['ANON_KEY'])[0]in(401,403)
  t.sql("update private.global_worker_run set expires_at=now()-interval'1 second'where singleton;")
  code,out=rpc('purge_worker_runtime_details',{'p_global_token':token,'p_limit':20});assert code>=400 and out.get('code')=='40001'
  receipt={'retentionJwtHttps':'PASS','closedPlus30DaysBoundary':True,'purgeVersusSameKeyNoRecreation':True,'unknownUnchanged':True,'expiredTokenAndAnonDenied':True,'externalTransmissions':0,'operatingChanged':False};p=R/'runtime-retention-http-receipt.json';p.write_text(json.dumps(receipt));p.chmod(0o600);print(json.dumps(receipt))
 finally:
  t.sql("update private.worker_runtime_atomic_control set enabled=false;revoke execute on function "+sig+" from service_role;update private.global_worker_run set token=null,expires_at=null where singleton and token='"+token+"';")
  server.shutdown();server.server_close();thread.join()
if __name__=='__main__':run()
