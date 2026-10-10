"""합성 검사기와 실제 로컬 Auth/REST의 SQL114~117 제품 HTTP 결합 검증."""
import base64
import hashlib
import importlib.util
import ipaddress
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
FOUNDATION = REPO.parent / 'minkyu-foundation'
revisions = [v for v in sys.argv[1:] if re.fullmatch(r'--revision-v[1-9][0-9]*', v)]
CONSUMERS = '--scenario-consumers' in sys.argv[1:]
FULL8 = '--scenario-full8' in sys.argv[1:]
AI_EVENTS = '--scenario-ai-event-price' in sys.argv[1:]
AI_LIMITS = '--scenario-ai-limits' in sys.argv[1:]
AI_CAPS = '--scenario-ai-caps' in sys.argv[1:]
AI_MIDNIGHT = '--scenario-ai-midnight' in sys.argv[1:]
MIDNIGHT_PREPARE = '--midnight-prepare' in sys.argv[1:]
MIDNIGHT_RESUME = '--midnight-resume' in sys.argv[1:]
MIDNIGHT_BINDINGS = [v.removeprefix('--prepared-binding=') for v in sys.argv[1:] if re.fullmatch(r'--prepared-binding=[0-9a-f]{64}', v)]
MIDNIGHT_GRAPHS = [v.removeprefix('--reviewed-graph=') for v in sys.argv[1:] if re.fullmatch(r'--reviewed-graph=[0-9a-f]{64}', v)]
assert not (MIDNIGHT_PREPARE or MIDNIGHT_RESUME or MIDNIGHT_BINDINGS or MIDNIGHT_GRAPHS) or AI_MIDNIGHT, 'MIDNIGHT_ACTION_REQUIRES_EXPLICIT_SCENARIO'
assert not AI_MIDNIGHT or (int(MIDNIGHT_PREPARE) + int(MIDNIGHT_RESUME) == 1 and len(MIDNIGHT_BINDINGS) == int(MIDNIGHT_RESUME) and len(MIDNIGHT_GRAPHS) == int(MIDNIGHT_PREPARE)), 'MIDNIGHT_EXPLICIT_ACTION_AND_EXTERNAL_BINDING_REQUIRED'
AI_ONLY = '--scenario-ai-chat' in sys.argv[1:] or AI_EVENTS or AI_LIMITS or AI_CAPS or AI_MIDNIGHT
assert int(AI_EVENTS) + int(AI_LIMITS) + int(AI_CAPS) + int(AI_MIDNIGHT) + int('--scenario-ai-chat' in sys.argv[1:]) <= 1, 'EXPLICIT_SINGLE_AI_SCENARIO_ONLY'
assert int(FULL8) + int(AI_ONLY) + int(CONSUMERS) <= 1, 'EXPLICIT_SINGLE_SCENARIO_ONLY'
assert len(revisions) <= 1 and len(sys.argv[1:]) == len(revisions) + int(FULL8) + int(AI_ONLY) + int(CONSUMERS) + int(MIDNIGHT_PREPARE) + int(MIDNIGHT_RESUME) + len(MIDNIGHT_BINDINGS) + len(MIDNIGHT_GRAPHS), 'EXPLICIT_REVISION_AND_SCENARIO_ONLY'
VERSION = revisions[0].split('-v')[1] if revisions else '1'
assert not FULL8 or (revisions and int(VERSION) > 8), 'FULL8_REQUIRES_NEW_REVISION_AFTER_V8'
assert not AI_ONLY or (revisions and int(VERSION) > 9), 'AI_ONLY_REQUIRES_FRESH_REVISION_AFTER_V9'
assert not AI_EVENTS or (revisions and int(VERSION) > 14), 'EVENT_PRICE_REQUIRES_FRESH_REVISION_AFTER_AI14'
assert not CONSUMERS or (revisions and int(VERSION) > 18), 'CONSUMERS_REQUIRE_FRESH_REVISION_AFTER_AI18'
assert not AI_LIMITS or (revisions and int(VERSION) > 21), 'AI_LIMITS_REQUIRE_FRESH_REVISION_AFTER_CONSUMER21'
assert not AI_CAPS or (revisions and int(VERSION) > 22), 'AI_CAPS_REQUIRE_FRESH_REVISION_AFTER_LIMITS22'
assert not AI_MIDNIGHT or (revisions and int(VERSION) > 23), 'MIDNIGHT_REQUIRE_FRESH_REVISION_AFTER_CAPS23'
ROOT = Path('/private/tmp/yumidang-content-http-20261009-v' + VERSION)
NAME = 'yumidang-minkyu-content-http-20261009-v' + VERSION
if AI_ONLY:
    ROOT = Path('/private/tmp/yumidang-ai-chat-http-20261009-v' + VERSION)
    NAME = 'yumidang-minkyu-ai-chat-http-20261009-v' + VERSION
if AI_EVENTS:
    ROOT = Path('/private/tmp/yumidang-ai-event-price-http-20261010-v' + VERSION)
    NAME = 'yumidang-minkyu-ai-event-price-http-20261010-v' + VERSION
if CONSUMERS:
    ROOT = Path('/private/tmp/yumidang-mobile-consumers-http-20261010-v' + VERSION)
    NAME = 'yumidang-minkyu-mobile-consumers-http-20261010-v' + VERSION
if AI_LIMITS:
    ROOT = Path('/private/tmp/yumidang-ai-limits-http-20261010-v' + VERSION)
    NAME = 'yumidang-minkyu-ai-limits-http-20261010-v' + VERSION
if AI_CAPS:
    ROOT = Path('/private/tmp/yumidang-ai-caps-http-20261010-v' + VERSION)
    NAME = 'yumidang-minkyu-ai-caps-http-20261010-v' + VERSION
if AI_MIDNIGHT:
    ROOT = Path('/private/tmp/yumidang-ai-midnight-http-20261010-v' + VERSION)
    NAME = 'yumidang-minkyu-ai-midnight-http-20261010-v' + VERSION
AUTH, REST, NETWORK = NAME + '-auth', NAME + '-rest', NAME + '-network'
SOURCE = 'yumidang-minkyu-event112-20261009-v1'
_argv = sys.argv
sys.argv = [_argv[0]]
spec = importlib.util.spec_from_file_location('auth116_scaffold', FOUNDATION / 'tests/integration/minkyu/member_retirement_auth_local.py')
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)
sys.argv = _argv
auth.ROOT, auth.NAME, auth.SOURCE = ROOT, NAME, SOURCE
auth.AUTH, auth.REST, auth.NETWORK = AUTH, REST, NETWORK
auth.OBSERVE_ONLY = False
spec = importlib.util.spec_from_file_location('snapshot116_scaffold', Path(__file__).with_name('member_cleanup_reconcile_local.py'))
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
shared.ROOT, shared.NAME, shared.SOURCE = ROOT, NAME, SOURCE
call, docker, save = auth.call, auth.docker, auth.save
CREATED = {}
MIGRATIONS = [FOUNDATION / 'backend/supabase/migrations' / f for f in (
    '20261009011400_worker_intent_confirmation.sql', '20261009011500_member_cleanup_reconcile.sql',
    '20261009011600_content_inspection_tickets.sql', '20261009011700_member_retirement_receipt.sql')]
FROZEN = ('7ba321e924e02bfea41a244435a21a5fc52d71e049421e178ca72a91358065ed',
          '74a0d3b2af807310f76dd77d8769f3177ca8f47cef2161ca4b44f194bbb73081',
          'a3a7abf169d4edd2d86556def9823f5f56a2072796c3a9adcc1b46e1d23b58ec',
          'bfa60e1169dc3752c54a53c5a4be462af5a40ef87ccd4e8477f724230fd41456')
if AI_ONLY or CONSUMERS:
    # source112에 있는 AI/검색/회원 계약을 사용한다. AI-only에는 후속 콘텐츠 SQL 의존이 없다.
    MIGRATIONS, FROZEN = [], ()
if AI_EVENTS:
    MIGRATIONS = [FOUNDATION / 'backend/supabase/migrations/20261009031628_event_detail_projection.sql']
    FROZEN = ('8b5b4af91067276fdfd27cd7340d30ff04f94ba632b029fa274885fde0be636c',)
CONTROLS = ('worker_runtime_atomic_control', 'worker_invocation_control', 'worker_intent_confirmation_control',
            'event_collection_control', 'content_inspection_control', 'member_retirement_receipt_control')
CONSUMER_READ_FIX = CONSUMERS and int(VERSION) >= 20
if CONSUMER_READ_FIX:
    MIGRATIONS = [FOUNDATION / 'backend/supabase/migrations/20261010030000_hidden_message_read_receipts.sql']
    FROZEN = ('74653943bae50901d50c72b1f4ccd66502f2799fc8ea7a5115e73fde270fe6ef',)

PRIVILEGED = ('public.prepare_queue_invocation(uuid,uuid,text,integer,integer)',
              'public.claim_queue_invocation_dispatch(uuid,uuid,text,integer,integer)',
              'public.complete_queue_invocation(uuid)', 'public.begin_member_cleanup_reconcile(uuid,uuid,uuid,uuid)',
              'public.finish_member_cleanup_reconcile(uuid,text)',
              'public.prepare_worker_invocation_intent(uuid,uuid,text,jsonb,uuid)',
              'public.execute_worker_invocation_operation(uuid,uuid,uuid,text,jsonb)',
              'public.confirm_worker_runtime_intent(uuid)',
              'public.issue_content_inspection_ticket(uuid,uuid,text,uuid,jsonb,text,text,text)')


def sql(statement, name=None):
    # imported helper의 default NAME 캡처를 사용하지 않고 매번 현재 clone을 명시한다.
    target = NAME if name is None else name
    assert target in (NAME, SOURCE), 'UNOWNED_DATABASE_TARGET'
    if target == SOURCE:
        statement = 'begin read only;' + statement + 'rollback;'
    return shared.query(target, statement).decode().strip()


auth.sql = sql


def snapshot(name):
    return shared.normalized_snapshot(name)


def closed(name, *, final=False):
    tests = ['not(select external_deletion_approved from private.member_cleanup_guard)',
             'not(select token is not null from private.global_worker_run)']
    for table in CONTROLS:
        if sql("select to_regclass('private." + table + "')is not null;", name) == 't':
            tests.append('not(select enabled from private.' + table + ' where singleton)')
    assert sql('select ' + 'and '.join('(' + t + ')' for t in tests) + ';', name) == 't', 'CONTROL_DEFAULT_OPEN'
    if CONSUMERS:
        tests.append('not(select enabled from private.general_notice_delivery_control where singleton)')
        assert sql('select ' + 'and '.join('(' + t + ')' for t in tests) + ';', name) == 't', 'CONSUMER_NOTICE_CONTROL_DEFAULT_OPEN'
    for signature in PRIVILEGED:
        if sql("select to_regprocedure('" + signature + "')is not null;", name) == 't':
            condition = 'and '.join("not has_function_privilege('" + role + "','" + signature + "','EXECUTE')" for role in ('anon', 'authenticated', 'service_role', 'yumidang_worker_queue'))
            assert sql('select ' + condition + ';', name) == 't', 'PRIVILEGED_EXEC_OPEN'
    assert sql('show cron.launch_active_jobs;', name) == 'off', 'CRON_OPEN'


def upstream(path, method, headers, body=None):
    if path.startswith('/auth/v1/'):
        target = 'http://' + AUTH + ':9999/' + path.removeprefix('/auth/v1/')
    elif path.startswith('/rest/v1/rpc/'):
        target = 'http://' + REST + ':3000/rpc/' + path.removeprefix('/rest/v1/rpc/')
    else:
        raise RuntimeError('LOCAL_PATH_FORBIDDEN')
    assert method in ('GET', 'POST'), 'DELETE_FORBIDDEN'
    lines = ['silent', 'show-error', 'max-time = 30', 'request = ' + json.dumps(method, ensure_ascii=False), 'url = ' + json.dumps(target, ensure_ascii=False)]
    for key in ('authorization', 'apikey', 'content-type', 'x-content-inspection-ticket', 'x-content-operation-id'):
        if key in headers:
            assert '\r' not in headers[key] and '\n' not in headers[key]
            lines.append('header = ' + json.dumps(key + ': ' + headers[key], ensure_ascii=False))
    if body is not None:
        # curl config는 JSON의 \u escape를 지원하지 않는다. UTF-8 원문을 그대로 전달한다.
        lines.append('data-binary = ' + json.dumps(body.decode(), ensure_ascii=False))
    raw = docker('exec', '-i', NAME, 'curl', '--config', '-', '--write-out', '\n%{http_code}', data=('\n'.join(lines) + '\n').encode())
    content, status = raw.rsplit(b'\n', 1)
    if int(status) >= 400 and path.startswith('/rest/v1/rpc/'):
        # 오류의 원문·JWT·SQL 상세는 내보내지 않고 SQLSTATE만 private artifact에 남긴다.
        try:
            error_code = json.loads(content).get('code')
        except (ValueError, AttributeError):
            error_code = None
        save('rest-error-' + uuid.uuid4().hex + '.json', {'path': path, 'status': int(status),
                                                       'code': error_code if isinstance(error_code, str) else None})
    return int(status), content


auth.upstream = upstream


def record(name):
    info = auth.inspect(name)
    assert info['Config']['Labels'].get('yumidang.owner') == 'minkyu'
    assert not info['HostConfig'].get('PortBindings')
    CREATED[name] = info['Id']


def node(file, mode):
    for relative, expected in json.loads(file.read_text()).get('productManifest', {}).items():
        assert hashlib.sha256((FOUNDATION / relative).read_bytes()).hexdigest() == expected, 'PRODUCT_GRAPH_CHANGED_BEFORE_NODE:' + relative
    return json.loads(call(['node', '--experimental-strip-types', str(Path(__file__).with_suffix('.ts')), str(file), mode], timeout=90))


def product_sources(entrypoints=('service-api/index.ts',)):
    pending = [FOUNDATION / 'backend/supabase/functions' / v for v in entrypoints]
    visited = set()
    while pending:
        path = pending.pop().resolve()
        assert path.is_relative_to(FOUNDATION.resolve()), 'IMPORT_OUTSIDE_PRODUCT_SOURCE'
        if path in visited:
            continue
        visited.add(path)
        for local in re.findall(r'''(?:from\s*|import\s*)["'](\.[^"']+)["']''', path.read_text()):
            dependency = (path.parent / local).resolve()
            assert dependency.is_file() and dependency.suffix == '.ts', 'UNRESOLVED_LOCAL_PRODUCT_IMPORT'
            pending.append(dependency)
    return sorted(visited)


def full8_verify(fixture, case):
    """한 정상 쓰기의 실제 ticket 소비와 동일키 전체 snapshot 불변을 독립 확인한다."""
    label = case['rpc']
    payload = dict(fixture, scenario='full8', fullCase=case)
    save('full8-' + label + '-store-private.json', payload)
    stored = node(ROOT / ('full8-' + label + '-store-private.json'), '--full-store')
    assert stored['rpc'] == label and stored['parserRpcWholeInputMatched'] is True
    assert sql("select count(*)=1 from private.content_inspection_tickets where ticket_id='" + stored['ticketId'] + "'::uuid and user_id='" + fixture['accounts'][case['account']]['userId'] + "'::uuid and operation_id='" + case['operationId'] + "'::uuid and action='" + case['action'] + "'and consumed_at is not null;") == 't', 'FULL8_CONSUMPTION_MISSING:' + label
    proof = json.loads(sql("select jsonb_build_object('ticketId',ticket_id,'userId',user_id,'operationId',operation_id,'action',action,'targetId',target_id,'inputSha256',input_sha256,'consumedAt',consumed_at,'outcomeContainsRawProfile',outcome is not null and action in('profile_traits','profile_preferences','signup_traits'))from private.content_inspection_tickets where ticket_id='" + stored['ticketId'] + "';"))
    assert proof['targetId'] == case['targetId'] and not proof['outcomeContainsRawProfile'], 'FULL8_TICKET_BINDING_OR_RAW_PROFILE'
    save('full8-' + label + '-stored-proof.json', proof)
    before = snapshot(NAME)
    save('full8-' + label + '-before-replay-private.json', before)
    payload['fullStored'] = stored
    save('full8-' + label + '-replay-private.json', payload)
    replay = node(ROOT / ('full8-' + label + '-replay-private.json'), '--full-recover')
    after = snapshot(NAME)
    save('full8-' + label + '-after-replay-private.json', after)
    assert after == before, 'FULL8_REPLAY_CHANGED_ROWS_CATALOG_ROLES_ACL:' + label
    evidence = {'rpc': label, 'action': case['action'], 'store': stored, 'replay': replay,
                'storedProof': proof, 'sameKeyAllRowsCatalogRolesAclUnchanged': True}
    save('full8-' + label + '-evidence.json', evidence)
    return evidence


def full8_cases(fixture):
    """fixture 준비만 SQL로 수행한다. 검사·가입·콘텐츠 정상 쓰기는 실제 factory로 수행한다."""
    accounts = fixture['accounts']
    q = lambda v: "'" + v.replace("'", "''") + "'"
    result = []

    def execute(rpc, action, path, body, args, account, target):
        operation = args.get('p_message_id', str(uuid.uuid4()))
        result.append(full8_verify(fixture, {'rpc': rpc, 'action': action, 'path': path, 'body': body,
            'input': args, 'account': account, 'operationId': operation, 'targetId': target}))

    assert len(accounts) == 4
    assert sql("select not exists(select 1 from public.profiles where id=" + q(accounts[3]['userId']) + '::uuid);') == 't', 'SIGNUP_ALREADY_COMPLETED_IN_FIXTURE'
    avatar = accounts[3]['avatarPath']
    execute('complete_naver_signup', 'signup_traits', '/signup/complete', {'avatarPath': avatar},
            {'p_avatar_path': avatar, 'p_interests': [], 'p_conversation_styles': [], 'p_mbti': None}, 3, accounts[3]['userId'])
    assert sql('select count(*)=1 from public.profiles where id=' + q(accounts[3]['userId']) + '::uuid;') == 't'
    traits = {'interests': ['독서'], 'conversationStyles': ['차분한 대화'], 'mbti': 'INFP'}
    trait_args = {'p_interests': traits['interests'], 'p_conversation_styles': traits['conversationStyles'], 'p_mbti': traits['mbti']}
    execute('set_my_profile_traits', 'profile_traits', '/me/traits', traits, trait_args, 0, accounts[0]['userId'])
    execute('set_my_profile_preferences', 'profile_preferences', '/me/preferences', dict(traits, bio='합성 공개 소개'),
            dict(trait_args, p_bio='합성 공개 소개'), 0, accounts[0]['userId'])
    post_id = str(uuid.uuid4())
    starts = datetime.now(timezone.utc) + timedelta(days=3)
    stamp = lambda value: value.isoformat(timespec='microseconds').replace('+00:00', 'Z')
    # 등록 장소명·선호·태그·행사 키 생략은 실제 route parser 기본값과 동일한 검사 입력으로 결합한다.
    body = {'postId': post_id, 'title': '합성 검사 공고', 'description': '실제 factory 연결 확인', 'category': '산책',
            'startsAt': stamp(starts), 'endsAt': stamp(starts + timedelta(hours=2)), 'publicArea': '서울특별시 강남구 역삼동',
            'registeredAddress': '합성 비공개 주소 123', 'meetingDetail': '합성 비공개 입구', 'costType': 'free', 'amount': 0}
    post_input = {k: v for k, v in body.items() if k != 'postId'}
    post_input.update(recruitmentEndsAt=body['startsAt'], registeredPlaceName=None, preferenceNote=None, tags=[])
    execute('create_service_post', 'post_create', '/posts', body, {'p_post_id': post_id, 'p_input': post_input}, 0, post_id)
    assert sql('select count(*)=1 from public.posts where id=' + q(post_id) + '::uuid;') == 't'
    updated = sql('select to_jsonb(updated_at)#>>\'{}\'from public.posts where id=' + q(post_id) + '::uuid;')
    update_body = {k: v for k, v in body.items() if k != 'postId'}
    update_body.update(expectedUpdatedAt=updated, title='합성 검사 수정 공고', registeredPlaceName='합성 장소')
    update_input = dict(post_input, title=update_body['title'], registeredPlaceName=update_body['registeredPlaceName'])
    execute('update_service_post', 'post_update', '/posts/' + post_id + '/update', update_body,
            {'p_post_id': post_id, 'p_input': update_input, 'p_expected_updated_at': updated}, 0, post_id)
    message_id, message = str(uuid.uuid4()), '합성 첫 신청 메시지'
    execute('request_service_post', 'application_message', '/posts/' + post_id + '/requests', {'messageId': message_id, 'message': message},
            {'p_post_id': post_id, 'p_message_id': message_id, 'p_message': message}, 1, post_id)
    request_id = sql('select id::text from public.join_requests where post_id=' + q(post_id) + '::uuid and requester_id=' + q(accounts[1]['userId']) + '::uuid;')
    uuid.UUID(request_id)
    chat_id, chat = str(uuid.uuid4()), '합성 일반 채팅 메시지'
    execute('send_conversation_message', 'chat_message', '/conversations/' + request_id + '/messages', {'messageId': chat_id, 'content': chat},
            {'p_request_id': request_id, 'p_message_id': chat_id, 'p_content': chat}, 1, request_id)
    past_post, past_request, appointment = [str(uuid.uuid4()) for _ in range(3)]
    sql("begin;select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)values(" + q(past_post) + '::uuid,' + q(accounts[0]['userId']) + "::uuid,'합성 후기 공고','실제 후기 작성 조건','산책',clock_timestamp()-interval'3 hours',clock_timestamp()-interval'1 hour',clock_timestamp()-interval'4 hours','서울특별시 강남구 역삼동');insert into public.join_requests(id,post_id,requester_id,message,status)values(" + q(past_request) + '::uuid,' + q(past_post) + '::uuid,' + q(accounts[1]['userId']) + "::uuid,'합성 후기 신청','matched');insert into public.appointments(id,post_id,join_request_id,status,confirmed_at)values(" + q(appointment) + '::uuid,' + q(past_post) + '::uuid,' + q(past_request) + "::uuid,'confirmed',clock_timestamp()-interval'4 hours');commit;")
    for account in accounts[:2]:
        claims = json.dumps({'role': 'authenticated', 'sub': account['userId'], 'session_id': account['sessionId']})
        sql('begin;select set_config(\'request.jwt.claims\',' + q(claims) + ',true);select set_config(\'request.jwt.claim.sub\',' + q(account['userId']) + ',true);select public.confirm_appointment_completion(' + q(appointment) + '::uuid);commit;')
    assert sql('select status=\'completed\'from public.appointments where id=' + q(appointment) + '::uuid;') == 't', 'REVIEW_REQUIRES_BOTH_COMPLETIONS'
    # 후기 comment/praises 생략의 nullable·빈 배열 정규화까지 검증한다.
    execute('submit_appointment_review', 'review', '/appointments/' + appointment + '/reviews', {'rating': 4, 'experience': 'neutral'},
            {'p_appointment_id': appointment, 'p_rating': 4, 'p_comment': None, 'p_experience': 'neutral', 'p_praises': []}, 1, appointment)
    assert len(result) == 8 and len({v['rpc'] for v in result}) == 8
    return result


