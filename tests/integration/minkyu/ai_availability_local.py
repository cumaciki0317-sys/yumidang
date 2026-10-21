"""WBS5.4a/B09 current124 availability 준비 계약. import/CLI의 실제 실행은 0이다.

별도 GET entry를 정상 제품 factory로 조립한다. 기본 CLI/준비는 NOT_RUN이며,
exact root typed 실행권위에서만 검토된 BatchTransport/CurrentAuthSource를 조합한다.
monkeypatch·임의 SQL API·관측값의 실행 권위 승격은 제공하지 않는다. 원 JWT/credentials는 descriptor에 받거나 출력하지 않는다.
"""
from datetime import datetime,timedelta,timezone
import hashlib,json,re,uuid,base64,importlib.util,os,subprocess,sys,threading,time,posixpath
from pathlib import Path
from contextlib import contextmanager
ROOT=Path(__file__).resolve().parents[3]
SOURCE='tools/local/run_current_auth_source.py'
BATCH='tools/local/collect_d03_timeout_batch.py'
KERNEL='tests/integration/jonghyun/isolated_ai_contracts.py'

SELF='tests/integration/minkyu/ai_availability_local.py'
FACTORY='tests/integration/minkyu/ai_availability_factory.ts'
POSITIVE_FACTORY='tests/integration/jonghyun/isolated_ai_factory.ts'
ROUTE='backend/supabase/functions/service-api/routes.ts'
MIGRATION='backend/supabase/migrations/20261020100000_ai_independent_consents.sql'
STATES=('processing_disabled','consent_required','concurrent','daily_limit','estimated_eligible')
KST=timezone(timedelta(hours=9))
BUDGET_TABLES=('private.ai_budget_ledgers','private.ai_budget_reservations','private.ai_account_budget_reservations','private.ai_account_daily_budget','private.ai_global_daily_budget')
REMAINING=('INDEPENDENT_EXECUTION_ADAPTER_REVIEW','FRESH_ROOT_TYPED_SOURCE_AUTH6_AND_SERVICE_CAPSULE','ACTUAL_GET_FIVE_STATES_NOT_RUN')
def need(value,code):
    if not value:raise ValueError(code)
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def sha(raw):return hashlib.sha256(raw).hexdigest()
def exact(raw):
    def pairs(items):
        out={}
        for k,v in items:need(k not in out,'AVAIL_DUPLICATE_JSON');out[k]=v
        return out
    need(type(raw)is bytes and len(raw)<=65536,'AVAIL_RAW_BOUND')
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in()).throw(ValueError('AVAIL_NONFINITE')))
class ReviewedAvailabilityPreparation:
    """정확 current124 source/원 Auth6/own4/member/day를 root가 별도로 검토한다."""
    def __init__(self,decision_id,head,pins,profile,binding_sha,auth_receipt_sha,scope_id,user_id,session_id,daemon_id,own_ids,kst_day):
        need(type(decision_id)is str and re.fullmatch('[A-Za-z0-9_.:-]{1,128}',decision_id),'AVAIL_DECISION')
        need(type(head)is str and re.fullmatch('[a-f0-9]{40}',head),'AVAIL_HEAD')
        need(type(pins)is dict and {SELF,FACTORY,POSITIVE_FACTORY,ROUTE,MIGRATION}<=set(pins)and all(type(h)is str and re.fullmatch('[a-f0-9]{64}',h)for h in pins.values()),'AVAIL_PINS')
        need(type(profile)is dict and set(profile)=={'sourceHead','migrationEntriesSha256','versions','expectedTables','fullTableSetSha256'}and profile['sourceHead']==head,'AVAIL_PROFILE')
        versions=profile['versions'];tables=profile['expectedTables']
        need(type(versions)is list and len(versions)==124 and all(type(v)is str and re.fullmatch('[0-9]{14}',v)for v in versions)and versions==sorted(set(versions)),'AVAIL_CURRENT124_ONLY')
        need(type(tables)is list and len(tables)==182 and tables==sorted(set(tables))and all(type(t)is str and re.fullmatch('(auth|public|private|storage|cron|vault)[.][a-z_][a-z_0-9]*',t)for t in tables)and set(BUDGET_TABLES)<=set(tables)and sha(canonical(tables))==profile['fullTableSetSha256'],'AVAIL_TABLES')
        need(all(type(h)is str and re.fullmatch('[a-f0-9]{64}',h)for h in(binding_sha,auth_receipt_sha,profile['migrationEntriesSha256'])),'AVAIL_SHA')
        need(type(scope_id)is str and re.fullmatch('[a-f0-9]{32}',scope_id),'AVAIL_SCOPE')
        need(all(type(u)is str and str(uuid.UUID(u))==u for u in(user_id,session_id,daemon_id))and user_id!=session_id,'AVAIL_IDENTITY')
        need(type(own_ids)is dict and set(own_ids)=={'db','auth','rest','gateway'}and len(set(own_ids.values()))==4 and all(type(v)is str and re.fullmatch('[a-f0-9]{64}',v)for v in own_ids.values()),'AVAIL_OWN_FOUR')
        need(type(kst_day)is str and datetime.strptime(kst_day,'%Y-%m-%d').strftime('%Y-%m-%d')==kst_day,'AVAIL_DAY')
        self._sealed=canonical(dict(decisionId=decision_id,sourceHead=head,pins=pins,profile=profile,bindingSha256=binding_sha,authReceiptSha256=auth_receipt_sha,scopeId=scope_id,userId=user_id,sessionId=session_id,daemonId=daemon_id,ownIds=own_ids,kstDay=kst_day))
    def descriptor(self):return json.loads(self._sealed)
