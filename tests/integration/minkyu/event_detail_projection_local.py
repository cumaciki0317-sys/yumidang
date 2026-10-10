"""SQL119: socket-only 새 복제에서 공개 상세·필터와 실제 소비자의 오프라인 계약을 검증한다.

기본 실행은 계획만 표시한다. 실제 실행은 root 승인 graph와 별도 실행 신호가 필요하다.
원본은 읽기만 한다. 기존 UNKNOWN/행·역할·grantor를 지우지 않으며 합성 SQL은 rollback한다.
소비자 단계는 실제 SQL 결과를 메모리 RPC fixture로 전달한다. HTTP·공급사·외부 AI 검증은 아니다.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import traceback
import uuid

REPO = Path(__file__).resolve().parents[3]
SOURCE = 'yumidang-minkyu-event112-20261009-v1'
BOOT = 'yumidang_production_recovery_bootstrap'
DOCKER = ['docker', '--host', 'unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock']
IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.165'
MIGRATION = 'backend/supabase/migrations/20261009031628_event_detail_projection.sql'
TEST = 'tests/database/minkyu/event_detail_projection.sql'
POST_TEST = 'tests/database/minkyu/event_detail_post_projection.sql'
POST_TEST_SHA = 'f41e2739744bb4b1e662f25b5eae2e786b24eae3d5b341916fc67168bacaf588'
BASE = 'tests/integration/minkyu/member_cleanup_reconcile_local.py'
REPOSITORY = 'backend/supabase/functions/_shared/db/repositories/events.ts'
DISCOVERY = 'backend/supabase/functions/_shared/ai/Agents/chatbot/event-discovery.ts'
DRIVER = 'tests/integration/minkyu/event_detail_projection_local.py'
FROZEN = {
    MIGRATION: '8b5b4af91067276fdfd27cd7340d30ff04f94ba632b029fa274885fde0be636c',
    TEST: '17b5536f7a7d4f2bdd2ba8bb6cd490b2f24609498d4662922b74ee92143ab05f',
    BASE: '86ef272728d4f0e4cd8150cce6733944ba95bb69ef0a7563c580db3145133cbb',
    'tests/integration/minkyu/product_connection_restore108_local.py': 'b417a07bc396b60655ff3943adc5f73f4ad621870421ffd92ad42cf3dad2fd3a',
    'tests/integration/minkyu/queue_tls_environment.py': '807448169be8228636f6091e3fee96d31c47be47a16a21457a2e7d4318d31ea6',
}
UPDATED = ('private.valid_source_event_v2(jsonb)',
           'private.merge_event_detail(private.source_events,jsonb)',
           'private.project_post_linked_event(uuid)',
           'public.list_public_events(jsonb,jsonb,integer)')
HELPER = 'private.project_event_source_detail(uuid)'
ROOT = NAME = RUN_ID = None
CREATED_ID = None
LAUNCH_INTENT = False


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(name, value):
    data = value if isinstance(value, bytes) else (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)).encode()
    with os.fdopen(os.open(ROOT/name, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600), 'wb') as out:
        out.write(data)


SQL_CONTEXT_FUNCTIONS = frozenset(('inline_code_block', 'require', 'expect_invalid',
    'valid_source_event_v2', 'valid_event_source_detail', 'merge_event_detail',
    'upsert_canonical_events', 'project_event_source_detail', 'project_post_linked_event',
    'get_public_event', 'list_public_events', 'event_instant_v1', 'event_seoul_day_start',
    'event_public_text_v1', 'member_content_hidden', 'assert_not_retired_caller',
    'post119_require', 'post119_actor', 'post119_baseline', 'post119_hidden',
    'get_service_post', 'get_service_post_before_content_hidden',
    'get_service_post_before_member_retirement', 'get_service_post_without_blocks'))


def sql_failure_metadata(stderr, return_code):
    # verbose stderr의 메시지·SQL·인자·DETAIL은 저장하지 않는다. 고정 함수명과 행 번호만 남긴다.
    states = sorted(set(x.decode() for x in re.findall(
        rb'(?m)^(?:psql:[^\r\n]*?:[ \t]*)?(?:ERROR|FATAL):[ \t]+([A-Z0-9]{5})(?::|[ \t]|$)', stderr)))
    contexts = []
    for name, line in re.findall(
        rb'(?m)^(?:CONTEXT:[ \t]+)?PL/pgSQL function (?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)(?:\([^\r\n]*\))? line ([0-9]{1,6})\b', stderr):
        name = name.decode()
        if name in SQL_CONTEXT_FUNCTIONS:
            context = {'function': name, 'line': int(line)}
            if context not in contexts:
                contexts.append(context)
    return {'returnCode': return_code, 'sqlStates': states, 'functionFrames': contexts,
            'rawOutputArgumentsStored': False}


CONSUMER_STEPS = frozenset(('INPUT_JSON', 'REPOSITORY_ALL', 'PRICE_DETAIL', 'AI_CARD',
    'KEYSET_FIRST', 'KEYSET_SECOND', 'DISCOVERY_ALL', 'DISCOVERY_FREE', 'DISCOVERY_MUSICAL',
    'DISCOVERY_ONGOING', 'UNKNOWN_FIELD_REJECTION', 'RPC_INPUT', 'RPC_FIRST_MODE',
    'RPC_CURSOR', 'RPC_NULL_CURSOR', 'RPC_INCLUDE_MODE', 'RPC_MODE', 'RPC_MUSICAL_FREE', 'COMPLETE'))
DENO_COMPILER_CODES = frozenset(('TS1005', 'TS1128', 'TS2304', 'TS2307', 'TS2322',
    'TS2345', 'TS2554', 'TS2769', 'TS7006', 'TS18046'))


def consumer_failure_metadata(stdout, stderr):
    value = {'compilerCodes': sorted(set(re.findall(r'\bTS[0-9]{4,5}\b', stderr.decode(errors='replace')))&DENO_COMPILER_CODES),
             'consumerStep': 'UNCLASSIFIED', 'rawOutputArgumentsStored': False}
    try:
        proof = json.loads(stdout)
        if isinstance(proof, dict) and proof.get('status') == 'FAIL' and proof.get('step') in CONSUMER_STEPS:
            value['consumerStep'] = proof['step']
    except (ValueError, TypeError):
        pass
    return value


def call(args, data=None, timeout=120):
    try:
        value = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        save('failure-'+uuid.uuid4().hex+'.json', {'subprocessTimeout':True,'rawOutputArgumentsStored':False})
        raise RuntimeError('ISOLATED_CALL_TIMEOUT_NO_AUTOMATIC_RETRY') from None
    if value.returncode:
        metadata = sql_failure_metadata(value.stderr, value.returncode)
        if args[0] == 'deno':
            metadata.update(consumer_failure_metadata(value.stdout, value.stderr))
        save('failure-'+uuid.uuid4().hex+'.json', metadata)
        raise RuntimeError('ISOLATED_CALL_FAILED_PRIVATE_METADATA')
    return value.stdout


def query(name, statement):
    assert name in (SOURCE, NAME), 'UNOWNED_DATABASE_TARGET'
    if name == SOURCE:
        statement = 'begin read only;'+statement+'rollback;'
    return call(DOCKER+['exec','-i',name,'psql','-XqAt','-U',BOOT,'-d','postgres',
                        '-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'], statement.encode())


def inspect(name):
    return json.loads(call(DOCKER+['inspect',name]))[0]


def helper():
    previous, old_path = sys.argv, list(sys.path)
    try:
        sys.argv = [str(REPO/BASE)]
        sys.path.insert(0, str(REPO/'tests/integration/minkyu'))
        spec = importlib.util.spec_from_file_location('event119_existing_utilities', REPO/BASE)
        value = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(value)
    finally:
        sys.argv, sys.path[:] = previous, old_path
    value.call, value.query, value.ROOT, value.NAME, value.SOURCE = call, query, ROOT, NAME, SOURCE
    return value


def consumer_graph(repository):
    visited, pending = set(), [repository/REPOSITORY,repository/DISCOVERY]
    while pending:
        path = pending.pop().resolve()
        if path in visited:
            continue
        assert path.is_relative_to(repository) and path.is_file(), 'CONSUMER_IMPORT_ESCAPE_OR_MISSING'
        visited.add(path)
        for dependency in re.findall(r'(?:from\s*|import\s*\(|import\s*)[\"\']([^\"\']+)[\"\']', path.read_text()):
            if dependency.startswith('.'):
                pending.append(path.parent/dependency)
            else:
                assert dependency.startswith('node:'), 'REMOTE_CONSUMER_IMPORT_FORBIDDEN'
    return {str(path.relative_to(repository)):sha(path) for path in sorted(visited)}


def required_graph_files(repository, *, post_rpc=False):
    required = {**FROZEN,**consumer_graph(repository),DRIVER:sha(Path(__file__))}
    if post_rpc:
        required[POST_TEST] = POST_TEST_SHA
    return required


def approved_graph(path, *, post_rpc=False):
    assert path.resolve() == path and path.is_file() and not(path.stat().st_mode&0o077), 'PRIVATE_GRAPH_REQUIRED'
    value = json.loads(path.read_text())
    assert value.get('approvedByRoot') is True and value.get('dockerSlotReady') is True, 'ROOT_GRAPH_AND_DOCKER_SLOT_REQUIRED'
    assert value.get('repository') == str(REPO), 'GRAPH_REPOSITORY_MISMATCH'
    files = value['files']
    required = required_graph_files(REPO,post_rpc=post_rpc)
    assert all(files.get(name) == digest and sha(REPO/name) == digest for name,digest in required.items()), 'FROZEN_GRAPH_CHANGED'
    return value, sha(path)


def memory(phase):
    raw = call(DOCKER+['exec',SOURCE,'cat','/proc/meminfo']).decode()
    values = {}
    for key in ('MemTotal','MemAvailable'):
        found = re.findall(r'^'+key+r':\s+([0-9]+)\s+kB\s*$', raw, re.M)
        assert len(found)==1 and int(found[0])>0, 'MEMORY_MEASUREMENT_UNAVAILABLE'
        values[key]=int(found[0])
    assert values['MemAvailable']<=values['MemTotal'], 'INVALID_MEMORY_MEASUREMENT'
    enough = values['MemAvailable']>=768*1024
    save('memory-'+phase+'.json', {'memAvailableKiB':values['MemAvailable'],'minimumMiB':768,'newContainers':1,
                                 'containerLimitMiB':512,'enough':enough,'cloneCreated':CREATED_ID is not None})
    assert CREATED_ID is None and enough, 'MEMORY_LOW_CLONE0_NO_START'
    return values['MemAvailable']


def procedure_properties():
    signatures = UPDATED+('public.get_public_event(uuid)',)
    names = ','.join("'"+sig+"'" for sig in signatures)
    return json.loads(query(NAME,"select jsonb_object_agg(x.signature,jsonb_build_object('properties',to_jsonb(p)-'prosrc','bodySha256',encode(extensions.digest(p.prosrc,'sha256'),'hex')))from unnest(array["+names+"]::text[])x(signature)join pg_proc p on p.oid=to_regprocedure(x.signature);"))


def unrelated_catalog(base):
    # 기존 구조 감사 helper의 함수 제외 경계만 이 migration의 정확한 다섯 함수로 바꾼다.
    original_query = base.query
    anchor = "p.oid is distinct from to_regprocedure('public.read_member_cleanup_unknown_invocations(uuid,integer)')"
    excluded = UPDATED+(HELPER,)
    replacement = 'p.oid<>all(array['+','.join("to_regprocedure('"+sig+"')" for sig in excluded)+']::oid[])'
    def read_catalog(name, statement):
        assert statement.count(anchor)==1, 'EXISTING_CATALOG_HELPER_CHANGED'
        # 적용 전 없는 새 helper의 NULL은 기존 함수까지 제외하지 않도록 제거한다.
        replacement_safe = replacement.replace("array[", "array_remove(array[").replace("]::oid[])", "]::oid[],null))")
        return original_query(name,statement.replace(anchor,replacement_safe))
    try:
        base.query = read_catalog
        return base.discovery_existing_catalog(NAME)
    finally:
        base.query = original_query


def helper_closed():
    assert query(NAME,"select to_regprocedure('"+HELPER+"')is not null;").strip()==b't', 'PROJECTION_HELPER_MISSING'
    assert query(NAME,"select not p.prosecdef and p.provolatile='s' and p.proowner=q.proowner and p.proconfig=array['search_path='||chr(34)||chr(34)]::text[] from pg_proc p join pg_proc q on q.oid='private.project_post_linked_event(uuid)'::regprocedure where p.oid='"+HELPER+"'::regprocedure;").strip()==b't', 'PRIVATE_HELPER_OWNER_INVOKER_SEARCH_PATH_CHANGED'
    for role in ('anon','authenticated','service_role','authenticator','yumidang_worker_queue'):
        assert query(NAME,"select not has_function_privilege('"+role+"','"+HELPER+"','EXECUTE');").strip()==b't', 'PRIVATE_HELPER_ROLE_OPEN'
    assert query(NAME,"select not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid='"+HELPER+"'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE');").strip()==b't', 'PRIVATE_HELPER_PUBLIC_OPEN'


CAPTURE = r"""
select 'EVENT119:'||jsonb_build_object(
 'query',(select value->>'query'from event_projection_fixture where key='filters'),
 'paidId',(select value from event_projection_fixture where key='paidId'),
 'fullPrice',(select value from event_projection_fixture where key='cost'),
 'all',public.list_public_events((select value from event_projection_fixture where key='filters'),null,10),
 'free',public.list_public_events((select value from event_projection_fixture where key='filters')||'{"freeOnly":true}',null,10),
 'musical',public.list_public_events((select value from event_projection_fixture where key='filters')||'{"freeOnly":true,"performanceGenre":"musical"}',null,10),
 'ongoing',public.list_public_events((select value from event_projection_fixture where key='filters')||'{"mode":"new_this_week","includeOngoing":true,"performanceGenre":"play"}',null,10),
 'first',public.list_public_events((select value from event_projection_fixture where key='filters'),null,1),
 'second',public.list_public_events((select value from event_projection_fixture where key='filters'),
    public.list_public_events((select value from event_projection_fixture where key='filters'),null,1)->'nextCursor',1),
 'linkedMatchesDetail',private.project_post_linked_event((select(value#>>'{}')::uuid from event_projection_fixture where key='paidId'))=
    public.get_public_event((select(value#>>'{}')::uuid from event_projection_fixture where key='paidId')))::text;
"""


def rollback_sql(body):
    assert not re.search(r'\btruncate\b',body,re.I), 'SCRATCH_TRUNCATE_FORBIDDEN'
    assert re.search(r'(?m)^begin;\s*$',body) and re.search(r'(?m)^rollback;\s*\Z',body), 'SCRATCH_TRANSACTION_REQUIRED'
    assert not re.search(r'(?mi)^\s*commit\s*;',body), 'SCRATCH_COMMIT_FORBIDDEN'
    return body


def scratch_sql(body):
    return re.sub(r'(?m)^rollback;\s*\Z',CAPTURE+'\nrollback;\n',rollback_sql(body))


POST_PROOF = {'status': 'PASS', 'scope': 'ACTUAL_PUBLIC_GET_SERVICE_POST_SYNTHETIC_SQL_FIXTURES',
    'visibleContexts': 8, 'isolatedHiddenContexts': 12, 'fullPriceLength': 10000,
    'privateFieldsPreserved': True, 'realAuthLogin': 'NOT_RUN', 'normalSignup': 'NOT_RUN',
    'normalPostCreate': 'NOT_RUN', 'normalConfirmation': 'NOT_RUN', 'actualHttp': 'NOT_RUN'}


def post_proof(output):
    # 고정 marker의 알려진 metadata만 저장한다. claims/공고/행사 결과와 오류 원문은 저장하지 않는다.
    records = [line.removeprefix('POST119:') for line in output.decode().splitlines() if line.startswith('POST119:')]
    assert len(records) == 1, 'SINGLE_POST_RPC_PROOF_REQUIRED'
    value = json.loads(records[0])
    assert isinstance(value, dict) and value == POST_PROOF and all(type(value[k]) is type(v) for k,v in POST_PROOF.items()), 'POST_RPC_PROOF_SHAPE_OR_SCOPE_MISMATCH'
    return dict(POST_PROOF)


def run_post_rpc(base, migrated):
    path = REPO/POST_TEST
    assert sha(path) == POST_TEST_SHA, 'POST_RPC_TEST_CHANGED'
    body = rollback_sql(path.read_text())
    assert body.count('POST119:') == 1 and 'EVENT119:' not in body, 'POST_RPC_FIXED_MARKER_REQUIRED'
    output = query(NAME, body)  # core CAPTURE는 다른 temp fixture를 참조하므로 이 단계에 넣지 않는다.
    after = base.normalized_snapshot(NAME)
    save('clone-after-post-rollback-private.json', after)
    assert after == migrated, 'POST_RPC_ROWS_CATALOG_ROLES_NOT_ROLLED_BACK'
    proof = post_proof(output)
    save('post-rpc-proof.json', proof)
    return proof


CONSUMER_PROGRAM = r"""
import { createRpcEventRepository } from REPOSITORY_IMPORT;
import { toAiEventCard, createEventDiscovery } from DISCOVERY_IMPORT;
let currentStep='INPUT_JSON';
try{
const chunks=[];for await(const chunk of Deno.stdin.readable)chunks.push(chunk);
const data=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let at=0;for(const c of chunks){data.set(c,at);at+=c.length;}
const payload=JSON.parse(new TextDecoder().decode(data));
const require=(ok,code=currentStep)=>{if(!ok){currentStep=code;throw new Error('EVENT119_CONSUMER_PROOF_FAILED');}};
let fetchCalls=0;globalThis.fetch=async()=>{fetchCalls++;throw new Error('EXTERNAL_FETCH_FORBIDDEN');};
const calls=[];const rpc={rpc:async(name,args)=>{
 require(name==='list_public_events'&&args.p_filters.query===payload.query&&[1,10].includes(args.p_limit),'RPC_INPUT');
 calls.push(name);const f=args.p_filters;
 if(args.p_limit===1){require(f.mode==='overlapping','RPC_FIRST_MODE');if(args.p_cursor!==null){const expected=payload.first.nextCursor;require(expected&&Object.keys(args.p_cursor).length===3&&['rank','key','id'].every(k=>Object.hasOwn(args.p_cursor,k)&&args.p_cursor[k]===expected[k]),'RPC_CURSOR');}return args.p_cursor===null?payload.first:payload.second;}
 require(args.p_cursor===null,'RPC_NULL_CURSOR');
 if(f.includeOngoing){require(f.mode==='new_this_week'&&f.performanceGenre==='play','RPC_INCLUDE_MODE');return payload.ongoing;}
 require(f.mode==='overlapping','RPC_MODE');
 if(f.performanceGenre==='musical'){require(f.freeOnly===true,'RPC_MUSICAL_FREE');return payload.musical;}
 return f.freeOnly?payload.free:payload.all;
}};
const repository=createRpcEventRepository(rpc);
const query={mode:'overlapping',query:payload.query};
currentStep='REPOSITORY_ALL';
const page=await repository.listPage(query,undefined,10);
require(page.events.length===3&&page.nextCursor===null&&payload.linkedMatchesDetail);
currentStep='PRICE_DETAIL';
const paid=page.events.find(x=>x.id===payload.paidId);require(paid&&paid.admission.kind==='described'&&paid.admission.text===payload.fullPrice&&payload.fullPrice.length===10000);
require(paid.operatingInfo==='합성 운영 안내'&&paid.description==='합성 상세 설명'&&paid.posterUrl.startsWith('https://www.kopis.or.kr/'));
currentStep='AI_CARD';
const card=toAiEventCard(paid);require(card.costLabel===payload.fullPrice&&card.canApply===false&&!('description'in card));
currentStep='KEYSET_FIRST';
const first=await repository.listPage(query,undefined,1);currentStep='KEYSET_SECOND';const second=await repository.listPage(query,first.nextCursor,1);
require(first.nextCursor&&first.events[0].id!==second.events[0].id);
const discovery=createEventDiscovery({source:repository,limits:{pageSize:10,maxSearchPages:2,recheckMaxPages:2,maxResultCards:10}});
currentStep='DISCOVERY_ALL';
const all=await discovery.search({filters:{target:'events',query:payload.query}});
require(all.cards.length===3&&all.cards.find(x=>x.id===payload.paidId).costLabel===payload.fullPrice);
currentStep='DISCOVERY_FREE';
const free=await discovery.search({filters:{target:'events',cost:'free',query:payload.query}});
require(free.cards.length===2&&free.cards.every(x=>x.costLabel==='무료'));
currentStep='DISCOVERY_MUSICAL';
const musical=await discovery.search({filters:{target:'events',cost:'free',performanceGenre:'musical',query:payload.query}});
require(musical.cards.length===1&&musical.cards[0].costLabel==='무료');
currentStep='DISCOVERY_ONGOING';
const ongoing=await discovery.search({filters:{target:'events',includeOngoing:true,performanceGenre:'play',query:payload.query}});
require(ongoing.cards.length===1&&ongoing.cards[0].state==='ongoing'&&fetchCalls===0);
currentStep='UNKNOWN_FIELD_REJECTION';
const original=payload.all;payload.all={...original,items:original.items.map(x=>x.id===payload.paidId?{...x,secret:'forbidden'}:x)};
let rejected=false;try{await repository.listPage(query,undefined,10);}catch{rejected=true;}require(rejected);payload.all=original;
currentStep='COMPLETE';
console.log(JSON.stringify({status:'PASS',scope:'REAL_J_CONSUMERS_OFFLINE_IN_MEMORY_RPC',inputSource:payload.inputSource,
 actualRepositoryParser:true,toAiEventCard:true,createEventDiscovery:true,fullPriceLength:10000,queryFilterPagination:true,
 unknownProjectionFieldRejected:true,externalFetchCalls:fetchCalls,actualHttp:false,rpcCalls:calls.length}));
}catch{console.log(JSON.stringify({status:'FAIL',scope:'REAL_J_CONSUMERS_OFFLINE_IN_MEMORY_RPC',step:currentStep,rawErrorStored:false}));Deno.exit(1);}

"""


def consumers(payload, repository):
    program = CONSUMER_PROGRAM.replace('REPOSITORY_IMPORT',json.dumps((repository/REPOSITORY).as_uri())).replace('DISCOVERY_IMPORT',json.dumps((repository/DISCOVERY).as_uri()))
    save('consumer-proof.mjs',program)
    raw = call(['deno','run','--no-prompt','--cached-only','--check','--allow-read='+str(repository/'backend'),str(ROOT/'consumer-proof.mjs')],json.dumps(payload,ensure_ascii=False).encode())
    value = json.loads(raw)
    assert value['status']=='PASS' and value['externalFetchCalls']==0 and value['actualHttp'] is False, 'CONSUMER_STAGE_NOT_PROVEN'
    save('consumer-proof.json',value)
    return value


def run(args):
    global ROOT, NAME, RUN_ID, CREATED_ID, LAUNCH_INTENT
    graph_path=args.graph_manifest.resolve();graph,graph_sha=approved_graph(graph_path,post_rpc=args.post_rpc)
    NAME='yumidang-minkyu-event119-20261009-'+args.revision;ROOT=Path('/private/tmp/yumidang-event119-20261009-'+args.revision);RUN_ID=str(uuid.uuid4())
    assert not ROOT.exists(), 'EXISTING_ARTIFACTS_UNKNOWN_PRESERVED'
    ROOT.mkdir(mode=0o700);base=helper();before=None;passed=False;receipt=None;closed=False;stopped=False;source_same=False
    try:
        existing=call(DOCKER+['ps','-a','--format','{{.Names}}']).decode().splitlines();assert NAME not in existing,'EXISTING_CLONE_PRESERVED'
        source=inspect(SOURCE);assert source['State']['Running'] and source['Config']['Labels'].get('yumidang.owner')=='minkyu'
        assert not source['Mounts'] and not source['HostConfig'].get('PortBindings');base.assert_closed(SOURCE)
        assert query(SOURCE,"select to_regclass('private.event_invocation_references')is not null and to_regprocedure('"+HELPER+"')is null;").strip()==b't','SOURCE112_NOT119_REQUIRED'
        backup_mem=memory('before-backup');before=base.normalized_snapshot(SOURCE);assert len(before['rows'])==186,'SOURCE_TABLE_COUNT_CHANGED';save('source-before-private.json',before)
        dump=call(DOCKER+['exec',SOURCE,'pg_dump','-U',BOOT,'-d','postgres','-Fc']);roles=call(DOCKER+['exec',SOURCE,'pg_dumpall','-U',BOOT,'--roles-only','--no-role-passwords'])
        assert not re.search(rb"\bPASSWORD\s+'",roles,re.I);save('source.dump',dump);save('roles.sql',roles);assert base.normalized_snapshot(SOURCE)==before,'SOURCE_CHANGED_DURING_BACKUP'
        call(DOCKER+['image','inspect',IMAGE]);start_mem=memory('before-start');save('launch-intent-private.json',{'name':NAME,'runId':RUN_ID,'newOnly':True});LAUNCH_INTENT=True
        raw=call(DOCKER+['run','-d','--pull=never','--network=none','--no-healthcheck','--memory','512m','--name',NAME,'--label','yumidang.owner=minkyu','--label','yumidang.recipe=event119','--label','yumidang.run_id='+RUN_ID,'--user','postgres','--entrypoint','sh',IMAGE,'-c','initdb -U '+BOOT+" -D /tmp/event119-data --auth-local=trust --auth-host=reject && exec postgres -D /tmp/event119-data -c listen_addresses='' -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off -c shared_buffers=16MB -c max_connections=40"])
        CREATED_ID=raw.decode().strip();assert re.fullmatch('[a-f0-9]{64}',CREATED_ID),'OWNED_ID_MISSING'
        target=inspect(NAME);assert target['Id']==CREATED_ID and target['Config']['Labels'].get('yumidang.run_id')==RUN_ID
        assert target['HostConfig']['NetworkMode']=='none' and not target['Mounts'] and not target['HostConfig'].get('PortBindings')
        assert target['HostConfig']['Memory']==512*1024*1024 and target['Config'].get('Healthcheck',{}).get('Test')==['NONE']
        for _ in range(40):
            probe=subprocess.run(DOCKER+['exec',NAME,'pg_isready','-U',BOOT,'-d','postgres'],capture_output=True,timeout=5)
            if probe.returncode==0:break
            time.sleep(.25)
        else:raise RuntimeError('FRESH_DB_NOT_READY_NO_RESTART')
        roles_sql='\n'.join(line for line in roles.decode().splitlines()if not re.match(r'(CREATE|ALTER) ROLE '+re.escape(BOOT)+r'(?: |;)',line))
        query(NAME,roles_sql);call(DOCKER+['exec','-i',NAME,'pg_restore','-U',BOOT,'-d','postgres','--single-transaction','--exit-on-error'],dump)
        restored=base.normalized_snapshot(NAME);save('clone-restored-private.json',restored);assert restored==before,'RESTORE_ROWS_CATALOG_ROLES_GRANTORS_MISMATCH';base.assert_closed(NAME)
        properties_before=procedure_properties();unrelated_before=unrelated_catalog(base);query(NAME,(REPO/MIGRATION).read_text());properties_after=procedure_properties()
        assert set(properties_before)==set(UPDATED+('public.get_public_event(uuid)',)) and properties_before.keys()==properties_after.keys()
        for signature in properties_before:
            assert properties_before[signature]['properties']==properties_after[signature]['properties'],'FUNCTION_OID_OWNER_ACL_PROPERTIES_CHANGED'
            changed=properties_before[signature]['bodySha256']!=properties_after[signature]['bodySha256']
            assert changed==(signature in UPDATED),'WRONG_FUNCTION_BODY_CHANGE'
        assert unrelated_catalog(base)==unrelated_before,'OTHER_CATALOG_OBJECT_CHANGED';helper_closed();base.assert_closed(NAME)
        migrated=base.normalized_snapshot(NAME);assert migrated['rows']==before['rows']and migrated['roles']==before['roles'],'MIGRATION_CHANGED_ROWS_OR_ROLES';save('clone-after-migration-private.json',migrated);save('original-function-properties-private.json',{'before':properties_before,'after':properties_after})
        body=scratch_sql((REPO/TEST).read_text());output=query(NAME,body);after=base.normalized_snapshot(NAME);save('clone-after-rollback-private.json',after);assert after==migrated,'TEST_ROWS_CATALOG_ROLES_NOT_ROLLED_BACK'
        records=[line.removeprefix('EVENT119:')for line in output.decode().splitlines()if line.startswith('EVENT119:')];assert len(records)==1,'SINGLE_SYNTHETIC_PROJECTION_RESULT_REQUIRED';payload=json.loads(records[0]);payload['inputSource']='ACTUAL_SQL119_RESULT_ROLLBACK_PROVEN'
        consumer=consumers(payload,REPO);assert base.normalized_snapshot(NAME)==migrated,'OFFLINE_CONSUMER_CHANGED_DB'
        post = run_post_rpc(base,migrated) if args.post_rpc else None
        assert approved_graph(graph_path,post_rpc=args.post_rpc)[1]==graph_sha,'APPROVED_GRAPH_CHANGED'
        assert not inspect(NAME)['State']['OOMKilled'],'CLONE_OOM';receipt={'status':'PASS','scope':'ISOLATED_SQL119_AND_REAL_CONSUMERS_OFFLINE','graphSha256':graph_sha,'migrationSha256':FROZEN[MIGRATION],'testSha256':FROZEN[TEST],'driverSha256':sha(Path(__file__)),'source':SOURCE,'clone':NAME,'cloneId':CREATED_ID,'sourceTables':186,'fullSourceRowsCatalogRolesGrantorsRestored':True,'sourceExistingUnknownPreserved':True,'noTruncate':True,'allSqlFixtureEffectsRolledBack':True,'fourFunctionsOidOwnerAclPropertiesPreserved':True,'otherCatalogObjectsPreserved':True,'helperDefaultClosed':True,'helperOwnerInvokerSearchPathPreserved':True,'syntheticSqlClaimsHidingOnly':True,'actualAuthLogin':'NOT_RUN','actualPostRpc':'NOT_RUN','consumerProof':consumer,'sourceDumpSha256':hashlib.sha256(dump).hexdigest(),'memoryBeforeBackupKiB':backup_mem,'memoryBeforeStartKiB':start_mem,'externalFetchCount':0,'actualHttp':'NOT_RUN','providerAndOperatingActivation':'NOT_RUN','fullStorageFiles':'NOT_RUN'}
        if post is not None:
            receipt.update({'scope':'ISOLATED_SQL119_AND_REAL_CONSUMERS_OFFLINE_PLUS_PUBLIC_POST_RPC',
                            'actualPostRpc':'PASS_SYNTHETIC_SQL_FIXTURES','postRpcTestSha256':POST_TEST_SHA,'postRpcProof':post})
        passed=True
    finally:
        if LAUNCH_INTENT:
            found=subprocess.run(DOCKER+['inspect',NAME],capture_output=True,timeout=10)
            if found.returncode==0:
                target=json.loads(found.stdout)[0];labels=target['Config'].get('Labels')or{}
                assert labels.get('yumidang.owner')=='minkyu'and labels.get('yumidang.recipe')=='event119'and labels.get('yumidang.run_id')==RUN_ID,'UNOWNED_TARGET_NO_STOP'
                assert CREATED_ID is None or target['Id']==CREATED_ID,'OWNED_TARGET_REPLACED_NO_STOP';CREATED_ID=target['Id']
                try:base.assert_closed(NAME);helper_closed()if query(NAME,"select to_regprocedure('"+HELPER+"')is not null;").strip()==b't'else None;closed=True
                except Exception:save('closed-proof-failure-private.json',{'closed':False});passed=False
        if before is not None:
            try:
                after_source=base.normalized_snapshot(SOURCE);save('source-after-private.json',after_source);source_same=after_source==before
            except Exception:source_same=False
            if not source_same:passed=False
        if CREATED_ID is not None:
            call(DOCKER+['stop',CREATED_ID]);target=inspect(NAME);stopped=target['Id']==CREATED_ID and not target['State']['Running'];assert stopped,'OWNED_STOP_NOT_PROVEN'
        save('finalization.json',{'passed':passed,'sourceUnchanged':source_same,'cloneClosed':closed,'ownedStopped':stopped,'cloneCreated':CREATED_ID is not None,'unknownAndArtifactsPreserved':True})
    assert passed and source_same and closed and stopped,'FINALIZATION_NOT_PROVEN'
    save('receipt.json',{**receipt,'sourceWholeUnchanged':True,'cloneClosed':True,'ownedStopped':True})
    print(json.dumps({'status':'PASS','scope':receipt['scope'],'sourceTables':186,'sourceUnchanged':True,'ownedStopped':True,'actualHttp':'NOT_RUN'}))


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--run',action='store_true');parser.add_argument('--graph-manifest',type=Path);parser.add_argument('--revision',default='v1');parser.add_argument('--post-rpc',action='store_true',help='같은 새 복제에서 core PASS 뒤 합성 공고의 실제 조회 RPC를 추가 검사한다');args=parser.parse_args()
    assert re.fullmatch(r'v[1-9][0-9]*',args.revision),'EXPLICIT_FRESH_REVISION_REQUIRED'
    if not args.run:
        print(json.dumps({'status':'NOT_RUN','source':SOURCE,'scope':'SOCKET_ONLY_SQL119_ROLLBACK_PLUS_OFFLINE_REAL_CONSUMERS','requiredFrozenFiles':{**FROZEN,**({POST_TEST:POST_TEST_SHA} if args.post_rpc else {})},'postRpcRequested':args.post_rpc,'postRpcScope':'ACTUAL_GET_SERVICE_POST_SYNTHETIC_SQL_FIXTURES' if args.post_rpc else 'NOT_RUN','realAuthSignupAndNormalConfirmation':'NOT_RUN','consumerImportClosure':[REPOSITORY,DISCOVERY],'rootGraphAndSlotApprovalRequired':True,'newContainers':1,'minimumMemAvailableMiB':768,'memoryLimitMiB':512,'network':'none','cron':'off','noHealthcheck':True,'sourceWrites':0,'truncate':0,'externalFetch':0,'actualHttp':'NOT_RUN'},ensure_ascii=False));return
    assert args.graph_manifest is not None,'APPROVED_GRAPH_REQUIRED';run(args)


if __name__=='__main__':
    try:main()
    except BaseException as error:
        if ROOT is not None and ROOT.is_dir():save('failure-frames-private.json',{'errorType':type(error).__name__,'frames':[{'file':Path(f.filename).name,'line':f.lineno,'function':f.name}for f in traceback.extract_tb(error.__traceback__)]})
        print(json.dumps({'status':'FAIL','errorType':type(error).__name__,'rawOutput':False,'automaticRetry':False}));raise SystemExit(130 if isinstance(error,KeyboardInterrupt)else 1)from None
