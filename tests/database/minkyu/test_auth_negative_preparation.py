"""독립 익명/다른 인증 문맥 계약 회귀. 합성 입력만 사용하며 Docker/HTTP 실행 없음."""
import ast
import base64
import copy
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
import tomllib

ROOT = Path(__file__).resolve().parents[3]
# private 후보에서도 같은 파일을 실행한다. 실제 저장소 소스는 읽기만 한다.
REFERENCE = Path(os.environ.get('YUMIDANG_NEGATIVE_TEST_REFERENCE', str(ROOT))).resolve()
sys.path.insert(0, str(REFERENCE / 'tools/local'))

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

negative = load('negative_candidate', ROOT / 'tools/local/prepare_auth_negative.py')
prepare = load('negative_config_candidate', ROOT / 'tools/local/prepare_database.py')


def reader():
    """기존 reader의 실제 함수본문을 실행한다. 검증을 mock으로 대체하지 않는다."""
    namespace = dict(Path=Path, os=os, stat=stat, tempfile=tempfile, ROOT=REFERENCE)
    for path, names in ((REFERENCE / 'tools/local/run_database_tests.py', {'private_temp_root'}),
            (REFERENCE / 'tests/integration/jonghyun/isolated_ai_contracts.py', {'signed_private_read'})):
        tree = ast.parse(path.read_bytes())
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
        if len(nodes) != len(names): raise AssertionError('검토한 reader 함수 누락')
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), namespace)
    return SimpleNamespace(signed_exact_json=negative.exact_json, signed_private_read=namespace['signed_private_read'],
                           private_temp_root=namespace['private_temp_root'])


def reviewed(root, operations=('prepare', 'create', 'issue', 'dispatch', 'close'),
             capsule_root=Path('/private/tmp/unit-negative-capsule-parent/capsule'),
             source_head='a' * 40, pins=None):
    return negative.ReviewedAuthNegativePair('unit-review', root,
        'jonghyun-backend100-a0170001', 57441, '10.253.101.0/24',
        'jonghyun-backend100-f0170001', 57461, '10.253.102.0/24',
        source_head, {'unit': 'b' * 64} if pins is None else pins, '/reviewed/supabase', 'c' * 64,
        '/reviewed/node', 'd' * 64, {x: 'sha256:' + str(i) * 64 for i, x in enumerate(negative.ROLES, 1)},
        'legacy_v1', '879401ec-e2b7-4ad8-9915-0a16ea74e3f5', operations, capsule_root=capsule_root)


def anonymous_fixture():
    uid, sid, scope = str(uuid.uuid4()), str(uuid.uuid4()), uuid.uuid4().hex
    meta = {'fixture_scope_id': scope, 'fixture_case': 'anonymousBearer'}
    response = {'token_type': 'bearer', 'access_token': 'unit-original-not-jwt', 'refresh_token': 'unit-original-refresh',
        'user': {'id': uid, 'is_anonymous': True, 'role': 'authenticated', 'email': '', 'identities': [], 'user_metadata': meta}}
    claims = {'sub': uid, 'session_id': sid, 'iss': 'http://127.0.0.1:57441/auth/v1', 'aud': 'authenticated',
        'role': 'authenticated', 'is_anonymous': True, 'email': '', 'user_metadata': meta, 'iat': 1000, 'exp': 4600}
    account = negative.anonymous_account(response, 'http://127.0.0.1:57441', scope, claims, 1001)
    tables = ['auth.users', 'auth.sessions', 'auth.refresh_tokens', 'auth.mfa_amr_claims', 'auth.identities',
        'auth.audit_log_entries', 'public.profiles', 'private.ai_budget_reservations', 'private.ai_account_budget_reservations']
    before = {'rows': {table: {} for table in tables}, 'authoritySha256': '1' * 64,
        'constraintsSha256': '2' * 64, 'catalogSha256': '3' * 64}
    before['rows']['private.ai_budget_reservations']['f' * 64] = 2
    row_values = {
        'auth.users': {'id': uid, 'is_anonymous': True, 'role': 'authenticated', 'email': '', 'phone': '',
            'encrypted_password': '', 'banned_until': None, 'deleted_at': None, 'raw_user_meta_data': meta},
        'auth.sessions': {'id': sid, 'user_id': uid, 'refresh_token_hmac_key': None, 'refresh_token_counter': None},
        'auth.refresh_tokens': {'user_id': uid, 'session_id': sid, 'revoked': False, 'token': response['refresh_token'], 'parent': ''},
        'auth.mfa_amr_claims': {'id': str(uuid.uuid4()), 'session_id': sid, 'authentication_method': 'anonymous'}}
    rows = {table: [{'row': row, 'sha256': negative.digest(negative.canonical(row))}] for table, row in row_values.items()}
    after = copy.deepcopy(before)
    for table, values in rows.items(): after['rows'][table][values[0]['sha256']] = 1
    return response, claims, account, scope, before, after, rows


