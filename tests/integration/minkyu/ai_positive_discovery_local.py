"""새 Auth6의 실제 검색·성향·재조회 전용 typed 실행. 기본 CLI는 NOT_RUN이다."""
import ast
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
SELF = 'tests/integration/minkyu/ai_positive_discovery_local.py'
FACTORY = 'tests/integration/jonghyun/isolated_ai_factory.ts'
SCOPE = 'SIGNED_POSITIVE_DISCOVERY_ONLY'
CASE_TASKS = {'semantic': ['intent', 'preference_match', 'preference_match', 'explanation'],
    'judgment_failure': ['intent', 'preference_match'], 'output_privacy': ['intent'],
    'recheck_change': ['intent', 'preference_match', 'preference_match', 'explanation']}
BUDGET = ('ai_budget_ledgers', 'ai_budget_reservations', 'ai_account_budget_reservations', 'ai_account_daily_budget', 'ai_global_daily_budget')
OWN = ('public.posts', 'private.profile_traits', 'private.ai_member_processing', 'private.ai_chat_requests',
       'private.ai_member_daily_usage', 'private.ai_result_receipts')


def require(value, code):
    if not value: raise ValueError(code)


def raw_json(raw):
    def unique(items):
        out = {}
        for key, value in items:
            require(key not in out, 'POSITIVE_DUPLICATE_JSON'); out[key] = value
        return out
    return json.loads(raw, object_pairs_hook=unique,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError('POSITIVE_NONFINITE_JSON')))


def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
def sha(raw): return hashlib.sha256(raw).hexdigest()


def source_pins(expected_head=None):
    """기존 observer의 전체 tracked source guard를 그대로 실행한 뒤 신규 driver도 HEAD에 묶는다."""
    head = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], timeout=15, text=True).strip()
    require(re.fullmatch('[a-f0-9]{40}', head) and (expected_head is None or head == expected_head), 'POSITIVE_HEAD_CHANGED')
    observer = ROOT / 'tools/local/observe_isolated.py'
    original = subprocess.check_output(['git', '-C', str(ROOT), 'show', head + ':tools/local/observe_isolated.py'], timeout=15)
    require(observer.resolve() == observer and observer.read_bytes() == original, 'POSITIVE_OBSERVER_NOT_COMMITTED')
    nodes = [n for n in ast.parse(original).body if isinstance(n, ast.FunctionDef) and n.name == 'source_pins']
    require(len(nodes) == 1, 'POSITIVE_OBSERVER_GUARD_MISSING')
    namespace = dict(ROOT=ROOT, subprocess=subprocess, hashlib=hashlib)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(observer), 'exec'), namespace)
    pins = namespace['source_pins']()
    ai_path = ROOT / 'tests/integration/jonghyun/isolated_ai_contracts.py'
    ai_raw = ai_path.read_bytes()
    require(sha(ai_raw) == pins[str(ai_path.relative_to(ROOT))], 'POSITIVE_SIGNED_CONTRACT_CHANGED')
    names = {'product_graph', 'signed_source_pins'}
    nodes = [n for n in ast.parse(ai_raw).body if isinstance(n, ast.FunctionDef) and n.name in names]
    require({n.name for n in nodes} == names, 'POSITIVE_SIGNED_CONTRACT_MISSING')
    namespace = dict(REPO=ROOT, hashlib=hashlib, re=re)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(ai_path), 'exec'), namespace)
    required = {**namespace['signed_source_pins'](), SELF: sha((ROOT / SELF).read_bytes())}
    # 기존 observer와 signed Auth 원 계약을 모두 검사한다. 호출자가 필요한 경로를 생략할 수 없다.
    for relative, expected in required.items():
        if relative in pins:
            require(pins[relative] == expected, 'POSITIVE_SIGNED_SOURCE_CHANGED'); continue
        original = subprocess.check_output(['git', '-C', str(ROOT), 'show', head + ':' + relative], timeout=15, stderr=subprocess.DEVNULL)
        require((ROOT / relative).resolve() == ROOT / relative and (ROOT / relative).read_bytes() == original
                and sha(original) == expected, 'POSITIVE_REQUIRED_SOURCE_NOT_COMMITTED')
        pins[relative] = expected
    require(subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], timeout=15, text=True).strip() == head,
            'POSITIVE_HEAD_CHANGED')
    return head, pins


