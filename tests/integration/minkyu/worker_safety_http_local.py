"""Fresh SQL112+114 safety HTTPS/Node harness; default-closed, never resume a started fixture.

python3 worker_safety_http_local.py --prepare --scenario cancellation --revision v1
python3 worker_safety_http_local.py --run --scenario cancellation --revision v1
Approved agent executes only owned disposable Docker/network recipes. Base v5 is read-only and hash recorded.
Every scenario uses a fresh recipe; success and DELETE-loss Storage are separate.
"""
import hashlib
import base64
import io
import tarfile
import urllib.request
import urllib.error
import importlib.util
import ipaddress
import json
from pathlib import Path
import re
import subprocess
import os
import signal
import selectors
import uuid
import threading
import hmac
from datetime import datetime

import sys
assert len(sys.argv) == 6 and sys.argv[1] in ['--prepare','--fixture','--snapshot','--unknown','--close','--run','--storage-proof','--five-proof','--recovery-open','--owned-proof','--retirement-proof','--summary-race-proof','--summary-race-mutate','--summary-insufficient-enqueue','--summary-insufficient-proof','--review-lane-proof','--budget-proof','--budget-insert','--legacy-proof'], 'EXACT_ARGUMENTS_REQUIRED'
from types import SimpleNamespace
args = SimpleNamespace(action=sys.argv[1], scenario=sys.argv[3], revision=sys.argv[5])
assert sys.argv[2] == '--scenario' and sys.argv[4] == '--revision', 'EXACT_ARGUMENT_ORDER_REQUIRED'
SUMMARY_RACES={
 'five-kind-summary-'+mutation+'-'+phase:(mutation,phase,'summary-'+short+suffix)
 for mutation,short in [('edit','e'),('consent','c'),('hide','h'),('delete','d')]
 for phase,suffix in [('checkpoint','c'),('publish','p')]
}
SUMMARY_RACE=SUMMARY_RACES.get(args.scenario)
REVIEW_LANE_MODE=args.scenario in('review-lease-reassignment','review-unsupported-due')
REASSIGNMENT_MODE=args.scenario=='review-lease-reassignment'
LEGACY_OBSERVED_MODE=args.scenario=='legacy-observed-pending'
BUDGET_MODE=args.scenario=='cancellation-budget-maintenance'
CANCELLATION_MODE=args.scenario in('cancellation','cancellation-budget-maintenance','review-unsupported-due')
assert args.scenario in ('legacy-observed-pending','cancellation','cancellation-budget-maintenance','review-lease-reassignment','review-unsupported-due','report-metadata','report-storage-success','report-storage-delete-loss','five-kind-smoke','five-kind-overflow','five-kind-response-loss','five-kind-storage-reconcile','five-kind-auth-reconcile','five-kind-retire-storage','five-kind-retire-auth',*SUMMARY_RACES) and re.fullmatch(r'v[1-9][0-9]?', args.revision), 'INVALID_RECIPE'
HARNESS_REPO = Path(__file__).resolve().parents[3]
# Parent maintains this latest integration snapshot; harness reads it without edits.
REPO = Path('/Users/minkyu/Documents/GitHub/yumidang/.worktrees/minkyu-foundation')
spec = importlib.util.spec_from_file_location('readonly_invocation_v5', REPO/'tests/integration/minkyu/worker_invocation_http_local.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
b.REPO = REPO
b.ROOT = Path('/private/tmp/yumidang-safety114-http-' + args.scenario + '-' + args.revision)
short_scenario={'legacy-observed-pending':'legacy-observed','cancellation-budget-maintenance':'cancel-budget-maint',**{name:value[2]for name,value in SUMMARY_RACES.items()},'five-kind-storage-reconcile':'five-storage-reconcile','five-kind-auth-reconcile':'five-auth-reconcile','five-kind-retire-storage':'five-retire-storage','five-kind-retire-auth':'five-retire-auth'}.get(args.scenario,args.scenario)
b.NAME = 'yumidang-minkyu-safety114-http-' + short_scenario + '-' + args.revision
assert len(b.NAME)<=63,'DB_DNS_LABEL_TOO_LONG'
STORAGE_SOURCE='yumidang-minkyu-runtime103-storage'
STORAGE=b.NAME+'-storage';VOLUME=STORAGE+'-files'
FIVE_MODE=args.scenario.startswith('five-kind-')
PUBLIC_RETIREMENT_MODE=args.scenario in('five-kind-retire-storage','five-kind-retire-auth')
RECOVERY_MODE=args.scenario in('five-kind-storage-reconcile','five-kind-auth-reconcile','five-kind-retire-storage','five-kind-retire-auth')
RECOVERY_FUNCTIONS=('begin_member_cleanup_reconcile(uuid,uuid,uuid,uuid)','get_member_cleanup_reconcile(uuid)','finish_member_cleanup_reconcile(uuid,text)')
STORAGE_MODE=args.scenario.startswith('report-storage-')or FIVE_MODE
AUTH=b.NAME+'-auth'
b.REST = b.NAME + '-rest'; b.NETWORK = b.NAME + '-network'; b.REVISION = 'safety-' + args.revision
b.LOGIN = 'yumidang_safety114_queue_login'; b.REST_LOGIN = 'yumidang_safety114_rest_login'
# Imported Python defaults captured v5 NAME at definition time. Resolve the new
# clone dynamically while retaining base target validation for every SQL call.
_original_sql=b.sql
def clone_sql(query,name=None):return _original_sql(query,b.NAME if name is None else name)
b.sql=clone_sql
_original_docker=b.docker
def fresh_docker(*argv,data=None):
 # 새 레시피 세 컨테이너에만 상한을 적용한다. 원본·기존 컨테이너 설정은 바꾸지 않는다.
 if argv[:2]==('run','-d'):
  name=argv[argv.index('--name')+1]
  limits={b.NAME:'512m',b.REST:'128m',STORAGE:'512m',AUTH:'128m'}
  assert name in limits,'UNOWNED_CONTAINER_START'
  alias={b.NAME:'safety-db',b.REST:'safety-rest',STORAGE:'safety-storage',AUTH:'safety-auth'}[name]
  argv=argv[:2]+('--no-healthcheck','--memory',limits[name],'--network-alias',alias)+argv[2:]
  if name==b.NAME:
   # 같은 이미지의 새 initdb 전용 설정이다. 연결·TLS·원자 SQL 검증은 보존한다.
   assert argv[-2]=='-c' and 'exec postgres -D /tmp/invocation-data 'in argv[-1]
   argv=argv[:-1]+(argv[-1]+' -c shared_buffers=16MB -c max_connections=40 -c log_connections=on -c "log_line_prefix=safety114 [%p] " -c log_statement=none -c log_min_error_statement=panic',)
 if len(argv)>=3 and argv[:2]==('network','create') and argv[-1]==b.NETWORK:
  ids=_original_docker('network','ls','--quiet').decode().splitlines()
  info=json.loads(_original_docker('network','inspect',*ids)) if ids else []
  used=[ipaddress.ip_network(c['Subnet'],strict=False) for n in info for c in(n.get('IPAM',{}).get('Config')or[])if c.get('Subnet')]
  subnet=next((ipaddress.ip_network('10.245.'+str(i)+'.0/24')for i in range(100,240)if not any(ipaddress.ip_network('10.245.'+str(i)+'.0/24').overlaps(n)for n in used if n.version==4)),None)
  assert subnet is not None,'NO_NONOVERLAPPING_TEST_SUBNET'
  b.save('network-plan-private.json',json.dumps({'network':b.NETWORK,'subnet':str(subnet),'existingNetworksChanged':False}))
  argv=argv[:2]+('--subnet',str(subnet))+argv[2:]
 return _original_docker(*argv,data=data)
b.docker=fresh_docker

def container_metadata(value):
 # 준비·실행·중지 뒤 검사는 같은 전체 Config/Mounts 직렬화를 사용한다.
 # 원문 env·호스트 경로는 메모리에서만 해시하며 파일·stdout에 저장하지 않는다.
 canonical=lambda item:json.dumps(item,sort_keys=True,separators=(',',':'),ensure_ascii=True)
 digest=lambda item:hashlib.sha256(canonical(item).encode()).hexdigest()
 return {'schema':'full-inspect-v1','name':value['Name'],'id':value['Id'],
  'configHash':digest(value['Config']),
  'mountHash':digest(sorted(value['Mounts'],key=canonical)),
  'memoryCap':value['HostConfig']['Memory'],
  'noHealthcheck':value['Config'].get('Healthcheck',{}).get('Test')==['NONE']}

def owned_metadata():
 names=[b.NAME,b.REST]+([STORAGE]if STORAGE_MODE else [])+([AUTH]if FIVE_MODE else [])
 result=[]
 for name in names:
  value=json.loads(b.docker('inspect',name))[0]
  assert value['Name']=='/'+name and (value['Config'].get('Labels')or{}).get('yumidang.owner')=='minkyu','OWNED_IDENTITY_REQUIRED'
  assert not value['State']['OOMKilled'],'OWNED_OOM_REJECTED'
  item=container_metadata(value);assert item['noHealthcheck'],'OWNED_HEALTHCHECK_REJECTED'
  assert item['memoryCap']=={b.NAME:512*1024*1024,b.REST:128*1024*1024,STORAGE:512*1024*1024,AUTH:128*1024*1024}[name],'OWNED_MEMORY_CAP_MISMATCH'
  result.append(item)
 return result

def owned_proof():
 assert b.ROOT.resolve()==b.ROOT and not b.ROOT.stat().st_mode&0o077,'PRIVATE_ROOT_REQUIRED'
 baseline=json.loads((b.ROOT/'owned-container-baseline.json').read_text())
 actual=owned_metadata();assert actual==baseline,'OWNED_CONFIG_OR_MOUNTS_CHANGED'
 print(json.dumps({'schema':'full-inspect-v1','containers':actual,'baselineExact':True}))
EXTRA = (
 'prepare_worker_invocation_intent(uuid,uuid,text,jsonb,uuid)',
 'execute_worker_invocation_operation(uuid,uuid,uuid,text,jsonb)',
 'confirm_worker_runtime_intent(uuid)', 'get_worker_runtime_intent(uuid)',
 'observe_worker_runtime_intent(uuid,boolean)',
 'enqueue_cancellation_safety_due(integer,uuid)', 'process_cancellation_safety_due(uuid,bigint,uuid,uuid,uuid)',
 'enqueue_report_retention_purges(uuid,integer)', 'claim_report_retention_task(uuid,uuid,uuid)',
 'check_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid)',
 'get_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid)',
 'record_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid,text)',
 'complete_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid,text)',
 'purge_report_retention_terminal_receipts(uuid,integer)', 'begin_report_retention_delete(uuid,uuid,uuid,uuid,uuid,uuid)',
)
BASE_SIGNATURES = b.SIGNATURES
b.SIGNATURES = BASE_SIGNATURES + EXTRA
MIGRATIONS = ['20261009011000_member_cleanup_invocation.sql','20261009011100_event_collection_lane.sql',
              '20261009011200_event_invocation_audit.sql','20261009011400_worker_intent_confirmation.sql']
if FIVE_MODE:MIGRATIONS+=['20261009011500_member_cleanup_reconcile.sql']
if PUBLIC_RETIREMENT_MODE:MIGRATIONS+=['20261009011700_member_retirement_receipt.sql']
DISCOVERY_FUNCTION='read_member_cleanup_unknown_invocations(uuid,integer)'
if RECOVERY_MODE:MIGRATIONS+=['20261009024414_member_cleanup_unknown_discovery.sql']
FIVE_FUNCTIONS=('read_event_collection_contract()',
 'register_event_collection_jobs(text,date,jsonb,boolean,jsonb)',
 'claim_event_collection(text,text,jsonb,uuid,integer,text,text)',
 'commit_event_collection_page(uuid,uuid,uuid,integer,jsonb,boolean,jsonb,jsonb)',
 'store_event_source_detail(jsonb,uuid,uuid,uuid,text,boolean)',
 'next_event_collection_reference(uuid,jsonb)','list_ongoing_event_source_ids(text,text,integer)',
 'settle_event_collection(uuid,uuid,uuid,text,text,boolean,integer,integer)',
 'claim_member_cleanup_task(uuid)','check_member_cleanup_task(uuid,uuid,uuid,uuid)',
 'begin_member_cleanup_delete(uuid,uuid,uuid,uuid)','get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)',
 'record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)','complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)',
 'claim_supported_job(uuid,integer,uuid,text[])','claim_job(uuid,integer,uuid)',
 'complete_job(uuid,uuid,uuid)','fail_job(uuid,uuid,text,uuid)',
 'retry_job(uuid,uuid,timestamptz,text,uuid)','yield_job(uuid,uuid,timestamptz,uuid)','supersede_job(uuid,uuid,uuid)',
 'load_review_summary_source(uuid,uuid,uuid,text)','load_review_summary_checkpoint(uuid,uuid,text,uuid,text)',
 'save_review_summary_checkpoint(uuid,uuid,text,jsonb,uuid,text)','discard_review_summary_checkpoint(uuid,uuid,text,uuid,text)',
 'mark_review_summary_insufficient(uuid,uuid,text,uuid,text)',
 'reserve_review_summary_model(text,text,text,bigint,uuid,uuid,uuid,text,uuid,text,text,uuid[],text)',
 'publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text,uuid,text)','settle_ai_budget(uuid,text,bigint,bigint)')
FIVE_SIGNATURES=()
_original_closed = b.closed

def closed(name):
 _original_closed(name)
 if b.sql("select to_regclass('private.worker_intent_confirmation_control')is not null;", name).decode().strip() == 't':
  assert b.sql("select not(select enabled from private.worker_intent_confirmation_control)and not(select enabled from private.worker_runtime_journal_control)and not(select enabled from private.cancellation_due_control)and not(select enabled from private.report_purge_control);", name).decode().strip() == 't', 'SAFETY_CONTROLS_NOT_CLOSED'
  for sig in EXTRA[:3]:
   assert b.sql("select bool_and(not has_function_privilege(r,'public." + sig + "','EXECUTE'))from unnest(array['anon','authenticated','service_role','yumidang_worker_queue'])r;", name).decode().strip() == 't', 'SCOPED_EXEC_NOT_CLOSED'
 if REVIEW_LANE_MODE:
  assert b.sql('select not external_processing_allowed from private.ai_processing_guard;',name).decode().strip()=='t','REVIEW_LANE_GUARD_NOT_CLOSED'
  for sig in FIVE_FUNCTIONS[14:]if name==b.NAME and(b.ROOT/'review-lane-rpc-signatures.json').exists()else ():
   assert b.sql("select bool_and(not has_function_privilege(r,'public."+sig+"','EXECUTE'))from unnest(array['anon','authenticated','service_role','yumidang_worker_queue'])r;",name).decode().strip()=='t','REVIEW_LANE_EXEC_NOT_CLOSED'
 if FIVE_MODE and b.sql("select to_regclass('private.event_collection_control')is not null;",name).decode().strip()=='t':
  for table,column in [('event_collection_control','enabled'),('member_cleanup_guard','external_deletion_approved')]:
   assert b.sql('select not '+column+' from private.'+table+';',name).decode().strip()=='t','FIVE_KIND_CONTROL_NOT_CLOSED'
  assert b.sql('select not external_processing_allowed from private.ai_processing_guard;',name).decode().strip()=='t','SYNTHETIC_MODEL_GUARD_NOT_CLOSED'
  if name==b.NAME and(b.ROOT/'five-rpc-signatures.json').is_file():
   for sig in five_signatures()+RECOVERY_FUNCTIONS+((DISCOVERY_FUNCTION,)if RECOVERY_MODE else ()):
    assert b.sql("select bool_and(not has_function_privilege(r,'public."+sig+"','EXECUTE'))from unnest(array['anon','authenticated','service_role','yumidang_worker_queue'])r;",name).decode().strip()=='t','FIVE_KIND_EXEC_NOT_CLOSED'
 if PUBLIC_RETIREMENT_MODE and b.sql("select to_regclass('private.member_retirement_receipt_control')is not null;",name).decode().strip()=='t':
  assert b.sql('select not enabled and expected_issuer is null from private.member_retirement_receipt_control;',name).decode().strip()=='t','PUBLIC_RECEIPT_GATE_NOT_RESTORED'
  assert b.sql("select has_function_privilege('authenticated','public.get_my_retirement_receipt(uuid,text)','EXECUTE')and not has_function_privilege('anon','public.get_my_retirement_receipt(uuid,text)','EXECUTE')and not has_function_privilege('service_role','public.get_my_retirement_receipt(uuid,text)','EXECUTE')and not has_function_privilege('yumidang_worker_queue','public.get_my_retirement_receipt(uuid,text)','EXECUTE');",name).decode().strip()=='t','PUBLIC_RECEIPT_ACL_CHANGED'
b.closed = closed

def five_signatures():
 path=b.ROOT/'five-rpc-signatures.json'
 if not FIVE_MODE:return ()
 assert path.is_file(),'FIVE_KIND_SIGNATURE_MANIFEST_REQUIRED'
 values=tuple(json.loads(path.read_text()))
 assert values==FIVE_FUNCTIONS,'INVALID_FIVE_KIND_SIGNATURE_MANIFEST'
 return values

def prepare_auth():
 # 캐시된 동일 Auth 이미지를 새 clone에만 연결한다. 실제 회원 로그인·외부 메일은 사용하지 않는다.
 image='public.ecr.aws/supabase/gotrue:v2.196.0'
 info=json.loads(b.docker('image','inspect',image))[0]
 f=b.state();secret=dict(v.split('=',1)for v in(b.ROOT/'rest-private.env').read_text().splitlines())['PGRST_JWT_SECRET']
 password=b.secrets.token_urlsafe(36)
 b.sql("alter role supabase_auth_admin login password '"+password+"';")
 env={'GOTRUE_API_HOST':'0.0.0.0','GOTRUE_API_PORT':'9999','API_EXTERNAL_URL':'http://127.0.0.1/auth/v1',
  'GOTRUE_DB_DRIVER':'postgres','GOTRUE_DB_DATABASE_URL':'postgresql://supabase_auth_admin:'+password+'@'+b.NAME+':5432/postgres?sslmode=verify-full&sslrootcert=/certs/ca.crt',
  'GOTRUE_SITE_URL':'http://127.0.0.1','GOTRUE_JWT_SECRET':secret,'GOTRUE_JWT_AUD':'authenticated',
  'GOTRUE_JWT_DEFAULT_GROUP_NAME':'authenticated','GOTRUE_JWT_ADMIN_ROLES':'service_role','GOTRUE_JWT_EXP':'3600',
  'GOTRUE_DISABLE_SIGNUP':'true','GOTRUE_EXTERNAL_EMAIL_ENABLED':'true','GOTRUE_MAILER_AUTOCONFIRM':'true',
  'GOTRUE_EXTERNAL_PHONE_ENABLED':'false','GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED':'false','GOTRUE_LOG_LEVEL':'error'}
 if PUBLIC_RETIREMENT_MODE or SUMMARY_RACE and SUMMARY_RACE[0]=='consent':env['GOTRUE_JWT_ISSUER']=env['API_EXTERNAL_URL']
 b.save('auth-private.env','\n'.join(k+'='+v for k,v in env.items())+'\n')
 b.docker('run','-d','--name',AUTH,'--network',b.NETWORK,'--user','0:0','--label','yumidang.owner=minkyu',
  '-p','127.0.0.1::9999','--env-file',str(b.ROOT/'auth-private.env'),'--mount','type=bind,src='+str(b.ROOT/'ca.crt')+',dst=/certs/ca.crt,readonly',info['Id'])
 port=b.mapped_port(AUTH,9999);b.save('auth-connection-private.json',json.dumps({'container':AUTH,'containerId':b.identity(AUTH)['Id'],'image':info['Id'],'port':port}))
 deadline=b.time.monotonic()+90
 while b.time.monotonic()<deadline:
  try:
   with urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/health',timeout=1)as r:
    if r.status==200:break
  except (OSError,urllib.error.HTTPError):pass
  b.time.sleep(.25)
 else:raise RuntimeError('PREPARE_AUTH_NOT_READY_NO_FIXTURE')
 b.save('auth-api-ready.json',json.dumps({'actualStatus':200,'fixtureStarted':False}))

def auth_request(method,path,data=None,headers=None):
 f=b.state();c=json.loads((b.ROOT/'auth-connection-private.json').read_text())
 assert b.identity(AUTH)['Id']==c['containerId'],'AUTH_REPLACED'
 request=urllib.request.Request('http://127.0.0.1:'+str(c['port'])+path,
  data=None if data is None else json.dumps(data).encode(),method=method,
  headers={'authorization':'Bearer '+f['serviceKey'],'apikey':f['serviceKey'],'content-type':'application/json',**(headers or {})})
 try:
  with urllib.request.urlopen(request,timeout=10)as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read())