AI_ORIGINAL = None
CONSUMER_NOTICE_ORIGINAL = None
AI_FIXTURE = None
AI_QUOTA_ORIGINAL = None
AI_SIGNATURES = (
    'public.acquire_ai_chat_request(uuid,uuid,text,uuid,text)',
    'public.finish_ai_chat_request(uuid,uuid,uuid,text)',
    'public.reserve_ai_chat_account_model(text,text,text,bigint,uuid,uuid,uuid,text,text)',
    'public.settle_ai_account_budget(uuid,text,date,text,bigint,bigint)',
    'public.record_ai_chat_result_available(uuid,uuid,uuid)',
)


def consumer_node_call(args, data=None, timeout=120):
    """실제로 생성한 Node PID만 종료한다. 토큰·명령·본문은 기록하지 않는다."""
    process = subprocess.Popen(args, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    key = uuid.uuid4().hex
    save('consumer-node-start-' + key + '.json', {'pid': process.pid, 'ownedChild': True})
    terminated = False
    try:
        stdout, stderr = process.communicate(input=data, timeout=timeout)
        return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
    except BaseException:
        if process.poll() is None:
            terminated = True
            process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=5)
        raise
    finally:
        save('consumer-node-end-' + key + '.json', {'pid': process.pid, 'ownedChild': True,
             'terminatedOnFailure': terminated, 'returnCode': process.returncode,
             'stillRunning': process.poll() is None})


def ai_safe_call(args, data=None, timeout=120):
    # AI 시나리오에서는 명령/오류의 DSN·키·원문을 로그에 쓰지 않는다. 고정 코드와 digest만 보존한다.
    if 'psql' in args:
        args = [*args, '-v', 'VERBOSITY=sqlstate']
    try:
        result = consumer_node_call(args, data, timeout) if CONSUMERS and args[0] == 'node' else subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        save('ai-tool-timeout-' + uuid.uuid4().hex + '.json', {
            'code': 'AI_TOOL_TIMEOUT', 'stdoutSha256': hashlib.sha256(error.stdout or b'').hexdigest(),
            'stderrSha256': hashlib.sha256(error.stderr or b'').hexdigest()})
        raise RuntimeError('AI_TOOL_TIMEOUT') from None
    if result.returncode:
        save('ai-tool-failure-' + uuid.uuid4().hex + '.json', {
            'code': 'AI_TOOL_FAILED', 'exitCode': result.returncode,
            'sqlStates': sorted(set(v.decode() for v in re.findall(rb'(?m)(?:ERROR|FATAL):\s+([A-Z0-9]{5})\b', result.stderr))),
            'caseCodes': sorted(set(v.decode() for v in re.findall(rb'(?m)^((?:AI_CHECK_|CONSUMER_CHECK_)[A-Z_]+)$' if CONSUMERS else rb'(?m)^(AI_CHECK_[A-Z_]+)$', result.stderr))),
            'stdoutSha256': hashlib.sha256(result.stdout).hexdigest(),
            'stderrSha256': hashlib.sha256(result.stderr).hexdigest()})
        raise RuntimeError('AI_TOOL_FAILED')
    return result.stdout


def ai_config(fixture):
    ids = ','.join("'" + str(uuid.UUID(a['userId'])) + "'::uuid" for a in fixture['accounts'])
    return json.loads(sql("select jsonb_build_object('guard',(select to_jsonb(g)from private.ai_processing_guard g where singleton),"
                         "'accounts',(select jsonb_agg(to_jsonb(a)order by account_order)from private.ai_budget_accounts a),"
                         "'members',(select coalesce(jsonb_agg(to_jsonb(m)order by user_id),'[]'::jsonb)from private.ai_member_processing m where user_id in(" + ids + ')));'))


def ai_restore():
    if NAME not in CREATED:
        return
    if AI_ORIGINAL is None:
        if sql("select to_regclass('private.ai_processing_guard')is not null;") == 't':
            sql('update private.ai_processing_guard set external_processing_allowed=false where singleton;')
        return
    q = lambda v: "'" + v.replace("'", "''") + "'"
    configuration = AI_ORIGINAL['config']
    old_members = {m['user_id']: m for m in configuration['members']}
    # 미종결 요청의 점유를 지워서 정상 정리로 위장하지 않는다. 만료도 완료 증거가 아니다.
    ids = ','.join(q(str(uuid.UUID(a['userId']))) + '::uuid' for a in AI_FIXTURE['accounts'])
    sql('update private.ai_processing_guard set external_processing_allowed=false where singleton;')
    unfinished = sql("select exists(select 1 from private.ai_chat_requests where user_id in(" + ids + ')and outcome is null);') == 't'
    statements = ['begin;']
    if AI_QUOTA_ORIGINAL is not None:
        uid = str(uuid.UUID(AI_QUOTA_ORIGINAL['user_id']))
        day = AI_QUOTA_ORIGINAL['kst_day']
        datetime.strptime(day, '%Y-%m-%d')
        statements.append('update private.ai_member_daily_usage set started_requests=' + str(AI_QUOTA_ORIGINAL['started_requests']) + " where user_id='" + uid + "'and kst_day='" + day + "'and started_requests=20;")
    for account in AI_FIXTURE['accounts']:
        uid = str(uuid.UUID(account['userId']))
        original = old_members.get(uid)
        if unfinished:
            statements.append("update private.ai_member_processing set exploration_allowed=false,summary_allowed=false where user_id='" + uid + "';")
        elif original is None:
            statements.append("delete from private.ai_member_processing where user_id='" + uid + "';")
        else:
            assignments = []
            for key in ('exploration_allowed', 'summary_allowed', 'exploration_withdrawn_at', 'summary_withdrawn_at', 'active_request_id'):
                value = original[key]
                literal = 'null' if value is None else (str(value).lower() if isinstance(value, bool) else q(value))
                assignments.append(key + '=' + literal)
            statements.append('update private.ai_member_processing set ' + ','.join(assignments) + " where user_id='" + uid + "';")
    for account in configuration['accounts']:
        statements.append('update private.ai_budget_accounts set registered=' + str(account['registered']).lower() + ' where account_id=' + q(account['account_id']) + ';')
    statements.append('update private.ai_processing_guard set external_processing_allowed=' + str(configuration['guard']['external_processing_allowed']).lower() + ' where singleton;commit;')
    sql('\n'.join(statements))
    if unfinished:
        save('ai-unfinished-preserved.json', {'code': 'AI_UNFINISHED_REQUEST_PRESERVED', 'guardClosed': True, 'activePointerNotErased': True})
        raise RuntimeError('AI_UNFINISHED_REQUEST_PRESERVED')
    assert ai_config(AI_FIXTURE) == configuration, 'AI_ORIGINAL_SETTINGS_NOT_RESTORED'
    after = snapshot(NAME)
    assert after['catalog'] == AI_ORIGINAL['catalog'] and after['roles'] == AI_ORIGINAL['roles'], 'AI_ACL_CATALOG_ROLES_CHANGED'
    assert sql('select not external_processing_allowed from private.ai_processing_guard where singleton;') == 't', 'AI_PROCESSING_GUARD_NOT_CLOSED'


def ai_usage(uid):
    return int(sql("select coalesce(sum(started_requests),0)from private.ai_member_daily_usage where user_id='" + str(uuid.UUID(uid)) + "';"))


def ai_proof(fixture, observed, expected_started):
    uid = str(uuid.UUID(fixture['accounts'][1]['userId']))
    proved = []
    started = 0
    for request in observed['requests']:
        rid = str(uuid.UUID(request['requestId']))
        if request['acquireStatus'] != 'acquired':
            assert sql("select not exists(select 1 from private.ai_chat_requests where request_id='" + rid + "');") == 't', 'DENIED_REQUEST_CREATED'
            proved.append({'requestId': rid, 'acquireStatus': request['acquireStatus'], 'requestCreated': False})
            continue
        row = json.loads(sql("select jsonb_build_object('leaseSha256',encode(sha256(convert_to(lease_token::text,'UTF8')),'hex'),"
                            "'ownerBound',user_id='" + uid + "'::uuid,'finished',outcome='finished'and finished_at is not null,"
                            "'started',started_at is not null,'kstDayBound',counted_day is null or counted_day=(started_at at time zone'Asia/Seoul')::date,"
                            "'resultRecorded',(select count(*)=1 from private.ai_result_receipts where request_id=r.request_id and user_id=r.user_id))"
                            "from private.ai_chat_requests r where request_id='" + rid + "';"))
        assert row['ownerBound'] and row['finished'] and row['kstDayBound'] and row['leaseSha256'] == request['leaseSha256'], 'AI_SCOPE_FINISH_OR_DAY_UNPROVEN'
        expected_result = observed['case'] in ('normal-followup', 'no-results', 'clarification', 'permission-reread') or (fixture.get('aiEventPriceScenario') is True and observed['case'].startswith('event-'))
        assert row['resultRecorded'] == expected_result, 'AI_RESULT_RECEIPT_UNPROVEN'
        started += int(row['started'])
        proved.append(dict(row, requestId=rid))
    assert started == expected_started, 'AI_FIRST_MODEL_CHARGE_UNPROVEN'
    assert sql("select active_request_id is null from private.ai_member_processing where user_id='" + uid + "';") == 't', 'AI_ACTIVE_REQUEST_NOT_RELEASED'
    receipts = []
    for reservation in observed['reservations']:
        rid = str(uuid.UUID(reservation['reservationId']))
        day = reservation['accountDay']
        assert reservation['accountId'] in ('yumi', 'jonghyun', 'minkyu', 'sungho'), 'AI_RESERVATION_ACCOUNT_UNKNOWN'
        assert reservation['dispatched'] and reservation['settled'], 'AI_RESERVATION_TRANSPORT_LIFECYCLE_UNPROVEN'
        assert reservation['requestId'] in {r['requestId'] for r in observed['requests'] if r['acquireStatus'] == 'acquired'}, 'AI_RESERVATION_REQUEST_UNBOUND'
        datetime.strptime(day, '%Y-%m-%d')
        row = json.loads(sql("select jsonb_build_object('exactBinding',ledger_id='" + fixture['aiLedgerId'] + "'and account_id='" + reservation['accountId'] + "'and account_day='" + day + "'::date,"
                            "'reservedUnits',reserved_units,'settled',settled_at is not null,'unknown',unknown_at is not null,"
                            "'reportedTwoTokens',input_tokens=1 and output_tokens=1,"
                            "'legacyPending',exists(select 1 from private.ai_budget_reservations where id=a.reservation_id))"
                            "from private.ai_account_budget_reservations a where reservation_id='" + rid + "';"))
        assert row['exactBinding'] and row['reservedUnits'] == reservation['units'], 'AI_ACCOUNT_RESERVATION_BINDING'
        if observed['case'] == 'provider-failure':
            assert row['unknown'] and not row['settled'] and row['legacyPending'], 'AI_UNKNOWN_RESERVATION_RELEASED'
        else:
            assert row['settled'] and not row['unknown'] and row['reportedTwoTokens'] and not row['legacyPending'], 'AI_ACTUAL_SETTLEMENT_UNPROVEN'
        receipts.append(dict(row, reservationId=rid, requestId=reservation['requestId'], task=reservation['task']))
    assert len(receipts) == observed['providerInterceptions'], 'MODEL_DISPATCH_WITHOUT_REAL_RESERVATION'
    return {'requests': proved, 'reservations': receipts, 'firstModelStartedRequests': started,
            'metadataOnlyReceipt': True, 'requestFinishReleasedOccupancy': True}


def ai_event_fixture(fixture):
    """새 clone의 합성 canonical/detail을 실제 SQL119 경계로 저장한다. 원문 출력은 없다."""
    q = lambda v: "'" + v.replace("'", "''") + "'"
    fixture.update(aiEventSourceId='PFTEST' + uuid.uuid4().hex, aiPrice='가격안내' * 2500,
                   aiFreshPrice='최신가격' * 2500, aiOperating='합성 최신 운영 안내',
                   aiDescription='합성 최신 상세 설명')
    assert len(fixture['aiPrice']) == len(fixture['aiFreshPrice']) == 10000
    sql("do $$declare base jsonb;source private.source_events;stamp timestamptz:=clock_timestamp();"
        "day date:=(clock_timestamp()at time zone'Asia/Seoul')::date;begin "
        "base:=jsonb_build_object('provider','kopis','sourceId'," + q(fixture['aiEventSourceId']) + ","
        "'sourceStatus','active','title'," + q(fixture['aiTitle']) + ",'category','대중음악','region','서울특별시',"
        "'placeName','합성 공연장','publicAddress','서울 합성 주소','admission',jsonb_build_object('kind','free'),"
        "'sourceUrl',null,'collectedAt',to_char(stamp at time zone'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),"
        "'precision','date','startsOn',(day+1)::text,'endsOn',(day+8)::text);"
        "if not private.valid_source_event_v2(jsonb_set(base,'{admission}',jsonb_build_object('kind','described','text'," + q(fixture['aiPrice']) + ")))"
        "or private.valid_source_event_v2(jsonb_set(base,'{admission}',jsonb_build_object('kind','described','text'," + q(fixture['aiPrice'] + '가') + ")))"
        "or private.valid_source_event_v2(base||'{\"meetingDetail\":\"AI_PRIVATE_MEETING_CANARY\"}'::jsonb)"
        "or private.valid_source_event_v2(jsonb_set(base,'{admission}',jsonb_build_object('kind','described','text','<script>')))then raise exception 'event_validator_boundary_failed';end if;"
        "perform private.upsert_canonical_events(jsonb_build_array(base));"
        "select *into strict source from private.source_events where provider='kopis'and source_id=" + q(fixture['aiEventSourceId']) + ";"
        "if not private.merge_event_detail(source,jsonb_build_object('provider','kopis','sourceId',source.source_id,"
        "'collectedAt',to_char((stamp+interval'1 minute')at time zone'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),"
        "'admission',jsonb_build_object('kind','described','text'," + q(fixture['aiPrice']) + "),"
        "'operatingInfo','합성 이전 운영 안내','description','합성 이전 상세 설명',"
        "'posterUrl','https://www.kopis.or.kr/upload/fixture119.jpg'))then raise exception 'event_fixture_failed';end if;end;$$;")
    fixture['aiEventId'] = str(uuid.UUID(sql("select id from private.source_events where provider='kopis'and source_id=" + q(fixture['aiEventSourceId']) + ';')))


def ai_event_revision(fixture, refresh=False):
    q = lambda v: "'" + v.replace("'", "''") + "'"
    eid = q(fixture['aiEventId']) + '::uuid'
    if not refresh:
        sql("update private.source_events set collected_at=collected_at+interval'2 hours',"
            "record=jsonb_set(record,'{collectedAt}',to_jsonb(to_char((collected_at+interval'2 hours')at time zone'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')))where id=" + eid + ';')
    else:
        sql("do $$declare source private.source_events;begin select *into strict source from private.source_events where id=" + eid + ";"
            "if not private.merge_event_detail(source,jsonb_build_object('provider','kopis','sourceId',source.source_id,"
            "'collectedAt',to_char((source.collected_at+interval'1 minute')at time zone'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),"
            "'admission',jsonb_build_object('kind','described','text'," + q(fixture['aiFreshPrice']) + "),"
            "'operatingInfo'," + q(fixture['aiOperating']) + ",'description'," + q(fixture['aiDescription']) + ","
            "'posterUrl','https://www.kopis.or.kr/upload/fixture119.jpg'))then raise exception 'event_revision_failed';end if;end;$$;")


def ai_event_database_proof(fixture, label):
    q = lambda v: "'" + v.replace("'", "''") + "'"
    row = json.loads(sql("select jsonb_build_object('priceLength',length(s.record#>>'{admission,text}'),"
        "'priceSha256',encode(sha256(convert_to(s.record#>>'{admission,text}','UTF8')),'hex'),"
        "'revisionMatched',s.collected_at=d.source_collected_at,'sourceIdBound',s.source_id=" + q(fixture['aiEventSourceId']) + ","
        "'hiddenForViewer',exists(select 1 from private.member_hidden_targets h join private.member_episodes ep on ep.identity_id=h.identity_id "
        "where ep.profile_id=" + q(fixture['accounts'][1]['userId']) + "::uuid and ep.ended_at is null and h.target_type='event'and h.target_id=s.id))"
        "from private.source_events s join private.event_source_details d on d.source_event_id=s.id where s.id=" + q(fixture['aiEventId']) + '::uuid;'))
    price = fixture['aiFreshPrice'] if label in ('event-price-refreshed', 'event-price-hidden', 'event-price-free-only') else fixture['aiPrice']
    assert row['priceLength'] == 10000 and row['priceSha256'] == hashlib.sha256(price.encode()).hexdigest() and row['sourceIdBound'], 'EVENT_PRICE_DB_BINDING'
    assert row['revisionMatched'] == (label != 'event-price-stale'), 'EVENT_PRICE_REVISION_BINDING'
    assert row['hiddenForViewer'] == (label == 'event-price-hidden'), 'EVENT_PRICE_HIDE_BINDING'
    return row


