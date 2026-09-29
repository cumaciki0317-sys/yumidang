#!/usr/bin/env python3
"""민규 foundation 하네스의 파일 분리와 담당 소유권을 읽기 검사한다."""

import argparse
import json
import hashlib
from pathlib import Path
import sys

import check_ownership as ownership


MANIFEST = "docs/collaboration/minkyu-foundation-harness.json"


def validate_manifest(data, policy):
    if not isinstance(data, dict) or data.get("version") not in (1, 2):
        raise ownership.CheckError("하네스 version은 1 또는 2이어야 합니다.")
    if data.get("actor") != "minkyu":
        raise ownership.CheckError("이 하네스의 작업자는 minkyu입니다.")
    if not isinstance(data.get("baseline"), str) or not data["baseline"]:
        raise ownership.CheckError("기준 커밋이 필요합니다.")
    if not isinstance(data.get("branch"), str) or not data["branch"]:
        raise ownership.CheckError("전용 브랜치가 필요합니다.")
    lanes = data.get("lanes")
    if not isinstance(lanes, dict) or set(lanes) != {"coordinator", "A", "B", "C"}:
        raise ownership.CheckError("coordinator/A/B/C의 네 작업 범위가 필요합니다.")
    files = {}
    for lane, paths in lanes.items():
        if not isinstance(paths, list) or not paths:
            raise ownership.CheckError(f"{lane}: 비어 있지 않은 파일 목록이 필요합니다.")
        for value in paths:
            if not isinstance(value, str) or value.endswith("/") or any(c in value for c in "*?["):
                raise ownership.CheckError("허용 목록은 디렉터리·glob이 아닌 정확한 파일 경로여야 합니다.")
            path = ownership.normalize_path(value)
            if path in files:
                raise ownership.CheckError(f"중복 수정 영역: {path} ({files[path]}, {lane})")
            if not any(ownership.matches(path, p) for p in policy["protected_paths"]):
                raise ownership.CheckError(f"담당 보호 범위 밖 파일: {path}")
            if ownership.violations(policy, "minkyu", [path]):
                raise ownership.CheckError(f"민규 담당이 아닌 파일: {path}")
            files[path] = lane
    return files


def validate_preserved(data, files, repo, policy):
    preserved = data.get("preserved", {})
    if not isinstance(preserved, dict):
        raise ownership.CheckError("보존 목록은 파일별 SHA256이어야 합니다.")
    for value, digest in preserved.items():
        path = ownership.normalize_path(value)
        if path in files or ownership.violations(policy, "minkyu", [path]):
            raise ownership.CheckError(f"보존 파일과 수정 범위 충돌: {path}")
        source = repo / path
        if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(repo.resolve()):
            raise ownership.CheckError(f"보존 파일이 없거나 유효하지 않습니다: {path}")
        if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
            raise ownership.CheckError(f"이전 단계 산출물 변경: {path}")
    return preserved


def check_paths(files, lane, paths):
    if lane not in {"coordinator", "A", "B", "C"}:
        raise ownership.CheckError(f"알 수 없는 작업 범위: {lane}")
    return [p for p in paths if files.get(p) != lane]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", choices=[MANIFEST, "docs/collaboration/minkyu-db-harness.json", "docs/collaboration/minkyu-runtime-harness.json", "docs/collaboration/minkyu-local-refresh-harness.json", "docs/collaboration/minkyu-search-db-harness.json", "docs/collaboration/minkyu-search-http-harness.json", "docs/collaboration/minkyu-edge-harness.json", "docs/collaboration/minkyu-search-connect-harness.json", "docs/collaboration/minkyu-provider-config-harness.json"], default=MANIFEST)
    parser.add_argument("--lane", choices=["coordinator", "A", "B", "C"])
    parser.add_argument("--paths", nargs="+")
    parser.add_argument("--all-changes", action="store_true")
    args = parser.parse_args(argv)
    if args.all_changes and (args.lane or args.paths):
        parser.error("--all-changes는 --lane/--paths와 함께 사용할 수 없습니다.")
    if not args.all_changes and (not args.lane or not args.paths):
        parser.error("--lane 이름 --paths 파일... 또는 --all-changes를 지정하세요.")
    try:
        repo = Path(__file__).resolve().parents[2]
        data = json.loads((repo / args.manifest).read_text())
        policy, _ = ownership.load_policy(repo)
        files = validate_manifest(data, policy)
        preserved = validate_preserved(data, files, repo, policy)
        branch = ownership.git(repo, "branch", "--show-current").decode().strip()
        head = ownership.git(repo, "rev-parse", "HEAD").decode().strip()
        if branch != data["branch"] or head != data["baseline"]:
            raise ownership.CheckError("하네스의 전용 브랜치·기준 커밋과 일치하지 않습니다.")
        if args.all_changes:
            paths = ownership.parse_name_status(ownership.git(
                repo, "diff", "--name-status", "-z", "--find-renames", data["baseline"], "--"
            ))
            paths += [p.decode("utf-8", "surrogateescape") for p in ownership.git(
                repo, "ls-files", "--others", "--exclude-standard", "-z"
            ).split(b"\0") if p]
            denied = [p for p in paths if p not in files and p not in preserved]
        else:
            paths = [ownership.normalize_path(p, repo=repo) for p in args.paths]
            denied = check_paths(files, args.lane, paths)
        for path in paths:
            candidate = repo / path
            if candidate.is_dir() or candidate.is_symlink():
                raise ownership.CheckError(f"일반 파일만 검사할 수 있습니다: {path}")
            if not candidate.resolve().is_relative_to(repo.resolve()):
                raise ownership.CheckError(f"작업 공간 밖 경로: {path}")
        if denied:
            print("거절: 허용된 작업 범위를 벗어난 파일\n" + "\n".join(sorted(set(denied))), file=sys.stderr)
            return 1
        counts = {lane: sum(files.get(p) == lane for p in set(paths)) for lane in data["lanes"]}
        print(json.dumps({"status": "PASS", "overlap": 0, "files": len(set(paths)), "lanes": counts, "preserved": len(preserved)}, ensure_ascii=False))
        return 0
    except (ownership.CheckError, OSError, ValueError) as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
