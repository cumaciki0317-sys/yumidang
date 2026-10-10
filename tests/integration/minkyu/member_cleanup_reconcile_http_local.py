"""실제 service-api runtime factory에 연결한 SQL115 GET-only bridge 검증.

기본 실행은 계획만 출력한다. 실제 실행은 root가 승인한 최신 제품 graph와
queue/ACK·메모리 준비 기록을 요구한다. 원 dispatch/ACK는 명시적 합성 SQL fixture이며
외부 DELETE·ACK 재전송, 운영 환경, 실제 회원, 원본 변경은 허용하지 않는다.
기존 미확정 행을 보존하므로 original invocation 준비 행만 합성 SQL로 생성하며
prepare_queue_invocation 정상 신규 준비 성공은 검증하지 않는다.
Storage 성공/finish 유실은 DB·REST·Storage 3개, Auth는 DB·REST·Auth 3개,
begin 유실/noACK는 DB·REST 2개만 생성한다. Auth·Storage 동시 4개가 필요한
원 SQL110 physical DELETE 레시피와 전체 Storage 파일 복원은 이 검증 범위 밖이다.
"""
import argparse
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote

REPO = Path(__file__).resolve().parents[3]
SOURCE = 'yumidang-minkyu-event112-20261009-v1'
BOOT = 'yumidang_production_recovery_bootstrap'
DOCKER = ['docker', '--host', 'unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock']
IMAGES = {'db': 'public.ecr.aws/supabase/postgres:17.6.1.165',
          'auth': 'public.ecr.aws/supabase/gotrue:v2.196.0',
          'rest': 'public.ecr.aws/supabase/postgrest:v16.1',
          'storage': 'public.ecr.aws/supabase/storage-api:v1.70.3'}
SQL114 = 'backend/supabase/migrations/20261009011400_worker_intent_confirmation.sql'
SQL115 = 'backend/supabase/migrations/20261009011500_member_cleanup_reconcile.sql'
SQL_SHAS = {SQL114: '7ba321e924e02bfea41a244435a21a5fc52d71e049421e178ca72a91358065ed',
            SQL115: '74a0d3b2af807310f76dd77d8769f3177ca8f47cef2161ca4b44f194bbb73081'}
REQUIRED = [SQL114, SQL115, 'tools/local/remote_schema_catalog.sql',
            'tests/integration/minkyu/member_retirement_auth_local.py',
            'tests/integration/minkyu/member_cleanup_reconcile_http_local.py',
            'tests/integration/minkyu/member_cleanup_reconcile_http_local.ts',
            'backend/supabase/functions/_shared/auth/member-cleanup.ts',
            'backend/supabase/functions/_shared/db/repositories/member-cleanup.ts',
            'backend/supabase/functions/_shared/db/transport.ts',
            'backend/supabase/functions/_shared/config/env.ts',
            'backend/supabase/functions/_shared/http/errors.ts']
HTTP_COMPONENT = 'backend/supabase/functions/service-api/member-cleanup-reconcile-http.ts'
HTTP_FACTORY = 'backend/supabase/functions/service-api/index.ts'
HTTP_HANDLER = 'backend/supabase/functions/service-api/handler.ts'
HTTP_SHAS = {HTTP_FACTORY:'21cd37176d6fb8819eeecce5f51d17ba7a3e857a3ad21f11a22e88fcba49e81d',
             HTTP_HANDLER:'000cbf9c68ba4ba8e3dccb1b3cf9aa2b49ced41acd6f2b91bdd965a8e5e1b841',
             HTTP_COMPONENT:'a0a280a2253b80b37635a78a036b1bdc54e2dceb7c2196858aef23f7f48eb134'}
REQUIRED.extend(HTTP_SHAS)
RPCS = {'begin_member_cleanup_reconcile', 'get_member_cleanup_reconcile',
        'finish_member_cleanup_reconcile', 'check_member_cleanup_task',
        'get_member_cleanup_delete_ack', 'get_queue_invocation', 'complete_queue_invocation',
        'read_worker_run_budget'}
SIGNATURES = ['begin_member_cleanup_reconcile(uuid,uuid,uuid,uuid)',
              'get_member_cleanup_reconcile(uuid)', 'finish_member_cleanup_reconcile(uuid,text)',
              'check_member_cleanup_task(uuid,uuid,uuid,uuid)',
              'get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)',
              'get_queue_invocation(uuid)', 'complete_queue_invocation(uuid)',
              'read_worker_run_budget(uuid)']
