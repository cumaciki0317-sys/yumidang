import assert from "node:assert/strict";
import test from "node:test";
import { createEventSyncRuntime } from "../../../backend/supabase/functions/event-sync/index.ts";
import { createEventSyncHandler, mapEventSyncError } from "../../../backend/supabase/functions/event-sync/handler.ts";
import { createRpcEventRepository } from "../../../backend/supabase/functions/_shared/db/repositories/events.ts";
import { EventProviderError } from "../../../backend/supabase/functions/_shared/integrations/events/port.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";

// 가상 KOPIS 응답·가상 RPC로 HTTP·저장 연결을 검사한다. 실제 DB/Edge 검증이 아니다.
const SECRET = "s".repeat(40);
const KOPIS_KEY = "SYNTHETIC-KOPIS-KEY";
const baseEnv = {
  SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_ANON_KEY: "synthetic-anon", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service",
  INTERNAL_WORKER_SECRET: SECRET, UPSTREAM_TIMEOUT_MS: "1000", MAX_REQUEST_BYTES: "4096", ALLOWED_ORIGINS: "[]",
  KOPIS_API_KEY: KOPIS_KEY, EVENT_SYNC_PROVIDERS: "kopis", EVENT_SYNC_MAX_PERIOD_DAYS: "7", EVENT_SYNC_MAX_PAGE: "3",
  EVENT_SYNC_PAGE_ROWS: "2",
};
const decl = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
const db = (id, extra = "") => `<db><mt20id>${id}</mt20id><prfnm>가상 ${id}</prfnm><prfpdfrom>2026.10.05</prfpdfrom><prfpdto>2026.10.06</prfpdto><fcltynm>가상 극장</fcltynm><area>서울특별시</area><genrenm>연극</genrenm><prfstate>공연예정</prfstate>${extra}</db>`;
const xml = (body) => new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
const body = { provider: "kopis", period: { start: "2026-10-05", end: "2026-10-11" }, page: 1 };
const post = (payload, { auth = SECRET, path = "/functions/v1/event-sync", type = "application/json" } = {}) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), "Content-Type": type },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
async function read(response) {
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}
function fakeRpc(respond) {
  const calls = [];
  return { calls, client: { async rpc(name, args) { calls.push({ name, args }); return respond(name, args); } } };
}
const upsertOk = (name, args) => ({ receivedCount: args.p_events.length, insertedCount: args.p_events.length, updatedCount: 0, staleCount: 0 });

function runtime({ env = {}, kopis = () => xml(`${decl}<dbs>${db("PF1")}${db("PF2")}</dbs>`), rpc = upsertOk, inject = true } = {}) {
  const fetches = [];
  const fetch = async (url, init) => {
    fetches.push({ url: new URL(url), init });
    if (url.startsWith("https://kopis.or.kr/")) return kopis(new URL(url), init);
    return new Response(JSON.stringify({ code: "unexpected" }), { status: 500 });
  };
  const fake = fakeRpc(rpc);
  const merged = { ...baseEnv, ...env };
  const handler = createEventSyncRuntime((key) => merged[key], fetch, {
    ...(inject ? { createRpcClient: () => fake.client } : {}), now: () => new Date("2026-09-29T13:00:00.000Z"),
  });
  return { handler, fetches, rpcCalls: fake.calls };
}

