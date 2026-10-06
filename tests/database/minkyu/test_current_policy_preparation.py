"""합성 Git·모형 SQL로 최신 82개 준비 범위와 기존 strict guard 보존을 검사한다."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/local"))
sys.path.insert(0, str(Path(__file__).parent))
import prepare_current_policy as current
import prepare_edge as edge
import test_gateway_preparation as gateway_fixtures


class CurrentPolicyPreparationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = gateway_fixtures.GatewayPreparationTests("test_default_strict_mode_still_rejects_seven_functions")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.repo, self.output = self.fixture.repo, self.fixture.output
        self.new_queue_paths = [Path(name) for name in sorted(current.NEW_PENDING_MIGRATIONS)]
        self.policy_paths = [Path(name) for name in current.CURRENT_POLICY_REVIEWED if name not in current.NEW_PENDING_MIGRATIONS]
        self.pre80_policy_paths = [path for path in self.policy_paths if path not in (Path(current.REPORT_RETENTION_DISPATCH_MIGRATION), Path(current.CANCELLATION_DUE_GUARD_MIGRATION))]
        self.pre78_policy_paths = [path for path in self.pre80_policy_paths if path not in (Path(current.REPORT_RETENTION_PURGE_MIGRATION), Path(current.WORKER_SUPPORTED_CLAIM_MIGRATION))]
        self.legacy_policy_paths = [path for path in self.pre78_policy_paths if path not in (Path(current.ASSIGNED_REPORT_REVIEW_START_MIGRATION), Path(current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION), Path(current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION), Path(current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION), Path(current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION), Path(current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION), Path(current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION))]
        self.previous_policy_paths = [path for path in self.legacy_policy_paths if path not in (Path(current.MEMBER_SANCTION_HISTORY_MIGRATION), Path(current.PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION), Path(current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION), Path(current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION))]
        for index, path in enumerate([*self.policy_paths, *self.new_queue_paths], 1000):
            (self.repo / path).write_text(f"begin; select {index}; commit;\n")
        policy_hashes = {str(path): hashlib.sha256((self.repo / path).read_bytes()).hexdigest()
                         for path in [*self.policy_paths, *self.new_queue_paths]}
        patched = patch.object(current, "CURRENT_POLICY_REVIEWED", policy_hashes)
        patched.start()
        self.addCleanup(patched.stop)

    def test_new_queue_tail_requires_exact_reviewed_bytes(self):
        report = self.prepare()
        self.assertEqual(report["migration_count"], 86)
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual({entry["path"] for entry in manifest["pending"] if entry["path"] in current.NEW_PENDING_MIGRATIONS}, current.NEW_PENDING_MIGRATIONS)

    def test_new_queue_pending_tamper_and_missing_are_rejected(self):
        for path in self.new_queue_paths:
            target = self.repo / path
            original = target.read_bytes()
            target.write_bytes(original + b"-- unreviewed change\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            target.unlink()
            with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
                self.prepare()
            self.assertFalse(self.output.exists())
            target.write_bytes(original)

    def test_new_queue_generation_without_schedule_head_is_rejected(self):
        self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths, Path(current.CANCELLATION_NEXT_DUE_MIGRATION)])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def prepare(self):
        return current.prepare_current_policy(self.repo, self.output, gateway_probe=True)

    def commit_paths(self, paths):
        self.fixture.git("add", *(str(path) for path in paths))
        self.fixture.git("-c", "user.name=Policy fixture", "-c", "user.email=policy@example.invalid",
                         "-c", "commit.gpgsign=false", "commit", "-qm", "reviewed fixture")


    def test_fixed_dispatch_and_cancel_guard_registration_hashes(self):
        source = (ROOT / "tools/local/prepare_current_policy.py").read_text()
        self.assertIn('"backend/supabase/migrations/20261005232700_report_retention_dispatch_fence.sql": "4283b5d85a18404409db5828885576c091b8e4525a0f884a849f1d17bcdac2c5"', source)
        self.assertIn('"backend/supabase/migrations/20261005233511_cancellation_due_guard_closed.sql": "85aec069961a72d9ea0bd1cc23324c8c2c93800fba23896cd26eb4777df831b6"', source)

    def test_committed81_requires_only_cancel_guard_pending(self):
        self.commit_paths([*edge.GATEWAY_PENDING, *self.pre80_policy_paths, Path(current.REPORT_RETENTION_DISPATCH_MIGRATION)])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (81, 5))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(report["sql_execution"], "NOT_RUN")

    def test_arbitrary81_guard_without_dispatch_rejected(self):
        self.commit_paths([*edge.GATEWAY_PENDING, *self.pre80_policy_paths, Path(current.CANCELLATION_DUE_GUARD_MIGRATION)])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_dispatch_and_cancel_guard_missing_rejected(self):
        for name in (current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION):
            path = self.repo / name
            original = path.read_bytes()
            path.unlink()
            with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_dispatch_and_cancel_guard_pending_and_head_tamper_rejected(self):
        for name in (current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION):
            path = self.repo / name
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed delta\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)
        self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
        for name in (current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION):
            path = self.repo / name
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed delta\n")
            self.commit_paths([path.relative_to(self.repo)])
            with self.assertRaisesRegex(current.PreparationError, "HEAD SQL 내용"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)
            self.commit_paths([path.relative_to(self.repo)])

    def test_unknown_future_after82_rejected(self):
        path = self.fixture.sql_dir / "20261005233512_unreviewed_future.sql"
        path.write_text("select 'unreviewed';\n")
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖"):
            self.prepare()
        self.assertFalse(self.output.exists())
        self.commit_paths([path.relative_to(self.repo)])
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_fixed_retention_and_supported_claim_registration_hashes(self):
        source = (ROOT / "tools/local/prepare_current_policy.py").read_text()
        self.assertIn('"backend/supabase/migrations/20261005225107_report_retention_purge.sql": "c5b801c0f31dd8f058aafd844f90b5531cd582c7f668cc6703b0b01b3ce14a91"', source)
        self.assertIn('"backend/supabase/migrations/20261005225951_worker_supported_claim.sql": "bbe43a5adaef287145d832a37353c9c32991a813663b28975f8c1d5ad532fa8b"', source)

    def test_committed78_requires_exact_retention_and_supported_claim_pending(self):
        self.commit_paths([*edge.GATEWAY_PENDING, *self.pre78_policy_paths])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (78, 8))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(report["migration_count"], 86)
        self.assertEqual(report["sql_execution"], "NOT_RUN")

    def test_committed79_requires_only_exact_supported_claim_pending(self):
        self.commit_paths([*edge.GATEWAY_PENDING, *self.pre78_policy_paths, Path(current.REPORT_RETENTION_PURGE_MIGRATION)])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (79, 7))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])

    def test_retention_and_supported_claim_missing_rejected(self):
        for name in (current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION):
            path = self.repo / name
            original = path.read_bytes()
            path.unlink()
            with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_retention_and_supported_claim_pending_and_head_tampering_rejected(self):
        for name in (current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION):
            path = self.repo / name
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed delta\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)
        self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
        for name in (current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION):
            path = self.repo / name
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed delta\n")
            self.commit_paths([path.relative_to(self.repo)])
            with self.assertRaisesRegex(current.PreparationError, "HEAD SQL 내용"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)
            self.commit_paths([path.relative_to(self.repo)])

    def test_arbitrary79_with_supported_claim_without_retention_rejected(self):
        previous = [path for path in self.pre80_policy_paths if path != Path(current.REPORT_RETENTION_PURGE_MIGRATION)]
        self.commit_paths([*edge.GATEWAY_PENDING, *previous])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_unknown_future_after_supported_claim_rejected(self):
        path = self.fixture.sql_dir / "20261005225952_unreviewed_future.sql"
        path.write_text("select 'unreviewed';\n")
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖"):
            self.prepare()
        self.assertFalse(self.output.exists())
        self.commit_paths([path.relative_to(self.repo)])
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_fixed_cancel_resolution_registration_hash(self):
        source = (ROOT / "tools/local/prepare_current_policy.py").read_text()
        self.assertIn('"backend/supabase/migrations/20261005203258_appointment_cancel_resolution_and_due.sql": "542d2efcc3c44e45e4d3cd1f7caeb2f22e5649615a22ff547f319267a45b3efa"', source)

    def test_committed77_requires_only_exact_resolution_pending(self):
        previous = [path for path in self.pre78_policy_paths if path != Path(current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION)]
        self.commit_paths([*edge.GATEWAY_PENDING, *previous])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (77, 9))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(report["migration_count"], 86)
        self.assertEqual(report["sql_execution"], "NOT_RUN")

    def test_cancel_resolution_missing_rejected(self):
        (self.repo / current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION).unlink()
        with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_cancel_resolution_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed resolution\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_arbitrary77_with_resolution_without_atomic_rejected(self):
        previous = [path for path in self.pre78_policy_paths if path != Path(current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION)]
        self.commit_paths([*edge.GATEWAY_PENDING, *previous])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_unknown_future_after_resolution_rejected(self):
        path = self.fixture.sql_dir / "20261005203259_unreviewed_future.sql"
        path.write_text("select 'unreviewed';\n")
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖"):
            self.prepare()
        self.assertFalse(self.output.exists())
        self.commit_paths([path.relative_to(self.repo)])
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_fixed_atomic_cancel_appeal_registration_hash(self):
        source = (ROOT / "tools/local/prepare_current_policy.py").read_text()
        self.assertIn('"backend/supabase/migrations/20261005195033_appointment_cancel_appeal_atomic_report.sql": "53750fc93d7edf48ff863807ccfa267c3e759213d55385b3d0d28103ec71f745"', source)

    def test_committed76_requires_only_exact_atomic_appeal_pending(self):
        previous = [path for path in self.pre78_policy_paths if path not in (Path(current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION), Path(current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION))]
        self.commit_paths([*edge.GATEWAY_PENDING, *previous])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (76, 10))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(report["migration_count"], 86)
        self.assertEqual(report["sql_execution"], "NOT_RUN")

    def test_atomic_appeal_missing_rejected(self):
        (self.repo / current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION).unlink()
        with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_atomic_appeal_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed atomic appeal\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_arbitrary76_with_atomic_without_intake_rejected(self):
        previous = [path for path in self.pre78_policy_paths if path != Path(current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION)]
        self.commit_paths([*edge.GATEWAY_PENDING, *previous])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_unknown_future_after_atomic_appeal_rejected(self):
        path = self.fixture.sql_dir / "20261005195034_unreviewed_future.sql"
        path.write_text("select 'unreviewed';\n")
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖"):
            self.prepare()
        self.assertFalse(self.output.exists())
        self.commit_paths([path.relative_to(self.repo)])
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_fixed_cancel_appeal_registration_hash(self):
        source = (ROOT / "tools/local/prepare_current_policy.py").read_text()
        self.assertIn('"backend/supabase/migrations/20261005190311_appointment_cancel_appeal_intake.sql": "359a8093c3a32bf7d547a17df98173de677307933780a8e78db323bc4c26fcd8"', source)

    def test_committed75_requires_only_exact_cancel_appeal_pending(self):
        previous = [path for path in self.pre78_policy_paths if path not in (Path(current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION), Path(current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION), Path(current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION))]
        self.commit_paths([*edge.GATEWAY_PENDING, *previous])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (75, 11))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(report["migration_count"], 86)
        self.assertEqual(report["sql_execution"], "NOT_RUN")

    def test_committed80_requires_dispatch_and_guard_pending(self):
        self.commit_paths([*edge.GATEWAY_PENDING, *self.pre80_policy_paths])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (80, 6))
        self.assertEqual(report["sql_execution"], "NOT_RUN")

    def test_cancel_appeal_missing_rejected(self):
        (self.repo / current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION).unlink()
        with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_cancel_appeal_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed appeal\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_arbitrary75_with_appeal_without_notice_rejected(self):
        previous = [path for path in self.pre78_policy_paths if path != Path(current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION)]
        self.commit_paths([*edge.GATEWAY_PENDING, *previous])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_unknown_future_after_cancel_appeal_rejected(self):
        path = self.fixture.sql_dir / "20261005190312_unreviewed_future.sql"
        path.write_text("select 'unreviewed';\n")
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖"):
            self.prepare()
        self.assertFalse(self.output.exists())
        self.commit_paths([path.relative_to(self.repo)])
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_fixed_notice_registration_hash(self):
        source = (ROOT / "tools/local/prepare_current_policy.py").read_text()
        self.assertIn('"backend/supabase/migrations/20261005180340_assigned_report_notice_receipts.sql": "880e62099cbb2f405da1e9035bcba2bdb0ff19c2f5a4d5222c63586240fbfc6b"', source)

    def test_committed74_requires_only_exact_notice_pending(self):
        previous = [path for path in self.pre78_policy_paths if path not in (Path(current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION),Path(current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION), Path(current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION), Path(current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION))]
        self.commit_paths([*edge.GATEWAY_PENDING, *previous])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (74, 12))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(report["migration_count"], 86)
        self.assertEqual(report["sql_execution"], "NOT_RUN")

    def test_notice_missing_rejected(self):
        (self.repo / current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION).unlink()
        with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_notice_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed notice\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_arbitrary74_with_notice_without_adjudication_rejected(self):
        previous = [path for path in self.pre78_policy_paths if path != Path(current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION)]
        self.commit_paths([*edge.GATEWAY_PENDING, *previous])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_unknown_future_after_notice_rejected(self):
        path = self.fixture.sql_dir / "20261005180341_unreviewed_future.sql"
        path.write_text("select 'unreviewed';\n")
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖"):
            self.prepare()
        self.assertFalse(self.output.exists())
        self.commit_paths([path.relative_to(self.repo)])
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_fixed_adjudication_registration_hash(self):
        source = (ROOT / "tools/local/prepare_current_policy.py").read_text()
        self.assertIn('"backend/supabase/migrations/20261005171606_assigned_report_adjudication.sql": "d2e3b141ea5ad7048d075f1568f7afd6fc1320e3daa4f71163b252a91b825133"', source)

    def test_committed73_requires_only_exact_adjudication_pending(self):
        previous = [path for path in self.pre78_policy_paths if path not in (Path(current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION), Path(current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION), Path(current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION), Path(current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION), Path(current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION))]
        self.commit_paths([*edge.GATEWAY_PENDING, *previous])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (73, 13))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION, current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(report["migration_count"], 86)
        self.assertEqual(report["sql_execution"], "NOT_RUN")

    def test_adjudication_missing_rejected(self):
        (self.repo / current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION).unlink()
        with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_adjudication_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed adjudication\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_arbitrary73_with_adjudication_without_state_rejected(self):
        previous = [path for path in self.pre78_policy_paths if path not in (Path(current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION), Path(current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION), Path(current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION), Path(current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION), Path(current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION))]
        self.commit_paths([*edge.GATEWAY_PENDING, *previous])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_unknown_future_after_adjudication_rejected(self):
        path = self.fixture.sql_dir / "20261005171607_unreviewed_future.sql"
        path.write_text("select 'unreviewed';\n")
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖"):
            self.prepare()
        self.assertFalse(self.output.exists())
        self.commit_paths([path.relative_to(self.repo)])
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_fixed_review_start_and_state_registration_hashes(self):
        # setUp patches hashes for synthetic SQL; inspect the fixed registration source separately.
        source = (ROOT / "tools/local/prepare_current_policy.py").read_text()
        self.assertIn('"backend/supabase/migrations/20261005155136_assigned_report_review_start.sql": "c1083e452b284ed66edaa11bb4e075914e6f93ce64ab918a1c266f62ad470b71"', source)
        self.assertIn('"backend/supabase/migrations/20261005161352_assigned_report_review_state.sql": "4c497604f20db4708f65750697fe8bc4f51ea5e1afe6d81d95c2e119a63f0846"', source)

    def test_committed71_requires_exact_review_start_and_state_pending(self):
        self.commit_paths([*edge.GATEWAY_PENDING, *self.legacy_policy_paths])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (71, 15))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [current.ASSIGNED_REPORT_REVIEW_START_MIGRATION, current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION, current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(report["migration_count"], 86)
        self.assertEqual(report["sql_execution"], "NOT_RUN")

    def test_committed72_requires_only_review_state_pending(self):
        self.commit_paths([*edge.GATEWAY_PENDING, *self.legacy_policy_paths, Path(current.ASSIGNED_REPORT_REVIEW_START_MIGRATION)])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (72, 14))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION, current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(report["edge_execution"], "NOT_RUN")

    def test_arbitrary72_with_state_without_start_rejected(self):
        self.commit_paths([*edge.GATEWAY_PENDING, *self.legacy_policy_paths, Path(current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION)])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_review_start_and_state_missing_rejected(self):
        for name in (current.ASSIGNED_REPORT_REVIEW_START_MIGRATION, current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION):
            path = self.repo / name
            original = path.read_bytes()
            path.unlink()
            with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_review_start_and_state_pending_and_committed_tampering_rejected(self):
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            for name in (current.ASSIGNED_REPORT_REVIEW_START_MIGRATION, current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION):
                path = self.repo / name
                original = path.read_bytes()
                path.write_bytes(original + b"-- unreviewed report state\n")
                with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                    self.prepare()
                self.assertFalse(self.output.exists())
                path.write_bytes(original)

    def test_unknown_future_review_sql_rejected(self):
        path = self.fixture.sql_dir / "20261005161353_unreviewed.sql"
        path.write_text("select 'unreviewed';\n")
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_explicit_gateway_selection_required(self):
        with self.assertRaisesRegex(current.PreparationError, "gateway-probe"):
            current.prepare_current_policy(self.repo, self.output)
        self.assertFalse(self.output.exists())

    def test_28_head_and_54_pending_prepare_exact82_preserving_source(self):
        selected = [self.fixture.config, self.fixture.entry, self.fixture.shared,
                    *self.fixture.canonical, *(self.repo / path for path in edge.GATEWAY_PENDING),
                    *(self.repo / path for path in self.policy_paths)]
        before = {path: path.read_bytes() for path in selected}
        original_head = current.git(self.repo, "rev-parse", "HEAD").decode().strip()
        report = self.prepare()
        self.assertEqual(report["source_head"], original_head)
        self.assertEqual(current.git(self.repo, "rev-parse", "HEAD").decode().strip(), original_head)
        self.assertEqual(report["migration_count"], 86)
        self.assertEqual(report["canonical_count"], 28)
        self.assertEqual(report["pending_count"], 58)
        self.assertEqual(report["base_migration_count"], 41)
        self.assertEqual(report["policy_migration_count"], 45)
        self.assertEqual(report["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")
        self.assertEqual(report["functions"], ["service-api"])
        self.assertEqual(len(list((self.output / "supabase/migrations").glob("*.sql"))), 86)
        self.assertEqual((self.output.stat().st_mode & 0o777), 0o700)
        self.assertEqual({path: path.read_bytes() for path in selected}, before)
        manifest = json.loads((self.output / "migration-manifest.json").read_text())
        self.assertEqual(manifest["count"], 86)
        self.assertEqual(len(manifest["migrations"]), 86)
        base = json.loads((self.output / "base-edge-manifest.json").read_text())
        self.assertEqual(base["migration_count"], 41)
        self.assertEqual(base["canonical_count"], 41)
        self.assertEqual(base["source_head"], report["base_snapshot_head"])
        self.assertEqual(report["source_files"], base["source_files"])
        for entry in manifest["migrations"]:
            target = self.output / "supabase/migrations" / Path(entry["path"]).name
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), entry["sha256"])
        for entry in report["source_files"]:
            self.assertEqual(hashlib.sha256((self.output / entry["target"]).read_bytes()).hexdigest(), entry["sha256"])

    def test_committed41_plus_exact41_pending(self):
        self.commit_paths(edge.GATEWAY_PENDING)
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (41, 45))
        database = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual(len(database["migrations"]), 41)
        self.assertEqual(len(database["pending"]), 45)

    def test_committed82_with_no_pending_keeps_original_strict41_guard(self):
        self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
        with self.assertRaisesRegex(edge.PreparationError, "28개.*41개"):
            edge.prepare_gateway_probe(self.repo, self.output)
        self.assertFalse(self.output.exists())
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (82, 4))
        database = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual({entry["path"] for entry in database["pending"]}, current.NEW_PENDING_MIGRATIONS)
        self.assertEqual(len(database["migrations"]), 82)

    def test_committed60_requires_exact40300_40500_40600_40700_40800_40900_pending(self):
        role_path = Path(current.QUEUE_RUNNER_ROLE_MIGRATION)
        preferences_path = Path(current.PROFILE_PREFERENCES_MIGRATION)
        withdrawal_path = Path(current.APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION)
        safety_path = Path(current.MEMBER_SAFETY_STATE_MIGRATION)
        sync_path = Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)
        previous_policy = [path for path in self.previous_policy_paths if path != Path(current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION) and path not in (role_path, preferences_path, withdrawal_path, safety_path, sync_path, Path(current.APPOINTMENT_REVIEW_HOLDS_MIGRATION))]
        self.commit_paths([*edge.GATEWAY_PENDING, *previous_policy])
        before = {path: (self.repo / path).read_bytes() for path in self.policy_paths}
        with self.assertRaisesRegex(edge.PreparationError, "28개.*41개"):
            edge.prepare_gateway_probe(self.repo, self.output)
        self.assertFalse(self.output.exists())
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (60, 26))
        self.assertEqual(report["migration_count"], 86)
        database = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual(len(database["migrations"]), 60)
        self.assertEqual([entry["path"] for entry in database["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [str(role_path), str(preferences_path), str(withdrawal_path), str(safety_path), str(sync_path), current.APPOINTMENT_REVIEW_HOLDS_MIGRATION, current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION, current.MEMBER_SANCTION_HISTORY_MIGRATION, current.PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, current.ASSIGNED_REPORT_REVIEW_START_MIGRATION, current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION, current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(database["total_count"], 86)
        self.assertEqual(database["pending"][0]["sha256"], hashlib.sha256(before[role_path]).hexdigest())
        self.assertEqual((self.output / "supabase/migrations" / role_path.name).read_bytes(), before[role_path])
        self.assertEqual({path: (self.repo / path).read_bytes() for path in self.policy_paths}, before)

    def test_arbitrary60_subset_including40300_is_not_previous60(self):
        self.commit_paths([*edge.GATEWAY_PENDING, *self.legacy_policy_paths[5:]])
        with self.assertRaisesRegex(current.PreparationError, "28개/41개/60개/61개/62개/63개/64개/65개/66개/67개/68개/69개/70개/71개/72개/73개/74개/75개/76개/77개/78개"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed61_requires_reviewed40500_40600_40700_40800_40900_pending(self):
        preferences = Path(current.PROFILE_PREFERENCES_MIGRATION)
        withdrawal = Path(current.APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION)
        safety = Path(current.MEMBER_SAFETY_STATE_MIGRATION)
        sync = Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING,
                           *(path for path in self.previous_policy_paths if path != Path(current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION) and path not in (preferences, withdrawal, safety, sync, Path(current.APPOINTMENT_REVIEW_HOLDS_MIGRATION)))])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (61, 25))
        database = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in database["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [str(preferences), str(withdrawal), str(safety), str(sync), current.APPOINTMENT_REVIEW_HOLDS_MIGRATION, current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION, current.MEMBER_SANCTION_HISTORY_MIGRATION, current.PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, current.ASSIGNED_REPORT_REVIEW_START_MIGRATION, current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION, current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(database["total_count"], 86)
        self.assertEqual(report["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")

    def test_arbitrary61_including40500_without40300_rejected(self):
        role_path = Path(current.QUEUE_RUNNER_ROLE_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING,
                           *(path for path in self.previous_policy_paths if path != Path(current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION) and path not in (role_path, Path(current.APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION), Path(current.MEMBER_SAFETY_STATE_MIGRATION), Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)))])
        with self.assertRaisesRegex(current.PreparationError, "28개/41개/60개/61개/62개/63개/64개/65개/66개/67개/68개/69개/70개/71개/72개/73개/74개/75개/76개/77개/78개"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed62_requires_reviewed40600_40700_40800_40900_pending(self):
        withdrawal = Path(current.APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION)
        safety = Path(current.MEMBER_SAFETY_STATE_MIGRATION)
        sync = Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.previous_policy_paths if path != Path(current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION) and path not in (withdrawal, safety, sync, Path(current.APPOINTMENT_REVIEW_HOLDS_MIGRATION)))])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (62, 24))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [str(withdrawal), str(safety), str(sync), current.APPOINTMENT_REVIEW_HOLDS_MIGRATION, current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION, current.MEMBER_SANCTION_HISTORY_MIGRATION, current.PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, current.ASSIGNED_REPORT_REVIEW_START_MIGRATION, current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION, current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(manifest["pending"][0]["sha256"], hashlib.sha256((self.repo / withdrawal).read_bytes()).hexdigest())
        self.assertEqual(manifest["total_count"], 86)
        self.assertEqual(manifest["sql_execution"], "NOT_RUN")

    def test_arbitrary62_with40600_without40500_rejected(self):
        preferences = Path(current.PROFILE_PREFERENCES_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.previous_policy_paths if path != Path(current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION) and path not in (preferences, Path(current.MEMBER_SAFETY_STATE_MIGRATION), Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)))])
        with self.assertRaisesRegex(current.PreparationError, "28개/41개/60개/61개/62개/63개/64개/65개/66개/67개/68개/69개/70개/71개/72개/73개/74개/75개/76개/77개/78개"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed63_requires_reviewed40700_40800_40900_pending(self):
        safety = Path(current.MEMBER_SAFETY_STATE_MIGRATION)
        sync = Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.previous_policy_paths if path != Path(current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION) and path not in (safety, sync, Path(current.APPOINTMENT_REVIEW_HOLDS_MIGRATION)))])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (63, 23))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [str(safety), str(sync), current.APPOINTMENT_REVIEW_HOLDS_MIGRATION, current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION, current.MEMBER_SANCTION_HISTORY_MIGRATION, current.PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, current.ASSIGNED_REPORT_REVIEW_START_MIGRATION, current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION, current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(manifest["pending"][0]["sha256"], hashlib.sha256((self.repo / safety).read_bytes()).hexdigest())
        self.assertEqual(manifest["total_count"], 86)
        self.assertEqual(manifest["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")

    def test_arbitrary63_with40700_without40600_rejected(self):
        withdrawal = Path(current.APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.previous_policy_paths if path != Path(current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION) and path not in (withdrawal, Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)))])
        with self.assertRaisesRegex(current.PreparationError, "28개/41개/60개/61개/62개/63개/64개/65개/66개/67개/68개/69개/70개/71개/72개/73개/74개/75개/76개/77개/78개"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed64_requires_reviewed40800_40900_pending(self):
        sync = Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.previous_policy_paths if path != Path(current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION) and path not in (sync, Path(current.APPOINTMENT_REVIEW_HOLDS_MIGRATION)))])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (64, 22))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [str(sync), current.APPOINTMENT_REVIEW_HOLDS_MIGRATION, current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION, current.MEMBER_SANCTION_HISTORY_MIGRATION, current.PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, current.ASSIGNED_REPORT_REVIEW_START_MIGRATION, current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION, current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(manifest["pending"][0]["sha256"], hashlib.sha256((self.repo / sync).read_bytes()).hexdigest())
        self.assertEqual(manifest["total_count"], 86)
        self.assertEqual(manifest["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")

    def test_arbitrary64_with40800_without40700_rejected(self):
        safety = Path(current.MEMBER_SAFETY_STATE_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.previous_policy_paths if path not in (safety, Path(current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION)))])
        with self.assertRaisesRegex(current.PreparationError, "28개/41개/60개/61개/62개/63개/64개/65개/66개/67개/68개/69개/70개/71개/72개/73개/74개/75개/76개/77개/78개"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed65_requires_reviewed40900_41000_pending(self):
        hold = Path(current.APPOINTMENT_REVIEW_HOLDS_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.previous_policy_paths if path not in (hold, Path(current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION)))])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (65, 21))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [str(hold), current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION, current.MEMBER_SANCTION_HISTORY_MIGRATION, current.PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, current.ASSIGNED_REPORT_REVIEW_START_MIGRATION, current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION, current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(manifest["pending"][0]["sha256"], hashlib.sha256((self.repo / hold).read_bytes()).hexdigest())
        self.assertEqual(manifest["total_count"], 86)
        self.assertEqual(report["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")

    def test_arbitrary65_with40900_without40800_rejected(self):
        sync = Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.previous_policy_paths if path not in (sync, Path(current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION)))])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed66_requires_only_reviewed41000_pending(self):
        terminal = Path(current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.previous_policy_paths if path != terminal)])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (66, 20))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [str(terminal), current.MEMBER_SANCTION_HISTORY_MIGRATION, current.PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, current.ASSIGNED_REPORT_REVIEW_START_MIGRATION, current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION, current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(manifest["pending"][0]["sha256"], hashlib.sha256((self.repo / terminal).read_bytes()).hexdigest())
        self.assertEqual(manifest["total_count"], 86)
        self.assertEqual(report["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")

    def test_arbitrary66_with41000_without40900_rejected(self):
        hold = Path(current.APPOINTMENT_REVIEW_HOLDS_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.previous_policy_paths if path != hold)])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed67_requires_only_reviewed_sanction_history_pending(self):
        self.commit_paths([*edge.GATEWAY_PENDING, *self.previous_policy_paths])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (67, 19))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [current.MEMBER_SANCTION_HISTORY_MIGRATION, current.PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION, current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, current.ASSIGNED_REPORT_REVIEW_START_MIGRATION, current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION, current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(manifest["pending"][0]["sha256"], hashlib.sha256((self.repo / current.MEMBER_SANCTION_HISTORY_MIGRATION).read_bytes()).hexdigest())
        self.assertEqual(manifest["total_count"], 86)
        self.assertEqual(report["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")

    def test_arbitrary67_with_sanction_history_without41000_rejected(self):
        terminal = Path(current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.legacy_policy_paths if path not in (terminal, Path(current.PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION), Path(current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION), Path(current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION)))])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed68_requires_only_reviewed_profile_image_pending(self):
        photo = Path(current.PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.legacy_policy_paths if path not in (photo, Path(current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION), Path(current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION)))])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (68, 18))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [str(photo), current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION, current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, current.ASSIGNED_REPORT_REVIEW_START_MIGRATION, current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION, current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(manifest["pending"][0]["sha256"], hashlib.sha256((self.repo / photo).read_bytes()).hexdigest())
        self.assertEqual(manifest["total_count"], 86)
        self.assertEqual(report["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")

    def test_arbitrary68_with_photo_without_sanction_history_rejected(self):
        history = Path(current.MEMBER_SANCTION_HISTORY_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.legacy_policy_paths if path not in (history, Path(current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION), Path(current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION)))])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed69_requires_only_reviewed_operator_access_pending(self):
        operator = Path(current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.legacy_policy_paths if path not in (operator, Path(current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION)))])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (69, 17))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [str(operator), current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION, current.ASSIGNED_REPORT_REVIEW_START_MIGRATION, current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION, current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(manifest["pending"][0]["sha256"], hashlib.sha256((self.repo / operator).read_bytes()).hexdigest())
        self.assertEqual(manifest["total_count"], 86)
        self.assertEqual(report["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")

    def test_arbitrary69_with_operator_without_photo_access_rejected(self):
        photo = Path(current.PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.legacy_policy_paths if path not in (photo, Path(current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION)))])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed70_requires_only_reviewed_capture_access_pending(self):
        capture = Path(current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.legacy_policy_paths if path != capture)])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (70, 16))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"] if entry["path"] not in current.NEW_PENDING_MIGRATIONS], [str(capture), current.ASSIGNED_REPORT_REVIEW_START_MIGRATION, current.ASSIGNED_REPORT_REVIEW_STATE_MIGRATION, current.ASSIGNED_REPORT_ADJUDICATION_MIGRATION, current.ASSIGNED_REPORT_NOTICE_RECEIPTS_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_INTAKE_MIGRATION, current.APPOINTMENT_CANCEL_APPEAL_ATOMIC_REPORT_MIGRATION, current.APPOINTMENT_CANCEL_RESOLUTION_AND_DUE_MIGRATION, current.REPORT_RETENTION_PURGE_MIGRATION, current.WORKER_SUPPORTED_CLAIM_MIGRATION, current.REPORT_RETENTION_DISPATCH_MIGRATION, current.CANCELLATION_DUE_GUARD_MIGRATION])
        self.assertEqual(manifest["pending"][0]["sha256"], hashlib.sha256((self.repo / capture).read_bytes()).hexdigest())
        self.assertEqual(manifest["total_count"], 86)
        self.assertEqual(report["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")

    def test_arbitrary70_with_capture_without_operator_access_rejected(self):
        operator = Path(current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.legacy_policy_paths if path != operator)])
        with self.assertRaisesRegex(current.PreparationError, "검토된 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_capture_access_source_missing_rejected(self):
        (self.repo / current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION).unlink()
        with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_capture_access_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.ASSIGNED_REPORT_CAPTURE_ACCESS_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed report capture access\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_unknown_future_after_capture_access_untracked_and_head_rejected(self):
        path = self.fixture.sql_dir / "20261005150559_unreviewed_future.sql"
        path.write_text("select 'unreviewed future';\n")
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖"):
            self.prepare()
        self.assertFalse(self.output.exists())
        self.commit_paths([path.relative_to(self.repo)])
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖 HEAD"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_operator_access_source_missing_rejected(self):
        (self.repo / current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION).unlink()
        with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_operator_access_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.ASSIGNED_REPORT_OPERATOR_ACCESS_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed operator access\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_profile_image_source_missing_rejected(self):
        (self.repo / current.PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION).unlink()
        with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_profile_image_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.PROFILE_IMAGE_AUTHENTICATED_ACCESS_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed profile image access\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_sanction_history_source_missing_rejected(self):
        (self.repo / current.MEMBER_SANCTION_HISTORY_MIGRATION).unlink()
        with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_sanction_history_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.MEMBER_SANCTION_HISTORY_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed sanction history\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_no_show_source_missing_rejected(self):
        (self.repo / current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION).unlink()
        with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_no_show_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.APPOINTMENT_REVIEW_NO_SHOW_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed terminal result\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_reviewed_hold_source_missing_rejected(self):
        (self.repo / current.APPOINTMENT_REVIEW_HOLDS_MIGRATION).unlink()
        with self.assertRaisesRegex(current.PreparationError, "일반 소스 파일"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_hold_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.APPOINTMENT_REVIEW_HOLDS_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed hold\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_sync_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed appointment result sync\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_safety_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.MEMBER_SAFETY_STATE_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed safety\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_withdrawal_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed withdrawal\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_preferences_pending_and_committed_tampering_rejected(self):
        path = self.repo / current.PROFILE_PREFERENCES_MIGRATION
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed preferences\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_staged_exact_policy_sql_is_still_pending_until_commit(self):
        self.commit_paths(edge.GATEWAY_PENDING)
        self.fixture.git("add", *(str(path) for path in self.policy_paths))
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (41, 45))

    def test_partial_committed_policy_history_rejected(self):
        self.commit_paths([*edge.GATEWAY_PENDING, self.policy_paths[0]])
        with self.assertRaisesRegex(current.PreparationError, "28개/41개/60개/61개/62개/63개/64개/65개/66개/67개/68개/69개/70개/71개/72개/73개/74개/75개/76개/77개/78개"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_pending_or_committed_hash_tampering_rejected(self):
        for committed in (False, True):
            if committed:
                self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
            path = self.repo / self.policy_paths[0]
            original = path.read_bytes()
            path.write_bytes(original + b"-- unreviewed\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_partial49_and_previous48_head_rejected(self):
        for policy_count in (7, 8):
            self.commit_paths([*edge.GATEWAY_PENDING, *self.legacy_policy_paths[:policy_count]])
            with self.assertRaisesRegex(current.PreparationError, "28개/41개/60개/61개/62개/63개/64개/65개/66개/67개/68개/69개/70개/71개/72개/73개/74개/75개/76개/77개/78개"):
                self.prepare()
            self.assertFalse(self.output.exists())

    def test_new_reopen_block_sweetness_place_sql_tampering_rejected(self):
        for path in self.policy_paths[-6:]:
            source = self.repo / path
            original = source.read_bytes()
            source.write_bytes(original + b"-- unreviewed new policy\n")
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시"):
                self.prepare()
            self.assertFalse(self.output.exists())
            source.write_bytes(original)

    def test_unknown_untracked_or_head_sql_never_approved(self):
        path = self.fixture.sql_dir / "20261005009999_unreviewed.sql"
        path.write_text("select 'unreviewed';\n")
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖"):
            self.prepare()
        self.assertFalse(self.output.exists())
        self.commit_paths([path.relative_to(self.repo)])
        with self.assertRaisesRegex(current.PreparationError, "검토 목록 밖 HEAD"):
            self.prepare()

    def test_duplicate2_cache_and_env_are_not_copied(self):
        copy = self.fixture.sql_dir / "20261005001429_current_completion_consent_policy 2.sql"
        copy.write_text("select 'excluded';\n")
        (self.repo / ".env").write_text("PRIVATE_TEST_VALUE=excluded\n")
        (self.repo / "tools/local/__pycache__").mkdir(parents=True)
        (self.repo / "tools/local/__pycache__/synthetic.pyc").write_bytes(b"excluded")
        (self.fixture.entry.parent / "index 2.ts").write_text("excluded")
        self.prepare()
        self.assertFalse(any(" 2." in path.name or path.name == ".env" or "__pycache__" in path.parts
                             for path in self.output.rglob("*")))
        manifest = json.loads((self.output / "migration-manifest.json").read_text())
        self.assertIn(str(copy.relative_to(self.repo)), manifest["excluded"])

    def test_sql_symlink_rejected_before_output(self):
        path = self.repo / self.policy_paths[0]
        alternate = self.repo / "synthetic.sql"
        alternate.write_bytes(path.read_bytes())
        path.unlink(); path.symlink_to(alternate)
        with self.assertRaisesRegex(current.PreparationError, "심볼릭 링크"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_external_and_dynamic_imports_rejected(self):
        original = self.fixture.entry.read_text()
        for extra in ('import "https://example.invalid/unreviewed.ts";\n', 'const value = import("./dynamic.ts");\n'):
            self.fixture.entry.write_text(original + extra)
            with self.assertRaisesRegex(current.PreparationError, "외부 모듈|동적 import"):
                self.prepare()
            self.assertFalse(self.output.exists())

    def test_output_is_not_overwritten(self):
        self.output.mkdir()
        marker = self.output / "preserve"
        marker.write_text("before")
        with self.assertRaisesRegex(current.PreparationError, "빈 디렉터리"):
            self.prepare()
        self.assertEqual(marker.read_text(), "before")

    def test_source_change_during_preparation_has_no_current_ready_manifest(self):
        original = current.create_base_snapshot
        def mutate(*args):
            result = original(*args)
            (self.repo / self.policy_paths[0]).write_text("select 'changed';\n")
            return result
        with patch.object(current, "create_base_snapshot", side_effect=mutate):
            with self.assertRaisesRegex(current.PreparationError, "검토된 해시|원본이 변경"):
                self.prepare()
        self.assertFalse((self.output / "current-policy-manifest.json").exists())
        self.assertFalse((self.output / "edge-manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
