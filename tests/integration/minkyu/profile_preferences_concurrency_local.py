"""민규: 명시 승인 native62의 저장↔탈퇴 실제 두 세션 경합 후보.

키·Provider·HTTP를 사용하지 않는다. 합성 SQL 회원만 만들며 임시 준비는 탈퇴 TX
안에서 열고 닫는다. 실행 승인은 별도이며 py_compile은 실제 검증 증거가 아니다.
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
MANIFEST = Path('/private/tmp/yumidang-policy62-reviewed-omlrmcgb/prepared/migration-manifest.json')
MANIFEST_SHA = 'abbfcac0065c6be95aaec61df99876f3d527fe4675d1e14802b31c719696feb3'
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
    parser.add_argument('--native62-approved', action='store_true')
    parser.add_argument('--docker-host', required=True)
    parser.add_argument('--container', required=True)
    parser.add_argument('--database', required=True)
    parser.add_argument('--api-url', required=True)
    parser.add_argument('--db-port', required=True, type=int)
    args = parser.parse_args()
    require(args.native62_approved and args.docker_host == HOST and args.container == CONTAINER
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
    require(manifest['status'] == 'READY' and manifest['count'] == 62
            and manifest['mode'] == 'current_policy_gateway' and manifest['sql_execution'] == 'NOT_RUN'
            and len(manifest['migrations']) == 62, 'MANIFEST_CONTRACT_INVALID')
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
    require(len(set(versions)) == 62 and versions[-2:] == ['20261005040300', '20261005040500'], 'VERSION_SET_INVALID')
    command = ['docker', '--host', HOST, 'exec', '-i', CONTAINER, 'psql', '-XqAt', '-U', 'postgres',
               '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']
    processes, fixture_ids, fixture_subjects, results = [], [], [], []
    artifact = Path(tempfile.mkdtemp(prefix='yumidang-preferences-race62-'))
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
        claims = json.dumps({'sub': uid, 'role': 'authenticated', 'is_anonymous': False})
        return "set local role authenticated;select set_config('request.jwt.claims'," + literal(claims) + ",true);"

    def fixture():
        uid, subject = str(uuid.uuid4()), 'preferences-race-' + str(uuid.uuid4())
        fixture_ids.append(uid); fixture_subjects.append(subject)
        # DB 쓰기보다 먼저 정확한 복구 범위를 기록한다. JWT·키·원문·PID는 저장하지 않는다.
        private_json(recovery, {'scope':'isolated_native62_sql_only','fixtureIds':fixture_ids,
                               'fixtureSubjects':fixture_subjects,'manifestSha256':MANIFEST_SHA})
        run(f"""begin;insert into auth.users(id,email) values('{uid}','{uid}@naver.yumidang.invalid');
          insert into public.profiles(id,real_name,birth_date,gender,bio) values('{uid}','합성 경합','1990-01-01','female','초기 소개');
          insert into private.naver_accounts(subject,user_id,auth_email,real_name,birth_date,gender,verification_status,completed_at)
           values('{subject}','{uid}','{uid}@naver.yumidang.invalid','합성 경합','1990-01-01','F','qualified',clock_timestamp());
          insert into private.profile_traits(profile_id,interests,conversation_styles,mbti) values('{uid}',array['초기'],array[]::text[],null);commit;""")
        return uid

    def save(session, uid):
        session.write(actor(uid) + "select public.set_my_profile_preferences(array['산책'],array['차분한 대화'],'INFP','저장 소개');select 'SAVE_READY';")

    def retire(session, uid):
        # 같은 TX만 준비하며 외부 세션에는 열린 guard/ACL이 보이지 않는다.
        session.write("update private.member_cleanup_guard set external_deletion_approved=true where singleton;grant execute on function " + ','.join('public.' + s for s in CLEANUP) + " to service_role;" + actor(uid) +
                      "select public.retire_my_account('" + str(uuid.uuid4()) + "');reset role;update private.member_cleanup_guard set external_deletion_approved=false where singleton;revoke execute on function " + ','.join('public.' + s for s in CLEANUP) + " from service_role;select 'RETIRE_READY';")

    def retired(uid):
        require(run(f"select (p.bio is null and p.real_name is null and e.ended_at is not null and a.user_id is null and not exists(select 1 from private.profile_traits where profile_id=p.id) and (select count(*) from private.member_retirements where profile_id=p.id)=1 and (select count(*) from private.member_cleanup_tasks where profile_id=p.id and kind='auth_user')=1 and (select count(*) from private.member_cleanup_tasks where profile_id=p.id)=1) from public.profiles p join private.member_episodes e on e.profile_id=p.id cross join private.naver_accounts a where p.id='{uid}' and a.subject=(select subject from private.naver_identity_keys where id=e.identity_id);") == 't', 'RETIRED_STATE_MISMATCH')

    try:
        info = json.loads(subprocess.run(['docker','--host',HOST,'inspect',CONTAINER],capture_output=True,text=True,check=True,timeout=10).stdout)
        require(len(info) == 1 and info[0]['Name'] == '/' + CONTAINER and info[0]['State']['Running']
                and info[0]['Config']['Labels']['com.supabase.cli.project'] == 'yumidang-minkyu-drift'
                and any(p['HostPort']=='56532' for p in info[0]['HostConfig']['PortBindings']['5432/tcp']), 'CONTAINER_SCOPE_INVALID')
        baseline = catalog(); state = json.loads(baseline)
        require(state['history']==versions and state['guard'] is False and state['idle'] is True, 'NATIVE62_BASELINE_INVALID')
        common = CLEANUP + ['read_worker_run_budget(uuid)', 'read_worker_queue_schedule(text[],text)',
                            'acquire_worker_run(integer,uuid)', 'release_worker_run(uuid)']
        for sig in common:
            for role in ['anon','authenticated','service_role']:
                expected = role == 'service_role' and sig in ['acquire_worker_run(integer,uuid)','release_worker_run(uuid)']
                require(run(f"select has_function_privilege({literal(role)},{literal('public.'+sig)},'EXECUTE');") == ('t' if expected else 'f'), 'COMMON_ACL_MISMATCH')
        for role in ['anon','authenticated','service_role']:
            require(run(f"select has_function_privilege({literal(role)},'public.set_my_profile_preferences(text[],text[],text,text)','EXECUTE');") == ('t' if role=='authenticated' else 'f'), 'PREFERENCES_ACL_MISMATCH')
        require(run("select has_column_privilege('authenticated','public.profiles','bio','UPDATE');")=='f','BIO_UPDATE_NOT_CLOSED')
        baseline_counts = counts()
        require(all(baseline_counts[r]=='0' for r in ['auth.users','storage.objects','public.profiles','public.posts','public.appointments','private.member_retirements']), 'APPLICATION_NOT_EMPTY')
        uid = fixture(); a, b = Session(), Session(); save(a,uid); a.wait('SAVE_READY'); retire(b,uid); blocked(b,a)
        require(catalog()==baseline, 'UNCOMMITTED_PREPARATION_EXPOSED')
        a.write("commit;select 'DONE';"); a.wait('DONE'); a.finish(); b.wait('RETIRE_READY'); b.write("commit;select 'DONE';"); b.wait('DONE'); b.finish(); retired(uid)
        results.append('save_commit_then_retire_commit_actual_block')
        uid = fixture(); b, a = Session(), Session(); retire(b,uid); b.wait('RETIRE_READY'); save(a,uid); blocked(a,b)
        require(catalog()==baseline, 'UNCOMMITTED_PREPARATION_EXPOSED')
        b.write("commit;select 'DONE';"); b.wait('DONE'); b.finish(); a.finish('42501'); retired(uid)
        results.append('retire_commit_then_waiting_save_42501_actual_block')
        uid = fixture(); b, a = Session(), Session(); retire(b,uid); b.wait('RETIRE_READY'); save(a,uid); blocked(a,b)
        b.write("rollback;select 'DONE';"); b.wait('DONE'); b.finish(); a.wait('SAVE_READY'); a.write("commit;select 'DONE';"); a.wait('DONE'); a.finish()
        require(run(f"select (p.bio='저장 소개' and t.interests=array['산책'] and t.conversation_styles=array['차분한 대화'] and t.mbti='INFP' and e.ended_at is null and not exists(select 1 from private.member_retirements where profile_id=p.id) and not exists(select 1 from private.member_cleanup_tasks where profile_id=p.id)) from public.profiles p join private.profile_traits t on t.profile_id=p.id join private.member_episodes e on e.profile_id=p.id where p.id='{uid}';")=='t','ROLLBACK_SAVE_STATE_MISMATCH')
        results.append('retire_rollback_then_waiting_save_commit_actual_block')
    except Exception as error:
        failure = str(error) if isinstance(error, ProbeFailure) else 'PROBE_INFRASTRUCTURE_FAILED'
    finally:
        for session in processes:
            session.stop()
        try:
            if fixture_ids:
                ids = ','.join(literal(v) for v in fixture_ids); subjects = ','.join(literal(v) for v in fixture_subjects)
                run(f"begin;delete from private.member_cleanup_tasks where profile_id in({ids});delete from private.member_retirements where profile_id in({ids});delete from public.profiles where id in({ids});delete from private.member_episodes where profile_id in({ids});delete from private.naver_identity_keys where subject in({subjects});delete from private.naver_accounts where subject in({subjects});delete from auth.users where id in({ids});commit;")
            require(baseline is not None and catalog()==baseline, 'CATALOG_NOT_RESTORED')
            require(counts()==baseline_counts, 'RELATION_COUNTS_NOT_RESTORED')
            require(all(s.p.poll() is not None for s in processes), 'LIVE_PROCESS_REMAINS')
            pids = [s.pid for s in processes if hasattr(s, 'pid')]
            if pids:
                require(run('select count(*) from pg_stat_activity where pid in(' + ','.join(str(pid) for pid in pids) + ');') == '0', 'LIVE_DB_SESSION_REMAINS')
            cleanup_ok = True
        except Exception:
            failure = failure or 'FINALLY_NOT_VERIFIED'
    receipt = {'status':'FAIL' if failure else 'PASS','cases':results,'failureCode':failure,
               'cleanupVerified':cleanup_ok,'providerCalls':0,'externalNaver':False,
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
