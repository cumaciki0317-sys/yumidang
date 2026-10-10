/** 실제 service-api factory→SQL115 제품 bridge→격리 REST/Auth/Storage. 운영 배포·CLI 검증은 아니다. */
import assert from "node:assert/strict";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
import type { MemberCleanupReconcileBinding } from "../../../backend/supabase/functions/_shared/auth/member-cleanup.ts";

interface Input {
  root: string; upstream: string; scenario: "storage" | "auth" | "begin_loss" | "finish_loss" | "finalize_loss" | "no_ack"; phase: "bridge" | "finalize";
  anon: string; service: string; workerSecret: string; binding: MemberCleanupReconcileBinding;
  profileId: string; objectName: string | null; originalGlobalToken: string;
  frozenGraphSha256: string; originEvidence: "SYNTHETIC_SQL_ACK_NO_EXTERNAL_DELETE" | "SYNTHETIC_SQL_NO_ACK";
}
if (Deno.args.length !== 1) throw new Error("PRIVATE_INPUT_REQUIRED");
const inputPath = await Deno.realPath(Deno.args[0]);
assert.ok(inputPath.startsWith("/private/tmp/yumidang-member115-http-"));
const stat = await Deno.stat(inputPath); assert.equal((stat.mode ?? 0) & 0o077, 0);
const f = JSON.parse(await Deno.readTextFile(inputPath)) as Input;
assert.equal(await Deno.realPath(f.root), f.root); assert.equal((await Deno.stat(f.root)).mode! & 0o077, 0);
assert.match(f.frozenGraphSha256, /^[a-f0-9]{64}$/);
assert.ok(["bridge", "finalize"].includes(f.phase));
const upstream = new URL(f.upstream); assert.equal(upstream.protocol, "http:"); assert.equal(upstream.hostname, "127.0.0.1"); assert.equal(upstream.pathname, "/");
const nativeFetch = globalThis.fetch;
let runtime: ReturnType<typeof createRuntimeHandler> | undefined;
const suffix = f.phase === "finalize" ? "/finalize" : "";
const routes = ["/service-api/internal/member-cleanup/reconcile", "/functions/v1/service-api/internal/member-cleanup/reconcile"].map(path => path + suffix);
const routeCounts: Record<string, number> = {};
const workerSecret = f.workerSecret;
assert.ok(typeof workerSecret === "string" && workerSecret.length >= 32);
const rpcNames = new Set(f.phase === "finalize" ? ["get_queue_invocation", "complete_queue_invocation"] : ["read_worker_run_budget", "begin_member_cleanup_reconcile", "get_member_cleanup_reconcile", "finish_member_cleanup_reconcile", "check_member_cleanup_task", "get_member_cleanup_delete_ack", "get_queue_invocation"]);
const rpcCounts: Record<string, number> = {}, statuses: Record<string, number[]> = {};
const rpcSqlCodes: Record<string, unknown[]> = {};
let immutableProof: string | undefined;
let forbidden = 0, external = 0, authGets = 0, storageGets = 0, lossInjected = false;
const storagePaths = f.objectName === null ? [] : ["/storage/v1/object/info/authenticated/profile-images/", "/storage/v1/object/authenticated/profile-images/"].map(prefix => prefix + f.objectName!.split("/").map(encodeURIComponent).join("/"));
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, cert: await Deno.readTextFile(f.root + "/https.crt"), key: await Deno.readTextFile(f.root + "/https.key"), onListen() {} }, async request => {
  try {
    const url = new URL(request.url); assert.equal(url.search, "");
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ status: "ready" });
    if (routes.includes(url.pathname)) {
      if (!runtime) return new Response(null, { status: 503 });
      routeCounts[url.pathname] = (routeCounts[url.pathname] ?? 0) + 1;
      return runtime(request);
    }
    const name = url.pathname.startsWith("/rest/v1/rpc/") ? url.pathname.slice("/rest/v1/rpc/".length) : null;
    if (name) {
      if (!rpcNames.has(name) || request.method !== "POST") { forbidden++; return new Response(null, { status: 403 }); }
      rpcCounts[name] = (rpcCounts[name] ?? 0) + 1;
    } else if (f.phase === "bridge" && url.pathname === "/auth/v1/admin/users/" + f.profileId && request.method === "GET") authGets++;
    else if (f.phase === "bridge" && storagePaths.includes(url.pathname) && request.method === "GET") storageGets++;
    else { forbidden++; return new Response(null, { status: 403 }); }
    const bytes = request.method === "GET" ? undefined : await request.arrayBuffer(); assert.ok(!bytes || bytes.byteLength <= 65536);
    const response = await nativeFetch(upstream.origin + url.pathname, { method: request.method, headers: request.headers, ...(bytes ? { body: bytes } : {}), redirect: "error", signal: AbortSignal.timeout(15000) });
    const label = name ?? (url.pathname.startsWith("/auth/") ? "auth_get" : "storage_get");
    (statuses[label] ??= []).push(response.status);
    if (name && !response.ok) (rpcSqlCodes[name] ??= []).push((await response.clone().json()).code);
    if (name === "get_member_cleanup_reconcile" && response.ok) {
      const proof = await response.clone().json();
      const fixed = JSON.stringify({ original: proof.original, recovery: proof.recovery });
      assert.ok(immutableProof === undefined || immutableProof === fixed);
      immutableProof ??= fixed;
    }
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
  } catch { return Response.json({ code: "ISOLATED_UPSTREAM_FAILED" }, { status: 503 }); }
});
const origin = "https://127.0.0.1:" + server.addr.port;
const client = Deno.createHttpClient({ caCerts: [await Deno.readTextFile(f.root + "/ca.crt")] });
const localFetch: typeof fetch = async (url, init) => {
  const u = new URL(url instanceof Request ? url.url : String(url));
  if (u.origin !== origin) { external++; throw new Error("EXTERNAL_DISABLED"); }
  const response = await nativeFetch(url, { ...init, client } as RequestInit & { client: Deno.HttpClient });
  const lossTarget = f.phase === "finalize" ? (f.scenario === "finalize_loss" ? "complete_queue_invocation" : null) : f.scenario === "begin_loss" ? "begin_member_cleanup_reconcile" : f.scenario === "finish_loss" ? "finish_member_cleanup_reconcile" : null;
  if (lossTarget && !lossInjected && u.pathname.endsWith("/" + lossTarget) && response.ok) {
    lossInjected = true; await response.body?.cancel(); throw new Error("CONTROLLED_ACKNOWLEDGEMENT_LOSS_AFTER_ACTUAL_RESPONSE");
  }
  return response;
};
const values: Record<string, string> = { SUPABASE_URL: origin, SUPABASE_ANON_KEY: f.anon, SUPABASE_SERVICE_ROLE_KEY: f.service, INTERNAL_WORKER_SECRET: workerSecret, ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "65536", UPSTREAM_TIMEOUT_MS: "15000" };
globalThis.fetch = localFetch;
const read = (key: string) => values[key];
let requestOrdinal = 0;
const body = f.phase === "finalize" ? { invocationRequestId: f.binding.invocationRequestId } : { recoveryRequestId: f.binding.recoveryRequestId, invocationRequestId: f.binding.invocationRequestId, taskId: f.binding.taskId };
const request = (secret = workerSecret, input: unknown = body) => localFetch(origin + routes[requestOrdinal++ % routes.length], {
  method: "POST", headers: { authorization: "Bearer " + secret, ...(f.phase === "bridge" ? { "x-worker-run-token": f.binding.recoveryGlobalToken } : {}), "content-type": "application/json" }, body: JSON.stringify(input),
});
const invoke = async () => {
  const response = await request(); assert.equal(response.status, 200);
  const envelope = await response.json(); assert.equal(envelope.requestId, response.headers.get("x-request-id"));
  return envelope.data;
};
const rpc = async (name: string, args: Record<string, string>) => {
  const response = await localFetch(origin + "/rest/v1/rpc/" + name, { method: "POST", headers: { authorization: "Bearer " + f.service, apikey: f.service, "content-type": "application/json" }, body: JSON.stringify(args) });
  assert.equal(response.status, 200); return await response.json();
};
try {
  const closed = createRuntimeHandler(read);
  for (const route of routes) {
    const response = await closed(new Request(origin + route, { method: "POST", headers: { authorization: "Bearer " + workerSecret, "content-type": "application/json", "x-worker-run-token": f.binding.recoveryGlobalToken }, body: "{}" }));
    assert.equal(response.status, 404);
  }
  assert.throws(() => createRuntimeHandler(read, { memberCleanupReconcile: { approved: false, decisionId: "synthetic115", maxExecutionMs: 60000 } as never }));
  assert.equal(Object.values(rpcCounts).reduce((a, b) => a + b, 0), 0);
  runtime = createRuntimeHandler(read, { memberCleanupReconcile: { approved: true, decisionId: "synthetic115", maxExecutionMs: 60000 } });
  await assert.rejects(nativeFetch(origin + "/health", { signal: AbortSignal.timeout(3000) }));
  assert.equal((await localFetch(origin + "/health")).status, 200);
  assert.equal((await request("synthetic-untrusted-member", { approved: true })).status, 403);
  assert.equal(Object.values(rpcCounts).reduce((a, b) => a + b, 0), 0);
  assert.equal((await request(workerSecret, { approved: true })).status, 400);
  assert.equal(Object.values(rpcCounts).reduce((a, b) => a + b, 0), 0);
  let applied = false, evidenceSha256: string | null = null;
  const blocked = f.scenario === "no_ack" || f.scenario === "begin_loss";
  const counts = { claimed: 1, succeeded: 1, retried: 0, failed: 0, superseded: 0, yielded: 0 };
  const initial = await rpc("get_queue_invocation", { p_request_id: f.binding.invocationRequestId });
  assert.equal(initial.state, "unknown"); assert.equal(initial.kind, "member_cleanup"); assert.equal(initial.globalToken, f.originalGlobalToken);
  if (f.phase === "finalize") {
    const result = await invoke();
    assert.deepEqual(result, blocked ? { status: "pending" } : { status: "completed", counts });
    applied = !blocked;
    assert.equal(rpcCounts.complete_queue_invocation, 1);
    if (blocked) assert.deepEqual(rpcSqlCodes.complete_queue_invocation, ["55000"]);
    else assert.deepEqual(statuses.complete_queue_invocation, [200]);
    const saved = await rpc("get_queue_invocation", { p_request_id: f.binding.invocationRequestId });
    assert.equal(saved.state, blocked ? "unknown" : "completed");
    for (const key of ["requestId", "globalToken", "kind", "limit", "remainingMs"]) assert.equal(saved[key], initial[key]);
    assert.deepEqual(saved.result, blocked ? null : { status: "ran", counts });
    if (!blocked) {
      const beforeReplay = { ...rpcCounts };
      assert.deepEqual(await invoke(), result);
      assert.equal(rpcCounts.complete_queue_invocation, beforeReplay.complete_queue_invocation);
      assert.equal(rpcCounts.get_queue_invocation, beforeReplay.get_queue_invocation + 1);
    }
    if (f.scenario === "finalize_loss") assert.ok(lossInjected);
    assert.equal(authGets + storageGets, 0);
    assert.equal(rpcCounts.read_worker_run_budget ?? 0, 0);
    assert.ok(Object.keys(rpcCounts).every(name => ["get_queue_invocation", "complete_queue_invocation"].includes(name)));
  } else if (f.scenario === "no_ack") {
    assert.equal((await request()).status, 404); assert.equal((await request()).status, 404);
    assert.deepEqual(rpcSqlCodes.begin_member_cleanup_reconcile, ["40001", "40001"]);
    assert.deepEqual(rpcSqlCodes.get_member_cleanup_reconcile, ["PT404", "PT404"]);
    assert.equal(authGets + storageGets, 0); assert.equal(rpcCounts.finish_member_cleanup_reconcile ?? 0, 0);
  } else if (f.scenario === "begin_loss") {
    assert.deepEqual(await invoke(), { status: "pending" });
    assert.deepEqual(await invoke(), { status: "pending" });
    assert.deepEqual(await invoke(), { status: "pending" });
    assert.equal(authGets + storageGets, 0); assert.equal(rpcCounts.finish_member_cleanup_reconcile ?? 0, 0); assert.ok(lossInjected);
  } else {
    const result = await invoke(); assert.equal(result.status, "applied"); if (result.status !== "applied") throw new Error("NO_COMPLETION_PROOF");
    applied = true; evidenceSha256 = result.evidenceSha256;
    const count = JSON.stringify(rpcCounts), gets = authGets + storageGets;
    assert.deepEqual(await invoke(), result);
    assert.equal(authGets + storageGets, gets);
    assert.deepEqual(await invoke(), result);
    assert.equal(authGets + storageGets, gets); assert.notEqual(JSON.stringify(rpcCounts), count);
    assert.equal(rpcCounts.finish_member_cleanup_reconcile, 1);
    if (f.scenario === "auth") { assert.equal(authGets, 1); assert.equal(storageGets, 0); }
    else { assert.equal(storageGets, 2); assert.equal(authGets, 0); }
    if (f.scenario === "finish_loss") assert.ok(lossInjected);
  }
  if (f.phase === "bridge") {
    assert.equal(rpcCounts.begin_member_cleanup_reconcile, f.scenario === "no_ack" ? 2 : 3);
    assert.equal(rpcCounts.read_worker_run_budget, f.scenario === "no_ack" ? 2 : 3);
    assert.equal(rpcCounts.complete_queue_invocation ?? 0, 0);
    const parent = await rpc("get_queue_invocation", { p_request_id: f.binding.invocationRequestId });
    assert.deepEqual(parent, initial);
  }
  assert.equal(forbidden + external, 0);
  assert.ok(routes.every(route => routeCounts[route] > 0));
  const receipt = { status: "PASS", scope: "RUNTIME_FACTORY_HTTPS_SQL115_BRIDGE", scenario: f.scenario, phase: f.phase, originEvidence: f.originEvidence, originalExternalDeleteAndAckProof: "NOT_RUN_SYNTHETIC_SQL_ORIGIN", originalExternalDeleteCount: 0, bridgeDeleteDispatchAckCount: 0, actualStorageGets: storageGets, actualAuthGets: authGets, actualRpcCounts: rpcCounts, upstreamStatusOnly: statuses, storedEvidenceSha256: evidenceSha256, taskCompleted: f.phase === "bridge" && applied, outerCompleted: f.phase === "finalize" && applied, originalUnknownPreserved: f.phase === "bridge" || !applied, sameKeyGetOnly: true, wrongCaRejected: true, controlledResponseLoss: lossInjected, forbiddenCalls: forbidden, externalRequests: external, frozenGraphSha256: f.frozenGraphSha256, operatingChanged: false, actualProductHttpComponent: true, actualRuntimeFactoryRouting: true, defaultFactory404: true, approvalFalseCreationRejected: true, actualRouteCounts: routeCounts, internalAuthenticationBeforeRpc: true, actualGlobalBudgetRead: f.phase === "bridge", finalizationBudgetReads: f.phase === "finalize" ? 0 : null, finalizationGlobalHeader: f.phase === "finalize" ? false : null, completedReplayCompleteCalls: f.phase === "finalize" && applied ? 0 : null, parentCompleteScope: "ACTUAL_RUNTIME_FACTORY_FINALIZE_HTTP", fullQueueCliAndDeployedProductHttp: "NOT_RUN", sourceStorageFileRestore: "NOT_RUN_MINIMUM_ABSENCE_GET_SCOPE" };
  const output = f.root + "/" + f.phase + "-http-observations.json";
  await Deno.writeTextFile(output, JSON.stringify(receipt), { mode: 0o600, createNew: true });
  console.log(JSON.stringify({ status: receipt.status, scope: receipt.scope, scenario: receipt.scenario, phase: f.phase, actualStorageGets: storageGets, actualAuthGets: authGets, bridgeDeleteDispatchAckCount: 0, originalExternalDeleteAndAckProof: receipt.originalExternalDeleteAndAckProof }));
} finally { globalThis.fetch = nativeFetch; client.close(); await server.shutdown(); }
