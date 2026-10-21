"""D03 저장 원시 관측 → DB-entry classifier 연결. 실행·파일 I/O 권한은 없다.

인자는 수집자가 이미 보존한 bytes 및 독립 검토한 SHA seal이다. seal의 실제
출처·수집 경로·Auth/자격 증명은 외부 실행기가 검증해야 한다. 이 모듈은 HTTP
최초 접수, 실제 실행 성공, fixture 삭제 실행 또는 전체 정책 완료를 증명하지 않는다.
공개 service-api 오류는 SQLSTATE를 지우므로 여기서는 PostgREST 원응답만 받는다.
"""
from dataclasses import dataclass
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import re
import sys

_PATH = Path(__file__).with_name('deadline_lock_evidence.py')
_SPEC = importlib.util.spec_from_file_location('d03_raw_classifier', _PATH)
_CLASSIFIER = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _CLASSIFIER
_SPEC.loader.exec_module(_CLASSIFIER)
PHASES = ('binding', 'before', 'blocked', 'release', 'response', 'after', 'cleanup')
_SHA = re.compile('[a-f0-9]{64}\\Z')


def need(value, code):
    if not value:
        raise ValueError(code)


def pairs(items):
    value = {}
    for key, item in items:
        need(key not in value, 'DUPLICATE_JSON_KEY')
        value[key] = item
    return value


def decode(raw):
    need(type(raw) is bytes and 0 < len(raw) <= 2097152, 'RAW_BYTES_REQUIRED')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NONFINITE_JSON')))


@dataclass(frozen=True)
class ReviewedRawSeal:
    """독립 검토 입력. 구성만으로 실제 원본/검토 승인이 생기지 않는다."""
    source_sha: str
    phase_sha: dict
    database_identity: str
    request_id: str
    holder_backend_start: str
    waiter_backend_start: str