def tls_sessions():
 # 자기 clone의 연결 메타데이터만 메모리에서 읽는다. 원 SQL·DSN·로그는 저장하지 않는다.
 query="select coalesce(json_agg(json_build_object('pid',a.pid,'role',a.usename,'ssl',s.ssl,'protocol',s.version,'cipher',s.cipher,'bits',s.bits)),'[]')from pg_stat_ssl s join pg_stat_activity a using(pid)where a.usename in('"+b.REST_LOGIN+"','supabase_auth_admin','supabase_storage_admin');"
 result=subprocess.run(b.DOCKER+['exec','-i',b.NAME,'psql','-XqAt','-U',b.BOOT,'-d','postgres','-v','ON_ERROR_STOP=1'],input=query.encode(),capture_output=True,timeout=3)
 assert result.returncode==0,'TLS_OBSERVER_QUERY_FAILED'
 return json.loads(result.stdout)

def parse_tls_connections(data):
 roles=(b.REST_LOGIN,'supabase_auth_admin','supabase_storage_admin');authenticated={};authorized=[]
 for line in data.decode(errors='replace').splitlines():
  identity=re.fullmatch(r'safety114 \[(\d+)\] LOG:  connection authenticated: identity="([a-z0-9_]+)" method=scram-sha-256(?: .*)?',line)
  if identity and identity[2]in roles:authenticated[int(identity[1])]=identity[2]
  # 고정 이미지의 실제 비밀 아닌 앱 이름만 허용한다. 임의 문자열·제어문자·위조 SSL 문구는 앱 이름이 아니다.
  transport=re.fullmatch(r'safety114 \[(\d+)\] LOG:  connection authorized: user=([a-z0-9_]+) database=postgres(?: application_name=(?:PostgREST 16\.1|Supabase Storage API 1\.70\.3|auth_migrations))? SSL enabled \(protocol=(TLSv1\.[23]), cipher=([A-Za-z0-9_-]+), bits=(\d+)\)',line)
  authorization=re.match(r'safety114 \[(\d+)\] LOG:  connection authorized: user=([a-z0-9_]+) database=postgres(?:\s|$)',line)
  if authorization and authorization[2]in roles:assert transport and int(transport[5])>=128,'PLAINTEXT_OR_WEAK_APP_CONNECTION_FORBIDDEN'
  if transport and transport[2]in roles and int(transport[5])>=128:authorized.append({'pid':int(transport[1]),'role':transport[2],'ssl':True,'protocol':transport[3],'cipher':transport[4],'bits':int(transport[5])})
 return [value for value in authorized if authenticated.get(value['pid'])==value['role']]

def tls_connections():
 result=subprocess.run(b.DOCKER+['logs',b.NAME],capture_output=True,timeout=5)
 assert result.returncode==0,'TLS_CONNECTION_LOG_READ_FAILED'
 return parse_tls_connections(result.stdout+result.stderr)

def auth_db_readiness():
 assert b.sql("select current_setting('log_connections')='on'and current_setting('log_line_prefix')='safety114 [%p] 'and current_setting('log_statement')='none'and current_setting('log_min_error_statement')='panic';").decode().strip()=='t','CLONE_TLS_LOG_METADATA_ONLY_REQUIRED'
 readiness_id=str(uuid.uuid4())
 assert b.sql("select not exists(select 1 from auth.users where id='"+readiness_id+"');").decode().strip()=='t','AUTH_READINESS_ID_MUST_BE_ABSENT'
 before={value['pid']for value in tls_connections()};observed={};stopped=threading.Event();ready=threading.Event();failed=[]
 def observe():
  started=b.time.monotonic()
  try:
   while not stopped.is_set()and b.time.monotonic()-started<20:
    for value in tls_sessions():observed[(value['pid'],value['role'])]=value
    ready.set();stopped.wait(.01)
  except Exception:failed.append(True);ready.set()
 observer=threading.Thread(target=observe,daemon=True);observer.start()
 try:
  assert ready.wait(5)and not failed,'TLS_OBSERVER_NOT_READY'
  status,_=auth_request('GET','/admin/users/'+readiness_id)
 finally:stopped.set();observer.join(5)
 assert not observer.is_alive()and not failed,'TLS_OBSERVER_FAILED'
 connections=tls_connections();fresh=[v for v in connections if v['role']=='supabase_auth_admin'and v['pid']not in before]
 valid=lambda v:v['ssl']is True and v['protocol']in('TLSv1.2','TLSv1.3')and v['cipher']and v['bits']>=128
 sessions=list(observed.values())+tls_sessions()
 assert not any(v['ssl']is not True for v in sessions),'PLAINTEXT_APP_SESSION_FORBIDDEN'
 assert all(valid(v)for v in sessions),'WEAK_APP_SESSION_FORBIDDEN'
 proven={v['role']for v in sessions+connections if valid(v)};expected={b.REST_LOGIN,'supabase_auth_admin','supabase_storage_admin'}
 b.save('auth-db-readiness-private.json',json.dumps({'method':'GET','freshNonexistentUser':True,'signedService':True,'httpStatus':status,'createListDelete':0,'concurrentTlsSessions':sessions,'freshAuthenticatedTlsConnections':fresh,'expectedRoles':sorted(expected),'allExpectedRolesActualTls':expected.issubset(proven),'rawResponseArgumentsSqlLogsStored':False}))
 assert status==404,'AUTH_DB_READINESS_GET404_REQUIRED'
 assert fresh or any(v['role']=='supabase_auth_admin'and valid(v)for v in sessions),'AUTH_GET_ACTUAL_TLS_REQUIRED'
 assert expected.issubset(proven),'ACTUAL_DB_TLS_EVIDENCE_REQUIRED_FOR_EACH_ROLE'

def storage_source_proof():
 info=b.identity(STORAGE_SOURCE)
 env=dict(v.split('=',1)for v in info['Config']['Env']if '='in v)
 assert env.get('STORAGE_BACKEND')=='file','CACHED_FILE_STORAGE_REQUIRED'
 archive=b.docker('exec',STORAGE_SOURCE,'tar','-cf','-','-C','/mnt','.')
 files={}
 with tarfile.open(fileobj=io.BytesIO(archive))as tar:
  for item in tar:
   assert not item.issym()and not item.islnk(),'SOURCE_LINK_NOT_ALLOWED'
   if item.isfile():files[item.name]=hashlib.sha256(tar.extractfile(item).read()).hexdigest()
 return {'id':info['Id'],'image':info['Image'],'envHash':hashlib.sha256(json.dumps(info['Config']['Env']).encode()).hexdigest(),'fileHashes':files},env

def prepare_storage():
 f=b.state();proof,env=storage_source_proof();b.save('storage-source-private.json',json.dumps(proof))
 assert STORAGE not in b.docker('ps','-a','--format','{{.Names}}').decode().splitlines(),'EXISTING_STORAGE_PRESERVED'
 assert VOLUME not in b.docker('volume','ls','--format','{{.Name}}').decode().splitlines(),'EXISTING_VOLUME_PRESERVED'
 secret=dict(v.split('=',1)for v in(b.ROOT/'rest-private.env').read_text().splitlines())['PGRST_JWT_SECRET']
 password=b.secrets.token_urlsafe(36)
 b.sql("alter role supabase_storage_admin password '"+password+"';")
 hba='local all all trust\nhostssl postgres '+b.LOGIN+','+b.REST_LOGIN+',supabase_storage_admin'+(',supabase_auth_admin'if FIVE_MODE else '')+' 0.0.0.0/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n'
 b.docker('exec','-i',b.NAME,'sh','-c','cat > /tmp/invocation-data/pg_hba.conf',data=hba.encode());b.sql('select pg_reload_conf();')
 env.update({'DATABASE_URL':'postgresql://supabase_storage_admin:'+password+'@'+b.NAME+':5432/postgres?sslmode=verify-full&sslrootcert=/certs/ca.crt','POSTGREST_URL':'http://safety-rest:3000','AUTH_JWT_SECRET':secret,'ANON_KEY':f['anonKey'],'SERVICE_KEY':f['serviceKey'],'NODE_EXTRA_CA_CERTS':'/certs/ca.crt','NODE_OPTIONS':'--max-old-space-size=128','ENABLE_IMAGE_TRANSFORMATION':'false','S3_PROTOCOL_ENABLED':'false'})
 env.pop('JWT_JWKS',None)
 b.save('storage-private.env','\n'.join(k+'='+v for k,v in env.items())+'\n')
 b.docker('volume','create','--label','yumidang.owner=minkyu',VOLUME)
 b.docker('run','-d','--name',STORAGE,'--network',b.NETWORK,'--user','0:0','--label','yumidang.owner=minkyu','-p','127.0.0.1::5000','--env-file',str(b.ROOT/'storage-private.env'),'--mount','type=volume,src='+VOLUME+',dst=/mnt','--mount','type=bind,src='+str(b.ROOT/'ca.crt')+',dst=/certs/ca.crt,readonly',proof['image'])
 port=b.mapped_port(STORAGE,5000)
 b.save('storage-connection-private.json',json.dumps({'container':STORAGE,'containerId':b.identity(STORAGE)['Id'],'volume':VOLUME,'port':port}))
 deadline=b.time.monotonic()+90
 while b.time.monotonic()<deadline:
  try:
   with urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/status',timeout=1)as r:
    if r.status==200:break
  except (OSError,urllib.error.HTTPError):pass
  b.time.sleep(.25)
 else:raise RuntimeError('PREPARE_STORAGE_API_NOT_READY_NO_FIXTURE')
 b.save('storage-api-ready.json',json.dumps({'actualStatus':200,'fixtureStarted':False}))
 assert storage_source_proof()[0]==proof,'SOURCE_STORAGE_CHANGED'


def storage_request(method,path,data=None,headers=None):
 f=b.state();c=json.loads((b.ROOT/'storage-connection-private.json').read_text())
 assert b.identity(STORAGE)['Id']==c['containerId'],'STORAGE_REPLACED'
 request=urllib.request.Request('http://127.0.0.1:'+str(c['port'])+path,data=data,method=method,headers={'authorization':'Bearer '+f['serviceKey'],**(headers or {})})
 try:
  with urllib.request.urlopen(request,timeout=10)as r:return r.status,r.read()
 except urllib.error.HTTPError as e:return e.code,e.read()


def fixture_storage(members,reports):
 for _ in range(40):
  try:
   if storage_request('GET','/status')[0]==200:break
  except OSError:pass
  b.time.sleep(.25)
 else:raise RuntimeError('NEW_STORAGE_NOT_READY')
 png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF3sAAAAASUVORK5CYII=')
 assets=[str(uuid.uuid4())for _ in range(2 if args.scenario=='report-storage-success' else 1)]
 names=[members[0]+'/'+a+'.png'for a in assets]
 canary=members[0]+'/'+str(uuid.uuid4())+'.png'
 for name in names+[canary]:
  code,_=storage_request('POST','/object/report-evidence/'+name,png,{'content-type':'image/png'});assert code==200,'SYNTHETIC_BYTES_UPLOAD_FAILED'
 for asset,name in zip(assets,names):
  b.sql("update storage.objects set owner_id='"+members[0]+"'where bucket_id='report-evidence'and name='"+name+"';insert into private.report_capture_assets(id,owner_id,owner_episode_id,object_name,state,report_id,uploaded_at)select '"+asset+"','"+members[0]+"',id,'"+name+"','attached','"+reports[0]+"',clock_timestamp()from private.member_episodes where profile_id='"+members[0]+"'and ended_at is null;")
 b.save('storage-fixture-private.json',json.dumps({'names':names,'canary':canary,'sha256':hashlib.sha256(png).hexdigest(),'reportId':reports[0]}))
 assert b.sql("select count(*)>0 and bool_and(s.ssl)from pg_stat_ssl s join pg_stat_activity a using(pid)where a.usename='supabase_storage_admin';").decode().strip()=='t','ACTUAL_STORAGE_DB_TLS_REQUIRED'

def fixture_public_member():
 assert PUBLIC_RETIREMENT_MODE,'PUBLIC_RETIREMENT_SCENARIO_REQUIRED'
 subject='five-public-retirement-'+uuid.uuid4().hex
 quote=lambda value:"'"+value.replace("'","''")+"'"
 account=json.loads(b.sql("select public.resolve_naver_account("+quote(subject)+",'합성탈퇴회원','F','1990-01-01');").decode())
 assert account['status']=='photo_required' and account['userId']is None,'SYNTHETIC_ACCOUNT_NOT_RESERVED'
 password=b.secrets.token_urlsafe(36)
 b.save('public-auth-create-intent.json',json.dumps({'attempt':1,'phase':'LOCAL_ADMIN_CREATE'}))
 status,created=auth_request('POST','/admin/users',{'email':account['authEmail'],'password':password,'email_confirm':True})
 assert status==200,'PUBLIC_SYNTHETIC_AUTH_CREATE_FAILED';member=str(uuid.UUID(created['id']))
 b.save('public-auth-login-intent.json',json.dumps({'attempt':1,'phase':'LOCAL_PASSWORD_LOGIN'}))
 f=b.state();status,session=auth_request('POST','/token?grant_type=password',{'email':account['authEmail'],'password':password},{'apikey':f['anonKey'],'Authorization':'Bearer '+f['anonKey']})
 assert status==200 and session['user']['id']==member,'PUBLIC_SYNTHETIC_LOGIN_FAILED'
 token=session['access_token'];claims=json.loads(base64.urlsafe_b64decode(token.split('.')[1]+'=='));session_id=str(uuid.UUID(claims['session_id']))
 env=dict(line.split('=',1)for line in(b.ROOT/'auth-private.env').read_text().splitlines());issuer=env['API_EXTERNAL_URL']
 assert claims['iss']==issuer and claims['aud']=='authenticated' and claims['role']=='authenticated','ACTUAL_AUTH_ISSUER_AUDIENCE_REQUIRED'
 b.sql("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false);select public.record_naver_session("+quote(subject)+",'"+member+"'::uuid,'"+session_id+"'::uuid);insert into public.profiles(id,real_name,birth_date,gender)values('"+member+"','합성탈퇴회원','1990-01-01','female');")
 withdrawal=str(uuid.uuid4());other_withdrawal=str(uuid.uuid4())
 enc=lambda value:base64.urlsafe_b64encode(json.dumps(value,separators=(',',':')).encode()).rstrip(b'=')
 def sign(value,secret=None):
  content=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc(value)
  return(content+b'.'+base64.urlsafe_b64encode(hmac.new((secret or env['GOTRUE_JWT_SECRET']).encode(),content,hashlib.sha256).digest()).rstrip(b'=')).decode()
 negative={name:sign({**claims,**change})for name,change in {'expired':{'exp':int(b.time.time())-60},'wrong_issuer':{'iss':'https://wrong.fixture.invalid/auth/v1'},'wrong_audience':{'aud':'wrong'},'wrong_sub':{'sub':str(uuid.uuid4())},'anonymous':{'is_anonymous':True}}.items()}
 negative['wrong_signature']=sign(claims,env['GOTRUE_JWT_SECRET']+'-wrong-signature')
 # 실제 GoTrue 회원 토큰과 합성 서명 대조군은 구분한다. refresh/재로그인 포트는 없다.
 b.save('public-retirement-session-private.json',json.dumps({'token':token,'member':member,'withdrawalId':withdrawal,'otherWithdrawalId':other_withdrawal,'negativeTokens':negative,'issuer':issuer,'actualSession':True}))
 b.sql("update private.member_retirement_receipt_control set enabled=true,expected_issuer="+quote(issuer)+";notify pgrst,'reload schema';")
 return member,withdrawal

def fixture_summary_author():
 assert SUMMARY_RACE and SUMMARY_RACE[0]=='consent','SIGNED_CONSENT_SCENARIO_REQUIRED'
 email='summary-race-'+uuid.uuid4().hex+'@test.invalid';password=b.secrets.token_urlsafe(36)
 b.save('summary-author-create-intent.json',json.dumps({'attempt':1,'phase':'LOCAL_ADMIN_CREATE'}))
 status,created=auth_request('POST','/admin/users',{'email':email,'password':password,'email_confirm':True})
 assert status==200,'SUMMARY_SYNTHETIC_AUTH_CREATE_FAILED';author=str(uuid.UUID(created['id']))
 f=b.state();b.save('summary-author-login-intent.json',json.dumps({'attempt':1,'phase':'LOCAL_PASSWORD_LOGIN'}))
 status,session=auth_request('POST','/token?grant_type=password',{'email':email,'password':password},{'apikey':f['anonKey'],'Authorization':'Bearer '+f['anonKey']})
 assert status==200 and session['user']['id']==author,'SUMMARY_SYNTHETIC_LOGIN_FAILED'
 token=session['access_token'];claims=json.loads(base64.urlsafe_b64decode(token.split('.')[1]+'=='))
 assert claims['sub']==author and claims['aud']=='authenticated'and claims['role']=='authenticated'and not claims.get('is_anonymous')
 uuid.UUID(claims['session_id']);env=dict(line.split('=',1)for line in(b.ROOT/'auth-private.env').read_text().splitlines())
 assert claims['iss']==env['GOTRUE_JWT_ISSUER']==env['API_EXTERNAL_URL'],'SIGNED_SUMMARY_ISSUER_REQUIRED'
 enc=lambda value:base64.urlsafe_b64encode(json.dumps(value,separators=(',',':')).encode()).rstrip(b'=')
 def sign(value,secret):
  content=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc(value)
  return(content+b'.'+base64.urlsafe_b64encode(hmac.new(secret.encode(),content,hashlib.sha256).digest()).rstrip(b'=')).decode()
 negative={'expired':sign({**claims,'exp':int(b.time.time())-60},env['GOTRUE_JWT_SECRET']),
  'anonymous':sign({**claims,'is_anonymous':True},env['GOTRUE_JWT_SECRET']),
  'wrong_signature':sign(claims,env['GOTRUE_JWT_SECRET']+'-wrong-signature')}
 b.save('summary-author-session-private.json',json.dumps({'author':author,'token':token,'actualSession':True,'negativeTokens':negative,'issuer':claims['iss']}))
 return author


