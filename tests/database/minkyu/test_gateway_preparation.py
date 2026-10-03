"""합성 Git 자료만 사용해 명시적 게이트웨이 준비 모드의 범위·원본 보존을 검증한다."""

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
import prepare_edge as edge


class GatewayPreparationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir="/private/tmp")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.repo = self.base / "repo"
        self.repo.mkdir()
        self.functions = self.repo / edge.FUNCTIONS
        self.entry = self.repo / edge.ENTRYPOINT
        self.shared = self.functions / "_shared/config/env.ts"
        self.entry.parent.mkdir(parents=True)
        self.shared.parent.mkdir(parents=True)
        self.entry.write_text('import { value } from "../_shared/config/env.ts";\nexport default value;\n')
        self.shared.write_text("export const value = 1;\n")
        (self.functions / "deno.json").write_text('{"compilerOptions":{"strict":true}}')
        self.config = self.repo / "backend/supabase/config.toml"
        self.config.write_text('''project_id = "yumidang-minkyu-db"
[api]
port = 55421
max_rows = 1000
[db]
port = 55422
shadow_port = 55420
major_version = 17
[db.pooler]
enabled = false
port = 55429
[studio]
enabled = false
port = 55423
[local_smtp]
enabled = true
port = 55424
[analytics]
enabled = false
port = 55427
[auth]
enable_signup = false
site_url = "http://127.0.0.1:5173"
[storage]
enabled = true
[edge_runtime]
enabled = false
''' + "".join(f"[functions.{name}]\nverify_jwt = false\n" for name in sorted(edge.GATEWAY_FUNCTIONS)))
        self.sql_dir = self.repo / "backend/supabase/migrations"
        self.sql_dir.mkdir()
        self.canonical = []
        for index in range(1, 29):
            path = self.sql_dir / f"2026010100{index:04d}_fixture.sql"
            path.write_text(f"select {index};\n")
            self.canonical.append(path)
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Gateway fixture", "-c", "user.email=gateway@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
        for index, path in enumerate(edge.GATEWAY_PENDING, 100):
            (self.repo / path).write_text(f"begin; select {index}; commit;\n")
        # 검토 해시는 합성 Git 원본에만 맞춘다. 실제 저장소의 승인 목록을 바꾸지 않는다.
        reviewed = {str(path.relative_to(self.repo)): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in (*self.canonical, *(self.repo / path for path in edge.GATEWAY_PENDING))}
        self.reviewed_patch = patch.object(edge, "GATEWAY_REVIEWED_MIGRATIONS", reviewed)
        self.reviewed_patch.start()
        self.addCleanup(self.reviewed_patch.stop)
        self.output = self.base / "execution"

    def git(self, *args):
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
        return subprocess.run(["git", "-C", str(self.repo), *args], env=env,
                              capture_output=True, check=True, timeout=10)

    def prepare(self):
        return edge.prepare_edge(self.repo, self.output, gateway_probe=True)

    def test_default_strict_mode_still_rejects_seven_functions(self):
        with self.assertRaisesRegex(edge.PreparationError, "다른 함수"):
            edge.prepare_edge(self.repo, self.output)
        self.assertFalse(self.output.exists())

    def test_fixed_overlay_preserves_all_other_semantics_and_originals(self):
        original = tomllib.loads(self.config.read_text())
        selected = [self.config, self.entry, self.shared, *self.canonical,
                    *(self.repo / path for path in edge.GATEWAY_PENDING)]
        before = {str(path): path.read_bytes() for path in selected}
        report = self.prepare()
        self.assertEqual((self.output.stat().st_mode & 0o777), 0o700)
        self.assertEqual(report["mode"], "gateway_probe")
        self.assertEqual(report["migration_count"], 41)
        self.assertEqual(report["canonical_count"], 28)
        self.assertEqual(report["pending_count"], 13)
        self.assertEqual(report["sql_execution"], "NOT_RUN")
        self.assertEqual(report["edge_execution"], "NOT_RUN")
        self.assertEqual(report["functions"], ["service-api"])
        final_bytes = (self.output / "supabase/config.toml").read_bytes()
        actual = tomllib.loads(final_bytes.decode())
        self.assertEqual(actual["project_id"], edge.GATEWAY_PROJECT)
        self.assertTrue(actual["edge_runtime"]["enabled"])
        self.assertEqual(actual["functions"], {"service-api": {"verify_jwt": False}})
        for section, port in edge.GATEWAY_PORTS.items():
            value = actual
            original_value = original
            for component in section.split("."):
                value = value[component]
                original_value = original_value[component]
            self.assertEqual(value["port"], port)
            value["port"] = original_value["port"]
        self.assertEqual(actual["db"]["shadow_port"], 56520)
        actual["db"]["shadow_port"] = original["db"]["shadow_port"]
        actual["project_id"] = original["project_id"]
        actual["edge_runtime"]["enabled"] = original["edge_runtime"]["enabled"]
        actual["functions"] = original["functions"]
        self.assertEqual(actual, original)
        self.assertEqual(report["config_sha256"], hashlib.sha256(final_bytes).hexdigest())
        self.assertEqual(report["source_config_sha256"], hashlib.sha256(self.config.read_bytes()).hexdigest())
        self.assertEqual(before, {str(path): path.read_bytes() for path in selected})
        self.assertEqual(json.loads((self.output / "edge-manifest.json").read_text()), report)

    def test_exact_pending_and_hashes_exclude_copies_unreviewed_sql_and_environment(self):
        for relative in ("signup/index.ts", "service-api/.env", "service-api/key.pem", "_shared/unused.ts"):
            path = self.functions / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("SECRET_NOT_SELECTED")
        (self.sql_dir / "20260929100000_event_storage 2.sql").write_text("SECRET_NOT_SELECTED")
        (self.sql_dir / "20261002150000_not_selected.sql").write_text("SECRET_NOT_SELECTED")
        report = self.prepare()
        database = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual(database["count"], 28)
        self.assertEqual(database["total_count"], 41)
        self.assertEqual([entry["path"] for entry in database["pending"]], [str(path) for path in edge.GATEWAY_PENDING])
        self.assertEqual(database["config_sha256"], report["source_config_sha256"])
        self.assertTrue(any(name.endswith(" 2.sql") for name in database["excluded"]))
        self.assertFalse(set(str(path) for path in edge.GATEWAY_PENDING) & set(database["excluded"]))
        for entry in database["migrations"] + database["pending"]:
            original = (self.repo / entry["path"]).read_bytes()
            copied = (self.output / "supabase/migrations" / Path(entry["path"]).name).read_bytes()
            self.assertEqual(original, copied)
            self.assertEqual(entry["sha256"], hashlib.sha256(copied).hexdigest())
        for entry in report["source_files"]:
            copied = (self.output / entry["target"]).read_bytes()
            self.assertEqual(copied, (self.repo / entry["path"]).read_bytes())
            self.assertEqual(entry["sha256"], hashlib.sha256(copied).hexdigest())
        self.assertEqual(len(list((self.output / "supabase/migrations").glob("*.sql"))), 41)
        self.assertFalse(any(b"SECRET_NOT_SELECTED" in path.read_bytes() for path in self.output.rglob("*") if path.is_file()))

    def commit_selected(self, paths=None):
        self.git("add", *(str(path) for path in (edge.GATEWAY_PENDING if paths is None else paths)))
        self.git("-c", "user.name=Gateway fixture", "-c", "user.email=gateway@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "synthetic shared migrations")

    def test_committing_all_reviewed_migrations_preserves_exact_prepared_payloads(self):
        before = self.prepare()
        prepared = {path.name: path.read_bytes()
                    for path in (self.output / "supabase/migrations").iterdir()}
        self.commit_selected()
        self.output = self.base / "after-commit"
        after = self.prepare()
        database = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual(before["migration_count"], after["migration_count"])
        self.assertEqual((after["canonical_count"], after["pending_count"], after["migration_count"]), (41, 0, 41))
        self.assertEqual(database["count"], 41)
        self.assertEqual(database["pending"], [])
        self.assertEqual(len({entry["version"] for entry in database["migrations"]}), 41)
        self.assertEqual(len({entry["sha256"] for entry in database["migrations"]}), 41)
        self.assertEqual(prepared, {path.name: path.read_bytes()
                                  for path in (self.output / "supabase/migrations").iterdir()})
        self.assertNotEqual(before["source_head"], after["source_head"])
        self.assertEqual(before["source_files"], after["source_files"])
        self.assertEqual(before["config_sha256"], after["config_sha256"])

    def test_partial_commit_is_not_supported(self):
        self.commit_selected(edge.GATEWAY_PENDING[:1])
        with self.assertRaises(edge.PreparationError):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_same_count_with_unreviewed_canonical_file_is_rejected(self):
        selected = edge.GATEWAY_PENDING[0]
        replacement = selected.with_name("20260929100000_unreviewed.sql")
        (self.repo / selected).rename(self.repo / replacement)
        self.commit_selected((*edge.GATEWAY_PENDING[1:], replacement))
        with self.assertRaises(edge.PreparationError):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_committed_selected_or_baseline_content_changes_are_rejected(self):
        self.commit_selected()
        for path in (self.repo / edge.GATEWAY_PENDING[0], self.canonical[0]):
            with self.subTest(path=path):
                original = path.read_bytes()
                path.write_bytes(original + b"-- changed reviewed content\n")
                self.commit_selected((path.relative_to(self.repo),))
                with self.assertRaisesRegex(edge.PreparationError, "검토된 해시"):
                    self.prepare()
                self.assertFalse(self.output.exists())
                path.write_bytes(original)
                self.commit_selected((path.relative_to(self.repo),))

    def test_uncommitted_selected_content_change_is_rejected(self):
        selected = self.repo / edge.GATEWAY_PENDING[0]
        selected.write_bytes(selected.read_bytes() + b"-- changed reviewed content\n")
        with self.assertRaisesRegex(edge.PreparationError, "검토된 해시"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_wrong_project_function_claims_extra_options_and_port_types_rejected(self):
        original = self.config.read_text()
        variants = (original.replace("yumidang-minkyu-db", "other"),
                    original.replace("verify_jwt = false", "verify_jwt = true", 1),
                    original + "\n[functions.other]\nverify_jwt = false\n",
                    original.replace("[functions.service-api]\n", "[functions.service-api]\nenabled = true\n"),
                    original.replace("port = 55421", "port = true"),
                    original.replace("shadow_port = 55420\n", ""))
        for value in variants:
            with self.subTest(config=value):
                self.config.write_text(value)
                with self.assertRaises(edge.PreparationError):
                    self.prepare()
                self.assertFalse(self.output.exists())

    def test_external_dynamic_and_environment_imports_rejected_before_output(self):
        for source in ('import "https://example.invalid/a.ts";', 'import "node:fs";',
                       'const value = import("./x.ts");', 'import "./.env";',
                       'import "../signup/index.ts";', 'import "../../../outside.ts";'):
            with self.subTest(source=source):
                self.entry.write_text(source)
                with self.assertRaises(edge.PreparationError):
                    self.prepare()
                self.assertFalse(self.output.exists())

    def test_missing_or_duplicate_pending_rejected_before_output(self):
        selected = self.repo / edge.GATEWAY_PENDING[0]
        selected.unlink()
        with self.assertRaises(edge.PreparationError):
            self.prepare()
        self.assertFalse(self.output.exists())
        selected.write_bytes(self.canonical[0].read_bytes())
        with self.assertRaisesRegex(edge.PreparationError, "중복"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_pending_and_source_symlinks_rejected(self):
        for target in (self.shared, self.repo / edge.GATEWAY_PENDING[0]):
            with self.subTest(path=target):
                data = target.read_bytes()
                real = self.base / "outside"
                real.write_bytes(data)
                target.unlink(); target.symlink_to(real)
                with self.assertRaisesRegex(edge.PreparationError, "심볼릭"):
                    self.prepare()
                self.assertFalse(self.output.exists())
                target.unlink(); target.write_bytes(data)

    def test_changed_head_sql_rejected_before_output(self):
        self.canonical[0].write_text("select 999;\n")
        with self.assertRaisesRegex(edge.PreparationError, "커밋 이력과 다른"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_wrong_baseline_count_rejected(self):
        self.canonical[0].unlink()
        self.git("add", "-u")
        self.git("-c", "user.name=Gateway fixture", "-c", "user.email=gateway@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "fixture count")
        with self.assertRaisesRegex(edge.PreparationError, "28개"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_output_overlap_reuse_and_symlink_rejected(self):
        self.output.mkdir()
        marker = self.output / "keep"
        marker.write_text("keep")
        with self.assertRaises(edge.PreparationError):
            self.prepare()
        self.assertEqual(marker.read_text(), "keep")
        for output in (self.repo / "execution", Path("relative"), Path(tempfile.gettempdir()),
                       Path("/private/var/folders/yumidang-gateway-unshared/output")):
            with self.subTest(path=output), self.assertRaises(edge.PreparationError):
                edge.prepare_edge(self.repo, output, gateway_probe=True)
        alias = self.base / "alias"
        alias.symlink_to(self.repo, target_is_directory=True)
        with self.assertRaisesRegex(edge.PreparationError, "심볼릭"):
            edge.prepare_edge(self.repo, alias / "execution", gateway_probe=True)

    def test_final_source_config_and_pending_changes_cannot_emit_ready_manifest(self):
        original_prepare = edge.prepare_gateway_database
        targets = (self.entry, self.config, self.repo / edge.GATEWAY_PENDING[0])
        for index, target in enumerate(targets):
            with self.subTest(path=target):
                original = target.read_bytes()
                output = self.base / f"changed-{index}"
                def changed(repo, destination):
                    result = original_prepare(repo, destination)
                    target.write_bytes(original + b"\n# changed\n" if target == self.config else original + b"\n// changed\n")
                    return result
                with patch.object(edge, "prepare_gateway_database", side_effect=changed):
                    with self.assertRaisesRegex(edge.PreparationError, "준비 중"):
                        edge.prepare_edge(self.repo, output, gateway_probe=True)
                self.assertFalse((output / "edge-manifest.json").exists())
                target.write_bytes(original)


if __name__ == "__main__":
    unittest.main()
