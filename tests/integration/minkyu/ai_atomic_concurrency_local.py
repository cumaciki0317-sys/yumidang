"""승인된 scratch DB 전용 두 실제 PostgreSQL 세션 검사. 외부 AI 호출·원문 없음."""
import argparse
import concurrent.futures
import json
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
    if args.database != 'yumidang_policy_20261005':
        raise SystemExit('허용된 격리 DB 이름이 아닙니다.')
    command = ['docker', '--host', args.docker_host, 'exec', '-i', args.container, 'psql',
               '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', args.database]

    def sql(statement):
        result = subprocess.run(command, input=statement, text=True, capture_output=True, timeout=30)
        if result.returncode:
            # SQL 오류에는 statement가 붙을 수 있으므로 원문·식별자 전체를 출력하지 않는다.
            raise RuntimeError('격리 DB 명령 실패')
        return result.stdout.strip()

    def rpc(statement):
        return json.loads(sql('set role service_role; select ' + statement + ';'))

    def pair(statements):
        barrier = threading.Barrier(2)
        def call(statement):
            barrier.wait(timeout=5)
            return rpc(statement)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            return list(executor.map(call, statements))

    assert sql('select current_database();') == args.database
    users = [str(uuid.uuid4()) for _ in range(5)]
    requests = []
    ledgers = ['synthetic-concurrency-' + uuid.uuid4().hex[:12] for _ in range(2)]
    original_guard = sql('select external_processing_allowed from private.ai_processing_guard where singleton;')
    assert original_guard in ('t', 'f')

    def acquire(user, client):
        request = str(uuid.uuid4())
        requests.append(request)
        return request, rpc(f"public.acquire_ai_chat_request('{user}','{request}','{client}',null,'2026-10-05')")

    def reserve(user, request, token, ledger):
        return f"public.reserve_ai_chat_model('{ledger}','fixture','intent',1,'{user}','{request}','{token}','2026-10-05')"

    try:
        sql('begin; ' + ''.join(
            f"insert into auth.users(id) values('{user}');"
            f"insert into public.profiles(id,real_name,birth_date,gender) values('{user}','합성동시검사','1990-01-01','female');"
            f"insert into private.ai_member_processing(user_id,exploration_allowed,summary_allowed) values('{user}',true,true);"
            for user in users) +
            'update private.ai_processing_guard set external_processing_allowed=true where singleton; commit;')
        for ledger, units in zip(ledgers, [100, 1]):
            rpc(f"public.configure_ai_budget_ledger('{ledger}',{units},100)")
        sql(f"insert into private.ai_member_daily_usage values('{users[0]}',(clock_timestamp() at time zone 'Asia/Seoul')::date,19);")
        first_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        requests.extend(first_ids)
        responses = pair([f"public.acquire_ai_chat_request('{users[0]}','{request}','race-{index}',null,'2026-10-05')"
                          for index, request in enumerate(first_ids)])
        assert sorted(response['status'] for response in responses) == ['acquired', 'concurrent']
        winner = next(i for i, response in enumerate(responses) if response['status'] == 'acquired')
        winner_id, token = first_ids[winner], responses[winner]['leaseToken']
        responses = pair([reserve(users[0], winner_id, token, ledgers[0])] * 2)
        assert all(response.get('reservationId') for response in responses)
        assert sql(f"select started_requests from private.ai_member_daily_usage where user_id='{users[0]}' and kst_day=(clock_timestamp() at time zone 'Asia/Seoul')::date;") == '20'
        assert sql(f"select counted_day=(started_at at time zone 'Asia/Seoul')::date from private.ai_chat_requests where request_id='{winner_id}';") == 't'
        rpc(f"public.finish_ai_chat_request('{users[0]}','{winner_id}','{token}','finished')")
        assert acquire(users[0], 'after-twentieth')[1]['status'] == 'daily_limit'
        print('PASS: 두 세션 단일 점유·동일 요청 개인 1회·20회 상한·DB KST receipt')

        scopes = [acquire(user, 'one-global-unit')[0:2] for user in users[1:3]]
        assert all(response['status'] == 'acquired' for _, response in scopes)
        responses = pair([reserve(user, request, scope['leaseToken'], ledgers[1])
                          for user, (request, scope) in zip(users[1:3], scopes)])
        assert sum(response.get('reservationId') is not None for response in responses) == 1
        assert sql(f"select coalesce(sum(started_requests),0) from private.ai_member_daily_usage where user_id in('{users[1]}','{users[2]}');") == '1'
        assert sql(f"select reserved_units=1 and open_calls=1 from private.ai_budget_ledgers where ledger_id='{ledgers[1]}';") == 't'
        print('PASS: 두 회원 한 단위 전역 예산 경쟁·거절한 회원 차감 없음')

        request, scope = acquire(users[3], 'expiry-during-budget-lock')
        before = sql(f"select reserved_units||':'||open_calls from private.ai_budget_ledgers where ledger_id='{ledgers[0]}';")
        blocker_name = 'synthetic-ai-budget-' + uuid.uuid4().hex[:12]
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            blocker = executor.submit(sql, f"set application_name='{blocker_name}'; begin; select 1 from private.ai_budget_ledgers where ledger_id='{ledgers[0]}' for update; select pg_sleep(2); commit;")
            deadline = time.monotonic() + 5
            while sql(f"select exists(select 1 from pg_stat_activity where datname=current_database() and application_name='{blocker_name}' and wait_event='PgSleep');") != 't':
                assert time.monotonic() < deadline, '원장 잠금 세션 시작을 확인하지 못했습니다.'
                time.sleep(0.02)
            sql(f"update private.ai_chat_requests set expires_at=clock_timestamp()+interval '500 milliseconds' where request_id='{request}';")
            response = rpc(reserve(users[3], request, scope['leaseToken'], ledgers[0]))
            assert response == {'status': 'lease_lost'}
            blocker.result(timeout=10)
        assert sql(f"select reserved_units||':'||open_calls from private.ai_budget_ledgers where ledger_id='{ledgers[0]}';") == before
        assert sql(f"select coalesce(sum(started_requests),0) from private.ai_member_daily_usage where user_id='{users[3]}';") == '0'
        print('PASS: 원장 잠금 대기 중 점유 만료·예약과 개인 차감 원자 롤백')

        request, scope = acquire(users[4], 'withdrawal-races-model-start')
        before = sql(f"select reserved_units||':'||open_calls from private.ai_budget_ledgers where ledger_id='{ledgers[0]}';")
        blocker_name = 'synthetic-ai-withdraw-' + uuid.uuid4().hex[:12]
        claims = json.dumps({'role': 'authenticated', 'sub': users[4]}, separators=(',', ':'))
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            withdrawal = executor.submit(sql, f"set application_name='{blocker_name}'; set role authenticated; select set_config('request.jwt.claim.sub','{users[4]}',false); select set_config('request.jwt.claims','{claims}',false); begin; select public.withdraw_my_ai_processing('exploration'); select pg_sleep(2); commit;")
            deadline = time.monotonic() + 5
            while sql(f"select exists(select 1 from pg_stat_activity where datname=current_database() and application_name='{blocker_name}' and wait_event='PgSleep');") != 't':
                assert time.monotonic() < deadline, '철회 접수 세션 시작을 확인하지 못했습니다.'
                time.sleep(0.02)
            response = rpc(reserve(users[4], request, scope['leaseToken'], ledgers[0]))
            assert response == {'status': 'consent_revoked'}
            withdrawal.result(timeout=10)
        assert sql(f"select reserved_units||':'||open_calls from private.ai_budget_ledgers where ledger_id='{ledgers[0]}';") == before
        assert sql(f"select coalesce(sum(started_requests),0) from private.ai_member_daily_usage where user_id='{users[4]}';") == '0'
        assert sql(f"select exists(select 1 from public.profiles where id='{users[4]}');") == 't'
        print('PASS: 철회 접수와 모델 시작 두 세션 경쟁·철회 뒤 예약/차감 차단·계정 유지')


    finally:
        # 성공·실패 모두 본 검사의 무작위 자료와 합성 승인 상태만 정리한다.
        quoted_users = ','.join("'" + user + "'" for user in users)
        quoted_ledgers = ','.join("'" + ledger + "'" for ledger in ledgers)
        sql('begin; '
            f"update private.ai_processing_guard set external_processing_allowed={'true' if original_guard == 't' else 'false'} where singleton;"
            f"delete from private.ai_chat_requests where user_id in({quoted_users});"
            f"delete from private.ai_member_daily_usage where user_id in({quoted_users});"
            f"delete from private.ai_member_processing where user_id in({quoted_users});"
            f"delete from private.ai_budget_ledgers where ledger_id in({quoted_ledgers});"
            f"delete from public.profiles where id in({quoted_users});"
            f"delete from auth.users where id in({quoted_users}); commit;")
        assert sql(f"select count(*) from private.ai_chat_requests where user_id in({quoted_users});") == '0'
        assert sql(f"select external_processing_allowed from private.ai_processing_guard where singleton;") == original_guard
        print('PASS: 합성 자료 삭제·외부 처리 가드 원상 복구')


if __name__ == '__main__':
    main()
