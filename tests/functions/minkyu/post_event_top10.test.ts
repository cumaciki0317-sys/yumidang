/** 민규: eventId의 생략/해제 계약과 내부 전용 Top10 HTTP/RPC 연결. 네트워크와 DB는 주입 모형이다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { requireInternalCaller } from "../../../backend/supabase/functions/_shared/auth/internal-caller.ts";
import { requirePrincipal } from "../../../backend/supabase/functions/_shared/auth/principal.ts";
import { createInternalClient } from "../../../backend/supabase/functions/_shared/db/internal-client.ts";
import { createPublicClient } from "../../../backend/supabase/functions/_shared/db/public-client.ts";
import { createUserClient } from "../../../backend/supabase/functions/_shared/db/user-client.ts";
import { HttpError, toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { RuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
import type { RpcClient } from "../../../backend/supabase/functions/_shared/db/transport.ts";

const POST = "11111111-1111-4111-8111-111111111111", EVENT = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "https://app.example.test", API = "https://local-fixture.example.invalid";
const secret = "synthetic_worker_" + "b".repeat(32);
const config: RuntimeConfig = { supabaseUrl: API, supabaseAnonKey: "synthetic-anon", supabaseServiceRoleKey: "synthetic-service",
  internalWorkerSecret: secret, allowedOrigins: [ORIGIN], maxRequestBytes: 8192, upstreamTimeoutMs: 1000 };
const input = { postId: POST, title: "합성 행사 동행", description: "로컬 단위 검증", category: "공연",
  startsAt: "2099-01-01T10:00:00Z", endsAt: "2099-01-01T12:00:00Z", publicArea: "서울특별시 강남구 역삼동",
  registeredAddress: "합성 등록 주소", meetingDetail: "합성 입구", costType: "free", amount: 0 };
const expectedUpdatedAt = "2098-12-31T12:00:00.123456Z";
const snapshot = { mode: "all", requestedPeriod: { start: "2026-10-01", end: "2026-10-02" }, collectedAt: "2026-10-02T12:00:00Z",
  items: [{ rank: 1, sourceId: "SYNTHETIC-KOPIS-1", title: "합성 공연", genre: "뮤지컬", performancePeriodText: "2026.10.01 ~ 2026.10.02", placeName: "합성 공연장", region: "서울" }] };
function setup(result: JsonValue = { ok: true }, rpc?: RpcClient["rpc"]) {
  const calls: { name: string; args: Record<string, JsonValue>; role: string }[] = [];
  const auth: string[] = [];
  const client = (role: string): RpcClient => ({ async rpc(name, args) { calls.push({ name, args, role }); return rpc ? rpc(name, args) : result; } });
  const handler = createServiceApi({ allowedOrigins: [ORIGIN], maxBodyBytes: 8192,
    authenticateUser: async request => {
      auth.push("user"); if (request.headers.get("authorization") !== "Bearer member") throw new HttpError("AUTH_REQUIRED");
      return client("member");
    },
    authenticateInternal: async request => { auth.push("internal"); await requireInternalCaller(request, config); return client("internal"); },
    publicPostDetails: { authenticate: async () => { auth.push("public_detail"); return { db: client("anonymous"), caller: "anonymous" }; } },
  });
  const send = (path: string, method = "GET", body?: unknown, token: string | null = "member", prefix = "/functions/v1/service-api") =>
    handler(new Request(API + prefix + path, { method, headers: { Origin: ORIGIN,
      ...(token === null ? {} : { Authorization: "Bearer " + token }), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { handler, send, calls, auth };
}

test("행사 연결 공고 생성은 eventId 생략·UUID·null을 구분해 고정 RPC에 전달한다", async () => {
  for (const eventFields of [{}, { eventId: EVENT }, { eventId: null }]) {
    const h = setup(); const response = await h.send("/posts", "POST", { ...input, ...eventFields });
    assert.equal(response.status, 200);
    assert.equal(h.calls[0].name, "create_service_post"); assert.equal(h.calls[0].args.p_post_id, POST);
    const mapped = h.calls[0].args.p_input as Record<string, JsonValue>;
    assert.equal(Object.hasOwn(mapped, "eventId"), Object.hasOwn(eventFields, "eventId"));
    if (Object.hasOwn(eventFields, "eventId")) assert.equal(mapped.eventId, eventFields.eventId);
    assert.equal(mapped.startsAt, input.startsAt); assert.equal(mapped.registeredAddress, input.registeredAddress);
    assert.equal(mapped.recruitmentEndsAt, input.startsAt); assert.equal(Object.hasOwn(mapped, "authorId"), false);
  }
});

test("행사 연결 수정은 생략 보존·명시 해제를 유지하며 기존 optimistic 시각을 그대로 전달한다", async () => {
  const { postId: _, ...fields } = input;
  for (const eventFields of [{}, { eventId: EVENT }, { eventId: null }]) {
    const h = setup(); assert.equal((await h.send(`/posts/${POST}/update`, "POST", { ...fields, expectedUpdatedAt, ...eventFields })).status, 200);
    assert.equal(h.calls[0].name, "update_service_post"); assert.equal(h.calls[0].args.p_expected_updated_at, expectedUpdatedAt);
    const mapped = h.calls[0].args.p_input as Record<string, JsonValue>;
    assert.equal(Object.hasOwn(mapped, "eventId"), Object.hasOwn(eventFields, "eventId"));
    if (Object.hasOwn(eventFields, "eventId")) assert.equal(mapped.eventId, eventFields.eventId);
    assert.equal(mapped.endsAt, fields.endsAt); assert.equal(mapped.meetingDetail, fields.meetingDetail);
  }
});

test("eventId 형식·공고 주입 키 오류는 DB 호출 전에 거절한다", async () => {
  for (const invalid of ["", "not-a-uuid", EVENT + " ", 1, true, [], {}, { id: EVENT }]) {
    for (const update of [false, true]) {
      const h = setup(); const { postId: _, ...fields } = input;
      const response = await h.send(update ? `/posts/${POST}/update` : "/posts", "POST",
        update ? { ...fields, expectedUpdatedAt, eventId: invalid } : { ...input, eventId: invalid });
      assert.equal(response.status, 400); assert.equal(h.calls.length, 0);
    }
  }
  for (const injected of [{ source_event_id: EVENT }, { linkedEvent: snapshot }, { authorId: POST }]) {
    const h = setup(); assert.equal((await h.send("/posts", "POST", { ...input, ...injected })).status, 400); assert.equal(h.calls.length, 0);
  }
});

test("공개 상세는 DB가 만든 linkedEvent를 그대로 제공하며 별도 비공개 주소를 생성하지 않는다", async () => {
  const detail = { postId: POST, eventId: EVENT, linkedEvent: { id: EVENT, title: "합성 최신 행사", sourceStatus: "cancelled", publicAddress: "공급사 공개 장소" }, authorDisplayName: "동행-합성별칭" };
  const h = setup(detail); const response = await h.send(`/posts/${POST}`, "GET", undefined, null);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, detail);
  assert.deepEqual(h.calls, [{ name: "get_service_post", args: { p_post_id: POST }, role: "anonymous" }]);
  assert.deepEqual(h.auth, ["public_detail"]); assert.equal(response.headers.get("cache-control"), "no-store");
});

test("Top10 두 고정 내부 경로는 exact args와 원형 SQL 수집 기간 표식을 유지한다", async () => {
  for (const prefix of ["/service-api", "/functions/v1/service-api"]) {
    const stored = setup({ status: "saved", itemCount: 1, deduplicated: false });
    assert.equal((await stored.send("/internal/events/kopis-top10", "POST", { snapshot }, secret, prefix)).status, 200);
    assert.deepEqual(stored.calls, [{ name: "store_kopis_top10_snapshot", args: { p_snapshot: snapshot }, role: "internal" }]);
    for (const mode of ["all", "musical"]) {
      const value = { status: "available", mode, source: "kopis", requestedPeriod: snapshot.requestedPeriod,
        responsePeriod: null, periodVerification: "requested_only", collectedAt: snapshot.collectedAt, items: snapshot.items };
      const h = setup(value); const response = await h.send(`/internal/events/kopis-top10/${mode}`, "GET", undefined, secret, prefix);
      assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, value);
      assert.deepEqual(h.calls, [{ name: "get_kopis_top10_snapshot", args: { p_mode: mode }, role: "internal" }]);
      assert.deepEqual(h.auth, ["internal"]); assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
});

test("Top10은 일반 JWT·익명·서비스키를 내부 secret 대신 받지 않고 path/method/body/query를 제한한다", async () => {
  for (const token of [null, "member", config.supabaseAnonKey, config.supabaseServiceRoleKey!]) {
    for (const [path, method, body] of [["/internal/events/kopis-top10", "POST", { snapshot }], ["/internal/events/kopis-top10/all", "GET", undefined]] as const) {
      const h = setup(); assert.equal((await h.send(path, method, body, token)).status, token === null ? 401 : 403);
      assert.equal(h.calls.length, 0); assert.deepEqual(h.auth, ["internal"]);
    }
  }
  for (const [path, method, body, status] of [
    ["/internal/events/kopis-top10", "GET", undefined, 405], ["/internal/events/kopis-top10/all", "POST", {}, 405],
    ["/internal/events/kopis-top10/all?mode=musical", "GET", undefined, 400], ["/internal/events/kopis-top10/All", "GET", undefined, 400],
    ["/internal/events/kopis-top10/all/extra", "GET", undefined, 404], ["/internal/events/kopis-top10?rpc=enqueue_job", "POST", { snapshot }, 400],
    ["/internal/events/kopis-top10", "POST", { snapshot, role: "service_role" }, 400], ["/internal/events/kopis-top10", "POST", {}, 400],
    ["/internal/events/kopis-top10", "POST", { snapshot: null }, 400], ["/internal/events/kopis-top10", "POST", { snapshot: [] }, 400],
  ] as const) {
    const h = setup(); assert.equal((await h.send(path, method, body, secret)).status, status); assert.equal(h.calls.length, 0);
  }
  const h = setup(); assert.equal((await h.send("/internal/events/kopis-top10/all", "GET", undefined, secret, "/evil/service-api")).status, 404);
  const get = new Request(API + "/service-api/internal/events/kopis-top10/all", { headers: { Authorization: "Bearer " + secret } });
  Object.defineProperty(get, "body", { value: new ReadableStream() });
  assert.equal((await h.handler(get)).status, 400); assert.equal(h.calls.length, 0);
});

test("Top10 RPC는 내부 service role 헤더로만 전송하고 공개·사용자·spoof RPC는 전송하지 않는다", async () => {
  const result = { status: "saved", itemCount: 1, deduplicated: false };
  const cases = [["store_kopis_top10_snapshot", { p_snapshot: snapshot }], ["get_kopis_top10_snapshot", { p_mode: "all" }]] as const;
  for (const [name, args] of cases) {
    let sent = 0;
    const internal = createInternalClient(config, async (url, init) => {
      sent++; assert.equal(url, API + "/rest/v1/rpc/" + name); assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers); assert.equal(headers.get("apikey"), config.supabaseServiceRoleKey);
      assert.equal(headers.get("authorization"), "Bearer " + config.supabaseServiceRoleKey); assert.equal(init?.body, JSON.stringify(args));
      return new Response(JSON.stringify(result));
    });
    assert.deepEqual(await internal.rpc(name, args), result); assert.equal(sent, 1);
  }
  const noNetwork = async () => assert.fail("must not request");
  const publicDb = createPublicClient(config, noNetwork);
  const principal = await requirePrincipal(new Request(API, { headers: { Authorization: "Bearer a.b.c" } }), config,
    async () => new Response(JSON.stringify({ id: POST, role: "authenticated", is_anonymous: false })));
  const userDb = createUserClient(config, principal, noNetwork), internal = createInternalClient(config, noNetwork);
  const denied = (error: unknown) => { assert.equal(toPublicError(error).error.code, "ACCESS_DENIED"); return true; };
  for (const [name] of cases) {
    await assert.rejects(publicDb.rpc(name, {}), denied); await assert.rejects(userDb.rpc(name, {}), denied);
    for (const spoof of [name + "?select=*", name + "/..", name.toUpperCase()]) await assert.rejects(internal.rpc(spoof, {}), denied);
  }
});

test("Top10 RPC의 malformed/conflict 오류는 원문 없이 400/409로 전달한다", async () => {
  for (const [sqlState, status, code] of [["22023", 400, "INVALID_REQUEST"], ["40001", 409, "STATE_CONFLICT"]] as const) {
    const db = createInternalClient(config, async () => new Response(JSON.stringify({ code: sqlState, message: "RAW_SQL_SECRET_DETAIL", details: "RAW_SQL_SECRET_DETAIL" }), { status: status === 400 ? 400 : 500 }));
    const h = setup(null, db.rpc); const response = await h.send("/internal/events/kopis-top10", "POST", { snapshot }, secret);
    assert.equal(response.status, status); const text = await response.text(); assert.equal(JSON.parse(text).error.code, code);
    assert.doesNotMatch(text, /RAW_SQL_SECRET_DETAIL|synthetic-service|synthetic_worker|stack|details/);
  }
});
