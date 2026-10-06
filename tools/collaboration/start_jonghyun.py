#!/usr/bin/env python3
"""종현 실행 패키지를 검증하고 새 clone에서 담당 작업을 시작한다."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time


REMOTE = "https://github.com/jjackbb/yumidang.git"
BASE_REF = "refs/heads/minkyu/jonghyun-start-base"
TASK_PATH = "docs/collaboration/requests/minkyu/2026-10-05-jonghyun-start-task.md"


def git(*args, cwd=None):
    result = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True)
    if result.returncode:
        # URL에 포함될 수 있는 사용자 자격증명/환경값을 로그에 복제하지 않는다.
        raise RuntimeError("Git 준비에 실패했습니다. 원본 폴더는 변경하지 않았습니다.")
    return result.stdout.strip()


def verify_package(package):
    package = package.resolve(strict=True)
    metadata_path = package / "package.json"
    if metadata_path.is_symlink() or not metadata_path.is_file():
        raise RuntimeError("패키지 설명 파일이 올바르지 않습니다.")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if not isinstance(metadata, dict):
        raise RuntimeError("패키지 설명 형식이 올바르지 않습니다.")
    if metadata.get("version") != 1 or metadata.get("remote") != REMOTE or metadata.get("baseRef") != BASE_REF:
        raise RuntimeError("지원하지 않는 실행 패키지입니다.")
    for key in ("sourceHead", "handoffCommit"):
        if not re.fullmatch(r"[a-f0-9]{40}", str(metadata.get(key, ""))):
            raise RuntimeError("패키지 커밋 정보가 올바르지 않습니다.")
    files = metadata.get("files")
    if not isinstance(files, dict) or set(files) != {"repository.bundle", "TASK.md", "start_jonghyun.py"}:
        raise RuntimeError("패키지 파일 목록이 올바르지 않습니다.")
    for name, digest in files.items():
        path = package / name
        if path.is_symlink() or not path.is_file() or not re.fullmatch(r"[a-f0-9]{64}", str(digest)):
            raise RuntimeError("패키지 파일이 없거나 올바르지 않습니다.")
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError("패키지 내용이 변경됐습니다. 원본 패키지를 다시 받으세요.")
    return package, metadata


def prepare_clone(package, metadata, source, target):
    """기존 clone의 설정/인덱스는 읽기만 하며 모든 변경은 새 clone에 한정한다."""
    if target.exists() or target.is_symlink():
        raise RuntimeError("대상 폴더가 이미 있습니다. 새 폴더를 지정하세요.")
    if source is not None:
        source = Path(git("rev-parse", "--show-toplevel", cwd=source)).resolve()
        if target.resolve().is_relative_to(source):
            raise RuntimeError("원본 저장소 밖의 새 작업 폴더를 지정하세요.")
        git("cat-file", "-e", metadata["sourceHead"] + "^{commit}", cwd=source)
        git("clone", "--no-hardlinks", "--no-checkout", str(source), str(target))
    else:
        git("clone", "--no-checkout", REMOTE, str(target))
        git("cat-file", "-e", metadata["sourceHead"] + "^{commit}", cwd=target)
    git("bundle", "verify", str(package / "repository.bundle"), cwd=target)
    git("fetch", str(package / "repository.bundle"), BASE_REF + ":" + BASE_REF, cwd=target)
    if git("rev-parse", BASE_REF, cwd=target) != metadata["handoffCommit"]:
        raise RuntimeError("가져온 작업 기준이 검토한 커밋과 다릅니다.")
    if git("rev-parse", metadata["handoffCommit"] + "^", cwd=target) != metadata["sourceHead"]:
        raise RuntimeError("작업 전달 커밋의 기준 버전이 일치하지 않습니다.")
    branch = "jonghyun/queue-integration-" + time.strftime("%Y%m%d-%H%M%S")
    git("checkout", "-b", branch, metadata["handoffCommit"], cwd=target)
    if (target / TASK_PATH).read_bytes() != (package / "TASK.md").read_bytes():
        raise RuntimeError("작업 지시와 코드 버전이 일치하지 않습니다.")
    # 명시적 종현 작업 시작용 새 clone에만 역할과 기존 소유권 hook을 적용한다.
    git("config", "--local", "remote.origin.url", REMOTE, cwd=target)
    git("config", "--local", "yumidang.actor", "jonghyun", cwd=target)
    git("config", "--local", "core.hooksPath", ".githooks", cwd=target)
    return branch


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--repo", type=Path, help="기존 유미당 clone. 생략하면 현재 Git 폴더 또는 공식 원격 저장소를 사용")
    parser.add_argument("--target", type=Path, help="새 종현 작업 폴더")
    parser.add_argument("--check", action="store_true", help="패키지만 검사하며 clone/Codex 실행 없음")
    parser.add_argument("--prepare-only", action="store_true", help="새 clone까지 준비하며 Codex 실행 없음")
    args = parser.parse_args(argv)
    try:
        package, metadata = verify_package(args.package)
        if args.check:
            print("PASS: 패키지 파일·버전 일치. clone/설정/Codex 실행 없음.")
            return 0
        if not shutil.which("git"):
            raise RuntimeError("Git 설치가 필요합니다.")
        codex = shutil.which("codex")
        if not args.prepare_only and not codex:
            raise RuntimeError("Codex CLI 설치·로그인이 필요합니다. TASK.md에는 그대로 사용할 작업 지시가 있습니다.")
        source = args.repo
        if source is None:
            probe = subprocess.run(["git", "rev-parse", "--show-toplevel"], text=True, capture_output=True)
            if probe.returncode == 0:
                source = Path(probe.stdout.strip())
        target_parent = source.resolve().parent if source is not None else Path.cwd()
        target = (args.target or target_parent / ("yumidang-jonghyun-" + time.strftime("%Y%m%d-%H%M%S"))).absolute()
        branch = prepare_clone(package, metadata, source, target)
        print(f"종현 작업 폴더: {target}\n브랜치: {branch}\n담당: jonghyun", flush=True)
        if args.prepare_only:
            print("준비 완료. 이 폴더의 TASK 문서로 Codex 작업을 시작할 수 있습니다.")
            return 0
        prompt = (package / "TASK.md").read_text(encoding="utf-8")
        os.execv(codex, [codex, "--cd", str(target), "--sandbox", "workspace-write",
                        "--ask-for-approval", "on-request", prompt])
    except (RuntimeError, OSError, ValueError) as error:
        print(f"시작 준비 중단: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
