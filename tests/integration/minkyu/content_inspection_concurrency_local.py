"""SQL116 격리 DB 회귀 및 양쪽 실제 채팅 동시 잠금. 외부 검사기는 호출하지 않는다."""
import hashlib
import importlib.util
import json
import os
import re
import select
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
revision = [v for v in sys.argv[1:] if re.fullmatch(r'--revision-v[1-9][0-9]*', v)]
assert len(revision) <= 1, 'ONE_REVISION_REQUIRED'
VERSION = revision[0].split('-v')[1] if revision else '1'
ROOT = Path('/private/tmp/yumidang-content116-concurrency-20261009-v' + VERSION)
NAME = 'yumidang-minkyu-content116-concurrency-20261009-v' + VERSION
SOURCE = 'yumidang-minkyu-event112-20261009-v1'
MIGRATION = REPO / 'backend/supabase/migrations/20261009011600_content_inspection_tickets.sql'
TEST = REPO / 'tests/database/minkyu/content_inspection_tickets.sql'
spec = importlib.util.spec_from_file_location('member115_isolation_helpers', Path(__file__).with_name('member_cleanup_reconcile_local.py'))
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
shared.ROOT, shared.NAME, shared.SOURCE = ROOT, NAME, SOURCE
call, query, snapshot, save = shared.call, shared.query, shared.normalized_snapshot, shared.save
ACTORS = ('content116_concurrency_actor_a', 'content116_concurrency_actor_b')
IDS = ('a1161000-0000-4000-8000-000000000001', 'a1161000-0000-4000-8000-000000000002')


def frozen():
    return {'migrationSha256': hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),
            'testSha256': hashlib.sha256(TEST.read_bytes()).hexdigest()}


def closed(name, *, content=False):
    shared.assert_closed(name)
    if content:
        assert query(name, 'select not enabled from private.content_inspection_control where singleton;').decode().strip() == 't', 'CONTENT_DEFAULT_OPEN'
        for role in ('anon', 'authenticated', 'service_role'):
            assert query(name, "select has_function_privilege('" + role + "','public.issue_content_inspection_ticket(uuid,uuid,text,uuid,jsonb,text,text,text)','EXECUTE');").decode().strip() == 'f', 'CONTENT_ISSUER_OPEN'


def prepare():
    assert not ROOT.exists(), 'EXISTING_ARTIFACTS_PRESERVED'
    ROOT.mkdir(mode=0o700)
    existing = call(shared.tls.DOCKER + ['ps', '-a', '--format', '{{.Names}}']).decode().splitlines()
    assert SOURCE in existing and NAME not in existing, 'SOURCE_OR_NEW_CLONE_INVALID'
    source_info = json.loads(call(shared.tls.DOCKER + ['inspect', SOURCE]))[0]
    assert source_info['State']['Running'] and source_info['Config']['Labels'].get('yumidang.owner') == 'minkyu', 'SOURCE_OWNERSHIP_INVALID'
    assert not query(SOURCE, "select to_regclass('private.content_inspection_tickets');").decode().strip(), 'SOURCE_ALREADY_SQL116'
    closed(SOURCE)
    before = snapshot(SOURCE)
    dump = call(shared.tls.DOCKER + ['exec', SOURCE, 'pg_dump', '-U', shared.recovery.BOOT, '-d', 'postgres', '-Fc'])
    roles = call(shared.tls.DOCKER + ['exec', SOURCE, 'pg_dumpall', '-U', shared.recovery.BOOT,
                                   '--roles-only', '--no-role-passwords']).decode()
    assert not re.search(r"\bPASSWORD\s+'", roles, re.I), 'PASSWORD_MUST_NOT_BE_SAVED'
    save('source.dump', dump)
    save('roles.sql', roles.encode())
    save('source-before.json', json.dumps(before).encode())
    roles = re.sub(r' GRANTED BY [A-Za-z_][A-Za-z0-9_]*;', ';', roles)
    roles = '\n'.join(line for line in roles.splitlines() if not re.match(r'(CREATE|ALTER) ROLE ' + re.escape(shared.recovery.BOOT) + r'(?: |;)', line))
    shared.restore(dump, roles)
    assert snapshot(NAME) == before and snapshot(SOURCE) == before, 'SOURCE_OR_RESTORED_CATALOG_ROWS_ROLE_ACL_CHANGED'
    save('prepared.json', json.dumps({'source': SOURCE, 'clone': NAME, **frozen()}).encode())
    print('CONTENT116_CONCURRENCY_CLONE_PREPARED')


