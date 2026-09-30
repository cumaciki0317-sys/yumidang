/** 민규담당. 실제 Web Request handler와 서비스·repository 매핑 검증; 외부 DB는 주입한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi, type ServiceApiDependencies } from "../../../backend/supabase/functions/service-api/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
function setup(overrides: Partial<ServiceApiDependencies> = {}) {
  const calls: { name: string; args: Record<string, JsonValue>; role: string }[] = [];
  const auth: string[] = [];
  const client = (role: string) => ({ rpc: async (name: string, args: Record<string, JsonValue>) => { calls.push({ name, args, role }); return name === "process_due_review_publications" ? { publishedCount: 2 } : name === "process_review_summary_refresh" ? { processedCount: 3, enqueuedCount: 1 } : { ok: true }; } });
  const handler = createServiceApi({
    allowedOrigins: ["https://app.example.test"], maxBodyBytes: 8192,
    authenticateUser: async (request) => { auth.push("user"); if (request.headers.get("authorization") !== "Bearer member") throw new HttpError("AUTH_REQUIRED"); return client("user"); },
    authenticateInternal: async (request) => { auth.push("internal"); if (request.headers.get("authorization") !== "Bearer worker") throw new HttpError("ACCESS_DENIED"); return client("internal"); },
    maintenance: { modelVersion: "fixture-model", promptVersion: "fixture-prompt" }, ...overrides,
  });
  const send = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => handler(new Request(`https://api.example.test/functions/v1/service-api${path}`, {
    method, headers: { authorization: "Bearer member", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { handler, send, calls, auth };
}

test("정상 완료 확인은 사용자 클라이언트와 고정 RPC만 호출한다", async () => {
  const { send, calls } = setup();
  const response = await send(`/appointments/${id}/confirm-completion`, "POST", {});
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ name: "confirm_appointment_completion", args: { p_appointment_id: id }, role: "user" }]);
  const body = await response.json();
  assert.deepEqual(body.data, { ok: true });
  assert.equal(body.requestId, response.headers.get("x-request-id"));
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("모든 읽기 경로를 명시 RPC에 연결하며 임의 RPC 경로는 없다", async () => {
  const { send, calls } = setup();
  const paths = [
    ["/me", "get_my_profile"], ["/appointments", "list_my_appointments"], [`/appointments/${id}`, "get_appointment_state"],
    [`/appointments/${id}/reviews`, "get_appointment_review_state"], [`/profiles/${id}/reviews?limit=5&before=${otherId}`, "get_public_profile_reviews"],
    ["/notifications?limit=5", "list_my_notifications"], ["/conversations", "list_conversations"], [`/conversations/${id}`, "get_conversation"],
    [`/conversations/${id}/messages?limit=10`, "list_conversation_messages"], [`/posts/${id}`, "get_service_post"],
    ["/requests/sent", "list_sent_join_requests"], ["/requests/received", "list_received_join_requests"],
  ];
  for (const [path, rpc] of paths) { assert.equal((await send(path)).status, 200, path); assert.equal(calls.at(-1)?.name, rpc); }
  assert.equal((await send("/rpc/confirm_match", "POST", {})).status, 404);
});

test("미인증 요청은 입력과 DB 실행 전에 차단한다", async () => {
  const { send, calls } = setup();
  assert.equal((await send(`/appointments/${id}/confirm-completion`, "POST", { actorId: id }, { authorization: "Bearer forged" })).status, 401);
  assert.equal(calls.length, 0);
});

test("내부 worker를 사용자 JWT 대신 쓰거나 사용자 JWT로 내부 기능 호출 불가", async () => {
  const { send, calls, auth } = setup();
  assert.equal((await send("/internal/maintenance", "POST", { limit: 2 })).status, 403);
  assert.equal((await send("/me", "GET", undefined, { authorization: "Bearer worker" })).status, 401);
  assert.deepEqual(auth, ["internal", "user"]);
  assert.equal(calls.length, 0);
});

test("maintenance는 공개 후 명시된 버전으로 요약을 예약하며 자동 완료를 호출하지 않는다", async () => {
  const { send, calls } = setup();
  const response = await send("/internal/maintenance", "POST", { limit: 3 }, { authorization: "Bearer worker" });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    { name: "process_due_review_publications", args: { p_limit: 3 }, role: "internal" },
    { name: "process_review_summary_refresh", args: { p_limit: 3, p_model_version: "fixture-model", p_prompt_version: "fixture-prompt" }, role: "internal" },
  ]);
  assert.deepEqual((await response.json()).data, {
    status: "ok", completion: { status: "managed_by_reservation" },
    reviews: { status: "published", publishedCount: 2 },
    summary: { status: "queued", processedCount: 3, enqueuedCount: 1 },
  });
});

test("요약 설정 누락·빈 값·잘못된 값은 공개를 실행한 뒤 별도 상태이며 outbox 처리를 호출하지 않는다", async () => {
  for (const [maintenance, expected] of [
    [undefined, "pending_configuration"],
    [{ modelVersion: "valid" }, "pending_configuration"],
    [{ modelVersion: "", promptVersion: "valid" }, "configuration_error"],
    [{ modelVersion: "unsafe version", promptVersion: "valid" }, "configuration_error"],
    [{ modelVersion: "valid", promptVersion: "bad\nvalue" }, "configuration_error"],
  ] as const) {
    const { send, calls } = setup({ maintenance });
    const response = await send("/internal/maintenance", "POST", { limit: 1 }, { authorization: "Bearer worker" });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, {
      status: "partial", completion: { status: "managed_by_reservation" },
      reviews: { status: "published", publishedCount: 2 }, summary: { status: expected },
    });
    assert.deepEqual(calls.map((call) => call.name), ["process_due_review_publications"]);
  }
});

test("maintenance 본문 주입·잘못된 작업 한도는 공개 쓰기 전에 차단한다", async () => {
  const { send, calls } = setup();
  for (const body of [{}, { limit: 0 }, { limit: 101 }, { limit: 1, modelVersion: "attacker" }, { limit: "1" }]) {
    assert.equal((await send("/internal/maintenance", "POST", body, { authorization: "Bearer worker" })).status, 400);
  }
  assert.equal(calls.length, 0);
});

test("공개 실패는 요약을 실행하지 않고 실제 오류로 반환한다", async () => {
  for (const result of ["throw", "malformed"]) {
    const calls: string[] = [];
    const { send } = setup({ authenticateInternal: async () => ({ rpc: async (name) => {
      calls.push(name);
      if (result === "throw") throw new HttpError("EXTERNAL_UNAVAILABLE");
      return { publishedCount: -1, privateDetail: "never-echo" };
    } }) });
    const response = await send("/internal/maintenance", "POST", { limit: 2 }, { authorization: "Bearer worker" });
    assert.equal(response.status, 503);
    assert.deepEqual(calls, ["process_due_review_publications"]);
    assert.ok(!(await response.text()).includes("never-echo"));
  }
});

test("공개 후 요약 실패·비정상 응답은 공개 결과와 정형 partial 오류로 구분한다", async () => {
  for (const kind of ["timeout", "malformed", "unknown"]) {
    const calls: string[] = [];
    const { send } = setup({ authenticateInternal: async () => ({ rpc: async (name) => {
      calls.push(name);
      if (name === "process_due_review_publications") return { publishedCount: 1, secret: "never-echo" };
      if (kind === "timeout") throw new HttpError("EXTERNAL_UNAVAILABLE");
      if (kind === "unknown") throw new Error("never-echo");
      return { processedCount: 2, enqueuedCount: "2", secret: "never-echo" };
    } }) });
    const response = await send("/internal/maintenance", "POST", { limit: 2 }, { authorization: "Bearer worker" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, {
      status: "partial", completion: { status: "managed_by_reservation" },
      reviews: { status: "published", publishedCount: 1 },
      summary: { status: "failed", code: kind === "unknown" ? "INTERNAL_ERROR" : "EXTERNAL_UNAVAILABLE", retryable: kind !== "unknown" },
    });
    assert.equal(calls.length, 2);
    assert.ok(!JSON.stringify(body).includes("never-echo"));
  }
});

test("사용자·상태·개인정보 필드 주입과 비객체 본문을 거절한다", async () => {
  const { send, calls } = setup();
  for (const body of [{ userId: id }, { status: "completed" }, null, [], true]) {
    assert.equal((await send(`/appointments/${id}/confirm-completion`, "POST", body)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test("엄격한 UUID·중복 query·알 수 없는 query·커서·한도를 검증한다", async () => {
  const { send, calls } = setup();
  for (const path of ["/appointments/not-a-uuid", "/notifications?limit=0", "/notifications?limit=101", "/notifications?limit=2&limit=3", "/notifications?before=secret", "/me?userId=x", "/notifications?limit=1e1"]) {
    assert.equal((await send(path)).status, 400, path);
  }
  assert.equal(calls.length, 0);
});

test("다른 prefix·suffix·인코딩 경로·미지원 메서드를 거절한다", async () => {
  const { handler, send, calls } = setup();
  for (const path of ["/evil/functions/v1/service-api/me", "/functions/v1/service-api-evil/me", "/functions/v1/service-api//me", "/functions/v1/service-api/%6de"]) {
    assert.equal((await handler(new Request(`https://api.example.test${path}`))).status, 404, path);
  }
  assert.equal((await send("/me", "DELETE")).status, 405);
  assert.equal((await send("/signup", "POST", { name: "arbitrary" })).status, 404);
  assert.equal(calls.length, 0);
});

test("정확한 origin만 CORS 허용하고 거절된 출처에서는 DB를 호출하지 않는다", async () => {
  const { send, calls } = setup();
  const accepted = await send("/me", "GET", undefined, { origin: "https://app.example.test" });
  assert.equal(accepted.headers.get("access-control-allow-origin"), "https://app.example.test");
  const denied = await send("/me", "GET", undefined, { origin: "https://app.example.test.evil" });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  assert.equal(calls.length, 1);
});

test("preflight는 인증 없이 통과하되 요청 헤더를 제한한다", async () => {
  const { send, auth } = setup();
  const response = await send("/me", "OPTIONS", undefined, { origin: "https://app.example.test", "access-control-request-method": "GET", "access-control-request-headers": "authorization, apikey" });
  assert.equal(response.status, 204);
  assert.equal(auth.length, 0);
});

test("본문 바이트 제한·미디어 종류·비정상 JSON을 처리한다", async () => {
  const { send, handler, calls } = setup({ maxBodyBytes: 5 });
  assert.equal((await send(`/appointments/${id}/confirm-completion`, "POST", { large: "body" })).status, 413);
  assert.equal((await send(`/appointments/${id}/confirm-completion`, "POST", {}, { "content-type": "text/plain" })).status, 415);
  assert.equal((await handler(new Request(`https://api.example.test/service-api/appointments/${id}/confirm-completion`, { method: "POST", headers: { authorization: "Bearer member", "content-type": "application/json" }, body: "{" }))).status, 400);
  assert.equal(calls.length, 0);
});

test("DB 오류 원문·토큰·SQL을 응답에 넣지 않는다", async () => {
  const { send } = setup({ authenticateUser: async () => ({ rpc: async () => { throw new Error("SELECT private.phone; Bearer secret; 후기원문"); } }) });
  const response = await send("/me");
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /SELECT|secret|후기원문/);
});

test("후기 제출은 별점·경험·한마디를 새 5인자 RPC에 전달한다", async () => {
  const { send, calls } = setup();
  assert.equal((await send(`/appointments/${id}/reviews`, "POST", { rating: 5, experience: "positive", comment: "편안했어요" })).status, 200);
  assert.deepEqual(calls[0].args, { p_appointment_id: id, p_rating: 5, p_experience: "positive", p_comment: "편안했어요", p_praises: [] });
  for (const body of [{ rating: 6, experience: "positive" }, { rating: 5, experience: "neutral", praises: ["친절"] }, { rating: 5, experience: "positive", reviewerId: otherId }]) {
    assert.equal((await send(`/appointments/${id}/reviews`, "POST", body)).status, 400);
  }
  assert.equal(calls.length, 1);
});

test("채팅 재시도 ID를 유지하고 sender와 createdAt 주입을 거절한다", async () => {
  const { send, calls } = setup();
  assert.equal((await send(`/conversations/${id}/messages`, "POST", { messageId: otherId, content: "반가워요" })).status, 200);
  assert.deepEqual(calls[0].args, { p_request_id: id, p_message_id: otherId, p_content: "반가워요" });
  assert.equal((await send(`/conversations/${id}/messages`, "POST", { messageId: otherId, content: "반가워요", senderId: id })).status, 400);
});

test("제안과 조건 버전 수락은 다른 RPC이며 직접 확정 경로는 없다", async () => {
  const { send, calls } = setup();
  assert.equal((await send(`/requests/${id}/propose`, "POST", {})).status, 200);
  assert.equal((await send(`/requests/${id}/accept`, "POST", { conditionVersion: "condition-revision" })).status, 200);
  assert.equal((await send(`/requests/${id}/accept`, "POST", {})).status, 400);
  assert.equal((await send(`/requests/${id}/confirm`, "POST", {})).status, 404);
  assert.deepEqual(calls.map((call) => call.name), ["propose_match", "accept_match"]);
});

const freePost = {
  postId: id, title: "무료 전시 동행", description: "함께 전시를 봐요", category: "전시", startsAt: "2099-01-01T10:00:00+09:00", endsAt: "2099-01-01T12:00:00+09:00", recruitmentEndsAt: "2099-01-01T09:00:00+09:00",
  publicArea: "서울특별시 성동구 성수동", registeredAddress: "가상 주소", meetingDetail: "가상 상세", costType: "free", amount: 0,
};
test("무료 공고는 주소·상세를 구분해 보내고 DB가 author를 결정한다", async () => {
  const { send, calls } = setup();
  assert.equal((await send("/posts", "POST", freePost)).status, 200);
  assert.equal(calls[0].name, "create_service_post");
  const input = calls[0].args.p_input as Record<string, JsonValue>;
  assert.equal(input.registeredAddress, "가상 주소");
  assert.equal(input.meetingDetail, "가상 상세");
  assert.equal(Object.hasOwn(input, "authorId"), false);
  assert.deepEqual(input.tags, []);
  assert.equal((await send("/posts", "POST", { ...freePost, authorId: otherId })).status, 400);
});

test("유료 공급사 미연결·잘못된 일정·비용을 가짜 성공으로 처리하지 않는다", async () => {
  const { send, calls } = setup();
  assert.equal((await send("/posts", "POST", { ...freePost, costType: "paid_request", amount: 10000 })).status, 503);
  assert.equal((await send("/posts", "POST", { ...freePost, amount: 1 })).status, 400);
  assert.equal((await send("/posts", "POST", { ...freePost, endsAt: freePost.startsAt })).status, 400);
  assert.equal(calls.length, 0);
});

test("신청·철회·거절·알림 확인 경로는 의도한 RPC에만 연결한다", async () => {
  const { send, calls } = setup();
  for (const [path, body, rpc] of [
    [`/posts/${id}/requests`, { message: "함께 전시를 보러 가고 싶어요" }, "request_service_post"],
    [`/requests/${id}/withdraw`, {}, "withdraw_join_request"], [`/requests/${id}/decline`, {}, "decline_join_request"],
    [`/notifications/${id}/read`, {}, "mark_my_notification_read"], ["/notifications/read-all", {}, "mark_all_my_notifications_read"],
  ] as const) { assert.equal((await send(path, "POST", body)).status, 200); assert.equal(calls.at(-1)?.name, rpc); }
});


test("신청자는 동의 버전 조회 후 수락하며 사진 변경은 소유 객체 경로만 받는다", async () => {
  const { send, calls } = setup();
  assert.equal((await send(`/requests/${id}/consent`)).status, 200);
  assert.equal(calls[0].name, "get_match_consent");
  assert.equal((await send("/me/avatar", "POST", { avatarPath: `${id}/${otherId}.jpg` })).status, 200);
  assert.equal(calls[1].name, "set_my_profile_avatar");
  assert.equal((await send("/me/avatar", "POST", { avatarPath: "https://evil.example/avatar.jpg" })).status, 400);
  assert.equal((await send("/me/avatar", "POST", { avatarPath: `${id}/${otherId}.jpg`, realName: "변경" })).status, 400);
});

test("공고 주소·상세와 신청 메시지 길이는 DB 계약 경계를 지킨다", async () => {
  const { send, calls } = setup();
  assert.equal((await send("/posts", "POST", { ...freePost, registeredAddress: "가".repeat(301) })).status, 400);
  assert.equal((await send("/posts", "POST", { ...freePost, meetingDetail: "가".repeat(201) })).status, 400);
  assert.equal((await send("/posts", "POST", { ...freePost, meetingDetail: "가" })).status, 400);
  assert.equal((await send(`/posts/${id}/requests`, "POST", { message: "가".repeat(9) })).status, 400);
  assert.equal((await send(`/posts/${id}/requests`, "POST", { message: "가".repeat(301) })).status, 400);
  assert.equal(calls.length, 0);
});


test("진입점 import는 Deno 환경 조회·서버 시작 없이 factory와 fetch를 제공한다", async () => {
  // Node에는 Deno 전역이 없으므로 eager 환경 접근·serve 등록이 있으면 import가 실패한다.
  const entry = await import("../../../backend/supabase/functions/service-api/index.ts");
  assert.equal(typeof entry.createRuntimeHandler, "function");
  assert.equal(typeof entry.default.fetch, "function");
  assert.equal(Object.keys(entry.default).join(","), "fetch");
});

test("실제 런타임 조립도 빈 요약 환경을 보존하고 내부 공개 RPC만 실행한다", async () => {
  const { createRuntimeHandler } = await import("../../../backend/supabase/functions/service-api/index.ts");
  const secret = "fixture_internal_" + "a".repeat(32);
  const environment: Record<string, string> = {
    SUPABASE_URL: "https://project.example.test", SUPABASE_ANON_KEY: "public-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", INTERNAL_WORKER_SECRET: secret,
    ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "1000",
    REVIEW_SUMMARY_MODEL_VERSION: "", REVIEW_SUMMARY_PROMPT_VERSION: "review-summary-v1",
  };
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-service");
    return Response.json({ publishedCount: 1 });
  };
  try {
    const handler = createRuntimeHandler((key) => environment[key]);
    const response = await handler(new Request("https://api.example.test/functions/v1/service-api/internal/maintenance", {
      method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ limit: 1 }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.status, "partial");
    assert.deepEqual(body.data.summary, { status: "configuration_error" });
    assert.deepEqual(body.data.reviews, { status: "published", publishedCount: 1 });
    assert.deepEqual(calls, ["https://project.example.test/rest/v1/rpc/process_due_review_publications"]);
  } finally { globalThis.fetch = previous; }
});