class ReviewedPositiveDiscovery:
    def __init__(self, decision_id, root, source_head, pins, binding_sha256, auth6_receipt, auth6_receipt_sha256,
                 capsule_root, node_path, node_sha256, scope_id, daemon_id):
        root = Path(root); capsule = Path(capsule_root); receipt = Path(auth6_receipt)
        require(type(decision_id) is str and re.fullmatch('[A-Za-z0-9_.:-]{1,128}', decision_id), 'POSITIVE_DECISION')
        require(root.is_absolute() and root.resolve() == root and not root.is_relative_to(ROOT), 'POSITIVE_ROOT')
        require(capsule.is_absolute() and capsule.resolve() == capsule and Path('/private/tmp') in capsule.parents
                and capsule.parent != Path('/private/tmp') and not capsule.is_relative_to(ROOT) and not capsule.is_relative_to(root)
                and not root.is_relative_to(capsule), 'POSITIVE_CAPSULE_ROOT')
        require(receipt.is_absolute() and receipt.resolve() == receipt and receipt.name == 'receipt.json'
                and re.fullmatch('auth-provision-[a-f0-9]{32}', receipt.parent.name)
                and receipt.parent.parent == root, 'POSITIVE_ORIGINAL_RECEIPT_PATH')
        require(type(source_head) is str and re.fullmatch('[a-f0-9]{40}', source_head)
                and type(pins) is dict and SELF in pins and FACTORY in pins
                and all(type(v) is str and re.fullmatch('[a-f0-9]{64}', v) for v in pins.values()), 'POSITIVE_SOURCE_REVIEW')
        require(all(type(v) is str and re.fullmatch('[a-f0-9]{64}', v)
                for v in (binding_sha256, auth6_receipt_sha256, node_sha256)), 'POSITIVE_SHA')
        require(type(scope_id) is str and re.fullmatch('[a-f0-9]{32}', scope_id), 'POSITIVE_SCOPE_ID')
        require(type(daemon_id) is str and str(uuid.UUID(daemon_id)) == daemon_id, 'POSITIVE_DAEMON_ID')
        node = Path(node_path)
        require(node.is_absolute() and node.resolve() == node and node.name == 'node', 'POSITIVE_NODE_PATH')
        self._sealed = canonical(dict(decisionId=decision_id, root=str(root), sourceHead=source_head, pins=pins,
            bindingSha256=binding_sha256, auth6Receipt=str(receipt), auth6ReceiptSha256=auth6_receipt_sha256,
            capsuleRoot=str(capsule), nodePath=str(node), nodeSha256=node_sha256, scopeId=scope_id, daemonId=daemon_id))

    def descriptor(self): return raw_json(self._sealed)


def support(reviewed):
    require(type(reviewed) is ReviewedPositiveDiscovery, 'POSITIVE_TYPED_REVIEW_REQUIRED')
    value = reviewed.descriptor()
    require(source_pins(value['sourceHead'])[1] == value['pins'], 'POSITIVE_SOURCE_CHANGED')
    sys.path.insert(0, str(ROOT / 'tools/local'))
    modules = {}
    for name, relative in (('run_database_tests', 'tools/local/run_database_tests.py'),
            ('positive_ai', 'tests/integration/jonghyun/isolated_ai_contracts.py'),
            ('positive_private', 'tools/local/prepare_auth_negative.py')):
        path = ROOT / relative; raw = path.read_bytes()
        require(sha(raw) == value['pins'][relative], 'POSITIVE_DEPENDENCY_CHANGED')
        module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader=None))
        module.__file__ = str(path)
        if name == 'run_database_tests': sys.modules[name] = module
        exec(compile(raw, str(path), 'exec'), module.__dict__); modules[name] = module
    ai = modules['positive_ai']
    require(all(value['pins'].get(k) == v for k, v in ai.signed_source_pins().items()), 'POSITIVE_SIGNED_SOURCE_CHANGED')
    return ai, modules['positive_private']


def verify_result(fixture, result):
    require(type(result) is dict and result.get('status') == 'PASS' and result.get('scope') == SCOPE
            and type(result.get('nativeExternalAttempts')) is int and result['nativeExternalAttempts'] == 0
            and type(result.get('mutationCount')) is int and result['mutationCount'] == 1
            and result.get('actualAuthPostgrestProductFactory') is True
            and result.get('actualNaver') == result.get('actualProviderQuality') == 'NOT_RUN', 'POSITIVE_FACTORY_RESULT')
    cases = result.get('cases')
    require(type(cases) is list and [c.get('case') for c in cases] == list(CASE_TASKS), 'POSITIVE_EXACT_CASES')
    request_ids, reservations = set(), set()
    for case in cases:
        name = case['case']; success = name in ('semantic', 'recheck_change')
        expected_cards = [fixture['postIds'][2], fixture['postIds'][0]] if name == 'semantic' else [fixture['postIds'][2]] if name == 'recheck_change' else []
        require(case['modelTasks'] == CASE_TASKS[name] and case['cardIds'] == expected_cards
                and case['resultStatus'] == ('results' if success else 'unavailable')
                and type(case['resultCount']) is int and case['resultCount'] == int(success)
                and type(case['authReads']) is int and case['authReads'] == 1
                and case['finishOutcome'] == ('output_privacy' if name == 'output_privacy' else 'finished')
                and case['originalTokenSha256'] == sha(fixture['accounts'][0]['accessToken'].encode()), 'POSITIVE_CASE_PROOF')
        require(len(case['requests']) == 1 and len(case['reservations']) == len(CASE_TASKS[name]), 'POSITIVE_EXACT_EFFECT_COUNT')
        rid = case['requests'][0]['requestId']; require(str(uuid.UUID(rid)) == rid and rid not in request_ids, 'POSITIVE_REQUEST_ID'); request_ids.add(rid)
        for row, task in zip(case['reservations'], CASE_TASKS[name]):
            identifier = row['reservationId']
            require(str(uuid.UUID(identifier)) == identifier and identifier not in reservations and row['task'] == task
                    and row['dispatched'] is True and row['settled'] is True
                    and type(row['units']) is int and row['units'] > 0, 'POSITIVE_RESERVATION_PROOF')
            reservations.add(identifier)
    return cases


