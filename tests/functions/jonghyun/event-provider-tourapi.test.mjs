// TourAPI 행사 제공처 가상 검사. fetch는 주입한 가상 응답이며 실제 공급사 검증은 인계 문서의 별도 기록을 따른다.
import test from "node:test";
import assert from "node:assert/strict";
import { createTourApiEventProvider, classifyTourApiResponse, normalizeTourApiFestival, TOUR_API_CATEGORY }
  from "../../../backend/supabase/functions/_shared/integrations/events/tourapi.ts";
import { createEventSyncRuntime } from "../../../backend/supabase/functions/event-sync/index.ts";

const KEY = "SYNTHETICKEY+/=";
const item = (id, extra = {}) => ({ contentid: id, title: "가상 축제 " + id, eventstartdate: "20261003", eventenddate: "20261005",
  addr1: "서울특별시 종로구 가상로 1", addr2: "가상 광장", tel: "02-000-0000", mapx: "126.9", mapy: "37.5", firstimage: "https://example.invalid/a.jpg", ...extra });
const ok = (items, total = items.length) => new Response(JSON.stringify({ response: { header: { resultCode: "0000", resultMsg: "OK" },
  body: { items: items.length ? { item: items } : "", numOfRows: 2, pageNo: 1, totalCount: total } } }), { status: 200, headers: { "content-type": "application/json" } });
function provider(respond, extra = {}) {
  const calls = [];
  const port = createTourApiEventProvider({ serviceKey: KEY, keyFormat: "decoded", timeoutMs: 1000, rows: 2, now: () => new Date("2026-09-30T00:00:00Z"),
    fetch: async (url, init) => { calls.push({ url, init }); return respond(url, init); }, ...extra });
  return { port, calls };
}
const period = { start: "2026-10-01", end: "2026-10-07" };

test("고정 HTTPS 목적지·명시 기간/페이지/rows, decoded 키는 한 번만 인코딩, redirect 금지", async () => {
  const { port, calls } = provider(() => ok([item("1"), item("2")], 5));
  const page = await port.fetchPage({ period, page: 1 });
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://apis.data.go.kr/B551011/KorService2/searchFestival2");
  assert.equal(url.searchParams.get("serviceKey"), KEY);
  assert.match(calls[0].url, /serviceKey=SYNTHETICKEY%2B%2F%3D&/);
  assert.deepEqual([url.searchParams.get("eventStartDate"), url.searchParams.get("eventEndDate"), url.searchParams.get("numOfRows"), url.searchParams.get("pageNo")],
    ["20261001", "20261007", "2", "1"]);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(page.events.length, 2); assert.equal(page.nextCursor, "2");
  const encoded = provider(() => ok([]), { serviceKey: "ALREADY%2BENC", keyFormat: "encoded" });
  await encoded.port.fetchPage({ period, page: 1 });
  assert.match(encoded.calls[0].url, /serviceKey=ALREADY%2BENC&/, "encoded는 이중 인코딩하지 않음");
});

test("정규화: 날짜 정밀도, 공식 주소·시도 지역, 입장료 미상, 링크 없음, 전화·좌표·이미지 미저장", () => {
  const e = normalizeTourApiFestival(item("123"), { provider: "tour-api", collectedAt: "2026-09-30T00:00:00.000Z" });
  assert.deepEqual([e.sourceId, e.precision, e.startsOn, e.endsOn, e.region, e.placeName, e.publicAddress, e.category, e.admission.kind, e.sourceUrl],
    ["123", "date", "2026-10-03", "2026-10-05", "서울특별시", "가상 광장", "서울특별시 종로구 가상로 1", TOUR_API_CATEGORY, "unknown", null]);
  assert.doesNotMatch(JSON.stringify(e), /02-000|126\.9|example\.invalid/);
  assert.throws(() => normalizeTourApiFestival(item("1", { eventstartdate: "20260230" }), { provider: "tour-api", collectedAt: "2026-09-30T00:00:00.000Z" }));
});

