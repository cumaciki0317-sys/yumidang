import assert from "node:assert/strict";
import test from "node:test";
import {
  createKakaoPlacesAdapter,
  createUnconfiguredPostalAddressAdapter,
} from "../../../backend/supabase/functions/_shared/integrations/places/adapter.ts";
import { PlaceLookupError } from "../../../backend/supabase/functions/_shared/integrations/places/port.ts";

// 외부 호출 없는 가상 transport 검증. 실제 키/계정 한도/공통 인증 연결 검증은 아니다.
const context = { principal: { kind: "member", userId: "synthetic-member" } };
const document = {
  id: "fake-place-1", place_name: "가상 전시관", address_name: "가상시 예시구 10",
  road_address_name: "가상시 예시로 10", phone: "PRIVATE-PHONE", x: "PRIVATE-X", y: "PRIVATE-Y",
  distance: "PRIVATE-DISTANCE", place_url: "https://discard.example", category_name: "discard-category",
};
const payload = (documents = [document], isEnd = true) => ({
  meta: { is_end: isEnd, total_count: documents.length, pageable_count: documents.length,
    same_name: { keyword: "QUERY-ANALYSIS" } }, documents,
});
const settings = (fetch) => ({ apiKey: "SYNTHETIC-KEY", pageSize: 15, timeoutMs: 1000, fetch });
const input = { query: "  전시 & 공원  ", page: 1 };
const hasCode = (expected) => (error) => {
  assert.ok(error instanceof PlaceLookupError);
  assert.equal(error.code, expected);
  assert.equal(error.message, expected);
  assert.equal(error.cause, undefined);
  return true;
};

test("카카오 고정 URL·헤더·페이지를 사용하고 좌표·반경·거리순 없이 요청한다", async () => {
  let calls = 0;
  const adapter = createKakaoPlacesAdapter(settings(async (url, request) => {
    calls += 1;
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, "https://dapi.kakao.com/v2/local/search/keyword.json");
    assert.deepEqual(Object.fromEntries(parsed.searchParams), {
      query: "전시 & 공원", page: "1", size: "15", sort: "accuracy",
    });
    assert.equal(parsed.searchParams.has("x"), false);
    assert.equal(parsed.searchParams.has("radius"), false);
    assert.equal(request.method, "GET");
    assert.equal(request.headers.Authorization, "KakaoAK SYNTHETIC-KEY");
    assert.equal(request.redirect, "error");
    assert.equal(request.credentials, "omit");
    assert.equal(request.cache, "no-store");
    assert.ok(request.signal instanceof AbortSignal);
    return Response.json(payload());
  }));
  const result = await adapter.lookup(input, context);
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    status: "results",
    places: [{ source: "kakao", sourceId: "fake-place-1", placeName: "가상 전시관",
      address: "가상시 예시구 10", roadAddress: "가상시 예시로 10" }],
    nextPage: null,
  });
  for (const omitted of ["PRIVATE-PHONE", "PRIVATE-X", "PRIVATE-Y", "PRIVATE-DISTANCE",
    "discard.example", "discard-category", "QUERY-ANALYSIS", "SYNTHETIC-KEY"]) {
    assert.equal(JSON.stringify(result).includes(omitted), false);
  }
});

test("도로명 없는 후보를 유지하고 마지막 페이지와 0건을 구분한다", async () => {
  const adapter = createKakaoPlacesAdapter(settings(async () => Response.json(payload([
    { ...document, road_address_name: "" },
  ], false))));
  const first = await adapter.lookup(input, context);
  assert.equal(first.places[0].roadAddress, null);
  assert.equal(first.nextPage, 2);
  const lastAllowed = await adapter.lookup({ ...input, page: 45 }, context);
  assert.equal(lastAllowed.nextPage, null);
  const empty = createKakaoPlacesAdapter(settings(async () => Response.json(payload([]))));
  assert.deepEqual(await empty.lookup(input, context), { status: "no_results", places: [], nextPage: null });
});

test("잘못된 입력·익명 요청·미지원 주변 옵션은 공급사 호출 전에 거절한다", async () => {
  let calls = 0;
  const adapter = createKakaoPlacesAdapter(settings(async () => { calls += 1; return Response.json(payload()); }));
  for (const bad of [null, { query: "", page: 1 }, { query: " ", page: 1 }, { query: 3, page: 1 },
    { query: "전시" }, { ...input, page: 0 }, { ...input, page: 46 }, { ...input, page: 1.5 },
    { ...input, radius: 100 }, { ...input, sort: "distance" }, { ...input, x: 127 }]) {
    await assert.rejects(adapter.lookup(bad, context), hasCode("INVALID_PLACE_INPUT"));
  }
  for (const badContext of [null, { principal: null }, { principal: { kind: "anonymous", userId: "fake" } },
    { principal: { kind: "member", userId: "" } }]) {
    await assert.rejects(adapter.lookup(input, badContext), hasCode("UNAUTHENTICATED"));
  }
  assert.equal(calls, 0);
});

