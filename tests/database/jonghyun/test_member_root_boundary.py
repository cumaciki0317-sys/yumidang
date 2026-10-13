"""Root member 전용 경계 책임 시험. 실제 SQL/Auth/VM/HTTP는 호출하지 않는다."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import stat
import shutil
import tempfile
import unittest
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
        b.maintenance = None
        b.maintenance_completion = None
        b.maintenance_completion_receipt_sha = None
        b.maintenance_unclosed_observations = 0
        b.ai_request = None
        b.retirement = None
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
                self.assertEqual(len(value['methods']), 13)
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


if __name__ == '__main__':
    unittest.main()
