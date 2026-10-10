"""민규: 새 격리 DB/GoTrue/REST에서 세션 삭제와 HTTP 탈퇴 재시도 경계만 검증한다.

캐시 이미지·내부 network·합성 비밀번호만 사용한다. 외부 DELETE는 실행하지 않는다.
실패 환경/자료는 보존하며 실행을 자동 재시도하지 않는다.
"""
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import sys

REPO = Path(__file__).resolve().parents[3]
SOURCE = 'yumidang-minkyu-invocation109-20261009-v1'
BOOT = 'yumidang_production_recovery_bootstrap'
assert sys.argv[1:] in ([], ['--revision-v2'], ['--revision-v3'], ['--revision-v4'], ['--revision-v5'], ['--revision-v6'], ['--revision-v7'], ['--revision-v8'], ['--revision-v9'], ['--revision-v10'], ['--observe-v7'], ['--observe-auth503-v10']), 'EXPLICIT_REVIEWED_REVISION_REQUIRED'
AUTH503_OBSERVE = sys.argv[1:] == ['--observe-auth503-v10']
OBSERVE_ONLY = sys.argv[1:] == ['--observe-v7'] or AUTH503_OBSERVE
REVISION = 'v10' if AUTH503_OBSERVE else ('v7' if OBSERVE_ONLY else (sys.argv[1].removeprefix('--revision-') if sys.argv[1:] else 'v1'))
NAME = 'yumidang-minkyu-retirement-auth-20261009-' + REVISION
AUTH, REST, NETWORK = NAME + '-auth', NAME + '-rest', NAME + '-network'
ROOT = Path('/private/tmp/yumidang-retirement-auth-20261009-' + REVISION)
DOCKER = ['docker', '--host', 'unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock']
AUTH_IMAGE = 'public.ecr.aws/supabase/gotrue:v2.196.0'
REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v16.1'
CREATED = {}
RECEIPT_REVISION = REVISION in ('v8','v9','v10')


