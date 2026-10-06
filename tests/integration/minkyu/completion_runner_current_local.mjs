/** 민규: 독립 drift 클러스터의 현재 schema와 원형 실행기 프로세스/전용 LOGIN 실제 검증. */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

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
