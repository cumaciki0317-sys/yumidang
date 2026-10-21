"""AI24 오프라인 CLI와 검토 코드용 고정 실행 API. 실제 경계 실행은 NOT_RUN이다."""
import argparse
import base64
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
KST = timezone(timedelta(hours=9))
PROTECTED = ('ai_budget_ledgers', 'ai_budget_reservations', 'ai_account_budget_reservations',
             'ai_account_daily_budget', 'ai_global_daily_budget')
WINDOWS = {
    'initialPrepareSecondsBefore': [1200, 3600],
    'fixturePrepareSecondsBefore': [600, 3600],
    'fixtureFinishMinimumSecondsBefore': 300,
    'resumeSecondsBefore': {'exclusiveMinimum': 5, 'inclusiveMaximum': 120},
    'finalIdleSecondsBefore': {'exclusiveMinimum': 3, 'inclusiveMaximum': 60},
    'preBoundaryStrictMaximumSeconds': 2.2,
    'postBoundaryStrictMaximumSeconds': 2,
    'observerHoldSeconds': 2.5,
    'providerHoldSeconds': 2.8,
}
LIVE_KIND = 'AI24_NATURAL_KST_CONTRACT_ONLY'
SIGNED_KIND = 'SIGNED_LOCAL_AUTH_AI22_23'
CURRENT_SIGNED_KIND = 'SIGNED_LOCAL_AUTH_AI24_CURRENT'
CURRENT_INSPECTOR = 'tests/integration/minkyu/service_profile_readonly_local.py'
CURRENT_HELPERS = tuple('tools/local/' + name + '.py' for name in
    ('prepare_migrations','prepare_database','prepare_edge','prepare_current_policy'))
RESOURCES = {'startupMinimumKiB': 1048576, 'runningMinimumKiB': 786432,
             'probeMaximumSeconds': 3, 'sampleIntervalSeconds': 3}


def require(value, code):
    if not value:
        raise ValueError(code)


def private_root(path):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path, 'CANONICAL_PRIVATE_ROOT_REQUIRED')
    require(not any(p.is_symlink() for p in (path, *path.parents)), 'SYMLINK_FORBIDDEN')
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o700, 'PRIVATE_ROOT_REQUIRED')
    return path


def private_bytes(root, name):
    require(Path(name).name == name and name not in ('.', '..'), 'EXACT_FILE_REQUIRED')
    fd = os.open(root / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                and before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o600
                and before.st_size <= 4 * 1024 * 1024, 'PRIVATE_REGULAR_FILE_REQUIRED')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(4 * 1024 * 1024 + 1)
        after = os.fstat(fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
                and len(data) == before.st_size, 'EVIDENCE_CHANGED')
        return data
    finally:
        os.close(fd)


def inspect_evidence(path):
    root = private_root(path)
    preservation = json.loads(private_bytes(root, 'preservation-manifest.json'))
    entries = preservation['files']
    require(isinstance(entries, list) and len({x['file'] for x in entries}) == len(entries),
            'DUPLICATE_EVIDENCE')
    index = {x['file']: x for x in entries}
    # Select only fixed public observer/result names. Never open credentials,
    # raw startup logs, transport fixtures, configuration or member raw rows.
    candidates = [n for n in index if re.fullmatch(r'ai-observer-[0-9]+\.json', n)]
    require(len(candidates) == 1, 'EXACT_AI_OBSERVER_REQUIRED')
    observer_name = candidates[0]
    log_name = observer_name.replace('observer', 'public').replace('.json', '.log')
    require(log_name in index, 'AI_PUBLIC_LOG_REQUIRED')
    values = {}
    hashes = {}
    for name in (observer_name, log_name):
        data = private_bytes(root, name)
        digest = hashlib.sha256(data).hexdigest()
        require(index[name]['sha256'] == digest and index[name]['bytes'] == len(data), 'EVIDENCE_HASH_CHANGED')
        values[name] = json.loads(data)
        hashes[name] = digest
    observer, result = values[observer_name], values[log_name]
    require(observer['status'] == 'PASS' and observer['mode'] == 'ai'
            and observer['childExitCode'] == 0 and observer['observerFailure'] is None
            and observer['publicLogSha256'] == hashes[log_name], 'AI_OBSERVER_NOT_PASS')
    require(result['status'] == 'PASS'
            and result['scope'] == 'PRODUCT_HTTP_FACTORY_REAL_SQL_RPC_SYNTHETIC_AUTH_BRIDGE_AND_MODEL'
            and result['naturalMidnight'] == result['actualAuthPostgrestNaver'] == result['externalProvider'] == 'NOT_RUN'
            and result['memberFixtureRowsRestored'] is True
            and result['protectedBudgetMetadata'] == 'PRESERVED_WITH_UNKNOWN', 'AI_SCOPE_CHANGED')
    require(result['checks'] == [
        {'scenario': 'AI22', 'observations': 28, 'dailyCounts': [3, 20, 3], 'unknownPreserved': True},
        {'scenario': 'AI23', 'observations': 6, 'globalCap': 12800000, 'eachAccountCap': 3200000, 'unknownPreserved': True},
    ], 'AI22_AI23_CONTRACT_CHANGED')
    return {'publicEvidenceSha256': hashes, 'aiRunnerSha256': observer['sourceSha256'],
            'priorDailyCounts': [3, 20, 3], 'protectedBudgetMetadata': 'PRESERVED_WITH_UNKNOWN',
            'priorLiveBudgetDay': 'NOT_OBSERVED',
            'productGraphMatchToCurrent': 'NOT_VERIFIED',
            'targetBinding': 'MANIFEST_ONLY_LIVE_NOT_OBSERVED'}


class ReviewedCurrentAI24Profile:
    """검토자가 명시한 현행 소스·보존 범위·세 회원의 두 원 세션을 봉인한다."""
    def __init__(self, value):
        validate_current_profile_shape(value)
        self._sealed=canonical(value)
    def descriptor(self):return exact_json(self._sealed)


def validate_current_profile_shape(value):
    require(type(value)is dict and set(value)=={'sourceHead','migrationEntriesSha256','versions',
        'expectedTables','fullTableSetSha256','memberSessions'},'CURRENT_AI24_PROFILE_REQUIRED')
    require(type(value['sourceHead'])is str and re.fullmatch('[a-f0-9]{40}',value['sourceHead']), 'CURRENT_AI24_HEAD')
    digest_required(value['migrationEntriesSha256']);digest_required(value['fullTableSetSha256'])
    versions=value['versions'];tables=value['expectedTables'];members=value['memberSessions']
    require(type(versions)is list and versions and all(type(v)is str and re.fullmatch('[0-9]{14}',v)for v in versions)
        and versions==sorted(set(versions)), 'CURRENT_AI24_VERSIONS')
    require(type(tables)is list and tables and all(type(t)is str and re.fullmatch(r'(auth|public|private|storage|cron|vault)\.[a-z_][a-z_0-9]*',t)for t in tables)
        and tables==sorted(set(tables)) and hashlib.sha256(canonical(tables)).hexdigest()==value['fullTableSetSha256'], 'CURRENT_AI24_TABLES')
    require(type(members)is list and len(members)==3,'CURRENT_AI24_THREE_MEMBERS')
    for member in members:
        require(type(member)is dict and set(member)=={'userId','primarySessionId','secondarySessionId'},'CURRENT_AI24_MEMBER_SESSIONS')
        require(all(type(v)is str and str(uuid.UUID(v))==v for v in member.values()),'CURRENT_AI24_MEMBER_SESSIONS')
    require(len({m['userId']for m in members})==3 and len({m[k]for m in members for k in('primarySessionId','secondarySessionId')})==6,
        'CURRENT_AI24_EXACT_SIX_SESSIONS')
    return value


def verify_current_profile(value,pins,target_versions=None):
    value=validate_current_profile_shape(value)
    path=ROOT/CURRENT_INSPECTOR;raw=path.read_bytes()
    require(path.resolve()==path and not path.is_symlink() and pins.get(CURRENT_INSPECTOR)==hashlib.sha256(raw).hexdigest(),
        'CURRENT_AI24_INSPECTOR_CHANGED')
    module=importlib.util.module_from_spec(importlib.util.spec_from_loader('ai24_current_inspector',loader=None));module.__file__=str(path)
    exec(compile(raw,str(path),'exec'),module.__dict__)
    require(tuple(module.CURRENT_HELPERS)==CURRENT_HELPERS,'CURRENT_AI24_HELPER_CLOSURE')
    source={k:v for k,v in value.items()if k!='memberSessions'}
    history=module.verify_current_profile(source,pins,value['sourceHead'],target_versions)
    require(path.resolve()==path and not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest()==pins[CURRENT_INSPECTOR],
        'CURRENT_AI24_INSPECTOR_CHANGED')
    return history


@contextmanager
def current_constructor_support(pins):
    """실제 SignedRunner 생성 안의 늦은 import도 승인된 helper를 소비한다."""
    path=ROOT/CURRENT_INSPECTOR;raw=path.read_bytes()
    require(path.resolve()==path and not path.is_symlink() and pins.get(CURRENT_INSPECTOR)==hashlib.sha256(raw).hexdigest(),
        'CURRENT_AI24_INSPECTOR_CHANGED')
    module=importlib.util.module_from_spec(importlib.util.spec_from_loader('ai24_constructor_inspector',loader=None));module.__file__=str(path)
    exec(compile(raw,str(path),'exec'),module.__dict__)
    require(tuple(module.CURRENT_HELPERS)==CURRENT_HELPERS,'CURRENT_AI24_HELPER_CLOSURE')
    try:
        with module.current_support(pins):yield
    finally:
        require(path.resolve()==path and not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest()==pins[CURRENT_INSPECTOR],
            'CURRENT_AI24_INSPECTOR_CHANGED')


def current_tables(contract):
    profile=contract.get('currentProfile')
    return None if profile is None else validate_current_profile_shape(profile)['expectedTables']


def contract_pins(current_profile=None):
    paths = set(verified_product_paths()) | {
        'tests/integration/minkyu/content_inspection_http_local.py',
        'tests/integration/minkyu/content_inspection_http_local.ts',
        'tests/integration/jonghyun/isolated_ai_contracts.py',
        'tests/integration/jonghyun/isolated_ai_factory.ts',
        'tests/integration/minkyu/member_cleanup_reconcile_local.py',
        'tests/integration/minkyu/product_connection_restore108_local.py',
        'tools/local/run_database_tests.py', 'tools/local/prepare_isolated_midnight.py',
        'tools/local/prepare_database.py', 'tools/local/prepare_migrations.py',
    }
    if current_profile is not None:
        require(type(current_profile)is ReviewedCurrentAI24Profile,'CURRENT_AI24_TYPED_REVIEW')
        paths.update((CURRENT_INSPECTOR,*CURRENT_HELPERS))
    pins = {}
    for relative in sorted(paths):
        path = ROOT / relative
        require(path.resolve() == path and not path.is_symlink(), 'SOURCE_SYMLINK_FORBIDDEN')
        committed = subprocess.check_output(['git', '-C', str(ROOT), 'show', 'HEAD:' + relative],
                                             stderr=subprocess.DEVNULL, timeout=15)
        require(committed == path.read_bytes(), 'SOURCE_NOT_COMMITTED')
        pins[relative] = hashlib.sha256(committed).hexdigest()
    if current_profile is not None:verify_current_profile(current_profile.descriptor(),pins)
    return pins


def verified_product_paths():
    """검증 전 Python 모듈을 실행하지 않고 HEAD 고정 TS import만 순회한다."""
    pending = [ROOT / 'backend/supabase/functions/ai-chat/index.ts']
    found = set()
    while pending:
        path = pending.pop()
        require(path.resolve() == path and not path.is_symlink()
                and path.is_relative_to(ROOT / 'backend/supabase/functions') and path.suffix == '.ts',
                'PRODUCT_IMPORT_OUTSIDE_ROOT')
        relative = path.relative_to(ROOT).as_posix()
        if relative in found:
            continue
        data = subprocess.check_output(['git', '-C', str(ROOT), 'show', 'HEAD:' + relative],
                                       stderr=subprocess.DEVNULL, timeout=15)
        require(path.read_bytes() == data, 'SOURCE_NOT_COMMITTED')
        found.add(relative)
        for local in re.findall(r'''(?:from\s*|import\s*)["'](\.[^"']+)["']''', data.decode()):
            child = Path(os.path.abspath(path.parent / local))
            pending.append(child)
    return found


