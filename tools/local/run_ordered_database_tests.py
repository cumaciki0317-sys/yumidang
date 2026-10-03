#!/usr/bin/env python3
"""사용자 승인 순서의 pending SQL을 전용 기존 로컬 DB에서 단일 적용·검증·rollback한다."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import run_database_tests as db
from run_event_database_tests import read_source, statements

ROOT = Path(__file__).resolve().parents[2]
HEAD28 = Path("backend/supabase/migrations/20260929120000_review_release_and_completion_reservations.sql")
BASE_PENDING = (
    Path("backend/supabase/migrations/20261002090000_naver_signup.sql"),
    Path("backend/supabase/migrations/20261002100000_matching_lifecycle.sql"),
)
# 후속 단계는 해당 단계의 사용자 승인·하네스·구현 후에만 명시 경로로 추가한다.
PHASES = {
    1: {
        "migrations": BASE_PENDING + (Path("backend/supabase/migrations/20261002110000_completion_review_policy.sql"),),
        "tests": (Path("tests/database/minkyu/completion_review_policy.sql"),),
        "markers": {"personal_confirmation_submission_before_completion", "both_early_reviews_wait_for_actual_completion",
                    "actual_completion_metrics_deadline_immutability", "single_review_completed24h_same_gate",
                    "mutual_release_override_consistent", "deadline_boundary_immutable_retry", "blocked_states_resume_remaining",
                    "praise_catalog_validation", "roles_rls_existing_session_permissions", "automatic_completion_actual_time_exclusions"},
    },
}
PHASES[2] = {
    "migrations": PHASES[1]["migrations"] + (Path("backend/supabase/migrations/20261002120000_appointment_changes.sql"),),
    "tests": PHASES[1]["tests"] + (Path("tests/database/minkyu/appointment_changes.sql"),),
    "markers": PHASES[1]["markers"] | {"schedule_proposal_keeps_original_peer_only", "schedule_deadline_boundary_retries",
        "schedule_accept_reservation_generation", "schedule_both_participant_conflicts", "schedule_decline_expiry_keeps_original",
        "cancellation_visibility_chat_reservation", "legacy_cancellation_activity_gate", "schedule_roles_notifications_deduplication"},
}
PHASES[3] = {
    "migrations": (Path("backend/supabase/migrations/20260929100000_event_storage.sql"),) + PHASES[2]["migrations"] +
        (Path("backend/supabase/migrations/20261002130000_ai_budget_worker.sql"),
         Path("backend/supabase/migrations/20261002131000_events_public_profile.sql")),
    "tests": PHASES[2]["tests"] + (Path("tests/database/minkyu/common_connections.sql"),),
    "markers": PHASES[2]["markers"] | {"budget_limits_settlement_overflow", "common_internal_permissions",
        "worker_checkpoint_lease_publish", "worker_revision_checkpoint_invalidation", "worker_empty_insufficient",
        "events_single_canonical_stale_null_url", "events_filters_order_cursor", "public_profile_traits_identity_me_preserved"},
}
JONGHYUN_REGRESSIONS = tuple(Path("tests/database/jonghyun") / name for name in
    ("ai_budget.sql", "review_summary_worker.sql", "profile_traits.sql", "events.sql", "event_filter_values.sql"))


def read_head_source(path):
    source = read_source(ROOT, path)
    tracked = subprocess.run(["git", "show", "HEAD:" + path.as_posix()], cwd=ROOT,
                             capture_output=True, text=True, timeout=15)
    if tracked.returncode or tracked.stdout != source:
        raise ValueError("HEAD_SOURCE_MISMATCH")
    return source


def absent_probe():
    return """do $$ begin
      assert to_regclass('private.naver_accounts') is null;
      assert to_regclass('private.naver_sessions') is null;
      assert to_regclass('private.profile_traits') is null;
      assert to_regclass('private.match_consent_lifecycle') is null;
      assert to_regclass('private.match_lifecycle_events') is null;
      assert to_regprocedure('public.get_review_praise_catalog()') is null;
      assert to_regprocedure('private.can_submit_appointment_review(uuid,uuid,timestamp with time zone)') is null;
      assert to_regprocedure('private.is_review_public_eligible(uuid)') is null;
      assert to_regclass('private.appointment_schedule_changes') is null;
      assert to_regclass('private.appointment_cancellations') is null;
      assert to_regclass('private.source_events') is null;
      assert to_regclass('private.events') is null;
      assert to_regclass('private.ai_budget_ledgers') is null;
      assert to_regclass('private.ai_budget_reservations') is null;
      assert to_regclass('private.review_summary_checkpoints') is null;
      assert to_regclass('private.review_summary_job_publications') is null;
      assert not exists(select 1 from information_schema.columns where table_schema='private'
        and table_name='review_praise_catalog' and column_name in('is_active','display_order'));
      assert not exists(select 1 from auth.users where id between
        '91000000-0000-4000-8000-000000000001'::uuid and '91000000-0000-4000-8000-000000000003'::uuid);
      assert not exists(select 1 from public.posts where id between
        '93000000-0000-4000-8000-000000000001'::uuid and '93000000-0000-4000-8000-000000000013'::uuid);
      assert not exists(select 1 from public.appointments where id between
        '94000000-0000-4000-8000-000000000001'::uuid and '94000000-0000-4000-8000-000000000013'::uuid);
      assert not exists(select 1 from auth.users where id between
        '61000000-0000-4000-8000-000000000001'::uuid and '61000000-0000-4000-8000-000000000006'::uuid);
      assert not exists(select 1 from auth.users where id between
        '71000000-0000-4000-8000-000000000001'::uuid and '71000000-0000-4000-8000-000000000003'::uuid);
    end $$;"""


def build_script(migrations, tests, phase=1, prelude=(), regressions=(), regression_paths=None):
    if phase not in PHASES:
        raise ValueError("UNAUTHORIZED_PHASE")
    config = PHASES[phase]
    if len(migrations) != len(config["migrations"]) or len(tests) != len(config["tests"]):
        raise ValueError("UNEXPECTED_PHASE_SOURCES")
    chunks, probes = [statements(source) for source in list(prelude) + migrations], [statements(source) for source in tests]
    if any(not part or part[0].lower() != "begin" or part[-1].lower() != "commit" for part in chunks):
        raise ValueError("EXPECTED_MIGRATION_WRAPPER")
    if any(not part or part[0].lower() != "begin" or part[-1].lower() != "rollback" for part in probes):
        raise ValueError("EXPECTED_TEST_WRAPPER")
    setup = [statement for part in chunks[:len(prelude)] for statement in part[1:-1]]
    body = [statement for part in chunks[len(prelude):] + probes for statement in part[1:-1]]
    if regressions:
        selected = JONGHYUN_REGRESSIONS if regression_paths is None else tuple(regression_paths)
        if phase != 3 or len(regressions) != len(selected) or not set(selected)<=set(JONGHYUN_REGRESSIONS) or len(set(selected))!=len(selected):
            raise ValueError("UNAUTHORIZED_REGRESSION_SOURCES")
        for index, source in enumerate(regressions):
            body.extend(statements(source))
            body.append("select 'ORDERED_REGRESSION:" + selected[index].stem + "'")
    if any(re.match(r"(?is)^(begin|commit|rollback|end|abort|savepoint|release|start\s+transaction|prepare\s+transaction)\b", statement) for statement in setup + body):
        raise ValueError("NESTED_TRANSACTION_NOT_ALLOWED")
    combined_tests = "\n".join(tests)
    if not all("ORDERED_CHECK:" + name in combined_tests for name in config["markers"]):
        raise ValueError("TEST_MARKERS_MISSING")
    dependencies = """do $$ begin
      assert to_regprocedure('public.get_appointment_review_state(uuid)') is not null;
      assert to_regprocedure('public.submit_appointment_review(uuid,integer,text,text,text[])') is not null;
      assert to_regclass('private.review_praise_catalog') is not null;
      assert position('24 hours' in pg_get_functiondef('private.review_release_ready(uuid)'::regprocedure))>0;
      assert to_regclass('private.completion_reservations') is not null;
    end $$;"""
    return ("set statement_timeout='30s';set lock_timeout='5s';set idle_in_transaction_session_timeout='30s';set transaction_timeout='150s';\n"
            "begin;set local plpgsql.check_asserts=on;\n" + absent_probe() + "\nselect 'ORDERED_STAGE:baseline_absent';\n" +
            (";\n".join(setup) + ";\n" if setup else "") + dependencies + "\nselect 'ORDERED_STAGE:baseline_dependencies';\n" +
            ";\n".join(body) + ";\nreset role;rollback;\nset plpgsql.check_asserts=on;\n" + absent_probe() +
            "\nselect 'ORDERED_ROLLBACK_PASS';\n")


def baseline_snapshot(command):
    # 정의/예약내용은 출력하지 않고 지문만 비교한다. cron 변경도 같은 txn 롤백에 포함된다.
    query = """begin;select jsonb_build_object(
      'versions',(select jsonb_agg(version order by version) from supabase_migrations.schema_migrations),
      'reservationTable',to_regclass('private.completion_reservations') is not null,
      'reservationRPC',to_regprocedure('public.list_completion_reservations()') is not null,
      'tables',(select md5(string_agg(n.nspname||'.'||c.relname||':'||c.relkind::text,',' order by n.nspname,c.relname))
        from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('private','public')),
      'routines',(select md5(string_agg(p.oid::text||':'||pg_get_functiondef(p.oid),',' order by p.oid))
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('private','public') and p.prokind in('f','p')),
      'cron',(select md5(coalesce(jsonb_agg(to_jsonb(j) order by jobid)::text,'[]')) from cron.job j));rollback;"""
    result = subprocess.run(command, input=query, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError("BASELINE_SNAPSHOT_FAILED")
    rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
    if len(rows) != 1:
        raise ValueError("BASELINE_SNAPSHOT_INVALID")
    return rows[0]


def execute(phase=1, include_jonghyun=False, test=None):
    if phase not in PHASES:
        raise ValueError("UNAUTHORIZED_PHASE")
    config = PHASES[phase]
    sources = [read_source(ROOT, path) for path in config["migrations"]]
    tests = [read_source(ROOT, path) for path in config["tests"]]
    if (include_jonghyun or test is not None) and phase != 3:
        raise ValueError("UNAUTHORIZED_REGRESSION_PHASE")
    selected_regressions = JONGHYUN_REGRESSIONS if include_jonghyun else (() if test is None else (Path(test),))
    if not set(selected_regressions)<=set(JONGHYUN_REGRESSIONS):
        raise ValueError("UNAUTHORIZED_REGRESSION_SOURCE")
    regressions = [read_head_source(path) for path in selected_regressions]
    endpoint = db.docker("context", "inspect", db.CONTEXT, "--format", "{{.Endpoints.docker.Host}}")
    expected = "unix://" + str(Path.home() / ".colima/yumidang-minkyu/docker.sock")
    if endpoint.returncode or endpoint.stdout.strip() != expected:
        raise ValueError("DEDICATED_CONTEXT_REQUIRED")
    inspection = db.docker("inspect", db.CONTAINER)
    if inspection.returncode:
        raise ValueError("DEDICATED_CONTAINER_REQUIRED")
    db.validate_target(endpoint.stdout.strip(), json.loads(inspection.stdout)[0])
    command = db.psql_command()
    # 원문은 0600 임시 진단 파일에만 보관한다. stdout 보고에는 SQLSTATE·함수 위치만 허용한다.
    command[-1] = "VERBOSITY=verbose"
    with db.SessionLock(73109000):
        baseline = baseline_snapshot(command)
        versions = baseline["versions"]
        if len(versions) not in(27,28) or versions[-1] != ("20260929090000" if len(versions)==27 else "20260929120000"):
            raise ValueError("UNSUPPORTED_BASELINE")
        if baseline["reservationTable"] != (len(versions)==28) or baseline["reservationRPC"] != (len(versions)==28):
            raise ValueError("BASELINE_OBJECT_MISMATCH")
        prelude = []
        if len(versions)==27:
            prelude.append(read_head_source(HEAD28))
        script = build_script(sources, tests, phase, prelude, regressions, selected_regressions)
        result = subprocess.run(command, input=script, capture_output=True, text=True, timeout=180)
        rollback = subprocess.run(command, input="begin;set local plpgsql.check_asserts=on;\n" + absent_probe() +
                                  "\nrollback;select 'ORDERED_ROLLBACK_PASS';\n", capture_output=True, text=True, timeout=30)
        baseline_preserved = baseline_snapshot(command) == baseline
    if result.returncode:
        descriptor, diagnostic = tempfile.mkstemp(prefix="yumidang-ordered-sql-", suffix=".log")
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(result.stdout + "\n" + result.stderr)
        state = re.search(r"(?m)^ERROR:\s+([0-9A-Z]{5})\b", result.stderr)
        completed = sorted({line.removeprefix("ORDERED_CHECK:") for line in result.stdout.splitlines()
                            if line.startswith("ORDERED_CHECK:") and line.removeprefix("ORDERED_CHECK:") in config["markers"]})
        locations = re.findall(r"PL/pgSQL function ([a-zA-Z_][a-zA-Z_0-9.]*\([^\n)]*\)|inline_code_block) line ([0-9]+) at ([A-Z]+)", result.stderr)
        stages = [line.removeprefix("ORDERED_STAGE:") for line in result.stdout.splitlines()
                  if line in {"ORDERED_STAGE:baseline_absent", "ORDERED_STAGE:baseline_dependencies", "ORDERED_STAGE:synthetic_fixtures"}]
        return {"status": "FAIL", "phase": phase, "result": "SQL_CHECK_FAILED",
                "rollback": "PASS" if baseline_preserved and rollback.returncode == 0 and "ORDERED_ROLLBACK_PASS" in rollback.stdout.splitlines() else "FAIL",
                "sqlstate": state[1] if state else "UNKNOWN", "completedChecks": completed, "completedStages": stages,
                "errorLocations": [{"function": name, "line": int(line), "operation": operation} for name, line, operation in locations],
                "diagnosticFile": diagnostic}
    lines = result.stdout.splitlines()
    observed = {line.removeprefix("ORDERED_CHECK:") for line in lines if line.startswith("ORDERED_CHECK:")}
    expected_regressions = {path.stem for path in selected_regressions}
    actual_regressions = {line.removeprefix("ORDERED_REGRESSION:") for line in lines if line.startswith("ORDERED_REGRESSION:")}
    if observed != config["markers"] or actual_regressions != expected_regressions or "ORDERED_ROLLBACK_PASS" not in lines or not baseline_preserved or rollback.returncode:
        return {"status": "FAIL", "result": "CHECK_OR_ROLLBACK_MARKER_MISSING", "phase": phase}
    return {"status": "PASS", "phase": phase, "checks": len(config["markers"]), "rollback": "PASS",
            "pendingMigrations": len(sources), "scope": "local_pending_migrations_only",
            "baselineMigrations": len(versions), "transactionalBaselinePrelude": len(prelude),
            "jonghyunRegressions": [path.as_posix() for path in selected_regressions],
            "source_sha256": [hashlib.sha256(source.encode()).hexdigest() for source in prelude + sources + tests + regressions]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--phase", type=int, choices=sorted(PHASES), default=1)
    regression = parser.add_mutually_exclusive_group()
    regression.add_argument("--include-jonghyun-regression", action="store_true", help="3단계에서 정식 종현 SQL 검사5개를 읽기만 재생")
    regression.add_argument("--test", choices=[path.as_posix() for path in JONGHYUN_REGRESSIONS],
                            help="정식 검사1개를 별도 누적 트랜잭션으로 재생하여 fixture/기대 차이를 격리")
    args = parser.parse_args(argv)
    report = {"status": "NOT_RUN", "phase": args.phase, "result": "EXPLICIT_RUN_REQUIRED"}
    if args.run:
        try:
            report = execute(args.phase, args.include_jonghyun_regression, args.test)
        except subprocess.TimeoutExpired:
            report = {"status": "FAIL", "phase": args.phase, "result": "LOCAL_CHECK_TIMEOUT", "rollback": "NOT_VERIFIED"}
        except Exception:
            report = {"status": "FAIL", "phase": args.phase, "result": "SOURCE_OR_TARGET_CHECK_FAILED"}
    print(json.dumps(report))
    return 0 if report["status"] == "PASS" else 2 if report["status"] == "NOT_RUN" else 1


if __name__ == "__main__":
    raise SystemExit(main())
