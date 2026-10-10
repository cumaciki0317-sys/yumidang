"""SQL109 disposable HTTPS/CLI harness. Source dump is read-only; no automatic retry.

Run --prepare once, then --run. Append --revision-v2/v3/v4 to both
commands to select a fresh recipe; older artifacts are never resumed or replaced.
--close is idempotent and only closes the recorded
fresh clone. Containers/private evidence are retained for inspection, never removed.
"""
import base64
import hashlib
import hmac
import json
import ipaddress
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import uuid

REVISION_V2 = sys.argv[1:] in ([action, '--revision-v2'] for action in
                             ('--prepare', '--fixture', '--snapshot', '--unknown', '--close', '--run'))
REVISION_V3 = sys.argv[1:] in ([action, '--revision-v3'] for action in
                             ('--prepare', '--fixture', '--snapshot', '--unknown', '--close', '--run'))
REVISION_V4 = sys.argv[1:] in ([action, '--revision-v4'] for action in
                             ('--prepare', '--fixture', '--snapshot', '--unknown', '--close', '--run'))
REVISION_V5 = sys.argv[1:] in ([action, '--revision-v5'] for action in
                             ('--prepare', '--fixture', '--snapshot', '--unknown', '--close', '--run'))
RECONNECT_ACTIONS = ('--prepare', '--fixture', '--snapshot', '--unknown', '--close', '--run', '--disconnect-due', '--disconnect-unknown', '--reconnect-proof')
RECONNECT_V12 = sys.argv[1:] in ([action, '--revision-v12', '--scenario-reconnect'] for action in RECONNECT_ACTIONS)
RECONNECT_V11 = RECONNECT_V12 or sys.argv[1:] in ([action, '--revision-v11', '--scenario-reconnect'] for action in RECONNECT_ACTIONS)
RECONNECT_V10 = RECONNECT_V11 or sys.argv[1:] in ([action, '--revision-v10', '--scenario-reconnect'] for action in RECONNECT_ACTIONS)
RECONNECT_V9 = RECONNECT_V10 or sys.argv[1:] in ([action, '--revision-v9', '--scenario-reconnect'] for action in RECONNECT_ACTIONS)
RECONNECT_V8 = RECONNECT_V9 or sys.argv[1:] in ([action, '--revision-v8', '--scenario-reconnect'] for action in RECONNECT_ACTIONS)
RECONNECT = RECONNECT_V8 or sys.argv[1:] in ([action, '--revision-v7', '--scenario-reconnect'] for action in RECONNECT_ACTIONS)
REVISION = 'v12' if RECONNECT_V12 else 'v11' if RECONNECT_V11 else 'v10' if RECONNECT_V10 else 'v9' if RECONNECT_V9 else 'v8' if RECONNECT_V8 else 'v7' if RECONNECT else 'v5' if REVISION_V5 else 'v4' if REVISION_V4 else 'v3' if REVISION_V3 else 'v2' if REVISION_V2 else 'v1'
ROOT = Path('/private/tmp/yumidang-invocation109-http-' + REVISION)
NAME = 'yumidang-minkyu-invocation109-http-' + REVISION
if RECONNECT:
    ROOT = Path('/private/tmp/yumidang-invocation109-reconnect-' + REVISION)
    NAME = 'yumidang-minkyu-invocation109-reconnect-' + REVISION
SOURCE = 'yumidang-minkyu-invocation109-20261009-v1'
BOOT = 'yumidang_production_recovery_bootstrap'
LOGIN = 'yumidang_invocation_http_queue_login'
REST_LOGIN = 'yumidang_invocation_http_rest_login'
REST = NAME + '-rest'
NETWORK = NAME + '-network'
DOCKER = ['docker', '--host', 'unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock']
REPO = Path(__file__).resolve().parents[3]
TLS = Path('/private/tmp/yumidang-queue-tls99')
SIGNATURES = (
    'prepare_queue_invocation(uuid,uuid,text,integer,integer)',
    'claim_queue_invocation_dispatch(uuid,uuid,text,integer,integer)',
    'get_queue_invocation(uuid)', 'complete_queue_invocation(uuid)',
    'mark_queue_invocation_unknown(uuid)', 'read_worker_runtime_pending_v2()',
    'read_worker_runtime_slots(uuid)', 'read_worker_run_budget(uuid)',
    'read_worker_runtime_maintenance_schedule(uuid)',
    'read_ai_feedback_maintenance_schedule(uuid)',
    'purge_ai_feedback_scoped(uuid,uuid,integer)', 'get_worker_runtime_operation(uuid)',
    'execute_worker_runtime_operation(uuid,uuid,text,jsonb)',
    'purge_worker_runtime_details_scoped(uuid,uuid,integer)',
)


