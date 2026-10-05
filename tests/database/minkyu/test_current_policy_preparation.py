"""합성 Git·모형 SQL로 최신 65개 준비 범위와 기존 strict guard 보존을 검사한다."""
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
        self.policy_paths = [Path(name) for name in current.CURRENT_POLICY_REVIEWED]
        for index, path in enumerate(self.policy_paths, 1000):
            (self.repo / path).write_text(f"begin; select {index}; commit;\n")
        policy_hashes = {str(path): hashlib.sha256((self.repo / path).read_bytes()).hexdigest()
                         for path in self.policy_paths}
        patched = patch.object(current, "CURRENT_POLICY_REVIEWED", policy_hashes)
        patched.start()
        self.addCleanup(patched.stop)

    def prepare(self):
        return current.prepare_current_policy(self.repo, self.output, gateway_probe=True)

    def commit_paths(self, paths):
        self.fixture.git("add", *(str(path) for path in paths))
        self.fixture.git("-c", "user.name=Policy fixture", "-c", "user.email=policy@example.invalid",
                         "-c", "commit.gpgsign=false", "commit", "-qm", "reviewed fixture")

    def test_explicit_gateway_selection_required(self):
        with self.assertRaisesRegex(current.PreparationError, "gateway-probe"):
            current.prepare_current_policy(self.repo, self.output)
        self.assertFalse(self.output.exists())

    def test_28_head_and_37_pending_prepare_exact65_preserving_source(self):
        selected = [self.fixture.config, self.fixture.entry, self.fixture.shared,
                    *self.fixture.canonical, *(self.repo / path for path in edge.GATEWAY_PENDING),
                    *(self.repo / path for path in self.policy_paths)]
        before = {path: path.read_bytes() for path in selected}
        original_head = current.git(self.repo, "rev-parse", "HEAD").decode().strip()
        report = self.prepare()
        self.assertEqual(report["source_head"], original_head)
        self.assertEqual(current.git(self.repo, "rev-parse", "HEAD").decode().strip(), original_head)
        self.assertEqual(report["migration_count"], 65)
        self.assertEqual(report["canonical_count"], 28)
        self.assertEqual(report["pending_count"], 37)
        self.assertEqual(report["base_migration_count"], 41)
        self.assertEqual(report["policy_migration_count"], 24)
        self.assertEqual(report["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")
        self.assertEqual(report["functions"], ["service-api"])
        self.assertEqual(len(list((self.output / "supabase/migrations").glob("*.sql"))), 65)
        self.assertEqual((self.output.stat().st_mode & 0o777), 0o700)
        self.assertEqual({path: path.read_bytes() for path in selected}, before)
        manifest = json.loads((self.output / "migration-manifest.json").read_text())
        self.assertEqual(manifest["count"], 65)
        self.assertEqual(len(manifest["migrations"]), 65)
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

    def test_committed41_plus_exact24_pending(self):
        self.commit_paths(edge.GATEWAY_PENDING)
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (41, 24))
        database = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual(len(database["migrations"]), 41)
        self.assertEqual(len(database["pending"]), 24)

    def test_committed65_with_no_pending_keeps_original_strict41_guard(self):
        self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths])
        with self.assertRaisesRegex(edge.PreparationError, "28개.*41개"):
            edge.prepare_gateway_probe(self.repo, self.output)
        self.assertFalse(self.output.exists())
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (65, 0))
        database = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual(database["pending"], [])
        self.assertEqual(len(database["migrations"]), 65)

    def test_committed60_requires_exact40300_40500_40600_40700_40800_pending(self):
        role_path = Path(current.QUEUE_RUNNER_ROLE_MIGRATION)
        preferences_path = Path(current.PROFILE_PREFERENCES_MIGRATION)
        withdrawal_path = Path(current.APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION)
        safety_path = Path(current.MEMBER_SAFETY_STATE_MIGRATION)
        sync_path = Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)
        previous_policy = [path for path in self.policy_paths if path not in (role_path, preferences_path, withdrawal_path, safety_path, sync_path)]
        self.commit_paths([*edge.GATEWAY_PENDING, *previous_policy])
        before = {path: (self.repo / path).read_bytes() for path in self.policy_paths}
        with self.assertRaisesRegex(edge.PreparationError, "28개.*41개"):
            edge.prepare_gateway_probe(self.repo, self.output)
        self.assertFalse(self.output.exists())
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (60, 5))
        self.assertEqual(report["migration_count"], 65)
        database = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual(len(database["migrations"]), 60)
        self.assertEqual([entry["path"] for entry in database["pending"]], [str(role_path), str(preferences_path), str(withdrawal_path), str(safety_path), str(sync_path)])
        self.assertEqual(database["total_count"], 65)
        self.assertEqual(database["pending"][0]["sha256"], hashlib.sha256(before[role_path]).hexdigest())
        self.assertEqual((self.output / "supabase/migrations" / role_path.name).read_bytes(), before[role_path])
        self.assertEqual({path: (self.repo / path).read_bytes() for path in self.policy_paths}, before)

    def test_arbitrary60_subset_including40300_is_not_previous60(self):
        self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths[5:]])
        with self.assertRaisesRegex(current.PreparationError, "28개/41개/60개/61개/62개/63개/64개/65개"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed61_requires_reviewed40500_40600_40700_40800_pending(self):
        preferences = Path(current.PROFILE_PREFERENCES_MIGRATION)
        withdrawal = Path(current.APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION)
        safety = Path(current.MEMBER_SAFETY_STATE_MIGRATION)
        sync = Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING,
                           *(path for path in self.policy_paths if path not in (preferences, withdrawal, safety, sync))])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (61, 4))
        database = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in database["pending"]], [str(preferences), str(withdrawal), str(safety), str(sync)])
        self.assertEqual(database["total_count"], 65)
        self.assertEqual(report["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")

    def test_arbitrary61_including40500_without40300_rejected(self):
        role_path = Path(current.QUEUE_RUNNER_ROLE_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING,
                           *(path for path in self.policy_paths if path not in (role_path, Path(current.APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION), Path(current.MEMBER_SAFETY_STATE_MIGRATION), Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)))])
        with self.assertRaisesRegex(current.PreparationError, "28개/41개/60개/61개/62개/63개/64개/65개"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed62_requires_reviewed40600_40700_40800_pending(self):
        withdrawal = Path(current.APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION)
        safety = Path(current.MEMBER_SAFETY_STATE_MIGRATION)
        sync = Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.policy_paths if path not in (withdrawal, safety, sync))])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (62, 3))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"]], [str(withdrawal), str(safety), str(sync)])
        self.assertEqual(manifest["pending"][0]["sha256"], hashlib.sha256((self.repo / withdrawal).read_bytes()).hexdigest())
        self.assertEqual(manifest["total_count"], 65)
        self.assertEqual(manifest["sql_execution"], "NOT_RUN")

    def test_arbitrary62_with40600_without40500_rejected(self):
        preferences = Path(current.PROFILE_PREFERENCES_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.policy_paths if path not in (preferences, Path(current.MEMBER_SAFETY_STATE_MIGRATION), Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)))])
        with self.assertRaisesRegex(current.PreparationError, "28개/41개/60개/61개/62개/63개/64개/65개"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed63_requires_reviewed40700_and40800_pending(self):
        safety = Path(current.MEMBER_SAFETY_STATE_MIGRATION)
        sync = Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.policy_paths if path not in (safety, sync))])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (63, 2))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"]], [str(safety), str(sync)])
        self.assertEqual(manifest["pending"][0]["sha256"], hashlib.sha256((self.repo / safety).read_bytes()).hexdigest())
        self.assertEqual(manifest["total_count"], 65)
        self.assertEqual(manifest["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")

    def test_arbitrary63_with40700_without40600_rejected(self):
        withdrawal = Path(current.APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.policy_paths if path not in (withdrawal, Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)))])
        with self.assertRaisesRegex(current.PreparationError, "28개/41개/60개/61개/62개/63개/64개/65개"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed64_requires_only_reviewed40800_pending(self):
        sync = Path(current.APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.policy_paths if path != sync)])
        report = self.prepare()
        self.assertEqual((report["canonical_count"], report["pending_count"]), (64, 1))
        manifest = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual([entry["path"] for entry in manifest["pending"]], [str(sync)])
        self.assertEqual(manifest["pending"][0]["sha256"], hashlib.sha256((self.repo / sync).read_bytes()).hexdigest())
        self.assertEqual(manifest["total_count"], 65)
        self.assertEqual(manifest["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")

    def test_arbitrary64_with40800_without40700_rejected(self):
        safety = Path(current.MEMBER_SAFETY_STATE_MIGRATION)
        self.commit_paths([*edge.GATEWAY_PENDING, *(path for path in self.policy_paths if path != safety)])
        with self.assertRaisesRegex(current.PreparationError, "28개/41개/60개/61개/62개/63개/64개/65개"):
            self.prepare()
        self.assertFalse(self.output.exists())

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
        self.assertEqual((report["canonical_count"], report["pending_count"]), (41, 24))

    def test_partial_committed_policy_history_rejected(self):
        self.commit_paths([*edge.GATEWAY_PENDING, self.policy_paths[0]])
        with self.assertRaisesRegex(current.PreparationError, "28개/41개/60개/61개/62개/63개/64개/65개"):
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
            self.commit_paths([*edge.GATEWAY_PENDING, *self.policy_paths[:policy_count]])
            with self.assertRaisesRegex(current.PreparationError, "28개/41개/60개/61개/62개/63개/64개/65개"):
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
