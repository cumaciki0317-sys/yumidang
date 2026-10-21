"""Auth 발급 전 D03 고정 catalog SQL smoke. CLI/import NOT_RUN, root만 실제 실행한다."""
import ast
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time

ROOT=Path(__file__).resolve().parents[2]
SELF='tools/local/run_d03_catalog_smoke.py'
SOURCE='tools/local/run_current_auth_source.py'
BATCH='tools/local/collect_d03_timeout_batch.py'
RUNTIME='tests/integration/minkyu/deadline_lock_runtime.py'
READONLY='tests/integration/minkyu/service_profile_readonly_local.py'
KERNEL='tests/integration/jonghyun/isolated_ai_contracts.py'
EXTRA={SELF,BATCH,RUNTIME,READONLY}
ORDER=('initial','activity','fast','sequence','roles','routines')
PREAUTH="select json_build_object('authUsers',(select count(*)from auth.users),'authSessions',(select count(*)from auth.sessions),'authIdentities',(select count(*)from auth.identities),'authRefreshTokens',(select count(*)from auth.refresh_tokens),'authMfaClaims',(select count(*)from auth.mfa_amr_claims),'profiles',(select count(*)from public.profiles));"

def need(v,code):
    if not v:raise ValueError(code)
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def sha(v):return hashlib.sha256(v).hexdigest()
def exact(raw):
    def pairs(items):
        d={}
        for k,v in items:need(k not in d,'SMOKE_DUPLICATE_JSON');d[k]=v
        return d
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in()).throw(ValueError('SMOKE_NONFINITE_JSON')))

@dataclass(frozen=True)
class ReviewedD03CatalogSmoke:
    source_kwargs_bytes:bytes
    extra_pins_bytes:bytes
    current_profile_bytes:bytes
    query_registry_sha256:str
    decision_id:str
    output_name:str
    def descriptor(self):return {k:sha(v)if type(v)is bytes else v for k,v in self.__dict__.items()}
    def validate(self):
        need(type(self)is ReviewedD03CatalogSmoke and all(type(v)is bytes for v in(self.source_kwargs_bytes,self.extra_pins_bytes,self.current_profile_bytes)),'SMOKE_TYPED_ROOT_REVIEW')
        kw=exact(self.source_kwargs_bytes);pins=exact(self.extra_pins_bytes);profile=exact(self.current_profile_bytes)
        need(type(kw)is dict and type(kw.get('head'))is str and re.fullmatch('[a-f0-9]{40}',kw['head'])
             and type(kw.get('pins'))is dict,'SMOKE_LITERAL_SOURCE_HEAD')
        for rel,digest in kw['pins'].items():
            need(type(rel)is str and not Path(rel).is_absolute()and '..'not in Path(rel).parts
                 and type(digest)is str and re.fullmatch('[a-f0-9]{64}',digest),'SMOKE_SOURCE_PIN_PATH')
        need(SOURCE in kw['pins'],'SMOKE_SOURCE_RUNNER_PIN')
        need(type(pins)is dict and set(pins)==EXTRA and all(type(v)is str and re.fullmatch('[a-f0-9]{64}',v)for v in pins.values()),'SMOKE_EXACT_EXTRA_PINS')
        need(type(self.query_registry_sha256)is str and re.fullmatch('[a-f0-9]{64}',self.query_registry_sha256),'SMOKE_LITERAL_QUERY_SHA')
        need(type(profile)is dict and profile.get('sourceHead')==kw['head'],'SMOKE_PROFILE_SOURCE_HEAD')
        need(re.fullmatch('[A-Za-z0-9_-]{1,96}',self.decision_id or '')and re.fullmatch('catalog-smoke-[A-Za-z0-9_-]{1,64}',self.output_name or ''),'SMOKE_NEW_SCOPE')
        return kw,pins,profile

