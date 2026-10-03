/** 민규담당. 매칭 생명주기의 HTTP 경계·Auth 조립·고정 RPC 검사. 실제 SQL 검사는 별도다. */
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
const version = "server-condition-version";
const input = {
  title: "무료 전시 동행", description: "함께 전시를 봐요", category: "전시",
  startsAt: "2099-01-01T10:00:00+09:00", endsAt: "2099-01-01T12:00:00+09:00",
  publicArea: "서울특별시 성동구 성수동", registeredAddress: "가상 등록 주소", meetingDetail: "가상 만남 안내", costType: "free", amount: 0,
};
const updatedAt = "2098-12-01T00:00:00.123456Z";
type Call = { name: string; args: Record<string, JsonValue>; role: string };
function setup(reply: (name: string) => Promise<JsonValue> = async () => ({ ok: true })) {
  const calls: Call[] = [];
  const client = (role: string) => ({ rpc: async (name: string, args: Record<string, JsonValue>) => { calls.push({ name, args, role }); return reply(name); } });
  const handler = createServiceApi({
    allowedOrigins: ["https://app.example.test"], maxBodyBytes: 8192,
    authenticateUser: async (request) => { if (request.headers.get("authorization") !== "Bearer member") throw new HttpError("AUTH_REQUIRED"); return client("user"); },
    authenticateInternal: async (request) => { if (request.headers.get("authorization") !== "Bearer worker") throw new HttpError("ACCESS_DENIED"); return client("internal"); },
  });
  const send = (path: string, body?: unknown, method = "POST", token = "member") => handler(new Request(`https://api.example.test/service-api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { calls, send, handler };
}

test("공고 생성과 수정의 모집 마감 생략은 시작 시각으로 채우며 수정 ID는 경로에서만 받는다", async () => {
  const { send, calls } = setup();
  assert.equal((await send("/posts", { postId: id, ...input })).status, 200);
  assert.equal((await send(`/posts/${id}/update`, { ...input, expectedUpdatedAt: updatedAt })).status, 200);
  assert.deepEqual(calls.map(c => c.name), ["create_service_post", "update_service_post"]);
  const normalized = { ...input, recruitmentEndsAt: input.startsAt, registeredPlaceName: null, preferenceNote: null, tags: [] };
  assert.deepEqual(calls[0].args, { p_post_id: id, p_input: normalized });
  assert.deepEqual(calls[1], { name: "update_service_post", args: { p_post_id: id, p_input: normalized, p_expected_updated_at: updatedAt }, role: "user" });
});

test("수정의 명시 모집 마감은 보존하며 오랜 조회 버전을 자동 교체하지 않는다", async () => {
  const { send, calls } = setup();
  const deadline = "2099-01-01T09:00:00+09:00";
  assert.equal((await send(`/posts/${id}/update`, { ...input, recruitmentEndsAt: deadline, expectedUpdatedAt: updatedAt })).status, 200);
  assert.equal((calls[0].args.p_input as Record<string, JsonValue>).recruitmentEndsAt, deadline);
  assert.equal(calls[0].args.p_expected_updated_at, updatedAt);
});

test("수정은 필수 전체 입력·유효 조회 시각을 요구하고 회원·상태·ID 주입을 거절한다", async () => {
  const { send, calls } = setup();
  for (const body of [
    { ...input }, { title: input.title, expectedUpdatedAt: updatedAt },
    { ...input, expectedUpdatedAt: "2098-12-01" }, { ...input, expectedUpdatedAt: null },
    ...["postId", "authorId", "userId", "status", "conditionVersion"].map(key => ({ ...input, expectedUpdatedAt: updatedAt, [key]: otherId })),
  ]) assert.equal((await send(`/posts/${id}/update`, body)).status, 400);
  assert.equal(calls.length, 0);
});

test("생성·수정은 명시 null 마감·잘못된 달력·역전·시작 이후 모집 마감을 거절한다", async () => {
  const { send, calls } = setup();
  for (const patch of [
    { recruitmentEndsAt: null }, { recruitmentEndsAt: "2099-01-01T11:00:00+09:00" },
    { startsAt: "2099-02-30T10:00:00Z", endsAt: "2099-03-02T12:00:00Z" },
    { endsAt: input.startsAt }, { startsAt: "2099-01-01T10:00:00" },
  ]) {
    assert.equal((await send("/posts", { postId: id, ...input, ...patch })).status, 400);
    assert.equal((await send(`/posts/${id}/update`, { ...input, expectedUpdatedAt: updatedAt, ...patch })).status, 400);
  }
  assert.equal(calls.length, 0);
});

test("수정은 기존 무료 전용·주소/상세 분리와 문자열 한도를 동일하게 적용한다", async () => {
  const { send, calls } = setup();
  for (const [patch, status] of [
    [{ costType: "paid_offer", amount: 10000 }, 503], [{ amount: 1 }, 400],
    [{ registeredAddress: "가".repeat(301) }, 400], [{ meetingDetail: "가".repeat(201) }, 400],
    [{ title: " 공고 제목" }, 400], [{ tags: ["전시", "전시"] }, 400],
  ] as const) assert.equal((await send(`/posts/${id}/update`, { ...input, expectedUpdatedAt: updatedAt, ...patch })).status, status);
  assert.equal(calls.length, 0);
});

test("마감·삭제는 빈 본문과 경로 ID를 각각의 고정 RPC에 연결한다", async () => {
  const { send, calls } = setup();
  for (const action of ["close", "delete"]) {
    assert.equal((await send(`/posts/${id}/${action}`, {})).status, 200);
    assert.equal((await send(`/posts/${id}/${action}`, { force: true })).status, 400);
    assert.equal((await send(`/posts/${id}/${action}`, null)).status, 400);
  }
  assert.deepEqual(calls, [
    { name: "close_service_post", args: { p_post_id: id }, role: "user" },
    { name: "delete_service_post", args: { p_post_id: id }, role: "user" },
  ]);
});

test("동의 철회·거절은 신청 철회·거절과 별개 RPC이며 대상 조건 버전을 보존한다", async () => {
  const { send, calls } = setup();
  for (const action of ["withdraw", "decline"]) {
    assert.equal((await send(`/requests/${id}/consent/${action}`, { conditionVersion: version })).status, 200);
    assert.equal((await send(`/requests/${id}/${action}`, {})).status, 200);
  }
  assert.deepEqual(calls.map(c => [c.name, c.args]), [
    ["withdraw_match_consent", { p_request_id: id, p_condition_version: version }], ["withdraw_join_request", { p_request_id: id }],
    ["decline_match_consent", { p_request_id: id, p_condition_version: version }], ["decline_join_request", { p_request_id: id }],
  ]);
});

test("동의 종료는 누락·잘못된 버전·신원·요청 시각 주입을 DB 전에 차단한다", async () => {
  const { send, calls } = setup();
  for (const action of ["withdraw", "decline"]) for (const body of [
    {}, { conditionVersion: null }, { conditionVersion: " " }, { conditionVersion: "v".repeat(201) },
    { conditionVersion: version, actorId: id }, { conditionVersion: version, expiresAt: input.startsAt },
  ]) assert.equal((await send(`/requests/${id}/consent/${action}`, body)).status, 400);
  assert.equal(calls.length, 0);
});

test("새 경로의 메서드·UUID·인코딩·query 경계를 검사한다", async () => {
  const { send, calls, handler } = setup();
  for (const path of [`/posts/${id}/update`, `/posts/${id}/close`, `/posts/${id}/delete`, `/requests/${id}/consent/withdraw`, `/requests/${id}/consent/decline`]) {
    assert.equal((await send(path, undefined, "GET")).status, 405);
    assert.equal((await send(path, {}, "DELETE")).status, 405);
    assert.equal((await send(`${path}?force=true`, {})).status, 400);
    assert.equal((await send(`${path}?version=a&version=b`, {})).status, 400);
  }
  assert.equal((await send("/posts/not-uuid/update", {})).status, 400);
  assert.equal((await send(`/requests/${id}/consent/accept`, {})).status, 404);
  assert.equal((await handler(new Request(`https://api.example.test/evil/service-api/posts/${id}/close`, { method: "POST" }))).status, 404);
  assert.equal((await send(`/posts/${id}/%63lose`, {})).status, 404);
  assert.equal(calls.length, 0);
});

test("권한 실패·조건 충돌은 사용자 클라이언트를 내부 역할로 재시도하지 않는다", async () => {
  for (const [code, status] of [["ACCESS_DENIED", 403], ["STATE_CONFLICT", 409], ["RESOURCE_NOT_FOUND", 404]] as const) {
    const { send, calls } = setup(async () => { throw new HttpError(code); });
    assert.equal((await send(`/posts/${id}/close`, {})).status, status);
    assert.deepEqual(calls.map(c => c.role), ["user"]);
  }
  const { send, calls } = setup();
  assert.equal((await send(`/requests/${id}/consent/withdraw`, { conditionVersion: version }, "POST", "worker")).status, 401);
  assert.equal(calls.length, 0);
});

test("동의 조회는 종료·구형·없는 요청을 가짜 대기 상태로 바꾸지 않는다", async () => {
  for (const result of [
    { consent: null }, { requestId: id, conditionVersion: version, status: "expired", expiresAt: input.startsAt, requestedAt: updatedAt, conditions: {} },
    { requestId: id, conditionVersion: version, status: "renewal_required", expiresAt: null, requestedAt: updatedAt, conditions: {} },
  ]) {
    const { send } = setup(async () => result);
    const response = await send(`/requests/${id}/consent`, undefined, "GET");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, result);
  }
});