ROOT = NAME = NETWORK = None
CREATED = {}
FIXTURE = {}
COUNTS = {'forbidden': 0, 'delete': 0}
MEMORY_POLICIES = {
    'storage': {'minimumMiB':768, 'newContainers':3, 'containerLimitsMiB':1152, 'storageHeapMiB':128},
    'finish_loss': {'minimumMiB':768, 'newContainers':3, 'containerLimitsMiB':1152, 'storageHeapMiB':128},
    'finalize_loss': {'minimumMiB':768, 'newContainers':3, 'containerLimitsMiB':1152, 'storageHeapMiB':128},
    'auth': {'minimumMiB':1024, 'newContainers':3, 'containerLimitsMiB':768, 'storageHeapMiB':None},
    'begin_loss': {'minimumMiB':768, 'newContainers':2, 'containerLimitsMiB':640, 'storageHeapMiB':None},
    'no_ack': {'minimumMiB':768, 'newContainers':2, 'containerLimitsMiB':640, 'storageHeapMiB':None},
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(name, value):
    data = value if isinstance(value, bytes) else (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)).encode()
    with os.fdopen(os.open(ROOT / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        stream.write(data)


def call(args, data=None, timeout=120):
    try:
        result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        save('failure-' + uuid.uuid4().hex + '.log', (error.stdout or b'') + (error.stderr or b''))
        raise RuntimeError('ISOLATED_CALL_TIMEOUT_PRIVATE_EVIDENCE_PRESERVED') from None
    if result.returncode:
        save('failure-' + uuid.uuid4().hex + '.log', result.stdout + result.stderr)
        raise RuntimeError('ISOLATED_CALL_FAILED_PRIVATE_EVIDENCE_PRESERVED')
    return result.stdout


def docker(*args, data=None):
    return call(DOCKER + list(args), data)


def sql(statement, name=None):
    name = NAME if name is None else name
    assert name in (NAME, SOURCE), 'UNOWNED_DATABASE_TARGET'
    if name == SOURCE:
        statement = 'begin read only;' + statement + 'rollback;'
    return docker('exec', '-i', name, 'psql', '-XqAt', '-U', BOOT, '-d', 'postgres',
                  '-v', 'ON_ERROR_STOP=1', data=statement.encode()).decode().strip()


def inspect(name):
    return json.loads(docker('inspect', name))[0]


def record(name):
    info = inspect(name)
    assert (info['Config'].get('Labels') or {}).get('yumidang.owner') == 'minkyu'
    assert not info['HostConfig'].get('PortBindings'), 'PUBLISHED_PORT_FORBIDDEN'
    assert set(info['NetworkSettings']['Networks']) == {NETWORK}, 'NETWORK_ESCAPE'
    assert info['Config'].get('Healthcheck', {}).get('Test') == ['NONE'], 'IMAGE_HEALTHCHECK_NOT_DISABLED'
    if name != NAME:
        kind = name.removeprefix(NAME+'-')
        assert app_host(kind) in (info['NetworkSettings']['Networks'][NETWORK].get('Aliases') or []), 'APP_DNS_ALIAS_NOT_INSTALLED'
    CREATED[name] = info['Id']


def frozen_graph(path):
    assert path.is_file() and path.resolve() == path and not path.stat().st_mode & 0o077, 'PRIVATE_GRAPH_REQUIRED'
    value = json.loads(path.read_text())
    assert value.get('approvedByRoot') is True and value.get('queueAckReady') is True and value.get('memoryReady') is True, 'ROOT_FREEZE_QUEUE_ACK_AND_MEMORY_READY_REQUIRED'
    assert value.get('repository') == str(REPO), 'GRAPH_REPOSITORY_MISMATCH'
    files = value['files']
    assert set(REQUIRED).issubset(files), 'INCOMPLETE_FROZEN_GRAPH'
    # 실행 제품의 상대 import 전체를 동결한다. type import도 포함하며 원격 import는 허용하지 않는다.
    pending = [REPO/HTTP_COMPONENT, REPO/HTTP_FACTORY]
    visited = set()
    while pending:
        module = pending.pop().resolve()
        if module in visited:
            continue
        visited.add(module)
        assert module.is_relative_to(REPO) and module.is_file(), 'PRODUCT_IMPORT_MISSING_OR_ESCAPE'
        relative = str(module.relative_to(REPO))
        assert relative in files, 'PRODUCT_IMPORT_NOT_FROZEN'
        for dependency in re.findall(r'(?:from\s*|import\s*\(|import\s*)[\"\']([^\"\']+)[\"\']', module.read_text()):
            if dependency.startswith('.'):
                pending.append(module.parent/dependency)
            else:
                assert dependency.startswith('node:'), 'REMOTE_PRODUCT_IMPORT_FORBIDDEN'
    for relative, digest in files.items():
        target = REPO / relative
        assert not Path(relative).is_absolute() and target.resolve().is_relative_to(REPO), 'GRAPH_PATH_ESCAPE'
        assert re.fullmatch('[a-f0-9]{64}', digest) and sha(target) == digest, 'FROZEN_SOURCE_CHANGED'
    assert all(files[path] == digest for path, digest in SQL_SHAS.items()), 'SQL114115_NOT_FINAL'
    assert all(files[path] == digest for path, digest in HTTP_SHAS.items()), 'HTTP_FACTORY_GRAPH_NOT_FINAL'
    assert files['tests/integration/minkyu/member_cleanup_reconcile_http_local.py'] == sha(Path(__file__)), 'EXECUTING_DRIVER_NOT_FROZEN'
    return value, sha(path)


def snapshot_helpers():
    # 읽기만 사용하는 기존 전체 행·catalog·역할 비교와 좁은 CHECK 재파싱 증명을 재사용한다.
    path = REPO / 'tests/integration/minkyu/member_retirement_auth_local.py'
    spec = importlib.util.spec_from_file_location('member115_snapshot_helper', path)
    helper = importlib.util.module_from_spec(spec)
    previous = sys.argv
    try:
        sys.argv = [str(path)]
        spec.loader.exec_module(helper)
    finally:
        sys.argv = previous
    helper.ROOT, helper.NAME, helper.SOURCE, helper.REPO = ROOT, NAME, SOURCE, REPO
    helper.sql, helper.save = sql, save
    original_snapshot = helper.snapshot
    def with_grantors(name):
        value = original_snapshot(name)
        value['membershipGrantors'] = json.loads(sql("select coalesce(json_agg(json_build_array(pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor),admin_option,inherit_option,set_option)order by pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor)),'[]')from pg_auth_members;", name))
        return value
    helper.snapshot = with_grantors
    return helper


def memory_preflight(scenario, phase):
    # MemAvailable은 공유 VM kernel의 현재 값이다. boolean 승인이나 컨테이너 limit 합계로 대체하지 않는다.
    raw = docker('exec', SOURCE, 'cat', '/proc/meminfo').decode()
    values = {}
    for key in ('MemTotal', 'MemAvailable'):
        found = re.findall(r'^'+key+r':\s+([0-9]+)\s+kB\s*$', raw, re.M)
        assert len(found) == 1 and int(found[0]) > 0, 'MEMORY_INFORMATION_UNAVAILABLE'
        values[key] = int(found[0])
    assert values['MemAvailable'] <= values['MemTotal'], 'MEMORY_INFORMATION_INVALID'
    policy = MEMORY_POLICIES[scenario]
    enough = values['MemAvailable'] >= policy['minimumMiB'] * 1024
    save('memory-preflight-'+phase+'.json', {'scenario':scenario, 'memAvailableKiB':values['MemAvailable'], **policy,
                                          'containerLimitsAreReservations':False, 'enough':enough, 'createdContainers':len(CREATED)})
    assert not CREATED and enough, 'GLOBAL_MEMORY_INSUFFICIENT_CLONE0_NO_START'
    return values['MemAvailable']


def observed_network_subnets():
    identifiers = docker('network', 'ls', '--format', '{{.ID}}').decode().splitlines()
    assert identifiers and len(identifiers) == len(set(identifiers)), 'NETWORK_INVENTORY_INVALID'
    assert all(re.fullmatch(r'[a-f0-9]{12,64}', identifier) for identifier in identifiers), 'NETWORK_IDENTIFIER_INVALID'
    entries = []
    for start in range(0, len(identifiers), 32):
        inspected = json.loads(docker('network', 'inspect', *identifiers[start:start+32]))
        assert len(inspected) == len(identifiers[start:start+32]), 'NETWORK_INVENTORY_INCOMPLETE'
        entries.extend(inspected)
    subnets = []
    for entry in entries:
        configs = entry.get('IPAM', {}).get('Config') or []
        if entry.get('Driver') == 'bridge':
            assert configs and all(config.get('Subnet') for config in configs), 'BRIDGE_NETWORK_SUBNET_UNKNOWN'
        for config in configs:
            value = config.get('Subnet')
            if value:
                subnets.append(ipaddress.ip_network(value, strict=True))
    return subnets


def fresh_private_subnet(observed):
    # 주소 풀 고갈은 명시적 RFC1918 /24로 피한다. 기존 network/volume은 삭제하거나 재배정하지 않는다.
    for candidate in ipaddress.ip_network('10.240.0.0/12').subnets(new_prefix=24):
        if not any(other.version == candidate.version and candidate.overlaps(other) for other in observed):
            return candidate
    raise RuntimeError('NO_NONOVERLAPPING_PRIVATE_SUBNET_NO_START')


def plan_internal_network():
    first = observed_network_subnets()
    chosen = fresh_private_subnet(first)
    # 조정 신호와 무관한 다른 network 생성도 두 번째 실제 inventory에서 다시 확인한다.
    latest = observed_network_subnets()
    assert not any(other.version == chosen.version and chosen.overlaps(other) for other in latest), 'SUBNET_ALLOCATED_CONCURRENTLY_NO_START'
    save('network-allocation-private.json', {'chosenSubnet':str(chosen), 'gateway':str(chosen.network_address+1),
                                           'observedSubnets':sorted(str(value) for value in latest),
                                           'networkRemovalOrPrune':False, 'existingNetworksChanged':False})
    return chosen


def wait(command, label, attempts=40):
    started = time.monotonic()
    observations = []
    for _ in range(attempts):
        if time.monotonic()-started >= 60:
            break
        try:
            result = subprocess.run(DOCKER + command, capture_output=True, timeout=6)
            status = result.stdout.decode('ascii', errors='ignore').strip()
            observations.append({'elapsedMs':round((time.monotonic()-started)*1000), 'returnCode':result.returncode,
                                 'httpStatus':status if re.fullmatch(r'[1-5][0-9]{2}', status)else None})
            if result.returncode == 0:
                save('readiness-'+label+'-private.json', {'ready':True, 'observations':observations, 'rawResponseOrArgumentsStored':False})
                return
        except subprocess.TimeoutExpired:
            observations.append({'elapsedMs':round((time.monotonic()-started)*1000), 'subprocessTimeout':True})
        time.sleep(.25)
    save('readiness-'+label+'-private.json', {'ready':False, 'observations':observations, 'rawResponseOrArgumentsStored':False})
    raise RuntimeError(label + '_NOT_READY_NO_REPLAY')


def certificates():
    call(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(ROOT/'ca.key'),
          '-out', str(ROOT/'ca.crt'), '-days', '1', '-subj', '/CN=member115-isolated-ca',
          '-addext', 'basicConstraints=critical,CA:TRUE'])
    for leaf, san in [('server', 'DNS:' + NAME), ('https', 'DNS:localhost,IP:127.0.0.1')]:
        call(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(ROOT/(leaf+'.key')),
              '-out', str(ROOT/(leaf+'.csr')), '-subj', '/CN=' + (NAME if leaf == 'server' else 'localhost')])
        save(leaf+'.ext', 'subjectAltName='+san+'\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\n')
        call(['openssl', 'x509', '-req', '-in', str(ROOT/(leaf+'.csr')), '-CA', str(ROOT/'ca.crt'),
              '-CAkey', str(ROOT/'ca.key'), '-set_serial', str(secrets.randbits(128)), '-out', str(ROOT/(leaf+'.crt')),
              '-days', '1', '-extfile', str(ROOT/(leaf+'.ext'))])
    for item in ROOT.iterdir():
        item.chmod(0o600)
    for leaf in ('server.key', 'server.crt'):
        docker('cp', str(ROOT/leaf), NAME+':/tmp/'+leaf)
    docker('exec', '--user', 'root', NAME, 'sh', '-c', 'chown postgres:postgres /tmp/server.key /tmp/server.crt && chmod 600 /tmp/server.key /tmp/server.crt')


