/** Actual product handler + SQL109 + two independent Node CLI processes.
 * Only the recorded disposable clone is used; no supplier, OAuth or member login.
 * A PASS receipt is written only after DB proof, HTTP loss recovery and restart.
 */
import assert from "node:assert/strict";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { createReviewSummaryWorkerRuntime } from "../../../backend/supabase/functions/review-summary-worker/index.ts";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { createInternalClient } from "../../../backend/supabase/functions/_shared/db/internal-client.ts";
import { requireInternalCaller } from "../../../backend/supabase/functions/_shared/auth/internal-caller.ts";
import { HttpError, toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import { createWorkerInvocationRuntime } from "../../../backend/supabase/functions/_shared/db/worker-runtime-client.ts";

const reconnectScenario = Deno.args.length === 2 && ["--revision-v7", "--revision-v8", "--revision-v9", "--revision-v10", "--revision-v11", "--revision-v12"].includes(Deno.args[0]) && Deno.args[1] === "--scenario-reconnect";
assert.ok(reconnectScenario || Deno.args.length === 0 || Deno.args.length === 1 && ["--revision-v2", "--revision-v3", "--revision-v4", "--revision-v5"].includes(Deno.args[0]), "INVALID_REVISION_ARGUMENTS");
const revision = Deno.args.length ? Deno.args[0].slice("--revision-".length) : "v1";
const root = reconnectScenario ? "/private/tmp/yumidang-invocation109-reconnect-" + revision : "/private/tmp/yumidang-invocation109-http-" + revision;
const f = JSON.parse(await Deno.readTextFile(root + "/connection-private.json"));
assert.equal(f.clone, reconnectScenario ? "yumidang-minkyu-invocation109-reconnect-" + revision : "yumidang-minkyu-invocation109-http-" + revision, "RECORDED_CLONE_REQUIRED");
assert.equal(f.source, "yumidang-minkyu-invocation109-20261009-v1", "READ_ONLY_SOURCE_REQUIRED");
const repo = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const controlPath = repo + "/tests/integration/minkyu/worker_invocation_http_local.py";
const cliPath = repo + "/backend/supabase/functions/scheduled-jobs/queue-runner.mjs";
await Deno.stat(repo + "/backend/node_modules/pg/package.json");
let config: ReturnType<typeof loadRuntimeConfig>;
let helpfulCalls = 0, reviewCalls = 0, externalCalls = 0, lost = false;
const events: Array<{ name: string; requestId: string | null; token: string | null; claimed?: boolean; responseStatus?: number; hasPending?: boolean }> = [];
const originalFetch = globalThis.fetch;
const client = Deno.createHttpClient({ caCerts: [await Deno.readTextFile(root + "/ca.crt")] });
const safeFetch: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1") {
    externalCalls++;
    throw Error("EXTERNAL_DESTINATION_DISABLED");
  }
  if (url.protocol === "http:" && Number(url.port) !== f.restPort) {
    externalCalls++;
    throw Error("UNOWNED_LOCAL_DESTINATION_DISABLED");
  }
  return originalFetch(input, { ...init, client } as unknown as RequestInit);
};

async function control(action: string) {
  const p = await new Deno.Command("python3", { args: [controlPath, action, ...(reconnectScenario ? ["--revision-" + revision, "--scenario-reconnect"] : revision !== "v1" ? ["--revision-" + revision] : [])], cwd: repo, stdout: "piped", stderr: "piped" }).output();
  if (p.code !== 0) {
    await Deno.writeFile(root + "/control-failure-" + crypto.randomUUID() + ".log", new Uint8Array([...p.stdout, ...p.stderr]), { mode: 0o600, createNew: true });
    throw Error("ISOLATED_CONTROL_FAILED_PRIVATE_EVIDENCE_PRESERVED");
  }
  return new TextDecoder().decode(p.stdout);
}
const snapshot = async () => JSON.parse(await control("--snapshot"));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, code: string, milliseconds = 15000) {
  const deadline = performance.now() + milliseconds;
  do {
    if (await check()) return;
    await delay(100);
  } while (performance.now() < deadline);
  throw Error(code);
}