def connection():
    return subprocess.Popen(shared.tls.DOCKER + ['exec', '-i', NAME, 'psql', '-XqAt', '-U', shared.recovery.BOOT,
                            '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)


def wait_line(process, prefix):
    # 전용 로컬 연결의 준비 확인을 정해진 상한 안에서 기다린다.
    deadline = time.monotonic() + 15
    collected = b''
    while time.monotonic() < deadline:
        if select.select([process.stdout], [], [], .25)[0]:
            line = process.stdout.readline()
            collected += line
            if line.startswith(prefix):
                return line.decode().strip()
            if not line:
                break
    save('blocker-ready-failure.log', collected)
    raise RuntimeError('BLOCKER_READY_TIMEOUT')


def actor_sql(index, request_id, message_id, ticket):
    claims = json.dumps({'role': 'authenticated', 'sub': IDS[index],
                         'session_id': 'a1162000-0000-4000-8000-00000000000' + str(index + 1)})
    headers = json.dumps({'x-content-inspection-ticket': ticket['ticketId'], 'x-content-operation-id': message_id})
    return ("begin;set local statement_timeout='10s';set local lock_timeout='8s';"
            "set local application_name='" + ACTORS[index] + "';set local role authenticated;"
            "select set_config('request.jwt.claim.sub','" + IDS[index] + "',true);"
            "select set_config('request.jwt.claims','" + claims + "',true);"
            "select set_config('request.headers','" + headers + "',true);"
            "do $$declare result jsonb;begin result:=public.send_conversation_message('" + request_id + "','" + message_id + "','합성 동시 채팅 " + str(index + 1) + "');"
            "assert result->>'alreadySent'='false';assert (public.get_my_content_inspection_ticket('" + ticket['ticketId'] + "','" + message_id + "')->>'consumed')::boolean;"
            "assert exists(select 1 from public.chat_messages where id='" + message_id + "');end;$$;"
            "select 'ACTOR_OK';rollback;")


def concurrency(body):
    # 실제 함수의 본문은 수정하지 않는다. episode 잠금으로 양쪽 호출을 같은 경계에 정지한다.
    setup = body.split('-- 성공한 채팅도 target/action/message/operation')[0]
    assert setup != body, 'FIXTURE_ANCHOR_CHANGED'
    query(NAME, 'begin;\n' + setup + '\nreset role;commit;')
    request_id = query(NAME, "select request_id from private.first_chat_applications where message_id='a1164000-0000-4000-8000-000000000002';").decode().strip()
    assert re.fullmatch(r'[a-f0-9-]{36}', request_id), 'SYNTHETIC_REQUEST_MISSING'
    messages = ['a116c000-0000-4000-8000-00000000000' + str(n + 1) for n in range(2)]
    tickets = []
    for n in range(2):
        args = json.dumps({'p_request_id': request_id, 'p_message_id': messages[n], 'p_content': '합성 동시 채팅 ' + str(n + 1)}, ensure_ascii=False)
        statement = ("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false);"
                     "select public.issue_content_inspection_ticket('" + IDS[n] + "','" + messages[n] + "','chat_message','" + request_id + "','" + args + "'::jsonb,'allow','synthetic-policy','synthetic-scanner');")
        tickets.append(json.loads(query(NAME, statement).decode().splitlines()[-1]))
    before = snapshot(NAME)
    blocker = connection()
    actors = []
    try:
        statement = ("begin;set local application_name='content116_concurrency_blocker';"
                     "select 1 from private.member_episodes where profile_id in('" + IDS[0] + "','" + IDS[1] + "')and ended_at is null order by profile_id for update;"
                     "select 'BLOCKER_READY:'||pg_backend_pid();")
        blocker.stdin.write(statement.encode() + b'\n')
        blocker.stdin.flush()
        blocker_pid = int(wait_line(blocker, b'BLOCKER_READY:').split(':')[1])
        for n in range(2):
            actor = connection()
            actor.stdin.write(actor_sql(n, request_id, messages[n], tickets[n]).encode() + b'\n')
            actor.stdin.close()
            actor.stdin = None
            actors.append(actor)
        deadline = time.monotonic() + 12
        paused = False
        while time.monotonic() < deadline:
            count = query(NAME, "select count(*)from pg_stat_activity where application_name in('" + ACTORS[0] + "','" + ACTORS[1] + "')and wait_event_type='Lock'and " + str(blocker_pid) + "=any(pg_blocking_pids(pid));").decode().strip()
            if count == '2':
                paused = True
                break
            time.sleep(.05)
        assert paused, 'BOTH_ACTORS_DID_NOT_REACH_EPISODE_BARRIER'
        save('barrier.json', json.dumps({'actors': list(ACTORS), 'bothBlockedByEpisodeOwner': True,
                                         'functionInstrumentation': False}).encode())
        blocker.stdin.write(b'commit;\n')
        blocker.stdin.flush()
        blocker.stdin.close()
        blocker.stdin = None
        outputs = []
        for n, actor in enumerate(actors):
            stdout, stderr = actor.communicate(timeout=15)
            save('actor-' + str(n + 1) + '.log', stdout + stderr)
            assert actor.returncode == 0 and b'ACTOR_OK' in stdout, 'CONCURRENT_REAL_RPC_FAILED'
            outputs.append(True)
        stdout, stderr = blocker.communicate(timeout=5)
        assert blocker.returncode == 0, 'BLOCKER_RELEASE_FAILED'
        assert snapshot(NAME) == before, 'ACTOR_WRITES_CONSUMPTION_NOT_ROLLED_BACK'
        return {'bothActorsPausedAtRealEpisodeBoundary': paused, 'bothActualRpcSendsSucceeded': all(outputs),
                'bothActorTransactionsRolledBack': True, 'functionInstrumentation': False}
    finally:
        for process in [blocker, *actors]:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
        # 합성 setup은 clone 안에서 보존하되 호출 경계는 성공·실패 모두 닫는다.
        query(NAME, "begin;update private.content_inspection_control set enabled=false,policy_version=null,scanner_version=null,max_ticket_seconds=60 where singleton;revoke all on function public.issue_content_inspection_ticket(uuid,uuid,text,uuid,jsonb,text,text,text)from public,anon,authenticated,service_role;commit;")


def apply_test():
    assert ROOT.is_dir() and ROOT.resolve() == ROOT and not ROOT.stat().st_mode & 0o077, 'PRIVATE_ARTIFACTS_REQUIRED'
    prepared = json.loads((ROOT / 'prepared.json').read_text())
    assert prepared['clone'] == NAME and all(prepared[k] == v for k, v in frozen().items()) and not (ROOT / 'receipt.json').exists(), 'FROZEN_INPUT_OR_RECEIPT_INVALID'
    source = json.loads((ROOT / 'source-before.json').read_text())
    assert snapshot(SOURCE) == source, 'SOURCE_CHANGED_SINCE_PREPARE'
    assert not query(NAME, "select to_regclass('private.content_inspection_tickets');").decode().strip(), 'APPLIED_CLONE_PRESERVED_NO_REAPPLY'
    query(NAME, MIGRATION.read_text())
    save('applied.json', json.dumps(frozen()).encode())
    closed(NAME, content=True)
    before = snapshot(NAME)
    fixtures = "array(select('a1161000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,6)n)"
    assert query(NAME, 'select not exists(select 1 from auth.users where id=any(' + fixtures + '));').decode().strip() == 't', 'FIXTURE_UUID_COLLISION'
    assert query(NAME, "select not exists(select 1 from private.naver_accounts where subject like 'content116-sql-%');").decode().strip() == 't', 'FIXTURE_SUBJECT_COLLISION'
    body, removed = re.subn(r'(?m)^begin;\n', '', TEST.read_text(), count=1)
    assert removed == 1 and re.search(r'(?m)^rollback;\s*\Z', body), 'ROLLBACK_BOUNDARY_INVALID'
    query(NAME, 'begin;\n' + body)
    assert snapshot(NAME) == before, 'FULL_SQL_FIXTURE_NOT_ROLLED_BACK'
    save('scratch-pass.json', json.dumps({'status': 'PASS', **frozen(), 'rowsCatalogRolesAclRolledBack': True}).encode())
    body = re.sub(r'(?m)^rollback;\s*\Z', '', body)
    result = concurrency(body)
    closed(NAME, content=True)
    closed(SOURCE)
    assert snapshot(SOURCE) == source, 'READONLY_SOURCE_CHANGED'
    receipt = {'status': 'PASS', 'scope': 'ISOLATED_SQL116_DATABASE_AND_TWO_ACTOR_REAL_RPC_CONCURRENCY', **frozen(),
               'driverSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'source': SOURCE, 'clone': NAME,
               'sourceTableCount': len(source['rows']), 'scratchRowsCatalogRolesAclRolledBack': True,
               'sourceRowsCatalogRolesAclUnchanged': True, **result, 'syntheticSetupMetadataPreservedInClone': True,
               'defaultControlIssuerAndWorkerExecClosed': True, 'socketOnlyCronOffNetworkNone': True,
               'externalCommunications': 0, 'realClassifierAndPolicyApproval': 'NOT_RUN', 'realMember': 'NOT_RUN', 'operatingChanged': False}
    save('receipt.json', json.dumps(receipt, ensure_ascii=False, indent=2).encode())
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == '__main__':
    try:
        args = [v for v in sys.argv[1:] if v not in revision]
        if args == ['--prepare']:
            prepare()
        elif args == ['--apply-test']:
            apply_test()
        else:
            raise SystemExit('INVALID_ARGUMENTS')
    except Exception as error:
        if ROOT.is_dir() and ROOT.resolve() == ROOT and not ROOT.stat().st_mode & 0o077:
            save('failure-' + str(shared.uuid.uuid4()) + '.log', repr(error).encode())
        raise SystemExit('CONTENT116_FAILED_PRIVATE_EVIDENCE_PRESERVED') from None