def natural_windows(now):
    require(now.tzinfo is not None and now.utcoffset() is not None, 'OFFSET_CLOCK_REQUIRED')
    local = now.astimezone(KST)
    target = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return {'nextKstMidnight': target.isoformat(), 'initialPrepareFrom': (target - timedelta(seconds=3600)).isoformat(),
            'initialPrepareThrough': (target - timedelta(seconds=1200)).isoformat(),
            'resumeFromInclusive': (target - timedelta(seconds=120)).isoformat(),
            'resumeBeforeExclusive': (target - timedelta(seconds=5)).isoformat(),
            'actualClockAndWindowsAtExecution': 'NOT_OBSERVED'}


def build_plan(target, evidence, pins, now):
    require(pins.get('tests/integration/jonghyun/isolated_ai_contracts.py') == evidence['aiRunnerSha256'],
            'AI_EVIDENCE_SOURCE_CHANGED')
    scope = uuid.uuid4().hex
    return {
        'status': 'PREPARED_OFFLINE', 'actualMidnight': 'NOT_RUN', 'executionAllowed': False,
        'scope': 'CURRENT_SOURCE_SYNTHETIC_AI24_PLANNING_ONLY',
        'actualSignedAuthPostgrestNaverOriginalAI24': 'NOT_RUN',
        'target': {'project': target['project'], 'containerId': target['id'], 'image': target['image']},
        'sourcePins': pins, 'sourcePinsSha256': hashlib.sha256(json.dumps(pins, sort_keys=True).encode()).hexdigest(),
        'evidence': evidence, 'windows': dict(WINDOWS), 'naturalTimingPlan': natural_windows(now),
        'ownedIntent': {'scopeId': scope, 'memberIds': [str(uuid.uuid4()) for _ in range(3)],
                        'ledgerId': 'synthetic-midnight-' + scope, 'creationReceipts': 'NOT_CREATED'},
        'baselineContract': {
            'dbObserved': False, 'memberStartedRequestsRequiredBeforeBoundary': [3, 20, 3],
            'priorAI22MembersWereRemoved': True, 'freshAI22PreparationRequired': True,
            'protectedTables': list(PROTECTED), 'existingAllRowsHashesRequired': True,
            'existingUnknownFullRowsMustRemainIdentical': True,
            'newLedgerDoesNotResetSharedDayBudget': True, 'liveNaturalDayHeadroom': 'NOT_OBSERVED',
            'allAuthPublicPrivateStorageTablesIncluded': True,
            'budgetDeltaMustMatchOwnedReceiptsAndNaturalOldNewDays': True,
        },
        'cleanupContract': {
            'onlyCreatedIdsWithReceipts': True,
            'memberOwnedRows': ['auth.users', 'public.profiles', 'private.member_episodes',
                                'private.ai_member_processing', 'private.ai_member_daily_usage',
                                'private.ai_chat_requests', 'private.ai_result_receipts'],
            'episodeRequiresNoNaverIdentity': True, 'preserveUnknownAnd90DayBudgetRows': True,
            'restoreGuardAndRegisteredAccountBaseline': True,
            'compareFullProtectedBaselineAndExpectedOwnedBudgetDelta': True,
            'noBulkDeleteNoTimeShiftNoRefundNoLimitChange': True,
            'actualCleanupVerification': 'NOT_RUN',
        },
        'remainingGates': ['VM_RESTART_AND_BOUNDARY_EXECUTION_NOT_APPROVED',
                           'LIVE_CURRENT_IDENTITY_CLOCK_RESOURCE_AND_HEADROOM',
                           'NEW_OWNED_AI22_LIVE_PREPARATION_AND_BASELINE',
                           'PERSISTENT_PREPARED_INPUT_BINDING_AND_CLEANUP_REVIEW',
                           'FIXED_AI24_ASSEMBLY_REVIEW_AND_ACTUAL_EXECUTION_REQUIRED',
                           'SIGNED_AUTH_ORIGINAL_AI24_REQUIRES_SEPARATE_CONTRACT'],
    }


def build_signed_plan(target, evidence, pins, now, signed_input, prepared_root, selected_user_ids, current_profile=None):
    """검토 호출자가 명시한 원 signed 계정 3명으로 비실행 계획만 조립한다."""
    profile=None
    if current_profile is not None:
        require(type(current_profile)is ReviewedCurrentAI24Profile,'CURRENT_AI24_TYPED_REVIEW')
        profile=current_profile.descriptor();verify_current_profile(profile,pins,target.get('versions'))
        require(selected_user_ids==[m['userId']for m in profile['memberSessions']],'CURRENT_AI24_SELECTED_MEMBERS')
    auth = signed_input_binding(signed_input, prepared_root, profile)
    require(type(selected_user_ids) is list and len(selected_user_ids) == 3
            and all(type(value) is str and str(uuid.UUID(value)) == value
                    for value in selected_user_ids)
            and len(set(selected_user_ids)) == 3, 'EXACT_OWNED_MEMBERS_REQUIRED')
    require(set(selected_user_ids).issubset({x['userId'] for x in auth['accounts']}),
            'EXPLICIT_AI24_SIGNED_MEMBER_SELECTION_REQUIRED')
    require(target['id'] == auth['containers']['db']['id']
            and target['image'] == auth['containers']['db']['image'], 'SIGNED_TARGET_CHANGED')
    require(all(pins.get(key) == value for key, value in auth['sourcePins'].items()),
            'SIGNED_SOURCE_PINS_CHANGED')
    boundary = boundary_time(natural_windows(now)['nextKstMidnight'])
    require(all(account['expiresAt'] >= boundary.timestamp() + 300
                for account in auth['accounts']), 'DECLARED_EXPIRY_DOES_NOT_COVER_BOUNDARY')
    plan = build_plan(target, evidence, pins, now)
    if profile is not None:plan['currentProfile']=profile
    plan['ownedIntent']['memberIds'] = list(selected_user_ids)
    plan['signedPlanBinding'] = {
        'path': auth['path'], 'sha256': auth['sha256'], 'preparedRoot': auth['preparedRoot'],
        'databaseManifestSha256': auth['databaseManifestSha256'],
        'selectedUserIds': list(selected_user_ids), 'actualSignedVerification': 'NOT_OBSERVED',
    }
    return plan


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def live_private_bytes(root, name):
    """라이브 입력은 읽은 fd와 현재 pathname/ctime까지 같은 파일이어야 한다."""
    root = private_root(root)
    require(Path(name).name == name and name not in ('.', '..'), 'EXACT_FILE_REQUIRED')
    path = root / name
    before_path = path.lstat()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and before.st_nlink == 1
                and stat.S_IMODE(before.st_mode) == 0o600 and before.st_size <= 4 * 1024 * 1024
                and (before_path.st_dev, before_path.st_ino) == (before.st_dev, before.st_ino),
                'PRIVATE_REGULAR_FILE_REQUIRED')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(4 * 1024 * 1024 + 1)
        after, current = os.fstat(fd), path.lstat()
        fields = lambda x: (x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns, x.st_ctime_ns,
                            x.st_nlink, x.st_uid, x.st_mode)
        require(fields(before_path) == fields(before) == fields(after) == fields(current)
                and len(data) == before.st_size, 'LIVE_PRIVATE_PATH_CHANGED')
        private_root(root)
        return data
    finally:
        os.close(fd)


def exact_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'DUPLICATE_BINDING_KEY')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs)


def digest_required(value):
    require(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value), 'EXACT_SHA256_REQUIRED')
    return value


def aware_time(value):
    require(isinstance(value, str), 'OFFSET_CLOCK_REQUIRED')
    result = datetime.fromisoformat(value)
    require(result.tzinfo is not None and result.utcoffset() is not None, 'OFFSET_CLOCK_REQUIRED')
    return result


def boundary_time(value):
    result = aware_time(value)
    require(result.utcoffset() == timedelta(hours=9) and result.hour == result.minute
            == result.second == result.microsecond == 0, 'EXACT_KST_MIDNIGHT_REQUIRED')
    return result


def check_window(now, boundary, phase):
    require(now.tzinfo is not None and now.utcoffset() is not None, 'OFFSET_CLOCK_REQUIRED')
    remaining = (boundary - now).total_seconds()
    if phase == 'initial':
        valid = 1200 <= remaining <= 3600
    elif phase == 'fixture':
        valid = 600 <= remaining <= 3600
    elif phase == 'fixture_finish':
        valid = 300 <= remaining <= 3600
    elif phase == 'resume':
        valid = 5 < remaining <= 120
    elif phase == 'final_idle':
        valid = 3 < remaining <= 60
    elif phase == 'pre_boundary':
        valid = 0 < remaining < 2.2
    elif phase == 'post_boundary':
        valid = 0 <= -remaining < 2
    else:
        require(False, 'EXACT_PHASE_REQUIRED')
    require(valid, 'NATURAL_WINDOW_REQUIRED')
    return remaining


def durable_json(root, name, value):
    root = private_root(root)
    require(Path(name).name == name and name.endswith('.json'), 'EXACT_FILE_REQUIRED')
    data = canonical(value)
    require(len(data) <= 4 * 1024 * 1024, 'BINDING_SIZE_BOUND_REQUIRED')
    fd = os.open(root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    for directory in (root, root.parent):
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return hashlib.sha256(data).hexdigest()


def signed_input_binding(path, prepared_root, current_profile=None):
    """구조·해시만 고정한다. 서명/GoTrue/REST 성공 증거로 승격하지 않는다."""
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path, 'CANONICAL_SIGNED_INPUT_REQUIRED')
    raw = live_private_bytes(private_root(path.parent), path.name)
    value = exact_json(raw)
    required = {'version', 'kind', 'preparedRoot', 'databaseManifestSha256', 'origin', 'jwtIssuer',
                'containers', 'credentials', 'accounts', 'evidenceRoot', 'sourcePins',
                'approvedByRoot', 'dockerSlotReady'}
    require(set(value) == required and type(value['version']) is int and value['version'] == 1
            and value['kind'] == (SIGNED_KIND if current_profile is None else CURRENT_SIGNED_KIND), 'EXACT_SIGNED_BINDING_REQUIRED')
    require(type(value['approvedByRoot']) is bool and type(value['dockerSlotReady']) is bool,
            'BOOLEAN_INPUT_PROVENANCE_REQUIRED')
    require(isinstance(value['sourcePins'], dict) and value['sourcePins'], 'SIGNED_SOURCE_PINS_REQUIRED')
    for relative, digest in value['sourcePins'].items():
        require(isinstance(relative, str) and relative and not Path(relative).is_absolute()
                and '..' not in Path(relative).parts and '\\' not in relative
                and Path(relative).as_posix() == relative, 'RELATIVE_SOURCE_PIN_REQUIRED')
        digest_required(digest)
    require(value['preparedRoot'] == str(private_root(prepared_root)), 'PREPARED_ROOT_CHANGED')
    from urllib.parse import urlsplit
    for field in ('origin', 'jwtIssuer'):
        url = urlsplit(value[field])
        require(url.scheme in ('http', 'https') and url.hostname in ('127.0.0.1', 'localhost', '::1')
                and url.port is not None and not url.username and not url.password
                and not url.query and not url.fragment, 'EXACT_LOOPBACK_ENDPOINT_REQUIRED')
    require(value['origin'] == value['origin'].rstrip('/') and urlsplit(value['origin']).path == ''
            and value['jwtIssuer'] == value['origin'] + '/auth/v1', 'EXACT_AUTH_ISSUER_REQUIRED')
    require(set(value['containers']) == {'db', 'auth', 'rest', 'gateway'}, 'EXACT_CONTAINERS_REQUIRED')
    for container in value['containers'].values():
        require(set(container) == {'id', 'name', 'image', 'configSha256', 'hostConfigSha256', 'mountsSha256'},
                'EXACT_CONTAINER_BINDING_REQUIRED')
        require(re.fullmatch('[a-f0-9]{64}', container['id']) and isinstance(container['name'], str)
                and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', container['name'])
                and re.fullmatch('sha256:[a-f0-9]{64}', container['image']), 'CONTAINER_IDENTITY_REQUIRED')
        for field in ('configSha256', 'hostConfigSha256', 'mountsSha256'):
            digest_required(container[field])
    require(len({x['id'] for x in value['containers'].values()}) == 4, 'DISTINCT_CONTAINERS_REQUIRED')
    require(set(value['credentials']) == {'anon', 'service'} and all(
        isinstance(x, str) and 0 < len(x) <= 16384 for x in value['credentials'].values()),
        'SIGNED_CREDENTIAL_SHAPE_REQUIRED')
    accounts = value['accounts']
    require(isinstance(accounts, list) and len(accounts) == 6, 'SIX_SIGNED_ACCOUNTS_REQUIRED')
    for account in accounts:
        require(set(account) == {'userId', 'sessionId', 'accessToken', 'expiresAt', 'authEmail'},
                'SIGNED_ACCOUNT_SHAPE_REQUIRED')
        for field in ('userId', 'sessionId'):
            require(str(uuid.UUID(account[field])) == account[field], 'EXACT_UUID_REQUIRED')
        require(isinstance(account['accessToken'], str) and 0 < len(account['accessToken']) <= 16384,
                'SIGNED_TOKEN_SHAPE_REQUIRED')
        require(type(account['expiresAt']) is int and 0 < account['expiresAt'] <= 253402300799,
                'DECLARED_TOKEN_EXPIRY_REQUIRED')
        require(isinstance(account['authEmail'], str) and 0 < len(account['authEmail']) <= 254
                and re.fullmatch(r'[^\s@]+@[^\s@]+', account['authEmail']), 'AUTH_EMAIL_SHAPE_REQUIRED')
    if current_profile is None:
        for field in ('userId', 'sessionId', 'accessToken', 'authEmail'):
            require(len({x[field] for x in accounts}) == 6, 'DISTINCT_SIGNED_ACCOUNTS_REQUIRED')
    else:
        profile=validate_current_profile_shape(current_profile)
        expected={(m['userId'],m[k])for m in profile['memberSessions']for k in('primarySessionId','secondarySessionId')}
        require({(a['userId'],a['sessionId'])for a in accounts}==expected and len({a['accessToken']for a in accounts})==6,'CURRENT_AI24_EXACT_SIX_SESSIONS')
        for member in profile['memberSessions']:
            pair=[a for a in accounts if a['userId']==member['userId']]
            require(len(pair)==2 and len({a['authEmail']for a in pair})==1,'CURRENT_AI24_MEMBER_EMAIL')
            for a in pair:
                parts=a['accessToken'].split('.');require(len(parts)==3 and all(parts),'CURRENT_AI24_ORIGINAL_JWT')
                claims=exact_json(base64.urlsafe_b64decode(parts[1]+'='*(-len(parts[1])%4)))
                require(type(claims.get('iat'))is int and type(claims.get('exp'))is int and claims['exp']-claims['iat']==3600
                    and claims['exp']==a['expiresAt'] and claims.get('sub')==a['userId'] and claims.get('session_id')==a['sessionId']
                    and claims.get('iss')==value['jwtIssuer'] and claims.get('role')=='authenticated' and claims.get('is_anonymous')is not True
                    and claims.get('email')==a['authEmail'],'CURRENT_AI24_ORIGINAL_JWT')
    require(str(private_root(value['evidenceRoot'])) != str(private_root(prepared_root)),
            'DISTINCT_EVIDENCE_ROOT_REQUIRED')
    return {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
            'databaseManifestSha256': digest_required(value['databaseManifestSha256']),
            'preparedRoot': value['preparedRoot'], 'origin': value['origin'], 'jwtIssuer': value['jwtIssuer'],
            'containers': value['containers'],
            'accounts': [{k: x[k] for k in ('userId', 'sessionId', 'expiresAt')} for x in accounts],
            'sourcePins': value['sourcePins'],
            'inputApprovalProvenance': {k: value[k] for k in ('approvedByRoot', 'dockerSlotReady')},
            'evidenceRoot': value['evidenceRoot'], 'actualSignedVerification': 'NOT_OBSERVED'}


