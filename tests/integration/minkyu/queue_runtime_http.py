"""전용 TLS DB + 실제 PostgREST JWT + HTTPS의 intent 응답 유실/경쟁 검증."""
import concurrent.futures,http.client,http.server,importlib.util,json,secrets,ssl,subprocess,threading,urllib.request,urllib.error,uuid,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('tls',Path(__file__).with_name('queue_tls_environment.py'));tls=importlib.util.module_from_spec(spec);spec.loader.exec_module(tls)
R=tls.ROOT;REST='yumidang-minkyu-queue-rest101'
state=json.loads(Path('/private/tmp/yumidang-release88-http-isolated/status-private.json').read_text());assert state['API_URL']=='http://127.0.0.1:59621'
def setup():
 assert REST not in tls.call(tls.DOCKER+['ps','-a','--format','{{.Names}}']).decode().splitlines(),'EXISTING_REST_PRESERVED'
 source=json.loads(tls.call(tls.DOCKER+['inspect','supabase_rest_yumidang-release88-http']))[0]
 env=dict(x.split('=',1)for x in source['Config']['Env']if '='in x);jwt=env['PGRST_JWT_SECRET']
 target=json.loads(tls.call(tls.DOCKER+['inspect',tls.NAME]))[0];ip=target['NetworkSettings']['Networks']['bridge']['IPAddress'];assert ip
 password=secrets.token_urlsafe(36)
 tls.sql("alter role authenticator password '"+password+"';")
 tls.call(tls.DOCKER+['exec',tls.NAME,'sh','-c',"printf 'local all all trust\nhostssl all yumidang_queue_tls_login,authenticator 0.0.0.0/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\n' > /tmp/queue-data/pg_hba.conf"]);tls.sql('select pg_reload_conf();')
 config={'PGRST_DB_URI':f'postgresql://authenticator:{password}@localhost:5432/postgres?hostaddr={ip}&sslmode=verify-full&sslrootcert=/ca.crt','PGRST_DB_SCHEMAS':'public','PGRST_DB_ANON_ROLE':'anon','PGRST_JWT_SECRET':jwt,'PGRST_SERVER_PORT':'3000'}
 p=R/'rest-private.env';p.write_text('\n'.join(k+'='+v for k,v in config.items()));p.chmod(0o600)
 tls.call(tls.DOCKER+['create','--name',REST,'--label','yumidang.owner=minkyu','-p','127.0.0.1:61621:3000','--env-file',str(p),'public.ecr.aws/supabase/postgrest:v16.1'])
 ca=R/'ca.crt';ca.chmod(0o644)
 try:tls.call(tls.DOCKER+['cp',str(ca),REST+':/ca.crt'])
 finally:ca.chmod(0o600)
 tls.call(tls.DOCKER+['start',REST])
