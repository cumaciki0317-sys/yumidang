"""고정 read-only D03 timeout 원자료 batch. CLI/import NOT_RUN, 승인 자동 생성 없음."""
import ast
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import stat
import sys
import tempfile
import threading
import time

ROOT=Path(__file__).resolve().parents[2]
SELF='tools/local/collect_d03_timeout_batch.py'
SOURCE='tools/local/run_current_auth_source.py'
KERNEL='tests/integration/jonghyun/isolated_ai_contracts.py'
DEADLINE='tests/integration/minkyu/deadline_lock_runtime.py'
SCHEMAS={'auth','public','private','storage','cron','vault'}

def need(value,code):
    if not value:raise ValueError(code)
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def sha(v):return hashlib.sha256(v).hexdigest()
def exact(raw):
    def pairs(items):
        d={}
        for k,v in items:need(k not in d,'BATCH_DUPLICATE_JSON');d[k]=v
        return d
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in()).throw(ValueError('BATCH_NONFINITE_JSON')))

def tables_checked(tables):
    need(type(tables)is tuple and list(tables)==sorted(tables) and len(set(tables))==len(tables) and tables,'BATCH_EXACT_TABLE_LIST')
    for t in tables:
        need(type(t)is str and re.fullmatch('[A-Za-z_][A-Za-z_0-9]*[.][A-Za-z_][A-Za-z_0-9]*',t)
             and t.split('.')[0]in SCHEMAS,'BATCH_TABLE_IDENTIFIER')
    return tables

@dataclass(frozen=True)
class ReviewedD03ReadonlyBatch:
    source_kwargs_bytes:bytes
    source_sha256:str
    collector_sha256:str
    deadline_sha256:str
    binding_sha256:str
    auth6_receipt_relative:str
    auth6_receipt_sha256:str
    expected_tables:tuple
    table_set_sha256:str
    decision_id:str
    output_name:str
    def descriptor(self):
        return {k:sha(v) if type(v)is bytes else list(v) if type(v)is tuple else v for k,v in self.__dict__.items()}
    def validate(self):
        need(type(self)is ReviewedD03ReadonlyBatch and type(self.source_kwargs_bytes)is bytes,'BATCH_TYPED_ROOT_REVIEW')
        for x in (self.source_sha256,self.collector_sha256,self.deadline_sha256,self.binding_sha256,self.auth6_receipt_sha256,self.table_set_sha256):
            need(type(x)is str and re.fullmatch('[a-f0-9]{64}',x),'BATCH_LITERAL_SHA')
        tables_checked(self.expected_tables)
        need(sha(canonical(list(self.expected_tables)))==self.table_set_sha256,'BATCH_TABLE_SET_SHA')
        need(re.fullmatch('[A-Za-z0-9_-]{1,96}',self.decision_id or '') and re.fullmatch('timeout-batch-[A-Za-z0-9_-]{1,64}',self.output_name or ''),'BATCH_SCOPE')
        p=Path(self.auth6_receipt_relative)
        need(not p.is_absolute() and '..'not in p.parts and p.name=='receipt.json','BATCH_AUTH_RECEIPT_PATH')
        return exact(self.source_kwargs_bytes)


def strings(node):return [n.value for n in ast.walk(node)if isinstance(n,ast.Constant)and type(n.value)is str]
def method(tree,cls,name):
    c=next(n for n in tree.body if isinstance(n,ast.ClassDef)and n.name==cls)
    return next(n for n in c.body if isinstance(n,ast.FunctionDef)and n.name==name)
def unique(values,prefix):
    found=[v for v in values if v.startswith(prefix)];need(len(found)==1,'BATCH_FIXED_SOURCE_QUERY');return found[0]

