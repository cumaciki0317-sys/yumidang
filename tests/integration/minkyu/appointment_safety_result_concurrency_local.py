"""민규: 승인된 isolated native65의 약속 자동 원장↔owner 행 잠금 두 세션 SQL 회귀 후보.

--native65-approved 없이는 연결하지 않는다. 키/Provider/HTTP/운영 판정 액터를 만들지 않는다.
owner 합성 revision은 경쟁 fixture이며 실제 담당 권한 배정의 증명이 아니다. 실행 승인은 별도다.
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
MANIFEST = Path('/private/tmp/yumidang-policy65-reviewed-e0hpsl74/prepared/migration-manifest.json')
MANIFEST_SHA = '2303e3ae6507bfad1859d012ae16b96814563a5ceb2001c44591d116515e5ee6'
EDGE_SHA = '003deb8f7931a9d9c2cd6f9afdaf20a242fdd39a90b50d227cde965248a5650d'
SYNC_SQL_SHA = 'afc727a109454d430ab2b39b7d8000c2f7f49638c4351200454827c8a2c1ab80'
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
    parser.add_argument('--native65-approved', action='store_true')
    parser.add_argument('--docker-host', required=True)
    parser.add_argument('--container', required=True)
    parser.add_argument('--database', required=True)
    parser.add_argument('--api-url', required=True)
    parser.add_argument('--db-port', required=True, type=int)
    args = parser.parse_args()
    require(args.native65_approved and args.docker_host == HOST and args.container == CONTAINER
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
    require(manifest['status'] == 'READY' and manifest['count'] == 65
            and manifest['mode'] == 'current_policy_gateway' and manifest['sql_execution'] == 'NOT_RUN'
            and len(manifest['migrations']) == 65, 'MANIFEST_CONTRACT_INVALID')
    versions = []
    for item in manifest['migrations']:
        require(re.fullmatch(r'backend/supabase/migrations/\d{14}_[a-z0-9_]+\.sql', item['path'])
                and re.fullmatch(r'\d{14}', item['version'])
                and Path(item['path']).name.startswith(item['version'] + '_'), 'SQL_PATH_INVALID')
        path = SOURCE / item['path']
        require(not path.is_symlink() and path.is_file()
                and hashlib.sha256(path.read_bytes()).hexdigest() == item['sha256'], 'SQL_BYTES_MISMATCH')
        prepared_sql = MANIFEST.parent / 'supabase/migrations' / path.name
        require(not prepared_sql.is_symlink() and prepared_sql.is_file()
                and hashlib.sha256(prepared_sql.read_bytes()).hexdigest() == item['sha256'], 'PREPARED_SQL_BYTES_MISMATCH')
        versions.append(item['version'])
    versions.sort()
    require(len(set(versions)) == 65 and versions[-5:] == ['20261005040300', '20261005040500', '20261005040600', '20261005040700', '20261005040800'], 'VERSION_SET_INVALID')
    edge_path = MANIFEST.parent / 'edge-manifest.json'
    require(not edge_path.is_symlink() and edge_path.is_file(), 'EDGE_MANIFEST_INVALID')
    edge_raw = edge_path.read_bytes()
    require(hashlib.sha256(edge_raw).hexdigest() == EDGE_SHA, 'EDGE_MANIFEST_HASH_INVALID')
    edge = json.loads(edge_raw)
    require(edge['migration_count'] == 65 and edge['sql_execution'] == 'NOT_RUN'
            and edge['edge_execution'] == 'NOT_RUN' and len(edge['source_files']) == 49,
            'EDGE_SOURCE_SCOPE_INVALID')
    for item in edge['source_files']:
        require((re.fullmatch(r'backend/supabase/functions/[A-Za-z0-9_./-]+\.ts', item['path'])
                 or item['path']=='backend/supabase/functions/deno.json')
                and '..' not in Path(item['path']).parts and item['target']==item['path'][len('backend/'):]
                and re.fullmatch(r'[a-f0-9]{64}', item['sha256']),
                'SOURCE_PATH_INVALID')
        for path in [SOURCE / item['path'], MANIFEST.parent / item['target']]:
            require(not path.is_symlink() and path.is_file()
                    and hashlib.sha256(path.read_bytes()).hexdigest() == item['sha256'], 'SOURCE_BYTES_MISMATCH')
    require(next(item['sha256'] for item in manifest['migrations'] if item['version'] == '20261005040800') == SYNC_SQL_SHA,
            'REVIEWED_SYNC_SQL_HASH_INVALID')
    command = ['docker', '--host', HOST, 'exec', '-i', CONTAINER, 'psql', '-XqAt', '-U', 'postgres',
               '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']
    lock_evidence = []
    namespace = uuid.uuid4().hex[:12]
    processes, fixture_ids, fixture_subjects, fixture_posts, fixture_sessions, fixture_photos, results = [], [], [], [], [], [], []
    artifact = Path(tempfile.mkdtemp(prefix='yumidang-safety-result-race65-'))
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
    baseline_counts = None
    failure = None
    failure_phase = None
    cleanup_ok = False
    owner_queries = 0
    current_phase = 'preflight'
    query_diagnostics = []
    bucket_created = False

    def run(sql, phase=None):
        nonlocal owner_queries
        owner_queries += 1
        entry = {'number':owner_queries,'phase':phase or current_phase,'status':'RUNNING',
                 'processTimeoutSeconds':30,'sqlStatementTimeoutSeconds':10,'sqlLockTimeoutSeconds':8}
        query_diagnostics.append(entry)
        private_json(artifact / 'owner-query-progress.json', {'queries':query_diagnostics})
        started = time.monotonic()
        try:
            p = subprocess.run(command, input="set statement_timeout='10s';set lock_timeout='8s';" + sql,
                               text=True, capture_output=True, timeout=30)
        except subprocess.TimeoutExpired:
            entry.update(status='TIMEOUT',durationSeconds=round(time.monotonic()-started,6))
            private_json(artifact / 'owner-query-progress.json', {'queries':query_diagnostics})
            # 부분 stdout/stderr와 SQL 원문은 진단 영수증에 복제하지 않는다.
            raise ProbeFailure('OWNER_QUERY_TIMEOUT') from None
        except Exception:
            entry.update(status='PROCESS_ERROR',durationSeconds=round(time.monotonic()-started,6))
            private_json(artifact / 'owner-query-progress.json', {'queries':query_diagnostics})
            raise
        entry.update(status='PASS' if p.returncode==0 else 'FAIL',
                     durationSeconds=round(time.monotonic()-started,6),exitCode=p.returncode,
                     sqlStates=re.findall(r'ERROR:\s+([A-Z0-9]{5}):',p.stderr))
        private_json(artifact / 'owner-query-progress.json', {'queries':query_diagnostics})
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
        # 같은 실제 테이블 목록을 유지하되 Docker/psql 왕복은 목록+집계의 두 번뿐이다.
        relations = json.loads(run("select jsonb_agg(format('%I.%I',n.nspname,c.relname) order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage') and c.relkind='r';",current_phase+'.counts.list')) or []
        if not relations:
            return {}
        selects = ["select " + literal(name) + " as name,count(*)::text as n from " + name for name in relations]
        result = json.loads(run("select jsonb_object_agg(name,n)from(" + " union all ".join(selects) + ")all_counts;",current_phase+'.counts.aggregate'))
        require(set(result)==set(relations) and all(isinstance(value,str) and value.isdecimal() for value in result.values()),
                'RELATION_COUNTS_SHAPE_MISMATCH')
        return result

    class Session:
        def __init__(self):
            self.p = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True, bufsize=1)
            processes.append(self)
            self.lines, self.errors, self.messages = queue.Queue(), [], []
            self.stderr_path = artifact / ('session-' + str(len(processes)) + '.stderr')
            self.stderr_stream = self.stderr_path.open('w')
            self.stderr_path.chmod(0o600)
            def read_stdout():
                for line in self.p.stdout:
                    self.lines.put(line.strip())
            def read_stderr():
                for line in self.p.stderr:
                    self.stderr_stream.write(line); self.stderr_stream.flush()
                    match = re.search(r'ERROR:\s+([A-Z0-9]{5}):\s*(.*)', line)
                    if match:
                        self.errors.append(match.group(1)); self.messages.append(match.group(2))
            self.reader = threading.Thread(target=read_stdout, daemon=True)
            self.error_reader = threading.Thread(target=read_stderr, daemon=True)
            self.reader.start(); self.error_reader.start()
            self.write("select 'PID:'||pg_backend_pid();")
            self.pid = int(self.wait('PID:', prefix=True)[4:])
            self.write("select set_config('application_name'," + literal('safety-sync-race65-' + namespace + '-' + str(len(processes))) + ",false);")
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
                    (code != 0 and self.errors == [expected] and self.messages == ['appointment_safety_result_conflict']), 'SESSION_OUTCOME_MISMATCH')
            self.stderr_stream.close()

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
            self.reader.join(timeout=2); self.error_reader.join(timeout=2)
            require(not self.reader.is_alive() and not self.error_reader.is_alive(), 'SESSION_READER_REMAINS')
            if not self.stderr_stream.closed:
                self.stderr_stream.close()

    def held_row(holder, member, identity, appointment):
        holder.write("select identity_id from private.safety_appointment_results where identity_id=" + literal(identity)
                     + " and appointment_id=" + literal(appointment) + " for update;"
                     + "select 'OWNER_HELD:'||pg_current_xact_id()::text;")
        xid = holder.wait('OWNER_HELD:', prefix=True).split(':', 1)[1]
        # 같은 행의 NOWAIT 실패를 별도 세션에서 확인한다. 대기 PID 부재는 증거로 사용하지 않는다.
        member.write("do $$declare got text;begin begin perform 1 from private.safety_appointment_results where identity_id="
                     + literal(identity) + " and appointment_id=" + literal(appointment)
                     + " for update nowait;exception when others then get stacked diagnostics got=returned_sqlstate;end;"
                     + "assert got='55P03','owner row is actually held';end;$$;select 'ROW_HELD_PROVED';")
        member.wait('ROW_HELD_PROVED')
        state = json.loads(run("select jsonb_build_object('holderPid',pid,'state',state,'backendXid',backend_xid::text)"
                             + " from pg_stat_activity where pid=" + str(holder.pid) + ";"))
        require(state['holderPid'] == holder.pid and state['state'] == 'idle in transaction'
                and state['backendXid'] is not None, 'OWNER_TRANSACTION_NOT_HELD')
        evidence = {'holderPid':holder.pid,'memberPid':member.pid,'ownerXid':xid,
                    'backendXid':state['backendXid'],'heldRowSqlState':'55P03'}
        lock_evidence.append(evidence)
        return evidence

    def actor(uid):
        session = fixture_sessions[fixture_ids.index(uid)]
        claims = json.dumps({'sub':uid,'role':'authenticated','session_id':session,'is_anonymous':False})
        return "set local role authenticated;select set_config('request.jwt.claims'," + literal(claims) + ",true);"

    def record_recovery():
        private_json(recovery, {'scope':'isolated_native65_sql_metadata_only','fixtureIds':fixture_ids,
                               'fixtureSubjects':fixture_subjects,'fixturePosts':fixture_posts,
                               'fixtureSessions':fixture_sessions,'fixturePhotos':fixture_photos,
                               'bucketCreated':bucket_created,'manifestSha256':MANIFEST_SHA,'namespace':namespace})

    def fixture_members():
        nonlocal bucket_created
        bucket_created = run("select exists(select 1 from storage.buckets where id='profile-images');") == 'f'
        for _ in range(2):
            uid, session, subject, image = str(uuid.uuid4()), str(uuid.uuid4()), 'safety-result-race-'+str(uuid.uuid4()), str(uuid.uuid4())
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
        return run("select jsonb_build_object('post',to_jsonb(p),'appointment',to_jsonb(a),"
          "'location',(select to_jsonb(l)from private.post_search_locations l where post_id=p.id),"
          "'details',(select to_jsonb(d)from public.post_private_details d where post_id=p.id),"
          "'reservation',(select to_jsonb(r)from private.completion_reservations r where appointment_id=a.id),"
          "'cancellation',(select to_jsonb(c)from private.appointment_cancellations c where appointment_id=a.id),"
          "'requests',(select jsonb_agg(to_jsonb(j)order by j.id)from public.join_requests j where j.post_id=p.id),"
          "'consents',(select jsonb_agg(to_jsonb(c)order by c.request_id)from private.match_consents c join public.join_requests j on j.id=c.request_id where j.post_id=p.id),"
          "'changes',(select jsonb_agg(to_jsonb(c)order by c.change_id)from private.appointment_schedule_changes c where c.appointment_id=a.id),"
          "'events',(select jsonb_agg(to_jsonb(e)order by e.event_key,e.request_id,e.kind)from private.match_lifecycle_events e join public.join_requests j on j.id=e.request_id where j.post_id=p.id),"
          "'notices',(select jsonb_agg(to_jsonb(n)order by n.id)from public.notifications n join public.join_requests j on j.id=n.join_request_id where j.post_id=p.id),"
          "'heads',(select jsonb_agg(to_jsonb(h)order by h.identity_id)from private.safety_appointment_results h where h.appointment_id=a.id),"
          "'revisions',(select jsonb_agg(to_jsonb(r)order by r.identity_id,r.revision)from private.safety_appointment_result_revisions r where r.appointment_id=a.id))"
          " from public.posts p join public.appointments a on a.post_id=p.id where p.id="+literal(case['post'])+" and a.id="+literal(case['appointment'])+";")

    def cancellation(session, case, cancellation_id, commit=False):
        session.write(actor(fixture_ids[0])+"select public.cancel_appointment("+literal(case['appointment'])+","+
                      literal(cancellation_id)+",'합성 원장 경합 취소');"+
                      (("commit;" if commit else "")+"select 'CANCEL_READY';"))

    def finish_holder(session, commit=True):
        session.write(("commit;" if commit else "rollback;")+"select 'DONE';")
        session.wait('DONE'); session.finish()

    def identity(case, author=False):
        return run("select h.identity_id from private.safety_appointment_results h join private.member_episodes e on e.id=h.source_episode_id"
                   + " where h.appointment_id=" + literal(case['appointment'])
                   + (" and e.profile_id="+literal(fixture_ids[0]) if author else " order by h.identity_id desc limit 1") + ";")

    def operator_pending(session, case, key):
        # 기존 owner 권한으로 합성 revision만 추가한다. 실제 담당 ACL/판정 API의 증거로 사용하지 않는다.
        session.write("with inserted as (insert into private.safety_appointment_result_revisions(identity_id,appointment_id,revision,decision_id,outcome,cancellation_at,appeal_state,reason_code,origin)"
          + " select identity_id,appointment_id,current_revision+1,gen_random_uuid(),'pending',null,'none','appointment_state_sync','operator'"
          + " from private.safety_appointment_results where identity_id="+literal(key)+" and appointment_id="+literal(case['appointment'])
          + " returning identity_id,appointment_id,revision)update private.safety_appointment_results h set current_revision=i.revision from inserted i"
          + " where h.identity_id=i.identity_id and h.appointment_id=i.appointment_id;select 'OPERATOR_PENDING_READY';")
        session.wait('OPERATOR_PENDING_READY')

    def verify_cancel(case, cancellation_id, protected=None, protected_snapshot=None):
        after=json.loads(snapshot(case)); before=json.loads(case['before'])
        require(after['post']==before['post'] and after['location']==before['location'] and after['details']==before['details'], 'CANCEL_CHANGED_POST_OR_LOCATION')
        require(after['appointment']['status']=='cancelled' and after['reservation'] is None
                and after['cancellation']['cancellation_id']==cancellation_id, 'CANCEL_STATE_MISMATCH')
        require(after['changes'][0]['status']=='cancelled' and after['changes'][0]['new_location_input'] is None, 'CHANGE_NOT_CLOSED')
        require(len(after['heads'])==2 and len(after['revisions'])==4
                and all(h['current_revision']==2 for h in after['heads']), 'TWO_HEADS_AND_EXACT_REVISIONS_REQUIRED')
        current=[]
        for head in after['heads']:
            matching=[r for r in after['revisions'] if r['identity_id']==head['identity_id'] and r['revision']==head['current_revision']]
            require(len(matching)==1, 'POINTER_REVISION_MISMATCH'); current.append(matching[0])
        author_key=identity(case,author=True)
        for row in current:
            if row['identity_id']==protected:
                require(row==protected_snapshot and row['origin']=='operator' and row['outcome']=='pending','OPERATOR_REVISION_NOT_PRESERVED')
            else:
                own=row['identity_id']==author_key
                require(row['origin']=='appointment' and row['outcome']==('own_cancel' if own else 'peer_cancel')
                        and row['cancellation_at']==(after['cancellation']['cancelled_at'] if own else None), 'AUTOMATIC_OUTCOME_MISMATCH')
        # 양쪽의 변경 종료·취소 알림/이벤트가 중복되지 않는지 확인한다.
        for kind,key in [('appointment_schedule_change_ended',case['version']),('appointment_cancelled',cancellation_id)]:
            require(sum(e['kind']==kind and e['event_key']==key for e in after['events'])==1,'LIFECYCLE_EVENT_DUPLICATED')
            require(sum(n['kind']==kind for n in after['notices'])==2,'LIFECYCLE_NOTICE_DUPLICATED')
        stable = snapshot(case)
        run("begin;"+actor(fixture_ids[0])+"do $$declare response jsonb;begin response:=public.cancel_appointment("
            +literal(case['appointment'])+","+literal(cancellation_id)+",'합성 원장 경합 취소');"
            +"assert response->>'deduplicated'='true','successful cancellation retry deduplicated';end;$$;commit;")
        require(snapshot(case)==stable,'SUCCESS_CANCEL_RETRY_CHANGED_SNAPSHOT')
        return after

    try:
        info = json.loads(subprocess.run(['docker','--host',HOST,'inspect',CONTAINER],capture_output=True,text=True,check=True,timeout=10).stdout)
        require(len(info) == 1 and info[0]['Name'] == '/' + CONTAINER and info[0]['State']['Running']
                and info[0]['Config']['Labels']['com.supabase.cli.project'] == 'yumidang-minkyu-drift'
                and any(p['HostPort']=='56532' for p in info[0]['HostConfig']['PortBindings']['5432/tcp']), 'CONTAINER_SCOPE_INVALID')
        current_phase = 'preflight_catalog'
        baseline = catalog(); state = json.loads(baseline)
        require(state['history']==versions and state['guard'] is False and state['idle'] is True, 'NATIVE65_BASELINE_INVALID')
        current_phase = 'preflight_acl'
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
        current_phase = 'preflight_counts'
        baseline_counts = counts()
        require(files()==0,'STORAGE_BACKEND_NOT_EMPTY')
        require(all(baseline_counts[r]=='0' for r in ['auth.users','storage.objects','public.profiles','public.posts','public.appointments','private.member_retirements']), 'APPLICATION_NOT_EMPTY')
        current_phase = 'fixture_members'
        fixture_members()
        # 뒤 identity 행을 잡아 앞 행의 append/pointer까지 예외로 되돌아가는지 확인한다.
        current_phase = 'case1_lock_rollback'
        case=fixture_case(3);cid=str(uuid.uuid4());holder,member=Session(),Session()
        held_row(holder,member,identity(case),case['appointment'])
        started=time.monotonic();cancellation(member,case,cid);member.finish('40001')
        lock_evidence[-1]['memberFailureSeconds']=round(time.monotonic()-started,6)
        require(snapshot(case)==case['before'],'NOWAIT_CANCEL_ALL_EFFECTS_NOT_ROLLED_BACK')
        finish_holder(holder,False)
        retry=Session();cancellation(retry,case,cid,True);retry.wait('CANCEL_READY');retry.finish()
        verify_cancel(case,cid);results.append('last_identity_owner_lock_40001_all_effects_rollback_then_cancel')

        current_phase = 'case2_operator_commit'
        case=fixture_case(6);cid=str(uuid.uuid4());holder,member=Session(),Session();key=identity(case,author=True)
        held_row(holder,member,key,case['appointment']);operator_pending(holder,case,key)
        cancellation(member,case,cid);member.finish('40001')
        require(snapshot(case)==case['before'],'PENDING_OWNER_CANCEL_ALL_EFFECTS_NOT_ROLLED_BACK')
        finish_holder(holder,True)
        committed=json.loads(snapshot(case));protected=[r for r in committed['revisions'] if r['identity_id']==key and r['origin']=='operator']
        require(len(protected)==1,'OPERATOR_COMMIT_MISSING')
        retry=Session();cancellation(retry,case,cid,True);retry.wait('CANCEL_READY');retry.finish()
        verify_cancel(case,cid,key,protected[0]);results.append('owner_pending_commit_preserved_peer_cancel_registered')

        current_phase = 'case3_operator_rollback'
        case=fixture_case(9);cid=str(uuid.uuid4());holder,member=Session(),Session();key=identity(case,author=True)
        held_row(holder,member,key,case['appointment']);operator_pending(holder,case,key)
        cancellation(member,case,cid);member.finish('40001')
        require(snapshot(case)==case['before'],'UNCOMMITTED_OWNER_CANCEL_EFFECTS_NOT_ROLLED_BACK')
        finish_holder(holder,False)
        require(snapshot(case)==case['before'],'OWNER_ROLLBACK_REVISION_POINTER_NOT_RESTORED')
        retry=Session();cancellation(retry,case,cid,True);retry.wait('CANCEL_READY');retry.finish()
        verify_cancel(case,cid);results.append('owner_revision_rollback_then_own_peer_cancel_success')
    except Exception as error:
        failure_phase = current_phase
        failure = str(error) if isinstance(error, ProbeFailure) else 'PROBE_INFRASTRUCTURE_FAILED'
    finally:
        current_phase = 'finally_cleanup'
        for session in processes:
            try:
                session.stop()
            except Exception:
                failure = failure or 'SESSION_STOP_FAILED'
        try:
            if fixture_ids and baseline is not None and baseline_counts is not None:
                ids = ','.join(literal(v) for v in fixture_ids); subjects = ','.join(literal(v) for v in fixture_subjects)
                posts = ','.join(literal(v) for v in fixture_posts)
                commands = "begin;set local storage.allow_delete_query='true';"
                if posts:
                    commands += f"delete from private.safety_appointment_result_revisions where appointment_id in(select id from public.appointments where post_id in({posts}));"
                    commands += f"delete from private.safety_appointment_results where appointment_id in(select id from public.appointments where post_id in({posts}));"
                    commands += f"delete from public.appointments where post_id in({posts});delete from public.posts where id in({posts});"
                commands += f"delete from public.profiles where id in({ids});delete from private.member_episodes where profile_id in({ids});delete from private.naver_sessions where user_id in({ids});delete from private.naver_identity_keys where subject in({subjects});delete from private.naver_accounts where subject in({subjects});"
                commands += "delete from storage.objects where bucket_id='profile-images' and name in("+', '.join(literal(v) for v in fixture_photos)+");"
                commands += f"delete from auth.users where id in({ids});"
                if bucket_created:
                    commands += "delete from storage.buckets where id='profile-images';"
                run(commands+'commit;', 'finally_cleanup.fixtures')

            current_phase = 'finally_verify'
            require(baseline is not None and baseline_counts is not None and catalog()==baseline, 'CATALOG_NOT_RESTORED')
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
               'manifestSha256':MANIFEST_SHA,'edgeManifestSha256':EDGE_SHA,'lockEvidence':lock_evidence,
               'lastPhase':current_phase,'failurePhase':failure_phase,'ownerQueries':query_diagnostics,
               'timeoutCauseEstablished':False,'ownerProcessTimeoutSeconds':30,
               'scope':'isolated_native65_owner_and_authenticated_sql_rpc',
               'ownerFixtureIsOperatorAuthorizationProof':False,'blockingPidAbsenceUsedAsProof':False,
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
