#!/usr/bin/env python3
"""Check backend file ownership without changing files or Git configuration.

Usage: python3 tools/collaboration/check_ownership.py --actor jonghyun --staged
       python3 tools/collaboration/check_ownership.py --actor minkyu --paths PATH ...

Exit codes: 0 allowed, 1 ownership violation, 2 invalid input/configuration/Git error.
The actor is a collaboration declaration, not an authenticated identity.
"""

import argparse
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys


MANIFEST = "backend/ownership.json"
ACTORS = ("minkyu", "jonghyun", "sungho")


class CheckError(Exception):
    """An invalid invocation or unusable policy must never silently pass."""


def git(repo, *args):
    result = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, check=False
    )
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise CheckError(f"Git 실패 ({' '.join(args)}): {detail}")
    return result.stdout


def normalize_path(value, repo=None, allow_prefix=False):
    if not isinstance(value, str) or not value or "\0" in value:
        raise CheckError(f"유효하지 않은 경로: {value!r}")
    if not allow_prefix and value.endswith("/"):
        raise CheckError(f"디렉터리 대신 작성할 파일 경로를 지정하세요: {value!r}")
    if ".." in PurePosixPath(value).parts:
        raise CheckError(f"상위 디렉터리(..) 경로는 사용할 수 없습니다: {value!r}")
    prefix = allow_prefix and value.endswith("/")
    path = PurePosixPath(value)
    if path.is_absolute():
        if repo is None:
            raise CheckError(f"정책 경로는 저장소 상대 경로여야 합니다: {value!r}")
        try:
            # macOS may expose the same checkout through /var and /private/var.
            path = PurePosixPath(Path(value).resolve().relative_to(repo.resolve()).as_posix())
        except ValueError as exc:
            raise CheckError(f"저장소 밖 경로: {value!r}") from exc
    if str(path) == ".":
        raise CheckError("저장소 루트 대신 파일 경로를 지정하세요.")
    return path.as_posix() + ("/" if prefix else "")


def matches(path, pattern):
    return path.startswith(pattern) if pattern.endswith("/") else path == pattern


def validate_policy(data):
    if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1:
        raise CheckError("ownership.json version은 정수 1이어야 합니다.")
    protected = data.get("protected_paths")
    rules = data.get("rules")
    if not isinstance(protected, list) or not protected or not isinstance(rules, list):
        raise CheckError("protected_paths는 비어 있지 않은 배열, rules는 배열이어야 합니다.")
    protected = [normalize_path(item, allow_prefix=True) for item in protected]
    validated = []
    seen = set()
    for rule in rules:
        if not isinstance(rule, dict) or rule.get("owner") not in ACTORS:
            raise CheckError(f"유효하지 않은 담당 규칙: {rule!r}")
        path = normalize_path(rule.get("path"), allow_prefix=True)
        if path in seen:
            raise CheckError(f"중복 담당 경로: {path!r}")
        seen.add(path)
        validated.append({"path": path, "owner": rule["owner"]})
    return {"protected_paths": protected, "rules": validated}


def load_policy(repo):
    # Read committed policy first: staging a replacement cannot grant ownership.
    head = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--verify", "--quiet", "HEAD"],
        capture_output=True, check=False,
    )
    if head.returncode not in (0, 1):
        raise CheckError("Git HEAD를 확인하지 못했습니다.")
    committed = head.returncode == 0 and bool(git(repo, "ls-tree", "-z", "HEAD", "--", MANIFEST))
    if committed:
        raw = git(repo, "show", f"HEAD:{MANIFEST}")
        source = f"HEAD:{MANIFEST}"
    else:
        try:
            raw = (repo / MANIFEST).read_bytes()
        except OSError as exc:
            raise CheckError(f"초기 담당 정책을 읽을 수 없습니다: {exc}") from exc
        source = f"working tree:{MANIFEST}"
        print("안내: HEAD에 담당 정책이 없어 작업 폴더 정책을 사용합니다. 초기 합의 후 커밋하세요.", file=sys.stderr)
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise CheckError(f"담당 정책 JSON 오류: {exc}") from exc
    return validate_policy(data), source


def parse_name_status(raw):
    """Parse NUL-separated Git output; rename/copy source AND target are checked."""
    if not raw:
        return []
    fields = raw.split(b"\0")
    if fields.pop() != b"":
        raise CheckError("Git 변경 목록의 NUL 종료가 누락됐습니다.")
    paths = []
    position = 0
    while position < len(fields):
        status = fields[position].decode("ascii", errors="replace")
        position += 1
        if not status or status[0] not in "ACDMRTUXB":
            raise CheckError(f"알 수 없는 Git 변경 상태: {status!r}")
        count = 2 if status[0] in "RC" else 1
        if position + count > len(fields):
            raise CheckError("Git 변경 목록의 파일 경로가 누락됐습니다.")
        for item in fields[position:position + count]:
            paths.append(item.decode("utf-8", errors="surrogateescape"))
        position += count
    return paths


def violations(policy, actor, paths):
    denied = []
    for path in dict.fromkeys(paths):
        if actor != "sungho" and not any(matches(path, pattern) for pattern in policy["protected_paths"]):
            continue
        rules = [rule for rule in policy["rules"] if matches(path, rule["path"])]
        owner = max(rules, key=lambda rule: len(rule["path"]))["owner"] if rules else None
        if owner != actor:
            denied.append((path, owner))
    return denied


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--actor", choices=ACTORS, required=True)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--staged", action="store_true", help="스테이징된 변경 검사 (기본값)")
    group.add_argument("--paths", nargs="+", metavar="PATH", help="작성 전 저장소 상대 경로 검사")
    group.add_argument("--diff", nargs=2, metavar=("BASE", "HEAD"), help="PR 기준 두 커밋 사이 변경 검사")
    args = parser.parse_args(argv)
    try:
        candidate = Path(__file__).resolve().parents[2]
        repo = Path(git(candidate, "rev-parse", "--show-toplevel").decode().strip())
        policy, source = load_policy(repo)
        if args.diff:
            paths = parse_name_status(git(repo, "diff", "--name-status", "-z", "--find-renames", *args.diff, "--"))
        else:
            paths = args.paths if args.paths is not None else parse_name_status(
            git(repo, "diff", "--cached", "--name-status", "-z", "--find-renames", "--")
        )
        paths = [normalize_path(path, repo=repo) for path in paths]
        if args.paths is not None:
            for path in paths:
                if (repo / path).is_dir():
                    raise CheckError(f"디렉터리 대신 작성할 파일 경로를 지정하세요: {path!r}")
            resolved_paths = []
            for path in paths:
                try:
                    resolved = (repo / path).resolve().relative_to(repo.resolve()).as_posix()
                except ValueError as exc:
                    raise CheckError(f"링크 대상이 저장소 밖입니다: {path!r}") from exc
                resolved_paths.append(resolved)
            paths.extend(resolved_paths)
        denied = violations(policy, args.actor, paths)
        if denied:
            for path, owner in denied:
                print(f"거절: {path!r} — 담당: {owner or '미배정'}, 작업자: {args.actor}", file=sys.stderr)
            print("다른 담당 파일을 직접 수정하지 말고 담당자에게 변경 요청을 전달하세요.", file=sys.stderr)
            return 1
        print(f"통과: {len(set(paths))}개 경로, 작업자 {args.actor}, 정책 {source}")
        return 0
    except (CheckError, OSError) as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
