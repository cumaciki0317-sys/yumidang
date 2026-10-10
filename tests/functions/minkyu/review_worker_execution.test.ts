import assert from "node:assert/strict";
import test from "node:test";
import { createReviewSummaryWorkerHandler, type ReviewSummaryWorkerDependencies } from "../../../backend/supabase/functions/review-summary-worker/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";

const requestId = "00000000-0000-4000-8000-000000000011";
const globalToken = "00000000-0000-4000-8000-000000000012";
const headers = { "content-type": "application/json", "x-worker-run-token": globalToken,
  "x-worker-request-id": requestId, "x-worker-max-jobs": "7", "x-worker-time-budget-ms": "1234" };
const idle = { status: "not_enabled", reason: "MODEL_MEMBER_TRANSMISSION_NOT_APPROVED" } as const;
function request(extra: Record<string, string> = {}, body = "{}", signal?: AbortSignal) {
  return new Request("https://test.invalid/review-summary-worker", { method: "POST", headers: { ...headers, ...extra }, body, signal });
}
function factory(overrides: Partial<ReviewSummaryWorkerDependencies> = {}) {
  return createReviewSummaryWorkerHandler({ allowedOrigins: [], maxBodyBytes: 65536,
    authenticateInternal: async () => {}, run: async () => idle, ...overrides });
}

test("scoped headers require an authenticated DB resolution and pass the same cancellation signal", async () => {
  const order: string[] = [];
  const req = request();
  const run = factory({ authenticateInternal: async () => { order.push("auth"); },
    resolveSharedExecution: async input => { order.push("resolve"); assert.deepEqual(input, { requestId, globalToken, maxJobsPerRun: 7, timeBudgetMs: 1234 }); return { maxJobsPerRun: 5, timeBudgetMs: 900 }; },
    run: async (token, execution) => { order.push("run"); assert.equal(token, globalToken); assert.deepEqual(execution, { maxJobsPerRun: 5, timeBudgetMs: 900, signal: req.signal }); return idle; } });
  assert.equal((await run(req)).status, 200);
  assert.deepEqual(order, ["auth", "resolve", "run"]);
});

test("headers cannot enable a missing DB contract or inflate the verified allocation", async () => {
  let runs = 0;
  const run = async () => { runs++; return idle; };
  assert.equal((await factory({ run })(request())).status, 503);
  for (const approved of [{ maxJobsPerRun: 8, timeBudgetMs: 1000 }, { maxJobsPerRun: 5, timeBudgetMs: 1235 },
    { maxJobsPerRun: -1, timeBudgetMs: 0 }, { maxJobsPerRun: 1.5, timeBudgetMs: 1 },
    { maxJobsPerRun: 5, timeBudgetMs: 1000, approved: true }]) {
    assert.equal((await factory({ run, resolveSharedExecution: async () => approved })(request())).status, 503);
  }
  assert.equal(runs, 0);
});

test("partial and noncanonical allocations are rejected before DB resolution", async () => {
  let calls = 0;
  const run = factory({ resolveSharedExecution: async () => { calls++; return { maxJobsPerRun: 1, timeBudgetMs: 1 }; } });
  for (const [header, value] of [["x-worker-max-jobs", "21"], ["x-worker-max-jobs", "07"], ["x-worker-max-jobs", "1.0"],
    ["x-worker-max-jobs", "-1"], ["x-worker-time-budget-ms", "180001"], ["x-worker-time-budget-ms", "Infinity"],
    ["x-worker-request-id", "not-a-uuid"]]) assert.equal((await run(request({ [header]: value }))).status, 400);
  for (const header of ["x-worker-run-token", "x-worker-request-id", "x-worker-time-budget-ms", "x-worker-max-jobs"]) {
    const req = request(); req.headers.delete(header);
    assert.equal((await run(req)).status, 400);
  }
  assert.equal(calls, 0);
});

test("auth rejection and DB mismatch do not execute or expose verifier details", async () => {
  let calls = 0;
  const run = async () => { calls++; return idle; };
  assert.equal((await factory({ run, authenticateInternal: async () => { throw new HttpError("AUTH_REQUIRED"); } })(request())).status, 401);
  const response = await factory({ run, resolveSharedExecution: async () => { throw new Error("PRIVATE_DATABASE_DIAGNOSTIC"); } })(request());
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes("PRIVATE_DATABASE_DIAGNOSTIC"), false);
  assert.equal(calls, 0);
});

test("execution remains server controlled with empty body and pre-resolve or post-resolve abort", async () => {
  let calls = 0;
  const run = async () => { calls++; return idle; };
  const controller = new AbortController(); controller.abort();
  assert.equal((await factory({ run, resolveSharedExecution: async () => ({ maxJobsPerRun: 1, timeBudgetMs: 1 }) })(request({}, "{}", controller.signal))).status, 409);
  const after = new AbortController();
  assert.equal((await factory({ run, resolveSharedExecution: async () => { after.abort(); return { maxJobsPerRun: 1, timeBudgetMs: 1 }; } })(request({}, "{}", after.signal))).status, 409);
  assert.equal((await factory({ run })(request({}, '{"maxJobs":20,"approved":true}'))).status, 400);
  assert.equal(calls, 0);
});

test("existing independent internal requests retain empty-body compatibility", async () => {
  const req = request();
  for (const header of ["x-worker-request-id", "x-worker-max-jobs", "x-worker-time-budget-ms"]) req.headers.delete(header);
  assert.equal((await factory({ run: async (token, execution) => { assert.equal(token, globalToken); assert.equal(execution, undefined); return idle; } })(req)).status, 200);
});