def kernel_queries(raw,tables):
    tables_checked(tables);tree=ast.parse(raw)
    original=method(tree,'FixedLifecycleProvisioningPorts','original_rows')
    tables_sql=unique(strings(original),'select jsonb_agg(jsonb_build_array(schemaname,tablename)')
    # 같은 fixed kernel method의 실제 SQL 생성식을 순수 AST로 추출한다. DB 호출은 없다.
    class Capturer:
        def __init__(self):self.calls=[]
        def read_sql(self,q,timeout=5):
            self.calls.append(q)
            if len(self.calls)==1:return json.dumps([t.split('.')for t in tables])
            return json.dumps({t:{}for t in tables})
    fn=ast.FunctionDef(name='original_rows',args=original.args,body=original.body,decorator_list=[])
    unit=ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[]))
    env={'json':json,'re':re,'signed_exact_json':exact}
    exec(compile(unit,'<captured-kernel-original-rows>','exec'),env)
    c=Capturer();env['original_rows'](c)
    need(len(c.calls)==2 and c.calls[0]==tables_sql,'BATCH_KERNEL_FIVE_QUERIES')
    base=strings(method(tree,'FixedSignedProvisioningPorts','snapshot'))
    derived=strings(method(tree,'FixedLifecycleProvisioningPorts','snapshot'))
    return {'tables':tables_sql,'rows':c.calls[1],
        'authority':unique(base,'select encode(sha256(convert_to(jsonb_build_object('),
        'constraints':unique(derived,'select coalesce(jsonb_agg(to_jsonb(c)order by oid)'),
        'catalog':unique(derived,'select jsonb_build_object(\'relations\'')}

def collection_queries(deadline_raw):
    tree=ast.parse(deadline_raw)
    fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='collect_timeout_preflight')
    vals=strings(fn)
    roles=unique(vals,'select coalesce(jsonb_agg(jsonb_build_object(\'database\'')
    routines=unique(vals,'select coalesce(jsonb_agg(jsonb_build_object(\'identity\'')
    basis=next(ast.literal_eval(n.value)for n in tree.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='POSTGREST_V16_BASIS'for t in n.targets))
    return {'roles':roles,'routines':routines},list(basis)

INHERITANCE="select jsonb_build_object('database',(select jsonb_build_object('oid',oid,'name',datname,'owner',datdba)from pg_database where datname=current_database()),'roles',(select coalesce(jsonb_agg(jsonb_build_object('oid',oid,'name',rolname,'inherit',rolinherit,'canLogin',rolcanlogin,'superuser',rolsuper,'bypassRls',rolbypassrls)order by oid),'[]'::jsonb)from pg_roles),'memberships',(select coalesce(jsonb_agg(jsonb_build_object('role',roleid,'member',member,'grantor',grantor,'adminOption',admin_option,'inheritOption',inherit_option,'setOption',set_option)order by roleid,member,grantor),'[]'::jsonb)from pg_auth_members));"

def control_query(raw):
    tree=ast.parse(raw);fn=method(tree,'FixedSignedProvisioningPorts','closed_controls')
    class Capture:
        def read_sql(self,q,timeout=3):self.query=q;return '{}'
    env={'json':json,'quote':lambda s:"'"+s.replace("'","''")+"'"}
    # 현재 고정 kernel의 제어 목록을 읽는다. 관측 DB에서 목록을 승인하지 않는다.
    env['PROVISION_CLOSED_CONTROLS']=next(ast.literal_eval(n.value)for n in tree.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='PROVISION_CLOSED_CONTROLS'for t in n.targets))
    unit=ast.fix_missing_locations(ast.Module(body=[ast.FunctionDef(name='closed_controls',args=fn.args,body=fn.body,decorator_list=[])],type_ignores=[]))
    exec(compile(unit,'<captured-kernel-controls>','exec'),env);c=Capture();env['closed_controls'](c)
    return c.query,{**{k:False for k in env['PROVISION_CLOSED_CONTROLS']},'cronLaunchActiveJobs':'off'}

def batch_sql(queries):
    need(type(queries)is dict and queries,'BATCH_QUERIES')
    parts=[]
    for name,q in queries.items():
        need(re.fullmatch('[a-z]+',name)and type(q)is str and q.startswith('select ')and q.endswith(';')and ';'not in q[:-1],'BATCH_FIXED_SELECT')
        # 원 SQL 결과의 text를 문자열 값으로 보존한다. jsonb 재직렬화 금지.
        parts.extend(("'"+name+"'",'('+q[:-1]+')::text'))
    return ("begin isolation level repeatable read read only;set local statement_timeout='30s';set local lock_timeout='1500ms';"
        "select json_build_object('pid',pg_backend_pid(),'backendStart',backend_start)from pg_stat_activity where pid=pg_backend_pid();\n"
        +'select json_build_object('+','.join(parts)+');\nrollback;\n').encode()