def run():
 class Proxy(http.server.BaseHTTPRequestHandler):
  def do_POST(self):
   length=int(self.headers['content-length']);data=self.rfile.read(length)
   conn=http.client.HTTPConnection('127.0.0.1',61621,timeout=10)
   try:
    conn.request('POST',self.path,data,{'authorization':self.headers['authorization'],'content-type':'application/json'})
    response=conn.getresponse();body=response.read()
    if self.headers.get('x-test-drop')=='yes':self.close_connection=True;return
    self.send_response(response.status);self.send_header('content-type','application/json');self.send_header('content-length',str(len(body)));self.end_headers();self.wfile.write(body)
   except (OSError,http.client.HTTPException):
    self.send_response(503);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(b'{"code":"TEST_UPSTREAM_STARTING"}')
   finally:conn.close()
  def log_message(self,*args):pass
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Proxy);context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(str(R/'server.crt'),str(R/'server.key'));server.socket=context.wrap_socket(server.socket,server_side=True)
 thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();client=ssl.create_default_context(cafile=str(R/'ca.crt'))
 def rpc(name,data,token=None,drop=False):
  headers={'authorization':'Bearer '+(token or state['SERVICE_ROLE_KEY']),'content-type':'application/json'}
  if drop:headers['x-test-drop']='yes'
  request=urllib.request.Request(f'https://127.0.0.1:{server.server_port}/rpc/'+name,data=json.dumps(data).encode(),headers=headers)
  try:
   with urllib.request.urlopen(request,context=client,timeout=15)as response:return response.status,json.loads(response.read())
  except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
 global_token=str(uuid.uuid4());request_id=str(uuid.uuid4());scope={'kind':'report_retention'}
 args={'p_request_id':request_id,'p_operation':'cycle','p_global_token':global_token,'p_scope':scope}
 try:
  code=None
  for _ in range(30):
   try:
    code,_=rpc('read_worker_runtime_pending',{})
    if code in(401,403):break
   except urllib.error.URLError as e:
    failure=type(e.reason).__name__+':'+str(getattr(e.reason,'verify_code',getattr(e.reason,'errno','none')))
   except http.client.RemoteDisconnected:failure='RemoteDisconnected'
   time.sleep(.2)
  assert code in(401,403),f'DEFAULT_ACL_MUST_BE_CLOSED:{code}:{locals().get("failure","none")}'
  tls.sql("update private.worker_runtime_journal_control set enabled=true where singleton;update private.global_worker_run set token='"+global_token+"',expires_at=clock_timestamp()+interval'180 seconds'where singleton;grant execute on function public.prepare_worker_runtime_intent(uuid,text,uuid,jsonb,uuid),public.observe_worker_runtime_intent(uuid,boolean),public.read_worker_runtime_pending(),public.get_worker_runtime_intent(uuid)to service_role;notify pgrst,'reload schema';")
  lost=False
  try:rpc('prepare_worker_runtime_intent',args,drop=True)
  except http.client.RemoteDisconnected:lost=True
  assert lost
  with concurrent.futures.ThreadPoolExecutor(max_workers=6)as pool:results=list(pool.map(lambda _:rpc('prepare_worker_runtime_intent',args),range(6)))
  assert all(code==200 for code,_ in results)and len({v['ticket']for _,v in results})==1
  conflict=rpc('prepare_worker_runtime_intent',{**args,'p_scope':{'kind':'review_summary'}});assert conflict[0]>=400 and conflict[1].get('code')=='40001'
  assert rpc('prepare_worker_runtime_intent',args,state['ANON_KEY'])[0]in(401,403)
  assert rpc('get_worker_runtime_intent',{'p_request_id':request_id})[1]['scope']==scope
  assert rpc('observe_worker_runtime_intent',{'p_request_id':request_id,'p_observed':False})[1]['state']=='unknown'
  conflict=rpc('observe_worker_runtime_intent',{'p_request_id':request_id,'p_observed':True});assert conflict[0]>=400 and conflict[1].get('code')=='40001'
  assert rpc('read_worker_runtime_pending',{})[1]['hasPending']is True
  receipt={'httpsPostgrestJwt':'PASS','responseLostAfterCommit':True,'sixRetriesOneTicket':True,'differentInputConflict':True,'anonDenied':True,'unknownPreserved':True,'automaticMutationReplay':0,'operatingChanged':False}
  p=R/'journal-http-receipt.json';p.write_text(json.dumps(receipt));p.chmod(0o600);print(json.dumps(receipt))
 finally:
  tls.sql("update private.worker_runtime_journal_control set enabled=false where singleton;revoke execute on function public.prepare_worker_runtime_intent(uuid,text,uuid,jsonb,uuid),public.observe_worker_runtime_intent(uuid,boolean),public.read_worker_runtime_pending(),public.get_worker_runtime_intent(uuid)from service_role;update private.global_worker_run set token=null,expires_at=null where singleton and token='"+global_token+"';")
  server.shutdown();server.server_close();thread.join()
if __name__=='__main__':
 import sys
 if sys.argv[1:]==['--setup']:setup()
 else:run()
