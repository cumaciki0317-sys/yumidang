"""민규: 명시 승인 native63의 일정·장소 변경 철회↔수락 실제 두 세션 경합 후보.

키·Provider·HTTP를 사용하지 않는다. 합성 SQL 회원만 만들며 guard·권한을 열지 않는다. 실행 승인은 별도이며 py_compile은 실제 검증 증거가 아니다.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import tempfile
import time
import uuid

SOURCE = Path('/Users/minkyu/Documents/GitHub/yumidang/.worktrees/minkyu-foundation')
MANIFEST = Path('/private/tmp/yumidang-policy63-reviewed-khq_kxpq/prepared/migration-manifest.json')
MANIFEST_SHA = '53c58346cab037e08eb4c6e2842f76b3818700e5ca7bf4c8afb3d45cb5281e68'
HOST = 'unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock'
CONTAINER = 'supabase_db_yumidang-minkyu-drift'
CLEANUP = ['claim_member_cleanup_task(uuid)', 'check_member_cleanup_task(uuid,uuid,uuid,uuid)',
           'get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)',
           'record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)',
           'complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)']


class ProbeFailure(Exception):
    pass


def require(value, code):
    if not value:
        raise ProbeFailure(code)


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--native63-approved', action='store_true')
    parser.add_argument('--docker-host', required=True)
    parser.add_argument('--container', required=True)
    parser.add_argument('--database', required=True)
    parser.add_argument('--api-url', required=True)
    parser.add_argument('--db-port', required=True, type=int)
    args = parser.parse_args()
    require(args.native63_approved and args.docker_host == HOST and args.container == CONTAINER
            and args.database == 'postgres' and args.api_url == 'http://127.0.0.1:56531'
            and args.db_port == 56532, 'EXACT_ISOLATED_SCOPE_REQUIRED')
    # 소스 파일·manifest는 비밀 설정 파일이 아니며 키를 읽지 않는다.
    st, parent = MANIFEST.lstat(), MANIFEST.parent.lstat()
    require(not MANIFEST.is_symlink() and not MANIFEST.parent.is_symlink() and MANIFEST.resolve() == MANIFEST and st.st_uid == os.getuid()
            and st.st_nlink == 1 and st.st_mode & 0o777 == 0o644 and parent.st_mode & 0o777 == 0o700
            and parent.st_uid == os.getuid(), 'MANIFEST_SCOPE_INVALID')
    raw = MANIFEST.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == MANIFEST_SHA, 'MANIFEST_HASH_INVALID')
    manifest = json.loads(raw)
    require(manifest['status'] == 'READY' and manifest['count'] == 63
            and manifest['mode'] == 'current_policy_gateway' and manifest['sql_execution'] == 'NOT_RUN'
            and len(manifest['migrations']) == 63, 'MANIFEST_CONTRACT_INVALID')
    versions = []
    for item in manifest['migrations']:
        require(re.fullmatch(r'backend/supabase/migrations/\d{14}_[a-z0-9_]+\.sql', item['path'])
                and re.fullmatch(r'\d{14}', item['version'])
                and Path(item['path']).name.startswith(item['version'] + '_'), 'SQL_PATH_INVALID')
        path = SOURCE / item['path']
        require(not path.is_symlink() and path.is_file()
                and hashlib.sha256(path.read_bytes()).hexdigest() == item['sha256'], 'SQL_BYTES_MISMATCH')
        versions.append(item['version'])
    versions.sort()
    require(len(set(versions)) == 63 and versions[-3:] == ['20261005040300', '20261005040500', '20261005040600'], 'VERSION_SET_INVALID')
    command = ['docker', '--host', HOST, 'exec', '-i', CONTAINER, 'psql', '-XqAt', '-U', 'postgres',
               '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']
    processes, fixture_ids, fixture_subjects, fixture_posts, fixture_sessions, fixture_photos, results = [], [], [], [], [], [], []
    artifact = Path(tempfile.mkdtemp(prefix='yumidang-change-withdraw-race63-'))
    artifact.chmod(0o700)
    recovery = artifact / 'fixture-recovery.json'

    def private_json(path, value):
        # 같은 private 디렉터리에서 원자 교체하며 쓰기 중 실패에도 이전 복구 목록을 보존한다.
        temporary = path.with_suffix('.pending')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(value, stream, ensure_ascii=False, indent=2)
                stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
            os.replace(temporary, path)
            path.chmod(0o600)
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if temporary.exists():
                temporary.unlink()

    baseline = None
    failure = None
    cleanup_ok = False
    bucket_created = False

    def run(sql):
        try:
            p = subprocess.run(command, input="set statement_timeout='10s';set lock_timeout='8s';" + sql,
                               text=True, capture_output=True, timeout=15)
        except subprocess.TimeoutExpired:
            raise ProbeFailure('OWNER_QUERY_TIMEOUT') from None
        require(p.returncode == 0, 'OWNER_QUERY_FAILED')
        return p.stdout.strip()

    def catalog():
        return run("""select jsonb_build_object(
          'roles',(select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,md5(coalesce(rolconfig::text,''))) order by rolname) from pg_roles),
          'memberships',(select coalesce(jsonb_agg(jsonb_build_array(r.rolname,m.rolname,g.rolname,a.admin_option,a.inherit_option,a.set_option) order by r.rolname,m.rolname,g.rolname),'[]') from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor),
          'acls',(select jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_userbyid(p.proowner),p.proacl::text) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private','auth','storage')),
          'bioAcl',(select attacl::text from pg_attribute where attrelid='public.profiles'::regclass and attname='bio'),
          'guard',(select external_deletion_approved from private.member_cleanup_guard where singleton),
          'history',(select jsonb_agg(version order by version) from supabase_migrations.schema_migrations),
          'idle',(select token is null and expires_at is null from private.global_worker_run where singleton));""")

    def files():
        try:
            response = subprocess.run(['docker','--host',HOST,'exec','supabase_storage_yumidang-minkyu-drift','find','/var/lib/storage','-type','f'],capture_output=True,text=True,timeout=10)
        except subprocess.TimeoutExpired:
            raise ProbeFailure('FILES_QUERY_TIMEOUT') from None
        require(response.returncode==0,'FILES_QUERY_FAILED')
        return len(response.stdout.strip().splitlines()) if response.stdout.strip() else 0

    def counts():
        relations = json.loads(run("select jsonb_agg(format('%I.%I',n.nspname,c.relname) order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage') and c.relkind='r';"))
        return {r: run('select count(*) from ' + r + ';') for r in relations}

    class Session:
        def __init__(self):
            self.p = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True, bufsize=1)
            processes.append(self)
            self.lines, self.errors = queue.Queue(), []
            def read_stdout():
                for line in self.p.stdout:
                    self.lines.put(line.strip())
            def read_stderr():
                for line in self.p.stderr:
                    match = re.search(r'ERROR:\s+([A-Z0-9]{5}):', line)
                    if match:
                        self.errors.append(match.group(1))
            self.reader = threading.Thread(target=read_stdout, daemon=True)
            self.error_reader = threading.Thread(target=read_stderr, daemon=True)
            self.reader.start(); self.error_reader.start()
            self.write("select 'PID:'||pg_backend_pid();")
            self.pid = int(self.wait('PID:', prefix=True)[4:])
            self.write("begin;set local statement_timeout='10s';set local lock_timeout='8s';")

        def write(self, sql):
            require(self.p.poll() is None, 'SESSION_TERMINAL_EARLY')
            self.p.stdin.write(sql + '\n'); self.p.stdin.flush()

        def wait(self, marker, prefix=False):
            until = time.monotonic() + 12
            while time.monotonic() < until:
                try:
                    line = self.lines.get(timeout=.1)
                except queue.Empty:
                    require(self.p.poll() is None, 'SESSION_TERMINAL_EARLY')
                    continue
                if (line.startswith(marker) if prefix else line == marker):
                    return line
            raise ProbeFailure('BARRIER_TIMEOUT')

        def finish(self, expected=None):
            if self.p.stdin and not self.p.stdin.closed:
                self.p.stdin.close()
            try:
                code = self.p.wait(timeout=15)
            except subprocess.TimeoutExpired:
                raise ProbeFailure('SESSION_FINISH_TIMEOUT') from None
            self.reader.join(timeout=1); self.error_reader.join(timeout=1)
            require((code == 0 and not self.errors) if expected is None else
                    (code != 0 and self.errors == [expected]), 'SESSION_OUTCOME_MISMATCH')

        def stop(self):
            if self.p.poll() is None:
                try:
                    self.write('rollback;')
                    self.p.stdin.close()
                    self.p.wait(timeout=3)
                except (OSError, ProbeFailure, subprocess.TimeoutExpired):
                    self.p.terminate()
                    try:
                        self.p.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        self.p.kill(); self.p.wait(timeout=3)

    def blocked(waiter, holder):
        until = time.monotonic() + 5
        while time.monotonic() < until:
            if run(f'select {holder.pid}=any(pg_blocking_pids({waiter.pid}));') == 't':
                return
            require(waiter.p.poll() is None, 'WAITER_FAILED_BEFORE_BLOCK')
            time.sleep(.05)
        raise ProbeFailure('ACTUAL_LOCK_WAIT_NOT_OBSERVED')

    def actor(uid):
        session = fixture_sessions[fixture_ids.index(uid)]
        claims = json.dumps({'sub':uid,'role':'authenticated','session_id':session,'is_anonymous':False})
        return "set local role authenticated;select set_config('request.jwt.claims'," + literal(claims) + ",true);"

    def record_recovery():
        private_json(recovery, {'scope':'isolated_native63_sql_metadata_only','fixtureIds':fixture_ids,
                               'fixtureSubjects':fixture_subjects,'fixturePosts':fixture_posts,
                               'fixtureSessions':fixture_sessions,'fixturePhotos':fixture_photos,
                               'bucketCreated':bucket_created,'manifestSha256':MANIFEST_SHA})

    def fixture_members():
        nonlocal bucket_created
        bucket_created = run("select exists(select 1 from storage.buckets where id='profile-images');") == 'f'
        for _ in range(2):
            uid, session, subject, image = str(uuid.uuid4()), str(uuid.uuid4()), 'withdraw-race-'+str(uuid.uuid4()), str(uuid.uuid4())
            fixture_ids.append(uid); fixture_sessions.append(session); fixture_subjects.append(subject)
            photo = uid+'/'+image+'.jpg';fixture_photos.append(photo);record_recovery()
            run("begin;insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('profile-images','profile-images',false,2097152,array['image/jpeg']) on conflict(id) do nothing;"+
                "set local role service_role;select public.resolve_naver_account("+literal(subject)+",'합성 경합','F','1990-01-01');reset role;"+
                f"insert into auth.users(id,email) select '{uid}',auth_email from private.naver_accounts where subject={literal(subject)};"+
                f"insert into auth.sessions(id,user_id) values('{session}','{uid}');"+
                f"insert into storage.objects(id,bucket_id,name,owner_id,metadata) values('{image}','profile-images',{literal(photo)},'{uid}',{literal(json.dumps({'mimetype':'image/jpeg','size':128}))});"+
                "set local role service_role;select public.record_naver_session("+literal(subject)+f",'{uid}','{session}');reset role;"+
                actor(uid)+"select public.complete_naver_signup("+literal(photo)+",'{}','{}',null);commit;")

    def fixture_case(offset):
        post, change = str(uuid.uuid4()), str(uuid.uuid4())
        fixture_posts.append(post);record_recovery()
        # 공고/신청/확정/제안은 실제 공개 RPC다. 사진은 SQL metadata이며 blob 업로드가 아니다.
        output = run("begin;create temp table probe(data jsonb);grant all on probe to authenticated;"+
          actor(fixture_ids[0])+f"select public.create_service_post('{post}',jsonb_build_object('title','합성 경합','description','격리 SQL 회귀','category','산책','startsAt',clock_timestamp()+interval '{offset} days','endsAt',clock_timestamp()+interval '{offset} days 2 hours','recruitmentEndsAt',clock_timestamp()+interval '1 day','publicArea','서울특별시 강남구 역삼동','registeredPlaceName','가상 기존 장소','registeredAddress','서울특별시 강남구 가상주소','meetingDetail','기존 가상 입구','preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0));"+
          actor(fixture_ids[1])+f"insert into probe values(public.request_service_post('{post}',gen_random_uuid(),'합성 신청'));"+
          actor(fixture_ids[0])+"insert into probe values(public.propose_match((select (data->>'id')::uuid from probe where data?'id')));"+
          actor(fixture_ids[1])+"insert into probe values(public.accept_match((select (data->>'id')::uuid from probe where data?'id'),(select data->>'conditionVersion' from probe where data?'conditionVersion')));"+
          actor(fixture_ids[0])+"insert into probe values(public.get_appointment_change_state((select (data->>'appointmentId')::uuid from probe where data?'appointmentId')));"+
          f"insert into probe select public.propose_appointment_schedule_change((select (data->>'appointmentId')::uuid from probe where data?'appointmentId' and not data?'updatedAt'),'{change}',p.starts_at+interval '1 hour',p.ends_at+interval '1 hour',(select (data->>'updatedAt')::timestamptz from probe where data?'updatedAt'),jsonb_build_object('publicArea','부산광역시 중구 중앙동','registeredPlaceName','새 가상 장소','registeredAddress','부산광역시 중구 새 가상주소','meetingDetail','새 가상 입구')) from public.posts p where p.id='{post}';reset role;"+
          f"select jsonb_build_object('post','{post}','change','{change}','appointment',appointment_id,'version',condition_version,'newStarts',new_starts_at,'newEnds',new_ends_at) from private.appointment_schedule_changes where change_id='{change}';commit;")
        candidates = [line for line in output.splitlines() if line.startswith('{') and 'newStarts' in line]
        require(len(candidates)==1,'CASE_FIXTURE_RESPONSE_INVALID')
        case = json.loads(candidates[0]);case['before'] = snapshot(case)
        return case

    def snapshot(case):
        return run("select jsonb_build_object('post',to_jsonb(p),'appointment',to_jsonb(a),'location',(select to_jsonb(l) from private.post_search_locations l where post_id=p.id),'details',(select to_jsonb(d) from public.post_private_details d where post_id=p.id),'reservation',(select to_jsonb(r) from private.completion_reservations r where appointment_id=a.id)) from public.posts p join public.appointments a on a.post_id=p.id where p.id="+literal(case['post'])+" and a.id="+literal(case['appointment'])+";")

    def action(session,case,verb):
        uid = fixture_ids[0] if verb=='withdraw' else fixture_ids[1]
        session.write(actor(uid)+"select public."+verb+"_appointment_schedule_change("+
                      ','.join(literal(case[k]) for k in ['appointment','change','version'])+");select 'ACTION_READY';")

    def finish_holder(session,commit=True):
        session.write(("commit;" if commit else "rollback;")+"select 'DONE';")
        session.wait('DONE');session.finish()

    def inspect_case(case,status):
        value=json.loads(run("select jsonb_build_object('status',status,'locationCleared',new_location_input is null,'events',(select count(*) from private.match_lifecycle_events where kind='appointment_schedule_change_ended' and event_key=c.condition_version),'notifications',(select count(*) from public.notifications where kind='appointment_schedule_change_ended' and event_data->>'changeId'=c.change_id::text)) from private.appointment_schedule_changes c where change_id="+literal(case['change'])+";"))
        require(value=={'status':status,'locationCleared':True,'events':1,'notifications':2},'TERMINAL_STATE_MISMATCH')
        if status=='withdrawn':
            require(snapshot(case)==case['before'],'WITHDRAW_CHANGED_ORIGINAL_APPOINTMENT')
        else:
            before = json.loads(case['before'])
            after = json.loads(snapshot(case))
            require(after['appointment']==before['appointment'], 'ACCEPT_CHANGED_APPOINTMENT_ROW')
            require(after['reservation']['generation']!=before['reservation']['generation'], 'ACCEPT_RESERVATION_GENERATION_UNCHANGED')
            require(run("select p.starts_at="+literal(case['newStarts'])+"::timestamptz and p.ends_at="+literal(case['newEnds'])+"::timestamptz and p.public_area='부산광역시 중구 중앙동' and l.registered_place_name='새 가상 장소' and l.registered_address='부산광역시 중구 새 가상주소' and d.exact_location='새 가상 입구' and a.status='confirmed' and cr.due_at=p.ends_at+interval '24 hours' from public.posts p join public.appointments a on a.post_id=p.id join private.completion_reservations cr on cr.appointment_id=a.id join private.post_search_locations l on l.post_id=p.id join public.post_private_details d on d.post_id=p.id where p.id="+literal(case['post'])+";")=='t','ACCEPTED_VALUES_MISMATCH')

    try:
        info = json.loads(subprocess.run(['docker','--host',HOST,'inspect',CONTAINER],capture_output=True,text=True,check=True,timeout=10).stdout)
        require(len(info) == 1 and info[0]['Name'] == '/' + CONTAINER and info[0]['State']['Running']
                and info[0]['Config']['Labels']['com.supabase.cli.project'] == 'yumidang-minkyu-drift'
                and any(p['HostPort']=='56532' for p in info[0]['HostConfig']['PortBindings']['5432/tcp']), 'CONTAINER_SCOPE_INVALID')
        baseline = catalog(); state = json.loads(baseline)
        require(state['history']==versions and state['guard'] is False and state['idle'] is True, 'NATIVE63_BASELINE_INVALID')
        common = CLEANUP + ['read_worker_run_budget(uuid)', 'read_worker_queue_schedule(text[],text)',
                            'acquire_worker_run(integer,uuid)', 'release_worker_run(uuid)']
        for sig in common:
            for role in ['anon','authenticated','service_role']:
                expected = role == 'service_role' and sig in ['acquire_worker_run(integer,uuid)','release_worker_run(uuid)']
                require(run(f"select has_function_privilege({literal(role)},{literal('public.'+sig)},'EXECUTE');") == ('t' if expected else 'f'), 'COMMON_ACL_MISMATCH')
        for role in ['anon','authenticated','service_role']:
            require(run(f"select has_function_privilege({literal(role)},'public.set_my_profile_preferences(text[],text[],text,text)','EXECUTE');") == ('t' if role=='authenticated' else 'f'), 'PREFERENCES_ACL_MISMATCH')
        require(run("select has_column_privilege('authenticated','public.profiles','bio','UPDATE');")=='f','BIO_UPDATE_NOT_CLOSED')
        for role in ['anon','authenticated','service_role','yumidang_worker_queue']:
            require(run(f"select has_function_privilege({literal(role)},'public.withdraw_appointment_schedule_change(uuid,uuid,text)','EXECUTE');") == ('t' if role=='authenticated' else 'f'), 'WITHDRAW_ACL_MISMATCH')
        baseline_counts = counts()
        require(files()==0,'STORAGE_BACKEND_NOT_EMPTY')
        require(all(baseline_counts[r]=='0' for r in ['auth.users','storage.objects','public.profiles','public.posts','public.appointments','private.member_retirements']), 'APPLICATION_NOT_EMPTY')
        fixture_members()
        case=fixture_case(3);a,b=Session(),Session();action(a,case,'withdraw');a.wait('ACTION_READY');action(b,case,'accept');blocked(b,a)
        finish_holder(a);b.finish('40001');inspect_case(case,'withdrawn')
        results.append('withdraw_commit_waiting_accept_40001_original_preserved')
        case=fixture_case(6);a,b=Session(),Session();action(a,case,'accept');a.wait('ACTION_READY');action(b,case,'withdraw');blocked(b,a)
        finish_holder(a);b.finish('40001');inspect_case(case,'accepted')
        results.append('accept_commit_waiting_withdraw_40001_new_conditions_preserved')
        case=fixture_case(9);a,b=Session(),Session();action(a,case,'withdraw');a.wait('ACTION_READY');action(b,case,'accept');blocked(b,a)
        finish_holder(a,False);b.wait('ACTION_READY');finish_holder(b);inspect_case(case,'accepted')
        results.append('withdraw_rollback_waiting_accept_commit')
    except Exception as error:
        failure = str(error) if isinstance(error, ProbeFailure) else 'PROBE_INFRASTRUCTURE_FAILED'
    finally:
        for session in processes:
            session.stop()
        try:
            if fixture_ids:
                ids = ','.join(literal(v) for v in fixture_ids); subjects = ','.join(literal(v) for v in fixture_subjects)
                posts = ','.join(literal(v) for v in fixture_posts)
                commands = "begin;set local storage.allow_delete_query='true';"
                if posts:
                    commands += f"delete from public.appointments where post_id in({posts});delete from public.posts where id in({posts});"
                commands += f"delete from public.profiles where id in({ids});delete from private.member_episodes where profile_id in({ids});delete from private.naver_sessions where user_id in({ids});delete from private.naver_identity_keys where subject in({subjects});delete from private.naver_accounts where subject in({subjects});"
                commands += "delete from storage.objects where bucket_id='profile-images' and name in("+', '.join(literal(v) for v in fixture_photos)+");"
                commands += f"delete from auth.users where id in({ids});"
                if bucket_created:
                    commands += "delete from storage.buckets where id='profile-images';"
                run(commands+'commit;')

            require(baseline is not None and catalog()==baseline, 'CATALOG_NOT_RESTORED')
            require(counts()==baseline_counts, 'RELATION_COUNTS_NOT_RESTORED')
            require(files()==0,'STORAGE_BACKEND_NOT_EMPTY_FINALLY')
            require(all(s.p.poll() is not None for s in processes), 'LIVE_PROCESS_REMAINS')
            pids = [s.pid for s in processes if hasattr(s, 'pid')]
            if pids:
                require(run('select count(*) from pg_stat_activity where pid in(' + ','.join(str(pid) for pid in pids) + ');') == '0', 'LIVE_DB_SESSION_REMAINS')
            cleanup_ok = True
        except Exception:
            failure = failure or 'FINALLY_NOT_VERIFIED'
    receipt = {'status':'FAIL' if failure else 'PASS','cases':results,'failureCode':failure,
               'cleanupVerified':cleanup_ok,'providerCalls':0,'externalNaver':False,'storageBlobProof':False,'actualHttpProof':False,
               'manifestSha256':MANIFEST_SHA,
               'driverSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               'sourceSqlSha256':{item['path']:item['sha256'] for item in manifest['migrations']},
               'recoveryRetained':not cleanup_ok and recovery.exists()}
    try:
        private_json(artifact / 'result.json',receipt)
        # 최종 검사와 영수증 저장 뒤에만 복구용 식별 자료를 제거한다.
        if cleanup_ok and recovery.exists():
            recovery.unlink()
    except Exception:
        failure = failure or 'ARTIFACT_FINALIZATION_FAILED'
        receipt['status'] = 'FAIL'
        receipt['failureCode'] = failure
    print(json.dumps({'status':receipt['status'],'cases':results,'failureCode':failure,
                      'cleanupVerified':cleanup_ok,'artifact':str(artifact / 'result.json')}))
    return 1 if failure else 0


if __name__ == '__main__':
    raise SystemExit(main())