def persist_live_contract(root, plan, signed_input, prepared_root, now):
    """실행하지 않고 단일 재개 intent에 필요한 입력 계약만 영속화한다."""
    require(plan['status'] == 'PREPARED_OFFLINE' and plan['executionAllowed'] is False
            and plan['actualMidnight'] == 'NOT_RUN' and plan['windows'] == WINDOWS,
            'OFFLINE_PLAN_REQUIRED')
    boundary = boundary_time(plan['naturalTimingPlan']['nextKstMidnight'])
    check_window(now, boundary, 'initial')
    require(plan['sourcePins'] and plan['sourcePinsSha256'] == hashlib.sha256(
        json.dumps(plan['sourcePins'], sort_keys=True).encode()).hexdigest(), 'SOURCE_PINS_CHANGED')
    for relative, digest in plan['sourcePins'].items():
        require(not Path(relative).is_absolute() and '..' not in Path(relative).parts,
                'RELATIVE_SOURCE_PIN_REQUIRED')
        digest_required(digest)
    profile=plan.get('currentProfile')
    if profile is not None:
        verify_current_profile(profile,plan['sourcePins'])
        require(plan['ownedIntent']['memberIds']==[m['userId']for m in profile['memberSessions']],'CURRENT_AI24_SELECTED_MEMBERS')
    auth = signed_input_binding(signed_input, prepared_root, profile)
    if 'signedPlanBinding' in plan:
        require(plan['signedPlanBinding'] == {
            'path': auth['path'], 'sha256': auth['sha256'], 'preparedRoot': auth['preparedRoot'],
            'databaseManifestSha256': auth['databaseManifestSha256'],
            'selectedUserIds': list(plan['ownedIntent']['memberIds']),
            'actualSignedVerification': 'NOT_OBSERVED',
        }, 'SIGNED_PLAN_BINDING_CHANGED')
    require(all(plan['sourcePins'].get(k) == v for k, v in auth['sourcePins'].items()),
            'SIGNED_SOURCE_PINS_CHANGED')
    require(all(x['expiresAt'] >= boundary.timestamp() + 300 for x in auth['accounts']),
            'DECLARED_EXPIRY_DOES_NOT_COVER_BOUNDARY')
    require(re.fullmatch('[a-f0-9]{32}', plan['ownedIntent']['scopeId']), 'EXACT_SCOPE_REQUIRED')
    members = plan['ownedIntent']['memberIds']
    require(isinstance(members, list) and len(members) == len(set(members)) == 3
            and all(str(uuid.UUID(x)) == x for x in members), 'EXACT_OWNED_MEMBERS_REQUIRED')
    require(set(members).issubset({x['userId'] for x in auth['accounts']}),
            'EXPLICIT_AI24_SIGNED_MEMBER_SELECTION_REQUIRED')
    require(plan['baselineContract']['protectedTables'] == list(PROTECTED)
            and plan['baselineContract']['dbObserved'] is False
            and plan['baselineContract']['memberStartedRequestsRequiredBeforeBoundary'] == [3, 20, 3]
            and all(plan['baselineContract'][key] is True for key in (
                'existingAllRowsHashesRequired', 'existingUnknownFullRowsMustRemainIdentical',
                'newLedgerDoesNotResetSharedDayBudget', 'allAuthPublicPrivateStorageTablesIncluded',
                'budgetDeltaMustMatchOwnedReceiptsAndNaturalOldNewDays'))
            and all(plan['cleanupContract'][key] is True for key in (
                'onlyCreatedIdsWithReceipts', 'episodeRequiresNoNaverIdentity',
                'preserveUnknownAnd90DayBudgetRows', 'restoreGuardAndRegisteredAccountBaseline',
                'compareFullProtectedBaselineAndExpectedOwnedBudgetDelta',
                'noBulkDeleteNoTimeShiftNoRefundNoLimitChange'))
            and plan['ownedIntent']['creationReceipts'] == 'NOT_CREATED',
            'PROTECTED_BASELINE_CONTRACT_REQUIRED')
    require(plan['target']['containerId'] == auth['containers']['db']['id']
            and plan['target']['image'] == auth['containers']['db']['image'], 'SIGNED_TARGET_CHANGED')
    contract = {'version': 1, 'kind': LIVE_KIND, 'status': 'PERSISTED_CONTRACT_ONLY',
                'executionAllowed': False, 'executorAllowed': False, 'actualMidnight': 'NOT_RUN',
                'scopeId': plan['ownedIntent']['scopeId'], 'target': plan['target'],
                'planSha256': hashlib.sha256(canonical(plan)).hexdigest(),
                'sourcePins': plan['sourcePins'], 'sourcePinsSha256': plan['sourcePinsSha256'],
                'preparedAt': now.isoformat(), 'boundary': boundary.isoformat(),
                'resumeExpiresAtExclusive': (boundary - timedelta(seconds=5)).isoformat(),
                'windows': WINDOWS, 'resources': RESOURCES,
                'signedAuthInput': auth, 'ownedIntent': plan['ownedIntent'],
                'signedSelectedUserIds': members,
                'preprovisionedAuthAccountsAreCleanupOwned': False,
                'baselineContract': plan['baselineContract'], 'cleanupContract': plan['cleanupContract'],
                'headroomContract': {'accountDailyMaximum': 3200000,
                                     'globalMaximum': 'SUM_OF_ACTUALLY_REGISTERED_ACCOUNT_CAPS',
                                     'oldNaturalDayHeadroom': 'NOT_OBSERVED',
                                     'unknownReservationsCannotBeReleased': True,
                                     'ownedLedgerDoesNotResetSharedBudget': True},
                'liveGates': ['CURRENT_CONTAINER_AND_MANIFEST_IDENTITY', 'ACTUAL_GOTRUE_USER_AND_REAL_REST',
                              'ACTUAL_TOKEN_SESSION_EXPIRY_AFTER_BOUNDARY', 'CURRENT_PRODUCT_SOURCE_PINS',
                              'LIVE_OLD_ROWS_AND_UNKNOWN_HASHES', 'NATURAL_DAY_REGISTERED_ACCOUNT_HEADROOM',
                              'EXACT_OWNED_CREATION_RECEIPTS', 'CLOCK_RESOURCE_AND_STRICT_DISPATCH_WINDOWS',
                              'FIXED_AI24_ASSEMBLY_REVIEW_AND_ACTUAL_EXECUTION_REQUIRED']}
    if profile is not None:contract['currentProfile']=profile
    return durable_json(root, 'ai24-live-contract.json', contract)


def load_live_contract(root, expected_sha256, current_pins):
    root = private_root(root)
    raw = live_private_bytes(root, 'ai24-live-contract.json')
    require(hashlib.sha256(raw).hexdigest() == digest_required(expected_sha256), 'LIVE_CONTRACT_CHANGED')
    value = exact_json(raw)
    require(value['kind'] == LIVE_KIND and value['version'] == 1 and value['executionAllowed'] is False
            and value['executorAllowed'] is False
            and value['status'] == 'PERSISTED_CONTRACT_ONLY' and value['actualMidnight'] == 'NOT_RUN',
            'EXACT_NON_EXECUTING_CONTRACT_REQUIRED')
    require(value['sourcePins'] == current_pins and value['windows'] == WINDOWS,
            'CURRENT_SOURCE_PINS_CHANGED')
    require(value['resources'] == RESOURCES, 'RESOURCE_CONTRACT_CHANGED')
    binding = value['signedAuthInput']
    profile=value.get('currentProfile')
    if profile is not None:verify_current_profile(profile,current_pins)
    require(signed_input_binding(binding['path'], binding['preparedRoot'], profile) == binding, 'SIGNED_INPUT_CHANGED')
    boundary_time(value['boundary'])
    return value


def record_resume_intent(root, expected_sha256, current_pins, now):
    """재개 중복을 영속 거절한다. 이 기록은 실행 허가나 live PASS가 아니다."""
    value = load_live_contract(root, expected_sha256, current_pins)
    boundary = boundary_time(value['boundary'])
    check_window(now, boundary, 'resume')
    require(now < aware_time(value['resumeExpiresAtExclusive']), 'RESUME_EXPIRED')
    intent = {'version': 1, 'kind': LIVE_KIND, 'status': 'RESUME_INTENT_ONLY',
              'executionAllowed': False, 'executorAllowed': False, 'actualMidnight': 'NOT_RUN',
              'contractSha256': expected_sha256, 'scopeId': value['scopeId'],
              'boundary': value['boundary'], 'requestedAt': now.isoformat(),
              'liveGates': value['liveGates']}
    return durable_json(root, 'ai24-resume-intent.json', intent)


