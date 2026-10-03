/** 민규담당. 완료·후기 HTTP 계약. 실제 공개·집계·시간 판단은 SQL 통합 검사에서 검증한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
import { HttpError, toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import { requirePrincipal } from "../../../backend/supabase/functions/_shared/auth/principal.ts";
import { createUserClient } from "../../../backend/supabase/functions/_shared/db/user-client.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const catalog = { items: [
  { code: "punctual", label: "시간을 잘 지켜요" }, { code: "keeps_promises", label: "약속한 내용을 지켜요" },
  { code: "communicates_well", label: "소통이 원활해요" }, { code: "considerate", label: "배려심이 있어요" },
  { code: "enjoyable_conversation", label: "대화가 즐거워요" }, { code: "comfortable_companion", label: "함께하니 편안해요" },
] };
type Call = { name: string; args: Record<string, JsonValue>; role: string };
function setup(reply: (name: string) => Promise<JsonValue> = async () => catalog) {
  const calls: Call[] = [];
  const db = (role: string) => ({ rpc: async (name: string, args: Record<string, JsonValue>) => { calls.push({ name, args, role }); return reply(name); } });
  const handler = createServiceApi({ allowedOrigins: ["https://app.example.test"], maxBodyBytes: 8192,
    authenticateUser: async request => { if (request.headers.get("authorization") !== "Bearer member") throw new HttpError("AUTH_REQUIRED"); return db("user"); },
    authenticateInternal: async () => db("internal"),
  });
  const send = (path: string, method = "GET", body?: unknown, token = "member") => handler(new Request(`https://api.example.test/service-api${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { send, handler, calls };
}

test("칭찬 목록은 인증 사용자용 GET과 고정 무인자 RPC로 실제 code·label을 전달한다", async () => {
  const { send, calls } = setup();
  const response = await send("/reviews/praises");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, catalog);
  assert.deepEqual(calls, [{ name: "get_review_praise_catalog", args: {}, role: "user" }]);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("칭찬 목록은 익명·위조·worker 세션을 사용자 인증으로 인정하지 않는다", async () => {
  const { send, calls } = setup();
  for (const token of ["", "forged", "worker"]) assert.equal((await send("/reviews/praises", "GET", undefined, token)).status, 401);
  assert.equal(calls.length, 0);
});

test("칭찬 목록은 미지원 메서드·query·경로 우회를 RPC 전에 거절한다", async () => {
  const { send, handler, calls } = setup();
  assert.equal((await send("/reviews/praises", "POST", {})).status, 405);
  assert.equal((await send("/reviews/praises", "DELETE")).status, 405);
  for (const query of ["?userId=forged", "?limit=2", "?limit=1&limit=2"]) assert.equal((await send(`/reviews/praises${query}`)).status, 400);
  for (const path of ["/evil/service-api/reviews/praises", "/service-api/reviews/%70raises", "/service-api//reviews/praises", "/service-api/reviews/praises/", "/service-api/reviews/unknown"])
    assert.equal((await handler(new Request(`https://api.example.test${path}`))).status, 404);
  assert.equal(calls.length, 0);
});

test("개인 완료 후 미완료 후기 상태는 배열·snake_case·비공개 상태를 그대로 보존한다", async () => {
  const state = [{ appointment_id: id, appointment_completed: false, deadline_at: null, hold_until: null, disputed: false,
    can_write: true, own_review: null, peer_submitted: false, released: false, release_reason: null, peer_review: null, server_now: "2099-01-01T14:00:00Z" }];
  const { send, calls } = setup(async () => state);
  const response = await send(`/appointments/${id}/reviews`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, state);
  assert.deepEqual(calls, [{ name: "get_appointment_review_state", args: { p_appointment_id: id }, role: "user" }]);
});

test("선제 제출은 기존 5인자 RPC만 사용하며 완료·catalog 조회를 대신 실행하지 않는다", async () => {
  const submission = { reviewId: otherId, submittedAt: "2099-01-01T14:00:00Z", deduplicated: false };
  const { send, calls } = setup(async () => submission);
  const response = await send(`/appointments/${id}/reviews`, "POST", { rating: 5, experience: "positive", comment: "편안하게 이야기했어요", praises: ["punctual", "considerate"] });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, submission);
  assert.deepEqual(calls, [{ name: "submit_appointment_review", role: "user", args: {
    p_appointment_id: id, p_rating: 5, p_experience: "positive", p_comment: "편안하게 이야기했어요", p_praises: ["punctual", "considerate"],
  } }]);
});

test("후기 공개·완료 집계는 completedCount와 실제 빈 결과를 보존한다", async () => {
  const result = { reviews: [], praisesTop5: [], nextCursor: null, completedCount: 2 };
  const { send, calls } = setup(async () => result);
  assert.deepEqual((await (await send(`/profiles/${id}/reviews?limit=5&before=${otherId}`)).json()).data, result);
  assert.deepEqual(calls, [{ name: "get_public_profile_reviews", role: "user", args: { p_profile_id: id, p_limit: 5, p_before: otherId } }]);
});

test("칭찬은 positive 최대3개·중복 금지이며 신원·완료·공개 주입은 거절한다", async () => {
  const { send, calls } = setup();
  const review = { rating: 5, experience: "positive" };
  for (const body of [
    { ...review, praises: ["punctual", "punctual"] }, { ...review, praises: catalog.items.slice(0, 4).map(item => item.code) },
    { ...review, experience: "neutral", praises: ["punctual"] }, { ...review, experience: "negative", praises: ["punctual"] },
    { ...review, reviewerId: id }, { ...review, appointmentCompleted: true }, { ...review, released: true },
  ]) assert.equal((await send(`/appointments/${id}/reviews`, "POST", body)).status, 400);
  assert.equal(calls.length, 0);
});

test("알 수 없는 칭찬 code는 DB 최종검증 오류를 반환하며 가짜 catalog로 대체하지 않는다", async () => {
  const { send, calls } = setup(async () => { throw new HttpError("INVALID_REQUEST"); });
  assert.equal((await send(`/appointments/${id}/reviews`, "POST", { rating: 5, experience: "positive", praises: ["unknown_code"] })).status, 400);
  assert.deepEqual(calls.map(call => call.name), ["submit_appointment_review"]);
});

test("catalog 권한·연결 실패는 역할 재시도나 빈 성공으로 바꾸지 않는다", async () => {
  for (const [code, status] of [["ACCESS_DENIED", 403], ["EXTERNAL_UNAVAILABLE", 503]] as const) {
    const { send, calls } = setup(async () => { throw new HttpError(code); });
    assert.equal((await send("/reviews/praises")).status, status);
    assert.deepEqual(calls.map(call => call.role), ["user"]);
  }
});

const config = { supabaseUrl: "https://project.example.test", supabaseAnonKey: "fixture-anon", allowedOrigins: [], maxRequestBytes: 8192, upstreamTimeoutMs: 1000 };
test("사용자 client는 catalog를 허용하고 후기 worker·내부 매칭 RPC를 거절한다", async () => {
  const token = "header.payload.signature";
  const principal = await requirePrincipal(new Request("https://app.example.test", { headers: { authorization: `Bearer ${token}` } }), config,
    async () => Response.json({ id, role: "authenticated", is_anonymous: false }));
  const urls: string[] = [];
  const db = createUserClient(config, principal, async (url, init) => {
    urls.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    return Response.json(catalog);
  });
  assert.deepEqual(await db.rpc("get_review_praise_catalog", {}), catalog);
  for (const name of ["process_due_review_publications", "process_review_summary_refresh", "expire_match_consents", "complete_reserved_appointment"])
    await assert.rejects(db.rpc(name, {}), error => toPublicError(error).error.code === "ACCESS_DENIED");
  assert.deepEqual(urls, [`${config.supabaseUrl}/rest/v1/rpc/get_review_praise_catalog`]);
});

test("catalog의 기본 런타임 조립은 네이버 설정 없이 Auth 검증·사용자 JWT RPC에 연결한다", async () => {
  const env: Record<string, string> = { SUPABASE_URL: config.supabaseUrl, SUPABASE_ANON_KEY: config.supabaseAnonKey, ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "1000" };
  const previous = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer header.payload.signature");
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ id, role: "authenticated", is_anonymous: false });
    assert.equal(String(url), `${config.supabaseUrl}/rest/v1/rpc/get_review_praise_catalog`);
    assert.equal(init?.body, "{}");
    return Response.json(catalog);
  };
  try {
    const response = await createRuntimeHandler(key => env[key])(new Request("https://api.example.test/functions/v1/service-api/reviews/praises", { headers: { authorization: "Bearer header.payload.signature" } }));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, catalog);
    assert.deepEqual(urls, [`${config.supabaseUrl}/auth/v1/user`, `${config.supabaseUrl}/rest/v1/rpc/get_review_praise_catalog`]);
  } finally { globalThis.fetch = previous; }
});

test("본인 프로필 GET은 기존 전용 RPC만 호출하여 공개 프로필로 대체하지 않는다", async () => {
  const own = { id, avatar_path: `${id}/${otherId}.jpg` };
  const { send, calls } = setup(async () => own);
  assert.deepEqual((await (await send("/me")).json()).data, own);
  assert.deepEqual(calls, [{ name: "get_my_profile", args: {}, role: "user" }]);
});
