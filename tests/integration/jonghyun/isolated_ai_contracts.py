"""Fresh prepared DB + product AI factory. 기본 Auth bridge는 합성이다.

Root executes explicitly. No old context/private fixture/provider is accessed.
서명 모드는 실제 로컬 Auth/REST와 합성 모델을 사용한다. AI24는 실행 전 NOT_RUN이다.
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
import base64
import stat
import time
import urllib.request
import urllib.error

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

SIGNED_KIND = 'SIGNED_LOCAL_AUTH_AI22_23'
PROTECTED_BUDGET = ('ai_budget_ledgers', 'ai_budget_reservations', 'ai_account_budget_reservations',
                    'ai_account_daily_budget', 'ai_global_daily_budget')

def signed_private_read(path):
    """비공개 입력의 링크·모드·열린 fd 신원을 검사한다. 도구/네트워크 호출 없음."""
    path = Path(path)
    if not path.is_absolute() or path != path.resolve(): raise ValueError('SIGNED_PRIVATE_PATH')
    for parent in path.parents:
        if parent == Path('/private/tmp') or parent == Path('/tmp').resolve(): break
        s = parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o700:
            raise ValueError('SIGNED_PRIVATE_DIRECTORY')
    else: raise ValueError('SIGNED_PRIVATE_ROOT')
    before = path.lstat()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        if (not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != os.getuid()
                or stat.S_IMODE(s.st_mode) != 0o600 or s.st_size > 2*1024*1024
                or (before.st_dev, before.st_ino) != (s.st_dev, s.st_ino)):
            raise ValueError('SIGNED_PRIVATE_FILE')
        with os.fdopen(os.dup(fd), 'rb') as f: data = f.read(2*1024*1024+1)
        after = os.fstat(fd)
        current = path.lstat()
        if (len(data) != s.st_size or (s.st_size, s.st_mtime_ns, s.st_ctime_ns) !=
                (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                or (current.st_dev, current.st_ino) != (s.st_dev, s.st_ino)):
            raise ValueError('SIGNED_PRIVATE_CHANGED')
        return data
    finally: os.close(fd)

def signed_claims(token):
    """선언 메타데이터만 읽는다. 실제 인증은 GoTrue와 REST가 검증한다."""
    if not isinstance(token, str) or len(token)>16384 or not re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', token):
        raise ValueError('SIGNED_TOKEN_SHAPE')
    try:
        part = token.split('.')[1]
        value = signed_exact_json(base64.urlsafe_b64decode(part + '='*((-len(part))%4)))
        if not isinstance(value, dict): raise ValueError()
        return value
    except Exception: raise ValueError('SIGNED_TOKEN_METADATA') from None

def signed_exact_json(data):
    def unique(pairs):
        result={}
        for key,value in pairs:
            if key in result:raise ValueError('SIGNED_DUPLICATE_JSON_KEY')
            result[key]=value
        return result
    return json.loads(data,object_pairs_hook=unique,parse_constant=lambda value:(_ for _ in()).throw(ValueError('SIGNED_JSON_CONSTANT')))

def signed_source_pins():
    paths = ('tests/integration/jonghyun/isolated_ai_contracts.py',
             'tests/integration/jonghyun/isolated_ai_factory.ts', 'tools/local/run_database_tests.py',
             'tools/local/prepare_database.py', 'tools/local/prepare_migrations.py',
             'tests/integration/minkyu/product_connection_restore108_local.py',
             'tests/integration/minkyu/member_cleanup_reconcile_local.py')
    return {**product_graph(), **{p: hashlib.sha256((REPO/p).read_bytes()).hexdigest() for p in paths}}

def validate_signed_binding(value, prepared_root, target, now=None):
    """로컬 입력만 허용한다. JWT claims 자체는 인증 증거가 아니다."""
    fields = {'version','kind','preparedRoot','databaseManifestSha256','origin','jwtIssuer','containers',
              'credentials','accounts','evidenceRoot','sourcePins','approvedByRoot','dockerSlotReady'}
    if not isinstance(value, dict) or set(value) != fields: raise ValueError('SIGNED_BINDING_FIELDS')
    if type(value['version']) is not int or value['version'] != 1 or value['kind'] != SIGNED_KIND:
        raise ValueError('SIGNED_BINDING_KIND')
    if value['preparedRoot'] != str(prepared_root): raise ValueError('SIGNED_PREPARED_ROOT')
    manifest = signed_private_read(Path(prepared_root)/'database-manifest.json')
    if value['databaseManifestSha256'] != hashlib.sha256(manifest).hexdigest():
        raise ValueError('SIGNED_MANIFEST_CHANGED')
    port = signed_exact_json(manifest)['config_overlay']['api.port']
    if type(port) is not int or value['origin'] != 'http://127.0.0.1:'+str(port):
        raise ValueError('SIGNED_LOOPBACK_ENDPOINT')
    if value['jwtIssuer'] != value['origin']+'/auth/v1': raise ValueError('SIGNED_ISSUER')
    if value['sourcePins'] != signed_source_pins(): raise ValueError('SIGNED_SOURCE_CHANGED')
    if any(type(value[k]) is not bool for k in ('approvedByRoot','dockerSlotReady')):
        raise ValueError('SIGNED_APPROVAL_TYPE')
    if not isinstance(value['containers'],dict) or set(value['containers']) != {'db','auth','rest','gateway'}:
        raise ValueError('SIGNED_CONTAINER_SET')
    names = {'db':'supabase_db_', 'auth':'supabase_auth_', 'rest':'supabase_rest_', 'gateway':'supabase_kong_'}
    ids = set()
    for kind, item in value['containers'].items():
        if not isinstance(item,dict) or set(item) != {'id','name','image','configSha256','hostConfigSha256','mountsSha256'}:
            raise ValueError('SIGNED_CONTAINER_FIELDS')
        if item['name'] != names[kind]+target['project'] or not re.fullmatch(r'[a-f0-9]{64}',item['id']):
            raise ValueError('SIGNED_CONTAINER_ID')
        if not re.fullmatch(r'sha256:[a-f0-9]{64}',item['image']): raise ValueError('SIGNED_IMAGE')
        if any(not re.fullmatch(r'[a-f0-9]{64}',item[k]) for k in ('configSha256','hostConfigSha256','mountsSha256')):
            raise ValueError('SIGNED_CONFIG_HASH')
        if item['id'] in ids: raise ValueError('SIGNED_DUPLICATE_CONTAINER')
        ids.add(item['id'])
    if value['containers']['db']['id'] != target['id'] or value['containers']['db']['image'] != target['image']:
        raise ValueError('SIGNED_DATABASE_ID')
    if not isinstance(value['credentials'],dict) or set(value['credentials']) != {'anon','service'}:
        raise ValueError('SIGNED_CREDENTIAL_FIELDS')
    for key, role in (('anon','anon'),('service','service_role')):
        if signed_claims(value['credentials'][key]).get('role') != role: raise ValueError('SIGNED_CREDENTIAL_ROLE')
    now = time.time() if now is None else now
    if not isinstance(value['accounts'],list) or len(value['accounts']) != 6: raise ValueError('SIGNED_SIX_ACCOUNTS')
    users, sessions = set(), set()
    for a in value['accounts']:
        if not isinstance(a,dict) or set(a) != {'userId','sessionId','accessToken','expiresAt','authEmail'}:
            raise ValueError('SIGNED_ACCOUNT_FIELDS')
        for key in ('userId','sessionId'):
            try:
                if str(uuid.UUID(a[key])) != a[key]: raise ValueError()
            except Exception: raise ValueError('SIGNED_CANONICAL_ID') from None
        c = signed_claims(a['accessToken'])
        if (c.get('sub') != a['userId'] or c.get('session_id') != a['sessionId'] or c.get('iss') != value['jwtIssuer']
                or c.get('role') != 'authenticated' or c.get('is_anonymous') is True
                or type(c.get('exp')) is not int or type(a['expiresAt']) is not int
                or c['exp'] != a['expiresAt'] or c['exp'] <= now+300
                or c.get('email') != a['authEmail']
                or not re.fullmatch(r'synthetic-ai-[a-z0-9-]+@example\.invalid',a['authEmail'])):
            raise ValueError('SIGNED_ACCOUNT_METADATA')
        if a['userId'] in users or a['sessionId'] in sessions: raise ValueError('SIGNED_DUPLICATE_ACCOUNT')
        users.add(a['userId']); sessions.add(a['sessionId'])
    e = Path(value['evidenceRoot'])
    if (not e.is_absolute() or e != e.resolve() or e.parent != Path(prepared_root)
            or not re.fullmatch(r'signed-auth-[a-f0-9]{32}',e.name)):
        raise ValueError('SIGNED_EVIDENCE_ROOT')
    return value

def signed_prepared_target(prepared_root):
    """기존 overlay와 이력 계약을 유지하며 명시된 소유 socket만 허용한다."""
    from prepare_database import isolated_config
    from prepare_migrations import inspect_migrations
    root=Path(prepared_root)
    manifest=signed_exact_json(signed_private_read(root/'database-manifest.json'))
    intent=signed_exact_json(signed_private_read(root/'execution-intent.json'))
    overlay=manifest['config_overlay'];source=(REPO/'backend/supabase/config.toml').read_bytes()
    config=signed_private_read(root/'supabase/config.toml')
    expected,expected_overlay=isolated_config(source,overlay['project_id'],overlay['api.port'])
    if (config!=expected or overlay!=expected_overlay or manifest['config_sha256']!=hashlib.sha256(config).hexdigest()
            or manifest['source_config_sha256']!=hashlib.sha256(source).hexdigest() or manifest['sql_execution']!='NOT_RUN'):
        raise ValueError('SIGNED_PREPARED_CONFIG')
    history=inspect_migrations(REPO)
    if manifest['migrations']!=history['migrations']:raise ValueError('SIGNED_PREPARED_HISTORY')
    entries=history['migrations'];directory=root/'supabase/migrations'
    if {p.name for p in directory.iterdir()}!={Path(e['path']).name for e in entries}:raise ValueError('SIGNED_PREPARED_SQL_SET')
    for e in entries:
        if hashlib.sha256(signed_private_read(directory/Path(e['path']).name)).hexdigest()!=e['sha256']:raise ValueError('SIGNED_PREPARED_SQL')
    profiles={'colima-yumidang-minkyu':'yumidang-minkyu','colima-jonghyun-backend100':'jonghyun-backend100'}
    context=intent.get('context');profile=profiles.get(context)
    host='unix://'+str(Path.home()/'.colima'/str(profile)/'docker.sock')
    if (profile is None or intent.get('dockerHost')!=host or intent.get('project')!=overlay['project_id']
            or intent.get('scope')!='new-synthetic-only' or intent.get('existingContainers')!=[] or intent.get('existingNetworks')!=[]):
        raise ValueError('SIGNED_PREPARED_AUTHORITY')
    owned=signed_exact_json(signed_private_read(root/'owned-containers.json'))
    matching=[x for x in owned if x.get('name')=='supabase_db_'+overlay['project_id']]
    if len(matching)!=1 or not re.fullmatch(r'[a-f0-9]{64}',matching[0]['id']) or not re.fullmatch(r'sha256:[a-f0-9]{64}',matching[0]['image']):
        raise ValueError('SIGNED_PREPARED_DB')
    item=matching[0]
    return {'context':context,'host':host,'project':overlay['project_id'],'container':item['name'],'id':item['id'],'image':item['image'],'versions':[e['version']for e in entries]}

def inspect_signed_binding(binding_path, prepared_root):
    """비공개 fd로 읽은 원 바이트를 묶는다. 실행·인증 승인은 반환하지 않는다."""
    data=signed_private_read(binding_path)
    target=signed_prepared_target(prepared_root)
    value=validate_signed_binding(signed_exact_json(data),Path(prepared_root),target)
    return {'bindingSha256':hashlib.sha256(data).hexdigest(),'scope':SIGNED_KIND,'preparedRoot':value['preparedRoot'],
            'databaseManifestSha256':value['databaseManifestSha256'],'containerIds':{k:v['id']for k,v in value['containers'].items()},
            'declaredExpiresAt':[a['expiresAt']for a in value['accounts']],'executionAllowed':False,'actualAuth':'NOT_RUN'}

NATIVE_SIGNED_SOURCE_STATE=Path('/private/tmp/yumidang-native119-full-identities-20261013-t1_ooz8b/state-before-private.json')
NATIVE_SIGNED_SOURCE_STATE_SHA='5cb91cff88044b86375acacc9a9e1f37e939594225058527ffabaddd2d3606d2'
NATIVE_SIGNED_CANONICAL_ROOT=Path('/private/tmp/yumidang-canonical-application-20261010-canonical-v1')
NATIVE_SIGNED_CANONICAL_RECEIPT_SHA='fafeb72231850417dde552c00c39bb759baa536eacc5fcfb8e2cbf8551b20d4d'
NATIVE_SIGNED_APPLIED_INVENTORY_SHA='e879b213c91b4da96479322896bc33fb6f216b4f297f1382f2f90c907d7e1c10'
NATIVE_SIGNED_APPLIED_FILE_MAP_SHA='da62068194236f19e442d17a08807f15e93653f1893cb529e25444174dd7218b'
NATIVE_SIGNED_SOURCE_ID='497e5d1bc98835d4074a2fbb7ccb37575d539984c18f571d38b6d8fbec692c2f'

def signed_native_selected(relative, names, pins, namespace):
    """현재 검토·커밋된 고정 helper의 지정 함수만 평가한다."""
    import ast
    path=REPO/relative;captured=path.read_bytes()
    if hashlib.sha256(captured).hexdigest()!=pins.get(relative):raise ValueError('SIGNED_NATIVE_HELPER_PIN_CHANGED')
    committed=subprocess.run(['git','-C',str(REPO),'show','HEAD:'+relative],capture_output=True,timeout=5)
    if committed.returncode or committed.stdout!=captured:raise ValueError('SIGNED_NATIVE_HELPER_UNCOMMITTED')
    nodes=[node for node in ast.parse(captured).body if isinstance(node,ast.FunctionDef)and node.name in names]
    if len(nodes)!=len(names)or{node.name for node in nodes}!=set(names):raise ValueError('SIGNED_NATIVE_HELPER_FUNCTIONS')
    exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),namespace)
    return namespace

def signed_verify_history(runner):
    """일반 DB 이력과 고정 native119 원 영수증을 별도 증거로 검증한다."""
    path=runner.root/'native119-runtime-provenance.json'
    if not path.exists()and not path.is_symlink():
        if json.loads(runner.sql('select json_agg(version order by version)from supabase_migrations.schema_migrations;'))!=runner.target['versions']:
            raise ValueError('APPLIED_HISTORY_CHANGED')
        return {'method':'SUPABASE_DB_HISTORY','native':'NOT_RUN'}
    provenance=signed_exact_json(signed_private_read(path))
    fields={'version','kind','preparedRoot','preparedManifestSha256','sourceStatePath','sourceStateSha256',
        'canonicalRoot','canonicalReceiptSha256','canonicalAppliedInventorySha256','canonicalAppliedFileMapSha256',
        'sourceCatalogSha256','sourcePortableRolesSha256','cloneBaselineStateSha256','database','creatorCodeSha256'}
    if (not isinstance(provenance,dict)or set(provenance)!=fields or type(provenance['version'])is not int
            or provenance['version']!=1 or provenance['kind']!='NATIVE119_RUNTIME_PROVENANCE'
            or provenance['preparedRoot']!=str(runner.root)):raise ValueError('SIGNED_NATIVE_PROVENANCE_FIELDS')
    fixed={'sourceStatePath':str(NATIVE_SIGNED_SOURCE_STATE),'sourceStateSha256':NATIVE_SIGNED_SOURCE_STATE_SHA,
        'canonicalRoot':str(NATIVE_SIGNED_CANONICAL_ROOT),'canonicalReceiptSha256':NATIVE_SIGNED_CANONICAL_RECEIPT_SHA,
        'canonicalAppliedInventorySha256':NATIVE_SIGNED_APPLIED_INVENTORY_SHA,'canonicalAppliedFileMapSha256':NATIVE_SIGNED_APPLIED_FILE_MAP_SHA,
        'cloneBaselineStateSha256':NATIVE_SIGNED_SOURCE_STATE_SHA}
    if any(provenance[k]!=v for k,v in fixed.items()):raise ValueError('SIGNED_NATIVE_FIXED_PROOF')
    if provenance['database']!=runner.binding['containers']['db']:raise ValueError('SIGNED_NATIVE_DATABASE_BINDING')
    if not isinstance(provenance['creatorCodeSha256'],str)or not re.fullmatch('[a-f0-9]{64}',provenance['creatorCodeSha256']):raise ValueError('SIGNED_NATIVE_CREATOR_METADATA')
    canonical=lambda value:json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
    digest=lambda value:hashlib.sha256(canonical(value)).hexdigest()
    manifest_raw=signed_private_read(runner.root/'database-manifest.json')
    if provenance['preparedManifestSha256']!=hashlib.sha256(manifest_raw).hexdigest():raise ValueError('SIGNED_NATIVE_MANIFEST_BINDING')
    manifest=signed_exact_json(manifest_raw);entries=manifest['migrations']
    receipt_raw=signed_private_read(NATIVE_SIGNED_CANONICAL_ROOT/'receipt.json')
    if hashlib.sha256(receipt_raw).hexdigest()!=NATIVE_SIGNED_CANONICAL_RECEIPT_SHA:raise ValueError('SIGNED_NATIVE_CANONICAL_RECEIPT')
    receipt=signed_exact_json(receipt_raw)
    if (receipt.get('status')!='PASS_NATIVE_CANONICAL_119_APPLICATION_ONLY'or receipt.get('migrationCount')!=119
            or receipt.get('nativeDbId')!=NATIVE_SIGNED_SOURCE_ID or receipt.get('orderedAppliedMigrations')!=entries
            or len(entries)!=119 or [e['version']for e in entries]!=runner.target['versions']):raise ValueError('SIGNED_NATIVE_ORDERED119')
    files=sorted(NATIVE_SIGNED_CANONICAL_ROOT.glob('*-applied.json'));inventory=[];file_map={}
    if len(files)!=119 or [p.name for p in files]!=[e['version']+'-applied.json'for e in entries]:raise ValueError('SIGNED_NATIVE_APPLIED_SET')
    for file,entry in zip(files,entries):
        raw=signed_private_read(file);value=signed_exact_json(raw);sha=hashlib.sha256(raw).hexdigest()
        if (set(value)!={'commandExit','nativeDbId','sha256','storedIn','version'}or type(value['commandExit'])is not int
                or value['commandExit']!=0 or value['nativeDbId']!=NATIVE_SIGNED_SOURCE_ID or value['sha256']!=entry['sha256']
                or value['version']!=entry['version']or value['storedIn']!='PRIVATE_RECEIPT_NOT_DB_HISTORY'):raise ValueError('SIGNED_NATIVE_APPLIED_RECEIPT')
        file_map[file.name]=sha;inventory.append({'receipt':file.name,'version':value['version'],'sqlSha256':value['sha256'],'commandExit':0,'receiptSha256':sha})
    if digest(inventory)!=NATIVE_SIGNED_APPLIED_INVENTORY_SHA or digest(file_map)!=NATIVE_SIGNED_APPLIED_FILE_MAP_SHA:raise ValueError('SIGNED_NATIVE_APPLIED_DIGEST')
    pins=signed_source_pins()
    if pins!=runner.binding['sourcePins']:raise ValueError('SIGNED_NATIVE_SOURCE_PINS')
    namespace=signed_native_selected('tests/integration/minkyu/product_connection_restore108_local.py',{'platform_open'},pins,{'__builtins__':__builtins__})
    with namespace['platform_open'](NATIVE_SIGNED_SOURCE_STATE)as stream:
        before=os.fstat(stream.fileno());raw=stream.read(64*1024*1024+1);after=os.fstat(stream.fileno());current=NATIVE_SIGNED_SOURCE_STATE.lstat()
        identity=lambda value:(value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns,value.st_nlink)
        if (len(raw)>64*1024*1024 or len(raw)!=before.st_size or identity(before)!=identity(after)or identity(after)!=identity(current)
                or hashlib.sha256(raw).hexdigest()!=NATIVE_SIGNED_SOURCE_STATE_SHA):raise ValueError('SIGNED_NATIVE_SOURCE_STATE_CHANGED')
    state=signed_exact_json(raw);snapshot=state['snapshot'];schema=snapshot['catalog'];roles=snapshot['roles']
    if (len(snapshot['rows'])!=178 or provenance['sourceCatalogSha256']!=hashlib.sha256(schema.encode()).hexdigest()
            or provenance['sourcePortableRolesSha256']!=digest(roles)):raise ValueError('SIGNED_NATIVE_SOURCE_METADATA')
    from types import SimpleNamespace
    def read_query(name,statement):
        if name!=runner.target['id']:raise ValueError('SIGNED_NATIVE_QUERY_TARGET')
        command=runner.base+['exec','-i',name,'psql','-XqAt','-h','/var/run/postgresql','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1','-f','-']
        result=subprocess.run(command,input=("begin read only;set local statement_timeout='5s';set local lock_timeout='1s';"+statement+'commit;').encode(),capture_output=True,timeout=5)
        if result.returncode:raise ValueError('SIGNED_NATIVE_SCHEMA_ROLE_READ_FAILED')
        return result.stdout
    def read_dump(argv,data=None):
        expected=runner.base+['exec',runner.target['id'],'pg_dump','-U','supabase_admin','-d','postgres','--schema-only']
        if argv!=expected or data is not None:raise ValueError('SIGNED_NATIVE_SCHEMA_DUMP_SCOPE')
        command=runner.base+['exec','-e','PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000',runner.target['id'],
            'pg_dump','-h','/var/run/postgresql','-U','supabase_admin','-d','postgres','--schema-only']
        result=subprocess.run(command,capture_output=True,timeout=5)
        if result.returncode:raise ValueError('SIGNED_NATIVE_SCHEMA_ROLE_READ_FAILED')
        return result.stdout
    namespace=signed_native_selected('tests/integration/minkyu/member_cleanup_reconcile_local.py',{'catalog','roles'},pins,
        {'json':json,'tls':SimpleNamespace(DOCKER=runner.base),'recovery':SimpleNamespace(BOOT='supabase_admin'),'query':read_query,'call':read_dump})
    current_schema=namespace['catalog'](runner.target['id']);current_roles=namespace['roles'](runner.target['id'])
    for role in current_roles['roles']:role.pop('oid',None)
    if current_schema!=schema or current_roles!=roles:raise ValueError('SIGNED_NATIVE_CURRENT_SCHEMA_ROLES_CHANGED')
    runner.signed_identity()
    return {'method':'PINNED_NATIVE119_RECEIPTS_AND_CURRENT_SCHEMA_ROLES','scope':'NATIVE119_SCHEMA_ROLE_MATCH_LINEAGE',
        'migrationReplay':'NOT_RUN','authRows':'PROVISIONING_JOURNAL_SEPARATE','actualNaver':'NOT_RUN'}

class SignedRunner(Runner):
    def __init__(self, root, binding):
        self.root=root;self.target=signed_prepared_target(root)
        self.base=['docker','--host',self.target['host']]
        self.days=set();self.ledgers=[];self.changed=False;self.failed=False
        self.binding = binding
        self.users = [a['userId'] for a in binding['accounts'][:3]]
        self.all_users = [a['userId'] for a in binding['accounts']]
        self.tokens = {a['accessToken']:a['userId'] for a in binding['accounts']}
        self.evidence = Path(binding['evidenceRoot'])

    def save_signed(self, name, value):
        if not re.fullmatch(r'[a-z0-9-]+\.json',name): raise ValueError('SIGNED_ARTIFACT_NAME')
        fd = os.open(self.evidence/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as f: json.dump(value,f,sort_keys=True);f.flush();os.fsync(f.fileno())
        for p in (self.evidence,self.evidence.parent):
            fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY)
            try: os.fsync(fd)
            finally: os.close(fd)

    def signed_identity(self):
        self.identity()
        owned = signed_exact_json(signed_private_read(self.root/'owned-containers.json'))
        canon=lambda v:json.dumps(v,sort_keys=True,separators=(',',':')).encode()
        for item in self.binding['containers'].values():
            if not any(x['id']==item['id'] and x['name']==item['name'] and x['image']==item['image'] for x in owned):
                raise ValueError('SIGNED_NOT_PREPARED_OWNED')
            v=json.loads(self.call(['inspect',item['id']]))[0]
            if (v['Id']!=item['id'] or v['Name']!='/'+item['name'] or v['Image']!=item['image']
                    or not v['State']['Running'] or v['State']['OOMKilled']
                    or v['Config']['Labels'].get('com.supabase.cli.project')!=self.target['project']):
                raise ValueError('SIGNED_LIVE_IDENTITY')
            for field,key in (('Config','configSha256'),('HostConfig','hostConfigSha256'),('Mounts','mountsSha256')):
                raw=v[field] if field!='Mounts' else sorted(v[field],key=lambda x:canon(x))
                if hashlib.sha256(canon(raw)).hexdigest()!=item[key]: raise ValueError('SIGNED_LIVE_CONFIG')

    def auth_user(self, token):
        # Exact loopback URL; redirect following and ambient proxy lookup are disabled.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args): return None
        request=urllib.request.Request(self.binding['origin']+'/auth/v1/user',method='GET',
            headers={'Authorization':'Bearer '+token,'apikey':self.binding['credentials']['anon']})
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        try:
            with opener.open(request,timeout=5) as response:
                data=response.read(65537)
                if response.status!=200 or len(data)>65536: raise ValueError('SIGNED_AUTH_RESPONSE')
                return json.loads(data)
        except Exception: raise ValueError('SIGNED_AUTH_VERIFY_FAILED') from None

    def prepare(self):
        self.signed_identity()
        signed_verify_history(self)
        if self.sql("select external_processing_allowed from private.ai_processing_guard where singleton;select current_setting('cron.launch_active_jobs');").splitlines()!=['f','off']:
            raise ValueError('SIGNED_CLOSED_BASELINE_REQUIRED')
        if self.sql("select(select count(*)from private.ai_account_daily_budget where kst_day=(clock_timestamp()at time zone'Asia/Seoul')::date)+(select count(*)from private.ai_global_daily_budget where kst_day=(clock_timestamp()at time zone'Asia/Seoul')::date);")!='0':
            raise ValueError('SIGNED_FRESH_CURRENT_DAY_REQUIRED')
        for a in self.binding['accounts']:
            actual=self.auth_user(a['accessToken'])
            if actual.get('id')!=a['userId'] or actual.get('role')!='authenticated' or actual.get('is_anonymous') is True:
                raise ValueError('SIGNED_AUTH_IDENTITY')
            uid=quote(a['userId'])+'::uuid'
            if self.sql('select exists(select 1 from auth.users u join auth.sessions s on s.user_id=u.id join public.profiles p on p.id=u.id where u.id='+uid+' and s.id='+quote(a['sessionId'])+'::uuid and u.email='+quote(a['authEmail'])+' and not u.is_anonymous);')!='t':
                raise ValueError('SIGNED_DATABASE_SESSION')
            if self.sql('select (select count(*)from private.ai_member_processing where user_id='+uid+')+(select count(*)from private.ai_member_daily_usage where user_id='+uid+')+(select count(*)from private.ai_chat_requests where user_id='+uid+')+(select count(*)from private.ai_result_receipts where user_id='+uid+');')!='0':
                raise ValueError('SIGNED_FRESH_MEMBER_AI_REQUIRED')
        self.baseline=self.digest()
        self.protected=self.protected_rows()
        self.accounts=json.loads(self.sql('select json_agg(to_jsonb(a)order by account_id)from private.ai_budget_accounts a;'))
        if {a['account_id'] for a in self.accounts}!={'yumi','jonghyun','minkyu','sungho'} or any(a['unit_limit']!=3200000 for a in self.accounts):
            raise ValueError('SIGNED_ACCOUNT_POLICY')
        self.catalog=self.sql("select md5(coalesce(string_agg(to_jsonb(p)::text,E'\\n' order by p.oid),''))from pg_proc p where pronamespace in('public'::regnamespace,'private'::regnamespace);select md5(coalesce(string_agg(to_jsonb(r)::text,E'\\n' order by oid),''))from pg_roles r;")
        self.save_signed('activation-intent.json',{'sourcePins':signed_source_pins(),'oldProtectedRowsSha256':hashlib.sha256(json.dumps(self.protected,sort_keys=True).encode()).hexdigest(),'accounts':self.all_users,'noAuthLifecycleMutation':True})
        self.changed=True
        ids=','.join(quote(u)+'::uuid' for u in self.all_users)
        self.sql("begin;insert into private.ai_member_processing(user_id,exploration_allowed)select unnest(array["+ids+"]),true;update private.ai_budget_accounts set registered=true;update private.ai_processing_guard set external_processing_allowed=true where singleton;commit;")

    def protected_rows(self):
        return {t:json.loads(self.sql("select coalesce(jsonb_object_agg(id,h),'{}'::jsonb)from(select md5(to_jsonb(r)::text)id,md5(to_jsonb(r)::text)h from private."+t+' r)s;')) for t in PROTECTED_BUDGET}

    def clean(self):
        if not self.changed:return
        errors=[]
        def attempt(operation):
            try:operation()
            except Exception as e:errors.append(type(e).__name__)
        attempt(lambda:self.sql('update private.ai_processing_guard set external_processing_allowed=false where singleton;'))
        ids=','.join(quote(u)+'::uuid' for u in self.all_users)
        attempt(lambda:self.sql('begin;'+''.join('delete from private.'+t+' where user_id in('+ids+');' for t in ('ai_result_receipts','ai_chat_requests','ai_member_daily_usage','ai_member_processing'))+'commit;'))
        for a in self.accounts:
            attempt(lambda a=a:self.sql('update private.ai_budget_accounts set registered='+('true' if a['registered'] else 'false')+' where account_id='+quote(a['account_id'])+';'))
        def verify():
            current=self.protected_rows()
            if any(not set(self.protected[t]).issubset(current[t]) for t in PROTECTED_BUDGET):raise ValueError('SIGNED_OLD_PROTECTED_ROWS_CHANGED')
            if self.digest()!=self.baseline:raise ValueError('SIGNED_BASELINE_CHANGED')
            catalog=self.sql("select md5(coalesce(string_agg(to_jsonb(p)::text,E'\\n' order by p.oid),''))from pg_proc p where pronamespace in('public'::regnamespace,'private'::regnamespace);select md5(coalesce(string_agg(to_jsonb(r)::text,E'\\n' order by oid),''))from pg_roles r;")
            if catalog!=self.catalog:raise ValueError('SIGNED_CATALOG_CHANGED')
            self.signed_identity()
        attempt(verify)
        self.save_signed('cleanup.json',{'status':'FAIL' if errors else 'PASS','fixedFailureTypes':errors,'authLifecycleMutation':False,'originalProtectedRowsPreserved':not errors,'protectedBudgetDelta':'COMMITTED_NOT_ROLLED_BACK','sequence':'NOT_VERIFIED','ownedContainerLifecycle':'UNCHANGED'})
        if errors:raise ValueError('SIGNED_CLEANUP_FAILED')

def signed_negative_receipt(value):
    """실제 거절 결과와 아직 실행하지 않은 수명주기 검증을 함께 보존한다."""
    coverage=('expiredBearer','revokedSession','anonymousBearer','memberChanged','differentOriginalContext')
    if not isinstance(value,dict)or value.get('status')!='PASS' or type(value.get('nativeExternalAttempts'))is not int or value.get('nativeExternalAttempts')!=0:
        raise ValueError('SIGNED_NEGATIVE_PROOF')
    cases=value.get('cases')
    expected={'missing':0,'malformed':0,'invalid_signature':1,'service_principal':0}
    if not isinstance(cases,list)or len(cases)!=4:raise ValueError('SIGNED_NEGATIVE_CASES')
    seen=set()
    for item in cases:
        if not isinstance(item,dict)or set(item)!={'case','status','httpStatus','actualAuthReads','rpcCalls','providerCalls'}:
            raise ValueError('SIGNED_NEGATIVE_CASES')
        name=item['case']
        if name not in expected or name in seen or item['status']!='PASS' or type(item['httpStatus'])is not int or item['httpStatus']!=401:
            raise ValueError('SIGNED_NEGATIVE_CASES')
        if type(item['actualAuthReads'])is not int or item['actualAuthReads']!=expected[name]or type(item['rpcCalls'])is not int or item['rpcCalls']!=0 or type(item['providerCalls'])is not int or item['providerCalls']!=0:
            raise ValueError('SIGNED_NEGATIVE_EFFECTS')
        seen.add(name)
    # 현재 네 검사만으로 실제 만료·철회·익명·회원 변경·다른 발급 문맥을 승격하지 않는다.
    if any(value.get(key)!='NOT_RUN'for key in coverage):raise ValueError('SIGNED_NEGATIVE_COVERAGE')
    return {'scenario':'SIGNED_AUTH_NEGATIVE','cases':cases,**{key:value[key]for key in coverage},
            'fullLifecycleCoverage':'NOT_RUN','nativeExternalAttempts':0}

def signed_main():
    parser=argparse.ArgumentParser();parser.add_argument('--signed-local-auth','--signed-auth',action='store_true',required=True)
    parser.add_argument('--signed-auth-input','--signed-auth-binding',type=Path);parser.add_argument('--prepared-root',type=Path,required=True)
    parser.add_argument('--node',default=shutil.which('node'));parser.add_argument('--run',action='store_true')
    o=parser.parse_args()
    if not o.signed_auth_input or not o.run:
        print(json.dumps({'status':'NOT_RUN','scope':SIGNED_KIND,'privateInputRequired':True,'actualCalls':0}));return
    target=signed_prepared_target(o.prepared_root)
    b=validate_signed_binding(signed_exact_json(signed_private_read(o.signed_auth_input)),o.prepared_root,target)
    if not b['approvedByRoot'] or not b['dockerSlotReady']:raise ValueError('SIGNED_APPROVAL_SLOT_REQUIRED')
    if not o.node or not Path(o.node).is_file():raise ValueError('NODE_REQUIRED')
    Path(b['evidenceRoot']).mkdir(mode=0o700,exist_ok=False)
    r=SignedRunner(o.prepared_root,b);proof=[]
    def interrupted(*args):raise RuntimeError('SIGNED_OWN_PROCESS_TERMINATED')
    signal.signal(signal.SIGTERM,interrupted)
    def invoke(f,mode):
        validate_signed_binding(b,o.prepared_root,target);r.signed_identity()
        key=uuid.uuid4().hex;r.save_signed('fixture-'+key+'.json',f)
        argv=[o.node,'--experimental-strip-types',str(Path(__file__).with_name('isolated_ai_factory.ts')),str(r.evidence/('fixture-'+key+'.json')),mode]
        r.save_signed('node-'+key+'-intent.json',{'singleLaunch':True,'argvSha256':hashlib.sha256(json.dumps(argv).encode()).hexdigest()})
        p=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            out,err=p.communicate(timeout=150)
            fixed=err.decode('utf-8','replace').strip()
            r.save_signed('node-'+key+'-result.json',{'exitCode':p.returncode,'stdoutSha256':hashlib.sha256(out).hexdigest(),
                'stderrSha256':hashlib.sha256(err).hexdigest(),'fixedFactoryCode':fixed if re.fullmatch(r'AI_CHECK_[A-Z_]+',fixed)else None})
            if p.returncode or len(out)>2*1024*1024:raise ValueError('SIGNED_FACTORY_FAILED')
            v=json.loads(out)
            if v['status']!='PASS' or v['nativeExternalAttempts']!=0:raise ValueError('SIGNED_FACTORY_PROOF')
            return v
        finally:
            if p.poll() is None:
                p.terminate()
                try:p.communicate(timeout=5)
                except subprocess.TimeoutExpired:p.kill();p.communicate(timeout=5)
            r.save_signed('node-'+key+'-closed.json',{'exited':p.poll() is not None,'exitCode':p.returncode,'signalsOnlyExactPopenObject':True})
    try:
        r.prepare()
        common={'codeRoot':str(REPO),'origin':b['origin'],'anon':b['credentials']['anon'],'service':b['credentials']['service'],'signedLocalAuth':True,
                'accounts':[{'userId':a['userId'],'token':a['accessToken']}for a in b['accounts'][:3]],'scenario':'ai-chat',
                'productManifest':product_graph(),'aiQuery':'synthetic-absent-'+uuid.uuid4().hex}
        negative=invoke(common,'--signed-auth-negative');proof.append(signed_negative_receipt(negative))
        for label in ('limits','caps'):
            ledger='synthetic-signed-'+label+'-'+uuid.uuid4().hex;r.ledgers.append(ledger)
            r.save_signed('ledger-'+label+'-intent.json',{'ledgerId':ledger,'noReplay':True})
            r.sql('insert into private.ai_budget_ledgers(ledger_id,unit_limit,call_limit)values('+quote(ledger)+',100000000,1000);')
            f={**common,'aiLedgerId':ledger}
            if label=='limits':
                f['aiLimitsScenario']=True;first=invoke(f,'--ai-limits');r.prove(f,first['observations'])
                before=r.protected_rows();second=invoke({**f,'aiLimitsRecovery':True},'--ai-limits');r.prove(f,second['observations'])
                after=r.protected_rows()
                if any(not set(before[t]).issubset(after[t]) for t in PROTECTED_BUDGET[1:3]):raise ValueError('SIGNED_UNKNOWN_CHANGED')
                counts=json.loads(r.sql("select json_agg(coalesce((select started_requests from private.ai_member_daily_usage d where d.user_id=x.id and kst_day=(clock_timestamp()at time zone'Asia/Seoul')::date),0)order by x.n)from unnest(array["+','.join(quote(u)+'::uuid' for u in r.users)+'])with ordinality x(id,n);'))
                if counts!=[3,20,3]:raise ValueError('SIGNED_DAILY_COUNTS')
                proof.append({'scenario':'AI22','observations':len(first['observations'])+len(second['observations']),'dailyCounts':counts})
                common['accounts']=[{'userId':a['userId'],'token':a['accessToken']}for a in b['accounts'][3:]]
            else:
                day=r.sql("select(clock_timestamp()at time zone'Asia/Seoul')::date;")
                balances=json.loads(r.sql("select coalesce(jsonb_object_agg(account_id,reserved_units+charged_units),'{}'::jsonb)from private.ai_account_daily_budget where kst_day="+quote(day)+'::date;'))
                f.update(aiCapsScenario=True,aiCapDay=day,aiCapHeadroom={a:3200000-balances.get(a,0)for a in ('yumi','jonghyun','minkyu','sungho')},aiCapPhase='unknown')
                if any(v<=0 for v in f['aiCapHeadroom'].values()):raise ValueError('SIGNED_NATURAL_HEADROOM_REQUIRED')
                first=invoke(f,'--ai-caps');r.prove(f,first['observations']);before=r.protected_rows()
                second=invoke({**f,'aiCapPhase':'fill','aiCapUnknownUnits':first['observations'][0]['reservations'][0]['units']},'--ai-caps');r.prove(f,second['observations'])
                after=r.protected_rows()
                if any(not set(before[t]).issubset(after[t]) for t in PROTECTED_BUDGET[1:3]):raise ValueError('SIGNED_UNKNOWN_CHANGED')
                if r.sql('select reserved_units+charged_units from private.ai_global_daily_budget where kst_day='+quote(day)+'::date;')!='12800000':raise ValueError('SIGNED_GLOBAL_CAP')
                proof.append({'scenario':'AI23','observations':len(first['observations'])+len(second['observations'])})
        if b['sourcePins']!=signed_source_pins():raise ValueError('SIGNED_FINAL_SOURCE_CHANGED')
    except Exception as error:
        code=str(error)if re.fullmatch(r'[A-Z0-9_,]+',str(error))else'SIGNED_EXECUTION_FAILED'
        r.save_signed('failure.json',{'status':'FAIL','scope':SIGNED_KIND,'fixedCode':code,'retryAllowed':False})
        raise
    finally:r.clean()
    result={'status':'PASS','scope':SIGNED_KIND,'checks':proof,'actualAuthPostgrest':'PASS','actualNaver':'NOT_RUN','externalProvider':'NOT_RUN','tls':'NOT_RUN_LOCAL_HTTP','naturalMidnight':'NOT_RUN','originalProtectedRowsPreserved':True,'authFixtureBaselinePreserved':True}
    r.save_signed('receipt.json',result);print(json.dumps(result))

class SignedMidnightRunner(SignedRunner):
    """AI24 조립용 고정 포트. 생성·재기동·자정 대기·승인은 호출자가 담당한다."""
    def __init__(self, prepared_root, binding, member_ids, evidence_root, scope_id, boundary_epoch):
        super().__init__(Path(prepared_root),binding)
        validate_signed_binding(binding,self.root,self.target)
        known={a['userId']:a for a in binding['accounts']}
        if not isinstance(member_ids,list) or len(member_ids)!=3 or len(set(member_ids))!=3 or any(u not in known for u in member_ids):
            raise ValueError('MIDNIGHT_EXPLICIT_THREE_MEMBERS')
        root=Path(evidence_root)
        if (not root.is_absolute() or root!=root.resolve() or root==Path(binding['evidenceRoot'])
                or not root.is_relative_to(Path('/private/tmp')) or root.is_relative_to(REPO)):
            raise ValueError('MIDNIGHT_DISTINCT_PRIVATE_ROOT')
        entry=root.lstat()
        if not stat.S_ISDIR(entry.st_mode) or entry.st_uid!=os.getuid() or stat.S_IMODE(entry.st_mode)!=0o700:
            raise ValueError('MIDNIGHT_PRIVATE_ROOT')
        if not isinstance(scope_id,str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,48}',scope_id):raise ValueError('MIDNIGHT_SCOPE_ID')
        if type(boundary_epoch)not in(int,float) or not 0<boundary_epoch<4102444800:raise ValueError('MIDNIGHT_BOUNDARY')
        self.users=list(member_ids);self.all_users=list(member_ids);self.selected_accounts=[known[u]for u in member_ids]
        self.evidence=root;self.scope_id=scope_id;self.boundary_epoch=boundary_epoch;self.children=[];self.prepared_units_complete=False
        self.fixture={'codeRoot':str(REPO),'origin':binding['origin'],'anon':binding['credentials']['anon'],
            'service':binding['credentials']['service'],'signedLocalAuth':True,'scenario':'ai-chat',
            'productManifest':product_graph(),'accounts':[{'userId':a['userId'],'token':a['accessToken']}for a in self.selected_accounts],
            'aiQuery':'synthetic-absent-'+uuid.uuid4().hex}

    def validate_original_accounts(self):
        if not self.binding['approvedByRoot'] or not self.binding['dockerSlotReady']:raise ValueError('SIGNED_APPROVAL_SLOT_REQUIRED')
        validate_signed_binding(self.binding,self.root,self.target)
        self.signed_identity()
        proofs=[]
        for a in self.binding['accounts']:
            actual=self.auth_user(a['accessToken'])
            if actual.get('id')!=a['userId'] or actual.get('role')!='authenticated' or actual.get('is_anonymous')is True:
                raise ValueError('MIDNIGHT_ORIGINAL_AUTH')
            query='select exists(select 1 from auth.sessions where id='+quote(a['sessionId'])+'::uuid and user_id='+quote(a['userId'])+'::uuid);'
            if self.read_sql(query,timeout=2)!='t':raise ValueError('MIDNIGHT_ORIGINAL_SESSION')
            proofs.append({'userId':a['userId'],'sessionId':a['sessionId'],'expiresAt':a['expiresAt'],
                'gotrueUserId':actual['id'],'databaseSessionUserId':a['userId']})
        return proofs

    def activate_fixture_registration(self):
        """검토된 clone fixture의 네 등록 flag와 닫힌 guard만 별도 journal로 연다."""
        if getattr(self,'resumed_state',False):raise ValueError('MIDNIGHT_PREPARE_REPLAY_FORBIDDEN')
        if self.changed:raise ValueError('MIDNIGHT_ACTIVATION_ALREADY_ATTEMPTED')
        self.validate_original_accounts()
        clock=json.loads(self.read_sql("with s as(select clock_timestamp()t)select jsonb_build_object('epoch',extract(epoch from t),'midnightEpoch',extract(epoch from(((t at time zone'Asia/Seoul')::date+1)::timestamp at time zone'Asia/Seoul')))from s;",timeout=2))
        if clock['midnightEpoch']!=self.boundary_epoch or not 600<=self.boundary_epoch-clock['epoch']<=3600:raise ValueError('MIDNIGHT_NATURAL_PREPARE_WINDOW')
        signed_verify_history(self)
        if self.sql("select external_processing_allowed from private.ai_processing_guard where singleton;select current_setting('cron.launch_active_jobs');").splitlines()!=['f','off']:raise ValueError('SIGNED_CLOSED_BASELINE_REQUIRED')
        if self.sql("select(select count(*)from private.ai_account_daily_budget where kst_day=(clock_timestamp()at time zone'Asia/Seoul')::date)+(select count(*)from private.ai_global_daily_budget where kst_day=(clock_timestamp()at time zone'Asia/Seoul')::date);")!='0':raise ValueError('SIGNED_FRESH_CURRENT_DAY_REQUIRED')
        for uid in self.users:
            key=quote(uid)+'::uuid'
            if self.sql('select (select count(*)from private.ai_member_processing where user_id='+key+')+(select count(*)from private.ai_member_daily_usage where user_id='+key+')+(select count(*)from private.ai_chat_requests where user_id='+key+')+(select count(*)from private.ai_result_receipts where user_id='+key+');')!='0':raise ValueError('SIGNED_FRESH_MEMBER_AI_REQUIRED')
        self.fixture_baseline=self.snapshot();self.baseline=self.digest();self.protected=self.protected_rows()
        self.accounts=json.loads(self.sql('select json_agg(to_jsonb(a)order by account_id)from private.ai_budget_accounts a;'))
        if {a['account_id']for a in self.accounts}!={'yumi','jonghyun','minkyu','sungho'} or any(a['unit_limit']!=3200000 for a in self.accounts):raise ValueError('SIGNED_ACCOUNT_POLICY')
        self.catalog=self.sql("select md5(coalesce(string_agg(to_jsonb(p)::text,E'\\n' order by p.oid),''))from pg_proc p where pronamespace in('public'::regnamespace,'private'::regnamespace);select md5(coalesce(string_agg(to_jsonb(r)::text,E'\\n' order by oid),''))from pg_roles r;")
        self.save_signed('midnight-fixture-original-controls-private.json',{'scopeId':self.scope_id,
            'accounts':[{'accountId':a['account_id'],'registered':a['registered'],'unitLimit':a['unit_limit']}for a in self.accounts],
            'externalProcessingAllowed':False,'noMemberLedgerModelYet':True})
        clock=json.loads(self.read_sql("with s as(select clock_timestamp()t)select jsonb_build_object('epoch',extract(epoch from t),'midnightEpoch',extract(epoch from(((t at time zone'Asia/Seoul')::date+1)::timestamp at time zone'Asia/Seoul')))from s;",timeout=2))
        if clock['midnightEpoch']!=self.boundary_epoch or not 600<=self.boundary_epoch-clock['epoch']<=3600:raise ValueError('MIDNIGHT_PRE_MUTATION_WINDOW_EXPIRED')
        self.changed=True
        self.save_signed('midnight-activation-resume-state-private.json',self.export_resume_state())
        boundary=str(self.boundary_epoch)
        self.sql("begin;do $midnight$declare observed timestamptz:=clock_timestamp();begin if extract(epoch from(((observed at time zone'Asia/Seoul')::date+1)::timestamp at time zone'Asia/Seoul'))!="+boundary+" or "+boundary+"-extract(epoch from observed)not between 600 and 3600 then raise exception 'MIDNIGHT_ACTIVATION_TX_WINDOW' using errcode='55000';end if;end; $midnight$;update private.ai_budget_accounts set registered=true;update private.ai_processing_guard set external_processing_allowed=true where singleton;commit;")
        return {'status':'PASS_FIXTURE_ACTIVATED','scopeId':self.scope_id,'operatingApproval':'NOT_RUN','restoreRequired':True}

    def read_sql(self, query, timeout=2):
        if not isinstance(query,str) or not query or type(timeout)not in(int,float) or not 0<timeout<=5:
            raise ValueError('MIDNIGHT_READ_ARGUMENT')
        statement=query.strip().removesuffix(';').strip()
        if (len(query)>262144 or not re.match(r'(?i)^(select|with)\b',statement)
                or any(token in statement for token in (';','--','/*','\\'))):raise ValueError('MIDNIGHT_READ_FIXED_STATEMENT')
        # 신원 재검사는 launch/preflight에서 한다. observer에서는 원 검증 ID만 사용한다.
        command=self.base+['exec','-i',self.target['id'],'psql','-XqAt','-U','postgres','-d','postgres',
            '-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate','-f','-']
        body="begin read only;set local statement_timeout='"+str(max(1,int(timeout*500)))+"ms';"+statement+';\nrollback;'
        result=subprocess.run(command,input=body,text=True,capture_output=True,timeout=timeout)
        if result.returncode:raise isolated_command_error(result.stderr)
        return result.stdout.strip()

    def original_rows(self):
        """행 전체의 해시와 중복 개수를 보존한다. 원문은 반환하지 않는다."""
        tables=json.loads(self.read_sql("select jsonb_agg(jsonb_build_array(schemaname,tablename)order by schemaname,tablename)from pg_tables where schemaname in('auth','public','private','storage');",timeout=5))
        result={}
        for schema,table in tables:
            identifier=lambda v:'"'+v.replace('"','""')+'"'
            query="select coalesce(jsonb_object_agg(h,n),'{}'::jsonb)from(select encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')h,count(*)n from "+identifier(schema)+'.'+identifier(table)+' r group by 1)s;'
            result[schema+'.'+table]=json.loads(self.read_sql(query,timeout=5))
        return result

    def snapshot(self):
        rows=self.original_rows();hash_value=lambda value:hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        catalog=self.read_sql("select coalesce(jsonb_agg(to_jsonb(p)order by p.oid),'[]'::jsonb)from pg_proc p where pronamespace in('public'::regnamespace,'private'::regnamespace);",timeout=5)
        authority=self.read_sql("select jsonb_build_object('roles',(select jsonb_agg(to_jsonb(r)order by oid)from pg_roles r),'memberships',(select jsonb_agg(to_jsonb(m)order by roleid,member,grantor)from pg_auth_members m),'schemas',(select jsonb_agg(jsonb_build_array(nspname,nspowner,nspacl)order by nspname)from pg_namespace where nspname in('auth','public','private','storage')),'relations',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relowner,c.relacl)order by n.nspname,c.relname)from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('auth','public','private','storage')));",timeout=5)
        self.snapshot_original_rows=rows
        return {'rows':{k:hash_value(v)for k,v in rows.items()},'catalogSha256':hashlib.sha256(catalog.encode()).hexdigest(),
            'rolesAclSha256':hashlib.sha256(authority.encode()).hexdigest(),
            'unknownRows':{k:hash_value(rows[k])for k in ('private.ai_budget_reservations','private.ai_account_budget_reservations')},
            'sequence':'NOT_VERIFIED','physical':'NOT_VERIFIED'}

    def counts(self, day):
        if not isinstance(day,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',day):raise ValueError('MIDNIGHT_DAY')
        ids=','.join(quote(u)+'::uuid'for u in self.users)
        query="select jsonb_agg(coalesce((select started_requests from private.ai_member_daily_usage where user_id=x.uid and kst_day="+quote(day)+"::date),0)order by x.pos)from unnest(array["+ids+'])with ordinality x(uid,pos);'
        return json.loads(self.read_sql(query,timeout=3))

    def budget(self):
        return json.loads(self.read_sql("select jsonb_build_object('global',(select coalesce(jsonb_object_agg(kst_day::text,jsonb_build_array(reserved_units,charged_units)),'{}'::jsonb)from private.ai_global_daily_budget),'accounts',(select coalesce(jsonb_object_agg(account_id,days),'{}'::jsonb)from(select account_id,jsonb_object_agg(kst_day::text,jsonb_build_array(reserved_units,charged_units))days from private.ai_account_daily_budget group by account_id)s));",timeout=5))

    def unknown_rows(self, reservation_id):
        identifier=str(uuid.UUID(reservation_id))
        if identifier!=reservation_id:raise ValueError('MIDNIGHT_UNKNOWN_ID')
        return {table:self.read_sql('select to_jsonb(r)::text from private.'+table+' r where '+key+'='+quote(identifier)+'::uuid;',timeout=2)
            for table,key in (('ai_budget_reservations','id'),('ai_account_budget_reservations','reservation_id'))}

    def fixture_unknown_rows(self):
        if not hasattr(self,'midnight_unknown'):raise ValueError('MIDNIGHT_FIXTURE_UNKNOWN_NOT_PREPARED')
        identifier,expected=self.midnight_unknown
        actual=self.unknown_rows(identifier)
        if actual!=expected:raise ValueError('MIDNIGHT_ORIGINAL_UNKNOWN_CHANGED')
        return {k:hashlib.sha256(v.encode()).hexdigest()for k,v in actual.items()}

    def warm_factory(self, fixture, phase='held'):
        if phase!='held':raise ValueError('MIDNIGHT_WARM_PHASE')
        if not self.prepared_units_complete or not self.changed or not hasattr(self,'midnight_unknown'):raise ValueError('MIDNIGHT_PREPARED_UNITS_REQUIRED')
        self.validate_original_accounts()
        for key,value in self.fixture.items():
            if fixture.get(key)!=value:raise ValueError('MIDNIGHT_FIXED_FIXTURE')
        if fixture.get('midnightPhase')!=phase or fixture.get('midnightDir')!=str(self.evidence) or fixture.get('midnightEpoch')!=self.boundary_epoch:
            raise ValueError('MIDNIGHT_PHASE_BINDING')
        pins=signed_source_pins()
        if pins!=self.binding['sourcePins']:raise ValueError('SIGNED_SOURCE_CHANGED')
        identity=lambda p:(p.st_dev,p.st_ino,p.st_size,p.st_mtime_ns,p.st_ctime_ns)
        sources={k:identity((REPO/k).lstat())for k in pins}
        capability={'id':uuid.uuid4().hex,'scopeId':self.scope_id,'phase':phase,
            'fixtureSha256':hashlib.sha256(json.dumps(fixture,sort_keys=True).encode()).hexdigest()}
        self.held_capability=capability;self.held_warm_time=time.monotonic();self.held_warm_sources=sources;self.held_warm_used=False
        self.held_warm_binding=hashlib.sha256(json.dumps(self.binding,sort_keys=True).encode()).hexdigest()
        self.held_warm_target=json.dumps({'target':self.target,'base':self.base},sort_keys=True)
        return capability

    def start_factory(self, fixture, phase, capability=None):
        if phase not in('held','new-day','prepare-limits','prepare-recovery'):raise ValueError('MIDNIGHT_FIXED_PHASE')
        if getattr(self,'resumed_state',False)and phase.startswith('prepare-'):raise ValueError('MIDNIGHT_PREPARE_REPLAY_FORBIDDEN')
        if phase in('held','new-day')and not self.prepared_units_complete:raise ValueError('MIDNIGHT_PREPARED_UNITS_REQUIRED')
        for key,value in self.fixture.items():
            if fixture.get(key)!=value:raise ValueError('MIDNIGHT_FIXED_FIXTURE')
        if phase in('held','new-day') and (fixture.get('aiMidnightScenario')is not True or fixture.get('midnightDir')!=str(self.evidence)
                or fixture.get('midnightEpoch')!=self.boundary_epoch or fixture.get('midnightPhase')!=phase):raise ValueError('MIDNIGHT_PHASE_BINDING')
        if phase=='held':
            if (capability is not getattr(self,'held_capability',None) or capability is None or self.held_warm_used
                    or not 0<=time.monotonic()-self.held_warm_time<=60
                    or hashlib.sha256(json.dumps(self.binding,sort_keys=True).encode()).hexdigest()!=self.held_warm_binding
                    or json.dumps({'target':self.target,'base':self.base},sort_keys=True)!=self.held_warm_target
                    or hashlib.sha256(json.dumps(fixture,sort_keys=True).encode()).hexdigest()!=capability['fixtureSha256']):
                raise ValueError('MIDNIGHT_HELD_NOT_WARMED')
            deadline=time.monotonic()+.25
            for key,expected in self.held_warm_sources.items():
                info=(REPO/key).lstat()
                if time.monotonic()>=deadline or (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)!=expected:
                    raise ValueError('MIDNIGHT_HELD_SOURCE_DRIFT_OR_SLOW')
            self.held_warm_used=True
        else:self.validate_original_accounts()
        filename='midnight-'+phase+'-fixture-private.json';self.save_signed(filename,fixture)
        node=shutil.which('node')
        if not node:raise ValueError('NODE_REQUIRED')
        mode='--ai-midnight'if phase in('held','new-day')else'--ai-limits'
        command=[node,'--experimental-strip-types',str(Path(__file__).with_name('isolated_ai_factory.ts')),str(self.evidence/filename),mode]
        self.save_signed('midnight-'+phase+'-node-intent.json',{'scopeId':self.scope_id,'phase':phase,'singleLaunch':True,
            'argvSha256':hashlib.sha256(json.dumps(command).encode()).hexdigest()})
        process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        handle={'process':process,'phase':phase,'fixture':fixture};self.children.append(handle)
        try:self.save_signed('midnight-'+phase+'-node-created.json',{'pid':process.pid,'scopeId':self.scope_id,'signalsOnlyExactPopenObject':True})
        except Exception:
            self.cancel_factory(handle)
            raise
        return handle

    def cancel_factory(self, handle):
        if not any(handle is h for h in self.children):raise ValueError('MIDNIGHT_CHILD_NOT_OWNED')
        process=handle['process']
        if process.poll()is None:
            process.terminate()
            try:process.communicate(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.communicate(timeout=5)
        if process.poll()is None:raise ValueError('MIDNIGHT_CHILD_EXIT_UNPROVEN')
        return {'exited':True,'pid':process.pid,'exitCode':process.returncode,'signalsOnlyExactPopenObject':True}

    def finish_factory(self, handle, timeout=30):
        if not any(handle is h for h in self.children) or type(timeout)not in(int,float) or not 0<timeout<=150:raise ValueError('MIDNIGHT_CHILD_WAIT_ARGUMENT')
        process=handle['process'];phase=handle['phase']
        try:
            out,err=process.communicate(timeout=timeout)
            self.save_signed('midnight-'+phase+'-node-result.json',{'exitCode':process.returncode,'stdoutSha256':hashlib.sha256(out).hexdigest(),'stderrSha256':hashlib.sha256(err).hexdigest()})
            if process.returncode or len(out)>2*1024*1024:raise ValueError('MIDNIGHT_FACTORY_FAILED')
            observed=json.loads(out)
            if observed.get('status')!='PASS' or observed.get('nativeExternalAttempts')!=0:raise ValueError('MIDNIGHT_FACTORY_PROOF')
            self.save_signed('midnight-'+phase+'-observations.json',observed)
            return observed
        finally:
            closed=self.cancel_factory(handle)
            self.save_signed('midnight-'+phase+'-node-closed.json',closed)

    def effect_proof(self, observations):
        self.prove(self.fixture,observations)
        return {'status':'PASS','actualRequestReservationResultFinish':'PASS','observations':len(observations),'actualAuthPostgrest':'PASS'}

    def prepare_units(self):
        if getattr(self,'resumed_state',False):raise ValueError('MIDNIGHT_PREPARE_REPLAY_FORBIDDEN')
        if not self.changed or not hasattr(self,'fixture_baseline'):raise ValueError('MIDNIGHT_ACTIVATION_REQUIRED')
        self.validate_original_accounts();before=self.fixture_baseline
        ids=','.join(quote(u)+'::uuid'for u in self.users)
        self.save_signed('midnight-member-fixture-intent.json',{'scopeId':self.scope_id,'memberIds':self.users,'noReplay':True})
        self.sql('insert into private.ai_member_processing(user_id,exploration_allowed)select unnest(array['+ids+']),true;')
        ledger='signed-midnight-'+self.scope_id;self.ledgers.append(ledger)
        self.save_signed('midnight-ledger-intent.json',{'scopeId':self.scope_id,'ledgerId':ledger,'noReplay':True})
        self.sql('insert into private.ai_budget_ledgers(ledger_id,unit_limit,call_limit)values('+quote(ledger)+',100000000,1000);')
        self.fixture.update(aiLedgerId=ledger,aiLimitsScenario=True)
        first=self.finish_factory(self.start_factory(dict(self.fixture),'prepare-limits'),timeout=150);self.effect_proof(first['observations'])
        second_fixture={**self.fixture,'aiLimitsRecovery':True}
        second=self.finish_factory(self.start_factory(second_fixture,'prepare-recovery'),timeout=30);self.effect_proof(second['observations'])
        day=self.read_sql("select(clock_timestamp()at time zone'Asia/Seoul')::date;",timeout=2)
        from datetime import datetime,timezone,timedelta
        boundary=datetime.fromtimestamp(self.boundary_epoch,timezone(timedelta(hours=9)))
        original_day=(boundary-timedelta(days=1)).date().isoformat();next_day=boundary.date().isoformat()
        if boundary.hour or boundary.minute or boundary.second or boundary.microsecond or day!=original_day or self.counts(day)!=[3,20,3]:
            raise ValueError('MIDNIGHT_NATURAL_PREPARE_DAY')
        unknown=next(r for o in first['observations']if o['case']=='unknown-provider-loss'for r in o['reservations'])
        rows=self.unknown_rows(unknown['reservationId'])
        if not all(rows.values()):raise ValueError('MIDNIGHT_PREPARED_UNKNOWN_ROWS')
        self.midnight_unknown=(unknown['reservationId'],rows)
        self.fixture.update(aiMidnightScenario=True,midnightDir=str(self.evidence),originalDay=original_day,nextDay=next_day,midnightEpoch=self.boundary_epoch)
        receipts=[]
        for observation in first['observations']+second['observations']:
            if observation['requests'][0]['acquireStatus']=='acquired':receipts.append({'table':'ai_chat_requests','id':observation['requests'][0]['requestId'],'scopeId':self.scope_id})
            receipts.extend({'table':'ai_account_budget_reservations','id':r['reservationId'],'scopeId':self.scope_id}for r in observation['reservations'])
            receipts.extend({'table':'ai_budget_reservations','id':r['reservationId'],'scopeId':self.scope_id}for r in observation['reservations'])
        result={'scopeId':self.scope_id,'counts':self.counts(day),'nextCounts':self.counts(next_day),'baseline':before,
            'budget':self.budget(),'creationReceipts':receipts,'fixture':self.fixture,'unknown':unknown,'unknownRows':rows,
            'unknownReservationId':unknown['reservationId'],'fixtureUnknownRows':self.fixture_unknown_rows(),
            'actualWallClockMidnight':'NOT_RUN','externalProvider':'NOT_RUN'}
        self.save_signed('midnight-prepared-state-private.json',result)
        self.prepared_units_complete=True
        self.prepare_creation_receipts=receipts
        return result

    def export_resume_state(self):
        """별도 프로세스에 필요한 원 상태를 반환한다. 비공개 SHA 묶음은 호출자가 저장한다."""
        excluded={'codeRoot','origin','anon','service','accounts','productManifest','signedLocalAuth','scenario'}
        return {'version':1,'kind':'SIGNED_AI24_PORT_STATE','scopeId':self.scope_id,'boundaryEpoch':self.boundary_epoch,
            'memberIds':self.users,'preparedRoot':str(self.root),'evidenceRoot':str(self.evidence),'target':self.target,
            'bindingCanonicalSha256':hashlib.sha256(json.dumps(self.binding,sort_keys=True).encode()).hexdigest(),
            'sourcePins':self.binding['sourcePins'],'changed':self.changed,'accounts':getattr(self,'accounts',None),
            'preparedUnitsComplete':self.prepared_units_complete,'creationReceipts':getattr(self,'prepare_creation_receipts',[]),
            'baseline':getattr(self,'baseline',None),'catalog':getattr(self,'catalog',None),'protected':getattr(self,'protected',None),
            'fixtureBaseline':getattr(self,'fixture_baseline',None),'originalRows':getattr(self,'snapshot_original_rows',None),
            'ledgers':self.ledgers,'fixtureMetadata':{k:v for k,v in self.fixture.items()if k not in excluded},
            'unknown':getattr(self,'midnight_unknown',None),'externalProcessingAllowedBefore':False}

    def restore_resume_state(self, value):
        """소유·scope·원 입력이 같은 상태만 복원한다. SQL·재기동·새 prepare 호출 없음."""
        current=self.export_resume_state()
        if not isinstance(value,dict) or set(value)!=set(current):raise ValueError('MIDNIGHT_RESUME_STATE_FIELDS')
        for key in ('version','kind','scopeId','boundaryEpoch','memberIds','preparedRoot','evidenceRoot','target','bindingCanonicalSha256','sourcePins','externalProcessingAllowedBefore'):
            if value[key]!=current[key]:raise ValueError('MIDNIGHT_RESUME_STATE_BINDING')
        if type(value['version'])is not int or type(value['changed'])is not bool or type(value['preparedUnitsComplete'])is not bool or type(value['externalProcessingAllowedBefore'])is not bool:raise ValueError('MIDNIGHT_RESUME_STATE_TYPE')
        if value['changed']:
            accounts=value['accounts']
            if (not isinstance(accounts,list) or len(accounts)!=4 or {a.get('account_id')for a in accounts}!={'yumi','jonghyun','minkyu','sungho'}
                    or any(set(a)!={'account_id','account_order','registered','unit_limit'} or type(a['registered'])is not bool
                        or type(a['account_order'])is not int or a['account_order']not in(1,2,3,4) or a['unit_limit']!=3200000 for a in accounts)
                    or len({a['account_order']for a in accounts})!=4):raise ValueError('MIDNIGHT_RESUME_ORIGINAL_ACCOUNTS')
            if (not isinstance(value['baseline'],str) or not re.fullmatch(r'[a-f0-9]{32}',value['baseline'])
                    or not isinstance(value['catalog'],str) or not re.fullmatch(r'[a-f0-9]{32}\n[a-f0-9]{32}',value['catalog'])):
                raise ValueError('MIDNIGHT_RESUME_ORIGINAL_DIGEST')
            protected=value['protected']
            if not isinstance(protected,dict) or set(protected)!=set(PROTECTED_BUDGET):raise ValueError('MIDNIGHT_RESUME_PROTECTED')
            for rows in protected.values():
                if not isinstance(rows,dict) or any(not re.fullmatch(r'[a-f0-9]{32}',k)or k!=v for k,v in rows.items()):raise ValueError('MIDNIGHT_RESUME_PROTECTED_ROW')
            baseline=value['fixtureBaseline'];rows=value['originalRows']
            if (not isinstance(baseline,dict) or set(baseline)!={'rows','catalogSha256','rolesAclSha256','unknownRows','sequence','physical'}
                    or not isinstance(rows,dict) or not isinstance(baseline['rows'],dict) or set(rows)!=set(baseline['rows'])
                    or baseline['sequence']!='NOT_VERIFIED' or baseline['physical']!='NOT_VERIFIED'
                    or any(not re.fullmatch(r'[a-f0-9]{64}',baseline[k])for k in ('catalogSha256','rolesAclSha256'))):raise ValueError('MIDNIGHT_RESUME_BASELINE')
            for table,bag in rows.items():
                if (not re.fullmatch(r'(auth|public|private|storage)\.[A-Za-z_0-9]+',table) or not isinstance(bag,dict)
                        or any(not re.fullmatch(r'[a-f0-9]{64}',h)or type(n)is not int or n<1 for h,n in bag.items())
                        or hashlib.sha256(json.dumps(bag,sort_keys=True,separators=(',',':')).encode()).hexdigest()!=baseline['rows'][table]):raise ValueError('MIDNIGHT_RESUME_ORIGINAL_ROW_HASH')
            if baseline['unknownRows']!={k:baseline['rows'].get(k)for k in ('private.ai_budget_reservations','private.ai_account_budget_reservations')}:
                raise ValueError('MIDNIGHT_RESUME_UNKNOWN_BASELINE')
        metadata=value['fixtureMetadata'];allowed={'aiQuery','aiLedgerId','aiLimitsScenario','aiMidnightScenario','midnightDir','originalDay','nextDay','midnightEpoch'}
        if (not isinstance(metadata,dict) or not set(metadata).issubset(allowed)
                or not re.fullmatch(r'synthetic-absent-[a-f0-9]{32}',metadata.get('aiQuery',''))):raise ValueError('MIDNIGHT_RESUME_FIXTURE_METADATA')
        ledger='signed-midnight-'+self.scope_id
        if not isinstance(value['ledgers'],list) or value['ledgers']not in([], [ledger]):raise ValueError('MIDNIGHT_RESUME_LEDGER')
        if 'aiLedgerId'in metadata and metadata['aiLedgerId']!=ledger:raise ValueError('MIDNIGHT_RESUME_LEDGER')
        if 'midnightDir'in metadata and metadata['midnightDir']!=str(self.evidence):raise ValueError('MIDNIGHT_RESUME_PRIVATE_ROOT')
        if 'midnightEpoch'in metadata and metadata['midnightEpoch']!=self.boundary_epoch:raise ValueError('MIDNIGHT_RESUME_BOUNDARY')
        from datetime import datetime, timedelta, timezone
        next_day=datetime.fromtimestamp(self.boundary_epoch,timezone(timedelta(hours=9))).date()
        for key,expected in (('originalDay',str(next_day-timedelta(days=1))),('nextDay',str(next_day))):
            if key in metadata and metadata[key]!=expected:raise ValueError('MIDNIGHT_RESUME_KST_DAY')
        for key in ('aiLimitsScenario','aiMidnightScenario'):
            if key in metadata and metadata[key]is not True:raise ValueError('MIDNIGHT_RESUME_SCENARIO_TYPE')
        if metadata.get('aiMidnightScenario')is True and not {'originalDay','nextDay','midnightDir','midnightEpoch'}.issubset(metadata):
            raise ValueError('MIDNIGHT_RESUME_PHASE_FIELDS')
        unknown=value['unknown']
        if unknown is not None:
            if not isinstance(unknown,(list,tuple)) or len(unknown)!=2 or str(uuid.UUID(unknown[0]))!=unknown[0]:raise ValueError('MIDNIGHT_RESUME_UNKNOWN')
            rows=unknown[1]
            if not isinstance(rows,dict) or set(rows)!={'ai_budget_reservations','ai_account_budget_reservations'}:raise ValueError('MIDNIGHT_RESUME_UNKNOWN_ROWS')
            legacy=signed_exact_json(rows['ai_budget_reservations']);account=signed_exact_json(rows['ai_account_budget_reservations'])
            if (legacy.get('id')!=unknown[0] or account.get('reservation_id')!=unknown[0] or legacy.get('ledger_id')!=ledger
                    or account.get('ledger_id')!=ledger or not account.get('unknown_at') or account.get('settled_at')is not None):raise ValueError('MIDNIGHT_RESUME_UNKNOWN_PROVENANCE')
        receipts=value['creationReceipts']
        if not isinstance(receipts,list):raise ValueError('MIDNIGHT_RESUME_CREATION_RECEIPTS')
        for receipt in receipts:
            if (not isinstance(receipt,dict) or set(receipt)!={'table','id','scopeId'} or receipt['scopeId']!=self.scope_id
                    or receipt['table']not in('ai_chat_requests','ai_account_budget_reservations','ai_budget_reservations')
                    or str(uuid.UUID(receipt['id']))!=receipt['id']):raise ValueError('MIDNIGHT_RESUME_CREATION_RECEIPT')
        if value['preparedUnitsComplete']and(not value['changed']or unknown is None or not receipts or metadata.get('aiMidnightScenario')is not True):raise ValueError('MIDNIGHT_RESUME_PREPARED_PROOF')
        # 전체 검증 뒤에만 메모리를 바꾼다. 실패 시 원 object를 정리 대상으로 유지한다.
        value=signed_exact_json(json.dumps(value))
        self.changed=value['changed'];self.ledgers=value['ledgers'];self.fixture.update(value['fixtureMetadata'])
        self.prepared_units_complete=value['preparedUnitsComplete'];self.prepare_creation_receipts=value['creationReceipts']
        for field,key in (('accounts','accounts'),('baseline','baseline'),('catalog','catalog'),('protected','protected'),('fixture_baseline','fixtureBaseline'),('snapshot_original_rows','originalRows')):
            if value[key]is not None:setattr(self,field,value[key])
        if value['unknown']is not None:self.midnight_unknown=(value['unknown'][0],value['unknown'][1])
        self.resumed_state=True
        return {'status':'PASS_VALIDATED_MEMORY_ONLY','resourceCalls':0,'prepareReplayAllowed':False}

    def cleanup_owned(self):
        errors=[];children=[]
        for handle in self.children:
            try:children.append(self.cancel_factory(handle))
            except Exception as error:errors.append(type(error).__name__)
        unknown='NOT_RUN'
        if hasattr(self,'midnight_unknown'):
            try:
                identifier,expected=self.midnight_unknown
                if self.unknown_rows(identifier)!=expected:raise ValueError('MIDNIGHT_ORIGINAL_UNKNOWN_CHANGED')
                unknown='PASS_FULL_ORIGINAL_ROWS'
            except Exception as error:errors.append(type(error).__name__);unknown='FAIL'
        try:self.clean()
        except Exception as error:errors.append(type(error).__name__)
        result={'status':'FAIL'if errors else'PASS','actualChildren':children,'originalUnknownRows':unknown,
            'fixedFailureTypes':errors,'authLifecycleMutation':False,'containerLifecycleMutation':False,
            'protectedBudgetDelta':'COMMITTED_NOT_ROLLED_BACK','sequence':'NOT_VERIFIED','physical':'NOT_VERIFIED'}
        self.save_signed('midnight-cleanup.json',result)
        if errors:raise ValueError('MIDNIGHT_CLEANUP_FAILED')
        return result


PROVISION_FAILURE_CODES = ('PROVISION_AUTHORITY_HASH_REQUIRED', 'PROVISION_ADDED_ROW_SCOPE','PROVISION_ADDED_ROW_COUNT','PROVISION_ADDED_ROW_OWNER','PROVISION_UNOWNED_ROW_CHANGED','PROVISION_DATABASE_CONTROLS_OPEN', 'PROVISION_PREVIOUS_ATTEMPT_PRESERVED', 'PROVISION_CLEANUP_CREATED_ID_CHANGED', 'PROVISION_ACTUAL_AUTH_SESSION_FAILED', 'PROVISION_ARTIFACT_NAME', 'PROVISION_CLEANUP_SCOPE_UNKNOWN', 'PROVISION_CONTAINER_BINDING', 'PROVISION_CONTAINER_FIELDS', 'PROVISION_CREATE_FAILED', 'PROVISION_CREDENTIAL_FIELDS', 'PROVISION_CREDENTIAL_ROLE', 'PROVISION_DATABASE_BINDING', 'PROVISION_DELETE_UNKNOWN', 'PROVISION_EMAIL_ALREADY_PRESENT', 'PROVISION_EMAIL_SCOPE_UNKNOWN', 'PROVISION_EXACT_SIX_POPULATION_FAILED', 'PROVISION_EXPIRY_REQUIREMENT', 'PROVISION_FAILED', 'PROVISION_FAILED_PRIVATE_EVIDENCE_PRESERVED', 'PROVISION_FIXED_HTTP_PATH', 'PROVISION_FRESH_EMPTY_TARGET_REQUIRED', 'PROVISION_HEAD_CHANGED', 'PROVISION_HTTP_OUTCOME_UNKNOWN', 'PROVISION_IDENTITY_CHANGED', 'PROVISION_LOGIN_FAILED', 'PROVISION_LOOPBACK_REQUIRED', 'PROVISION_MEMORY_PARSE', 'PROVISION_MEMORY_READ', 'PROVISION_MONITOR_DID_NOT_CLOSE', 'PROVISION_ORIGINAL_JWT_METADATA', 'PROVISION_ORIGINAL_ROWS_OR_AUTHORITY_CHANGED', 'PROVISION_PROFILE_EPISODE_FAILED', 'PROVISION_RESOURCE_GUARD', 'PROVISION_RESOURCE_MONITOR_FAILED', 'PROVISION_REVIEWED_CODE_REQUIRED', 'PROVISION_SOURCE_CHANGED', 'PROVISION_SOURCE_NOT_COMMITTED', 'PROVISION_SOURCE_PATH')

PROVISION_OWNED_TABLES = ('auth.users','auth.sessions','auth.identities','auth.refresh_tokens',
    'auth.audit_log_entries','public.profiles','private.member_episodes')
PROVISION_CLOSED_CONTROLS = ('ai_processing_guard','member_cleanup_guard','worker_runtime_journal_control',
    'worker_runtime_atomic_control','worker_invocation_control','worker_intent_confirmation_control',
    'report_purge_control','ai_report_handling_control','ai_feedback_maintenance_control',
    'event_collection_control','cancellation_due_control','member_retirement_receipt_control','content_inspection_control')


def provisioning_added_scope(baseline, current, added, accounts):
    if (set(current)!=set(baseline)or set(added)!=set(PROVISION_OWNED_TABLES)
            or not set(PROVISION_OWNED_TABLES).issubset(current)):raise ValueError('PROVISION_ADDED_ROW_SCOPE')
    users={a['userId']for a in accounts}
    for table,bag in current.items():
        expected=dict(baseline[table])
        if table in added:
            entries=added[table]
            if len(entries)!=(12 if table=='auth.audit_log_entries'else 6):raise ValueError('PROVISION_ADDED_ROW_COUNT')
            owners={u:[]for u in users}
            for identifier,row in entries.items():
                if (not isinstance(identifier,str)or not identifier or len(identifier)>512
                        or set(row)!={'rowSha256','ownerUserId','operation'}
                        or not re.fullmatch(r'[a-f0-9]{64}',row['rowSha256'])or row['ownerUserId']not in users
                        or row['rowSha256']in baseline[table]):raise ValueError('PROVISION_ADDED_ROW_SCOPE')
                owners[row['ownerUserId']].append(row['operation'])
                expected[row['rowSha256']]=expected.get(row['rowSha256'],0)+1
            required=['login','user_signedup']if table=='auth.audit_log_entries'else['row']
            if any(sorted(operations)!=required for operations in owners.values()):raise ValueError('PROVISION_ADDED_ROW_OWNER')
        if bag!=expected:raise ValueError('PROVISION_UNOWNED_ROW_CHANGED')


class ReviewedSignedProvisioning:
    """검토한 서버 코드 객체만 공급하는 새 합성 Auth 생성 계약. JSON flags는 권한이 아니다."""
    def __init__(self, decision_id, prepared_root, source_pins, containers, credentials, minimum_expiry, ports=None):
        self.decision_id, self.prepared_root = decision_id, Path(prepared_root)
        self.source_pins, self.containers, self.credentials = source_pins, containers, credentials
        self.minimum_expiry, self.ports = minimum_expiry, ports


def provisioning_json(root, name, value):
    if not re.fullmatch(r'[a-z0-9-]+\.json', name): raise ValueError('PROVISION_ARTIFACT_NAME')
    fd=os.open(root/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w')as stream:
        json.dump(value,stream,sort_keys=True);stream.flush();os.fsync(stream.fileno())
    for directory in (root,root.parent):
        fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
    return hashlib.sha256(signed_private_read(root/name)).hexdigest()


def provisioning_source_check(expected, expected_head=None):
    head=subprocess.check_output(['git','-C',str(REPO),'rev-parse','HEAD'],timeout=15,text=True).strip()
    if not re.fullmatch(r'[a-f0-9]{40}',head)or expected_head is not None and head!=expected_head:raise ValueError('PROVISION_HEAD_CHANGED')
    if expected!=signed_source_pins():raise ValueError('PROVISION_SOURCE_CHANGED')
    for relative,digest in expected.items():
        path=REPO/relative
        if path.resolve()!=path or path.is_symlink():raise ValueError('PROVISION_SOURCE_PATH')
        data=path.read_bytes()
        result=subprocess.run(['git','-C',str(REPO),'show','HEAD:'+relative],capture_output=True,timeout=15)
        if result.returncode or result.stdout!=data or hashlib.sha256(data).hexdigest()!=digest:
            raise ValueError('PROVISION_SOURCE_NOT_COMMITTED')

    return head


def provisioning_metadata(reviewed, target, origin):
    if not isinstance(reviewed.containers,dict)or set(reviewed.containers)!={'db','auth','rest','gateway'}:raise ValueError('PROVISION_CONTAINER_FIELDS')
    names={'db':'supabase_db_','auth':'supabase_auth_','rest':'supabase_rest_','gateway':'supabase_kong_'}
    ids=set()
    for kind,item in reviewed.containers.items():
        if (not isinstance(item,dict)or set(item)!={'id','name','image','configSha256','hostConfigSha256','mountsSha256'}
                or item['name']!=names[kind]+target['project']or not re.fullmatch(r'[a-f0-9]{64}',item['id'])
                or not re.fullmatch(r'sha256:[a-f0-9]{64}',item['image'])
                or any(not re.fullmatch(r'[a-f0-9]{64}',item[k])for k in('configSha256','hostConfigSha256','mountsSha256'))
                or item['id']in ids):raise ValueError('PROVISION_CONTAINER_BINDING')
        ids.add(item['id'])
    if reviewed.containers['db']['id']!=target['id']or reviewed.containers['db']['image']!=target['image']:raise ValueError('PROVISION_DATABASE_BINDING')
    if not isinstance(reviewed.credentials,dict)or set(reviewed.credentials)!={'anon','service'}:raise ValueError('PROVISION_CREDENTIAL_FIELDS')
    for key,role in(('anon','anon'),('service','service_role')):
        if signed_claims(reviewed.credentials[key]).get('role')!=role:raise ValueError('PROVISION_CREDENTIAL_ROLE')
    if not re.fullmatch(r'http://127[.]0[.]0[.]1:[0-9]{1,5}',origin):raise ValueError('PROVISION_LOOPBACK_REQUIRED')

class FixedSignedProvisioningPorts:
    """명시된 새 owned 네 컨테이너의 GoTrue·DB만 사용한다. 리소스를 기동하지 않는다."""
    def __init__(self, reviewed):
        self.reviewed=reviewed;self.target=signed_prepared_target(reviewed.prepared_root)
        self.base=['docker','--host',self.target['host']]
        self.runner=object.__new__(SignedRunner)
        self.runner.root=reviewed.prepared_root;self.runner.target=self.target;self.runner.base=self.base
        self.runner.binding={'containers':reviewed.containers}

    def identity(self):
        self.runner.signed_identity()
        return self.reviewed.containers

    def memory_kib(self):
        result=subprocess.run(self.base+['exec',self.target['id'],'cat','/proc/meminfo'],capture_output=True,timeout=3)
        if result.returncode or len(result.stdout)>65536:raise ValueError('PROVISION_MEMORY_READ')
        lines=[x for x in result.stdout.decode('ascii').splitlines()if x.startswith('MemAvailable:')]
        if len(lines)!=1 or not re.fullmatch(r'MemAvailable:\s+[0-9]+\s+kB',lines[0]):raise ValueError('PROVISION_MEMORY_PARSE')
        return int(lines[0].split()[1])

    def read_sql(self, query, timeout=3):
        return SignedMidnightRunner.read_sql(self,query,timeout)

    def sql(self, query):
        return self.runner.sql(query)

    def original_rows(self):
        return SignedMidnightRunner.original_rows(self)

    def snapshot(self):
        rows=self.original_rows()
        authority=self.read_sql("select encode(sha256(convert_to(jsonb_build_object('roles',(select jsonb_agg(to_jsonb(r)order by oid)from pg_roles r),'memberships',(select jsonb_agg(to_jsonb(m)order by roleid,member,grantor)from pg_auth_members m),'namespaces',(select jsonb_agg(to_jsonb(n)order by oid)from pg_namespace n),'relations',(select jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl)order by c.oid)from pg_class c),'columns',(select jsonb_agg(jsonb_build_array(a.attrelid,a.attnum,a.attacl)order by a.attrelid,a.attnum)from pg_attribute a),'defaultAcl',(select jsonb_agg(to_jsonb(d)order by oid)from pg_default_acl d),'functions',(select jsonb_agg(to_jsonb(p)order by oid)from pg_proc p))::text,'UTF8')),'hex');",timeout=5)
        if not re.fullmatch(r'[a-f0-9]{64}',authority):raise ValueError('PROVISION_AUTHORITY_HASH_REQUIRED')
        return {'rows':rows,'authoritySha256':authority}

    def empty_auth(self):
        return self.read_sql('select(select count(*)from auth.users)+(select count(*)from auth.sessions)+(select count(*)from auth.identities)+(select count(*)from public.profiles)+(select count(*)from private.ai_budget_ledgers)+(select count(*)from private.ai_budget_reservations)+(select count(*)from private.ai_account_budget_reservations)+(select count(*)from private.ai_account_daily_budget)+(select count(*)from private.ai_global_daily_budget);')=='0'and self.read_sql("select not external_processing_allowed and current_setting('cron.launch_active_jobs')='off'from private.ai_processing_guard where singleton;")=='t'

    def closed_controls(self):
        expressions=[]
        for table in PROVISION_CLOSED_CONTROLS:
            column='external_processing_allowed'if table=='ai_processing_guard'else'external_deletion_approved'if table=='member_cleanup_guard'else'enabled'
            expressions.extend((quote(table),"(select "+column+"from private."+table+" where singleton)"))
        expressions.extend(("'cronLaunchActiveJobs'","to_jsonb(current_setting('cron.launch_active_jobs'))"))
        return json.loads(self.read_sql('select jsonb_build_object('+','.join(expressions)+');',timeout=3))

    def added_rows(self, baseline, accounts):
        # v2.196.0 admin audit는 admin actor가 아니라 traits user_id/email로 묶는다.
        metadata=[{'user_id':a['userId'],'session_id':a['sessionId'],'email':a['authEmail']}for a in accounts]
        source="jsonb_to_recordset("+quote(json.dumps(metadata))+"::jsonb)a(user_id text,session_id text,email text)"
        conditions={'auth.users':'r.id::text=a.user_id','auth.sessions':'r.user_id::text=a.user_id and r.id::text=a.session_id',
            'auth.identities':"r.user_id::text=a.user_id and r.provider='email'",
            'auth.refresh_tokens':'r.user_id::text=a.user_id and r.session_id::text=a.session_id',
            'public.profiles':'r.id::text=a.user_id','private.member_episodes':'r.profile_id::text=a.user_id and r.identity_id is null and r.ended_at is null',
            'auth.audit_log_entries':"((r.payload->>'action'='user_signedup'and r.payload->'traits'->>'user_id'=a.user_id and r.payload->'traits'->>'user_email'=a.email)or(r.payload->>'action'='login'and r.payload->>'actor_id'=a.user_id and r.payload->>'actor_username'=a.email))"}
        result={}
        for table,condition in conditions.items():
            operation="r.payload->>'action'"if table=='auth.audit_log_entries'else"'row'"
            query="select coalesce(jsonb_object_agg(r.id::text,jsonb_build_object('rowSha256',encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex'),'ownerUserId',a.user_id,'operation',"+operation+")),'{}'::jsonb)from "+table+" r join "+source+" on "+condition+';'
            result[table]=json.loads(self.read_sql(query,timeout=3))
        return result

    def request(self, method, path, payload=None, token=None, admin=False):
        allowed=(method=='POST'and path in('/admin/users','/token?grant_type=password'))or(method=='GET'and(path=='/user'or re.fullmatch(r'/admin/users/[a-f0-9-]{36}',path)))or(method=='DELETE'and re.fullmatch(r'/admin/users/[a-f0-9-]{36}',path))
        if not allowed:raise ValueError('PROVISION_FIXED_HTTP_PATH')
        c=self.reviewed.credentials;credential=c['service']if admin else c['anon']
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args):return None
        body=None if payload is None else json.dumps(payload).encode()
        request=urllib.request.Request(self.origin+'/auth/v1'+path,data=body,method=method,
            headers={'apikey':credential,'Authorization':'Bearer '+(token or credential),'Content-Type':'application/json'})
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        try:
            with opener.open(request,timeout=5)as response:
                data=response.read(65537);status=response.status
        except urllib.error.HTTPError as error:
            status=error.code;data=error.read(65537)
        except Exception:raise ValueError('PROVISION_HTTP_OUTCOME_UNKNOWN')from None
        if len(data)>65536:raise ValueError('PROVISION_HTTP_OUTCOME_UNKNOWN')
        return status,(signed_exact_json(data)if data else {})

    def resolve_email(self, email):
        value=json.loads(self.read_sql('select coalesce(jsonb_agg(id),\'[]\'::jsonb)from auth.users where email='+quote(email)+';'))
        if len(value)>1:raise ValueError('PROVISION_EMAIL_SCOPE_UNKNOWN')
        return value[0]if value else None

    def session_proof(self, account):
        a=account
        return self.read_sql('select exists(select 1 from auth.users u join auth.sessions s on s.user_id=u.id where u.id='+quote(a['userId'])+'::uuid and s.id='+quote(a['sessionId'])+'::uuid and u.email='+quote(a['authEmail'])+' and not u.is_anonymous);')=='t'

    def link_profile(self, user_id):
        # clone-only 실제 Auth 세션/profile/episode 연결. Naver 자격 행을 만들지 않는다.
        self.sql('begin;insert into public.profiles(id,real_name,birth_date,gender)values('+quote(user_id)+"::uuid,'합성 AI 검증회원','1990-01-01','female');commit;")
        return self.read_sql('select(select count(*)from public.profiles where id='+quote(user_id)+'::uuid)=1 and(select count(*)from private.member_episodes where profile_id='+quote(user_id)+'::uuid and ended_at is null and identity_id is null)=1;')=='t'

    def unlink_profile(self, user_id):
        # AI fixture가 시작되었거나 native identity가 붙었다면 이 생성기 소유로 삭제하지 않는다.
        self.sql("begin;do $$begin if exists(select 1 from private.member_episodes where profile_id="+quote(user_id)+"::uuid and identity_id is not null)or exists(select 1 from private.ai_member_processing where user_id="+quote(user_id)+"::uuid)or exists(select 1 from private.ai_chat_requests where user_id="+quote(user_id)+"::uuid)then raise exception 'provision_cleanup_scope'using errcode='55000';end if;end $$;delete from public.profiles where id="+quote(user_id)+"::uuid;delete from private.member_episodes where profile_id="+quote(user_id)+"::uuid and identity_id is null;commit;")

    def verify_population(self, accounts):
        ids=','.join(quote(a['userId'])+'::uuid'for a in accounts)
        sessions=','.join(quote(a['sessionId'])+'::uuid'for a in accounts)
        return self.read_sql('select(select count(*)from auth.users)=6 and(select count(*)from public.profiles)=6 and(select count(*)from auth.sessions)=6 and(select count(*)from auth.identities)=6 and not exists(select 1 from auth.sessions where user_id<>all(array['+ids+'])or id<>all(array['+sessions+']))and not exists(select 1 from auth.identities where user_id<>all(array['+ids+'])or provider<>\'email\')and(select count(*)from private.member_episodes where profile_id=any(array['+ids+'])and ended_at is null and identity_id is null)=6;')=='t'


def provision_signed_accounts(prepared_root, reviewed):
    """한 새 대상의 원 JWT6 입력을 만든다. 실제 호출은 검토 객체/준비 대상 없으면 거절한다."""
    root=Path(prepared_root)
    if type(reviewed)is not ReviewedSignedProvisioning or reviewed.prepared_root!=root or not isinstance(reviewed.decision_id,str)or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}',reviewed.decision_id):raise ValueError('PROVISION_REVIEWED_CODE_REQUIRED')
    source_head=provisioning_source_check(reviewed.source_pins)
    target=signed_prepared_target(root)
    manifest=signed_exact_json(signed_private_read(root/'database-manifest.json'))
    origin='http://127.0.0.1:'+str(manifest['config_overlay']['api.port'])
    if type(reviewed.minimum_expiry)is not int or reviewed.minimum_expiry<time.time()+300:raise ValueError('PROVISION_EXPIRY_REQUIREMENT')
    provisioning_metadata(reviewed,target,origin)
    if (root/'signed-ai-provision-intent.json').exists()or(root/'signed-ai-binding-private.json').exists():raise ValueError('PROVISION_PREVIOUS_ATTEMPT_PRESERVED')
    scope=uuid.uuid4().hex;evidence=root/('auth-provision-'+scope);evidence.mkdir(mode=0o700)
    signed_evidence=root/('signed-auth-'+scope)
    if signed_evidence.resolve()!=signed_evidence or signed_evidence.exists()or signed_evidence.is_symlink():raise ValueError('PROVISION_FUTURE_EVIDENCE_NOT_ABSENT')
    ports=reviewed.ports if reviewed.ports is not None else FixedSignedProvisioningPorts(reviewed)
    ports.origin=origin
    def save(name,value):return provisioning_json(evidence,name,value)
    def resource(minimum):
        began=time.monotonic();value=ports.memory_kib()
        if type(value)is not int or value<minimum or time.monotonic()-began>3:raise ValueError('PROVISION_RESOURCE_GUARD')
        return value
    accounts=[];owned=[];attempted=[];unknown_posts=[];stopped=threading.Event();failures=[]
    def monitor():
        while not stopped.is_set():
            began=time.monotonic()
            try:resource(786432)
            except BaseException:failures.append('PROVISION_RESOURCE_MONITOR_FAILED');stopped.set();return
            stopped.wait(max(0,began+3-time.monotonic()))
    observer=threading.Thread(target=monitor,daemon=True)
    def single_post(index, phase, path, payload, admin=False):
        try:
            status,value=ports.request('POST',path,payload,admin=admin)
        except BaseException:
            unknown_posts.append((index,phase))
            try:save('account-'+str(index)+'-'+phase+'-outcome.json',{'scopeId':scope,'phase':phase,'outcome':'UNKNOWN_NO_SERVER_CLOSURE_PROOF'})
            except BaseException:pass
            raise
        known_id=None
        if phase=='create'and status==200:
            try:
                known_id=str(uuid.UUID(value['id']))
                if known_id!=value['id']or value.get('email')!=payload['email']:raise ValueError()
                owned.append({'userId':known_id,'authEmail':payload['email']})
            except (ValueError,KeyError,TypeError,AttributeError):
                unknown_posts.append((index,'create-body'))
                raise ValueError('PROVISION_CREATE_FAILED')from None
        save('account-'+str(index)+'-'+phase+'-outcome.json',{'scopeId':scope,'phase':phase,'outcome':'HTTP_STATUS_OBSERVED','status':status,'knownCreatedId':known_id})
        return status,value
    def live():
        if failures or stopped.is_set():raise ValueError('PROVISION_RESOURCE_MONITOR_FAILED')
        provisioning_source_check(reviewed.source_pins,source_head)
        if ports.identity()!=reviewed.containers:raise ValueError('PROVISION_IDENTITY_CHANGED')
        controls=ports.closed_controls()
        if set(controls)!=set(PROVISION_CLOSED_CONTROLS)|{'cronLaunchActiveJobs'}or controls['cronLaunchActiveJobs']!='off'or any(controls[k]is not False for k in PROVISION_CLOSED_CONTROLS):raise ValueError('PROVISION_DATABASE_CONTROLS_OPEN')
        resource(786432)
    try:
        if ports.identity()!=reviewed.containers or not ports.empty_auth():raise ValueError('PROVISION_FRESH_EMPTY_TARGET_REQUIRED')
        initial=resource(1048576)
        controls=ports.closed_controls()
        if set(controls)!=set(PROVISION_CLOSED_CONTROLS)|{'cronLaunchActiveJobs'}or controls['cronLaunchActiveJobs']!='off'or any(controls[k]is not False for k in PROVISION_CLOSED_CONTROLS):raise ValueError('PROVISION_DATABASE_CONTROLS_OPEN')
        baseline=ports.snapshot();save('baseline-private.json',baseline)
        save('scope-intent.json',{'scopeId':scope,'target':target,'sourcePins':reviewed.source_pins,'sourceHead':source_head,'initialMemoryKiB':initial,
            'signedEvidenceRoot':str(signed_evidence),'noResend':True,'actualNaver':'NOT_RUN'})
        provisioning_json(root,'signed-ai-provision-intent.json',{'scopeId':scope,'targetId':target['id'],'sourceHead':source_head,'creationReceiptRoot':str(evidence),'singleProvision':True,'noReplay':True})
        observer.start()
        for index in range(6):
            live();resource(1048576 if index==0 else 786432)
            email='synthetic-ai-'+scope+'-'+str(index)+'@example.invalid';password=base64.urlsafe_b64encode(os.urandom(36)).decode()
            if ports.resolve_email(email)is not None:raise ValueError('PROVISION_EMAIL_ALREADY_PRESENT')
            save('account-'+str(index)+'-intent-private.json',{'scopeId':scope,'authEmail':email,'password':password,'singleCreate':True})
            attempted.append((index,email))
            status,user=single_post(index,'create','/admin/users',{'email':email,'password':password,'email_confirm':True},admin=True)
            if status!=200 or user.get('email')!=email:raise ValueError('PROVISION_CREATE_FAILED')
            identifier=str(uuid.UUID(user['id']))
            if owned[-1]!={'userId':identifier,'authEmail':email}:raise ValueError('PROVISION_CREATE_FAILED')
            save('account-'+str(index)+'-created-private.json',{'scopeId':scope,**owned[-1],'createStatus':status})
            live();save('account-'+str(index)+'-login-intent.json',{'scopeId':scope,'singleLogin':True})
            status,session=single_post(index,'login','/token?grant_type=password',{'email':email,'password':password})
            if status!=200 or session.get('user',{}).get('id')!=identifier:raise ValueError('PROVISION_LOGIN_FAILED')
            token=session.get('access_token');claims=signed_claims(token)
            account={'userId':identifier,'sessionId':str(uuid.UUID(claims.get('session_id'))),'accessToken':token,
                     'expiresAt':claims.get('exp'),'authEmail':email}
            if claims.get('sub')!=identifier or claims.get('email')!=email or claims.get('iss')!=origin+'/auth/v1'or claims.get('role')!='authenticated'or claims.get('aud')!='authenticated'or claims.get('is_anonymous')is True or type(account['expiresAt'])is not int or account['expiresAt']<max(reviewed.minimum_expiry,time.time()+300):raise ValueError('PROVISION_ORIGINAL_JWT_METADATA')
            live();status,actual=ports.request('GET','/user',token=token)
            if status!=200 or actual.get('id')!=identifier or actual.get('email')!=email or actual.get('role')!='authenticated'or actual.get('is_anonymous')is True or not ports.session_proof(account):raise ValueError('PROVISION_ACTUAL_AUTH_SESSION_FAILED')
            save('account-'+str(index)+'-session-private.json',{'scopeId':scope,**{k:v for k,v in account.items()if k!='accessToken'},'actualGoTrueUser':True,'actualDatabaseSession':True})
            live();save('account-'+str(index)+'-profile-intent.json',{'scopeId':scope,'userId':identifier,'singleLink':True,'syntheticNaverEligibility':False})
            if not ports.link_profile(identifier):raise ValueError('PROVISION_PROFILE_EPISODE_FAILED')
            save('account-'+str(index)+'-linked.json',{'scopeId':scope,'userId':identifier,'originalSessionId':account['sessionId'],'profile':True,'nativeIdentity':False})
            accounts.append(account)
        live()
        if any(a['expiresAt']<max(reviewed.minimum_expiry,time.time()+300)for a in accounts):raise ValueError('PROVISION_ORIGINAL_JWT_METADATA')
        if not ports.verify_population(accounts):raise ValueError('PROVISION_EXACT_SIX_POPULATION_FAILED')
        final=ports.snapshot()
        if final['authoritySha256']!=baseline['authoritySha256']:raise ValueError('PROVISION_ORIGINAL_ROWS_OR_AUTHORITY_CHANGED')
        added=ports.added_rows(baseline['rows'],accounts)
        provisioning_added_scope(baseline['rows'],final['rows'],added,accounts)
        save('owned-added-rows-private.json',{'scopeId':scope,'createdUserIds':[a['userId']for a in accounts],'rows':added})
        stopped.set();observer.join(timeout=3)
        if observer.is_alive()or failures:raise ValueError('PROVISION_MONITOR_DID_NOT_CLOSE')
        binding={'version':1,'kind':SIGNED_KIND,'preparedRoot':str(root),'databaseManifestSha256':hashlib.sha256(signed_private_read(root/'database-manifest.json')).hexdigest(),
            'origin':origin,'jwtIssuer':origin+'/auth/v1','containers':reviewed.containers,'credentials':reviewed.credentials,'accounts':accounts,
            'evidenceRoot':str(signed_evidence),'sourcePins':reviewed.source_pins,'approvedByRoot':False,'dockerSlotReady':False}
        validate_signed_binding(binding,root,target)
        binding_sha=provisioning_json(root,'signed-ai-binding-private.json',binding)
        receipt={'status':'PASS_LOCAL_AUTH6_PROVISION_ONLY','scopeId':scope,'accounts':6,'bindingSha256':binding_sha,
            'creationReceiptRoot':str(evidence),'signedEvidenceRoot':str(signed_evidence),'originalRowsPreserved':True,
            'actualGoTrueAndDatabaseSessions':True,'actualNaver':'NOT_RUN','actualAI22AI23AI24':'NOT_RUN','authAccountsRetained':True}
        save('receipt.json',receipt)
        return receipt
    except BaseException as error:
        # 최초 POST가 유실되었어도 원 email GET/DB 조회만 한다. create/login은 재발신하지 않는다.
        stopped.set()
        if observer.ident is not None:observer.join(timeout=3)
        uncertainty=bool(observer.is_alive()or unknown_posts);closed=[]
        for index,email in attempted:
            try:
                if ports.identity()!=reviewed.containers:raise ValueError('PROVISION_CLEANUP_SCOPE_UNKNOWN')
                identifier=ports.resolve_email(email)
                if identifier is None:continue
                identifier=str(uuid.UUID(identifier))
                known=next((item['userId']for item in owned if item['authEmail']==email),None)
                if known is not None and identifier!=known:raise ValueError('PROVISION_CLEANUP_CREATED_ID_CHANGED')
                status,actual=ports.request('GET','/admin/users/'+identifier,admin=True)
                if status!=200 or actual.get('id')!=identifier or actual.get('email')!=email:raise ValueError('PROVISION_CLEANUP_SCOPE_UNKNOWN')
                save('account-'+str(index)+'-cleanup-intent.json',{'scopeId':scope,'userId':identifier,'authEmail':email,'singleDelete':True})
                ports.unlink_profile(identifier)
                if ports.identity()!=reviewed.containers:raise ValueError('PROVISION_CLEANUP_SCOPE_UNKNOWN')
                try:status,_=ports.request('DELETE','/admin/users/'+identifier,admin=True)
                except BaseException:status=None
                # 유실 DELETE는 GET-only로 확인한다. 어떤 status도 추가 DELETE 허가가 아니다.
                found=ports.resolve_email(email)
                get_status,_=ports.request('GET','/admin/users/'+identifier,admin=True)
                if found is not None or get_status!=404:raise ValueError('PROVISION_DELETE_UNKNOWN')
                closed.append(identifier)
                save('account-'+str(index)+'-cleanup-closed.json',{'scopeId':scope,'userId':identifier,'getAbsent':True,'deleteResponseObserved':status is not None})
            except BaseException:uncertainty=True
        code=str(error)if type(error)is ValueError and str(error)in PROVISION_FAILURE_CODES else'PROVISION_FAILED'
        try:save('failure.json',{'status':'UNKNOWN'if uncertainty else'FAIL_OWN_CREATED_AUTH_ABSENT','scopeId':scope,'code':code,
            'closedCount':len(closed),'attemptedCount':len(attempted),'unknownPostCount':len(unknown_posts),'noResend':True,'actualAI22AI23AI24':'NOT_RUN'})
        except BaseException:pass
        raise ValueError('PROVISION_FAILED_PRIVATE_EVIDENCE_PRESERVED')from None
    finally:
        stopped.set()
        if observer.ident is not None:
            observer.join(timeout=3)
            if observer.is_alive():raise ValueError('PROVISION_MONITOR_DID_NOT_CLOSE')

if __name__=='__main__':
    try:signed_main() if any(k in sys.argv for k in ('--signed-local-auth','--signed-auth')) else main()
    except Exception as error:
        code=str(error)if re.fullmatch(r'[A-Z0-9_,]+',str(error))else'ISOLATED_AI_FAILED'
        print(json.dumps({'status':'FAIL','code':code}));sys.exit(1)
