#!/usr/bin/env python3
"""검토된 정식 41개와 최신 정책 SQL 24개를 service-api 로컬 검증 루트에 준비한다. 실행 없음."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import prepare_edge as edge
from prepare_migrations import CANONICAL, COPY, MIGRATIONS, PreparationError, git

# 검토된 특정 경로와 바이트만 허용한다. 수정된 SQL을 자동으로 승인하지 않는다.
CURRENT_POLICY_REVIEWED = {
    "backend/supabase/migrations/20261005001429_current_completion_consent_policy.sql": "22312f4333a4676a654a02a2802d63ebf6c7304923172a9dea6bf0de877df275",
    "backend/supabase/migrations/20261005001456_global_worker_lease.sql": "427c665cbe0686d6b70b33d5dc9b4546f7947fa9b5731a15670f1fd45f0fe6e9",
    "backend/supabase/migrations/20261005001538_current_public_search.sql": "f9b27ec0c373cf8264a6c0e7e7768a52c7bd4730c1644f8cb384391178d06d54",
    "backend/supabase/migrations/20261005002006_first_chat_application.sql": "46a7be5550c2a4e6c901899b06db4b7ebc7c833ef820b117cfbed24d43eef191",
    "backend/supabase/migrations/20261005002528_ai_atomic_requests.sql": "789e97ae1e179bff176f0fc5b9d18fed445e26d18d4b186ca877defc98f35c02",
    "backend/supabase/migrations/20261005003000_worker_job_fences.sql": "ce31ec87b09a40174b1ed6d277bb4abbc1cd8865e6855498a94686caccb12c90",
    "backend/supabase/migrations/20261005003159_current_summary_fences.sql": "e3796267685e641cc3aa0257bf2410ff4abec12c0ef5d52225ff14ba54fd4cbc",
    "backend/supabase/migrations/20261005005459_current_recruitment_reopen.sql": "af2c94c092e757765aef5745ce73bd83a146842875cf93b29a933102127c875e",
    "backend/supabase/migrations/20261005005855_current_member_blocks.sql": "28ad42ff14cae65bd6b984667119113753d04cf78b79c969b05d9a3fe675de69",
    "backend/supabase/migrations/20261005013901_current_sweetness_ledger.sql": "6db41b47a2f469d1370f2589f9a1daedc854275eac65f220fcb37909002a891e",
    "backend/supabase/migrations/20261005014629_appointment_place_change_draft.sql": "a3c2284bf1b2fbf19c3a4404c1deea2eaa6314c9faee51894c3b5c30e4e4904c",
    "backend/supabase/migrations/20261005014630_appointment_location_validation.sql": "93d7ab1d413a6e46425218798925f26440e8f1a674e2c3830e60394b862fa0c7",
    "backend/supabase/migrations/20261005015709_member_reports.sql": "317fbb34f1e07bf37976b3d9ec809f0ca6bfabf787006aad737e6552aeffc07c",
    "backend/supabase/migrations/20261005020135_current_member_lifecycle.sql": "d24d3e338e9a8876c3d34c761f3fe9c863095faa95d93bf0055c471a81ab266d",
    "backend/supabase/migrations/20261005020136_member_cleanup_dependencies.sql": "a5a5827f1d79887d36d3e22bba5d42a45f93702ae770f9a20822da7eea39259b",
    "backend/supabase/migrations/20261005021810_sanction_adjudication_draft.sql": "b3c56b87385b5bf835f7ae52390b80b963d50b9308dc3878b8645a756905120f",
    "backend/supabase/migrations/20261005030100_member_retention_batches.sql": "c7877762ca88df738a991b35fc65ae4144e1de6eaf7fca44b623caadaa7a1e60",
    "backend/supabase/migrations/20261005021811_member_activity_sanction_gates.sql": "cf30480c6254060fbaef2bba375260d611ed17059ac200aee2af93d90da80255",
    "backend/supabase/migrations/20261005040100_worker_queue_schedule.sql": "71e18556baf27779a68fb209fb5b1cb51310ef5e6511c5cd5d65402de397aee5",
    "backend/supabase/migrations/20261005040300_worker_queue_runner_role.sql": "49d7d72b47b33e5fee407498e6c09882c3e929de06c815240f10781d4c11917c",
    "backend/supabase/migrations/20261005040500_member_profile_preferences.sql": "98ce66ffc50229a6713266197b315a1eeec2e69bbdd5fe1908c1c45cb70bd278",
    "backend/supabase/migrations/20261005040600_appointment_change_withdrawal.sql": "80d58914f8db461c9e5d961b4a5ebcc8c51aaa6a0ce76fd843333e2079d5a10b",
    "backend/supabase/migrations/20261005040700_member_safety_state.sql": "39f2cabe90cc137252be7953f5c0078f087f78f8ce7a2fbeda469a7309e555cf",
    "backend/supabase/migrations/20261005040800_appointment_safety_result_sync.sql": "afc727a109454d430ab2b39b7d8000c2f7f49638c4351200454827c8a2c1ab80",
}
QUEUE_RUNNER_ROLE_MIGRATION = "backend/supabase/migrations/20261005040300_worker_queue_runner_role.sql"
PROFILE_PREFERENCES_MIGRATION = "backend/supabase/migrations/20261005040500_member_profile_preferences.sql"
APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION = "backend/supabase/migrations/20261005040600_appointment_change_withdrawal.sql"
MEMBER_SAFETY_STATE_MIGRATION = "backend/supabase/migrations/20261005040700_member_safety_state.sql"
APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION = "backend/supabase/migrations/20261005040800_appointment_safety_result_sync.sql"
CONFIG = Path("backend/supabase/config.toml")


def inspect_current_migrations(repo):
    """HEAD 28/41/60/61/62/63/64/65의 정확한 집합과 현재 65개 바이트를 모두 검토 해시와 비교한다."""
    repo = Path(repo).resolve()
    if Path(git(repo, "rev-parse", "--show-toplevel").decode().strip()).resolve() != repo:
        raise PreparationError("--repo는 저장소 최상위 경로여야 합니다.")
    base = edge.GATEWAY_REVIEWED_MIGRATIONS
    policy = CURRENT_POLICY_REVIEWED
    reviewed = {**base, **policy}
    pending_base = {str(path) for path in edge.GATEWAY_PENDING}
    if (len(base) != 41 or len(policy) != 24 or len(reviewed) != 65
            or not {QUEUE_RUNNER_ROLE_MIGRATION, PROFILE_PREFERENCES_MIGRATION, APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION, MEMBER_SAFETY_STATE_MIGRATION, APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION} <= set(policy)
            or not pending_base <= set(base)):
        raise PreparationError("검토된 기존 41개와 최신 24개 목록이 필요합니다.")
    source_head = git(repo, "rev-parse", "HEAD").decode().strip()
    head_names = git(repo, "ls-tree", "-r", "--name-only", "-z", "HEAD", "--", str(MIGRATIONS)).decode().split("\0")
    head = set()
    excluded = set()
    for name in filter(None, head_names):
        path = Path(name)
        if path.suffix != ".sql":
            continue
        if COPY.search(path.name):
            excluded.add(name)
            continue
        if path.parent != MIGRATIONS or not CANONICAL.fullmatch(path.name) or name not in reviewed:
            raise PreparationError(f"검토 목록 밖 HEAD SQL입니다: {name}")
        if edge.digest(git(repo, "show", f"HEAD:{name}")) != reviewed[name]:
            raise PreparationError(f"HEAD SQL 내용이 검토된 해시와 다릅니다: {name}")
        head.add(name)
    # 이전 이력은 정확한 경로 집합으로 고정한다. 개수만 같은 임의 subset은 거절한다.
    previous60 = set(reviewed) - {QUEUE_RUNNER_ROLE_MIGRATION, PROFILE_PREFERENCES_MIGRATION, APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION, MEMBER_SAFETY_STATE_MIGRATION, APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION}
    previous61 = set(reviewed) - {PROFILE_PREFERENCES_MIGRATION, APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION, MEMBER_SAFETY_STATE_MIGRATION, APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION}
    previous62 = set(reviewed) - {APPOINTMENT_CHANGE_WITHDRAWAL_MIGRATION, MEMBER_SAFETY_STATE_MIGRATION, APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION}
    previous63 = set(reviewed) - {MEMBER_SAFETY_STATE_MIGRATION, APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION}
    previous64 = set(reviewed) - {APPOINTMENT_SAFETY_RESULT_SYNC_MIGRATION}
    if head not in (set(base) - pending_base, set(base), previous60, previous61, previous62, previous63, previous64, set(reviewed)):
        raise PreparationError("검토된 HEAD 28개/41개/60개/61개/62개/63개/64개/65개 전체만 준비할 수 있습니다.")
    # 기존 strict gateway 검사도 그대로 실행한다. 60/61/62/63/64/65개일 때는 기존 41개 집합만 전달한다.
    base_head = sorted(head & set(base))
    base_report = {"count": len(base_head), "migrations": [
        {"path": name, "sha256": reviewed[name]} for name in base_head]}
    edge.validate_reviewed_migration_history(base_report)
    payloads, entries, versions, hashes = {}, [], set(), set()
    for name, expected in sorted(reviewed.items()):
        path = Path(name)
        match = CANONICAL.fullmatch(path.name)
        data = edge.read_regular(repo, path)
        sha = edge.digest(data)
        if not match or not data.strip() or sha != expected:
            raise PreparationError(f"현재 SQL 내용이 검토된 해시와 다릅니다: {name}")
        if match[1] in versions or sha in hashes:
            raise PreparationError("선택 SQL 버전·내용이 중복됩니다.")
        versions.add(match[1]); hashes.add(sha)
        payloads[path] = data
        entries.append({"version": match[1], "path": name, "sha256": sha, "bytes": len(data)})
    # untracked/staged 신파일도 고정 목록으로만 선택한다. 사본은 선택하지 않고 기록한다.
    for candidate in (repo / MIGRATIONS).rglob("*.sql"):
        path = candidate.relative_to(repo)
        if COPY.search(path.name):
            excluded.add(str(path))
        elif str(path) not in reviewed:
            raise PreparationError(f"검토 목록 밖 현재 SQL입니다: {path}")
    pending = [entry for entry in entries if entry["path"] not in head]
    canonical = [entry for entry in entries if entry["path"] in head]
    return {"source_head": source_head, "canonical": canonical, "pending": pending,
            "entries": entries, "excluded": sorted(excluded)}, payloads


def create_base_snapshot(snapshot, payloads, config, sources):
    """검증된 바이트만 임시 Git에 기록한다. 원본 저장소/index/HEAD는 변경하지 않는다."""
    selected = {**{path: data for path, data in payloads.items()
                   if str(path) in edge.GATEWAY_REVIEWED_MIGRATIONS}, CONFIG: config, **sources}
    for path, data in selected.items():
        target = snapshot / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
    for args in (("init", "-q"), ("add", "."),
                 ("-c", "user.name=Local policy preparation", "-c", "user.email=local-policy@example.invalid",
                  "-c", "commit.gpgsign=false", "commit", "-qm", "Reviewed 41 migration snapshot")):
        try:
            subprocess.run(["git", "-C", str(snapshot), *args], env=environment,
                           capture_output=True, check=True, timeout=15)
        except (OSError, subprocess.SubprocessError) as exc:
            raise PreparationError("검토된 기존 SQL의 임시 Git 준비에 실패했습니다.") from exc
    return git(snapshot, "rev-parse", "HEAD").decode().strip()


def write_manifest(path, report):
    with path.open("x") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def prepare_current_policy(repo, output, *, gateway_probe=False):
    if not gateway_probe:
        raise PreparationError("최신 정책 준비에는 명시적 --gateway-probe가 필요합니다.")
    repo = Path(repo).resolve()
    history, sql_payloads = inspect_current_migrations(repo)
    config = edge.read_regular(repo, CONFIG)
    edge.gateway_config(config)  # 기존 임시 프로젝트/포트/함수 overlay 범위를 그대로 검증한다.
    sources = edge.source_snapshot(repo)
    destination = edge.private_gateway_output(repo, output)
    with tempfile.TemporaryDirectory(prefix="yumidang-policy-base-", dir="/private/tmp") as temporary:
        snapshot = Path(temporary) / "repo"
        snapshot.mkdir(mode=0o700)
        base_head = create_base_snapshot(snapshot, sql_payloads, config, sources)
        base_report = edge.prepare_gateway_probe(snapshot, destination)
    # 기존 도구의 READY는 41개 준비만 증명한다. 최신 정책 artifact와 별도 이름으로 보존한다.
    for name in ("migration", "database", "edge"):
        (destination / f"{name}-manifest.json").rename(destination / f"base-{name}-manifest.json")
    for path, data in sql_payloads.items():
        if str(path) in CURRENT_POLICY_REVIEWED:
            with (destination / "supabase/migrations" / path.name).open("xb") as stream:
                stream.write(data)
    current_history, current_sql = inspect_current_migrations(repo)
    if (current_history != history or current_sql != sql_payloads
            or edge.read_regular(repo, CONFIG) != config or edge.source_snapshot(repo) != sources):
        raise PreparationError("준비 중 원본이 변경되었습니다. 새 임시 루트로 다시 준비하십시오.")
    shared = {"status": "READY", "mode": "current_policy_gateway", "sql_execution": "NOT_RUN",
              "edge_execution": "NOT_RUN", "output_root": str(destination),
              "source_head": history["source_head"], "source_mode": "working_tree_snapshot",
              "canonical_count": len(history["canonical"]), "pending_count": len(history["pending"]),
              "migration_count": 65, "base_migration_count": 41, "policy_migration_count": 24,
              "base_snapshot_head": base_head, "base_manifests": [f"base-{name}-manifest.json" for name in ("migration", "database", "edge")],
              "preparation_note": "파일 준비 결과이며 실제 SQL 적용·Edge 실행·운영 배포 검증이 아니다."}
    migration = {**shared, "count": 65, "migrations": history["entries"], "excluded": history["excluded"]}
    database = {**shared, "count": len(history["canonical"]), "total_count": 65,
                "migrations": history["canonical"], "pending": history["pending"],
                "excluded": history["excluded"], "config_sha256": edge.digest(config)}
    report = {**base_report, **shared, "base_snapshot_head": base_head,
              "policy_migrations": [entry for entry in history["entries"] if entry["path"] in CURRENT_POLICY_REVIEWED]}
    write_manifest(destination / "migration-manifest.json", migration)
    write_manifest(destination / "database-manifest.json", database)
    write_manifest(destination / "edge-manifest.json", report)
    write_manifest(destination / "current-policy-manifest.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--gateway-probe", action="store_true")
    args = parser.parse_args()
    try:
        result = prepare_current_policy(args.repo, args.output, gateway_probe=args.gateway_probe)
    except (PreparationError, OSError) as exc:
        print(json.dumps({"status": "BLOCKED", "sql_execution": "NOT_RUN", "edge_execution": "NOT_RUN", "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