test("내부 인증 후 한 페이지 조회→저장, 응답은 집계만", async () => {
  const { handler, fetches, rpcCalls } = runtime();
  const res = await read(await handler(post(body)));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { status: "synced", provider: "kopis", fetchedCount: 2, savedCount: 2, hasMore: true });
  assert.equal(fetches.length, 1);
  const { url, init } = fetches[0];
  assert.equal(url.origin + url.pathname, "https://kopis.or.kr/openApi/restful/pblprfr");
  assert.deepEqual(Object.fromEntries(url.searchParams), { service: KOPIS_KEY, stdate: "20261005", eddate: "20261011", cpage: "1", rows: "2" });
  assert.equal(init.redirect, "error");
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, "upsert_events");
  assert.deepEqual(rpcCalls[0].args.p_events.map((e) => [e.provider, e.sourceId, e.collectedAt, e.sourceUrl, e.admission.kind]),
    [["kopis", "PF1", "2026-09-29T13:00:00.000Z", null, "unknown"], ["kopis", "PF2", "2026-09-29T13:00:00.000Z", null, "unknown"]]);
  assert.equal(res.text.includes(KOPIS_KEY), false);
  // 부분 페이지 → hasMore false. /event-sync 경로도 허용.
  const partial = runtime({ kopis: () => xml(`${decl}<dbs>${db("PF1")}</dbs>`) });
  const second = await read(await partial.handler(post(body, { path: "/event-sync" })));
  assert.deepEqual(second.body.data, { status: "synced", provider: "kopis", fetchedCount: 1, savedCount: 1, hasMore: false });
});

test("정상 빈 페이지만 0건 성공이다", async () => {
  const { handler, rpcCalls } = runtime({ kopis: () => xml(`${decl}<dbs/>`) });
  const res = await read(await handler(post(body)));
  assert.deepEqual(res.body.data, { status: "synced", provider: "kopis", fetchedCount: 0, savedCount: 0, hasMore: false });
  assert.equal(rpcCalls.length, 1);
});

test("공급사 실패·200 오류 envelope·정규화 실패는 503이고 저장하지 않는다", async () => {
  for (const kopis of [
    () => xml(`${decl}<dbs><db><returncode>02</returncode><errmsg>SERVICE KEY IS NOT REGISTERED ERROR</errmsg></db></dbs>`),
    () => new Response("", { status: 500 }), () => new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } }),
    () => xml(`${decl}<dbs>${db("PF1", "<unknownfield>x</unknownfield>")}</dbs>`),
    () => xml(`${decl}<dbs>${db("PF1").replace("공연예정", "공연취소")}</dbs>`),
    () => xml(`${decl}<dbs>${db("PF1").replace("2026.10.06", "2026.10.01")}</dbs>`),
    () => { throw new Error(`network ${KOPIS_KEY}`); },
  ]) {
    const { handler, rpcCalls } = runtime({ kopis });
    const res = await read(await handler(post(body)));
    assert.equal(res.status, 503, res.text);
    assert.equal(res.body.error.code, "EXTERNAL_UNAVAILABLE");
    assert.equal(res.text.includes(KOPIS_KEY), false);
    assert.equal(res.text.includes("SERVICE KEY"), false);
    assert.equal(rpcCalls.length, 0);
  }
});

test("DB 저장 실패·집계 불일치는 성공으로 바꾸지 않는다", async () => {
  const mismatched = runtime({ rpc: (name, args) => ({ receivedCount: args.p_events.length, insertedCount: 0, updatedCount: 0, staleCount: 0 }) });
  assert.equal((await mismatched.handler(post(body))).status, 500);
  const extra = runtime({ rpc: (name, args) => ({ ...upsertOk(name, args), deletedCount: 1 }) });
  assert.equal((await extra.handler(post(body))).status, 500);
  const unavailable = runtime({ rpc: () => { throw new HttpError("EXTERNAL_UNAVAILABLE"); } });
  assert.equal((await unavailable.handler(post(body))).status, 503);
  const invalid = runtime({ rpc: () => { throw new HttpError("INVALID_REQUEST"); } });
  assert.equal((await invalid.handler(post(body))).status, 400);
});

test("기본 내부 클라이언트는 upsert_events가 허용 목록에 없어 500으로 실패한다(민규 요청 전 상태)", async () => {
  const { handler, fetches } = runtime({ inject: false });
  const res = await read(await handler(post(body)));
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, "INTERNAL_ERROR");
  // 공급사 조회 후 DB 전송 전에 거절되며 자체 transport로 우회하지 않는다.
  assert.deepEqual(fetches.map((f) => f.url.origin), ["https://kopis.or.kr"]);
});

