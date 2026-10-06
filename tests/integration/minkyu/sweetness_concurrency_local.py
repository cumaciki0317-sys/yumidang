"""민규: 독립 당도 scratch에서 실제 2세션 공개/숨김/확정 사건 경합을 검사한다."""
import argparse
import json
from pathlib import Path
import subprocess
import threading
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--docker-host', required=True)
    parser.add_argument('--container', required=True)
    parser.add_argument('--database', required=True)
    args = parser.parse_args()
    if not args.docker_host.startswith('unix:///') or not args.database.startswith('yumidang_sweetness_'):
        parser.error('isolated local sweetness scratch required')
    cmd = ['docker', '--host', args.docker_host, 'exec', '-i', args.container, 'psql', '-U',
           'supabase_admin', '-d', args.database, '-v', 'ON_ERROR_STOP=1', '-qAt']
    service = "select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);"

    def run(sql):
        p = subprocess.run(cmd, input=sql, text=True, capture_output=True, timeout=30)
        if p.returncode:
            raise RuntimeError('synthetic scratch SQL failed: ' + p.stderr)
        return p.stdout.strip()

    def hold(sql):
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, bufsize=1)
        p.stdin.write('begin;' + service + sql + "select 'LOCK_READY';select pg_sleep(1);commit;")
        p.stdin.close()
        ready = threading.Event()

        def reader():
            for line in p.stdout:
                if line.strip() == 'LOCK_READY':
                    ready.set()

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()
        if not ready.wait(10):
            p.terminate()
            p.wait(timeout=5)
            raise RuntimeError('SQL lock readiness missing')
        return p, thread

    def finish(pair):
        p, thread = pair
        assert p.wait(timeout=10) == 0, p.stderr.read()
        thread.join(timeout=2)

    users = [str(uuid.uuid4()), str(uuid.uuid4())]
    fixture = (Path(__file__).resolve().parents[3] / 'tests/database/minkyu/current_sweetness_ledger.sql').read_text().split('-- 전 조합', 1)[0]
    fixture = fixture.replace("(1,gen_random_uuid()),(2,gen_random_uuid())", f"(1,'{users[0]}'),(2,'{users[1]}')")
    post_ids = []
    incident_ids = []
    try:
        run(fixture + 'commit;')

        def prepare():
            # Session-local fixture functions are reconstructed without creating another member.
            functions = fixture.split('create function pg_temp.sweet_uid', 1)[1]
            functions = 'create temp table sweetness_users(n integer,id uuid);' + f"insert into sweetness_users values(1,'{users[0]}'),(2,'{users[1]}');" + 'create function pg_temp.sweet_uid' + functions
            output = run('begin;' + functions + "create temp table ap_fixture as select pg_temp.sweet_fixture('positive',5,false) a;" +
                         "select jsonb_build_object('ap',a,'post',ap.post_id,'review',rv.id) from ap_fixture f join public.appointments ap on ap.id=f.a join public.appointment_reviews rv on rv.appointment_id=f.a;commit;")
            data = next(json.loads(line) for line in output.splitlines() if line.startswith('{') and '"ap"' in line)
            post_ids.append(data['post'])
            return data

        def score():
            return int(run(f"select private.current_member_sweetness('{users[1]}');"))

        def second_review(a):
            return f"insert into public.appointment_reviews(appointment_id,reviewer_id,rating,experience) values('{a}','{users[1]}',3,'neutral');"

        def remove_post(data):
            run('begin;' + service + f"delete from public.posts where id='{data['post']}';commit;")

        data = prepare()
        assert score() == 15
        pair = hold(second_review(data['ap']))
        run('begin;' + service + f"select public.set_review_publication('{data['review']}',false);commit;")
        finish(pair)
        assert score() == 17
        print('PASS: second submission commits before waiting hide; started contribution preserved')
        remove_post(data)

        data = prepare()
        pair = hold(f"select public.set_review_publication('{data['review']}',false);")
        run('begin;' + service + second_review(data['ap']) + 'commit;')
        finish(pair)
        assert score() == 15
        print('PASS: hide commits before waiting second submission; hidden review never contributes')
        remove_post(data)

        data = prepare()
        run('begin;' + service + second_review(data['ap']) + 'commit;')
        pair = hold(f"select private.decide_review_sweetness('{uuid.uuid4()}','{data['review']}',1,false);")
        run('begin;' + service + f"select public.set_review_publication('{data['review']}',true);commit;")
        finish(pair)
        assert score() == 15
        assert run(f"select private.is_review_public_eligible('{data['review']}');") == 'f'
        print('PASS: final invalidation wins; publication retry cannot restore invalid score/source')
        remove_post(data)

        episode = run(f"select private.active_member_episode('{users[1]}');")
        i1, i2 = str(uuid.uuid4()), str(uuid.uuid4())
        incident_ids.extend([i1, i2])
        pair = hold(f"select private.decide_incident_sweetness('{uuid.uuid4()}','{i1}','{episode}','cancel_sanction',1,true);")
        run(f"begin;select private.decide_incident_sweetness('{uuid.uuid4()}','{i2}','{episode}','no_show',1,true);commit;")
        finish(pair)
        assert score() == 10
        print('PASS: concurrent independent confirmed incidents retain both contributions')
    finally:
        user_list = ','.join("'" + u + "'" for u in users)
        run('begin;' + service + f"delete from private.sweetness_incident_decisions where recipient_episode_id in(select id from private.member_episodes where profile_id in({user_list}));" +
            f"delete from private.sweetness_incidents where recipient_episode_id in(select id from private.member_episodes where profile_id in({user_list}));" +
            f"delete from public.posts where author_id in({user_list});delete from auth.users where id in({user_list});delete from private.member_episodes where profile_id in({user_list});commit;")
        assert run(f"select (select count(*) from auth.users where id in({user_list}))+(select count(*) from public.profiles where id in({user_list}))+(select count(*) from private.member_episodes where profile_id in({user_list}));") == '0'
        for post in post_ids:
            assert run(f"select count(*) from public.posts where id='{post}';") == '0'
        for incident in incident_ids:
            assert run(f"select (select count(*) from private.sweetness_incidents where incident_id='{incident}')+(select count(*) from private.sweetness_incident_decisions where incident_id='{incident}');") == '0'
        print('PASS: all random synthetic members, episodes, posts and incident decisions removed')


if __name__ == '__main__':
    main()
