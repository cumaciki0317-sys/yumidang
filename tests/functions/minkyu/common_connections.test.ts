/** 민규담당. 종현 기존 코어와 공통 client의 가상 전송 연결. 실제 외부 모델·공급사는 호출하지 않는다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
import { parseEventQuery } from "../../../backend/supabase/functions/service-api/events-http.ts";
import { loadRuntimeConfig, requireInternalConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { requirePrincipal } from "../../../backend/supabase/functions/_shared/auth/principal.ts";
import { createUserClient } from "../../../backend/supabase/functions/_shared/db/user-client.ts";
import { createInternalClient } from "../../../backend/supabase/functions/_shared/db/internal-client.ts";
import { createPublicClient } from "../../../backend/supabase/functions/_shared/db/public-client.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import { createEventSyncRuntime } from "../../../backend/supabase/functions/event-sync/index.ts";
import { createReviewSummaryWorkerRuntime, REVIEW_SUMMARY_WORKER_ENV } from "../../../backend/supabase/functions/review-summary-worker/index.ts";
import { REVIEW_SUMMARY_PROMPT_VERSION } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/prompts.ts";
import { createAiChatRuntime } from "../../../backend/supabase/functions/ai-chat/index.ts";
import { AI_CHAT_ENV } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/settings.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const token = "header.payload.signature", secret = "synthetic_worker_" + "a".repeat(32);
const env: Record<string, string> = { SUPABASE_URL: "https://project.example.test", SUPABASE_ANON_KEY: "synthetic-anon", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service",
  INTERNAL_WORKER_SECRET: secret, ALLOWED_ORIGINS: '["https://app.example.test"]', MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "1000" };
const config = { supabaseUrl: env.SUPABASE_URL, supabaseAnonKey: env.SUPABASE_ANON_KEY, supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  internalWorkerSecret: secret, allowedOrigins: [], maxRequestBytes: 8192, upstreamTimeoutMs: 1000 };
type Call = { url: string; args: unknown; bearer: string | null };
async function runtimeTest(run: (send: (path: string, authorization?: string, method?: string) => Promise<Response>, calls: Call[]) => Promise<void>, reply: (name: string, args: Record<string, JsonValue>) => JsonValue = () => ({ items: [], nextCursor: null })) {
  const previous = globalThis.fetch, calls: Call[] = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url), bearer = new Headers(init?.headers).get("authorization"), args = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: path, args, bearer });
    if (path.endsWith("/auth/v1/user")) return bearer === `Bearer ${token}` ? Response.json({ id, role: "authenticated", is_anonymous: false }) : Response.json({ code: "invalid" }, { status: 401 });
    assert.ok(path.startsWith(`${env.SUPABASE_URL}/rest/v1/rpc/`));
    return Response.json(reply(path.split("/").at(-1)!, args));
  };
  try {
    const handler = createRuntimeHandler(key => env[key]);
    await run((path, authorization, method = "GET") => handler(new Request(`https://api.example.test/functions/v1/service-api${path}`, {
      method, headers: { origin: "https://app.example.test", ...(authorization === undefined ? {} : { authorization }) },
    })), calls);
  } finally { globalThis.fetch = previous; }
}

test("익명 행사 목록은 신규 기본 모드·명시 limit과 익명 client로 종현 RPC 저장소를 실행한다", async () => {
  await runtimeTest(async (send, calls) => {
    const response = await send("/events?limit=2");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { events: [], nextCursor: null });
    assert.deepEqual(calls, [{ url: `${env.SUPABASE_URL}/rest/v1/rpc/list_public_events`, bearer: `Bearer ${env.SUPABASE_ANON_KEY}`,
      args: { p_filters: { mode: "new_this_week", ongoingOnly: false }, p_cursor: null, p_limit: 2 } }]);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.test");
  });
});

test("회원 행사 조회는 Auth 검증 이후 같은 사용자 JWT로 지역·분류·기간을 전달한다", async () => {
  await runtimeTest(async (send, calls) => {
    assert.equal((await send("/events?mode=overlapping&periodStart=2099-01-01&periodEnd=2099-01-31&ongoingOnly=false&region=서울&category=전시&query=ART&limit=3", `Bearer ${token}`)).status, 200);
    assert.equal(calls[0].url, `${env.SUPABASE_URL}/auth/v1/user`);
    assert.deepEqual(calls[1].args, { p_filters: { mode: "overlapping", ongoingOnly: false, period: { start: "2099-01-01", end: "2099-01-31" }, region: "서울", category: "전시", query: "art" }, p_cursor: null, p_limit: 3 });
    assert.equal(calls[1].bearer, `Bearer ${token}`);
  });
});

test("행사 선택 모드·진행중만 필터와 진행중 포함 표현을 서로 구분한다", () => {
  const parse = (query: string) => parseEventQuery(new URL(`https://api.example.test/events?${query}`));
  assert.deepEqual(parse("mode=post_selection&ongoingOnly=true&limit=5"), { query: { mode: "post_selection", ongoingOnly: true }, limit: 5 });
  assert.deepEqual(parse("mode=overlapping&periodStart=2026-09-28&periodEnd=2026-10-04&limit=5"), { query: { mode: "overlapping", period: { start: "2026-09-28", end: "2026-10-04" } }, limit: 5 });
});

test("진행중 포함은 선택 기간 겹침으로 장기 진행·신규 예정 행사를 함께 반환한다", async () => {
  const common = { provider: "kopis", sourceStatus: "active", title: "가상 행사", category: "전시", region: "서울", placeName: null, publicAddress: null,
    admission: { kind: "unknown" }, sourceUrl: null, collectedAt: "2026-10-02T00:00:00Z", precision: "date" };
  const items = [{ ...common, id, sourceId: "long", state: "ongoing", startsOn: "2026-09-01", endsOn: "2026-10-31" },
    { ...common, id: otherId, sourceId: "new", state: "upcoming", startsOn: "2026-10-03", endsOn: "2026-10-04" }];
  await runtimeTest(async send => {
    const response = await send("/events?mode=overlapping&periodStart=2026-09-28&periodEnd=2026-10-04&limit=2");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.events.map((event: { sourceId: string }) => event.sourceId), ["long", "new"]);
  }, () => ({ items, nextCursor: null }));
});

test("행사 조회는 누락 limit·query 주입·중복·비정상 달력·조건 커서를 SQL 전에 거절한다", async () => {
  await runtimeTest(async (send, calls) => {
    for (const query of ["", "?limit=0", "?limit=51", "?limit=1e1", "?limit=1&limit=2", "?limit=2&userId=x", "?limit=2&provider=kopis",
      "?limit=2&periodStart=2099-01-01", "?limit=2&periodStart=2099-02-30&periodEnd=2099-03-02", "?limit=2&ongoingOnly=1", "?limit=2&mode=all", "?limit=2&cursor=!!!"])
      assert.equal((await send(`/events${query}`)).status, 400, query);
    assert.equal(calls.length, 0);
  });
});

test("행사 필터 목록은 실제 제공처·원문 값·횟수를 저장소 검사 후 반환한다", async () => {
  const result = { regions: [{ provider: "kopis", value: "서울특별시", count: 2 }], categories: [{ provider: "tour-api", value: "A0207", count: 1 }] };
  await runtimeTest(async (send, calls) => {
    assert.deepEqual((await (await send("/events/filters")).json()).data, result);
    assert.equal(calls[0].url, `${env.SUPABASE_URL}/rest/v1/rpc/list_event_filter_values`);
    assert.equal((await send("/events/filters?region=x")).status, 400);
    assert.equal(calls.length, 1);
  }, () => result);
});

test("행사 DB 응답 위반은 입력400·빈 성공으로 강등하지 않는다", async () => {
  await runtimeTest(async send => assert.equal((await send("/events?limit=1")).status, 500), () => ({ items: [], nextCursor: null, secret: "never-echo" }));
  await runtimeTest(async send => assert.equal((await send("/events/filters")).status, 500), () => ({ regions: [{ provider: "kopis", value: "서울", count: -1 }], categories: [] }));
});

test("위조·빈·서버 키 Auth는 익명 행사 조회로 재시도하지 않는다", async () => {
  await runtimeTest(async (send, calls) => {
    for (const auth of ["", "Bearer wrong", `Bearer ${env.SUPABASE_ANON_KEY}`, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Bearer aaa.bbb.ccc"])
      assert.equal((await send("/events?limit=2", auth)).status, 401);
    assert.ok(calls.every(call => call.url.endsWith("/auth/v1/user")));
  });
});

test("행사·필터 경로는 메서드·prefix·encoding·불필요한 후행 경로를 제한한다", async () => {
  await runtimeTest(async (send, calls) => {
    for (const path of ["/events?limit=2", "/events/filters"]) {
      assert.equal((await send(path, undefined, "POST")).status, 405);
      assert.equal((await send(path, undefined, "DELETE")).status, 405);
    }
    for (const path of ["/%65vents?limit=2", "/events/", "/events/unknown", "//events?limit=2"])
      assert.equal((await send(path)).status, 404);
    assert.equal(calls.length, 0);
  });
});

test("공개 프로필은 회원 전용 RPC로 성향·마스킹·완료 횟수를 반환하고 본인 조회는 유지한다", async () => {
  const result = { profileId: otherId, displayName: "민*", age: 24, gender: "female", avatarPath: null, bio: null,
    interests: ["전시"], conversationStyles: [], mbti: "INTJ", completedCount: 2 };
  await runtimeTest(async (send, calls) => {
    assert.deepEqual((await (await send(`/profiles/${otherId}`, `Bearer ${token}`)).json()).data, result);
    assert.equal(calls[1].url, `${env.SUPABASE_URL}/rest/v1/rpc/get_public_profile`);
    assert.deepEqual(calls[1].args, { p_profile_id: otherId });
    assert.equal((await send(`/profiles/${otherId}`)).status, 401);
    assert.equal((await send(`/profiles/${otherId}?userId=${id}`, `Bearer ${token}`)).status, 400);
    assert.equal((await send(`/profiles/${otherId}`, `Bearer ${token}`, "POST")).status, 405);
    await send("/me", `Bearer ${token}`);
    assert.equal(calls.at(-1)!.url, `${env.SUPABASE_URL}/rest/v1/rpc/get_my_profile`);
  }, () => result);
});

test("R2 client 허용 목록은 실제 전송을 허용하고 다른 역할·운영 설정 RPC는 차단한다", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push(String(url)); return Response.json({ ok: true }); };
  const principal = await requirePrincipal(new Request("https://app.example.test", { headers: { authorization: `Bearer ${token}` } }), config,
    async () => Response.json({ id, role: "authenticated", is_anonymous: false }));
  const user = createUserClient(config, principal, fetcher), anonymous = createPublicClient(config, fetcher), internal = createInternalClient(config, fetcher);
  const newInternal = ["reserve_ai_budget", "settle_ai_budget", "yield_job", "fail_job", "supersede_job", "load_review_summary_source", "load_review_summary_checkpoint", "save_review_summary_checkpoint", "discard_review_summary_checkpoint", "mark_review_summary_insufficient", "publish_review_summary_for_job", "upsert_events"];
  for (const name of newInternal) await internal.rpc(name, {});
  for (const client of [user, anonymous]) for (const name of ["list_public_events", "list_event_filter_values"]) await client.rpc(name, {});
  await user.rpc("get_public_profile", { p_profile_id: id });
  assert.equal(calls.length, 17);
  for (const client of [user, anonymous]) for (const name of newInternal) await assert.rejects(client.rpc(name, {}), error => toPublicError(error).error.code === "ACCESS_DENIED");
  for (const client of [user, anonymous, internal]) for (const name of ["configure_ai_budget_ledger", "get_ai_budget_ledger", "unknown_rpc"])
    await assert.rejects(client.rpc(name, {}), error => toPublicError(error).error.code === "ACCESS_DENIED");
  await assert.rejects(anonymous.rpc("get_public_profile", {}), error => toPublicError(error).error.code === "ACCESS_DENIED");
  assert.equal(calls.length, 17);
});

test("빈 내부·AI 설정은 공개 기능을 막지 않으며 내부 호출은 계속 미설정으로 거절한다", async () => {
  const values = { ...env, SUPABASE_SERVICE_ROLE_KEY: "", INTERNAL_WORKER_SECRET: "", REVIEW_SUMMARY_MODEL_VERSION: "", AI_CHAT_MAX_MESSAGES: "" };
  const reads: Record<string, number> = {};
  const parsed = loadRuntimeConfig(key => { reads[key] = (reads[key] ?? 0) + 1; return values[key]; });
  assert.equal(parsed.supabaseServiceRoleKey, undefined); assert.equal(parsed.internalWorkerSecret, undefined);
  assert.equal(reads.SUPABASE_SERVICE_ROLE_KEY, 1); assert.equal(reads.INTERNAL_WORKER_SECRET, 1);
  assert.throws(() => requireInternalConfig(parsed), error => toPublicError(error).error.code === "EXTERNAL_UNAVAILABLE");
  const previous = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith("/auth/v1/user") ? Response.json({ id, role: "authenticated", is_anonymous: false })
    : Response.json(String(url).endsWith("/get_my_profile") ? { id } : { items: [], nextCursor: null });
  try {
    const handler = createRuntimeHandler(key => values[key]);
    assert.equal((await handler(new Request("https://api.example.test/service-api/events?limit=2"))).status, 200);
    assert.equal((await handler(new Request("https://api.example.test/service-api/me", { headers: { authorization: `Bearer ${token}` } }))).status, 200);
    assert.equal((await handler(new Request("https://api.example.test/service-api/internal/maintenance", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: '{"limit":1}' }))).status, 503);
  } finally { globalThis.fetch = previous; }
  for (const value of [" ", "bad\nvalue", " bad"]) assert.throws(() => loadRuntimeConfig(key => key === "INTERNAL_WORKER_SECRET" ? value : env[key]), error => toPublicError(error).error.code === "EXTERNAL_UNAVAILABLE");
  assert.throws(() => loadRuntimeConfig(key => key === "SUPABASE_ANON_KEY" ? "" : env[key]), error => toPublicError(error).error.code === "EXTERNAL_UNAVAILABLE");
});

test("종현 event-sync 기본 런타임은 가상 HTTPS 수집 후 실제 내부 client로 저장한다", async () => {
  const values = { ...env, KOPIS_API_KEY: "synthetic-key", EVENT_SYNC_PROVIDERS: "kopis", EVENT_SYNC_MAX_PERIOD_DAYS: "7", EVENT_SYNC_MAX_PAGE: "3", EVENT_SYNC_PAGE_ROWS: "2" };
  const calls: string[] = [];
  const handler = createEventSyncRuntime(key => values[key], async (url, init) => {
    const path = String(url); calls.push(path);
    if (path.startsWith("https://kopis.or.kr/")) return new Response('<?xml version="1.0" encoding="UTF-8"?><dbs><db><mt20id>PF1</mt20id><prfnm>가상 공연</prfnm><prfpdfrom>2026.10.05</prfpdfrom><prfpdto>2026.10.06</prfpdto><fcltynm>가상 극장</fcltynm><area>서울특별시</area><genrenm>연극</genrenm><prfstate>공연예정</prfstate></db></dbs>', { headers: { "content-type": "application/xml" } });
    assert.equal(path, `${env.SUPABASE_URL}/rest/v1/rpc/upsert_events`);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    assert.equal(JSON.parse(String(init?.body)).p_events[0].sourceId, "PF1");
    return Response.json({ receivedCount: 1, insertedCount: 1, updatedCount: 0, staleCount: 0 });
  }, { now: () => new Date("2026-10-02T00:00:00Z") });
  const response = await handler(new Request("https://api.example.test/event-sync", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ provider: "kopis", period: { start: "2026-10-05", end: "2026-10-11" }, page: 1 }) }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { status: "synced", provider: "kopis", fetchedCount: 1, savedCount: 1, hasMore: false });
  assert.equal(calls.length, 2);
});

test("종현 worker는 실제 내부 client로 접근 확인 후 claim까지 도달하며 승인 없는 모델은 호출하지 않는다", async () => {
  const worker = Object.fromEntries(Object.values(REVIEW_SUMMARY_WORKER_ENV).map(key => [key, "5"]));
  worker.REVIEW_SUMMARY_LEASE_SECONDS = "60"; worker.REVIEW_SUMMARY_WORKER_TIME_BUDGET_MS = "1000";
  const values = { ...env, ...worker, REVIEW_SUMMARY_MODEL_VERSION: "potens.claude-5-sonnet", REVIEW_SUMMARY_PROMPT_VERSION };
  const names: string[] = [];
  const handler = createReviewSummaryWorkerRuntime(key => values[key], {
    createModel: () => ({ status: "ready", modelVersion: "potens.claude-5-sonnet", model: { async generate() { throw new Error("must not generate"); } } }),
    safety: { async check() { return true; } }, workerId: () => id,
    fetch: async (url, init) => {
      const name = String(url).split("/").at(-1)!; names.push(name);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
      if (["yield_job", "fail_job", "supersede_job"].includes(name)) return Response.json({ code: "40001" }, { status: 409 });
      return Response.json(name === "claim_job" ? { job: null } : { status: "lease_lost" });
    },
  });
  const response = await handler(new Request("https://api.example.test/review-summary-worker", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: "{}" }));
  assert.equal(response.status, 200);
  const result = (await response.json()).data;
  assert.equal(result.status, "ran"); assert.equal(result.stopReason, "idle");
  assert.deepEqual(names, ["load_review_summary_source", "load_review_summary_checkpoint", "save_review_summary_checkpoint", "discard_review_summary_checkpoint", "mark_review_summary_insufficient", "publish_review_summary_for_job", "yield_job", "fail_job", "supersede_job", "claim_job"]);
});

test("AI 탐색 기본 런타임은 성향·행사 사용자 client와 예산 내부 client로 가상 모델을 연결한다", async () => {
  const settings = Object.fromEntries(Object.values(AI_CHAT_ENV).map(key => [key, "5"]));
  settings.AI_CHAT_MAX_MESSAGE_CHARS = "1000"; settings.AI_CHAT_MAX_TOTAL_CHARS = "2000";
  const values = { ...env, ...settings, POTENS_API_KEY: "synthetic-key", POTENS_API_BASE_URL: "https://ai.potens.ai", POTENS_MODEL: "claude-5-sonnet",
    AI_RETENTION_DECISION_ID: "synthetic-only", AI_COST_EVIDENCE_ID: "synthetic-only", AI_BUDGET_LEDGER_ID: "synthetic-ledger" };
  const calls: Array<[string, string | null]> = [];
  const handler = createAiChatRuntime(key => values[key], async (url, init) => {
    const path = String(url), name = path.split("/").at(-1)!; calls.push([name, new Headers(init?.headers).get("authorization")]);
    if (path.endsWith("/auth/v1/user")) return Response.json({ id, role: "authenticated", is_anonymous: false });
    if (path === "https://ai.potens.ai/api/chat") return Response.json({ message: JSON.stringify({ status: "search", filters: { target: "events", newThisWeek: true } }), token_usage: {} });
    if (name === "get_my_profile_traits") return Response.json({ interests: [], conversationStyles: [], mbti: null });
    if (name === "reserve_ai_budget") return Response.json({ reservationId: otherId });
    if (name === "settle_ai_budget") return Response.json({ settled: true });
    assert.equal(name, "list_public_events"); return Response.json({ items: [], nextCursor: null });
  }, { now: () => new Date("2026-10-02T00:00:00Z") });
  const response = await handler(new Request("https://api.example.test/ai-chat", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: "synthetic1", messages: [{ role: "user", content: "이번 주 행사를 찾아줘" }], currentFilters: { target: "events" } }) }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, "no_results");
  for (const name of ["get_my_profile_traits", "list_public_events"]) assert.ok(calls.some(call => call[0] === name && call[1] === `Bearer ${token}`));
  for (const name of ["reserve_ai_budget", "settle_ai_budget"]) assert.ok(calls.some(call => call[0] === name && call[1] === `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`));
});
