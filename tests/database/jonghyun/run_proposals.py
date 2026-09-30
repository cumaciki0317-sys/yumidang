#!/usr/bin/env python3
"""종현 제안 SQL 격리 검증 도구.

전용 로컬 Supabase(Colima yumidang-minkyu / project yumidang-minkyu-db)에서만 실행한다.
각 검사 파일마다 `BEGIN → 제안 SQL(지정 순서) → 검사 SQL → ROLLBACK`을 한 세션에서 수행하므로
제안 스키마·가상 자료가 DB에 남지 않는다. 원격 URL·키 입력을 받지 않는다.
제안 SQL은 민규가 정식 마이그레이션으로 채택하기 전의 초안이며 이 검증은 채택·배포가 아니다.

사용:
  python3 -B tests/database/jonghyun/run_proposals.py \
    --proposal docs/collaboration/requests/jonghyun/2026-09-29-claude-proposed-sql/01_ai_budget.sql \
    --test tests/database/jonghyun/ai_budget.sql
  --all : 제안 폴더의 모든 SQL(이름순)과 이 폴더의 모든 검사 SQL을 함께 실행
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CONTEXT = "colima-yumidang-minkyu"
PROJECT = "yumidang-minkyu-db"
CONTAINER = "supabase_db_" + PROJECT
PROPOSALS = ROOT / "docs/collaboration/requests/jonghyun/2026-09-29-claude-proposed-sql"
TESTS = Path(__file__).resolve().parent
LOCK_KEY = 2026092901
TRANSACTION_CONTROL = re.compile(r"^\s*(begin|commit|rollback|start\s+transaction|end)\s*;", re.I | re.M)


def fail(message):
    print("BLOCKED: " + message)
    sys.exit(2)


def check_target():
    expected = "unix://" + str(Path.home() / ".colima/yumidang-minkyu/docker.sock")
    ctx = subprocess.run(["docker", "context", "inspect", CONTEXT], capture_output=True, text=True, timeout=20)
    if ctx.returncode != 0:
        fail("전용 Colima docker context가 없습니다.")
    endpoint = json.loads(ctx.stdout)[0]["Endpoints"]["docker"]["Host"]
    if endpoint != expected:
        fail("전용 Colima 로컬 소켓만 허용합니다.")
    info = subprocess.run(["docker", "--context", CONTEXT, "inspect", CONTAINER], capture_output=True, text=True, timeout=20)
    if info.returncode != 0:
        fail("전용 Supabase DB 컨테이너가 없습니다.")
    container = json.loads(info.stdout)[0]
    if container.get("Config", {}).get("Labels", {}).get("com.supabase.cli.project") != PROJECT:
        fail("전용 Supabase 프로젝트 컨테이너가 아닙니다.")
    if not container.get("State", {}).get("Running"):
        fail("로컬 DB가 실행 중이 아닙니다.")


def psql(script, timeout):
    command = ["docker", "--context", CONTEXT, "exec", "-i", CONTAINER, "psql", "-X", "-qAt",
               "-h", "/var/run/postgresql", "-p", "5432", "-U", "postgres", "-d", "postgres",
               "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=default"]
    return subprocess.run(command, input=script.encode(), capture_output=True, timeout=timeout)


def load_sql(path):
    text = path.read_text(encoding="utf-8")
    # 함수·DO 본문($$...$$)의 plpgsql begin/end는 트랜잭션 제어가 아니므로 제외하고 검사한다.
    outside = re.sub(r"\$\$.*?\$\$", "", text, flags=re.S)
    if TRANSACTION_CONTROL.search(outside):
        fail(f"{path.name}: 제안/검사 SQL에 트랜잭션 제어문을 넣지 않습니다.")
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--proposal", action="append", default=[])
    parser.add_argument("--test", action="append", default=[])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    proposals = sorted(PROPOSALS.glob("*.sql")) if args.all else [ROOT / p for p in args.proposal]
    tests = sorted(TESTS.glob("*.sql")) if args.all else [ROOT / t for t in args.test]
    if not tests:
        fail("검사 SQL이 필요합니다.")
    check_target()
    empty = psql("select (select count(*) from auth.users)+(select count(*) from public.profiles);", 30)
    if empty.returncode != 0 or empty.stdout.decode().strip() != "0":
        fail("가상 자료만 쓰는 빈 전용 DB가 아닙니다(사용자/프로필 존재).")
    proposal_sql = "\n".join(f"-- proposal: {p.name}\n" + load_sql(p) for p in proposals)
    failed = 0
    for test in tests:
        script = (f"begin;\nselect pg_advisory_xact_lock({LOCK_KEY});\nset local client_min_messages = warning;\n"
                  f"{proposal_sql}\n-- test: {test.name}\n{load_sql(test)}\nrollback;\n")
        result = psql(script, args.timeout)
        if result.returncode == 0:
            print(f"PASS {test.relative_to(ROOT)}")
        else:
            failed += 1
            lines = [line for line in result.stderr.decode(errors="replace").splitlines() if line.strip()]
            print(f"FAIL {test.relative_to(ROOT)}")
            for line in lines[-6:]:
                print("  " + line[:400])
    print(f"proposals={[p.name for p in proposals]} tests={len(tests)} failed={failed} (transaction rolled back)")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
