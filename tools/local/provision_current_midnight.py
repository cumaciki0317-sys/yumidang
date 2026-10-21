"""현재 AI24의 새3회원×2원세션 발급기. 기본 CLI는 실행하지 않는다."""
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import threading
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]
SELF='tools/local/provision_current_midnight.py'
CURRENT_DB_SOURCES=('tools/local/current_ai24_database.py','tests/integration/minkyu/deadline_readonly_transport.py','tools/local/prepare_isolated_midnight.py')
_DATABASE_MODULES={}
RUNNER='tests/integration/jonghyun/isolated_ai_contracts.py'
INSPECTOR='tests/integration/minkyu/service_profile_readonly_local.py'
HELPERS=tuple('tools/local/'+name+'.py' for name in ('prepare_migrations','prepare_database','prepare_edge','prepare_current_policy','run_database_tests'))
STATUS='PASS_LOCAL_AI24_THREE_USERS_SIX_SESSIONS_ONLY'


def need(value,code):
    if not value:raise ValueError(code)


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode()
def sha(raw):return hashlib.sha256(raw).hexdigest()


def read_source(relative):
    path=ROOT/relative
    need(type(relative)is str and re.fullmatch('[A-Za-z0-9_./-]+',relative) and Path(relative).as_posix()==relative
        and not Path(relative).is_absolute() and '..'not in Path(relative).parts
        and path.resolve()==path and not path.is_symlink(),'ISSUER_SOURCE_PATH')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        before=os.fstat(fd);raw=os.read(fd,4*1024*1024+1);after=os.fstat(fd);current=path.lstat()
        signature=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns)
        need(stat.S_ISREG(before.st_mode) and before.st_size<=4*1024*1024 and len(raw)==before.st_size
            and signature(before)==signature(after)==signature(current),'ISSUER_SOURCE_CHANGED')
        return raw
    finally:os.close(fd)


def verify_pins(pins,head):
    need(type(head)is str and re.fullmatch('[a-f0-9]{40}',head) and type(pins)is dict and pins,'ISSUER_SOURCE_REVIEW')
    need(subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True,timeout=15).strip()==head,'ISSUER_HEAD_CHANGED')
    captured={p:read_source(p) for p in sorted(pins)}
    need(all(type(pins[p])is str and re.fullmatch('[a-f0-9]{64}',pins[p]) and sha(raw)==pins[p] for p,raw in captured.items()),'ISSUER_SOURCE_CHANGED')
    requests=''.join(head+':'+p+'\n'for p in captured).encode()
    result=subprocess.run(['git','-C',str(ROOT),'cat-file','--batch'],input=requests,capture_output=True,timeout=15)
    need(result.returncode==0 and len(result.stdout)<=32*1024*1024,'ISSUER_COMMITTED_SOURCE_REQUIRED')
    offset=0
    for raw in captured.values():
        end=result.stdout.find(b'\n',offset);header=result.stdout[offset:end]
        need(end>=offset and re.fullmatch(rb'[a-f0-9]{40,64} blob [0-9]+',header),'ISSUER_COMMITTED_SOURCE_REQUIRED')
        size=int(header.split()[2]);offset=end+1
        need(size==len(raw) and result.stdout[offset:offset+size]==raw and result.stdout[offset+size:offset+size+1]==b'\n','ISSUER_COMMITTED_SOURCE_REQUIRED')
        offset+=size+1
    need(offset==len(result.stdout) and subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True,timeout=15).strip()==head,'ISSUER_HEAD_CHANGED')