def unchanged_except(before, after, excluded):
    require(set(before) == set(after) and all(before[k] == after[k] for k in before if k != 'rows')
            and set(before['rows']) == set(after['rows']) and len(before['rows']) == 178,
            'POSITIVE_AUTHORITY_OR_INVENTORY_CHANGED')
    require(all(after['rows'][table] == bag for table, bag in before['rows'].items() if table not in excluded),
            'POSITIVE_UNOWNED_ROW_CHANGED')


class PositiveRun:
    def __init__(self, reviewed):
        self.deadline = time.monotonic() + 300
        self.reviewed = reviewed; self.value = reviewed.descriptor(); self.root = Path(self.value['root'])
        self.ai, self.private_module = support(reviewed); self.ai.private_temp_root(self.root)
        self.writer = object.__new__(self.private_module.FixedPair); self.writer.ai = self.ai
        self.failures = []; self.samples = []; self.done = threading.Event(); self.child = None; self.thread = None
        self.r = None; self.port = None; self.fixture = None; self.before = None; self.setup = False
        self.cleanup_proof = {'status': 'NOT_PROVEN'}; self.factory_proof = None
        self.capture_threads = []; self.capture_failures = []; self.cleaning = False

    def read(self, path): return self.private_module.secure_private_bytes(Path(path), self.ai)
    def save(self, name, value): return self.writer.save(self.evidence, name, value)
    def live(self):
        require(not self.failures and not self.done.is_set(), 'POSITIVE_MEMORY_MONITOR')
        require(time.monotonic() < self.deadline, 'POSITIVE_OBSERVER_TIMEOUT')
        self.fixed_identity()
    def fixed_identity(self):
        # 메모리 실패 후에도 새 호출 없이 정확 소유 fixture를 닫을 수 있다. source/신원 검사는 유지한다.
        require(source_pins(self.value['sourceHead'])[1] == self.value['pins'], 'POSITIVE_SOURCE_CHANGED')
        if self.r is not None:
            require(self.r.call(['info', '--format', '{{.ID}}']) == self.value['daemonId'], 'POSITIVE_DAEMON_CHANGED')
            self.r.signed_identity()
    def memory(self, minimum):
        start = time.monotonic()
        p = subprocess.run(['colima', 'ssh', '--profile', 'yumidang-minkyu', '--', 'cat', '/proc/meminfo'],
                           capture_output=True, text=True, timeout=3)
        values = re.findall(r'^MemAvailable:\s+([0-9]+) kB$', p.stdout, re.M)
        require(p.returncode == 0 and len(values) == 1 and time.monotonic() - start <= 3, 'POSITIVE_MEMORY_PROBE')
        value = int(values[0]); self.samples.append(value); require(value >= minimum, 'POSITIVE_MEMORY_LIMIT')
    def monitor(self):
        while not self.done.is_set():
            start = time.monotonic()
            try: self.memory(786432)
            except BaseException: self.failures.append('POSITIVE_MEMORY_MONITOR'); return
            self.done.wait(max(0, start + 3 - time.monotonic()))
    def snapshot(self, cleanup=False):
        check = self.fixed_identity if cleanup else self.live
        check(); require(self.port.history() == {'method': 'SUPABASE_DB_HISTORY', 'native': 'NOT_RUN'}, 'POSITIVE_HISTORY')
        value = self.ai.lcp_snapshot(self.port.snapshot()); require(len(value['rows']) == 178, 'POSITIVE_FULL_178_REQUIRED')
        check(); return value
    def bind(self):
        raw = self.read(self.root / 'signed-ai-binding-private.json'); require(sha(raw) == self.value['bindingSha256'], 'POSITIVE_ORIGINAL_BINDING_CHANGED')
        receipt_raw = self.read(self.value['auth6Receipt']); require(sha(receipt_raw) == self.value['auth6ReceiptSha256'], 'POSITIVE_ORIGINAL_RECEIPT_CHANGED')
        receipt = raw_json(receipt_raw); binding = raw_json(raw)
        require(receipt['status'] == 'PASS_LOCAL_AUTH6_PROVISION_ONLY' and type(receipt['accounts']) is int and receipt['accounts'] == 6
                and receipt['bindingSha256'] == sha(raw) and receipt['actualGoTrueAndDatabaseSessions'] is True
                and receipt['originalRowsPreserved'] is True and receipt['actualNaver'] == 'NOT_RUN'
                and receipt['actualAI22AI23AI24'] == 'NOT_RUN' and receipt['authAccountsRetained'] is True
                and receipt['creationReceiptRoot'] == str(Path(self.value['auth6Receipt']).parent), 'POSITIVE_AUTH6_PROVENANCE')
        target = self.ai.signed_prepared_target(self.root); require(len(target['versions']) == 121, 'POSITIVE_CURRENT121')
        require(target['context'] == self.private_module.CONTEXT and target['host'] == self.private_module.HOST,
                'POSITIVE_FIXED_MINKYU_CONTEXT')
        observed = subprocess.run(['docker', '--host', target['host'], 'info', '--format', '{{.ID}}'],
            capture_output=True, text=True, timeout=3)
        require(observed.returncode == 0 and observed.stdout.strip() == self.value['daemonId'], 'POSITIVE_DAEMON_CHANGED')
        self.ai.validate_signed_binding(binding, self.root, target)
        require(all(a['expiresAt'] > time.time() + 900 for a in binding['accounts']), 'POSITIVE_NEW_ORIGINAL_TOKENS_REQUIRED')
        evidence = Path(binding['evidenceRoot'])
        require(evidence.parent == self.root and evidence.name == 'signed-auth-' + receipt['scopeId']
                and not evidence.exists() and not evidence.is_symlink(), 'POSITIVE_NO_REPLAY')
        evidence.mkdir(mode=0o700); self.evidence = evidence; self.binding_raw = raw; self.receipt_raw = receipt_raw
        self.save('positive-intent.json', {'scope': SCOPE, 'reviewSha256': sha(self.reviewed._sealed), 'sourceHead': self.value['sourceHead'],
            'originalBindingSha256': sha(raw), 'originalAuth6ReceiptSha256': sha(receipt_raw), 'noReplay': True, 'noResend': True})
        reviewed_ports = self.ai.ReviewedSignedProvisioning(self.value['decisionId'], self.root, binding['sourcePins'], binding['containers'], binding['credentials'], int(time.time()) + 900)
        self.ai.provisioning_metadata(reviewed_ports, target, binding['origin'])
        self.port = self.ai.FixedLifecycleProvisioningPorts(reviewed_ports)
        require(self.port.settings() == {'jwtExpirySeconds': 3600, 'anonymousEnabled': False, 'signupDisabled': True}, 'POSITIVE_AUTH_SETTINGS')
        require(self.port.closed_controls() == {**{k: False for k in self.ai.PROVISION_CLOSED_CONTROLS}, 'cronLaunchActiveJobs': 'off'},
                'POSITIVE_CLOSED_CONTROLS')
        owner = self
        class MonitoredSignedRunner(self.ai.SignedRunner):
            def active(self):
                if not owner.cleaning:
                    require(not owner.failures and not owner.done.is_set(), 'POSITIVE_MEMORY_MONITOR')
                    require(time.monotonic() < owner.deadline, 'POSITIVE_OBSERVER_TIMEOUT')
            def sql(self, statement):
                self.active(); value = super().sql(statement); self.active(); return value
            def auth_user(self, token):
                self.active(); value = super().auth_user(token); self.active(); return value
        self.r = MonitoredSignedRunner(self.root, binding); self.r.evidence = evidence
        return binding
    def capsule(self):
        pins = {**self.ai.product_graph(), FACTORY: self.value['pins'][FACTORY]}
        self.ai.sealed_runtime_capsule(self.value['sourceHead'], Path(self.value['capsuleRoot']), pins, pins)
        self.private_module.FixedPair.binary(self.writer, self.value['nodePath'], self.value['nodeSha256'], 'node')
    def prepare(self, binding):
        self.before = self.snapshot(); self.save('before-private.json', self.before)
        # 이 검증은 새 대상만 받는다. 기존 공고·성향·AI 원장을 덮어쓰지 않는다.
        counts = self.port.read_sql('select (select count(*)from public.posts)+(select count(*)from private.profile_traits)+' +
            '+'.join('(select count(*)from private.' + t + ')' for t in (*BUDGET, 'ai_chat_requests', 'ai_member_processing', 'ai_member_daily_usage', 'ai_result_receipts')) + ';')
        require(counts == '0', 'POSITIVE_FRESH_EMPTY_FIXTURE_REQUIRED')
        self.r.prepare(); self.live(); q = self.ai.quote
        scope = self.value['scopeId']; posts = [str(uuid.uuid4()) for _ in range(3)]; query = '합성긍정' + scope[:12]
        now = datetime.now(timezone.utc); times = [(now + timedelta(days=5)).isoformat(), (now + timedelta(days=5, hours=2)).isoformat(), (now + timedelta(days=4)).isoformat()]
        titles = [query + ' 차분', query + ' 활발', query + ' 미입력']; ledger = 'positive-' + scope
        self.expected_posts = []
        self.fixture_time = now.isoformat()
        self.fixture = {'scope': SCOPE, 'scopeId': scope, 'codeRoot': self.value['capsuleRoot'], 'origin': binding['origin'],
            'anon': binding['credentials']['anon'], 'service': binding['credentials']['service'], 'signedLocalAuth': True,
            'accounts': binding['accounts'], 'postIds': posts, 'titles': titles, 'query': query, 'ledger': ledger,
            'evidence': str(self.evidence), 'productManifest': self.ai.product_graph()}
        self.save('positive-fixture-plan-private.json', {'scope': SCOPE, 'postIds': posts, 'authorIds': [a['userId'] for a in binding['accounts'][1:4]],
            'titles': titles, 'dates': times, 'ledger': ledger, 'fixtureSqlIsNotNaverOrWriteApiProof': True})
        statements = ['begin;']
        for i, post in enumerate(posts):
            author = binding['accounts'][i + 1]['userId']
            created = (now - timedelta(minutes=3-i)).isoformat()
            self.expected_posts.append(dict(id=post, author_id=author, title=titles[i], description='AI_PRIVATE_CANARY', category='전시',
                starts_at=times[0], ends_at=times[1], recruitment_ends_at=times[2], public_area='서울특별시 종로구 삼청동',
                cost_type='free', amount=0, created_at=created, updated_at=self.fixture_time, preference_note=None,
                tags=[], capacity=2, status='recruiting', partner_gender='any', source_event_id=None))
            statements.append("insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,cost_type,amount,created_at,updated_at)values(" +
                ','.join([q(post) + '::uuid', q(author) + '::uuid', q(titles[i]), q('AI_PRIVATE_CANARY'), q('전시'), *[q(v) + '::timestamptz' for v in times], q('서울특별시 종로구 삼청동'), q('free'), '0', q(created) + '::timestamptz', q(self.fixture_time) + '::timestamptz']) + ');')
        for account, style in zip(binding['accounts'][1:3], ('차분한 대화', '활발한 수다')):
            statements.append('insert into private.profile_traits(profile_id,interests,conversation_styles,mbti,updated_at)values(' + q(account['userId']) + "::uuid,array['전시'],array[" + q(style) + "],'INFP'," + q(self.fixture_time) + '::timestamptz);')
        statements.append('insert into private.ai_budget_ledgers(ledger_id,unit_limit,call_limit)values(' + q(ledger) + ',100000000,64);commit;')
        self.save('positive-exact-row-plan-private.json', {'posts': self.expected_posts,
            'traits': [{'profile_id': a['userId'], 'interests': ['전시'], 'conversation_styles': [style], 'mbti': 'INFP', 'updated_at': self.fixture_time}
                for a, style in zip(binding['accounts'][1:3], ('차분한 대화', '활발한 수다'))]})
        self.setup = True; self.r.ledgers.append(ledger); self.r.sql(''.join(statements))
        self.setup_snapshot = self.snapshot(); self.save('setup-private.json', self.setup_snapshot)
        unchanged_except(self.before, self.setup_snapshot, {'public.posts', 'private.profile_traits',
            'private.ai_member_processing', 'private.ai_processing_guard', 'private.ai_budget_accounts', 'private.ai_budget_ledgers'})
        self.validate_fixture(False)
    def validate_fixture(self, changed):
        q = self.ai.quote; f = self.fixture
        records = raw_json(self.port.read_sql("select jsonb_build_object('posts',(select coalesce(jsonb_agg(to_jsonb(p)order by id),'[]'::jsonb)from public.posts p),'traits',(select coalesce(jsonb_agg(to_jsonb(t)order by profile_id),'[]'::jsonb)from private.profile_traits t));"))
        self.save('fixture-' + ('after' if changed else 'before') + '-private.json', records)
        if not changed: self.fixture_rows = records
        else:
            require(records['posts'] == self.fixture_rows['posts'], 'POSITIVE_POST_CHANGED_DURING_RECHECK')
        require(len(records['posts']) == 3 and {p['id'] for p in records['posts']} == set(f['postIds']) and len(records['traits']) == 2, 'POSITIVE_FIXTURE_SCOPE')
        for i, identifier in enumerate(f['postIds']):
            post = next(p for p in records['posts'] if p['id'] == identifier)
            expected = self.expected_posts[i]
            dates = ('starts_at', 'ends_at', 'recruitment_ends_at', 'created_at', 'updated_at')
            require(set(post) == set(expected) and all(post[k] == v for k,v in expected.items() if k not in dates)
                and all(datetime.fromisoformat(post[k].replace('Z','+00:00')) == datetime.fromisoformat(expected[k]) for k in dates),
                'POSITIVE_EXACT_PLANNED_POST')
            require(post['author_id'] == f['accounts'][i+1]['userId'] and post['title'] == f['titles'][i] and post['description'] == 'AI_PRIVATE_CANARY'
                    and post['public_area'] == '서울특별시 종로구 삼청동' and post['status'] == 'recruiting' and post['cost_type'] == 'free' and post['amount'] == 0,
                    'POSITIVE_POST_OWNER_OR_VALUE')
        for i, account in enumerate(f['accounts'][1:3]):
            row = next(t for t in records['traits'] if t['profile_id'] == account['userId'])
            require(set(row) == {'profile_id', 'interests', 'conversation_styles', 'mbti', 'updated_at'}
                    and row['interests'] == ['전시'] and row['conversation_styles'] == [('활발한 수다' if changed else '차분한 대화') if i == 0 else '활발한 수다']
                    and row['mbti'] == 'INFP', 'POSITIVE_TRAITS_EXACT_CHANGE')
            if not changed: require(datetime.fromisoformat(row['updated_at'].replace('Z','+00:00')) == datetime.fromisoformat(self.fixture_time), 'POSITIVE_EXACT_PLANNED_TRAIT')
            if changed:
                original = next(t for t in self.fixture_rows['traits'] if t['profile_id'] == row['profile_id'])
                require(set(row) == set(original) and all(row[k] == v for k, v in original.items()
                    if i != 0 or k not in ('conversation_styles', 'updated_at'))
                    and (i != 0 or row['updated_at'] != original['updated_at']), 'POSITIVE_TRAITS_UNPLANNED_DELTA')
    def invoke(self):
        self.capsule(); self.live(); self.memory(1048576)
        self.save('positive-factory-private.json', self.fixture)
        self.save('positive-factory-dispatch-intent.json', {'scope': SCOPE, 'mode': '--signed-positive-discovery', 'singleAttempt': True, 'noReplay': True})
        self.child = subprocess.Popen([self.value['nodePath'], '--experimental-strip-types', str(Path(self.value['capsuleRoot']) / FACTORY),
            str(self.evidence / 'positive-factory-private.json'), '--signed-positive-discovery'], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, env=self.ai.midnight_minimal_env(self.evidence))
        self.capture(self.child.stdout, 'positive-factory-stdout-private.json', 1024 * 1024)
        self.capture(self.child.stderr, 'positive-factory-stderr-private.json', 65536)
        while self.child.poll() is None:
            require(not self.failures and not self.capture_failures and time.monotonic() < self.deadline, 'POSITIVE_OBSERVER_TIMEOUT_OR_MEMORY')
            self.done.wait(.1)
        out, _ = self.finish_capture()
        require(not self.failures and not self.capture_failures and self.child.returncode == 0, 'POSITIVE_FACTORY_FAILED')
        result = raw_json(out); verify_result(self.fixture, result); self.save('positive-factory-proof.json', result)
        self.factory_proof = {'path': str(self.evidence / 'positive-factory-proof.json'),
            'sha256': sha(self.read(self.evidence / 'positive-factory-proof.json'))}
        self.capsule(); self.live(); return result
    def capture(self, stream, name, maximum):
        self.writer.save_bytes(self.evidence, name, b'')
        path = self.evidence / name; before = path.lstat()
        fd = os.open(path, os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            opened = os.fstat(fd)
            require(stat.S_ISREG(opened.st_mode) and opened.st_uid == os.getuid() and opened.st_nlink == 1
                and opened.st_mode & 0o777 == 0o600 and opened.st_size == 0
                and (before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino), 'POSITIVE_CAPTURE_FILE')
        except BaseException: os.close(fd); raise
        def drain():
            count = 0
            try:
                while True:
                    raw = stream.read(16384)
                    if not raw: break
                    remaining = maximum - count; payload = raw[:remaining]
                    while payload:
                        n = os.write(fd, payload); require(n > 0, 'POSITIVE_CAPTURE_WRITE'); count += n; payload = payload[n:]
                    if len(raw) > remaining:
                        self.capture_failures.append('POSITIVE_CAPTURE_LIMIT'); break
                os.fsync(fd)
            except BaseException: self.capture_failures.append('POSITIVE_CAPTURE_FAILED')
            finally: os.close(fd); stream.close()
        thread = threading.Thread(target=drain, daemon=True); self.capture_threads.append(thread); thread.start()
    def finish_capture(self):
        for thread in self.capture_threads: thread.join(timeout=2)
        require(all(not t.is_alive() for t in self.capture_threads), 'POSITIVE_CAPTURE_NOT_CLOSED')
        out = self.read(self.evidence / 'positive-factory-stdout-private.json')
        err = self.read(self.evidence / 'positive-factory-stderr-private.json')
        if not getattr(self, 'capture_saved', False):
            self.save('positive-factory-outcome.json', {'exitCode': self.child.returncode, 'stdoutSha256': sha(out), 'stderrSha256': sha(err),
                'stdoutBytes': len(out), 'stderrBytes': len(err), 'streamFailures': self.capture_failures,
                'stdoutLimit': 1024 * 1024, 'stderrLimit': 65536, 'privateRawOutputPreserved': True})
            self.capture_saved = True
        return out, err
    def proof(self, result):
        tables = ['ai_chat_requests', 'ai_result_receipts', 'ai_member_daily_usage', 'ai_member_processing', *BUDGET]
        query = 'select jsonb_build_object(' + ','.join(self.ai.quote(t) + ",(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)from private." + t + ' x)' for t in tables) + ');'
        data = raw_json(self.port.read_sql(query, timeout=5)); self.save('positive-db-proof-private.json', data)
        verify_database(self.fixture, result, data)
        canary = self.port.read_sql("select " + ' or '.join("exists(select 1 from private." + table + " r where strpos(to_jsonb(r)::text,'AI_DIALOGUE_CANARY')>0 or strpos(to_jsonb(r)::text,'AI_PRIVATE_CANARY')>0)" for table in tables) + ';')
        require(canary == 'f', 'POSITIVE_RAW_CONTENT_STORED')
        self.validate_fixture(True)
        after = self.snapshot(); self.save('after-private.json', after)
        unchanged_except(self.setup_snapshot, after, set(OWN) | {'private.' + t for t in BUDGET})
    def close_child(self):
        if self.child is None: return
        source = ROOT / 'tools/local/observe_isolated.py'; raw = source.read_bytes()
        require(sha(raw) == self.value['pins']['tools/local/observe_isolated.py'], 'POSITIVE_TERMINATOR_CHANGED')
        names = {'group_alive', 'terminate', 'verify_group_closed'}
        nodes = [n for n in ast.parse(raw).body if isinstance(n, ast.FunctionDef) and n.name in names]
        require({n.name for n in nodes} == names, 'POSITIVE_TERMINATOR_SET')
        ns = dict(os=os, signal=signal, subprocess=subprocess, time=time)
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec'), ns)
        ns['terminate'](self.child); require(self.child.poll() is not None and not ns['group_alive'](self.child), 'POSITIVE_CHILD_NOT_CLOSED')
        if self.capture_threads: self.finish_capture()
        self.save('positive-child-closed.json', {'exited': True, 'exitCode': self.child.returncode, 'exactOwnedSessionOnly': True}); self.child = None
    def clean(self):
        if self.r is None: return
        # 최종 전체 상태는 정리·판정 전에 저장한다. 실패해도 원 실패/UNKNOWN을 덮어쓰지 않는다.
        record = {'scope': SCOPE, 'status': 'UNAVAILABLE_NOT_PROOF'}
        errors = []
        try: record.update(status='CAPTURED_NOT_PROOF', snapshot=self.snapshot(cleanup=True))
        except BaseException: errors.append('POSITIVE_FINAL_CAPTURE_UNPROVEN')
        self.save('final-before-cleanup-private.json', record)
        require(self.child is None, 'POSITIVE_LIVE_CHILD_CLEANUP_DEFERRED')
        self.cleaning = True
        try:
            self.fixed_identity()
            if self.setup:
                q = self.ai.quote; ids = ','.join(q(x) + '::uuid' for x in self.fixture['postIds'])
                authors = ','.join(q(a['userId']) + '::uuid' for a in self.fixture['accounts'][1:3])
                self.save('positive-cleanup-intent.json', {'postIds': self.fixture['postIds'], 'traitOwners': [a['userId'] for a in self.fixture['accounts'][1:3]], 'authMutation': False})
                self.r.sql('begin;update private.ai_processing_guard set external_processing_allowed=false where singleton;delete from public.posts where id in(' + ids + ');delete from private.profile_traits where profile_id in(' + authors + ');commit;')
        except BaseException: errors.append('POSITIVE_OWNED_FIXTURE_CLEANUP_UNPROVEN')
        try: self.fixed_identity(); self.r.clean()
        except BaseException: errors.append('POSITIVE_STANDARD_CLEANUP_UNPROVEN')
        final = self.snapshot(cleanup=True); self.save('final-after-cleanup-private.json', final)
        require(self.before is not None, 'POSITIVE_BEFORE_SNAPSHOT_REQUIRED')
        unchanged_except(self.before, final, {'private.' + t for t in BUDGET})
        require(self.read(self.root / 'signed-ai-binding-private.json') == self.binding_raw
                and self.read(self.value['auth6Receipt']) == self.receipt_raw, 'POSITIVE_ORIGINAL_AUTH6_CHANGED')
        self.fixed_identity(); self.capsule(); require(not errors, 'POSITIVE_CLEANUP_OR_CAPTURE_UNPROVEN')
        self.cleanup_proof = {'status': 'PASS', 'finalSnapshotPath': str(self.evidence / 'final-after-cleanup-private.json'),
            'finalSnapshotSha256': sha(self.read(self.evidence / 'final-after-cleanup-private.json')),
            'beforeSnapshotSha256': sha(self.read(self.evidence / 'before-private.json')),
            'baselineReservationsSha256': sha(canonical({t: self.before['rows']['private.' + t] for t in BUDGET[1:3]})),
            'finalReservationsSha256': sha(canonical({t: final['rows']['private.' + t] for t in BUDGET[1:3]}))}


def verify_database(fixture, result, data):
    cases = verify_result(fixture, result); viewer = fixture['accounts'][0]['userId']; reqs = {c['requests'][0]['requestId']: c for c in cases}
    require(len(data['ai_chat_requests']) == 4 and {r['request_id'] for r in data['ai_chat_requests']} == set(reqs), 'POSITIVE_DB_REQUEST_SET')
    for row in data['ai_chat_requests']:
        case = reqs[row['request_id']]
        require(row['user_id'] == viewer and row['outcome'] == case['finishOutcome'] and row['finished_at'] is not None
                and row['started_at'] is not None and row['counted_day'] is not None
                and row['client_request_hash'] == sha(('positive-' + case['case'] + '-' + fixture['scopeId']).encode())
                and row['output_retry_of'] is None and row['retry_request_id'] is None
                and sha(row['lease_token'].encode()) == case['requests'][0]['leaseSha256'], 'POSITIVE_DB_REQUEST')
    expected_results = {c['requests'][0]['requestId'] for c in cases if c['resultCount'] == 1}
    require(len(data['ai_result_receipts']) == 2 and {r['request_id'] for r in data['ai_result_receipts']} == expected_results
            and all(r['user_id'] == viewer for r in data['ai_result_receipts']), 'POSITIVE_DB_RESULTS')
    require(len(data['ai_member_daily_usage']) == 1 and data['ai_member_daily_usage'][0]['user_id'] == viewer
            and type(data['ai_member_daily_usage'][0]['started_requests']) is int and data['ai_member_daily_usage'][0]['started_requests'] == 4,
            'POSITIVE_DB_DAILY_COUNT')
    require(len(data['ai_member_processing']) == 6 and {r['user_id'] for r in data['ai_member_processing']} == {a['userId'] for a in fixture['accounts']}
            and all(r['exploration_allowed'] is True and r['summary_allowed'] is False and all(r[k] is False for k in ('summary_view_allowed','summary_generate_allowed','summary_source_allowed')) and r['active_request_id'] is None for r in data['ai_member_processing']), 'POSITIVE_DB_MEMBER_SCOPE')
    expected = {r['reservationId']: r for c in cases for r in c['reservations']}
    days = {r['accountDay'] for r in expected.values()}
    require(len(days) == 1 and all(re.fullmatch(r'\d{4}-\d{2}-\d{2}', d) for d in days), 'POSITIVE_SINGLE_KST_DAY')
    day = next(iter(days))
    require(len(expected) == 11 and len(data['ai_account_budget_reservations']) == 11 and not data['ai_budget_reservations'], 'POSITIVE_UNKNOWN_OR_RESERVATION_SET')
    require({r['reservation_id'] for r in data['ai_account_budget_reservations']} == set(expected), 'POSITIVE_DB_RESERVATION_IDS')
    for row in data['ai_account_budget_reservations']:
        original = expected[row['reservation_id']]
        require(row['ledger_id'] == fixture['ledger'] and row['account_id'] == original['accountId'] and row['account_day'] == original['accountDay']
                and row['reserved_units'] == original['units'] and row['unknown_at'] is None and row['settled_at'] is not None
                and type(row['input_tokens']) is type(row['output_tokens']) is type(row['reserved_units']) is int
                and row['input_tokens'] == row['output_tokens'] == 1, 'POSITIVE_DB_RESERVATION')
    require(len(data['ai_budget_ledgers']) == 1, 'POSITIVE_DB_LEDGER_SET'); ledger = data['ai_budget_ledgers'][0]
    require(all(type(ledger[k]) is int for k in ('charged_units','reserved_units','open_calls','settled_calls','unknown_usage_calls'))
            and ledger['ledger_id'] == fixture['ledger'] and ledger['unit_limit'] == 100000000 and ledger['call_limit'] == 64
            and ledger['charged_units'] == 22 and ledger['reserved_units'] == 0
            and ledger['open_calls'] == 0 and ledger['settled_calls'] == 11 and ledger['unknown_usage_calls'] == 0,
            'POSITIVE_DB_LEDGER')
    for table in ('ai_account_daily_budget', 'ai_global_daily_budget'):
        require(len(data[table]) == 1 and data[table][0]['kst_day'] == day
                and type(data[table][0]['charged_units']) is type(data[table][0]['reserved_units']) is int
                and data[table][0]['charged_units'] == 22 and data[table][0]['reserved_units'] == 0,
                'POSITIVE_DB_DAILY_BUDGET')
    require(data['ai_account_daily_budget'][0]['account_id'] == 'yumi', 'POSITIVE_DB_ACCOUNT_ORDER')
    require(data['ai_member_daily_usage'][0]['kst_day'] == day and all(r['counted_day'] == day for r in data['ai_chat_requests']), 'POSITIVE_DB_KST_DAY')


def run_reviewed(reviewed):
    require(type(reviewed) is ReviewedPositiveDiscovery, 'POSITIVE_TYPED_REVIEW_REQUIRED')
    run = PositiveRun(reviewed); errors = []; result = None
    previous = signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(RuntimeError('POSITIVE_INTERRUPTED')))
    try:
        binding = run.bind(); run.memory(1048576)
        run.thread = threading.Thread(target=run.monitor, daemon=True); run.thread.start()
        run.prepare(binding); result = run.invoke(); run.close_child(); run.proof(result)
    except BaseException:
        errors.append('POSITIVE_EXECUTION_FAILED_NO_REPLAY')
    finally:
        try: run.close_child()
        except BaseException: errors.append('POSITIVE_CHILD_CLOSURE_UNPROVEN')
        try: run.clean()
        except BaseException: errors.append('POSITIVE_CLEANUP_UNPROVEN')
        run.done.set()
        if run.thread is not None:
            run.thread.join(timeout=4)
            if run.thread.is_alive(): errors.append('POSITIVE_MONITOR_NOT_CLOSED')
        errors.extend(run.failures)
        try:
            if hasattr(run, 'evidence'):
                cleanup = run.cleanup_proof
                run.save('positive-receipt.json', {'scope': SCOPE, 'status': 'FAIL' if errors else 'PASS', 'fixedFailures': errors,
                    'sourceHead': run.value['sourceHead'], 'memorySamples': run.samples, 'ownedChildClosed': run.child is None,
                    'sourceId': run.value['scopeId'], 'sourcePinsSha256': sha(canonical(run.value['pins'])),
                    'reviewSha256': sha(reviewed._sealed), 'root': str(run.root), 'capsuleRoot': run.value['capsuleRoot'],
                    'database': {'id': run.r.target['id'], 'project': run.r.target['project'], 'preparedRoot': str(run.root)} if run.r else None,
                    'originalAuth6ReceiptSha256': run.value['auth6ReceiptSha256'], 'originalBindingSha256': run.value['bindingSha256'],
                    'actualPhaseReceipt': run.factory_proof, 'fixtureCleanup': cleanup,
                    'originalRowsPreserved': {'status': cleanup['status'], 'beforeSnapshotSha256': cleanup.get('beforeSnapshotSha256'),
                        'finalSnapshotSha256': cleanup.get('finalSnapshotSha256')},
                    'unknownPreserved': {'status': cleanup['status'], 'baselineReservationsSha256': cleanup.get('baselineReservationsSha256'),
                        'finalReservationsSha256': cleanup.get('finalReservationsSha256')},
                    'modelScope': 'SYNTHETIC_IN_MEMORY_ONLY', 'actualNaver': 'NOT_RUN', 'actualProviderQuality': 'NOT_RUN',
                    'auth6RowsRetained': cleanup['status'], 'budgetRowsRetained': cleanup['status'], 'priorNegativeCasesReplayed': False, 'noReplay': True})
        finally: signal.signal(signal.SIGTERM, previous)
    require(not errors and result is not None, 'POSITIVE_FAILED_PRIVATE_EVIDENCE_PRESERVED')
    return result


if __name__ == '__main__':
    print(json.dumps({'scope': SCOPE, 'status': 'NOT_RUN', 'actualCalls': 0, 'reason': 'ROOT_TYPED_REVIEW_REQUIRED'}))
