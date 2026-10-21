"""D03 SQL template 후보 수집. CLI/import NOT_RUN, 후보의 자동 승인 없음."""
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT=Path(__file__).resolve().parents[3]
SELF='tests/integration/minkyu/deadline_query_probe_local.py'
RUNTIME='tests/integration/minkyu/deadline_lock_runtime.py'

def need(value,code):
    if not value:raise ValueError(code)
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def sha(v):return hashlib.sha256(v).hexdigest()

@dataclass(frozen=True)
class ReviewedD03QueryProbe:
    """원 D03 권한과 독립된 root literal. rpc 승인 필드는 의도적으로 없다."""
    service_descriptor_bytes:bytes
    execution_descriptor_bytes:bytes
    owned_source_pins_bytes:bytes
    runtime_sha256:str
    probe_sha256:str
    qualification_path:str
    qualification_sha:str
    qualification_receipt_path:str
    qualification_receipt_sha:str
    qualification_review_bytes:bytes
    d03_alias_review_bytes:bytes
    timeout_preflight_sha256:str
    actual_d03_scope_id:str
    actual_d03_fixture_ids:tuple
    effective_statement_timeout_ms:int=8000
    effective_lock_timeout_ms:int=8000

    def validate(self):
        need(type(self)is ReviewedD03QueryProbe,'PROBE_EXACT_TYPED_AUTHORITY')
        for v in (self.runtime_sha256,self.probe_sha256,self.timeout_preflight_sha256):
            need(type(v)is str and re.fullmatch('[a-f0-9]{64}',v),'PROBE_LITERAL_HASH')
        need(type(self.effective_statement_timeout_ms)is int and self.effective_statement_timeout_ms==8000
             and type(self.effective_lock_timeout_ms)is int and self.effective_lock_timeout_ms==8000,'PROBE_REVIEWED_EIGHT_SECOND_BUDGET')
        v=json.loads(self.execution_descriptor_bytes)
        own=(v['appointment_id'],v['post_id'],v['request_id'])
        need(v['scope_id']!=self.actual_d03_scope_id and type(self.actual_d03_fixture_ids)is tuple
             and len(self.actual_d03_fixture_ids)==3 and not set(own)&set(self.actual_d03_fixture_ids),
             'PROBE_DISTINCT_SCOPE_AND_FIXTURE')
        return v

def payload(review):
    return canonical({'p_appointment_id':review.appointment_id,'p_rating':0,'p_comment':None,
                      'p_experience':'neutral','p_praises':[]})

def candidate(rows,holder,dispatch_us):
    blocked=[r for r in rows if holder['pid'] in r['blockingPids']]
    need(len(blocked)==1,'PROBE_UNIQUE_HOLDER_WAITER')
    r=blocked[0]
    need(r['state']=='active' and r['waitEventType']=='Lock' and r['blockingPids']==[holder['pid']]
         and type(r['pid'])is int and r['pid']!=holder['pid'] and type(r['backendStart'])is str
         and type(r['query'])is str and 0<len(r['query'])<=65536
         and sha(r['query'].encode())==r['querySha256']
         and len(re.findall(r'(?<![a-z_])"?submit_appointment_review"?\s*\(',r['query']))==1
         and dispatch_us<=r['xactStartUs']<=r['queryStartUs']<=r['observedUs'],
         'PROBE_CORRELATED_RPC_ONLY')
    return {'status':'UNREVIEWED_CANDIDATE','query':r['query'],'querySha256':r['querySha256'],
            'backend':{'pid':r['pid'],'backendStart':r['backendStart']},'sample':r,
            'automaticApproval':False,'actualD03Proven':False}

def response_ok(value):
    need(value.get('status')==400 and value.get('transportClosed')is True
         and value.get('body',{}).get('code')=='22023'
         and value.get('body',{}).get('message')=='invalid_review','PROBE_EXPECTED_INVALID_REVIEW')

def load_runtime(a,head):
    for relative,digest in ((SELF,a.probe_sha256),(RUNTIME,a.runtime_sha256)):
        p=ROOT/relative;raw=p.read_bytes()
        need(p.resolve()==p and not p.is_symlink() and sha(raw)==digest,'PROBE_SOURCE_CHANGED')
        need(subprocess.check_output(['git','-C',str(ROOT),'show',head+':'+relative])==raw,'PROBE_SOURCE_NOT_COMMITTED')
    p=ROOT/RUNTIME;name='d03_probe_pinned_runtime'
    spec=importlib.util.spec_from_loader(name,loader=None);m=importlib.util.module_from_spec(spec);m.__file__=str(p)
    old=sys.modules.get(name);sys.modules[name]=m
    raw=p.read_bytes();need(sha(raw)==a.runtime_sha256,'PROBE_RUNTIME_LOAD_CHANGED')
    try:exec(compile(raw,str(p),'exec'),m.__dict__)
    finally:
        if old is None:sys.modules.pop(name,None)
        else:sys.modules[name]=old
    return m