def prepare(review):
    need(type(review)is ReviewedAvailabilityPreparation,'AVAIL_TYPED_REVIEW')
    value=review.descriptor()
    # 상태 순서에 따라 우선순위까지 검증한다. 동시 상태와 일한도 동시 존재시 concurrent다.
    fixtures=[dict(state=s,processingAllowed=i!=0,explorationAllowed=i>=2,activeRequest=i==2,startedRequests=20 if i in(2,3)else 0)for i,s in enumerate(STATES)]
    return dict(status='PREPARED_NOT_RUN',executionAllowed=False,reviewSha256=sha(review._sealed),sourceHead=value['sourceHead'],scopeId=value['scopeId'],method='GET',path='/functions/v1/service-api/me/ai-availability',userId=value['userId'],sessionId=value['sessionId'],kstDay=value['kstDay'],fixtures=fixtures,minimumStartKiB=1048576,minimumMaintainKiB=786432,originalJwtSeconds=3600,automaticReplay=False,remaining=list(REMAINING),actualAuth=0,modelDispatch=0,operatingChanged=False)
def fixed_fixture_plan(review,state):
    need(type(review)is ReviewedAvailabilityPreparation and state in STATES,'AVAIL_TYPED_STATE')
    return _fixed_fixture_value(review.descriptor(),state)
def _fixed_fixture_value(v,state):
    need(state in STATES,'AVAIL_TYPED_STATE')
    u="'"+v['userId']+"'::uuid";day="'"+v['kstDay']+"'::date"
    rid=str(uuid.uuid5(uuid.UUID(v['scopeId']),state));request="'"+rid+"'::uuid"
    i=STATES.index(state);case=dict(processingAllowed=i!=0,explorationAllowed=i>=2,activeRequest=i==2,startedRequests=20 if i in(2,3)else 0)
    # root typed adapter의 고정 다섯 계획만 소비한다. 범용 SQL 실행 인자를 제공하지 않는다.
    statements=["update private.ai_processing_guard set external_processing_allowed="+str(case['processingAllowed']).lower()+" where singleton;",
        "insert into private.ai_member_processing(user_id,exploration_allowed,active_request_id)values("+u+','+str(case['explorationAllowed']).lower()+','+(request if case['activeRequest']else'null')+");",
        "insert into private.ai_member_daily_usage(user_id,kst_day,started_requests)values("+u+','+day+','+str(case['startedRequests'])+");"]
    if case['activeRequest']:
        statements.append("insert into private.ai_chat_requests(request_id,user_id,client_request_hash,lease_token,expires_at)values("+request+','+u+",'"+sha((v['scopeId']+state).encode())+"',"+request+",clock_timestamp()+interval '10 minutes');")
    return {'state':state,'userId':v['userId'],'kstDay':v['kstDay'],'requestId':rid,'fixedStatements':statements,
        'statementSha256':sha(canonical(statements)),'executionAllowed':False,
        'precondition':'own member_processing/day_usage/chat/result rows absent; sealed original guard payload',
        'restore':'exact original guard payload and delete only proven new UID/day/request rows; full182 comparison'}

