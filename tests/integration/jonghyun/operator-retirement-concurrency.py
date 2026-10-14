#!/usr/bin/env python3
"""새 owned DB의 두 psql 세션만 검증한다. 기본 NOT_RUN, Auth/Storage API 증거 아님."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
DRIVER = 'tests/integration/jonghyun/operator-retirement-concurrency.py'
TEST = 'tests/database/jonghyun/test_operator_retirement_concurrency.py'
CANDIDATE = 'tests/database/jonghyun/operator_receipts_retirement.sql'
SUPPORT = ('tools/local/run_database_tests.py', 'tools/local/prepare_database.py',
           'tools/local/prepare_migrations.py', 'backend/supabase/config.toml')
FUNCTIONS = ('public.claim_member_cleanup_task(uuid)',
             'public.check_member_cleanup_task(uuid,uuid,uuid,uuid)',
             'public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)',
             'public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)',
             'public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)')
MARKER = '-- native Auth row/일반 탈퇴의 SQL 효과만 검사한다.'


class NativeInterrupted(ValueError):
    def __init__(self):
        super().__init__('OPERATOR_NATIVE_INTERRUPTED')


def interrupt_handler(signum, frame):
    raise NativeInterrupted()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def require(value, code):
    if not value:
        raise ValueError('OPERATOR_NATIVE_' + code)


def private_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out, ensure_ascii=False, sort_keys=True)
        out.flush()
        os.fsync(out.fileno())


def source_gate(review, repo=ROOT):
    require(set(review) == {'version', 'scenario', 'preparedRoot', 'head', 'runId',
                            'driverSha256', 'testSha256', 'sourceFiles'}, 'REVIEW_SHAPE')
    require(review['version'] == 1 and review['scenario'] == 'OPERATOR_RETIREMENT_TWO_SESSION_NATIVE', 'REVIEW_SCOPE')
    require(str(uuid.UUID(review['runId'])) == review['runId'], 'RUN_ID')
    head = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    require(head == review['head'], 'HEAD_CHANGED')
    paths = review['sourceFiles']
    migrations = {str(p.relative_to(repo)) for p in (repo / 'backend/supabase/migrations').glob('*.sql')}
    require(len(migrations) == 121 and isinstance(paths, dict)
            and migrations | {CANDIDATE, *SUPPORT} == paths.keys(), 'SOURCE_SET')
    for path, sha in paths.items():
        require(isinstance(path, str) and path not in (DRIVER, TEST)
                and not Path(path).is_absolute() and '..' not in Path(path).parts
                and re.fullmatch('[0-9a-f]{64}', sha or ''), 'SOURCE_PATH')
        file = repo / path
        require(file.resolve() == file.absolute() and file.is_file() and not file.is_symlink(), 'SOURCE_FILE')
        raw = file.read_bytes()
        committed = subprocess.check_output(['git', '-C', str(repo), 'show', head + ':' + path])
        require(raw == committed and digest(raw) == sha, 'COMMITTED_SOURCE_CHANGED')
    for path, key in ((DRIVER, 'driverSha256'), (TEST, 'testSha256')):
        file = repo / path
        require(file.resolve() == file.absolute() and file.is_file() and not file.is_symlink(), 'SOURCE_FILE')
        require(digest(file.read_bytes()) == review[key], 'REVIEWED_WORKINGTREE_CHANGED')
    return (repo / CANDIDATE).read_text()


def fixture_parts(raw):
    require(raw.count(MARKER) == 1 and raw.count('create function pg_temp.operator_uid') == 1, 'FIXTURE_PREFIX')
    prefix, tail = raw.split(MARKER)
    # 표식은 주석 줄의 앞부분이다. 남은 주석을 SQL로 해석하지 않는다.
    tail = tail.split('\n', 1)[1]
    require('\nbegin;' in prefix and '\nrollback;' not in prefix.lower(), 'FIXTURE_TRANSACTION')
    grants, _ = tail.split('set local role authenticated;', 1)
    require(grants.count('grant execute on function') == 1
            and grants.count('external_deletion_approved=true') == 1, 'FIXTURE_OPEN_SCOPE')
    helpers = prefix[prefix.index('create function pg_temp.operator_uid'):prefix.index('create temp table operator_catalog')]
    return prefix + grants + '\ncommit;\n', helpers


def role_call(kind):
    if kind == 'retire':
        return ("select pg_temp.operator_actor(3);set local role authenticated;"
                "select public.retire_my_account(pg_temp.operator_uid(17));")
    if kind == 'read':
        return ("select pg_temp.operator_actor(3);set local role authenticated;"
                "select public.get_assigned_report_review_state(pg_temp.operator_uid(10));")
    options = {'approval_false': "select private.set_report_operator_approval(pg_temp.operator_uid(3),false);",
               'approval_true': "select private.set_report_operator_approval(pg_temp.operator_uid(3),true);",
               'assignment_false': "select private.set_report_operator_assignment(pg_temp.operator_uid(3),pg_temp.operator_uid(10),false);",
               'assignment_true': "select private.set_report_operator_assignment(pg_temp.operator_uid(3),pg_temp.operator_uid(10),true);"}
    require(kind in options, 'FIXED_METHOD')
    return options[kind]


PROBES = [('approval_false', 'retire', '40001'), ('assignment_false', 'retire', '40001'),
          ('read', 'retire', '40001'), ('approval_true', 'retire', 'blocked'),
          ('assignment_true', 'retire', 'blocked'), ('retire', 'approval_true', 'blocked'),
          ('retire', 'assignment_true', 'blocked')]


def blocked_observation(row, holder, waiter):
    return (isinstance(row, dict) and row.get('pid') == waiter and row.get('wait_event_type') == 'Lock'
            and row.get('state') == 'active' and holder in row.get('blockers', []))


def failed_transaction(call_state, transaction_state):
    require(call_state == '40001' and transaction_state == '25P02', 'WHOLE_TX_ROLLBACK_UNPROVEN')


def call_result(kind, rows):
    if kind == 'retire':
        require(bool(rows), 'RETIRE_RESULT')
        result = json.loads(rows[-1])
        require(result == {'withdrawalId': 'fa140000-0000-4000-8000-000000000017',
                           'status': 'processing', 'memberAccessRevoked': True}, 'RETIRE_RESULT')


def rows_equal(current, baseline):
    require(current == baseline, 'FIXTURE_ROWS_CHANGED')


def close_sessions(sessions):
    closed = True
    # holder를 먼저 닫아 아직 대기 중인 waiter가 blocker 해제 뒤 EOF를 처리하게 한다.
    for session in sessions:
        try:
            session.close()
        except BaseException:
            closed = False
    return closed


class Session:
    """원 자식 하나의 SQLSTATE frame만 소비한다. caller SQL 입력 CLI는 제공하지 않는다."""
    def __init__(self, command, log, journal, name, owned=None):
        self.log = open(log, 'xb', buffering=0)
        os.chmod(log, 0o600)
        self.child = None
        self.pending = None
        self.buffer = b''
        self.journal = journal
        try:
            # 부모 발급 구간의 신호만 지연한다. handle 확보 전 비동기 예외로 자식을 잃지 않는다.
            deferred = []
            handlers = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
            try:
                for sig in handlers:
                    signal.signal(sig, lambda signum, frame: deferred.append(signum))
                self.child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                              stderr=self.log, bufsize=0, start_new_session=True)
                if owned is not None:
                    owned.append(self)
            finally:
                for sig, handler in handlers.items():
                    signal.signal(sig, handler)
            if deferred:
                raise NativeInterrupted()
            journal('child', {'name': name, 'command': command, 'pid': self.child.pid})
            self.ok("set application_name='" + name + "';set statement_timeout='20s';set lock_timeout='15s';"
                    'set plpgsql.check_asserts=on;')
            rows, state = self.sql('select pg_backend_pid();')
            require(state == '00000' and len(rows) == 1 and rows[0].isdigit(), 'BACKEND_PID')
            self.pid = int(rows[0])
        except BaseException:
            if self.child is not None:
                try:
                    self.close()
                except BaseException:
                    pass
            else:
                self.log.close()
            raise

    def send(self, sql):
        require(self.pending is None and self.child.poll() is None, 'SESSION_STATE')
        token = 'OP_FRAME_' + uuid.uuid4().hex
        self.pending = token
        self.child.stdin.write((sql + '\n\\echo ' + token + ' :SQLSTATE\n').encode())
        self.child.stdin.flush()
        return token

    def finish(self, timeout=25):
        require(self.pending is not None, 'SESSION_FRAME')
        deadline = time.monotonic() + timeout
        rows = []
        while True:
            if b'\n' in self.buffer:
                raw, self.buffer = self.buffer.split(b'\n', 1)
                line = raw.decode('utf-8', errors='strict').strip()
                if line.startswith(self.pending + ' '):
                    state = line[len(self.pending) + 1:]
                    require(re.fullmatch('[0-9A-Z]{5}', state), 'SQLSTATE_FRAME')
                    self.pending = None
                    return rows, state
                if line:
                    rows.append(line)
                continue
            remaining = deadline - time.monotonic()
            require(remaining > 0 and self.child.poll() is None, 'SESSION_UNKNOWN')
            ready, _, _ = select.select([self.child.stdout], [], [], remaining)
            require(bool(ready), 'SESSION_TIMEOUT')
            chunk = os.read(self.child.stdout.fileno(), 65536)
            require(bool(chunk), 'SESSION_EOF')
            self.buffer += chunk
            require(len(self.buffer) <= 4_000_000, 'SESSION_FRAME_LIMIT')

    def sql(self, sql, timeout=25):
        self.send(sql)
        return self.finish(timeout)

    def ok(self, sql):
        rows, state = self.sql(sql)
        require(state == '00000', 'SQL_FAILED')
        return rows

    def close(self):
        # 소유한 연결이 닫히면 PostgreSQL의 미완료 TX도 rollback한다. SQL 재전송 없음.
        try:
            if not self.child.stdin.closed:
                self.child.stdin.close()
            try:
                self.child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    try:
                        os.killpg(self.child.pid, sig)
                    except ProcessLookupError:
                        pass
                    try:
                        self.child.wait(timeout=3)
                        break
                    except subprocess.TimeoutExpired:
                        continue
                require(self.child.poll() is not None, 'CHILD_CLOSE_UNPROVEN')
        finally:
            self.child.stdout.close()
            self.log.close()
        self.journal('child_closed', {'pid': self.child.pid, 'returncode': self.child.returncode})
        require(self.child.returncode == 0, 'CHILD_TERMINAL_UNPROVEN')


def scalar(session, sql):
    rows = session.ok(sql)
    require(len(rows) == 1, 'SCALAR_SHAPE')
    return json.loads(rows[0])


# 네이티브 전체 행 bag: 합성 직원/다른 직원/영수증3개/시계 외 변경도 감춘 채 통과하지 않는다.
SNAPSHOT_SQL = """do $$declare t record; h text; bag jsonb:='{}';begin
 for t in select schemaname,tablename from pg_tables where schemaname in('auth','public','private','storage')
 order by schemaname,tablename loop
 execute format('select encode(sha256(convert_to(coalesce(string_agg(v,E''\\n'' order by v),''''),''UTF8'')),''hex'') from (select to_jsonb(x)::text v from %I.%I x)s',t.schemaname,t.tablename) into h;
 bag:=bag||jsonb_build_object(t.schemaname||'.'||t.tablename,h);end loop;
 bag:=bag||jsonb_build_object('roles',(select jsonb_agg(to_jsonb(r)order by oid)from pg_roles r),
 'memberships',(select jsonb_agg(to_jsonb(m)order by roleid,member,grantor)from pg_auth_members m));
 perform set_config('operator_native.snapshot',bag::text,false);end $$;
 select current_setting('operator_native.snapshot')::jsonb;"""


def control_sql():
    names = ','.join("('" + x + "'::regprocedure,'" + x + "')" for x in FUNCTIONS)
    return ("select jsonb_build_object('guard',(select to_jsonb(g)from private.member_cleanup_guard g where singleton),"
            "'functions',(select jsonb_agg(jsonb_build_object('signature',w.signature,"
            "'row',to_jsonb(p),'serviceExecute',has_function_privilege('service_role',p.oid,'EXECUTE'))order by p.oid)"
            'from pg_proc p join(values ' + names + ')w(oid,signature)on p.oid=w.oid));')


def restore_sql(original, opened):
    require(len(original['functions']) == len(opened['functions']) == 5, 'ACL_SCOPE')
    require(original['guard']['external_deletion_approved'] is False, 'ORIGINAL_GUARD')
    # 고정 pg_proc/guard 전체행의 차이를 복귀 mutation 전에 거절한다.
    payload = json.dumps(opened, ensure_ascii=False, separators=(',', ':')).replace("'", "''")
    current = control_sql().removeprefix('select ').removesuffix(';')
    sql = "begin;select singleton from private.member_cleanup_guard where singleton for update nowait;"
    sql += "do $$begin if (" + current + ") is distinct from '" + payload + "'::jsonb then raise exception using errcode='40001';end if;end $$;"
    sql += 'update private.member_cleanup_guard set external_deletion_approved=false where singleton;'
    for item in original['functions']:
        require(item['signature'] in FUNCTIONS, 'ACL_SIGNATURE')
        if not item['serviceExecute']:
            sql += 'revoke execute on function ' + item['signature'] + ' from service_role;'
    original_json = json.dumps(original, ensure_ascii=False, separators=(',', ':')).replace("'", "''")
    sql += "do $$begin if (" + current + ") is distinct from '" + original_json + "'::jsonb then raise exception using errcode='40001';end if;end $$;"
    return sql + 'commit;'


def preflight(session, versions):
    actual = scalar(session, 'select json_agg(version order by version)from supabase_migrations.schema_migrations;')
    require(actual == versions and len(actual) == 121, 'APPLIED_HISTORY')
    result = scalar(session, "select jsonb_build_array((select count(*)from auth.users)+(select count(*)from public.profiles)"
                    "+(select count(*)from private.worker_jobs)+(select count(*)from private.ai_chat_requests)"
                    "+(select count(*)from private.ai_budget_reservations)+(select count(*)from auth.sessions)"
                    "+(select count(*)from storage.objects)+(select count(*)from private.member_episodes)"
                    "+(select count(*)from private.naver_accounts)+(select count(*)from private.member_retirements)"
                    "+(select count(*)from private.member_reports),current_setting('cron.launch_active_jobs'),"
                    "(select external_processing_allowed from private.ai_processing_guard where singleton),"
                    "(select external_deletion_approved from private.member_cleanup_guard where singleton));")
    require(result == [0, 'off', False, False], 'NOT_FRESH_OR_EXTERNAL_OPEN')


def run(review, root):
    fixture = source_gate(review)
    seed, helpers = fixture_parts(fixture)
    sys.path.insert(0, str(ROOT / 'tools/local'))
    spec = importlib.util.spec_from_file_location('operator_owned_guard', ROOT / SUPPORT[0])
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    target = guard.isolated_prepared_target(root)
    require('preservedResourcePins' in target, 'PROTECTED_RESOURCES_REQUIRED')
    evidence = root / ('operator-native-' + review['runId'])
    evidence.mkdir(mode=0o700)
    sequence = 0

    def journal(stage, value):
        nonlocal sequence
        sequence += 1
        private_json(evidence / ('%03d-%s.json' % (sequence, stage)), value)

    def call(args, data=None):
        return subprocess.check_output(['docker', '--host', target['host'], *args], input=data,
                                       text=True, stderr=subprocess.DEVNULL, timeout=30).strip()

    def identity():
        guard.verify_preserved_resources(root, target['host'], target['project'], call, target['preservedResourcePins'])
        items = json.loads(call(['inspect', target['id']]))
        require(len(items) == 1, 'TARGET_INSPECT')
        item = items[0]
        require(item['Id'] == target['id'] and item['Name'] == '/' + target['container']
                and item['Image'] == target['image'] and item['State']['Running']
                and not item['State']['OOMKilled']
                and item['Config']['Labels'].get('com.supabase.cli.project') == target['project'], 'TARGET_CHANGED')

    command = ['docker', '--host', target['host'], 'exec', '-i', target['id'], 'psql', '-XqAt',
               '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=0', '-v', 'VERBOSITY=sqlstate', '-f', '-']
    sessions = []
    status = 'BLOCKED'
    failure = None
    try:
        identity()
        journal('input', {'review': review, 'target': target, 'scope': 'NATIVE_SQL_TWO_SESSION_ONLY',
                          'driverSourceScope': 'SEPARATE_REVIEWED_WORKINGTREE_SHA', 'fixtureRetained': True})
        a = Session(command, evidence / 'holder.stderr', journal, 'ym_operator_holder_' + review['runId'], sessions)
        preflight(a, target['versions'])
        original = scalar(a, control_sql())
        journal('original_control', original)
        # 검토된 native 후보의 같은 prefix로 두 세션에 공유할 준비 자료만 commit한다.
        identity()
        a.ok('\\set ON_ERROR_STOP on\n' + seed + '\\set ON_ERROR_STOP off\n')
        identity()
        opened = scalar(a, control_sql())
        journal('opened_control', opened)
        baseline = scalar(a, SNAPSHOT_SQL)
        journal('fixture_baseline', {'rows': baseline, 'seedSha256': digest(seed.encode())})
        b = Session(command, evidence / 'waiter.stderr', journal, 'ym_operator_waiter_' + review['runId'], sessions)
        b.ok('\\set ON_ERROR_STOP on\n' + helpers + '\\set ON_ERROR_STOP off\n')
        for number, (holder, waiter, expected) in enumerate(PROBES, 1):
            identity()
            holder_rows = a.ok('begin;' + role_call(holder))
            identity()
            call_result(holder, holder_rows)
            a.ok('reset role;')
            identity()
            b.send('begin;' + role_call(waiter))
            if expected == '40001':
                _, call_state = b.finish()
                identity()
                _, tx_state = b.sql('select 1;')
                failed_transaction(call_state, tx_state)
                identity()
                b.ok('rollback;')
                identity()
                a.ok('rollback;')
                identity()
                observation = {'callSqlstate': call_state, 'transactionSqlstate': tx_state}
            else:
                deadline = time.monotonic() + 8
                while True:
                    a.ok('select pg_stat_clear_snapshot();')
                    observation = scalar(a, 'select jsonb_build_object(\'pid\',pid,\'state\',state,\'wait_event_type\',wait_event_type,\'blockers\',pg_blocking_pids(pid))from pg_stat_activity where pid=' + str(b.pid) + ';')
                    if blocked_observation(observation, a.pid, b.pid):
                        break
                    require(time.monotonic() < deadline, 'REAL_BLOCKER_UNOBSERVED')
                journal('blocked', {'probe': number, 'holderPid': a.pid, 'waiter': observation})
                identity()
                a.ok('rollback;')
                identity()
                waiter_rows, call_state = b.finish()
                identity()
                require(call_state == '00000', 'WAITER_DID_NOT_RESUME')
                call_result(waiter, waiter_rows)
                identity()
                b.ok('rollback;')
                identity()
            current = scalar(a, SNAPSHOT_SQL)
            rows_equal(current, baseline)
            journal('probe', {'number': number, 'holder': holder, 'waiter': waiter,
                              'expected': expected, 'observation': observation, 'rowsEqual': True})
        identity()
        source_gate(review)
        identity()
        a.ok('\\set ON_ERROR_STOP on\n' + restore_sql(original, opened) + '\n\\set ON_ERROR_STOP off\n')
        identity()
        require(scalar(a, control_sql()) == original, 'CONTROL_NOT_RESTORED')
        final_rows = scalar(a, SNAPSHOT_SQL)
        expected_rows = dict(baseline)
        # 원 guard 복귀는 허용된 유일한 행 차이. 그 밖에 fixture/receipt/clock bag 전체 동일.
        expected_rows['private.member_cleanup_guard'] = final_rows['private.member_cleanup_guard']
        require(final_rows == expected_rows, 'FINAL_ROWS_CHANGED')
        identity()
        source_gate(review)
        status = 'PASS_NATIVE_SQL_ONLY'
    except BaseException as error:
        failure = str(error) if re.fullmatch('OPERATOR_NATIVE_[A-Z0-9_]+', str(error)) else 'OPERATOR_NATIVE_UNCLASSIFIED'
        # UNKNOWN에서 추가 SQL/복귀 mutation 금지. journal과 새 target fixture를 보존한다.
    finally:
        # 정리 중 추가 신호도 기록하되 모든 소유 자식과 저널을 끝까지 처리한다.
        deferred = []
        handlers = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
        try:
            for sig in handlers:
                signal.signal(sig, lambda signum, frame: deferred.append(signum))
            if not close_sessions(sessions):
                status = 'BLOCKED'
                failure = 'OPERATOR_NATIVE_CHILD_CLOSE_UNPROVEN'
            if deferred:
                status, failure = 'BLOCKED', 'OPERATOR_NATIVE_INTERRUPTED'
            journal('final', {'status': status, 'failure': failure, 'fixtureRetained': True,
                              'emptyBaselineRestored': False, 'scope': 'NATIVE_SQL_TWO_SESSION_ONLY',
                              'sequenceRestored': False, 'clockRestored': False,
                              'authApi': 'NOT_RUN', 'storageApi': 'NOT_RUN', 'staffWorkflow': 'NOT_RUN'})
            if deferred and failure != 'OPERATOR_NATIVE_INTERRUPTED':
                status, failure = 'BLOCKED', 'OPERATOR_NATIVE_INTERRUPTED'
                journal('final_interrupted', {'status': status, 'failure': failure})
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
    return {'status': status, 'failure': failure, 'ready': False, 'scope': 'NATIVE_SQL_TWO_SESSION_ONLY',
            'fixtureRetained': True, 'sequenceRestored': False, 'clockRestored': False,
            'authApi': 'NOT_RUN', 'storageApi': 'NOT_RUN', 'staffWorkflow': 'NOT_RUN'}


def main():
    parser = argparse.ArgumentParser(description='직원 탈퇴의 두 native SQL 연결 책임만 검증')
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--prepared-root', type=Path)
    parser.add_argument('--reviewed', type=Path)
    args = parser.parse_args()
    if not args.run:
        print(json.dumps({'status': 'NOT_RUN', 'ready': False, 'scope': 'NATIVE_SQL_TWO_SESSION_ONLY'}))
        return
    handlers = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        for sig in handlers:
            signal.signal(sig, interrupt_handler)
        require(args.prepared_root is not None and args.reviewed is not None, 'INPUT_REQUIRED')
        require(args.prepared_root.is_absolute() and args.prepared_root.resolve() == args.prepared_root,
                'ROOT_CANONICAL_REQUIRED')
        root = args.prepared_root.resolve()
        path = args.reviewed
        require(path.is_absolute() and path.resolve() == path and path.parent == root
                and not path.is_symlink() and path.stat().st_nlink == 1
                and path.stat().st_uid == os.getuid() and path.stat().st_mode & 0o777 == 0o600
                and path.stat().st_size <= 4_000_000, 'REVIEW_PRIVATE_FILE')
        review = json.loads(path.read_bytes())
        require(review['preparedRoot'] == str(root), 'ROOT_MISMATCH')
        result = run(review, root)
    except BaseException as error:
        result = {'status': 'BLOCKED', 'ready': False, 'failure': 'OPERATOR_NATIVE_INTERRUPTED'
                  if isinstance(error, NativeInterrupted) else 'OPERATOR_NATIVE_INPUT_OR_TARGET_REJECTED'}
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
    print(json.dumps(result, ensure_ascii=False))
    if result['status'] != 'PASS_NATIVE_SQL_ONLY':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