def save(name, value):
    data = value if isinstance(value, bytes) else (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)).encode()
    with os.fdopen(os.open(ROOT / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as out:
        out.write(data)


def call(args, data=None, timeout=120):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        save('failure-' + uuid.uuid4().hex + '.log', result.stdout + result.stderr)
        raise RuntimeError('LOCAL_AUTH_TEST_FAILED_PRIVATE_EVIDENCE_PRESERVED')
    return result.stdout


def docker(*args, data=None):
    return call(DOCKER + list(args), data)


def inspect(name):
    return json.loads(docker('inspect', name))[0]


def sql(query, name=NAME):
    assert name in (NAME, SOURCE), 'UNOWNED_DATABASE_TARGET'
    if name == SOURCE:
        query = 'begin read only;' + query + 'rollback;'
    return docker('exec', '-i', name, 'psql', '-XqAt', '-U', BOOT, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', data=query.encode()).decode().strip()


def snapshot(name):
    tables = json.loads(sql("select coalesce(json_agg(json_build_array(n.nspname,c.relname)order by n.nspname,c.relname),'[]')from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in('r','p','m')and left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema';", name))
    selects = []
    for schema, table in tables:
        relation = '"' + schema.replace('"', '""') + '"."' + table.replace('"', '""') + '"'
        key = (schema + '.' + table).replace("'", "''")
        selects.append("select '" + key + "' as key,count(*)||':'||md5(coalesce(string_agg(to_jsonb(x)::text,','order by to_jsonb(x)::text),''))as value from " + relation + ' x')
    rows = json.loads(sql("select coalesce(json_object_agg(key,value),'{}')from(" + ' union all '.join(selects) + ')digests;', name)) if selects else {}
    queries = {
        'functions': "select coalesce(string_agg(n.nspname||'.'||p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid)||':'||coalesce(p.proacl::text,'NULL'),'|'order by n.nspname,p.oid::regprocedure::text),'')from pg_proc p join pg_namespace n on n.oid=p.pronamespace where left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema'and p.prokind='f';",
        'roles': "select coalesce(json_agg(json_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig)order by rolname),'[]')from pg_roles where rolname not like 'pg_%';",
        'memberships': "select coalesce(json_agg(json_build_array(a.rolname,b.rolname,m.admin_option,m.inherit_option,m.set_option)order by a.rolname,b.rolname),'[]')from pg_auth_members m join pg_roles a on a.oid=m.roleid join pg_roles b on b.oid=m.member;",
        'relations': "select coalesce(string_agg(n.nspname||'.'||c.relname||':'||c.relkind::text||':'||pg_get_userbyid(c.relowner)||':'||c.relrowsecurity||':'||c.relforcerowsecurity||':'||coalesce((select jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee)end,a.privilege_type,a.is_grantable)order by pg_get_userbyid(a.grantor),case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee)end,a.privilege_type,a.is_grantable)from aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S'then 'S'::\"char\" else 'r'::\"char\" end,c.relowner)))a)::text,'[]'),'|'order by n.nspname,c.relname),'')from pg_class c join pg_namespace n on n.oid=c.relnamespace where left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema';",
        'columns': "select coalesce(string_agg(n.nspname||'.'||c.relname||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),''),'|'order by n.nspname,c.relname,a.attnum),'')from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where a.attnum>0 and not a.attisdropped and left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema';",
    }
    catalog = json.loads(sql((REPO/'tools/local/remote_schema_catalog.sql').read_text(), name))['static']
    return {'rows': rows, 'catalog': {key: hashlib.sha256(sql(query, name).encode()).hexdigest() for key, query in queries.items()}, 'static': catalog}


def prove_clone(before, actual):
    save('clone-baseline-private.json', actual)
    different = [key for key in before if before[key] != actual[key]]
    constraint_differences = [entry['name'] for entry, restored in zip(before['static']['constraints'], actual['static']['constraints']) if entry != restored]
    save('clone-catalog-diagnostics.json', {'differentSections': different, 'constraintNames': constraint_differences})
    expected = copy.deepcopy(before)
    assert len(expected['static']['constraints']) == len(actual['static']['constraints']), 'CONSTRAINT_COUNT_CHANGED'
    reparsed = []
    for original, restored in zip(expected['static']['constraints'], actual['static']['constraints']):
        if original == restored:
            continue
        assert (original['schema'], original['table'], original['name']) in {
            ('private', 'general_sanction_appeal_receipts', 'general_sanction_appeal_receipts_reason_check'),
            ('private', 'worker_jobs', 'worker_jobs_dedupe_key_check')
        }, 'UNEXPECTED_CONSTRAINT_DIFFERENCE'
        assert {k:v for k,v in original.items() if k!='definitionMd5'} == {k:v for k,v in restored.items() if k!='definitionMd5'}, 'CONSTRAINT_METADATA_CHANGED'
        identity = original['schema'] + '.' + original['table']
        definition = sql("set local search_path=pg_catalog;select pg_get_constraintdef(oid,false)from pg_constraint where conrelid='" + identity + "'::regclass and conname='" + original['name'] + "';", SOURCE)
        digest = sql('begin;set local search_path=pg_catalog;create temp table recovery_check(reason text,dedupe_key text);alter table recovery_check add constraint normalized ' + definition + ";select md5(pg_get_constraintdef(oid,false))from pg_constraint where conrelid='pg_temp.recovery_check'::regclass and conname='normalized';rollback;")
        assert digest == restored['definitionMd5'], 'CONSTRAINT_REPARSE_MISMATCH'
        original['definitionMd5'] = digest
        reparsed.append(original['name'])
    assert expected == actual, 'CLONE_SOURCE_MISMATCH'
    return reparsed


def closed(name):
    assert sql("select not(select enabled from private.worker_invocation_control)and not(select enabled from private.worker_runtime_atomic_control)and not(select external_deletion_approved from private.member_cleanup_guard)and not(select token is not null from private.global_worker_run);", name) == 't', 'SOURCE_CONTROLS_NOT_CLOSED'
    assert sql('show cron.launch_active_jobs;', name) == 'off', 'SOURCE_CRON_NOT_CLOSED'
    if name!=SOURCE and sql("select to_regclass('private.member_retirement_receipt_control')is not null;",name)=='t':
        assert sql('select not enabled from private.member_retirement_receipt_control where singleton;',name)=='t','RECEIPT_GATE_NOT_CLOSED'


def record_created(name):
    value = inspect(name)
    assert (value['Config'].get('Labels') or {}).get('yumidang.owner') == 'minkyu'
    CREATED[name] = value['Id']


def jwt(secret, role):
    enc = lambda value: base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).rstrip(b'=')
    data = enc({'alg': 'HS256', 'typ': 'JWT'}) + b'.' + enc({'role': role, 'iss': 'supabase', 'exp': int(time.time()) + 3600})
    return (data + b'.' + base64.urlsafe_b64encode(hmac.new(secret.encode(), data, hashlib.sha256).digest()).rstrip(b'=')).decode()


def upstream(path, method, headers, body=None):
    if path.startswith('/auth/v1/'):
        target = 'http://' + AUTH + ':9999/' + path.removeprefix('/auth/v1/')
    elif path.startswith('/rest/v1/rpc/') and not OBSERVE_ONLY:
        target = 'http://' + REST + ':3000/rpc/' + path.removeprefix('/rest/v1/rpc/')
    else:
        raise RuntimeError('LOCAL_PATH_FORBIDDEN')
    assert method in ('GET', 'POST'), 'DELETE_FORBIDDEN'
    lines = ['silent', 'show-error', 'max-time = 2' if AUTH503_OBSERVE else 'max-time = 60', 'request = ' + json.dumps(method), 'url = ' + json.dumps(target)]
    for key in ('authorization', 'apikey', 'content-type'):
        if key in headers:
            assert '\r' not in headers[key] and '\n' not in headers[key]
            lines.append('header = ' + json.dumps(key + ': ' + headers[key]))
    if body is not None:
        lines.append('data-binary = ' + json.dumps(body.decode()))
    result = docker('exec', '-i', NAME, 'curl', '--config', '-', '--write-out', '\n%{http_code}', data=('\n'.join(lines) + '\n').encode())
    content, status = result.rsplit(b'\n', 1)
    return int(status), content


class Gateway(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def handle_request(self):
        try:
            headers = {key.lower(): value for key, value in self.headers.items()}
            body = self.rfile.read(int(headers.get('content-length', '0'))) if self.command == 'POST' else None
            assert body is None or len(body) <= 65536
            status, content = upstream(self.path, self.command, headers, body)
            self.send_response(status)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except Exception:
            content = b'{"code":"LOCAL_GATEWAY_FAILED"}'
            self.send_response(503)
            self.send_header('content-length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)

    do_GET = handle_request
    do_POST = handle_request


def run():
    assert not ROOT.exists(), 'EXISTING_ARTIFACTS_PRESERVED'
    ROOT.mkdir(mode=0o700)
    existing = docker('ps', '-a', '--format', '{{.Names}}').decode().splitlines()
    assert not set((NAME, AUTH, REST)).intersection(existing), 'EXISTING_TARGETS_PRESERVED'
    assert NETWORK not in docker('network', 'ls', '--format', '{{.Name}}').decode().splitlines()
    source = inspect(SOURCE)
    assert source['State']['Running'] and (source['Config'].get('Labels') or {}).get('yumidang.owner') == 'minkyu'
    assert not source['Mounts'] and not source['HostConfig'].get('PortBindings')
    closed(SOURCE)
    assert sql('show listen_addresses;', SOURCE) == ''
    before = snapshot(SOURCE)
    save('source-baseline-private.json', before)
    dump = docker('exec', SOURCE, 'pg_dump', '-U', BOOT, '-d', 'postgres', '-Fc')
    roles = docker('exec', SOURCE, 'pg_dumpall', '-U', BOOT, '--roles-only', '--no-role-passwords')
    save('source.dump', dump)
    save('source-roles.sql', roles)
    assert snapshot(SOURCE) == before
    for image in (AUTH_IMAGE, REST_IMAGE):
        docker('image', 'inspect', image)
    docker('network', 'create', '--internal', '--label', 'yumidang.owner=minkyu', NETWORK)
    assert json.loads(docker('network', 'inspect', NETWORK))[0]['Internal'] is True
    docker('run', '-d', '--name', NAME, '--network', NETWORK, '--pull', 'never', '--memory', '512m', '--label', 'yumidang.owner=minkyu',
           '--user', 'postgres', '--entrypoint', 'sh', source['Image'], '-c',
           'if [ ! -f /tmp/retirement-data/PG_VERSION ]; then initdb -U ' + BOOT + " -D /tmp/retirement-data --auth-local=trust --auth-host=reject || exit 1; fi; exec postgres -D /tmp/retirement-data -c listen_addresses='*' -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off -c shared_buffers=16MB -c max_connections=40")
    record_created(NAME)
    for _ in range(50):
        p = subprocess.run(DOCKER + ['exec', NAME, 'pg_isready', '-U', BOOT], capture_output=True, timeout=5)
        if p.returncode == 0:
            break
        time.sleep(.2)
    else:
        raise RuntimeError('CLONE_NOT_READY')
    role_sql = re.sub(r' GRANTED BY [A-Za-z_][A-Za-z0-9_]*;', ';', roles.decode())
    role_sql = '\n'.join(line for line in role_sql.splitlines() if not re.match(r'(CREATE|ALTER) ROLE ' + BOOT + r'(?: |;)', line))
    sql(role_sql)
    docker('exec', '-i', NAME, 'pg_restore', '-U', BOOT, '-d', 'postgres', '--single-transaction', '--exit-on-error', data=dump)
    reparsed_checks = prove_clone(before, snapshot(NAME))
    closed(NAME)
    if RECEIPT_REVISION:
        migration=REPO/'backend/supabase/migrations/20261009011700_member_retirement_receipt.sql'
        sql(migration.read_text())
        sql((REPO/'tests/database/minkyu/member_retirement_receipt.sql').read_text())
        save('sql117-applied.json',{'sha256':hashlib.sha256(migration.read_bytes()).hexdigest(),'defaultClosed':True,'sqlContractTest':'PASS'})
    # 원본 자격 증명/CA를 재사용하지 않고 정확한 새 clone hostname SAN을 만든다.
    call(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(ROOT/'ca.key'), '-out', str(ROOT/'ca.crt'), '-days', '1', '-subj', '/CN=retirement-local-ca', '-addext', 'basicConstraints=critical,CA:TRUE'])
    call(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(ROOT/'server.key'), '-out', str(ROOT/'server.csr'), '-subj', '/CN='+NAME])
    save('server.ext', 'subjectAltName=DNS:' + NAME + '\nextendedKeyUsage=serverAuth\n')
    call(['openssl', 'x509', '-req', '-in', str(ROOT/'server.csr'), '-CA', str(ROOT/'ca.crt'), '-CAkey', str(ROOT/'ca.key'), '-set_serial', str(secrets.randbits(128)), '-out', str(ROOT/'server.crt'), '-days', '1', '-extfile', str(ROOT/'server.ext')])
    for item in ROOT.iterdir():
        item.chmod(0o600)
    for name in ('server.crt', 'server.key'):
        docker('cp', str(ROOT/name), NAME+':/tmp/'+name)
    docker('exec', '--user', 'root', NAME, 'sh', '-c', 'chown postgres:postgres /tmp/server.key /tmp/server.crt && chmod 600 /tmp/server.key /tmp/server.crt')
    auth_password, rest_password, secret = (secrets.token_urlsafe(36) for _ in range(3))
    sql("alter role supabase_auth_admin login password '"+auth_password+"';create role retirement_rest_login login noinherit password '"+rest_password+"';grant anon,authenticated,service_role to retirement_rest_login with admin false,inherit false,set true;")
    hba = 'local all all trust\nhostssl postgres supabase_auth_admin,retirement_rest_login 0.0.0.0/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n'
    docker('exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/retirement-data/pg_hba.conf', data=hba.encode())
    sql("alter system set ssl='on';alter system set ssl_cert_file='/tmp/server.crt';alter system set ssl_key_file='/tmp/server.key';select pg_reload_conf();")
    gateway = ThreadingHTTPServer(('127.0.0.1', 0), Gateway)
    origin = 'http://127.0.0.1:'+str(gateway.server_port)
    auth_env = {'GOTRUE_API_HOST':'0.0.0.0','GOTRUE_API_PORT':'9999','API_EXTERNAL_URL':origin+'/auth/v1',
        'GOTRUE_DB_DRIVER':'postgres','GOTRUE_DB_DATABASE_URL':'postgresql://supabase_auth_admin:'+auth_password+'@'+NAME+':5432/postgres?sslmode=verify-full&sslrootcert=/certs/ca.crt',
        'GOTRUE_SITE_URL':origin,'GOTRUE_JWT_SECRET':secret,'GOTRUE_JWT_AUD':'authenticated','GOTRUE_JWT_DEFAULT_GROUP_NAME':'authenticated',
        **({'GOTRUE_JWT_ISSUER':origin+'/auth/v1'}if RECEIPT_REVISION else{}),'GOTRUE_JWT_ADMIN_ROLES':'service_role','GOTRUE_JWT_EXP':'3600','GOTRUE_DISABLE_SIGNUP':'true','GOTRUE_EXTERNAL_EMAIL_ENABLED':'true',
        'GOTRUE_MAILER_AUTOCONFIRM':'true','GOTRUE_EXTERNAL_PHONE_ENABLED':'false','GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED':'false','GOTRUE_LOG_LEVEL':'error'}
    rest_env={'PGRST_DB_URI':'postgresql://retirement_rest_login:'+rest_password+'@'+NAME+':5432/postgres?sslmode=verify-full&sslrootcert=/certs/ca.crt',
        'PGRST_DB_SCHEMAS':'public','PGRST_DB_ANON_ROLE':'anon','PGRST_JWT_SECRET':secret,'PGRST_SERVER_PORT':'3000',**({'PGRST_JWT_AUD':'authenticated'}if RECEIPT_REVISION else{})}
    for name, env in (('auth',auth_env),('rest',rest_env)):
        save(name+'-private.env','\n'.join(key+'='+value for key,value in env.items())+'\n')
        target, image=(AUTH,AUTH_IMAGE)if name=='auth'else(REST,REST_IMAGE)
        docker('run','-d','--name',target,'--network',NETWORK,'--pull','never','--memory','128m','--user','0:0','--label','yumidang.owner=minkyu',
            '--env-file',str(ROOT/(name+'-private.env')),'--mount','type=bind,src='+str(ROOT/'ca.crt')+',dst=/certs/ca.crt,readonly',image)
        record_created(target)
    threading.Thread(target=gateway.serve_forever,daemon=True).start()
    for _ in range(50):
        try:
            probe = subprocess.run(DOCKER+['exec',NAME,'curl','--max-time','2','-s','-o','/dev/null','-w','%{http_code}','http://'+AUTH+':9999/health'],capture_output=True,timeout=8)
        except subprocess.TimeoutExpired:
            time.sleep(.2)
            continue
        if probe.returncode==0 and probe.stdout==b'200':
            break
        time.sleep(.2)
    else:
        for name in (AUTH,REST): save(name+'-failure.log',docker('logs',name))
        raise RuntimeError('LOCAL_AUTH_NOT_READY')
    anon, service = jwt(secret,'anon'), jwt(secret,'service_role')
    q=lambda value:"'"+value.replace("'","''")+"'"
    subject='retirement-local-'+uuid.uuid4().hex
    account=json.loads(sql("select public.resolve_naver_account("+q(subject)+",'합성탈퇴회원','F','1990-01-01');"))
    assert account['status']=='photo_required' and account['userId'] is None, 'SYNTHETIC_ACCOUNT_NOT_RESERVED'
    email, password = account['authEmail'], secrets.token_urlsafe(36)
    save('synthetic-password-private.json',{'email':email,'password':password})
    save('auth-admin-create-intent.json',{'path':'/auth/v1/admin/users','attempt':1})
    headers={'authorization':'Bearer '+service,'apikey':service,'content-type':'application/json'}
    status, raw = upstream('/auth/v1/admin/users','POST',headers,json.dumps({'email':email,'password':password,'email_confirm':True}).encode())
    save('auth-admin-create-result.json',{'status':status})
    assert status==200, 'SYNTHETIC_ADMIN_CREATE_FAILED'
    user_id=json.loads(raw)['id']
    save('auth-password-login-intent.json',{'path':'/auth/v1/token','attempt':1})
    status, raw=upstream('/auth/v1/token?grant_type=password','POST',{'apikey':anon,'content-type':'application/json'},json.dumps({'email':email,'password':password}).encode())
    save('auth-password-login-result.json',{'status':status})
    assert status==200, 'SYNTHETIC_PASSWORD_LOGIN_FAILED'
    session=json.loads(raw)
    session_id=json.loads(base64.urlsafe_b64decode(session['access_token'].split('.')[1]+'=='))['session_id']
    save('auth-fixture-private.json',{'email':email,'password':password,'session':session})
    # 공급사 응답/실회원 없이 local owner가 최소 계정·episode fixture만 만든다.
    sql("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false);select public.record_naver_session("+q(subject)+","+q(user_id)+"::uuid,"+q(session_id)+"::uuid);insert into public.profiles(id,real_name,birth_date,gender)values("+q(user_id)+"::uuid,'합성탈퇴회원','1990-01-01','female');")
    withdrawal=str(uuid.uuid4())
    save('node-private.json',{'origin':origin,'anon':anon,'service':service,'token':session['access_token'],'userId':user_id,'withdrawalId':withdrawal})
    # 세션 삭제를 관측하는 목적에 한정하여 clone pipeline guard와 원래5포트만 연다. DELETE 실행0.
    signatures=['claim_member_cleanup_task(uuid)','check_member_cleanup_task(uuid,uuid,uuid,uuid)','get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)','record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)','complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)']
    sql('begin;update private.member_cleanup_guard set external_deletion_approved=true;grant execute on function '+','.join('public.'+signature for signature in signatures)+' to service_role;commit;')
    output=call(['node','--experimental-strip-types',str(REPO/'tests/integration/minkyu/member_retirement_auth_local.ts'),str(ROOT/'node-private.json'),*(['--receipt-initial']if RECEIPT_REVISION else[])],timeout=60)
    observations=json.loads(output)
    save('http-observations.json',observations)
    state=json.loads(sql("select json_build_object('users',(select count(*)from auth.users where id="+q(user_id)+"::uuid),'sessions',(select count(*)from auth.sessions where user_id="+q(user_id)+"::uuid),'retirements',(select count(*)from private.member_retirements where profile_id="+q(user_id)+"::uuid and withdrawal_id="+q(withdrawal)+"::uuid),'state',(select state from private.member_retirements where withdrawal_id="+q(withdrawal)+"::uuid),'tasks',(select count(*)from private.member_cleanup_tasks where withdrawal_id="+q(withdrawal)+"::uuid),'acks',(select count(*)from private.member_cleanup_delete_acks where withdrawal_id="+q(withdrawal)+"::uuid));"))
    assert state=={'users':1,'sessions':0,'retirements':1,'state':'pending_cleanup','tasks':1,'acks':0}, 'RETIREMENT_NOT_SESSIONS_ONLY'
    proof=None
    if RECEIPT_REVISION:
        # issuer는 신뢰할 GoTrue API_EXTERNAL_URL 설정에서 구성한다. JWT의 self-claim을 신뢰하지 않는다.
        sql("update private.member_retirement_receipt_control set enabled=true,expected_issuer="+q(origin+'/auth/v1')+";")
        claims=json.loads(base64.urlsafe_b64decode(session['access_token'].split('.')[1]+'=='))
        enc=lambda v:base64.urlsafe_b64encode(json.dumps(v,separators=(',',':')).encode()).rstrip(b'=')
        def sign(value):
            message=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc(value)
            return(message+b'.'+base64.urlsafe_b64encode(hmac.new(secret.encode(),message,hashlib.sha256).digest()).rstrip(b'=')).decode()
        controls={}
        changes={'expired':{'exp':int(time.time())-60},'wrong_issuer':{'iss':'https://wrong.fixture.invalid/auth/v1'},'wrong_audience':{'aud':'wrong'},'wrong_sub':{'sub':str(uuid.uuid4())},'anonymous':{'is_anonymous':True},'service_role':{'role':'service_role'}}
        for key,value in changes.items():controls[key]=sign({**claims,**value})
        for key,field in [('missing_issuer','iss'),('missing_audience','aud'),('missing_expiry','exp')]:
            value=dict(claims);value.pop(field,None);controls[key]=sign(value)
        controls['wrong_signature']=sign(claims).rsplit('.',1)[0]+'.'+base64.urlsafe_b64encode(bytes(32)).rstrip(b'=').decode()
        save('receipt-proof-node-private.json',{'origin':origin,'anon':anon,'service':service,'token':session['access_token'],'userId':user_id,'withdrawalId':withdrawal,'otherWithdrawal':str(uuid.uuid4()),'negativeTokens':controls})
        clone_before=snapshot(NAME);save('receipt-proof-clone-before-private.json',clone_before)
        proof=json.loads(call(['node','--experimental-strip-types',str(REPO/'tests/integration/minkyu/member_retirement_auth_local.ts'),str(ROOT/'receipt-proof-node-private.json'),'--receipt-proof'],timeout=120))
        save('receipt-proof-http-observations.json',proof)
        clone_after=snapshot(NAME);save('receipt-proof-clone-after-private.json',clone_after)
        assert clone_before==clone_after,'GET_ONLY_RECOVERY_CHANGED_CLONE'
        # current-state gate만 owner fixture로 바꾸고 원상복구한다. 원 탈퇴/DELETE/ACK 재전송0.
        ended_at=sql("select ended_at::text from private.member_episodes where id=(select episode_id from private.member_retirements where withdrawal_id="+q(withdrawal)+"::uuid);")
        sql("update private.member_episodes set ended_at=ended_at+interval '1 second'where id=(select episode_id from private.member_retirements where withdrawal_id="+q(withdrawal)+"::uuid);")
        try:
            state_denied=json.loads(call(['node','--experimental-strip-types',str(REPO/'tests/integration/minkyu/member_retirement_auth_local.ts'),str(ROOT/'receipt-proof-node-private.json'),'--receipt-state-denied'],timeout=60))
            save('receipt-current-state-negative.json',state_denied)
        finally:sql("update private.member_episodes set ended_at="+q(ended_at)+"::timestamptz where id=(select episode_id from private.member_retirements where withdrawal_id="+q(withdrawal)+"::uuid);")
        assert snapshot(NAME)==clone_before,'CURRENT_STATE_FIXTURE_NOT_RESTORED'
        sql('update private.member_retirement_receipt_control set enabled=false;')

    sql('begin;update private.member_cleanup_guard set external_deletion_approved=false;revoke all on function '+','.join('public.'+signature for signature in signatures)+' from service_role;commit;')
    closed(NAME)
    after=snapshot(SOURCE)
    assert after==before, 'SOURCE_CHANGED'
    save('source-after-private.json',after)
    receipt={'status':'PASS','authImage':AUTH_IMAGE,'sourceUnchanged':True,'sourceTableCount':len(before['rows']),
        'nativeAuthSessionDeletion':observations,'authUsersDeleted':False,'externalDeleteCalls':0,'ackCount':0,
        'fullCleanup':'NOT_RUN','retryProofImplementation':'PASS'if proof else'NOT_RUN','receiptRecovery':proof,'localRawHttpIsolatedScope':True,'dbTlsVerifyFull':True,'controlsClosed':True,'constraintReparseVerified':reparsed_checks}
    save('receipt.json',receipt)
    gateway.shutdown()
    return receipt


def observe_v7():
    # 원 탈퇴·Auth 발급을 재전송하지 않는다. 기존 실패 v7에 대해 조회만 허용한다.
    assert ROOT.is_dir() and ROOT.resolve()==ROOT and ROOT.stat().st_mode & 0o077 == 0
    assert not (ROOT/'observation-receipt.json').exists(), 'EXISTING_OBSERVATION_PRESERVED'
    assert (ROOT/'node-private.json').is_file() and not (ROOT/'receipt.json').exists()
    before=snapshot(SOURCE)
    assert before==json.loads((ROOT/'source-baseline-private.json').read_text())==json.loads((ROOT/'source-final-private.json').read_text()), 'SOURCE_CHANGED_BEFORE_OBSERVATION'
    closed(SOURCE)
    private=json.loads((ROOT/'node-private.json').read_text())
    q=lambda value:"'"+value.replace("'","''")+"'"
    state_query="select json_build_object('users',(select count(*)from auth.users where id="+q(private['userId'])+"::uuid),'sessions',(select count(*)from auth.sessions where user_id="+q(private['userId'])+"::uuid),'retirements',(select count(*)from private.member_retirements where profile_id="+q(private['userId'])+"::uuid and withdrawal_id="+q(private['withdrawalId'])+"::uuid),'state',(select state from private.member_retirements where withdrawal_id="+q(private['withdrawalId'])+"::uuid),'tasks',(select count(*)from private.member_cleanup_tasks where withdrawal_id="+q(private['withdrawalId'])+"::uuid),'acks',(select count(*)from private.member_cleanup_delete_acks where withdrawal_id="+q(private['withdrawalId'])+"::uuid));"
    allowed_state={'users':1,'sessions':0,'retirements':1,'state':'pending_cleanup','tasks':1,'acks':0}
    for name in (NAME,AUTH):
        value=inspect(name)
        assert not value['State']['Running'] and not value['HostConfig'].get('PortBindings')
        assert (value['Config'].get('Labels')or{}).get('yumidang.owner')=='minkyu'
        assert set(value['NetworkSettings']['Networks'])=={NETWORK}
        assert json.loads(docker('network','inspect',NETWORK))[0]['Internal'] is True
        docker('start',name)
        record_created(name)
    for _ in range(50):
        p=subprocess.run(DOCKER+['exec',NAME,'pg_isready','-U',BOOT],capture_output=True,timeout=5)
        if p.returncode==0:break
        time.sleep(.2)
    else:raise RuntimeError('READ_ONLY_CLONE_NOT_READY')
    closed(NAME)
    assert json.loads(sql(state_query))==allowed_state, 'PRIOR_RETIREMENT_STATE_NOT_CONFIRMED'
    clone_before=snapshot(NAME)
    save('observation-clone-before-private.json',clone_before)
    gateway=ThreadingHTTPServer(('127.0.0.1',0),Gateway)
    private['origin']='http://127.0.0.1:'+str(gateway.server_port)
    save('observation-node-private.json',private)
    threading.Thread(target=gateway.serve_forever,daemon=True).start()
    try:
        for _ in range(50):
            probe=subprocess.run(DOCKER+['exec',NAME,'curl','--max-time','2','-s','-o','/dev/null','-w','%{http_code}','http://'+AUTH+':9999/health'],capture_output=True,timeout=5)
            if probe.stdout==b'200':break
            time.sleep(.2)
        else:raise RuntimeError('READ_ONLY_AUTH_NOT_READY')
        result=json.loads(call(['node','--experimental-strip-types',str(REPO/'tests/integration/minkyu/member_retirement_auth_local.ts'),str(ROOT/'observation-node-private.json'),'--retry-only'],timeout=60))
        save('read-only-http-observations.json',result)
        clone_after=snapshot(NAME)
        save('observation-clone-after-private.json',clone_after)
        assert clone_after==clone_before and json.loads(sql(state_query))==allowed_state, 'READ_ONLY_OBSERVATION_CHANGED_CLONE'
        closed(NAME)
        source_after=snapshot(SOURCE)
        save('observation-source-after-private.json',source_after)
        assert source_after==before, 'SOURCE_CHANGED_DURING_OBSERVATION'
        receipt={'status':'PASS','scope':'read_only_followup_after_v7_failed_401_expectation','sourceUnchanged':True,'cloneUnchanged':True,'sourceTableCount':len(before['rows']),'actualAuthUserStatus':result['afterUserStatus'],'sameWithdrawalHttpRetry':result,'sessionsDeleted':True,'authUserStillPresent':True,'cleanupTasksPending':1,'ackCount':0,'externalDeleteCalls':0,'retirementRpcReexecuted':False,'fullCleanup':'NOT_RUN','retryProofImplementation':'NOT_RUN','localRawHttpIsolatedScope':True,'dbTlsVerifyFull':True,'controlsClosed':True}
        save('observation-receipt.json',receipt)
        return receipt
    finally:gateway.shutdown()


def observe_auth503():
    # 실제 Auth/REST를 중지한 상태에서 장애를 관측한다. DB fixture mutation·발급·탈퇴 재전송0.
    assert ROOT.is_dir() and ROOT.resolve()==ROOT and ROOT.stat().st_mode&0o077==0
    assert json.loads((ROOT/'receipt.json').read_text())['status']=='PASS'
    assert not (ROOT/'auth503-receipt.json').exists(), 'EXISTING_AUTH503_OBSERVATION_PRESERVED'
    source_before=snapshot(SOURCE)
    assert source_before==json.loads((ROOT/'source-final-private.json').read_text()),'SOURCE_CHANGED_BEFORE_AUTH503'
    closed(SOURCE)
    for name in (NAME,AUTH,REST):
        value=inspect(name)
        assert not value['State']['Running'] and not value['HostConfig'].get('PortBindings')
        assert (value['Config'].get('Labels')or{}).get('yumidang.owner')=='minkyu'
        assert set(value['NetworkSettings']['Networks'])=={NETWORK}
    assert json.loads(docker('network','inspect',NETWORK))[0]['Internal'] is True
    docker('start',NAME);record_created(NAME)
    for _ in range(50):
        probe=subprocess.run(DOCKER+['exec',NAME,'pg_isready','-U',BOOT],capture_output=True,timeout=5)
        if probe.returncode==0:break
        time.sleep(.2)
    else:raise RuntimeError('AUTH503_CLONE_NOT_READY')
    closed(NAME)
    clone_before=snapshot(NAME);save('auth503-clone-before-private.json',clone_before)
    gateway=ThreadingHTTPServer(('127.0.0.1',0),Gateway)
    fixture=json.loads((ROOT/'node-private.json').read_text());fixture['origin']='http://127.0.0.1:'+str(gateway.server_port)
    save('auth503-node-private.json',fixture)
    threading.Thread(target=gateway.serve_forever,daemon=True).start()
    try:
        observation=json.loads(call(['node','--experimental-strip-types',str(REPO/'tests/integration/minkyu/member_retirement_auth_local.ts'),str(ROOT/'auth503-node-private.json'),'--auth-unavailable'],timeout=60))
        clone_after=snapshot(NAME);save('auth503-clone-after-private.json',clone_after)
        source_after=snapshot(SOURCE);save('auth503-source-after-private.json',source_after)
        assert clone_after==clone_before and source_after==source_before,'AUTH503_OBSERVATION_CHANGED_DATABASE'
        closed(NAME)
        receipt={'status':'PASS','authUnavailable':observation,'cloneUnchanged':True,'sourceUnchanged':True,'authAndRestStayedStopped':True,'externalDeleteCalls':0,'ackCount':0,'controlsClosed':True}
        save('auth503-receipt.json',receipt)
        return receipt
    finally:gateway.shutdown()


if __name__=='__main__':
    try:
        result=observe_auth503() if AUTH503_OBSERVE else (observe_v7() if OBSERVE_ONLY else run())
    finally:
        try:
            if NAME in CREATED and not OBSERVE_ONLY:
                try:
                    sql('update private.member_cleanup_guard set external_deletion_approved=false;')
                    if RECEIPT_REVISION and sql("select to_regclass('private.member_retirement_receipt_control')is not null;")=='t':
                        sql('update private.member_retirement_receipt_control set enabled=false;')
                except Exception:
                    pass
            if (ROOT/'source-baseline-private.json').is_file():
                source_after=snapshot(SOURCE)
                save('auth503-source-final-private.json' if AUTH503_OBSERVE else ('observation-source-final-private.json' if OBSERVE_ONLY else 'source-final-private.json'),source_after)
                assert source_after==json.loads((ROOT/'source-baseline-private.json').read_text()), 'SOURCE_CHANGED_AT_CLOSE'
        finally:
            for name, expected_id in reversed(list(CREATED.items())):
                value=inspect(name)
                assert value['Id']==expected_id and (value['Config'].get('Labels')or{}).get('yumidang.owner')=='minkyu'
                docker('stop','--time','5',name)
    print(json.dumps(result))
