import assert from "node:assert/strict";
import test from "node:test";
import { createPlacesRuntime } from "../../../backend/supabase/functions/places/index.ts";
import { createPlacesHandler, mapPlaceError } from "../../../backend/supabase/functions/places/handler.ts";
import { PlaceLookupError } from "../../../backend/supabase/functions/_shared/integrations/places/port.ts";

// 가상 Auth·Kakao 응답으로 HTTP 경계만 검사한다. 실제 Edge/gateway·Kakao 호출이 아니다.
const ORIGIN = "https://app.example.test";
const KAKAO_KEY = "SYNTHETIC-KAKAO-KEY";
const USER_ID = "11111111-2222-4333-8444-555555555555";
const JWT = "aaaa.bbbb.cccc";
const baseEnv = {
  SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_ANON_KEY: "synthetic-anon", UPSTREAM_TIMEOUT_MS: "1000",
  MAX_REQUEST_BYTES: "4096", ALLOWED_ORIGINS: JSON.stringify([ORIGIN]),
  KAKAO_REST_API_KEY: KAKAO_KEY, PLACES_PAGE_SIZE: "5",
};
const kakaoDocument = {
  id: "fake-1", place_name: "가상 전시관", address_name: "가상시 예시구 10", road_address_name: "가상시 예시로 10",
  phone: "PRIVATE-PHONE", x: "127.1", y: "37.1", distance: "10", place_url: "https://discard.example",
};

function setup({ env = {}, kakao, auth } = {}) {
  const calls = { kakao: [], auth: 0 };
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/auth/v1/user") {
      calls.auth++;
      if (auth) return auth(init);
      return Response.json({ id: USER_ID, role: "authenticated" });
    }
    if (parsed.origin === "https://dapi.kakao.com") {
      calls.kakao.push({ url: parsed, init });
      if (kakao) return kakao(parsed, init);
      return Response.json({ meta: { is_end: true, total_count: 1, pageable_count: 1 }, documents: [kakaoDocument] });
    }
    throw new Error("unexpected destination");
  };
  const merged = { ...baseEnv, ...env };
  const handler = createPlacesRuntime((key) => merged[key], fetch);
  return { handler, calls };
}
const get = (path, { auth = true, origin = ORIGIN, method = "GET" } = {}) => new Request(`http://localhost${path}`, {
  method, headers: { ...(auth ? { Authorization: `Bearer ${JWT}` } : {}), ...(origin ? { Origin: origin } : {}) },
});
async function read(response) {
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text), headers: response.headers };
}

test("회원 검색: 공개 후보 필드만 반환하고 CORS·요청 ID를 붙인다", async () => {
  const { handler, calls } = setup();
  const res = await read(await handler(get("/functions/v1/places?query=%20%EC%A0%84%EC%8B%9C%20&page=1")));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, {
    status: "results",
    places: [{ source: "kakao", sourceId: "fake-1", placeName: "가상 전시관", address: "가상시 예시구 10", roadAddress: "가상시 예시로 10" }],
    nextPage: null,
  });
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(res.headers.get("x-request-id"), res.body.requestId);
  for (const secret of [KAKAO_KEY, "PRIVATE-PHONE", "127.1", "discard.example", JWT]) assert.equal(res.text.includes(secret), false, secret);
  assert.equal(calls.kakao.length, 1);
  const { url, init } = calls.kakao[0];
  assert.deepEqual(Object.fromEntries(url.searchParams), { query: "전시", page: "1", size: "5", sort: "accuracy" });
  assert.equal(init.headers.Authorization, `KakaoAK ${KAKAO_KEY}`);
  assert.equal(init.redirect, "error");
  // /places 경로도 같은 처리.
  assert.equal((await handler(get("/places?page=2&query=a"))).status, 200);
});

test("인증 없음·Auth 거절은 401이며 공급사를 호출하지 않는다", async () => {
  const { handler, calls } = setup();
  const anonymous = await read(await handler(get("/functions/v1/places?query=a&page=1", { auth: false })));
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error.code, "AUTH_REQUIRED");
  const rejected = setup({ auth: () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } }) });
  assert.equal((await rejected.handler(get("/functions/v1/places?query=a&page=1"))).status, 401);
  const anonymousUser = setup({ auth: () => Response.json({ id: USER_ID, role: "authenticated", is_anonymous: true }) });
  assert.equal((await anonymousUser.handler(get("/functions/v1/places?query=a&page=1"))).status, 401);
  assert.equal(calls.kakao.length + rejected.calls.kakao.length + anonymousUser.calls.kakao.length, 0);
});

test("입력 검증: query·page 두 값만, page 1..45, 빈 검색어·중복·추가 키 거절", async () => {
  const { handler, calls } = setup();
  for (const query of ["", "?query=a", "?page=1", "?query=a&page=0", "?query=a&page=46", "?query=a&page=01", "?query=a&page=1.5",
    "?query=%20%20&page=1", "?query=a&query=b&page=1", "?query=a&page=1&x=127", "?query=a&page=1&radius=100",
    `?query=${"가".repeat(301)}&page=1`, "?query=a%00&page=1"]) {
    const res = await read(await handler(get(`/functions/v1/places${query}`)));
    assert.equal(res.status, 400, query);
    assert.equal(res.body.error.code, "INVALID_REQUEST");
  }
  assert.equal(calls.kakao.length, 0);
  assert.equal((await handler(get(`/functions/v1/places?query=${"가".repeat(300)}&page=45`))).status, 200);
});

