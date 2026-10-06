"""모집 재개 두 PostgreSQL 세션 검사. 승인된 scratch DB와 합성 회원만 사용한다."""
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
    if args.database != 'yumidang_policy_20261005':
        raise SystemExit('허용된 격리 DB가 아닙니다.')
    command = ['docker', '--host', args.docker_host, 'exec', '-i', args.container, 'psql',
               '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', args.database]

    def sql(statement):
        result = subprocess.run(command, input=statement, text=True, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('격리 DB 명령 실패')
        return result.stdout.strip()

    assert sql('select current_database();') == args.database
    member_prefix, session_prefix, photo_prefix = [uuid.uuid4().hex[:8] for _ in range(3)]
    subject_prefix = 'reopen-race-' + uuid.uuid4().hex[:12] + '-'
    users = [f'{member_prefix}-0000-4000-8000-{i:012d}' for i in range(1, 6)]
    sessions = [f'{session_prefix}-0000-4000-8000-{i:012d}' for i in range(1, 6)]
    fixture = Path(__file__).parents[2] / 'database/minkyu/current_recruitment_reopen.sql'
    setup = fixture.read_text().split('create temp table reopen_case')[0]
    setup = (setup.replace('a1000000', member_prefix).replace('a2000000', session_prefix)
             .replace('a3000000', photo_prefix).replace('reopen-sql-', subject_prefix))
    original_bucket = sql("select exists(select 1 from storage.buckets where id='profile-images');")

    def actor(n):
        claims = json.dumps({'role': 'authenticated', 'sub': users[n-1], 'session_id': sessions[n-1]}, separators=(',', ':'))
        return f"set local role authenticated;set local request.jwt.claim.sub='{users[n-1]}';set local request.jwt.claims='{claims}';"

    def reopen(post):
        return json.loads(sql('begin;' + actor(1) + f"select public.reopen_service_post('{post}');commit;"))

    try:
        result = sql(setup + """
set local role authenticated;
do $$ declare n integer;p uuid;r2 uuid;r3 uuid;c jsonb;ap uuid;begin
 for n in 1..2 loop
  p:=gen_random_uuid();perform pg_temp.match_actor(1);perform public.create_service_post(p,pg_temp.match_input(n));
  perform pg_temp.match_actor(2);r2:=(public.request_service_post(p,gen_random_uuid(),'합성 확정 신청')->>'id')::uuid;
  perform pg_temp.match_actor(3);r3:=(public.request_service_post(p,gen_random_uuid(),'합성 복원 신청')->>'id')::uuid;
  perform pg_temp.match_actor(1);c:=public.propose_match(r2);
  perform pg_temp.match_actor(2);ap:=(public.accept_match(r2,c->>'conditionVersion')->>'appointmentId')::uuid;
  perform public.cancel_appointment(ap,gen_random_uuid(),'합성 취소 사유');
  insert into matching_cases(name,post_id,r1,r2) values('race-'||n,p,r2,r3);
 end loop;
end $$;
reset role;
select jsonb_agg(jsonb_build_object('post',post_id,'request',r2) order by name) from matching_cases;
commit;
""")
        cases = json.loads(result)
        barrier = threading.Barrier(2)
        def concurrent_reopen(_):
            barrier.wait(timeout=5)
            return reopen(cases[0]['post'])
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(concurrent_reopen, range(2)))
        assert sorted(response['alreadyReopened'] for response in responses) == [False, True]
        assert sorted(response['restoredCount'] for response in responses) == [0, 1]
        request = cases[0]['request']
        assert sql(f"select count(*) from private.match_lifecycle_events where request_id='{request}' and kind='recruitment_reopened';") == '1'
        assert sql(f"select count(*) from public.notifications where join_request_id='{request}' and kind='recruitment_reopened';") == '2'
        print('PASS: 두 동시 재개 단일 복원·단일 이벤트·당사자 알림')

        application = 'synthetic-reopen-block-' + uuid.uuid4().hex[:10]
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            blocker = executor.submit(sql, f"set application_name='{application}';begin;" + actor(1) +
                                      f"select public.block_member('{users[2]}');select pg_sleep(2);commit;")
            deadline = time.monotonic() + 5
            while sql(f"select exists(select 1 from pg_stat_activity where datname=current_database() and application_name='{application}' and wait_event='PgSleep');") != 't':
                assert time.monotonic() < deadline, '차단 접수 잠금을 확인하지 못했습니다.'
                time.sleep(0.02)
            response = reopen(cases[1]['post'])
            blocker.result(timeout=10)
        assert response['restoredCount'] == 0
        assert sql(f"select status from public.join_requests where id='{cases[1]['request']}';") == 'not_selected'
        assert sql(f"select count(*) from private.match_lifecycle_events where request_id='{cases[1]['request']}' and kind='recruitment_reopened';") == '0'
        print('PASS: 차단 접수와 재개 경쟁·pair 잠금 대기·차단된 신청 복원 제외')
    finally:
        quoted = ','.join("'" + user + "'" for user in users)
        sql("begin;set local storage.allow_delete_query='true';" +
            f"delete from public.posts where author_id in({quoted});delete from public.profiles where id in({quoted});" +
            f"delete from private.naver_accounts where subject like '{subject_prefix}%';delete from auth.users where id in({quoted});" +
            f"delete from storage.objects where owner_id in({quoted});" +
            ("delete from storage.buckets where id='profile-images';" if original_bucket == 'f' else '') + 'commit;')
        assert sql(f"select count(*) from public.profiles where id in({quoted});") == '0'
        print('PASS: 합성 동시 검사 자료 삭제')


if __name__ == '__main__':
    main()
