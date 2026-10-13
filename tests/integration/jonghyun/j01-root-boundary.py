"""종현 J01 전용 Root 실행 경계. 기본 실행은 NOT_RUN이다.

원 합성 Auth6 발급/삭제는 하지 않는다. 기존 검토된 provisioning ports를 읽기 재사용하며,
선택2명의 숨김용 합성 identity와 행사17개만 자기 runId로 준비/원복한다.
실제 --run은 Root의 원 binding/발급 영수증·현재 커밋·Node/capsule SHA·owned 대상이 필요하다.
"""
import argparse
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import time
import uuid

REPO = Path(__file__).resolve().parents[3]
CALLER = Path(__file__).resolve()
DRIVER = 'tests/integration/jonghyun/events-rest.mjs'
METHODS = frozenset(('verifyTarget', 'readCredentials', 'readSyntheticMembers', 'sql', 'snapshot', 'cleanupScope', 'readTls'))
MAX_FRAME = 2 * 1024 * 1024
NODE_PROGRAM = r"""
import {createInterface} from 'node:readline';import {pathToFileURL} from 'node:url';
const lines=createInterface({input:process.stdin,crlfDelay:Infinity})[Symbol.asyncIterator]();
const first=JSON.parse((await lines.next()).value);let seq=0;
const call=async(method,args)=>{const n=++seq;process.stdout.write(JSON.stringify({type:'call',requestId:first.requestId,sequence:n,method,args})+'\n');const item=await lines.next();if(item.done)throw Error('J01_BROKER_CLOSED');const r=JSON.parse(item.value);if(r.requestId!==first.requestId||r.sequence!==n||r.ok!==true)throw Error('J01_BROKER_REJECTED');return r.value;};
const boundary=Object.fromEntries(['verifyTarget','readCredentials','readSyntheticMembers','sql','snapshot','cleanupScope','readTls'].map(name=>[name,(...args)=>call(name,args)]));
try{const{runJ01EventRoundtrip}=await import(pathToFileURL(first.input.codeRoot+'/tests/integration/jonghyun/events-rest.mjs').href);const proof=await runJ01EventRoundtrip(first.input,boundary);process.stdout.write(JSON.stringify({type:'result',requestId:first.requestId,sequence:seq,proof})+'\n');}
catch{process.stdout.write(JSON.stringify({type:'failure',requestId:first.requestId,sequence:seq,error:'J01_NODE_ROUNDTRIP_FAILED'})+'\n');process.exitCode=1;}
"""
SQL_PROGRAM = r"""
import{pathToFileURL}from'node:url';let raw='';for await(const c of process.stdin)raw+=c;const p=JSON.parse(raw);
const m=await import(pathToFileURL(p.codeRoot+'/tests/integration/jonghyun/events-rest.mjs').href);
const data=p.eventId?{hide:m.j01HideSql(p.members[0].identityId,p.eventId)}:{seed:m.j01FixtureSql(p.runId,p.members),inventory:m.J01_INVENTORY_SQL};
process.stdout.write(JSON.stringify(data));
"""


def require(value, code):
    if not value:
        raise ValueError('J01_ROOT_' + code)


