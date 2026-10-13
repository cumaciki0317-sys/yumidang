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
import tempfile
from functools import lru_cache

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'tools/local'))
from run_database_tests import isolated_prepared_target, isolated_command_error, preserved_contract, preserved_resource_pins, verify_preserved_resources

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
        verify_preserved_resources(self.root, t['host'], t['project'], self.call, t.get('preservedResourcePins'))
        item = json.loads(self.call(['inspect', t['id']]))[0]
        if (item['Id'] != t['id'] or item['Image'] != t['image'] or item['Name'] != '/' + t['container']
                or not item['State']['Running'] or item['Config']['Labels'].get('com.supabase.cli.project') != t['project']):
            raise ValueError('ISOLATED_ID_CHANGED')
        if self.call(['context', 'inspect', t['context'], '--format', '{{.Endpoints.docker.Host}}']) != t['host']:
            raise ValueError('ISOLATED_SOCKET_CHANGED')

    def sql(self, statement):
        self.identity()
        try:
            result = self.call(['exec', '-i', self.target['id'], 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres',
                               '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-f', '-'],
                              "set statement_timeout='15s';set lock_timeout='10s';set plpgsql.check_asserts=on;\n" + statement)
        except BaseException as error:
            try: self.identity()
            except BaseException: error.add_note('PRESERVED_POST_SQL_UNPROVEN')
            raise
        self.identity()
        return result

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
        if parent in {Path('/private/tmp').resolve(), Path('/tmp').resolve(), Path(tempfile.gettempdir()).resolve()}: break
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
            or intent.get('scope')!='new-synthetic-only'
            or intent.get('version',1)==1 and (intent.get('existingContainers')!=[] or intent.get('existingNetworks')!=[])):
        raise ValueError('SIGNED_PREPARED_AUTHORITY')
    owned=signed_exact_json(signed_private_read(root/'owned-containers.json'))
    preserved_contract(root,intent,owned,host,overlay['project_id'])
    matching=[x for x in owned if x.get('name')=='supabase_db_'+overlay['project_id']]
    if len(matching)!=1 or not re.fullmatch(r'[a-f0-9]{64}',matching[0]['id']) or not re.fullmatch(r'sha256:[a-f0-9]{64}',matching[0]['image']):
        raise ValueError('SIGNED_PREPARED_DB')
    item=matching[0]
    result={'context':context,'host':host,'project':overlay['project_id'],'container':item['name'],'id':item['id'],'image':item['image'],'versions':[e['version']for e in entries]}
    pins=preserved_resource_pins(root,intent)
    if pins is not None:result['preservedResourcePins']=pins
    return result

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

def signed_native_permission_selected(pins):
    """고정 helper의 두 SQL 상수와 읽기 전용 함수만 커밋 원본에서 선택한다."""
    import ast
    relative='tests/integration/minkyu/product_connection_restore108_local.py'
    path=REPO/relative;raw=path.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=pins.get(relative):raise ValueError('SIGNED_NATIVE_HELPER_PIN_CHANGED')
    committed=subprocess.run(['git','-C',str(REPO),'show','HEAD:'+relative],capture_output=True,timeout=5)
    if committed.returncode or committed.stdout!=raw:raise ValueError('SIGNED_NATIVE_HELPER_UNCOMMITTED')
    names={'NATIVE_BACKUP_ACL_QUERY','NATIVE_BACKUP_PERMISSION_QUERY'};values={}
    for node in ast.parse(raw).body:
        if isinstance(node,ast.Assign) and len(node.targets)==1 and isinstance(node.targets[0],ast.Name) and node.targets[0].id in names:
            name=node.targets[0].id
            if name in values:raise ValueError('SIGNED_NATIVE_SQL_CONSTANTS')
            value=ast.literal_eval(node.value)
            if type(value)is not str or not value or len(value.encode())>1024*1024:raise ValueError('SIGNED_NATIVE_SQL_CONSTANTS')
            values[name]=value
    if set(values)!=names:raise ValueError('SIGNED_NATIVE_SQL_CONSTANTS')
    return signed_native_selected(relative,{'platform_json','native_backup_permissions'},pins,
        {'json':json,**values})


@lru_cache(maxsize=1)
def _signed_native_immutable_projection(source_raw, baseline_raw, source_sha, baseline_sha, helper_raw, helper_sha):
    """검증된 불변 bytes의 순수 비교만 재사용한다. 현재 DB/파일 검사는 호출자가 매번 한다."""
    import ast
    for raw,pin in ((source_raw,source_sha),(baseline_raw,baseline_sha),(helper_raw,helper_sha)):
        if (type(raw)is not bytes or len(raw)>64*1024*1024 or type(pin)is not str
                or not re.fullmatch('[a-f0-9]{64}',pin)or hashlib.sha256(raw).hexdigest()!=pin):
            raise ValueError('SIGNED_NATIVE_IMMUTABLE_BYTES_CHANGED')
    names={'native_restore_json','native_restore_source','native_restore_ident','native_restore_acl_entries',
        'native_restore_catalog','native_restore_acl_plan','native_restore_schema_grant_lines','native_restore_compare'}
    nodes=[n for n in ast.parse(helper_raw).body if isinstance(n,ast.FunctionDef)and n.name in names]
    if len(nodes)!=len(names)or{n.name for n in nodes}!=names:raise ValueError('SIGNED_NATIVE_HELPER_FUNCTIONS')
    namespace={'json':json,'hashlib':hashlib,'re':re}
    exec(compile(ast.Module(body=nodes,type_ignores=[]),'committed-native-immutable-comparison','exec'),namespace)
    source=signed_exact_json(source_raw);baseline=signed_exact_json(baseline_raw)
    namespace['native_restore_compare'](source,baseline,source_sha)
    canonical=lambda value:json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
    grants=tuple(namespace['native_restore_schema_grant_lines'](baseline))
    return (len(source['snapshot']['rows']),hashlib.sha256(source['snapshot']['catalog'].encode()).hexdigest(),
        hashlib.sha256(canonical(source['snapshot']['roles'])).hexdigest(),canonical(baseline['rawAuthority']),
        canonical(baseline['effectivePrivileges']),canonical(baseline['snapshot']['roles']),grants,
        namespace['native_restore_catalog'](baseline['snapshot']['catalog'],grants))


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
    version=provenance.get('version')if type(provenance)is dict else None
    expected_fields=fields|({'cloneBaselineStatePath'}if type(version)is int and version==2 else set())
    if (not isinstance(provenance,dict)or set(provenance)!=expected_fields or type(version)is not int
            or version not in(1,2) or provenance['kind']!='NATIVE119_RUNTIME_PROVENANCE'
            or provenance['preparedRoot']!=str(runner.root)):raise ValueError('SIGNED_NATIVE_PROVENANCE_FIELDS')
    fixed={'sourceStatePath':str(NATIVE_SIGNED_SOURCE_STATE),'sourceStateSha256':NATIVE_SIGNED_SOURCE_STATE_SHA,
        'canonicalRoot':str(NATIVE_SIGNED_CANONICAL_ROOT),'canonicalReceiptSha256':NATIVE_SIGNED_CANONICAL_RECEIPT_SHA,
        'canonicalAppliedInventorySha256':NATIVE_SIGNED_APPLIED_INVENTORY_SHA,'canonicalAppliedFileMapSha256':NATIVE_SIGNED_APPLIED_FILE_MAP_SHA,
        **({'cloneBaselineStateSha256':NATIVE_SIGNED_SOURCE_STATE_SHA}if version==1 else {})}
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
    comparison=None
    if version==1:
        state=signed_exact_json(raw);snapshot=state['snapshot'];schema=snapshot['catalog'];roles=snapshot['roles']
        if (len(snapshot['rows'])!=178 or provenance['sourceCatalogSha256']!=hashlib.sha256(schema.encode()).hexdigest()
                or provenance['sourcePortableRolesSha256']!=digest(roles)):raise ValueError('SIGNED_NATIVE_SOURCE_METADATA')
    if version==2:
        baseline_path=runner.root/'native119-clone-baseline-private.json'
        if provenance['cloneBaselineStatePath']!=str(baseline_path)or not isinstance(provenance['cloneBaselineStateSha256'],str)or not re.fullmatch('[a-f0-9]{64}',provenance['cloneBaselineStateSha256']):
            raise ValueError('SIGNED_NATIVE_BASELINE_BINDING')
        # token/state reader의 600/700 규칙을 유지하며 64MiB 전체 상태만 별도 허용한다.
        with namespace['platform_open'](baseline_path)as stream:
            before=os.fstat(stream.fileno());baseline_raw=stream.read(64*1024*1024+1);after=os.fstat(stream.fileno());current=baseline_path.lstat()
            if (len(baseline_raw)>64*1024*1024 or len(baseline_raw)!=before.st_size or identity(before)!=identity(after)or identity(after)!=identity(current)
                    or hashlib.sha256(baseline_raw).hexdigest()!=provenance['cloneBaselineStateSha256']):raise ValueError('SIGNED_NATIVE_BASELINE_CHANGED')
        comparison=signed_native_selected('tests/integration/minkyu/product_connection_restore108_local.py',
            {'native_restore_json','native_restore_source','native_restore_ident','native_restore_acl_entries','native_restore_catalog',
             'native_restore_acl_plan','native_restore_schema_grant_lines','native_restore_compare'},pins,{'json':json,'hashlib':hashlib,'re':re})
        relative='tests/integration/minkyu/product_connection_restore108_local.py'
        helper_raw=(REPO/relative).read_bytes()
        if hashlib.sha256(helper_raw).hexdigest()!=pins[relative]:raise ValueError('SIGNED_NATIVE_HELPER_PIN_CHANGED')
        rows,source_catalog_sha,source_roles_sha,baseline_authority,baseline_effective,baseline_roles,allowed,baseline_catalog=\
            _signed_native_immutable_projection(raw,baseline_raw,NATIVE_SIGNED_SOURCE_STATE_SHA,
                provenance['cloneBaselineStateSha256'],helper_raw,pins[relative])
        if (rows!=178 or provenance['sourceCatalogSha256']!=source_catalog_sha
                or provenance['sourcePortableRolesSha256']!=source_roles_sha):raise ValueError('SIGNED_NATIVE_SOURCE_METADATA')
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
    if version==1:
        if current_schema!=schema or current_roles!=roles:raise ValueError('SIGNED_NATIVE_CURRENT_SCHEMA_ROLES_CHANGED')
    else:
        permission=signed_native_permission_selected(pins)
        current_authority=permission['platform_json'](read_query(runner.target['id'],permission['NATIVE_BACKUP_ACL_QUERY']))
        current_effective=permission['native_backup_permissions'](read_query,runner.target['id'],role_batch_size=4)
        if canonical(current_authority)!=baseline_authority or canonical(current_effective)!=baseline_effective:
            raise ValueError('SIGNED_NATIVE_CURRENT_AUTHORITY_CHANGED')
        if canonical(current_roles)!=baseline_roles:raise ValueError('SIGNED_NATIVE_CURRENT_SCHEMA_ROLES_CHANGED')
        if comparison['native_restore_catalog'](current_schema,allowed)!=baseline_catalog:
            raise ValueError('SIGNED_NATIVE_CURRENT_SCHEMA_ROLES_CHANGED')
    runner.signed_identity()
    if version==2:
        return {'method':'PINNED_NATIVE119_V2_BASELINE_AND_CURRENT_AUTHORITY','scope':'NATIVE119_SCHEMA_ROLE_RAW_ACL_EFFECTIVE_MATCH_LINEAGE',
            'baselineRowsSequences':'VERIFIED_SOURCE_EQUIVALENCE','currentAuthRowsSequences':'PROVISIONING_JOURNAL_SEPARATE',
            'migrationReplay':'NOT_RUN','actualNaver':'NOT_RUN','creatorAuthorization':'NOT_GRANTED'}
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
        if getattr(self,'midnight_custody',None)is not None:
            self.held_custody=self.midnight_custody.descriptor();self.held_custody_signatures=midnight_warm_signatures(self)
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
            if getattr(self,'midnight_custody',None)is not None:midnight_warm_recheck(self)
            for key,expected in self.held_warm_sources.items():
                info=(REPO/key).lstat()
                if time.monotonic()>=deadline or (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)!=expected:
                    raise ValueError('MIDNIGHT_HELD_SOURCE_DRIFT_OR_SLOW')
            self.held_warm_used=True
        else:
            midnight_custody_proof(self)
            self.validate_original_accounts()
        filename='midnight-'+phase+'-fixture-private.json';self.save_signed(filename,fixture)
        typed=getattr(self,'midnight_custody',None)
        node=str(typed.node_path)if typed is not None else shutil.which('node')
        if not node:raise ValueError('NODE_REQUIRED')
        factory=Path(typed.descriptor()['capsuleRoot'])/'tests/integration/jonghyun/isolated_ai_factory.ts'if typed is not None else Path(__file__).with_name('isolated_ai_factory.ts')
        mode='--ai-midnight'if phase in('held','new-day')else'--ai-limits'
        command=[node,'--experimental-strip-types',str(factory),str(self.evidence/filename),mode]
        self.save_signed('midnight-'+phase+'-node-intent.json',{'scopeId':self.scope_id,'phase':phase,'singleLaunch':True,
            'argvSha256':hashlib.sha256(json.dumps(command).encode()).hexdigest()})
        options={'env':midnight_minimal_env(self.evidence),'cwd':str(self.evidence),'start_new_session':True}if typed is not None else {}
        process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**options)
        handle={'process':process,'phase':phase,'fixture':fixture,'typedCustody':typed is not None};self.children.append(handle)
        try:self.save_signed('midnight-'+phase+'-node-created.json',{'pid':process.pid,'scopeId':self.scope_id,'signalsOnlyExactPopenObject':True})
        except Exception:
            self.cancel_factory(handle)
            raise
        return handle

    def cancel_factory(self, handle):
        if not any(handle is h for h in self.children):raise ValueError('MIDNIGHT_CHILD_NOT_OWNED')
        process=handle['process']
        if handle.get('typedCustody'):
            try:
                self.midnight_terminate(process)
                if process.poll()is None:raise ValueError('MIDNIGHT_CHILD_EXIT_UNPROVEN')
            finally:midnight_custody_proof(self)
            return {'exited':True,'pid':process.pid,'exitCode':process.returncode,'ownedGroupClosed':True,'sourceCustody':'SEALED_PIN_RECHECKED'}
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
            'unknown':getattr(self,'midnight_unknown',None),'externalProcessingAllowedBefore':False,
            **({'sourceCustody':self.midnight_custody.descriptor(),'sourceCustodySha256':hashlib.sha256(self.midnight_custody._data.encode()).hexdigest()}if getattr(self,'midnight_custody',None)is not None else {})}

    def restore_resume_state(self, value):
        """소유·scope·원 입력이 같은 상태만 복원한다. SQL·재기동·새 prepare 호출 없음."""
        current=self.export_resume_state()
        if getattr(self,'midnight_custody',None)is not None:
            if (not isinstance(value,dict)or value.get('sourceCustody')!=current['sourceCustody']or value.get('sourceCustodySha256')!=current['sourceCustodySha256']):
                raise ValueError('MIDNIGHT_RESUME_CUSTODY_BINDING')
            midnight_custody_proof(self)
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
        verify_preserved_resources(self.runner.root,self.target['host'],self.target['project'],self.runner.call,self.target.get('preservedResourcePins'))
        try:
            result=SignedMidnightRunner.read_sql(self,query,timeout)
        except BaseException as error:
            try: verify_preserved_resources(self.runner.root,self.target['host'],self.target['project'],self.runner.call,self.target.get('preservedResourcePins'))
            except BaseException: error.add_note('PRESERVED_POST_READ_UNPROVEN')
            raise
        verify_preserved_resources(self.runner.root,self.target['host'],self.target['project'],self.runner.call,self.target.get('preservedResourcePins'))
        return result

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
            expressions.extend((quote(table),"(select "+column+" from private."+table+" where singleton)"))
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
        verify_preserved_resources(self.runner.root,self.target['host'],self.target['project'],self.runner.call,self.target.get('preservedResourcePins'))
        c=self.reviewed.credentials;credential=c['service']if admin else c['anon']
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args):return None
        body=None if payload is None else json.dumps(payload).encode()
        request=urllib.request.Request(self.origin+'/auth/v1'+path,data=body,method=method,
            headers={'apikey':credential,'Authorization':'Bearer '+(token or credential),'Content-Type':'application/json'})
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        try:
            try:
                with opener.open(request,timeout=5)as response:
                    data=response.read(65537);status=response.status
            except urllib.error.HTTPError as error:
                status=error.code;data=error.read(65537)
            except Exception:raise ValueError('PROVISION_HTTP_OUTCOME_UNKNOWN')from None
        except BaseException as error:
            try: verify_preserved_resources(self.runner.root,self.target['host'],self.target['project'],self.runner.call,self.target.get('preservedResourcePins'))
            except BaseException: error.add_note('PRESERVED_POST_HTTP_UNPROVEN')
            raise
        verify_preserved_resources(self.runner.root,self.target['host'],self.target['project'],self.runner.call,self.target.get('preservedResourcePins'))
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

