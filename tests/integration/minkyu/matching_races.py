#!/usr/bin/env python3
"""전용 임시 matching 프로젝트의 실제 독립 PostgreSQL 세션 경합 검증.

네이버·matching migration을 이미 적용한 빈 임시 DB에서만 --run으로 실행한다.
일반 yumidang-minkyu-db나 원격 URL을 사용하지 않는다. 합성 자료는 실행 후 삭제한다.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import select
import subprocess
import tempfile
import time
import uuid

CONTEXT = "colima-yumidang-minkyu"
PROJECT = "yumidang-minkyu-matching"
CONTAINER = "supabase_db_" + PROJECT
stage = "target"
diagnostic = None


def require(value):
    if not value:
        raise ValueError("LOCAL_RACE_CHECK_FAILED")


def command():
    return ["docker", "--context", CONTEXT, "exec", "-i", CONTAINER, "psql", "-X", "-qAt",
            "-h", "/var/run/postgresql", "-U", "postgres", "-d", "postgres",
            "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate"]


def sql(query, allow_error=False):
    global diagnostic
    result = subprocess.run(command(), input="set statement_timeout='25s';set lock_timeout='15s';set plpgsql.check_asserts=on;\n" + query,
                            capture_output=True, text=True, timeout=35)
    if result.returncode and not allow_error:
        descriptor, path = tempfile.mkstemp(prefix="yumidang-matching-race-", suffix=".log")
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(result.stdout + "\n" + result.stderr)
        state = re.search(r"(?m)^ERROR:\s+([0-9A-Z]{5})\b", result.stderr)
        diagnostic = {"sqlstate": state[1] if state else "UNKNOWN", "diagnosticFile": path}
        raise ValueError("LOCAL_SQL_FAILED")
    return result


def objects(result):
    return [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def wait_locked(name):
    require(re.fullmatch(r"ym_match_[a-z0-9_]+", name))
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        result = sql("select exists(select 1 from pg_stat_activity where application_name=" + literal(name) + " and wait_event_type='Lock');")
        if result.stdout.strip() == "t":
            return
        time.sleep(0.05)
    raise ValueError("LOCAL_RACE_BARRIER_TIMEOUT")


class Barrier:
    def __init__(self, key):
        self.key = key
        self.process = None

    def __enter__(self):
        self.process = subprocess.Popen(command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.process.stdin.write(f"select case when pg_try_advisory_lock({self.key}) then 'LOCKED' else 'BUSY' end;\n".encode())
            self.process.stdin.flush()
            require(select.select([self.process.stdout], [], [], 10)[0])
            require(self.process.stdout.readline().strip() == b"LOCKED")
            return self
        except BaseException:
            self.release()
            raise

    def release(self):
        if self.process is not None:
            if not self.process.stdin.closed:
                self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
            self.process.stdout.close()
            self.process.stderr.close()
            self.process = None

    def __exit__(self, *_):
        self.release()


def verify_target():
    endpoint = subprocess.run(["docker", "--context", CONTEXT, "context", "inspect", CONTEXT, "--format", "{{.Endpoints.docker.Host}}"],
                              capture_output=True, text=True, timeout=20)
    require(endpoint.returncode == 0 and endpoint.stdout.strip() == "unix://" + str(Path.home() / ".colima/yumidang-minkyu/docker.sock"))
    inspected = subprocess.run(["docker", "--context", CONTEXT, "inspect", CONTAINER], capture_output=True, text=True, timeout=20)
    require(inspected.returncode == 0)
    container = json.loads(inspected.stdout)[0]
    require(container.get("State", {}).get("Running") and container.get("Config", {}).get("Labels", {}).get("com.supabase.cli.project") == PROJECT)
    require(sql("select (select count(*) from auth.users)+(select count(*) from public.profiles);").stdout.strip() == "0")
    require(sql("select to_regclass('private.naver_sessions') is not null and to_regclass('private.match_consent_lifecycle') is not null and to_regprocedure('public.update_service_post(uuid,jsonb,timestamp with time zone)') is not null;").stdout.strip() == "t")


def execute():
    global stage
    verify_target()
    people = [str(uuid.uuid4()) for _ in range(4)]
    sessions = [str(uuid.uuid4()) for _ in people]
    images = [str(uuid.uuid4()) for _ in people]
    posts = []
    run_id = uuid.uuid4().hex

    def actor(index):
        uid, session = people[index], sessions[index]
        claims = json.dumps({"role": "authenticated", "sub": uid, "session_id": session})
        return f"set local role authenticated;do $$ begin perform set_config('request.jwt.claim.sub',{literal(uid)},true);perform set_config('request.jwt.claims',{literal(claims)},true);end $$;"

    def post(index, day):
        pid = str(uuid.uuid4()); posts.append(pid)
        start = datetime.now(timezone.utc) + timedelta(days=day)
        fmt = lambda date: date.isoformat(timespec="seconds")
        data = {"title": "가상 경합 공고", "description": "전용 로컬 합성 데이터", "category": "산책",
                "startsAt": fmt(start), "endsAt": fmt(start + timedelta(hours=2)), "recruitmentEndsAt": fmt(start - timedelta(hours=1)),
                "publicArea": "서울특별시 강남구 역삼동", "registeredPlaceName": "가상 장소", "registeredAddress": "서울특별시 강남구 가상주소",
                "meetingDetail": "가상 입구", "preferenceNote": None, "tags": [], "costType": "free", "amount": 0}
        sql("begin;" + actor(index) + f"select public.create_service_post('{pid}',{literal(json.dumps(data, ensure_ascii=False))}::jsonb);commit;")
        return pid, data

    def request(index, pid):
        result = sql("begin;" + actor(index) + f"select public.request_service_post('{pid}','합성 경합 검증 신청');commit;")
        return objects(result)[0]["id"]

    def propose(index, rid):
        result = sql("begin;" + actor(index) + f"select public.propose_match('{rid}');commit;")
        return objects(result)[0]["conditionVersion"]

    def race(label, index_a, action_a, index_b, action_b, key):
        name_a, name_b = "ym_match_" + label + "_a", "ym_match_" + label + "_b"
        with ThreadPoolExecutor(max_workers=2) as pool, Barrier(key) as barrier:
            a = pool.submit(sql, "begin;set application_name=" + literal(name_a) + ";" + actor(index_a) + action_a + f"select pg_advisory_xact_lock({key});commit;")
            wait_locked(name_a)
            b = pool.submit(sql, "begin;set application_name=" + literal(name_b) + ";" + actor(index_b) + action_b + "commit;", True)
            wait_locked(name_b)
            barrier.release()
            first, second = a.result(), b.result()
            require(first.returncode == 0 and second.returncode != 0 and re.search(r"\b40001\b", second.stderr))
            return objects(first)

    try:
        # fixture 삽입은 관리 역할에서만 한다. 실행 대상 RPC는 실제 authenticated 역할+session_id로 검사한다.
        stage = "fixture"
        fixture = "begin;"
        for uid, sid, image in zip(people, sessions, images):
            subject, alias = "matching-race-" + run_id + "-" + uid, str(uuid.uuid4()) + "@naver.yumidang.invalid"
            path = uid + "/" + image + ".jpg"
            fixture += f"""insert into auth.users(id,email) values('{uid}','{alias}');
            insert into auth.sessions(id,user_id) values('{sid}','{uid}');
            insert into public.profiles(id,real_name,birth_date,gender,avatar_url) values('{uid}','가상 경합회원','1990-01-01','female','{path}');
            insert into storage.objects(bucket_id,name,owner_id,metadata) values('profile-images','{path}','{uid}','{{"mimetype":"image/jpeg","size":128}}');
            insert into private.naver_accounts(subject,auth_email,user_id,real_name,birth_date,gender,verification_status,completed_at)
            values('{subject}','{alias}','{uid}','가상 경합회원','1990-01-01','female','qualified',clock_timestamp());
            insert into private.naver_sessions(session_id,user_id,subject) values('{sid}','{uid}','{subject}');"""
        sql(fixture + "commit;")

        stage = "two_proposers_single_active"
        pid, _ = post(0, 5)
        rid_a, rid_b = request(2, pid), request(3, pid)
        race("propose", 0, f"select public.propose_match('{rid_a}');", 0, f"select public.propose_match('{rid_b}');", 73112001)
        require(sql(f"select count(*) from private.match_consent_lifecycle where post_id='{pid}' and status='awaiting_consent';").stdout.strip() == "1")
        require(sql(f"select count(*) from public.join_requests where post_id='{pid}' and status='pending';").stdout.strip() == "2")

        stage = "close_vs_new_application"
        pid, _ = post(0, 11)
        race("close", 0, f"select public.close_service_post('{pid}');", 2, f"select public.request_service_post('{pid}','합성 마감 경합 신청');", 73112002)
        require(sql(f"select count(*) from public.join_requests where post_id='{pid}';").stdout.strip() == "0")

        stage = "update_vs_accept_old_version"
        pid, data = post(0, 8)
        rid = request(2, pid)
        version = propose(0, rid)
        updated_at = sql(f"select updated_at from public.posts where id='{pid}';").stdout.strip()
        data["title"] = "변경된 가상 경합 공고"
        action = f"select public.update_service_post('{pid}',{literal(json.dumps(data, ensure_ascii=False))}::jsonb,{literal(updated_at)}::timestamptz);"
        race("update", 0, action, 2, f"select public.accept_match('{rid}','{version}');", 73112003)
        require(sql(f"select count(*) from public.appointments where post_id='{pid}';").stdout.strip() == "0")
        require(sql(f"select status from private.match_consent_lifecycle where request_id='{rid}';").stdout.strip() == "invalidated")

        stage = "two_posts_same_member_overlap"
        pid_a, _ = post(0, 20)
        pid_b, _ = post(1, 20)
        rid_a, rid_b = request(2, pid_a), request(2, pid_b)
        version_a, version_b = propose(0, rid_a), propose(1, rid_b)
        race("accept", 2, f"select public.accept_match('{rid_a}','{version_a}');", 2, f"select public.accept_match('{rid_b}','{version_b}');", 73112004)
        require(sql(f"select count(*) from public.appointments where post_id in('{pid_a}','{pid_b}');").stdout.strip() == "1")
        return {"status": "PASS", "races": 4, "scope": "dedicated_disposable_local_database"}
    finally:
        # 영구/고객 자료에는 접근하지 않으며 이 실행의 UUID만 삭제한다. fixture INSERT 실패도 정리한다.
        stage_before_cleanup = stage
        stage = "cleanup"
        ids = ",".join(literal(value) for value in people)
        sql(f"""begin;set local storage.allow_delete_query='true';
        delete from public.posts where author_id in({ids});
        delete from private.naver_accounts where user_id in({ids});
        delete from public.profiles where id in({ids});
        delete from storage.objects where bucket_id='profile-images' and owner_id in({ids});
        delete from auth.users where id in({ids});commit;""")
        require(sql("select (select count(*) from auth.users)+(select count(*) from public.profiles)+(select count(*) from private.naver_accounts)+(select count(*) from private.naver_sessions);").stdout.strip() == "0")
        stage = stage_before_cleanup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    report = {"status": "NOT_RUN", "result": "EXPLICIT_RUN_REQUIRED"}
    if args.run:
        try:
            # 전체 경합 묶음도 세션 advisory lock으로 중복 실행을 막는다.
            verify_target()
            with Barrier(73112000):
                report = execute()
        except Exception:
            report = {"status": "FAIL", "stage": stage, "result": "LOCAL_RACE_OR_TARGET_CHECK_FAILED", **(diagnostic or {})}
    print(json.dumps(report))
    return 0 if report["status"] == "PASS" else 2 if report["status"] == "NOT_RUN" else 1


if __name__ == "__main__":
    raise SystemExit(main())
