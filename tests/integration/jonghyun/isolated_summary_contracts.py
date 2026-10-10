"""Fresh prepared SQL + product summary factory; root explicitly executes --run.

Eight live checkpoint/publish races and six latest insufficient transitions.
Synthetic Auth identity/model/privacy/safety only. Original source112/private
graph, gateway/Auth, provider/budget and production safety are NOT_RUN.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import uuid

# Transport is reused read-only; its AI prepare/rpc/cleanup are never called.
from isolated_ai_contracts import Runner as GuardedRunner, quote, REPO
from run_database_tests import isolated_prepared_target

SIGNATURES=(
 'acquire_worker_run(integer,uuid)','release_worker_run(uuid)',
 'enqueue_job(text,text,jsonb,timestamp with time zone)','claim_job(uuid,integer,uuid)',
 'claim_supported_job(uuid,integer,uuid,text[])','complete_job(uuid,uuid,uuid)',
 'retry_job(uuid,uuid,timestamp with time zone,text,uuid)',
 'yield_job(uuid,uuid,timestamp with time zone,uuid)','fail_job(uuid,uuid,text,uuid)',
 'supersede_job(uuid,uuid,uuid)','prepare_queue_invocation(uuid,uuid,text,integer,integer)',
 'claim_queue_invocation_dispatch(uuid,uuid,text,integer,integer)',
 'complete_queue_invocation(uuid)','get_queue_invocation(uuid)',
 'reserve_review_summary_model(text,text,text,bigint,uuid,uuid,uuid,text,uuid,text,text,uuid[],text)',
 'load_review_summary_source(uuid,uuid,uuid,text)',
 'load_review_summary_checkpoint(uuid,uuid,text,uuid,text)',
 'save_review_summary_checkpoint(uuid,uuid,text,jsonb,uuid,text)',
 'discard_review_summary_checkpoint(uuid,uuid,text,uuid,text)',
 'mark_review_summary_insufficient(uuid,uuid,text,uuid,text)',
 'publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text,uuid,text)',
)
NAMES={s.split('(')[0] for s in SIGNATURES}
COMMENT='대화가 편안했고 함께한 시간이 즐거웠어요.'
EDITED='편안하게 이야기하며 함께한 시간이 즐거웠습니다.'

def require(value,code):
    if not value:raise ValueError(code)

def graph():
    todo=[REPO/'backend/supabase/functions/review-summary-worker/index.ts'];result={}
    while todo:
        path=todo.pop().resolve()
        require(path.is_relative_to(REPO/'backend/supabase/functions') and path.suffix=='.ts','PRODUCT_IMPORT_BOUNDARY')
        name=str(path.relative_to(REPO))
        if name in result:continue
        data=path.read_bytes();result[name]=hashlib.sha256(data).hexdigest()
        for local in re.findall(r'''(?:from\s*|import\s*)["'](\.[^"']+)["']''',data.decode()):todo.append((path.parent/local).resolve())
    for name in ('tests/integration/minkyu/worker_safety_http_local.py','tests/integration/minkyu/worker_safety_http.ts',
                 'tests/integration/jonghyun/isolated_ai_contracts.py',
                 'tests/integration/jonghyun/isolated_summary_contracts.py',
                 'tests/integration/jonghyun/isolated_summary_factory.ts'):
        result[name]=hashlib.sha256((REPO/name).read_bytes()).hexdigest()
    return result

class Runner(GuardedRunner):
    def __init__(self,root):
        super().__init__(root)
        self.role='ym_summary_isolated_'+uuid.uuid4().hex[:12]
        self.people=[str(uuid.uuid4()) for _ in range(2)]
        self.posts=[str(uuid.uuid4()) for _ in range(5)]
        self.requests=[str(uuid.uuid4()) for _ in range(5)]
        self.appointments=[str(uuid.uuid4()) for _ in range(5)]
        self.reviews=[str(uuid.uuid4()) for _ in range(5)]
        self.jobs=[];self.invocations=[];self.run_tokens=[];self.mutation_proof=None
        self.role_created=False

    def digest(self):
        # Protect every row, including budgets excluded by the AI fixture digest.
        return self.sql("begin;create temp table fingerprints(n text,h text);do $$declare t record;h text;begin "
          "for t in select schemaname,tablename from pg_tables where schemaname in('public','private','storage','auth') order by 1,2 loop "
          "execute format('select md5(coalesce(string_agg(v,%L order by v),%L)) from(select to_jsonb(x)::text v from %I.%I x)s',E'\\n','',t.schemaname,t.tablename)into h;"
          "insert into fingerprints values(t.schemaname||'.'||t.tablename,h);end loop;end $$;"
          "select md5(string_agg(n||':'||h,E'\\n' order by n))from fingerprints;rollback;")

    def catalog(self):
        return self.sql("select md5(coalesce(string_agg(to_jsonb(p)::text,E'\\n' order by p.oid),''))from pg_proc p where pronamespace in('public'::regnamespace,'private'::regnamespace);"
          "select md5(coalesce(string_agg(to_jsonb(r)::text,E'\\n' order by oid),''))from pg_roles r;"
          "select md5(coalesce(string_agg(to_jsonb(a)::text,E'\\n' order by roleid,member),''))from pg_auth_members a;"
          "select md5(coalesce(string_agg(jsonb_build_object('schema',nspname,'acl',nspacl)::text,E'\\n' order by nspname),''))from pg_namespace;")

    def prepare(self):
        require(json.loads(self.sql('select json_agg(version order by version)from supabase_migrations.schema_migrations;'))==self.target['versions'],'APPLIED_HISTORY_CHANGED')
        closed=self.sql("select count(*)from auth.users;select count(*)from public.profiles;select count(*)from private.worker_jobs;select count(*)from private.worker_invocations;select external_processing_allowed from private.ai_processing_guard where singleton;select enabled from private.worker_invocation_control where singleton;select enabled from private.worker_runtime_atomic_control where singleton;select current_setting('cron.launch_active_jobs');")
        require(closed.splitlines()==['0','0','0','0','f','f','f','off'],'FRESH_CLOSED_EMPTY_REQUIRED')
        self.baseline=self.digest();self.catalog_before=self.catalog()
        self.global_before=json.loads(self.sql('select to_jsonb(g)from private.global_worker_run g;'))
        self.changed=True
        self.sql('begin;create role '+self.role+' login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;'
          'grant '+self.role+' to postgres with admin false,inherit false,set true;grant usage on schema public to '+self.role+';'
          'grant execute on function '+','.join('public.'+s for s in SIGNATURES)+' to '+self.role+';'
          "do $$begin assert not has_schema_privilege("+quote(self.role)+",'private','USAGE');assert not has_table_privilege("+quote(self.role)+",'private.worker_invocations','SELECT');"
          "assert not pg_has_role("+quote(self.role)+",'service_role','SET');assert not has_function_privilege('service_role','public.publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text,uuid,text)','EXECUTE');end;$$;"
          'update private.worker_runtime_atomic_control set enabled=true where singleton;update private.worker_invocation_control set enabled=true where singleton;'
          'update private.ai_processing_guard set external_processing_allowed=true where singleton;commit;')
        self.role_created=True
        author,target=self.people
        q="begin;select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);"
        for member in self.people:
            q+='insert into auth.users(id)values('+quote(member)+');insert into public.profiles(id,real_name,birth_date,gender)values('+quote(member)+",'합성회원','1990-01-01','female');insert into private.ai_member_processing(user_id,summary_allowed)values("+quote(member)+',true);'
        for i in range(5):
            q+='insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)values('+quote(self.posts[i])+','+quote(author)+",'합성 요약 공고','로컬 연결 검증','산책',now()-interval'12 days',now()-interval'11 days',now()-interval'13 days','서울특별시 강남구 역삼동','closed');"
            q+='insert into public.join_requests(id,post_id,requester_id,message,status)values('+quote(self.requests[i])+','+quote(self.posts[i])+','+quote(target)+",'합성 후기 검증 신청','matched');"
            q+='insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)values('+quote(self.appointments[i])+','+quote(self.posts[i])+','+quote(self.requests[i])+",'completed',now()-interval'10 days','automatic',now()-interval'10 days',now()-interval'9 days',now()-interval'3 days');"
            q+='insert into public.appointment_reviews(id,appointment_id,reviewer_id,rating,comment,experience)values('+quote(self.reviews[i])+','+quote(self.appointments[i])+','+quote(author)+',5,'+('null' if i==3 else quote(COMMENT))+",'positive');select public.set_review_publication("+quote(self.reviews[i])+','+('false' if i==4 else 'true')+');'
        self.sql(q+'commit;');self.context=self.enqueue()

    def rpc(self,name,args):
        require(name in NAMES and isinstance(args,dict) and all(re.fullmatch('p_[a-z_]+',k) for k in args),'RPC_ALLOWLIST')
        def wire(value):
            if value is None:return 'null'
            if isinstance(value,list):return 'array['+','.join(quote(v) for v in value)+']::'+('text[]' if name=='claim_supported_job' else 'uuid[]')
            return quote(json.dumps(value,ensure_ascii=False) if isinstance(value,dict) else value)
        prefix='begin;set local role '+self.role+";do $$begin perform set_config('request.jwt.claim.role','service_role',true);perform set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);end;$$;"
        return json.loads(self.sql(prefix+'select public.'+name+'('+','.join(k+' => '+wire(v) for k,v in args.items())+');commit;').splitlines()[-1])

    def enqueue(self):
        source=json.loads(self.sql('select private.refresh_review_summary_state('+quote(self.people[1])+');'));revision=source['sourceRevision']
        job=self.rpc('enqueue_job',{'p_kind':'review_summary','p_dedupe_key':'synthetic-summary:'+uuid.uuid4().hex,'p_payload':{'profileId':self.people[1],'sourceRevision':revision,'modelVersion':'synthetic-summary-v1','promptVersion':'review-summary-v1'},'p_available_at':'2000-01-01T00:00:00Z'})
        require(job['deduplicated'] is False and job['status']=='queued','FRESH_JOB');self.jobs.append(job['jobId'])
        run=self.rpc('acquire_worker_run',{'p_lease_seconds':180,'p_existing_token':None});require(run is not None,'RUN_ACQUIRED')
        token=run['token'];self.run_tokens.append(token);req=str(uuid.uuid4());self.invocations.append(req)
        args={'p_request_id':req,'p_global_token':token,'p_kind':'review_summary','p_limit':1,'p_remaining_ms':60000}
        require(self.rpc('prepare_queue_invocation',args)=={'requestId':req,'state':'prepared','fresh':True},'PREPARED')
        require(self.rpc('claim_queue_invocation_dispatch',args)=={'claimed':True},'FIRST_DISPATCH')
        require(self.rpc('claim_queue_invocation_dispatch',args)=={'claimed':False},'DUPLICATE_DISPATCH_CLOSED')
        return {'jobId':job['jobId'],'sourceRevision':revision,'requestId':req,'runToken':token}

    def proof(self,context):
        author,target=self.people;job=context['jobId'];review=self.reviews[0]
        return json.loads(self.sql(f"""select json_build_object(
          'jobId',j.id,'target',j.payload->>'profileId','jobRevision',j.payload->>'sourceRevision','jobStatus',j.status,
          'scope',json_build_object('jobId',j.id,'leaseToken',a.job_lease_token,'workerRunToken',r.global_token,'sourceRevision',j.payload->>'sourceRevision','contractVersion','2026-10-05','parent',r.request_id),
          'dispatchable',coalesce(j.status='running' and j.lease_token=a.job_lease_token and exists(select 1 from private.worker_job_run_fences f where f.job_id=j.id and f.job_lease_token=a.job_lease_token and f.worker_run_token=r.global_token) and r.kind='review_summary' and r.state='prepared' and r.dispatch_started and r.deadline>clock_timestamp() and j.lease_expires_at>clock_timestamp() and exists(select 1 from private.global_worker_run g where g.token=r.global_token and g.expires_at>clock_timestamp()),false),
          'settledStatus',a.settled_status,'effect',a.effect,'parentState',r.state,'claimCalls',r.claim_calls,'parentResult',r.result,
          'parentRemainingMs',r.remaining_ms,'parentLimit',r.item_limit,'parentKind',r.kind,'parentClosedAt',r.closed_at,
          'revision',st.revision::text,'visibleNull',st.visible_summary_id is null,
          'checkpoints',(select count(*)from private.review_summary_checkpoints where profile_id='{target}'),
          'published',(select count(*)from private.review_summary_job_publications where profile_id='{target}'),
          'eligibleCount',jsonb_array_length(private.review_summary_sources('{target}')),
          'authorConsent',m.summary_allowed,'authorWithdrawn',m.summary_withdrawn_at is not null,
          'publicReviewCount',(select count(*)from public.appointment_reviews rv where rv.reviewer_id='{author}' and rv.id=any(array[{','.join(quote(x) for x in self.reviews[:3])}]::uuid[]) and private.is_review_public_eligible(rv.id)),
          'selectedReviewExists',exists(select 1 from public.appointment_reviews where id='{review}'),
          'reviewerExact',exists(select 1 from public.appointment_reviews where id='{review}' and reviewer_id='{author}'),
          'commentHash',(select encode(extensions.digest(comment,'sha256'),'hex')from public.appointment_reviews where id='{review}'),
          'authorProfilePresent',exists(select 1 from public.profiles where id='{author}'),
          'originalAppointments',(select count(*)from public.appointments ap join public.posts p on p.id=ap.post_id where p.author_id='{author}' and ap.status='completed'),
          'auditClaims',(select count(*)from private.worker_invocation_jobs where job_id=j.id),
          'slotExact',exists(select 1 from private.worker_runtime_job_slots sl where sl.job_id=j.id and sl.global_token=r.global_token))
          from private.worker_jobs j join private.review_summary_state st on st.profile_id='{target}' join private.ai_member_processing m on m.user_id='{author}'
          left join private.worker_invocation_jobs a on a.job_id=j.id left join private.worker_invocations r on r.request_id=a.request_id where j.id='{job}';"""))

    def mutate(self,body):
        require(self.mutation_proof is None,'ONE_MUTATION_ONLY');before=self.proof(self.context);scope=body['scope']
        require(scope==before['scope'] and before['dispatchable'] and before['settledStatus'] is None and before['effect'] is None,'LIVE_ORIGINAL_SCOPE')
        require(1<=before['parentRemainingMs']<=60000 and 1<=before['parentLimit']<=10 and before['parentRemainingMs']==60000 and before['parentLimit']==1,'ORIGINAL_PARENT_ALLOCATION_BOUNDS')
        require(before['parentKind']=='review_summary' and before['parentClosedAt'] is None,'ORIGINAL_PARENT_OPEN_KIND')
        require(before['revision']==scope['sourceRevision'] and before['eligibleCount']==3 and before['publicReviewCount']==3 and before['authorConsent'] and before['reviewerExact'],'ORIGINAL_EVIDENCE')
        require(before['commentHash']==hashlib.sha256(COMMENT.encode()).hexdigest() and before['visibleNull'] and before['published']==0 and before['checkpoints']==int(self.phase=='publish'),'ORIGINAL_PHASE')
        review=quote(self.reviews[0]);author=quote(self.people[0])
        if self.mutation=='edit':command='update public.appointment_reviews set comment='+quote(EDITED)+' where id='+review+';'
        elif self.mutation=='hide':command='select public.set_review_publication('+review+',false);'
        elif self.mutation=='delete':command='delete from public.appointment_reviews where id='+review+';'
        else:command="set local role authenticated;do $$begin perform set_config('request.jwt.claim.role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',"+author+")::text,true);perform set_config('request.jwt.claim.sub',"+author+",true);end;$$;select public.withdraw_my_ai_processing('review_summary');"
        # Recheck the held invocation in the mutation transaction, not only in
        # the preceding observation connection. No stale lease can mutate.
        guard=f"""do $$begin assert exists(select 1 from private.worker_jobs j join private.worker_invocation_jobs a on a.job_id=j.id
          join private.worker_invocations r on r.request_id=a.request_id where j.id='{scope['jobId']}' and j.lease_token='{scope['leaseToken']}'
          and j.status='running' and a.job_lease_token='{scope['leaseToken']}' and a.settled_status is null and r.request_id='{scope['parent']}'
          and r.global_token='{scope['workerRunToken']}' and r.kind='review_summary' and r.state='prepared' and r.dispatch_started
          and exists(select 1 from private.worker_job_run_fences fence where fence.job_id=j.id and fence.job_lease_token=a.job_lease_token and fence.worker_run_token=r.global_token)
          and r.deadline>clock_timestamp() and j.lease_expires_at>clock_timestamp() and j.payload->>'sourceRevision'='{scope['sourceRevision']}'
          and exists(select 1 from private.global_worker_run g where g.token=r.global_token and g.expires_at>clock_timestamp()));end;$$;"""
        self.sql("begin;select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);"+guard+command+'commit;')
        after=self.proof(self.context)
        require(after['scope']==scope and after['dispatchable'] and after['jobStatus']=='running' and after['settledStatus'] is None and after['effect'] is None,'MUTATION_LIVE_FENCE')
        require(after['parentRemainingMs']==before['parentRemainingMs'] and after['parentLimit']==before['parentLimit'],'MUTATION_ALLOCATION_UNCHANGED')
        require(after['parentKind']=='review_summary' and after['parentClosedAt'] is None,'MUTATION_PARENT_OPEN_KIND')
        require(int(after['revision'])>int(before['revision']) and after['visibleNull'] and after['checkpoints']==0 and after['published']==0,'ATOMIC_INVALIDATION')
        require(after['eligibleCount']=={'edit':3,'hide':2,'delete':2,'consent':0}[self.mutation] and after['publicReviewCount']==(2 if self.mutation in ('hide','delete') else 3),'EXACT_REDUCED_EVIDENCE')
        require(after['authorProfilePresent'] and after['originalAppointments']==5,'GENERAL_ACCOUNT_RETAINED')
        if self.mutation=='consent':require(not after['authorConsent'] and after['authorWithdrawn'],'WITHDRAWN')
        if self.mutation=='delete':require(not after['selectedReviewExists'],'REVIEW_DELETED')
        if self.mutation=='edit':require(after['commentHash']==hashlib.sha256(EDITED.encode()).hexdigest(),'COMMENT_EDITED')
        self.mutation_proof={'before':before,'after':after};return {'status':'applied'}

    def completed(self,context,status,effect):
        p=self.proof(context)
        require(1<=p['parentRemainingMs']<=60000 and 1<=p['parentLimit']<=10 and p['parentRemainingMs']==60000 and p['parentLimit']==1,'COMPLETED_PARENT_ALLOCATION_BOUNDS')
        require(p['parentKind']=='review_summary' and isinstance(p['parentClosedAt'],str) and p['parentClosedAt'],'COMPLETED_PARENT_CLOSED_KIND')
        require(p['jobStatus']==status and p['settledStatus']==status and p['effect']==effect and p['parentState']=='completed' and p['claimCalls']==1 and p['auditClaims']==1 and p['slotExact'],'JOURNAL_COMPLETED')
        require(p['parentResult']['status']=='ran' and p['parentResult']['counts']['superseded' if status=='superseded' else 'succeeded']==1,'PARENT_RESULT')
        require(not p['dispatchable'] and p['visibleNull'] and p['checkpoints']==0 and p['published']==0,'NO_STALE_PUBLICATION');return p

    def control(self,name,body):
        if name=='mutate':return self.mutate(body)
        if name=='complete':
            require(body['requestId'] in self.invocations,'OWN_INVOCATION')
            value=self.rpc('complete_queue_invocation',{'p_request_id':body['requestId']})
            # SQL109 stores settled DB counts, not the HTTP/batch stopReason.
            actual=value.get('result');worker=body['result']
            require(value['state']=='completed' and actual['status']==worker['status']=='ran','COMPLETION_STATUS')
            require(actual['counts']=={'claimed':worker['counts']['claimed'],'succeeded':worker['counts']['succeeded'],'retried':worker['counts']['retryWait'],'failed':worker['counts']['failed'],'superseded':worker['counts']['superseded'],'yielded':worker['counts']['yielded']},'COMPLETION_EQUALS_WORKER');return {'status':'completed'}
        if name=='insufficient':
            require(self.mutation!='edit' and not hasattr(self,'latest'),'ONE_LATEST_ONLY')
            original=self.completed(self.context,'superseded',None)
            require(original['scope']==self.mutation_proof['after']['scope'],'ORIGINAL_SCOPE_UNCHANGED')
            require(self.rpc('release_worker_run',{'p_token':self.context['runToken']})=={'status':'applied'},'ORIGINAL_RUN_RELEASED')
            self.latest=self.enqueue()
            require(self.latest['jobId']!=self.context['jobId'] and self.latest['sourceRevision']==original['revision'],'LATEST_REVISION_JOB');return self.latest
        if name=='prove':
            original=self.completed(self.context,'superseded',None)
            require(original['scope']==self.mutation_proof['after']['scope'],'ORIGINAL_SCOPE_PRESERVED')
            if self.mutation!='edit':
                latest=self.completed(self.latest,'succeeded','insufficient')
                require(latest['jobRevision']==latest['revision']==self.latest['sourceRevision'] and latest['eligibleCount']==(0 if self.mutation=='consent' else 2),'LATEST_INSUFFICIENT_EVIDENCE')
            return {'status':'proved'}
        raise ValueError('CONTROL_ALLOWLIST')

    def clean(self):
        if not self.changed:return
        self.sql('update private.ai_processing_guard set external_processing_allowed=false where singleton;update private.worker_invocation_control set enabled=false where singleton;update private.worker_runtime_atomic_control set enabled=false where singleton;')
        ids=lambda xs:','.join(quote(x)+'::uuid' for x in xs) or 'null::uuid'
        q='begin;delete from private.worker_invocation_jobs where request_id in('+ids(self.invocations)+');delete from private.worker_invocations where request_id in('+ids(self.invocations)+');'
        q+='delete from private.worker_job_run_fences where job_id in('+ids(self.jobs)+');delete from private.worker_runtime_job_slots where job_id in('+ids(self.jobs)+');'
        q+='delete from private.worker_jobs where id in('+ids(self.jobs)+');delete from public.posts where id in('+ids(self.posts)+');'
        q+='delete from private.ai_member_processing where user_id in('+ids(self.people)+');delete from public.profiles where id in('+ids(self.people)+');delete from auth.users where id in('+ids(self.people)+');'
        if self.global_before is not None:q+='update private.global_worker_run set (token,expires_at)=(select token,expires_at from jsonb_populate_record(null::private.global_worker_run,'+quote(json.dumps(self.global_before))+'::jsonb)) where singleton;'
        if self.role_created:q+='drop owned by '+self.role+';drop role '+self.role+';'
        q+='commit;';self.sql(q)
        require(self.digest()==self.baseline,'ALL_ROWS_RESTORED');require(self.catalog()==self.catalog_before,'ROLES_MEMBERSHIPS_PRODUCT_ACL_RESTORED')
        isolated_prepared_target(self.root)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--prepared-root',type=Path,required=True);parser.add_argument('--node',default=shutil.which('node'));parser.add_argument('--run',action='store_true');args=parser.parse_args()
    isolated_prepared_target(args.prepared_root)
    if not args.run:print(json.dumps({'status':'NOT_RUN','scope':'CURRENT119_SUMMARY14_SYNTHETIC'}));return
    require(args.node and Path(args.node).is_file(),'NODE_REQUIRED')
    def stop(signum,frame):raise RuntimeError('OWN_PROCESS_TERMINATED')
    signal.signal(signal.SIGTERM,stop);manifest=graph();results=[]
    for mutation in ('edit','consent','hide','delete'):
        for phase in ('checkpoint','publish'):
            runner=Runner(args.prepared_root);runner.mutation=mutation;runner.phase=phase;server=None
            try:
                require(manifest==graph(),'FROZEN_SOURCE_CHANGED');runner.prepare()
                class Bridge(BaseHTTPRequestHandler):
                    def log_message(self,*unused):pass
                    def do_POST(self):
                        body=None
                        try:
                            require(self.headers.get('Authorization')=='Bearer synthetic-service','SYNTHETIC_TOKEN_REQUIRED')
                            size=int(self.headers.get('Content-Length','0'));require(0<size<=65536,'BODY_LIMIT');body=json.loads(self.rfile.read(size))
                            if self.path.startswith('/rpc/'):result=runner.rpc(self.path[5:],body)
                            elif self.path.startswith('/control/'):result=runner.control(self.path[9:],body)
                            else:raise ValueError('BRIDGE_PATH')
                            wire=json.dumps(result).encode();self.send_response(200)
                        except Exception as error:
                            label=str(error) if re.fullmatch('[A-Z_0-9:]+',str(error)) else 'ISOLATED_SUMMARY_RPC_FAILED'
                            # Product readiness deliberately probes NIL scoped effects.
                            # Preserve their real SQL rejection as public STATE_CONFLICT;
                            # every actual fixture failure remains fatal.
                            probe=self.path in ('/rpc/mark_review_summary_insufficient','/rpc/publish_review_summary_for_job','/rpc/yield_job','/rpc/fail_job','/rpc/supersede_job') and isinstance(body,dict) and body.get('p_job_id')=='00000000-0000-0000-0000-000000000000'
                            if probe and label in ('SQLSTATE_55000','SQLSTATE_40001','SQLSTATE_P0001'):
                                wire=b'{"code":"STATE_CONFLICT"}';self.send_response(409)
                            else:
                                runner.failed=True;runner.failure_code=label;wire=b'{"code":"ISOLATED_SUMMARY_RPC_FAILED"}';self.send_response(500)
                        self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(wire)));self.end_headers();self.wfile.write(wire)
                server=ThreadingHTTPServer(('127.0.0.1',0),Bridge);threading.Thread(target=server.serve_forever,daemon=True).start()
                fixture={'scope':'CURRENT119_SUMMARY14_SYNTHETIC','codeRoot':str(REPO),'origin':'http://127.0.0.1:'+str(server.server_port),'manifest':manifest,'rpcs':sorted(NAMES),'comment':COMMENT,'reviewIds':runner.reviews[:3],'mutation':mutation,'phase':phase,**runner.context}
                path=args.prepared_root/('summary-synthetic-'+uuid.uuid4().hex+'.json');fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
                with os.fdopen(fd,'w')as stream:json.dump(fixture,stream)
                try:
                    result=subprocess.run([args.node,'--experimental-strip-types',str(Path(__file__).with_name('isolated_summary_factory.ts')),str(path)],capture_output=True,text=True,timeout=150)
                    output=json.loads(result.stdout.strip().splitlines()[-1])
                    safe_code=output.get('code','')
                    if not isinstance(safe_code,str) or not re.fullmatch('SUMMARY_CHECK_[A-Z0-9_]+|SUMMARY_BARRIER_TIMEOUT',safe_code):safe_code='SUMMARY_FACTORY_FAILED'
                    require(result.returncode==0 and output['status']=='PASS' and not runner.failed,getattr(runner,'failure_code',safe_code));results.append(output)
                finally:path.unlink(missing_ok=True)
                require(manifest==graph(),'FROZEN_SOURCE_CHANGED')
            finally:
                if server:server.shutdown();server.server_close()
                runner.clean()
    require(len(results)==8 and sum(x['insufficient'] for x in results)==6,'EXACT_FOURTEEN_CASES')
    print(json.dumps({'status':'PASS','scope':'CURRENT119_SUMMARY14_SYNTHETIC','races':8,'insufficient':6,'allRowsRolesMembershipsProductAclRestored':True,'sourcePins':manifest,'cases':results,'originalSource112PrivateGraphActualAuthProviderBudgetProductionSafety':'NOT_RUN'},ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except Exception as error:
        code=str(error) if re.fullmatch('[A-Z_0-9:]+',str(error)) else 'ISOLATED_SUMMARY_FAILED'
        print(json.dumps({'status':'FAIL','code':code,'scope':'CURRENT119_SUMMARY14_SYNTHETIC'}));raise SystemExit(1)