LIFECYCLE_KIND='SIGNED_LOCAL_AUTH_LIFECYCLE'
LIFECYCLE_CASES=('expiredBearer','revokedSession','anonymousBearer','memberChanged','differentOriginalContext')


class ReviewedSignedAuthLifecycle:
    """검토된 고정 코드 조립만 받는다. 입력 JSON은 이 실행 객체를 만들거나 포트를 선택하지 않는다."""
    def __init__(self, decision_id, prepared_root, binding_path, input_path, binding_sha256, input_sha256, source_pins, containers, issuance_proofs=None, foreign_receipt_sha256=None):
        self.decision_id=decision_id;self.prepared_root=Path(prepared_root)
        self.binding_path=Path(binding_path);self.input_path=Path(input_path)
        self.binding_sha256=binding_sha256;self.input_sha256=input_sha256
        self.source_pins=source_pins;self.containers=containers
        self.issuance_proofs=issuance_proofs
        self.foreign_receipt_sha256=foreign_receipt_sha256


def validate_lifecycle_input(value, root, binding, binding_sha):
    """발급 원문은 private 입력에만 둔다. JSON 정보는 실제 Auth 읽기를 대신하지 않는다."""
    fields={'version','kind','scopeId','preparedRoot','signedBindingSha256','sourcePins','evidenceRoot',
            'accounts','foreign','approvedByRoot','dockerSlotReady'}
    if not isinstance(value,dict)or set(value)!=fields or type(value['version'])is not int or value['version']!=1 or value['kind']!=LIFECYCLE_KIND:
        raise ValueError('LIFECYCLE_INPUT_FIELDS')
    scope=value['scopeId']
    if not isinstance(scope,str)or not re.fullmatch(r'[a-f0-9]{32}',scope):raise ValueError('LIFECYCLE_SCOPE')
    if value['preparedRoot']!=str(root)or value['signedBindingSha256']!=binding_sha or value['sourcePins']!=signed_source_pins():
        raise ValueError('LIFECYCLE_SOURCE_BINDING')
    if any(type(value[key])is not bool for key in ('approvedByRoot','dockerSlotReady')):raise ValueError('LIFECYCLE_APPROVAL_TYPE')
    if value['evidenceRoot']!=str(root/('auth-lifecycle-'+scope)):raise ValueError('LIFECYCLE_EVIDENCE_SCOPE')
    evidence=Path(value['evidenceRoot'])
    if evidence.resolve()!=evidence or evidence.exists()or evidence.is_symlink():raise ValueError('LIFECYCLE_PREVIOUS_ATTEMPT')
    accounts=value['accounts']
    if not isinstance(accounts,dict)or set(accounts)!=set(LIFECYCLE_CASES)-{'differentOriginalContext'}:
        raise ValueError('LIFECYCLE_ACCOUNT_SET')
    users={a['userId']for a in binding['accounts']};sessions={a['sessionId']for a in binding['accounts']}
    for case,a in accounts.items():
        if a is None and case=='anonymousBearer':continue
        if not isinstance(a,dict)or set(a)!={'userId','sessionId','accessToken','expiresAt','authEmail','issuanceReceiptSha256'}:
            raise ValueError('LIFECYCLE_ACCOUNT_FIELDS')
        for key in ('userId','sessionId'):
            if not isinstance(a[key],str)or str(uuid.UUID(a[key]))!=a[key]:raise ValueError('LIFECYCLE_ACCOUNT_ID')
        if a['userId']in users or a['sessionId']in sessions:raise ValueError('LIFECYCLE_ORIGINAL_ACCOUNT_SCOPE')
        users.add(a['userId']);sessions.add(a['sessionId'])
        claims=signed_claims(a['accessToken'])
        anonymous=case=='anonymousBearer'
        email=''if anonymous else'synthetic-auth-lifecycle-'+scope+'-'+case.lower()+'@example.invalid'
        if (claims.get('sub')!=a['userId']or claims.get('session_id')!=a['sessionId']or claims.get('iss')!=binding['jwtIssuer']
                or claims.get('role')!='authenticated' or claims.get('is_anonymous')is not anonymous or claims.get('email')!=email
                or a['authEmail']!=email or type(a['expiresAt'])is not int or claims.get('exp')!=a['expiresAt']
                or type(claims.get('exp'))is not int or type(claims.get('iat'))is not int or claims['iat']>=claims['exp']):
            raise ValueError('LIFECYCLE_ORIGINAL_TOKEN_METADATA')
        if not isinstance(a['issuanceReceiptSha256'],str)or not re.fullmatch(r'[a-f0-9]{64}',a['issuanceReceiptSha256']):
            raise ValueError('LIFECYCLE_ISSUANCE_HASH')
    foreign=value['foreign']
    if foreign is not None:
        if not isinstance(foreign,dict)or set(foreign)!={'preparedRoot','bindingPath','bindingSha256','userId'}:
            raise ValueError('LIFECYCLE_FOREIGN_FIELDS')
        if not isinstance(foreign['preparedRoot'],str)or not isinstance(foreign['bindingPath'],str):raise ValueError('LIFECYCLE_FOREIGN_PATH')
        foreign_root=Path(foreign['preparedRoot']);foreign_path=Path(foreign['bindingPath'])
        if foreign_root==root or foreign_root.resolve()!=foreign_root or foreign_path.parent!=foreign_root or foreign_path.resolve()!=foreign_path:
            raise ValueError('LIFECYCLE_FOREIGN_PATH')
        if foreign_path.name!='signed-ai-binding-private.json' or not re.fullmatch(r'[a-f0-9]{64}',foreign['bindingSha256']):
            raise ValueError('LIFECYCLE_FOREIGN_BINDING')
        if not isinstance(foreign['userId'],str)or str(uuid.UUID(foreign['userId']))!=foreign['userId']or foreign['userId']in users:
            raise ValueError('LIFECYCLE_FOREIGN_USER')
    return value


def lifecycle_issuance(root, binding, value, case, reviewed):
    a=value['accounts'][case]
    path=root/('auth-lifecycle-provision-'+value['scopeId'])/(case+'-issued.json')
    raw=signed_private_read(path)
    if hashlib.sha256(raw).hexdigest()!=a['issuanceReceiptSha256']:raise ValueError('LIFECYCLE_ISSUANCE_CHANGED')
    actual=signed_exact_json(raw)
    approved=reviewed.issuance_proofs[case]
    if a['issuanceReceiptSha256']!=approved['receiptSha256']:raise ValueError('LIFECYCLE_ISSUANCE_NOT_REVIEWED')
    response_raw=signed_private_read(path.with_name(case+'-issued-response-private.json'))
    if hashlib.sha256(response_raw).hexdigest()!=approved['responseSha256']:raise ValueError('LIFECYCLE_ISSUANCE_RESPONSE_CHANGED')
    response=signed_exact_json(response_raw)
    if (not isinstance(response,dict)or response.get('access_token')!=a['accessToken']
            or response.get('token_type')!='bearer' or not isinstance(response.get('user'),dict)
            or response['user'].get('id')!=a['userId']or response['user'].get('is_anonymous')is not(case=='anonymousBearer')):
        raise ValueError('LIFECYCLE_ISSUANCE_ORIGINAL_RESPONSE')
    expected={'version':1,'kind':'GOTRUE_ORIGINAL_TOKEN_ISSUED','scopeId':value['scopeId'],'case':case,
              'userId':a['userId'],'sessionId':a['sessionId'],'tokenSha256':hashlib.sha256(a['accessToken'].encode()).hexdigest(),
              'origin':binding['origin'],'authContainerId':binding['containers']['auth']['id'],
              'authImage':binding['containers']['auth']['image'],'issuedAt':signed_claims(a['accessToken'])['iat'],
              'expiresAt':a['expiresAt'],'httpStatus':200,'responseSha256':approved['responseSha256'],
              'wire':'POST /signup'if case=='anonymousBearer'else'POST /token?grant_type=password'}
    if actual!=expected or type(actual['version'])is not int or type(actual['httpStatus'])is not int:
        raise ValueError('LIFECYCLE_ISSUANCE_PROVENANCE')
    return expected


