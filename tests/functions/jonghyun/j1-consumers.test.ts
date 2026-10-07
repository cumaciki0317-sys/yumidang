import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { createSharedBackgroundQueueScheduler } from "../../../backend/supabase/functions/_shared/jobs/background.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRpcJobRepository, decodeSafetyJobPayload, type ClaimedJob, type JobRepository } from "../../../backend/supabase/functions/_shared/db/repositories/jobs.ts";
import { createSafetyConsumerRegistry, createRpcSafetyConsumerPorts, createSafetyWorkerInvocation, decodeReportRetentionTask, type SafetyConsumerPorts, type SafetyJournalIntent } from "../../../backend/supabase/functions/_shared/jobs/safety-consumers.ts";
import { runNextJob } from "../../../backend/supabase/functions/_shared/jobs/lease.ts";
import { decideRetry, JobExecutionUnknown } from "../../../backend/supabase/functions/_shared/jobs/retry.ts";
import { enqueueJob, enqueueSafetyDue } from "../../../backend/supabase/functions/_shared/jobs/enqueue.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const claimJournal = { prepare: async () => {}, confirmed: async () => {}, unknown: async () => {} };
const job = (kind: "report_retention" | "cancellation_safety" = "report_retention"): ClaimedJob => ({ jobId: id(1), leaseToken: id(2), leaseUntil: "2099-01-01T00:00:00Z", failedAttempts: 0,
  reference: kind === "report_retention" ? { kind, reportId: id(3), closureProofId: id(4) } : { kind, identityId: id(3), generation: 7 } });
