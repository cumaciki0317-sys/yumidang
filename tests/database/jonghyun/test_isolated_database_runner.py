"""명시적인 새 합성 DB 계약의 거절·트랜잭션 분리를 검사한다. Docker/DB 실행 없음."""
import hashlib
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

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

    def test_minkyu_socket_is_explicit_and_cannot_be_mixed_with_other_context(self):
        self.intent['context'] = 'colima-yumidang-minkyu'
        self.intent['dockerHost'] = 'unix://' + str(Path.home() / '.colima/yumidang-minkyu/docker.sock')
        self.write_inputs()
        with patch.object(runner.subprocess, 'run', side_effect=AssertionError('process called')):
            target = runner.isolated_prepared_target(self.root)
        self.assertEqual(target['host'], self.intent['dockerHost'])
        self.assertEqual(target['context'], self.intent['context'])
        self.intent['context'] = 'colima-jonghyun-backend100'
        self.write_inputs()
        with self.assertRaises(ValueError):
            runner.isolated_prepared_target(self.root)

    def test_temporary_root_must_be_canonical_and_all_parents_private(self):
        self.assertEqual(runner.private_temp_root(self.root), self.root)
        with self.assertRaises(ValueError):
            runner.private_temp_root(self.base / 'repo' / '..' / 'prepared')
        with self.assertRaises(ValueError):
            runner.private_temp_root(Path(tempfile.gettempdir()).resolve())
        self.base.chmod(0o755)
        with self.assertRaises(ValueError):
            runner.private_temp_root(self.root)

    @unittest.skipUnless(Path('/private/tmp').is_dir(), 'canonical macOS temporary root unavailable')
    def test_canonical_private_tmp_is_supported_separately_from_os_temp(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp', prefix='guard-root-') as directory:
            root = Path(directory).resolve()
            self.assertEqual(runner.private_temp_root(root), root)

    def test_current_sql_inventory_contains_both_reviewed_rollback_checks(self):
        self.assertEqual(len(runner.CURRENT_AI_FILES), 7)
        for name in ('ai_result_state.sql', 'operator_receipts_retirement.sql'):
            self.assertIn(name, runner.CURRENT_AI_FILES)
            self.assertIn(name, runner.CURRENT_JONGHYUN_SQL)

    def test_sql_error_still_checks_preservation_after_dispatch(self):
        target = {'host': self.intent['dockerHost'], 'context': self.intent['context'],
                  'project': self.intent['project'], 'container': self.owned[0]['name'],
                  'id': self.owned[0]['id'], 'image': self.owned[0]['image'], 'versions': []}
        events = []
        def call(command, **kwargs):
            arguments = command[3:]
            if arguments[:2] == ['context', 'inspect']:
                return SimpleNamespace(returncode=0, stdout=target['host'])
            if arguments[0] == 'inspect':
                return SimpleNamespace(returncode=0, stdout=json.dumps([{
                    'Id': target['id'], 'Image': target['image'], 'Name': '/' + target['container'],
                    'State': {'Running': True}, 'Config': {'Labels': {
                        'com.supabase.cli.project': target['project']}}}]))
            if arguments[0] == 'exec':
                self.assertEqual(arguments[2], target['id'])
                events.append('sql')
                raise RuntimeError('MODEL_SQL_DISPATCH_FAILED')
            raise AssertionError('unexpected command')
        with patch.object(runner, 'isolated_prepared_target', return_value=target), \
                patch.object(runner, 'verify_preserved_resources', side_effect=lambda *args: events.append('guard')), \
                patch.object(runner.subprocess, 'run', side_effect=call), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runner.run_current_ai(self.root), 1)
        self.assertEqual(events, ['guard', 'guard', 'sql', 'guard'])

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

    def test_approved_native_pair_keeps_separate_rollback_payloads_and_rejects_partial_pair(self):
        helper = "create function pg_temp.pool_failure(x text) returns void language plpgsql as $$begin null;end;$$;"
        payload = {"ai_atomic_requests.sql": "begin;select 'atomic';rollback;",
                   "ai_account_budget.sql": helper,
                   "ai_account_scopes.sql": "select pg_temp.pool_failure('scope');",
                   "current_summary_fences.sql": "begin;select 'summary';rollback;"}
        approved = {name: (ROOT / "tests/database/jonghyun" / name).read_text()
                    for name in ("ai_result_state.sql", "operator_receipts_retirement.sql")}
        cases = dict(runner.current_ai_cases({**payload, **approved}))
        for name, statement in approved.items():
            self.assertEqual(cases[name.removesuffix(".sql")], statement)
        for partial in [{"ai_result_state.sql": approved["ai_result_state.sql"]},
                        {"operator_receipts_retirement.sql": approved["operator_receipts_retirement.sql"]},
                        {**approved, "ai_result_state.sql": "begin; select 'no rollback';"}]:
            with self.subTest(partial=list(partial)), self.assertRaises(ValueError):
                runner.current_ai_cases({**payload, **partial})


if __name__ == "__main__":
    unittest.main()
