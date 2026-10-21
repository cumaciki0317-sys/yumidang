#!/usr/bin/env python3
"""현재121 전용 DB 복원 연결. 기본 오프라인, 검토한 graph 없이는 실행하지 않는다.

Storage 원본 복원/삭제 재적용/제품 ACK/운영 복원은 이 도구의 범위가 아니다.
기존119 실행기는 호출하지 않고 그 원 상태 수집·복원 비교 함수를 재사용한다.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import signal
import tempfile
import time
import uuid
from types import SimpleNamespace

import run_database_tests as guards
import verify_restoration_readiness as secure
from prepare_migrations import inspect_migrations

SCOPE = 'CURRENT121_SYNTHETIC_DATABASE_ONLY_RESTORE'
RECOVERY = 'tests/integration/minkyu/product_connection_restore108_local.py'
HELPER = 'tests/integration/minkyu/member_cleanup_reconcile_local.py'
FILES = frozenset({RECOVERY, HELPER, 'tests/integration/minkyu/queue_tls_environment.py',
    'tools/local/prepare_database_restore.py', 'tools/local/run_database_tests.py',
    'tools/local/verify_restoration_readiness.py', 'tools/local/prepare_database.py',
    'tools/local/prepare_migrations.py', 'tools/local/prepare_current_policy.py',
    'tools/local/prepare_edge.py', 'tools/local/observe_isolated.py'})
SHA = re.compile(r'[a-f0-9]{64}\Z')
ID = SHA
PROJECT = re.compile(r'jonghyun-backend100-[a-f0-9]{8}\Z')
UNKNOWN_SQL = "select count(*) from private.ai_account_budget_reservations where unknown_at is not null and settled_at is null;"
HISTORY_SQL = 'select coalesce(json_agg(json_build_array(version,name) order by version),\'[]\') from supabase_migrations.schema_migrations;'
DATABASE_LOCALE_SQL = """select json_build_object('encoding',pg_encoding_to_char(encoding),
 'collate',datcollate,'ctype',datctype,'provider',datlocprovider,'locale',datlocale,
 'version',datcollversion,'actualVersion',pg_database_collation_actual_version(oid),
 'icuRules',daticurules) from pg_database where datname=current_database();"""
LOCALE_KEYS = {'encoding', 'collate', 'ctype', 'provider', 'locale', 'version', 'actualVersion', 'icuRules'}
LOCALE_OBSERVATIONS = {
    'capture_source_before': 'capture-source-before-locale-raw.json',
    'capture_source_final': 'capture-source-final-locale-raw.json',
    'restore_source_before': 'source-before-locale-raw.json',
    'restore_source_final': 'source-after-locale-raw.json',
    'target_initial': 'target-initial-locale-raw.json',
    'target_archive': 'target-restored-locale-raw.json',
    'target_final': 'target-final-locale-raw.json',
}
PACKET_FILES = {'source-state.json', 'source.dump', 'roles.sql', 'history.json',
                'archive-metadata.json', 'database-locale.json'}
FAILURE_CODES = {'DATABASE_LOCALE_UNSUPPORTED', 'DATABASE_LOCALE_CHANGED',
    'TARGET_START_IDENTITY_CHANGED',
    'DATABASE_ICU_RULES_UNSUPPORTED', 'DATABASE_COLLATION_VERSION_MISMATCH',
    'SOURCE_IDENTITY_CHANGED', 'TARGET_IDENTITY_CHANGED', 'TARGET_CONFIGURATION_CHANGED',
    'IMAGE_DECLARED_VOLUME_REFUSED', 'TARGET_NOT_READY_NO_RETRY_RESTORE',
    'MEMORY_LOW_NO_NEW_WORK', 'DOCKER_COMMAND_FAILED', 'DOCKER_COMMAND_TIMEOUT_NO_RETRY',
    'SOURCE_FILES_CHANGED', 'ARCHIVE_CHANGED', 'ORIGINAL_ROLES_REQUIRED', 'TARGET_NOT_EMPTY'}
RESTORE_STAGES = {'source_preflight', 'target_image_preflight', 'database_locale_preflight',
                  'target_create', 'target_locale_preflight', 'roles_restore', 'archive_restore',
                  'target_compare', 'finalization', 'complete'}
SOURCE_KEYS = {'preparedRoot', 'preservedPins', 'context', 'host', 'project', 'id', 'name',
               'image', 'configSha256', 'hostConfigSha256', 'mountsSha256', 'unknownCount', 'fixtureReceipt',
               'startedAt', 'restartCount', 'phaseReceipt'}
GRAPH_KEYS = {'version', 'scope', 'phase', 'reviewedByRoot', 'dockerSlotReady', 'repo',
              'sourceHead', 'sourceFiles', 'migrations', 'migrationManifestSha256', 'source',
              'targetProject', 'baseline', 'minimumAvailableMiB', 'activationAllowed',
              'fullRestore', 'storage39', 'productDeleteAck'}


class RestoreError(Exception):
    """비밀·원문 경로를 포함하지 않는 고정 오류."""


def require(ok, code):
    if not ok:
        raise RestoreError(code)


def failure_code(error):
    # SQL/오류 원문을 영수증으로 복사하지 않는다. 검토한 고정 코드만 공개한다.
    return str(error) if type(error) is RestoreError and str(error) in FAILURE_CODES else 'RESTORE_FAILED'


def stage_code(stage):
    return stage if type(stage) is str and stage in RESTORE_STAGES else 'restore'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                      allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def resource_sha(value):
    # 기존 resource guard의 JSON escaping과 정확히 같아야 한다(한글 label/env 포함).
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode())


def parse(raw):
    return guards.preserved_json(raw)


def read_pin(path, expected, *, repo=None, limit=64 * 1024**2):
    require(type(expected) is str and SHA.fullmatch(expected), 'EXPECTED_SHA_REQUIRED')
    raw = secure.read_bytes(Path(path), repo=repo, limit=limit)
    require(sha(raw) == expected, 'INPUT_CHANGED')
    return raw


def head(repo):
    p = subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'], capture_output=True,
                       timeout=10, env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
    value = p.stdout.decode().strip()
    require(p.returncode == 0 and re.fullmatch('[a-f0-9]{40}', value), 'SOURCE_HEAD_REQUIRED')
    return value


def current_manifest(repo):
    """개수만으로 현재121을 승인하지 않는다. 실제 reviewed map와 모든 SQL 바이트를 대조한다."""
    repo = Path(repo)
    reviewed = {}
    for name, constant in [('tools/local/prepare_edge.py', 'GATEWAY_REVIEWED_MIGRATIONS'),
                           ('tools/local/prepare_current_policy.py', 'CURRENT_POLICY_REVIEWED')]:
        mapping = secure.literal(secure.read_bytes(repo / name, repo=repo), constant)
        require(type(mapping) is dict and not set(mapping) & set(reviewed), 'REVIEWED_DUPLICATE')
        reviewed.update(mapping)
    require(len(reviewed) == 121 and sha(canonical(reviewed)) == secure.CURRENT_MANIFEST,
            'CURRENT121_REVIEW_REQUIRED')
    migrations = inspect_migrations(repo)['migrations']
    require(len(migrations) == 121 and [x['path'] for x in migrations] == sorted(reviewed),
            'CURRENT121_ORDER_REQUIRED')
    for entry in migrations:
        require(entry['sha256'] == reviewed[entry['path']] and
                sha(secure.read_bytes(repo / entry['path'], repo=repo)) == entry['sha256'],
                'CURRENT121_SQL_CHANGED')
    return migrations


def source_files(repo):
    return {name: sha(secure.read_bytes(Path(repo) / name, repo=Path(repo)))
            for name in sorted(FILES)}


def synthetic_seed_sql(ledger, reservation_ids, day, sequence):
    """root의 새 source 전용 driver용 SQL 값. 이 모듈은 source에 실행하지 않는다."""
    from datetime import date
    require(type(ledger) is str and re.fullmatch('restore121-[a-f0-9]{32}', ledger), 'SEED_LEDGER')
    require(type(reservation_ids) is list and len(reservation_ids) == 2 and
            len(set(reservation_ids)) == 2 and all(str(uuid.UUID(x)) == x for x in reservation_ids), 'SEED_IDS')
    require(date.fromisoformat(day).isoformat() == day and
            re.fullmatch('restore121_seq_[a-f0-9]{8}', sequence), 'SEED_DAY_SEQUENCE')
    values = ','.join("('" + x + "'::uuid,'" + ledger + "','synthetic-restore','intent',1)" for x in reservation_ids)
    receipts = ','.join("('" + x + "'::uuid,'" + ledger + "','minkyu',date '" + day + "',1,clock_timestamp())" for x in reservation_ids)
    return ("begin;\ninsert into private.ai_budget_ledgers(ledger_id,unit_limit,call_limit,reserved_units,open_calls) values('" + ledger + "',1000,100,2,2);\n"
        "insert into private.ai_global_daily_budget(kst_day,reserved_units) values(date '" + day + "',2);\n"
        "insert into private.ai_account_daily_budget(account_id,kst_day,reserved_units) values('minkyu',date '" + day + "',2);\n"
        "insert into private.ai_budget_reservations(id,ledger_id,provider_id,task,units) values" + values + ";\n"
        "insert into private.ai_account_budget_reservations(reservation_id,ledger_id,account_id,account_day,reserved_units,unknown_at) values" + receipts + ";\n"
        'create sequence private.' + sequence + ' start 41;\nselect nextval(\'private.' + sequence + "');\ncommit;\n")


def verify_fixture(source):
    ref = source['fixtureReceipt']
    require(type(ref) is dict and set(ref) == {'path', 'sha256'}, 'FIXTURE_RECEIPT_REQUIRED')
    value = parse(read_pin(ref['path'], ref['sha256']))
    require(type(value) is dict and set(value) == {'kind', 'sourceId', 'ledgerId', 'reservationIds',
        'day', 'sequence', 'seedSqlSha256', 'beforeUnknownCount', 'afterUnknownCount', 'productTransmission',
        'positiveReceiptSha256'},
        'EXACT_FIXTURE_RECEIPT')
    require(value['kind'] == 'SYNTHETIC_DB_SEED' and value['sourceId'] == source['id']
            and type(value['beforeUnknownCount']) is int and value['beforeUnknownCount'] == 0
            and type(value['afterUnknownCount']) is int and value['afterUnknownCount'] == 2
            and value['productTransmission'] == 'NOT_RUN' and value['seedSqlSha256'] == sha(
                synthetic_seed_sql(value['ledgerId'], value['reservationIds'], value['day'], value['sequence']).encode()),
            'SYNTHETIC_SEED_ONLY')
    require(value['positiveReceiptSha256'] == source['phaseReceipt']['sha256'], 'SEED_POSITIVE_ORDER_BINDING')
    return value


def verify_positive_phase(source, source_head):
    """이번 새 DB의 positive 종료 원자료를 연결한다. 같은 scopeId만으로 연결하지 않는다."""
    ref = source['phaseReceipt']
    require(type(ref) is dict and set(ref) == {'path', 'sha256'}, 'POSITIVE_PHASE_REFERENCE')
    path = Path(ref['path']); root = Path(source['preparedRoot'])
    require(path.is_relative_to(root), 'POSITIVE_SOURCE_ROOT')
    value = parse(read_pin(path, ref['sha256']))
    require(value['scope'] == 'SIGNED_POSITIVE_DISCOVERY_ONLY' and value['status'] == 'PASS'
        and value['sourceHead'] == source_head and value['fixedFailures'] == []
        and value['database'] == {'id': source['id'], 'project': source['project'], 'preparedRoot': str(root)}
        and value['root'] == str(root) and value['ownedChildClosed'] is True
        and value['modelScope'] == 'SYNTHETIC_IN_MEMORY_ONLY' and value['actualNaver'] == 'NOT_RUN'
        and value['actualProviderQuality'] == 'NOT_RUN' and value['priorNegativeCasesReplayed'] is False
        and value['noReplay'] is True, 'POSITIVE_PHASE_NOT_FINAL')
    require(all(type(value[k]) is str and SHA.fullmatch(value[k]) for k in
        ('sourcePinsSha256', 'reviewSha256', 'originalAuth6ReceiptSha256', 'originalBindingSha256')),
        'POSITIVE_PROVENANCE_HASH')
    cleanup = value['fixtureCleanup']; original = value['originalRowsPreserved']; unknown = value['unknownPreserved']
    require(cleanup['status'] == original['status'] == unknown['status'] == 'PASS'
        and value['auth6RowsRetained'] == value['budgetRowsRetained'] == 'PASS'
        and cleanup['finalSnapshotSha256'] == original['finalSnapshotSha256']
        and cleanup['beforeSnapshotSha256'] == original['beforeSnapshotSha256']
        and cleanup['baselineReservationsSha256'] == unknown['baselineReservationsSha256']
        and cleanup['finalReservationsSha256'] == unknown['finalReservationsSha256'],
        'POSITIVE_CLEANUP_NOT_PROVEN')
    for target, expected in [(Path(cleanup['finalSnapshotPath']), cleanup['finalSnapshotSha256']),
                             (path.parent / 'before-private.json', original['beforeSnapshotSha256']),
                             (Path(value['actualPhaseReceipt']['path']), value['actualPhaseReceipt']['sha256']),
                             (root / 'signed-ai-binding-private.json', value['originalBindingSha256'])]:
        require(target.is_relative_to(root), 'POSITIVE_EVIDENCE_ROOT')
        read_pin(target, expected)
    return value


def new_graph(repo, source, target_project):
    """실제 source identity를 root가 검토할 초안. 생성 자체는 실행 승인이 아니다."""
    repo = Path(repo)
    return {'version': 1, 'scope': SCOPE, 'phase': 'CAPTURE', 'reviewedByRoot': False,
            'dockerSlotReady': False, 'repo': str(repo), 'sourceHead': head(repo),
            'sourceFiles': source_files(repo), 'migrations': current_manifest(repo),
            'migrationManifestSha256': secure.CURRENT_MANIFEST, 'source': source,
            'targetProject': target_project, 'baseline': None, 'minimumAvailableMiB': 1024,
            'activationAllowed': False, 'fullRestore': False, 'storage39': 'UNRESOLVED',
            'productDeleteAck': 'NOT_RUN'}


def verify_graph(graph, *, execution=False):
    require(type(graph) is dict and set(graph) == GRAPH_KEYS, 'EXACT_GRAPH_REQUIRED')
    require(type(graph['version']) is int and graph['version'] == 1 and graph['scope'] == SCOPE
            and graph['phase'] in ('CAPTURE', 'RESTORE') and graph['activationAllowed'] is False
            and graph['fullRestore'] is False and graph['storage39'] == 'UNRESOLVED'
            and graph['productDeleteAck'] == 'NOT_RUN', 'DB_ONLY_SCOPE_REQUIRED')
    require(type(graph['reviewedByRoot']) is bool and type(graph['dockerSlotReady']) is bool,
            'REVIEW_FLAGS_REQUIRED')
    if execution:
        require(graph['reviewedByRoot'] and graph['dockerSlotReady'], 'ROOT_REVIEW_AND_SLOT_REQUIRED')
    require(type(graph['minimumAvailableMiB']) is int and graph['minimumAvailableMiB'] >= 1024,
            'MEMORY_FLOOR_REQUIRED')
    repo = Path(graph['repo'])
    require(repo.is_absolute() and repo.resolve() == repo and head(repo) == graph['sourceHead'],
            'SOURCE_HEAD_CHANGED')
    require(graph['sourceFiles'] == source_files(repo), 'SOURCE_FILES_CHANGED')
    require(graph['migrationManifestSha256'] == secure.CURRENT_MANIFEST and
            graph['migrations'] == current_manifest(repo), 'CURRENT121_GRAPH_CHANGED')
    s = graph['source']
    require(type(s) is dict and set(s) == SOURCE_KEYS and PROJECT.fullmatch(s['project'])
            and s['name'] == 'supabase_db_' + s['project'] and ID.fullmatch(s['id'])
            and re.fullmatch('sha256:[a-f0-9]{64}', s['image'])
            and all(SHA.fullmatch(s[k]) for k in ('configSha256', 'hostConfigSha256', 'mountsSha256'))
            and type(s['unknownCount']) is int and s['unknownCount'] == 2
            and type(s['startedAt']) is str and bool(s['startedAt'])
            and type(s['restartCount']) is int and s['restartCount'] >= 0, 'FRESH_SOURCE_REQUIRED')
    require(s['context'] == 'colima-yumidang-minkyu' and s['host'] ==
            'unix://' + str(Path.home() / '.colima/yumidang-minkyu/docker.sock'),
            'MINKYU_SOCKET_REQUIRED')
    require(PROJECT.fullmatch(graph['targetProject']) and graph['targetProject'] != s['project'],
            'DISTINCT_NEW_TARGET_REQUIRED')
    verify_fixture(s)
    verify_positive_phase(s, graph['sourceHead'])
    root = guards.private_temp_root(s['preparedRoot'])
    intent = parse(secure.read_bytes(root / 'execution-intent.json'))
    owned = parse(secure.read_bytes(root / 'owned-containers.json'))
    require(intent.get('version') == 2 and intent['context'] == s['context'] and
            intent['dockerHost'] == s['host'] and intent['project'] == s['project'],
            'PREPARED_SOURCE_BINDING')
    guards.preserved_contract(root, intent, owned, s['host'], s['project'])
    require(guards.preserved_resource_pins(root, intent) == s['preservedPins'],
            'SOURCE_PREPARATION_CHANGED')
    require([x for x in owned if x['id'] == s['id']] ==
            [x for x in owned if x['name'] == s['name']] and
            len([x for x in owned if x['id'] == s['id'] and x['image'] == s['image']]) == 1,
            'SOURCE_NOT_NEW_OWNED_DB')
    b = graph['baseline']
    if graph['phase'] == 'CAPTURE':
        require(b is None, 'CAPTURE_BASELINE_MUST_BE_ABSENT')
    else:
        require(type(b) is dict and set(b) == {'root', 'receiptSha256'}, 'RESTORE_BASELINE_REQUIRED')
        packet = guards.private_temp_root(b['root'])
        receipt = parse(read_pin(packet / 'capture-receipt.json', b['receiptSha256']))
        require(set(receipt) == {'scope', 'source', 'sourceHead', 'sourceFiles', 'migrations',
            'graphSha256', 'files', 'sourceUnchanged', 'actualRestore'} and
            receipt['scope'] == SCOPE and receipt['source'] == s and
            receipt['sourceHead'] == graph['sourceHead'] and receipt['sourceFiles'] == graph['sourceFiles']
            and receipt['migrations'] == graph['migrations'] and receipt['sourceUnchanged'] is True
            and receipt['actualRestore'] == 'NOT_RUN', 'CAPTURE_RECEIPT_BINDING')
        capture_graph = {**graph, 'phase': 'CAPTURE', 'baseline': None}
        require(receipt['graphSha256'] == sha(canonical(capture_graph)), 'CAPTURE_GRAPH_BINDING')
        require(set(receipt['files']) == PACKET_FILES, 'CAPTURE_FILES_REQUIRED')
        for name, digest in receipt['files'].items():
            read_pin(packet / name, digest)
        verify_database_locale(parse(read_pin(packet / 'source-state.json', receipt['files']['source-state.json'])),
            parse(read_pin(packet / 'database-locale.json', receipt['files']['database-locale.json'])))
    return graph


def load_graph(path, expected, *, execution=False):
    return verify_graph(parse(read_pin(path, expected)), execution=execution)


def load_existing(repo):
    """기존 모듈의 실행 entrypoint는 호출하지 않는다. 별도 모듈 instance의 I/O만 고정한다."""
    folder = str(Path(repo) / 'tests/integration/minkyu')
    sys.path.insert(0, folder)
    try:
        spec = importlib.util.spec_from_file_location('database_restore_existing', Path(repo) / RECOVERY)
        recovery = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(recovery)
        spec = importlib.util.spec_from_file_location('database_restore_snapshot', Path(repo) / HELPER)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        require(Path(helper.recovery.__file__).resolve() == Path(repo) / RECOVERY and
                Path(helper.tls.__file__).resolve() == Path(repo) /
                'tests/integration/minkyu/queue_tls_environment.py', 'EXISTING_IMPORT_ROOT_CHANGED')
        return recovery, helper
    finally:
        sys.path.remove(folder)


def group_helpers(repo, expected):
    raw = read_pin(Path(repo) / 'tools/local/observe_isolated.py', expected, repo=Path(repo))
    names = {'group_alive', 'verify_group_closed'}
    nodes = [n for n in ast.parse(raw).body if isinstance(n, ast.FunctionDef) and n.name in names]
    require({n.name for n in nodes} == names and len(nodes) == 2, 'GROUP_HELPER_CONTRACT')
    namespace = {'os': os, 'signal': signal, 'subprocess': subprocess, 'time': time}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'reviewed-group-helpers', 'exec'), namespace)
    return namespace


def write_private(root, name, data):
    root = guards.private_temp_root(root)
    require(re.fullmatch('[a-z][a-z0-9.-]*', name), 'OUTPUT_NAME_REQUIRED')
    raw = data if isinstance(data, bytes) else canonical(data)
    identity = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid)
    chain = {p: identity(p.lstat()) for p in (root, *root.parents)}
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        require(identity(os.fstat(directory)) == chain[root], 'OUTPUT_DIRECTORY_CHANGED')
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=directory)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        require(all(identity(p.lstat()) == old for p, old in chain.items()), 'OUTPUT_DIRECTORY_CHANGED')
        os.fsync(directory)
    finally:
        os.close(directory)
    read_pin(root / name, sha(raw))
    return sha(raw)


def verify_identity(s, inspection):
    network_path = Path(s['preparedRoot']) / 'owned-networks.json'
    networks = parse(read_pin(network_path, s['preservedPins']['ownedNetworksSha256']))
    require(type(networks) is list and len(networks) == 1 and all(
        type(item) is dict and set(item) == {'id', 'name'} for item in networks), 'SOURCE_NETWORK_PROOF')
    expected_networks = {item['name']: item['id'] for item in networks}
    actual_networks = inspection['NetworkSettings']['Networks']
    require(type(actual_networks) is dict and
            {name: value['NetworkID'] for name, value in actual_networks.items()} == expected_networks,
            'SOURCE_NETWORK_CHANGED')
    require(inspection['Id'] == s['id'] and inspection['Name'] == '/' + s['name'] and
            inspection['Image'] == s['image'] and inspection['State']['Running'] is True and
            inspection['State']['OOMKilled'] is False and
            inspection['State']['StartedAt'] == s['startedAt'] and
            inspection['RestartCount'] == s['restartCount'] and
            inspection['Config']['Labels'].get('com.supabase.cli.project') == s['project'] and
            sha(canonical(inspection['Config'])) == s['configSha256'] and
            sha(canonical(inspection['HostConfig'])) == s['hostConfigSha256'] and
            guards.preserved_mounts_sha(inspection['Mounts']) == s['mountsSha256'],
            'SOURCE_IDENTITY_CHANGED')


def verify_history(migrations, observed):
    expected = [[x['version'], Path(x['path']).stem.split('_', 1)[1]] for x in migrations]
    require(observed == expected and len(observed) == 121, 'ACTUAL121_HISTORY_REQUIRED')


def verify_database_locale(state, proof):
    """기존 collector 원배열은 보정하지 않고 별도 실제 locale 관측을 연결한다."""
    database = state['rawAuthority']['database']
    require(type(database) is list and len(database) == 15 and database[0] == 'postgres'
            and database[2] == 'UTF8' and database[5] in ('c', 'i'), 'DATABASE_LOCALE_UNSUPPORTED')
    require(type(proof) is dict and set(proof) == LOCALE_KEYS, 'DATABASE_LOCALE_CHANGED')
    expected = dict(zip(('encoding', 'collate', 'ctype', 'provider', 'locale', 'version'), database[2:8]))
    require(all(type(proof[k]) is type(value) and proof[k] == value for k, value in expected.items()),
            'DATABASE_LOCALE_CHANGED')
    require(all(type(value) is str and re.fullmatch('[A-Za-z0-9_.@-]{1,100}', value)
                for value in (database[3], database[4])), 'DATABASE_LOCALE_UNSUPPORTED')
    require(proof['icuRules'] is None, 'DATABASE_ICU_RULES_UNSUPPORTED')
    if database[5] == 'c':
        require(database[6] is None, 'DATABASE_LOCALE_UNSUPPORTED')
    else:
        require(type(database[6]) is str and re.fullmatch('[A-Za-z][A-Za-z0-9_-]{0,99}', database[6])
                and type(database[7]) is str and re.fullmatch('[0-9]+(?:[.][0-9]+)*', database[7]),
                'DATABASE_LOCALE_UNSUPPORTED')
    require(proof['actualVersion'] == database[7] and type(proof['actualVersion']) is type(database[7]),
            'DATABASE_COLLATION_VERSION_MISMATCH')
    return proof


def database_locale_options(state, proof):
    value = verify_database_locale(state, proof)
    provider = '--locale-provider=icu --icu-locale=' + value['locale'] if value['provider'] == 'i' else '--locale-provider=libc'
    return provider + ' --lc-collate=' + value['collate'] + ' --lc-ctype=' + value['ctype']


class DatabaseRestore:
    """고정 Docker 명령으로만 연결한다. 원 source SQL은 항상 READ ONLY다."""
    def __init__(self, graph, root):
        self.graph = verify_graph(graph, execution=True)
        self.source = graph['source']; self.root = guards.private_temp_root(root)
        self.repo = Path(graph['repo']); self.target = None; self.created = False
        self.target_pins = None; self.target_init = None; self.locale_proof = None
        self.target_created_inspect_sha = None; self.target_runtime_pins = None
        self.target_transition_sha = None; self.target_start_intent_sha = None
        self.target_start_pending = False
        self.target_start_identity_sha = None; self.target_incarnation_rejected_sha = None
        self.group_helpers = group_helpers(self.repo, graph['sourceFiles']['tools/local/observe_isolated.py'])
        self.command_monitor = []; self.memory_samples = []
        self.guard_root = None; self.guard_pins = None
        self.docker = ['docker', '--host', self.source['host']]
        self.recovery, self.helper = load_existing(self.repo)
        permissions = self.recovery.native_backup_permissions
        self.recovery.native_backup_permissions = lambda query, name: permissions(
            query, name, role_batch_size=4)
        self.helper.query = lambda name, query: self.sql(name, query)
        self.helper.call = self.helper_call

    def raw(self, args, data=None, *, timeout=60):
        """stdout/stderr는 terminal로 보내지 않는다. 고정 오류만 상위로 전달한다."""
        # 진단/read/stop은 guard 자체의 구성 요소다. 나머지 SQL/dump/restore 명령은
        # 3초마다 HEAD/소스/메모리를 감시하며 자기 CLI process group만 닫는다.
        observed = bool(args and (args[0] in ('create', 'start') or args[0] == 'exec' and any(
            value in args for value in ('psql', 'pg_dump', 'pg_dumpall', 'pg_restore', 'dropdb'))))
        with tempfile.TemporaryFile(dir=self.root) as incoming, tempfile.TemporaryFile(dir=self.root) as out, tempfile.TemporaryFile(dir=self.root) as err:
            if data: incoming.write(data)
            incoming.seek(0)
            process = subprocess.Popen(self.docker + list(args), stdin=incoming, stdout=out,
                                       stderr=err, start_new_session=True)
            started = time.monotonic()
            try:
                while process.poll() is None:
                    require(time.monotonic() - started < timeout, 'DOCKER_COMMAND_TIMEOUT_NO_RETRY')
                    require(os.fstat(out.fileno()).st_size <= 64 * 1024**2 and
                            os.fstat(err.fileno()).st_size <= 4 * 1024**2, 'COMMAND_OUTPUT_LIMIT')
                    try: process.wait(timeout=min(3, max(.01, timeout - (time.monotonic() - started))))
                    except subprocess.TimeoutExpired:
                        if observed:
                            require(head(self.repo) == self.graph['sourceHead'] and
                                    source_files(self.repo) == self.graph['sourceFiles'], 'SOURCE_FILES_CHANGED')
                            self.memory()
                require(process.returncode == 0 and os.fstat(out.fileno()).st_size <= 64 * 1024**2,
                        'DOCKER_COMMAND_FAILED')
                out.seek(0); return out.read(64 * 1024**2 + 1)
            finally:
                had_error = sys.exc_info()[0] is not None or process.returncode != 0
                if process.poll() is None:
                    try: os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError: pass
                    try: process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        try: os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError: pass
                        process.wait(timeout=3)
                closed = False
                try:
                    self.group_helpers['verify_group_closed'](process)
                    closed = process.poll() is not None and not self.group_helpers['group_alive'](process)
                    require(closed, 'OWN_PROCESS_GROUP_REMAINS')
                finally:
                    entry = {'pid': process.pid, 'operation': args[0],
                        'elapsedSeconds': round(time.monotonic() - started, 3),
                        'exitCode': process.returncode, 'closed': closed}
                    self.command_monitor.append(entry)
                    if (had_error or not closed) and (observed or args[0] in ('create', 'start', 'stop')):
                        name = 'failure-command-' + uuid.uuid4().hex
                        out.seek(0); err.seek(0)
                        entry['failureOutput'] = {
                            'stdoutSha256': write_private(self.root, name + '.stdout', out.read(64 * 1024**2)),
                            'stderrSha256': write_private(self.root, name + '.stderr', err.read(4 * 1024**2)),
                            'stdoutBytes': os.fstat(out.fileno()).st_size,
                            'stderrBytes': os.fstat(err.fileno()).st_size,
                            'truncated': os.fstat(out.fileno()).st_size > 64 * 1024**2 or
                                         os.fstat(err.fileno()).st_size > 4 * 1024**2}
                        write_private(self.root, name + '.json', entry)

    def memory(self, *, start=False):
        started = time.monotonic()
        raw = self.raw(['exec', self.source['id'], 'cat', '/proc/meminfo'], timeout=3)
        require(time.monotonic() - started <= 3, 'MEMORY_PROBE_STALE')
        values = re.findall(rb'^MemAvailable:\s+([0-9]+) kB$', raw, re.M)
        minimum = max(1048576, self.graph['minimumAvailableMiB'] * 1024) if start else 786432
        require(len(values) == 1 and int(values[0]) >= minimum,
                'MEMORY_LOW_NO_NEW_WORK')
        self.memory_samples.append(int(values[0]))
        return int(values[0])

    def monitor_result(self):
        samples = getattr(self, 'memory_samples', [])
        commands = getattr(self, 'command_monitor', [])
        return {'sampleCount': len(samples), 'minimumAvailableKiB': min(samples) if samples else None,
                'commands': commands, 'ownChildProcessesClosed': all(x['closed'] for x in commands)}

    def guard(self):
        require(head(self.repo) == self.graph['sourceHead'] and
                source_files(self.repo) == self.graph['sourceFiles'], 'SOURCE_FILES_CHANGED')
        for entry in self.graph['migrations']:
            require(sha(secure.read_bytes(self.repo / entry['path'], repo=self.repo)) == entry['sha256'],
                    'CURRENT121_SQL_CHANGED')
        values = parse(self.raw(['inspect', self.source['id']]))
        require(type(values) is list and len(values) == 1, 'SOURCE_INSPECT_REQUIRED')
        verify_identity(self.source, values[0]); self.memory()
        if self.guard_root:
            guards.verify_preserved_resources(self.guard_root, self.source['host'],
                self.graph['targetProject'], lambda args: self.raw(args).decode(), self.guard_pins)
        else:
            guards.verify_preserved_resources(self.source['preparedRoot'], self.source['host'],
                self.source['project'], lambda args: self.raw(args).decode(), self.source['preservedPins'])

    def command(self, args, data=None):
        target_command = False
        start_command = False
        if args and args[0] == 'exec':
            index = 2 if len(args) > 1 and args[1] == '-i' else 1
            require(len(args) > index + 1, 'FIXED_COMMAND_REQUIRED')
            identifier, program = args[index:index + 2]
            require(identifier == self.source['id'] or self.target is not None and identifier == self.target,
                    'EXEC_TARGET_REFUSED')
            require(program in ('psql', 'pg_dump', 'pg_dumpall', 'pg_restore', 'dropdb'), 'EXEC_PROGRAM_REFUSED')
            target_command = identifier == self.target
            if not target_command:
                require(program != 'dropdb' and (program != 'pg_restore' or args[index + 2:] == ['--create', '--list'])
                    and (program != 'psql' or type(data) is bytes and data.startswith(
                        b"begin read only;set local statement_timeout='15s';") and data.endswith(b'commit;')),
                    'SOURCE_WRITE_REFUSED')
        elif args == ['image', 'inspect', self.source['image']]:
            pass
        elif self.target is not None and args == ['start', self.target]:
            target_command = True
            start_command = True
            require(getattr(self, 'target_start_intent_sha', None) is None, 'TARGET_START_NO_REPLAY')
        else:
            raise RestoreError('FIXED_COMMAND_REQUIRED')
        self.guard()
        if target_command:
            before = self.own(observation='before_start') if start_command else self.own()
        # 전체 기존 자원 대조가 길어져도 실행 직전 메모리 관측은 새로 취득한다.
        self.memory()
        if start_command:
            require(before['State']['Status'] == 'created' and before['State']['Running'] is False
                    and before['RestartCount'] == 0, 'TARGET_START_CREATED_ONLY')
            self.target_start_intent_sha = write_private(self.root, 'target-start-intent.json', {
                'id': self.target, 'graphSha256': sha(canonical(self.graph)), 'attempt': 1, 'noReplay': True,
                'createdInspectSha256': self.target_created_inspect_sha,
                'beforeInspectSha256': self.target_before_start_sha, 'beforePins': self.target_pins})
            self.target_start_pending = True
        try:
            return self.raw(args, data)
        finally:
            try:
                if target_command:
                    self.own(observation='after_start') if start_command else self.own()
            finally:
                if start_command: self.target_start_pending = False
                self.guard()

    def sql(self, name, query, *, write=False, database='postgres'):
        require(name in (self.source['id'], self.target), 'SQL_TARGET_REQUIRED')
        if name == self.source['id']:
            require(not write and database == 'postgres', 'SOURCE_WRITE_REFUSED')
            query = "begin read only;set local statement_timeout='15s';" + query + 'commit;'
        else:
            self.own()
        return self.command(['exec', '-i', name, 'psql', '-XqAt', '-h', '/var/run/postgresql',
            '-U', 'supabase_admin', '-d', database, '-v', 'ON_ERROR_STOP=1'], query.encode())

    def helper_call(self, argv, data=None):
        # 기존 catalog helper가 요구하는 schema-only pg_dump만 지원한다.
        require(data is None and 'exec' in argv, 'SNAPSHOT_COMMAND_REQUIRED')
        args = argv[argv.index('exec') + 1:]
        require(args[0] in (self.source['id'], self.target) and args[1] == 'pg_dump'
                and args[-1] == '--schema-only' and args[2:6] ==
                ['-U', self.helper.recovery.BOOT, '-d', 'postgres'] and len(args) == 7,
                'SCHEMA_DUMP_ONLY')
        return self.command(['exec', args[0], 'pg_dump', '-h', '/var/run/postgresql', '-U',
                             'supabase_admin', '-d', 'postgres', '--schema-only'])

    def state(self, name):
        # 동일 함수의 실제 collector/role·grantor 정규화와 strict compare를 재사용한다.
        return self.recovery.native_backup_state(lambda n, q: self.sql(n, q), self.helper, name)

    def read_database_locale(self, name, state, *, observation):
        require(type(observation) is str and observation in LOCALE_OBSERVATIONS,
                'FIXED_LOCALE_OBSERVATION_REQUIRED')
        raw = self.sql(name, DATABASE_LOCALE_SQL)
        write_private(self.root, LOCALE_OBSERVATIONS[observation], raw)
        return verify_database_locale(state, parse(raw))

    def closed(self, name):
        query = """select json_build_object('cron',current_setting('cron.launch_active_jobs'),
          'admin',(select rolsuper from pg_roles where rolname='supabase_admin'),
          'active',(select count(*) from pg_stat_activity where datname=current_database()
            and backend_type='client backend' and state='active' and pid<>pg_backend_pid()),
          'controls',(select bool_and(not enabled) from private.worker_runtime_atomic_control),
          'deletion',(select bool_and(not external_deletion_approved) from private.member_cleanup_guard),
          'lease',(select bool_and(token is null) from private.global_worker_run));"""
        value = parse(self.sql(name, query))
        require(value == {'cron': 'off', 'admin': True, 'active': 0, 'controls': True,
                          'deletion': True, 'lease': True}, 'CLOSED_SOURCE_REQUIRED')
        for table in ('worker_invocation_control', 'worker_intent_confirmation_control',
                      'event_collection_control', 'content_inspection_control',
                      'member_retirement_receipt_control'):
            require(self.sql(name, 'select bool_and(not enabled) from private.' + table + ';').strip()
                    == b't', 'CONTROL_OPEN')
        require(int(self.sql(name, UNKNOWN_SQL).strip()) == 2, 'ORIGINAL_UNKNOWN2_REQUIRED')
        fixture = verify_fixture(self.source)
        ids = ','.join("'" + x + "'::uuid" for x in fixture['reservationIds'])
        proof = parse(self.sql(name, "select json_build_object('account',(select count(*) from private.ai_account_budget_reservations where reservation_id in(" + ids + ") and ledger_id='" + fixture['ledgerId'] + "' and unknown_at is not null and settled_at is null),'legacy',(select count(*) from private.ai_budget_reservations where id in(" + ids + ") and ledger_id='" + fixture['ledgerId'] + "'),'sequence',(select json_build_array(last_value,is_called) from private." + fixture['sequence'] + '));'))
        require(proof == {'account': 2, 'legacy': 2, 'sequence': [41, True]}, 'SYNTHETIC_ORIGINAL_ROWS_REQUIRED')

    def capture(self):
        require(self.graph['phase'] == 'CAPTURE', 'CAPTURE_PHASE_REQUIRED')
        write_private(self.root, 'capture-intent.json', {'graphSha256': sha(canonical(self.graph)),
                      'sourceId': self.source['id'], 'attempt': 1, 'noReplay': True})
        stage = 'guard'; files = {}
        try:
            self.guard(); stage = 'start_memory'; self.memory(start=True)
            stage = 'closed'; self.closed(self.source['id'])
            stage = 'history'
            history_raw = self.sql(self.source['id'], HISTORY_SQL)
            files['history.json'] = write_private(self.root, 'history.json', history_raw)
            history = parse(history_raw); verify_history(self.graph['migrations'], history)
            stage = 'source_state'; before = self.state(self.source['id'])
            files['source-state.json'] = write_private(self.root, 'source-state.json', before)
            stage = 'database_locale'; locale = self.read_database_locale(
                self.source['id'], before, observation='capture_source_before')
            files['database-locale.json'] = write_private(self.root, 'database-locale.json', locale)
        except BaseException as exc:
            write_private(self.root, 'capture-finalization.json', {'sourceUnchanged': 'NOT_PROVEN',
                'stage': stage, 'completePacket': False, 'errorType': type(exc).__name__, 'failureCode': failure_code(exc),
                'additionalSqlAfterFailure': 'NOT_RUN', 'actualRestore': 'NOT_RUN',
                'automaticReplay': False, 'monitor': self.monitor_result()})
            raise RestoreError('CAPTURE_PREFLIGHT_FAILED_NO_REPLAY') from None
        error = None; same = False
        try:
            dump = self.command(['exec', self.source['id'], 'pg_dump', '-h', '/var/run/postgresql',
                '-U', 'supabase_admin', '-d', 'postgres', '-Fc'])
            files['source.dump'] = write_private(self.root, 'source.dump', dump)
            roles = self.command(['exec', self.source['id'], 'pg_dumpall', '-h', '/var/run/postgresql',
                '-U', 'supabase_admin', '--roles-only', '--no-role-passwords'])
            require(not re.search(rb"\bPASSWORD\s+'", roles, re.I), 'PASSWORD_DUMP_REFUSED')
            files['roles.sql'] = write_private(self.root, 'roles.sql', roles)
            archive = self.recovery.native_backup_database_archive(self.command(['exec', '-i',
                self.source['id'], 'pg_restore', '--create', '--list'], dump), before)
            files['archive-metadata.json'] = write_private(self.root, 'archive-metadata.json', archive)
        except BaseException as exc:
            error = exc
        finally:
            try:
                final = self.state(self.source['id'])
                write_private(self.root, 'source-final.json', final)
                self.recovery.native_restore_compare(before, final, sha(canonical(before)))
                locale_final = self.read_database_locale(
                    self.source['id'], final, observation='capture_source_final')
                write_private(self.root, 'source-final-locale.json', locale_final)
                require(canonical(locale_final) == canonical(locale), 'DATABASE_LOCALE_CHANGED')
                self.closed(self.source['id']); self.guard()
                verify_graph(self.graph, execution=True); same = True
            except BaseException as exc:
                if error is None: error = exc
            write_private(self.root, 'capture-finalization.json', {'sourceUnchanged': same,
                'completePacket': set(files) == PACKET_FILES, 'errorType': type(error).__name__ if error else None,
                'failureCode': failure_code(error) if error else None,
                'actualRestore': 'NOT_RUN', 'automaticReplay': False, 'monitor': self.monitor_result()})
        require(error is None and same and set(files) == PACKET_FILES, 'CAPTURE_FAILED_CLOSED_NO_REPLAY')
        receipt = {'scope': SCOPE, 'source': self.source, 'sourceHead': self.graph['sourceHead'],
                   'sourceFiles': self.graph['sourceFiles'], 'migrations': self.graph['migrations'],
                   'graphSha256': sha(canonical(self.graph)), 'files': files,
                   'sourceUnchanged': True, 'actualRestore': 'NOT_RUN'}
        write_private(self.root, 'capture-receipt.json', receipt)
        return receipt

    def initialize_guard(self):
        """기존 resource guard schema를 그대로 사용. source도 새 guard에서는 보호 대상이다."""
        self.guard(); project = self.graph['targetProject']
        root = self.root / 'resource-guard'; root.mkdir(mode=0o700)
        ids = self.raw(['ps', '-a', '--no-trunc', '--format', '{{.ID}}']).decode().splitlines()
        containers = parse(self.raw(['inspect', *sorted(ids)])) if ids else []
        old = []
        for x in containers:
            old.append({'id': x['Id'], 'name': x['Name'].removeprefix('/'), 'image': x['Image'],
                'labelsSha256': resource_sha(x['Config']['Labels']),
                'configSha256': resource_sha(x['Config']), 'hostConfigSha256': resource_sha(x['HostConfig']),
                'mountsSha256': guards.preserved_mounts_sha(x['Mounts']),
                'state': {'running': x['State']['Running'], 'status': x['State']['Status'],
                          'oomKilled': x['State']['OOMKilled']}})
        nets = [parse(x) for x in self.raw(['network', 'ls', '--no-trunc', '--format', '{{json .}}']).splitlines()]
        custom = sorted(x['ID'] for x in nets if x['Name'] not in ('bridge', 'host', 'none'))
        networks = [{'id': x['Id'], 'name': x['Name'], 'inspectionSha256': resource_sha(x)}
            for x in (parse(self.raw(['network', 'inspect', *custom])) if custom else [])]
        names = self.raw(['volume', 'ls', '--format', '{{.Name}}']).decode().splitlines()
        volumes = [{'name': x['Name'], 'inspectionSha256': resource_sha(x)}
            for x in (parse(self.raw(['volume', 'inspect', *sorted(names)])) if names else [])]
        baseline = {'version': 1, 'scope': 'OBSERVED_EXISTING_RESOURCES_METADATA_ONLY',
            'profile': 'yumidang-minkyu', 'dockerHost': self.source['host'], 'containers': old,
            'customNetworks': networks, 'volumes': volumes, 'existingDatabaseOrStorageRead': 'NOT_RUN',
            'existingMutationCommands': 'NOT_RUN', 'wholeStoredBytesPreserved': 'NOT_VERIFIED',
            'baselineMetadataSha256': sha(canonical({'containers': old, 'networks': networks, 'volumes': volumes}))}
        intent = {'version': 2, 'context': self.source['context'], 'dockerHost': self.source['host'],
            'project': project, 'scope': 'new-synthetic-only',
            'existingContainers': [{'id': x['id'], 'name': x['name']} for x in old],
            'existingNetworks': [{'id': x['id'], 'name': x['name']} for x in networks],
            'preservedBaselineSha256': write_private(root, 'protected-resource-baseline.json', baseline)}
        for name, value in [('execution-intent.json', intent), ('owned-containers.json', []),
                            ('owned-networks.json', []), ('owned-volumes.json', [])]:
            write_private(root, name, value)
        self.guard_root = root
        self.guard_pins = guards.preserved_resource_pins(root, intent)
        self.existing_ids = {x['id'] for x in old}
        require('supabase_db_' + project not in {x['name'] for x in old}, 'EXISTING_TARGET_REFUSED')
        self.guard()

    def target_incarnation(self, x, raw, observation):
        def reject():
            if getattr(self, 'target_incarnation_rejected_sha', None) is None:
                self.target_incarnation_rejected_sha = write_private(
                    self.root, 'target-incarnation-rejected-inspect-private.json', raw)
            else:
                read_pin(self.root / 'target-incarnation-rejected-inspect-private.json',
                         self.target_incarnation_rejected_sha)
            raise RestoreError('TARGET_START_IDENTITY_CHANGED')
        state = x.get('State', {})
        if observation == 'after_start':
            if not (getattr(self, 'target_start_pending', False) is True
                and getattr(self, 'target_start_intent_sha', None) is not None
                and state.get('Running') is True and state.get('Restarting') is False
                and type(x.get('RestartCount')) is int and x['RestartCount'] == 0
                and type(state.get('StartedAt')) is str
                and state['StartedAt'] not in ('', '0001-01-01T00:00:00Z')):
                reject()
        elif getattr(self, 'target_start_identity_sha', None) is not None:
            proof = parse(read_pin(self.root / 'target-started-identity.json', self.target_start_identity_sha))
            after = parse(read_pin(self.root / 'target-after-start-inspect-private.json', proof['afterInspectSha256']))[0]
            require(proof['id'] == self.target and proof['restartCount'] == 0
                    and proof['startedAt'] == after['State']['StartedAt']
                    and after['RestartCount'] == 0 and after['State']['Restarting'] is False,
                    'TARGET_START_EVIDENCE_CHANGED')
            for name, key in [('target-created-inspect-private.json', 'createdInspectSha256'),
                              ('target-before-start-inspect-private.json', 'beforeInspectSha256'),
                              ('target-start-intent.json', 'startIntentSha256')]:
                read_pin(self.root / name, proof[key])
            if not (type(x.get('RestartCount')) is int and x['RestartCount'] == proof['restartCount']
                    and state.get('Restarting') is False and state.get('StartedAt') == proof['startedAt']):
                reject()
        elif getattr(self, 'target_start_intent_sha', None) is not None:
            # 시작을 시도했으나 최초 incarnation을 입증하지 못했으면 후속 SQL/정지도 진행하지 않는다.
            reject()

    def own(self, *, observation=None):
        require(self.target and self.target not in self.existing_ids and
                self.target != self.source['id'], 'NEW_TARGET_ID_REQUIRED')
        require(observation in (None, 'before_start', 'after_start'), 'FIXED_TARGET_OBSERVATION_REQUIRED')
        inspection_only = type(self) is SimpleNamespace
        if inspection_only:
            require(observation is None and type(self.target_pins) is dict and
                    set(self.target_pins) == {'configSha256', 'hostConfigSha256'} and
                    all(type(v) is str and SHA.fullmatch(v) for v in self.target_pins.values()),
                    'EXACT_PINNED_INSPECTION_REQUIRED')
        raw = self.raw(['inspect', self.target])
        if self.target_pins is None and getattr(self, 'target_created_inspect_sha', None) is None:
            self.target_created_inspect_sha = write_private(self.root, 'target-created-inspect-private.json', raw)
        if observation is not None:
            name = 'target-before-start-inspect-private.json' if observation == 'before_start' else 'target-after-start-inspect-private.json'
            digest = write_private(self.root, name, raw)
            if observation == 'before_start': self.target_before_start_sha = digest
            else: self.target_after_start_sha = digest
        xs = parse(raw); require(type(xs) is list and len(xs) == 1, 'ONE_TARGET_REQUIRED')
        x = xs[0]; h = x['HostConfig']; labels = x['Config']['Labels']
        if not inspection_only: self.target_incarnation(x, raw, observation)
        require(x['Id'] == self.target and x['Name'] == '/supabase_db_' + self.graph['targetProject']
            and x['Image'] == self.source['image'] and labels.get('com.supabase.cli.project') ==
            self.graph['targetProject'] and labels.get('yumidang.scope') == SCOPE
            and labels.get('yumidang.owner') == 'minkyu'
            and labels.get('yumidang.graph') == sha(canonical(self.graph)) and
            not x['Mounts'] and not h['PortBindings'] and h['NetworkMode'] == 'none'
            and h['Memory'] == h['MemorySwap'] == 512 * 1024**2 and h['PidsLimit'] == 128
            and h['NanoCpus'] == 500000000 and h['Privileged'] is False and not h['CapAdd']
            and h['LogConfig']['Type'] == 'none' and x['Config']['Healthcheck']['Test'] == ['NONE']
            and x['Config']['User'] == 'postgres' and x['Config']['Entrypoint'] == ['sh']
            and x['Config']['Cmd'] == ['-c', self.target_init]
            and set(x['NetworkSettings']['Networks']) == {'none'}
            and not x['NetworkSettings']['Networks']['none']['IPAddress']
            and 'OomKillDisable' in h and (h['OomKillDisable'] is False or h['OomKillDisable'] is None)
            and type(x['RestartCount']) is int and x['RestartCount'] == 0 and x['State']['Restarting'] is False
            and x['State']['OOMKilled'] is False, 'TARGET_IDENTITY_CHANGED')
        pins = {'configSha256': sha(canonical(x['Config'])), 'hostConfigSha256': sha(canonical(h))}
        if inspection_only:
            # 기존 closure의 순수 판정에는 전이 허용이나 파일 I/O를 추가하지 않는다.
            require(self.target_pins == pins, 'TARGET_CONFIGURATION_CHANGED')
            return x
        if self.target_pins is None:
            original = parse(read_pin(self.root / 'target-created-inspect-private.json', self.target_created_inspect_sha))
            require(canonical(xs) == canonical(original) and x['State']['Status'] == 'created'
                    and x['State']['Running'] is False and x['RestartCount'] == 0
                    and x['State']['StartedAt'] == '0001-01-01T00:00:00Z', 'TARGET_INITIAL_CREATED_REQUIRED')
            self.target_pins = pins
        read_pin(self.root / 'target-created-inspect-private.json', self.target_created_inspect_sha)
        expected = getattr(self, 'target_runtime_pins', None) or self.target_pins
        if expected != pins:
            require(getattr(self, 'target_runtime_pins', None) is None and observation == 'after_start'
                    and getattr(self, 'target_start_pending', False) is True
                    and getattr(self, 'target_start_intent_sha', None) is not None,
                    'TARGET_CONFIGURATION_CHANGED')
            original = parse(read_pin(self.root / 'target-created-inspect-private.json', self.target_created_inspect_sha))[0]
            before = parse(read_pin(self.root / 'target-before-start-inspect-private.json', self.target_before_start_sha))[0]
            intent = parse(read_pin(self.root / 'target-start-intent.json', self.target_start_intent_sha))
            require(intent == {'id': self.target, 'graphSha256': sha(canonical(self.graph)), 'attempt': 1,
                'noReplay': True, 'createdInspectSha256': self.target_created_inspect_sha,
                'beforeInspectSha256': self.target_before_start_sha, 'beforePins': self.target_pins},
                'TARGET_START_EVIDENCE_CHANGED')
            require(original['HostConfig']['OomKillDisable'] is False
                    and before['HostConfig']['OomKillDisable'] is False and h['OomKillDisable'] is None
                    and before['State']['Status'] == 'created' and before['State']['Running'] is False
                    and x['State']['Running'] is True and x['State']['Restarting'] is False
                    and x['RestartCount'] == 0 and type(x['State']['StartedAt']) is str
                    and x['State']['StartedAt'] not in ('', '0001-01-01T00:00:00Z'),
                    'TARGET_CONFIGURATION_CHANGED')
            reconstructed = dict(h); reconstructed['OomKillDisable'] = False
            require(self.target_pins == {'configSha256': pins['configSha256'],
                'hostConfigSha256': sha(canonical(reconstructed))}, 'TARGET_CONFIGURATION_CHANGED')
            self.target_transition_sha = write_private(self.root, 'target-hostconfig-transition.json', {
                'scope': 'EXACT_NEW_TARGET_START_FALSE_TO_NULL_ONLY', 'id': self.target,
                'createdInspectSha256': self.target_created_inspect_sha,
                'beforeInspectSha256': self.target_before_start_sha, 'afterInspectSha256': self.target_after_start_sha,
                'startIntentSha256': self.target_start_intent_sha, 'beforePins': self.target_pins,
                'afterPins': pins, 'field': 'HostConfig.OomKillDisable', 'before': False, 'after': None})
            self.target_runtime_pins = pins
        if getattr(self, 'target_runtime_pins', None) is not None:
            proof = parse(read_pin(self.root / 'target-hostconfig-transition.json', self.target_transition_sha))
            require(proof['id'] == self.target and proof['beforePins'] == self.target_pins
                    and proof['afterPins'] == self.target_runtime_pins == pins, 'TARGET_CONFIGURATION_CHANGED')
            for name, key in [('target-created-inspect-private.json', 'createdInspectSha256'),
                              ('target-before-start-inspect-private.json', 'beforeInspectSha256'),
                              ('target-after-start-inspect-private.json', 'afterInspectSha256'),
                              ('target-start-intent.json', 'startIntentSha256')]:
                read_pin(self.root / name, proof[key])
        if observation == 'after_start':
            original = parse(read_pin(self.root / 'target-created-inspect-private.json', self.target_created_inspect_sha))[0]
            before = parse(read_pin(self.root / 'target-before-start-inspect-private.json', self.target_before_start_sha))[0]
            require(all(row['State']['Status'] == 'created' and row['State']['Running'] is False
                and row['RestartCount'] == 0 and row['State']['Restarting'] is False
                and row['State']['StartedAt'] == '0001-01-01T00:00:00Z' for row in (original, before)),
                'TARGET_START_IDENTITY_CHANGED')
            self.target_start_identity_sha = write_private(self.root, 'target-started-identity.json', {
                'id': self.target, 'startedAt': x['State']['StartedAt'], 'restartCount': 0,
                'createdInspectSha256': self.target_created_inspect_sha,
                'beforeInspectSha256': self.target_before_start_sha, 'afterInspectSha256': self.target_after_start_sha,
                'startIntentSha256': self.target_start_intent_sha})
        return x

    def create_target(self, state):
        self.stage = 'target_image_preflight'
        images = parse(self.command(['image', 'inspect', self.source['image']]))
        require(type(images) is list and len(images) == 1 and images[0]['Id'] == self.source['image']
                and images[0]['Config'].get('Volumes') in (None, {}), 'IMAGE_DECLARED_VOLUME_REFUSED')
        self.initialize_guard()
        self.stage = 'database_locale_preflight'
        locale_options = database_locale_options(state, self.locale_proof)
        init = ('initdb -U supabase_admin -D /tmp/restore-data --auth-local=trust --auth-host=reject '
            '--encoding=UTF8 ' + locale_options +
            " && exec postgres -D /tmp/restore-data -c config_file=/etc/postgresql/postgresql.conf"
            " -c data_directory=/tmp/restore-data -c hba_file=/tmp/restore-data/pg_hba.conf"
            " -c listen_addresses='' -c unix_socket_directories=/var/run/postgresql -c ssl=off"
            ' -c cron.database_name=postgres -c cron.launch_active_jobs=off -c shared_buffers=16MB -c max_connections=40')
        name = 'supabase_db_' + self.graph['targetProject']
        self.target_init = init
        write_private(self.root, 'target-create-intent.json', {'name': name, 'graphSha256': sha(canonical(self.graph)),
                      'image': self.source['image'], 'attempt': 1, 'noReplay': True})
        self.guard()
        self.memory(start=True)
        self.stage = 'target_create'
        # create 실패 후에도 이름+고유graph label로 발견한 이번 새 ID만 finally에서 고정한다.
        try:
            raw = self.raw(['create', '--pull=never', '--name', name, '--network', 'none', '--memory', '512m',
                '--memory-swap', '512m', '--pids-limit', '128', '--cpus', '0.5', '--log-driver', 'none',
                '--no-healthcheck', '--label', 'com.supabase.cli.project=' + self.graph['targetProject'],
                '--label', 'yumidang.scope=' + SCOPE, '--label', 'yumidang.graph=' + sha(canonical(self.graph)),
                '--label', 'yumidang.owner=minkyu',
                '--user', 'postgres', '--entrypoint', 'sh', self.source['image'], '-c', init])
            self.target = raw.decode().strip(); require(ID.fullmatch(self.target), 'NEW_TARGET_ID_REQUIRED')
        finally:
            if self.target is None:
                found = self.raw(['ps', '-a', '--no-trunc', '--format', '{{.ID}}', '--filter',
                    'name=^/' + name + '$', '--filter', 'label=yumidang.graph=' + sha(canonical(self.graph))]).decode().splitlines()
                require(len(found) <= 1, 'CREATE_DISCOVERY_AMBIGUOUS')
                if found: self.target = found[0]
            if self.target:
                self.own(); self.created = True
                write_private(self.root, 'owned-target.json', {'id': self.target, 'name': name,
                              'configurationPins': self.target_pins})
                # 새 ID 확정은 새 guard의 허용 집합 변경이다. 원 source packet은 변경하지 않는다.
                old = self.guard_root / 'owned-containers.json'; old.unlink()
                write_private(self.guard_root, 'owned-containers.json',
                    [{'id': self.target, 'name': name, 'image': self.source['image']}])
                intent = parse(secure.read_bytes(self.guard_root / 'execution-intent.json'))
                self.guard_pins = guards.preserved_resource_pins(self.guard_root, intent)
        self.guard(); self.command(['start', self.target])
        for _ in range(40):
            self.own()
            try:
                if self.sql(self.target, 'select 1;').strip() == b'1':
                    self.stage = 'target_locale_preflight'
                    observed = self.read_database_locale(self.target, state, observation='target_initial')
                    require(canonical(observed) == canonical(self.locale_proof), 'DATABASE_LOCALE_CHANGED')
                    write_private(self.root, 'target-initial-locale.json', observed)
                    return
            except RestoreError as error:
                if str(error) != 'DOCKER_COMMAND_FAILED': raise
            time.sleep(.25)
        raise RestoreError('TARGET_NOT_READY_NO_RETRY_RESTORE')

    def restore(self):
        require(self.graph['phase'] == 'RESTORE', 'RESTORE_PHASE_REQUIRED')
        packet = Path(self.graph['baseline']['root'])
        receipt = parse(read_pin(packet / 'capture-receipt.json', self.graph['baseline']['receiptSha256']))
        read = lambda name: read_pin(packet / name, receipt['files'][name])
        original = parse(read('source-state.json')); dump = read('source.dump'); roles = read('roles.sql')
        self.locale_proof = verify_database_locale(original, parse(read('database-locale.json')))
        require(not re.search(rb"\bPASSWORD\s+'", roles, re.I), 'PASSWORD_DUMP_REFUSED')
        write_private(self.root, 'restore-intent.json', {'graphSha256': sha(canonical(self.graph)),
                      'captureSha256': self.graph['baseline']['receiptSha256'], 'attempt': 1, 'noReplay': True})
        # 같은 승인 graph의 새 output 경로 재실행도 자동 재전송으로 바꾸지 않는다.
        write_private(packet, 'restore-reservation.json', {'graphSha256': sha(canonical(self.graph)),
                      'targetProject': self.graph['targetProject'], 'attempt': 1, 'automaticRemoval': False})
        passed = False; final_source = None; error = None; remaining = []; work_started = False
        self.stage = 'source_preflight'; failed_stage = None
        try:
            self.guard(); self.memory(start=True); work_started = True
            self.closed(self.source['id']); verify_history(self.graph['migrations'], parse(self.sql(self.source['id'], HISTORY_SQL)))
            self.recovery.native_restore_compare(original, self.state(self.source['id']), sha(canonical(original)))
            observed = self.read_database_locale(
                self.source['id'], original, observation='restore_source_before')
            write_private(self.root, 'source-before-locale.json', observed)
            require(canonical(observed) == canonical(self.locale_proof), 'DATABASE_LOCALE_CHANGED')
            self.create_target(original)
            self.stage = 'roles_restore'
            # 원 admin CREATE만 제외. GRANTED BY/LOGIN/NOLOGIN/owner를 보정하지 않는다.
            role_sql = '\n'.join(line for line in roles.decode().splitlines()
                                 if not re.match(r'CREATE ROLE supabase_admin(?: |;)', line))
            self.sql(self.target, role_sql, write=True)
            observed_roles = self.helper.roles(self.target)
            for role in observed_roles['roles']: role.pop('oid', None)
            require(observed_roles == original['snapshot']['roles'], 'ORIGINAL_ROLES_REQUIRED')
            require(self.sql(self.target, "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema' and c.relkind in('r','p','v','m','f','S');").strip() == b'0', 'TARGET_NOT_EMPTY')
            self.stage = 'archive_restore'
            toc = self.command(['exec', '-i', self.target, 'pg_restore', '--create', '--list'], dump)
            require(self.recovery.native_backup_database_archive(toc, original) == parse(read('archive-metadata.json')), 'ARCHIVE_CHANGED')
            self.command(['exec', self.target, 'dropdb', '-h', '/var/run/postgresql', '-U', 'supabase_admin',
                          '--force', '--maintenance-db=template1', 'postgres'])
            self.command(['exec', '-i', self.target, 'pg_restore', '-h', '/var/run/postgresql', '-U',
                          'supabase_admin', '-d', 'template1', '--create', '--exit-on-error'], dump)
            self.stage = 'target_compare'
            restored = self.state(self.target); write_private(self.root, 'restored-state.json', restored)
            target_locale = self.read_database_locale(self.target, restored, observation='target_archive')
            write_private(self.root, 'target-restored-locale.json', target_locale)
            require(canonical(target_locale) == canonical(self.locale_proof), 'DATABASE_LOCALE_CHANGED')
            # 기존 exact ACL 보완은 새 target의 누락 NULL ACL만 원grantor로 복구한다.
            plan = self.recovery.native_restore_acl_plan(original, restored, sha(canonical(original)))
            write_private(self.root, 'acl-plan.json', plan)
            if plan['sql']: self.sql(self.target, plan['sql'], write=True)
            restored = self.state(self.target); write_private(self.root, 'restored-final-state.json', restored)
            final_locale = self.read_database_locale(self.target, restored, observation='target_final')
            write_private(self.root, 'target-final-locale.json', final_locale)
            require(canonical(final_locale) == canonical(self.locale_proof), 'DATABASE_LOCALE_CHANGED')
            result = self.recovery.native_restore_compare(original, restored, sha(canonical(original)))
            self.closed(self.target); write_private(self.root, 'comparison.json', result)
            verify_graph(self.graph, execution=True)
            passed = True
        except BaseException as exc:
            error = exc; failed_stage = self.stage
        finally:
            # 판정 전 전체 증거를 먼저 저장한다. 원문/계정/비밀은 stdout에 넣지 않는다.
            source_same = False
            try:
                require(work_started, 'SOURCE_FINAL_NOT_CAPTURED_START_GATE_FAILED')
                final_source = self.state(self.source['id'])
                write_private(self.root, 'source-after-private.json', final_source)
                self.recovery.native_restore_compare(original, final_source, sha(canonical(original)))
                source_locale = self.read_database_locale(
                    self.source['id'], final_source, observation='restore_source_final')
                write_private(self.root, 'source-after-locale.json', source_locale)
                require(canonical(source_locale) == canonical(self.locale_proof), 'DATABASE_LOCALE_CHANGED')
                self.closed(self.source['id']); source_same = True
            except BaseException:
                source_same = False
            if self.target:
                try:
                    x = self.own()
                    write_private(self.root, 'target-before-stop-inspect-private.json', x)
                    target_state = 'NOT_CAPTURED_GUARD_OR_QUERY_FAILED'
                    try:
                        write_private(self.root, 'target-before-stop-state-private.json', self.state(self.target))
                        target_state = 'CAPTURED'
                    except BaseException:
                        pass
                    write_private(self.root, 'target-before-stop-evidence.json', {'state': target_state,
                                  'inspection': 'EXACT_NEW_ID_VERIFIED'})
                    if x['State']['Running']: self.raw(['stop', '--time', '10', self.target])
                    require(self.own()['State']['Running'] is False, 'TARGET_REMAINS_RUNNING')
                except BaseException:
                    remaining.append(self.target)
            preservation = False
            try: self.guard(); preservation = True
            except BaseException: pass
            success = passed and source_same and preservation and not remaining
            final = {'scope': SCOPE, 'status': 'PASS_DB121_ONLY' if success else 'FAIL_CLOSED',
                'sourceUnchanged': source_same, 'existingMetadataPreserved': preservation,
                'existingStoredBytes': 'NOT_VERIFIED', 'remainingIds': remaining,
                'ownedTargetId': self.target, 'targetStopped': bool(self.target) and not remaining,
                'targetConfigurationEvidence': {
                    'createdInspectSha256': getattr(self, 'target_created_inspect_sha', None),
                    'beforeStartInspectSha256': getattr(self, 'target_before_start_sha', None),
                    'afterStartInspectSha256': getattr(self, 'target_after_start_sha', None),
                    'startIntentSha256': getattr(self, 'target_start_intent_sha', None),
                    'transitionSha256': getattr(self, 'target_transition_sha', None),
                    'startedIdentitySha256': getattr(self, 'target_start_identity_sha', None),
                    'incarnationRejectedInspectSha256': getattr(self, 'target_incarnation_rejected_sha', None),
                    'originalPins': getattr(self, 'target_pins', None),
                    'runtimePins': getattr(self, 'target_runtime_pins', None)},
                'actualRoleSequenceUnknownDatabaseRestore': passed and source_same and preservation and not remaining,
                'fullRestore': False, 'storage39': 'UNRESOLVED', 'productDeleteAck': 'NOT_RUN',
                'storageBytes': 'NOT_RUN', 'operatingChanged': False, 'activationAllowed': False,
                'unknownOrigin': 'SYNTHETIC_DB_SEED_NOT_PRODUCT_TRANSMISSION',
                'automaticReplay': False, 'graphSha256': sha(canonical(self.graph)),
                'sourceStateSha256': sha(canonical(original)), 'errorType': type(error).__name__ if error else None,
                'failureCode': failure_code(error) if error else None if success else 'FINALIZATION_NOT_PROVEN',
                'stage': stage_code(failed_stage) if error else 'complete' if success else 'finalization',
                'databaseLocaleSha256': sha(canonical(self.locale_proof))}
            final['monitor'] = self.monitor_result()
            write_private(self.root, 'restore-receipt.json', final)
        require(final['status'] == 'PASS_DB121_ONLY', 'DATABASE_RESTORE_FAILED_CLOSED')
        return final


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--graph', type=Path); p.add_argument('--expected-sha256')
    p.add_argument('--run', action='store_true'); p.add_argument('--output', type=Path)
    args = p.parse_args(argv)
    if not args.graph:
        require(not args.run and args.output is None, 'GRAPH_REQUIRED')
        print(json.dumps({'status': 'NOT_RUN', 'scope': SCOPE, 'fullRestore': False,
                          'storage39': 'UNRESOLVED', 'activationAllowed': False})); return
    graph = load_graph(args.graph, args.expected_sha256, execution=args.run)
    if not args.run:
        require(args.output is None, 'OFFLINE_OUTPUT_NOT_ALLOWED')
        print(json.dumps({'status': 'GRAPH_VERIFIED_EXECUTION_NOT_RUN', 'scope': SCOPE,
                          'fullRestore': False, 'activationAllowed': False})); return
    require(args.output is not None and not args.output.exists(), 'FRESH_OUTPUT_REQUIRED')
    parent = guards.private_temp_root(args.output.parent)
    require(args.output.parent == parent, 'OUTPUT_PARENT_REQUIRED')
    args.output.mkdir(mode=0o700)
    runner = DatabaseRestore(graph, args.output)
    result = runner.capture() if graph['phase'] == 'CAPTURE' else runner.restore()
    print(json.dumps({'status': result.get('status', 'SOURCE_CAPTURED_NOT_RESTORED'),
                      'scope': SCOPE, 'fullRestore': False, 'activationAllowed': False}))


if __name__ == '__main__':
    try: main()
    except BaseException:
        print(json.dumps({'status': 'FAIL_CLOSED', 'scope': SCOPE, 'fullRestore': False,
                          'activationAllowed': False}), file=sys.stderr)
        raise SystemExit(1)


def prepare_current124_restore_review(profile, source_manifest):
    """현재124 준비 검토 연결만 수행한다. 기존121 graph/실행 dispatcher와 분리한다.

    source_manifest는 정식 prepare_restore_source_manifest 경로가 만든 준비 결과다.
    단순 JSON의 flags는 실행 승인으로 취급하지 않는다. 실제 target ID/intent/영수증은
    만들어 내지 않으며, 후속 capture adapter와 executor는 별도 검토가 필요하다.
    """
    secure.require(type(profile) is secure.ReviewedCurrentRestoreProfile,
                   'TYPED_CURRENT_RESTORE_PROFILE_REQUIRED')
    p = profile.value()
    secure.require(type(source_manifest) is dict
                   and source_manifest.get('scope') == 'CURRENT_RESTORE_SOURCE_PREPARATION_ONLY'
                   and source_manifest.get('sourceHead') == p['sourceHead']
                   and source_manifest.get('migrationsSha256') == p['migrationsSha256']
                   and source_manifest.get('policyProfileVerified') is True
                   and source_manifest.get('committedSourceVerified') is True
                   and source_manifest.get('executionAllowed') is False
                   and source_manifest.get('runnable') is False
                   and source_manifest.get('fullRestore') is False,
                   'CURRENT_RESTORE_SOURCE_PREPARATION_REQUIRED')
    migrations = source_manifest.get('migrations')
    secure.require(type(migrations) is list and len(migrations) == 124
                   and type(source_manifest.get('migrationCount')) is int
                   and source_manifest['migrationCount'] == 124
                   and secure.digest(secure.canonical(migrations)) == p['migrationsSha256'],
                   'CURRENT_RESTORE_EXACT124_MANIFEST_REQUIRED')
    files = source_manifest.get('sourceFiles')
    secure.require(type(files) is dict and set(files) ==
                   FILES | {'tools/local/prepare_restore_source_manifest.py'}
                   and all(secure._current_sha(value) for value in files.values())
                   and secure.digest(secure.canonical(files)) == source_manifest.get('sourceFilesSha256'),
                   'CURRENT_RESTORE_SOURCE_CLOSURE_REQUIRED')
    return {'scope': 'CURRENT124_DATABASE_RESTORE_PREPARATION_ONLY',
            'status': 'PREPARED_NOT_RUN', 'profileSha256': profile.sha256,
            'sourceHead': p['sourceHead'], 'migrationsSha256': p['migrationsSha256'],
            'sourceFilesSha256': source_manifest['sourceFilesSha256'],
            'sourceIdentity': p['sourceIdentity'], 'captureId': p['captureId'],
            'targetProject': p['targetProject'],
            'relationRosterSha256': secure.digest(secure.canonical(p['relations'])),
            'roleRosterSha256': secure.digest(secure.canonical(p['roles'])),
            'sequenceRosterSha256': secure.digest(secure.canonical(p['sequences'])),
            'executionAllowed': False, 'runnable': False, 'fullRestore': False,
            'runtimeValidation': 'NOT_RUN', 'storageMissing': 39,
            'remaining': ['review fresh current124 capture adapter and executor',
                          'fresh identity memory preservation and O_EXCL intent gates',
                          'actual restore comparison and deletion reapplication', '39 Storage originals']}