const task = () => ({ taskId: id(5), taskLeaseToken: id(6), taskExpiresAt: "2098-01-01T00:00:00Z", reportId: id(3), closureRevision: 1, kind: "report_metadata", assetId: null, bucketId: null, objectName: null, objectId: null, retentionDueAt: "2026-01-01T00:00:00Z", closureProofId: id(4) });
function fixture() {
  const intents: SafetyJournalIntent[] = [], unknown: string[] = [], events: string[] = [];
  let remaining = 10;
  const ports: SafetyConsumerPorts = {
    readiness: { scopedClaim: true, sharedBudgetContract: true, durableJournalContract: true, cancellationGuardAndAcl: true, reportGuardAndAcl: true, reportTerminalScheduleContract: true, storageProviderApproved: true },
    budget: { globalToken: id(8), signal: new AbortController().signal, elapsed: () => 0, readRemaining: async () => ({ remainingMs: 10000 }), reserve: async () => remaining-- > 0 },
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
  const calls: unknown[] = [];
  const repo = createRpcJobRepository({ rpc: async (name, args) => { calls.push({ name, args }); return { job: null }; } }, { workerRunToken: id(8), claimJournal, signal: new AbortController().signal });
  assert.equal(await repo.claim({ workerId: id(9), kinds: ["report_retention"], leaseDurationMs: 60000 }), null);
  assert.deepEqual(calls, [{ name: "claim_supported_job", args: { p_worker_id: id(9), p_lease_seconds: 60, p_worker_run_token: id(8), p_supported_kinds: ["report_retention"] } }]);
  await assert.rejects(repo.claim({ workerId: id(9), kinds: ["report_retention", "event_sync"], leaseDurationMs: 60000 }));
  assert.equal(calls.length, 1);
});
test("claim response loss is UNKNOWN and cannot enter retry policy", async () => {
  const repo = createRpcJobRepository({ rpc: async () => { throw new Error("response lost"); } }, { workerRunToken: id(8), claimJournal, signal: new AbortController().signal });
  await assert.rejects(repo.claim({ workerId: id(9), kinds: ["cancellation_safety"], leaseDurationMs: 60000 }), JobExecutionUnknown);
  assert.throws(() => decideRetry({ failedAttempts: 0, now: new Date(), error: new JobExecutionUnknown("claim"), settings: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } }), JobExecutionUnknown);
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
  const f = fixture(); f.ports.journal.prepare = async () => { throw new Error("disk unavailable"); };
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

test("missing claim journal fails before scoped DB claim", async () => {
  let calls = 0;
  const repo = createRpcJobRepository({ rpc: async () => { calls++; return { job: null }; } }, { workerRunToken: id(8), signal: new AbortController().signal });
  await assert.rejects(repo.claim({ workerId: id(9), kinds: ["report_retention"], leaseDurationMs: 60000 }), /JOURNAL_REQUIRED/);
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
  const f = fixture(); f.ports.journal.confirmed = async () => { throw new Error("disk confirmation lost"); };
  const r = runner(job("cancellation_safety"), createSafetyConsumerRegistry(f.ports));
  await assert.rejects(r.run(), JobExecutionUnknown); assert.deepEqual(r.settlements, []); assert.equal(f.unknown.length, 1);
});
test("zero DB budget yields held before dispatch", async () => {
  const f = fixture(); f.ports.budget.readRemaining = async () => ({ remainingMs: 0 });
  const r = runner(job(), createSafetyConsumerRegistry(f.ports));
  assert.equal((await r.run()).status, "held"); assert.deepEqual(f.events, []);
});

test("claim journal failure after valid DB response is UNKNOWN even with conflict code", async () => {
  const journal = { ...claimJournal, confirmed: async () => { throw Object.assign(new Error("journal error"), { code: "STATE_CONFLICT" }); } };
  const repo = createRpcJobRepository({ rpc: async () => ({ job: null }) }, { workerRunToken: id(8), claimJournal: journal, signal: new AbortController().signal });
  await assert.rejects(repo.claim({ workerId: id(9), kinds: ["report_retention"], leaseDurationMs: 60000 }), JobExecutionUnknown);
});
test("scoped claim ignores late valid DB result after parent abort", async () => {
  const abort = new AbortController(); let confirmations = 0;
  const repo = createRpcJobRepository({ rpc: async () => { abort.abort(); return { job: null }; } }, { workerRunToken: id(8), claimJournal: { ...claimJournal, confirmed: async () => { confirmations++; } }, signal: abort.signal });
  await assert.rejects(repo.claim({ workerId: id(9), kinds: ["report_retention"], leaseDurationMs: 60000 }), JobExecutionUnknown);
  assert.equal(confirmations, 0);
});
test("cancellation settlement requires original job fence journal before complete RPC", async () => {
  const calls: string[] = [], j = job("cancellation_safety");
  const repo = createRpcJobRepository({ rpc: async name => { calls.push(name); return { job: { jobId: j.jobId, leaseToken: j.leaseToken, leaseExpiresAt: j.leaseUntil, kind: "cancellation_safety", payload: { identityId: id(3), generation: 7 }, attempt: 1, failedAttempts: 0 } }; } }, { workerRunToken: id(8), claimJournal, signal: new AbortController().signal });
  await repo.claim({ workerId: id(9), kinds: ["cancellation_safety"], leaseDurationMs: 60000 });
  await assert.rejects(repo.settle({ jobId: j.jobId, leaseToken: j.leaseToken, status: "succeeded" }), JobExecutionUnknown);
  assert.deepEqual(calls, ["claim_supported_job"]);
});

const runtimeConfig = (timeout = "1000") => loadRuntimeConfig(k => ({ SUPABASE_URL: "https://project.example.test", SUPABASE_ANON_KEY: "anon-fixture", SUPABASE_SERVICE_ROLE_KEY: "service-fixture", INTERNAL_WORKER_SECRET: "internal_fixture_secret_more_than_32_chars", ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: timeout } as Record<string, string>)[k]);
test("actual RPC factory has no creation side effect and metadata chain uses exact original fences", async () => {
  const f = fixture(), calls: { name: string; body: unknown }[] = [];
  const wired = createRpcSafetyConsumerPorts(runtimeConfig(), { readiness: f.ports.readiness, budget: f.ports.budget, journal: f.ports.journal }, async (url, init) => {
    const name = String(url).split("/").at(-1)!; const body = JSON.parse(String(init?.body)); calls.push({ name, body });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer service-fixture");
    assert.equal(new Headers(init?.headers).get("apikey"), "service-fixture");
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json(name === "read_worker_run_budget" ? { remainingMs: 10000 } : name === "claim_report_retention_task" ? task() : { taskId: id(5), status: "completed", alreadyApplied: false });
  });
  assert.equal(calls.length, 0);
  const r = runner(job(), createSafetyConsumerRegistry(wired.consumers));
  assert.equal((await r.run()).status, "succeeded"); assert.deepEqual(r.settlements, []);
  assert.deepEqual(calls.map(c => c.name), ["read_worker_run_budget", "claim_report_retention_task", "read_worker_run_budget", "complete_report_retention_task"]);
  assert.deepEqual(calls[1].body, { p_job_id: id(1), p_job_lease_token: id(2), p_global_token: id(8) });
  const last = calls[3].body as Record<string, unknown>;
  assert.deepEqual(Object.keys(last).sort(), ["p_task_id", "p_task_lease_token", "p_job_id", "p_job_lease_token", "p_global_token", "p_object_id", "p_evidence_sha256"].sort());
  assert.equal(last.p_object_id, null); assert.match(String(last.p_evidence_sha256), /^[a-f0-9]{64}$/);
});
test("actual cancellation and dedicated enqueue RPC preserve differing global token argument names", async () => {
  const f = fixture(), calls: { name: string; body: Record<string, unknown> }[] = [];
  const w = createRpcSafetyConsumerPorts(runtimeConfig(), { readiness: f.ports.readiness, budget: f.ports.budget, journal: f.ports.journal }, async (url, init) => {
    const name = String(url).split("/").at(-1)!; calls.push({ name, body: JSON.parse(String(init?.body)) });
    return Response.json(name.startsWith("enqueue") ? { enqueued: 1 } : { status: "applied", generation: 7, changed: true });
  });
  await w.consumers.cancellationProcess({ identityId: id(3), generation: 7, jobId: id(1), jobLeaseToken: id(2), globalToken: id(8) }, f.ports.budget.signal);
  await enqueueSafetyDue(w.dueEnqueue, "cancellation_safety", 2, id(8), f.ports.budget.signal);
  await enqueueSafetyDue(w.dueEnqueue, "report_retention", 2, id(8), f.ports.budget.signal);
  assert.deepEqual(calls[0], { name: "process_cancellation_safety_due", body: { p_identity_id: id(3), p_expected_generation: 7, p_job_id: id(1), p_job_lease_token: id(2), p_worker_run_token: id(8) } });
  assert.deepEqual(calls[1].body, { p_limit: 2, p_worker_run_token: id(8) });
  assert.deepEqual(calls[2].body, { p_limit: 2, p_global_token: id(8) });
});
test("actual Storage adapter assembly sends one DELETE and durable ACK before completion", async () => {
  const f = fixture(), j = job(); let deleted = false, ack: unknown = null, deletes = 0, dispatches = 0;
  const storageTask = { ...task(), kind: "storage_object", assetId: id(11), objectId: id(12), bucketId: "report-evidence", objectName: id(13) + "/" + id(11) + ".jpg" };
  const w = createRpcSafetyConsumerPorts(runtimeConfig(), { readiness: f.ports.readiness, budget: f.ports.budget, journal: f.ports.journal }, async (url, init) => {
    const path = new URL(String(url)).pathname, name = path.split("/").at(-1), body = init?.body ? JSON.parse(String(init.body)) : {};
    if (name === "check_report_retention_task") return Response.json(storageTask);
    if (name === "get_report_retention_delete_ack") return Response.json(ack);
    if (name === "begin_report_retention_delete") { dispatches++; return Response.json({ taskId: id(5), dispatchId: id(14), alreadyApplied: false }); }
    if (name === "record_report_retention_delete_ack") { ack = { receiptId: id(15), taskId: id(5), assetId: id(11), objectId: id(12), ackSha256: body.p_ack_sha256 }; return Response.json(ack); }
    if (init?.method === "DELETE") { deletes++; deleted = true; return Response.json([{ id: id(12), name: storageTask.objectName, bucket_id: "report-evidence" }]); }
    if (deleted) return new Response(null, { status: 404 });
    return Response.json({ id: id(12), name: storageTask.objectName, bucket_id: "report-evidence", content_type: "image/jpeg", size: 200 });
  });
  const t = decodeReportRetentionTask(storageTask, j);
  const first = await w.consumers.reportStorage(t, j, f.ports.budget.signal), replay = await w.consumers.reportStorage(t, j, f.ports.budget.signal);
  assert.match(first.evidenceSha256, /^[a-f0-9]{64}$/); assert.deepEqual(first, replay); assert.equal(deletes, 1); assert.equal(dispatches, 1);
});
test("actual RPC factory bounds transport that ignores its own AbortSignal", async () => {
  const f = fixture(); let calls = 0;
  const w = createRpcSafetyConsumerPorts(runtimeConfig("5"), { readiness: f.ports.readiness, budget: f.ports.budget, journal: f.ports.journal }, async () => { calls++; return new Promise<Response>(() => {}); });
  await assert.rejects(w.consumers.reportClaim({ jobId: id(1), jobLeaseToken: id(2), globalToken: id(8) }, f.ports.budget.signal), JobExecutionUnknown);
  assert.equal(calls, 1);
});

function workerChain(kind: "cancellation_safety" | "report_retention", conflict?: "generation" | "fence") {
  const f = fixture(), calls: string[] = [], recorded: string[] = [];
  const j = job(kind);
  const journal = { prepare: async () => { recorded.push("prepare"); }, confirmed: async () => { recorded.push("confirmed"); }, unknown: async () => { recorded.push("unknown"); } };
  const invoke = createSafetyWorkerInvocation(runtimeConfig(), { readiness: f.ports.readiness, journal: f.ports.journal, claimJournal: journal, settlementJournal: journal, enqueueJournal: journal,
    allocate: () => ({ maxJobsPerRun: 1, enqueueLimit: 1 }), reserve: async () => true, elapsed: () => 0, workerId: id(9), jobLeaseDurationMs: 60000,
    retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 }, now: () => new Date("2026-10-07T00:00:00Z") }, async (url, init) => {
      const name = String(url).split("/").at(-1)!; calls.push(name);
      if (name === "read_worker_run_budget") return Response.json({ remainingMs: 10000 });
      if (name.startsWith("enqueue")) return Response.json({ enqueued: 1 });
      if (name === "claim_supported_job") return Response.json({ job: { jobId: j.jobId, kind, payload: kind === "cancellation_safety" ? { identityId: id(3), generation: 7 } : { reportId: id(3), closureProofId: id(4) }, leaseToken: j.leaseToken, leaseExpiresAt: j.leaseUntil, attempt: 1, failedAttempts: 0 } });
      if (name === "process_cancellation_safety_due") return conflict ? Response.json({ code: "40001" }, { status: 409 }) : Response.json({ status: "applied", generation: 7, changed: true });
      if (name === "claim_report_retention_task") return conflict ? Response.json({ code: "40001" }, { status: 409 }) : Response.json(task());
      if (name === "complete_report_retention_task") return Response.json({ taskId: id(5), status: "completed", alreadyApplied: false });
      if (name === "complete_job") return Response.json({ jobId: id(1), status: "succeeded" });
      throw new Error("unexpected " + name);
    });
  return { calls, recorded, invoke, input: { limit: 20, remainingMs: 10000, signal: new AbortController().signal } };
}
test("complete cancellation chain uses dedicated enqueue, scoped claim, process and journalled generic completion", async () => {
  const f = workerChain("cancellation_safety"), r = await f.invoke(id(8), "cancellation_safety", f.input);
  assert.equal(r.status, "ran"); if (r.status !== "ran") throw new Error();
  assert.deepEqual(r.counts, { claimed: 1, succeeded: 1, held: 0, leaseLost: 0 });
  assert.deepEqual(f.calls.filter(name => name !== "read_worker_run_budget"), ["enqueue_cancellation_safety_due", "claim_supported_job", "process_cancellation_safety_due", "complete_job"]);
  assert.deepEqual(f.recorded, ["prepare", "confirmed", "prepare", "confirmed", "prepare", "confirmed"]);
});
test("complete report chain performs metadata completion exactly once with parent settlement0", async () => {
  const f = workerChain("report_retention"), r = await f.invoke(id(8), "report_retention", f.input);
  assert.equal(r.status, "ran"); if (r.status !== "ran") throw new Error();
  assert.equal(r.counts.succeeded, 1);
  assert.deepEqual(f.calls.filter(name => name !== "read_worker_run_budget"), ["enqueue_report_retention_purges", "claim_supported_job", "claim_report_retention_task", "complete_report_retention_task"]);
  assert.equal(f.calls.includes("complete_job"), false);
});
for (const [kind, conflict] of [["cancellation_safety", "generation"], ["report_retention", "fence"]] as const) {
  test(`server rejects stale ${conflict} before any settle/retry/complete or second request`, async () => {
    const f = workerChain(kind, conflict), r = await f.invoke(id(8), kind, f.input);
    assert.equal(r.status, "ran"); if (r.status !== "ran") throw new Error();
    assert.deepEqual(r.counts, { claimed: 1, succeeded: 0, held: 0, leaseLost: 1 });
    assert.equal(f.calls.some(name => ["complete_job", "complete_report_retention_task", "retry_job", "fail_job"].includes(name)), false);
    assert.equal(f.calls.filter(name => name === (kind === "cancellation_safety" ? "process_cancellation_safety_due" : "claim_report_retention_task")).length, 1);
  });
}

