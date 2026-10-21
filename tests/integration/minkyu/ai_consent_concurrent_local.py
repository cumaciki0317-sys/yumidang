"""고정 Scratch의 합성 SQL 동시 철회 추가 검사. 독립 Docker 실행/CLI 진입점 없음."""
import json
import os
import re
import signal
import subprocess
import tempfile
import time

FIXTURE='tests/database/minkyu/ai_consent_concurrent_fixture.sql'
APPS=('minkyu_ai_withdraw_a1cc_actor_a','minkyu_ai_withdraw_a1cc_actor_b')
SCHEMAS="('auth','public','private','storage','cron','vault','supabase_migrations')"


def need(ok,code):
    if not ok:raise ValueError(code)


def relation_name(value):
    need(type(value) is str and re.fullmatch('[a-zA-Z_][a-zA-Z_0-9]*',value),'RELATION_IDENTIFIER')
    return '"'+value+'"'


def snapshot(scratch):
    """원본 행은 개인 command 파일에만 남기며 반환값은 해시 bag/카탈로그/sequence다."""
    tables=json.loads(scratch.sql(("select coalesce(jsonb_agg(jsonb_build_array(schemaname,tablename)order by schemaname,tablename),'[]') from pg_tables where schemaname in"+SCHEMAS+';').encode()))
    need(len({tuple(row) for row in tables})==len(tables),'TABLE_INVENTORY')
    terms=[]
    for schema,table in tables:
        table_sql=relation_name(schema)+'.'+relation_name(table)
        terms.append("select '"+schema+'.'+table+"' k,(select coalesce(jsonb_object_agg(h,n),'{}') from (select encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')h,count(*)n from "+table_sql+' r group by 1)b)v')
    rows_query="select coalesce(jsonb_object_agg(k,v),'{}') from ("+' union all '.join(terms)+')q;' if terms else "select '{}'::jsonb;"
    rows=json.loads(scratch.sql(rows_query.encode()))
    catalogue=json.loads(scratch.sql(("select jsonb_build_object('relations',(select jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relnamespace,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.reloptions)order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in"+SCHEMAS+"),'columns',(select jsonb_agg(to_jsonb(a)order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in"+SCHEMAS+" and a.attnum>0),'functions',(select jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,pg_get_functiondef(p.oid))order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in"+SCHEMAS+" and p.prokind in('f','p')),'constraints',(select jsonb_agg(to_jsonb(c)order by c.oid) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in"+SCHEMAS+"),'triggers',(select jsonb_agg(to_jsonb(t)order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in"+SCHEMAS+"),'defaults',(select jsonb_agg(to_jsonb(d)order by d.oid) from pg_attrdef d join pg_class c on c.oid=d.adrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in"+SCHEMAS+"),'roles',(select jsonb_agg(to_jsonb(r)order by r.oid) from pg_roles r),'memberships',(select jsonb_agg(to_jsonb(m)order by roleid,member) from pg_auth_members m));").encode()))
    catalogue['policiesIndexesSequences']=json.loads(scratch.sql(("select jsonb_build_object('policies',(select jsonb_agg(to_jsonb(p)order by p.oid) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in"+SCHEMAS+"),'indexes',(select jsonb_agg(to_jsonb(i)order by i.indexrelid) from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in"+SCHEMAS+"),'sequences',(select jsonb_agg(to_jsonb(q)order by q.seqrelid) from pg_sequence q join pg_class c on c.oid=q.seqrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in"+SCHEMAS+"),'schemas',(select jsonb_agg(jsonb_build_array(n.oid,n.nspname,n.nspowner,n.nspacl)order by n.oid) from pg_namespace n where n.nspname in"+SCHEMAS+"));").encode()))
    sequences=json.loads(scratch.sql(("select coalesce(jsonb_agg(jsonb_build_array(n.nspname,c.relname)order by n.nspname,c.relname),'[]') from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S' and n.nspname in"+SCHEMAS+';').encode()))
    state=sequence_values(scratch,sequences)
    return {'rows':rows,'catalogue':catalogue,'sequences':state}