test("200 안의 공급사 오류·XML 공통 오류·0건·형식 오류를 구분하고 0건 성공으로 숨기지 않음", () => {
  assert.deepEqual(classifyTourApiResponse(JSON.stringify({ response: { header: { resultCode: "0000" }, body: { items: "", totalCount: 0 } } }), 2, 1), { items: [], hasMore: false });
  assert.throws(() => classifyTourApiResponse(JSON.stringify({ response: { header: { resultCode: "10" }, body: {} } }), 2, 1), /SOURCE_REJECTED/);
  assert.throws(() => classifyTourApiResponse("<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>", 2, 1), /SOURCE_AUTH_REJECTED/);
  assert.throws(() => classifyTourApiResponse("<x><returnReasonCode>22</returnReasonCode></x>", 2, 1), /SOURCE_RATE_LIMITED/);
  assert.throws(() => classifyTourApiResponse("not json", 2, 1), /SOURCE_INVALID_RESPONSE/);
  const dup = JSON.stringify({ response: { header: { resultCode: "0000" }, body: { items: { item: [item("1"), item("1")] }, totalCount: 2 } } });
  assert.throws(() => classifyTourApiResponse(dup, 2, 1), /SOURCE_INVALID_RESPONSE/);
});

test("totalCount는 실제 정수 또는 정수 문자열이어야 하며 null·누락 등을 정상 0건으로 바꾸지 않음", () => {
  const response = (body) => JSON.stringify({ response: { header: { resultCode: "0000" }, body } });
  for (const totalCount of [undefined, null, false, true, "", " ", [], {}, -1, 0.5, "1e2", "0.5", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => classifyTourApiResponse(response({ totalCount, items: "" }), 2, 1), /SOURCE_INVALID_RESPONSE/,
      `잘못된 전체 건수: ${JSON.stringify(totalCount)}`);
  }
  for (const totalCount of [0, "0"]) {
    assert.deepEqual(classifyTourApiResponse(response({ totalCount, items: "" }), 2, 1), { items: [], hasMore: false });
    assert.deepEqual(classifyTourApiResponse(response({ totalCount, items: { item: [] } }), 2, 1), { items: [], hasMore: false });
  }
  assert.equal(classifyTourApiResponse(response({ totalCount: "5", items: { item: [item("1"), item("2")] } }), 2, 1).hasMore, true);
});

test("items 구조 누락·손상·건수 모순을 거절하고 마지막 단일 항목과 범위 밖 빈 페이지는 유지", () => {
  const response = (totalCount, items) => JSON.stringify({ response: { header: { resultCode: "0000" }, body: { totalCount, items } } });
  for (const items of [undefined, null, false, 123, [], {}, { item: null }, { item: "" }, { item: [[]] }]) {
    for (const total of [0, 5]) {
      assert.throws(() => classifyTourApiResponse(response(total, items), 2, 1), /SOURCE_INVALID_RESPONSE/);
    }
  }
  for (const empty of ["", { item: [] }]) {
    assert.throws(() => classifyTourApiResponse(response(5, empty), 2, 1), /SOURCE_INVALID_RESPONSE/);
    assert.deepEqual(classifyTourApiResponse(response(5, empty), 2, 4), { items: [], hasMore: false });
  }
  assert.throws(() => classifyTourApiResponse(response(0, { item: item("1") }), 2, 1), /SOURCE_INVALID_RESPONSE/);
  assert.throws(() => classifyTourApiResponse(response(1, { item: [item("1"), item("2")] }), 2, 1), /SOURCE_INVALID_RESPONSE/);
  const last = classifyTourApiResponse(response(5, { item: item("5") }), 2, 3);
  assert.equal(last.items.length, 1);
  assert.equal(last.items[0].contentid, "5");
  assert.equal(last.hasMore, false);
});

