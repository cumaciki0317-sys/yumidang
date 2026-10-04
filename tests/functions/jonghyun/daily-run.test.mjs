// 24시간 일일 실행 묶음 가상 검사(총괄 작성, lane S 중단 후 이어받음). fetch·단계 의존성은 주입값이다.
import test from "node:test";
import assert from "node:assert/strict";
import { runDaily, loadDailySettings, dailyPeriod, DAILY_ENV, runEventPages } from "../../../backend/supabase/functions/_shared/jobs/daily.ts";
import { createScheduledJobsRuntime } from "../../../backend/supabase/functions/scheduled-jobs/index.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";

// 가상 수치(합성 검사 전용, 운영값 아님).
const eventsSettings = { providers: ["kopis"], timeZone: "Asia/Seoul", windowDays: 7, maxPages: 3, timeoutMs: 1000 };
const workerSettings = { maxInvocations: 1, timeoutMs: 1000 };
const counts = (n) => ({ claimed: n, succeeded: n, yielded: 0, deferred: 0, retryWait: 0, failed: 0, superseded: 0, leaseLost: 0 });
function deps(overrides = {}) {
  const log = [];
  const d = {
    maintenance: async () => { log.push("maintenance"); return { status: "ok" }; },
    eventSync: async (input) => { log.push(`event:${input.provider}:${input.page}:${input.period.start}..${input.period.end}`);
      return { status: "synced", provider: input.provider, fetchedCount: 5, savedCount: 5, hasMore: input.page < 2 }; },
    runEventCollections: async (settings) => runEventPages(d, settings),
    invokeSummaryWorker: async () => { log.push("worker"); return { status: "ran", stopReason: "idle", hasMore: false, counts: counts(1) }; },
    now: () => new Date("2026-10-04T16:30:00Z"), // 서울 기준 2026-10-05 01:30
    ...overrides,
  }; return { log, deps: d };
}

test("단계는 서로 독립: 공개 정리 실패가 행사·요약을 막지 않고 실패는 0건 성공으로 숨기지 않음", async () => {
  const { log, deps: d } = deps({ maintenance: async () => { throw new HttpError("EXTERNAL_UNAVAILABLE"); } });
  const result = await runDaily(d, { events: eventsSettings, summaryWorker: workerSettings });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.maintenance, { status: "failed", code: "EXTERNAL_UNAVAILABLE" });
  assert.equal(result.events.status, "ok");
  assert.equal(result.summaryWorker.status, "ok");
  assert.ok(log.includes("worker"));
});

test("행사: 설정 시간대 날짜부터 기간을 만들고 hasMore=false 또는 최대 페이지에서 멈춤, 공급사 실패는 failed", async () => {
  const { log, deps: d } = deps();
  const result = await runDaily(d, { events: eventsSettings, summaryWorker: "not_configured" });
  assert.deepEqual(result.events.period, { start: "2026-10-05", end: "2026-10-11" });
  assert.deepEqual(log.filter((x) => x.startsWith("event")), ["event:kopis:1:2026-10-05..2026-10-11", "event:kopis:2:2026-10-05..2026-10-11"]);
  const failing = deps({ eventSync: async () => { throw new HttpError("EXTERNAL_UNAVAILABLE"); } });
  const bad = await runDaily(failing.deps, { events: eventsSettings, summaryWorker: "not_configured" });
  assert.equal(bad.events.status, "failed");
  assert.equal(bad.events.providers[0].fetchedCount, 0);
  assert.notEqual(bad.status, "ok");
  const capped = deps({ eventSync: async (i) => ({ status: "synced", provider: i.provider, fetchedCount: 1, savedCount: 1, hasMore: true }) });
  const r = await runDaily(capped.deps, { events: { ...eventsSettings, maxPages: 2 }, summaryWorker: "not_configured" });
  assert.equal(r.events.providers[0].pages, 2);
  assert.equal(r.events.providers[0].hasMore, true);
});

test("요약 worker: 남은 작업이 있어도 등록 직후 한 번만 호출, not_enabled는 실패로 세지 않음", async () => {
  let n = 0;
  const more = deps({ invokeSummaryWorker: async () => { n++; return { status: "ran", stopReason: "max_jobs", hasMore: true, counts: counts(2) }; } });
  const r = await runDaily(more.deps, { events: "not_configured", summaryWorker: workerSettings });
  assert.equal(n, 1, "일일 등록 직후 호출은 한 번");
  assert.deepEqual([r.summaryWorker.invocations, r.summaryWorker.hasMore, r.summaryWorker.counts.claimed], [1, true, 2]);
  const disabled = deps({ invokeSummaryWorker: async () => ({ status: "not_enabled", reason: "SAFETY_CHECK_NOT_APPROVED" }) });
  const d = await runDaily(disabled.deps, { events: "not_configured", summaryWorker: workerSettings });
  assert.deepEqual(d.summaryWorker, { status: "not_enabled", reason: "SAFETY_CHECK_NOT_APPROVED" });
  assert.equal(d.status, "ok", "공개 정리만 실행된 정상 상태");
});

