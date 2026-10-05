#!/usr/bin/env python3
"""본인 clone에 기존 소유권 hook을 연결한다. 기존 설정은 무단 교체하지 않는다."""
import argparse
from pathlib import Path
import subprocess
import sys

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--actor", choices=("minkyu", "jonghyun", "sungho"), required=True)
    actor = parser.parse_args().actor
    root = Path(__file__).resolve().parents[2]
    def git(*args):
        return subprocess.run(["git", "-C", str(root), *args], text=True, capture_output=True)
    current = git("config", "--local", "--get", "yumidang.actor").stdout.strip()
    hook = git("config", "--get", "core.hooksPath").stdout.strip()
    branch = git("branch", "--show-current")
    if branch.returncode or not branch.stdout.strip().startswith(actor + "/"):
        print("본인 담당 이름/으로 시작하는 별도 브랜치에서 실행하세요.", file=sys.stderr)
        return 1
    if current and current != actor:
        print("다른 담당자의 clone 설정을 변경하지 않습니다. 본인의 별도 clone을 사용하세요.", file=sys.stderr)
        return 1
    if hook and hook != ".githooks":
        print("기존 custom hook을 덮어쓰지 않습니다. 연결 방식을 먼저 검토하세요.", file=sys.stderr)
        return 1
    for key, value in [("yumidang.actor", actor), ("core.hooksPath", ".githooks")]:
        if git("config", "--local", key, value).returncode:
            return 1
    print("준비 완료: " + actor + " 담당 검사·커밋 hook")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
