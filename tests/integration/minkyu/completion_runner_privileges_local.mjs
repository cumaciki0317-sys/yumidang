/** 민규: 제한된 합성 LOGIN으로 원형 상주 실행기의 실제 권한·복구를 검증한다.
 * 관리자 연결은 합성 fixture 준비·관측·정리에만 사용한다. worker 암호는 메모리에만 둔다.
 * 총괄이 준비한 39 SQL 로컬 DB와 잠금된 pg8.22 설치만 사용하며 finally에서 정리한다.
 * 운영 비밀 provisioning·원격·외부 네이버/AI·프로젝트 기동은 이 검사의 범위 밖이다.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNTIME = '/private/tmp/yumidang-completion-20261002-5s4httaj';
const CONTEXT = 'colima-yumidang-minkyu';
const PROJECT = 'yumidang-minkyu-gateway';
const CONTAINER = `supabase_db_${PROJECT}`;
const APP = 'yumidang-completion-scheduler';
const runnerPath = 'supabase/functions/scheduled-jobs/completion-runner.mjs';
const schedulerPath = 'supabase/functions/_shared/jobs/completion-scheduler.mjs';
const uid = n => `b6100300-0000-4000-8000-${String(n).padStart(12, '0')}`;
const people = [uid(1), uid(2)];
const posts = [uid(101), uid(102), uid(103), uid(104)];
const requests = [uid(201), uid(202), uid(203), uid(204)];
const appointments = [uid(301), uid(302), uid(303), uid(304)];
let stage = 'configuration', checks = 0, groups = 0, cleanupPassed = false;
const GROUP = 'yumidang_completion_runner';
const ROLE_PREFIX = 'ym_completion_local_';
const workerRole = ROLE_PREFIX + randomBytes(12).toString('hex');
const workerPassword = randomBytes(32).toString('hex');
let admin, worker, child, guarded = false, cliStarted = false, roleCreated = false;
let workerUrl, workerPermissions = false, workerSession = false, emptyTableCount = 0;
let failedCheck = null;
const requireSafe = (condition, label = 'fixed_guard') => { checks++; if (!condition) { failedCheck = label; throw new Error('LOCAL_COMPLETION_CHECK_FAILED'); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function regular(path) {
  const info = lstatSync(path);
  requireSafe(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 1024 * 1024);
  requireSafe(realpathSync(path) === resolve(path));
  return readFileSync(path);
}
function protectedDirectory(path) {
  const info = lstatSync(path);
  requireSafe(path.startsWith('/private/tmp/') && info.isDirectory() && !info.isSymbolicLink() &&
    info.uid === process.getuid() && (info.mode & 0o777) === 0o700 && realpathSync(path) === path);
}
function readConfig(filename) {
  requireSafe(typeof filename === 'string' && filename === resolve(filename));
  protectedDirectory(dirname(filename));
  const info = lstatSync(filename);
  requireSafe(info.uid === process.getuid() && (info.mode & 0o777) === 0o600 && info.size <= 24576);
  const value = JSON.parse(regular(filename).toString('utf8'));
  requireSafe(value && Object.keys(value).sort().join(',') === 'DATABASE_URL,EDGE_ROOT,RUNTIME_ROOT');
  requireSafe(Object.values(value).every(v => typeof v === 'string' && v.length > 0 && !/[\r\n\0]/.test(v)));
  const url = new URL(value.DATABASE_URL);
  requireSafe(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' &&
    url.port === '56522' && url.pathname === '/postgres' && url.username === 'postgres' && url.password && !url.search && !url.hash);
  requireSafe(value.RUNTIME_ROOT === RUNTIME);
  protectedDirectory(value.RUNTIME_ROOT);
  protectedDirectory(value.EDGE_ROOT);
  return value;
}
function sourceGuard(config) {
  // 새 하네스와 39개 원본/사본을 직접 검사한다. 이전 gateway guard를 가져오지 않는다.
  const code = String.raw`
import hashlib,json,re,sys,tomllib
from pathlib import Path
root,edge=Path(sys.argv[1]),Path(sys.argv[2])
sys.path[:0]=[str(root/'tools/collaboration'),str(root/'tools/local')]
import check_harness as h,check_ownership as o,prepare_edge as p
from prepare_migrations import inspect_migrations
def check(x):
 if not x: raise ValueError('snapshot_guard_failed')
def read(path,base):
 check(path.resolve()==path and path.is_file() and path.is_relative_to(base))
 for item in [path,*path.parents]:
  if item==base: break
  check(not item.is_symlink())
 return path.read_bytes()
def sha(b): return hashlib.sha256(b).hexdigest()
d=json.loads(read(root/'docs/collaboration/minkyu-completion-role-harness.json',root))
policy,_=o.load_policy(root)
f=h.validate_manifest(d,policy);preserved=h.validate_preserved(d,f,root,policy)
check(len(preserved)==145 and f.get('tests/integration/minkyu/completion_runner_privileges_local.mjs')=='B')
check(o.git(root,'rev-parse','HEAD').decode().strip()==d['baseline'])
check(o.git(root,'branch','--show-current').decode().strip()==d['branch'])
m=json.loads(read(edge/'edge-manifest.json',edge))
check(m['status']=='READY' and m['mode']=='gateway_probe' and m['source_head']==d['baseline'])
check(m['source_mode']=='working_tree_snapshot' and m['functions']==['service-api'])
check(m['output_root']==str(edge) and m['database_manifest']=='database-manifest.json')
check(m['migration_count']==39 and m['canonical_count']==28 and m['pending_count']==11)
check(m['source_config_sha256']==sha(read(root/'backend/supabase/config.toml',root)))
payloads=p.source_snapshot(root);entries=m['source_files'];seen=set();targets=set()
check(len(entries)==len(payloads))
for e in entries:
 check(set(e)=={'path','target','sha256'})
 source=Path(e['path']);target=Path('supabase/functions')/source.relative_to(p.FUNCTIONS)
 check(source in payloads and source not in seen and e['target']==str(target))
 b=read(edge/target,edge);check(b==payloads[source] and sha(b)==e['sha256'])
 seen.add(source);targets.add(target)
check({x.relative_to(edge) for x in (edge/'supabase/functions').rglob('*') if x.is_file()}==targets)
b=read(edge/'supabase/config.toml',edge);check(sha(b)==m['config_sha256']);c=tomllib.loads(b.decode())
check(c['project_id']=='yumidang-minkyu-gateway' and c['api']['port']==56521 and c['db']['port']==56522 and c['db']['shadow_port']==56520)
check(c['edge_runtime']['enabled'] is True and set(c['functions'])=={'service-api'} and c['functions']['service-api']['verify_jwt'] is False)
expected=['20260929100000_event_storage.sql','20261002090000_naver_signup.sql','20261002100000_matching_lifecycle.sql',
 '20261002110000_completion_review_policy.sql','20261002120000_appointment_changes.sql','20261002130000_ai_budget_worker.sql',
 '20261002131000_events_public_profile.sql','20261002140000_public_search_age_range.sql','20261002150000_post_event_links.sql',
 '20261002160000_event_rankings.sql','20261003090000_completion_runner_role.sql']
check([x.name for x in p.GATEWAY_PENDING]==expected)
db=json.loads(read(edge/'database-manifest.json',edge));canonical=inspect_migrations(root)['migrations']
check(db['mode']=='gateway_probe' and db['count']==28 and db['total_count']==39 and db['migrations']==canonical)
check([Path(x['path']).name for x in db['pending']]==expected)
for e in canonical+db['pending']:
 source=Path(e['path']);check(source.parent==Path('backend/supabase/migrations'))
 check(re.fullmatch(r'[0-9]{14}_[a-z0-9_]+\.sql',source.name))
 b=read(edge/'supabase/migrations'/source.name,edge)
 check(b==read(root/source,root) and sha(b)==e['sha256'] and len(b)==e['bytes'])
check({x.name for x in (edge/'supabase/migrations').iterdir()}=={Path(e['path']).name for e in canonical+db['pending']})
`;
  const checked = spawnSync('python3', ['-B', '-c', code, ROOT, config.EDGE_ROOT],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 65536 });
  requireSafe(checked.status === 0, 'harness_and_39_sql_snapshot');
  for (const relative of ['package.json', 'package-lock.json', runnerPath, schedulerPath]) {
    const original = regular(`${ROOT}/backend/${relative}`);
    const copied = regular(`${RUNTIME}/${relative}`);
    requireSafe(original.equals(copied), 'original_runner_runtime_bytes');
    requireSafe(createHash('sha256').update(original).digest('hex') ===
      createHash('sha256').update(copied).digest('hex'));
  }
  requireSafe(JSON.parse(regular(`${RUNTIME}/package.json`)).dependencies.pg === '8.22.0');
  requireSafe(JSON.parse(regular(`${RUNTIME}/node_modules/pg/package.json`)).version === '8.22.0');
}
function docker(...args) {
  const result = spawnSync('docker', ['--context', CONTEXT, ...args],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 262144 });
  requireSafe(result.status === 0);
  return result.stdout.trim();
}
function targetGuard() {
  requireSafe(docker('context', 'inspect', CONTEXT, '--format', '{{.Endpoints.docker.Host}}') ===
    `unix://${homedir()}/.colima/yumidang-minkyu/docker.sock`);
  const targets = JSON.parse(docker('inspect', CONTAINER));
  requireSafe(Array.isArray(targets) && targets.length === 1);
  const target = targets[0];
  requireSafe(target.Name === `/${CONTAINER}` && target.State.Running === true &&
    target.Config.Labels['com.supabase.cli.project'] === PROJECT);
  const bindings = target.HostConfig.PortBindings?.['5432/tcp'];
  requireSafe(Array.isArray(bindings) && bindings.some(b => b.HostPort === '56522' &&
    ['', '127.0.0.1', '0.0.0.0'].includes(b.HostIp)));
}
async function query(text, params = []) { return (await admin.query(text, params)).rows; }
async function zeroGuard() {
  const tables = await query(`select schemaname,tablename from pg_tables where schemaname in('public','private')
    and not(schemaname='private' and tablename='review_praise_catalog') order by schemaname,tablename`);
  requireSafe(tables.length >= 23, 'relevant_tables_present');
  // 칭찬 카탈로그 외 모든 앱 자료를 제한된 식별자 형식으로 검사한다.
  for (const { schemaname, tablename } of tables) {
    requireSafe(/^[a-z_]+$/.test(schemaname) && /^[a-z0-9_]+$/.test(tablename));
    requireSafe((await query(`select count(*)::int as n from "${schemaname}"."${tablename}"`))[0].n === 0, 'all_application_tables_empty');
  }
  const [row] = await query(`select (select count(*) from auth.users)::int as users,
    (select count(*) from storage.objects)::int as objects`);
  requireSafe(row.users === 0 && row.objects === 0, 'auth_and_storage_empty');
  emptyTableCount = tables.length;
}
async function runnerPids() {
  const sessions = await query('select pid,usename from pg_stat_activity where application_name=$1 and datname=current_database()', [APP]);
  requireSafe(sessions.every(r => r.usename === workerRole), 'cli_worker_identity');
  if (sessions.length) workerSession = true;
  return sessions.map(r => r.pid);
}
async function waitUntil(predicate, timeoutMs = 12000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (child) requireSafe(!child.bad && child.exit === undefined);
    if (await predicate()) return;
    await sleep(50);
  }
  requireSafe(false);
}
function start() {
  const handle = { readyCount: 0, unavailableCount: 0, bad: false, exit: undefined, stderr: '' };
  const processChild = spawn(process.execPath, [`${RUNTIME}/${runnerPath}`], {
    cwd: RUNTIME, env: { COMPLETION_DATABASE_URL: workerUrl,
      COMPLETION_RECONNECT_MS: '1500', COMPLETION_QUERY_TIMEOUT_MS: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  handle.process = processChild;
  processChild.once('spawn', () => { cliStarted = true; });
  handle.finished = new Promise(resolveExit => {
    processChild.once('exit', (code, signal) => { handle.exit = { code, signal }; resolveExit(handle.exit); });
    processChild.once('error', () => { handle.bad = true; resolveExit(null); });
  });
  processChild.stdout.on('data', () => { handle.bad = true; });
  processChild.stderr.on('data', bytes => {
    handle.stderr += bytes.toString('utf8');
    if (handle.stderr.length > 4096) { handle.stderr = ''; handle.bad = true; return; }
    let newline;
    while ((newline = handle.stderr.indexOf('\n')) >= 0) {
      const code = handle.stderr.slice(0, newline); handle.stderr = handle.stderr.slice(newline + 1);
      if (code === 'COMPLETION_SCHEDULER_READY') handle.readyCount++;
      else if (code === 'COMPLETION_CONNECTION_UNAVAILABLE') handle.unavailableCount++;
      else handle.bad = true;
    }
  });
  child = handle;
}
async function stopChild() {
  if (!child) return;
  const current = child; child = undefined;
  if (current.exit === undefined) current.process.kill('SIGTERM');
  let timer;
  const stopped = await Promise.race([current.finished, new Promise(r => { timer = setTimeout(() => r(null), 7000); })]);
  clearTimeout(timer);
  if (!stopped) { current.process.kill('SIGKILL'); await current.finished; }
  requireSafe(stopped && stopped.code === 0 && !stopped.signal && !current.bad && current.stderr === '');
  requireSafe((await runnerPids()).length === 0);
}
async function transaction(action) {
  await query('begin');
  try { const result = await action(); await query('commit'); return result; }
  catch { await query('rollback'); throw new Error('LOCAL_COMPLETION_TRANSACTION_FAILED'); }
}
async function fixture(index, dueOffsetMs) {
  return transaction(async () => {
    // 실제 예약의 원천 ends_at+24h를 유지하며 trigger가 예약과 NOTIFY를 생성한다.
    const [clock] = await query(`select clock_timestamp()+($1::double precision*interval '1 millisecond') as due`, [dueOffsetMs]);
    const due = clock.due;
    await query(`insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,cost_type,amount,status)
      values($1,$2,'합성 상주 완료 공고','로컬 실행기 복구 검증','산책',
        $3::timestamptz-interval '25 hours',$3::timestamptz-interval '24 hours',
        $3::timestamptz-interval '26 hours','서울특별시 강남구 역삼동','free',0,'closed')`, [posts[index], people[0], due]);
    await query(`insert into public.join_requests(id,post_id,requester_id,message,status)
      values($1,$2,$3,'합성 완료 실행기 검증 신청','matched')`, [requests[index], posts[index], people[1]]);
    await query(`insert into public.appointments(id,post_id,join_request_id,status) values($1,$2,$3,'confirmed')`,
      [appointments[index], posts[index], requests[index]]);
    const [reservation] = await query('select generation,due_at from private.completion_reservations where appointment_id=$1', [appointments[index]]);
    requireSafe(reservation && reservation.due_at.getTime() === due.getTime());
    return reservation;
  });
}
async function completed(index) {
  const [row] = await query(`select ap.status,ap.completion_method,ap.completed_at::text as completed_at,
    ap.completed_at>=ap.confirmed_at and ap.completed_at>=clock_timestamp()-interval '1 minute' as recent,
    ap.review_deadline_at=ap.completed_at+interval '7 days' as deadline,
    ap.completion_notified_at=ap.completed_at as notified,
    not exists(select 1 from private.completion_reservations where appointment_id=ap.id) as removed,
    (select count(*)::int from public.notifications where kind='appointment_completed' and join_request_id=ap.join_request_id) as notifications,
    (select count(*)::int from public.appointment_completion_confirmations where appointment_id=ap.id) as manual_confirmations
    from public.appointments ap where ap.id=$1`, [appointments[index]]);
  return row;
}
async function awaitCompleted(index) {
  await waitUntil(async () => (await completed(index))?.status === 'completed');
  const row = await completed(index);
  requireSafe(row.completion_method === 'automatic' && row.recent && row.deadline && row.notified &&
    row.removed && row.notifications === 2 && row.manual_confirmations === 0);
  return row.completed_at;
}
async function provisionWorker(Client, config) {
  requireSafe(/^[a-z][a-z0-9_]{1,62}$/.test(workerRole) && /^[0-9a-f]{64}$/.test(workerPassword));
  requireSafe((await query('select count(*)::int as n from pg_roles where rolname like $1', [ROLE_PREFIX + '%']))[0].n === 0,
    'no_prior_fixture_role');
  await transaction(async () => {
    await query(`create role "${workerRole}" login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
      connection limit 2 password '${workerPassword}'`);
    await query(`grant ${GROUP} to "${workerRole}"`);
  });
  roleCreated = true;
  const [attributes] = await query(`select rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
    rolconnlimit from pg_roles where rolname=$1`, [workerRole]);
  requireSafe(attributes.rolcanlogin && attributes.rolinherit && attributes.rolconnlimit === 2 &&
    !attributes.rolsuper && !attributes.rolcreatedb && !attributes.rolcreaterole &&
    !attributes.rolreplication && !attributes.rolbypassrls, 'restricted_login_attributes');
  const memberships = await query(`select g.rolname,m.admin_option from pg_auth_members m
    join pg_roles g on g.oid=m.roleid join pg_roles r on r.oid=m.member where r.rolname=$1`, [workerRole]);
  requireSafe(memberships.length === 1 && memberships[0].rolname === GROUP && !memberships[0].admin_option,
    'single_group_without_admin_option');
  const [inherited] = await query(`select count(*)::int as n from pg_roles
    where pg_has_role($1,oid,'MEMBER')`, [workerRole]);
  requireSafe(inherited.n === 2, 'no_indirect_privileged_membership');
  const [group] = await query(`select rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    from pg_roles where rolname=$1`, [GROUP]);
  requireSafe(group && Object.values(group).every(value => value === false), 'restricted_nologin_group');
  const [effective] = await query(`select
    has_schema_privilege($1,'public','USAGE') as usage,
    has_schema_privilege($1,'public','CREATE') as create_public,
    has_schema_privilege($1,'private','USAGE') as private_usage,
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in('public','private','auth','storage','vault','realtime','cron','supabase_functions','supabase_migrations')
      and has_schema_privilege($1,n.oid,'USAGE') and has_function_privilege($1,p.oid,'EXECUTE')) as app_functions,
    not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in('public','private','auth','storage','vault','realtime','cron','supabase_functions','supabase_migrations')
      and has_schema_privilege($1,n.oid,'USAGE') and c.relkind in('r','p','v','m','f') and
      (has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege($1,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) as tables_denied`, [workerRole]);
  requireSafe(effective.usage && !effective.create_public && !effective.private_usage && effective.app_functions === 2 &&
    effective.tables_denied, 'only_two_effective_application_rpcs');
  // 로컬 pg_cron의 PUBLIC 표 권한은 유지되지만 schema USAGE 없이는 실제 접근할 수 없다.
  const [cron] = await query(`select has_schema_privilege($1,'cron','USAGE') as usage,
    has_table_privilege($1,'cron.job','SELECT') as latent_job_select,
    has_table_privilege($1,'cron.job_run_details','SELECT') as latent_details_select`, [workerRole]);
  requireSafe(!cron.usage && cron.latent_job_select && cron.latent_details_select, 'cron_schema_denies_latent_public_select');
  const url = new URL(config.DATABASE_URL); url.username = workerRole; url.password = workerPassword;
  workerUrl = url.href;
  worker = new Client({ connectionString: workerUrl, ssl: false, application_name: 'yumidang-completion-permission-check',
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
  worker.on('error', () => {}); await worker.connect();
  const [identity] = (await worker.query('select current_user as u,session_user as s')).rows;
  requireSafe(identity.u === workerRole && identity.s === workerRole, 'native_login_identity');
  const [snapshot] = (await worker.query('select public.list_completion_reservations() as result')).rows;
  requireSafe(Array.isArray(snapshot.result.reservations) && snapshot.result.reservations.length === 0, 'allowed_snapshot_rpc');
  const [stale] = (await worker.query('select public.execute_completion_reservation($1::uuid,$2::uuid) as result',
    [uid(901), uid(902)])).rows;
  requireSafe(stale.result.status === 'stale', 'allowed_execution_rpc');
  const denials = [
    'select * from public.profiles', 'select * from public.chat_messages', 'select * from auth.users',
    'select * from private.completion_reservations', 'select * from private.worker_jobs',
    'select count(*) from cron.job', 'select count(*) from cron.job_run_details',
    'update public.profiles set real_name=real_name where false', 'delete from public.chat_messages where false',
    'select public.process_due_completions(1)', 'select public.get_my_profile()',
    'set role postgres', 'set role service_role', 'set role authenticated', 'set role authenticator',
    'set role anon', 'set role pg_monitor',
    'set session authorization postgres', `alter role "${workerRole}" superuser`,
    `create table public.ym_completion_escape_${workerRole.slice(-12)}(id integer)`,
  ];
  for (const text of denials) {
    let rejected = false;
    await worker.query('begin');
    try { await worker.query(text); }
    catch (error) { rejected = error?.code === '42501'; }
    finally { await worker.query('rollback'); }
    requireSafe(rejected, 'worker_privileged_operation_denied');
  }
  await worker.query(`set request.jwt.claims='{"role":"service_role"}'`);
  let rejected = false;
  try { await worker.query('select public.process_due_completions(1)'); }
  catch (error) { rejected = error?.code === '42501'; }
  requireSafe(rejected, 'jwt_claim_does_not_grant_database_role');
  await worker.end(); worker = undefined; workerPermissions = true;
}
async function execute(config) {
  stage = 'source_snapshot'; sourceGuard(config);
  stage = 'dedicated_target'; targetGuard();
  const { Client } = createRequire(`${RUNTIME}/package.json`)('pg');
  admin = new Client({ connectionString: config.DATABASE_URL, ssl: false, application_name: 'yumidang-completion-integration',
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
  admin.on('error', () => {});
  await admin.connect();
  await zeroGuard(); requireSafe((await runnerPids()).length === 0);
  const [schema] = await query(`select to_regprocedure('public.execute_completion_reservation(uuid,uuid)') is not null as ready,
    (select count(*)::int from supabase_migrations.schema_migrations) as migrations,
    exists(select 1 from supabase_migrations.schema_migrations where version='20261003090000') as role_migration`);
  requireSafe(schema.ready && schema.migrations === 39 && schema.role_migration, 'actual_39_migrations');
  guarded = true;
  stage = 'restricted_worker_permissions'; await provisionWorker(Client, config);
  await query(`set request.jwt.claims='{"role":"service_role"}'`);
  await transaction(async () => {
    await query('insert into auth.users(id) select unnest($1::uuid[])', [people]);
    await query(`insert into public.profiles(id,real_name,birth_date,gender)
      select unnest($1::uuid[]),'합성 상주 실행기 회원','1990-01-01'::date,'female'`, [people]);
  });

  stage = 'startup_overdue';
  await fixture(0, -1000);
  start();
  await waitUntil(async () => child.readyCount === 1 && (await runnerPids()).length === 1);
  const originalCompletion = await awaitCompleted(0); groups++;

  stage = 'committed_notification_reschedule';
  const old = await fixture(1, 2000);
  const [changed] = await query(`update public.posts set ends_at=clock_timestamp()-interval '24 hours'+interval '4 seconds'
    where id=$1 returning ends_at+interval '24 hours' as due`, [posts[1]]);
  const [fresh] = await query('select generation,due_at from private.completion_reservations where appointment_id=$1', [appointments[1]]);
  requireSafe(old.generation !== fresh.generation && fresh.due_at.getTime() === changed.due.getTime());
  await waitUntil(async () => (await query("select clock_timestamp()>$1::timestamptz+interval '250 milliseconds' as passed", [old.due_at]))[0].passed);
  requireSafe((await completed(1)).status === 'confirmed');
  await awaitCompleted(1); groups++;

  stage = 'backend_disconnect_reconnect';
  const [oldPid] = await runnerPids(); requireSafe(Number.isInteger(oldPid));
  const readyBefore = child.readyCount;
  requireSafe((await query('select pg_terminate_backend($1) as terminated', [oldPid]))[0].terminated);
  await waitUntil(async () => child.unavailableCount >= 1);
  await fixture(2, -1000);
  requireSafe(child.readyCount === readyBefore);
  await waitUntil(async () => {
    const ids = await runnerPids(); return child.readyCount > readyBefore && ids.length === 1 && ids[0] !== oldPid;
  });
  await awaitCompleted(2); groups++;

  stage = 'sigterm_restart_recovery';
  await stopChild();
  await fixture(3, -1000);
  requireSafe((await completed(3)).status === 'confirmed');
  start();
  await waitUntil(async () => child.readyCount === 1 && (await runnerPids()).length === 1);
  await awaitCompleted(3);
  const previous = await completed(0);
  requireSafe(previous.completed_at === originalCompletion && previous.notifications === 2);
  groups++;
}
async function cleanup() {
  let stoppedCleanly = true;
  try { await stopChild(); } catch { stoppedCleanly = false; }
  if (worker) { try { await worker.end(); } catch { stoppedCleanly = false; } worker = undefined; }
  if (!guarded) return;
  await query('rollback');
  await transaction(async () => {
    await query('delete from public.posts where id=any($1::uuid[])', [posts]);
    await query('delete from public.profiles where id=any($1::uuid[])', [people]);
    await query('delete from auth.users where id=any($1::uuid[])', [people]);
  });
  requireSafe((await runnerPids()).length === 0);
  const exists = (await query('select exists(select 1 from pg_roles where rolname=$1) as present', [workerRole]))[0].present;
  if (exists) {
    await query(`revoke ${GROUP} from "${workerRole}"`);
    await query(`drop role "${workerRole}"`); roleCreated = false;
  }
  requireSafe((await query('select count(*)::int as n from pg_roles where rolname=$1', [workerRole]))[0].n === 0, 'fixture_role_removed');
  await zeroGuard();
  cleanupPassed = true;
  requireSafe(stoppedCleanly);
}

let passed = false;
try {
  if (process.argv.length === 2) {
    console.log(JSON.stringify({ status: 'NOT_RUN', actualPostgres: false, groups: 4 }));
  } else {
    requireSafe(process.argv.length === 4 && process.argv[2] === '--config');
    await execute(readConfig(process.argv[3])); passed = true;
  }
} catch { /* 원문 SQL/credential/child 출력을 반환하지 않는다. */ }
finally {
  if (admin || worker || child) {
    const previousStage = stage;
    try { stage = 'synthetic_cleanup'; await cleanup(); stage = previousStage; }
    catch { passed = false; }
    try { await admin?.end(); } catch { passed = false; }
  }
}
if (process.argv.length !== 2) {
  console.log(JSON.stringify({ status: passed && cleanupPassed ? 'PASS' : 'FAIL', stage, groups, checks,
    syntheticCleanup: cleanupPassed, actualPostgres: guarded, nativeCli: cliStarted,
    fixtureAdministratorConnection: true, restrictedWorkerConnection: workerSession, workerPermissions,
    emptyApplicationTables: emptyTableCount, temporaryLoginRemoved: !roleCreated, failedCheck, productionLeastPrivilege: 'NOT_RUN', remote: 'NOT_RUN', externalNaver: false, externalAI: false }));
  process.exitCode = passed && cleanupPassed ? 0 : 1;
}
