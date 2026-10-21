#!/usr/bin/env python3
"""현재 HEAD의 복원 소스 목록 준비. DB/컨테이너 실행 및 과거 packet 재승인 없음."""
from pathlib import Path
from contextlib import contextmanager
import importlib.util
import sys
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


def prepare_current_profile_source(repo, reviewed_head, reviewed_migrations_sha256):
    """현재 고정 policy profile과 소스 HEAD를 함께 확인하는 새 Auth/복원 준비 입구."""
    from prepare_current_policy import inspect_reviewed_current_migrations
    history, _ = inspect_reviewed_current_migrations(repo, reviewed_head, reviewed_migrations_sha256)
    result = prepare_source_manifest(repo, reviewed_head, reviewed_migrations_sha256)
    need(result['migrations'] == history['entries'], 'CURRENT_PROFILE_SOURCE_CHANGED')
    return {**result, 'policyProfileVerified': True,
            'artifactPreparation': 'prepare_current_policy explicit reviewed mode',
            'runtimeAuthRestoreConsumer': 'FRESH_EXECUTOR_REVIEW_REQUIRED'}


@contextmanager
def _reviewed_current_restore_support(repo, reviewed_head):
    """새 typed 입구의 지연 helper import도 검토한 원 bytes 안에 고정한다."""
    repo = Path(repo)
    names = ('prepare_migrations', 'prepare_database', 'prepare_edge', 'prepare_current_policy')
    payloads = {}
    need(core.head(repo) == reviewed_head, 'REVIEWED_HEAD_CHANGED')
    for name in names:
        relative = 'tools/local/' + name + '.py'
        value = core.secure.read_bytes(repo / relative, repo=repo)
        need(value == git(repo, 'show', f'{reviewed_head}:{relative}'), 'SOURCE_NOT_COMMITTED')
        payloads[name] = value
    previous = {name: sys.modules.get(name) for name in names}
    try:
        for name in names:
            path = repo / 'tools/local' / (name + '.py')
            spec = importlib.util.spec_from_file_location(name, path)
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            exec(compile(payloads[name], str(path), 'exec'), module.__dict__)
        yield
        need(core.head(repo) == reviewed_head, 'REVIEWED_HEAD_CHANGED')
        for name, value in payloads.items():
            need(core.secure.read_bytes(repo / 'tools/local' / (name + '.py'), repo=repo) == value,
                 'SUPPORT_CHANGED_DURING_READ')
    finally:
        for name, old in previous.items():
            if old is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = old


def prepare_reviewed_current124_restore(repo, profile):
    """root literal 현재124 profile과 실제 HEAD 전체 목록·소스 bytes를 연결한다.

    기존119/121 준비·실행 입구를 변경하지 않는다. 이 결과는 DB 실행이나 현재 관측한
    JSON을 자동 재승인하는 수단이 아니며, runtime target/intent를 발급하지 않는다.
    """
    need(type(profile) is core.secure.ReviewedCurrentRestoreProfile,
         'TYPED_CURRENT_RESTORE_PROFILE_REQUIRED')
    p = profile.value()
    with _reviewed_current_restore_support(repo, p['sourceHead']):
        prepared = prepare_current_profile_source(repo, p['sourceHead'], p['migrationsSha256'])
        review = core.prepare_current124_restore_review(profile, prepared)
        # 준비 반환 직전 동일 source closure를 다시 검산한다.
        final = prepare_current_profile_source(repo, p['sourceHead'], p['migrationsSha256'])
        need(canonical(final) == canonical(prepared), 'CURRENT_RESTORE_PREPARATION_CHANGED')
    return {'source': prepared, 'review': review}