def sequence_values(scratch,sequences):
    keys=[];terms=[]
    for schema,name in sequences:
        table=relation_name(schema)+'.'+relation_name(name)
        key=schema+'.'+name;keys.append(key)
        terms.append("select '"+key+"' k,jsonb_build_object('last_value',s.last_value,'log_cnt',s.log_cnt,'is_called',s.is_called) v from "+table+' s')
    need(len(keys)==len(set(keys)),'SEQUENCE_INVENTORY')
    if not terms:return {}
    values=json.loads(scratch.sql(("select jsonb_object_agg(k,v)from("+' union all '.join(terms)+')q;').encode()))
    need(type(values) is dict and set(values)==set(keys) and len(values)==len(keys),'SEQUENCE_KEYSET')
    for row in values.values():
        need(type(row) is dict and set(row)=={'last_value','log_cnt','is_called'} and
             type(row['last_value']) is int and type(row['log_cnt']) is int and type(row['is_called']) is bool,'SEQUENCE_VALUES')
    return values


def observe(scratch):
    query="select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'application',application_name,'state',state,'query',query,'backendStart',backend_start,'queryStart',query_start,'observedAt',clock_timestamp(),'waitType',wait_event_type,'blockers',pg_blocking_pids(pid))order by application_name),'[]')from pg_stat_activity where datname=current_database() and application_name in('"+"','".join(APPS)+"') and pid<>pg_backend_pid();"
    return json.loads(scratch.sql(query.encode()))


def actor_bindings(outputs,observations,count):
    need(len(outputs)>=count,'ACTOR_OUTPUT_SET')
    result=[]
    for index in range(count):
        matches=re.findall(rb'^([0-9]+)\|[^\r\n]+$',outputs[index],re.M)
        need(len(matches)<=1,'ACTOR_PID_OUTPUT')
        pid=int(matches[0]) if matches else None
        candidates={(r.get('pid'),r.get('backendStart')) for rows in observations for r in rows
                    if r.get('application')==APPS[index] and
                    "public.withdraw_my_ai_processing('review_summary')" in r.get('query','') and
                    type(r.get('pid')) is int and r['pid']>0 and type(r.get('backendStart')) is str and r['backendStart']}
        need(len(candidates)==1,'ACTOR_BACKEND_IDENTITY_UNPROVEN')
        observed_pid,started=next(iter(candidates))
        need(pid is None or pid==observed_pid,'ACTOR_PID_MISMATCH')
        result.append({'pid':observed_pid,'backendStart':started,'application':APPS[index],
                       'pidSource':'stdout_and_observation' if pid is not None else 'unique_observation'})
    need(len({row['pid'] for row in result})==count,'ACTOR_PID_DUPLICATE')
    return result


def observe_exact_backends(scratch,bindings):
    need(bindings and all(type(row.get('pid')) is int and row['pid']>0 for row in bindings),'BACKEND_IDS')
    ids=','.join(str(row['pid']) for row in bindings)
    query="select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'backendStart',backend_start,'application',application_name,'state',state)order by pid),'[]')from pg_stat_activity where datname=current_database() and pid in("+ids+');'
    return json.loads(scratch.sql(query.encode()))


def exact_backends_absent(rows,bindings):
    expected={row['pid']:row['backendStart'] for row in bindings}
    need(type(rows) is list and len({r.get('pid') for r in rows})==len(rows) and
         all(type(r.get('pid')) is int and r['pid'] in expected and type(r.get('backendStart')) is str for r in rows),'BACKEND_CLOSURE_ROWS')
    # application_name은 SET LOCAL 해제 뒤 달라져도 동일 pid+backend_start이면 미종결이다.
    return not any(expected[row['pid']]==row['backendStart'] for row in rows)


