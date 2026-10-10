"""AI24 오프라인 검토 묶음. DB/VM/모델/예약 실행 능력은 제공하지 않는다."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
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


def contract_pins():
    sys.path.insert(0, str(ROOT / 'tests/integration/jonghyun'))
    from isolated_ai_contracts import product_graph
    paths = set(product_graph()) | {
        'tests/integration/minkyu/content_inspection_http_local.py',
        'tests/integration/minkyu/content_inspection_http_local.ts',
        'tests/integration/jonghyun/isolated_ai_contracts.py',
        'tests/integration/jonghyun/isolated_ai_factory.ts',
        'tools/local/run_database_tests.py', 'tools/local/prepare_isolated_midnight.py',
        'tools/local/prepare_database.py', 'tools/local/prepare_migrations.py',
    }
    pins = {}
    for relative in sorted(paths):
        path = ROOT / relative
        require(path.resolve() == path and not path.is_symlink(), 'SOURCE_SYMLINK_FORBIDDEN')
        committed = subprocess.check_output(['git', '-C', str(ROOT), 'show', 'HEAD:' + relative],
                                             stderr=subprocess.DEVNULL, timeout=15)
        require(committed == path.read_bytes(), 'SOURCE_NOT_COMMITTED')
        pins[relative] = hashlib.sha256(committed).hexdigest()
    return pins


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
                           'DEDICATED_AI24_EXECUTOR_NOT_IMPLEMENTED',
                           'SIGNED_AUTH_ORIGINAL_AI24_REQUIRES_SEPARATE_CONTRACT'],
    }


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
