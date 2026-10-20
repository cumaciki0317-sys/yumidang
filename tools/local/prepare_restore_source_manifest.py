#!/usr/bin/env python3
"""현재 HEAD의 복원 소스 목록 준비. DB/컨테이너 실행 및 과거 packet 재승인 없음."""
from pathlib import Path
import hashlib
import json
import re

import prepare_database_restore as core
from prepare_migrations import inspect_migrations, git, MIGRATIONS, COPY

SOURCE_FILES = core.FILES | {"tools/local/prepare_restore_source_manifest.py"}

class ManifestRefused(ValueError):
    pass

def need(value, code):
    if not value:
        raise ManifestRefused(code)

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode()

def digest(value):
    return hashlib.sha256(value).hexdigest()

def prepare_source_manifest(repo, reviewed_head, reviewed_migrations_sha256):
    """명시 검토한 HEAD·정렬 목록과 실제 bytes를 연결한다. 반환은 실행 권한이 아니다.

    reviewed_migrations_sha256는 inspect_migrations()['migrations'] 전체 배열의
    canonical SHA다. count만 맞추거나 현재 관측값을 과거 packet에 덮어쓰지 않는다.
    """
    repo = Path(repo)
    need(repo.is_absolute() and repo.resolve() == repo, "EXACT_REPO_REQUIRED")
    need(type(reviewed_head) is str and re.fullmatch(r"[a-f0-9]{40}", reviewed_head),
         "REVIEWED_HEAD_REQUIRED")
    need(type(reviewed_migrations_sha256) is str
         and re.fullmatch(r"[a-f0-9]{64}", reviewed_migrations_sha256), "REVIEWED_LIST_REQUIRED")
    need(core.head(repo) == reviewed_head, "REVIEWED_HEAD_CHANGED")
    inventory = inspect_migrations(repo)
    migrations = inventory["migrations"]
    need(bool(migrations) and digest(canonical(migrations)) == reviewed_migrations_sha256,
         "REVIEWED_MIGRATIONS_CHANGED")
    # 기존 정식 검사기가 제외한 사본만 허용한다. 미추적 신규 SQL은 현재 목록에
    # 포함되지 않으므로 준비 승격 전에 거절한다(개수/이름만 추가하여 통과하지 않음).
    allowed = {item["path"] for item in migrations} | {name for name in inventory["excluded"] if COPY.search(Path(name).name)}
    for path in (repo / MIGRATIONS).rglob("*.sql"):
        if path.suffix == ".sql":
            need(str(path.relative_to(repo)) in allowed, "UNREVIEWED_SQL_PRESENT")
    files = {}
    for name in sorted(SOURCE_FILES):
        raw = core.secure.read_bytes(repo / name, repo=repo)
        need(raw == git(repo, "show", f"{reviewed_head}:{name}"), "SOURCE_NOT_COMMITTED")
        files[name] = digest(raw)
    need(core.head(repo) == reviewed_head, "REVIEWED_HEAD_CHANGED")
    need(inspect_migrations(repo)["migrations"] == migrations, "MIGRATIONS_CHANGED_DURING_READ")
    for name, expected in files.items():
        need(digest(core.secure.read_bytes(repo / name, repo=repo)) == expected,
             "SOURCE_CHANGED_DURING_READ")
    # 기존121 실행기와 과거 consumer는 변경하지 않는다.
    return {"scope": "CURRENT_RESTORE_SOURCE_PREPARATION_ONLY", "sourceHead": reviewed_head,
            "migrationCount": len(migrations), "migrations": migrations,
            "migrationsSha256": reviewed_migrations_sha256, "sourceFiles": files,
            "sourceFilesSha256": digest(canonical(files)), "committedSourceVerified": True,
            "executionAllowed": False, "runnable": False, "fullRestore": False,
            "consumerCompatibility": "NOT_REVIEWED", "runtimeValidation": "NOT_RUN",
            "remaining": ["current typed source and capture packet review",
                          "current consumer and composition review",
                          "live identity memory preservation and intent gates"]}
