/** 민규담당. 주입한 가상 executor로 HTTP 경계만 검사한다. 검색 코어·실제 DB 검증이 아니다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi, type ServiceApiDependencies } from "../../../backend/supabase/functions/service-api/handler.ts";
import { mapPublicPostSearchError, parsePublicPostSearchQuery, type HttpPostSearchInput, type PublicPostSearchExecutor } from "../../../backend/supabase/functions/service-api/search-http.ts";
import { HttpError, toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import { POST_CATEGORIES, POST_REGIONS } from "../../../backend/supabase/functions/_shared/contracts/search.ts";
import type { RpcClient } from "../../../backend/supabase/functions/_shared/db/transport.ts";
const origin = "https://app.example.test";
const emptyPage = { status: "no_results" as const, posts: [], nextCursor: null };
function setup(execute?: PublicPostSearchExecutor, enabled = true) {
  const inputs: HttpPostSearchInput[] = [];
  const auth: string[] = [];
  const rpc: string[] = [];
  const db: RpcClient = { rpc: async (name) => { rpc.push(name); return {}; } };
  const dependencies: ServiceApiDependencies = {
    allowedOrigins: [origin], maxBodyBytes: 8192,
    authenticateUser: async (request) => { auth.push("user"); if (request.headers.get("authorization") !== "Bearer member") throw new HttpError("AUTH_REQUIRED"); return db; },
    authenticateInternal: async () => { auth.push("internal"); throw new HttpError("ACCESS_DENIED"); },
    ...(enabled ? { publicSearch: {
      authenticate: async (request: Request) => { auth.push("search"); return { db, caller: request.headers.get("authorization") === "Bearer member" ? "member" as const : "anonymous" as const }; },
      execute: execute ?? (async (client: RpcClient, input: HttpPostSearchInput) => { assert.equal(client, db); inputs.push(input); return emptyPage; }),
    } } : {}),
  };
  const handler = createServiceApi(dependencies);
  const send = (path = "/posts", headers: Record<string, string> = {}, method = "GET") => handler(new Request(`https://api.example.test/service-api${path}`, { method, headers }));
  return { handler, send, inputs, auth, rpc };
}
const invalid = (error: unknown) => { assert.equal(toPublicError(error).error.code, "INVALID_REQUEST"); return true; };

test("정확한 두 prefix의 GET 목록만 선택 인증으로 처리한다", async () => {
  const { handler, inputs, auth } = setup();
  for (const prefix of ["/service-api", "/functions/v1/service-api"]) {
    const response = await handler(new Request(`https://api.example.test${prefix}/posts`));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, emptyPage);
  }
  assert.deepEqual(inputs, [{ caller: "anonymous", sort: "created_desc" }, { caller: "anonymous", sort: "created_desc" }]);
  assert.deepEqual(auth, ["search", "search"]);
});

test("저수준 handler factory에 검색 의존성을 생략하면 GET 목록은 405다", async () => {
  const { send, auth } = setup(undefined, false);
  assert.equal((await send()).status, 405);
  assert.deepEqual(auth, []);
});

test("비슷한 경로·인코딩·상세·다른 메서드는 공개 검색으로 보내지 않는다", async () => {
  const { handler, send, auth, inputs } = setup();
  for (const path of ["/service-api/posts/", "/service-api//posts", "/service-api/%70osts", "/evil/service-api/posts", "/service-api-extra/posts"]) {
    assert.equal((await handler(new Request(`https://api.example.test${path}`))).status, 404, path);
  }
  assert.equal((await send("/posts", {}, "DELETE")).status, 405);
  assert.equal((await send("/posts/11111111-1111-4111-8111-111111111111")).status, 401);
  assert.deepEqual(inputs, []);
  assert.deepEqual(auth, ["user"]);
});

test("동일 /posts의 POST는 계속 회원 인증이 필요하다", async () => {
  const { send, auth, rpc } = setup();
  assert.equal((await send("/posts", {}, "POST")).status, 401);
  assert.deepEqual(auth, ["user"]);
  assert.deepEqual(rpc, []);
});

test("기간 검색은 회원 입력으로 넘기고 caller는 인증 문맥에서만 만든다", async () => {
  const { send, inputs } = setup();
  const query = new URLSearchParams({ query: "  전시  ", periodStart: "2026-10-01T00:00:00+09:00", periodEnd: "2026-10-02T00:00:00+09:00", sort: "starts_asc", availability: "recruiting", category: "전시", cost: "free", authorAge: "all", limit: "50", cursor: "opaque_cursor" });
  assert.equal((await send(`/posts?${query}`, { authorization: "Bearer member" })).status, 200);
  assert.deepEqual(inputs[0], { caller: "member", query: "  전시  ", period: { startsAt: "2026-10-01T00:00:00+09:00", endsAt: "2026-10-02T00:00:00+09:00" }, sort: "starts_asc", availability: "recruiting", category: "전시", cost: "free", authorAge: "all", limit: 50, cursor: "opaque_cursor" });
  assert.equal((await send("/posts?ageMin=30&ageMax=39", { authorization: "Bearer member" })).status, 200);
  assert.equal(inputs[1].caller, "member");
});

test("비로그인 나이 선택은 executor 전에 로그인 필요로 응답한다", async () => {
  const { send, inputs } = setup();
  const response = await send("/posts?ageMin=30&ageMax=39");
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "AUTH_REQUIRED");
  assert.deepEqual(inputs, []);
});

test("중복 query·알 수 없는 필터·caller 및 권한 주입을 차단한다", async () => {
  const { send, inputs } = setup();
  for (const query of ["query=a&query=b", "limit=1&limit=2", "caller=member", "userId=secret", "role=service_role", "sort=starts_asc&sort=created_desc", "period=object", "radius=3"]) {
    assert.equal((await send(`/posts?${query}`)).status, 400, query);
  }
  assert.deepEqual(inputs, []);
});

test("잘못된 enum·숫자 표현·기간 한쪽·길이 초과는 HTTP에서 거절한다", () => {
  for (const query of ["sort=newest", "availability=closed", "cost=unknown", "authorAge=teen", "category=없는분류", "limit=0", "limit=51", "limit=1e1", "limit=01", "limit=-1", "limit=1.1", "limit=", "periodStart=2026-10-01T00:00:00Z", "periodEnd=2026-10-02T00:00:00Z", "periodStart=x&periodEnd=y", "cursor=", `cursor=${"x".repeat(4097)}`, `query=${"가".repeat(301)}`]) {
    assert.throws(() => parsePublicPostSearchQuery(new URL(`https://api.example.test/posts?${query}`), "member"), invalid, query);
  }
  assert.equal(parsePublicPostSearchQuery(new URL(`https://api.example.test/posts?query=${"😀".repeat(300)}&limit=1`), "member").limit, 1);
});

test("공통 requestId·CORS·no-store를 성공과 실패 모두 유지한다", async () => {
  const { send } = setup();
  const ids: string[] = [];
  for (const path of ["/posts", "/posts?sort=bad"]) {
    const response = await send(path, { origin, "x-request-id": "caller-injected-id" });
    const body = await response.json();
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-request-id"), body.requestId);
    assert.match(body.requestId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(body.requestId, "caller-injected-id");
    ids.push(body.requestId);
  }
  assert.notEqual(ids[0], ids[1]);
});

test("거절 origin은 검색 인증 이전에 차단하고 preflight는 인증하지 않는다", async () => {
  const { send, auth } = setup();
  assert.equal((await send("/posts", { origin: `${origin}.evil` })).status, 403);
  const preflight = await send("/posts", { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization, apikey" }, "OPTIONS");
  assert.equal(preflight.status, 204);
  assert.deepEqual(auth, []);
});

test("검색 코어 오류는 정확한 허용 코드만 공통 오류로 바꾼다", () => {
  for (const message of ["INVALID_FILTER", "UNSUPPORTED_FILTER", "INVALID_CURSOR", "INVALID_SEARCH_TIMESTAMP", "INVALID_SEARCH_PERIOD"]) {
    assert.equal(toPublicError(mapPublicPostSearchError(new Error(message))).status, 400, message);
  }
  assert.equal(toPublicError(mapPublicPostSearchError(new Error("AUTH_REQUIRED"))).status, 401);
  const known = new HttpError("ACCESS_DENIED");
  assert.equal(mapPublicPostSearchError(known), known);
  for (const error of [new Error("INVALID_CALLER"), new Error("INVALID_SEARCH_RESPONSE"), new Error("INVALID_CURSOR secret SQL"), { code: "AUTH_REQUIRED" }, "AUTH_REQUIRED"]) {
    assert.equal(toPublicError(mapPublicPostSearchError(error)).status, 500);
  }
});

test("실행기 오류의 민감정보는 응답·console 로그에 남기지 않는다", async () => {
  const logs: unknown[][] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    for (const [error, expected] of [[new Error("INVALID_CURSOR"), 400], [new Error("AUTH_REQUIRED"), 401], [new Error("SELECT private.phone; Bearer secret-token; 상세주소"), 500], [new HttpError("EXTERNAL_UNAVAILABLE"), 503]] as const) {
      const { send } = setup(async () => { throw error; });
      const response = await send("/posts?query=검색원문");
      assert.equal(response.status, expected);
      assert.doesNotMatch(await response.text(), /SELECT|secret-token|상세주소|검색원문|stack/);
    }
    assert.deepEqual(logs, []);
  } finally { Object.assign(console, saved); }
});


test("최신 16개 카테고리와 17개 시도는 익명 검색에 전달한다", async () => {
  assert.equal(POST_CATEGORIES.length, 16);
  assert.equal(POST_REGIONS.length, 17);
  const { send, inputs } = setup();
  for (const category of POST_CATEGORIES) {
    assert.equal((await send(`/posts?${new URLSearchParams({ category })}`)).status, 200);
    assert.equal(inputs.at(-1)?.category, category);
  }
  for (const region of POST_REGIONS) {
    assert.equal((await send(`/posts?${new URLSearchParams({ region })}`)).status, 200);
    assert.equal(inputs.at(-1)?.region, region);
  }
});

test("숫자 만 나이 경계와 단일 나이는 허용하고 전체는 무제한 all로 유지한다", () => {
  for (const [min, max] of [[19, 99], [19, 19], [99, 99], [30, 39]]) {
    const parsed = parsePublicPostSearchQuery(new URL(`https://api.example.test/posts?ageMin=${min}&ageMax=${max}`), "member");
    assert.deepEqual(parsed.authorAge, { min, max });
  }
  assert.equal(parsePublicPostSearchQuery(new URL("https://api.example.test/posts?authorAge=all"), "anonymous").authorAge, "all");
  assert.equal(parsePublicPostSearchQuery(new URL("https://api.example.test/posts"), "member").authorAge, undefined);
});

test("나이 한쪽·범위 역전·구형 enum·중복 표현·잘못된 지역은 거절한다", async () => {
  const { send, inputs } = setup();
  for (const query of ["ageMin=19", "ageMax=99", "ageMin=18&ageMax=99", "ageMin=19&ageMax=100", "ageMin=39&ageMax=30", "ageMin=019&ageMax=99", "ageMin=1e1&ageMax=99", "ageMin=19.0&ageMax=99", "ageMin=&ageMax=99", "ageMin=19&ageMax=99&authorAge=all", "ageMin=19&ageMin=30&ageMax=99", "authorAge=20s", "authorAge=30s", "authorAge=40plus", "region=서울", "region=전체", "category=식사", "category=지금"]) {
    assert.equal((await send(`/posts?${query}`, { authorization: "Bearer member" })).status, 400, query);
  }
  assert.deepEqual(inputs, []);
});

test("비로그인 일정과 숫자 전체 범위도 executor 전에 로그인 가드한다", async () => {
  const { send, inputs } = setup();
  for (const query of ["ageMin=19&ageMax=99", "periodStart=2026-10-01T00:00:00Z&periodEnd=2026-10-02T00:00:00Z"]) {
    const response = await send(`/posts?${query}`);
    assert.equal(response.status, 401, query);
    assert.equal((await response.json()).error.code, "AUTH_REQUIRED");
  }
  assert.deepEqual(inputs, []);
});
