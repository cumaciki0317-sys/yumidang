"""SQL112 격리 DB 회귀. SQL110 원본은 읽기만 하고 합성 테스트는 rollback한다."""
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

VERSIONS = [arg for arg in sys.argv[1:] if arg in ('--revision-v2', '--revision-v3')]
if len(VERSIONS) > 1:
    raise SystemExit('ONE_REVISION_REQUIRED')
RUN_VERSION = int(VERSIONS[0][-1]) if VERSIONS else 1
ROOT = Path(f'/private/tmp/yumidang-event112-20261009-v{RUN_VERSION}')
NAME = f'yumidang-minkyu-event112-20261009-v{RUN_VERSION}'
SOURCE = 'yumidang-minkyu-member110-20261009-v1'
REPO = Path(__file__).resolve().parents[3]
MIGRATION = REPO / 'backend/supabase/migrations/20261009011200_event_invocation_audit.sql'
TEST = REPO / 'tests/database/minkyu/event_invocation_audit.sql'


def save(name, data):
    with os.fdopen(os.open(ROOT / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        stream.write(data)


def call(args, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=120)
    if result.returncode:
        save('failure-' + str(uuid.uuid4()) + '.log', result.stdout + result.stderr)
        raise RuntimeError('EVENT112_FAILED_PRIVATE_EVIDENCE_PRESERVED')
    return result.stdout


def query(name, statement):
    return call(tls.DOCKER + ['exec', '-i', name, 'psql', '-XqAt', '-U', recovery.BOOT,
                             '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], statement.encode())


def rows(name):
    return recovery.read_database_row_digests(lambda sql: query(name, sql))


def prepare():
    assert not ROOT.exists(), 'EXISTING_EVENT112_PRESERVED'
    ROOT.mkdir(mode=0o700)
    existing = call(tls.DOCKER + ['ps', '-a', '--format', '{{.Names}}']).decode().splitlines()
    assert SOURCE in existing and NAME not in existing, 'SOURCE_OR_NEW_CLONE_INVALID'
    before = rows(SOURCE)
    dump = call(tls.DOCKER + ['exec', SOURCE, 'pg_dump', '-U', recovery.BOOT, '-d', 'postgres', '-Fc'])
    roles = call(tls.DOCKER + ['exec', SOURCE, 'pg_dumpall', '-U', recovery.BOOT,
                              '--roles-only', '--no-role-passwords']).decode()
    save('source.dump', dump)
    save('roles.sql', roles.encode())
    save('source-rows.json', json.dumps(before).encode())
    roles = re.sub(r' GRANTED BY [A-Za-z_][A-Za-z0-9_]*;', ';', roles)
    roles = '\n'.join(line for line in roles.splitlines()
                      if not re.match(r'(CREATE|ALTER) ROLE ' + recovery.BOOT + r'(?: |;)', line))
    recovery.restore(NAME, ROOT / 'source.dump', roles)
    assert rows(NAME) == before and rows(SOURCE) == before, 'CLONE_SOURCE_ROWS_CHANGED'
    save('prepared.json', json.dumps({'sourceChanged': False, 'clone': NAME,
                                      'sourceDumpSha256': hashlib.sha256(dump).hexdigest()}).encode())
    print('EVENT112_CLONE_PREPARED_NOT_ACTIVATED')


def apply_test():
    assert (ROOT / 'prepared.json').is_file() and not (ROOT / 'receipt.json').exists(), 'PREPARE_OR_RECEIPT_INVALID'
    before_source = rows(SOURCE)
    migration = MIGRATION.read_bytes()
    test = TEST.read_bytes()
    sha = hashlib.sha256(migration).hexdigest()
    prerequisite = REPO / 'backend/supabase/migrations/20261009011100_event_collection_lane.sql'
    assert hashlib.sha256(prerequisite.read_bytes()).hexdigest() == 'f9e6026400a3a7b8d6e3a0c929f9c13e65cc41ff991180fd4fb4f17e921cc34c', 'SQL111_SOURCE_CHANGED'
    if not query(NAME, "select to_regclass('private.event_collection_control');").decode().strip():
        query(NAME, prerequisite.read_text())
        save('prerequisite-applied.json', json.dumps({'sql111': 'APPLIED_DEFAULT_CLOSED'}).encode())
    else:
        assert (ROOT / 'prerequisite-applied.json').is_file(), 'UNRECORDED_PREREQUISITE_NO_RETRY'
    present = query(NAME, "select to_regclass('private.event_invocation_references');").decode().strip()
    if present:
        assert (ROOT / 'applied.json').is_file(), 'UNRECORDED_APPLY_NO_RETRY'
        assert json.loads((ROOT / 'applied.json').read_text())['sha256'] == sha, 'APPLIED_SOURCE_CHANGED'
    else:
        query(NAME, migration.decode())
        save('applied.json', json.dumps({'sha256': sha, 'operatingChanged': False}).encode())
    before = rows(NAME)
    assert all(before.get(key) == value for key, value in before_source.items()), 'CLONE_EXISTING_ROWS_CHANGED'
    assert query(NAME, 'select enabled from private.event_collection_control;').decode().strip() == 'f', 'DEFAULT_OPEN'
    prelude = ('begin;truncate private.worker_jobs,private.worker_runtime_intents,private.worker_runtime_results,'
               'private.worker_runtime_job_slots,private.member_cleanup_dispatches,private.worker_invocations,private.source_events cascade;\n')
    query(NAME, prelude + re.sub(r'(?m)^begin;\n', '', test.decode(), count=1))
    assert rows(NAME) == before and rows(SOURCE) == before_source, 'SCRATCH_OR_SOURCE_MUTATED'
    recovery.assert_closed(lambda sql: query(NAME, sql))
    receipt = {'status': 'PASS', 'scope': 'ISOLATED_SQL112_DATABASE', 'migrationSha256': sha,
               'testSha256': hashlib.sha256(test).hexdigest(), 'allTableRowsRolledBack': True,
               'exactDispatchAndObservedReferenceBinding': True, 'realJobUniqueTwentySlots': True,
               'sourceRevisionAndAtomicDeadline': True, 'rankingHeld': True, 'seoulHeld': True,
               'sourceDatabaseChanged': False, 'operatingChanged': False,
               'realProviderAndProductCli': 'NOT_RUN', 'eventInvocationAudit': 'PASS_DATABASE_ONLY'}
    save('receipt.json', json.dumps(receipt, ensure_ascii=False, indent=2).encode())
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == '__main__':
    args = sys.argv[1:]
    for revision in VERSIONS:
        args.remove(revision)
    if args == ['--prepare']:
        prepare()
    elif args == ['--apply-test']:
        apply_test()
    else:
        raise SystemExit('INVALID_ARGUMENTS')
