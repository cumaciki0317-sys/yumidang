#!/usr/bin/env python3
"""원격에서 확인한 20개 버전만 HEAD의 정식 SQL에서 로컬 DB 재생용으로 준비한다."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tomllib

from prepare_migrations import MIGRATIONS, PreparationError, git, inspect_migrations
from prepare_edge import validate_reviewed_migration_history

PROJECT = "yumidang-minkyu-drift"
PORTS = {"api": 56531, "db": 56532, "db.pooler": 56539, "studio": 56533,
         "local_smtp": 56534, "analytics": 56537}
FUNCTIONS = {"service-api", "signup", "ai-chat", "places", "event-sync", "review-summary-worker", "scheduled-jobs"}
CONFIG = Path("backend/supabase/config.toml")


def require(condition, message):
    if not condition:
        raise PreparationError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, base):
    require(path.is_absolute() and path.resolve() == path and path.is_relative_to(base), "경로는 허용된 기준 내부의 절대 경로여야 합니다.")
    require(all(not part.is_symlink() for part in (path, *path.parents)), "심볼릭 링크 경로는 허용하지 않습니다.")
    info = path.stat()
    require(path.is_file() and info.st_nlink == 1 and info.st_size <= 8 * 1024 * 1024, "일반 단일 파일만 읽을 수 있습니다.")
    return path.read_bytes()


def read_versions(path):
    path = Path(path)
    data = regular(path, Path("/private/tmp"))
    info, parent = path.stat(), path.parent.stat()
    require(info.st_uid == os.getuid() and info.st_mode & 0o777 == 0o600 and
            parent.st_uid == os.getuid() and parent.st_mode & 0o777 == 0o700,
            "버전 입력은 본인 소유의 0700 폴더와 0600 파일이어야 합니다.")
    try:
        versions = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PreparationError("버전 입력은 JSON 배열이어야 합니다.") from exc
    require(isinstance(versions, list) and len(versions) == 20 and all(
        isinstance(value, str) and re.fullmatch(r"[0-9]{14}", value) for value in versions),
        "정확히 20개의 문자열 버전이 필요합니다.")
    require(len(set(versions)) == 20, "중복 버전은 허용하지 않습니다.")
    return sorted(versions), data


def render_config(data):
    try:
        text = data.decode("utf-8")
        original = tomllib.loads(text)
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise PreparationError("원본 설정은 유효한 UTF-8 TOML이어야 합니다.") from exc
    require(original.get("project_id") == "yumidang-minkyu-db", "검토된 민규 DB 원본 프로젝트만 허용합니다.")
    functions = original.get("functions")
    require(isinstance(functions, dict) and set(functions) == FUNCTIONS and all(
        isinstance(value, dict) and set(value) == {"verify_jwt"} and value["verify_jwt"] is False
        for value in functions.values()), "검토된 7개 함수 설정만 원본에 포함할 수 있습니다.")
    replacements = {("", "project_id"): PROJECT, ("db", "shadow_port"): 56530,
                    ("edge_runtime", "enabled"): False}
    replacements.update({(section, "port"): port for section, port in PORTS.items()})
    expected = json.loads(json.dumps(original))
    for (section, key), value in replacements.items():
        target = expected
        for component in section.split(".") if section else ():
            require(isinstance(target.get(component), dict), "필수 로컬 설정 항목이 없습니다.")
            target = target[component]
        require(key in target and type(target[key]) is type(value), "로컬 설정 값 형식이 다릅니다.")
        target[key] = value
    del expected["functions"]
    lines, seen, sections = [], set(), set()
    section, skip = "", False
    for line in text.splitlines(keepends=True):
        header = re.fullmatch(r"\s*\[([A-Za-z0-9_.-]+)\]\s*(?:#[^\n]*)?\n?", line)
        if header:
            section = header[1]
            skip = section.startswith("functions.")
            if skip:
                sections.add(section.removeprefix("functions."))
        if skip:
            continue
        assignment = re.match(r"\s*([A-Za-z0-9_-]+)\s*=", line)
        identity = (section, assignment[1]) if assignment else None
        if identity in replacements:
            require(identity not in seen, "설정 항목이 중복됩니다.")
            seen.add(identity)
            line = identity[1] + " = " + json.dumps(replacements[identity]) + "\n"
        lines.append(line)
    require(seen == set(replacements) and sections == FUNCTIONS, "설정의 명시적 table/key 형식이 필요합니다.")
    rendered = "".join(lines).encode()
    require(tomllib.loads(rendered.decode()) == expected, "프로젝트·포트·함수 제거·Edge 비활성화 외 변경은 금지합니다.")
    overlay = {"project_id": PROJECT, "db.shadow_port": 56530, "edge_runtime.enabled": False,
               "functions": {}, **{section + ".port": port for section, port in PORTS.items()}}
    return rendered, overlay


def output_path(repo, output):
    path = Path(output)
    require(path.is_absolute() and path.resolve() == path and path.is_relative_to(Path("/private/tmp")) and
            path != Path("/private/tmp"), "출력은 /private/tmp 내부 절대 경로여야 합니다.")
    require(all(not item.is_symlink() for item in (path, *path.parents)), "출력 심볼릭 링크는 허용하지 않습니다.")
    require(not path.exists() and not path.is_relative_to(repo) and not repo.is_relative_to(path),
            "출력은 저장소와 분리된 새 경로여야 합니다.")
    parent = path.parent.stat()
    require(path.parent.is_dir() and parent.st_uid == os.getuid() and parent.st_mode & 0o777 == 0o700,
            "출력 부모는 본인 소유 0700 폴더여야 합니다.")
    return path


def prepare_remote_baseline(repo, versions, output):
    repo = Path(repo).resolve()
    source_head = git(repo, "rev-parse", "HEAD").decode().strip()
    source_branch = git(repo, "branch", "--show-current").decode().strip()
    require(bool(source_branch), "명시적인 작업 브랜치가 필요합니다.")
    inspection = inspect_migrations(repo)
    validate_reviewed_migration_history(inspection)
    selected_versions, versions_bytes = read_versions(versions)
    source_entries = inspection["migrations"]
    by_version = {entry["version"]: entry for entry in source_entries}
    require(set(selected_versions) <= set(by_version), "원격 버전이 정식 HEAD 이력에 없습니다.")
    selected = [by_version[version] for version in selected_versions]
    config_bytes = regular(repo / CONFIG, repo)
    rendered, overlay = render_config(config_bytes)
    payloads = []
    for entry in selected:
        data = regular(repo / entry["path"], repo)
        require(digest(data) == entry["sha256"], "검사 중 SQL 원본이 변경되었습니다.")
        payloads.append(data)
    destination = output_path(repo, output)
    destination.mkdir(mode=0o700)
    try:
        target = destination / "supabase" / "migrations"
        target.mkdir(parents=True)
        for entry, data in zip(selected, payloads):
            with (target / Path(entry["path"]).name).open("xb") as stream:
                stream.write(data)
        with (destination / "supabase/config.toml").open("xb") as stream:
            stream.write(rendered)
        require(inspect_migrations(repo) == inspection and
                git(repo, "rev-parse", "HEAD").decode().strip() == source_head and
                git(repo, "branch", "--show-current").decode().strip() == source_branch and
                regular(repo / CONFIG, repo) == config_bytes and read_versions(versions)[1] == versions_bytes,
                "준비 중 원본·버전·브랜치가 변경되었습니다.")
        report = {"status": "READY", "mode": "remote_baseline", "sql_execution": "NOT_RUN",
                  "edge_execution": "NOT_RUN", "output_root": str(destination), "project_id": PROJECT,
                  "count": 20, "canonical_count": inspection["count"], "migrations": selected, "pending": [],
                  "source_migrations": source_entries, "source_head": source_head, "source_branch": source_branch,
                  "versions_sha256": digest(versions_bytes), "source_config_sha256": digest(config_bytes),
                  "config_sha256": digest(rendered), "config_overlay": overlay, "functions": []}
        with (destination / "remote-baseline-manifest.json").open("x") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        return report
    except BaseException:
        shutil.rmtree(destination)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--versions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare_remote_baseline(args.repo, args.versions, args.output), ensure_ascii=False))
        return 0
    except (PreparationError, OSError, ValueError):
        print(json.dumps({"status": "BLOCKED", "error": "REMOTE_BASELINE_PREPARATION_FAILED", "sql_execution": "NOT_RUN"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
