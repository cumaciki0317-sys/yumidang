#!/usr/bin/env python3
"""민규: 전용 로컬 Edge gateway의 CORS와 인증·공개 읽기·내부 작업 검사.

총괄이 준비/기동한 빈 yumidang-minkyu-gateway(:56521)에만 HTTP 요청한다.
CLI 관리·사용자 생성·외부 네트워크·원문 오류/키 출력은 하지 않는다.
CORS만 미충족이면 다른 검사를 마친 뒤 PARTIAL/exit2, 기능 실패는 FAIL/exit1이다.
--self-test는 가상 응답과 임시 합성 설정만 사용하며 Docker/HTTP에 접근하지 않는다.
"""
import argparse
from dataclasses import dataclass
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import tomllib
import unittest
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[3]
API = "http://127.0.0.1:56521"
ORIGIN = "http://127.0.0.1:5173"
PROJECT = "yumidang-minkyu-gateway"
CONTEXT = "colima-yumidang-minkyu"
CONTAINER = "supabase_db_" + PROJECT
MANIFEST = "docs/collaboration/minkyu-event-http-harness.json"
MAX_BODY = 65536
STAGE = "configuration"
PENDING = (
    "20260929100000_event_storage.sql", "20261002090000_naver_signup.sql",
    "20261002100000_matching_lifecycle.sql", "20261002110000_completion_review_policy.sql",
    "20261002120000_appointment_changes.sql", "20261002130000_ai_budget_worker.sql",
    "20261002131000_events_public_profile.sql", "20261002140000_public_search_age_range.sql",
    "20261002150000_post_event_links.sql", "20261002160000_event_rankings.sql",
)
SAFE_CODES = {"AUTH_REQUIRED", "ACCESS_DENIED", "RESOURCE_NOT_FOUND", "INVALID_REQUEST", "STATE_CONFLICT",
              "EXTERNAL_UNAVAILABLE", "INTERNAL_ERROR", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "METHOD_NOT_ALLOWED"}


def require(value):
    if not value:
        raise ValueError("GATEWAY_CHECK_FAILED")


def regular(path, root=None, maximum=1048576):
    path = Path(path)
    if root is not None:
        require(path.is_relative_to(root))
        require(not any(part.is_symlink() for part in (path, *path.parents) if part.is_relative_to(root)))
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_size <= maximum)
    return path.read_bytes()


def temporary_directory(path):
    require(path.is_absolute() and not path.is_symlink())
    resolved = path.resolve()
    require(resolved != Path(tempfile.gettempdir()).resolve() and
            (resolved.is_relative_to(Path(tempfile.gettempdir()).resolve()) or resolved.is_relative_to(Path("/private/tmp"))))
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700 and info.st_uid == os.getuid())
    return resolved


def read_config(filename):
    path = Path(filename)
    require(path.is_absolute() and not path.is_symlink())
    temporary_directory(path.parent)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600 and
            info.st_uid == os.getuid() and info.st_nlink == 1 and info.st_size <= 24576)
    cfg = json.loads(regular(path, maximum=24576))
    require(isinstance(cfg, dict) and set(cfg) == {"API_URL", "ANON_KEY", "SERVICE_ROLE_KEY", "INTERNAL_WORKER_SECRET", "EDGE_ROOT"})
    require(all(isinstance(value, str) and value and value.strip() == value and not re.search(r"[\r\n\x00]", value) for value in cfg.values()))
    require(cfg["API_URL"] == API and len({cfg["ANON_KEY"], cfg["SERVICE_ROLE_KEY"], cfg["INTERNAL_WORKER_SECRET"]}) == 3)
    require(re.fullmatch(r"[A-Za-z0-9_-]{32,4096}", cfg["INTERNAL_WORKER_SECRET"]) is not None)
    cfg["EDGE_ROOT"] = temporary_directory(Path(cfg["EDGE_ROOT"]))
    return cfg


