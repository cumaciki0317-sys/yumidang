#!/usr/bin/env python3
"""민규 전용 기존 로컬 DB에서 네이버·매칭 미적용 SQL을 단일 트랜잭션으로 검증·rollback한다."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
import run_database_tests as db
from run_event_database_tests import read_source, statements

ROOT = Path(__file__).resolve().parents[2]
NAVER = Path("backend/supabase/migrations/20261002090000_naver_signup.sql")
MATCHING = Path("backend/supabase/migrations/20261002100000_matching_lifecycle.sql")
TEST = Path("tests/database/minkyu/matching_lifecycle.sql")
NAVER_TEST = Path("tests/database/minkyu/naver_signup.sql")
CHECKS = {"acl_naver_direct_bypass", "single_active_pending_chats", "expiry_reproposal_version",
          "withdraw_decline_consent_not_application", "closed_existing_request_finalization",
          "core_update_invalidation_optimistic", "deletion_visibility_read_only_preservation",
          "confirmation_losers_idempotency", "withdraw_reapply_decline_ban", "information_requalification_gate"}


def build_script(naver, matching, tests, naver_tests=None):
    migrations = [statements(naver), statements(matching)]
    probes = [statements(tests)]
    if naver_tests is not None:
        probes.insert(0, statements(naver_tests))
    if any(not part or part[0].lower() != "begin" or part[-1].lower() != "commit" for part in migrations):
        raise ValueError("EXPECTED_MIGRATION_WRAPPER")
    if any(not part or part[0].lower() != "begin" or part[-1].lower() != "rollback" for part in probes):
        raise ValueError("EXPECTED_TEST_WRAPPER")
    body = [statement for part in migrations + probes for statement in part[1:-1]]
    if any(re.match(r"(?is)^(begin|commit|rollback|end|abort|savepoint|release|start\s+transaction|prepare\s+transaction)\b", statement) for statement in body):
        raise ValueError("NESTED_TRANSACTION_NOT_ALLOWED")
    if not all("MATCHING_CHECK:" + name in tests for name in CHECKS):
        raise ValueError("TEST_MARKERS_MISSING")
    absent = """do $$ begin
      assert to_regclass('private.naver_accounts') is null;
      assert to_regclass('private.naver_sessions') is null;
      assert to_regclass('private.profile_traits') is null;
      assert to_regclass('private.match_consent_lifecycle') is null;
      assert to_regclass('private.match_lifecycle_events') is null;
      assert to_regprocedure('public.update_service_post(uuid,jsonb,timestamp with time zone)') is null;
      assert to_regprocedure('public.withdraw_match_consent(uuid,text)') is null;
      assert to_regprocedure('public.expire_match_consents(integer)') is null;
    end $$;"""
    dependency = """do $$ begin
      assert to_regprocedure('public.create_service_post(uuid,jsonb)') is not null;
      assert position('request_declined_history' in pg_get_functiondef('public.create_join_request(uuid,text)'::regprocedure))>0;
      assert to_regclass('private.match_consents') is not null;
      assert to_regclass('private.post_search_locations') is not null;
    end $$;"""
    return ("set statement_timeout='30s';set lock_timeout='5s';set idle_in_transaction_session_timeout='30s';set transaction_timeout='120s';\n"
            "begin;set local plpgsql.check_asserts=on;\n" + absent + "\n" + dependency + "\n" + ";\n".join(body) +
            ";\nreset role;rollback;\nset plpgsql.check_asserts=on;\n" + absent + "\nselect 'MATCHING_ROLLBACK_PASS';\n")


def execute(include_naver=False):
    sources = [read_source(ROOT, path) for path in (NAVER, MATCHING, TEST)]
    naver_tests = read_source(ROOT, NAVER_TEST) if include_naver else None
    script = build_script(*sources, naver_tests=naver_tests)
    endpoint = db.docker("context", "inspect", db.CONTEXT, "--format", "{{.Endpoints.docker.Host}}")
    expected = "unix://" + str(Path.home() / ".colima/yumidang-minkyu/docker.sock")
    if endpoint.returncode or endpoint.stdout.strip() != expected:
        raise ValueError("DEDICATED_CONTEXT_REQUIRED")
    inspected = db.docker("inspect", db.CONTAINER)
    if inspected.returncode:
        raise ValueError("DEDICATED_CONTAINER_REQUIRED")
    db.validate_target(endpoint.stdout.strip(), json.loads(inspected.stdout)[0])
    # 이전 로컬 검증과 동일 잠금을 사용해 동시에 pending DDL을 적용하지 않는다.
    with db.SessionLock(73109000):
        result = subprocess.run(db.psql_command(), input=script, capture_output=True, text=True, timeout=150)
    if result.returncode:
        # 진단 원문은 0600 임시 파일에만 남긴다. 출력은 SQLSTATE·검증 마커만 허용한다.
        descriptor, diagnostic = tempfile.mkstemp(prefix="yumidang-matching-sql-", suffix=".log")
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(result.stdout + "\n" + result.stderr)
        state = re.search(r"(?m)^ERROR:\s+([0-9A-Z]{5})\b", result.stderr)
        observed = sorted({line.removeprefix("MATCHING_CHECK:") for line in result.stdout.splitlines()
                           if line.startswith("MATCHING_CHECK:") and line.removeprefix("MATCHING_CHECK:") in CHECKS})
        return {"status": "FAIL", "result": "SQL_CHECK_FAILED", "rollback": "NOT_VERIFIED",
                "sqlstate": state[1] if state else "UNKNOWN", "completedChecks": observed, "diagnosticFile": diagnostic}
    lines = result.stdout.splitlines()
    observed = {line.removeprefix("MATCHING_CHECK:") for line in lines if line.startswith("MATCHING_CHECK:")}
    if observed != CHECKS or "MATCHING_ROLLBACK_PASS" not in lines:
        return {"status": "FAIL", "result": "CHECK_OR_ROLLBACK_MARKER_MISSING"}
    if include_naver:
        from run_naver_database_tests import CHECKS as naver_checks
        actual = {line.removeprefix("NAVER_CHECK:") for line in lines if line.startswith("NAVER_CHECK:")}
        if actual != naver_checks:
            return {"status": "FAIL", "result": "NAVER_REGRESSION_MARKER_MISSING"}
    return {"status": "PASS", "checks": len(CHECKS), "naverRegression": include_naver, "rollback": "PASS",
            "scope": "local_pending_migrations_only", "source_sha256": [hashlib.sha256(value.encode()).hexdigest() for value in sources]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--include-naver", action="store_true")
    args = parser.parse_args(argv)
    report = {"status": "NOT_RUN", "result": "EXPLICIT_RUN_REQUIRED"}
    if args.run:
        try:
            report = execute(args.include_naver)
        except subprocess.TimeoutExpired:
            report = {"status": "FAIL", "result": "LOCAL_CHECK_TIMEOUT", "rollback": "NOT_VERIFIED"}
        except Exception:
            report = {"status": "FAIL", "result": "SOURCE_OR_TARGET_CHECK_FAILED"}
    print(json.dumps(report))
    return 0 if report["status"] == "PASS" else 2 if report["status"] == "NOT_RUN" else 1


if __name__ == "__main__":
    raise SystemExit(main())
