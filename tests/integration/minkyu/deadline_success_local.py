"""D03 수정 후 성공 증거의 별도 계약과 고정 runtime 조립.

기존400 재현 판정을 변경하지 않는다. 아래 순수 검산과 고정 정리 계획은
실제 catalog/125 소스가 명시 등록되고 검토된 새 source에서만 소비할 수 있다.
"""
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import os
import stat
import subprocess
import sys
import importlib.util
from contextlib import contextmanager
import re
import uuid

SELF='tests/integration/minkyu/deadline_success_local.py'
EXTRA=('public.appointment_reviews','private.review_publication','private.sweetness_review_contributions',
       'private.review_summary_state','private.review_refresh_outbox','private.review_summary_checkpoints')

def need(ok,code):
    if not ok:raise ValueError(code)
def canon(v):return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def sha(v):return hashlib.sha256(v).hexdigest()
def uid(v):
    need(type(v)is str and str(uuid.UUID(v))==v,'SUCCESS_UUID');return "'"+v+"'::uuid"

@dataclass(frozen=True)
class ReviewedDeadlineSuccess:
    source_head:str
    self_sha256:str
    migration_entries_sha256:str
    versions:tuple
    expected_tables:tuple
    full_table_set_sha256:str
    scope_id:str
    author_id:str
    reviewer_id:str
    appointment_id:str
    author_episode_id:str
    expected_insert_revision:int=2
    expected_delete_revision:int=5

    def validate(self):
        need(type(self)is ReviewedDeadlineSuccess,'SUCCESS_EXACT_TYPED_REVIEW')
        need(re.fullmatch('[a-f0-9]{40}',self.source_head or ''),'SUCCESS_HEAD')
        for v in (self.self_sha256,self.migration_entries_sha256,self.full_table_set_sha256):
            need(type(v)is str and re.fullmatch('[a-f0-9]{64}',v),'SUCCESS_LITERAL_SHA')
        need(type(self.versions)is tuple and len(self.versions)==125 and list(self.versions)==sorted(set(self.versions))
             and all(re.fullmatch('[0-9]{14}',v)for v in self.versions),'SUCCESS_REVIEWED125_REQUIRED')
        need(type(self.expected_tables)is tuple and len(self.expected_tables)==182
             and list(self.expected_tables)==sorted(set(self.expected_tables))
             and set(EXTRA)<=set(self.expected_tables)
             and sha(canon(self.expected_tables))==self.full_table_set_sha256,'SUCCESS_TABLE_PROFILE')
        need(type(self.scope_id)is str and re.fullmatch('[a-f0-9]{32}',self.scope_id),'SUCCESS_SCOPE')
        for v in (self.author_id,self.reviewer_id,self.appointment_id,self.author_episode_id):uid(v)
        need(self.author_id!=self.reviewer_id,'SUCCESS_DISTINCT_ACTORS')
        need(type(self.expected_insert_revision)is int and self.expected_insert_revision==2
             and type(self.expected_delete_revision)is int and self.expected_delete_revision==5,'SUCCESS_FIXED_TRIGGER_REVISIONS')


def verify_initial_empty(rows,review):
    review.validate()
    need(type(rows)is dict and set(rows)==set(EXTRA),'SUCCESS_INITIAL_RELATIONS')
    need(all(type(v)is list and not v for v in rows.values()),'SUCCESS_PREEXISTING_RELATION')