def source_guards(edge_root):
    # Reuse read-only harness/snapshot validators; imports do not start a server or read credentials.
    sys.path.insert(0, str(ROOT / "tools/collaboration"))
    sys.path.insert(0, str(ROOT / "tools/local"))
    import check_harness as harness
    import check_ownership as ownership
    import prepare_edge
    from prepare_migrations import inspect_migrations
    data = json.loads(regular(ROOT / MANIFEST, ROOT))
    policy, _ = ownership.load_policy(ROOT)
    files = harness.validate_manifest(data, policy)
    preserved = harness.validate_preserved(data, files, ROOT, policy)
    require(files.get("tests/integration/minkyu/gateway_cors_local.py") == "A")
    require(ownership.git(ROOT, "rev-parse", "HEAD").decode().strip() == data["baseline"])
    require(ownership.git(ROOT, "branch", "--show-current").decode().strip() == data["branch"])
    report = json.loads(regular(edge_root / "edge-manifest.json", edge_root))
    require(report["status"] == "READY" and report["source_head"] == data["baseline"] and
            report["source_mode"] == "working_tree_snapshot" and report["functions"] == ["service-api"])
    require(Path(report["output_root"]) == edge_root and report["database_manifest"] == "database-manifest.json")
    require(report["source_config_sha256"] == hashlib.sha256(regular(ROOT / "backend/supabase/config.toml", ROOT)).hexdigest())
    payloads = prepare_edge.source_snapshot(ROOT)
    entries = report["source_files"]
    require(isinstance(entries, list) and len(entries) == len(payloads))
    seen, targets = set(), set()
    for entry in entries:
        require(isinstance(entry, dict) and set(entry) == {"path", "target", "sha256"})
        source = Path(entry["path"])
        require(source in payloads and source not in seen)
        expected = Path("supabase/functions") / source.relative_to(prepare_edge.FUNCTIONS)
        require(Path(entry["target"]) == expected)
        copied = regular(edge_root / expected, edge_root)
        require(copied == payloads[source] and hashlib.sha256(copied).hexdigest() == entry["sha256"])
        seen.add(source)
        targets.add(expected)
    require({path.relative_to(edge_root) for path in (edge_root / "supabase/functions").rglob("*") if path.is_file()} == targets)
    config_bytes = regular(edge_root / "supabase/config.toml", edge_root)
    require(hashlib.sha256(config_bytes).hexdigest() == report["config_sha256"])
    config = tomllib.loads(config_bytes.decode())
    require(config["project_id"] == PROJECT and config["api"]["port"] == 56521 and
            config["db"]["port"] == 56522 and config["db"]["shadow_port"] == 56520)
    require(config["edge_runtime"]["enabled"] is True and set(config["functions"]) == {"service-api"} and
            config["functions"]["service-api"]["verify_jwt"] is False)
    database = json.loads(regular(edge_root / "database-manifest.json", edge_root))
    canonical = inspect_migrations(ROOT)["migrations"]
    require(database["migrations"] == canonical and database["total_count"] == len(canonical) + len(PENDING) == report["migration_count"] == 38)
    pending = database["pending"]
    require(isinstance(pending, list) and {Path(entry["path"]).name for entry in pending} == set(PENDING) and len(pending) == len(PENDING))
    for entry in canonical + pending:
        source = Path(entry["path"])
        require(source.parent == Path("backend/supabase/migrations") and re.fullmatch(r"[0-9]{14}_[a-z0-9_]+\.sql", source.name))
        copied = regular(edge_root / "supabase/migrations" / source.name, edge_root)
        require(copied == regular(ROOT / source, ROOT) and hashlib.sha256(copied).hexdigest() == entry["sha256"])
    require({path.name for path in (edge_root / "supabase/migrations").iterdir()} == {Path(entry["path"]).name for entry in canonical + pending})
    return len(preserved)


def docker(*args, input=None):
    result = subprocess.run(["docker", "--context", CONTEXT, *args], input=input, text=True,
                            capture_output=True, timeout=30)
    require(result.returncode == 0)
    return result.stdout.strip()


def database_empty():
    return docker("exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
                  input="select (select count(*) from auth.users)||','||(select count(*) from public.posts)||','||(select count(*) from private.worker_jobs);") == "0,0,0"


def target_guard():
    expected = "unix://" + str(Path.home()) + "/.colima/yumidang-minkyu/docker.sock"
    require(docker("context", "inspect", CONTEXT, "--format", "{{.Endpoints.docker.Host}}") == expected)
    targets = json.loads(docker("inspect", CONTAINER))
    require(isinstance(targets, list) and len(targets) == 1)
    target = targets[0]
    require(target["Name"] == "/" + CONTAINER and target["Config"]["Labels"]["com.supabase.cli.project"] == PROJECT and target["State"]["Running"] is True)
    require(database_empty())


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


@dataclass
class Result:
    status: int
    headers: object
    body: bytes

    def values(self, name):
        return self.headers.get_all(name, [])