def concurrency_proof(observations,actor_pids):
    need(type(actor_pids) is list and len(actor_pids)==2 and all(type(p) is int and p>0 for p in actor_pids) and len(set(actor_pids))==2,'ACTOR_PIDS')
    for rows in observations:
        if len(rows)!=2 or {r.get('application') for r in rows}!=set(APPS):continue
        by_app={r['application']:r for r in rows}
        if [by_app[a].get('pid') for a in APPS]!=actor_pids:continue
        if any(r.get('state')!='active' or "public.withdraw_my_ai_processing('review_summary')" not in r.get('query','') or not r.get('queryStart') for r in rows):continue
        for row in rows:
            other=next(p for p in actor_pids if p!=row['pid'])
            if row.get('waitType')=='Lock' and row.get('blockers')==[other]:
                return {'status':'PASS_SYNTHETIC_SQL_CONCURRENCY_ONLY','actorPids':actor_pids,'waiter':row['pid'],'blockers':[other],
                        'overlapObservation':rows,'actualAuth':'NOT_RUN','providerCalls':0}
    raise ValueError('CONCURRENT_LOCK_NOT_PROVEN')


def group_state(pid):
    try:os.killpg(pid,0);return 'present'
    except ProcessLookupError:return 'absent'
    except OSError:return 'unknown'


def close_group(child):
    proof=[]
    for sig in (None,signal.SIGTERM,signal.SIGKILL):
        if sig is not None:
            try:os.killpg(child.pid,sig);proof.append({'signal':int(sig),'result':'sent'})
            except ProcessLookupError:proof.append({'signal':int(sig),'result':'absent'})
            except OSError:proof.append({'signal':int(sig),'result':'unknown'})
        deadline=time.monotonic()+(0 if sig is None else 3)
        while True:
            try:reaped=type(child.wait(timeout=0)) is int
            except (subprocess.TimeoutExpired,OSError):reaped=False
            state=group_state(child.pid);proof.append({'reaped':reaped,'group':state})
            if reaped and state=='absent':return {'closed':True,'observations':proof}
            if time.monotonic()>=deadline:break
            time.sleep(.05)
    return {'closed':False,'observations':proof}


def phase(scratch,fixture,name):
    need(name in('setup','verify','cleanup'),'FIXED_PHASE')
    scratch.guard();scratch.own()
    scratch.save('consent-'+name+'-intent.json',{'phase':name,'attempt':1,'automaticReplay':False})
    args=['exec','-i',scratch.target,'psql','-XqAt','-v','ON_ERROR_STOP=1','-v','phase='+name,'-h','/var/run/postgresql','-U','supabase_admin','-d','postgres']
    return scratch.docker(args,fixture,timeout=30)[0]


