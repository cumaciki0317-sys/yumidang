"""Root member 전용 경계 책임 시험. 실제 SQL/Auth/VM/HTTP는 호출하지 않는다."""
import copy
import ast
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import stat
import shutil
import tempfile
import unittest
import uuid
from types import SimpleNamespace

CALLER = Path(__file__).resolve().parents[3] / 'tests/integration/jonghyun/member-root-boundary.py'
spec = importlib.util.spec_from_file_location('tested_member_root_boundary', CALLER)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
RUN = '00000000-0000-4000-8000-000000000001'
USER = '00000000-0000-4000-8000-000000000002'
OTHER = '00000000-0000-4000-8000-000000000003'
H = 'a' * 64
F = 'b' * 64
N = 'c' * 64


class MemberRootBoundaryTests(unittest.TestCase):
    def boundary(self):
        b = m.RootMemberBoundary.__new__(m.RootMemberBoundary)
        b.run_id = RUN
        b.sequence = 0
        b.packet = {'bindingSha256': H}
        b.binding = {'accounts': [{'userId': USER}, {'userId': OTHER}]}
        b.observations = []
        b.live_calls = []
        b.live = lambda: b.live_calls.append(True) or {'target': None, 'bindingSha256': H, 'sourceFiles': {}, 'migrationFiles': {}}
        b.seed_attempted = False
        b.fixture = None
        b.read_boundary = None
        b.qualifications = {}
        b.maintenance = None
        b.maintenance_completion = None
        b.maintenance_completion_receipt_sha = None
        b.maintenance_unclosed_observations = 0
        b.ai_request = None
        b.retirement = None
        b.retirement_attempted = False
        b.retirement_preparation_closed = False
        b.retirement_functions = None
        b.retirement_observation = None
        b.retirement_observation_receipt_sha = None
        b.connection_closed = False
        b.connection_closure = 'UNVERIFIED'
        b.j01 = None
        b.saved = {}
        b.evidence = Path('/synthetic-memory-only')
        def save(name, value):
            if name in b.saved:
                raise FileExistsError(name)
            b.saved[name] = copy.deepcopy(value)
            return m.sha(json.dumps(value, sort_keys=True).encode())
        b.save = save
        b.h = SimpleNamespace(signed_private_read=lambda path: json.dumps(b.saved[path.name], sort_keys=True).encode(),
                              signed_exact_json=json.loads)
        return b

    def read_case_boundary(self):
        b = self.boundary()
        ids = [str(uuid.UUID(int=100 + i)) for i in range(100)]
        post, foreign_post, foreign_room, foreign_message, hidden = [str(uuid.UUID(int=1000 + i)) for i in range(5)]
        b.binding['accounts'][0]['sessionId'] = str(uuid.UUID(int=2000))
        b.fixture = {'postId': post, 'requestId': RUN, 'messageIds': ids[:3]}
        b.qualifications = {0: {'identityId': str(uuid.UUID(int=3000)), 'subject': 'synthetic-owned', 'sessionSha256': H}, 1: {}}
        session = {'session_id': b.binding['accounts'][0]['sessionId'], 'user_id': USER,
                   'subject': 'synthetic-owned', 'registered_at': '2026-10-14T01:02:03.123456+00:00'}
        owned = lambda row: {'row': row, 'rowSha256': H}
        b.native = {
            'posts': [owned({'id': x, 'author_id': USER}) for x in (post, foreign_post)],
            'requests': [owned({'id': RUN, 'post_id': post, 'requester_id': OTHER}),
                         owned({'id': foreign_room, 'post_id': foreign_post, 'requester_id': OTHER})],
            'messages': [owned({'id': x, 'join_request_id': RUN, 'sender_id': OTHER}) for x in ids]
                + [owned({'id': foreign_message, 'join_request_id': foreign_room, 'sender_id': OTHER})],
            'reads': [owned({'user_id': USER, 'request_id': RUN, 'message_id': ids[0], 'read_at': '2026-10-14T01:02:04+00:00'})],
            'visibility': [], 'hidden': [], 'session': [owned(session)], 'derived': [], 'descendantsAbsent': True,
        }
        b.read_boundary = {'messageIds': ids, 'foreignPostId': foreign_post, 'foreignRequestId': foreign_room,
            'foreignMessageId': foreign_message, 'hiddenMessageId': ids[-1], 'hiddenId': hidden,
            'originalSession': owned(session), 'references': [], 'descendantReferences': [],
            'phase': 'prepared', 'stage': 'initial', 'dispatchState': 'SQL_ENTRY_UNKNOWN',
            'graph': {**{k: sorted(x['rowSha256'] for x in b.native[k]) for k in ('posts', 'requests', 'messages')}, 'derived': []}}
        b.sql_calls = []
        b.ports = SimpleNamespace(sql=lambda sql: b.sql_calls.append(sql), session_proof=lambda account: True)
        b.read = lambda sql: copy.deepcopy(b.native)
        return b

    def hidden_native_row(self, b):
        s = b.read_boundary
        return {'row': {'id': s['hiddenId'], 'identity_id': b.qualifications[0]['identityId'],
                        'target_type': 'chat', 'target_id': s['hiddenMessageId']}, 'rowSha256': F}

    def test_read_boundary_wrong_scope_and_stage_order_never_dispatch_sql(self):
        b = self.read_case_boundary()
        for call in (lambda: b.prepare_read_boundary(OTHER), lambda: b.inspect_read_boundary(OTHER),
                     lambda: b.set_read_boundary(RUN, 'revoked'), lambda: b.set_read_boundary(RUN, 'restored'),
                     lambda: b.set_read_boundary(RUN, 'sql'), lambda: b.set_read_boundary(RUN, {'approved': True})):
            with self.assertRaises(ValueError):
                call()
        self.assertEqual(b.sql_calls, [])
        self.assertEqual(b.saved, {})

    def test_read_boundary_exact_native_scope_rejects_unknown_reads_session_and_hidden(self):
        b = self.read_case_boundary()
        original = copy.deepcopy(b.native)
        changes = [('reads', lambda v: v['reads'][0]['row'].update(user_id=RUN)),
                   ('reads', lambda v: v['reads'][0]['row'].update(message_id=RUN)),
                   ('reads', lambda v: v['reads'].append(copy.deepcopy(v['reads'][0]))),
                   ('messages', lambda v: v['messages'][0].update(rowSha256=F)),
                   ('session', lambda v: v['session'][0]['row'].update(registered_at='new-clock')),
                   ('hidden', lambda v: v['hidden'].append({'row': {'id': RUN}, 'rowSha256': H})),
                   ('visibility', lambda v: v['visibility'].append({'row': {'user_id': OTHER, 'request_id': RUN, 'hidden_at': 'time'}, 'rowSha256': H}))]
        for name, mutate in changes:
            with self.subTest(name=name):
                b.native = copy.deepcopy(original)
                mutate(b.native)
                with self.assertRaises(ValueError):
                    b.inspect_read_boundary(RUN)
                self.assertEqual(b.sql_calls, [])

    def test_read_boundary_digest_changes_on_native_rows_without_sending_rows_or_tokens(self):
        b = self.read_case_boundary()
        before = b.inspect_read_boundary(RUN)
        b.native['reads'][0]['row']['read_at'] = '2026-10-14T01:02:05+00:00'
        after = b.inspect_read_boundary(RUN)
        self.assertNotEqual(before['scopeRowsSha256'], after['scopeRowsSha256'])
        self.assertEqual(set(after), {'requestId', 'scopeRowsSha256', 'reads', 'hidden', 'visibility', 'sessionBindingRestored'})
        self.assertNotIn('registered_at', json.dumps(after))
        self.assertNotIn('synthetic-owned', json.dumps(after))
        self.assertEqual(after['reads'][0]['rowSha256'], H)
        self.assertTrue(after['sessionBindingRestored'])

    def test_read_boundary_unknown_cascade_descendant_blocks_inspection_and_cleanup(self):
        b = self.read_case_boundary()
        b.native['descendantsAbsent'] = False
        for call in (lambda: b.inspect_read_boundary(RUN), lambda: b.cleanup_read_boundary(),
                     lambda: b.set_read_boundary(RUN, 'hidden')):
            with self.assertRaisesRegex(ValueError, 'DESCENDANT_UNKNOWN_PRESERVED'):
                call()
        self.assertEqual(b.sql_calls, [])
        self.assertEqual(b.read_boundary['phase'], 'prepared')

    def test_read_boundary_cascade_guard_uses_all_fk_columns_and_exact_parent_scope(self):
        b = self.read_case_boundary()
        b.read_boundary['references'] = [{'schema': 'private', 'table': 'synthetic_parent', 'column': 'request_id', 'parent': 'requests'}]
        b.read_boundary['descendantReferences'] = [{'schema': 'private', 'table': 'synthetic_child',
            'parentSchema': 'private', 'parentTable': 'synthetic_parent', 'childColumns': ['parent_id', 'revision'],
            'parentColumns': ['id', 'revision']}]
        sql = b.read_boundary_statement(RUN)
        self.assertIn('c.parent_id=r.id and c.revision=r.revision', sql)
        self.assertIn('from private.synthetic_child c join private.synthetic_parent r', sql)
        self.assertIn('where r.request_id in(', sql)
        self.assertIn('descendantsAbsent', sql)
        self.assertNotIn('delete ', sql)
        self.assertEqual(b.sql_calls, [])

    def test_read_boundary_read_visibility_hidden_and_session_descendants_are_guarded(self):
        b = self.read_case_boundary()
        for table in ('conversation_message_reads', 'conversation_visibility', 'member_hidden_targets', 'naver_sessions'):
            with self.subTest(table=table):
                b.read_boundary['descendantReferences'] = [{'schema': 'private', 'table': 'synthetic_child',
                    'parentSchema': 'private', 'parentTable': table, 'childColumns': ['parent_id'], 'parentColumns': ['id']}]
                sql = b.read_boundary_statement(RUN)
                self.assertIn('from private.synthetic_child c join private.' + table + ' r on c.parent_id=r.id where ', sql)
                self.assertNotIn(' where )', sql)
        self.assertEqual(b.sql_calls, [])

    def test_read_boundary_stage_loss_preserves_unknown_and_does_not_resend(self):
        for stage in ('hidden', 'revoked', 'restored'):
            with self.subTest(stage=stage):
                b = self.read_case_boundary()
                if stage in ('revoked', 'restored'):
                    b.native['hidden'] = [self.hidden_native_row(b)]
                    b.read_boundary['stage'] = 'hidden' if stage == 'revoked' else 'revoked'
                if stage == 'restored':
                    b.native['session'] = []
                def lost(sql):
                    b.sql_calls.append(sql)
                    raise ValueError('SQLSTATE_08006')
                b.ports.sql = lost
                with self.assertRaisesRegex(ValueError, 'SQLSTATE_08006'):
                    b.set_read_boundary(RUN, stage)
                self.assertEqual(b.read_boundary['stage'], stage + '_unknown')
                self.assertEqual(b.read_boundary['dispatchState'], 'SQL_ENTRY_UNKNOWN')
                with self.assertRaisesRegex(ValueError, 'STAGE_ORDER'):
                    b.set_read_boundary(RUN, stage)
                self.assertEqual(len(b.sql_calls), 1)
                self.assertIn('read-boundary-' + stage + '-intent.json', b.saved)

    def test_read_boundary_restores_captured_session_timestamp_only_with_parent_proof(self):
        b = self.read_case_boundary()
        b.native['session'] = []
        b.native['hidden'] = [self.hidden_native_row(b)]
        sql = b.restore_read_boundary_sql(b.native)
        self.assertIn('2026-10-14T01:02:03.123456+00:00', sql)
        self.assertIn('jsonb_populate_record(null::private.naver_sessions', sql)
        self.assertIn('member_read_session_conflict', sql)
        self.assertIn("='" + F + "'", sql)
        self.assertNotIn('delete from auth.', sql)
        self.assertNotIn('insert into auth.', sql)
        self.assertNotIn('on conflict', sql)
        b.ports.session_proof = lambda account: False
        with self.assertRaisesRegex(ValueError, 'PARENT_SESSION'):
            b.restore_read_boundary_sql(b.native)
        self.assertEqual(b.sql_calls, [])

    def test_read_boundary_cleanup_compares_complete_scope_under_parent_child_locks(self):
        b = self.read_case_boundary()
        b.native['hidden'] = [self.hidden_native_row(b)]
        b.native['session'] = []
        b.native['visibility'] = [{'row': {'user_id': USER, 'request_id': RUN, 'hidden_at': 'time'}, 'rowSha256': N}]
        b.cleanup_read_boundary()
        self.assertEqual(len(b.sql_calls), 1)
        sql = b.sql_calls[0]
        self.assertLess(sql.index('from auth.sessions'), sql.index('from public.posts'))
        self.assertLess(sql.index('from public.posts'), sql.index('from public.join_requests'))
        self.assertLess(sql.index('member_read_scope_cas'), sql.index('delete from private.member_hidden_targets'))
        self.assertIn('is distinct from', sql)
        self.assertEqual(sql.count('delete from public.posts'), 2)
        self.assertIn('member_read_visibility_cas', sql)
        self.assertIn('member_read_receipt_cas', sql)
        self.assertEqual(b.read_boundary['phase'], 'cleaned')
        self.assertFalse(b.connection_closed)
        self.assertTrue(b.saved['read-boundary-cleaned.json']['wholeBaselineStillRequired'])

    def test_read_boundary_unknown_seed_or_cleanup_is_preserved_not_replayed(self):
        for phase in ('preparing', 'cleanup_unknown', 'cleaned'):
            with self.subTest(phase=phase):
                b = self.read_case_boundary()
                b.read_boundary['phase'] = phase
                with self.assertRaisesRegex(ValueError, 'UNKNOWN_PRESERVED'):
                    b.cleanup_read_boundary()
                self.assertEqual(b.sql_calls, [])
        b = self.read_case_boundary()
        def lost(sql):
            b.sql_calls.append(sql)
            raise ValueError('SQLSTATE_08006')
        b.ports.sql = lost
        with self.assertRaisesRegex(ValueError, 'SQLSTATE_08006'):
            b.cleanup_read_boundary()
        with self.assertRaisesRegex(ValueError, 'UNKNOWN_PRESERVED'):
            b.cleanup_read_boundary()
        self.assertEqual(len(b.sql_calls), 1)
        self.assertEqual(b.read_boundary['phase'], 'cleanup_unknown')

    def test_read_boundary_prepare_creates_97_plus_one_preserves_original_three(self):
        b = self.read_case_boundary()
        old_native, old_state = copy.deepcopy(b.native), copy.deepcopy(b.read_boundary)
        b.read_boundary = None
        b.inspect_conversation = lambda request: {'messages': [{'id': x, 'rowSha256': H} for x in b.fixture['messageIds']], 'reads': []}
        responses = iter([[old_state['originalSession']], [], [], True])
        def read(sql):
            if 'select jsonb_build_object(' not in sql:
                return next(responses)
            state = b.read_boundary
            value = copy.deepcopy(old_native)
            value['posts'][1]['row']['id'] = state['foreignPostId']
            value['requests'][1]['row'].update(id=state['foreignRequestId'], post_id=state['foreignPostId'])
            value['messages'] = [{'row': {'id': x, 'join_request_id': RUN, 'sender_id': OTHER}, 'rowSha256': H}
                for x in state['messageIds']] + [{'row': {'id': state['foreignMessageId'], 'join_request_id': state['foreignRequestId'], 'sender_id': OTHER}, 'rowSha256': H}]
            return value
        b.read = read
        value = b.prepare_read_boundary(RUN)
        self.assertEqual(len(value['messageIds']), 100)
        self.assertEqual(len(set(value['messageIds'])), 100)
        self.assertEqual(value['messageIds'][:3], b.fixture['messageIds'])
        self.assertNotIn(value['foreignMessageId'], value['messageIds'])
        self.assertEqual(value['hiddenMessageId'], value['messageIds'][-1])
        self.assertEqual(b.sql_calls[0].count('insert into public.chat_messages'), 98)
        self.assertEqual(len(b.sql_calls), 1)
        self.assertIn('read-boundary-state-intent.json', b.saved)
        self.assertIn('read-boundary-seed-intent.json', b.saved)
        self.assertNotIn('auth.users', b.sql_calls[0])
        self.assertEqual(b.read_boundary['phase'], 'prepared')
        with self.assertRaises(ValueError):
            b.prepare_read_boundary(RUN)
        self.assertEqual(len(b.sql_calls), 1)

    def maintenance_boundary(self, row):
        b = self.boundary()
        b.maintenance = {'maintenanceRequest': RUN, 'globalToken': OTHER}
        b.control_overrides = {'worker_runtime_atomic_control': True, 'ai_feedback_maintenance_control': True}
        b.original_global = {'singleton': True, 'token': None, 'expires_at': None}
        b.sql_calls = []
        b.ports = SimpleNamespace(sql=lambda sql: b.sql_calls.append(sql))
        b.read = lambda _: copy.deepcopy(row)
        return b

    def real_private_boundary(self, row):
        # 형식 검증·파일 I/O helper만 로드한다. DB/Auth/VM 코드나 자원은 호출하지 않는다.
        h = m.load_j01().load_helpers()
        temporary = tempfile.TemporaryDirectory(prefix='member-receipt-abi-', dir='/private/tmp')
        self.addCleanup(temporary.cleanup)
        b = self.maintenance_boundary(row)
        b.h = h
        b.evidence = Path(temporary.name).resolve()
        b.artifact_writes = []
        def save(name, value):
            result = h.provisioning_json(b.evidence, name, value)
            b.artifact_writes.append(name)
            b.saved[name] = copy.deepcopy(value)
            return result
        b.save = save
        return b

    def qualification_boundary(self):
        b = self.real_private_boundary(None)
        b.maintenance = None
        b.control_overrides = {}
        b.binding['accounts'][0]['sessionId'] = OTHER
        b.outer_baseline = self.snapshot()
        b.snapshot_calls = []
        b.ports.snapshot = lambda: b.snapshot_calls.append(True) or copy.deepcopy(b.outer_baseline)
        responses = iter([
            {'id': USER, 'avatar_url': None},
            [{'id': OTHER, 'profile_id': USER, 'ended_at': None, 'identity_id': None}],
            True,
            {'identityId': RUN, 'accountSha256': H, 'profileSha256': H, 'episodeSha256': H,
             'keySha256': H, 'sessionSha256': H, 'objectSha256': H},
        ])
        b.read = lambda _: next(responses)
        return b

    def qualification_with_old_filename_collision(self):
        b = self.qualification_boundary()
        save = b.save
        def old_collision(name, value):
            # 원 결함과 같은 O_EXCL 순서: 상태 intent를 먼저 저장한 뒤 SQL intent가 충돌한다.
            return save('qualification-0-state-intent.json' if name == 'qualification-0-intent.json' else name, value)
        b.save = old_collision
        with self.assertRaises(FileExistsError):
            b.qualify(0, True)
        return b

    def completed_maintenance(self):
        return {'requestId': RUN, 'globalToken': OTHER, 'operation': 'helpful_maintenance', 'state': 'completed',
                'input': {'limit': 1}, 'result': {'deletedCount': 1}, 'deletedCount': 1,
                'closedAt': '2026-10-14T00:00:00Z', 'purgedAt': None,
                'fingerprintMatches': True, 'rowSha256': H}

    def frame(self, method='verifyTarget', **args):
        return {'type': 'call', 'requestId': RUN, 'sequence': 1, 'method': method,
                'args': {'runId': RUN, 'bindingSha256': H, **args}}

    def rejects_before_live(self, frame):
        b = self.boundary()
        with self.assertRaises(ValueError):
            b.dispatch(frame)
        self.assertEqual(b.live_calls, [])
        self.assertEqual(b.sequence, 0)

    def test_default_and_reviewed_without_run_are_not_run(self):
        for args in ([], ['--reviewed', '/never-read-private-packet']):
            with self.subTest(args=args):
                p = subprocess.run([sys.executable, '-B', str(CALLER), *args], capture_output=True, text=True)
                self.assertEqual(p.returncode, 0)
                value = json.loads(p.stdout)
                self.assertEqual(value['status'], 'NOT_RUN')
                self.assertEqual(value['credentialReads'], 0)
                self.assertFalse(value['vmStarted'])
                self.assertFalse(value['ready'])
                self.assertEqual(len(value['methods']), 16)
                self.assertNotIn('sql', value['methods'])

    def test_run_requires_reviewed_packet_without_implicit_auth(self):
        p = subprocess.run([sys.executable, '-B', str(CALLER), '--run'], capture_output=True, text=True)
        self.assertEqual(p.returncode, 2)
        self.assertEqual(json.loads(p.stdout)['status'], 'BLOCKED')
        self.assertEqual(p.stderr, '')

    def test_no_arbitrary_sql_control_or_approval_callback(self):
        for method in ('sql', 'setGuard', 'createAuth', 'deleteAuth', 'startWorker', 'grant', 'controller'):
            with self.subTest(method=method):
                self.rejects_before_live(self.frame(method, sql='select private_data', approved=True))

    def test_exact_frame_and_method_arguments(self):
        frames = [self.frame(extra='sensitive-untrusted-string'), self.frame(sql='select 1')]
        for key, value in [('requestId', OTHER), ('sequence', 0), ('sequence', True), ('type', 'approval')]:
            f = self.frame()
            f[key] = value
            frames.append(f)
        for key, value in [('runId', OTHER), ('bindingSha256', F)]:
            f = self.frame()
            f['args'][key] = value
            frames.append(f)
        for f in frames:
            with self.subTest(frame=f):
                self.rejects_before_live(f)

    def test_success_consumes_sequence_and_replay_is_rejected(self):
        b = self.boundary()
        result = b.dispatch(self.frame())
        self.assertEqual(result['requestId'], RUN)
        self.assertEqual(result['sequence'], 1)
        self.assertTrue(result['ok'])
        before = len(b.live_calls)
        with self.assertRaises(ValueError):
            b.dispatch(self.frame())
        self.assertEqual(len(b.live_calls), before)

    def test_wrong_owned_scope_rejected_before_any_sql(self):
        b = self.boundary()
        b.read = lambda *_: self.fail('wrong owned scope reached SQL')
        b.mutate = lambda *_: self.fail('wrong owned scope reached mutation')
        for call in (lambda: b.prepare_conversation([USER, USER]),
                     lambda: b.inspect_conversation(OTHER),
                     lambda: b.inspect_ai(OTHER, RUN),
                     lambda: b.inspect_maintenance(RUN),
                     lambda: b.prepare_retention(OTHER, RUN, USER)):
            with self.assertRaises(ValueError):
                call()

    def test_read_only_native_postgres_booleans_and_json_keep_exact_types(self):
        h = m.load_j01().load_helpers()
        responses = [('t', True), ('f', False), ('true', True), ('false', False),
                     ('null', None), ('0', 0), ('"f"', 'f'), ('{"exists":true}', {'exists': True})]
        for raw, expected in responses:
            with self.subTest(raw=raw):
                b = self.boundary()
                b.h = h
                calls = []
                b.ports = SimpleNamespace(read_sql=lambda sql, timeout: calls.append((sql, timeout)) or raw)
                value = b.read('select native_boolean_or_json;')
                self.assertEqual(value, expected)
                self.assertIs(type(value), type(expected))
                self.assertEqual(calls, [('select native_boolean_or_json;', 5)])
                self.assertEqual(len(b.live_calls), 1)

    def test_malformed_native_read_never_defaults_to_false(self):
        h = m.load_j01().load_helpers()
        for raw in ('', 't garbage', 'f ', 'TRUE', 'not-json', '{broken}',
                    'NaN', 'Infinity', '{"exists":true,"exists":false}', False):
            with self.subTest(raw=raw):
                b = self.boundary()
                b.h = h
                b.ports = SimpleNamespace(read_sql=lambda sql, timeout: raw)
                with self.assertRaises(ValueError):
                    b.read('select native_boolean_or_json;')

    def test_owned_subtraction_preserves_duplicate_unknown_rows(self):
        self.assertEqual(m.subtract_owned_bags({'public.profiles': {H: 2, F: 1}},
                                             {'public.profiles': {H: 1}}),
                         {'public.profiles': {H: 1, F: 1}})
        for owned in ({'private.new_unknown_table': {H: 1}}, {'public.profiles': {N: 1}},
                      {'public.profiles': {H: 3}}, {'public.profiles': {H: True}}):
            with self.subTest(owned=owned), self.assertRaises(ValueError):
                m.subtract_owned_bags({'public.profiles': {H: 2, F: 1}}, owned)

    def snapshot(self):
        return {'rows': {'public.profiles': {H: 1, F: 1}, 'cron.job': {}},
                'authoritySha256': H, 'constraintsSha256': F, 'catalogSha256': N}

    def test_last_member_only_changes_do_not_exempt_first_five_or_unknown(self):
        before = self.snapshot()
        after = copy.deepcopy(before)
        after['rows']['public.profiles'] = {N: 1, F: 1}
        m.foreign_state_unchanged(before, after, {'public.profiles': {H: 1}}, {'public.profiles': {N: 1}})
        # 같은 profiles 테이블의 다른 회원 변화는 테이블 예외로 통과시킬 수 없다.
        after['rows']['public.profiles'] = {N: 1, 'd' * 64: 1}
        with self.assertRaisesRegex(ValueError, 'FOREIGN_ROW_CHANGED'):
            m.foreign_state_unchanged(before, after, {'public.profiles': {H: 1}}, {'public.profiles': {N: 1}})

    def test_authority_catalog_and_cron_remain_exact(self):
        before = self.snapshot()
        for key in ('authoritySha256', 'constraintsSha256', 'catalogSha256'):
            after = copy.deepcopy(before)
            after[key] = 'e' * 64
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'AUTHORITY_OR_CATALOG_CHANGED'):
                m.foreign_state_unchanged(before, after, {}, {})
        after = copy.deepcopy(before)
        after['rows']['cron.job'][H] = 1
        with self.assertRaisesRegex(ValueError, 'FOREIGN_ROW_CHANGED'):
            m.foreign_state_unchanged(before, after, {}, {})

    def test_safe_errors_never_record_sql_url_or_secret_text(self):
        for error in (ValueError('https://secret.example/sql?key=sensitive'),
                      ValueError('SQLSTATE_55000 SELECT secret'), ValueError('MEMBER_ROOT_X\nprivate'),
                      ValueError('MEMBER_ROOT_X', 'second-secret'), ValueError('SIGNED_UNREVIEWED_CODE')):
            with self.subTest(error=type(error).__name__):
                self.assertEqual(m.safe_code(error), 'MEMBER_ROOT_UNCLASSIFIED_FAILURE')
        self.assertEqual(m.safe_code(ValueError('MEMBER_ROOT_FIXED_FRAME')), 'MEMBER_ROOT_FIXED_FRAME')
        self.assertEqual(m.safe_code(ValueError('SQLSTATE_55000')), 'SQLSTATE_55000')

    def test_guard_restoration_cas_is_owned_and_no_other_flags(self):
        b = self.boundary()
        b.original_controls = {'retirement': {'singleton': True, 'enabled': False,
                                'expected_issuer': None, 'expected_audience': 'authenticated'}}
        changes = {'enabled': True, 'expected_issuer': 'http://127.0.0.1:501/auth/v1'}
        opened = b.control_cas('retirement', changes, True)
        closed = b.control_cas('retirement', changes, False)
        self.assertIn('to_jsonb(c)=', opened)
        self.assertIn('member_control_cas', closed)
        self.assertIn('expected_issuer=null', closed)
        self.assertNotIn('ai_processing_guard', opened)
        self.assertNotIn('grant ', opened)
        with self.assertRaises(ValueError):
            b.control_cas('not_an_owned_guard', {'enabled': True}, True)
        with self.assertRaises(ValueError):
            b.control_cas('retirement', {'singleton': False}, True)

    def test_absent_pending_prepared_and_unknown_preserve_worker_global_guards(self):
        rows = [None]
        for state in ('external_pending', 'prepared', 'UNKNOWN', 'purged'):
            row = self.completed_maintenance()
            row['state'] = state
            rows.append(row)
        for row in rows:
            with self.subTest(state=None if row is None else row['state']):
                b = self.maintenance_boundary(row)
                before_controls = copy.deepcopy(b.control_overrides)
                with self.assertRaisesRegex(ValueError, 'COMPLETION_UNVERIFIED'):
                    b.cleanup_connections([USER, OTHER])
                self.assertEqual(b.sql_calls, [])
                self.assertEqual(b.control_overrides, before_controls)
                self.assertFalse(b.connection_closed)
                self.assertEqual(b.connection_closure, 'UNVERIFIED')
                receipt = b.saved['maintenance-unclosed-1.json']
                self.assertFalse(receipt['wholeBaselineRestored'])
                self.assertTrue(receipt['absentIsNotProofOfNoDispatch'])
                self.assertTrue(receipt['retirementBlocked'])

    def test_completed_requires_original_token_operation_expected_result_and_read_hash(self):
        overrides = [('globalToken', USER), ('operation', 'report_delete'), ('deletedCount', 0),
                     ('result', {'deletedCount': 0}), ('input', {'limit': True}), ('fingerprintMatches', False),
                     ('closedAt', None), ('purgedAt', '2026-10-14T00:00:01Z'), ('rowSha256', 'invalid')]
        for key, value in overrides:
            with self.subTest(key=key):
                row = self.completed_maintenance()
                row[key] = value
                b = self.maintenance_boundary(row)
                with self.assertRaises(ValueError):
                    b.cleanup_connections([USER, OTHER])
                self.assertEqual(b.sql_calls, [])
                self.assertIsNone(b.maintenance_completion)

    def test_lookup_failure_preserves_unclosed_scope_and_blocks_retirement(self):
        b = self.maintenance_boundary(None)
        b.read = lambda _: (_ for _ in ()).throw(ValueError('SQLSTATE_08006'))
        b.binding['accounts'].extend([{'userId': RUN}] * 4)
        with self.assertRaisesRegex(ValueError, 'SQLSTATE_08006'):
            b.prepare_retirement(RUN)
        self.assertEqual(b.sql_calls, [])
        self.assertIsNone(b.retirement)
        self.assertFalse(hasattr(b, 'retirement_baseline'))
        self.assertEqual(b.saved['maintenance-unclosed-1.json']['failureCode'], 'SQLSTATE_08006')
        self.assertEqual(b.connection_closure, 'UNVERIFIED')

    def test_completed_read_receipt_cannot_be_replaced_after_row_changes(self):
        b = self.maintenance_boundary(self.completed_maintenance())
        b.inspect_maintenance(RUN)
        self.assertEqual(b.saved['maintenance-completed-read-proof.json']['rowSha256'], H)
        changed = self.completed_maintenance()
        changed['rowSha256'] = F
        b.read = lambda _: changed
        with self.assertRaisesRegex(ValueError, 'COMPLETION_CHANGED'):
            b.cleanup_connections([USER, OTHER])
        self.assertEqual(b.sql_calls, [])
        self.assertEqual(b.maintenance_completion['rowSha256'], H)
        self.assertFalse(b.connection_closed)

    def test_completed_delete_requires_read_receipt_and_transactional_row_count_cas(self):
        b = self.maintenance_boundary(self.completed_maintenance())
        with self.assertRaisesRegex(ValueError, 'READ_PROOF_REQUIRED'):
            b.completed_maintenance_delete()
        b.inspect_maintenance(RUN)
        sql = b.completed_maintenance_delete()
        self.assertIn("state='completed'", sql)
        self.assertIn("result='{\"deletedCount\":1}'::jsonb", sql)
        self.assertIn("='" + H + "'", sql)
        self.assertIn('get diagnostics n=row_count;if n<>1 then raise exception', sql)
        self.assertIn(RUN, sql)
        self.assertIn(OTHER, sql)
        self.assertEqual(b.sql_calls, [])

    def test_completed_two_reads_and_cleanup_single_delete_use_exclusive_private_abi(self):
        b = self.real_private_boundary(self.completed_maintenance())
        b.original_controls = {'atomic': {'singleton': True, 'enabled': False},
                               'feedback': {'singleton': True, 'enabled': False}}
        b.original_grants = {s: False for s in m.MAINTENANCE_SIGNATURES}
        b.qualifications = {}
        b.baseline_bucket = [{'id': 'profile-images'}]
        b.outer_baseline = self.snapshot()
        b.ports.snapshot = lambda: copy.deepcopy(b.outer_baseline)
        reads = []
        b.read = lambda sql: reads.append(sql) or self.completed_maintenance()
        b.inspect_maintenance(RUN)
        receipt = b.evidence / 'maintenance-completed-read-proof.json'
        original_bytes, original_inode = receipt.read_bytes(), receipt.stat().st_ino
        self.assertEqual(stat.S_IMODE(receipt.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(b.evidence.stat().st_mode), 0o700)
        with self.assertRaises(FileExistsError):
            b.h.provisioning_json(b.evidence, receipt.name, self.completed_maintenance())
        result = b.cleanup_connections([USER, OTHER])
        self.assertTrue(result['baselineRestored'])
        self.assertEqual(len(reads), 2)
        self.assertEqual(len(b.sql_calls), 1)
        self.assertEqual(b.sql_calls[0].count('delete from private.worker_runtime_results'), 1)
        self.assertEqual(b.artifact_writes.count(receipt.name), 1)
        self.assertEqual(receipt.read_bytes(), original_bytes)
        self.assertEqual(receipt.stat().st_ino, original_inode)
        self.assertTrue(b.cleanup_connections([USER, OTHER])['alreadyClosed'])
        self.assertEqual(len(b.sql_calls), 1)

    def test_unknown_repeated_observations_preserve_first_private_receipt_and_mutate_zero(self):
        b = self.real_private_boundary(None)
        with self.assertRaisesRegex(ValueError, 'COMPLETION_UNVERIFIED'):
            b.cleanup_connections([USER, OTHER])
        first = b.evidence / 'maintenance-unclosed-1.json'
        original_bytes, original_inode = first.read_bytes(), first.stat().st_ino
        with self.assertRaisesRegex(ValueError, 'COMPLETION_UNVERIFIED'):
            b.cleanup_connections([USER, OTHER])
        self.assertEqual(b.sql_calls, [])
        self.assertFalse(b.connection_closed)
        self.assertEqual(first.read_bytes(), original_bytes)
        self.assertEqual(first.stat().st_ino, original_inode)
        self.assertEqual(stat.S_IMODE(first.stat().st_mode), 0o600)
        self.assertEqual(b.artifact_writes, ['maintenance-unclosed-1.json', 'maintenance-unclosed-2.json'])
        self.assertTrue((b.evidence / 'maintenance-unclosed-2.json').is_file())

    def test_completed_private_receipt_changed_bytes_block_cleanup(self):
        b = self.real_private_boundary(self.completed_maintenance())
        b.inspect_maintenance(RUN)
        receipt = b.evidence / 'maintenance-completed-read-proof.json'
        # 같은 JSON에 공백만 추가해도 최초의 원 bytes 고정값이 달라지면 거절한다.
        receipt.write_bytes(receipt.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'MAINTENANCE_RECEIPT_BYTES'):
            b.cleanup_connections([USER, OTHER])
        self.assertEqual(b.sql_calls, [])
        self.assertFalse(b.connection_closed)
        self.assertEqual(b.connection_closure, 'UNVERIFIED')

    def test_retirement_three_observations_preserve_one_exclusive_private_receipt(self):
        b = self.real_private_boundary(None)
        value = {'withdrawalId': RUN, 'originalUserId': USER, 'state': 'pending_cleanup',
                 'ackSha256': None, 'rowSha256': H}
        b.record_retirement_observation(value)
        receipt = b.evidence / 'retirement-observed.json'
        original_bytes, original_inode = receipt.read_bytes(), receipt.stat().st_ino
        b.record_retirement_observation(copy.deepcopy(value))
        b.record_retirement_observation(copy.deepcopy(value))
        self.assertEqual(b.artifact_writes, ['retirement-observed.json'])
        self.assertEqual(receipt.read_bytes(), original_bytes)
        self.assertEqual(receipt.stat().st_ino, original_inode)
        self.assertEqual(stat.S_IMODE(receipt.stat().st_mode), 0o600)
        changed = {**value, 'ackSha256': F}
        with self.assertRaisesRegex(ValueError, 'RETIREMENT_OBSERVATION_CHANGED'):
            b.record_retirement_observation(changed)
        self.assertEqual(receipt.read_bytes(), original_bytes)

    def test_retirement_observation_revalidates_original_private_bytes(self):
        b = self.real_private_boundary(None)
        value = {'withdrawalId': RUN, 'originalUserId': USER, 'state': 'pending_cleanup', 'ackSha256': None}
        b.record_retirement_observation(value)
        receipt = b.evidence / 'retirement-observed.json'
        receipt.write_bytes(receipt.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'RETIREMENT_OBSERVATION_BYTES'):
            b.record_retirement_observation(value)
        self.assertEqual(b.artifact_writes, ['retirement-observed.json'])

    def test_local_node_terminal_requires_parent_stdin_eof_and_exits_zero(self):
        node = shutil.which('node')
        self.assertIsNotNone(node, 'local Node is required for the stdio responsibility test')
        temporary = tempfile.TemporaryDirectory(prefix='member-node-eof-', dir='/private/tmp')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        driver = root / m.DRIVER
        driver.parent.mkdir(parents=True)
        # 이 로컬 child는 stdin/stdout만 사용한다. VM/HTTP/DB/provider 호출은 없다.
        driver.write_text("""import {createInterface} from 'node:readline';
const reader=createInterface({input:process.stdin});
reader.once('line',line=>{
 const initial=JSON.parse(line);
 process.stdout.write(JSON.stringify({type:'result',requestId:initial.requestId,sequence:0,
   proof:{status:'ROOT_ATTESTATION_REQUIRED',localStdioOnly:true}})+'\\n');
});
await new Promise(resolve=>reader.once('close',resolve));
process.exitCode=0;
""")
        b = self.boundary()
        b.node = Path(node)
        b.input = {'codeRoot': str(root)}
        b.j01 = SimpleNamespace(RootJ01Boundary=SimpleNamespace(node_env=lambda _: {}))
        b.h = SimpleNamespace(signed_exact_json=json.loads)
        proof = b.invoke_node()
        self.assertEqual(proof, {'status': 'ROOT_ATTESTATION_REQUIRED', 'localStdioOnly': True})
        self.assertTrue(b.child.stdin.closed)
        self.assertEqual(b.child.returncode, 0)
        b.child.stdout.close()

    def test_qualification_state_and_sql_intents_use_distinct_exclusive_files(self):
        b = self.qualification_boundary()
        state = b.qualify(0, True)
        self.assertEqual(len(b.sql_calls), 1)
        self.assertEqual(b.artifact_writes, ['qualification-0-state-intent.json',
                                          'qualification-0-intent.json', 'qualification-0-owned.json'])
        original = b.h.signed_exact_json(b.h.signed_private_read(b.evidence / 'qualification-0-state-intent.json'))
        self.assertEqual(original['dispatchState'], 'NOT_SENT')
        self.assertEqual(state['dispatchState'], 'SQL_ENTRY_UNKNOWN')
        self.assertEqual(state['accountSha256'], H)

    def test_pre_sql_collision_closes_only_with_independent_complete_snapshot_equality(self):
        b = self.qualification_with_old_filename_collision()
        original = (b.evidence / 'qualification-0-state-intent.json').read_bytes()
        self.assertEqual(b.sql_calls, [])
        result = b.cleanup_connections([USER, OTHER])
        self.assertTrue(result['baselineRestored'])
        self.assertEqual(b.snapshot_calls, [True])
        self.assertEqual(b.sql_calls, [])
        self.assertEqual(b.connection_closure, 'VERIFIED_NO_DISPATCH')
        self.assertEqual((b.evidence / 'qualification-0-state-intent.json').read_bytes(), original)
        self.assertFalse(b.saved['connections-closed-no-dispatch.json']['fileAbsenceUsedAsEvidence'])

    def test_pre_sql_collision_with_changed_snapshot_preserves_unverified_scope(self):
        b = self.qualification_with_old_filename_collision()
        changed = self.snapshot()
        changed['authoritySha256'] = F
        b.ports.snapshot = lambda: changed
        with self.assertRaisesRegex(ValueError, 'BASELINE_CHANGED_PRESERVED'):
            b.cleanup_connections([USER, OTHER])
        self.assertFalse(b.connection_closed)
        self.assertEqual(b.connection_closure, 'UNVERIFIED')
        self.assertEqual(b.sql_calls, [])
        self.assertNotIn('connections-closed-no-dispatch.json', b.saved)

    def test_failure_after_sql_entry_never_infers_not_sent_from_missing_owned_file(self):
        b = self.qualification_boundary()
        def sent_failure(sql):
            b.sql_calls.append(sql)
            raise ValueError('SQLSTATE_08006')
        b.ports.sql = sent_failure
        with self.assertRaisesRegex(ValueError, 'SQLSTATE_08006'):
            b.qualify(0, True)
        self.assertEqual(b.qualifications[0]['dispatchState'], 'SQL_ENTRY_UNKNOWN')
        self.assertFalse((b.evidence / 'qualification-0-owned.json').exists())
        with self.assertRaisesRegex(ValueError, 'QUALIFICATION_UNKNOWN_PRESERVED'):
            b.cleanup_connections([USER, OTHER])
        self.assertEqual(len(b.sql_calls), 1)
        self.assertEqual(b.snapshot_calls, [])
        self.assertFalse(b.connection_closed)

    def test_rpc_metadata_sql_casts_preserve_strict_integer_identity(self):
        b = self.boundary()
        values = {s: {'oid': 1000 + i, 'owner': 10, 'proacl': None, 'rowSha256': H, 'serviceExecute': False}
                  for i, s in enumerate(m.RETIREMENT_SIGNATURES)}
        statements = []
        b.read = lambda sql: statements.append(sql) or copy.deepcopy(values)
        self.assertEqual(b.retirement_function_rows(), values)
        self.assertIn("'oid',p.oid::bigint,'owner',p.proowner::bigint", statements[0])
        self.assertIn(m.row_sha_sql('p'), statements[0])
        bad = {s: {**v, 'oid': str(v['oid']), 'owner': str(v['owner'])} for s, v in values.items()}
        b.read = lambda _: bad
        with self.assertRaisesRegex(ValueError, 'RETIREMENT_RPC_METADATA'):
            b.retirement_function_rows()

    def test_retirement_metadata_failure_closes_only_unchanged_pre_mutation_scope(self):
        b = self.real_private_boundary(None)
        b.maintenance = None
        b.control_overrides = {}
        b.connection_closed = True
        b.binding['accounts'].extend([{'userId': RUN, 'sessionId': OTHER}] * 4)
        baseline = self.snapshot()
        snapshots = []
        b.ports.snapshot = lambda: snapshots.append(True) or copy.deepcopy(baseline)
        bad = {s: {'oid': '1000', 'owner': '10', 'proacl': None, 'rowSha256': H, 'serviceExecute': False}
               for s in m.RETIREMENT_SIGNATURES}
        reads = iter([[{'id': OTHER, 'ended_at': None, 'identity_id': None}], {}, bad])
        b.read = lambda _: next(reads)
        with self.assertRaisesRegex(ValueError, 'RETIREMENT_RPC_METADATA'):
            b.prepare_retirement(RUN)
        self.assertTrue(b.retirement_attempted)
        self.assertIsNone(b.retirement)
        self.assertEqual(b.qualifications, {})
        self.assertEqual(b.sql_calls, [])
        b.close_retirement_preparation_not_dispatched()
        self.assertTrue(b.retirement_preparation_closed)
        self.assertEqual(len(snapshots), 2)
        receipt = b.saved['retirement-preparation-not-dispatched-closed.json']
        self.assertTrue(receipt['originalExecutionFailurePreserved'])
        self.assertFalse(receipt['fileAbsenceUsedAsEvidence'])
        self.assertEqual(receipt['actualRetirement'], 'NOT_RUN')
        with self.assertRaisesRegex(ValueError, 'RETIREMENT_OWNED_USER'):
            b.prepare_retirement(RUN)
        self.assertEqual(len(snapshots), 2)
        self.assertEqual(b.sql_calls, [])

    def completed_boundary(self):
        b = self.boundary()
        b.completed_mode = True
        b.input = {'completionMode': 'ack_loss'}
        b.binding['accounts'] = [{'userId': str(uuid.UUID(int=50 + i)), 'sessionId': str(uuid.UUID(int=60 + i)),
                                 'authEmail': 'synthetic-ai-test-' + str(i) + '@example.invalid'} for i in range(6)]
        b.storage_receipt = None
        b.completed_retirement = {'status': 'prepared', 'userId': b.binding['accounts'][5]['userId'],
            'withdrawalId': RUN, 'objectId': OTHER, 'objectSha256': H, 'objectBytes': 128,
            'invocationRequestId': str(uuid.UUID(int=90)), 'recoveryRequestId': str(uuid.UUID(int=91))}
        b.completion_functions = {}
        b.sql_calls = []
        b.ports = SimpleNamespace(sql=lambda sql: b.sql_calls.append(sql))
        return b

    def completed_native(self, b):
        s = b.completed_retirement
        tasks = [{'taskId': str(uuid.UUID(int=100 + i)), 'withdrawalId': RUN, 'profileId': s['userId'],
                  'kind': kind, 'state': 'pending', 'objectId': OTHER if i == 0 else None,
                  'leaseToken': None, 'workerRunToken': None, 'leaseExpiresAt': None,
                  'evidenceSha256': None, 'completedAt': None, 'rowSha256': H, 'dispatch': None, 'ack': None}
                 for i, kind in enumerate(('storage_object', 'auth_user'))]
        return {'withdrawalId': RUN, 'userId': s['userId'], 'state': 'pending_cleanup', 'rowSha256': H,
                'ackSha256': None, 'tasks': tasks, 'invocations': [], 'reconciliations': [],
                'authUserPresent': True, 'storageObjectPresent': True}

    def test_completed_methods_are_unavailable_in_original_v1_before_live(self):
        b = self.boundary()
        for name, fields in m.COMPLETED_METHOD_ARGS.items():
            args = {'runId': RUN, 'bindingSha256': H, 'userId': USER}
            if 'withdrawalId' in fields:
                args['withdrawalId'] = RUN
            with self.assertRaisesRegex(ValueError, 'FIXED_FRAME'):
                b.dispatch({'type': 'call', 'requestId': RUN, 'sequence': 1, 'method': name, 'args': args})
        self.assertEqual(b.live_calls, [])
        self.assertEqual(len(m.METHOD_ARGS), 16)

    def test_completed_new_packet_does_not_enable_old_mutation_methods(self):
        b = self.completed_boundary()
        with self.assertRaisesRegex(ValueError, 'FIXED_FRAME'):
            b.dispatch({'type': 'call', 'requestId': RUN, 'sequence': 1, 'method': 'prepareRetirement',
                        'args': {'runId': RUN, 'bindingSha256': H, 'userId': b.completed_retirement['userId']}})
        self.assertEqual(b.sql_calls, [])
        self.assertEqual(b.live_calls, [])

    def test_completed_missing_creation_metadata_cannot_be_current_inspect_or_created_flag(self):
        b = self.completed_boundary()
        for alleged in (None, {'created': True}, {'id': 'a' * 64, 'image': 'sha256:' + H, 'configSha256': H}):
            b.storage_receipt = alleged
            with self.assertRaisesRegex(ValueError, 'STORAGE_CREATION_CONTRACT_REQUIRED'):
                b.verify_completed_storage()
        self.assertEqual(b.sql_calls, [])

    def storage_creation_model(self):
        root = Path('/synthetic-model-only')
        project = 'jonghyun-backend100-12345678'
        target = {'project': project, 'context': 'colima-jonghyun-backend100', 'host': 'unix:///synthetic-model-only/docker.sock'}
        def container(i, name, selected):
            return {'id': format(i, '064x'), 'name': name, 'image': 'sha256:' + H,
                'configSha256': H, 'hostConfigSha256': H, 'mountsSha256': H,
                'project': selected, 'running': True, 'oomKilled': False}
        old = [container(i + 1, 'preserved-' + str(i), 'preserved') for i in range(6)]
        roles = ('db', 'auth', 'rest', 'kong', 'storage', 'inbucket')
        new = [container(i + 20, 'supabase_' + role + '_' + project, project) for i, role in enumerate(roles)]
        before = {'containers': old, 'networks': [], 'volumes': []}
        added = {'containers': new, 'networks': [{'id': 'd' * 64, 'name': 'supabase_network_' + project, 'inspectionSha256': H}],
                 'volumes': [{'name': 'supabase_db_' + project, 'inspectionSha256': H}, {'name': 'supabase_storage_' + project, 'inspectionSha256': H}]}
        after = {'containers': old + new, 'networks': added['networks'], 'volumes': added['volumes']}
        protected = {'containers': [{**{k: v for k, v in c.items() if k not in ('project', 'running', 'oomKilled')},
                        'state': {'running': True, 'oomKilled': False}} for c in old], 'customNetworks': [], 'volumes': []}
        common = {'version': 1, 'head': '1' * 40, 'producerPath': 'tools/local/start_owned_validation.py',
            'producerSha256': H, 'preparedRoot': str(root), 'project': project, 'context': target['context'], 'dockerHost': target['host']}
        original = {**common, 'scenario': 'OWNED_RESOURCES_CREATION_V1', 'intentBeforeSha256': H, 'protectedBaselineSha256': H,
            'cli': {'path': '/synthetic-model-only/supabase', 'sha256': '42a9fe8b8a266bc0fbde804c08efb75cc0653480e91ba3f20fba1c3c27a7b49a', 'version': '2.116.0'},
            'command': ['/synthetic-model-only/supabase', 'start', '--workdir', str(root), '-x', 'realtime,imgproxy'], 'commandExit': 0,
            'commandStdoutSha256': H, 'commandStderrSha256': H, 'before': before, 'after': after, 'owned': added}
        receipt = {**common, 'scenario': 'OWNED_STORAGE_CREATION_V1',
            'originalCreationReceiptPath': str(root / 'owned-resource-creation-receipt.json'), 'originalCreationReceiptSha256': H,
            'ownedContainersSha256': H, 'storage': {k: new[4][k] for k in ('id', 'name', 'image', 'configSha256', 'hostConfigSha256', 'mountsSha256')}}
        producer = CALLER.parents[3] / 'tools/local/start_owned_validation.py'
        tree = ast.parse(producer.read_text())
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'creation_delta')
        import re
        namespace = {'require': m.require, 're': re}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(producer), 'exec'), namespace)
        return receipt, original, new, protected, root, target, common['head'], namespace['creation_delta']

    def test_completed_original_creation_model_rejects_existing_resource_and_storage_mismatch(self):
        fixture = self.storage_creation_model()
        result = m.validate_storage_creation(*copy.deepcopy(fixture[:-1]), fixture[-1])
        self.assertEqual(result, fixture[0]['storage'])
        changes = [lambda f: f[0]['storage'].update(image='sha256:' + F),
                   lambda f: f[1]['after']['containers'][0].update(configSha256=F),
                   lambda f: f[1].update(commandExit=1),
                   lambda f: f[1].update(command=['supabase', 'stop']),
                   lambda f: f[0].update(created=True),
                   lambda f: f[1]['after']['containers'].pop(),
                   lambda f: f[1]['after']['containers'].append(copy.deepcopy(f[1]['after']['containers'][0]))]
        for mutate in changes:
            bad = list(copy.deepcopy(fixture[:-1]))
            mutate(bad)
            with self.assertRaises(ValueError):
                m.validate_storage_creation(*bad, fixture[-1])
        # 이 검사는 정형 관측의 모형 대조이며 start/VM/SQL/Auth/HTTP를 실행하지 않는다.

    def test_completed_current_storage_config_or_image_drift_refused(self):
        b = self.completed_boundary()
        b.target = {'project': 'jonghyun-backend100-12345678'}
        c = {'Id': 'd' * 64, 'Name': '/supabase_storage_' + b.target['project'], 'Image': 'sha256:' + H,
             'State': {'Running': True, 'OOMKilled': False},
             'Config': {'Labels': {'com.supabase.cli.project': b.target['project']}}, 'HostConfig': {}, 'Mounts': []}
        canon = lambda v: m.sha(json.dumps(v, sort_keys=True, separators=(',', ':')).encode())
        b.storage_receipt = {'id': c['Id'], 'name': c['Name'][1:], 'image': c['Image'],
            'configSha256': canon(c['Config']), 'hostConfigSha256': canon(c['HostConfig']), 'mountsSha256': canon(c['Mounts'])}
        b.storage_creation_verified = True
        b.ports.runner = SimpleNamespace(call=lambda args: json.dumps([c]))
        b.h.signed_exact_json = json.loads
        b.verify_completed_storage()
        for field in ('Id', 'Image'):
            before = c[field]
            c[field] = 'wrong-owned-target'
            with self.assertRaisesRegex(ValueError, 'STORAGE_CURRENT_IDENTITY'):
                b.verify_completed_storage()
            c[field] = before
        c['Mounts'].append({'Source': '/other-target'})
        with self.assertRaisesRegex(ValueError, 'STORAGE_CURRENT_CONFIG'):
            b.verify_completed_storage()
        self.assertEqual(b.sql_calls, [])

    def test_creation_port_preflight_requires_exact_overlay_ports_and_all_free_without_reservation(self):
        overlay = {'api.port': 54321, 'db.port': 54322, 'db.shadow_port': 54320, 'other.port': 54321, 'jwt.expiry': 3600}
        good = {'ports': [54320, 54321, 54322], 'dockerBindings': 'FREE', 'vmListeners': 'FREE',
                'hostBind': 'FREE', 'reservation': False, 'observedAt': 1000.5}
        m.validate_creation_port_preflight(good, overlay, 1001)
        mutations = [lambda v: v.update(ports=[54320, 54321]),
                     lambda v: v.update(ports=[54321, 54320, 54322]),
                     lambda v: v.update(ports=[54320, 54321, 54321, 54322]),
                     lambda v: v.update(dockerBindings='OCCUPIED'),
                     lambda v: v.update(vmListeners='UNKNOWN'),
                     lambda v: v.update(hostBind='UNKNOWN'),
                     lambda v: v.update(reservation=True),
                     lambda v: v.update(reservation=0),
                     lambda v: v.update(observedAt=1001.1),
                     lambda v: v.update(observedAt=float('nan')),
                     lambda v: v.update(created=True)]
        for mutate in mutations:
            value = copy.deepcopy(good)
            mutate(value)
            with self.assertRaises(ValueError):
                m.validate_creation_port_preflight(value, overlay, 1001)
        for invalid in ({'api.port': True}, {'db.port': '54322'}, {'api.port': 1024}, {}):
            with self.assertRaises(ValueError):
                m.validate_creation_port_preflight(good, invalid, 1001)
        # bind/listen/VM/Docker 호출은 없다. 생성 시점 관측을 예약 보장으로 확대하지 않는다.

    def test_completed_foreign_member_and_withdrawal_refused_without_mutation(self):
        b = self.completed_boundary()
        with self.assertRaisesRegex(ValueError, 'COMPLETED_OWNED_USER'):
            b.prepare_completed_retirement(USER)
        with self.assertRaisesRegex(ValueError, 'COMPLETED_OWNED_WITHDRAWAL'):
            b.inspect_completed_retirement(b.completed_retirement['userId'], OTHER)
        self.assertEqual(b.sql_calls, [])
        self.assertEqual(b.saved, {})

    def test_completed_native_scope_rejects_foreign_duplicate_reordered_tasks_and_false_outcome(self):
        b = self.completed_boundary()
        good = self.completed_native(b)
        self.assertEqual(b.validate_completed_rows(copy.deepcopy(good)), good)
        changes = [lambda v: v['tasks'][0].update(profileId=USER),
                   lambda v: v['tasks'][0].update(withdrawalId=OTHER),
                   lambda v: v['tasks'].reverse(),
                   lambda v: v['tasks'].append(copy.deepcopy(v['tasks'][0])),
                   lambda v: v['tasks'][1].update(kind='storage_object'),
                   lambda v: v.update(state='completed'),
                   lambda v: v.update(ackSha256=H)]
        for mutate in changes:
            bad = copy.deepcopy(good)
            mutate(bad)
            with self.assertRaises(ValueError):
                b.validate_completed_rows(bad)
        self.assertEqual(b.sql_calls, [])

    def test_completed_auth_ack_is_original_auth_hash_not_storage_or_aggregate(self):
        b = self.completed_boundary()
        value = self.completed_native(b)
        for index, mark in enumerate((H, F)):
            value['tasks'][index].update(state='running', leaseToken=str(uuid.UUID(int=140 + index)),
                workerRunToken=str(uuid.UUID(int=150)), leaseExpiresAt='2026-10-14T01:00:00+00:00')
            value['tasks'][index]['dispatch'] = {'dispatchId': str(uuid.UUID(int=120 + index)), 'rowSha256': H}
            value['tasks'][index]['ack'] = {'receiptId': str(uuid.UUID(int=130 + index)), 'ackSha256': mark, 'rowSha256': H}
        value['ackSha256'] = F
        b.validate_completed_rows(value)
        value['ackSha256'] = H
        with self.assertRaisesRegex(ValueError, 'COMPLETED_AUTH_ACK_BINDING'):
            b.validate_completed_rows(value)
        value['tasks'][1]['ack'] = None
        value['ackSha256'] = None
        b.validate_completed_rows(value)

    def test_completed_product_query_is_read_only_and_uses_original_ids(self):
        b = self.completed_boundary()
        queries = []
        b.read = lambda sql: queries.append(sql) or None
        b.completed_fixture_rows(b.completed_retirement['userId'], RUN)
        query = queries[0]
        for word in ('update ', 'insert ', 'delete ', 'set lease', 'record_member_cleanup_delete_ack(', 'begin_member_cleanup_delete('):
            self.assertNotIn(word, query.lower())
        self.assertIn("a.kind='auth_user'", query)
        self.assertIn(b.completed_retirement['invocationRequestId'], query)
        self.assertIn(b.completed_retirement['recoveryRequestId'], query)
        self.assertEqual(b.sql_calls, [])

    def test_completed_cleanup_foreign_whole_bag_change_prevents_closed_receipt(self):
        b = self.completed_boundary()
        b.completed_baseline = {'rows': {'public.profiles': {H: 5}, 'private.unrelated': {F: 1}}, 'authoritySha256': H}
        current = copy.deepcopy(b.completed_baseline)
        current['rows']['private.unrelated'] = {N: 1}
        b.completed_before_owned = {}
        b.completed_owned_rows = lambda *args: {}
        b.function_rows = lambda signatures: {}
        b.ports.snapshot = lambda: current
        with self.assertRaisesRegex(ValueError, 'FOREIGN_ROW_CHANGED'):
            b.cleanup_completed_retirement(b.completed_retirement['userId'], RUN)
        self.assertFalse(getattr(b, 'completed_closed', False))
        self.assertNotIn('completed-final-retained.json', b.saved)
        self.assertEqual(b.sql_calls, [])

    def test_completed_guard_cas_foreign_change_refuses_all_writes(self):
        b = self.completed_boundary()
        b.original_controls = {'atomic': {'singleton': True, 'enabled': False}}
        b.completion_enable_changes = {'atomic': {'enabled': True}}
        b.control_overrides = {}
        b.ports.read_sql = lambda *args, **kwargs: json.dumps({'atomic': {'singleton': True, 'enabled': True, 'foreignColumn': True}})
        with self.assertRaisesRegex(ValueError, 'COMPLETED_OPENING_CAS_UNKNOWN'):
            b.close_completed_guards()
        self.assertEqual(b.sql_calls, [])
        self.assertEqual(b.saved, {})

    def test_completed_cleanup_cas_failure_does_not_claim_closed_or_rewrite_ack_and_lease(self):
        b = self.completed_boundary()
        b.original_controls = {'atomic': {'singleton': True, 'enabled': False}}
        b.completion_enable_changes = {'atomic': {'enabled': True}}
        b.control_overrides = {}
        b.ports.read_sql = lambda *args, **kwargs: json.dumps({'atomic': {'singleton': True, 'enabled': True}})
        def denied(sql):
            b.sql_calls.append(sql)
            raise ValueError('SQLSTATE_40001')
        b.ports.sql = denied
        with self.assertRaisesRegex(ValueError, 'SQLSTATE_40001'):
            b.close_completed_guards()
        self.assertEqual(len(b.sql_calls), 1)
        sql = b.sql_calls[0].lower()
        self.assertIn('to_jsonb(c)=', sql)
        for table in ('member_cleanup_tasks', 'member_cleanup_delete_acks', 'member_cleanup_dispatches', 'worker_invocations', 'global_worker_run'):
            self.assertNotIn('update private.' + table, sql)
            self.assertNotIn('delete from private.' + table, sql)
        self.assertFalse(getattr(b, 'completed_closed', False))
        self.assertNotIn('completed-final-retained.json', b.saved)


if __name__ == '__main__':
    unittest.main()
