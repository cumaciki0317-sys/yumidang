import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { createSharedBackgroundQueueScheduler } from "../../../backend/supabase/functions/_shared/jobs/background.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRpcJobRepository, decodeSafetyJobPayload, type ClaimedJob, type JobRepository } from "../../../backend/supabase/functions/_shared/db/repositories/jobs.ts";
import { createSafetyConsumerRegistry, createRpcSafetyConsumerPorts, createSafetyWorkerInvocation, decodeReportRetentionTask, type SafetyConsumerPorts, type SafetyJournalIntent } from "../../../backend/supabase/functions/_shared/jobs/safety-consumers.ts";
import { runNextJob } from "../../../backend/supabase/functions/_shared/jobs/lease.ts";
import { decideRetry, JobExecutionUnknown } from "../../../backend/supabase/functions/_shared/jobs/retry.ts";
import { enqueueJob, enqueueSafetyDue } from "../../../backend/supabase/functions/_shared/jobs/enqueue.ts";
import { createWorkerScopedIntentRuntime } from "../../../backend/supabase/functions/_shared/db/worker-runtime-client.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
import type { RpcClient } from "../../../backend/supabase/functions/_shared/db/transport.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const claimJournal = { prepare: async () => {}, confirmed: async () => {}, unknown: async () => {} };
const job = (kind: "report_retention" | "cancellation_safety" = "report_retention"): ClaimedJob => ({ jobId: id(1), leaseToken: id(2), leaseUntil: "2099-01-01T00:00:00Z", failedAttempts: 0,
  reference: kind === "report_retention" ? { kind, reportId: id(3), closureProofId: id(4) } : { kind, identityId: id(3), generation: 7 } });