def metadata_fixture():
    images = {role: 'sha256:' + str(i) * 64 for i, role in enumerate(negative.ROLES, 1)}
    contexts = {'anonymous': {'project': 'jonghyun-backend100-a0170001'},
                'foreign': {'project': 'jonghyun-backend100-f0170001'}}
    old = {'containers': [{'id': 'old', 'name': 'original-kept', 'image': 'sha256:old',
            'state': {'running': False, 'status': 'exited', 'oomKilled': False}}],
        'customNetworks': [{'id': 'old-net', 'name': 'old-net'}], 'volumes': [{'name': 'old-volume'}]}
    now = copy.deepcopy(old)
    for key, ctx in contexts.items():
        for role in negative.ROLES:
            now['containers'].append({'id': key + '-' + role, 'name': negative.ROLES[role] + ctx['project'],
                'image': images[role], 'state': {'running': True, 'status': 'running', 'oomKilled': False}})
        now['customNetworks'].append({'id': key + '-net', 'name': 'supabase_network_' + ctx['project']})
        now['volumes'].append({'name': 'supabase_db_' + ctx['project']})
    return old, now, contexts, images


class ConfigContract(unittest.TestCase):
    def test_only_exact_three_auth_flags_change(self):
        raw = (REFERENCE / 'backend/supabase/config.toml').read_bytes()
        standard, ports = prepare.isolated_config(raw, 'jonghyun-backend100-a0170001', 57441)
        changed, overlay = prepare.anonymous_negative_config(raw, 'jonghyun-backend100-a0170001', 57441)
        expected = tomllib.loads(standard.decode()); auth = expected['auth']
        auth['enable_signup'] = True; auth['enable_anonymous_sign_ins'] = True; auth['email']['enable_signup'] = False
        self.assertEqual(tomllib.loads(changed.decode()), expected)
        self.assertEqual(set(overlay) - set(ports), {'auth.enable_signup', 'auth.enable_anonymous_sign_ins', 'auth.email.enable_signup'})
        self.assertFalse(tomllib.loads(standard.decode())['auth']['enable_anonymous_sign_ins'])
        self.assertEqual(raw, (REFERENCE / 'backend/supabase/config.toml').read_bytes())

    def test_invalid_boolean_config_rejected(self):
        raw = (REFERENCE / 'backend/supabase/config.toml').read_bytes().replace(b'enable_anonymous_sign_ins = false', b'enable_anonymous_sign_ins = 0')
        with self.assertRaises(ValueError): prepare.anonymous_negative_config(raw, 'jonghyun-backend100-a0170001', 57441)

    def test_typed_review_and_os_temp_boundary(self):
        with tempfile.TemporaryDirectory() as folder:
            obj = reviewed(Path(folder).resolve()); self.assertEqual(obj.descriptor()['refreshMode'], 'legacy_v1')
            with self.assertRaisesRegex(ValueError, 'TYPED'): negative.operation_review({}, 'issue')
            with self.assertRaisesRegex(ValueError, 'NOT_APPROVED'): negative.operation_review(reviewed(Path(folder).resolve(), ('prepare',)), 'dispatch')
            original = obj.descriptor(); original['contexts']['anonymous']['port'] = 1
            self.assertEqual(obj.descriptor()['contexts']['anonymous']['port'], 57441)
        with self.assertRaisesRegex(ValueError, 'PRIVATE_ROOT'): reviewed(Path(tempfile.gettempdir()).resolve())

    def test_review_rejects_refresh_mode_two_before_io(self):
        with tempfile.TemporaryDirectory() as folder:
            args = reviewed(Path(folder).resolve()).descriptor()
            with self.assertRaisesRegex(ValueError, 'FIXED_REFRESH_MODE'):
                negative.ReviewedAuthNegativePair('unit-review', Path(folder).resolve(),
                    'jonghyun-backend100-a0170001', 57441, '10.253.101.0/24',
                    'jonghyun-backend100-f0170001', 57461, '10.253.102.0/24',
                    args['sourceHead'], args['pins'], args['cliPath'], args['cliSha256'], args['nodePath'], args['nodeSha256'],
                    args['images'], 'session_hmac_v2', args['daemonId'], ('issue',), capsule_root=args['capsuleRoot'])


