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

test("기본 내부 클라이언트의 DB 오류는 성공으로 바꾸지 않는다", async () => {
  const { handler, fetches } = runtime({ inject: false });
  const res = await read(await handler(post(body)));
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, "EXTERNAL_UNAVAILABLE");
  // 공통 내부 클라이언트의 허용된 RPC 경로를 사용한다.
  assert.deepEqual(fetches.map((f) => f.url.origin), ["https://kopis.or.kr", "http://127.0.0.1:54321"]);
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
    { EVENT_SYNC_PROVIDERS: undefined }, { EVENT_SYNC_PROVIDERS: "" },
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
  assert.deepEqual(second, { events: [{ ...item(3), performanceGenre: "play" }], nextCursor: null });
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

test("공개 행사 extras는 원천 텍스트/HTTPS만 허용하고 장르 필터를 RPC와 커서에 포함", async () => {
 const calls=[];const data={...item(3),category:"한국음악(국악)",description:"가상 소개",operatingInfo:null,posterUrl:"https://kopis.or.kr/upload/fixture.jpg"};
 const repo=createRpcEventRepository({async rpc(name,args){calls.push(args);return {items:[data],nextCursor:null};}});
 const page=await repo.listPage({mode:"overlapping",region:"서울",performanceGenre:"concert"},undefined,10);
 assert.equal(page.events[0].performanceGenre,"concert");assert.equal(calls[0].p_filters.performanceGenre,"concert");assert.equal(calls[0].p_filters.region,"서울특별시");
 for(const bad of [{...data,description:"<b>소개</b>"},{...data,posterUrl:"http://kopis.or.kr/upload/fixture.jpg"},{...data,performanceGenre:"play"}]){
  const invalid=createRpcEventRepository({async rpc(){return {items:[bad],nextCursor:null};}});
  await assert.rejects(invalid.listPage({mode:"overlapping"},undefined,10),/INVALID_EVENT_REPOSITORY_RESPONSE/);
 }
});

test('무료 필터는 DB 페이징 이전 전달하고 unknown/described를 무료로 추정하지 않는다',async()=>{
 let last;const repo=createRpcEventRepository({async rpc(_name,args){last=args;return {items:[{...item(1),admission:{kind:'free'}}],nextCursor:null};}});
 assert.equal((await repo.listPage({mode:'overlapping',freeOnly:true},undefined,10)).events.length,1);
 assert.equal(last.p_filters.freeOnly,true);
 const unknown=createRpcEventRepository({async rpc(){return {items:[item(1)],nextCursor:null};}});
 await assert.rejects(unknown.listPage({mode:'overlapping',freeOnly:true},undefined,10),/INVALID_EVENT_REPOSITORY_RESPONSE/);
 await assert.rejects(repo.listPage({mode:'overlapping',freeOnly:'yes'},undefined,10),/INVALID_EVENT_FILTER/);
});

// J01 준비 입력/SQL 생성의 로컬 모형 계약이다. VM·DB·Auth·TLS 서버를 실행하지 않는다.
import {
  validateJ01Input, collectJ01SourceFiles, j01FixtureSql, validateJ01Auth,
  validateJ01Snapshot, validateLegacyEventRestEndpoints, runJ01EventRoundtrip,
} from '../../integration/jonghyun/events-rest.mjs';
import { fileURLToPath } from 'node:url';
const modelSha = 'a'.repeat(64);
const modelUser = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
const modelIdentity = ['33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
const modelJ01 = () => ({version:1,scenario:'J01_EVENTS_ROUNDTRIP',repositoryRoot:'/private/tmp/mock-repo',codeRoot:'/private/tmp/mock-capsule',head:'b'.repeat(40),sourceFiles:{
 'backend/supabase/functions/service-api/index.ts':modelSha,'apps/mobile/src/service.ts':modelSha,'tests/integration/jonghyun/events-rest.mjs':modelSha,
},migrationFiles:{'backend/supabase/migrations/20261009031628_event_detail_projection.sql':modelSha},target:null});

test('J01 준비 모형 입력은 target 없음을 보존하고 실제 실행/ready를 선언하지 않는다', async () => {
  const plan=modelJ01(),report=validateJ01Input(plan);
  assert.equal(report.execution,'NOT_RUN');assert.equal(report.ready,false);assert.equal(report.actualTargetVerified,false);
  assert.ok(report.missing.includes('EXACT_APPROVED_TARGET'));
  let calls=0;await assert.rejects(()=>runJ01EventRoundtrip(plan,{verifyTarget:()=>{calls++;}}),/J01_EXACT_TARGET_REQUIRED/);assert.equal(calls,0);
  for(const bad of [{...plan,target:{approved:true}},{...plan,approval:true},{...plan,sourceFiles:{...plan.sourceFiles,'../outside.ts':modelSha}},{...plan,migrationFiles:{}}])assert.throws(()=>validateJ01Input(bad),/^Error: J01_/);
});

test('J01 대상 입력은 기존 격리 준비 ABI의 고유프로젝트만 받으며 target 관측으로 승격하지 않는다', () => {
  const plan=modelJ01(),container={id:modelSha,image:'public.ecr.aws/supabase/postgres@sha256:'+modelSha};
  const target={dockerSocket:'/private/tmp/mock/docker.sock',project:'jonghyun-backend100-1234abcd',runId:'55555555-5555-4555-8555-555555555555',containers:{db:container,auth:{...container,id:'c'.repeat(64)},rest:{...container,id:'d'.repeat(64)}},origin:'http://127.0.0.1:65421',authIssuer:'http://127.0.0.1:65421/auth/v1',authAudience:'authenticated'};
  const report=validateJ01Input({...plan,target});assert.equal(report.ready,false);assert.equal(report.actualTargetVerified,false);
  assert.throws(()=>validateJ01Input({...plan,target:{...target,containers:{...target.containers,auth:container}}}),/J01_TARGET_ROLE_ID_DUPLICATE/);
  for(const project of ['jonghyun-backend100','yumidang-minkyu-gateway','yumidang-jonghyun-j01-test','jonghyun-backend100-123456789'])assert.throws(()=>validateJ01Input({...plan,target:{...target,project}}),/J01_TARGET_IDENTITY/);
});

test('J01 기존 legacy REST는 DB host/scheme을 고정하고 비밀 URL을 오류에 넣지 않는다', () => {
  assert.deepEqual(validateLegacyEventRestEndpoints('http://127.0.0.1:55421','postgresql://fixture:synthetic-password@127.0.0.1:55422/postgres'),{apiOrigin:'http://127.0.0.1:55421'});
  for(const database of ['postgresql://fixture:PRIVATE_SENTINEL@evil.invalid:55422/postgres','https://127.0.0.1:55422/postgres','postgresql://127.0.0.1:5432/postgres']){
    assert.throws(()=>validateLegacyEventRestEndpoints('http://127.0.0.1:55421',database),error=>error.message==='J01_LEGACY_DEDICATED_LOCAL_ONLY'&&!String(error).includes('PRIVATE_SENTINEL'));
  }
  assert.throws(()=>validateLegacyEventRestEndpoints('http://fixture:PRIVATE_SENTINEL@127.0.0.1:55421','postgresql://127.0.0.1:55422/postgres'),/J01_LEGACY_DEDICATED_LOCAL_ONLY/);
});

test('J01 source closure는 모바일 서비스와 runtime 및 시험기 자신의 실제 파일을 포함한다', () => {
  const root=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
  const graph=collectJ01SourceFiles(root);
  for(const path of ['apps/mobile/src/service.ts','apps/mobile/src/api.ts','apps/mobile/src/domain.ts','apps/mobile/src/types.ts','backend/supabase/functions/service-api/events-http.ts','backend/supabase/functions/_shared/auth/principal.ts','tests/integration/jonghyun/events-rest.mjs'])assert.match(graph[path],/^[a-f0-9]{64}$/);
  assert.deepEqual(graph,collectJ01SourceFiles(root));
});

test('J01 fixture SQL은 새 runId의17행과 실제 Auth/identity 확인·10000자 가격만 준비한다', () => {
  const accounts=modelUser.map((userId,i)=>({userId,identityId:modelIdentity[i]}));
  const seed=j01FixtureSql('55555555-5555-4555-8555-555555555555',accounts);
  assert.equal(seed.count,17);assert.match(seed.sql,/for i in 1\.\.17 loop/);assert.match(seed.sql,/repeat\('가격안내',2500\)/);
  assert.match(seed.sql,/auth\.users/);assert.match(seed.sql,/private\.member_episodes/);assert.match(seed.sql,/j01_scope_existing/);
  assert.doesNotMatch(seed.sql,/\btruncate\b|grant |disable trigger|delete from/i);
  assert.throws(()=>j01FixtureSql('bad;PRIVATE_SENTINEL',accounts),error=>error.message==='J01_FIXTURE_IDENTITY'&&!String(error).includes('PRIVATE_SENTINEL'));
  assert.throws(()=>j01FixtureSql('55555555-5555-4555-8555-555555555555',[accounts[0],accounts[0]]),/J01_FIXTURE_IDENTITY/);
});

test('J01 JWT 모형 metadata는 signature 증명과 분리하고 subject/issuer/audience/만료를 검사한다', () => {
  const now=1900000000000,target={authIssuer:'http://127.0.0.1:65421/auth/v1',authAudience:'authenticated'};
  const token=claims=>'synthetic.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature';
  const claims=i=>({sub:modelUser[i],iss:target.authIssuer,aud:target.authAudience,role:'authenticated',exp:1900000600});
  const accounts=modelUser.map((userId,i)=>({userId,identityId:modelIdentity[i],token:token(claims(i))}));
  assert.deepEqual(validateJ01Auth(accounts,target,now),{scope:'JWT_METADATA_ONLY',signatureVerified:false});
  for(const change of [{sub:modelUser[1]},{iss:'https://external.invalid/auth/v1'},{aud:'wrong'},{exp:1899999999},{nbf:1900000600},{role:'anon'}]){
    assert.throws(()=>validateJ01Auth([{...accounts[0],token:token({...claims(0),...change})},accounts[1]],target,now),error=>error.message==='J01_AUTH_TOKEN_SCOPE_EXPIRY'&&!String(error).includes(accounts[0].token));
  }
});

test('J01 모형 snapshot의 일부 table 또는 digest 문자열을 전체 복원 증거로 받지 않는다', () => {
  const snapshot={scope:'FULL_TARGET_LOGICAL_BASELINE',schemas:['auth','private','public','storage'],tables:{'private.source_events':{rowCount:17,sha256:modelSha},'auth.users':{rowCount:2,sha256:modelSha}},catalogSha256:modelSha,rolesSha256:modelSha,existingUnknownSha256:modelSha};
  const tables=['auth.users','private.source_events'];
  const report=validateJ01Snapshot(snapshot,tables);assert.equal(report.wholeBaselineRestored,false);assert.equal(report.scope,'BOUNDARY_INVENTORY_CHECK_ONLY');
  assert.throws(()=>validateJ01Snapshot(modelSha,tables),/J01_SNAPSHOT_COVERAGE/);
  assert.throws(()=>validateJ01Snapshot(snapshot,[...tables,'storage.objects']),/J01_SNAPSHOT_TABLE_INVENTORY/);
  assert.throws(()=>validateJ01Snapshot({...snapshot,existingUnknownSha256:null},tables),/J01_SNAPSHOT_CATALOG_ROLES_UNKNOWN/);
});