const task = () => ({ taskId: id(5), taskLeaseToken: id(6), taskExpiresAt: "2098-01-01T00:00:00Z", reportId: id(3), closureRevision: 1, kind: "report_metadata", assetId: null, bucketId: null, objectName: null, objectId: null, retentionDueAt: "2026-01-01T00:00:00Z", closureProofId: id(4) });
// 실제 SQL114 SDK를 사용하되 DB는 모형이다. 실제 SQL 권한·트랜잭션 검증을 대신하지 않는다.
function scopedFixture(options: {
  result?: (operation: string, input: Record<string, JsonValue>) => JsonValue | undefined;
  lost?: string; missing?: string; reject?: string; falseConfirmation?: boolean; scopeMismatch?: boolean; prepareFail?: boolean;
  afterExecute?: () => void; globalToken?: string;
} = {}) {
  const globalToken = options.globalToken ?? id(8), parentRequestId = id(16);
  const calls: { name: string; args: Record<string, JsonValue> }[] = [];
  const intents = new Map<string, Record<string, JsonValue>>(), results = new Map<string, Record<string, JsonValue>>();
  const operations: { requestId: string; operation: string; input: Record<string, JsonValue>; predecessor: JsonValue }[] = [];
  const confirmed: string[] = [], unknown: string[] = [];
  const db: RpcClient = { async rpc(name, args) {
    calls.push({ name, args: structuredClone(args) });
    const key = String(args.p_request_id);
    if (name === "prepare_worker_invocation_intent") {
      assert.equal(args.p_parent_invocation_id, parentRequestId);
      if (options.prepareFail) throw new Error("durable prepare unavailable");
      const prior = intents.get(key);
      if (prior) { assert.deepEqual(prior.scope, args.p_scope); assert.equal(prior.operation, args.p_operation); }
      else intents.set(key, { ticket: key, requestId: key, globalToken, operation: args.p_operation, parentTicket: null, scope: structuredClone(args.p_scope), state: "prepared" });
      return { ticket: key, state: prior?.state ?? "prepared", fresh: !prior };
    }
    if (name === "execute_worker_invocation_operation") {
      const intent = intents.get(key); assert.ok(intent); assert.equal(args.p_parent_request_id, parentRequestId); assert.equal(args.p_global_token, globalToken);
      assert.equal(args.p_operation, intent.operation); assert.deepEqual(args.p_input, intent.scope);
      assert.equal(operations.some(o => o.requestId === key), false);
      const prepared = calls.find(c => c.name === "prepare_worker_invocation_intent" && c.args.p_request_id === key)!;
      const op = String(args.p_operation), input = args.p_input as Record<string, JsonValue>;
      operations.push({ requestId: key, operation: op, input: structuredClone(input), predecessor: prepared.args.p_predecessor_request_id });
      if (options.reject === op) throw new Error("DB fence rejected without stored result");
      const result = options.result?.(op, input) ?? (op === "job_claim" ? { job: null } : op === "due_enqueue" ? { enqueued: 1 } : op === "cancellation_process" ? { status: "applied", generation: 7, changed: true } : op === "report_task_claim" ? savedTask(task()) : op === "report_storage" ? { taskId: input.taskId, dispatchId: id(14), alreadyApplied: false } : op === "report_storage_ack" ? { receiptId: id(15), taskId: input.taskId, assetId: id(11), objectId: input.objectId, ackSha256: input.ackSha256 } : op === "report_task_complete" ? { taskId: input.taskId, status: "completed", alreadyApplied: false } : { jobId: input.jobId, status: input.status });
      const out = { requestId: key, state: op === "report_storage" ? "external_pending" : "completed", result, closedAt: op === "report_storage" ? null : "2026-10-09T00:00:00Z", replayed: false };
      if (options.missing !== op) results.set(key, out);
      options.afterExecute?.();
      if (options.lost === op) throw new Error("response lost");
      return out;
    }
    if (name === "get_worker_runtime_intent") {
      const row = intents.get(key); assert.ok(row);
      return options.scopeMismatch ? { ...structuredClone(row), scope: { ...(row.scope as Record<string, JsonValue>), jobLeaseToken: id(99) } } : structuredClone(row);
    }
    if (name === "get_worker_runtime_operation") { const row = results.get(key); if (!row) throw new Error("stored result unavailable"); return { ...row, replayed: true }; }
    if (name === "confirm_worker_runtime_intent") {
      const row = intents.get(key); assert.ok(row); assert.ok(results.has(key));
      if (row.operation === "report_storage") assert.ok(operations.some(o => o.operation === "report_task_complete" && o.input.taskId === (row.scope as Record<string, JsonValue>).taskId));
      if (options.falseConfirmation) return { ticket: id(99), state: "confirmed" };
      row.state = "confirmed"; confirmed.push(key); return { ticket: key, state: "confirmed" };
    }
    if (name === "observe_worker_runtime_intent") { unknown.push(key); const row = intents.get(key); assert.ok(row); row.state = "unknown"; return { ticket: key, state: "unknown" }; }
    assert.fail("mutable raw RPC or unexpected DB call: " + name);
  } };
  return { db, atomic: createWorkerScopedIntentRuntime(db, { parentRequestId, globalToken }), calls, operations, confirmed, unknown, intents };
}
function savedTask(t: ReturnType<typeof task> | Record<string, JsonValue>): JsonValue { const { bucketId: _bucket, objectName: _name, ...saved } = t; return saved; }
function wireJob(j: ClaimedJob): JsonValue {
  const { kind, ...payload } = j.reference;
  return { job: { jobId: j.jobId, leaseToken: j.leaseToken, leaseExpiresAt: j.leaseUntil, attempt: 1, failedAttempts: 0, kind, payload } };
}
const forbiddenRaw = { rpc: async () => assert.fail("mutable raw RPC must remain unused") };
function scopedRepository(f: ReturnType<typeof scopedFixture>, signal = new AbortController().signal) {
  return createRpcJobRepository(forbiddenRaw, { workerRunToken: f.atomic.globalToken, signal, atomicInvocation: f.atomic });
}
// 소비자 자체의 순수 단위 모형이다. 이 no-op journal은 실제 factory 준비조건을 충족하지 않는다.
function fixture() {
  const intents: SafetyJournalIntent[] = [], unknown: string[] = [], events: string[] = [];
  let remaining = 10;
  const ports: SafetyConsumerPorts = {
    readiness: { scopedClaim: true, sharedBudgetContract: true, durableJournalContract: true, cancellationGuardAndAcl: true, reportGuardAndAcl: true, reportTerminalScheduleContract: true, storageProviderApproved: true },
    budget: { globalToken: id(8), signal: new AbortController().signal, elapsed: () => 0, readRemaining: async () => ({ remainingMs: 10000 }), reserveItem: async () => true, hasItemCapacity: () => true, reserve: async () => remaining-- > 0 },
    journal: { prepare: async i => { intents.push(i); events.push("journal"); }, unknown: async i => { unknown.push(i); }, confirmed: async () => { events.push("confirmed"); } },
    cancellationProcess: async () => { events.push("process"); return { status: "applied", generation: 7, changed: true }; },
    reportClaim: async () => { events.push("claim"); return task(); },
    reportStorage: async () => { throw new Error("storage must not run for metadata"); }, metadataEvidence: async () => "a".repeat(64),
    reportComplete: async ({ task: t }) => { events.push("complete"); return { taskId: t.taskId, status: "completed", alreadyApplied: false }; },
  };
  return { ports, intents, unknown, events };
}
function runner(j: ClaimedJob, registry: ReturnType<typeof createSafetyConsumerRegistry>) {
  const settlements: unknown[] = [];
  const repository: JobRepository = { claim: async () => j, enqueue: async () => { throw new Error(); }, settle: async i => { settlements.push(i); return "applied"; } };
  return { settlements, run: () => runNextJob({ workerId: id(9), repository, registry, settings: { leaseDurationMs: 60000, retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 } }, now: () => new Date("2026-10-07T00:00:00Z") }) };
}
test("exact safety payload rejects overflow, zero, extra key and unrelated UUID", () => {
  assert.equal(decodeSafetyJobPayload("cancellation_safety", { identityId: id(1), generation: Number.MAX_SAFE_INTEGER }).kind, "cancellation_safety");
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => decodeSafetyJobPayload("cancellation_safety", { identityId: id(1), generation }));
  assert.throws(() => decodeSafetyJobPayload("report_retention", { reportId: id(1), closureProofId: id(2), text: "secret" }));
});
test("scoped claim supplies only requested supported kind and original global token", async () => {
  const f = scopedFixture(), repo = scopedRepository(f);
  assert.equal(await repo.claim({ workerId: id(9), kinds: ["report_retention"], leaseDurationMs: 180000 }), null);
  assert.deepEqual(f.operations.map(o => o.input), [{ workerId: id(9), leaseSeconds: 180, supportedKinds: ["report_retention"] }]);
  assert.equal(f.confirmed.length, 1);
  await assert.rejects(repo.claim({ workerId: id(9), kinds: ["report_retention", "event_sync"], leaseDurationMs: 180000 }));
  assert.equal(f.operations.length, 1);
});
test("claim response loss without stored proof is UNKNOWN and cannot enter retry policy", async () => {
  const f = scopedFixture({ lost: "job_claim", missing: "job_claim" }), repo = scopedRepository(f);
  await assert.rejects(repo.claim({ workerId: id(9), kinds: ["cancellation_safety"], leaseDurationMs: 180000 }), JobExecutionUnknown);
  assert.equal(f.operations.length, 1); assert.equal(f.confirmed.length, 0); assert.ok(f.unknown.length > 0);
  assert.throws(() => decideRetry({ failedAttempts: 0, now: new Date(), error: new JobExecutionUnknown("claim"), settings: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } }), JobExecutionUnknown);
});
test("claim response loss with exact stored proof is recovered by GET without resend", async () => {
  const f = scopedFixture({ lost: "job_claim" });
  assert.equal(await scopedRepository(f).claim({ workerId: id(9), kinds: ["report_retention"], leaseDurationMs: 180000 }), null);
  assert.equal(f.operations.length, 1); assert.equal(f.confirmed.length, 1); assert.equal(f.unknown.length, 0);
});
test("pending contracts leave new consumers unregistered", () => {
  const f = fixture();
  assert.deepEqual(createSafetyConsumerRegistry({ ...f.ports, readiness: { ...f.ports.readiness, sharedBudgetContract: false } }), {});
});
test("metadata complete does not issue duplicate parent settlement", async () => {
  const f = fixture(), r = runner(job(), createSafetyConsumerRegistry(f.ports));
  assert.equal((await r.run()).status, "succeeded"); assert.deepEqual(r.settlements, []);
  assert.deepEqual(f.events, ["journal", "claim", "confirmed", "journal", "complete", "confirmed"]);
  assert.equal(f.intents[1].evidenceSha256, "a".repeat(64));
  assert.equal(JSON.stringify(f.intents).includes("objectName"), false);
});
test("metadata response lost preserves original intent and forbids settle", async () => {
  const f = fixture(); f.ports.reportComplete = async () => { throw new Error("lost"); };
  const r = runner(job(), createSafetyConsumerRegistry(f.ports));
  await assert.rejects(r.run(), JobExecutionUnknown); assert.deepEqual(r.settlements, []);
  assert.equal(f.unknown.length, 1); assert.equal(f.intents.length, 2);
});
test("journal failure stops before any mutative process", async () => {
  const f = fixture(); f.ports.journal!.prepare = async () => { throw new Error("disk unavailable"); };
  const r = runner(job("cancellation_safety"), createSafetyConsumerRegistry(f.ports));
  await assert.rejects(r.run(), JobExecutionUnknown); assert.deepEqual(r.settlements, []); assert.deepEqual(f.events, []);
});
test("policy_pending is held without fabricated completion/retry", async () => {
  const f = fixture(); f.ports.cancellationProcess = async () => ({ status: "policy_pending", generation: 7, changed: false });
  const r = runner(job("cancellation_safety"), createSafetyConsumerRegistry(f.ports));
  assert.equal((await r.run()).status, "held"); assert.deepEqual(r.settlements, []);
});
test("exhausted shared budget starts neither claim nor process", async () => {
  const f = fixture(); f.ports.budget.reserve = async () => false;
  const r = runner(job(), createSafetyConsumerRegistry(f.ports));
  assert.equal((await r.run()).status, "held"); assert.deepEqual(f.events, []); assert.deepEqual(r.settlements, []);
});
test("task decode rejects changed proof, extra field, incorrect metadata object", () => {
  assert.throws(() => decodeReportRetentionTask({ ...task(), closureProofId: id(10) }, job()));
  assert.throws(() => decodeReportRetentionTask({ ...task(), original: "text" }, job()));
  assert.throws(() => decodeReportRetentionTask({ ...task(), objectId: id(10) }, job()));
});
test("generic safety enqueue is blocked and dedicated port preserves exact count", async () => {
  await assert.rejects(enqueueJob({ enqueue: async () => { throw new Error("must not call"); } } as unknown as JobRepository, job("cancellation_safety").reference, "2026-10-07T00:00:00Z"), /DEDICATED/);
  assert.deepEqual(await enqueueSafetyDue({ enqueueCancellation: async () => ({ enqueued: 2 }), enqueueReportRetention: async () => { throw new Error(); } }, "cancellation_safety", 3, id(8), new AbortController().signal), { enqueued: 2 });
});

