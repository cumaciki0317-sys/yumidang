"""Fresh prepared DB + product AI factory. SQL RPC real; Auth bridge synthetic.

Root executes explicitly. No old context/private fixture/provider is accessed.
AI22/23 original TS unit assertions are preserved; natural midnight is NOT_RUN.
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
import threading
import shutil
import signal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import uuid

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'tools/local'))
from run_database_tests import isolated_prepared_target, isolated_command_error

INTERNAL = {'acquire_ai_chat_request', 'reserve_ai_chat_account_model', 'settle_ai_account_budget',
            'record_ai_chat_result_available', 'finish_ai_chat_request'}
MEMBER = {'get_my_profile_traits', 'search_public_posts_v2', 'get_post_author_traits'}

def quote(value):
    return "'" + str(value).replace("'", "''") + "'"

class Runner:
    def __init__(self, root):
        self.root = root
        self.target = isolated_prepared_target(root)
        self.base = ['docker', '--host', self.target['host']]
        self.users = [str(uuid.uuid4()) for _ in range(3)]
        self.all_users = list(self.users)
        self.tokens = {f'synthetic.member{i}.signature': u for i, u in enumerate(self.users)}
        self.days = set()
        self.ledgers = []
        self.changed = False
        self.failed = False

    def call(self, args, data=None):
        result = subprocess.run(self.base + args, input=data, text=True, capture_output=True, timeout=25)
        if result.returncode:
            raise isolated_command_error(result.stderr)
        return result.stdout.strip()

    def identity(self):
        t = self.target
        item = json.loads(self.call(['inspect', t['id']]))[0]
        if (item['Id'] != t['id'] or item['Image'] != t['image'] or item['Name'] != '/' + t['container']
                or not item['State']['Running'] or item['Config']['Labels'].get('com.supabase.cli.project') != t['project']):
            raise ValueError('ISOLATED_ID_CHANGED')
        if self.call(['context', 'inspect', t['context'], '--format', '{{.Endpoints.docker.Host}}']) != t['host']:
            raise ValueError('ISOLATED_SOCKET_CHANGED')

    def sql(self, statement):
        self.identity()
        return self.call(['exec', '-i', self.target['id'], 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres',
                          '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-f', '-'],
                         "set statement_timeout='15s';set lock_timeout='10s';set plpgsql.check_asserts=on;\n" + statement)

    def digest(self):
        return self.sql("begin;create temp table fingerprints(n text,h text);do $$declare t record;h text;begin "
                        "for t in select schemaname,tablename from pg_tables where schemaname in('public','private','storage','auth') and not(schemaname='private' and tablename in('ai_budget_ledgers','ai_budget_reservations','ai_account_budget_reservations','ai_account_daily_budget','ai_global_daily_budget')) order by 1,2 loop "
                        "execute format('select md5(coalesce(string_agg(v,%L order by v),%L)) from(select to_jsonb(x)::text v from %I.%I x)s',E'\\n','',t.schemaname,t.tablename)into h;"
                        "insert into fingerprints values(t.schemaname||'.'||t.tablename,h);end loop;end $$;"
                        "select md5(string_agg(n||':'||h,E'\\n' order by n))from fingerprints;rollback;")

    def prepare(self):
        if json.loads(self.sql('select json_agg(version order by version)from supabase_migrations.schema_migrations;')) != self.target['versions']:
            raise ValueError('APPLIED_HISTORY_CHANGED')
        closed = self.sql("select count(*)from auth.users;select count(*)from public.profiles;select external_processing_allowed from private.ai_processing_guard where singleton;select current_setting('cron.launch_active_jobs');"
                          "select (select count(*)from private.ai_account_daily_budget)+(select count(*)from private.ai_global_daily_budget)+(select count(*)from private.ai_account_budget_reservations)+(select count(*)from private.ai_chat_requests)+(select count(*)from private.ai_budget_ledgers);")
        if closed.splitlines() != ['0','0','f','off','0']:
            raise ValueError('FRESH_CLOSED_EMPTY_REQUIRED')
        self.baseline = self.digest()
        self.accounts = json.loads(self.sql('select json_agg(to_jsonb(a)order by account_id)from private.ai_budget_accounts a;'))
        if {a['account_id'] for a in self.accounts} != {'yumi','jonghyun','minkyu','sungho'}:
            raise ValueError('EXACT_FOUR_ACCOUNTS_REQUIRED')
        if any(a['unit_limit']!=3200000 for a in self.accounts):raise ValueError('ACCOUNT_POLICY_LIMIT_CHANGED')
        self.catalog=self.sql("select md5(coalesce(string_agg(to_jsonb(p)::text,E'\\n' order by p.oid),''))from pg_proc p where pronamespace in('public'::regnamespace,'private'::regnamespace);select md5(coalesce(string_agg(to_jsonb(r)::text,E'\\n' order by oid),''))from pg_roles r;")
        self.changed = True
        ids = ','.join(quote(u)+'::uuid' for u in self.users)
        self.sql("begin;insert into auth.users(id)select unnest(array["+ids+"]);"
                 "insert into public.profiles(id,real_name,birth_date,gender)select unnest(array["+ids+"]), '합성한도회원','1990-01-01'::date,'female';"
                 "insert into private.ai_member_processing(user_id,exploration_allowed)select unnest(array["+ids+"]),true;"
                 "update private.ai_budget_accounts set registered=true;update private.ai_processing_guard set external_processing_allowed=true where singleton;commit;")

    def rpc(self, name, args, token):
        if name not in INTERNAL | MEMBER or not isinstance(args, dict) or any(not re.fullmatch(r'p_[a-z_]+', key) for key in args):
            raise ValueError('RPC_NOT_ALLOWED')
        if name in INTERNAL:
            if token != 'synthetic-service': raise ValueError('INTERNAL_TOKEN_REQUIRED')
            role, claims = 'service_role', {'role':'service_role'}
        else:
            if token not in self.tokens: raise ValueError('MEMBER_TOKEN_REQUIRED')
            role, claims = 'authenticated', {'role':'authenticated','sub':self.tokens[token], 'is_anonymous':False}
        wire = ','.join(key+' => '+quote(json.dumps(value, ensure_ascii=False) if isinstance(value,(dict,list)) else value) if value is not None else key+' => null' for key,value in args.items())
        prefix = 'begin;set local role '+role+';'
        prefix += 'do $$begin perform set_config(\'request.jwt.claims\','+quote(json.dumps(claims))+',true);'
        if 'sub' in claims: prefix += "perform set_config('request.jwt.claim.sub',"+quote(claims['sub'])+',true);'
        prefix += 'end $$;'
        result = json.loads(self.sql(prefix+'select public.'+name+'('+wire+');commit;').splitlines()[-1])
        if name == 'reserve_ai_chat_account_model' and result.get('accountDay'):
            self.days.add(result['accountDay'])
        return result

    def clean(self):
        if not self.changed: return
        ids = ','.join(quote(u)+'::uuid' for u in self.all_users)
        ledger = ','.join(quote(x) for x in self.ledgers) or "''"
        # Close first in its own transaction, even if a subsequent cleanup assertion fails.
        self.sql("update private.ai_processing_guard set external_processing_allowed=false where singleton;")
        self.sql("begin;"
                 "delete from private.ai_result_receipts where user_id in("+ids+");"
                 "delete from private.ai_chat_requests where user_id in("+ids+");"
                 "delete from private.ai_member_daily_usage where user_id in("+ids+");"
                 "delete from private.ai_member_processing where user_id in("+ids+");"
                 "delete from public.profiles where id in("+ids+");delete from auth.users where id in("+ids+");"
                 # Profile insert creates an episode without a profile FK. Only
                 # these exact non-Naver fixture owners may be cleaned up.
                 "do $$begin if exists(select 1 from private.member_episodes where profile_id in("+ids+") and identity_id is not null)"
                 "then raise exception 'synthetic_episode_has_identity' using errcode='55000';end if;end $$;"
                 "delete from private.member_episodes where profile_id in("+ids+") and identity_id is null;commit;")
        # Guarded UNKNOWN/90-day receipts and their budget/ledger metadata are intentionally preserved.
        for a in self.accounts:
            self.sql('update private.ai_budget_accounts set registered='+('true' if a['registered'] else 'false')+' where account_id='+quote(a['account_id'])+';')
        if self.digest() != self.baseline: raise ValueError('FIXTURE_CLEANUP_DIGEST_CHANGED')
        if self.catalog!=self.sql("select md5(coalesce(string_agg(to_jsonb(p)::text,E'\\n' order by p.oid),''))from pg_proc p where pronamespace in('public'::regnamespace,'private'::regnamespace);select md5(coalesce(string_agg(to_jsonb(r)::text,E'\\n' order by oid),''))from pg_roles r;"):raise ValueError('CATALOG_ROLES_ACL_CHANGED')
        isolated_prepared_target(self.root)

    def prove(self, fixture, observations):
        """TS transport observations must match committed SQL requests and receipts."""
        for o in observations:
            request=o['requests'][0];rid=request['requestId'];uid=fixture['accounts'][o['account']]['userId']
            if request['acquireStatus']!='acquired':
                if self.sql('select count(*)from private.ai_chat_requests where request_id='+quote(rid)+'::uuid;')!='0':raise ValueError('DENIED_REQUEST_CREATED')
                continue
            denied=o['case']=='global-denied';unknown=o['case'] in ('unknown-provider-loss','unknown-preserved')
            row=json.loads(self.sql("select jsonb_build_object('owner',user_id="+quote(uid)+"::uuid,'finished',outcome='finished'and finished_at is not null,'started',started_at is not null,'lease',encode(sha256(convert_to(lease_token::text,'UTF8')),'hex'),'day',counted_day,'dayBound',counted_day=(started_at at time zone'Asia/Seoul')::date,'results',(select count(*)from private.ai_result_receipts where request_id=r.request_id and user_id=r.user_id))from private.ai_chat_requests r where request_id="+quote(rid)+'::uuid;'))
            if not(row['owner'] and row['finished'] and row['lease']==request['leaseSha256'] and row['started']==(not denied) and row['results']==int(not denied and not unknown) and (denied or row['dayBound'])):raise ValueError('REQUEST_SQL_PROOF')
            for receipt in o['reservations']:
                actual=json.loads(self.sql("select jsonb_build_object('ledger',ledger_id,'account',account_id,'day',account_day,'units',reserved_units,'unknown',unknown_at is not null,'settled',settled_at is not null,'input',input_tokens,'output',output_tokens,'pending',exists(select 1 from private.ai_budget_reservations where id=a.reservation_id))from private.ai_account_budget_reservations a where reservation_id="+quote(receipt['reservationId'])+'::uuid;'))
                charge=o.get('reportedCharge',2)
                if not(actual['ledger']==fixture['aiLedgerId'] and actual['account']==receipt['accountId'] and actual['day']==row['day'] and actual['units']==receipt['units'] and actual['unknown']==unknown and actual['settled']==(not unknown) and actual['pending']==unknown and (actual['input'],actual['output'])==((None,None)if unknown else(charge-1,1))):raise ValueError('RESERVATION_SQL_PROOF')
        for table in ('ai_chat_requests','ai_member_processing','ai_member_daily_usage','ai_budget_ledgers','ai_budget_reservations','ai_account_budget_reservations','ai_result_receipts'):
            if self.sql("select exists(select 1 from private."+table+" t where strpos(to_jsonb(t)::text,'AI_DIALOGUE_CANARY')>0);")!='f':raise ValueError('RAW_DIALOGUE_PERSISTED')

def product_graph():
    pending = [REPO/'backend/supabase/functions/ai-chat/index.ts']; found = {}
    while pending:
        path = pending.pop().resolve()
        if not path.is_relative_to(REPO/'backend/supabase/functions') or path.suffix != '.ts': raise ValueError('IMPORT_OUTSIDE_PRODUCT')
        if str(path.relative_to(REPO)) in found: continue
        data = path.read_bytes(); found[str(path.relative_to(REPO))] = hashlib.sha256(data).hexdigest()
        for local in re.findall(r'''(?:from\s*|import\s*)["'](\.[^"']+)["']''', data.decode()): pending.append((path.parent/local).resolve())
    return found

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--prepared-root',type=Path,required=True);parser.add_argument('--node',default=shutil.which('node'));parser.add_argument('--run',action='store_true')
    options=parser.parse_args()
    if not options.run:
        isolated_prepared_target(options.prepared_root)
        print(json.dumps({'status':'NOT_RUN','scope':'AI22_AI23_SYNTHETIC_FACTORY'}));return
    if not options.node or not Path(options.node).is_file():raise ValueError('NODE_REQUIRED')
    def stop(signum,frame):raise RuntimeError('OWN_PROCESS_TERMINATED')
    signal.signal(signal.SIGTERM,stop)
    runner=Runner(options.prepared_root);server=None;proof=[]
    try:
        runner.prepare();manifest=product_graph()
        class Bridge(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self): self.respond(False)
            def do_POST(self): self.respond(True)
            def respond(self,post):
                try:
                    token=self.headers.get('Authorization','').removeprefix('Bearer ')
                    if not post and self.path=='/auth/v1/user' and token in runner.tokens:
                        result={'id':runner.tokens[token],'role':'authenticated','is_anonymous':False}
                    elif post and self.path.startswith('/rest/v1/rpc/'):
                        size=int(self.headers.get('Content-Length','0'))
                        if not 0<size<=65536: raise ValueError('BODY_LIMIT')
                        result=runner.rpc(self.path.removeprefix('/rest/v1/rpc/'),json.loads(self.rfile.read(size)),token)
                    else: raise ValueError('BRIDGE_PATH')
                    body=json.dumps(result).encode();self.send_response(200)
                except Exception:
                    runner.failed=True;body=b'{"code":"ISOLATED_RPC_FAILED"}';self.send_response(500)
                self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        server=ThreadingHTTPServer(('127.0.0.1',0),Bridge);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        common={'codeRoot':str(REPO),'origin':'http://127.0.0.1:'+str(server.server_port),'anon':'synthetic-anon','service':'synthetic-service',
                'accounts':[{'userId':u,'token':t}for t,u in runner.tokens.items()], 'scenario':'ai-chat','productManifest':manifest,
                'aiQuery':'synthetic-absent-'+uuid.uuid4().hex.translate(str.maketrans('0123456789','ghijklmnop'))}
        def invoke(f,mode):
            if manifest!=product_graph():raise ValueError('PRODUCT_GRAPH_CHANGED')
            path=options.prepared_root/'ai-factory-fixture.json'
            fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'w')as stream:json.dump(f,stream)
            result=subprocess.run([options.node,'--experimental-strip-types',str(Path(__file__).with_suffix('.ts')).replace('isolated_ai_contracts.ts','isolated_ai_factory.ts'),str(path),mode],capture_output=True,timeout=150)
            if result.returncode:raise RuntimeError('FACTORY_FAILED_'+','.join(x.decode()for x in re.findall(rb'AI_CHECK_[A-Z_]+',result.stderr)))
            observed=json.loads(result.stdout)
            if runner.failed or observed['status']!='PASS' or observed['nativeExternalAttempts']!=0:raise ValueError('FACTORY_BRIDGE_FAILED')
            return observed
        for scenario in ('limits','caps'):
            ledger='synthetic-isolated-'+scenario+'-'+uuid.uuid4().hex;runner.ledgers.append(ledger)
            runner.sql('insert into private.ai_budget_ledgers(ledger_id,unit_limit,call_limit)values('+quote(ledger)+',100000000,1000);')
            f={**common,'aiLedgerId':ledger}
            if scenario=='limits':
                f['aiLimitsScenario']=True;initial=invoke(f,'--ai-limits')
                unknown=next(o for o in initial['observations']if o['case']=='unknown-provider-loss')['reservations'][0]['reservationId']
                before=runner.sql('select md5(to_jsonb(a)::text)from private.ai_account_budget_reservations a where reservation_id='+quote(unknown)+'::uuid and unknown_at is not null and settled_at is null;')
                recovery=invoke({**f,'aiLimitsRecovery':True},'--ai-limits')
                runner.prove(f,initial['observations']+recovery['observations'])
                if not before or before!=runner.sql('select md5(to_jsonb(a)::text)from private.ai_account_budget_reservations a where reservation_id='+quote(unknown)+'::uuid;'):raise ValueError('UNKNOWN_CHANGED')
                counts=json.loads(runner.sql('select json_agg(coalesce((select started_requests from private.ai_member_daily_usage d where d.user_id=x.id and kst_day=(clock_timestamp()at time zone\'Asia/Seoul\')::date),0)order by x.n)from unnest(array['+','.join(quote(u)+'::uuid'for u in runner.users)+'])with ordinality x(id,n);'))
                if counts!=[3,20,3]:raise ValueError('AI22_DAILY_COUNTS')
                proof.append({'scenario':'AI22','observations':len(initial['observations'])+len(recovery['observations']),'dailyCounts':counts,'unknownPreserved':True})
                # New synthetic members; natural existing AI22 budget receipts remain protected.
                runner.users=[str(uuid.uuid4())for _ in range(3)];runner.all_users.extend(runner.users)
                runner.tokens={f'synthetic.caps{i}.signature':u for i,u in enumerate(runner.users)}
                ids=','.join(quote(u)+'::uuid'for u in runner.users)
                runner.sql("begin;insert into auth.users(id)select unnest(array["+ids+"]);insert into public.profiles(id,real_name,birth_date,gender)select unnest(array["+ids+"]), '합성상한회원','1990-01-01'::date,'female';insert into private.ai_member_processing(user_id,exploration_allowed)select unnest(array["+ids+"]),true;commit;")
                common.update(accounts=[{'userId':u,'token':t}for t,u in runner.tokens.items()])
            else:
                day=runner.sql("select(clock_timestamp()at time zone'Asia/Seoul')::date;")
                balances=json.loads(runner.sql("select coalesce(jsonb_object_agg(account_id,reserved_units+charged_units),'{}'::jsonb)from private.ai_account_daily_budget where kst_day="+quote(day)+'::date;'))
                f.update(aiCapsScenario=True,aiCapDay=day,aiCapHeadroom={a:3200000-balances.get(a,0) for a in ['yumi','jonghyun','minkyu','sungho']},aiCapPhase='unknown')
                first=invoke(f,'--ai-caps');reservation=first['observations'][0]['reservations'][0]
                rid=reservation['reservationId'];before=runner.sql('select md5(to_jsonb(a)::text)from private.ai_account_budget_reservations a where reservation_id='+quote(rid)+'::uuid and unknown_at is not null and settled_at is null;')
                fill=invoke({**f,'aiCapPhase':'fill','aiCapUnknownUnits':reservation['units']},'--ai-caps')
                runner.prove(f,first['observations']+fill['observations'])
                if not before or before!=runner.sql('select md5(to_jsonb(a)::text)from private.ai_account_budget_reservations a where reservation_id='+quote(rid)+'::uuid;'):raise ValueError('CAP_UNKNOWN_CHANGED')
                bounds=runner.sql('select sum(reserved_units+charged_units)from private.ai_global_daily_budget;select min(reserved_units+charged_units),max(reserved_units+charged_units),count(*)from private.ai_account_daily_budget;')
                if bounds.splitlines()!=['12800000','3200000|3200000|4']:raise ValueError('AI23_BOUNDARIES')
                proof.append({'scenario':'AI23','observations':len(first['observations'])+len(fill['observations']),'globalCap':12800000,'eachAccountCap':3200000,'unknownPreserved':True})
        if manifest!=product_graph():raise ValueError('FINAL_PRODUCT_GRAPH_CHANGED')
    finally:
        if server:server.shutdown();server.server_close()
        runner.clean()
    print(json.dumps({'status':'PASS','checks':proof,'scope':'PRODUCT_HTTP_FACTORY_REAL_SQL_RPC_SYNTHETIC_AUTH_BRIDGE_AND_MODEL',
                      'actualAuthPostgrestNaver':'NOT_RUN','naturalMidnight':'NOT_RUN','externalProvider':'NOT_RUN','memberFixtureRowsRestored':True,'protectedBudgetMetadata':'PRESERVED_WITH_UNKNOWN','digestExcludesProtectedBudgetTables':True,'sequences':'NOT_VERIFIED'}))

if __name__=='__main__':
    try:main()
    except Exception as error:
        code=str(error)if re.fullmatch(r'[A-Z0-9_,]+',str(error))else'ISOLATED_AI_FAILED'
        print(json.dumps({'status':'FAIL','code':code}));sys.exit(1)