class TypedAdapterContract(unittest.TestCase):
    def fixture(self):
        namespace = dict(Path=Path, re=re, json=json, base64=base64)
        names = {'provisioning_metadata', 'signed_claims', 'signed_exact_json', 'ReviewedSignedProvisioning'}
        source = REFERENCE / 'tests/integration/jonghyun/isolated_ai_contracts.py'
        nodes = [n for n in ast.parse(source.read_bytes()).body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in names]
        self.assertEqual(len(nodes), len(names))
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec'), namespace)
        class Ports: pass
        class Runner: pass
        ai = SimpleNamespace(**{key: namespace[key] for key in names},
            FixedLifecycleProvisioningPorts=Ports, SignedRunner=Runner)
        project = 'jonghyun-backend100-a0170001'; root = Path(tempfile.gettempdir()).resolve() / 'unit-pair/anonymous'
        containers = {role: {'id': str(i) * 64, 'name': negative.ROLES[role] + project,
            'image': 'sha256:' + str(i) * 64, 'configSha256': 'a' * 64, 'hostConfigSha256': 'b' * 64,
            'mountsSha256': 'c' * 64} for i, role in enumerate(negative.ROLES, 1)}
        def token(role):
            payload = base64.urlsafe_b64encode(json.dumps({'role': role}).encode()).decode().rstrip('=')
            return 'unit.' + payload + '.unit'
        reviewed_ports = ai.ReviewedSignedProvisioning('unit', root, {}, containers,
            {'anon': token('anon'), 'service': token('service_role')}, 9999999999)
        target = {'project': project, 'id': containers['db']['id'], 'image': containers['db']['image']}
        obj = object.__new__(negative.FixedPair); obj.ai = ai; obj.base = ['unit-no-process']
        obj.contexts = {'anonymous': {'port': 57441}}; events = []
        obj.anonymous_target = lambda value: events.append(('purpose-target', value)) or target
        return obj, reviewed_ports, root, events, target, token

    def test_exact_purpose_and_standard_metadata_are_required_before_adapter(self):
        obj, ports, root, events, _, _ = self.fixture()
        adapter = obj.anonymous_negative_ports(ports, root)
        self.assertEqual(type(adapter).__name__, 'AnonymousNegativePorts')
        self.assertEqual(events, [('purpose-target', root)])
        self.assertEqual(adapter.reviewed, ports)
        self.assertEqual(adapter.runner.binding['containers'], ports.containers)
        obj.anonymous_target = lambda _: (_ for _ in ()).throw(ValueError('unit-exact-purpose-rejected'))
        with self.assertRaisesRegex(ValueError, 'exact-purpose-rejected'): obj.anonymous_negative_ports(ports, root)
        with self.assertRaisesRegex(ValueError, 'TYPED_PORTS'): obj.anonymous_negative_ports({}, root)

    def test_wrong_roles_duplicate_ids_db_and_credentials_reject_before_sql_http(self):
        for bad in ('missing-role', 'extra-role', 'duplicate-id', 'wrong-db', 'wrong-image', 'credential-role', 'wrong-root', 'non-loopback'):
            with self.subTest(bad=bad):
                obj, ports, root, _, target, token = self.fixture()
                if bad == 'missing-role': del ports.containers['rest']
                if bad == 'extra-role': ports.containers['unapproved'] = ports.containers['db']
                if bad == 'duplicate-id': ports.containers['rest']['id'] = ports.containers['db']['id']
                if bad == 'wrong-db': target['id'] = '9' * 64
                if bad == 'wrong-image': target['image'] = 'sha256:' + '9' * 64
                if bad == 'credential-role': ports.credentials['anon'] = token('service_role')
                if bad == 'wrong-root': ports.prepared_root = root.parent
                if bad == 'non-loopback':
                    with self.assertRaisesRegex(ValueError, 'LOOPBACK'): obj.ai.provisioning_metadata(ports, target, 'https://example.invalid')
                else:
                    with self.assertRaises(ValueError): obj.anonymous_negative_ports(ports, root)


