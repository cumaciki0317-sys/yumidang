#!/usr/bin/env python3
"""전용 로컬 Auth/JWT → 실제 Deno 진입점 → PostgREST/RPC 통합 검사.

외부 공급사·모델을 호출하지 않는다. 로그인은 테스트 계정의 로컬 Auth 세션이다.
"""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/local"))
import run_database_tests as db


def http(url, method="GET", body=None, token=None, apikey=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if apikey:
        headers["apikey"] = apikey
    data = None if body is None else json.dumps(body).encode()
    try:
        with urlopen(Request(url, data=data, method=method, headers=headers), timeout=20) as response:
            return response.status, json.loads(response.read() or b"null"), dict(response.headers)
    except HTTPError as error:
        return error.code, json.loads(error.read() or b"null"), dict(error.headers)


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workdir", required=True, type=Path, help="prepare_database로 만든 전용 임시 루트")
    args = parser.parse_args()
    workdir = args.workdir.resolve()
    config_file = workdir / "supabase/config.toml"
    import tomllib
    db.require(workdir.is_relative_to(Path('/private/tmp')) and not config_file.is_symlink(), "전용 임시 루트만 허용")
    db.require(tomllib.loads(config_file.read_text()).get('project_id') == db.PROJECT, "전용 project_id 필요")
    context = db.docker("context", "inspect", db.CONTEXT, "--format", "{{.Endpoints.docker.Host}}")
    inspected = db.docker("inspect", db.CONTAINER)
    db.validate_target(context.stdout.strip(), json.loads(inspected.stdout)[0])
    env = dict(os.environ, SUPABASE_TELEMETRY_DISABLED="1", DO_NOT_TRACK="1",
               DOCKER_HOST="unix://" + str(Path.home() / ".colima/yumidang-minkyu/docker.sock"))
    result = subprocess.run(["npx", "--yes", "supabase@2.116.0", "status", "--workdir", str(workdir), "-o", "json"],
                            capture_output=True, text=True, env=env, timeout=30, check=True)
    credentials = json.loads(result.stdout)
    api = credentials["API_URL"]
    db.require(api in ("http://127.0.0.1:55421", "http://localhost:55421"), "원격 API 사용 금지")
    anon, service = credentials["ANON_KEY"], credentials["SERVICE_ROLE_KEY"]
    created, checks = [], []
    process = None
    def passed(name):
        checks.append(name)
        print(json.dumps({"status": "PASS", "test": name}), flush=True)
    with db.SessionLock(73109000), tempfile.TemporaryDirectory(prefix="yumidang-runtime-") as temp:
        db.require(db.sql("select count(*) from auth.users;").stdout.strip() == "0", "비어 있는 전용 DB만 허용")
        try:
            tokens = []
            for _ in range(3):
                email = secrets.token_hex(12) + "@example.invalid"
                password = secrets.token_urlsafe(36)
                status, user, _ = http(api + "/auth/v1/admin/users", "POST",
                    {"email": email, "password": password, "email_confirm": True}, service, service)
                db.require(status == 200 and isinstance(user.get("id"), str), "로컬 테스트 계정 생성 실패")
                import uuid
                user_id = str(uuid.UUID(user["id"]))
                created.append(user_id)
                status, session, _ = http(api + "/auth/v1/token?grant_type=password", "POST",
                    {"email": email, "password": password}, apikey=anon)
                db.require(status == 200 and "access_token" in session, "로컬 테스트 세션 발급 실패")
                tokens.append(session["access_token"])
            author, peer, outsider = created
            db.sql("insert into public.profiles(id,real_name,birth_date,gender) values " +
                   ",".join(f"('{uid}','연결검증회원','1990-01-01','female')" for uid in created) + ";")
            passed("local_auth_sessions_created")
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            secret = secrets.token_urlsafe(48)
            child_env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR") if key in os.environ}
            child_env.update(SUPABASE_URL=api, SUPABASE_ANON_KEY=anon, SUPABASE_SERVICE_ROLE_KEY=service,
                INTERNAL_WORKER_SECRET=secret, ALLOWED_ORIGINS='["http://127.0.0.1:5173"]',
                MAX_REQUEST_BYTES="65536", UPSTREAM_TIMEOUT_MS="5000",
                REVIEW_SUMMARY_MODEL_VERSION="integration-fixture", REVIEW_SUMMARY_PROMPT_VERSION="integration-fixture")
            launcher = Path(temp) / "serve.ts"
            launcher.write_text('import {createRuntimeHandler} from ' + json.dumps((ROOT / 'backend/supabase/functions/service-api/index.ts').as_uri()) +
                               f';\nDeno.serve({{hostname:"127.0.0.1",port:{port}}},createRuntimeHandler(key=>Deno.env.get(key)));\n')
            with (Path(temp) / "runtime.log").open("w+") as log:
                process = subprocess.Popen(["deno", "run", "--no-remote", "--allow-env=" + ",".join(k for k in child_env if k not in ('HOME','PATH','TMPDIR')),
                    f"--allow-net=127.0.0.1:{port},127.0.0.1:55421,localhost:55421", str(launcher)],
                    env=child_env, stdout=log, stderr=log)
                deadline = time.monotonic() + 15
                while True:
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.2): break
                    except OSError:
                        db.require(process.poll() is None and time.monotonic() < deadline, "Deno HTTP 서버 시작 실패")
                        time.sleep(0.1)
                base = f"http://127.0.0.1:{port}/functions/v1/service-api"
                def call(path, token=tokens[0], body=None, expected=200):
                    status, payload, headers = http(base + path, "POST" if body is not None else "GET", body, token)
                    db.require(status == expected, f"HTTP 상태 불일치: {path} expected={expected} actual={status}")
                    db.require(payload.get('requestId') == (headers.get('x-request-id') or headers.get('X-Request-Id')), "requestId 불일치")
                    return payload.get('data') if status == 200 else payload.get('error')
                call('/me', token=None, expected=401)
                call('/me', token=tokens[0][:-8] + 'AAAAAAAA', expected=401)
                call('/me', token=service, expected=401)
                db.require(call('/me')['userId'] == author, "JWT 사용자 전달 불일치")
                passed("real_jwt_validation_and_role_isolation")
                post_id = str(uuid.uuid4())
                now = datetime.now(timezone.utc)
                post = dict(postId=post_id,title="실제 API 동행",description="가상 연결 검증",category="산책",
                    startsAt=(now+timedelta(days=3)).isoformat(),endsAt=(now+timedelta(days=3,hours=2)).isoformat(),
                    recruitmentEndsAt=(now+timedelta(days=2)).isoformat(),publicArea="서울특별시 강남구 역삼동",
                    registeredPlaceName="비공개장소",registeredAddress="비공개주소 123",meetingDetail="상세 만남 지점",
                    costType="free",amount=0)
                db.require(call('/posts',body=post)['alreadyCreated'] is False, "공고 생성 실패")
                db.require(call('/posts',body=post)['alreadyCreated'] is True, "공고 중복 생성")
                call('/posts',body={**post,'title':'변경된 재요청'},expected=409)
                call('/posts',body={**post,'postId':str(uuid.uuid4()),'costType':'paid_request','amount':1000},expected=503)
                details = call('/posts/'+post_id,token=tokens[1])
                db.require('privateDetails' not in details and '비공개주소' not in json.dumps(details,ensure_ascii=False), "확정전 위치 노출")
                request_id = call('/posts/'+post_id+'/requests',token=tokens[1],body={'message':'동행에 참여하는 가상 신청입니다'})['id']
                proposal = call('/requests/'+request_id+'/propose',body={})
                call('/requests/'+request_id+'/accept',body={'conditionVersion':proposal['conditionVersion']},expected=404)
                consent = call('/requests/'+request_id+'/consent',token=tokens[1])
                db.require(len(consent['conditionVersion']) == 36, "무작위 조건 버전 필요")
                accepted = call('/requests/'+request_id+'/accept',token=tokens[1],body={'conditionVersion':consent['conditionVersion']})
                appointment = str(uuid.UUID(accepted['appointmentId']))
                db.require(call('/requests/'+request_id+'/accept',token=tokens[1],body={'conditionVersion':consent['conditionVersion']})['alreadyConfirmed'], "매칭 재요청 비멱등")
                db.require('privateDetails' in call('/posts/'+post_id,token=tokens[1]), "당사자 위치 미제공")
                db.require('privateDetails' not in call('/posts/'+post_id,token=tokens[2]), "제3자 위치 노출")
                passed("post_request_bilateral_match_and_private_detail")
                call('/appointments/'+appointment,token=tokens[2],expected=404)
                message = {'messageId':str(uuid.uuid4()),'content':'동행 메시지 검증'}
                call('/conversations/'+request_id+'/messages',body=message)
                db.require(call('/conversations/'+request_id+'/messages',body=message)['alreadySent'], "메시지 재요청 비멱등")
                call('/conversations/'+request_id+'/messages',token=tokens[2],expected=404)
                notifications = call('/notifications')['items']
                db.require(bool(notifications), "알림 없음")
                call('/notifications/'+notifications[0]['notificationId']+'/read',body={})
                passed("conversation_and_notification_ownership")
                # Advance only this fixture's schedule to the already-ended state.
                db.sql(f"update public.posts set starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour',recruitment_ends_at=now()-interval '3 hours' where id='{post_id}';")
                first = call('/appointments/'+appointment+'/confirm-completion',body={})[0]
                db.require(first['status']=='confirmed' and first['completed_at'] is None, "단측 완료 발생")
                second = call('/appointments/'+appointment+'/confirm-completion',token=tokens[1],body={})[0]
                db.require(second['status']=='completed', "양측 완료 실패")
                repeat = call('/appointments/'+appointment+'/confirm-completion',body={})[0]
                db.require(repeat['completed_at']==second['completed_at'], "완료 시각 재설정")
                passed("bilateral_completion_and_idempotent_deadlines")
                review = {'rating':5,'experience':'positive','comment':'배려해 주는 동행이었어요','praises':[]}
                call('/appointments/'+appointment+'/reviews',body=review)
                call('/appointments/'+appointment+'/reviews',token=tokens[1],body=review)
                db.require(call('/appointments/'+appointment+'/reviews',body=review)['deduplicated'], "후기 재요청 실패")
                call('/appointments/'+appointment+'/reviews',body={**review,'rating':1},expected=409)
                db.require(call('/profiles/'+author+'/reviews')['reviews']==[], "24시간 전에 공개됨")
                status, _, _ = http(base+'/internal/maintenance','POST',{'limit':100},tokens[0])
                db.require(status in (401,403), "사용자 토큰으로 내부 작업 실행")
                call('/internal/maintenance',token=secret,body={'limit':100})
                passed("immutable_reviews_hold_and_internal_auth")
                db.sql(f"update public.appointments set completed_at=now()-interval '25 hours',completion_notified_at=now()-interval '25 hours',dispute_deadline_at=now()-interval '1 hour',review_deadline_at=now()+interval '143 hours' where id='{appointment}';")
                # Two more explicit SQL fixtures give each participant three texts;
                # no provider or model output is fabricated as product success.
                for _ in range(2):
                    p,r,a = [str(uuid.uuid4()) for _ in range(3)]
                    db.sql(f"""begin;
                    insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)
                    values('{p}','{author}','추가 가상 동행','테스트','산책',now()-interval '3 days',now()-interval '2 days',now()-interval '4 days','서울특별시 강남구 역삼동');
                    insert into public.join_requests(id,post_id,requester_id,message,status) values('{r}','{p}','{peer}','통합 테스트용 신청입니다','matched');
                    insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
                    values('{a}','{p}','{r}','completed',now()-interval '25 hours','automatic',now()-interval '25 hours',now()-interval '1 hour',now()+interval '143 hours');
                    insert into public.appointment_reviews(appointment_id,reviewer_id,rating,comment,experience)
                    values('{a}','{author}',5,'가상 공개 후기','positive'),('{a}','{peer}',5,'가상 공개 후기','positive'); commit;""")
                maintenance = call('/internal/maintenance',token=secret,body={'limit':100})
                db.require(maintenance['reviews']['enqueuedCount']==2, "세개 이상 텍스트 재요약 작업 미등록")
                db.require(len(call('/profiles/'+author+'/reviews')['reviews'])==3, "공개 원문 조회 실패")
                db.require(call('/internal/maintenance',token=secret,body={'limit':100})['reviews']['enqueuedCount']==0, "중복 재요약 등록")
                passed("publication_outbox_and_deduplicated_summary_jobs")
                # No tokens, passwords, or source bodies may be written by the API.
                log.flush()
                log.seek(0)
                recorded = log.read()
                db.require(not any(value in recorded for value in tokens+[service,secret,review['comment'],message['content']]), "런타임 로그에 민감정보 포함")
                passed("runtime_logs_exclude_credentials_and_user_text")
        finally:
            if process is not None:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=5)
            if created:
                ids = ','.join("'"+value+"'" for value in created)
                db.sql(f"begin; delete from public.posts where author_id in ({ids}); delete from private.worker_jobs where payload->>'profileId' in ({ids}); commit;")
                for uid in created:
                    status, _, _ = http(api+'/auth/v1/admin/users/'+uid,'DELETE',token=service,apikey=service)
                    db.require(status==200, "가상 사용자 정리 실패")
        db.require(db.sql("select (select count(*) from auth.users)+(select count(*) from public.profiles)+(select count(*) from private.worker_jobs);").stdout.strip()=='0', "통합 fixture 잔존")
    print(json.dumps({"status":"PASS","scenarios":len(checks),"fixtures_remaining":0,"runtime":"local Deno + Supabase Auth/PostgREST"}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Never dump response bodies, commands with credentials, or exception repr.
        message = str(exc) if isinstance(exc, (AssertionError, RuntimeError)) else type(exc).__name__
        print(json.dumps({"status":"FAIL","error":message},ensure_ascii=False))
        raise SystemExit(1)
