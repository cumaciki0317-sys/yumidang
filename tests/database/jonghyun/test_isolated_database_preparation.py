"""새 합성 환경의 설정 격리·SQL 보존을 검증한다. VM/DB/네트워크 실행 없음."""
import copy
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
from prepare_database import PreparationError, prepare_database

CONFIG = b'''project_id = "original-fixture"
[api]
port = 54321
schemas = ["public"]
[db]
port = 54322
shadow_port = 54320
major_version = 17
[db.pooler]
enabled = false
port = 54329
[db.seed]
enabled = false
[studio]
enabled = false
port = 54323
[local_smtp]
enabled = true
port = 54324
[analytics]
enabled = false
port = 54327
[auth]
enable_signup = false
[edge_runtime]
enabled = false
[functions.service-api]
verify_jwt = false
[functions.ai-chat]
verify_jwt = false
'''


class IsolatedPreparationTests(unittest.TestCase):
    def setUp(self):
        environment = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        isolated = patch.dict(os.environ, environment, clear=True)
        isolated.start()
        self.addCleanup(isolated.stop)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "repo"
        self.sql = self.repo / "backend/supabase/migrations/20260101000000_fixture.sql"
        self.sql.parent.mkdir(parents=True)
        self.sql.write_bytes(b"select 1;\n")
        self.config = self.repo / "backend/supabase/config.toml"
        self.config.write_bytes(CONFIG)
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Synthetic preparation", "-c", "user.email=fixture@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
        self.output = self.root / "output"

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.DEVNULL)

    def test_overlay_keeps_all_policy_and_function_settings_and_records_both_hashes(self):
        report = prepare_database(self.repo, self.output, project_id="jonghyun-backend100-abcdef12", port_base=61621)
        rendered = (self.output / "supabase/config.toml").read_bytes()
        actual = tomllib.loads(rendered.decode())
        expected = copy.deepcopy(tomllib.loads(CONFIG.decode()))
        expected["project_id"] = "jonghyun-backend100-abcdef12"
        for section, port in [("api", 61621), ("db", 61622), ("studio", 61623),
                              ("local_smtp", 61624), ("analytics", 61627)]:
            expected[section]["port"] = port
        expected["db"]["shadow_port"] = 61620
        expected["db"]["pooler"]["port"] = 61629
        self.assertEqual(actual, expected)
        self.assertEqual(report["source_config_sha256"], hashlib.sha256(CONFIG).hexdigest())
        self.assertEqual(report["config_sha256"], hashlib.sha256(rendered).hexdigest())
        self.assertEqual(report["sql_execution"], "NOT_RUN")
        self.assertEqual(report["runtime_readiness"], "NOT_VERIFIED")
        self.assertEqual(report["port_availability"], "NOT_VERIFIED")
        self.assertEqual(json.loads((self.output / "database-manifest.json").read_text()), report)
        self.assertEqual(self.config.read_bytes(), CONFIG)
        self.assertEqual((self.output / "supabase/migrations" / self.sql.name).read_bytes(), self.sql.read_bytes())
        self.assertEqual(self.git("status", "--porcelain"), b"")

    def test_default_behavior_retains_original_bytes_and_manifest(self):
        report = prepare_database(self.repo, self.output)
        self.assertEqual((self.output / "supabase/config.toml").read_bytes(), CONFIG)
        self.assertNotIn("config_overlay", report)
        self.assertNotIn("source_config_sha256", report)

    def test_shared_remote_or_ambiguous_project_names_are_rejected_before_copy(self):
        for project in ["original-fixture", "yumidang-minkyu-gateway", "production", "jonghyun-backend100/other",
                        "jonghyun-backend100-123", "jonghyun-backend100-ABCDEF12"]:
            with self.subTest(project=project), self.assertRaises(PreparationError):
                prepare_database(self.repo, self.output, project_id=project, port_base=61621)
            self.assertFalse(self.output.exists())

    def test_partial_or_invalid_port_configuration_is_rejected_before_copy(self):
        cases = [(None, 61621), ("jonghyun-backend100", None)]
        cases += [("jonghyun-backend100", p) for p in [True, "61621", 1024, 65528, -1]]
        for project, port in cases:
            with self.subTest(project=project, port=port), self.assertRaises(PreparationError):
                prepare_database(self.repo, self.output, project_id=project, port_base=port)
            self.assertFalse(self.output.exists())

    def test_missing_overlay_key_or_same_project_is_rejected_before_copy(self):
        for data in [CONFIG.replace(b"shadow_port = 54320\n", b""),
                     CONFIG.replace(b'"original-fixture"', b'"jonghyun-backend100"')]:
            self.config.write_bytes(data)
            with self.assertRaises(PreparationError):
                prepare_database(self.repo, self.output, project_id="jonghyun-backend100", port_base=61621)
            self.assertFalse(self.output.exists())

    def test_changed_sql_is_still_rejected_and_existing_output_is_preserved(self):
        self.sql.write_bytes(b"select 2;\n")
        with self.assertRaises(PreparationError):
            prepare_database(self.repo, self.output, project_id="jonghyun-backend100", port_base=61621)
        self.assertFalse(self.output.exists())
        self.sql.write_bytes(b"select 1;\n")
        self.output.mkdir()
        marker = self.output / "protected"
        marker.write_bytes(b"existing")
        with self.assertRaises(PreparationError):
            prepare_database(self.repo, self.output, project_id="jonghyun-backend100", port_base=61621)
        self.assertEqual(marker.read_bytes(), b"existing")


if __name__ == "__main__":
    unittest.main()