def fixture_five():
 # 승인 목록은 DB 원문으로 만들지 않는다. 쓰기 전에 계획한 합성 문구와 ID만 모델 검사기에 전달한다.
 prefix='adcafeed'
 uid=lambda n:prefix+'-0000-4000-8000-'+str(n).zfill(12)
 # 검토한 합성 namespace만 쓴다. 개인정보 검사는 유지하며 새 clone의 ID 충돌도 거절한다.
 planned_ids=[uid(n)for n in [1,2,*range(101,106),*range(201,206),*range(301,306),*range(401,406)]]
 assert len(planned_ids)==len(set(planned_ids))==22
 absent="select not exists(select 1 from(select id from auth.users union all select id from public.profiles union all select id from public.posts union all select id from public.join_requests union all select id from public.appointments union all select id from public.appointment_reviews)existing where id=any(array['"+"','".join(planned_ids)+"']::uuid[]));"
 assert b.sql(absent).decode().strip()=='t','FRESH_SYNTHETIC_NAMESPACE_REQUIRED_NO_INSERT'
 author,target=(fixture_summary_author()if SUMMARY_RACE and SUMMARY_RACE[0]=='consent'else uid(1)),uid(2);review_ids=[uid(400+i)for i in range(1,6)]
 source_id='PF'+str(uuid.uuid4().int).zfill(39)[-25:]
 cancel_count=25 if args.scenario=='five-kind-overflow'else 1
 plan={'reviewAuthor':author,'reviewTarget':target,'approvedReviewIds':review_ids[:3],
  'excludedReviewIds':review_ids[3:],'approvedComment':'대화가 편안했고 함께한 시간이 즐거웠어요.',
  'approvedSummary':'세 후기에서 편안한 대화와 즐거운 시간을 공통으로 언급합니다.','eventSourceId':source_id,
  'ledgerId':'synthetic-five-kind-summary','cancelCount':cancel_count,
  'expectedJobs':9+cancel_count-1,'expectedKinds':['review_summary','event_sync','member_cleanup','cancellation_safety','report_retention']}
 if SUMMARY_RACE:plan.update({'summaryRace':{'mutation':SUMMARY_RACE[0],'phase':SUMMARY_RACE[1]},'changedComment':'편안하게 이야기하며 함께한 시간이 즐거웠습니다.'})
 b.save('five-fixture-plan-private.json',json.dumps(plan))
 if PUBLIC_RETIREMENT_MODE:
  # 별도 완료 레시피의 NoACK 음성 증거와 연결한다. 현재 public task/ACK/기한은 변조하지 않는다.
  contrast_path=Path('/private/tmp/yumidang-member115-http-20261009-no_ack-v1/receipt.json')
  contrast_bytes=contrast_path.read_bytes();contrast_sha=hashlib.sha256(contrast_bytes).hexdigest()
  assert contrast_sha=='9e1a4b4c3e2a45cafcd10840df5869689b5e07d2f92b94de1be0e9a4e0eface7','FROZEN_NO_ACK_CONTRAST_REQUIRED'
  contrast=json.loads(contrast_bytes)
  assert contrast['status']=='PASS' and contrast['originEvidence']=='SYNTHETIC_SQL_NO_ACK','NO_ACK_SCOPE_REQUIRED'
  assert contrast['taskCompleted']is False and contrast['outerCompleted']is False and contrast['originalUnknownPreserved']is True,'NO_ACK_UNKNOWN_MUST_REMAIN'
  assert contrast['bridgeDeleteDispatchAckCount']==0 and contrast['forbiddenCalls']==0 and contrast['createdContainersStopped']is True,'NO_ACK_CLOSED_NO_MUTATION_REQUIRED'
  b.save('no-ack-contrast.json',json.dumps({'status':'PASS_LINKED_PRIOR_ACTUAL','receiptSha256':contrast_sha,'origin':'SYNTHETIC_SQL_NO_ACK','taskCompleted':False,'parentCompleted':False,'unknownPreserved':True,'deleteDispatchAck':0,'currentRecipeExecution':'NOT_RUN'}))
 signatures=five_signatures()
 # 신규 clone의 상속 task·원천 자료만 초기화한다. 원 DB/Storage/제공사에는 요청하지 않는다.
 q="begin;select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);truncate private.member_cleanup_tasks cascade;truncate private.source_events cascade;"
 q+="update private.event_collection_control set enabled=true;update private.member_cleanup_guard set external_deletion_approved=true;update private.cancellation_due_control set enabled=true;update private.ai_processing_guard set external_processing_allowed=true;"
 q+='grant execute on function '+','.join('public.'+s for s in signatures+EXTRA[5:7])+' to service_role;'
 for member in [author,target]:
  if not(SUMMARY_RACE and SUMMARY_RACE[0]=='consent'and member==author):q+="insert into auth.users(id,email)values('"+member+"','five-"+member+"@test.invalid');"
  q+="insert into public.profiles(id,real_name,birth_date,gender)values('"+member+"','합성회원','1990-01-01','female');insert into private.ai_member_processing(user_id,summary_allowed)values('"+member+"',true);"
 for i in range(1,6):
  post,request,appointment,review=uid(100+i),uid(200+i),uid(300+i),uid(400+i)
  q+="insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)values('"+post+"','"+author+"','합성 요약 공고','로컬 연결 검증','산책',now()-interval'12 days',now()-interval'11 days',now()-interval'13 days','서울특별시 강남구 역삼동','closed');"
  q+="insert into public.join_requests(id,post_id,requester_id,message,status)values('"+request+"','"+post+"','"+target+"','합성 후기 검증 신청','matched');"
  q+="insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)values('"+appointment+"','"+post+"','"+request+"','completed',now()-interval'10 days','automatic',now()-interval'10 days',now()-interval'9 days',now()-interval'3 days');"
  q+="insert into public.appointment_reviews(id,appointment_id,reviewer_id,rating,comment,experience)values('"+review+"','"+appointment+"','"+author+"',5,"+('null'if i==4 else "'대화가 편안했고 함께한 시간이 즐거웠어요.'")+",'positive');select public.set_review_publication('"+review+"',"+('false'if i==5 else 'true')+');'
 q+="select public.configure_ai_budget_ledger('synthetic-five-kind-summary',100000,10);"
 q+="do $$declare s jsonb;ids uuid[];begin s:=private.refresh_review_summary_state('"+target+"');assert(s->>'eligibleCount')::integer=3;select array_agg((v->>'reviewId')::uuid order by v->>'reviewId')into ids from jsonb_array_elements(s->'reviews')v;assert ids=array['"+"'::uuid,'".join(review_ids[:3])+"'::uuid];perform public.enqueue_job('review_summary','synthetic-five-summary:"+target+"',jsonb_build_object('profileId','"+target+"','sourceRevision',s->>'sourceRevision','modelVersion','synthetic-summary-v1','promptVersion','review-summary-v1'),clock_timestamp()-interval'1 second');end;$$;"
 for _ in range(cancel_count):
  subject='synthetic-five-'+uuid.uuid4().hex
  q+="insert into private.naver_accounts(subject,real_name,birth_date,gender,verification_status)values('"+subject+"','합성회원','1990-01-01','F','qualified');insert into private.cancellation_safety_due(identity_id,next_due_at)select id,clock_timestamp()-interval'1 hour'from private.naver_identity_keys where subject='"+subject+"';"
 q+="do $$declare d date:=(clock_timestamp()at time zone'Asia/Seoul')::date;refs jsonb;begin refs:=jsonb_build_array(jsonb_build_object('provider','kopis','lane','initial_history','period',jsonb_build_object('start',(d-interval'1 month')::date::text,'end',(d-1)::text)),jsonb_build_object('provider','kopis','lane','future','period',jsonb_build_object('start',d::text,'end',(d+30)::text)),jsonb_build_object('provider','kopis','lane','ongoing','period',jsonb_build_object('start',d::text,'end',d::text)));perform public.register_event_collection_jobs('kopis',d,refs,true,null);assert not(public.read_event_collection_contract()->'capabilities'?'ranking_jobs');end;$$;notify pgrst,'reload schema';commit;"
 b.sql(q)
 # 새 Auth의 합성 계정 생성이며 실회원 로그인·원 계정 변경은 없다.
 if PUBLIC_RETIREMENT_MODE:member,withdrawal=fixture_public_member()
 else:
  status,account=auth_request('POST','/admin/users',{'email':'five-cleanup-'+uuid.uuid4().hex+'@test.invalid','password':b.secrets.token_urlsafe(32),'email_confirm':True})
  assert status==200 and uuid.UUID(account['id']),'SYNTHETIC_AUTH_CREATE_REQUIRED'
  member=account['id'];withdrawal=str(uuid.uuid4())
  b.sql("insert into public.profiles(id,real_name,birth_date,gender)values('"+member+"','합성 삭제회원','1990-01-01','female');")
 object_name=member+'/'+str(uuid.uuid4())+'.jpg'
 jpeg=base64.b64decode('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAB//2Q==')
 canary=author+'/'+str(uuid.uuid4())+'.jpg'
 for name in [object_name,canary]:
  code,_=storage_request('POST','/object/profile-images/'+name,jpeg,{'content-type':'image/jpeg'});assert code==200,'SYNTHETIC_MEMBER_BYTES_UPLOAD_FAILED'
 object_id=b.sql("select id from storage.objects where bucket_id='profile-images'and name='"+object_name+"';").decode().strip();uuid.UUID(object_id)
 q="begin;update storage.objects set owner_id='"+member+"'where id='"+object_id+"';"
 if not PUBLIC_RETIREMENT_MODE:
  q+="insert into private.member_retirements(profile_id,withdrawal_id,episode_id)select '"+member+"','"+withdrawal+"',id from private.member_episodes where profile_id='"+member+"'and ended_at is null;update private.member_episodes set ended_at=clock_timestamp()where profile_id='"+member+"'and ended_at is null;"
  q+="insert into private.member_cleanup_tasks(withdrawal_id,kind,profile_id,bucket_id,object_name,object_id)values('"+withdrawal+"','storage_object','"+member+"','profile-images','"+object_name+"','"+object_id+"');insert into private.member_cleanup_tasks(withdrawal_id,kind,profile_id)values('"+withdrawal+"','auth_user','"+member+"');"
 q+="notify pgrst,'reload schema';commit;"
 b.sql(q)
 plan.update({'cleanupMember':member,'cleanupWithdrawal':withdrawal,'cleanupObjectId':object_id,'cleanupObjectName':object_name,'memberCanary':canary,'memberBytesSha256':hashlib.sha256(jpeg).hexdigest(),'publicRetirement':PUBLIC_RETIREMENT_MODE})
 if PUBLIC_RETIREMENT_MODE:plan.update({'expectedJobs':None,'cleanupTasksSeeded':0})
 if SUMMARY_RACE:
  plan['reviewJobId']=str(uuid.UUID(b.sql("select id from private.worker_jobs where dedupe_key='synthetic-five-summary:"+target+"';").decode().strip()))
 b.save('five-fixture-private.json',json.dumps(plan))
 auth_db_readiness()


def summary_race_sql(query):
 # 새 경쟁 분기의 SQL/오류 원문은 메모리에서만 읽는다. 실패 파일에도 고정 code만 남긴다.
 f=b.state();assert f['clone']==b.NAME,'EXACT_SUMMARY_CLONE_REQUIRED'
 result=subprocess.run(b.DOCKER+['exec','-i',b.NAME,'psql','-XqAt','-U',b.BOOT,'-d','postgres',
  '-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate'],input=query.encode(),capture_output=True,timeout=10)
 if result.returncode:
  candidates=re.findall(r'\b(?:22023|40001|42501|55000|23514|23505)\b',result.stderr.decode(errors='replace'))
  b.save('summary-sql-failure-'+str(uuid.uuid4())+'.json',json.dumps({'stage':'SUMMARY_FIXED_SQL','code':candidates[0]if candidates else'UNCLASSIFIED','failed':True}))
  raise RuntimeError('SUMMARY_SQL_FAILED_FIXED_METADATA_PRESERVED')
 return result.stdout

def fixture_review_lane():
 assert REVIEW_LANE_MODE,'REVIEW_LANE_REQUIRED'
 uid=lambda n:'adcafeed-0000-4000-8000-'+str(n).zfill(12)
 ids=[uid(n)for n in [1,2,*range(101,106),*range(201,206),*range(301,306),*range(401,406)]]
 assert len(ids)==len(set(ids))==22
 absent="select not exists(select 1 from(select id from auth.users union all select id from public.profiles union all select id from public.posts union all select id from public.join_requests union all select id from public.appointments union all select id from public.appointment_reviews)existing where id=any(array['"+"','".join(ids)+"']::uuid[]));"
 assert b.sql(absent).decode().strip()=='t','FRESH_SYNTHETIC_NAMESPACE_REQUIRED_NO_INSERT'
 author,target=uid(1),uid(2);reviews=[uid(n)for n in range(401,406)]
 plan={'target':target,'approvedReviewIds':reviews[:3],'comment':'대화가 편안했고 함께한 시간이 즐거웠어요.',
  'chunkTwo':'두 후기에서 편안한 대화와 즐거운 시간을 언급합니다.','chunkOne':'이 후기에서는 편안한 대화와 즐거운 시간을 언급합니다.',
  'summary':'세 후기에서 편안한 대화와 즐거운 시간을 공통으로 언급합니다.','ledgerId':'synthetic-stage3-review','scenario':args.scenario}
 q="begin;select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);"
 if REASSIGNMENT_MODE:
  q+='update private.ai_processing_guard set external_processing_allowed=true;grant execute on function '+','.join('public.'+s for s in FIVE_FUNCTIONS[14:])+' to service_role;'
 else:q+='update private.cancellation_due_control set enabled=true;'
 for member in [author,target]:
  q+="insert into auth.users(id,email)values('"+member+"','stage3-"+member+"@test.invalid');insert into public.profiles(id,real_name,birth_date,gender)values('"+member+"','합성회원','1990-01-01','female');insert into private.ai_member_processing(user_id,summary_allowed)values('"+member+"',true);"
 for i in range(1,6):
  post,request,appointment,review=uid(100+i),uid(200+i),uid(300+i),uid(400+i)
  q+="insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)values('"+post+"','"+author+"','합성 요약 공고','로컬 연결 검증','산책',now()-interval'12 days',now()-interval'11 days',now()-interval'13 days','서울특별시 강남구 역삼동','closed');"
  q+="insert into public.join_requests(id,post_id,requester_id,message,status)values('"+request+"','"+post+"','"+target+"','합성 후기 검증 신청','matched');"
  q+="insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)values('"+appointment+"','"+post+"','"+request+"','completed',now()-interval'10 days','automatic',now()-interval'10 days',now()-interval'9 days',now()-interval'3 days');"
  q+="insert into public.appointment_reviews(id,appointment_id,reviewer_id,rating,comment,experience)values('"+review+"','"+appointment+"','"+author+"',5,"+('null'if i==4 else"'"+plan['comment']+"'")+",'positive');select public.set_review_publication('"+review+"',"+('false'if i==5 else'true')+');'
 q+="select public.configure_ai_budget_ledger('synthetic-stage3-review',100000,10);do $$declare s jsonb;begin s:=private.refresh_review_summary_state('"+target+"');assert(s->>'eligibleCount')::integer=3;perform public.enqueue_job('review_summary','synthetic-stage3-review:"+target+"',jsonb_build_object('profileId','"+target+"','sourceRevision',s->>'sourceRevision','modelVersion','synthetic-summary-v1','promptVersion','review-summary-v1'),clock_timestamp()-interval'1 second');end;$$;notify pgrst,'reload schema';commit;"
 summary_race_sql(q)
 result=json.loads(summary_race_sql("select json_build_object('jobId',id,'revision',payload->>'sourceRevision')from private.worker_jobs where dedupe_key='synthetic-stage3-review:"+target+"';").decode())
 plan.update(result);assert str(uuid.UUID(plan['jobId']))==plan['jobId']and re.fullmatch('[0-9]+',plan['revision'])
 b.save('review-lane-fixture-private.json',json.dumps(plan));initial=review_lane_proof_value()
 assert initial['status']=='queued'and initial['due']is True and initial['eligibleCount']==3 and initial['slotRows']==0 and initial['audit']==[]and initial['parents']==[]
 b.save('review-lane-initial-private.json',json.dumps(initial))

def review_lane_proof_value():
 assert REVIEW_LANE_MODE
 plan=json.loads((b.ROOT/'review-lane-fixture-private.json').read_text());job=str(uuid.UUID(plan['jobId']));target=str(uuid.UUID(plan['target']))
 return json.loads(summary_race_sql(f"""select json_build_object('jobId',j.id,'status',j.status,'revision',j.payload->>'sourceRevision',
 'sourceRevision',st.revision::text,'serverNow',clock_timestamp(),'due',j.available_at<=clock_timestamp(),
 'currentLease',j.lease_token,'leaseExpiresAt',j.lease_expires_at,'jobHash',encode(extensions.digest(to_jsonb(j)::text,'sha256'),'hex'),
 'eligibleCount',jsonb_array_length(private.review_summary_sources('{target}')),
 'visibleCurrent',exists(select 1 from private.review_summaries s where s.id=st.visible_summary_id and s.source_revision=st.revision and cardinality(s.evidence_review_ids)=3),
 'checkpointRows',(select count(*)from private.review_summary_checkpoints where job_id=j.id),
 'checkpointIndex',(select checkpoint->>'nextReviewIndex'from private.review_summary_checkpoints where job_id=j.id),
 'publicationRows',(select count(*)from private.review_summary_job_publications where job_id=j.id),
 'budget',(select json_build_object('openCalls',open_calls,'settledCalls',settled_calls,'unknownCalls',unknown_usage_calls,'reservedUnits',reserved_units)from private.ai_budget_ledgers where ledger_id='synthetic-stage3-review'),
 'reservationRows',(select count(*)from private.ai_budget_reservations where ledger_id='synthetic-stage3-review'),
 'slotRows',(select count(*)from private.worker_runtime_job_slots where job_id=j.id),
 'slotTokens',(select coalesce(json_agg(global_token),'[]')from private.worker_runtime_job_slots where job_id=j.id),
 'audit',(select coalesce(json_agg(json_build_object('parent',a.request_id,'lease',a.job_lease_token,'claimSeq',a.claim_seq,'settled',a.settled_status,'effect',a.effect)order by a.claim_seq),'[]')from private.worker_invocation_jobs a where a.job_id=j.id),
 'parents',(select coalesce(json_agg(json_build_object('stored',private.worker_invocation_json(r),'createdAt',r.created_at,'deadline',r.deadline,'claimCalls',r.claim_calls,'idleSeen',r.idle_seen)),'[]')from private.worker_invocations r where r.kind='review_summary'),
 'lease',(select json_build_object('token',token,'expiresAt',expires_at)from private.global_worker_run),
 'protectionDigest',encode(extensions.digest(jsonb_build_array(
  (select coalesce(jsonb_agg(to_jsonb(x)order by x.request_id),'[]')from private.worker_invocations x where x.state='unknown'),
  (select coalesce(jsonb_agg(to_jsonb(x)order by x.task_id),'[]')from private.report_purge_delete_acks x),
  (select coalesce(jsonb_agg(to_jsonb(x)order by x.task_id),'[]')from private.member_cleanup_delete_acks x))::text,'sha256'),'hex'))
 from private.worker_jobs j join private.review_summary_state st on st.profile_id='{target}'where j.id='{job}';""").decode())

def review_lane_proof():print(json.dumps(review_lane_proof_value()))

