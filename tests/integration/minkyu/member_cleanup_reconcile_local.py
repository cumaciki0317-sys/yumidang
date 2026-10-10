"""SQL112 읽기 복제에 SQL114/115를 적용하고 SQL115 합성 회귀를 rollback한다."""
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
FOUNDATION = REPO if (REPO / 'tests/integration/minkyu/product_connection_restore108_local.py').is_file() else REPO.parent / 'minkyu-foundation'
sys.path.insert(0, str(FOUNDATION / 'tests/integration/minkyu'))
import product_connection_restore108_local as recovery
import queue_tls_environment as tls

ROOT = Path('/private/tmp/yumidang-member115-20261009-v2')
NAME = 'yumidang-minkyu-member115-20261009-v2'
SOURCE = 'yumidang-minkyu-event112-20261009-v1'
MIGRATION = REPO / 'backend/supabase/migrations/20261009011500_member_cleanup_reconcile.sql'
TEST = REPO / 'tests/database/minkyu/member_cleanup_reconcile.sql'
SQL114 = FOUNDATION / 'backend/supabase/migrations/20261009011400_worker_intent_confirmation.sql'
SQL114_SHA = '7ba321e924e02bfea41a244435a21a5fc52d71e049421e178ca72a91358065ed'
MARKERS = ('private.worker_runtime_intent_confirmations', 'private.member_cleanup_reconciliations')
FUNCTIONS = (
    'public.prepare_queue_invocation(uuid,uuid,text,integer,integer)',
    'public.claim_queue_invocation_dispatch(uuid,uuid,text,integer,integer)',
    'public.get_queue_invocation(uuid)', 'public.complete_queue_invocation(uuid)',
    'public.mark_queue_invocation_unknown(uuid)',
    'public.begin_member_cleanup_reconcile(uuid,uuid,uuid,uuid)',
    'public.get_member_cleanup_reconcile(uuid)',
    'public.finish_member_cleanup_reconcile(uuid,text)',
    'public.prepare_worker_invocation_intent(uuid,uuid,text,jsonb,uuid)',
    'public.execute_worker_invocation_operation(uuid,uuid,uuid,text,jsonb)',
    'public.confirm_worker_runtime_intent(uuid)',
)


