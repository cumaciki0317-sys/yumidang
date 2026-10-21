"""D03 격리 fixture의 순수 계획. 연결·SQL·JWT 발급·실행 권한이 없다."""
from datetime import date
from hashlib import sha256
import json
import re
from uuid import UUID

SOURCES = (
 'backend/supabase/migrations/20260917052827_profile_images_required.sql',
 'backend/supabase/migrations/20261002090000_naver_signup.sql',
 'backend/supabase/migrations/20261002100000_matching_lifecycle.sql',
 'backend/supabase/migrations/20261002110000_completion_review_policy.sql',
 'backend/supabase/migrations/20261005013901_current_sweetness_ledger.sql',
 'backend/supabase/migrations/20261005030100_member_retention_batches.sql',
 'backend/contracts/completion-db.md',
 'tests/integration/minkyu/deadline_lock_evidence.py',
)
PREFIX = 'd0300000-0000-4000-8000-'

def need(condition, code):
    if not condition:
        raise ValueError(code)


def fixture_id(n):
    need(type(n) is int and 1 <= n <= 99, 'FIXED_ID_RANGE')
    return str(UUID(PREFIX + f'{n:012d}'))


def source_pins(source_bytes):
    """호출자 bytes의 해시일 뿐 독립 검토 승인/HEAD 핀이 아니다. 파일을 읽지 않는다."""
    need(set(source_bytes) == set(SOURCES), 'SOURCE_SET')
    need(all(type(v) is bytes and v for v in source_bytes.values()), 'SOURCE_BYTES')
    return {k: sha256(source_bytes[k]).hexdigest() for k in SOURCES}


def qualified_actor(n, *, user_id, session_id, birth_date, today, image_size):
    """합성 자격 입력을 검산한다. Naver 확인/사진 바이트/Auth 발급 증명이 아니다."""
    need(n in (1, 2) and type(n) is int, 'ACTOR_RANGE')
    need(type(today) is date and type(birth_date) is date, 'DATABASE_DATE_REQUIRED')
    age = today.year - birth_date.year - ((today.month, today.day) < (birth_date.month, birth_date.day))
    need(age >= 19, 'UNDERAGE')
    need(type(session_id) is str and str(UUID(session_id)) == session_id, 'SESSION_UUID')
    need(type(image_size) is int and 1 <= image_size <= 2097152, 'IMAGE_SIZE')
    need(type(user_id) is str and str(UUID(user_id)) == user_id, 'USER_UUID')
    uid = user_id
    return {'userId': uid, 'sessionId': session_id,
            'subject': 'synthetic-d03-' + uid,
            'authEmail': uid + '@naver.yumidang.invalid',
            'birthDate': birth_date.isoformat(), 'databaseDate': today.isoformat(), 'gender': 'female',
            'verificationStatus': 'qualified', 'completedAtRequired': True,
            'avatarPath': uid + '/' + fixture_id(n + 10) + '.jpg',
            'storage': {'id': fixture_id(n + 20), 'bucket_id': 'profile-images',
                        'owner_id': uid, 'metadata': {'mimetype': 'image/jpeg', 'size': image_size}},
            'evidenceScope': 'SYNTHETIC_QUALIFICATION_ONLY'}


