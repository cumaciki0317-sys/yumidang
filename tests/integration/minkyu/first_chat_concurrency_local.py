"""민규: 이미 마이그레이션된 로컬 scratch DB에서 두 첫 채팅의 실제 경쟁을 검증한다.

운영 DB에는 실행하지 않는다. 실제 Naver 합성 가입·Storage metadata 준비 후
두 독립 psql 연결을 사용하며 finally에서 지정한 합성 자료를 제거한다.
"""
import argparse
import concurrent.futures
import json
from pathlib import Path
import subprocess
import threading


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--docker-host", required=True)
    parser.add_argument("--container", required=True)
    parser.add_argument("--database", required=True)
    args = parser.parse_args()
    if not args.docker_host.startswith("unix:///"):
        parser.error("local Unix Docker socket required")
    if not args.database.startswith("yumidang_policy_"):
        parser.error("isolated yumidang_policy_ scratch database required")
    command = ["docker", "--host", args.docker_host, "exec", "-i", args.container,
               "psql", "-U", "supabase_admin", "-d", args.database,
               "-v", "ON_ERROR_STOP=1", "-qAt"]

    def sql(statement):
        process = subprocess.run(command, input=statement, text=True, capture_output=True, timeout=30)
        if process.returncode:
            # Fixture SQL has no real credentials or personal data. Avoid dumping statements/results.
            raise RuntimeError("local fixture SQL failed: " + process.stderr)
        return process.stdout.strip()

    post_id = "97000000-0000-4000-8000-000000000001"
    user_id = "94000000-0000-4000-8000-000000000002"
    session_id = "95000000-0000-4000-8000-000000000002"
    assert sql("select count(*) from auth.users where id::text like '94000000-%';") == "0", "fixture namespace occupied"
    assert sql("select count(*) from private.naver_accounts where subject like 'firstchat-concurrency-%';") == "0", "fixture namespace occupied"
    bucket_existed = sql("select exists(select 1 from storage.buckets where id='profile-images');") == "t"
    root = Path(__file__).resolve().parents[3]
    fixture = (root / "tests/database/minkyu/first_chat_application.sql").read_text()
    fixture = fixture.split("\ndo $$ begin\n  assert has_function_privilege", 1)[0]
    assert fixture.startswith("--") and "\nbegin;" in fixture and "rollback;" not in fixture.lower()
    fixture = (fixture.replace("firstchat-sql-", "firstchat-concurrency-")
               .replace("91000000", "94000000").replace("92000000", "95000000")
               .replace("93000000", "96000000"))
    fixture += ("set local role authenticated; select pg_temp.first_actor(1); "
                f"select public.create_service_post('{post_id}',pg_temp.first_input(3)); "
                "reset role; commit;")
    claims = json.dumps({"role": "authenticated", "sub": user_id, "session_id": session_id}, separators=(",", ":"))
    barrier = threading.Barrier(2)

    def worker(number):
        barrier.wait(timeout=10)
        message_id = "98000000-0000-4000-8000-" + str(number).zfill(12)
        result = sql("begin; set local role authenticated; "
                     f"select set_config('request.jwt.claim.sub','{user_id}',true); "
                     f"select set_config('request.jwt.claims','{claims}',true); "
                     f"select public.request_service_post('{post_id}','{message_id}','동시 채팅 {number}'); "
                     "select pg_sleep(0.2); commit;")
        return next(json.loads(line) for line in result.splitlines()
                    if line.startswith("{") and "alreadySent" in line)

    try:
        sql(fixture)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(worker, [1, 2]))
        assert len({result["id"] for result in results}) == 1, "two conversations created"
        counts = json.loads(sql(
            f"select json_build_object('requests',(select count(*) from public.join_requests where post_id='{post_id}'),"
            f"'messages',(select count(*) from public.chat_messages m join public.join_requests r on r.id=m.join_request_id where r.post_id='{post_id}'),"
            f"'receipts',(select count(*) from private.first_chat_applications f join public.join_requests r on r.id=f.request_id where r.post_id='{post_id}'))"))
        assert counts == {"requests": 1, "messages": 2, "receipts": 2}, counts
        print("PASS: two independent connections; one conversation; two messages; two receipts")
    finally:
        # Account FK restrict: remove only synthetic account bindings before deleting synthetic auth users.
        cleanup = ("begin; set local storage.allow_delete_query='true'; "
                   "delete from private.naver_accounts where subject like 'firstchat-concurrency-%'; "
                   "delete from auth.users where id::text like '94000000-%'; "
                   "delete from storage.objects where owner_id like '94000000-%'; ")
        if not bucket_existed:
            cleanup += ("delete from storage.buckets where id='profile-images' "
                        "and not exists(select 1 from storage.objects where bucket_id='profile-images'); ")
        sql(cleanup + "commit;")
        remaining = json.loads(sql(
            "select json_build_object('users',(select count(*) from auth.users where id::text like '94000000-%'),"
            "'sessions',(select count(*) from auth.sessions where id::text like '95000000-%'),"
            "'accounts',(select count(*) from private.naver_accounts where subject like 'firstchat-concurrency-%'),"
            "'objects',(select count(*) from storage.objects where owner_id like '94000000-%'),"
            f"'posts',(select count(*) from public.posts where id='{post_id}'),"
            "'messages',(select count(*) from public.chat_messages where id::text like '98000000-%'),"
            "'receipts',(select count(*) from private.first_chat_applications where message_id::text like '98000000-%'))"))
        assert all(count == 0 for count in remaining.values()), remaining
        print("PASS: synthetic users, sessions, accounts, objects, posts, messages, receipts all removed")


if __name__ == "__main__":
    main()
