"""명시적인 새 합성 DB 계약의 거절·트랜잭션 분리를 검사한다. Docker/DB 실행 없음."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/local"))
sys.path.insert(0, str(Path(__file__).parent))
import run_database_tests as runner
import prepare_database
import prepare_migrations
from test_isolated_database_preparation import CONFIG


class IsolatedRunnerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.repo = self.base / "repo"
        source = self.repo / "backend/supabase/config.toml"
        source.parent.mkdir(parents=True)
        source.write_bytes(CONFIG)
        self.root = self.base / "prepared"
        self.root.mkdir(mode=0o700)
        sql = self.root / "supabase/migrations/20260101000000_fixture.sql"
        sql.parent.mkdir(parents=True)
        sql.write_bytes(b"select 1;\n")
        self.history = {"migrations": [{"path": "backend/supabase/migrations/" + sql.name,
                         "version": "20260101000000", "sha256": hashlib.sha256(sql.read_bytes()).hexdigest()}]}
        config, overlay = prepare_database.isolated_config(CONFIG, "jonghyun-backend100-abcdef12", 61621)
        (self.root / "supabase/config.toml").write_bytes(config)
        self.manifest = {"migrations": self.history["migrations"], "config_overlay": overlay,
                         "source_config_sha256": hashlib.sha256(CONFIG).hexdigest(),
                         "config_sha256": hashlib.sha256(config).hexdigest(), "sql_execution": "NOT_RUN"}
        self.intent = {"project": overlay["project_id"], "context": "colima-jonghyun-backend100",
                       "dockerHost": "unix://" + str(Path.home() / ".colima/jonghyun-backend100/docker.sock"),
                       "scope": "new-synthetic-only", "existingContainers": [], "existingNetworks": []}
        self.owned = [{"name": "supabase_db_" + overlay["project_id"], "id": "a" * 64, "image": "sha256:" + "b" * 64}]
        self.write_inputs()
        mocked = patch.object(runner, "ROOT", self.repo)
        mocked.start();self.addCleanup(mocked.stop)
        mocked = patch.object(prepare_migrations, "inspect_migrations", return_value=self.history)
        mocked.start();self.addCleanup(mocked.stop)

    def write_inputs(self):
        for name, value in [("database-manifest.json", self.manifest), ("execution-intent.json", self.intent),
                            ("owned-containers.json", self.owned)]:
            (self.root / name).write_text(json.dumps(value))

    def test_valid_contract_yields_only_exact_owned_target_without_processes(self):
        with patch.object(runner.subprocess, "run", side_effect=AssertionError("process called")):
            target = runner.isolated_prepared_target(self.root)
        self.assertEqual(target["id"], "a" * 64)
        self.assertEqual(target["container"], self.owned[0]["name"])
        self.assertEqual(target["context"], "colima-jonghyun-backend100")

    def test_wrong_socket_context_project_and_existing_scope_are_rejected(self):
        changes = [("dockerHost", "tcp://remote:2376"), ("context", "colima-yumidang-minkyu"),
                   ("project", "production"), ("existingContainers", ["protected"]), ("scope", "production")]
        for key, value in changes:
            with self.subTest(key=key):
                original = self.intent[key];self.intent[key] = value;self.write_inputs()
                with self.assertRaises(ValueError):runner.isolated_prepared_target(self.root)
                self.intent[key] = original

    def test_sql_config_and_unexpected_file_changes_are_rejected(self):
        sql = next((self.root / "supabase/migrations").iterdir())
        sql.write_bytes(b"select 2;\n")
        with self.assertRaises(ValueError):runner.isolated_prepared_target(self.root)
        sql.write_bytes(b"select 1;\n")
        extra = sql.parent / "unreviewed.sql";extra.write_text("select 3;")
        with self.assertRaises(ValueError):runner.isolated_prepared_target(self.root)
        extra.unlink()
        config = self.root / "supabase/config.toml"
        config.write_bytes(config.read_bytes().replace(b"enable_signup = false", b"enable_signup = true"))
        with self.assertRaises(ValueError):runner.isolated_prepared_target(self.root)

    def test_symlink_manifest_and_unprotected_directory_are_rejected(self):
        path = self.root / "database-manifest.json"
        data = path.read_bytes();path.unlink()
        outside = self.base / "other.json";outside.write_bytes(data);path.symlink_to(outside)
        with self.assertRaises(ValueError):runner.isolated_prepared_target(self.root)
        path.unlink();path.write_bytes(data)
        self.root.chmod(0o755)
        with self.assertRaises(ValueError):runner.isolated_prepared_target(self.root)

    def test_wrong_or_ambiguous_owned_db_is_rejected(self):
        for value in [[], [dict(self.owned[0], id="abc")], self.owned + self.owned]:
            self.owned = value;self.write_inputs()
            with self.assertRaises(ValueError):runner.isolated_prepared_target(self.root)

    def test_budget_and_scopes_have_independent_transactions_and_identical_helper(self):
        helper = "create function pg_temp.pool_failure(x text) returns void language plpgsql as $$begin null;end;$$;"
        payload = {"ai_atomic_requests.sql": "begin;select 'atomic';rollback;",
                   "ai_account_budget.sql": helper + "\nselect 'budget-fixture';",
                   "ai_account_scopes.sql": "select pg_temp.pool_failure('scope-fixture');",
                   "current_summary_fences.sql": "begin;select 'summary';rollback;"}
        cases = dict(runner.current_ai_cases(payload))
        self.assertEqual(len(cases), 4)
        self.assertIn(helper, cases["ai_account_scopes"])
        self.assertNotIn("budget-fixture", cases["ai_account_scopes"])
        for name in ["ai_account_budget", "ai_account_scopes"]:
            self.assertTrue(cases[name].startswith("begin;"))
            self.assertTrue(cases[name].endswith("rollback;"))
        payload["ai_account_budget.sql"] = "select 'missing-helper';"
        with self.assertRaises(ValueError):runner.current_ai_cases(payload)

    def test_failure_diagnostics_expose_only_state_and_bounded_stdin_line(self):
        raw = "psql:<stdin>:90: ERROR:  42501\nCONTEXT: SECRET_BODY token=SECRET_TOKEN"
        error = runner.isolated_command_error(raw)
        self.assertEqual(str(error), "SQLSTATE_42501")
        self.assertEqual(error.execution_line, 90)
        self.assertNotIn("SECRET", str(error))
        for raw in ["SECRET_TOKEN", "psql:/private/SECRET:90: ERROR: 42501",
                    "psql:<stdin>:1000000: ERROR: 42501", "psql:<stdin>:0: ERROR: 42501"]:
            with self.subTest(raw=raw):
                error = runner.isolated_command_error(raw)
                self.assertIsNone(error.execution_line)
                self.assertNotIn("SECRET", str(error))


if __name__ == "__main__":
    unittest.main()