class SignedAuthLifecycleRunner(SignedRunner):
    """별도 preprovisioned 원 토큰만 사용한다. 생성·설정 변경·삭제·세션 복구는 하지 않는다."""
    def __init__(self, root, binding, value=None):
        super().__init__(root,binding);self.lifecycle=value;self.mutations=set();self.children=[]
        if value is not None:self.evidence=Path(value['evidenceRoot'])
    read_sql=SignedMidnightRunner.read_sql
    original_rows=SignedMidnightRunner.original_rows
    closed_controls=FixedSignedProvisioningPorts.closed_controls
    memory_kib=FixedSignedProvisioningPorts.memory_kib

    def snapshot(self):
        value=FixedSignedProvisioningPorts.snapshot(self)
        constraints=self.read_sql("select coalesce(jsonb_agg(to_jsonb(c)order by oid),'[]'::jsonb)from pg_constraint c;",timeout=5)
        value['constraintsSha256']=hashlib.sha256(constraints.encode()).hexdigest()
        return value

    def live(self):
        if self.binding['sourcePins']!=signed_source_pins():raise ValueError('LIFECYCLE_SOURCE_CHANGED')
        if hasattr(self,'reviewed_head'):
            current=subprocess.check_output(['git','-C',str(REPO),'rev-parse','HEAD'],timeout=5,text=True).strip()
            if current!=self.reviewed_head:raise ValueError('LIFECYCLE_SOURCE_HEAD_CHANGED')
        self.signed_identity()
        controls=self.closed_controls()
        if set(controls)!=set(PROVISION_CLOSED_CONTROLS)|{'cronLaunchActiveJobs'}or controls['cronLaunchActiveJobs']!='off'or any(controls[k]is not False for k in PROVISION_CLOSED_CONTROLS):
            raise ValueError('LIFECYCLE_CONTROLS_NOT_CLOSED')

    def http(self, method, path, token, payload=None):
        known={a['accessToken']for a in self.binding['accounts']}
        if self.lifecycle is not None:known.update(a['accessToken']for a in self.lifecycle['accounts'].values()if a is not None)
        credential=self.binding['credentials']['anon']
        if method=='GET'and path=='/user':
            if token not in known or payload is not None:raise ValueError('LIFECYCLE_HTTP_SCOPE')
        elif method=='POST'and path=='/logout?scope=local'and self.lifecycle is not None:
            if token!=self.lifecycle['accounts']['revokedSession']['accessToken']or payload!={}:raise ValueError('LIFECYCLE_HTTP_SCOPE')
        elif method=='PUT'and self.lifecycle is not None and path=='/admin/users/'+self.lifecycle['accounts']['memberChanged']['userId']:
            credential=self.binding['credentials']['service']
            if token!=credential or payload!={'ban_duration':'1h'}:raise ValueError('LIFECYCLE_HTTP_SCOPE')
        else:raise ValueError('LIFECYCLE_HTTP_SCOPE')
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args):return None
        request=urllib.request.Request(self.binding['origin']+'/auth/v1'+path,data=None if payload is None else json.dumps(payload).encode(),method=method,
            headers={'authorization':'Bearer '+token,'apikey':credential,'content-type':'application/json'})
        try:
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
            try:
                with opener.open(request,timeout=5)as response:status=response.status;raw=response.read(65537)
            except urllib.error.HTTPError as error:status=error.code;raw=error.read(65537)
            if len(raw)>65536:raise ValueError()
            body=signed_exact_json(raw)if raw else{}
            if not isinstance(body,dict):raise ValueError()
            return status,body
        except Exception:raise ValueError('LIFECYCLE_HTTP_OUTCOME_UNKNOWN')from None

    def verify_token(self, case, account, scoped=True):
        status,user=self.http('GET','/user',account['accessToken'])
        anonymous=case=='anonymousBearer'
        if status!=200 or user.get('id')!=account['userId']or user.get('role')!='authenticated' or user.get('is_anonymous')is not anonymous:
            raise ValueError('LIFECYCLE_ACTUAL_ORIGINAL_AUTH')
        predicate=''
        if scoped:
            meta={'fixture_scope_id':self.lifecycle['scopeId'],'fixture_case':case}
            if any(user.get('user_metadata',{}).get(k)!=v for k,v in meta.items()):raise ValueError('LIFECYCLE_USER_SCOPE')
            predicate=' and u.raw_user_meta_data @> '+quote(json.dumps(meta))+'::jsonb'
        if not anonymous:
            predicate+=' and exists(select 1 from public.profiles p join private.member_episodes e on e.profile_id=p.id where p.id=u.id and e.ended_at is null and e.identity_id is null)'
        email=('coalesce(u.email,\'\')'if anonymous else'u.email')+'='+quote(account['authEmail'])
        query='select exists(select 1 from auth.users u join auth.sessions s on s.user_id=u.id where u.id='+quote(account['userId'])+'::uuid and s.id='+quote(account['sessionId'])+'::uuid and '+email+' and u.role='+quote('authenticated')+' and u.is_anonymous='+('true'if anonymous else'false')+predicate+');'
        # 익명 사용자의 DB email은 빈 문자열 또는 NULL이다.
        if self.read_sql(query,timeout=3)!='t':raise ValueError('LIFECYCLE_ACTUAL_DATABASE_SESSION')
        return {'userId':account['userId'],'sessionId':account['sessionId'],'tokenSha256':hashlib.sha256(account['accessToken'].encode()).hexdigest(),'authHttpStatus':200,'actualDatabaseSession':True}

    def preservation_rows(self):
        """각 허용 행만 제외하고 모든 기존 행과 중복 수를 비교한다. 새 감사 행은 별도 1회 증명한다."""
        v=self.lifecycle;revoke=v['accounts']['revokedSession'];ban=v['accounts']['memberChanged']
        conditions={'auth.users':'r.id<>'+quote(ban['userId'])+'::uuid',
            'auth.sessions':'r.id<>'+quote(revoke['sessionId'])+'::uuid',
            'auth.refresh_tokens':'r.session_id is distinct from '+quote(revoke['sessionId'])+'::uuid',
            'auth.mfa_amr_claims':'r.session_id is distinct from '+quote(revoke['sessionId'])+'::uuid',
            'auth.audit_log_entries':"not (((r.payload->>'action'='logout'and r.payload->>'actor_id'="+quote(revoke['userId'])+")or(r.payload->>'action'='user_modified'and r.payload->'traits'->>'user_id'="+quote(ban['userId'])+')) is true)'}
        tables=signed_exact_json(self.read_sql("select jsonb_agg(jsonb_build_array(schemaname,tablename)order by schemaname,tablename)from pg_tables where schemaname in('auth','public','private','storage');",timeout=5));result={}
        for schema,table in tables:
            identifier=lambda name:'"'+name.replace('"','""')+'"'
            key=schema+'.'+table
            query="select coalesce(jsonb_object_agg(h,n),'{}'::jsonb)from(select encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')h,count(*)n from "+identifier(schema)+'.'+identifier(table)+' r where '+conditions.get(key,'true')+' group by 1)s;'
            result[key]=signed_exact_json(self.read_sql(query,timeout=5))
        return result

    def mutation_state(self):
        v=self.lifecycle;revoke=v['accounts']['revokedSession'];ban=v['accounts']['memberChanged']
        return signed_exact_json(self.read_sql("select jsonb_build_object('user',(select to_jsonb(u)from auth.users u where id="+quote(ban['userId'])+"::uuid),'revokedSession',(select to_jsonb(s)from auth.sessions s where id="+quote(revoke['sessionId'])+"::uuid),'revokedRefreshCount',(select count(*)from auth.refresh_tokens where session_id="+quote(revoke['sessionId'])+"::uuid),'revokedAmrCount',(select count(*)from auth.mfa_amr_claims where session_id="+quote(revoke['sessionId'])+"::uuid),'logoutAudit',(select count(*)from auth.audit_log_entries r where r.payload->>'action'='logout'and r.payload->>'actor_id'="+quote(revoke['userId'])+"),'banAudit',(select count(*)from auth.audit_log_entries r where r.payload->>'action'='user_modified'and r.payload->'traits'->>'user_id'="+quote(ban['userId'])+"),'banActive',(select coalesce(banned_until>clock_timestamp(),false)from auth.users where id="+quote(ban['userId'])+'::uuid));',timeout=3))

    def mutate_once(self, case):
        if case not in('revokedSession','memberChanged')or case in self.mutations:raise ValueError('LIFECYCLE_MUTATION_REPLAY')
        self.live();a=self.lifecycle['accounts'][case];self.verify_token(case,a)
        self.save_signed(case.lower()+'-mutation-intent.json',{'case':case,'scopeId':self.lifecycle['scopeId'],'userId':a['userId'],'sessionId':a['sessionId'],'tokenSha256':hashlib.sha256(a['accessToken'].encode()).hexdigest(),'singleAttempt':True,'retryAllowed':False})
        self.mutations.add(case)
        try:
            status,body=self.http('POST','/logout?scope=local',a['accessToken'],{})if case=='revokedSession'else self.http('PUT','/admin/users/'+a['userId'],self.binding['credentials']['service'],{'ban_duration':'1h'})
            if status!=(204 if case=='revokedSession'else 200)or(case=='memberChanged'and body.get('id')!=a['userId']):raise ValueError('LIFECYCLE_MUTATION_RESPONSE')
        except BaseException:
            self.save_signed(case.lower()+'-mutation-outcome.json',{'status':'UNKNOWN','retryAllowed':False,'readOnlyResolutionRequired':True})
            raise
        self.save_signed(case.lower()+'-mutation-outcome.json',{'status':'HTTP_OBSERVED','httpStatus':status,'retryAllowed':False})

    def dependent_rows(self):
        session=self.lifecycle['accounts']['revokedSession']['sessionId'];result={}
        for table in('refresh_tokens','mfa_amr_claims'):
            result[table]=signed_exact_json(self.read_sql("select coalesce(jsonb_object_agg(h,n),'{}'::jsonb)from(select encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')h,count(*)n from auth."+table+' r where session_id='+quote(session)+'::uuid group by 1)s;',timeout=3))
        return result

    def verify_final(self, baseline, rows, state, dependent, foreign=None, foreign_baseline=None):
        self.live();current=self.snapshot()
        if any(current[key]!=baseline[key]for key in('authoritySha256','constraintsSha256'))or self.preservation_rows()!=rows:
            raise ValueError('LIFECYCLE_ORIGINAL_ROWS_AUTHORITY_CHANGED')
        actual=self.mutation_state();before=dict(state['user']);after=dict(actual['user'])if actual['user']is not None else{}
        for column in('banned_until','updated_at'):before.pop(column,None);after.pop(column,None)
        if before!=after or actual['logoutAudit']not in(0,1)or actual['banAudit']not in(0,1):raise ValueError('LIFECYCLE_MUTATION_OVERFLOW')
        current_dependent=self.dependent_rows()
        if 'revokedSession'not in self.mutations:
            if actual['revokedSession']!=state['revokedSession']or current_dependent!=dependent:raise ValueError('LIFECYCLE_ORIGINAL_SESSION_CHANGED')
        elif(actual['revokedSession']is not None or actual['revokedRefreshCount']!=0 or actual['revokedAmrCount']!=0 or any(current_dependent.values())):
            raise ValueError('LIFECYCLE_REVOCATION_CASCADE_UNPROVEN')
        if 'memberChanged'not in self.mutations and actual['user']!=state['user']:raise ValueError('LIFECYCLE_ORIGINAL_USER_CHANGED')
        if foreign is not None and foreign.snapshot()!=foreign_baseline:raise ValueError('LIFECYCLE_FOREIGN_ROWS_CHANGED')

    def invoke_case(self, case, account, node):
        self.live();key=uuid.uuid4().hex
        code_root,factory_path=lifecycle_runner_factory_paths(self)
        fixture={'codeRoot':str(code_root),'origin':self.binding['origin'],'anon':self.binding['credentials']['anon'],'service':self.binding['credentials']['service'],
            'signedLocalAuth':True,'authLifecycleScenario':True,'lifecycleCase':case,'originalUserId':account['userId'],'originalToken':account['accessToken'],
            'productManifest':product_graph(),'aiLedgerId':'synthetic-lifecycle-never-reserved'}
        self.save_signed('factory-'+key+'.json',fixture)
        argv=[node,'--experimental-strip-types',str(factory_path),str(self.evidence/('factory-'+key+'.json')),'--signed-auth-lifecycle-case']
        self.save_signed('factory-'+key+'-intent.json',{'case':case,'singleAttempt':True,'argvSha256':hashlib.sha256(json.dumps(argv).encode()).hexdigest()})
        child=None
        try:
            child=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE);self.children.append(child)
            raw,error=child.communicate(timeout=30)
            self.save_signed('factory-'+key+'-outcome.json',{'exitCode':child.returncode,'stdoutSha256':hashlib.sha256(raw).hexdigest(),'stderrSha256':hashlib.sha256(error).hexdigest()})
            if child.returncode or len(raw)>65536:raise ValueError('LIFECYCLE_FACTORY_FAILED')
            result=signed_exact_json(raw)
            if result!={'status':'PASS','case':case,'httpStatus':401,'authHttpStatus':200 if case=='anonymousBearer'else result.get('authHttpStatus'),'actualAuthReads':1,'rpcCalls':0,'providerCalls':0,'nativeExternalAttempts':0,
                'originalTokenSha256':hashlib.sha256(account['accessToken'].encode()).hexdigest(),'actualNaver':'NOT_RUN','externalProvider':'NOT_RUN'}or result.get('authHttpStatus')not in([200]if case=='anonymousBearer'else[401,403]):
                raise ValueError('LIFECYCLE_FACTORY_PROOF')
            if any(type(result[k])is not int for k in('httpStatus','authHttpStatus','actualAuthReads','rpcCalls','providerCalls','nativeExternalAttempts')):raise ValueError('LIFECYCLE_FACTORY_PROOF')
            return result
        finally:
            if child is not None and child.poll()is None:
                child.terminate()
                try:child.communicate(timeout=5)
                except subprocess.TimeoutExpired:child.kill();child.communicate(timeout=5)
            try:self.save_signed('factory-'+key+'-closed.json',{'exited':child is None or child.poll()is not None,'exactPopenOnly':True,'started':child is not None})
            finally:lifecycle_runner_factory_paths(self)


def lifecycle_natural_expiry(account, now=time.time, sleep=time.sleep):
    # 인증 성공 후 같은 원 서명 토큰의 자연 시간만 기다린다.
    start=time.monotonic();remaining=account['expiresAt']-now()
    if not 0<remaining<=60:raise ValueError('LIFECYCLE_NATURAL_EXPIRY_WINDOW')
    while now()<account['expiresAt']:
        if time.monotonic()-start>=60:raise ValueError('LIFECYCLE_NATURAL_EXPIRY_TIMEOUT')
        sleep(min(.25,account['expiresAt']-now()))
    if time.monotonic()-start>60:raise ValueError('LIFECYCLE_NATURAL_EXPIRY_TIMEOUT')


def signed_auth_lifecycle_main():
    parser=argparse.ArgumentParser();parser.add_argument('--signed-auth-lifecycle',action='store_true',required=True)
    parser.add_argument('--signed-auth-binding',type=Path);parser.add_argument('--lifecycle-input',type=Path);parser.add_argument('--prepared-root',type=Path)
    parser.add_argument('--node',default=shutil.which('node'));parser.add_argument('--run',action='store_true');options=parser.parse_args()
    if not options.run or not options.signed_auth_binding or not options.lifecycle_input or not options.prepared_root:
        print(json.dumps({'status':'NOT_RUN','scope':LIFECYCLE_KIND,'actualCalls':0,'privateInputRequired':True}));return
    root=options.prepared_root;target=signed_prepared_target(root)
    raw=signed_private_read(options.signed_auth_binding);binding=validate_signed_binding(signed_exact_json(raw),root,target)
    input_raw=signed_private_read(options.lifecycle_input)
    value=validate_lifecycle_input(signed_exact_json(input_raw),root,binding,hashlib.sha256(raw).hexdigest())
    # --run이나 JSON flags는 고정 검토 코드 객체/실제 슬롯의 대체가 아니다.
    print(json.dumps({'status':'NOT_RUN','scope':LIFECYCLE_KIND,'actualCalls':0,'privateInputsValidated':True,
        'bindingSha256':hashlib.sha256(raw).hexdigest(),'inputSha256':hashlib.sha256(input_raw).hexdigest(),
        'executionAllowed':False,'reason':'ROOT_REVIEWED_CODE_OBJECT_REQUIRED'}))


def run_signed_auth_lifecycle(reviewed, binding, value, node):
    if (type(reviewed)is not ReviewedSignedAuthLifecycle or not isinstance(reviewed.decision_id,str)
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}',reviewed.decision_id)):
        raise ValueError('LIFECYCLE_REVIEWED_CODE_REQUIRED')
    root=reviewed.prepared_root
    validate_lifecycle_reviewed_paths(reviewed,value)
    binding_bytes=signed_private_read(reviewed.binding_path);input_bytes=signed_private_read(reviewed.input_path)
    if (hashlib.sha256(binding_bytes).hexdigest()!=reviewed.binding_sha256 or hashlib.sha256(input_bytes).hexdigest()!=reviewed.input_sha256
            or signed_exact_json(binding_bytes)!=binding or signed_exact_json(input_bytes)!=value):
        raise ValueError('LIFECYCLE_REVIEWED_PRIVATE_BYTES_CHANGED')
    if reviewed.source_pins!=binding['sourcePins']or reviewed.containers!=binding['containers']:
        raise ValueError('LIFECYCLE_REVIEWED_BINDING')
    # CLI에서 안정적으로 읽은 원 바이트 SHA와 검토 객체를 묶는다. 실제 실행 전 HEAD 바이트도 검증한다.
    for digest in(reviewed.binding_sha256,reviewed.input_sha256):
        if not isinstance(digest,str)or not re.fullmatch(r'[a-f0-9]{64}',digest):raise ValueError('LIFECYCLE_REVIEWED_BINDING')
    if value['signedBindingSha256']!=reviewed.binding_sha256:raise ValueError('LIFECYCLE_REVIEWED_BINDING')
    validate_lifecycle_input(value,root,binding,reviewed.binding_sha256)
    validate_signed_binding(binding,root,signed_prepared_target(root))
    if not all(binding[k]and value[k]for k in('approvedByRoot','dockerSlotReady')):raise ValueError('LIFECYCLE_APPROVAL_SLOT_REQUIRED')
    required={case for case,a in value['accounts'].items()if a is not None}
    if not isinstance(reviewed.issuance_proofs,dict)or set(reviewed.issuance_proofs)!=required:
        raise ValueError('LIFECYCLE_REVIEWED_ACTUAL_ISSUANCE_REQUIRED')
    for proof in reviewed.issuance_proofs.values():
        if (not isinstance(proof,dict)or set(proof)!={'receiptSha256','responseSha256'}
                or any(not isinstance(d,str)or not re.fullmatch(r'[a-f0-9]{64}',d)for d in proof.values())):
            raise ValueError('LIFECYCLE_REVIEWED_ACTUAL_ISSUANCE_REQUIRED')
    if value['foreign']is not None and(not isinstance(reviewed.foreign_receipt_sha256,str)or not re.fullmatch(r'[a-f0-9]{64}',reviewed.foreign_receipt_sha256)):
        raise ValueError('LIFECYCLE_REVIEWED_FOREIGN_ISSUANCE_REQUIRED')
    source_head=provisioning_source_check(reviewed.source_pins)
    if not node or not Path(node).is_file():raise ValueError('NODE_REQUIRED')
    r=SignedAuthLifecycleRunner(root,binding,value);r.evidence.mkdir(mode=0o700,exist_ok=False)
    r.reviewed_head=source_head
    authority=getattr(reviewed,'dispatch_authority',None)
    if type(authority)is ReviewedLifecycleDispatch:
        lifecycle_dispatch_capsule(authority);r.dispatch_authority=authority
    proofs={k:{'status':'NOT_RUN'}for k in LIFECYCLE_CASES};foreign=None;errors=[];done=threading.Event()
    def interrupted(*args):raise RuntimeError('LIFECYCLE_OWN_PROCESS_TERMINATED')
    signal.signal(signal.SIGTERM,interrupted)
    def memory(minimum):
        began=time.monotonic();kib=r.memory_kib()
        if type(kib)is not int or kib<minimum or time.monotonic()-began>3:raise ValueError('LIFECYCLE_MEMORY_GUARD')
        return kib
    def monitor():
        while not done.is_set():
            began=time.monotonic()
            try:memory(786432)
            except BaseException:
                errors.append('LIFECYCLE_MEMORY_MONITOR_FAILED');os.kill(os.getpid(),signal.SIGTERM);return
            done.wait(max(0,began+3-time.monotonic()))
    observer=threading.Thread(target=monitor,daemon=True);baseline=None;state=None
    try:
        memory(1048576);observer.start();r.live();signed_verify_history(r)
        for account in binding['accounts']:r.verify_token('baseline',account,scoped=False)
        for case,account in value['accounts'].items():
            if account is not None:
                lifecycle_issuance(root,binding,value,case,reviewed);r.verify_token(case,account)
                if case!='expiredBearer'and account['expiresAt']<time.time()+180:raise ValueError('LIFECYCLE_VALID_TOKEN_HEADROOM')
        baseline=r.snapshot();rows=r.preservation_rows();state=r.mutation_state();dependent=r.dependent_rows()
        if state['user']is None or state['user'].get('banned_until')is not None or state['revokedSession']is None or state['logoutAudit']!=0 or state['banAudit']!=0 or state['banActive']is not False:
            raise ValueError('LIFECYCLE_FRESH_MUTATION_BASELINE')
        r.save_signed('baseline-private.json',{'snapshot':baseline,'preservationRows':rows,'mutationState':state,'dependentRows':dependent,'sourcePins':binding['sourcePins']})
        spec=value['foreign']
        if spec is not None:
            other_root=Path(spec['preparedRoot']);other_raw=signed_private_read(Path(spec['bindingPath']))
            if hashlib.sha256(other_raw).hexdigest()!=spec['bindingSha256']:raise ValueError('LIFECYCLE_FOREIGN_BINDING_CHANGED')
            other_binding=validate_signed_binding(signed_exact_json(other_raw),other_root,signed_prepared_target(other_root))
            scope=Path(other_binding['evidenceRoot']).name.removeprefix('signed-auth-')
            if not re.fullmatch(r'[a-f0-9]{32}',scope):raise ValueError('LIFECYCLE_FOREIGN_PROVISION_SCOPE')
            receipt_raw=signed_private_read(other_root/('auth-provision-'+scope)/'receipt.json')
            if hashlib.sha256(receipt_raw).hexdigest()!=reviewed.foreign_receipt_sha256:raise ValueError('LIFECYCLE_FOREIGN_ISSUANCE_CHANGED')
            receipt=signed_exact_json(receipt_raw)
            if(receipt.get('status')!='PASS_LOCAL_AUTH6_PROVISION_ONLY'or receipt.get('scopeId')!=scope or receipt.get('accounts')!=6
                    or receipt.get('bindingSha256')!=spec['bindingSha256']or receipt.get('actualGoTrueAndDatabaseSessions')is not True):
                raise ValueError('LIFECYCLE_FOREIGN_ISSUANCE_PROVENANCE')
            if other_binding['origin']==binding['origin']or any(other_binding['containers'][k]['id']==binding['containers'][k]['id']for k in('db','auth')):
                raise ValueError('LIFECYCLE_FOREIGN_CONTEXT_NOT_DISTINCT')
            foreign=SignedAuthLifecycleRunner(other_root,other_binding);foreign.live();signed_verify_history(foreign)
            selected=[a for a in other_binding['accounts']if a['userId']==spec['userId']]
            if len(selected)!=1:raise ValueError('LIFECYCLE_FOREIGN_ORIGINAL_ACCOUNT')
            foreign.verify_token('foreign',selected[0],scoped=False);foreign_baseline=foreign.snapshot()
            proofs['differentOriginalContext']=r.invoke_case('differentOriginalContext',selected[0],node)
        expired=value['accounts']['expiredBearer'];r.verify_token('expiredBearer',expired)
        lifecycle_natural_expiry(expired);proofs['expiredBearer']=r.invoke_case('expiredBearer',expired,node)
        for case in('revokedSession','memberChanged'):
            r.mutate_once(case);actual=r.mutation_state()
            if (case=='revokedSession'and(actual['revokedSession']is not None or actual['revokedRefreshCount']!=0 or actual['revokedAmrCount']!=0 or actual['logoutAudit']!=1))or(case=='memberChanged'and(actual['banActive']is not True or actual['banAudit']!=1)):
                raise ValueError('LIFECYCLE_MUTATION_ACTUAL_STATE')
            proofs[case]=r.invoke_case(case,value['accounts'][case],node)
        anonymous=value['accounts']['anonymousBearer']
        if anonymous is not None:proofs['anonymousBearer']=r.invoke_case('anonymousBearer',anonymous,node)
    except BaseException as error:
        errors.append(str(error)if type(error)is ValueError and re.fullmatch(r'LIFECYCLE_[A-Z_]+',str(error))else'LIFECYCLE_EXECUTION_FAILED')
        for case in r.mutations:
            if proofs[case]['status']=='NOT_RUN':proofs[case]={'status':'UNKNOWN','retryAllowed':False}
    finally:
        done.set()
        if observer.ident is not None:
            observer.join(timeout=4)
            if observer.is_alive():errors.append('LIFECYCLE_MONITOR_UNCLOSED')
        # 원 세션을 복구하지 않고 실패 때도 독립적으로 저장 상태를 비교한다.
        if baseline is not None:
            try:
                r.verify_final(baseline,rows,state,dependent,foreign,foreign_baseline if foreign is not None else None)
            except BaseException:errors.append('LIFECYCLE_FINAL_PRESERVATION_UNPROVEN')
        else:errors.append('LIFECYCLE_BASELINE_NOT_CAPTURED')
        r.save_signed('receipt.json',{'status':'FAIL'if errors else'PASS_PARTIAL'if any(p['status']=='NOT_RUN'for p in proofs.values())else'PASS',
            'scope':LIFECYCLE_KIND,'cases':proofs,'fixedFailures':errors,'fullLifecycleCoverage':'NOT_RUN'if errors or any(p['status']=='NOT_RUN'for p in proofs.values())else'PASS',
            'authMutationsRetained':sorted(r.mutations),'noSessionResurrection':True,'noMutationReplay':True,'originalBaselineSixPreserved':baseline is not None and not errors,
            'memberChangedMeaning':'AUTH_USER_BANNED_ONLY','serviceMemberRetirement':'NOT_RUN','consentRevocation':'NOT_RUN',
            'containerLifecycle':'UNCHANGED_NOT_STOPPED_BY_RUNNER','sequence':'NOT_VERIFIED','physical':'NOT_VERIFIED','actualNaver':'NOT_RUN','externalProvider':'NOT_RUN','naturalMidnight':'NOT_RUN'})
    result=signed_exact_json(signed_private_read(r.evidence/'receipt.json'));print(json.dumps(result))
    if errors:raise ValueError('LIFECYCLE_FAILED_PRIVATE_EVIDENCE_PRESERVED')


