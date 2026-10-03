/** 민규: 실제 상주 CLI와 PostgreSQL의 시작·알림·재접속·재시작 최소 검증.
 * 총괄이 준비한 로컬 gateway DB와 잠금된 임시 pg 설치만 사용한다.
 * 합성 약속은 COMMIT하여 별도 실행기가 관측하도록 하며 finally에서 정리한다.
 * 네이버/외부 AI/원격/운영 최소권한 검증은 하지 않는다. CLI 프로젝트 관리도 하지 않는다.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const uid = n => `a6100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const people = [uid(1), uid(2)];
const posts = [uid(101), uid(102), uid(103), uid(104)];
const requests = [uid(201), uid(202), uid(203), uid(204)];
const appointments = [uid(301), uid(302), uid(303), uid(304)];
let stage = 'configuration', checks = 0, groups = 0, cleanupPassed = false;
let admin, child, guarded = false, cliStarted = false;
const requireSafe = condition => { checks++; if (!condition) throw new Error('LOCAL_COMPLETION_CHECK_FAILED'); };
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
  // 기존 읽기 전용 snapshot/harness guard를 재사용한다. 출력과 원문 오류는 전달하지 않는다.
  const code = 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);' +
    'import gateway_cors_local as p;p.source_guards(Path(sys.argv[2]))';
  const checked = spawnSync('python3', ['-B', '-c', code, `${ROOT}/tests/integration/minkyu`, config.EDGE_ROOT],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  requireSafe(checked.status === 0);
  const harness = JSON.parse(regular(`${ROOT}/docs/collaboration/minkyu-gateway-harness.json`));
  requireSafe(harness.lanes.B.includes('tests/integration/minkyu/completion_runner_local.mjs'));
  for (const relative of ['package.json', 'package-lock.json', runnerPath, schedulerPath]) {
    const original = regular(`${ROOT}/backend/${relative}`);
    const copied = regular(`${RUNTIME}/${relative}`);
    requireSafe(original.equals(copied));
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
  const [row] = await query(`select
    (select count(*) from auth.users)::int as users,
    (select count(*) from public.posts)::int as posts,
    (select count(*) from private.worker_jobs)::int as jobs,
    (select count(*) from private.completion_reservations)::int as reservations,
    (select count(*) from public.appointments)::int as appointments,
    (select count(*) from public.notifications)::int as notifications`);
  requireSafe(Object.values(row).every(n => n === 0));
}
async function runnerPids() {
  return (await query('select pid from pg_stat_activity where application_name=$1 and datname=current_database()', [APP])).map(r => r.pid);
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
function start(config) {
  const handle = { readyCount: 0, unavailableCount: 0, bad: false, exit: undefined, stderr: '' };
  const processChild = spawn(process.execPath, [`${RUNTIME}/${runnerPath}`], {
    cwd: RUNTIME, env: { COMPLETION_DATABASE_URL: config.DATABASE_URL,
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
async function execute(config) {
  stage = 'source_snapshot'; sourceGuard(config);
  stage = 'dedicated_target'; targetGuard();
  const { Client } = createRequire(`${RUNTIME}/package.json`)('pg');
  admin = new Client({ connectionString: config.DATABASE_URL, ssl: false, application_name: 'yumidang-completion-integration',
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
  admin.on('error', () => {});
  await admin.connect();
  await zeroGuard(); requireSafe((await runnerPids()).length === 0);
  requireSafe((await query("select to_regprocedure('public.execute_completion_reservation(uuid,uuid)') is not null as ready"))[0].ready);
  guarded = true;
  await query(`set request.jwt.claims='{"role":"service_role"}'`);
  await transaction(async () => {
    await query('insert into auth.users(id) select unnest($1::uuid[])', [people]);
    await query(`insert into public.profiles(id,real_name,birth_date,gender)
      select unnest($1::uuid[]),'합성 상주 실행기 회원','1990-01-01'::date,'female'`, [people]);
  });

  stage = 'startup_overdue';
  await fixture(0, -1000);
  start(config);
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
  start(config);
  await waitUntil(async () => child.readyCount === 1 && (await runnerPids()).length === 1);
  await awaitCompleted(3);
  const previous = await completed(0);
  requireSafe(previous.completed_at === originalCompletion && previous.notifications === 2);
  groups++;
}
async function cleanup() {
  let stoppedCleanly = true;
  try { await stopChild(); } catch { stoppedCleanly = false; }
  if (!guarded) return;
  await query('rollback');
  await transaction(async () => {
    await query('delete from public.posts where id=any($1::uuid[])', [posts]);
    await query('delete from public.profiles where id=any($1::uuid[])', [people]);
    await query('delete from auth.users where id=any($1::uuid[])', [people]);
  });
  await zeroGuard(); requireSafe((await runnerPids()).length === 0);
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
  if (admin || child) {
    const previousStage = stage;
    try { stage = 'synthetic_cleanup'; await cleanup(); stage = previousStage; }
    catch { passed = false; }
    try { await admin?.end(); } catch { passed = false; }
  }
}
if (process.argv.length !== 2) {
  console.log(JSON.stringify({ status: passed && cleanupPassed ? 'PASS' : 'FAIL', stage, groups, checks,
    syntheticCleanup: cleanupPassed, actualPostgres: guarded, nativeCli: cliStarted,
    administratorConnection: true, productionLeastPrivilege: 'NOT_RUN', remote: 'NOT_RUN', externalNaver: false, externalAI: false }));
  process.exitCode = passed && cleanupPassed ? 0 : 1;
}
