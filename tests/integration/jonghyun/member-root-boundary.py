"""J07/J08/J09 전용 Root dispatcher. 기본 CLI는 NOT_RUN이며 자원을 시작하지 않는다.

원 GoTrue Auth6를 읽기 재사용한다. J07/8 정리는 원 baseline으로 봉인하고 J09의 마지막
한 명은 별도 destructive-owned-synthetic scope로 보존한다. 운영·네이버·실파일 삭제가 아니다.
Node의 임의 SQL이나 JSON 승인 flag는 받지 않는다. 실제 실행은 Root가 검토·커밋한 packet만 받는다.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import subprocess
import sys
import time
import uuid

REPO = Path(__file__).resolve().parents[3]
CALLER = Path(__file__).resolve()
DRIVER = 'tests/integration/jonghyun/member-connections-rest.mjs'
METHOD_ARGS = {
    'verifyTarget': (), 'readCredentials': (), 'readIssuedAuth': (), 'readTls': (),
    'prepareConversation': ('memberUserIds',), 'inspectConversation': ('requestId',),
    'prepareReadBoundaryCases': ('requestId',), 'inspectReadBoundaryCases': ('requestId',),
    'setReadBoundaryCase': ('requestId', 'stage'),
    'inspectAiFeedback': ('userId', 'requestId'),
    'prepareFeedbackRetention': ('userId', 'requestId', 'feedbackId'),
    'inspectMaintenance': ('requestId',), 'cleanupConnections': ('memberUserIds',),
    'prepareRetirement': ('userId',), 'inspectRetirement': ('userId', 'withdrawalId'),
    'cleanupRetirement': ('userId', 'withdrawalId'),
}
MAX_FRAME = 2 * 1024 * 1024
MAINTENANCE_SIGNATURES = (
    'public.purge_ai_feedback_scoped(uuid,uuid,integer)',
    'public.get_worker_runtime_operation(uuid)',
)
RETIREMENT_SIGNATURES = (
    'public.claim_member_cleanup_task(uuid)',
    'public.check_member_cleanup_task(uuid,uuid,uuid,uuid)',
    'public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)',
    'public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)',
    'public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)',
)
CONTROL_TABLES = {'atomic': 'worker_runtime_atomic_control', 'feedback': 'ai_feedback_maintenance_control',
                  'retirement': 'member_retirement_receipt_control', 'cleanup': 'member_cleanup_guard'}


def require(value, code):
    if not value:
        raise ValueError('MEMBER_ROOT_' + code)


def safe_code(error, j01=None):
    value = error.args[0] if len(error.args) == 1 and type(error.args[0]) is str else ''
    if re.fullmatch(r'MEMBER_ROOT_[A-Z_]+|SQLSTATE_[A-Z0-9]{5}', value):
        return value
    if j01 is not None:
        reviewed = j01.safe_code(error)
        if reviewed != 'J01_ROOT_UNCLASSIFIED_FAILURE' and re.fullmatch(r'(J01_ROOT|SIGNED|PROVISION)_[A-Z_]+', reviewed):
            return reviewed
    return 'MEMBER_ROOT_UNCLASSIFIED_FAILURE'


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def digest(value):
    return sha(canonical(value))


def is_sha(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def uid(value):
    require(type(value) is str and str(uuid.UUID(value)) == value, 'UUID')
    return value


def q(value):
    require(type(value) is str, 'SQL_SCALAR')
    return "'" + value.replace("'", "''") + "'"


def row_sha_sql(alias):
    require(re.fullmatch('[a-z][a-z0-9_]*', alias) is not None, 'SQL_ALIAS')
    return "encode(sha256(convert_to(to_jsonb(" + alias + ")::text,'UTF8')),'hex')"


def subtract_owned_bags(snapshot, owned):
    """소유 행도 원 bag 안에 있어야 한다. 테이블 전체 예외는 허용하지 않는다."""
    require(type(snapshot) is dict and type(owned) is dict and set(owned) <= set(snapshot), 'OWNED_TABLES')
    remaining = {}
    for table, bag in snapshot.items():
        require(type(bag) is dict and all(is_sha(h) and type(n) is int and n > 0 for h, n in bag.items())
            and type(owned.get(table, {})) is dict, 'ROW_BAG')
        result = dict(bag)
        for key, count in owned.get(table, {}).items():
            require(is_sha(key) and type(count) is int and count > 0
                    and type(result.get(key)) is int and result[key] >= count, 'OWNED_ROW_NOT_PRESENT')
            result[key] -= count
            if result[key] == 0:
                del result[key]
        remaining[table] = result
    return remaining


def foreign_state_unchanged(before, after, before_owned, after_owned):
    require(type(before) is dict and type(after) is dict and set(before) == set(after), 'SNAPSHOT_KEYS')
    require(all(before[k] == after[k] for k in before if k != 'rows'), 'AUTHORITY_OR_CATALOG_CHANGED')
    require(subtract_owned_bags(before['rows'], before_owned)
            == subtract_owned_bags(after['rows'], after_owned), 'FOREIGN_ROW_CHANGED')


def load_j01():
    spec = importlib.util.spec_from_file_location('member_existing_root_j01', CALLER.with_name('j01-root-boundary.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RootMemberBoundary:
    def __init__(self, packet_path):
        self.j01 = load_j01()
        self.h = self.j01.load_helpers()
        self.packet_path = Path(packet_path)
        self.packet_raw = self.h.signed_private_read(self.packet_path)
        self.packet = self.h.signed_exact_json(self.packet_raw)
        p = self.packet
        fields = {'version', 'scenario', 'decisionId', 'head', 'preparedRoot', 'bindingPath', 'bindingSha256',
                  'provisionReceiptPath', 'provisionReceiptSha256', 'inputPath', 'inputSha256', 'privateRoot',
                  'nodePath', 'nodeSha256', 'callerSha256', 'j01CallerSha256'}
        require(type(p) is dict and set(p) == fields and type(p['version']) is int and p['version'] == 1
                and p['scenario'] == 'MEMBER_ROOT_BOUNDARY', 'REVIEWED_FIELDS')
        require(re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', p['decisionId']) is not None
                and re.fullmatch('[a-f0-9]{40}', p['head']) is not None, 'REVIEWED_IDENTITY')
        require(all(is_sha(p[k]) for k in ('bindingSha256', 'provisionReceiptSha256', 'inputSha256',
                                           'nodeSha256', 'callerSha256', 'j01CallerSha256')), 'REVIEWED_HASHES')
        self.root = Path(p['preparedRoot'])
        self.target = self.h.signed_prepared_target(self.root)
        self.binding_raw = self.h.signed_private_read(Path(p['bindingPath']))
        require(sha(self.binding_raw) == p['bindingSha256'], 'BINDING_BYTES')
        self.binding = self.h.validate_signed_binding(self.h.signed_exact_json(self.binding_raw), self.root, self.target)
        receipt_raw = self.h.signed_private_read(Path(p['provisionReceiptPath']))
        require(sha(receipt_raw) == p['provisionReceiptSha256'], 'PROVISION_RECEIPT_BYTES')
        receipt = self.h.signed_exact_json(receipt_raw)
        require(receipt.get('status') == 'PASS_LOCAL_AUTH6_PROVISION_ONLY' and receipt.get('accounts') == 6
                and receipt.get('bindingSha256') == p['bindingSha256']
                and receipt.get('actualGoTrueAndDatabaseSessions') is True and receipt.get('authAccountsRetained') is True,
                'ORIGINAL_SIX_RECEIPT')
        require(Path(receipt['creationReceiptRoot']) / 'receipt.json' == Path(p['provisionReceiptPath']), 'PROVISION_PATH')
        self.input_raw = self.h.signed_private_read(Path(p['inputPath']))
        require(sha(self.input_raw) == p['inputSha256'], 'INPUT_BYTES')
        self.input = self.h.signed_exact_json(self.input_raw)
        require(type(self.input) is dict and set(self.input) == {'version', 'scenario', 'repositoryRoot', 'codeRoot', 'head',
                'sourceFiles', 'migrationFiles', 'target', 'bindingSha256'} and type(self.input['version']) is int
                and self.input['version'] == 1 and self.input.get('head') == p['head'] and self.input.get('repositoryRoot') == str(REPO)
                and self.input.get('scenario') == 'MEMBER_CONNECTIONS_J07_J08_J09'
                and self.input.get('bindingSha256') == p['bindingSha256'] and self.input.get('target') is not None,
                'INPUT_BINDING')
        require(type(self.input['target']) is dict and set(self.input['target']) == {'dockerSocket', 'project', 'runId',
                'containers', 'origin', 'authIssuer', 'authAudience'}, 'TARGET_FIELDS')
        self.run_id = uid(self.input['target']['runId'])
        self.evidence = Path(p['privateRoot'])
        require(self.evidence.is_absolute() and self.evidence.resolve() == self.evidence
                and self.evidence.parent == self.root and self.evidence.name == 'member-' + self.run_id, 'EVIDENCE_NAMESPACE')
        self.node = Path(p['nodePath'])
        require(self.node.is_absolute() and self.node.resolve() == self.node and self.node.is_file()
                and sha(self.node.read_bytes()) == p['nodeSha256'], 'NODE_BINARY')
        reviewed = self.h.ReviewedSignedProvisioning(p['decisionId'], self.root, self.binding['sourcePins'],
                    self.binding['containers'], self.binding['credentials'], int(time.time()) + 600)
        self.ports = self.h.FixedLifecycleProvisioningPorts(reviewed)
        self.ports.origin = self.binding['origin']
        self.ports.runner.binding['sourcePins'] = self.binding['sourcePins']
        self.sequence = 0
        self.observations = []
        self.hashes = {}
        self.capsule_paths = None
        self.qualifications = {}
        self.fixture = None
        self.read_boundary = None
        self.ai_request = None
        self.feedback_id = None
        self.maintenance = None
        self.maintenance_completion = None
        self.maintenance_completion_receipt_sha = None
        self.maintenance_unclosed_observations = 0
        self.connection_closed = False
        self.connection_closure = 'UNVERIFIED'
        self.retirement = None
        self.control_overrides = {}
        self.internal_secret = secrets.token_urlsafe(36)
        self.ledger_id = 'member-' + self.run_id
        self.child = None
        self.seed_attempted = False
        self.maintenance_attempted = False
        self.retirement_attempted = False
        self.retirement_preparation_closed = False
        self.retirement_closed = False
        self.retirement_receipt_retained = False
        self.retirement_observation = None
        self.retirement_observation_receipt_sha = None
        self.retirement_functions = None
        self.retirement_function_owned = None
        self.source_check()

    save = lambda self, name, value: self.h.provisioning_json(self.evidence, name, value)

    def source_check(self):
        p = self.packet
        for path, expected in ((CALLER, p['callerSha256']), (CALLER.with_name('j01-root-boundary.py'), p['j01CallerSha256'])):
            require(sha(path.read_bytes()) == expected, 'CALLER_BYTES')
            actual = subprocess.run(['git', '-C', str(REPO), 'show', p['head'] + ':' + str(path.relative_to(REPO))],
                                    capture_output=True, timeout=10)
            require(actual.returncode == 0 and sha(actual.stdout) == expected, 'CALLER_NOT_COMMITTED')
        self.h.provisioning_source_check(self.binding['sourcePins'], p['head'])
        capsule = Path(self.input['codeRoot'])
        require(capsule.is_absolute() and capsule.resolve() == capsule, 'CAPSULE')
        for kind, files in (('source', self.input['sourceFiles']), ('migration', self.input['migrationFiles'])):
            require(type(files) is dict and files, 'MANIFEST')
            for relative, expected in files.items():
                require(type(relative) is str and re.fullmatch('[A-Za-z0-9_./-]+', relative) is not None
                        and '..' not in Path(relative).parts and not Path(relative).is_absolute() and is_sha(expected), 'PIN')
                require((relative == DRIVER or relative.startswith('backend/supabase/functions/') or relative.startswith('apps/mobile/src/'))
                        if kind == 'source' else relative.startswith('backend/supabase/migrations/') and relative.endswith('.sql'), 'PIN_SCOPE')
                current = REPO / relative
                require(current.resolve() == current and sha(current.read_bytes()) == expected, 'WORKTREE_PIN')
                if relative not in self.hashes:
                    result = subprocess.run(['git', '-C', str(REPO), 'show', p['head'] + ':' + relative], capture_output=True, timeout=10)
                    require(result.returncode == 0, 'COMMITTED_PIN')
                    self.hashes[relative] = sha(result.stdout)
                require(self.hashes[relative] == expected, 'HEAD_PIN')
                if kind == 'source':
                    copied = capsule / relative
                    require(copied.resolve() == copied and sha(copied.read_bytes()) == expected, 'CAPSULE_PIN')
        require({'backend/supabase/migrations/' + x.name for x in (REPO / 'backend/supabase/migrations').glob('*.sql')}
                == set(self.input['migrationFiles']), 'MIGRATION_SET')
        # 추가 실행 파일도 HEAD와 같아야 한다. capsule 안의 미핀 helper 교체를 거절한다.
        capsule_paths = []
        for copied in capsule.rglob('*'):
            require(not copied.is_symlink(), 'CAPSULE_SYMLINK')
            if copied.is_file() and copied.suffix in ('.js', '.mjs', '.cjs', '.ts', '.tsx', '.json'):
                relative = copied.relative_to(capsule).as_posix()
                if relative not in self.hashes:
                    result = subprocess.run(['git', '-C', str(REPO), 'show', p['head'] + ':' + relative], capture_output=True, timeout=10)
                    require(result.returncode == 0, 'CAPSULE_EXECUTABLE_NOT_COMMITTED')
                    self.hashes[relative] = sha(result.stdout)
                require(sha(copied.read_bytes()) == self.hashes[relative], 'CAPSULE_EXECUTABLE_BYTES')
                capsule_paths.append(relative)
        if self.capsule_paths is None:
            self.capsule_paths = sorted(capsule_paths)
        require(self.capsule_paths == sorted(capsule_paths), 'CAPSULE_EXECUTABLE_SET_CHANGED')
        for path, expected in ((self.packet_path, sha(self.packet_raw)), (Path(p['bindingPath']), p['bindingSha256']),
                               (Path(p['inputPath']), p['inputSha256']), (Path(p['provisionReceiptPath']), p['provisionReceiptSha256'])):
            require(sha(self.h.signed_private_read(path)) == expected, 'PRIVATE_INPUT_CHANGED')

    def live(self):
        self.source_check()
        self.ports.identity()
        require(self.ports.memory_kib() >= 786432, 'RESOURCE_LIMIT')
        self.h.signed_verify_history(self.ports.runner)
        controls = self.ports.closed_controls()
        require(controls.get('cronLaunchActiveJobs') == 'off' and all(
            controls.get(k) is self.control_overrides.get(k, False) for k in self.h.PROVISION_CLOSED_CONTROLS), 'CONTROL_SCOPE')
        target = self.input['target']
        require(target['dockerSocket'] == self.target['host'].removeprefix('unix://')
                and target['project'] == self.target['project'] and target['origin'] == self.binding['origin']
                and target['authIssuer'] == self.binding['jwtIssuer'] and target['authAudience'] == 'authenticated'
                and target['containers'] == self.binding['containers'], 'TARGET_BINDING')
        return {'target': target, 'bindingSha256': self.packet['bindingSha256'],
                'sourceFiles': self.input['sourceFiles'], 'migrationFiles': self.input['migrationFiles']}

    def read(self, statement):
        self.live()
        raw = self.ports.read_sql(statement, timeout=5)
        require(type(raw) is str, 'READ_TEXT_REQUIRED')
        if raw == 't':
            return True
        if raw == 'f':
            return False
        return self.h.signed_exact_json(raw)

    def mutate(self, name, statement, dispatch_state=None):
        self.live()
        self.save(name + '-intent.json', {'runId': self.run_id, 'sqlSha256': sha(statement.encode()), 'singleAttempt': True})
        # 실패 응답을 새 실행 허가로 바꾸지 않는다. 정확한 read/cleanup evidence만 후속 처리한다.
        if dispatch_state is not None:
            dispatch_state['dispatchState'] = 'SQL_ENTRY_UNKNOWN'
        self.ports.sql(statement)
        self.live()

    def prepare(self):
        self.live()
        require(not self.evidence.exists(), 'PREVIOUS_ATTEMPT_PRESERVED')
        self.evidence.mkdir(mode=0o700)
        self.save('intent.json', {'runId': self.run_id, 'head': self.packet['head'], 'packetSha256': sha(self.packet_raw),
            'bindingSha256': self.packet['bindingSha256'], 'authCreationReceiptSha256': self.packet['provisionReceiptSha256'],
            'callerSha256': self.packet['callerSha256'], 'actualNaver': False, 'realPhotoBytes': False,
            'retirementLastOriginalAccount': self.binding['accounts'][5]['userId']})
        self.outer_baseline = self.ports.snapshot()
        self.save('outer-baseline-private.json', self.outer_baseline)
        for account in self.binding['accounts']:
            self.live()
            status, body = self.ports.request('GET', '/user', token=account['accessToken'])
            require(status == 200 and body.get('id') == account['userId'] and body.get('role') == 'authenticated'
                    and body.get('is_anonymous') is not True and self.ports.session_proof(account), 'AUTH_SIX_ORIGINAL')
        self.save('auth-six-observed.json', {'users': [a['userId'] for a in self.binding['accounts']],
            'sessionIds': [a['sessionId'] for a in self.binding['accounts']], 'actualGoTrueSessions': True, 'authMutations': 0})
        self.baseline_bucket = self.read("select coalesce(jsonb_agg(to_jsonb(b)),'[]'::jsonb)from storage.buckets b where id='profile-images';")
        self.original_grants = self.read('select jsonb_build_object(' + ','.join(
            q(x) + ",exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid="
            + q(x) + "::regprocedure and a.grantee='service_role'::regrole and a.privilege_type='EXECUTE')"
            for x in MAINTENANCE_SIGNATURES) + ');')
        self.original_global = self.read("select to_jsonb(g)from private.global_worker_run g where singleton;")
        require(self.original_global['token'] is None and self.original_global['expires_at'] is None, 'GLOBAL_BUSY')
        self.original_controls = self.read('select jsonb_build_object(' + ','.join(
            q(k) + ',(select to_jsonb(c)from private.' + table + ' c where singleton)' for k, table in CONTROL_TABLES.items()) + ');')

    def control_cas(self, key, changes, opening):
        require(key in CONTROL_TABLES and type(changes) is dict and changes, 'FIXED_CONTROL')
        original = self.original_controls[key]
        require(set(changes) <= set(original) - {'singleton'}, 'CONTROL_COLUMNS')
        during = {**original, **changes}
        expected, replacement = (original, during) if opening else (during, original)
        sets = []
        for column in changes:
            value = replacement[column]
            scalar = 'null' if value is None else ('true' if value is True else 'false' if value is False else q(value))
            sets.append(column + '=' + scalar)
        return 'do $$declare n integer;begin update private.' + CONTROL_TABLES[key] + ' c set ' + ','.join(sets) + ' where singleton and to_jsonb(c)=' + q(json.dumps(expected)) + "::jsonb;get diagnostics n=row_count;if n<>1 then raise exception 'member_control_cas';end if;end;$$;"

    def qualify(self, index, photo):
        account = self.binding['accounts'][index]
        user = uid(account['userId'])
        require(index not in self.qualifications, 'QUALIFICATION_REPLAY')
        profile = self.read('select to_jsonb(p)from public.profiles p where id=' + q(user) + '::uuid;')
        episodes = self.read("select coalesce(jsonb_agg(to_jsonb(e)),'[]'::jsonb)from private.member_episodes e where profile_id=" + q(user) + '::uuid;')
        require(len(episodes) == 1 and episodes[0]['ended_at'] is None and episodes[0]['identity_id'] is None
                and profile['avatar_url'] is None, 'FRESH_MEMBER_SCOPE')
        absence = self.read("select not exists(select 1 from private.naver_accounts where user_id=" + q(user) + "::uuid)and not exists(select 1 from private.naver_sessions where user_id=" + q(user) + "::uuid)and not exists(select 1 from private.ai_chat_requests where user_id=" + q(user) + "::uuid)and not exists(select 1 from private.ai_member_processing where user_id=" + q(user) + "::uuid)and not exists(select 1 from private.member_retirements where profile_id=" + q(user) + "::uuid)and not exists(select 1 from private.review_summary_state where profile_id=" + q(user) + '::uuid);')
        require(absence is True, 'PREEXISTING_MEMBER_STATE_PRESERVED')
        subject = 'MEMBER-synthetic-' + self.run_id + '-' + str(index)
        object_id = str(uuid.uuid4())
        path = user + '/' + object_id + '.jpg'
        state = {'index': index, 'userId': user, 'subject': subject, 'identityId': None,
                 'episode': episodes[0], 'profile': profile, 'objectId': object_id, 'objectPath': path, 'photo': photo,
                 'dispatchState': 'NOT_SENT'}
        self.qualifications[index] = state
        self.save('qualification-' + str(index) + '-state-intent.json', state)
        statement = 'begin;'
        if photo:
            statement += "insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)values('profile-images','profile-images',false,2097152,array['image/jpeg'])on conflict(id)do nothing;"
        statement += "insert into private.naver_accounts(subject,user_id,real_name,birth_date,gender,verification_status,completed_at)values(" + q(subject) + ',' + q(user) + "::uuid,'합성 연결 검증회원','1990-01-01','female','qualified',clock_timestamp());"
        # INSERT trigger가 만든 실제 identity ID만 후속 읽기로 확인한다.
        statement += "insert into private.naver_sessions(session_id,user_id,subject)values(" + q(account['sessionId']) + '::uuid,' + q(user) + '::uuid,' + q(subject) + ');'
        if photo:
            statement += "insert into storage.objects(id,bucket_id,name,owner_id,metadata)values(" + q(object_id) + "::uuid,'profile-images'," + q(path) + ',' + q(user) + ",'" + '{"mimetype":"image/jpeg","size":128}' + "'::jsonb);update public.profiles set avatar_url=" + q(path) + ' where id=' + q(user) + '::uuid;'
        self.mutate('qualification-' + str(index), statement + 'commit;', state)
        current = self.read("select jsonb_build_object('identityId',k.id,'keySha256'," + row_sha_sql('k') + ",'accountSha256'," + row_sha_sql('a') + ",'profileSha256'," + row_sha_sql('p') + ",'episodeSha256'," + row_sha_sql('e') + ",'sessionSha256',(select " + row_sha_sql('s') + ' from private.naver_sessions s where session_id=' + q(account['sessionId']) + "::uuid and user_id=p.id and subject=a.subject),'objectSha256',(select " + row_sha_sql('o') + ' from storage.objects o where id=' + q(object_id) + '::uuid))from private.naver_accounts a join private.naver_identity_keys k on k.subject=a.subject join public.profiles p on p.id=a.user_id join private.member_episodes e on e.profile_id=p.id and e.ended_at is null where a.subject=' + q(subject) + ';')
        require(current and uid(current['identityId']) == current['identityId'], 'QUALIFICATION_LINK')
        state.update(current)
        self.save('qualification-' + str(index) + '-owned.json', state)
        return state

    def prepare_conversation(self, users):
        require(users == [a['userId'] for a in self.binding['accounts'][:2]] and not self.seed_attempted, 'CONVERSATION_MEMBERS')
        self.seed_attempted = True
        self.qualify(0, True)
        self.qualify(1, True)
        post, request = str(uuid.uuid4()), str(uuid.uuid4())
        messages = [str(uuid.uuid4()) for _ in range(3)]
        self.fixture = {'postId': post, 'requestId': request, 'messageIds': messages}
        self.save('conversation-intent.json', self.fixture)
        a, b = users
        statement = "begin;insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,cost_type,amount)values(" + q(post) + '::uuid,' + q(a) + "::uuid,'합성 연결 검증','합성 연결 검사','산책',clock_timestamp()+interval'3 days',clock_timestamp()+interval'3 days 2 hours',clock_timestamp()+interval'2 days','서울특별시 강남구 역삼동','free',0);insert into public.join_requests(id,post_id,requester_id,message)values(" + q(request) + '::uuid,' + q(post) + '::uuid,' + q(b) + "::uuid,'합성 첫 메시지를 전송합니다.');"
        for i in range(2):
            statement += 'insert into public.chat_messages(id,join_request_id,sender_id,content,created_at)values(' + q(messages[i]) + '::uuid,' + q(request) + '::uuid,' + q(b) + "::uuid,'합성 기존 메시지',clock_timestamp()+interval'" + str(i) + " milliseconds');"
        statement += 'insert into private.ai_member_processing(user_id,exploration_allowed)values(' + q(a) + '::uuid,true);commit;'
        self.mutate('conversation-seed', statement)
        require(self.read('select count(*)=2 from public.chat_messages where join_request_id=' + q(request) + '::uuid;'), 'CONVERSATION_SEED_COUNT')
        self.save('conversation-owned.json', self.fixture)
        return {'requestId': request, 'messageIds': messages}

    def inspect_conversation(self, request):
        require(self.fixture and request == self.fixture['requestId'], 'OWNED_CONVERSATION')
        return self.read("select jsonb_build_object('messages',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'rowSha256'," + row_sha_sql('m') + ")order by m.id),'[]'::jsonb)from public.chat_messages m where m.join_request_id=" + q(request) + "::uuid),'reads',(select coalesce(jsonb_agg(jsonb_build_object('userId',r.user_id,'messageId',r.message_id,'readAt',r.read_at)order by r.user_id,r.message_id),'[]'::jsonb)from private.conversation_message_reads r where r.request_id=" + q(request) + '::uuid));')

    def read_boundary_statement(self, request):
        state = self.read_boundary
        require(state is not None and self.fixture and request == self.fixture['requestId'], 'READ_BOUNDARY_OWNED')
        rooms = ','.join(q(x) + '::uuid' for x in (request, state['foreignRequestId']))
        posts = ','.join(q(x) + '::uuid' for x in (self.fixture['postId'], state['foreignPostId']))
        account = self.binding['accounts'][0]
        queries = {
            'posts': ('public.posts', 'r.id in(' + posts + ')'),
            'requests': ('public.join_requests', 'r.id in(' + rooms + ')or r.post_id in(' + posts + ')'),
            'messages': ('public.chat_messages', 'r.join_request_id in(' + rooms + ')'),
            'reads': ('private.conversation_message_reads', 'r.request_id in(' + rooms + ')'),
            'visibility': ('private.conversation_visibility', 'r.request_id in(' + rooms + ')'),
            'hidden': ('private.member_hidden_targets', 'r.id=' + q(state['hiddenId']) + '::uuid or(r.identity_id='
                + q(self.qualifications[0]['identityId']) + "::uuid and r.target_type='chat'and r.target_id="
                + q(state['hiddenMessageId']) + '::uuid)'),
            'session': ('private.naver_sessions', 'r.session_id=' + q(account['sessionId']) + '::uuid or r.user_id='
                + q(account['userId']) + '::uuid'),
        }
        terms = [q(k) + ",(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(r),'rowSha256',"
            + row_sha_sql('r') + ")order by to_jsonb(r)::text),'[]'::jsonb)from " + table + ' r where ' + predicate + ')'
            for k, (table, predicate) in queries.items()]
        derived = []
        ids = {'posts': posts, 'requests': rooms,
               'messages': ','.join(q(x) + '::uuid' for x in [*state['messageIds'], state['foreignMessageId']])}
        for meta in state['references']:
            derived.append("jsonb_build_object('table'," + q(meta['schema'] + '.' + meta['table'])
                + ",'column'," + q(meta['column']) + ",'parent'," + q(meta['parent'])
                + ",'rows',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(r),'rowSha256',"
                + row_sha_sql('r') + ")order by to_jsonb(r)::text),'[]'::jsonb)from " + meta['schema'] + '.'
                + meta['table'] + ' r where r.' + meta['column'] + ' in(' + ids[meta['parent']] + ')))')
        terms.append("'derived',jsonb_build_array(" + ','.join(derived) + ')')
        descendants = []
        for child in state['descendantReferences']:
            parents = [x for x in state['references'] if x['schema'] == child['parentSchema'] and x['table'] == child['parentTable']]
            joins = ' and '.join('c.' + local + '=r.' + remote
                for local, remote in zip(child['childColumns'], child['parentColumns']))
            scoped = ' or '.join('r.' + meta['column'] + ' in(' + ids[meta['parent']] + ')' for meta in parents)
            if not parents:
                leaf = [predicate for table, predicate in queries.values()
                        if table == child['parentSchema'] + '.' + child['parentTable']]
                require(len(leaf) == 1, 'READ_BOUNDARY_DESCENDANT_PARENT')
                scoped = leaf[0]
            descendants.append('not exists(select 1 from ' + child['schema'] + '.' + child['table'] + ' c join '
                + child['parentSchema'] + '.' + child['parentTable'] + ' r on ' + joins + ' where ' + scoped + ')')
        terms.append("'descendantsAbsent',(" + (' and '.join(descendants) if descendants else 'true') + ')')
        return 'select jsonb_build_object(' + ','.join(terms) + ');'

    def read_boundary_scope(self, request):
        value = self.read(self.read_boundary_statement(request))
        require(type(value) is dict and set(value) == {'posts', 'requests', 'messages', 'reads', 'visibility',
            'hidden', 'session', 'derived', 'descendantsAbsent'}, 'READ_BOUNDARY_NATIVE_FIELDS')
        require(value['descendantsAbsent'] is True, 'READ_BOUNDARY_DESCENDANT_UNKNOWN_PRESERVED')
        arrays = [value[k] for k in value if k not in ('derived', 'descendantsAbsent')]
        require(type(value['derived']) is list and len(value['derived']) == len(self.read_boundary['references']),
                'READ_BOUNDARY_DERIVED_FIELDS')
        for meta, item in zip(self.read_boundary['references'], value['derived']):
            require(type(item) is dict and set(item) == {'table', 'column', 'parent', 'rows'}
                and item['table'] == meta['schema'] + '.' + meta['table'] and item['column'] == meta['column']
                and item['parent'] == meta['parent'], 'READ_BOUNDARY_DERIVED_SCOPE')
            arrays.append(item['rows'])
        for rows in arrays:
            require(type(rows) is list and all(type(x) is dict and set(x) == {'row', 'rowSha256'}
                and type(x['row']) is dict and is_sha(x['rowSha256']) for x in rows), 'READ_BOUNDARY_NATIVE_ROWS')
        return value

    def validate_read_boundary_scope(self, value, seeded=True):
        state = self.read_boundary
        users = {a['userId'] for a in self.binding['accounts'][:2]}
        request = self.fixture['requestId']
        main_ids = set(state['messageIds'])
        all_ids = main_ids | {state['foreignMessageId']}
        rooms = {request, state['foreignRequestId']}
        require(value.get('descendantsAbsent') is True, 'READ_BOUNDARY_DESCENDANT_UNKNOWN_PRESERVED')
        for table, ids in (('posts', {self.fixture['postId'], state['foreignPostId']}),
                           ('requests', rooms), ('messages', all_ids)):
            rows = value[table]
            require(len(rows) == len(ids) and {x['row'].get('id') for x in rows} == ids,
                    'READ_BOUNDARY_GRAPH_IDS')
            if seeded:
                require(sorted(x['rowSha256'] for x in rows) == state['graph'][table], 'READ_BOUNDARY_GRAPH_CHANGED')
        for item in value['posts']:
            require(item['row'].get('author_id') == self.binding['accounts'][0]['userId'], 'READ_BOUNDARY_POST_OWNER')
        for item in value['requests']:
            row = item['row']
            expected_post = self.fixture['postId'] if row['id'] == request else state['foreignPostId']
            require(row.get('post_id') == expected_post and row.get('requester_id') == self.binding['accounts'][1]['userId'],
                    'READ_BOUNDARY_REQUEST_OWNER')
        for item in value['messages']:
            row = item['row']
            require(row.get('join_request_id') == (request if row['id'] in main_ids else state['foreignRequestId'])
                and row.get('sender_id') in users, 'READ_BOUNDARY_MESSAGE_OWNER')
        if seeded:
            require(value['derived'] == state['graph']['derived'], 'READ_BOUNDARY_DERIVED_CHANGED')
        read_keys = []
        for item in value['reads']:
            row = item['row']
            require(row.get('user_id') in users and row.get('message_id') in all_ids and row.get('request_id') ==
                (request if row['message_id'] in main_ids else state['foreignRequestId'])
                and type(row.get('read_at')) is str and row['read_at'], 'READ_BOUNDARY_READ_OWNER')
            read_keys.append((row['user_id'], row['message_id']))
        require(len(read_keys) == len(set(read_keys)), 'READ_BOUNDARY_DUPLICATE_READ')
        require(len(value['hidden']) <= 1 and all(x['row'] == {'id': state['hiddenId'],
            'identity_id': self.qualifications[0]['identityId'], 'target_type': 'chat',
            'target_id': state['hiddenMessageId']} for x in value['hidden']), 'READ_BOUNDARY_HIDDEN_CONFLICT')
        require(len(value['visibility']) <= 1 and all(x['row'].get('user_id') == self.binding['accounts'][0]['userId']
            and x['row'].get('request_id') == request and type(x['row'].get('hidden_at')) is str
            for x in value['visibility']), 'READ_BOUNDARY_VISIBILITY_CONFLICT')
        require(len(value['session']) <= 1 and all(x == state['originalSession'] for x in value['session']),
                'READ_BOUNDARY_SESSION_CONFLICT')

    def inspect_read_boundary(self, request):
        state = self.read_boundary
        require(state is not None and state['phase'] == 'prepared', 'READ_BOUNDARY_NOT_PREPARED')
        value = self.read_boundary_scope(request)
        self.validate_read_boundary_scope(value)
        reads = [{'userId': x['row']['user_id'], 'requestId': x['row']['request_id'],
                  'messageId': x['row']['message_id'], 'readAt': x['row']['read_at'], 'rowSha256': x['rowSha256']}
                 for x in value['reads']]
        hidden = [{'id': x['row']['id'], 'rowSha256': x['rowSha256']} for x in value['hidden']]
        visibility = [{'userId': x['row']['user_id'], 'requestId': x['row']['request_id'], 'rowSha256': x['rowSha256']}
                      for x in value['visibility']]
        return {'requestId': request, 'scopeRowsSha256': digest(value),
                'reads': sorted(reads, key=lambda x: (x['userId'], x['requestId'], x['messageId'])),
                'hidden': sorted(hidden, key=lambda x: x['id']),
                'visibility': sorted(visibility, key=lambda x: (x['userId'], x['requestId'])),
                'sessionBindingRestored': value['session'] == [state['originalSession']]}

    def prepare_read_boundary(self, request):
        require(self.fixture and request == self.fixture['requestId'] and self.read_boundary is None
            and set(self.qualifications) >= {0, 1}, 'READ_BOUNDARY_PREPARATION_SCOPE')
        prior = self.inspect_conversation(request)
        require(len(prior['messages']) == 3 and {m['id'] for m in prior['messages']} == set(self.fixture['messageIds']),
                'READ_BOUNDARY_ORIGINAL_THREE')
        account = self.binding['accounts'][0]
        sessions = self.read("select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(s),'rowSha256',"
            + row_sha_sql('s') + ")),'[]'::jsonb)from private.naver_sessions s where user_id="
            + q(account['userId']) + '::uuid or session_id=' + q(account['sessionId']) + '::uuid;')
        require(type(sessions) is list and len(sessions) == 1 and set(sessions[0]) == {'row', 'rowSha256'}
            and sessions[0]['rowSha256'] == self.qualifications[0]['sessionSha256']
            and type(sessions[0]['row']) is dict and set(sessions[0]['row']) == {'session_id', 'user_id', 'subject', 'registered_at'}
            and sessions[0]['row']['session_id'] == account['sessionId'] and sessions[0]['row']['user_id'] == account['userId']
            and sessions[0]['row']['subject'] == self.qualifications[0]['subject'], 'READ_BOUNDARY_ORIGINAL_SESSION')
        references = self.read("select coalesce(jsonb_agg(distinct jsonb_build_object('schema',ns.nspname,'table',t.relname,"
            "'column',a.attname,'parent',case c.confrelid when 'public.posts'::regclass then 'posts'when 'public.join_requests'::regclass "
            "then 'requests'else 'messages'end)),'[]'::jsonb)from pg_constraint c join pg_class t on t.oid=c.conrelid "
            "join pg_namespace ns on ns.oid=t.relnamespace cross join lateral unnest(c.conkey,c.confkey)keys(local_key,parent_key) "
            "join pg_attribute a on a.attrelid=c.conrelid and a.attnum=keys.local_key join pg_attribute pa on pa.attrelid=c.confrelid "
            "and pa.attnum=keys.parent_key where c.contype='f'and c.confrelid in('public.posts'::regclass,'public.join_requests'::regclass,"
            "'public.chat_messages'::regclass)and pa.attname='id'and c.conrelid not in('public.posts'::regclass,'public.join_requests'::regclass,"
            "'public.chat_messages'::regclass,'private.conversation_message_reads'::regclass,'private.conversation_visibility'::regclass);")
        require(type(references) is list and all(type(x) is dict and set(x) == {'schema', 'table', 'column', 'parent'}
            and x['schema'] in ('public', 'private') and x['parent'] in ('posts', 'requests', 'messages')
            and all(type(x[k]) is str and re.fullmatch('[a-z][a-z0-9_]*', x[k]) for k in ('table', 'column'))
            for x in references), 'READ_BOUNDARY_REFERENCE_CATALOG')
        references.sort(key=lambda x: (x['schema'], x['table'], x['column'], x['parent']))
        descendant_references = []
        tables = sorted({x['schema'] + '.' + x['table'] for x in references}
            | {'private.conversation_message_reads', 'private.conversation_visibility',
               'private.member_hidden_targets', 'private.naver_sessions'})
        if tables:
            descendant_references = self.read("select coalesce(jsonb_agg(jsonb_build_object('schema',ns.nspname,'table',t.relname,"
                "'parentSchema',pns.nspname,'parentTable',pt.relname,'childColumns',(select jsonb_agg(a.attname order by k.n)from "
                "unnest(c.conkey)with ordinality k(att,n)join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.att),"
                "'parentColumns',(select jsonb_agg(a.attname order by k.n)from unnest(c.confkey)with ordinality k(att,n)join pg_attribute a "
                "on a.attrelid=c.confrelid and a.attnum=k.att))),'[]'::jsonb)from pg_constraint c join pg_class t on t.oid=c.conrelid "
                "join pg_namespace ns on ns.oid=t.relnamespace join pg_class pt on pt.oid=c.confrelid join pg_namespace pns on pns.oid=pt.relnamespace "
                "where c.contype='f'and c.confrelid in(" + ','.join(q(t) + '::regclass' for t in tables) + ');')
            require(type(descendant_references) is list and all(type(x) is dict
                and set(x) == {'schema', 'table', 'parentSchema', 'parentTable', 'childColumns', 'parentColumns'}
                and x['schema'] in ('public', 'private') and x['parentSchema'] in ('public', 'private')
                and x['parentSchema'] + '.' + x['parentTable'] in tables
                and all(type(x[k]) is str and re.fullmatch('[a-z][a-z0-9_]*', x[k]) for k in ('table', 'parentTable'))
                and type(x['childColumns']) is list and type(x['parentColumns']) is list
                and len(x['childColumns']) == len(x['parentColumns']) and len(x['childColumns']) > 0
                and all(type(c) is str and re.fullmatch('[a-z][a-z0-9_]*', c) for c in x['childColumns'] + x['parentColumns'])
                for x in descendant_references), 'READ_BOUNDARY_DESCENDANT_CATALOG')
            descendant_references.sort(key=lambda x: canonical(x))
        state = {'messageIds': [*self.fixture['messageIds'], *[str(uuid.uuid4()) for _ in range(97)]],
                 'foreignPostId': str(uuid.uuid4()), 'foreignRequestId': str(uuid.uuid4()),
                 'foreignMessageId': str(uuid.uuid4()), 'hiddenId': str(uuid.uuid4()),
                 'originalSession': sessions[0], 'references': references, 'descendantReferences': descendant_references,
                 'phase': 'preparing', 'stage': 'initial', 'dispatchState': 'NOT_SENT'}
        state['hiddenMessageId'] = state['messageIds'][-1]
        self.read_boundary = state
        self.save('read-boundary-state-intent.json', state)
        new_ids = [state['foreignMessageId'], *state['messageIds'][3:]]
        absent = self.read('select not exists(select 1 from public.posts where id=' + q(state['foreignPostId'])
            + '::uuid)and not exists(select 1 from public.join_requests where id=' + q(state['foreignRequestId'])
            + '::uuid)and not exists(select 1 from public.chat_messages where id in('
            + ','.join(q(x) + '::uuid' for x in new_ids) + '))and not exists(select 1 from private.member_hidden_targets where id='
            + q(state['hiddenId']) + '::uuid);')
        require(absent is True, 'READ_BOUNDARY_NEW_IDS_CONFLICT')
        a, b = [x['userId'] for x in self.binding['accounts'][:2]]
        statement = "begin;insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,cost_type,amount)values("
        statement += q(state['foreignPostId']) + '::uuid,' + q(a) + "::uuid,'합성 별도 방','합성 경계 검사','산책',clock_timestamp()+interval'3 days',clock_timestamp()+interval'3 days 2 hours',clock_timestamp()+interval'2 days','서울특별시 강남구 역삼동','free',0);"
        statement += 'insert into public.join_requests(id,post_id,requester_id,message)values(' + q(state['foreignRequestId']) + '::uuid,' + q(state['foreignPostId']) + '::uuid,' + q(b) + "::uuid,'합성 별도 방 첫 메시지');"
        for i, message in enumerate(new_ids):
            room = state['foreignRequestId'] if message == state['foreignMessageId'] else request
            statement += 'insert into public.chat_messages(id,join_request_id,sender_id,content,created_at)values(' + q(message) + '::uuid,' + q(room) + '::uuid,' + q(b) + "::uuid,'합성 추가 메시지',clock_timestamp()+interval'" + str(i + 3) + " milliseconds');"
        self.mutate('read-boundary-seed', statement + 'commit;', state)
        value = self.read_boundary_scope(request)
        self.validate_read_boundary_scope(value, seeded=False)
        require(all(any(x['row']['id'] == old['id'] and x['rowSha256'] == old['rowSha256']
            for x in value['messages']) for old in prior['messages']), 'READ_BOUNDARY_PRIOR_MESSAGES_CHANGED')
        state['graph'] = {k: sorted(x['rowSha256'] for x in value[k]) for k in ('posts', 'requests', 'messages')}
        state['graph']['derived'] = value['derived']
        state['phase'] = 'prepared'
        self.save('read-boundary-owned.json', state)
        return {'requestId': request, 'messageIds': state['messageIds'], 'foreignRequestId': state['foreignRequestId'],
                'foreignMessageId': state['foreignMessageId'], 'hiddenMessageId': state['hiddenMessageId']}

    def restore_read_boundary_sql(self, value):
        state = self.read_boundary
        self.validate_read_boundary_scope(value)
        sql = ''
        if not value['session']:
            account = self.binding['accounts'][0]
            self.live()
            require(self.ports.session_proof(account) is True, 'READ_BOUNDARY_PARENT_SESSION')
            row = state['originalSession']['row']
            sql += 'if exists(select 1 from private.naver_sessions where session_id=' + q(row['session_id'])
            sql += '::uuid or user_id=' + q(row['user_id']) + "::uuid)then raise exception 'member_read_session_conflict';end if;"
            sql += 'perform 1 from auth.sessions where id=' + q(row['session_id']) + '::uuid and user_id=' + q(row['user_id'])
            sql += "::uuid and(not_after is null or not_after>clock_timestamp())for share;if not found then raise exception 'member_read_parent_session';end if;"
            sql += 'insert into private.naver_sessions select *from jsonb_populate_record(null::private.naver_sessions,'
            sql += q(json.dumps(row)) + '::jsonb);'
        for item in value['hidden']:
            sql += 'delete from private.member_hidden_targets h where id=' + q(item['row']['id']) + '::uuid and '
            sql += row_sha_sql('h') + '=' + q(item['rowSha256'])
            sql += ";get diagnostics n=row_count;if n<>1 then raise exception 'member_read_hidden_cas';end if;"
        return sql

    def set_read_boundary(self, request, stage):
        require(type(stage) is str and stage in ('hidden', 'revoked', 'restored'), 'READ_BOUNDARY_STAGE')
        state = self.read_boundary
        require(state is not None and state['phase'] == 'prepared' and self.fixture['requestId'] == request,
                'READ_BOUNDARY_OWNED')
        require(state['stage'] == {'hidden': 'initial', 'revoked': 'hidden', 'restored': 'revoked'}[stage],
                'READ_BOUNDARY_STAGE_ORDER')
        value = self.read_boundary_scope(request)
        self.validate_read_boundary_scope(value)
        if stage == 'hidden':
            require(not value['hidden'] and value['session'] == [state['originalSession']], 'READ_BOUNDARY_HIDE_PRECONDITION')
            sql = 'insert into private.member_hidden_targets(id,identity_id,target_type,target_id)values('
            sql += q(state['hiddenId']) + '::uuid,' + q(self.qualifications[0]['identityId']) + "::uuid,'chat'," + q(state['hiddenMessageId']) + '::uuid);'
        elif stage == 'revoked':
            require(len(value['hidden']) == 1 and value['session'] == [state['originalSession']], 'READ_BOUNDARY_REVOKE_PRECONDITION')
            sql = 'delete from private.naver_sessions s where session_id=' + q(self.binding['accounts'][0]['sessionId'])
            sql += '::uuid and ' + row_sha_sql('s') + '=' + q(state['originalSession']['rowSha256'])
            sql += ";get diagnostics n=row_count;if n<>1 then raise exception 'member_read_session_cas';end if;"
        else:
            require(len(value['hidden']) == 1 and not value['session'], 'READ_BOUNDARY_RESTORE_PRECONDITION')
            sql = self.restore_read_boundary_sql(value)
        state['stage'] = stage + '_unknown'
        self.mutate('read-boundary-' + stage, 'begin;do $$declare n integer;begin ' + sql + 'end;$$;commit;', state)
        observed = self.inspect_read_boundary(request)
        require(observed['sessionBindingRestored'] is (stage != 'revoked')
            and len(observed['hidden']) == (0 if stage == 'restored' else 1), 'READ_BOUNDARY_STAGE_EFFECT')
        state['stage'] = stage
        self.save('read-boundary-' + stage + '-observed.json', observed)
        return observed

    def cleanup_read_boundary(self):
        state = self.read_boundary
        if state is None:
            return
        require(state['phase'] == 'prepared', 'READ_BOUNDARY_UNKNOWN_PRESERVED')
        request = self.fixture['requestId']
        value = self.read_boundary_scope(request)
        self.validate_read_boundary_scope(value)
        restoration = self.restore_read_boundary_sql(value)
        # parent→child 원래 FK 잠금 순서. 전부 잠근 후 native scope 전체 JSON을 다시 비교한다.
        sql = 'begin;do $$declare n integer;begin '
        account = self.binding['accounts'][0]
        sql += 'perform 1 from auth.sessions where id=' + q(account['sessionId']) + '::uuid and user_id='
        sql += q(account['userId']) + "::uuid and(not_after is null or not_after>clock_timestamp())for share;"
        sql += "if not found then raise exception 'member_read_parent_session';end if;"
        for key, table in (('posts', 'public.posts'), ('requests', 'public.join_requests'), ('messages', 'public.chat_messages')):
            for item in sorted(value[key], key=lambda x: x['row']['id']):
                sql += 'perform 1 from ' + table + ' r where id=' + q(item['row']['id']) + '::uuid and '
                sql += row_sha_sql('r') + '=' + q(item['rowSha256'])
                sql += " for update;if not found then raise exception 'member_read_graph_cas';end if;"
        child_rows = [(table, item) for key, table in (('reads', 'private.conversation_message_reads'),
                      ('visibility', 'private.conversation_visibility'), ('hidden', 'private.member_hidden_targets'),
                      ('session', 'private.naver_sessions')) for item in value[key]]
        child_rows += [(d['table'], item) for d in value['derived'] for item in d['rows']]
        for table, item in child_rows:
            sql += 'perform 1 from ' + table + ' r where to_jsonb(r)=' + q(json.dumps(item['row']))
            sql += '::jsonb and ' + row_sha_sql('r') + '=' + q(item['rowSha256'])
            sql += " for update;if not found then raise exception 'member_read_child_cas';end if;"
        native = self.read_boundary_statement(request).removeprefix('select ').removesuffix(';')
        sql += 'if (' + native + ')is distinct from ' + q(json.dumps(value))
        sql += "::jsonb then raise exception 'member_read_scope_cas';end if;"
        sql += restoration
        for item in value['visibility']:
            row = item['row']
            sql += 'delete from private.conversation_visibility r where user_id=' + q(row['user_id'])
            sql += '::uuid and request_id=' + q(row['request_id']) + '::uuid and ' + row_sha_sql('r') + '=' + q(item['rowSha256'])
            sql += ";get diagnostics n=row_count;if n<>1 then raise exception 'member_read_visibility_cas';end if;"
        for item in value['reads']:
            row = item['row']
            sql += 'delete from private.conversation_message_reads r where user_id=' + q(row['user_id'])
            sql += '::uuid and request_id=' + q(row['request_id']) + '::uuid and message_id=' + q(row['message_id'])
            sql += '::uuid and ' + row_sha_sql('r') + '=' + q(item['rowSha256'])
            sql += ";get diagnostics n=row_count;if n<>1 then raise exception 'member_read_receipt_cas';end if;"
        for item in value['posts']:
            sql += 'delete from public.posts r where id=' + q(item['row']['id']) + '::uuid and '
            sql += row_sha_sql('r') + '=' + q(item['rowSha256'])
            sql += ";get diagnostics n=row_count;if n<>1 then raise exception 'member_read_post_cas';end if;"
        sql += 'end;$$;commit;'
        state['phase'] = 'cleanup_unknown'
        self.mutate('read-boundary-cleanup', sql, state)
        state['phase'] = 'cleaned'
        self.save('read-boundary-cleaned.json', {'mainRequestId': request, 'foreignRequestId': state['foreignRequestId'],
            'nativeScopeComparedUnderLocks': True, 'originalSessionRestored': True, 'wholeBaselineStillRequired': True})

    def inspect_ai(self, user, request):
        require(user == self.binding['accounts'][0]['userId'], 'AI_OWNED_USER')
        uid(request)
        require(self.ai_request is None or self.ai_request == request, 'AI_OWNED_REQUEST')
        client_hash = hashlib.sha256(('member-' + self.run_id).encode()).hexdigest()
        result = self.read("select jsonb_build_object('requestOwned',exists(select 1 from private.ai_chat_requests where user_id=" + q(user) + '::uuid and request_id=' + q(request) + "::uuid and client_request_hash=" + q(client_hash) + "),'resultReceiptCount',(select count(*)from private.ai_result_receipts where user_id=" + q(user) + '::uuid and request_id=' + q(request) + '::uuid));')
        require(result['requestOwned'] is True, 'AI_REQUEST_LINEAGE')
        self.ai_request = request
        self.save('ai-request-owned.json', {'userId': user, 'requestId': request, 'clientHash': client_hash})
        return result

    def prepare_retention(self, user, request, feedback):
        require(user == self.binding['accounts'][0]['userId'] and request == self.ai_request and not self.maintenance_attempted, 'RETENTION_LINEAGE')
        uid(feedback)
        owned = self.read("select count(*)=1 from private.ai_feedback_receipts where user_id=" + q(user) + '::uuid and request_id=' + q(request) + '::uuid and feedback_id=' + q(feedback) + "::uuid and action='helpful'and client_hash=" + q(hashlib.sha256(('helpful-' + self.run_id).encode()).hexdigest()) + ';')
        require(owned is True, 'OWNED_HELPFUL')
        self.maintenance_attempted = True
        self.feedback_id = feedback
        self.maintenance = {'globalToken': str(uuid.uuid4()), 'maintenanceRequest': str(uuid.uuid4())}
        self.save('maintenance-owned.json', {**self.maintenance, 'userId': user, 'requestId': request, 'feedbackId': feedback})
        statement = 'begin;' + self.control_cas('atomic', {'enabled': True}, True) + self.control_cas('feedback', {'enabled': True}, True)
        statement += "do $$declare n integer;begin update private.global_worker_run g set token=" + q(self.maintenance['globalToken']) + "::uuid,expires_at=clock_timestamp()+interval'180 seconds'where singleton and to_jsonb(g)=" + q(json.dumps(self.original_global)) + "::jsonb;get diagnostics n=row_count;if n<>1 then raise exception 'member_global_cas';end if;end;$$;"
        statement += 'grant execute on function ' + ','.join(MAINTENANCE_SIGNATURES) + ' to service_role;'
        statement += "update private.ai_feedback_receipts set accepted_at=clock_timestamp()-interval'91 days'where feedback_id=" + q(feedback) + '::uuid and user_id=' + q(user) + "::uuid and action='helpful';update private.ai_result_receipts set available_at=clock_timestamp()-interval'91 days'where request_id=" + q(request) + '::uuid and user_id=' + q(user) + "::uuid;notify pgrst,'reload schema';commit;"
        # live 검사 이전에는 아직 닫힌 값이다. 변경 intent를 먼저 기록하고 한 번만 전송한다.
        self.live()
        self.save('maintenance-enable-intent.json', {'sqlSha256': sha(statement.encode()), **self.maintenance})
        self.ports.sql(statement)
        self.control_overrides.update(worker_runtime_atomic_control=True, ai_feedback_maintenance_control=True)
        self.live()
        return self.maintenance

    def inspect_maintenance(self, request):
        require(self.maintenance and request == self.maintenance['maintenanceRequest'], 'OWNED_MAINTENANCE')
        try:
            value = self.read("select jsonb_build_object('requestId',request_id,'globalToken',global_token,'operation',operation,'state',state,'input',input,'result',result,'deletedCount',result->'deletedCount','closedAt',closed_at,'purgedAt',purged_at,'fingerprintMatches',fingerprint=encode(extensions.digest(jsonb_build_array('helpful_maintenance'," + q(self.maintenance['globalToken']) + "::uuid,1)::text,'sha256'),'hex'),'rowSha256'," + row_sha_sql('r') + ')from private.worker_runtime_results r where request_id=' + q(request) + '::uuid;')
            require(type(value) is dict and value.get('requestId') == request
                and value.get('globalToken') == self.maintenance['globalToken']
                and value.get('operation') == 'helpful_maintenance' and value.get('state') == 'completed'
                and value.get('input') == {'limit': 1} and value.get('result') == {'deletedCount': 1}
                and type(value['input']['limit']) is int
                and type(value.get('deletedCount')) is int and value['deletedCount'] == 1
                and value.get('closedAt') is not None and value.get('purgedAt') is None
                and value.get('fingerprintMatches') is True and is_sha(value.get('rowSha256')),
                'MAINTENANCE_COMPLETION_UNVERIFIED')
            require(self.maintenance_completion is None or value == self.maintenance_completion,
                'MAINTENANCE_COMPLETION_CHANGED')
            if self.maintenance_completion is None:
                proof = json.loads(json.dumps(value))
                receipt_sha = self.save('maintenance-completed-read-proof.json', proof)
                raw = self.h.signed_private_read(self.evidence / 'maintenance-completed-read-proof.json')
                require(is_sha(receipt_sha) and sha(raw) == receipt_sha
                    and self.h.signed_exact_json(raw) == proof, 'MAINTENANCE_RECEIPT_BYTES')
                self.maintenance_completion = proof
                self.maintenance_completion_receipt_sha = receipt_sha
            else:
                raw = self.h.signed_private_read(self.evidence / 'maintenance-completed-read-proof.json')
                require(is_sha(self.maintenance_completion_receipt_sha)
                    and sha(raw) == self.maintenance_completion_receipt_sha
                    and self.h.signed_exact_json(raw) == self.maintenance_completion, 'MAINTENANCE_RECEIPT_BYTES')
            return value
        except Exception as error:
            self.connection_closed = False
            self.connection_closure = 'UNVERIFIED'
            self.maintenance_unclosed_observations += 1
            self.save('maintenance-unclosed-' + str(self.maintenance_unclosed_observations) + '.json', {'requestId': request,
                'failureCode': safe_code(error, self.j01), 'closure': 'UNVERIFIED',
                'wholeBaselineRestored': False, 'dispatchState': 'UNKNOWN',
                'workerResultPreserved': True, 'globalAndControlsPreserved': True,
                'absentIsNotProofOfNoDispatch': True, 'retirementBlocked': True})
            raise

    def completed_maintenance_delete(self):
        proof = self.maintenance_completion
        require(type(proof) is dict and proof.get('requestId') == self.maintenance['maintenanceRequest']
            and proof.get('globalToken') == self.maintenance['globalToken'] and proof.get('state') == 'completed'
            and proof.get('operation') == 'helpful_maintenance' and is_sha(proof.get('rowSha256')),
            'MAINTENANCE_READ_PROOF_REQUIRED')
        # 이 DELETE가 먼저 실패하면 아래 fixture/global/guard 정리까지 모두 같은 tx에서 rollback한다.
        return 'do $$declare n integer;begin delete from private.worker_runtime_results r where request_id=' + q(proof['requestId']) + '::uuid and global_token=' + q(proof['globalToken']) + "::uuid and operation='helpful_maintenance'and state='completed'and input='{\"limit\":1}'::jsonb and result='{\"deletedCount\":1}'::jsonb and closed_at is not null and purged_at is null and " + row_sha_sql('r') + '=' + q(proof['rowSha256']) + ";get diagnostics n=row_count;if n<>1 then raise exception 'member_completed_result_cas';end if;end;$$;"

    def restore_qualification(self, index):
        state = self.qualifications[index]
        require(all(is_sha(state.get(k)) for k in ('accountSha256', 'profileSha256', 'episodeSha256', 'keySha256', 'sessionSha256'))
            and (not state['photo'] or is_sha(state.get('objectSha256'))), 'QUALIFICATION_UNKNOWN_PRESERVED')
        user, subject, identity = state['userId'], state['subject'], state['identityId']
        original_profile, original_episode = json.dumps(state['profile'], ensure_ascii=False), json.dumps(state['episode'], ensure_ascii=False)
        statement = "begin;set local storage.allow_delete_query='true';do $$declare n integer;created uuid;fk record;remaining boolean;begin "
        statement += 'perform 1 from public.profiles p where p.id=' + q(user) + '::uuid and ' + row_sha_sql('p') + '=' + q(state['profileSha256']) + ' for update;if not found then raise exception \'member_profile_cas\';end if;'
        statement += 'perform 1 from private.member_episodes e where e.id=' + q(state['episode']['id']) + '::uuid and ' + row_sha_sql('e') + '=' + q(state['episodeSha256']) + ' for update;if not found then raise exception \'member_episode_cas\';end if;'
        statement += 'delete from private.naver_sessions s where user_id=' + q(user) + '::uuid and subject=' + q(subject) + ' and ' + row_sha_sql('s') + '=' + q(state['sessionSha256']) + ";get diagnostics n=row_count;if n<>1 then raise exception 'member_session_cas';end if;update private.member_episodes set identity_id=null where id=" + q(state['episode']['id']) + '::uuid and identity_id=' + q(identity) + '::uuid;'
        statement += 'delete from private.naver_identity_keys k where id=' + q(identity) + '::uuid and subject=' + q(subject) + ' and ' + row_sha_sql('k') + '=' + q(state['keySha256']) + ";get diagnostics n=row_count;if n<>1 then raise exception 'member_identity_cas';end if;delete from private.naver_accounts a where subject=" + q(subject) + ' and ' + row_sha_sql('a') + '=' + q(state['accountSha256']) + ";get diagnostics n=row_count;if n<>1 then raise exception 'member_account_cas';end if;"
        # 현재 프로필에는 이 scope 이외의 참조를 허용하지 않는다. FK 실패는 전체 rollback/UNKNOWN이다.
        statement += 'delete from private.member_episodes where id=' + q(state['episode']['id']) + '::uuid and profile_id=' + q(user) + '::uuid and ended_at is null and identity_id is null;'
        # ON DELETE CASCADE가 원래 다른 데이터를 지우지 않도록 FK 참조가 전부 비었는지 먼저 확인한다.
        statement += "for fk in select c.conkey,c.confkey,ns.nspname schema_name,t.relname table_name,a.attname column_name from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace ns on ns.oid=t.relnamespace join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1] where c.contype='f'and c.confrelid='public.profiles'::regclass loop if cardinality(fk.conkey)<>1 or cardinality(fk.confkey)<>1 then raise exception 'member_composite_fk_preserved';end if;execute format('select exists(select 1 from %I.%I where %I=$1)',fk.schema_name,fk.table_name,fk.column_name)into remaining using " + q(user) + "::uuid;if remaining then raise exception 'member_foreign_reference_preserved';end if;end loop;"
        statement += 'delete from public.profiles where id=' + q(user) + '::uuid;'
        if state['photo']:
            statement += 'delete from storage.objects o where id=' + q(state['objectId']) + "::uuid and bucket_id='profile-images'and name=" + q(state['objectPath']) + ' and owner_id=' + q(user) + ' and ' + row_sha_sql('o') + '=' + q(state['objectSha256']) + ";get diagnostics n=row_count;if n<>1 then raise exception 'member_object_cas';end if;"
        statement += 'insert into public.profiles select *from jsonb_populate_record(null::public.profiles,' + q(original_profile) + '::jsonb);select id into strict created from private.member_episodes where profile_id=' + q(user) + "::uuid and ended_at is null;if created=" + q(state['episode']['id']) + "::uuid then raise exception 'member_generated_episode_collision';end if;delete from private.member_episodes where id=created and profile_id=" + q(user) + '::uuid and ended_at is null and identity_id is null;insert into private.member_episodes select *from jsonb_populate_record(null::private.member_episodes,' + q(original_episode) + '::jsonb);end;$$;commit;'
        self.mutate('qualification-' + str(index) + '-restore', statement)
        self.save('qualification-' + str(index) + '-restored.json', {'userId': user, 'originalEpisodeId': state['episode']['id'], 'originalTimestampsRestored': True})

    def cleanup_connections(self, users):
        require(users == [a['userId'] for a in self.binding['accounts'][:2]], 'CLEANUP_MEMBERS')
        if self.connection_closed:
            return {'alreadyClosed': True, 'baselineRestored': True}
        require(self.retirement is None, 'CLEANUP_BEFORE_RETIREMENT')
        self.connection_closure = 'UNVERIFIED'
        pending = [s for s in self.qualifications.values() if not (all(is_sha(s.get(k)) for k in
            ('accountSha256', 'profileSha256', 'episodeSha256', 'keySha256', 'sessionSha256'))
            and (not s.get('photo') or is_sha(s.get('objectSha256'))))]
        if pending:
            # 메모리의 호출 진입 경계와 실제 전체 snapshot을 함께 확인한다. 파일 부재는 근거가 아니다.
            require(self.fixture is None and self.maintenance is None
                and all(s.get('dispatchState') == 'NOT_SENT' for s in pending), 'QUALIFICATION_UNKNOWN_PRESERVED')
            self.live()
            require(self.ports.snapshot() == self.outer_baseline, 'QUALIFICATION_BASELINE_CHANGED_PRESERVED')
            self.save('connections-closed-no-dispatch.json', {'runId': self.run_id,
                'qualificationSqlEntry': 'NOT_SENT', 'completeSnapshotEqualsOuterBaseline': True,
                'wholeLogicalBaselineRestored': True, 'fileAbsenceUsedAsEvidence': False,
                'pendingStateIntentsRetained': True, 'authSixRetained': True})
            self.connection_closed = True
            self.connection_closure = 'VERIFIED_NO_DISPATCH'
            return {'baselineRestored': True, 'authSixRetained': True}
        # 최초 purge의 응답이 유실됐을 수 있다. ABSENT/UNKNOWN을 미전송으로 해석하지 않는다.
        if self.maintenance:
            self.inspect_maintenance(self.maintenance['maintenanceRequest'])
        if self.fixture:
            client_hash = hashlib.sha256(('member-' + self.run_id).encode()).hexdigest()
            requests = self.read("select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb)from private.ai_chat_requests r where user_id=" + q(users[0]) + '::uuid;')
            require(len(requests) <= 1 and all(r['client_request_hash'] == client_hash
                and r['counted_day'] is None and r['started_at'] is None and r['outcome'] == 'finished'
                and r['output_retry_of'] is None and r['retry_request_id'] is None
                and (self.ai_request is None or r['request_id'] == self.ai_request) for r in requests), 'AI_UNKNOWN_PRESERVED')
            if requests:
                self.ai_request = uid(requests[0]['request_id'])
                self.save('ai-cleanup-lineage.json', {'requestId': self.ai_request, 'clientHash': client_hash,
                    'modelStarted': False, 'finished': True, 'readRecoveryOnly': True})
        if self.read_boundary is not None:
            self.cleanup_read_boundary()
        statement = 'begin;' + (self.completed_maintenance_delete() if self.maintenance else '')
        if self.fixture and self.read_boundary is None:
            request, post = self.fixture['requestId'], self.fixture['postId']
            statement += 'delete from private.conversation_message_reads where request_id=' + q(request) + '::uuid;delete from public.posts where id=' + q(post) + '::uuid and author_id=' + q(users[0]) + '::uuid;'
        if self.ai_request:
            statement += 'delete from private.ai_feedback_receipts where user_id=' + q(users[0]) + '::uuid and request_id=' + q(self.ai_request) + "::uuid and action='helpful'and client_hash=" + q(hashlib.sha256(('helpful-' + self.run_id).encode()).hexdigest()) + ';delete from private.ai_chat_requests where user_id=' + q(users[0]) + '::uuid and request_id=' + q(self.ai_request) + "::uuid and counted_day is null and started_at is null and outcome='finished';"
        if self.fixture:
            statement += 'delete from private.ai_member_processing where user_id=' + q(users[0]) + '::uuid and active_request_id is null and exploration_allowed and not summary_allowed and exploration_withdrawn_at is null and summary_withdrawn_at is null;'
        if self.maintenance:
            statement += "do $$declare n integer;begin update private.global_worker_run set token=null,expires_at=null where singleton and token=" + q(self.maintenance['globalToken']) + "::uuid;get diagnostics n=row_count;if n<>1 then raise exception 'member_global_cleanup_cas';end if;end;$$;"
            statement += self.control_cas('atomic', {'enabled': True}, False) + self.control_cas('feedback', {'enabled': True}, False)
            for signature in MAINTENANCE_SIGNATURES:
                # 기존 서비스 ACL을 유지하며 소유자·RLS·다른 역할은 바꾸지 않는다.
                if not self.original_grants.get(signature, False):
                    statement += 'revoke execute on function ' + signature + ' from service_role;'
        statement += "notify pgrst,'reload schema';commit;"
        self.live()
        self.save('connection-cleanup-intent.json', {'sqlSha256': sha(statement.encode()), 'fixture': self.fixture, 'aiRequestId': self.ai_request, 'maintenance': self.maintenance})
        self.ports.sql(statement)
        self.control_overrides.clear()
        self.live()
        for index in (1, 0):
            if index in self.qualifications:
                self.restore_qualification(index)
        if not self.baseline_bucket:
            self.mutate('bucket-cleanup', "begin;delete from storage.buckets where id='profile-images'and not exists(select 1 from storage.objects where bucket_id='profile-images');commit;")
        require(self.ports.snapshot() == self.outer_baseline, 'CONNECTION_WHOLE_BASELINE_NOT_RESTORED')
        self.connection_closed = True
        self.connection_closure = 'VERIFIED'
        self.save('connections-closed.json', {'runId': self.run_id, 'authSixRetained': True, 'wholeLogicalBaselineRestored': True,
            'roleAuthorityRestored': True, 'unknownPreserved': True, 'actualPhotoBytes': False})
        return {'baselineRestored': True, 'authSixRetained': True}

    def prepare_retirement(self, user):
        require(user == self.binding['accounts'][5]['userId'] and self.retirement is None
            and not self.retirement_attempted, 'RETIREMENT_OWNED_USER')
        self.retirement_attempted = True
        if not self.connection_closed:
            self.cleanup_connections([a['userId'] for a in self.binding['accounts'][:2]])
        self.live()
        self.retirement_baseline = self.ports.snapshot()
        self.save('retirement-before-private.json', self.retirement_baseline)
        withdrawal = str(uuid.uuid4())
        episode = self.read("select coalesce(jsonb_agg(to_jsonb(e)),'[]'::jsonb)from private.member_episodes e where profile_id=" + q(user) + '::uuid;')
        require(len(episode) == 1 and episode[0]['ended_at'] is None and episode[0]['identity_id'] is None, 'RETIREMENT_FRESH_EPISODE')
        self.retirement_episode_id = uid(episode[0]['id'])
        self.retirement_before_owned = self.retirement_owned_rows(user, withdrawal)
        self.retirement_functions = self.retirement_function_rows()
        # 모든 읽기 준비가 끝난 뒤, 첫 qualification/grant/POST보다 앞에서 효과 가능 scope를 연다.
        self.retirement = {'userId': user, 'withdrawalId': withdrawal, 'status': 'preparing'}
        self.save('retirement-native-closed-precondition.json', {'productionReady': False,
            'reason': 'NATIVE_CLEANUP_GATE_AND_RPC_CLOSED', 'originalControls': self.original_controls,
            'functions': self.retirement_functions, 'fixtureOnly': True, 'externalWorkerStarted': False})
        self.save('retirement-destructive-owned-intent.json', {**self.retirement,
            'originalUserId': user, 'originalSessionId': self.binding['accounts'][5]['sessionId'],
            'originalTokenSha256': sha(self.binding['accounts'][5]['accessToken'].encode()),
            'originalFiveMustRemain': [a['userId'] for a in self.binding['accounts'][:5]], 'externalDeletion': 'NOT_RUN',
            'cron': 'off', 'newAuthAccounts': 0, 'cleanupWorkerStarted': False})
        self.qualify(5, False)
        self.retirement_control_changes = {'enabled': True, 'expected_issuer': self.binding['jwtIssuer'], 'expected_audience': 'authenticated'}
        statement = 'begin;' + self.control_cas('retirement', self.retirement_control_changes, True)
        statement += self.control_cas('cleanup', {'external_deletion_approved': True}, True)
        statement += self.function_rows_cas(self.retirement_functions)
        statement += 'grant execute on function ' + ','.join(RETIREMENT_SIGNATURES) + " to service_role;notify pgrst,'reload schema';commit;"
        self.save('retirement-fixture-enable-intent.json', {'sqlSha256': sha(statement.encode()),
            'onlySignatures': list(RETIREMENT_SIGNATURES), 'externalWorkerStarted': False, 'productionReady': False})
        self.ports.sql(statement)
        self.control_overrides['member_retirement_receipt_control'] = True
        self.control_overrides['member_cleanup_guard'] = True
        self.live()
        self.retirement_function_owned = self.retirement_function_rows()
        require(all(v['serviceExecute'] is True and v['oid'] == self.retirement_functions[k]['oid']
            and v['owner'] == self.retirement_functions[k]['owner'] for k, v in self.retirement_function_owned.items()), 'RETIREMENT_FIXED_FUNCTIONS')
        self.save('retirement-fixture-functions-owned.json', self.retirement_function_owned)
        self.retirement['status'] = 'prepared'
        return self.retirement

    def retirement_function_rows(self):
        terms = [q(s) + ", (select jsonb_build_object('oid',p.oid::bigint,'owner',p.proowner::bigint,'proacl',to_jsonb(p.proacl),'rowSha256',"
            + row_sha_sql('p') + ",'serviceExecute',has_function_privilege('service_role',p.oid,'EXECUTE'))from pg_proc p where p.oid="
            + q(s) + '::regprocedure)' for s in RETIREMENT_SIGNATURES]
        value = self.read('select jsonb_build_object(' + ','.join(terms) + ');')
        require(type(value) is dict and set(value) == set(RETIREMENT_SIGNATURES)
            and all(type(v) is dict and is_sha(v['rowSha256']) and type(v['oid']) is int
                and type(v['owner']) is int and type(v['serviceExecute']) is bool for v in value.values()), 'RETIREMENT_RPC_METADATA')
        return value

    def close_retirement_preparation_not_dispatched(self):
        # retirement 객체는 첫 변경 전에 반드시 설정된다. 파일 존재/부재로 이 경계를 추정하지 않는다.
        require(self.retirement_attempted and self.retirement is None and self.connection_closed
            and hasattr(self, 'retirement_baseline'), 'RETIREMENT_PREPARATION_UNKNOWN_PRESERVED')
        self.live()
        require(self.ports.snapshot() == self.retirement_baseline, 'RETIREMENT_PREPARATION_BASELINE_CHANGED')
        self.save('retirement-preparation-not-dispatched-closed.json', {'runId': self.run_id,
            'status': 'NOT_DISPATCHED_CLOSED', 'completeSnapshotEqualsRetirementBaseline': True,
            'qualificationGrantPostNotEntered': True, 'fileAbsenceUsedAsEvidence': False,
            'originalExecutionFailurePreserved': True, 'actualRetirement': 'NOT_RUN'})
        self.retirement_preparation_closed = True

    def function_rows_cas(self, values):
        require(set(values) == set(RETIREMENT_SIGNATURES), 'FIXED_FUNCTION_SCOPE')
        return 'do $$begin ' + ''.join('perform 1 from pg_proc p where p.oid=' + q(s)
            + '::regprocedure and p.oid=' + str(values[s]['oid']) + ' and p.proowner=' + str(values[s]['owner'])
            + ' and ' + row_sha_sql('p') + '=' + q(values[s]['rowSha256'])
            + ";if not found then raise exception 'member_function_cas';end if;" for s in RETIREMENT_SIGNATURES) + 'end;$$;'

    def retirement_owned_rows(self, user, withdrawal):
        uid(user)
        uid(withdrawal)
        session = uid(self.binding['accounts'][5]['sessionId'])
        subject = 'MEMBER-synthetic-' + self.run_id + '-5'
        predicates = {
            'public.profiles': 'r.id=' + q(user) + '::uuid',
            'private.member_episodes': 'r.profile_id=' + q(user) + '::uuid and r.id=' + q(self.retirement_episode_id) + '::uuid',
            'private.naver_accounts': 'r.subject=' + q(subject),
            'private.naver_identity_keys': 'r.subject=' + q(subject),
            'private.naver_sessions': 'r.subject=' + q(subject) + ' and r.user_id=' + q(user) + '::uuid and r.session_id=' + q(session) + '::uuid',
            'auth.sessions': 'r.user_id=' + q(user) + '::uuid and r.id=' + q(session) + '::uuid',
            'auth.refresh_tokens': 'r.user_id::text=' + q(user) + ' and r.session_id=' + q(session) + '::uuid',
            'auth.mfa_amr_claims': 'r.session_id=' + q(session) + '::uuid',
            'private.member_retirements': 'r.profile_id=' + q(user) + '::uuid and r.withdrawal_id=' + q(withdrawal) + '::uuid',
            'private.member_cleanup_tasks': 'r.profile_id=' + q(user) + '::uuid and r.withdrawal_id=' + q(withdrawal) + "::uuid and r.kind='auth_user'",
            'private.member_cleanup_delete_acks': 'r.profile_id=' + q(user) + '::uuid and r.withdrawal_id=' + q(withdrawal) + "::uuid and r.kind='auth_user'",
            'private.ai_member_processing': 'r.user_id=' + q(user) + '::uuid',
            'private.review_summary_state': 'r.profile_id=' + q(user) + '::uuid',
        }
        terms = []
        for table, predicate in predicates.items():
            bag = "select coalesce(jsonb_object_agg(h,n),'{}'::jsonb)from(select " + row_sha_sql('r') + ' h,count(*)n from ' + table + ' r where ' + predicate + ' group by 1)q'
            terms.append(q(table) + ',(' + bag + ')')
        return self.read('select jsonb_build_object(' + ','.join(terms) + ');')

    def inspect_retirement(self, user, withdrawal):
        require(self.retirement and user == self.retirement['userId'] and withdrawal == self.retirement['withdrawalId'], 'OWNED_RETIREMENT')
        result = self.read("select jsonb_build_object('withdrawalId',r.withdrawal_id,'originalUserId',r.profile_id,'state',r.state,'rowSha256'," + row_sha_sql('r') + ",'ackSha256',(select case when count(*)=0 then null else encode(sha256(convert_to(jsonb_agg(to_jsonb(a)order by a.task_id)::text,'UTF8')),'hex')end from private.member_cleanup_delete_acks a where a.withdrawal_id=r.withdrawal_id),'sessionsDeleted',not exists(select 1 from auth.sessions where user_id=r.profile_id),'episodeEnded',exists(select 1 from private.member_episodes e where e.id=r.episode_id and e.ended_at=r.retired_at),'profileMinimal',exists(select 1 from public.profiles p where p.id=r.profile_id and p.real_name is null and p.birth_date is null and p.gender is null and p.avatar_url is null and p.bio is null))from private.member_retirements r where withdrawal_id=" + q(withdrawal) + '::uuid and profile_id=' + q(user) + '::uuid;')
        require(result and result['sessionsDeleted'] is True and result['episodeEnded'] is True and result['profileMinimal'] is True
                and result['state'] == 'pending_cleanup' and result['ackSha256'] is None, 'RETIREMENT_PROCESSING_NOT_COMPLETED')
        expected_shape = self.read("select jsonb_build_object('episode',exists(select 1 from private.member_retirements r where r.withdrawal_id=" + q(withdrawal) + '::uuid and r.episode_id=' + q(self.retirement_episode_id) + "::uuid),'tasks',(select count(*)=1 and bool_and(kind='auth_user'and state='pending'and lease_token is null and worker_run_token is null and lease_expires_at is null and evidence_sha256 is null and completed_at is null)from private.member_cleanup_tasks where withdrawal_id=" + q(withdrawal) + '::uuid and profile_id=' + q(user) + "::uuid),'ai',(select not exploration_allowed and not summary_allowed and exploration_withdrawn_at is not null and summary_withdrawn_at is not null and active_request_id is null from private.ai_member_processing where user_id=" + q(user) + '::uuid));')
        require(all(expected_shape.get(k) is True for k in ('episode', 'tasks', 'ai')), 'RETIREMENT_EXPECTED_ONLY')
        rows = self.read('select jsonb_build_object(\'profile\',(select to_jsonb(p)from public.profiles p where id=' + q(user) + '::uuid),\'episode\',(select to_jsonb(e)from private.member_episodes e where id=' + q(self.retirement_episode_id) + '::uuid),\'summary\',(select to_jsonb(s)from private.review_summary_state s where profile_id=' + q(user) + '::uuid));')
        original = self.qualifications[5]
        ignored = {'real_name', 'birth_date', 'gender', 'avatar_url', 'bio', 'updated_at'}
        require({k: v for k, v in rows['profile'].items() if k not in ignored}
            == {k: v for k, v in original['profile'].items() if k not in ignored}, 'RETIREMENT_OTHER_PROFILE_COLUMNS')
        require({k: v for k, v in rows['episode'].items() if k not in {'identity_id', 'ended_at'}}
            == {k: v for k, v in original['episode'].items() if k not in {'identity_id', 'ended_at'}}
            and rows['episode']['identity_id'] == original['identityId'], 'RETIREMENT_ORIGINAL_EPISODE_COLUMNS')
        require(rows['summary'] == {'profile_id': user, 'revision': 1, 'fingerprint': None, 'visible_summary_id': None}, 'RETIREMENT_SUMMARY_WITHDRAWAL_ONLY')
        self.retirement_receipt_retained = True
        self.record_retirement_observation(result)
        return result

    def record_retirement_observation(self, value):
        require(self.retirement_observation is None or value == self.retirement_observation,
            'RETIREMENT_OBSERVATION_CHANGED')
        if self.retirement_observation is None:
            proof = json.loads(json.dumps(value))
            receipt_sha = self.save('retirement-observed.json', proof)
            raw = self.h.signed_private_read(self.evidence / 'retirement-observed.json')
            require(is_sha(receipt_sha) and sha(raw) == receipt_sha
                and self.h.signed_exact_json(raw) == proof, 'RETIREMENT_OBSERVATION_BYTES')
            self.retirement_observation = proof
            self.retirement_observation_receipt_sha = receipt_sha
        else:
            raw = self.h.signed_private_read(self.evidence / 'retirement-observed.json')
            require(is_sha(self.retirement_observation_receipt_sha)
                and sha(raw) == self.retirement_observation_receipt_sha
                and self.h.signed_exact_json(raw) == self.retirement_observation, 'RETIREMENT_OBSERVATION_BYTES')

    def cleanup_retirement(self, user, withdrawal):
        require(self.retirement and user == self.retirement['userId'] and withdrawal == self.retirement['withdrawalId'], 'OWNED_RETIREMENT')
        if self.retirement_closed:
            return {'receiptRetained': self.retirement_receipt_retained, 'wholeBaselineRestored': False, 'externalDeletion': 'NOT_RUN'}
        # 탈퇴 영수증과 ACK를 검사 중 지우지 않는다. 자원 삭제는 별도 Root 절차다.
        statement = 'begin;'
        if self.control_overrides.get('member_retirement_receipt_control') is True:
            statement += self.control_cas('retirement', self.retirement_control_changes, False)
        if self.control_overrides.get('member_cleanup_guard') is True:
            statement += self.control_cas('cleanup', {'external_deletion_approved': True}, False)
        if self.retirement_function_owned is not None:
            statement += self.function_rows_cas(self.retirement_function_owned)
            for signature in RETIREMENT_SIGNATURES:
                if not self.retirement_functions[signature]['serviceExecute']:
                    statement += 'revoke execute on function ' + signature + ' from service_role;'
        statement += "notify pgrst,'reload schema';commit;"
        self.live()
        self.save('retirement-guard-close-intent.json', {'withdrawalId': withdrawal, 'sqlSha256': sha(statement.encode()), 'receiptRetained': True})
        self.ports.sql(statement)
        self.control_overrides.clear()
        self.live()
        require(self.retirement_functions is not None and self.retirement_function_rows() == self.retirement_functions, 'RETIREMENT_RPC_EXACT_RESTORE')
        exists = self.read('select exists(select 1 from private.member_retirements where profile_id=' + q(user) + '::uuid and withdrawal_id=' + q(withdrawal) + '::uuid);')
        if not exists:
            # 최초 POST 효과가 없음을 DB에서 확인한 경우에만 합성 qualification을 복원한다.
            if 5 in self.qualifications:
                self.restore_qualification(5)
            require(self.ports.snapshot() == self.retirement_baseline, 'RETIREMENT_PREPARATION_UNKNOWN_PRESERVED')
            self.retirement_closed = True
            self.save('retirement-post-not-committed.json', {'withdrawalId': withdrawal, 'actualRetirement': 'NOT_VERIFIED',
                'guardsAndAuthorityRestored': True, 'preparationBaselineRestored': True, 'pass': False})
            raise ValueError('MEMBER_ROOT_RETIREMENT_POST_NOT_COMMITTED')
        observed = self.inspect_retirement(user, withdrawal)
        current = self.ports.snapshot()
        foreign_state_unchanged(self.retirement_baseline, current, self.retirement_before_owned,
            self.retirement_owned_rows(user, withdrawal))
        for account in self.binding['accounts'][:5]:
            require(self.ports.session_proof(account), 'ORIGINAL_FIVE_SESSION_PRESERVATION')
        require(self.read('select count(*)=6 from auth.users;') is True, 'NO_AUTH_USER_DELETE_OR_SEVENTH')
        self.save('retirement-final-retained.json', {'userId': user, 'withdrawalId': withdrawal,
            'state': observed['state'], 'ackSha256': observed['ackSha256'], 'originalFiveSessionsPreserved': True,
            'lastOriginalSessionDeleted': True, 'wholeOriginalSixBaselineRestored': False, 'externalDelete': 'NOT_RUN',
            'receiptRetainedForPolicy': True, 'ackRetention': 'NO_ACK_YET' if observed['ackSha256'] is None else 'ACK_NOT_DELETED',
            'ninetyDayElapsedTest': 'NOT_RUN', 'roleAndFunctionAuthorityRestored': True,
            'productionCleanupReady': False, 'resourceDeletion': 'ROOT_SEPARATE_APPROVED_SCOPE'})
        self.retirement_closed = True
        return {'receiptRetained': True, 'wholeBaselineRestored': False, 'externalDeletion': 'NOT_RUN'}

    def dispatch(self, frame):
        require(type(frame) is dict and set(frame) == {'type', 'requestId', 'sequence', 'method', 'args'}
                and frame['type'] == 'call' and frame['requestId'] == self.run_id
                and type(frame['sequence']) is int and frame['sequence'] == self.sequence + 1
                and frame['method'] in METHOD_ARGS and type(frame['args']) is dict, 'FIXED_FRAME')
        method, args = frame['method'], frame['args']
        require(set(args) == {'runId', 'bindingSha256', *METHOD_ARGS[method]} and args['runId'] == self.run_id
                and args['bindingSha256'] == self.packet['bindingSha256'], 'METHOD_BINDING')
        self.sequence += 1
        self.live()
        if method == 'verifyTarget': value = self.live()
        elif method == 'readCredentials': value = {**self.binding['credentials'], 'internalSecret': self.internal_secret, 'ledgerId': self.ledger_id}
        elif method == 'readIssuedAuth': value = self.binding['accounts']
        elif method == 'readTls': value = self.j01.RootJ01Boundary.read_tls(self)
        elif method == 'prepareConversation': value = self.prepare_conversation(args['memberUserIds'])
        elif method == 'inspectConversation': value = self.inspect_conversation(args['requestId'])
        elif method == 'prepareReadBoundaryCases': value = self.prepare_read_boundary(args['requestId'])
        elif method == 'inspectReadBoundaryCases': value = self.inspect_read_boundary(args['requestId'])
        elif method == 'setReadBoundaryCase': value = self.set_read_boundary(args['requestId'], args['stage'])
        elif method == 'inspectAiFeedback': value = self.inspect_ai(args['userId'], args['requestId'])
        elif method == 'prepareFeedbackRetention': value = self.prepare_retention(args['userId'], args['requestId'], args['feedbackId'])
        elif method == 'inspectMaintenance': value = self.inspect_maintenance(args['requestId'])
        elif method == 'cleanupConnections': value = self.cleanup_connections(args['memberUserIds'])
        elif method == 'prepareRetirement': value = self.prepare_retirement(args['userId'])
        elif method == 'inspectRetirement': value = self.inspect_retirement(args['userId'], args['withdrawalId'])
        else: value = self.cleanup_retirement(args['userId'], args['withdrawalId'])
        self.observations.append({'sequence': self.sequence, 'method': method, 'outcome': 'RESPONSE_OBSERVED'})
        return {'requestId': self.run_id, 'sequence': self.sequence, 'ok': True, 'value': value}

    def invoke_node(self):
        # 실제 provider/DB 환경 키를 child에 넘기지 않는다. 제품 조립은 고정 합성 env만 사용한다.
        inherited = self.j01.RootJ01Boundary.node_env(self)
        env = {k: v for k, v in inherited.items() if k in {'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR'}}
        self.child = subprocess.Popen([str(self.node), '--experimental-strip-types', str(Path(self.input['codeRoot']) / DRIVER), '--root-stdio'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env)
        self.child.stdin.write(json.dumps({'requestId': self.run_id, 'input': self.input}) + '\n')
        self.child.stdin.flush()
        selector = selectors.DefaultSelector()
        selector.register(self.child.stdout, selectors.EVENT_READ)
        proof = None
        try:
            while True:
                require(selector.select(timeout=45), 'NODE_TIMEOUT')
                line = self.child.stdout.readline(MAX_FRAME + 1)
                require(line and len(line.encode()) <= MAX_FRAME, 'NODE_FRAME')
                frame = self.h.signed_exact_json(line.encode())
                if frame.get('type') == 'result':
                    require(frame.get('requestId') == self.run_id and frame.get('sequence') == self.sequence
                            and frame.get('proof', {}).get('status') == 'ROOT_ATTESTATION_REQUIRED', 'NODE_NO_FAKE_PASS')
                    proof = frame['proof']
                    break
                try:
                    reply = self.dispatch(frame)
                except Exception as error:
                    method = frame.get('method') if type(frame) is dict else None
                    self.observations.append({'sequence': self.sequence, 'method': method if type(method) is str and method in METHOD_ARGS else 'invalid',
                        'outcome': 'REJECTED_NO_RETRY', 'failureCode': safe_code(error, self.j01)})
                    reply = {'requestId': self.run_id, 'sequence': self.sequence, 'ok': False, 'error': 'MEMBER_ROOT_FIXED_METHOD_REJECTED'}
                self.child.stdin.write(json.dumps(reply) + '\n')
                self.child.stdin.flush()
            # 검증된 terminal 뒤에 EOF를 전달해야 Node readline이 입력 대기를 끝낸다.
            self.child.stdin.close()
            require(self.child.wait(timeout=10) == 0, 'NODE_EXIT')
        finally:
            selector.close()
            if self.child.poll() is None:
                self.child.terminate()
                try: self.child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=5)
        return proof

    def run(self):
        proof, failure = None, None
        execution_failure, cleanup_failure = None, None
        try:
            self.prepare()
            proof = self.invoke_node()
        except Exception as error:
            execution_failure = safe_code(error, self.j01)
            failure = 'MEMBER_ROOT_EXECUTION_NOT_CLOSED'
        finally:
            if self.evidence.exists():
                try:
                    if self.retirement:
                        self.cleanup_retirement(self.retirement['userId'], self.retirement['withdrawalId'])
                    elif self.retirement_attempted:
                        self.close_retirement_preparation_not_dispatched()
                    elif self.seed_attempted:
                        self.cleanup_connections([a['userId'] for a in self.binding['accounts'][:2]])
                except Exception as error:
                    cleanup_failure = safe_code(error, self.j01)
                    failure = 'MEMBER_ROOT_OWNED_STATE_UNKNOWN_PRESERVED'
                self.save('finalization.json', {'runId': self.run_id, 'failure': failure, 'observedCalls': self.observations,
                    'executionFailureCode': execution_failure, 'cleanupFailureCode': cleanup_failure,
                    'connectionsClosure': self.connection_closure,
                    'wholeOriginalSixRestored': False if self.retirement else (self.connection_closed
                        and (not self.retirement_attempted or self.retirement_preparation_closed)),
                    'retirementReceiptRetained': self.retirement_receipt_retained, 'actualProvider': 'NOT_RUN'})
        require(failure is None and proof is not None, 'PRIVATE_EVIDENCE_PRESERVED')
        self.save('receipt.json', {'status': 'MEMBER_ROOT_CALL_OBSERVATIONS_CLOSED', 'executionEvidence': 'ROOT_ATTESTATION_REQUIRED',
            'runId': self.run_id, 'sourceHead': self.packet['head'], 'packetSha256': sha(self.packet_raw),
            'bindingSha256': self.packet['bindingSha256'], 'proof': proof, 'observedCalls': self.observations,
            'connectionsBaselineRestoredBeforeRetirement': self.connection_closed, 'originalSixFinalBaselineRestored': False,
            'actualNaver': False, 'actualProvider': False, 'production': False})
        return {'status': 'MEMBER_ROOT_CALL_OBSERVATIONS_CLOSED', 'executionEvidence': 'ROOT_ATTESTATION_REQUIRED',
                'runId': self.run_id, 'retirementOriginalReceiptRetained': True, 'originalSixFinalBaselineRestored': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--reviewed', type=Path)
    args = parser.parse_args()
    if not args.run:
        print(json.dumps({'status': 'NOT_RUN', 'ready': False, 'methods': sorted(METHOD_ARGS), 'vmStarted': False,
                          'credentialReads': 0, 'actualAuth': 'NOT_RUN', 'actualDatabase': 'NOT_RUN'}))
        return 0
    try:
        require(args.reviewed is not None, 'REVIEWED_REQUIRED')
        print(json.dumps(RootMemberBoundary(args.reviewed).run()))
        return 0
    except Exception:
        print(json.dumps({'status': 'BLOCKED', 'executionEvidence': 'ROOT_ATTESTATION_REQUIRED',
                          'reason': 'MEMBER_ROOT_NOT_CLOSED', 'stateEvidence': 'PRIVATE_REVIEW_REQUIRED'}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