def ai_units(fixture, source_before, manifest):
    global AI_ORIGINAL, AI_FIXTURE, AI_QUOTA_ORIGINAL
    q = lambda v: "'" + v.replace("'", "''") + "'"
    for signature in AI_SIGNATURES:
        assert sql("select to_regprocedure('" + signature + "')is not null and has_function_privilege('service_role','" + signature + "','EXECUTE');") == 't', 'AI_SOURCE_RPC_OR_ACL_MISSING'
    baseline = snapshot(NAME)
    configuration = ai_config(fixture)
    assert not configuration['guard']['external_processing_allowed'], 'AI_REQUIRES_DEFAULT_CLOSED_GUARD'
    AI_ORIGINAL = {'config': configuration, 'catalog': baseline['catalog'], 'roles': baseline['roles']}
    AI_FIXTURE = fixture
    save('ai-original-settings-private.json', AI_ORIGINAL)
    fixture.update(aiLedgerId='synthetic-ai-' + uuid.uuid4().hex, aiQuery='synthetic-ai-' + uuid.uuid4().hex,
                   aiPostId=str(uuid.uuid4()))
    fixture['aiTitle'] = 'AI ' + fixture['aiQuery']
    assert 1 <= len(fixture['aiTitle']) <= 50, 'AI_SYNTHETIC_TITLE_CURRENT_POLICY_REQUIRED'
    uid = fixture['accounts'][1]['userId']
    ids = ','.join(q(a['userId']) + '::uuid' for a in fixture['accounts'])
    sql("begin;update private.ai_budget_accounts set registered=true;update private.ai_processing_guard set external_processing_allowed=true where singleton;"
        "insert into private.ai_member_processing(user_id,exploration_allowed)select unnest(array[" + ids + "]),true on conflict(user_id)do update set exploration_allowed=true;"
        "insert into private.ai_budget_ledgers(ledger_id,unit_limit,call_limit)values(" + q(fixture['aiLedgerId']) + ",100000000,1000);"
        "insert into private.profile_traits(profile_id,mbti)values(" + q(fixture['accounts'][0]['userId']) + ", 'INFP')on conflict(profile_id)do update set mbti='INFP';"
        "insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,cost_type,amount)values(" + q(fixture['aiPostId']) + '::uuid,' + q(fixture['accounts'][0]['userId']) + '::uuid,' + q(fixture['aiTitle']) + ",'합성 실제 AI 탐색','산책',clock_timestamp()+interval'3 days',clock_timestamp()+interval'3 days 2 hours',clock_timestamp()+interval'2 days','서울특별시 강남구 역삼동','free',0);"
        "insert into private.post_search_locations(post_id,registered_place_name,registered_address)values(" + q(fixture['aiPostId']) + ",'합성 공개 장소','AI_PRIVATE_ADDRESS_CANARY');"
        "insert into public.post_private_details(post_id,exact_location)values(" + q(fixture['aiPostId']) + ",'AI_PRIVATE_MEETING_CANARY');commit;")
    if AI_EVENTS:
        ai_event_fixture(fixture)
    evidence = []
    cases = [('normal-followup', 'results', 2), ('no-results', 'no_results', 1), ('clarification', 'needs_clarification', 0),
             ('permission-reread', 'no_results', 1), ('unconfigured', 'unavailable', 0), ('unauthenticated', None, 0),
             ('service-token', None, 0), ('anon-token', None, 0), ('consent-denied', 'unavailable', 0),
             ('daily-limit', 'unavailable', 0), ('processing-closed', 'unavailable', 0),
             ('budget-denied', 'unavailable', 0), ('provider-failure', 'unavailable', 1)]
    if AI_EVENTS:
        cases = [('event-price-normal', 'results', 1), ('event-price-stale', 'results', 1),
                 ('event-price-refreshed', 'results', 1), ('event-price-hidden', 'no_results', 1),
                 ('event-price-free-only', 'no_results', 1), ('event-private-point-query', 'no_results', 1),
                 ('provider-failure', 'unavailable', 1)]
    for label, status, started in cases:
        if label == 'event-price-stale':
            ai_event_revision(fixture)
        if label == 'event-price-refreshed':
            ai_event_revision(fixture, refresh=True)
        if label == 'event-price-hidden':
            sql("insert into private.member_hidden_targets(identity_id,target_type,target_id)select identity_id,'event'," + q(fixture['aiEventId']) + "::uuid from private.member_episodes where profile_id=" + q(uid) + "::uuid and ended_at is null;")
        if label == 'consent-denied':
            sql("update private.ai_member_processing set exploration_allowed=false where user_id=" + q(uid) + ';')
        quota_before = None
        if label == 'daily-limit':
            quota_before = json.loads(sql("select to_jsonb(u)from private.ai_member_daily_usage u where user_id=" + q(uid) + "and kst_day=(clock_timestamp()at time zone'Asia/Seoul')::date;"))
            assert quota_before, 'AI_QUOTA_FIXTURE_REQUIRES_PRIOR_REAL_CHARGE'
            AI_QUOTA_ORIGINAL = quota_before
            sql("update private.ai_member_daily_usage set started_requests=20 where user_id=" + q(uid) + "and kst_day='" + quota_before['kst_day'] + "';")
        if label == 'processing-closed':
            sql('update private.ai_processing_guard set external_processing_allowed=false where singleton;')
        case_fixture = dict(fixture, aiCase={'name': label, 'expectedStatus': status, 'httpStatus': 401 if status is None else 200})
        if label == 'budget-denied':
            case_fixture['aiLedgerId'] = 'synthetic-ai-denied-' + uuid.uuid4().hex
            sql('insert into private.ai_budget_ledgers(ledger_id,unit_limit,call_limit)values(' + q(case_fixture['aiLedgerId']) + ',1,1);')
        path = ROOT / ('ai-case-' + label + '-private.json')
        save(path.name, case_fixture)
        before_usage = ai_usage(uid)
        observation = node(path, '--ai-case')
        assert ai_usage(uid) == before_usage + started, 'AI_PERSONAL_CHARGE_DELTA'
        proof = ai_proof(case_fixture, observation, started)
        if AI_EVENTS and label.startswith('event-price-'):
            proof['eventProjection'] = ai_event_database_proof(fixture, label)
        evidence.append({'case': label, 'observed': observation, 'databaseProof': proof})
        save('ai-proof-' + label + '.json', evidence[-1])
        if label == 'event-price-hidden':
            sql("delete from private.member_hidden_targets h using private.member_episodes ep where h.identity_id=ep.identity_id and ep.profile_id=" + q(uid) + "::uuid and ep.ended_at is null and h.target_type='event'and h.target_id=" + q(fixture['aiEventId']) + '::uuid;')
        if label == 'permission-reread':
            assert sql("select count(*)=1 from private.member_blocks where blocker_id=" + q(uid) + 'and blocked_id=' + q(fixture['accounts'][0]['userId']) + ';') == 't', 'AI_PERMISSION_BARRIER_NOT_STORED'
            # 정상 쓰기 증거를 대신하지 않는 합성 환경 정리다. 원 회원 차단 기록은 만지지 않는다.
            sql("delete from private.member_blocks where blocker_id=" + q(uid) + 'and blocked_id=' + q(fixture['accounts'][0]['userId']) + ';')
        if label == 'consent-denied':
            sql("update private.ai_member_processing set exploration_allowed=true where user_id=" + q(uid) + ';')
        if quota_before:
            sql('update private.ai_member_daily_usage set started_requests=' + str(quota_before['started_requests']) + ' where user_id=' + q(uid) + "and kst_day='" + quota_before['kst_day'] + "';")
        if quota_before:
            AI_QUOTA_ORIGINAL = None
        if label == 'processing-closed':
            sql('update private.ai_processing_guard set external_processing_allowed=true where singleton;')
    # 예약 aggregate는 남은 UNKNOWN을 포함해야 하며 정상 정산을 임의로 취소하지 않는다.
    assert sql("select l.reserved_units=coalesce(sum(a.units),0)and l.open_calls=count(a.id)from private.ai_budget_ledgers l left join private.ai_budget_reservations a on a.ledger_id=l.ledger_id where l.ledger_id=" + q(fixture['aiLedgerId']) + 'group by l.reserved_units,l.open_calls;') == 't', 'AI_PENDING_AGGREGATE_UNPROVEN'
    assert sql("select count(*)=1 from private.ai_account_budget_reservations where ledger_id=" + q(fixture['aiLedgerId']) + 'and unknown_at is not null and settled_at is null;') == 't', 'AI_UNKNOWN_METADATA_NOT_PRESERVED'
    for table in ('ai_chat_requests', 'ai_member_processing', 'ai_member_daily_usage', 'ai_budget_ledgers', 'ai_budget_reservations', 'ai_account_budget_reservations', 'ai_result_receipts'):
        assert sql("select not exists(select 1 from private." + table + " t where strpos(to_jsonb(t)::text,'AI_DIALOGUE_CANARY')>0);" ) == 't', 'AI_RAW_DIALOGUE_PERSISTED'
    ai_restore()
    closed(NAME, final=True)
    assert snapshot(SOURCE) == source_before, 'READONLY_SOURCE_CHANGED'
    for relative, expected in manifest.items():
        assert hashlib.sha256((FOUNDATION / relative).read_bytes()).hexdigest() == expected, 'AI_PRODUCT_GRAPH_CHANGED'
    receipt = {'status': 'PASS', 'scope': 'ISOLATED_REAL_SIGNED_AUTH_REST_AI_FACTORY_SYNTHETIC_MODEL',
               'scenario': 'ai-event-price' if AI_EVENTS else 'ai-chat', 'manifest': manifest, 'sourceTableCount': 186,
               'sourceRowsCatalogRolesAclUnchanged': True, 'units': evidence,
               'providerNativeExternalTransport': 0, 'rawPromptsModelResponsesDsnsLogged': False,
               'originalSettingsAndAclRestored': True, 'processingGuardClosed': True,
               'protectedSyntheticBudgetMetadataAndUnknownPreserved': True, 'cloneRowsRolledBack': False,
               'model': 'EXPLICIT_SYNTHETIC_IN_MEMORY_ADAPTER', 'realProviderQualityAccountCostResetSharedUseLegalMemberLogin': 'NOT_RUN',
               'longKopisPriceAbove2000': 'PASS_ACTUAL_SQL119_AUTH_RPC_SYNTHETIC_MODEL' if AI_EVENTS else 'NOT_RUN_EXISTING_PROJECTION_HOLD',
               **({'actualWallClockMidnight': 'NOT_RUN'} if AI_EVENTS else {}),
               'internalNetworkNoPublishedDockerPorts': True, 'dbTlsVerifyFull': True,
               'externalDeleteAndAckCalls': 0, 'operatingChanged': False, 'containersStoppedAndPreserved': True}
    save('ai-http-provisional.json', receipt)
    return receipt


def ai_main():
    global call, docker
    if CONSUMERS:
        import signal
        def consumer_stop(signum, frame):
            raise RuntimeError('CONSUMER_OWN_PROCESS_TERMINATED')
        signal.signal(signal.SIGTERM, consumer_stop)
    # 기존 콘텐츠 분기의 원문 오류 보존 방식을 바꾸지 않고 AI 전용 logger만 교체한다.
    auth.call = ai_safe_call
    shared.call = ai_safe_call
    call = ai_safe_call
    docker = auth.docker
    result = None
    try:
        result = run()
    except Exception as error:
        if ROOT.is_dir() and ROOT.resolve() == ROOT and not(ROOT.stat().st_mode & 0o077):
            kind = type(error).__name__
            allowed = {'AssertionError', 'FileNotFoundError', 'KeyError', 'RuntimeError', 'TimeoutError', 'ValueError'}
            trace = error.__traceback__
            line = 0
            while trace is not None:
                if Path(trace.tb_frame.f_code.co_filename).resolve() == Path(__file__).resolve():
                    line = trace.tb_lineno
                trace = trace.tb_next
            save('ai-failure-' + uuid.uuid4().hex + '.json', {'code': 'AI_HTTP_FAILED',
                 'errorType': kind if kind in allowed else 'UNCLASSIFIED', 'harnessLine': line,
                 'rawErrorLogged': False})
        raise SystemExit('AI_HTTP_FAILED_PRIVATE_METADATA_PRESERVED') from None
    finally:
        try:
            if CONSUMERS:
                consumer_restore()
            ai_restore()
            if NAME in CREATED:
                closed(NAME, final=True)
            if (ROOT / 'source-before-private.json').is_file():
                after = snapshot(SOURCE)
                save('ai-source-final-private.json', after)
                assert after == json.loads((ROOT / 'source-before-private.json').read_text()), 'AI_SOURCE_CHANGED_AT_CLOSE'
        finally:
            for name, identifier in reversed(list(CREATED.items())):
                assert auth.inspect(name)['Id'] == identifier, 'AI_CREATED_CONTAINER_ID_CHANGED'
                docker('stop', '--time', '5', name)
            if ROOT.is_dir() and CREATED:
                save('ai-closed-and-stopped.json', {'containers': list(CREATED), 'stopped': all(not auth.inspect(n)['State']['Running'] for n in CREATED)})
    save('receipt.json', result)
    print(json.dumps(result, ensure_ascii=False))



def consumer_read_functions():
    signatures = "'private.conversation_unread_messages(uuid)'::regprocedure,'public.mark_conversation_messages_read(uuid,uuid[])'::regprocedure,'public.mark_conversation_read(uuid,uuid)'::regprocedure"
    return json.loads(sql("select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'metadata',to_jsonb(p)-'prosrc','definition',pg_get_functiondef(p.oid))order by p.oid)from pg_proc p where p.oid in(" + signatures + ');'))


def consumer_catalog_read_fix(catalog):
    """두 CREATE FUNCTION 블록만 정확히 바꾼 예상 catalog다. watermark 블록은 건드리지 않는다."""
    needle = 'and private.conversation_message_readable(m.id)'
    replacement = needle + "and not private.member_content_hidden('chat',m.id)"
    for function in ('private.conversation_unread_messages', 'public.mark_conversation_messages_read'):
        matches = list(re.finditer(r'(?m)^CREATE FUNCTION ' + re.escape(function) + r'\(', catalog))
        assert len(matches) == 1, 'READ_FIX_CATALOG_FUNCTION_MISSING_OR_DUPLICATE'
        start = matches[0].start()
        end = catalog.find('\nALTER FUNCTION ', start)
        assert end > start, 'READ_FIX_CATALOG_FUNCTION_BOUNDARY'
        block = catalog[start:end]
        assert block.count(needle) == 1 and 'private.member_content_hidden' not in block, 'READ_FIX_CATALOG_BODY_CHANGED'
        catalog = catalog[:start] + block.replace(needle, replacement) + catalog[end:]
    return catalog


def consumer_read_fix_negative(statement, expected, label):
    # 실패해도 연결 종료가 BEGIN 전체를 rollback한다. 성공 경로에도 명시 ROLLBACK이 있다.
    assert statement.startswith('begin;\n') and statement.endswith('rollback;\n'), 'READ_FIX_NEGATIVE_TRANSACTION_BOUNDARY'
    result = subprocess.run(auth.DOCKER + ['exec', '-i', NAME, 'psql', '-XqAt', '-U', auth.BOOT,
                            '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate'],
                            input=statement.encode(), capture_output=True, timeout=90)
    states = sorted(set(value.decode() for value in re.findall(rb'(?m)(?:ERROR|FATAL):\s+([A-Z0-9]{5})\b', result.stderr)))
    save('consumer-read-fix-' + label + '.json', {'code': 'EXPECTED_MIGRATION_GUARD_REJECTION',
         'exitCode': result.returncode, 'sqlStates': states,
         'stdoutSha256': hashlib.sha256(result.stdout).hexdigest(),
         'stderrSha256': hashlib.sha256(result.stderr).hexdigest()})
    assert result.returncode == 3 and states == ['55000'] and result.stdout == b'', 'READ_FIX_NEGATIVE_WRONG_FAILURE'
    assert snapshot(NAME) == expected, 'READ_FIX_NEGATIVE_TRANSACTION_NOT_ROLLED_BACK'


def consumer_apply_read_fix(path):
    assert CONSUMER_READ_FIX and path == MIGRATIONS[0] and len(MIGRATIONS) == 1, 'READ_FIX_EXACT_MIGRATION_ONLY'
    original = path.read_text()
    assert hashlib.sha256(original.encode()).hexdigest() == FROZEN[0], 'READ_FIX_FROZEN_MIGRATION_CHANGED'
    body, begin_count = re.subn(r'(?m)^begin;\n', '', original, count=1)
    body, commit_count = re.subn(r'(?m)^commit;\s*\Z', '', body, count=1)
    assert begin_count == commit_count == 1 and not re.search(r'(?m)^(?:begin|commit);', body), 'READ_FIX_OUTER_TRANSACTION_NOT_REMOVED'
    before = snapshot(NAME)
    functions = consumer_read_functions()
    assert len(functions) == 3, 'READ_FIX_FUNCTION_SET_INCOMPLETE'
    needle = 'and private.conversation_message_readable(m.id)'
    replacement = needle + "and not private.member_content_hidden('chat',m.id)"
    targets = [value for value in functions if value['signature'].split('(')[0].split('.')[-1] in ('conversation_unread_messages', 'mark_conversation_messages_read')]
    assert len(targets) == 2 and all(value['definition'].count(needle) == 1 and 'private.member_content_hidden' not in value['definition'] for value in targets), 'READ_FIX_ORIGINAL_BODY_CHANGED'
    wrong = targets[0]['definition'].replace(needle, needle + needle)
    consumer_read_fix_negative('begin;\n' + wrong + ';\n' + body + '\nrollback;\n', before, 'wrong-body')
    sql(original)  # 전체 원 migration의 실제 적용은 정확히 한 번이다.
    after = snapshot(NAME)
    assert after['rows'] == before['rows'] and after['roles'] == before['roles'], 'READ_FIX_MIGRATION_CHANGED_ROWS_OR_ROLES'
    assert after['catalog'] == consumer_catalog_read_fix(before['catalog']), 'READ_FIX_UNEXPECTED_CATALOG_CHANGE'
    current = consumer_read_functions()
    assert len(current) == len(functions) and [v['signature'] for v in current] == [v['signature'] for v in functions], 'READ_FIX_FUNCTION_IDENTITIES_CHANGED'
    evidence = []
    for old, new in zip(functions, current):
        assert old['metadata'] == new['metadata'], 'READ_FIX_FULL_PG_PROC_METADATA_CHANGED'
        target = old in targets
        assert new['definition'] == (old['definition'].replace(needle, replacement) if target else old['definition']), 'READ_FIX_DEFINITION_OR_LEGACY_CHANGED'
        evidence.append({'signature': old['signature'], 'pgProcExceptProsrc': old['metadata'],
                         'beforeDefinitionSha256': hashlib.sha256(old['definition'].encode()).hexdigest(),
                         'afterDefinitionSha256': hashlib.sha256(new['definition'].encode()).hexdigest(), 'target': target})
    consumer_read_fix_negative('begin;\n' + body + '\nrollback;\n', after, 'duplicate-apply')
    save('consumer-read-fix-migration.json', {'status': 'PASS_WHEN_ACTUALLY_RUN', 'migrationSha256': FROZEN[0],
         'migrationApplyCalls': 1, 'negativeTransactionCases': 2, 'negativeCommitCalls': 0,
         'allRowsAndRolesUnchanged': True, 'onlyTwoExactFunctionBodyChanges': True,
         'functions': evidence, 'legacyWatermarkDefinitionUnchanged': True})


def consumer_notice_fixture(fixture):
    """기존 일반 경고 fixture의 판정 자료만 합성한다. 실제 직원 판정/승인을 뜻하지 않는다."""
    q = lambda value: "'" + value.replace("'", "''") + "'"
    uid = q(fixture['accounts'][1]['userId']) + '::uuid'
    fixture.update(noticeId=str(uuid.uuid4()), noticeIncidentId=str(uuid.uuid4()),
                   noticeDecisionId=str(uuid.uuid4()), noticeSanctionId=str(uuid.uuid4()))
    report = "(select id from private.member_reports where reporter_id=" + q(fixture['accounts'][0]['userId']) + '::uuid and client_request_id=' + q(fixture['reportKey']) + '::uuid)'
    identity = '(select identity_id from private.member_episodes where profile_id=' + uid + ' and ended_at is null)'
    episode = '(select id from private.member_episodes where profile_id=' + uid + ' and ended_at is null)'
    incident, decision, sanction, notice = (q(fixture[key]) + '::uuid' for key in ('noticeIncidentId', 'noticeDecisionId', 'noticeSanctionId', 'noticeId'))
    sql("begin;update private.member_reports set status='reviewing'where id=" + report + ';'
        'insert into private.safety_incidents(id,current_revision)values(' + incident + ',1);'
        'insert into private.safety_incident_report_links(incident_id,report_id)values(' + incident + ',' + report + ');'
        "insert into private.safety_incident_revisions(incident_id,revision,decision_id,state,reason_code,actor_reference,subject_payload_hash)values(" + incident + ',1,' + decision + ",'confirmed','spam'," + q(str(uuid.uuid4())) + "::uuid,repeat('a',64));"
        'insert into private.safety_incident_subjects(incident_id,revision,identity_id,source_episode_id,violation_class,violation_type)values(' + incident + ',1,' + identity + ',' + episode + ",'minor','spam');"
        'insert into private.safety_sanction_applications(id,identity_id,incident_id,decision_revision,source_episode_id,stage,kind)values(' + sanction + ',' + identity + ',' + incident + ',1,' + episode + ",1,'general_warning');"
        'insert into private.assigned_report_decisions(decision_id,report_id,report_version,mode,appointment_outcome,incident_id,incident_revision,incident_outcome,responsible_role,representative_reason_code,violation_class,violation_type)values(' + decision + ',' + report + ",2,'initial','normal'," + incident + ",1,'confirmed','target','spam','minor','spam');"
        'insert into private.member_decision_notices(id,decision_id,recipient_identity_id,recipient_episode_id,violation_outcome,reason_code,violation_class,violation_type)values(' + notice + ',' + decision + ',' + identity + ',' + episode + ",'confirmed','spam','minor','spam');commit;")
    assert sql('select review_version=2 from private.member_reports where id=' + report + ';') == 't', 'SYNTHETIC_NOTICE_REPORT_REVISION_UNBOUND'
    save('consumer-notice-fixture-scope.json', {'scope': 'SYNTHETIC_ADJUDICATED_RECORDS_NO_OPERATOR_APPROVAL',
         'incidentId': fixture['noticeIncidentId'], 'noticeId': fixture['noticeId'], 'physicalScreenRender': 'NOT_RUN', 'policyChanged': False})


