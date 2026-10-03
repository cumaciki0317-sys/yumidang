#!/usr/bin/env python3
"""새 행사 SQL과 회귀 검사를 전용 로컬 DB의 단일 트랜잭션에서 실행 후 되돌린다."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

import run_database_tests as db

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = Path("backend/supabase/migrations/20260929100000_event_storage.sql")
TEST = Path("tests/database/minkyu/event_storage.sql")
CHECKS = {"acl", "identity_stale_cancel", "timing_null_admission_exact_filters",
          "invalid_and_atomic_batch", "actual_roles_and_direct_table_denial", "candidate_cap"}
MAX_SOURCE = 1024 * 1024


def read_source(root, relative):
    path = root / relative
    if any(part.is_symlink() for part in (path, *path.parents) if part.is_relative_to(root)):
        raise ValueError("SOURCE_SYMLINK")
    if not path.is_file() or path.stat().st_size > MAX_SOURCE:
        raise ValueError("SOURCE_INVALID")
    return path.read_text(encoding="utf-8")


def statements(sql):
    """현재 SQL의 문자열·dollar quote·주석 안 세미콜론과 최상위 문장을 구분한다.

    신뢰할 수 없는 SQL을 허용하는 sandbox가 아니다. 고정된 신규 파일의
    중첩 transaction/psql 명령 실수를 거절하기 위한 실행 전 검사다.
    """
    result, current, index = [], [], 0
    while index < len(sql):
        if sql.startswith("--", index):
            end = sql.find("\n", index)
            index = len(sql) if end < 0 else end + 1
            current.append("\n")
        elif sql.startswith("/*", index):
            depth, index = 1, index + 2
            while depth and index < len(sql):
                if sql.startswith("/*", index):
                    depth, index = depth + 1, index + 2
                elif sql.startswith("*/", index):
                    depth, index = depth - 1, index + 2
                else:
                    index += 1
            if depth:
                raise ValueError("UNTERMINATED_SQL_COMMENT")
            current.append(" ")
        elif sql[index] in ("'", '"'):
            start, quote = index, sql[index]
            escaped = quote == "'" and index > 0 and sql[index - 1] in "eE" and (index < 2 or not (sql[index - 2].isalnum() or sql[index - 2] == "_"))
            index += 1
            while index < len(sql):
                if escaped and sql[index] == "\\":
                    index += 2
                elif sql[index] == quote:
                    index += 1
                    if index < len(sql) and sql[index] == quote:
                        index += 1
                    else:
                        break
                else:
                    index += 1
            else:
                raise ValueError("UNTERMINATED_SQL_QUOTE")
            current.append(sql[start:index])
        elif sql[index] == "$" and (match := re.match(r"\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$", sql[index:])):
            tag = match[0]
            end = sql.find(tag, index + len(tag))
            if end < 0:
                raise ValueError("UNTERMINATED_SQL_DOLLAR_QUOTE")
            end += len(tag)
            current.append(sql[index:end])
            index = end
        elif sql[index] == "\\":
            raise ValueError("PSQL_COMMAND_NOT_ALLOWED")
        elif sql[index] == ";":
            value = "".join(current).strip()
            if value:
                result.append(value)
            current, index = [], index + 1
        else:
            current.append(sql[index])
            index += 1
    if "".join(current).strip():
        raise ValueError("SQL_TERMINATOR_REQUIRED")
    return result


def build_script(migration, tests):
    chunks = statements(migration)
    if len(chunks) < 3 or chunks[0].lower() != "begin" or chunks[-1].lower() != "commit":
        raise ValueError("EXPECTED_MIGRATION_WRAPPER")
    body, probes = chunks[1:-1], statements(tests)
    for statement in body + probes:
        if re.match(r"(?is)^(begin|commit|rollback|end|abort|savepoint|release|start\s+transaction|prepare\s+transaction)\b", statement):
            raise ValueError("NESTED_TRANSACTION_NOT_ALLOWED")
    if not probes or not all("EVENT_CHECK:" + name in tests for name in CHECKS):
        raise ValueError("TEST_MARKERS_MISSING")
    absent = """do $$ begin
      assert to_regclass('private.source_events') is null, 'event table already exists';
      assert to_regprocedure('public.upsert_source_events_v1(jsonb)') is null, 'event upsert already exists';
      assert to_regprocedure('public.list_event_candidates_v1(text,text)') is null, 'event list already exists';
      assert to_regprocedure('private.event_calendar_date_v1(text)') is null, 'event date helper already exists';
      assert to_regprocedure('private.event_instant_v1(text)') is null, 'event instant helper already exists';
      assert to_regprocedure('private.event_public_text_v1(text,integer)') is null, 'event text helper already exists';
      assert to_regprocedure('private.valid_source_event_v1(jsonb)') is null, 'event validation helper already exists';
    end $$;"""
    return ("set statement_timeout='20s'; set lock_timeout='5s'; set idle_in_transaction_session_timeout='30s'; set transaction_timeout='60s';\n"
            "begin; set local plpgsql.check_asserts=on;\n" + absent + "\n" +
            ";\n".join(body + probes) + ";\nrollback;\nset plpgsql.check_asserts=on;\n" + absent +
            "\nselect 'EVENT_ROLLBACK_PASS';\n")


def execute(root=ROOT):
    migration, tests = read_source(root, MIGRATION), read_source(root, TEST)
    script = build_script(migration, tests)
    endpoint = db.docker("context", "inspect", db.CONTEXT, "--format", "{{.Endpoints.docker.Host}}")
    expected = "unix://" + str(Path.home() / ".colima/yumidang-minkyu/docker.sock")
    if endpoint.returncode or endpoint.stdout.strip() != expected:
        raise ValueError("DEDICATED_CONTEXT_REQUIRED")
    inspected = db.docker("inspect", db.CONTAINER)
    if inspected.returncode:
        raise ValueError("DEDICATED_CONTAINER_REQUIRED")
    db.validate_target(endpoint.stdout.strip(), json.loads(inspected.stdout)[0])
    with db.SessionLock(73109000):
        result = subprocess.run(db.psql_command(), input=script, capture_output=True, text=True, timeout=90)
    if result.returncode:
        # SQL/psql 원문은 사용자 자료나 연결 문자열을 포함할 수 있어 반환하지 않는다.
        return {"status": "FAIL", "result": "SQL_CHECK_FAILED", "rollback": "NOT_VERIFIED"}
    lines = result.stdout.splitlines()
    observed = {line.removeprefix("EVENT_CHECK:") for line in lines if line.startswith("EVENT_CHECK:")}
    if observed != CHECKS or "EVENT_ROLLBACK_PASS" not in lines:
        return {"status": "FAIL", "result": "CHECK_OR_ROLLBACK_MARKER_MISSING"}
    return {"status": "PASS", "checks": len(CHECKS), "rollback": "PASS", "scope": "local_pending_migration_only",
            "migration_sha256": hashlib.sha256(migration.encode()).hexdigest(), "tests_sha256": hashlib.sha256(tests.encode()).hexdigest()}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, epilog=
        "기본은 NOT_RUN. --run만 전용 Colima/Supabase를 검사합니다. 새 SQL의 외곽 BEGIN/COMMIT을 제거하고 "
        "테스트와 함께 단일 BEGIN/ROLLBACK으로 실행합니다. 실패/시간 초과 시 psql 연결 종료로 rollback됩니다. "
        "정식 이력 목록·기존 마이그레이션·원격 DB는 변경하지 않습니다.")
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args(argv)
    if not args.run:
        report = {"status": "NOT_RUN", "result": "EXPLICIT_RUN_REQUIRED", "migration": str(MIGRATION), "test": str(TEST)}
    else:
        try:
            report = execute()
        except subprocess.TimeoutExpired:
            report = {"status": "FAIL", "result": "LOCAL_CHECK_TIMEOUT", "rollback": "NOT_VERIFIED"}
        except Exception:
            report = {"status": "FAIL", "result": "SOURCE_OR_TARGET_CHECK_FAILED"}
    print(json.dumps(report))
    return 0 if report["status"] == "PASS" else 2 if report["status"] == "NOT_RUN" else 1


if __name__ == "__main__":
    raise SystemExit(main())
