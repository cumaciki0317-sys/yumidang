"""동시 철회 fixture의 실행 계획/범위 회귀. SQL/Docker/Auth 실행이나 실제 PASS를 만들지 않는다."""
from pathlib import Path
import re
import unittest

SQL = Path(__file__).with_name('ai_consent_concurrent_fixture.sql').read_text()


def phase(name):
    # 고정 psql phase의 본문. 중첩 phase를 허용하지 않는다.
    match = re.search(r'\\if :do_' + re.escape(name) + r'\n(.*?)\\endif', SQL, re.S)
    if not match:
        raise ValueError('UNKNOWN_PHASE')
    return match.group(1)


def classify_lock_proof(*, actor_pids, overlapping_intervals, observed_waiter,
                        observed_blockers, exits, sqlstates, dispatched_once,
                        full_baseline_restored, children_closed):
    """root의 원시 증거 수집 뒤 쓰는 순수 판정 조건. SQL 결과만으로 동시성 PASS 불가."""
    pids = list(actor_pids)
    exact = (len(pids) == 2 and all(type(p) is int and p > 0 for p in pids)
             and len(set(pids)) == 2 and observed_waiter in pids
             and type(observed_waiter) is int
             and list(observed_blockers) == [next((p for p in pids if p != observed_waiter), None)])
    passed = (exact and overlapping_intervals is True and list(exits) == [0, 0]
              and list(sqlstates) == ['00000', '00000'] and dispatched_once is True
              and full_baseline_restored is True and children_closed is True)
    return {'status': 'PASS_SYNTHETIC_SQL_CONCURRENCY_ONLY' if passed else 'NOT_PROVEN',
            'actualAuth': 'NOT_RUN', 'realNaver': 'NOT_RUN', 'providerCalls': 0}