class ProbeSeal:
    """후보 전용 6초 봉인. full pre/post guard를 대체하는 일반 옵션이 아니다."""
    def __init__(self,runtime,module,authority):
        self.runtime=runtime;self.module=module;self.review=runtime.review;self.executor=runtime.executor
        self.core=runtime.core;self.children=runtime.children;self.backend_ids=runtime.backend_ids
        self.cleaning=False;self.start=None
        runtime.guard(self.review)
        observed=module.collect_timeout_preflight(runtime)
        need(not observed['unreviewedUriOptionsPresent'] and not observed['externalRestConfigMounts']
             and sha(canonical(observed))==authority.timeout_preflight_sha256,'PROBE_TIMEOUT_PREFLIGHT_LITERAL')
        pins={**runtime.value['pins'],**runtime.own_pins,SELF:authority.probe_sha256,RUNTIME:authority.runtime_sha256}
        self.sources={}
        for rel,digest in pins.items():
            p=ROOT/rel;st=p.lstat();raw=module.fast_source_bytes(p,(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,digest))
            need(sha(raw)==digest,'PROBE_SOURCE_PIN')
            self.sources[rel]=(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,digest)
        self.binding=self.core.read(self.core.root/'signed-ai-binding-private.json')
        runtime.guard(self.review)
        runtime.save('probe-seal-private.json',{'fullPreGuard':True,'fullPostGuardRequired':True,
                     'sourceSetSha256':sha(canonical(self.sources)),'timeoutPreflightSha256':authority.timeout_preflight_sha256})
    def enter(self):
        need(self.start is None,'PROBE_NO_REPLAY');self.start=time.monotonic()
    def guard(self,review,cleanup=False):
        r=self.runtime
        need(review==r.review and (self.start is None or time.monotonic()-self.start<6),'PROBE_FAST_WINDOW')
        need(not r.raw_sticky and not self.core.failures and r.memory_last is not None
             and time.monotonic()-r.memory_last<=3,'PROBE_MEMORY_OR_RAW_CLOSURE')
        need(self.core.read(self.core.root/'signed-ai-binding-private.json')==self.binding,'PROBE_ORIGINAL_BINDING')
        for rel,stamp in self.sources.items():
            need(sha(self.module.fast_source_bytes(ROOT/rel,stamp))==stamp[4],'PROBE_CAPTURED_SOURCE_CHANGED')
        need(subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True,timeout=1).strip()==review.source_head,'PROBE_HEAD_CHANGED')
    def save(self,*args):return self.runtime.save(*args)
    def finish_raw_backend(self,*args):return self.runtime.finish_raw_backend(*args)
    def mark_raw_unclosed(self,*args):return self.runtime.mark_raw_unclosed(*args)