LCP_TABLES=PROVISION_OWNED_TABLES+('auth.mfa_amr_claims',)
LCP_CODES=('LCP_REVIEWED_CODE_REQUIRED','LCP_PREVIOUS_ATTEMPT','LCP_PRIVATE_SCOPE','LCP_STATE_BINDING',
    'LCP_FRESH_EMPTY_REQUIRED','LCP_SETTINGS_REQUIRED','LCP_CLOSED_REQUIRED','LCP_RESOURCE_GUARD',
    'LCP_MONITOR_FAILED','LCP_MONITOR_UNCLOSED','LCP_HTTP_UNKNOWN','LCP_CREATE_PROOF','LCP_LOGIN_PROOF',
    'LCP_AUTH_PROOF','LCP_PROFILE_PROOF','LCP_ROWS_CHANGED','LCP_AUTHORITY_CHANGED','LCP_OWNED_SCOPE',
    'LCP_WINDOW_REQUIRED','LCP_HEAD_CHANGED','LCP_CLEANUP_UNKNOWN','LCP_FAILED')


class ReviewedLifecycleProvisioning:
    """검토된 코드 객체 전용. JSON/CLI는 발급 권한·대상·포트를 선택할 수 없다."""
    def __init__(self,decision_id,prepared_root,source_pins,containers,credentials,scope_id,ports=None):
        self.decision_id=decision_id;self.prepared_root=Path(prepared_root);self.source_pins=source_pins
        self.containers=containers;self.credentials=credentials;self.scope_id=scope_id;self.ports=ports


def lcp_save_bytes(root,name,data):
    if not re.fullmatch(r'[A-Za-z0-9-]+\.json',name)or not isinstance(data,bytes)or len(data)>8*1024*1024:
        raise ValueError('LCP_PRIVATE_SCOPE')
    if root.resolve()!=root or root.is_symlink():raise ValueError('LCP_PRIVATE_SCOPE')
    s=root.lstat()
    if not stat.S_ISDIR(s.st_mode)or s.st_uid!=os.getuid()or stat.S_IMODE(s.st_mode)!=0o700:raise ValueError('LCP_PRIVATE_SCOPE')
    # 기존 stable FD 검사를 부모에 적용한 뒤 O_EXCL로 첫 전송 journal만 만든다.
    for p in root.parents:
        if p==Path('/private/tmp'):break
        s=p.lstat()
        if not stat.S_ISDIR(s.st_mode)or s.st_uid!=os.getuid()or stat.S_IMODE(s.st_mode)!=0o700:raise ValueError('LCP_PRIVATE_SCOPE')
    else:raise ValueError('LCP_PRIVATE_SCOPE')
    fd=os.open(root/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb')as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
    for p in(root,root.parent):
        fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
    saved=signed_private_read(root/name)
    if saved!=data:raise ValueError('LCP_PRIVATE_SCOPE')
    return hashlib.sha256(saved).hexdigest()


def lcp_save(root,name,value):
    return lcp_save_bytes(root,name,json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode())


def lcp_binding(reviewed):
    if(type(reviewed)is not ReviewedLifecycleProvisioning or not isinstance(reviewed.decision_id,str)
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}',reviewed.decision_id)
            or not isinstance(reviewed.scope_id,str)or not re.fullmatch(r'[a-f0-9]{32}',reviewed.scope_id)):
        raise ValueError('LCP_REVIEWED_CODE_REQUIRED')
    root=reviewed.prepared_root
    manifest=signed_private_read(root/'database-manifest.json')
    port=signed_exact_json(manifest)['config_overlay']['api.port']
    if type(port)is not int or not 1<=port<=65535:raise ValueError('LCP_STATE_BINDING')
    target=signed_prepared_target(root);origin='http://127.0.0.1:'+str(port)
    provisioning_metadata(reviewed,target,origin)
    head=provisioning_source_check(reviewed.source_pins)
    return {'version':1,'kind':'STAGED_LIFECYCLE_ORIGINAL_ISSUANCE','scopeId':reviewed.scope_id,
        'preparedRoot':str(root),'manifestSha256':hashlib.sha256(manifest).hexdigest(),'sourceHead':head,
        'sourcePins':reviewed.source_pins,'target':target,'containers':reviewed.containers,'origin':origin,
        'credentialSha256':{k:hashlib.sha256(v.encode()).hexdigest()for k,v in reviewed.credentials.items()},
        'decisionId':reviewed.decision_id}


def lcp_snapshot(value):
    if not isinstance(value,dict)or set(value)!={'rows','authoritySha256','constraintsSha256','catalogSha256'}:
        raise ValueError('LCP_OWNED_SCOPE')
    if any(not isinstance(value[k],str)or not re.fullmatch(r'[a-f0-9]{64}',value[k])for k in('authoritySha256','constraintsSha256','catalogSha256')):
        raise ValueError('LCP_OWNED_SCOPE')
    rows=value['rows']
    required=set(LCP_TABLES)|{'private.'+t for t in PROTECTED_BUDGET}
    if not isinstance(rows,dict)or not required.issubset(rows):raise ValueError('LCP_OWNED_SCOPE')
    for table,bag in rows.items():
        if (table not in('cron.job','cron.job_run_details','vault.secrets')and not re.fullmatch(r'(auth|public|private|storage)\.[a-z_][a-z_0-9]*',table))or not isinstance(bag,dict):raise ValueError('LCP_OWNED_SCOPE')
        if any(not re.fullmatch(r'[a-f0-9]{64}',h)or type(n)is not int or n<1 for h,n in bag.items()):raise ValueError('LCP_OWNED_SCOPE')
    return value


def lcp_added_scope(baseline,current,added,accounts):
    lcp_snapshot(baseline);lcp_snapshot(current)
    if any(current[k]!=baseline[k]for k in('authoritySha256','constraintsSha256','catalogSha256')):
        raise ValueError('LCP_AUTHORITY_CHANGED')
    if set(current['rows'])!=set(baseline['rows'])or set(added)!=set(LCP_TABLES):raise ValueError('LCP_OWNED_SCOPE')
    users={a['userId']for a in accounts}
    if len(users)!=len(accounts):raise ValueError('LCP_OWNED_SCOPE')
    for table,bag in current['rows'].items():
        expected=dict(baseline['rows'][table])
        if table in added:
            entries=added[table];owners={u:[]for u in users}
            if len(entries)!=len(users)*(2 if table=='auth.audit_log_entries'else 1):raise ValueError('LCP_OWNED_SCOPE')
            for key,row in entries.items():
                if(not isinstance(key,str)or not key or len(key)>512 or not isinstance(row,dict)
                        or set(row)!={'rowSha256','ownerUserId','operation'}or row['ownerUserId']not in users
                        or not re.fullmatch(r'[a-f0-9]{64}',row['rowSha256'])or row['rowSha256']in baseline['rows'][table]):
                    raise ValueError('LCP_OWNED_SCOPE')
                owners[row['ownerUserId']].append(row['operation']);h=row['rowSha256'];expected[h]=expected.get(h,0)+1
            required=['login','user_signedup']if table=='auth.audit_log_entries'else['row']
            if any(sorted(ops)!=required for ops in owners.values()):raise ValueError('LCP_OWNED_SCOPE')
        if expected!=bag:raise ValueError('LCP_ROWS_CHANGED')