test("maintenance는 모델 설정 없이 만료·공개를 처리하고 만료 응답의 민감 필드를 버린다", async () => {
  const { send, calls } = setup(async name => name === "expire_match_consents" || name === "expire_appointment_changes" ? { expiredCount: 2, secret: "never-echo" } : { publishedCount: 1 });
  const response = await send("/internal/maintenance", { limit: 4 }, "POST", "worker");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {
    status: "partial", completion: { status: "managed_by_reservation" }, consent: { status: "expired", expiredCount: 2 }, scheduleChange: { status: "expired", expiredCount: 2 },
    reviews: { status: "published", publishedCount: 1 }, summary: { status: "pending_configuration" },
  });
  assert.deepEqual(calls.map(c => [c.name, c.args, c.role]), [["expire_match_consents", { p_limit: 4 }, "internal"], ["expire_appointment_changes", { p_limit: 4 }, "internal"], ["process_due_review_publications", { p_limit: 4 }, "internal"]]);
});

test("maintenance 만료 오류·비정상 건수는 공개·요약을 실행하지 않는다", async () => {
  for (const result of [null, { expiredCount: -1 }, { expiredCount: "0" }, { expiredCount: 1.5 }, { expiredCount: Number.MAX_SAFE_INTEGER + 1 }]) {
    const { send, calls } = setup(async () => result);
    assert.equal((await send("/internal/maintenance", { limit: 1 }, "POST", "worker")).status, 503);
    assert.deepEqual(calls.map(c => c.name), ["expire_match_consents"]);
  }
});