class AnonymousScope(unittest.TestCase):
    def check(self, fixture):
        r, _, a, scope, before, after, rows = fixture
        negative.verify_anonymous_delta(before, after, rows, a, scope, 'legacy_v1', r['refresh_token'])

    def test_bulk_row_query_separates_uuid_cast_and_predicate_tokens(self):
        _, _, account, *_ = anonymous_fixture()
        received = []
        obj = object.__new__(negative.FixedPair)
        obj.ai = SimpleNamespace(quote=lambda value: "'" + value.replace("'", "''") + "'")
        def sql(query, **kw): received.append(query); return b'{}'
        obj.ports = {'anonymous': SimpleNamespace(read_sql=sql)}
        self.assertEqual(obj.anonymous_rows(account), {})
        self.assertEqual(len(received), 1)
        query = received[0]
        self.assertNotIn('::uuidand', query)
        for table in ('auth.sessions', 'auth.refresh_tokens'):
            self.assertRegex(query, r'from ' + re.escape(table) + r" r where r\.(?:id|session_id)='[a-f0-9-]+'::uuid and r\.user_id")
        self.assertEqual(query.count("'sha256',encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')"), 4)
        self.assertTrue(query.endswith(');'))

    def test_current_applied_history_is_checked_not_inferred_from_manifest(self):
        obj = object.__new__(negative.FixedPair)
        versions = [str(20261018000000 + i) for i in range(121)]
        calls = []
        def port(key):
            return SimpleNamespace(target={'versions': versions},
                history=lambda: calls.append(key) or {'method': 'SUPABASE_DB_HISTORY', 'native': 'NOT_RUN'})
        obj.ports = {key: port(key) for key in ('anonymous', 'foreign')}
        result = obj.history(); self.assertEqual(calls, ['anonymous', 'foreign'])
        self.assertEqual(result['anonymous']['versionCount'], 121)
        obj.ports['foreign'].history = lambda: {'method': 'NATIVE_BASELINE_ONLY', 'native': 'PASS'}
        with self.assertRaisesRegex(ValueError, 'ACTUAL_DB_HISTORY_REQUIRED'): obj.history()
        obj.ports['anonymous'].target = {'versions': versions[:-1]}
        with self.assertRaisesRegex(ValueError, 'CURRENT_HISTORY'): obj.history()

    def test_exact_four_rows_and_unknown_multiplicity(self): self.check(anonymous_fixture())

    def test_foreign_owner_amr_refresh_and_user_mutation_rejected(self):
        for table, key, bad in [('auth.users', 'is_anonymous', False), ('auth.sessions', 'user_id', str(uuid.uuid4())),
                ('auth.mfa_amr_claims', 'authentication_method', 'password'), ('auth.refresh_tokens', 'revoked', True),
                ('auth.refresh_tokens', 'token', 'different-original')]:
            with self.subTest(table=table, field=key):
                f = anonymous_fixture(); f[-1][table][0]['row'][key] = bad
                with self.assertRaises(ValueError): self.check(f)

    def test_no_audit_identity_profile_budget_or_old_row_changes(self):
        for table in ('auth.audit_log_entries', 'auth.identities', 'public.profiles', 'private.ai_budget_reservations'):
            with self.subTest(table=table):
                f = anonymous_fixture(); f[5]['rows'][table]['9' * 64] = 1
                with self.assertRaisesRegex(ValueError, 'UNOWNED_ROW'): self.check(f)
        f = anonymous_fixture(); f[5]['rows']['private.ai_budget_reservations']['f' * 64] = 1
        with self.assertRaisesRegex(ValueError, 'UNOWNED_ROW'): self.check(f)

    def test_observed_sha_must_be_new_and_counts_exact(self):
        f = anonymous_fixture(); sha = f[-1]['auth.users'][0]['sha256']; f[4]['rows']['auth.users'][sha] = 1
        f[5]['rows']['auth.users'][sha] = 2
        with self.assertRaisesRegex(ValueError, 'ROW_NOT_NEW'): self.check(f)
        f = anonymous_fixture(); f[-1]['auth.mfa_amr_claims'] *= 2
        with self.assertRaisesRegex(ValueError, 'EXACT_COUNTS'): self.check(f)

    def test_authority_catalog_constraints_cannot_be_approved_from_after(self):
        for field in ('authoritySha256', 'constraintsSha256', 'catalogSha256'):
            f = anonymous_fixture(); f[5][field] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'AUTHORITY'): self.check(f)

    def test_original_claims_are_not_swapped_or_shortened(self):
        response, claims, _, scope, *_ = anonymous_fixture()
        for field, bad in [('sub', str(uuid.uuid4())), ('is_anonymous', False), ('exp', 1300), ('iat', True)]:
            changed = {**claims, field: bad}
            with self.assertRaises(ValueError): negative.anonymous_account(response, 'http://127.0.0.1:57441', scope, changed, 1001)

    def test_factory_exact_counts_and_foreign_auth_status(self):
        for case, auth in [('anonymousBearer', 200), ('differentOriginalContext', 401), ('differentOriginalContext', 403)]:
            proof = {'status': 'PASS', 'case': case, 'httpStatus': 401, 'authHttpStatus': auth, 'actualAuthReads': 1,
                'rpcCalls': 0, 'providerCalls': 0, 'nativeExternalAttempts': 0, 'originalTokenSha256': 'a' * 64,
                'actualNaver': 'NOT_RUN', 'externalProvider': 'NOT_RUN'}
            self.assertEqual(negative.rejection_proof(negative.canonical(proof), case, 'a' * 64), proof)
            for field, bad in [('rpcCalls', 1), ('providerCalls', 1), ('actualAuthReads', True), ('httpStatus', 200), ('authHttpStatus', 500)]:
                with self.assertRaises(ValueError): negative.rejection_proof(negative.canonical({**proof, field: bad}), case, 'a' * 64)
        with self.assertRaises(ValueError): negative.exact_json(b'{"x":1,"x":2}')
        with self.assertRaises(ValueError): negative.exact_json(b'{"x":NaN}')


class PairedResourceContract(unittest.TestCase):
    def test_exact_pair_and_old_stopped_resources_retained(self):
        before, after, contexts, images = metadata_fixture()
        own = negative.pair_inventory(before, after, contexts, images)
        self.assertEqual(len(own['containers']), 8); self.assertEqual(before['containers'][0], after['containers'][0])

    def test_extra_service_old_change_and_wrong_image_rejected(self):
        for mutation in ('extra', 'old', 'image'):
            before, after, contexts, images = metadata_fixture()
            if mutation == 'extra': after['containers'].append({'id': 'extra', 'name': 'unapproved', 'image': images['db']})
            if mutation == 'old': after['containers'][0]['state']['running'] = True
            if mutation == 'image': after['containers'][1]['image'] = images['auth']
            with self.assertRaises(ValueError): negative.pair_inventory(before, after, contexts, images)

    def test_partial_failure_cleanup_and_no_replacement_ids(self):
        before, after, contexts, images = metadata_fixture()
        after['containers'] = after['containers'][:3]
        own = negative.cleanup_inventory(before, after, contexts, images)
        self.assertEqual(len(own['containers']), 2)
        negative.fixed_created_ids(own, copy.deepcopy(own))
        replaced = copy.deepcopy(own); replaced['containers'][0]['id'] = 'replacement'
        with self.assertRaisesRegex(ValueError, 'CREATED_IDS_CHANGED'): negative.fixed_created_ids(replaced, own)
        after['containers'].append({'id': 'foreign-new', 'name': 'foreign-new', 'image': images['db']})
        with self.assertRaisesRegex(ValueError, 'UNOWNED_CLEANUP'): negative.cleanup_inventory(before, after, contexts, images)


