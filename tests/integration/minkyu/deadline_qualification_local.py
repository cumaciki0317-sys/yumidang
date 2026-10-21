"""D03 새 source의 합성 자격 생성. CLI NOT_RUN; 실제 Naver/Storage 업로드는 수행하지 않는다."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
import urllib.request
import urllib.error
import tempfile
import threading
import sys

ROOT=Path(__file__).resolve().parents[3]
SELF='tests/integration/minkyu/deadline_qualification_local.py'
KERNEL_PATH='tests/integration/jonghyun/isolated_ai_contracts.py'
def need(ok,code):
    if not ok:raise ValueError(code)
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode()
def sha(b):return hashlib.sha256(b).hexdigest()
READONLY_PATH='tests/integration/minkyu/service_profile_readonly_local.py'
KERNEL_SUPPORT_PATH='tools/local/run_database_tests.py'
def load_reviewed_module(relative,head,pins):
    need(relative in (KERNEL_PATH,READONLY_PATH,KERNEL_SUPPORT_PATH)and type(head)is str and re.fullmatch('[a-f0-9]{40}',head),'D03_LOAD_SCOPE')
    need(type(pins)is dict and type(pins.get(relative))is str and re.fullmatch('[a-f0-9]{64}',pins[relative]),'D03_LOAD_PIN')
    path=ROOT/relative;raw=path.read_bytes()
    need(path.resolve()==path and not path.is_symlink()and sha(raw)==pins[relative],'D03_LOAD_BYTES_CHANGED')
    need(subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True,timeout=10).strip()==head
         and subprocess.check_output(['git','-C',str(ROOT),'show',head+':'+relative],timeout=15)==raw,'D03_LOAD_NOT_COMMITTED')
    spec=importlib.util.spec_from_loader('d03_reviewed_'+Path(relative).stem,loader=None)
    module=importlib.util.module_from_spec(spec);module.__file__=str(path)
    exec(compile(raw,str(path),'exec'),module.__dict__)
    return module

def load_reviewed_kernel(head,pins):
    support=load_reviewed_module(KERNEL_SUPPORT_PATH,head,pins)
    previous=sys.modules.get('run_database_tests');previous_path=list(sys.path)
    sys.modules['run_database_tests']=support
    try:return load_reviewed_module(KERNEL_PATH,head,pins)
    finally:
        sys.path[:]=previous_path
        if previous is None:sys.modules.pop('run_database_tests',None)
        else:sys.modules['run_database_tests']=previous

def load_process_guard(expected):
    path=ROOT/'tools/local/run_current_auth_source.py';raw=path.read_bytes()
    need(path.resolve()==path and not path.is_symlink()and sha(raw)==expected,'D03_PROCESS_GUARD_PIN')
    spec=importlib.util.spec_from_loader('d03_fixed_process_guard',loader=None)
    module=importlib.util.module_from_spec(spec);module.__file__=str(path)
    exec(compile(raw,str(path),'exec'),module.__dict__);return module

class ReviewedD03Qualification:
    def __init__(self,decision_id,root,head,pins,profile,literal_aliases,expected_alias_policy_sha256,binding_sha,receipt_path,receipt_sha,actors):
        root=Path(root);receipt=Path(receipt_path)
        need(root.is_absolute()and root.resolve()==root and root.parent.name.startswith('yumidang-d03-')
             and Path('/private/tmp')in root.parents and not root.is_relative_to(ROOT),'D03_NEW_SOURCE_ROOT')
        need(type(decision_id)is str and re.fullmatch('[A-Za-z0-9_.:-]{1,128}',decision_id),'D03_DECISION')
        need(receipt.parent.parent==root and re.fullmatch('auth-provision-[a-f0-9]{32}',receipt.parent.name)
             and receipt.name=='receipt.json','D03_AUTH6_RECEIPT_PATH')
        need(type(head)is str and re.fullmatch('[a-f0-9]{40}',head)and type(pins)is dict
             and {SELF,KERNEL_PATH,KERNEL_SUPPORT_PATH,'tests/integration/minkyu/service_profile_readonly_local.py','tools/local/run_current_auth_source.py'}<=set(pins)
             and all(re.fullmatch('[a-f0-9]{64}',v)for v in pins.values()),'D03_SOURCE_PINS')
        self.kernel=load_reviewed_kernel(head,pins)
        alias_policy=self.kernel.ReviewedD03AuthEmailAliases(decision_id,root,literal_aliases)
        need(type(expected_alias_policy_sha256)is str and sha(alias_policy._sealed)==expected_alias_policy_sha256,'D03_ROOT_LITERAL_POLICY_SHA')
        need(type(profile)is dict and profile.get('sourceHead')==head,'D03_PROFILE')
        need(all(type(v)is str and re.fullmatch('[a-f0-9]{64}',v)for v in (binding_sha,receipt_sha)),'D03_ORIGINAL_SHA')
        need(type(actors)is list and len(actors)==2,'D03_TWO_ACTORS')
        for a in actors:
            need(type(a)is dict and set(a)=={'userId','sessionId','subject','objectId','jpegPath','jpegSha256','storagePath'},'D03_ACTOR_FIELDS')
            for key in ('userId','sessionId','objectId'):need(str(uuid.UUID(a[key]))==a[key],'D03_ACTOR_UUID')
            need(a['subject']=='synthetic-d03-'+a['userId'],'D03_SYNTHETIC_SUBJECT')
            need(re.fullmatch(re.escape(a['userId'])+r'/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]jpg',a['storagePath']),'D03_PHOTO_NAME')
            need(Path(a['jpegPath']).parent==root and re.fullmatch(r'd03-photo-[a-f0-9]{32}[.]jpg',Path(a['jpegPath']).name)
                 and re.fullmatch('[a-f0-9]{64}',a['jpegSha256']),'D03_PHOTO_PATH')
        for field in ('userId','sessionId','subject','objectId','jpegPath','storagePath'):
            need(len({a[field]for a in actors})==2,'D03_DISTINCT_ACTORS')
        self.alias_policy=alias_policy
        self._sealed=canonical(dict(decisionId=decision_id,root=str(root),head=head,pins=pins,profile=profile,
            aliasPolicy=alias_policy.descriptor(),aliasPolicySha256=expected_alias_policy_sha256,bindingSha256=binding_sha,receiptPath=str(receipt),receiptSha256=receipt_sha,actors=actors))
    def descriptor(self):return json.loads(self._sealed)

def check_sources(v):
    need(subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True,timeout=10).strip()==v['head'],'D03_HEAD_CHANGED')
    for rel,pin in v['pins'].items():
        need(type(rel)is str and not Path(rel).is_absolute()and '..'not in Path(rel).parts,'D03_SOURCE_PATH')
        p=ROOT/rel;raw=p.read_bytes()
        need(p.resolve()==p and not p.is_symlink()and sha(raw)==pin
             and subprocess.check_output(['git','-C',str(ROOT),'show',v['head']+':'+rel],timeout=15)==raw,'D03_SOURCE_CHANGED')
    module=load_reviewed_module(READONLY_PATH,v['head'],v['pins'])
    module.verify_current_profile(v['profile'],v['pins'],v['head'])

def validate_delta(before,after,old_rows,new_rows):
    """표/열 전역 allowlist 대신 exact pre/post 행 해시의 교체만 허용한다."""
    need(set(before)==set(after),'D03_SNAPSHOT_FIELDS')
    for key in set(before)-{'rows'}:need(before[key]==after[key],'D03_AUTHORITY_CHANGED')
    need(set(before['rows'])==set(after['rows']),'D03_TABLE_SET_CHANGED')
    expected=json.loads(json.dumps(before['rows']))
    for table,rows in old_rows.items():
        for row in rows:
            digest=row['sha256'];need(expected[table].get(digest)==1,'D03_PREIMAGE_NOT_EXACT')
            del expected[table][digest]
    for table,rows in new_rows.items():
        for row in rows:
            digest=row['sha256'];expected[table][digest]=expected[table].get(digest,0)+1
    need(expected==after['rows'],'D03_UNEXPECTED_ROW_DELTA')
    return {'status':'EXACT_TYPED_DELTA_ONLY','authRowsUnchanged':all(before['rows'][k]==after['rows'][k]for k in before['rows']if k.startswith('auth.'))}

class FixedQualificationPorts:
    def __init__(self,review,binding):
        self.kernel=review.kernel
        self.review=review;self.v=review.descriptor();self.binding=binding;self.root=Path(self.v['root'])
        producer=self.kernel.ReviewedSignedProvisioning(self.v['decisionId'],self.root,binding['sourcePins'],binding['containers'],binding['credentials'],int(time.time())+600)
        self.done=threading.Event();self.failures=[];self.thread=None;self.unclosed_child=False;self.deadline=time.monotonic()+300
        self.base=self.kernel.FixedLifecycleProvisioningPorts(producer)
        self.base.origin=binding['origin'];self.target=self.kernel.signed_prepared_target(self.root)
        self.kernel.provisioning_metadata(producer,self.target,binding['origin'])
    def guard(self,start=False):
        need(not self.unclosed_child,'D03_PREVIOUS_CHILD_UNCLOSED')
        need(not self.failures and not self.done.is_set()and time.monotonic()<self.deadline,'D03_LIVE_GUARD')
        check_sources(self.v)
        need(self.base.identity()==self.binding['containers'],'D03_IDENTITY')
        controls=self.base.closed_controls()
        need(controls=={**{k:False for k in self.kernel.PROVISION_CLOSED_CONTROLS},'cronLaunchActiveJobs':'off'},'D03_CLOSED_CONTROLS')
        memory_started=time.monotonic();n=self.base.memory_kib()
        need(time.monotonic()-memory_started<=3 and n>=(1048576 if start else 786432),'D03_MEMORY')
    def start_monitor(self):
        def monitor():
            while not self.done.is_set():
                began=time.monotonic()
                try:
                    n=self.base.memory_kib()
                    need(type(n)is int and n>=786432 and time.monotonic()-began<=3,'D03_MEMORY_MONITOR')
                except BaseException:self.failures.append('D03_MEMORY_MONITOR');return
                self.done.wait(max(0,began+3-time.monotonic()))
        self.thread=threading.Thread(target=monitor,daemon=True);self.thread.start()
    def close_monitor(self):
        self.done.set()
        if self.thread is not None:self.thread.join(timeout=4);need(not self.thread.is_alive(),'D03_MONITOR_NOT_CLOSED')
    def sql(self,text):return self.base.read_sql(text,timeout=5)
    def snapshot(self):
        value=self.base.snapshot();need(sorted(value['rows'])==self.v['profile']['expectedTables'],'D03_FULL_TABLE_PROFILE');return value
    def artifact(self,name,value):
        return self.kernel.provisioning_json(self.root/'d03-qualification',name,value)
    def write_metadata(self,statement):
        # insert_metadata만 이 경로를 호출한다. 외부 SQL/CLI 입력 인자는 없다.
        need(type(statement)is str and len(statement)<=262144 and statement.startswith('begin;insert into private.naver_accounts(')
             and statement.endswith('commit;'),'D03_FIXED_METADATA_WRITE')
        helper=load_process_guard(self.v['pins']['tools/local/run_current_auth_source.py'])
        command=self.base.base+['exec','-i',self.target['id'],'psql','-XqAt','-U','postgres','-d','postgres',
            '-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate','-f','-']
        payload=("set statement_timeout='15s';set lock_timeout='10s';set plpgsql.check_asserts=on;\n"+statement).encode()
        self.guard();self.artifact('metadata-write-intent.json',{'sqlSha256':sha(payload),'targetId':self.target['id'],'singleDispatch':True})
        failure=None;closure=None
        with tempfile.TemporaryFile()as inp,tempfile.TemporaryFile()as out,tempfile.TemporaryFile()as err:
            inp.write(payload);inp.seek(0)
            self.unclosed_child=True
            child=subprocess.Popen(command,stdin=inp,stdout=out,stderr=err,start_new_session=True)
            deadline=time.monotonic()+20
            try:
                while child.poll()is None:
                    need(time.monotonic()<deadline,'D03_WRITE_TIMEOUT')
                    need(out.tell()<=524288 and err.tell()<=65536,'D03_WRITE_OUTPUT_LIMIT')
                    need(not self.failures,'D03_MEMORY_MONITOR');time.sleep(.05)
            except BaseException as exc:failure=type(exc).__name__
            finally:
                closure=helper.close_process_group(child,terminate=failure is not None,grace=1)
                self.unclosed_child=not closure['closed']
                out.seek(0);stdout=out.read(524289);err.seek(0);stderr=err.read(65537)
                self.artifact('metadata-write-stdout-private.json',{'rawHex':stdout.hex(),'truncated':len(stdout)>524288})
                self.artifact('metadata-write-stderr-private.json',{'rawHex':stderr.hex(),'truncated':len(stderr)>65536})
                self.artifact('metadata-write-result.json',{'pid':child.pid,'exit':child.returncode,'failureType':failure,'closure':closure})
            need(closure['closed']and failure is None and child.returncode==0 and len(stdout)<=524288 and len(stderr)<=65536,'D03_METADATA_WRITE_FAILED')
        self.guard()
    def complete(self,actor,account):
        # 유일한 HTTP 쓰기 경로. 원 JWT 그대로, proxy/redirect/자동 재전송 없이 한 번만 전송한다.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args):return None
        payload=canonical({'p_avatar_path':actor['storagePath'],'p_interests':[],'p_conversation_styles':[],'p_mbti':None})
        request=urllib.request.Request(self.binding['origin']+'/rest/v1/rpc/complete_naver_signup',data=payload,method='POST',
            headers={'apikey':self.binding['credentials']['anon'],'Authorization':'Bearer '+account['accessToken'],'Content-Type':'application/json'})
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        status=None;body=b'';complete=False;error_type=None
        try:
            try:response=opener.open(request,timeout=10)
            except urllib.error.HTTPError as error:response=error
            with response:
                status=response.status;body=response.read(65537);complete=len(body)<=65536
        except BaseException as exc:error_type=type(exc).__name__
        self.artifact('http-'+actor['userId'].replace('-','')+'-raw-private.json',{'httpStatus':status,'bodyHex':body.hex(),
            'complete':complete,'truncated':len(body)>65536,'outcome':'HTTP_OBSERVED'if complete else'UNKNOWN_NO_REPLAY','errorType':error_type})
        need(complete and error_type is None,'D03_RPC_RESPONSE_UNPROVEN')
        return status,body
    def inspect_rows(self):
        # 정확 두 actor 관련 7표만 원문 pre/post를 수집한다. Auth 원문은 포함하지 않는다.
        q=self.kernel.quote;actors=self.v['actors'];uids=','.join(q(a['userId'])+'::uuid'for a in actors);subjects=','.join(q(a['subject'])for a in actors)
        predicates={'public.profiles':'id in('+uids+')','private.member_episodes':'profile_id in('+uids+')',
         'private.profile_traits':'profile_id in('+uids+')','private.naver_accounts':'user_id in('+uids+')or subject in('+subjects+')',
         'private.naver_sessions':'user_id in('+uids+')','private.naver_identity_keys':'subject in('+subjects+')',
         'storage.objects':'id in('+','.join(q(a['objectId'])+'::uuid'for a in actors)+')or name in('+','.join(q(a['storagePath'])for a in actors)+')'}
        result={}
        for table,predicate in predicates.items():
            result[table]=json.loads(self.sql("select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(r),'sha256',encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex'))order by to_jsonb(r)::text),'[]'::jsonb)from "+table+' r where '+predicate+';'))
        return result
    def insert_metadata(self,images):
        q=self.kernel.quote;sql=['begin;']
        for a,size in zip(self.v['actors'],images):
            account=next(x for x in self.binding['accounts']if x['userId']==a['userId'])
            sql.extend(["insert into private.naver_accounts(subject,auth_email,user_id,real_name,birth_date,gender,verification_status)values("+','.join([q(a['subject']),q(account['authEmail']),q(a['userId'])+'::uuid',q('합성 D03'),'date\'1990-01-01\'',q('female'),q('qualified')])+');',
             'insert into private.naver_sessions(session_id,user_id,subject)values('+q(a['sessionId'])+'::uuid,'+q(a['userId'])+'::uuid,'+q(a['subject'])+');',
             "insert into storage.objects(id,bucket_id,name,owner_id,metadata)values("+q(a['objectId'])+"::uuid,'profile-images',"+q(a['storagePath'])+','+q(a['userId'])+",jsonb_build_object('mimetype','image/jpeg','size',"+str(size)+'));'])
        sql.append('commit;');self.write_metadata(''.join(sql))

def run_reviewed(review):
    need(type(review)is ReviewedD03Qualification,'D03_TYPED_QUALIFIER_REQUIRED')
    v=review.descriptor();check_sources(v)
    readonly=load_reviewed_module(READONLY_PATH,v['head'],v['pins'])
    # prepared target/고정 ports의 모든 lazy import와 실패 증거·monitor 종료까지 유지한다.
    with readonly.current_support(v['pins']):
        return run_supported(review)

def run_supported(review):
    kernel=review.kernel
    v=review.descriptor();root=Path(v['root']);check_sources(v)
    need(review.alias_policy.descriptor()==v['aliasPolicy']and sha(review.alias_policy._sealed)==v['aliasPolicySha256'],'D03_ALIAS_POLICY_CHANGED')
    raw=kernel.signed_private_read(root/'signed-ai-binding-private.json');receipt_raw=kernel.signed_private_read(Path(v['receiptPath']))
    need(sha(raw)==v['bindingSha256']and sha(receipt_raw)==v['receiptSha256'],'D03_ORIGINAL_AUTH6_CHANGED')
    binding=json.loads(raw);receipt=json.loads(receipt_raw);target=kernel.signed_prepared_target(root)
    kernel.validate_signed_binding(binding,root,target,d03_email_aliases=review.alias_policy)
    need(receipt['status']=='PASS_LOCAL_AUTH6_PROVISION_ONLY'and receipt['bindingSha256']==sha(raw)
         and receipt['actualNaver']=='NOT_RUN'and receipt['d03EmailAliasPolicy']==v['aliasPolicy'],'D03_ORIGINAL_ALIAS_RECEIPT')
    for a in v['actors']:
        need(any(x['userId']==a['userId']and x['sessionId']==a['sessionId']for x in binding['accounts']),'D03_ORIGINAL_ACTOR')
    images=[]
    for a in v['actors']:
        image=kernel.signed_private_read(Path(a['jpegPath']))
        need(1<=len(image)<=2097152 and sha(image)==a['jpegSha256']and image[:2]==b'\xff\xd8'and image[-2:]==b'\xff\xd9','D03_SOURCE_JPEG');images.append(len(image))
    need(not(root/'d03-qualification-private.json').exists(),'D03_QUALIFICATION_PACKET_EXISTS')
    evidence=root/'d03-qualification';evidence.mkdir(mode=0o700,exist_ok=False)
    save=lambda name,value:kernel.provisioning_json(evidence,name,value)
    save('intent.json',{'scope':'SYNTHETIC_D03_QUALIFICATION_ONLY','reviewSha256':sha(review._sealed),'originalBindingSha256':sha(raw),'originalAuth6ReceiptSha256':sha(receipt_raw),'noReplay':True})
    ports=FixedQualificationPorts(review,binding);before=None;error=None;qualified=False;packet_sha=None;baseline_sha=None
    try:
        ports.guard(start=True);ports.start_monitor();before=ports.snapshot();save('before-private.json',before)
        need(sha(json.dumps(before,sort_keys=True).encode())==receipt['finalSha256'],'D03_AUTH6_FINAL_BASELINE_CHANGED')
        old=ports.inspect_rows();save('preimages-private.json',old)
        need(len(old['public.profiles'])==2 and len(old['private.member_episodes'])==2,'D03_EXACT_OWN_PROFILES_EPISODES')
        need(all(not rows for table,rows in old.items()if table not in('public.profiles','private.member_episodes')),'D03_PREEXISTING_QUALIFICATION')
        need(all(r['row']['identity_id']is None and r['row']['ended_at']is None for r in old['private.member_episodes']),'D03_EPISODE_ALREADY_QUALIFIED')
        ports.guard();save('metadata-intent.json',{'singleCommit':True,'actors':v['actors'],'actualNaver':'NOT_RUN','actualStorageAPI':'NOT_RUN'})
        ports.insert_metadata(images)
        for index,a in enumerate(v['actors']):
            ports.guard();save('complete-'+str(index)+'-intent.json',{'userId':a['userId'],'sessionId':a['sessionId'],'singleRequest':True})
            account=next(x for x in binding['accounts']if x['userId']==a['userId'])
            status,body=ports.complete(a,account);save('complete-'+str(index)+'-response-private.json',{'httpStatus':status,'bodyHex':body.hex()})
            need(status==200,'D03_COMPLETE_SIGNUP_FAILED');ports.guard()
        after=ports.snapshot();save('after-private.json',after)
        new=ports.inspect_rows();save('postimages-private.json',new)
        validate_qualified_rows(v,old,new,images,binding)
        proof=validate_delta(before,after,old,new);save('delta.json',proof)
        need(kernel.signed_private_read(root/'signed-ai-binding-private.json')==raw and kernel.signed_private_read(Path(v['receiptPath']))==receipt_raw,'D03_AUTH6_BYTES_CHANGED')
        baseline_sha=save('qualified-baseline-private.json',after)
        packet={a['userId']:{'path':a['jpegPath'],'sha256':a['jpegSha256'],'storagePath':a['storagePath']}for a in v['actors']}
        ports.guard()
        packet_sha=kernel.provisioning_json(root,'d03-qualification-private.json',packet);qualified=True
    except BaseException as exc:error=type(exc).__name__
    finally:
        if not qualified:
            try:
                ports.guard();save('failure-after-private.json',ports.snapshot())
                save('failure-after-capture.json',{'status':'CAPTURED'})
            except BaseException as exc:save('failure-after-capture.json',{'status':'UNAVAILABLE','reasonType':type(exc).__name__})
        try:
            ports.close_monitor()
            need(not ports.failures,'D03_MEMORY_MONITOR')
        except BaseException:error='MONITOR_CLOSURE_UNPROVEN';qualified=False
        try:history_preserved=kernel.signed_private_read(root/'signed-ai-binding-private.json')==raw and kernel.signed_private_read(Path(v['receiptPath']))==receipt_raw
        except BaseException:history_preserved=False
        if not history_preserved:qualified=False;error='AUTH6_HISTORY_PRESERVATION_UNPROVEN'
        save('receipt.json',{'status':'PASS_SYNTHETIC_QUALIFICATION_ONLY'if qualified else'FAIL_CLOSED','failureType':error,
            'actualNaver':'NOT_RUN','actualStorageAPI':'NOT_RUN','sourceJpegBytesVerified':True,'auth6HistoricalReceiptPreserved':history_preserved,'qualificationPacketSha256':packet_sha,'qualifiedBaselineSha256':baseline_sha,
            'ownedChildClosed':not ports.unclosed_child,'originalBindingSha256':sha(raw),'originalReceiptSha256':sha(receipt_raw),'retainOwnQualificationRows':True,'automaticReplay':False})
    need(qualified,'D03_QUALIFICATION_FAILED_NO_REPLAY')
    return {'status':'PASS_SYNTHETIC_QUALIFICATION_ONLY','evidenceRoot':str(evidence)}

def validate_qualified_rows(v,old,new,images,binding):
    need(set(old)==set(new),'D03_TYPED_TABLE_SCOPE')
    need(all(len(rows)==2 for rows in new.values()),'D03_EXACT_QUALIFIED_ROWS')
    def by(table,key,value):
        matches=[r['row']for r in new[table]if r['row'].get(key)==value]
        need(len(matches)==1,'D03_EXACT_TYPED_ID');return matches[0]
    for a,size in zip(v['actors'],images):
        uid=a['userId'];account=next(x for x in binding['accounts']if x['userId']==uid)
        n=by('private.naver_accounts','subject',a['subject'])
        need(all(n.get(k)==val for k,val in {'user_id':uid,'auth_email':account['authEmail'],'real_name':'합성 D03','birth_date':'1990-01-01','gender':'female','verification_status':'qualified'}.items())and n.get('verified_at')and n.get('completed_at'),'D03_QUALIFIED_ACCOUNT')
        ns=by('private.naver_sessions','session_id',a['sessionId'])
        need(ns.get('user_id')==uid and ns.get('subject')==a['subject'],'D03_QUALIFIED_SESSION')
        identity=by('private.naver_identity_keys','subject',a['subject'])
        need(set(identity)=={'id','subject'}and str(uuid.UUID(identity['id']))==identity['id'],'D03_QUALIFIED_IDENTITY')
        old_profile=next(r['row']for r in old['public.profiles']if r['row']['id']==uid)
        profile=by('public.profiles','id',uid)
        expected={**old_profile,'real_name':'합성 D03','birth_date':'1990-01-01','gender':'female','avatar_url':a['storagePath']}
        if 'updated_at'in old_profile:
            need(type(profile['updated_at'])is str and profile['updated_at']>=old_profile['updated_at'],'D03_PROFILE_UPDATE_CLOCK')
            expected['updated_at']=profile['updated_at']
        need(profile==expected,'D03_PROFILE_UNAPPROVED_CHANGE')
        old_episode=next(r['row']for r in old['private.member_episodes']if r['row']['profile_id']==uid)
        episode=by('private.member_episodes','profile_id',uid)
        need(episode=={**old_episode,'identity_id':identity['id']},'D03_EPISODE_UNAPPROVED_CHANGE')
        traits=by('private.profile_traits','profile_id',uid)
        need(traits.get('interests')==[]and traits.get('conversation_styles')==[]and traits.get('mbti')is None,'D03_TRAITS_UNAPPROVED_CHANGE')
        obj=by('storage.objects','id',a['objectId'])
        need(obj.get('bucket_id')=='profile-images'and obj.get('name')==a['storagePath']and obj.get('owner_id')==uid
             and obj.get('metadata')=={'mimetype':'image/jpeg','size':size},'D03_PHOTO_METADATA_UNAPPROVED_CHANGE')
    return {'status':'SYNTHETIC_QUALIFICATION_METADATA_ONLY','actualNaver':'NOT_RUN','actualStorageAPI':'NOT_RUN'}

if __name__=='__main__':
    print(json.dumps({'status':'NOT_RUN','scope':'D03_SYNTHETIC_QUALIFICATION_ONLY','typedRootReviewRequired':True}))