test("shared scheduler dispatch reaches actual safety composition and terminal metadata without fallback", async () => {
  const f = workerChain("report_retention"); let due = true, released = 0, invoked = 0;
  const scheduler = createSharedBackgroundQueueScheduler({
    supportedKinds: ["report_retention"], queryTimeoutMs: 1000,
    repository: {
      schedule: async () => ({ serverNow: "2026-10-07T00:00:00Z", nextDueAt: due ? "2026-10-07T00:00:00Z" : null, nextKind: due ? "report_retention" : null }),
      acquire: async () => ({ token: id(8), expiresAt: "2026-10-07T00:03:00Z" }), release: async () => { released++; return "applied"; },
    },
    invoke: async (token: string, kind: "report_retention", options: typeof f.input) => { invoked++; const r = await f.invoke(token, kind, options); due = false; return r; },
    contracts: { decisionId: "mock-composition-only", readBudget: async () => ({ remainingMs: 10000 }), unitsFor: (_kind: unknown, r: { counts: { claimed: number } }) => r.counts.claimed,
      journal: { hasPending: async () => false, begin: async () => id(16), confirm: async () => true, unknown: async () => { assert.fail("should not be unknown"); } },
      maintenance: { readSchedule: async () => ({ serverNow: "2026-10-07T00:00:00Z", nextDueAt: null }), run: async () => { assert.fail("terminal not due"); } } },
    onError: () => { assert.fail("unexpected scheduler error"); },
  });
  await scheduler.wake(); await scheduler.stop();
  assert.equal(invoked, 1); assert.equal(released, 1); assert.equal(f.calls.filter(n => n === "complete_report_retention_task").length, 1);
  assert.equal(f.calls.includes("complete_job"), false);
});