test("내부 인증: 없음 401, 다른 비밀 403, 본문 검사 전에 거절", async () => {
  const { handler, fetches } = runtime();
  assert.equal((await handler(post(body, { auth: null }))).status, 401);
  assert.equal((await handler(post("not json", { auth: "x".repeat(40) }))).status, 403);
  assert.equal(fetches.length, 0);
});

test("본문 검증: 정확한 키, 허용 제공처, 기간 상한, 페이지 상한", async () => {
  const { handler, fetches } = runtime();
  for (const bad of [
    {}, { ...body, extra: 1 }, { provider: "kopis", period: body.period }, { ...body, provider: "seoul-open-data" },
    { ...body, provider: "KOPIS" }, { ...body, period: { start: "2026-10-05" } }, { ...body, period: { ...body.period, x: 1 } },
    { ...body, period: { start: "2026-10-05", end: "2026-10-12" } }, { ...body, period: { start: "2026-10-11", end: "2026-10-05" } },
    { ...body, period: { start: "2026-02-30", end: "2026-03-01" } }, { ...body, period: { start: "20261005", end: "20261011" } },
    { ...body, page: 0 }, { ...body, page: 4 }, { ...body, page: 1.5 }, { ...body, page: "1" }, [], null,
  ]) {
    const res = await read(await handler(post(bad)));
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.error.code, "INVALID_REQUEST");
  }
  assert.equal((await handler(post(body, { path: "/functions/v1/event-sync?x=1" }))).status, 400);
  assert.equal((await handler(post(body, { type: "text/plain" }))).status, 415);
  assert.equal((await handler(post(body, { path: "/functions/v1/other" }))).status, 404);
  assert.equal((await handler(new Request("http://localhost/event-sync", { method: "GET", headers: { Authorization: `Bearer ${SECRET}` } }))).status, 405);
  assert.equal(fetches.length, 0);
  // 7일(양 끝 포함)·최대 페이지는 허용.
  assert.equal((await handler(post({ ...body, page: 3 }))).status, 200);
});

test("설정: 필수 환경값·허용 제공처·공급사 규격 상한, 기본값 없음 — 공급사 설정 누락은 인증 뒤에만 503", async () => {
  const fetch = async () => new Response();
  // 내부 인증 자체에 필요한 설정이 없으면 생성 단계에서 실패한다(인증 불가).
  for (const env of [{ INTERNAL_WORKER_SECRET: undefined }, { SUPABASE_SERVICE_ROLE_KEY: undefined }]) {
    const merged = { ...baseEnv, ...env };
    assert.throws(() => createEventSyncRuntime((key) => merged[key], fetch), (error) => error instanceof HttpError, JSON.stringify(env));
  }
  // 공급사 설정 누락·형식 오류: 잘못된 비밀은 403, 올바른 비밀만 503. 설정 상태·키를 인증 전에 드러내지 않는다.
  for (const env of [
    { EVENT_SYNC_PROVIDERS: undefined }, { EVENT_SYNC_PROVIDERS: "" }, { EVENT_SYNC_PROVIDERS: "seoul-open-data" },
    { EVENT_SYNC_PROVIDERS: "tour-api" }, { EVENT_SYNC_PROVIDERS: "kopis,kopis" }, { EVENT_SYNC_PROVIDERS: "kopis " },
    { EVENT_SYNC_MAX_PERIOD_DAYS: undefined }, { EVENT_SYNC_MAX_PERIOD_DAYS: "32" }, { EVENT_SYNC_MAX_PAGE: undefined },
    { EVENT_SYNC_MAX_PAGE: "1000" }, { EVENT_SYNC_PAGE_ROWS: undefined }, { EVENT_SYNC_PAGE_ROWS: "101" }, { EVENT_SYNC_PAGE_ROWS: "0" },
    { KOPIS_API_KEY: undefined },
  ]) {
    const merged = { ...baseEnv, ...env };
    const handler = createEventSyncRuntime((key) => merged[key], fetch);
    assert.equal((await handler(post(body, { auth: "w".repeat(40) }))).status, 403, JSON.stringify(env));
    const ok = await read(await handler(post(body)));
    assert.equal(ok.status, 503, JSON.stringify(env));
    assert.equal(ok.text.includes(KOPIS_KEY), false);
  }
  const upper = { ...baseEnv, EVENT_SYNC_MAX_PERIOD_DAYS: "31", EVENT_SYNC_MAX_PAGE: "999", EVENT_SYNC_PAGE_ROWS: "100" };
  assert.doesNotThrow(() => createEventSyncRuntime((key) => upper[key], fetch));
});

