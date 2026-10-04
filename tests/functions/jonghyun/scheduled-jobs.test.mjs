import test from "node:test";
import assert from "node:assert/strict";
import { createScheduledJobsRuntime } from "../../../backend/supabase/functions/scheduled-jobs/index.ts";

const secret = "fixture_worker_" + "a".repeat(32);
const fixture = {
  SUPABASE_URL: "https://project.example.invalid", SUPABASE_ANON_KEY: "fixture-anon",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service", INTERNAL_WORKER_SECRET: secret,
  ALLOWED_ORIGINS: "[]", UPSTREAM_TIMEOUT_MS: "1000", MAX_REQUEST_BYTES: "1024",
  REVIEW_SUMMARY_MODEL_VERSION: "fixture-model", REVIEW_SUMMARY_PROMPT_VERSION: "review-summary-v1",
};
const good = { data: {
  status: "ok", completion: { status: "managed_by_reservation", appointments: [{ appointmentId: "fixture", completedAt: "2099-01-01T00:00:00Z" }], secret: "must-not-echo" },
  reviews: { status: "published", publishedCount: 2 },
  summary: { status: "queued", processedCount: 3, enqueuedCount: 1 },
}, requestId: "upstream-id", raw: "must-not-echo" };
function request(body = { limit: 7 }, token = secret, method = "POST", suffix = "") {
  return new Request("https://project.example.invalid/functions/v1/scheduled-jobs" + suffix, {
    method, headers: { "content-type": "application/json", ...(token == null ? {} : { authorization: "Bearer " + token }) },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}
function runtime(fetcher, overrides = {}) {
  const values = { ...fixture, ...overrides };
  return createScheduledJobsRuntime((key) => values[key], fetcher);
}

test("authenticated scheduler forwards explicit limit to fixed maintenance URL and projects only counts", async () => {
  const calls = [];
  const handler = runtime(async (url, init) => {
    calls.push({ url, init });
    return Response.json(good);
  });
  const response = await handler(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data, { status: "ok", completion: { status: "managed_by_reservation" }, reviews: { status: "published", publishedCount: 2 }, summary: { status: "queued", processedCount: 3, enqueuedCount: 1 } });
  assert.equal(body.requestId, response.headers.get("x-request-id"));
  assert.notEqual(body.requestId, good.requestId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, fixture.SUPABASE_URL + "/functions/v1/service-api/internal/maintenance");
  assert.equal(calls[0].init.headers.Authorization, "Bearer " + secret);
  assert.deepEqual(JSON.parse(calls[0].init.body), { limit: 7 });
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(!JSON.stringify(body).includes("must-not-echo"));
  assert.ok(!JSON.stringify(body).includes(secret));
});

test("missing credentials, user JWT and service key do not invoke maintenance", async () => {
  let calls = 0;
  const handler = runtime(async () => { calls++; return Response.json(good); });
  for (const [token, status] of [[null, 401], ["header.payload.signature", 403], [fixture.SUPABASE_SERVICE_ROLE_KEY, 403]]) {
    assert.equal((await handler(request({ limit: 1 }, token))).status, status);
  }
  assert.equal(calls, 0);
});

test("limit is mandatory and request cannot override URL, model, caller or operation", async () => {
  let calls = 0;
  const handler = runtime(async () => { calls++; return Response.json(good); });
  for (const body of [{}, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "1" },
    { limit: 1, url: "https://attacker.invalid" }, { limit: 1, modelVersion: "override" }, { limit: 1, userId: "spoof" }, { limit: 1, kind: "event_sync" }]) {
    assert.equal((await handler(request(body))).status, 400);
  }
  assert.equal((await handler(request({ limit: 1 }, secret, "GET"))).status, 405);
  assert.equal((await handler(request({ limit: 1 }, secret, "POST", "/other"))).status, 404);
  assert.equal((await handler(request({ limit: 1 }, secret, "POST", "?limit=2"))).status, 400);
  assert.equal(calls, 0);
});

test("missing, blank or invalid local model versions do not block the publication bridge", async () => {
  for (const overrides of [{ REVIEW_SUMMARY_MODEL_VERSION: undefined }, { REVIEW_SUMMARY_PROMPT_VERSION: undefined },
    { REVIEW_SUMMARY_MODEL_VERSION: "" }, { REVIEW_SUMMARY_PROMPT_VERSION: "unsafe version" }]) {
    let calls = 0;
    const handler = runtime(async () => { calls++; return Response.json(good); }, overrides);
    assert.equal((await handler(request())).status, 200);
    assert.equal(calls, 1);
  }
});

test("partial upstream state remains explicit and does not fabricate successful zero counts", async () => {
  for (const summary of [
    { status: "pending_configuration" }, { status: "configuration_error" },
    { status: "failed", code: "EXTERNAL_UNAVAILABLE", retryable: true },
  ]) {
    const data = { ...good.data, status: "partial", summary: { ...summary, raw: "must-not-echo" } };
    const handler = runtime(async () => Response.json({ data }));
    const response = await handler(request());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.status, "partial");
    assert.deepEqual(body.data.summary, summary);
    assert.deepEqual(body.data.reviews, { status: "published", publishedCount: 2 });
    assert.ok(!JSON.stringify(body).includes("must-not-echo"));
  }
});

test("upstream failure is safe and does not create hidden retry; next invocation is explicit", async () => {
  let calls = 0;
  const handler = runtime(async () => {
    calls++;
    return calls === 1 ? Response.json({ error: { message: "private SQL token secret" } }, { status: 503 }) : Response.json(good);
  });
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("private SQL"));
  assert.equal(calls, 1);
  assert.equal((await handler(request())).status, 200);
  assert.equal(calls, 2);
});

test("malformed successful upstream data never becomes a success response", async () => {
  for (const body of [{}, { data: { completion: {}, reviews: {} } }, { ...good, error: {} },
    { data: { ...good.data, reviews: { status: "published", publishedCount: -1 } } },
    { data: { ...good.data, summary: { ...good.data.summary, enqueuedCount: "1" } } },
    { data: { ...good.data, summary: { status: "pending_configuration" } } },
    { data: { ...good.data, status: "partial", summary: { status: "failed", code: "private SQL", retryable: true } } },
    { data: { ...good.data, status: "partial", summary: { status: "failed", code: "INTERNAL_ERROR", retryable: "true" } } },
    { data: { ...good.data, status: "partial" } },
    { data: { ...good.data, completion: { completedCount: 0 } } }]) {
    const handler = runtime(async () => Response.json(body));
    assert.equal((await handler(request())).status, 503);
  }
});

test("transport exceptions are redacted and internal secret configuration cannot reuse a public key", async () => {
  const handler = runtime(async () => { throw new Error("upstream token private detail"); });
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("private detail"));
  assert.throws(() => runtime(async () => Response.json(good), { INTERNAL_WORKER_SECRET: fixture.SUPABASE_ANON_KEY }));
});


test("정책 내부 정리는 최대20건이며 초과 요청은 일일/직접 경로 모두 외부 호출 전 거부한다", async () => {
  let calls = 0;
  const handler = runtime(async () => { calls++; return Response.json(good); });
  for (const suffix of ["", "/daily"]) {
    assert.equal((await handler(request({limit:21}, secret, "POST", suffix))).status, 400);
    assert.equal((await handler(request({limit:100}, secret, "POST", suffix))).status, 400);
  }
  assert.equal(calls,0);
  assert.equal((await handler(request({limit:20}))).status,200);
  assert.equal(calls,1);
});
