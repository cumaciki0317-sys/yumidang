#!/usr/bin/env python3
"""Git HEAD와 일치하는 정식 SQL 이력과 로컬 설정을 임시 폴더에 준비. 실행 없음."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import tomllib

from prepare_migrations import PreparationError, prepare


def prepare_database(repo, output):
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
    # 정식 파일명·HEAD 일치·변경/신규 staged SQL 거절과 사본 제외를 공통 검사에 위임한다.
    report = prepare(repo, output)
    target = Path(report["output_root"])
    with (target / "supabase/config.toml").open("xb") as stream:
        stream.write(config_bytes)
    report["pending"] = []
    report["config_sha256"] = hashlib.sha256(config_bytes).hexdigest()
    report["total_count"] = report["count"]
    with (target / "database-manifest.json").open("x") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare_database(args.repo, args.output), ensure_ascii=False, indent=2))
        return 0
    except (OSError, PreparationError) as exc:
        print(json.dumps({"status": "BLOCKED", "sql_execution": "NOT_RUN", "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
