import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/local"))
spec = importlib.util.spec_from_file_location("tour_check", ROOT / "tools/local/check_tour_api.py")
tour = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tour)


def success(items=None, total=1):
    return json.dumps({"response": {"header": {"resultCode": "00"}, "body": {
        "items": {"item": items if items is not None else [{"contentid": "synthetic-1", "title": "PRIVATE_BODY"}]},
        "totalCount": total,
    }}}).encode()


class TourApiTests(unittest.TestCase):
    def test_raw_unknown_key_is_preserved_once(self):
        key = "synthetic%2B+/=&?key"
        url = tour.request_url(key, "20260929")
        self.assertEqual(urlsplit(url).scheme, "https")
        self.assertEqual(urlsplit(url).netloc, "apis.data.go.kr")
        query = parse_qs(urlsplit(url).query)
        self.assertEqual(query["serviceKey"], [key])
        self.assertEqual(query["numOfRows"], ["1"])
        self.assertEqual(query["eventStartDate"], query["eventEndDate"])
        self.assertIn("%252B", url)  # 이미 인코딩처럼 보이는 입력도 decode하지 않는다.

    def test_invalid_date_and_key_cannot_form_request(self):
        for key, day in [("x\nsecret", "20260929"), (" x", "20260929"), ("x", "20260230"), ("x", "2026-09-29")]:
            with self.subTest(key=key, day=day), self.assertRaises(tour.InputError):
                tour.request_url(key, day)

    def test_pass_reports_only_count(self):
        result = tour.response_report(200, success())
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["returned_count"], 1)
        self.assertNotIn("PRIVATE_BODY", json.dumps(result))

    def test_empty_success_requires_zero_total(self):
        self.assertTrue(tour.response_report(200, success([], 0))["empty"])
        self.assertEqual(tour.response_report(200, success([], 1))["status"], "FAIL")

    def test_official_four_digit_success_example(self):
        body = success().replace(b'"00"', b'"0000"')
        self.assertEqual(tour.response_report(200, body)["status"], "PASS")
        self.assertEqual(tour.response_report(200, body)["provider_code"], "0000")

    def test_http_200_provider_error_is_failure(self):
        body = b'{"response":{"header":{"resultCode":"30","resultMsg":"PRIVATE_KEY"}}}'
        result = tour.response_report(200, body)
        self.assertEqual(result["reason"], "PROVIDER_ERROR")
        self.assertEqual(result["provider_code"], "30")
        self.assertNotIn("PRIVATE_KEY", json.dumps(result))

    def test_xml_gateway_error_is_failure(self):
        body = b'<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>PRIVATE</returnAuthMsg><returnReasonCode>20</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>'
        self.assertEqual(tour.response_report(200, body)["provider_code"], "20")

    def test_unknown_error_code_never_echoes(self):
        for body in [b'{"header":{"resultCode":"PRIVATE_KEY"}}', b'<r><resultCode>PRIVATE_KEY</resultCode></r>']:
            result = tour.response_report(200, body)
            self.assertEqual(result["provider_code"], "UNKNOWN")
            self.assertNotIn("PRIVATE_KEY", json.dumps(result))

    def test_redirect_and_malformed_response_fail(self):
        self.assertEqual(tour.response_report(302, b"PRIVATE_URL")["reason"], "HTTP_ERROR")
        for body in [b"not-json PRIVATE", b"[]", b'<html/>', b'<!DOCTYPE x><x/>', success([{}, {}], 2)]:
            self.assertEqual(tour.response_report(200, body)["status"], "FAIL")

    def test_default_does_not_read_or_connect(self):
        with patch.object(tour, "read_env") as read, patch.object(tour, "curl_request") as connect, contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(tour.main([]), 0)
        read.assert_not_called()
        connect.assert_not_called()
        self.assertEqual(json.loads(out.getvalue())["status"], "NOT_RUN")

    def test_run_requires_explicit_raw_input(self):
        with patch.object(tour, "read_env") as read, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(tour.main(["--run", "--env-file", "unused"]), 1)
        read.assert_not_called()

    def test_unknown_input_run_is_not_format_detection(self):
        source = 'TOUR_API_SERVICE_KEY="synthetic%2B+/="\nTOUR_API_KEY_FORMAT="unknown"'
        with patch.object(tour, "read_env", return_value=source), patch.object(tour, "curl_request", return_value=(200, success())) as call, contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(tour.main(["--run", "--raw-input", "--env-file", "unused", "--event-date", "20260929"]), 0)
        self.assertEqual(call.call_count, 1)
        self.assertEqual(parse_qs(urlsplit(call.call_args.args[0]).query)["serviceKey"], ["synthetic%2B+/="])
        result = json.loads(out.getvalue())
        self.assertEqual(result["input_key_format"], "unknown")
        self.assertEqual(result["key_format_detection"], "NOT_RUN")
        self.assertFalse(result["config_modified"])
        self.assertNotIn("synthetic", out.getvalue())

    def test_exception_message_is_never_printed_or_retried(self):
        with patch.object(tour, "read_env", return_value="TOUR_API_SERVICE_KEY=synthetic"), patch.object(tour, "curl_request", side_effect=RuntimeError("PRIVATE_KEY")) as call, contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(tour.main(["--run", "--raw-input", "--env-file", "unused"]), 1)
        self.assertEqual(call.call_count, 1)
        self.assertNotIn("PRIVATE_KEY", out.getvalue())

    def test_curl_flags_and_stdin_secret(self):
        original = subprocess.Popen
        recorded = []
        def spawn(command, **kwargs):
            recorded.append(command)
            self.assertEqual(kwargs["env"], {})
            script = 'import sys; c=sys.stdin.buffer.read(); assert b"synthetic-secret" in c; sys.stdout.buffer.write(b"{}\\n200")'
            return original([sys.executable, "-c", script], **kwargs)
        with patch.object(tour.subprocess, "Popen", side_effect=spawn):
            self.assertEqual(tour.curl_request(tour.request_url("synthetic-secret", "20260929")), (200, b"{}"))
        cmd = recorded[0]
        self.assertEqual(cmd[:2], ["/usr/bin/curl", "-q"])
        self.assertIn("--config", cmd)
        self.assertNotIn("synthetic-secret", " ".join(cmd))
        self.assertNotIn("--insecure", cmd)
        self.assertNotIn("--location", cmd)

    def test_transport_body_cap(self):
        original = subprocess.Popen
        def spawn(_command, **kwargs):
            return original([sys.executable, "-c", 'import sys;sys.stdin.buffer.read();sys.stdout.buffer.write(b"X"*100000)'], **kwargs)
        with patch.object(tour.subprocess, "Popen", side_effect=spawn), self.assertRaises(tour.InputError):
            tour.curl_request(tour.request_url("synthetic", "20260929"))


if __name__ == "__main__":
    unittest.main()
