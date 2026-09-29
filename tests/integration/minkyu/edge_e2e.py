#!/usr/bin/env python3
"""전용 로컬 Supabase gateway → 실제 Edge → Auth/PostgREST 검증.

DB 시작/종료는 호출자가 담당한다. 이 runner는 functions serve만 관리한다.
원격 배포·실제 PASS/문자·외부 모델 검증을 의미하지 않는다.
"""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import tempfile
import time
import tomllib
import uuid
from urllib.parse import urlencode
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from runtime_e2e import http, db, ROOT


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


def gateway(url, method="GET", body=None, token=None, headers=None, timeout=20):
    """게이트웨이의 비JSON 장애도 상태만 반환해 원문/키 출력 없이 진단한다."""
    db.require(url.startswith("http://127.0.0.1:55421/functions/v1/"), "로컬 gateway만 허용")
    request_headers = {"Content-Type": "application/json", **(headers or {})}
    if token is not None:
        request_headers["Authorization"] = "Bearer " + token
    data = None if body is None else json.dumps(body).encode()
    request = Request(url, method=method, headers=request_headers, data=data)
    try:
        response = build_opener(NoRedirect()).open(request, timeout=timeout)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read()
        try:
            payload = json.loads(raw) if raw else None
        except (ValueError, UnicodeDecodeError):
            payload = None
        return response.code, payload, {k.lower(): v for k, v in response.headers.items()}


def stop_process(process):
    """npx의 CLI 자식까지 종료한다. 다른 Supabase 프로젝트는 건드리지 않는다."""
    if process is None:
        return
    for action, timeout in ((signal.SIGINT, 8), (signal.SIGTERM, 5), (signal.SIGKILL, 5)):
        try:
            os.killpg(process.pid, action)
        except ProcessLookupError:
            break
        try:
            process.wait(timeout=timeout)
            # npx가 먼저 종료되어도 같은 그룹에 남은 CLI를 정리한다.
            os.killpg(process.pid, signal.SIGTERM)
            break
        except ProcessLookupError:
            break
        except subprocess.TimeoutExpired:
            continue
    process.wait(timeout=5)


def verify_snapshot(root):
    # prepare_edge와 같은 검증 코드를 사용한다. 실행 직전 저장소/복사본의
    # 변경·파일 추가·삭제·symlink도 확인하여 오래된 준비본을 실행하지 않는다.
    import prepare_edge
    report = json.loads(prepare_edge.read_regular(root, Path("edge-manifest.json")))
    db.require(report.get("status") == "READY" and report.get("functions") == ["service-api"], "Edge 준비 manifest 필요")
    db.require(report.get("output_root") == str(root), "Edge 준비 루트 불일치")
    db.require(report.get("source_head") == prepare_edge.git(ROOT, "rev-parse", "HEAD").decode().strip(), "준비 후 HEAD 변경")
    sources = prepare_edge.source_snapshot(ROOT)
    entries = report.get("source_files", [])
    db.require({entry["path"] for entry in entries} == {str(path) for path in sources}
               and len(entries) == len(sources), "준비 후 소스 목록 변경")
    targets = set()
    for entry in entries:
        path = Path(entry["path"])
        target = Path("supabase/functions") / path.relative_to(prepare_edge.FUNCTIONS)
        db.require(str(target) == entry["target"], "준비 소스 경로 불일치")
        db.require(prepare_edge.digest(sources[path]) == entry["sha256"] ==
                   prepare_edge.digest(prepare_edge.read_regular(root, target)), "준비 후 소스 변경")
        targets.add(str(target))
    actual = {str(path.relative_to(root)) for path in (root / "supabase/functions").rglob("*") if path.is_file() or path.is_symlink()}
    db.require(actual == targets, "준비 후 실행 파일 추가/삭제")
    original = prepare_edge.read_regular(ROOT, Path("backend/supabase/config.toml"))
    rendered = prepare_edge.read_regular(root, Path("supabase/config.toml"))
    db.require(prepare_edge.digest(original) == report["source_config_sha256"], "준비 후 원본 config 변경")
    db.require(prepare_edge.digest(rendered) == report["config_sha256"] and
               rendered == prepare_edge.edge_config(original), "준비 후 실행 config 변경")