def snapshot_from(value,tables):
    need(type(value)is dict and {'tables','rows','authority','constraints','catalog'}<=set(value),'BATCH_SNAPSHOT_FIELDS')
    need(all(type(value[k])is str for k in value),'BATCH_RAW_TEXT_ONLY')
    actual=exact(value['tables']);need(actual==[t.split('.')for t in tables],'BATCH_RUNTIME_TABLE_SET')
    rows=exact(value['rows']);need(type(rows)is dict and set(rows)==set(tables),'BATCH_ROW_SET')
    for bag in rows.values():
        need(type(bag)is dict and all(re.fullmatch('[a-f0-9]{64}',h)and type(n)is int and n>0 for h,n in bag.items()),'BATCH_ROW_BAG')
    authority=value['authority'].strip();need(re.fullmatch('[a-f0-9]{64}',authority),'BATCH_AUTHORITY_HEX')
    return {'rows':rows,'authoritySha256':authority,'constraintsSha256':sha(value['constraints'].strip().encode()),
            'catalogSha256':sha(value['catalog'].strip().encode())}

def timeout_candidate(value,rest,head,root,basis):
    config=rest['Config'];allowed={'PGRST_DB_CONFIG','PGRST_DB_PRE_REQUEST','PGRST_DB_PRE_CONFIG','PGRST_DB_HOISTED_TX_SETTINGS','PGRST_DB_TX_END'}
    env=[v for v in config['Env']if v.split('=',1)[0]in allowed]
    vals={v.split('=',1)[0]:v.split('=',1)[1]for v in config['Env']if'='in v}
    from urllib.parse import urlsplit,parse_qs
    options=bool(parse_qs(urlsplit(vals.get('PGRST_DB_URI','')).query).get('options'))or bool(vals.get('PGOPTIONS'))
    return {'roles':exact(value['roles']),'routines':exact(value['routines']),'restId':rest['Id'],'restImage':rest['Image'],
        'restConfigSha256':sha(canonical(config)),'selectedRestEnvironment':sorted(env),
        'unreviewedUriOptionsPresent':options,'externalRestConfigMounts':bool(rest.get('Mounts')),
        'restCommand':config.get('Cmd'),'restEntrypoint':config.get('Entrypoint'),'sourceHead':head,'preparedRoot':str(root),'basisUrls':basis}

