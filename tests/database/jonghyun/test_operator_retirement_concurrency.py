"""로컬 모형 책임만 검사한다. 실제 psql/DB/Auth/Storage 호출은 없다."""
import copy
import argparse
import contextlib
import io
import importlib.util
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
PATH = REPO / 'tests/integration/jonghyun/operator-retirement-concurrency.py'
spec = importlib.util.spec_from_file_location('operator_native', PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class NativeContracts(unittest.TestCase):
    def test_default_never_invokes_target(self):
        result = subprocess.run([sys.executable, '-B', str(PATH)], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), {'status': 'NOT_RUN', 'ready': False,
                                                    'scope': 'NATIVE_SQL_TWO_SESSION_ONLY'})

    def test_missing_run_packet_is_fail_closed(self):
        result = subprocess.run([sys.executable, '-B', str(PATH), '--run'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)['ready'])
        self.assertEqual(json.loads(result.stdout)['status'], 'BLOCKED')

    def test_relative_root_is_not_resolved_into_an_authorized_live_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            reviewed = root / 'reviewed.json'
            m.private_json(reviewed, {'preparedRoot': str(root)})
            args = argparse.Namespace(run=True, prepared_root=Path(os.path.relpath(root)), reviewed=reviewed)
            with patch.object(m.argparse.ArgumentParser, 'parse_args', return_value=args), \
                 patch.object(m, 'run', return_value={'status': 'PASS_NATIVE_SQL_ONLY'}) as actual, \
                 contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    m.main()
            actual.assert_not_called()

    def test_fixed_seven_function_probes_do_not_insert_manual_locks(self):
        self.assertEqual(len(m.PROBES), 7)
        self.assertEqual(sum(p[2] == '40001' for p in m.PROBES), 3)
        self.assertEqual(sum(p[2] == 'blocked' for p in m.PROBES), 4)
        for holder, waiter, _ in m.PROBES:
            for kind in (holder, waiter):
                sql = m.role_call(kind).lower()
                self.assertNotIn('for update', sql)
                self.assertNotIn('pg_sleep', sql)
                self.assertNotIn('reset role', sql)  # 오류 SQLSTATE를 다음 명령으로 덮지 않는다.
        with self.assertRaisesRegex(ValueError, 'FIXED_METHOD'):
            m.role_call('delete from auth.users')

    def test_error_requires_whole_aborted_transaction(self):
        m.failed_transaction('40001', '25P02')
        for states in [('40001', '00000'), ('55P03', '25P02'), ('00000', '25P02')]:
            with self.assertRaisesRegex(ValueError, 'WHOLE_TX_ROLLBACK_UNPROVEN'):
                m.failed_transaction(*states)

    def test_real_blocker_requires_exact_pid_lock_state(self):
        row = {'pid': 22, 'state': 'active', 'wait_event_type': 'Lock', 'blockers': [11]}
        self.assertTrue(m.blocked_observation(row, 11, 22))
        for key, value in [('pid', 23), ('state', 'idle in transaction'),
                           ('wait_event_type', 'Client'), ('blockers', [33])]:
            wrong = dict(row, **{key: value})
            self.assertFalse(m.blocked_observation(wrong, 11, 22))

    def test_barrier_refreshes_transaction_activity_snapshot(self):
        raw = PATH.read_text()
        loop = raw[raw.index('while True:\n                    a.ok'):raw.index("journal('blocked'")]
        self.assertLess(loop.index('pg_stat_clear_snapshot'), loop.index('pg_stat_activity'))
        self.assertNotIn('sleep', loop)

    def test_retirement_success_cannot_be_inferred_from_sqlstate(self):
        value = {'withdrawalId': 'fa140000-0000-4000-8000-000000000017',
                 'status': 'processing', 'memberAccessRevoked': True}
        m.call_result('retire', [json.dumps(value)])
        for key, changed in [('status', 'completed'), ('memberAccessRevoked', False),
                             ('withdrawalId', 'foreign')]:
            with self.assertRaisesRegex(ValueError, 'RETIRE_RESULT'):
                m.call_result('retire', [json.dumps(dict(value, **{key: changed}))])

    def test_candidate_prefix_is_exact_and_does_not_run_auth_delete(self):
        raw = (REPO / m.CANDIDATE).read_text()
        seed, helpers = m.fixture_parts(raw)
        self.assertTrue(seed.startswith(raw.split(m.MARKER)[0] + 'update private.member_cleanup_guard'))
        self.assertTrue(seed.endswith('commit;\n'))
        self.assertNotIn('delete from auth.users', seed.lower())
        self.assertNotIn('retire_my_account', seed.lower())
        self.assertIn('create function pg_temp.operator_actor', helpers)
        self.assertNotIn('create temp table', helpers)
        with self.assertRaisesRegex(ValueError, 'FIXTURE_PREFIX'):
            m.fixture_parts(raw.replace(m.MARKER, '-- changed'))

    def test_control_restore_compares_full_native_rows_before_any_mutation(self):
        original = {'guard': {'singleton': True, 'external_deletion_approved': False},
                    'functions': [{'signature': f, 'row': {'oid': i, 'proacl': ['original']},
                                   'serviceExecute': False} for i, f in enumerate(m.FUNCTIONS)]}
        opened = copy.deepcopy(original)
        opened['guard']['external_deletion_approved'] = True
        sql = m.restore_sql(original, opened)
        self.assertLess(sql.index('is distinct from'), sql.index('update private.member_cleanup_guard'))
        self.assertEqual(sql.count('revoke execute on function'), 5)
        self.assertEqual(sql.count('is distinct from'), 2)
        self.assertNotIn('delete from', sql.lower())
        self.assertIn('for update nowait', sql)
        foreign = copy.deepcopy(original)
        foreign['functions'][0]['signature'] = 'public.foreign(uuid)'
        with self.assertRaisesRegex(ValueError, 'ACL_SIGNATURE'):
            m.restore_sql(foreign, opened)

    def test_snapshot_includes_other_staff_receipts_clock_roles_and_auth(self):
        # 전체 auth/public/private/storage 행 bag이므로 3receipt뿐 아니라 다른 직원/clock 변화도 포함.
        self.assertIn("('auth','public','private','storage')", m.SNAPSHOT_SQL)
        self.assertIn('to_jsonb(x)::text', m.SNAPSHOT_SQL)
        self.assertIn('pg_roles', m.SNAPSHOT_SQL)
        self.assertIn('pg_auth_members', m.SNAPSHOT_SQL)
        self.assertNotIn('where profile_id=', m.SNAPSHOT_SQL)
        self.assertNotIn('pg_sleep', m.SNAPSHOT_SQL)

    def test_other_staff_receipt_or_clock_change_cannot_pass_row_comparison(self):
        baseline = {'private.assigned_report_final_closures': 'a' * 64,
                    'private.member_reports': 'b' * 64, 'private.report_operator_assignments': 'c' * 64}
        m.rows_equal(dict(baseline), baseline)
        for name in baseline:
            with self.assertRaisesRegex(ValueError, 'FIXTURE_ROWS_CHANGED'):
                m.rows_equal(dict(baseline, **{name: 'd' * 64}), baseline)

    def source_fixture(self, root):
        files = {f'backend/supabase/migrations/{i:014}_migration.sql': b'-- product\n' for i in range(121)}
        files.update({p: b'-- approved source\n' for p in (m.CANDIDATE, *m.SUPPORT)})
        files[m.DRIVER] = b'# reviewed uncommitted driver\n'
        files[m.TEST] = b'# reviewed uncommitted tests\n'
        for path, raw in files.items():
            p = root / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(raw)
        review = {'version': 1, 'scenario': 'OPERATOR_RETIREMENT_TWO_SESSION_NATIVE',
                  'preparedRoot': str(root), 'head': 'a' * 40,
                  'runId': '00000000-0000-4000-8000-000000000001',
                  'driverSha256': m.digest(files[m.DRIVER]), 'testSha256': m.digest(files[m.TEST]),
                  'sourceFiles': {p: m.digest(v) for p, v in files.items() if p not in (m.DRIVER, m.TEST)}}
        def git(command, **kwargs):
            if command[-2:] == ['rev-parse', 'HEAD']:
                return review['head'] + '\n'
            return files[command[-1].split(':', 1)[1]]
        return files, review, git

    def test_source_gate_allows_only_reviewed_uncommitted_driver_product_is_head_exact(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            files, review, git = self.source_fixture(root)
            with patch.object(m.subprocess, 'check_output', side_effect=git):
                self.assertEqual(m.source_gate(review, root), files[m.CANDIDATE].decode())
                (root / m.SUPPORT[0]).write_bytes(b'changed uncommitted support')
                with self.assertRaisesRegex(ValueError, 'COMMITTED_SOURCE_CHANGED'):
                    m.source_gate(review, root)

    def test_driver_bytes_and_migration_set_changes_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            files, review, git = self.source_fixture(root)
            with patch.object(m.subprocess, 'check_output', side_effect=git):
                (root / m.DRIVER).write_bytes(b'changed driver')
                with self.assertRaisesRegex(ValueError, 'REVIEWED_WORKINGTREE_CHANGED'):
                    m.source_gate(review, root)
                (root / m.DRIVER).write_bytes(files[m.DRIVER])
                (root / next(p for p in files if '/migrations/' in p)).unlink()
                with self.assertRaisesRegex(ValueError, 'SOURCE_SET'):
                    m.source_gate(review, root)

    def test_extra_env_path_and_symlink_are_refused_before_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            files, review, git = self.source_fixture(root)
            with patch.object(m.subprocess, 'check_output', side_effect=git):
                review['sourceFiles']['.env'] = 'a' * 64
                with self.assertRaisesRegex(ValueError, 'SOURCE_SET'):
                    m.source_gate(review, root)
                del review['sourceFiles']['.env']
                path = root / m.SUPPORT[0]
                path.unlink()
                path.symlink_to(root / m.SUPPORT[1])
                with self.assertRaisesRegex(ValueError, 'SOURCE_FILE'):
                    m.source_gate(review, root)

    def test_private_receipt_cannot_overwrite_prior_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'receipt.json'
            m.private_json(path, {'scope': 'LOCAL_MODEL_ONLY'})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                m.private_json(path, {'status': 'fake pass'})


class LocalPipeModel(unittest.TestCase):
    # 실제 로컬 자식/EOF만 검사한다. SQL parser/server가 없고 native 실증으로 집계하지 않는다.
    SCRIPT = """import sys,time
for line in sys.stdin:
 if 'select pg_backend_pid();' in line: print('3317',flush=True)
 if 'model_wait;' in line: time.sleep(.12)
 if line.startswith('\\\\echo '): print(line.split()[1]+' 00000',flush=True)
"""

    def test_real_child_frame_and_stdin_eof_close(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipts = []
            session = m.Session([sys.executable, '-u', '-c', self.SCRIPT], Path(tmp) / 'stderr',
                                lambda stage, value: receipts.append((stage, value)), 'local_model')
            self.assertEqual(session.pid, 3317)
            self.assertEqual(session.sql('select 1;'), ([], '00000'))
            session.close()
            self.assertEqual(session.child.returncode, 0)
            self.assertTrue(session.child.stdin.closed)
            self.assertEqual(receipts[-1][0], 'child_closed')

    def test_pipe_timeout_does_not_retransmit_or_claim_database_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipts = []
            session = m.Session([sys.executable, '-u', '-c', self.SCRIPT], Path(tmp) / 'stderr',
                                lambda stage, value: receipts.append((stage, value)), 'local_model')
            session.send('model_wait;')
            with self.assertRaisesRegex(ValueError, 'SESSION_TIMEOUT'):
                session.finish(.01)
            with self.assertRaisesRegex(ValueError, 'SESSION_STATE'):
                session.send('model_wait;')
            session.close()
            self.assertEqual(len([x for x in receipts if x[0] == 'child']), 1)
            self.assertFalse(any('PASS' in json.dumps(v) for _, v in receipts))

    def test_pid_journal_failure_closes_the_just_issued_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            issued = []
            real_popen = m.subprocess.Popen
            def spawn(*args, **kwargs):
                child = real_popen(*args, **kwargs)
                issued.append(child)
                return child
            def failed_journal(stage, value):
                raise OSError('local mock journal failure')
            with patch.object(m.subprocess, 'Popen', side_effect=spawn):
                with self.assertRaises(OSError):
                    m.Session([sys.executable, '-u', '-c', self.SCRIPT], Path(tmp) / 'stderr',
                              failed_journal, 'local_model')
            self.assertEqual(len(issued), 1)
            self.assertIsNotNone(issued[0].poll())
            self.assertTrue(issued[0].stdin.closed)

    def test_signal_during_issuance_closes_only_owned_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            issued = []
            owned = []
            real_popen = m.subprocess.Popen
            original = signal.getsignal(signal.SIGINT)
            def spawn(*args, **kwargs):
                child = real_popen(*args, **kwargs)
                issued.append(child)
                os.kill(os.getpid(), signal.SIGINT)
                return child
            with patch.object(m.subprocess, 'Popen', side_effect=spawn):
                with self.assertRaises(m.NativeInterrupted):
                    m.Session([sys.executable, '-u', '-c', self.SCRIPT], Path(tmp) / 'stderr',
                              lambda *args: None, 'local_model', owned)
            self.assertIs(signal.getsignal(signal.SIGINT), original)
            self.assertEqual(len(issued), 1)
            self.assertEqual(len(owned), 1)
            self.assertIs(owned[0].child, issued[0])
            self.assertIsNotNone(issued[0].poll())
            self.assertTrue(issued[0].stdin.closed)

    def test_one_cleanup_error_does_not_skip_another_child(self):
        order = []
        class Child:
            def __init__(self, name, fail): self.name, self.fail = name, fail
            def close(self):
                order.append(self.name)
                if self.fail: raise OSError('local mock close journal failure')
        self.assertFalse(m.close_sessions([Child('holder', True), Child('waiter', False)]))
        self.assertEqual(order, ['holder', 'waiter'])


class RunBoundaryModel(unittest.TestCase):
    """실제 run 제어흐름의 포트만 모형으로 바꾼다. native/API 호출 증거가 아니다."""
    @contextlib.contextmanager
    def ports(self, root, events, fail_after=None, interrupt=None):
        target = {'host': 'unix://local-model-only', 'project': 'local-model-only',
                  'id': 'a' * 64, 'image': 'sha256:' + 'b' * 64, 'container': 'local-model-only',
                  'versions': [], 'preservedResourcePins': {'localModel': True}}
        inspection = [{'Id': target['id'], 'Name': '/' + target['container'], 'Image': target['image'],
                       'State': {'Running': True, 'OOMKilled': False},
                       'Config': {'Labels': {'com.supabase.cli.project': target['project']}}}]
        state = {'control': 0, 'restored': False}
        result = json.dumps({'withdrawalId': 'fa140000-0000-4000-8000-000000000017',
                             'status': 'processing', 'memberAccessRevoked': True})
        def verify(*args):
            previous = events[-1] if events else None
            events.append('identity')
            if fail_after is not None and previous == fail_after:
                raise ValueError('OPERATOR_NATIVE_TARGET_CHANGED')
        guard = SimpleNamespace(isolated_prepared_target=lambda path: target,
                                verify_preserved_resources=verify)
        class ModelSession:
            def __init__(self, command, log, journal, name, owned):
                self.role = 'holder' if 'holder' in name else 'waiter'
                self.pid = 11 if self.role == 'holder' else 22
                self.finished = 0
                owned.append(self)
            def ok(self, sql):
                if 'create function pg_temp.operator_uid' in sql and '\ncommit;' in sql:
                    tag = 'seed_commit'
                elif sql == 'MODEL_RESTORE_COMMIT':
                    tag = 'restore_commit'
                    state['restored'] = True
                elif sql.startswith('begin;'):
                    tag = self.role + '_begin'
                elif sql == 'rollback;':
                    tag = self.role + '_rollback'
                else:
                    tag = self.role + '_read_or_setup'
                events.append(tag)
                return [result] if 'retire_my_account' in sql else []
            def send(self, sql):
                events.append('waiter_send')
                if interrupt:
                    os.kill(os.getpid(), interrupt)
            def finish(self):
                events.append('waiter_finish')
                self.finished += 1
                return ([], '40001') if self.finished == 1 else ([result], '00000')
            def sql(self, sql):
                events.append('waiter_transaction_read')
                return [], '25P02'
            def close(self):
                events.append(self.role + '_closed')
        def native_scalar(session, sql):
            if sql == m.control_sql():
                state['control'] += 1
                return {'guard': {'external_deletion_approved': state['control'] == 2}, 'functions': []}
            if sql == m.SNAPSHOT_SQL:
                return {'private.member_cleanup_guard': 'original' if state['restored'] else 'opened',
                        'private.receipts_and_other_staff': 'unchanged'}
            return {'pid': 22, 'state': 'active', 'wait_event_type': 'Lock', 'blockers': [11]}
        review = {'preparedRoot': str(root), 'runId': '00000000-0000-4000-8000-000000000001'}
        with contextlib.ExitStack() as stack:
            replacements = [(m, 'source_gate', lambda review: (REPO / m.CANDIDATE).read_text()),
                            (m, 'preflight', lambda *args: None), (m, 'Session', ModelSession),
                            (m, 'scalar', native_scalar), (m, 'restore_sql', lambda *args: 'MODEL_RESTORE_COMMIT'),
                            (m, 'PROBES', [('approval_false', 'retire', '40001'), ('approval_true', 'retire', 'blocked')]),
                            (m.importlib.util, 'spec_from_file_location', lambda *args: SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))),
                            (m.importlib.util, 'module_from_spec', lambda spec: guard),
                            (m.subprocess, 'check_output', lambda *args, **kwargs: json.dumps(inspection))]
            for owner, name, value in replacements:
                stack.enter_context(patch.object(owner, name, value))
            yield review

    def test_identity_guards_bracket_both_transaction_branches_and_commits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, events = Path(tmp).resolve(), []
            with self.ports(root, events) as review:
                value = m.run(review, root)
            self.assertEqual(value['status'], 'PASS_NATIVE_SQL_ONLY')  # 모형 제어흐름의 기대값만 검사.
            for index, event in enumerate(events):
                if event in ('seed_commit', 'holder_begin', 'holder_rollback', 'waiter_rollback', 'restore_commit'):
                    self.assertEqual(events[index - 1:index + 2:2], ['identity', 'identity'], event)
                elif event == 'waiter_send':
                    self.assertEqual(events[index - 1], 'identity')
                elif event == 'waiter_finish':
                    self.assertEqual(events[index + 1], 'identity')

    def test_changed_target_after_seed_or_waiter_finish_stops_all_further_sql(self):
        for failed_at in ('seed_commit', 'waiter_finish'):
            with self.subTest(failed_at=failed_at), tempfile.TemporaryDirectory() as tmp:
                root, events = Path(tmp).resolve(), []
                with self.ports(root, events, fail_after=failed_at) as review:
                    value = m.run(review, root)
                self.assertEqual(value['status'], 'BLOCKED')
                self.assertEqual(value['failure'], 'OPERATOR_NATIVE_TARGET_CHANGED')
                index = events.index(failed_at)
                self.assertEqual(events[index + 1], 'identity')
                self.assertTrue(all(x.endswith('_closed') for x in events[index + 2:]))
                final = json.loads(next((root / ('operator-native-' + review['runId'])).glob('*-final.json')).read_text())
                self.assertEqual(final['status'], 'BLOCKED')
                self.assertTrue(final['fixtureRetained'])

    def test_real_sigterm_sigint_enter_finally_close_all_children_and_restore_handlers(self):
        for interrupted in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=interrupted), tempfile.TemporaryDirectory() as tmp:
                root, events = Path(tmp).resolve(), []
                originals = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
                with self.ports(root, events, interrupt=interrupted) as review:
                    reviewed = root / 'reviewed.json'
                    m.private_json(reviewed, review)
                    args = argparse.Namespace(run=True, prepared_root=root, reviewed=reviewed)
                    with patch.object(m.argparse.ArgumentParser, 'parse_args', return_value=args), \
                         contextlib.redirect_stdout(io.StringIO()):
                        with self.assertRaises(SystemExit):
                            m.main()
                self.assertEqual(events[-2:], ['holder_closed', 'waiter_closed'])
                for sig, original in originals.items():
                    self.assertIs(signal.getsignal(sig), original)
                final = json.loads(next((root / ('operator-native-' + review['runId'])).glob('*-final.json')).read_text())
                self.assertEqual(final['status'], 'BLOCKED')
                self.assertEqual(final['failure'], 'OPERATOR_NATIVE_INTERRUPTED')
                self.assertFalse(final['emptyBaselineRestored'])


if __name__ == '__main__':
    unittest.main()
