#!/usr/bin/env python3
"""전용 로컬 DB에서 rollback SQL + 독립 세션 경쟁 검증. 원격 URL 입력 없음."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import hashlib
import os
import re
import tempfile
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
CURRENT_AI_FILES = ("ai_atomic_requests.sql", "ai_account_budget.sql", "ai_account_scopes.sql", "current_summary_fences.sql")


def isolated_command_error(stderr):
    """원 응답 대신 제한된 SQLSTATE와 stdin 실행 행만 남긴다."""
    state = re.search(r"ERROR:\s+([0-9A-Z]{5})\b", stderr)
    line = re.search(r"psql:<stdin>:([1-9][0-9]{0,5}):\s+ERROR:", stderr)
    error = RuntimeError("SQLSTATE_" + state[1] if state else "ISOLATED_COMMAND_FAILED")
    error.execution_line = int(line[1]) if line else None
    return error


def isolated_prepared_target(prepared_root):
    """현재 소스의 좁은 overlay·SQL 바이트만 검사한다. Docker/SQL 호출은 없다."""
    from prepare_database import isolated_config
    from prepare_migrations import inspect_migrations
    original = Path(prepared_root)
    root = original.resolve()
    if (root != original.absolute() or root == Path(tempfile.gettempdir()).resolve()
            or not root.is_relative_to(Path(tempfile.gettempdir()).resolve())
            or root.is_relative_to(ROOT) or root.is_symlink()
            or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o777 != 0o700):
        raise ValueError("ISOLATED_ROOT_INVALID")
    def read(relative):
        path = root / relative
        if (path.is_symlink() or not path.is_file() or path.resolve() != path
                or path.stat().st_nlink != 1 or path.stat().st_size > 4 * 1024 * 1024):
            raise ValueError("ISOLATED_INPUT_INVALID")
        return path.read_bytes()
    manifest = json.loads(read("database-manifest.json"))
    intent = json.loads(read("execution-intent.json"))
    config = read("supabase/config.toml")
    overlay = manifest["config_overlay"]
    source = (ROOT / "backend/supabase/config.toml").read_bytes()
    expected, expected_overlay = isolated_config(source, overlay["project_id"], overlay["api.port"])
    if (config != expected or overlay != expected_overlay
            or manifest["config_sha256"] != hashlib.sha256(config).hexdigest()
            or manifest["source_config_sha256"] != hashlib.sha256(source).hexdigest()
            or manifest["sql_execution"] != "NOT_RUN"):
        raise ValueError("ISOLATED_CONFIG_CHANGED")
    history = inspect_migrations(ROOT)
    if manifest["migrations"] != history["migrations"]:
        raise ValueError("ISOLATED_MIGRATION_CHANGED")
    selected = {Path(x["path"]).name for x in history["migrations"]}
    if {p.name for p in (root / "supabase/migrations").iterdir()} != selected:
        raise ValueError("ISOLATED_MIGRATION_SET_CHANGED")
    for entry in history["migrations"]:
        if hashlib.sha256(read("supabase/migrations/" + Path(entry["path"]).name)).hexdigest() != entry["sha256"]:
            raise ValueError("ISOLATED_MIGRATION_CHANGED")
    project = overlay["project_id"]
    host = "unix://" + str(Path.home() / ".colima/jonghyun-backend100/docker.sock")
    if (intent["context"] != "colima-jonghyun-backend100" or intent["dockerHost"] != host
            or intent["project"] != project or intent["scope"] != "new-synthetic-only"
            or intent["existingContainers"] != [] or intent["existingNetworks"] != []):
        raise ValueError("ISOLATED_INTENT_INVALID")
    owned = json.loads(read("owned-containers.json"))
    matching = [x for x in owned if x["name"] == "supabase_db_" + project]
    if (len(matching) != 1 or not re.fullmatch(r"[a-f0-9]{64}", matching[0]["id"])
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", matching[0]["image"])):
        raise ValueError("ISOLATED_DB_ID_INVALID")
    return {"context": intent["context"], "host": host, "project": project,
            "container": matching[0]["name"], "id": matching[0]["id"], "image": matching[0]["image"],
            "versions": [x["version"] for x in history["migrations"]]}


def current_ai_cases(payloads):
    """계정 scope가 참조하는 helper만 재사용하고 각 fixture는 독립 rollback한다."""
    helper = re.findall(r"create function pg_temp\.pool_failure\(.*?\$\$;", payloads["ai_account_budget.sql"], re.S)
    if len(helper) != 1:
        raise ValueError("BUDGET_HELPER_CHANGED")
    return [
        ("ai_atomic_requests", payloads["ai_atomic_requests.sql"]),
        ("ai_account_budget", "begin;\n" + payloads["ai_account_budget.sql"] + "\nrollback;"),
        ("ai_account_scopes", "begin;\n" + helper[0] + "\n" + payloads["ai_account_scopes.sql"] + "\nrollback;"),
        ("current_summary_fences", payloads["current_summary_fences.sql"]),
    ]


def run_current_ai(prepared_root):
    """새 전용 환경에서 현재 AI 계약만 검사한다. legacy 경쟁/외부 호출 없음."""
    stage, completed, target = "prepared_guard", [], None
    try:
        target = isolated_prepared_target(prepared_root)
        # 이름의 재해석 대신 검토한 socket을 모든 실제 Docker 호출에 고정한다.
        base = ["docker", "--host", target["host"]]
        def call(args, *, data=None):
            result = subprocess.run(base + args, input=data, text=True, capture_output=True, timeout=30)
            if result.returncode:
                raise isolated_command_error(result.stderr)
            return result.stdout.strip()
        def verify_identity():
            if call(["context", "inspect", target["context"], "--format", "{{.Endpoints.docker.Host}}"] ) != target["host"]:
                raise ValueError("ISOLATED_SOCKET_CHANGED")
            inspected = json.loads(call(["inspect", target["container"]]))
            if len(inspected) != 1:
                raise ValueError("ISOLATED_ID_CHANGED")
            item = inspected[0]
            if (item["Id"] != target["id"] or item["Image"] != target["image"]
                    or item["Name"] != "/" + target["container"] or not item["State"]["Running"]
                    or item["Config"]["Labels"].get("com.supabase.cli.project") != target["project"]):
                raise ValueError("ISOLATED_ID_CHANGED")
        def query(statement):
            verify_identity()
            return call(["exec", "-i", target["id"], "psql", "-XqAt", "-U", "postgres", "-d", "postgres",
                         "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate", "-f", "-"],
                        data="set application_name='ym_current_ai_sql';set statement_timeout='15s';"
                             "set lock_timeout='10s';set plpgsql.check_asserts=on;\n" + statement)
        stage = "target_guard"
        verify_identity()
        actual_versions = json.loads(query("select json_agg(version order by version) from supabase_migrations.schema_migrations;"))
        if actual_versions != target["versions"]:
            raise ValueError("ISOLATED_APPLIED_HISTORY_CHANGED")
        def closed_empty():
            result = query("select (select count(*) from auth.users)+(select count(*) from public.profiles)"
                           "+(select count(*) from private.worker_jobs)+(select count(*) from private.ai_chat_requests)"
                           "+(select count(*) from private.ai_budget_reservations);"
                           "select current_setting('cron.launch_active_jobs');"
                           "select external_processing_allowed from private.ai_processing_guard where singleton;"
                           "select count(*) from pg_stat_activity where application_name='ym_current_ai_sql'"
                           " and pid<>pg_backend_pid();")
            if result.splitlines() != ["0", "off", "f", "0"]:
                raise ValueError("ISOLATED_NOT_EMPTY_OR_OPEN")
        closed_empty()
        def row_fingerprint():
            # 행 원문을 DB 밖으로 반환하지 않고 모든 제품/AI/Storage 행의 digest만 비교한다.
            return query("begin;create temp table isolated_row_fingerprints(name text,digest text);"
                         "do $$declare t record;h text;begin for t in select schemaname,tablename from pg_tables"
                         " where schemaname in ('public','private','storage') order by schemaname,tablename loop"
                         " execute format('select md5(coalesce(string_agg(v,%L order by v),%L)) from"
                         " (select to_jsonb(x)::text v from %I.%I x)s',E'\\n','',t.schemaname,t.tablename) into h;"
                         " insert into isolated_row_fingerprints values(t.schemaname||'.'||t.tablename,h);"
                         " end loop;end $$;select md5(string_agg(name||':'||digest,E'\\n' order by name))"
                         " from isolated_row_fingerprints;rollback;")
        baseline = row_fingerprint()
        payloads = {}
        for name in CURRENT_AI_FILES:
            path = "tests/database/minkyu/" + name
            data = (ROOT / path).read_bytes()
            committed = subprocess.run(["git", "-C", str(ROOT), "show", "HEAD:" + path], capture_output=True, timeout=15)
            if committed.returncode or data != committed.stdout:
                raise ValueError("SQL_TEST_CHANGED")
            payloads[name] = data.decode("utf-8")
        for name, statement in current_ai_cases(payloads):
            stage = name
            # 같은 검사의 fixture 트랜잭션을 직렬화한다. 고정값 이외 입력을 SQL에 넣지 않는다.
            query(statement.replace("begin;", "begin;\nselect pg_advisory_xact_lock(73109100);", 1))
            closed_empty()
            if row_fingerprint() != baseline:
                raise ValueError("ISOLATED_ROWS_CHANGED_AFTER_ROLLBACK")
            completed.append(name)
            print(json.dumps({"status": "PASS", "test": name}), flush=True)
        stage = "final_guard"
        isolated_prepared_target(prepared_root)
        verify_identity()
        closed_empty()
        print(json.dumps({"status": "PASS", "checks": completed, "fixtureCoreRows": 0,
                          "externalGuard": "CLOSED", "cron": "OFF", "migrationCount": len(target["versions"]),
                          "rowDigestScope": ["public", "private", "storage"], "sequenceOrFullRestore": "NOT_VERIFIED",
                          "scope": "isolated_current_ai_sql_only", "fullAi22Or23": "NOT_RUN", "summary14": "NOT_RUN"}))
        return 0
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, AssertionError, subprocess.SubprocessError) as exc:
        # 동적 SQL/원응답/예외 원문은 출력하지 않는다. 연결 종료가 열린 TX를 rollback한다.
        closure = "NOT_VERIFIED"
        if "baseline" in locals():
            try:
                closed_empty()
                closure = "ROWS_GUARDS_AND_SESSIONS_VERIFIED" if row_fingerprint() == baseline else "ROWS_CHANGED"
            except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError):
                pass
        print(json.dumps({"status": "FAIL", "stage": stage, "completed": completed,
                          "error": "ISOLATED_CURRENT_AI_CHECK_FAILED",
                          "failureClosure": closure,
                          "executionLine": getattr(exc, "execution_line", None),
                          "sqlState": str(exc).removeprefix("SQLSTATE_")
                          if re.fullmatch(r"SQLSTATE_[0-9A-Z]{5}", str(exc)) else None}))
        return 1


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
    parser.add_argument("--prepared-root", type=Path, help="새 종현 합성 환경의 검증된 임시 루트")
    parser.add_argument("--current-ai", action="store_true", help="현재 AI/예산/요약 SQL만 독립 rollback 검사")
    args = parser.parse_args()
    if args.prepared_root is not None or args.current_ai:
        if args.prepared_root is None or not args.current_ai:
            print(json.dumps({"status": "BLOCKED", "error": "EXPLICIT_ISOLATED_MODE_REQUIRED"}))
            return 1
        if not args.run:
            print(json.dumps({"status": "NOT_RUN", "tests": CURRENT_AI_FILES, "context": "colima-jonghyun-backend100"}))
            return 0
        return run_current_ai(args.prepared_root)
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
