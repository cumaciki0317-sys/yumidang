#!/usr/bin/env python3
"""21811의 독립 scratch 전용 실제 RPC 경합 harness. START 전에는 --help/정적 검사만 한다.

운영/native postgres/원본 컨테이너/역할 생성은 금지한다. --execute 없이는 연결하지 않는다.
retire probe의 DB-local function ACL/guard는 한 transaction에서만 바꾸고 항상 rollback한다.
stdout에는 합성 행·SQL·키 없이 결과/비공개 receipt 경로만 출력한다.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
import uuid

DOCKER_HOST = 'unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock'
CONTAINER = 'supabase_db_yumidang-minkyu-drift'
CLEANUP = [
    'public.claim_member_cleanup_task(uuid)',
    'public.check_member_cleanup_task(uuid,uuid,uuid,uuid)',
    'public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)',
    'public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)',
    'public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)',
]
ROOTS = ['auth.users', 'public.profiles', 'storage.objects',
         'private.naver_accounts', 'private.naver_identity_keys', 'private.safety_incidents']


def literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class Session:
    """별도 backend의 psql 지속 세션. 오류는 세션 종료/예외이며 PASS로 투영하지 않는다."""
    def __init__(self, database: str, label: str, artifact: Path):
        self.label = label
        self.lines: queue.Queue[str | None] = queue.Queue()
        self.stderr = (artifact / (label + '.stderr')).open('wb')
        os.chmod(artifact / (label + '.stderr'), 0o600)
        self.process = subprocess.Popen([
            'docker', '--host', DOCKER_HOST, 'exec', '-i', CONTAINER,
            'psql', '-X', '-q', '-A', '-t', '-U', 'supabase_admin',
            '-d', database, '-v', 'ON_ERROR_STOP=1'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
            text=True, bufsize=1)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        try:
            self.execute("set statement_timeout='8s';set lock_timeout='6s';"
                     "select set_config('application_name'," + literal(label) + ",false);")
            self.execute("""
create function pg_temp.expect_state(command text,expected text)returns text language plpgsql as $$
declare got text;begin
 begin execute command;exception when others then get stacked diagnostics got=returned_sqlstate;end;
 if got is distinct from expected then raise exception 'unexpected_sqlstate expected=% actual=%',expected,got;end if;
 return got;
