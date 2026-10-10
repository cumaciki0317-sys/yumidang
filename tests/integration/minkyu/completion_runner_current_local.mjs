/** 민규: 독립 drift 클러스터의 현재 schema와 원형 실행기 프로세스/전용 LOGIN 실제 검증. */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, fstatSync, realpathSync, openSync, closeSync, fsyncSync, constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

if (process.argv[2] === '--fresh-completion') {
  try { await freshCompletionMain(process.argv.slice(2)); } catch (error) { console.log(JSON.stringify({status:'FAIL',stage:'FRESH_GUARD_OR_CONTROL',fixtureReplay:0,...(error.safeDiagnostic?{diagnostic:error.safeDiagnostic}:{})})); process.exitCode=1; }
} else {
const options = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => i % 2 ? a : [...a, [v, all[i + 1]]], []));
const source = resolve(options['--source-root'] ?? '');
const runtime = resolve(options['--runtime-root'] ?? '');
const database = options['--database'];
const container = 'supabase_db_yumidang-minkyu-drift';
const host = 'unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock';
const role = 'ym_completion_current_' + randomBytes(10).toString('hex');
const password = randomBytes(32).toString('hex');
const group = 'yumidang_completion_runner';
const users = [randomUUID(), randomUUID()];
const postIds = Array.from({ length: 5 }, randomUUID);
const requestIds = Array.from({ length: 5 }, randomUUID);
const appointmentIds = Array.from({ length: 5 }, randomUUID);
let stage = 'configuration', roleCreated = false, fixtureCreated = false, cleanupPassed = false, child, worker, failure, groups = 0;
const assert = (ok, label) => { if (!ok) throw new Error(label); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function sql(text) {
  const result = spawnSync('docker', ['--host', host, 'exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database],
    { input: text, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  assert(result.status === 0, 'scratch_sql_failed');
  return result.stdout.trim();
}
const rows = query => JSON.parse(sql(`select coalesce(json_agg(q),'[]') from (${query}) q;`));
async function until(check, label, timeout = 18000) {
  const start = performance.now();
  while (performance.now() - start < timeout) { if (await check()) return; await sleep(100); }
  throw new Error(label);
}
function startRunner() {
  const env = { ...process.env, COMPLETION_DATABASE_URL: `postgresql://${role}:${password}@127.0.0.1:56532/${database}`,
    COMPLETION_RECONNECT_MS: '5000', COMPLETION_QUERY_TIMEOUT_MS: '10000' };
  const proc = spawn(process.execPath, [resolve(runtime, 'supabase/functions/scheduled-jobs/completion-runner.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = { proc, ready: 0, unavailable: 0, unexpected: false, exited: false, code: null, signal: null };
  result.done = new Promise(r => proc.once('exit', (code, signal) => { result.exited = true; result.code = code; result.signal = signal; r(); }));
  proc.stdout.on('data', () => { result.unexpected = true; });
  let partial = '';
  proc.stderr.on('data', data => {
    partial += data.toString();
    const lines = partial.split('\n'); partial = lines.pop();
    for (const line of lines) {
      if (line === 'COMPLETION_SCHEDULER_READY') result.ready++;
      else if (line === 'COMPLETION_CONNECTION_UNAVAILABLE') result.unavailable++;
      else result.unexpected = true;
    }
  });
  return result;
}
async function stopRunner() {
  if (!child) return;
  const current = child; child = undefined;
  if (!current.exited) current.proc.kill('SIGTERM');
  let timer;
  const clean = await Promise.race([current.done.then(() => true), new Promise(r => { timer = setTimeout(() => r(false), 7000); })]);
  clearTimeout(timer);
  if (!clean) { current.proc.kill('SIGKILL'); await current.done; }
  assert(clean && current.code === 0 && !current.signal && !current.unexpected, 'runner_process_stop_failed');
}
function runnerSessions() {
  return rows(`select pid from pg_stat_activity where datname='${database}' and usename='${role}' and application_name='yumidang-completion-scheduler'`);
}
function fixture(index, dueMs) {
  const p = postIds[index], r = requestIds[index], a = appointmentIds[index];
  sql(`begin;
  insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,cost_type,amount,status)
  select '${p}','${users[0]}','합성 완료 실행기','현재 전용 실행기 합성 검증','산책',
    clock_timestamp()+interval '${dueMs} milliseconds'-interval '25 hours',clock_timestamp()+interval '${dueMs} milliseconds'-interval '24 hours',
    clock_timestamp()+interval '${dueMs} milliseconds'-interval '26 hours','서울특별시 강남구 역삼동','free',0,'closed';
  insert into public.join_requests(id,post_id,requester_id,message,status) values('${r}','${p}','${users[1]}','합성 신청','matched');
  insert into public.appointments(id,post_id,join_request_id,status) values('${a}','${p}','${r}','confirmed');commit;`);
  return rows(`select generation,due_at from private.completion_reservations where appointment_id='${a}'`)[0];
}
function state(index) {
  return rows(`select ap.status,ap.completion_method,ap.completed_at,
   ap.review_deadline_at=ap.completed_at+interval '7 days' as deadline,
   ap.completed_at>=ap.confirmed_at as actual_time,
   (select count(*) from public.notifications n where n.kind='appointment_completed' and n.join_request_id=ap.join_request_id) as notices,
   (select count(*) from public.appointment_completion_confirmations c where c.appointment_id=ap.id) as confirmations,
   exists(select 1 from private.completion_reservations c where c.appointment_id=ap.id) as reserved
   from public.appointments ap where ap.id='${appointmentIds[index]}'`)[0];
}
async function automatic(index) {
  await until(() => state(index)?.status === 'completed', 'automatic_completion_missing');
  const s = state(index);
  assert(s.completion_method === 'automatic' && s.deadline && s.actual_time && Number(s.notices) === 2 && Number(s.confirmations) === 0 && !s.reserved, 'automatic_result_invalid');
  return s.completed_at;
}
function confirm(index, user) {
  const claims = JSON.stringify({ role: 'authenticated', sub: user, is_anonymous: false });
  sql(`begin;set local role authenticated;set local request.jwt.claim.sub='${user}';set local request.jwt.claims='${claims}';
   select public.confirm_appointment_completion('${appointmentIds[index]}');commit;`);
}
try {
  assert(source.startsWith('/Users/minkyu/Documents/GitHub/yumidang/') && runtime.startsWith('/private/tmp/'), 'source_runtime_boundary');
  assert(/^yumidang_completion_current_20261005(?:_[a-z0-9]+)?$/.test(database ?? ''), 'scratch_database_boundary');
  assert(options['--docker-host'] === host && options['--container'] === container && options['--port'] === '56532', 'dedicated_cluster_boundary');
  for (const relative of ['supabase/functions/scheduled-jobs/completion-runner.mjs', 'supabase/functions/_shared/jobs/completion-scheduler.mjs', 'package.json', 'package-lock.json']) {
    assert(createHash('sha256').update(readFileSync(resolve(source, 'backend', relative))).digest('hex') ===
      createHash('sha256').update(readFileSync(resolve(runtime, relative))).digest('hex'), 'original_runner_bytes');
  }
  assert(JSON.parse(readFileSync(resolve(runtime, 'node_modules/pg/package.json'))).version === '8.22.0', 'locked_pg_version');
  assert(rows(`select current_database() as db`)[0].db === database, 'connected_scratch_only');
  assert(rows(`select count(*) as n from auth.users`)[0].n === 0 && rows(`select count(*) as n from public.posts`)[0].n === 0, 'empty_scratch_required');
  stage = 'login_permissions';
  sql(`begin;create role "${role}" login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 2 password '${password}';
    grant ${group} to "${role}";grant connect on database "${database}" to "${role}";commit;`);
  roleCreated = true;
  const attrs = rows(`select rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname='${role}'`)[0];
  assert(attrs.rolcanlogin && attrs.rolinherit && !attrs.rolsuper && !attrs.rolcreatedb && !attrs.rolcreaterole && !attrs.rolreplication && !attrs.rolbypassrls, 'login_flags');
  const membership = rows(`select p.rolname,m.admin_option from pg_auth_members m join pg_roles p on p.oid=m.roleid join pg_roles c on c.oid=m.member where c.rolname='${role}'`);
  assert(membership.length === 1 && membership[0].rolname === group && !membership[0].admin_option, 'single_group_only');
  const perms = rows(`select has_schema_privilege('${role}','public','CREATE') as creates,
   has_schema_privilege('${role}','private','USAGE') as private_usage,
   (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private','auth','storage','cron','realtime','supabase_migrations','supabase_functions','vault')
    and has_schema_privilege('${role}',n.oid,'USAGE') and has_function_privilege('${role}',p.oid,'EXECUTE')) as functions,
   exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage','cron','realtime','supabase_migrations','supabase_functions','vault')
    and has_schema_privilege('${role}',n.oid,'USAGE') and c.relkind in('r','p','v','m','f') and (has_table_privilege('${role}',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege('${role}',c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) as tables`)[0];
  assert(!perms.creates && !perms.private_usage && Number(perms.functions) === 2 && !perms.tables, 'two_effective_rpcs_only');
  const { Client } = createRequire(resolve(runtime, 'package.json'))('pg');
  worker = new Client({ connectionString: `postgresql://${role}:${password}@127.0.0.1:56532/${database}`, ssl: false });
  worker.on('error', () => {});await worker.connect();
  assert((await worker.query('select current_user as u,session_user as s')).rows.every(r => r.u === role && r.s === role), 'actual_login_identity');
  for (const command of ['select * from public.profiles', 'select * from private.completion_reservations', 'select public.process_due_completions(1)', 'set role service_role']) {
    let denied = false;try { await worker.query(command); } catch (e) { denied = e.code === '42501'; }assert(denied, 'actual_privilege_denial');
  }
  await worker.end();worker = undefined;groups++;
  stage = 'fixtures';fixtureCreated = true;
  sql(`begin;insert into auth.users(id,email) values('${users[0]}','${users[0]}@fixture.invalid'),('${users[1]}','${users[1]}@fixture.invalid');
    insert into public.profiles(id,real_name,birth_date,gender) values('${users[0]}','합성작성자','1990-01-01','female'),('${users[1]}','합성신청자','1990-01-01','female');commit;`);
  stage = 'startup_recovery';fixture(0, -1000);child = startRunner();await until(() => child.ready === 1, 'initial_ready_missing');await automatic(0);groups++;
  stage = 'committed_notification_timer';fixture(1, 1600);assert(state(1).status === 'confirmed', 'timer_fired_early');await automatic(1);groups++;
  stage = 'bilateral_manual';fixture(2, 60000);confirm(2, users[0]);assert(state(2).status === 'confirmed' && Number(state(2).confirmations) === 1, 'one_person_completed');
  confirm(2, users[1]);const manual = state(2);assert(manual.status === 'completed' && manual.completion_method === 'manual' && Number(manual.confirmations) === 2 && !manual.reserved, 'bilateral_manual_invalid');groups++;
  // 합성 운영 보류 행으로 자동 완료 predicate를 검증한다. 사용자 분쟁 접수 gateway 검증과 구분한다.
  stage = 'dispute_hold';fixture(3, 1500);sql(`begin;insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining) values('${appointmentIds[3]}','${users[1]}','합성 분쟁 보류',interval '7 days');
    commit;`);await sleep(2000);assert(state(3).status === 'confirmed' && state(3).completed_at === null && !state(3).reserved, 'dispute_was_completed');groups++;
  stage = 'real_backend_reconnect';const oldSession = runnerSessions();assert(oldSession.length === 1, 'single_runner_session');
  assert(rows(`select pg_terminate_backend(${Number(oldSession[0].pid)}) as terminated`)[0].terminated, 'terminate_runner_backend');
  await until(() => child.unavailable >= 1, 'connection_loss_not_reported');fixture(4, -1000);
  await until(() => child.ready >= 2 && runnerSessions().length === 1 && runnerSessions()[0].pid !== oldSession[0].pid, 'reconnect_not_observed');
  await automatic(4);assert(state(0).completed_at !== null && !child.unexpected && !child.exited, 'runner_recovery_invalid');groups++;
  stage = 'clean_process_stop';await stopRunner();await until(() => runnerSessions().length === 0, 'runner_session_remained');groups++;
} catch { failure = stage; }
finally {
  try { await worker?.end();await stopRunner(); } catch { failure ??= 'process_cleanup'; }
  try {
    if (fixtureCreated) sql(`begin;delete from public.posts where id in(${postIds.map(id => `'${id}'`).join(',')});delete from public.profiles where id in('${users[0]}','${users[1]}');delete from auth.users where id in('${users[0]}','${users[1]}');delete from private.member_episodes where profile_id in('${users[0]}','${users[1]}');commit;`);
    if (roleCreated) sql(`revoke connect on database "${database}" from "${role}";revoke ${group} from "${role}";drop role "${role}";`);
    if (fixtureCreated) assert(rows(`select count(*) as n from auth.users`)[0].n === 0 && rows(`select count(*) as n from public.posts`)[0].n === 0, 'fixture_rows_remained');
    if (roleCreated) assert(rows(`select count(*) as n from pg_roles where rolname='${role}'`)[0].n === 0 && runnerSessions().length === 0, 'role_or_session_remained');
    if (fixtureCreated) assert(rows(`select count(*) as n from private.member_episodes where profile_id in('${users[0]}','${users[1]}')`)[0].n === 0, 'episode_rows_remained');
    cleanupPassed = true;
  } catch { failure ??= 'fixture_role_cleanup'; }
}
console.log(JSON.stringify({ status: failure ? 'FAIL' : 'PASS', stage: failure ?? 'complete', groups, actualRunnerProcess: groups >= 2,
  actualDedicatedLogin: groups >= 1, operatingDeployment: 'NOT_RUN', cleanup: cleanupPassed ? 'PASS' : 'FAIL' }));
process.exitCode = failure ? 1 : 0;

}

// 새 모드는 명시적 준비 영수증을 검증하며 과거 drift 경로에 도달하지 않는다.
async function freshCompletionMain(argv) {
  const check = (ok, label) => { if (!ok) throw Error(label); };
  check(argv.length === 4 && argv[0] === '--fresh-completion' && ['prepare','run','competition','finalize'].includes(argv[1]) && argv[2] === '--revision' && /^v[1-9][0-9]?$/.test(argv[3]), 'EXACT_FRESH_ARGUMENTS_REQUIRED');
  const action=argv[1],revision=argv[3];
  const repo='/Users/minkyu/Documents/GitHub/yumidang/.worktrees/minkyu-foundation';
  const root='/private/tmp/yumidang-completion-current-'+revision;
  const helper=String.raw`import sys,json,hashlib,importlib.util,os,secrets,subprocess,uuid,stat,re,datetime,contextlib,io,traceback
from pathlib import Path
repo=Path(sys.argv[1]);revision=sys.argv[2];action=sys.argv[3]
assert str(repo)=='/Users/minkyu/Documents/GitHub/yumidang/.worktrees/minkyu-foundation'
assert re.fullmatch(r'v[1-9][0-9]?',revision)and action in('prepare','readiness','finalize')
root=Path('/private/tmp/yumidang-completion-current-'+revision)
name='yumidang-minkyu-completion-current-'+revision;role='ym_completion_fresh_'+revision
recipe=hashlib.sha256(str(root).encode()).hexdigest()
docker=['docker','--host','unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock']
created=[];baseline={};source=None

DIAGNOSTIC_TOKENS={'INHERITED_RESERVATIONS_REFUSED','BASE_PREPARE_STDOUT_CONTRACT','ISOLATION_SOURCE_DIGEST_REQUIRED','ISOLATION_EXACT_ROWS_REQUIRED','ISOLATION_APPOINTMENTS_REQUIRED','ISOLATION_ONLY_RESERVATION_DIFF_ALLOWED','ISOLATION_BASELINE_EXACT','ISOLATION_DELETE_EXACT_TWO','ISOLATION_LINKED_APPOINTMENTS_CHANGED','ISOLATION_SOURCE_UNCHANGED','ISOLATION_PROOF_REQUIRED','FIXED_CONTROL_COMMAND_FAILED','FROZEN_HELPERS_REQUIRED_NO_EFFECT','PRIVATE_DIRECTORY_REQUIRED','PRIVATE_SINGLE_FILE_REQUIRED','PRIVATE_FILE_REPLACED','CURRENT_SQL_ABI_MISMATCH','CURRENT_STOCK_TLS_RUNNER_REQUIRED','SOURCE_CHANGED_DURING_PREPARE','PREPARE_MEMORY_768_REQUIRED_NO_EFFECT','NAMESPACE_COLLISION_NO_CREATE','NETWORK_COLLISION_NO_CREATE'}
SQLSTATES={'42501','22023','42601','42703','42P01','42883','55000','40001','57014','28000','28P01'}
FRAME_LABELS={'<string>':'embedded_control','worker_safety_http_local.py':'worker_safety_helper','worker_invocation_http_local.py':'worker_invocation_helper','member_retirement_auth_local.py':'source_snapshot_helper'}
def safe_diagnostic(error,tb):
 token=error.args[0]if error.args and isinstance(error.args[0],str)and error.args[0]in DIAGNOSTIC_TOKENS else'UNCLASSIFIED_CONTROL_FAILURE'
 frames=[{'label':FRAME_LABELS[Path(frame.f_code.co_filename).name],'line':line}for frame,line in traceback.walk_tb(tb)if Path(frame.f_code.co_filename).name in FRAME_LABELS][-8:]
 state=getattr(error,'safe_sqlstate',None);digest=getattr(error,'safe_stderr_sha256',None)
 return{'status':'FAIL_FIXED_CONTROL_DIAGNOSTIC','token':token,'frames':frames,'sqlstate':state if state in SQLSTATES else None,'stderrSha256':digest if isinstance(digest,str)and re.fullmatch('[0-9a-f]{64}',digest)else None}
sys.excepthook=lambda _,error,tb:print(json.dumps(safe_diagnostic(error,tb)))

def private_dir(path):
 v=path.lstat();assert stat.S_ISDIR(v.st_mode)and not path.is_symlink()and path.resolve()==path and v.st_uid==os.getuid()and stat.S_IMODE(v.st_mode)==0o700,'PRIVATE_DIRECTORY_REQUIRED'

def private_at(directory,name):
 private_dir(directory);path=directory/name
 assert path.parent==directory,'PRIVATE_FIXED_PATH_REQUIRED'
 v=path.lstat();assert stat.S_ISREG(v.st_mode)and v.st_uid==os.getuid()and stat.S_IMODE(v.st_mode)==0o600 and v.st_nlink==1 and path.resolve()==path,'PRIVATE_SINGLE_FILE_REQUIRED'
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  current=os.fstat(fd);assert(current.st_dev,current.st_ino,current.st_nlink)==(v.st_dev,v.st_ino,1)and current.st_uid==os.getuid()and stat.S_IMODE(current.st_mode)==0o600,'PRIVATE_FILE_REPLACED'
  with os.fdopen(fd,'rb',closefd=False)as f:return f.read()
 finally:os.close(fd)

def private_read(name):return private_at(root,name)

def durable_create(name,data):
 private_dir(root);path=root/name;assert path.parent==root
 if isinstance(data,str):data=data.encode()
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  with os.fdopen(fd,'wb',closefd=False)as f:f.write(data);f.flush();os.fsync(fd)
 finally:os.close(fd)
 fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
 fd=os.open(root.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)

def save(name,value):durable_create(name,json.dumps(value,sort_keys=True))
def raw(args,data=None,timeout=120):
 if 'psql'in args:args=list(args)+['-v','VERBOSITY=sqlstate']
 r=subprocess.run(args,input=data,capture_output=True,timeout=timeout)
 if r.returncode:
  error=RuntimeError('FIXED_CONTROL_COMMAND_FAILED');error.safe_stderr_sha256=hashlib.sha256(r.stderr).hexdigest()
  match=re.search(rb'^ERROR:\s+([0-9A-Z]{5})(?::|\s*$)',r.stderr,re.M);code=match.group(1).decode()if match else None
  error.safe_sqlstate=code if code in SQLSTATES else None;raise error
 return r.stdout

def inspect(identifier):return json.loads(raw(docker+['inspect',identifier]))[0]
def assert_created(record,prior_ids):
 assert set(record)=={'id','name','memoryCap','recipe'}and re.fullmatch(r'[0-9a-f]{64}',record['id'])and record['id']not in prior_ids,'CREATED_ID_PROVENANCE_REQUIRED'
 assert record['name']in(name,name+'-rest')and record['recipe']==recipe,'CREATED_SCOPE_REQUIRED'
 assert record['memoryCap']==(128 if record['name'].endswith('-rest')else 512)*1024*1024,'CREATED_CAP_REQUIRED'
 return record

def prior():
 ids=raw(docker+['ps','--all','--quiet']).decode().splitlines();values=json.loads(raw(docker+['inspect',*ids]))if ids else[]
 return{v['Id']:{'metadata':h.container_metadata(v),'state':{k:v['State'][k]for k in('Status','Running','Paused','Restarting','OOMKilled','Dead','ExitCode','StartedAt','FinishedAt')}}for v in values}

def stop_created(records,prior_ids,errors):
 stopped=[]
 for record in records:
  try:
   assert_created(record,prior_ids);v=inspect(record['id'])
   assert v['Id']==record['id']and v['Name']=='/'+record['name']and(v['Config'].get('Labels')or{}).get('yumidang.owner')=='minkyu'and(v['Config'].get('Labels')or{}).get('yumidang.completion.recipe')==recipe,'STOP_IDENTITY_REQUIRED'
   if v['State']['Running']:raw(docker+['stop','--time','10',record['id']])
   after=inspect(record['id']);assert not after['State']['Running']and after['State']['Status']=='exited'and not after['State']['OOMKilled'],'OWN_STOP_OR_OOM_FAILED'
   stopped.append({'id':record['id'],'stopped':True,'oom':False})
  except Exception:errors.append('OWN_STOP_NOT_PROVEN')
 return stopped

HELPERS={'tests/integration/minkyu/worker_safety_http_local.py': 'b3e34e0d07b495aece4548a427d245f09d756d6e85dbeb1500f49d98bf10218c', 'tests/integration/minkyu/worker_invocation_http_local.py': '91f058ce2be26adf56568aee363a77a6e015f76755148846b0974641a8a247e8', 'tests/integration/minkyu/member_retirement_auth_local.py': '44708062daa8e6c80a391fde9f4001e5d3148c7005821ab8908a03a4ee1a6f3a', 'tools/local/remote_schema_catalog.sql': '4405360718ce6f5f5c3c249964390ed1dfba156369b55ab52982d800f4614772'}
try:helpers_match=all((repo/n).resolve()==repo/n and hashlib.sha256((repo/n).read_bytes()).hexdigest()==v for n,v in HELPERS.items())
except Exception:helpers_match=False
if not helpers_match:
 assert action=='finalize','FROZEN_HELPERS_REQUIRED_NO_EFFECT'
 private_dir(root);errors=['HELPER_GRAPH_CHANGED'];own=[json.loads(private_read(p.name))for p in root.glob('created-*.json')]
 try:prior_ids=set(json.loads(private_read('completion-prior-private.json')))
 except Exception:prior_ids=set();errors.append('PRIVATE_PRIOR_NOT_PROVEN')
 for record in own:
  if record['name']!=name:continue
  try:
   assert_created(record,prior_ids);v=inspect(record['id']);assert v['Name']=='/'+name and(v['Config'].get('Labels')or{}).get('yumidang.completion.recipe')==recipe
   if v['State']['Running']:
    q="do $$begin if exists(select 1 from pg_roles where rolname='"+role+"')then execute 'alter role "+role+" nologin';end if;end;$$;"
    raw(docker+['exec','-i',record['id'],'psql','-XqAt','-U','yumidang_production_recovery_bootstrap','-d','postgres','-v','ON_ERROR_STOP=1'],q.encode())
  except Exception:errors.append('ROLE_CLOSE_NOT_PROVEN')
 stopped=stop_created(own,prior_ids,errors)
 result={'status':'FAIL_PRESERVED_HELPER_GRAPH_CHANGED','ownStopped':stopped,'errors':errors,'sourceFullUnchanged':False,'productSqlUnchanged':False,'priorUnchanged':False}
 save('completion-final-stopped.json',result);print(json.dumps(result));sys.exit(1)

p=repo/'tests/integration/minkyu/worker_safety_http_local.py'
sys.argv=[str(p),'--snapshot','--scenario','review-unsupported-due','--revision',revision]
spec=importlib.util.spec_from_file_location('completion_snapshot_tls_helpers',p);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
b=h.b;b.ROOT=root;b.NAME=name;b.REST=name+'-rest';b.NETWORK=name+'-network'
b.RECONNECT=False;b.RECONNECT_V8=b.RECONNECT_V9=b.RECONNECT_V12=True;b.REVISION='completion-'+revision
# 기존 M fresh_docker가 상한·healthcheck·별칭을 주입한다. base의 중복 subnet은 켜지 않는다.
original_docker=b.docker;original_sql=b.sql

def scoped_docker(*args,data=None):
 if args[:2]==('network','create'):
  # 생성 전에 저장한 prior는 실패 정리에서도 기존 ID를 제외한다.
  save('completion-prior-private.json',baseline);save('completion-source-before-private.json',source)
 start=args[:2]==('run','-d')
 if start:
  target=args[args.index('--name')+1];assert target in(name,name+'-rest'),'OWN_CREATE_NAME_REQUIRED'
  save('creation-intent-'+target+'.json',{'name':target,'memoryCap':(128 if target.endswith('-rest')else 512)*1024*1024,'recipe':recipe,'priorSha256':hashlib.sha256(private_read('completion-prior-private.json')).hexdigest(),'namespaceAbsent':True})
  args=args[:2]+('--label','yumidang.completion.recipe='+recipe)+args[2:]
 result=original_docker(*args,data=data)
 if start:
  identifier=result.decode().strip();record={'id':identifier,'name':target,'memoryCap':(128 if target.endswith('-rest')else 512)*1024*1024,'recipe':recipe}
  assert_created(record,set(baseline));created.append(record);save('created-'+identifier+'.json',record)
 return result

def scoped_sql(query,target=None):
 target=b.NAME if target is None else target
 if target==b.SOURCE:query='begin read only;'+query+';rollback;'
 return original_sql(query,target)
b.docker=scoped_docker;b.sql=scoped_sql;b.save=durable_create;b.call=raw

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def load(name):return json.loads(private_read(name))
def metadata():return h.owned_metadata()
def available():
 raw_memory=raw(docker+['exec',b.SOURCE,'cat','/proc/meminfo']).decode()
 return int(next(x.split()[1]for x in raw_memory.splitlines()if x.startswith('MemAvailable:')))
def records():
 result=[load(p.name)for p in root.glob('created-*.json')]
 assert len({v['id']for v in result})==len(result),'CREATED_DUPLICATE_ID'
 return result
product=['backend/supabase/functions/scheduled-jobs/completion-runner.mjs','backend/supabase/functions/_shared/jobs/completion-scheduler.mjs','backend/package.json','backend/package-lock.json']
files=product+['backend/supabase/migrations/20260929120000_review_release_and_completion_reservations.sql','backend/supabase/migrations/20261002110000_completion_review_policy.sql','backend/supabase/migrations/20261003090000_completion_runner_role.sql','tests/integration/minkyu/worker_safety_http_local.py','tests/integration/minkyu/worker_invocation_http_local.py','tests/integration/minkyu/member_retirement_auth_local.py','tools/local/remote_schema_catalog.sql','tests/integration/minkyu/completion_runner_current_local.mjs']
runner='b07007db2f44c0673efdc7af74bba92df531df191b23ac482d2cfb32b3569484'
if action!='finalize':assert sha(repo/product[0])==runner,'CURRENT_STOCK_TLS_RUNNER_REQUIRED'
if action!='finalize':assert json.loads((repo/'backend/node_modules/pg/package.json').read_text())['version']=='8.22.0'
functions=('list_completion_reservations()','execute_completion_reservation(uuid,uuid)')
def definition_hashes(target):return{n:hashlib.sha256(b.sql("select pg_get_functiondef('public."+n+"'::regprocedure);",target)).hexdigest()for n in functions}

def clone_snapshot():
 path=repo/'tests/integration/minkyu/member_retirement_auth_local.py'
 spec=importlib.util.spec_from_file_location('completion_clone_snapshot',path);helper=importlib.util.module_from_spec(spec);previous=sys.argv
 try:sys.argv=[str(path)];spec.loader.exec_module(helper)
 finally:sys.argv=previous
 helper.REPO=repo
 helper.sql=lambda query,target:b.sql('begin read only;'+query+';rollback;',target).decode().strip()
 result=helper.snapshot(b.NAME)
 result['membershipGrantors']=json.loads(b.sql("select coalesce(json_agg(json_build_array(pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor),admin_option,inherit_option,set_option)order by pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor)),'[]')from pg_auth_members;").decode())
 return result

def isolation_rows():return json.loads(b.sql("select coalesce(jsonb_agg(to_jsonb(r)order by r.appointment_id),'[]')from private.completion_reservations r;").decode())
def isolation_appointments(rows):
 ids=','.join("'"+str(uuid.UUID(v['appointment_id']))+"'"for v in rows)
 return json.loads(b.sql("select coalesce(jsonb_agg(to_jsonb(a)order by a.id),'[]')from public.appointments a where a.id in("+ids+");").decode())
def validate_isolation_rows(rows,appointments):
 assert isinstance(rows,list)and len(rows)==2 and all(isinstance(v,dict)and set(v)=={'appointment_id','due_at','generation'}for v in rows),'ISOLATION_EXACT_ROWS_REQUIRED'
 ids=[]
 for row in rows:
  assert all(isinstance(row[n],str)for n in row),'ISOLATION_EXACT_ROWS_REQUIRED'
  assert str(uuid.UUID(row['appointment_id']))==row['appointment_id']and str(uuid.UUID(row['generation']))==row['generation'],'ISOLATION_EXACT_ROWS_REQUIRED'
  due=datetime.datetime.fromisoformat(row['due_at']);assert due.tzinfo is not None,'ISOLATION_EXACT_ROWS_REQUIRED'
  ids.append(row['appointment_id'])
 assert len(set(ids))==2 and ids==sorted(ids),'ISOLATION_EXACT_ROWS_REQUIRED'
 assert isinstance(appointments,list)and len(appointments)==2 and all(isinstance(v,dict)and v.get('id')==ids[i]for i,v in enumerate(appointments)),'ISOLATION_APPOINTMENTS_REQUIRED'
 return ids
def compare_isolation_snapshots(before,after):
 assert before['rows']['private.completion_reservations']=='2:e98f11700476723b5eaf69eb42b3271a','ISOLATION_SOURCE_DIGEST_REQUIRED'
 expected=json.loads(json.dumps(before));expected['rows']['private.completion_reservations']='0:d41d8cd98f00b204e9800998ecf8427e'
 assert after==expected,'ISOLATION_ONLY_RESERVATION_DIFF_ALLOWED'

def isolation_sql(rows,appointments):
 validate_isolation_rows(rows,appointments)
 row_hex=json.dumps(rows,sort_keys=True).encode().hex();appointment_hex=json.dumps(appointments,sort_keys=True).encode().hex()
 # 원 약속 -> 원 예약 순서로 잠그고, 전체 행을 검증한 뒤 새 clone의 정확한 두 예약만 제거한다.
 return """begin;do $isolation$
 declare expected_rows jsonb:=convert_from(decode('"""+row_hex+"""','hex'),'UTF8')::jsonb;
 expected_appointments jsonb:=convert_from(decode('"""+appointment_hex+"""','hex'),'UTF8')::jsonb;
 actual_rows jsonb;actual_appointments jsonb;deleted_rows jsonb;deleted_count integer;
 begin
 perform 1 from public.appointments a where a.id in(select (v->>'appointment_id')::uuid from jsonb_array_elements(expected_rows)v)order by a.id for update;
 perform 1 from private.completion_reservations r where r.appointment_id in(select (v->>'appointment_id')::uuid from jsonb_array_elements(expected_rows)v)order by r.appointment_id for update;
 select coalesce(jsonb_agg(to_jsonb(r)order by r.appointment_id),'[]')into actual_rows from private.completion_reservations r;
 select coalesce(jsonb_agg(to_jsonb(a)order by a.id),'[]')into actual_appointments from public.appointments a where a.id in(select (v->>'appointment_id')::uuid from jsonb_array_elements(expected_rows)v);
 if actual_rows is distinct from expected_rows or actual_appointments is distinct from expected_appointments then raise exception 'ISOLATION_BASELINE_EXACT'using errcode='40001';end if;
 with deleted as(delete from private.completion_reservations r using jsonb_to_recordset(expected_rows)v(appointment_id uuid,due_at timestamptz,generation uuid)
 where r.appointment_id=v.appointment_id and r.due_at=v.due_at and r.generation=v.generation returning to_jsonb(r)as reservation_json)
 select count(*),coalesce(jsonb_agg(reservation_json order by reservation_json->>'appointment_id'),'[]')into deleted_count,deleted_rows from deleted;
 if deleted_count<>2 or deleted_rows is distinct from expected_rows or exists(select 1 from private.completion_reservations)then raise exception 'ISOLATION_DELETE_EXACT_TWO'using errcode='40001';end if;
 select coalesce(jsonb_agg(to_jsonb(a)order by a.id),'[]')into actual_appointments from public.appointments a where a.id in(select (v->>'appointment_id')::uuid from jsonb_array_elements(expected_rows)v);
 if actual_appointments is distinct from expected_appointments then raise exception 'ISOLATION_LINKED_APPOINTMENTS_CHANGED'using errcode='40001';end if;
 end;$isolation$;commit;"""

def isolate_inherited_reservations():
 assert source['rows']['private.completion_reservations']=='2:e98f11700476723b5eaf69eb42b3271a','ISOLATION_SOURCE_DIGEST_REQUIRED'
 before=clone_snapshot();assert before['rows']==source['rows'],'ISOLATION_BASELINE_EXACT'
 rows=isolation_rows();appointments=isolation_appointments(rows);ids=validate_isolation_rows(rows,appointments)
 intent={'schema':'completion-isolation-v2','cloneId':inspect(name)['Id'],'sourceDigest':source['rows']['private.completion_reservations'],'rows':rows,'appointments':appointments,'before':before}
 save('completion-isolation-intent-private.json',intent)
 b.sql(isolation_sql(rows,appointments))
 after=clone_snapshot();compare_isolation_snapshots(before,after)
 assert isolation_appointments(rows)==appointments,'ISOLATION_LINKED_APPOINTMENTS_CHANGED'
 assert h.source_full_snapshot()==source,'ISOLATION_SOURCE_UNCHANGED'
 save('completion-isolation-proof.json',{'status':'ISOLATED_EXACT_TWO_CLONE_ONLY','cloneId':intent['cloneId'],'intentSha256':hashlib.sha256(private_read('completion-isolation-intent-private.json')).hexdigest(),'deletedCount':2,'sourceUnchanged':True,'originalAppointmentsUnchanged':True,'onlyReservationRowsChanged':True})

def verify_isolation_originals():
 intent=load('completion-isolation-intent-private.json');proof=load('completion-isolation-proof.json')
 assert intent['schema']=='completion-isolation-v2'and proof['status']=='ISOLATED_EXACT_TWO_CLONE_ONLY'and proof['cloneId']==inspect(name)['Id']==intent['cloneId']and proof['intentSha256']==hashlib.sha256(private_read('completion-isolation-intent-private.json')).hexdigest()and proof['deletedCount']==2 and proof['sourceUnchanged']and proof['originalAppointmentsUnchanged']and proof['onlyReservationRowsChanged'],'ISOLATION_PROOF_REQUIRED'
 validate_isolation_rows(intent['rows'],intent['appointments'])
 assert isolation_appointments(intent['rows'])==intent['appointments'],'ISOLATION_LINKED_APPOINTMENTS_CHANGED'

if action=='prepare':
 assert not root.exists(),'FRESH_ROOT_REQUIRED'
 memory=available();assert memory>=786432,'PREPARE_MEMORY_768_REQUIRED_NO_EFFECT'
 for certificate in('ca.crt','ca.key','wrong-ca.crt'):private_at(b.TLS,certificate)
 baseline=prior();assert all(v['metadata']['name']not in('/'+name,'/'+name+'-rest')for v in baseline.values()),'NAMESPACE_COLLISION_NO_CREATE'
 assert b.NETWORK not in raw(docker+['network','ls','--format','{{.Name}}']).decode().splitlines(),'NETWORK_COLLISION_NO_CREATE'
 source=h.source_full_snapshot();hashes={n:sha(repo/n)for n in files}
 try:
  output=io.StringIO()
  with contextlib.redirect_stdout(output):b.prepare()
  assert output.getvalue()=='INVOCATION_HTTP_CLONE_PREPARED_NOT_ACTIVATED\n','BASE_PREPARE_STDOUT_CONTRACT'
  private_dir(root);isolate_inherited_reservations()
  assert b.sql('select count(*)from private.completion_reservations;').decode().strip()=='0','INHERITED_RESERVATIONS_REFUSED'
  assert h.source_full_snapshot()==source,'SOURCE_CHANGED_DURING_PREPARE'
  password=secrets.token_hex(32)
  b.sql("begin;create role "+role+" login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 3 password '"+password+"';grant yumidang_completion_runner to "+role+" with admin false,inherit true,set true;grant connect on database postgres to "+role+";commit;")
  hba='local all all trust\nhostssl postgres '+role+','+b.LOGIN+','+b.REST_LOGIN+' 0.0.0.0/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n'
  b.docker('exec','-i',b.NAME,'sh','-c','cat > /tmp/invocation-data/pg_hba.conf',data=hba.encode());b.sql('select pg_reload_conf();')
  connection=load('connection-private.json');owned=metadata();assert len(owned)==2 and len(created)==2
  definitions=definition_hashes(b.SOURCE);assert definition_hashes(b.NAME)==definitions,'CURRENT_SQL_ABI_MISMATCH'
  data={'schema':'completion-fresh-v1','revision':revision,'source':b.SOURCE,'sourceId':b.identity(b.SOURCE)['Id'],'clone':b.NAME,'cloneId':b.identity(b.NAME)['Id'],'database':'postgres','dbPort':connection['dbPort'],'login':role,'password':password,'ca':str(root/'ca.crt'),'caSha256':hashlib.sha256(private_read('ca.crt')).hexdigest(),'wrongCa':str(root/'wrong-ca.crt'),'owned':owned,'files':hashes,'functionDefinitions':definitions,'prepareAvailableKiB':memory,'minimumKiB':786432,'fixtureStarted':False,'stockRunnerSha256':runner}
  save('completion-prepared-private.json',data);print(json.dumps({'status':'PREPARED_NOT_RUN','ownContainers':2,'availableKiB':memory,'fixtureStarted':False}))
 except Exception:
  errors=[]
  try:
   if created:
    if inspect(created[0]['id'])['State']['Running']:
     exists=b.sql("select exists(select 1 from pg_roles where rolname='"+role+"');").decode().strip()=='t'
     if exists:b.sql('alter role '+role+' nologin;revoke connect on database postgres from '+role+';')
  except Exception:errors.append('ROLE_CLOSE_NOT_PROVEN')
  stopped=stop_created(created,set(baseline),errors)
  try:assert h.source_full_snapshot()==source
  except Exception:errors.append('SOURCE_CHANGED')
  try:assert all(prior().get(k)==v for k,v in baseline.items())
  except Exception:errors.append('PRIOR_CHANGED')
  if root.exists():save('completion-prepare-failed-closed.json',{'status':'FAIL_PRESERVED','ownStopped':stopped,'errors':errors,'fixtureStarted':False})
  raise
elif action=='readiness':
 private_dir(root);data=load('completion-prepared-private.json');baseline=load('completion-prior-private.json')
 assert data['schema']=='completion-fresh-v1'and data['revision']==revision and data['clone']==name and data['database']=='postgres'
 assert b.identity(b.NAME)['Id']==data['cloneId']and b.identity(b.SOURCE)['Id']==data['sourceId'],'EXACT_IDS_REQUIRED'
 own=records();assert len(own)==2 and{v['id']for v in own}=={v['id']for v in data['owned']}
 for v in own:assert_created(v,set(baseline))
 assert metadata()==data['owned'],'CANONICAL_OWNED_REQUIRED'
 assert all(sha(repo/n)==v for n,v in data['files'].items()),'FROZEN_SOURCE_GRAPH_REQUIRED'
 assert h.source_full_snapshot()==load('completion-source-before-private.json'),'FULL_SOURCE_CHANGED'
 actual=prior();assert all(actual.get(k)==v for k,v in baseline.items()),'PRIOR_CHANGED'
 b.closed(b.NAME)
 assert not(root/'completion-fixture-started.json').exists()and not(root/'completion-run-started.json').exists(),'FIRST_RUN_ONLY'
 verify_isolation_originals()
 memory=available();assert memory>=786432,'RUN_MEMORY_768_REQUIRED'
 assert b.sql('select count(*)from private.completion_reservations;').decode().strip()=='0'
 assert definition_hashes(b.NAME)==data['functionDefinitions'],'CURRENT_CLONE_SQL_ABI_REQUIRED'
 assert hashlib.sha256(private_read('ca.crt')).hexdigest()==data['caSha256'];private_read('wrong-ca.crt')
 print(json.dumps({'status':'READINESS_PASS','availableKiB':memory,'ownContainers':2,'sourceUnchanged':True}))
else:
 # 불일치는 기록한다. 생성 ID 증거가 유효한 자기 환경의 STOP을 막지 않는다.
 private_dir(root);own=records();errors=[];stopped=[];data=None;baseline={}
 try:data=load('completion-prepared-private.json');baseline=load('completion-prior-private.json')
 except Exception:errors.append('PRIVATE_MANIFEST_OR_PRIOR_NOT_PROVEN')
 try:
  assert data and metadata()==data['owned'],'CONFIG_DRIFT'
  assert all(sha(repo/n)==v for n,v in data['files'].items()),'GRAPH_DRIFT'
  assert h.source_full_snapshot()==load('completion-source-before-private.json'),'SOURCE_DRIFT'
  verify_isolation_originals()
  actual=prior();assert all(actual.get(k)==v for k,v in baseline.items()),'PRIOR_DRIFT'
 except Exception:errors.append('FINAL_INVARIANT_CHANGED')
 try:
  db=next(v for v in own if v['name']==name);assert_created(db,set(baseline));v=inspect(db['id'])
  assert v['Id']==db['id']and v['Name']=='/'+name and(v['Config'].get('Labels')or{}).get('yumidang.completion.recipe')==recipe
  if v['State']['Running']:
   assert data and data['login']==role,'ROLE_SCOPE_REQUIRED'
   b.sql('revoke connect on database postgres from '+role+';alter role '+role+' nologin;')
   b.sql("select pg_terminate_backend(pid)from pg_stat_activity where usename='"+role+"'and datname='postgres'and pid<>pg_backend_pid();")
   assert b.sql("select count(*)from pg_stat_activity where usename='"+role+"';").decode().strip()=='0','OWN_SESSION_REMAINED'
   b.closed(b.NAME)
 except Exception:errors.append('ROLE_OR_SESSION_CLOSE_NOT_PROVEN')
 finally:stopped=stop_created(own,set(baseline),errors)
 try:assert data and h.source_full_snapshot()==load('completion-source-before-private.json')
 except Exception:errors.append('FINAL_SOURCE_UNCHANGED_NOT_PROVEN')
 try:
  actual=prior();assert all(actual.get(k)==v for k,v in baseline.items())and baseline
 except Exception:errors.append('FINAL_PRIOR_UNCHANGED_NOT_PROVEN')
 status='CLOSED_OWN2_STOP_SOURCE_PROTECTED'if not errors and len(stopped)==2 else'FAIL_PRESERVED_OWN_STOP_ATTEMPTED'
 result={'status':status,'ownStopped':stopped,'errors':errors,'sourceFullUnchanged':not any('SOURCE'in e or e=='FINAL_INVARIANT_CHANGED'for e in errors),'productSqlUnchanged':'FINAL_INVARIANT_CHANGED'not in errors,'priorUnchanged':not any('PRIOR'in e or e=='FINAL_INVARIANT_CHANGED'for e in errors),'canonicalBaselineExact':'FINAL_INVARIANT_CHANGED'not in errors,'oom':False if len(stopped)==2 else None}
 save('completion-final-stopped.json',result);print(json.dumps(result));sys.exit(0 if status=='CLOSED_OWN2_STOP_SOURCE_PROTECTED'else 1)

`;
  const control=stage=>{
    const result=spawnSync('python3',['-B','-c',helper,repo,revision,stage],{encoding:'utf8',timeout:240000,maxBuffer:1024*1024});
    if(result.status!==0){
      let diagnostic;try{diagnostic=validateFreshControlDiagnostic(JSON.parse(result.stdout.trim()));}catch{diagnostic={status:'FAIL_FIXED_CONTROL_DIAGNOSTIC',token:'UNCLASSIFIED_CONTROL_FAILURE',frames:[],sqlstate:null,stderrSha256:null};}
      if(lstatSync(root,{throwIfNoEntry:false})){createFreshPrivate(root,'completion-'+stage+'-diagnostic.json',JSON.stringify(diagnostic));}
      const error=Error('FRESH_COMPLETION_CONTROL_'+stage.toUpperCase()+'_FAILED');error.safeDiagnostic=diagnostic;throw error;
    }
    return JSON.parse(result.stdout.trim());
  };
  if(action==='prepare'||action==='finalize'){console.log(JSON.stringify(control(action)));return;}
  const ready=control('readiness');
  const m=validateFreshCompletionManifest(JSON.parse(readFreshPrivate(root,'completion-prepared-private.json')),revision,root);
  check(m.schema==='completion-fresh-v1'&&m.revision===revision&&m.stockRunnerSha256==='b07007db2f44c0673efdc7af74bba92df531df191b23ac482d2cfb32b3569484','MANIFEST_BINDING_REQUIRED');
  const digest=value=>createHash('sha256').update(value).digest('hex');
  check(digest(readFreshPrivate(root,'ca.crt'))===m.caSha256,'CA_BINDING_REQUIRED');
  createFreshPrivate(root,'completion-run-started.json',JSON.stringify({stage:'FIRST_RUN_BEFORE_TLS',readiness:ready,manifestSha256:digest(readFreshPrivate(root,'completion-prepared-private.json')),fixtureStarted:false}));
  const {Client}=createRequire(repo+'/backend/package.json')('pg');
  const host='unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock';
  const sql=query=>{const r=spawnSync('docker',['--host',host,'exec','-i',m.cloneId,'psql','-XqAt','-U','yumidang_production_recovery_bootstrap','-d','postgres','-v','ON_ERROR_STOP=1'],{input:query,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});check(r.status===0,'FRESH_FIXTURE_SQL_FAILED');return r.stdout.trim();};
  const rows=query=>JSON.parse(sql(`select coalesce(json_agg(q),'[]')from(${query})q;`));
  const connection={host:'127.0.0.1',port:m.dbPort,database:'postgres',user:m.login,password:m.password,ssl:{ca:readFreshPrivate(root,'ca.crt').toString('utf8'),rejectUnauthorized:true},connectionTimeoutMillis:5000,query_timeout:5000};
  const connect=async options=>{const c=new Client(options);c.on('error',()=>{});try{await c.connect();return c;}catch(error){await c.end().catch(()=>{});throw error;}};
  let worker,child,gate,competitionProof,competitionCleanStops=0;const children=[];let stage='tls_negative',failure,groups=0,minimalRoleStep=null,negativeControl=null,negativeSqlstate=null,diagnostic=null;
  const save=(name,value)=>createFreshPrivate(root,name,JSON.stringify(value));
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(fn,label,limit=18000)=>{const end=performance.now()+limit;while(performance.now()<end){if(await fn())return;await sleep(100);}throw Error(label);};
  const sessions=()=>rows(`select a.pid,s.ssl,s.version,s.cipher,s.bits from pg_stat_activity a join pg_stat_ssl s using(pid)where a.usename='${m.login}'and a.application_name='yumidang-completion-scheduler'`);
  function launch(ca=m.ca){
    const env={PATH:process.env.PATH,NODE_EXTRA_CA_CERTS:ca,COMPLETION_REQUIRE_TLS:'true',COMPLETION_DATABASE_URL:`postgresql://${m.login}:${m.password}@127.0.0.1:${m.dbPort}/postgres`,COMPLETION_RECONNECT_MS:'5000',COMPLETION_QUERY_TIMEOUT_MS:'10000'};
    const proc=spawn(process.execPath,[repo+'/backend/supabase/functions/scheduled-jobs/completion-runner.mjs'],{env,stdio:['ignore','pipe','pipe']});
    const r={proc,ready:0,unavailable:0,unexpected:false,exited:false,code:null,signal:null};
    r.done=new Promise(resolve=>{proc.once('error',()=>{Object.assign(r,{exited:true,unexpected:true});resolve();});proc.once('exit',(code,signal)=>{Object.assign(r,{exited:true,code,signal});resolve();});});let pending='';
    proc.stdout.on('data',()=>r.unexpected=true);proc.stderr.on('data',data=>{pending+=data.toString();const lines=pending.split('\n');pending=lines.pop();for(const line of lines){if(line==='COMPLETION_SCHEDULER_READY')r.ready++;else if(line==='COMPLETION_CONNECTION_UNAVAILABLE')r.unavailable++;else r.unexpected=true;}});
    children.push(r);child=r;return r;
  }
  const stop=async r=>{if(!r)return;if(!r.exited)r.proc.kill('SIGTERM');let timer;const clean=await Promise.race([r.done.then(()=>true),new Promise(resolve=>timer=setTimeout(()=>resolve(false),7000))]);clearTimeout(timer);if(!clean){r.proc.kill('SIGKILL');await r.done;}check(clean&&r.code===0&&!r.signal&&!r.unexpected,'STOCK_CLI_CLEAN_STOP_REQUIRED');};
  const id=n=>'adcafeed-0000-4000-8000-'+String(7000+n).padStart(12,'0');const users=[id(1),id(2)],posts=Array.from({length:7},(_,i)=>id(100+i)),requests=Array.from({length:7},(_,i)=>id(200+i)),appointments=Array.from({length:7},(_,i)=>id(300+i));
  function fixture(i,dueMs){
    sql(`begin;insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,cost_type,amount,status)select '${posts[i]}','${users[0]}','합성 완료 실행기','전용 현재 CLI 검증','산책',clock_timestamp()+interval '${dueMs} milliseconds'-interval '25 hours',clock_timestamp()+interval '${dueMs} milliseconds'-interval '24 hours',clock_timestamp()+interval '${dueMs} milliseconds'-interval '26 hours','서울특별시 강남구 역삼동','free',0,'closed';insert into public.join_requests(id,post_id,requester_id,message,status)values('${requests[i]}','${posts[i]}','${users[1]}','합성 신청','matched');insert into public.appointments(id,post_id,join_request_id,status)values('${appointments[i]}','${posts[i]}','${requests[i]}','confirmed');commit;`);
    const reservation=rows(`select generation,due_at, due_at=(select ends_at+interval '24 hours'from public.posts where id='${posts[i]}')as exact_24h from private.completion_reservations where appointment_id='${appointments[i]}'`)[0];check(reservation?.exact_24h,'PRODUCER_24H_REQUIRED');return reservation;
  }
  const state=i=>rows(`select a.status,a.completed_at,a.completion_method,a.review_deadline_at=a.completed_at+interval '7 days'as deadline,exists(select 1 from private.completion_reservations where appointment_id=a.id)as reserved,(select count(*)from public.notifications n where n.kind='appointment_completed'and n.join_request_id=a.join_request_id)as notices,(select count(*)from public.appointment_completion_confirmations where appointment_id=a.id)as confirmations from public.appointments a where a.id='${appointments[i]}'`)[0];
  const automatic=async i=>{await until(()=>state(i)?.status==='completed','AUTOMATIC_COMPLETION_MISSING');const v=state(i);check(v.completion_method==='automatic'&&v.deadline&&!v.reserved&&Number(v.notices)===2&&Number(v.confirmations)===0,'AUTOMATIC_EFFECT_PROOF_REQUIRED');};
  const confirm=(i,user)=>sql(`begin;select set_config('request.jwt.claims','{"sub":"${user}","role":"authenticated"}',true);set local role authenticated;select public.confirm_appointment_completion('${appointments[i]}');commit;`);
  // 별도 경쟁 action은 기존 PASS8을 반복하거나 그 범위를 영수증에 합산하지 않는다.
  const competitionSessions=()=>rows(`select a.pid,a.backend_start::text as "backendStart",a.datname as database,a.usename as role,a.application_name as application,s.ssl,s.version,s.cipher,s.bits from pg_stat_activity a join pg_stat_ssl s using(pid)where a.datname='postgres'and a.usename='${m.login}'and a.application_name='yumidang-completion-scheduler'`);
  const gateSessions=()=>rows(`select pid,backend_start::text as "backendStart",datname as database,usename as role,application_name as application from pg_stat_activity where datname='postgres'and usename='yumidang_production_recovery_bootstrap'and application_name='yumidang-completion-competition-gate'`);
  const beginGate=async()=>{
    check(gateSessions().length===0,'COMPETITION_GATE_NAMESPACE_ABSENT_REQUIRED');
    const proc=spawn('docker',['--host',host,'exec','-i',m.cloneId,'psql','-XqAt','-U','yumidang_production_recovery_bootstrap','-d','postgres','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});
    const g={proc,identity:null,locked:false,unexpected:false,exited:false,code:null,started:performance.now(),rollbackSent:false};gate=g;
    g.done=new Promise(resolve=>{proc.once('error',()=>{g.exited=true;g.unexpected=true;resolve();});proc.once('exit',code=>{g.exited=true;g.code=code;resolve();});});let pending='';
    proc.stdin.on('error',()=>{g.unexpected=true;});proc.stderr.on('data',()=>{g.unexpected=true;});
    proc.stdout.on('data',data=>{pending+=data.toString();if(pending.length>4096){g.unexpected=true;pending='';return;}const lines=pending.split('\n');pending=lines.pop();for(const line of lines){if(line==='COMPETITION_GATE_LOCKED')g.locked=true;else if(line.startsWith('COMPETITION_GATE_IDENTITY:')&&!g.identity){try{g.identity=validateFreshCompetitionGate(JSON.parse(line.slice('COMPETITION_GATE_IDENTITY:'.length)));}catch{g.unexpected=true;}}else g.unexpected=true;}});
    proc.stdin.write(`set application_name='yumidang-completion-competition-gate';set statement_timeout='4000ms';begin;set local idle_in_transaction_session_timeout='7000ms';select 'COMPETITION_GATE_IDENTITY:'||json_build_object('pid',pg_backend_pid(),'backendStart',(select backend_start::text from pg_stat_activity where pid=pg_backend_pid()),'database',current_database(),'role',current_user,'application',current_setting('application_name'))::text;select 'COMPETITION_GATE_LOCKED'from public.appointments where id='${appointments[0]}'for update;\n`);
    await until(()=>{check(!g.unexpected&&!g.exited,'COMPETITION_GATE_ACQUIRE_FAILED');return g.identity&&g.locked;},'COMPETITION_GATE_ACQUIRE_TIMEOUT',2000);return g;
  };
  const endGate=async()=>{
    const g=gate;if(!g)return;let problem;
    try{
      if(!g.rollbackSent&&!g.exited){g.rollbackSent=true;g.proc.stdin.end('rollback;\n');}
      let timer;const ended=await Promise.race([g.done.then(()=>true),new Promise(resolve=>timer=setTimeout(()=>resolve(false),1500))]);clearTimeout(timer);
      if(!ended&&g.identity){
        const identity=validateFreshCompetitionGate(g.identity),stamp=Buffer.from(identity.backendStart).toString('hex');
        // 실패 시에도 새 clone의 원 gate PID·backend_start·role·app·DB가 모두 같은 경우만 종료한다.
        g.forcedTerminate=true;
        const result=rows(`select pg_terminate_backend(pid)as terminated from pg_stat_activity where pid=${identity.pid}and backend_start=convert_from(decode('${stamp}','hex'),'UTF8')::timestamptz and datname='postgres'and usename='yumidang_production_recovery_bootstrap'and application_name='yumidang-completion-competition-gate'`);
        check(result.length<=1&&result.every(v=>v.terminated===true),'COMPETITION_GATE_EXACT_TERMINATE_FAILED');
      }
    }catch(error){problem=error;}
    finally{
      if(!g.exited){let timer;const ended=await Promise.race([g.done.then(()=>true),new Promise(resolve=>timer=setTimeout(()=>resolve(false),8000))]);clearTimeout(timer);if(!ended){g.proc.kill('SIGKILL');await g.done;problem??=Error('COMPETITION_GATE_PROCESS_END_FAILED');}}
      gate=undefined;
    }
    check(gateSessions().length===0,'COMPETITION_GATE_SESSION_REMAINED');
    if(problem)throw problem;
    check(!g.forcedTerminate&&g.code===0&&!g.unexpected,'COMPETITION_GATE_ROLLBACK_NOT_CLEAN');
  };
  try{
    for(const [ssl,codes]of [[{ca:readFreshPrivate(root,'wrong-ca.crt').toString('utf8'),rejectUnauthorized:true},['SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY']],[{ca:readFreshPrivate(root,'ca.crt').toString('utf8'),rejectUnauthorized:true,servername:'completion-invalid.invalid'},['ERR_TLS_CERT_ALTNAME_INVALID']]]){
      let c,code;try{c=await connect({...connection,ssl});}catch(error){code=error.code;}finally{await c?.end();}check(codes.includes(code),'TLS_SPECIFIC_NEGATIVE_CA_OR_HOST_REQUIRED');
    }
    worker=await connect(connection);stage='minimal_role';
    minimalRoleStep='flags';const attrs=rows(`select rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname='${m.login}'`)[0];check(attrs.rolcanlogin&&attrs.rolinherit&&!attrs.rolsuper&&!attrs.rolcreatedb&&!attrs.rolcreaterole&&!attrs.rolreplication&&!attrs.rolbypassrls,'EXACT_LOGIN_FLAGS_REQUIRED');
    minimalRoleStep='membership';const membership=rows(`select p.rolname,x.admin_option,x.inherit_option,x.set_option from pg_auth_members x join pg_roles p on p.oid=x.roleid join pg_roles c on c.oid=x.member where c.rolname='${m.login}'`);check(membership.length===1&&membership[0].rolname==='yumidang_completion_runner'&&!membership[0].admin_option&&membership[0].inherit_option&&membership[0].set_option,'EXACT_SINGLE_GROUP_REQUIRED');
    minimalRoleStep='identity';const identity=(await worker.query('select current_user as u,session_user as s,(select ssl from pg_stat_ssl where pid=pg_backend_pid())as ssl')).rows[0];check(identity.u===m.login&&identity.s===m.login&&identity.ssl===true,'EXACT_TLS_LOGIN_REQUIRED');
    minimalRoleStep='two_rpc';const perms=rows(`select has_schema_privilege('${m.login}','public','CREATE')as creates,has_schema_privilege('${m.login}','private','USAGE')as private_usage,(select count(*)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private','auth','storage','cron','realtime','supabase_migrations','supabase_functions','vault')and has_schema_privilege('${m.login}',n.oid,'USAGE')and has_function_privilege('${m.login}',p.oid,'EXECUTE'))as functions,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage','cron','realtime','supabase_migrations','supabase_functions','vault')and has_schema_privilege('${m.login}',n.oid,'USAGE')and c.relkind in('r','p','v','m','f')and(has_table_privilege('${m.login}',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')or has_any_column_privilege('${m.login}',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))as tables`)[0];check(!perms.creates&&!perms.private_usage&&Number(perms.functions)===2&&!perms.tables,'EXACT_TWO_RPC_MINIMAL_ROLE_REQUIRED');
    minimalRoleStep='effective_acl';const effective=rows(`select exists(select 1 from pg_namespace n where n.nspname!~'^pg_(temp|toast_temp)_'and has_schema_privilege('${m.login}',n.oid,'CREATE'))as schema_create,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema'and c.relkind='S'and has_schema_privilege('${m.login}',n.oid,'USAGE')and case when c.relkind='S'then has_sequence_privilege('${m.login}',c.oid,'USAGE,SELECT,UPDATE')else false end)as sequences,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema'and c.relkind in('r','p','v','m','f')and has_schema_privilege('${m.login}',n.oid,'USAGE')and(has_table_privilege('${m.login}',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')or has_any_column_privilege('${m.login}',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))as table_columns,exists(select 1 from pg_roles r where r.rolname not in('${m.login}','yumidang_completion_runner')and pg_has_role('${m.login}',r.oid,'MEMBER'))as inherited_other_role`)[0];check(!effective.schema_create&&!effective.sequences&&!effective.table_columns&&!effective.inherited_other_role,'EFFECTIVE_SCHEMA_SEQUENCE_COLUMN_ROLE_PROMOTION_REQUIRED');
    minimalRoleStep='negative_control';for(const [label,q]of [['public_profiles','select * from public.profiles'],['completion_reservations','select * from private.completion_reservations'],['legacy_due_rpc','select public.process_due_completions(1)'],['service_role','set role service_role'],['supabase_admin','set role supabase_admin'],['bootstrap_role','set role yumidang_production_recovery_bootstrap']]){negativeControl=label;negativeSqlstate=null;let denied=false;try{await worker.query(q);}catch(e){denied=e.code==='42501';negativeSqlstate=e.code;}check(denied,'ACTUAL_ROLE_DENIAL_REQUIRED');}groups++;
    if(action!=='competition'){
    stage='stock_cli_wrong_ca';const rejected=launch(m.wrongCa);await until(()=>rejected.unavailable>=1,'STOCK_CLI_BAD_CA_MUST_FAIL');check(rejected.ready===0&&!rejected.unexpected&&sessions().length===0,'STOCK_CLI_BAD_CA_READY_OR_SESSION');await stop(rejected);const stillTls=(await worker.query('select current_user as u,(select ssl from pg_stat_ssl where pid=pg_backend_pid())as ssl')).rows[0];check(stillTls.u===m.login&&stillTls.ssl===true,'SAME_ENDPOINT_POSITIVE_AFTER_BAD_CA_REQUIRED');save('completion-tls-negative.json',{genericPgWrongCaTlsSpecific:true,genericPgWrongHostnameTlsSpecific:true,actualStockCliWrongCaRejected:true,actualStockCliWrongHostname:'NOT_RUN',sameEndpointPositive:true});
    }
    stage='fixture_absence';const all=[...users,...posts,...requests,...appointments];check(rows(`select exists(select 1 from(select id from auth.users union all select id from public.profiles union all select id from public.posts union all select id from public.join_requests union all select id from public.appointments)v where id=any(array[${all.map(id=>`'${id}'`).join(',')}]::uuid[]))as present`)[0].present===false,'FIXTURE_NAMESPACE_MUST_BE_ABSENT');
    save('completion-fixture-started.json',{stage:'FIRST_FIXTURE',plannedIds:all,fixtureReplays:0,ready});sql(`begin;insert into auth.users(id,email)values('${users[0]}','completion-author@fixture.invalid'),('${users[1]}','completion-target@fixture.invalid');insert into public.profiles(id,real_name,birth_date,gender)values('${users[0]}','합성작성자','1990-01-01','female'),('${users[1]}','합성신청자','1990-01-01','female');commit;`);
    if(action==='competition'){
      stage='competition_two_healthy_stock_listeners';const first=launch(),second=launch();
      await until(()=>first.ready===1&&second.ready===1&&competitionSessions().length===2,'COMPETITION_TWO_READY_REQUIRED');
      const identities=validateFreshCompetitionWorkers(competitionSessions(),m.login);
      const healthy=()=>{check([first,second].every(v=>v.ready===1&&v.unavailable===0&&!v.exited&&!v.unexpected),'COMPETITION_HEALTHY_WORKERS_REQUIRED');};healthy();
      check(rows('select count(*)as n from private.completion_reservations')[0].n===0,'COMPETITION_ONLY_ONE_PRODUCED_RESERVATION_REQUIRED');
      stage='competition_same_due_generation';const original=fixture(0,3000);
      check(state(0).status==='confirmed'&&state(0).completed_at===null&&Number(state(0).notices)===0,'COMPETITION_NO_EARLY_EFFECT_REQUIRED');
      const reservation=()=>rows('select appointment_id,generation,due_at::text as due from private.completion_reservations');
      const originalRows=reservation();check(originalRows.length===1&&originalRows[0].appointment_id===appointments[0]&&originalRows[0].generation===original.generation,'COMPETITION_ONE_ORIGINAL_GENERATION_REQUIRED');
      const currentGate=await beginGate();const deadline=currentGate.started+6000;let observed;
      try{
        stage='competition_both_exact_execute_waiters';
        await until(()=>{
          healthy();validateFreshCompetitionGateTime(currentGate.started,performance.now());
          check(!currentGate.exited&&!currentGate.unexpected,'COMPETITION_GATE_EXPIRED_BEFORE_RELEASE');
          const current=validateFreshCompetitionWorkers(competitionSessions(),m.login);check(JSON.stringify(current)===JSON.stringify(identities),'COMPETITION_WORKER_IDENTITIES_CHANGED');
          check(JSON.stringify(reservation())===JSON.stringify(originalRows),'COMPETITION_GENERATION_CHANGED_BEFORE_RELEASE');
          const waiters=rows(`select pid,backend_start::text as "backendStart",state,wait_event_type as "waitEventType",query='select public.execute_completion_reservation($1::uuid,$2::uuid) as result'as "executeExact",pg_blocking_pids(pid)as blockers from pg_stat_activity where pid in(${identities.map(v=>v.pid).join(',')})order by pid`);
          if(waiters.some(v=>v.state!=='active'||v.waitEventType!=='Lock'))return false;
          observed=validateFreshCompetitionWaiters(waiters,identities,currentGate.identity);return true;
        },'COMPETITION_TWO_EXECUTORS_NOT_OBSERVED',Math.max(1,deadline-performance.now()));
        validateFreshCompetitionGateTime(currentGate.started,performance.now());
        check(!currentGate.exited&&!currentGate.unexpected,'COMPETITION_GATE_EXPIRED_BEFORE_RELEASE');
      }finally{await endGate();}
      stage='competition_one_effect';await automatic(0);healthy();const completed=state(0);await sleep(1000);healthy();
      check(JSON.stringify(state(0))===JSON.stringify(completed)&&reservation().length===0,'COMPETITION_DUPLICATE_EFFECT_OR_RESERVATION');
      check(JSON.stringify(validateFreshCompetitionWorkers(competitionSessions(),m.login))===JSON.stringify(identities),'COMPETITION_WORKER_IDENTITIES_CHANGED');
      competitionProof={workers:identities,gateIdentity:currentGate.identity,waiters:observed,originalGeneration:original.generation,originalDueAt:original.due_at,appointmentId:appointments[0],sameGenerationBeforeRelease:true,gateRollback:true,gateLifetimeLimitMs:6000,stockQueryTimeoutMs:10000,automaticEffects:1,notices:2,reservationRemoved:true,duplicateEffects:0};
      stage='competition_clean_sigterm';await stop(first);await stop(second);await until(()=>sessions().length===0,'COMPETITION_NO_LISTENERS_AFTER_STOP');competitionCleanStops=2;
      save('completion-competition-proof.json',{status:'PASS_SINGLE_GENERATION_COMPETITION',...competitionProof,cleanSigtermCount:2});groups=1;
    }else{
    stage='missed_notification_startup';check(sessions().length===0,'NO_LISTENER_BEFORE_COMMIT_REQUIRED');fixture(0,-1000);const first=launch();await until(()=>first.ready===1,'STOCK_READY_MISSING');await automatic(0);const tls=sessions();check(tls.length===1&&tls.every(r=>r.ssl&&['TLSv1.2','TLSv1.3'].includes(r.version)&&r.bits>=128&&r.cipher),'STOCK_CLI_ACTUAL_TLS_REQUIRED');save('completion-stock-tls.json',{sessions:tls,requireTls:true,startupCA:true,wrongCARejected:true,genericPgWrongHostnameRejected:true,actualStockCliWrongHostname:'NOT_RUN'});groups++;
    stage='notification_timer_24h';fixture(1,1600);check(state(1).status==='confirmed','NOT_DUE_EARLY_COMPLETION');await automatic(1);groups++;
    stage='bilateral_policy_control';fixture(2,60000);confirm(2,users[0]);check(state(2).status==='confirmed'&&Number(state(2).confirmations)===1,'ONE_PERSON_MUST_NOT_COMPLETE');confirm(2,users[1]);check(state(2).status==='completed'&&state(2).completion_method==='manual'&&Number(state(2).confirmations)===2&&!state(2).reserved,'BILATERAL_MANUAL_REQUIRED');groups++;
    stage='dispute_policy_control';fixture(3,1500);sql(`insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining)values('${appointments[3]}','${users[1]}','합성 분쟁 보류',interval '7 days');`);await sleep(2000);check(state(3).status==='confirmed'&&!state(3).reserved&&state(3).completed_at===null,'DISPUTE_MUST_NOT_AUTOCOMPLETE');groups++;
    stage='backend_disconnect_missed_commit';const old=sessions();check(old.length===1,'EXACT_OWN_SESSION_REQUIRED');check(rows(`select pg_terminate_backend(${Number(old[0].pid)})as terminated`)[0].terminated,'OWN_BACKEND_TERMINATE_REQUIRED');await until(()=>first.unavailable>=1&&sessions().length===0,'ACTUAL_DISCONNECT_REQUIRED');fixture(4,-1000);await until(()=>first.ready>=2&&sessions().length===1&&sessions()[0].pid!==old[0].pid,'RECONNECT_NEW_TLS_SESSION_REQUIRED');await automatic(4);groups++;
    stage='restart_durable_generation_cas';await stop(first);await until(()=>sessions().length===0,'STOPPED_NO_LISTENER_REQUIRED');const original=fixture(5,60000);sql(`update public.posts set ends_at=ends_at+interval '1 minute'where id='${posts[5]}';`);const current=rows(`select generation,due_at from private.completion_reservations where appointment_id='${appointments[5]}'`)[0];check(current.generation!==original.generation,'GENERATION_PRODUCER_MUST_CHANGE');const before=state(5);const stale=(await worker.query('select public.execute_completion_reservation($1::uuid,$2::uuid)as result',[appointments[5],original.generation])).rows[0].result;check(JSON.stringify(stale)==='{"status":"stale"}'&&JSON.stringify(state(5))===JSON.stringify(before),'STALE_GENERATION_NO_EFFECT_REQUIRED');sql(`update public.posts set ends_at=clock_timestamp()-interval '24 hours'-interval '1 second'where id='${posts[5]}';`);const due=rows(`select generation from private.completion_reservations where appointment_id='${appointments[5]}'`)[0];check(due.generation!==current.generation,'DUE_REVISION_GENERATION_REQUIRED');const restarted=launch();await until(()=>restarted.ready===1,'RESTART_READY_MISSING');await automatic(5);const done=state(5);const duplicate=(await worker.query('select public.execute_completion_reservation($1::uuid,$2::uuid)as result',[appointments[5],due.generation])).rows[0].result;check(JSON.stringify(duplicate)==='{"status":"stale"}'&&JSON.stringify(state(5))===JSON.stringify(done),'COMPLETED_CAS_NO_DUPLICATE_EFFECT_REQUIRED');groups++;
    stage='clean_stop';await stop(restarted);await until(()=>sessions().length===0,'NO_OWN_LISTENER_AFTER_STOP_REQUIRED');groups++;
    }
  }catch(error){failure=stage;if(stage==='minimal_role')diagnostic=freshMinimalRoleDiagnostic(error,minimalRoleStep,negativeControl,negativeSqlstate);}finally{
    try{await endGate();}catch{failure??='competition_gate_cleanup';}
    for(const r of children){try{await stop(r);}catch{failure??='stock_cli_cleanup';}}await worker?.end().catch(()=>{failure??='worker_cleanup';});
    // 실패 fixture와 원 예약은 보존한다. finalize는 비교 실패에도 생성 ID만 권한 닫힘·STOP을 시도한다.
    if(action==='competition')save('completion-receipt.json',{status:failure?'FAIL':'PASS',stage:failure??'complete',groups:failure?0:1,scope:'SINGLE_GENERATION_COMPETITION_ONLY',stockActualCli:children.filter(v=>v.ready>0).length===2,actualTls:Boolean(competitionProof),simultaneousExecuteWaiters:Boolean(competitionProof),cleanSigtermCount:competitionCleanStops,durableMissedNotification:'NOT_RUN',reconnect:'NOT_RUN',restartGenerationCas:'NOT_RUN',policyControls:'NOT_RUN',actualStockCliWrongHostname:'NOT_RUN',externalCalls:0,operatingDeployment:'NOT_RUN',sourceWrites:0,fixtureReplay:0,diagnostic});
    else save('completion-receipt.json',{status:failure?'FAIL':'PASS',stage:failure??'complete',groups,stockActualCli:children.length>0,actualTls:groups>=2,actualStockCliWrongCa:children.some(r=>r.ready===0&&r.unavailable>0),actualStockCliWrongHostname:'NOT_RUN',durableMissedNotification:groups>=2,reconnect:groups>=6,restartGenerationCas:groups>=7,policyControls:'BILATERAL_24H_DISPUTE',externalCalls:0,operatingDeployment:'NOT_RUN',sourceWrites:0,fixtureReplay:0,diagnostic});
  }
  console.log(JSON.stringify({status:failure?'FAIL':'PASS',stage:failure??'complete',groups:action==='competition'?(failure?0:1):groups}));if(failure)process.exitCode=1;
}

function validateFreshCompletionManifest(m,revision,root) {
  const fail=()=>{throw Error('EXACT_FRESH_MANIFEST_REQUIRED');};
  const exact=(v,keys)=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&JSON.stringify(Object.keys(v).sort())===JSON.stringify(keys.sort()));
  const hex=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
  const name='yumidang-minkyu-completion-current-'+revision;
  const files=['backend/supabase/functions/scheduled-jobs/completion-runner.mjs','backend/supabase/functions/_shared/jobs/completion-scheduler.mjs','backend/package.json','backend/package-lock.json','backend/supabase/migrations/20260929120000_review_release_and_completion_reservations.sql','backend/supabase/migrations/20261002110000_completion_review_policy.sql','backend/supabase/migrations/20261003090000_completion_runner_role.sql','tests/integration/minkyu/worker_safety_http_local.py','tests/integration/minkyu/worker_invocation_http_local.py','tests/integration/minkyu/member_retirement_auth_local.py','tools/local/remote_schema_catalog.sql','tests/integration/minkyu/completion_runner_current_local.mjs'];
  if(!exact(m,['schema','revision','source','sourceId','clone','cloneId','database','dbPort','login','password','ca','caSha256','wrongCa','owned','files','functionDefinitions','prepareAvailableKiB','minimumKiB','fixtureStarted','stockRunnerSha256'])||m.schema!=='completion-fresh-v1'||m.revision!==revision||m.source!=='yumidang-minkyu-invocation109-20261009-v1'||!hex(m.sourceId)||m.clone!==name||!hex(m.cloneId)||m.cloneId===m.sourceId||m.database!=='postgres'||!Number.isSafeInteger(m.dbPort)||m.dbPort<1||m.dbPort>65535||m.login!=='ym_completion_fresh_'+revision||!hex(m.password)||m.ca!==root+'/ca.crt'||m.wrongCa!==root+'/wrong-ca.crt'||!hex(m.caSha256)||!Number.isSafeInteger(m.prepareAvailableKiB)||m.prepareAvailableKiB<786432||m.minimumKiB!==786432||m.fixtureStarted!==false||m.stockRunnerSha256!=='b07007db2f44c0673efdc7af74bba92df531df191b23ac482d2cfb32b3569484')fail();
  if(!exact(m.files,files)||!Object.values(m.files).every(hex)||!exact(m.functionDefinitions,['list_completion_reservations()','execute_completion_reservation(uuid,uuid)'])||!Object.values(m.functionDefinitions).every(hex))fail();
  if(!Array.isArray(m.owned)||m.owned.length!==2||m.owned[0].id!==m.cloneId||m.owned[0].id===m.owned[1].id)fail();
  for(const [i,v]of m.owned.entries())if(!hex(v.id)||v.id===m.sourceId||v.name!=='/'+name+(i?'-rest':'')||v.memoryCap!==(i?128:512)*1024*1024||v.noHealthcheck!==true||!hex(v.configHash)||!hex(v.mountHash))fail();
  return m;
}

function validateFreshCompetitionGate(value){
 const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&JSON.stringify(Object.keys(v).sort())===JSON.stringify(keys.sort());
 if(!exact(value,['pid','backendStart','database','role','application'])||!Number.isSafeInteger(value.pid)||value.pid<1||typeof value.backendStart!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00$/.test(value.backendStart)||!Number.isFinite(Date.parse(value.backendStart))||value.database!=='postgres'||value.role!=='yumidang_production_recovery_bootstrap'||value.application!=='yumidang-completion-competition-gate')throw Error('COMPETITION_EXACT_GATE_IDENTITY_REQUIRED');
 return value;
}

function validateFreshCompetitionGateTime(started,now){
 if(!Number.isFinite(started)||!Number.isFinite(now)||started<0||now<started||now-started>=6000)throw Error('COMPETITION_GATE_DEADLINE_EXCEEDED');
 return true;
}

function validateFreshCompetitionWorkers(values,login){
 const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&JSON.stringify(Object.keys(v).sort())===JSON.stringify(keys.sort());
 if(typeof login!=='string'||!/^ym_completion_fresh_v[1-9][0-9]?$/.test(login)||!Array.isArray(values)||values.length!==2||new Set(values.map(v=>v?.pid)).size!==2)throw Error('COMPETITION_TWO_EXACT_TLS_WORKERS_REQUIRED');
 for(const v of values)if(!exact(v,['pid','backendStart','database','role','application','ssl','version','cipher','bits'])||!Number.isSafeInteger(v.pid)||v.pid<1||typeof v.backendStart!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00$/.test(v.backendStart)||!Number.isFinite(Date.parse(v.backendStart))||v.database!=='postgres'||v.role!==login||v.application!=='yumidang-completion-scheduler'||v.ssl!==true||!['TLSv1.2','TLSv1.3'].includes(v.version)||typeof v.cipher!=='string'||! /^[A-Z0-9_-]{1,128}$/.test(v.cipher)||!Number.isSafeInteger(v.bits)||v.bits<128)throw Error('COMPETITION_TWO_EXACT_TLS_WORKERS_REQUIRED');
 return [...values].sort((a,b)=>a.pid-b.pid);
}

function validateFreshCompetitionWaiters(values,workers,gate){
 validateFreshCompetitionGate(gate);validateFreshCompetitionWorkers(workers,workers[0]?.role);
 const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&JSON.stringify(Object.keys(v).sort())===JSON.stringify(keys.sort());
 const identities=new Map(workers.map(v=>[v.pid,v.backendStart])),allowed=new Set([gate.pid,...identities.keys()]);
 if(identities.has(gate.pid)||!Array.isArray(values)||values.length!==2||new Set(values.map(v=>v?.pid)).size!==2)throw Error('COMPETITION_EXACT_EXECUTE_LOCK_CHAIN_REQUIRED');
 for(const v of values)if(!exact(v,['pid','backendStart','state','waitEventType','executeExact','blockers'])||!identities.has(v.pid)||v.backendStart!==identities.get(v.pid)||v.state!=='active'||v.waitEventType!=='Lock'||v.executeExact!==true||!Array.isArray(v.blockers)||v.blockers.length<1||v.blockers.length>2||new Set(v.blockers).size!==v.blockers.length||v.blockers.some(p=>!allowed.has(p)||p===v.pid))throw Error('COMPETITION_EXACT_EXECUTE_LOCK_CHAIN_REQUIRED');
 const map=new Map(values.map(v=>[v.pid,v.blockers]));
 const reachesGate=(pid,path=new Set())=>{if(pid===gate.pid)return true;if(path.has(pid))return false;const next=new Set(path);next.add(pid);return map.get(pid)?.every(p=>reachesGate(p,next))===true;};
 if(!values.every(v=>reachesGate(v.pid)))throw Error('COMPETITION_EXACT_EXECUTE_LOCK_CHAIN_REQUIRED');
 return [...values].sort((a,b)=>a.pid-b.pid);
}

function freshMinimalRoleDiagnostic(error,minimalRoleStep,negativeControl,negativeSqlstate){
 const tokens=new Set(['EXACT_LOGIN_FLAGS_REQUIRED','EXACT_SINGLE_GROUP_REQUIRED','EXACT_TLS_LOGIN_REQUIRED','EXACT_TWO_RPC_MINIMAL_ROLE_REQUIRED','EFFECTIVE_SCHEMA_SEQUENCE_COLUMN_ROLE_PROMOTION_REQUIRED','ACTUAL_ROLE_DENIAL_REQUIRED','FRESH_FIXTURE_SQL_FAILED']);
 const states=new Set(['42501','22023','42601','42703','42P01','42883','42809','55000','40001','57014','28000','28P01']);
 const sqlstate=states.has(error?.code)?error.code:minimalRoleStep==='negative_control'&&states.has(negativeSqlstate)?negativeSqlstate:null;
 return validateFreshMinimalRoleDiagnostic({token:tokens.has(error?.message)?error.message:'UNCLASSIFIED_RUNTIME_FAILURE',sqlstate,minimalRoleStep,negativeControl:minimalRoleStep==='negative_control'?negativeControl:null});
}

function validateFreshMinimalRoleDiagnostic(value){
 const tokens=new Set(['EXACT_LOGIN_FLAGS_REQUIRED','EXACT_SINGLE_GROUP_REQUIRED','EXACT_TLS_LOGIN_REQUIRED','EXACT_TWO_RPC_MINIMAL_ROLE_REQUIRED','EFFECTIVE_SCHEMA_SEQUENCE_COLUMN_ROLE_PROMOTION_REQUIRED','ACTUAL_ROLE_DENIAL_REQUIRED','FRESH_FIXTURE_SQL_FAILED','UNCLASSIFIED_RUNTIME_FAILURE']);
 const states=new Set(['42501','22023','42601','42703','42P01','42883','42809','55000','40001','57014','28000','28P01']);
 const steps=new Set(['flags','membership','identity','two_rpc','effective_acl','negative_control']);
 const labels=new Set(['public_profiles','completion_reservations','legacy_due_rpc','service_role','supabase_admin','bootstrap_role']);
 const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&JSON.stringify(Object.keys(v).sort())===JSON.stringify(keys.sort());
 if(!exact(value,['token','sqlstate','minimalRoleStep','negativeControl'])||!tokens.has(value.token)||!steps.has(value.minimalRoleStep)||(value.sqlstate!==null&&!states.has(value.sqlstate))||(value.minimalRoleStep==='negative_control'?!labels.has(value.negativeControl):value.negativeControl!==null))throw Error('FIXED_MINIMAL_ROLE_DIAGNOSTIC_CONTRACT_REQUIRED');
 return value;
}

function validateFreshControlDiagnostic(value){
 const tokens=new Set(['INHERITED_RESERVATIONS_REFUSED','BASE_PREPARE_STDOUT_CONTRACT','ISOLATION_SOURCE_DIGEST_REQUIRED','ISOLATION_EXACT_ROWS_REQUIRED','ISOLATION_APPOINTMENTS_REQUIRED','ISOLATION_ONLY_RESERVATION_DIFF_ALLOWED','ISOLATION_BASELINE_EXACT','ISOLATION_DELETE_EXACT_TWO','ISOLATION_LINKED_APPOINTMENTS_CHANGED','ISOLATION_SOURCE_UNCHANGED','ISOLATION_PROOF_REQUIRED','FIXED_CONTROL_COMMAND_FAILED','FROZEN_HELPERS_REQUIRED_NO_EFFECT','PRIVATE_DIRECTORY_REQUIRED','PRIVATE_SINGLE_FILE_REQUIRED','PRIVATE_FILE_REPLACED','CURRENT_SQL_ABI_MISMATCH','CURRENT_STOCK_TLS_RUNNER_REQUIRED','SOURCE_CHANGED_DURING_PREPARE','PREPARE_MEMORY_768_REQUIRED_NO_EFFECT','NAMESPACE_COLLISION_NO_CREATE','NETWORK_COLLISION_NO_CREATE','UNCLASSIFIED_CONTROL_FAILURE']);
 const states=new Set(['42501','22023','42601','42703','42P01','42883','55000','40001','57014','28000','28P01']);
 const labels=new Set(['embedded_control','worker_safety_helper','worker_invocation_helper','source_snapshot_helper']);
 const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&JSON.stringify(Object.keys(v).sort())===JSON.stringify(keys.sort());
 if(!exact(value,['status','token','frames','sqlstate','stderrSha256'])||value.status!=='FAIL_FIXED_CONTROL_DIAGNOSTIC'||!tokens.has(value.token)||!Array.isArray(value.frames)||value.frames.length>8||value.frames.some(f=>!exact(f,['label','line'])||!labels.has(f.label)||!Number.isInteger(f.line)||f.line<1||f.line>10000)||(value.sqlstate!==null&&!states.has(value.sqlstate))||(value.stderrSha256!==null&&(typeof value.stderrSha256!=='string'||!/^[0-9a-f]{64}$/.test(value.stderrSha256))))throw Error('FIXED_DIAGNOSTIC_CONTRACT_REQUIRED');
 return value;
}

function freshPrivateDirectory(root){
 const v=lstatSync(root);if(!v.isDirectory()||v.isSymbolicLink()||v.uid!==process.getuid()||(v.mode&0o777)!==0o700||realpathSync(root)!==root)throw Error('PRIVATE_FRESH_DIRECTORY_REQUIRED');
}
function readFreshPrivate(root,name){
 freshPrivateDirectory(root);if(name.includes('/')||name==='.'||name==='..')throw Error('FIXED_PRIVATE_FILENAME_REQUIRED');
 const path=root+'/'+name,v=lstatSync(path);if(!v.isFile()||v.isSymbolicLink()||v.uid!==process.getuid()||(v.mode&0o777)!==0o600||v.nlink!==1||realpathSync(path)!==path)throw Error('PRIVATE_SINGLE_FILE_REQUIRED');
 const fd=openSync(path,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);
 try{const opened=fstatSync(fd);if(opened.dev!==v.dev||opened.ino!==v.ino||opened.nlink!==1||opened.uid!==process.getuid()||(opened.mode&0o777)!==0o600)throw Error('PRIVATE_FILE_REPLACED');return readFileSync(fd);}finally{closeSync(fd);}
}
function createFreshPrivate(root,name,value){
 freshPrivateDirectory(root);if(name.includes('/')||name==='.'||name==='..')throw Error('FIXED_PRIVATE_FILENAME_REQUIRED');
 const fd=openSync(root+'/'+name,fsConstants.O_WRONLY|fsConstants.O_CREAT|fsConstants.O_EXCL|fsConstants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}const directory=openSync(root,fsConstants.O_RDONLY|fsConstants.O_DIRECTORY);try{fsyncSync(directory);}finally{closeSync(directory);}const parent=openSync(resolve(root,'..'),fsConstants.O_RDONLY|fsConstants.O_DIRECTORY);try{fsyncSync(parent);}finally{closeSync(parent);}
}