test("legacy journal without atomic invocation fails before scoped DB claim", async () => {
  let calls = 0;
  const repo = createRpcJobRepository({ rpc: async () => { calls++; return { job: null }; } }, { workerRunToken: id(8), claimJournal, signal: new AbortController().signal });
  await assert.rejects(repo.claim({ workerId: id(9), kinds: ["report_retention"], leaseDurationMs: 180000 }), /ATOMIC_INVOCATION_REQUIRED/);
  assert.equal(calls, 0);
});
test("Storage UNKNOWN does not settle, reclaim or automatically DELETE again", async () => {
  const f = fixture(); let deletes = 0;
  f.ports.reportClaim = async () => ({ ...task(), kind: "storage_object", assetId: id(11), objectId: id(12), bucketId: "report-evidence", objectName: id(13) + "/" + id(11) + ".jpg" });
  f.ports.reportStorage = async () => { deletes++; throw new JobExecutionUnknown("process"); };
  const r = runner(job(), createSafetyConsumerRegistry(f.ports));
  await assert.rejects(r.run(), JobExecutionUnknown);
  assert.equal(deletes, 1); assert.equal(f.intents.length, 2); assert.deepEqual(r.settlements, []);
});

test("late success after abort remains UNKNOWN and never confirms/settles", async () => {
  const f = fixture(), abort = new AbortController();
  f.ports.cancellationProcess = async () => { abort.abort(); return { status: "applied", generation: 7, changed: true }; };
  const ports = { ...f.ports, budget: { ...f.ports.budget, signal: abort.signal } };
  const r = runner(job("cancellation_safety"), createSafetyConsumerRegistry(ports));
  await assert.rejects(r.run(), JobExecutionUnknown); assert.deepEqual(r.settlements, []);
  assert.equal(f.events.includes("confirmed"), false); assert.equal(f.intents.length, 1);
});
test("journal confirmation failure after successful process is UNKNOWN", async () => {
  const f = fixture(); f.ports.journal!.confirmed = async () => { throw new Error("disk confirmation lost"); };
  const r = runner(job("cancellation_safety"), createSafetyConsumerRegistry(f.ports));
  await assert.rejects(r.run(), JobExecutionUnknown); assert.deepEqual(r.settlements, []); assert.equal(f.unknown.length, 1);
});
test("zero DB budget yields held before dispatch", async () => {
  const f = fixture(); f.ports.budget.readRemaining = async () => ({ remainingMs: 0 });
  const r = runner(job(), createSafetyConsumerRegistry(f.ports));
  assert.equal((await r.run()).status, "held"); assert.deepEqual(f.events, []);
});