class ProbeHTTP:
    def __init__(self,seal,holder):
        self.seal=seal;self.result=None;self.error=None;self.response_closed=False;self.released=threading.Event()
        self.release_error=None;self.release_sent_at=None;self.dispatch_started=None
        self.holder=holder
        self.watchdog=threading.Thread(target=self._watchdog,daemon=True)
        self.thread=threading.Thread(target=self._execute,daemon=True)
    def release(self):
        # 한 번만 COMMIT을 보내며 monitor/guard 실패에도 own lock 해제는 시도한다.
        with self.lock:
            if self.released.is_set():return
            try:self.holder.send("commit;select json_build_object('releasedUs',(extract(epoch from clock_timestamp())*1000000)::bigint,'actualCommitCompletedUpperBound',true);\n")
            except BaseException as e:self.release_error=e
            self.release_sent_at=time.monotonic();self.released.set()
    def _watchdog(self):
        if not self.released.wait(3):self.release()
    def start(self):
        self.lock=threading.Lock();self.dispatch_started=time.monotonic()
        self.watchdog.start();self.thread.start()
    def _execute(self):
        response=None
        try:
            s=self.seal;r=s.runtime;s.guard(r.review)
            need(re.fullmatch(r'http://127[.]0[.]0[.]1:[0-9]+',r.core.binding['origin']),'PROBE_LOOPBACK_ONLY')
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self,*args):return None
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
            request=urllib.request.Request(r.core.binding['origin']+'/rest/v1/rpc/submit_appointment_review',
                data=payload(r.review),method='POST',headers={'apikey':r.core.binding['credentials']['anon'],
                'Authorization':'Bearer '+r.account['accessToken'],'Content-Type':'application/json','Accept':'application/json'})
            try:response=opener.open(request,timeout=7)
            except urllib.error.HTTPError as e:response=e
            raw=response.read(65537);s.save('probe-http-body-private.bin',raw)
            need(len(raw)<=65536,'PROBE_HTTP_LIMIT')
            self.result={'status':response.code,'body':json.loads(raw),'transportClosed':True}
        except BaseException as e:self.error=e
        finally:
            if response is not None:response.close();self.response_closed=True
            try:self.seal.save('probe-http-closed-private.json',{'transportClosed':self.response_closed,
                'failureType':None if self.error is None else type(self.error).__name__,'automaticReplay':False})
            except BaseException as e:self.error=e
    def close(self):
        self.release();self.watchdog.join(4);self.thread.join(8)
        need(not self.watchdog.is_alive() and not self.thread.is_alive(),'PROBE_WORKER_UNCLOSED')
        if self.release_error is not None:raise self.release_error


def observe(runtime,module,authority):
    """짧은 후보 관측. 공개 실행은 run_reviewed만 허용한다."""
    seal=ProbeSeal(runtime,module,authority);holder=observer=request=None;result=None;error=None
    try:
        holder=module.PsqlHolder(seal,label='probe-holder');hid=holder.identity()
        observer=module.FastReadObserver(seal);observer.identity()
        runtime.guard(runtime.review)
        seal.enter()
        clock=observer.query_json("select json_build_object('nowUs',(extract(epoch from clock_timestamp())*1000000)::bigint)",1)
        runtime.save('probe-http-intent-private.json',{'payloadSha256':sha(payload(runtime.review)),
            'userId':runtime.review.reviewer_id,'sessionId':runtime.review.original_session_id,
            'dispatchUs':clock['nowUs'],'automaticReplay':False})
        request=ProbeHTTP(seal,holder);request.start();runtime.http_dispatched=True
        observed=None;index=0
        while time.monotonic()-request.dispatch_started<2.5:
            rows=observer.query_json(module.fast_activity_sql(),.5);index+=1
            runtime.save(f'probe-wait-{index:03d}-private.json',rows)
            if any(hid['pid'] in row['blockingPids'] for row in rows):
                observed=candidate(rows,hid,clock['nowUs']);break
            if request.error is not None:raise request.error
        request.release()
        release=holder.next_json(1);runtime.save('probe-release-private.json',release)
        need(release.get('actualCommitCompletedUpperBound')is True,'PROBE_COMMIT_UPPER_BOUND')
        request.close()
        if request.error is not None:raise request.error
        need(observed is not None,'PROBE_NO_WAITER')
        response_ok(request.result)
        need(release['releasedUs']-observed['sample']['queryStartUs']<7000000,'PROBE_TIMEOUT_MARGIN')
        seal.guard(runtime.review)
        result=observed
        return result,request
    except BaseException as e:
        error=e;runtime.save('probe-not-proven-private.json',{'status':'NOT_PROVEN','failureType':type(e).__name__,'automaticReplay':False})
        raise
    finally:
        failures=[]
        for child in (request,observer,holder):
            if child is not None:
                try:child.close()
                except BaseException as e:failures.append(type(e).__name__)
        try:runtime.guard(runtime.review,cleanup=True)
        except BaseException as e:failures.append(type(e).__name__)
        if failures:
            if error is not None:error.add_note('PROBE_CLOSE_UNPROVEN:'+','.join(failures))
            else:raise ValueError('PROBE_CLOSE_UNPROVEN:'+','.join(failures))