def catalog_registry(runtime_raw):
    """서명한 runtime의 정확한 여섯 메서드만 읽는다. 자유 SQL registry를 받지 않는다."""
    tree=ast.parse(runtime_raw)
    def function(name):return next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name==name)
    cls=next(n for n in tree.body if isinstance(n,ast.ClassDef)and n.name=='FixedDeadlineRuntime')
    def method(name):return next(n for n in cls.body if isinstance(n,ast.FunctionDef)and n.name==name)
    def one(node,prefix):
        values=[n.value for n in ast.walk(node)if isinstance(n,ast.Constant)and type(n.value)is str and n.value.startswith(prefix)]
        need(len(values)==1,'SMOKE_FIXED_AST_QUERY');return values[0]
    values={'initial':one(function('initial_activity_sql'),'select '),'activity':one(method('activity'),'select '),
        'fast':one(function('fast_activity_sql'),'select '),'sequence':one(method('sequence_state'),'select ')}
    timeout=function('collect_timeout_preflight')
    values['roles']=one(timeout,"select coalesce(jsonb_agg(jsonb_build_object('database'")
    values['routines']=one(timeout,"select coalesce(jsonb_agg(jsonb_build_object('identity'")
    need(tuple(values)==ORDER and values['fast'].startswith('select pg_stat_clear_snapshot();select '),'SMOKE_EXACT_SIX_QUERY_SHAPES')
    return values

def scripts(batch,registry,snapshot_queries,controls):
    need(tuple(registry)==ORDER,'SMOKE_QUERY_SET')
    before=batch.batch_sql({**snapshot_queries,'controls':controls,'preauth':PREAUTH})
    result={'before':before}
    for label in ORDER:
        query=registry[label]
        if label=='fast':
            clear='select pg_stat_clear_snapshot();'
            need(query.startswith(clear)and ';'not in query[len(clear):].rstrip(';'),'SMOKE_FIXED_FAST_PAIR')
            body=batch.batch_sql({'fast':query[len(clear):].rstrip(';')+';'})
            marker=b"select json_build_object('fast',"
            need(body.count(marker)==1,'SMOKE_FAST_ENVELOPE_POSITION')
            body=body.replace(marker,clear.encode()+b'\n'+marker,1)
        else:body=batch.batch_sql({label:query.rstrip(';')+';'})
        result[label]=body
    result['after']=batch.batch_sql({**snapshot_queries,'controls':controls,'preauth':PREAUTH})
    need(len(result)==8 and list(result)==['before',*ORDER,'after'],'SMOKE_EIGHT_FINITE_PG')
    return result

