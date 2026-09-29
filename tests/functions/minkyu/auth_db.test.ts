/** 민규담당: 인증 서버/DB 경계의 실패·권한 혼동·비밀 비노출을 네트워크 모형으로 검증. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig, type RuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { requirePrincipal, requireOptionalPrincipal, getPrincipalToken, type Principal } from "../../../backend/supabase/functions/_shared/auth/principal.ts";
import { requireInternalCaller } from "../../../backend/supabase/functions/_shared/auth/internal-caller.ts";
import { evaluateTrustedEligibility } from "../../../backend/supabase/functions/_shared/auth/eligibility.ts";
import { createPublicClient } from "../../../backend/supabase/functions/_shared/db/public-client.ts";
import { createUserClient } from "../../../backend/supabase/functions/_shared/db/user-client.ts";
import { createInternalClient } from "../../../backend/supabase/functions/_shared/db/internal-client.ts";
import type { FetchLike } from "../../../backend/supabase/functions/_shared/db/transport.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
const uid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const jwt = "header.validated_by_remote.signature";
const env: Record<string, string> = {
  SUPABASE_URL: "https://project.example.test", SUPABASE_ANON_KEY: "public-anon",
  SUPABASE_SERVICE_ROLE_KEY: "private-service", INTERNAL_WORKER_SECRET: "internal_random_secret_at_least_32_characters",
  ALLOWED_ORIGINS: '["https://app.example.test"]', MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "1000",
};
const config = () => loadRuntimeConfig((key) => env[key]);
const bearer = (token = jwt, headers = {}) => new Request("https://api.example.test", { headers: { Authorization: `Bearer ${token}`, ...headers } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const authFetch: FetchLike = async () => json({ id: uid, role: "authenticated", is_anonymous: false });
const principal = () => requirePrincipal(bearer(), config(), authFetch);
const code = (expected: string) => (error: unknown) => {
  assert.equal(toPublicError(error).error.code, expected);
  assert.doesNotMatch(JSON.stringify(toPublicError(error)), /private-service|internal_random|sensitive-detail|SELECT|validat.*signature/);
  return true;
};

test("환경은 주입되며 사용자 기능은 내부 키 없이 시작하고 내부는 닫힌다", () => {
  const c = loadRuntimeConfig((key) => key === "SUPABASE_SERVICE_ROLE_KEY" || key === "INTERNAL_WORKER_SECRET" ? undefined : env[key]);
  assert.equal(c.supabaseUrl, env.SUPABASE_URL);
  assert.throws(() => createInternalClient(c), code("EXTERNAL_UNAVAILABLE"));
  assert.equal(JSON.stringify(config()), '{"configured":true}');
  assert.ok(Object.isFrozen(c));
});

test("환경 누락·와일드카드 origin·비정수 한도·자격증명 URL을 원문 없이 거절한다", () => {
  for (const [name, value] of [
    ["SUPABASE_URL", "https://secret:password@example.test"],
    ["SUPABASE_URL", "http://remote.example.test"], ["SUPABASE_URL", "https://example.test/?token=sensitive-detail"],
    ["ALLOWED_ORIGINS", '["*"]'], ["ALLOWED_ORIGINS", '["https://app.example.test/path"]'],
    ["MAX_REQUEST_BYTES", "0"], ["UPSTREAM_TIMEOUT_MS", "1.1"], ["UPSTREAM_TIMEOUT_MS", "2147483648"],
    ["SUPABASE_ANON_KEY", ""], ["MAX_REQUEST_BYTES", "01"],
  ]) assert.throws(() => loadRuntimeConfig((key) => key === name ? value : env[key]), code("EXTERNAL_UNAVAILABLE"));
  assert.equal(loadRuntimeConfig((key) => key === "SUPABASE_URL" ? "http://127.0.0.1:55421" : env[key]).supabaseUrl, "http://127.0.0.1:55421");
});

test("인증 서버 검증 ID만 사용하며 원래 JWT를 숨겨 보관한다", async () => {
  let requested = false;
  const p = await requirePrincipal(bearer(jwt, { "x-user-id": "attacker", "x-role": "service_role" }), config(), async (url, init) => {
    requested = true;
    assert.equal(url, `${env.SUPABASE_URL}/auth/v1/user`);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${jwt}`);
    assert.equal(new Headers(init?.headers).get("apikey"), env.SUPABASE_ANON_KEY);
    assert.equal(init?.redirect, "error");
    return authFetch(url, init);
  });
  assert.ok(requested);
  assert.deepEqual(p, { userId: uid });
  assert.equal(getPrincipalToken(p), jwt);
  assert.doesNotMatch(JSON.stringify(p), /signature|token/);
  assert.ok(Object.isFrozen(p));
});

test("누락·위조 사용자 객체·서비스 키·내부 비밀은 사용자 세션이 아니다", async () => {
  const noNetwork: FetchLike = async () => { assert.fail("must not request"); };
  await assert.rejects(requirePrincipal(new Request("https://api.example.test", { headers: { "x-user-id": uid } }), config(), noNetwork), code("AUTH_REQUIRED"));
  for (const token of ["not-a-jwt", env.SUPABASE_ANON_KEY, env.SUPABASE_SERVICE_ROLE_KEY, env.INTERNAL_WORKER_SECRET]) {
    await assert.rejects(requirePrincipal(bearer(token), config(), noNetwork), code("AUTH_REQUIRED"));
  }
  assert.throws(() => createUserClient(config(), { userId: uid }), code("AUTH_REQUIRED"));
  assert.throws(() => getPrincipalToken({ ...({ userId: uid } as Principal) }), code("AUTH_REQUIRED"));
});

test("서명처럼 보이는 문자열도 서버가 거절하면 인증되지 않는다", async () => {
  for (const status of [401, 403]) {
    await assert.rejects(requirePrincipal(bearer(), config(), async () => json({ message: "sensitive-detail", token: jwt }, status)), code("AUTH_REQUIRED"));
  }
  for (const body of [{ id: uid, role: "service_role" }, { id: uid, role: "authenticated", is_anonymous: true }, { id: "bad", role: "authenticated" }, {}]) {
    await assert.rejects(requirePrincipal(bearer(), config(), async () => json(body)), code("AUTH_REQUIRED"));
  }
});

test("인증 네트워크 장애·잘못된 응답은 상세 없이 503이다", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("sensitive-detail private-service"); },
    async () => new Response("sensitive-detail", { status: 500 }),
    async () => json({ message: "sensitive-detail" }, 503),
  ] as FetchLike[]) await assert.rejects(requirePrincipal(bearer(), config(), fetchImpl), code("EXTERNAL_UNAVAILABLE"));
});

test("타임아웃은 요청을 abort하고 원문 오류를 폐기한다", async () => {
  let aborted = false;
  const waitUntilAbort: FetchLike = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("sensitive-detail timeout")); }, { once: true });
  });
  await assert.rejects(requirePrincipal(bearer(), { ...config(), upstreamTimeoutMs: 5 }, waitUntilAbort), code("EXTERNAL_UNAVAILABLE"));
  assert.equal(aborted, true);
});

test("사용자 RPC는 검증한 JWT와 anon key를 전달하고 서비스 키를 쓰지 않는다", async () => {
  const p = await principal();
  const client = createUserClient(config(), p, async (url, init) => {
    assert.equal(url, `${env.SUPABASE_URL}/rest/v1/rpc/get_my_profile`);
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${jwt}`);
    assert.equal(headers.get("apikey"), env.SUPABASE_ANON_KEY);
    assert.equal(init?.body, "{}");
    assert.doesNotMatch(JSON.stringify(init), /private-service/);
    return json({ id: uid });
  });
  assert.deepEqual(await client.rpc("get_my_profile", {}), { id: uid });
});

test("사용자 RPC는 내부 작업·이전 수기 가입·임의 테이블 호출을 차단한다", async () => {
  const client = createUserClient(config(), await principal(), async () => assert.fail("must not request"));
  for (const name of ["process_due_completions", "enqueue_job", "complete_signup", "create_post", "../profiles", "get_my_profile?select=*"]) {
    await assert.rejects(client.rpc(name, {}), code("ACCESS_DENIED"));
  }
});

test("내부 인증은 별도 비밀만 받으며 역할 헤더·사용자 JWT·서비스 키는 거절한다", async () => {
  await requireInternalCaller(bearer(env.INTERNAL_WORKER_SECRET), config());
  for (const token of [jwt, env.SUPABASE_SERVICE_ROLE_KEY, `${env.INTERNAL_WORKER_SECRET}x`]) {
    await assert.rejects(requireInternalCaller(bearer(token, { "x-internal": "true", "x-role": "service_role" }), config()), code("ACCESS_DENIED"));
  }
  for (const value of [undefined, "short", env.SUPABASE_SERVICE_ROLE_KEY, `${"x".repeat(32)}\n`]) {
    await assert.rejects(requireInternalCaller(bearer(), { ...config(), internalWorkerSecret: value }), code("EXTERNAL_UNAVAILABLE"));
  }
});

test("내부 DB는 고정 RPC 목록과 서비스 키만 사용한다", async () => {
  const client = createInternalClient(config(), async (url, init) => {
    assert.equal(url, `${env.SUPABASE_URL}/rest/v1/rpc/process_due_completions`);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    assert.equal(new Headers(init?.headers).get("apikey"), env.SUPABASE_SERVICE_ROLE_KEY);
    return json({ processed: 1 });
  });
  assert.deepEqual(await client.rpc("process_due_completions", { p_limit: 1 }), { processed: 1 });
  for (const name of ["get_my_profile", "sql", "profiles", "complete_signup"]) await assert.rejects(client.rpc(name, {}), code("ACCESS_DENIED"));
});

test("DB SQLSTATE는 고정 공개 오류로 변환하고 상세·힌트를 버린다", async () => {
  const p = await principal();
  for (const [sql, status, expected] of [
    ["42501", 403, "ACCESS_DENIED"], ["22023", 400, "INVALID_REQUEST"], ["23505", 409, "STATE_CONFLICT"],
    ["28000", 400, "AUTH_REQUIRED"], ["PT404", 404, "RESOURCE_NOT_FOUND"], ["PT503", 503, "EXTERNAL_UNAVAILABLE"],
    ["P0001", 400, "STATE_CONFLICT"], ["P0002", 400, "RESOURCE_NOT_FOUND"], ["40001", 500, "STATE_CONFLICT"],
    ["99999", 400, "INTERNAL_ERROR"], ["any", 401, "AUTH_REQUIRED"], ["any", 503, "EXTERNAL_UNAVAILABLE"],
  ] as const) {
    const client = createUserClient(config(), p, async () => json({ code: sql, message: "sensitive-detail", details: "SELECT private-service", hint: jwt }, status));
    await assert.rejects(client.rpc("get_my_profile", {}), code(expected));
  }
});

test("204 RPC 응답은 null이며 JSON 없는 오류는 원문 없이 실패한다", async () => {
  const p = await principal();
  assert.equal(await createUserClient(config(), p, async () => new Response(null, { status: 204 })).rpc("mark_all_my_notifications_read", {}), null);
  await assert.rejects(createUserClient(config(), p, async () => new Response("sensitive-detail", { status: 502 })).rpc("get_my_profile", {}), code("EXTERNAL_UNAVAILABLE"));
});

test("PASS 근거 해석은 legacy·다른 사용자·불완전 DI를 자격으로 바꾸지 않는다", async () => {
  const p = await principal();
  const proof = { source: "pass" as const, userId: uid, qualificationVerified: true, diUnique: true, profilePhotoPresent: true };
  assert.equal(evaluateTrustedEligibility(p, null), "verification_required");
  assert.equal(evaluateTrustedEligibility(p, { ...proof, userId: "other" }), "verification_required");
  assert.equal(evaluateTrustedEligibility(p, { ...proof, diUnique: false }), "verification_required");
  assert.equal(evaluateTrustedEligibility(p, { ...proof, source: "female_direct" } as unknown as typeof proof), "verification_required");
  assert.equal(evaluateTrustedEligibility(p, { ...proof, profilePhotoPresent: false }), "photo_required");
  assert.equal(evaluateTrustedEligibility(p, proof), "eligible");
});


test("선택 인증은 Authorization 헤더가 없는 경우만 네트워크 없이 null이다", async () => {
  const request = new Request("https://api.example.test", { headers: { "x-user-id": uid, "x-role": "authenticated", apikey: env.SUPABASE_ANON_KEY } });
  const result = await requireOptionalPrincipal(request, config(), async () => assert.fail("must not request"));
  assert.equal(result, null);
});

test("빈 Authorization·잘못된 형식·각종 서버 키는 익명으로 강등하지 않는다", async () => {
  const noNetwork: FetchLike = async () => assert.fail("must not request");
  for (const authorization of ["", " ", "Bearer", "Basic value", "Bearer invalid", `Bearer ${env.SUPABASE_ANON_KEY}`, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, `Bearer ${env.INTERNAL_WORKER_SECRET}`]) {
    const request = new Request("https://api.example.test", { headers: { authorization } });
    await assert.rejects(requireOptionalPrincipal(request, config(), noNetwork), code("AUTH_REQUIRED"));
  }
});

test("선택 인증도 만료 JWT·익명 Auth 계정·서버 장애를 그대로 거절한다", async () => {
  for (const status of [401, 403]) {
    await assert.rejects(requireOptionalPrincipal(bearer(), config(), async () => json({ message: "sensitive-detail" }, status)), code("AUTH_REQUIRED"));
  }
  await assert.rejects(requireOptionalPrincipal(bearer(), config(), async () => json({ id: uid, role: "authenticated", is_anonymous: true })), code("AUTH_REQUIRED"));
  await assert.rejects(requireOptionalPrincipal(bearer(), config(), async () => json({ message: "sensitive-detail" }, 503)), code("EXTERNAL_UNAVAILABLE"));
});

test("익명 검색 클라이언트는 anon key만 전달하고 서비스·내부 비밀을 읽지 않는다", async () => {
  const c = { ...config() };
  Object.defineProperty(c, "supabaseServiceRoleKey", { get() { assert.fail("must not read service key"); } });
  Object.defineProperty(c, "internalWorkerSecret", { get() { assert.fail("must not read internal secret"); } });
  const args = { p_query: "전시" };
  const client = createPublicClient(c, async (url, init) => {
    assert.equal(url, `${env.SUPABASE_URL}/rest/v1/rpc/search_public_posts_v2`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), env.SUPABASE_ANON_KEY);
    assert.equal(headers.get("authorization"), `Bearer ${env.SUPABASE_ANON_KEY}`);
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), args);
    assert.doesNotMatch(JSON.stringify(init), /private-service|internal_random|validated_by_remote/);
    return json({ items: [], nextCursor: null });
  });
  assert.deepEqual(await client.rpc("search_public_posts_v2", args), { items: [], nextCursor: null });
});

test("익명 클라이언트는 공개 검색 한 개 외 읽기·쓰기·내부 RPC 모두 요청 전에 차단한다", async () => {
  const client = createPublicClient(config(), async () => assert.fail("must not request"));
  for (const name of ["search_public_posts", "get_service_post", "get_my_profile", "create_service_post", "request_service_post", "confirm_appointment_completion", "enqueue_job", "process_due_completions", "complete_signup", "../profiles", "search_public_posts_v2?select=*"]) {
    await assert.rejects(client.rpc(name, {}), code("ACCESS_DENIED"));
  }
});

test("선택 인증의 검증된 회원 검색은 원래 JWT로 RLS 문맥을 유지한다", async () => {
  const p = await requireOptionalPrincipal(bearer(), config(), authFetch);
  assert.ok(p);
  assert.equal(p.userId, uid);
  assert.equal(getPrincipalToken(p), jwt);
  const client = createUserClient(config(), p, async (url, init) => {
    assert.equal(url, `${env.SUPABASE_URL}/rest/v1/rpc/search_public_posts_v2`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), env.SUPABASE_ANON_KEY);
    assert.equal(headers.get("authorization"), `Bearer ${jwt}`);
    assert.notEqual(headers.get("authorization"), `Bearer ${env.SUPABASE_ANON_KEY}`);
    assert.doesNotMatch(JSON.stringify(init), /private-service|internal_random/);
    return json({ items: [] });
  });
  assert.deepEqual(await client.rpc("search_public_posts_v2", {}), { items: [] });
});


test("익명 검색의 HTTP403 + SQLSTATE28000은 로그인 필요이며 다른403은 접근 거절이다", async () => {
  for (const [body, expected] of [
    [{ code: "28000", message: "sensitive-detail" }, "AUTH_REQUIRED"],
    [{ code: "42501", message: "sensitive-detail" }, "ACCESS_DENIED"],
    [{ code: "unknown", message: "28000 sensitive-detail" }, "ACCESS_DENIED"],
    [{ code: 28000, message: "sensitive-detail" }, "ACCESS_DENIED"],
  ] as const) {
    const client = createPublicClient(config(), async () => json(body, 403));
    await assert.rejects(client.rpc("search_public_posts_v2", {}), code(expected));
  }
});