def verify_success(response,rows,review,query_us,deadline_us,release_us):
    """200만으로 성공하지 않는다. 원문·상관귀속/PG종결은 호출자의 별도 필수 증거다."""
    review.validate()
    need(all(type(v)is int for v in (query_us,deadline_us,release_us))
         and query_us<deadline_us<=release_us and release_us-query_us<7000000,'SUCCESS_TIME_WINDOW')
    need(type(response)is dict and response.get('status')==200 and response.get('bodyComplete')is True
         and response.get('transportClosed')is True,'SUCCESS_ORIGINAL_HTTP_CLOSED')
    body=response.get('body');need(type(body)is dict and set(body)=={'reviewId','submittedAt','deduplicated'}
         and body['deduplicated']is False and type(body['submittedAt'])is str and body['submittedAt'],'SUCCESS_EXACT_RESPONSE')
    uid(body['reviewId']);need(type(rows)is dict and set(rows)==set(EXTRA),'SUCCESS_RELATIONS')
    rv=rows['public.appointment_reviews'];need(type(rv)is list and len(rv)==1,'SUCCESS_ONE_REVIEW')
    r=rv[0];need(r.get('id')==body['reviewId'] and r.get('appointment_id')==review.appointment_id
        and r.get('reviewer_id')==review.reviewer_id and r.get('rating')==3 and type(r.get('rating'))is int
        and r.get('comment')is None and r.get('experience')=='neutral' and r.get('praises')==[]
        and r.get('submitted_at')==body['submittedAt'],'SUCCESS_REVIEW_PAYLOAD')
    pub=rows['private.review_publication'];need(len(pub)==1 and pub[0].get('review_id')==r['id']
        and pub[0].get('publication_source')=='policy' and pub[0].get('is_public')is False,'SUCCESS_PUBLICATION')
    contrib=rows['private.sweetness_review_contributions'];need(len(contrib)==1
        and contrib[0].get('review_id')==r['id'] and contrib[0].get('recipient_episode_id')==review.author_episode_id
        and type(contrib[0].get('reaction_delta'))is int and contrib[0]['reaction_delta']==0
        and type(contrib[0].get('star_delta'))is int and contrib[0]['star_delta']==0,'SUCCESS_CONTRIBUTION')
    states=rows['private.review_summary_state'];need(len(states)==2 and {s.get('profile_id')for s in states}=={review.author_id,review.reviewer_id}
        and all(type(s.get('revision'))is int and s['revision']==review.expected_insert_revision
        and s.get('fingerprint')is None and s.get('visible_summary_id')is None for s in states),'SUCCESS_SUMMARY_STATE')
    outbox=rows['private.review_refresh_outbox'];need(len(outbox)==2 and {r.get('profile_id')for r in outbox}=={review.author_id,review.reviewer_id},'SUCCESS_OUTBOX')
    need(rows['private.review_summary_checkpoints']==[],'SUCCESS_CHECKPOINT_CHANGED')
    return {'status':'VERIFIED_DB_ENTRY_SUCCESS_ONLY','reviewId':r['id'],'httpIngressProven':False,
            'policyComplete':False,'automaticReplay':False,'actualNaver':'NOT_RUN'}


def verify_delta(before,after,new_rows,review):
    """fixture 완료 baseline에 추가한 정확 행 bag만 허용한다. 기존 행 갱신도 거절한다."""
    review.validate();need(set(before)==set(after),'SUCCESS_SNAPSHOT_SHAPE')
    need(all(before[k]==after[k]for k in before if k!='rows'),'SUCCESS_AUTHORITY_CHANGED')
    need(sorted(before['rows'])==sorted(after['rows'])==list(review.expected_tables),'SUCCESS_FULL182')
    need(set(new_rows)==set(EXTRA),'SUCCESS_DELTA_RELATIONS')
    for table,bag in before['rows'].items():
        expected=dict(bag)
        for h,n in new_rows.get(table,{}).items():
            need(re.fullmatch('[a-f0-9]{64}',h)and type(n)is int and n>0 and h not in expected,'SUCCESS_NEW_BAG')
            expected[h]=n
        need(after['rows'][table]==expected,'SUCCESS_FOREIGN_OR_MISSING_DELTA')


def cleanup_plan(review,review_id):
    """트리거 억제/시계/sequence변경 없이 새행만 지운다. 실행기는 별도다."""
    review.validate();r=uid(review_id);a=uid(review.appointment_id);users=uid(review.author_id)+','+uid(review.reviewer_id)
    return {'beforeFixtureCleanup':[
        'delete from private.sweetness_review_contributions where review_id='+r+' and recipient_episode_id='+uid(review.author_episode_id)+';',
        'delete from private.review_publication where review_id='+r+" and publication_source='policy';",
        'delete from public.appointment_reviews where id='+r+' and appointment_id='+a+' and reviewer_id='+uid(review.reviewer_id)+';'],
        'afterFixtureCleanup':[
        'delete from private.review_refresh_outbox where profile_id in('+users+');',
        'delete from private.review_summary_state where profile_id in('+users+') and revision=5 and fingerprint is null and visible_summary_id is null;'],
        'requiredBeforeFinalDeletes':{'summaryRevision':5,'checkpointRows':0,'sourceRows':0},
        'sequenceReset':False,'actualCleanup':'NOT_RUN'}