test("같은 날 두 번 실행해도 같은 기간·페이지를 요청한다(중복 방지는 DB upsert·작업 dedupe 계약)", async () => {
  const first = deps(), second = deps();
  await runDaily(first.deps, { events: eventsSettings, summaryWorker: workerSettings });
  await runDaily(second.deps, { events: eventsSettings, summaryWorker: workerSettings });
  assert.deepEqual(first.log, second.log);
});

test("설정 누락은 not_configured, 형식 오류는 configuration_error(기본값으로 대체하지 않음)", () => {
  assert.deepEqual(loadDailySettings(() => undefined), { events: "not_configured", summaryWorker: "not_configured" });
  const bad = { [DAILY_ENV.eventProviders]: "kopis", [DAILY_ENV.eventTimeZone]: "Mars/Base", [DAILY_ENV.eventWindowDays]: "7",
    [DAILY_ENV.eventMaxPages]: "1", [DAILY_ENV.eventTimeoutMs]: "1000", [DAILY_ENV.summaryMaxInvocations]: "0" };
  assert.deepEqual(loadDailySettings((k) => bad[k]), { events: "configuration_error", summaryWorker: "configuration_error" });
  assert.throws(() => dailyPeriod(new Date(NaN), "Asia/Seoul", 1));
});

test("HTTP /daily: 내부 인증, 고정 목적지만 호출, 하위 응답 원문·비밀을 전달하지 않음", async () => {
  const secret = "fixture_worker_" + "d".repeat(32);
  const env = { SUPABASE_URL: "https://project.example.invalid", SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    INTERNAL_WORKER_SECRET: secret, ALLOWED_ORIGINS: "[]", UPSTREAM_TIMEOUT_MS: "1000", MAX_REQUEST_BYTES: "1024",
    [DAILY_ENV.eventProviders]: "kopis", [DAILY_ENV.eventTimeZone]: "Asia/Seoul", [DAILY_ENV.eventWindowDays]: "1",
    [DAILY_ENV.eventMaxPages]: "1", [DAILY_ENV.eventTimeoutMs]: "1000", [DAILY_ENV.summaryMaxInvocations]: "1", [DAILY_ENV.summaryTimeoutMs]: "1000" };
  const urls = [];
  const fetcher = async (url, init) => {
    urls.push(url);
    assert.equal(init.headers.Authorization, "Bearer " + secret);
    if (url.endsWith("/service-api/internal/maintenance")) return Response.json({ requestId: "x", data: { status: "ok", completion: { status: "managed_by_reservation" },
      reviews: { status: "published", publishedCount: 1 }, summary: { status: "queued", processedCount: 1, enqueuedCount: 0 } } });
    if (url.endsWith("/event-sync/register")) return Response.json({requestId:"x",data:{status:"not_enabled",reason:"EVENT_COLLECTION_PERSISTENCE_NOT_CONNECTED"}});
    if (url.endsWith("/event-sync")) return Response.json({ requestId: "x", data: { status: "synced", provider: "kopis", fetchedCount: 5, savedCount: 5, hasMore: false } });
    if (url.endsWith("/review-summary-worker")) return Response.json({ requestId: "x", data: { status: "not_enabled", reason: "SAFETY_CHECK_NOT_APPROVED" } });
    throw new Error("unexpected destination");
  };
  const handler = createScheduledJobsRuntime((k) => env[k], fetcher, { now: () => new Date("2026-10-04T16:30:00Z") });
  const request = (token) => new Request("https://project.example.invalid/functions/v1/scheduled-jobs/daily",
    { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ limit: 10 }) });
  assert.equal((await handler(request("wrong_" + "e".repeat(40)))).status, 403);
  assert.equal(urls.length, 0);
  const response = await handler(request(secret));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.status, "ok");
  assert.deepEqual(body.data.events, { status: "not_enabled", reason: "EVENT_COLLECTION_PERSISTENCE_NOT_CONNECTED" });
  assert.deepEqual(body.data.summaryWorker, { status: "not_enabled", reason: "SAFETY_CHECK_NOT_APPROVED" });
  assert.deepEqual(urls.map((u) => new URL(u).pathname), ["/functions/v1/service-api/internal/maintenance", "/functions/v1/event-sync/register", "/functions/v1/review-summary-worker"]);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
});