@contextmanager
def support(pins):
    """전체 발급·실패 정리 동안 늦은 helper import도 고정한다."""
    paths=[*HELPERS,RUNNER,INSPECTOR]
    names=[Path(p).stem if p in HELPERS else 'current_midnight_'+Path(p).stem for p in paths]
    previous={name:sys.modules.get(name)for name in names};old_path=list(sys.path);modules={}
    try:
        for relative,name in zip(paths,names):
            raw=read_source(relative);need(pins.get(relative)==sha(raw),'ISSUER_HELPER_CHANGED')
            module=importlib.util.module_from_spec(importlib.util.spec_from_loader(name,loader=None));module.__file__=str(ROOT/relative)
            sys.modules[name]=module;exec(compile(raw,module.__file__,'exec'),module.__dict__);modules[relative]=module
        yield modules[RUNNER],modules[INSPECTOR]
    finally:
        sys.path[:]=old_path
        for name,old in previous.items():
            if old is None:sys.modules.pop(name,None)
            else:sys.modules[name]=old


def current_database_support(pins,head):
    """호출자가 이 모듈의 exact typed review를 구성한다. 관측 JSON은 권한이 아니다."""
    path=CURRENT_DB_SOURCES[0];raw=read_source(path)
    need(pins.get(path)==sha(raw),'ISSUER_DATABASE_SOURCE')
    key=(head,sha(raw))
    if key not in _DATABASE_MODULES:
        module=importlib.util.module_from_spec(importlib.util.spec_from_loader('issuer_current_ai24_database',loader=None))
        module.__file__=str(ROOT/path);exec(compile(raw,module.__file__,'exec'),module.__dict__);_DATABASE_MODULES[key]=module
    return _DATABASE_MODULES[key]


def source_pins(head):
    paths=(SELF,*HELPERS,RUNNER,INSPECTOR)
    pins={p:sha(read_source(p))for p in paths};verify_pins(pins,head)
    with support(pins)as(ai,_):pins.update(ai.signed_source_pins())
    verify_pins(pins,head)
    return pins


def current_database_source_pins(head):
    """새 current DB review 전용 closure. 기존 발급 source_pins 계약은 유지한다."""
    pins=source_pins(head);pins.update({p:sha(read_source(p))for p in CURRENT_DB_SOURCES});verify_pins(pins,head)
    return pins


def verify_closure(ai,pins,current_database=False):
    required={SELF,*HELPERS,RUNNER,INSPECTOR}
    if current_database:required.update(CURRENT_DB_SOURCES)
    signed=ai.signed_source_pins()
    need(type(pins)is dict and set(pins)==required|set(signed),'ISSUER_EXACT_SOURCE_CLOSURE')
    need(all(pins.get(path)==digest for path,digest in signed.items()),'ISSUER_SIGNED_SOURCE_CHANGED')


class ReviewedCurrentMidnightIssuance:
    """발급 전에는 source-only 검토만 받는다. 아직 모르는 UUID를 입력으로 요구하지 않는다."""
    def __init__(self,decision_id,prepared_root,source_head,pins,source_profile,containers,credentials,
                 scope_id,boundary_epoch,minimum_expiry,ports=None,database_review=None):
        need(type(decision_id)is str and re.fullmatch('[A-Za-z0-9_.:-]{1,128}',decision_id),'ISSUER_REVIEW_ID')
        need(type(scope_id)is str and re.fullmatch('[a-f0-9]{32}',scope_id),'ISSUER_SCOPE')
        need(type(source_profile)is dict and set(source_profile)=={'sourceHead','migrationEntriesSha256','versions','expectedTables','fullTableSetSha256'}
            and source_profile['sourceHead']==source_head,'ISSUER_SOURCE_PROFILE')
        need(type(boundary_epoch)is int and type(minimum_expiry)is int and minimum_expiry>=boundary_epoch+300,'ISSUER_BOUNDARY_EXPIRY')
        root=Path(prepared_root)
        need(root.is_absolute() and root.resolve()==root and not root.is_relative_to(ROOT),'ISSUER_PRIVATE_ROOT')
        self._sealed=canonical(dict(decisionId=decision_id,preparedRoot=str(root),sourceHead=source_head,pins=pins,
            sourceProfile=source_profile,containers=containers,credentials=credentials,scopeId=scope_id,
            boundaryEpoch=boundary_epoch,minimumExpiry=minimum_expiry))
        self.ports=ports;self.database_review=database_review
    def descriptor(self):return json.loads(self._sealed)