end;$$;
""")
        except Exception:
            self.close()
            raise

    def _read(self):
        assert self.process.stdout
        for line in self.process.stdout:
            self.lines.put(line.rstrip('\n'))
        self.lines.put(None)

    def execute(self, sql: str) -> list[str]:
        assert self.process.stdin
        marker = 'end_' + uuid.uuid4().hex
        try:
            self.process.stdin.write(sql + '\nselect ' + literal(marker) + ';\n')
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise RuntimeError('SQL_SESSION_TERMINATED') from error
        result = []
        deadline = time.monotonic() + 12
        while True:
            try:
                line = self.lines.get(timeout=max(.01, deadline-time.monotonic()))
            except queue.Empty as error:
                raise RuntimeError('SQL_SESSION_TIMEOUT') from error
            if line is None:
                raise RuntimeError('SQL_SESSION_FAILED_SEE_PRIVATE_LOG')
            if line == marker:
                return result
            if line:
                result.append(line)

    def scalar(self, sql: str) -> str:
        values = self.execute(sql)
        if len(values) != 1:
            raise RuntimeError('UNEXPECTED_QUERY_SHAPE')
        return values[0]

    def expected(self, sql: str, state: str):
        got = self.scalar('select pg_temp.expect_state(' + literal(sql) + ',' + literal(state) + ');')
        if got != state:
            raise AssertionError('UNEXPECTED_SQLSTATE')

    def close(self):
        if self.process.poll() is None:
            try:
                self.execute('rollback;reset role;')
                assert self.process.stdin
                self.process.stdin.write('\\q\n')
                self.process.stdin.flush()
                self.process.wait(timeout=3)
            except Exception:
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        self.stderr.close()


class Harness:
    def __init__(self, database: str, artifact: Path):
        self.database = database
        self.artifact = artifact
        self.sessions: list[Session] = []
        self.results: list[str] = []
        # 독립 합성 UUID는 실제 자료/키가 아니며 stdout에 출력하지 않는다.
        self.namespace = uuid.uuid4()
        self.subjects = {n: 'sanction-race-' + self.namespace.hex + '-' + str(n) for n in range(1, 9) if n != 5}
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        self.fixture_started = False
        self.bucket_created = False
        self.doomed: list[str] = []
        self.original_cleanup = None
        self.original_roles_hash = None

    def uid(self, kind: str, n: int) -> str:
        return str(uuid.uuid5(self.namespace, kind + ':' + str(n)))

    def session(self, suffix: str) -> Session:
        s = Session(self.database, 'sanction-race-' + self.namespace.hex[:10] + '-' + suffix, self.artifact)
        self.sessions.append(s)
        return s

    def actor(self, s: Session, n: int):
        claims = json.dumps({'role':'authenticated', 'sub':self.uid('user', n), 'session_id':self.uid('session', n)})
        s.execute('set local role authenticated;select set_config(\'request.jwt.claims\',' + literal(claims) + ',true);'
                  'select set_config(\'request.jwt.claim.sub\',' + literal(self.uid('user', n)) + ',true);')

    def begin_actor(self, s: Session, n: int):
        s.execute('begin;')
        self.actor(s, n)

    def input(self, n: int) -> str:
        # DB now에 상대적인 합성 날짜. 현행 등록 장소·공개 지역 계약을 사용한다.
        return "jsonb_build_object('title','합성 경합 공고','description','격리 SQL fixture','category','산책'," \
            f"'startsAt',clock_timestamp()+interval'{n%20+1} days','endsAt',clock_timestamp()+interval'{n%20+1} days 2 hours'," \
            f"'recruitmentEndsAt',clock_timestamp()+interval'{n%20+1} days -1 hours'," \
            "'publicArea','서울특별시 강남구 역삼동','registeredPlaceName','가상 장소','registeredAddress','비공개 가상주소 123'," \
            "'meetingDetail','비공개 가상 지점','preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0)"

    def create(self, n: int, key: int) -> str:
        return 'select public.create_service_post(' + literal(self.uid('post', key)) + ',' + self.input(key) + ');'

    def decision(self, incident: int, members: list[int], expected=0, state='confirmed') -> str:
        subjects = []
        for n in members:
            subjects.append("(select jsonb_build_object('identityId',e.identity_id,'sourceEpisodeId',e.id,'confirmedKinds',"
                            "jsonb_build_array('major_violation'))from private.member_episodes e where e.profile_id=" +
                            literal(self.uid('user', n)) + '::uuid and e.ended_at is null)')
        payload = 'jsonb_build_array(' + ','.join(subjects) + ')' if state == 'confirmed' else "'[]'::jsonb"
        return 'select private.record_incident_revision(' + ','.join([
            literal(self.uid('incident', incident)), literal(str(uuid.uuid4())), str(expected), literal(state),
            "'synthetic_race'", literal(self.uid('operator', 99)), payload]) + ');'

    def snapshot(self, s: Session, incident: int) -> str:
        i = literal(self.uid('incident', incident))
        # 변경 행수뿐 아니라 기존 revision/효력/당도 결정 값의 전체 rollback도 비교한다.
        return s.scalar("select jsonb_build_object('incident',(select count(*)from private.safety_incidents where id=" + i +
                        "),'revision',(select count(*)from private.safety_incident_revisions where incident_id=" + i +
                        "),'applications',(select count(*)from private.safety_sanction_applications where incident_id=" + i +
                        "),'sweetness',(select count(*)from private.sweetness_incident_decisions where incident_id=" + i +
                        "),'metadataHash',md5(jsonb_build_array("
                        "(select jsonb_agg(to_jsonb(x)order by x.id)from private.safety_incidents x where x.id=" + i + "),"
                        "(select jsonb_agg(to_jsonb(x)order by x.revision)from private.safety_incident_revisions x where x.incident_id=" + i + "),"
                        "(select jsonb_agg(to_jsonb(x)order by x.revision,x.identity_id)from private.safety_incident_subjects x where x.incident_id=" + i + "),"
                        "(select jsonb_agg(to_jsonb(x)order by x.id)from private.safety_sanction_applications x where x.incident_id=" + i + "),"
                        "(select jsonb_agg(to_jsonb(x)order by x.recipient_episode_id,x.kind,x.revision)from private.sweetness_incident_decisions x where x.incident_id=" + i +
                        "))::text))::text;")

    def no_effect(self, s: Session, incident: int):
        state = json.loads(self.snapshot(s, incident))
        if any(state[key] != 0 for key in ['incident', 'revision', 'applications', 'sweetness']):
            raise AssertionError('PARTIAL_EFFECT_FOUND')

    def wait_locked(self, observer: Session, s: Session, future):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if future.done():
                future.result()  # 실제 SQL 오류를 무시하지 않는다.
                raise AssertionError('EXPECTED_BACKEND_LOCK_WAIT')
            found = observer.scalar('select count(*)from pg_stat_activity where datname=current_database() and application_name=' +
                                    literal(s.label) + " and wait_event_type='Lock';")
            if found == '1':
                return
            time.sleep(.02)
        raise AssertionError('LOCK_WAIT_NOT_OBSERVED')

    def pass_case(self, name: str):
        self.results.append(name)
        print(name + ' PASS', flush=True)

    def preflight(self, o: Session):
        # prepare/apply를 실행하지 않는다. 전용 scratch/21811이 준비돼 있는지 검사한다.
        if o.scalar("select exists(select 1 from pg_proc where oid='private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)'::regprocedure and prosrc like '%for update of a nowait%' and prosrc like '%identity_id=any(ids)%')::text;") != 'true':
            raise RuntimeError('REVIEWED_21811_NOT_APPLIED')
        if o.scalar("select exists(select 1 from pg_proc where oid='private.request_service_post_without_blocks(uuid,uuid,text)'::regprocedure and prosrc like '%assert_new_member_activity_allowed%')::text;") != 'true':
            raise RuntimeError('ACTIVITY_GATE_NOT_APPLIED')
        # 초기에 빈 FK-cascade 범위만 finally에서 정리한다. 기존 자료 복사·삭제 금지.
        roots = ','.join(literal(x) + '::regclass' for x in ROOTS)
        sql = "with recursive d(id)as(select unnest(array[" + roots + "]::oid[])union select c.conrelid from pg_constraint c join d on d.id=c.confrelid where c.contype='f')select format('%I.%I',n.nspname,c.relname)from d join pg_class c on c.oid=d.id join pg_namespace n on n.oid=c.relnamespace order by 1;"
        self.doomed = o.execute(sql)
        if not self.doomed or any(not re.fullmatch(r'(?:public|private|auth|storage)\.[a-z_][a-z0-9_]*', t) for t in self.doomed):
            raise RuntimeError('UNSAFE_FIXTURE_SCOPE')
        for table in self.doomed:
            if o.scalar('select count(*)from ' + table + ';') != '0':
                raise RuntimeError('SCRATCH_FIXTURE_SCOPE_NOT_EMPTY')
        self.bucket_created = o.scalar("select count(*)from storage.buckets where id='profile-images';") == '0'
        self.original_roles_hash = self.roles_hash(o)
        self.original_cleanup = self.cleanup_metadata(o)
        if self.original_cleanup['guard'] is not False:
            raise RuntimeError('CLEANUP_GUARD_MUST_BE_CLOSED')

    def roles_hash(self, s: Session) -> str:
        # 비밀번호/역할 원문을 내보내지 않고 글로벌 역할·멤버십 불변만 비교한다.
        return s.scalar("select md5(jsonb_build_array("
                        "(select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconfig)order by oid)from pg_roles),"
                        "(select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members))::text);")

    def cleanup_metadata(self, s: Session):
        signatures = ','.join(literal(x) + '::regprocedure' for x in CLEANUP)
        return json.loads(s.scalar("select jsonb_build_object('guard',(select external_deletion_approved from private.member_cleanup_guard where singleton),"
                         "'acl',(select jsonb_agg(jsonb_build_array(oid,proowner,proacl::text)order by oid)from pg_proc where oid in(" + signatures + ')))::text;'))

    def setup(self, o: Session):
        self.fixture_started = True
        o.execute('begin;')
        o.execute("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);"
                  "insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)values('profile-images','profile-images',false,5242880,array['image/jpeg'])on conflict(id)do nothing;")
        for n in range(1, 9):
            u = self.uid('user', n)
            email = 'synthetic-' + str(n) + '-' + self.namespace.hex + '@test.invalid'
            path = u + '/' + self.uid('image', n) + '.jpg'
            o.execute('insert into auth.users(id,email)values(' + literal(u) + ',' + literal(email) + ');'
                      'insert into auth.sessions(id,user_id)values(' + literal(self.uid('session', n)) + ',' + literal(u) + ');')
            if n != 5:
                subject = self.subjects[n]
                o.execute("insert into private.naver_accounts(subject,user_id,real_name,birth_date,gender,verification_status,completed_at)values(" +
                          ','.join([literal(subject), literal(u), literal('합성 경합 회원'), "'1990-01-01'", "'female'", "'qualified'", 'clock_timestamp()']) + ');')
            else:
                subject = self.subjects[4]  # 현재회차 재바인딩 전까지는 unused synthetic session.
            o.execute('insert into private.naver_sessions(session_id,user_id,subject)values(' +
                      ','.join(map(literal, [self.uid('session', n), u, subject])) + ');'
                      "insert into storage.objects(bucket_id,name,owner_id,metadata)values('profile-images'," + literal(path) + ',' + literal(u) + ",'" + '{"mimetype":"image/jpeg","size":128}' + "'::jsonb);"
                      'insert into public.profiles(id,real_name,birth_date,gender,avatar_url)values(' + literal(u) + ",'합성 경합 회원','1990-01-01','female'," + literal(path) + ');')
        # 복수 대상 actor-first 순서 검사용 실제 서비스 신청이다.
        self.actor(o, 7)
        o.execute(self.create(7, 700))
        o.execute('reset role;')
        self.actor(o, 6)
        r = json.loads(o.scalar('select public.request_service_post(' + literal(self.uid('post', 700)) + ',' + literal(self.uid('message', 700)) + ",'합성 복수 계정 신청')::text;"))
        self.request_id = r['id']
        o.execute('commit;reset role;')

    def run(self, o: Session, a: Session, b: Session):
        self.begin_actor(a, 1)
        a.execute('select public.get_my_profile();')
        before = self.snapshot(o, 1)
        b.execute('begin;')
        b.expected(self.decision(1, [1]), '40001')
        assert self.snapshot(o, 1) == before
        b.execute('rollback;')
        a.execute('commit;reset role;')
        b.execute('begin;' + self.decision(1, [1]) + 'commit;')
        self.begin_actor(a, 1)
        a.expected(self.create(1, 101), '42501')
        a.execute('rollback;reset role;')
        self.pass_case('shared_guard_owner_nowait_rollback_retry')

        # owner 판정이 실제 RPC의 회원 공유 가드를 막는지 observer로 확인한다.
        b.execute('begin;' + self.decision(2, [2]))
        self.begin_actor(a, 2)
        pending = self.pool.submit(a.expected, self.create(2, 102), '42501')
        self.wait_locked(o, a, pending)
        b.execute('commit;')
        pending.result(timeout=8)
        a.execute('rollback;reset role;')
        self.pass_case('owner_commit_new_activity_denied')

        b.execute('begin;' + self.decision(3, [3]))
        self.begin_actor(a, 3)
        pending = self.pool.submit(a.execute, 'do $$declare r jsonb;begin r:=(' + self.create(3, 103).removeprefix('select ').removesuffix(';') + ");assert r->>'alreadyCreated'='false';end;$$;")
        self.wait_locked(o, a, pending)
        b.execute('rollback;')
        pending.result(timeout=8)
        a.execute('rollback;reset role;')
        self.no_effect(o, 3)
        self.pass_case('owner_rollback_new_activity_allowed')

        b.execute('begin;' + self.decision(4, [4]) + 'commit;')
        o.execute('begin;select set_config(\'request.jwt.claims\',\'{"role":"service_role"}\',true);'
                  'update private.member_episodes set ended_at=clock_timestamp()where profile_id=' + literal(self.uid('user', 4)) + ' and ended_at is null;'
                  'update private.naver_accounts set user_id=' + literal(self.uid('user', 5)) + 'where subject=' + literal(self.subjects[4]) + ';commit;')
        self.begin_actor(a, 5)
        a.execute('select public.get_my_profile();')
        before = self.snapshot(o, 4)
        b.execute('begin;')
        b.expected(self.decision(4, [], 1, 'invalidated'), '40001')
        assert self.snapshot(o, 4) == before
        b.execute('rollback;')
        a.execute('commit;reset role;')
        b.execute('begin;' + self.decision(4, [], 1, 'invalidated') + 'commit;')
        self.begin_actor(a, 5)
        a.execute(self.create(5, 105))
        a.execute('rollback;reset role;')
        assert o.scalar('select private.current_member_sweetness(' + literal(self.uid('user', 5)) + ');') == '15'
        self.pass_case('old_episode_correction_locks_new_active_episode')

        # 계정7의actor 공유락, 계정6의판정 배타락을 교차시킨 뒤 실제 propose_match를 기다리게 한다.
        self.begin_actor(a, 7)
        a.execute('select public.get_my_profile();')
        b.execute('begin;select subject from private.naver_accounts where subject=' + literal(self.subjects[6]) + 'for update;')
        pending = self.pool.submit(a.execute, 'select public.propose_match(' + literal(self.request_id) + ');')
        self.wait_locked(o, a, pending)
        before = self.snapshot(o, 6)
        b.expected(self.decision(6, [6, 7]), '40001')
        assert self.snapshot(o, 6) == before
        b.execute('rollback;')
        pending.result(timeout=8)
        a.execute('rollback;reset role;')
        self.pass_case('multi_subject_actor_first_pair_conflict_no_deadlock')

        # 실행 flag 승인 시에만 한 DB transaction의 임시 ACL/guard를 준비한다. 절대 COMMIT하지 않는다.
        self.begin_actor(a, 8)
        a.execute('select public.get_my_profile();')
        b.execute('begin;' + ';'.join('grant execute on function ' + sig + ' to service_role' for sig in CLEANUP) + ';'
                  'update private.member_cleanup_guard set external_deletion_approved=true where singleton;')
        self.actor(b, 8)
        pending = self.pool.submit(b.execute, 'do $$declare r jsonb;begin r:=public.retire_my_account(' + literal(self.uid('withdrawal', 8)) + ");assert r->>'status'='processing';end;$$;")
        self.wait_locked(o, b, pending)
        a.execute('commit;reset role;')
        pending.result(timeout=8)
        # 같은 탈퇴 transaction이 current episode UPDATE를 보유할 때 판정은40001이어야 한다.
        o.execute('begin;')
        o.expected(self.decision(8, [8]), '40001')
        o.execute('rollback;')
        b.execute('rollback;reset role;')
        assert self.cleanup_metadata(o) == self.original_cleanup
        self.begin_actor(a, 8)
        a.execute(self.create(8, 108))
        a.execute('rollback;reset role;')
        self.no_effect(o, 8)
        self.pass_case('actual_retire_shared_guard_owner_conflict_rollback')

        # 반대 방향: 판정 COMMIT 뒤에도 제재 중 탈퇴를 허용한다. 탈퇴 자체는 rollback한다.
        a.execute('begin;' + self.decision(9, [8]))
        b.execute('begin;' + ';'.join('grant execute on function ' + sig + ' to service_role' for sig in CLEANUP) + ';'
                  'update private.member_cleanup_guard set external_deletion_approved=true where singleton;')
        self.actor(b, 8)
        pending = self.pool.submit(b.execute, 'do $$declare r jsonb;begin r:=public.retire_my_account(' + literal(self.uid('withdrawal', 9)) + ");assert r->>'status'='processing';end;$$;")
        self.wait_locked(o, b, pending)
        a.execute('commit;')
        pending.result(timeout=8)
        b.execute('rollback;reset role;')
        assert self.cleanup_metadata(o) == self.original_cleanup
        self.begin_actor(a, 8)
        a.expected(self.create(8, 109), '42501')
        a.execute('rollback;reset role;')
        self.pass_case('owner_commit_retire_allowed_restriction_preserved')


    def cleanup(self):
        # worker 연결 없이 모든 열린 SQL transaction을 닫고 owner 합성 fixture만 정리한다.
        self.pool.shutdown(wait=True, cancel_futures=True)
        for s in reversed(self.sessions):
            s.close()
        if not self.fixture_started:
            return {'fixtureStarted':False}
        o = self.session('cleanup')
        try:
            # fixture용 metadata bucket 삭제만 허용한다. Provider/API 삭제는 호출하지 않는다.
            o.execute("begin;set local storage.allow_delete_query='true';truncate table " + ','.join(ROOTS) + ' cascade;')
            if self.bucket_created:
                o.execute("delete from storage.buckets where id='profile-images';")
            o.execute('commit;')
            counts = {table:int(o.scalar('select count(*)from ' + table + ';')) for table in self.doomed}
            if any(counts.values()):
                raise AssertionError('FIXTURE_RESIDUAL_ROWS')
            if self.roles_hash(o) != self.original_roles_hash:
                raise AssertionError('GLOBAL_ROLES_CHANGED')
            active = int(o.scalar('select count(*)from pg_stat_activity where datname=current_database() and application_name like ' + literal('sanction-race-' + self.namespace.hex[:10] + '-%') + ' and pid<>pg_backend_pid();'))
            if active:
                raise AssertionError('OWNED_SESSION_RESIDUAL_HANDLES')
            current = self.cleanup_metadata(o)
            if current != self.original_cleanup:
                raise AssertionError('CLEANUP_GUARD_OR_ACL_CHANGED')
            return {'fixtureStarted':True, 'residualCounts':counts, 'cleanupGuardAndAclUnchanged':True, 'globalRolesUnchanged':True}
        finally:
            o.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--artifact-dir', required=True)
    parser.add_argument('--execute', action='store_true', help='root START 이후에만 실제 합성 DB 연결')
    parser.add_argument('--allow-transactional-retire-setup', action='store_true', help='retire probe transaction의 임시5RPC ACL/guard 후 반드시 rollback')
    args = parser.parse_args()
    if not re.fullmatch(r'yumidang_(?:sanction|activity)_[a-z0-9_]{1,40}', args.database):
        parser.error('approved independent sanction/activity scratch database only')
    artifact = Path(args.artifact_dir)
    if not artifact.is_absolute() or not str(artifact).startswith('/private/tmp/') or artifact.is_symlink():
        parser.error('private /private/tmp artifact directory required')
    if not args.execute:
        print('NOT_RUN: root START and --execute required')
        return 0
    if not args.allow_transactional_retire_setup:
        parser.error('actual retire case requires reviewed --allow-transactional-retire-setup')
    if not artifact.parent.is_dir() or not artifact.resolve().is_relative_to(Path('/private/tmp').resolve()):
        parser.error('existing private /private/tmp parent required; symlink redirection forbidden')
    if artifact.parent.stat().st_mode & 0o077:
        parser.error('artifact parent must already be private (0700)')
    artifact.mkdir(mode=0o700, exist_ok=False)
    h = Harness(args.database, artifact)
    receipt = {'sourceSHA256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'database':args.database,
               'container':CONTAINER, 'globalRolesChanged':False, 'status':'RUNNING'}
    failed = None
    try:
        o, a, b = h.session('observer'), h.session('actor'), h.session('owner')
        h.preflight(o)
        h.setup(o)
        h.run(o, a, b)
        receipt['status'] = 'PASS'
    except Exception as error:
        failed = error
        receipt['status'] = 'FAIL'
        receipt['failureClass'] = type(error).__name__
        if re.fullmatch('[A-Z_]{1,100}', str(error)):
            receipt['failureCode'] = str(error)
    finally:
        try:
            receipt['cleanup'] = h.cleanup()
        except Exception as error:
            failed = failed or error
            receipt['status'] = 'FAIL'
            receipt['cleanupFailureClass'] = type(error).__name__
        receipt['cases'] = h.results
        p = artifact / 'receipt.json'
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(receipt, out, ensure_ascii=False, indent=2)
    print(receipt['status'] + ': ' + str(artifact / 'receipt.json'))
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
