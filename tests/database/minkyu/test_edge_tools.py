"""임시 Git 자료로 Edge 준비의 범위·원본 보존·검증 상태를 확인한다."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/local"))
from prepare_edge import PreparationError, prepare_edge


class EdgePreparationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.repo = self.base / "repo"
        self.repo.mkdir()
        self.functions = self.repo / "backend/supabase/functions"
        self.entry = self.functions / "service-api/index.ts"
        self.entry.parent.mkdir(parents=True)
        self.shared = self.functions / "_shared/config/env.ts"
        self.shared.parent.mkdir(parents=True)
        self.shared.write_text("export const value = 1;\n")
        self.entry.write_text('import { value } from "../_shared/config/env.ts";\nexport default value;\n')
        (self.functions / "deno.json").write_text('{"tasks":{"check":"deno check service-api/index.ts"}}')
        self.config = self.repo / "backend/supabase/config.toml"
        self.config.write_text('project_id = "yumidang-minkyu-db"\n[edge_runtime]\nenabled = false\n[functions.service-api]\nverify_jwt = false\n')
        self.sql = self.repo / "backend/supabase/migrations/20260929000000_first.sql"
        self.sql.parent.mkdir()
        self.sql.write_text("select 1;\n")
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Edge fixture", "-c", "user.email=edge@example.invalid", "commit", "-qm", "fixture")
        self.output = self.base / "execution"

    def git(self, *args):
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
        return subprocess.run(["git", "-C", str(self.repo), *args], env=env, capture_output=True, check=True, timeout=10)

    def prepare(self):
        return prepare_edge(self.repo, self.output)

    def test_snapshot_hashes_current_source_and_only_enables_edge(self):
        self.shared.write_text("export const value = 2; // reviewed uncommitted source\n")
        before = {p: p.read_bytes() for p in (self.config, self.entry, self.shared, self.sql)}
        report = self.prepare()
        self.assertEqual(report["source_mode"], "working_tree_snapshot")
        self.assertEqual(report["migration_count"], 1)
        self.assertEqual(report["functions"], ["service-api"])
        self.assertEqual(report["edge_execution"], "NOT_RUN")
        self.assertEqual(report["sql_execution"], "NOT_RUN")
        self.assertEqual(len(report["source_files"]), 3)
        for entry in report["source_files"]:
            expected = (self.repo / entry["path"]).read_bytes()
            self.assertEqual(expected, (self.output / entry["target"]).read_bytes())
            self.assertEqual(entry["sha256"], hashlib.sha256(expected).hexdigest())
        final_config = (self.output / "supabase/config.toml").read_bytes()
        self.assertTrue(tomllib.loads(final_config.decode())["edge_runtime"]["enabled"])
        self.assertFalse(tomllib.loads(final_config.decode())["functions"]["service-api"]["verify_jwt"])
        self.assertEqual(report["config_sha256"], hashlib.sha256(final_config).hexdigest())
        self.assertNotEqual(report["config_sha256"], report["source_config_sha256"])
        database = json.loads((self.output / "database-manifest.json").read_text())
        self.assertEqual(database["config_sha256"], report["source_config_sha256"])
        self.assertEqual(report, json.loads((self.output / "edge-manifest.json").read_text()))
        self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_unneeded_functions_hidden_keys_copies_and_sql_copies_are_excluded(self):
        for name in ("other/index.ts", "_shared/unused.ts", "service-api/.env", "service-api/key.pem", "service-api/index 2.ts", "service-api/.hidden.ts"):
            path = self.functions / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("SECRET_SHOULD_NOT_COPY")
        (self.sql.parent / "20260929000000_first 2.sql").write_text("copy")
        report = self.prepare()
        copied = list((self.output / "supabase/functions").rglob("*"))
        self.assertEqual({p.relative_to(self.output / "supabase/functions").parts[0] for p in copied}, {"service-api", "_shared", "deno.json"})
        self.assertNotIn("SECRET_SHOULD_NOT_COPY", json.dumps(report))
        self.assertFalse(any("SECRET_SHOULD_NOT_COPY" in p.read_text() for p in copied if p.is_file()))
        self.assertEqual(len(list((self.output / "supabase/migrations").glob("*.sql"))), 1)

    def test_multiline_reexport_and_cycles_are_supported(self):
        self.entry.write_text('export {\n value\n} from "../_shared/config/env.ts";\n')
        self.shared.write_text('import "../../service-api/index.ts"; export const value = 1;\n')
        self.assertEqual(len(self.prepare()["source_files"]), 3)

    def test_external_dynamic_outside_and_non_source_imports_rejected(self):
        for source in ('import "https://example.invalid/a.ts";', 'const value = import("./other.ts");',
                       'import "../../../outside.ts";', 'import "./.hidden.ts";',
                       'import "./key.pem";', 'import "./index 2.ts";', 'import "../other/index.ts";'):
            with self.subTest(source=source):
                self.entry.write_text(source)
                with self.assertRaises(PreparationError):
                    self.prepare()
                self.assertFalse(self.output.exists())

    def test_source_file_symlink_rejected(self):
        real = self.base / "real.ts"
        real.write_text("export const value = 1;")
        self.shared.unlink()
        self.shared.symlink_to(real)
        with self.assertRaisesRegex(PreparationError, "심볼릭"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_source_directory_symlink_rejected_even_inside_repo(self):
        actual = self.functions / "actual"
        self.shared.parent.rename(actual)
        self.shared.parent.symlink_to(actual, target_is_directory=True)
        with self.assertRaisesRegex(PreparationError, "심볼릭"):
            self.prepare()

    def test_wrong_project_gateway_setting_and_additional_function_rejected(self):
        original = self.config.read_text()
        for value in (original.replace("yumidang-minkyu-db", "other"), original.replace("verify_jwt = false", "verify_jwt = true"), original + "\n[functions.other]\nverify_jwt = false\n"):
            with self.subTest(config=value):
                self.config.write_text(value)
                with self.assertRaises(PreparationError):
                    self.prepare()
                self.assertFalse(self.output.exists())

    def test_external_deno_config_rejected(self):
        (self.functions / "deno.json").write_text('{"imports":{"x":"https://example.invalid/x.ts"}}')
        with self.assertRaises(PreparationError):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_changed_canonical_sql_rejected(self):
        self.sql.write_text("select 2;")
        with self.assertRaisesRegex(PreparationError, "커밋 이력과 다른"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_output_reuse_overlap_and_symlink_rejected_without_overwrite(self):
        self.output.mkdir()
        marker = self.output / "keep"
        marker.write_text("keep")
        with self.assertRaisesRegex(PreparationError, "비어 있지"):
            self.prepare()
        self.assertEqual(marker.read_text(), "keep")
        for path in (self.repo / "output", Path("relative")):
            with self.subTest(path=path), self.assertRaises(PreparationError):
                prepare_edge(self.repo, path)
        alias = self.base / "alias"
        alias.symlink_to(self.repo, target_is_directory=True)
        with self.assertRaisesRegex(PreparationError, "심볼릭"):
            prepare_edge(self.repo, alias / "output")


if __name__ == "__main__":
    unittest.main()