class Client:
    def __init__(self, secrets, opener=None):
        self.secrets = [value.encode() for value in secrets]
        self.opener = opener or build_opener(ProxyHandler({}), NoRedirect())

    def request(self, path, method="GET", headers=None, body=None):
        address = API + path
        url = urlsplit(address)
        require(url.scheme == "http" and url.netloc == "127.0.0.1:56521" and
                not url.username and not url.password and not url.fragment and path.startswith("/functions/v1/service-api"))
        require(method in {"GET", "POST", "PUT", "OPTIONS"})
        payload = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        require(payload is None or len(payload) <= 8192)
        request = Request(address, method=method, data=payload,
                          headers={"Origin": ORIGIN, "Accept": "application/json", **({"Content-Type": "application/json"} if payload is not None else {}), **(headers or {})})
        try:
            result = self.opener.open(request, timeout=10)
        except HTTPError as error:
            result = error
        with result:
            content = result.read(MAX_BODY + 1)
            require(len(content) <= MAX_BODY and not any(secret in content for secret in self.secrets))
            require(not re.search(rb'"(?:stack|details|hint)"\s*:|SELECT\s+|at file:', content))
            return Result(result.status, result.headers, content)


class Probes:
    def __init__(self):
        self.checks = 0
        self.failures = []
        self.cors_failures = []

    def check(self, name, condition, *, cors=False, status=None):
        self.checks += 1
        if not condition:
            failure = {"check": name}
            if status is not None:
                failure["httpStatus"] = status
            (self.cors_failures if cors else self.failures).append(failure)

    def envelope(self, name, result, status, code=None, data_check=None):
        self.check(name + "_status", result.status == status, status=result.status)
        try:
            body = json.loads(result.body)
        except (ValueError, UnicodeDecodeError):
            self.check(name + "_json", False)
            return
        self.check(name + "_request_id", isinstance(body, dict) and isinstance(body.get("requestId"), str) and
                   result.values("X-Request-Id") == [body.get("requestId")])
        self.check(name + "_no_store", result.values("Cache-Control") == ["no-store"])
        if code is not None:
            error = body.get("error") if isinstance(body, dict) else None
            self.check(name + "_safe_error", isinstance(error, dict) and set(error) == {"code", "message", "retryable"} and
                       error.get("code") == code and code in SAFE_CODES and isinstance(error.get("message"), str) and
                       isinstance(error.get("retryable"), bool) and set(body) == {"error", "requestId"})
        else:
            self.check(name + "_data", isinstance(body, dict) and set(body) == {"data", "requestId"} and
                       (data_check is None or data_check(body["data"])))

    def cors(self, name, result, status, allow=None, preflight=False):
        self.check(name + "_status", result.status == status, cors=True, status=result.status)
        self.check(name + "_origin", result.values("Access-Control-Allow-Origin") == ([] if allow is None else [allow]), cors=True)
        if preflight:
            self.check(name + "_no_store", result.values("Cache-Control") == ["no-store"], cors=True)
            methods = ",".join(result.values("Access-Control-Allow-Methods")).split(",")
            headers = ",".join(result.values("Access-Control-Allow-Headers")).split(",")
            self.check(name + "_methods", {item.strip() for item in methods} == {"GET", "POST"}, cors=True)
            self.check(name + "_headers", {item.strip().lower() for item in headers} == {"authorization", "content-type", "apikey"}, cors=True)

    def report(self):
        return {"status": "FAIL" if self.failures else "PARTIAL" if self.cors_failures else "PASS", "checks": self.checks,
                "workflowPassed": not self.failures, "corsPassed": not self.cors_failures,
                "failures": self.failures, "corsFailures": self.cors_failures,
                "externalNaver": False, "externalAI": False, "userCreation": False}