def added_scope(before,after,added,accounts):
    """현재 전용 행 계약:3회원·6세션·9audit. 기존Auth6 판정은 호출하지 않는다."""
    users={a['userId']for a in accounts}
    need(len(accounts)==6 and len(users)==3 and len({a['sessionId']for a in accounts})==6,'ISSUER_EXACT_POPULATION')
    counts={'auth.users':3,'auth.identities':3,'public.profiles':3,'private.member_episodes':3,
        'auth.sessions':6,'auth.refresh_tokens':6,'auth.mfa_amr_claims':6,'auth.audit_log_entries':9}
    need(set(before)==set(after) and set(added)==set(counts) and set(counts)<=set(before),'ISSUER_ROW_SCOPE')
    for table,bag in after.items():
        expected=dict(before[table])
        if table in counts:
            entries=added[table];need(type(entries)is dict and len(entries)==counts[table],'ISSUER_ROW_COUNT')
            owned={u:[]for u in users}
            for identifier,row in entries.items():
                need(type(identifier)is str and 0<len(identifier)<=512 and type(row)is dict
                    and set(row)=={'rowSha256','ownerUserId','operation'} and row['ownerUserId']in users
                    and type(row['rowSha256'])is str and re.fullmatch('[a-f0-9]{64}',row['rowSha256'])
                    and row['rowSha256']not in before[table],'ISSUER_ROW_OWNER')
                owned[row['ownerUserId']].append(row['operation']);digest=row['rowSha256'];expected[digest]=expected.get(digest,0)+1
            operations=['login','login','user_signedup']if table=='auth.audit_log_entries'else['row']*(2 if counts[table]==6 else 1)
            need(all(sorted(v)==operations for v in owned.values()),'ISSUER_ROW_OWNER')
        need(bag==expected,'ISSUER_UNOWNED_ROW_CHANGED')


def fixed_ports(ai,reviewed):
    class Ports(ai.FixedLifecycleProvisioningPorts):
        def clock(self):
            return ai.signed_exact_json(self.read_sql("with s as(select clock_timestamp()t)select jsonb_build_object('epoch',extract(epoch from t),'midnightEpoch',extract(epoch from(((t at time zone'Asia/Seoul')::date+1)::timestamp at time zone'Asia/Seoul')))from s;",timeout=3))
        def preservation(self):
            return ai.verify_preserved_resources(self.runner.root,self.target['host'],self.target['project'],self.runner.call,self.target.get('preservedResourcePins'))
        def raw(self,method,path,payload=None,token=None,admin=False):
            allowed=(method=='POST'and path in('/admin/users','/token?grant_type=password'))or(method=='GET'and(path=='/user'or re.fullmatch('/admin/users/[a-f0-9-]{36}',path)))or(method=='DELETE'and re.fullmatch('/admin/users/[a-f0-9-]{36}',path))
            need(allowed,'ISSUER_FIXED_HTTP_PATH')
            credential=self.reviewed.credentials['service'if admin else'anon']
            class NoRedirect(ai.urllib.request.HTTPRedirectHandler):
                def redirect_request(self,*args):return None
            request=ai.urllib.request.Request(self.origin+'/auth/v1'+path,data=None if payload is None else canonical(payload),method=method,
                headers={'apikey':credential,'Authorization':'Bearer '+(token or credential),'Content-Type':'application/json'})
            opener=ai.urllib.request.build_opener(ai.urllib.request.ProxyHandler({}),NoRedirect())
            try:
                with opener.open(request,timeout=5)as response:return response.status,response.read(65537)
            except ai.urllib.error.HTTPError as error:return error.code,error.read(65537)
    return Ports(reviewed)


