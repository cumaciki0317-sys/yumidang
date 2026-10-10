"""운영과 분리된 SQL99 TLS DB 준비. 비밀은 private tmp에만 저장한다."""
import json,os,re,secrets,subprocess,time
from pathlib import Path

ROOT=Path('/private/tmp/yumidang-queue-tls99')
NAME='yumidang-minkyu-queue-tls99'
SOURCE='supabase_db_yumidang-release88-http'
DOCKER=['docker','--host','unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock']
IMAGE='public.ecr.aws/supabase/postgres:17.6.1.165'
def call(args,data=None):
 r=subprocess.run(args,input=data,capture_output=True,timeout=120)
 if r.returncode:
  ROOT.mkdir(mode=0o700,exist_ok=True)
  p=ROOT/'failure-private.log';p.write_bytes(r.stdout+r.stderr);p.chmod(0o600)
  raise RuntimeError('TLS_ENVIRONMENT_FAILED_SEE_PRIVATE_LOG')
 return r.stdout
def sql(statement):
 return call(DOCKER+['exec','-i',NAME,'psql','-XqAt','-U','yumidang_tls_bootstrap','-d','postgres','-v','ON_ERROR_STOP=1'],statement.encode())
def validate():
 state=json.loads((ROOT/'connection-private.json').read_text())
 p=ROOT/'client.pgpass';p.write_text('*:*:*:'+state['user']+':'+state['password']+'\n');p.chmod(0o600)
 for filename in ['ca.crt','wrong-ca.crt','client.pgpass']:
  call(DOCKER+['cp',str(ROOT/filename),NAME+':/tmp/'+filename])
 call(DOCKER+['exec','--user','root',NAME,'chown','postgres:postgres','/tmp/ca.crt','/tmp/wrong-ca.crt','/tmp/client.pgpass'])
 def tcp(statement,ca='ca.crt',host='localhost',ssl='verify-full'):
  conn=f'host={host} hostaddr=127.0.0.1 port=5432 user={state["user"]} dbname=postgres sslmode={ssl} sslrootcert=/tmp/{ca} connect_timeout=3'
  return subprocess.run(DOCKER+['exec','-e','PGPASSFILE=/tmp/client.pgpass',NAME,'psql','-XqAt',conn,'-v','ON_ERROR_STOP=1','-c',statement],capture_output=True,timeout=15)
 v=tcp("select ssl from pg_stat_ssl where pid=pg_backend_pid();set role yumidang_worker_queue;select json_build_object('role',current_user,'login',session_user);")
 assert v.returncode==0,'TLS_LOGIN_FAILED'
 lines=v.stdout.decode().splitlines();assert lines[0]=='t';row=json.loads(lines[1]);assert row=={'role':'yumidang_worker_queue','login':state['user']}
 for ca,host,ssl in [('wrong-ca.crt','localhost','verify-full'),('ca.crt','wrong.invalid','verify-full'),('ca.crt','localhost','disable')]:
  assert tcp('select 1',ca,host,ssl).returncode!=0,'TLS_PROTECTION_BYPASSED'
 for query in ['set role service_role','set role supabase_admin','set role yumidang_worker_queue;select *from private.worker_jobs','set role yumidang_worker_queue;create table public.queue_unwanted(id int)']:
  assert tcp(query).returncode!=0,'EXCESS_PERMISSION'
 assert tcp("set role yumidang_worker_queue;select public.read_worker_queue_schedule('{}',null);").returncode==0
 # Two independent psql processes contend using the dedicated TLS LOGIN.
 from concurrent.futures import ThreadPoolExecutor
 from threading import Barrier
 barrier=Barrier(2)
 def contend(_):
  barrier.wait(timeout=5)
  return tcp('set role yumidang_worker_queue;select public.acquire_worker_run(180,null);')
 with ThreadPoolExecutor(max_workers=2)as pool:results=list(pool.map(contend,range(2)))
 assert all(r.returncode==0 for r in results),'LEASE_COMPETITION_FAILED'
 rows=[r.stdout.decode().strip()for r in results];winners=[json.loads(row)for row in rows if row]
 assert len(winners)==1,'EXPECTED_ONE_GLOBAL_LEASE'
 token=winners[0]['token']
 try:
  assert tcp("set role yumidang_worker_queue;select public.read_worker_owned_queue_schedule('"+token+"');").returncode==0
 finally:
  released=tcp("set role yumidang_worker_queue;select public.release_worker_run('"+token+"');")
  assert released.returncode==0 and json.loads(released.stdout.decode())['status']=='applied'
 receipt={'tlsLogin':'PASS','wrongCaRejected':True,'wrongHostRejected':True,'plaintextRejected':True,'excessRoleAndTableAccessRejected':True,'scheduleRpcAllowed':True,'twoTlsProcessesOneGlobalLease':True,'operatingChanged':False}
 p=ROOT/'tls-receipt.json';p.write_text(json.dumps(receipt));p.chmod(0o600);print(json.dumps(receipt))