class FixedLifecycleProvisioningPorts(FixedSignedProvisioningPorts):
    """같은 고정 서비스에만 실제 원 HTTP bytes/SQL을 전달한다. 시간·서비스 설정은 변경하지 않는다."""
    def __init__(self,reviewed):
        super().__init__(reviewed);self.runner.binding['sourcePins']=reviewed.source_pins
    def original_rows(self):
        """native119 전체178: 기존 네 schema에 cron/vault를 포함하며 원문 없이 행 해시 bag만 읽는다."""
        tables=json.loads(self.read_sql("select jsonb_agg(jsonb_build_array(schemaname,tablename)order by schemaname,tablename)from pg_tables where schemaname in('auth','public','private','storage','cron','vault');",timeout=5))
        schemas={'auth','public','private','storage','cron','vault'}
        if (not isinstance(tables,list)or any(type(row)is not list or len(row)!=2
                or any(type(v)is not str or not re.fullmatch('[A-Za-z_][A-Za-z_0-9]*',v)for v in row)or row[0]not in schemas for row in tables)
                or len({tuple(row)for row in tables})!=len(tables)):raise ValueError('LCP_FULL_TABLE_INVENTORY')
        if not tables:return {}
        terms=[]
        for schema,table in tables:
            identifier=lambda v:'"'+v.replace('"','""')+'"'
            bag="select coalesce(jsonb_object_agg(h,n),'{}'::jsonb)from(select encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')h,count(*)n from "+identifier(schema)+'.'+identifier(table)+' r group by 1)s'
            terms.append("select '"+schema+'.'+table+"'::text table_name,("+bag+')bag')
        query='select jsonb_object_agg(table_name,bag)from('+' union all '.join(terms)+')q;'
        result=signed_exact_json(self.read_sql(query,timeout=5))
        if type(result)is not dict or set(result)!={schema+'.'+table for schema,table in tables}:raise ValueError('LCP_FULL_ROW_BAGS')
        for bag in result.values():
            if type(bag)is not dict or any(type(h)is not str or not re.fullmatch('[a-f0-9]{64}',h)or type(n)is not int or n<=0 for h,n in bag.items()):raise ValueError('LCP_FULL_ROW_BAGS')
        return result
    def history(self):return signed_verify_history(self.runner)
    def settings(self):
        result=subprocess.run(self.base+['inspect',self.reviewed.containers['auth']['id']],capture_output=True,timeout=3)
        if result.returncode or len(result.stdout)>1024*1024:raise ValueError('LCP_SETTINGS_REQUIRED')
        values=json.loads(result.stdout)
        if len(values)!=1 or values[0]['Id']!=self.reviewed.containers['auth']['id']:raise ValueError('LCP_SETTINGS_REQUIRED')
        env=values[0]['Config']['Env'];keys=('GOTRUE_JWT_EXP','GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED','GOTRUE_DISABLE_SIGNUP')
        selected={}
        for key in keys:
            found=[v.split('=',1)[1]for v in env if v.startswith(key+'=')]
            if len(found)!=1:raise ValueError('LCP_SETTINGS_REQUIRED')
            selected[key]=found[0]
        if selected!={keys[0]:'3600',keys[1]:'false',keys[2]:'true'}:raise ValueError('LCP_SETTINGS_REQUIRED')
        return {'jwtExpirySeconds':3600,'anonymousEnabled':False,'signupDisabled':True}
    def snapshot(self):
        value=super().snapshot()
        constraints=self.read_sql("select coalesce(jsonb_agg(to_jsonb(c)order by oid),'[]'::jsonb)from pg_constraint c;",timeout=5)
        value['constraintsSha256']=hashlib.sha256(constraints.encode()).hexdigest()
        # relpages/reltuples 같은 실행 통계는 제외하되 빈 테이블의 컬럼/타입/기본값 변경도 거절한다.
        catalog=self.read_sql("select jsonb_build_object('relations',(select jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relnamespace,c.relkind,c.relowner,c.relam,c.reltablespace,c.relpersistence,c.relreplident,c.relrowsecurity,c.relforcerowsecurity,c.reloptions)order by c.oid)from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('auth','public','private','storage','cron','vault')),'columns',(select jsonb_agg(jsonb_build_array(a.attrelid,a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,a.attisdropped,a.attstorage,a.attcompression)order by a.attrelid,a.attnum)from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('auth','public','private','storage','cron','vault')),'defaults',(select jsonb_agg(to_jsonb(d)order by d.oid)from pg_attrdef d join pg_class c on c.oid=d.adrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('auth','public','private','storage','cron','vault')));",timeout=5)
        value['catalogSha256']=hashlib.sha256(catalog.encode()).hexdigest();return value
    def added_rows(self,baseline,accounts):
        rows=super().added_rows(baseline,accounts)
        metadata=[{'user_id':a['userId'],'session_id':a['sessionId']}for a in accounts]
        source='jsonb_to_recordset('+quote(json.dumps(metadata))+'::jsonb)a(user_id text,session_id text)'
        rows['auth.mfa_amr_claims']=signed_exact_json(self.read_sql("select coalesce(jsonb_object_agg(r.id::text,jsonb_build_object('rowSha256',encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex'),'ownerUserId',a.user_id,'operation','row')),'{}'::jsonb)from auth.mfa_amr_claims r join "+source+" on r.session_id::text=a.session_id and r.authentication_method='password';",timeout=3))
        return rows
    def metadata_proof(self,a,scope,case):
        return self.read_sql('select exists(select 1 from auth.users u join auth.sessions s on s.user_id=u.id join public.profiles p on p.id=u.id join private.member_episodes e on e.profile_id=p.id where u.id='+quote(a['userId'])+'::uuid and s.id='+quote(a['sessionId'])+'::uuid and e.identity_id is null and e.ended_at is null and not u.is_anonymous and u.raw_user_meta_data @> '+quote(json.dumps({'fixture_scope_id':scope,'fixture_case':case,'email_verified':True}))+'::jsonb);')=='t'
    def cleanup_audits(self,created):
        metadata=[{'uid':v['userId'],'email':v['authEmail']}for v in created.values()]
        source='jsonb_to_recordset('+quote(json.dumps(metadata))+'::jsonb)a(uid text,email text)'
        condition="((r.payload->>'action'='user_signedup'and r.payload->'traits'->>'user_id'=a.uid and r.payload->'traits'->>'user_email'=a.email)or(r.payload->>'action'='login'and r.payload->>'actor_id'=a.uid and r.payload->>'actor_username'=a.email)or(r.payload->>'action'='user_deleted'and r.payload->'traits'->>'user_id'=a.uid and r.payload->'traits'->>'user_email'=a.email))"
        return signed_exact_json(self.read_sql("select coalesce(jsonb_object_agg(h,n),'{}'::jsonb)from(select encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')h,count(*)n from auth.audit_log_entries r join "+source+' on '+condition+' group by 1)s;',timeout=3))
    def request_original(self,path,payload):
        if path not in('/admin/users','/token?grant_type=password'):raise ValueError('LCP_HTTP_UNKNOWN')
        credential=self.reviewed.credentials['service'if path=='/admin/users'else'anon']
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args):return None
        req=urllib.request.Request(self.origin+'/auth/v1'+path,data=json.dumps(payload).encode(),method='POST',
            headers={'apikey':credential,'authorization':'Bearer '+credential,'content-type':'application/json'})
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        try:
            try:
                with opener.open(req,timeout=5)as response:status=response.status;raw=response.read(65537)
            except urllib.error.HTTPError as error:status=error.code;raw=error.read(65537)
            if len(raw)>65536:raise ValueError()
            signed_exact_json(raw);return status,raw
        except Exception:raise ValueError('LCP_HTTP_UNKNOWN')from None


class LifecycleProvisioningContext:
    def __init__(self,reviewed):
        self.reviewed=reviewed;self.binding=lcp_binding(reviewed);self.root=reviewed.prepared_root
        self.evidence=self.root/('auth-lifecycle-provision-'+reviewed.scope_id)
        self.ports=reviewed.ports if reviewed.ports is not None else FixedLifecycleProvisioningPorts(reviewed)
        self.ports.origin=self.binding['origin'];self.done=threading.Event();self.failures=[];self.unknown=False;self.created={}
        self.baseline_sha256=None
        self.observer=threading.Thread(target=self.observe,daemon=True)
    def resource(self,minimum):
        start=time.monotonic();value=self.ports.memory_kib()
        if type(value)is not int or value<minimum or time.monotonic()-start>3:raise ValueError('LCP_RESOURCE_GUARD')
        return value
    def observe(self):
        while not self.done.is_set():
            start=time.monotonic()
            try:self.resource(786432)
            except BaseException:self.failures.append('LCP_MONITOR_FAILED');self.done.set();return
            self.done.wait(max(0,start+3-time.monotonic()))
    def start(self):
        self.resource(1048576);self.observer.start();self.live();self.ports.history()
    def live(self):
        self.assert_monitor_live()
        if provisioning_source_check(self.reviewed.source_pins,self.binding['sourceHead'])!=self.binding['sourceHead']:raise ValueError('LCP_HEAD_CHANGED')
        if self.ports.identity()!=self.reviewed.containers:raise ValueError('LCP_STATE_BINDING')
        if self.ports.settings()!={'jwtExpirySeconds':3600,'anonymousEnabled':False,'signupDisabled':True}:raise ValueError('LCP_SETTINGS_REQUIRED')
        controls=self.ports.closed_controls()
        if set(controls)!=set(PROVISION_CLOSED_CONTROLS)|{'cronLaunchActiveJobs'}or controls['cronLaunchActiveJobs']!='off'or any(controls[k]is not False for k in PROVISION_CLOSED_CONTROLS):raise ValueError('LCP_CLOSED_REQUIRED')
        self.resource(786432)
        self.assert_monitor_live()
    def assert_monitor_live(self):
        if self.done.is_set()or self.failures:raise ValueError('LCP_MONITOR_FAILED')
    def stop(self):
        self.done.set()
        if self.observer.ident is not None:self.observer.join(timeout=3)
        if self.observer.is_alive()or self.failures:raise ValueError('LCP_MONITOR_UNCLOSED')
    def finish(self,phase):
        # observer의 실패가 done을 먼저 설정했어도 반드시 join한다.
        self.done.set()
        if self.observer.ident is not None:self.observer.join(timeout=3)
        if self.observer.is_alive():
            self.fail(phase,ValueError('LCP_MONITOR_UNCLOSED'))
            raise ValueError('LCP_FAILED_PRIVATE_EVIDENCE_PRESERVED')
    def save(self,name,value):return lcp_save(self.evidence,name,value)
    def fail(self,phase,error):
        code=str(error)if type(error)is ValueError and str(error)in LCP_CODES else'LCP_FAILED'
        try:self.save('failure-'+phase+'.json',{'status':'UNKNOWN'if self.unknown else'FAIL_RETAINED_OWNED',
            'code':code,'created':self.created,'binding':self.binding,'baselineSha256':self.baseline_sha256,
            'noResend':True,'actualLifecycle':'NOT_RUN'})
        except BaseException:pass
    def post(self,case,operation,payload):
        self.live();self.save(case+'-'+operation+'-intent-private.json',{'case':case,'scopeId':self.reviewed.scope_id,'payload':payload,'singlePost':True})
        path='/admin/users'if operation=='create'else'/token?grant_type=password'
        # journal 직후 불명확한 전송/저장 실패도 재전송 권한이 되지 않는다.
        self.live();self.unknown=True
        self.assert_monitor_live()
        status,raw=self.ports.request_original(path,payload);body=signed_exact_json(raw)
        if operation=='create'and status==200:
            try:
                uid=body['id']
                if (str(uuid.UUID(uid))!=uid or body['email']!=payload['email']or body.get('user_metadata')!=payload['user_metadata']
                        or body['user_metadata'].get('email_verified')is not True or body.get('role')!='authenticated'or body.get('is_anonymous')is not False):raise ValueError()
                self.created[case]={'userId':uid,'authEmail':payload['email']}
            except (KeyError,TypeError,ValueError):raise ValueError('LCP_CREATE_PROOF')from None
            lcp_save_bytes(self.evidence,case+'-create-response-private.json',raw)
            self.save(case+'-created.json',self.created[case])
        self.save(case+'-'+operation+'-outcome.json',{'status':status,'responseSha256':hashlib.sha256(raw).hexdigest(),'responseBytes':len(raw)})
        # login은 원 bytes/claims/issuance가 모두 검증·영속화될 때만 known이다.
        # non-200은 commit 후 오류일 수 있으므로 어떤 status도 uncertainty를 지우지 않는다.
        if operation=='create'and status==200:self.unknown=False
        return status,raw,body
    def issue(self,case):
        scope=self.reviewed.scope_id
        email=('synthetic-ai-'+scope+'-'+case.split('-')[1]if case.startswith('baseline-')else'synthetic-auth-lifecycle-'+scope+'-'+case.lower())+'@example.invalid'
        if self.ports.resolve_email(email)is not None:raise ValueError('LCP_CREATE_PROOF')
        password=base64.urlsafe_b64encode(os.urandom(36)).decode();meta={'fixture_scope_id':scope,'fixture_case':case,'email_verified':True}
        status,_,user=self.post(case,'create',{'email':email,'password':password,'email_confirm':True,'user_metadata':meta})
        if status!=200 or user.get('role')!='authenticated'or user.get('is_anonymous')is not False:raise ValueError('LCP_CREATE_PROOF')
        status,raw,response=self.post(case,'login',{'email':email,'password':password})
        if status!=200 or response.get('token_type')!='bearer':raise ValueError('LCP_LOGIN_PROOF')
        claims=signed_claims(response.get('access_token'));uid=user['id'];now=time.time()
        if (claims.get('sub')!=uid or claims.get('iss')!=self.binding['origin']+'/auth/v1'or claims.get('aud')!='authenticated'
                or claims.get('role')!='authenticated'or claims.get('is_anonymous')is not False or claims.get('email')!=email
                or type(claims.get('iat'))is not int or type(claims.get('exp'))is not int or claims['exp']-claims['iat']!=3600
                or claims['iat']>now or claims['exp']<=now+300 or str(uuid.UUID(claims.get('session_id')))!=claims['session_id']
                or not isinstance(response.get('user'),dict)
                or any(response['user'].get(k)!=user.get(k)for k in('id','email','role','is_anonymous','user_metadata'))):raise ValueError('LCP_LOGIN_PROOF')
        a={'userId':uid,'sessionId':claims['session_id'],'accessToken':response['access_token'],'expiresAt':claims['exp'],'authEmail':email}
        response_sha=lcp_save_bytes(self.evidence,case+'-issued-response-private.json',raw)
        receipt={'version':1,'kind':'GOTRUE_ORIGINAL_TOKEN_ISSUED','scopeId':scope,'case':case,'userId':uid,'sessionId':a['sessionId'],
            'tokenSha256':hashlib.sha256(a['accessToken'].encode()).hexdigest(),'origin':self.binding['origin'],
            'authContainerId':self.reviewed.containers['auth']['id'],'authImage':self.reviewed.containers['auth']['image'],
            'issuedAt':claims['iat'],'expiresAt':claims['exp'],'httpStatus':200,'responseSha256':response_sha,'wire':'POST /token?grant_type=password'}
        sha=self.save(case+'-issued.json',receipt)
        self.unknown=False
        self.live();self.save(case+'-profile-intent.json',{'scopeId':scope,'userId':uid,'singleLink':True})
        self.unknown=True
        if not self.ports.link_profile(uid):raise ValueError('LCP_PROFILE_PROOF')
        self.save(case+'-profile-linked.json',{'userId':uid,'identityId':None,'syntheticOnly':True});self.unknown=False
        self.verify(a,case)
        return a,{'receiptSha256':sha,'responseSha256':response_sha}
    def verify(self,a,case):
        self.live();status,user=self.ports.request('GET','/user',token=a['accessToken'])
        if(status!=200 or not isinstance(user,dict)or user.get('id')!=a['userId']or user.get('email')!=a['authEmail']
                or user.get('role')!='authenticated'or user.get('is_anonymous')is not False
                or user.get('user_metadata')!={'fixture_scope_id':self.reviewed.scope_id,'fixture_case':case,'email_verified':True}
                or user['user_metadata'].get('email_verified')is not True
                or not self.ports.session_proof(a)or not self.ports.metadata_proof(a,self.reviewed.scope_id,case)):raise ValueError('LCP_AUTH_PROOF')
    def read_state(self,name,digest):
        if not isinstance(digest,str)or not re.fullmatch(r'[a-f0-9]{64}',digest):raise ValueError('LCP_STATE_BINDING')
        raw=signed_private_read(self.evidence/name)
        if hashlib.sha256(raw).hexdigest()!=digest:raise ValueError('LCP_STATE_BINDING')
        v=signed_exact_json(raw)
        if set(v)!={'binding','baseline','current','accounts','issuanceProofs','readyNotBefore','expiresAt'}or v['binding']!=self.binding:raise ValueError('LCP_STATE_BINDING')
        cases={'expiredBearer'}if name=='stage-private.json'else{'expiredBearer','revokedSession','memberChanged'}|{'baseline-'+str(i)for i in range(6)}
        if not isinstance(v['accounts'],dict)or set(v['accounts'])!=cases or not isinstance(v['issuanceProofs'],dict)or set(v['issuanceProofs'])!=cases:
            raise ValueError('LCP_STATE_BINDING')
        lcp_snapshot(v['baseline']);lcp_snapshot(v['current'])
        baseline_raw=signed_private_read(self.evidence/'baseline-private.json')
        if signed_exact_json(baseline_raw)!=v['baseline']:raise ValueError('LCP_STATE_BINDING')
        self.baseline_sha256=hashlib.sha256(baseline_raw).hexdigest()
        if v['expiresAt']!=v['accounts']['expiredBearer']['expiresAt']or v['readyNotBefore']!=v['expiresAt']-60:raise ValueError('LCP_STATE_BINDING')
        for case,a in v['accounts'].items():
            if not isinstance(a,dict)or set(a)!={'userId','sessionId','accessToken','expiresAt','authEmail'}:raise ValueError('LCP_STATE_BINDING')
            for k in('userId','sessionId'):
                if not isinstance(a[k],str)or str(uuid.UUID(a[k]))!=a[k]:raise ValueError('LCP_STATE_BINDING')
            proof=v['issuanceProofs'][case]
            if not isinstance(proof,dict)or set(proof)!={'receiptSha256','responseSha256'}or any(not isinstance(h,str)or not re.fullmatch(r'[a-f0-9]{64}',h)for h in proof.values()):raise ValueError('LCP_STATE_BINDING')
            raw=signed_private_read(self.evidence/(case+'-issued-response-private.json'))
            if hashlib.sha256(raw).hexdigest()!=proof['responseSha256']:raise ValueError('LCP_STATE_BINDING')
            if signed_exact_json(raw)['access_token']!=a['accessToken']:raise ValueError('LCP_STATE_BINDING')
            receipt=signed_private_read(self.evidence/(case+'-issued.json'))
            if hashlib.sha256(receipt).hexdigest()!=proof['receiptSha256']:raise ValueError('LCP_STATE_BINDING')
            r=signed_exact_json(receipt)
            claims=signed_claims(a['accessToken'])
            expected={'version':1,'kind':'GOTRUE_ORIGINAL_TOKEN_ISSUED','scopeId':self.reviewed.scope_id,'case':case,
                'userId':a['userId'],'sessionId':a['sessionId'],'tokenSha256':hashlib.sha256(a['accessToken'].encode()).hexdigest(),
                'origin':self.binding['origin'],'authContainerId':self.reviewed.containers['auth']['id'],'authImage':self.reviewed.containers['auth']['image'],
                'issuedAt':claims.get('iat'),'expiresAt':a['expiresAt'],'httpStatus':200,'responseSha256':proof['responseSha256'],'wire':'POST /token?grant_type=password'}
            if r!=expected or type(r['version'])is not int or type(r['httpStatus'])is not int:raise ValueError('LCP_STATE_BINDING')
            self.created[case]={'userId':a['userId'],'authEmail':a['authEmail']}
        return v
    def preservation(self,v):
        accounts=list(v['accounts'].values());current=lcp_snapshot(self.ports.snapshot())
        added=self.ports.added_rows(v['baseline']['rows'],accounts)
        lcp_added_scope(v['baseline'],current,added,accounts)
        if current!=v['current']:raise ValueError('LCP_ROWS_CHANGED')
        for case,a in v['accounts'].items():self.verify(a,case)