def consumer_restore():
    if not CONSUMERS or CONSUMER_NOTICE_ORIGINAL is None or NAME not in CREATED:
        return
    assert auth.inspect(NAME)['Id'] == CREATED[NAME], 'CONSUMER_OWN_CLONE_ONLY'
    sql('update private.general_notice_delivery_control set enabled=' + ('true' if CONSUMER_NOTICE_ORIGINAL else 'false') + ' where singleton;')
    assert sql('select enabled from private.general_notice_delivery_control where singleton;') == ('t' if CONSUMER_NOTICE_ORIGINAL else 'f'), 'CONSUMER_NOTICE_CONTROL_NOT_RESTORED'


def consumer_units(fixture, source_before, manifest):
    """현재 개별 읽음 결함을 실제 HTTP/DB로 보존한다. 화면 검증으로 확대하지 않는다."""
    global AI_ORIGINAL, AI_FIXTURE, CONSUMER_NOTICE_ORIGINAL
    CONSUMER_NOTICE_ORIGINAL = sql('select enabled from private.general_notice_delivery_control where singleton;') == 't'
    assert not CONSUMER_NOTICE_ORIGINAL, 'CONSUMER_NOTICE_DEFAULT_GUARD_OPEN'
    q = lambda value: "'" + value.replace("'", "''") + "'"
    fixture.update(privateRoot=str(ROOT), requestId=str(uuid.uuid4()), otherRequestId=str(uuid.uuid4()),
                   postId=str(uuid.uuid4()), otherPostId=str(uuid.uuid4()),
                   messageIds=[str(uuid.uuid4()) for _ in range(102)], otherMessageId=str(uuid.uuid4()),
                   reportKey=str(uuid.uuid4()), feedbackKey=str(uuid.uuid4()), feedbackReportKey=str(uuid.uuid4()))
    for room, post, requester in ((fixture['requestId'], fixture['postId'], 1), (fixture['otherRequestId'], fixture['otherPostId'], 2)):
        sql("insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)values(" + q(post) + ',' + q(fixture['accounts'][0]['userId']) + ",'합성 소비자 공고','합성 연결 검증','산책',clock_timestamp()+interval'3 days',clock_timestamp()+interval'3 days 2 hours',clock_timestamp()+interval'2 days','서울특별시 강남구 역삼동');"
            "insert into public.join_requests(id,post_id,requester_id,message,status)values(" + q(room) + ',' + q(post) + ',' + q(fixture['accounts'][requester]['userId']) + ",'합성 신청 메시지','pending');")
    sql("insert into public.chat_messages(id,join_request_id,sender_id,content)values" + ','.join('(' + q(mid) + ',' + q(fixture['requestId']) + ',' + q(fixture['accounts'][1]['userId']) + ",'합성 메시지 본문')" for mid in fixture['messageIds']) + ';'
        "insert into public.chat_messages(id,join_request_id,sender_id,content)values(" + q(fixture['otherMessageId']) + ',' + q(fixture['otherRequestId']) + ',' + q(fixture['accounts'][2]['userId']) + ",'합성 다른 방 메시지');")
    # TLS bridge는 Node host loopback 하나이며 새 Docker sidecar를 추가하지 않는다.
    call(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(ROOT / 'consumer-tls.key'),
          '-out', str(ROOT / 'consumer-tls.crt'), '-days', '1', '-subj', '/CN=localhost',
          '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'])
    for name in ('consumer-tls.key', 'consumer-tls.crt'):
        (ROOT / name).chmod(0o600)
    base = snapshot(NAME)
    uid = q(fixture['accounts'][0]['userId'])
    room = q(fixture['requestId'])
    read_state = lambda: sql("select count(*)||':'||md5(coalesce(string_agg(to_jsonb(r)::text,','order by to_jsonb(r)::text),''))from private.conversation_message_reads r where user_id=" + uid + '::uuid and request_id=' + room + '::uuid;')
    watermark = sql("select count(*)||':'||md5(coalesce(string_agg(to_jsonb(r)::text,','order by to_jsonb(r)::text),''))from private.conversation_read_states r where user_id=" + uid + '::uuid and request_id=' + room + '::uuid;')
    evidence, gaps = [], []
    cases = ('read', 'mixed-room', 'other-user', 'invalid-input', 'loss', 'replay', 'hundred', 'projection', 'hidden', 'report', 'report-replay', 'unhide', 'notice-empty', 'notice-list', 'notice-read', 'notice-closed', 'notice-prepare', 'notice-provided', 'notice-replay', 'notice-other-user', 'feedback')
    for label in cases:
        if label == 'notice-list':
            consumer_notice_fixture(fixture)
        if label == 'notice-prepare':
            assert sql('select not enabled from private.general_notice_delivery_control where singleton;') == 't', 'NOTICE_GUARD_ALREADY_OPEN'
            sql('update private.general_notice_delivery_control set enabled=true where singleton;')
        if label == 'hidden':
            # 숨김 validator 회귀 fixture다. 온라인 신고/실제 capture 성공으로 주장하지 않는다.
            sql("insert into private.member_hidden_targets(identity_id,target_type,target_id)select identity_id,'chat'," + q(fixture['messageIds'][100]) + "::uuid from private.member_episodes where profile_id=" + uid + '::uuid and ended_at is null;')
        if label == 'feedback':
            baseline = snapshot(NAME); configuration = ai_config(fixture)
            assert not configuration['guard']['external_processing_allowed'], 'CONSUMER_AI_DEFAULT_GUARD_OPEN'
            assert sql('select not enabled from private.ai_report_handling_control where singleton;') == 't', 'CONSUMER_REPORT_DEFAULT_GUARD_OPEN'
            AI_ORIGINAL = {'config': configuration, 'catalog': baseline['catalog'], 'roles': baseline['roles']}
            AI_FIXTURE = fixture; save('consumer-original-ai-settings-private.json', AI_ORIGINAL)
            fixture.update(aiLedgerId='synthetic-consumer-' + uuid.uuid4().hex, aiQuery='synthetic-consumer-query', aiTitle='합성 소비자 탐색', aiPostId=fixture['postId'])
            ids = ','.join(q(a['userId']) + '::uuid' for a in fixture['accounts'])
            sql("begin;update private.ai_budget_accounts set registered=true;update private.ai_processing_guard set external_processing_allowed=true where singleton;"
                "insert into private.ai_member_processing(user_id,exploration_allowed)select unnest(array[" + ids + "]),true on conflict(user_id)do update set exploration_allowed=true;"
                "insert into private.ai_budget_ledgers(ledger_id,unit_limit,call_limit)values(" + q(fixture['aiLedgerId']) + ',100000000,1000);commit;')
        before = snapshot(NAME); before_reads = read_state()
        errors_before = {path.name for path in ROOT.glob('rest-error-*.json')}
        payload = {**fixture, 'consumerCase': label}
        if label == 'projection':
            claims = q(json.dumps({'sub': fixture['accounts'][0]['userId'], 'role': 'authenticated'}))
            payload['expectedProjection'] = json.loads(sql("begin;set local request.jwt.claims=" + claims + ";select jsonb_build_object('watermark',(private.conversation_read_dto(" + room + "::uuid)->>'unread_count')::integer,'individual',private.conversation_unread_messages(" + room + '::uuid));rollback;'))
            assert payload['expectedProjection']['watermark'] > payload['expectedProjection']['individual'] >= 0, 'CONSUMER_FIXTURE_COUNTER_DIFFERENCE_REQUIRED'
        path = ROOT / ('consumer-' + label + '-private.json'); save(path.name, payload)
        observed = node(path, '--consumer-case'); after = snapshot(NAME)
        assert observed['nativeExternalAttempts'] == 0 and observed['watermarkRequests'] == 0, 'CONSUMER_EXTERNAL_OR_WATERMARK'
        assert after['catalog'] == before['catalog'] and after['roles'] == before['roles'], 'CONSUMER_CATALOG_OR_ROLE_CHANGED'
        if label in ('mixed-room', 'other-user', 'invalid-input', 'replay', 'projection', 'report-replay', 'notice-empty', 'notice-list', 'notice-closed', 'notice-replay', 'notice-other-user'):
            assert after == before, 'CONSUMER_REJECT_OR_REPLAY_ADDED_WRITES:' + label
        if label == 'read':
            assert sql("select count(*)=1 from private.conversation_message_reads where user_id=" + uid + "::uuid and message_id=" + q(fixture['messageIds'][0]) + '::uuid;') == 't', 'CONSUMER_FIRST_READ_NOT_STORED'
        if label == 'loss':
            assert sql("select count(*)=1 from private.conversation_message_reads where user_id=" + uid + "::uuid and message_id=" + q(fixture['messageIds'][1]) + '::uuid;') == 't', 'CONSUMER_RESPONSE_LOSS_NOT_STORED'
        if label == 'hundred':
            assert sql("select count(*)=100 from private.conversation_message_reads where user_id=" + uid + "::uuid and message_id=any(array[" + ','.join(q(mid) + '::uuid' for mid in fixture['messageIds'][:100]) + ']);') == 't', 'CONSUMER_100_SET_NOT_STORED'
        if label == 'hidden':
            if CONSUMER_READ_FIX:
                claims = q(json.dumps({'sub': fixture['accounts'][0]['userId'], 'role': 'authenticated'}))
                individual = sql('begin;set local request.jwt.claims=' + claims + ';select private.conversation_unread_messages(' + room + '::uuid);rollback;')
                assert individual == '1' and observed['status'] == 'PASS' and observed['result']['individualUnread'] == 1, 'HIDDEN_FIXED_UNREAD_COUNT_NOT_ONE'
            observed['hiddenReceiptAdded'] = read_state() != before_reads
            if observed['status'] == 'FAIL_PRODUCT_GAP':
                assert observed['hiddenReceiptAdded'] and sql("select count(*)=1 from private.conversation_message_reads where user_id=" + uid + "::uuid and message_id=" + q(fixture['messageIds'][100]) + '::uuid;') == 't', 'HIDDEN_ACK_ACTUAL_STORED_RECEIPT_REQUIRED'
            else:
                assert after == before and not observed['hiddenReceiptAdded'], 'HIDDEN_REJECT_ADDED_WRITES'
        if label == 'report':
            assert sql("select count(*)=1 from private.member_reports where reporter_id=" + uid + '::uuid and client_request_id=' + q(fixture['reportKey']) + '::uuid and hide_target;') == 't', 'CONSUMER_REPORT_NOT_STORED'
        if label == 'notice-closed':
            errors = [json.loads(path.read_text()) for path in ROOT.glob('rest-error-*.json') if path.name not in errors_before]
            assert len(errors) == 1 and errors[0]['path'].endswith('/prepare_my_general_notice_delivery') and errors[0]['code'] == '55000', 'NOTICE_ACTUAL_GUARD_REJECTION_NOT_PROVEN'
        if label == 'notice-read':
            assert sql("select first_read_at is not null from private.member_decision_notices where id=" + q(fixture['noticeId']) + '::uuid;') == 't', 'NOTICE_FIRST_READ_NOT_STORED'
        if label == 'notice-prepare':
            fixture['noticeDeliveryId'] = observed['result']['deliveryId']
            assert sql("select provided_at is null and deadline_at is null from private.general_notice_deliveries where id=" + q(fixture['noticeDeliveryId']) + '::uuid and notice_id=' + q(fixture['noticeId']) + '::uuid;') == 't', 'NOTICE_PREPARE_ALREADY_PROVIDED'
        if label == 'notice-provided':
            fixture['noticeProvidedAt'] = observed['result']['providedAt']; fixture['noticeDeadlineAt'] = observed['result']['deadlineAt']
            assert sql("select provided_at=" + q(fixture['noticeProvidedAt']) + '::timestamptz and deadline_at=' + q(fixture['noticeDeadlineAt']) + "::timestamptz and deadline_at=provided_at+interval'168 hours'from private.general_notice_deliveries where id=" + q(fixture['noticeDeliveryId']) + '::uuid;') == 't', 'NOTICE_PROVIDED_RECEIPT_NOT_STORED'
        if label.startswith('notice-') and label != 'notice-empty':
            assert sql("select notified_at is null from private.safety_sanction_applications where id=" + q(fixture['noticeSanctionId']) + '::uuid;') == 't', 'NOTICE_ACK_INVENTED_EXTERNAL_NOTIFIED_TIME'
        if label == 'feedback':
            generated = observed['result']['generatedAi']
            observed['actualAiRequestResultFinishProof'] = ai_proof(fixture, generated, 0)
            rid = q(observed['result']['requestId']); fid = q(observed['result']['feedbackId'])
            assert sql("select count(*)=1 from private.ai_feedback_receipts where feedback_id=" + fid + "::uuid and request_id=" + rid + "::uuid and user_id=" + q(fixture['accounts'][1]['userId']) + "::uuid and action='helpful'and report_id is null;") == 't', 'CONSUMER_FEEDBACK_RECEIPT_NOT_STORED'
            assert sql("select count(*)=0 from private.ai_feedback_receipts where request_id=" + rid + "::uuid and action='report';") == 't', 'CONSUMER_CLOSED_REPORT_ADDED_RECEIPT'
            ai_restore(); assert sql('select not enabled from private.ai_report_handling_control where singleton;') == 't'
        assert sql("select count(*)||':'||md5(coalesce(string_agg(to_jsonb(r)::text,','order by to_jsonb(r)::text),''))from private.conversation_read_states r where user_id=" + uid + '::uuid and request_id=' + room + '::uuid;') == watermark, 'CONSUMER_AUTOMATIC_WATERMARK_BACKFILL'
        if observed['status'] == 'FAIL_PRODUCT_GAP':
            gaps.append(observed['defect'])
        else:
            assert observed['status'] == 'PASS', 'CONSUMER_UNCLASSIFIED_FAILURE'
        save('consumer-' + label + '-evidence.json', observed)
        evidence.append({'case': label, 'status': observed['status'], 'defect': observed['defect'], 'httpsBridgeRequests': observed['httpsBridgeRequests'], 'dbReadStateBeforeSha256': hashlib.sha256(before_reads.encode()).hexdigest(), 'dbReadStateAfterSha256': hashlib.sha256(read_state().encode()).hexdigest(), 'rowsCatalogRolesReplayOrFailureUnchanged': label in ('mixed-room', 'other-user', 'invalid-input', 'replay', 'projection', 'report-replay', 'notice-empty', 'notice-list', 'notice-closed', 'notice-replay', 'notice-other-user')})
    assert snapshot(SOURCE) == source_before, 'CONSUMER_SOURCE_CHANGED'
    for relative, expected in manifest.items():
        assert hashlib.sha256((FOUNDATION / relative).read_bytes()).hexdigest() == expected, 'CONSUMER_SOURCE_GRAPH_CHANGED'
    consumer_restore()
    closed(NAME, final=True)
    return {'status': 'FAIL_KNOWN_PRODUCT_GAPS' if gaps else 'PASS', 'scope': 'REAL_MOBILE_CONSUMER_HTTPS_AUTH_RPC_DB_EXCLUDING_UI', 'scenario': 'consumers', 'readFixApplied': CONSUMER_READ_FIX, 'manifest': manifest, 'cases': evidence, 'productGaps': gaps, 'sourceTableCount': 186, 'sourceRowsCatalogRolesAclUnchanged': True, 'committedSyntheticRowsPreservedNotRollbackClaim': True, 'actualUiViewportFocusAndNoticeRenderAck': 'NOT_RUN', 'noticeFixtureScope': 'SYNTHETIC_ADJUDICATED_RECORDS_NO_OPERATOR_APPROVAL', 'noticeListReadPrepareExplicitProvidedReplay': 'ACTUAL_CASES_WHEN_RUN', 'reportPhysicalCaptureAndRealStaffDecision': 'NOT_RUN', 'noticeDeliveryControlRestored': True, 'feedbackReportAdmissionAndPeriodicMaintenance': 'NOT_RUN_DEFAULT_CLOSED', 'providerOrRealMemberOrOperating': 'NOT_RUN', 'externalTransport': 0, 'originalAiSettingsRestored': True, 'rawPromptJwtDsnLogs': False}


