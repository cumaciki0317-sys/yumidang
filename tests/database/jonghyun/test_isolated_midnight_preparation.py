"""오프라인 경계·증거 거절 검사. 자연 자정 실행 증거로 계산하지 않는다."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timezone

REPO = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('midnight_prepare', REPO / 'tools/local/prepare_isolated_midnight.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MidnightPreparationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name).resolve()
        self.root.chmod(0o700)
        self.observer = 'ai-observer-123.json'
        self.log = 'ai-public-123.log'
        result = {'status': 'PASS', 'scope': 'PRODUCT_HTTP_FACTORY_REAL_SQL_RPC_SYNTHETIC_AUTH_BRIDGE_AND_MODEL',
                  'naturalMidnight': 'NOT_RUN', 'actualAuthPostgrestNaver': 'NOT_RUN', 'externalProvider': 'NOT_RUN',
                  'memberFixtureRowsRestored': True, 'protectedBudgetMetadata': 'PRESERVED_WITH_UNKNOWN',
                  'checks': [{'scenario': 'AI22', 'observations': 28, 'dailyCounts': [3, 20, 3], 'unknownPreserved': True},
                             {'scenario': 'AI23', 'observations': 6, 'globalCap': 12800000, 'eachAccountCap': 3200000, 'unknownPreserved': True}]}
        self.put(self.log, result)
        self.put(self.observer, {'status': 'PASS', 'mode': 'ai', 'childExitCode': 0, 'observerFailure': None,
                                'publicLogSha256': hashlib.sha256((self.root / self.log).read_bytes()).hexdigest(),
                                'sourceSha256': 'a' * 64})
        self.reindex()

    def tearDown(self):
        self.directory.cleanup()

    def put(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def reindex(self, duplicate=False):
        entries = [{'file': n, 'bytes': (self.root / n).stat().st_size,
                    'sha256': hashlib.sha256((self.root / n).read_bytes()).hexdigest()}
                   for n in (self.observer, self.log)]
        if duplicate:
            entries.append(entries[0])
        self.put('preservation-manifest.json', {'files': entries})

    def test_valid_public_evidence_never_opens_auth_fixture(self):
        # Deliberately unreadable credential fixture; it is outside the allowlist.
        (self.root / 'ai-factory-fixture.json').mkdir()
        evidence = m.inspect_evidence(self.root)
        self.assertEqual(len(evidence['publicEvidenceSha256']), 2)
        self.assertEqual(evidence['priorLiveBudgetDay'], 'NOT_OBSERVED')

    def test_tampered_public_log_is_rejected(self):
        with (self.root / self.log).open('a') as stream:
            stream.write(' ')
        with self.assertRaisesRegex(ValueError, 'EVIDENCE_HASH_CHANGED'):
            m.inspect_evidence(self.root)

    def test_duplicate_manifest_entries_are_rejected(self):
        self.reindex(True)
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_EVIDENCE'):
            m.inspect_evidence(self.root)

    def test_failed_observer_cannot_prepare(self):
        value = json.loads((self.root / self.observer).read_text())
        value['childExitCode'] = 1
        self.put(self.observer, value)
        self.reindex()
        with self.assertRaisesRegex(ValueError, 'AI_OBSERVER_NOT_PASS'):
            m.inspect_evidence(self.root)

    def test_changed_daily_counts_do_not_pass(self):
        result = json.loads((self.root / self.log).read_text())
        result['checks'][0]['dailyCounts'] = [3, 19, 3]
        self.put(self.log, result)
        observer = json.loads((self.root / self.observer).read_text())
        observer['publicLogSha256'] = hashlib.sha256((self.root / self.log).read_bytes()).hexdigest()
        self.put(self.observer, observer)
        self.reindex()
        with self.assertRaisesRegex(ValueError, 'AI22_AI23_CONTRACT_CHANGED'):
            m.inspect_evidence(self.root)

    def test_private_mode_and_hardlink_are_required(self):
        path = self.root / self.log
        path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'PRIVATE_REGULAR_FILE_REQUIRED'):
            m.inspect_evidence(self.root)
        path.chmod(0o600)
        os.link(path, self.root / 'alias')
        with self.assertRaisesRegex(ValueError, 'PRIVATE_REGULAR_FILE_REQUIRED'):
            m.inspect_evidence(self.root)

    def test_symlink_public_evidence_is_rejected(self):
        path = self.root / self.log
        path.rename(self.root / 'real-log')
        path.symlink_to(self.root / 'real-log')
        with self.assertRaises(OSError):
            m.inspect_evidence(self.root)

    def test_traversal_private_name_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'EXACT_FILE_REQUIRED'):
            m.private_bytes(self.root, '../credential')

    def test_plan_never_claims_live_readiness_or_resets_full_cap(self):
        evidence = m.inspect_evidence(self.root)
        pins = {'tests/integration/jonghyun/isolated_ai_contracts.py': 'a' * 64}
        plan = m.build_plan({'project': 'synthetic', 'id': 'owned', 'image': 'pinned'}, evidence, pins,
                            datetime(2026, 10, 11, 14, 40, tzinfo=timezone.utc))
        self.assertFalse(plan['executionAllowed'])
        self.assertEqual(plan['actualMidnight'], 'NOT_RUN')
        baseline = plan['baselineContract']
        self.assertFalse(baseline['dbObserved'])
        self.assertTrue(baseline['newLedgerDoesNotResetSharedDayBudget'])
        self.assertEqual(baseline['protectedTables'], list(m.PROTECTED))
        self.assertEqual(baseline['liveNaturalDayHeadroom'], 'NOT_OBSERVED')
        self.assertTrue(plan['cleanupContract']['noBulkDeleteNoTimeShiftNoRefundNoLimitChange'])
        ids = plan['ownedIntent']['memberIds']
        self.assertEqual(len(set(ids)), 3)
        self.assertEqual(plan['ownedIntent']['creationReceipts'], 'NOT_CREATED')

    def test_changed_evidence_runner_pin_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'AI_EVIDENCE_SOURCE_CHANGED'):
            m.build_plan({}, m.inspect_evidence(self.root), {}, datetime.now(timezone.utc))

    def test_kst_next_boundary_and_strict_resume_cutoff(self):
        value = m.natural_windows(datetime(2026, 10, 11, 14, 0, tzinfo=timezone.utc))
        self.assertEqual(value['nextKstMidnight'], '2026-10-12T00:00:00+09:00')
        self.assertEqual(value['initialPrepareThrough'], '2026-10-11T23:40:00+09:00')
        self.assertEqual(value['resumeBeforeExclusive'], '2026-10-11T23:59:55+09:00')
        # At natural midnight the next target moves to the following day.
        next_value = m.natural_windows(datetime(2026, 10, 11, 15, 0, tzinfo=timezone.utc))
        self.assertEqual(next_value['nextKstMidnight'], '2026-10-13T00:00:00+09:00')

    def test_naive_clock_cannot_silently_use_local_timezone(self):
        with self.assertRaisesRegex(ValueError, 'OFFSET_CLOCK_REQUIRED'):
            m.natural_windows(datetime(2026, 10, 11))


if __name__ == '__main__':
    unittest.main()