def execute(cfg):
    global STAGE
    STAGE = "source_snapshot"
    preserved = source_guards(cfg["EDGE_ROOT"])
    STAGE = "dedicated_target"
    target_guard()
    STAGE = "gateway_http"
    client = Client([cfg["ANON_KEY"], cfg["SERVICE_ROLE_KEY"], cfg["INTERNAL_WORKER_SECRET"]])
    probes = Probes()
    prefix = "/functions/v1/service-api"
    empty_page = lambda value: value == {"status": "no_results", "posts": [], "nextCursor": None}
    page = client.request(prefix + "/posts")
    probes.envelope("public_empty_page", page, 200, data_check=empty_page)
    probes.cors("public_page_cors", page, 200, ORIGIN)
    options = client.request(prefix + "/posts", "OPTIONS", {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,content-type,apikey"})
    probes.cors("allowed_preflight", options, 204, ORIGIN, preflight=True)
    denied = client.request(prefix + "/posts", headers={"Origin": "https://blocked.example.test"})
    probes.cors("denied_origin", denied, 403)
    bad_headers = client.request(prefix + "/posts", "OPTIONS", {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-user-id"})
    probes.cors("denied_preflight_header", bad_headers, 403)
    bad_method = client.request(prefix + "/posts", "OPTIONS", {"Access-Control-Request-Method": "PUT"})
    probes.cors("denied_preflight_method", bad_method, 405)
    probes.envelope("anonymous_me", client.request(prefix + "/me"), 401, "AUTH_REQUIRED")
    for name, token in [("malformed_token", "synthetic.invalid.signature"), ("anon_bearer", cfg["ANON_KEY"]), ("service_bearer", cfg["SERVICE_ROLE_KEY"]), ("empty_token", "")]:
        probes.envelope(name, client.request(prefix + "/posts", headers={"Authorization": "" if not token else "Bearer " + token}), 401, "AUTH_REQUIRED")
    probes.envelope("internal_no_secret", client.request(prefix + "/internal/maintenance", "POST", body={"limit": 1}), 401, "AUTH_REQUIRED")
    probes.envelope("internal_service_key_denied", client.request(prefix + "/internal/maintenance", "POST", {"Authorization": "Bearer " + cfg["SERVICE_ROLE_KEY"]}, {"limit": 1}), 403, "ACCESS_DENIED")
    maintenance = client.request(prefix + "/internal/maintenance", "POST", {"Authorization": "Bearer " + cfg["INTERNAL_WORKER_SECRET"]}, {"limit": 1})
    expected = {"status": "partial", "completion": {"status": "managed_by_reservation"}, "consent": {"status": "expired", "expiredCount": 0},
                "scheduleChange": {"status": "expired", "expiredCount": 0}, "reviews": {"status": "published", "publishedCount": 0},
                "summary": {"status": "pending_configuration"}}
    probes.envelope("internal_config_pending_not_fake_ai", maintenance, 200, data_check=lambda value: value == expected)
    missing = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    probes.envelope("public_missing_detail", client.request(prefix + "/posts/" + missing), 404, "RESOURCE_NOT_FOUND")
    probes.envelope("unsupported_method", client.request(prefix + "/posts/" + missing, "PUT"), 405, "METHOD_NOT_ALLOWED")
    probes.envelope("invalid_uuid", client.request(prefix + "/posts/not-a-uuid"), 400, "INVALID_REQUEST")
    probes.envelope("unlisted_path", client.request(prefix + "/rpc/get_service_post", "POST", body={}), 404, "RESOURCE_NOT_FOUND")
    probes.envelope("caller_injection", client.request(prefix + "/posts?caller=member"), 400, "INVALID_REQUEST")
    probes.envelope("duplicate_query", client.request(prefix + "/posts?limit=1&limit=2"), 400, "INVALID_REQUEST")
    probes.envelope("detail_query_injection", client.request(prefix + "/posts/" + missing + "?userId=" + missing), 400, "INVALID_REQUEST")
    probes.envelope("internal_body_injection", client.request(prefix + "/internal/maintenance", "POST", {"Authorization": "Bearer " + cfg["INTERNAL_WORKER_SECRET"]}, {"limit": 1, "modelVersion": "attacker"}), 400, "INVALID_REQUEST")
    STAGE = "database_preservation"
    probes.check("database_still_empty", database_empty())
    report = probes.report()
    report["preserved"] = preserved
    return report


class SelfTests(unittest.TestCase):
    def test_exact_config_and_modes(self):
        with tempfile.TemporaryDirectory(prefix="ym-gateway-self-") as directory:
            root = Path(directory); root.chmod(0o700)
            cfg = {"API_URL": API, "ANON_KEY": "synthetic-anon", "SERVICE_ROLE_KEY": "synthetic-service",
                   "INTERNAL_WORKER_SECRET": "synthetic_worker_secret_32_characters", "EDGE_ROOT": str(root)}
            file = root / "config.json"
            file.write_text(json.dumps(cfg)); file.chmod(0o600)
            self.assertEqual(read_config(file)["EDGE_ROOT"], root.resolve())
            for extra in [{"extra": True}, {"API_URL": "http://127.0.0.1:56421"}, {"INTERNAL_WORKER_SECRET": "synthetic-anon"}]:
                file.write_text(json.dumps({**cfg, **extra}))
                with self.assertRaises(ValueError): read_config(file)
            file.write_text(json.dumps(cfg)); file.chmod(0o644)
            with self.assertRaises(ValueError): read_config(file)
            file.chmod(0o600); link = root / "link.json"; link.symlink_to(file)
            with self.assertRaises(ValueError): read_config(link)
            hard = root / "hard.json"; os.link(file, hard)
            with self.assertRaises(ValueError): read_config(file)

    def test_partial_cors_does_not_hide_workflow_failure(self):
        probes = Probes(); probes.check("cors", False, cors=True)
        self.assertEqual(probes.report()["status"], "PARTIAL")
        self.assertTrue(probes.report()["workflowPassed"])
        probes.check("authentication", False)
        self.assertEqual(probes.report()["status"], "FAIL")
        self.assertEqual(Probes().report()["status"], "PASS")

    def test_no_redirect_or_proxy_and_capped_response(self):
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, None, None, "https://outside.example.test"))
        from email.message import Message
        class FakeResponse(io.BytesIO):
            status = 200
            headers = Message()
        class FakeOpener:
            def __init__(self, payload): self.payload = payload; self.calls = []
            def open(self, request, timeout):
                self.calls.append((request.full_url, timeout))
                return FakeResponse(self.payload)
        opener = FakeOpener(b"{}"); client = Client(["synthetic-secret"], opener)
        self.assertEqual(client.request("/functions/v1/service-api/posts").status, 200)
        self.assertEqual(opener.calls, [(API + "/functions/v1/service-api/posts", 10)])
        for payload in [b"x" * (MAX_BODY + 1), b"synthetic-secret", b'{"stack":"private"}']:
            with self.assertRaises(ValueError): Client(["synthetic-secret"], FakeOpener(payload)).request("/functions/v1/service-api/posts")
        with self.assertRaises(ValueError): client.request("https://outside.example.test")
        self.assertTrue(any(isinstance(handler, ProxyHandler) and handler.proxies == {} for handler in Client([]).opener.handlers) or
                        not any(isinstance(handler, ProxyHandler) for handler in Client([]).opener.handlers))

    def test_exact_cors_and_error_envelope(self):
        from email.message import Message
        headers = Message(); headers["Access-Control-Allow-Origin"] = "*"
        probes = Probes(); probes.cors("wildcard", Result(200, headers, b"{}"), 200, ORIGIN)
        self.assertEqual(probes.report()["status"], "PARTIAL")
        headers = Message(); headers["Cache-Control"] = "no-store"; headers["X-Request-Id"] = "synthetic-id"
        body = {"requestId": "synthetic-id", "error": {"code": "AUTH_REQUIRED", "message": "로그인이 필요합니다.", "retryable": False}}
        probes = Probes(); probes.envelope("unauth", Result(401, headers, json.dumps(body).encode()), 401, "AUTH_REQUIRED")
        self.assertEqual(probes.report()["status"], "PASS")
        body["error"]["details"] = "synthetic private context"
        probes.envelope("raw_error", Result(401, headers, json.dumps(body).encode()), 401, "AUTH_REQUIRED")
        self.assertEqual(probes.report()["status"], "FAIL")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--config", type=Path)
    group.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        result = unittest.TextTestRunner(stream=io.StringIO()).run(unittest.defaultTestLoader.loadTestsFromTestCase(SelfTests))
        print(json.dumps({"status": "PASS" if result.wasSuccessful() else "FAIL", "selfTests": result.testsRun, "actualGateway": "NOT_RUN"}))
        return 0 if result.wasSuccessful() else 1
    if args.config is None:
        print(json.dumps({"status": "NOT_RUN", "project": PROJECT, "actualGateway": "NOT_RUN"}))
        return 0
    try:
        report = execute(read_config(args.config))
    except Exception:
        # Captured Docker stderr/HTTP payload/config credentials must never enter output.
        print(json.dumps({"status": "FAIL", "stage": STAGE, "actualGateway": "NOT_COMPLETED"}))
        return 1
    print(json.dumps(report))
    return 1 if report["status"] == "FAIL" else 2 if report["status"] == "PARTIAL" else 0


if __name__ == "__main__":
    raise SystemExit(main())