def stage_lifecycle_accounts(reviewed):
    c=LifecycleProvisioningContext(reviewed)
    if c.evidence.exists()or c.evidence.is_symlink()or any((c.root/x).exists()for x in('signed-ai-provision-intent.json','signed-ai-binding-private.json','auth-lifecycle-input-'+reviewed.scope_id+'.json')):raise ValueError('LCP_PREVIOUS_ATTEMPT')
    c.evidence.mkdir(mode=0o700)
    try:
        c.save('stage-intent.json',c.binding);c.start()
        if not c.ports.empty_auth():raise ValueError('LCP_FRESH_EMPTY_REQUIRED')
        baseline=lcp_snapshot(c.ports.snapshot())
        for t in set(LCP_TABLES)|{'private.'+t for t in PROTECTED_BUDGET}:
            if baseline['rows'][t]:raise ValueError('LCP_FRESH_EMPTY_REQUIRED')
        c.baseline_sha256=c.save('baseline-private.json',baseline);c.live();c.resource(1048576)
        a,proof=c.issue('expiredBearer');current=lcp_snapshot(c.ports.snapshot())
        lcp_added_scope(baseline,current,c.ports.added_rows(baseline['rows'],[a]),[a]);c.live();c.stop()
        state={'binding':c.binding,'baseline':baseline,'current':current,'accounts':{'expiredBearer':a},'issuanceProofs':{'expiredBearer':proof},
            'readyNotBefore':a['expiresAt']-60,'expiresAt':a['expiresAt']}
        sha=c.save('stage-private.json',state)
        result={'status':'STAGED_ORIGINAL_TOKEN_NOT_EXECUTED','stateSha256':sha,'scopeId':reviewed.scope_id,'readyNotBefore':state['readyNotBefore'],
            'expiresAt':state['expiresAt'],'actualLifecycle':'NOT_RUN','anonymous':'NOT_RUN','foreign':'NOT_RUN','actualNaver':'NOT_RUN',
            'executionScope':'OFFLINE_MODEL_ONLY'if reviewed.ports is not None else'LOCAL_GOTRUE_ORIGINAL_ISSUANCE'}
        c.save('stage-receipt.json',result);return result
    except BaseException as error:c.fail('stage',error);raise ValueError('LCP_FAILED_PRIVATE_EVIDENCE_PRESERVED')from None
    finally:
        c.finish('stage')


def resume_lifecycle_accounts(reviewed,stage_sha256):
    c=LifecycleProvisioningContext(reviewed);v=c.read_state('stage-private.json',stage_sha256)
    if any((c.evidence/x).exists()for x in('late-intent.json','failure-stage.json')):raise ValueError('LCP_PREVIOUS_ATTEMPT')
    try:
        c.save('late-intent.json',{'binding':c.binding,'stageSha256':stage_sha256,'singleResume':True});c.start();c.preservation(v)
        c.live();c.resource(1048576)
        if time.time()>=v['expiresAt']:raise ValueError('LCP_WINDOW_REQUIRED')
        for case in('revokedSession','memberChanged')+tuple('baseline-'+str(i)for i in range(6)):
            a,proof=c.issue(case);v['accounts'][case]=a;v['issuanceProofs'][case]=proof
        v['current']=lcp_snapshot(c.ports.snapshot())
        lcp_added_scope(v['baseline'],v['current'],c.ports.added_rows(v['baseline']['rows'],list(v['accounts'].values())),list(v['accounts'].values()))
        c.verify(v['accounts']['expiredBearer'],'expiredBearer');c.live();c.stop()
        sha=c.save('late-private.json',v)
        result={'status':'STAGED_LATE_TOKENS_NOT_EXECUTED','stateSha256':sha,'scopeId':reviewed.scope_id,'readyNotBefore':v['readyNotBefore'],
            'expiresAt':v['expiresAt'],'actualLifecycle':'NOT_RUN','baselineSix':6,'ownedOriginalUsers':9,'anonymous':'NOT_RUN','foreign':'NOT_RUN'}
        c.save('late-receipt.json',result);return result
    except BaseException as error:c.fail('late',error);raise ValueError('LCP_FAILED_PRIVATE_EVIDENCE_PRESERVED')from None
    finally:
        c.finish('late')


def bind_lifecycle_accounts(reviewed,late_sha256):
    c=LifecycleProvisioningContext(reviewed);v=c.read_state('late-private.json',late_sha256)
    if any((c.evidence/x).exists()for x in('handoff-intent.json','failure-stage.json','failure-late.json')):raise ValueError('LCP_PREVIOUS_ATTEMPT')
    try:
        c.save('handoff-intent.json',{'binding':c.binding,'lateSha256':late_sha256,'getOnly':True});c.start();c.preservation(v)
        now=time.time();remaining=v['expiresAt']-now
        if not 0<remaining<=60:raise ValueError('LCP_WINDOW_REQUIRED')
        if any(a['expiresAt']<=now+(300 if case.startswith('baseline-')else 180)for case,a in v['accounts'].items()if case!='expiredBearer'):raise ValueError('LCP_WINDOW_REQUIRED')
        c.live();c.resource(1048576)
        if not 0<v['expiresAt']-time.time()<=60:raise ValueError('LCP_WINDOW_REQUIRED')
        signed_evidence=c.root/('signed-auth-'+reviewed.scope_id);lifecycle_evidence=c.root/('auth-lifecycle-'+reviewed.scope_id)
        if any(p.exists()or p.is_symlink()for p in(signed_evidence,lifecycle_evidence)):raise ValueError('LCP_PREVIOUS_ATTEMPT')
        binding={'version':1,'kind':SIGNED_KIND,'preparedRoot':str(c.root),'databaseManifestSha256':c.binding['manifestSha256'],
            'origin':c.binding['origin'],'jwtIssuer':c.binding['origin']+'/auth/v1','containers':reviewed.containers,'credentials':reviewed.credentials,
            'accounts':[v['accounts']['baseline-'+str(i)]for i in range(6)],'evidenceRoot':str(signed_evidence),'sourcePins':reviewed.source_pins,
            'approvedByRoot':False,'dockerSlotReady':False}
        validate_signed_binding(binding,c.root,c.binding['target'],now=time.time());c.stop()
        binding_sha=lcp_save(c.root,'signed-ai-binding-private.json',binding)
        accounts={case:{**v['accounts'][case],'issuanceReceiptSha256':v['issuanceProofs'][case]['receiptSha256']}for case in('expiredBearer','revokedSession','memberChanged')}
        value={'version':1,'kind':LIFECYCLE_KIND,'scopeId':reviewed.scope_id,'preparedRoot':str(c.root),'signedBindingSha256':binding_sha,
            'sourcePins':reviewed.source_pins,'evidenceRoot':str(lifecycle_evidence),'accounts':{**accounts,'anonymousBearer':None},'foreign':None,
            'approvedByRoot':False,'dockerSlotReady':False}
        validate_lifecycle_input(value,c.root,binding,binding_sha)
        input_sha=lcp_save(c.root,'auth-lifecycle-input-'+reviewed.scope_id+'.json',value)
        result={'status':'MODEL_LIFECYCLE_INPUT_BOUND_NOT_EXECUTED'if reviewed.ports is not None else'LOCAL_LIFECYCLE_INPUT_BOUND_NOT_EXECUTED',
            'bindingSha256':binding_sha,'inputSha256':input_sha,'issuanceProofs':{k:v['issuanceProofs'][k]for k in accounts},
            'actualLifecycle':'NOT_RUN','anonymous':'NOT_RUN','foreign':'NOT_RUN','protectedBudgetDelta':0,'sourceHead':c.binding['sourceHead']}
        c.save('handoff-receipt.json',result);return result
    except BaseException as error:c.fail('handoff',error);raise ValueError('LCP_FAILED_PRIVATE_EVIDENCE_PRESERVED')from None
    finally:
        c.finish('handoff')


def cleanup_lifecycle_accounts(reviewed,phase,failure_sha256):
    """별도 검토한 실패 원 SHA로만 정리한다. 미확정 전송/UUID 교체는 UNKNOWN, 재발급·부활은 없다."""
    c=LifecycleProvisioningContext(reviewed)
    if phase not in('stage','late','handoff')or not isinstance(failure_sha256,str)or not re.fullmatch(r'[a-f0-9]{64}',failure_sha256):raise ValueError('LCP_STATE_BINDING')
    raw=signed_private_read(c.evidence/('failure-'+phase+'.json'))
    if hashlib.sha256(raw).hexdigest()!=failure_sha256:raise ValueError('LCP_STATE_BINDING')
    failure=signed_exact_json(raw)
    if(set(failure)!={'status','code','created','binding','baselineSha256','noResend','actualLifecycle'}
            or failure['binding']!=c.binding or failure['status']not in('UNKNOWN','FAIL_RETAINED_OWNED')
            or failure['code']not in LCP_CODES or failure['noResend']is not True or failure['actualLifecycle']!='NOT_RUN'):
        raise ValueError('LCP_STATE_BINDING')
    if (c.evidence/'cleanup-intent.json').exists():raise ValueError('LCP_PREVIOUS_ATTEMPT')
    c.save('cleanup-intent.json',{'binding':c.binding,'failureSha256':failure_sha256,'noResend':True})
    errors=[];closed=[];unknown=failure['status']=='UNKNOWN';preserved=False
    try:
        c.start()
        for case,owned in failure['created'].items():
            try:
                expected=('synthetic-ai-'+reviewed.scope_id+'-'+case.split('-')[1]if re.fullmatch(r'baseline-[0-5]',case)else'synthetic-auth-lifecycle-'+reviewed.scope_id+'-'+case.lower())+'@example.invalid'
                if(case not in('expiredBearer','revokedSession','memberChanged')and not re.fullmatch(r'baseline-[0-5]',case)
                        or set(owned)!={'userId','authEmail'}or str(uuid.UUID(owned['userId']))!=owned['userId']or owned['authEmail']!=expected):raise ValueError('LCP_CLEANUP_UNKNOWN')
                uid=owned['userId'];c.live()
                found=c.ports.resolve_email(expected)
                if found!=uid:raise ValueError('LCP_CLEANUP_UNKNOWN')
                status,user=c.ports.request('GET','/admin/users/'+uid,admin=True)
                if(status!=200 or user.get('id')!=uid or user.get('email')!=expected
                        or user.get('user_metadata')!={'fixture_scope_id':reviewed.scope_id,'fixture_case':case,'email_verified':True}
                        or user['user_metadata'].get('email_verified')is not True):raise ValueError('LCP_CLEANUP_UNKNOWN')
                c.save(case+'-cleanup-intent.json',{'userId':uid,'authEmail':expected,'singleDelete':True})
                c.live();c.ports.unlink_profile(uid);c.live()
                try:c.ports.request('DELETE','/admin/users/'+uid,admin=True)
                except BaseException:unknown=True
                c.live();status,_=c.ports.request('GET','/admin/users/'+uid,admin=True)
                if status!=404 or c.ports.resolve_email(expected)is not None:raise ValueError('LCP_CLEANUP_UNKNOWN')
                closed.append(uid);c.save(case+'-cleanup-closed.json',{'userId':uid,'getAbsent':True})
            except BaseException:errors.append('LCP_CLEANUP_UNKNOWN')
        if failure['baselineSha256']is not None:
            raw=signed_private_read(c.evidence/'baseline-private.json')
            if hashlib.sha256(raw).hexdigest()!=failure['baselineSha256']:raise ValueError('LCP_STATE_BINDING')
            baseline=lcp_snapshot(signed_exact_json(raw));current=lcp_snapshot(c.ports.snapshot())
            expected={**baseline,'rows':{t:dict(bag)for t,bag in baseline['rows'].items()}}
            audits=c.ports.cleanup_audits(failure['created'])
            for h,n in audits.items():
                if not re.fullmatch(r'[a-f0-9]{64}',h)or type(n)is not int or n<1:raise ValueError('LCP_OWNED_SCOPE')
                expected['rows']['auth.audit_log_entries'][h]=expected['rows']['auth.audit_log_entries'].get(h,0)+n
            preserved=current==expected and len(closed)==len(failure['created'])and not unknown
            if not preserved:errors.append('LCP_CLEANUP_UNKNOWN')
        else:errors.append('LCP_CLEANUP_UNKNOWN')
        c.stop()
    except BaseException:errors.append('LCP_CLEANUP_UNKNOWN')
    finally:c.finish('cleanup')
    result={'status':'UNKNOWN'if unknown or errors else'FAIL_OWNED_PREPARATION_CLEANUP_PROVEN','closedCount':len(closed),
        'preservationProven':preserved and not errors,'fixedFailures':errors,'originalFailurePreserved':True,
        'noResend':True,'noSessionResurrection':True,'actualLifecycle':'NOT_RUN'}
    c.save('cleanup-receipt.json',result);return result


class ReviewedLifecycleDispatch:
    """Root의 고정 코드만 만드는 단일 전송 권한. JSON/CLI/반환 receipt로 재구성하지 않는다."""
    def __init__(self,decision_id,producer_reviewed,source_head,late_sha256,handoff_sha256,binding_sha256,input_sha256,issuance_proofs,node_path,node_sha256,capsule_root,capsule_pins,factory_sha256):
        self.decision_id=decision_id;self.producer=producer_reviewed;self.source_head=source_head
        self.late_sha256=late_sha256;self.handoff_sha256=handoff_sha256;self.binding_sha256=binding_sha256;self.input_sha256=input_sha256
        self.issuance_proofs=issuance_proofs;self.node_path=Path(node_path);self.node_sha256=node_sha256
        self.capsule_root=Path(capsule_root);self.capsule_pins=capsule_pins;self.factory_sha256=factory_sha256