@dataclass(frozen=True)
class ReviewedSuccessAuthority:
    review:ReviewedDeadlineSuccess
    runtime_authority_bytes:bytes
    runtime_sha256:str

    def validate(self):
        need(type(self)is ReviewedSuccessAuthority,'SUCCESS_AUTHORITY_TYPE');self.review.validate()
        need(type(self.runtime_authority_bytes)is bytes,'SUCCESS_AUTHORITY_BYTES')
        v=json.loads(self.runtime_authority_bytes);service=json.loads(v['service_descriptor_bytes'])
        profile=service['currentProfile'];r=self.review
        need(profile==dict(sourceHead=r.source_head,migrationEntriesSha256=r.migration_entries_sha256,
            versions=list(r.versions),expectedTables=list(r.expected_tables),fullTableSetSha256=r.full_table_set_sha256),
            'SUCCESS_EXACT_CURRENT_PROFILE')
        execution=json.loads(v['execution_descriptor_bytes'])
        need(service['sourceHead']==r.source_head==execution['source_head']
            and execution['binding_sha']==service['bindingSha256']
            and execution['original_receipt_sha']==service['auth6ReceiptSha256']
            and execution['source_pins_sha']==sha(canon(service['pins']))
            and execution['decision_id']==service['decisionId']
            and execution['scope_id']==service['scopeId'],'SUCCESS_ORIGINAL_AUTH_BINDING')
        need(all(execution[k]==getattr(r,k)for k in ('scope_id','author_id','reviewer_id','appointment_id')),'SUCCESS_EXACT_EXECUTION')
        need(json.loads(v['owned_source_pins_bytes'])['tests/integration/minkyu/deadline_lock_runtime.py']==self.runtime_sha256,
            'SUCCESS_RUNTIME_PIN')
        return v