def app_host(kind):
    assert kind in ('rest', 'auth', 'storage'), 'UNKNOWN_LOCAL_APP'
    host = 'm115-'+kind
    assert len(host) <= 63 and re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', host), 'INVALID_LOCAL_DNS_ALIAS'
    return host


def tls_sessions():
    assert NAME in CREATED, 'TLS_OBSERVER_OWN_CLONE_REQUIRED'
    statement = "select coalesce(json_agg(json_build_object('pid',a.pid,'role',a.usename,'ssl',s.ssl,'protocol',s.version,'cipher',s.cipher,'bits',s.bits)),'[]')from pg_stat_ssl s join pg_stat_activity a using(pid)where a.usename in('member115_rest_login','supabase_auth_admin','supabase_storage_admin');"
    result = subprocess.run(DOCKER+['exec','-i',NAME,'psql','-XqAt','-U',BOOT,'-d','postgres','-v','ON_ERROR_STOP=1'], input=statement.encode(), capture_output=True, timeout=3)
    assert result.returncode == 0, 'TLS_OBSERVER_QUERY_FAILED'
    return json.loads(result.stdout)


def parse_tls_connections(data):
    # raw 로그/SQL/DSN은 저장하지 않는다. 동일 backend PID의 정확 role 인증과 TLS 허가만 결합한다.
    roles = ('member115_rest_login','supabase_auth_admin','supabase_storage_admin')
    authenticated = {}
    authorized = []
    for line in data.decode(errors='replace').splitlines():
        identity = re.fullmatch(r'member115 \[(\d+)\] LOG:  connection authenticated: identity="([a-z0-9_]+)" method=scram-sha-256(?: .*)?', line)
        if identity and identity[2] in roles:
            authenticated[int(identity[1])] = identity[2]
        transport = re.fullmatch(r'member115 \[(\d+)\] LOG:  connection authorized: user=([a-z0-9_]+) database=postgres(?: application_name=\S+)? SSL enabled \(protocol=(TLSv1\.[23]), cipher=([A-Za-z0-9_-]+), bits=(\d+)\)', line)
        if transport and transport[2] in roles and int(transport[5]) >= 128:
            authorized.append({'pid':int(transport[1]),'role':transport[2],'ssl':True,'protocol':transport[3],'cipher':transport[4],'bits':int(transport[5])})
    return [value for value in authorized if authenticated.get(value['pid']) == value['role']]


def tls_connections():
    assert NAME in CREATED, 'TLS_LOG_OWN_CLONE_REQUIRED'
    result = subprocess.run(DOCKER+['logs',NAME], capture_output=True, timeout=5)
    assert result.returncode == 0, 'TLS_CONNECTION_LOG_READ_FAILED'
    return parse_tls_connections(result.stdout+result.stderr)


def auth_db_readiness(service):
    readiness_id = str(uuid.uuid4())
    assert sql("select not exists(select 1 from auth.users where id='"+readiness_id+"'::uuid);") == 't', 'AUTH_READINESS_ID_MUST_BE_ABSENT_NO_GET'
    before_pids = {value['pid'] for value in tls_connections()}
    observed = {}
    stopped, ready = threading.Event(), threading.Event()
    observer_failed = []
    def observe():
        started = time.monotonic()
        try:
            while not stopped.is_set() and time.monotonic()-started < 20:
                for value in tls_sessions():
                    observed[(value['pid'],value['role'])] = value
                ready.set()
                stopped.wait(.01)
        except Exception:
            observer_failed.append(True)
            ready.set()
    observer = threading.Thread(target=observe, daemon=True)
    observer.start()
    try:
        assert ready.wait(5) and not observer_failed, 'TLS_OBSERVER_NOT_READY'
        config = 'silent\nshow-error\nmax-time = 15\nrequest = "GET"\nurl = "http://'+app_host('auth')+':9999/admin/users/'+readiness_id+'"\nheader = "Authorization: Bearer '+service+'"\nheader = "apikey: '+service+'"\n'
        code = docker('exec', '-i', NAME, 'curl', '--config', '-', '--output', '/dev/null', '--write-out', '%{http_code}', data=config.encode()).decode().strip()
    finally:
        stopped.set()
        observer.join(5)
    assert not observer.is_alive() and not observer_failed, 'TLS_OBSERVER_FAILED'
    after = tls_connections()
    fresh_auth = [value for value in after if value['role']=='supabase_auth_admin' and value['pid'] not in before_pids]
    save('auth-db-readiness-private.json', {'method':'GET','freshNonexistentUser':True,'signedService':True,'httpStatus':code,'createListDelete':0,
                                          'concurrentTlsSessions':list(observed.values()),'freshAuthenticatedTlsConnections':fresh_auth,'rawResponseArgumentsSqlLogsStored':False})
    assert code == '404', 'AUTH_DB_READINESS_GET404_REQUIRED'
    assert fresh_auth or any(value['role']=='supabase_auth_admin' and value['ssl'] is True and value['protocol'] in ('TLSv1.2','TLSv1.3') for value in observed.values()), 'AUTH_GET_ACTUAL_TLS_REQUIRED'
    return list(observed.values())


