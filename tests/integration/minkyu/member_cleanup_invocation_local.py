"""SQL110 격리 clone 회귀. 원 SQL109 DB는 읽기만 하고 합성 변경은 rollback한다."""
import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

import product_connection_restore108_local as recovery
import queue_tls_environment as tls

ROOT = Path('/private/tmp/yumidang-member110-20261009-v1')
NAME = 'yumidang-minkyu-member110-20261009-v1'
SOURCE = 'yumidang-minkyu-invocation109-20261009-v1'
REPO = Path(__file__).resolve().parents[3]
MIGRATION = REPO / 'backend/supabase/migrations/20261009011000_member_cleanup_invocation.sql'
TEST = REPO / 'tests/database/minkyu/member_cleanup_invocation.sql'
SQL109 = REPO / 'backend/supabase/migrations/20261009010900_worker_invocation_audit.sql'
SQL109_SHA = '5de1f86e7937cef02f2f7dd3a2691afe0663effdbfa49a2af1490d6221836288'
MARKER = 'public.claim_member_cleanup_task_sql109(uuid)'
FUNCTIONS = (
    'public.prepare_queue_invocation(uuid,uuid,text,integer,integer)',
    'public.claim_queue_invocation_dispatch(uuid,uuid,text,integer,integer)',
    'public.get_queue_invocation(uuid)', 'public.complete_queue_invocation(uuid)',
    'public.mark_queue_invocation_unknown(uuid)',
    'public.claim_member_cleanup_task(uuid)',
    'public.begin_member_cleanup_delete(uuid,uuid,uuid,uuid)',
    'public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)',
    'public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)',
)