def run():
    assert not ROOT.exists(), 'EXISTING_ARTIFACTS_PRESERVED'
    ROOT.mkdir(mode=0o700)
    manifest = {}
    for path, expected in zip(MIGRATIONS, FROZEN):
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        assert actual == expected, 'FINAL_MIGRATION_HASH_CHANGED:' + path.name
        manifest[str(path.relative_to(FOUNDATION)) if AI_EVENTS or CONSUMERS else path.name] = actual
    service_graph = product_sources(('service-api/index.ts', 'ai-chat/index.ts')) if CONSUMERS else product_sources(('ai-chat/index.ts',)) if AI_ONLY else product_sources()
    signup_graph = product_sources(('signup/index.ts',)) if FULL8 else []
    if FULL8:
        assert not {FOUNDATION / 'backend/supabase/functions/signup/index.ts', FOUNDATION / 'backend/supabase/functions/signup/handler.ts'}.intersection(service_graph), 'SIGNUP_ENTRYPOINT_CHANGED_SERVICE_API_GRAPH'
        save('product-graph-partition.json', {'serviceApi': [str(p.relative_to(FOUNDATION.resolve())) for p in service_graph],
            'signup': [str(p.relative_to(FOUNDATION.resolve())) for p in signup_graph],
            'signupOnly': [str(p.relative_to(FOUNDATION.resolve())) for p in sorted(set(signup_graph)-set(service_graph))],
            'scope': 'ACTUAL_LOCAL_RELATIVE_IMPORT_CLOSURES_NOT_A_DEPENDENCY_FREE_CLAIM'})
    for path in sorted(set(service_graph + signup_graph)):
        manifest[str(path.relative_to(FOUNDATION.resolve()))] = hashlib.sha256(path.read_bytes()).hexdigest()
    if CONSUMERS:
        mobile_files = ('api.ts', 'member-service.ts', 'chat-read-state.ts', 'service.ts', 'domain.ts', 'types.ts')
        for filename in mobile_files:
            path = FOUNDATION / 'apps/mobile/src' / filename
            assert path.is_file() and not path.is_symlink(), 'MOBILE_SOURCE_MUST_BE_REGULAR'
            manifest[str(path.relative_to(FOUNDATION))] = hashlib.sha256(path.read_bytes()).hexdigest()
        save('mobile-consumer-graph-private.json', {key: value for key, value in manifest.items() if key.startswith('apps/mobile/src/')})
    save('manifest.json', manifest)
    existing = docker('ps', '-a', '--format', '{{.Names}}').decode().splitlines()
    assert not set((NAME, AUTH, REST)).intersection(existing), 'EXISTING_CONTAINERS_PRESERVED'
    assert NETWORK not in docker('network', 'ls', '--format', '{{.Name}}').decode().splitlines(), 'EXISTING_NETWORK_PRESERVED'
    source_info = auth.inspect(SOURCE)
    assert source_info['State']['Running'] and source_info['Config']['Labels'].get('yumidang.owner') == 'minkyu'
    closed(SOURCE)
    before = snapshot(SOURCE)
    assert len(before['rows']) == 186, 'SOURCE112_TABLE_BASELINE_CHANGED'
    save('source-before-private.json', before)
    dump = docker('exec', SOURCE, 'pg_dump', '-U', auth.BOOT, '-d', 'postgres', '-Fc')
    roles = docker('exec', SOURCE, 'pg_dumpall', '-U', auth.BOOT, '--roles-only', '--no-role-passwords').decode()
    assert not re.search(r"\bPASSWORD\s+'", roles, re.I), 'PASSWORD_DUMP_FORBIDDEN'
    save('source.dump', dump)
    save('source-roles.sql', roles)
    for image in (auth.AUTH_IMAGE, auth.REST_IMAGE):
        docker('image', 'inspect', image)
    networks = docker('network', 'ls', '--format', '{{.ID}}').decode().splitlines()
    occupied = [ipaddress.ip_network(item['Subnet']) for network in json.loads(docker('network', 'inspect', *networks))
                for item in (network.get('IPAM', {}).get('Config') or []) if item.get('Subnet')]
    candidates = [ipaddress.ip_network('10.254.' + str(n) + '.0/24') for n in range(116, 256)]
    subnet = next((candidate for candidate in candidates if not any(candidate.version == existing.version and candidate.overlaps(existing) for existing in occupied)), None)
    assert subnet is not None, 'NO_ISOLATED_NONOVERLAPPING_SUBNET'
    save('network-allocation.json', {'subnet': str(subnet), 'existingNetworkChanged': False})
    docker('network', 'create', '--internal', '--subnet', str(subnet), '--label', 'yumidang.owner=minkyu', NETWORK)
    assert json.loads(docker('network', 'inspect', NETWORK))[0]['Internal']
    docker('run', '-d', '--name', NAME, '--network', NETWORK, '--pull', 'never', '--memory', '512m',
           '--no-healthcheck',
           '--label', 'yumidang.owner=minkyu', '--user', 'postgres', '--entrypoint', 'sh', source_info['Image'], '-c',
           'if [ ! -f /tmp/content-data/PG_VERSION ]; then initdb -U ' + auth.BOOT + " -D /tmp/content-data --auth-local=trust --auth-host=reject || exit 1; fi; exec postgres -D /tmp/content-data -c listen_addresses='*' -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off -c shared_buffers=16MB -c max_connections=40")
    record(NAME)
    ready_deadline = time.monotonic() + 90
    db_ready = False
    while time.monotonic() < ready_deadline:
        try:
            probe = subprocess.run(auth.DOCKER + ['exec', NAME, 'pg_isready', '-U', auth.BOOT],
                                   capture_output=True, timeout=min(5, max(.1, ready_deadline-time.monotonic())))
            if probe.returncode == 0:
                db_ready = True
                break
        except subprocess.TimeoutExpired:
            # 시작 확인만 재조회한다. SQL·제품 요청을 재전송하지 않는다.
            pass
        time.sleep(.2)
    if not db_ready:
        raise RuntimeError('CLONE_NOT_READY')
    roles = re.sub(r' GRANTED BY [A-Za-z_][A-Za-z0-9_]*;', ';', roles)
    roles = '\n'.join(line for line in roles.splitlines() if not re.match(r'(CREATE|ALTER) ROLE ' + auth.BOOT + r'(?: |;)', line))
    sql(roles)
    docker('exec', '-i', NAME, 'pg_restore', '-U', auth.BOOT, '-d', 'postgres', '--single-transaction', '--exit-on-error', data=dump)
    assert snapshot(NAME) == before and snapshot(SOURCE) == before, 'RESTORED_ROWS_CATALOG_ROLES_ACL_MISMATCH'
    for path in MIGRATIONS:
        if CONSUMER_READ_FIX:
            consumer_apply_read_fix(path)
        else:
            sql(path.read_text())
        closed(NAME)
    save('migrations-applied.json', {path.name: manifest[str(path.relative_to(FOUNDATION)) if AI_EVENTS or CONSUMERS else path.name] for path in MIGRATIONS})
    # DB의 외부 노출 없이 새 내부 hostname SAN/자격 증명만 만든다.
    call(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(ROOT / 'ca.key'), '-out', str(ROOT / 'ca.crt'), '-days', '1', '-subj', '/CN=content-local-ca', '-addext', 'basicConstraints=critical,CA:TRUE'])
    call(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(ROOT / 'server.key'), '-out', str(ROOT / 'server.csr'), '-subj', '/CN=' + NAME])
    save('server.ext', 'subjectAltName=DNS:' + NAME + '\nextendedKeyUsage=serverAuth\n')
    call(['openssl', 'x509', '-req', '-in', str(ROOT / 'server.csr'), '-CA', str(ROOT / 'ca.crt'), '-CAkey', str(ROOT / 'ca.key'), '-set_serial', str(secrets.randbits(128)), '-out', str(ROOT / 'server.crt'), '-days', '1', '-extfile', str(ROOT / 'server.ext')])
    for item in ROOT.iterdir():
        item.chmod(0o600)
    for filename in ('server.crt', 'server.key'):
        docker('cp', str(ROOT / filename), NAME + ':/tmp/' + filename)
    docker('exec', '--user', 'root', NAME, 'sh', '-c', 'chown postgres:postgres /tmp/server.key /tmp/server.crt && chmod 600 /tmp/server.key')
    auth_password, rest_password, secret = (secrets.token_urlsafe(36) for _ in range(3))
    sql("alter role supabase_auth_admin login password '" + auth_password + "';create role content_rest_login login noinherit password '" + rest_password + "';grant anon,authenticated,service_role to content_rest_login with admin false,inherit false,set true;")
    hba = 'local all all trust\nhostssl postgres supabase_auth_admin,content_rest_login 0.0.0.0/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n'
    docker('exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/content-data/pg_hba.conf', data=hba.encode())
    sql("alter system set ssl='on';alter system set ssl_cert_file='/tmp/server.crt';alter system set ssl_key_file='/tmp/server.key';select pg_reload_conf();")
    gateway = ThreadingHTTPServer(('127.0.0.1', 0), auth.Gateway)
    origin = 'http://127.0.0.1:' + str(gateway.server_port)
    auth_env = {'GOTRUE_API_HOST': '0.0.0.0', 'GOTRUE_API_PORT': '9999', 'API_EXTERNAL_URL': origin + '/auth/v1',
                'GOTRUE_DB_DRIVER': 'postgres', 'GOTRUE_DB_DATABASE_URL': 'postgresql://supabase_auth_admin:' + auth_password + '@' + NAME + ':5432/postgres?sslmode=verify-full&sslrootcert=/certs/ca.crt',
                'GOTRUE_SITE_URL': origin, 'GOTRUE_JWT_SECRET': secret, 'GOTRUE_JWT_AUD': 'authenticated',
                'GOTRUE_JWT_ISSUER': origin + '/auth/v1', 'GOTRUE_JWT_DEFAULT_GROUP_NAME': 'authenticated',
                'GOTRUE_JWT_ADMIN_ROLES': 'service_role', 'GOTRUE_JWT_EXP': '3600', 'GOTRUE_DISABLE_SIGNUP': 'true',
                'GOTRUE_EXTERNAL_EMAIL_ENABLED': 'true', 'GOTRUE_MAILER_AUTOCONFIRM': 'true',
                'GOTRUE_EXTERNAL_PHONE_ENABLED': 'false', 'GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED': 'false', 'GOTRUE_LOG_LEVEL': 'error'}
    rest_env = {'PGRST_DB_URI': 'postgresql://content_rest_login:' + rest_password + '@' + NAME + ':5432/postgres?sslmode=verify-full&sslrootcert=/certs/ca.crt',
                'PGRST_DB_SCHEMAS': 'public', 'PGRST_DB_ANON_ROLE': 'anon', 'PGRST_JWT_SECRET': secret,
                'PGRST_SERVER_PORT': '3000', 'PGRST_JWT_AUD': 'authenticated'}
    for name, image, env in ((AUTH, auth.AUTH_IMAGE, auth_env), (REST, auth.REST_IMAGE, rest_env)):
        filename = name + '-private.env'
        save(filename, '\n'.join(key + '=' + value for key, value in env.items()) + '\n')
        docker('run', '-d', '--name', name, '--network', NETWORK, '--pull', 'never', '--memory', '128m', '--user', '0:0',
               '--no-healthcheck',
               '--label', 'yumidang.owner=minkyu', '--env-file', str(ROOT / filename),
               '--mount', 'type=bind,src=' + str(ROOT / 'ca.crt') + ',dst=/certs/ca.crt,readonly', image)
        record(name)
    threading.Thread(target=gateway.serve_forever, daemon=True).start()
    try:
        # 새 컨테이너는 inherited healthcheck 대신 목적이 제한된 준비 조회만 사용한다.
        for component, target in (('AUTH', 'http://' + AUTH + ':9999/health'), ('REST', 'http://' + REST + ':3000/')):
            ready_deadline = time.monotonic() + 90
            service_ready = False
            while time.monotonic() < ready_deadline:
                try:
                    probe = subprocess.run(auth.DOCKER + ['exec', NAME, 'curl', '--max-time', '2', '-s', '-o', '/dev/null', '-w', '%{http_code}', target],
                                           capture_output=True, timeout=min(5, max(.1, ready_deadline-time.monotonic())))
                    if probe.returncode == 0 and probe.stdout == b'200':
                        service_ready = True
                        break
                except subprocess.TimeoutExpired:
                    pass
                time.sleep(1)
            if not service_ready:
                raise RuntimeError('LOCAL_' + component + '_NOT_READY')
        anon, service = auth.jwt(secret, 'anon'), auth.jwt(secret, 'service_role')
        q = lambda v: "'" + v.replace("'", "''") + "'"
        accounts = []
        for n in range(4 if FULL8 else 3):
            subject = 'content-http-' + uuid.uuid4().hex
            account = json.loads(sql("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false);select public.resolve_naver_account(" + q(subject) + ",'합성콘텐츠회원','F','1990-01-01');").splitlines()[-1])
            password = secrets.token_urlsafe(36)
            status, raw = upstream('/auth/v1/admin/users', 'POST', {'authorization': 'Bearer ' + service, 'apikey': service, 'content-type': 'application/json'}, json.dumps({'email': account['authEmail'], 'password': password, 'email_confirm': True}).encode())
            assert status == 200, 'SYNTHETIC_ADMIN_CREATE_FAILED'
            uid = json.loads(raw)['id']
            status, raw = upstream('/auth/v1/token?grant_type=password', 'POST', {'apikey': anon, 'content-type': 'application/json'}, json.dumps({'email': account['authEmail'], 'password': password}).encode())
            assert status == 200, 'SYNTHETIC_PASSWORD_LOGIN_FAILED'
            session = json.loads(raw)
            sid = json.loads(base64.urlsafe_b64decode(session['access_token'].split('.')[1] + '=='))['session_id']
            avatar = uid + '/' + str(uuid.uuid4()) + '.jpg'
            sql("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false);select public.record_naver_session(" + q(subject) + ',' + q(uid) + '::uuid,' + q(sid) + "::uuid);insert into storage.objects(bucket_id,name,owner_id,metadata)values('profile-images'," + q(avatar) + ',' + q(uid) + ",' {\"mimetype\":\"image/jpeg\",\"size\":128}'::jsonb);")
            if not FULL8 or n != 3:
                sql("select set_config('request.jwt.claims'," + q(json.dumps({'role': 'authenticated', 'sub': uid, 'session_id': sid})) + ",false);select set_config('request.jwt.claim.sub'," + q(uid) + ",false);select public.complete_naver_signup(" + q(avatar) + ",'{}','{}',null);")
            accounts.append({'userId': uid, 'token': session['access_token'], 'sessionId': sid, 'avatarPath': avatar})
        if CONSUMERS:
            return consumer_units({'codeRoot': str(FOUNDATION), 'origin': origin, 'anon': anon, 'service': service, 'accounts': accounts, 'scenario': 'consumers', 'readFixApplied': CONSUMER_READ_FIX, 'productManifest': {key: value for key, value in manifest.items() if key.startswith(('backend/supabase/functions/', 'apps/mobile/src/'))}}, before, manifest)
        if AI_ONLY:
            fixture = {'codeRoot': str(FOUNDATION), 'origin': origin, 'anon': anon, 'service': service,
                       'accounts': accounts, 'scenario': 'ai-chat', **({'aiEventPriceScenario': True} if AI_EVENTS else {}),
                       'productManifest': {path: value for path, value in manifest.items() if path.startswith('backend/supabase/functions/')}}
            return ai_units(fixture, before, manifest)
        post, request_id = str(uuid.uuid4()), str(uuid.uuid4())
        sql("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false);insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)values(" + q(post) + '::uuid,' + q(accounts[0]['userId']) + "::uuid,'합성 채팅 공고','실제 로컬 HTTP 검증','산책',clock_timestamp()+interval'3 days',clock_timestamp()+interval'3 days 2 hours',clock_timestamp()+interval'2 days','서울특별시 강남구 역삼동');insert into public.join_requests(id,post_id,requester_id,message,status)values(" + q(request_id) + '::uuid,' + q(post) + '::uuid,' + q(accounts[1]['userId']) + "::uuid,'합성 신청 메시지','pending');")
        fixture = {'codeRoot': str(FOUNDATION), 'origin': origin, 'anon': anon, 'service': service,
                   'accounts': accounts, 'requestId': request_id, 'profileOperation': str(uuid.uuid4()),
                   'productManifest': {path: value for path, value in manifest.items() if path.startswith('backend/')}}
        save('node-store-private.json', fixture)
        # 승인값은 합성 fixture이며 제품 정책·분류기 승인으로 표현하지 않는다.
        sql("begin;update private.content_inspection_control set enabled=true,policy_version='synthetic-policy',scanner_version='synthetic-local'where singleton;grant execute on function public.issue_content_inspection_ticket(uuid,uuid,text,uuid,jsonb,text,text,text)to service_role;commit;")
        stored = node(ROOT / 'node-store-private.json', '--store')
        save('http-store-observations.json', stored)
        fixture.update(stored=stored)
        save('node-recover-private.json', fixture)
        recovery_before = snapshot(NAME)
        recovered = node(ROOT / 'node-recover-private.json', '--recover')
        save('http-recovery-observations.json', recovered)
        assert snapshot(NAME) == recovery_before, 'SAME_KEY_RECOVERY_CHANGED_ROWS_CATALOG_ROLES_ACL'
        full_evidence = full8_cases(fixture) if FULL8 else []
        # 유효하던 실제 Auth 세션을 원 탈퇴 pipeline으로 회수한다. 물리 DELETE/ACK 실행0.
        ports = ['claim_member_cleanup_task(uuid)', 'check_member_cleanup_task(uuid,uuid,uuid,uuid)', 'get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)', 'record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)', 'complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)']
        sql('begin;update private.member_cleanup_guard set external_deletion_approved=true;grant execute on function ' + ','.join('public.' + f for f in ports) + " to service_role;set local storage.allow_delete_query='true';select set_config('request.jwt.claims'," + q(json.dumps({'role': 'authenticated', 'sub': accounts[2]['userId'], 'session_id': accounts[2]['sessionId']})) + ",true);select set_config('request.jwt.claim.sub'," + q(accounts[2]['userId']) + ",true);select public.retire_my_account('" + str(uuid.uuid4()) + "');update private.member_cleanup_guard set external_deletion_approved=false;revoke all on function " + ','.join('public.' + f for f in ports) + ' from service_role;commit;')
        cases = node(ROOT / 'node-recover-private.json', '--cases')
        save('http-case-observations.json', cases)
        assert sql('select count(*)from private.member_cleanup_delete_acks;') == str(sum(int(v.split(':')[0]) for k, v in before['rows'].items() if k == 'private.member_cleanup_delete_acks')), 'NEW_ACK_RECORDS'
        assert sql("select not exists(select 1 from private.content_inspection_tickets where outcome is not null and action in('profile_traits','profile_preferences','signup_traits'));") == 't', 'RAW_PROFILE_RECEIPT'
        sql("begin;update private.content_inspection_control set enabled=false,policy_version=null,scanner_version=null where singleton;revoke all on function public.issue_content_inspection_ticket(uuid,uuid,text,uuid,jsonb,text,text,text)from public,anon,authenticated,service_role;commit;")
        closed(NAME, final=True)
        assert snapshot(SOURCE) == before, 'READONLY_SOURCE_CHANGED'
        for path in manifest:
            target = FOUNDATION / ('backend/supabase/migrations/' + path if path.endswith('.sql') else path)
            assert hashlib.sha256(target.read_bytes()).hexdigest() == manifest[path], 'CODE_CHANGED_DURING_EXECUTION'
        receipt = {'status': 'PASS', 'scope': 'ISOLATED_COMBINED_SQL114_115_116_117_REAL_AUTH_REST_PRODUCT_HTTP',
                   'manifest': manifest, 'sourceTableCount': len(before['rows']), 'sourceRowsCatalogRolesAclUnchanged': True,
                   'scenario': 'full8' if FULL8 else 'v8-two-write-baseline', 'full8': full_evidence,
                   'writeRpcCoverage': 8 if FULL8 else 2, 'store': stored, 'recovery': recovered, 'cases': cases, 'sameKeyRecoveryAllRowsCatalogRolesAclUnchanged': True,
                   'classifier': 'EXPLICIT_SYNTHETIC_LOCAL', 'classificationQualityAndPolicyApproval': 'NOT_RUN',
                   'defaultControlsAndPrivilegedExecClosed': True, 'dbTlsVerifyFull': True, 'loopbackGatewayRawHttpIsolatedScope': True,
                   'internalNetworkNoPublishedDockerPorts': True, 'externalDeleteAndAckCalls': 0, 'externalModelCalls': 0,
                   'realMember': 'NOT_RUN', 'naverProviderLogin': 'NOT_RUN', 'physicalPhotoUpload': 'NOT_RUN', 'operatingChanged': False, 'containersStoppedAndPreserved': True}
        save('http-provisional.json', receipt)
        return receipt
    finally:
        gateway.shutdown()



def ai_limits_budget():
    return json.loads(sql("select jsonb_build_object('global',coalesce((select jsonb_object_agg(kst_day::text,jsonb_build_array(reserved_units,charged_units))from private.ai_global_daily_budget),'{}'::jsonb),'accounts',coalesce((select jsonb_object_agg(account_id||':'||kst_day::text,jsonb_build_array(reserved_units,charged_units))from private.ai_account_daily_budget),'{}'::jsonb));"))


def ai_limits_node(fixture, label):
    path = ROOT / ('ai-limits-' + label + '-fixture-private.json')
    save(path.name, fixture)
    for relative, expected in fixture['productManifest'].items():
        assert hashlib.sha256((FOUNDATION / relative).read_bytes()).hexdigest() == expected, 'AI_LIMITS_PRODUCT_GRAPH_CHANGED'
    result = consumer_node_call(['node', '--experimental-strip-types', str(Path(__file__).with_suffix('.ts')), str(path), '--ai-limits'], timeout=120)
    if result.returncode:
        save('ai-limits-' + label + '-failed.json', {'code': 'AI_LIMITS_NODE_FAILED', 'exitCode': result.returncode,
             'codes': sorted(set(v.decode() for v in re.findall(rb'(?m)^(AI_CHECK_[A-Z_]+)$', result.stderr))),
             'stdoutSha256': hashlib.sha256(result.stdout).hexdigest(), 'stderrSha256': hashlib.sha256(result.stderr).hexdigest()})
        raise RuntimeError('AI_LIMITS_NODE_FAILED')
    observed = json.loads(result.stdout)
    save('ai-limits-' + label + '-observations.json', observed)
    return observed