class BatchTransport:
    """한 번 실패한 batch는 다음 SQL을 열지 않는다. observer는 /proc만 읽는다."""
    def __init__(self,m,runner,db_id,save,fast_guard):
        self.m=m;self.runner=runner;self.db_id=db_id;self.save=save;self.fast_guard=fast_guard;self.sticky=False;self.counter=0
    def run(self,body):
        need(not self.sticky,'BATCH_STICKY_NO_SQL');self.fast_guard();self.counter+=1;prefix='batch-'+str(self.counter)
        argv=['docker','--host',self.m.HOST,'exec','-i',self.db_id,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-f','-']
        self.sticky=True
        self.save(prefix+'-intent.json',{'sqlSha256':sha(body),'sqlUtf8':body.decode(),'argv':argv,'singleAttempt':True})
        self.sticky=True;child=None;failure=None;closure=None
        with tempfile.TemporaryFile()as inp,tempfile.TemporaryFile()as out,tempfile.TemporaryFile()as err:
            inp.write(body);inp.seek(0)
            try:
                child=subprocess.Popen(argv,stdin=inp,stdout=out,stderr=err,start_new_session=True);began=time.monotonic()
                while child.poll()is None:
                    self.fast_guard();need(time.monotonic()-began<35,'BATCH_PROCESS_TIMEOUT')
                    need(os.fstat(out.fileno()).st_size<=8388608 and os.fstat(err.fileno()).st_size<=65536,'BATCH_OUTPUT_LIMIT');time.sleep(.05)
            except BaseException as e:failure=e
            finally:
                if child is not None:
                    try:closure=self.m.close_process_group(child,terminate=failure is not None)
                    except BaseException as e:
                        if failure is None:failure=e
                out.seek(0);raw=out.read(8388609);err.seek(0);stderr=err.read(65537)
                self.save(prefix+'-raw-private.json',{'stdoutHex':raw.hex(),'stderrHex':stderr.hex(),'closure':closure,
                    'returnCode':None if child is None else child.returncode,'failureType':None if failure is None else type(failure).__name__})
        need(child is not None and closure and closure.get('closed')is True,'BATCH_PG_UNPROVEN')
        if failure is not None:raise failure
        need(child.returncode==0 and len(raw)<=8388608 and len(stderr)<=65536,'BATCH_COMMAND_FAILED')
        lines=raw.splitlines();need(len(lines)==2,'BATCH_EXACT_MARKER_ENVELOPE')
        marker=exact(lines[0]);need(type(marker)is dict and set(marker)=={'pid','backendStart'}and type(marker['pid'])is int
            and 1<marker['pid']<2147483648 and type(marker['backendStart'])is str,'BATCH_BACKEND_MARKER')
        start=time.monotonic();observations=[]
        while True:
            answer=self.runner.call(['exec',self.db_id,'/bin/sh','-c','if [ -d /proc/'+str(marker['pid'])+' ]; then printf PRESENT; else printf ABSENT; fi'],timeout=2)
            observations.append(answer)
            if answer=='ABSENT':break
            need(answer=='PRESENT'and time.monotonic()-start<3,'BATCH_BACKEND_UNPROVEN');time.sleep(.05)
        self.save(prefix+'-closed.json',{'backend':marker,'backendAbsent':True,'observations':observations,'localProcessGroupClosed':True})
        value=exact(lines[1]);self.fast_guard();self.sticky=False;return value


def captured_file(path,digest):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        st=os.fstat(fd);need(os.path.isfile(path)and st.st_uid==os.getuid(),'BATCH_SOURCE_OWNER')
        with os.fdopen(fd,'rb',closefd=False)as stream:raw=stream.read()
        now=path.lstat();need((st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns)==(now.st_dev,now.st_ino,now.st_size,now.st_mtime_ns)
            and not path.is_symlink()and sha(raw)==digest,'BATCH_CAPTURED_SOURCE_CHANGED')
        return raw
    finally:os.close(fd)

class PrivateFileAnchor:
    """보안 검사된 원 파일을 FD로 고정한다. 형제 증거 추가의 directory mtime은 무시한다."""
    @staticmethod
    def directory_identity(st):return (st.st_dev,st.st_ino,st.st_uid,st.st_gid,st.st_mode)
    @staticmethod
    def leaf_identity(st):
        return (st.st_dev,st.st_ino,st.st_uid,st.st_gid,st.st_mode,st.st_nlink,st.st_size,st.st_mtime_ns,st.st_ctime_ns)
    def __init__(self,path,digest,secure_reader):
        self.path=Path(path);self.digest=digest;self.directories=[];self.leaf=None
        need(self.path.is_absolute()and self.path.resolve()==self.path,'BATCH_ANCHOR_ABSOLUTE_PATH')
        need(sha(secure_reader(self.path))==digest,'BATCH_ANCHOR_INITIAL_PRIVATE_BYTES')
        try:
            flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
            fd=os.open('/',flags);self.directories.append((fd,None,None,self.directory_identity(os.fstat(fd))))
            for name in self.path.parent.parts[1:]:
                parent=fd;fd=os.open(name,flags,dir_fd=parent)
                self.directories.append((fd,parent,name,self.directory_identity(os.fstat(fd))))
            self.parent=fd
            self.leaf=os.open(self.path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
            st=os.fstat(self.leaf)
            need(stat.S_ISREG(st.st_mode)and st.st_uid==os.getuid()and st.st_mode&0o077==0 and st.st_nlink==1,'BATCH_ANCHOR_PRIVATE_LEAF')
            self.identity=self.leaf_identity(st);self.check()
        except BaseException:
            self.close();raise
    def check_parents(self):
        for fd,parent,name,expected in self.directories:
            need(self.directory_identity(os.fstat(fd))==expected,'BATCH_ANCHOR_PARENT_FD_CHANGED')
            if parent is not None:
                need(self.directory_identity(os.stat(name,dir_fd=parent,follow_symlinks=False))==expected,'BATCH_ANCHOR_PARENT_PATH_CHANGED')
    def check(self):
        need(self.leaf is not None,'BATCH_ANCHOR_CLOSED');self.check_parents()
        fd=os.open(self.path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=self.parent)
        try:
            need(self.leaf_identity(os.fstat(self.leaf))==self.identity and self.leaf_identity(os.fstat(fd))==self.identity,'BATCH_ANCHOR_LEAF_CHANGED')
            chunks=[];offset=0
            while offset<self.identity[6]:
                chunk=os.pread(fd,min(1048576,self.identity[6]-offset),offset)
                need(chunk,'BATCH_ANCHOR_SHORT_READ');chunks.append(chunk);offset+=len(chunk)
            need(sha(b''.join(chunks))==self.digest,'BATCH_ANCHOR_BYTES_CHANGED')
            need(self.leaf_identity(os.fstat(fd))==self.identity and self.leaf_identity(os.stat(self.path.name,dir_fd=self.parent,follow_symlinks=False))==self.identity,'BATCH_ANCHOR_READ_CHANGED')
            self.check_parents()
        finally:os.close(fd)
    def close(self):
        if self.leaf is not None:os.close(self.leaf);self.leaf=None
        for fd,_,_,_ in reversed(self.directories):os.close(fd)
        self.directories=[]


class PrivateOutputWriter(PrivateFileAnchor):
    """소유한 출력 디렉터리 FD 아래에만 O_EXCL 파일을 만들며 경로 연결도 확인한다."""
    def __init__(self,path):
        self.path=Path(path);self.directories=[];self.leaf=None
        need(self.path.is_absolute()and self.path.resolve()==self.path,'BATCH_OUTPUT_ABSOLUTE_PATH')
        try:
            flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
            fd=os.open('/',flags);self.directories.append((fd,None,None,self.directory_identity(os.fstat(fd))))
            for name in self.path.parts[1:]:
                parent=fd;fd=os.open(name,flags,dir_fd=parent)
                self.directories.append((fd,parent,name,self.directory_identity(os.fstat(fd))))
            self.output_fd=fd;st=os.fstat(fd)
            need(st.st_uid==os.getuid()and stat.S_ISDIR(st.st_mode)and st.st_mode&0o077==0,'BATCH_PRIVATE_OUTPUT_MODE')
            self.check_parents()
        except BaseException:self.close();raise
    def save(self,name,value):
        need(type(name)is str and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,191}',name),'BATCH_PRIVATE_OUTPUT_NAME')
        self.check_parents();raw=canonical(value)
        fd=os.open(name,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=self.output_fd)
        try:
            st=os.fstat(fd)
            need(stat.S_ISREG(st.st_mode)and st.st_uid==os.getuid()and st.st_nlink==1 and st.st_mode&0o077==0,'BATCH_OUTPUT_LEAF_MODE')
            self.check_parents()
            with os.fdopen(fd,'wb',closefd=False)as stream:stream.write(raw);stream.flush();os.fsync(fd)
            os.fsync(self.output_fd);self.check_parents()
            stored=os.fstat(fd)
            need(stat.S_ISREG(stored.st_mode)and stored.st_uid==os.getuid()and stat.S_IMODE(stored.st_mode)==0o600
                 and stored.st_nlink==1 and stored.st_size==len(raw),'BATCH_OUTPUT_STORED_METADATA')
            saved=os.pread(fd,len(raw)+1,0)
            need(len(saved)==len(raw)and sha(saved)==sha(raw),'BATCH_OUTPUT_STORED_BYTES')
            self.check_parents()
            need(self.leaf_identity(stored)==self.leaf_identity(os.fstat(fd))
                 and self.leaf_identity(stored)==self.leaf_identity(os.stat(name,dir_fd=self.output_fd,follow_symlinks=False)),'BATCH_OUTPUT_LEAF_REPLACED')
        finally:os.close(fd)
        return sha(raw)


class FinalReceiptGate:
    """원 context 종료와 monitor 최종 판정이 모두 끝난 경우만 영수증을 허용한다."""
    def __init__(self):self.exited=False;self.finalized=False
    @contextmanager
    def support(self,manager):
        with manager as value:yield value
        self.exited=True
    def publish(self,save,value):
        need(self.exited and self.finalized,'BATCH_FINAL_RECEIPT_NOT_PERMITTED')
        return save('receipt.json',value)


def run_reviewed(authority):
    need(type(authority)is ReviewedD03ReadonlyBatch,'BATCH_TYPED_ROOT_REVIEW');kw=authority.validate()
    head=kw['head'];pins=kw['pins'];need(pins[SOURCE]==authority.source_sha256,'BATCH_SOURCE_PIN')
    extra={SELF:authority.collector_sha256,DEADLINE:authority.deadline_sha256}
    captured={}
    for rel,digest in {**pins,**extra}.items():
        raw=captured_file(ROOT/rel,digest)
        need(subprocess.check_output(['git','-C',str(ROOT),'show',head+':'+rel])==raw,'BATCH_UNCOMMITTED_SOURCE');captured[rel]=raw
    spec=importlib.util.spec_from_loader('d03_batch_source',loader=None);m=importlib.util.module_from_spec(spec);m.__file__=str(ROOT/SOURCE)
    exec(compile(captured[SOURCE],m.__file__,'exec'),m.__dict__)
    review=m.ReviewedCurrentAuthSource(**kw);anchors=[];runner=None;error=None;result=None;transport=None;done=threading.Event();failures=[];thread=None
    def source_guard(strong=False):
        need(subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True,timeout=2).strip()==head,'BATCH_HEAD_CHANGED')
        for rel,raw in captured.items():need(captured_file(ROOT/rel,sha(raw))==raw,'BATCH_SOURCE_BYTES_CHANGED')
        if runner is not None:
            if strong:
                need(sha(runner.writer.private(runner.root/'signed-ai-binding-private.json'))==authority.binding_sha256,'BATCH_ORIGINAL_BINDING')
                need(sha(runner.writer.private(runner.root/authority.auth6_receipt_relative))==authority.auth6_receipt_sha256,'BATCH_ORIGINAL_RECEIPT')
            need(len(anchors)==2,'BATCH_TWO_ORIGINAL_AUTH_ANCHORS')
            for anchor in anchors:anchor.check()
    def full_guard():
        source_guard(strong=True);runner.runtime_source();inventory,_=runner.baseline_guard();runner.check_owned(runner.read('owned-resources.json'),inventory,running=True)
        runner.memory(786432);runner.healthy()
    def watch():
        while not done.is_set():
            start=time.monotonic()
            try:source_guard()
            except BaseException as e:failures.append(type(e).__name__);return
            done.wait(max(0,start+3-time.monotonic()))
    def fast():
        need(not failures,'BATCH_CAPTURE_MONITOR');runner.healthy()
    output=None;output_writer=None;gate=FinalReceiptGate()
    provenance={'authorityDescriptorSha256':sha(canonical(authority.descriptor())),'sourceReviewSha256':sha(review._sealed),
        'sourceKwargsBytesSha256':sha(authority.source_kwargs_bytes),'originalBindingSha256':authority.binding_sha256,
        'originalAuth6ReceiptSha256':authority.auth6_receipt_sha256,'observerStatementTimeoutMs':30000,
        'observerProcessTimeoutSeconds':35,'productTimeoutApproved':False}
    def save(name,value):
        need(output_writer is not None,'BATCH_PRIVATE_OUTPUT_NOT_READY')
        return output_writer.save(name,value)
    try:
        with gate.support(m.runtime_support(review))as support:
            runner=m.CurrentAuthSource(review,support);runner.phase=authority.decision_id;runner.plan=runner.source()['target'];runner.runtime_source()
            need(runner.read('root-auth6-current-receipt.json')['status']=='PASS_CURRENT_AUTH6_SIX_SCHEMA_ONLY','BATCH_ORIGINAL_AUTH6_NOT_PASS')
            output=runner.root/authority.output_name;output.mkdir(mode=0o700,exist_ok=False);output_writer=PrivateOutputWriter(output)
            for path,digest in ((runner.root/'signed-ai-binding-private.json',authority.binding_sha256),(runner.root/authority.auth6_receipt_relative,authority.auth6_receipt_sha256)):
                anchors.append(PrivateFileAnchor(path,digest,runner.writer.private))
            packet=runner.read('signed-provisioning-packet-private.json');owned=runner.read('owned-resources.json')
            need(set(packet['containers'])=={'db','auth','rest','gateway'}and len({x['id']for x in packet['containers'].values()})==4,'BATCH_OWN_FOUR')
            db_id=packet['containers']['db']['id'];rest_id=packet['containers']['rest']['id']
            first=runner.read('owned-first-inspection.json')
            need(len(first)==4 and {x['Id']for x in first}=={x['id']for x in packet['containers'].values()},'BATCH_EXACT_FOUR_FIRST_IDS')
            need(next(x for x in first if x['Id']==db_id)['HostConfig'].get('PidMode')=='','BATCH_PRIVATE_PID_NAMESPACE')
            base=kernel_queries(captured[KERNEL],authority.expected_tables);extra_queries,basis=collection_queries(captured[DEADLINE]);controls,expected_controls=control_query(captured[KERNEL])
            before_queries={**base,**extra_queries,'inheritance':INHERITANCE,'controls':controls};after_queries={**base,'controls':controls}
            try:
                runner.start_monitor();thread=threading.Thread(target=watch,daemon=True);thread.start()
                full_guard();save('intent.json',{**provenance,'sourceHead':head,'decisionId':authority.decision_id,'tableSetSha256':authority.table_set_sha256,'queryApproval':'NOT_GRANTED','singleAttempt':True})
                transport=BatchTransport(m,runner,db_id,save,fast)
                before=transport.run(batch_sql(before_queries));save('before-private.json',before);a=snapshot_from(before,authority.expected_tables)
                need(exact(before['controls'])==expected_controls,'BATCH_CONTROLS_NOT_CLOSED')
                rest=exact(runner.call(['inspect',rest_id]));need(type(rest)is list and len(rest)==1 and rest[0]['Id']==rest_id,'BATCH_REST_IDENTITY')
                result=timeout_candidate(before,rest[0],head,runner.root,basis)
                inheritance=exact(before['inheritance']);save('candidate-private.json',result);inheritance_sha=save('role-inheritance-private.json',inheritance)
                after=transport.run(batch_sql(after_queries));save('after-private.json',after);b=snapshot_from(after,authority.expected_tables)
                need(a==b and exact(after['controls'])==expected_controls,'BATCH_BASELINE_CHANGED');full_guard()
            except BaseException as e:error=e;raise
            finally:
                done.set();runner.done.set()
                if thread is not None:thread.join(4)
                if runner.thread is not None:runner.thread.join(4)
                final_ok=thread is not None and not thread.is_alive()and runner.thread is not None and not runner.thread.is_alive()and not failures and not runner.failures and not runner.unclosed_child and (transport is None or not transport.sticky)
                save('finalization.json',{'status':'CAPTURED_PENDING_CONTEXT_EXIT'if final_ok and error is None else'FAIL_CLOSED','captureFailures':failures,'memoryFailures':runner.failures,'sqlSticky':False if transport is None else transport.sticky,'errorType':None if error is None else type(error).__name__})
                if error is None:
                    need(final_ok,'BATCH_LATE_FINALIZATION_FAILED');gate.finalized=True
        source_guard(strong=True)
        gate.publish(save,{**provenance,'status':'CAPTURED_UNREVIEWED_TIMEOUT_SOURCE_ONLY','candidateSha256':sha(canonical(result)),
            'roleInheritanceSha256':inheritance_sha,'sourceHead':head,'supportContextExited':True,'monitorJoined':True,
            'fullBaselineRestored':True,'actualD03':'NOT_RUN','queryApproved':False,'effectiveTimeoutApproved':False})
        return result
    finally:
        done.set()
        for anchor in reversed(anchors):anchor.close()
        if output_writer is not None:output_writer.close()

if __name__=='__main__':print(json.dumps({'status':'NOT_RUN','reason':'명시적 root literal batch 검토와 새 source가 필요합니다.'},ensure_ascii=False))