const api = createServiceApi({
  allowedOrigins: [], maxBodyBytes: 65536,
  authenticateUser: () => { throw new HttpError("ACCESS_DENIED"); },
  authenticateInternal: async request => {
    await requireInternalCaller(request, config);
    return createInternalClient(config, safeFetch);
  },
});
let review: ReturnType<typeof createReviewSummaryWorkerRuntime>;
const server = Deno.serve({ hostname: "127.0.0.1", port: 0,
  cert: await Deno.readTextFile(root + "/server.crt"), key: await Deno.readTextFile(root + "/server.key"),
  onListen() {}, onError: () => new Response(null, { status: 503 }),
}, async request => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/rest/v1/rpc/")) {
    const name = url.pathname.split("/").at(-1)!;
    assert.match(name, /^[a-z][a-z0-9_]*$/, "INVALID_RPC_PATH");
    const text = await request.text();
    const args = JSON.parse(text);
    const event = { name, requestId: args.p_request_id ?? null, token: args.p_global_token ?? args.p_worker_run_token ?? null } as typeof events[number];
    events.push(event);
    const response = await safeFetch("http://127.0.0.1:" + f.restPort + "/rpc/" + name, {
      method: request.method, headers: request.headers, body: text, redirect: "error",
    });
    if (reconnectScenario && name === "read_worker_runtime_pending_v2") {
      event.responseStatus = response.status;
      if (response.ok) {
        const pending = await response.clone().json();
        assert.equal(response.status, 200, "ACTUAL_PENDING_HTTP_STATUS_INVALID");
        assert.deepEqual(Object.keys(pending), ["hasPending"], "ACTUAL_PENDING_DTO_INVALID");
        assert.equal(typeof pending.hasPending, "boolean", "ACTUAL_PENDING_BOOLEAN_INVALID");
        event.hasPending = pending.hasPending;
      }
    }
    if (name === "claim_queue_invocation_dispatch" && response.ok) event.claimed = (await response.clone().json()).claimed;
    return response;
  }
  if (url.pathname === "/functions/v1/service-api/internal/ai-feedback-maintenance") {
    helpfulCalls++;
    const response = await api(request);
    assert.equal(response.status, 200, "ACTUAL_HELPFUL_HANDLER_FAILED");
    const stored = await response.arrayBuffer();
    if (!lost && !reconnectScenario) {
      // Real handler/DB transaction has committed. Lose its HTTP body once only.
      await until(async () => (await snapshot()).queueSessions === 2, "TWO_REAL_NODE_SESSIONS_REQUIRED", 5000);
      lost = true;
      return new Response(new ReadableStream({ start(controller) { controller.error(Error("SYNTHETIC_RESPONSE_LOSS")); } }));
    }
    return new Response(stored, { status: response.status, headers: response.headers });
  }
  if (url.pathname === "/functions/v1/review-summary-worker") {
    reviewCalls++;
    return review(request);
  }
  return new Response(null, { status: 404 });
});
const origin = "https://127.0.0.1:" + server.addr.port;
const values: Record<string, string> = {
  SUPABASE_URL: origin, SUPABASE_ANON_KEY: f.anonKey, SUPABASE_SERVICE_ROLE_KEY: f.serviceKey,
  INTERNAL_WORKER_SECRET: f.internalSecret, ALLOWED_ORIGINS: "[]", UPSTREAM_TIMEOUT_MS: "15000", MAX_REQUEST_BYTES: "65536",
};
config = loadRuntimeConfig(key => values[key]);
review = createReviewSummaryWorkerRuntime(key => values[key], { fetch: safeFetch });
const invocation = createWorkerInvocationRuntime(createInternalClient(config, safeFetch));
const env: Record<string, string> = {
  ...values,
  WORKER_QUEUE_DATABASE_URL: "postgresql://" + f.login + ":" + f.password + "@127.0.0.1:" + f.dbPort + "/postgres",
  WORKER_QUEUE_FUNCTION_URL: origin + "/functions/v1/review-summary-worker",
  WORKER_QUEUE_DB_CA_PEM: await Deno.readTextFile(root + "/ca.crt"),
  WORKER_QUEUE_DB_CONTRACT_ID: "isolated-http109-" + revision, WORKER_QUEUE_DB_LOGIN_ROLE: f.login,
  WORKER_QUEUE_QUERY_TIMEOUT_MS: "3000", WORKER_QUEUE_RECONNECT_MS: reconnectScenario ? "5000" : "1000", WORKER_QUEUE_HTTP_TIMEOUT_MS: "15000",
  NODE_EXTRA_CA_CERTS: root + "/ca.crt",
};
interface Running {
  child: Deno.ChildProcess; output: Promise<Deno.CommandOutput>; name: string;
}
const children: Running[] = [];
function launch(name: string) {
  const child = new Deno.Command("node", { args: [cliPath], cwd: repo + "/backend", env, clearEnv: true, stdout: "piped", stderr: "piped" }).spawn();
  const running = { child, output: child.output(), name };
  children.push(running);
  return running;
}
async function stop(running: Running, pendingHasFuture?: boolean) {
  try { running.child.kill("SIGTERM"); } catch { /* Already exited; output code still checked. */ }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const output = await Promise.race([running.output, new Promise<never>((_, reject) => {
    timer = setTimeout(() => { try { running.child.kill("SIGKILL"); } catch { /* exit race */ } reject(Error("CLI_GRACEFUL_STOP_TIMEOUT")); }, 10000);
  })]).finally(() => clearTimeout(timer));
  await Deno.writeFile(root + "/" + running.name + "-private.log", new Uint8Array([...output.stdout, ...output.stderr]), { mode: 0o600, createNew: true });
  assert.equal(output.code, 0, "ACTUAL_NODE_CLI_FAILED");
  const codes = new TextDecoder().decode(output.stderr).trim().split(/\s+/).filter(Boolean);
  assert.ok(codes.includes("WORKER_QUEUE_READY"), "ACTUAL_NODE_CLI_NEVER_READY");
  if (reconnectScenario) {
    assert.equal(output.stdout.length, 0, "CLI_UNEXPECTED_RAW_STDOUT");
    assert.equal(codes.filter(x => x === "WORKER_QUEUE_UNAVAILABLE").length, 2, "TWO_REAL_CONNECTION_FAILURES_NOT_OBSERVED");
    assert.equal(codes.filter(x => x === "WORKER_QUEUE_READY").length, 3, "THREE_REAL_CONNECTION_READY_PHASES_REQUIRED");
    assert.equal(typeof pendingHasFuture, "boolean", "ACTUAL_PENDING_SCHEDULE_BARRIER_REQUIRED");
    // 현 scheduler는 미래 DB 예약이 있을 때 오류 코드를 생략하고 만료/알림을 기다린다.
    if (!pendingHasFuture) assert.ok(codes.includes("WORKER_QUEUE_RECONCILIATION_REQUIRED"), "UNKNOWN_WITHOUT_FUTURE_NOT_REPORTED");
  }
  assert.ok(codes.every(code => ["WORKER_QUEUE_READY", "WORKER_QUEUE_RECONCILIATION_REQUIRED", ...(reconnectScenario ? ["WORKER_QUEUE_UNAVAILABLE"] : [])].includes(code)), "ACTUAL_NODE_CLI_REPORTED_FAILURE");
  children.splice(children.indexOf(running), 1);
}

