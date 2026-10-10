"""SQL116 격리 DB 회귀. SQL112 원본은 읽기만 하고 합성 테스트는 rollback한다."""
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
ROOT = Path(f'/private/tmp/yumidang-content116-20261009-v{RUN_VERSION}')
NAME = f'yumidang-minkyu-content116-20261009-v{RUN_VERSION}'
SOURCE = 'yumidang-minkyu-event112-20261009-v1'
REPO = Path(__file__).resolve().parents[3]
MIGRATION = REPO / 'backend/supabase/migrations/20261009011600_content_inspection_tickets.sql'
TEST = REPO / 'tests/database/minkyu/content_inspection_tickets.sql'


def save(name, data):
    with os.fdopen(os.open(ROOT / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        stream.write(data)


def call(args, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=120)
    if result.returncode:
        save('failure-' + str(uuid.uuid4()) + '.log', result.stdout + result.stderr)
        raise RuntimeError('CONTENT116_FAILED_PRIVATE_EVIDENCE_PRESERVED')
    return result.stdout


def query(name, statement):
    return call(tls.DOCKER + ['exec', '-i', name, 'psql', '-XqAt', '-U', recovery.BOOT,
                             '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], statement.encode())


def rows(name):
    return recovery.read_database_row_digests(lambda sql: query(name, sql))


def prepare():
    assert not ROOT.exists(), 'EXISTING_CONTENT116_PRESERVED'
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
    print('CONTENT116_CLONE_PREPARED_NOT_ACTIVATED')


def apply_test():
    assert (ROOT / 'prepared.json').is_file() and not (ROOT / 'receipt.json').exists(), 'PREPARE_OR_RECEIPT_INVALID'
    before_source = rows(SOURCE)
    migration = MIGRATION.read_bytes()
    test = TEST.read_bytes()
    sha = hashlib.sha256(migration).hexdigest()
    present = query(NAME, "select to_regclass('private.content_inspection_tickets');").decode().strip()
    if present:
        assert (ROOT / 'applied.json').is_file(), 'UNRECORDED_APPLY_NO_RETRY'
        assert json.loads((ROOT / 'applied.json').read_text())['sha256'] == sha, 'APPLIED_SOURCE_CHANGED'
    else:
        query(NAME, migration.decode())
        save('applied.json', json.dumps({'sha256': sha, 'operatingChanged': False}).encode())
    before = rows(NAME)
    assert all(before.get(key) == value for key, value in before_source.items()), 'CLONE_EXISTING_ROWS_CHANGED'
    assert query(NAME, 'select enabled from private.content_inspection_control;').decode().strip() == 'f', 'DEFAULT_OPEN'
    query(NAME, test.decode())
    assert rows(NAME) == before and rows(SOURCE) == before_source, 'SCRATCH_OR_SOURCE_MUTATED'
    recovery.assert_closed(lambda sql: query(NAME, sql))
    receipt = {'status': 'PASS', 'scope': 'ISOLATED_SQL116_DATABASE', 'migrationSha256': sha,
               'testSha256': hashlib.sha256(test).hexdigest(), 'allTableRowsRolledBack': True,
               'directWriteTicketGate': 'PASS_DATABASE_ONLY', 'atomicConsumptionAndReplay': True,
               'sourceDatabaseChanged': False, 'operatingChanged': False,
               'classifierQualityAndProductHttp': 'NOT_RUN', 'enabledByDefault': False}
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