class PrivateIoContract(unittest.TestCase):
    def setUp(self): self.ai = reader()
    def root(self, folder):
        root = Path(folder).resolve(); root.chmod(0o700); return root
    def runtime(self):
        obj = object.__new__(negative.FixedPair); obj.ai = self.ai; return obj

    def test_os_temp_atomic_write_read_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.root(folder); obj = self.runtime()
            sha = obj.save(root, 'private.json', {'unit': True})
            self.assertEqual(sha, negative.digest(negative.canonical({'unit': True})))
            self.assertEqual(negative.secure_private_bytes(root / 'private.json', self.ai), b'{"unit":true}')
            self.assertEqual(stat.S_IMODE((root / 'private.json').stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError): obj.save(root, 'private.json', {'unit': False})

    def test_bad_ancestor_repeated_rejection_has_no_raw_fd_leak(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.root(folder); path = root / 'private.json'; path.write_bytes(b'{}'); path.chmod(0o600)
            root.chmod(0o755)
            before = len(os.listdir('/dev/fd'))
            for _ in range(32):
                with self.assertRaisesRegex(ValueError, 'ANCESTOR'): negative.secure_private_bytes(path, self.ai)
            self.assertEqual(len(os.listdir('/dev/fd')), before)
            root.chmod(0o700)

    def test_parent_path_swap_and_hardlink_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.root(folder); parent = root / 'parent'; parent.mkdir(mode=0o700)
            path = parent / 'private.json'; path.write_bytes(b'{}'); path.chmod(0o600)
            original = self.ai.signed_private_read
            def swap(target):
                raw = original(target); parent.rename(root / 'old'); parent.mkdir(mode=0o700)
                replacement = parent / 'private.json'; replacement.write_bytes(raw); replacement.chmod(0o600)
                return raw
            with self.assertRaisesRegex(ValueError, 'ANCESTOR_CHANGED'):
                negative.secure_private_bytes(path, SimpleNamespace(signed_private_read=swap))
            os.link(path, parent / 'other.json')
            with self.assertRaises(ValueError): negative.secure_private_bytes(path, self.ai)

    def test_binary_fifo_swap_is_rejected_within_child_two_seconds(self):
        # os.open 직전 교체는 사전 lstat만으로 막지 못한다. NONBLOCK/fstat 경계를 실제 child로 검사한다.
        code = '''import importlib.util,os,pathlib,tempfile
from unittest.mock import patch
p=pathlib.Path(%r);s=importlib.util.spec_from_file_location('n',p);n=importlib.util.module_from_spec(s);s.loader.exec_module(n)
with tempfile.TemporaryDirectory() as d:
 f=pathlib.Path(d).resolve()/'supabase';f.write_bytes(b'unit');f.chmod(0o700);original=os.open
 def replace(path,flags,*a,**k):
  if pathlib.Path(path)==f:
   f.unlink();os.mkfifo(f,0o600)
  return original(path,flags,*a,**k)
 with patch.object(n.os,'open',replace):
  try:n.FixedPair.binary(None,f,n.digest(b'unit'),'supabase')
  except ValueError:pass
  else:raise AssertionError('FIFO accepted')
''' % str(ROOT / 'tools/local/prepare_auth_negative.py')
        result = subprocess.run([sys.executable, '-c', code], capture_output=True, timeout=2)
        self.assertEqual(result.returncode, 0, 'FIFO child failure')

    def test_private_fifo_is_rejected_within_child_two_seconds(self):
        code = '''import ast,importlib.util,os,pathlib,stat,tempfile,types
p=pathlib.Path(%r);s=importlib.util.spec_from_file_location('n',p);n=importlib.util.module_from_spec(s);s.loader.exec_module(n)
ns=dict(Path=pathlib.Path,os=os,stat=stat,tempfile=tempfile,ROOT=pathlib.Path(%r))
for p,names in [(pathlib.Path(%r),{'private_temp_root'}),(pathlib.Path(%r),{'signed_private_read'})]:
 t=ast.parse(p.read_bytes());exec(compile(ast.Module(body=[x for x in t.body if isinstance(x,ast.FunctionDef)and x.name in names],type_ignores=[]),str(p),'exec'),ns)
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d).resolve()/'private.json';os.mkfifo(p,0o600)
 try:n.secure_private_bytes(p,types.SimpleNamespace(signed_private_read=ns['signed_private_read']))
 except ValueError:pass
 else:raise AssertionError('FIFO accepted')
''' % (str(ROOT / 'tools/local/prepare_auth_negative.py'), str(REFERENCE),
       str(REFERENCE / 'tools/local/run_database_tests.py'), str(REFERENCE / 'tests/integration/jonghyun/isolated_ai_contracts.py'))
        result = subprocess.run([sys.executable, '-c', code], capture_output=True, timeout=2)
        self.assertEqual(result.returncode, 0, 'FIFO child failure')


class PhaseFailureContract(unittest.TestCase):
    def runtime_class(self, root, mode, events):
        base = negative.FixedPair
        class UnitRuntime:
            save_bytes = base.save_bytes; save = base.save; private = base.private; read = base.read
            def __init__(self, review):
                self.root = root; self.ai = reader(); self.child = None; self.samples = []
                self.contexts = review.descriptor()['contexts']; self.value = review.descriptor()
            def start_monitor(self): events.append('start')
            def finish_monitor(self):
                events.append('monitor-closed')
                if mode == 'monitor-fail': raise ValueError('unit-monitor-failure')
            def close_child(self, root, label): self.child = None; events.append('child-closed')
            def dispatch(self):
                self.child = object(); events.append('case')
                if mode == 'phase-fail': raise ValueError('unit-case-failure')
                return {'scope': 'UNIT_MODEL_ONLY', 'fullLifecycleCoverage': 'NOT_RUN'}
            def create(self):
                self.child = object(); events.append('create')
                before, after, _, _ = metadata_fixture()
                self.save(root, 'pair-before-private.json', before)
                raise ValueError('unit-partial-create-failure')
            def inventory(self):
                if self.child is not None: raise AssertionError('자식 종료 전에 생성ID를 고정함')
                events.append('inventory-after-child-close')
                _, after, _, _ = metadata_fixture(); after['containers'] = after['containers'][:3]
                return after
        return UnitRuntime

    def test_phase_attempt_is_consumed_without_resend(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve(); events = []
            with patch.object(negative, 'FixedPair', self.runtime_class(root, 'success', events)):
                result = negative.run_reviewed_phase(reviewed(root), 'dispatch')
                self.assertEqual(result['scope'], 'UNIT_MODEL_ONLY')
                with self.assertRaises(FileExistsError): negative.run_reviewed_phase(reviewed(root), 'dispatch')
            self.assertEqual(events.count('case'), 1)
            receipt = json.loads((root / 'dispatch-monitor.json').read_bytes())
            self.assertEqual(receipt['status'], 'PASS'); self.assertTrue(receipt['ownedChildClosed'])
            self.assertEqual(receipt['fullLifecycleCoverage'], 'NOT_RUN')

    def test_monitor_or_case_failure_closes_child_and_cannot_return_pass(self):
        for mode in ('monitor-fail', 'phase-fail'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                root = Path(folder).resolve(); events = []
                with patch.object(negative, 'FixedPair', self.runtime_class(root, mode, events)):
                    with self.assertRaises(ValueError): negative.run_reviewed_phase(reviewed(root), 'dispatch')
                receipt = json.loads((root / 'dispatch-monitor.json').read_bytes())
                self.assertEqual(receipt['status'], 'FAIL'); self.assertTrue(receipt['ownedChildClosed'])
                self.assertIn('child-closed', events); self.assertIn('monitor-closed', events)

    def test_partial_create_failure_ids_are_saved_after_exact_child_closure(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve(); events = []
            with patch.object(negative, 'FixedPair', self.runtime_class(root, 'partial-create', events)), \
                    patch.object(negative, 'metadata_summary', lambda value: value):
                with self.assertRaises(ValueError): negative.run_reviewed_phase(reviewed(root), 'create')
            fixed = json.loads((root / 'create-final-private.json').read_bytes())
            self.assertEqual(fixed['status'], 'CAPTURED_CREATED_IDS_ONLY')
            self.assertEqual(len(fixed['owned']['containers']), 2)
            self.assertLess(events.index('child-closed'), events.index('inventory-after-child-close'))
            self.assertEqual(json.loads((root / 'create-monitor.json').read_bytes())['status'], 'FAIL')

    def test_failure_cleanup_stops_only_frozen_owned_ids_and_saves_failure_remaining_ids(self):
        base = negative.FixedPair
        for fail_one in (False, True):
            with self.subTest(fail_one=fail_one), tempfile.TemporaryDirectory() as folder:
                root = Path(folder).resolve(); review = reviewed(root); obj = object.__new__(base)
                obj.root = root; obj.ai = reader(); obj.reviewed = review; obj.value = review.descriptor()
                obj.contexts = obj.value['contexts']; obj.source = lambda: None
                before, current, _, images = metadata_fixture(); owned = negative.cleanup_inventory(before, current, obj.contexts, images)
                obj.save(root, 'pair-before-private.json', before)
                obj.save(root, 'pair-create-intent.json', {'reviewSha256': negative.digest(review._sealed),
                    'contexts': obj.contexts, 'beforeSha256': negative.digest(negative.canonical(before))})
                obj.save(root, 'create-final-private.json', {'status': 'CAPTURED_CREATED_IDS_ONLY',
                    'reviewSha256': negative.digest(review._sealed), 'owned': owned})
                obj.inventory = lambda: current
                stopped = []
                def call(args, **kw):
                    item = next(x for x in current['containers'] if x['id'] == args[-1])
                    if args[0] == 'stop':
                        stopped.append(item['id'])
                        if fail_one and item['id'] == 'anonymous-db': raise ValueError('unit-stop-failure')
                        item['state'].update(running=False, status='exited')
                        return ''
                    project = next(c['project'] for c in obj.contexts.values() if item['name'].endswith(c['project']))
                    return json.dumps([{'Id': item['id'], 'Name': '/' + item['name'], 'Image': item['image'],
                        'Config': {'Labels': {'com.supabase.cli.project': project}},
                        'State': {'Running': item['state']['running'], 'OOMKilled': False, 'ExitCode': 0}}])
                obj.call = call
                with patch.object(negative, 'metadata_summary', lambda value: value):
                    if fail_one:
                        with self.assertRaisesRegex(ValueError, 'CLEANUP_UNPROVEN'): obj.close()
                    else: obj.close()
                receipt = json.loads((root / 'pair-closure.json').read_bytes())
                self.assertEqual(set(stopped), {x['id'] for x in owned['containers']})
                self.assertNotIn('old', stopped); self.assertEqual(current['containers'][0], before['containers'][0])
                self.assertEqual(receipt['status'], 'FAIL' if fail_one else 'PASS_OWN_CREATED_STOPPED_EXISTING_METADATA_PRESERVED')
                self.assertEqual(receipt['remainingIds'], ['anonymous-db'] if fail_one else [])
                self.assertTrue((root / 'pair-after-close-private.json').exists())


class SealedCapsuleBoundaryContract(unittest.TestCase):
    def helpers(self):
        source = REFERENCE / 'tests/integration/jonghyun/isolated_ai_contracts.py'
        names = {'lifecycle_capsule_source_read', 'sealed_runtime_capsule', 'product_graph'}
        namespace = dict(Path=Path, os=os, stat=stat, re=re, hashlib=hashlib,
                         subprocess=subprocess, REPO=REFERENCE)
        nodes = [node for node in ast.parse(source.read_bytes()).body
                 if isinstance(node, ast.FunctionDef) and node.name in names]
        self.assertEqual(len(nodes), 3)
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec'), namespace)
        return namespace

    def seal(self, root, pins):
        root.mkdir(mode=0o700)
        for relative in pins:
            target = root / relative; target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((REFERENCE / relative).read_bytes()); target.chmod(0o400)
        for directory in sorted([root, *[p for p in root.rglob('*') if p.is_dir()]],
                                key=lambda p: len(p.parts), reverse=True): directory.chmod(0o500)

    def unseal_for_cleanup(self, root):
        if root.exists():
            for directory in [root, *[p for p in root.rglob('*') if p.is_dir()]]: directory.chmod(0o700)

    def test_typed_capsule_root_is_separate_explicit_canonical_private_tmp(self):
        with tempfile.TemporaryDirectory() as folder:
            pair = Path(folder).resolve()
            capsule = Path('/private/tmp/negative-owned-unit/source-capsule')
            obj = reviewed(pair, capsule_root=capsule)
            self.assertEqual(obj.descriptor()['capsuleRoot'], str(capsule))
            obj.descriptor()['capsuleRoot'] = str(pair / 'different')
            self.assertEqual(obj.descriptor()['capsuleRoot'], str(capsule))
            for bad in (pair / 'inside-os-pair', Path('/private/tmp'), Path('/private/tmp/capsule-no-private-parent'),
                        Path('relative/capsule'), Path('/private/tmp/unit/../capsule')):
                with self.subTest(path=str(bad)), self.assertRaisesRegex(ValueError, 'CAPSULE_ROOT'):
                    reviewed(pair, capsule_root=bad)

    def test_existing_helper_rejects_os_temp_and_accepts_real_private_tmp_all_51_files(self):
        helpers = self.helpers(); factory = 'tests/integration/jonghyun/isolated_ai_factory.ts'
        pins = {**helpers['product_graph'](), factory: negative.digest((REFERENCE / factory).read_bytes())}
        self.assertEqual(len(pins), 51)
        head = subprocess.check_output(['git', '-C', str(REFERENCE), 'rev-parse', 'HEAD'], text=True).strip()
        with tempfile.TemporaryDirectory() as os_folder, tempfile.TemporaryDirectory(dir='/private/tmp') as source_folder:
            bad = Path(os_folder).resolve() / 'os-source-capsule'
            good = Path(source_folder).resolve() / 'source-capsule'
            try:
                self.seal(bad, pins); self.seal(good, pins)
                # 실제 기존 helper, 실제 봉인파일, 실제 Git HEAD를 사용한다. TMPDIR/reader를 바꾸지 않는다.
                if not Path(os_folder).resolve().is_relative_to(Path('/private/tmp')):
                    with self.assertRaisesRegex(ValueError, 'LIFECYCLE_CAPSULE_SOURCE_(DIRECTORY|ROOT)'):
                        helpers['sealed_runtime_capsule'](head, bad, pins, pins)
                self.assertEqual(helpers['sealed_runtime_capsule'](head, good, pins, pins), (good, good / factory))
                os.chmod(good / factory, 0o600)
                with self.assertRaisesRegex(ValueError, 'SOURCE_FILE'):
                    helpers['sealed_runtime_capsule'](head, good, pins, pins)
            finally:
                self.unseal_for_cleanup(bad); self.unseal_for_cleanup(good)

    def test_capsule_review_cannot_choose_path_outside_typed_descriptor(self):
        helpers = self.helpers(); factory = 'tests/integration/jonghyun/isolated_ai_factory.ts'
        pins = {**helpers['product_graph'](), factory: negative.digest((REFERENCE / factory).read_bytes())}
        head = subprocess.check_output(['git', '-C', str(REFERENCE), 'rev-parse', 'HEAD'], text=True).strip()
        with tempfile.TemporaryDirectory() as os_folder, tempfile.TemporaryDirectory(dir='/private/tmp') as source_folder:
            pair = Path(os_folder).resolve(); source = Path(source_folder).resolve() / 'source-capsule'
            try:
                self.seal(source, pins)
                obj = object.__new__(negative.FixedPair)
                obj.reviewed = reviewed(pair, capsule_root=source, source_head=head, pins=pins)
                obj.value = obj.reviewed.descriptor(); obj.root = pair
                obj.ai = SimpleNamespace(**vars(reader()), product_graph=helpers['product_graph'],
                    sealed_runtime_capsule=helpers['sealed_runtime_capsule'])
                binaries = []; obj.binary = lambda *args: binaries.append(args)
                cap = {'capsuleRoot': str(source), 'capsulePins': pins,
                    'nodePath': obj.value['nodePath'], 'nodeSha256': obj.value['nodeSha256']}
                obj.save(pair, 'capsule-review.json', cap)
                self.assertEqual(obj.capsule(), cap); self.assertEqual(len(binaries), 1)
                # 다른 올바른모양 JSON도 typed 경로와 다르면 reader/실행 전에 거절한다.
                changed = {**cap, 'capsuleRoot': str(source.parent / 'different-capsule')}
                obj.read = lambda *_: changed
                with self.assertRaisesRegex(ValueError, 'CAPSULE_REVIEW'): obj.capsule()
                self.assertEqual(len(binaries), 1)
            finally: self.unseal_for_cleanup(source)


class SourceHeadContract(unittest.TestCase):
    def test_actual_temporary_git_head_and_config_and_self_dirty_rejection(self):
        # 실제 임시 Git 저장소에서 HEAD/staged/작업파일 차이를 검사한다. 프로젝트 git에는 쓰지 않는다.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            tree = ast.parse((ROOT / 'tools/local/prepare_auth_negative.py').read_bytes())
            method = next(x for x in tree.body if isinstance(x, ast.FunctionDef) and x.name == 'source_pins')
            fixed = next(n.value for n in ast.walk(method) if isinstance(n, ast.Assign)
                         and any(isinstance(t, ast.Name) and t.id == 'fixed' for t in n.targets))
            names = {negative.SELF if isinstance(x, ast.Name) else x.value for x in fixed.elts}
            names.add('backend/supabase/functions/ai-chat/index.ts')
            for name in names:
                path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('unit committed bytes\n')
            env = {**os.environ, 'GIT_AUTHOR_NAME': 'Unit', 'GIT_AUTHOR_EMAIL': 'unit@example.invalid',
                'GIT_COMMITTER_NAME': 'Unit', 'GIT_COMMITTER_EMAIL': 'unit@example.invalid'}
            for command in (['init', '-q'], ['add', '.'], ['commit', '-qm', 'unit fixture only']):
                subprocess.run(['git', '-C', str(root), *command], env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            with patch.object(negative, 'ROOT', root):
                head, pins = negative.source_pins(); self.assertIn('backend/supabase/config.toml', pins)
                for name in (negative.SELF, 'backend/supabase/config.toml', 'tools/local/prepare_database.py'):
                    path = root / name; raw = path.read_bytes(); path.write_bytes(raw + b'changed')
                    subprocess.run(['git', '-C', str(root), 'add', name], check=True, stdout=subprocess.DEVNULL)
                    with self.assertRaisesRegex(ValueError, 'NOT_COMMITTED'): negative.source_pins(head)
                    path.write_bytes(raw); subprocess.run(['git', '-C', str(root), 'add', name], check=True, stdout=subprocess.DEVNULL)
                with self.assertRaisesRegex(ValueError, 'HEAD_CHANGED'): negative.source_pins('0' * 40)


if __name__ == '__main__': unittest.main()