test("false DB confirmation after valid claim is UNKNOWN and never accepted", async () => {
  const f = scopedFixture({ falseConfirmation: true });
  await assert.rejects(scopedRepository(f).claim({ workerId: id(9), kinds: ["report_retention"], leaseDurationMs: 180000 }), JobExecutionUnknown);
  assert.equal(f.operations.length, 1); assert.equal(f.confirmed.length, 0); assert.ok(f.unknown.length > 0);
});
test("scoped claim ignores late valid DB result after parent abort", async () => {
  const abort = new AbortController(), f = scopedFixture({ afterExecute: () => abort.abort(), result: () => wireJob(job()) });
  const repo = scopedRepository(f, abort.signal);
  await assert.rejects(repo.claim({ workerId: id(9), kinds: ["report_retention"], leaseDurationMs: 180000 }), JobExecutionUnknown);
  assert.ok(f.unknown.length > 0); assert.equal(f.operations.filter(o => o.operation === "job_settlement").length, 0);
  assert.equal(f.operations.filter(o => o.operation === "job_claim").length, 1);
});
test("cancellation settlement binds original job fence and requires exact DB confirmation", async () => {
  const j = job("cancellation_safety"), f = scopedFixture({ result: (op, input) => op === "job_claim" ? wireJob(j) : { jobId: input.jobId, status: input.status } });
  const repo = scopedRepository(f);
  await repo.claim({ workerId: id(9), kinds: ["cancellation_safety"], leaseDurationMs: 180000 });
  assert.equal(await repo.settle({ jobId: j.jobId, leaseToken: j.leaseToken, status: "succeeded" }), "applied");
  assert.deepEqual(f.operations[1].input, { jobId: j.jobId, jobLeaseToken: j.leaseToken, status: "succeeded" });
  assert.equal(f.confirmed.length, 2);
  const lost = scopedFixture({ reject: "job_settlement", result: () => wireJob(j) }), lostRepo = scopedRepository(lost);
  await lostRepo.claim({ workerId: id(9), kinds: ["cancellation_safety"], leaseDurationMs: 180000 });
  await assert.rejects(lostRepo.settle({ jobId: j.jobId, leaseToken: j.leaseToken, status: "succeeded" }), JobExecutionUnknown);
  assert.equal(lost.operations.filter(o => o.operation === "job_settlement").length, 1); assert.ok(lost.unknown.length > 0);
});