def prepare():
 ROOT.mkdir(mode=0o700,exist_ok=True);ROOT.chmod(0o700)
 existing=call(DOCKER+['ps','-a','--format','{{.Names}}']).decode().splitlines()
 assert NAME not in existing,'EXISTING_ENVIRONMENT_PRESERVED'
 assert SOURCE in existing
 # Save current source recovery point before creating an independent target.
 for filename,args in [('source99.dump',['pg_dump','-U','postgres','-d','postgres','-Fc']),('roles.sql',['pg_dumpall','-U','supabase_admin','--roles-only','--no-role-passwords'])]:
  p=ROOT/filename;p.write_bytes(call(DOCKER+['exec',SOURCE,*args]));p.chmod(0o600)
 (ROOT/'ca.cnf').write_text('[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=yumidang-test-ca\n[v3_ca]\nbasicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n')
 for label in ['ca','wrong-ca']:
  call(['openssl','req','-config',str(ROOT/'ca.cnf'),'-extensions','v3_ca','-x509','-newkey','rsa:2048','-nodes','-keyout',str(ROOT/(label+'.key')),'-out',str(ROOT/(label+'.crt')),'-days','2','-subj','/CN=yumidang-local-test-'+label])
 call(['openssl','req','-newkey','rsa:2048','-nodes','-keyout',str(ROOT/'server.key'),'-out',str(ROOT/'server.csr'),'-subj','/CN=localhost'])
 (ROOT/'server.ext').write_text('subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always,issuer:always\n')
 call(['openssl','x509','-req','-in',str(ROOT/'server.csr'),'-CA',str(ROOT/'ca.crt'),'-CAkey',str(ROOT/'ca.key'),'-CAcreateserial','-out',str(ROOT/'server.crt'),'-days','2','-extfile',str(ROOT/'server.ext')])
 for p in ROOT.iterdir():p.chmod(0o600)
 call(DOCKER+['run','-d','--name',NAME,'--label','yumidang.owner=minkyu','--user','postgres','-p','127.0.0.1:61622:5432','--entrypoint','sh',IMAGE,'-c','initdb -U yumidang_tls_bootstrap -D /tmp/queue-data --auth-local=trust --auth-host=scram-sha-256 && exec postgres -D /tmp/queue-data -c listen_addresses=\'*\' -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off'])
 for _ in range(40):
  r=subprocess.run(DOCKER+['exec',NAME,'pg_isready','-U','postgres'],capture_output=True)
  if r.returncode==0:break
  time.sleep(.5)
 else:raise RuntimeError('TLS_DB_NOT_READY')
 # A separate local-only bootstrap avoids source postgres role demotion mid-restore.
 roles=(ROOT/'roles.sql').read_text()
 # Membership grantor is the isolated bootstrap; effective source role options remain.
 roles=re.sub(r' GRANTED BY [A-Za-z_][A-Za-z0-9_]*;', ';',roles)
 sql(roles)
 call(DOCKER+['exec','-i',NAME,'pg_restore','-U','yumidang_tls_bootstrap','-d','postgres','--single-transaction','--exit-on-error'],(ROOT/'source99.dump').read_bytes())
 for filename in ['server.key','server.crt']:
  call(DOCKER+['cp',str(ROOT/filename),NAME+':/tmp/'+filename])
 call(DOCKER+['exec','--user','root',NAME,'sh','-c','chown postgres:postgres /tmp/server.key /tmp/server.crt; chmod 600 /tmp/server.key'])
 password=secrets.token_urlsafe(36)
 sql("create role yumidang_queue_tls_login login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '"+password+"';grant yumidang_worker_queue to yumidang_queue_tls_login with inherit false,set true;alter system set ssl='on';alter system set ssl_cert_file='/tmp/server.crt';alter system set ssl_key_file='/tmp/server.key';select pg_reload_conf();")
 call(DOCKER+['exec',NAME,'sh','-c',"printf 'local all all trust\nhostssl all yumidang_queue_tls_login 0.0.0.0/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\n' > /tmp/queue-data/pg_hba.conf"])
 sql('select pg_reload_conf();')
 p=ROOT/'connection-private.json';p.write_text(json.dumps({'host':'127.0.0.1','port':61622,'user':'yumidang_queue_tls_login','password':password,'database':'postgres','ca':str(ROOT/'ca.crt')}));p.chmod(0o600)
 print(json.dumps({'created':NAME,'sql99Restored':True,'dedicatedLogin':True,'tlsConfigured':True,'operatingChanged':False,'connectionValidation':'NOT_RUN'}))
if __name__=='__main__':
 import sys
 if sys.argv[1:]==['--validate']:validate()
 else:prepare()