def verify_response(raw,state,kst_day,remaining):
    need(state in STATES and type(remaining)is int and 0<=remaining<=20,'AVAIL_EXPECTATION')
    v=exact(raw);need(type(v)is dict and set(v)=={'estimatedEligible','reason','remaining','kstDay','checkedAt','resetsAt','requestAuthoritative'},'AVAIL_EXACT_RESPONSE')
    reason=None if state=='estimated_eligible'else state
    need(type(v['estimatedEligible'])is bool and v['estimatedEligible']==(reason is None)and v['reason']==reason and type(v['requestAuthoritative'])is bool and v['requestAuthoritative']is True,'AVAIL_AUTHORITY')
    need(type(v['remaining'])is int and v['remaining']==remaining and v['kstDay']==kst_day,'AVAIL_LIMIT')
    checked=datetime.fromisoformat(v['checkedAt'].replace('Z','+00:00'));reset=datetime.fromisoformat(v['resetsAt'].replace('Z','+00:00'))
    need(checked.tzinfo is not None and reset.tzinfo is not None and checked.astimezone(KST).date().isoformat()==kst_day,'AVAIL_SERVER_DAY')
    expected=datetime.strptime(kst_day,'%Y-%m-%d').replace(tzinfo=KST)+timedelta(days=1)
    need(reset==expected and checked<reset,'AVAIL_SERVER_RESET')
    return {'responseSha256':sha(raw),'state':state,'verifiedScope':'SUPPLIED_RAW_RESPONSE_ONLY','actualExecutionProven':False}
def verify_factory_result(result,packet,state):
    keys={'scope','scopeId','state','packetSha256','method','path','httpStatus','bodyBase64','bodySha256','calls','automaticReplay','modelDispatch','observations','networkObserver','databasePreservation'}
    need(type(result)is dict and set(result)==keys,'AVAIL_FACTORY_EXACT_RESULT')
    need(result['scope']=='AVAILABILITY_SINGLE_FACTORY_GET'and result['method']=='GET'
         and result['path']=='/functions/v1/service-api/me/ai-availability'and result['automaticReplay']is False
         and result['databasePreservation']=='CALLER_REQUIRED','AVAIL_FACTORY_SCOPE')
    need(type(result['modelDispatch'])is int and result['modelDispatch']==0 and type(result['calls'])is int and result['calls']==1
         and type(result['httpStatus'])is int and result['httpStatus']==200 and result['state']==state
         and result['scopeId']==packet['scopeId']and result['packetSha256']==sha(canonical(packet)),'AVAIL_FACTORY_RESULT')
    expected=[dict(origin=packet['origin'],path='/auth/v1/user',method='GET'),dict(origin=packet['origin'],path='/rest/v1/rpc/get_my_ai_availability',method='POST')]
    need(result['networkObserver']=='NODE_UNDICI_REQUEST_CREATE'and result['observations']==expected,'AVAIL_FACTORY_NETWORK_PROOF')
    body=base64.b64decode(result['bodyBase64'],validate=True)
    need(len(body)<=65536 and sha(body)==result['bodySha256'],'AVAIL_BODY_SHA')
    return body

