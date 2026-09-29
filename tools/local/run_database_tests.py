#!/usr/bin/env python3
"""전용 로컬 DB에서 rollback SQL + 독립 세션 경쟁 검증. 원격 URL 입력 없음."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import select
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
CONTEXT = "colima-yumidang-minkyu"
PROJECT = "yumidang-minkyu-db"
CONTAINER = "supabase_db_" + PROJECT
TESTS = ("worker_jobs.sql", "public_post_search.sql", "review_summary_storage.sql",
         "bilateral_completion.sql", "review_automation.sql", "core_service_api.sql", "public_search_v2.sql")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def psql_command():
    return ["docker", "--context", CONTEXT, "exec", "-i", CONTAINER, "psql", "-X", "-qAt",
            "-h", "/var/run/postgresql", "-p", "5432", "-U", "postgres", "-d", "postgres",
            "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate"]


class SessionLock:
    """프로세스가 살아 있는 동안 잠금 유지. stdin EOF 시 PG 연결/잠금도 해제."""
    def __init__(self, key):
        self.key = key
        self.process = None

    def __enter__(self):
        self.process = subprocess.Popen(psql_command(), stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.process.stdin.write(f"select case when pg_try_advisory_lock({self.key}) then 'LOCKED' else 'BUSY' end;\n".encode())
            self.process.stdin.flush()
            if not select.select([self.process.stdout], [], [], 10)[0]:
                raise RuntimeError("로컬 DB 잠금 응답 시간 초과")
            if self.process.stdout.readline().strip() != b"LOCKED":
                raise RuntimeError("다른 로컬 검증이 진행 중이거나 잠금을 얻지 못했습니다.")
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


def validate_target(endpoint, container):
    expected = "unix://" + str(Path.home() / ".colima/yumidang-minkyu/docker.sock")
    if endpoint != expected:
        raise ValueError("전용 Colima 로컬 소켓만 허용합니다.")
    if container.get("Config", {}).get("Labels", {}).get("com.supabase.cli.project") != PROJECT:
        raise ValueError("전용 Supabase 프로젝트 컨테이너가 아닙니다.")
    if not container.get("State", {}).get("Running"):
        raise ValueError("로컬 DB가 실행 중이 아닙니다.")


def docker(*args, **kwargs):
    return subprocess.run(["docker", "--context", CONTEXT, *args], capture_output=True,
                          text=True, timeout=kwargs.pop("timeout", 30), **kwargs)


def sql(query, *, allow_error=False):
    result = subprocess.run(psql_command(), capture_output=True, text=True, timeout=30,
                            input="set statement_timeout='15s'; set plpgsql.check_asserts=on;\n" + query)
    if result.returncode and not allow_error:
        raise RuntimeError("SQL 검증 실패: " + result.stderr.strip())
    return result


def objects(result):
    return [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]


def wait_event(name, event_type=None, event=None):
    # application_name은 이 파일에서 정한 상수만 전달한다.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        condition = f"application_name='{name}'"
        if event_type:
            condition += f" and wait_event_type='{event_type}'"
        if event:
            condition += f" and wait_event='{event}'"
        if sql("select exists(select 1 from pg_stat_activity where " + condition + ");").stdout.strip() == "t":
            return
        time.sleep(0.05)
    raise RuntimeError(f"경쟁 검증 세션이 기대 상태에 도달하지 않았습니다: {name}")


def queue_concurrency():
    prefix = "harness-" + uuid.uuid4().hex
    payload = json.dumps({"profileId": str(uuid.uuid4()), "sourceRevision": "1",
                          "modelVersion": "test", "promptVersion": "test"})
    def enqueue(suffix):
        return f"select public.enqueue_job('review_summary','{prefix}-{suffix}','{payload}',clock_timestamp());"
    try:
        with ThreadPoolExecutor(max_workers=2) as pool, SessionLock(73109001) as barrier:
            a = pool.submit(sql, "begin; set application_name='ym_enqueue_a'; set local role service_role;" + enqueue("same") + f"select pg_advisory_xact_lock({barrier.key}); commit;")
            wait_event("ym_enqueue_a", event_type="Lock")
            b = pool.submit(sql, "begin; set application_name='ym_enqueue_b'; set local role service_role;" + enqueue("same") + "commit;")
            wait_event("ym_enqueue_b", event_type="Lock")
            barrier.release()
            first, second = objects(a.result())[0], objects(b.result())[0]
            require(first["jobId"] == second["jobId"] and not first["deduplicated"] and second["deduplicated"], "concurrent enqueue dedupe failed")
        sql(enqueue("second"))
        with ThreadPoolExecutor(max_workers=2) as pool, SessionLock(73109002) as barrier:
            a = pool.submit(sql, "begin; set application_name='ym_claim_a'; set local role service_role; select public.claim_job('10000000-0000-4000-8000-000000000001',60);" + f"select pg_advisory_xact_lock({barrier.key}); commit;")
            wait_event("ym_claim_a", event_type="Lock")
            second = objects(sql("set role service_role; select public.claim_job('10000000-0000-4000-8000-000000000002',60);"))[0]
            barrier.release()
            first = objects(a.result())[0]
            require(first["job"]["jobId"] != second["job"]["jobId"], "SKIP LOCKED returned the same job")
            require(first["job"]["leaseToken"] != second["job"]["leaseToken"], "lease token reused")
        return ["concurrent_enqueue_deduplicates", "concurrent_claim_skips_locked_job"]
    finally:
        sql(f"delete from private.worker_jobs where dedupe_key like '{prefix}-%';")


def summary_concurrency():
    target, author = str(uuid.uuid4()), str(uuid.uuid4())
    appointments, reviews = [], []
    fixture = f"begin; insert into auth.users(id) values ('{target}'),('{author}'); insert into public.profiles(id,real_name,birth_date) values ('{target}','검증대상','1990-01-01'),('{author}','검증작성자','1990-01-01');"
    for _ in range(3):
        post, request, appointment, review = [str(uuid.uuid4()) for _ in range(4)]
        appointments.append(appointment)
        reviews.append(review)
        fixture += f"""
        insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)
        values ('{post}','{author}','경쟁검증','가상 데이터','산책',now()-interval '11 days',now()-interval '10 days',now()-interval '12 days','서울특별시 강남구 역삼동');
        insert into public.join_requests(id,post_id,requester_id,message,status) values ('{request}','{post}','{target}','가상 신청 데이터입니다','matched');
        insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
        values ('{appointment}','{post}','{request}','completed',now()-interval '10 days','automatic',now()-interval '10 days',now()-interval '9 days',now()-interval '3 days');
        insert into public.appointment_reviews(id,appointment_id,reviewer_id,rating,comment) values ('{review}','{appointment}','{author}',5,'친절한 동행');
        select public.set_review_publication('{review}',true);
        """
    ids = "array[" + ",".join(f"'{r}'::uuid" for r in reviews) + "]"
    def snapshot():
        return objects(sql(f"set role service_role; select public.load_public_review_snapshot('{target}');"))[0]
    def publish(revision):
        return f"select public.publish_review_summary('{target}','{revision}',{ids},'가상 요약','test','test');"
    try:
        sql(fixture + "commit;")
        revision = snapshot()["sourceRevision"]
        with ThreadPoolExecutor(max_workers=2) as pool, SessionLock(73109003) as barrier:
            a = pool.submit(sql, "begin; set application_name='ym_publish_a'; set local role service_role;" + publish(revision) + f"select pg_advisory_xact_lock({barrier.key}); commit;")
            wait_event("ym_publish_a", event_type="Lock")
            b = pool.submit(sql, f"begin; set application_name='ym_private_b'; set local role service_role; select public.set_review_publication('{reviews[0]}',false); commit;")
            wait_event("ym_private_b", event_type="Lock")
            barrier.release()
            a.result()
            b.result()
        visible = objects(sql(f"set role authenticated; select set_config('request.jwt.claim.sub','{target}',false); select public.get_visible_review_summary('{target}');"))[0]
        require(visible == {"summary": None}, "privacy change left stale summary visible")
        sql(f"set role service_role; select public.set_review_publication('{reviews[0]}',true);")
        revision = snapshot()["sourceRevision"]
        with ThreadPoolExecutor(max_workers=2) as pool, SessionLock(73109004) as barrier:
            a = pool.submit(sql, f"begin; set application_name='ym_private_a'; set local role service_role; select public.set_review_publication('{reviews[0]}',false); select pg_advisory_xact_lock({barrier.key}); commit;")
            wait_event("ym_private_a", event_type="Lock")
            b = pool.submit(sql, "begin; set application_name='ym_publish_b'; set local role service_role;" + publish(revision) + "commit;", allow_error=True)
            wait_event("ym_publish_b", event_type="Lock")
            barrier.release()
            a.result()
            rejected = b.result()
            require(rejected.returncode and "40001" in rejected.stderr, "stale concurrent publish was not rejected")
        return ["publish_then_private_hides_summary", "private_then_publish_rejects_revision"]
    finally:
        # Only this run's random identities; never truncate participant data.
        appointment_ids = ",".join(f"'{value}'::uuid" for value in appointments)
        sql(f"begin; delete from public.appointments where id in ({appointment_ids}); delete from auth.users where id in ('{target}','{author}'); commit;")


def core_concurrency():
    """Two-post finalization conflicts and completion/manual-vs-automatic locks."""
    author, peer = str(uuid.uuid4()), str(uuid.uuid4())
    posts, requests, versions = [], [], []
    try:
        sql(f"begin; insert into auth.users(id) values('{author}'),('{peer}'); insert into public.profiles(id,real_name,birth_date,gender) values('{author}','경쟁작성자','1990-01-01','female'),('{peer}','경쟁신청자','1990-01-01','female'); commit;")
        for _ in range(2):
            post, request = str(uuid.uuid4()), str(uuid.uuid4())
            posts.append(post); requests.append(request)
            sql(f"""begin;
            insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,cost_type,amount)
            values('{post}','{author}','경쟁확정','가상 데이터','산책',now()+interval '3 days',now()+interval '3 days 2 hours',now()+interval '2 days','서울특별시 강남구 역삼동','free',0);
            insert into public.post_private_details(post_id,exact_location) values('{post}','가상 만남지점');
            insert into public.join_requests(id,post_id,requester_id,message) values('{request}','{post}','{peer}','동시 확정 검증을 신청합니다'); commit;""")
            versions.append(objects(sql(f"set role authenticated; select set_config('request.jwt.claim.sub','{author}',false); select public.propose_match('{request}');"))[0]['conditionVersion'])
        with ThreadPoolExecutor(max_workers=2) as pool, SessionLock(73109005) as barrier:
            a = pool.submit(sql, f"begin; set application_name='ym_match_a'; set local role authenticated; select set_config('request.jwt.claim.sub','{peer}',true); select public.accept_match('{requests[0]}','{versions[0]}'); select pg_advisory_xact_lock({barrier.key}); commit;")
            wait_event('ym_match_a', event_type='Lock')
            b = pool.submit(sql, f"begin; set application_name='ym_match_b'; set local role authenticated; select set_config('request.jwt.claim.sub','{peer}',true); select public.accept_match('{requests[1]}','{versions[1]}'); commit;", allow_error=True)
            wait_event('ym_match_b', event_type='Lock')
            barrier.release()
            accepted = objects(a.result())[0]
            refused = b.result()
            require(refused.returncode and '40001' in refused.stderr, 'two overlapping posts both finalized')
        appointment = accepted['appointmentId']
        sql(f"update public.posts set starts_at=now()-interval '3 days',ends_at=now()-interval '2 days',recruitment_ends_at=now()-interval '4 days' where id='{posts[0]}';")
        with ThreadPoolExecutor(max_workers=2) as pool, SessionLock(73109006) as barrier:
            a = pool.submit(sql, f"begin; set application_name='ym_complete_a'; set local role authenticated; select set_config('request.jwt.claim.sub','{author}',true); select row_to_json(x) from public.confirm_appointment_completion('{appointment}') x; select pg_advisory_xact_lock({barrier.key}); commit;")
            wait_event('ym_complete_a', event_type='Lock')
            b = pool.submit(sql, f"begin; set application_name='ym_complete_b'; set local role authenticated; select set_config('request.jwt.claim.sub','{peer}',true); select row_to_json(x) from public.confirm_appointment_completion('{appointment}') x; commit;")
            wait_event('ym_complete_b', event_type='Lock')
            automatic = objects(sql('set role service_role; select public.process_due_completions(100);'))[0]
            require(automatic['completedCount']==0, 'automatic completion did not skip the locked appointment')
            barrier.release()
            first, second = objects(a.result())[0], objects(b.result())[0]
            require(first['status']=='confirmed' and first['completed_at'] is None and second['status']=='completed', 'manual confirmations did not serialize')
        repeat = objects(sql(f"set role authenticated; select set_config('request.jwt.claim.sub','{author}',false); select row_to_json(x) from public.confirm_appointment_completion('{appointment}') x;"))[0]
        require(repeat['completed_at']==second['completed_at'], 'completion time changed on repeat')
        require(sql(f"select count(*) from public.notifications where join_request_id='{requests[0]}' and kind='appointment_completed';").stdout.strip()=='2', 'duplicate or missing completion notifications')
        return ['concurrent_match_blocks_overlapping_schedule', 'bilateral_manual_and_automatic_completion_serialize']
    finally:
        sql(f"begin; delete from public.posts where author_id='{author}'; delete from auth.users where id in ('{author}','{peer}'); commit;")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="비어 있는 전용 로컬 DB에만 테스트 실행")
    args = parser.parse_args()
    if not args.run:
        print(json.dumps({"status": "NOT_RUN", "tests": TESTS, "context": CONTEXT, "container": CONTAINER}))
        return 0
    try:
        endpoint = docker("context", "inspect", CONTEXT, "--format", "{{.Endpoints.docker.Host}}")
        inspection = docker("inspect", CONTAINER)
        if endpoint.returncode or inspection.returncode:
            raise ValueError("전용 로컬 Docker 환경을 먼저 시작하세요.")
        validate_target(endpoint.stdout.strip(), json.loads(inspection.stdout)[0])
        with SessionLock(73109000):
            if sql("select (select count(*) from auth.users)+(select count(*) from public.profiles)+(select count(*) from private.worker_jobs);").stdout.strip() != "0":
                raise ValueError("가상 검증은 users/profiles/jobs가 비어 있는 전용 DB에서만 실행합니다.")
            completed = []
            for name in TESTS:
                sql((ROOT / "tests/database/minkyu" / name).read_text())
                completed.append(name)
                print(json.dumps({"status": "PASS", "test": name}), flush=True)
            completed += queue_concurrency()
            completed += summary_concurrency()
            completed += core_concurrency()
            require(sql("select (select count(*) from auth.users)+(select count(*) from public.profiles)+(select count(*) from private.worker_jobs)+(select count(*) from private.review_summaries);").stdout.strip() == "0", "fixture cleanup failed")
        print(json.dumps({"status": "PASS", "checks": completed, "fixtures_remaining": 0}))
        return 0
    except (OSError, ValueError, RuntimeError, AssertionError, subprocess.SubprocessError) as exc:
        print(json.dumps({"status": "FAIL", "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
