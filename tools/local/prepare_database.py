#!/usr/bin/env python3
"""Git HEAD와 일치하는 정식 SQL 이력과 로컬 설정을 임시 폴더에 준비. 실행 없음."""
import argparse
import hashlib
import json
from pathlib import Path
import copy
import re
import sys
import tomllib

from prepare_migrations import PreparationError, prepare


def isolated_config(config_bytes, project_id, port_base):
    """새 종현 합성 환경의 이름·포트만 변경한다. 기동·포트 예약은 하지 않는다."""
    if (not isinstance(project_id, str)
            or not re.fullmatch(r"jonghyun-backend100(?:-[0-9a-f]{8})?", project_id)
            or type(port_base) is not int or not 1025 <= port_base <= 65527):
        raise PreparationError("전용 jonghyun-backend100 프로젝트와 유효한 포트 묶음이 필요합니다.")
    original = tomllib.loads(config_bytes.decode("utf-8"))
    if original.get("project_id") == project_id:
        raise PreparationError("원본과 다른 새 전용 project_id가 필요합니다.")
    overrides = {"project_id": project_id, "api.port": port_base,
                 "db.port": port_base + 1, "db.shadow_port": port_base - 1,
                 "db.pooler.port": port_base + 8, "studio.port": port_base + 2,
                 "local_smtp.port": port_base + 3, "analytics.port": port_base + 6}
    expected = copy.deepcopy(original)
    for path, value in overrides.items():
        parts = path.split(".")
        current = expected
        for part in parts[:-1]:
            if not isinstance(current.get(part), dict):
                raise PreparationError("전용 환경 overlay에 필요한 설정 항목이 없습니다.")
            current = current[part]
        if parts[-1] not in current:
            raise PreparationError("전용 환경 overlay에 필요한 설정 항목이 없습니다.")
        current[parts[-1]] = value
    # TOML 전체를 재작성하지 않고, 해당 section의 정확한 설정 한 줄만 바꾼다.
    section, changed, lines = "", set(), []
    for line in config_bytes.decode("utf-8").splitlines(keepends=True):
        header = re.fullmatch(r"\s*\[([A-Za-z0-9_.-]+)\]\s*(?:#[^\r\n]*)?(?:\r?\n)?", line)
        if header:
            section = header[1]
        entry = re.match(r"^(\s*)([A-Za-z0-9_-]+)\s*=", line)
        path = (section + "." if section else "") + entry[2] if entry else None
        if path in overrides:
            if path in changed:
                raise PreparationError("전용 환경 overlay 설정이 중복됐습니다.")
            newline = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
            line = entry[1] + entry[2] + " = " + json.dumps(overrides[path]) + newline
            changed.add(path)
        lines.append(line)
    rendered = "".join(lines).encode("utf-8")
    if changed != set(overrides) or tomllib.loads(rendered.decode("utf-8")) != expected:
        raise PreparationError("이름·포트 외 설정 변경은 허용하지 않습니다.")
    return rendered, overrides


def prepare_database(repo, output, *, project_id=None, port_base=None):
    repo = Path(repo).resolve()
    config = repo / "backend/supabase/config.toml"
    if config.is_symlink() or not config.is_file() or not config.resolve().is_relative_to(repo):
        raise PreparationError("로컬 설정은 저장소 내부의 일반 파일이어야 합니다.")
    config_bytes = config.read_bytes()
    try:
        config_data = tomllib.loads(config_bytes.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise PreparationError("로컬 설정이 유효한 UTF-8 TOML이 아닙니다.") from exc
    if not config_data:
        raise PreparationError("로컬 설정이 비어 있습니다.")
    rendered, overlay = config_bytes, None
    if project_id is not None or port_base is not None:
        rendered, overlay = isolated_config(config_bytes, project_id, port_base)
    # 정식 파일명·HEAD 일치·변경/신규 staged SQL 거절과 사본 제외를 공통 검사에 위임한다.
    report = prepare(repo, output)
    target = Path(report["output_root"])
    with (target / "supabase/config.toml").open("xb") as stream:
        stream.write(rendered)
    report["pending"] = []
    report["config_sha256"] = hashlib.sha256(rendered).hexdigest()
    if overlay is not None:
        report["source_config_sha256"] = hashlib.sha256(config_bytes).hexdigest()
        report["config_overlay"] = overlay
        report["runtime_readiness"] = "NOT_VERIFIED"
        report["port_availability"] = "NOT_VERIFIED"
    report["total_count"] = report["count"]
    with (target / "database-manifest.json").open("x") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--project-id", help="명시적인 새 종현 합성 프로젝트 이름")
    parser.add_argument("--port-base", type=int, help="새 전용 환경 포트 묶음의 API 포트")
    args = parser.parse_args()
    try:
        print(json.dumps(prepare_database(args.repo, args.output, project_id=args.project_id,
                                         port_base=args.port_base), ensure_ascii=False, indent=2))
        return 0
    except (OSError, PreparationError) as exc:
        print(json.dumps({"status": "BLOCKED", "sql_execution": "NOT_RUN", "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
