"""합성 Git 이력으로 원격 20버전 준비의 범위·원본 보존을 검사한다. DB 실행 없음."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/local"))
import prepare_remote_baseline as baseline
import prepare_edge as edge


class RemoteBaselinePreparationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir="/private/tmp")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.repo = self.base / "repo"
        self.sql = self.repo / baseline.MIGRATIONS
        self.sql.mkdir(parents=True)
        self.config = self.repo / baseline.CONFIG
        self.config.write_bytes((ROOT / baseline.CONFIG).read_bytes())
        self.sources = []
        for index in range(1, 29):
            path = self.sql / f"2026010100{index:04d}_fixture.sql"
            path.write_text(f"select {index};\n")
            self.sources.append(path)
        self.git("init", "-q", "-b", "fixture")
        self.git("add", ".")
        self.git("-c", "user.name=Baseline fixture", "-c", "user.email=baseline@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
        self.version_file = self.base / "versions.json"
        self.versions = [path.name[:14] for path in self.sources[:20]]
        self.write_versions(self.versions)
        self.output = self.base / "execution"
        self.additional = {path: f"begin; select {index}; commit;\n".encode()
                           for index, path in enumerate(edge.GATEWAY_PENDING, 100)}
        reviewed = {str(path.relative_to(self.repo)): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in self.sources}
        reviewed.update({str(path): hashlib.sha256(data).hexdigest() for path, data in self.additional.items()})
        reviewed_patch = patch.object(edge, "GATEWAY_REVIEWED_MIGRATIONS", reviewed)
        reviewed_patch.start()
        self.addCleanup(reviewed_patch.stop)

    def git(self, *args):
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
        return subprocess.run(["git", "-C", str(self.repo), *args], env=env,
                              capture_output=True, check=True, timeout=10)

    def write_versions(self, value):
        self.version_file.write_text(json.dumps(value))
        self.version_file.chmod(0o600)

    def prepare(self):
        return baseline.prepare_remote_baseline(self.repo, self.version_file, self.output)

    def test_selected_twenty_only_preserves_sources_and_exact_overlay(self):
        original = {path: path.read_bytes() for path in [self.config, *self.sources]}
        (self.repo / ".env").write_text("SYNTHETIC_PRIVATE_VALUE=not-for-copy\n")
        (self.sql / "20261003090000_completion_runner_role.sql").write_text("select 'pending';")
        (self.sql / "20260101000001_fixture 2.sql").write_text("select 'copy';")
        report = self.prepare()
        self.assertEqual(report["status"], "READY")
        self.assertEqual(report["sql_execution"], "NOT_RUN")
        self.assertEqual((report["count"], report["canonical_count"]), (20, 28))
        self.assertEqual(report["pending"], [])
        self.assertEqual(report["functions"], [])
        self.assertEqual([e["version"] for e in report["migrations"]], self.versions)
        self.assertEqual(len(report["source_migrations"]), 28)
        copied = list((self.output / "supabase/migrations").iterdir())
        self.assertEqual({p.name for p in copied}, {p.name for p in self.sources[:20]})
        for path in self.sources[:20]:
            self.assertEqual((self.output / "supabase/migrations" / path.name).read_bytes(), original[path])
        self.assertEqual({p.relative_to(self.output).as_posix() for p in self.output.rglob("*") if p.is_file()},
                         {"remote-baseline-manifest.json", "supabase/config.toml", *{f"supabase/migrations/{p.name}" for p in self.sources[:20]}})
        actual = tomllib.loads((self.output / "supabase/config.toml").read_text())
        expected = tomllib.loads(original[self.config].decode())
        expected["project_id"] = baseline.PROJECT
        expected["db"]["shadow_port"] = 56530
        expected["edge_runtime"]["enabled"] = False
        del expected["functions"]
        for section, port in baseline.PORTS.items():
            target = expected
            for component in section.split("."):
                target = target[component]
            target["port"] = port
        self.assertEqual(actual, expected)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)
        self.assertEqual({p: p.read_bytes() for p in original}, original)
        self.assertEqual(json.loads((self.output / "remote-baseline-manifest.json").read_text()), report)

    def commit_additional(self, paths=None):
        paths = list(self.additional) if paths is None else list(paths)
        for path in paths:
            (self.repo / path).write_bytes(self.additional[path])
        self.git("add", *(str(path) for path in paths))
        self.git("-c", "user.name=Baseline fixture", "-c", "user.email=baseline@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "synthetic shared migrations")

    def test_shared_forty_one_head_prepares_identical_remote_twenty(self):
        before = self.prepare()
        prepared = {path.relative_to(self.output): path.read_bytes()
                    for path in (self.output / "supabase").rglob("*") if path.is_file()}
        self.commit_additional()
        self.output = self.base / "shared-execution"
        after = self.prepare()
        self.assertEqual((after["count"], after["canonical_count"]), (20, 41))
        self.assertEqual(after["migrations"], before["migrations"])
        self.assertEqual(after["pending"], [])
        self.assertEqual(len(after["source_migrations"]), 41)
        self.assertEqual(prepared, {path.relative_to(self.output): path.read_bytes()
                                   for path in (self.output / "supabase").rglob("*") if path.is_file()})
        self.assertEqual(before["versions_sha256"], after["versions_sha256"])
        self.assertEqual(before["config_sha256"], after["config_sha256"])
        self.assertNotEqual(before["source_head"], after["source_head"])

    def test_partial_shared_history_is_rejected(self):
        self.commit_additional(edge.GATEWAY_PENDING[:1])
        with self.assertRaises(baseline.PreparationError):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed_unselected_sql_tampering_is_rejected(self):
        self.commit_additional()
        path = self.repo / edge.GATEWAY_PENDING[0]
        path.write_bytes(path.read_bytes() + b"-- changed reviewed source\n")
        self.git("add", str(edge.GATEWAY_PENDING[0]))
        self.git("-c", "user.name=Baseline fixture", "-c", "user.email=baseline@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "synthetic tampered source")
        with self.assertRaisesRegex(baseline.PreparationError, "검토된 해시"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_same_count_unreviewed_filename_is_rejected(self):
        self.commit_additional()
        path = edge.GATEWAY_PENDING[0]
        replacement = path.with_name("20260929100000_unreviewed.sql")
        self.git("mv", str(path), str(replacement))
        self.git("-c", "user.name=Baseline fixture", "-c", "user.email=baseline@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "synthetic replacement")
        with self.assertRaises(baseline.PreparationError):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_missing_malformed_or_duplicate_versions_rejected(self):
        for value in [self.versions[:19], [*self.versions[:19], self.versions[0]],
                      {"versions": self.versions}, [*self.versions[:19], 20260101000020]]:
            with self.subTest(shape=type(value).__name__):
                self.write_versions(value)
                with self.assertRaises(baseline.PreparationError):
                    self.prepare()
                self.assertFalse(self.output.exists())
        self.version_file.unlink()
        with self.assertRaises(OSError):
            self.prepare()

    def test_foreign_or_untracked_versions_never_selected(self):
        (self.sql / "20261003090000_completion_runner_role.sql").write_text("select 99;")
        for value in ["20261003090000", "20990101000000"]:
            self.write_versions([*self.versions[:19], value])
            with self.assertRaises(baseline.PreparationError):
                self.prepare()
            self.assertFalse(self.output.exists())

    def test_changed_head_sql_or_non_twenty_eight_head_rejected(self):
        self.sources[27].write_text("select 'changed unselected source';")
        with self.assertRaises(baseline.PreparationError):
            self.prepare()
        self.assertFalse(self.output.exists())
        self.git("checkout", "--", ".")
        self.git("rm", str(self.sources[27].relative_to(self.repo)))
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "remove fixture")
        with self.assertRaises(baseline.PreparationError):
            self.prepare()

    def test_symlinks_existing_output_and_unsafe_paths_rejected(self):
        link = self.base / "linked.json"
        link.symlink_to(self.version_file)
        with self.assertRaises(baseline.PreparationError):
            baseline.prepare_remote_baseline(self.repo, link, self.output)
        for destination in [Path("relative"), self.repo / "output", self.base]:
            with self.subTest(destination=str(destination)):
                with self.assertRaises(baseline.PreparationError):
                    baseline.prepare_remote_baseline(self.repo, self.version_file, destination)
        self.version_file.chmod(0o644)
        with self.assertRaises(baseline.PreparationError):
            self.prepare()

    def test_config_overlay_refuses_other_project_and_extra_functions(self):
        original = self.config.read_text()
        for text in [original.replace('project_id = "yumidang-minkyu-db"', 'project_id = "foreign"'),
                     original + "\n[functions.unreviewed]\nverify_jwt = false\n"]:
            self.config.write_text(text)
            with self.assertRaises(baseline.PreparationError):
                self.prepare()
            self.assertFalse(self.output.exists())

    def test_changes_during_copy_leave_no_ready_output(self):
        real_inspect = baseline.inspect_migrations
        calls = 0

        def mutate(repo):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.git("checkout", "-qb", "changed-during-copy")
            return real_inspect(repo)

        with patch.object(baseline, "inspect_migrations", side_effect=mutate):
            with self.assertRaises(baseline.PreparationError):
                self.prepare()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
