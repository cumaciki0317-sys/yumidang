"""민규: 합성 전용 lifecycle scratch의 실제 두 세션 탈퇴 경합 검사."""
import argparse
import json
import subprocess
import threading
import time
import uuid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--docker-host', required=True)
    ap.add_argument('--container', required=True)
    ap.add_argument('--database', required=True)
    args = ap.parse_args()
    if not args.docker_host.startswith('unix:///') or args.database != 'yumidang_lifecycle_20261005':
        ap.error('exact isolated lifecycle scratch required')
    cmd = ['docker', '--host', args.docker_host, 'exec', '-i', args.container, 'psql', '-U',
           'supabase_admin', '-d', args.database, '-v', 'ON_ERROR_STOP=1', '-qAt']

    def run(sql, expected=None):
        p = subprocess.run(cmd, input=sql, text=True, capture_output=True, timeout=20)
        if expected is not None:
            assert p.returncode and expected in p.stderr, p.stderr
        elif p.returncode:
            raise RuntimeError('synthetic scratch SQL failed: ' + p.stderr)
        return p.stdout.strip()

    def hold(sql):
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, bufsize=1)
        p.stdin.write('begin;set local statement_timeout=10000;' + sql +
                      "select 'LOCK_READY';select pg_sleep(1);commit;")
        p.stdin.close()
        ready = threading.Event()

        def reader():
            for line in p.stdout:
                if line.strip() == 'LOCK_READY':
                    ready.set()

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        if not ready.wait(10):
            p.terminate()
            raise RuntimeError('lock readiness missing: ' + p.stderr.read())
        return p, t

    def finish(pair):
        p, t = pair
        assert p.wait(timeout=15) == 0, p.stderr.read()
        t.join(timeout=2)

    fixture_users, fixture_posts, fixture_subjects = [], [], []

    def fixture():
        users = [str(uuid.uuid4()), str(uuid.uuid4())]
        sessions = [str(uuid.uuid4()), str(uuid.uuid4())]
        images = [str(uuid.uuid4()), str(uuid.uuid4())]
        post, request = str(uuid.uuid4()), str(uuid.uuid4())
        subjects = ['life-concurrency-' + str(uuid.uuid4()) for _ in users]
        fixture_users.extend(users)
        fixture_posts.append(post)
        fixture_subjects.extend(subjects)
        sql = "begin;insert into storage.buckets(id,name,public) values('profile-images','profile-images',false) on conflict do nothing;"
        for u, se, image, subject in zip(users, sessions, images, subjects):
            path = f'{u}/{image}.jpg'
            sql += f"""insert into auth.users(id,email) values('{u}','{u}@naver.yumidang.invalid');
              insert into auth.sessions(id,user_id) values('{se}','{u}');
              insert into storage.objects(id,bucket_id,name,owner_id,metadata)
                values('{image}','profile-images','{path}','{u}','{{"mimetype":"image/jpeg","size":128}}');
              insert into public.profiles(id,real_name,birth_date,gender,avatar_url) values('{u}','합성 경합','1990-01-01','female','{path}');
              insert into private.naver_accounts(subject,user_id,auth_email,real_name,birth_date,gender,verification_status,completed_at)
                values('{subject}','{u}','{u}@naver.yumidang.invalid','합성 경합','1990-01-01','F','qualified',clock_timestamp());
              insert into private.naver_sessions(session_id,user_id,subject) values('{se}','{u}','{subject}');"""
        sql += f"""insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)
            values('{post}','{users[0]}','합성 경합','실회원 자료 없음','산책',now()+interval '3 days',now()+interval '3 days 2 hours',now()+interval '2 days','서울특별시 강남구 역삼동');
          insert into public.join_requests(id,post_id,requester_id,message,status) values('{request}','{post}','{users[1]}','합성 신청','pending');commit;"""
        run(sql)

        def actor(i):
            claims = json.dumps({'role': 'authenticated', 'sub': users[i], 'session_id': sessions[i], 'is_anonymous': False})
            return f"set local role authenticated;select set_config('request.jwt.claim.sub','{users[i]}',true);select set_config('request.jwt.claims','{claims}',true);"

        return users, post, request, actor, subjects

    try:
        users, post, request, actor, subjects = fixture()
        message = str(uuid.uuid4())
        h = hold(actor(1) + f"select public.send_conversation_message('{request}','{message}','합성 전송 경합');")
        started = time.monotonic()
        run('begin;' + actor(0) + f"select public.retire_my_account('{uuid.uuid4()}');commit;")
        assert time.monotonic() - started > .5
        finish(h)
        assert run(f"select count(*) from public.chat_messages where id='{message}';") == '1'
        print('PASS: actual message commits before waiting retirement; history preserved')

        users, post, request, actor, subjects = fixture()
        h = hold(actor(0) + f"select public.retire_my_account('{uuid.uuid4()}');")
        run('begin;' + actor(1) + f"select public.send_conversation_message('{request}','{uuid.uuid4()}','합성 거절 전송');commit;", 'account_retired')
        finish(h)
        assert run(f"select count(*) from public.chat_messages where join_request_id='{request}';") == '0'
        print('PASS: retirement commits before waiting actual message; no message inserted')

        users, post, request, actor, subjects = fixture()
        h = hold(actor(0) + f"select public.block_member('{users[1]}');")
        run('begin;' + actor(1) + f"select public.retire_my_account('{uuid.uuid4()}');commit;")
        finish(h)
        print('PASS: block target FK protection precedes pair; retirement finishes without deadlock')

        users, post, request, actor, subjects = fixture()
        h = hold(actor(0) + 'select public.get_my_profile();')
        run('begin;' + actor(0) + f"select public.retire_my_account('{uuid.uuid4()}');commit;")
        finish(h)
        print('PASS: member shared gate serializes with exclusive retirement')

        users, post, request, actor, subjects = fixture()
        h = hold(actor(0) + 'select public.list_my_reports();')
        run('begin;' + actor(0) + f"select public.retire_my_account('{uuid.uuid4()}');commit;")
        finish(h)
        run('begin;' + actor(0) + 'select public.list_my_reports();commit;', 'account_retired')
        print('PASS: actual report member guard shares account/profile/episode order; stale caller denied')

        users, post, request, actor, subjects = fixture()
        service = "set local role service_role;select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);"
        h = hold(service + f"select public.resolve_naver_account('{subjects[0]}','합성 callback','F','1990-01-01');")
        run('begin;' + actor(0) + f"select public.retire_my_account('{uuid.uuid4()}');commit;")
        finish(h)
        assert run(f"select real_name is null from public.profiles where id='{users[0]}';") == 't'
        print('PASS: actual Naver callback precedes retirement without lock inversion; PII cleared')

        users, post, request, actor, subjects = fixture()
        h = hold(actor(0) + f"select public.retire_my_account('{uuid.uuid4()}');")
        run('begin;' + service + f"select public.resolve_naver_account('{subjects[0]}','합성 fresh callback','F','1990-01-01');commit;")
        finish(h)
        assert run(f"select real_name is null from public.profiles where id='{users[0]}';") == 't'
        assert run(f"select user_id is null from private.naver_accounts where subject='{subjects[0]}';") == 't'
        print('PASS: retirement precedes callback; fresh qualification never restores retired profile')
    finally:
        if fixture_users:
            ids = ','.join("'" + u + "'" for u in fixture_users)
            posts = ','.join("'" + u + "'" for u in fixture_posts)
            subjects = ','.join("'" + s + "'" for s in fixture_subjects)
            run(f"""begin;set local storage.allow_delete_query='true';
              delete from public.posts where id in({posts});
              delete from private.member_cleanup_tasks where profile_id in({ids});
              delete from private.member_retirements where profile_id in({ids});
              delete from private.member_blocks where blocker_id in({ids}) or blocked_id in({ids});
              delete from private.member_episodes where profile_id in({ids});
              delete from public.profiles where id in({ids});
              delete from storage.objects where owner_id in(select x::text from unnest(array[{ids}]::uuid[])x);
              delete from private.naver_sessions where user_id in({ids});
              delete from private.naver_identity_keys where subject in({subjects});
              delete from private.naver_accounts where subject in({subjects});
              delete from auth.users where id in({ids});commit;""")
            left = run(f"select (select count(*) from public.profiles where id in({ids}))+(select count(*) from auth.users where id in({ids}))+(select count(*) from private.member_episodes where profile_id in({ids}))+(select count(*) from private.naver_accounts where subject in({subjects}))+(select count(*) from private.member_retirements where profile_id in({ids}))+(select count(*) from public.posts where id in({posts}));")
            assert left == '0', left
            print('PASS: synthetic fixture cleanup 0')


if __name__ == '__main__':
    main()