def summary_race_proof_value():
 assert SUMMARY_RACE,'SUMMARY_RACE_REQUIRED'
 plan=json.loads((b.ROOT/'five-fixture-private.json').read_text())
 target=str(uuid.UUID(plan['reviewTarget']));author=str(uuid.UUID(plan['reviewAuthor']));job=str(uuid.UUID(plan['reviewJobId']))
 review=str(uuid.UUID(plan['approvedReviewIds'][0]))
 value=json.loads(summary_race_sql(f"""select json_build_object(
  'jobId',j.id,'target',j.payload->>'profileId','jobRevision',j.payload->>'sourceRevision','jobStatus',j.status,
  'scope',json_build_object('jobId',j.id,'leaseToken',a.job_lease_token,'workerRunToken',r.global_token,
    'sourceRevision',j.payload->>'sourceRevision','contractVersion','2026-10-05','parent',r.request_id),
  'dispatchable',coalesce(j.status='running'and j.lease_token=a.job_lease_token and exists(select 1 from private.worker_job_run_fences fence
    where fence.job_id=j.id and fence.job_lease_token=a.job_lease_token and fence.worker_run_token=r.global_token)
   and r.kind='review_summary'and r.state='prepared'and r.dispatch_started and r.deadline>clock_timestamp()
   and j.lease_expires_at>clock_timestamp()and exists(select 1 from private.global_worker_run g
     where g.token=r.global_token and g.expires_at>clock_timestamp()),false),
  'settledStatus',a.settled_status,'effect',a.effect,
  'revision',st.revision::text,'visibleNull',st.visible_summary_id is null,
  'checkpoints',(select count(*)from private.review_summary_checkpoints where job_id=j.id),
  'published',(select count(*)from private.review_summary_job_publications where job_id=j.id),
  'eligibleCount',jsonb_array_length(private.review_summary_sources('{target}'::uuid)),
  'authorConsent',m.summary_allowed,'authorWithdrawn',m.summary_withdrawn_at is not null,
  'publicReviewCount',(select count(*)from public.appointment_reviews rv where rv.reviewer_id='{author}'and rv.id in(
    select jsonb_array_elements_text('{json.dumps(plan['approvedReviewIds'])}'::jsonb)::uuid)and private.is_review_public_eligible(rv.id)),
  'selectedReviewExists',exists(select 1 from public.appointment_reviews where id='{review}'),
  'reviewerExact',exists(select 1 from public.appointment_reviews where id='{review}'and reviewer_id='{author}'),
  'commentHash',(select encode(extensions.digest(comment,'sha256'),'hex')from public.appointment_reviews where id='{review}'),
  'authorProfilePresent',exists(select 1 from public.profiles where id='{author}'),
  'originalAppointments', (select count(*)from public.appointments ap join public.posts p on p.id=ap.post_id
    where p.author_id='{author}'and ap.status='completed'),
  'checkpointDigest',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(c)order by c.job_id),'[]')::text,'sha256'),'hex')
    from private.review_summary_checkpoints c where c.job_id=j.id))
 from private.worker_jobs j join private.review_summary_state st on st.profile_id='{target}'
 join private.ai_member_processing m on m.user_id='{author}'
 left join private.worker_invocation_jobs a on a.job_id=j.id
 left join private.worker_invocations r on r.request_id=a.request_id where j.id='{job}';""").decode())
 assert isinstance(value,dict)and value['jobId']==job and value['target']==target,'SUMMARY_RACE_PROOF_MISSING'
 return value

def summary_race_proof():print(json.dumps(summary_race_proof_value()))

def summary_insufficient_context(proof,mutation):
 # 원 revision 경쟁의 종결 이후에만 최신 적격 부족 작업을 별도로 만든다.
 assert mutation in('hide','delete','consent'),'LATEST_INSUFFICIENT_BRANCH_REQUIRED'
 assert proof['jobStatus']=='superseded'and proof['settledStatus']=='superseded'and proof['effect']is None,'ORIGINAL_SUPERSEDED_PROOF_REQUIRED'
 assert proof['dispatchable']is False and proof['visibleNull']is True and proof['checkpoints']==0 and proof['published']==0
 assert proof['jobRevision']==proof['scope']['sourceRevision']and re.fullmatch(r'[0-9]+',proof['revision'])and int(proof['revision'])>int(proof['jobRevision'])
 assert type(proof['eligibleCount'])is int and type(proof['publicReviewCount'])is int and proof['eligibleCount']==(0 if mutation=='consent'else 2)and proof['publicReviewCount']==(3 if mutation=='consent'else 2),'EXACT_LATEST_ELIGIBLE_COUNT_REQUIRED'
 if mutation=='consent':assert proof['authorConsent']is False and proof['authorWithdrawn']is True
 assert proof['authorProfilePresent']is True and proof['originalAppointments']==5
 for key in('jobId','target'):assert str(uuid.UUID(proof[key]))==proof[key]
 assert set(proof['scope'])=={'jobId','leaseToken','workerRunToken','sourceRevision','contractVersion','parent'}
 for key in('jobId','leaseToken','workerRunToken','parent'):assert str(uuid.UUID(proof['scope'][key]))==proof['scope'][key]
 assert proof['scope']['jobId']==proof['jobId']and proof['scope']['contractVersion']=='2026-10-05'
 return{'originalScope':proof['scope'],'target':proof['target'],'sourceRevision':proof['revision'],'eligibleCount':proof['eligibleCount']}

def summary_insufficient_enqueue():
 assert SUMMARY_RACE,'SUMMARY_RACE_REQUIRED'
 frozen=json.loads((b.ROOT/'safety-apply-started.json').read_text())
 for path,digest in{**frozen['files'],**frozen['product']}.items():assert hashlib.sha256((REPO/path).read_bytes()).hexdigest()==digest,'FROZEN_SOURCE_CHANGED'
 assert hashlib.sha256(Path(spec.origin).read_bytes()).hexdigest()==frozen['baseHarnessSha256'],'BASE_HARNESS_CHANGED'
 run_receipts=list(b.ROOT.glob('run-*-source.json'));assert len(run_receipts)==1
 assert json.loads(run_receipts[0].read_text())=={'python':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'typescript':hashlib.sha256(Path(__file__).with_name('worker_safety_http.ts').read_bytes()).hexdigest()},'RUN_HARNESS_CHANGED'
 assert not(b.ROOT/'summary-insufficient-enqueue-intent.json').exists(),'LATEST_ENQUEUE_NEVER_REPLAYED'
 before=summary_race_proof_value();context=summary_insufficient_context(before,SUMMARY_RACE[0])
 mutation=json.loads((b.ROOT/'summary-race-mutation-proof.json').read_text())
 assert mutation['after']['scope']==context['originalScope']and mutation['after']['revision']==context['sourceRevision'],'ORIGINAL_RACE_SCOPE_CHANGED'
 target=context['target'];job=context['originalScope']['jobId'];parent=context['originalScope']['parent'];revision=context['sourceRevision'];count=context['eligibleCount']
 dedupe='synthetic-five-insufficient:'+target+':'+revision
 # 원 키를 보존하는 일회 fixture enqueue 기록이다. 응답 유실이면 다시 enqueue하지 않는다.
 b.save('summary-insufficient-enqueue-intent.json',json.dumps(context))
 result=json.loads(summary_race_sql(f"""begin;select set_config('request.jwt.claims','{{"role":"service_role"}}',true);
 do $$begin
  assert exists(select 1 from private.worker_jobs j join private.worker_invocation_jobs a on a.job_id=j.id
   join private.worker_invocations r on r.request_id=a.request_id where j.id='{job}'and j.status='superseded'
   and a.settled_status='superseded'and a.effect is null and r.request_id='{parent}'and r.state='completed'
   and r.result->>'status'='ran'and(r.result#>>'{{counts,superseded}}')::integer=1);
  assert exists(select 1 from private.review_summary_state where profile_id='{target}'and revision::text='{revision}'and visible_summary_id is null);
  assert jsonb_array_length(private.review_summary_sources('{target}'))={count};
  assert not exists(select 1 from private.worker_jobs where kind='review_summary'and dedupe_key='{dedupe}');
 end;$$;
 select public.enqueue_job('review_summary','{dedupe}',jsonb_build_object('profileId','{target}','sourceRevision','{revision}',
  'modelVersion','synthetic-summary-v1','promptVersion','review-summary-v1'),clock_timestamp()-interval'1 second');commit;""").decode().splitlines()[-1])
 assert set(result)=={'jobId','deduplicated','status'}and result['deduplicated']is False and result['status']=='queued'
 latest=str(uuid.UUID(result['jobId']));assert latest!=job
 context['jobId']=latest;b.save('summary-insufficient-enqueued-private.json',json.dumps(context))
 assert summary_race_proof_value()==before,'ORIGINAL_SUPERSEDED_SCOPE_CHANGED'
 print(json.dumps(context))

def summary_insufficient_proof():
 context=json.loads((b.ROOT/'summary-insufficient-enqueued-private.json').read_text())
 assert set(context)=={'originalScope','target','sourceRevision','eligibleCount','jobId'}
 job=str(uuid.UUID(context['jobId']));target=str(uuid.UUID(context['target']))
 value=json.loads(summary_race_sql(f"""select json_build_object('jobId',j.id,'target',j.payload->>'profileId',
  'jobRevision',j.payload->>'sourceRevision','revision',st.revision::text,'jobStatus',j.status,
  'settledStatus',a.settled_status,'effect',a.effect,'auditClaims',(select count(*)from private.worker_invocation_jobs where job_id=j.id),
  'parent',private.worker_invocation_json(r),'leaseToken',a.job_lease_token,
  'eligibleCount',jsonb_array_length(private.review_summary_sources('{target}')),'visibleNull',st.visible_summary_id is null,
  'checkpoints',(select count(*)from private.review_summary_checkpoints where profile_id='{target}'),
  'published',(select count(*)from private.review_summary_job_publications where profile_id='{target}'),
  'slotExact',exists(select 1 from private.worker_runtime_job_slots sl where sl.job_id=j.id and sl.global_token=r.global_token))
 from private.worker_jobs j join private.review_summary_state st on st.profile_id='{target}'
 left join private.worker_invocation_jobs a on a.job_id=j.id left join private.worker_invocations r on r.request_id=a.request_id
 where j.id='{job}';""").decode())
 assert value['jobId']==job and value['target']==target
 print(json.dumps(value))

def summary_race_context(context,proof,plan):
 expected=['jobId','leaseToken','workerRunToken','sourceRevision','contractVersion','parent','phase','mutation']
 assert isinstance(context,dict)and sorted(context)==sorted(expected),'EXACT_SUMMARY_RACE_CONTEXT_REQUIRED'
 for key in ['jobId','leaseToken','workerRunToken','parent']:assert str(uuid.UUID(context[key]))==context[key]
 assert context['phase']==SUMMARY_RACE[1]and context['mutation']==SUMMARY_RACE[0],'SUMMARY_RACE_BRANCH_MISMATCH'
 assert context['contractVersion']=='2026-10-05'and re.fullmatch(r'[0-9]+',context['sourceRevision']),'SUMMARY_RACE_CONTRACT_MISMATCH'
 assert isinstance(proof.get('scope'),dict)and sorted(proof['scope'])==sorted(expected[:-2]),'EXACT_ORIGINAL_SUMMARY_SCOPE_REQUIRED'
 assert plan['approvedComment']=='대화가 편안했고 함께한 시간이 즐거웠어요.','FIXED_SUMMARY_FIXTURE_REQUIRED'
 assert {key:context[key]for key in proof['scope']}==proof['scope'],'SUMMARY_RACE_ORIGINAL_SCOPE_MISMATCH'
 assert proof['dispatchable']is True and proof['settledStatus']is None,'LIVE_ORIGINAL_SUMMARY_CLAIM_REQUIRED'
 assert proof['revision']==context['sourceRevision']and proof['reviewerExact']is True,'SUMMARY_RACE_ORIGINAL_REVISION_REQUIRED'
 assert proof['commentHash']==hashlib.sha256(plan['approvedComment'].encode()).hexdigest(),'SUMMARY_RACE_ORIGINAL_COMMENT_MISMATCH'
 assert proof['eligibleCount']==3 and proof['publicReviewCount']==3 and proof['authorConsent']is True,'SUMMARY_RACE_ORIGINAL_EVIDENCE_REQUIRED'
 assert proof['visibleNull']is True and proof['published']==0,'SUMMARY_RACE_PRIOR_PUBLICATION_REJECTED'
 assert proof['checkpoints']==(1 if SUMMARY_RACE[1]=='publish'else 0),'SUMMARY_RACE_CHECKPOINT_PHASE_MISMATCH'

def summary_consent_request(token,kind):
 f=b.state();body=json.dumps({'p_kind':kind}).encode()
 headers={'apikey':f['anonKey'],'content-type':'application/json'}
 if token is not None:headers['authorization']='Bearer '+token
 request=urllib.request.Request('http://127.0.0.1:'+str(f['restPort'])+'/rpc/withdraw_my_ai_processing',data=body,method='POST',headers=headers)
 try:
  with urllib.request.urlopen(request,timeout=10)as response:return response.status,json.loads(response.read())
 except urllib.error.HTTPError as error:return error.code,json.loads(error.read())

def summary_race_mutate():
 assert SUMMARY_RACE,'SUMMARY_RACE_REQUIRED'
 frozen=json.loads((b.ROOT/'safety-apply-started.json').read_text())
 for path,digest in {**frozen['files'],**frozen['product']}.items():assert hashlib.sha256((REPO/path).read_bytes()).hexdigest()==digest,'FROZEN_SOURCE_CHANGED'
 assert hashlib.sha256(Path(spec.origin).read_bytes()).hexdigest()==frozen['baseHarnessSha256'],'BASE_HARNESS_CHANGED'
 run_receipts=list(b.ROOT.glob('run-*-source.json'));assert len(run_receipts)==1,'EXACT_RUN_SOURCE_REQUIRED'
 run_source=json.loads(run_receipts[0].read_text());assert run_source=={'python':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'typescript':hashlib.sha256(Path(__file__).with_name('worker_safety_http.ts').read_bytes()).hexdigest()},'RUN_HARNESS_CHANGED'
 assert not(b.ROOT/'summary-race-mutation-intent.json').exists(),'SUMMARY_RACE_MUTATION_NEVER_REPLAYED'
 context=json.loads((b.ROOT/'summary-race-gate-private.json').read_text());plan=json.loads((b.ROOT/'five-fixture-private.json').read_text())
 before=summary_race_proof_value();summary_race_context(context,before,plan)
 b.save('summary-race-mutation-intent.json',json.dumps({'scope':context,'attempt':1}))
 mutation=SUMMARY_RACE[0]
 if mutation=='consent':
  session=json.loads((b.ROOT/'summary-author-session-private.json').read_text());assert session['actualSession']is True and session['author']==plan['reviewAuthor']
  controls=[('missing',None,'review_summary',401,{'42501'}),
   ('expired',session['negativeTokens']['expired'],'review_summary',401,{'PGRST301','PGRST303'}),
   ('wrong_signature',session['negativeTokens']['wrong_signature'],'review_summary',401,{'PGRST301'}),
   ('anonymous',session['negativeTokens']['anonymous'],'review_summary',403,{'28000'}),
   ('invalid_kind',session['token'],'invalid',400,{'22023'})]
  evidence=[]
  for name,token,kind,status,codes in controls:
   actual,value=summary_consent_request(token,kind)
   assert actual==status and isinstance(value,dict)and value.get('code')in codes,'SUMMARY_CONSENT_NEGATIVE_NOT_PROVEN'
   assert summary_race_proof_value()==before,'SUMMARY_CONSENT_NEGATIVE_MUTATED_ORIGINAL'
   evidence.append({'control':name,'status':actual,'sqlCode':value['code'],'unchanged':True})
  summary_race_context(context,summary_race_proof_value(),plan)
  status,value=summary_consent_request(session['token'],'review_summary')
  assert status==200 and value=={'withdrawn':True},'SIGNED_SUMMARY_CONSENT_NOT_COMMITTED'
  b.save('summary-consent-negative-proof.json',json.dumps(evidence))
 else:
  review=str(uuid.UUID(plan['approvedReviewIds'][0]));job=str(uuid.UUID(context['jobId']));lease=str(uuid.UUID(context['leaseToken']));token=str(uuid.UUID(context['workerRunToken']));parent=str(uuid.UUID(context['parent']))
  if mutation=='edit':
   text=plan['changedComment'];assert text=='편안하게 이야기하며 함께한 시간이 즐거웠습니다.'
   command="update public.appointment_reviews set comment='"+text+"'where id='"+review+"';"
  elif mutation=='hide':command="select public.set_review_publication('"+review+"',false);"
  else:
   assert mutation=='delete';command="delete from public.appointment_reviews where id='"+review+"';"
  summary_race_sql(f"""begin;select set_config('request.jwt.claims','{{"role":"service_role"}}',true);
   do $$begin assert exists(select 1 from private.worker_jobs j join private.worker_invocation_jobs a on a.job_id=j.id
    join private.worker_invocations r on r.request_id=a.request_id where j.id='{job}'and j.lease_token='{lease}'
    and j.status='running'and a.job_lease_token='{lease}'and a.settled_status is null and r.request_id='{parent}'
    and r.global_token='{token}'and r.state='prepared'and r.dispatch_started
    and exists(select 1 from private.worker_job_run_fences fence where fence.job_id=j.id and fence.job_lease_token=a.job_lease_token and fence.worker_run_token=r.global_token) and r.deadline>clock_timestamp()
    and j.lease_expires_at>clock_timestamp()and j.payload->>'sourceRevision'='{context['sourceRevision']}'
    and exists(select 1 from private.global_worker_run g where g.token=r.global_token and g.expires_at>clock_timestamp()));end;$$;
   {command}commit;""")
 after=summary_race_proof_value();assert int(after['revision'])>int(before['revision']),'SUMMARY_RACE_REVISION_NOT_CHANGED'
 assert after['visibleNull']is True and after['checkpoints']==0 and after['published']==0,'SUMMARY_RACE_INVALIDATION_NOT_PROVEN'
 assert after['scope']==before['scope']and after['jobStatus']=='running'and after['settledStatus']is None,'ORIGINAL_SCOPE_OR_CLAIM_CHANGED'
 assert after['eligibleCount']=={'edit':3,'hide':2,'delete':2,'consent':0}[mutation]
 assert after['publicReviewCount']==(2 if mutation in('hide','delete')else 3)
 assert after['authorProfilePresent']is True and after['originalAppointments']==5
 if mutation=='consent':assert after['authorConsent']is False and after['authorWithdrawn']is True
 if mutation=='delete':assert after['selectedReviewExists']is False
 if mutation=='edit':assert after['commentHash']==hashlib.sha256(plan['changedComment'].encode()).hexdigest()
 b.save('summary-race-mutation-proof.json',json.dumps({'mutation':mutation,'phase':SUMMARY_RACE[1],'mutations':1,'before':before,'after':after,'signedConsentRpc':mutation=='consent'}))
 print(json.dumps({'status':'FIXTURE_MUTATION_COMMITTED','mutations':1,'revisionChanged':True,'checkpointRemoved':True}))

def storage_proof():
 fixture=json.loads((b.ROOT/'storage-fixture-private.json').read_text());checks=[]
 for name in fixture['names']:
  code,body=storage_request('GET','/object/authenticated/report-evidence/'+name)
  checks.append(code in(400,404)and json.loads(body).get('statusCode')in('404',404))
 code,body=storage_request('GET','/object/authenticated/report-evidence/'+fixture['canary'])
 assert code==200 and hashlib.sha256(body).hexdigest()==fixture['sha256'],'UNRELATED_CANARY_BYTES_CHANGED'
 assert storage_source_proof()[0]==json.loads((b.ROOT/'storage-source-private.json').read_text()),'SOURCE_STORAGE_CHANGED'
 print(json.dumps({'deletedBytesAbsent':all(checks),'deletedFiles':len(checks),'canaryUnchanged':True,'sourceStorageUnchanged':True}))

def five_proof():
 assert FIVE_MODE,'FIVE_KIND_SCENARIO_REQUIRED'
 plan=json.loads((b.ROOT/'five-fixture-private.json').read_text())
 member=str(uuid.UUID(plan['cleanupMember']))
 code,body=storage_request('GET','/object/authenticated/profile-images/'+plan['cleanupObjectName'])
 assert code in(400,404)and json.loads(body).get('statusCode')in('404',404),'MEMBER_BYTES_STILL_PRESENT'
 code,body=storage_request('GET','/object/authenticated/profile-images/'+plan['memberCanary'])
 assert code==200 and hashlib.sha256(body).hexdigest()==plan['memberBytesSha256'],'MEMBER_CANARY_CHANGED'
 assert auth_request('GET','/admin/users/'+member)[0]==404,'MEMBER_AUTH_STILL_PRESENT'
 out={'memberDeletedBytesAbsent':True,'memberCanaryUnchanged':True,'localAuthUserAbsent':True}
 print(json.dumps(out))

