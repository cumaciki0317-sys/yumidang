"""실제 네트워크 없이 진단 범위·오류 분류·키와 원문 미출력을 검증한다."""
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
import check_kakao_api as kakao


class KakaoDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.env = Path(temp.name).resolve() / ".env"
        self.key = "fixture_PRIVATE_key"
        self.env.write_text(f'KAKAO_REST_API_KEY="{self.key}"\n')

    def response(self, body, status=403, returncode=0):
        return subprocess.CompletedProcess([], returncode, json.dumps(body).encode() + f"\n{status}".encode(), b"private upstream error")

    def test_default_is_not_run(self):
        with patch.object(kakao.subprocess, "run", side_effect=AssertionError("no network")):
            self.assertEqual(kakao.diagnose(self.env)["execution"], "NOT_RUN")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(kakao.main(["--env-file", str(self.env)]), 0)
            self.assertNotIn(self.key, out.getvalue())

    def test_key_only_in_stdin_and_request_is_fixed_minimum(self):
        def transport(command, **kwargs):
            self.assertNotIn(self.key, repr(command))
            self.assertEqual(command[:4], ["/usr/bin/curl", "--disable", "--config", "-"])
            self.assertEqual(command[-1], kakao.URL)
            self.assertIn("page=1&size=1", command[-1])
            self.assertNotIn("--location", command)
            self.assertNotIn("--insecure", command)
            self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
            self.assertEqual(kwargs["timeout"], 20)
            self.assertEqual(kwargs["input"], f'header = "Authorization: KakaoAK {self.key}"\n'.encode())
            return self.response({"documents": [], "meta": {}}, 200)
        self.assertEqual(kakao.diagnose(self.env, True, transport)["execution"], "PASS")

    def test_header_and_config_injection_rejected_before_network(self):
        for value in ['"\nurl=evil', "key\\n", "key key", "key\r\nInjected:value", "key;option"]:
            self.env.write_text(f"KAKAO_REST_API_KEY='{value}'\n")
            result = kakao.diagnose(self.env, True, lambda *_args, **_kwargs: self.fail("network not allowed"))
            self.assertEqual(result["execution"], "NOT_RUN")
            self.assertNotIn(value, json.dumps(result))

    def test_403_fixed_message_and_official_codes_are_safely_classified(self):
        response = {"errorType": "NotAuthorizedError", "message": f"App({self.key}) disabled OPEN_MAP_AND_LOCAL service."}
        result = kakao.diagnose(self.env, True, lambda *_args, **_kwargs: self.response(response))
        self.assertEqual(result["classification"], "MAP_LOCAL_SERVICE_DISABLED")
        self.assertNotIn(self.key, json.dumps(result))
        for code, expected in [(-3, "FEATURE_OR_API_NOT_ENABLED"), (-5, "API_PERMISSION_REQUIRED"), (-12, "APP_OR_ACCOUNT_RESTRICTED")]:
            result = kakao.classify(403, json.dumps({"code": code, "msg": self.key}).encode())
            self.assertEqual(result["classification"], expected)
            self.assertEqual(result["upstream_code"], code)
            self.assertNotIn(self.key, json.dumps(result))

    def test_arbitrary_error_code_message_and_body_are_never_echoed(self):
        for body in [{"code": self.key, "message": self.key}, {"code": -999999, "msg": self.key},
                     {"errorType": "NotAuthorizedError", "message": f"prefix App({self.key}) disabled OPEN_MAP_AND_LOCAL service."}]:
            result = kakao.classify(403, json.dumps(body).encode())
            self.assertEqual(result["classification"], "FORBIDDEN_UNCLASSIFIED")
            self.assertNotIn(self.key, json.dumps(result))
            self.assertNotIn("upstream_code", result)
        self.assertEqual(kakao.classify(403, b"not JSON private body")["classification"], "FORBIDDEN_UNCLASSIFIED")

    def test_timeout_network_failure_oversize_and_redirect_are_bounded(self):
        for code, expected in [(28, "NETWORK_TIMEOUT"), (60, "TLS_VERIFICATION_FAILED"), (63, "RESPONSE_TOO_LARGE"), (6, "NETWORK_FAILED")]:
            result = kakao.diagnose(self.env, True, lambda *_args, **_kwargs: self.response({"key": self.key}, returncode=code))
            self.assertEqual(result["classification"], expected)
        def timeout(*_args, **_kwargs):
            raise subprocess.TimeoutExpired(self.key, 20, output=self.key, stderr=self.key)
        self.assertEqual(kakao.diagnose(self.env, True, timeout)["classification"], "NETWORK_TIMEOUT")
        self.assertEqual(kakao.classify(200, b"x" * (kakao.MAX_BODY + 1))["classification"], "RESPONSE_TOO_LARGE")
        self.assertEqual(kakao.classify(302, b"")["classification"], "REDIRECT_REFUSED")

    def test_cli_invalid_argument_does_not_echo_value(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(kakao.main(["--unknown", self.key]), 1)
        self.assertNotIn(self.key, out.getvalue())
        self.assertEqual(json.loads(out.getvalue())["classification"], "INVALID_ARGUMENTS")


if __name__ == "__main__":
    unittest.main()