def run(scratch):
    """root가 새 Scratch에 고정 연결한다. executor/target/credentials를 인자로 받지 않는다."""
    fixture=scratch.read_source(FIXTURE)
    scratch.guard();scratch.own()
    baseline=snapshot(scratch);scratch.save('consent-baseline-private.json',baseline)
    setup=False;actors=[];streams=[];observations=[];closed=True;backends_closed=True;error=None;result=None;restored=False
    try:
        phase(scratch,fixture,'setup');setup=True
        # seq/원문 writer는 여기 메인 thread만 사용한다. worker thread는 만들지 않는다.
        scratch.guard();scratch.own()
        for index,label in enumerate(('a','b')):
            inp=tempfile.TemporaryFile();out=tempfile.TemporaryFile();err=tempfile.TemporaryFile();streams.append((inp,out,err))
            inp.write(fixture);inp.seek(0)
            args=['docker','--host',scratch_host(scratch),'exec','-i',scratch.target,'psql','-XqAt','-v','ON_ERROR_STOP=1','-v','phase=withdraw_'+label,'-h','/var/run/postgresql','-U','supabase_admin','-d','postgres']
            scratch.save('consent-actor-'+label+'-intent.json',{'targetId':scratch.target,'phase':'withdraw_'+label,'attempt':1,'stdinSha256':scratch_sha(scratch,fixture),'automaticReplay':False})
            scratch.memory()
            child=subprocess.Popen(args,stdin=inp,stdout=out,stderr=err,start_new_session=True)
            actors.append(child);backends_closed=False;scratch.concurrent_unclosed=True
        deadline=time.monotonic()+180
        while any(child.poll() is None for child in actors):
            scratch.memory();scratch.guard();scratch.own()
            need(time.monotonic()<deadline,'CONCURRENT_TIMEOUT')
            need(all(out.tell()<=524288 and err.tell()<=524288 for _,out,err in streams),'ACTOR_OUTPUT_LIMIT')
            rows=observe(scratch);observations.append(rows)
            scratch.save('consent-observation-'+str(len(observations))+'.json',rows)
            time.sleep(.1)
    except BaseException as exc:error=exc
    finally:
        for index,child in enumerate(actors):
            closure=close_group(child);closed=closed and closure['closed']
            scratch.save('consent-actor-'+('a','b')[index]+'-closure.json',closure)
        outputs=[]
        for index,(inp,out,err) in enumerate(streams):
            out.seek(0);err.seek(0);stdout=out.read(524289);stderr=err.read(524289)
            if (len(stdout)>524288 or len(stderr)>524288) and error is None:error=ValueError('ACTOR_OUTPUT_LIMIT')
            label=('a','b')[index];scratch.save('consent-actor-'+label+'-stdout.raw',stdout);scratch.save('consent-actor-'+label+'-stderr.raw',stderr)
            outputs.append(stdout)
            if index<len(actors):scratch.save('consent-actor-'+label+'-result.json',{'exit':actors[index].returncode,'stdoutSha256':scratch_sha(scratch,stdout),'stderrSha256':scratch_sha(scratch,stderr)})
            inp.close();out.close();err.close()
        bindings=[]
        if actors and closed:
            try:
                bindings=actor_bindings(outputs,observations,len(actors))
                scratch.save('consent-actor-backend-bindings.json',bindings)
                deadline=time.monotonic()+15;closure_count=0
                while True:
                    rows=observe_exact_backends(scratch,bindings);closure_count+=1
                    scratch.save('consent-backend-closure-'+str(closure_count)+'.json',rows)
                    if exact_backends_absent(rows,bindings):backends_closed=True;break
                    need(time.monotonic()<deadline,'ACTOR_BACKEND_NOT_CLOSED');time.sleep(.2)
            except BaseException as exc:
                if error is None:error=exc
        scratch.concurrent_unclosed=not(closed and backends_closed)
        try:
            need(closed and backends_closed,'CONCURRENT_CLOSURE_UNPROVEN')
            need(error is None,'CONCURRENT_DISPATCH_FAILED')
            need(len(actors)==2 and all(c.returncode==0 for c in actors),'ACTOR_SQL_FAILED')
            need(all(row['pidSource']=='stdout_and_observation' for row in bindings),'ACTOR_STDOUT_PID_UNPROVEN')
            pids=[row['pid'] for row in bindings]
            for raw in outputs:
                need(raw.count(b'{"withdrawn": true}')==1,'WITHDRAWAL_RESULT')
            result=concurrency_proof(observations,pids)
            phase(scratch,fixture,'verify')
        except BaseException as exc:
            if error is None:error=exc
        if setup and closed and backends_closed:
            try:
                phase(scratch,fixture,'cleanup')
                after=snapshot(scratch);scratch.save('consent-after-cleanup-private.json',after)
                need(after==baseline,'CONSENT_BASELINE_CHANGED');restored=True
            except BaseException as exc:
                if error is None:error=exc
        scratch.save('consent-concurrency-receipt.json',{'status':'PASS_SYNTHETIC_SQL_CONCURRENCY_ONLY' if error is None and restored else 'NOT_PROVEN',
            'lockProof':result,'groupsClosed':closed,'backendsClosed':backends_closed,'baselineRestored':restored,
            'actualAuth':'NOT_RUN','providerCalls':0,'automaticReplay':False,'failureType':None if error is None else type(error).__name__})
    if error is not None:raise ValueError('CONSENT_CONCURRENCY_NOT_PROVEN') from None
    need(restored,'CONSENT_BASELINE_NOT_RESTORED')
    return result


def scratch_host(scratch):
    # trusted loaded Scratch module의 고정 값만 사용한다. HTTP/JSON host 인자를 받지 않는다.
    return scratch.__class__.__module_host__


def scratch_sha(scratch,raw):
    return __import__('hashlib').sha256(raw).hexdigest()