def lifecycle_capsule_source_read(path,root):
    """검토된 source 전용 봉인0400/0500. token/state600/700 reader와 섞지 않는다."""
    path=Path(path);root=Path(root)
    if(not root.is_absolute()or root.resolve()!=root or root==Path('/private/tmp')
            or not path.is_absolute()or path.resolve()!=path or root not in path.parents):
        raise ValueError('LIFECYCLE_CAPSULE_SOURCE_PATH')
    # root 자신을 포함한 모든 source 디렉터리는0500, 그 위 private 부모는0700이다.
    for directory in (path.parent,*path.parent.parents):
        if directory==Path('/private/tmp'):break
        info=directory.lstat();inside=directory==root or root in directory.parents
        if(not stat.S_ISDIR(info.st_mode)or info.st_uid!=os.getuid()
                or stat.S_IMODE(info.st_mode)!=(0o500 if inside else 0o700)):
            raise ValueError('LIFECYCLE_CAPSULE_SOURCE_DIRECTORY')
    else:raise ValueError('LIFECYCLE_CAPSULE_SOURCE_ROOT')
    before=path.lstat();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        first=os.fstat(fd)
        if(not stat.S_ISREG(first.st_mode)or first.st_uid!=os.getuid()or first.st_nlink!=1
                or stat.S_IMODE(first.st_mode)!=0o400 or first.st_size>2*1024*1024):
            raise ValueError('LIFECYCLE_CAPSULE_SOURCE_FILE')
        signature=lambda info:(info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_nlink,
            info.st_size,info.st_mtime_ns,info.st_ctime_ns)
        if signature(before)!=signature(first):raise ValueError('LIFECYCLE_CAPSULE_SOURCE_CHANGED')
        with os.fdopen(os.dup(fd),'rb')as stream:raw=stream.read(2*1024*1024+1)
        after=os.fstat(fd);current=path.lstat()
        if len(raw)!=first.st_size or signature(first)!=signature(after)or signature(first)!=signature(current):
            raise ValueError('LIFECYCLE_CAPSULE_SOURCE_CHANGED')
        return raw
    finally:os.close(fd)


def lifecycle_dispatch_capsule(reviewed):
    """검토 객체의 고정 map만 권한이다. private manifest/fixture JSON으로 경로나 코드를 선택하지 않는다."""
    if (type(reviewed)is not ReviewedLifecycleDispatch or type(reviewed.producer)is not ReviewedLifecycleProvisioning
            or reviewed.producer.ports is not None or not isinstance(reviewed.source_head,str)
            or not re.fullmatch(r'[a-f0-9]{40}',reviewed.source_head)):raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
    root=reviewed.capsule_root;pins=reviewed.capsule_pins;factory='tests/integration/jonghyun/isolated_ai_factory.ts'
    if(not root.is_absolute()or root.resolve()!=root or root==REPO or root==reviewed.producer.prepared_root
            or not isinstance(pins,dict)or not 1<=len(pins)<=256 or not isinstance(reviewed.factory_sha256,str)
            or not re.fullmatch(r'[a-f0-9]{64}',reviewed.factory_sha256)):
        raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
    expected={**product_graph(),factory:reviewed.producer.source_pins.get(factory)}
    if expected[factory]!=reviewed.factory_sha256 or any(pins.get(k)!=v for k,v in expected.items()):raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
    return sealed_runtime_capsule(reviewed.source_head,root,pins,expected)


def sealed_runtime_capsule(source_head,root,pins,expected):
    """Lifecycle와 AI24가 같은 source-only reader와 inventory 검사를 사용한다."""
    factory='tests/integration/jonghyun/isolated_ai_factory.ts'
    if (not root.is_absolute()or root.resolve()!=root or root==REPO or not isinstance(pins,dict)or not 1<=len(pins)<=256
            or any(pins.get(k)!=v for k,v in expected.items())):raise ValueError('MIDNIGHT_CUSTODY_CAPSULE')
    expected_directories={root};captured={}
    for key,digest in pins.items():
        if(not isinstance(key,str)or key.startswith('/')or any(x in('','..','.')for x in key.split('/'))
                or key!=factory and not re.fullmatch(r'backend/supabase/functions/[A-Za-z0-9_./-]+\.ts',key)
                or not isinstance(digest,str)or not re.fullmatch(r'[a-f0-9]{64}',digest)):
            raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
        path=root/key
        for parent in path.parents:
            if parent==root:break
            expected_directories.add(parent)
        raw=lifecycle_capsule_source_read(path,root)
        if hashlib.sha256(raw).hexdigest()!=digest:raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
        live=REPO/key
        if live.resolve()!=live or live.is_symlink()or live.read_bytes()!=raw:raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
        captured[key]=raw
        if sum(len(v)for v in captured.values())+256*200>32*1024*1024:raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
    # 고정 파일들의 committed bytes를 한 bounded Git batch로 읽는다. N개의15초 대기는 하지 않는다.
    requests=''.join(source_head+':'+key+'\n'for key in captured).encode()
    committed=subprocess.run(['git','-C',str(REPO),'cat-file','--batch'],input=requests,capture_output=True,timeout=15)
    if committed.returncode or len(committed.stdout)>32*1024*1024:raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
    offset=0
    for raw in captured.values():
        end=committed.stdout.find(b'\n',offset)
        if end<0 or end-offset>200:raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
        header=committed.stdout[offset:end]
        if not re.fullmatch(rb'[a-f0-9]{40,64} blob [0-9]+',header):raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
        size=int(header.split()[2]);offset=end+1
        if size!=len(raw)or committed.stdout[offset:offset+size]!=raw or committed.stdout[offset+size:offset+size+1]!=b'\n':raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
        offset+=size+1
    if offset!=len(committed.stdout):raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
    actual_files=set();actual_dirs={root}
    for path in root.rglob('*'):
        info=path.lstat()
        if info.st_uid!=os.getuid()or stat.S_ISLNK(info.st_mode):raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
        if stat.S_ISDIR(info.st_mode):
            if stat.S_IMODE(info.st_mode)!=0o500:raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
            actual_dirs.add(path)
        elif stat.S_ISREG(info.st_mode):actual_files.add(path.relative_to(root).as_posix())
        else:raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
    if actual_files!=set(pins)or actual_dirs!=expected_directories:raise ValueError('LIFECYCLE_DISPATCH_CAPSULE')
    return root,root/factory


def lifecycle_runner_factory_paths(runner):
    authority=getattr(runner,'dispatch_authority',None)
    if authority is None:return REPO,Path(__file__).with_name('isolated_ai_factory.ts')
    return lifecycle_dispatch_capsule(authority)



class TypedMidnightCustody:
    """검토한 Python 코드 객체만 부여하는 source 권한. 상태 JSON은 권한이 아니다."""
    __slots__=('_data',)
    def __init__(self,source_head,scope_id,capsule_root,capsule_pins,factory_sha256,node_path,node_sha256,observer_sha256):
        value={'sourceHead':source_head,'scopeId':scope_id,'capsuleRoot':str(capsule_root),'capsulePins':capsule_pins,
            'factorySha256':factory_sha256,'nodePath':str(node_path),'nodeSha256':node_sha256,'observerSha256':observer_sha256}
        if (not isinstance(source_head,str)or not re.fullmatch(r'[a-f0-9]{40}',source_head)
                or not isinstance(scope_id,str)or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,48}',scope_id)
                or any(not isinstance(value[k],str)or not re.fullmatch(r'[a-f0-9]{64}',value[k])for k in ('factorySha256','nodeSha256','observerSha256'))):
            raise ValueError('MIDNIGHT_CUSTODY_FIELDS')
        object.__setattr__(self,'_data',json.dumps(value,sort_keys=True,separators=(',',':')))
    def __setattr__(self,name,value):raise AttributeError('MIDNIGHT_CUSTODY_IMMUTABLE')
    def descriptor(self):return json.loads(self._data)
    @property
    def node_path(self):return Path(self.descriptor()['nodePath'])
    @property
    def node_sha256(self):return self.descriptor()['nodeSha256']


def midnight_custody_proof(runner):
    authority=getattr(runner,'midnight_custody',None)
    if authority is None:return None
    if type(authority)is not TypedMidnightCustody:raise ValueError('MIDNIGHT_TYPED_CUSTODY_REQUIRED')
    value=authority.descriptor();factory='tests/integration/jonghyun/isolated_ai_factory.ts'
    if value['scopeId']!=runner.scope_id or value['factorySha256']!=runner.binding['sourcePins'].get(factory):
        raise ValueError('MIDNIGHT_CUSTODY_BINDING')
    head=subprocess.run(['git','-C',str(REPO),'rev-parse','HEAD'],capture_output=True,timeout=15)
    if head.returncode or head.stdout.decode().strip()!=value['sourceHead']:raise ValueError('MIDNIGHT_CUSTODY_HEAD')
    expected={**product_graph(),factory:value['factorySha256']}
    root,path=sealed_runtime_capsule(value['sourceHead'],Path(value['capsuleRoot']),value['capsulePins'],expected)
    lifecycle_dispatch_node(authority)
    return value


def midnight_bind_custody(runner,authority):
    if(type(runner)is not SignedMidnightRunner or type(authority)is not TypedMidnightCustody
            or runner.changed or runner.children or hasattr(runner,'midnight_custody')):
        raise ValueError('MIDNIGHT_CUSTODY_BIND_ONCE')
    runner.midnight_custody=authority
    value=midnight_custody_proof(runner)
    # 원 observer의 고정 3개 함수만 검증한 버퍼에서 캡처한다. 임의 모듈 loader가 아니다.
    import ast
    path=REPO/'tools/local/observe_isolated.py';raw=path.read_bytes()
    committed=subprocess.run(['git','-C',str(REPO),'show',value['sourceHead']+':tools/local/observe_isolated.py'],capture_output=True,timeout=15)
    if (committed.returncode or committed.stdout!=raw or hashlib.sha256(raw).hexdigest()!=value['observerSha256']):
        raise ValueError('MIDNIGHT_CUSTODY_OBSERVER')
    tree=ast.parse(raw);names={'group_alive','verify_group_closed','terminate'}
    nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef)and node.name in names]
    if {node.name for node in nodes}!=names:raise ValueError('MIDNIGHT_CUSTODY_OBSERVER')
    namespace={'os':os,'signal':signal,'subprocess':subprocess,'time':time}
    exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),namespace)
    runner.midnight_terminate=namespace['terminate']
    runner.fixture['codeRoot']=value['capsuleRoot']
    return {'custody':value,'sha256':hashlib.sha256(authority._data.encode()).hexdigest(),'actualMidnight':'NOT_RUN'}


def midnight_warm_signatures(runner):
    value=midnight_custody_proof(runner)
    paths={str(Path(value['capsuleRoot'])/key):digest for key,digest in value['capsulePins'].items()}
    paths[value['nodePath']]=value['nodeSha256'];result={}
    signature=lambda p:(p.st_dev,p.st_ino,p.st_mode,p.st_uid,p.st_nlink,p.st_size,p.st_mtime_ns,p.st_ctime_ns)
    root=Path(value['capsuleRoot']);directories={root}
    for name in value['capsulePins']:
        parent=(root/name).parent
        while parent!=root:directories.add(parent);parent=parent.parent
    for directory in directories:
        info=directory.lstat()
        if not stat.S_ISDIR(info.st_mode)or info.st_uid!=os.getuid()or stat.S_IMODE(info.st_mode)!=0o500:
            raise ValueError('MIDNIGHT_CUSTODY_WARM')
        result[str(directory)]=signature(info)
    # 검증과 warm metadata 사이 교체를 신뢰하지 않는다. 같은 FD에서 해시와 식별자를 묶는다.
    for name,digest in paths.items():
        path=Path(name);info=path.lstat();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            opened=os.fstat(fd)
            if signature(info)!=signature(opened)or not stat.S_ISREG(opened.st_mode)or opened.st_nlink!=1:
                raise ValueError('MIDNIGHT_CUSTODY_WARM')
            maximum=256*1024*1024 if name==value['nodePath']else 2*1024*1024
            if opened.st_size>maximum:raise ValueError('MIDNIGHT_CUSTODY_WARM')
            hasher=hashlib.sha256();remaining=opened.st_size;began=time.monotonic()
            while remaining:
                if time.monotonic()-began>15:raise ValueError('MIDNIGHT_CUSTODY_WARM')
                raw=os.read(fd,min(1048576,remaining))
                if not raw:raise ValueError('MIDNIGHT_CUSTODY_WARM')
                hasher.update(raw);remaining-=len(raw)
            if (hasher.hexdigest()!=digest or signature(opened)!=signature(os.fstat(fd))
                    or signature(opened)!=signature(path.lstat())):raise ValueError('MIDNIGHT_CUSTODY_WARM')
            result[name]=signature(opened)
        finally:os.close(fd)
    midnight_custody_proof(runner)
    if any(signature(Path(name).lstat())!=bound for name,bound in result.items()):raise ValueError('MIDNIGHT_CUSTODY_WARM')
    return result


def midnight_warm_recheck(runner):
    deadline=time.monotonic()+.25
    if runner.midnight_custody.descriptor()!=runner.held_custody:raise ValueError('MIDNIGHT_CUSTODY_WARM')
    for name,expected in runner.held_custody_signatures.items():
        info=Path(name).lstat()
        if time.monotonic()>=deadline or (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)!=expected:
            raise ValueError('MIDNIGHT_HELD_SOURCE_DRIFT_OR_SLOW')


def midnight_minimal_env(evidence):
    # 원 환경의 경로와 locale만 전달한다. HOME/locale을 evidence 용도로 바꾸지 않는다.
    keys=('PATH','HOME','LANG','LC_ALL','LC_CTYPE','LC_NUMERIC','LC_TIME','LC_COLLATE','LC_MONETARY',
        'LC_MESSAGES','LC_PAPER','LC_NAME','LC_ADDRESS','LC_TELEPHONE','LC_MEASUREMENT','LC_IDENTIFICATION')
    return {key:os.environ[key]for key in keys if key in os.environ}


def lifecycle_dispatch_node(reviewed):
    path=reviewed.node_path
    if not path.is_absolute()or path.resolve()!=path or path.name!='node':raise ValueError('LIFECYCLE_DISPATCH_NODE')
    before=path.lstat();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        s=os.fstat(fd)
        if(not stat.S_ISREG(s.st_mode)or s.st_nlink!=1 or s.st_uid not in(0,os.getuid())or s.st_mode&0o022
                or not s.st_mode&0o111 or s.st_size>256*1024*1024 or(before.st_dev,before.st_ino)!=(s.st_dev,s.st_ino)):
            raise ValueError('LIFECYCLE_DISPATCH_NODE')
        digest=hashlib.sha256();remaining=s.st_size;began=time.monotonic()
        while remaining:
            if time.monotonic()-began>15:raise ValueError('LIFECYCLE_DISPATCH_NODE')
            data=os.read(fd,min(1048576,remaining))
            if not data:raise ValueError('LIFECYCLE_DISPATCH_NODE')
            digest.update(data);remaining-=len(data)
        after=os.fstat(fd);current=path.lstat()
        if((s.st_size,s.st_mtime_ns,s.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns)
                or(current.st_dev,current.st_ino)!=(s.st_dev,s.st_ino)or digest.hexdigest()!=reviewed.node_sha256):
            raise ValueError('LIFECYCLE_DISPATCH_NODE')
    finally:os.close(fd)