test("키·페이지 크기·제한 시간·transport 설정을 생략하거나 규격을 벗어나면 시작하지 않는다", () => {
  const config = settings(async () => Response.json(payload()));
  for (const apiKey of [undefined, "", "   "]) {
    assert.throws(() => createKakaoPlacesAdapter({ ...config, apiKey }), hasCode("PLACE_PROVIDER_UNCONFIGURED"));
  }
  for (const overrides of [
    { apiKey: "key\r\nHEADER" }, { timeoutMs: undefined }, { timeoutMs: 0 }, { timeoutMs: Infinity },
    { timeoutMs: 2_147_483_648 }, { pageSize: undefined }, { pageSize: 0 }, { pageSize: 16 }, { fetch: undefined },
  ]) assert.throws(() => createKakaoPlacesAdapter({ ...config, ...overrides }), hasCode("INVALID_PLACE_CONFIG"));
});

test("HTTP 실패 본문을 읽거나 키·검색어를 오류에 넣지 않고 상태를 구분한다", async () => {
  for (const [status, code] of [[401, "SOURCE_AUTH_REJECTED"], [403, "SOURCE_AUTH_REJECTED"],
    [429, "SOURCE_RATE_LIMITED"], [500, "SOURCE_UNAVAILABLE"], [400, "SOURCE_REJECTED"]]) {
    let read = false;
    const adapter = createKakaoPlacesAdapter(settings(async () => ({
      status, ok: false, async json() { read = true; throw new Error("SECRET BODY KEY QUERY"); },
    })));
    await assert.rejects(adapter.lookup(input, context), hasCode(code));
    assert.equal(read, false);
  }
  const networkFailure = createKakaoPlacesAdapter(settings(async () => { throw new Error("SECRET URL API KEY QUERY"); }));
  await assert.rejects(networkFailure.lookup(input, context), hasCode("SOURCE_UNAVAILABLE"));
});

test("손상된 JSON·잘못된 후보·중복 ID를 성공이나 부분 결과로 포장하지 않는다", async () => {
  const malformed = createKakaoPlacesAdapter(settings(async () => new Response("PRIVATE broken JSON")));
  await assert.rejects(malformed.lookup(input, context), hasCode("SOURCE_INVALID_RESPONSE"));
  for (const value of [null, {}, { ...payload(), meta: { is_end: "true" } },
    payload([{ ...document, id: "" }]), payload([{ ...document, place_name: 5 }]),
    payload([{ ...document, address_name: "", road_address_name: "" }]), payload([document, document])]) {
    const adapter = createKakaoPlacesAdapter(settings(async () => Response.json(value)));
    await assert.rejects(adapter.lookup(input, context), hasCode("SOURCE_INVALID_RESPONSE"));
  }
});

test("호출 전 취소는 외부 요청을 보내지 않고 실행 중 취소는 공급사 요청을 중단한다", async () => {
  let calls = 0;
  let providerSignal;
  const adapter = createKakaoPlacesAdapter(settings(async (_url, init) => {
    calls += 1;
    providerSignal = init.signal;
    return new Promise(() => {});
  }));
  const prior = new AbortController();
  prior.abort("SECRET ABORT REASON");
  await assert.rejects(adapter.lookup(input, { ...context, signal: prior.signal }), hasCode("CANCELLED"));
  assert.equal(calls, 0);
  const running = new AbortController();
  const pending = adapter.lookup(input, { ...context, signal: running.signal });
  running.abort("SECRET ABORT REASON");
  await assert.rejects(pending, hasCode("CANCELLED"));
  assert.equal(calls, 1);
  assert.equal(providerSignal.aborted, true);
});

test("제한 시간은 응답 헤더뿐 아니라 JSON 본문 수신까지 적용한다", async () => {
  let providerSignal;
  const adapter = createKakaoPlacesAdapter({ ...settings(async (_url, init) => {
    providerSignal = init.signal;
    return { status: 200, ok: true, json: () => new Promise(() => {}) };
  }), timeoutMs: 10 });
  await assert.rejects(adapter.lookup(input, context), hasCode("SOURCE_TIMEOUT"));
  assert.equal(providerSignal.aborted, true);
});

test("우편번호 공급사 미정은 명시 unavailable이며 다른 카카오 API를 호출하지 않는다", async () => {
  const postal = createUnconfiguredPostalAddressAdapter();
  assert.equal(postal.configured, false);
  assert.deepEqual(await postal.lookup({ query: "가상로" }, context), {
    status: "unavailable", code: "POSTAL_PROVIDER_UNCONFIGURED",
  });
  await assert.rejects(postal.lookup({ query: "가상로" }, { principal: null }), hasCode("UNAUTHENTICATED"));
});