def verify_get_preservation(review,before,after,dispatch_before,dispatch_after):
    need(type(review)is ReviewedAvailabilityPreparation,'AVAIL_TYPED_REVIEW')
    tables=review.descriptor()['profile']['expectedTables']
    for snapshot in(before,after):
        need(type(snapshot)is dict and set(snapshot)=={'rows','catalogSha256','authoritySha256','constraintsSha256','sequenceSha256','unknownRowsSha256'},'AVAIL_SNAPSHOT')
        need(type(snapshot['rows'])is dict and sorted(snapshot['rows'])==tables,'AVAIL_ALL_182_TABLES')
        need(all(type(v)is str and re.fullmatch('[a-f0-9]{64}',v)for k,v in snapshot.items()if k!='rows'),'AVAIL_STATE_DIGEST')
        for bag in snapshot['rows'].values():need(type(bag)is dict and all(type(h)is str and re.fullmatch('[a-f0-9]{64}',h)and type(n)is int and n>0 for h,n in bag.items()),'AVAIL_ROW_BAG')
    need(canonical(before)==canonical(after),'AVAIL_GET_MUTATED_DATABASE')
    need(type(dispatch_before)is int and type(dispatch_after)is int and dispatch_before==dispatch_after==0,'AVAIL_MODEL_DISPATCH')
    return {'status':'SUPPLIED_EVIDENCE_UNCHANGED','snapshotSha256':sha(canonical(before)),'budgetAndUnknownUnchanged':True,'actualExecutionProven':False}
class ReviewedAvailabilityExecution:
    """별도 root 실행 권위. 준비 JSON·관측 결과로 이 exact type을 대신하지 않는다."""
    def __init__(self,preparation,source_kwargs_bytes,auth_receipt_relative,node_path,node_sha256,capsule_root,product_pins):
        need(type(preparation)is ReviewedAvailabilityPreparation and type(source_kwargs_bytes)is bytes and len(source_kwargs_bytes)<=1048576,'AVAIL_EXECUTION_TYPED')
        v=preparation.descriptor();kw=exact(source_kwargs_bytes)
        need(kw['head']==v['sourceHead'] and {SOURCE,BATCH,KERNEL,SELF,FACTORY}<=set(v['pins']) and kw['pins'].items()<=v['pins'].items(),'AVAIL_EXECUTION_SOURCE')
        receipt=Path(auth_receipt_relative);need(not receipt.is_absolute()and '..'not in receipt.parts and receipt.name=='receipt.json','AVAIL_RECEIPT_PATH')
        node=Path(node_path);capsule=Path(capsule_root)
        need(node.is_absolute()and node.resolve()==node and node.name=='node'and re.fullmatch('[a-f0-9]{64}',node_sha256),'AVAIL_NODE')
        need(capsule.is_absolute()and capsule.resolve()==capsule and capsule.is_relative_to(Path('/private/tmp'))and not capsule.is_relative_to(ROOT),'AVAIL_CAPSULE')
        need(type(product_pins)is dict and bool(product_pins)and product_pins.items()<=v['pins'].items(),'AVAIL_PRODUCT_PINS')
        self._sealed=canonical(dict(preparation=v,sourceKwargs=kw,authReceiptRelative=str(receipt),nodePath=str(node),nodeSha256=node_sha256,capsuleRoot=str(capsule),productPins=product_pins))
    def descriptor(self):return json.loads(self._sealed)

@contextmanager
def captured_support(review):
    v=review.descriptor()['preparation'];loaded={};previous={}
    try:
        need(subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True,timeout=5).strip()==v['sourceHead'],'AVAIL_HEAD_CHANGED')
        for relative,digest in v['pins'].items():
            path=ROOT/relative;need(not Path(relative).is_absolute()and '..'not in Path(relative).parts and path.resolve()==path,'AVAIL_SOURCE_PATH')
            raw=path.read_bytes();need(len(raw)<=4194304 and sha(raw)==digest and subprocess.check_output(['git','-C',str(ROOT),'show',v['sourceHead']+':'+relative],timeout=5)==raw,'AVAIL_SOURCE_CHANGED')
            loaded[relative]=raw
        modules={}
        for relative in(SOURCE,BATCH):
            name='_availability_captured_'+relative.replace('/','_').replace('.','_');previous[name]=sys.modules.get(name)
            spec=importlib.util.spec_from_loader(name,loader=None);module=importlib.util.module_from_spec(spec);module.__file__=str(ROOT/relative);sys.modules[name]=module
            exec(compile(loaded[relative],module.__file__,'exec'),module.__dict__);modules[relative]=module
        yield modules[SOURCE],modules[BATCH],loaded
    finally:
        for name,old in previous.items():
            if old is None:sys.modules.pop(name,None)
            else:sys.modules[name]=old

