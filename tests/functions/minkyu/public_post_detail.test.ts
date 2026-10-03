/** 민규: 공개 상세의 HTTP 인증 분기와 좁은 익명 RPC 경계를 가상 네트워크로 검사한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { createPublicClient } from "../../../backend/supabase/functions/_shared/db/public-client.ts";
import { resolveRouteForMethod } from "../../../backend/supabase/functions/service-api/routes.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";

const API = "http://127.0.0.1:56421", ORIGIN = "http://127.0.0.1:5173";
const POST = "11111111-1111-4111-8111-111111111111", USER = "22222222-2222-4222-8222-222222222222";
const ANON = "synthetic-anon", SERVICE = "synthetic-service", TOKEN = "synthetic.member.signature";
const config = { supabaseUrl: API, supabaseAnonKey: ANON, supabaseServiceRoleKey: SERVICE,
  allowedOrigins: [ORIGIN], maxRequestBytes: 8192, upstreamTimeoutMs: 10000 };
const publicDetail = { postId: POST, title: "공개 상세 합성 공고", authorDisplayName: "동행-합성별칭", publicArea: "서울특별시 성동구 성수동" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { path: string; headers: Headers; body: unknown; method: string; redirect: RequestRedirect | undefined };

async function runtimeProbe(run: (handler: ReturnType<typeof createRuntimeHandler>, calls: Call[]) => Promise<void>,
  options: { authStatus?: number; authBody?: unknown; authThrow?: boolean; rpcStatus?: number; rpcBody?: unknown; serviceKey?: boolean } = {}) {
  const originalFetch = globalThis.fetch, calls: Call[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, API, "unexpected network target");
    calls.push({ path: url.pathname, method: init?.method ?? "GET", headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : null, redirect: init?.redirect });
    assert.equal(init?.redirect, "error");
    if (url.pathname === "/auth/v1/user") {
      if (options.authThrow) throw new Error("synthetic private upstream payload");
      return response(Object.hasOwn(options, "authBody") ? options.authBody : { id: USER, role: "authenticated", is_anonymous: false }, options.authStatus ?? 200);
    }
    assert.equal(url.pathname, "/rest/v1/rpc/get_service_post");
    return response(options.rpcBody ?? publicDetail, options.rpcStatus ?? 200);
  };
  try {
    const env: Record<string, string> = { SUPABASE_URL: API, SUPABASE_ANON_KEY: ANON,
      ALLOWED_ORIGINS: JSON.stringify([ORIGIN]), MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "10000" };
    if (options.serviceKey) env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
    await run(createRuntimeHandler(key => env[key]), calls);
  } finally { globalThis.fetch = originalFetch; }
}
const request = (path = `/functions/v1/service-api/posts/${POST}`, method = "GET", headers: Record<string, string> = {}) =>
  new Request(`${API}${path}`, { method, headers: { origin: ORIGIN, ...headers } });
async function failure(result: Response, status: number, code: string) {
  assert.equal(result.status, status);
  const body = await result.json(); assert.equal(body.error.code, code); assert.equal(body.data, undefined);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(body.requestId, result.headers.get("x-request-id"));
  assert.ok(!JSON.stringify(body).includes("synthetic private"));
}

test("정확한 두 상세 GET prefix는 토큰 없이 익명 키로 기존 RPC만 호출한다", async () => {
  await runtimeProbe(async (handler, calls) => {
    for (const prefix of ["/service-api", "/functions/v1/service-api"]) {
      const result = await handler(request(`${prefix}/posts/${POST}`));
      assert.equal(result.status, 200); assert.deepEqual((await result.json()).data, publicDetail);
      assert.equal(result.headers.get("access-control-allow-origin"), ORIGIN);
      assert.equal(result.headers.get("cache-control"), "no-store");
    }
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.path, "/rest/v1/rpc/get_service_post"); assert.equal(call.method, "POST");
      assert.equal(call.headers.get("apikey"), ANON); assert.equal(call.headers.get("authorization"), `Bearer ${ANON}`);
      assert.deepEqual(call.body, { p_post_id: POST });
    }
  });
});

test("회원 토큰은 Auth 검증 후 원래 bearer로 전달하며 서비스 키를 쓰지 않는다", async () => {
  await runtimeProbe(async (handler, calls) => {
    const result = await handler(request(undefined, "GET", { authorization: `Bearer ${TOKEN}` }));
    assert.equal(result.status, 200);
    assert.deepEqual(calls.map(call => call.path), ["/auth/v1/user", "/rest/v1/rpc/get_service_post"]);
    for (const call of calls) {
      assert.equal(call.headers.get("apikey"), ANON); assert.equal(call.headers.get("authorization"), `Bearer ${TOKEN}`);
    }
    assert.deepEqual(calls[1].body, { p_post_id: POST });
  }, { serviceKey: true });
});

test("빈 헤더·형식 오류·서버 키·익명 키는 익명 상세로 강등하지 않는다", async () => {
  await runtimeProbe(async (handler, calls) => {
    for (const authorization of ["", "Bearer", "Basic member", "Bearer malformed", `Bearer ${ANON}`, `Bearer ${SERVICE}`, "Bearer a.b.c, Bearer d.e.f"]) {
      await failure(await handler(request(undefined, "GET", { authorization })), 401, "AUTH_REQUIRED");
    }
    assert.equal(calls.length, 0);
  }, { serviceKey: true });
});

test("거절·만료 토큰은 Auth 호출 한 번 후 401이며 익명 RPC fallback은 없다", async () => {
  for (const authStatus of [401, 403]) await runtimeProbe(async (handler, calls) => {
    await failure(await handler(request(undefined, "GET", { authorization: `Bearer ${TOKEN}` })), 401, "AUTH_REQUIRED");
    assert.deepEqual(calls.map(call => call.path), ["/auth/v1/user"]);
  }, { authStatus, authBody: { message: "synthetic private rejected token" } });
});

test("Auth 장애·네트워크 실패는 503이며 익명 RPC fallback과 원문 노출이 없다", async () => {
  for (const options of [{ authStatus: 503 }, { authThrow: true }]) await runtimeProbe(async (handler, calls) => {
    await failure(await handler(request(undefined, "GET", { authorization: `Bearer ${TOKEN}` })), 503, "EXTERNAL_UNAVAILABLE");
    assert.deepEqual(calls.map(call => call.path), ["/auth/v1/user"]);
  }, options);
});

test("Auth 익명 세션·잘못된 주체·역할은 회원이나 익명 상세로 인정하지 않는다", async () => {
  for (const authBody of [{ id: USER, role: "authenticated", is_anonymous: true }, { id: "invalid", role: "authenticated" },
    { id: USER, role: "service_role" }, null, []]) await runtimeProbe(async (handler, calls) => {
    await failure(await handler(request(undefined, "GET", { authorization: `Bearer ${TOKEN}` })), 401, "AUTH_REQUIRED");
    assert.deepEqual(calls.map(call => call.path), ["/auth/v1/user"]);
  }, { authBody });
});

test("상세의 알 수 없는 쿼리·중복 쿼리·호출자 주입은 인증과 RPC 전에 거절한다", async () => {
  await runtimeProbe(async (handler, calls) => {
    for (const query of ["?caller=member", `?userId=${USER}`, "?token=private", "?limit=1", "?x=1&x=2", "?__proto__=member"]) {
      await failure(await handler(request(`/service-api/posts/${POST}${query}`, "GET", { authorization: `Bearer ${TOKEN}` })), 400, "INVALID_REQUEST");
    }
    assert.equal(calls.length, 0);
  });
});

test("상세 GET 이외 메서드와 신청·수정·삭제 경로에 공개 표식이 없다", async () => {
  await runtimeProbe(async (handler, calls) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      await failure(await handler(request(undefined, method)), 405, "METHOD_NOT_ALLOWED");
    }
    for (const suffix of ["requests", "update", "close", "delete"]) {
      await failure(await handler(request(`/service-api/posts/${POST}/${suffix}`, "GET")), 405, "METHOD_NOT_ALLOWED");
      await failure(await handler(request(`/service-api/posts/${POST}/${suffix}`, "POST")), 401, "AUTH_REQUIRED");
    }
    assert.equal(calls.length, 0);
  });
});

test("UUID 오류와 인코딩·중복 슬래시·추가 path는 RPC로 전달되지 않는다", async () => {
  await runtimeProbe(async (handler, calls) => {
    for (const id of ["not-a-uuid", `${POST}'`, "null"]) await failure(await handler(request(`/service-api/posts/${id}`)), 400, "INVALID_REQUEST");
    for (const path of [`/service-api/posts/%31${POST.slice(1)}`, `/service-api/posts//${POST}`, `/service-api/posts/${POST}/extra`,
      `/service-api/posts/${POST}/`, `/service-apix/posts/${POST}`, `/rpc/get_service_post`]) {
      await failure(await handler(request(path)), 404, "RESOURCE_NOT_FOUND");
    }
    assert.equal(calls.length, 0);
  });
});

test("GET body는 익명 인증과 RPC 전에 거절한다", async () => {
  await runtimeProbe(async (handler, calls) => {
    const input = request(); Object.defineProperty(input, "body", { value: new ReadableStream() });
    await failure(await handler(input), 400, "INVALID_REQUEST"); assert.equal(calls.length, 0);
  });
});

test("금지 Origin과 preflight 오류는 네트워크를 실행하지 않는다", async () => {
  await runtimeProbe(async (handler, calls) => {
    const blocked = await handler(request(undefined, "GET", { origin: "https://other.example.test" }));
    await failure(blocked, 403, "ACCESS_DENIED"); assert.equal(blocked.headers.get("access-control-allow-origin"), null);
    const ok = await handler(request(undefined, "OPTIONS", { "access-control-request-method": "GET", "access-control-request-headers": "authorization" }));
    assert.equal(ok.status, 204); assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
    await failure(await handler(request(undefined, "OPTIONS", { "access-control-request-method": "GET", "access-control-request-headers": "x-caller" })), 403, "ACCESS_DENIED");
    assert.equal(calls.length, 0);
  });
});

test("다른 개인·관계 경로와 원문 RPC endpoint는 계속 인증이 필요하다", async () => {
  await runtimeProbe(async (handler, calls) => {
    for (const path of ["/me", "/appointments", `/appointments/${POST}`, `/profiles/${USER}`, `/conversations/${POST}`, "/requests/sent"]) {
      await failure(await handler(request(`/service-api${path}`)), 401, "AUTH_REQUIRED");
    }
    await failure(await handler(request("/service-api/rpc/get_service_post", "POST")), 404, "RESOURCE_NOT_FOUND");
    assert.equal(calls.length, 0);
  });
});

test("삭제·부재 RPC 오류는 404로 변환하며 상세 DB 오류를 공개하지 않는다", async () => {
  await runtimeProbe(async (handler, calls) => {
    await failure(await handler(request()), 404, "RESOURCE_NOT_FOUND"); assert.equal(calls.length, 1);
  }, { rpcStatus: 404, rpcBody: { code: "P0002", message: "synthetic private unavailable row", details: "synthetic private SQL context" } });
});

test("공개 client는 상세 읽기만 추가하며 사용자·내부·임의 RPC를 차단한다", async () => {
  let fetches = 0;
  const client = createPublicClient(config, async (_input, init) => { fetches++; assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${ANON}`); return response(publicDetail); });
  assert.deepEqual(await client.rpc("get_service_post", { p_post_id: POST }), publicDetail);
  for (const name of ["get_my_profile", "create_service_post", "set_post_search_location", "get_conversation", "cancel_appointment", "process_due_review_publications", "get_service_post/../get_my_profile"]) {
    await assert.rejects(client.rpc(name, {}), HttpError);
  }
  assert.equal(fetches, 1);
});

test("정확한 GET 상세만 route 표식을 받고 의존성 미지정은 기존 사용자 인증을 유지한다", async () => {
  const route = resolveRouteForMethod(new URL(`${API}/service-api/posts/${POST}`), "GET");
  assert.equal((route as { publicPostDetail?: boolean }).publicPostDetail, true);
  for (const suffix of ["requests", "update", "close", "delete"]) {
    assert.notEqual((resolveRouteForMethod(new URL(`${API}/service-api/posts/${POST}/${suffix}`), "POST") as { publicPostDetail?: boolean }).publicPostDetail, true);
  }
  let privateAuth = 0;
  const handler = createServiceApi({ allowedOrigins: [ORIGIN], maxBodyBytes: 8192,
    authenticateUser: async () => { privateAuth++; throw new HttpError("AUTH_REQUIRED"); },
    authenticateInternal: async () => { throw new HttpError("ACCESS_DENIED"); } });
  await failure(await handler(request()), 401, "AUTH_REQUIRED"); assert.equal(privateAuth, 1);
});