test("invalid factory retry settings fail before any RPC", () => {
  const f = fixture(); let calls = 0;
  assert.throws(() => createSafetyWorkerInvocation(runtimeConfig(), { readiness: f.ports.readiness, journal: f.ports.journal, claimJournal, settlementJournal: claimJournal, enqueueJournal: claimJournal,
    allocate: () => ({ maxJobsPerRun: 1, enqueueLimit: 1 }), reserve: async () => true, elapsed: () => 0, workerId: id(9), jobLeaseDurationMs: 60000,
    retry: { maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1 }, now: () => new Date() }, async () => { calls++; return Response.json(null); }), /INVALID_RETRY_SETTINGS/);
  assert.equal(calls, 0);
});

test("reused invocation factory forwards each original global token to shared reservation", async () => {
  const f = fixture(), reservations: { token: string; operation: string }[] = [];
  const invoke = createSafetyWorkerInvocation(runtimeConfig(), { readiness: f.ports.readiness, journal: f.ports.journal, claimJournal, settlementJournal: claimJournal, enqueueJournal: claimJournal,
    allocate: () => ({ maxJobsPerRun: 1, enqueueLimit: 1 }), reserve: async (token, operation) => { reservations.push({ token, operation }); return true; }, elapsed: () => 0,
    workerId: id(9), jobLeaseDurationMs: 60000, retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 }, now: () => new Date("2026-10-07T00:00:00Z") }, async (url, init) => {
      const name = String(url).split("/").at(-1)!; const args = JSON.parse(String(init?.body));
      const token = args.p_worker_run_token ?? args.p_global_token;
      assert.ok([id(8), id(18)].includes(token));
      if (name === "read_worker_run_budget") return Response.json({ remainingMs: 10000 });
      if (name === "enqueue_cancellation_safety_due") return Response.json({ enqueued: 0 });
      if (name === "claim_supported_job") return Response.json({ job: null });
      throw new Error(name);
    });
  for (const token of [id(8), id(18)]) await invoke(token, "cancellation_safety", { limit: 20, remainingMs: 10000, signal: new AbortController().signal });
  assert.deepEqual(reservations, [{ token: id(8), operation: "due_enqueue" }, { token: id(8), operation: "job_claim" }, { token: id(18), operation: "due_enqueue" }, { token: id(18), operation: "job_claim" }]);
});