def search_scenarios(call, author, tokens, sensitive, passed):
    """실제 GET → 종현 코어 → 민규 RPC. 동률·마이크로초를 가진 독립 가상 자료."""
    ids = sorted(str(uuid.uuid4()) for _ in range(4))
    now = datetime.now(timezone.utc).replace(microsecond=0)
    created = [(now - timedelta(hours=1)).replace(microsecond=123456)] * 2
    created += [created[0].replace(microsecond=123457), now - timedelta(days=1)]
    starts = [(now + timedelta(days=1)).replace(microsecond=123456)] * 2
    starts += [starts[0].replace(microsecond=123457), now - timedelta(days=3)]
    address, detail, description = "검색비공개주소 123", "검색비공개상세지점", "검색제외소개문구"
    sensitive.extend([address, detail, description])
    values = []
    for index, post_id in enumerate(ids):
        cost = "null,null" if index == 3 else "'free',0"
        deadline = starts[index] - timedelta(hours=2)
        values.append(f"('{post_id}','{author}','엣지검색전시{index}','{description}','전시',"
                      f"'{starts[index].isoformat()}','{(starts[index] + timedelta(hours=1)).isoformat()}',"
                      f"'{deadline.isoformat()}','서울특별시 종로구 삼청동','{created[index].isoformat()}',{cost})")
    db.sql("begin; insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,created_at,cost_type,amount) values " +
           ",".join(values) + f"; insert into private.post_search_locations(post_id,registered_place_name,registered_address) "
           f"values('{ids[0]}','검색전시장','{address}'); insert into public.post_private_details(post_id,exact_location) "
           f"values('{ids[0]}','{detail}'); commit;")

    def search(params=None, token=None, expected=200):
        query = urlencode(params or {})
        return call("/posts" + ("?" + query if query else ""), token=token, expected=expected)

    def card_ids(page):
        return [post["id"] for post in page["posts"]]

    anonymous = search()
    db.require(anonymous["status"] == "results" and card_ids(anonymous) == [ids[2], ids[0], ids[1], ids[3]], "검색 기본 등록일 순서 오류")
    fields = {"id", "title", "authorDisplayName", "publicArea", "startsAt", "endsAt", "cost", "state", "canApply"}
    for card in anonymous["posts"]:
        alias = card["authorDisplayName"]
        db.require(set(card) == fields and card["publicArea"] == "서울특별시 종로구 삼청동", "검색 공개 투영/동 누락")
        db.require(alias.startswith("동행 ") and alias[3:].isdigit() and card["canApply"] is False, "익명 별칭/신청 권한 오류")
    serialized = json.dumps(anonymous, ensure_ascii=False)
    db.require(not any(value in serialized for value in ["엣지검증회원", address, detail, description]), "익명 검색 비공개 원문 노출")
    db.require(anonymous["posts"][-1]["cost"] == {"kind": "unknown"}, "NULL 비용을 미상으로 반환하지 않음")
    db.require(card_ids(search({"availability": "recruiting"})) == [ids[2], ids[0], ids[1]], "모집 필터 오류")
    db.require(len(search({"cost": "free"})["posts"]) == 3 and search({"cost": "paid"})["status"] == "no_results", "비용 필터 오류")
    passed("search_anonymous_dong_alias_privacy_all_states_and_unknown_cost")

    age = (datetime.now(timezone.utc).year - 1990)
    age_filter = "30s" if age < 40 else "40plus"
    member = search({"authorAge": age_filter}, token=tokens[1])
    db.require(len(member["posts"]) == 4 and all(card["authorDisplayName"] == "엣****원" for card in member["posts"]), "회원 나이 필터/마스킹 오류")
    db.require(member["posts"][0]["canApply"] is True and member["posts"][-1]["canApply"] is False, "회원 검색 신청 권한 오류")
    db.require(search({"authorAge": "20s"}, token=tokens[1])["status"] == "no_results", "작성자 나이 필터 미적용")
    period = {"periodStart": (now + timedelta(hours=1)).isoformat(), "periodEnd": (now + timedelta(days=2)).isoformat()}
    db.require(len(search(period)["posts"]) == 3, "익명 기간 검색 거절/범위 오류")
    db.require(search({"authorAge": age_filter}, expected=401)["code"] == "AUTH_REQUIRED", "익명 상세 나이 제한 누락")
    search(token=tokens[0][:-8] + "AAAAAAAA", expected=401)
    passed("search_member_mask_age_anonymous_period_and_invalid_jwt")

    address_page = search({"query": "검색비공개주소"})
    db.require(card_ids(address_page) == [ids[0]] and address not in json.dumps(address_page, ensure_ascii=False), "등록 주소 검색/반환 권한 분리 실패")
    db.require(search({"query": detail})["status"] == "no_results" and search({"query": description})["status"] == "no_results", "상세 지점/소개가 검색됨")
    passed("search_registered_address_match_without_private_fields")

    first_cursor = None
    for sort, expected in (("created_desc", [ids[2], ids[0], ids[1], ids[3]]), ("starts_asc", [ids[3], ids[0], ids[1], ids[2]])):
        seen, cursor = [], None
        for _ in range(5):
            params = {"sort": sort, "limit": 1}
            if cursor:
                params["cursor"] = cursor
            page = search(params)
            seen.extend(card_ids(page))
            cursor = page["nextCursor"]
            if first_cursor is None:
                first_cursor = cursor
                decoded = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
                db.require(decoded["v"] == 2 and ".123457" in decoded["position"]["sortAt"], "v2 커서의 마이크로초 손실")
            if cursor is None:
                break
        db.require(seen == expected and cursor is None and len(set(seen)) == 4, "정렬/동률/마이크로초 페이지 중복·누락")
    for changed in ({"sort": "starts_asc"}, {"availability": "recruiting"}, {"query": "검색전시장"}):
        db.require(search({"cursor": first_cursor, **changed}, expected=400)["code"] == "INVALID_REQUEST", "필터 변경 커서 거절 실패")
    old = json.loads(base64.urlsafe_b64decode(first_cursor + "=" * (-len(first_cursor) % 4)))
    old["v"] = 1
    old_cursor = base64.urlsafe_b64encode(json.dumps(old).encode()).decode().rstrip("=")
    search({"cursor": old_cursor}, expected=400)
    passed("search_v2_sort_microseconds_ties_pagination_and_cursor_rejection")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workdir", required=True, type=Path)
    args = parser.parse_args()
    root = args.workdir.resolve()
    config_path = root / "supabase/config.toml"
    db.require(root.is_relative_to(Path("/private/tmp")) and not config_path.is_symlink(), "전용 임시 루트 필요")
    config = tomllib.loads(config_path.read_text())
    db.require(config.get("project_id") == db.PROJECT, "전용 project 필요")
    db.require(config.get("edge_runtime", {}).get("enabled") is True, "Edge 준비 설정 필요")
    db.require(config.get("functions", {}).get("service-api", {}).get("verify_jwt") is False, "서비스 자체 인증 설정 필요")
    verify_snapshot(root)
    endpoint = db.docker("context", "inspect", db.CONTEXT, "--format", "{{.Endpoints.docker.Host}}")
    inspection = db.docker("inspect", db.CONTAINER)
    db.validate_target(endpoint.stdout.strip(), json.loads(inspection.stdout)[0])
    env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR") if key in os.environ}
    env.update(SUPABASE_TELEMETRY_DISABLED="1", DO_NOT_TRACK="1",
               DOCKER_HOST="unix://" + str(Path.home() / ".colima/yumidang-minkyu/docker.sock"))
    result = subprocess.run(["npx", "--yes", "supabase@2.116.0", "status", "--workdir", str(root), "-o", "json"],
                            capture_output=True, text=True, env=env, timeout=30, check=True)
    keys = json.loads(result.stdout)
    api, anon, service = keys["API_URL"], keys["ANON_KEY"], keys["SERVICE_ROLE_KEY"]
    db.require(api in ("http://127.0.0.1:55421", "http://localhost:55421"), "원격 API 금지")
    api = "http://127.0.0.1:55421"
    base, origin = api + "/functions/v1/service-api", "http://127.0.0.1:5173"
    users, checks, findings, sensitive = [], [], [], [anon, service]
    process = None

    def passed(name):
        checks.append(name)
        print(json.dumps({"status": "PASS", "test": name}), flush=True)

    with db.SessionLock(73109000), tempfile.TemporaryDirectory(prefix="yumidang-edge-e2e-") as temp:
        db.require(db.sql("select (select count(*) from auth.users)+(select count(*) from public.profiles)+(select count(*) from public.posts)+(select count(*) from private.worker_jobs);").stdout.strip() == "0", "빈 전용 DB 필요")
        secret = secrets.token_urlsafe(48)
        sensitive.append(secret)
        env_file = Path(temp) / "edge.env"
        log_file = Path(temp) / "edge.log"
        # SUPABASE_*는 CLI가 컨테이너 내부 주소·로컬 키로 주입한다.
        values = {
            "INTERNAL_WORKER_SECRET": secret,
            "ALLOWED_ORIGINS": json.dumps([origin], separators=(",", ":")),
            "MAX_REQUEST_BYTES": "16384", "UPSTREAM_TIMEOUT_MS": "5000",
            "REVIEW_SUMMARY_MODEL_VERSION": "edge-fixture",
            "REVIEW_SUMMARY_PROMPT_VERSION": "edge-fixture",
        }
        env_file.write_text("\n".join(key + "='" + value + "'" for key, value in values.items()) + "\n")
        env_file.chmod(0o600)
        with log_file.open("w+") as log:
            log_file.chmod(0o600)
            try:
                verify_snapshot(root)
                process = subprocess.Popen(["npx", "--yes", "supabase@2.116.0", "functions", "serve", "service-api",
                    "--workdir", str(root), "--env-file", str(env_file)], env=env, stdout=log, stderr=log, start_new_session=True)
                started = time.monotonic()
                deadline = started + 180
                last_status, last_kind, last_failure = None, "no_response", "none"
                while True:
                    try:
                        status, payload, headers = gateway(base + "/me", headers={"Origin": origin}, timeout=2)
                        last_status = status
                        last_kind = ("application_envelope" if isinstance(payload, dict) and payload.get("requestId")
                                     else "json" if payload is not None else "non_json_or_empty")
                        last_failure = ("gateway_dns_failure" if isinstance(payload, dict)
                                        and payload.get("message") == "name resolution failed" else "none")
                        if status == 401 and isinstance(payload, dict) and payload.get("requestId") and payload["requestId"] == headers.get("x-request-id"):
                            break
                    except OSError:
                        last_status, last_kind, last_failure = None, "no_response", "connection_or_timeout"
                    if process.poll() is not None or time.monotonic() >= deadline:
                        # 원문·자격증명은 제외하고 고정 분류와 숫자만 출력한다.
                        print(json.dumps({"status": "FAIL", "stage": "edge_gateway_ready",
                            "last_http_status": last_status, "response_kind": last_kind,
                            "failure_kind": last_failure, "cli_exit_code": process.poll(),
                            "elapsed_seconds": round(time.monotonic() - started), "readiness_limit_seconds": 180}), flush=True)
                        raise AssertionError("Edge gateway 시작 실패(원문 출력 생략)")
                    time.sleep(0.25)
                passed("supabase_cli_edge_gateway_ready")
                tokens = []
                for _ in range(3):
                    email, password = secrets.token_hex(12) + "@example.invalid", secrets.token_urlsafe(36)
                    sensitive.extend([email, password])
                    status, user, _ = http(api + "/auth/v1/admin/users", "POST",
                        {"email": email, "password": password, "email_confirm": True}, service, service)
                    db.require(status == 200 and isinstance(user, dict), "가상 사용자 생성 실패")
                    users.append(str(uuid.UUID(user["id"])))
                    status, session, _ = http(api + "/auth/v1/token?grant_type=password", "POST",
                        {"email": email, "password": password}, apikey=anon)
                    db.require(status == 200 and "access_token" in session, "가상 세션 생성 실패")
                    tokens.append(session["access_token"])
                sensitive.extend(tokens)
                author, peer, outsider = users
                db.sql("insert into public.profiles(id,real_name,birth_date,gender) values " +
                       ",".join(f"('{uid}','엣지검증회원','1990-01-01','female')" for uid in users) + ";")

                def call(path, token=tokens[0], body=None, expected=200, method=None, headers=None):
                    status, payload, response_headers = gateway(base + path,
                        method or ("POST" if body is not None else "GET"), body, token, headers)
                    db.require(status == expected, f"Edge HTTP 상태 불일치 expected={expected} actual={status}")
                    db.require(isinstance(payload, dict), "Edge 공통 JSON 응답 없음")
                    request_id = payload.get("requestId")
                    db.require(isinstance(request_id, str) and request_id == response_headers.get("x-request-id"), "Edge requestId 불일치")
                    db.require(str(uuid.UUID(request_id)) == request_id, "서버 requestId 형식 오류")
                    db.require(response_headers.get("cache-control") == "no-store", "Edge no-store 누락")
                    db.require(response_headers.get("x-content-type-options") == "nosniff", "Edge nosniff 누락")
                    db.require(not any(value in json.dumps(payload, ensure_ascii=False) for value in [*tokens, anon, service, secret]), "응답에 자격증명 포함")
                    return payload.get("data") if expected == 200 else payload.get("error")

                for token in (None, tokens[0][:-8] + "AAAAAAAA", anon, service, secret):
                    db.require(call("/me", token=token, expected=401)["code"] == "AUTH_REQUIRED", "회원 인증 경계 오류")
                db.require(call("/me")["userId"] == author, "JWT 회원 전달 실패")
                passed("real_jwt_missing_tampered_anon_service_worker_isolation")

                preflight_status, _, preflight_headers = gateway(base + "/me", method="OPTIONS", headers={
                    "Origin": origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization, content-type"})
                _, _, allowed_headers = gateway(base + "/me", token=tokens[0], headers={"Origin": origin})
                def origin_kind(value):
                    return "exact_origin" if value == origin else "wildcard" if value == "*" else "missing" if value is None else "other"
                cors_observation = {
                    "preflight_status": preflight_status,
                    "preflight_origin": origin_kind(preflight_headers.get("access-control-allow-origin")),
                    "preflight_no_store": preflight_headers.get("cache-control") == "no-store",
                    "allowed_get_origin": origin_kind(allowed_headers.get("access-control-allow-origin")),
                }
                if (preflight_status != 204 or cors_observation["preflight_origin"] != "exact_origin"
                        or not cors_observation["preflight_no_store"] or cors_observation["allowed_get_origin"] != "exact_origin"):
                    # CLI의 Kong CORS plugin이 응답/OPTIONS를 변경할 수 있다.
                    # 실제 불일치를 PASS로 간주하지 않고 독립 실패로 남긴다.
                    finding = {"status": "FAIL", "test": "gateway_cors_contract",
                               "finding": "local_gateway_cors_override", **cors_observation}
                    findings.append(finding)
                    print(json.dumps(finding), flush=True)
                else:
                    passed("gateway_cors_contract")
                call("/me", headers={"Origin": "https://denied.example.invalid"}, expected=403)
                call("/me/extra", expected=404)
                call("/evil/service-api/me", expected=404)
                call("/me", body={}, expected=405)
                db.require(call("/posts", token=None)["status"] == "no_results", "빈 DB 공개 검색 연결 실패")
                passed("application_origin_denial_exact_routes_and_connected_search")
                search_scenarios(call, author, tokens, sensitive, passed)

                now, post_id = datetime.now(timezone.utc), str(uuid.uuid4())
                post = dict(postId=post_id, title="엣지 통합 동행", description="원문로그제외검증 " + secrets.token_hex(8), category="산책",
                    startsAt=(now + timedelta(days=3)).isoformat(), endsAt=(now + timedelta(days=3, hours=2)).isoformat(),
                    recruitmentEndsAt=(now + timedelta(days=2)).isoformat(), publicArea="서울특별시 강남구 역삼동",
                    registeredPlaceName="엣지 비공개 장소", registeredAddress="엣지 비공개 주소 123", meetingDetail="엣지 비공개 상세 지점", costType="free", amount=0)
                sensitive.extend([post["description"], post["registeredAddress"], post["meetingDetail"]])
                db.require(call("/posts", body=post)["alreadyCreated"] is False, "Edge 공고 생성 실패")
                db.require(call("/posts", body=post)["alreadyCreated"] is True, "Edge 공고 재요청 비멱등")
                call("/posts", body={**post, "title": "충돌 내용"}, expected=409)
                before = call("/posts/" + post_id, token=tokens[1])
                db.require("privateDetails" not in before and post["registeredAddress"] not in json.dumps(before, ensure_ascii=False), "확정 전 주소 노출")
                passed("free_post_idempotency_conflict_and_private_projection")

                message = "가상 엣지 신청 메시지 " + secrets.token_hex(8)
                sensitive.append(message)
                request_id = call("/posts/" + post_id + "/requests", token=tokens[1], body={"message": message})["id"]
                proposal = call("/requests/" + request_id + "/propose", body={})
                call("/requests/" + request_id + "/accept", body={"conditionVersion": proposal["conditionVersion"]}, expected=404)
                consent = call("/requests/" + request_id + "/consent", token=tokens[1])
                acceptance = {"conditionVersion": consent["conditionVersion"]}
                call("/requests/" + request_id + "/accept", token=tokens[1], body=acceptance)
                db.require(call("/requests/" + request_id + "/accept", token=tokens[1], body=acceptance)["alreadyConfirmed"], "Edge 확정 비멱등")
                db.require("privateDetails" in call("/posts/" + post_id, token=tokens[1]), "확정 당사자 정보 누락")
                db.require("privateDetails" not in call("/posts/" + post_id, token=tokens[2]), "제3자 정보 노출")
                passed("bilateral_match_and_confirmed_participant_access")

                call("/internal/maintenance", token=None, body={"limit": 100}, expected=401)
                for token in (tokens[0], service, anon):
                    call("/internal/maintenance", token=token, body={"limit": 100}, expected=403)
                maintained = call("/internal/maintenance", token=secret, body={"limit": 100})
                db.require(maintained["reviews"]["enqueuedCount"] == 0, "가상 미래 약속에서 작업 생성")
                passed("gateway_custom_worker_secret_and_internal_role_isolation")
                verify_snapshot(root)
                passed("source_snapshot_unchanged")
            finally:
                stop_process(process)
                if users:
                    ids = ",".join("'" + uid + "'" for uid in users)
                    db.sql(f"begin; delete from public.posts where author_id in ({ids}); delete from private.worker_jobs where payload->>'profileId' in ({ids}); commit;")
                    for uid in users:
                        status, _, _ = http(api + "/auth/v1/admin/users/" + uid, "DELETE", token=service, apikey=service)
                        db.require(status == 200, "가상 사용자 정리 실패")
            log.flush()
            log.seek(0)
            recorded = log.read()
            db.require(not any(value in recorded for value in sensitive), "Edge CLI 로그에 민감정보 포함")
            passed("edge_cli_logs_exclude_credentials_and_user_text")
        db.require(db.sql("select (select count(*) from auth.users)+(select count(*) from public.profiles)+(select count(*) from public.posts)+(select count(*) from private.worker_jobs);").stdout.strip() == "0", "Edge fixture 잔존")
    print(json.dumps({"status": "PARTIAL" if findings else "PASS", "scenarios_passed": len(checks),
        "findings": findings, "fixtures_remaining": 0, "runtime": "local Supabase Edge and gateway",
        "remote_deploy": "NOT_RUN", "public_search": "LOCAL_EDGE_VERIFIED"}))
    return 2 if findings else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        # SQL/외부 예외에는 본문이 포함될 수 있다. 자체 검증 문구만 출력한다.
        message = str(exc) if isinstance(exc, AssertionError) else type(exc).__name__
        print(json.dumps({"status": "FAIL", "error": message}, ensure_ascii=False))
        raise SystemExit(1)