def save(name, data):
    with os.fdopen(os.open(ROOT / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        stream.write(data)


def call(args, data=None):
    try:
        result = subprocess.run(args, input=data, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired as error:
        save('failure-' + str(uuid.uuid4()) + '.log', (error.stdout or b'') + (error.stderr or b''))
        raise RuntimeError('MEMBER110_TIMEOUT_PRIVATE_EVIDENCE_PRESERVED') from None
    if result.returncode:
        save('failure-' + str(uuid.uuid4()) + '.log', result.stdout + result.stderr)
        raise RuntimeError('MEMBER110_FAILED_PRIVATE_EVIDENCE_PRESERVED')
    return result.stdout


def query(name, statement):
    return call(tls.DOCKER + ['exec', '-i', name, 'psql', '-XqAt', '-U', recovery.BOOT,
                             '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], statement.encode())


def rows(name):
    return recovery.read_database_row_digests(lambda sql: query(name, sql))


def hashes():
    assert hashlib.sha256(SQL109.read_bytes()).hexdigest() == SQL109_SHA, 'SQL109_FROZEN_SOURCE_CHANGED'
    return {'migrationSha256': hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),
            'testSha256': hashlib.sha256(TEST.read_bytes()).hexdigest()}


def assert_closed(name):
    recovery.assert_closed(lambda sql: query(name, sql))
    assert query(name, 'select not enabled from private.worker_invocation_control where singleton;').decode().strip() == 't', 'INVOCATION_DEFAULT_OPEN'
    for signature in FUNCTIONS:
        for role in ('anon', 'authenticated', 'service_role', 'yumidang_worker_queue'):
            statement = "select has_function_privilege('" + role + "','" + signature + "','EXECUTE');"
            assert query(name, statement).decode().strip() == 'f', 'EXECUTE_NOT_CLOSED'
    assert query(name, 'show cron.launch_active_jobs;').decode().strip() == 'off', 'CRON_NOT_DISABLED'
    assert query(name, 'show listen_addresses;').decode().strip() == '', 'UNEXPECTED_TCP_LISTENER'


def restore(dump_path, roles):
    # 공유 helper의 실패도 이 실행의 private600 증거 디렉터리에 보존한다.
    original_call = tls.call
    tls.call = call
    try:
        recovery.restore(NAME, dump_path, roles)
    finally:
        tls.call = original_call


def prepare():
    assert not ROOT.exists(), 'EXISTING_MEMBER110_PRESERVED'
    ROOT.mkdir(mode=0o700)
    frozen = hashes()
    existing = call(tls.DOCKER + ['ps', '-a', '--format', '{{.Names}}']).decode().splitlines()
    assert SOURCE in existing and NAME not in existing, 'SOURCE_OR_NEW_CLONE_INVALID'
    labels = json.loads(call(tls.DOCKER + ['inspect', '--format', '{{json .Config.Labels}}', SOURCE]))
    assert labels.get('yumidang.owner') == 'minkyu', 'SOURCE_OWNERSHIP_MISMATCH'
    assert not query(SOURCE, "select to_regprocedure('" + MARKER + "');").decode().strip(), 'SOURCE_ALREADY_SQL110'
    assert_closed(SOURCE)
    before = rows(SOURCE)
    dump = call(tls.DOCKER + ['exec', SOURCE, 'pg_dump', '-U', recovery.BOOT, '-d', 'postgres', '-Fc'])
    roles = call(tls.DOCKER + ['exec', SOURCE, 'pg_dumpall', '-U', recovery.BOOT,
                              '--roles-only', '--no-role-passwords']).decode()
    assert not re.search(r"\bPASSWORD\s+'", roles, re.I), 'ROLE_PASSWORD_MUST_NOT_BE_SAVED'
    save('source.dump', dump)
    save('roles.sql', roles.encode())
    save('source-rows.json', json.dumps(before).encode())
    roles = re.sub(r' GRANTED BY [A-Za-z_][A-Za-z0-9_]*;', ';', roles)
    roles = '\n'.join(line for line in roles.splitlines()
                      if not re.match(r'(CREATE|ALTER) ROLE ' + re.escape(recovery.BOOT) + r'(?: |;)', line))
    restore(ROOT / 'source.dump', roles)
    assert rows(NAME) == before and rows(SOURCE) == before, 'CLONE_SOURCE_ROWS_CHANGED'
    assert_closed(NAME)
    save('prepared.json', json.dumps({'sourceChanged': False, 'clone': NAME,
                                      'sourceDumpSha256': hashlib.sha256(dump).hexdigest(), **frozen}).encode())
    print('MEMBER110_CLONE_PREPARED_NOT_ACTIVATED')


def apply_test():
    assert ROOT.is_dir() and ROOT.resolve() == ROOT and not (ROOT.stat().st_mode & 0o077), 'PRIVATE_RECOVERY_REQUIRED'
    assert (ROOT / 'prepared.json').is_file() and not (ROOT / 'receipt.json').exists(), 'PREPARE_OR_RECEIPT_INVALID'
    frozen = hashes()
    prepared = json.loads((ROOT / 'prepared.json').read_text())
    assert prepared['clone'] == NAME and all(prepared[key] == value for key, value in frozen.items()), 'PREPARED_SOURCE_CHANGED'
    before_source = rows(SOURCE)
    assert before_source == json.loads((ROOT / 'source-rows.json').read_text()), 'SOURCE_CHANGED_SINCE_PREPARE'
    assert_closed(SOURCE)
    migration = MIGRATION.read_bytes()
    test = TEST.read_bytes()
    present = query(NAME, "select to_regprocedure('" + MARKER + "');").decode().strip()
    if present:
        assert (ROOT / 'applied.json').is_file(), 'UNRECORDED_APPLY_NO_RETRY'
        assert json.loads((ROOT / 'applied.json').read_text()) == frozen, 'APPLIED_SOURCE_CHANGED'
    else:
        assert not (ROOT / 'applied.json').exists(), 'RECORDED_APPLY_MARKER_MISSING'
        query(NAME, migration.decode())
        save('applied.json', json.dumps(frozen).encode())
    before = rows(NAME)
    assert all(before.get(key) == value for key, value in before_source.items()), 'CLONE_EXISTING_ROWS_CHANGED'
    assert_closed(NAME)
    # 원본 auth UUID 충돌을 검사한다. 관계 seed를 지우거나 실제 회원을 대체하지 않는다.
    fixtures = "array(select('d1100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,3)n)"
    assert query(NAME, 'select not exists(select 1 from auth.users where id=any(' + fixtures + '));').decode().strip() == 't', 'SYNTHETIC_AUTH_UUID_COLLISION'
    body, removed = re.subn(r'(?m)^begin;\n', '', test.decode(), count=1)
    assert removed == 1 and re.search(r'(?m)^rollback;\s*\Z', body), 'SCRATCH_TRANSACTION_BOUNDARY_INVALID'
    prelude = ('begin;truncate private.worker_jobs,private.worker_runtime_intents,private.worker_runtime_results,'
               'private.worker_runtime_job_slots,private.worker_invocations,private.member_cleanup_tasks,'
               'private.member_cleanup_dispatches cascade;\n')
    query(NAME, prelude + body)
    assert rows(NAME) == before and rows(SOURCE) == before_source, 'SCRATCH_OR_SOURCE_MUTATED'
    assert_closed(NAME)
    assert_closed(SOURCE)
    receipt = {'status': 'PASS', 'scope': 'ISOLATED_SQL110_DATABASE', **frozen,
               'allTableRowsRolledBack': True, 'actualTaskJobBinding': True,
               'sameJobReclaimNoExtraSlotOrEffectCopy': True, 'sharedUniqueTwentyAndBatchTen': True,
               'originalDispatchAckBinding': True, 'unknownRedispatchBlocked': True,
               'existingReviewDelegate': True, 'globalLeaseNotRenewed': True,
               'sourceDatabaseChanged': False, 'operatingChanged': False,
               'physicalStorageAndAuthDelete': 'NOT_RUN', 'realMemberAndProductCli': 'NOT_RUN',
               'trackedUnknownGetOnlyReconcile': 'NOT_IMPLEMENTED'}
    save('receipt.json', json.dumps(receipt, ensure_ascii=False, indent=2).encode())
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--prepare']:
            prepare()
        elif sys.argv[1:] == ['--apply-test']:
            apply_test()
        else:
            raise SystemExit('INVALID_ARGUMENTS')
    except Exception as error:
        if ROOT.is_dir() and ROOT.resolve() == ROOT and not (ROOT.stat().st_mode & 0o077):
            save('failure-' + str(uuid.uuid4()) + '.log', repr(error).encode())
        raise SystemExit('MEMBER110_FAILED_PRIVATE_EVIDENCE_PRESERVED') from None