/** Pure template; the actual evaluated bytes must parse before any fixture opens. */
function reconnectObservedLauncher(cliUrl: string, tracePath: string): string {
  return `import {runQueueRunnerCli}from ${JSON.stringify(cliUrl)};
import {createRequire}from 'node:module';
import {openSync,writeSync,closeSync}from 'node:fs';
const {Client}=createRequire(${JSON.stringify(cliUrl)})('pg');
const descriptor=openSync(${JSON.stringify(tracePath)},'wx',0o600);
let sequence=0,databasePid=null;
const record=(value)=>writeSync(descriptor,JSON.stringify({sequence:++sequence,nodePid:process.pid,...value})+'\\n');
class ObservedClient extends Client{
 async connect(){await super.connect();databasePid=this.processID;record({code:'CONNECTED',databasePid});}
 async query(...args){
  const result=await super.query(...args);
  const text=typeof args[0]==='string'?args[0]:args[0]?.text;
  if(typeof text==='string'&&/^LISTEN (yumidang_worker_jobs|yumidang_cancellation_due)$/.test(text)){
   const channel=text.slice(7),proof=await super.query('select pg_backend_pid()as pid,array(select pg_listening_channels())as channels');
   if(proof.rows.length!==1||proof.rows[0].pid!==this.processID||!proof.rows[0].channels.includes(channel))throw Error('ACTUAL_LISTEN_STATE_MISSING');
   record({code:'LISTEN_VERIFIED',databasePid:this.processID,channel});
  }else if(typeof text==='string'){
   const name=['read_worker_queue_schedule','read_report_terminal_maintenance_schedule_v2'].find(value=>text.includes(value));
   if(name){
    const value=result.rows[0]?.result;
    if(!value||typeof value.serverNow!=='string'||!Number.isFinite(Date.parse(value.serverNow))||!(value.nextDueAt===null||typeof value.nextDueAt==='string'&&Number.isFinite(Date.parse(value.nextDueAt))))throw Error('ACTUAL_OBSERVED_SCHEDULE_INVALID');
    record({code:'SCHEDULE_QUERY_COMPLETED',databasePid:this.processID,name,serverNow:value.serverNow,nextDueAt:value.ready===false?null:value.nextDueAt});
   }
  }
  return result;
 }
}
process.once('exit',()=>closeSync(descriptor));
const nativeFetch=globalThis.fetch;
const observedFetch=async(...args)=>{
 const response=await nativeFetch(...args),name=new URL(args[0]instanceof Request?args[0].url:String(args[0])).pathname.split('/').at(-1);
 if(['read_worker_runtime_pending_v2','read_ai_feedback_maintenance_schedule','read_worker_runtime_maintenance_schedule'].includes(name)){
  const json=response.json.bind(response);
  response.json=async()=>{
   const value=await json();
   if(response.status===200){
    if(name==='read_worker_runtime_pending_v2'){
     if(!value||Object.keys(value).length!==1||typeof value.hasPending!=='boolean')throw Error('ACTUAL_OBSERVED_PENDING_INVALID');
     record({code:'RUNTIME_READ_CONSUMED',databasePid,name,status:200,hasPending:value.hasPending});
    }else{
     if(!value||typeof value.serverNow!=='string'||!Number.isFinite(Date.parse(value.serverNow))||!(value.nextDueAt===null||typeof value.nextDueAt==='string'&&Number.isFinite(Date.parse(value.nextDueAt))))throw Error('ACTUAL_OBSERVED_RUNTIME_SCHEDULE_INVALID');
     record({code:'RUNTIME_READ_CONSUMED',databasePid,name,status:200,serverNow:value.serverNow,nextDueAt:value.ready===false?null:value.nextDueAt});
    }
   }
   return value;
  };
 }
 return response;
};
await runQueueRunnerCli({dependencies:{loadClient:async()=>ObservedClient,fetchImpl:observedFetch}});
`;
}