test("키 형식 unknown·31일 초과 기간은 요청하지 않음, 오류에 키를 넣지 않음", async () => {
  assert.throws(() => provider(() => ok([]), { keyFormat: "unknown" }), /EVENT_PROVIDER_UNCONFIGURED/);
  const { port, calls } = provider(() => ok([]));
  await assert.rejects(port.fetchPage({ period: { start: "2026-10-01", end: "2026-11-15" }, page: 1 }), /INVALID_EVENT_REQUEST/);
  assert.equal(calls.length, 0);
  const failing = provider(() => { throw new TypeError("network " + KEY); });
  await assert.rejects(failing.port.fetchPage({ period, page: 1 }), (e) => e.message === "SOURCE_UNAVAILABLE" && !String(e.stack).includes(KEY));
});

test("event-sync 등록부: tour-api를 허용 제공처로 쓸 수 있고 키 형식 unknown이면 인증 뒤 503", async () => {
  const SECRET = "t".repeat(40);
  const env = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s", INTERNAL_WORKER_SECRET: SECRET,
    UPSTREAM_TIMEOUT_MS: "1000", MAX_REQUEST_BYTES: "4096", ALLOWED_ORIGINS: "[]", TOUR_API_SERVICE_KEY: KEY, TOUR_API_KEY_FORMAT: "decoded",
    EVENT_SYNC_PROVIDERS: "tour-api", EVENT_SYNC_MAX_PERIOD_DAYS: "7", EVENT_SYNC_MAX_PAGE: "1", EVENT_SYNC_PAGE_ROWS: "2" };
  let saves = 0;
  const post = (e, auth = SECRET, respond = () => ok([item("9")])) => createEventSyncRuntime((k) => e[k], async () => respond(), {
    createRpcClient: () => ({ async rpc(name, args) { saves++; return { receivedCount: args.p_events.length, insertedCount: args.p_events.length, updatedCount: 0, staleCount: 0 }; } }),
    now: () => new Date("2026-09-30T00:00:00Z") })(new Request("http://localhost/functions/v1/event-sync", { method: "POST",
    headers: { authorization: "Bearer " + auth, "content-type": "application/json" }, body: JSON.stringify({ provider: "tour-api", period, page: 1 }) }));
  const res = await post(env);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, { status: "synced", provider: "tour-api", fetchedCount: 1, savedCount: 1, hasMore: false });
  const unknown = { ...env, TOUR_API_KEY_FORMAT: "" };
  assert.equal((await post(unknown, "w".repeat(40))).status, 403);
  assert.equal((await post(unknown)).status, 503);
  const savesBefore = saves;
  for (const malformed of [{ totalCount: null }, { totalCount: 5, items: {} }]) {
    const response = await post(env, SECRET, () => Response.json({ response: { header: { resultCode: "0000" }, body: malformed } }));
    assert.equal(response.status, 503, "공급사 자료 오류를 synced 0건으로 반환하지 않음");
    assert.equal((await response.json()).error.code, "EXTERNAL_UNAVAILABLE");
  }
  assert.equal(saves, savesBefore, "손상된 응답은 행사 DB 저장을 호출하지 않음");
});

// U9-A 행사 필터 값 목록(제공처 포함) 저장소 검사.
import { listEventFilterValues } from "../../../backend/supabase/functions/_shared/db/repositories/events.ts";
test("필터 값 목록: 제공처와 원문 값을 함께 돌려주고 형식 오류·중복은 거절", async () => {
  const good = { regions: [{ provider: "kopis", value: "서울특별시", count: 2 }, { provider: "tour-api", value: "서울특별시", count: 1 }],
    categories: [{ provider: "kopis", value: "연극", count: 2 }] };
  assert.deepEqual(await listEventFilterValues({ async rpc(name) { assert.equal(name, "list_event_filter_values"); return good; } }), good);
  for (const bad of [{ regions: [] }, { regions: [{ provider: "kopis", value: "<b>x</b>", count: 1 }], categories: [] },
    { regions: [{ provider: "kopis", value: "a", count: 1 }, { provider: "kopis", value: "a", count: 2 }], categories: [] },
    { regions: [{ provider: "kopis", value: "a", count: -1 }], categories: [] }]) {
    await assert.rejects(listEventFilterValues({ async rpc() { return bad; } }), /INVALID_EVENT_REPOSITORY_RESPONSE/);
  }
});
