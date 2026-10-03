#!/usr/bin/env python3
"""정식 DB 이력과 현재 service-api 소스를 격리된 로컬 Edge 실행 루트에 준비한다."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import tomllib

from prepare_database import prepare_database
from prepare_migrations import CANONICAL, PreparationError, git, inspect_migrations

FUNCTIONS = Path("backend/supabase/functions")
ENTRYPOINT = FUNCTIONS / "service-api/index.ts"
# 현재 코드의 정적 import, import type, export ... from 문법만 지원한다.
IMPORTS = re.compile(r"\b(?:import|export)\s+(?:[^;]*?\bfrom\s*)?[\"']([^\"']+)[\"']", re.MULTILINE)
DYNAMIC_IMPORT = re.compile(r"\bimport\s*\(")
SAFE_PART = re.compile(r"[A-Za-z0-9_-]+(?:\.ts)?$")
GATEWAY_PROJECT = "yumidang-minkyu-gateway"
GATEWAY_FUNCTIONS = {"service-api", "signup", "ai-chat", "places", "event-sync", "review-summary-worker", "scheduled-jobs"}
# ordered PHASES[3]의 7개와 나이·행사·순위·사진 접근·대화 숨김·완료 실행기 역할 SQL을 선택한다.
GATEWAY_PENDING = tuple(Path("backend/supabase/migrations") / name for name in (
    "20260929100000_event_storage.sql",
    "20261002090000_naver_signup.sql",
    "20261002100000_matching_lifecycle.sql",
    "20261002110000_completion_review_policy.sql",
    "20261002120000_appointment_changes.sql",
    "20261002130000_ai_budget_worker.sql",
    "20261002131000_events_public_profile.sql",
    "20261002140000_public_search_age_range.sql",
    "20261002150000_post_event_links.sql",
    "20261002160000_event_rankings.sql",
    "20261002170743_profile_image_access.sql",
    "20261002174755_conversation_visibility.sql",
    "20261003090000_completion_runner_role.sql",
))
# 검토된 공유 전후 이력만 허용한다. 새 SQL은 별도 검토 후 이 목록에 반영한다.
GATEWAY_REVIEWED_MIGRATIONS = {
    "backend/supabase/migrations/20260916080335_create_profiles.sql": "da19b1a471feeb92279b95e37c71cd6b337657639da803a807e7b1bff9514de2",
    "backend/supabase/migrations/20260916081429_remove_profiles_neighborhood.sql": "61a12907ee1d3c5a338d9de0e37b30b19afb422d31e9eee427a8504252c9b9d2",
    "backend/supabase/migrations/20260916081750_restrict_profiles_column_writes.sql": "f88de84f8b85bef01d312003ee3827226e65d8b1b9258eb6e061e547efa30427",
    "backend/supabase/migrations/20260916101123_profiles_real_name_contract.sql": "7dfc98ef2db697246e814a10d68ef0f3761c9f7bdbf43f7d39949c5632aa6673",
    "backend/supabase/migrations/20260916105220_feature03_posts.sql": "e8765b87bc2f37a95086f74f2273cfdb0a0e1137f21066f6a89794c655440709",
    "backend/supabase/migrations/20260916105738_feature04_post_author_profile.sql": "2321bc7328f946281312a7dae13c3538d12a97a1ab13a5de31146feaf17db25a",
    "backend/supabase/migrations/20260916105916_feature05_join_requests.sql": "09c13dd6ead99c4d7d92edfa754761758fbb22065be0a66e11f36ab06d385a01",
    "backend/supabase/migrations/20260916110052_feature06_matching_chat.sql": "30943796bb28009963d2ae68f7674ef3eb6a4c50808f6916b340e6f034a760ec",
    "backend/supabase/migrations/20260916110758_feature07_final_match.sql": "344f2909fcf075084e78a42325388bccf2092f4073975aff61fbc3d266e49f64",
    "backend/supabase/migrations/20260916110943_feature08_completion.sql": "57995918ad709cbb6ac6f011eaa5f156db88d6b67ed9d5d10882d3a825907d64",
    "backend/supabase/migrations/20260916111030_feature09_mutual_review.sql": "dd4ef8e0c1ec10111ac872283b77f8f2cc6c19f77574ed14183388d31e4be879",
    "backend/supabase/migrations/20260916111437_appointments_request_post_fk_index.sql": "8faeb187b204aa81d2a8c2248931440ec631eed6a6b9822049d8f9fe70a0fb40",
    "backend/supabase/migrations/20260916114036_rpc_unavailable_errors_as_404.sql": "bf5f8e62e668f777ff8774ae3239775ef8dd4c84ac23722db746c2430926c21e",
    "backend/supabase/migrations/20260916131906_existing_ui_gender_category_author_cards.sql": "7fec3aee4a304eefe00e3153b85c4890c4e12486951210d92e5fb49de0fa2ca0",
    "backend/supabase/migrations/20260917005621_retry_completion_dispute_review_policy.sql": "9dc9f8b9f9d259cc38a8d9f18450b29822565f112864050f7e3cd4fd4a543487",
    "backend/supabase/migrations/20260917043418_signup_eligibility_author_demographics.sql": "12b9decaead249eadad008cf9131244b5a1620544a3a4fc8344d924c3cd74c9e",
    "backend/supabase/migrations/20260917052827_profile_images_required.sql": "0797f8e416ca2a6b56e3fdd4a0cadc2d713349416a685ee14949c13bcdd69a8f",
    "backend/supabase/migrations/20260917094753_disable_legacy_signup_without_avatar.sql": "75b2765d9fd426104b50eb9f12ef4a30d0797a6c30943fa839c8b3336575d24d",
    "backend/supabase/migrations/20260917122744_ut_notifications_and_discovery.sql": "cfc1e00de60da0f953843a3dcc86467cb0f515520da855dd0ab0b5be64bd74b8",
    "backend/supabase/migrations/20260917141449_notifications_join_request_index.sql": "978376c0c1d725441b474886df72ffe590ccc803894d12d0e8a2aa9d3c6059c9",
    "backend/supabase/migrations/20260923090000_worker_jobs.sql": "35cc37ed31145fc59ec5ee0580db3f49ccfd36ca19abe2208eccc5f9fe7bee5f",
    "backend/supabase/migrations/20260923091000_public_post_search.sql": "3d95413693ed39cccf4c40c9a4c642f8d75cf9c53590c35495a7c0f1cd0a5822",
    "backend/supabase/migrations/20260923092000_review_summary_storage.sql": "71c58e1587d2949ed7292d591a5505cbc33b53fab2a9ae5ac38a77f68e6d5d52",
    "backend/supabase/migrations/20260923100000_bilateral_completion.sql": "d49cd183f46738412f2fb5fff8737dee5bac30431011c18f939671ba3d7a8cd2",
    "backend/supabase/migrations/20260923101000_review_automation.sql": "499a5f5867540179301f34ec82d5d6f15934e026febeaf267781c62fe5543e5b",
    "backend/supabase/migrations/20260923102000_core_service_api.sql": "17039dccff591f32e05f8fd8af83cea729cd1b51721f8ac8ad9a6b388e045133",
    "backend/supabase/migrations/20260929090000_public_search_v2.sql": "7291d87a34c6cdef707d97af502f7097ac6edf6ff2fd6fe34023116959683525",
    "backend/supabase/migrations/20260929100000_event_storage.sql": "8b853ab4af4311552126bbf66f073a9b2baeaad2371fabb2d0afc1ee2196931c",
    "backend/supabase/migrations/20260929120000_review_release_and_completion_reservations.sql": "8cd13df2cfa9e92a8a3ea0e21d2917cdc32d03441cb5a2957665fbbee60366b2",
    "backend/supabase/migrations/20261002090000_naver_signup.sql": "835cedd273fbb901a8ecc1aff538bbb9f89c3f1ea49aa6e18fbfdc4d61722338",
    "backend/supabase/migrations/20261002100000_matching_lifecycle.sql": "58e175eb4af6fd3e551c23c22c6a2d8b50c6d420d5c91389e460c39be29ec977",
    "backend/supabase/migrations/20261002110000_completion_review_policy.sql": "4b9ee69e4230dd62f70d2fa711a69b857b93d6bf17afa297192543389fc57615",
    "backend/supabase/migrations/20261002120000_appointment_changes.sql": "dec9b0753ff6b8da4db33c1044615ed7cd82f47c37170eff2bf3293ded7d3f86",
    "backend/supabase/migrations/20261002130000_ai_budget_worker.sql": "ea61b1d1d8b0ea1b57e44f97c56c32ab3121b6273ef83f6364d64c5b979e30e6",
    "backend/supabase/migrations/20261002131000_events_public_profile.sql": "8ac1eb3857d29ecbbccd543bbd0f58a440043234c086f734860d664562a0eb0b",
    "backend/supabase/migrations/20261002140000_public_search_age_range.sql": "b9b7d00e6f6fd2af10252e30e371e635a55bcce00f2ee29b3f872eec974a14d0",
    "backend/supabase/migrations/20261002150000_post_event_links.sql": "0d436dc31e8483603d8751ca25f7d50e79660f613c220aa220ab5a514b03475a",
    "backend/supabase/migrations/20261002160000_event_rankings.sql": "a59ef5cdd304a5361f21b7e81d4cb3add630fedc0ebe6f51fd020ecf6dda203b",
    "backend/supabase/migrations/20261002170743_profile_image_access.sql": "933597ecfa225eefbc9fb51eeee5f71c239f5cdc63c524325dbd7b9bb55404b0",
    "backend/supabase/migrations/20261002174755_conversation_visibility.sql": "e476d098e82c52352b484b724b0f041b209b077821ca9d9642c69aca5a0999c6",
    "backend/supabase/migrations/20261003090000_completion_runner_role.sql": "98425e7c855914bf49899b4a68704686e615fdfeac6a2852e9674f4ecd5e65fc",
}
GATEWAY_PORTS = {"api": 56521, "db": 56522, "db.pooler": 56529, "studio": 56523,
                 "local_smtp": 56524, "analytics": 56527}


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


def gateway_config(config_bytes):
    """명시적 검증 모드만 프로젝트·포트·함수 목록·Edge 활성화를 임시 설정에 적용한다."""
    try:
        text = config_bytes.decode("utf-8")
        original = tomllib.loads(text)
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise PreparationError("로컬 설정이 유효한 UTF-8 TOML이 아닙니다.") from exc
    if original.get("project_id") != "yumidang-minkyu-db":
        raise PreparationError("민규 전용 원본 project_id만 준비할 수 있습니다.")
    functions = original.get("functions")
    if not isinstance(functions, dict) or set(functions) != GATEWAY_FUNCTIONS or any(
            not isinstance(value, dict) or set(value) != {"verify_jwt"} or value["verify_jwt"] is not False
            for value in functions.values()):
        raise PreparationError("검토된 7개 함수의 verify_jwt=false 설정만 허용합니다.")
    replacements = {("", "project_id"): GATEWAY_PROJECT, ("db", "shadow_port"): 56520,
                    ("edge_runtime", "enabled"): True}
    replacements.update({(section, "port"): port for section, port in GATEWAY_PORTS.items()})
    expected = json.loads(json.dumps(original))
    for (section, key), value in replacements.items():
        target = expected
        for component in section.split(".") if section else ():
            if not isinstance(target.get(component), dict):
                raise PreparationError("검토된 게이트웨이 설정 항목이 필요합니다.")
            target = target[component]
        if key not in target or (key != "project_id" and type(target[key]) is not type(value)):
            raise PreparationError("검토된 게이트웨이 설정 값의 형식이 필요합니다.")
        target[key] = value
    expected["functions"] = {"service-api": functions["service-api"]}
    lines, seen, function_sections = [], set(), set()
    section, skip = "", False
    for line in text.splitlines(keepends=True):
        header = re.fullmatch(r"\s*\[([A-Za-z0-9_.-]+)\]\s*(?:#[^\n]*)?\n?", line)
        if header:
            section = header[1]
            skip = section.startswith("functions.") and section != "functions.service-api"
            if section.startswith("functions."):
                function_sections.add(section.removeprefix("functions."))
        if skip:
            continue
        assignment = re.match(r"\s*([A-Za-z0-9_-]+)\s*=", line)
        identity = (section, assignment[1]) if assignment else None
        if identity in replacements:
            if identity in seen:
                raise PreparationError("게이트웨이 설정은 항목마다 정확히 하나 필요합니다.")
            seen.add(identity)
            line = identity[1] + " = " + json.dumps(replacements[identity]) + "\n"
        lines.append(line)
    if seen != set(replacements) or function_sections != GATEWAY_FUNCTIONS:
        raise PreparationError("게이트웨이 설정의 명시적 table/key 형식이 필요합니다.")
    rendered = "".join(lines).encode("utf-8")
    if tomllib.loads(rendered.decode("utf-8")) != expected:
        raise PreparationError("프로젝트·포트·service-api 제한·Edge 활성화 외 설정 변경은 허용하지 않습니다.")
    return rendered


def private_gateway_output(repo, output):
    destination = Path(output)
    if not destination.is_absolute():
        raise PreparationError("--output은 임시 폴더 아래 절대 경로여야 합니다.")
    if any(part.is_symlink() for part in (destination, *destination.parents)
           if part != Path('/var') and part != Path('/tmp')):
        raise PreparationError("출력 경로에 심볼릭 링크를 사용할 수 없습니다.")
    destination = destination.resolve()
    # Colima가 공유하는 canonical 경로만 허용한다. macOS 기본 /var/folders는 bind되지 않는다.
    temporary_root = Path("/private/tmp")
    if destination == temporary_root or not destination.is_relative_to(temporary_root):
        raise PreparationError("gateway --output은 /private/tmp의 하위 경로여야 합니다.")
    if destination.is_relative_to(repo) or repo.is_relative_to(destination):
        raise PreparationError("저장소와 겹치는 출력 경로는 허용하지 않습니다.")
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir()) or destination.stat().st_uid != os.getuid()):
        raise PreparationError("출력 루트는 본인 소유의 빈 디렉터리여야 합니다. 기존 파일은 덮어쓰지 않습니다.")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination.chmod(0o700)
    return destination


def prepare_gateway_database(repo, destination):
    # 기본 준비 도구는 변경하지 않는다. 별도 프로세스의 TMPDIR만 공유 가능한 경로로 지정한다.
    environment = {**os.environ, "TMPDIR": "/private/tmp"}
    try:
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("prepare_database.py")),
                                 "--repo", str(repo), "--output", str(destination)],
                                env=environment, capture_output=True, check=False, timeout=60)
        report = json.loads(result.stdout)
        if result.returncode != 0 or report.get("status") != "READY" or report.get("output_root") != str(destination):
            raise ValueError()
        return report
    except (OSError, subprocess.SubprocessError, ValueError, AttributeError) as exc:
        raise PreparationError("게이트웨이의 격리된 원본 DB 준비가 실패했습니다.") from exc


def validate_reviewed_migration_history(canonical):
    """준비 도구들이 검토된 공유 전후 경로·해시를 동일하게 확인한다."""
    reviewed_paths = set(GATEWAY_REVIEWED_MIGRATIONS)
    selected_paths = {str(path) for path in GATEWAY_PENDING}
    canonical_paths = {entry["path"] for entry in canonical["migrations"]}
    # 13개 전체가 아직 pending이거나 전체가 HEAD에 들어간 두 상태만 지원한다.
    if (canonical["count"] not in (28, 41) or len(reviewed_paths) != 41 or len(selected_paths) != 13
            or not selected_paths <= reviewed_paths
            or canonical_paths not in (reviewed_paths - selected_paths, reviewed_paths)):
        raise PreparationError("검토된 HEAD 정식 SQL 28개 또는 공유 후 41개 전체가 필요합니다.")
    if any(entry["sha256"] != GATEWAY_REVIEWED_MIGRATIONS[entry["path"]]
           for entry in canonical["migrations"]):
        raise PreparationError("HEAD SQL 내용이 검토된 해시와 다릅니다.")


def prepare_gateway_probe(repo, output):
    repo = Path(repo).resolve()
    config_path = Path("backend/supabase/config.toml")
    source_head = git(repo, "rev-parse", "HEAD").decode().strip()
    source_config = read_regular(repo, config_path)
    rendered_config = gateway_config(source_config)
    payloads = source_snapshot(repo)
    canonical = inspect_migrations(repo)
    validate_reviewed_migration_history(canonical)
    canonical_paths = {entry["path"] for entry in canonical["migrations"]}
    versions = {entry["version"] for entry in canonical["migrations"]}
    hashes = {entry["sha256"] for entry in canonical["migrations"]}
    pending, pending_payloads = [], {}
    for path in GATEWAY_PENDING:
        match = CANONICAL.fullmatch(path.name)
        data = read_regular(repo, path)
        sha = digest(data)
        # 커밋된 선택 SQL도 현재 바이트와 고정 해시를 확인하고 다시 복사하지 않는다.
        if str(path) in canonical_paths:
            if sha != GATEWAY_REVIEWED_MIGRATIONS[str(path)]:
                raise PreparationError("선택 SQL 내용이 검토된 해시와 다릅니다.")
            pending_payloads[path] = data
            continue
        if not match or not data.strip() or match[1] in versions or sha in hashes:
            raise PreparationError("선택 pending SQL의 버전·내용이 비어 있거나 중복됩니다.")
        if sha != GATEWAY_REVIEWED_MIGRATIONS[str(path)]:
            raise PreparationError("선택 SQL 내용이 검토된 해시와 다릅니다.")
        versions.add(match[1]); hashes.add(sha)
        pending_payloads[path] = data
        pending.append({"version": match[1], "path": str(path), "sha256": sha, "bytes": len(data)})
    # 기존 DB 준비의 HEAD/정식 파일명/사본 제외 검사를 재사용하며 실행 루트만 owner0700으로 만든다.
    destination = private_gateway_output(repo, output)
    database = prepare_gateway_database(repo, destination)
    if database["config_sha256"] != digest(source_config) or database["migrations"] != canonical["migrations"]:
        raise PreparationError("준비 중 원본 설정/SQL이 변경되었습니다. 새 임시 루트로 다시 준비하십시오.")
    (destination / "supabase/config.toml").write_bytes(rendered_config)
    for entry in pending:
        with (destination / "supabase/migrations" / Path(entry["path"]).name).open("xb") as stream:
            stream.write(pending_payloads[Path(entry["path"])])
    entries = []
    for path, data in sorted(payloads.items()):
        target = Path("supabase/functions") / path.relative_to(FUNCTIONS)
        (destination / target).parent.mkdir(parents=True, exist_ok=True)
        with (destination / target).open("xb") as stream:
            stream.write(data)
        entries.append({"path": str(path), "target": str(target), "sha256": digest(data)})
    # 출력 완료 직전 모든 선택 원본을 다시 읽는다. 변경된 소스로 READY를 만들지 않는다.
    if (read_regular(repo, config_path) != source_config or source_snapshot(repo) != payloads
            or git(repo, "rev-parse", "HEAD").decode().strip() != source_head
            or inspect_migrations(repo)["migrations"] != canonical["migrations"]
            or any(read_regular(repo, path) != data for path, data in pending_payloads.items())):
        raise PreparationError("준비 중 원본이 변경되었습니다. 새 임시 루트로 다시 준비하십시오.")
    database["pending"] = pending
    database["total_count"] = database["count"] + len(pending)
    database["excluded"] = [name for name in database["excluded"] if name not in {str(path) for path in GATEWAY_PENDING}]
    database["mode"] = "gateway_probe"
    with (destination / "database-manifest.json").open("w") as stream:
        json.dump(database, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    report = {
        "status": "READY", "mode": "gateway_probe", "sql_execution": "NOT_RUN", "edge_execution": "NOT_RUN",
        "output_root": str(destination), "source_head": source_head, "source_mode": "working_tree_snapshot",
        "migration_count": database["total_count"], "canonical_count": database["count"], "pending_count": len(pending),
        "functions": ["service-api"], "source_files": entries, "database_manifest": "database-manifest.json",
        "source_config_sha256": digest(source_config), "config_sha256": digest(rendered_config),
        "config_overlay": {"project_id": GATEWAY_PROJECT, "edge_runtime.enabled": True,
                           "functions": {"service-api": {"verify_jwt": False}}, "db.shadow_port": 56520,
                           **{section + ".port": port for section, port in GATEWAY_PORTS.items()}},
        "config_note": "database-manifest.json은 원본 config 해시를 보존하며 최종 실행 config 해시는 config_sha256이다.",
    }
    with (destination / "edge-manifest.json").open("x") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return report


def prepare_edge(repo, output, *, gateway_probe=False):
    if gateway_probe:
        return prepare_gateway_probe(repo, output)
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
    parser.add_argument("--gateway-probe", action="store_true", help="검토된 service-api 게이트웨이 검증 프로젝트만 명시적으로 준비")
    args = parser.parse_args()
    try:
        print(json.dumps(prepare_edge(args.repo, args.output, gateway_probe=args.gateway_probe), ensure_ascii=False, indent=2))
        return 0
    except (OSError, PreparationError) as exc:
        print(json.dumps({"status": "BLOCKED", "edge_execution": "NOT_RUN", "sql_execution": "NOT_RUN", "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
