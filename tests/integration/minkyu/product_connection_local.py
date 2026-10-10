"""Product handler TLS/DB preparation. Synthetic signed JWT; no operating/Auth login mutation."""
import base64,hashlib,hmac,json,secrets,time,uuid
from pathlib import Path
import queue_tls_environment as t
R=t.ROOT
prefix=uuid.uuid4().hex[:8]
def uid(n):return prefix+'-0000-4000-8000-'+str(n).zfill(12)
def run():
 seed=Path('tests/database/minkyu/assigned_report_notice_receipts.sql').read_text().split("insert into auth.users(id,email)values(pg_temp.safety_uid(3)")[0]
 seed=seed.replace('fe910000',prefix).replace('fe920000',prefix[:6]+'aa').replace('fe930000',prefix[:6]+'bb').replace('review-start-sql-','connection107-'+prefix+'-')
 post=str(uuid.uuid4());messages=[str(uuid.uuid4())for _ in range(3)]
 seed+="set local role authenticated;select pg_temp.safety_actor(1);select public.create_service_post('"+post+"',jsonb_build_object('title','서버 연결 검증','description','합성 공고','category','산책','startsAt',now()+interval'3 days','endsAt',now()+interval'3 days 2 hours','recruitmentEndsAt',now()+interval'2 days','publicArea','서울특별시 강남구 역삼동','registeredAddress','서울특별시 강남구 가상주소','meetingDetail','가상 입구','registeredPlaceName',null,'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0));select pg_temp.safety_actor(2);select public.request_service_post('"+post+"','"+messages[0]+"','합성 첫 메시지');reset role;commit;"
 t.sql(seed)
 # This opt-in is only for newly created synthetic fixtures, never real accounts.
 t.sql("insert into private.ai_member_processing(user_id,exploration_allowed)values('"+uid(1)+"',true)on conflict(user_id)do update set exploration_allowed=true;")
 rid=t.sql("select id from public.join_requests where post_id='"+post+"';").decode().strip()
 state=json.loads(Path('/private/tmp/yumidang-release88-http-isolated/status-private.json').read_text())
 env=dict(v.split('=',1)for v in(R/'rest-private.env').read_text().splitlines()if '='in v);secret=env['PGRST_JWT_SECRET']
 try:
  keys=json.loads(secret);oct_key=next(k for k in keys.get('keys',[keys])if k.get('kty')=='oct');secret=base64.urlsafe_b64decode(oct_key['k']+'='*((-len(oct_key['k']))%4))
 except ValueError:secret=secret.encode()
 enc=lambda v:base64.urlsafe_b64encode(json.dumps(v,separators=(',',':')).encode()).decode().rstrip('=')
 tokens=[]
 for n in(1,2):
  sid=prefix[:6]+'aa-0000-4000-8000-'+str(n).zfill(12)
  unsigned=enc({'alg':'HS256','typ':'JWT'})+'.'+enc({'sub':uid(n),'role':'authenticated','session_id':sid,'exp':int(time.time())+3600})
  tokens.append(unsigned+'.'+base64.urlsafe_b64encode(hmac.new(secret,unsigned.encode(),hashlib.sha256).digest()).decode().rstrip('='))
 token=str(uuid.uuid4());request=str(uuid.uuid4());internal=secrets.token_urlsafe(36)
 sig='public.read_worker_runtime_pending_v2(),public.read_worker_runtime_maintenance_schedule(uuid),public.read_ai_feedback_maintenance_schedule(uuid),public.purge_ai_feedback_scoped(uuid,uuid,integer),public.get_worker_runtime_operation(uuid)'
 t.sql("update private.worker_runtime_atomic_control set enabled=true;update private.ai_feedback_maintenance_control set enabled=true;update private.global_worker_run set token='"+token+"',expires_at=now()+interval'180 seconds'where singleton;grant execute on function "+sig+" to service_role;notify pgrst,'reload schema';")
 p=R/'product-connection-private.json';p.write_text(json.dumps({'members':[uid(1),uid(2)],'tokens':tokens,'requestId':rid,'messages':messages,'globalToken':token,'maintenanceRequest':request,'internalSecret':internal,'anonKey':state['ANON_KEY'],'serviceKey':state['SERVICE_ROLE_KEY'],'signatures':sig}));p.chmod(0o600)
 print(json.dumps({'syntheticMembersPrepared':2,'operatingChanged':False,'credentialsPrinted':False}))
def control(action):
 f=json.loads((R/'product-connection-private.json').read_text());member=f['members'][0]
 if action=='--resign':
  env=dict(v.split('=',1)for v in(R/'rest-private.env').read_text().splitlines()if '='in v);keys=json.loads(env['PGRST_JWT_SECRET']);key=next(k for k in keys['keys']if k.get('kty')=='oct');secret=base64.urlsafe_b64decode(key['k']+'='*((-len(key['k']))%4))
  signed=[]
  for token in f['tokens']:
   unsigned='.'.join(token.split('.')[:2]);signed.append(unsigned+'.'+base64.urlsafe_b64encode(hmac.new(secret,unsigned.encode(),hashlib.sha256).digest()).decode().rstrip('='))
  f['tokens']=signed;p=R/'product-connection-private.json';p.write_text(json.dumps(f));p.chmod(0o600)
 elif action=='--refresh':t.sql("update private.global_worker_run set token='"+f['globalToken']+"',expires_at=now()+interval'180 seconds'where singleton;")
 elif action=='--age':t.sql("update private.ai_feedback_receipts set accepted_at=now()-interval'91 days'where user_id='"+member+"'and action='helpful';update private.ai_result_receipts set available_at=now()-interval'91 days'where user_id='"+member+"';")
 elif action=='--close':t.sql("update private.worker_runtime_atomic_control set enabled=false;update private.ai_feedback_maintenance_control set enabled=false;revoke execute on function "+f['signatures']+" from service_role;update private.global_worker_run set token=null,expires_at=null where singleton and token='"+f['globalToken']+"';")
 else:raise RuntimeError('INVALID_ACTION')
 print('ISOLATED_CONTROL_OK')
if __name__=='__main__':
 import sys
 if sys.argv[1:]:control(sys.argv[1])
 else:run()