/** 읽기 관측값만 검사하며 원 pending/lease 결과를 생성하거나 변경하지 않는다. */
function unknownReconnectBarrier(trace: Array<Record<string, any>>, rpcEvents: Array<Record<string, any>>, databasePid: number, nodePid: number, afterSequence: number, originalExpiry: string, runtimeRetention: Record<string, any>, expectedDefinitionSha256: string) {
  const consumed = trace.filter(x => x.sequence > afterSequence && x.databasePid === databasePid && x.nodePid === nodePid);
  const pending = consumed.find(x => x.code === "RUNTIME_READ_CONSUMED" && x.name === "read_worker_runtime_pending_v2" && x.status === 200 && x.hasPending === true);
  if (!pending || !rpcEvents.some(x => x.name === "read_worker_runtime_pending_v2" && x.responseStatus === 200 && x.hasPending === true)) return null;
  const schedules = [
    ["SCHEDULE_QUERY_COMPLETED", "read_worker_queue_schedule"],
    ["SCHEDULE_QUERY_COMPLETED", "read_report_terminal_maintenance_schedule_v2"],
    ["RUNTIME_READ_CONSUMED", "read_ai_feedback_maintenance_schedule"],
    ["RUNTIME_READ_CONSUMED", "read_worker_runtime_maintenance_schedule"],
  ].map(([code, name]) => consumed.find(x => x.sequence > pending.sequence && x.code === code && x.name === name && (code !== "RUNTIME_READ_CONSUMED" || x.status === 200))).filter((x): x is Record<string, any> => x !== undefined);
  if (schedules.length !== 4) return null;
  assert.ok(Number.isFinite(Date.parse(originalExpiry)), "ORIGINAL_UNKNOWN_EXPIRY_REQUIRED");
  const future = schedules.filter(x => x.nextDueAt !== null && Date.parse(x.nextDueAt) > Date.parse(x.serverNow));
  assert.ok(future.length > 0, "UNCHANGED_FIXTURE_FUTURE_LEASE_REQUIRED");
  const expiryMs = Date.parse(originalExpiry), scheduled = schedules.filter(x => x.nextDueAt !== null);
  assert.ok(scheduled.every(x => Date.parse(x.nextDueAt) >= expiryMs), "RESERVATION_BEFORE_ORIGINAL_EXPIRY");
  assert.equal(Math.min(...scheduled.map(x => Date.parse(x.nextDueAt))), expiryMs, "AGGREGATE_MIN_NOT_ORIGINAL_EXPIRY");
  const helpful = schedules.find(x => x.name === "read_ai_feedback_maintenance_schedule")!;
  assert.equal(Date.parse(helpful.nextDueAt), expiryMs, "ACTUAL_HELPFUL_FUTURE_NOT_ORIGINAL_EXPIRY");
  const runtime = schedules.find(x => x.name === "read_worker_runtime_maintenance_schedule")!;
  assert.ok(runtimeRetention && runtimeRetention.state === "completed" && runtimeRetention.invocationState === "completed" &&
    runtimeRetention.operation === runtimeRetention.invocationKind && ["helpful_maintenance", "runtime_maintenance", "terminal_maintenance"].includes(runtimeRetention.operation) &&
    runtimeRetention.globalBindingMatches === true && /^[a-f0-9]{64}$/.test(runtimeRetention.rowSha256) &&
    runtimeRetention.definitionSha256 === expectedDefinitionSha256 && /^[a-f0-9]{64}$/.test(expectedDefinitionSha256), "ACTUAL_RUNTIME_RETENTION_ROW_UNPROVEN");
  assert.equal(Date.parse(runtimeRetention.retentionDueAt) - Date.parse(runtimeRetention.closedAt), 720 * 3600000, "STORED_RUNTIME_RETENTION_CONTRACT_CHANGED");
  assert.equal(Date.parse(runtime.nextDueAt), Math.max(Date.parse(runtimeRetention.retentionDueAt), expiryMs), "RUNTIME_SCHEDULE_NOT_STORED_RETENTION_AND_LEASE");
  return { pendingHttpStatus: 200, hasPending: true, databasePid, nodePid, pendingSequence: pending.sequence,
    scheduleSequences: schedules.map(x => ({ name: x.name, sequence: x.sequence, serverNow: x.serverNow, nextDueAt: x.nextDueAt })),
    originalExpiry, hasFuture: true, runtimeRetention, aggregateNextDueAt: helpful.nextDueAt, noGlobalOrLeaseMutation: true };
}