def ai_limits_units(fixture, source_before, manifest):
    global AI_ORIGINAL, AI_FIXTURE
    q = lambda value: "'" + value.replace("'", "''") + "'"
    for signature in AI_SIGNATURES:
        assert sql("select to_regprocedure('" + signature + "')is not null and has_function_privilege('service_role','" + signature + "','EXECUTE');") == 't', 'AI_SOURCE_RPC_OR_ACL_MISSING'
    baseline = snapshot(NAME)
    configuration = ai_config(fixture)
    assert not configuration['guard']['external_processing_allowed'], 'AI_LIMITS_DEFAULT_GUARD_OPEN'
    AI_ORIGINAL = {'config': configuration, 'catalog': baseline['catalog'], 'roles': baseline['roles']}
    AI_FIXTURE = fixture
    save('ai-original-settings-private.json', AI_ORIGINAL)
    fixture.update(aiLimitsScenario=True, aiLedgerId='synthetic-limits-' + uuid.uuid4().hex,
                   aiQuery='synthetic-absent-' + uuid.uuid4().hex.translate(str.maketrans('0123456789', 'ghijklmnop')))
    ids = ','.join(q(a['userId']) + '::uuid' for a in fixture['accounts'])
    assert sql('select not exists(select 1 from private.ai_chat_requests where user_id in(' + ids + '))and not exists(select 1 from private.ai_member_daily_usage where user_id in(' + ids + '));') == 't', 'AI_LIMITS_FRESH_MEMBERS_REQUIRED'
    sql("begin;update private.ai_budget_accounts set registered=true;update private.ai_processing_guard set external_processing_allowed=true where singleton;"
        "insert into private.ai_member_processing(user_id,exploration_allowed)select unnest(array[" + ids + "]),true on conflict(user_id)do update set exploration_allowed=true;"
        "insert into private.ai_budget_ledgers(ledger_id,unit_limit,call_limit)values(" + q(fixture['aiLedgerId']) + ',100000000,1000);commit;')
    budget_before = ai_limits_budget()
    protected_rows = lambda: sql("select md5(coalesce(string_agg(to_jsonb(r)::text,','order by reservation_id),''))from private.ai_account_budget_reservations r where ledger_id<>" + q(fixture['aiLedgerId']) + ';')
    protected_before = protected_rows()
    observed = ai_limits_node(fixture, 'initial')
    assert observed['status'] == 'PASS' and observed['nativeExternalAttempts'] == 0, 'AI_LIMITS_FACTORY_UNPROVEN'
    unknown = next(o for o in observed['observations'] if o['case'] == 'unknown-provider-loss')['reservations'][0]
    unknown_id = str(uuid.UUID(unknown['reservationId']))
    original_unknown = sql("select to_jsonb(a)::text from private.ai_account_budget_reservations a where reservation_id=" + q(unknown_id) + '::uuid;')
    assert original_unknown and sql('select unknown_at is not null and settled_at is null from private.ai_account_budget_reservations where reservation_id=' + q(unknown_id) + '::uuid;') == 't', 'AI_LIMITS_UNKNOWN_NOT_PRESERVED'
    recovery = ai_limits_node({**fixture, 'aiLimitsRecovery': True}, 'after-unknown')
    assert recovery['status'] == 'PASS' and recovery['nativeExternalAttempts'] == 0, 'AI_LIMITS_RECOVERY_FACTORY_UNPROVEN'
    assert sql("select to_jsonb(a)::text from private.ai_account_budget_reservations a where reservation_id=" + q(unknown_id) + '::uuid;') == original_unknown, 'AI_LIMITS_UNKNOWN_CHANGED_AFTER_NEW_REQUEST'
    observations = observed['observations'] + recovery['observations']
    assert len(observations) == 28 and len({o['requests'][0]['requestId'] for o in observations}) == 28, 'AI_LIMITS_REQUEST_IDENTITIES'
    expected_daily = (3, 20, 3)
    requests, reservations, denied = [], [], []
    delta = {'global': {}, 'accounts': {}}
    for o in observations:
        account = o['account']; uid = str(uuid.UUID(fixture['accounts'][account]['userId']))
        request = o['requests'][0]; rid = str(uuid.UUID(request['requestId']))
        if request['acquireStatus'] != 'acquired':
            assert request['acquireStatus'] in ('daily_limit', 'concurrent'), 'AI_LIMITS_UNEXPECTED_DENIAL'
            assert sql('select not exists(select 1 from private.ai_chat_requests where request_id=' + q(rid) + '::uuid);') == 't', 'AI_LIMITS_DENIED_ROW_CREATED'
            denied.append({'case': o['case'], 'requestCreated': False, 'providerCalls': 0, 'reason': request['acquireStatus']})
            continue
        row = json.loads(sql("select jsonb_build_object('ownerBound',user_id=" + q(uid) + "::uuid,'leaseSha256',encode(sha256(convert_to(lease_token::text,'UTF8')),'hex'),'finished',outcome='finished'and finished_at is not null,'started',started_at is not null,'day',counted_day,'kstDayBound',counted_day=(started_at at time zone'Asia/Seoul')::date,'resultCount',(select count(*)from private.ai_result_receipts where request_id=r.request_id and user_id=r.user_id))from private.ai_chat_requests r where request_id=" + q(rid) + '::uuid;'))
        loss = o['case'] == 'unknown-provider-loss'
        assert row['ownerBound'] and row['finished'] and row['started'] and row['kstDayBound'] and row['leaseSha256'] == request['leaseSha256'] and row['resultCount'] == int(not loss), 'AI_LIMITS_ACTUAL_REQUEST_PROOF'
        requests.append({'case': o['case'], 'requestId': rid, **row})
        r = o['reservations'][0]; reservation_id = str(uuid.UUID(r['reservationId']))
        assert r['dispatched'] and r['settled'] and r['requestId'] == rid and o['providerInterceptions'] == 1, 'AI_LIMITS_MODEL_RESERVATION_BOUND'
        receipt = json.loads(sql("select jsonb_build_object('ledgerId',ledger_id,'accountId',account_id,'accountDay',account_day,'units',reserved_units,'settled',settled_at is not null,'unknown',unknown_at is not null,'input',input_tokens,'output',output_tokens,'legacyPending',exists(select 1 from private.ai_budget_reservations where id=a.reservation_id))from private.ai_account_budget_reservations a where reservation_id=" + q(reservation_id) + '::uuid;'))
        assert (receipt['ledgerId'], receipt['accountId'], receipt['accountDay'], receipt['units']) == (fixture['aiLedgerId'], r['accountId'], r['accountDay'], r['units']), 'AI_LIMITS_RESERVATION_EXACT_BINDING'
        assert receipt['accountDay'] == row['day'], 'AI_LIMITS_CROSSED_MIDNIGHT_NOT_SUPPORTED'
        assert receipt['unknown'] == loss and receipt['settled'] == (not loss) and receipt['legacyPending'] == loss, 'AI_LIMITS_SETTLEMENT_OR_UNKNOWN_PROOF'
        assert (receipt['input'], receipt['output']) == ((None, None) if loss else (1, 1)), 'AI_LIMITS_USAGE_PROOF'
        for lane, key in (('global', receipt['accountDay']), ('accounts', receipt['accountId'] + ':' + receipt['accountDay'])):
            values = delta[lane].setdefault(key, [0, 0]); values[0] += receipt['units'] if loss else 0; values[1] += 0 if loss else 2
        reservations.append({'reservationId': reservation_id, 'requestId': rid, **receipt})
    assert len(requests) == 26 and len(denied) == 2 and len({r['reservationId'] for r in reservations}) == 26, 'AI_LIMITS_EXACT_ACCEPTED_COUNTS'
    assert len({r['accountDay'] for r in reservations}) == 1, 'AI_LIMITS_REQUIRE_SINGLE_NATURAL_KST_DAY'
    for index, account in enumerate(fixture['accounts']):
        uid = q(account['userId'])
        assert ai_usage(account['userId']) == expected_daily[index], 'AI_LIMITS_REAL_DAILY_COUNT'
        assert sql('select active_request_id is null from private.ai_member_processing where user_id=' + uid + '::uuid;') == 't', 'AI_LIMITS_OCCUPANCY_NOT_RELEASED'
        assert int(sql('select count(*)from private.ai_chat_requests where user_id=' + uid + '::uuid;')) == expected_daily[index], 'AI_LIMITS_DENIAL_ADDED_MEMBER_REQUEST'
    budget_after = ai_limits_budget()
    for lane in delta:
        for key in set(budget_before[lane]) | set(budget_after[lane]) | set(delta[lane]):
            before = budget_before[lane].get(key, [0, 0]); after = budget_after[lane].get(key, [0, 0]); change = delta[lane].get(key, [0, 0])
            assert after == [before[i] + change[i] for i in range(2)], 'AI_LIMITS_REAL_GLOBAL_ACCOUNT_BALANCE'
    assert protected_rows() == protected_before, 'AI_LIMITS_EXISTING_PROTECTED_RECEIPTS_CHANGED'
    assert sql('select reserved_units=' + str(unknown['units']) + 'and charged_units=50 and open_calls=1 and settled_calls=25 and unknown_usage_calls=0 from private.ai_budget_ledgers where ledger_id=' + q(fixture['aiLedgerId']) + ';') == 't', 'AI_LIMITS_REAL_LEGACY_LEDGER_BALANCE'
    assert sql('select count(*)=26 and count(*)filter(where unknown_at is not null)=1 and count(*)filter(where settled_at is not null)=25 from private.ai_account_budget_reservations where ledger_id=' + q(fixture['aiLedgerId']) + ';') == 't', 'AI_LIMITS_RECEIPTS_EXTRA_OR_MISSING'
    for table in ('ai_chat_requests', 'ai_member_processing', 'ai_member_daily_usage', 'ai_budget_ledgers', 'ai_budget_reservations', 'ai_account_budget_reservations', 'ai_result_receipts'):
        assert sql("select not exists(select 1 from private." + table + " t where strpos(to_jsonb(t)::text,'AI_DIALOGUE_CANARY')>0);") == 't', 'AI_RAW_DIALOGUE_PERSISTED'
    ai_restore(); closed(NAME, final=True)
    assert snapshot(SOURCE) == source_before, 'READONLY_SOURCE_CHANGED'
    for relative, expected in manifest.items():
        assert hashlib.sha256((FOUNDATION / relative).read_bytes()).hexdigest() == expected, 'AI_LIMITS_PRODUCT_GRAPH_CHANGED'
    receipt = {'status': 'PASS', 'scope': 'ISOLATED_REAL_AUTH_RPC_AI_LIMITS_SYNTHETIC_USAGE', 'scenario': 'ai-limits',
               'manifest': manifest, 'units': observed['units'], 'requestProof': requests, 'reservationProof': reservations,
               'deniedProof': denied, 'memberStartedRequests': expected_daily, 'accountAndGlobalBalanceDelta': delta,
               'unknownSha256BeforeAndAfter': hashlib.sha256(original_unknown.encode()).hexdigest(),
               'existingProtectedReceiptDigestUnchanged': True, 'legacyLedgerReportedCharge': 50, 'legacyLedgerOpenUnknownCalls': 1,
               'sourceTableCount': 186, 'sourceRowsCatalogRolesAclUnchanged': True, 'originalSettingsAndAclRestored': True,
               'processingGuardClosed': True, 'protectedSyntheticBudgetMetadataAndUnknownPreserved': True,
               'cloneRowsRolledBack': False, 'providerNativeExternalTransport': 0, 'rawPromptsModelResponsesDsnsLogged': False,
               'syntheticUsageOnly': True, 'accountAndGlobalCapExhaustion': 'NOT_IMPLEMENTED', 'actualWallClockMidnight': 'NOT_RUN',
               'realProviderQualityAccountCostResetSharedUseLegalMemberLogin': 'NOT_RUN', 'externalDeleteAndAckCalls': 0,
               'operatingChanged': False, 'containersStoppedAndPreserved': True}
    save('ai-limits-provisional.json', receipt)
    return receipt


def ai_caps_units(fixture, source_before, manifest):
    """일일 행을 직접 채우지 않고 실제 factory 정산으로 상한에 도달한다."""
    global AI_ORIGINAL, AI_FIXTURE
    q = lambda value: "'" + value.replace("'", "''") + "'"
    for signature in AI_SIGNATURES:
        assert sql("select to_regprocedure('" + signature + "')is not null and has_function_privilege('service_role','" + signature + "','EXECUTE');") == 't', 'AI_CAPS_SOURCE_RPC_OR_ACL_MISSING'
    baseline, configuration = snapshot(NAME), ai_config(fixture)
    assert not configuration['guard']['external_processing_allowed'], 'AI_CAPS_DEFAULT_GUARD_OPEN'
    assert len(configuration['accounts']) == 4 and all(a['unit_limit'] == 3200000 for a in configuration['accounts']), 'AI_CAPS_FIXED_ACCOUNT_LIMIT_CHANGED'
    AI_ORIGINAL = {'config': configuration, 'catalog': baseline['catalog'], 'roles': baseline['roles']}
    AI_FIXTURE = fixture
    save('ai-original-settings-private.json', AI_ORIGINAL)
    fixture.update(aiCapsScenario=True, aiLedgerId='synthetic-caps-' + uuid.uuid4().hex,
                   aiQuery='synthetic-absent-' + uuid.uuid4().hex.translate(str.maketrans('0123456789', 'ghijklmnop')))
    ids = ','.join(q(a['userId']) + '::uuid' for a in fixture['accounts'])
    assert sql('select not exists(select 1 from private.ai_chat_requests where user_id in(' + ids + '))and not exists(select 1 from private.ai_member_daily_usage where user_id in(' + ids + '));') == 't', 'AI_CAPS_FRESH_MEMBERS_REQUIRED'
    budget_before = ai_limits_budget()
    day = sql("select (clock_timestamp()at time zone'Asia/Seoul')::date;")
    account_ids = ('yumi', 'jonghyun', 'minkyu', 'sungho')
    balances = {a: budget_before['accounts'].get(a + ':' + day, [0, 0]) for a in account_ids}
    assert budget_before['global'].get(day, [0, 0]) == [sum(b[i] for b in balances.values()) for i in range(2)], 'AI_CAPS_BASELINE_GLOBAL_ACCOUNT_SUM'
    fixture.update(aiCapDay=day, aiCapHeadroom={a: 3200000 - sum(balances[a]) for a in account_ids})
    assert all(0 < v <= 3200000 for v in fixture['aiCapHeadroom'].values()), 'AI_CAPS_EXISTING_BUDGET_LEAVES_NO_NATURAL_HEADROOM'
    protected_rows = lambda: sql("select md5(coalesce(string_agg(to_jsonb(r)::text,','order by reservation_id),''))from private.ai_account_budget_reservations r where ledger_id<>" + q(fixture['aiLedgerId']) + ';')
    protected_before = protected_rows()
    sql("begin;update private.ai_budget_accounts set registered=true;update private.ai_processing_guard set external_processing_allowed=true where singleton;"
        "insert into private.ai_member_processing(user_id,exploration_allowed)select unnest(array[" + ids + "]),true on conflict(user_id)do update set exploration_allowed=true;"
        "insert into private.ai_budget_ledgers(ledger_id,unit_limit,call_limit)values(" + q(fixture['aiLedgerId']) + ',100000000,1000);commit;')
    def observe(phase):
        fixture['aiCapPhase'] = phase
        path = ROOT / ('ai-caps-' + phase + '-fixture-private.json')
        save(path.name, fixture)
        for relative, expected in fixture['productManifest'].items():
            assert hashlib.sha256((FOUNDATION / relative).read_bytes()).hexdigest() == expected, 'AI_CAPS_PRODUCT_GRAPH_CHANGED'
        result = consumer_node_call(['node', '--experimental-strip-types', str(Path(__file__).with_suffix('.ts')), str(path), '--ai-caps'], timeout=60)
        if result.returncode:
            save('ai-caps-' + phase + '-node-failed.json', {'code': 'AI_CAPS_NODE_FAILED', 'exitCode': result.returncode,
                 'codes': sorted(set(v.decode() for v in re.findall(rb'(?m)^(AI_CHECK_[A-Z_]+)$', result.stderr))),
                 'stdoutSha256': hashlib.sha256(result.stdout).hexdigest(), 'stderrSha256': hashlib.sha256(result.stderr).hexdigest()})
            raise RuntimeError('AI_CAPS_NODE_FAILED')
        observed = json.loads(result.stdout)
        save('ai-caps-' + phase + '-observations.json', observed)
        assert observed['status'] == 'PASS' and observed['nativeExternalAttempts'] == 0, 'AI_CAPS_FACTORY_UNPROVEN'
        return observed
    initial = observe('unknown')
    assert len(initial['observations']) == 1, 'AI_CAPS_ORIGINAL_UNKNOWN_COUNT'
    original = initial['observations'][0]['reservations'][0]
    unknown_id = str(uuid.UUID(original['reservationId']))
    original_unknown = sql("select to_jsonb(a)::text from private.ai_account_budget_reservations a where reservation_id=" + q(unknown_id) + '::uuid;')
    assert original_unknown and sql('select unknown_at is not null and settled_at is null from private.ai_account_budget_reservations where reservation_id=' + q(unknown_id) + '::uuid;') == 't', 'AI_CAPS_ORIGINAL_UNKNOWN_NOT_STORED'
    fixture['aiCapUnknownUnits'] = original['units']
    observed = observe('fill')
    observed['observations'] = initial['observations'] + observed['observations']
    assert len(observed['observations']) == 6, 'AI_CAPS_EXACT_OBSERVATIONS'
    assert sql("select to_jsonb(a)::text from private.ai_account_budget_reservations a where reservation_id=" + q(unknown_id) + '::uuid;') == original_unknown, 'AI_CAPS_ORIGINAL_UNKNOWN_CHANGED_AFTER_FILL'
    assert sql("select (clock_timestamp()at time zone'Asia/Seoul')::date;") == day, 'AI_CAPS_NATURAL_DAY_CHANGED'
    observations = observed['observations']
    assert [o['case'] for o in observations] == ['unknown-preserved'] + ['fill-' + a for a in account_ids] + ['global-denied'], 'AI_CAPS_EXACT_CASES'
    requests, reservations = [], []
    for o in observations:
        assert len(o['requests']) == 1 and o['requests'][0]['acquireStatus'] == 'acquired', 'AI_CAPS_REQUEST_NOT_ACQUIRED'
        request = o['requests'][0]
        rid = str(uuid.UUID(request['requestId']))
        denied, unknown = o['case'] == 'global-denied', o['case'] == 'unknown-preserved'
        row = json.loads(sql("select jsonb_build_object('ownerBound',user_id=" + q(fixture['accounts'][0]['userId']) + "::uuid,'leaseSha256',encode(sha256(convert_to(lease_token::text,'UTF8')),'hex'),'finished',outcome='finished'and finished_at is not null,'started',started_at is not null,'day',counted_day,'resultCount',(select count(*)from private.ai_result_receipts where request_id=r.request_id and user_id=r.user_id))from private.ai_chat_requests r where request_id=" + q(rid) + '::uuid;'))
        assert row['ownerBound'] and row['finished'] and row['leaseSha256'] == request['leaseSha256'] and row['started'] == (not denied) and row['day'] == (None if denied else day) and row['resultCount'] == int(not denied and not unknown), 'AI_CAPS_ACTUAL_REQUEST_PROOF'
        requests.append({'requestId': rid, **row, 'case': o['case']})
        if denied:
            assert not o['reservations'] and o['providerInterceptions'] == 0 and o['reserveAttempts'] == [{'accountId': 'yumi', 'status': 'global_budget_denied', 'units': o['reserveAttempts'][0]['units']}], 'AI_CAPS_DENIAL_NEW_EFFECT'
            continue
        assert len(o['reservations']) == 1 and o['providerInterceptions'] == 1, 'AI_CAPS_RESERVATION_COUNT'
        r = o['reservations'][0]
        receipt = json.loads(sql("select jsonb_build_object('ledgerId',ledger_id,'accountId',account_id,'accountDay',account_day,'units',reserved_units,'settled',settled_at is not null,'unknown',unknown_at is not null,'input',input_tokens,'output',output_tokens,'legacyPending',exists(select 1 from private.ai_budget_reservations where id=a.reservation_id))from private.ai_account_budget_reservations a where reservation_id=" + q(str(uuid.UUID(r['reservationId']))) + '::uuid;'))
        assert r['dispatched'] and r['settled'] and r['requestId'] == rid and (receipt['ledgerId'], receipt['accountId'], receipt['accountDay'], receipt['units']) == (fixture['aiLedgerId'], r['accountId'], day, r['units']), 'AI_CAPS_RESERVATION_EXACT_BINDING'
        assert receipt['unknown'] == unknown and receipt['settled'] == (not unknown) and receipt['legacyPending'] == unknown and (receipt['input'], receipt['output']) == ((None, None) if unknown else (o['reportedCharge'] - 1, 1)), 'AI_CAPS_USAGE_PROOF'
        reservations.append({'reservationId': r['reservationId'], **receipt})
    assert len({r['requestId'] for r in requests}) == 6 and len({r['reservationId'] for r in reservations}) == 5, 'AI_CAPS_EXTRA_IDENTITIES'
    unknown = reservations[0]
    assert len([r for r in reservations if r['unknown']]) == 1 and ai_usage(fixture['accounts'][0]['userId']) == 5, 'AI_CAPS_DENIAL_CONSUMED_DAILY_COUNT'
    assert sql('select active_request_id is null from private.ai_member_processing where user_id=' + q(fixture['accounts'][0]['userId']) + '::uuid;') == 't', 'AI_CAPS_OCCUPANCY_NOT_RELEASED'
    budget_after = ai_limits_budget()
    charge = sum(o['reportedCharge'] for o in observations)
    assert set(budget_after['global']) == set(budget_before['global']) | {day} and set(budget_after['accounts']) == set(budget_before['accounts']) | {a + ':' + day for a in account_ids}, 'AI_CAPS_EXTRA_BUDGET_DAYS'
    assert sql('select count(*)=6 from private.ai_chat_requests where user_id in(' + ids + ');') == 't', 'AI_CAPS_EXTRA_MEMBER_REQUESTS'
    assert sql('select count(*)=1 and sum(started_requests)=5 from private.ai_member_daily_usage where user_id in(' + ids + ');') == 't', 'AI_CAPS_EXTRA_MEMBER_DAILY_ROWS'
    for account in account_ids:
        after = budget_after['accounts'][account + ':' + day]
        assert sum(after) == 3200000 and after[0] == balances[account][0] + (unknown['units'] if account == 'yumi' else 0), 'AI_CAPS_ACCOUNT_BOUNDARY_NOT_EXACT'
    assert budget_after['global'][day] == [budget_before['global'].get(day, [0, 0])[0] + unknown['units'], budget_before['global'].get(day, [0, 0])[1] + charge] and sum(budget_after['global'][day]) == 12800000, 'AI_CAPS_GLOBAL_BOUNDARY_NOT_EXACT'
    for scope, table in budget_before.items():
        for key, value in table.items():
            if key != day and not (scope == 'accounts' and key in {a + ':' + day for a in account_ids}):
                assert budget_after[scope][key] == value, 'AI_CAPS_OLD_DAY_BUDGET_CHANGED'
    assert protected_rows() == protected_before, 'AI_CAPS_PROTECTED_RECEIPTS_CHANGED'
    assert sql('select reserved_units=' + str(unknown['units']) + 'and charged_units=' + str(charge) + 'and open_calls=1 and settled_calls=4 and unknown_usage_calls=0 from private.ai_budget_ledgers where ledger_id=' + q(fixture['aiLedgerId']) + ';') == 't', 'AI_CAPS_REAL_LEGACY_LEDGER_BALANCE'
    assert sql('select count(*)=5 and count(*)filter(where unknown_at is not null)=1 and count(*)filter(where settled_at is not null)=4 from private.ai_account_budget_reservations where ledger_id=' + q(fixture['aiLedgerId']) + ';') == 't', 'AI_CAPS_EXTRA_RECEIPTS'
    for table in ('ai_chat_requests', 'ai_member_processing', 'ai_member_daily_usage', 'ai_budget_ledgers', 'ai_budget_reservations', 'ai_account_budget_reservations', 'ai_result_receipts'):
        assert sql("select not exists(select 1 from private." + table + " t where strpos(to_jsonb(t)::text,'AI_DIALOGUE_CANARY')>0);") == 't', 'AI_RAW_DIALOGUE_PERSISTED'
    ai_restore(); closed(NAME, final=True)
    assert sql("select to_jsonb(a)::text from private.ai_account_budget_reservations a where reservation_id=" + q(unknown['reservationId']) + '::uuid;') == original_unknown, 'AI_CAPS_UNKNOWN_CHANGED_DURING_CLOSE'
    assert snapshot(SOURCE) == source_before, 'READONLY_SOURCE_CHANGED'
    for relative, expected in manifest.items():
        assert hashlib.sha256((FOUNDATION / relative).read_bytes()).hexdigest() == expected, 'AI_CAPS_PRODUCT_GRAPH_CHANGED'
    receipt = {'status': 'PASS', 'scope': 'ISOLATED_REAL_AUTH_RPC_SYNTHETIC_REPORTED_USAGE_CAP_ADMISSION', 'scenario': 'ai-caps',
               'manifest': manifest, 'requestProof': requests, 'reservationProof': reservations, 'budgetBefore': budget_before, 'budgetAfter': budget_after,
               'memberStartedRequests': 5, 'syntheticReportedCharge': charge, 'unknownPreserved': True,
               'existingProtectedReceiptDigestUnchanged': True, 'sourceTableCount': 186, 'sourceRowsCatalogRolesAclUnchanged': True,
               'originalSettingsAndAclRestored': True, 'processingGuardClosed': True, 'cloneRowsRolledBack': False,
               'providerNativeExternalTransport': 0, 'rawPromptsModelResponsesDsnsLogged': False, 'syntheticUsageOnly': True,
               'actualWallClockMidnight': 'NOT_RUN', 'realProviderQualityAccountCostResetSharedUseLegalMemberLogin': 'NOT_RUN',
               'externalDeleteAndAckCalls': 0, 'operatingChanged': False}
    save('ai-caps-provisional.json', receipt)
    return receipt


