#!/usr/bin/env python3
"""민규: 기존 복원 준비자료의 바이트·연결·범위를 오프라인에서만 검증한다.

실제 복원/역할·sequence 복원/운영 판정을 생성하지 않는다. 외부에서 검토한
두 문서 SHA가 신뢰 시작점이며, private 원문·객체 경로는 출력하지 않는다.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tempfile


class VerificationError(Exception):
    """원문이나 경로를 포함하지 않는 고정 오류 코드."""



# 현재124 전용 오프라인 계약. 역사119/121 소비기나 실제 실행 권한과 합치지 않는다.
# root가 검토한 literal bytes로만 만들며 JSON 문서의 reviewed=true를 신뢰하지 않는다.
class _ReviewedRestoreBytes:
    __slots__ = ('_bytes',)

    def __init__(self, reviewed_bytes):
        require(type(reviewed_bytes) is bytes, 'ROOT_LITERAL_BYTES_REQUIRED')
        try:
            value = json.loads(reviewed_bytes)
        except (ValueError, UnicodeError):
            raise VerificationError('INVALID_REVIEW_JSON') from None
        require(canonical(value) == reviewed_bytes, 'CANONICAL_REVIEW_BYTES_REQUIRED')
        self._validate(value)
        object.__setattr__(self, '_bytes', reviewed_bytes)

    def __setattr__(self, name, value):
        raise VerificationError('IMMUTABLE_REVIEW_REQUIRED')

    def value(self):
        return json.loads(self._bytes)

    @property
    def sha256(self):
        return digest(self._bytes)


def _current_sha(value, length=64):
    return type(value) is str and re.fullmatch('[a-f0-9]{' + str(length) + '}', value) is not None


def _current_uuid(value):
    import uuid
    try:
        return type(value) is str and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def _current_names(values, qualified=False, allow_empty=False):
    pattern = r'[A-Za-z_][A-Za-z0-9_$]{0,62}'
    if qualified:
        pattern += r'\.' + pattern
    return (type(values) is list and (bool(values) or allow_empty)
            and all(type(x) is str and re.fullmatch(pattern, x) for x in values)
            and values == sorted(set(values)))


class ReviewedCurrentRestoreProfile(_ReviewedRestoreBytes):
    __slots__ = ()

    @staticmethod
    def _validate(value):
        keys = {'version', 'scope', 'sourceHead', 'migrationsSha256', 'captureId',
                'sourceIdentity', 'targetProject', 'relations', 'roles', 'sequences',
                'unknownIds', 'deletionPlan', 'sourceStateSha256', 'reappliedStateSha256',
                'storageMetadata', 'storageOriginals', 'storageMissing'}
        require(type(value) is dict and set(value) == keys, 'CURRENT_RESTORE_PROFILE_FIELDS')
        require(type(value['version']) is int and value['version'] == 1
                and value['scope'] == 'CURRENT124_DATABASE_RESTORE_REVIEW_ONLY', 'CURRENT_RESTORE_SCOPE')
        require(_current_sha(value['sourceHead'], 40)
                and all(_current_sha(value[k]) for k in
                        ('migrationsSha256', 'sourceStateSha256', 'reappliedStateSha256')),
                'CURRENT_RESTORE_SOURCE_PINS')
        identity = value['sourceIdentity']
        require(type(identity) is dict and set(identity) == {'id', 'name', 'image'}
                and _current_sha(identity['id']) and _current_sha(identity['image'])
                and type(identity['name']) is str
                and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', identity['name']),
                'CURRENT_RESTORE_SOURCE_IDENTITY')
        require(_current_uuid(value['captureId']) and type(value['targetProject']) is str
                and re.fullmatch(r'jonghyun-backend100-[a-f0-9]{8}', value['targetProject']),
                'CURRENT_RESTORE_CAPTURE_TARGET')
        require(_current_names(value['relations'], True) and _current_names(value['roles'])
                and _current_names(value['sequences'], True, True), 'CURRENT_RESTORE_EXACT_ROSTERS')
        unknown = value['unknownIds']
        require(type(unknown) is list and bool(unknown)
                and all(_current_uuid(x) for x in unknown) and unknown == sorted(set(unknown)),
                'CURRENT_RESTORE_UNKNOWN_ROSTER')
        plan = value['deletionPlan']
        require(type(plan) is list and bool(plan), 'CURRENT_RESTORE_DELETION_PLAN')
        for item in plan:
            require(type(item) is dict and set(item) == {'relation', 'rowIdentity'}
                    and item['relation'] in value['relations']
                    and type(item['rowIdentity']) is str and 0 < len(item['rowIdentity']) <= 512,
                    'CURRENT_RESTORE_DELETION_ENTRY')
        require(len({canonical(x) for x in plan}) == len(plan), 'CURRENT_RESTORE_DUPLICATE_DELETION')
        require(all(type(value[k]) is int for k in
                    ('storageMetadata', 'storageOriginals', 'storageMissing'))
                and (value['storageMetadata'], value['storageOriginals'], value['storageMissing'])
                == (45, 6, 39), 'CURRENT_RESTORE_STORAGE_SCOPE')


_CURRENT_ARTIFACTS = frozenset({'sourceState', 'restoredState', 'reappliedState',
                              'sourceUnknown', 'restoredUnknown', 'reappliedUnknown', 'deletionPlan'})


def _current_reference(value):
    require(type(value) is dict and set(value) == {'path', 'sha256'}
            and type(value['path']) is str and _current_sha(value['sha256']),
            'CURRENT_RESTORE_REFERENCE_FIELDS')
    path = Path(value['path'])
    require(path.is_absolute() and '..' not in path.parts and path.suffix == '.json',
            'CURRENT_RESTORE_REFERENCE_PATH')


class ReviewedCurrentRestoreEvidence(_ReviewedRestoreBytes):
    __slots__ = ()

    @staticmethod
    def _validate(value):
        require(type(value) is dict and set(value) ==
                {'version', 'binding', 'artifacts', 'originalReceipts'}
                and type(value['version']) is int and value['version'] == 1,
                'CURRENT_RESTORE_EVIDENCE_FIELDS')
        binding = value['binding']
        require(type(binding) is dict and set(binding) ==
                {'profileSha256', 'sourceHead', 'migrationsSha256', 'captureId',
                 'sourceIdentity', 'targetProject', 'targetId', 'intentId'}
                and _current_sha(binding['targetId']) and _current_uuid(binding['intentId']),
                'CURRENT_RESTORE_EVIDENCE_BINDING')
        require(type(value['artifacts']) is dict and set(value['artifacts']) == _CURRENT_ARTIFACTS
                and type(value['originalReceipts']) is dict
                and set(value['originalReceipts']) == {'capture', 'restore', 'deletionReapply'},
                'CURRENT_RESTORE_EVIDENCE_REFERENCES')
        refs = list(value['artifacts'].values()) + list(value['originalReceipts'].values())
        for ref in refs:
            _current_reference(ref)
        require(len({x['path'] for x in refs}) == len(refs), 'CURRENT_RESTORE_DISTINCT_REFERENCES')


def _current_restore_state(value, profile):
    require(type(value) is dict and set(value) ==
            {'snapshot', 'rawAuthority', 'effectivePrivileges', 'sequences'},
            'CURRENT_RESTORE_STATE_FIELDS')
    snapshot = value['snapshot']
    require(type(snapshot) is dict and set(snapshot) == {'rows', 'catalog', 'roles'}
            and type(snapshot['rows']) is dict
            and sorted(snapshot['rows']) == profile['relations']
            and all(type(x) is str and re.fullmatch(r'[0-9]+:[a-f0-9]{32}', x)
                    for x in snapshot['rows'].values())
            and type(snapshot['catalog']) is str and bool(snapshot['catalog']),
            'CURRENT_RESTORE_ALL_RELATIONS')
    roles = snapshot['roles']
    require(type(roles) is dict and set(roles) == {'roles', 'memberships'}
            and type(roles['roles']) is list and type(roles['memberships']) is list
            and all(type(x) is dict and type(x.get('rolname')) is str for x in roles['roles'])
            and sorted(x['rolname'] for x in roles['roles']) == profile['roles'],
            'CURRENT_RESTORE_ALL_ROLES')
    require(type(value['rawAuthority']) is dict and set(value['rawAuthority']) ==
            {'database', 'schemas', 'relations', 'columns', 'functions', 'defaults', 'dbRoleSettings'}
            and type(value['effectivePrivileges']) is list
            and bool(value['effectivePrivileges']), 'CURRENT_RESTORE_AUTHORITY_FIELDS')
    sequences = value['sequences']
    require(type(sequences) is dict and sorted(sequences) == profile['sequences'],
            'CURRENT_RESTORE_SEQUENCE_ROSTER')
    for item in sequences.values():
        require(type(item) is list and len(item) == 2 and type(item[0]) is int
                and type(item[1]) is bool, 'CURRENT_RESTORE_SEQUENCE_VALUE')


def verify_current_restore_evidence(profile, evidence, reader=None):
    """새 실행기 없이 root 검토 원파일의 값/연결만 소비한다. 실행 PASS를 만들지 않는다.

    artifacts는 별도 검토된 capture adapter가 남기는 정규 envelope다. 원 producer
    영수증은 originalReceipts로 따로 보존한다. 현재 소비기는 그 producer를 실행하거나
    임의 status를 해석하여 실제 검증/실행 권한으로 승격하지 않는다.
    """
    require(type(profile) is ReviewedCurrentRestoreProfile
            and type(evidence) is ReviewedCurrentRestoreEvidence, 'TYPED_CURRENT_RESTORE_REVIEW_REQUIRED')
    p, packet = profile.value(), evidence.value()
    binding = packet['binding']
    require(binding['profileSha256'] == profile.sha256
            and all(canonical(binding[k]) == canonical(p[k]) for k in
                    ('sourceHead', 'migrationsSha256', 'captureId', 'sourceIdentity', 'targetProject'))
            and binding['targetId'] != p['sourceIdentity']['id'], 'CURRENT_RESTORE_BINDING_CHANGED')
    read = read_bytes if reader is None else reader
    consumed, loaded = {}, {}
    refs = {**packet['artifacts'], **{'original:' + k: v for k, v in packet['originalReceipts'].items()}}
    for kind, ref in refs.items():
        value = read(Path(ref['path'])) if reader is None else read(ref['path'])
        require(type(value) is bytes and digest(value) == ref['sha256'], 'CURRENT_RESTORE_EVIDENCE_BYTES_CHANGED')
        consumed[kind] = {'sha256': digest(value), 'bytes': len(value)}
        if kind in _CURRENT_ARTIFACTS:
            try:
                envelope = json.loads(value)
            except (ValueError, UnicodeError):
                raise VerificationError('CURRENT_RESTORE_ARTIFACT_JSON') from None
            require(type(envelope) is dict and set(envelope) == {'kind', 'binding', 'payload'}
                    and envelope['kind'] == kind
                    and canonical(envelope['binding']) == canonical(binding),
                    'CURRENT_RESTORE_ARTIFACT_BINDING')
            loaded[kind] = envelope['payload']
    for kind in ('sourceState', 'restoredState', 'reappliedState'):
        _current_restore_state(loaded[kind], p)
    source, restored, reapplied = (loaded[k] for k in ('sourceState', 'restoredState', 'reappliedState'))
    require(digest(canonical(source)) == p['sourceStateSha256']
            and canonical(restored) == canonical(source), 'CURRENT_RESTORE_FULL_STATE_MISMATCH')
    require(digest(canonical(reapplied)) == p['reappliedStateSha256']
            and canonical(loaded['deletionPlan']) == canonical(p['deletionPlan']),
            'CURRENT_RESTORE_REAPPLY_STATE_MISMATCH')
    for key in ('rawAuthority', 'effectivePrivileges', 'sequences'):
        require(canonical(source[key]) == canonical(reapplied[key]), 'CURRENT_RESTORE_REAPPLY_AUTHORITY_CHANGED')
    for key in ('catalog', 'roles'):
        require(canonical(source['snapshot'][key]) == canonical(reapplied['snapshot'][key]),
                'CURRENT_RESTORE_REAPPLY_CATALOG_CHANGED')
    planned = {x['relation'] for x in p['deletionPlan']}
    changed = {k for k, value in source['snapshot']['rows'].items()
               if value != reapplied['snapshot']['rows'][k]}
    require(bool(changed) and changed <= planned, 'CURRENT_RESTORE_UNPLANNED_ROW_CHANGE')
    unknown = loaded['sourceUnknown']
    require(type(unknown) is list and all(type(x) is dict and set(x) ==
            {'id', 'status', 'fullReservationAndLedgerRows'} and x['status'] == 'UNKNOWN'
            and type(x['fullReservationAndLedgerRows']) is dict
            and bool(x['fullReservationAndLedgerRows']) for x in unknown)
            and sorted(x['id'] for x in unknown) == p['unknownIds'], 'CURRENT_RESTORE_UNKNOWN_ROWS')
    require(canonical(unknown) == canonical(loaded['restoredUnknown'])
            == canonical(loaded['reappliedUnknown']), 'CURRENT_RESTORE_UNKNOWN_CHANGED')
    # 재독출로 소비 중 파일 교체를 판정 전에 거절한다.
    for kind, ref in refs.items():
        value = read(Path(ref['path'])) if reader is None else read(ref['path'])
        require(type(value) is bytes and digest(value) == consumed[kind]['sha256'],
                'CURRENT_RESTORE_EVIDENCE_CHANGED_DURING_READ')
    return {'status': 'CURRENT124_OFFLINE_EVIDENCE_MATCHED', 'profileSha256': profile.sha256,
            'evidenceSha256': evidence.sha256, 'sourceHead': p['sourceHead'],
            'migrationsSha256': p['migrationsSha256'], 'consumed': consumed,
            'executionAllowed': False, 'runnable': False, 'fullRestore': False,
            'runtimeValidation': 'NOT_INDEPENDENTLY_EXECUTED', 'storageMissing': 39,
            'remaining': ['fresh executor and capture adapter review',
                          'actual current124 database restore and cleanup', '39 Storage originals']}


CURRENT_MANIFEST = '3e7a3b35df08323fa0818d1b9cc473781cfcaced26cfbce53988e1f73bc5f4fd'
OLD119_MANIFEST = '32e9b5f4aa4c6f72d1111139ba6184ac2149c1cf6937de89b7f06755fc9aea3f'
NEW_SQL = {
    'backend/supabase/migrations/20261014010000_operator_receipts_retirement.sql':
        '3ced5ccb5627ae9a2e5c9f3da6d3565af977ec302d390f6cc0bd111c239ac5c5',
    'backend/supabase/migrations/20261014020000_ai_result_state.sql':
        '406d316b51c653d850045a87c4d8e6480c303c5f099a1899f7c1335281856494',
}
DOC = 'docs/collaboration/requests/minkyu/'
SOURCE_PATHS = frozenset({
    'tools/local/prepare_production_backend.py', 'tools/local/prepare_current_policy.py',
    'tools/local/prepare_edge.py', 'tools/local/prepare_migrations.py',
    'tools/local/compare_schema_catalog.py',
    'tests/integration/minkyu/product_connection_restore108_local.py',
    'tests/integration/minkyu/member_cleanup_reconcile_local.py',
    'tests/integration/minkyu/queue_tls_environment.py', 'backend/ownership.json',
    *[DOC + name for name in (
        '2026-10-12-operating-readonly.json', '2026-10-12-operating-roles-proof.json',
        '2026-10-12-operating-catalog-proof.json', '2026-10-12-backend100-application-diff.json',
        '2026-10-13-auth-lifecycle-coverage.json', '2026-10-13-auth-lifecycle-execution.md',
        '2026-10-10-final-schema-storage-restore-static.md')],
})
REQUIREMENT_IDS = frozenset({
    'source_and_target_custody', 'roles_and_privileges', 'sequence_and_physical_state',
    'confirmed_deletion_reapplication', 'unknown_and_ledger_preservation',
    'current121_mapping_and_full_restore',
})
HISTORICAL_SCOPES = (
    'actualSql120C20', 'actualStorage45MetadataExport',
    'actualStorage45OriginalFileMapping', 'storage39LastNamedCandidateAudit',
)
READINESS_KEYS = {
    'version', 'status', 'preparedAt', 'actor', 'sourceHead', 'activationAllowed', 'operatingChanged',
    'execution', 'baselineProgress', 'wbsIds', 'sourceInputs', 'currentMigrationInventory',
    'productionPreparationMapping', 'historicalOperatingInputs', 'restorationRequirements',
    'storageScopes', 'parallelRuntimeBoundary', 'nextAction', 'initialProductionMapping119',
    'initialDocumentSourceInputs', 'integrationUpdatedAt', 'actualRuntimeSourceFrozenAt',
    'workingTreeSupplementsAppliedAfterActualRuntime', 'initialDocumentLaneActions', 'rootIntegration',
}
RUNTIME_KEYS = {
    'version', 'capturedAt', 'actor', 'sourceRuntimeHead', 'baselineProgress',
    'rawTokensOrCredentialsIncluded', 'actualAi24Midnight', 'operatingChanged', 'runs',
}
PREPARATION_RESULT_KEYS = {
    'status', 'mode', 'sql_execution', 'edge_execution', 'output_root', 'source_head',
    'source_mode', 'migration_count', 'canonical_count', 'pending_count', 'functions',
    'source_files', 'database_manifest', 'source_config_sha256', 'config_sha256',
    'config_overlay', 'config_note', 'base_migration_count', 'policy_migration_count',
    'base_snapshot_head', 'base_manifests', 'preparation_note', 'policy_migrations',
}
# 이미 검토된 driver를 실행하거나 비교 코드를 복제하지 않는다. 이 고정 AST는
# 해당 준비 계약의 실제 구현을 읽기 검토한 바이트와 연결한다.
CONTRACT_FUNCTIONS = {
    'native_backup_archive': '3bfe03e50501b075c9aa5f0562ab710e1b7532f10d20a04cddb0574fe90546cd',
    'native_backup_inventory': '3f44f85ba904b7349d501d6cef69b2989065af8be583c313a70ae96f30ecbf92',
    'native_backup_graph': 'b7f14a038cf49fdceed9e3996cd9e9a596a16ebf3d27257e22ea29900e222e0e',
    'native_backup_database_archive': '7530a3af5d4ca353c030ddc484572b7706da4111c8c5fcbb6b7c66185326fd19',
    'native_backup_permissions': 'e076efe164143e72a02ccaee9b6bab275241134ae0b3ece2a2d09e5d4f6f9d36',
    'native_backup_state': '38594b0bf367c992bb2fb1472e58365c9177d7272fc959f9d351d77f257e2926',
    'native_restore_source': 'a6fac8a262b8cdf6f949408029bb665cde9bb9a6e6f1f8fc10d6d95b0e5b366a',
    'native_restore_compare': '15556909660db37a08d29e94b1359b0d41fe194c06f4bb093d621a7c73127a42',
    'run_native_final_backup': '7b5444d76d18cc5ff82aab99e97e7a5027287212d28ce68e8cd12f4fd5344f33',
}
CONTRACT_BINDINGS = {
    'roles_and_privileges': ['native_backup_permissions', 'native_restore_source', 'native_restore_compare'],
    'sequence_and_physical_state': ['native_backup_state', 'native_restore_compare', 'native_backup_archive',
                                    'native_backup_inventory', 'native_backup_database_archive'],
    'confirmed_deletion_reapplication': ['run_native_final_backup'],
    'unknown_and_ledger_preservation': ['native_restore_compare', 'run_native_final_backup'],
    'source_and_target_custody': ['native_backup_graph'],
}
SHA = re.compile(r'[a-f0-9]{64}\Z')
LIMIT = 64 * 1024 * 1024


def require(value, code):
    if not value:
        raise VerificationError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False,
                      separators=(',', ':'), allow_nan=False).encode()


def sha_value(value):
    require(type(value) is str and SHA.fullmatch(value), 'INVALID_EXPECTED_SHA')
    return value


def relative(value):
    require(type(value) is str and value and '\\' not in value, 'INVALID_RELATIVE_PATH')
    path = PurePosixPath(value)
    require(not path.is_absolute() and '..' not in path.parts and str(path) == value,
            'INVALID_RELATIVE_PATH')
    return value


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def _number(_):
    raise VerificationError('INVALID_JSON_NUMBER')


def _finite(value):
    require(len(value) <= 64, 'INVALID_JSON_NUMBER')
    number = float(value)
    require(math.isfinite(number), 'INVALID_JSON_NUMBER')
    return number


def parse(data):
    try:
        return json.loads(data.decode('utf8'), object_pairs_hook=_pairs,
                          parse_float=_finite, parse_constant=_number)
    except VerificationError:
        raise
    except (UnicodeError, ValueError, RecursionError):
        raise VerificationError('INVALID_JSON') from None


def keys(value, expected, code):
    require(type(value) is dict and set(value) == set(expected), code)


def read_bytes(path, *, repo=None, limit=LIMIT, boundary_metadata=False):
    """열린 디렉터리 fd를 잇고 모든 조상 링크/권한 및 안정된 파일을 검사한다."""
    path = Path(path)
    require(path.is_absolute() and path == path.absolute() and '..' not in path.parts,
            'INVALID_INPUT_PATH')
    private = repo is None
    if private:
        boundaries = {Path('/private/tmp'), Path(tempfile.gettempdir()).resolve()}
        roots = [root for root in boundaries if root in path.parents]
        require(bool(roots), 'PRIVATE_TEMP_BOUNDARY_REQUIRED')
        root = max(roots, key=lambda item: len(item.parts))
        # 역사 비민감 준비요약 한 종류만 trusted temp 경계의 원본600 파일이다.
        # 실제 binding/원행/42개 영수증은 전용0700 조상을 계속 요구한다.
        require(path.parent != root or boundary_metadata, 'PRIVATE_DIRECTORY_REQUIRED')
        if path.parent == root and boundary_metadata:
            require(path.name == 'yumidang-wbs-current121-preparation-result.json',
                    'PREPARATION_BOUNDARY_FILENAME')
    else:
        root = Path(repo)
        require(root.is_absolute() and root in path.parents, 'REPOSITORY_PATH_REQUIRED')
    require(root.resolve() == root and not root.is_symlink(), 'INPUT_ANCESTOR_LINK')
    directory = descriptor = None
    directory_descriptors, directory_links = [], []
    try:
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        directory_descriptors.append(directory)
        root_stat = os.fstat(directory)
        require(private or (root_stat.st_uid == os.getuid() and not root_stat.st_mode & 0o022),
                'INVALID_INPUT_DIRECTORY')
        for part in path.relative_to(root).parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=directory)
            directory_descriptors.append(child)
            parent = directory
            directory = child
            entry = os.fstat(directory)
            directory_links.append((parent, part, child, entry))
            require(entry.st_uid == os.getuid() and
                    (stat.S_IMODE(entry.st_mode) == 0o700 if private
                     else not entry.st_mode & 0o022), 'INVALID_INPUT_DIRECTORY')
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=directory)
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                before.st_uid == os.getuid() and before.st_size <= limit and
                (stat.S_IMODE(before.st_mode) == 0o600 if private
                 else not before.st_mode & 0o022), 'INVALID_INPUT_FILE')
        chunks, size = [], 0
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            size += len(chunk)
            require(size <= limit, 'INPUT_SIZE_LIMIT')
            chunks.append(chunk)
        after = os.fstat(descriptor)
        identity = lambda item: (item.st_dev, item.st_ino, item.st_size,
                                 item.st_mtime_ns, item.st_ctime_ns)
        require(identity(before) == identity(after), 'INPUT_CHANGED')
        # 같은 바이트의 새 inode로 원 경로나 부모를 바꿔도 옛 fd 해시로 통과하지 않는다.
        directory_identity = lambda item: (item.st_dev, item.st_ino, item.st_mode,
                                           item.st_uid, item.st_gid)
        require(directory_identity(root_stat) == directory_identity(
            os.stat(root, follow_symlinks=False)), 'INPUT_PATH_CHANGED')
        for parent, part, child, original in directory_links:
            require(directory_identity(original) == directory_identity(os.fstat(child))
                    == directory_identity(os.stat(part, dir_fd=parent, follow_symlinks=False)),
                    'INPUT_PATH_CHANGED')
        require(identity(before) == identity(os.stat(path.name, dir_fd=directory,
                                                    follow_symlinks=False))
                == identity(os.stat(path, follow_symlinks=False)), 'INPUT_PATH_CHANGED')
        return b''.join(chunks)
    except VerificationError:
        raise
    except (OSError, ValueError, RuntimeError):
        raise VerificationError('INPUT_UNAVAILABLE_OR_UNSAFE') from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        for item in reversed(directory_descriptors):
            os.close(item)


def pinned(path, expected, *, repo=None, json_value=True, boundary_metadata=False):
    raw = read_bytes(path, repo=repo, boundary_metadata=boundary_metadata)
    require(digest(raw) == sha_value(expected), 'INPUT_SHA_MISMATCH')
    return parse(raw) if json_value else raw


def literal(raw, name):
    try:
        found = [node.value for node in ast.parse(raw).body if isinstance(node, ast.Assign)
                 and any(isinstance(target, ast.Name) and target.id == name
                         for target in node.targets)]
        require(len(found) == 1, 'SOURCE_CONSTANT_MISSING_OR_DUPLICATE')
        return ast.literal_eval(found[0])
    except VerificationError:
        raise
    except (ValueError, TypeError, SyntaxError, RecursionError):
        raise VerificationError('SOURCE_CONSTANT_INVALID') from None


def metadata(path, repo):
    return parse(read_bytes(path, repo=repo if Path(repo) in Path(path).parents else None))


def verify_sources(repo, ready):
    entries = ready['sourceInputs']
    require(type(entries) is list and len(entries) == 16, 'SOURCE_INPUT_INVENTORY')
    source = {}
    for entry in entries:
        keys(entry, {'path', 'sha256', 'origin'}, 'SOURCE_INPUT_SCHEMA')
        name = relative(entry['path'])
        require(name in SOURCE_PATHS and name not in source, 'SOURCE_INPUT_INVENTORY')
        require(entry['origin'] in ('COMMITTED_AT_SOURCE_HEAD',
                                   'WORKING_TREE_SUPPLEMENT_NOT_COMMITTED'),
                'SOURCE_ORIGIN_INVALID')
        if entry['origin'] != 'COMMITTED_AT_SOURCE_HEAD':
            require(name == 'tools/local/prepare_current_policy.py', 'SOURCE_ORIGIN_INVALID')
        if name == 'tools/local/prepare_current_policy.py':
            require(entry['origin'] == 'WORKING_TREE_SUPPLEMENT_NOT_COMMITTED', 'SOURCE_ORIGIN_INVALID')
        source[name] = pinned(repo / name, entry['sha256'], repo=repo, json_value=False)
    require(set(source) == SOURCE_PATHS, 'SOURCE_INPUT_INVENTORY')
    require(ready['rootIntegration']['currentSourceSupplementCommitted'] is False and
            ready['workingTreeSupplementsAppliedAfterActualRuntime'] is True,
            'SOURCE_ORIGIN_INVALID')
    return source


def migration_map(entries):
    require(type(entries) is list and len(entries) == 121, 'MIGRATION_INVENTORY')
    result, versions, order = {}, set(), []
    for entry in entries:
        require(type(entry) is dict, 'MIGRATION_SCHEMA')
        name = relative(entry.get('path'))
        match = re.fullmatch(r'backend/supabase/migrations/([0-9]{14})_[A-Za-z0-9_]+\.sql', name)
        require(match and entry.get('version') == match[1] and name not in result
                and match[1] not in versions, 'MIGRATION_IDENTITY')
        result[name] = sha_value(entry.get('sha256'))
        versions.add(match[1]); order.append(name)
    require(order == sorted(order), 'MIGRATION_ORDER')
    return result


def verify_migrations(repo, ready, source):
    inv = ready['currentMigrationInventory']
    require(type(inv['count']) is int and inv['count'] == 121 and
            inv['manifestSha256'] == CURRENT_MANIFEST, 'CURRENT121_REQUIRED')
    expected = migration_map(inv['migrations'])
    require(digest(canonical(expected)) == CURRENT_MANIFEST, 'CURRENT121_MANIFEST')
    reviewed = {}
    for filename, variable, count in (
            ('prepare_edge.py', 'GATEWAY_REVIEWED_MIGRATIONS', 41),
            ('prepare_current_policy.py', 'CURRENT_POLICY_REVIEWED', 80)):
        part = literal(source['tools/local/' + filename], variable)
        require(type(part) is dict and len(part) == count and not set(part) & set(reviewed),
                'REVIEWED_MAPPING_INVENTORY')
        reviewed.update(part)
    require(reviewed == expected, 'REVIEWED_MAPPING_MISMATCH')
    require(all(expected.get(path) == value for path, value in NEW_SQL.items()), 'NEW_SQL_SHA')
    old = {path: value for path, value in expected.items() if path not in NEW_SQL}
    require(digest(canonical(old)) == OLD119_MANIFEST, 'HISTORICAL119_CHANGED')
    actual = {}
    directory = repo / 'backend/supabase/migrations'
    for path in directory.iterdir():
        require(path.name.endswith('.sql'), 'UNREVIEWED_MIGRATION_FILE')
        name = str(path.relative_to(repo))
        actual[name] = digest(read_bytes(path, repo=repo))
    require(actual == expected, 'SOURCE_MIGRATIONS_MISMATCH')
    mapping = ready['productionPreparationMapping']
    require(mapping['gatewayCount'] == 41 and mapping['policyCount'] == 80 and
            mapping['reviewedCount'] == 121 and mapping['reviewedManifestSha256'] == CURRENT_MANIFEST
            and mapping['current121PreparationReady'] is True and mapping['historical108Unchanged'] is True
            and mapping['followupCount'] == 13 and mapping['activationAllowed'] is False
            and mapping['operatingChanged'] is False, 'PREPARATION_SCOPE')
    receipt = pinned(mapping['actualArtifactReceipt'], mapping['artifactReceiptSha256'],
                     boundary_metadata=True)
    keys(receipt, {'artifactRoot', 'result'}, 'PREPARATION_RECEIPT_SCHEMA')
    prepared = Path(receipt['artifactRoot'])
    result = receipt['result']
    require(type(result) is dict and set(result) <= PREPARATION_RESULT_KEYS,
            'PREPARATION_RESULT_SCHEMA')
    manifest = metadata(prepared / 'migration-manifest.json', repo)
    current = metadata(prepared / 'current-policy-manifest.json', repo)
    require(current == result, 'PREPARATION_MANIFEST_LINK')
    for value in (result, manifest):
        require(value['status'] == 'READY' and value['source_head'] == ready['sourceHead']
                and value['source_mode'] == 'working_tree_snapshot' and value['migration_count'] == 121
                and value['canonical_count'] == 121 and value['pending_count'] == 0
                and value['base_migration_count'] == 41 and value['policy_migration_count'] == 80
                and value['sql_execution'] == 'NOT_RUN' and value['edge_execution'] == 'NOT_RUN'
                and value['output_root'] == str(prepared), 'PREPARATION_SCOPE')
    require(migration_map(manifest['migrations']) == expected and manifest['count'] == 121,
            'ARTIFACT_MIGRATION_MANIFEST')
    sql_directory = prepared / 'supabase/migrations'
    require({p.name for p in sql_directory.iterdir()} == {Path(p).name for p in expected},
            'ARTIFACT_MIGRATION_INVENTORY')
    for name, value in expected.items():
        pinned(sql_directory / Path(name).name, value, json_value=False)
    return {'count': 121, 'manifestSha256': CURRENT_MANIFEST, 'reviewed': 121,
            'artifactSqlExact': 121, 'historical119Unchanged': True,
            'sqlExecution': 'NOT_RUN', 'edgeExecution': 'NOT_RUN'}


def subset(expected, actual):
    if type(expected) is dict:
        return type(actual) is dict and all(key in actual and subset(value, actual[key])
                                           for key, value in expected.items())
    return type(expected) is type(actual) and expected == actual


def verify_runtime(repo, ready, runtime):
    keys(runtime, RUNTIME_KEYS, 'RUNTIME_SCHEMA')
    require(type(runtime.get('version')) is int and runtime['version'] == 1
            and runtime['actor'] == 'minkyu' and runtime['sourceRuntimeHead'] == ready['sourceHead']
            and runtime['rawTokensOrCredentialsIncluded'] is False
            and runtime['actualAi24Midnight'] == 'NOT_RUN' and runtime['operatingChanged'] is False,
            'RUNTIME_SCOPE')
    require(list(runtime['runs']) == ['d017a001', 'd017a002', 'd017a003', 'd017a004'],
            'RUNTIME_RUN_INVENTORY')
    values, roots, count = {}, {}, 0
    for run, group in runtime['runs'].items():
        keys(group, {'privateRoot', 'evidence'}, 'RUNTIME_GROUP_SCHEMA')
        root = Path(group['privateRoot']); roots[run] = root
        require(root not in list(roots.values())[:-1], 'RUNTIME_ROOT_REUSED')
        seen = set()
        for entry in group['evidence']:
            keys(entry, {'file', 'sha256', 'bytes', 'summary'}, 'RUNTIME_ENTRY_SCHEMA')
            name = relative(entry['file'])
            require(name not in seen and type(entry['bytes']) is int and entry['bytes'] >= 0,
                    'RUNTIME_ENTRY_INVENTORY')
            seen.add(name)
            raw = pinned(root / name, entry['sha256'], json_value=False)
            require(len(raw) == entry['bytes'], 'RUNTIME_RECEIPT_LENGTH')
            value = parse(raw)
            require(subset(entry['summary'], value), 'RUNTIME_SUMMARY_MISMATCH')
            values[run, name] = value; count += 1
    require(count == 42, 'RUNTIME_RECEIPT_INVENTORY')
    run = 'd017a004'; root = roots[run]
    get = lambda name: values.get((run, name))
    fresh = get('fresh121-readiness.json')
    require(type(fresh) is dict and fresh['status'] == 'PASS_FRESH_121_CLOSED_LOCAL_ONLY'
            and fresh['migrationCount'] == 121 and fresh['controls']['cronLaunchActiveJobs'] == 'off'
            and all(v is False for k, v in fresh['controls'].items() if k != 'cronLaunchActiveJobs'),
            'FRESH121_GUARDS')
    state = get('before-stop-synthetic-state.json')
    require(type(state) is dict and state['unknownReservations'] == 2
            and state['pendingReservations'] == 2 and state['externalGuard'] is False
            and state['cron'] == 'off', 'UNKNOWN2_NOT_PRESERVED')
    closure = get('own4-closure.json')
    require(type(closure) is dict and closure['status'] == 'PASS_OWN4_STOPPED_EXISTING_METADATA_PRESERVED'
            and closure['unknownReservationsRetained'] == 2 and closure['ownDataVolumesRetained'] is True
            and closure['ownNetworkRetained'] is True and len(closure['containers']) == 4
            and len({x['id'] for x in closure['containers']}) == 4
            and all(x['stopped'] is True and x['exitCode'] == 0 and x['oomKilled'] is False
                    for x in closure['containers']), 'RUNTIME_CLOSURE')
    review = get('signed-ai-root-review.json')
    require(type(review) is dict and review['sourceHead'] == ready['sourceHead']
            and review['scope'] == 'LOCAL_AUTH_HTTP_RPC_SYNTHETIC_MODEL_ONLY'
            and review['externalProvider'] == 'NOT_RUN' and review['naturalMidnight'] == 'NOT_RUN',
            'BINDING_REVIEW_SCOPE')
    # 비밀이 든 binding은 decode하지 않고 고정 해시만 검사한다.
    pinned(root / 'signed-ai-binding-private.json', review['originalBindingSha256'], json_value=False)
    pinned(root / 'signed-ai-reviewed-binding-private.json', review['reviewedBindingSha256'], json_value=False)
    provisions = [(name, value) for (r, name), value in values.items() if r == run
                  and re.fullmatch(r'auth-provision-[a-f0-9]{32}/receipt\.json', name)]
    require(len(provisions) == 1, 'AUTH6_PROVENANCE_MISSING')
    name, provision = provisions[0]
    scope = name.split('/')[0][len('auth-provision-'):]
    evidence = root / name.split('/')[0]
    signed = root / ('signed-auth-' + scope)
    require(provision['scopeId'] == scope and provision['accounts'] == 6
            and provision['status'] == 'PASS_LOCAL_AUTH6_PROVISION_ONLY'
            and provision['bindingSha256'] == review['originalBindingSha256']
            and provision['creationReceiptRoot'] == str(evidence)
            and provision['signedEvidenceRoot'] == str(signed)
            and provision['originalRowsPreserved'] is True, 'AUTH6_PROVENANCE_LINK')
    for field, filename in (('baselineSha256', 'baseline-private.json'),
                            ('finalSha256', 'final-private.json')):
        pinned(evidence / filename, provision[field], json_value=False)
    signed_receipt = get(signed.name + '/receipt.json')
    cleanup = get(signed.name + '/cleanup.json')
    require(type(signed_receipt) is dict and signed_receipt['status'] == 'PASS'
            and signed_receipt['scope'] == 'SIGNED_LOCAL_AUTH_AI22_23'
            and signed_receipt['originalProtectedRowsPreserved'] is True
            and signed_receipt['externalProvider'] == 'NOT_RUN'
            and signed_receipt['naturalMidnight'] == 'NOT_RUN', 'SIGNED_SCOPE_LINK')
    require(type(cleanup) is dict and cleanup['status'] == 'PASS'
            and cleanup['originalProtectedRowsPreserved'] is True
            and cleanup['sequence'] == 'NOT_VERIFIED', 'SIGNED_CLEANUP_SCOPE')
    cases = {case['scenario']: case for case in signed_receipt['checks']}
    require(len(cases) == 3 and cases['AI22']['observations'] == 28
            and cases['AI22']['dailyCounts'] == [3, 20, 3]
            and cases['AI23']['observations'] == 6, 'SIGNED_AI_SCOPE')
    return {'receiptCount': count, 'allPinnedBytesMatch': True, 'bindingChainVerified': True,
            'auth6BaselineFinalBytesMatch': True, 'unknownReservationsRetained': 2,
            'rowComparison': 'PINNED_SUCCESSFUL_RUN_SCOPE_ONLY_NOT_NEW_FULL_ROW_COMPARISON',
            'sequence': 'NOT_VERIFIED', 'fullRestore': 'NOT_RUN'}


def historical_references(value):
    result = []
    if type(value) is dict:
        if 'path' in value and 'sha256' in value:
            require(type(value['path']) is str and value['path'].startswith('/private/'),
                    'HISTORICAL_REFERENCE_PATH')
            result.append((value['path'], sha_value(value['sha256'])))
        for child in value.values():
            result.extend(historical_references(child))
    elif type(value) is list:
        for child in value:
            result.extend(historical_references(child))
    return result


def historical_present(path):
    """부재 판정도 링크/공개 디렉터리로 숨길 수 없게 한다."""
    path = Path(path)
    roots = {Path('/private/tmp'), Path(tempfile.gettempdir()).resolve()}
    eligible = [root for root in roots if root in path.parents]
    require(bool(eligible), 'HISTORICAL_REFERENCE_PATH')
    root = max(eligible, key=lambda item: len(item.parts))
    require(path.parent != root and '..' not in path.parts, 'HISTORICAL_REFERENCE_PATH')
    current = root
    for part in path.relative_to(root).parts:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            return False
        require(not stat.S_ISLNK(info.st_mode), 'INPUT_ANCESTOR_LINK')
        if current != path:
            require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700
                    and info.st_uid == os.getuid(), 'INVALID_INPUT_DIRECTORY')
    return True


def verify_historical(source, ready):
    coverage = parse(source[DOC + '2026-10-13-auth-lifecycle-coverage.json'])
    require(coverage['actualSql120C20']['scope'] == 'SIMULATED_SQL_JWT_DATABASE_ONLY'
            and coverage['actualSql120C20']['storageActualBytes'] == 'NOT_VERIFIED',
            'HISTORICAL119_SCOPE')
    mapping = coverage['actualStorage45OriginalFileMapping']
    require(mapping['scope'] == 'OFFLINE_ORIGINAL_SQL108_STORAGE_METADATA_TO_RETAINED_BYTES_MAPPING_ONLY'
            and mapping['metadataCount'] == 45 and mapping['matchedOriginalByteFiles'] == 6
            and mapping['metadataWithoutRetainedBytes'] == 39 and mapping['actualOriginal39ByteFiles'] == 0
            and mapping['fullRestore'] == 'NOT_PROVEN' and mapping['readerWholeFAIL_UNKNOWN'] is True,
            'STORAGE_HISTORICAL_SCOPE')
    storage = ready['storageScopes']
    original = storage['originalSql108']
    require((original['metadataObjects'], original['matchedPreservedOriginalFiles'],
             original['missingOriginalBytesObjects']) == (45, 6, 39)
            and original['missingBytesStatus'] == 'HOLD_NOT_RECOVERED'
            and original['fullRestore'] == 'NOT_PROVEN'
            and original['lastMappingReceiptSha256'] == mapping['receipt']['sha256']
            and original['missingListSha256'] == mapping['missing39ManifestSha256']
            and original['lastNamedCandidateAuditReceiptSha256'] ==
                coverage['storage39LastNamedCandidateAudit']['receipt']['sha256']
            and storage['syntheticNative119']['storageMetadataRowsInHistoricalSource'] == 0
            and storage['historicalOperating']['storageMetadataObjectsAt20261012Observation'] == 2
            and storage['historicalOperating']['currentCount'] == 'NOT_OBSERVED', 'STORAGE_SCOPE_MIXED')
    raw = source['tests/integration/minkyu/product_connection_restore108_local.py']
    functions = {node.name: node for node in ast.parse(raw).body
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    require(set(CONTRACT_FUNCTIONS) <= set(functions), 'EXISTING_RESTORE_CONTRACT_MISSING')
    require(all(digest(ast.dump(functions[name], include_attributes=False).encode()) == expected
                for name, expected in CONTRACT_FUNCTIONS.items()), 'EXISTING_RESTORE_CONTRACT_CHANGED')
    refs, scope_counts = [], {}
    for scope in HISTORICAL_SCOPES:
        entries = historical_references(coverage[scope])
        refs.extend((scope, name, value) for name, value in entries)
        scope_counts[scope] = {'expected': len(entries), 'present': 0, 'missing': 0}
    root = Path(literal(raw, 'NATIVE_BACKUP_CANONICAL_ROOT'))
    proofs = literal(raw, 'NATIVE_BACKUP_CANONICAL_PROOFS')
    require(type(proofs) is dict and len(proofs) == 5, 'CANONICAL119_PROOFS')
    refs.extend(('CANONICAL119_SOURCE', str(root / relative(name)), sha_value(value))
                for name, value in proofs.items())
    scope_counts['CANONICAL119_SOURCE'] = {'expected': len(proofs), 'present': 0, 'missing': 0}
    seen, present, missing = {}, 0, 0
    for scope, name, value in refs:
        require(name not in seen or seen[name] == value, 'HISTORICAL_REFERENCE_CONFLICT')
        if name in seen:
            continue
        seen[name] = value
        if not historical_present(name):
            missing += 1
            scope_counts[scope]['missing'] += 1
            continue
        pinned(name, value, json_value=False); present += 1
        scope_counts[scope]['present'] += 1
    return {'pinnedReferenceCount': len(seen), 'presentBytesVerified': present,
            'missingOriginalInputs': missing,
            'status': 'HISTORICAL_PINNED_NOT_REVALIDATED' if missing else 'RETAINED_BYTES_VERIFIED_SCOPE_ONLY',
            'pastPassRevoked': False, 'current121ActualRestore': 'NOT_RUN',
            'roleSequenceActualRestoreVerified': False,
            'confirmedDeletionReapplication': 'HISTORICAL_CONTRACT_ONLY_NOT_CURRENT121_EXECUTION',
            'productAckDeleteDispatch': 'NOT_RUN', 'physicalUnknownDelete': 'NOT_VERIFIED',
            'inputScopes': scope_counts,
            'storage': {'metadataObjects': 45, 'matchedOriginalFiles': 6, 'missingOriginalObjects': 39,
                        'countScope': 'HISTORICAL_ORIGINAL45_MAPPING_NOT_CURRENT_BYTE_REVALIDATION',
                        'currentOriginalFileBytesRevalidated': False, 'status': 'HOLD_NOT_RECOVERED'},
            'preparationContractBindings': {
                key: {'preparationCheck': 'SOURCE_CONTRACT_VERIFIED_INPUTS_CLASSIFIED',
                      'functionAstSha256': {name: CONTRACT_FUNCTIONS[name] for name in names},
                      'sourceSha256': digest(raw),
                      'requiredEvidenceSha256': digest(canonical(next(
                          item['requiredEvidence'] for item in ready['restorationRequirements']
                          if item['id'] == key))),
                      'evidenceScope': ('CANONICAL119_C20_DATABASE_ONLY' if key == 'roles_and_privileges'
                                        else 'HISTORICAL_DRIVER_CONTRACT_NOT_CURRENT121_EXECUTION'),
                      'historicalInputState': 'HISTORICAL_PINNED_NOT_REVALIDATED' if missing
                                              else 'RETAINED_BYTES_VERIFIED_SCOPE_ONLY',
                      'remainingExecution': {
                          'roles_and_privileges': 'CURRENT121_ROLE_ATTRS_MEMBERSHIP_GRANTOR_OWNER_RAW_ACL_EFFECTIVE_COMPARE',
                          'sequence_and_physical_state': 'CURRENT121_SEQUENCE_LAST_VALUE_IS_CALLED_AND_BACKUP_RESTORE_COMPARE',
                          'confirmed_deletion_reapplication': 'CURRENT121_CONFIRMED_SUCCESS_ONLY_REAPPLY_GET_METADATA_FILE_ABSENCE',
                          'unknown_and_ledger_preservation': 'CURRENT121_ORIGINAL_UNKNOWN_DISPATCH_ACK_TASK_BUDGET_FULL_STATE_COMPARE',
                          'source_and_target_custody': 'CURRENT121_FINAL_GRAPH_TARGET_CUSTODY_AND_EXECUTION_APPROVAL',
                      }[key], 'actualCurrent121Verified': False}
                for key, names in CONTRACT_BINDINGS.items()}}


def verify(repo, readiness_path, *, expected_readiness_sha256, runtime_evidence_path,
           expected_runtime_sha256):
    repo = Path(repo)
    ready = pinned(readiness_path, expected_readiness_sha256,
                   repo=repo if repo in Path(readiness_path).parents else None)
    runtime = pinned(runtime_evidence_path, expected_runtime_sha256,
                     repo=repo if repo in Path(runtime_evidence_path).parents else None)
    keys(ready, READINESS_KEYS, 'READINESS_SCHEMA')
    require(type(ready.get('version')) is int and ready['version'] == 1 and ready['actor'] == 'minkyu'
            and ready['activationAllowed'] is False and ready['operatingChanged'] is False
            and ready['rootIntegration']['actualFullRestore'] == 'NOT_RUN'
            and ready['rootIntegration']['operatingActivation'] is False
            and ready['actualRuntimeSourceFrozenAt'] == ready['sourceHead']
            and re.fullmatch(r'[a-f0-9]{40}', ready['sourceHead']), 'READINESS_SCOPE')
    requirements = ready['restorationRequirements']
    require(type(requirements) is list and len(requirements) == 6
            and {x['id'] for x in requirements} == REQUIREMENT_IDS
            and all(type(x['requiredEvidence']) is list and x['requiredEvidence'] for x in requirements)
            and all(x['status'] in ('PREPARATION_ONLY_NOT_EXECUTED_BY_THIS_LANE',
                                   'CURRENT121_MAPPING_READY_FULL_RESTORE_NOT_PROVEN')
                    for x in requirements), 'RESTORATION_CONTRACT_SCOPE')
    old = ready['historicalOperatingInputs']
    require(old['freshExternalQueryPerformed'] is False
            and old['currentOperatingState'] == 'NOT_OBSERVED_ON_2026_10_17'
            and old['historyComparison']['comparisonAtCurrentSourceAgainstHistoricalInputOnly']
                ['currentOperatingPendingCount'] == 'NOT_OBSERVED', 'OPERATING_SNAPSHOT_SCOPE')
    source = verify_sources(repo, ready)
    migrations = verify_migrations(repo, ready, source)
    receipts = verify_runtime(repo, ready, runtime)
    history = verify_historical(source, ready)
    return {'version': 1, 'status': 'PREPARATION_VERIFIED_WITH_HOLDS',
            'sourceInputCount': 16, 'sourceOrigin': 'REVIEWED_WORKING_TREE_SUPPLEMENT_NOT_COMMITTED',
            'current121': migrations, 'runtime': receipts, 'historical': history,
            'operatingSnapshot': 'HISTORICAL_ONLY_NOT_CURRENT_OBSERVATION',
            'fullRestore': 'NOT_RUN', 'roleSequenceActualRestoreVerified': False,
            'activationAllowed': False, 'operatingChanged': False,
            'actualDbNetworkDockerCalls': 0}


def main(argv=None):
    parser = argparse.ArgumentParser(description='복원 준비 증거의 오프라인 검증')
    for flag in ('repo', 'readiness', 'expected-readiness-sha256', 'runtime-evidence',
                 'expected-runtime-sha256'):
        parser.add_argument('--' + flag, required=True)
    args = parser.parse_args(argv)
    try:
        result = verify(Path(args.repo), Path(args.readiness),
                        expected_readiness_sha256=args.expected_readiness_sha256,
                        runtime_evidence_path=Path(args.runtime_evidence),
                        expected_runtime_sha256=args.expected_runtime_sha256)
    except VerificationError as error:
        result = {'version': 1, 'status': 'FAIL_CLOSED', 'code': str(error),
                  'fullRestore': 'NOT_RUN', 'activationAllowed': False, 'operatingChanged': False}
    except (KeyError, TypeError, ValueError, SyntaxError, RecursionError, OSError):
        result = {'version': 1, 'status': 'FAIL_CLOSED', 'code': 'INVALID_EVIDENCE_SCHEMA',
                  'fullRestore': 'NOT_RUN', 'activationAllowed': False, 'operatingChanged': False}
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, allow_nan=False))
    return 0 if result['status'] == 'PREPARATION_VERIFIED_WITH_HOLDS' else 2


if __name__ == '__main__':
    sys.exit(main())
