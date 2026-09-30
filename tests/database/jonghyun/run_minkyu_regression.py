#!/usr/bin/env python3
"""종현 제안 SQL 회귀(lane S 작성, 총괄 이동): minkyu SQL 검사(자체 begin/rollback 포함)를 줄 단위로 제거한 임시 사본으로
BEGIN → 제안 SQL → 검사 → ROLLBACK 실행한다. minkyu 파일은 수정하지 않는다.
사용: python3 -B tests/database/jonghyun/run_minkyu_regression.py "<제안1>,<제안2>" "<검사1>,<검사2>"  (제안 없이 비교할 때 첫 인수는 "")
전용 로컬 Colima yumidang-minkyu / supabase_db_yumidang-minkyu-db만 대상으로 한다."""
import re, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
CONTEXT, CONTAINER = "colima-yumidang-minkyu", "supabase_db_yumidang-minkyu-db"
proposals = [ROOT / p for p in sys.argv[1].split(",") if p]
tests = [ROOT / t for t in sys.argv[2].split(",")]
ctrl = re.compile(r"^\s*(begin|commit|rollback)\s*;\s*$", re.I)
def strip(text):
    # $$ 본문 밖의 단독 begin;/rollback; 줄만 제거한다.
    out, inside = [], False
    for line in text.splitlines():
        if not inside and ctrl.match(line):
            continue
        if line.count("$$") % 2 == 1:
            inside = not inside
        out.append(line)
    return "\n".join(out)
prop = "\n".join(p.read_text() for p in proposals)
failed = 0
for t in tests:
    script = f"begin;\nselect pg_advisory_xact_lock(2026092901);\nset local client_min_messages = warning;\n{prop}\n{strip(t.read_text())}\nrollback;\n"
    r = subprocess.run(["docker", "--context", CONTEXT, "exec", "-i", CONTAINER, "psql", "-X", "-qAt", "-U", "postgres",
                        "-d", "postgres", "-v", "ON_ERROR_STOP=1"], input=script.encode(), capture_output=True, timeout=300)
    ok = r.returncode == 0
    failed += not ok
    print(("PASS " if ok else "FAIL ") + str(t.relative_to(ROOT)) + f" (proposals={[p.name for p in proposals]})")
    if not ok:
        for line in r.stderr.decode(errors="replace").splitlines()[-6:]:
            print("  " + line[:400])
sys.exit(1 if failed else 0)