def finalize_probe(runtime,review,before,attempted,original):
    """미확정 요청/보존 실패는 후속 fixture 쓰기를 금지하며 late monitor도 전파한다."""
    error=original
    try:
        runtime.close_owned_children();runtime.guard(review,cleanup=True)
        runtime.verify_owned_backends_absent()
        need(not runtime.http_dispatched or runtime.probe_pool_closed,'PROBE_REQUEST_TRANSACTION_UNPROVEN_NO_FIXTURE_WRITE')
        if attempted:runtime.cleanup_fixture(review)
        final=runtime.snapshot();runtime.save('probe-cleanup-private.json',final)
        if before is not None:runtime.verify_delta(before,final,review,cleanup=True)
    except BaseException as cleanup:
        if original is not None:original.add_note('PROBE_CLEANUP_UNPROVEN:'+type(cleanup).__name__)
        else:error=cleanup;raise
    finally:runtime.close(error)


def run_reviewed(authority):
    need(type(authority)is ReviewedD03QueryProbe,'PROBE_EXACT_TYPED_AUTHORITY')
    fields=authority.validate();module=load_runtime(authority,fields['source_head'])
    owned=json.loads(authority.owned_source_pins_bytes);module.verify_own_sources(fields['source_head'],owned)
    need(owned[module.SELF]==authority.runtime_sha256,'PROBE_RUNTIME_PIN_EQUAL')
    ro=module.load(module.READONLY,owned[module.READONLY]);ex=module.load(module.EXECUTOR,owned[module.EXECUTOR])
    review=ex.ReviewedDeadlineExecution(**fields);review.validate();value=ro.exact(authority.service_descriptor_bytes)
    need(review.source_head==value['sourceHead'] and review.binding_sha==value['bindingSha256']
         and review.original_receipt_sha==value['auth6ReceiptSha256'] and review.source_pins_sha==sha(canonical(value['pins']))
         and review.scope_id==value['scopeId'] and review.decision_id==value['decisionId'],'PROBE_SOURCE_BINDING')
    service=module.reconstruct_service_review(ro,value)
    old_path=list(sys.path);old_runner=sys.modules.get('run_database_tests');runtime=None;error=None;before=None;attempted=False;result=None
    try:
        sys.modules['run_database_tests']=ro.load('tools/local/run_database_tests.py',value['pins']['tools/local/run_database_tests.py'])
        with ro.current_support(value['pins']):
            try:
                runtime=module.FixedDeadlineRuntime(authority,ro,ex,service,review);runtime.probe_pool_closed=False;runtime.bind()
                runtime.save('probe-single-intent.json',{'scopeId':review.scope_id,'rootReviewSha256':sha(canonical({k:sha(v) if type(v)is bytes else v for k,v in authority.__dict__.items()})),
                    'status':'UNREVIEWED_PROBE_ONLY','automaticReplay':False})
                runtime.verify_original_auth(review);before=runtime.snapshot();runtime.save('probe-before-private.json',before)
                attempted=True;runtime.sql(ex.fixture_sql(review));after=runtime.snapshot();runtime.verify_delta(before,after,review,cleanup=False)
                result,request=observe(runtime,module,authority)
                # 후보는 root 승인물이 아니다. 원 PostgREST backend만 idle/종결 검산한다.
                rows=runtime.activity();runtime.save('probe-pool-final-private.json',rows)
                proof=module.pooled_transaction_closed(rows,result['backend'],{'query':result['query'],'querySha256':result['querySha256']},request.response_closed and not request.thread.is_alive())
                runtime.save('probe-pool-closure-private.json',proof);runtime.probe_pool_closed=True
            except BaseException as e:
                error=e
                if runtime is not None and runtime.core.evidence_owned:
                    try:runtime.save('probe-primary-failure-private.json',{'status':'NOT_PROVEN','failureType':type(e).__name__,'automaticReplay':False})
                    except BaseException as save_error:e.add_note('PROBE_FAILURE_SAVE_UNPROVEN:'+type(save_error).__name__)
                raise
            finally:
                if runtime is not None:
                    finalize_probe(runtime,review,before,attempted,error)
        # helper context의 최종 source 재검증까지 성공한 뒤에만 최종 후보 영수증을 발행한다.
        if error is None and result is not None:
            runtime.save('probe-candidate-private.json',{**result,'fullBaselineRestored':True,'finalMonitorJoined':True,
                'supportContextExited':True,'actualNaver':'NOT_RUN','actualStorageAPI':'NOT_RUN','actualD03Proven':False})
        return result
    finally:
        sys.path[:]=old_path
        if old_runner is None:sys.modules.pop('run_database_tests',None)
        else:sys.modules['run_database_tests']=old_runner

if __name__=='__main__':print(json.dumps({'status':'NOT_RUN','reason':'root 독립 typed probe 검토와 fresh source 필요'},ensure_ascii=False))