def availability_product_graph(captured):
    """이미 검산·캡처한 bytes의 service-api 정적 상대 import 전체만 소비한다."""
    pending=['backend/supabase/functions/service-api/index.ts'];found={}
    while pending:
        relative=pending.pop()
        need(relative.startswith('backend/supabase/functions/')and relative.endswith('.ts')and relative in captured,'AVAIL_SERVICE_CLOSURE_MISSING')
        if relative in found:continue
        raw=captured[relative];need(type(raw)is bytes,'AVAIL_SERVICE_SOURCE_BYTES');found[relative]=sha(raw)
        for local in re.findall(r"(?:from\s*|import\s*)[\"'](\.[^\"']+)[\"']",raw.decode()):
            pending.append(posixpath.normpath(posixpath.join(posixpath.dirname(relative),local)))
    return found

def guarded_owned_statements(payload,owned_queries):
    need(type(payload)is dict and set(payload)==set(owned_queries),'AVAIL_OWNED_PAYLOAD_UNPROVEN')
    q=lambda value:"'"+value.replace("'","''")+"'"
    lock='lock table private.ai_processing_guard,private.ai_member_processing,private.ai_member_daily_usage,private.ai_chat_requests,private.ai_result_receipts in share row exclusive mode;'
    assertions='do $availability$ begin '
    for name,query in owned_queries.items():
        assertions+='if('+query[:-1]+')is distinct from '+q(canonical(payload[name]).decode())+"::jsonb then raise exception 'availability_owned_payload_changed';end if;"
    return [lock,assertions+'end $availability$;']

def cleanup_statements(v,plan,payload,owned_queries,original_guard):
    """고정 own 행 전체 payload를 잠금 아래 재검산한다. 원 singleton payload만 복원한다."""
    need(type(payload)is dict and set(payload)==set(owned_queries),'AVAIL_OWNED_PAYLOAD_UNPROVEN')
    need(type(original_guard)is list and len(original_guard)==1 and original_guard[0].get('singleton')is True
         and original_guard[0].get('external_processing_allowed')is False,'AVAIL_ORIGINAL_GUARD')
    u="'"+v['userId']+"'::uuid";day="'"+v['kstDay']+"'::date";request="'"+plan['requestId']+"'::uuid"
    return guarded_owned_statements(payload,owned_queries)+["delete from private.ai_member_processing where user_id="+u+';',
        "delete from private.ai_member_daily_usage where user_id="+u+' and kst_day='+day+';',
        "delete from private.ai_chat_requests where user_id="+u+' and request_id='+request+';',
        "update private.ai_processing_guard set external_processing_allowed=false where singleton;"]

def fixed_write_body(statements):
    # 호출자는 root typed 고정 계획/복구에서만 이 helper에 도달한다. 임의 SQL public 실행 API 없음.
    return ("begin;set local statement_timeout='5s';set local lock_timeout='1500ms';select json_build_object('pid',pg_backend_pid(),'backendStart',backend_start)from pg_stat_activity where pid=pg_backend_pid();\n"+''.join(statements)+"select json_build_object('completed',true);\ncommit;\n").encode()

def run_fixed_write(transport,statements):
    result=transport.run(fixed_write_body(statements))
    need(type(result)is dict and set(result)=={'completed'}and result['completed']is True,'AVAIL_FIXED_WRITE_RESULT')