class ConcurrencyPlanTests(unittest.TestCase):
    def test_missing_or_invalid_phase_refused_before_any_mutation(self):
        self.assertLess(SQL.index('PHASE_REQUIRED'), SQL.index('begin;'))
        self.assertLess(SQL.index('INVALID_PHASE'), SQL.index('begin;'))
        with self.assertRaises(ValueError): phase('unreviewed')

    def test_two_actors_have_independent_single_transaction_and_distinct_identity(self):
        texts = [phase('a'), phase('b')]
        for actor, text in zip(('a', 'b'), texts):
            self.assertEqual(text.count('begin;'), 1)
            self.assertEqual(text.count('commit;'), 1)
            self.assertEqual(text.count("public.withdraw_my_ai_processing('review_summary')"), 1)
            self.assertIn('set local role authenticated;', text)
            self.assertIn("deadlock_timeout='200ms'", text)
            self.assertIn("lock_timeout='8s'", text)
            self.assertIn("statement_timeout='10s'", text)
            self.assertIn('pg_backend_pid()', text)
            self.assertIn('minkyu_ai_withdraw_a1cc_actor_' + actor, text)
        self.assertIn('000000000001', texts[0])
        self.assertNotIn('000000000002', texts[0])
        self.assertIn('000000000002', texts[1])
        self.assertNotIn('000000000001', texts[1])

    def test_setup_commits_only_new_fixture_and_rejects_existing_ids(self):
        setup = phase('setup')
        self.assertEqual(setup.count('commit;'), 1)
        self.assertIn('preexisting auth id', setup)
        self.assertIn('preexisting episode', setup)
        self.assertIn('preexisting summary state', setup)
        self.assertIn('fixture trigger already exists', setup)
        self.assertNotRegex(setup, r'(?i)\bcreate\s+or\s+replace\b')
        self.assertNotRegex(setup, r'(?i)\b(update|delete\s+from)\s+private\.ai_processing_guard\b')
        self.assertNotIn('insert into auth.sessions', setup)
        self.assertNotIn('resolve_naver_account', setup)

    def test_delay_only_changes_fixture_summary_rows_not_policy_or_clock(self):
        setup = phase('setup')
        self.assertIn('before update on private.review_summary_state', setup)
        self.assertIn('perform pg_sleep(2)', setup)
        self.assertIn("if new.profile_id in('a1cc0000", setup)
        self.assertNotRegex(SQL, r'(?i)\b(setval|nextval|alter\s+system|disable\s+trigger|truncate)\b')

    def test_observation_window_and_fixed_timeouts_remain_ordered(self):
        delay = int(re.search(r'perform pg_sleep\((\d+)\)', phase('setup')).group(1))
        first_actor_seconds = delay * 2
        serialized_pair_seconds = first_actor_seconds * 2
        self.assertGreater(first_actor_seconds, 2)  # reviewed guard/observer latency budget
        self.assertEqual(serialized_pair_seconds, 8)
        for name in ('a', 'b'):
            actor = phase(name)
            lock = int(re.search(r"lock_timeout='(\d+)s'", actor).group(1))
            statement = int(re.search(r"statement_timeout='(\d+)s'", actor).group(1))
            self.assertLess(first_actor_seconds, lock)
            self.assertLess(serialized_pair_seconds, statement)
            self.assertLess(lock, statement)
            self.assertLess(statement, 20)  # fixed helper overall actor deadline

    def test_cleanup_is_exact_uuid_predicates_and_only_fixture_ddl(self):
        cleanup = phase('cleanup')
        statements = re.findall(r'delete from\s+([^;]+);', cleanup, re.I)
        self.assertEqual(len(statements), 11)
        for statement in statements:
            self.assertIn(' where ', statement)
            ids = re.findall(r"'(a1cc[0-9a-f-]{32})'", statement)
            self.assertEqual(len(ids), 2)
            self.assertTrue(ids[0].endswith('000000000001'))
            self.assertTrue(ids[1].endswith('000000000002'))
        self.assertNotRegex(cleanup, r'(?i)\b(drop\s+table|cascade|truncate)\b')
        self.assertEqual(cleanup.count('drop trigger fixture_ai_withdraw_pause'), 1)
        self.assertEqual(cleanup.count('drop function private.fixture_ai_withdraw_pause()'), 1)
        self.assertLess(cleanup.index('drop trigger'), cleanup.index('delete from'))

    def test_verify_keeps_exploration_and_disclaims_auth_or_concurrency_proof(self):
        verify = phase('verify')
        self.assertIn('and exploration_allowed and not summary_allowed', verify)
        self.assertIn('not summary_view_allowed and not summary_generate_allowed and not summary_source_allowed', verify)
        self.assertIn('rollback;', verify)
        self.assertIn('REQUIRES_INDEPENDENT_CONCURRENT_LOCK_PROOF', verify)
        self.assertIn('실제 Auth/네이버/회원/모델 검증 아님', SQL)

    def proof(self, **changes):
        values = dict(actor_pids=[101, 202], overlapping_intervals=True,
                      observed_waiter=202, observed_blockers=[101], exits=[0, 0],
                      sqlstates=['00000', '00000'], dispatched_once=True,
                      full_baseline_restored=True, children_closed=True)
        values.update(changes)
        return classify_lock_proof(**values)

    def test_exact_lock_overlap_success_stays_synthetic_sql_only(self):
        result = self.proof()
        self.assertEqual(result['status'], 'PASS_SYNTHETIC_SQL_CONCURRENCY_ONLY')
        self.assertEqual(result['actualAuth'], 'NOT_RUN')

    def test_sequential_success_is_not_concurrency_proof(self):
        self.assertEqual(self.proof(overlapping_intervals=False)['status'], 'NOT_PROVEN')
        self.assertEqual(self.proof(observed_blockers=[])['status'], 'NOT_PROVEN')

    def test_foreign_or_duplicate_backend_and_unknown_blocker_rejected(self):
        for changes in ({'actor_pids': [101, 101]}, {'observed_waiter': 303},
                        {'observed_blockers': [303]}, {'observed_blockers': [101, 303]}):
            with self.subTest(changes=changes):
                self.assertEqual(self.proof(**changes)['status'], 'NOT_PROVEN')

    def test_deadlock_lock_timeout_statement_timeout_and_unknown_never_pass(self):
        for code in ('40P01', '55P03', '57014', 'UNKNOWN'):
            self.assertEqual(self.proof(sqlstates=['00000', code])['status'], 'NOT_PROVEN')
        self.assertEqual(self.proof(exits=[0, 1])['status'], 'NOT_PROVEN')

    def test_replay_or_unclosed_child_or_failed_cleanup_never_pass(self):
        for key in ('dispatched_once', 'full_baseline_restored', 'children_closed'):
            self.assertEqual(self.proof(**{key: False})['status'], 'NOT_PROVEN')


if __name__ == '__main__': unittest.main()
