/** 민규담당. 확정 후 일정 변경·취소 HTTP/클라이언트 경계; SQL 권한·경쟁은 별도 통합 검사다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
import { HttpError, toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import { requirePrincipal } from "../../../backend/supabase/functions/_shared/auth/principal.ts";
import { createUserClient } from "../../../backend/supabase/functions/_shared/db/user-client.ts";
import { createInternalClient } from "../../../backend/supabase/functions/_shared/db/internal-client.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";

const id = "11111111-1111-4111-8111-111111111111";
const changeId = "22222222-2222-4222-8222-222222222222";
const cancellationId = "33333333-3333-4333-8333-333333333333";
const expectedUpdatedAt = "2098-12-01T00:00:00.123456Z";
const proposal = { changeId, startsAt: "2099-01-01T10:00:00+09:00", endsAt: "2099-01-01T12:00:00+09:00", expectedUpdatedAt };
const conditionVersion = "server-condition-version";
type Call = { name: string; args: Record<string, JsonValue>; role: string };
function setup(reply: (name: string) => Promise<JsonValue> = async () => ({ ok: true })) {
  const calls: Call[] = [];
  const client = (role: string) => ({ rpc: async (name: string, args: Record<string, JsonValue>) => { calls.push({ name, args, role }); return reply(name); } });
  const handler = createServiceApi({ allowedOrigins: ["https://app.example.test"], maxBodyBytes: 8192,
    authenticateUser: async request => { if (request.headers.get("authorization") !== "Bearer member") throw new HttpError("AUTH_REQUIRED"); return client("user"); },
    authenticateInternal: async request => { if (request.headers.get("authorization") !== "Bearer worker") throw new HttpError("ACCESS_DENIED"); return client("internal"); },
  });
  const send = (suffix: string, body?: unknown, method = "POST", token = "member") => handler(new Request(`https://api.example.test/service-api${suffix}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { send, calls, handler };
}
const schedulePath = `/appointments/${id}/schedule-change`;
const location = { publicArea: "서울특별시 강남구 역삼동", registeredPlaceName: "도서관", registeredAddress: "서울 강남구 테스트로 1", meetingDetail: "정문 앞" };

test("장소 포함 제안은 검증한 선택 입력을 전달하고 DB 응답 DTO를 보존한다", async () => {
  const result = { appointmentId: id, changeId, status: "awaiting_response", locationChanged: true, newLocation: location, deduplicated: false };
  const { send, calls } = setup(async () => result);
  const response = await send(`${schedulePath}/propose`, { ...proposal, location });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, result);
  assert.deepEqual(calls[0].args, { p_appointment_id: id, p_change_id: changeId, p_starts_at: proposal.startsAt,
    p_ends_at: proposal.endsAt, p_expected_updated_at: expectedUpdatedAt, p_location: location });
  for (const newLocation of [location, null]) {
    const dto = { appointmentId: id, change: { changeId, locationChanged: true, newLocation } };
    const reader = setup(async () => dto);
    assert.deepEqual((await (await reader.send(schedulePath, undefined, "GET")).json()).data, dto);
  }
});

test("시간 전용 응답에는 새 장소 필드를 강제로 추가하지 않는다", async () => {
  const dto = { appointmentId: id, change: { changeId, status: "awaiting_response", oldSchedule: proposal, newSchedule: proposal } };
  const { send } = setup(async () => dto);
  assert.deepEqual((await (await send(schedulePath, undefined, "GET")).json()).data, dto);
});

test("장소 입력은 17개 지역·필수 필드·문자 길이를 검사하며 서버 시각 주입을 거절한다", async () => {
  const { send, calls } = setup();
  for (const invalid of [null, [], {}, { ...location, publicArea: "미등록지역" }, { ...location, publicArea: "서울특별시 종로구" }, { ...location, meetingDetail: "한" },
    { ...location, registeredAddress: "가".repeat(301) }, { ...location, meetingDetail: "가".repeat(301) },
    { ...location, registeredPlaceName: "가".repeat(201) }, { ...location, receivedAt: proposal.startsAt }]) {
    assert.equal((await send(`${schedulePath}/propose`, { ...proposal, location: invalid })).status, 400);
  }
  assert.equal((await send(`${schedulePath}/propose`, { ...proposal, location, receivedAt: proposal.startsAt })).status, 400);
  assert.equal(calls.length, 0);
  for (const publicArea of ["서울 강남구 역삼동", "강원도 춘천시 퇴계동", "전라북도 전주시 완산구 서신동"]) {
    assert.equal((await send(`${schedulePath}/propose`, { ...proposal, location: { ...location, publicArea, registeredPlaceName: null, meetingDetail: "가".repeat(300) } })).status, 200);
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => (call.args.p_location as Record<string, JsonValue>).publicArea), ["서울특별시 강남구 역삼동", "강원특별자치도 춘천시 퇴계동", "전북특별자치도 전주시 완산구 서신동"]);
});

test("일정 변경 조회는 현재 일정·조회 버전·없는 제안·취소를 그대로 전달한다", async () => {
  const result = { appointmentId: id, status: "confirmed", startsAt: proposal.startsAt, endsAt: proposal.endsAt, updatedAt: expectedUpdatedAt, change: null, cancellation: null };
  const { send, calls } = setup(async () => result);
  const response = await send(schedulePath, undefined, "GET");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, result);
  assert.deepEqual(calls, [{ name: "get_appointment_change_state", args: { p_appointment_id: id }, role: "user" }]);
});

test("일정 제안은 경로 약속 ID와 재시도 ID·6자리 원본 시각을 고정 RPC에 보존한다", async () => {
  const { send, calls } = setup();
  assert.equal((await send(`${schedulePath}/propose`, proposal)).status, 200);
  assert.deepEqual(calls, [{ name: "propose_appointment_schedule_change", role: "user", args: {
    p_appointment_id: id, p_change_id: changeId, p_starts_at: proposal.startsAt, p_ends_at: proposal.endsAt, p_expected_updated_at: expectedUpdatedAt,
  } }]);
});

test("일정 제안은 달력·offset·전체 입력·순서와 오래된 버전 대체를 엄격히 검사한다", async () => {
  const { send, calls } = setup();
  for (const input of [
    { changeId }, { ...proposal, changeId: "not-uuid" }, { ...proposal, expectedUpdatedAt: null }, { ...proposal, expectedUpdatedAt: "2098-12-01" },
    { ...proposal, endsAt: proposal.startsAt }, { ...proposal, startsAt: "2099-02-30T10:00:00Z", endsAt: "2099-03-02T00:00:00Z" },
    { ...proposal, startsAt: "2099-01-01T10:00:00" }, { ...proposal, expectedUpdatedAt: "2098-12-01T00:00:00.1234567Z" },
  ]) assert.equal((await send(`${schedulePath}/propose`, input)).status, 400);
  assert.equal(calls.length, 0);
});

test("일정 제안·수락은 회원·역할·확정·만료시각 주입을 받지 않는다", async () => {
  const { send, calls } = setup();
  for (const field of ["appointmentId", "authorId", "requesterId", "userId", "role", "status", "expiresAt", "requestedAt"])
    assert.equal((await send(`${schedulePath}/propose`, { ...proposal, [field]: id })).status, 400);
  for (const field of ["appointmentId", "userId", "acceptedBy", "role", "startsAt"])
    assert.equal((await send(`${schedulePath}/accept`, { changeId, conditionVersion, [field]: id })).status, 400);
  assert.equal(calls.length, 0);
});

test("일정 수락·거절·철회는 동일 변경 ID·불투명 조건 버전을 별도 RPC에 전달한다", async () => {
  const { send, calls } = setup();
  for (const action of ["accept", "decline", "withdraw"]) assert.equal((await send(`${schedulePath}/${action}`, { changeId, conditionVersion })).status, 200);
  assert.deepEqual(calls.map(c => [c.name, c.args]), [
    ["accept_appointment_schedule_change", { p_appointment_id: id, p_change_id: changeId, p_condition_version: conditionVersion }],
    ["decline_appointment_schedule_change", { p_appointment_id: id, p_change_id: changeId, p_condition_version: conditionVersion }],
    ["withdraw_appointment_schedule_change", { p_appointment_id: id, p_change_id: changeId, p_condition_version: conditionVersion }],
  ]);
});

test("일정 응답은 누락·비객체·잘못된 ID·빈 버전을 SQL 전에 거절한다", async () => {
  const { send, calls } = setup();
  for (const action of ["accept", "decline", "withdraw"]) for (const body of [
    {}, null, [], { changeId }, { conditionVersion }, { changeId: "bad", conditionVersion },
    { changeId, conditionVersion: null }, { changeId, conditionVersion: " " }, { changeId, conditionVersion: "v".repeat(201) },
  ]) assert.equal((await send(`${schedulePath}/${action}`, body)).status, 400);
  assert.equal(calls.length, 0);
});

test("기한이 끝난 거절 결과는 기존 일정과 expired를 보존해 HTTP 성공으로 전달한다", async () => {
  const result = { appointmentId: id, changeId, conditionVersion, status: "expired", oldSchedule: { startsAt: proposal.startsAt, endsAt: proposal.endsAt },
    newSchedule: { startsAt: "2099-01-02T10:00:00Z", endsAt: "2099-01-02T12:00:00Z" }, deduplicated: true };
  const { send } = setup(async () => result);
  const response = await send(`${schedulePath}/decline`, { changeId, conditionVersion });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, result);
});

test("변경 제안 철회는 종료 상태·기존 일정을 보존하고 사용자·접수 시각 주입을 거절한다", async () => {
  for (const status of ["withdrawn", "expired", "cancelled"]) {
    const result = { appointmentId: id, changeId, conditionVersion, status, oldSchedule: proposal, newLocation: null, deduplicated: true };
    const { send } = setup(async () => result);
    assert.deepEqual((await (await send(`${schedulePath}/withdraw`, { changeId, conditionVersion })).json()).data, result);
  }
  const { send, calls } = setup();
  for (const field of ["appointmentId", "userId", "requestedBy", "role", "status", "receivedAt", "expiresAt", "location"])
    assert.equal((await send(`${schedulePath}/withdraw`, { changeId, conditionVersion, [field]: id })).status, 400);
  assert.equal((await send(`${schedulePath}/withdraw`, { changeId, conditionVersion }, "POST", "worker")).status, 401);
  assert.equal(calls.length, 0);
  for (const code of ["ACCESS_DENIED", "STATE_CONFLICT"] as const) {
    const denied = setup(async () => { throw new HttpError(code); });
    assert.equal((await denied.send(`${schedulePath}/withdraw`, { changeId, conditionVersion })).status, code === "ACCESS_DENIED" ? 403 : 409);
    assert.deepEqual(denied.calls.map(call => call.role), ["user"]);
  }
});

test("취소는 재시도 ID·사유만 받고 현재 약속을 임의 노쇼·완료로 바꾸지 않는다", async () => {
  const result = { appointmentId: id, status: "cancelled", cancellationId, reason: "개인 일정 변경", cancelledAt: expectedUpdatedAt, deduplicated: false };
  const { send, calls } = setup(async () => result);
  const response = await send(`/appointments/${id}/cancel`, { cancellationId, reason: "개인 일정 변경" });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, result);
  assert.deepEqual(calls, [{ name: "cancel_appointment", role: "user", args: { p_appointment_id: id, p_cancellation_id: cancellationId, p_reason: "개인 일정 변경" } }]);
});

test("취소 사유는 공백·누락·300자 초과를 거절하고 승인되지 않은 상태 필드는 받지 않는다", async () => {
  const { send, calls } = setup();
  for (const body of [
    {}, { cancellationId }, { cancellationId: "bad", reason: "사유" }, { cancellationId, reason: "" }, { cancellationId, reason: " 사유" },
    { cancellationId, reason: "사유 " }, { cancellationId, reason: "가".repeat(301) }, { cancellationId, reason: "사유", cancelledBy: id },
    { cancellationId, reason: "사유", status: "no_show" },
  ]) assert.equal((await send(`/appointments/${id}/cancel`, body)).status, 400);
  assert.equal((await send(`/appointments/${id}/cancel`, { cancellationId, reason: "가".repeat(300) })).status, 200);
  assert.equal(calls.length, 1);
});

test("일정·취소 경로는 메서드·UUID·query·prefix 우회를 차단한다", async () => {
  const { send, calls, handler } = setup();
  assert.equal((await send(schedulePath, {}, "POST")).status, 405);
  for (const path of [`${schedulePath}/propose`, `${schedulePath}/accept`, `${schedulePath}/decline`, `${schedulePath}/withdraw`, `/appointments/${id}/cancel`]) {
    assert.equal((await send(path, undefined, "GET")).status, 405);
    assert.equal((await send(path, {}, "DELETE")).status, 405);
    assert.equal((await send(`${path}?actorId=${id}`, {})).status, 400);
  }
  assert.equal((await send(`${schedulePath}?changeId=a&changeId=b`, undefined, "GET")).status, 400);
  assert.equal((await send("/appointments/not-uuid/schedule-change", undefined, "GET")).status, 400);
  for (const path of [`/evil/service-api${schedulePath}`, `/service-api${schedulePath}/unknown`, `/service-api/appointments/${id}/%63ancel`])
    assert.equal((await handler(new Request(`https://api.example.test${path}`))).status, 404);
  assert.equal(calls.length, 0);
});

test("일정·취소권한·조건·충돌 오류는 내부 역할 재시도 없이 동일 오류를 반환한다", async () => {
  for (const [code, status] of [["ACCESS_DENIED", 403], ["STATE_CONFLICT", 409], ["RESOURCE_NOT_FOUND", 404]] as const) {
    const { send, calls } = setup(async () => { throw new HttpError(code); });
    assert.equal((await send(`${schedulePath}/accept`, { changeId, conditionVersion })).status, status);
    assert.deepEqual(calls.map(c => c.role), ["user"]);
  }
  const { send, calls } = setup();
  assert.equal((await send(`/appointments/${id}/cancel`, { cancellationId, reason: "사유" }, "POST", "worker")).status, 401);
  assert.equal(calls.length, 0);
});

test("유지보수는 두 만료를 먼저 처리하고 모델 없이 공개를 실행한다", async () => {
  const { send, calls } = setup(async (name): Promise<JsonValue> => name === "process_due_review_publications" ? { publishedCount: 1 } : { expiredCount: 2, secret: "never-echo" });
  const response = await send("/internal/maintenance", { limit: 3 }, "POST", "worker");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { status: "partial", completion: { status: "managed_by_reservation" },
    consent: { status: "expired", expiredCount: 2 }, scheduleChange: { status: "expired", expiredCount: 2 },
    reviews: { status: "published", publishedCount: 1 }, summary: { status: "pending_configuration" } });
  assert.deepEqual(calls.map(c => [c.name, c.args, c.role]), [
    ["expire_match_consents", { p_limit: 3 }, "internal"], ["expire_appointment_changes", { p_limit: 3 }, "internal"], ["process_due_review_publications", { p_limit: 3 }, "internal"],
  ]);
});

test("일정 만료 실패·비정상 건수는 공개·요약을 차단하며 민감 응답을 숨긴다", async () => {
  for (const result of [null, { expiredCount: -1 }, { expiredCount: "0" }, { expiredCount: 0.5 }, { expiredCount: Number.MAX_SAFE_INTEGER + 1 }]) {
    const { send, calls } = setup(async name => name === "expire_match_consents" ? { expiredCount: 0 } : result);
    assert.equal((await send("/internal/maintenance", { limit: 1 }, "POST", "worker")).status, 503);
    assert.deepEqual(calls.map(c => c.name), ["expire_match_consents", "expire_appointment_changes"]);
  }
});

const config = { supabaseUrl: "https://project.example.test", supabaseAnonKey: "fixture-anon", allowedOrigins: [], maxRequestBytes: 8192, upstreamTimeoutMs: 1000,
  supabaseServiceRoleKey: "fixture-service", internalWorkerSecret: "fixture_worker_" + "a".repeat(32) };
test("사용자·내부 client는 일정 사용자 RPC와 내부 만료 RPC를 분리한다", async () => {
  const token = "header.payload.signature";
  const principal = await requirePrincipal(new Request("https://app.example.test", { headers: { authorization: `Bearer ${token}` } }), config,
    async () => Response.json({ id, role: "authenticated", is_anonymous: false }));
  const calls: string[] = [];
  const db = createUserClient(config, principal, async (url, init) => { calls.push(String(url)); assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`); return Response.json({ ok: true }); });
  for (const name of ["get_appointment_change_state", "propose_appointment_schedule_change", "accept_appointment_schedule_change", "decline_appointment_schedule_change", "withdraw_appointment_schedule_change", "cancel_appointment"]) await db.rpc(name, {});
  await assert.rejects(db.rpc("expire_appointment_changes", {}), error => toPublicError(error).error.code === "ACCESS_DENIED");
  const internalCalls: string[] = [];
  const internal = createInternalClient(config, async (url, init) => { internalCalls.push(String(url)); assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${config.supabaseServiceRoleKey}`); return Response.json({ expiredCount: 0 }); });
  await internal.rpc("expire_appointment_changes", { p_limit: 2 });
  for (const name of ["cancel_appointment", "accept_appointment_schedule_change", "withdraw_appointment_schedule_change"]) await assert.rejects(internal.rpc(name, {}), error => toPublicError(error).error.code === "ACCESS_DENIED");
  assert.equal(calls.length, 6);
  assert.deepEqual(internalCalls, [`${config.supabaseUrl}/rest/v1/rpc/expire_appointment_changes`]);
});

test("일정 제안 기본 런타임은 네이버 설정 없이 Auth 사용자와 같은 JWT로 고정 RPC를 호출한다", async () => {
  const env: Record<string, string> = { SUPABASE_URL: config.supabaseUrl, SUPABASE_ANON_KEY: config.supabaseAnonKey, ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "1000" };
  const previous = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer header.payload.signature");
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ id, role: "authenticated", is_anonymous: false });
    assert.equal(String(url), `${config.supabaseUrl}/rest/v1/rpc/propose_appointment_schedule_change`);
    assert.equal(JSON.parse(String(init?.body)).p_expected_updated_at, expectedUpdatedAt);
    return Response.json({ appointmentId: id, changeId, status: "awaiting_response", deduplicated: false });
  };
  try {
    const response = await createRuntimeHandler(key => env[key])(new Request(`https://api.example.test/service-api${schedulePath}/propose`, {
      method: "POST", headers: { authorization: "Bearer header.payload.signature", "content-type": "application/json" }, body: JSON.stringify(proposal),
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(urls, [`${config.supabaseUrl}/auth/v1/user`, `${config.supabaseUrl}/rest/v1/rpc/propose_appointment_schedule_change`]);
  } finally { globalThis.fetch = previous; }
});

test("철회 런타임은 검증된 회원 JWT와 정확한 세 RPC 인자만 사용한다", async () => {
  const env: Record<string, string> = { SUPABASE_URL: config.supabaseUrl, SUPABASE_ANON_KEY: config.supabaseAnonKey, ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "1000" };
  const previous = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer header.payload.signature");
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ id, role: "authenticated", is_anonymous: false });
    assert.equal(String(url), `${config.supabaseUrl}/rest/v1/rpc/withdraw_appointment_schedule_change`);
    assert.deepEqual(JSON.parse(String(init?.body)), { p_appointment_id: id, p_change_id: changeId, p_condition_version: conditionVersion });
    return Response.json({ appointmentId: id, changeId, status: "withdrawn", deduplicated: false });
  };
  try {
    const response = await createRuntimeHandler(key => env[key])(new Request(`https://api.example.test/service-api${schedulePath}/withdraw`, {
      method: "POST", headers: { authorization: "Bearer header.payload.signature", "content-type": "application/json" }, body: JSON.stringify({ changeId, conditionVersion }),
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.status, "withdrawn");
    assert.deepEqual(urls, [`${config.supabaseUrl}/auth/v1/user`, `${config.supabaseUrl}/rest/v1/rpc/withdraw_appointment_schedule_change`]);
  } finally { globalThis.fetch = previous; }
});