def run_reviewed(review):
    need(type(review)is ReviewedAvailabilityExecution,'AVAIL_FACTORY_AND_DB_PORT_NOT_REVIEWED')
    authority=review.descriptor();v=authority['preparation'];runner=None;transport=None;output=None;writer=None;error=None;results=[];anchors=[]
    done=threading.Event();failures=[];thread=None;writer_closed=False
    def close_writer():
        nonlocal writer_closed
        if writer is not None and not writer_closed:
            writer_closed=True;writer.close()
    try:
        with captured_support(review)as(source,batch,captured):
            root_review=source.ReviewedCurrentAuthSource(**authority['sourceKwargs'])
            with source.runtime_support(root_review)as support:
                runner=source.CurrentAuthSource(root_review,support);runner.phase='availability-'+v['scopeId'];prepared=runner.source();runner.plan=prepared['target'];runner.runtime_source()
                need(prepared.get('migrationCount')==124 and [e['version']for e in prepared['migrations']]==v['profile']['versions']and sha(canonical(prepared['migrations']))==v['profile']['migrationEntriesSha256'],'AVAIL_SOURCE_EXACT_MIGRATIONS')
                def save(name,value):return writer.save(name,value)
                def live():
                    need(not failures,'AVAIL_MONITOR_FAILED');runner.healthy()
                    for anchor in anchors:anchor.check()
                def fast():
                    need(transport is None or not transport.sticky,'AVAIL_STICKY_OR_MONITOR');live()
                def guard():
                    fast();need(subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True,timeout=5).strip()==v['sourceHead'],'AVAIL_HEAD_CHANGED')
                    for relative,raw in captured.items():need(batch.captured_file(ROOT/relative,sha(raw))==raw,'AVAIL_SOURCE_CHANGED')
                    runner.runtime_source();inventory,_=runner.baseline_guard();runner.check_owned(runner.read('owned-resources.json'),inventory,running=True);runner.memory(786432)
                def watch():
                    while not done.is_set():
                        try:
                            for anchor in anchors:anchor.check()
                            for relative,raw in captured.items():need(batch.captured_file(ROOT/relative,sha(raw))==raw,'AVAIL_SOURCE_CHANGED')
                            runner.healthy()
                        except BaseException as e:failures.append(type(e).__name__);return
                        done.wait(3)
                try:
                    output=runner.root/('availability-'+v['scopeId']);output.mkdir(mode=0o700,exist_ok=False);writer=batch.PrivateOutputWriter(output)
                    binding_path=runner.root/'signed-ai-binding-private.json';receipt_path=runner.root/authority['authReceiptRelative']
                    for path,digest in((binding_path,v['bindingSha256']),(receipt_path,v['authReceiptSha256'])):anchors.append(batch.PrivateFileAnchor(path,digest,runner.writer.private))
                    binding=exact(runner.writer.private(binding_path));receipt=exact(runner.writer.private(receipt_path))
                    need(receipt.get('status')=='PASS_LOCAL_AUTH6_PROVISION_ONLY'and receipt.get('bindingSha256')==v['bindingSha256']and receipt.get('actualGoTrueAndDatabaseSessions')is True,'AVAIL_AUTH6_PROVENANCE')
                    packet=runner.read('signed-provisioning-packet-private.json');need({k:x['id']for k,x in packet['containers'].items()}==v['ownIds'],'AVAIL_OWN_IDS')
                    account=next(a for a in binding['accounts']if a['userId']==v['userId']and a['sessionId']==v['sessionId'])
                    claims=runner.ai.signed_claims(account['accessToken']);need(claims['exp']-claims['iat']==3600 and claims['exp']>time.time()+600,'AVAIL_ORIGINAL_TTL')
                    need(runner.call(['info','--format','{{.ID}}'])==v['daemonId'],'AVAIL_DAEMON')
                    runner.ai.validate_signed_binding(binding,runner.root,runner.ai.signed_prepared_target(runner.root))
                    first=runner.read('owned-first-inspection.json');need(next(x for x in first if x['Id']==v['ownIds']['db'])['HostConfig'].get('PidMode')=='','AVAIL_PRIVATE_PID_NAMESPACE')
                    need(availability_product_graph(captured)==authority['productPins'],'AVAIL_EXACT_PRODUCT_CLOSURE')
                    runner.ai.sealed_runtime_capsule(v['sourceHead'],Path(authority['capsuleRoot']),authority['productPins'],authority['productPins'])
                    for relative,digest in authority['productPins'].items():anchors.append(batch.PrivateFileAnchor(Path(authority['capsuleRoot'])/relative,digest,lambda p:batch.captured_file(p,digest)))
                    writer.check_parents();fd=os.open('availability-factory.ts',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=writer.output_fd)
                    try:
                        with os.fdopen(fd,'wb',closefd=False)as stream:stream.write(captured[FACTORY]);stream.flush();os.fsync(fd)
                        os.fchmod(fd,0o400);os.fsync(fd);os.fsync(writer.output_fd);writer.check_parents()
                    finally:os.close(fd)
                    factory_entry=output/'availability-factory.ts'
                    anchors.append(batch.PrivateFileAnchor(factory_entry,v['pins'][FACTORY],lambda p:batch.captured_file(p,v['pins'][FACTORY])))
                    runner.private.FixedPair.binary(runner.writer,authority['nodePath'],authority['nodeSha256'],'node')
                    runner.start_monitor();thread=threading.Thread(target=watch,daemon=True);thread.start()
                    guard();save('intent.json',{'reviewSha256':sha(review._sealed),'sourceHead':v['sourceHead'],'singleAttempt':True,'automaticReplay':False})
                    transport=batch.BatchTransport(source,runner,v['ownIds']['db'],save,live)
                    base=batch.kernel_queries(captured[KERNEL],tuple(v['profile']['expectedTables']));control,expected=batch.control_query(captured[KERNEL])
                    u="'"+v['userId']+"'::uuid";day="'"+v['kstDay']+"'::date"
                    own="select json_build_object('processing',(select count(*)from private.ai_member_processing where user_id="+u+"),'daily',(select count(*)from private.ai_member_daily_usage where user_id="+u+"),'chat',(select count(*)from private.ai_chat_requests where user_id="+u+"),'results',(select count(*)from private.ai_result_receipts where user_id="+u+"),'day',(clock_timestamp()at time zone 'Asia/Seoul')::date);"
                    owned_queries={name:"select coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)from "+table+' t where user_id='+u+';'for name,table in(('processing','private.ai_member_processing'),('daily','private.ai_member_daily_usage'),('chat','private.ai_chat_requests'),('results','private.ai_result_receipts'))}
                    owned_queries['guard']="select coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)from private.ai_processing_guard t;"
                    owned_rows="select json_build_object("+','.join("'"+name+"',("+query[:-1]+")"for name,query in owned_queries.items())+');'
                    sequence="select coalesce(jsonb_agg(jsonb_build_array(schemaname,sequencename,last_value)order by schemaname,sequencename),'[]'::jsonb)from pg_sequences where schemaname in('auth','public','private','storage','cron','vault');"
                    queries={**base,'controls':control,'own':own,'ownedrows':owned_rows,'sequence':sequence}
                    def snapshot(label):
                        guard();raw=transport.run(batch.batch_sql(queries));save(label+'-private.json',raw);guard();return raw,batch.snapshot_from(raw,tuple(v['profile']['expectedTables']))
                    initial,baseline=snapshot('before');need(batch.exact(initial['controls'])==expected,'AVAIL_CONTROLS_NOT_CLOSED')
                    original_guard=batch.exact(initial['ownedrows'])['guard']
                    need(type(original_guard)is list and len(original_guard)==1 and original_guard[0].get('singleton')is True and original_guard[0].get('external_processing_allowed')is False,'AVAIL_ORIGINAL_GUARD')
                    own_state=batch.exact(initial['own']);need(all(own_state[k]==0 for k in('processing','daily','chat','results'))and own_state['day']==v['kstDay'],'AVAIL_FRESH_OWN_ROWS_AND_DAY')
                    for state in STATES:
                        fast();plan=fixed_fixture_plan_from_value(v,state)
                        expected_owned_payload=None
                        applied=False;case_error=None;write_attempted=False
                        try:
                            guard();apply=guarded_owned_statements(batch.exact(initial['ownedrows']),owned_queries)+plan['fixedStatements'];write_attempted=True;run_fixed_write(transport,apply);applied=True
                            before_raw,before=snapshot(state+'-before');expected_owned_payload=batch.exact(before_raw['ownedrows'])
                            origin=binding['origin'];url=__import__('urllib.parse',fromlist=['urlparse']).urlparse(origin)
                            need(url.scheme=='http'and url.hostname=='127.0.0.1'and url.port is not None,'AVAIL_LOCAL_ORIGIN')
                            factory_packet=dict(anon=packet['credentials']['anon'],capsule=authority['capsuleRoot'],origin=origin,pins=authority['productPins'],scopeId=v['scopeId'],state=state,token=account['accessToken'])
                            filename=state+'-factory-input-private.json';save(filename,factory_packet)
                            guard();raw=runner.command([authority['nodePath'],'--experimental-strip-types',str(factory_entry),str(output/filename)],timeout=20)
                            save(state+'-factory-output-private.json',{'rawBase64':base64.b64encode(raw).decode(),'sha256':sha(raw)})
                            result=exact(raw);body=verify_factory_result(result,factory_packet,state)
                            remaining=0 if state in('concurrent','daily_limit')else 20;proof=verify_response(body,state,v['kstDay'],remaining)
                            after_raw,after=snapshot(state+'-after');need(before==after,'AVAIL_GET_CHANGED_182')
                            need(all(before_raw[k]==after_raw[k]for k in('controls','own','ownedrows','sequence')),'AVAIL_GET_CHANGED_CONTROL')
                            # Node undici 원 관측은 정확 local Auth GET/RPC POST 두 요청만 허용한다.
                            results.append({**proof,'factoryOutputSha256':sha(raw),'databaseUnchanged':True,'modelDispatch':0})
                        except BaseException as case_failure:
                            case_error=case_failure
                            save(state+'-failure.json',{'errorType':type(case_failure).__name__,'writeAttempted':write_attempted,'commitProven':applied,'writeOutcome':'COMMIT_PROVEN'if applied else'UNKNOWN_IF_DISPATCHED'if write_attempted else'NOT_ATTEMPTED','cleanupAllowed':applied and expected_owned_payload is not None,'automaticReplay':False})
                            raise
                        finally:
                            if applied:
                                try:
                                    fast();guard()
                                    cleanup=cleanup_statements(v,plan,expected_owned_payload,owned_queries,original_guard)
                                    run_fixed_write(transport,cleanup);restored_raw,restored=snapshot(state+'-restored');need(restored_raw['sequence']==initial['sequence'],'AVAIL_FIXTURE_CHANGED_SEQUENCE');need(restored==baseline,'AVAIL_FIXTURE_RESTORE_CHANGED_182');need(restored_raw['ownedrows']==initial['ownedrows']and restored_raw['controls']==initial['controls'],'AVAIL_EXACT_ORIGINAL_PAYLOAD_NOT_RESTORED')
                                    save(state+'-cleanup-proof.json',{'full182BaselineRestored':True,'originalGuardAndOwnPayloadRestored':True,'sequenceUnchanged':True})
                                except BaseException as cleanup_error:
                                    save(state+'-cleanup-failure.json',{'originalErrorType':None if case_error is None else type(case_error).__name__,'cleanupErrorType':type(cleanup_error).__name__,'cleanupProven':False})
                                    if case_error is None:raise
                    guard()
                except BaseException as e:error=e
                finally:
                    done.set();runner.done.set()
                    if thread is not None:thread.join(4)
                    if runner.thread is not None:runner.thread.join(4)
                    final_ok=not failures and not runner.failures and not runner.unclosed_child and (transport is None or not transport.sticky)and (thread is None or not thread.is_alive())and (runner.thread is None or not runner.thread.is_alive())
                    try:
                        if writer is not None:save('finalization.json',{'errorType':None if error is None else type(error).__name__,'closed':final_ok,'results':results,'actualModelDispatch':0 if len(results)==5 else 'NOT_PROVEN'})
                    except BaseException:
                        if writer is not None:close_writer()
                        raise
                    finally:
                        for anchor in reversed(anchors):anchor.close()
                    if error is not None or not final_ok:
                        if writer is not None:close_writer()
                    if error is not None:raise error
                    need(final_ok,'AVAIL_LATE_FINALIZATION_FAILED')
            result={'status':'PASS_FACTORY_AUTH_DB_AVAILABILITY_ONLY','cases':results,'modelDispatchProof':'EXACT_NODE_UNDICI_LOCAL_AUTH_AND_RPC_ONLY','operatingChanged':False,'supportContextExited':True,'reviewSha256':sha(review._sealed)}
            try:save('receipt.json',result)
            finally:close_writer()
            return result
    finally:
        close_writer()

def fixed_fixture_plan_from_value(value,state):
    # 내부 봉인값을 원 exact type으로 다시 승인하지 않는다. root review 생성 시만 쓰인 helper의
    # 고정 생성을 재사용하기 위해 read-only descriptor view를 직접 인자로 분리한다.
    return _fixed_fixture_value(value,state)

if __name__=='__main__':print(json.dumps({'status':'NOT_RUN','executionAllowed':False,'remaining':REMAINING}))