def save(name, data):
    if isinstance(data, str):
        data = data.encode()
    with os.fdopen(os.open(ROOT / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as out:
        out.write(data)


def call(args, data=None, timeout=120):
    p = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if p.returncode:
        # Raw failure output can include credentials; it is never printed.
        save('failure-' + str(uuid.uuid4()) + '.log', p.stdout + p.stderr)
        raise RuntimeError('INVOCATION_HTTP_FAILED_PRIVATE_EVIDENCE_PRESERVED')
    return p.stdout


def docker(*args, data=None):
    return call(DOCKER + list(args), data)


def sql(query, name=NAME):
    assert name in (NAME, SOURCE), 'UNOWNED_DATABASE_TARGET'
    return docker('exec', '-i', name, 'psql', '-XqAt', '-U', BOOT, '-d', 'postgres',
                  '-v', 'ON_ERROR_STOP=1', data=query.encode())


def identity(name):
    info = json.loads(docker('inspect', name))[0]
    assert (info['Config'].get('Labels') or {}).get('yumidang.owner') == 'minkyu', 'OWNER_MISMATCH'
    assert info['State']['Running'], 'DATABASE_NOT_RUNNING'
    return info


def fingerprint(name):
    tables = json.loads(sql("select coalesce(json_agg(json_build_array(n.nspname,c.relname)order by n.nspname,c.relname),'[]')from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in('r','p','m')and left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema';", name))
    queries = []
    for schema, table in tables:
        relation = '"' + schema.replace('"', '""') + '"."' + table.replace('"', '""') + '"'
        key = (schema + '.' + table).replace("'", "''")
        queries.append("select '" + key + "'as key,count(*)||':'||md5(coalesce(string_agg(to_jsonb(x)::text,','order by to_jsonb(x)::text),''))as value from " + relation + ' x')
    rows = json.loads(sql("select json_object_agg(key,value)from(" + ' union all '.join(queries) + ')v;', name))
    functions = sql("select md5(coalesce(string_agg(n.nspname||'.'||p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid)||':'||coalesce(p.proacl::text,'NULL'),'|'order by n.nspname,p.oid::regprocedure::text),''))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private')and p.prokind='f';", name).decode().strip()
    result = {'rows': rows, 'functions': functions}
    if RECONNECT:
        if RECONNECT_V8:
            catalog = reconnect_catalog(name)
            result['rolesAclCatalogSha256'] = hashlib.sha256(json.dumps(catalog, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        else:
            result['rolesAclCatalogSha256'] = hashlib.sha256(sql("select jsonb_build_object('roles',(select jsonb_agg(to_jsonb(r)-'oid'order by rolname)from pg_roles r),'memberships',(select jsonb_agg(jsonb_build_object('role',pg_get_userbyid(roleid),'member',pg_get_userbyid(member),'grantor',pg_get_userbyid(grantor),'admin',admin_option,'inherit',inherit_option,'set',set_option)order by pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor))from pg_auth_members m),'catalog',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'schemaAcl',n.nspacl,'name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'indexDefinition',case when c.relkind in('i','I')then pg_get_indexdef(c.oid)end,'viewDefinition',case when c.relkind in('v','m')then pg_get_viewdef(c.oid)end,'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'acl',a.attacl,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'dropped',a.attisdropped,'default',(select pg_get_expr(d.adbin,d.adrelid)from pg_attrdef d where d.adrelid=a.attrelid and d.adnum=a.attnum))order by a.attnum)from pg_attribute a where a.attrelid=c.oid and a.attnum>0),'constraints',(select jsonb_agg(pg_get_constraintdef(k.oid)order by k.conname)from pg_constraint k where k.conrelid=c.oid),'policies',(select jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'cmd',p.polcmd,'roles',(select jsonb_agg(case when role_oid=0 then 'PUBLIC'else pg_get_userbyid(role_oid)end order by case when role_oid=0 then 'PUBLIC'else pg_get_userbyid(role_oid)end)from unnest(p.polroles)role_oid),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))order by p.polname)from pg_policy p where p.polrelid=c.oid),'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid)order by t.tgname)from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal))order by n.nspname,c.relname)from pg_class c join pg_namespace n on n.oid=c.relnamespace where left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema'));", name)).hexdigest()
    return result



def reconnect_catalog(name):
    """Semantic definitions only: named roles/grantors, full ACL and constraints.

    ACL ordering and catalog OIDs are not authority. NULL ACL remains distinct
    from explicit grants, and no role attribute or grantor is excluded.
    """
    return json.loads(sql("select jsonb_build_object('roles',(select jsonb_agg(to_jsonb(r)-'oid'order by rolname)from pg_roles r),'memberships',(select jsonb_agg(jsonb_build_object('role',pg_get_userbyid(roleid),'member',pg_get_userbyid(member),'grantor',pg_get_userbyid(grantor),'admin',admin_option,'inherit',inherit_option,'set',set_option)order by pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor))from pg_auth_members m),'catalog',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'schemaAcl',case when n.nspacl is null then null else (select coalesce(jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(x.grantor),'grantee',case when x.grantee=0 then 'PUBLIC'else pg_get_userbyid(x.grantee)end,'privilege',x.privilege_type,'grantable',x.is_grantable)order by pg_get_userbyid(x.grantor),case when x.grantee=0 then 'PUBLIC'else pg_get_userbyid(x.grantee)end,x.privilege_type,x.is_grantable),'[]'::jsonb)from aclexplode(n.nspacl)x)end,'name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'acl',case when c.relacl is null then null else (select coalesce(jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(x.grantor),'grantee',case when x.grantee=0 then 'PUBLIC'else pg_get_userbyid(x.grantee)end,'privilege',x.privilege_type,'grantable',x.is_grantable)order by pg_get_userbyid(x.grantor),case when x.grantee=0 then 'PUBLIC'else pg_get_userbyid(x.grantee)end,x.privilege_type,x.is_grantable),'[]'::jsonb)from aclexplode(c.relacl)x)end,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'indexDefinition',case when c.relkind in('i','I')then pg_get_indexdef(c.oid)end,'viewDefinition',case when c.relkind in('v','m')then pg_get_viewdef(c.oid)end,'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'acl',case when a.attacl is null then null else (select coalesce(jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(x.grantor),'grantee',case when x.grantee=0 then 'PUBLIC'else pg_get_userbyid(x.grantee)end,'privilege',x.privilege_type,'grantable',x.is_grantable)order by pg_get_userbyid(x.grantor),case when x.grantee=0 then 'PUBLIC'else pg_get_userbyid(x.grantee)end,x.privilege_type,x.is_grantable),'[]'::jsonb)from aclexplode(a.attacl)x)end,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'dropped',a.attisdropped,'default',(select pg_get_expr(d.adbin,d.adrelid)from pg_attrdef d where d.adrelid=a.attrelid and d.adnum=a.attnum))order by a.attnum)from pg_attribute a where a.attrelid=c.oid and a.attnum>0),'constraints',(select jsonb_agg(pg_get_constraintdef(k.oid)order by k.conname)from pg_constraint k where k.conrelid=c.oid),'policies',(select jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'cmd',p.polcmd,'roles',(select jsonb_agg(case when role_oid=0 then 'PUBLIC'else pg_get_userbyid(role_oid)end order by case when role_oid=0 then 'PUBLIC'else pg_get_userbyid(role_oid)end)from unnest(p.polroles)role_oid),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))order by p.polname)from pg_policy p where p.polrelid=c.oid),'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid)order by t.tgname)from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal))order by n.nspname,c.relname)from pg_class c join pg_namespace n on n.oid=c.relnamespace where left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema'));", name))


def materialize_reconnect_default_acl(source_catalog, clone_catalog):
    """Only the observed three owner-default ACL representations may be restored.

    pg_dump omits explicit ACLs identical to owner defaults. Preserve the source
    representation with the same owner/grantor; never grant a different actor.
    Every other named catalog field and relation must already match exactly.
    """
    allowed = {'worker_invocation_control', 'worker_invocation_jobs', 'worker_invocations'}
    privileges = {'DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'}
    source = {(v['schema'], v['name']): v for v in source_catalog['catalog']}
    clone = {(v['schema'], v['name']): v for v in clone_catalog['catalog']}
    assert source.keys() == clone.keys(), 'ACL_RESTORE_RELATIONS_MISMATCH'
    assert source_catalog['roles'] == clone_catalog['roles'] and source_catalog['memberships'] == clone_catalog['memberships'], 'ACL_RESTORE_AUTHORITY_MISMATCH'
    changed = {key for key in source if source[key] != clone[key]}
    assert changed == {('private', n) for n in allowed}, 'ACL_RESTORE_EXACT_THREE_REQUIRED'
    for key in sorted(changed):
        a, b = source[key], clone[key]
        assert a['owner'] == b['owner'] == 'postgres' and a['kind'] == b['kind'] == 'r', 'ACL_RESTORE_EXACT_OWNER_TABLE_REQUIRED'
        assert {k: v for k, v in a.items() if k != 'acl'} == {k: v for k, v in b.items() if k != 'acl'}, 'ACL_RESTORE_NONACL_CHANGED'
        acl = a['acl']
        assert b['acl'] is None and isinstance(acl, list) and len(acl) == 8, 'ACL_RESTORE_EXPLICIT_DEFAULT_REQUIRED'
        assert {v.get('privilege') for v in acl} == privileges and all(set(v) == {'grantor', 'grantee', 'privilege', 'grantable'} and v['grantor'] == v['grantee'] == 'postgres' and v['grantable'] is False for v in acl), 'ACL_RESTORE_EXACT_DEFAULT_PRIVILEGES_REQUIRED'
    save('default-acl-restore-intent-private.json', json.dumps({'relations': sorted(allowed), 'owner': 'postgres', 'newCloneOnly': True, 'newAuthority': False}))
    statements = ';'.join('grant all privileges on table private."' + n + '" to postgres' for n in sorted(allowed))
    sql('begin;set local role postgres;' + statements + ';reset role;commit;')
    assert reconnect_catalog(NAME) == source_catalog, 'ACL_RESTORE_FULL_NAMED_CATALOG_MISMATCH'
    save('default-acl-restore-success-private.json', json.dumps({'relations': sorted(allowed), 'fullNamedCatalogExact': True}))

def closed(name):
    assert sql("select not(select enabled from private.worker_invocation_control)and not(select enabled from private.worker_runtime_atomic_control)and not(select enabled from private.ai_feedback_maintenance_control)and not(select external_deletion_approved from private.member_cleanup_guard)and not(select token is not null from private.global_worker_run);", name).decode().strip() == 't', 'CONTROLS_NOT_CLOSED'
    assert sql('show cron.launch_active_jobs;', name).decode().strip() == 'off', 'CRON_NOT_CLOSED'
    for signature in SIGNATURES[:5] + ('purge_worker_runtime_details_scoped(uuid,uuid,integer)',):
        assert sql("select bool_and(not has_function_privilege(r,'public." + signature + "','EXECUTE'))from unnest(array['anon','authenticated','service_role','yumidang_worker_queue'])r;", name).decode().strip() == 't', 'SQL109_EXEC_NOT_CLOSED'


def state(*, allow_stage=False):
    assert ROOT.is_dir() and ROOT.resolve() == ROOT and not ROOT.stat().st_mode & 0o077, 'PRIVATE_ROOT_REQUIRED'
    connection = ROOT / 'connection-private.json'
    # A port publication failure may leave only a stage receipt. It contains
    # sufficient immutable identity to close guards, never enough to resume work.
    assert connection.is_file() or allow_stage, 'PREPARE_INCOMPLETE_NO_RESUME'
    f = json.loads((connection if connection.is_file() else ROOT / 'prepare-stage-private.json').read_text())
    assert f['clone'] == NAME and f['source'] == SOURCE, 'RECORDED_TARGET_MISMATCH'
    assert identity(NAME)['Id'] == f['cloneId'], 'CLONE_REPLACED'
    return f


def jwt(secret, role):
    enc = lambda v: base64.urlsafe_b64encode(json.dumps(v, separators=(',', ':')).encode()).decode().rstrip('=')
    unsigned = enc({'alg': 'HS256', 'typ': 'JWT'}) + '.' + enc({'role': role, 'exp': int(time.time()) + 3600})
    return unsigned + '.' + base64.urlsafe_b64encode(hmac.new(secret.encode(), unsigned.encode(), hashlib.sha256).digest()).decode().rstrip('=')


def mapped_port(container, internal):
    value = docker('port', container, str(internal) + '/tcp').decode().strip()
    assert re.fullmatch(r'127\.0\.0\.1:[1-9][0-9]*', value), 'UNEXPECTED_PORT_BINDING'
    return int(value.rsplit(':', 1)[1])


def prepare():
    assert not ROOT.exists(), 'EXISTING_PRIVATE_EVIDENCE_PRESERVED'
    ROOT.mkdir(mode=0o700)
    existing = docker('ps', '-a', '--format', '{{.Names}}').decode().splitlines()
    assert not set((NAME, REST)).intersection(existing), 'EXISTING_TARGET_PRESERVED'
    assert NETWORK not in docker('network', 'ls', '--format', '{{.Name}}').decode().splitlines(), 'EXISTING_NETWORK_PRESERVED'
    info = identity(SOURCE)
    closed(SOURCE)
    assert sql('show listen_addresses;', SOURCE).decode().strip() == '', 'SOURCE_MUST_REMAIN_SOCKET_ONLY'
    before = fingerprint(SOURCE)
    source_function = sql("select prosrc from pg_proc where oid='public.prepare_queue_invocation(uuid,uuid,text,integer,integer)'::regprocedure;", SOURCE)
    assert b'runtime_maintenance' in source_function, 'ACTUAL_SQL109_REQUIRED'
    save('source-comparison-private.json', json.dumps(before))
    dump = docker('exec', SOURCE, 'pg_dump', '-U', BOOT, '-d', 'postgres', '-Fc')
    roles = docker('exec', SOURCE, 'pg_dumpall', '-U', BOOT, '--roles-only', '--no-role-passwords')
    save('source.dump', dump)
    save('roles.sql', roles)
    assert fingerprint(SOURCE) == before, 'SOURCE_CHANGED_DURING_DUMP'
    if RECONNECT_V8:
        # Fresh initdb already owns BOOT; preserve its exact source ALTER attributes
        # and every original membership GRANTED BY. No authority is weakened.
        role_sql = '\n'.join(line for line in roles.decode().splitlines() if not re.match(r'CREATE ROLE ' + BOOT + r'(?: |;)', line))
        save('source-catalog-private.json', json.dumps(reconnect_catalog(SOURCE), sort_keys=True))
    else:
        role_sql = re.sub(r' GRANTED BY [A-Za-z_][A-Za-z0-9_]*;', ';', roles.decode())
        role_sql = '\n'.join(line for line in role_sql.splitlines() if not re.match(r'(CREATE|ALTER) ROLE ' + BOOT + r'(?: |;)', line))
    # Colima does not publish dynamic ports on --internal networks. Fresh v2/v3/v4
    # bridge publishes only loopback; Deno/Node destinations stay separately scoped.
    network_arguments = []
    if RECONNECT:
        identifiers = docker('network', 'ls', '--format', '{{.ID}}').decode().splitlines()
        allocated = [ipaddress.ip_network(c['Subnet']) for n in json.loads(docker('network', 'inspect', *identifiers))
                     for c in (n.get('IPAM', {}).get('Config') or []) if c.get('Subnet')]
        subnet = next((ipaddress.ip_network('10.251.' + str(n) + '.0/24') for n in range(1, 255)
                       if not any(v.version == 4 and v.overlaps(ipaddress.ip_network('10.251.' + str(n) + '.0/24')) for v in allocated)), None)
        assert subnet is not None, 'NO_NONOVERLAPPING_RECONNECT_SUBNET'
        network_arguments = ['--subnet', str(subnet)]
        save('reconnect-network-allocation.json', json.dumps({'subnet': str(subnet), 'existingNetworkChanged': False}))
    docker('network', 'create', *([] if REVISION != 'v1' else ['--internal']), *network_arguments, '--label', 'yumidang.owner=minkyu', NETWORK)
    # Conditional initdb makes only this fresh clone restart-safe. Source is never restarted.
    docker('run', '-d', '--name', NAME, '--network', NETWORK, '--label', 'yumidang.owner=minkyu',
           *(['--memory', '512m', '--no-healthcheck'] if RECONNECT else []),
           '-p', '127.0.0.1::5432', '--user', 'postgres', '--entrypoint', 'sh', info['Image'], '-c',
           'if [ ! -f /tmp/invocation-data/PG_VERSION ]; then initdb -U ' + BOOT + ' -D /tmp/invocation-data --auth-local=trust --auth-host=reject || exit 1; fi; exec postgres -D /tmp/invocation-data -c listen_addresses=\'*\' -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off')
    for _ in range(40):
        p = subprocess.run(DOCKER + ['exec', NAME, 'pg_isready', '-U', BOOT], capture_output=True, timeout=5)
        if p.returncode == 0:
            break
        time.sleep(.5)
    else:
        raise RuntimeError('FRESH_CLONE_NOT_READY')
    sql(role_sql)
    docker('exec', '-i', NAME, 'pg_restore', '-U', BOOT, '-d', 'postgres', '--single-transaction', '--exit-on-error', data=dump)
    if RECONNECT_V8:
        clone_identity = identity(NAME)
        save('prepare-clone-identity-private.json', json.dumps({'source': SOURCE, 'clone': NAME, 'cloneId': clone_identity['Id'], 'memory': clone_identity['HostConfig']['Memory']}))
        source_catalog = json.loads((ROOT / 'source-catalog-private.json').read_text())
        clone_catalog = reconnect_catalog(NAME)
        if RECONNECT_V9:
            save('clone-before-acl-private.json', json.dumps(clone_catalog, sort_keys=True))
            materialize_reconnect_default_acl(source_catalog, clone_catalog)
            clone_catalog = reconnect_catalog(NAME)
        save('clone-catalog-private.json', json.dumps(clone_catalog, sort_keys=True))
        save('catalog-comparison-private.json', json.dumps({'componentsMatch': {key: source_catalog[key] == clone_catalog[key] for key in source_catalog}, 'cloneClosed': closed(NAME) is None}))
    assert fingerprint(NAME) == before, 'CLONE_DUMP_CONTENT_MISMATCH'
    closed(NAME)
    # Use existing CA; create an isolated leaf without changing TLS99 material.
    assert (TLS / 'ca.crt').is_file() and (TLS / 'ca.key').is_file(), 'EXISTING_APPROVED_CA_REQUIRED'
    save('ca.crt', (TLS / 'ca.crt').read_bytes())
    save('wrong-ca.crt', (TLS / 'wrong-ca.crt').read_bytes())
    save('server.ext', 'subjectAltName=DNS:localhost,DNS:' + NAME + ',IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
    call(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(ROOT / 'server.key'), '-out', str(ROOT / 'server.csr'), '-subj', '/CN=localhost'])
    call(['openssl', 'x509', '-req', '-in', str(ROOT / 'server.csr'), '-CA', str(TLS / 'ca.crt'), '-CAkey', str(TLS / 'ca.key'), '-set_serial', str(secrets.randbits(128)), '-out', str(ROOT / 'server.crt'), '-days', '1', '-extfile', str(ROOT / 'server.ext')])
    for path in ROOT.iterdir():
        path.chmod(0o600)
    for file in ('server.key', 'server.crt', 'ca.crt'):
        docker('cp', str(ROOT / file), NAME + ':/tmp/' + file)
    docker('exec', '--user', 'root', NAME, 'sh', '-c', 'chown postgres:postgres /tmp/server.key /tmp/server.crt /tmp/ca.crt && chmod 600 /tmp/server.key /tmp/server.crt /tmp/ca.crt')
    password, rest_password, secret = (secrets.token_urlsafe(36) for _ in range(3))
    sql("create role " + LOGIN + " login noinherit password '" + password + "';grant yumidang_worker_queue to " + LOGIN + " with admin false,inherit false,set true;create role " + REST_LOGIN + " login noinherit password '" + rest_password + "';grant anon,authenticated,service_role to " + REST_LOGIN + " with admin false,inherit false,set true;")
    hba = 'local all all trust\nhostssl postgres ' + LOGIN + ',' + REST_LOGIN + ' 0.0.0.0/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n'
    docker('exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/invocation-data/pg_hba.conf', data=hba.encode())
    sql("alter system set ssl='on';alter system set ssl_cert_file='/tmp/server.crt';alter system set ssl_key_file='/tmp/server.key';select pg_reload_conf();")
    # Existing locally cached PostgREST image only. No pull, mutable source or credentials reuse.
    rest_image = os.environ.get('INVOCATION_HTTP_POSTGREST_IMAGE')
    if not rest_image:
        for container in existing:
            candidate = json.loads(docker('inspect', container))[0]
            if (candidate['Config'].get('Labels') or {}).get('yumidang.owner') == 'minkyu' and any(x.startswith('PGRST_DB_URI=') for x in (candidate['Config'].get('Env') or [])):
                rest_image = candidate['Image']
                break
    assert rest_image, 'LOCAL_POSTGREST_IMAGE_REQUIRED'
    docker('image', 'inspect', rest_image)
    env = {'PGRST_DB_URI': 'postgresql://' + REST_LOGIN + ':' + rest_password + '@' + NAME + ':5432/postgres?sslmode=verify-full&sslrootcert=/certs/ca.crt', 'PGRST_DB_SCHEMAS': 'public', 'PGRST_DB_ANON_ROLE': 'anon', 'PGRST_JWT_SECRET': secret, 'PGRST_SERVER_PORT': '3000'}
    save('rest-private.env', '\n'.join(k + '=' + v for k, v in env.items()) + '\n')
    # The isolated REST process reads a 0600 CA mount as container root; its DB
    # login remains NOINHERIT and can SET ROLE only to the three API roles.
    docker('run', '-d', '--name', REST, '--network', NETWORK, *(['--memory', '128m', '--no-healthcheck'] if RECONNECT else []), '--user', '0:0', '--label', 'yumidang.owner=minkyu', '-p', '127.0.0.1::3000', '--env-file', str(ROOT / 'rest-private.env'), '--mount', 'type=bind,src=' + str(ROOT / 'ca.crt') + ',dst=/certs/ca.crt,readonly', rest_image)
    closed(NAME)
    assert fingerprint(SOURCE) == before, 'SOURCE_CHANGED_BEFORE_PORT_PROBE'
    clone_id = identity(NAME)['Id']
    save('prepare-stage-private.json', json.dumps({'source': SOURCE, 'clone': NAME, 'cloneId': clone_id,
         'rest': REST, 'restId': identity(REST)['Id'], 'revision': REVISION,
         'phase': 'REST_STARTED_CONTROLS_CLOSED_BEFORE_PORT_PROBE', 'sourceDatabaseChanged': False,
         'fixtureStarted': False, 'dispatchStarted': False}))
    f = {'source': SOURCE, 'clone': NAME, 'cloneId': clone_id, 'dbPort': mapped_port(NAME, 5432), 'restPort': mapped_port(REST, 3000), 'login': LOGIN, 'password': password, 'anonKey': jwt(secret, 'anon'), 'serviceKey': jwt(secret, 'service_role'), 'internalSecret': secrets.token_urlsafe(36), 'helpfulId': str(uuid.uuid4()), 'runtimeId': str(uuid.uuid4()), 'unknownId': str(uuid.uuid4()), 'unknownToken': str(uuid.uuid4())}
    if RECONNECT:
        f.update(reconnectHelpfulId=str(uuid.uuid4()), reconnectRuntimeId=str(uuid.uuid4()))
    save('connection-private.json', json.dumps(f))
    save('prepared.json', json.dumps({'status': 'PREPARED_NOT_RUN', 'sourceDumpSha256': hashlib.sha256(dump).hexdigest(), 'sourceDatabaseChanged': False}))
    print('INVOCATION_HTTP_CLONE_PREPARED_NOT_ACTIVATED')


def fixture():
    f = state()
    assert not (ROOT / 'fixture-started.json').exists(), 'FIXTURE_NO_AUTOMATIC_REPLAY'
    save('fixture-started.json', '{}')
    # All truncation/deletion is restricted to this newly recorded disposable clone.
    sql("truncate private.worker_jobs,private.worker_runtime_intents,private.worker_runtime_results,private.worker_runtime_job_slots,private.member_cleanup_dispatches,private.worker_invocations cascade;delete from private.ai_feedback_receipts where action='helpful';update private.global_worker_run set token=null,expires_at=null;update private.worker_invocation_control set enabled=true;update private.worker_runtime_atomic_control set enabled=true;update private.ai_feedback_maintenance_control set enabled=true;grant execute on function " + ','.join('public.' + s for s in SIGNATURES) + " to service_role;grant execute on function public.read_report_terminal_maintenance_schedule_v2(uuid)to yumidang_worker_queue;insert into private.ai_feedback_receipts(feedback_id,user_id,client_hash,fingerprint,request_id,action,accepted_at)values('" + f['helpfulId'] + "','" + str(uuid.uuid4()) + "','synthetic-http109','synthetic-http109','" + str(uuid.uuid4()) + "','helpful',clock_timestamp()-interval'91 days');insert into private.worker_runtime_results(request_id,global_token,operation,fingerprint,input,result,state,created_at,closed_at)values('" + f['runtimeId'] + "','" + str(uuid.uuid4()) + "','synthetic_http109',repeat('a',64),'{}','{}','completed',clock_timestamp()-interval'32 days',clock_timestamp()-interval'31 days');notify pgrst,'reload schema';")
    verify_tls_and_role(f)
    print('ISOLATED_FIXTURE_OPEN')


def verify_tls_and_role(f):
    save('queue.pgpass', 'localhost:5432:postgres:' + LOGIN + ':' + f['password'] + '\n')
    docker('cp', str(ROOT / 'queue.pgpass'), NAME + ':/tmp/queue.pgpass')
    docker('cp', str(ROOT / 'wrong-ca.crt'), NAME + ':/tmp/wrong-ca.crt')
    docker('exec', '--user', 'root', NAME, 'sh', '-c', 'chown postgres:postgres /tmp/queue.pgpass /tmp/wrong-ca.crt && chmod 600 /tmp/queue.pgpass /tmp/wrong-ca.crt')
    def login(query, suffix='sslmode=verify-full sslrootcert=/tmp/ca.crt', host='localhost'):
        connection = 'host=' + host + ' hostaddr=127.0.0.1 port=5432 dbname=postgres user=' + LOGIN + ' ' + suffix
        return subprocess.run(DOCKER + ['exec', '-i', '-e', 'PGPASSFILE=/tmp/queue.pgpass', NAME, 'psql', '-XqAt', '-d', connection, '-v', 'ON_ERROR_STOP=1'], input=query.encode(), capture_output=True, timeout=10)
    # Read the actual connection's SSL row before SET ROLE removes pg_stat_ssl
    # visibility. The same connection then proves the exact queue/session roles.
    good = login("select ssl from pg_stat_ssl where pid=pg_backend_pid();set role yumidang_worker_queue;select current_user||':'||session_user;")
    assert good.returncode == 0 and good.stdout.decode().strip().splitlines() == ['t', 'yumidang_worker_queue:' + LOGIN], 'QUEUE_TLS_IDENTITY_NOT_PROVEN'
    for query in ('set role service_role;', 'set role yumidang_worker_queue;select *from private.worker_invocations;', 'set role yumidang_worker_queue;create table public.synthetic_privilege_bypass(id int);'):
        denied = login(query)
        assert denied.returncode != 0, 'QUEUE_PRIVILEGE_BYPASS'
    assert login('select 1;', 'sslmode=disable').returncode != 0, 'PLAINTEXT_LOGIN_ALLOWED'
    assert login('select 1;', 'sslmode=verify-full sslrootcert=/tmp/wrong-ca.crt').returncode != 0, 'WRONG_CA_ALLOWED'
    # Verify-full rejects the certificate before password lookup, so require an
    # actual certificate error rather than a pgpass-hostname authentication error.
    connection = 'host=wrong.invalid hostaddr=127.0.0.1 dbname=postgres user=' + LOGIN + ' sslmode=verify-full sslrootcert=/tmp/ca.crt'
    denied = subprocess.run(DOCKER + ['exec', '-i', '-e', 'PGPASSFILE=/tmp/queue.pgpass', NAME, 'psql', '-XqAt', '-d', connection], input=b'select 1;', capture_output=True, timeout=10)
    assert denied.returncode != 0 and b'certificate' in denied.stderr.lower(), 'WRONG_HOST_NOT_CERTIFICATE_REJECTED'
    save('tls-role-evidence.json', json.dumps({'verifyFull': True, 'wrongCaRejected': True, 'wrongHostRejected': True, 'plaintextRejected': True, 'setServiceRoleDenied': True, 'tableReadDenied': True, 'tableCreateDenied': True}))


def snapshot():
    f = state()
    value = json.loads(sql("select json_build_object('invocations',(select coalesce(json_agg(json_build_object('requestId',request_id,'token',global_token,'kind',kind,'state',state,'dispatchStarted',dispatch_started,'result',result,'limit',item_limit)order by created_at),'[]')from private.worker_invocations),'helpfulRemaining',(select count(*)from private.ai_feedback_receipts where feedback_id='" + f['helpfulId'] + "'),'runtimePurged',(select state='purged'and input is null and result is null from private.worker_runtime_results where request_id='" + f['runtimeId'] + "'),'queueSessions',(select count(*)from pg_stat_activity where application_name='yumidang-worker-queue'),'lease',(select json_build_object('token',token,'expiresAt',expires_at)from private.global_worker_run),'slots',(select count(*)from private.worker_runtime_job_slots));"))
    print(json.dumps(value))


def unknown():
    f = state()
    assert sql('select token is null from private.global_worker_run;').decode().strip() == 't', 'CLI_MUST_RELEASE_BEFORE_UNKNOWN_FIXTURE'
    sql("begin;select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);update private.global_worker_run set token='" + f['unknownToken'] + "',expires_at=clock_timestamp()+interval'180 seconds';select public.prepare_queue_invocation('" + f['unknownId'] + "','" + f['unknownToken'] + "','helpful_maintenance',1,10000);select public.mark_queue_invocation_unknown('" + f['unknownId'] + "');insert into private.ai_feedback_receipts(user_id,client_hash,fingerprint,request_id,action,accepted_at)values('" + str(uuid.uuid4()) + "','synthetic-http109-unknown','synthetic-http109-unknown','" + str(uuid.uuid4()) + "','helpful',clock_timestamp()-interval'91 days');commit;")
    print('UNKNOWN_FIXTURE_PERSISTED_NO_DISPATCH')


def close():
    state(allow_stage=True)
    sql("update private.worker_invocation_control set enabled=false;update private.worker_runtime_atomic_control set enabled=false;update private.ai_feedback_maintenance_control set enabled=false;revoke execute on function " + ','.join('public.' + s for s in SIGNATURES) + " from service_role;revoke execute on function public.read_report_terminal_maintenance_schedule_v2(uuid)from yumidang_worker_queue;update private.global_worker_run set token=null,expires_at=null;")
    closed(NAME)
    assert fingerprint(SOURCE) == json.loads((ROOT / 'source-comparison-private.json').read_text()), 'SOURCE_DATABASE_CHANGED'
    print('ISOLATED_CONTROLS_CLOSED_SOURCE_UNCHANGED')


def reconnect_proof():
    assert RECONNECT, 'RECONNECT_SCENARIO_REQUIRED'
    f = state()
    value = json.loads(sql("select jsonb_build_object('queueBackends',(select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'backendStart',backend_start,'idle',state='idle')order by pid),'[]'::jsonb)from pg_stat_activity where usename='" + LOGIN + "'and application_name='yumidang-worker-queue'and backend_type='client backend'),"
        "'missedHelpfulRemaining',(select count(*)from private.ai_feedback_receipts where feedback_id='" + f['reconnectHelpfulId'] + "'),"
        "'missedRuntimePurged',(select state='purged'and input is null and result is null from private.worker_runtime_results where request_id='" + f['reconnectRuntimeId'] + "'),"
        "'unknownSha256',(select encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex')from private.worker_invocations i where request_id='" + f['unknownId'] + "'),"
        "'dispatchAckSha256',(select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(d)::text,','order by to_jsonb(d)::text),''),'UTF8')),'hex')from private.member_cleanup_dispatches d));"))
    if RECONNECT_V12:
        # SQL104 예약의 실제 최소 closed_at 행만 읽는다. 보관 기한/fixture를 바꾸지 않는다.
        definition_query = "select encode(sha256(convert_to(pg_get_functiondef('public.read_worker_runtime_maintenance_schedule(uuid)'::regprocedure),'UTF8')),'hex');"
        source_definition = sql(definition_query, SOURCE).decode().strip()
        clone_definition = sql(definition_query).decode().strip()
        assert source_definition == clone_definition, 'RUNTIME_SCHEDULE_CONTRACT_CHANGED'
        retention = json.loads(sql("select coalesce((select jsonb_build_object('requestId',r.request_id,'state',r.state,'operation',r.operation,'closedAt',r.closed_at,'retentionDueAt',r.closed_at+interval'720 hours','invocationState',i.state,'invocationKind',i.kind,'globalBindingMatches',i.global_token=r.global_token,'rowSha256',encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex'))from private.worker_runtime_results r left join private.worker_invocations i on i.request_id=r.request_id where r.state='completed'order by r.closed_at,r.request_id limit 1),'null'::jsonb);"))
        assert retention is not None, 'ACTUAL_COMPLETED_RUNTIME_RETENTION_ROW_REQUIRED'
        retention['definitionSha256'] = clone_definition
        value['runtimeRetention'] = retention
    print(json.dumps(value))


def disconnect_reconnect(due):
    """기록된 새 clone의 정확한 전용 LOGIN PID 하나만 종료한다. 원 DB/PID는 선택하지 않는다."""
    assert RECONNECT, 'RECONNECT_SCENARIO_REQUIRED'
    f = state()
    marker = 'reconnect-disconnect-' + ('due' if due else 'unknown') + '.json'
    assert not (ROOT / marker).exists(), 'DISCONNECT_NO_AUTOMATIC_REPLAY'
    trace_path = ROOT / 'reconnect-node-trace-private.jsonl'
    info = trace_path.lstat()
    assert trace_path.is_file() and not trace_path.is_symlink() and info.st_uid == os.getuid() and info.st_mode & 0o777 == 0o600, 'OWN_PRIVATE_NODE_TRACE_REQUIRED'
    trace = [json.loads(line) for line in trace_path.read_text().splitlines()]
    listened = [item for item in trace if item['code'] == 'LISTEN_VERIFIED' and item['channel'] == 'yumidang_worker_jobs']
    assert listened, 'ACTUAL_LISTEN_PROOF_REQUIRED'
    target = listened[-1]
    pid, node_pid = target['databasePid'], target['nodePid']
    assert type(pid) is int and type(node_pid) is int and pid > 0 and node_pid > 0, 'INVALID_RECORDED_PID'
    victim = json.loads(sql("select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'backendStart',backend_start,'idle',state='idle')),'[]'::jsonb)from pg_stat_activity where usename='" + LOGIN + "'and application_name='yumidang-worker-queue'and datname='postgres'and backend_type='client backend';"))
    assert len(victim) == 1 and victim[0]['pid'] == pid and victim[0]['idle'], 'ONLY_EXACT_IDLE_CLONE_QUEUE_PID_ALLOWED'
    assert sql('select token is null from private.global_worker_run;').decode().strip() == 't' or not due, 'DISCONNECT_DUE_REQUIRES_RELEASED_CYCLE'
    save(marker, json.dumps({'status': 'INTENT_BEFORE_SINGLE_OBSERVER_TERMINATION', 'databasePid': pid, 'nodePid': node_pid, 'backendStart': victim[0]['backendStart'], 'cloneId': f['cloneId'], 'newDue': due}))
    # recheck backend_start in the same terminating statement to reject numeric PID reuse.
    backend_start = victim[0]['backendStart'].replace("'", "''")
    terminated = sql("select pg_terminate_backend(pid,5000)from pg_stat_activity where pid=" + str(pid) + " and backend_start='" + backend_start + "'::timestamptz and usename='" + LOGIN + "'and application_name='yumidang-worker-queue'and datname='postgres'and backend_type='client backend'and state='idle'and pid<>pg_backend_pid();").decode().strip()
    assert terminated == 't', 'RECORDED_QUEUE_BACKEND_NOT_TERMINATED'
    uid, request_id, token = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    # The absence assertion and due/NOTIFY commit form one DB transaction. Reconnect waits5000ms.
    statement = "begin;do $$begin if exists(select 1 from pg_stat_activity where usename='" + LOGIN + "'and application_name='yumidang-worker-queue')then raise exception 'reconnect_gap_not_proven';end if;end;$$;"
    if due:
        statement += "insert into private.ai_feedback_receipts(feedback_id,user_id,client_hash,fingerprint,request_id,action,accepted_at)values('" + f['reconnectHelpfulId'] + "','" + uid + "','synthetic-reconnect109','synthetic-reconnect109','" + request_id + "','helpful',clock_timestamp()-interval'91 days');"
        statement += "insert into private.worker_runtime_results(request_id,global_token,operation,fingerprint,input,result,state,created_at,closed_at)values('" + f['reconnectRuntimeId'] + "','" + token + "','synthetic_reconnect109',repeat('b',64),'{}','{}','completed',clock_timestamp()-interval'32 days',clock_timestamp()-interval'31 days');"
    statement += "do $$begin if exists(select 1 from pg_stat_activity where usename='" + LOGIN + "'and application_name='yumidang-worker-queue')then raise exception 'reconnect_gap_not_proven';end if;end;$$;notify yumidang_worker_jobs,'';commit;"
    sql(statement)
    save('reconnect-gap-' + ('due' if due else 'unknown') + '-committed.json', json.dumps({'databasePid': pid, 'nodePid': node_pid, 'noQueueListenerAtTransactionCheck': True, 'notificationCommittedWhileDisconnected': True, 'dueRowsCommitted': 2 if due else 0, 'sourceOrOtherPidTerminations': 0}))
    print('RECORDED_CLONE_QUEUE_DISCONNECT_AND_GAP_COMMITTED')


def stop_reconnect_clone():
    assert RECONNECT, 'RECONNECT_SCENARIO_REQUIRED'
    stage = json.loads((ROOT / 'prepare-stage-private.json').read_text())
    for name, identifier in ((REST, stage['restId']), (NAME, stage['cloneId'])):
        info = json.loads(docker('inspect', name))[0]
        assert info['Id'] == identifier and (info['Config'].get('Labels')or{}).get('yumidang.owner') == 'minkyu', 'OWN_RECORDED_CONTAINER_ONLY'
        if info['State']['Running']:
            docker('stop', '--time', '5', name)
        assert not json.loads(docker('inspect', name))[0]['State']['Running'], 'OWN_CONTAINER_NOT_STOPPED'
    save('reconnect-closed-stopped.json', json.dumps({'containers': [NAME, REST], 'stoppedAndPreserved': True, 'deleteRestartOtherContainer': 0}))


def reconnect_product_manifest():
    """제품 전체 현재 바이트를 묶는다. 배포·운영 승인이나 DB 접속을 수행하지 않는다."""
    files = [REPO / 'backend/package.json', REPO / 'backend/package-lock.json']
    files += [p for p in (REPO / 'backend/supabase/functions').rglob('*')
              if p.suffix in ('.ts', '.mjs', '.json') and not re.search(r' [0-9]+\.(?:ts|mjs|json)$', p.name)]
    result = {}
    for path in sorted(files):
        assert path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(REPO.resolve()), 'UNREVIEWED_SOURCE_PATH'
        result[str(path.relative_to(REPO))] = hashlib.sha256(path.read_bytes()).hexdigest()
    entry = (REPO / 'backend/supabase/functions/scheduled-jobs/queue-runner.mjs').read_text()
    assert re.search(r'^export async function runQueueRunnerCli\(', entry, re.M), 'ACTUAL_COMMON_CLI_ENTRY_REQUIRED'
    return result


def run_reconnect():
    state()
    assert not (ROOT / 'fixture-started.json').exists() and not (ROOT / 'receipt.json').exists(), 'EXISTING_RUN_PRESERVED'
    closed(NAME)
    script = Path(__file__).with_name('worker_invocation_http.ts')
    assert (REPO / 'backend/node_modules/pg/package.json').is_file(), 'ACTUAL_PG_REQUIRED_BEFORE_FIXTURE'
    product_manifest = reconnect_product_manifest()
    save('reconnect-static-manifest.json', json.dumps({'productFiles': product_manifest, 'pythonSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'typescriptSha256': hashlib.sha256(script.read_bytes()).hexdigest(), 'cliSha256': hashlib.sha256((REPO / 'backend/supabase/functions/scheduled-jobs/queue-runner.mjs').read_bytes()).hexdigest()}))
    try:
        result = subprocess.run(['deno', 'run', '--cached-only', '--allow-net=127.0.0.1', '--allow-read=' + str(REPO) + ',' + str(ROOT), '--allow-write=' + str(ROOT), '--allow-env', '--allow-run=node,python3', '--cert=' + str(ROOT / 'ca.crt'), str(script), '--revision-' + REVISION, '--scenario-reconnect'], cwd=REPO, capture_output=True, timeout=120)
        save('reconnect-run-private.log', result.stdout + result.stderr)
        assert result.returncode == 0, 'RECONNECT_ACTUAL_CLI_FAILED_PRIVATE_EVIDENCE_PRESERVED'
    finally:
        try:
            close()
        finally:
            stop_reconnect_clone()
    assert reconnect_product_manifest() == product_manifest, 'PRODUCT_SOURCE_CHANGED_DURING_REAL_RECONNECT'
    receipt = json.loads((ROOT / 'reconnect-provisional.json').read_text())
    assert receipt['status'] == 'PASS', 'REAL_RECONNECT_PROOF_REQUIRED'
    receipt.update(containersStoppedAndPreserved=True, guardsClosed=True, sourceDatabaseChanged=False)
    save('receipt.json', json.dumps(receipt, indent=2))
    print(json.dumps(receipt))


def run():
    if RECONNECT:
        return run_reconnect()
    state()
    assert not (ROOT / 'receipt.json').exists(), 'EXISTING_RECEIPT_PRESERVED'
    # A dependency failure before fixture creation has no execution effect and
    # may be retried on this clone. Once the durable fixture marker exists, every
    # failure requires inspection; even an incomplete run is never blindly replayed.
    assert not (ROOT / 'fixture-started.json').exists(), 'FIXTURE_ALREADY_STARTED_NO_RUN_REPLAY'
    closed(NAME)
    dependency = REPO / 'backend/node_modules/pg/package.json'
    assert dependency.is_file(), 'PG_DEPENDENCY_REQUIRED_BEFORE_FIXTURE'
    assert json.loads(dependency.read_text()).get('name') == 'pg', 'ACTUAL_PG_DEPENDENCY_REQUIRED'
    run_id = str(uuid.uuid4())
    script = Path(__file__).with_name('worker_invocation_http.ts')
    save('run-' + run_id + '-metadata.json', json.dumps({'revision': REVISION,
         'phase': 'PREREQUISITES_READY_NO_FIXTURE', 'fixtureStarted': False,
         'pythonSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
         'typescriptSha256': hashlib.sha256(script.read_bytes()).hexdigest()}))
    try:
        result = subprocess.run(['deno', 'run', '--cached-only', '--allow-net=127.0.0.1', '--allow-read=' + str(REPO) + ',' + str(ROOT), '--allow-write=' + str(ROOT), '--allow-env', '--allow-run=node,python3', '--cert=' + str(ROOT / 'ca.crt'), str(script)] + (['--revision-' + REVISION] if REVISION != 'v1' else []), cwd=REPO, capture_output=True, timeout=100)
        save('http-run-' + run_id + '-private.log', result.stdout + result.stderr)
        assert result.returncode == 0, 'HTTP_CLI_FAILED_INSPECT_PRIVATE_EVIDENCE'
    finally:
        close()
    receipt = json.loads((ROOT / 'receipt.json').read_text())
    assert receipt['status'] == 'PASS', 'ACTUAL_EVIDENCE_REQUIRED'
    print(json.dumps(receipt))


if __name__ == '__main__':
    actions = {'--prepare': prepare, '--fixture': fixture, '--snapshot': snapshot, '--unknown': unknown, '--close': close, '--run': run}
    if RECONNECT:
        actions.update({'--disconnect-due': lambda: disconnect_reconnect(True), '--disconnect-unknown': lambda: disconnect_reconnect(False), '--reconnect-proof': reconnect_proof})
    assert (len(sys.argv) == 2 or REVISION_V2 or REVISION_V3 or REVISION_V4 or REVISION_V5 or RECONNECT) and sys.argv[1] in actions, 'INVALID_ACTION'
    actions[sys.argv[1]]()
