/** 민규담당. 실제 인증·종현 검색 코어·DB 클라이언트 조립을 fetch 모형으로 검사한다. 실제 DB 실행 검증은 별도다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import entrypoint, { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
import type { PublicPostSearchExecutor } from "../../../backend/supabase/functions/service-api/search-http.ts";
const uid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const jwt = "header.verified_by_fixture.signature";
const env: Record<string, string> = {
  SUPABASE_URL: "https://project.example.test", SUPABASE_ANON_KEY: "fixture-anon",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-private-service", INTERNAL_WORKER_SECRET: "fixture_internal_secret_at_least_32_characters",
  ALLOWED_ORIGINS: '["https://app.example.test"]', MAX_REQUEST_BYTES: "65536", UPSTREAM_TIMEOUT_MS: "1000",
};
const emptyPage = { status: "no_results" as const, posts: [], nextCursor: null };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const request = (authorization?: string, query = "") => new Request(`https://api.example.test/functions/v1/service-api/posts${query}`, { headers: authorization === undefined ? {} : { authorization } });

// 가상 executor는 검색 의미를 구현하지 않는다. 전달받은 client의 RPC 자격 증명만 확인한다.
const probe: PublicPostSearchExecutor = async (db, input) => {
  await db.rpc("search_public_posts_v2", { p_filters: { sort: input.sort ?? "created_desc", authorAge: input.authorAge ?? "all" }, p_cursor: null, p_limit: input.limit ?? 10 });
  return emptyPage;
};

async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = original; }
}

test("익명 검색은 Auth 호출 없이 anon 자격 증명으로 공개 RPC에 도달한다", async () => {
  const calls: string[] = [];
  await withFetch(async (url, init) => {
    calls.push(String(url));
    assert.equal(String(url), `${env.SUPABASE_URL}/rest/v1/rpc/search_public_posts_v2`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), env.SUPABASE_ANON_KEY);
    assert.equal(headers.get("authorization"), `Bearer ${env.SUPABASE_ANON_KEY}`);
    assert.doesNotMatch(JSON.stringify(init), /fixture-private-service|fixture_internal_secret/);
    return json({ items: [], nextCursor: null });
  }, async () => {
    let caller = "";
    const handler = createRuntimeHandler((key) => env[key], { publicPostSearch: async (db, input) => { caller = input.caller; return probe(db, input); } });
    assert.equal((await handler(request(undefined, "?sort=starts_asc"))).status, 200);
    assert.equal(caller, "anonymous");
    assert.equal(calls.length, 1);
  });
});

test("회원 검색은 Auth 검증 후 같은 JWT를 RPC에 전달하며 서비스 키를 쓰지 않는다", async () => {
  const calls: string[] = [];
  await withFetch(async (url, init) => {
    calls.push(String(url));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${jwt}`);
    assert.equal(headers.get("apikey"), env.SUPABASE_ANON_KEY);
    assert.doesNotMatch(JSON.stringify(init), /fixture-private-service|fixture_internal_secret/);
    if (String(url).endsWith("/auth/v1/user")) return json({ id: uid, role: "authenticated", is_anonymous: false });
    assert.equal(String(url), `${env.SUPABASE_URL}/rest/v1/rpc/search_public_posts_v2`);
    assert.deepEqual(JSON.parse(String(init?.body)).p_filters.authorAge, { min: 30, max: 39 });
    return json({ items: [], nextCursor: null });
  }, async () => {
    let caller = "";
    const handler = createRuntimeHandler((key) => env[key], { publicPostSearch: async (db, input) => { caller = input.caller; return probe(db, input); } });
    assert.equal((await handler(request(`Bearer ${jwt}`, "?ageMin=30&ageMax=39"))).status, 200);
    assert.equal(caller, "member");
    assert.deepEqual(calls, [`${env.SUPABASE_URL}/auth/v1/user`, `${env.SUPABASE_URL}/rest/v1/rpc/search_public_posts_v2`]);
  });
});

test("빈·잘못된 Authorization과 anon·service·worker 키는 익명으로 강등하지 않는다", async () => {
  await withFetch(async () => assert.fail("금지한 자격 증명으로 외부 호출하지 않는다"), async () => {
    let executions = 0;
    const handler = createRuntimeHandler((key) => env[key], { publicPostSearch: async () => { executions++; return emptyPage; } });
    for (const authorization of ["", "Basic value", "Bearer invalid", `Bearer ${env.SUPABASE_ANON_KEY}`, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, `Bearer ${env.INTERNAL_WORKER_SECRET}`]) {
      const response = await handler(request(authorization));
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, "AUTH_REQUIRED");
    }
    assert.equal(executions, 0);
  });
});

test("Auth의 만료·익명 계정·서버 장애는 익명 검색으로 이어지지 않는다", async () => {
  for (const [upstreamStatus, body, expected] of [[401, { message: "secret-auth-detail" }, 401], [403, { message: "secret-auth-detail" }, 401], [200, { id: uid, role: "authenticated", is_anonymous: true }, 401], [503, { message: "secret-auth-detail" }, 503]] as const) {
    let requests = 0;
    await withFetch(async (url) => { requests++; assert.equal(String(url), `${env.SUPABASE_URL}/auth/v1/user`); return json(body, upstreamStatus); }, async () => {
      const handler = createRuntimeHandler((key) => env[key], { publicPostSearch: async () => assert.fail("Auth 실패 후 검색하지 않는다") });
      const response = await handler(request(`Bearer ${jwt}`));
      assert.equal(response.status, expected);
      assert.doesNotMatch(await response.text(), /secret-auth-detail|verified_by_fixture|private-service/);
      assert.equal(requests, 1);
    });
  }
});

test("공개 검색 client로 내부·쓰기 RPC를 시도하면 네트워크 전에 거절한다", async () => {
  await withFetch(async () => assert.fail("공개 client에서 쓰기 요청은 나가지 않는다"), async () => {
    for (const name of ["create_service_post", "process_due_completions", "get_my_profile"]) {
      const handler = createRuntimeHandler((key) => env[key], { publicPostSearch: async (db) => { await db.rpc(name, {}); return emptyPage; } });
      assert.equal((await handler(request())).status, 403, name);
    }
  });
});

test("검색 RPC 권한·유효성·장애 오류는 원문 없이 공통 HTTP 응답이 된다", async () => {
  for (const [status, code, expected] of [[403, "28000", 401], [403, "42501", 403], [400, "22023", 400], [503, "PGRST000", 503]] as const) {
    await withFetch(async (url) => { assert.equal(String(url), `${env.SUPABASE_URL}/rest/v1/rpc/search_public_posts_v2`); return json({ code, message: "SELECT private.address secret-token", details: "민감한 상세" }, status); }, async () => {
      const handler = createRuntimeHandler((key) => env[key]);
      const response = await handler(request());
      assert.equal(response.status, expected);
      assert.doesNotMatch(await response.text(), /SELECT|secret-token|민감한 상세|PGRST000/);
    });
  }
});

test("기본 검색 조립은 종현 코어의 정규화·기본값을 v2 RPC에 전달한다", async () => {
  const calls: string[] = [];
  await withFetch(async (url, init) => {
    calls.push(String(url));
    assert.equal(String(url), `${env.SUPABASE_URL}/rest/v1/rpc/search_public_posts_v2`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      p_contract_version: "2026-10-05", p_region: null,
      p_filters: { query: "전시 a", category: null, cost: "all", availability: "all", sort: "created_desc", periodStart: null, periodEnd: null, authorAge: "all" },
      p_cursor: null, p_limit: 10,
    });
    return json({ items: [], nextCursor: null });
  }, async () => {
    const handler = createRuntimeHandler((key) => env[key]);
    const response = await handler(request(undefined, `?query=${encodeURIComponent("  전시  A  ")}`));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, emptyPage);
    assert.equal(calls.length, 1);
  });
});

test("기본 검색 연결 이후에도 POST는 계속 회원 인증이 필요하다", async () => {
  await withFetch(async () => assert.fail("미인증 POST는 외부 호출하지 않는다"), async () => {
    const handler = createRuntimeHandler((key) => env[key]);
    assert.equal((await handler(new Request("https://api.example.test/service-api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).status, 401);
  });
});

const publicCard = {
  id: "11111111-1111-4111-8111-111111111111", title: "함께 전시",
  authorDisplayName: null, publicArea: "서울특별시 종로구 삼청동",
  startsAt: "2026-10-01T00:00:00.123456Z", endsAt: "2026-10-01T03:00:00Z",
  cost: { kind: "free" }, state: "recruiting", canApply: false,
};

test("기본 코어는 동 공개·선택 정렬·마이크로초 v3 커서를 유지한다", async () => {
  let cursor: string;
  let calls = 0;
  await withFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.p_filters.sort, "starts_asc");
    assert.equal(body.p_filters.periodStart, null);
    assert.equal(body.p_filters.periodEnd, null);
    assert.equal(body.p_filters.authorAge, "all");
    assert.equal(body.p_limit, 1);
    if (calls++ === 0) {
      assert.equal(body.p_cursor, null);
      return json({ items: [publicCard], nextCursor: { sortAt: publicCard.startsAt, id: publicCard.id } });
    }
    assert.deepEqual(body.p_cursor, { sortAt: publicCard.startsAt, id: publicCard.id });
    return json({ items: [], nextCursor: null });
  }, async () => {
    const handler = createRuntimeHandler((key) => env[key]);
    const query = "?sort=starts_asc&limit=1";
    const first = await handler(request(undefined, query));
    assert.equal(first.status, 200);
    const page = (await first.json()).data;
    assert.deepEqual(page.posts, [publicCard]);
    cursor = page.nextCursor;
    assert.equal(typeof cursor, "string");
    const next = await handler(request(undefined, `${query}&cursor=${cursor}`));
    assert.equal(next.status, 200);
    assert.deepEqual((await next.json()).data, emptyPage);
    const changed = await handler(request(undefined, `${query.replace("starts_asc", "created_desc")}&cursor=${cursor}`));
    assert.equal(changed.status, 400);
    assert.equal(calls, 2);
  });
});

test("기본 코어 회원 검색은 검증된 JWT·나이 필터와 마스킹 이름을 사용한다", async () => {
  const memberCard = { ...publicCard, authorDisplayName: "김*연", canApply: true };
  await withFetch(async (url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${jwt}`);
    assert.equal(headers.get("apikey"), env.SUPABASE_ANON_KEY);
    if (String(url).endsWith("/auth/v1/user")) return json({ id: uid, role: "authenticated", is_anonymous: false });
    assert.deepEqual(JSON.parse(String(init?.body)).p_filters.authorAge, { min: 30, max: 39 });
    return json({ items: [memberCard], nextCursor: null });
  }, async () => {
    const response = await createRuntimeHandler((key) => env[key])(request(`Bearer ${jwt}`, "?ageMin=30&ageMax=39"));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.posts, [memberCard]);
  });
});

test("기본 코어의 잘못된 기간·커서는 DB 호출 전에 거절한다", async () => {
  await withFetch(async () => assert.fail("잘못된 검색 입력으로 DB 호출하지 않는다"), async () => {
    const handler = createRuntimeHandler((key) => env[key]);
    for (const query of ["?cursor=invalid", "?periodStart=2026-10-02T00:00:00Z&periodEnd=2026-10-01T00:00:00Z", "?periodStart=2026-02-30T00:00:00Z&periodEnd=2026-03-02T00:00:00Z"]) {
      const response = await handler(request(undefined, query));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "INVALID_REQUEST");
    }
  });
});

test("기본 코어는 비공개 필드가 섞이거나 형식이 잘못된 DB 결과를 응답하지 않는다", async () => {
  for (const value of [
    { items: [{ ...publicCard, registeredAddress: "민감한 상세주소" }], nextCursor: null },
    { items: [{ ...publicCard, publicArea: "서울특별시 종로구" }], nextCursor: null },
    { items: [], nextCursor: { sortAt: publicCard.startsAt, id: publicCard.id } },
  ]) {
    await withFetch(async () => json(value), async () => {
      const response = await createRuntimeHandler((key) => env[key])(request());
      assert.equal(response.status, 500);
      assert.equal((await response.clone().json()).error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(await response.text(), /민감한|registeredAddress|삼청동|INVALID_SEARCH/);
    });
  }
});

test("호스팅 default fetch도 같은 기본 검색 코어를 실행한다", async () => {
  const runtime = globalThis as unknown as { Deno?: { env: { get(key: string): string | undefined } } };
  const saved = runtime.Deno;
  runtime.Deno = { env: { get: (key) => env[key] } };
  try {
    await withFetch(async (url, init) => {
      assert.equal(String(url), `${env.SUPABASE_URL}/rest/v1/rpc/search_public_posts_v2`);
      assert.equal(JSON.parse(String(init?.body)).p_filters.sort, "created_desc");
      return json({ items: [publicCard], nextCursor: null });
    }, async () => {
      const response = await entrypoint.fetch(request());
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data.posts, [publicCard]);
    });
  } finally {
    if (saved === undefined) delete runtime.Deno;
    else runtime.Deno = saved;
  }
});


test("모바일 URL의 지역·분류·숫자 나이·일정이 기본 코어에서 최신 RPC로 손실 없이 전달된다", async () => {
  let rpcCalls = 0;
  await withFetch(async (url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${jwt}`);
    if (String(url).endsWith("/auth/v1/user")) return json({ id: uid, role: "authenticated", is_anonymous: false });
    assert.equal(String(url), `${env.SUPABASE_URL}/rest/v1/rpc/search_public_posts_v2`);
    rpcCalls++;
    assert.deepEqual(JSON.parse(String(init?.body)), {
      p_contract_version: "2026-10-05", p_region: "경기도",
      p_filters: { query: "팝업", category: "팝업", cost: "free", availability: "recruiting", sort: "starts_asc", periodStart: "2026-10-05T00:00:00+09:00", periodEnd: "2026-10-06T00:00:00+09:00", authorAge: { min: 19, max: 99 } },
      p_cursor: null, p_limit: 10,
    });
    return json({ items: [], nextCursor: null });
  }, async () => {
    const query = new URLSearchParams({ query: "팝업", category: "팝업", region: "경기도", cost: "free", availability: "recruiting", sort: "starts_asc", periodStart: "2026-10-05T00:00:00+09:00", periodEnd: "2026-10-06T00:00:00+09:00", ageMin: "19", ageMax: "99", limit: "10" });
    const response = await createRuntimeHandler((key) => env[key])(request(`Bearer ${jwt}`, `?${query}`));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, emptyPage);
    assert.equal(rpcCalls, 1);
  });
});

test("익명 작성자 이름이 DB 응답에 들어오면 기본 코어가 공개하지 않는다", async () => {
  await withFetch(async () => json({ items: [{ ...publicCard, authorDisplayName: "김*연" }], nextCursor: null }), async () => {
    const response = await createRuntimeHandler((key) => env[key])(request());
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /김|삼청동|authorDisplayName/);
  });
});