const runtimeConfig = (timeout = "1000") => loadRuntimeConfig(k => ({ SUPABASE_URL: "https://project.example.test", SUPABASE_ANON_KEY: "anon-fixture", SUPABASE_SERVICE_ROLE_KEY: "service-fixture", INTERNAL_WORKER_SECRET: "internal_fixture_secret_more_than_32_chars", ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: timeout } as Record<string, string>)[k]);
// REST 모형에는 조회만 허용한다. 변경은 위 SDK의 scoped execute 한 경로로만 전달한다.
function readonlyFetch(t = task(), calls: { name: string; body: Record<string, unknown> }[] = []) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const name = String(url).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body)); calls.push({ name, body });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer service-fixture");
    assert.equal(new Headers(init?.headers).get("apikey"), "service-fixture");
    assert.ok(init?.signal instanceof AbortSignal);
    if (name === "read_worker_run_budget") { assert.deepEqual(body, { p_worker_run_token: id(8) }); return Response.json({ remainingMs: 10000 }); }
    if (name === "check_report_retention_task") {
      assert.deepEqual(body, { p_task_id: t.taskId, p_task_lease_token: t.taskLeaseToken, p_job_id: id(1), p_job_lease_token: id(2), p_global_token: id(8), p_object_id: t.objectId });
      return Response.json(t);
    }
    assert.fail("mutable raw REST RPC: " + name);
  };
}
test("actual RPC factory has no creation side effect and metadata chain uses exact original fences", async () => {
  const f = fixture(), scoped = scopedFixture(), calls: { name: string; body: Record<string, unknown> }[] = [];
  const wired = createRpcSafetyConsumerPorts(runtimeConfig(), { readiness: f.ports.readiness, budget: f.ports.budget, atomicInvocation: scoped.atomic }, readonlyFetch(task(), calls));
  assert.equal(calls.length + scoped.calls.length, 0);
  const r = runner(job(), createSafetyConsumerRegistry(wired.consumers));
  assert.equal((await r.run()).status, "succeeded"); assert.deepEqual(r.settlements, []);
  assert.deepEqual(calls.map(c => c.name), ["read_worker_run_budget", "check_report_retention_task", "read_worker_run_budget"]);
  assert.deepEqual(scoped.operations.map(o => o.operation), ["report_task_claim", "report_task_complete"]);
  assert.deepEqual(scoped.operations[0].input, { jobId: id(1), jobLeaseToken: id(2) });
  const complete = scoped.operations[1];
  assert.deepEqual(Object.keys(complete.input).sort(), ["taskId", "taskLeaseToken", "jobId", "jobLeaseToken", "objectId", "evidenceSha256"].sort());
  assert.equal(complete.input.objectId, null); assert.match(String(complete.input.evidenceSha256), /^[a-f0-9]{64}$/);
  assert.equal(complete.predecessor, null); assert.equal(scoped.confirmed.length, 2);
});
test("actual cancellation and dedicated enqueue bind original global token through scoped SDK", async () => {
  const f = fixture(), scoped = scopedFixture();
  const w = createRpcSafetyConsumerPorts(runtimeConfig(), { readiness: f.ports.readiness, budget: f.ports.budget, atomicInvocation: scoped.atomic }, readonlyFetch());
  await w.consumers.cancellationProcess({ identityId: id(3), generation: 7, jobId: id(1), jobLeaseToken: id(2), globalToken: id(8) }, f.ports.budget.signal);
  await enqueueSafetyDue(w.dueEnqueue, "cancellation_safety", 2, id(8), f.ports.budget.signal);
  await enqueueSafetyDue(w.dueEnqueue, "report_retention", 2, id(8), f.ports.budget.signal);
  assert.deepEqual(scoped.operations.map(o => o.input), [
    { identityId: id(3), generation: 7, jobId: id(1), jobLeaseToken: id(2) },
    { kind: "cancellation_safety", limit: 2 }, { kind: "report_retention", limit: 2 },
  ]);
  assert.equal(scoped.confirmed.length, 3);
  await assert.rejects(enqueueSafetyDue(w.dueEnqueue, "report_retention", 2, id(18), f.ports.budget.signal));
  assert.equal(scoped.operations.length, 3);
});
test("legacy no-op journal does not enable actual RPC factory or mutable calls", () => {
  const f = fixture(); let calls = 0;
  const wired = createRpcSafetyConsumerPorts(runtimeConfig(), { readiness: f.ports.readiness, budget: f.ports.budget, journal: f.ports.journal }, async () => { calls++; assert.fail("no transport"); });
  assert.equal(wired.consumers.readiness.durableJournalContract, false);
  assert.deepEqual(createSafetyConsumerRegistry(wired.consumers), {}); assert.equal(calls, 0);
});
test("changed full intent scope and changed transient task proof are UNKNOWN without completion", async () => {
  for (const mismatch of ["scope", "task"] as const) {
    const f = fixture(), scoped = scopedFixture({ scopeMismatch: mismatch === "scope" });
    const wired = createRpcSafetyConsumerPorts(runtimeConfig(), { readiness: f.ports.readiness, budget: f.ports.budget, atomicInvocation: scoped.atomic }, readonlyFetch({ ...task(), closureProofId: mismatch === "task" ? id(99) : id(4) }));
    const r = runner(job(), createSafetyConsumerRegistry(wired.consumers));
    await assert.rejects(r.run(), JobExecutionUnknown); assert.deepEqual(r.settlements, []);
    assert.deepEqual(scoped.operations.map(o => o.operation), ["report_task_claim"]);
    assert.ok(scoped.unknown.length > 0);
    if (mismatch === "scope") assert.equal(scoped.confirmed.length, 0);
  }
});
test("actual durable prepare failure stops before a cancellation effect", async () => {
  const f = fixture(), scoped = scopedFixture({ prepareFail: true });
  const wired = createRpcSafetyConsumerPorts(runtimeConfig(), { readiness: f.ports.readiness, budget: f.ports.budget, atomicInvocation: scoped.atomic }, readonlyFetch());
  const r = runner(job("cancellation_safety"), createSafetyConsumerRegistry(wired.consumers));
  await assert.rejects(r.run(), JobExecutionUnknown);
  assert.equal(scoped.operations.length, 0); assert.equal(scoped.confirmed.length, 0); assert.deepEqual(r.settlements, []);
});
test("actual metadata response loss uses original GET proof or preserves UNKNOWN without settlement", async () => {
  for (const missing of [false, true]) {
    const f = fixture(), scoped = scopedFixture({ lost: "report_task_complete", missing: missing ? "report_task_complete" : undefined });
    const wired = createRpcSafetyConsumerPorts(runtimeConfig(), { readiness: f.ports.readiness, budget: f.ports.budget, atomicInvocation: scoped.atomic }, readonlyFetch());
    const r = runner(job(), createSafetyConsumerRegistry(wired.consumers));
    if (missing) { await assert.rejects(r.run(), JobExecutionUnknown); assert.ok(scoped.unknown.length > 0); }
    else { assert.equal((await r.run()).status, "succeeded"); assert.equal(scoped.unknown.length, 0); }
    assert.deepEqual(r.settlements, []);
    const complete = scoped.operations.filter(o => o.operation === "report_task_complete"); assert.equal(complete.length, 1);
    assert.ok(scoped.calls.some(c => c.name === "get_worker_runtime_operation" && c.args.p_request_id === complete[0].requestId));
    assert.equal(scoped.confirmed.includes(complete[0].requestId), !missing);
  }
});
function storageChain(options: { lost?: string; missing?: string } = {}) {
  const f = fixture(), j = job(); let deleted = false, ack: JsonValue = null, deletes = 0;
  const storageTask = { ...task(), kind: "storage_object", assetId: id(11), objectId: id(12), bucketId: "report-evidence", objectName: id(13) + "/" + id(11) + ".jpg" };
  const scoped = scopedFixture({ ...options, result: (op, input) => {
    if (op === "report_storage_ack") { ack = { receiptId: id(15), taskId: id(5), assetId: id(11), objectId: id(12), ackSha256: input.ackSha256 }; return ack; }
  } });
  const w = createRpcSafetyConsumerPorts(runtimeConfig(), { readiness: f.ports.readiness, budget: f.ports.budget, atomicInvocation: scoped.atomic }, async (url, init) => {
    const path = new URL(String(url)).pathname, name = path.split("/").at(-1);
    if (path.startsWith("/rest/")) {
      const body = JSON.parse(String(init?.body));
      if (name === "check_report_retention_task" || name === "get_report_retention_delete_ack") {
        assert.deepEqual(body, { p_task_id: id(5), p_task_lease_token: id(6), p_job_id: id(1), p_job_lease_token: id(2), p_global_token: id(8), p_object_id: id(12) });
        return Response.json(name === "check_report_retention_task" ? storageTask : ack);
      }
      assert.fail("mutable raw Storage RPC: " + name);
    }
    if (init?.method === "DELETE") { deletes++; deleted = true; return Response.json([{ id: id(12), name: storageTask.objectName, bucket_id: "report-evidence" }]); }
    if (deleted) return new Response(null, { status: 404 });
    return Response.json({ id: id(12), name: storageTask.objectName, bucket_id: "report-evidence", content_type: "image/jpeg", size: 200 });
  });
  return { scoped, w, j, t: decodeReportRetentionTask(storageTask, j), signal: f.ports.budget.signal, deletes: () => deletes };
}
test("actual Storage adapter sends one DELETE and binds BEGIN ACK completion predecessor chain", async () => {
  const f = storageChain(), first = await f.w.consumers.reportStorage(f.t, f.j, f.signal);
  assert.match(first.evidenceSha256, /^[a-f0-9]{64}$/); assert.equal(f.deletes(), 1);
  const [begin, ack] = f.scoped.operations;
  assert.equal(begin.operation, "report_storage"); assert.equal(ack.operation, "report_storage_ack"); assert.equal(ack.predecessor, begin.requestId);
  assert.deepEqual(begin.input, { taskId: id(5), taskLeaseToken: id(6), jobId: id(1), jobLeaseToken: id(2), objectId: id(12) });
  assert.deepEqual(ack.input, { ...begin.input, ackSha256: ack.input.ackSha256 }); assert.match(String(ack.input.ackSha256), /^[a-f0-9]{64}$/);
  assert.equal(f.scoped.confirmed.includes(begin.requestId), false);
  await f.w.consumers.reportComplete({ task: f.t, jobId: id(1), jobLeaseToken: id(2), globalToken: id(8), evidenceSha256: first.evidenceSha256 }, f.signal);
  const complete = f.scoped.operations[2]; assert.equal(complete.predecessor, ack.requestId); assert.equal(complete.input.evidenceSha256, first.evidenceSha256);
  assert.deepEqual(f.scoped.confirmed, [ack.requestId, complete.requestId, begin.requestId]);
  await assert.rejects(f.w.consumers.reportStorage(f.t, f.j, f.signal));
  assert.equal(f.deletes(), 1); assert.equal(f.scoped.operations.length, 3);
});
test("lost Storage BEGIN never authorizes DELETE and lost ACK never authorizes a new chain", async () => {
  const begin = storageChain({ lost: "report_storage" });
  await assert.rejects(begin.w.consumers.reportStorage(begin.t, begin.j, begin.signal));
  assert.equal(begin.deletes(), 0); assert.equal(begin.scoped.operations.length, 1); assert.equal(begin.scoped.confirmed.length, 0);
  const ack = storageChain({ lost: "report_storage_ack", missing: "report_storage_ack" });
  await assert.rejects(ack.w.consumers.reportStorage(ack.t, ack.j, ack.signal));
  assert.equal(ack.deletes(), 1); assert.ok(ack.scoped.unknown.length > 0);
  await assert.rejects(ack.w.consumers.reportStorage(ack.t, ack.j, ack.signal));
  assert.equal(ack.deletes(), 1); assert.equal(ack.scoped.operations.length, 2); assert.equal(ack.scoped.confirmed.length, 0);
});
test("actual RPC factory bounds readonly transport that ignores its own AbortSignal", async () => {
  const f = fixture(), scoped = scopedFixture(); let calls = 0;
  const w = createRpcSafetyConsumerPorts(runtimeConfig("5"), { readiness: f.ports.readiness, budget: f.ports.budget, atomicInvocation: scoped.atomic }, async () => { calls++; return new Promise<Response>(() => {}); });
  await assert.rejects(w.consumers.reportClaim({ jobId: id(1), jobLeaseToken: id(2), globalToken: id(8) }, f.ports.budget.signal), JobExecutionUnknown);
  assert.equal(calls, 1); assert.equal(scoped.operations.length, 1); assert.equal(scoped.confirmed.length, 1);
});
function workerChain(kind: "cancellation_safety" | "report_retention", conflict?: "generation" | "fence", globalToken = id(8), idle = false) {
  const f = fixture(), calls: string[] = [], reservations: { token: string; operation: string }[] = [], items: unknown[] = [];
  const j = job(kind), reject = conflict ? kind === "cancellation_safety" ? "cancellation_process" : "report_task_claim" : undefined;
  const scoped = scopedFixture({ globalToken, reject, result: (op) => op === "job_claim" ? idle ? { job: null } : wireJob(j) : op === "due_enqueue" ? { enqueued: idle ? 0 : 1 } : undefined });
  const invoke = createSafetyWorkerInvocation(runtimeConfig(), { readiness: f.ports.readiness, atomicInvocation: scoped.atomic,
    allocate: () => ({ maxJobsPerRun: 1, enqueueLimit: 1 }), reserveItem: async (token, item) => {
      assert.equal(token, globalToken); assert.equal(item.jobId, j.jobId);
      // 부모 claim의 DB 확인 증거가 없는 예약을 성공으로 만들지 않는다.
      assert.ok(scoped.operations.some(o => o.operation === "job_claim" && scoped.confirmed.includes(o.requestId))); items.push(item); return true;
    }, reserve: async (token, operation) => { reservations.push({ token, operation }); return true; }, elapsed: () => 0, workerId: id(9), jobLeaseDurationMs: 180000,
    retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 }, now: () => new Date("2026-10-07T00:00:00Z") }, async (url, init) => {
      const name = String(url).split("/").at(-1)!; calls.push(name);
      const body = JSON.parse(String(init?.body));
      if (name === "read_worker_run_budget") { assert.deepEqual(body, { p_worker_run_token: globalToken }); return Response.json({ remainingMs: 10000 }); }
      if (name === "check_report_retention_task") { assert.equal(body.p_global_token, globalToken); assert.equal(body.p_job_id, j.jobId); assert.equal(body.p_job_lease_token, j.leaseToken); return Response.json(task()); }
      assert.fail("mutable raw RPC: " + name);
    });
  return { calls, scoped, items, reservations, invoke, input: { limit: 20, remainingMs: 10000, signal: new AbortController().signal } };
}
test("complete cancellation chain uses scoped enqueue claim process and DB confirmed settlement", async () => {
  const f = workerChain("cancellation_safety"), r = await f.invoke(id(8), "cancellation_safety", f.input);
  assert.equal(r.status, "ran"); if (r.status !== "ran") throw new Error();
  assert.deepEqual(r.counts, { claimed: 1, succeeded: 1, held: 0, leaseLost: 0, processedItems: 1 });
  assert.deepEqual(f.scoped.operations.map(o => o.operation), ["due_enqueue", "job_claim", "cancellation_process", "job_settlement"]);
  assert.equal(f.scoped.confirmed.length, 4); assert.deepEqual(f.items, [{ kind: "cancellation_safety", jobId: id(1) }]);
  assert.deepEqual(f.scoped.operations[3].input, { jobId: id(1), jobLeaseToken: id(2), status: "succeeded" });
});
test("complete report chain performs metadata completion exactly once with parent settlement0", async () => {
  const f = workerChain("report_retention"), r = await f.invoke(id(8), "report_retention", f.input);
  assert.equal(r.status, "ran"); if (r.status !== "ran") throw new Error();
  assert.equal(r.counts.succeeded, 1); assert.equal(r.counts.processedItems, 1);
  assert.deepEqual(f.scoped.operations.map(o => o.operation), ["due_enqueue", "job_claim", "report_task_claim", "report_task_complete"]);
  assert.equal(f.scoped.confirmed.length, 4); assert.deepEqual(f.items, [{ kind: "report_retention", jobId: id(1) }]);
});
for (const [kind, conflict] of [["cancellation_safety", "generation"], ["report_retention", "fence"]] as const) {
  test(`server rejects stale ${conflict} without stored proof and preserves UNKNOWN without retry`, async () => {
    const f = workerChain(kind, conflict);
    await assert.rejects(f.invoke(id(8), kind, f.input), JobExecutionUnknown);
    assert.ok(f.scoped.unknown.length > 0);
    assert.equal(f.scoped.operations.some(o => ["job_settlement", "report_task_complete"].includes(o.operation)), false);
    assert.equal(f.scoped.operations.filter(o => o.operation === (kind === "cancellation_safety" ? "cancellation_process" : "report_task_claim")).length, 1);
    assert.equal(f.scoped.confirmed.length, 2);
  });
}
test("shared scheduler dispatch reaches actual scoped SDK and uses DB slot and terminal proof", async () => {
  const f = workerChain("report_retention"); let due = true, released = 0, invoked = 0, confirmed = 0;
  const scheduler = createSharedBackgroundQueueScheduler({
    supportedKinds: ["report_retention"], queryTimeoutMs: 1000,
    repository: {
      schedule: async () => ({ serverNow: "2026-10-07T00:00:00Z", nextDueAt: due ? "2026-10-07T00:00:00Z" : null, nextKind: due ? "report_retention" : null }),
      acquire: async () => ({ token: id(8), expiresAt: "2026-10-07T00:03:00Z" }), release: async () => { assert.equal(confirmed, 1); released++; return "applied"; },
    },
    invoke: async (token: string, kind: "report_retention", options: typeof f.input & { requestId: string }) => {
      assert.equal(options.requestId, f.scoped.atomic.parentRequestId); invoked++; const r = await f.invoke(token, kind, options); due = false; return r;
    },
    contracts: { decisionId: "modeled-db-scoped-composition", readBudget: async () => ({ remainingMs: 10000 }),
      readSlots: async (token: string) => { assert.equal(token, id(8)); const used = f.items.length; return { used, remaining: 20 - used }; },
      unitsFor: (_kind: unknown, r: { counts: { claimed: number } }) => r.counts.claimed,
      journal: { hasPending: async () => false, begin: async (input: { globalToken: string; kind: string }) => { assert.equal(input.globalToken, id(8)); assert.equal(input.kind, "report_retention"); return f.scoped.atomic.parentRequestId; },
        confirm: async (requestId: string) => {
          assert.equal(requestId, f.scoped.atomic.parentRequestId);
          const terminal = f.scoped.operations.filter(o => o.operation === "report_task_complete");
          assert.equal(terminal.length, 1); assert.ok(f.scoped.confirmed.includes(terminal[0].requestId)); assert.equal(f.items.length, 1); confirmed++; return true;
        }, unknown: async () => { assert.fail("should not be unknown"); } },
      maintenance: { readSchedule: async () => ({ serverNow: "2026-10-07T00:00:00Z", nextDueAt: null }), run: async () => { assert.fail("terminal not due"); } } },
    onError: (e: unknown = undefined) => { assert.fail("unexpected scheduler error " + String(e)); },
  });
  await scheduler.wake(); await scheduler.stop();
  assert.equal(invoked, 1); assert.equal(released, 1); assert.equal(confirmed, 1);
  assert.equal(f.scoped.operations.filter(o => o.operation === "report_task_complete").length, 1);
  assert.equal(f.scoped.operations.some(o => o.operation === "job_settlement"), false);
});
test("invalid factory retry settings fail before any RPC", () => {
  const f = fixture(); let calls = 0;
  assert.throws(() => createSafetyWorkerInvocation(runtimeConfig(), { readiness: f.ports.readiness, atomicInvocation: scopedFixture().atomic,
    allocate: () => ({ maxJobsPerRun: 1, enqueueLimit: 1 }), reserveItem: async () => true, reserve: async () => true, elapsed: () => 0, workerId: id(9), jobLeaseDurationMs: 180000,
    retry: { maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1 }, now: () => new Date() }, async () => { calls++; return Response.json(null); }), /INVALID_RETRY_SETTINGS/);
  assert.equal(calls, 0);
});
test("bound invocation rejects another global token and separate contexts preserve original reservations", async () => {
  const first = workerChain("cancellation_safety", undefined, id(8), true);
  await first.invoke(id(8), "cancellation_safety", first.input);
  const before = first.scoped.calls.length;
  await assert.rejects(first.invoke(id(18), "cancellation_safety", first.input), /INVALID_ATOMIC_SAFETY_CONTEXT/);
  assert.equal(first.scoped.calls.length, before);
  const second = workerChain("cancellation_safety", undefined, id(18), true);
  await second.invoke(id(18), "cancellation_safety", second.input);
  assert.deepEqual([...first.reservations, ...second.reservations], [
    { token: id(8), operation: "due_enqueue" }, { token: id(8), operation: "job_claim" },
    { token: id(18), operation: "due_enqueue" }, { token: id(18), operation: "job_claim" },
  ]);
});