AI_LIMITS_MONITOR_STOP = None
_ai_limits_original_run = run


def ai_limits_run():
    try:
        return _ai_limits_original_run()
    finally:
        if AI_LIMITS_MONITOR_STOP is not None:
            AI_LIMITS_MONITOR_STOP.set()


def ai_limits_entry():
    """3초 표본과 실제 own Node 종료. 기존 소비자/AI 분기는 변경하지 않는다."""
    global AI_LIMITS_MONITOR_STOP
    import signal
    def sample():
        result = subprocess.run(auth.DOCKER + ['exec', SOURCE, 'cat', '/proc/meminfo'], capture_output=True, timeout=5)
        assert result.returncode == 0, 'AI_LIMITS_MEMORY_READ_FAILED'
        raw = result.stdout.decode()
        match = re.search(r'^MemAvailable:\s+([0-9]+) kB$', raw, re.M)
        assert match is not None, 'AI_LIMITS_MEMORY_UNAVAILABLE'
        return int(match[1])
    initial = sample()
    assert initial >= 1048576, 'AI_LIMITS_PREPARE_REQUIRES_1GIB'
    samples = [{'memAvailableKiB': initial, 'thresholdKiB': 1048576, 'stage': 'prepare'}]
    def inventory():
        names = docker('ps', '-a', '--format', '{{.Names}}').decode().splitlines()
        return {name: {'id': info['Id'], 'running': info['State']['Running'], 'oomKilled': info['State']['OOMKilled'],
                'configSha256': hashlib.sha256(json.dumps(info['Config'], sort_keys=True).encode()).hexdigest(),
                'hostConfigSha256': hashlib.sha256(json.dumps(info['HostConfig'], sort_keys=True).encode()).hexdigest()}
                for name in names for info in (auth.inspect(name),)}
    prior = inventory()
    stopped = threading.Event(); AI_LIMITS_MONITOR_STOP = stopped
    def stop(signum, frame):
        raise RuntimeError('AI_LIMITS_MEMORY_OR_OWN_SIGNAL_STOP')
    previous = signal.signal(signal.SIGTERM, stop)
    def monitor():
        while not stopped.wait(3):
            try:
                value = sample()
                if stopped.is_set():
                    return
                samples.append({'memAvailableKiB': value, 'thresholdKiB': 786432, 'stage': 'running'})
                if value >= 786432:
                    continue
            except Exception:
                samples.append({'code': 'AI_LIMITS_MEMORY_SAMPLE_FAILED'})
            if stopped.is_set():
                return
            os.kill(os.getpid(), signal.SIGTERM)
            return
    worker = threading.Thread(target=monitor, daemon=True); worker.start()
    completed = False
    try:
        ai_main()
        completed = True
    finally:
        stopped.set(); worker.join(timeout=10); signal.signal(signal.SIGTERM, previous)
        if ROOT.is_dir() and ROOT.resolve() == ROOT and not(ROOT.stat().st_mode & 0o077):
            save('ai-limits-memory-samples.json', {'intervalSeconds': 3, 'samples': samples,
                 'floorViolated': any(s.get('memAvailableKiB', 0) < s.get('thresholdKiB', 0) for s in samples),
                 'sampleFailed': any('code' in s for s in samples),
                 'scope': 'VM_MEMAVAILABLE_SAMPLES_NOT_CONTINUOUS_OBSERVATION'})
            current = inventory()
            own = {}
            for name, identifier in CREATED.items():
                info = auth.inspect(name)
                own[name] = {'idBound': info['Id'] == identifier, 'stopped': not info['State']['Running'],
                     'oomKilled': info['State']['OOMKilled'], 'memoryBytes': info['HostConfig']['Memory'],
                     'expectedMemoryBytes': (512 if name == NAME else 128) * 1048576}
            prior_same = all(current.get(name) == value for name, value in prior.items())
            owned_closed = all(v['idBound'] and v['stopped'] and not v['oomKilled'] and v['memoryBytes'] == v['expectedMemoryBytes'] for v in own.values())
            children = [json.loads(path.read_text()) for path in ROOT.glob('consumer-node-end-*.json')]
            children_closed = all(not value['stillRunning'] and value['returnCode'] is not None for value in children)
            successful = completed and len(own) == 3 and owned_closed and prior_same and children_closed and not worker.is_alive() and not any('code' in v or v['memAvailableKiB'] < v['thresholdKiB'] for v in samples)
            save('ai-limits-finalization.json', {'status': 'PASS' if successful else 'FAIL', 'actualScenarioCompleted': completed,
                 'ownContainers': own, 'priorContainersUnchanged': prior_same, 'actualNodeChildrenExited': children_closed,
                 'memoryMonitorExited': not worker.is_alive(), 'sourceProof': 'ai-source-final-private.json',
                 'metadataOnly': True, 'operatingChanged': False})
            if completed:
                assert successful, 'AI_LIMITS_FINALIZATION_NOT_CONFIRMED'


def midnight_private(name):
    path = ROOT / name
    assert path.parent == ROOT and ROOT.resolve() == ROOT and not ROOT.is_symlink(), 'MIDNIGHT_FIXED_ROOT'
    for item, mode in ((ROOT, 0o700), (path, 0o600)):
        info = item.lstat()
        assert info.st_uid == os.getuid() and info.st_mode & 0o777 == mode and not item.is_symlink(), 'MIDNIGHT_PRIVATE_INPUT'
    assert path.is_file() and path.stat().st_nlink == 1, 'MIDNIGHT_REGULAR_SINGLE_LINK_INPUT'
    return path


def midnight_write(name, value):
    assert Path(name).name == name and ROOT.resolve() == ROOT and not ROOT.is_symlink(), 'MIDNIGHT_WRITE_SCOPE'
    fd = os.open(ROOT / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(json.dumps(value, sort_keys=True).encode())
        out.flush(); os.fsync(out.fileno())
    for directory in (ROOT, ROOT.parent):
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)