class FixedSmokePg:
    """8개 고정 script만 실행한다. raw 저장/PG·backend 종료 실패는 다음 호출을 금지한다."""
    def __init__(self,source,runner,db_id,bodies,save,live):
        need(list(bodies)==['before',*ORDER,'after'],'SMOKE_FIXED_OPERATION_LIST')
        self.source=source;self.runner=runner;self.db_id=db_id;self.bodies=dict(bodies)
        self.body_sha={k:sha(v)for k,v in bodies.items()};self.save=save;self.live=live;self.sticky=False;self.counter=0
        self.last_closure={'localProcessGroupClosed':False,'backendAbsent':False,'markerParsed':False,'status':'NOT_STARTED'}
    def run(self,label):
        need(not self.sticky,'SMOKE_STICKY_NO_NEXT_SQL')
        expected=['before',*ORDER,'after'];need(self.counter<len(expected)and label==expected[self.counter],'SMOKE_FIXED_ORDER_NO_REPLAY')
        body=self.bodies[label];need(sha(body)==self.body_sha[label],'SMOKE_SCRIPT_CHANGED');self.live()
        if self.counter==0:self.runner.memory(1048576)
        self.counter+=1;self.sticky=True
        self.last_closure={'localProcessGroupClosed':False,'backendAbsent':False,'markerParsed':False,'status':'UNPROVEN'}
        prefix='pg-'+str(self.counter)+'-'+label
        argv=['docker','--host',self.source.HOST,'exec','-i',self.db_id,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-f','-']
        self.save(prefix+'-intent.json',{'argv':argv,'sqlUtf8':body.decode(),'sqlSha256':sha(body),'singleAttempt':True,
            'transaction':'REPEATABLE_READ_READ_ONLY','observerStatementTimeoutMs':30000,'processTimeoutSeconds':35})
        child=None;failure=None;closure=None
        with tempfile.TemporaryFile()as inp,tempfile.TemporaryFile()as out,tempfile.TemporaryFile()as err:
            inp.write(body);inp.seek(0)
            try:
                child=subprocess.Popen(argv,stdin=inp,stdout=out,stderr=err,start_new_session=True);began=time.monotonic()
                while child.poll()is None:
                    self.live();need(time.monotonic()-began<35,'SMOKE_PG_TIMEOUT')
                    need(os.fstat(out.fileno()).st_size<=8388608 and os.fstat(err.fileno()).st_size<=65536,'SMOKE_RAW_LIMIT');time.sleep(.05)
            except BaseException as e:failure=e
            finally:
                if child is not None:
                    try:closure=self.source.close_process_group(child,terminate=failure is not None)
                    except BaseException as e:
                        if failure is None:failure=e
                out.seek(0);raw=out.read(8388609);err.seek(0);stderr=err.read(65537)
                self.last_closure['localProcessGroupClosed']=bool(closure and closure.get('closed')is True)
                self.last_closure['returnCode']=None if child is None else child.returncode
                self.save(prefix+'-raw-private.json',{'stdoutHex':raw.hex(),'stderrHex':stderr.hex(),'closure':closure,
                    'returnCode':None if child is None else child.returncode,'failureType':None if failure is None else type(failure).__name__})
        local_closed=child is not None and closure and closure.get('closed')is True
        primary=failure
        if primary is None and not local_closed:primary=ValueError('SMOKE_PROCESS_GROUP_UNPROVEN')
        if primary is None and (child.returncode!=0 or len(raw)>8388608 or len(stderr)>65536):primary=ValueError('SMOKE_POSTGRES_QUERY_FAILED')
        lines=raw.splitlines();marker=None
        try:
            marker=exact(lines[0])if lines else None
            need(type(marker)is dict and set(marker)=={'pid','backendStart'}and type(marker['pid'])is int
                and 1<marker['pid']<2147483648 and type(marker['backendStart'])is str and marker['backendStart'],'SMOKE_EXACT_BACKEND')
            self.last_closure['markerParsed']=True
        except BaseException as marker_error:
            if primary is None:primary=marker_error
        if local_closed and marker is not None and self.last_closure['markerParsed']:
            try:
                self.observe_backend(marker,prefix);self.last_closure['backendAbsent']=True
            except BaseException as backend_error:
                if primary is None:primary=backend_error
                else:primary.add_note('SMOKE_BACKEND_CLOSURE_UNPROVEN:'+type(backend_error).__name__)
        self.last_closure['status']='CLOSED'if self.last_closure['backendAbsent']and local_closed else'UNPROVEN'
        self.save(prefix+'-closure-status.json',dict(self.last_closure))
        if primary is not None:raise primary
        if label=='fast':need(len(lines)==3 and lines[1]==b'','SMOKE_EXACT_FAST_VOID_OUTPUT');lines=[lines[0],lines[2]]
        else:need(len(lines)==2,'SMOKE_EXACT_MARKER_ENVELOPE')
        value=exact(lines[1]);self.live();self.sticky=False;return value
    def observe_backend(self,marker,prefix):
        observations=[];began=time.monotonic()
        while True:
            answer=self.runner.call(['exec',self.db_id,'/bin/sh','-c','if [ -d /proc/'+str(marker['pid'])+' ]; then printf PRESENT; else printf ABSENT; fi'],timeout=2)
            observations.append(answer)
            if answer=='ABSENT':break
            need(answer=='PRESENT'and time.monotonic()-began<3,'SMOKE_BACKEND_UNPROVEN');time.sleep(.05)
        self.save(prefix+'-closed.json',{'backend':marker,'localProcessGroupClosed':True,'backendAbsent':True,
            'observations':observations,'recursiveSqlObserver':False})



def captured_load(relative,raw,name):
    spec=importlib.util.spec_from_loader(name,loader=None);module=importlib.util.module_from_spec(spec);module.__file__=str(ROOT/relative)
    old=sys.modules.get(name);sys.modules[name]=module
    try:exec(compile(raw,module.__file__,'exec'),module.__dict__)
    finally:
        if old is None:sys.modules.pop(name,None)
        else:sys.modules[name]=old
    return module

def preauth_files(root):
    need(not any(p.exists()or p.is_symlink()for p in(root/'signed-ai-binding-private.json',root/'root-auth6-current-receipt.json'))
         and not list(root.glob('auth-provision-*')),'SMOKE_FRESH_PREAUTH_SOURCE_ONLY')
def zero_auth(value):
    need(type(value)is dict and set(value)=={'authUsers','authSessions','authIdentities','authRefreshTokens','authMfaClaims','profiles'}
         and all(type(n)is int and n==0 for n in value.values()),'SMOKE_AUTH_NOT_EMPTY')


def run_reviewed(authority):
    need(type(authority)is ReviewedD03CatalogSmoke,'SMOKE_TYPED_ROOT_REVIEW');kw,extra,profile=authority.validate()
    captured={}
    need(all(rel not in kw['pins']or kw['pins'][rel]==digest for rel,digest in extra.items()),'SMOKE_PIN_COLLISION')
    for rel,digest in {**kw['pins'],**extra}.items():
        path=ROOT/rel;need(path.resolve()==path and not path.is_symlink(),'SMOKE_SOURCE_PATH');raw=path.read_bytes()
        need(sha(raw)==digest and subprocess.check_output(['git','-C',str(ROOT),'show',kw['head']+':'+rel])==raw,'SMOKE_COMMITTED_SOURCE')
        captured[rel]=raw
    source=captured_load(SOURCE,captured[SOURCE],'d03_smoke_source');batch=captured_load(BATCH,captured[BATCH],'d03_smoke_batch')
    readonly=captured_load(READONLY,captured[READONLY],'d03_smoke_readonly')
    registry=catalog_registry(captured[RUNTIME]);need(sha(canonical(registry))==authority.query_registry_sha256,'SMOKE_ROOT_QUERY_REGISTRY')
    review=source.ReviewedCurrentAuthSource(**kw);runner=None;transport=None;writer=None;error=None
    done=threading.Event();watcher=None;failures=[];gate=batch.FinalReceiptGate();receipt=None
    def captured_guard():
        need(subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True,timeout=2).strip()==kw['head'],'SMOKE_HEAD_CHANGED')
        for rel,raw in captured.items():need(batch.captured_file(ROOT/rel,sha(raw))==raw,'SMOKE_CAPTURED_SOURCE_CHANGED')
        if runner is not None:preauth_files(runner.root)
    def full_guard():
        captured_guard();runner.runtime_source();raw,_=runner.baseline_guard();runner.check_owned(runner.read('owned-resources.json'),raw,running=True)
        runner.memory(786432);runner.healthy()
    def watch():
        while not done.is_set():
            began=time.monotonic()
            try:captured_guard()
            except BaseException as e:failures.append(type(e).__name__);return
            done.wait(max(0,began+3-time.monotonic()))
    def live():need(not failures,'SMOKE_CAPTURED_MONITOR');runner.healthy()
    def save(name,value):need(writer is not None,'SMOKE_WRITER_NOT_READY');return writer.save(name,value)
    provenance={'authorityDescriptorSha256':sha(canonical(authority.descriptor())),'queryRegistrySha256':authority.query_registry_sha256,
        'sourceHead':kw['head'],'currentProfileSha256':sha(authority.current_profile_bytes),'actualAuthIssued':0,'httpRequests':0,
        'fixtureWrites':0,'automaticReplay':False,'queryFingerprintApproved':False,'productTimeoutApproved':False}
    try:
        with gate.support(source.runtime_support(review))as support:
            runner=source.CurrentAuthSource(review,support);runner.phase=authority.decision_id;runner.plan=runner.source()['target'];runner.runtime_source();preauth_files(runner.root)
            readonly.verify_current_profile(profile,kw['pins'],kw['head'])
            packet=runner.read('signed-provisioning-packet-private.json');first=runner.read('owned-first-inspection.json');containers=packet['containers']
            need(set(containers)=={'db','auth','rest','gateway'}and len(first)==4 and {v['id']for v in containers.values()}=={x['Id']for x in first},'SMOKE_EXACT_FOUR')
            db=containers['db']['id'];need(next(x for x in first if x['Id']==db)['HostConfig'].get('PidMode')=='','SMOKE_PRIVATE_PID_NAMESPACE')
            snapshot=batch.kernel_queries(captured[KERNEL],tuple(profile['expectedTables']));controls,expected_controls=batch.control_query(captured[KERNEL]);bodies=scripts(batch,registry,snapshot,controls)
            output=runner.root/authority.output_name;output.mkdir(mode=0o700,exist_ok=False);writer=batch.PrivateOutputWriter(output)
            try:
                runner.start_monitor();watcher=threading.Thread(target=watch,daemon=True);watcher.start();full_guard()
                save('intent.json',{**provenance,'finitePgCount':8,'catalogOperations':list(ORDER),'sourceReviewSha256':sha(review._sealed)})
                transport=FixedSmokePg(source,runner,db,bodies,save,live)
                before=transport.run('before');save('before-private.json',before);a=batch.snapshot_from(before,tuple(profile['expectedTables']))
                zero_auth(exact(before['preauth']));need(exact(before['controls'])==expected_controls,'SMOKE_CONTROLS_OPEN')
                outcomes=[]
                for label in ORDER:
                    result=transport.run(label);need(type(result)is dict and set(result)=={label}and type(result[label])is str,'SMOKE_FIXED_RESULT_ENVELOPE')
                    decoded=exact(result[label]);need(type(decoded)is list,'SMOKE_CATALOG_LIST_RESULT')
                    ref=save('result-'+label+'-private.json',result);outcomes.append({'label':label,'rawResultSha256':ref,'postgresExecuted':True})
                after=transport.run('after');save('after-private.json',after);b=batch.snapshot_from(after,tuple(profile['expectedTables']))
                zero_auth(exact(after['preauth']));need(exact(after['controls'])==expected_controls and a==b,'SMOKE_BASELINE_CHANGED');full_guard()
                receipt={**provenance,'status':'PASS_PREAUTH_FIXED_CATALOG_SQL_ONLY','finitePgCount':8,'catalogOutcomes':outcomes,
                    'fullBaselineUnchanged':True,'supportContextExited':True,'monitorJoined':True,'sourceReviewSha256':sha(review._sealed)}
            except BaseException as e:error=e;raise
            finally:
                done.set();runner.done.set()
                if watcher is not None:watcher.join(4)
                if runner.thread is not None:runner.thread.join(4)
                closed=watcher is not None and not watcher.is_alive()and runner.thread is not None and not runner.thread.is_alive()
                final_ok=closed and not failures and not runner.failures and not runner.unclosed_child and transport is not None and not transport.sticky
                save('finalization.json',{'status':'PENDING_CONTEXT_EXIT'if error is None and final_ok else'FAIL_CLOSED','failureType':None if error is None else type(error).__name__,
                    'memoryFailures':runner.failures,'captureFailures':failures,'sqlSticky':None if transport is None else transport.sticky,'monitorJoined':closed,'lastPgClosure':None if transport is None else dict(transport.last_closure)})
                if error is None:need(final_ok,'SMOKE_LATE_FINALIZATION_FAILED');gate.finalized=True
        captured_guard();gate.publish(save,receipt);return {'status':receipt['status'],'sourceHead':kw['head'],'receiptSha256':sha(canonical(receipt))}
    finally:
        done.set()
        if writer is not None:writer.close()

if __name__=='__main__':print(json.dumps({'status':'NOT_RUN','reason':'root literal review와 새 preauth source가 필요합니다.'},ensure_ascii=False))