class SourceAnchor:
    """새 성공 모듈도 held parent/leaf FD와 HEAD blob을 별도로 봉인한다."""
    def __init__(self,repo,review):
        self.repo=Path(repo);self.path=self.repo/SELF;self.parent=None;self.fd=None
        try:
            need(self.path.resolve()==self.path,'SUCCESS_SOURCE_PATH')
            self.parent=os.open(self.path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            self.parent_state=self.directory(os.fstat(self.parent))
            self.fd=os.open(self.path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=self.parent)
            self.state=self.signature(os.fstat(self.fd));self.head=review.source_head
            need(stat.S_ISREG(self.state[4])and self.state[5]==1 and self.state[6]<=1024*1024,'SUCCESS_SOURCE_FILE')
            self.raw=os.pread(self.fd,self.state[6]+1,0)
            need(sha(self.raw)==review.self_sha256,'SUCCESS_SELF_SHA')
            need(subprocess.check_output(['git','-C',str(self.repo),'show',self.head+':'+SELF],timeout=15)==self.raw,'SUCCESS_SELF_NOT_COMMITTED')
            self.check()
        except BaseException:self.close();raise
    @staticmethod
    def signature(s):return(s.st_dev,s.st_ino,s.st_uid,s.st_gid,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    @staticmethod
    def directory(s):return(s.st_dev,s.st_ino,s.st_uid,s.st_gid,s.st_mode)
    def check(self):
        need(subprocess.check_output(['git','-C',str(self.repo),'rev-parse','HEAD'],text=True,timeout=15).strip()==self.head,'SUCCESS_HEAD_CHANGED')
        need(self.directory(os.fstat(self.parent))==self.parent_state==self.directory(self.path.parent.lstat())
            and self.path.resolve()==self.path,'SUCCESS_PARENT_CHANGED')
        need(self.signature(os.fstat(self.fd))==self.state==self.signature(os.stat(self.path.name,dir_fd=self.parent,follow_symlinks=False))
            and os.pread(self.fd,self.state[6]+1,0)==self.raw,'SUCCESS_SOURCE_CHANGED')
    def close(self):
        for name in ('fd','parent'):
            fd=getattr(self,name,None)
            if fd is not None:os.close(fd);setattr(self,name,None)


def relation_predicates(review):
    ap=uid(review.appointment_id);users=uid(review.author_id)+','+uid(review.reviewer_id)
    reviews='select id from public.appointment_reviews where appointment_id='+ap
    return {EXTRA[0]:'appointment_id='+ap,EXTRA[1]:'review_id in('+reviews+')',EXTRA[2]:'review_id in('+reviews+')',
        EXTRA[3]:'profile_id in('+users+')',EXTRA[4]:'profile_id in('+users+')',EXTRA[5]:'profile_id in('+users+')'}

def relations_sql(review):
    terms=[]
    for t,p in relation_predicates(review).items():
        records="select coalesce(jsonb_agg(to_jsonb(r)order by to_jsonb(r)::text),'[]'::jsonb)from "+t+' r where '+p
        bag="select coalesce(jsonb_object_agg(h,n),'{}'::jsonb)from(select encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')h,count(*)n from "+t+' r where '+p+' group by 1)s'
        terms.extend(("'"+t+"',jsonb_build_object('records',("+records+"),'bag',("+bag+'))',))
    return 'select jsonb_build_object('+','.join(terms)+');'


def guarded_cleanup_sql(review,review_id,rows,fixture_predicates):
    """전체 정리 TX에서 정확 payload를 다시 확인한 뒤 자기행만 삭제한다."""
    review.validate();rid=uid(review_id);pred=relation_predicates(review)
    need(set(rows)==set(EXTRA),'SUCCESS_CLEANUP_EXACT_RELATIONS')
    q=lambda x:"'"+x.replace("'","''")+"'"
    sql="begin;set local statement_timeout='5s';set local lock_timeout='1s';lock table "+','.join(EXTRA)+" in share row exclusive mode;do $success$ begin "
    for t,p in pred.items():
        sql+="if(select coalesce(jsonb_agg(to_jsonb(r)order by to_jsonb(r)::text),'[]'::jsonb)from "+t+' r where '+p+')is distinct from '+q(canon(rows[t]).decode())+"::jsonb then raise exception 'success_cleanup_payload_changed';end if;"
    sql+='end $success$;'
    sql+='delete from private.sweetness_review_contributions where review_id='+rid+';delete from private.review_publication where review_id='+rid+';delete from public.appointment_reviews where id='+rid+' and appointment_id='+uid(review.appointment_id)+';'
    for t in ('private.conversation_generation_appointments','private.appointment_member_episodes','public.appointments','public.notifications','private.conversation_retention_generations','public.join_requests','public.posts'):
        sql+='delete from '+t+' where '+fixture_predicates[t]+';'
    users=uid(review.author_id)+','+uid(review.reviewer_id)
    sql+="do $successfinal$ begin if(select count(*)from private.review_summary_state where profile_id in("+users+")and revision=5 and fingerprint is null and visible_summary_id is null)<>2 or exists(select 1 from private.review_summary_checkpoints where profile_id in("+users+"))then raise exception 'success_cleanup_trigger_delta';end if;end $successfinal$;"
    sql+='delete from private.review_refresh_outbox where profile_id in('+users+');delete from private.review_summary_state where profile_id in('+users+');commit;'
    return sql


def success_runtime_class(runtime_module,review,anchor):
    """검토한 runtime의 정상 subclass. 원400 classifier와 executor는 변경하지 않는다."""
    class SuccessRuntime(runtime_module.FixedDeadlineRuntime):
        def __init__(self,*args):
            self.success_proofs={};self.fixture_baseline=None;self.success_rows=None;self.success_result=None
            super().__init__(*args)
        def save(self,name,value):
            super().save(name,value)
            self.success_proofs[name]=json.loads(canon(value))
        def guard(self,*args,**kwargs):
            anchor.check();return super().guard(*args,**kwargs)
        def relation_state(self):
            value=json.loads(self.sql(relations_sql(review)))
            need(set(value)==set(EXTRA),'SUCCESS_RELATION_QUERY')
            return {t:value[t]['records']for t in EXTRA},{t:value[t]['bag']for t in EXTRA}
        def prepare_fast_phase(self,fast):
            rows,_=self.relation_state();verify_initial_empty(rows,review)
            self.save('success-initial-relations-private.json',rows)
            return super().prepare_fast_phase(fast)
        def verify_delta(self,before,after,execution,cleanup):
            super().verify_delta(before,after,execution,cleanup)
            if not cleanup:self.fixture_baseline=after
        def run_fast_phase(self,seal):
            # 기존400판정의 NOT_PROVEN은 정상200을 성공으로 승격시키지 않는다.
            prior=super().run_fast_phase(seal)
            need(prior.get('status')=='NOT_PROVEN','SUCCESS_EXPECTED_SEPARATE_200')
            window=self.success_proofs.get('d03-fast-window-private.json',{})
            release=self.success_proofs.get('d03-fast-release-private.json',{})
            need(release.get('actualCommitCompletedUpperBound')is True,'SUCCESS_COMMIT_MARKER')
            samples=[r for name,rows in self.success_proofs.items()if name.startswith('d03-fast-activity-')for r in rows
                if self.http_backend is not None and r.get('pid')==self.http_backend['pid']and r.get('backendStart')==self.http_backend['backendStart']and r.get('waitEventType')=='Lock']
            need(samples and self.http_child is not None and self.http_child.response_closed,'SUCCESS_CORRELATION_AND_HTTP')
            contract=runtime_module.reviewed_rpc(json.loads(self.authority.rpc_review_bytes))
            need(all(s['query']==contract['query']and s['querySha256']==contract['querySha256']for s in samples),'SUCCESS_QUERY_FINGERPRINT')
            rows,bags=self.relation_state();result=verify_success(self.http_child.result,rows,review,samples[-1]['queryStartUs'],window['deadlineUs'],release['releasedUs'])
            verify_delta(self.fixture_baseline,self.snapshot(),bags,review)
            self.success_rows=rows;self.success_result=result
            self.save('success-verified-private.json',result);return result
        def cleanup_fixture(self,execution):
            rows,_=self.relation_state()
            if not rows[EXTRA[0]]:
                need(not any(rows[t]for t in (EXTRA[1],EXTRA[2])),'SUCCESS_ORPHAN_RELATIONS')
                return super().cleanup_fixture(execution)
            # 응답유실/잘못된 생성행은 자동삭제 대상으로 승격하지 않는다.
            need(self.success_result is not None and rows==self.success_rows,'SUCCESS_CLEANUP_NOT_REVIEWED')
            self.sql(guarded_cleanup_sql(review,self.success_result['reviewId'],rows,runtime_module.predicates(execution)))
            final,_=self.relation_state();need(all(not x for x in final.values()),'SUCCESS_CLEANUP_REMAINS')
            self.save('success-own-cleanup-private.json',{'ownRowsAbsent':True,'sequenceReset':False})
    return SuccessRuntime


def run_reviewed(authority):
    need(type(authority)is ReviewedSuccessAuthority,'SUCCESS_AUTHORITY_TYPE')
    data=authority.validate();review=authority.review;repo=Path(__file__).resolve().parents[3]
    # JSON으로 bytes를 자동승격하지 않는다. root는 원문 UTF8 문자열들을 명시 봉인한다.
    data={k:v.encode()if k.endswith('_bytes')else v for k,v in data.items()}
    runtime_path=repo/'tests/integration/minkyu/deadline_lock_runtime.py'
    raw=runtime_path.read_bytes();need(sha(raw)==authority.runtime_sha256,'SUCCESS_RUNTIME_SOURCE')
    need(subprocess.check_output(['git','-C',str(repo),'show',review.source_head+':tests/integration/minkyu/deadline_lock_runtime.py'],timeout=15)==raw,'SUCCESS_RUNTIME_NOT_COMMITTED')
    spec=importlib.util.spec_from_file_location('reviewed_success_runtime',runtime_path);module=importlib.util.module_from_spec(spec)
    previous=sys.modules.get(spec.name)
    runtime=None;error=None;anchor=None;old_runner=sys.modules.get('run_database_tests')
    try:
        sys.modules[spec.name]=module
        anchor=SourceAnchor(repo,review)
        exec(compile(raw,str(runtime_path),'exec'),module.__dict__)
        base=module.ReviewedDeadlineAuthority(**data);value=json.loads(base.service_descriptor_bytes);owned=json.loads(base.owned_source_pins_bytes)
        module.verify_own_sources(review.source_head,owned)
        ro=module.load(module.READONLY,owned[module.READONLY]);execution=module.load(module.EXECUTOR,owned[module.EXECUTOR])
        ev=execution.ReviewedDeadlineExecution(**json.loads(base.execution_descriptor_bytes));ev.validate()
        module.reviewed_rpc(json.loads(base.rpc_review_bytes))
        service=module.reconstruct_service_review(ro,value)
        sys.modules['run_database_tests']=ro.load('tools/local/run_database_tests.py',value['pins']['tools/local/run_database_tests.py'])
        with ro.current_support(value['pins']):
            try:
                runtime=success_runtime_class(module,review,anchor)(base,ro,execution,service,ev)
                runtime.bind();fast=module.ReviewedD03FastPhase(base.fast_phase_review_bytes)
                result=execution.ReviewedFastDeadlineExecutor(ev,runtime,fast).run()
                need(result.get('status')=='VERIFIED_DB_ENTRY_SUCCESS_ONLY','SUCCESS_NOT_PROVEN')
            except BaseException as exc:error=exc;raise
            finally:
                if runtime is not None:runtime.close(error)
        anchor.check();return result
    finally:
        try:
            if anchor is not None:anchor.close()
        finally:
            if previous is None:sys.modules.pop(spec.name,None)
            else:sys.modules[spec.name]=previous
            if old_runner is None:sys.modules.pop('run_database_tests',None)
            else:sys.modules['run_database_tests']=old_runner

if __name__=='__main__':print(json.dumps({'status':'NOT_RUN','actualSQL':0,'actualHTTP':0,'actual125Profile':'NOT_VERIFIED'}))
