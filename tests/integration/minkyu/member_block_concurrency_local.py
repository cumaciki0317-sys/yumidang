"""민규: 로컬 scratch에서 차단/메시지의 양방향 선형화와 합성 자료 정리를 검사한다."""
import argparse
import json
from pathlib import Path
import subprocess
import threading
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--docker-host", required=True)
    parser.add_argument("--container", required=True)
    parser.add_argument("--database", required=True)
    args = parser.parse_args()
    if not args.docker_host.startswith("unix:///") or not args.database.startswith("yumidang_policy_"):
        parser.error("local Unix Docker socket and isolated yumidang_policy_ database required")
    command = ["docker", "--host", args.docker_host, "exec", "-i", args.container,
               "psql", "-U", "supabase_admin", "-d", args.database, "-v", "ON_ERROR_STOP=1",
               "-v", "VERBOSITY=sqlstate", "-qAt"]

    namespace = uuid.uuid4().hex[:6]

    def isolated(statement):
        for kind in range(1, 6):
            statement = statement.replace(f"b{kind}000000", namespace + f"0{kind}")
        return statement.replace("memberblocks-concurrency-", f"memberblocks-concurrency-{namespace}-")

    def run(statement, expected_error=None):
        process = subprocess.run(command, input=isolated(statement), text=True, capture_output=True, timeout=30)
        if expected_error:
            assert process.returncode and expected_error in process.stderr, "expected SQLSTATE missing"
        elif process.returncode:
            raise RuntimeError("synthetic local SQL failed: " + process.stderr)
        return process.stdout.strip()

    def actor(number):
        user = "b1000000-0000-4000-8000-" + str(number).zfill(12)
        session = "b2000000-0000-4000-8000-" + str(number).zfill(12)
        claims = json.dumps({"role": "authenticated", "sub": user, "session_id": session}, separators=(",", ":"))
        return ("set local role authenticated; "
                f"select set_config('request.jwt.claim.sub','{user}',true); "
                f"select set_config('request.jwt.claims','{claims}',true); ")

    def holding_process(statement, marker):
        # Readiness comes from a live SQL query after the RPC acquired its transaction pair lock.
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, bufsize=1)
        process.stdin.write(isolated(statement))
        process.stdin.close()
        ready = threading.Event()

        def read_until_ready():
            for line in process.stdout:
                if line.strip() == marker:
                    ready.set()

        reader = threading.Thread(target=read_until_ready, daemon=True)
        reader.start()
        if not ready.wait(10):
            process.terminate()
            process.wait(timeout=5)
            raise RuntimeError("pair lock readiness was not observed")
        return process, reader

    post_id = "b4000000-0000-4000-8000-000000000001"
    target = "b1000000-0000-4000-8000-000000000002"
    assert run("select count(*) from auth.users where id::text like 'b1000000-%';") == "0"
    assert run("select count(*) from private.naver_accounts where subject like 'memberblocks-concurrency-%';") == "0"
    bucket_existed = run("select exists(select 1 from storage.buckets where id='profile-images');") == "t"
    root = Path(__file__).resolve().parents[3]
    fixture = (root / "tests/database/minkyu/current_member_blocks.sql").read_text().split("\n-- 최신 계약", 1)[0]
    assert "\nbegin;" in fixture and "rollback;" not in fixture.lower()
    fixture = (fixture.replace("memberblocks-sql-", "memberblocks-concurrency-")
               .replace("a1000000", "b1000000").replace("a2000000", "b2000000")
               .replace("a3000000", "b3000000"))
    fixture += ("set local role authenticated; select pg_temp.block_actor(1); "
                f"select public.create_service_post('{post_id}',pg_temp.block_input(1)); "
                "select pg_temp.block_actor(2); "
                f"select public.request_service_post('{post_id}','b5000000-0000-4000-8000-000000000001','합성 초기 메시지'); "
                "reset role; commit;")
    try:
        output = run(fixture)
        request_id = next(json.loads(line)["id"] for line in output.splitlines()
                          if line.startswith("{") and "alreadySent" in line)
        block, reader = holding_process(
            "begin; " + actor(1) + f"select public.block_member('{target}'); "
            "select 'PAIR_HELD_BLOCK'; select pg_sleep(1); commit;", "PAIR_HELD_BLOCK")
        run("begin; " + actor(2) + f"select public.send_conversation_message('{request_id}',"
            "'b5000000-0000-4000-8000-000000000002','차단 뒤 금지 메시지'); commit;", "42501")
        assert block.wait(timeout=10) == 0, block.stderr.read()
        reader.join(timeout=2)
        assert run(f"select count(*) from public.chat_messages where join_request_id='{request_id}';") == "1"
        print("PASS: committed block wins; waiting message rejected; original message preserved")

        run("begin; " + actor(1) + f"select public.unblock_member('{target}'); commit;")
        sender, reader = holding_process(
            "begin; " + actor(2) + f"select public.send_conversation_message('{request_id}',"
            "'b5000000-0000-4000-8000-000000000003','차단 전 성공 메시지'); "
            "select 'PAIR_HELD_MESSAGE'; select pg_sleep(1); commit;", "PAIR_HELD_MESSAGE")
        run("begin; " + actor(1) + f"select public.block_member('{target}'); commit;")
        assert sender.wait(timeout=10) == 0, sender.stderr.read()
        reader.join(timeout=2)
        assert run(f"select count(*) from public.chat_messages where join_request_id='{request_id}';") == "2"
        run("begin; " + actor(1) + f"select public.send_conversation_message('{request_id}',"
            "'b5000000-0000-4000-8000-000000000004','양방향 금지 메시지'); commit;", "42501")
        print("PASS: message commits before waiting block; later messages forbidden in both directions")
    finally:
        cleanup = ("begin; set local storage.allow_delete_query='true'; "
                   "delete from private.naver_accounts where subject like 'memberblocks-concurrency-%'; "
                   "delete from auth.users where id::text like 'b1000000-%'; "
                   "delete from storage.objects where owner_id like 'b1000000-%'; ")
        if not bucket_existed:
            cleanup += ("delete from storage.buckets where id='profile-images' "
                        "and not exists(select 1 from storage.objects where bucket_id='profile-images'); ")
        run(cleanup + "commit;")
        leftovers = json.loads(run(
            "select json_build_object('users',(select count(*) from auth.users where id::text like 'b1000000-%'),"
            "'sessions',(select count(*) from auth.sessions where id::text like 'b2000000-%'),"
            "'accounts',(select count(*) from private.naver_accounts where subject like 'memberblocks-concurrency-%'),"
            "'objects',(select count(*) from storage.objects where owner_id like 'b1000000-%'),"
            f"'posts',(select count(*) from public.posts where id='{post_id}'),"
            "'messages',(select count(*) from public.chat_messages where id::text like 'b5000000-%'),"
            "'blocks',(select count(*) from private.member_blocks where blocker_id::text like 'b1000000-%' or blocked_id::text like 'b1000000-%'))"))
        assert all(value == 0 for value in leftovers.values()), leftovers
        print("PASS: all synthetic users, sessions, accounts, objects, posts, messages and blocks removed")


if __name__ == "__main__":
    main()
