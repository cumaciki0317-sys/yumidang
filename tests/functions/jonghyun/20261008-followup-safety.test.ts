import test from "node:test";
import assert from "node:assert/strict";
import { createSafetyConsumerRegistry, createRpcSafetyConsumerPorts, createSafetyWorkerInvocation } from "../../../backend/supabase/functions/_shared/jobs/safety-consumers.ts";
import { createWorkerScopedIntentRuntime } from "../../../backend/supabase/functions/_shared/db/worker-runtime-client.ts";
import type { RpcClient } from "../../../backend/supabase/functions/_shared/db/transport.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { JobExecutionUnknown } from "../../../backend/supabase/functions/_shared/jobs/retry.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const job = { jobId: id(1), leaseToken: id(2), leaseUntil: "2099-01-01T00:00:00Z", failedAttempts: 0, reference: { kind: "report_retention" as const, reportId: id(3), closureProofId: id(4) } };
const meta = { taskId: id(5), taskLeaseToken: id(6), taskExpiresAt: "2098-01-01T00:00:00Z", reportId: id(3), closureRevision: 1, kind: "report_metadata", assetId: null, bucketId: null, objectName: null, objectId: null, retentionDueAt: "2026-01-01T00:00:00Z", closureProofId: id(4) };
const config = loadRuntimeConfig(key => ({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s", INTERNAL_WORKER_SECRET: "x".repeat(32), UPSTREAM_TIMEOUT_MS: "1000", MAX_REQUEST_BYTES: "10000", ALLOWED_ORIGINS: "[]" } as Record<string, string>)[key]);
// 실제 SDK·Storage adapter 조립에 모형 DB/Storage를 주입한다. 실제 DB/공급사 검증과 구분한다.
function fixture(limit: number) {
  let claims = 0, deletes = 0, deleted = false, ack: JsonValue = null;
  const items: unknown[] = [], known = new Set<string>(), rpc: string[] = [], operations: { requestId: string; operation: string; input: Record<string, JsonValue>; predecessor: JsonValue }[] = [];
  const intents = new Map<string, Record<string, JsonValue>>(), results = new Map<string, Record<string, JsonValue>>();
  const storage = { ...meta, kind: "storage_object", taskId: id(10), assetId: id(11), objectId: id(12), bucketId: "report-evidence", objectName: `${id(3)}/${id(11)}.jpg` };
  let current: typeof meta | typeof storage = storage;
  const db: RpcClient = { async rpc(name, args) {
    const key = String(args.p_request_id);
    if (name === "prepare_worker_invocation_intent") {
      assert.equal(args.p_parent_invocation_id, id(16)); assert.equal(intents.has(key), false);
      intents.set(key, { ticket: key, requestId: key, globalToken: id(8), parentTicket: null, operation: args.p_operation, scope: structuredClone(args.p_scope), state: "prepared" });
      operations.push({ requestId: key, operation: String(args.p_operation), input: structuredClone(args.p_scope) as Record<string, JsonValue>, predecessor: args.p_predecessor_request_id });
      return { ticket: key, state: "prepared", fresh: true };
    }
    if (name === "execute_worker_invocation_operation") {
      assert.equal(args.p_parent_request_id, id(16)); assert.equal(args.p_global_token, id(8));
      const intent = intents.get(key)!; assert.deepEqual(args.p_input, intent.scope); assert.equal(args.p_operation, intent.operation);
      const input = args.p_input as Record<string, JsonValue>; let result: JsonValue;
      if (args.p_operation === "job_claim") result = { job: { jobId: job.jobId, leaseToken: job.leaseToken, leaseExpiresAt: job.leaseUntil, kind: "report_retention", payload: { reportId: id(3), closureProofId: id(4) }, attempt: 1, failedAttempts: 0 } };
      else if (args.p_operation === "report_task_claim") { current = claims++ === 0 ? storage : meta; const { bucketId: _b, objectName: _n, ...saved } = current; result = saved; }
      else if (args.p_operation === "report_storage") result = { taskId: storage.taskId, dispatchId: id(14), alreadyApplied: false };
      else if (args.p_operation === "report_storage_ack") {
        const predecessor = operations.find(o => o.requestId === key)!.predecessor;
        assert.equal(predecessor, operations.find(o => o.operation === "report_storage")!.requestId);
        ack = { receiptId: id(15), taskId: storage.taskId, assetId: storage.assetId, objectId: storage.objectId, ackSha256: input.ackSha256 }; result = ack;
      } else if (args.p_operation === "report_task_complete") {
        if (input.objectId !== null) assert.equal(operations.find(o => o.requestId === key)!.predecessor, operations.find(o => o.operation === "report_storage_ack")!.requestId);
        else assert.equal(operations.find(o => o.requestId === key)!.predecessor, null);
        result = { taskId: input.taskId, status: "completed", alreadyApplied: false };
      } else assert.fail("unexpected scoped operation " + String(args.p_operation));
      assert.equal(results.has(key), false);
      const out = { requestId: key, state: args.p_operation === "report_storage" ? "external_pending" : "completed", result, closedAt: args.p_operation === "report_storage" ? null : "2026-10-09T00:00:00Z", replayed: false };
      results.set(key, out); return out;
    }
    if (name === "get_worker_runtime_intent") return structuredClone(intents.get(key)!);
    if (name === "get_worker_runtime_operation") { assert.ok(results.has(key)); return { ...results.get(key)!, replayed: true }; }
    if (name === "confirm_worker_runtime_intent") {
      assert.ok(results.has(key)); const row = intents.get(key)!;
      if (row.operation === "report_storage") assert.ok(operations.some(o => o.operation === "report_task_complete" && o.input.taskId === storage.taskId));
      row.state = "confirmed"; return { ticket: key, state: "confirmed" };
    }
    if (name === "observe_worker_runtime_intent") return { ticket: key, state: "unknown" };
    assert.fail("mutable raw DB RPC " + name);
  } };
  const atomic = createWorkerScopedIntentRuntime(db, { parentRequestId: id(16), globalToken: id(8) });
  const readiness = { scopedClaim: true, sharedBudgetContract: true, durableJournalContract: true, cancellationGuardAndAcl: true, reportGuardAndAcl: true, reportTerminalScheduleContract: true, storageProviderApproved: true };
  const budget = { globalToken: id(8), signal: new AbortController().signal, elapsed: () => 0,
    reserve: async (op: string) => { rpc.push(op); return true; },
    hasItemCapacity: (jobId?: string) => (!!jobId && known.has(jobId)) || known.size < limit,
    reserveItem: async (item: { jobId: string }) => {
      if (known.has(item.jobId)) return true;
      if (known.size >= limit) return false;
      assert.ok([...intents.values()].some(i => i.operation === "job_claim" && i.state === "confirmed"));
      items.push(item); known.add(item.jobId); return true;
    } };
  const p = createRpcSafetyConsumerPorts(config, { readiness, budget, atomicInvocation: atomic }, async (url, init) => {
    const path = new URL(String(url)).pathname, name = path.split("/").at(-1);
    if (path.startsWith("/rest/")) {
      if (name === "read_worker_run_budget") return Response.json({ remainingMs: 10000 });
      if (name === "check_report_retention_task") return Response.json(current);
      if (name === "get_report_retention_delete_ack") return Response.json(ack);
      assert.fail("mutable raw REST RPC " + name);
    }
    if (init?.method === "DELETE") { deletes++; deleted = true; return Response.json([{ id: storage.objectId, name: storage.objectName, bucket_id: "report-evidence" }]); }
    return deleted ? new Response(null, { status: 404 }) : Response.json({ id: storage.objectId, name: storage.objectName, bucket_id: "report-evidence", content_type: "image/jpeg", size: 200 });
  }).consumers;
  async function run() {
    await atomic.run({ requestId: id(17), operation: "job_claim", input: { workerId: id(9), leaseSeconds: 180, supportedKinds: ["report_retention"] } });
    return createSafetyConsumerRegistry(p).report_retention!(job);
  }
  return { p, atomic, rpc, items, operations, known, run, claims: () => claims, deletes: () => deletes };
}
test("attachment DELETE ACK completion and metadata share one confirmed parent job slot", async () => {
  const f = fixture(2); assert.equal((await f.run()).status, "completed_by_handler");
  assert.equal(f.items.length, 1); assert.equal(f.claims(), 2); assert.equal(f.deletes(), 1);
  assert.deepEqual(f.items, [{ kind: "report_retention", jobId: id(1) }]);
  assert.deepEqual(f.rpc, ["report_task_claim", "report_storage", "report_task_claim", "report_task_complete"]);
  assert.deepEqual(f.operations.map(o => o.operation), ["job_claim", "report_task_claim", "report_storage", "report_storage_ack", "report_task_complete", "report_task_claim", "report_task_complete"]);
});
test("one remaining parent slot completes all its children and starts no different job claim", async () => {
  const f = fixture(1); assert.equal((await f.run()).status, "completed_by_handler"); assert.equal(f.claims(), 2); assert.equal(f.items.length, 1);
  const before = f.operations.length;
  assert.equal((await createSafetyConsumerRegistry(f.p).report_retention!({ ...job, jobId: id(20) })).status, "held");
  assert.equal(f.operations.length, before); assert.equal(f.claims(), 2); assert.equal(f.deletes(), 1);
});
test("atomic parent reservation refusal starts no child claim or destructive processing", async () => {
  const f = fixture(2); f.p.budget.reserveItem = async () => false;
  assert.equal((await f.run()).status, "held"); assert.equal(f.claims(), 0); assert.equal(f.deletes(), 0);
  assert.deepEqual(f.operations.map(o => o.operation), ["job_claim"]);
});
test("lost parent reservation response is UNKNOWN with no child claim or DELETE", async () => {
  const f = fixture(2); f.p.budget.reserveItem = async () => { throw new Error("lost"); };
  await assert.rejects(f.run(), JobExecutionUnknown); assert.equal(f.claims(), 0); assert.equal(f.deletes(), 0);
  assert.deepEqual(f.operations.map(o => o.operation), ["job_claim"]);
});
test("missing atomic item port leaves consumers unregistered", () => {
  const f = fixture(2); delete (f.p.budget as Partial<typeof f.p.budget>).reserveItem; assert.deepEqual(createSafetyConsumerRegistry(f.p), {});
});
for (const allocation of [{ maxJobsPerRun: 2, enqueueLimit: 1 }, { maxJobsPerRun: 1, enqueueLimit: 2 }]) test("allocation cannot exceed invocation remainder " + JSON.stringify(allocation), async () => {
  const f = fixture(2); let calls = 0;
  const invoke = createSafetyWorkerInvocation(config, { readiness: f.p.readiness, atomicInvocation: f.atomic, allocate: () => allocation, reserve: async () => true, reserveItem: async () => true, elapsed: () => 0, workerId: id(9), jobLeaseDurationMs: 180000, retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 }, now: () => new Date() }, async () => { calls++; throw new Error(); });
  await assert.rejects(invoke(id(8), "report_retention", { limit: 1, remainingMs: 1000, signal: new AbortController().signal }), /INVALID_SAFETY_WORKER_ALLOCATION/);
  assert.equal(calls, 0); assert.equal(f.operations.length, 0);
});
