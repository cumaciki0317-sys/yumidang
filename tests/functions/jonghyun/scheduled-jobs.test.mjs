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
  completion: { completedCount: 1, appointments: [{ appointmentId: "fixture", completedAt: "2099-01-01T00:00:00Z" }], secret: "must-not-echo" },
  reviews: { publishedCount: 2, processedCount: 3, enqueuedCount: 1 },
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
  assert.deepEqual(body.data, { completion: { completedCount: 1 }, reviews: { publishedCount: 2, processedCount: 3, enqueuedCount: 1 } });
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

test("missing or invalid server versions blocks invocation without fixture fallback", async () => {
  for (const overrides of [{ REVIEW_SUMMARY_MODEL_VERSION: undefined }, { REVIEW_SUMMARY_PROMPT_VERSION: undefined }, { REVIEW_SUMMARY_PROMPT_VERSION: "unsafe version" }]) {
    let calls = 0;
    const handler = runtime(async () => { calls++; return Response.json(good); }, overrides);
    const response = await handler(request());
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "EXTERNAL_UNAVAILABLE");
    assert.equal(calls, 0);
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
    { data: { completion: { completedCount: -1 }, reviews: good.data.reviews } },
    { data: { completion: good.data.completion, reviews: { ...good.data.reviews, enqueuedCount: "1" } } }]) {
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
