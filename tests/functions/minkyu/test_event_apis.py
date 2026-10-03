"""가상 응답으로 원문 비노출·HTTPS 전용 최소 요청·공급사 오류 판정을 검증한다."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/local"))
SPEC = importlib.util.spec_from_file_location("check_event_apis", ROOT / "tools/local/check_event_apis.py")
events = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(events)
VALID = b"<dbs><db><mt20id>PF1</mt20id><prfnm>fixture</prfnm><prfpdfrom>2026.09.29</prfpdfrom><prfpdto>2026.09.29</prfpdto></db></dbs>"


class EventApiTests(unittest.TestCase):
    def call(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = events.main(argv)
        self.assertEqual(err.getvalue(), "")
        return code, json.loads(out.getvalue()), out.getvalue()

    def test_default_and_seoul_do_not_read_key_or_call_network(self):
        with patch.object(events, "read_env") as read, patch.object(events, "fetch_kopis") as fetch:
            for args in (["--provider", "kopis"], ["--provider", "seoul", "--run", "--env-file", "SECRET_PATH"]):
                code, report, _ = self.call(args)
                self.assertEqual(code, 2)
                self.assertFalse(report["keyed_request_attempted"])
            read.assert_not_called()
            fetch.assert_not_called()

    def test_secret_url_only_in_stdin_and_no_downgrade(self):
        sentinel = "SECRET_ONLY_STDIN"
        stdout = VALID + events.MARKER + b"200 0"
        with patch.object(events.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout, b"")) as run:
            response = events.fetch_kopis(events.KOPIS_ENDPOINT + "?service=" + sentinel)
            command, kwargs = run.call_args.args[0], run.call_args.kwargs
            self.assertNotIn(sentinel, str(command))
            self.assertNotIn("https://", str(command))
            self.assertIn(sentinel.encode(), kwargs["input"])
            self.assertEqual(command[:2], ["/usr/bin/curl", "--disable"])
            self.assertNotIn("--location", command)
            self.assertNotIn("--insecure", command)
            self.assertIn("--max-filesize", command)
            self.assertEqual(command[command.index("--max-redirs") + 1], "0")
            self.assertEqual(command[command.index("--proto") + 1], "=https")
            self.assertEqual(response["http_status"], 200)
        with patch.object(events.subprocess, "run") as run:
            for url in ("http://kopis.or.kr/openApi/restful/pblprfr", "https://evil.invalid/openApi/restful/pblprfr", events.KOPIS_ENDPOINT + '\nurl="https://evil.invalid"'):
                self.assertEqual(events.fetch_kopis(url)["transport"], "DESTINATION_REJECTED")
            run.assert_not_called()

    def test_provider_error_html_malformed_xml_never_pass(self):
        for body in (b"<error><msg>PRIVATE</msg></error>", b"<html>gateway</html>", b"broken", b"<dbs><error>PRIVATE</error></dbs>", b"<dbs/>", b"<!DOCTYPE x [<!ENTITY x 'private'>]><dbs/>"):
            self.assertEqual(events.inspect_kopis(200, body)["status"], "FAIL")
        self.assertEqual(events.inspect_kopis(200, VALID), {"status": "PASS", "result": "VALID_XML_ROW", "rows": 1})
        self.assertEqual(events.inspect_kopis(302, b"PRIVATE")["result"], "REDIRECT_NOT_FOLLOWED")

    def test_seoul_http200_error_envelope_not_success(self):
        error = b'{"RESULT":{"CODE":"ERROR-300","MESSAGE":"PRIVATE"}}'
        self.assertEqual(events.inspect_seoul(200, error)["result"], "PROVIDER_ERROR")
        success = b'{"culturalEventInfo":{"RESULT":{"CODE":"INFO-000"},"row":[{"TITLE":"fixture"}]}}'
        self.assertEqual(events.inspect_seoul(200, success)["status"], "PASS")
        self.assertEqual(events.inspect_seoul(200, b"<html>PRIVATE</html>")["status"], "FAIL")

    def test_live_request_is_one_day_one_row_and_no_raw_output(self):
        secret = "SECRET_FULL_KEY"
        with patch.object(events, "read_env", return_value="KOPIS_API_KEY=" + secret), patch.object(events, "fetch_kopis", return_value={"transport": "OK", "http_status": 200, "body": VALID}) as fetch:
            code, report, output = self.call(["--provider", "kopis", "--run", "--env-file", "SECRET_FILE"])
            self.assertEqual(code, 0)
            self.assertEqual(report["rows"], 1)
            self.assertNotIn(secret, output)
            self.assertNotIn("fixture", output)
            from urllib.parse import parse_qs, urlsplit
            query = parse_qs(urlsplit(fetch.call_args.args[0]).query)
            self.assertEqual(query["stdate"], query["eddate"])
            self.assertEqual(query["rows"], ["1"])
            self.assertEqual(query["cpage"], ["1"])
            self.assertEqual(fetch.call_count, 1)

    def test_exception_and_response_key_echo_are_not_printed(self):
        secret = "SECRET_EXCEPTION_OR_BODY"
        with patch.object(events, "read_env", side_effect=RuntimeError(secret)):
            code, _, output = self.call(["--provider", "kopis", "--run", "--env-file", secret])
            self.assertEqual(code, 1)
            self.assertNotIn(secret, output)
        with patch.object(events, "read_env", return_value="KOPIS_API_KEY=" + secret), patch.object(events, "fetch_kopis", return_value={"transport": "OK", "http_status": 200, "body": ("<error>" + secret + "</error>").encode()}):
            code, _, output = self.call(["--provider", "kopis", "--run", "--env-file", secret])
            self.assertEqual(code, 1)
            self.assertNotIn(secret, output)

    def test_tls_timeout_large_body_and_redirect_do_not_retry(self):
        for rc, stdout in ((60, events.MARKER + b"000 20"), (28, events.MARKER + b"000 0"), (0, b"x" * (events.MAX_BODY + 101)), (0, events.MARKER + b"200 20")):
            with patch.object(events.subprocess, "run", return_value=subprocess.CompletedProcess([], rc, stdout, b"SECRET_STDERR")) as run:
                result = events.fetch_kopis(events.KOPIS_ENDPOINT)
                self.assertNotEqual(result["transport"], "OK")
                self.assertNotIn("SECRET_STDERR", str(result))
                self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