const config = { supabaseUrl: "https://project.example.test", supabaseAnonKey: "fixture-anon", allowedOrigins: [], maxRequestBytes: 8192, upstreamTimeoutMs: 1000 };
test("사용자 RPC 허용 목록은 새 생명주기만 추가하며 내부 만료·Auth 계정 RPC는 금지한다", async () => {
  const token = "header.payload.signature";
  const principal = await requirePrincipal(new Request("https://app.example.test", { headers: { authorization: `Bearer ${token}` } }), config,
    async () => Response.json({ id, role: "authenticated", is_anonymous: false }));
  const calls: string[] = [];
  const db = createUserClient(config, principal, async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    assert.equal(new Headers(init?.headers).get("apikey"), config.supabaseAnonKey);
    calls.push(String(url)); return Response.json({ ok: true });
  });
  for (const rpc of ["update_service_post", "close_service_post", "delete_service_post", "withdraw_match_consent", "decline_match_consent", "get_my_profile_traits", "list_event_candidates_v1"])
    await db.rpc(rpc, {});
  for (const rpc of ["expire_match_consents", "resolve_naver_account", "record_naver_session", "confirm_match", "attacker_function"])
    await assert.rejects(db.rpc(rpc, {}), error => error instanceof HttpError && toPublicError(error).error.code === "ACCESS_DENIED");
  assert.equal(calls.length, 7);
});

test("실제 런타임은 네이버 앱 설정 없이 검증된 Auth 사용자와 같은 토큰으로 수정 RPC에 연결한다", async () => {
  const env: Record<string, string> = { SUPABASE_URL: config.supabaseUrl, SUPABASE_ANON_KEY: config.supabaseAnonKey, ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "1000" };
  const previous = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer header.payload.signature");
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ id, role: "authenticated", is_anonymous: false });
    assert.equal(String(url), `${config.supabaseUrl}/rest/v1/rpc/update_service_post`);
    assert.equal(JSON.parse(String(init?.body)).p_post_id, id);
    return Response.json({ postId: id, status: "recruiting", updatedAt });
  };
  try {
    const response = await createRuntimeHandler(key => env[key])(new Request(`https://api.example.test/service-api/posts/${id}/update`, {
      method: "POST", headers: { authorization: "Bearer header.payload.signature", "content-type": "application/json" }, body: JSON.stringify({ ...input, expectedUpdatedAt: updatedAt }),
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(urls, [`${config.supabaseUrl}/auth/v1/user`, `${config.supabaseUrl}/rest/v1/rpc/update_service_post`]);
  } finally { globalThis.fetch = previous; }
});