test("handler 단위: 오류 매핑과 결과 검사", async () => {
  const code = (error) => JSON.parse(JSON.stringify({ m: error.message })).m;
  assert.equal(code(mapEventSyncError(new EventProviderError("INVALID_EVENT_REQUEST"))), "요청 형식이 올바르지 않습니다.");
  for (const c of ["SOURCE_AUTH_REJECTED", "SOURCE_TIMEOUT", "SOURCE_INVALID_RESPONSE", "EVENT_PROVIDER_UNCONFIGURED", "CANCELLED"]) {
    assert.equal(code(mapEventSyncError(new EventProviderError(c))), "외부 서비스를 일시적으로 사용할 수 없습니다.", c);
  }
  assert.equal(code(mapEventSyncError(new Error("INVALID_EVENT_DATE"))), "외부 서비스를 일시적으로 사용할 수 없습니다.");
  assert.equal(code(mapEventSyncError(new Error("INVALID_EVENT_REPOSITORY_RESPONSE"))), "요청 처리 중 오류가 발생했습니다.");
  assert.equal(code(mapEventSyncError(new HttpError("ACCESS_DENIED"))), "요청 처리 중 오류가 발생했습니다.");
  const deps = (sync) => ({ allowedOrigins: [], maxBodyBytes: 1024, authenticateInternal: async () => {}, providers: ["kopis"],
    maxPeriodDays: 7, maxPage: 3, sync });
  for (const result of [{ fetchedCount: 1, savedCount: 2, hasMore: false }, { fetchedCount: -1, savedCount: 0, hasMore: false },
    { fetchedCount: 1, savedCount: 1 }, null]) {
    assert.equal((await createEventSyncHandler(deps(async () => result))(post(body))).status, 500, JSON.stringify(result));
  }
  let received;
  const ok = createEventSyncHandler(deps(async (input) => { received = input; return { fetchedCount: 2, savedCount: 1, hasMore: false }; }));
  assert.equal((await ok(post(body))).status, 200);
  assert.deepEqual({ ...received, signal: undefined }, { ...body, signal: undefined });
  assert.ok(received.signal instanceof AbortSignal);
  assert.throws(() => createEventSyncHandler({ ...deps(async () => ({})), providers: [] }));
});

/* ---------- RPC 저장소 wire 검사 ---------- */

const record = (sourceId, extra = {}) => ({
  provider: "kopis", sourceId, sourceStatus: "active", title: `가상 ${sourceId}`, category: "연극", region: "서울특별시",
  placeName: "Art  Hall", publicAddress: null, admission: { kind: "unknown" }, sourceUrl: null,
  collectedAt: "2026-09-29T13:00:00.000Z", precision: "date", startsOn: "2026-10-05", endsOn: "2026-10-06", ...extra,
});
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (n, state = "upcoming", extra = {}) => {
  const base = record(`PF${n}`, extra);
  return { id: uuid(n), ...base, state };
};
// 2026-10-05 00:00+09:00 = 1791126000 epoch 초. 예정 그룹의 정렬값은 +시작.
const upcomingKey = "1791126000.000000";