class TypedMidnightCustody:
    """Root의 Python 코드가 만드는 캡처 source 권한. CLI/JSON 상태에서 생성하지 않는다."""
    __slots__=('_data',)
    def __init__(self,source_head,scope_id,capsule_root,capsule_pins,factory_sha256,node_path,node_sha256,observer_sha256):
        value={'sourceHead':source_head,'scopeId':scope_id,'capsuleRoot':str(capsule_root),'capsulePins':capsule_pins,
            'factorySha256':factory_sha256,'nodePath':str(node_path),'nodeSha256':node_sha256,'observerSha256':observer_sha256}
        require(isinstance(source_head,str) and re.fullmatch(r'[a-f0-9]{40}',source_head)
                and isinstance(scope_id,str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,48}',scope_id), 'MIDNIGHT_CUSTODY_FIELDS')
        for key in ('factorySha256','nodeSha256','observerSha256'):digest_required(value[key])
        object.__setattr__(self,'_data',json.dumps(value,sort_keys=True,separators=(',',':')))
    def __setattr__(self,name,value):raise AttributeError('MIDNIGHT_CUSTODY_IMMUTABLE')
    def descriptor(self):return json.loads(self._data)


@dataclass(frozen=True)
class ReviewedMidnightAssembly:
    """검토한 서버 코드가 주입할 실행 포트. JSON/환경 변수로 만들지 않는다.

    고정 실행 API의 승인 객체이며 CLI·JSON 입력으로 생성하지 않는다.
    함수 검사와 실제 자연 자정 검증을 구분하며, 현재 실제 실행은 NOT_RUN이다.
    """
    contract_sha256: str
    scope_id: str
    boundary: str
    decision_id: str
    ports: object


def executor_status():
    return {'orchestration': 'IMPLEMENTED_FIXED_RUNTIME_APIS_DEFAULT_CLI_CLOSED',
            'signedMidnightFactoryAdapter': 'IMPLEMENTED_NOT_INTEGRATED_OR_ACTUALLY_VERIFIED',
            'liveFixtureAndCleanupAdapter': 'IMPLEMENTED_NOT_INTEGRATED_OR_ACTUALLY_VERIFIED',
            'executorAllowed': False, 'actualMidnight': 'NOT_RUN'}


def execution_assembly(contract, contract_sha, assembly):
    require(type(assembly) is ReviewedMidnightAssembly and assembly.ports is not None,
            'REVIEWED_EXECUTOR_ASSEMBLY_REQUIRED')
    require(assembly.contract_sha256 == contract_sha and assembly.scope_id == contract['scopeId']
            and assembly.boundary == contract['boundary'] and isinstance(assembly.decision_id, str)
            and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', assembly.decision_id),
            'EXECUTOR_ASSEMBLY_BINDING_CHANGED')
    # 승인 flags를 읽지 않는다. 모든 포트는 검토한 고정 조립 코드의 책임이다.
    return assembly.ports


def sql_clock(value, boundary):
    require(set(value) == {'epoch', 'day', 'midnightEpoch', 'nextDay'}
            and type(value['epoch']) in (int, float) and type(value['midnightEpoch']) in (int, float)
            and value['midnightEpoch'] == boundary.timestamp(), 'SQL_CLOCK_BINDING_REQUIRED')
    now = datetime.fromtimestamp(value['epoch'], KST)
    require(value['day'] == now.date().isoformat()
            and value['nextDay'] == boundary.date().isoformat()
            and now.date() in ((boundary - timedelta(days=1)).date(), boundary.date()),
            'SQL_NATURAL_DAY_REQUIRED')
    return now


def execution_checkpoint(contract, ports, boundary, phase=None):
    """다음 호출 전에 현재 입력·대상·실제 인증·자원을 재검증한다."""
    require(ports.current_pins() == contract['sourcePins'], 'CURRENT_SOURCE_PINS_CHANGED')
    binding = contract['signedAuthInput']
    require(signed_input_binding(binding['path'], binding['preparedRoot'], contract.get('currentProfile')) == binding,
            'SIGNED_INPUT_CHANGED')
    identity = ports.identity()
    require(identity == {'containers': binding['containers'],
                         'databaseManifestSha256': binding['databaseManifestSha256']},
            'CURRENT_LIVE_TARGET_CHANGED')
    started = ports.monotonic()
    memory = ports.memory_kib()
    require(type(memory) is int and memory >= RESOURCES['runningMinimumKiB']
            and 0 <= ports.monotonic() - started <= RESOURCES['probeMaximumSeconds'],
            'LIVE_RESOURCE_GUARD_REQUIRED')
    now = sql_clock(ports.clock(), boundary)
    if phase is not None:
        check_window(now, boundary, phase)
    auth = ports.verify_signed_auth()
    expected = binding['accounts']
    require(isinstance(auth, list) and len(auth) == 6, 'ACTUAL_SIGNED_AUTH_REQUIRED')
    for actual, declared in zip(auth, expected):
        require(set(actual) == {'userId', 'sessionId', 'expiresAt', 'gotrueUserId', 'databaseSessionUserId'}
                and all(actual[k] == declared[k] for k in ('userId', 'sessionId', 'expiresAt'))
                and actual['gotrueUserId'] == actual['databaseSessionUserId'] == declared['userId']
                and actual['expiresAt'] >= max(now.timestamp() + 300, boundary.timestamp() + 300),
                'ACTUAL_SIGNED_SESSION_OR_EXPIRY_REQUIRED')
    now = sql_clock(ports.clock(), boundary)
    if phase is not None:
        check_window(now, boundary, phase)
    require(all(x['expiresAt'] >= max(now.timestamp() + 300, boundary.timestamp() + 300)
                for x in auth), 'ACTUAL_SIGNED_SESSION_OR_EXPIRY_REQUIRED')
    return now


def protected_snapshot(value, approved_tables=None):
    require(set(value) == {'rows', 'catalogSha256', 'rolesAclSha256', 'unknownRows'}
            and isinstance(value['rows'], dict) and isinstance(value['unknownRows'], dict)
            and set(value['unknownRows']) == {'private.ai_budget_reservations',
                                             'private.ai_account_budget_reservations'},
            'FULL_PROTECTED_SNAPSHOT_REQUIRED')
    schemas = {name.split('.')[0] for name in value['rows']}
    require((schemas == {'auth', 'public', 'private', 'storage'} if approved_tables is None else sorted(value['rows']) == approved_tables)
            and all('private.' + name in value['rows'] for name in PROTECTED),
            'ALL_PROTECTED_SCHEMAS_REQUIRED')
    for name, digest in {**value['rows'], **value['unknownRows']}.items():
        require(isinstance(name, str) and re.fullmatch('[a-z_][a-z0-9_]*[.][a-z_][a-z0-9_]*', name),
                'EXACT_PROTECTED_ROW_KEY_REQUIRED')
        digest_required(digest)
    digest_required(value['catalogSha256']); digest_required(value['rolesAclSha256'])
    return value


def registered_headroom(value):
    require(set(value) == {'accounts', 'global', 'requiredUnits'}
            and type(value['requiredUnits']) is int and value['requiredUnits'] > 0
            and isinstance(value['accounts'], dict)
            and set(value['accounts']) == {'yumi', 'jonghyun', 'minkyu', 'sungho'},
            'REGISTERED_HEADROOM_REQUIRED')
    registered = 0
    for name, account in value['accounts'].items():
        require(name in ('yumi', 'jonghyun', 'minkyu', 'sungho')
                and set(account) == {'registered', 'cap', 'reserved', 'charged'}
                and type(account['registered']) is bool
                and account['cap'] == 3200000
                and all(type(account[k]) is int and account[k] >= 0 for k in ('cap', 'reserved', 'charged')),
                'ACCOUNT_HEADROOM_POLICY_CHANGED')
        if account['registered']:
            registered += account['cap']
            require(account['reserved'] + account['charged'] + value['requiredUnits'] <= account['cap'],
                    'REGISTERED_ACCOUNT_HEADROOM_EXHAUSTED')
    global_budget = value['global']
    require(set(global_budget) == {'cap', 'reserved', 'charged'}
            and all(type(global_budget[k]) is int and global_budget[k] >= 0 for k in global_budget)
            and global_budget['cap'] == registered and registered > 0
            and global_budget['reserved'] + global_budget['charged'] + value['requiredUnits'] <= registered,
            'REGISTERED_GLOBAL_HEADROOM_EXHAUSTED')


def startup_resource_check(ports):
    started = ports.monotonic()
    memory = ports.memory_kib()
    require(type(memory) is int and memory >= RESOURCES['startupMinimumKiB']
            and 0 <= ports.monotonic() - started <= 3, 'STARTUP_RESOURCE_GUARD_REQUIRED')


class ResourceWatch:
    """준비/실행 중 같은 768MiB·3초 경계를 검사한다. 실패는 취소를 막지 않는다."""
    def __init__(self, ports):
        self.ports, self.stopped, self.failures = ports, threading.Event(), []
        self.thread = threading.Thread(target=self.observe, daemon=True)

    def sample(self):
        started = time.monotonic()
        began = self.ports.monotonic()
        value = self.ports.memory_kib()
        require(type(value) is int and value >= RESOURCES['runningMinimumKiB']
                and 0 <= self.ports.monotonic() - began <= 3
                and 0 <= time.monotonic() - started <= 3, 'LIVE_RESOURCE_GUARD_REQUIRED')

    def observe(self):
        while not self.stopped.is_set():
            started = time.monotonic()
            try:
                self.sample()
            except BaseException:
                self.failures.append('RESOURCE_MONITOR_FAILED')
                self.stopped.set()
                try: self.ports.cancel_factory()
                except BaseException: self.failures.append('RESOURCE_CANCEL_UNPROVEN')
                return
            # 표본 시작 간격은 3초다. 3초 검사 뒤 다시 3초를 더 기다리지 않는다.
            if self.stopped.wait(max(0, started + 3 - time.monotonic())):
                return

    def start(self):
        self.thread.start()

    def check(self):
        require(not self.failures, 'RESOURCE_MONITOR_FAILED')

    def end(self):
        self.stopped.set()
        if self.thread.ident is not None:
            self.thread.join(timeout=3)
            require(not self.thread.is_alive(), 'RESOURCE_MONITOR_DID_NOT_END')


def prepare_live_execution(root, contract_sha, current_pins, assembly):
    """실제 포트를 조립한 경우에만 fixture를 한 번 준비하는 실행 흐름이다."""
    root = private_root(root)
    contract = load_live_contract(root, contract_sha, current_pins)
    ports = execution_assembly(contract, contract_sha, assembly)
    boundary = boundary_time(contract['boundary'])
    execution_checkpoint(contract, ports, boundary, 'fixture')
    startup_resource_check(ports)
    watch, intent_sha = ResourceWatch(ports), None
    try:
        watch.start()
        baseline = protected_snapshot(ports.snapshot(), current_tables(contract))
        execution_checkpoint(contract, ports, boundary, 'fixture')
        # 긴 snapshot 이후 첫 fixture 변이 바로 전에 1GiB를 다시 증명한다.
        startup_resource_check(ports)
        now = sql_clock(ports.clock(), boundary)
        check_window(now, boundary, 'fixture')
        watch.check()
        intent_sha = durable_json(root, 'ai24-fixture-intent.json', {
            'contractSha256': contract_sha, 'scopeId': contract['scopeId'],
            'requestedAtSql': now.isoformat(), 'baseline': baseline,
            'status': 'SINGLE_FIXTURE_PREPARATION_INTENT', 'noRetry': True})
        # 별도 영속 journal로 원래 네 등록 flag/guard를 묶고 바꾼 뒤,
        # 실제 등록 목록의 합계를 읽는다. 오프라인 12.8M 추정은 쓰지 않는다.
        ports.activate_fixture_registration(intent_sha)
        registered_headroom(ports.headroom())
        # 원 ledger/계정 시간·UNKNOWN을 바꾸지 않는 포트만 연결할 수 있다.
        state = ports.prepare_fixture(intent_sha)
        require(set(state) == {'scopeId', 'counts', 'nextCounts', 'baseline', 'budget', 'creationReceipts',
                               'fixtureUnknownRows', 'portStateSha256'}
                and state['scopeId'] == contract['scopeId'] and state['counts'] == [3, 20, 3]
                and state['nextCounts'] == [0, 0, 0] and state['baseline'] == baseline,
                'ACTUAL_FIXTURE_BASELINE_REQUIRED')
        digest_required(state['portStateSha256'])
        require(set(state['fixtureUnknownRows']) == {'private.ai_budget_reservations',
                                                    'private.ai_account_budget_reservations'}
                and all(digest_required(v) for v in state['fixtureUnknownRows'].values()),
                'FIXTURE_UNKNOWN_FULL_ROWS_REQUIRED')
        require(isinstance(state['creationReceipts'], list) and state['creationReceipts']
                and all(set(x) == {'table', 'id', 'scopeId'} and x['scopeId'] == contract['scopeId']
                        and x['table'] not in ('auth.users', 'auth.sessions', 'public.profiles')
                        and str(uuid.UUID(x['id'])) == x['id'] for x in state['creationReceipts']),
                'OWNED_CREATION_RECEIPTS_REQUIRED')
        execution_checkpoint(contract, ports, boundary, 'fixture_finish')
        require(ports.original_rows() == baseline, 'ORIGINAL_PROTECTED_ROWS_CHANGED')
        watch.end()
        watch.check()
        return durable_json(root, 'ai24-live-prepared.json', {
            'contractSha256': contract_sha, 'scopeId': contract['scopeId'],
            'boundary': contract['boundary'], 'prepared': state,
            'actualMidnight': 'NOT_RUN', 'status': 'ACTUAL_FIXTURE_PREPARED_ONLY'})
    except BaseException:
        try:
            if intent_sha is not None or watch.failures:
                ports.cancel_factory()
        finally:
            if intent_sha is not None:
                ports.cleanup_owned(intent_sha)
        raise
    finally:
        watch.end()


def verify_midnight_effects(before, result, boundary, selected_users, held_marker):
    require(set(result) == {'dailyBefore', 'dailyAfter', 'effects', 'budget', 'originalRows',
                            'nativeExternalAttempts', 'rawPersistedRows', 'fixtureUnknownRows'}
            and result['dailyBefore'] == [4, 20, 3] and result['dailyAfter'] == [0, 1, 1]
            and type(result['nativeExternalAttempts']) is int and result['nativeExternalAttempts'] == 0
            and type(result['rawPersistedRows']) is int and result['rawPersistedRows'] == 0
            and result['originalRows'] == before['baseline']
            and result['fixtureUnknownRows'] == before['fixtureUnknownRows'],
            'MIDNIGHT_FULL_BOUNDARY_PROOF_REQUIRED')
    effects = result['effects']
    require(isinstance(effects, list) and len(effects) == 3, 'THREE_ACTUAL_EFFECTS_REQUIRED')
    require(all(effects[0].get(field) == held_marker.get(field) for field in
                ('requestId', 'reservationId', 'userId', 'accountId', 'day'))
            and effects[0].get('originalLeaseSha256') == held_marker.get('leaseSha256'),
            'HELD_ORIGINAL_EFFECT_BINDING_CHANGED')
    old_day = (boundary - timedelta(days=1)).date().isoformat()
    expected_budget = json.loads(json.dumps(before['budget']))
    requests, reservations = set(), set()
    for index, effect in enumerate(effects):
        require(set(effect) == {'requestId', 'reservationId', 'accountId', 'userId', 'day', 'finished',
                                'originalLeaseSha256', 'storedLeaseSha256', 'usage',
                                'resultCount', 'settledEpoch'}, 'EXACT_STORED_EFFECT_REQUIRED')
        day = old_day if index == 0 else boundary.date().isoformat()
        require(effect['userId'] == selected_users[index] and effect['day'] == day
                and effect['finished'] is True and effect['usage'] == [1, 1]
                and type(effect['resultCount']) is int and effect['resultCount'] == 1
                and type(effect['settledEpoch']) in (int, float)
                and effect['settledEpoch'] >= boundary.timestamp()
                and digest_required(effect['originalLeaseSha256']) == effect['storedLeaseSha256']
                and effect['accountId'] in ('yumi', 'jonghyun', 'minkyu', 'sungho'),
                'ORIGINAL_DAY_LEASE_SETTLEMENT_REQUIRED')
        for field, seen in (('requestId', requests), ('reservationId', reservations)):
            require(str(uuid.UUID(effect[field])) == effect[field] and effect[field] not in seen,
                    'DISTINCT_ORIGINAL_EFFECT_IDS_REQUIRED')
            seen.add(effect[field])
        for scope, key in (('global', day), ('accounts', effect['accountId'] + ':' + day)):
            values = expected_budget[scope].get(key, [0, 0])
            require(len(values) == 2 and all(type(v) is int and v >= 0 for v in values),
                    'EXACT_BUDGET_BASELINE_REQUIRED')
            expected_budget[scope][key] = [values[0], values[1] + 2]
    require(result['budget'] == expected_budget, 'ORIGINAL_RESERVED_OR_DAY_BUDGET_CHANGED')


def execute_live_midnight(root, contract_sha, prepared_sha, current_pins, assembly):
    """단일 실행 커널. 검토 코드용 고정 어댑터 API이며 기본 CLI는 닫혀 있다."""
    root = private_root(root)
    contract = load_live_contract(root, contract_sha, current_pins)
    ports = execution_assembly(contract, contract_sha, assembly)
    raw = live_private_bytes(root, 'ai24-live-prepared.json')
    require(hashlib.sha256(raw).hexdigest() == digest_required(prepared_sha), 'LIVE_PREPARATION_CHANGED')
    state = exact_json(raw)
    require(state['contractSha256'] == contract_sha and state['scopeId'] == contract['scopeId']
            and state['boundary'] == contract['boundary']
            and state['status'] == 'ACTUAL_FIXTURE_PREPARED_ONLY' and state['actualMidnight'] == 'NOT_RUN',
            'EXACT_LIVE_PREPARATION_REQUIRED')
    boundary = boundary_time(contract['boundary'])
    ports.hydrate_prepared(state['prepared']['portStateSha256'])
    now = execution_checkpoint(contract, ports, boundary, 'resume')
    require(ports.original_rows() == state['prepared']['baseline'], 'ORIGINAL_PROTECTED_ROWS_CHANGED')
    require(ports.counts() == {'before': [3, 20, 3], 'after': [0, 0, 0]}, 'PREPARED_DAILY_ROWS_CHANGED')
    registered_headroom(ports.headroom())
    now = execution_checkpoint(contract, ports, boundary, 'resume')
    startup_resource_check(ports)
    now = sql_clock(ports.clock(), boundary)
    check_window(now, boundary, 'resume')
    # 같은 파일을 계약-only 재개와 공유해 둘 중 어느 경로도 두 번째 전송을 허용하지 않는다.
    intent_sha = record_resume_intent(root, contract_sha, current_pins, now)
    watch = ResourceWatch(ports)
    stopped, failures = watch.stopped, watch.failures
    observer = watch.thread
    cleanup_attempted = False

    try:
        watch.start()
        idle_deadline = ports.monotonic() + 120
        while True:
            require(not stopped.is_set() and ports.monotonic() < idle_deadline, 'BOUNDARY_WAIT_ABORTED')
            now = sql_clock(ports.clock(), boundary)
            remaining = (boundary - now).total_seconds()
            require(remaining > 3, 'NATURAL_START_WINDOW_MISSED')
            if remaining <= 60:
                break
            ports.wait(min(1, remaining - 60))
        execution_checkpoint(contract, ports, boundary, 'final_idle')
        execution_checkpoint(contract, ports, boundary, 'final_idle')
        startup_resource_check(ports)
        check_window(sql_clock(ports.clock(), boundary), boundary, 'final_idle')
        ports.warm_factory('held')
        deadline = ports.monotonic() + 60
        while True:
            require(not stopped.is_set() and ports.monotonic() < deadline, 'BOUNDARY_WAIT_ABORTED')
            now = sql_clock(ports.clock(), boundary)
            remaining = (boundary - now).total_seconds()
            require(remaining > 0, 'NATURAL_START_WINDOW_MISSED')
            if remaining < 2.2:
                break
            ports.wait(min(.1, max(.01, remaining - 2)))
        require(not stopped.is_set(), 'BOUNDARY_WAIT_ABORTED')
        # 포트는 즉시 반환하는 시작 핸들이다. SQL witness와 모델 barrier는 병행한다.
        ports.start_factory('held', intent_sha)
        hold_deadline = ports.monotonic() + 2.5
        marker = ports.wait_provider_marker(min(2.5, max(0, hold_deadline - ports.monotonic())))
        before_clock = ports.clock(timeout=min(.75, max(.001, hold_deadline - ports.monotonic())))
        before_now = sql_clock(before_clock, boundary)
        check_window(before_now, boundary, 'pre_boundary')
        require(set(marker) == {'requestId', 'reservationId', 'userId', 'accountId', 'day',
                                'leaseSha256', 'units', 'pending', 'startedEpoch'}
                and marker['userId'] == contract['signedSelectedUserIds'][0]
                and marker['accountId'] in ('yumi', 'jonghyun', 'minkyu', 'sungho')
                and marker['pending'] is True and type(marker['units']) is int and marker['units'] > 0
                and type(marker['startedEpoch']) in (int, float)
                and marker['startedEpoch'] < boundary.timestamp(), 'ORIGINAL_PENDING_RESERVATION_REQUIRED')
        for field in ('requestId', 'reservationId'):
            require(str(uuid.UUID(marker[field])) == marker[field], 'EXACT_UUID_REQUIRED')
        digest_required(marker['leaseSha256'])
        original = ports.reservation_proof(marker, timeout=min(.75, max(.001, hold_deadline - ports.monotonic())))
        require(original == marker and marker['day'] == before_now.date().isoformat(),
                'ORIGINAL_PENDING_RESERVATION_REQUIRED')
        while True:
            require(not stopped.is_set() and ports.monotonic() < hold_deadline, 'NATURAL_OBSERVER_ABORTED')
            after_clock = ports.clock(timeout=min(.5, max(.001, hold_deadline - ports.monotonic())))
            after_now = sql_clock(after_clock, boundary)
            if after_now >= boundary:
                check_window(after_now, boundary, 'post_boundary')
                break
            require(after_now.date() == before_now.date(), 'SQL_NATURAL_DAY_REQUIRED')
            ports.wait(.03)
        require(not stopped.is_set() and ports.monotonic() < hold_deadline, 'NATURAL_OBSERVER_ABORTED')
        release = {'requestId': marker['requestId'], 'reservationId': marker['reservationId'],
                   'beforeDay': before_clock['day'], 'afterDay': after_clock['day'],
                   'beforeEpoch': before_clock['epoch'], 'afterEpoch': after_clock['epoch']}
        durable_json(root, 'midnight-provider-release.json', release)
        ports.finish_factory('held', 10)
        execution_checkpoint(contract, ports, boundary)
        require(not stopped.is_set(), 'NATURAL_OBSERVER_ABORTED')
        ports.start_factory('new-day', intent_sha)
        ports.finish_factory('new-day', 30)
        require(not failures and not stopped.is_set(), 'RESOURCE_MONITOR_FAILED')
        result = ports.effect_proof()
        verify_midnight_effects(state['prepared'], result, boundary, contract['signedSelectedUserIds'], marker)
        stopped.set()
        observer.join(timeout=3)
        require(not observer.is_alive() and not failures, 'RESOURCE_MONITOR_DID_NOT_END')
        cleanup_attempted = True
        ports.cleanup_owned(intent_sha)
        require(ports.cleanup_proof() == {'originalRows': state['prepared']['baseline'],
                                         'childrenExited': True, 'ownedOnly': True,
                                         'preservedBudget': result['budget']}, 'ACTUAL_CLEANUP_UNPROVEN')
    except BaseException:
        try:
            ports.cancel_factory()
        finally:
            if not cleanup_attempted:
                cleanup_attempted = True
                ports.cleanup_owned(intent_sha)
        raise
    finally:
        stopped.set()
        if observer is not None and observer.ident is not None:
            observer.join(timeout=3)
            require(not observer.is_alive(), 'RESOURCE_MONITOR_DID_NOT_END')
    require(not failures, 'RESOURCE_MONITOR_FAILED')
    return durable_json(root, 'ai24-natural-boundary-receipt.json', {
        'status': 'PASS_NATURAL_SQL_BOUNDARY_LOCAL_SYNTHETIC_MODEL',
        'scopeId': contract['scopeId'], 'contractSha256': contract_sha,
        'preparedSha256': prepared_sha, 'boundary': contract['boundary'],
        'actualSignedAuth': 'VERIFIED_BY_REVIEWED_PORT', 'actualMidnight': 'PASS',
        'dailyBefore': result['dailyBefore'], 'dailyAfter': result['dailyAfter'],
        'effectsSha256': hashlib.sha256(canonical(result)).hexdigest(),
        'externalProviderQualityCostNaverRealMember': 'NOT_RUN'})


class FixedSignedMidnightPorts:
    """고정 SignedMidnightRunner와 실제 SQL/GoTrue/Node 전송을 연결한다.

    임의 명령·모듈 경로·환경 승인 입력은 받지 않는다. 이 구현은 검토와
    통합 전이며 생성자/메서드를 실제 환경에서 호출한 검증 결과는 없다.
    """
    RUNNER_PATH = 'tests/integration/jonghyun/isolated_ai_contracts.py'

    def __init__(self, root, contract, custody=None):
        require(custody is None or type(custody) is TypedMidnightCustody, 'MIDNIGHT_TYPED_CUSTODY_REQUIRED')
        if custody is not None:
            require(custody.descriptor()['scopeId'] == contract['scopeId'], 'MIDNIGHT_CUSTODY_BINDING')
        self.root, self.contract = private_root(root), contract
        self.current_pins()
        path = ROOT / self.RUNNER_PATH
        data = path.read_bytes()
        require(hashlib.sha256(data).hexdigest() == contract['sourcePins'][self.RUNNER_PATH],
                'CURRENT_SOURCE_PINS_CHANGED')
        # HEAD/영속 pin을 확인한 캡처 바이트만 실행한다. loader의 pycache는 쓰지 않는다.
        spec = importlib.util.spec_from_file_location('_ai24_fixed_signed_runner', path)
        module = importlib.util.module_from_spec(spec)
        helper_path = ROOT / 'tools/local/run_database_tests.py'
        helper_data = helper_path.read_bytes()
        require(hashlib.sha256(helper_data).hexdigest()
                == contract['sourcePins']['tools/local/run_database_tests.py'], 'CURRENT_SOURCE_PINS_CHANGED')
        helper_spec = importlib.util.spec_from_file_location('run_database_tests', helper_path)
        helper = importlib.util.module_from_spec(helper_spec)
        old_path, old_helper = list(sys.path), sys.modules.get('run_database_tests')
        try:
            # 다른 worktree의 module cache를 쓰지 않는다. 검증한 캡처 helper만 연결한다.
            exec(compile(helper_data, str(helper_path), 'exec'), helper.__dict__)
            require(helper.ROOT == ROOT, 'FIXED_HELPER_ROOT_CHANGED')
            sys.modules['run_database_tests'] = helper
            sys.path[:0] = [str(ROOT / 'tools/local'), str(path.parent)]
            exec(compile(data, str(path), 'exec'), module.__dict__)
        finally:
            sys.path[:] = old_path
            if old_helper is None: sys.modules.pop('run_database_tests', None)
            else: sys.modules['run_database_tests'] = old_helper
        require(module.REPO == ROOT and hasattr(module, 'SignedMidnightRunner'),
                'SIGNED_MIDNIGHT_ADAPTER_NOT_INTEGRATED')
        for name in ('validate_original_accounts', 'read_sql', 'original_rows', 'snapshot', 'counts',
                     'budget', 'unknown_rows', 'prepare_units', 'activate_fixture_registration',
                     'start_factory', 'finish_factory', 'cancel_factory', 'cleanup_owned', 'warm_factory',
                     'export_resume_state', 'restore_resume_state'):
            require(callable(getattr(module.SignedMidnightRunner, name, None)),
                    'SIGNED_MIDNIGHT_ADAPTER_NOT_INTEGRATED')
        auth = contract['signedAuthInput']
        raw = live_private_bytes(private_root(Path(auth['path']).parent), Path(auth['path']).name)
        self.binding = exact_json(raw)
        kwargs={}
        if 'currentProfile'in contract:
            verify_current_profile(contract['currentProfile'],contract['sourcePins'])
            kwargs['current_profile']=module.ReviewedCurrentMidnightProfile(contract['currentProfile'])
        def construct():
            return module.SignedMidnightRunner(Path(auth['preparedRoot']), self.binding,
                contract['signedSelectedUserIds'], self.root, contract['scopeId'],
                boundary_time(contract['boundary']).timestamp(), **kwargs)
        if 'currentProfile'in contract:
            with current_constructor_support(contract['sourcePins']):self.runner=construct()
        else:self.runner=construct()
        if custody is not None:
            value = custody.descriptor()
            authority = module.TypedMidnightCustody(value['sourceHead'], value['scopeId'], value['capsuleRoot'],
                value['capsulePins'], value['factorySha256'], value['nodePath'], value['nodeSha256'], value['observerSha256'])
            module.midnight_bind_custody(self.runner, authority)
        self.cancelled = threading.Event()
        self.cleanup_active = False
        original_sql, original_start = self.runner.sql, self.runner.start_factory
        def guarded_sql(statement):
            require(not self.cancelled.is_set() or self.cleanup_active, 'EXECUTION_CANCELLED')
            return original_sql(statement)
        def guarded_start(*args, **kwargs):
            require(not self.cancelled.is_set(), 'EXECUTION_CANCELLED')
            return original_start(*args, **kwargs)
        self.runner.sql, self.runner.start_factory = guarded_sql, guarded_start
        self.handles, self.observations = {}, []
        self.warm_capabilities = {}
        self.baseline = self.baseline_rows = self.cleanup_result = self.result = None
        self.unknown_id = None

    def current_pins(self):
        if 'currentProfile'in self.contract:verify_current_profile(self.contract['currentProfile'],self.contract['sourcePins'])
        result = {}
        for relative, expected in self.contract['sourcePins'].items():
            path = ROOT / relative
            require(not Path(relative).is_absolute() and '..' not in Path(relative).parts
                    and path.resolve() == path and not path.is_symlink(), 'SOURCE_SYMLINK_FORBIDDEN')
            result[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
            require(result[relative] == expected, 'CURRENT_SOURCE_PINS_CHANGED')
        if 'currentProfile'in self.contract:verify_current_profile(self.contract['currentProfile'],result)
        return result

    def identity(self):
        self.runner.signed_identity()
        a = self.contract['signedAuthInput']
        require(hashlib.sha256(live_private_bytes(private_root(a['preparedRoot']), 'database-manifest.json')).hexdigest()
                == a['databaseManifestSha256'], 'CURRENT_LIVE_TARGET_CHANGED')
        return {'containers': a['containers'], 'databaseManifestSha256': a['databaseManifestSha256']}

    def monotonic(self): return time.monotonic()
    def wait(self, seconds): time.sleep(seconds)

    def memory_kib(self):
        result = subprocess.run(self.runner.base + ['exec', self.runner.target['id'], 'cat', '/proc/meminfo'],
                                capture_output=True, timeout=3)
        require(result.returncode == 0 and len(result.stdout) <= 65536, 'RESOURCE_ACQUISITION_FAILED')
        lines = re.findall(rb'^MemAvailable:[ \t]+([0-9]+)[ \t]+kB$', result.stdout, re.MULTILINE)
        require(len(lines) == 1, 'RESOURCE_PARSING_FAILED')
        return int(lines[0])

    def verify_signed_auth(self):
        self.runner.validate_original_accounts()
        actual = []
        for account in self.binding['accounts']:
            response = self.runner.auth_user(account['accessToken'])
            require(response.get('id') == account['userId'] and response.get('role') == 'authenticated'
                    and response.get('is_anonymous') is not True, 'ACTUAL_SIGNED_AUTH_REQUIRED')
            uid, sid = str(uuid.UUID(account['userId'])), str(uuid.UUID(account['sessionId']))
            query = "select user_id::text from auth.sessions where id='" + sid + "'::uuid and user_id='" + uid + "'::uuid;"
            stored = self.runner.read_sql(query, timeout=2)
            actual.append({k: account[k] for k in ('userId', 'sessionId', 'expiresAt')} |
                          {'gotrueUserId': response['id'], 'databaseSessionUserId': stored})
        return actual

    def clock(self, timeout=2):
        boundary = boundary_time(self.contract['boundary'])
        epoch = int(boundary.timestamp())
        day = boundary.date().isoformat()
        return exact_json(self.runner.read_sql("select jsonb_build_object('epoch',extract(epoch from t),"
            "'day',(t at time zone'Asia/Seoul')::date,'midnightEpoch'," + str(epoch) + ",'nextDay','"
            + day + "')from(select clock_timestamp()t)s;", timeout=timeout))

    def snapshot(self):
        value = self.runner.snapshot()
        schemas="'auth','public','private','storage'" if 'currentProfile'not in self.contract else "'auth','public','private','storage','cron','vault'"
        relation_names = exact_json(self.runner.read_sql("select jsonb_agg(schemaname||'.'||tablename"
            " order by schemaname,tablename)from pg_tables where schemaname in("+schemas+");", timeout=3))
        require(set(value['rows']) == set(relation_names) and len(relation_names) == len(set(relation_names)),
                'FULL_TARGET_RELATION_SET_REQUIRED')
        if 'currentProfile'in self.contract:require(sorted(relation_names)==current_tables(self.contract),'CURRENT_AI24_EXACT_TABLES')
        self.baseline_rows = json.loads(json.dumps(self.runner.snapshot_original_rows))
        self.account_baseline = exact_json(self.runner.read_sql(
            'select jsonb_agg(to_jsonb(a)order by account_id)from private.ai_budget_accounts a;', timeout=3))
        self.guard_baseline = exact_json(self.runner.read_sql(
            'select jsonb_agg(to_jsonb(a))from private.ai_processing_guard a;', timeout=3))
        value.update(self.authority_hashes())
        self.baseline = protected_snapshot({key: value[key] for key in ('rows', 'catalogSha256', 'rolesAclSha256', 'unknownRows')},current_tables(self.contract))
        return self.baseline

    def authority_hashes(self):
        # 함수/열/제약/트리거와 회원·스키마·테이블·열 ACL을 같은 SQL로 재계산한다.
        scope = "n.nspname in('auth','public','private','storage')" if 'currentProfile'not in self.contract else "n.nspname in('auth','public','private','storage','cron','vault')"
        catalog = "select encode(sha256(convert_to(jsonb_build_object('functions',(select jsonb_agg(to_jsonb(p)order by p.oid)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where " + scope + "),'relations',(select jsonb_agg(to_jsonb(c)order by c.oid)from pg_class c join pg_namespace n on n.oid=c.relnamespace where " + scope + "),'columns',(select jsonb_agg(to_jsonb(a)order by a.attrelid,a.attnum)from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where " + scope + "),'constraints',(select jsonb_agg(to_jsonb(c)order by c.oid)from pg_constraint c join pg_namespace n on n.oid=c.connamespace where " + scope + "),'triggers',(select jsonb_agg(to_jsonb(t)order by t.oid)from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where " + scope + "))::text,'UTF8')),'hex');"
        authority = "select encode(sha256(convert_to(jsonb_build_object('roles',(select jsonb_agg(to_jsonb(r)order by oid)from pg_roles r),'memberships',(select jsonb_agg(to_jsonb(m)order by roleid,member,grantor)from pg_auth_members m),'schemas',(select jsonb_agg(to_jsonb(n)order by oid)from pg_namespace n where " + scope + "),'relations',(select jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl)order by c.oid)from pg_class c join pg_namespace n on n.oid=c.relnamespace where " + scope + "),'columnAcl',(select jsonb_agg(jsonb_build_array(a.attrelid,a.attnum,a.attacl)order by a.attrelid,a.attnum)from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where " + scope + "),'defaultAcl',(select jsonb_agg(to_jsonb(d)order by oid)from pg_default_acl d),'databaseAcl',(select jsonb_build_array(datdba,datacl)from pg_database where datname=current_database()))::text,'UTF8')),'hex');"
        return {'catalogSha256': digest_required(self.runner.read_sql(catalog, timeout=3)),
                'rolesAclSha256': digest_required(self.runner.read_sql(authority, timeout=3))}

    def activate_fixture_registration(self, intent):
        require(self.baseline is not None, 'FULL_PROTECTED_SNAPSHOT_REQUIRED')
        # 첫 변이 전 전체 adapter 원 상태를 별도로 영속 저장한다. prepared 성공을 가정하지 않는다.
        durable_json(self.root, 'ai24-cleanup-baseline.json', {
            'version': 1, 'kind': 'AI24_CLEANUP_BASELINE', 'scopeId': self.contract['scopeId'],
            'boundary': self.contract['boundary'], 'sourcePins': self.contract['sourcePins'],
            'signedInputSha256': self.contract['signedAuthInput']['sha256'],
            'baseline': self.baseline, 'baselineRows': self.baseline_rows,
            'accountBaseline': self.account_baseline, 'guardBaseline': self.guard_baseline})
        return self.runner.activate_fixture_registration()

    def headroom(self):
        value = exact_json(self.runner.read_sql("with d as(select(clock_timestamp()at time zone'Asia/Seoul')::date day)"
            "select jsonb_build_object('accounts',(select jsonb_object_agg(a.account_id,jsonb_build_object('registered',"
            "a.registered,'cap',a.unit_limit,'reserved',coalesce(b.reserved_units,0),'charged',coalesce(b.charged_units,0)))"
            "from private.ai_budget_accounts a cross join d left join private.ai_account_daily_budget b"
            " on b.account_id=a.account_id and b.kst_day=d.day),'global',(select jsonb_build_object('cap',"
            "(select coalesce(sum(unit_limit)filter(where registered),0)from private.ai_budget_accounts),"
            "'reserved',coalesce(g.reserved_units,0),'charged',coalesce(g.charged_units,0))from d"
            " left join private.ai_global_daily_budget g on g.kst_day=d.day));", timeout=3))
        # 현재 고정 fixture의 보수적 준비 여유. 정책 cap/실제 요청 units는 변경하지 않는다.
        value['requiredUnits'] = 1000000
        return value

    def original_rows(self):
        require(self.authority_hashes() == {k: self.baseline[k] for k in ('catalogSha256', 'rolesAclSha256')},
                'FULL_CATALOG_OR_AUTHORITY_CHANGED')
        current = self.runner.original_rows()
        require(set(current) == set(self.baseline_rows), 'FULL_TARGET_RELATION_SET_REQUIRED')
        mutable = {'private.ai_budget_accounts', 'private.ai_processing_guard'}
        for table, rows in self.baseline_rows.items():
            if table not in mutable:
                require(all(current[table].get(h, 0) >= count for h, count in rows.items()),
                        'ORIGINAL_PROTECTED_ROWS_CHANGED')
        accounts = exact_json(self.runner.read_sql('select jsonb_agg(to_jsonb(a)order by account_id)'
                                                  'from private.ai_budget_accounts a;', timeout=3))
        guards = exact_json(self.runner.read_sql('select jsonb_agg(to_jsonb(a))'
                                                'from private.ai_processing_guard a;', timeout=3))
        activated = self.cleanup_result is None
        expected_accounts = [{**a, **({'registered': True} if activated else {})} for a in self.account_baseline]
        expected_guard = [{**a, **({'external_processing_allowed': True} if activated else {})} for a in self.guard_baseline]
        require(accounts == expected_accounts and guards == expected_guard, 'JOURNALED_FLAGS_OR_GUARD_CHANGED')
        # 원 행의 동일성만 반환한다. 추가 행은 효과/정리 증거에서 따로 확인한다.
        return self.baseline

    def budget(self):
        value = self.runner.budget()
        return {'global': value['global'], 'accounts': {a + ':' + d: n for a, days in value['accounts'].items()
                                                        for d, n in days.items()}}

    def counts(self):
        boundary = boundary_time(self.contract['boundary'])
        return {'before': self.runner.counts((boundary - timedelta(days=1)).date().isoformat()),
                'after': self.runner.counts(boundary.date().isoformat())}

    def fixture_unknown_rows(self):
        require(self.unknown_id is not None, 'FIXTURE_UNKNOWN_FULL_ROWS_REQUIRED')
        rows = self.runner.unknown_rows(self.unknown_id)
        require(all(rows.values()), 'FIXTURE_UNKNOWN_FULL_ROWS_REQUIRED')
        return {'private.' + table: hashlib.sha256(raw.encode()).hexdigest() for table, raw in rows.items()}

    def prepare_fixture(self, intent):
        value = self.runner.prepare_units()
        self.unknown_id = str(uuid.UUID(value['unknownReservationId']))
        counts = self.counts()
        self.creation_receipts = [{**r, 'table': 'private.' + r['table']} for r in value['creationReceipts']]
        self.owned_baseline = self.owned_metadata()
        ledger = self.runner.fixture['aiLedgerId']
        allowed = {r['id'] for r in self.creation_receipts if r['table'] == 'private.ai_account_budget_reservations'}
        require(set(self.owned_baseline['ai_budget_ledgers']) == {ledger}
                and set(self.owned_baseline['ai_account_budget_reservations']) == allowed
                and set(self.owned_baseline['ai_budget_reservations']) == {self.unknown_id},
                'UNRECEIPTED_PREPARED_BUDGET_ADDITION')
        port_state_sha = durable_json(self.root, 'ai24-fixed-port-state.json', {
            'version': 1, 'kind': 'AI24_FIXED_SIGNED_ADAPTER_STATE', 'scopeId': self.contract['scopeId'],
            'boundary': self.contract['boundary'], 'sourcePins': self.contract['sourcePins'],
            'signedInputSha256': self.contract['signedAuthInput']['sha256'],
            'baseline': self.baseline, 'baselineRows': self.baseline_rows,
            'accountBaseline': self.account_baseline, 'guardBaseline': self.guard_baseline,
            'unknownReservationId': self.unknown_id, 'creationReceipts': self.creation_receipts,
            'ownedBaseline': self.owned_baseline, 'runner': self.runner.export_resume_state()})
        return {'scopeId': self.contract['scopeId'], 'counts': counts['before'], 'nextCounts': counts['after'],
                'baseline': self.baseline, 'budget': self.budget(), 'creationReceipts': self.creation_receipts,
                'fixtureUnknownRows': self.fixture_unknown_rows(), 'portStateSha256': port_state_sha}

    def hydrate_prepared(self, expected_sha):
        raw = live_private_bytes(self.root, 'ai24-fixed-port-state.json')
        require(hashlib.sha256(raw).hexdigest() == digest_required(expected_sha), 'PORT_STATE_CHANGED')
        value = exact_json(raw)
        require(set(value) == {'version', 'kind', 'scopeId', 'boundary', 'sourcePins', 'signedInputSha256',
                              'baseline', 'baselineRows', 'accountBaseline', 'guardBaseline',
                              'unknownReservationId', 'creationReceipts', 'ownedBaseline', 'runner'}
                and type(value['version']) is int and value['version'] == 1
                and value['kind'] == 'AI24_FIXED_SIGNED_ADAPTER_STATE'
                and all(value[k] == self.contract[k] for k in ('scopeId', 'boundary', 'sourcePins'))
                and value['signedInputSha256'] == self.contract['signedAuthInput']['sha256'],
                'EXACT_PORT_STATE_BINDING_REQUIRED')
        baseline = protected_snapshot(value['baseline'],current_tables(self.contract))
        rows = value['baselineRows']
        require(isinstance(rows, dict) and set(rows) == set(baseline['rows']),
                'FULL_TARGET_RELATION_SET_REQUIRED')
        for table, hashes in rows.items():
            require(isinstance(hashes, dict) and all(digest_required(h) and type(n) is int and n > 0
                                                    for h, n in hashes.items()), 'FULL_ORIGINAL_ROW_MAP_REQUIRED')
            require(hashlib.sha256(canonical(hashes)).hexdigest() == baseline['rows'][table],
                    'FULL_ORIGINAL_ROW_MAP_CHANGED')
        identifier = str(uuid.UUID(value['unknownReservationId']))
        require(identifier == value['unknownReservationId'], 'EXACT_UUID_REQUIRED')
        require(value['runner'].get('changed') is True
                and value['runner'].get('preparedUnitsComplete') is True
                and value['runner'].get('unknown', [None])[0] == identifier
                and value['creationReceipts'] == [{**r, 'table': 'private.' + r['table']}
                                                  for r in value['runner']['creationReceipts']],
                'COMPLETE_PREPARED_PORT_STATE_REQUIRED')
        self.runner.restore_resume_state(value['runner'])
        self.baseline, self.baseline_rows = baseline, rows
        self.account_baseline, self.guard_baseline = value['accountBaseline'], value['guardBaseline']
        self.unknown_id = identifier
        self.creation_receipts, self.owned_baseline = value['creationReceipts'], value['ownedBaseline']

    def recover_cleanup_only(self, baseline_sha, activation_sha):
        """중단된 준비의 SHA-bound 원 제어값을 복원한다. 완전 성공으로 승격하지 않는다.

        다른 프로세스의 Popen 객체를 복구하지 않는다. 노드 closure receipt가 없으면
        child 상태는 UNKNOWN으로 남으며 일반 PID/name 신호나 새 prepare는 금지한다.
        """
        require(self.baseline is None and not self.handles, 'FRESH_CLEANUP_ADAPTER_REQUIRED')
        raw = live_private_bytes(self.root, 'ai24-cleanup-baseline.json')
        require(hashlib.sha256(raw).hexdigest() == digest_required(baseline_sha), 'CLEANUP_BASELINE_CHANGED')
        value = exact_json(raw)
        require(set(value) == {'version', 'kind', 'scopeId', 'boundary', 'sourcePins', 'signedInputSha256',
                              'baseline', 'baselineRows', 'accountBaseline', 'guardBaseline'}
                and type(value['version']) is int and value['version'] == 1
                and value['kind'] == 'AI24_CLEANUP_BASELINE'
                and all(value[k] == self.contract[k] for k in ('scopeId', 'boundary', 'sourcePins'))
                and value['signedInputSha256'] == self.contract['signedAuthInput']['sha256'],
                'EXACT_CLEANUP_BASELINE_REQUIRED')
        baseline = protected_snapshot(value['baseline'],current_tables(self.contract))
        require(set(value['baselineRows']) == set(baseline['rows']), 'FULL_TARGET_RELATION_SET_REQUIRED')
        for table, rows in value['baselineRows'].items():
            require(isinstance(rows, dict) and all(digest_required(h) and type(n) is int and n > 0
                                                   for h, n in rows.items())
                    and hashlib.sha256(canonical(rows)).hexdigest() == baseline['rows'][table],
                    'FULL_ORIGINAL_ROW_MAP_CHANGED')
        raw = live_private_bytes(self.root, 'midnight-activation-resume-state-private.json')
        require(hashlib.sha256(raw).hexdigest() == digest_required(activation_sha), 'ACTIVATION_STATE_CHANGED')
        activation = exact_json(raw)
        require(activation.get('changed') is True and activation.get('preparedUnitsComplete') is False
                and activation.get('accounts') == value['accountBaseline']
                and activation.get('originalRows') == value['baselineRows'], 'PARTIAL_ACTIVATION_STATE_REQUIRED')
        self.runner.restore_resume_state(activation)
        self.baseline, self.baseline_rows = baseline, value['baselineRows']
        self.account_baseline, self.guard_baseline = value['accountBaseline'], value['guardBaseline']
        # 검증된 대상/원 인증 및 현재 코드만 사용한다. 취소 이후에도 원 flag 복원은 독립 수행한다.
        self.current_pins()
        auth = self.contract['signedAuthInput']
        require(self.identity() == {'containers': auth['containers'],
                                   'databaseManifestSha256': auth['databaseManifestSha256']},
                'CURRENT_LIVE_TARGET_CHANGED')
        child_state = 'STORED_CLOSED_OR_NEVER_LAUNCHED'
        for phase in ('prepare-limits', 'prepare-recovery', 'held', 'new-day'):
            intent = self.root / ('midnight-' + phase + '-node-intent.json')
            if not intent.exists():
                if (self.root / ('midnight-' + phase + '-node-created.json')).exists():
                    child_state = 'UNKNOWN'
                continue
            try:
                intended = exact_json(live_private_bytes(self.root, intent.name))
                created = exact_json(live_private_bytes(self.root, 'midnight-' + phase + '-node-created.json'))
                closed = exact_json(live_private_bytes(self.root, 'midnight-' + phase + '-node-closed.json'))
                require(intended.get('scopeId') == created.get('scopeId') == self.contract['scopeId']
                        and intended.get('phase') == phase and intended.get('singleLaunch') is True
                        and created.get('signalsOnlyExactPopenObject') is True
                        and type(created.get('pid')) is int and created['pid'] > 0
                        and closed.get('pid') == created['pid'] and closed.get('exited') is True
                        and type(closed.get('exitCode')) is int
                        and closed.get('signalsOnlyExactPopenObject') is True, 'INTERRUPTED_CHILD_CLOSURE_UNKNOWN')
            except (OSError, ValueError, KeyError, TypeError):
                child_state = 'UNKNOWN'
        cleanup_failure = False
        try: self.cleanup_owned('CLEANUP_ONLY_NO_REPLAY')
        except BaseException: cleanup_failure = True
        restoration = 'FAIL'
        try:
            require(not cleanup_failure and self.original_rows() == baseline, 'ACTUAL_CLEANUP_UNPROVEN')
            current = self.runner.original_rows()
            require(all(current[t] == rows for t, rows in self.baseline_rows.items()
                        if t.removeprefix('private.') not in PROTECTED), 'NON_BUDGET_BASELINE_NOT_RESTORED')
            restoration = 'PASS_ORIGINAL_CONTROLS_ROWS_AND_AUTHORITY'
        except BaseException:
            pass
        # 부분 예산/effect 사슬은 prepared 성공 receipt가 아니다. 어떠한 경우도 full PASS가 아니다.
        result = {'status': 'FAIL' if restoration == 'FAIL' else 'UNKNOWN_PARTIAL_BUDGET_PROOF',
                  'scopeId': self.contract['scopeId'], 'baselineSha256': baseline_sha,
                  'activationSha256': activation_sha, 'originalRestoration': restoration,
                  'childClosure': child_state, 'fullBudgetProof': 'UNKNOWN',
                  'prepareReplayAllowed': False, 'actualMidnight': 'NOT_RUN'}
        durable_json(self.root, 'ai24-cleanup-only-result.json', result)
        return result

    def warm_factory(self, phase):
        require(phase == 'held' and phase not in self.warm_capabilities, 'SINGLE_FACTORY_WARM_REQUIRED')
        fixture = dict(self.runner.fixture, midnightPhase=phase)
        self.warm_capabilities[phase] = self.runner.warm_factory(fixture, phase)

    def start_factory(self, phase, intent):
        require(phase not in self.handles, 'SINGLE_FACTORY_DISPATCH_REQUIRED')
        fixture = dict(self.runner.fixture, midnightPhase=phase)
        if phase == 'held':
            require(phase in self.warm_capabilities, 'WARM_FACTORY_REQUIRED')
            capability = self.warm_capabilities.pop(phase)
            self.handles[phase] = self.runner.start_factory(fixture, phase, capability)
        else:
            self.handles[phase] = self.runner.start_factory(fixture, phase)

    def finish_factory(self, phase, timeout):
        value = self.runner.finish_factory(self.handles[phase], timeout=timeout)
        require(value['case'] == 'ai-midnight-' + phase and value['nativeExternalAttempts'] == 0
                and len(value['observations']) == (1 if phase == 'held' else 2), 'EXACT_FACTORY_PHASE_REQUIRED')
        self.observations.extend(value['observations'])

    def cancel_factory(self):
        self.cancelled.set()
        errors = []
        for handle in tuple(self.runner.children):
            try: self.runner.cancel_factory(handle)
            except BaseException: errors.append('OWN_CHILD_EXIT_UNPROVEN')
        require(not errors, 'OWN_CHILD_EXIT_UNPROVEN')

    def wait_provider_marker(self, timeout):
        deadline = self.monotonic() + timeout
        while not (self.root / 'midnight-provider-ready.json').exists():
            require(self.monotonic() < deadline, 'PROVIDER_READY_NOT_OBSERVED')
            self.wait(min(.02, max(0, deadline - self.monotonic())))
        require(exact_json(live_private_bytes(self.root, 'midnight-provider-ready.json')) == {'ready': True},
                'PROVIDER_READY_MARKER_CHANGED')
        wire = exact_json(live_private_bytes(self.root, 'midnight-provider-marker.json'))
        return self.reservation_proof(wire, timeout=max(.001, min(.75, deadline - self.monotonic())))

    def reservation_proof(self, marker, timeout):
        request = str(uuid.UUID(marker['requestId'])); reservation = str(uuid.UUID(marker['reservationId']))
        uid = self.contract['signedSelectedUserIds'][0]
        ledger = self.runner.fixture['aiLedgerId']
        require(re.fullmatch('[A-Za-z0-9_.:-]{1,96}', ledger), 'EXACT_LEDGER_REQUIRED')
        value = exact_json(self.runner.read_sql("select jsonb_build_object('requestId',r.request_id,'reservationId',"
            "a.reservation_id,'userId',r.user_id,'accountId',a.account_id,'day',a.account_day,'leaseSha256',"
            "encode(sha256(convert_to(r.lease_token::text,'UTF8')),'hex'),'units',a.reserved_units,'pending',"
            "a.settled_at is null and a.unknown_at is null,'startedEpoch',extract(epoch from r.started_at))"
            "from private.ai_chat_requests r join private.ai_account_budget_reservations a on a.reservation_id='"
            + reservation + "'::uuid where r.request_id='" + request + "'::uuid and r.user_id='" + uid
            + "'::uuid and a.ledger_id='" + ledger + "';", timeout=timeout))
        for key in ('requestId', 'reservationId', 'accountId', 'leaseSha256', 'units'):
            require(value[key] == marker[key], 'ORIGINAL_PENDING_RESERVATION_REQUIRED')
        require(value['day'] == marker.get('day', marker.get('accountDay')),
                'ORIGINAL_PENDING_RESERVATION_REQUIRED')
        return value

    def effect_proof(self):
        self.runner.effect_proof(self.observations)
        effects = []
        for i, observation in enumerate(self.observations):
            request, reserved = observation['requests'][0], observation['reservations'][0]
            rid, reservation = str(uuid.UUID(request['requestId'])), str(uuid.UUID(reserved['reservationId']))
            uid = self.contract['signedSelectedUserIds'][i]
            stored = exact_json(self.runner.read_sql("select jsonb_build_object('requestId',r.request_id,'reservationId',"
                "a.reservation_id,'userId',r.user_id,'accountId',a.account_id,'day',r.counted_day,'finished',"
                "r.outcome='finished'and r.finished_at is not null,'storedLeaseSha256',encode(sha256(convert_to"
                "(r.lease_token::text,'UTF8')),'hex'),'usage',jsonb_build_array(a.input_tokens,a.output_tokens),"
                "'resultCount',(select count(*)from private.ai_result_receipts x where x.request_id=r.request_id"
                "and x.user_id=r.user_id),'settledEpoch',extract(epoch from a.settled_at))from private.ai_chat_requests r"
                "join private.ai_account_budget_reservations a on a.reservation_id='" + reservation
                + "'::uuid where r.request_id='" + rid + "'::uuid and r.user_id='" + uid + "'::uuid;", timeout=3))
            stored['originalLeaseSha256'] = request['leaseSha256']
            effects.append(stored)
        raw = 0
        for table in ('ai_chat_requests', 'ai_member_processing', 'ai_member_daily_usage', 'ai_budget_ledgers',
                      'ai_budget_reservations', 'ai_account_budget_reservations', 'ai_result_receipts'):
            raw += int(self.runner.read_sql("select count(*)from private." + table
                + " t where strpos(to_jsonb(t)::text,'AI_DIALOGUE_CANARY')>0;", timeout=3))
        counts = self.counts()
        self.result = {'dailyBefore': counts['before'], 'dailyAfter': counts['after'], 'effects': effects,
                       'budget': self.budget(), 'originalRows': self.original_rows(),
                       'fixtureUnknownRows': self.fixture_unknown_rows(),
                       'nativeExternalAttempts': 0, 'rawPersistedRows': raw}
        self.verify_owned_metadata()
        return self.result

    def owned_metadata(self):
        result = {}
        for table, key in (('ai_budget_ledgers', 'ledger_id'), ('ai_budget_reservations', 'id'),
                           ('ai_account_budget_reservations', 'reservation_id')):
            current = exact_json(self.runner.read_sql("select coalesce(jsonb_object_agg(" + key
                + ",jsonb_build_object('row',to_jsonb(r),'sha256',encode(sha256(convert_to(to_jsonb(r)::text,"
                "'UTF8')),'hex'))),'{}'::jsonb)from private." + table + " r;", timeout=3))
            original = self.baseline_rows['private.' + table]
            result[table] = {identifier: v['row'] for identifier, v in current.items()
                             if v['sha256'] not in original}
        return result

    def verify_owned_metadata(self):
        current = self.owned_metadata()
        ledger = self.runner.fixture['aiLedgerId']
        old = self.owned_baseline
        require(set(current['ai_budget_ledgers']) == set(old['ai_budget_ledgers']) == {ledger},
                'UNRECEIPTED_LEDGER_ADDITION')
        require(current['ai_budget_reservations'] == old['ai_budget_reservations'],
                'ORIGINAL_UNKNOWN_OR_LEGACY_ROWS_CHANGED')
        allowed = {r['id'] for r in self.creation_receipts if r['table'] == 'private.ai_account_budget_reservations'}
        require(set(old['ai_account_budget_reservations']) == allowed,
                'UNRECEIPTED_PREPARED_RESERVATION_ADDITION')
        new_ids = {o['reservations'][0]['reservationId'] for o in self.observations}
        require(len(new_ids) == len(self.observations) == 3 and not (allowed & new_ids)
                and set(current['ai_account_budget_reservations']) == allowed | new_ids,
                'UNRECEIPTED_RESERVATION_ADDITION')
        for identifier, row in old['ai_account_budget_reservations'].items():
            require(current['ai_account_budget_reservations'][identifier] == row,
                    'PREPARED_FULL_RESERVATION_ROW_CHANGED')
        for observation in self.observations:
            proof = observation['reservations'][0]
            row = current['ai_account_budget_reservations'][proof['reservationId']]
            require(set(row) == {'reservation_id', 'ledger_id', 'account_id', 'account_day', 'reserved_units',
                                 'unknown_at', 'input_tokens', 'output_tokens', 'settled_at'}
                    and row['ledger_id'] == ledger and row['reservation_id'] == proof['reservationId']
                    and row['account_id'] == proof['accountId'] and row['account_day'] == proof['accountDay']
                    and row['reserved_units'] == proof['units'] and row['unknown_at'] is None
                    and row['input_tokens'] == row['output_tokens'] == 1 and row['settled_at'] is not None,
                    'EXACT_RETAINED_OWNED_RESERVATION_REQUIRED')
        before = old['ai_budget_ledgers'][ledger]
        after = current['ai_budget_ledgers'][ledger]
        expected = {**before, 'charged_units': before['charged_units'] + 6,
                    'settled_calls': before['settled_calls'] + 3, 'updated_at': after['updated_at']}
        require(after == expected and aware_time(after['updated_at']).timestamp()
                >= boundary_time(self.contract['boundary']).timestamp(), 'ORIGINAL_LEDGER_COUNTERS_CHANGED')

    def cleanup_owned(self, intent):
        require(self.cleanup_result is None, 'SINGLE_CLEANUP_ATTEMPT_REQUIRED')
        # 실패가 있어도 별도 재시도로 바꾸지 않는다. 실행기는 이 경로를 한 번만 호출한다.
        self.cleanup_result = {'status': 'ATTEMPTED'}
        self.cleanup_active = True
        try:
            self.cleanup_result = self.runner.cleanup_owned()
        finally:
            self.cleanup_active = False

    def cleanup_proof(self):
        require(self.cleanup_result['status'] == 'PASS' and self.cleanup_result['authLifecycleMutation'] is False
                and self.cleanup_result['containerLifecycleMutation'] is False, 'ACTUAL_CLEANUP_UNPROVEN')
        require(self.original_rows() == self.baseline, 'ORIGINAL_PROTECTED_ROWS_CHANGED')
        self.verify_owned_metadata()
        current = self.runner.original_rows()
        for table, rows in self.baseline_rows.items():
            if table.removeprefix('private.') not in PROTECTED:
                require(current[table] == rows, 'NON_BUDGET_BASELINE_NOT_RESTORED')
        return {'originalRows': self.baseline,
                'childrenExited': all(h['process'].poll() is not None for h in self.runner.children),
                'ownedOnly': True, 'preservedBudget': self.budget()}


def bind_fixed_execution(root, contract_sha, current_pins, reviewed_assembly, custody=None):
    """검토 코드의 승인 객체를 고정 포트에 연결한다. CLI/JSON 승인 진입점은 없다."""
    require(custody is None or type(custody) is TypedMidnightCustody, 'MIDNIGHT_TYPED_CUSTODY_REQUIRED')
    contract = load_live_contract(root, contract_sha, current_pins)
    require(type(reviewed_assembly) is ReviewedMidnightAssembly and reviewed_assembly.ports is None,
            'REVIEWED_FIXED_ASSEMBLY_REQUIRED')
    require(reviewed_assembly.contract_sha256 == contract_sha
            and reviewed_assembly.scope_id == contract['scopeId']
            and reviewed_assembly.boundary == contract['boundary'], 'EXECUTOR_ASSEMBLY_BINDING_CHANGED')
    ports = FixedSignedMidnightPorts(root, contract, custody=custody)
    result = ReviewedMidnightAssembly(contract_sha, contract['scopeId'], contract['boundary'],
                                     reviewed_assembly.decision_id, ports)
    execution_assembly(contract, contract_sha, result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepared-root', type=Path, required=True)
    parser.add_argument('--evidence-root', type=Path, required=True)
    args = parser.parse_args()
    from run_database_tests import isolated_prepared_target
    target = isolated_prepared_target(args.prepared_root)
    evidence = inspect_evidence(args.evidence_root)
    print(json.dumps(build_plan(target, evidence, contract_pins(), datetime.now(timezone.utc)), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print('{"status":"FAIL","code":"OFFLINE_MIDNIGHT_PREPARATION_FAILED","executionAllowed":false}')
        raise SystemExit(1)