def provision(reviewed):
    need(type(reviewed)is ReviewedCurrentMidnightIssuance,'ISSUER_TYPED_REVIEW_REQUIRED')
    value=reviewed.descriptor()
    need(({SELF,*HELPERS,RUNNER,INSPECTOR}|(set(CURRENT_DB_SOURCES)if reviewed.database_review is not None else set()))<=set(value['pins']),'ISSUER_EXACT_SOURCE_CLOSURE')
    verify_pins(value['pins'],value['sourceHead'])
    with support(value['pins'])as(ai,inspector):return _provision(reviewed,value,ai,inspector)


def _provision(reviewed,value,ai,inspector):
    """전체 pinned context 안에서만 호출한다. tests도 실제 전송 대신 합성 port를 쓴다."""
    verify_closure(ai,value['pins'],reviewed.database_review is not None)
    root=Path(value['preparedRoot']);ai.private_temp_root(root)
    # 포트 인터페이스는 기존 고정 metadata 검증기를 유지한다.
    adapter=type('ReviewedPorts',(),{})()
    adapter.prepared_root=root;adapter.source_pins=value['pins'];adapter.containers=value['containers'];adapter.credentials=value['credentials']
    target=ai.signed_prepared_target(root);inspector.verify_current_profile(value['sourceProfile'],value['pins'],value['sourceHead'],target['versions'])
    manifest=ai.signed_exact_json(ai.signed_private_read(root/'database-manifest.json'));origin='http://127.0.0.1:'+str(manifest['config_overlay']['api.port'])
    ai.provisioning_metadata(adapter,target,origin)
    need(value['minimumExpiry']>=max(value['boundaryEpoch']+300,time.time()+300),'ISSUER_BOUNDARY_EXPIRY')
    for name in ('signed-ai-provision-intent.json','signed-ai-binding-private.json','current-ai24-provision-intent.json','current-ai24-binding-private.json'):
        need(not(root/name).exists() and not(root/name).is_symlink(),'ISSUER_PREVIOUS_ATTEMPT')
    evidence=root/('ai24-provision-'+value['scopeId']);need(not evidence.exists() and not evidence.is_symlink(),'ISSUER_PREVIOUS_ATTEMPT');evidence.mkdir(mode=0o700)
    ports=reviewed.ports if reviewed.ports is not None else fixed_ports(ai,adapter);ports.origin=origin
    accounts=[];members=[];created={};attempted={};unknown=set();done=threading.Event();failures=[];baseline=None;observer=None;memory_samples=[];clock_samples=[]
    def save(name,data):return ai.lcp_save(evidence,name,data)
    if reviewed.ports is None:
        db=current_database_support(value['pins'],value['sourceHead'])
        database_review=reviewed.database_review
        need(type(database_review)is db.ReviewedCurrentAI24Database and database_review.operation is db.IssuerOperation,'ISSUER_DATABASE_TYPED_REVIEW')
        dv=database_review.descriptor()
        need(dv['sourceHead']==value['sourceHead'] and dv['pins']==value['pins'] and dv['profile']==value['sourceProfile']
            and dv['root']==str(root) and dv['scopeId']==value['scopeId'] and dv['containers']==value['containers'],'ISSUER_DATABASE_BINDING')
        original=ports
        def operation_guard():
            verify_pins(value['pins'],value['sourceHead'])
            need(original.identity()==value['containers'],'ISSUER_DATABASE_IDENTITY')
        def active_guard():need(not done.is_set() and not failures,'ISSUER_DATABASE_MONITOR')
        class CurrentIssuerPorts(type(original)):
            def __init__(self,reviewed):
                super().__init__(reviewed);self.root=reviewed.prepared_root
            def history(self):
                self.current_database.assert_closed_state()
                native=self.root/'native119-runtime-provenance.json'
                need(not native.exists() and not native.is_symlink(),'ISSUER_CURRENT_NATIVE_HISTORY_UNSUPPORTED')
                return ai.signed_verify_history(self)
            def read_sql(self,query,timeout=3):return self.current_database.read_sql(query,timeout)
            def sql(self,query):return self.current_database.sql(query)
            def snapshot(self):return self.current_database.snapshot()
            def original_rows(self):return self.current_database.original_rows()
            def identity(self):
                self.current_database.assert_closed_state();return super().identity()
            def preservation(self):
                self.current_database.assert_closed_state();return super().preservation()
            def raw(self,*args,**kwargs):
                self.current_database.assert_closed_state();return super().raw(*args,**kwargs)
        ports=CurrentIssuerPorts(adapter);ports.origin=origin
        # 원 constructor는 metadata만 읽고 SQL을 실행하지 않는다.
        ports.current_database=db.CurrentDatabase(ROOT,database_review,ai,ports,save,operation_guard,active_guard)
    def resource(minimum):
        if hasattr(ports,'current_database'):
            need(not ports.current_database.sticky or ports.current_database.inflight,'ISSUER_DATABASE_CLOSURE_STICKY')
        began=time.monotonic();memory=ports.memory_kib()
        need(type(memory)is int and memory>=minimum and time.monotonic()-began<=3,'ISSUER_MEMORY')
        memory_samples.append(memory);return memory
    def live():
        need(not done.is_set() and not failures,'ISSUER_MONITOR')
        verify_pins(value['pins'],value['sourceHead'])
        need(ports.identity()==value['containers'],'ISSUER_IDENTITY')
        need(ports.settings()=={'jwtExpirySeconds':3600,'anonymousEnabled':False,'signupDisabled':True},'ISSUER_AUTH_SETTINGS')
        controls=ports.closed_controls();need(controls=={**{k:False for k in ai.PROVISION_CLOSED_CONTROLS},'cronLaunchActiveJobs':'off'},'ISSUER_CONTROLS')
        resource(786432)
        began=time.time();clock=ports.clock()
        need(type(clock)is dict and set(clock)=={'epoch','midnightEpoch'} and type(clock['epoch'])in(int,float)
            and began-2<=clock['epoch']<=time.time()+2 and time.time()-began<=3
            and clock['midnightEpoch']==value['boundaryEpoch'] and clock['epoch']<value['boundaryEpoch'],'ISSUER_NATURAL_BOUNDARY')
        clock_samples.append(clock)
    def monitor():
        while not done.is_set():
            began=time.monotonic()
            try:resource(786432)
            except BaseException:failures.append('ISSUER_MEMORY');done.set();return
            done.wait(max(0,began+3-time.monotonic()))
    def send(label,method,path,payload=None,token=None,admin=False,cleanup=False):
        if not cleanup:live()
        else:verify_pins(value['pins'],value['sourceHead']);need(ports.identity()==value['containers'],'ISSUER_CLEANUP_IDENTITY')
        save(label+'-intent-private.json',dict(method=method,path=path,payload=payload,tokenSha256=None if token is None else sha(token.encode()),singleAttempt=True,noResend=True))
        if label=='ai24-member-0-create':resource(1048576)
        if method=='POST':unknown.add(label)
        try:
            def transport():
                status,raw=ports.raw(method,path,payload,token=token,admin=admin)
                need(type(raw)is bytes and len(raw)<=65537,'ISSUER_RESPONSE')
                # 후행 보존 검사 실패로 반환이 차단되어도 원 출력은 먼저 남긴다.
                digest=ai.lcp_save_bytes(evidence,label+'-response-private.json',raw)
                save(label+'-outcome.json',dict(status=status,responseSha256=digest,responseBytes=len(raw),capturedBeforeVerdict=True))
                return status,raw,digest
            status,raw,digest=ai.preserved_operation(ports.preservation,transport)
            need(len(raw)<=65536,'ISSUER_RESPONSE')
            return status,(ai.signed_exact_json(raw)if raw else {}),digest
        except BaseException:
            save(label+'-failure.json',dict(status='UNKNOWN'if method in('POST','DELETE')else'FAIL',noResend=True))
            raise
    def verify(account,label,meta):
        status,user,_=send(label+'-user','GET','/user',token=account['accessToken'])
        need(status==200 and user.get('id')==account['userId'] and user.get('email')==account['authEmail']
            and user.get('role')=='authenticated' and user.get('is_anonymous')is False and user.get('user_metadata')==meta
            and ports.session_proof(account) and ports.metadata_proof(account,value['scopeId'],meta['fixture_case']),'ISSUER_ACTUAL_SESSION')
    try:
        initial_memory=resource(1048576)
        observer=threading.Thread(target=monitor,daemon=True);observer.start()
        live();need(ports.empty_auth(),'ISSUER_FRESH_EMPTY_REQUIRED');ports.history()
        baseline=ports.snapshot();save('baseline-private.json',baseline)
        need(sorted(baseline['rows'])==value['sourceProfile']['expectedTables'],'ISSUER_TABLE_SCOPE')
        if reviewed.ports is None:
            need(ports.current_database.preparation_status['executionAllowed'] is True,'ISSUER_DATABASE_WRITE_COVERAGE_NOT_REVIEWED')
        ai.provisioning_json(root,'current-ai24-provision-intent.json',dict(scopeId=value['scopeId'],sourceHead=value['sourceHead'],sourceProfile=value['sourceProfile'],targetId=target['id'],initialMemoryKiB=initial_memory,singleProvision=True,noReplay=True))
        for index in range(3):
            case='ai24-member-'+str(index);email='synthetic-ai-'+value['scopeId']+'-m'+str(index)+'@example.invalid'
            meta={'fixture_scope_id':value['scopeId'],'fixture_case':case,'email_verified':True};password=ai.base64.urlsafe_b64encode(os.urandom(36)).decode()
            live();need(ports.resolve_email(email)is None,'ISSUER_EMAIL_EXISTS');attempted[case]={'authEmail':email,'meta':meta}
            label=case+'-create';status,user,_=send(label,'POST','/admin/users',dict(email=email,password=password,email_confirm=True,user_metadata=meta),admin=True)
            uid=user.get('id');need(status==200 and type(uid)is str and str(uuid.UUID(uid))==uid and user.get('email')==email
                and user.get('role')=='authenticated' and user.get('is_anonymous')is False and user.get('user_metadata')==meta,'ISSUER_CREATED_USER')
            created[case]={'userId':uid,'authEmail':email};save(case+'-created.json',created[case]);unknown.discard(label)
            live();save(case+'-profile-intent.json',dict(userId=uid,singleLink=True,syntheticNaverEligibility=False));need(ports.link_profile(uid),'ISSUER_PROFILE')
            member={'userId':uid}
            for role in ('primary','secondary'):
                label=case+'-'+role;status,response,response_sha=send(label,'POST','/token?grant_type=password',dict(email=email,password=password))
                need(status==200 and response.get('token_type')=='bearer','ISSUER_LOGIN')
                token=response.get('access_token');claims=ai.signed_claims(token);sid=claims.get('session_id')
                need(type(sid)is str and str(uuid.UUID(sid))==sid and claims.get('sub')==uid and claims.get('email')==email
                    and claims.get('iss')==origin+'/auth/v1' and claims.get('aud')=='authenticated' and claims.get('role')=='authenticated'
                    and claims.get('is_anonymous')is False and type(claims.get('iat'))is int and type(claims.get('exp'))is int
                    and claims['exp']-claims['iat']==3600 and claims['iat']<=time.time() and claims['exp']>=max(value['minimumExpiry'],time.time()+300)
                    and type(response.get('user'))is dict
                    and all(response['user'].get(k)==user.get(k)for k in('id','email','role','is_anonymous','user_metadata')),'ISSUER_ORIGINAL_JWT')
                account=dict(userId=uid,sessionId=sid,accessToken=token,expiresAt=claims['exp'],authEmail=email)
                need(sid not in {a['sessionId']for a in accounts} and token not in {a['accessToken']for a in accounts},'ISSUER_DISTINCT_SESSIONS')
                receipt=dict(kind='GOTRUE_ORIGINAL_TOKEN_ISSUED',scopeId=value['scopeId'],memberCase=case,sessionRole=role,userId=uid,sessionId=sid,
                    tokenSha256=sha(token.encode()),issuedAt=claims['iat'],expiresAt=claims['exp'],responseSha256=response_sha,
                    authContainerId=value['containers']['auth']['id'],authImage=value['containers']['auth']['image'],wire='POST /token?grant_type=password',httpStatus=status)
                save(label+'-issued.json',receipt);unknown.discard(label);accounts.append(account);member[role+'SessionId']=sid
                verify(account,label+'-verified',meta)
            members.append(member)
            # 두 번째 login이 첫 세션을 무효화하는 설정도 실제 재검증으로 거절한다.
            for n,account in enumerate(accounts[-2:]):verify(account,case+'-pair-final-'+str(n),meta)
        live();need(len(accounts)==6 and len({a['userId']for a in accounts})==3,'ISSUER_EXACT_POPULATION')
        for index,account in enumerate(accounts):
            case='ai24-member-'+str(index//2);verify(account,'all-final-'+str(index),attempted[case]['meta'])
        final=ports.snapshot();save('final-private.json',final)
        need({k:v for k,v in baseline.items()if k!='rows'}=={k:v for k,v in final.items()if k!='rows'},'ISSUER_AUTHORITY_CHANGED')
        added=ports.added_rows(baseline['rows'],accounts);save('owned-added-rows-private.json',added);added_scope(baseline['rows'],final['rows'],added,accounts)
        profile={**value['sourceProfile'],'memberSessions':members};typed=ai.ReviewedCurrentMidnightProfile(profile)
        signed_evidence=root/('signed-auth-'+value['scopeId']);need(not signed_evidence.exists() and not signed_evidence.is_symlink(),'ISSUER_PREVIOUS_ATTEMPT')
        binding=dict(version=1,kind=ai.CURRENT_MIDNIGHT_KIND,preparedRoot=str(root),databaseManifestSha256=sha(ai.signed_private_read(root/'database-manifest.json')),
            origin=origin,jwtIssuer=origin+'/auth/v1',containers=value['containers'],credentials=value['credentials'],accounts=accounts,
            evidenceRoot=str(signed_evidence),sourcePins=ai.signed_source_pins(),approvedByRoot=False,dockerSlotReady=False)
        ai.validate_signed_binding(binding,root,target,current_midnight=typed)
        # 성공 직전에도 source/runtime·메모리·원3600초 세션의 여유를 다시 확인한다.
        live();need(all(a['expiresAt']>=max(value['minimumExpiry'],time.time()+300)for a in accounts),'ISSUER_BOUNDARY_EXPIRY')
        done.set();observer.join(timeout=3);need(not observer.is_alive() and not failures,'ISSUER_MONITOR')
        # AI24 입력 reader는 이 전용 비공개 anchor 디렉터리의 존재/권한도 검사한다.
        # 실제 자정 실행 증거는 이 경로와 다른 새 root에만 기록한다.
        signed_evidence.mkdir(mode=0o700)
        save('resource-clock-evidence-private.json',dict(startupMinimumKiB=1048576,runningMinimumKiB=786432,
            initialMemoryKiB=initial_memory,memorySamplesKiB=memory_samples,sqlClocks=clock_samples))
        binding_sha=ai.provisioning_json(root,'current-ai24-binding-private.json',binding)
        profile_sha=save('observed-profile-private.json',profile)
        ai.provisioning_json(signed_evidence,'issuance-reference.json',dict(scopeId=value['scopeId'],bindingSha256=binding_sha,
            observedProfileSha256=profile_sha,creationReceiptRoot=str(evidence),actualAI='NOT_RUN',actualMidnight='NOT_RUN'))
        receipt=dict(status=STATUS,scopeId=value['scopeId'],sourceHead=value['sourceHead'],sourcePinsSha256=sha(canonical(value['pins'])),
            sourceProfile=value['sourceProfile'],members=3,sessions=6,createdAuthAudits=9,bindingSha256=binding_sha,observedProfileSha256=profile_sha,
            originalRowsPreserved=True,minimumMemoryKiB=min(memory_samples),memorySampleCount=len(memory_samples),actualGoTrueAndDatabaseSessions=True,authAccountsRetained=True,actualNaver='NOT_RUN',
            actualAI='NOT_RUN',actualMidnight='NOT_RUN',profileAssembly='ROOT_INDEPENDENT_REVIEW_REQUIRED',actualCrossSessionAI='NOT_RUN')
        save('receipt.json',receipt);return receipt
    except BaseException as error:
        fixed_code=str(error)if type(error)is ValueError and re.fullmatch('ISSUER_[A-Z_]+',str(error))else'ISSUER_FAILED'
        done.set()
        if observer is not None:observer.join(timeout=3)
        if hasattr(ports,'current_database') and ports.current_database.sticky:
            save('failure.json',dict(status='UNKNOWN',failureCode=fixed_code,dbClosureUnproven=True,cleanupAttempted=False,noFurtherSqlHttpMetadata=True))
            raise ValueError('ISSUER_FAILED_PRIVATE_EVIDENCE_PRESERVED') from error
        try:save('failure-before-cleanup-private.json',ports.snapshot())
        except BaseException:failures.append('ISSUER_FAILURE_SNAPSHOT_UNKNOWN')
        closed=[]
        for case,item in attempted.items():
            try:
                uid=ports.resolve_email(item['authEmail'])
                if uid is None:continue
                need(type(uid)is str and str(uuid.UUID(uid))==uid,'ISSUER_CLEANUP_OWNER')
                need(case not in created or created[case]['userId']==uid,'ISSUER_CLEANUP_OWNER')
                status,user,_=send(case+'-cleanup-owner','GET','/admin/users/'+uid,admin=True,cleanup=True)
                need(status==200 and user.get('id')==uid and user.get('email')==item['authEmail'] and user.get('user_metadata')==item['meta'],'ISSUER_CLEANUP_OWNER')
                created[case]={'userId':uid,'authEmail':item['authEmail']}
                verify_pins(value['pins'],value['sourceHead']);need(ports.identity()==value['containers'],'ISSUER_CLEANUP_IDENTITY')
                save(case+'-cleanup-profile-intent.json',created[case]);ports.unlink_profile(uid)
                try:send(case+'-cleanup-delete','DELETE','/admin/users/'+uid,admin=True,cleanup=True)
                except BaseException:unknown.add(case+'-delete')
                status,_,_=send(case+'-cleanup-absent','GET','/admin/users/'+uid,admin=True,cleanup=True)
                need(status==404 and ports.resolve_email(item['authEmail'])is None,'ISSUER_DELETE_UNKNOWN');closed.append(uid)
            except BaseException:failures.append('ISSUER_CLEANUP_UNKNOWN')
        try:save('failure-after-cleanup-private.json',ports.snapshot())
        except BaseException:failures.append('ISSUER_FAILURE_SNAPSHOT_UNKNOWN')
        save('failure.json',dict(status='UNKNOWN'if unknown or failures or(observer is not None and observer.is_alive())else'FAIL_CREATED_AUTH_ABSENT',
            scopeId=value['scopeId'],fixedCode=fixed_code,closedCreatedUsers=len(closed),attemptedUsers=len(attempted),unknownMutations=sorted(unknown),fixedFailures=failures,
            noResend=True,memorySamplesKiB=memory_samples,sqlClocks=clock_samples,fullRestoration='NOT_CLAIMED_OWN_AUDITS_MAY_REMAIN',actualAI='NOT_RUN',actualMidnight='NOT_RUN'))
        raise ValueError('ISSUER_FAILED_PRIVATE_EVIDENCE_PRESERVED')from None
    finally:
        done.set()
        if observer is not None:observer.join(timeout=3)


if __name__=='__main__':
    print(json.dumps({'status':'NOT_RUN','actualAuth':0,'actualSQL':0,'actualMidnight':'NOT_RUN','typedReviewedIssuanceRequired':True}))