test("repository upsert: 정확한 wire 필드, 중복 식별자 사전 거절, 집계 검사", async () => {
  const fake = fakeRpc((name, args) => ({ receivedCount: 2, insertedCount: 1, updatedCount: 0, staleCount: 1 }));
  const repo = createRpcEventRepository(fake.client);
  const result = await repo.upsertBySourceIdentity([record("PF1", { extra: "DROP" }), record("PF2", { admission: { kind: "described", text: "현장", x: 1 } })]);
  assert.deepEqual(result, { savedCount: 1, insertedCount: 1, updatedCount: 0, staleCount: 1 });
  assert.equal(fake.calls[0].name, "upsert_events");
  assert.deepEqual(Object.keys(fake.calls[0].args), ["p_events"]);
  assert.equal("extra" in fake.calls[0].args.p_events[0], false);
  assert.deepEqual(fake.calls[0].args.p_events[1].admission, { kind: "described", text: "현장" });
  await assert.rejects(repo.upsertBySourceIdentity([record("PF1"), record("PF1")]), /DUPLICATE_EVENT_IDENTITY/);
  await assert.rejects(repo.upsertBySourceIdentity([record("PF1", { provider: "Bad Provider" })]), /INVALID_EVENT_SOURCE_RECORD/);
  await assert.rejects(repo.upsertBySourceIdentity([record("PF1", { sourceStatus: "unknown" })]), /UNSUPPORTED_EVENT_SOURCE_STATUS/);
  assert.equal(fake.calls.length, 1);
  for (const response of [null, [], { receivedCount: 2, insertedCount: 2, updatedCount: 0 },
    { receivedCount: 3, insertedCount: 3, updatedCount: 0, staleCount: 0 }, { receivedCount: 2, insertedCount: 2, updatedCount: 1, staleCount: 0 },
    { receivedCount: 2, insertedCount: -1, updatedCount: 3, staleCount: 0 }, { receivedCount: 2, insertedCount: "2", updatedCount: 0, staleCount: 0 }]) {
    const bad = createRpcEventRepository(fakeRpc(() => response).client);
    await assert.rejects(bad.upsertBySourceIdentity([record("PF1"), record("PF2")]), /INVALID_EVENT_REPOSITORY_RESPONSE/, JSON.stringify(response));
  }
});

test("repository listPage: 정규화된 조건 전달, 불투명 커서, 조건 변경 시 커서 거절", async () => {
  const fake = fakeRpc((name, args) => args.p_cursor
    ? { items: [item(3)], nextCursor: null }
    : { items: [item(1), item(2)], nextCursor: { rank: 1, key: upcomingKey, id: uuid(2) } });
  const repo = createRpcEventRepository(fake.client);
  const query = { mode: "post_selection", query: "  ART   hall ", region: "서울특별시", period: { start: "2026-10-01", end: "2026-10-31" } };
  const first = await repo.listPage(query, undefined, 2);
  assert.deepEqual(first.events.map((e) => e.sourceId), ["PF1", "PF2"]);
  assert.equal(typeof first.nextCursor, "string");
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(fake.calls[0], { name: "list_public_events", args: {
    p_filters: { mode: "post_selection", ongoingOnly: false, query: "art hall", period: { start: "2026-10-01", end: "2026-10-31" }, region: "서울특별시" },
    p_cursor: null, p_limit: 2 } });
  const second = await repo.listPage(query, first.nextCursor, 2);
  assert.deepEqual(second, { events: [item(3)], nextCursor: null });
  assert.deepEqual(fake.calls[1].args.p_cursor, { rank: 1, key: upcomingKey, id: uuid(2) });
  // 같은 의미의 검색어는 같은 조건이다. 다른 조건·변조 커서는 첫 페이지로 바꾸지 않는다.
  await repo.listPage({ ...query, query: "art hall" }, first.nextCursor, 2);
  for (const [changed, cursor] of [[{ ...query, region: "부산광역시" }, first.nextCursor], [{ ...query, mode: "overlapping" }, first.nextCursor],
    [query, first.nextCursor.slice(0, -2)], [query, "!!!"], [query, ""], [query, "a".repeat(4097)]]) {
    await assert.rejects(repo.listPage(changed, cursor, 2), /INVALID_EVENT_CURSOR/);
  }
  for (const limit of [0, 51, 1.5]) await assert.rejects(repo.listPage(query, undefined, limit), /INVALID_EVENT_LIMIT/);
  for (const bad of [{ mode: "all" }, { mode: "overlapping", now: new Date() }, { mode: "overlapping", ongoingOnly: "yes" },
    { mode: "overlapping", region: " " }, { mode: "overlapping", period: { start: "2026-10-05" } }]) {
    await assert.rejects(repo.listPage(bad, undefined, 2), /INVALID_EVENT|UNSUPPORTED_EVENT_FILTER|INVALID_QUERY_PERIOD/);
  }
});