def save(name, data):
    with os.fdopen(os.open(ROOT / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        stream.write(data)


def call(args, data=None):
    try:
        result = subprocess.run(args, input=data, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired as error:
        save('failure-' + str(uuid.uuid4()) + '.log', (error.stdout or b'') + (error.stderr or b''))
        raise RuntimeError('MEMBER115_TIMEOUT_PRIVATE_EVIDENCE_PRESERVED') from None
    if result.returncode:
        save('failure-' + str(uuid.uuid4()) + '.log', result.stdout + result.stderr)
        raise RuntimeError('MEMBER115_FAILED_PRIVATE_EVIDENCE_PRESERVED')
    return result.stdout


def query(name, statement):
    return call(tls.DOCKER + ['exec', '-i', name, 'psql', '-XqAt', '-U', recovery.BOOT,
                             '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], statement.encode())


def rows(name):
    return recovery.read_database_row_digests(lambda sql: query(name, sql))


def roles(name):
    # 비밀번호는 pg_roles에 노출되지 않는다. 이름 기준의 권한·멤버십만 비교한다.
    return json.loads(query(name, """select jsonb_build_object(
      'roles',(select jsonb_agg(to_jsonb(r)order by rolname)from pg_roles r),
      'memberships',(select coalesce(jsonb_agg(jsonb_build_array(
        pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor),
        admin_option,inherit_option,set_option)order by pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor)),'[]'::jsonb)from pg_auth_members));"""))


def catalog(name):
    # OID·dump 시각·무작위 psql restriction 키는 복원 비교의 식별자가 아니다.
    raw = call(tls.DOCKER + ['exec', name, 'pg_dump', '-U', recovery.BOOT,
                             '-d', 'postgres', '--schema-only']).decode()
    return '\n'.join(line for line in raw.splitlines()
                     if line.strip() and not line.startswith('--')
                     and not line.startswith(('\\restrict ', '\\unrestrict ')))


def snapshot(name):
    return {'rows': rows(name), 'catalog': catalog(name), 'roles': roles(name)}


def fingerprints():
    assert hashlib.sha256(SQL114.read_bytes()).hexdigest() == SQL114_SHA, 'SQL114_FINAL_SOURCE_CHANGED'
    return {'sql114Sha256': SQL114_SHA,
            'migrationSha256': hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),
            'testSha256': hashlib.sha256(TEST.read_bytes()).hexdigest()}


def assert_closed(name, *, reconciler=False):
    recovery.assert_closed(lambda sql: query(name, sql))
    for table in ('worker_invocation_control', 'worker_intent_confirmation_control', 'event_collection_control'):
        if query(name, "select to_regclass('private." + table + "');").decode().strip():
            assert query(name, 'select not enabled from private.' + table + ' where singleton;').decode().strip() == 't', 'CONTROL_DEFAULT_OPEN'
    for signature in FUNCTIONS:
        if not query(name, "select to_regprocedure('" + signature + "');").decode().strip():
            assert not reconciler or 'reconcile' not in signature, 'RECONCILE_RPC_MISSING'
            continue
        for role in ('anon', 'authenticated', 'service_role', 'yumidang_worker_queue'):
            assert query(name, "select has_function_privilege('" + role + "','" + signature + "','EXECUTE');").decode().strip() == 'f', 'EXECUTE_NOT_CLOSED'
    assert query(name, 'show cron.launch_active_jobs;').decode().strip() == 'off', 'CRON_NOT_DISABLED'
    assert query(name, 'show listen_addresses;').decode().strip() == '', 'UNEXPECTED_TCP_LISTENER'


def restore(dump, roles_sql):
    # 이미지 캐시만 사용하고 새 clone의 Docker 외부 통신도 차단한다.
    call(tls.DOCKER + ['image', 'inspect', tls.IMAGE])
    call(tls.DOCKER + ['run', '-d', '--pull=never', '--network=none', '--name', NAME,
                      '--label', 'yumidang.owner=minkyu', '--user', 'postgres',
                      '--entrypoint', 'sh', tls.IMAGE, '-c',
                      'initdb -U ' + recovery.BOOT + " -D /tmp/recovery-data --auth-local=trust --auth-host=reject && exec postgres -D /tmp/recovery-data -c listen_addresses='' -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off"])
    for _ in range(40):
        probe = subprocess.run(tls.DOCKER + ['exec', NAME, 'pg_isready', '-U', recovery.BOOT], capture_output=True, timeout=5)
        if probe.returncode == 0:
            break
        time.sleep(.5)
    else:
        raise RuntimeError('NEW_CLONE_NOT_READY_PRESERVED')
    query(NAME, roles_sql)
    call(tls.DOCKER + ['exec', '-i', NAME, 'pg_restore', '-U', recovery.BOOT,
                      '-d', 'postgres', '--single-transaction', '--exit-on-error'], dump)
    info = json.loads(call(tls.DOCKER + ['inspect', NAME]))[0]
    assert info['HostConfig']['NetworkMode'] == 'none' and not info['HostConfig']['PortBindings'] and not info['Mounts'], 'NEW_CLONE_ISOLATION_INVALID'
    assert_closed(NAME)


def prepare():
    assert not ROOT.exists(), 'EXISTING_MEMBER115_ARTIFACTS_PRESERVED'
    ROOT.mkdir(mode=0o700)
    frozen = fingerprints()
    existing = call(tls.DOCKER + ['ps', '-a', '--format', '{{.Names}}']).decode().splitlines()
    assert SOURCE in existing and NAME not in existing, 'SOURCE_OR_NEW_CLONE_INVALID'
    info = json.loads(call(tls.DOCKER + ['inspect', SOURCE]))[0]
    assert info['State']['Running'] and info['Config']['Labels'].get('yumidang.owner') == 'minkyu', 'SOURCE_RUNNING_OWNERSHIP_INVALID'
    assert query(SOURCE, "select to_regclass('private.event_invocation_references');").decode().strip(), 'SOURCE_SQL112_REQUIRED'
    for marker in MARKERS:
        assert not query(SOURCE, "select to_regclass('" + marker + "');").decode().strip(), 'SOURCE_ALREADY_NEW_MIGRATION'
    assert_closed(SOURCE)
    before = snapshot(SOURCE)
    dump = call(tls.DOCKER + ['exec', SOURCE, 'pg_dump', '-U', recovery.BOOT, '-d', 'postgres', '-Fc'])
    role_dump = call(tls.DOCKER + ['exec', SOURCE, 'pg_dumpall', '-U', recovery.BOOT,
                                  '--roles-only', '--no-role-passwords']).decode()
    assert not re.search(r"\bPASSWORD\s+'", role_dump, re.I), 'ROLE_PASSWORD_MUST_NOT_BE_SAVED'
    save('source.dump', dump)
    save('roles.sql', role_dump.encode())
    save('source-before.json', json.dumps(before).encode())
    role_dump = re.sub(r' GRANTED BY [A-Za-z_][A-Za-z0-9_]*;', ';', role_dump)
    role_dump = '\n'.join(line for line in role_dump.splitlines()
                          if not re.match(r'(CREATE|ALTER) ROLE ' + re.escape(recovery.BOOT) + r'(?: |;)', line))
    restore(dump, role_dump)
    restored = snapshot(NAME)
    # pg_roles OID는 cluster별 다르므로 비교 전에 제거한다.
    for value in (before, restored):
        for role in value['roles']['roles']:
            role.pop('oid', None)
    save('restored-before.json', json.dumps(restored).encode())
    assert restored == before, 'RESTORED_ROWS_CATALOG_ROLE_ACL_MISMATCH'
    after = snapshot(SOURCE)
    for role in after['roles']['roles']:
        role.pop('oid', None)
    assert after == before, 'READONLY_SOURCE_CHANGED_DURING_CLONE'
    save('source-normalized.json', json.dumps(before).encode())
    save('prepared.json', json.dumps({'sourceChanged': False, 'clone': NAME,
                                     'sourceDumpSha256': hashlib.sha256(dump).hexdigest(), **frozen}).encode())
    print('MEMBER115_SQL112_CLONE_PREPARED_NOT_ACTIVATED')


def normalized_snapshot(name):
    value = snapshot(name)
    for role in value['roles']['roles']:
        role.pop('oid', None)
    return value


def apply_one(path, marker, key, expected):
    receipt = ROOT / (key + '-applied.json')
    present = query(NAME, "select to_regclass('" + marker + "');").decode().strip()
    if present:
        assert receipt.is_file() and json.loads(receipt.read_text()) == expected, 'APPLIED_MIGRATION_CHANGED_OR_UNRECORDED'
    else:
        assert not receipt.exists(), 'RECORDED_MIGRATION_MARKER_MISSING'
        query(NAME, path.read_text())
        save(receipt.name, json.dumps(expected).encode())


def apply_test():
    assert ROOT.is_dir() and ROOT.resolve() == ROOT and not (ROOT.stat().st_mode & 0o077), 'PRIVATE_RECOVERY_REQUIRED'
    assert (ROOT / 'prepared.json').is_file() and not (ROOT / 'receipt.json').exists(), 'PREPARE_OR_RECEIPT_INVALID'
    frozen = fingerprints()
    prepared = json.loads((ROOT / 'prepared.json').read_text())
    assert prepared['clone'] == NAME and all(prepared[key] == value for key, value in frozen.items()), 'PREPARED_SOURCE_CHANGED'
    source = json.loads((ROOT / 'source-normalized.json').read_text())
    assert normalized_snapshot(SOURCE) == source, 'SOURCE_CHANGED_SINCE_PREPARE'
    assert_closed(SOURCE)
    apply_one(SQL114, MARKERS[0], 'sql114', {'sha256': frozen['sql114Sha256']})
    apply_one(MIGRATION, MARKERS[1], 'sql115', {'sha256': frozen['migrationSha256']})
    before = normalized_snapshot(NAME)
    assert all(before['rows'].get(key) == value for key, value in source['rows'].items()), 'MIGRATION_CHANGED_EXISTING_ROWS'
    assert_closed(NAME, reconciler=True)
    fixtures = "array(select('d1150000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,3)n)"
    assert query(NAME, 'select not exists(select 1 from auth.users where id=any(' + fixtures + '));').decode().strip() == 't', 'SYNTHETIC_AUTH_UUID_COLLISION'
    body, removed = re.subn(r'(?m)^begin;\n', '', TEST.read_text(), count=1)
    assert removed == 1 and re.search(r'(?m)^rollback;\s*\Z', body), 'SCRATCH_TRANSACTION_BOUNDARY_INVALID'
    prelude = ('begin;truncate private.worker_jobs,private.worker_runtime_intents,private.worker_runtime_results,'
               'private.worker_runtime_job_slots,private.worker_invocations,private.member_cleanup_tasks,'
               'private.member_cleanup_dispatches,private.member_cleanup_reconciliations cascade;\n')
    query(NAME, prelude + body)
    after = normalized_snapshot(NAME)
    save('clone-after-test.json', json.dumps(after).encode())
    assert after == before, 'SCRATCH_ROWS_CATALOG_ROLES_ACL_NOT_ROLLED_BACK'
    source_after = normalized_snapshot(SOURCE)
    save('source-after.json', json.dumps(source_after).encode())
    assert source_after == source, 'READONLY_SOURCE_CHANGED'
    assert_closed(NAME, reconciler=True)
    assert_closed(SOURCE)
    receipt = {'status': 'PASS', 'scope': 'ISOLATED_SQL114_AND_SQL115_DATABASE', **frozen,
               'driverSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               'source': SOURCE, 'clone': NAME, 'sourceTableCount': len(source['rows']),
               'cloneTableCount': len(before['rows']), 'sourceDumpSha256': prepared['sourceDumpSha256'],
               'allTableRowsCatalogRolesAclRolledBack': True, 'sourceRowsCatalogRolesAclUnchanged': True,
               'trackedUnknownIndependentGetOnlyProvenance': True, 'originalDispatchAckUnchanged': True,
               'originalTokenLeaseEffectNotCopied': True, 'noAckNewClaimBlocked': True,
               'sharedUniqueTwentyRecoveryCap': True, 'existingReviewDelegate': True,
               'globalLeaseNotRenewed': True, 'defaultGuardAndExecClosed': True,
               'socketOnlyCronOffNetworkNone': True, 'externalCommunications': 0,
               'additionalExternalDeleteDispatchAck': 0, 'physicalStorageAuthGet': 'NOT_RUN',
               'physicalStorageAuthDelete': 'NOT_RUN', 'realMemberAndProductCli': 'NOT_RUN',
               'operatingChanged': False}
    save('receipt.json', json.dumps(receipt, ensure_ascii=False, indent=2).encode())
    print(json.dumps(receipt, ensure_ascii=False))


def verify_closed():
    # 완료된 합성 회귀는 재실행하지 않고 보완된 guard/ACL 검사를 읽기로 수행한다.
    assert ROOT.is_dir() and ROOT.resolve() == ROOT and not (ROOT.stat().st_mode & 0o077), 'PRIVATE_RECOVERY_REQUIRED'
    receipt = json.loads((ROOT / 'receipt.json').read_text())
    assert receipt['status'] == 'PASS' and all(receipt[key] == value for key, value in fingerprints().items()), 'PASS_SOURCE_CHANGED'
    assert normalized_snapshot(SOURCE) == json.loads((ROOT / 'source-after.json').read_text()), 'SOURCE_CHANGED_AFTER_PASS'
    assert normalized_snapshot(NAME) == json.loads((ROOT / 'clone-after-test.json').read_text()), 'CLONE_CHANGED_AFTER_PASS'
    assert_closed(SOURCE)
    assert_closed(NAME, reconciler=True)
    receipt.update(driverSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                   sql114ConfirmationAndEventGuardExecClosed=True,
                   originalReceiptSha256=hashlib.sha256((ROOT / 'receipt.json').read_bytes()).hexdigest())
    save('receipt-final.json', json.dumps(receipt, ensure_ascii=False, indent=2).encode())
    print(json.dumps(receipt, ensure_ascii=False))


# SQL118은 같은 하네스의 별도 recipe다. 기존 SQL115 기본 경로와 artifact를 바꾸지 않는다.
DISCOVERY_ROOT = Path('/private/tmp/yumidang-member118-20261009-v1')
DISCOVERY_NAME = 'yumidang-minkyu-member118-20261009-v1'
DISCOVERY_MIGRATION = REPO / 'backend/supabase/migrations/20261009024414_member_cleanup_unknown_discovery.sql'
DISCOVERY_TEST = REPO / 'tests/database/minkyu/member_cleanup_unknown_discovery.sql'
DISCOVERY_FUNCTION = 'public.read_member_cleanup_unknown_invocations(uuid,integer)'
DISCOVERY_OWNED = False


def discovery_fingerprints():
    paths = ((SQL114, 'sql114Sha256', SQL114_SHA),
             (MIGRATION, 'sql115Sha256', '74a0d3b2af807310f76dd77d8769f3177ca8f47cef2161ca4b44f194bbb73081'),
             (DISCOVERY_MIGRATION, 'sql118Sha256', '7d96eb284ff8d71685c6d3fe0379e7c3310a7dca89912bf855020920c3012e9c'),
             (DISCOVERY_TEST, 'discoveryTestSha256', 'aa7aa81a983b8b1b65a23b87189b0f184456366bc80f2dc4e4f89cc3ca30ad5f'))
    result = {}
    for path, key, expected in paths:
        value = hashlib.sha256(path.read_bytes()).hexdigest()
        assert value == expected, 'DISCOVERY_FROZEN_SOURCE_CHANGED'
        result[key] = value
    result['driverSha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    return result


def discovery_present(name):
    return bool(query(name, "select to_regprocedure('" + DISCOVERY_FUNCTION + "');").decode().strip())


def discovery_target(expected_id=None):
    assert NAME == DISCOVERY_NAME and NAME != SOURCE, 'DISCOVERY_TARGET_INVALID'
    info = json.loads(call(tls.DOCKER + ['inspect', NAME]))[0]
    assert info['Config']['Labels'].get('yumidang.owner') == 'minkyu' and info['HostConfig']['NetworkMode'] == 'none' and not info['Mounts'] and not info['HostConfig']['PortBindings'], 'DISCOVERY_OWNERSHIP_INVALID'
    assert expected_id is None or info['Id'] == expected_id, 'DISCOVERY_CLONE_REPLACED'
    return info


def discovery_closed(name, *, required=False):
    assert_closed(name, reconciler=required)
    present = discovery_present(name)
    assert present or not required, 'DISCOVERY_FUNCTION_MISSING'
    if present:
        for role in ('anon', 'authenticated', 'service_role', 'authenticator', 'yumidang_worker_queue'):
            assert query(name, "select has_function_privilege('" + role + "','" + DISCOVERY_FUNCTION + "','EXECUTE');").decode().strip() == 'f', 'DISCOVERY_EXEC_OPEN'
        assert query(name, "select not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid='" + DISCOVERY_FUNCTION + "'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE');").decode().strip() == 't', 'DISCOVERY_PUBLIC_EXEC_OPEN'


def discovery_existing_catalog(name):
    # 새 함수 하나만 제외한다. 기존 함수·테이블·열·constraint·trigger·schema ACL을 보존해야 한다.
    return json.loads(query(name, """select jsonb_build_object(
      'schemas',(select jsonb_agg(to_jsonb(n)order by n.oid)from pg_namespace n where n.nspname in('public','private','auth','storage')),
      'relations',(select jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.relam,c.relnamespace,c.relpersistence,c.reloptions,c.relispartition,c.relchecks,c.relhasindex)order by c.oid)from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')),
      'columns',(select jsonb_agg(to_jsonb(a)order by a.attrelid,a.attnum)from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')),
      'constraints',(select jsonb_agg(jsonb_build_array(k.oid,pg_get_constraintdef(k.oid))order by k.oid)from pg_constraint k join pg_namespace n on n.oid=k.connamespace where n.nspname in('public','private','auth','storage')),
      'triggers',(select jsonb_agg(jsonb_build_array(t.oid,pg_get_triggerdef(t.oid),t.tgenabled)order by t.oid)from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')),
      'functions',(select jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,pg_get_functiondef(p.oid))order by p.oid)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private','auth','storage')and p.prokind in('f','p')and p.oid is distinct from to_regprocedure('public.read_member_cleanup_unknown_invocations(uuid,integer)')));"""))


def discovery_prepare():
    global DISCOVERY_OWNED
    assert ROOT == DISCOVERY_ROOT and NAME == DISCOVERY_NAME and NAME != SOURCE
    assert not ROOT.exists(), 'EXISTING_MEMBER118_ARTIFACTS_PRESERVED'
    ROOT.mkdir(mode=0o700)
    frozen = discovery_fingerprints()
    existing = call(tls.DOCKER + ['ps', '-a', '--format', '{{.Names}}']).decode().splitlines()
    assert SOURCE in existing and NAME not in existing, 'SOURCE_OR_NEW_CLONE_INVALID'
    info = json.loads(call(tls.DOCKER + ['inspect', SOURCE]))[0]
    assert info['State']['Running'] and info['Config']['Labels'].get('yumidang.owner') == 'minkyu', 'SOURCE_RUNNING_OWNERSHIP_INVALID'
    assert query(SOURCE, "select to_regclass('private.event_invocation_references');").decode().strip(), 'SOURCE_SQL112_REQUIRED'
    assert not discovery_present(SOURCE), 'SOURCE_ALREADY_SQL118'
    for marker in MARKERS:
        assert not query(SOURCE, "select to_regclass('" + marker + "');").decode().strip(), 'SOURCE_ALREADY_NEW_MIGRATION'
    discovery_closed(SOURCE)
    before = normalized_snapshot(SOURCE)
    assert len(before['rows']) == 186, 'SOURCE_TABLE_COUNT_CHANGED'
    dump = call(tls.DOCKER + ['exec', SOURCE, 'pg_dump', '-U', recovery.BOOT, '-d', 'postgres', '-Fc'])
    role_dump = call(tls.DOCKER + ['exec', SOURCE, 'pg_dumpall', '-U', recovery.BOOT, '--roles-only', '--no-role-passwords']).decode()
    assert not re.search(r"\bPASSWORD\s+'", role_dump, re.I), 'ROLE_PASSWORD_MUST_NOT_BE_SAVED'
    save('source.dump', dump)
    save('roles.sql', role_dump.encode())
    save('source-normalized.json', json.dumps(before).encode())
    role_dump = re.sub(r' GRANTED BY [A-Za-z_][A-Za-z0-9_]*;', ';', role_dump)
    role_dump = '\n'.join(line for line in role_dump.splitlines() if not re.match(r'(CREATE|ALTER) ROLE ' + re.escape(recovery.BOOT) + r'(?: |;)', line))
    # 사전 검사에서 이 이름의 기존 clone이 없음을 확인한 경우만 실패 시 닫을 수 있다.
    DISCOVERY_OWNED = True
    restore(dump, role_dump)
    restored = normalized_snapshot(NAME)
    save('restored-before.json', json.dumps(restored).encode())
    assert restored == before, 'RESTORED_ROWS_CATALOG_ROLE_ACL_MISMATCH'
    assert normalized_snapshot(SOURCE) == before, 'READONLY_SOURCE_CHANGED_DURING_CLONE'
    discovery_closed(NAME)
    save('prepared.json', json.dumps({'source': SOURCE, 'clone': NAME, 'sourceChanged': False,
                                     'cloneId': discovery_target()['Id'],
                                     'sourceDumpSha256': hashlib.sha256(dump).hexdigest(), **frozen}).encode())
    print('MEMBER118_SQL112_CLONE_PREPARED_NOT_ACTIVATED')


def discovery_apply_test():
    global DISCOVERY_OWNED
    assert ROOT.is_dir() and ROOT.resolve() == ROOT and not(ROOT.stat().st_mode & 0o077), 'PRIVATE_DISCOVERY_REQUIRED'
    assert (ROOT / 'prepared.json').is_file() and not(ROOT / 'receipt.json').exists(), 'PREPARE_OR_RECEIPT_INVALID'
    frozen = discovery_fingerprints()
    prepared = json.loads((ROOT / 'prepared.json').read_text())
    assert prepared['clone'] == NAME and prepared['source'] == SOURCE and all(prepared[k] == v for k, v in frozen.items()), 'PREPARED_SOURCE_CHANGED'
    assert discovery_target(prepared['cloneId'])['State']['Running'], 'DISCOVERY_CLONE_NOT_RUNNING'
    DISCOVERY_OWNED = True
    source = json.loads((ROOT / 'source-normalized.json').read_text())
    assert normalized_snapshot(SOURCE) == source, 'SOURCE_CHANGED_SINCE_PREPARE'
    discovery_closed(SOURCE)
    discovery_closed(NAME)
    apply_one(SQL114, MARKERS[0], 'sql114', {'sha256': frozen['sql114Sha256']})
    apply_one(MIGRATION, MARKERS[1], 'sql115', {'sha256': frozen['sql115Sha256']})
    # 118은 테이블 marker가 없다. 정확한 signature와 같은 recipe의 적용 영수증을 함께 검사한다.
    marker_receipt = ROOT / 'sql118-applied.json'
    expected = {'sha256': frozen['sql118Sha256'], 'function': DISCOVERY_FUNCTION}
    if discovery_present(NAME):
        assert marker_receipt.is_file() and json.loads(marker_receipt.read_text()) == expected, 'SQL118_CHANGED_OR_UNRECORDED'
    else:
        assert not marker_receipt.exists(), 'SQL118_MARKER_MISSING'
        old_rows, old_roles, old_catalog = rows(NAME), roles(NAME), discovery_existing_catalog(NAME)
        query(NAME, DISCOVERY_MIGRATION.read_text())
        assert rows(NAME) == old_rows and roles(NAME) == old_roles, 'SQL118_CHANGED_EXISTING_ROWS_ROLES'
        assert discovery_existing_catalog(NAME) == old_catalog, 'SQL118_CHANGED_EXISTING_CATALOG'
        save(marker_receipt.name, json.dumps(expected).encode())
    discovery_closed(NAME, required=True)
    before = normalized_snapshot(NAME)
    assert all(before['rows'].get(k) == v for k, v in source['rows'].items()), 'MIGRATIONS_CHANGED_EXISTING_ROWS'
    body = DISCOVERY_TEST.read_text()
    assert re.search(r'(?m)^begin;$', body) and re.search(r'(?m)^rollback;\s*\Z', body), 'DISCOVERY_TRANSACTION_BOUNDARY_INVALID'
    assert not re.search(r'\btruncate\b', body, re.I), 'DISCOVERY_TRUNCATE_FORBIDDEN'
    query(NAME, body)
    after, source_after = normalized_snapshot(NAME), normalized_snapshot(SOURCE)
    save('clone-after-test.json', json.dumps(after).encode())
    save('source-after.json', json.dumps(source_after).encode())
    assert after == before, 'DISCOVERY_ROWS_CATALOG_ROLES_MEMBERSHIPS_NOT_ROLLED_BACK'
    assert source_after == source, 'READONLY_SOURCE_CHANGED'
    discovery_closed(NAME, required=True)
    discovery_closed(SOURCE)
    receipt = {'status': 'PASS', 'scope': 'ISOLATED_SQL118_DISCOVERY_DATABASE', **frozen,
               'source': SOURCE, 'clone': NAME, 'cloneId': prepared['cloneId'], 'sourceTableCount': len(source['rows']),
               'cloneTableCount': len(before['rows']), 'sourceDumpSha256': prepared['sourceDumpSha256'],
               'prerequisites': ['SQL112_SOURCE', 'SQL114', 'SQL115'], 'sql116117Required': False,
               'allTableRowsCatalogRolesAclMembershipsRolledBack': True,
               'sourceRowsCatalogRolesAclMembershipsUnchanged': True,
               'sql118ExistingRowsCatalogRolesUnchanged': True,
               'minimalIdsOnly': True, 'uuidExclusivePaginationSizes': [1, 2, 100],
               'completedTaskExpiredGlobalClaimZeroNoAckParentIncluded': True,
               'guardAndRoleRejections': True, 'defaultGuardAndExecClosed': True,
               'socketOnlyCronOffNetworkNone': True, 'externalCommunications': 0,
               'newGlobalLeaseDispatchDeleteAck': 0, 'productDiscoveryAndFinalization': 'NOT_RUN',
               'operatingChanged': False, 'cloneStopped': False}
    save('receipt.json', json.dumps(receipt, ensure_ascii=False, indent=2).encode())
    print(json.dumps(receipt, ensure_ascii=False))


def discovery_stop():
    prepared = ROOT / 'prepared.json'
    expected_id = json.loads(prepared.read_text())['cloneId'] if prepared.is_file() else None
    info = discovery_target(expected_id)
    if info['State']['Running']:
        call(tls.DOCKER + ['stop', '--time', '20', NAME])
    assert not json.loads(call(tls.DOCKER + ['inspect', NAME]))[0]['State']['Running'], 'DISCOVERY_STOP_FAILED'


def discovery_verify_closed():
    global DISCOVERY_OWNED
    assert ROOT.is_dir() and ROOT.resolve() == ROOT and not(ROOT.stat().st_mode & 0o077), 'PRIVATE_DISCOVERY_REQUIRED'
    assert not(ROOT / 'receipt-final.json').exists(), 'EXISTING_FINAL_RECEIPT_PRESERVED'
    receipt = json.loads((ROOT / 'receipt.json').read_text())
    assert receipt['status'] == 'PASS' and all(receipt[k] == v for k, v in discovery_fingerprints().items()), 'PASS_SOURCE_CHANGED'
    assert discovery_target(receipt['cloneId'])['State']['Running'], 'DISCOVERY_CLONE_NOT_RUNNING'
    DISCOVERY_OWNED = True
    assert normalized_snapshot(SOURCE) == json.loads((ROOT / 'source-after.json').read_text()), 'SOURCE_CHANGED_AFTER_PASS'
    assert normalized_snapshot(NAME) == json.loads((ROOT / 'clone-after-test.json').read_text()), 'CLONE_CHANGED_AFTER_PASS'
    discovery_closed(SOURCE)
    discovery_closed(NAME, required=True)
    discovery_stop()
    receipt.update(cloneStopped=True, originalReceiptSha256=hashlib.sha256((ROOT / 'receipt.json').read_bytes()).hexdigest())
    save('receipt-final.json', json.dumps(receipt, ensure_ascii=False, indent=2).encode())
    print(json.dumps(receipt, ensure_ascii=False))


def discovery_main(action):
    global ROOT, NAME
    ROOT, NAME = DISCOVERY_ROOT, DISCOVERY_NAME
    try:
        {'--prepare': discovery_prepare, '--apply-test': discovery_apply_test,
         '--verify-closed': discovery_verify_closed}[action]()
    except Exception as error:
        if ROOT.is_dir() and ROOT.resolve() == ROOT and not(ROOT.stat().st_mode & 0o077):
            save('failure-' + str(uuid.uuid4()) + '.log', repr(error).encode())
            if DISCOVERY_OWNED:
                try:
                    discovery_stop()
                except Exception as close_error:
                    save('failure-close-' + str(uuid.uuid4()) + '.log', repr(close_error).encode())
        raise SystemExit('MEMBER118_FAILED_PRIVATE_EVIDENCE_PRESERVED') from None


if __name__ == '__main__':
    if sys.argv[1:2] == ['--discovery']:
        if len(sys.argv[1:]) != 2 or sys.argv[2] not in ('--prepare', '--apply-test', '--verify-closed'):
            raise SystemExit('INVALID_DISCOVERY_ARGUMENTS')
        discovery_main(sys.argv[2])
        raise SystemExit(0)
    try:
        if sys.argv[1:] == ['--prepare']:
            prepare()
        elif sys.argv[1:] == ['--apply-test']:
            apply_test()
        elif sys.argv[1:] == ['--verify-closed']:
            verify_closed()
        else:
            raise SystemExit('INVALID_ARGUMENTS')
    except Exception as error:
        if ROOT.is_dir() and ROOT.resolve() == ROOT and not (ROOT.stat().st_mode & 0o077):
            save('failure-' + str(uuid.uuid4()) + '.log', repr(error).encode())
        raise SystemExit('MEMBER115_FAILED_PRIVATE_EVIDENCE_PRESERVED') from None