def make_plan(actors, pins):
    need(type(actors) is list and len(actors) == 2, 'TWO_ACTORS')
    need(len({a['userId'] for a in actors}) == 2, 'DISTINCT_USERS')
    for n, actor in enumerate(actors, 1):
        expected = qualified_actor(n, user_id=actor['userId'], session_id=actor['sessionId'], birth_date=date.fromisoformat(actor['birthDate']),
                                   today=date.fromisoformat(actor['databaseDate']), image_size=actor['storage']['metadata']['size'])
        need(actor == expected, 'QUALIFICATION_TAMPERED')
    need(len({a['sessionId'] for a in actors}) == 2, 'DISTINCT_SESSIONS')
    need(set(pins) == set(SOURCES) and all(re.fullmatch('[a-f0-9]{64}', v) for v in pins.values()), 'SOURCE_PINS')
    post, request, appointment = (fixture_id(i) for i in (31, 32, 33))
    # 업무7행 후보. 실제 catalog·trigger 증거 없이 자동 승인하지 않는다.
    business = [
        ['public.posts', {'id': post}],
        ['public.join_requests', {'id': request}],
        ['public.appointments', {'id': appointment}],
        ['public.notifications', {'join_request_id': request, 'recipient_id': actors[0]['userId'], 'kind': 'join_request'}],
        ['private.conversation_retention_generations', {'request_id': request, 'generation': 1}],
        ['private.appointment_member_episodes', {'appointment_id': appointment}],
        ['private.conversation_generation_appointments', {'appointment_id': appointment}],
    ]
    qualification = []
    for actor in actors:
        uid = actor['userId']
        qualification.extend([
            ['auth.users', {'id': uid}], ['auth.sessions', {'id': actor['sessionId'], 'user_id': uid}],
            ['private.naver_accounts', {'subject': actor['subject'], 'user_id': uid}],
            ['private.naver_sessions', {'session_id': actor['sessionId'], 'user_id': uid}],
            ['storage.objects', {'id': actor['storage']['id'], 'bucket_id': 'profile-images', 'name': actor['avatarPath']}],
            ['public.profiles', {'id': uid}], ['private.member_episodes', {'profile_id': uid}],
        ])
    return {'status': 'NOT_RUN', 'executionReady': False, 'actors': actors, 'sourcePins': pins, 'sourceReviewApproved': False,
            'identityBinding': 'CALLER_UUIDS_PENDING_ORIGINAL_JWT_RECEIPT_AND_REVIEW_SEAL',
            'businessRowsCandidate': business, 'qualificationRowsCandidate': qualification,
            'collisionPolicy': 'ALL_CANDIDATES_MUST_BE_ABSENT',
            'cleanup': {'executable': False, 'orderReviewed': False, 'predicateSet': business + qualification,
                        'requires': ['all_original_host_groups_closed', 'exact_pid_backend_start_absent',
                                     'reviewed_catalog_and_trigger_delta', 'full_row_catalog_role_sequence_unknown_baseline'],
                        'sequenceResetAllowed': False, 'existingRowMutationAllowed': False},
            'unresolved': ['fresh_original_auth_receipt_and_exact_auth_generated_rows',
                           'actual_catalog_trigger_and_owner_snapshot', 'exact_notification_kind_and_trigger_delta',
                           'profile_image_bytes_and_storage_api_contract', 'typed_cleanup_dependency_order',
                           'content_inspection_ticket_contract', 'http_request_to_backend_binding'],
            'deadline': {'source': 'SAME_DATABASE_CLOCK', 'completedAt': 'D_MINUS_7_DAYS',
                         'requiredOrder': 'query_start<=observed<D<=release', 'clockMutationAllowed': False},
            'classifier': {'source': SOURCES[-1], 'executed': False, 'httpIngressProven': False,
                           'policyComplete': False},
            'actualAuth': 'NOT_RUN', 'sqlExecuted': False, 'providerCalls': 0}


def validate_absence(plan, existing_keys):
    """정확 후보 키뿐 아니라 일부 식별 키가 겹치는 기존 관계도 충돌로 거절한다."""
    for table, predicate in plan['businessRowsCandidate'] + plan['qualificationRowsCandidate']:
        for existing in existing_keys.get(table, []):
            # 식별 근거가 하나라도 겹치는 행을 재사용하지 않는다.
            if any(k in existing and existing[k] == v for k, v in predicate.items() if k not in ('generation', 'kind', 'bucket_id')):
                raise ValueError('PREEXISTING_FIXTURE_RELATION')
    need(not(set(existing_keys) - {r[0] for r in plan['businessRowsCandidate'] + plan['qualificationRowsCandidate']}), 'UNREVIEWED_RELATION')
    return {'status': 'ABSENCE_INPUT_VALIDATED_ONLY', 'executionReady': False}


if __name__ == '__main__':
    print(json.dumps({'status': 'NOT_RUN', 'executionReady': False,
                      'reason': '순수 계획 모듈이며 실제 실행기는 포함하지 않습니다.'}, ensure_ascii=False))