test("repository listPage: DB 응답이 조건·정렬·형식을 어기면 거절한다", async () => {
  const list = (response, query = { mode: "post_selection" }, limit = 2) =>
    createRpcEventRepository(fakeRpc(() => response).client).listPage(query, undefined, limit);
  const rejects = (response, query, limit) => assert.rejects(list(response, query, limit), /INVALID_EVENT_REPOSITORY_RESPONSE/, JSON.stringify(response));
  await rejects({ items: [item(1, "upcoming", { sourceStatus: "cancelled" })], nextCursor: null });
  await rejects({ items: [{ ...item(1), exactLocation: "비공개" }], nextCursor: null });
  await rejects({ items: [item(1, "ended")], nextCursor: null });
  await rejects({ items: [item(2), item(1)], nextCursor: null });
  await rejects({ items: [item(1), item(1)], nextCursor: null });
  await rejects({ items: [item(1, "upcoming", { admission: { kind: "free", text: "x" } })], nextCursor: null });
  await rejects({ items: [{ ...item(1), id: "PF1" }], nextCursor: null });
  await rejects({ items: [item(1), item(2), item(3)], nextCursor: null });
  await rejects({ items: [item(1), item(2)], nextCursor: { rank: 1, key: upcomingKey, id: uuid(1) } });
  await rejects({ items: [item(1), item(2)], nextCursor: { rank: 0, key: upcomingKey, id: uuid(2) } });
  await rejects({ items: [item(1), item(2)], nextCursor: { rank: 1, key: "1791126001.000000", id: uuid(2) } });
  await rejects({ items: [item(1)], nextCursor: { rank: 1, key: upcomingKey, id: uuid(1) } });
  await rejects({ items: [item(1)], nextCursor: null, extra: 1 });
  await rejects({ items: [item(1, "upcoming", { region: "부산광역시" })], nextCursor: null }, { mode: "overlapping", region: "서울특별시" });
  await rejects({ items: [item(1)], nextCursor: null }, { mode: "overlapping", query: "없는 검색어" });
  await rejects({ items: [item(1)], nextCursor: null }, { mode: "overlapping", ongoingOnly: true });
  await rejects({ items: [item(1)], nextCursor: null }, { mode: "overlapping", period: { start: "2026-11-01", end: "2026-11-02" } });
  // 진행 중 → 예정 → 종료 그룹 순서, 시각 정밀도 항목도 허용.
  const timed = { ...item(9, "ongoing"), precision: "instant", startsAt: "2026-09-29T12:00:00.000Z", endsAt: "2026-09-29T14:00:00.000Z" };
  delete timed.startsOn; delete timed.endsOn;
  const ok = await list({ items: [timed, item(1), item(2, "ended")], nextCursor: null }, { mode: "overlapping" }, 3);
  assert.deepEqual(ok.events.map((e) => e.state), ["ongoing", "upcoming", "ended"]);
  await rejects({ items: [item(1), timed], nextCursor: null }, { mode: "overlapping" }, 3);
});
