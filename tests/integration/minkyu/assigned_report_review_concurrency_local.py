"""민규 C: formal native73 기존 증거 보존 및 명시 source74 두 세션 SQL 후보. source75 실제 실행 NOT_RUN. 기존73/74 실제 증거는 문서에 별도로 보존한다.

root가 승인한 정식73 영수증/source pin 없거나 오염되면 Docker 연결 전 실패한다. Provider/HTTP/키 접근은 없다.
--self-check는 로컬 구조 검사만 수행한다. SQLSTATE는 HTTP 상태 증거가 아니다.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
import time
import uuid

SOURCE = Path('/Users/minkyu/Documents/GitHub/yumidang/.worktrees/minkyu-foundation')
PREPARED = Path('/private/tmp/yumidang-policy73-reviewed/prepared')
MANIFEST_SHA = 'eafbcfd77266fcfdafffb18539c89ce0501f721901b41f4435692942ada2fde9'
EDGE_SHA = '4a46666ca6666155ffc209af45ef7e8fc05059aa742852276a1b872d5ee8b156'
SQL_PINS = {
    '20261005155136_assigned_report_review_start.sql': 'c1083e452b284ed66edaa11bb4e075914e6f93ce64ab918a1c266f62ad470b71',
    '20261005161352_assigned_report_review_state.sql': '4c497604f20db4708f65750697fe8bc4f51ea5e1afe6d81d95c2e119a63f0846',
}
# root 승인 정식73 증거만 pin한다. 사용자 인수로 임의 영수증/해시를 받지 않는다.
FORMAL_FOLDER = Path('/private/tmp/yumidang-native73-rollout-format-reviewed')
FORMAL_PROOFS = {
    str(FORMAL_FOLDER / 'application-receipt.json'): 'ba1c86ef5c36397d2a9bef3f2d8a3fa4647cc0b4df4314448f65ddee1363cf14',
    str(FORMAL_FOLDER / 'preflight.json'): 'ab8ca34d0f8bdc58c984cda09ef5da5751828585ee06d37b332bc01deaf14e52',
    str(FORMAL_FOLDER / 'postflight.json'): 'b706e296e91fd7a64ce7da957238eb7751511cada28df41d3e14553f748ea27e',
    str(FORMAL_FOLDER / 'schema-after.json'): 'ac6a98f31fdcfb18cf1e22ae4ee1c5eee93bc819e5c16c78bfb590b3f0877440',
}
FORMAL_DRIVER_SHA = 'ce06bb0bd8fca43e397cc10aaaf8aed8159fd2ed21da660c6f7abad9d58c1bc5'
FORMAL_EXPECTED = {
    str(FORMAL_FOLDER / 'application-receipt.json'): {
        'status': 'PASS', 'scope': 'isolated_native71_to73_formal_cli',
        'historyCount': 73, 'pendingAfter': 0, 'applicationCompleted': True,
        'applicationStateUnknown': False, 'manifestHash': MANIFEST_SHA,
        'edgeHash': EDGE_SHA, 'probeRollbackVerified': True,
        'oldMetadataPreserved': True, 'authAudit288ExactIdsPayloadHashesPreserved': True,
        'filesZero': True, 'guardFalse': True, 'workerIdle': True,
        'protectedContainersUnchanged': True, 'priorProofsUnchanged': True,
        'driverSha256': FORMAL_DRIVER_SHA,
    },
    str(FORMAL_FOLDER / 'preflight.json'): {'catalog.guard': False, 'catalog.idle': True},
    str(FORMAL_FOLDER / 'postflight.json'): {'guard': False, 'idle': True},
    str(FORMAL_FOLDER / 'schema-after.json'): {'catalog.guard': False, 'catalog.idle': True},
}
HOST = 'unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock'
CONTAINER = 'supabase_db_yumidang-minkyu-drift'
SCHEMAS = "('public','private','auth','storage','extensions','supabase_migrations')"
CLEANUP = (
    'claim_member_cleanup_task(uuid)', 'check_member_cleanup_task(uuid,uuid,uuid,uuid)',
    'get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)',
    'record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)',
    'complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)',
)
CASE_NAMES = (
    'same_request', 'different_requests', 'revocation', 'start_session_expiry',
    'state_session_expiry', 'state_current_version', 'retention_expiry',
    'appointment_nowait', 'completion_first', 'review_first', 'retired_actor',
)


class Failure(Exception):
    pass


def require(value, code):
    if not value:
        raise Failure(code)


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def sha(path):
    require(path.is_file() and not path.is_symlink(), 'PIN_FILE_INVALID')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def private_json(path, value):
    pending = path.with_suffix('.pending')
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    os.replace(pending, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def source_gate():
    require(len(FORMAL_PROOFS) >= 2 and set(FORMAL_EXPECTED) == set(FORMAL_PROOFS), 'FORMAL73_EXACT_PROOFS_PENDING')
    proofs = {}
    for name, digest in FORMAL_PROOFS.items():
        path = Path(name)
        require(path.is_absolute() and str(path).startswith('/private/tmp/')
                and re.fullmatch(r'[a-f0-9]{64}', digest) and sha(path) == digest,
                'FORMAL73_PROOF_PIN_INVALID')
        # root가 고정한 영수증 구조/성공 조건까지 확인한다. 형식을 임의 추정하지 않는다.
        proof = json.loads(path.read_bytes())
        expected = FORMAL_EXPECTED[name]
        require(expected and all(isinstance(key, str) for key in expected), 'FORMAL73_EXPECTED_CONTRACT_PENDING')
        for selector, value in expected.items():
            actual = proof
            for key in selector.split('.'):
                require(isinstance(actual, dict) and key in actual, 'FORMAL73_PROOF_FIELD_MISSING')
                actual = actual[key]
            require(type(actual) is type(value) and actual == value, 'FORMAL73_PROOF_NOT_APPROVED')
        proofs[name] = digest
    manifest_path = PREPARED / 'migration-manifest.json'
    edge_path = PREPARED / 'edge-manifest.json'
    require(sha(manifest_path) == MANIFEST_SHA and sha(edge_path) == EDGE_SHA,
            'PREPARED73_PIN_INVALID')
    manifest, edge = json.loads(manifest_path.read_bytes()), json.loads(edge_path.read_bytes())
    require(manifest['status'] == 'READY' and manifest['count'] == 73
            and len(manifest['migrations']) == 73 and edge['migration_count'] == 73
            and len(edge['source_files']) == 52, 'PREPARED73_CONTRACT_INVALID')
    pins = {str(Path(__file__).resolve()): sha(Path(__file__).resolve()), **proofs,
            str(manifest_path): MANIFEST_SHA, str(edge_path): EDGE_SHA}
    formal_driver = FORMAL_FOLDER / 'apply.py'
    require(sha(formal_driver) == FORMAL_DRIVER_SHA, 'FORMAL_DRIVER_CHANGED')
    pins[str(formal_driver)] = FORMAL_DRIVER_SHA
    versions = []
    for item in manifest['migrations']:
        require(re.fullmatch(r'backend/supabase/migrations/\d{14}_[a-z0-9_]+\.sql', item['path'])
                and re.fullmatch(r'\d{14}', item['version'])
                and Path(item['path']).name.startswith(item['version'] + '_'), 'SQL_PIN_PATH_INVALID')
        for path in (SOURCE / item['path'], PREPARED / 'supabase/migrations' / Path(item['path']).name):
            require(sha(path) == item['sha256'], 'SQL_PIN_CHANGED')
            pins[str(path)] = item['sha256']
        versions.append(item['version'])
    require(len(set(versions)) == 73 and sorted(versions)[-2:] == ['20261005155136', '20261005161352'],
            'VERSION_SET_INVALID')
    pre = json.loads((FORMAL_FOLDER / 'preflight.json').read_bytes())
    post = json.loads((FORMAL_FOLDER / 'postflight.json').read_bytes())
    after = json.loads((FORMAL_FOLDER / 'schema-after.json').read_bytes())
    require(pre['catalog']['history'] == sorted(versions)[:-2]
            and post['history'] == after['catalog']['history'] == sorted(versions)
            and pre['audit'] == after['audit'] and len(after['audit']['ids']) == 288,
            'FORMAL_HISTORY_OR_AUDIT_INVALID')
    require(json.loads((FORMAL_FOLDER / 'application-receipt.json').read_bytes())['migrationHashes'] == SQL_PINS,
            'FORMAL_NEW_SQL_HASHES_INVALID')
    for name, digest in SQL_PINS.items():
        require(sha(SOURCE / 'backend/supabase/migrations' / name) == digest, 'REVIEW_SQL_CHANGED')
    for item in edge['source_files']:
        require('..' not in Path(item['path']).parts and item['path'].startswith('backend/supabase/functions/')
                and item['target'] == item['path'][len('backend/'):], 'EDGE_PATH_INVALID')
        for path in (SOURCE / item['path'], PREPARED / item['target']):
            require(sha(path) == item['sha256'], 'EDGE_PIN_CHANGED')
            pins[str(path)] = item['sha256']
    return pins, sorted(versions)


class Driver:
    source_version = 73

    def gate(self):
        return source_gate()

    def extra_cleanup_sql(self, reports):
        return ""

    def extra_preflight(self):
        return None

    def __init__(self):
        self.command = ['docker', '--host', HOST, 'exec', '-i', CONTAINER, 'psql', '-XqAt',
                        '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
                        '-v', 'VERBOSITY=verbose']
        self.namespace = 'review' + str(self.source_version) + '-' + uuid.uuid4().hex[:12]
        self.artifact = Path(tempfile.mkdtemp(prefix='yumidang-review-concurrency' + str(self.source_version) + '-'))
        self.artifact.chmod(0o700)
        self.sessions = []
        self.users = []; self.posts = []; self.reports = []; self.members = []; self.report_requests = []
        self.blocking = []; self.results = []; self.queries = []; self.session_evidence = []
        self.preservation = {}
        self.remote_uncertain = False
        self.bucket_created = False
        self.completion_case_count = 0
        self.baseline = None
        self.phase = 'preflight'
        self.pins = {}; self.versions = []

    def durable(self):
        private_json(self.artifact / 'fixture-recovery.json', {
            'scope': 'isolated_native' + str(self.source_version) + '_two_session_sql_metadata_only',
            'namespace': self.namespace, 'users': self.users, 'posts': self.posts,
            'reports': self.reports, 'reportRequests': self.report_requests, 'members': self.members,
            'bucketCreated': self.bucket_created,
            'sessions': [{'pid': getattr(s, 'pid', None), 'applicationName': s.name} for s in self.sessions],
            'remoteCompletionUncertain': self.remote_uncertain, 'autoRetry': False,
        })

    def run(self, sql, race=False, label=None):
        entry = {'ordinal': len(self.queries) + 1, 'phase': self.phase,
                 'substage': label or ('owner_mutation' if race else 'owner_metadata'), 'statementTimeoutSeconds': 10,
                 'lockTimeoutSeconds': 8 if race else 3, 'status': 'RUNNING'}
        self.queries.append(entry)
        private_json(self.artifact / 'queries.json', self.queries)
        prefix = "set statement_timeout='10s';set lock_timeout='%ss';set plpgsql.check_asserts=on;" % (8 if race else 3)
        try:
            command = list(self.command)
            command[command.index('-d') + 1] = 'dbname=postgres application_name=' + self.namespace + '-observer-' + str(len(self.queries))
            result = subprocess.run(command, input=prefix + sql, text=True,
                                    capture_output=True, timeout=30 if race else 15)
        except subprocess.TimeoutExpired:
            self.remote_uncertain = True; self.durable()
            entry['status'] = 'TIMEOUT'
            private_json(self.artifact / 'queries.json', self.queries)
            raise Failure('OWNER_QUERY_REMOTE_COMPLETION_UNCERTAIN') from None
        entry.update(status='PASS' if result.returncode == 0 else 'FAIL',
                     sqlStates=re.findall(r'ERROR:\s+([A-Z0-9]{5}):', result.stderr))
        private_json(self.artifact / 'queries.json', self.queries)
        require(result.returncode == 0, 'OWNER_QUERY_FAILED')
        return result.stdout.strip()

    def value(self, sql, label=None):
        output = self.run(sql, label=label)
        rows = [line[4:] for line in output.splitlines() if line.startswith('VAL:')]
        require(len(rows) == 1, 'OWNER_RESULT_SHAPE_INVALID')
        return json.loads(rows[0])

    def other_sessions(self):
        # observer 자신 외 active 또는 열린 TX만 검사한다. 쿼리 원문/키/주소는 수집하지 않는다.
        return self.value("select 'VAL:'||coalesce(jsonb_agg(jsonb_build_object('pid',pid,'application',application_name,'state',state)order by pid),'[]')::text from pg_stat_activity where datname=current_database() and backend_type='client backend'and pid<>pg_backend_pid() and(state='active'or xact_start is not null);")

    def snapshot(self):
        # 모든 데이터는 counts만. Auth 기존 audit는 DB 내부 정렬 ID+payload SHA256만 반환한다.
        catalog = self.value(f"""select 'VAL:'||jsonb_build_object(
          'roles',(select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,md5(coalesce(rolconfig::text,'')))order by oid)from pg_roles),
          'membership',(select jsonb_agg(to_jsonb(m)order by roleid,member,grantor)from pg_auth_members m),
          'schema',(select jsonb_agg(jsonb_build_array(oid,nspname,nspowner,nspacl)order by oid)from pg_namespace where nspname in{SCHEMAS}),
          'defaultAcl',(select jsonb_agg(to_jsonb(d)order by oid)from pg_default_acl d),
          'functions',(select jsonb_agg(jsonb_build_array(p.oid,p.oid::regprocedure::text,p.proowner,p.proacl,md5(coalesce(p.proconfig::text,'')),case when p.prokind in('f','p')then pg_get_functiondef(p.oid)else null end)order by p.oid)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in{SCHEMAS}),
          'relations',(select jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relnamespace,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,c.relpersistence,c.relreplident,case when c.relkind in('v','m')then pg_get_viewdef(c.oid)else null end)order by c.oid)from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in{SCHEMAS}),
          'columns',(select jsonb_agg(jsonb_build_array(a.attrelid,a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attacl,pg_get_expr(d.adbin,d.adrelid))order by a.attrelid,a.attnum)from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where n.nspname in{SCHEMAS}and a.attnum>0),
          'constraints',(select jsonb_agg(jsonb_build_array(c.oid,c.conrelid,c.conname,pg_get_constraintdef(c.oid),c.convalidated)order by c.oid)from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in{SCHEMAS}),
          'indexes',(select jsonb_agg(jsonb_build_array(i.indexrelid,pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready)order by i.indexrelid)from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in{SCHEMAS}),
          'triggers',(select jsonb_agg(jsonb_build_array(t.oid,t.tgrelid,t.tgenabled,pg_get_triggerdef(t.oid))order by t.oid)from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in{SCHEMAS}),
          'policies',(select jsonb_agg(jsonb_build_array(p.oid,p.polrelid,p.polname,p.polcmd,p.polpermissive,p.polroles,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid))order by p.oid)from pg_policy p),
          'types',(select jsonb_agg(jsonb_build_array(t.oid,t.typname,t.typnamespace,t.typowner,t.typtype,t.typacl,t.typbasetype,t.typnotnull)order by t.oid)from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname in{SCHEMAS}),
          'enums',(select jsonb_agg(to_jsonb(e)order by enumtypid,enumsortorder)from pg_enum e),
          'sequences',(select jsonb_agg(to_jsonb(s)order by seqrelid)from pg_sequence s),
          'history',(select jsonb_agg(version order by version)from supabase_migrations.schema_migrations),
          'proofs',(select coalesce(jsonb_agg(to_jsonb(a)order by migration_version),'[]')from private.appointment_safety_sync_audit a),
          'guard',(select to_jsonb(g)from private.member_cleanup_guard g where singleton),
          'worker',(select to_jsonb(g)from private.global_worker_run g where singleton),
          'auditCount',(select count(*)from auth.audit_log_entries),
          'auditHash',(select encode(extensions.digest(coalesce(string_agg(jsonb_build_array(id,to_jsonb(payload))::text,E'\\n'order by id),''),'sha256'),'hex')from auth.audit_log_entries)
        )::text;""")
        relations = self.value(f"select 'VAL:'||coalesce(jsonb_agg(format('%I.%I',n.nspname,c.relname)order by n.nspname,c.relname),'[]')::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in{SCHEMAS}and c.relkind in('r','p');")
        union = ' union all '.join('select ' + quote(name) + ' as name,count(*)::text n from ' + name for name in relations)
        counts = self.value("select 'VAL:'||jsonb_object_agg(name,n)::text from(" + union + ')q;')
        return {'catalog': catalog, 'counts': counts, 'containers': self.containers(), 'files': self.files()}

    def containers(self):
        ids = self.process(['docker', '--host', HOST, 'ps', '-aq']).split()
        require(ids, 'CONTAINER_LIST_EMPTY')
        template = '{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}}}'
        return sorted((json.loads(line) for line in self.process(['docker', '--host', HOST, 'inspect', '--format', template, *ids]).splitlines()), key=lambda row: row['name'])

    def files(self):
        return len(self.process(['docker', '--host', HOST, 'exec', 'supabase_storage_yumidang-minkyu-drift', 'find', '/var/lib/storage', '-type', 'f']).splitlines())

    @staticmethod
    def process(command):
        try:
            result = subprocess.run(command, text=True, capture_output=True, timeout=10)
        except subprocess.TimeoutExpired:
            raise Failure('METADATA_PROCESS_TIMEOUT') from None
        require(result.returncode == 0, 'METADATA_PROCESS_FAILED')
        return result.stdout.strip()

    def actor(self, uid):
        user = next(item for item in self.users if item['uid'] == uid)
        claims = json.dumps({'sub': uid, 'role': 'authenticated', 'session_id': user['session'], 'is_anonymous': False})
        return 'set local role authenticated;do $$begin perform set_config(\'request.jwt.claim.sub\',' + quote(uid) + ',true);perform set_config(\'request.jwt.claims\',' + quote(claims) + ',true);end;$$;'

    def member(self, qualified=True):
        item = {'uid': str(uuid.uuid4()), 'session': str(uuid.uuid4()), 'subject': self.namespace + '-' + uuid.uuid4().hex,
                'photoId': str(uuid.uuid4())}
        item['photo'] = item['uid'] + '/' + item['photoId'] + '.jpg'
        self.users.append(item)
        if qualified:
            self.members.append(item)
        self.durable()
        uid, sid = quote(item['uid']), quote(item['session'])
        if qualified:
            self.run("begin;set local role service_role;select public.resolve_naver_account(" + quote(item['subject']) + ",'합성 경합 회원','F','1990-01-01');reset role;" +
                     f"insert into auth.users(id,email)select {uid},auth_email from private.naver_accounts where subject={quote(item['subject'])};insert into auth.sessions(id,user_id)values({sid},{uid});" +
                     f"insert into storage.objects(id,bucket_id,name,owner_id,metadata)values({quote(item['photoId'])},'profile-images',{quote(item['photo'])},{uid},'{{\"mimetype\":\"image/jpeg\",\"size\":128}}');" +
                     "set local role service_role;select public.record_naver_session(" + quote(item['subject']) + f",{uid},{sid});reset role;" +
                     self.actor(item['uid']) + "do $$begin assert public.complete_naver_signup(" + quote(item['photo']) + ",'{}','{}',null)->>'status'='ready';end;$$;commit;")
        else:
            self.run(f"begin;insert into auth.users(id,email)values({uid},{quote(self.namespace+'-'+item['uid']+'@test.invalid')});insert into auth.sessions(id,user_id)values({sid},{uid});commit;")
        return item['uid']

    def case(self, appointment=False, completion=False, staff=None):
        staff = staff or self.staff
        client_request = str(uuid.uuid4()); self.report_requests.append(client_request)
        report = client_request  # 아래 실제 접수 결과의 서버 reportId로 교체한다.
        case = {'report': report, 'staff': staff, 'request': str(uuid.uuid4()), 'appointment': None, 'post': None}
        if appointment:
            case['post'] = str(uuid.uuid4()); self.posts.append(case['post'])
            case['slotDays'] = len(self.posts) * 3
            if completion:
                self.completion_case_count += 1
                case['pastStartHours'] = self.completion_case_count * 3
        self.durable()
        prefix = 'begin;create temp table probe(data jsonb);grant all on probe to authenticated;'
        if appointment:
            p = quote(case['post'])
            prefix += self.actor(self.owner) + f"select public.create_service_post({p},jsonb_build_object('title','합성 검토 경합','description','격리 SQL 회귀','category','산책','startsAt',clock_timestamp()+make_interval(days=>{case['slotDays']}),'endsAt',clock_timestamp()+make_interval(days=>{case['slotDays']},hours=>2),'recruitmentEndsAt',clock_timestamp()+make_interval(days=>{case['slotDays']-1}),'publicArea','서울특별시 강남구 역삼동','registeredPlaceName','가상 장소','registeredAddress','서울특별시 강남구 가상주소','meetingDetail','가상 입구','preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0));"
            prefix += self.actor(self.peer) + f"insert into probe values(public.request_service_post({p},gen_random_uuid(),'합성 신청'));"
            prefix += self.actor(self.owner) + "insert into probe values(public.propose_match((select(data->>'id')::uuid from probe where data?'id')));"
            prefix += self.actor(self.peer) + "insert into probe values(public.accept_match((select(data->>'id')::uuid from probe where data?'id'),(select data->>'conditionVersion'from probe where data?'conditionVersion')));reset role;"
            if completion:
                prefix += f"with anchor as(select clock_timestamp()as n)update public.posts set starts_at=anchor.n-make_interval(hours=>{case['pastStartHours']}),ends_at=anchor.n-make_interval(hours=>{case['pastStartHours']-2}),recruitment_ends_at=anchor.n-make_interval(hours=>{case['pastStartHours']+1})from anchor where id={p};"
                prefix += self.actor(self.owner) + "select *from public.confirm_appointment_completion((select(data->>'appointmentId')::uuid from probe where data?'appointmentId'));reset role;"
            prefix += self.actor(self.owner) + f"insert into probe values(public.submit_member_report({quote(report)},'appointment',(select(data->>'appointmentId')::uuid from probe where data?'appointmentId'),'offline',array['other'],'합성 검토','{{}}',false));reset role;"

        else:
            prefix += self.actor(self.owner) + f"insert into probe values(public.submit_member_report({quote(report)},'member',{quote(self.peer)},'offline',array['spam'],'합성 일반 신고','{{}}',false));reset role;"
        prefix += f"select private.set_report_operator_assignment({quote(staff)},(select(data->>'reportId')::uuid from probe where data?'reportId'),true);"
        prefix += "select 'VAL:'||jsonb_build_object('reportId',(select data->>'reportId'from probe where data?'reportId'),'appointmentId',(select data->>'appointmentId'from probe where data?'appointmentId'))::text;commit;"
        output = self.run(prefix, race=True)
        rows = [line[4:] for line in output.splitlines() if line.startswith('VAL:')]
        require(len(rows) == 1, 'REPORT_FIXTURE_SHAPE_INVALID')
        result = json.loads(rows[0])
        require(isinstance(result['reportId'], str) and str(uuid.UUID(result['reportId'])) == result['reportId'], 'REPORT_SERVER_ID_INVALID')
        case['report'] = result['reportId']; self.reports.append(case['report'])
        case['appointment'] = result['appointmentId']; self.durable()
        require(self.report_state(case)['version'] == 1, 'REPORT_DEFAULT_VERSION_INVALID')
        return case

    def report_state(self, case):
        rid = quote(case['report'])
        return self.value(f"select 'VAL:'||jsonb_build_object('status',status,'version',review_version,'receipts',(select count(*)from private.report_review_start_receipts where report_id={rid}),'holds',(select count(*)from private.appointment_review_holds where report_id={rid}),'audit',(select count(*)from private.report_access_audit where report_id={rid}))::text from private.member_reports where id={rid};")

    def ap_state(self, case):
        return self.value(f"""select 'VAL:'||jsonb_build_object('appointment',to_jsonb(a),
        'post',to_jsonb(p),'reservation',(select to_jsonb(r)from private.completion_reservations r where appointment_id=a.id),
        'confirmations',(select count(*)from public.appointment_completion_confirmations where appointment_id=a.id),
        'notifications',(select count(*)from public.notifications where join_request_id=a.join_request_id and kind='appointment_completed'),
        'window',(select to_jsonb(w)from private.appointment_review_windows w where appointment_id=a.id),
        'results',(select coalesce(jsonb_agg(to_jsonb(r)order by identity_id,revision),'[]')from private.safety_appointment_result_revisions r where appointment_id=a.id))::text
        from public.appointments a join public.posts p on p.id=a.post_id where a.id={quote(case['appointment'])};""")

    def start(self, case, request=None):
        return self.actor(case['staff']) + 'select public.start_assigned_report_review(' + quote(case['report']) + ',' + quote(request or case['request']) + ',1);'

    def read(self, case):
        return self.actor(case['staff']) + 'select public.get_assigned_report_review_state(' + quote(case['report']) + ');'

    def blocked(self, holder, waiter, label):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            proof = self.value(f"select 'VAL:'||jsonb_build_object('holderPid',{holder.pid},'waiterPid',{waiter.pid},'blocked',{holder.pid}=any(pg_blocking_pids({waiter.pid})),'holderOpen',exists(select 1 from pg_stat_activity where pid={holder.pid} and xact_start is not null),'waiterLock',exists(select 1 from pg_stat_activity where pid={waiter.pid} and state='active'and wait_event_type='Lock'),'locks',(select coalesce(jsonb_agg(jsonb_build_object('type',locktype,'mode',mode,'granted',granted)order by locktype,mode,granted),'[]')from pg_locks where pid in({holder.pid},{waiter.pid})))::text;", label='barrier.' + label)
            if proof['blocked'] and proof['holderOpen'] and proof['waiterLock']:
                proof['label'] = label; self.blocking.append(proof)
                private_json(self.artifact / 'blocking.json', self.blocking)
                return
            require(waiter.p.poll() is None, 'WAITER_FINISHED_BEFORE_BARRIER')
            time.sleep(.05)
        raise Failure('REAL_BLOCKING_PID_BARRIER_TIMEOUT')

    def expire_after_barrier(self, table, key, column, interval='5 seconds'):
        # 초기 guard 전에 미리 설정한다. guard SHARE 뒤 session UPDATE는 하지 않는다.
        self.run(f"begin;update {table} set {column}=clock_timestamp()+interval'{interval}'where {key};commit;")

    def wait_db_deadline(self, expression):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if self.run('select clock_timestamp()>=' + expression + ';').splitlines()[-1] == 't':
                return
            time.sleep(.05)
        raise Failure('DB_CLOCK_DEADLINE_NOT_REACHED')

    def pair(self):
        return Session(self), Session(self)

    def no_effect_failure(self, case, sql, state):
        before = self.report_state(case)
        session = Session(self); session.send(sql + 'commit;'); session.finish(state)
        require(self.report_state(case) == before, 'FAILED_ACCESS_CHANGED_REPORT_OR_AUDIT')

    def same_request(self):
        case = self.case(appointment=True); a, b = self.pair()
        first = a.result(self.start(case)); b.send(self.start(case) + 'commit;')
        self.blocked(a, b, 'same_actor_request_advisory')
        a.release(True); second = b.finish_json()
        require(first == second | {'alreadyApplied': False} and first['alreadyApplied'] is False
                and second['alreadyApplied'] is True and first['version'] == 2 and first['holdId'],
                'DUPLICATE_RECEIPT_RESPONSE_MISMATCH')
        state = self.report_state(case)
        require(state['receipts'] == state['holds'] == 1 and state['version'] == 2
                and state['status'] == 'reviewing', 'DUPLICATE_NOT_EXACTLY_ONCE')

    def different_requests(self):
        case = self.case(appointment=True); a, b = self.pair()
        a.result(self.start(case)); before = self.report_state(case)
        b.send(self.start(case, str(uuid.uuid4())) + 'commit;'); b.finish('40001')
        require(self.report_state(case) == before, 'NOWAIT_FAILED_REQUEST_LEAKED')
        a.release(True)
        # 별도 명시 사례이며 자동 재시도가 아니다.
        self.no_effect_failure(case, self.start(case, str(uuid.uuid4())), '40001')

    def revocation(self):
        for kind in ('approval', 'assignment'):
            for first_revoke, commit in ((False, True), (True, True), (True, False)):
                case = self.case(); a, b = self.pair()
                setter = f"select private.set_report_operator_{kind}({quote(self.staff)}," + (f"{quote(case['report'])}," if kind == 'assignment' else '') + 'false);'
                before = self.report_state(case)
                if first_revoke:
                    a.mark(setter); b.send(self.start(case) + 'commit;')
                    self.blocked(a, b, kind + '_revoke_first')
                    a.release(commit)
                    if commit:
                        b.finish('42501'); require(self.report_state(case) == before, 'REVOKED_START_MUTATED')
                    else:
                        require(b.finish_json()['version'] == 2, 'REVOKE_ROLLBACK_DID_NOT_ALLOW_START')
                else:
                    a.result(self.start(case)); b.send(setter + 'commit;')
                    self.blocked(a, b, kind + '_access_first')
                    a.release(True); b.finish()
                    self.no_effect_failure(case, self.start(case), '42501')
                    self.no_effect_failure(case, self.read(case), '42501')
                if kind == 'approval':
                    self.run(f"begin;select private.set_report_operator_approval({quote(self.staff)},true);commit;")

    def start_session_expiry(self):
        case = self.case(appointment=True)
        sid = next(x['session'] for x in self.users if x['uid'] == self.staff)
        self.expire_after_barrier('auth.sessions', 'id=' + quote(sid), 'not_after')
        before, ap_before = self.report_state(case), self.ap_state(case)
        a, b = self.pair()
        a.mark(f"select pg_advisory_xact_lock(hashtextextended({quote(self.staff+':'+case['request'])},155136));select 1 from private.member_reports where id={quote(case['report'])}for update;")
        b.send(self.start(case) + 'commit;'); self.blocked(a, b, 'start_request_advisory_not_report_nowait')
        self.wait_db_deadline(f"(select not_after from auth.sessions where id={quote(sid)})")
        a.release(True); b.finish('28000')
        require(self.report_state(case) == before and self.ap_state(case) == ap_before, 'EXPIRED_START_NOT_ATOMIC')
        self.run(f"begin;update auth.sessions set not_after=null where id={quote(sid)};commit;")

    def state_session_expiry(self):
        case = self.case(); sid = next(x['session'] for x in self.users if x['uid'] == self.staff)
        self.expire_after_barrier('auth.sessions', 'id=' + quote(sid), 'not_after')
        before = self.report_state(case); a, b = self.pair()
        a.mark(f"select 1 from private.member_reports where id={quote(case['report'])}for update;")
        b.send(self.read(case) + 'commit;'); self.blocked(a, b, 'state_report_share_session_expiry')
        self.wait_db_deadline(f"(select not_after from auth.sessions where id={quote(sid)})")
        a.release(True); b.finish('28000')
        require(self.report_state(case) == before, 'EXPIRED_STATE_READ_AUDIT_LEAKED')
        self.run(f"begin;update auth.sessions set not_after=null where id={quote(sid)};commit;")

    def state_current_version(self):
        for commit in (True, False):
            case = self.case(); a, b = self.pair()
            a.result(self.start(case)); b.send(self.read(case) + 'commit;')
            self.blocked(a, b, 'state_wait_current_version')
            a.release(commit); result = b.finish_json()
            require(result == {'reportId': case['report'], 'status': 'reviewing' if commit else 'received', 'version': 2 if commit else 1}, 'CURRENT_VERSION_NOT_COMMITTED_STATE')
            require(self.report_state(case)['audit'] == 1, 'SUCCESS_READ_AUDIT_NOT_EXACTLY_ONE')
        case = self.case(); a = Session(self); a.result(self.start(case)); a.release(True)
        self.run(f"begin;update private.member_reports set status='more_evidence' where id={quote(case['report'])};commit;")
        b = Session(self); result = b.result(self.read(case)); b.release(True)
        require(result['version'] == 3 and result['status'] == 'more_evidence', 'STATE_RETURNED_OLD_RECEIPT_VERSION')
        require(self.run(f"select result_version from private.report_review_start_receipts where report_id={quote(case['report'])};") == '2', 'OLD_RECEIPT_VERSION_CHANGED')

    def retention_expiry(self):
        case = self.case(); rid = quote(case['report'])
        # owner 합성 일반 신고 종결 기한. 실제 신고 종결 workflow의 증거가 아니다.
        self.run(f"begin;do $$begin assert not exists(select 1 from private.safety_incident_report_links where report_id={rid});assert not exists(select 1 from private.appointment_review_holds where report_id={rid});end;$$;with deadline as(select clock_timestamp()+interval'5 seconds' as due)update private.member_reports set status='resolved',final_closed_at=d.due-interval'2160 hours',retention_due_at=d.due from deadline d where id={rid};commit;")
        # 동일 DB 시각 CTE로 final_closed_at + 2160 hours CHECK를 정확히 유지한다.
        before = self.report_state(case); a, b = self.pair()
        a.mark(f"select 1 from private.member_reports where id={rid}for update;")
        b.send(self.read(case) + 'commit;'); self.blocked(a, b, 'state_report_share_retention_expiry')
        self.wait_db_deadline(f'(select retention_due_at from private.member_reports where id={rid})')
        a.release(True); b.finish('PT404')
        require(self.report_state(case) == before, 'EXPIRED_RETENTION_READ_AUDIT_LEAKED')

    def appointment_nowait(self):
        case = self.case(appointment=True); before, ap_before = self.report_state(case), self.ap_state(case)
        a, b = self.pair(); a.mark(f"select 1 from public.appointments where id={quote(case['appointment'])}for update;")
        b.send(self.start(case) + 'commit;'); b.finish('40001')
        require(self.report_state(case) == before and self.ap_state(case) == ap_before, 'APPOINTMENT_NOWAIT_PARTIAL_EFFECT')
        a.release(False)

    def confirm(self, case):
        return self.actor(self.peer) + 'select *from public.confirm_appointment_completion(' + quote(case['appointment']) + ');'

    def completed(self, case):
        state = self.ap_state(case); ap = state['appointment']
        require(ap['status'] == 'completed' and ap['completed_at'] and ap['completion_method'] == 'manual'
                and state['confirmations'] == 2 and state['notifications'] == 2 and state['reservation'] is None,
                'BILATERAL_COMPLETION_NOT_COMMITTED')
        return state

    def completion_first(self):
        case = self.case(appointment=True, completion=True); a, b = self.pair()
        a.mark(self.confirm(case)); before = self.report_state(case)
        b.send(self.start(case) + 'commit;'); b.finish('40001')
        require(self.report_state(case) == before, 'COMPLETION_FIRST_REVIEW_LEAKED')
        a.release(True); done = self.completed(case)
        # 별도의 명시 검토 호출: 완료 사실은 지우지 않고 기존 hold semantics만 적용한다.
        b = Session(self); b.result(self.start(case)); b.release(True)
        require(self.ap_state(case)['appointment'] == done['appointment'], 'POST_COMPLETION_REVIEW_ERASED_COMPLETION')
        require(self.report_state(case)['holds'] == 1, 'COMPLETED_REVIEW_HOLD_MISSING')

    def review_first(self):
        for commit in (True, False):
            case = self.case(appointment=True, completion=True); a, b = self.pair()
            a.result(self.start(case)); b.send(self.confirm(case) + 'commit;')
            self.blocked(a, b, 'completion_actual_guard_or_appointment_wait')
            a.release(commit)
            if commit:
                b.finish('22023')
                require(self.ap_state(case)['appointment']['completed_at'] is None
                        and self.report_state(case)['holds'] == 1, 'REVIEW_HOLD_COMPLETION_BYPASS')
            else:
                b.finish(); self.completed(case)
                require(self.report_state(case)['version'] == 1 and self.report_state(case)['receipts'] == 0, 'ROLLED_BACK_REVIEW_NOT_ATOMIC')

    def retire_sql(self, uid, withdrawal):
        # 임시 승인과5 EXEC는 같은 owner TX에서만 준비하고 COMMIT 전 원래 폐쇄 ACL 복원.
        # 원래 ACL과 복원 ACL은 runtime에서 exact 비교하며 외부 DELETE/complete를 호출하지 않는다.
        grants = ''.join('grant execute on function public.' + sig + ' to service_role;' for sig in CLEANUP)
        revokes = ''.join('revoke execute on function public.' + sig + ' from service_role;' for sig in CLEANUP)
        return "update private.member_cleanup_guard set external_deletion_approved=true where singleton;" + grants + self.actor(uid) + 'select public.retire_my_account(' + quote(withdrawal) + ');reset role;' + revokes + "update private.member_cleanup_guard set external_deletion_approved=false where singleton;"

    def retired_actor(self):
        for retire_first, commit in ((False, True), (True, True), (True, False)):
            staff = self.member(); self.run(f"begin;select private.set_report_operator_approval({quote(staff)},true);commit;")
            case = self.case(staff=staff); sid = next(x['session'] for x in self.users if x['uid'] == staff)
            a, b = self.pair(); retirement = self.retire_sql(staff, str(uuid.uuid4()))
            before = self.report_state(case)
            if retire_first:
                a.result(retirement); b.send(self.start(case) + 'commit;')
                self.blocked(a, b, 'retire_auth_session_delete_first')
                a.release(commit)
                if commit:
                    b.finish('28000'); require(self.report_state(case) == before, 'RETIRED_ACTOR_MUTATION_LEAKED')
                else:
                    require(b.finish_json()['version'] == 2, 'RETIRE_ROLLBACK_BLOCKED_LIVE_STAFF')
            else:
                a.result(self.start(case)); b.send(retirement + 'commit;')
                self.blocked(a, b, 'staff_session_share_retire_delete_wait')
                require(self.run(f"select count(*)from private.member_retirements where profile_id={quote(staff)};") == '0', 'RETIRE_COMMITTED_BEFORE_SESSION_DELETE')
                a.release(True); response = b.finish_json()
                require(response['status'] == 'processing', 'SQL_RETIRE_FAKE_COMPLETED')
                require(self.report_state(case)['receipts'] == 1, 'RETIRE_ERASED_REVIEW_RECEIPT')
            if commit:
                require(self.run(f"select count(*)from auth.sessions where id={quote(sid)};") == '0', 'RETIRE_SESSION_DELETE_MISSING')
                self.no_effect_failure(case, self.read(case), '28000')
                self.no_effect_failure(case, self.start(case), '28000')
            require(self.value("select 'VAL:'||to_jsonb(external_deletion_approved)::text from private.member_cleanup_guard where singleton;") is False, 'RETIRE_GUARD_NOT_RESTORED')
            require(self.cleanup_acl() == self.baseline_cleanup_acl, 'TEMP_RETIRE_CLEANUP_ACL_NOT_EXACTLY_RESTORED')

    def cleanup_acl(self):
        sigs = ','.join(quote('public.' + sig) + '::regprocedure' for sig in CLEANUP)
        return self.value(f"select 'VAL:'||jsonb_agg(jsonb_build_array(oid,proowner,proacl)order by oid)::text from pg_proc where oid in({sigs});")

    def preflight(self):
        self.pins, self.versions = self.gate()
        # 고정 로컬 컨테이너 metadata만 읽는다. 환경/키는 읽지 않는다.
        template = '{"name":{{json .Name}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"ports":{{json (index .HostConfig.PortBindings "5432/tcp")}}}'
        info = json.loads(self.process(['docker', '--host', HOST, 'inspect', '--format', template, CONTAINER]))
        require(info['name'] == '/' + CONTAINER and info['running'] is True and info['project'] == 'yumidang-minkyu-drift'
                and any(p['HostPort'] == '56532' for p in info['ports']), 'ISOLATED_SCOPE_INVALID')
        require(not self.other_sessions(), 'OTHER_ACTIVE_DB_SESSION_PRESENT')
        self.baseline = self.snapshot(); c = self.baseline['catalog']
        self.preservation['beforeSha256'] = hashlib.sha256(json.dumps(self.baseline, sort_keys=True).encode()).hexdigest()
        self.preservation['authAuditCount'] = c['auditCount']
        self.preservation['authAuditIdPayloadSha256'] = c['auditHash']
        private_json(self.artifact / 'baseline-summary.json', self.preservation)
        require(c['history'] == self.versions and c['guard']['external_deletion_approved'] is False
                and c['worker']['token'] is None and c['worker']['expires_at'] is None
                and c['auditCount'] == 288 and self.baseline['files'] == 0, 'NATIVE73_BASELINE_INVALID')
        for name in ('auth.users', 'auth.sessions', 'public.profiles', 'public.posts', 'public.appointments',
                     'storage.objects', 'private.member_reports', 'private.member_retirements',
                     'private.report_review_start_receipts', 'private.report_operator_approvals', 'private.report_operator_assignments',
                     'private.member_cleanup_tasks', 'private.worker_jobs'):
            require(self.baseline['counts'][name] == '0', 'APPLICATION_FIXTURE_SCOPE_NOT_EMPTY')
        self.baseline_cleanup_acl = self.cleanup_acl()
        for sig in (*CLEANUP, 'read_worker_run_budget(uuid)'):
            for role in ('anon', 'authenticated', 'service_role'):
                require(self.run('select has_function_privilege(' + quote(role) + ',' + quote('public.' + sig) + ",'EXECUTE');") == 'f', 'CLEANUP_OR_BUDGET_ACL_NOT_CLOSED')
        for sig in ('start_assigned_report_review(uuid,uuid,bigint)', 'get_assigned_report_review_state(uuid)'):
            for role in ('anon', 'authenticated', 'service_role'):
                require(self.run('select has_function_privilege(' + quote(role) + ',' + quote('public.' + sig) + ",'EXECUTE');") == ('t' if role == 'authenticated' else 'f'), 'STAFF_RPC_ACL_INVALID')
        self.extra_preflight()
        self.bucket_created = self.run("select exists(select 1 from storage.buckets where id='profile-images');") == 'f'
        self.durable()
        if self.bucket_created:
            self.run("begin;insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)values('profile-images','profile-images',false,2097152,array['image/jpeg']);commit;")
        else:
            require(self.run("select not public and file_size_limit=2097152 and allowed_mime_types=array['image/jpeg']::text[]from storage.buckets where id='profile-images';") == 't', 'EXISTING_BUCKET_INCOMPATIBLE')
        self.owner = self.member(); self.peer = self.member(); self.staff = self.member(False)
        self.run('begin;select private.set_report_operator_approval(' + quote(self.staff) + ',true);commit;')

    def cleanup(self):
        close_failures = []
        for session in self.sessions:
            try:
                session.close()
            except Exception:
                close_failures.append('TRACKED_SESSION_CLOSE_NOT_VERIFIED')
        pids = ','.join(str(s.pid) for s in self.sessions if getattr(s, 'pid', None) is not None)
        if pids:
            require(self.run(f'select count(*)from pg_stat_activity where pid in({pids});') == '0', 'OWN_REMOTE_BACKEND_REMAINS_NO_CLEANUP')
        require(self.run("select count(*)from pg_stat_activity where datname=current_database()and pid<>pg_backend_pid()and application_name like " + quote(self.namespace + '-%') + ';') == '0', 'OWN_REMOTE_APPLICATION_REMAINS_NO_CLEANUP')
        require(not close_failures, 'TRACKED_SESSION_CLOSE_NOT_VERIFIED')
        require(not self.other_sessions(), 'OTHER_ACTIVE_DB_SESSION_BEFORE_CLEANUP')
        ids = ','.join(quote(x['uid']) for x in self.users)
        report_keys = ','.join(quote(x) for x in self.report_requests)
        reports = f'select id from private.member_reports where client_request_id in({report_keys})and reporter_id in({ids})' if report_keys and ids else ''
        posts = ','.join(quote(x) for x in self.posts)
        sql = "begin;set local storage.allow_delete_query='true';"
        # 기존 held-report DELETE trigger를 우회하지 않는다. 합성 hold/window/normal
        # completion을 먼저 정리한 뒤 그 합성 신고를 삭제한다.
        if posts:
            ap = f'select id from public.appointments where post_id in({posts})'
            for table in ('private.appointment_review_normal_completions', 'private.appointment_review_holds', 'private.appointment_review_windows'):
                sql += f'delete from {table} where appointment_id in({ap});'
        if reports:
            sql += self.extra_cleanup_sql(reports)
            sql += f"delete from private.report_access_audit where report_id in({reports});delete from private.appointment_review_holds where report_id in({reports});delete from private.member_reports where id in({reports});"
        if posts:
            for table in ('private.safety_appointment_result_revisions', 'private.safety_appointment_results'):
                sql += f'delete from {table} where appointment_id in({ap});'
            sql += f'delete from public.appointments where post_id in({posts});delete from public.posts where id in({posts});'
        if ids:
            sql += f"delete from private.report_access_audit where actor_id in({ids});delete from private.report_operator_assignments where operator_uid in({ids});delete from private.report_operator_approvals where auth_user_id in({ids});delete from private.member_cleanup_tasks where profile_id in({ids});delete from private.member_retirements where profile_id in({ids});delete from public.profiles where id in({ids});delete from private.member_episodes where profile_id in({ids});delete from private.naver_sessions where user_id in({ids});"
            subjects = ','.join(quote(x['subject']) for x in self.members)
            photos = ','.join(quote(x['photo']) for x in self.members)
            if subjects:
                sql += f'delete from private.naver_identity_keys where subject in({subjects});delete from private.naver_accounts where subject in({subjects});'
            if photos:
                sql += f"delete from storage.objects where bucket_id='profile-images'and name in({photos});"
            sql += f'delete from auth.users where id in({ids});'
        if self.bucket_created:
            sql += "delete from storage.buckets where id='profile-images';"
        if self.users or self.bucket_created:
            self.run(sql + 'commit;', race=True)
        require(not self.other_sessions(), 'OTHER_ACTIVE_DB_SESSION_AFTER_CLEANUP')
        after = self.snapshot()
        self.preservation['afterSha256'] = hashlib.sha256(json.dumps(after, sort_keys=True).encode()).hexdigest()
        require(after == self.baseline, 'FULL_BASELINE_NOT_RESTORED')
        self.preservation['fullCatalogCountsAuditAclRolesPoliciesGuardWorkerFilesContainersRestored'] = True
        require(all(sha(Path(path)) == digest for path, digest in self.pins.items()), 'SOURCE_OR_PROOF_CHANGED')


# root가 정확한 formal74 pins를 전달하기 전에는 이 gate를 채우지 않는다.
FORMAL74_PROOFS = {
 '/private/tmp/yumidang-native74-rollout-reviewed/application-receipt.json': '5099b62eba44200125c21dc9c642c8630f0b98172ebc13f5d1928a550b132926',
 '/private/tmp/yumidang-native74-rollout-reviewed/preflight.json': '25c595e77c54179c47a07787371e8662a025c9e8e0961e8824d6ffede75105b3',
 '/private/tmp/yumidang-native74-rollout-reviewed/postflight.json': '484858bb600171ff8079ea0d3c94e435a243a328fb17dd027d43fbd507c9e7bc',
 '/private/tmp/yumidang-native74-rollout-reviewed/schema-after.json': 'fb0241ea16744f493fa958468bab4fb928ceceebff1ad9c8f33f2a03afcb8be8',
}
FORMAL74_EXPECTED = {
 '/private/tmp/yumidang-native74-rollout-reviewed/application-receipt.json': {
  'status': 'PASS', 'scope': 'isolated_native73_to74_formal_cli', 'historyCount': 74,
  'pendingAfter': 0, 'applicationCompleted': True, 'applicationStateUnknown': False,
  'probeRollbackVerified': True, 'oldMetadataPreserved': True,
  'authAudit288ExactIdsPayloadHashesPreserved': True, 'filesZero': True,
  'guardFalse': True, 'workerIdle': True, 'protectedContainersUnchanged': True,
  'priorProofsUnchanged': True, 'driverSha256': '42f617fd80de3d1ff48dd3c418ca86d9a3b6b4538f1500101648f1104b531797',
  'manifestHash': '5006c517b54a63bf3e7ccb2d0f25e1ad0034ad83bc98fa49fcf25c8c409ed2d5',
  'edgeHash': 'df22a40254b1fc269930a5dfe083e3c11a67ec23ff252aecfc8ede3ad02e982c',
 },
 '/private/tmp/yumidang-native74-rollout-reviewed/preflight.json': {'catalog.guard': False, 'catalog.idle': True},
 '/private/tmp/yumidang-native74-rollout-reviewed/postflight.json': {'guard': False, 'idle': True},
 '/private/tmp/yumidang-native74-rollout-reviewed/schema-after.json': {'catalog.guard': False, 'catalog.idle': True},
}
FORMAL74_FOLDER = Path('/private/tmp/yumidang-native74-rollout-reviewed')
FORMAL74_PREPARED = Path('/private/tmp/yumidang-policy74-agent-reviewed/prepared')
FORMAL74_MANIFEST_SHA = '5006c517b54a63bf3e7ccb2d0f25e1ad0034ad83bc98fa49fcf25c8c409ed2d5'
FORMAL74_EDGE_SHA = 'df22a40254b1fc269930a5dfe083e3c11a67ec23ff252aecfc8ede3ad02e982c'
FORMAL74_DRIVER_SHA = '42f617fd80de3d1ff48dd3c418ca86d9a3b6b4538f1500101648f1104b531797'
SQL74_SHA = 'd2e3b141ea5ad7048d075f1568f7afd6fc1320e3daa4f71163b252a91b825133'
CASE74_NAMES = ('decision_duplicate', 'decision_different', 'incident_corrections',
                'decision_approval', 'decision_assignment', 'decision_session_expiry',
                'decision_retention', 'decision_state_current', 'party_retirement',
                'decision_staff_retirement', 'decision_hold_conflict', 'decision_completion')


def source_gate74():
    require(FORMAL74_FOLDER is not None and FORMAL74_PREPARED is not None
            and len(FORMAL74_PROOFS) >= 2 and set(FORMAL74_PROOFS) == set(FORMAL74_EXPECTED)
            and all(isinstance(x, str) and re.fullmatch(r'[a-f0-9]{64}', x)
                    for x in (FORMAL74_MANIFEST_SHA, FORMAL74_EDGE_SHA, FORMAL74_DRIVER_SHA)),
            'FORMAL74_EXACT_PROOFS_PENDING')
    pins = {str(Path(__file__).resolve()): sha(Path(__file__).resolve())}
    for name, digest in FORMAL74_PROOFS.items():
        path = Path(name)
        require(path.is_absolute() and str(path).startswith('/private/tmp/') and sha(path) == digest,
                'FORMAL74_PROOF_PIN_INVALID')
        proof = json.loads(path.read_bytes())
        require(FORMAL74_EXPECTED[name], 'FORMAL74_EXPECTED_CONTRACT_PENDING')
        for selector, value in FORMAL74_EXPECTED[name].items():
            actual = proof
            for key in selector.split('.'):
                require(isinstance(actual, dict) and key in actual, 'FORMAL74_FIELD_MISSING')
                actual = actual[key]
            require(type(actual) is type(value) and actual == value, 'FORMAL74_NOT_APPROVED')
        pins[name] = digest
    prepared = Path(FORMAL74_PREPARED)
    for name, digest in (('migration-manifest.json', FORMAL74_MANIFEST_SHA), ('edge-manifest.json', FORMAL74_EDGE_SHA)):
        require(sha(prepared / name) == digest, 'PREPARED74_PIN_INVALID'); pins[str(prepared / name)] = digest
    manifest = json.loads((prepared / 'migration-manifest.json').read_bytes())
    edge = json.loads((prepared / 'edge-manifest.json').read_bytes())
    require(manifest['status'] == 'READY' and manifest['count'] == len(manifest['migrations']) == 74
            and edge['migration_count'] == 74 and len(edge['source_files']) == 52, 'PREPARED74_SHAPE_INVALID')
    versions = []
    for item in manifest['migrations']:
        require(re.fullmatch(r'backend/supabase/migrations/\d{14}_[a-z0-9_]+\.sql', item['path'])
                and re.fullmatch(r'\d{14}', item['version']) and Path(item['path']).name.startswith(item['version'] + '_'), 'SQL74_PATH_INVALID')
        for path in (SOURCE / item['path'], prepared / 'supabase/migrations' / Path(item['path']).name):
            require(sha(path) == item['sha256'], 'SQL74_CHANGED'); pins[str(path)] = item['sha256']
        versions.append(item['version'])
    require(len(set(versions)) == 74 and sorted(versions)[-1] == '20261005171606', 'VERSION74_SET_INVALID')
    for item in edge['source_files']:
        require('..' not in Path(item['path']).parts and item['path'].startswith('backend/supabase/functions/')
                and item['target'] == item['path'][len('backend/'):], 'EDGE74_PATH_INVALID')
        for path in (SOURCE / item['path'], prepared / item['target']):
            require(sha(path) == item['sha256'], 'EDGE74_CHANGED'); pins[str(path)] = item['sha256']
    folder = Path(FORMAL74_FOLDER)
    for name, digest in (('apply.py', FORMAL74_DRIVER_SHA),):
        require(sha(folder / name) == digest, 'FORMAL74_DRIVER_CHANGED'); pins[str(folder / name)] = digest
    application = json.loads((folder / 'application-receipt.json').read_bytes())
    require(application['status'] == 'PASS' and application['historyCount'] == 74
            and application['applicationCompleted'] is True and application['applicationStateUnknown'] is False
            and application['migrationHashes'] == {'20261005171606_assigned_report_adjudication.sql': SQL74_SHA}, 'FORMAL74_APPLICATION_INVALID')
    pre = json.loads((folder / 'preflight.json').read_bytes())
    post = json.loads((folder / 'postflight.json').read_bytes())
    after = json.loads((folder / 'schema-after.json').read_bytes())
    require(pre['catalog']['history'] == sorted(versions)[:-1]
            and post['history'] == after['catalog']['history'] == sorted(versions)
            and pre['audit'] == after['audit'] and len(after['audit']['ids']) == 288,
            'FORMAL74_HISTORY_OR_AUDIT_INVALID')
    return pins, sorted(versions)


class Driver74(Driver):
    source_version = 74

    def gate(self):
        return source_gate74()

    def extra_preflight(self):
        for table in ('private.assigned_report_adjudications', 'private.safety_incidents',
                      'private.safety_incident_revisions', 'private.safety_incident_subjects',
                      'private.safety_sanction_applications', 'private.sweetness_incident_decisions', 'private.sweetness_incidents'):
            require(self.baseline['counts'][table] == '0', 'SAFETY74_BASELINE_NOT_EMPTY')
        for sig in ('get_assigned_report_adjudication_state(uuid)', 'adjudicate_assigned_member_report(uuid,uuid,text,bigint,bigint,bigint,text,text,text,text,text,text)'):
            for role in ('anon', 'authenticated', 'service_role'):
                require(self.run('select has_function_privilege(' + quote(role) + ',' + quote('public.' + sig) + ",'EXECUTE');") == ('t' if role == 'authenticated' else 'f'), 'STAFF74_ACL_INVALID')

    def ready_case(self, **kwargs):
        case = self.case(**kwargs)
        a = Session(self); result = a.result(Driver.start(self, case)); a.release(True)
        require(result['version'] == 2, 'REVIEW_START74_FIXTURE_INVALID')
        case['decisionRequest'] = str(uuid.uuid4())
        return case

    def decide(self, case, request=None, mode='initial', report_version=2, hold_version=1,
               incident_revision=0, appointment_outcome=None, incident_outcome='none', role='none',
               reason=None, violation_class='none', violation_type=None):
        if appointment_outcome is None:
            appointment_outcome = 'normal' if case['appointment'] else 'unchanged'
        if not case['appointment']:
            hold_version = None
        if reason is None:
            reason = 'no_show' if appointment_outcome == 'no_show' else 'no_action'
        args = [case['report'], request or case['decisionRequest'], mode, report_version, hold_version,
                incident_revision, appointment_outcome, incident_outcome, role, reason, violation_class, violation_type]
        encoded = [('null' if x is None else str(x) if isinstance(x, int) else quote(x)) for x in args]
        return self.actor(case['staff']) + 'select public.adjudicate_assigned_member_report(' + ','.join(encoded) + ');'

    def read74(self, case):
        return self.actor(case['staff']) + 'select public.get_assigned_report_adjudication_state(' + quote(case['report']) + ');'

    def state74(self, case):
        rid = quote(case['report'])
        return self.value(f"""select 'VAL:'||jsonb_build_object('report',to_jsonb(r),
        'receipts',(select coalesce(jsonb_agg(to_jsonb(d)order by decision_id),'[]')from private.assigned_report_adjudications d where report_id={rid}),
        'audit',(select count(*)from private.report_access_audit where report_id={rid}),
        'holds',(select coalesce(jsonb_agg(to_jsonb(h)order by hold_id),'[]')from private.appointment_review_holds h where report_id={rid}),
        'incidents',(select coalesce(jsonb_agg(to_jsonb(i)order by id),'[]')from private.safety_incidents i where id in(select incident_id from private.safety_incident_report_links where report_id={rid})),
        'revisions',(select coalesce(jsonb_agg(to_jsonb(i)order by incident_id,revision),'[]')from private.safety_incident_revisions i where incident_id in(select incident_id from private.safety_incident_report_links where report_id={rid})),
        'subjects',(select coalesce(jsonb_agg(to_jsonb(i)order by incident_id,revision,identity_id),'[]')from private.safety_incident_subjects i where incident_id in(select incident_id from private.safety_incident_report_links where report_id={rid})),
        'applications',(select coalesce(jsonb_agg(to_jsonb(i)order by id),'[]')from private.safety_sanction_applications i where incident_id in(select incident_id from private.safety_incident_report_links where report_id={rid})),
        'sweetness',(select coalesce(jsonb_agg(to_jsonb(i)order by decision_id),'[]')from private.sweetness_incident_decisions i where incident_id in(select incident_id from private.safety_incident_report_links where report_id={rid})))::text
        from private.member_reports r where r.id={rid};""")

    def unchanged74(self, case, sql, code):
        before = self.state74(case); ap = self.ap_state(case) if case['appointment'] else None
        a = Session(self); a.send(sql + 'commit;'); a.finish(code)
        require(self.state74(case) == before and (ap is None or self.ap_state(case) == ap), 'FAILED74_NOT_ATOMIC')

    def no_final(self, case):
        r = self.state74(case)['report']
        require(r['status'] == 'reviewing' and r['final_closed_at'] is None and r['retention_due_at'] is None, 'DECISION74_FAKE_FINAL_CLOSE')

    def decision_duplicate(self):
        case = self.ready_case(appointment=True); a, b = self.pair()
        sql = self.decide(case, appointment_outcome='no_show', incident_outcome='confirmed', role='companion')
        first = a.result(sql); b.send(sql + 'commit;'); self.blocked(a, b, 'decision74_same_request_advisory')
        a.release(True); second = b.finish_json()
        require(first == second | {'alreadyApplied': False} and first['version'] == 3 and second['alreadyApplied'] is True, 'DECISION74_DUPLICATE_RESPONSE')
        state = self.state74(case)
        require(len(state['receipts']) == len(state['incidents']) == len(state['revisions']) == 1
                and state['holds'][0]['version'] == 2 and state['report']['review_version'] == 3
                and len(state['sweetness']) == 1, 'DECISION74_DUPLICATE_EFFECT')
        self.no_final(case)

    def decision_different(self):
        case = self.ready_case(appointment=True); a, b = self.pair()
        a.result(self.decide(case)); before = self.state74(case)
        b.send(self.decide(case, request=str(uuid.uuid4())) + 'commit;'); b.finish('40001')
        require(self.state74(case) == before, 'DIFFERENT74_PARTIAL_UNCOMMITTED')
        a.release(True); self.unchanged74(case, self.decide(case, request=str(uuid.uuid4())), '40001')
        c = Session(self); r = c.result(self.decide(case, request=str(uuid.uuid4()), mode='correction', report_version=3, hold_version=2)); c.release(True)
        require(r['version'] == 4 and len(self.state74(case)['receipts']) == 2, 'EXPLICIT_CORRECTION74_FAILED'); self.no_final(case)

    def incident_corrections(self):
        case = self.ready_case(appointment=True); a = Session(self)
        a.result(self.decide(case, appointment_outcome='no_show', incident_outcome='confirmed', role='companion')); a.release(True)
        original = self.state74(case); old_episode = original['subjects'][0]['source_episode_id']
        a, b = self.pair(); sql = self.decide(case, request=str(uuid.uuid4()), mode='correction', report_version=3, hold_version=2, incident_revision=1, incident_outcome='confirmed', role='companion', reason='threat', violation_class='major', violation_type='threat')
        a.result(sql); b.send(self.decide(case, request=str(uuid.uuid4()), mode='correction', report_version=3, hold_version=2, incident_revision=1, incident_outcome='confirmed', role='companion', reason='threat', violation_class='major', violation_type='threat') + 'commit;')
        self.blocked(a, b, 'original_incident74_advisory'); a.release(True); b.finish('40001')
        now = self.state74(case)
        require(now['incidents'][0]['id'] == original['incidents'][0]['id'] and now['incidents'][0]['current_revision'] == 2
                and all(x['source_episode_id'] == old_episode for x in now['subjects'])
                and len([x for x in now['applications'] if x['revoked_at'] is None]) == 1, 'ORIGINAL_INCIDENT74_CHANGED')
        # 후속 fixture에 영구 제한을 남기지 않는다. 실제 명시 무효 정정으로 이 사건만 복원한다.
        c = Session(self); c.result(self.decide(case, request=str(uuid.uuid4()), mode='correction', report_version=4, hold_version=3, incident_revision=2, incident_outcome='invalidated', reason='decision_corrected')); c.release(True)
        require(all(x['revoked_at'] is not None for x in self.state74(case)['applications']), 'INVALIDATION74_NOT_RECALCULATED')
        self.no_final(case)

    def revoke74(self, kind):
        for first in (True, False):
            case = self.ready_case(); a, b = self.pair()
            setter = f"select private.set_report_operator_{kind}({quote(self.staff)}," + (quote(case['report']) + ',' if kind == 'assignment' else '') + 'false);'
            before = self.state74(case)
            if first:
                a.mark(setter); b.send(self.decide(case) + 'commit;'); self.blocked(a, b, 'decision74_' + kind + '_revoke_first'); a.release(True); b.finish('42501')
                require(self.state74(case) == before, 'REVOKED74_MUTATED')
            else:
                a.result(self.decide(case)); b.send(setter + 'commit;'); self.blocked(a, b, 'decision74_' + kind + '_decision_first'); a.release(True); b.finish()
                self.unchanged74(case, self.decide(case), '42501'); self.unchanged74(case, self.read74(case), '42501')
            if kind == 'approval':
                self.run(f"begin;select private.set_report_operator_approval({quote(self.staff)},true);commit;")

    def decision_approval(self):
        self.revoke74('approval')

    def decision_assignment(self):
        self.revoke74('assignment')

    def decision_session_expiry(self):
        case = self.ready_case(appointment=True); sid = next(x['session'] for x in self.users if x['uid'] == self.staff)
        self.expire_after_barrier('auth.sessions', 'id=' + quote(sid), 'not_after')
        before, ap = self.state74(case), self.ap_state(case); a, b = self.pair()
        a.mark(f"select pg_advisory_xact_lock(hashtextextended({quote(self.staff+':'+case['decisionRequest'])},171606));")
        b.send(self.decide(case) + 'commit;'); self.blocked(a, b, 'decision74_request_advisory_expiry')
        self.wait_db_deadline(f"(select not_after from auth.sessions where id={quote(sid)})")
        a.release(False); b.finish('28000'); require(self.state74(case) == before and self.ap_state(case) == ap, 'EXPIRED74_PARTIAL_EFFECT')
        self.run(f"begin;update auth.sessions set not_after=null where id={quote(sid)};commit;")
        case = self.ready_case()
        self.expire_after_barrier('auth.sessions', 'id=' + quote(sid), 'not_after')
        before = self.state74(case); a, b = self.pair()
        a.mark(f"select 1 from private.member_reports where id={quote(case['report'])}for update;")
        b.send(self.read74(case) + 'commit;'); self.blocked(a, b, 'getter74_report_share_session_expiry')
        self.wait_db_deadline(f"(select not_after from auth.sessions where id={quote(sid)})")
        a.release(False); b.finish('28000'); require(self.state74(case) == before, 'EXPIRED_GETTER74_AUDIT_LEAKED')
        self.run(f"begin;update auth.sessions set not_after=null where id={quote(sid)};commit;")

    def decision_retention(self):
        # source CHECK를 만족하는 합성 owner 종결이다. 실제 통지·최종 종결 증거가 아니다.
        for mutation in (True, False):
            case = self.ready_case(); rid = quote(case['report'])
            self.run(f"begin;with deadline as(select clock_timestamp()+interval'5 seconds'as due)update private.member_reports set status='resolved',final_closed_at=d.due-interval'2160 hours',retention_due_at=d.due from deadline d where id={rid};commit;")
            before = self.state74(case); a, b = self.pair()
            if mutation:
                a.mark(f"select pg_advisory_xact_lock(hashtextextended({quote(self.staff+':'+case['decisionRequest'])},171606));")
                sql = self.decide(case)
            else:
                a.mark(f"select 1 from private.member_reports where id={rid}for update;"); sql = self.read74(case)
            b.send(sql + 'commit;'); self.blocked(a, b, 'decision74_retention_' + ('mutation' if mutation else 'getter'))
            self.wait_db_deadline(f'(select retention_due_at from private.member_reports where id={rid})'); a.release(False); b.finish('PT404')
            require(self.state74(case) == before, 'RETENTION74_PARTIAL_EFFECT_OR_AUDIT')

    def decision_state_current(self):
        for commit in (True, False):
            case = self.ready_case(appointment=True); a, b = self.pair()
            a.result(self.decide(case)); b.send(self.read74(case) + 'commit;'); self.blocked(a, b, 'decision74_state_report_share')
            a.release(commit); r = b.finish_json()
            require(r == {'reportId': case['report'], 'status': 'reviewing', 'version': 3 if commit else 2,
                          'holdVersion': 2 if commit else 1, 'incidentRevision': 0}, 'GETTER74_STALE_OR_UNCOMMITTED')
            require(self.state74(case)['audit'] == 1, 'GETTER74_AUDIT_NOT_EXACTLY_ONE')

    def party_retirement(self):
        # confirmed 약속 탈퇴 제한을 피해 가짜 상태를 만들지 않는다. 일반 report의 실제 당사자를 사용한다.
        for retire_first in (True, False):
            peer = self.member(); original = self.peer; self.peer = peer
            try:
                case = self.ready_case(); a, b = self.pair(); retirement = self.retire_sql(peer, str(uuid.uuid4()))
                before = self.state74(case)
                if retire_first:
                    a.result(retirement); b.send(self.decide(case) + 'commit;'); b.finish('40001'); require(self.state74(case) == before, 'PARTY_RETIRE74_PARTIAL_EFFECT'); a.release(True)
                else:
                    a.result(self.decide(case)); b.send(retirement + 'commit;'); self.blocked(a, b, 'party74_profile_episode_retire_wait'); a.release(True)
                    require(b.finish_json()['status'] == 'processing', 'PARTY_RETIRE74_FAKE_COMPLETED')
                require(self.cleanup_acl() == self.baseline_cleanup_acl, 'PARTY_RETIRE74_ACL_CHANGED')
            finally:
                self.peer = original

    def decision_staff_retirement(self):
        for retire_first in (True, False):
            staff = self.member(); self.run(f"begin;select private.set_report_operator_approval({quote(staff)},true);commit;")
            case = self.ready_case(staff=staff); a, b = self.pair(); before = self.state74(case)
            retirement = self.retire_sql(staff, str(uuid.uuid4()))
            if retire_first:
                a.result(retirement); b.send(self.decide(case) + 'commit;'); self.blocked(a, b, 'staff74_auth_session_delete_first'); a.release(True); b.finish('28000')
                require(self.state74(case) == before, 'RETIRED_STAFF74_MUTATED')
            else:
                a.result(self.decide(case)); b.send(retirement + 'commit;'); self.blocked(a, b, 'staff74_session_share_retire_delete_wait')
                require(self.run(f"select count(*)from private.member_retirements where profile_id={quote(staff)};") == '0', 'STAFF_RETIRE74_COMMITTED_BEFORE_DELETE')
                a.release(True); require(b.finish_json()['status'] == 'processing', 'STAFF_RETIRE74_FAKE_COMPLETED')
            self.unchanged74(case, self.read74(case), '28000')
            require(self.cleanup_acl() == self.baseline_cleanup_acl, 'STAFF_RETIRE74_ACL_CHANGED')

    def decision_hold_conflict(self):
        case = self.ready_case(appointment=True); a, b = self.pair(); before, ap = self.state74(case), self.ap_state(case)
        a.mark(f"select 1 from public.appointments where id={quote(case['appointment'])}for update;")
        b.send(self.decide(case) + 'commit;'); b.finish('40001'); require(self.state74(case) == before and self.ap_state(case) == ap, 'AP74_NOWAIT_PARTIAL_EFFECT'); a.release(False)
        # owner의 기존 hold resolver가 선행하면 기대 hold1은 stale이다.
        a = Session(self); a.result(f"select private.resolve_appointment_review((select hold_id from private.appointment_review_holds where report_id={quote(case['report'])}),{quote(case['appointment'])},1,gen_random_uuid(),'normal');"); a.release(True)
        self.unchanged74(case, self.decide(case), '40001')

    def decision_completion(self):
        for normal_first in (True, False):
            case = self.ready_case(appointment=True, completion=True); a, b = self.pair()
            if normal_first:
                a.result(self.decide(case)); b.send(self.confirm(case) + 'commit;'); self.blocked(a, b, 'normal74_completion_guard_or_ap_wait'); a.release(True); b.finish(); self.completed(case)
            else:
                # reviewing hold로 실제 완료 확인은 거절된다. 실패 TX가 AP 잠금을 유지한다고 추정하지 않는다.
                b.send(self.confirm(case) + 'commit;'); b.finish('22023')
                require(self.ap_state(case)['appointment']['completed_at'] is None, 'HOLD74_COMPLETION_BYPASS')
                a.result(self.decide(case)); a.release(True)
                c = Session(self); c.mark(self.confirm(case)); c.release(True); self.completed(case)
            self.no_final(case)
        case = self.ready_case(appointment=True, completion=True); a = Session(self)
        a.result(self.decide(case, appointment_outcome='no_show')); a.release(True)
        self.unchanged74(case, self.confirm(case), '22023')
        require(self.ap_state(case)['appointment']['status'] == 'no_show' and self.ap_state(case)['appointment']['completed_at'] is None, 'NO_SHOW74_COMPLETED')

    def extra_cleanup_sql(self, reports):
        # 74 추가 FK 원장은 report DELETE 전 namespace 사건만 자식→부모 순으로 정리한다.
        return f"""create temp table cleanup74_incidents as select distinct incident_id from private.safety_incident_report_links where report_id in({reports});
        do $$begin assert not exists(select 1 from private.safety_incident_report_links l where l.incident_id in(select incident_id from cleanup74_incidents)and l.report_id not in({reports}));end;$$;
        delete from private.assigned_report_adjudications where report_id in({reports});
        delete from private.safety_appeals where sanction_id in(select id from private.safety_sanction_applications where incident_id in(select incident_id from cleanup74_incidents));
        delete from private.safety_sanction_applications where incident_id in(select incident_id from cleanup74_incidents);
        delete from private.sweetness_incident_decisions where incident_id in(select incident_id from cleanup74_incidents);
        delete from private.sweetness_incidents where incident_id in(select incident_id from cleanup74_incidents);
        delete from private.safety_incident_subjects where incident_id in(select incident_id from cleanup74_incidents);
        delete from private.safety_incident_revisions where incident_id in(select incident_id from cleanup74_incidents);
        delete from private.safety_incident_report_links where incident_id in(select incident_id from cleanup74_incidents);
        delete from private.safety_incidents where id in(select incident_id from cleanup74_incidents);"""


# 정식75 proof는 root 전달 전까지 비워 두고 fixture 전 차단한다.
FORMAL75_FOLDER = Path('/private/tmp/yumidang-native75-rollout-reviewed')
FORMAL75_PREPARED = Path('/private/tmp/yumidang-policy75-agent-reviewed/prepared')
FORMAL75_MANIFEST_SHA = '0f3f9a30234349b2837673782655c59ec0af5e2750d9c630de244db59accdb10'
FORMAL75_EDGE_SHA = 'b459d05404f7599cb197028a1ec407872e653e12ca5b87f35a913071a3b314ca'
FORMAL75_DRIVER_SHA = '029c879902e18159607ddec59f4aa60187e650d21586edef35879a08cd6a2258'
FORMAL75_PROOFS = {'/private/tmp/yumidang-native75-rollout-reviewed/application-receipt.json': 'bdc4827ba529b26dce01f163edb53fcf01f6022b65a9cdaef3b44ac9a47543f7', '/private/tmp/yumidang-native75-rollout-reviewed/preflight.json': '3e93773b9bdec6c4153140c2b9744637734c87b1f8d944a97e6d7c732c173005', '/private/tmp/yumidang-native75-rollout-reviewed/postflight.json': 'd5a009fbab7d522399678804e79c8baa2106f6b7995c1edaf02ec7c0e576382c', '/private/tmp/yumidang-native75-rollout-reviewed/schema-after.json': '857cf946c8641b0ab8ff56d70294741170797122fb7faac942dd122c2d6e0225'}
FORMAL75_EXPECTED = {'/private/tmp/yumidang-native75-rollout-reviewed/application-receipt.json': {'status': 'PASS', 'scope': 'isolated_native74_to75_formal_cli', 'historyCount': 75, 'pendingAfter': 0, 'applicationCompleted': True, 'applicationStateUnknown': False, 'probeRollbackVerified': True, 'oldMetadataPreserved': True, 'authAudit288ExactIdsPayloadHashesPreserved': True, 'filesZero': True, 'guardFalse': True, 'workerIdle': True, 'protectedContainersUnchanged': True, 'priorProofsUnchanged': True, 'driverSha256': '029c879902e18159607ddec59f4aa60187e650d21586edef35879a08cd6a2258', 'manifestHash': '0f3f9a30234349b2837673782655c59ec0af5e2750d9c630de244db59accdb10', 'edgeHash': 'b459d05404f7599cb197028a1ec407872e653e12ca5b87f35a913071a3b314ca'}, '/private/tmp/yumidang-native75-rollout-reviewed/preflight.json': {'catalog.guard': False, 'catalog.idle': True}, '/private/tmp/yumidang-native75-rollout-reviewed/postflight.json': {'guard': False, 'idle': True}, '/private/tmp/yumidang-native75-rollout-reviewed/schema-after.json': {'catalog.guard': False, 'catalog.idle': True}}
SQL75_SHA = '880e62099cbb2f405da1e9035bcba2bdb0ff19c2f5a4d5222c63586240fbfc6b'
CASE75_NAMES = ('notice_duplicate', 'notice_logout_first', 'notice_logout_after',
                'notice_child_expiry', 'notice_ack_session_expiry', 'notice_ack_retention_expiry',
                'notice_list_retention_expiry', 'notice_correction', 'notice_report_delete_first',
                'notice_report_delete_after', 'notice_retire_first', 'notice_retire_after')


def source_gate75():
    require(FORMAL75_FOLDER is not None and FORMAL75_PREPARED is not None
            and len(FORMAL75_PROOFS) >= 2 and set(FORMAL75_PROOFS) == set(FORMAL75_EXPECTED)
            and all(isinstance(x, str) and re.fullmatch(r'[a-f0-9]{64}', x)
                    for x in (FORMAL75_MANIFEST_SHA, FORMAL75_EDGE_SHA, FORMAL75_DRIVER_SHA)),
            'FORMAL75_EXACT_PROOFS_PENDING')
    pins = {str(Path(__file__).resolve()): sha(Path(__file__).resolve())}
    for name, digest in FORMAL75_PROOFS.items():
        path = Path(name)
        require(path.is_absolute() and str(path).startswith('/private/tmp/') and sha(path) == digest,
                'FORMAL75_PROOF_PIN_INVALID')
        proof = json.loads(path.read_bytes())
        require(FORMAL75_EXPECTED[name], 'FORMAL75_EXPECTED_CONTRACT_PENDING')
        for selector, value in FORMAL75_EXPECTED[name].items():
            actual = proof
            for key in selector.split('.'):
                require(isinstance(actual, dict) and key in actual, 'FORMAL75_FIELD_MISSING')
                actual = actual[key]
            require(type(actual) is type(value) and actual == value, 'FORMAL75_NOT_APPROVED')
        pins[name] = digest
    prepared = Path(FORMAL75_PREPARED)
    for name, digest in (('migration-manifest.json', FORMAL75_MANIFEST_SHA), ('edge-manifest.json', FORMAL75_EDGE_SHA)):
        require(sha(prepared / name) == digest, 'PREPARED75_PIN_INVALID'); pins[str(prepared / name)] = digest
    manifest = json.loads((prepared / 'migration-manifest.json').read_bytes())
    edge = json.loads((prepared / 'edge-manifest.json').read_bytes())
    require(manifest['status'] == 'READY' and manifest['count'] == len(manifest['migrations']) == 75
            and edge['migration_count'] == 75 and len(edge['source_files']) == 52, 'PREPARED75_SHAPE_INVALID')
    versions = []
    for item in manifest['migrations']:
        require(re.fullmatch(r'backend/supabase/migrations/\d{14}_[a-z0-9_]+\.sql', item['path'])
                and re.fullmatch(r'\d{14}', item['version']) and Path(item['path']).name.startswith(item['version'] + '_'), 'SQL75_PATH_INVALID')
        for path in (SOURCE / item['path'], prepared / 'supabase/migrations' / Path(item['path']).name):
            require(sha(path) == item['sha256'], 'SQL75_CHANGED'); pins[str(path)] = item['sha256']
        versions.append(item['version'])
    require(len(set(versions)) == 75 and sorted(versions)[-1] == '20261005180340', 'VERSION75_SET_INVALID')
    for item in edge['source_files']:
        require('..' not in Path(item['path']).parts and item['path'].startswith('backend/supabase/functions/')
                and item['target'] == item['path'][len('backend/'):], 'EDGE75_PATH_INVALID')
        for path in (SOURCE / item['path'], prepared / item['target']):
            require(sha(path) == item['sha256'], 'EDGE75_CHANGED'); pins[str(path)] = item['sha256']
    folder = Path(FORMAL75_FOLDER)
    for name, digest in (('apply.py', FORMAL75_DRIVER_SHA),):
        require(sha(folder / name) == digest, 'FORMAL75_DRIVER_CHANGED'); pins[str(folder / name)] = digest
    application = json.loads((folder / 'application-receipt.json').read_bytes())
    require(application['status'] == 'PASS' and application['historyCount'] == 75
            and application['applicationCompleted'] is True and application['applicationStateUnknown'] is False
            and application['migrationHashes'] == {'20261005180340_assigned_report_notice_receipts.sql': SQL75_SHA}, 'FORMAL75_APPLICATION_INVALID')
    pre = json.loads((folder / 'preflight.json').read_bytes())
    post = json.loads((folder / 'postflight.json').read_bytes())
    after = json.loads((folder / 'schema-after.json').read_bytes())
    require(pre['catalog']['history'] == sorted(versions)[:-1]
            and post['history'] == after['catalog']['history'] == sorted(versions)
            and pre['audit'] == after['audit'] and len(after['audit']['ids']) == 288,
            'FORMAL75_HISTORY_OR_AUDIT_INVALID')
    return pins, sorted(versions)


class Driver75(Driver74):
    source_version = 75

    def __init__(self):
        super().__init__()
        self.notice_incidents = []; self.notice_decisions = []

    def durable(self):
        # report CASCADE가 link를 제거한 뒤에도 정확한 자기 복구 ID를 한 번에 fsync한다.
        private_json(self.artifact / 'fixture-recovery.json', {
            'scope': 'isolated_native75_two_session_sql_metadata_only',
            'namespace': self.namespace, 'users': self.users, 'posts': self.posts,
            'reports': self.reports, 'reportRequests': self.report_requests, 'members': self.members,
            'bucketCreated': self.bucket_created,
            'sessions': [{'pid': getattr(s, 'pid', None), 'applicationName': s.name} for s in self.sessions],
            'noticeIncidents': self.notice_incidents, 'noticeDecisions': self.notice_decisions,
            'remoteCompletionUncertain': self.remote_uncertain, 'autoRetry': False,
        })

    def gate(self):
        return source_gate75()

    def extra_preflight(self):
        super().extra_preflight()
        for table in ('private.assigned_report_decisions', 'private.member_decision_notices'):
            require(self.baseline['counts'][table] == '0', 'NOTICE75_BASELINE_NOT_EMPTY')
        for sig in ('list_my_decision_notices(integer,uuid)', 'read_my_decision_notice(uuid)'):
            for role in ('anon', 'authenticated', 'service_role'):
                require(self.run('select has_function_privilege(' + quote(role) + ',' + quote('public.' + sig) + ",'EXECUTE');") == ('t' if role == 'authenticated' else 'f'), 'NOTICE75_ACL_INVALID')

    def notice_case(self, appointment=False):
        # 사례 간 major/탈퇴/세션 제거가 다른 fixture에 영향을 주지 않도록 새 두 회원을 쓴다.
        old_owner, old_peer = self.owner, self.peer
        self.owner, self.peer = self.member(), self.member()
        try:
            case = self.ready_case(appointment=appointment)
            case['author'], case['recipient'] = self.owner, self.peer
        finally:
            self.owner, self.peer = old_owner, old_peer
        a = Session(self)
        result = a.result(self.decide(case, appointment_outcome='no_show' if appointment else 'unchanged',
                         incident_outcome='confirmed', role='both' if appointment else 'target',
                         reason='no_show' if appointment else 'threat',
                         violation_class='none' if appointment else 'major', violation_type=None if appointment else 'threat'))
        # 같은 미커밋 TX에서 자기 report의 incident를 읽고 COMMIT 이전에 journal에 남긴다.
        metadata = a.result("reset role;select jsonb_build_object('incidentId',(select incident_id from private.safety_incident_report_links where report_id=" + quote(case['report']) + '));')
        require(isinstance(metadata['incidentId'], str) and str(uuid.UUID(metadata['incidentId'])) == metadata['incidentId'], 'NOTICE75_OWN_INCIDENT_ID_INVALID')
        case['incident'] = metadata['incidentId']
        self.notice_decisions.append(result['decisionId']); self.notice_incidents.append(case['incident'])
        self.durable(); a.release(True)
        notice = self.value("select 'VAL:'||jsonb_build_object('id',n.id,'session',s.session_id)::text from private.member_decision_notices n join private.member_episodes e on e.id=n.recipient_episode_id join private.naver_sessions s on s.user_id=e.profile_id where n.decision_id=" + quote(result['decisionId']) + ' and e.profile_id=' + quote(case['recipient']) + ';')
        case['notice'], case['session'] = notice['id'], notice['session']
        return case

    def list75(self, case, before=None):
        return self.actor(case['recipient']) + 'select public.list_my_decision_notices(20,' + ('null' if before is None else quote(before)) + ');'

    def ack75(self, case):
        return self.actor(case['recipient']) + 'select public.read_my_decision_notice(' + quote(case['notice']) + ');'

    def notice_state(self, case):
        return self.value("select 'VAL:'||jsonb_build_object('notices',(select coalesce(jsonb_agg(to_jsonb(n)order by n.id),'[]')from private.member_decision_notices n where decision_id in(select decision_id from private.assigned_report_decisions where report_id=" + quote(case['report']) + ")),'decisions',(select coalesce(jsonb_agg(to_jsonb(d)order by d.decision_id),'[]')from private.assigned_report_decisions d where report_id=" + quote(case['report']) + '))::text;')

    def notice_exact(self, item, case, read=True):
        require(isinstance(item, dict) and set(item) == {'noticeId','appointmentId','appointmentOutcome','violationOutcome','reasonCode','violationClass','violationType','availableAt','firstReadAt'}, 'NOTICE75_PRIVATE_OR_EXTRA_FIELDS')
        require(item['noticeId'] == case['notice'] and item['appointmentId'] == case['appointment']
                and (item['firstReadAt'] is not None if read else item['firstReadAt'] is None), 'NOTICE75_ID_OR_ACK_INVALID')
        require(item['violationOutcome'] == 'confirmed' and item['reasonCode'] == ('no_show' if case['appointment'] else 'threat'), 'NOTICE75_OWN_EFFECT_INVALID')

    def notice_failure(self, case, sql, code):
        before, effects = self.notice_state(case), self.state74(case)
        a = Session(self); a.send(sql + 'commit;'); a.finish(code)
        require(self.notice_state(case) == before and self.state74(case) == effects, 'NOTICE75_FAILED_REQUEST_NOT_ATOMIC')

    def notice_duplicate(self):
        for commit in (True, False):
            case = self.notice_case(); a, b = self.pair()
            first = a.result(self.ack75(case)); b.send(self.ack75(case) + 'commit;')
            self.blocked(a, b, 'notice75_duplicate_ack_row'); a.release(commit); second = b.finish_json()
            self.notice_exact(first, case); self.notice_exact(second, case)
            require(first == second if commit else second['firstReadAt'] >= first['firstReadAt'], 'NOTICE75_FIRST_ACK_CHANGED')
            c = Session(self); repeated = c.result(self.ack75(case)); c.release(True)
            require(repeated == second, 'NOTICE75_REPEATED_ACK_CHANGED')

    def notice_logout_first(self):
        for ack in (False, True):
            for commit in (True, False):
                case = self.notice_case(); before = self.notice_state(case); a, b = self.pair()
                a.mark('delete from auth.sessions where id=' + quote(case['session']) + ';')
                b.send((self.ack75(case) if ack else self.list75(case)) + 'commit;')
                self.blocked(a, b, 'notice75_parent_delete_first'); a.release(commit)
                if commit:
                    b.finish('28000'); require(self.notice_state(case) == before, 'NOTICE75_LOGOUT_ACK_LEAK')
                    require(self.run('select count(*)from private.naver_sessions where session_id=' + quote(case['session']) + ';') == '0', 'NOTICE75_CHILD_CASCADE_MISSING')
                else:
                    result = b.finish_json()
                    if ack: self.notice_exact(result, case)
                    else: require(len(result['items']) == 1 and result['items'][0]['firstReadAt'] is None, 'NOTICE75_LOGOUT_ROLLBACK_LIST')

    def notice_logout_after(self):
        for ack in (False, True):
            case = self.notice_case(); a, b = self.pair()
            first = a.result(self.ack75(case) if ack else self.list75(case))
            b.send('delete from auth.sessions where id=' + quote(case['session']) + ';commit;')
            self.blocked(a, b, 'notice75_parent_share_delete_wait'); a.release(True); b.finish()
            if ack: self.notice_exact(first, case)
            else: require(first['items'][0]['firstReadAt'] is None, 'NOTICE75_LIST_AUTO_ACK')
            self.notice_failure(case, self.ack75(case), '28000')

    def notice_child_expiry(self):
        for ack in (False, True):
            case = self.notice_case(); before = self.notice_state(case); a, b = self.pair()
            self.expire_after_barrier('auth.sessions', 'id=' + quote(case['session']), 'not_after')
            a.mark('select 1 from private.naver_sessions where session_id=' + quote(case['session']) + ' for update;')
            b.send((self.ack75(case) if ack else self.list75(case)) + 'commit;')
            self.blocked(a, b, 'notice75_child_share_expiry')
            self.wait_db_deadline('(select not_after from auth.sessions where id=' + quote(case['session']) + ')')
            a.release(False); b.finish('28000'); require(self.notice_state(case) == before, 'NOTICE75_CHILD_WAIT_EFFECT')

    def notice_ack_session_expiry(self):
        case = self.notice_case(); before = self.notice_state(case); effects = self.state74(case); a, b = self.pair()
        self.expire_after_barrier('auth.sessions', 'id=' + quote(case['session']), 'not_after')
        a.mark('select 1 from private.member_decision_notices where id=' + quote(case['notice']) + ' for update;')
        b.send(self.ack75(case) + 'commit;'); self.blocked(a, b, 'notice75_ack_session_expiry')
        self.wait_db_deadline('(select not_after from auth.sessions where id=' + quote(case['session']) + ')')
        a.release(False); b.finish('28000')
        require(self.notice_state(case) == before and self.state74(case) == effects, 'NOTICE75_EXPIRED_SESSION_PARTIAL_ACK')

    def ttl75(self, case, future=True):
        # 합성 owner TTL 경계이며 실제 최종 종결/운영 purge 승인 증거가 아니다.
        self.run("begin;with d as(select clock_timestamp()+interval'" + ('5 seconds' if future else '-1 second') + "'as due)update private.member_reports set status='resolved',final_closed_at=d.due-interval'2160 hours',retention_due_at=d.due from d where id=" + quote(case['report']) + ';commit;')

    def notice_ack_retention_expiry(self):
        for report_lock in (False, True):
            case = self.notice_case(); self.ttl75(case); before = self.notice_state(case); effects = self.state74(case); a, b = self.pair()
            a.mark('select 1 from ' + ('private.member_reports where id=' + quote(case['report']) if report_lock else 'private.member_decision_notices where id=' + quote(case['notice'])) + ' for update;')
            b.send(self.ack75(case) + 'commit;'); self.blocked(a, b, 'notice75_ack_retention_' + ('report' if report_lock else 'notice'))
            self.wait_db_deadline('(select retention_due_at from private.member_reports where id=' + quote(case['report']) + ')')
            a.release(False); b.finish('PT404')
            require(self.notice_state(case) == before and self.state74(case) == effects, 'NOTICE75_EXPIRED_RETENTION_PARTIAL_ACK')

    def notice_list_retention_expiry(self):
        for cursor in (False, True):
            case = self.notice_case(); self.ttl75(case); before = self.notice_state(case); a, b = self.pair()
            a.mark('lock table private.member_decision_notices in access exclusive mode;')
            b.send(self.list75(case, case['notice'] if cursor else None) + 'commit;')
            self.blocked(a, b, 'notice75_list_query_before_ttl')
            self.wait_db_deadline('(select retention_due_at from private.member_reports where id=' + quote(case['report']) + ')')
            a.release(False)
            if cursor: b.finish('PT404')
            else: require(b.finish_json() == {'items': [], 'nextCursor': None}, 'NOTICE75_EXPIRED_LIST_LEAK')
            require(self.notice_state(case) == before, 'NOTICE75_LIST_ACK_SIDE_EFFECT')
        self.preservation['listReturnBoundaryInstrumentation'] = False
        self.preservation['listReturnBoundaryProof'] = 'separate_single_transaction_guard_hook_regression_only'

    def notice_correction(self):
        for commit in (True, False):
            case = self.notice_case(appointment=True); old = self.notice_state(case); a, b = self.pair()
            result = a.result(self.decide(case, request=str(uuid.uuid4()), mode='correction', report_version=3,
                     hold_version=2, incident_revision=1, appointment_outcome='no_show', incident_outcome='confirmed',
                     role='author', reason='no_show'))
            self.notice_decisions.append(result['decisionId']); self.durable()
            b.send(self.ack75(case) + 'commit;'); self.blocked(a, b, 'notice75_correction_report_share'); self.durable(); a.release(commit)
            self.notice_exact(b.finish_json(), case)
            page_session = Session(self); page = page_session.result(self.list75(case)); page_session.release(True)
            require(len(page['items']) == (2 if commit else 1), 'NOTICE75_CORRECTION_EVENT_COUNT')
            if commit:
                changed = [n for n in page['items'] if n['noticeId'] != case['notice']][0]
                require(changed['violationOutcome'] == 'invalidated' and changed['reasonCode'] == 'decision_corrected'
                        and changed['violationClass'] is None and changed['violationType'] is None
                        and changed['firstReadAt'] is None, 'NOTICE75_RESPONSIBILITY_CLEAR_LEAK')
            else:
                require(len(self.notice_state(case)['decisions']) == len(old['decisions']), 'NOTICE75_ROLLBACK_NOTICE_LEAK')

    def notice_report_delete_first(self):
        for ack in (False, True):
            for commit in (True, False):
                case = self.notice_case(); self.ttl75(case, False); a, b = self.pair()
                self.durable(); a.mark('delete from private.member_reports where id=' + quote(case['report']) + ';')
                b.send((self.ack75(case) if ack else self.list75(case)) + 'commit;')
                if ack:
                    self.blocked(a, b, 'notice75_report_delete_first_ack'); a.release(commit); b.finish('PT404')
                else:
                    # MVCC 목록은 row DELETE를 기다리지 않는다. 성공한 빈 페이지를 barrier로 꾸미지 않는다.
                    require(b.finish_json() == {'items': [], 'nextCursor': None}, 'NOTICE75_DELETE_EXPIRED_LIST_LEAK'); a.release(commit)
                require(len(self.notice_state(case)['decisions']) == (0 if commit else 1), 'NOTICE75_REPORT_CASCADE_INVALID')

    def notice_report_delete_after(self):
        case = self.notice_case(); a, b = self.pair(); item = a.result(self.ack75(case))
        self.durable(); b.send('delete from private.member_reports where id=' + quote(case['report']) + ';commit;')
        self.blocked(a, b, 'notice75_report_delete_after_ack'); a.release(True); b.finish(); self.notice_exact(item, case)
        require(self.notice_state(case) == {'notices': [], 'decisions': []}, 'NOTICE75_REPORT_CASCADE_REMAINED')
        c = Session(self); c.send(self.ack75(case) + 'commit;'); c.finish('PT404')

    def notice_retire_first(self):
        for commit in (True, False):
            case = self.notice_case(); before = self.notice_state(case); a, b = self.pair()
            a.result(self.retire_sql(case['recipient'], str(uuid.uuid4())))
            b.send(self.ack75(case) + 'commit;'); self.blocked(a, b, 'notice75_retire_guard_first'); a.release(commit)
            if commit:
                b.finish('42501'); require(self.notice_state(case) == before, 'NOTICE75_RETIRED_ACK_LEAK')
            else: self.notice_exact(b.finish_json(), case)
            require(self.cleanup_acl() == self.baseline_cleanup_acl, 'NOTICE75_RETIRE_ACL_CHANGED')

    def notice_retire_after(self):
        case = self.notice_case(); a, b = self.pair(); item = a.result(self.ack75(case))
        b.send(self.retire_sql(case['recipient'], str(uuid.uuid4())) + 'commit;')
        self.blocked(a, b, 'notice75_ack_retire_wait'); a.release(True)
        require(b.finish_json()['status'] == 'processing', 'NOTICE75_RETIRE_FAKE_COMPLETED'); self.notice_exact(item, case)
        c = Session(self); c.send(self.ack75(case) + 'commit;'); c.finish('42501')
        require(self.notice_state(case)['notices'][0]['first_read_at'] == item['firstReadAt'], 'NOTICE75_RETIRE_ERASED_ACK')
        require(self.cleanup_acl() == self.baseline_cleanup_acl, 'NOTICE75_RETIRE_ACL_CHANGED')

    def extra_cleanup_sql(self, reports):
        # 이미 report DELETE CASCADE가 지운 link의 incident도 자신이 저장한 UUID로만 정리한다.
        base = super().extra_cleanup_sql(reports)
        if self.notice_incidents:
            explicit = ','.join(quote(x) + '::uuid' for x in self.notice_incidents)
            base = base.replace('where report_id in(' + reports + ');', 'where report_id in(' + reports + ') union select unnest(array[' + explicit + ']);', 1)
        return ('delete from private.member_decision_notices where decision_id in(select decision_id from private.assigned_report_decisions where report_id in(' + reports + '));'
                + 'delete from private.assigned_report_decisions where report_id in(' + reports + ');' + base)


def self_check75():
    import ast
    ast.parse(Path(__file__).read_text())
    pins, versions = source_gate75()
    require(len(versions) == 75 and len(pins) > 250, 'OFFLINE75_PINS_INCOMPLETE')
    from unittest.mock import patch
    try:
        with patch.dict(globals(), {'FORMAL75_PROOFS': {}}):
            source_gate75()
    except Failure as error:
        require(str(error) == 'FORMAL75_EXACT_PROOFS_PENDING', 'OFFLINE75_GATE_WRONG_FAILURE')
    else:
        raise Failure('OFFLINE75_PENDING_GATE_OPEN')
    require(len(CASE75_NAMES) == len(set(CASE75_NAMES)) == 12 and all(callable(getattr(Driver75, name)) for name in CASE75_NAMES), 'NOTICE75_CASES_INVALID')
    dummy = object.__new__(Driver75); dummy.notice_incidents = ['11111111-1111-4111-8111-111111111111']; dummy.users = [{'uid': '22222222-2222-4222-8222-222222222222', 'session': '33333333-3333-4333-8333-333333333333'}]
    case = {'recipient': dummy.users[0]['uid'], 'notice': '44444444-4444-4444-8444-444444444444', 'report': '55555555-5555-4555-8555-555555555555'}
    for sql in (dummy.ack75(case), dummy.list75(case), dummy.list75(case, case['notice']), dummy.extra_cleanup_sql('select ' + quote(case['report']) + '::uuid')):
        require(not re.search(r'\d(?:and|where|for|or)\b', sql, re.I), 'NOTICE75_GENERATED_NUMERIC_KEYWORD')
    cleanup = dummy.extra_cleanup_sql('select ' + quote(case['report']) + '::uuid')
    require('union select unnest(array[' in cleanup and cleanup.index('delete from private.member_decision_notices') < cleanup.index('delete from private.assigned_report_decisions') < cleanup.index('delete from private.assigned_report_adjudications'), 'NOTICE75_CLEANUP_SCOPE_OR_ORDER')
    require('sanction_id in(select id from private.safety_sanction_applications' in cleanup, 'NOTICE75_APPEAL_FK_WRONG')
    # 파일만 사용하는 복구 모형: report link가 사라지고 메모리를 잃어도 disk UUID가 남는다.
    with tempfile.TemporaryDirectory(prefix='yumidang-notice75-journal-offline-', dir='/private/tmp') as directory:
        dummy.artifact = Path(directory); dummy.namespace = 'offline75-synthetic'
        dummy.posts = []; dummy.reports = [case['report']]; dummy.report_requests = []
        dummy.members = []; dummy.bucket_created = False; dummy.sessions = []; dummy.remote_uncertain = False
        dummy.notice_decisions = ['66666666-6666-4666-8666-666666666666']
        expected_incidents = list(dummy.notice_incidents); expected_decisions = list(dummy.notice_decisions)
        dummy.durable()
        dummy.notice_incidents = []; dummy.notice_decisions = []
        recovery = json.loads((dummy.artifact / 'fixture-recovery.json').read_bytes())
        require(recovery['noticeIncidents'] == expected_incidents and recovery['noticeDecisions'] == expected_decisions
                and recovery['reports'] == [case['report']] and recovery['autoRetry'] is False,
                'NOTICE75_CASCADE_DISK_RECOVERY_MISSING')
        require((dummy.artifact / 'fixture-recovery.json').stat().st_mode & 0o777 == 0o600, 'NOTICE75_JOURNAL_NOT_PRIVATE')
    print(json.dumps({'status': 'PASS', 'mode': 'offline75_only', 'cases': 12, 'dbExecution': False,
                      'incidentDecisionRecoveryIdsPersistedBeforeCommit': True,
                      'formalPendingDeniedBeforeFixtures': True, 'source73And74BranchesPreserved': True,
                      'listReturnInstrumentation': False, 'twoSessionProof': False}))


# 미래 정식76 정확 증거가 없으면 연결/fixture 전 차단한다. 사용자 지정 proof 경로는 받지 않는다.
FORMAL76_FOLDER = Path('/private/tmp/yumidang-native76-rollout-reviewed')
FORMAL76_PREPARED = Path('/private/tmp/yumidang-policy76-agent-reviewed/prepared')
FORMAL76_MANIFEST_SHA = '501144f17a46a8442d35ff24375c3f9c8ba941d9fb789f5b0adc21dc15a48621'
FORMAL76_EDGE_SHA = 'a22e2b20306de8eff3340e2c46c8ede3bda108c9fdf4516c509f693f286cd126'
FORMAL76_DRIVER_SHA = '689931b35bccca14958ef392109fd6184a923b893b0523cb84f28ffcfc89e0f1'
FORMAL76_PROOFS = {'/private/tmp/yumidang-native76-rollout-reviewed/application-receipt.json': '69c7dcf942a9de44669db19a398629b6e628a6d2bdc544a7f1db75d4222d32b9', '/private/tmp/yumidang-native76-rollout-reviewed/preflight.json': '49bc84cba04a595177e860bebf6b452a5d94677c0b315772bdc2b978095c738b', '/private/tmp/yumidang-native76-rollout-reviewed/postflight.json': '85ba674099ef61121bf1d42264d683ca6ed4f0d1ee1c870602e1cace430c8198', '/private/tmp/yumidang-native76-rollout-reviewed/schema-after.json': 'd42429bbef889c2e5c23d3eafcf31add980f634983ba72ebfeca28fdcd0f9cb7'}
FORMAL76_EXPECTED = {'/private/tmp/yumidang-native76-rollout-reviewed/application-receipt.json': {'status': 'PASS', 'scope': 'isolated_native75_to76_formal_cli', 'historyCount': 76, 'pendingAfter': 0, 'applicationCompleted': True, 'applicationStateUnknown': False, 'manifestHash': '501144f17a46a8442d35ff24375c3f9c8ba941d9fb789f5b0adc21dc15a48621', 'edgeHash': 'a22e2b20306de8eff3340e2c46c8ede3bda108c9fdf4516c509f693f286cd126', 'newFunctions': 4, 'newTables': 1, 'newColumns': 10, 'newConstraints': 12, 'newIndexes': 2, 'newTriggers': 1, 'oldMetadataPreserved': True, 'authAudit288ExactIdsPayloadHashesPreserved': True, 'filesZero': True, 'guardFalse': True, 'workerIdle': True, 'protectedContainersUnchanged': True, 'priorProofsUnchanged': True}, '/private/tmp/yumidang-native76-rollout-reviewed/preflight.json': {'catalog.guard': False}, '/private/tmp/yumidang-native76-rollout-reviewed/postflight.json': {'guard': False, 'idle': True}, '/private/tmp/yumidang-native76-rollout-reviewed/schema-after.json': {'catalog.guard': False}}
SQL76_SHA = '359a8093c3a32bf7d547a17df98173de677307933780a8e78db323bc4c26fcd8'
CASE76_NAMES = ('appeal_duplicate_cas', 'appeal_other_appointment_key', 'appeal_logout_first',
                'appeal_logout_after', 'appeal_child_expiry', 'appeal_receipt_session_expiry',
                'appeal_statement_deadline', 'appeal_report_delete_first', 'appeal_report_delete_after',
                'appeal_report_retention', 'appeal_retire_first', 'appeal_retire_after')


def source_gate76():
    require(FORMAL76_FOLDER is not None and FORMAL76_PREPARED is not None
            and len(FORMAL76_PROOFS) >= 2 and set(FORMAL76_PROOFS) == set(FORMAL76_EXPECTED)
            and all(isinstance(x, str) and re.fullmatch(r'[a-f0-9]{64}', x)
                    for x in (FORMAL76_MANIFEST_SHA, FORMAL76_EDGE_SHA, FORMAL76_DRIVER_SHA)),
            'FORMAL76_EXACT_PROOFS_PENDING')
    pins = {str(Path(__file__).resolve()): sha(Path(__file__).resolve())}
    for name, digest in FORMAL76_PROOFS.items():
        path = Path(name)
        require(path.is_absolute() and str(path).startswith('/private/tmp/') and sha(path) == digest,
                'FORMAL76_PROOF_PIN_INVALID')
        proof = json.loads(path.read_bytes())
        require(FORMAL76_EXPECTED[name], 'FORMAL76_EXPECTED_CONTRACT_PENDING')
        for selector, value in FORMAL76_EXPECTED[name].items():
            actual = proof
            for key in selector.split('.'):
                require(isinstance(actual, dict) and key in actual, 'FORMAL76_FIELD_MISSING')
                actual = actual[key]
            require(type(actual) is type(value) and actual == value, 'FORMAL76_NOT_APPROVED')
        pins[name] = digest
    prepared = Path(FORMAL76_PREPARED)
    for name, digest in (('migration-manifest.json', FORMAL76_MANIFEST_SHA), ('edge-manifest.json', FORMAL76_EDGE_SHA)):
        require(sha(prepared / name) == digest, 'PREPARED76_PIN_INVALID'); pins[str(prepared / name)] = digest
    manifest = json.loads((prepared / 'migration-manifest.json').read_bytes())
    edge = json.loads((prepared / 'edge-manifest.json').read_bytes())
    require(manifest['status'] == 'READY' and manifest['count'] == len(manifest['migrations']) == 76
            and edge['migration_count'] == 76 and len(edge['source_files']) == 52, 'PREPARED76_SHAPE_INVALID')
    versions = []
    for item in manifest['migrations']:
        require(re.fullmatch(r'backend/supabase/migrations/\d{14}_[a-z0-9_]+\.sql', item['path'])
                and re.fullmatch(r'\d{14}', item['version']) and Path(item['path']).name.startswith(item['version'] + '_'), 'SQL76_PATH_INVALID')
        for path in (SOURCE / item['path'], prepared / 'supabase/migrations' / Path(item['path']).name):
            require(sha(path) == item['sha256'], 'SQL76_CHANGED'); pins[str(path)] = item['sha256']
        versions.append(item['version'])
    require(len(set(versions)) == 76 and sorted(versions)[-1] == '20261005190311', 'VERSION76_SET_INVALID')
    for item in edge['source_files']:
        require('..' not in Path(item['path']).parts and item['path'].startswith('backend/supabase/functions/')
                and item['target'] == item['path'][len('backend/'):], 'EDGE76_PATH_INVALID')
        for path in (SOURCE / item['path'], prepared / item['target']):
            require(sha(path) == item['sha256'], 'EDGE76_CHANGED'); pins[str(path)] = item['sha256']
    folder = Path(FORMAL76_FOLDER)
    for name, digest in (('apply.py', FORMAL76_DRIVER_SHA),):
        require(sha(folder / name) == digest, 'FORMAL76_DRIVER_CHANGED'); pins[str(folder / name)] = digest
    application = json.loads((folder / 'application-receipt.json').read_bytes())
    require(application['status'] == 'PASS' and application['historyCount'] == 76
            and application['applicationCompleted'] is True and application['applicationStateUnknown'] is False
            and application['migrationHashes'] == {'20261005190311_appointment_cancel_appeal_intake.sql': SQL76_SHA}, 'FORMAL76_APPLICATION_INVALID')
    pre = json.loads((folder / 'preflight.json').read_bytes())
    post = json.loads((folder / 'postflight.json').read_bytes())
    after = json.loads((folder / 'schema-after.json').read_bytes())
    require(pre['catalog']['history'] == sorted(versions)[:-1]
            and post['history'] == after['catalog']['history'] == sorted(versions)
            and pre['audit'] == after['audit'] and len(after['audit']['ids']) == 288,
            'FORMAL76_HISTORY_OR_AUDIT_INVALID')
    return pins, sorted(versions)


class Driver76(Driver75):
    source_version = 76

    def __init__(self):
        super().__init__()
        self.appeal_cases = []; self.appeal_ids = []

    def durable(self):
        # 기존 notice 복구 ID와 함께 자기 cancellation AP/report/episode만 atomically 기록한다.
        private_json(self.artifact / 'fixture-recovery.json', {
            'scope': 'isolated_native76_two_session_sql_metadata_only',
            'namespace': self.namespace, 'users': self.users, 'posts': self.posts,
            'reports': self.reports, 'reportRequests': self.report_requests, 'members': self.members,
            'bucketCreated': self.bucket_created,
            'sessions': [{'pid': getattr(s, 'pid', None), 'applicationName': s.name} for s in self.sessions],
            'noticeIncidents': self.notice_incidents, 'noticeDecisions': self.notice_decisions,
            'appealCases': self.appeal_cases, 'appealIds': self.appeal_ids,
            'remoteCompletionUncertain': self.remote_uncertain, 'autoRetry': False,
        })

    def gate(self):
        return source_gate76()

    def extra_preflight(self):
        super().extra_preflight()
        for table in ('private.appointment_cancel_appeal_receipts', 'private.safety_appeals'):
            require(self.baseline['counts'][table] == '0', 'APPEAL76_BASELINE_NOT_EMPTY')
        for sig in ('submit_appointment_cancel_appeal(uuid,uuid,bigint,uuid)', 'get_my_appointment_cancel_appeal(uuid)'):
            for role in ('anon', 'authenticated', 'service_role'):
                require(self.run('select has_function_privilege(' + quote(role) + ',' + quote('public.' + sig) + ",'EXECUTE');") == ('t' if role == 'authenticated' else 'f'), 'APPEAL76_ACL_INVALID')

    def appeal_case(self, same_actor=None):
        old_owner, old_peer = self.owner, self.peer
        self.owner, self.peer = (same_actor['author'], same_actor['companion']) if same_actor else (self.member(), self.member())
        try:
            case = self.case(appointment=True)
            case['author'], case['companion'] = self.owner, self.peer
        finally:
            self.owner, self.peer = old_owner, old_peer
        case['appealRequest'] = str(uuid.uuid4())
        self.appeal_cases.append(case); self.durable()
        a = Session(self)
        a.result(self.actor(case['author']) + 'select public.cancel_appointment(' + quote(case['appointment']) + ',' + quote(str(uuid.uuid4())) + ",'합성 본인 취소 이의');")
        a.release(True)
        metadata = self.value("select 'VAL:'||jsonb_build_object('identity',h.identity_id,'episode',h.source_episode_id,'revision',h.current_revision,'session',s.session_id,'outcome',r.outcome)::text from private.safety_appointment_results h join private.member_episodes ep on ep.id=h.source_episode_id join private.naver_sessions s on s.user_id=ep.profile_id join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision where h.appointment_id=" + quote(case['appointment']) + ' and ep.profile_id=' + quote(case['author']) + ';')
        require(metadata['outcome'] == 'own_cancel' and isinstance(metadata['revision'], int) and 1 <= metadata['revision'] < 9007199254740991, 'APPEAL76_REAL_CANCEL_FIXTURE_INVALID')
        case.update(metadata); self.durable()
        return case

    def submit76(self, case, request=None, expected=None, report=None):
        return self.actor(case['author']) + 'select public.submit_appointment_cancel_appeal(' + ','.join((quote(case['appointment']),quote(request or case['appealRequest']),str(case['revision'] if expected is None else expected),quote(report or case['report']))) + ');'

    def get76(self, case):
        return self.actor(case['author']) + 'select public.get_my_appointment_cancel_appeal(' + quote(case['appointment']) + ');'

    def remember76(self, result):
        require(isinstance(result.get('appealId'), str) and str(uuid.UUID(result['appealId'])) == result['appealId'], 'APPEAL76_SERVER_ID_INVALID')
        if result['appealId'] not in self.appeal_ids:
            self.appeal_ids.append(result['appealId'])
        self.durable()

    def exact76(self, result, case, submit=True):
        keys = {'appealId','appointmentId','resultRevision','state','cancelledAt','deadlineAt','receivedAt','resolvedAt'}
        if submit: keys.add('alreadyApplied')
        require(isinstance(result, dict) and set(result) == keys and result['appointmentId'] == case['appointment'], 'APPEAL76_EXTRA_PRIVATE_FIELDS')
        require(result['resultRevision'] == case['revision'] + 1 and result['state'] == 'reviewing'
                and result['appealId'] is not None and result['receivedAt'] is not None and result['resolvedAt'] is None,
                'APPEAL76_SNAPSHOT_INVALID')
        if submit: require(type(result['alreadyApplied']) is bool, 'APPEAL76_REPLAY_FLAG_INVALID')

    def state76(self, case):
        ap, report = quote(case['appointment']), quote(case['report'])
        return self.value("select 'VAL:'||jsonb_build_object('appointment',(select to_jsonb(a)from public.appointments a where id=" + ap + "),'head',(select to_jsonb(h)from private.safety_appointment_results h where appointment_id=" + ap + ' and identity_id=' + quote(case['identity']) + "),'revisions',(select coalesce(jsonb_agg(to_jsonb(r)order by revision),'[]')from private.safety_appointment_result_revisions r where appointment_id=" + ap + ' and identity_id=' + quote(case['identity']) + "),'appeals',(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]')from private.safety_appeals a where kind='cancellation'and appointment_id=" + ap + "),'receipts',(select coalesce(jsonb_agg(to_jsonb(r)order by client_request_id),'[]')from private.appointment_cancel_appeal_receipts r where appointment_id=" + ap + "),'report',(select to_jsonb(r)from private.member_reports r where id=" + report + "),'audit',(select count(*)from private.report_access_audit where report_id=" + report + '))::text;')

    def fail76(self, case, sql, code):
        before = self.state76(case)
        a = Session(self); a.send(sql + 'commit;'); a.finish(code)
        require(self.state76(case) == before, 'APPEAL76_FAILED_TX_NOT_ATOMIC')

    def appeal_duplicate_cas(self):
        case = self.appeal_case(); a, b = self.pair()
        first = a.result(self.submit76(case)); self.remember76(first)
        b.send(self.submit76(case) + 'commit;'); b.finish('40001')  # AP/result NOWAIT는 실제 대기가 아니다.
        a.release(True); self.exact76(first, case)
        c = Session(self); replay = c.result(self.submit76(case)); self.remember76(replay); c.release(True)
        require(replay == first | {'alreadyApplied': True}, 'APPEAL76_REPLAY_CHANGED')
        state = self.state76(case)
        require(len(state['appeals']) == len(state['receipts']) == 1 and state['head']['current_revision'] == case['revision'] + 1, 'APPEAL76_DUPLICATE_EFFECT')
        self.fail76(case, self.submit76(case, expected=case['revision'] + 1), '40001')
        self.fail76(case, self.submit76(case, report=str(uuid.uuid4())), '40001')
        self.fail76(case, self.submit76(case, request=str(uuid.uuid4())), '55000')

    def appeal_other_appointment_key(self):
        for commit in (True, False):
            first_case = self.appeal_case(); second_case = self.appeal_case(same_actor=first_case)
            second_case['appealRequest'] = first_case['appealRequest']; self.durable()
            before = self.state76(second_case); a, b = self.pair()
            first = a.result(self.submit76(first_case)); self.remember76(first)
            b.send(self.submit76(second_case) + 'commit;'); self.blocked(a, b, 'appeal76_cross_ap_request_unique')
            a.release(commit)
            if commit:
                b.finish('40001'); require(self.state76(second_case) == before, 'APPEAL76_CROSS_AP_PARTIAL_RECEIPT')
            else:
                second = b.finish_json(); self.exact76(second, second_case); self.remember76(second)
                require(len(self.state76(first_case)['appeals']) == 0, 'APPEAL76_ROLLBACK_FIRST_EFFECT')

    def appeal_logout_first(self):
        for submit in (False, True):
            for commit in (True, False):
                case = self.appeal_case(); before = self.state76(case); a, b = self.pair()
                a.mark('delete from auth.sessions where id=' + quote(case['session']) + ';')
                b.send((self.submit76(case) if submit else self.get76(case)) + 'commit;')
                self.blocked(a, b, 'appeal76_parent_delete_first'); a.release(commit)
                if commit:
                    b.finish('28000'); require(self.state76(case) == before, 'APPEAL76_LOGOUT_PARTIAL')
                else:
                    result = b.finish_json()
                    if submit: self.exact76(result, case); self.remember76(result)
                    else: require(result['appealId'] is None and result['receivedAt'] is None, 'APPEAL76_ABSENT_GET_CHANGED')

    def appeal_logout_after(self):
        for submit in (False, True):
            case = self.appeal_case(); a, b = self.pair()
            first = a.result(self.submit76(case) if submit else self.get76(case))
            if submit: self.remember76(first)
            b.send('delete from auth.sessions where id=' + quote(case['session']) + ';commit;')
            self.blocked(a, b, 'appeal76_parent_share_delete_wait'); a.release(True); b.finish()
            self.fail76(case, self.get76(case), '28000')

    def appeal_child_expiry(self):
        for submit in (False, True):
            case = self.appeal_case(); before = self.state76(case); a, b = self.pair()
            self.expire_after_barrier('auth.sessions', 'id=' + quote(case['session']), 'not_after')
            a.mark('select 1 from private.naver_sessions where session_id=' + quote(case['session']) + ' for update;')
            b.send((self.submit76(case) if submit else self.get76(case)) + 'commit;'); self.blocked(a, b, 'appeal76_child_expiry')
            self.wait_db_deadline('(select not_after from auth.sessions where id=' + quote(case['session']) + ')')
            a.release(False); b.finish('28000'); require(self.state76(case) == before, 'APPEAL76_CHILD_EXPIRY_EFFECT')

    def appeal_receipt_session_expiry(self):
        case = self.appeal_case(); before = self.state76(case); a, b = self.pair()
        self.expire_after_barrier('auth.sessions', 'id=' + quote(case['session']), 'not_after')
        a.mark('lock table private.appointment_cancel_appeal_receipts in access exclusive mode;')
        b.send(self.submit76(case) + 'commit;'); self.blocked(a, b, 'appeal76_receipt_session_expiry')
        self.wait_db_deadline('(select not_after from auth.sessions where id=' + quote(case['session']) + ')')
        a.release(False); b.finish('28000'); require(self.state76(case) == before, 'APPEAL76_SESSION_AFTER_WAIT_PARTIAL')

    def appeal_statement_deadline(self):
        case = self.appeal_case()
        # 합성 clock fixture는 원 취소/현재 own_cancel의 일치까지 유지한다. 실제24시간 대기를 대신한다.
        self.run("begin;with t as(select clock_timestamp()-interval'24 hours'+interval'5 seconds'as cancelled)update private.appointment_cancellations set cancelled_at=t.cancelled from t where appointment_id=" + quote(case['appointment']) + ";update private.safety_appointment_result_revisions set cancellation_at=(select cancelled_at from private.appointment_cancellations where appointment_id=" + quote(case['appointment']) + ')where appointment_id=' + quote(case['appointment']) + ' and identity_id=' + quote(case['identity']) + ' and revision=' + str(case['revision']) + ';commit;')
        a, b = self.pair(); a.mark('lock table private.appointment_cancel_appeal_receipts in access exclusive mode;')
        b.send(self.submit76(case) + 'commit;'); self.blocked(a, b, 'appeal76_statement_before_deadline_wait')
        self.wait_db_deadline('(select cancelled_at+interval\'24 hours\'from private.appointment_cancellations where appointment_id=' + quote(case['appointment']) + ')')
        a.release(False); result = b.finish_json(); self.exact76(result, case); self.remember76(result)
        proof = self.value("select 'VAL:'||jsonb_build_object('receivedBeforeDeadline',a.received_at<a.deadline_at,'completedAfterDeadline',clock_timestamp()>=a.deadline_at,'sameCancellation',(a.deadline_at=(select cancelled_at+interval'24 hours'from private.appointment_cancellations where appointment_id=a.appointment_id)))::text from private.safety_appeals a where id=" + quote(result['appealId']) + ';')
        require(all(x is True for x in proof.values()), 'APPEAL76_TRUSTED_STATEMENT_CLOCK_INVALID')
        self.preservation['canonicalDbStatementBeforeDeadlineAfterWait'] = proof

    def appeal_report_delete_first(self):
        for commit in (True, False):
            case = self.appeal_case(); before = self.state76(case); a, b = self.pair()
            self.durable(); a.mark('delete from private.member_reports where id=' + quote(case['report']) + ';')
            b.send(self.submit76(case) + 'commit;'); b.finish('40001')  # report NOWAIT거절, barrier로 세지 않는다.
            a.release(commit)
            if commit:
                self.fail76(case, self.submit76(case), 'PT404')
                require(len(self.state76(case)['appeals']) == 0, 'APPEAL76_DELETED_REPORT_INTAKE')
            else:
                require(self.state76(case) == before, 'APPEAL76_REPORT_DELETE_ROLLBACK_EFFECT')
                c = Session(self); r = c.result(self.submit76(case)); self.remember76(r); c.release(True); self.exact76(r, case)

    def appeal_report_delete_after(self):
        for commit in (True, False):
            case = self.appeal_case(); a, b = self.pair()
            first = a.result(self.submit76(case)); self.remember76(first)
            self.durable(); b.send('delete from private.member_reports where id=' + quote(case['report']) + ';commit;')
            self.blocked(a, b, 'appeal76_intake_report_delete_wait'); a.release(commit)
            if commit:
                b.finish('55000'); require(len(self.state76(case)['appeals']) == 1, 'APPEAL76_PENDING_REPORT_DELETED')
            else:
                b.finish(); require(self.state76(case)['report'] is None and len(self.state76(case)['appeals']) == 0, 'APPEAL76_INTAKE_ROLLBACK_DELETE_EFFECT')

    def appeal_report_retention(self):
        case = self.appeal_case()
        # 아직 이의가 없는 자기 report의 owner TTL metadata negative fixture이며 실제종결 workflow가 아니다.
        self.run("begin;with d as(select clock_timestamp()+interval'5 seconds'as due)update private.member_reports set status='resolved',final_closed_at=d.due-interval'2160 hours',retention_due_at=d.due from d where id=" + quote(case['report']) + ';commit;')
        before = self.state76(case); a, b = self.pair()
        a.mark('lock table private.appointment_cancel_appeal_receipts in access exclusive mode;')
        b.send(self.submit76(case) + 'commit;'); self.blocked(a, b, 'appeal76_report_ttl_before_row_query')
        self.wait_db_deadline('(select retention_due_at from private.member_reports where id=' + quote(case['report']) + ')')
        a.release(False); b.finish('PT404'); require(self.state76(case) == before, 'APPEAL76_TTL_AFTER_WAIT_PARTIAL')

    def appeal_retire_first(self):
        for submit in (False, True):
            for commit in (True, False):
                case = self.appeal_case(); before = self.state76(case); a, b = self.pair()
                a.result(self.retire_sql(case['author'], str(uuid.uuid4())))
                b.send((self.submit76(case) if submit else self.get76(case)) + 'commit;')
                self.blocked(a, b, 'appeal76_retire_guard_first'); a.release(commit)
                if commit:
                    b.finish('42501'); require(self.state76(case) == before, 'APPEAL76_RETIRED_INTAKE_PARTIAL')
                else:
                    r = b.finish_json()
                    if submit: self.exact76(r, case); self.remember76(r)
                require(self.cleanup_acl() == self.baseline_cleanup_acl, 'APPEAL76_RETIRE_ACL_CHANGED')

    def appeal_retire_after(self):
        for submit in (False, True):
            case = self.appeal_case(); a, b = self.pair()
            first = a.result(self.submit76(case) if submit else self.get76(case))
            if submit: self.remember76(first)
            b.send(self.retire_sql(case['author'], str(uuid.uuid4())) + 'commit;'); self.blocked(a, b, 'appeal76_management_share_retire_wait')
            a.release(True); require(b.finish_json()['status'] == 'processing', 'APPEAL76_RETIRE_FAKE_COMPLETED')
            self.fail76(case, self.get76(case), '42501')
            require(len(self.state76(case)['appeals']) == (1 if submit else 0) and self.cleanup_acl() == self.baseline_cleanup_acl, 'APPEAL76_RETIRE_DETAIL_OR_ACL_CHANGED')

    def cleanup(self):
        # 자기 client rollback/종료만 시도한다. 결과 불확실 상태는 PID 종료 여부와
        # 관계없이 자동 fixture DELETE를 금지하고 journal/FAIL을 남긴다.
        for session in self.sessions:
            try:
                session.close()
            except Exception:
                self.remote_uncertain = True
        if self.remote_uncertain:
            self.preservation['automaticMutativeCleanupBlocked'] = True
            self.durable()
            raise Failure('SOURCE76_REMOTE_COMPLETION_UNCERTAIN_NO_MUTATIVE_CLEANUP')
        # 정상 경로는 기존 exact PID/namespace/다른 TX 확인과 namespace 정리를 유지한다.
        return super().cleanup()

    def extra_cleanup_sql(self, reports):
        # reviewing 삭제guard를 우회하지 않고 먼저 자기 cancellation 상세만 child-first 정리한다.
        appointments = ','.join(quote(c['appointment']) for c in self.appeal_cases)
        episodes = ','.join(quote(c['episode']) for c in self.appeal_cases if c.get('episode'))
        prefix = ''
        if appointments and episodes:
            prefix = 'delete from private.appointment_cancel_appeal_receipts where appointment_id in(' + appointments + ')and source_episode_id in(' + episodes + ');delete from private.safety_appeals where kind=\'cancellation\'and appointment_id in(' + appointments + ')and source_episode_id in(' + episodes + ');'
        # 실제 취소가 만든 AP 결과 FK는 public.appointments/profile/identity보다 먼저 제거한다.
        if appointments:
            prefix += 'delete from private.safety_appointment_result_revisions where appointment_id in(' + appointments + ');delete from private.safety_appointment_results where appointment_id in(' + appointments + ');'
        return prefix + super().extra_cleanup_sql(reports)


def self_check76():
    import ast
    ast.parse(Path(__file__).read_text())
    pins, versions = source_gate76()
    saved = dict(FORMAL76_PROOFS)
    FORMAL76_PROOFS.clear()
    try:
        try:
            source_gate76()
        except Failure as error:
            require(str(error) == 'FORMAL76_EXACT_PROOFS_PENDING', 'OFFLINE76_GATE_WRONG_FAILURE')
        else:
            raise Failure('OFFLINE76_PENDING_GATE_OPEN')
    finally:
        FORMAL76_PROOFS.update(saved)
    first = next(iter(FORMAL76_PROOFS)); FORMAL76_PROOFS[first] = '0' * 64
    try:
        try:
            source_gate76()
        except Failure as error:
            require(str(error) == 'FORMAL76_PROOF_PIN_INVALID', 'OFFLINE76_TAMPER_WRONG_FAILURE')
        else:
            raise Failure('OFFLINE76_TAMPER_GATE_OPEN')
    finally:
        FORMAL76_PROOFS.update(saved)
    require(len(CASE76_NAMES) == len(set(CASE76_NAMES)) == 12 and all(callable(getattr(Driver76, name)) for name in CASE76_NAMES), 'APPEAL76_CASES_INVALID')
    dummy = object.__new__(Driver76); dummy.notice_incidents = []; dummy.notice_decisions = []
    dummy.users = [{'uid': '11111111-1111-4111-8111-111111111111','session':'22222222-2222-4222-8222-222222222222'}]
    case = {'author':dummy.users[0]['uid'],'appointment':'33333333-3333-4333-8333-333333333333','appealRequest':'44444444-4444-4444-8444-444444444444','report':'55555555-5555-4555-8555-555555555555','revision':2,'episode':'66666666-6666-4666-8666-666666666666'}
    dummy.appeal_cases = [case]; dummy.appeal_ids = ['77777777-7777-4777-8777-777777777777']
    cleanup = dummy.extra_cleanup_sql('select '+quote(case['report'])+'::uuid')
    for sql in (dummy.submit76(case), dummy.get76(case), cleanup):
        require(not re.search(r'\d(?:and|where|for|or)\b',sql,re.I), 'APPEAL76_NUMERIC_KEYWORD')
    require(cleanup.index('delete from private.appointment_cancel_appeal_receipts')<cleanup.index('delete from private.safety_appeals')<cleanup.index('delete from private.safety_appointment_result_revisions')<cleanup.index('delete from private.safety_appointment_results'), 'APPEAL76_CHILD_CLEANUP_ORDER')
    require('source_episode_id in(' in cleanup and "kind='cancellation'" in cleanup, 'APPEAL76_NAMESPACE_EPISODE_SCOPE')
    with tempfile.TemporaryDirectory(prefix='yumidang-appeal76-journal-offline-',dir='/private/tmp')as directory:
        dummy.artifact=Path(directory);dummy.namespace='offline76-synthetic';dummy.posts=[];dummy.reports=[case['report']];dummy.report_requests=[];dummy.members=[];dummy.bucket_created=False;dummy.sessions=[];dummy.remote_uncertain=False
        dummy.durable(); dummy.appeal_cases=[];dummy.appeal_ids=[]
        saved=json.loads((dummy.artifact/'fixture-recovery.json').read_bytes())
        require(saved['appealCases']==[case]and saved['appealIds']==['77777777-7777-4777-8777-777777777777']and saved['autoRetry']is False, 'APPEAL76_JOURNAL_DISK_IDS_MISSING')
        require((dummy.artifact/'fixture-recovery.json').stat().st_mode&0o777==0o600, 'APPEAL76_PRIVATE_JOURNAL_INVALID')
    from unittest.mock import patch
    from types import SimpleNamespace
    # 원격 불확실 flag, 자기 close 중 불확실 전환, close 실패 모두 DELETE 경로에 못 간다.
    for scenario in ('already_uncertain', 'close_uncertain', 'close_failure'):
        probe = object.__new__(Driver76); probe.preservation = {}; probe.remote_uncertain = scenario == 'already_uncertain'
        calls = []
        def close():
            calls.append('close')
            if scenario == 'close_uncertain': probe.remote_uncertain = True
            if scenario == 'close_failure': raise Failure('OFFLINE_CLOSE_FAILURE')
        probe.sessions = [SimpleNamespace(close=close)]
        probe.durable = lambda: calls.append('journal')
        probe.run = lambda *a, **k: (_ for _ in ()).throw(Failure('OFFLINE_CLEANUP_DB_FORBIDDEN'))
        with patch.object(Driver75, 'cleanup', side_effect=Failure('OFFLINE_MUTATIVE_CLEANUP_FORBIDDEN')) as inherited:
            try:
                probe.cleanup()
            except Failure as error:
                require(str(error) == 'SOURCE76_REMOTE_COMPLETION_UNCERTAIN_NO_MUTATIVE_CLEANUP', 'UNCERTAIN76_CLEANUP_WRONG_FAILURE')
            else:
                raise Failure('UNCERTAIN76_CLEANUP_OPEN')
            require(inherited.call_count == 0 and calls == ['close', 'journal']
                    and probe.preservation['automaticMutativeCleanupBlocked'] is True, 'UNCERTAIN76_AUTOMATIC_DELETE_REACHED')
    probe.remote_uncertain = False; probe.sessions = []
    with patch.object(Driver75, 'cleanup', return_value='normal_cleanup') as inherited:
        require(probe.cleanup() == 'normal_cleanup' and inherited.call_count == 1, 'NORMAL76_CLEANUP_NOT_PRESERVED')
    print(json.dumps({'status':'PASS','mode':'offline76_only','cases':12,'formal76PinsChecked':len(pins),'historyVersions':len(versions),'missingAndTamperedProofDeniedBeforeFixtures':True,'journalDiskRecoveryChecked':True,'uncertainAutomaticWritesBlocked':True,'normalCleanupDispatchPreserved':True,'dbExecution':False,'twoSessionProof':False}))


# 정식77 fixed proof 없이는 fixture/API를 시작하지 않는다.
FORMAL77_FOLDER = Path('/private/tmp/yumidang-native77-rollout-reviewed')
FORMAL77_PREPARED = Path('/private/tmp/yumidang-policy77-agent-reviewed/prepared')
FORMAL77_MANIFEST_SHA = '501bc9a741a6c64a6ebf7c5a5bd77aebb93dc7fb99b7a2d1b2eff444e3e04ee8'
FORMAL77_EDGE_SHA = 'e9ee9553ad57abe350aa0b1bc982446b79b062d9f1554e865ed7365e865b654e'
FORMAL77_DRIVER_SHA = '63def4cfee23670d7995953d9c24de40f94545f52b059af101c9c54090b2b577'
SQL77_SHA = '53750fc93d7edf48ff863807ccfa267c3e759213d55385b3d0d28103ec71f745'
FORMAL77_PROOFS = {'/private/tmp/yumidang-native77-rollout-reviewed/application-receipt.json': '1b24b7d643cac797391a39e46f5a533aa2bf7b24962eca881b54b6f84891c799', '/private/tmp/yumidang-native77-rollout-reviewed/preflight.json': 'd3fbf7a5ca56b8e7f738469aa6ffea411bdd2f2a362acd8b34291e75c0f3af5b', '/private/tmp/yumidang-native77-rollout-reviewed/postflight.json': 'e57f493f359b0cd4f4a20809d5f7335cc571a1539a87b015d8e23462ae75cdf9', '/private/tmp/yumidang-native77-rollout-reviewed/schema-after.json': '75144f0b37bcfd29796f60cae1e5a2c18743ef7a8d0e944b257c4aeb3c609a03'}
FORMAL77_EXPECTED = {'/private/tmp/yumidang-native77-rollout-reviewed/application-receipt.json': {'status': 'PASS', 'scope': 'isolated_native76_to77_formal_cli', 'historyCount': 77, 'pendingAfter': 0, 'applicationCompleted': True, 'applicationStateUnknown': False, 'manifestHash': '501bc9a741a6c64a6ebf7c5a5bd77aebb93dc7fb99b7a2d1b2eff444e3e04ee8', 'edgeHash': 'e9ee9553ad57abe350aa0b1bc982446b79b062d9f1554e865ed7365e865b654e', 'newFunctions': 1, 'newTables': 1, 'newColumns': 3, 'newConstraints': 3, 'newIndexes': 1, 'newTriggers': 0, 'probeRollbackVerified': True, 'oldMetadataPreserved': True, 'authAudit288ExactIdsPayloadHashesPreserved': True, 'filesZero': True, 'guardFalse': True, 'workerIdle': True, 'protectedContainersUnchanged': True, 'priorProofsUnchanged': True}, '/private/tmp/yumidang-native77-rollout-reviewed/preflight.json': {'catalog.guard': False}, '/private/tmp/yumidang-native77-rollout-reviewed/postflight.json': {'guard': False, 'idle': True}, '/private/tmp/yumidang-native77-rollout-reviewed/schema-after.json': {'catalog.guard': False}}
CASE77_NAMES = ('atomic_duplicate', 'atomic_legacy_report', 'atomic_other_appointment',
                'atomic_ap_result_nowait', 'atomic_sorted_capture', 'atomic_capture_cancel',
                'atomic_capture_metadata', 'atomic_session_request_wait', 'atomic_statement_deadline',
                'atomic_report_delete', 'atomic_logout_retire', 'atomic_binding_session_expiry')


def source_gate77():
    require(FORMAL77_FOLDER is not None and FORMAL77_PREPARED is not None
            and len(FORMAL77_PROOFS) >= 2 and set(FORMAL77_PROOFS) == set(FORMAL77_EXPECTED)
            and all(isinstance(x, str) and re.fullmatch(r'[a-f0-9]{64}', x)
                    for x in (FORMAL77_MANIFEST_SHA, FORMAL77_EDGE_SHA, FORMAL77_DRIVER_SHA)),
            'FORMAL77_EXACT_PROOFS_PENDING')
    pins = {str(Path(__file__).resolve()): sha(Path(__file__).resolve())}
    for name, digest in FORMAL77_PROOFS.items():
        path = Path(name)
        require(path.is_absolute() and str(path).startswith('/private/tmp/') and sha(path) == digest,
                'FORMAL77_PROOF_PIN_INVALID')
        proof = json.loads(path.read_bytes())
        require(FORMAL77_EXPECTED[name], 'FORMAL77_EXPECTED_CONTRACT_PENDING')
        for selector, value in FORMAL77_EXPECTED[name].items():
            actual = proof
            for key in selector.split('.'):
                require(isinstance(actual, dict) and key in actual, 'FORMAL77_FIELD_MISSING')
                actual = actual[key]
            require(type(actual) is type(value) and actual == value, 'FORMAL77_NOT_APPROVED')
        pins[name] = digest
    prepared = Path(FORMAL77_PREPARED)
    for name, digest in (('migration-manifest.json', FORMAL77_MANIFEST_SHA), ('edge-manifest.json', FORMAL77_EDGE_SHA)):
        require(sha(prepared / name) == digest, 'PREPARED77_PIN_INVALID'); pins[str(prepared / name)] = digest
    manifest = json.loads((prepared / 'migration-manifest.json').read_bytes())
    edge = json.loads((prepared / 'edge-manifest.json').read_bytes())
    require(manifest['status'] == 'READY' and manifest['count'] == len(manifest['migrations']) == 77
            and edge['migration_count'] == 77 and len(edge['source_files']) == 52, 'PREPARED77_SHAPE_INVALID')
    versions = []
    for item in manifest['migrations']:
        require(re.fullmatch(r'backend/supabase/migrations/\d{14}_[a-z0-9_]+\.sql', item['path'])
                and re.fullmatch(r'\d{14}', item['version']) and Path(item['path']).name.startswith(item['version'] + '_'), 'SQL77_PATH_INVALID')
        for path in (SOURCE / item['path'], prepared / 'supabase/migrations' / Path(item['path']).name):
            require(sha(path) == item['sha256'], 'SQL77_CHANGED'); pins[str(path)] = item['sha256']
        versions.append(item['version'])
    require(len(set(versions)) == 77 and sorted(versions)[-1] == '20261005195033', 'VERSION77_SET_INVALID')
    for item in edge['source_files']:
        require('..' not in Path(item['path']).parts and item['path'].startswith('backend/supabase/functions/')
                and item['target'] == item['path'][len('backend/'):], 'EDGE77_PATH_INVALID')
        for path in (SOURCE / item['path'], prepared / item['target']):
            require(sha(path) == item['sha256'], 'EDGE77_CHANGED'); pins[str(path)] = item['sha256']
    folder = Path(FORMAL77_FOLDER)
    for name, digest in (('apply.py', FORMAL77_DRIVER_SHA),):
        require(sha(folder / name) == digest, 'FORMAL77_DRIVER_CHANGED'); pins[str(folder / name)] = digest
    application = json.loads((folder / 'application-receipt.json').read_bytes())
    require(application['status'] == 'PASS' and application['historyCount'] == 77
            and application['applicationCompleted'] is True and application['applicationStateUnknown'] is False
            and application['migrationHashes'] == {'20261005195033_appointment_cancel_appeal_atomic_report.sql': SQL77_SHA}, 'FORMAL77_APPLICATION_INVALID')
    pre = json.loads((folder / 'preflight.json').read_bytes())
    post = json.loads((folder / 'postflight.json').read_bytes())
    after = json.loads((folder / 'schema-after.json').read_bytes())
    require(pre['catalog']['history'] == sorted(versions)[:-1]
            and post['history'] == after['catalog']['history'] == sorted(versions)
            and pre['audit'] == after['audit'] and len(after['audit']['ids']) == 288,
            'FORMAL77_HISTORY_OR_AUDIT_INVALID')
    return pins, sorted(versions)


class Driver77(Driver76):
    source_version = 77

    def __init__(self):
        super().__init__()
        self.atomic_cases = []; self.atomic_assets = []

    def durable(self):
        private_json(self.artifact / 'fixture-recovery.json', {
            'scope': 'isolated_native77_two_session_sql_metadata_only', 'namespace': self.namespace,
            'users': self.users, 'posts': self.posts, 'reports': self.reports,
            'reportRequests': self.report_requests, 'members': self.members, 'bucketCreated': self.bucket_created,
            'sessions': [{'pid': getattr(s, 'pid', None), 'applicationName': s.name} for s in self.sessions],
            'noticeIncidents': self.notice_incidents, 'noticeDecisions': self.notice_decisions,
            'appealCases': self.appeal_cases, 'appealIds': self.appeal_ids,
            'atomicCases': self.atomic_cases, 'atomicAssets': self.atomic_assets,
            'remoteCompletionUncertain': self.remote_uncertain, 'autoRetry': False,
        })

    def gate(self):
        return source_gate77()

    def extra_preflight(self):
        super().extra_preflight()
        require(self.baseline['counts']['private.appointment_cancel_appeal_report_bindings'] == '0', 'ATOMIC77_BINDING_BASELINE_NOT_EMPTY')
        for role in ('anon', 'authenticated', 'service_role'):
            require(self.run('select has_function_privilege(' + quote(role) + ',' + quote('public.submit_appointment_cancel_appeal_with_report(uuid,uuid,bigint,text[],text,uuid[],boolean)') + ",'EXECUTE');") == ('t' if role == 'authenticated' else 'f'), 'ATOMIC77_RPC_ACL_INVALID')

    def atomic_case(self, same_actor=None, assets=1):
        case = self.appeal_case(same_actor)
        case['atomicAssets'] = []; case['atomicRequest'] = str(uuid.uuid4())
        self.report_requests.append(case['atomicRequest']); self.atomic_cases.append(case); self.durable()
        for _ in range(assets):
            asset = {'id': str(uuid.uuid4()), 'owner': case['author'], 'episode': case['episode']}
            asset['path'] = asset['owner'] + '/' + asset['id'] + '.jpg'
            self.atomic_assets.append(asset); case['atomicAssets'].append(asset['id']); self.durable()
            a = Session(self); reserved = a.result(self.actor(case['author']) + 'select public.reserve_report_capture(' + quote(asset['id']) + ",'jpg');"); a.release(True)
            require(reserved['bucket'] == 'report-evidence' and reserved['path'] == asset['path'], 'ATOMIC77_CAPTURE_PATH_INVALID')
            self.run("begin;insert into storage.objects(bucket_id,name,owner_id,metadata)values('report-evidence'," + quote(asset['path']) + ',' + quote(asset['owner']) + ",'{}'::jsonb||jsonb_build_object('mimetype','image/jpeg','size',128));commit;")
            b = Session(self); b.result(self.actor(case['author']) + 'select public.confirm_report_capture(' + quote(asset['id']) + ');'); b.release(True)
        return case

    def atomic77(self, case, *, expected=None, request=None, assets=None, description='합성 원자 접수'):
        asset_ids = case['atomicAssets'] if assets is None else assets
        array = 'array[' + ','.join(quote(x) + '::uuid' for x in asset_ids) + ']::uuid[]'
        return self.actor(case['author']) + 'select public.submit_appointment_cancel_appeal_with_report(' + ','.join((quote(case['appointment']), quote(request or case['atomicRequest']), str(case['revision'] if expected is None else expected), "array['other','no_show']", quote(description), array, 'true')) + ');'

    def remember77(self, result, case):
        require(set(result) == {'reportId','appealId','appointmentId','resultRevision','state','cancelledAt','deadlineAt','receivedAt','resolvedAt','alreadyApplied'}, 'ATOMIC77_EXACT10_INVALID')
        report_id = result['reportId']; require(str(uuid.UUID(report_id)) == report_id, 'ATOMIC77_SERVER_REPORT_INVALID')
        self.exact76({k:v for k,v in result.items() if k != 'reportId'}, case)
        if report_id not in self.reports: self.reports.append(report_id)
        case['atomicReport'] = report_id
        self.remember76(result); self.durable()

    def state77(self, case):
        episode, request = quote(case['episode']), quote(case['atomicRequest'])
        reports = 'select id from private.member_reports where reporter_episode_id=' + episode + ' and client_request_id=' + request
        assets = ','.join(quote(x) for x in case['atomicAssets']) or 'null'
        return {'legacy': self.state76(case), 'atomic': self.value("select 'VAL:'||jsonb_build_object('reports',(select coalesce(jsonb_agg(to_jsonb(r)order by id),'[]')from private.member_reports r where id in(" + reports + ")),'details',(select coalesce(jsonb_agg(to_jsonb(d)order by report_id),'[]')from private.member_report_details d where report_id in(" + reports + ")),'bindings',(select coalesce(jsonb_agg(to_jsonb(b)order by client_request_id),'[]')from private.appointment_cancel_appeal_report_bindings b where source_episode_id=" + episode + ' and client_request_id=' + request + "),'assets',(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]')from private.report_capture_assets a where id in(" + assets + ")),'captureAudit',(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]')from private.report_access_audit a where asset_id in(" + assets + ")),'storage',(select coalesce(jsonb_agg(to_jsonb(o)order by id),'[]')from storage.objects o where bucket_id='report-evidence'and name in(select object_name from private.report_capture_assets where id in(" + assets + '))))::text;')}

    def failed77(self, case, sql, code):
        before = self.state77(case); a = Session(self); a.send(sql + 'commit;'); a.finish(code)
        require(self.state77(case) == before, 'ATOMIC77_FAILURE_PARTIAL_EFFECT')

    def atomic_duplicate(self):
        for commit in (True, False):
            case = self.atomic_case(); a, b = self.pair()
            first = a.result(self.atomic77(case)); self.remember77(first, case)
            b.send(self.atomic77(case) + 'commit;'); self.blocked(a, b, 'atomic77_same_request_551')
            a.release(commit); second = b.finish_json(); self.remember77(second, case)
            if commit: require(second == first | {'alreadyApplied': True}, 'ATOMIC77_DUPLICATE_RECEIPT_CHANGED')
            else: require(second['alreadyApplied'] is False, 'ATOMIC77_ROLLBACK_FAKE_REPLAY')
            state = self.state77(case)
            require(len(state['atomic']['reports']) == len(state['atomic']['bindings']) == 1 and len(state['legacy']['appeals']) == 1, 'ATOMIC77_DUPLICATE_EFFECT')
            self.failed77(case, self.atomic77(case, description='변경된 합성 사유'), '40001')

    def atomic_legacy_report(self):
        for commit in (True, False):
            case = self.atomic_case(); a, b = self.pair()
            array = 'array[' + ','.join(quote(x) + '::uuid' for x in case['atomicAssets']) + ']::uuid[]'
            a.result(self.actor(case['author']) + 'select public.submit_member_report(' + quote(case['atomicRequest']) + ",'appointment'," + quote(case['appointment']) + ",'offline',array['other','no_show'],'합성 원자 접수'," + array + ',true);')
            b.send(self.atomic77(case) + 'commit;'); self.blocked(a, b, 'atomic77_legacy_report_551')
            a.release(commit)
            if commit:
                b.finish('40001'); state = self.state77(case)
                require(len(state['atomic']['reports']) == 1 and not state['atomic']['bindings'] and not state['legacy']['appeals'] and state['legacy']['head']['current_revision'] == case['revision'], 'ATOMIC77_LEGACY_PORT_ADOPTED')
            else: self.remember77(b.finish_json(), case)

    def atomic_other_appointment(self):
        for commit in (True, False):
            first = self.atomic_case(); second = self.atomic_case(first)
            second['atomicRequest'] = first['atomicRequest']; self.durable()
            before = self.state77(second); a, b = self.pair(); r = a.result(self.atomic77(first)); self.remember77(r, first)
            b.send(self.atomic77(second) + 'commit;'); self.blocked(a, b, 'atomic77_other_ap_same_551')
            a.release(commit)
            if commit:
                b.finish('40001'); after = self.state77(second)
                require(after['legacy'] == before['legacy'] and after['atomic']['assets'] == before['atomic']['assets'] and len(after['atomic']['bindings']) == 1, 'ATOMIC77_OTHER_AP_PARTIAL_EFFECT')
            else: self.remember77(b.finish_json(), second)

    def atomic_ap_result_nowait(self):
        for result_lock in (False, True):
            case = self.atomic_case(); before = self.state77(case); a, b = self.pair()
            a.mark('select 1 from ' + ('private.safety_appointment_results where appointment_id=' + quote(case['appointment']) + ' and identity_id=' + quote(case['identity']) if result_lock else 'public.appointments where id=' + quote(case['appointment'])) + ' for update;')
            b.send(self.atomic77(case) + 'commit;'); b.finish('40001'); a.release(False)
            require(self.state77(case) == before, 'ATOMIC77_NOWAIT_REPORT_OR_CAPTURE_PARTIAL')  # NOWAIT는 실제 blocking 수에 넣지 않는다.

    def atomic_sorted_capture(self):
        case = self.atomic_case(assets=2); first_id = min(case['atomicAssets']); a, b = self.pair()
        a.mark('select 1 from private.report_capture_assets where id=' + quote(first_id) + ' for update;')
        b.send(self.atomic77(case, assets=sorted(case['atomicAssets'], reverse=True)) + 'commit;'); self.blocked(a, b, 'atomic77_first_sorted_capture')
        a.release(False); result = b.finish_json(); self.remember77(result, case)
        c = Session(self); replay = c.result(self.atomic77(case, assets=sorted(case['atomicAssets']))); c.release(True)
        require(replay == result | {'alreadyApplied': True} and all(x['state'] == 'attached' for x in self.state77(case)['atomic']['assets']), 'ATOMIC77_CAPTURE_SORT_REPLAY_INVALID')

    def atomic_capture_cancel(self):
        for commit in (True, False):
            case = self.atomic_case(); a, b = self.pair()
            a.result(self.actor(case['author']) + 'select public.cancel_report_capture(' + quote(case['atomicAssets'][0]) + ');')
            b.send(self.atomic77(case) + 'commit;'); self.blocked(a, b, 'atomic77_capture_cancel_wait')
            a.release(commit)
            if commit:
                b.finish('40001'); state = self.state77(case)
                require(not state['atomic']['reports'] and not state['atomic']['bindings'] and not state['legacy']['appeals'] and state['atomic']['assets'][0]['state'] == 'cancelled', 'ATOMIC77_CANCELLED_CAPTURE_PARTIAL')
            else: self.remember77(b.finish_json(), case)

    def atomic_capture_metadata(self):
        for commit in (True, False):
            case = self.atomic_case(); asset = next(x for x in self.atomic_assets if x['id'] == case['atomicAssets'][0]); a, b = self.pair()
            a.mark('select 1 from private.report_capture_assets where id=' + quote(asset['id']) + " for update;update storage.objects set metadata=jsonb_build_object('mimetype','image/png','size',128)where bucket_id='report-evidence'and name=" + quote(asset['path']) + ';')
            b.send(self.atomic77(case) + 'commit;'); self.blocked(a, b, 'atomic77_capture_metadata_after_wait')
            a.release(commit)
            if commit:
                b.finish('22023'); state = self.state77(case)
                require(not state['atomic']['reports'] and not state['atomic']['bindings'] and not state['legacy']['appeals'] and state['atomic']['assets'][0]['state'] == 'uploaded', 'ATOMIC77_INVALID_METADATA_PARTIAL')
            else: self.remember77(b.finish_json(), case)

    def request_lock77(self, case):
        return 'select pg_advisory_xact_lock(hashtextextended(' + quote(case['episode'] + ':' + case['atomicRequest']) + ',551));'

    def atomic_session_request_wait(self):
        case = self.atomic_case(); before = self.state77(case)
        self.expire_after_barrier('auth.sessions', 'id=' + quote(case['session']), 'not_after')
        a, b = self.pair(); a.mark(self.request_lock77(case)); b.send(self.atomic77(case) + 'commit;'); self.blocked(a, b, 'atomic77_session_551_expiry')
        self.wait_db_deadline('(select not_after from auth.sessions where id=' + quote(case['session']) + ')'); a.release(False); b.finish('28000')
        require(self.state77(case) == before, 'ATOMIC77_SESSION_551_PARTIAL')

    def atomic_statement_deadline(self):
        case = self.atomic_case()
        self.run("begin;with t as(select clock_timestamp()-interval'24 hours'+interval'5 seconds'as cancelled)update private.appointment_cancellations set cancelled_at=t.cancelled from t where appointment_id=" + quote(case['appointment']) + ";update private.safety_appointment_result_revisions set cancellation_at=(select cancelled_at from private.appointment_cancellations where appointment_id=" + quote(case['appointment']) + ')where appointment_id=' + quote(case['appointment']) + ' and identity_id=' + quote(case['identity']) + ' and revision=' + str(case['revision']) + ';commit;')
        a, b = self.pair(); a.mark('select 1 from private.report_capture_assets where id=' + quote(case['atomicAssets'][0]) + ' for update;')
        b.send(self.atomic77(case) + 'commit;'); self.blocked(a, b, 'atomic77_capture_wait_statement_deadline')
        self.wait_db_deadline('(select cancelled_at+interval\'24 hours\'from private.appointment_cancellations where appointment_id=' + quote(case['appointment']) + ')'); a.release(False)
        r = b.finish_json(); self.remember77(r, case)
        proof = self.value("select 'VAL:'||jsonb_build_object('receivedBeforeDeadline',received_at<deadline_at,'returnedAfterDeadline',clock_timestamp()>=deadline_at)::text from private.safety_appeals where id=" + quote(r['appealId']) + ';')
        require(all(x is True for x in proof.values()), 'ATOMIC77_STATEMENT_TIME_NOT_PRESERVED'); self.preservation['atomic77DbStatementClock'] = proof

    def atomic_report_delete(self):
        # 이의 상세 삭제 허용 상태는 owner negative fixture이며 운영 판정/90일 엔진이 아니다.
        for delete_first in (False, True):
            case = self.atomic_case(assets=0); c = Session(self); first = c.result(self.atomic77(case)); c.release(True); self.remember77(first, case)
            a, b = self.pair()
            if not delete_first:
                a.result(self.atomic77(case)); b.send('delete from private.member_reports where id=' + quote(first['reportId']) + ';commit;'); self.blocked(a, b, 'atomic77_replay_report_delete_wait'); a.release(True); b.finish('55000')
                require(len(self.state77(case)['atomic']['bindings']) == 1, 'ATOMIC77_PENDING_REPORT_BINDING_DELETED')
            else:
                self.run("begin;update private.safety_appeals set state='rejected',resolved_at=clock_timestamp()where id=" + quote(first['appealId']) + ';commit;')
                self.durable(); a.mark('delete from private.member_reports where id=' + quote(first['reportId']) + ';')
                b.send(self.atomic77(case) + 'commit;'); b.finish('40001'); a.release(True)
                state = self.state77(case); require(not state['atomic']['bindings'] and not state['atomic']['reports'], 'ATOMIC77_REPORT_CASCADE_BINDING_REMAINS')
                self.failed77(case, self.atomic77(case), '40001'); self.failed77(case, self.atomic77(case, expected=first['resultRevision']), '55000')

    def atomic_logout_retire(self):
        for retirement in (False, True):
            for management_first in (False, True):
                case = self.atomic_case(); a, b = self.pair()
                end = self.retire_sql(case['author'], str(uuid.uuid4())) if retirement else 'delete from auth.sessions where id=' + quote(case['session']) + ';'
                if management_first:
                    r = a.result(self.atomic77(case)); self.remember77(r, case); b.send(end + 'commit;'); self.blocked(a, b, 'atomic77_management_share_logout_retire'); a.release(True)
                    if retirement: require(b.finish_json()['status'] == 'processing', 'ATOMIC77_RETIRE_FAKE_COMPLETED')
                    else: b.finish()
                    self.failed77(case, self.atomic77(case), '42501' if retirement else '28000')
                else:
                    if retirement: a.result(end)
                    else: a.mark(end)
                    before = self.state77(case); b.send(self.atomic77(case) + 'commit;'); self.blocked(a, b, 'atomic77_logout_retire_first'); a.release(True); b.finish('42501' if retirement else '28000')
                    require(self.state77(case) == before, 'ATOMIC77_RETIRED_LOGOUT_PARTIAL')
                require(self.cleanup_acl() == self.baseline_cleanup_acl, 'ATOMIC77_RETIRE_ACL_CHANGED')

    def atomic_binding_session_expiry(self):
        case = self.atomic_case(); before = self.state77(case)
        self.expire_after_barrier('auth.sessions', 'id=' + quote(case['session']), 'not_after')
        a, b = self.pair()
        # SHARE 허용 SELECT/금지 ROW EXCLUSIVE: lookup은 통과하고 마지막 binding INSERT가 실제 대기한다.
        a.mark('lock table private.appointment_cancel_appeal_report_bindings in share mode;')
        b.send(self.atomic77(case) + 'commit;'); self.blocked(a, b, 'atomic77_binding_insert_after_report_appeal')
        self.wait_db_deadline('(select not_after from auth.sessions where id=' + quote(case['session']) + ')'); a.release(False); b.finish('28000')
        require(self.state77(case) == before and self.state77(case)['atomic']['assets'][0]['state'] == 'uploaded', 'ATOMIC77_BINDING_FINAL_GUARD_NOT_ATOMIC')

    def extra_cleanup_sql(self, reports):
        assets = ','.join(quote(x['id']) for x in self.atomic_assets)
        paths = ','.join(quote(x['path']) for x in self.atomic_assets)
        prefix = ''
        if assets:
            prefix = 'delete from private.report_access_audit where asset_id in(' + assets + ');delete from private.report_capture_assets where id in(' + assets + ");delete from storage.objects where bucket_id='report-evidence'and name in(" + paths + ');'
        # 76 receipt 정리의 ON DELETE CASCADE가77 binding만 지운다. 원 report 삭제guard는 그대로다.
        return prefix + super().extra_cleanup_sql(reports)


def self_check77():
    from unittest.mock import patch
    from types import SimpleNamespace
    pins, versions = source_gate77()
    saved = dict(FORMAL77_PROOFS); FORMAL77_PROOFS.clear()
    try:
        try: source_gate77()
        except Failure as error: require(str(error) == 'FORMAL77_EXACT_PROOFS_PENDING', 'ATOMIC77_MISSING_GATE_WRONG')
        else: raise Failure('ATOMIC77_MISSING_GATE_OPEN')
    finally: FORMAL77_PROOFS.update(saved)
    first = next(iter(FORMAL77_PROOFS)); FORMAL77_PROOFS[first] = '0' * 64
    try:
        try: source_gate77()
        except Failure as error: require(str(error) == 'FORMAL77_PROOF_PIN_INVALID', 'ATOMIC77_TAMPER_GATE_WRONG')
        else: raise Failure('ATOMIC77_TAMPER_GATE_OPEN')
    finally: FORMAL77_PROOFS.update(saved)
    require(len(CASE77_NAMES) == len(set(CASE77_NAMES)) == 12 and all(callable(getattr(Driver77, n)) for n in CASE77_NAMES), 'ATOMIC77_CASE_DISPATCH_INVALID')
    dummy = object.__new__(Driver77)
    case = {'author':'11111111-1111-4111-8111-111111111111','appointment':'22222222-2222-4222-8222-222222222222','report':'33333333-3333-4333-8333-333333333333','atomicRequest':'44444444-4444-4444-8444-444444444444','episode':'55555555-5555-4555-8555-555555555555','identity':'66666666-6666-4666-8666-666666666666','revision':1,'atomicAssets':['77777777-7777-4777-8777-777777777777']}
    dummy.users = [{'uid':case['author'],'session':'88888888-8888-4888-8888-888888888888'}]
    dummy.notice_incidents=[];dummy.notice_decisions=[];dummy.appeal_cases=[case];dummy.appeal_ids=[]
    dummy.atomic_cases=[case];dummy.atomic_assets=[{'id':case['atomicAssets'][0],'owner':case['author'],'episode':case['episode'],'path':case['author']+'/'+case['atomicAssets'][0]+'.jpg'}]
    generated=[];dummy.state76=lambda c:{};dummy.value=lambda q:generated.append(q)or{}
    dummy.state77(case)
    cleanup=dummy.extra_cleanup_sql('select '+quote(case['report'])+'::uuid')
    generated += [dummy.atomic77(case),dummy.atomic77(case,assets=[]),dummy.request_lock77(case),cleanup]
    for sql in generated:
        require(not re.search(r'\d(?:and|where|for|or)\b',sql,re.I), 'ATOMIC77_SQL_NUMERIC_TOKEN_INVALID')
        # 문자열 literal 밖의 괄호 짝만 확인한다. 실제 PG 구문/SQL 실행 검사와 구분한다.
        stripped=re.sub(r"'(?:''|[^'])*'",'string',sql);balance=0
        for c in stripped:
            balance += 1 if c=='(' else -1 if c==')' else 0
            require(balance>=0,'ATOMIC77_SQL_PAREN_NEGATIVE')
        require(balance==0,'ATOMIC77_SQL_PAREN_UNBALANCED')
    require(cleanup.index('delete from private.report_capture_assets')<cleanup.index('delete from private.appointment_cancel_appeal_receipts'), 'ATOMIC77_CAPTURE_FK_CLEANUP_ORDER')
    require('source_episode_id in('in cleanup and "bucket_id='report-evidence'and name in("in cleanup,'ATOMIC77_NAMESPACE_CLEANUP_MISSING')
    require("in share mode;"in __import__('inspect').getsource(Driver77.atomic_binding_session_expiry),'ATOMIC77_BINDING_AFTER_LOOKUP_BARRIER_MISSING')
    with tempfile.TemporaryDirectory(prefix='yumidang-atomic77-offline-',dir='/private/tmp')as directory:
        dummy.artifact=Path(directory);dummy.namespace='offline77-synthetic';dummy.posts=[];dummy.reports=[case['report']];dummy.report_requests=[case['atomicRequest']];dummy.members=[];dummy.bucket_created=False;dummy.sessions=[];dummy.remote_uncertain=False;dummy.preservation={}
        dummy.durable(); saved_journal=json.loads((dummy.artifact/'fixture-recovery.json').read_bytes())
        require(saved_journal['atomicCases']==[case]and saved_journal['atomicAssets']==dummy.atomic_assets and saved_journal['reportRequests']==[case['atomicRequest']]and saved_journal['autoRetry']is False,'ATOMIC77_DISK_RECOVERY_IDS_MISSING')
        require((dummy.artifact/'fixture-recovery.json').stat().st_mode&0o777==0o600,'ATOMIC77_JOURNAL_MODE_INVALID')
        dummy.remote_uncertain=True;dummy.sessions=[SimpleNamespace(name="offline77-session",close=lambda:None)]
        with patch.object(Driver75,'cleanup',side_effect=Failure('OFFLINE_MUTATIVE_CLEANUP_FORBIDDEN'))as inherited:
            try:dummy.cleanup()
            except Failure as error:require(str(error)=='SOURCE76_REMOTE_COMPLETION_UNCERTAIN_NO_MUTATIVE_CLEANUP','ATOMIC77_UNCERTAIN_GUARD_WRONG')
            else:raise Failure('ATOMIC77_UNCERTAIN_CLEANUP_OPEN')
            require(inherited.call_count==0 and json.loads((dummy.artifact/'fixture-recovery.json').read_bytes())['remoteCompletionUncertain']is True,'ATOMIC77_UNCERTAIN_DELETE_REACHED')
    print(json.dumps({'status':'PASS','mode':'offline77_only','formal77Pins':len(pins),'historyVersions':len(versions),'cases':12,'missingAndTamperedProofDenied':True,'oldBranchesPreservedSeparately':True,'generatedSqlTokensAndParenthesesChecked':True,'diskJournalAndUncertainWritesBlocked':True,'dbExecution':False,'httpProviderCalls':0,'twoSessionProof':False}))

class Session:
    def __init__(self, driver):
        self.driver = driver
        self.name = driver.namespace + '-' + str(len(driver.sessions) + 1)
        command = list(driver.command)
        command[command.index('-d') + 1] = 'dbname=postgres application_name=' + self.name
        driver.sessions.append(self)
        self.p = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, bufsize=1)
        self.lines = queue.Queue(); self.errors = []; self.outputs = []
        self.out_reader = threading.Thread(target=self.read_out, daemon=True)
        self.err_reader = threading.Thread(target=self.read_err, daemon=True)
        self.out_reader.start(); self.err_reader.start()
        self.send("select 'PID:'||pg_backend_pid();")
        self.pid = int(self.wait('PID:', True)[4:])
        driver.durable()
        self.mark("select set_config('application_name'," + quote(self.name) + ",false);begin;set local statement_timeout='10s';set local lock_timeout='8s';set local plpgsql.check_asserts=on;")

    def read_out(self):
        for line in self.p.stdout:
            line = line.strip(); self.lines.put(line)
            if line.startswith('{'):
                self.outputs.append(line)

    def read_err(self):
        for line in self.p.stderr:
            match = re.search(r'ERROR:\s+([A-Z0-9]{5}):', line)
            if match:
                self.errors.append(match.group(1))

    def send(self, sql):
        require(self.p.poll() is None, 'SESSION_EARLY_TERMINAL')
        self.p.stdin.write(sql + '\n'); self.p.stdin.flush()

    def wait(self, marker, prefix=False):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            try:
                line = self.lines.get(timeout=.05)
            except queue.Empty:
                require(self.p.poll() is None, 'SESSION_TERMINAL_BEFORE_MARKER')
                continue
            if line.startswith(marker) if prefix else line == marker:
                return line
        self.driver.remote_uncertain = True; self.driver.durable()
        raise Failure('SESSION_MARKER_TIMEOUT_REMOTE_COMPLETION_UNCERTAIN')

    def mark(self, sql):
        token = 'DONE:' + uuid.uuid4().hex
        self.send(sql + 'select ' + quote(token) + ';'); self.wait(token)

    def result(self, sql):
        count = len(self.outputs)
        self.mark(sql)
        require(len(self.outputs) == count + 1, 'SESSION_EXACT_JSON_RESPONSE_MISSING')
        return json.loads(self.outputs[-1])

    def release(self, commit):
        self.mark('commit;' if commit else 'rollback;'); self.finish()
        self.driver.session_evidence.append({'pid': self.pid, 'release': 'COMMIT' if commit else 'ROLLBACK'})

    def finish(self, expected=None):
        if not self.p.stdin.closed:
            self.p.stdin.close()
        try:
            code = self.p.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.driver.remote_uncertain = True; self.driver.durable()
            raise Failure('SESSION_FINISH_TIMEOUT_REMOTE_COMPLETION_UNCERTAIN') from None
        self.out_reader.join(1); self.err_reader.join(1)
        self.driver.session_evidence.append({'pid': self.pid, 'application': self.name, 'exitCode': code, 'sqlStates': list(self.errors), 'expectedSqlState': expected})
        private_json(self.driver.artifact / 'sessions.json', self.driver.session_evidence)
        require((code == 0 and not self.errors) if expected is None else (code != 0 and self.errors == [expected]), 'SESSION_SQLSTATE_MISMATCH')

    def finish_json(self):
        self.finish(); require(len(self.outputs) == 1, 'SESSION_FINAL_JSON_RESPONSE_MISSING')
        return json.loads(self.outputs[0])

    def close(self):
        if self.p.poll() is None:
            try:
                self.send('rollback;')
                self.p.stdin.close(); self.p.wait(timeout=3)
            except (OSError, Failure, subprocess.TimeoutExpired):
                # 로컬 client만 종료한다. 원격 종료는 아래 PID 검사로 따로 증명한다.
                self.driver.remote_uncertain = True
                self.p.terminate()
                try:
                    self.p.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.p.kill(); self.p.wait(timeout=3)
        self.out_reader.join(1); self.err_reader.join(1)
        require(not self.out_reader.is_alive() and not self.err_reader.is_alive(), 'SESSION_READER_REMAINS')


def self_check():
    # 정식/source pin을 읽기 검증한 뒤 pin 누락·오염을 연결 전에 거절하는지 검사한다.
    pins, versions = source_gate()
    saved = dict(FORMAL_PROOFS)
    FORMAL_PROOFS.clear()
    try:
        try:
            source_gate()
        except Failure as error:
            require(str(error) == 'FORMAL73_EXACT_PROOFS_PENDING', 'GATE_NOT_FAIL_CLOSED')
        else:
            raise Failure('FORMAL_GATE_OPEN_WITHOUT_PROOFS')
    finally:
        FORMAL_PROOFS.update(saved)
    key = next(iter(FORMAL_PROOFS)); FORMAL_PROOFS[key] = '0' * 64
    try:
        try:
            source_gate()
        except Failure as error:
            require(str(error) == 'FORMAL73_PROOF_PIN_INVALID', 'TAMPERED_PIN_GATE_NOT_CLOSED')
        else:
            raise Failure('FORMAL_GATE_ACCEPTED_TAMPERED_PROOF')
    finally:
        FORMAL_PROOFS.update(saved)
    require(len(CASE_NAMES) == len(set(CASE_NAMES)) == 11
            and all(callable(getattr(Driver, name, None)) for name in CASE_NAMES), 'CASE_DISPATCH_INVALID')
    require(quote("a'b") == "'a''b'" and len(CLEANUP) == 5, 'LOCAL_SQL_BUILDERS_INVALID')
    # 실제 case builder의 SQL만 수집한다. Driver.__init__/DB/fixture 쓰기는 호출하지 않는다.
    dummy = Driver.__new__(Driver)
    dummy.staff = '00000000-0000-4000-8000-000000000003'
    dummy.owner = '00000000-0000-4000-8000-000000000001'
    dummy.peer = '00000000-0000-4000-8000-000000000002'
    dummy.report_requests = []; dummy.posts = []; dummy.reports = []
    dummy.completion_case_count = 0
    dummy.durable = lambda: None
    dummy.actor = lambda uid: 'set local role authenticated;'
    dummy.report_state = lambda case: {'version': 1}
    queries = []
    def capture(sql, **kwargs):
        queries.append(sql)
        return 'VAL:' + json.dumps({'reportId': str(uuid.uuid4()), 'appointmentId': str(uuid.uuid4())})
    dummy.run = capture
    cases = [dummy.case(appointment=True, completion=i >= 5) for i in range(8)]
    future = [(c['slotDays'] * 24, c['slotDays'] * 24 + 2) for c in cases]
    past = [(-c['pastStartHours'], -c['pastStartHours'] + 2) for c in cases if 'pastStartHours' in c]
    for ranges in (future, past):
        require(all(a[1] <= b[0] or b[1] <= a[0] for i, a in enumerate(ranges) for b in ranges[i+1:]),
                'OFFLINE_FIXTURE_SCHEDULE_OVERLAP')
    require(len(past) == 3 and all(end + 24 > 0 for start, end in past), 'MANUAL_FIXTURE_AUTO_COMPLETION_ALREADY_DUE')
    require(all('make_interval(days=>' + str(c['slotDays']) + ')' in sql for c, sql in zip(cases, queries))
            and all(not re.search(r'\bnull(?:where|and|from)\b', sql, re.I) for sql in queries), 'GENERATED_FIXTURE_SQL_BOUNDARY_INVALID')
    # 숫자 PID를 실제 observer builder에 넣어 SQL 토큰 경계를 검사한다.
    # 잠금 증거는 모형 값이며 DB barrier PASS로 기록하지 않는다.
    from types import SimpleNamespace
    from unittest.mock import patch
    dummy.blocking = []; dummy.artifact = Path('/private/tmp/unused-offline-observer')
    def capture_observer(sql, **kwargs):
        queries.append(sql)
        return {'blocked': True, 'holderOpen': True, 'waiterLock': True}
    dummy.value = capture_observer
    with patch(__name__ + '.private_json'):
        dummy.blocked(SimpleNamespace(pid=123456), SimpleNamespace(pid=654321), 'offline_generated_only')
    require('pid=123456 and xact_start' in queries[-1] and 'pid=654321 and state' in queries[-1]
            and not any(re.search(r'\b[0-9]+(?:and|where|for|from|order|limit)\b', sql, re.I) for sql in queries),
            'GENERATED_SQL_NUMERIC_KEYWORD_JUNK')
    print(json.dumps({'status': 'PASS', 'scope': 'offline_pin_and_structure_only', 'dbCalls': 0,
                      'formalProofs': len(FORMAL_PROOFS), 'historyVersions': len(versions),
                      'sourcePins': len(pins), 'missingAndTamperedProofDenied': True, 'plannedCases': 11,
                      'generatedFixtureSchedulesDisjoint': True, 'manualCompletionFixturesBeforeAutoDue': True, 'numericPidObserverTokensValid': True}))


def self_check74():
    # 이 경로에서는 Docker/DB/API subprocess가 전체 차단된다.
    pins, versions = source_gate74()
    saved = dict(FORMAL74_PROOFS)
    FORMAL74_PROOFS.clear()
    try:
        try:
            source_gate74()
        except Failure as error:
            require(str(error) == 'FORMAL74_EXACT_PROOFS_PENDING', 'MISSING74_GATE_NOT_CLOSED')
        else:
            raise Failure('MISSING74_GATE_OPEN')
    finally:
        FORMAL74_PROOFS.update(saved)
    key = next(iter(FORMAL74_PROOFS)); FORMAL74_PROOFS[key] = '0' * 64
    try:
        try:
            source_gate74()
        except Failure as error:
            require(str(error) == 'FORMAL74_PROOF_PIN_INVALID', 'TAMPERED74_GATE_NOT_CLOSED')
        else:
            raise Failure('TAMPERED74_GATE_OPEN')
    finally:
        FORMAL74_PROOFS.update(saved)
    require(len(CASE74_NAMES) == len(set(CASE74_NAMES)) == 12
            and all(callable(getattr(Driver74, name, None)) for name in CASE74_NAMES), 'CASE74_DISPATCH_INVALID')
    dummy = Driver74.__new__(Driver74)
    dummy.actor = lambda uid: 'set local role authenticated;'
    case = {'report': str(uuid.uuid4()), 'staff': str(uuid.uuid4()), 'decisionRequest': str(uuid.uuid4()), 'appointment': str(uuid.uuid4())}
    queries = [dummy.decide(case), dummy.decide(case, mode='correction', report_version=3, hold_version=2, incident_revision=1,
                incident_outcome='invalidated', reason='decision_corrected'), dummy.read74(case),
               dummy.extra_cleanup_sql('select ' + quote(case['report']) + '::uuid')]
    require(all(not re.search(r'\b(?:null|[0-9]+)(?:where|and|from|for|order|limit)\b', q, re.I) for q in queries), 'SQL74_TOKEN_BOUNDARY_INVALID')
    require('171606' in Path(__file__).read_text() and '21810' in Path(__file__).read_text(), 'ADVISORY74_SEEDS_INVALID')
    cleanup = queries[-1]
    require('delete from private.safety_appeals where sanction_id in(select id from private.safety_sanction_applications where incident_id in(select incident_id from cleanup74_incidents));' in cleanup, 'APPEAL74_CANONICAL_FK_INVALID')
    names = ['assigned_report_adjudications', 'safety_sanction_applications', 'safety_incident_subjects', 'safety_incident_revisions', 'safety_incident_report_links', 'safety_incidents']
    require([cleanup.index('delete from private.' + n + ' ') for n in names] == sorted(cleanup.index('delete from private.' + n + ' ') for n in names), 'CLEANUP74_FK_ORDER_INVALID')
    require('l.report_id not in(' in cleanup and 'sweetness_incident_decisions' in cleanup and 'sweetness_incidents' in cleanup, 'CLEANUP74_NAMESPACE_OR_SWEETNESS_MISSING')
    print(json.dumps({'status': 'PASS', 'scope': 'offline74_pins_and_generated_SQL_only', 'dbCalls': 0,
                      'sourcePins': len(pins), 'historyVersions': len(versions), 'plannedCases': 12,
                      'missingAndTamperedProofDenied': True, 'generatedSqlTokensChecked': True,
                      'namespaceGuardAndChildFirstCleanupChecked': True, 'twoSessionProof': False}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-check', action='store_true')
    parser.add_argument('--native73-approved', action='store_true')
    parser.add_argument('--source74', action='store_true')
    parser.add_argument('--source75', action='store_true')
    parser.add_argument('--source76', action='store_true')
    parser.add_argument('--source77', action='store_true')
    parser.add_argument('--native77-approved', action='store_true')
    parser.add_argument('--native76-approved', action='store_true')
    parser.add_argument('--native75-approved', action='store_true')
    parser.add_argument('--native74-approved', action='store_true')
    parser.add_argument('--docker-host')
    parser.add_argument('--container')
    parser.add_argument('--database')
    args = parser.parse_args()
    require(sum((args.source74, args.source75, args.source76, args.source77)) <= 1, 'EXCLUSIVE_SOURCE_BRANCH_REQUIRED')
    if args.self_check:
        from unittest.mock import patch
        # offline 검사 중 실수로 추가된 subprocess 호출도 실제 실행 전에 차단한다.
        with patch('subprocess.run', side_effect=Failure('OFFLINE_SUBPROCESS_FORBIDDEN')), patch('subprocess.Popen', side_effect=Failure('OFFLINE_SUBPROCESS_FORBIDDEN')):
            self_check77() if args.source77 else self_check76() if args.source76 else self_check75() if args.source75 else self_check74() if args.source74 else self_check()
        return
    expected_approval = args.native77_approved if args.source77 else args.native76_approved if args.source76 else args.native75_approved if args.source75 else args.native74_approved if args.source74 else args.native73_approved
    require(expected_approval and sum((args.native73_approved, args.native74_approved, args.native75_approved, args.native76_approved, args.native77_approved)) == 1
            and args.docker_host == HOST and args.container == CONTAINER and args.database == 'postgres', 'EXACT_ISOLATED_SCOPE_REQUIRED')
    (source_gate77() if args.source77 else source_gate76() if args.source76 else source_gate75() if args.source75 else source_gate74() if args.source74 else source_gate())  # 정식 증거 없이 연결/fixture를 만들지 않는다.
    driver = Driver77() if args.source77 else Driver76() if args.source76 else Driver75() if args.source75 else Driver74() if args.source74 else Driver(); failure = None; cleanup = False
    try:
        driver.preflight()
        for name in (CASE77_NAMES if args.source77 else CASE76_NAMES if args.source76 else CASE75_NAMES if args.source75 else CASE74_NAMES if args.source74 else CASE_NAMES):
            driver.phase = name
            getattr(driver, name)()
            driver.results.append({'case': name, 'status': 'PASS'})
    except Exception as error:
        failure = str(error) if isinstance(error, Failure) else 'DRIVER_INFRASTRUCTURE_FAILED'
        driver.results.append({'case': driver.phase, 'status': 'FAIL', 'code': failure})
    finally:
        if driver.baseline is not None:
            try:
                driver.phase = 'finally_cleanup'; driver.cleanup(); cleanup = True
            except Exception:
                failure = failure or 'FINALLY_PRESERVATION_NOT_VERIFIED'
        driver.durable()
        private_json(driver.artifact / 'receipt.json', {
            'status': 'PASS' if not failure and cleanup and not driver.remote_uncertain else 'FAIL',
            'cases': driver.results, 'failure': failure, 'cleanupVerified': cleanup,
            'remoteCompletionUncertain': driver.remote_uncertain, 'autoRetry': False,
            'scope': 'two_session_SQL_only', 'providerCalls': 0, 'httpProof': False,
            'storageBinaryProof': False, 'noticeAppealProof': False,
            'sourceVersion': driver.source_version,
            'manifestSha256': FORMAL77_MANIFEST_SHA if args.source77 else FORMAL76_MANIFEST_SHA if args.source76 else FORMAL75_MANIFEST_SHA if args.source75 else FORMAL74_MANIFEST_SHA if args.source74 else MANIFEST_SHA, 'edgeSha256': FORMAL77_EDGE_SHA if args.source77 else FORMAL76_EDGE_SHA if args.source76 else FORMAL75_EDGE_SHA if args.source75 else FORMAL74_EDGE_SHA if args.source74 else EDGE_SHA,
            'blockingEvidence': driver.blocking, 'sessionOutcomes': driver.session_evidence,
            'preservation': driver.preservation, 'sourcePins': driver.pins,
        })
    print(json.dumps({'status': 'FAIL' if failure or not cleanup or driver.remote_uncertain else 'PASS',
                      'receipt': str(driver.artifact / 'receipt.json')}))
    if failure or not cleanup or driver.remote_uncertain:
        raise SystemExit(1)


if __name__ == '__main__':
    try:
        main()
    except Failure as error:
        print(json.dumps({'status': 'BLOCKED', 'code': str(error), 'autoRetry': False}))
        raise SystemExit(2) from None
