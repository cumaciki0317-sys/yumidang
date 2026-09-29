"""실제 API 키 없이 dotenv 읽기·거절·출력 비노출을 검증한다."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("check_api_env", ROOT / "tools/local/check_api_env.py")
env = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(env)


class ApiEnvTests(unittest.TestCase):
    def call(self, argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = env.main(argv)
        self.assertEqual(stderr.getvalue(), "")
        return code, json.loads(stdout.getvalue()), stdout.getvalue()

    def test_quotes_comments_and_literal_values(self):
        parsed = env.parse_env("# 주석\r\nA='literal # data' # comment\r\nB=plain # comment\nC=abc#part\nD=\"$(touch NEVER) ${A}\"\nE=\nF= # blank\n")
        self.assertEqual(parsed, {"A": "literal # data", "B": "plain", "C": "abc#part", "D": "$(touch NEVER) ${A}", "E": "", "F": ""})

    def test_malformed_lines_are_rejected(self):
        for text in ("A=1\nA=2", "A='unfinished", 'A="ok"junk', "A=bad'quote", "1KEY=x", "export A=x", "A-B=x", "A", "A=x\x00", "A=x\x1b", "A=x\rB=y", "A=x\t", "A=x\u200b"):
            with self.subTest(kind=type(text).__name__):
                with self.assertRaises(env.InputError):
                    env.parse_env(text)

    def test_blank_required_fields_and_explicit_tour_format(self):
        report = env.report({"KAKAO_REST_API_KEY": " ", "TOUR_API_SERVICE_KEY": "%2Bvalue"})
        self.assertEqual(report["status"], "INCOMPLETE")
        self.assertEqual(report["providers"]["kakao"]["api_key"], "missing")
        self.assertEqual(report["providers"]["tour"]["key_format"], "unknown")
        for mode in ("encoded", "decoded", "unknown"):
            self.assertEqual(env.report({"TOUR_API_KEY_FORMAT": mode})["providers"]["tour"]["key_format"], mode)
        with self.assertRaises(env.InputError):
            env.report({"TOUR_API_KEY_FORMAT": "auto"})

    def test_complete_inputs_are_not_connection_success(self):
        values = {key: "not-a-real-secret" for key in (*env.KEYS.values(), *env.POTENS_FIELDS.values())}
        values["TOUR_API_KEY_FORMAT"] = "decoded"
        values.update(POTENS_API_BASE_URL="https://example.invalid", UPSTREAM_TIMEOUT_MS="10000")
        result = env.report(values)
        self.assertEqual(result["status"], "INPUTS_PRESENT")
        self.assertEqual(result["connection_check"], "NOT_RUN")
        self.assertEqual(result["validation"], "OFFLINE_SYNTAX_ONLY")
        self.assertNotIn("not-a-real-secret", json.dumps(result))

    def test_cli_readonly_no_secret_or_filename_in_output(self):
        sentinel = "DO_NOT_PRINT_PRIVATE_SENTINEL"
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder).resolve() / (sentinel + ".env")
            content = "\n".join(key + "=" + sentinel for key in (*env.KEYS.values(), *env.POTENS_FIELDS.values()) if key != "POTENS_API_BASE_URL")
            content += "\nPOTENS_API_BASE_URL=https://example.invalid\nTOUR_API_KEY_FORMAT=encoded\nUPSTREAM_TIMEOUT_MS=10000\n"
            file.write_text(content)
            before = file.stat()
            code, report, output = self.call(["--env-file", str(file)])
            self.assertEqual(code, 0)
            self.assertEqual(report["status"], "INPUTS_PRESENT")
            self.assertNotIn(sentinel, output)
            self.assertNotIn(str(file), output)
            self.assertEqual(file.read_text(), content)
            self.assertEqual(file.stat().st_mtime_ns, before.st_mtime_ns)

    def test_safe_failure_for_secret_filename_or_line(self):
        sentinel = "NEVER_SHOW_SECRET_IN_ERROR"
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder).resolve() / sentinel
            for content in (None, sentinel + "='unfinished", sentinel + "=a\n" + sentinel + "=b", "TOUR_API_KEY_FORMAT=" + sentinel):
                if content is not None:
                    file.write_text(content)
                code, report, output = self.call(["--env-file", str(file)])
                self.assertEqual(code, 1)
                self.assertEqual(report["connection_check"], "NOT_RUN")
                self.assertNotIn(sentinel, output)

    def test_cli_required_path_and_unknown_arguments_are_redacted(self):
        for argv in ([], ["--env-file"], ["--SECRET_ARGUMENT_VALUE"]):
            code, report, output = self.call(argv)
            self.assertEqual((code, report["error"]), (1, "INVALID_ARGUMENTS"))
            self.assertNotIn("SECRET_ARGUMENT_VALUE", output)

    def test_unexpected_exception_message_is_not_printed(self):
        sentinel = "SECRET_INSIDE_EXCEPTION"
        for error in (OSError(sentinel), RuntimeError(sentinel)):
            with patch.object(env, "read_env", side_effect=error):
                code, _, output = self.call(["--env-file", sentinel])
                self.assertEqual(code, 1)
                self.assertNotIn(sentinel, output)

    def test_symlink_and_directory_are_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            file, link = root / "input.env", root / "link.env"
            file.write_text("A=1\n")
            link.symlink_to(file)
            self.assertEqual(self.call(["--env-file", str(link)])[1]["error"], "SYMLINK_NOT_ALLOWED")
            self.assertEqual(self.call(["--env-file", str(root)])[1]["error"], "REGULAR_FILE_REQUIRED")
            link_dir = root / "linked"
            link_dir.symlink_to(root, target_is_directory=True)
            self.assertEqual(self.call(["--env-file", str(link_dir / "input.env")])[1]["error"], "SYMLINK_NOT_ALLOWED")

    def test_invalid_encoding_and_oversize_are_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder).resolve() / "input.env"
            file.write_bytes(b"A=\xff")
            self.assertEqual(self.call(["--env-file", str(file)])[1]["error"], "INVALID_ENCODING")
            file.write_bytes(b"A=" + b"x" * env.MAX_BYTES)
            self.assertEqual(self.call(["--env-file", str(file)])[1]["error"], "FILE_TOO_LARGE")

    def test_missing_inputs_exit_two(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder).resolve() / "input.env"
            file.write_text("KAKAO_REST_API_KEY=\n")
            self.assertEqual(self.call(["--env-file", str(file)])[0], 2)

    def test_potens_model_timeout_url_and_optional_metadata(self):
        values = {key: "fake-key" for key in env.KEYS.values()}
        values.update(TOUR_API_KEY_FORMAT="encoded", POTENS_API_BASE_URL="https://example.invalid",
                      POTENS_MODEL="provider/model-id", UPSTREAM_TIMEOUT_MS="10000")
        self.assertEqual(env.report(values)["status"], "INPUTS_PRESENT")
        for key, value in (("POTENS_MODEL", "Sonnet 5"), ("UPSTREAM_TIMEOUT_MS", "0"),
                           ("UPSTREAM_TIMEOUT_MS", "2147483648"), ("POTENS_API_BASE_URL", "https://example.invalid/v1"),
                           ("POTENS_API_BASE_URL", "https://private@example.invalid"), ("KAKAO_REST_API_KEY", " bad ")):
            self.assertEqual(env.report({**values, key: value})["status"], "INVALID_INPUT")
        self.assertEqual(env.report({**values, "POTENS_MODEL": "", "POTENS_REQUESTED_MODEL": "Sonnet 5"})["status"], "INCOMPLETE")


if __name__ == "__main__":
    unittest.main()