test("경로·메서드·CORS", async () => {
  const { handler } = setup();
  assert.equal((await handler(get("/functions/v1/places/extra?query=a&page=1"))).status, 404);
  assert.equal((await handler(get("/functions/v1/places?query=a&page=1", { method: "POST" }))).status, 405);
  const foreign = await handler(get("/functions/v1/places?query=a&page=1", { origin: "https://evil.example" }));
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  const preflight = await handler(new Request("http://localhost/functions/v1/places", {
    method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET");
  const badMethod = await handler(new Request("http://localhost/functions/v1/places", {
    method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" },
  }));
  assert.equal(badMethod.status, 405);
  // Origin 없는 서버 간 요청은 CORS 헤더 없이 처리한다.
  const serverSide = await handler(get("/functions/v1/places?query=a&page=1", { origin: null }));
  assert.equal(serverSide.status, 200);
  assert.equal(serverSide.headers.get("access-control-allow-origin"), null);
});

test("공급사 거절·장애·형식 오류는 503이며 키·원문을 응답하지 않는다", async () => {
  for (const kakao of [
    () => Response.json({ errorType: "NotAuthorizedError", message: `App(disabled) ${KAKAO_KEY}` }, { status: 403 }),
    () => new Response("", { status: 429 }), () => new Response("", { status: 502 }),
    () => Response.json({ documents: "bad" }), () => { throw new Error(`socket ${KAKAO_KEY}`); },
  ]) {
    const { handler } = setup({ kakao });
    const res = await read(await handler(get("/functions/v1/places?query=a&page=1")));
    assert.equal(res.status, 503);
    assert.deepEqual(Object.keys(res.body.error).sort(), ["code", "message", "retryable"]);
    assert.equal(res.body.error.code, "EXTERNAL_UNAVAILABLE");
    assert.equal(res.text.includes(KAKAO_KEY), false);
    assert.equal(res.text.includes("disabled"), false);
  }
});

test("장소 설정 누락은 인증 후 503, 인증 전에는 401. PLACES_PAGE_SIZE는 기본값이 없다", async () => {
  for (const env of [{ KAKAO_REST_API_KEY: undefined }, { KAKAO_REST_API_KEY: " key" }, { PLACES_PAGE_SIZE: undefined },
    { PLACES_PAGE_SIZE: "0" }, { PLACES_PAGE_SIZE: "16" }, { PLACES_PAGE_SIZE: "5.0" }, { PLACES_PAGE_SIZE: "" }]) {
    const { handler, calls } = setup({ env });
    assert.equal((await handler(get("/functions/v1/places?query=a&page=1", { auth: false }))).status, 401);
    const res = await read(await handler(get("/functions/v1/places?query=a&page=1")));
    assert.equal(res.status, 503, JSON.stringify(env));
    assert.equal(calls.kakao.length, 0);
  }
  // 공통 설정 누락은 런타임 조립 실패.
  assert.throws(() => createPlacesRuntime((key) => ({ ...baseEnv, ALLOWED_ORIGINS: undefined })[key], async () => new Response()));
});

test("검색어를 콘솔에 기록하지 않는다", async () => {
  const { handler } = setup({ kakao: () => new Response("", { status: 500 }) });
  const seen = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const name of Object.keys(original)) console[name] = (...args) => seen.push(args.map(String).join(" "));
  try {
    await handler(get("/functions/v1/places?query=SECRET-QUERY-TEXT&page=1"));
  } finally {
    Object.assign(console, original);
  }
  assert.equal(seen.some((line) => line.includes("SECRET-QUERY-TEXT")), false);
});

test("handler 단위: 오류 매핑과 응답 투영", async () => {
  assert.equal(mapPlaceError(new PlaceLookupError("INVALID_PLACE_INPUT")).message, "요청 형식이 올바르지 않습니다.");
  assert.equal(mapPlaceError(new PlaceLookupError("UNAUTHENTICATED")).message, "로그인이 필요합니다.");
  for (const code of ["SOURCE_TIMEOUT", "SOURCE_AUTH_REJECTED", "PLACE_PROVIDER_UNCONFIGURED", "INVALID_PLACE_CONFIG", "CANCELLED"]) {
    assert.equal(mapPlaceError(new PlaceLookupError(code)).message, "외부 서비스를 일시적으로 사용할 수 없습니다.", code);
  }
  assert.equal(mapPlaceError(new Error("x")).message, "요청 처리 중 오류가 발생했습니다.");
  let context;
  const handler = createPlacesHandler({
    allowedOrigins: [ORIGIN],
    authenticate: async () => ({ userId: USER_ID }),
    lookup: async (input, ctx) => {
      context = ctx;
      return { status: "results", places: [{ source: "kakao", sourceId: "s", placeName: "p", address: null, roadAddress: "r", extra: "LEAK" }], nextPage: 2 };
    },
  });
  const res = await read(await handler(get("/functions/v1/places?query=a&page=1")));
  assert.equal(res.text.includes("LEAK"), false);
  assert.equal(res.body.data.nextPage, 2);
  assert.deepEqual(context.principal, { kind: "member", userId: USER_ID });
  assert.ok(context.signal instanceof AbortSignal);
  const bad = createPlacesHandler({ allowedOrigins: [ORIGIN], authenticate: async () => ({ userId: USER_ID }),
    lookup: async () => ({ status: "results", places: [], nextPage: 99 }) });
  assert.equal((await bad(get("/functions/v1/places?query=a&page=1"))).status, 503);
});
