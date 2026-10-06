"""장소 초안의 실제 두 세션 검사. 별도 장소 DB만 허용하고 합성 자료를 정리한다."""
import argparse
import concurrent.futures
import json
from pathlib import Path
import subprocess
import threading
import time
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--docker-host', required=True)
    parser.add_argument('--container', required=True)
    parser.add_argument('--database', required=True)
    args = parser.parse_args()
    if args.database != 'yumidang_place_20261005':
        raise SystemExit('별도 장소 검증 DB만 허용합니다.')
    command = ['docker', '--host', args.docker_host, 'exec', '-i', args.container, 'psql',
               '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', args.database]

    def sql(statement):
        result = subprocess.run(command, input=statement, text=True, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('장소 검증 DB 명령 실패')
        return result.stdout.strip()

    assert sql('select current_database();') == args.database
    prefixes = [uuid.uuid4().hex[:8] for _ in range(3)]
    subject = 'place-race-' + uuid.uuid4().hex[:12] + '-'
    users = [f'{prefixes[0]}-0000-4000-8000-{i:012d}' for i in range(1, 6)]
    sessions = [f'{prefixes[1]}-0000-4000-8000-{i:012d}' for i in range(1, 6)]
    fixture = Path(__file__).parents[2] / 'database/minkyu/appointment_place_change_draft.sql'
    setup = fixture.read_text().split("set local request.jwt.claims='{\"role\":\"anon\"}';")[0]
    for old, new in zip(['c1000000', 'c2000000', 'c3000000'], prefixes):
        setup = setup.replace(old, new)
    setup = setup.replace('place-sql-', subject)
    bucket = sql("select exists(select 1 from storage.buckets where id='profile-images');")

    def actor(n):
        claims = json.dumps({'role': 'authenticated', 'sub': users[n-1], 'session_id': sessions[n-1]}, separators=(',', ':'))
        return f"set local role authenticated;set local request.jwt.claim.sub='{users[n-1]}';set local request.jwt.claims='{claims}';"

    def action(case, verb):
        return f"public.{verb}_appointment_schedule_change('{case['ap']}','{case['change_id']}','{case['version']}')"

    def compete(case, verb):
        return json.loads(sql('begin;' + actor(1 if case['n'] == 2 else 2) + 'create temp table response(data jsonb);do $$ begin insert into response values(' +
                              action(case, verb) + ");exception when sqlstate '40001' then insert into response values('{\"conflict\":true}');end $$;select data from response;commit;"))

    def wait_sleep(name):
        deadline = time.monotonic() + 5
        while sql(f"select exists(select 1 from pg_stat_activity where datname=current_database() and application_name='{name}' and wait_event='PgSleep');") != 't':
            assert time.monotonic() < deadline, '잠금 보유 세션을 확인하지 못했습니다.'
            time.sleep(0.02)

    try:
        output = sql(setup + 'reset role;select jsonb_agg(to_jsonb(c) order by n) from place_cases c;commit;')
        cases = json.loads(output.splitlines()[-1])
        for case, operation in [(cases[0], 'accept'), (cases[1], 'cancel'), (cases[2], 'trusted_location')]:
            name = 'synthetic-place-lock-' + uuid.uuid4().hex[:10]
            if operation == 'accept':
                mutation = actor(2) + 'select ' + action(case, 'accept') + ';'
            elif operation == 'cancel':
                mutation = actor(2) + f"select public.cancel_appointment('{case['ap']}','{uuid.uuid4()}','합성 취소');"
            else:
                mutation = f"set local role service_role;select public.set_post_search_location('{case['p']}','합성 trusted 장소','합성 trusted 등록주소');"
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                holder = executor.submit(sql, f"set application_name='{name}';begin;" + mutation + 'select pg_sleep(2);commit;')
                wait_sleep(name)
                if operation == 'accept':
                    # uncommitted 수락의 새 장소는 다른 세션의 공개 검색에 보이지 않는다.
                    probe = sql("begin;set local role anon;set local request.jwt.claim.sub='';set local request.jwt.claims='{\"role\":\"anon\"}';" +
                                "select jsonb_array_length(public.search_public_posts_v2('2026-10-05',null,'{\"query\":\"새등록주소1\"}',null,10)->'items');commit;")
                    assert probe == '0'
                result = compete(case, 'decline' if operation == 'accept' else 'accept')
                assert result == {'conflict': True}
                holder.result(timeout=10)
            status = sql(f"select status from private.appointment_schedule_changes where change_id='{case['change_id']}';")
            assert status == {'accept': 'accepted', 'cancel': 'cancelled', 'trusted_location': 'awaiting_response'}[operation]
            if operation == 'trusted_location':
                assert sql(f"select updated_at='{case['updated']}'::timestamptz and starts_at='{case['starts']}'::timestamptz from public.posts where id='{case['p']}';") == 't'
            else:
                assert sql(f"select count(*) from private.match_lifecycle_events where event_key='{case['version']}' and kind='appointment_schedule_change_ended';") == '1'
            print('PASS: 두 세션 ' + operation + ' 접수·잠금 대기 후 상태/위치 충돌·원자성')

        case = cases[5]  # 기본5인수 일정 전용도 같은 수락 잠금과 멱등 계약을 사용한다.
        barrier = threading.Barrier(2)
        def accept(_):
            barrier.wait(timeout=5)
            return compete(case, 'accept')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(accept, range(2)))
        assert all(result['status'] == 'accepted' for result in results)
        assert sorted(result['deduplicated'] for result in results) == [False, True]
        assert sql(f"select count(*) from private.match_lifecycle_events where event_key='{case['version']}' and kind='appointment_schedule_change_ended';") == '1'
        print('PASS: 기존5인수 두 동시 수락·단일 반영/종료 이벤트')
    finally:
        quoted = ','.join("'" + user + "'" for user in users)
        sql("begin;set local storage.allow_delete_query='true';" +
            f"delete from public.posts where author_id in({quoted});delete from public.profiles where id in({quoted});" +
            f"delete from private.naver_accounts where subject like '{subject}%';delete from auth.users where id in({quoted});" +
            f"delete from storage.objects where owner_id in({quoted});" +
            ("delete from storage.buckets where id='profile-images';" if bucket == 'f' else '') + 'commit;')
        assert sql(f"select count(*) from public.profiles where id in({quoted});") == '0'
        print('PASS: 합성 두 세션 자료 삭제')


if __name__ == '__main__':
    main()