def upstream(path, method, headers, body=None):
    # 네트워크에는 외부 경로가 없다. credentials/body는 argv가 아닌 private stdin으로 전달한다.
    if path.startswith('/rest/v1/rpc/') and method == 'POST' and path.rsplit('/', 1)[1] in RPCS:
        endpoint = 'http://' + app_host('rest') + ':3000/rpc/' + path.rsplit('/', 1)[1]
    elif method == 'GET' and path == '/auth/v1/admin/users/' + FIXTURE['profileId']:
        endpoint = 'http://' + app_host('auth') + ':9999/admin/users/' + FIXTURE['profileId']
    elif method == 'GET' and path in FIXTURE['storagePaths']:
        endpoint = 'http://' + app_host('storage') + ':5000' + path.removeprefix('/storage/v1')
    else:
        COUNTS['forbidden'] += 1
        if method == 'DELETE':
            COUNTS['delete'] += 1
        return 403, b'{}'
    esc = lambda value: value.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '\\r')
    lines = ['silent', 'show-error', 'max-time = 15', 'url = "'+endpoint+'"', 'request = "'+method+'"']
    for key in ('authorization', 'apikey', 'content-type'):
        if headers.get(key):
            lines.append('header = "'+esc(key+': '+headers[key])+'"')
    if body is not None:
        lines.append('data = "'+esc(body.decode())+'"')
    result = docker('exec', '-i', NAME, 'curl', '--config', '-', '--write-out', '\n%{http_code}', data=('\n'.join(lines)+'\n').encode())
    content, code = result.rsplit(b'\n', 1)
    return int(code), content