def lifecycle_dispatch_load(reviewed):
    if(type(reviewed)is not ReviewedLifecycleDispatch or type(reviewed.producer)is not ReviewedLifecycleProvisioning
            or reviewed.producer.ports is not None or not isinstance(reviewed.decision_id,str)
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}',reviewed.decision_id)
            or not isinstance(reviewed.source_head,str)or not re.fullmatch(r'[a-f0-9]{40}',reviewed.source_head)):
        raise ValueError('LIFECYCLE_DISPATCH_REVIEWED_CODE_REQUIRED')
    for digest in(reviewed.late_sha256,reviewed.handoff_sha256,reviewed.binding_sha256,reviewed.input_sha256,reviewed.node_sha256):
        if not isinstance(digest,str)or not re.fullmatch(r'[a-f0-9]{64}',digest):raise ValueError('LIFECYCLE_DISPATCH_BINDING')
    c=LifecycleProvisioningContext(reviewed.producer)
    if c.binding['sourceHead']!=reviewed.source_head:raise ValueError('LIFECYCLE_DISPATCH_BINDING')
    late=c.read_state('late-private.json',reviewed.late_sha256)
    originals={}
    paths={'handoff':c.evidence/'handoff-receipt.json','binding':c.root/'signed-ai-binding-private.json',
        'input':c.root/('auth-lifecycle-input-'+reviewed.producer.scope_id+'.json')}
    for name,path in paths.items():
        raw=signed_private_read(path)
        digest=getattr(reviewed,{'handoff':'handoff_sha256','binding':'binding_sha256','input':'input_sha256'}[name])
        if hashlib.sha256(raw).hexdigest()!=digest:raise ValueError('LIFECYCLE_DISPATCH_ORIGINAL_CHANGED')
        originals[name]=signed_exact_json(raw)
    handoff=originals['handoff'];binding=originals['binding'];value=originals['input'];scope=reviewed.producer.scope_id;p=reviewed.producer
    expected_binding={'version':1,'kind':SIGNED_KIND,'preparedRoot':str(c.root),'databaseManifestSha256':c.binding['manifestSha256'],
        'origin':c.binding['origin'],'jwtIssuer':c.binding['origin']+'/auth/v1','containers':p.containers,'credentials':p.credentials,
        'accounts':[late['accounts']['baseline-'+str(i)]for i in range(6)],'evidenceRoot':str(c.root/('signed-auth-'+scope)),
        'sourcePins':p.source_pins,'approvedByRoot':False,'dockerSlotReady':False}
    accounts={case:{**late['accounts'][case],'issuanceReceiptSha256':late['issuanceProofs'][case]['receiptSha256']}for case in('expiredBearer','revokedSession','memberChanged')}
    expected_input={'version':1,'kind':LIFECYCLE_KIND,'scopeId':scope,'preparedRoot':str(c.root),'signedBindingSha256':reviewed.binding_sha256,
        'sourcePins':p.source_pins,'evidenceRoot':str(c.root/('auth-lifecycle-'+scope)),'accounts':{**accounts,'anonymousBearer':None},'foreign':None,
        'approvedByRoot':False,'dockerSlotReady':False}
    if binding!=expected_binding or value!=expected_input or any(binding[k]is not False or value[k]is not False for k in('approvedByRoot','dockerSlotReady')):
        raise ValueError('LIFECYCLE_DISPATCH_ORIGINAL_CHANGED')
    proofs={case:late['issuanceProofs'][case]for case in accounts}
    expected_handoff={'status':'LOCAL_LIFECYCLE_INPUT_BOUND_NOT_EXECUTED','bindingSha256':reviewed.binding_sha256,'inputSha256':reviewed.input_sha256,
        'issuanceProofs':proofs,'actualLifecycle':'NOT_RUN','anonymous':'NOT_RUN','foreign':'NOT_RUN','protectedBudgetDelta':0,'sourceHead':reviewed.source_head}
    if handoff!=expected_handoff or type(handoff['protectedBudgetDelta'])is not int or reviewed.issuance_proofs!=proofs:
        raise ValueError('LIFECYCLE_DISPATCH_ISSUANCE_CHANGED')
    lifecycle_dispatch_node(reviewed)
    lifecycle_dispatch_capsule(reviewed)
    approved_binding={**binding,'approvedByRoot':True,'dockerSlotReady':True}
    encode=lambda v:json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
    binding_sha=hashlib.sha256(encode(approved_binding)).hexdigest()
    approved_input={**value,'approvedByRoot':True,'dockerSlotReady':True,'signedBindingSha256':binding_sha}
    input_sha=hashlib.sha256(encode(approved_input)).hexdigest()
    approved_paths=(c.root/('auth-lifecycle-approved-binding-'+scope+'.json'),c.root/('auth-lifecycle-approved-input-'+scope+'.json'))
    intent={'version':1,'kind':'ROOT_TYPED_LIFECYCLE_DISPATCH','scopeId':scope,'decisionId':reviewed.decision_id,'sourceHead':reviewed.source_head,
        'lateSha256':reviewed.late_sha256,'handoffSha256':reviewed.handoff_sha256,'originalBindingSha256':reviewed.binding_sha256,
        'originalInputSha256':reviewed.input_sha256,'approvedBindingSha256':binding_sha,'approvedInputSha256':input_sha,
        'issuanceProofs':proofs,'nodePath':str(reviewed.node_path),'nodeSha256':reviewed.node_sha256,'noReplay':True}
    intent.update(capsuleRoot=str(reviewed.capsule_root),capsulePinsSha256=hashlib.sha256(encode(reviewed.capsule_pins)).hexdigest(),factorySha256=reviewed.factory_sha256)
    return c,late,approved_binding,approved_input,approved_paths,intent


def validate_lifecycle_reviewed_paths(reviewed,value):
    root=reviewed.prepared_root
    if reviewed.binding_path==root/'signed-ai-binding-private.json'and reviewed.input_path==root/('auth-lifecycle-input-'+value['scopeId']+'.json'):
        return
    authority=getattr(reviewed,'dispatch_authority',None)
    if type(authority)is not ReviewedLifecycleDispatch:raise ValueError('LIFECYCLE_REVIEWED_PRIVATE_PATH')
    c,_,binding,expected,paths,intent=lifecycle_dispatch_load(authority)
    if(root!=c.root or reviewed.binding_path!=paths[0]or reviewed.input_path!=paths[1]or value!=expected
            or reviewed.binding_sha256!=intent['approvedBindingSha256']or reviewed.input_sha256!=intent['approvedInputSha256']
            or reviewed.source_pins!=authority.producer.source_pins or reviewed.containers!=authority.producer.containers
            or reviewed.issuance_proofs!=authority.issuance_proofs or reviewed.foreign_receipt_sha256 is not None):
        raise ValueError('LIFECYCLE_REVIEWED_PRIVATE_PATH')
    actual=signed_exact_json(signed_private_read(c.evidence/'dispatch-intent.json'))
    if actual!=intent:raise ValueError('LIFECYCLE_DISPATCH_BINDING')
    for path,body in zip(paths,(binding,expected)):
        raw=signed_private_read(path)
        if signed_exact_json(raw)!=body or hashlib.sha256(raw).hexdigest()!=intent['approvedBindingSha256'if path==paths[0]else'approvedInputSha256']:
            raise ValueError('LIFECYCLE_DISPATCH_COPY_CHANGED')


def lifecycle_dispatch_kernel_proof(raw,value):
    proof=signed_exact_json(raw)
    fields={'status','scope','cases','fixedFailures','fullLifecycleCoverage','authMutationsRetained','noSessionResurrection','noMutationReplay',
        'originalBaselineSixPreserved','memberChangedMeaning','serviceMemberRetirement','consentRevocation','containerLifecycle',
        'sequence','physical','actualNaver','externalProvider','naturalMidnight'}
    if(not isinstance(proof,dict)or set(proof)!=fields or proof.get('scope')!=LIFECYCLE_KIND or proof.get('status')!='PASS_PARTIAL'
            or proof.get('fixedFailures')!=[]or proof.get('fullLifecycleCoverage')!='NOT_RUN'
            or not isinstance(proof.get('cases'),dict)or set(proof['cases'])!=set(LIFECYCLE_CASES)):
        raise ValueError('LIFECYCLE_DISPATCH_KERNEL_PROOF_CHANGED')
    if(any(proof[k]is not True for k in('originalBaselineSixPreserved','noSessionResurrection','noMutationReplay'))
            or proof['authMutationsRetained']!=['memberChanged','revokedSession']or proof['memberChangedMeaning']!='AUTH_USER_BANNED_ONLY'
            or any(proof[k]!='NOT_RUN'for k in('serviceMemberRetirement','consentRevocation','actualNaver','externalProvider','naturalMidnight'))
            or proof['sequence']!='NOT_VERIFIED'or proof['physical']!='NOT_VERIFIED'or proof['containerLifecycle']!='UNCHANGED_NOT_STOPPED_BY_RUNNER'):
        raise ValueError('LIFECYCLE_DISPATCH_KERNEL_PROOF_CHANGED')
    for case,v in proof['cases'].items():
        if case in('anonymousBearer','differentOriginalContext'):
            if v!={'status':'NOT_RUN'}:raise ValueError('LIFECYCLE_DISPATCH_KERNEL_PROOF_CHANGED')
            continue
        if not isinstance(v,dict)or type(v.get('authHttpStatus'))is not int or v['authHttpStatus']not in(401,403):
            raise ValueError('LIFECYCLE_DISPATCH_KERNEL_PROOF_CHANGED')
        expected={'status':'PASS','case':case,'httpStatus':401,'authHttpStatus':v['authHttpStatus'],'actualAuthReads':1,'rpcCalls':0,
            'providerCalls':0,'nativeExternalAttempts':0,'originalTokenSha256':hashlib.sha256(value['accounts'][case]['accessToken'].encode()).hexdigest(),
            'actualNaver':'NOT_RUN','externalProvider':'NOT_RUN'}
        if v!=expected or any(type(v[k])is not int for k in('httpStatus','actualAuthReads','rpcCalls','providerCalls','nativeExternalAttempts')):
            raise ValueError('LIFECYCLE_DISPATCH_KERNEL_PROOF_CHANGED')
    return proof


def inspect_lifecycle_dispatch(reviewed):
    """파일 custody만 읽는다. 반환 JSON은 실행 권한이나 새 Auth/headroom 확인이 아니다."""
    c,_,_,value,_,intent=lifecycle_dispatch_load(reviewed)
    path=c.evidence/'dispatch-intent.json'
    if not path.exists():return {'phase':'BOUND_ORIGINAL_INPUT_NOT_DISPATCHED','actualLifecycle':'NOT_RUN','readiness':'NOT_PROOF'}
    if signed_exact_json(signed_private_read(path))!=intent:raise ValueError('LIFECYCLE_DISPATCH_BINDING')
    terminal=c.evidence/'dispatch-receipt.json'
    if not terminal.exists():return {'phase':'DISPATCH_UNKNOWN_NO_REPLAY','actualLifecycle':'UNKNOWN','readiness':'NOT_PROOF'}
    result=signed_exact_json(signed_private_read(terminal))
    if(result.get('scopeId')!=intent['scopeId']or result.get('intentSha256')!=hashlib.sha256(signed_private_read(path)).hexdigest()
            or result.get('originalBindingSha256')!=reviewed.binding_sha256 or result.get('originalInputSha256')!=reviewed.input_sha256):
        raise ValueError('LIFECYCLE_DISPATCH_BINDING')
    raw=signed_private_read(c.root/('auth-lifecycle-'+intent['scopeId'])/'receipt.json')
    if hashlib.sha256(raw).hexdigest()!=result['kernelReceiptSha256']:raise ValueError('LIFECYCLE_DISPATCH_KERNEL_PROOF_CHANGED')
    proof=lifecycle_dispatch_kernel_proof(raw,value)
    expected={'status':'KERNEL_RETURNED_WITH_STORED_PROOF','scopeId':intent['scopeId'],'intentSha256':hashlib.sha256(signed_private_read(path)).hexdigest(),
        'originalBindingSha256':reviewed.binding_sha256,'originalInputSha256':reviewed.input_sha256,
        'kernelReceiptSha256':hashlib.sha256(raw).hexdigest(),'kernelStatus':proof['status'],'fullLifecycleCoverage':proof['fullLifecycleCoverage'],
        'anonymous':'NOT_RUN','foreign':'NOT_RUN','originalProducerInputsPreserved':True,'noReplay':True}
    if result!=expected:raise ValueError('LIFECYCLE_DISPATCH_KERNEL_PROOF_CHANGED')
    return {'phase':'KERNEL_RETURNED_WITH_STORED_PROOF','kernelStatus':result['kernelStatus'],'fullLifecycleCoverage':result['fullLifecycleCoverage'],
        'receiptSha256':hashlib.sha256(signed_private_read(terminal)).hexdigest(),'kernelReceiptSha256':result['kernelReceiptSha256'],'readiness':'NOT_PROOF'}


def dispatch_lifecycle_accounts(reviewed):
    """검토 객체와 원 SHA의 단일 실제 kernel 연결. CLI 경로·수명·토큰·원 receipt를 바꾸지 않는다."""
    c,_,binding,value,paths,intent=lifecycle_dispatch_load(reviewed)
    if any(p.exists()or p.is_symlink()for p in(c.evidence/'dispatch-intent.json',paths[0],paths[1],Path(value['evidenceRoot']))):
        raise ValueError('LIFECYCLE_DISPATCH_PREVIOUS_ATTEMPT')
    intent_sha=c.save('dispatch-intent.json',intent)
    try:
        if lcp_save(c.root,paths[0].name,binding)!=intent['approvedBindingSha256']:raise ValueError('LIFECYCLE_DISPATCH_COPY_CHANGED')
        if lcp_save(c.root,paths[1].name,value)!=intent['approvedInputSha256']:raise ValueError('LIFECYCLE_DISPATCH_COPY_CHANGED')
        child=ReviewedSignedAuthLifecycle(reviewed.decision_id,c.root,paths[0],paths[1],intent['approvedBindingSha256'],intent['approvedInputSha256'],
            reviewed.producer.source_pins,reviewed.producer.containers,reviewed.issuance_proofs)
        child.dispatch_authority=reviewed
        validate_lifecycle_reviewed_paths(child,value)
        # 기존 kernel이 현재 actual Auth/DB/closed controls/1GiB+768MiB/expiry를 검증하고 모든 mutation을 소유한다.
        run_signed_auth_lifecycle(child,binding,value,str(reviewed.node_path))
        raw=signed_private_read(Path(value['evidenceRoot'])/'receipt.json');proof=lifecycle_dispatch_kernel_proof(raw,value)
        # 후속 코드 변경/원 JWT 파일 교체도 성공을 만들지 않는다.
        lifecycle_dispatch_load(reviewed)
        result={'status':'KERNEL_RETURNED_WITH_STORED_PROOF','scopeId':intent['scopeId'],'intentSha256':intent_sha,
            'originalBindingSha256':reviewed.binding_sha256,'originalInputSha256':reviewed.input_sha256,
            'kernelReceiptSha256':hashlib.sha256(raw).hexdigest(),'kernelStatus':proof['status'],'fullLifecycleCoverage':proof['fullLifecycleCoverage'],
            'anonymous':'NOT_RUN','foreign':'NOT_RUN','originalProducerInputsPreserved':True,'noReplay':True}
        c.save('dispatch-receipt.json',result);return result
    except BaseException:
        preserved=False
        try:
            preserved=(hashlib.sha256(signed_private_read(c.root/'signed-ai-binding-private.json')).hexdigest()==reviewed.binding_sha256
                and hashlib.sha256(signed_private_read(c.root/('auth-lifecycle-input-'+intent['scopeId']+'.json'))).hexdigest()==reviewed.input_sha256)
        except BaseException:pass
        try:c.save('dispatch-failure.json',{'status':'UNKNOWN','scopeId':intent['scopeId'],'intentSha256':intent_sha,
            'code':'LIFECYCLE_DISPATCH_FAILED','noReplay':True,'originalProducerInputsPreserved':preserved})
        except BaseException:pass
        raise ValueError('LIFECYCLE_DISPATCH_UNKNOWN_PRIVATE_EVIDENCE_PRESERVED')from None


if __name__=='__main__':
    try:signed_auth_lifecycle_main() if '--signed-auth-lifecycle'in sys.argv else signed_main() if any(k in sys.argv for k in ('--signed-local-auth','--signed-auth')) else main()
    except Exception as error:
        code=str(error)if re.fullmatch(r'[A-Z0-9_,]+',str(error))else'ISOLATED_AI_FAILED'
        print(json.dumps({'status':'FAIL','code':code}));sys.exit(1)
