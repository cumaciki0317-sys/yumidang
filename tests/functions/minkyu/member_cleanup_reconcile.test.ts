/** 실제 SQL115 transport/기존 adapter를 사용한 모형 DB·Auth·Storage 회귀다. 실제 DB 증명은 별도다. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { createMemberCleanupReconcilePorts } from "../../../backend/supabase/functions/_shared/db/repositories/member-cleanup.ts";
import { createMemberCleanupAdapter, processMemberCleanupReconciliation, type MemberCleanupReconcileProof } from "../../../backend/supabase/functions/_shared/auth/member-cleanup.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
const id = (n: number) => `ef115100-0000-4000-8000-${String(n).padStart(12, "0")}`;
const values: Record<string, string> = { SUPABASE_URL: "https://cleanup.example.invalid", SUPABASE_ANON_KEY: "synthetic-anon", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service", INTERNAL_WORKER_SECRET: "x".repeat(32), ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "1000" };
const config = (timeout = "1000") => loadRuntimeConfig(k => k === "UPSTREAM_TIMEOUT_MS" ? timeout : values[k]);
type Options = { kind?: "storage_object" | "auth_user"; existing?: "prepared" | "completed" | "superseded"; lostBegin?: boolean; lostFinish?: boolean; missingFinish?: boolean; absence?: number; storageCode?: string; ack?: "missing" | "hash" | "receipt" | "object" | "kind"; change?: string; beginExtra?: boolean; taskMismatch?: boolean; abortOnGet?: AbortController; hang?: string; closed?: boolean };
function fixture(options: Options = {}, timeout = "1000") {
  const binding = { recoveryRequestId: id(1), invocationRequestId: id(2), taskId: id(3), recoveryGlobalToken: id(4) };
  const kind = options.kind ?? "storage_object", expiresAt = new Date(Date.now() + 50000).toISOString();
  const task = { taskId: id(3), leaseToken: id(5), expiresAt, kind, profileId: id(6), bucketId: kind === "storage_object" ? "profile-images" : null, objectName: kind === "storage_object" ? `${id(6)}/synthetic.png` : null, objectId: kind === "storage_object" ? id(7) : null };
  const proof: MemberCleanupReconcileProof = { recoveryRequestId: id(1), invocationRequestId: id(2), taskId: id(3), state: options.existing ?? "prepared", original: { withdrawalId: id(8), objectId: task.objectId, dispatchId: id(9), globalToken: id(10), jobLeaseToken: id(11), ackReceiptId: id(12), ackSha256: "a".repeat(64) }, recovery: { globalToken: id(4), leaseToken: id(5), expiresAt }, evidenceSha256: options.existing === "completed" ? "b".repeat(64) : null, closedAt: options.existing && options.existing !== "prepared" ? "2026-10-09T00:00:00Z" : null };
  const saved = structuredClone(proof) as unknown as Record<string, unknown>;
  let began = !!options.existing, gets = 0;
  const calls: { name: string; args: Record<string, unknown> }[] = [], external: { path: string; method: string }[] = [];
  const original = structuredClone(proof.original);
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    assert.notEqual(init?.method, "DELETE", "reconcile never sends DELETE");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-service");
    assert.equal(new Headers(init?.headers).get("apikey"), "synthetic-service");
    if (!path.startsWith("/rest/")) {
      assert.equal(init?.method, "GET"); external.push({ path, method: init!.method! });
      if (options.hang === "external") return new Promise<Response>(() => {});
      if (options.absence === 400) return Response.json({ code: options.storageCode ?? "NoSuchKey", statusCode: "404" }, { status: 400 });
      return new Response(null, { status: options.absence ?? 404 });
    }
    const name = path.split("/").at(-1)!, args = JSON.parse(String(init?.body)); calls.push({ name, args });
    assert.ok(init?.signal instanceof AbortSignal);
    if (options.hang === name) return new Promise<Response>(() => {});
    if (options.closed) return Response.json({ code: "42501" }, { status: 403 });
    if (name === "begin_member_cleanup_reconcile") {
      assert.deepEqual(args, { p_recovery_request_id: id(1), p_invocation_request_id: id(2), p_task_id: id(3), p_recovery_global_token: id(4) });
      const fresh = !began; began = true;
      if (options.lostBegin) throw new Error("synthetic response loss");
      return Response.json({ recoveryRequestId: id(1), state: saved.state, fresh, task: fresh ? options.taskMismatch ? { ...task, leaseToken: id(99) } : task : null, ...(options.beginExtra ? { raw: "disallowed" } : {}) });
    }
    if (name === "get_member_cleanup_reconcile") {
      assert.deepEqual(args, { p_recovery_request_id: id(1) }); gets++;
      options.abortOnGet?.abort();
      const value = structuredClone(saved) as Record<string, unknown>;
      if (options.change === "recoveryRequestId" || options.change === "invocationRequestId" || options.change === "taskId") value[options.change] = id(99);
      if (options.change === "recoveryGlobalToken") (value.recovery as Record<string, unknown>).globalToken = id(99);
      if (options.change === "originalAfterRead" && gets > 1) (value.original as Record<string, unknown>).ackSha256 = "c".repeat(64);
      if (options.change === "evidence" && saved.state === "completed") value.evidenceSha256 = "c".repeat(64);
      if (options.change === "extra") value.raw = "disallowed";
      return Response.json(value);
    }
    if (name === "check_member_cleanup_task" || name === "get_member_cleanup_delete_ack") {
      assert.deepEqual(args, { p_task_id: id(3), p_lease_token: id(5), p_worker_run_token: id(4), p_object_id: task.objectId });
      if (name === "check_member_cleanup_task") return Response.json(task);
      const ack = { receiptId: id(12), taskId: id(3), kind, objectId: task.objectId, evidenceSha256: "a".repeat(64) };
      if (options.ack === "missing") return Response.json(null);
      return Response.json({ ...ack, ...(options.ack === "hash" ? { evidenceSha256: "c".repeat(64) } : options.ack === "receipt" ? { receiptId: id(99) } : options.ack === "object" ? { objectId: id(99) } : options.ack === "kind" ? { kind: kind === "auth_user" ? "storage_object" : "auth_user" } : {}) });
    }
    if (name === "finish_member_cleanup_reconcile") {
      assert.deepEqual(Object.keys(args).sort(), ["p_recovery_request_id", "p_evidence_sha256"].sort()); assert.equal(args.p_recovery_request_id, id(1));
      assert.match(String(args.p_evidence_sha256), /^[a-f0-9]{64}$/);
      if (!options.missingFinish) { saved.state = "completed"; saved.evidenceSha256 = args.p_evidence_sha256; saved.closedAt = "2026-10-09T00:00:00Z"; }
      if (options.lostFinish) throw new Error("synthetic finish response loss");
      return Response.json({ ...saved, state: "completed", evidenceSha256: args.p_evidence_sha256, closedAt: "2026-10-09T00:00:00Z" });
    }
    assert.fail("legacy claim/complete, DELETE dispatch or ACK mutation: " + name);
  };
  const ports = createMemberCleanupReconcilePorts(config(timeout), binding, fetcher), adapter = createMemberCleanupAdapter(config(timeout), fetcher);
  const run = (signal?: AbortSignal) => processMemberCleanupReconciliation(ports, adapter, { deadlineAt: Date.now() + 1000, ...(signal ? { signal } : {}) });
  return { binding, task, proof, saved, ports, adapter, calls, external, run, original, fetcher };
}
for (const kind of ["storage_object", "auth_user"] as const) test(`fresh ${kind} reconcile uses ACK GET and absence GET only, finishes stored DB proof`, async () => {
  const f = fixture({ kind }); assert.equal(f.calls.length + f.external.length, 0);
  f.binding.recoveryRequestId = id(99); f.binding.taskId = id(99); f.binding.recoveryGlobalToken = id(99);
  const result = await f.run(); assert.equal(result.status, "applied"); if (result.status !== "applied") throw new Error();
  const evidence = createHash("sha256").update(JSON.stringify({ version: 2, taskId: id(3), leaseToken: id(5), workerRunToken: id(4), objectId: f.task.objectId, kind, receiptId: id(12), ackSha256: "a".repeat(64), requeryStatus: 404 })).digest("hex");
  assert.equal(result.evidenceSha256, evidence); assert.equal(f.saved.evidenceSha256, evidence);
  assert.equal(f.calls.filter(c => c.name === "begin_member_cleanup_reconcile").length, 1);
  assert.equal(f.calls.filter(c => c.name === "finish_member_cleanup_reconcile").length, 1);
  assert.ok(f.calls.some(c => c.name === "get_member_cleanup_delete_ack"));
  assert.equal(f.external.length, kind === "storage_object" ? 2 : 1); assert.ok(f.external.every(c => c.method === "GET"));
  assert.deepEqual(f.saved.original, f.original); assert.ok(Object.isFrozen(f.ports.binding));
});
for (const state of ["prepared", "completed", "superseded"] as const) test(`existing ${state} key is minimal GET only without task re-claim or adapter`, async () => {
  const f = fixture({ existing: state }), result = await f.run();
  assert.equal(result.status, state === "completed" ? "applied" : state === "prepared" ? "pending" : "superseded");
  if (result.status === "applied") assert.equal(result.evidenceSha256, "b".repeat(64));
  assert.deepEqual(f.calls.map(c => c.name), ["begin_member_cleanup_reconcile", "get_member_cleanup_reconcile"]); assert.equal(f.external.length, 0);
  assert.deepEqual(f.saved, f.proof);
});
test("lost begin preserves pending and repeated same instance sends GET only", async () => {
  const f = fixture({ lostBegin: true }); assert.deepEqual(await f.run(), { status: "pending" });
  assert.deepEqual(await f.run(), { status: "pending" });
  assert.deepEqual(f.calls.map(c => c.name), ["begin_member_cleanup_reconcile", "get_member_cleanup_reconcile", "get_member_cleanup_reconcile"]); assert.equal(f.external.length, 0);
});
test("lost finish recovers exact stored proof and repeated same key writes zero", async () => {
  const f = fixture({ lostFinish: true }); const first = await f.run(); assert.equal(first.status, "applied");
  const count = f.calls.length, reads = f.external.length; assert.deepEqual(await f.run(), first);
  assert.deepEqual(f.calls.slice(count).map(c => c.name), ["get_member_cleanup_reconcile"]); assert.equal(f.external.length, reads);
  assert.equal(f.calls.filter(c => c.name === "finish_member_cleanup_reconcile").length, 1);
});
test("acknowledged or lost finish without stored DB completion stays pending and never re-sends finish", async () => {
  for (const lostFinish of [false, true]) {
    const f = fixture({ missingFinish: true, lostFinish }); await assert.rejects(f.run());
    const reads = f.external.length; assert.deepEqual(await f.run(), { status: "pending" }); assert.equal(f.external.length, reads);
    assert.equal(f.calls.filter(c => c.name === "finish_member_cleanup_reconcile").length, 1); assert.equal(f.saved.state, "prepared");
  }
});
for (const change of ["recoveryRequestId", "invocationRequestId", "taskId", "recoveryGlobalToken", "extra", "originalAfterRead", "evidence"]) test(`changed ${change} proof cannot complete or substitute scope`, async () => {
  const f = fixture({ change }); await assert.rejects(f.run());
  assert.ok(f.calls.filter(c => c.name === "finish_member_cleanup_reconcile").length <= 1);
  if (!["originalAfterRead", "evidence"].includes(change)) assert.equal(f.external.length, 0);
});
for (const ack of ["missing", "hash", "receipt", "object", "kind"] as const) test(`original ACK ${ack} mismatch stops before external GET and finish`, async () => {
  const f = fixture({ ack }); await assert.rejects(f.run()); assert.equal(f.external.length, 0);
  assert.equal(f.calls.filter(c => c.name === "finish_member_cleanup_reconcile").length, 0);
});
for (const options of [{ beginExtra: true }, { taskMismatch: true }]) test("fresh begin DTO must be exact and match recovery lease " + JSON.stringify(options), async () => {
  const f = fixture(options); await assert.rejects(f.run()); assert.equal(f.external.length, 0);
  assert.equal(f.calls.filter(c => c.name === "check_member_cleanup_task").length, 0);
});
for (const kind of ["storage_object", "auth_user"] as const) for (const absence of [200, 401, 403, 503]) test(`${kind} ${absence} is not absence proof`, async () => {
  const f = fixture({ kind, absence }); await assert.rejects(f.run()); assert.equal(f.calls.filter(c => c.name === "finish_member_cleanup_reconcile").length, 0);
});
test("Storage NoSuchKey 400 alone is allowed but bucket or Auth 400 remain closed", async () => {
  assert.equal((await fixture({ absence: 400 }).run()).status, "applied");
  for (const options of [{ absence: 400, storageCode: "NoSuchBucket" }, { kind: "auth_user" as const, absence: 400 }]) await assert.rejects(fixture(options).run());
});
test("closed guard or unknown missing RPC cannot become success", async () => {
  const f = fixture({ closed: true }); await assert.rejects(f.run(), (e: unknown) => toPublicError(e).error.code === "ACCESS_DENIED");
  assert.equal(f.external.length, 0); assert.equal(f.calls.some(c => c.name === "finish_member_cleanup_reconcile"), false);
});
test("already aborted and expired allocations send no request", async () => {
  const f = fixture(), abort = new AbortController(); abort.abort(); await assert.rejects(f.run(abort.signal));
  await assert.rejects(processMemberCleanupReconciliation(f.ports, f.adapter, { deadlineAt: Date.now() - 1 })); assert.equal(f.calls.length, 0);
});
test("parent abort after GET starts no task read or external request", async () => {
  const abort = new AbortController(), f = fixture({ abortOnGet: abort }); await assert.rejects(f.run(abort.signal));
  assert.equal(f.external.length, 0); assert.equal(f.calls.some(c => c.name === "check_member_cleanup_task"), false);
});
test("ignored AbortSignal on begin is bounded and no new begin is sent", async () => {
  const f = fixture({ hang: "begin_member_cleanup_reconcile" }, "5"); assert.deepEqual(await f.run(), { status: "pending" });
  assert.deepEqual(await f.run(), { status: "pending" }); assert.equal(f.calls.filter(c => c.name === "begin_member_cleanup_reconcile").length, 1); assert.equal(f.external.length, 0);
});
test("ports reject unrelated recovery fence and second finish before transport", async () => {
  const f = fixture(); await f.ports.begin(); await f.ports.get(); const before = f.calls.length;
  await assert.rejects(async () => f.ports.assertCurrent({ taskId: id(99), leaseToken: id(5), workerRunToken: id(4), objectId: id(7) }));
  await assert.rejects(async () => f.ports.getDeleteAck({ taskId: id(3), leaseToken: id(99), workerRunToken: id(4), objectId: id(7) }));
  assert.equal(f.calls.length, before);
  await f.ports.finish("b".repeat(64)); const done = f.calls.length; await assert.rejects(f.ports.finish("b".repeat(64))); assert.equal(f.calls.length, done);
});
test("GET-only or existing fresh-false context cannot restore task DTO or call finish", async () => {
  for (const existing of [undefined, "prepared"] as const) {
    const f = fixture({ existing });
    if (existing) await f.ports.begin();
    await f.ports.get(); const count = f.calls.length;
    const fence = { taskId: id(3), leaseToken: id(5), workerRunToken: id(4), objectId: id(7) };
    await assert.rejects(async () => f.ports.assertCurrent(fence));
    await assert.rejects(async () => f.ports.getDeleteAck(fence));
    await assert.rejects(f.ports.finish("b".repeat(64))); assert.equal(f.calls.length, count);
  }
});
test("fence getters are snapshotted once before readonly transport", async () => {
  const f = fixture(); await f.ports.begin(); await f.ports.get(); let reads = 0;
  const fence = { get taskId() { return ++reads === 1 ? id(3) : id(99); }, leaseToken: id(5), workerRunToken: id(4), objectId: id(7) };
  await f.ports.assertCurrent(fence); assert.equal(reads, 1); assert.equal(f.calls.at(-1)!.args.p_task_id, id(3));
});
test("invalid binding is rejected before network and arbitrary source fields cannot be stored", () => {
  const f = fixture(); let count = 0; const fetcher: typeof fetch = async () => { count++; assert.fail(); };
  for (const input of [{ ...f.binding, taskId: "bad" }, { ...f.binding, recoveryGlobalToken: "00000000-0000-0000-0000-000000000000" }, { ...f.binding, raw: "not allowed" }]) assert.throws(() => createMemberCleanupReconcilePorts(config(), input, fetcher));
  assert.equal(count, 0);
});