class Gateway(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def dispatch(self):
        try:
            size = int(self.headers.get('content-length', '0'))
            assert 0 <= size <= 65536
            assert '?' not in self.path
            code, data = upstream(self.path, self.command, {k.lower():v for k,v in self.headers.items()}, self.rfile.read(size) if size else None)
        except Exception:
            code, data = 503, b'{"code":"ISOLATED_UPSTREAM_FAILED"}'
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_DELETE = do_PUT = do_PATCH = dispatch


def start_apps(helper, origin, scenario):
    passwords = {kind: secrets.token_urlsafe(36) for kind in ('auth', 'rest', 'storage')}
    secret = secrets.token_urlsafe(48)
    anon, service = helper.jwt(secret, 'anon'), helper.jwt(secret, 'service_role')
    sql("alter role supabase_auth_admin login password '"+passwords['auth']+"';alter role supabase_storage_admin login password '"+passwords['storage']+"';create role member115_rest_login login noinherit nocreatedb nocreaterole noreplication nobypassrls password '"+passwords['rest']+"';grant anon,authenticated,service_role to member115_rest_login with admin false,inherit false,set true;")
    hba = 'local all all trust\nhostssl postgres supabase_auth_admin,supabase_storage_admin,member115_rest_login 0.0.0.0/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n'
    docker('exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/member115-data/pg_hba.conf', data=hba.encode())
    sql("alter system set ssl='on';alter system set ssl_cert_file='/tmp/server.crt';alter system set ssl_key_file='/tmp/server.key';alter system set log_connections='on';alter system set log_line_prefix='member115 [%p] ';alter system set log_statement='none';alter system set log_min_error_statement='panic';select pg_reload_conf();")
    assert sql('show ssl;') == 'on', 'DB_TLS_RELOAD_REQUIRED'
    assert sql("select current_setting('log_connections')='on'and current_setting('log_line_prefix')='member115 [%p] 'and current_setting('log_statement')='none'and current_setting('log_min_error_statement')='panic';") == 't', 'CLONE_TLS_LOG_METADATA_ONLY_REQUIRED'
    uri = lambda kind, role: 'postgresql://'+role+':'+passwords[kind]+'@'+NAME+':5432/postgres?sslmode=verify-full&sslrootcert=/certs/ca.crt'
    envs = {
      'rest': {'PGRST_DB_URI':uri('rest','member115_rest_login'), 'PGRST_DB_SCHEMAS':'public', 'PGRST_DB_ANON_ROLE':'anon', 'PGRST_JWT_SECRET':secret, 'PGRST_SERVER_PORT':'3000'},
      'auth': {'GOTRUE_API_HOST':'0.0.0.0', 'GOTRUE_API_PORT':'9999', 'API_EXTERNAL_URL':origin+'/auth/v1', 'GOTRUE_DB_DRIVER':'postgres', 'GOTRUE_DB_DATABASE_URL':uri('auth','supabase_auth_admin'), 'GOTRUE_SITE_URL':origin, 'GOTRUE_JWT_SECRET':secret, 'GOTRUE_JWT_AUD':'authenticated', 'GOTRUE_JWT_ADMIN_ROLES':'service_role', 'GOTRUE_JWT_DEFAULT_GROUP_NAME':'authenticated', 'GOTRUE_JWT_EXP':'3600', 'GOTRUE_DISABLE_SIGNUP':'true', 'GOTRUE_EXTERNAL_EMAIL_ENABLED':'false', 'GOTRUE_EXTERNAL_PHONE_ENABLED':'false', 'GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED':'false', 'GOTRUE_LOG_LEVEL':'error'},
      'storage': {'ANON_KEY':anon, 'SERVICE_KEY':service, 'PGRST_JWT_SECRET':secret, 'AUTH_JWT_SECRET':secret, 'POSTGREST_URL':'http://'+app_host('rest')+':3000', 'DATABASE_URL':uri('storage','supabase_storage_admin'), 'STORAGE_BACKEND':'file', 'FILE_STORAGE_BACKEND_PATH':'/mnt', 'TENANT_ID':'stub', 'REGION':'stub', 'GLOBAL_S3_BUCKET':'stub', 'FILE_SIZE_LIMIT':'52428800', 'ENABLE_IMAGE_TRANSFORMATION':'false', 'NODE_OPTIONS':'--max-old-space-size=128'}
    }
    # 각 시나리오에는 필요한 외부 GET 서버만 기동한다. 준비 확인은 GET-only이다.
    kinds = ['rest'] + (['auth'] if scenario == 'auth' else ['storage'] if scenario in ('storage', 'finish_loss', 'finalize_loss') else [])
    for kind in kinds:
        save(kind+'-private.env', '\n'.join(key+'='+value for key,value in envs[kind].items())+'\n')
        options = ['--mount', 'type=bind,src='+str(ROOT/'ca.crt')+',dst=/certs/ca.crt,readonly']
        if kind == 'storage':
            volume = NAME+'-files'
            assert volume not in docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines(), 'EXISTING_VOLUME_PRESERVED'
            docker('volume', 'create', '--label', 'yumidang.owner=minkyu', volume)
            options += ['--mount', 'type=volume,src='+volume+',dst=/mnt']
        docker('run', '-d', '--name', NAME+'-'+kind, '--network', NETWORK, '--network-alias', app_host(kind), '--pull=never', '--no-healthcheck', '--memory', '512m' if kind=='storage' else '128m', '--user', '0:0', '--label', 'yumidang.owner=minkyu', '--env-file', str(ROOT/(kind+'-private.env')), *options, IMAGES[kind])
        record(NAME+'-'+kind)
        port, path = ('3000','/') if kind == 'rest' else ('9999','/health') if kind == 'auth' else ('5000','/status')
        wait(['exec', NAME, 'curl', '--fail', '--silent', '--max-time', '2', '--output', '/dev/null', '--write-out', '%{http_code}', 'http://'+app_host(kind)+':'+port+path], kind.upper(), attempts=120)
    observed = auth_db_readiness(service) if scenario == 'auth' else []
    expected = ['member115_rest_login'] + (['supabase_auth_admin'] if scenario == 'auth' else ['supabase_storage_admin'] if 'storage' in kinds else [])
    sessions = tls_sessions()+observed
    connections = tls_connections()
    valid = lambda value: value['ssl'] is True and value['protocol'] in ('TLSv1.2','TLSv1.3') and value['cipher'] and value['bits'] >= 128
    proven = {value['role'] for value in sessions+connections if valid(value)}
    assert not any(value['ssl'] is not True for value in sessions), 'PLAINTEXT_APP_SESSION_FORBIDDEN'
    save('startup-tls-proof-private.json', {'expectedRoles':expected,'allExpectedRolesActualTls':set(expected).issubset(proven),
                                          'sessions':sessions,'authenticatedTlsConnections':connections,'rawLogsSqlArgumentsStored':False})
    assert set(expected).issubset(proven), 'ACTUAL_DB_TLS_EVIDENCE_REQUIRED_FOR_EACH_ROLE'
    return anon, service


def existing_queue_rows():
    # 합성 task/invocation/global과 무관한 기존 행은 원 lease/ACK/UNKNOWN까지 그대로 보존한다.
    task, request = (FIXTURE[key] for key in ('taskId', 'invocationRequestId'))
    predicates = {
        'member_cleanup_tasks': "id<>'"+task+"'::uuid",
        'member_cleanup_dispatches': "task_id<>'"+task+"'::uuid",
        'member_cleanup_delete_acks': "task_id<>'"+task+"'::uuid",
        'worker_jobs': "id<>'"+task+"'::uuid",
        'worker_job_run_fences': "job_id<>'"+task+"'::uuid",
        'worker_runtime_job_slots': "job_id<>'"+task+"'::uuid",
        'worker_invocations': "request_id<>'"+request+"'::uuid",
        'worker_invocation_jobs': "request_id<>'"+request+"'::uuid",
        'worker_runtime_results': 'true',
        'worker_runtime_intents': 'true',
    }
    expressions = []
    for table, predicate in predicates.items():
        expressions += ["'"+table+"'", "(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)::text,'sha256'),'hex')from private."+table+" t where "+predicate+")"]
    return json.loads(sql('select jsonb_build_object('+','.join(expressions)+');'))


def fixture_ids(scenario):
    ids = {key: str(uuid.uuid4()) for key in ('profileId', 'withdrawalId', 'taskId', 'objectId', 'invocationRequestId', 'recoveryRequestId', 'originalGlobalToken', 'recoveryGlobalToken')}
    # 실제 generic claim은 ID순이다. 새 clone에서 충돌·순서를 확인하고 원 task 선택을 막는다.
    ids['taskId'] = '00000000-0000-4000-8000-000000000001'
    assert sql("select not exists(select 1 from private.member_cleanup_tasks where id<='"+ids['taskId']+"'::uuid)and not exists(select 1 from private.worker_jobs where id='"+ids['taskId']+"'::uuid);") == 't', 'SYNTHETIC_TASK_CANNOT_PRECEDE_EXISTING_NO_MUTATION'
    name = ids['profileId']+'/synthetic-member115.png' if scenario != 'auth' else None
    ids['objectName'] = name
    ids['storagePaths'] = [] if name is None else [prefix+'/'.join(quote(part, safe='') for part in name.split('/')) for prefix in ('/storage/v1/object/info/authenticated/profile-images/', '/storage/v1/object/authenticated/profile-images/')]
    FIXTURE.update(ids)
    return ids


def seed(scenario, ids):
    kind = 'auth_user' if scenario == 'auth' else 'storage_object'
    name = ids['objectName']
    profile, withdrawal, task = ids['profileId'], ids['withdrawalId'], ids['taskId']
    nullable = 'null' if name is None else "'"+name+"'"
    bucket = 'null' if name is None else "'profile-images'"
    obj = 'null' if name is None else "'"+ids['objectId']+"'::uuid"
    ack = '' if scenario == 'no_ack' else "perform public.record_member_cleanup_delete_ack((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,'"+ids['originalGlobalToken']+"',"+obj+",repeat('a',64));"
    statement = "begin;select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);select set_config('request.jwt.claim.role','service_role',true);"
    statement += "insert into auth.users(id,email)values('"+profile+"','"+profile+"@member115.invalid');insert into public.profiles(id,real_name,birth_date,gender)values('"+profile+"','합성회원','1990-01-01','female');insert into private.member_retirements(profile_id,withdrawal_id,episode_id)values('"+profile+"','"+withdrawal+"',private.active_member_episode('"+profile+"'));"
    statement += "insert into storage.buckets(id,name,public)values('profile-images','profile-images',false)on conflict do nothing;insert into private.member_cleanup_tasks(id,withdrawal_id,kind,profile_id,bucket_id,object_name,object_id)values('"+task+"','"+withdrawal+"','"+kind+"','"+profile+"',"+bucket+","+nullable+","+obj+");"
    statement += "update private.worker_invocation_control set enabled=true where singleton;update private.worker_runtime_atomic_control set enabled=true where singleton;update private.member_cleanup_guard set external_deletion_approved=true where singleton;update private.global_worker_run set token='"+ids['originalGlobalToken']+"',expires_at=clock_timestamp()+interval'180 seconds'where singleton;"
    # 기존 external_pending/UNKNOWN 때문에 신규 prepare는 닫혀 있다. 준비 행만 합성하며 CAS/claim은 실제 RPC다.
    statement += "do $$declare t jsonb;begin insert into private.worker_invocations(request_id,global_token,kind,item_limit,fingerprint,remaining_ms,deadline)select '"+ids['invocationRequestId']+"','"+ids['originalGlobalToken']+"','member_cleanup',1,encode(extensions.digest(jsonb_build_array('"+ids['originalGlobalToken']+"'::uuid,'member_cleanup',1,60000)::text,'sha256'),'hex'),60000,least(expires_at,clock_timestamp()+interval'60 seconds')from private.global_worker_run where singleton;t:=public.claim_queue_invocation_dispatch('"+ids['invocationRequestId']+"','"+ids['originalGlobalToken']+"','member_cleanup',1,60000);assert t->>'claimed'='true';t:=public.claim_member_cleanup_task('"+ids['originalGlobalToken']+"');assert t->>'taskId'='"+task+"';assert(select count(*)=1 and bool_and(job_id='"+task+"'::uuid and job_lease_token=(t->>'leaseToken')::uuid and claim_seq=1)from private.worker_invocation_jobs where request_id='"+ids['invocationRequestId']+"');assert(select claim_calls=1 from private.worker_invocations where request_id='"+ids['invocationRequestId']+"');perform public.begin_member_cleanup_delete((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,'"+ids['originalGlobalToken']+"',"+obj+");"+ack+"perform public.mark_queue_invocation_unknown('"+ids['invocationRequestId']+"');end;$$;"
    statement += "update private.member_cleanup_tasks set lease_expires_at=clock_timestamp()-interval'1 second'where id='"+task+"';update private.worker_jobs set lease_expires_at=clock_timestamp()-interval'1 second'where id='"+task+"';"
    if kind == 'auth_user':
        statement += "delete from auth.users where id='"+profile+"';"
    statement += 'commit;'
    sql(statement)
    return ids


def origin_proof():
    return json.loads(sql("select jsonb_build_object('dispatch',(select to_jsonb(d)from private.member_cleanup_dispatches d where task_id='"+FIXTURE['taskId']+"'),'ack',(select to_jsonb(a)from private.member_cleanup_delete_acks a where task_id='"+FIXTURE['taskId']+"'),'invocation',(select jsonb_build_array(request_id,global_token,kind,item_limit,remaining_ms,fingerprint,deadline,claim_calls,dispatch_started,idle_seen)from private.worker_invocations where request_id='"+FIXTURE['invocationRequestId']+"'),'audit',(select jsonb_build_array(job_id,job_lease_token,claim_seq,effect)from private.worker_invocation_jobs where request_id='"+FIXTURE['invocationRequestId']+"'));"))


def run_http_phase(fixture, phase):
    save('input-'+phase+'-private.json', {**fixture, 'phase':phase})
    output = call(['deno', 'run', '--no-prompt', '--allow-read='+str(ROOT), '--allow-write='+str(ROOT), '--allow-net=127.0.0.1', str(REPO/'tests/integration/minkyu/member_cleanup_reconcile_http_local.ts'), str(ROOT/('input-'+phase+'-private.json'))], timeout=120)
    save(phase+'-launcher-output-private.log', output)
    value = json.loads((ROOT/(phase+'-http-observations.json')).read_text())
    assert value['status'] == 'PASS' and value['frozenGraphSha256'] == fixture['frozenGraphSha256'] and value['phase'] == phase
    assert value['scope'] == 'RUNTIME_FACTORY_HTTPS_SQL115_BRIDGE' and all(value.get(key) is True for key in ('actualRuntimeFactoryRouting', 'defaultFactory404', 'approvalFalseCreationRejected', 'internalAuthenticationBeforeRpc')), 'ACTUAL_FACTORY_PROOF_REQUIRED'
    assert value['bridgeDeleteDispatchAckCount'] == 0 and value['forbiddenCalls'] == 0 and value['externalRequests'] == 0
    return value


def finalization_immutable():
    # 부모 state/result/closed_at 이외 행·lease·슬롯·역할·catalog는 부모 종결의 수정 대상이 아니다.
    return json.loads(sql("select jsonb_build_object('task',(select to_jsonb(t)from private.member_cleanup_tasks t where id='"+FIXTURE['taskId']+"'),'job',(select to_jsonb(j)from private.worker_jobs j where id='"+FIXTURE['taskId']+"'),'recovery',(select to_jsonb(r)from private.member_cleanup_reconciliations r where recovery_request_id='"+FIXTURE['recoveryRequestId']+"'),'slots',(select coalesce(jsonb_agg(to_jsonb(s)order by global_token,job_id),'[]'::jsonb)from private.worker_runtime_job_slots s),'global',(select to_jsonb(g)from private.global_worker_run g where singleton));"))


def run(args):
    global ROOT, NAME, NETWORK
    graph_path = args.graph_manifest.resolve()
    graph, graph_sha = frozen_graph(graph_path)
    NAME = 'yumidang-minkyu-member115-http-20261009-'+args.scenario+'-'+args.revision
    assert len(NAME) <= 63, 'DB_DNS_LABEL_TOO_LONG_NO_START'
    ROOT = Path('/private/tmp/yumidang-member115-http-20261009-'+args.scenario+'-'+args.revision)
    NETWORK = NAME+'-network'
    assert not ROOT.exists(), 'EXISTING_UNKNOWN_ARTIFACTS_PRESERVED_NO_RESUME'
    ROOT.mkdir(mode=0o700)
    helper = snapshot_helpers()
    before = None
    gateway = None
    gateway_started = False
    existing_rows = None
    passed = False
    receipt = None
    try:
        existing = docker('ps', '-a', '--format', '{{.Names}}').decode().splitlines()
        assert not set([NAME, NAME+'-auth', NAME+'-rest', NAME+'-storage']).intersection(existing), 'EXISTING_TARGETS_PRESERVED'
        assert NETWORK not in docker('network', 'ls', '--format', '{{.Name}}').decode().splitlines(), 'EXISTING_NETWORK_PRESERVED'
        source = inspect(SOURCE)
        assert source['State']['Running'] and (source['Config'].get('Labels') or {}).get('yumidang.owner') == 'minkyu'
        assert not source['Mounts'] and not source['HostConfig'].get('PortBindings')
        memory_before_backup = memory_preflight(args.scenario, 'before-backup')
        helper.closed(SOURCE)
        assert sql('show listen_addresses;', SOURCE) == ''
        assert sql("select to_regclass('private.event_invocation_references')is not null and to_regclass('private.member_cleanup_reconciliations')is null and to_regclass('private.worker_runtime_intent_confirmations')is null;", SOURCE) == 't'
        before = helper.snapshot(SOURCE)
        save('source-before-private.json', before)
        dump = docker('exec', SOURCE, 'pg_dump', '-U', BOOT, '-d', 'postgres', '-Fc')
        roles = docker('exec', SOURCE, 'pg_dumpall', '-U', BOOT, '--roles-only', '--no-role-passwords')
        assert not re.search(rb"\bPASSWORD\s+'", roles, re.I)
        save('source.dump', dump)
        save('source-roles.sql', roles)
        assert helper.snapshot(SOURCE) == before, 'SOURCE_CHANGED_DURING_BACKUP'
        for image in IMAGES.values():
            docker('image', 'inspect', image)
        subnet = plan_internal_network()
        memory_before_start = memory_preflight(args.scenario, 'before-start')
        docker('network', 'create', '--internal', '--subnet', str(subnet), '--gateway', str(subnet.network_address+1), '--label', 'yumidang.owner=minkyu', NETWORK)
        network = json.loads(docker('network', 'inspect', NETWORK))[0]
        assert network['Internal'] is True and (network.get('Labels') or {}).get('yumidang.owner') == 'minkyu'
        assert network['IPAM']['Config'] == [{'Subnet':str(subnet), 'Gateway':str(subnet.network_address+1)}], 'EXPLICIT_NETWORK_ALLOCATION_MISMATCH'
        docker('run', '-d', '--name', NAME, '--network', NETWORK, '--pull=never', '--no-healthcheck', '--memory', '512m', '--label', 'yumidang.owner=minkyu', '--user', 'postgres', '--entrypoint', 'sh', IMAGES['db'], '-c', 'initdb -U '+BOOT+" -D /tmp/member115-data --auth-local=trust --auth-host=reject && exec postgres -D /tmp/member115-data -c listen_addresses='*' -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off -c shared_buffers=16MB -c max_connections=40")
        record(NAME)
        wait(['exec', NAME, 'pg_isready', '-U', BOOT], 'DB')
        # 같은 bootstrap 이름을 사용하므로 GRANTED BY를 제거하지 않고 grantor를 정확히 보존한다.
        role_sql = '\n'.join(line for line in roles.decode().splitlines() if not re.match(r'(CREATE|ALTER) ROLE '+BOOT+r'(?: |;)', line))
        sql(role_sql)
        docker('exec', '-i', NAME, 'pg_restore', '-U', BOOT, '-d', 'postgres', '--single-transaction', '--exit-on-error', data=dump)
        reparsed = helper.prove_clone(before, helper.snapshot(NAME))
        helper.closed(NAME)
        for path in (SQL114, SQL115):
            sql((REPO/path).read_text())
        post_migration = helper.snapshot(NAME)
        assert all(post_migration['rows'].get(key) == digest for key,digest in before['rows'].items()), 'MIGRATION_CHANGED_EXISTING_ROWS'
        for signature in SIGNATURES:
            assert sql("select not has_function_privilege('service_role','public."+signature+"','EXECUTE');") == 't', 'NEW_EXEC_NOT_DEFAULT_CLOSED'
        helper.closed(NAME)
        certificates()
        gateway = ThreadingHTTPServer(('127.0.0.1', 0), Gateway)
        origin = 'http://127.0.0.1:'+str(gateway.server_port)
        anon, service = start_apps(helper, origin, args.scenario)
        threading.Thread(target=gateway.serve_forever, daemon=True).start()
        gateway_started = True
        ids = fixture_ids(args.scenario)
        existing_rows = existing_queue_rows()
        save('existing-queue-before-private.json', existing_rows)
        seed(args.scenario, ids)
        assert existing_queue_rows() == existing_rows, 'SEED_CHANGED_EXISTING_QUEUE_ROWS'
        original = origin_proof()
        save('synthetic-origin-private.json', original)
        sql("update private.global_worker_run set token='"+ids['recoveryGlobalToken']+"',expires_at=clock_timestamp()+interval'180 seconds'where singleton;"+';'.join('grant execute on function public.'+signature+' to service_role' for signature in SIGNATURES)+';')
        assert frozen_graph(graph_path)[1] == graph_sha, 'APPROVED_GRAPH_CHANGED'
        fixture = {'root':str(ROOT), 'upstream':origin, 'scenario':args.scenario, 'anon':anon, 'service':service, 'workerSecret':secrets.token_urlsafe(36), 'binding':{key:ids[key] for key in ('recoveryRequestId','invocationRequestId','taskId','recoveryGlobalToken')}, 'profileId':ids['profileId'], 'objectName':ids['objectName'], 'originalGlobalToken':ids['originalGlobalToken'], 'frozenGraphSha256':graph_sha, 'originEvidence':'SYNTHETIC_SQL_NO_ACK' if args.scenario=='no_ack' else 'SYNTHETIC_SQL_ACK_NO_EXTERNAL_DELETE'}
        bridge = run_http_phase(fixture, 'bridge')
        assert bridge['actualGlobalBudgetRead'] is True and bridge['originalUnknownPreserved'] is True
        assert origin_proof() == original, 'ORIGINAL_DISPATCH_ACK_TOKEN_DEADLINE_AUDIT_CHANGED'
        assert existing_queue_rows() == existing_rows, 'BRIDGE_CHANGED_EXISTING_QUEUE_ROWS'
        applied = args.scenario not in ('begin_loss','no_ack')
        assert sql("select state from private.worker_invocations where request_id='"+ids['invocationRequestId']+"';") == 'unknown', 'BRIDGE_MUST_NOT_FINALIZE_PARENT'
        recovery = json.loads(sql("begin;set local request.jwt.claims='{\"role\":\"service_role\"}';set local request.jwt.claim.role='service_role';select public.get_member_cleanup_reconcile('"+ids['recoveryRequestId']+"');commit;")) if args.scenario != 'no_ack' else None
        if recovery:
            assert recovery['state'] == ('completed' if applied else 'prepared')
            assert recovery['recovery']['globalToken'] == ids['recoveryGlobalToken']
            assert recovery['original']['globalToken'] == ids['originalGlobalToken']
            assert recovery['recovery']['leaseToken'] != recovery['original']['jobLeaseToken']
            assert recovery['evidenceSha256'] == bridge['storedEvidenceSha256']
            assert sql("select count(*)from private.worker_runtime_job_slots where global_token='"+ids['recoveryGlobalToken']+"'and job_id='"+ids['taskId']+"';") == '1'
            assert sql("select state from private.member_cleanup_tasks where id='"+ids['taskId']+"';") == ('completed' if applied else 'running')
            assert sql("select status from private.worker_jobs where id='"+ids['taskId']+"';") == ('succeeded' if applied else 'running')
        else:
            assert sql("select count(*)from private.member_cleanup_reconciliations where recovery_request_id='"+ids['recoveryRequestId']+"';") == '0'
        save('bridge-db-proof-private.json', {'recovery':recovery, 'origin':original, 'parentState':'unknown'})
        # clone-only fixture로 global 만료만 재현한다. 원 recovery receipt/lease/token/slot은 보존한다.
        sql("update private.global_worker_run set expires_at=clock_timestamp()-interval'1 second'where singleton and token='"+ids['recoveryGlobalToken']+"';")
        assert sql("select token='"+ids['recoveryGlobalToken']+"'::uuid and expires_at<clock_timestamp()from private.global_worker_run where singleton;") == 't', 'RECOVERY_GLOBAL_EXPIRY_NOT_PROVEN'
        immutable = finalization_immutable()
        finalized_before = helper.snapshot(NAME)
        save('before-finalize-private.json', finalized_before)
        assert frozen_graph(graph_path)[1] == graph_sha, 'APPROVED_GRAPH_CHANGED'
        finalized = run_http_phase(fixture, 'finalize')
        assert finalized['finalizationGlobalHeader'] is False and finalized['finalizationBudgetReads'] == 0
        assert finalized['actualStorageGets'] == 0 and finalized['actualAuthGets'] == 0
        assert finalized['outerCompleted'] is applied and finalized['originalUnknownPreserved'] is not applied
        assert origin_proof() == original, 'FINALIZE_CHANGED_ORIGINAL_SCOPE'
        assert finalization_immutable() == immutable, 'FINALIZE_CHANGED_TASK_JOB_RECOVERY_LEASE_SLOT_OR_GLOBAL'
        state = sql("select state from private.worker_invocations where request_id='"+ids['invocationRequestId']+"';")
        assert state == ('completed' if applied else 'unknown'), 'PARENT_STATE_NOT_PROVEN'
        finalized_after = helper.snapshot(NAME)
        save('after-finalize-private.json', finalized_after)
        for section in finalized_before:
            if section != 'rows':
                assert finalized_after[section] == finalized_before[section], 'FINALIZE_CHANGED_CATALOG_ROLES_ACL'
        assert set(finalized_after['rows']) == set(finalized_before['rows']), 'FINALIZE_CHANGED_RELATIONS'
        changed = {key for key in finalized_before['rows'] if finalized_after['rows'][key] != finalized_before['rows'][key]}
        assert changed == ({'private.worker_invocations'} if applied else set()), 'FINALIZE_CHANGED_OTHER_ROWS_OR_FALSE_COMPLETION'
        save('finalize-db-proof-private.json', {'parentState':state, 'expiredGlobalUnchanged':True, 'onlyParentStoredCompletionChanged':applied, 'changedTables':sorted(changed)})
        assert existing_queue_rows() == existing_rows, 'FINALIZE_CHANGED_EXISTING_QUEUE_ROWS'
        save('existing-queue-after-private.json', existing_queue_rows())
        assert COUNTS == {'forbidden':0, 'delete':0}
        assert helper.snapshot(SOURCE) == before, 'READONLY_SOURCE_CHANGED'
        assert frozen_graph(graph_path)[1] == graph_sha, 'APPROVED_GRAPH_CHANGED'
        for name in CREATED:
            assert not inspect(name)['State']['OOMKilled'], 'LOCAL_MEMORY_FAILURE'
        assert len(CREATED) == MEMORY_POLICIES[args.scenario]['newContainers'], 'UNNECESSARY_CONTAINER_START'
        receipt = {**bridge, 'phase':'combined', 'outerCompleted':applied, 'originalUnknownPreserved':not applied, 'finalizeHttpObservations':finalized, 'finalizationAfterExpiredRecoveryGlobalBudgetAndNewRun0':True, 'parentCompletionOrPendingThroughActualFactoryHttp':True, 'fullSourceRowsCatalogRolesAclUnchanged':True, 'restoredFullSourceRowsCatalogRolesAcl':True, 'membershipGrantorsExact':True, 'knownEquivalentReparsedChecks':reparsed, 'sourceTableCount':len(before['rows']), 'sourceDumpSha256':hashlib.sha256(dump).hexdigest(), 'actualDbTlsVerified':True, 'driverSha256':sha(Path(__file__)), 'source':SOURCE, 'clone':NAME, 'memoryBeforeBackupKiB':memory_before_backup, 'memoryBeforeStartKiB':memory_before_start, 'scenarioMemoryPolicy':MEMORY_POLICIES[args.scenario], 'existingQueueRowsLeasesAcksUnknownPreserved':True, 'newFixtureExactActualClaimAudit':True, 'originalInvocationPrepare':'NOT_RUN_SYNTHETIC_PREPARED_ROW', 'imageHealthchecksDisabled':True, 'explicitNonOverlappingSubnet':str(subnet), 'networkPrune':False}
        passed = True
    finally:
        if gateway:
            if gateway_started:
                gateway.shutdown()
            gateway.server_close()
        if NAME in CREATED:
            # UNKNOWN·dispatch·ACK·lease와 파일을 지우지 않는다. guard/EXEC만 닫는다.
            try:
                sql('update private.worker_invocation_control set enabled=false where singleton;update private.worker_runtime_atomic_control set enabled=false where singleton;update private.member_cleanup_guard set external_deletion_approved=false where singleton;update private.global_worker_run set token=null,expires_at=null where singleton;'+';'.join('revoke all on function public.'+signature+' from service_role' for signature in SIGNATURES)+';')
                helper.closed(NAME)
                if existing_rows is not None:
                    preserved = existing_queue_rows() == existing_rows
                    save('existing-queue-final-private.json', {'preserved':preserved})
                    if not preserved:
                        passed = False
                save('clone-closed-private.json', helper.snapshot(NAME))
            except Exception:
                save('close-failure-status.json', {'closed':False, 'unknownPreserved':True})
                passed = False
        if before is not None:
            after = helper.snapshot(SOURCE)
            save('source-after-private.json', after)
            assert after == before, 'SOURCE_CHANGED_FINAL'
        for name, identifier in reversed(list(CREATED.items())):
            assert inspect(name)['Id'] == identifier, 'CREATED_TARGET_ID_CHANGED'
            docker('stop', identifier)
        save('finalization.json', {'passed':passed, 'createdContainersStopped':True, 'unknownAndVolumesPreserved':True, 'sourceUnchanged':before is not None})
    assert passed, 'FINALIZATION_FAILED_PRIVATE_EVIDENCE_PRESERVED'
    save('receipt.json', {**receipt, 'cloneGuardAndExecClosed':True, 'createdContainersStopped':True})
    print(json.dumps({'status':'PASS', 'scope':'RUNTIME_FACTORY_HTTPS_SQL115_BRIDGE', 'scenario':args.scenario, 'sourceUnchanged':True, 'bridgeDeleteDispatchAck':0, 'originalPhysicalDeleteAndAck':'NOT_RUN_SYNTHETIC_SQL_ORIGIN', 'originalInvocationPrepare':'NOT_RUN_SYNTHETIC_PREPARED_ROW'}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--graph-manifest', type=Path)
    parser.add_argument('--scenario', choices=['storage','auth','begin_loss','finish_loss','finalize_loss','no_ack'], default='storage')
    parser.add_argument('--revision', default='v1')
    args = parser.parse_args()
    assert re.fullmatch(r'v[1-9][0-9]*', args.revision), 'EXPLICIT_NEW_REVISION_REQUIRED'
    if not args.run:
        print(json.dumps({'status':'NOT_RUN', 'scope':'RUNTIME_FACTORY_HTTPS_SQL115_BRIDGE', 'requiredRootApprovedFrozenPaths':REQUIRED, 'allRelativeFactoryImportsRequired':True, 'scenarioMemoryPolicies':MEMORY_POLICIES, 'memoryProbe':'SOURCE_READONLY_/proc/meminfo_BEFORE_BACKUP_AND_START', 'frozenHttpSha256':HTTP_SHAS, 'source':SOURCE, 'actualStart':'ROOT_FREEZE_QUEUE_ACK_AND_MEMORY_READY_REQUIRED', 'origin':'SYNTHETIC_SQL_ACK_NO_EXTERNAL_DELETE', 'originalInvocationPrepare':'NOT_RUN_SYNTHETIC_PREPARED_ROW', 'externalDeleteAck':0, 'sourceStorageFileRestore':'NOT_RUN', 'actualRuntimeFactory':'PREPARED_NOT_RUN', 'deployedProductHTTPAndCLI':'NOT_RUN'}, ensure_ascii=False))
        return
    assert args.graph_manifest is not None, 'ROOT_APPROVED_GRAPH_REQUIRED'
    run(args)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        if ROOT is not None and ROOT.is_dir():
            save('failure-frames-private.json', {'errorType':type(error).__name__, 'frames':[{'file':Path(frame.filename).name, 'line':frame.lineno, 'function':frame.name}for frame in traceback.extract_tb(error.__traceback__)]})
        print(json.dumps({'status':'FAIL', 'errorType':type(error).__name__, 'privateEvidencePreserved':True, 'automaticRetry':False}))
        raise SystemExit(1) from None