/** 실제 pg.Client의 성공한 쿼리만 관찰한다. LISTEN 상태는 같은 DB 연결에서 읽는다. */
async function runReconnectScenario() {
  const launcher = root + "/reconnect-observed-cli.mjs", tracePath = root + "/reconnect-node-trace-private.jsonl";
  const cliUrl = new URL("file://" + cliPath).href;
  await Deno.writeTextFile(launcher, reconnectObservedLauncher(cliUrl, tracePath), { mode: 0o600, createNew: true });
  const syntax = await new Deno.Command("node", { args: ["--check", launcher], stdout: "piped", stderr: "piped" }).output();
  const launcherBytes = await Deno.readFile(launcher);
  await Deno.writeTextFile(root + "/reconnect-launcher-syntax-private.json", JSON.stringify({ status: syntax.success ? "PASS" : "FAIL", exitCode: syntax.code,
    launcherSha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", launcherBytes))).map(x => x.toString(16).padStart(2, "0")).join(""),
    stdoutSha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", syntax.stdout))).map(x => x.toString(16).padStart(2, "0")).join(""),
    stderrSha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", syntax.stderr))).map(x => x.toString(16).padStart(2, "0")).join(""),
    importsExecuted: 0, databaseCalls: 0, fixtureStarted: false }), { mode: 0o600, createNew: true });
  assert.ok(syntax.success, "ACTUAL_GENERATED_LAUNCHER_SYNTAX_FAILED_BEFORE_FIXTURE");

  await control("--fixture");
  const tlsRole = JSON.parse(await Deno.readTextFile(root + "/tls-role-evidence.json"));
  assert.ok(Object.values(tlsRole).every(value => value === true), "REAL_TLS_QUEUE_IDENTITY_REQUIRED");
  await until(async () => {
    try { await invocation.getQueueInvocation("00000000-0000-0000-0000-000000000000"); }
    catch (error) { return error instanceof HttpError && toPublicError(error).error.code === "RESOURCE_NOT_FOUND"; }
    return false;
  }, "REAL_SQL109_HTTP_PREFLIGHT_FAILED");
  const child = new Deno.Command("node", { args: [launcher], cwd: repo + "/backend", env, clearEnv: true, stdout: "piped", stderr: "piped" }).spawn();
  const running = { child, output: child.output(), name: "queue-reconnect-same-process" };
  children.push(running);
  const trace = async () => (await Deno.readTextFile(tracePath)).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const reconnectProof = async () => JSON.parse(await control("--reconnect-proof"));
  await until(async () => {
    const p = await snapshot(); return p.helpfulRemaining === 0 && p.runtimePurged === true && p.lease.token === null;
  }, "BASELINE_MAINTENANCE_NOT_COMPLETED");
  await until(async () => (await trace()).filter(x => x.code === "LISTEN_VERIFIED").length === 2, "INITIAL_ACTUAL_LISTEN_NOT_PROVEN");
  const original = await snapshot(), baseline = await reconnectProof(), before = { events: events.length, helpful: helpfulCalls, invocations: original.invocations.length };
  assert.equal(baseline.queueBackends.length, 1, "ONLY_ONE_REAL_QUEUE_SESSION_REQUIRED");
  assert.equal(original.slots, 0);
  const initialTrace = await trace();
  assert.ok(initialTrace.every(x => x.nodePid === child.pid), "OBSERVED_NODE_PID_MISMATCH");
  const originalDbPid = baseline.queueBackends[0].pid;
  await control("--disconnect-due");
  const gap = JSON.parse(await Deno.readTextFile(root + "/reconnect-gap-due-committed.json"));
  assert.equal(gap.databasePid, originalDbPid); assert.equal(gap.nodePid, child.pid);
  assert.equal(gap.noQueueListenerAtTransactionCheck, true); assert.equal(gap.dueRowsCommitted, 2);
  await until(async () => {
    const p = await reconnectProof(), current = await snapshot();
    return p.queueBackends.length === 1 && p.queueBackends[0].pid !== originalDbPid && p.missedHelpfulRemaining === 0 && p.missedRuntimePurged === true && current.lease.token === null;
  }, "SAME_PROCESS_DURABLE_DUE_NOT_RECOVERED", 25000);
  const recovered = await snapshot(), second = await reconnectProof(), afterTrace = await trace();
  const newDbPid = second.queueBackends[0].pid;
  assert.ok(afterTrace.every(x => x.nodePid === child.pid), "CLI_REPLACEMENT_USED_FOR_RECONNECT");
  for (const channel of ["yumidang_worker_jobs", "yumidang_cancellation_due"]) {
    const restored = afterTrace.find(x => x.code === "LISTEN_VERIFIED" && x.databasePid === newDbPid && x.channel === channel);
    assert.ok(restored, "REAL_LISTEN_NOT_RESTORED");
    assert.ok(afterTrace.some(x => x.code === "SCHEDULE_QUERY_COMPLETED" && x.databasePid === newDbPid && x.sequence > restored.sequence), "DURABLE_SCHEDULE_NOT_READ_AFTER_LISTEN");
  }
  const newRows = recovered.invocations.filter((x: { requestId: string }) => !original.invocations.some((old: { requestId: string }) => old.requestId === x.requestId));
  assert.equal(newRows.length, 2, "RECONNECT_DUPLICATE_OR_MISSING_INVOCATION");
  assert.equal(helpfulCalls, before.helpful + 1, "RECONNECT_HELPFUL_HTTP_NOT_EXACTLY_ONCE");
  assert.equal(recovered.slots, original.slots, "MAINTENANCE_RECONNECT_CONSUMED_JOB_SLOT");
  for (const kind of ["helpful_maintenance", "runtime_maintenance"]) {
    const rows = newRows.filter((x: { kind: string }) => x.kind === kind);
    assert.equal(rows.length, 1); assert.equal(rows[0].state, "completed"); assert.equal(rows[0].result.purged, 1);
    const scoped = events.slice(before.events).filter(x => x.requestId === rows[0].requestId);
    const cas = scoped.filter(x => x.name === "claim_queue_invocation_dispatch");
    assert.equal(cas.length, 1); assert.equal(cas[0].claimed, true);
    assert.ok(scoped.findIndex(x => x.name === "prepare_queue_invocation") >= 0 && scoped.findIndex(x => x.name === "prepare_queue_invocation") < scoped.indexOf(cas[0]), "RECOVERY_DISPATCH_BEFORE_PREPARE");
    const mutation = kind === "helpful_maintenance" ? "purge_ai_feedback_scoped" : "purge_worker_runtime_details_scoped";
    assert.equal(scoped.filter(x => x.name === mutation).length, 1, "RECOVERY_PURGE_REPEATED");
  }
  assert.equal(second.dispatchAckSha256, baseline.dispatchAckSha256, "ORIGINAL_STORAGE_DISPATCH_ACK_CHANGED");
  // Separate barrier: original UNKNOWN blocks new effects across another lost LISTEN/reconnect.
  await control("--unknown");
  const unknownBefore = await reconnectProof(), unknownSnapshot = await snapshot(), unknownEventOffset = events.length, unknownHelpful = helpfulCalls, unknownTraceSequence = (await trace()).at(-1).sequence;
  assert.equal((await invocation.getQueueInvocation(f.unknownId)).state, "unknown");
  await until(async () => (await reconnectProof()).queueBackends[0]?.idle === true, "UNKNOWN_SESSION_NOT_IDLE");
  await control("--disconnect-unknown");
  await until(async () => {
    const p = await reconnectProof();return p.queueBackends.length === 1 && p.queueBackends[0].pid !== newDbPid &&
      (await trace()).some(x => x.code === "LISTEN_VERIFIED" && x.databasePid === p.queueBackends[0].pid && x.channel === "yumidang_cancellation_due");
  }, "UNKNOWN_SAME_PROCESS_LISTEN_NOT_RESTORED", 25000);
  // 실제 HTTP 응답을 소비한 뒤 같은 복원 연결에서 두 SQL 예약과 두 HTTP 예약의
  // 성공 결과까지 읽었는지 확인한다. 요청 시작이나 오류 문자열은 종결 증거가 아니다.
  const barrierState: { value: ReturnType<typeof unknownReconnectBarrier> } = { value: null };
  await until(async () => {
    const proof = await reconnectProof();
    if (proof.queueBackends.length !== 1) return false;
    barrierState.value = unknownReconnectBarrier(await trace(), events.slice(unknownEventOffset), proof.queueBackends[0].pid, child.pid, unknownTraceSequence, unknownSnapshot.lease.expiresAt, proof.runtimeRetention, baseline.runtimeRetention.definitionSha256);
    return barrierState.value !== null;
  }, "UNKNOWN_ACTUAL_RESPONSE_AND_SCHEDULE_BARRIER_MISSING");
  const pendingBarrier = barrierState.value;
  assert.ok(pendingBarrier, "UNKNOWN_ACTUAL_BARRIER_REQUIRED");
  await Deno.writeTextFile(root + "/reconnect-unknown-barrier-private.json", JSON.stringify(pendingBarrier), { mode: 0o600, createNew: true });
  const unknownAfter = await reconnectProof(), final = await snapshot(), finalTrace = await trace();
  assert.ok(finalTrace.every(x => x.nodePid === child.pid), "UNKNOWN_RECOVERY_REPLACED_NODE_PROCESS");
  for (const channel of ["yumidang_worker_jobs", "yumidang_cancellation_due"]) assert.ok(finalTrace.some(x => x.code === "LISTEN_VERIFIED" && x.databasePid === unknownAfter.queueBackends[0].pid && x.channel === channel), "UNKNOWN_REAL_LISTEN_CHANNEL_MISSING");
  assert.equal(unknownAfter.unknownSha256, unknownBefore.unknownSha256, "ORIGINAL_UNKNOWN_MUTATED");
  assert.equal(unknownAfter.dispatchAckSha256, baseline.dispatchAckSha256, "ACK_CHANGED_ON_UNKNOWN_RECOVERY");
  assert.deepEqual(final.invocations, unknownSnapshot.invocations, "UNKNOWN_RECONNECT_CREATED_OR_CHANGED_INVOCATION");
  assert.deepEqual(final.lease, unknownSnapshot.lease, "ORIGINAL_UNKNOWN_LEASE_CHANGED");
  assert.equal(final.slots, unknownSnapshot.slots, "UNKNOWN_RECONNECT_CONSUMED_SLOT");
  assert.equal(helpfulCalls, unknownHelpful, "UNKNOWN_RECONNECT_RESENT_HELPFUL");
  assert.ok(events.slice(unknownEventOffset).every(x => !["prepare_queue_invocation", "claim_queue_invocation_dispatch", "purge_ai_feedback_scoped", "purge_worker_runtime_details_scoped", "execute_worker_runtime_operation"].includes(x.name)), "UNKNOWN_RECONNECT_DISPATCHED");
  await stop(running, pendingBarrier.hasFuture);
  assert.equal((await reconnectProof()).queueBackends.length, 0, "SIGTERM_DB_SESSION_REMAINED");
  assert.equal(externalCalls, 0);assert.equal(reviewCalls, 0);assert.equal(lost, false);
  const metadata = JSON.parse(await Deno.readTextFile(root + "/reconnect-static-manifest.json"));
  const receipt = { status: "PASS", scope: "ACTUAL_RUN_QUEUE_RUNNER_CLI_PG_LISTEN_RECONNECT_MAINTENANCE_ONLY", revision, manifest: metadata,
    sameNodePid: child.pid, oldDatabasePid: originalDbPid, reconnectedDatabasePid: newDbPid, finalDatabasePid: unknownAfter.queueBackends[0].pid,
    realDisconnects: 2, missedNotificationWhileDisconnected: true, listenStateVerifiedBySameRealConnection: true,
    scheduleRereadAfterListen: true, exactPurges: { helpful: 1, runtime: 1 }, casPerNewInvocation: 1,
    additionalQueueSlots: 0, originalUnknownFingerprintUnchanged: true, originalDispatchAckHashUnchanged: true,
    unknownReconnectNewIntentOrDispatch: 0, pendingResponseAndSameConnectionScheduleConsumed: true, pendingFutureMatchesOriginalLease: pendingBarrier.hasFuture, runtimeFutureCorrelatedToStoredResultRetention: true, sigtermExitCode: 0, externalDeleteAckRequests: 0,
    fullFiveKindsEffects: "NOT_RUN_SEPARATE_SCOPE", modelProviderRealMember: "NOT_RUN", sourceDatabaseChanged: false, operatingChanged: false };
  await Deno.writeTextFile(root + "/reconnect-provisional.json", JSON.stringify(receipt, null, 2), { mode: 0o600, createNew: true });
}