def classify_raw(raw, seal):
    """정확 bytes/DB backend 귀속/보존 대조 후 기존 순수 classifier만 호출한다."""
    need(type(seal) is ReviewedRawSeal, 'REVIEWED_SEAL_REQUIRED')
    need(type(raw) is dict and set(raw) == set(PHASES), 'EXACT_RAW_PHASES')
    need(type(seal.phase_sha) is dict and set(seal.phase_sha) == set(PHASES), 'EXACT_SEAL_PHASES')
    need(type(seal.source_sha) is str and _SHA.fullmatch(seal.source_sha), 'SOURCE_SHA')
    for value in (seal.database_identity, seal.request_id, seal.holder_backend_start, seal.waiter_backend_start):
        need(type(value) is str and 0 < len(value) <= 256, 'EXACT_IDENTITY_REQUIRED')
    for phase in PHASES:
        digest = seal.phase_sha[phase]
        need(type(digest) is str and _SHA.fullmatch(digest), 'PHASE_SHA')
        need(type(raw[phase]) is bytes and sha256(raw[phase]).hexdigest() == digest, 'RAW_HASH_MISMATCH')
    docs = {phase: decode(raw[phase]) for phase in PHASES}
    for doc in docs.values():
        need(type(doc) is dict and doc.get('databaseIdentity') == seal.database_identity
             and doc.get('requestId') == seal.request_id, 'OBSERVATION_IDENTITY_MISMATCH')
    binding, before, blocked, release, response, after, cleanup = (docs[p] for p in PHASES)
    need(binding.get('originalJwtVerified') is True and binding.get('eligibleBeforeLock') is True,
         'AUTH_OR_ELIGIBILITY_UNPROVEN')
    need(blocked.get('holderBackendStart') == seal.holder_backend_start
         and blocked.get('waiterBackendStart') == seal.waiter_backend_start
         and release.get('holderBackendStart') == seal.holder_backend_start,
         'BACKEND_START_MISMATCH')
    need(release.get('holderPid') == blocked.get('holderPid'), 'RELEASE_BACKEND_MISMATCH')
    need(response.get('transport') == 'POSTGREST_ORIGINAL_HTTP'
         and type(response.get('status')) is int and response['status'] == 400
         and response.get('bodyComplete') is True and response.get('transportClosed') is True,
         'ORIGINAL_RPC_RESPONSE_REQUIRED')
    body = response.get('body')
    need(type(body) is dict and set(body) == {'code', 'message', 'details', 'hint'}, 'POSTGREST_ERROR_SHAPE')
    need(body['details'] is None and body['hint'] is None, 'UNREVIEWED_ERROR_DETAILS')
    # 수집자가 검토한 전체 보존 투영을 입력한다. 단일 boolean을 보존 증거로 승격하지 않는다.
    need(type(before.get('preservedProjection')) is dict and before['preservedProjection'], 'FULL_PROJECTION_REQUIRED')
    need(before['preservedProjection'] == after.get('preservedProjection')
         == cleanup.get('preservedProjection'), 'PRESERVATION_CHANGED')
    need(cleanup.get('remainingOwnBackendsScope') == 'RAW_PSQL_OWNED_ONLY', 'RAW_PSQL_OWNERSHIP_SCOPE_REQUIRED')
    pool = cleanup.get('postgrestTransactionClosure')
    need(type(pool) is dict and set(pool) == {'requestTransactionClosed','pooledBackendRetained','backendTerminated','ownership'}
         and pool['requestTransactionClosed'] is True and type(pool['pooledBackendRetained']) is bool
         and pool['backendTerminated'] is False and pool['ownership'] == 'POSTGREST_POOL_NOT_OWNED_BACKEND',
         'POSTGREST_TRANSACTION_CLOSURE_REQUIRED')
    need(cleanup.get('remainingOwnRows') == [] and cleanup.get('remainingOwnBackends') == []
         and cleanup.get('ownedHostGroupsClosed') is True, 'CLEANUP_UNPROVEN')
    # 삭제 후보의 정확한 집합과 완료 결과를 독립적으로 봉인한다. 실제 DELETE는 하지 않는다.
    need(type(before.get('ownPredicates')) is list and before['ownPredicates']
         and cleanup.get('deletedPredicates') == before['ownPredicates'], 'EXACT_CLEANUP_SCOPE')
    need(after.get('unexpectedRows') == [] and cleanup.get('unexpectedRows') == [], 'FOREIGN_DELTA')
    observation = _CLASSIFIER.ReviewDeadlineObservation(
        deadline_us=blocked.get('deadlineUs'), query_start_us=blocked.get('queryStartUs'),
        observed_us=blocked.get('observedUs'), released_us=release.get('releasedUs'),
        holder_pid=blocked.get('holderPid'), waiter_pid=blocked.get('waiterPid'),
        blocking_pids=tuple(blocked.get('blockingPids', [])),
        matching_waiter_count=blocked.get('matchingWaiterCount'), wait_event_type=blocked.get('waitEventType'),
        sqlstate=body['code'], message=body['message'], original_jwt=True, eligible_before_lock=True,
        source_sha=seal.source_sha, binding_sha=seal.phase_sha['binding'], before_sha=seal.phase_sha['before'],
        blocked_sample_sha=seal.phase_sha['blocked'], response_sha=seal.phase_sha['response'],
        after_sha=seal.phase_sha['after'], cleanup_sha=seal.phase_sha['cleanup'],
        own_fixture_only=True, preserved=True, cleanup_complete=True)
    result = _CLASSIFIER.classify_review_deadline(observation)
    return {**result, 'releaseSha': seal.phase_sha['release'],
            'rawInputHashesVerified': True, 'collectorAuthenticityProven': False,
            'runtimeExecutedByAdapter': False, 'remainingOwnBackendsScope': 'RAW_PSQL_OWNED_ONLY',
            'requestTransactionClosed': True, 'pooledBackendRetained': pool['pooledBackendRetained'],
            'backendTerminated': False, 'DBJWTclaimDirectObserved': False, 'evidenceScope': 'SEALED_CALLER_BYTES_ONLY'}