def retirement_proof():
 assert PUBLIC_RETIREMENT_MODE,'PUBLIC_RETIREMENT_SCENARIO_REQUIRED'
 plan=json.loads((b.ROOT/'five-fixture-private.json').read_text());member=str(uuid.UUID(plan['cleanupMember']));withdrawal=str(uuid.UUID(plan['cleanupWithdrawal']))
 query="""begin read only;select json_build_object(
 'retirements',(select count(*)from private.member_retirements where profile_id='"""+member+"""'),
 'state',(select state from private.member_retirements where withdrawal_id='"""+withdrawal+"""'),
 'fingerprint',(select request_fingerprint from private.member_retirements where withdrawal_id='"""+withdrawal+"""'),
 'episodeMatches',(select e.ended_at=r.retired_at and e.profile_id=r.profile_id from private.member_retirements r join private.member_episodes e on e.id=r.episode_id where r.withdrawal_id='"""+withdrawal+"""'),
 'profileScrubbed',(select real_name is null and birth_date is null and gender is null and avatar_url is null and bio is null from public.profiles where id='"""+member+"""'),
 'activeEpisodes',(select count(*)from private.member_episodes where profile_id='"""+member+"""'and ended_at is null),
 'naverLinked',(select count(*)from private.naver_accounts where user_id='"""+member+"""'),
 'authUsers',(select count(*)from auth.users where id='"""+member+"""'),
 'authSessions',(select count(*)from auth.sessions where user_id='"""+member+"""'),
 'tasks',(select count(*)from private.member_cleanup_tasks where withdrawal_id='"""+withdrawal+"""'),
 'tasksByKind',(select json_object_agg(kind,n)from(select kind,count(*)n from private.member_cleanup_tasks where withdrawal_id='"""+withdrawal+"""'group by kind)s),
 'tasksPending',(select count(*)from private.member_cleanup_tasks where withdrawal_id='"""+withdrawal+"""'and state='pending'),
 'tasksCompleted',(select count(*)from private.member_cleanup_tasks where withdrawal_id='"""+withdrawal+"""'and state='completed'),
 'acks',(select count(*)from private.member_cleanup_delete_acks where withdrawal_id='"""+withdrawal+"""'),
 'dispatches',(select count(*)from private.member_cleanup_dispatches d join private.member_cleanup_tasks t on t.id=d.task_id where t.withdrawal_id='"""+withdrawal+"""'),
 'memberJobCount',(select count(*)from private.worker_jobs j join private.member_cleanup_tasks t on t.id=j.id where t.withdrawal_id='"""+withdrawal+"""'),
 'memberJobsSucceeded',(select count(*)from private.worker_jobs j join private.member_cleanup_tasks t on t.id=j.id where t.withdrawal_id='"""+withdrawal+"""'and j.status='succeeded'),
 'nonMemberSeededJobs',(select count(*)from private.worker_jobs where kind<>'member_cleanup'),
 'dueCancellationInputs',(select count(*)from private.cancellation_safety_due where next_due_at<=clock_timestamp()),
 'dueReports',(select count(*)from private.member_reports where retention_due_at<=clock_timestamp()and final_closed_at is not null),
 'receiptDigest',(select encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex')from private.member_retirements r where r.withdrawal_id='"""+withdrawal+"""'),
 'taskDigest',(select encode(extensions.digest(coalesce(string_agg(to_jsonb(t)::text,','order by t.id),''),'sha256'),'hex')from private.member_cleanup_tasks t where withdrawal_id='"""+withdrawal+"""'),
 'jobDigest',(select encode(extensions.digest(coalesce(string_agg(to_jsonb(j)::text,','order by j.id),''),'sha256'),'hex')from private.worker_jobs j join private.member_cleanup_tasks t on t.id=j.id where t.withdrawal_id='"""+withdrawal+"""'),
 'ackDigest',(select encode(extensions.digest(coalesce(string_agg(to_jsonb(a)::text,','order by a.task_id),''),'sha256'),'hex')from private.member_cleanup_delete_acks a where withdrawal_id='"""+withdrawal+"""'),
 'dispatchDigest',(select encode(extensions.digest(coalesce(string_agg(to_jsonb(d)::text,','order by d.task_id),''),'sha256'),'hex')from private.member_cleanup_dispatches d join private.member_cleanup_tasks t on t.id=d.task_id where t.withdrawal_id='"""+withdrawal+"""'),
 'catalogAclDigest',(select encode(extensions.digest(jsonb_build_object(
  'relations',(select jsonb_agg(to_jsonb(c)-array['relpages','reltuples','relallvisible','relfrozenxid','relminmxid','relallfrozen']order by c.oid)from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')),
  'attributes',(select jsonb_agg(to_jsonb(a)order by a.attrelid,a.attnum)from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')),
  'constraints',(select jsonb_agg(to_jsonb(c)order by c.oid)from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in('public','private','auth','storage')),
  'policies',(select jsonb_agg(to_jsonb(p)order by p.oid)from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')),
  'functions',(select jsonb_agg(to_jsonb(p)order by p.oid)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private','auth','storage')),
  'roles',(select jsonb_agg(to_jsonb(r)order by r.oid)from pg_roles r),
  'memberships',(select jsonb_agg(to_jsonb(m)order by m.roleid,m.member,m.grantor)from pg_auth_members m)
 )::text,'sha256'),'hex'))
 );rollback;"""
 value=json.loads(b.sql(query).decode());code,body=storage_request('GET','/object/authenticated/profile-images/'+plan['cleanupObjectName'])
 value['memberBytesPresent']=code==200 and hashlib.sha256(body).hexdigest()==plan['memberBytesSha256'];value['memberBytesAbsent']=code in(400,404)and json.loads(body).get('statusCode')in(404,'404')
 code,body=storage_request('GET','/object/authenticated/profile-images/'+plan['memberCanary']);assert code==200 and hashlib.sha256(body).hexdigest()==plan['memberBytesSha256'],'PUBLIC_CANARY_CHANGED';value['canaryUnchanged']=True
 print(json.dumps(value))

def source_full_snapshot():
 # 기존 전체 행·catalog·역할/ACL 읽기 helper를 재사용한다. 원 DB는 b.sql의 READ ONLY 경계를 유지한다.
 path=REPO/'tests/integration/minkyu/member_retirement_auth_local.py'
 module_spec=importlib.util.spec_from_file_location('public_retirement_source_snapshot',path)
 helper=importlib.util.module_from_spec(module_spec);previous=sys.argv
 try:
  sys.argv=[str(path)];module_spec.loader.exec_module(helper)
 finally:sys.argv=previous
 helper.REPO=REPO;helper.sql=lambda query,name:b.sql(query,name).decode().strip()
 value=helper.snapshot(b.SOURCE)
 value['membershipGrantors']=json.loads(b.sql("select coalesce(json_agg(json_build_array(pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor),admin_option,inherit_option,set_option)order by pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor)),'[]')from pg_auth_members;",b.SOURCE).decode())
 return value