try {
  if (reconnectScenario) await runReconnectScenario();
  else {
  await control("--fixture");
  const tlsRole = JSON.parse(await Deno.readTextFile(root + "/tls-role-evidence.json"));
  assert.ok(Object.values(tlsRole).every(value => value === true), "TLS_MINIMUM_PRIVILEGE_EVIDENCE_REQUIRED");
  // Wait for actual schema reload/109 service grant, with no intent side effect.
  await until(async () => {
    try { await invocation.getQueueInvocation("00000000-0000-0000-0000-000000000000"); }
    catch (error) { return error instanceof HttpError && toPublicError(error).error.code === "RESOURCE_NOT_FOUND"; }
    return false;
  }, "ACTUAL_SQL109_HTTP_PREFLIGHT_FAILED");
  const first = launch("queue-a"), second = launch("queue-b");
  await until(async () => {
    const proof = await snapshot();
    return proof.helpfulRemaining === 0 && proof.runtimePurged === true && proof.invocations.filter((x: { state: string }) => x.state === "completed").length >= 2;
  }, "ACTUAL_CLI_MAINTENANCE_NOT_PROVEN");
  const proof = await snapshot();
  assert.equal(proof.queueSessions, 2, "TWO_PROCESS_COMPETITION_NOT_OBSERVED");
  assert.equal(lost, true, "HTTP_LOSS_NOT_INJECTED");
  assert.equal(helpfulCalls, 1, "HELPFUL_HTTP_RESENT");
  assert.equal(reviewCalls, 0, "DEFAULT_MEMBER_AI_CAPABILITY_ENABLED");
  assert.equal(proof.slots, 0, "MAINTENANCE_CONSUMED_QUEUE_JOB_SLOT");
  assert.equal(new Set(proof.invocations.map((x: { token: string }) => x.token)).size, 1, "COMPETITORS_CREATED_TWO_GLOBAL_CYCLES");
  for (const kind of ["helpful_maintenance", "runtime_maintenance"]) {
    const rows = proof.invocations.filter((x: { kind: string }) => x.kind === kind);
    assert.equal(rows.length, 1, "MAINTENANCE_DUPLICATE_INVOCATION");
    assert.equal(rows[0].state, "completed", "HTTP_WITHOUT_DATABASE_PROOF");
    assert.equal(rows[0].result.purged, 1, "ACTUAL_PURGE_RESULT_MISMATCH");
    const claims = events.filter(x => x.name === "claim_queue_invocation_dispatch" && x.requestId === rows[0].requestId);
    assert.equal(claims.length, 1, "DISPATCH_CAS_CALLED_MORE_THAN_ONCE");
    assert.equal(claims[0].claimed, true, "DISPATCH_CAS_NOT_WON");
    const prepareIndex = events.findIndex(x => x.name === "prepare_queue_invocation" && x.requestId === rows[0].requestId);
    assert.ok(prepareIndex >= 0 && prepareIndex < events.indexOf(claims[0]), "DISPATCH_BEFORE_DURABLE_PREPARE");
  }
  const helpful = proof.invocations.find((x: { kind: string }) => x.kind === "helpful_maintenance");
  assert.equal(events.filter(x => x.name === "purge_ai_feedback_scoped" && x.requestId === helpful.requestId).length, 1, "HELPFUL_OPERATION_REPLAYED");
  assert.ok(events.some(x => x.name === "get_worker_runtime_operation" && x.requestId === helpful.requestId), "RESPONSE_LOSS_NOT_READ_RECOVERED");
  await stop(first); await stop(second);
  await until(async () => (await snapshot()).lease.token === null, "GLOBAL_LEASE_NOT_RELEASED");
  // Persist an unproven intent before a fresh real CLI process starts. The CLI must
  // use pending/GET evidence and never resend helpful or begin a new request.
  await control("--unknown");
  const unknown = await invocation.getQueueInvocation(f.unknownId);
  assert.equal(unknown.state, "unknown");
  const beforeRestart = { events: events.length, helpfulCalls, rows: (await snapshot()).invocations.length };
  const restarted = launch("queue-restarted");
  await until(async () => (await snapshot()).queueSessions === 1, "REAL_CLI_RESTART_NOT_CONNECTED");
  await delay(1200);
  const afterRestart = await snapshot();
  assert.equal(afterRestart.invocations.length, beforeRestart.rows, "UNKNOWN_RESTART_CREATED_NEW_INTENT");
  assert.equal(helpfulCalls, beforeRestart.helpfulCalls, "UNKNOWN_RESTART_RESENT_HTTP");
  assert.ok(events.slice(beforeRestart.events).every(x => !["prepare_queue_invocation", "claim_queue_invocation_dispatch", "purge_ai_feedback_scoped", "execute_worker_runtime_operation", "purge_worker_runtime_details_scoped"].includes(x.name)), "UNKNOWN_RESTART_DISPATCHED");
  assert.ok(events.slice(beforeRestart.events).some(x => x.name === "read_worker_runtime_pending_v2"), "RESTART_DID_NOT_QUERY_REAL_PENDING_LEDGER");
  assert.equal(afterRestart.invocations.find((x: { requestId: string }) => x.requestId === f.unknownId).dispatchStarted, false);
  assert.equal((await invocation.getQueueInvocation(f.unknownId)).state, "unknown");
  await stop(restarted);
  assert.equal(externalCalls, 0, "EXTERNAL_CALL_OBSERVED");
  await control("--close");
  const receipt = {
    status: "PASS", scope: "ISOLATED_SQL109_HTTPS_ACTUAL_NODE_CLI", revision, productHelpfulHandler: true,
    approvedCaHttpsAndPgVerifyFull: true, independentNodeCliProcesses: 2, actualCliRestart: true,
    wrongCaHostAndPlaintextRejected: true, queueServiceRoleTableReadAndCreateDenied: true,
    durablePrepareBeforeFirstDispatch: true, casCalledOncePerCliInvocation: true,
    helpfulResponseLossStoredResultRecovery: true, helpfulHttpCalls: helpfulCalls,
    runtimeMaintenanceActualDetailsPurged: 1, maintenanceQueueJobSlots: 0,
    unknownRestartNewIntent: 0, unknownRestartDispatch: 0, memberModelCalls: reviewCalls,
    externalRequests: externalCalls, sourceDatabaseChanged: false, operatingChanged: false,
    fullFiveKinds: "NOT_RUN", realMemberLogin: "NOT_RUN",
  };
  await Deno.writeTextFile(root + "/receipt.json", JSON.stringify(receipt, null, 2), { mode: 0o600, createNew: true });
  console.log(JSON.stringify(receipt));
  }
} finally {
  for (const running of [...children]) {
    try { await stop(running); } catch { /* Preserve primary failure and process evidence. */ }
  }
  try { await control("--close"); } finally { await server.shutdown(); client.close(); }
}
