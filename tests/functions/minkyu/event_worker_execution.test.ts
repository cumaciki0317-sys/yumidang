import assert from "node:assert/strict";
import test from "node:test";
import { withEventOperations, type EventWorkerRequest } from "../../../backend/supabase/functions/event-sync/operations.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { createEventOperations } from "../../../backend/supabase/functions/_shared/jobs/event-runtime.ts";

const token = "ab110000-0000-4000-8000-000000000001";
const id = "ab110000-0000-4000-8000-000000000002";
const headers = { "content-type": "application/json", "x-worker-run-token": token,
  "x-worker-request-id": id, "x-worker-max-jobs": "3", "x-worker-time-budget-ms": "12000" };
const url = "https://isolated.invalid/functions/v1/event-sync/worker";
function request(extra: RequestInit = {}) {
  return new Request(url, { method: "POST", body: "{}", headers, ...extra });
}
function fixture(options: { authenticate?: () => Promise<void>; resolve?: (input: EventWorkerRequest) => Promise<{ maxJobsPerRun: number; timeBudgetMs: number }> } = {}) {
  const calls: unknown[][] = [];
  const operations = { worker: async (...args: unknown[]) => { calls.push(args); return { status: "ran", counts: { claimed: 0 } }; } } as unknown as ReturnType<typeof createEventOperations>;
  return { calls, handle: withEventOperations(async () => new Response(null, { status: 404 }), {
    authenticate: options.authenticate ?? (async () => {}), maxBytes: 1024, operations,
    resolveSharedExecution: options.resolve,
  }) };
}

test("event allocation requires a trusted DB resolver and keeps the request signal", async () => {
  let resolved: EventWorkerRequest | undefined;
  const f = fixture({ resolve: async input => { resolved = input; return { maxJobsPerRun: 2, timeBudgetMs: 8000 }; } });
  const r = request();
  assert.equal((await f.handle(r)).status, 200);
  assert.deepEqual(resolved, { requestId: id, globalToken: token, maxJobsPerRun: 3, timeBudgetMs: 12000 });
  assert.deepEqual(f.calls[0], [token, r.signal, { maxJobsPerRun: 2, timeBudgetMs: 8000 }]);
});

test("event authentication precedes resolver and malformed allocation handling", async () => {
  let resolutions = 0;
  const f = fixture({ authenticate: async () => { throw new HttpError("AUTH_REQUIRED"); }, resolve: async () => { resolutions++; return { maxJobsPerRun: 3, timeBudgetMs: 12000 }; } });
  assert.equal((await f.handle(request({ headers: { ...headers, "x-worker-max-jobs": "bad" } }))).status, 401);
  assert.equal(resolutions, 0); assert.equal(f.calls.length, 0);
});

test("event scoped header cannot activate execution without the resolver", async () => {
  const f = fixture(); assert.equal((await f.handle(request())).status, 503); assert.equal(f.calls.length, 0);
});

test("event partial, noncanonical and over-limit allocations invoke no worker", async () => {
  for (const change of [{ "x-worker-request-id": null }, { "x-worker-max-jobs": "03" }, { "x-worker-max-jobs": "11" },
    { "x-worker-max-jobs": "0" }, { "x-worker-time-budget-ms": "60001" }, { "x-worker-run-token": "invalid" }]) {
    const h = new Headers(headers);
    for (const [name, value] of Object.entries(change)) value === null ? h.delete(name) : h.set(name, value);
    const f = fixture(); assert.equal((await f.handle(request({ headers: h }))).status, 400); assert.equal(f.calls.length, 0);
  }
});

test("event resolver cannot enlarge allocation or add fields", async () => {
  for (const allocation of [{ maxJobsPerRun: 4, timeBudgetMs: 12000 }, { maxJobsPerRun: 3, timeBudgetMs: 12001 },
    { maxJobsPerRun: 3, timeBudgetMs: 12000, approved: true }]) {
    const f = fixture({ resolve: async () => allocation });
    assert.equal((await f.handle(request())).status, 503); assert.equal(f.calls.length, 0);
  }
});

test("event DB conflict never starts the provider", async () => {
  const f = fixture({ resolve: async () => { throw new HttpError("STATE_CONFLICT"); } });
  assert.equal((await f.handle(request())).status, 409); assert.equal(f.calls.length, 0);
});

test("event abort before or during resolution never starts the provider", async () => {
  for (const early of [true, false]) {
    const controller = new AbortController(); let resolutions = 0;
    const f = fixture({ resolve: async () => { resolutions++; controller.abort(); return { maxJobsPerRun: 3, timeBudgetMs: 12000 }; } });
    if (early) controller.abort();
    assert.equal((await f.handle(request({ signal: controller.signal }))).status, 409);
    assert.equal(resolutions, early ? 0 : 1); assert.equal(f.calls.length, 0);
  }
});

test("event body cannot supply execution approval", async () => {
  const f = fixture(); assert.equal((await f.handle(request({ body: '{"approved":true}' }))).status, 400); assert.equal(f.calls.length, 0);
});

test("legacy event worker keeps its existing server default allocation", async () => {
  const f = fixture(); const r = request({ headers: { "content-type": "application/json", "x-worker-run-token": token } });
  assert.equal((await f.handle(r)).status, 200); assert.deepEqual(f.calls[0], [token, r.signal, undefined]);
});
