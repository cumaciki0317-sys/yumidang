"""실제 Docker/DB 없이 행사 임시 적용 runner의 경계·rollback 조립·실패를 검사한다."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/local"))
import run_event_database_tests as runner


def probes():
    return "\n".join("select 'EVENT_CHECK:" + name + "';" for name in sorted(runner.CHECKS))


class EventDatabaseRunnerTests(unittest.TestCase):
    def fixture(self, root):
        for path, text in ((runner.MIGRATION, "begin; create table private.example(id int); commit;"), (runner.TEST, probes())):
            (root / path).parent.mkdir(parents=True, exist_ok=True)
            (root / path).write_text(text)

    def target(self):
        endpoint = "unix://" + str(Path.home() / ".colima/yumidang-minkyu/docker.sock")
        info = [{"Config": {"Labels": {"com.supabase.cli.project": runner.db.PROJECT}}, "State": {"Running": True}}]
        return [subprocess.CompletedProcess([], 0, endpoint, ""), subprocess.CompletedProcess([], 0, json.dumps(info), "")]

    def test_default_never_inspects_or_executes_database(self):
        out = io.StringIO()
        with patch.object(runner, "execute") as execute, contextlib.redirect_stdout(out):
            self.assertEqual(runner.main([]), 2)
        execute.assert_not_called()
        self.assertEqual(json.loads(out.getvalue())["status"], "NOT_RUN")

    def test_only_outer_wrapper_removed_with_sql_quotes_and_comments(self):
        migration = "-- wrapper\nbegin; /* comment; */ create function public.x() returns text language sql as $tag$ select 'commit;'; $tag$; commit;"
        script = runner.build_script(migration, probes())
        words = [statement.lower() for statement in runner.statements(script)]
        self.assertEqual(words.count("begin"), 1)
        self.assertEqual(words.count("rollback"), 1)
        self.assertNotIn("commit", words)
        self.assertIn("select 'commit;';", script)
        self.assertIn("statement_timeout='20s'", script)
        self.assertIn("transaction_timeout='60s'", script)
        self.assertGreater(script.index("EVENT_ROLLBACK_PASS"), script.index("rollback;"))

    def test_nested_transaction_or_psql_escape_is_rejected(self):
        for body in ("commit; select 1;", "rollback;", "start transaction;", "\\i external.sql\n", "select 'unterminated;", "do $$ begin null; end;"):
            with self.subTest(kind=body[:8]):
                with self.assertRaises(ValueError):
                    runner.build_script("begin;" + body + "commit;", probes())
        with self.assertRaises(ValueError):
            runner.build_script("begin; select 1; commit;", "begin;" + probes() + "rollback;")

    def test_symlink_source_rejected_before_target_inspection(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            self.fixture(root)
            (root / runner.MIGRATION).unlink()
            (root / runner.MIGRATION).symlink_to(root / runner.TEST)
            with patch.object(runner.db, "docker") as docker:
                with self.assertRaises(ValueError):
                    runner.execute(root)
                docker.assert_not_called()

    def test_wrong_context_cannot_inspect_container_or_execute_sql(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            self.fixture(root)
            with patch.object(runner.db, "docker", return_value=subprocess.CompletedProcess([], 0, "tcp://remote.invalid:2376", "")) as docker, patch.object(runner.db, "SessionLock") as lock, patch.object(runner.subprocess, "run") as run:
                with self.assertRaises(ValueError):
                    runner.execute(root)
                self.assertEqual(docker.call_count, 1)
                lock.assert_not_called()
                run.assert_not_called()

    def test_wrong_project_cannot_execute_sql(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            self.fixture(root)
            target = self.target()
            target[1].stdout = json.dumps([{"Config": {"Labels": {"com.supabase.cli.project": "someone-else"}}, "State": {"Running": True}}])
            with patch.object(runner.db, "docker", side_effect=target), patch.object(runner.db, "SessionLock") as lock, patch.object(runner.subprocess, "run") as run:
                with self.assertRaises(ValueError):
                    runner.execute(root)
                lock.assert_not_called()
                run.assert_not_called()

    def test_success_requires_all_checks_and_post_rollback_marker(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            self.fixture(root)
            full = "\n".join("EVENT_CHECK:" + name for name in sorted(runner.CHECKS)) + "\nEVENT_ROLLBACK_PASS\n"
            for stdout, expected in ((full, "PASS"), (full.replace("EVENT_ROLLBACK_PASS", ""), "FAIL")):
                with patch.object(runner.db, "docker", side_effect=self.target()), patch.object(runner.db, "SessionLock"), patch.object(runner.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout, "")) as run:
                    report = runner.execute(root)
                    self.assertEqual(report["status"], expected)
                    self.assertEqual(run.call_count, 1)
                    self.assertEqual(run.call_args.kwargs["timeout"], 90)
                    self.assertEqual(run.call_args.args[0], runner.db.psql_command())
                    self.assertIn("rollback;", run.call_args.kwargs["input"])

    def test_sql_error_and_timeout_do_not_print_raw_details_or_claim_rollback(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            self.fixture(root)
            with patch.object(runner.db, "docker", side_effect=self.target()), patch.object(runner.db, "SessionLock"), patch.object(runner.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "PRIVATE_DATA", "PRIVATE_CONNECTION")):
                report = runner.execute(root)
                self.assertEqual(report["rollback"], "NOT_VERIFIED")
                self.assertNotIn("PRIVATE", json.dumps(report))
        out = io.StringIO()
        with patch.object(runner, "execute", side_effect=subprocess.TimeoutExpired("PRIVATE_COMMAND", 90)), contextlib.redirect_stdout(out):
            self.assertEqual(runner.main(["--run"]), 1)
        self.assertNotIn("PRIVATE", out.getvalue())
        self.assertEqual(json.loads(out.getvalue())["rollback"], "NOT_VERIFIED")


if __name__ == "__main__":
    unittest.main()