def prepare():
 if STORAGE_MODE or BUDGET_MODE or REVIEW_LANE_MODE:
  # VM 전체 OOM을 유발하는 시작을 fixture·clone 생성 전에 거절한다. 다른 환경을 종료하지 않는다.
  raw=b.docker('exec',b.SOURCE,'cat','/proc/meminfo').decode()
  available=int(next(line.split()[1]for line in raw.splitlines()if line.startswith('MemAvailable:')))
  assert available>=(1024 if FIVE_MODE else 768)*1024,'STORAGE_STARTUP_MEMORY_HEADROOM_REQUIRED_NO_CLONE'
 source_before=source_full_snapshot()if PUBLIC_RETIREMENT_MODE or SUMMARY_RACE or BUDGET_MODE or REVIEW_LANE_MODE else None
 b.prepare()
 if PUBLIC_RETIREMENT_MODE or SUMMARY_RACE or BUDGET_MODE or REVIEW_LANE_MODE:
  assert source_full_snapshot()==source_before,'FULL_SOURCE_CHANGED_DURING_PREPARE'
  b.save('source-full-before-private.json',json.dumps(source_before))
 files = {str(Path('backend/supabase/migrations') / n): hashlib.sha256((REPO/'backend/supabase/migrations'/n).read_bytes()).hexdigest() for n in MIGRATIONS}
 # Recipe receipt precedes the first SQL apply; no unknown partial apply is resumed.
 product_paths=['backend/supabase/functions/_shared/jobs/runtime.ts','backend/supabase/functions/_shared/jobs/safety-consumers.ts','backend/supabase/functions/_shared/db/worker-runtime-client.ts','backend/supabase/functions/_shared/db/repositories/jobs.ts','backend/supabase/functions/_shared/db/internal-client.ts','backend/supabase/functions/_shared/jobs/background.mjs','backend/supabase/functions/scheduled-jobs/queue-runner.mjs','backend/supabase/functions/_shared/services/report-retention-storage.ts']
 if BUDGET_MODE:product_paths+=['backend/supabase/functions/service-api/index.ts']
 if FIVE_MODE:product_paths+=['backend/supabase/functions/event-sync/index.ts','backend/supabase/functions/review-summary-worker/index.ts','backend/supabase/functions/service-api/index.ts']
 if REVIEW_LANE_MODE:product_paths+=['backend/supabase/functions/review-summary-worker/index.ts','backend/supabase/functions/_shared/ai/providers/provider-adapter.ts','backend/supabase/functions/_shared/ai/providers/privacy.ts','backend/supabase/functions/_shared/ai/providers/budget.ts']
 seen=set();pending=[REPO/p for p in product_paths]
 while pending:
  path=pending.pop().resolve()
  if path in seen:continue
  assert path.is_relative_to(REPO.resolve()),'PRODUCT_IMPORT_OUTSIDE_REPO'
  seen.add(path)
  for dep in re.findall(r'''(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']''',path.read_text()):
   target=(path.parent/dep).resolve()
   if target.is_file()and target.suffix in('.ts','.mjs','.js'):pending.append(target)
 product={str(p.relative_to(REPO)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(seen)}
 if PUBLIC_RETIREMENT_MODE or SUMMARY_RACE or BUDGET_MODE or REVIEW_LANE_MODE:
  for relative in ('tests/integration/minkyu/member_retirement_auth_local.py','tools/local/remote_schema_catalog.sql'):
   product[relative]=hashlib.sha256((REPO/relative).read_bytes()).hexdigest()
 base_hash=hashlib.sha256(Path(spec.origin).read_bytes()).hexdigest()
 b.save('safety-apply-started.json', json.dumps({'files':files,'product':product,'baseHarnessSha256':base_hash}))
 for n in MIGRATIONS:
  b.sql((REPO/'backend/supabase/migrations'/n).read_text())
 if REVIEW_LANE_MODE:
  b.SIGNATURES+=FIVE_FUNCTIONS[14:]
  b.sql('revoke all on function '+','.join('public.'+s for s in FIVE_FUNCTIONS[14:])+' from public,anon,authenticated,service_role,yumidang_worker_queue;')
  b.save('review-lane-rpc-signatures.json',json.dumps(FIVE_FUNCTIONS[14:]))
 if FIVE_MODE:
  global FIVE_SIGNATURES
  FIVE_SIGNATURES=FIVE_FUNCTIONS
  for sig in FIVE_SIGNATURES:
   assert b.sql("select to_regprocedure('public."+sig+"')is not null;").decode().strip()=='t','FIVE_KIND_RPC_CONTRACT_MISSING'
  b.save('five-rpc-signatures.json',json.dumps(FIVE_SIGNATURES))
  b.SIGNATURES+=FIVE_SIGNATURES+RECOVERY_FUNCTIONS+((DISCOVERY_FUNCTION,)if RECOVERY_MODE else ())
  b.sql('revoke all on function '+','.join('public.'+s for s in FIVE_SIGNATURES)+' from public,anon,authenticated,service_role,yumidang_worker_queue;')
 closed(b.NAME)
 if STORAGE_MODE:prepare_storage()
 if FIVE_MODE:prepare_auth()
 b.save('owned-container-baseline.json',json.dumps(owned_metadata()))
 b.save('safety-prepared.json', json.dumps({'scenario':args.scenario,'revision':args.revision,'migrationHashes':files,'status':'PREPARED_NOT_RUN'}))
 print('SAFETY114_PREPARED_NOT_ACTIVATED')

def fixture():
 f = b.state()
 assert (b.ROOT/'safety-prepared.json').is_file(), 'SAFETY_PREPARE_REQUIRED'
 frozen=json.loads((b.ROOT/'safety-apply-started.json').read_text())
 assert hashlib.sha256(Path(spec.origin).read_bytes()).hexdigest()==frozen['baseHarnessSha256'], 'BASE_HARNESS_CHANGED'
 for path,digest in {**frozen['files'],**frozen['product']}.items():assert hashlib.sha256((REPO/path).read_bytes()).hexdigest()==digest, 'FROZEN_SOURCE_CHANGED'
 assert not (b.ROOT/'fixture-started.json').exists(), 'FIXTURE_NO_AUTOMATIC_REPLAY'
 b.save('fixture-started.json', '{}')
 q = "truncate private.worker_jobs,private.worker_runtime_intents,private.worker_runtime_results,private.worker_runtime_job_slots,private.member_cleanup_dispatches,private.worker_invocations cascade;delete from private.ai_feedback_receipts where action='helpful';delete from private.report_purge_terminal_receipts;update private.cancellation_safety_due set next_due_at=null;update private.global_worker_run set token=null,expires_at=null;"
 if STORAGE_MODE:q+='truncate private.report_purge_dispatches,private.report_purge_delete_acks,private.report_purge_tasks,private.report_purge_closures cascade;'
 q += "update private.worker_invocation_control set enabled=true;update private.worker_runtime_atomic_control set enabled=true;update private.worker_runtime_journal_control set enabled=true;update private.worker_intent_confirmation_control set enabled=true;update private.ai_feedback_maintenance_control set enabled=true;"
 grants = BASE_SIGNATURES + EXTRA[:5] + (EXTRA[5:7] if CANCELLATION_MODE else ()if REVIEW_LANE_MODE else EXTRA[7:])+((DISCOVERY_FUNCTION,)if RECOVERY_MODE else ())
 q += 'grant execute on function ' + ','.join('public.'+s for s in grants) + ' to service_role;grant execute on function public.read_report_terminal_maintenance_schedule_v2(uuid)to yumidang_worker_queue;'
 if REVIEW_LANE_MODE:
  b.sql(q);fixture_review_lane();b.verify_tls_and_role(f)
  print('SAFETY114_ISOLATED_FIXTURE_OPEN');return
 fixture_ids=[]
 if CANCELLATION_MODE:
  q += 'update private.cancellation_due_control set enabled=true;'
  for n in range(20):
   subject='synthetic-safety114-'+str(uuid.uuid4())
   q += "insert into private.naver_accounts(subject,real_name,birth_date,gender,verification_status)values('"+subject+"','합성회원','1990-01-01','F','qualified');insert into private.cancellation_safety_due(identity_id,next_due_at)select id,clock_timestamp()-interval'1 hour'from private.naver_identity_keys where subject='"+subject+"';"
   fixture_ids.append(subject)
 else:
  q += "update private.member_reports set retention_due_at=statement_timestamp()+interval'100 years',final_closed_at=statement_timestamp()+interval'100 years'-interval'2160 hours'where final_closed_at is not null;update private.report_purge_control set enabled=true;"
  members=[str(uuid.uuid4()),str(uuid.uuid4())]
  for m in members:q += "insert into auth.users(id,email)values('"+m+"','safety114-"+m+"@test.invalid');insert into public.profiles(id,real_name,birth_date,gender)values('"+m+"','합성회원','1990-01-01','female');"
  for n in range(1 if STORAGE_MODE else 20):
   report=str(uuid.uuid4());fixture_ids.append(report)
   q += "insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,status,hide_target,fingerprint,final_closed_at,retention_due_at)select '"+report+"','"+members[0]+"',id,gen_random_uuid(),'member','"+members[1]+"','online',array['other'],'resolved',false,repeat('a',64),statement_timestamp()-interval'2161 hours',statement_timestamp()-interval'1 hour'from private.member_episodes where profile_id='"+members[0]+"'and ended_at is null;insert into private.member_report_details(report_id,description)values('"+report+"','파기할 합성 설명');"
 if BUDGET_MODE:q+='update private.report_purge_control set enabled=true;grant execute on function public.purge_report_retention_terminal_receipts(uuid,integer)to service_role;'
 q += "notify pgrst,'reload schema';"
 b.sql(q)
 b.save('fixture-ids-private.json',json.dumps(fixture_ids))
 if BUDGET_MODE:fixture_budget_plan(fixture_ids)
 if FIVE_MODE:fixture_five()
 if STORAGE_MODE:fixture_storage(members,fixture_ids)
 b.verify_tls_and_role(f)
 print('SAFETY114_ISOLATED_FIXTURE_OPEN')

def budget_sql(query):
 assert BUDGET_MODE and b.state()['clone']==b.NAME,'EXACT_BUDGET_CLONE_REQUIRED'
 result=subprocess.run(b.DOCKER+['exec','-i',b.NAME,'psql','-XqAt','-U',b.BOOT,'-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate'],input=query.encode(),capture_output=True,timeout=10)
 if result.returncode:
  codes=re.findall(r'\b(?:22023|40001|42501|55000|23514|23505)\b',result.stderr.decode(errors='replace'))
  b.save('budget-sql-failure-'+str(uuid.uuid4())+'.json',json.dumps({'stage':'BUDGET_FIXED_SQL','code':codes[0]if codes else'UNCLASSIFIED'}))
  raise RuntimeError('BUDGET_SQL_FAILED_FIXED_METADATA_PRESERVED')
 return result.stdout

def fixture_budget_plan(subjects):
 assert BUDGET_MODE and len(subjects)==20 and len(set(subjects))==20
 assert all(re.fullmatch(r'synthetic-safety114-[0-9a-f-]{36}',s)for s in subjects)
 ids=json.loads(budget_sql("select json_agg(id order by id)from private.naver_identity_keys where subject in('"+"','".join(subjects)+"');"))
 assert len(ids)==20 and len(set(ids))==20,'ACTUAL_DUE_IDENTITY_SET_REQUIRED'
 plan={'identityIds':ids,'historicalProducer':'SYNTHETIC_FIXTURE_NOT_ACTUAL_PRODUCER','evidenceSha256':hashlib.sha256(b'local-stage2-history-fixture').hexdigest()}
 for prefix in('expired','canary'):
  for field in('Helpful','User','Request','Terminal','Job','Report','Closure','TaskLease','JobLease','Runtime','HistoryToken'):plan[prefix+field]=str(uuid.uuid4())
 b.save('budget-fixture-plan-private.json',json.dumps(plan))
 initial=budget_proof_value();assert initial['jobs']==[]and initial['parents']==[]and initial['slotIds']==[]and initial['dueCounts']=={'helpful':0,'terminal':0,'runtime':0},'INITIAL_MAINTENANCE_MUST_NOT_BE_DUE'
 b.save('budget-initial-proof-private.json',json.dumps(initial))

def budget_original_digest_sql():
 # 현재20 작업과 원취소부모의 영속 원행 전체를 해시한다. 유지관리 history 행은 포함하지 않는다.
 return """encode(extensions.digest(jsonb_build_array(
 (select coalesce(jsonb_agg(to_jsonb(j)order by j.id),'[]')from private.worker_jobs j),
 (select coalesce(jsonb_agg(to_jsonb(s)order by s.global_token,s.job_id),'[]')from private.worker_runtime_job_slots s),
 (select coalesce(jsonb_agg(to_jsonb(r)order by r.request_id),'[]')from private.worker_invocations r where r.kind='cancellation_safety'),
 (select coalesce(jsonb_agg(to_jsonb(a)order by a.request_id,a.job_id,a.job_lease_token),'[]')from private.worker_invocation_jobs a join private.worker_invocations r using(request_id)where r.kind='cancellation_safety'),
 (select coalesce(jsonb_agg(to_jsonb(f)order by f.job_id),'[]')from private.worker_job_run_fences f),
 (select coalesce(jsonb_agg(to_jsonb(b)order by b.request_id),'[]')from private.worker_runtime_intent_invocations b join private.worker_invocations r on r.request_id=b.invocation_request_id where r.kind='cancellation_safety'),
 (select coalesce(jsonb_agg(to_jsonb(c)order by c.request_id),'[]')from private.worker_runtime_intent_confirmations c join private.worker_invocations r on r.request_id=c.parent_invocation_request_id where r.kind='cancellation_safety'),
 (select coalesce(jsonb_agg(to_jsonb(i)order by i.request_id),'[]')from private.worker_runtime_intents i where exists(select 1 from private.worker_runtime_intent_invocations b join private.worker_invocations r on r.request_id=b.invocation_request_id where b.request_id=i.request_id and r.kind='cancellation_safety')),
 (select coalesce(jsonb_agg(to_jsonb(o)order by o.request_id),'[]')from private.worker_runtime_results o where exists(select 1 from private.worker_runtime_intent_invocations b join private.worker_invocations r on r.request_id=b.invocation_request_id where b.request_id=o.request_id and r.kind='cancellation_safety'))
 )::text,'sha256'),'hex')"""

def budget_proof_value():
 assert BUDGET_MODE
 plan=json.loads((b.ROOT/'budget-fixture-plan-private.json').read_text())
 ids=[str(uuid.UUID(v))for v in plan['identityIds']];assert len(ids)==len(set(ids))==20
 def row(table,column,key):return "(select to_jsonb(t)from private."+table+" t where "+column+"='"+str(uuid.UUID(plan[key]))+"')"
 effects={}
 for prefix in('expired','canary'):
  for suffix,table,column in [('Helpful','ai_feedback_receipts','feedback_id'),('Terminal','report_purge_terminal_receipts','task_id'),('Runtime','worker_runtime_results','request_id')]:effects[prefix+suffix]=row(table,column,prefix+suffix)
 effect_sql=','.join("'"+key+"',"+value for key,value in effects.items())
 value=json.loads(budget_sql("""select json_build_object(
 'serverNow',clock_timestamp(),'lease',(select json_build_object('token',token,'expiresAt',expires_at)from private.global_worker_run),
 'jobs',(select coalesce(json_agg(json_build_object('jobId',j.id,'identityId',j.payload->>'identityId','status',j.status)order by j.id),'[]')from private.worker_jobs j),
 'slotIds',(select coalesce(json_agg(job_id order by job_id),'[]')from private.worker_runtime_job_slots),
 'slotGlobals',(select coalesce(json_agg(distinct global_token),'[]')from private.worker_runtime_job_slots),
 'expectedIdentityIds',array['"""+"','".join(ids)+"""']::uuid[],
 'parents',(select coalesce(json_agg(json_build_object('requestId',r.request_id,'token',r.global_token,'kind',r.kind,'limit',r.item_limit,'remainingMs',r.remaining_ms,'state',r.state,'dispatchStarted',r.dispatch_started,'deadline',r.deadline,'createdAt',r.created_at,'result',r.result,'claimCalls',r.claim_calls,'auditClaims',(select count(*)from private.worker_invocation_jobs a where a.request_id=r.request_id),'auditSucceeded',(select count(*)from private.worker_invocation_jobs a where a.request_id=r.request_id and a.settled_status='succeeded'))order by r.created_at),'[]')from private.worker_invocations r where r.kind='cancellation_safety'),
 'unconfirmed',(select count(*)from private.worker_runtime_intents where state<>'confirmed'),
 'originalDigest',"""+budget_original_digest_sql()+""",
 'dueCounts',json_build_object('helpful',(select count(*)from private.ai_feedback_receipts where action='helpful'and accepted_at+interval'2160 hours'<=clock_timestamp()),'terminal',(select count(*)from private.report_purge_terminal_receipts where expires_at<=clock_timestamp()),'runtime',(select count(*)from private.worker_runtime_results where state='completed'and closed_at+interval'720 hours'<=clock_timestamp())),
 'effects',json_build_object("""+effect_sql+"""));"""))
 return value

def budget_proof():print(json.dumps(budget_proof_value()))

def budget_gate_context(context,proof):
 assert isinstance(context,dict)and set(context)=={'parentIds','globalToken','expiresAt','originalDigest','jobIds','slotProof'},'EXACT_BUDGET_SCOPE_REQUIRED'
 assert isinstance(proof,dict)and set(proof)=={'serverNow','lease','jobs','slotIds','slotGlobals','expectedIdentityIds','parents','unconfirmed','originalDigest','dueCounts','effects'},'EXACT_BUDGET_PROOF_REQUIRED'
 for key in('parentIds','jobIds'):
  assert isinstance(context[key],list)and all(isinstance(v,str)and str(uuid.UUID(v))==v for v in context[key])and len(set(context[key]))==len(context[key]),'EXACT_BUDGET_IDS_REQUIRED'
 assert isinstance(context['globalToken'],str)and str(uuid.UUID(context['globalToken']))==context['globalToken']
 assert len(context['parentIds'])==2 and len(context['jobIds'])==20 and context['slotProof']=={'used':20,'remaining':0},'ACTUAL_BUDGET20_REQUIRED'
 assert proof['lease']=={'token':context['globalToken'],'expiresAt':context['expiresAt']}and proof['originalDigest']==context['originalDigest'],'ORIGINAL_BUDGET_SCOPE_CHANGED'
 assert re.fullmatch(r'[0-9a-f]{64}',context['originalDigest'])and re.fullmatch(r'[0-9TZ:+. -]{20,40}',context['expiresAt']),'EXACT_BUDGET_TIME_REQUIRED'
 assert datetime.fromisoformat(proof['serverNow'])<datetime.fromisoformat(context['expiresAt']),'ORIGINAL_GLOBAL_EXPIRED'
 assert len(proof['parents'])==2 and{r['requestId']for r in proof['parents']}==set(context['parentIds'])
 assert len(proof['jobs'])==20 and{r['jobId']for r in proof['jobs']}==set(context['jobIds'])==set(proof['slotIds'])
 assert len(proof['slotIds'])==len(set(proof['slotIds']))==20 and len(proof['expectedIdentityIds'])==len(set(proof['expectedIdentityIds']))==20,'EXACT20_UNIQUE_LEDGER_REQUIRED'
 assert{r['identityId']for r in proof['jobs']}==set(proof['expectedIdentityIds'])and all(r['status']=='succeeded'for r in proof['jobs'])
 assert proof['slotGlobals']==[context['globalToken']]and proof['unconfirmed']==0 and proof['dueCounts']=={'helpful':0,'terminal':0,'runtime':0},'INITIAL_DUE_OR_PENDING_NOT_ALLOWED'
 for r in proof['parents']:
  assert r['token']==context['globalToken']and r['kind']=='cancellation_safety'and r['limit']==10 and r['state']=='completed'and r['dispatchStarted']is True and r['claimCalls']==10 and r['auditClaims']==10 and r['auditSucceeded']==10
  assert r['result']=={'status':'ran','counts':{'claimed':10,'succeeded':10,'retried':0,'failed':0,'superseded':0,'yielded':0}}and 0<r['remainingMs']<=60000
  assert datetime.fromisoformat(r['createdAt'])<datetime.fromisoformat(r['deadline'])<=datetime.fromisoformat(context['expiresAt'])
  assert (datetime.fromisoformat(r['deadline'])-datetime.fromisoformat(r['createdAt'])).total_seconds()*1000<=r['remainingMs']

def budget_insert():
 assert BUDGET_MODE and not(b.ROOT/'budget-gate-intent.json').exists(),'BUDGET_GATE_NO_REPLAY'
 context=json.loads((b.ROOT/'budget-gate-context-private.json').read_text());before=budget_proof_value();budget_gate_context(context,before)
 frozen=json.loads((b.ROOT/'safety-apply-started.json').read_text())
 for path,digest in{**frozen['files'],**frozen['product']}.items():assert hashlib.sha256((REPO/path).read_bytes()).hexdigest()==digest,'BUDGET_PRODUCT_CHANGED'
 assert hashlib.sha256(Path(spec.origin).read_bytes()).hexdigest()==frozen['baseHarnessSha256'],'BUDGET_BASE_CHANGED'
 plan=json.loads((b.ROOT/'budget-fixture-plan-private.json').read_text());values=[v for k,v in plan.items()if k not in('identityIds','historicalProducer','evidenceSha256')]
 assert len(values)==len(set(values))and not(set(values)&set(context['jobIds'])),'HISTORY_AND_ACTUAL_JOB_IDS_MUST_BE_DISJOINT'
 assert all(str(uuid.UUID(v))==v for v in values)and re.fullmatch(r'[0-9a-f]{64}',plan['evidenceSha256'])
 assert all(v is None for v in before['effects'].values()),'FRESH_HISTORY_ROWS_REQUIRED'
 b.save('budget-gate-intent.json',json.dumps({'mutations':1,'parentIds':context['parentIds'],'globalToken':context['globalToken']}))
 q="begin;do $$begin perform 1 from private.global_worker_run where token='"+context['globalToken']+"'and expires_at='"+context['expiresAt']+"'::timestamptz and expires_at>clock_timestamp()for share;assert found;assert "+budget_original_digest_sql()+"='"+context['originalDigest']+"';end;$$;"
 for prefix in('expired','canary'):
  age="statement_timestamp()-interval'721 hours'"if prefix=='expired'else'statement_timestamp()'
  accepted="statement_timestamp()-interval'2161 hours'"if prefix=='expired'else'statement_timestamp()'
  created="statement_timestamp()-interval'722 hours'"if prefix=='expired'else'statement_timestamp()'
  p=lambda name:plan[prefix+name]
  q+="insert into private.ai_feedback_receipts(feedback_id,user_id,client_hash,fingerprint,request_id,action,accepted_at)values('"+p('Helpful')+"','"+p('User')+"','"+p('Request')+"','"+plan['evidenceSha256']+"','"+p('Request')+"','helpful',"+accepted+");"
  q+="insert into private.report_purge_terminal_receipts(task_id,job_id,report_id,closure_id,task_lease_token,job_lease_token,evidence_sha256,completed_at,expires_at)values('"+p('Terminal')+"','"+p('Job')+"','"+p('Report')+"','"+p('Closure')+"','"+p('TaskLease')+"','"+p('JobLease')+"','"+plan['evidenceSha256']+"',"+age+","+age+"+interval'720 hours');"
  q+="insert into private.worker_runtime_results(request_id,global_token,operation,fingerprint,input,result,state,created_at,closed_at)values('"+p('Runtime')+"','"+p('HistoryToken')+"','synthetic_stage2_history','"+plan['evidenceSha256']+"','{}','{}','completed',"+created+","+age+");"
 q+="do $$begin assert exists(select 1 from private.global_worker_run where token='"+context['globalToken']+"'and expires_at='"+context['expiresAt']+"'::timestamptz and expires_at>clock_timestamp());assert "+budget_original_digest_sql()+"='"+context['originalDigest']+"';end;$$;commit;"
 budget_sql(q);after=budget_proof_value();assert after['originalDigest']==before['originalDigest']and after['lease']==before['lease'],'BUDGET_GATE_CHANGED_ORIGINAL'
 assert after['dueCounts']=={'helpful':1,'terminal':1,'runtime':1}and all(v is not None for v in after['effects'].values()),'ACTUAL_HISTORY_INSERT_NOT_PROVEN'
 b.save('budget-gate-stored-proof-private.json',json.dumps({'before':before,'after':after,'producer':plan['historicalProducer'],'fixtureMutations':1}))
 print(json.dumps({'status':'EXPIRED_FIXTURES_COMMITTED','fixtureMutations':1,'originalScopeUnchanged':True,'used':20,'remaining':0}))

def snapshot():
 b.state()
 q="select json_build_object('serverNow',clock_timestamp(),'invocations',(select coalesce(json_agg(json_build_object('requestId',request_id,'token',global_token,'kind',kind,'state',state,'dispatchStarted',dispatch_started,'result',result,'limit',item_limit,'remainingMs',remaining_ms,'createdAt',created_at,'deadline',deadline)order by created_at),'[]')from private.worker_invocations),'intents',(select coalesce(json_agg(json_build_object('requestId',i.request_id,'operation',i.operation,'state',i.state,'parent',b.invocation_request_id,'globalToken',i.global_token,'dispatched',b.dispatch_started,'confirmed',c.request_id is not null)),'[]')from private.worker_runtime_intents i join private.worker_runtime_intent_invocations b using(request_id)left join private.worker_runtime_intent_confirmations c using(request_id)),'queueSessions',(select count(*)from pg_stat_activity where application_name='yumidang-worker-queue'),'lease',(select json_build_object('token',token,'expiresAt',expires_at)from private.global_worker_run),'slots',(select count(*)from private.worker_runtime_job_slots),'maxSlots',(select coalesce(max(n),0)from(select count(*)n from private.worker_runtime_job_slots group by global_token)v),'succeeded',(select count(*)from private.worker_jobs where status='succeeded'),'jobs',(select count(*)from private.worker_jobs),'deleteAcks',(select count(*)from private.report_purge_delete_acks),'dispatches',(select count(*)from private.report_purge_dispatches),'externalPending',(select count(*)from private.worker_runtime_results where state='external_pending'),'reportDetails',(select count(*)from private.member_report_details where report_id in(select id from private.member_reports where reporter_id in(select id from auth.users where email like 'safety114-%@test.invalid'))));"
 value=json.loads(b.sql(q).decode())
 # 최종 metadata 파기는 기존 ACK/dispatch 원행을 cascade로 지운다. 확정 lineage와 원102 결과를 구분한다.
 value['ackProofs']=json.loads(b.sql("""select coalesce(json_agg(json_build_object(
  'requestId',i.request_id,'parent',b.invocation_request_id,'globalToken',i.global_token,
  'state',o.state,'closedAt',o.closed_at,'result',o.result,'ackSha256',i.scope->>'ackSha256',
  'exactInput',o.input=i.scope and o.global_token=i.global_token and o.operation='report_delete_ack',
  'confirmed',i.state='confirmed'and c.intent_fingerprint=i.fingerprint and c.result_fingerprint=o.fingerprint,
  'lineage',b.dispatch_started and c.parent_invocation_request_id=r.request_id and c.parent_fingerprint=r.fingerprint
    and c.predecessor_request_id=b.predecessor_request_id and c.predecessor_fingerprint=p.fingerprint
    and p.operation='report_storage'and p.global_token=i.global_token and p.scope=i.scope-'ackSha256'
    and pb.invocation_request_id=r.request_id and pc.intent_fingerprint=p.fingerprint
  )order by i.request_id),'[]')from private.worker_runtime_intents i
  join private.worker_runtime_results o using(request_id)
  join private.worker_runtime_intent_invocations b using(request_id)
  join private.worker_invocations r on r.request_id=b.invocation_request_id
  join private.worker_runtime_intent_confirmations c on c.request_id=i.request_id
  join private.worker_runtime_intents p on p.request_id=b.predecessor_request_id
  join private.worker_runtime_intent_invocations pb on pb.request_id=p.request_id
  join private.worker_runtime_intent_confirmations pc on pc.request_id=p.request_id
  where i.operation='report_storage_ack';""").decode())
 value['terminalReceipts']=int(b.sql('select count(*)from private.report_purge_terminal_receipts;').decode())
 if FIVE_MODE:
  plan=json.loads((b.ROOT/'five-fixture-private.json').read_text())
  target=str(uuid.UUID(plan['reviewTarget']));withdrawal=str(uuid.UUID(plan['cleanupWithdrawal']))
  source_id=plan['eventSourceId'];assert re.fullmatch(r'PF[0-9]{1,30}',source_id)
  value['five']=json.loads(b.sql("""select json_build_object(
   'jobsByKind',(select json_object_agg(kind,n)from(select kind,count(*)n from private.worker_jobs where status='succeeded'group by kind)s),
   'unfinishedJobs',(select count(*)from private.worker_jobs where status<>'succeeded'),
   'slotsByGlobal',(select coalesce(json_agg(json_build_object('token',global_token,'count',n)),'[]')from(select global_token,count(*)n from private.worker_runtime_job_slots group by global_token)s),
   'auditEffects',(select coalesce(json_agg(json_build_object('kind',r.kind,'effect',a.effect,'status',a.settled_status)),'[]')from private.worker_invocation_jobs a join private.worker_invocations r using(request_id)),
   'budget',(select json_build_object('openCalls',open_calls,'settledCalls',settled_calls,'unknownCalls',unknown_usage_calls,'reservedUnits',reserved_units,'chargedUnits',charged_units)from private.ai_budget_ledgers where ledger_id='synthetic-five-kind-summary'),
   'reservations',(select count(*)from private.ai_budget_reservations where ledger_id='synthetic-five-kind-summary'),
   'summaryPublished',(select count(*)from private.review_summary_job_publications where profile_id='"""+target+"""'),
   'summaryVisible',(select count(*)from private.review_summary_state st join private.review_summaries s on s.id=st.visible_summary_id where st.profile_id='"""+target+"""'and s.source_revision::text=st.revision::text and cardinality(s.evidence_review_ids)=3),
   'checkpointRows',(select count(*)from private.review_summary_checkpoints where profile_id='"""+target+"""'),
   'eventRows',(select count(*)from private.source_events where provider='kopis'and source_id='"""+source_id+"""'),
   'eventDetails',(select count(*)from private.event_source_details d join private.source_events s on s.id=d.source_event_id where s.provider='kopis'and s.source_id='"""+source_id+"""'),
   'memberCompleted',(select count(*)from private.member_cleanup_tasks where withdrawal_id='"""+withdrawal+"""'and state='completed'),
   'memberOriginalAcks',(select count(*)from private.member_cleanup_delete_acks where withdrawal_id='"""+withdrawal+"""'),
   'memberOriginalDispatches',(select count(*)from private.member_cleanup_dispatches d join private.member_cleanup_tasks t on t.id=d.task_id where t.withdrawal_id='"""+withdrawal+"""'),
   'memberAckChain',(select count(*)from private.member_cleanup_tasks t join private.member_cleanup_dispatches d on d.task_id=t.id join private.member_cleanup_delete_acks a on a.task_id=t.id join private.worker_jobs j on j.id=t.id join private.worker_invocation_jobs ij on ij.job_id=j.id and ij.job_lease_token=d.lease_token join private.worker_invocations r on r.request_id=ij.request_id where t.withdrawal_id='"""+withdrawal+"""'and t.state='completed'and t.evidence_sha256 is not null and j.status='succeeded'and(ij.effect='member_cleanup_completed'or exists(select 1 from private.member_cleanup_reconciliations mr where mr.task_id=t.id and mr.invocation_request_id=r.request_id and mr.state='completed'and mr.original_global_token=r.global_token and mr.original_job_lease_token=d.lease_token and mr.dispatch_id=d.dispatch_id and mr.ack_receipt_id=a.receipt_id and mr.ack_sha256=a.ack_sha256 and mr.evidence_sha256=t.evidence_sha256 and mr.target_sha256=private.member_cleanup_target_hash(t)))and ij.settled_status='succeeded'and d.global_token=r.global_token and a.recorded_worker_run_token=d.global_token and a.recorded_lease_token=d.lease_token and a.object_id is not distinct from d.object_id and a.withdrawal_id=t.withdrawal_id and a.profile_id=t.profile_id and a.kind=t.kind),
   'memberOrigins',(select coalesce(json_agg(json_build_object('taskId',t.id,'kind',t.kind,'state',t.state,'scopeHash',private.member_cleanup_target_hash(t),'parent',r.request_id,'parentToken',r.global_token,'claimCalls',r.claim_calls,'dispatchHash',encode(extensions.digest(to_jsonb(d)::text,'sha256'),'hex'),'ackHash',encode(extensions.digest(to_jsonb(ack)::text,'sha256'),'hex'),'originalLease',d.lease_token,'originalAckSha256',ack.ack_sha256,'taskExpiresAt',t.lease_expires_at,'jobStatus',j.status)),'[]')from private.member_cleanup_tasks t join private.member_cleanup_dispatches d on d.task_id=t.id join private.member_cleanup_delete_acks ack on ack.task_id=t.id join private.worker_jobs j on j.id=t.id join private.worker_invocation_jobs a on a.job_id=t.id and a.job_lease_token=d.lease_token join private.worker_invocations r on r.request_id=a.request_id where t.withdrawal_id='"""+withdrawal+"""'),
   'recoveries',(select coalesce(json_agg(json_build_object('requestId',recovery_request_id,'parent',invocation_request_id,'taskId',task_id,'state',state,'originalToken',original_global_token,'originalLease',original_job_lease_token,'token',recovery_global_token,'lease',recovery_lease_token,'ackSha256',ack_sha256,'targetHash',target_sha256,'evidenceSha256',evidence_sha256,'expiresAt',recovery_expires_at,'createdAt',created_at,'limitMs',extract(epoch from(recovery_expires_at-created_at))*1000,'closedAt',closed_at)),'[]')from private.member_cleanup_reconciliations where withdrawal_id='"""+withdrawal+"""'),
   'memberClaimEvidence',(select coalesce(json_agg(json_build_object('taskId',t.id,'kind',t.kind,'leaseToken',t.lease_token,'expiresAt',t.lease_expires_at,'limitMs',extract(epoch from(j.lease_expires_at-j.updated_at))*1000,'parent',r.request_id,'token',r.global_token,'exact',t.lease_expires_at=j.lease_expires_at and t.worker_run_token=r.global_token and t.lease_token=j.lease_token and j.lease_expires_at<=r.deadline)),'[]')from private.member_cleanup_tasks t join private.worker_jobs j on j.id=t.id join private.worker_invocation_jobs a on a.job_id=t.id and a.job_lease_token=t.lease_token join private.worker_invocations r on r.request_id=a.request_id where t.withdrawal_id='"""+withdrawal+"""'and t.state='running')
  );""").decode())
 if SUMMARY_RACE:value['summaryRace']=summary_race_proof_value()
 print(json.dumps(value))

def unknown():
 f=b.state()
 assert b.sql('select token is null from private.global_worker_run;').decode().strip()=='t', 'RELEASE_REQUIRED'
 kind='cancellation_safety' if args.scenario=='cancellation' else 'report_retention'
 b.sql("begin;select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);update private.global_worker_run set token='"+f['unknownToken']+"',expires_at=clock_timestamp()+interval'180 seconds';select public.prepare_queue_invocation('"+f['unknownId']+"','"+f['unknownToken']+"','"+kind+"',1,10000);select public.claim_queue_invocation_dispatch('"+f['unknownId']+"','"+f['unknownToken']+"','"+kind+"',1,10000);select public.mark_queue_invocation_unknown('"+f['unknownId']+"');commit;")
 print('DISPATCHED_UNKNOWN_PERSISTED')

def close():
 b.state(allow_stage=True)
 if PUBLIC_RETIREMENT_MODE and b.sql("select to_regclass('private.member_retirement_receipt_control')is not null;").decode().strip()=='t':
  b.sql('update private.member_retirement_receipt_control set enabled=false,expected_issuer=null;')
 if b.sql("select to_regclass('private.worker_intent_confirmation_control')is not null;").decode().strip()=='t':
  b.sql('update private.worker_intent_confirmation_control set enabled=false;update private.worker_runtime_journal_control set enabled=false;update private.cancellation_due_control set enabled=false;update private.report_purge_control set enabled=false;')
 if REVIEW_LANE_MODE and(b.ROOT/'review-lane-rpc-signatures.json').exists():
  b.sql('update private.ai_processing_guard set external_processing_allowed=false;')
  b.SIGNATURES+=FIVE_FUNCTIONS[14:]
 if FIVE_MODE and b.sql("select to_regclass('private.event_collection_control')is not null;").decode().strip()=='t':
  b.sql('update private.event_collection_control set enabled=false;update private.member_cleanup_guard set external_deletion_approved=false;update private.ai_processing_guard set external_processing_allowed=false;')
  path=b.ROOT/'five-fixture-plan-private.json'
  if path.exists():
   plan=json.loads(path.read_text());ids=[str(uuid.UUID(plan[k]))for k in ['reviewAuthor','reviewTarget']]
   b.sql("update private.ai_member_processing set summary_allowed=false where user_id in('"+"','".join(ids)+"');")
  if(b.ROOT/'five-rpc-signatures.json').exists():b.SIGNATURES+=five_signatures()+RECOVERY_FUNCTIONS+((DISCOVERY_FUNCTION,)if RECOVERY_MODE else ())
 # A partially applied fresh recipe can still close every existing EXEC.
 original_signatures=b.SIGNATURES
 b.SIGNATURES=tuple(sig for sig in original_signatures if b.sql("select to_regprocedure('public."+sig+"')is not null;").decode().strip()=='t')
 try:b.close()
 finally:b.SIGNATURES=original_signatures
 if (PUBLIC_RETIREMENT_MODE or SUMMARY_RACE or BUDGET_MODE or REVIEW_LANE_MODE)and(b.ROOT/'source-full-before-private.json').is_file():
  full_before=json.loads((b.ROOT/'source-full-before-private.json').read_text())
  assert source_full_snapshot()==full_before,'FULL_SOURCE_ROWS_CATALOG_ROLES_ACL_CHANGED'
  proof={'status':'PASS_READ_ONLY_FULL_SOURCE_EQUAL','tables':len(full_before['rows']),'membershipGrantorsExact':True}
  # close가 여러 finally에서 불릴 수 있다. 증거 파일은 최초 기록 후 동일 내용만 허용한다.
  path=b.ROOT/'source-full-final-proof.json'
  if path.exists():assert json.loads(path.read_text())==proof,'FULL_SOURCE_PROOF_CHANGED'
  else:b.save('source-full-final-proof.json',json.dumps(proof))
 if STORAGE_MODE and(b.ROOT/'storage-source-private.json').exists():assert storage_source_proof()[0]==json.loads((b.ROOT/'storage-source-private.json').read_text()),'SOURCE_STORAGE_CHANGED'
 if(b.ROOT/'owned-container-baseline.json').exists():assert owned_metadata()==json.loads((b.ROOT/'owned-container-baseline.json').read_text()),'OWNED_CONFIG_OR_MOUNTS_CHANGED'

def recovery_open():
 assert RECOVERY_MODE,'RECOVERY_SCENARIO_REQUIRED'
 b.state()
 proof=json.loads((b.ROOT/'member-original-unknown-private.json').read_text())
 parent=str(uuid.UUID(proof['parent']));task=str(uuid.UUID(proof['taskId']))
 assert b.sql("select exists(select 1 from private.worker_invocations i join private.worker_invocation_jobs a on a.request_id=i.request_id join private.member_cleanup_tasks t on t.id=a.job_id join private.member_cleanup_dispatches d on d.task_id=t.id join private.member_cleanup_delete_acks ack on ack.task_id=t.id where i.request_id='"+parent+"'and t.id='"+task+"'and i.state='unknown'and t.state='running'and d.global_token=i.global_token and d.lease_token=a.job_lease_token and ack.recorded_lease_token=d.lease_token and ack.recorded_worker_run_token=d.global_token and t.lease_expires_at<=clock_timestamp());").decode().strip()=='t','ORIGINAL_UNKNOWN_ACK_EXPIRED_REQUIRED'
 assert b.sql('select token is not null and expires_at<=clock_timestamp()from private.global_worker_run;').decode().strip()=='t','ORIGINAL_GLOBAL_NATURAL_EXPIRY_REQUIRED'
 b.sql('grant execute on function '+','.join('public.'+sig for sig in RECOVERY_FUNCTIONS)+" to service_role;notify pgrst,'reload schema';")
 print('ORIGINAL_SCOPE_UNCHANGED_RECOVERY_EXEC_GRANTED')


def run():
 b.state();closed(b.NAME)
 assert owned_metadata()==json.loads((b.ROOT/'owned-container-baseline.json').read_text()),'OWNED_CONFIG_OR_MOUNTS_CHANGED'
 assert (b.ROOT/'safety-prepared.json').is_file() and not (b.ROOT/'fixture-started.json').exists() and not(b.ROOT/'receipt.json').exists(), 'NO_STARTED_FIXTURE_REPLAY'
 assert (REPO/'backend/node_modules/pg/package.json').is_file(), 'PG_PREREQUISITE_REQUIRED'
 script=Path(__file__).with_name('worker_safety_http.ts');run_id=str(uuid.uuid4())
 b.save('run-'+run_id+'-source.json',json.dumps({'python':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'typescript':hashlib.sha256(script.read_bytes()).hexdigest()}))
 try:
  command=['deno','run','--cached-only','--allow-net=127.0.0.1','--allow-read='+str(REPO)+','+str(HARNESS_REPO)+','+str(b.ROOT),'--allow-write='+str(b.ROOT),'--allow-env','--allow-run=node,python3','--cert='+str(b.ROOT/'ca.crt'),str(script),'--scenario',args.scenario,'--revision',args.revision]
  # 자연 기한 대기는 30초마다 고정 진행 코드만 출력한다. 본문·키·예외 원문은 전용600 로그에만 보존한다.
  with os.fdopen(os.open(b.ROOT/('http-run-'+run_id+'-private.log'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb')as log:
   p=subprocess.Popen(command,cwd=REPO,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
   selector=selectors.DefaultSelector();selector.register(p.stdout,selectors.EVENT_READ)
   deadline=b.time.monotonic()+(420 if RECOVERY_MODE else 240 if FIVE_MODE else 150);partial=b''
   try:
    while selector.get_map():
     if b.time.monotonic()>deadline:raise TimeoutError('ISOLATED_OWN_PROCESS_TIMEOUT')
     for key,_ in selector.select(1):
      chunk=os.read(key.fileobj.fileno(),4096)
      if not chunk:selector.unregister(key.fileobj);continue
      log.write(chunk);log.flush();partial+=chunk
      while b'\n'in partial:
       line,partial=partial.split(b'\n',1)
       if line==b'ORIGINAL_MEMBER_DEADLINE_WAIT_GET_ONLY':print(line.decode(),flush=True)
    assert p.wait(timeout=5)==0,'SAFETY_HTTP_FAILED_PRIVATE_EVIDENCE_PRESERVED'
   finally:
    selector.close();p.stdout.close()
    if p.poll()is None:
     # 새 session의 자기 harness 및 그 자식만 종료한다. 기존 컨테이너·프로세스는 대상이 아니다.
     assert os.getpgid(p.pid)==p.pid,'OWN_PROCESS_GROUP_REQUIRED'
     os.killpg(p.pid,signal.SIGTERM)
     try:p.wait(timeout=5)
     except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
 finally:close()
 receipt=json.loads((b.ROOT/'receipt.json').read_text());assert receipt['status']=='PASS','ACTUAL_EVIDENCE_REQUIRED';print(json.dumps(receipt))


# 기존 검증은 그대로 유지하고 명시적인 SQL101 잔존 상태만 별도로 검증한다.
LEGACY_READ_SIGNATURES=('get_queue_invocation(uuid)','read_worker_runtime_pending_v2()',
 'read_ai_feedback_maintenance_schedule(uuid)','read_worker_runtime_maintenance_schedule(uuid)')

def legacy_private(name,value=None):
 import stat
 assert LEGACY_OBSERVED_MODE and re.fullmatch(r'[a-z0-9.-]+',name),'LEGACY_PRIVATE_NAME_REQUIRED'
 root=b.ROOT.lstat();assert stat.S_ISDIR(root.st_mode)and root.st_uid==os.getuid()and root.st_mode&0o777==0o700 and b.ROOT.resolve()==b.ROOT,'LEGACY_PRIVATE_ROOT_REQUIRED'
 path=b.ROOT/name
 if value is not None:
  encoded=json.dumps(value,sort_keys=True,separators=(',',':')).encode()
  with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb')as f:f.write(encoded);f.flush();os.fsync(f.fileno())
  for directory in (b.ROOT,b.ROOT.parent):
   fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
   try:os.fsync(fd)
   finally:os.close(fd)
 before=path.lstat()
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  info=os.fstat(fd);assert stat.S_ISREG(info.st_mode)and info.st_nlink==1 and info.st_uid==os.getuid()and info.st_mode&0o777==0o600 and(info.st_dev,info.st_ino)==(before.st_dev,before.st_ino),'LEGACY_PRIVATE_FILE_REQUIRED'
  with os.fdopen(fd,'rb',closefd=False)as file:data=file.read(32*1024*1024+1)
  after=os.fstat(fd);last=path.lstat();assert len(data)<=32*1024*1024 and after.st_nlink==1 and(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_mode,after.st_uid)==(info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_mode,info.st_uid)and(last.st_dev,last.st_ino)==(info.st_dev,info.st_ino),'LEGACY_PRIVATE_READ_CHANGED_OR_TOO_LARGE'
 finally:os.close(fd)
 return json.loads(data)

def legacy_sql(query,step="BUSINESS_READ"):
 assert step in("BUSINESS_READ","BASELINE_GUARDED_PROBE","FIXTURE_COMMIT"),"LEGACY_FIXED_SQL_STEP_REQUIRED"
 assert LEGACY_OBSERVED_MODE and b.state(allow_stage=True)['clone']==b.NAME,'LEGACY_CLONE_REQUIRED'
 result=subprocess.run(b.DOCKER+['exec','-i',b.NAME,'psql','-XqAt','-U',b.BOOT,'-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate'],input=query.encode(),capture_output=True,timeout=30)
 if result.returncode:
  codes=re.findall(r'\b(?:22023|40001|42501|55000|23514|23505|PT404)\b',result.stderr.decode(errors='replace'))
  legacy_private('legacy-sql-failure-'+str(uuid.uuid4())+'.json',{'status':'FAILED','step':step,'sqlState':codes[0]if codes else'UNCLASSIFIED','stderrSha256':hashlib.sha256(result.stderr).hexdigest()})
  raise RuntimeError('LEGACY_SQL_FAILED_FIXED_METADATA')
 return result.stdout

def legacy_clone_snapshot():
 path=REPO/'tests/integration/minkyu/member_retirement_auth_local.py'
 module_spec=importlib.util.spec_from_file_location('legacy_clone_snapshot',path);helper=importlib.util.module_from_spec(module_spec);previous=sys.argv
 try:sys.argv=[str(path)];module_spec.loader.exec_module(helper)
 finally:sys.argv=previous
 helper.REPO=REPO;helper.sql=lambda query,name:legacy_sql(query).decode().strip()if name==b.NAME else (_ for _ in()).throw(AssertionError('CLONE_SNAPSHOT_ONLY'))
 value=helper.snapshot(b.NAME)
 value['membershipGrantors']=json.loads(legacy_sql("select coalesce(json_agg(json_build_array(pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor),admin_option,inherit_option,set_option)order by pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor)),'[]')from pg_auth_members;"))
 return value

def legacy_inventory():
 ids=b.docker('ps','-aq').decode().splitlines()
 values=json.loads(b.docker('inspect',*ids))if ids else []
 digest=lambda value:hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 return {v['Id']:{'name':v['Name'],'config':digest(v['Config']),'hostConfig':digest(v['HostConfig']),'mounts':digest(sorted(v['Mounts'],key=lambda item:json.dumps(item,sort_keys=True,separators=(',',':')))),'running':v['State']['Running'],'oom':v['State']['OOMKilled']}for v in values}

def legacy_frozen():
 frozen=legacy_private('legacy-prepared-private.json')
 assert sorted(legacy_static_graph())==frozen['staticHarnessGraphPaths'],'LEGACY_STATIC_GRAPH_SET_CHANGED'
 assert sorted(str(p.relative_to(REPO))for p in(REPO/'backend/node_modules').rglob('*')if p.is_file())==frozen['nativePackagePaths'],'LEGACY_NATIVE_PACKAGE_SET_CHANGED'
 for path,digest in frozen['files'].items():
  target=REPO/path;assert target.resolve().is_relative_to(REPO.resolve())and not target.is_symlink(),'LEGACY_GRAPH_ESCAPE_REJECTED'
  assert hashlib.sha256(target.read_bytes()).hexdigest()==digest,'LEGACY_GRAPH_CHANGED'
 assert hashlib.sha256(Path(__file__).read_bytes()).hexdigest()==frozen['pythonSha256'],'LEGACY_CONTROL_CHANGED'
 assert hashlib.sha256(Path(__file__).with_name('worker_safety_http.ts').read_bytes()).hexdigest()==frozen['typescriptSha256'],'LEGACY_TYPESCRIPT_CHANGED'
 return frozen

def legacy_static_graph():
 pattern=r'''(?:from\s*|import\s*\(\s*|import\s*)["'](\.[^"']+)["']'''
 harness=Path(__file__).with_name('worker_safety_http.ts').resolve()
 pending=[(harness.parent/dep).resolve()for dep in re.findall(pattern,harness.read_text())];seen=set()
 while pending:
  path=pending.pop()
  if path in seen:continue
  assert path.is_file()and not path.is_symlink()and path.is_relative_to(REPO.resolve()),'LEGACY_STATIC_IMPORT_ESCAPE_REJECTED'
  seen.add(path)
  for dep in re.findall(pattern,path.read_text()):
   target=(path.parent/dep).resolve();assert target.is_relative_to(REPO.resolve()),'LEGACY_TRANSITIVE_IMPORT_ESCAPE_REJECTED'
   if target.is_file()and target.suffix in('.ts','.mjs','.js'):pending.append(target)
 return {str(path.relative_to(REPO)):hashlib.sha256(path.read_bytes()).hexdigest()for path in sorted(seen)}

def legacy_prepare():
 assert not b.ROOT.exists()and not b.ROOT.is_symlink(),'LEGACY_FRESH_ROOT_REQUIRED'
 prior=legacy_inventory();assert all(v['name']not in('/'+b.NAME,'/'+b.REST)for v in prior.values()),'LEGACY_EXISTING_CLONE_REJECTED'
 available=int(next(line.split()[1]for line in b.docker('exec',b.SOURCE,'cat','/proc/meminfo').decode().splitlines()if line.startswith('MemAvailable:')))
 assert available>=786432,'LEGACY_STARTUP_768MIB_REQUIRED_NO_EFFECT'
 before=source_full_snapshot()
 # 최신 원본 grantor/NULL ACL 복원을 재사용한다. cap/subnet은 fresh_docker 한 곳에서만 적용한다.
 b.RECONNECT_V8=b.RECONNECT_V9=b.RECONNECT_V12=True
 try:
  prepare()
  assert source_full_snapshot()==before,'LEGACY_SOURCE_CHANGED_PREPARE'
  legacy_private('legacy-prior-private.json',prior);legacy_private('legacy-source-before-private.json',before)
  legacy_private('legacy-owned-private.json',{'root':str(b.ROOT),'source':b.SOURCE,'name':b.NAME,'rest':b.REST,'containers':owned_metadata()})
  frozen=json.loads((b.ROOT/'safety-apply-started.json').read_text())
  files={**frozen['files'],**frozen['product'],**{relative:hashlib.sha256((REPO/relative).read_bytes()).hexdigest()for relative in('tests/integration/minkyu/member_retirement_auth_local.py','tools/local/remote_schema_catalog.sql')}}
  static_graph=legacy_static_graph();files.update(static_graph)
  native_files=sorted(p for p in(REPO/'backend/node_modules').rglob('*')if p.is_file())
  assert native_files and all(not p.is_symlink()and p.resolve().is_relative_to(REPO.resolve())for p in native_files),'LEGACY_NATIVE_CACHE_ESCAPE_REJECTED'
  native_paths=sorted(str(p.relative_to(REPO))for p in native_files);files.update({str(p.relative_to(REPO)):hashlib.sha256(p.read_bytes()).hexdigest()for p in native_files})
  legacy_private('legacy-prepared-private.json',{'staticHarnessGraphPaths':sorted(static_graph),'nativePackagePaths':native_paths,'status':'PREPARED_NOT_RUN','sourceTables':len(before['rows']),'files':files,'pythonSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'typescriptSha256':hashlib.sha256(Path(__file__).with_name('worker_safety_http.ts').read_bytes()).hexdigest(),'owned':owned_metadata(),'startupAvailableKiB':available,'scope':'MANUAL_LEGACY_SQL101_BOUNDARY_STOCK_CURRENT_CLI'})
 except BaseException:
  # 이름의 사전 부재를 확인한 이번 전용 pair만 닫는다. 기존 ID는 중지하지 않는다.
  if b.ROOT.is_dir():
   legacy_private('legacy-prepare-failed.json',{'status':'FAILED','scope':'PREPARE_NO_REPLAY'})
   for name in(b.REST,b.NAME):
    found=subprocess.run(b.DOCKER+['inspect',name],capture_output=True)
    if not found.returncode:
     v=json.loads(found.stdout)[0];assert v['Id']not in prior and(v['Config'].get('Labels')or{}).get('yumidang.owner')=='minkyu','LEGACY_UNOWNED_STOP_REJECTED'
     if name==b.NAME and v['State']['Running']and(b.ROOT/'prepare-stage-private.json').is_file():
      try:_legacy_original_close()
      except BaseException:pass
     b.docker('stop',v['Id'])
  raise

def legacy_inherited_rows(snapshot,plan):
 # 합성 두 행만 제외한다. 기존 업무 행의 전체 값과 테이블 집합은 그대로 비교한다.
 rows=dict(snapshot['rows'])
 for table in ('private.worker_invocation_control','private.worker_runtime_atomic_control','private.ai_feedback_maintenance_control'):rows.pop(table)
 for table,column,key in (('private.worker_runtime_intents','request_id','requestId'),('private.ai_feedback_receipts','feedback_id','helpfulId')):
  value=str(uuid.UUID(plan[key]));assert value==plan[key],'LEGACY_CANONICAL_FIXTURE_ID_REQUIRED'
  rows[table]=legacy_sql("select count(*)||':'||md5(coalesce(string_agg(to_jsonb(x)::text,','order by to_jsonb(x)::text),''))from "+table+" x where "+column+"<>'"+value+"'::uuid;").decode().strip()
 return rows

def legacy_assert_inherited(expected,actual):
 assert isinstance(expected,dict)and expected and actual==expected,'LEGACY_INHERITED_FULL_ROWS_CHANGED'

def legacy_fixture():
 legacy_frozen();f=b.state();closed(b.NAME)
 assert not(b.ROOT/'fixture-started.json').exists(),'LEGACY_FIXTURE_REPLAY_REJECTED'
 plan={key:str(uuid.uuid4())for key in('requestId','ticket','globalToken','helpfulId','userId','helpfulRequestId')}
 legacy_private('fixture-started.json',{'status':'STARTED_NO_REPLAY','scope':'MANUAL_LEGACY_ROW_COEXISTING_INHERITED_PENDING_NOT_PUBLIC_PRODUCER'})
 legacy_private('legacy-plan-private.json',plan)
 before=legacy_clone_snapshot();legacy_private('legacy-inherited-before-private.json',before)
 # 원본 업무 행을 쓰지 않는다. 전용 clone의 guard만 같은 트랜잭션에서 열고 반드시 원복한다.
 legacy_private('legacy-baseline-probe-intent.json',{'status':'STARTED_NO_REPLAY','step':'BASELINE_GUARDED_PROBE','temporaryCloneControlUpdate':True,'transactionEnds':'ROLLBACK'})
 probe="begin;set local request.jwt.claims='{\"role\":\"service_role\"}';update private.worker_runtime_atomic_control set enabled=true;select jsonb_build_object('hasPending',(public.read_worker_runtime_pending_v2()->>'hasPending')::boolean,'intentStates',(select coalesce(jsonb_object_agg(state,n),'{}')from(select state,count(*) n from private.worker_runtime_intents group by state)s),'resultStates',(select coalesce(jsonb_object_agg(state,n),'{}')from(select state,count(*) n from private.worker_runtime_results group by state)s),'invocationStates',(select coalesce(jsonb_object_agg(state,n),'{}')from(select state,count(*) n from private.worker_invocations group by state)s),'fixtureIdsAbsent',not exists(select 1 from private.worker_runtime_intents where request_id='"+plan['requestId']+"')and not exists(select 1 from private.worker_runtime_results where request_id='"+plan['requestId']+"')and not exists(select 1 from private.worker_invocations where request_id='"+plan['requestId']+"')and not exists(select 1 from private.worker_runtime_intent_confirmations where request_id='"+plan['requestId']+"')and not exists(select 1 from private.ai_feedback_receipts where feedback_id='"+plan['helpfulId']+"'));rollback;"
 metadata=json.loads(legacy_sql(probe,step='BASELINE_GUARDED_PROBE'));assert metadata['fixtureIdsAbsent']is True,'LEGACY_FIXTURE_ID_COLLISION'
 assert legacy_clone_snapshot()==before,'LEGACY_BASELINE_PROBE_DID_NOT_ROLL_BACK'
 inherited=legacy_inherited_rows(before,plan)
 legacy_private('legacy-inherited-business-private.json',{'rows':inherited,'metadata':metadata,'controlsRolledBackClosed':True,'scope':'COEXISTING_INHERITED_PENDING_CURRENT_CLI_BLOCKS_NOT_SOLE_CAUSE'})
 closed(b.NAME)
 legacy_private('legacy-fixture-commit-intent.json',{'status':'STARTED_NO_REPLAY','step':'FIXTURE_COMMIT','originalBusinessRowsSha256':hashlib.sha256(json.dumps(inherited,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'inheritedPending':metadata['hasPending']})
 q="begin;set local request.jwt.claims='{\"role\":\"service_role\"}';update private.worker_invocation_control set enabled=true;update private.worker_runtime_atomic_control set enabled=true;update private.ai_feedback_maintenance_control set enabled=true;"
 q+='grant execute on function '+','.join('public.'+sig for sig in LEGACY_READ_SIGNATURES)+' to service_role;grant execute on function public.read_report_terminal_maintenance_schedule_v2(uuid)to yumidang_worker_queue;'
 q+="insert into private.worker_runtime_intents(request_id,ticket,operation,global_token,parent_ticket,scope,fingerprint,state)values('"+plan['requestId']+"','"+plan['ticket']+"','cycle','"+plan['globalToken']+"',null,'{\"kind\":\"cancellation_safety\",\"limit\":1}',encode(extensions.digest(jsonb_build_array('cycle','"+plan['globalToken']+"'::uuid,'{\"kind\":\"cancellation_safety\",\"limit\":1}'::jsonb,null::uuid)::text,'sha256'),'hex'),'observed_response');"
 q+="insert into private.ai_feedback_receipts(feedback_id,user_id,client_hash,fingerprint,request_id,action,accepted_at)values('"+plan['helpfulId']+"','"+plan['userId']+"','synthetic-legacy101','synthetic-legacy101','"+plan['helpfulRequestId']+"','helpful',clock_timestamp()-interval'91 days');notify pgrst,'reload schema';commit;"
 legacy_sql(q,step='FIXTURE_COMMIT');b.verify_tls_and_role(f)
 snapshot=legacy_clone_snapshot();legacy_assert_inherited(inherited,legacy_inherited_rows(snapshot,plan))
 legacy_private('legacy-clone-before-private.json',snapshot)
 proof=legacy_proof_value();assert proof['state']=='observed_response'and proof['hasPending']is True and proof['modernReceipts']==0 and proof['dueHelpful']is True,'LEGACY_EXACT_PENDING_BOUNDARY_REQUIRED'
 legacy_private('legacy-before-private.json',proof)
 print('LEGACY_MANUAL_OBSERVED_RESPONSE_PENDING_READY')

def legacy_proof_value():
 plan=legacy_private('legacy-plan-private.json');request_id=str(uuid.UUID(plan['requestId']))
 value=json.loads(legacy_sql("begin read only;set local request.jwt.claims='{\"role\":\"service_role\"}';select jsonb_build_object('state',(select state from private.worker_runtime_intents where request_id='"+request_id+"'),'journalSha256',(select encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex')from private.worker_runtime_intents i where request_id='"+request_id+"'),'hasPending',(public.read_worker_runtime_pending_v2()->>'hasPending')::boolean,'modernReceipts',(select count(*)from private.worker_runtime_intent_invocations where request_id='"+request_id+"')+(select count(*)from private.worker_runtime_results where request_id='"+request_id+"')+(select count(*)from private.worker_invocations where request_id='"+request_id+"')+(select count(*)from private.worker_runtime_intent_confirmations where request_id='"+request_id+"'),'dueHelpful',exists(select 1 from private.ai_feedback_receipts where feedback_id='"+plan['helpfulId']+"'and accepted_at+interval'2160 hours'<clock_timestamp()),'closedObsoletePort',not(select enabled from private.worker_runtime_journal_control)and not(select enabled from private.worker_intent_confirmation_control)and not has_function_privilege('service_role','public.observe_worker_runtime_intent(uuid,boolean)','EXECUTE'));rollback;"))
 assert value['closedObsoletePort']is True,'OBSOLETE_JOURNAL_PORT_REOPENED'
 return value

def legacy_proof():
 legacy_frozen();value=legacy_proof_value()
 assert value==legacy_private('legacy-before-private.json'),'ORIGINAL_LEGACY_PROOF_CHANGED'
 snapshot=legacy_clone_snapshot();assert snapshot==legacy_private('legacy-clone-before-private.json'),'LEGACY_CLONE_ROWS_CATALOG_ROLES_CHANGED'
 legacy_assert_inherited(legacy_private('legacy-inherited-business-private.json')['rows'],legacy_inherited_rows(snapshot,legacy_private('legacy-plan-private.json')))
 print(json.dumps(value))

def legacy_close():
 # 코드 drift와 안전하게 중지할 ID의 근거를 분리한다. 원본/기존 ID는 항상 제외한다.
 owned=legacy_private('legacy-owned-private.json');prior=legacy_private('legacy-prior-private.json')
 assert owned['root']==str(b.ROOT)and owned['source']==b.SOURCE and owned['name']==b.NAME and owned['rest']==b.REST,'LEGACY_CLEANUP_BINDING_REQUIRED'
 assert len(owned['containers'])==2 and {v['name']for v in owned['containers']}=={'/'+b.NAME,'/'+b.REST},'LEGACY_EXACT_PAIR_REQUIRED'
 assert all(v['id']not in prior and v['memoryCap']==(512 if v['name']=='/'+b.NAME else 128)*1024*1024 and v['noHealthcheck']for v in owned['containers']),'LEGACY_PRIOR_OR_INVALID_PAIR_REJECTED'
 error=None;closed_proof=None;stopped=[]
 try:
  frozen=legacy_frozen();current=owned_metadata();assert current==frozen['owned']==owned['containers'],'LEGACY_OWNED_ID_CONFIG_CHANGED'
  info=json.loads(b.docker('inspect',b.NAME))[0]
  if info['State']['Running']:
   if(b.ROOT/'legacy-inherited-business-private.json').exists():legacy_assert_inherited(legacy_private('legacy-inherited-business-private.json')['rows'],legacy_inherited_rows(legacy_clone_snapshot(),legacy_private('legacy-plan-private.json')))
   elif(b.ROOT/'legacy-inherited-before-private.json').exists():assert legacy_clone_snapshot()==legacy_private('legacy-inherited-before-private.json'),'LEGACY_FAILED_PROBE_ORIGINAL_ROWS_CHANGED'
   if(b.ROOT/'legacy-before-private.json').exists():legacy_proof()
   _legacy_original_close();closed_proof={'defaultClosed':True,'obsoleteObserveCalls':0}
  else:
   assert(b.ROOT/'legacy-final-private.json').is_file(),'STOPPED_DB_VERIFICATION_NOT_RUN'
   closed_proof=legacy_private('legacy-final-private.json')['closedProof']
 except BaseException as exc:error=exc
 finally:
  cleanup_failures=[]
  for expected in reversed(owned['containers']):
   stage='INSPECT_IDENTITY'
   try:
    v=json.loads(b.docker('inspect',expected['id']))[0]
    assert v['Id']==expected['id']and v['Name']==expected['name']and(v['Config'].get('Labels')or{}).get('yumidang.owner')=='minkyu'and v['Id']not in prior,'LEGACY_STOP_IDENTITY_CHANGED'
    # 같은 새 ID의 각 중지는 독립적으로 시도하고 첫 실패를 보존한다.
    if v['Name']=='/'+b.NAME and v['State']['Running']and closed_proof is None:
     try:_legacy_original_close();closed_proof={'defaultClosed':True,'obsoleteObserveCalls':0}
     except BaseException as exc:
      cleanup_failures.append({'stage':'CLOSE_GUARDS','id':expected['id']})
      if error is None:error=exc
    stage='STOP_OWNED'
    if v['State']['Running']:b.docker('stop',expected['id'])
    stage='VERIFY_STOP'
    final_info=json.loads(b.docker('inspect',expected['id']))[0]
    assert final_info['Id']==expected['id']and not final_info['State']['Running'],'LEGACY_OWNED_STOP_FAILED'
    stopped.append({'id':expected['id'],'stopped':True,'oom':final_info['State']['OOMKilled']})
   except BaseException as exc:
    cleanup_failures.append({'stage':stage,'id':expected['id']})
    if error is None:error=exc
  source_equal=False;prior_equal=False;graph_equal=False
  try:
   current=legacy_inventory();prior_equal=all(current.get(key)==value for key,value in prior.items());assert prior_equal,'LEGACY_PRIOR_CONTAINER_CHANGED'
   source_equal=source_full_snapshot()==legacy_private('legacy-source-before-private.json');assert source_equal,'LEGACY_FULL_SOURCE_CHANGED'
   legacy_frozen();graph_equal=True
   assert not any(v['oom']for v in stopped),'LEGACY_OWNED_OOM_FAILED'
  except BaseException as exc:
   if error is None:error=exc
  final={'status':'FAILED'if error else'PASS_CLOSED_SOURCE_PRIOR_EQUAL','closedProof':closed_proof,'ownedStopped':len(stopped)==2 and {v['id']for v in stopped}=={v['id']for v in owned['containers']},'owned':stopped,'cleanupFailures':cleanup_failures,'sourceFullEqual':source_equal,'priorFullEqual':prior_equal,'frozenFilesEqual':graph_equal,'actualTest':'FAILED'if error or not(b.ROOT/'receipt.json').exists()else legacy_private('receipt.json')['status']}
  if not(b.ROOT/'legacy-final-private.json').exists():legacy_private('legacy-final-private.json',final)
  elif error:legacy_private('legacy-close-failure-'+str(uuid.uuid4())+'.json',final)
 if error:raise error

def legacy_run():
 process=None;samples=[];failure=None;child_checks=[]
 try:
  frozen=legacy_frozen();b.state();closed(b.NAME)
  assert owned_metadata()==frozen['owned'],'LEGACY_OWNED_CONFIG_CHANGED'
  assert not any((b.ROOT/name).exists()for name in('fixture-started.json','legacy-final-private.json','receipt.json')),'LEGACY_FIRST_RUN_ONLY'
  assert(REPO/'backend/node_modules/pg/package.json').is_file(),'LEGACY_CACHED_PG_REQUIRED'
  legacy_private('legacy-run-started-private.json',{'status':'STARTED_NO_REPLAY','pythonSha256':frozen['pythonSha256'],'typescriptSha256':frozen['typescriptSha256']})
  command=['deno','run','--cached-only','--allow-sys=uid','--allow-net=127.0.0.1','--allow-read='+str(REPO)+','+str(HARNESS_REPO)+','+str(b.ROOT),'--allow-write='+str(b.ROOT),'--allow-env','--allow-run=node,python3','--cert='+str(b.ROOT/'ca.crt'),str(Path(__file__).with_name('worker_safety_http.ts')),'--scenario',args.scenario,'--revision',args.revision]
  available=int(next(line.split()[1]for line in b.docker('exec',b.SOURCE,'cat','/proc/meminfo').decode().splitlines()if line.startswith('MemAvailable:')))
  samples.append({'availableKiB':available,'elapsedMs':0});assert available>=786432,'LEGACY_RUNNING_768MIB_FLOOR_BEFORE_CHILD'
  with os.fdopen(os.open(b.ROOT/'legacy-run-private.log',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb')as log:
   process=subprocess.Popen(command,cwd=REPO,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
   deadline=b.time.monotonic()+120;next_sample=0
   while process.poll()is None:
    now=b.time.monotonic();assert now<deadline,'LEGACY_BOUNDED_RUNTIME_TIMEOUT'
    if now>=next_sample:
     available=int(next(line.split()[1]for line in b.docker('exec',b.SOURCE,'cat','/proc/meminfo').decode().splitlines()if line.startswith('MemAvailable:')))
     samples.append({'availableKiB':available,'elapsedMs':int((120-deadline+now)*1000)});next_sample=now+3
     assert available>=786432,'LEGACY_RUNNING_768MIB_FLOOR'
    b.time.sleep(.1)
   assert process.returncode==0,'LEGACY_NATIVE_HTTP_FAILED_PRESERVED'
 except BaseException as exc:failure=exc
 finally:
  try:
   if process is not None:
    if process.poll()is None:
     assert os.getpgid(process.pid)==process.pid,'LEGACY_OWN_SESSION_REQUIRED';os.killpg(process.pid,signal.SIGTERM)
     try:process.wait(timeout=10)
     except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
    # 실제 launcher가 기록한 이번 session의 Node PID만 종료 여부를 확인한다.
    for path in sorted(b.ROOT.glob('legacy-node-*-private.jsonl')):
     info=path.lstat();assert info.st_nlink==1 and info.st_uid==os.getuid()and info.st_mode&0o777==0o600,'LEGACY_CHILD_TRACE_PRIVATE_REQUIRED'
     pids={v['nodePid']for line in path.read_text().splitlines()if line for v in[json.loads(line)]}
     for pid in pids:
      assert type(pid)is int and pid>0 and pid!=os.getpid(),'LEGACY_RECORDED_CHILD_REQUIRED'
      try:group=os.getpgid(pid)
      except ProcessLookupError:group=None
      if group is not None:
       assert group==process.pid,'LEGACY_CHILD_SESSION_CHANGED';os.kill(pid,signal.SIGKILL)
       end=b.time.monotonic()+3
       while b.time.monotonic()<end:
        try:os.getpgid(pid)
        except ProcessLookupError:break
        b.time.sleep(.05)
       else:raise RuntimeError('LEGACY_ACTUAL_NODE_NOT_TERMINATED')
      child_checks.append({'pid':pid,'terminated':True})
  except BaseException as exc:
   if failure is None:failure=exc
  finally:
   try:
    legacy_private('legacy-runtime-final-private.json',{'status':'FAILED'if failure else'PASS','memoryObservationScope':'EXECUTION_UNTIL_OWN_CHILDREN_END_NOT_CONTINUOUS_CLEANUP','minimumAvailableKiB':min((s['availableKiB']for s in samples),default=None),'samples':samples,'nodeChildren':child_checks,'denoExitCode':process.returncode if process else None})
   finally:legacy_close()
 if failure:raise failure
 receipt=legacy_private('receipt.json');assert receipt['status']=='PASS','LEGACY_ACTUAL_RECEIPT_REQUIRED';print(json.dumps(receipt))

if LEGACY_OBSERVED_MODE:
 _legacy_original_close=close
 close=legacy_close
 legacy_actions={'--prepare':legacy_prepare,'--fixture':legacy_fixture,'--legacy-proof':legacy_proof,'--close':legacy_close,'--run':legacy_run}
 assert args.action in legacy_actions,'LEGACY_READ_ONLY_SCENARIO_ACTION_REQUIRED'
 if __name__=='__main__':legacy_actions[args.action]();sys.exit(0)

if __name__=='__main__':
 {'--prepare':prepare,'--fixture':fixture,'--snapshot':snapshot,'--storage-proof':storage_proof,'--five-proof':five_proof,'--recovery-open':recovery_open,'--unknown':unknown,'--close':close,'--run':run,'--owned-proof':owned_proof,'--retirement-proof':retirement_proof,'--summary-race-proof':summary_race_proof,'--summary-race-mutate':summary_race_mutate,'--summary-insufficient-enqueue':summary_insufficient_enqueue,'--summary-insufficient-proof':summary_insufficient_proof,'--review-lane-proof':review_lane_proof,'--budget-proof':budget_proof,'--budget-insert':budget_insert}[args.action]()