def midnight_query(statement, *, name=None, timeout=2):
    target = NAME if name is None else name
    assert target in (NAME, SOURCE) and 0 < timeout <= 5, 'MIDNIGHT_READ_SCOPE'
    query = ('begin read only;set local statement_timeout=' + str(max(1, int(timeout * 500))) + ';' + statement + 'rollback;').encode()
    result = subprocess.run(auth.DOCKER + ['exec', '-i', target, 'psql', '-XqAt', '-U', auth.BOOT, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input=query, capture_output=True, timeout=timeout)
    assert result.returncode == 0, 'MIDNIGHT_READ_FAILED'
    return result.stdout.decode().strip()


def midnight_clock(*, name=None, timeout=2):
    value = json.loads(midnight_query("with s as(select clock_timestamp()t)select jsonb_build_object('epoch',extract(epoch from t),'day',(t at time zone'Asia/Seoul')::date,'midnightEpoch',extract(epoch from(((t at time zone'Asia/Seoul')::date+1)::timestamp at time zone'Asia/Seoul')),'nextDay',(t at time zone'Asia/Seoul')::date+1)from s;", name=name, timeout=timeout))
    assert set(value) == {'epoch', 'day', 'midnightEpoch', 'nextDay'} and 0 < value['midnightEpoch'] - value['epoch'] <= 86400, 'MIDNIGHT_NATURAL_CLOCK_SHAPE'
    return value


def midnight_counts(fixture, day):
    datetime.strptime(day, '%Y-%m-%d')
    ids = ','.join("'" + str(uuid.UUID(a['userId'])) + "'::uuid" for a in fixture['accounts'])
    return json.loads(midnight_query("select jsonb_agg(coalesce((select started_requests from private.ai_member_daily_usage where user_id=x.uid and kst_day='" + day + "'),0)order by x.pos)from unnest(array[" + ids + '])with ordinality x(uid,pos);', timeout=3))


def midnight_own(name):
    assert name in (NAME, AUTH, REST), 'MIDNIGHT_OWN_NAME'
    info = auth.inspect(name)
    assert not info['State']['OOMKilled'] and info['Config']['Labels'].get('yumidang.owner') == 'minkyu', 'MIDNIGHT_OWN_OWNER_OOM'
    assert info['HostConfig']['Memory'] == (512 if name == NAME else 128) * 1048576 and not info['HostConfig'].get('PortBindings') and info['Config']['Healthcheck']['Test'] == ['NONE'], 'MIDNIGHT_OWN_CAPS_PORTS_HEALTH'
    networks = info['NetworkSettings']['Networks']
    assert set(networks) == {NETWORK}, 'MIDNIGHT_OWN_NETWORK'
    digest = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
    return {'id': info['Id'], 'image': info['Image'], 'config': digest(info['Config']), 'hostConfig': digest(info['HostConfig']), 'mounts': digest(info['Mounts']), 'networkId': networks[NETWORK]['NetworkID']}


def midnight_prepare_units(fixture, source_before, manifest):
    assert midnight_graph_digest(manifest) == MIDNIGHT_GRAPHS[0], 'MIDNIGHT_REVIEWED_GRAPH_CHANGED_BEFORE_MODEL'
    midnight_graph(manifest)
    clock = midnight_clock()
    assert clock['day'] == MIDNIGHT_TARGET['day'] and 600 <= clock['midnightEpoch'] - clock['epoch'] <= 3600, 'MIDNIGHT_PREPARE_FIXTURE_WINDOW'
    result = ai_limits_units(fixture, source_before, manifest)
    final_clock = midnight_clock()
    assert final_clock['day'] == clock['day'] and final_clock['midnightEpoch'] - final_clock['epoch'] >= 300, 'MIDNIGHT_PREPARE_WINDOW_EXPIRED'
    unknown = next(r for r in result['reservationProof'] if r['unknown'])
    original_unknown = midnight_query("select to_jsonb(a)::text from private.ai_account_budget_reservations a where reservation_id='" + str(uuid.UUID(unknown['reservationId'])) + "';")
    original_legacy = midnight_query("select to_jsonb(a)::text from private.ai_budget_reservations a where id='" + str(uuid.UUID(unknown['reservationId'])) + "';")
    assert original_unknown and original_legacy, 'MIDNIGHT_ORIGINAL_UNKNOWN_ROWS_REQUIRED'
    midnight_write('midnight-prepared-state-private.json', {'fixture': fixture, 'day': clock['day'], 'nextDay': clock['nextDay'], 'midnightEpoch': clock['midnightEpoch'], 'cloneSnapshot': snapshot(NAME), 'budget': ai_limits_budget(), 'counts': midnight_counts(fixture, clock['day']), 'unknown': unknown, 'unknownRow': original_unknown, 'legacyRow': original_legacy, 'clock': final_clock})
    return result


def midnight_validate_tokens(fixture, target):
    for account in fixture['accounts']:
        parts = account['token'].split('.')
        assert len(parts) == 3, 'MIDNIGHT_ORIGINAL_SIGNED_TOKEN'
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
        assert claims['sub'] == account['userId'] and claims['iss'] == fixture['origin'] + '/auth/v1' and claims['role'] == 'authenticated' and claims['aud'] == 'authenticated' and claims['session_id'] == account['sessionId'] and claims['exp'] > target + 120, 'MIDNIGHT_ORIGINAL_TOKEN_EXPIRED_OR_REPLACED'
    # JWT claims only reject unusable inputs; the real factory must authenticate each original token.


def midnight_graph(manifest):
    current = {str(p.relative_to(FOUNDATION.resolve())): hashlib.sha256(p.read_bytes()).hexdigest() for p in product_sources(('ai-chat/index.ts',))}
    assert manifest == current, 'MIDNIGHT_FULL_GRAPH_CHANGED'
    for ext in ('py', 'ts'):
        assert (FOUNDATION / ('tests/integration/minkyu/content_inspection_http_local.' + ext)).read_bytes() == Path(__file__).with_suffix('.' + ext).read_bytes(), 'MIDNIGHT_HARNESS_HANDSHAKE'


def midnight_graph_digest(manifest):
    return hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def midnight_input_binding(binding):
    assert binding['status'] == 'PREPARED_MIDNIGHT_NOT_RUN' and binding['actualMidnight'] == 'NOT_RUN' and binding['root'] == str(ROOT) and binding['name'] == NAME, 'MIDNIGHT_PREPARED_ONLY'
    assert set(binding['own']) == {NAME, AUTH, REST} and len({v['id'] for v in binding['own'].values()}) == 3, 'MIDNIGHT_EXACT_OWN_IDS'
    inputs = binding['inputs']
    assert inputs and set(inputs) == {p.name for p in ROOT.iterdir() if p.name != 'midnight-prepared-binding.json'}, 'MIDNIGHT_INPUT_INVENTORY_CHANGED'
    for filename, expected in inputs.items():
        assert re.fullmatch('[0-9a-f]{64}', expected) and hashlib.sha256(midnight_private(filename).read_bytes()).hexdigest() == expected, 'MIDNIGHT_PREPARED_INPUT_CHANGED'
    receipt = json.loads(midnight_private('receipt.json').read_text())
    final = json.loads(midnight_private('ai-limits-finalization.json').read_text())
    assert receipt['status'] == 'PASS' and receipt['scenario'] == 'ai-limits' and receipt['manifest'] == binding['manifest'] and receipt['memberStartedRequests'] == [3, 20, 3] and len(receipt['requestProof']) == len(receipt['reservationProof']) == 26 and len(receipt['deniedProof']) == 2 and receipt['legacyLedgerOpenUnknownCalls'] == 1 and receipt['providerNativeExternalTransport'] == 0 and receipt['actualWallClockMidnight'] == 'NOT_RUN', 'MIDNIGHT_ORIGINAL_28_RECEIPT_REQUIRED'
    assert final['status'] == 'PASS' and final['actualScenarioCompleted'] and final['priorContainersUnchanged'] and final['actualNodeChildrenExited'] and final['memoryMonitorExited'] and set(final['ownContainers']) == {NAME, AUTH, REST} and all(v['idBound'] and v['stopped'] and not v['oomKilled'] and v['memoryBytes'] == v['expectedMemoryBytes'] for v in final['ownContainers'].values()), 'MIDNIGHT_ORIGINAL_FINALIZATION_REQUIRED'
    midnight_graph(binding['manifest'])
    assert snapshot(SOURCE) == json.loads(midnight_private('source-before-private.json').read_text()), 'MIDNIGHT_SOURCE_CHANGED'
    for name, expected in binding['own'].items():
        assert midnight_own(name) == expected and not auth.inspect(name)['State']['Running'], 'MIDNIGHT_OWN_REPLACED_OR_RUNNING'
    network = json.loads(docker('network', 'inspect', NETWORK))[0]
    assert network['Internal'] and network['Id'] == binding['networkId'] and network['Labels'].get('yumidang.owner') == 'minkyu', 'MIDNIGHT_INTERNAL_NETWORK_CHANGED'
    state = json.loads(midnight_private('midnight-prepared-state-private.json').read_text())
    assert state['counts'] == [3, 20, 3] and state['day'] == binding['day'] and state['midnightEpoch'] == binding['midnightEpoch'], 'MIDNIGHT_PREPARED_DAY_PROOF'
    midnight_validate_tokens(state['fixture'], state['midnightEpoch'])
    return state


def midnight_node(fixture, phase):
    path = ROOT / ('midnight-' + phase + '-fixture-private.json')
    midnight_write(path.name, {**fixture, 'midnightPhase': phase})
    midnight_graph(fixture['productManifest'])
    result = consumer_node_call(['node', '--experimental-strip-types', str(Path(__file__).with_suffix('.ts')), str(path), '--ai-midnight'], timeout=10 if phase == 'held' else 30)
    if result.returncode:
        midnight_write('midnight-' + phase + '-node-failed.json', {'code': 'MIDNIGHT_NODE_FAILED', 'exitCode': result.returncode, 'stdoutSha256': hashlib.sha256(result.stdout).hexdigest(), 'stderrSha256': hashlib.sha256(result.stderr).hexdigest()})
        raise RuntimeError('MIDNIGHT_NODE_FAILED')
    observed = json.loads(result.stdout)
    midnight_write('midnight-' + phase + '-observations.json', observed)
    assert observed['status'] == 'PASS' and observed['nativeExternalAttempts'] == 0, 'MIDNIGHT_FACTORY_UNPROVEN'
    return observed


def midnight_observer(state, stopped, evidence):
    deadline = time.monotonic() + 8
    try:
        while not (ROOT / 'midnight-provider-ready.json').exists():
            assert not stopped.is_set() and time.monotonic() < deadline, 'MIDNIGHT_PROVIDER_DID_NOT_RESERVE'
            stopped.wait(.02)
        hold_deadline = time.monotonic() + 2.5
        assert json.loads(midnight_private('midnight-provider-ready.json').read_text()) == {'ready': True}, 'MIDNIGHT_PROVIDER_READY_MARKER'
        marker = json.loads(midnight_private('midnight-provider-marker.json').read_text())
        remaining = lambda: max(.001, hold_deadline - time.monotonic())
        before = midnight_clock(timeout=min(.75, remaining()))
        assert before['day'] == state['day'] and before['epoch'] < state['midnightEpoch'] and 0 < state['midnightEpoch'] - before['epoch'] < 2.2, 'MIDNIGHT_RESERVE_NOT_BEFORE_BOUNDARY'
        rid, reservation = str(uuid.UUID(marker['requestId'])), str(uuid.UUID(marker['reservationId']))
        proof = json.loads(midnight_query("select jsonb_build_object('requestDay',r.counted_day,'startedEpoch',extract(epoch from r.started_at),'leaseSha256',encode(sha256(convert_to(r.lease_token::text,'UTF8')),'hex'),'reservationDay',a.account_day,'accountId',a.account_id,'units',a.reserved_units,'pending',a.settled_at is null and a.unknown_at is null)from private.ai_chat_requests r join private.ai_account_budget_reservations a on a.reservation_id='" + reservation + "'where r.request_id='" + rid + "'and r.user_id='" + state['fixture']['accounts'][0]['userId'] + "'and a.ledger_id='" + state['fixture']['aiLedgerId'] + "';", timeout=min(.75, remaining())))
        assert proof['pending'] and proof['requestDay'] == proof['reservationDay'] == marker['accountDay'] == state['day'] and proof['startedEpoch'] < state['midnightEpoch'] and proof['leaseSha256'] == marker['leaseSha256'] and proof['accountId'] == marker['accountId'] and proof['units'] == marker['units'], 'MIDNIGHT_ORIGINAL_RESERVATION_PROOF'
        while True:
            assert not stopped.is_set() and remaining() > .05, 'MIDNIGHT_OBSERVER_TIMEOUT_OR_ABORT'
            after = midnight_clock(timeout=min(.5, remaining()))
            if after['day'] == state['nextDay']:
                assert state['midnightEpoch'] <= after['epoch'] < state['midnightEpoch'] + 2, 'MIDNIGHT_POST_BOUNDARY_WINDOW'
                break
            assert after['day'] == state['day'], 'MIDNIGHT_NATURAL_DAY_CHANGED_UNEXPECTEDLY'
            stopped.wait(min(.03, remaining()))
        release = {'requestId': rid, 'reservationId': reservation, 'beforeDay': before['day'], 'afterDay': after['day'], 'beforeEpoch': before['epoch'], 'afterEpoch': after['epoch']}
        midnight_write('midnight-provider-release.json', release)
        evidence.update(status='PASS_NATURAL_SQL_CHECKPOINTS', before=before, after=after, proof=proof, release=release)
    except Exception:
        evidence['status'] = 'FAIL_NATURAL_OBSERVER'
        # No release on failure: the bounded provider hold aborts and preserves uncertainty.


MIDNIGHT_RECOVERY_EXPECTED = None
MIDNIGHT_BODY_COMPLETED = False


def midnight_unknown_before_stop():
    """실패 경로도 원 UNKNOWN 두 행을 읽는다. 멈춘 DB를 다시 시작하지 않는다."""
    evidence = {'actualScenarioStatus': 'COMPLETED_PENDING_FINALIZATION' if MIDNIGHT_BODY_COMPLETED else 'FAILED_OR_NOT_COMPLETED', 'verification': 'UNKNOWN_VERIFICATION_NOT_RUN', 'beforeOwnStop': True, 'restarts': 0}
    if MIDNIGHT_RECOVERY_EXPECTED is not None:
        state = MIDNIGHT_RECOVERY_EXPECTED
        expected = [state['unknownRow'], state['legacyRow']]
        evidence['expectedFullRowSha256'] = [hashlib.sha256(v.encode()).hexdigest() for v in expected]
        try:
            assert NAME in CREATED and auth.inspect(NAME)['Id'] == CREATED[NAME] and auth.inspect(NAME)['State']['Running'], 'MIDNIGHT_UNKNOWN_OWN_RUNNING_REQUIRED'
            identifier = str(uuid.UUID(state['unknown']['reservationId']))
            actual = [midnight_query("select to_jsonb(a)::text from private.ai_account_budget_reservations a where reservation_id='" + identifier + "';"), midnight_query("select to_jsonb(a)::text from private.ai_budget_reservations a where id='" + identifier + "';")]
            evidence['observedFullRowSha256'] = [hashlib.sha256(v.encode()).hexdigest() for v in actual]
            evidence['verification'] = 'PASS_ORIGINAL_UNKNOWN_FULL_ROWS_UNCHANGED' if actual == expected else 'FAIL_ORIGINAL_UNKNOWN_FULL_ROWS_CHANGED'
        except Exception:
            pass
    midnight_write('midnight-unknown-before-stop.json', evidence)
    return evidence['verification'] == 'PASS_ORIGINAL_UNKNOWN_FULL_ROWS_UNCHANGED'


def midnight_resume_body():
    global AI_ORIGINAL, AI_FIXTURE, MIDNIGHT_RECOVERY_EXPECTED, MIDNIGHT_BODY_COMPLETED
    binding_path = midnight_private('midnight-prepared-binding.json')
    assert hashlib.sha256(binding_path.read_bytes()).hexdigest() == MIDNIGHT_BINDINGS[0], 'MIDNIGHT_EXTERNAL_BINDING_MISMATCH'
    binding = json.loads(binding_path.read_text())
    state = midnight_input_binding(binding)
    assert state['unknownRow'] and state['legacyRow'], 'MIDNIGHT_PREPARED_UNKNOWN_FULL_ROWS_REQUIRED'
    MIDNIGHT_RECOVERY_EXPECTED = state
    clock = midnight_clock(name=SOURCE)
    assert clock['day'] == state['day'] and 5 < state['midnightEpoch'] - clock['epoch'] <= 120, 'MIDNIGHT_RESUME_NATURAL_WINDOW'
    fixture = state['fixture']
    from urllib.parse import urlsplit
    origin = urlsplit(fixture['origin'])
    assert origin.scheme == 'http' and origin.hostname == '127.0.0.1' and origin.port and origin.path == '', 'MIDNIGHT_ORIGINAL_ISSUER'
    gateway = ThreadingHTTPServer(('127.0.0.1', origin.port), auth.Gateway)
    worker = threading.Thread(target=gateway.serve_forever, daemon=True)
    observer_stop, evidence = threading.Event(), {}
    observer = None
    try:
        midnight_write('midnight-resume-intent.json', {'purpose': 'SINGLE_NATURAL_MIDNIGHT_SYNTHETIC_RESUME', 'externalPreparedBinding': MIDNIGHT_BINDINGS[0], 'ownIds': {n: v['id'] for n, v in binding['own'].items()}, 'time': clock, 'noRetry': True})
        CREATED.update({n: v['id'] for n, v in binding['own'].items()})
        for name in (NAME, AUTH, REST):
            assert midnight_own(name) == binding['own'][name], 'MIDNIGHT_OWN_BEFORE_START'
            started = subprocess.run(auth.DOCKER + ['start', name], capture_output=True, timeout=10)
            assert started.returncode == 0 and auth.inspect(name)['Id'] == binding['own'][name]['id'], 'MIDNIGHT_EXACT_OWN_START_FAILED'
        worker.start()
        readiness_deadline = time.monotonic() + 45
        for target in ('http://' + AUTH + ':9999/health', 'http://' + REST + ':3000/'):
            while True:
                remaining = readiness_deadline - time.monotonic()
                assert remaining > 0, 'MIDNIGHT_READINESS_TIMEOUT'
                probe = subprocess.run(auth.DOCKER + ['exec', NAME, 'curl', '--max-time', '1', '-s', '-o', '/dev/null', '-w', '%{http_code}', target], capture_output=True, timeout=min(2, remaining))
                if probe.returncode == 0 and probe.stdout == b'200': break
                time.sleep(min(.1, remaining))
        closed(NAME)
        assert snapshot(NAME) == state['cloneSnapshot'], 'MIDNIGHT_PREPARED_CLONE_CHANGED'
        assert snapshot(SOURCE) == json.loads(midnight_private('source-before-private.json').read_text()), 'MIDNIGHT_SOURCE_CHANGED_AFTER_START'
        AI_ORIGINAL = json.loads(midnight_private('ai-original-settings-private.json').read_text())
        AI_FIXTURE = fixture
        clock = midnight_clock()
        assert clock['day'] == state['day'] and 3 < state['midnightEpoch'] - clock['epoch'] <= 60, 'MIDNIGHT_BOUNDED_IDLE_WINDOW'
        assert midnight_counts(fixture, state['day']) == [3, 20, 3] and midnight_counts(fixture, state['nextDay']) == [0, 0, 0], 'MIDNIGHT_ORIGINAL_DAILY_ROWS_CHANGED'
        ids = ','.join("'" + str(uuid.UUID(a['userId'])) + "'::uuid" for a in fixture['accounts'])
        sql("begin;update private.ai_budget_accounts set registered=true;update private.ai_processing_guard set external_processing_allowed=true where singleton;insert into private.ai_member_processing(user_id,exploration_allowed)select unnest(array[" + ids + "]),true on conflict(user_id)do update set exploration_allowed=true;commit;")
        deadline = time.monotonic() + 60
        while True:
            assert time.monotonic() < deadline, 'MIDNIGHT_WAIT_BOUND_EXCEEDED'
            clock = midnight_clock(timeout=1)
            remaining = state['midnightEpoch'] - clock['epoch']
            assert clock['day'] == state['day'] and remaining > .5, 'MIDNIGHT_START_WINDOW_MISSED'
            if remaining <= 2.2: break
            time.sleep(min(.1, max(.01, remaining - 2)))
        fixture = {**fixture, 'aiMidnightScenario': True, 'midnightDir': str(ROOT), 'originalDay': state['day'], 'nextDay': state['nextDay'], 'midnightEpoch': state['midnightEpoch']}
        observer = threading.Thread(target=midnight_observer, args=(state, observer_stop, evidence), daemon=True); observer.start()
        held = midnight_node(fixture, 'held')
        observer_stop.set(); observer.join(timeout=3)
        assert not observer.is_alive() and evidence.get('status') == 'PASS_NATURAL_SQL_CHECKPOINTS', 'MIDNIGHT_NATURAL_CHECKPOINTS_MISSING'
        assert midnight_clock()['day'] == state['nextDay'], 'MIDNIGHT_AFTER_DAY_NOT_ACTUAL'
        following = midnight_node(fixture, 'new-day')
        observations = held['observations'] + following['observations']
        assert len(observations) == 3 and midnight_counts(fixture, state['day']) == [4, 20, 3] and midnight_counts(fixture, state['nextDay']) == [0, 1, 1], 'MIDNIGHT_DAILY_ROWS_NOT_SEPARATE'
        for i, o in enumerate(observations):
            request, reservation = o['requests'][0], o['reservations'][0]
            expected_day = state['day'] if i == 0 else state['nextDay']
            proof = json.loads(midnight_query("select jsonb_build_object('finished',r.outcome='finished'and r.finished_at is not null,'requestDay',r.counted_day,'leaseSha256',encode(sha256(convert_to(r.lease_token::text,'UTF8')),'hex'),'reservedDay',a.account_day,'settledEpoch',extract(epoch from a.settled_at),'usage',jsonb_build_array(a.input_tokens,a.output_tokens),'resultCount',(select count(*)from private.ai_result_receipts x where x.request_id=r.request_id and x.user_id=r.user_id))from private.ai_chat_requests r join private.ai_account_budget_reservations a on a.reservation_id='" + str(uuid.UUID(reservation['reservationId'])) + "'where r.request_id='" + str(uuid.UUID(request['requestId'])) + "'and r.user_id='" + fixture['accounts'][o['account']]['userId'] + "'and a.ledger_id='" + fixture['aiLedgerId'] + "'and a.account_id='" + reservation['accountId'] + "';", timeout=3))
            assert proof['finished'] and proof['requestDay'] == proof['reservedDay'] == expected_day and proof['leaseSha256'] == request['leaseSha256'] and proof['usage'] == [1, 1] and proof['resultCount'] == 1 and proof['settledEpoch'] >= state['midnightEpoch'], 'MIDNIGHT_STORED_REQUEST_SETTLEMENT_PROOF'
            o['storedProof'] = proof
        unknown_id = str(uuid.UUID(state['unknown']['reservationId']))
        assert midnight_query("select to_jsonb(a)::text from private.ai_account_budget_reservations a where reservation_id='" + unknown_id + "';") == state['unknownRow'], 'MIDNIGHT_ORIGINAL_UNKNOWN_CHANGED'
        assert midnight_query("select to_jsonb(a)::text from private.ai_budget_reservations a where id='" + unknown_id + "';") == state['legacyRow'], 'MIDNIGHT_UNKNOWN_LEGACY_FULL_ROW_CHANGED'
        after = ai_limits_budget()
        expected = json.loads(json.dumps(state['budget']))
        for i, o in enumerate(observations):
            day = state['day'] if i == 0 else state['nextDay']
            account = o['reservations'][0]['accountId']
            for scope, key in (('global', day), ('accounts', account + ':' + day)):
                previous = expected[scope].get(key, [0, 0]); expected[scope][key] = [previous[0], previous[1] + 2]
        assert after == expected, 'MIDNIGHT_OLD_RESERVED_OR_DAY_BUDGET_CHANGED'
        for table in ('ai_chat_requests', 'ai_member_processing', 'ai_member_daily_usage', 'ai_budget_ledgers', 'ai_budget_reservations', 'ai_account_budget_reservations', 'ai_result_receipts'):
            assert midnight_query("select not exists(select 1 from private." + table + " t where strpos(to_jsonb(t)::text,'AI_DIALOGUE_CANARY')>0);") == 't', 'MIDNIGHT_RAW_DIALOGUE_PERSISTED'
        MIDNIGHT_BODY_COMPLETED = True
        return {'status': 'PASS', 'scope': 'ACTUAL_NATURAL_KST_BOUNDARY_WITH_SYNTHETIC_MODEL_USAGE', 'scenario': 'ai-midnight', 'beforeDay': state['day'], 'afterDay': state['nextDay'], 'naturalSqlEvidence': evidence, 'observations': observations, 'originalUnknownUnchanged': True, 'originalDailyTwentyUnchanged': True, 'dailyBefore': [4, 20, 3], 'dailyAfter': [0, 1, 1], 'budgetBefore': state['budget'], 'budgetAfter': after, 'providerNativeExternalTransport': 0, 'realProviderQualityAccountCostResetSharedUseLegalMemberLogin': 'NOT_RUN', 'cloneRowsRolledBack': False, 'operatingChanged': False}
    finally:
        observer_stop.set()
        if observer is not None: observer.join(timeout=3)
        if worker.is_alive(): gateway.shutdown(); worker.join(timeout=3)
        gateway.server_close()


def midnight_entry():
    global ai_units, run, _ai_limits_original_run, MIDNIGHT_TARGET, save, ai_restore
    if MIDNIGHT_PREPARE:
        assert not ROOT.exists(), 'MIDNIGHT_FRESH_PREPARE_ONLY'
        MIDNIGHT_TARGET = midnight_clock(name=SOURCE)
        assert 1200 <= MIDNIGHT_TARGET['midnightEpoch'] - MIDNIGHT_TARGET['epoch'] <= 3600, 'MIDNIGHT_PREPARE_BEFORE_ANY_FIXTURE_WINDOW'
        reviewed = {str(p.relative_to(FOUNDATION.resolve())): hashlib.sha256(p.read_bytes()).hexdigest() for p in product_sources(('ai-chat/index.ts',))}
        assert midnight_graph_digest(reviewed) == MIDNIGHT_GRAPHS[0], 'MIDNIGHT_EXTERNAL_REVIEWED_GRAPH_REQUIRED'
        midnight_graph(reviewed)
        ai_units, run = midnight_prepare_units, ai_limits_run
        ai_limits_entry()
        assert json.loads(midnight_private('receipt.json').read_text())['status'] == 'PASS' and json.loads(midnight_private('ai-limits-finalization.json').read_text())['status'] == 'PASS', 'MIDNIGHT_ORIGINAL_28_AND_FINAL_PASS_REQUIRED'
        state = json.loads(midnight_private('midnight-prepared-state-private.json').read_text())
        midnight_validate_tokens(state['fixture'], state['midnightEpoch'])
        own = {n: midnight_own(n) for n in (NAME, AUTH, REST)}
        assert all(not auth.inspect(n)['State']['Running'] for n in own), 'MIDNIGHT_PREPARED_OWN_NOT_STOPPED'
        inputs = {p.name: hashlib.sha256(midnight_private(p.name).read_bytes()).hexdigest() for p in ROOT.iterdir()}
        midnight_write('midnight-prepared-binding.json', {'status': 'PREPARED_MIDNIGHT_NOT_RUN', 'actualMidnight': 'NOT_RUN', 'root': str(ROOT), 'name': NAME, 'day': state['day'], 'midnightEpoch': state['midnightEpoch'], 'own': own, 'networkId': own[NAME]['networkId'], 'inputs': inputs, 'manifest': state['fixture']['productManifest']})
        return
    assert MIDNIGHT_RESUME and len(MIDNIGHT_BINDINGS) == 1, 'MIDNIGHT_RESUME_REQUIRES_ROOT_SELECTED_BINDING'
    original_save = save
    def resume_save(name, value):
        renamed = {'receipt.json', 'ai-source-final-private.json', 'ai-closed-and-stopped.json', 'ai-limits-memory-samples.json', 'ai-limits-finalization.json'}
        return original_save('midnight-resume-' + name if name in renamed else name, value)
    save = resume_save
    original_restore = ai_restore
    def resume_restore():
        proven = False
        try:
            proven = midnight_unknown_before_stop()
        finally:
            original_restore()  # 증거 실패도 기존 guard/settings 복원을 막지 않는다.
        assert proven, 'MIDNIGHT_FAILED_PATH_UNKNOWN_FULL_ROWS_NOT_PROVEN'
    ai_restore = resume_restore
    _ai_limits_original_run, run = midnight_resume_body, ai_limits_run
    completed = False
    try:
        ai_limits_entry()
        completed = True
    finally:
        if CREATED:
            after = snapshot(SOURCE)
            midnight_write('midnight-resume-source-final-private.json', after)
            source_same = after == json.loads(midnight_private('source-before-private.json').read_text())
            owned = {name: {'idBound': auth.inspect(name)['Id'] == identifier, 'stopped': not auth.inspect(name)['State']['Running'], 'oomKilled': auth.inspect(name)['State']['OOMKilled']} for name, identifier in CREATED.items()}
            final_path = ROOT / 'midnight-resume-ai-limits-finalization.json'
            execution_final = json.loads(midnight_private(final_path.name).read_text()) if final_path.exists() else {'status': 'FAIL'}
            final = completed and source_same and len(owned) == 3 and all(v['idBound'] and v['stopped'] and not v['oomKilled'] for v in owned.values()) and execution_final['status'] == 'PASS'
            midnight_write('midnight-resume-final.json', {'status': 'PASS' if final else 'FAIL', 'actualNaturalScenarioCompleted': completed, 'sourceRowsCatalogRolesAclUnchanged': source_same, 'sourceProof': 'midnight-resume-source-final-private.json', 'owned': owned, 'resourceAndChildrenProof': final_path.name, 'memoryScope': 'EXECUTION_SAMPLES_NOT_CONTINUOUS_CLEANUP_FLOOR', 'providerOrRealMemberOrOperating': 'NOT_RUN'})
            assert not completed or final, 'MIDNIGHT_FINALIZATION_NOT_CONFIRMED'


if AI_LIMITS or AI_CAPS:
    # 기존 run/ai_main/ai_units 함수 AST를 보존하고 신규 명시 분기에서만 조립한다.
    ai_units = ai_caps_units if AI_CAPS else ai_limits_units
    run = ai_limits_run

if __name__ == '__main__':
    if AI_MIDNIGHT:
        midnight_entry()
        raise SystemExit(0)
    if AI_LIMITS or AI_CAPS:
        ai_limits_entry()
        raise SystemExit(0)
    if AI_ONLY or CONSUMERS:
        ai_main()
        raise SystemExit(0)
    result = None
    try:
        result = run()
    except Exception as error:
        if ROOT.is_dir() and ROOT.resolve() == ROOT and not ROOT.stat().st_mode & 0o077:
            save('failure-' + uuid.uuid4().hex + '.log', repr(error))
        raise SystemExit('CONTENT_HTTP_FAILED_PRIVATE_EVIDENCE_PRESERVED') from None
    finally:
        try:
            if NAME in CREATED:
                for table in CONTROLS:
                    if sql("select to_regclass('private." + table + "')is not null;") == 't':
                        sql('update private.' + table + ' set enabled=false where singleton;')
                sql('update private.member_cleanup_guard set external_deletion_approved=false;')
                if sql("select to_regprocedure('public.issue_content_inspection_ticket(uuid,uuid,text,uuid,jsonb,text,text,text)')is not null;") == 't':
                    sql('revoke all on function public.issue_content_inspection_ticket(uuid,uuid,text,uuid,jsonb,text,text,text)from public,anon,authenticated,service_role;')
                closed(NAME, final=True)
            if (ROOT / 'source-before-private.json').is_file():
                after = snapshot(SOURCE)
                save('source-final-private.json', after)
                assert after == json.loads((ROOT / 'source-before-private.json').read_text()), 'SOURCE_CHANGED_AT_CLOSE'
        finally:
            for name, identifier in reversed(list(CREATED.items())):
                assert auth.inspect(name)['Id'] == identifier, 'CREATED_CONTAINER_ID_CHANGED'
                docker('stop', '--time', '5', name)
            if ROOT.is_dir() and CREATED:
                save('closed-and-stopped.json', {'containers': list(CREATED), 'stopped': all(not auth.inspect(n)['State']['Running'] for n in CREATED)})
    save('receipt.json', result)
    print(json.dumps(result, ensure_ascii=False))
