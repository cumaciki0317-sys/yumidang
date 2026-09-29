#!/usr/bin/env python3
"""정식 DB 이력과 현재 service-api 소스를 격리된 로컬 Edge 실행 루트에 준비한다."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import tomllib

from prepare_database import prepare_database
from prepare_migrations import PreparationError, git

FUNCTIONS = Path("backend/supabase/functions")
ENTRYPOINT = FUNCTIONS / "service-api/index.ts"
# 현재 코드의 정적 import, import type, export ... from 문법만 지원한다.
IMPORTS = re.compile(r"\b(?:import|export)\s+(?:[^;]*?\bfrom\s*)?[\"']([^\"']+)[\"']", re.MULTILINE)
DYNAMIC_IMPORT = re.compile(r"\bimport\s*\(")
SAFE_PART = re.compile(r"[A-Za-z0-9_-]+(?:\.ts)?$")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_regular(repo, path):
    candidate = repo / path
    if any(part.is_symlink() for part in (candidate, *candidate.parents) if part != repo and part.is_relative_to(repo)):
        raise PreparationError(f"소스 경로에 심볼릭 링크를 사용할 수 없습니다: {path}")
    if not candidate.is_file() or not candidate.resolve().is_relative_to(repo):
        raise PreparationError(f"저장소 내부 일반 소스 파일이 아닙니다: {path}")
    return candidate.read_bytes()


def source_snapshot(repo):
    pending, payloads = [ENTRYPOINT], {}
    while pending:
        path = pending.pop()
        if path in payloads:
            continue
        relative = path.relative_to(FUNCTIONS)
        if (relative.parts[0] not in {"service-api", "_shared"} or path.suffix != ".ts"
                or not all(SAFE_PART.fullmatch(part) for part in relative.parts)):
            raise PreparationError(f"허용된 Edge TypeScript 소스 경로가 아닙니다: {path}")
        data = read_regular(repo, path)
        try:
            source = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PreparationError(f"UTF-8 소스가 아닙니다: {path}") from exc
        if DYNAMIC_IMPORT.search(source):
            raise PreparationError(f"동적 import는 별도 검토가 필요합니다: {path}")
        payloads[path] = data
        for specifier in IMPORTS.findall(source):
            if not specifier.startswith("."):
                raise PreparationError(f"외부 모듈 import는 별도 검토가 필요합니다: {path}")
            # resolve() 전에 심볼릭 링크를 검사하여 저장소 안의 링크도 거절한다.
            raw = path.parent / specifier
            if any(part.is_symlink() for part in (repo / raw, *(repo / raw).parents)
                   if part.is_relative_to(repo) and part != repo):
                raise PreparationError(f"import 경로에 심볼릭 링크를 사용할 수 없습니다: {path}")
            absolute = (repo / raw).resolve()
            if not absolute.is_relative_to(repo / FUNCTIONS):
                raise PreparationError(f"함수 폴더 밖 import입니다: {path}")
            pending.append(absolute.relative_to(repo))
    deno = FUNCTIONS / "deno.json"
    data = read_regular(repo, deno)
    try:
        config = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PreparationError("deno.json이 유효한 JSON이 아닙니다.") from exc
    if not isinstance(config, dict) or set(config) - {"tasks", "compilerOptions"}:
        raise PreparationError("deno.json의 외부 의존성·workspace 설정은 별도 검토가 필요합니다.")
    payloads[deno] = data
    return payloads


def edge_config(config_bytes):
    try:
        original = tomllib.loads(config_bytes.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise PreparationError("로컬 설정이 유효한 UTF-8 TOML이 아닙니다.") from exc
    if original.get("project_id") != "yumidang-minkyu-db":
        raise PreparationError("민규 전용 로컬 project_id만 준비할 수 있습니다.")
    if original.get("functions", {}).get("service-api", {}).get("verify_jwt") is not False:
        raise PreparationError("service-api의 verify_jwt=false 설정이 필요합니다.")
    if set(original.get("functions", {})) != {"service-api"}:
        raise PreparationError("다른 함수의 실행 설정을 포함할 수 없습니다.")
    text = config_bytes.decode("utf-8")
    section = re.compile(r"(?ms)(^\[edge_runtime\][^\n]*\n)(.*?)(?=^\[|\Z)")
    matches = list(section.finditer(text))
    if len(matches) != 1:
        raise PreparationError("edge_runtime 설정이 정확히 하나 필요합니다.")
    match = matches[0]
    body, count = re.subn(r"(?m)^enabled\s*=\s*(?:true|false)(\s*(?:#[^\n]*)?)$", r"enabled = true\1", match[2])
    if count != 1:
        raise PreparationError("edge_runtime.enabled 설정이 정확히 하나 필요합니다.")
    rendered = (text[:match.start(2)] + body + text[match.end(2):]).encode("utf-8")
    expected = dict(original)
    expected["edge_runtime"] = {**original["edge_runtime"], "enabled": True}
    if tomllib.loads(rendered.decode("utf-8")) != expected:
        raise PreparationError("Edge 활성화 외 설정 변경은 허용하지 않습니다.")
    return rendered


def prepare_edge(repo, output):
    repo = Path(repo).resolve()
    config_path = Path("backend/supabase/config.toml")
    source_config = read_regular(repo, config_path)
    rendered_config = edge_config(source_config)
    payloads = source_snapshot(repo)
    # 출력 경계, HEAD 정식 SQL 일치, 사본 제외는 기존 준비 도구가 검증한다.
    database = prepare_database(repo, output)
    destination = Path(database["output_root"])
    if database["config_sha256"] != digest(source_config):
        raise PreparationError("준비 중 config가 변경되었습니다. 새 임시 루트로 다시 준비하십시오.")
    (destination / "supabase/config.toml").write_bytes(rendered_config)
    entries = []
    for path, data in sorted(payloads.items()):
        target = Path("supabase/functions") / path.relative_to(FUNCTIONS)
        (destination / target).parent.mkdir(parents=True, exist_ok=True)
        with (destination / target).open("xb") as stream:
            stream.write(data)
        entries.append({"path": str(path), "target": str(target), "sha256": digest(data)})
    report = {
        "status": "READY", "sql_execution": "NOT_RUN", "edge_execution": "NOT_RUN",
        "output_root": str(destination), "source_head": git(repo, "rev-parse", "HEAD").decode().strip(),
        "source_mode": "working_tree_snapshot", "migration_count": database["total_count"],
        "functions": ["service-api"], "source_files": entries,
        "database_manifest": "database-manifest.json",
        "source_config_sha256": digest(source_config), "config_sha256": digest(rendered_config),
        "config_overlay": {"edge_runtime.enabled": True},
        "config_note": "database-manifest.json은 원본 config 해시를 보존하며 최종 실행 config 해시는 이 문서의 config_sha256이다.",
    }
    with (destination / "edge-manifest.json").open("x") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare_edge(args.repo, args.output), ensure_ascii=False, indent=2))
        return 0
    except (OSError, PreparationError) as exc:
        print(json.dumps({"status": "BLOCKED", "edge_execution": "NOT_RUN", "sql_execution": "NOT_RUN", "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
