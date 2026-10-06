"""민규: 승인된 isolated native66의 명시 검토 진입↔회원 완료/예약 실행 두 세션 SQL 회귀 후보.

--native66-approved 없이는 연결하지 않는다. 키/Provider/HTTP/운영 판정 액터를 만들지 않는다.
owner 검토는 구조화 SQL 경합 fixture이며 실제 담당 권한 배정의 증명이 아니다. 실행 승인은 별도다.
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
MANIFEST = Path('/private/tmp/yumidang-policy66-agent-reviewed/prepared/migration-manifest.json')
MANIFEST_SHA = '91b896b355e8e919f38ae216b24dfcc514becb6eb7992d8c27cde8f82882972b'
EDGE_SHA = '69a6538a5a4ac8232c8d6e036c94288cc0d0d69431cbe0a285c890d2e645aa25'
HOLD_SQL_SHA = 'b13e5ade5891e49b049a7243ba3cbe161d8e64545212bc72d8865638a6992fe6'
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
    parser.add_argument('--native66-approved', action='store_true')
    parser.add_argument('--docker-host', required=True)
    parser.add_argument('--container', required=True)
    parser.add_argument('--database', required=True)
    parser.add_argument('--api-url', required=True)
    parser.add_argument('--db-port', required=True, type=int)
    args = parser.parse_args()
    require(args.native66_approved and args.docker_host == HOST and args.container == CONTAINER
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
    require(manifest['status'] == 'READY' and manifest['count'] == 66
            and manifest['mode'] == 'current_policy_gateway' and manifest['sql_execution'] == 'NOT_RUN'
            and len(manifest['migrations']) == 66, 'MANIFEST_CONTRACT_INVALID')
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
    require(len(set(versions)) == 66 and versions[-6:] == ['20261005040300', '20261005040500', '20261005040600', '20261005040700', '20261005040800', '20261005040900'], 'VERSION_SET_INVALID')
    edge_path = MANIFEST.parent / 'edge-manifest.json'
    require(not edge_path.is_symlink() and edge_path.is_file(), 'EDGE_MANIFEST_INVALID')
    edge_raw = edge_path.read_bytes()
    require(hashlib.sha256(edge_raw).hexdigest() == EDGE_SHA, 'EDGE_MANIFEST_HASH_INVALID')
    edge = json.loads(edge_raw)
    require(edge['migration_count'] == 66 and edge['sql_execution'] == 'NOT_RUN'
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
    require(next(item['sha256'] for item in manifest['migrations'] if item['version']=='20261005040900')==HOLD_SQL_SHA, 'REVIEWED_HOLD_SQL_HASH_INVALID')
    command = ['docker', '--host', HOST, 'exec', '-i', CONTAINER, 'psql', '-XqAt', '-U', 'postgres',
               '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']
    lock_evidence = []
    namespace = uuid.uuid4().hex[:12]
    processes, fixture_ids, fixture_subjects, fixture_posts, fixture_sessions, fixture_photos, results = [], [], [], [], [], [], []
    artifact = Path(tempfile.mkdtemp(prefix='yumidang-review-hold-race66-'))
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
    protected_baseline = None
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
          'acls',(select jsonb_agg(jsonb_build_array(p.oid,p.oid::regprocedure::text,pg_get_userbyid(p.proowner),p.proacl::text,p.proconfig::text,case when p.prokind in('f','p')then md5(pg_get_functiondef(p.oid))else null end) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private','auth','storage')),
          'constraints',(select jsonb_agg(jsonb_build_array(c.oid,c.conrelid::regclass::text,c.conname,pg_get_constraintdef(c.oid),c.convalidated)order by c.oid)from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in('public','private','auth','storage')),
          'tableAcl',(select jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl::text)order by c.oid)from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')),
          'syncAudit',(select coalesce(jsonb_agg(to_jsonb(a)order by migration_version),'[]')from private.appointment_safety_sync_audit a),
          'columnAcls',(select jsonb_agg(jsonb_build_array(a.attrelid,a.attnum,a.attacl::text)order by a.attrelid,a.attnum)from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')and a.attnum>0 and not a.attisdropped),
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
                    match = re.search(r'ERROR:\s+([A-Z0-9]{5}):\s*(.*)', line)
                    if match:
                        self.errors.append(match.group(1)); self.messages.append(match.group(2))
                        self.stderr_stream.write(match.group(1)+'\n'); self.stderr_stream.flush()
            self.reader = threading.Thread(target=read_stdout, daemon=True)
            self.error_reader = threading.Thread(target=read_stderr, daemon=True)
            self.reader.start(); self.error_reader.start()
            self.write("select 'PID:'||pg_backend_pid();")
            self.pid = int(self.wait('PID:', prefix=True)[4:])
            self.write("select set_config('application_name'," + literal('review-hold-race66-' + namespace + '-' + str(len(processes))) + ",false);")
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

    def protected_containers():
        # 56521 원본과 다른 컨테이너를 읽기 metadata로만 비교한다. 환경/키는 수집하지 않는다.
        listing = subprocess.run(['docker','--host',HOST,'ps','-aq'],capture_output=True,text=True,timeout=10)
        require(listing.returncode==0,'CONTAINER_LIST_FAILED')
        identifiers=listing.stdout.split()
        require(identifiers,'CONTAINER_LIST_EMPTY')
        template='{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}}}'
        inspected=subprocess.run(['docker','--host',HOST,'inspect','--format',template,*identifiers],capture_output=True,text=True,timeout=10)
        require(inspected.returncode==0,'PROTECTED_CONTAINER_INSPECT_FAILED')
        rows=[json.loads(line)for line in inspected.stdout.splitlines()if line.strip()]
        require(len(rows)==len(identifiers),'PROTECTED_CONTAINER_METADATA_INVALID')
        return sorted(rows,key=lambda row:row['name'])

    def blocked_on_appointment(holder, participant):
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            proof=json.loads(run("select jsonb_build_object('blockedByOwner',"+str(holder.pid)+
              "=any(pg_blocking_pids("+str(participant.pid)+")),"
              "'ownerTransactionActive',exists(select 1 from pg_stat_activity where pid="+str(holder.pid)+
              " and state='idle in transaction' and backend_xid is not null),"
              "'memberLockWait',exists(select 1 from pg_stat_activity where pid="+str(participant.pid)+
              " and state='active' and wait_event_type='Lock' and xact_start is not null));",'barrier.blocking'))
            if all(proof.values()):
                lock_evidence.append(proof)
                return
            require(participant.p.poll()is None,'MEMBER_FINISHED_BEFORE_BARRIER')
            time.sleep(.05)
        raise ProbeFailure('BLOCKING_PID_BARRIER_TIMEOUT')

    def actor(uid):
        session = fixture_sessions[fixture_ids.index(uid)]
        claims = json.dumps({'sub':uid,'role':'authenticated','session_id':session,'is_anonymous':False})
        return "set local role authenticated;select set_config('request.jwt.claims'," + literal(claims) + ",true);"

    def record_recovery():
        private_json(recovery, {'scope':'isolated_native66_sql_metadata_only','fixtureIds':fixture_ids,
                               'fixtureSubjects':fixture_subjects,'fixturePosts':fixture_posts,
                               'fixtureSessions':fixture_sessions,'fixturePhotos':fixture_photos,
                               'bucketCreated':bucket_created,'manifestSha256':MANIFEST_SHA,'namespace':namespace})

    def fixture_members():
        nonlocal bucket_created
        bucket_created = run("select exists(select 1 from storage.buckets where id='profile-images');") == 'f'
        for _ in range(2):
            uid, session, subject, image = str(uuid.uuid4()), str(uuid.uuid4()), 'review-hold-race-'+str(uuid.uuid4()), str(uuid.uuid4())
            fixture_ids.append(uid); fixture_sessions.append(session); fixture_subjects.append(subject)
            photo = uid+'/'+image+'.jpg';fixture_photos.append(photo);record_recovery()
            run("begin;insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('profile-images','profile-images',false,2097152,array['image/jpeg']) on conflict(id) do nothing;"+
                "set local role service_role;select public.resolve_naver_account("+literal(subject)+",'합성 경합','F','1990-01-01');reset role;"+
                f"insert into auth.users(id,email) select '{uid}',auth_email from private.naver_accounts where subject={literal(subject)};"+
                f"insert into auth.sessions(id,user_id) values('{session}','{uid}');"+
                f"insert into storage.objects(id,bucket_id,name,owner_id,metadata) values('{image}','profile-images',{literal(photo)},'{uid}',{literal(json.dumps({'mimetype':'image/jpeg','size':128}))});"+
                "set local role service_role;select public.record_naver_session("+literal(subject)+f",'{uid}','{session}');reset role;"+
                actor(uid)+"select public.complete_naver_signup("+literal(photo)+",'{}','{}',null);commit;")

    def fixture_case(offset, elapsed=False):
        post=str(uuid.uuid4());fixture_posts.append(post);record_recovery()
        # 공고/신청/확정/신고/첫 개인 완료는 실제 회원 SQL RPC다.
        output=run("begin;create temp table probe(data jsonb);grant all on probe to authenticated;"+
          actor(fixture_ids[0])+"select public.create_service_post("+literal(post)+",jsonb_build_object('title','합성 검토 경합','description','격리 SQL 회귀','category','산책','startsAt',clock_timestamp()+interval '"+str(offset)+" days','endsAt',clock_timestamp()+interval '"+str(offset)+" days 2 hours','recruitmentEndsAt',clock_timestamp()+interval '1 day','publicArea','서울특별시 강남구 역삼동','registeredPlaceName','가상 검토 장소','registeredAddress','서울특별시 강남구 가상주소','meetingDetail','합성 입구','preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0));"+
          actor(fixture_ids[1])+"insert into probe values(public.request_service_post("+literal(post)+",gen_random_uuid(),'합성 신청'));"+
          actor(fixture_ids[0])+"insert into probe values(public.propose_match((select(data->>'id')::uuid from probe where data?'id')));"+
          actor(fixture_ids[1])+"insert into probe values(public.accept_match((select(data->>'id')::uuid from probe where data?'id'),(select data->>'conditionVersion'from probe where data?'conditionVersion')));reset role;"+
          "update public.posts set starts_at=clock_timestamp()-interval '3 days',ends_at=clock_timestamp()-interval '"+('2 days'if elapsed else'1 hour')+"',recruitment_ends_at=clock_timestamp()-interval '4 days'where id="+literal(post)+";"+
          actor(fixture_ids[0])+"select *from public.confirm_appointment_completion((select(data->>'appointmentId')::uuid from probe where data?'appointmentId'));"+
          "insert into probe values(public.submit_member_report(gen_random_uuid(),'appointment',(select(data->>'appointmentId')::uuid from probe where data?'appointmentId'),'offline',array['other'],'합성 완료 검토','{}',false));reset role;"+
          "update private.member_reports set status='reviewing'where id=(select(data->>'reportId')::uuid from probe where data?'reportId');"+
          "select jsonb_build_object('post',"+literal(post)+",'appointment',(select(data->>'appointmentId')::uuid from probe where data?'appointmentId'),'report',(select(data->>'reportId')::uuid from probe where data?'reportId'));commit;")
        responses=[line for line in output.splitlines()if line.startswith('{')and '"report"'in line]
        require(len(responses)==1,'CASE_FIXTURE_RESPONSE_INVALID')
        case=json.loads(responses[0]);case['before']=snapshot(case)
        require(case['before']['appointment']['status']=='confirmed'and case['before']['appointment']['completed_at']is None
                and case['before']['confirmations']==1 and case['before']['reservation']is not None,'FIRST_CONFIRMATION_NOT_PRECOMPLETION')
        return case

    def snapshot(case):
        output=run("select jsonb_build_object('appointment',to_jsonb(a),'post',to_jsonb(p),"
          "'reservation',(select to_jsonb(r)from private.completion_reservations r where appointment_id=a.id),"
          "'confirmations',(select count(*)from public.appointment_completion_confirmations where appointment_id=a.id),"
          "'completionNotices',(select count(*)from public.notifications where join_request_id=a.join_request_id and kind='appointment_completed'),"
          "'holds',(select coalesce(jsonb_agg(to_jsonb(h)order by hold_id),'[]')from private.appointment_review_holds h where appointment_id=a.id),"
          "'window',(select to_jsonb(w)from private.appointment_review_windows w where appointment_id=a.id),"
          "'results',(select coalesce(jsonb_agg(jsonb_build_array(h.identity_id,h.current_revision,r.outcome,r.origin)order by h.identity_id),'[]')from private.safety_appointment_results h join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision where h.appointment_id=a.id))"
          "from public.appointments a join public.posts p on p.id=a.post_id where a.id="+literal(case['appointment'])+";")
        return json.loads(output)

    def owner_enter(holder, case):
        holder.write("select private.enter_appointment_review("+literal(case['report'])+","+literal(case['appointment'])+");select 'OWNER_HELD:'||pg_current_xact_id()::text;")
        transaction=holder.wait('OWNER_HELD:',prefix=True).split(':',1)[1]
        require(transaction.isdecimal(),'OWNER_XACT_NOT_ASSIGNED')

    def finish_holder(holder, commit):
        holder.write(('commit;'if commit else'rollback;')+"select 'DONE';")
        holder.wait('DONE');holder.finish()

    def member_completion(member, case):
        member.write(actor(fixture_ids[1])+"select *from public.confirm_appointment_completion("+literal(case['appointment'])+");commit;select 'MEMBER_DONE';")

    def verify_completed(case):
        after=snapshot(case)
        require(after['post']==case['before']['post'],'COMPLETION_CHANGED_AGREED_POST')
        require(after['appointment']['status']=='completed'and after['appointment']['completion_method']=='manual'
                and after['appointment']['completed_at']is not None and after['confirmations']==2
                and after['completionNotices']==2 and after['reservation']is None
                and not after['holds']and after['window']is None,'BILATERAL_MANUAL_COMPLETION_MISMATCH')
        require(run("select review_deadline_at=completed_at+interval '7 days'from public.appointments where id="+literal(case['appointment'])+";")=='t','FIRST_COMPLETION_SEVEN_DAYS_MISMATCH')
        require(len(after['results'])==2 and all(row[2:] == ['completed','appointment']for row in after['results']),'COMPLETED_SAFETY_FACTS_MISMATCH')
        stable=after
        run('begin;'+actor(fixture_ids[1])+"select *from public.confirm_appointment_completion("+literal(case['appointment'])+');commit;')
        require(snapshot(case)==stable,'COMPLETION_RETRY_CHANGED_STATE')

    try:
        template='{"name":{{json .Name}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"ports":{{json (index .HostConfig.PortBindings "5432/tcp")}}}'
        info=json.loads(subprocess.run(['docker','--host',HOST,'inspect','--format',template,CONTAINER],capture_output=True,text=True,check=True,timeout=10).stdout)
        require(info['name']=='/'+CONTAINER and info['running']is True
                and info['project']=='yumidang-minkyu-drift'
                and any(port['HostPort']=='56532'for port in info['ports']),'CONTAINER_SCOPE_INVALID')
        current_phase = 'preflight_catalog'
        protected_baseline=protected_containers()
        baseline = catalog(); state = json.loads(baseline)
        require(state['history']==versions and state['guard'] is False and state['idle'] is True, 'NATIVE66_BASELINE_INVALID')
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
        for role in ['anon','authenticated','service_role','yumidang_worker_queue']:
            for sig in ['private.appointment_review_held(uuid)','private.enter_appointment_review(uuid,uuid)','private.resolve_appointment_review(uuid,uuid,bigint,uuid,text)','private.resume_appointment_review_if_clear(uuid)','private.guard_appointment_review_report_state()']:
                require(run(f"select has_function_privilege({literal(role)},{literal(sig)},'EXECUTE');")=='f','HOLD_HELPER_ACL_NOT_CLOSED')
        current_phase = 'preflight_counts'
        baseline_counts = counts()
        require(files()==0,'STORAGE_BACKEND_NOT_EMPTY')
        require(all(baseline_counts[r]=='0' for r in ['auth.users','storage.objects','public.profiles','public.posts','public.appointments','private.member_retirements','private.appointment_review_holds','private.appointment_review_windows','private.member_reports','private.safety_appointment_results','private.safety_appointment_result_revisions']), 'APPLICATION_NOT_EMPTY')
        current_phase = 'fixture_members'
        fixture_members()
        current_phase='case1_owner_commit'
        case=fixture_case(3);holder,member=Session(),Session()
        owner_enter(holder,case);member_completion(member,case)
        blocked_on_appointment(holder,member);finish_holder(holder,True);member.finish('22023')
        after=snapshot(case)
        require(after['appointment']==case['before']['appointment']and after['post']==case['before']['post']
                and after['confirmations']==1 and after['completionNotices']==0
                and after['reservation']is None and len(after['holds'])==1
                and after['holds'][0]['state']=='reviewing'and after['window']is not None,'OWNER_COMMIT_MEMBER_EFFECTS_MISMATCH')
        require(all(row[2:] == ['pending','appointment']for row in after['results']),'HELD_RESULT_NOT_PENDING')
        results.append('owner_commit_blocks_second_member_completion_22023')

        current_phase='case2_owner_rollback'
        case=fixture_case(6);holder,member=Session(),Session()
        owner_enter(holder,case);member_completion(member,case)
        blocked_on_appointment(holder,member);finish_holder(holder,False)
        member.wait('MEMBER_DONE');member.finish();verify_completed(case)
        results.append('owner_rollback_allows_bilateral_manual_completion_and_seven_days')

        current_phase='case3_stale_reservation_owner_commit'
        case=fixture_case(9,elapsed=True);holder,worker=Session(),Session()
        generation=case['before']['reservation']['generation']
        owner_enter(holder,case)
        worker.write("select 'WORKER_STATUS:'||(public.execute_completion_reservation("+literal(case['appointment'])+","+literal(generation)+")->>'status');commit;select 'WORKER_DONE';")
        blocked_on_appointment(holder,worker);finish_holder(holder,True)
        require(worker.wait('WORKER_STATUS:',prefix=True)=='WORKER_STATUS:stale','QUEUED_RESERVATION_NOT_STALE')
        worker.wait('WORKER_DONE');worker.finish()
        after=snapshot(case)
        require(after['appointment']==case['before']['appointment']and after['post']==case['before']['post']
                and after['confirmations']==1 and after['completionNotices']==0 and after['reservation']is None
                and len(after['holds'])==1 and after['holds'][0]['state']=='reviewing','STALE_RESERVATION_BYPASSED_HOLD')
        results.append('owner_commit_makes_waiting_elapsed_reservation_stale')
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
                    commands += f"delete from private.appointment_review_holds where appointment_id in(select id from public.appointments where post_id in({posts}));delete from private.appointment_review_windows where appointment_id in(select id from public.appointments where post_id in({posts}));delete from private.member_reports where target_type='appointment' and target_id in(select id from public.appointments where post_id in({posts}));"
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
            require(protected_baseline is not None and protected_containers()==protected_baseline,'PROTECTED_CONTAINERS_CHANGED')
            cleanup_ok = True
        except Exception:
            failure = failure or 'FINALLY_NOT_VERIFIED'
    receipt = {'status':'FAIL' if failure else 'PASS','cases':results,'failureCode':failure,
               'cleanupVerified':cleanup_ok,'providerCalls':0,'externalNaver':False,'storageBlobProof':False,'actualHttpProof':False,
               'manifestSha256':MANIFEST_SHA,'edgeManifestSha256':EDGE_SHA,'lockEvidence':lock_evidence,
               'lastPhase':current_phase,'failurePhase':failure_phase,'ownerQueries':query_diagnostics,
               'timeoutCauseEstablished':False,'ownerProcessTimeoutSeconds':30,
               'scope':'isolated_native66_owner_and_authenticated_sql_rpc',
               'ownerFixtureIsOperatorAuthorizationProof':False,'blockingPidAbsenceUsedAsProof':False,
               'actualBlockingPidBarrier':len(lock_evidence)==3,'guardAndAclOpened':False,
               'driverSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               'sourceSqlSha256':{item['path']:item['sha256'] for item in manifest['migrations']},
               'allRelationCountsRestored':cleanup_ok,'catalogAndRolesRestored':cleanup_ok,
               'protectedContainersRestored':cleanup_ok,'storageFilesZero':cleanup_ok,
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