def safe_code(error):
    # args 전체·traceback·SQL·URL·키는 기록하지 않는다. 고정 코드 한 개만 허용한다.
    value = error.args[0] if len(error.args) == 1 and type(error.args[0]) is str else ''
    if re.fullmatch(r'J01_ROOT_[A-Z0-9_]+|SQLSTATE_[0-9A-Z]{5}', value):
        return value
    if re.fullmatch(r'(SIGNED|PROVISION)_[A-Z0-9_]+', value):
        try:
            tree = ast.parse(CALLER.with_name('isolated_ai_contracts.py').read_text())
            known = {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant)
                     and type(node.value) is str and re.fullmatch(r'(SIGNED|PROVISION)_[A-Z0-9_]+', node.value)}
            if value in known:
                return value
        except Exception:
            pass
    return 'J01_ROOT_UNCLASSIFIED_FAILURE'


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def is_sha(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def quoted(value):
    return "'" + value.replace("'", "''") + "'"


def fixed_uuid(value):
    require(type(value) is str and str(uuid.UUID(value)) == value, 'UUID')
    return value


def load_helpers():
    # 로드 자체는 Docker/Auth/SQL을 호출하지 않는다. 이미 검토된 실제 함수만 재사용한다.
    sys.path.insert(0, str(REPO / 'tools/local'))
    sys.path.insert(0, str(CALLER.parent))
    spec = importlib.util.spec_from_file_location('j01_existing_signed_helpers', CALLER.with_name('isolated_ai_contracts.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RootJ01Boundary:
    """CLI가 실제 원 binding으로 만든 객체만 Node의 고정 일곱 메소드에 응답한다."""
    def __init__(self, packet_path):
        self.h = load_helpers()
        self.packet_path = Path(packet_path)
        self.packet_raw = self.h.signed_private_read(self.packet_path)
        self.packet = self.h.signed_exact_json(self.packet_raw)
        fields = {'version', 'scenario', 'decisionId', 'head', 'preparedRoot', 'bindingPath', 'bindingSha256',
                  'provisionReceiptPath', 'provisionReceiptSha256', 'inputPath', 'inputSha256', 'privateRoot',
                  'nodePath', 'nodeSha256', 'callerSha256'}
        p = self.packet
        require(type(p) is dict and set(p) == fields and p['version'] == 1 and p['scenario'] == 'J01_ROOT_BOUNDARY', 'REVIEWED_FIELDS')
        require(re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', p['decisionId']) is not None, 'DECISION_REFERENCE')
        require(re.fullmatch('[0-9a-f]{40}', p['head']) is not None and all(is_sha(p[k]) for k in ('bindingSha256', 'provisionReceiptSha256', 'inputSha256', 'nodeSha256', 'callerSha256')), 'REVIEWED_HASHES')
        self.root = Path(p['preparedRoot'])
        self.target = self.h.signed_prepared_target(self.root)
        self.binding_raw = self.h.signed_private_read(Path(p['bindingPath']))
        require(sha(self.binding_raw) == p['bindingSha256'], 'BINDING_BYTES')
        self.binding = self.h.validate_signed_binding(self.h.signed_exact_json(self.binding_raw), self.root, self.target)
        receipt_raw = self.h.signed_private_read(Path(p['provisionReceiptPath']))
        require(sha(receipt_raw) == p['provisionReceiptSha256'], 'PROVISION_RECEIPT_BYTES')
        receipt = self.h.signed_exact_json(receipt_raw)
        require(receipt.get('status') == 'PASS_LOCAL_AUTH6_PROVISION_ONLY' and receipt.get('accounts') == 6
                and receipt.get('bindingSha256') == p['bindingSha256'] and receipt.get('actualGoTrueAndDatabaseSessions') is True
                and receipt.get('authAccountsRetained') is True, 'ORIGINAL_SIX_PROVISION_REQUIRED')
        require(Path(receipt['creationReceiptRoot']) / 'receipt.json' == Path(p['provisionReceiptPath']), 'PROVISION_RECEIPT_PATH')
        self.input_raw = self.h.signed_private_read(Path(p['inputPath']))
        require(sha(self.input_raw) == p['inputSha256'], 'INPUT_BYTES')
        self.input = self.h.signed_exact_json(self.input_raw)
        require(self.input.get('head') == p['head'] and self.input.get('repositoryRoot') == str(REPO)
                and self.input.get('target') is not None, 'SOURCE_TARGET_INPUT_REQUIRED')
        self.run_id = fixed_uuid(self.input['target']['runId'])
        self.evidence = Path(p['privateRoot'])
        require(self.evidence.is_absolute() and self.evidence.resolve() == self.evidence
                and self.evidence.parent == self.root and self.evidence.name == 'j01-' + self.run_id, 'EVIDENCE_NAMESPACE')
        self.node = Path(p['nodePath'])
        require(self.node.is_absolute() and self.node.resolve() == self.node and self.node.is_file()
                and sha(self.node.read_bytes()) == p['nodeSha256'], 'NODE_BINARY')
        self.reviewed = self.h.ReviewedSignedProvisioning(p['decisionId'], self.root, self.binding['sourcePins'],
            self.binding['containers'], self.binding['credentials'], int(time.time()) + 300)
        # 원 Auth6 발급 뒤의 J01만 사용한다. 발급/added_rows는 호출하지 않는다.
        # 외곽 baseline은 처음부터 cron/vault까지 포함한 여섯 schema를 보존한다.
        self.ports = self.h.FixedLifecycleProvisioningPorts(self.reviewed)
        self.ports.origin = self.binding['origin']
        self.ports.runner.binding['sourcePins'] = self.binding['sourcePins']
        self.sequence = 0
        self.observations = []
        self.members = []
        self.identity_intents = []
        self.identity_created = {}
        self.event_rows = None
        self.seed_attempted = False
        self.hide_attempted = False
        self.hidden_row = None
        self.seed_data = None
        self.allowed_sql = {}
        self.child = None
        self.committed_hashes = {}
        self.capsule_paths = None
        self.last_native_snapshot = None
        self.last_completed_source_check = None
        self.source_check()

    def source_check(self):
        p = self.packet
        require(sha(CALLER.read_bytes()) == p['callerSha256'], 'CALLER_CHANGED')
        result = subprocess.run(['git', '-C', str(REPO), 'show', p['head'] + ':' + str(CALLER.relative_to(REPO))], capture_output=True, timeout=10)
        require(result.returncode == 0 and sha(result.stdout) == p['callerSha256'], 'CALLER_NOT_COMMITTED')
        self.h.provisioning_source_check(self.binding['sourcePins'], p['head'])
        require(type(self.input.get('sourceFiles')) is dict and type(self.input.get('migrationFiles')) is dict, 'INPUT_MANIFESTS')
        capsule = Path(self.input['codeRoot'])
        require(capsule.is_absolute() and capsule.resolve() == capsule, 'CAPSULE_ROOT')
        for kind, files in (('source', self.input['sourceFiles']), ('migration', self.input['migrationFiles'])):
            for relative, expected in files.items():
                require(type(relative) is str and re.fullmatch('[A-Za-z0-9_./-]+', relative) is not None and '..' not in Path(relative).parts and not Path(relative).is_absolute() and is_sha(expected), 'PIN_RELATIVE_PATH')
                require(relative == DRIVER or relative.startswith('backend/supabase/functions/') or relative.startswith('apps/mobile/src/') if kind == 'source' else relative.startswith('backend/supabase/migrations/') and relative.endswith('.sql'), 'PIN_SCOPE')
                current = REPO / relative
                if relative not in self.committed_hashes:
                    result = subprocess.run(['git', '-C', str(REPO), 'show', p['head'] + ':' + relative], capture_output=True, timeout=10)
                    require(result.returncode == 0, 'HEAD_PIN_MISSING')
                    self.committed_hashes[relative] = sha(result.stdout)
                require(current.resolve() == current and current.is_file() and sha(current.read_bytes()) == expected and self.committed_hashes[relative] == expected, 'COMMITTED_PIN_BYTES')
                if kind == 'source':
                    copied = capsule / relative
                    require(copied.resolve() == copied and copied.is_file() and sha(copied.read_bytes()) == expected, 'CAPSULE_PIN_BYTES')
        # 첫 Node import 전에 capsule의 미선언 실행 파일도 현재 HEAD 바이트로 묶는다.
        capsule_paths = []
        for copied in capsule.rglob('*'):
            require(not copied.is_symlink() and copied.resolve() == copied, 'CAPSULE_LINK')
            if copied.is_file() and copied.suffix in ('.ts', '.tsx', '.js', '.mjs', '.cjs'):
                relative = str(copied.relative_to(capsule))
                if not (relative == DRIVER or relative.startswith('backend/supabase/functions/') or relative.startswith('apps/mobile/src/')):
                    continue
                if relative not in self.committed_hashes:
                    result = subprocess.run(['git', '-C', str(REPO), 'show', p['head'] + ':' + relative], capture_output=True, timeout=10)
                    require(result.returncode == 0, 'CAPSULE_UNCOMMITTED_EXECUTABLE')
                    self.committed_hashes[relative] = sha(result.stdout)
                require(sha(copied.read_bytes()) == self.committed_hashes[relative], 'CAPSULE_EXECUTABLE_CHANGED')
                capsule_paths.append(relative)
        if self.capsule_paths is None:
            self.capsule_paths = sorted(capsule_paths)
        require(self.capsule_paths == sorted(capsule_paths), 'CAPSULE_EXECUTABLE_SET_CHANGED')
        actual_migrations = {'backend/supabase/migrations/' + path.name for path in (REPO / 'backend/supabase/migrations').glob('*.sql')}
        require(actual_migrations == set(self.input['migrationFiles']), 'EXACT_MIGRATION_FILE_SET')
        for path, expected in ((self.packet_path, sha(self.packet_raw)), (Path(p['bindingPath']), p['bindingSha256']), (Path(p['inputPath']), p['inputSha256'])):
            require(sha(self.h.signed_private_read(path)) == expected, 'REVIEWED_INPUT_CHANGED')
        self.last_completed_source_check = {'head': p['head'], 'sourceManifestSha256': digest(self.input['sourceFiles']),
            'migrationManifestSha256': digest(self.input['migrationFiles']), 'observedAtUnixSeconds': int(time.time())}

    def live(self):
        self.source_check()
        self.ports.identity()
        require(self.ports.memory_kib() >= 786432, 'RESOURCE_LIMIT')
        self.h.signed_verify_history(self.ports.runner)
        closed = self.ports.closed_controls()
        require(closed.get('cronLaunchActiveJobs') == 'off'
                and all(closed.get(k) is False for k in self.h.PROVISION_CLOSED_CONTROLS), 'CLOSED_CONTROLS')
        expected = self.input['target']
        require(expected['dockerSocket'] == self.target['host'].removeprefix('unix://')
                and expected['project'] == self.target['project'] and expected['origin'] == self.binding['origin']
                and expected['authIssuer'] == self.binding['jwtIssuer'] and expected['authAudience'] == 'authenticated', 'TARGET_ORIGIN_IDENTITY')
        require(expected['containers'] == {k: {x: self.binding['containers'][k][x] for x in ('id', 'image')} for k in ('db', 'auth', 'rest')}, 'TARGET_CONTAINER_IDENTITY')
        return {'target': expected, 'migrationFiles': self.input['migrationFiles']}

    def save(self, name, value):
        self.h.provisioning_json(self.evidence, name, value)

    def node_env(self):
        env = dict(os.environ)
        for key in ('NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
            env.pop(key, None)
        return env

    def sql_contract(self, event_id=None):
        self.source_check()
        payload = {'codeRoot': self.input['codeRoot'], 'runId': self.run_id, 'members': self.members}
        if event_id is not None:
            payload['eventId'] = fixed_uuid(event_id)
        result = subprocess.run([str(self.node), '--experimental-strip-types', '--input-type=module', '-e', SQL_PROGRAM],
            input=canonical(payload), capture_output=True, timeout=20, env=self.node_env())
        require(result.returncode == 0 and len(result.stdout) <= MAX_FRAME, 'CURRENT_SQL_CONTRACT')
        return self.h.signed_exact_json(result.stdout)

    def prepare(self):
        self.live()
        require(not self.evidence.exists(), 'PREVIOUS_J01_ATTEMPT_PRESERVED')
        self.evidence.mkdir(mode=0o700)
        self.save('intent.json', {'runId': self.run_id, 'head': self.packet['head'], 'packetSha256': sha(self.packet_raw),
            'bindingSha256': self.packet['bindingSha256'], 'originalProvisionReceiptSha256': self.packet['provisionReceiptSha256'],
            'nodeSha256': self.packet['nodeSha256'], 'callerSha256': self.packet['callerSha256'], 'originalAuthSixRetained': True,
            'bridgeProgramSha256': sha(NODE_PROGRAM.encode()), 'actualNaver': 'NOT_RUN'})
        self.outer_baseline = self.native_snapshot()
        self.save('outer-baseline-private.json', self.outer_baseline)
        for index, account in enumerate(self.binding['accounts'][:2]):
            self.live()
            status, actual = self.ports.request('GET', '/user', token=account['accessToken'])
            require(status == 200 and actual.get('id') == account['userId'] and actual.get('role') == 'authenticated'
                    and actual.get('is_anonymous') is not True and self.ports.session_proof(account), 'ORIGINAL_AUTH_SESSION')
            u = fixed_uuid(account['userId'])
            observed = json.loads(self.ports.read_sql("select coalesce(jsonb_agg(jsonb_build_object('episodeId',e.id,'identityId',e.identity_id,'otherSha256',encode(sha256(convert_to((to_jsonb(e)-'identity_id')::text,'UTF8')),'hex'))),'[]'::jsonb)from private.member_episodes e where profile_id=" + quoted(u) + '::uuid and ended_at is null;', timeout=5))
            require(len(observed) == 1 and observed[0]['identityId'] is None and is_sha(observed[0]['otherSha256']), 'FRESH_SELECTED_EPISODE')
            subject = 'J01-synthetic-' + self.run_id + '-' + u
            intent = {'userId': u, 'episodeId': fixed_uuid(observed[0]['episodeId']), 'otherSha256': observed[0]['otherSha256'], 'subject': subject}
            self.identity_intents.append(intent)
            self.save('identity-' + str(index) + '-intent.json', intent)
            self.live()
            q = quoted
            statement = "begin;do $$declare k uuid;n integer;begin if exists(select 1 from private.naver_accounts where subject=" + q(subject) + ")then raise exception 'j01_identity_exists';end if;perform 1 from private.member_episodes e where e.id=" + q(intent['episodeId']) + "::uuid and e.profile_id=" + q(u) + "::uuid and e.ended_at is null and e.identity_id is null and encode(sha256(convert_to((to_jsonb(e)-'identity_id')::text,'UTF8')),'hex')=" + q(intent['otherSha256']) + " for update;if not found then raise exception 'j01_episode_cas';end if;insert into private.naver_accounts(subject,verification_status)values(" + q(subject) + ",'information_required');select id into strict k from private.naver_identity_keys where subject=" + q(subject) + ";update private.member_episodes set identity_id=k where id=" + q(intent['episodeId']) + "::uuid and profile_id=" + q(u) + "::uuid and identity_id is null and ended_at is null;get diagnostics n=row_count;if n<>1 then raise exception 'j01_episode_cas';end if;end;$$;commit;"
            self.ports.sql(statement)
            attached = self.identity_state(intent)
            require(attached is not None and attached['episodeIdentityId'] == attached['identityId'], 'IDENTITY_ATTACH_PROOF')
            self.identity_created[index] = dict(attached)
            self.save('identity-' + str(index) + '-created.json', {**intent, **attached, 'syntheticIdentity': True, 'naverQualified': False})
            self.members.append({'userId': u, 'token': account['accessToken'], 'identityId': attached['identityId']})
        self.j01_baseline = self.native_snapshot()
        self.save('j01-baseline-private.json', self.j01_baseline)
        contract = self.sql_contract()
        self.allowed_sql = {sha(contract['seed']['sql'].encode()): ('seed', contract['seed']['sql']), sha(contract['inventory'].encode()): ('inventory', contract['inventory'])}
        self.source_prefix = contract['seed']['sourcePrefix']
        self.inventory_sql = contract['inventory']
        self.live()

    def identity_state(self, intent):
        q = quoted
        value = json.loads(self.ports.read_sql("select coalesce(jsonb_agg(jsonb_build_object('identityId',k.id,'episodeIdentityId',e.identity_id,'accountSha256',encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex'))),'[]'::jsonb)from private.naver_accounts a join private.naver_identity_keys k on k.subject=a.subject join private.member_episodes e on e.id=" + q(intent['episodeId']) + "::uuid and e.profile_id=" + q(intent['userId']) + "::uuid where a.subject=" + q(intent['subject']) + " and a.user_id is null and a.verification_status='information_required'and a.completed_at is null and a.real_name is null and a.birth_date is null and a.gender is null;", timeout=5))
        require(len(value) <= 1, 'IDENTITY_RESOLUTION')
        return value[0] if value else None

    def native_snapshot(self):
        native = self.ports.snapshot()
        # 사적 실패 기록에는 행 원문 대신 마지막 관측의 범위/건수/해시만 남긴다.
        self.last_native_snapshot = {'observedAtUnixSeconds': int(time.time()), 'snapshotSha256': digest(native),
            'tables': {name: {'rowCount': sum(bag.values()), 'sha256': digest(bag)} for name, bag in native['rows'].items()},
            **{key: native[key] for key in ('authoritySha256', 'catalogSha256', 'constraintsSha256')}}
        return native

    def snapshot(self):
        self.live()
        native = self.native_snapshot()
        # Node 목록 계약은 네 schema만 읽는다. 외곽/정리 비교는 native 전체를 유지한다.
        rows = {name: bag for name, bag in native['rows'].items()
                if name.partition('.')[0] in ('auth', 'private', 'public', 'storage')}
        unknown = {k: rows[k] for k in ('private.ai_budget_reservations', 'private.ai_account_budget_reservations')}
        authority = native['authoritySha256']
        return {'scope': 'FULL_TARGET_LOGICAL_BASELINE', 'schemas': ['auth', 'private', 'public', 'storage'],
                'tables': {name: {'rowCount': sum(bag.values()), 'sha256': digest(bag)} for name, bag in rows.items()},
                'catalogSha256': digest({key: native[key] for key in ('catalogSha256', 'constraintsSha256')}),
                'rolesSha256': authority, 'existingUnknownSha256': digest(unknown)}

    def source_rows(self):
        prefix = 'PFJ01' + self.run_id.replace('-', '')
        statement = "select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'sourceId',s.source_id,'rowSha256',encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex'),'detailSha256',(select encode(sha256(convert_to(to_jsonb(d)::text,'UTF8')),'hex')from private.event_source_details d where d.source_event_id=s.id))order by s.source_id),'[]'::jsonb)from private.source_events s where s.provider='kopis'and s.source_id like " + quoted(prefix + '%') + ';'
        return json.loads(self.ports.read_sql(statement, timeout=5))

    def hidden_rows(self):
        identity = fixed_uuid(self.members[0]['identityId'])
        event_id = fixed_uuid(self.seed_data['ids']['15'])
        statement = "select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'rowSha256',encode(sha256(convert_to(to_jsonb(h)::text,'UTF8')),'hex'))),'[]'::jsonb)from private.member_hidden_targets h where identity_id=" + quoted(identity) + "::uuid and target_type='event'and target_id=" + quoted(event_id) + '::uuid;'
        return json.loads(self.ports.read_sql(statement, timeout=5))

    def sql(self, statement):
        self.live()
        require(isinstance(statement, str) and len(statement.encode()) <= MAX_FRAME, 'SQL_ARGUMENT')
        match = self.allowed_sql.get(sha(statement.encode()))
        require(match is not None and statement == match[1], 'SQL_NOT_CURRENT_SOURCE_CONTRACT')
        kind = match[0]
        if kind == 'inventory':
            return json.loads(self.ports.sql(statement))
        if kind == 'seed':
            require(not self.seed_attempted and not self.source_rows(), 'NO_SEED_REPLAY')
            self.seed_attempted = True
            self.save('seed-intent.json', {'runId': self.run_id, 'sqlSha256': sha(statement.encode()), 'sourcePrefix': self.source_prefix, 'singleSend': True})
            result = json.loads(self.ports.sql(statement))
            self.event_rows = self.source_rows()
            require(len(self.event_rows) == 17 and {x['id'] for x in self.event_rows} == set(result['ids'].values()), 'SEED_OWNED_ROWS')
            self.seed_data = result
            self.save('seed-owned.json', {'runId': self.run_id, 'rows': self.event_rows, 'sqlSha256': sha(statement.encode())})
            hide = self.sql_contract(result['ids']['15'])['hide']
            self.allowed_sql[sha(hide.encode())] = ('hide', hide)
            return result
        require(kind == 'hide' and self.seed_data is not None and not self.hide_attempted, 'NO_HIDE_REPLAY')
        require(not self.hidden_rows(), 'HIDDEN_SCOPE_ALREADY_PRESENT')
        self.hide_attempted = True
        self.save('hide-intent.json', {'runId': self.run_id, 'identityId': self.members[0]['identityId'], 'eventId': self.seed_data['ids']['15'], 'singleSend': True})
        self.ports.sql(statement)
        hidden = self.hidden_rows()
        require(len(hidden) == 1 and is_sha(hidden[0]['rowSha256']), 'HIDDEN_OWNERSHIP_NOT_PROVEN')
        self.hidden_row = {'id': fixed_uuid(hidden[0]['id']), 'rowSha256': hidden[0]['rowSha256']}
        self.save('hide-owned.json', {'runId': self.run_id, **self.hidden_row})
        return None

    def cleanup_events(self):
        self.live()
        rows = self.source_rows()
        if not rows:
            require(not hasattr(self, 'j01_baseline') or self.native_snapshot() == self.j01_baseline, 'EMPTY_EVENT_SCOPE_BASELINE_CHANGED')
            return {'eventsAbsent': True}
        require(self.seed_attempted and self.event_rows is not None and rows == self.event_rows, 'EVENT_OWNERSHIP_UNKNOWN_PRESERVED')
        ids = [fixed_uuid(x['id']) for x in rows]
        id_sql = ','.join(quoted(x) + '::uuid' for x in ids)
        identity = fixed_uuid(self.members[0]['identityId'])
        event_id = fixed_uuid(self.seed_data['ids']['15'])
        hidden = self.hidden_rows()
        expected_hidden = [self.hidden_row] if self.hidden_row is not None else []
        require(hidden == expected_hidden, 'HIDDEN_CHANGED_UNKNOWN_PRESERVED')
        self.save('event-cleanup-intent.json', {'runId': self.run_id, 'eventIds': ids, 'hiddenIdentityId': identity, 'hiddenEventId': event_id, 'rows': self.event_rows, 'hiddenRows': expected_hidden})
        q = quoted
        expected_rows = q(canonical(self.event_rows).decode()) + '::jsonb'
        hidden_json = q(canonical(expected_hidden).decode()) + '::jsonb'
        identity_cas = ''
        for index, intent in enumerate(self.identity_intents):
            attached = self.identity_created[index]
            identity_cas += "perform 1 from private.naver_accounts a join private.naver_identity_keys k on k.subject=a.subject join private.member_episodes e on e.identity_id=k.id where a.subject=" + q(intent['subject']) + " and a.user_id is null and a.verification_status='information_required'and a.completed_at is null and encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex')=" + q(attached['accountSha256']) + " and k.id=" + q(fixed_uuid(attached['identityId'])) + "::uuid and e.id=" + q(intent['episodeId']) + "::uuid and e.profile_id=" + q(intent['userId']) + "::uuid and e.ended_at is null and encode(sha256(convert_to((to_jsonb(e)-'identity_id')::text,'UTF8')),'hex')=" + q(intent['otherSha256']) + " for update of a,k,e;if not found then raise exception 'j01_cleanup_identity_cas';end if;"
        statement = "begin;lock table private.source_events,private.event_source_details,private.member_hidden_targets in share row exclusive mode;do $$declare observed jsonb;n integer;begin " + identity_cas + "select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'sourceId',s.source_id,'rowSha256',encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex'),'detailSha256',(select encode(sha256(convert_to(to_jsonb(d)::text,'UTF8')),'hex')from private.event_source_details d where d.source_event_id=s.id))order by s.source_id),'[]'::jsonb)into observed from private.source_events s where s.provider='kopis'and s.source_id like " + q(self.source_prefix + '%') + ";if observed is distinct from " + expected_rows + " then raise exception 'j01_event_cleanup_cas';end if;select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'rowSha256',encode(sha256(convert_to(to_jsonb(h)::text,'UTF8')),'hex'))),'[]'::jsonb)into observed from private.member_hidden_targets h where identity_id=" + q(identity) + "::uuid and target_type='event'and target_id=" + q(event_id) + "::uuid;if observed is distinct from " + hidden_json + " then raise exception 'j01_hidden_cleanup_cas';end if;delete from private.member_hidden_targets where identity_id=" + q(identity) + "::uuid and target_type='event'and target_id=" + q(event_id) + "::uuid;get diagnostics n=row_count;if n<>" + str(len(expected_hidden)) + " then raise exception 'j01_hidden_cleanup_count';end if;delete from private.source_events where id=any(array[" + id_sql + "])and provider='kopis'and source_id like " + q(self.source_prefix + '%') + ";get diagnostics n=row_count;if n<>17 then raise exception 'j01_event_cleanup_count';end if;end;$$;commit;"
        self.ports.sql(statement)
        require(not self.source_rows(), 'EVENT_DELETE_NOT_PROVEN')
        require(self.native_snapshot() == self.j01_baseline, 'J01_BASELINE_NOT_RESTORED')
        self.save('event-cleanup-closed.json', {'runId': self.run_id, 'eventsAbsent': True, 'j01BaselineRestored': True, 'authSixDeleted': False})
        return {'eventsAbsent': True}

    def restore_identities(self):
        self.live()
        for index, intent in reversed(list(enumerate(self.identity_intents))):
            observed = self.identity_state(intent)
            if observed is None:
                continue
            k = fixed_uuid(observed['identityId'])
            require(index in self.identity_created and observed == self.identity_created[index] and observed['episodeIdentityId'] == k, 'IDENTITY_CHANGED_UNKNOWN_PRESERVED')
            q = quoted
            self.save('identity-' + str(index) + '-restore-intent.json', {**intent, 'identityId': k})
            statement = "begin;lock table private.member_hidden_targets in share row exclusive mode;do $$declare n integer;begin perform 1 from private.naver_accounts a where a.subject=" + q(intent['subject']) + " and a.user_id is null and a.verification_status='information_required'and a.completed_at is null and encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex')=" + q(self.identity_created[index]['accountSha256']) + " for update;if not found then raise exception 'j01_restore_account_cas';end if;if exists(select 1 from private.member_hidden_targets where identity_id=" + q(k) + "::uuid)then raise exception 'j01_restore_hidden_unknown';end if;update private.member_episodes e set identity_id=null where e.id=" + q(intent['episodeId']) + "::uuid and e.profile_id=" + q(intent['userId']) + "::uuid and e.identity_id=" + q(k) + "::uuid and e.ended_at is null and encode(sha256(convert_to((to_jsonb(e)-'identity_id')::text,'UTF8')),'hex')=" + q(intent['otherSha256']) + ";get diagnostics n=row_count;if n<>1 then raise exception 'j01_restore_cas';end if;delete from private.naver_identity_keys where id=" + q(k) + "::uuid and subject=" + q(intent['subject']) + ";get diagnostics n=row_count;if n<>1 then raise exception 'j01_restore_key';end if;delete from private.naver_accounts a where a.subject=" + q(intent['subject']) + " and a.user_id is null and a.verification_status='information_required'and a.completed_at is null and encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex')=" + q(self.identity_created[index]['accountSha256']) + ";get diagnostics n=row_count;if n<>1 then raise exception 'j01_restore_account';end if;end;$$;commit;"
            self.ports.sql(statement)
            require(self.identity_state(intent) is None, 'IDENTITY_ABSENCE_NOT_PROVEN')
            self.save('identity-' + str(index) + '-restore-closed.json', {'runId': self.run_id, 'episodeId': intent['episodeId'], 'originalNullRestored': True, 'syntheticIdentityAbsent': True})
        require(self.native_snapshot() == self.outer_baseline, 'OUTER_BASELINE_NOT_RESTORED')

    def read_tls(self):
        if not getattr(self, 'tls_created', False):
            key, cert = self.evidence / 'bridge.key', self.evidence / 'bridge.crt'
            self.live()
            result = subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], capture_output=True, timeout=15)
            require(result.returncode == 0, 'LOCAL_TLS_PREPARATION')
            key.chmod(0o600)
            cert.chmod(0o600)
            self.tls_created = True
        return {'key': self.h.signed_private_read(self.evidence / 'bridge.key').decode(), 'cert': self.h.signed_private_read(self.evidence / 'bridge.crt').decode()}

    def dispatch(self, frame):
        require(type(frame) is dict and set(frame) == {'type', 'requestId', 'sequence', 'method', 'args'}
                and frame['type'] == 'call' and frame['requestId'] == self.run_id
                and type(frame['sequence']) is int and frame['sequence'] == self.sequence + 1
                and frame['method'] in METHODS and type(frame['args']) is list, 'FIXED_METHOD_REQUEST')
        self.sequence += 1
        method, args = frame['method'], frame['args']
        require(len(args) == (2 if method in ('readSyntheticMembers', 'sql') else 1) and args[0] == self.input['target'], 'METHOD_TARGET_ARGUMENT')
        self.live()
        if method == 'verifyTarget':
            value = self.live()
        elif method == 'readCredentials':
            value = self.binding['credentials']
        elif method == 'readSyntheticMembers':
            require(type(args[1]) is int and args[1] == 2, 'SELECT_TWO_ONLY')
            value = self.members
        elif method == 'sql':
            value = self.sql(args[1])
        elif method == 'snapshot':
            value = self.snapshot()
        elif method == 'cleanupScope':
            value = self.cleanup_events()
        else:
            value = self.read_tls()
        self.observations.append({'sequence': self.sequence, 'method': method, 'outcome': 'RESPONSE_OBSERVED'})
        return {'requestId': self.run_id, 'sequence': self.sequence, 'ok': True, 'value': value}

    def invoke_node(self):
        self.child = subprocess.Popen([str(self.node), '--experimental-strip-types', '--input-type=module', '-e', NODE_PROGRAM],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1, env=self.node_env())
        self.child.stdin.write(json.dumps({'requestId': self.run_id, 'input': self.input}) + '\n')
        self.child.stdin.flush()
        selector = selectors.DefaultSelector()
        selector.register(self.child.stdout, selectors.EVENT_READ)
        proof = None
        try:
            while True:
                require(selector.select(timeout=45), 'NODE_BROKER_TIMEOUT')
                line = self.child.stdout.readline(MAX_FRAME + 1)
                require(line and len(line.encode()) <= MAX_FRAME, 'NODE_FRAME')
                frame = self.h.signed_exact_json(line.encode())
                if frame.get('type') in ('result', 'failure'):
                    require(frame.get('requestId') == self.run_id and frame.get('sequence') == self.sequence, 'NODE_TERMINAL_SCOPE')
                    require(frame['type'] == 'result', 'NODE_ROUNDTRIP_FAILED')
                    proof = frame['proof']
                    require(proof.get('scope') == 'ROOT_TYPED_BOUNDARY_CHECKS_ONLY' and proof.get('executionEvidence') == 'ROOT_ATTESTATION_REQUIRED', 'NO_FAKE_LIVE_PASS')
                    break
                try:
                    response = self.dispatch(frame)
                except Exception as error:
                    method = frame.get('method')
                    self.observations.append({'sequence': self.sequence, 'method': method if type(method) is str and method in METHODS else 'invalid', 'outcome': 'REJECTED_NO_RETRY', 'failureCode': safe_code(error)})
                    response = {'requestId': self.run_id, 'sequence': self.sequence, 'ok': False, 'error': 'J01_ROOT_FIXED_METHOD_REJECTED'}
                self.child.stdin.write(json.dumps(response) + '\n')
                self.child.stdin.flush()
            require(self.child.wait(timeout=10) == 0, 'NODE_EXIT')
        finally:
            selector.close()
            if self.child.poll() is None:
                self.child.terminate()
                try:
                    self.child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=5)
        return proof

    def run(self):
        proof, failed = None, None
        execution_failure, cleanup_failure = None, None
        try:
            self.prepare()
            proof = self.invoke_node()
        except Exception as error:
            execution_failure = safe_code(error)
            failed = 'J01_ROOT_EXECUTION_NOT_CLOSED'
        finally:
            if self.evidence.exists():
                try:
                    if self.seed_attempted:
                        self.cleanup_events()
                    if self.identity_intents:
                        self.restore_identities()
                except Exception as error:
                    cleanup_failure = safe_code(error)
                    failed = 'J01_ROOT_OWNED_STATE_UNKNOWN_PRESERVED'
                self.save('finalization.json', {'runId': self.run_id, 'failed': failed, 'originalAuthSixRetained': True,
                    'executionFailureCode': execution_failure, 'cleanupFailureCode': cleanup_failure,
                    'lastCompletedSourceCheck': self.last_completed_source_check,
                    'lastObservedNativeSnapshot': self.last_native_snapshot,
                    'observedCalls': self.observations, 'sourceHead': self.packet['head'], 'noNewAuthIssue': True})
        require(failed is None and proof is not None, 'PRIVATE_EVIDENCE_PRESERVED')
        self.save('receipt.json', {'status': 'J01_ROOT_CALL_OBSERVATIONS_CLOSED', 'executionEvidence': 'ROOT_ATTESTATION_REQUIRED',
            'runId': self.run_id, 'sourceHead': self.packet['head'], 'packetSha256': sha(self.packet_raw),
            'originalProvisionReceiptSha256': self.packet['provisionReceiptSha256'], 'nodeProgramSha256': sha(NODE_PROGRAM.encode()),
            'proof': proof, 'observedCalls': self.observations, 'identityTwoRestored': True, 'originalAuthSixRetained': True,
            'actualNaver': 'NOT_RUN', 'providers': 'NOT_RUN', 'authSixOuterCleanup': 'ROOT_SEPARATE_SCOPE'})
        return {'status': 'J01_ROOT_CALL_OBSERVATIONS_CLOSED', 'executionEvidence': 'ROOT_ATTESTATION_REQUIRED', 'runId': self.run_id,
                'identityTwoRestored': True, 'originalAuthSixRetained': True, 'actualNaver': 'NOT_RUN', 'providers': 'NOT_RUN'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--reviewed', type=Path)
    args = parser.parse_args()
    if not args.run:
        print(json.dumps({'status': 'NOT_RUN', 'ready': False, 'methods': sorted(METHODS), 'vmStarted': False,
                          'credentialReads': 0, 'actualAuth': 'NOT_RUN', 'actualDatabase': 'NOT_RUN'}))
        return 0
    try:
        require(args.reviewed is not None, 'REVIEWED_OBJECT_REQUIRED')
        print(json.dumps(RootJ01Boundary(args.reviewed).run()))
        return 0
    except Exception:
        print(json.dumps({'status': 'BLOCKED', 'executionEvidence': 'ROOT_ATTESTATION_REQUIRED', 'error': 'J01_ROOT_NOT_CLOSED',
                          'stateEvidence': 'PRIVATE_REVIEW_REQUIRED'}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
