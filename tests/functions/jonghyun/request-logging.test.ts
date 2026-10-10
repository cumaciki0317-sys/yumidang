/** 합성 HTTP·sink로 원문 제외와 관측 실패 격리를 검증한다. DB/외부/운영 보관 검증 아님. */
import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnosticLogger, type DiagnosticLogger } from "../../../backend/supabase/functions/_shared/observability/logger.ts";
import { sanitizeRequestDiagnostic, type RequestDiagnostic } from "../../../backend/supabase/functions/_shared/observability/redaction.ts";
import { createServiceApi, type ServiceApiDependencies } from "../../../backend/supabase/functions/service-api/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";

const id = "11111111-1111-4111-8111-111111111111";
const record: RequestDiagnostic = { requestId: id, resultCode: "SUCCESS", status: 200, durationMs: 3.5 };
const origin = "https://app.example.test";
const sentinel = "SYNTHETIC_PRIVATE_SENTINEL";
function setup(overrides: Partial<ServiceApiDependencies> = {}) {
  const records: Readonly<RequestDiagnostic>[] = [];
  let tick = 0, calls = 0;
  const handler = createServiceApi({ allowedOrigins: [origin], maxBodyBytes: 65536,
    diagnostics: createDiagnosticLogger({ write(value) { records.push(value); } }), diagnosticNow: () => tick++ * 3.5,
    authenticateUser: async () => ({ rpc: async () => { calls++; return { value: sentinel }; } }),
    authenticateInternal: async () => { throw new HttpError("ACCESS_DENIED"); }, ...overrides });
  const send = (path = "/me", method = "GET", headers: Record<string, string> = {}, body?: string) => handler(new Request(
    "https://api.example.test/functions/v1/service-api" + path,
    { method, headers: { origin, authorization: "Bearer " + sentinel, "x-request-id": id, ...headers }, ...(body === undefined ? {} : { body }) }));
  return { handler, send, records, calls: () => calls };
}

test("진단은 검사한 네 primitive만 새 frozen 객체로 복사한다", async () => {
  let received: Readonly<RequestDiagnostic> | undefined;
  const logger = createDiagnosticLogger({ write(value) { received = value; } });
  assert.deepEqual(await logger.write(record), { status: "recorded" });
  assert.deepEqual(received, record);
  assert.notEqual(received, record);
  assert.ok(Object.isFrozen(received));
  const nullPrototype = Object.assign(Object.create(null), record);
  assert.deepEqual(sanitizeRequestDiagnostic(nullPrototype), record);
});

test("원문·symbol·비표준 prototype·Error·숨은 metadata를 sink에 넘기지 않는다", async () => {
  let calls = 0;
  const logger = createDiagnosticLogger({ write() { calls++; } });
  const hidden = Object.defineProperty({ ...record }, "token", { value: sentinel });
  for (const input of [null, [], new Error(sentinel), { ...record, token: sentinel }, { ...record, [Symbol("private")]: sentinel },
    Object.assign(Object.create({ token: sentinel }), record), hidden]) {
    assert.deepEqual(await logger.write(input), { status: "rejected", code: "INVALID_DIAGNOSTIC" });
  }
  assert.equal(calls, 0);
});

test("getter·toJSON·string coercion을 실행하지 않고 거절한다", async () => {
  let evaluated = 0, calls = 0;
  const logger = createDiagnosticLogger({ write() { calls++; } });
  const getter = Object.defineProperty({ ...record }, "requestId", { enumerable: true, get() { evaluated++; throw new Error(sentinel); } });
  const toJSON = { ...record, toJSON() { evaluated++; return sentinel; } };
  const value = { toString() { evaluated++; return id; } };
  for (const input of [getter, toJSON, { ...record, requestId: value }]) {
    assert.deepEqual(await logger.write(input), { status: "rejected", code: "INVALID_DIAGNOSTIC" });
  }
  assert.equal(evaluated, 0);
  assert.equal(calls, 0);
});

test("잘못된 ID·코드·상태·시간 및 누락 필드를 거절한다", () => {
  for (const changes of [{ requestId: sentinel }, { requestId: "11111111-1111-1111-8111-111111111111" },
    { resultCode: sentinel }, { resultCode: "AUTH_REQUIRED" }, { status: 600 }, { status: 200.5 },
    { durationMs: NaN }, { durationMs: Infinity }, { durationMs: -1 }, { durationMs: "3" }]) {
    assert.equal(sanitizeRequestDiagnostic({ ...record, ...changes }), null);
  }
  assert.equal(sanitizeRequestDiagnostic({ requestId: id, status: 200, durationMs: 1 }), null);
  assert.equal(sanitizeRequestDiagnostic({ ...record, status: 401, resultCode: "PREFLIGHT" }), null);
});

test("sink throw·rejection은 고정 실패 코드이며 자동 재시도하지 않는다", async () => {
  for (const asynchronous of [false, true]) {
    let calls = 0;
    const logger = createDiagnosticLogger({ write() { calls++; if (asynchronous) return Promise.reject(new Error(sentinel)); throw new Error(sentinel); } });
    assert.deepEqual(await logger.write(record), { status: "unavailable", code: "DIAGNOSTICS_SINK_UNAVAILABLE" });
    assert.equal(calls, 1);
  }
});

test("정상 HTTP는 서버 응답 ID로 한 번 기록하며 입력·응답 원문을 제외한다", async () => {
  const { send, records, calls } = setup();
  const response = await send();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.value, sentinel);
  assert.equal(body.requestId, response.headers.get("x-request-id"));
  assert.notEqual(body.requestId, id);
  assert.deepEqual(records, [{ requestId: body.requestId, resultCode: "SUCCESS", status: 200, durationMs: 3.5 }]);
  assert.equal(JSON.stringify(records).includes(sentinel), false);
  assert.equal(calls(), 1);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
});

test("민감 합성값이 포함된 알 수 없는 query는 기존 거절을 유지하며 URL을 기록하지 않는다", async () => {
  const { send, records, calls } = setup();
  const response = await send("/me?private=" + sentinel);
  assert.equal(response.status, 400);
  assert.equal(records.length, 1);
  assert.equal(records[0].resultCode, "INVALID_REQUEST");
  assert.equal(JSON.stringify(records).includes(sentinel), false);
  assert.equal(calls(), 0);
});

test("본문의 민감 합성값은 기록하지 않고 기존 입력 거절을 보존한다", async () => {
  const { send, records, calls } = setup();
  const response = await send("/posts", "POST", { "content-type": "application/json" }, JSON.stringify({ introduction: sentinel }));
  assert.equal(response.status, 400);
  assert.equal(records[0].resultCode, "INVALID_REQUEST");
  assert.equal(JSON.stringify(records).includes(sentinel), false);
  assert.equal(calls(), 0);
});

test("공개 인증 오류와 알 수 없는 오류는 원문 없이 상태로 분류한다", async () => {
  for (const [error, status, code] of [[new HttpError("AUTH_REQUIRED"), 401, "AUTH_REQUIRED"], [new Error(sentinel), 500, "INTERNAL_ERROR"]] as const) {
    const { send, records } = setup({ authenticateUser: async () => { throw error; } });
    const response = await send();
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
    assert.equal(records.length, 1);
    assert.equal(records[0].resultCode, code);
    assert.equal(JSON.stringify(records).includes(sentinel), false);
  }
});

test("성공/거절 OPTIONS도 한 번 기록하며 기존 헤더·body를 보존한다", async () => {
  for (const allowed of [true, false]) {
    const { send, records, calls } = setup();
    const response = await send("/me", "OPTIONS", { origin: allowed ? origin : "https://denied.example.test", "access-control-request-method": "GET" });
    assert.equal(response.status, allowed ? 204 : 403);
    assert.equal(records.length, 1);
    assert.equal(records[0].resultCode, allowed ? "PREFLIGHT" : "ACCESS_DENIED");
    if (allowed) { assert.equal(response.headers.get("x-request-id"), null); assert.equal(await response.text(), ""); }
    assert.equal(calls(), 0);
  }
});

test("자체 오류 Response 조기 반환을 성공으로 기록하지 않는다", async () => {
  for (const status of [403, 503, 204]) {
    const { send, records } = setup({ profileImages: { execute: async () => new Response(status === 204 ? null : sentinel, { status }) } });
    const response = await send("/profile-images/" + id);
    assert.equal(response.status, status);
    assert.equal(records.length, 1);
    assert.equal(records[0].resultCode, status === 403 ? "ACCESS_DENIED" : status === 503 ? "EXTERNAL_UNAVAILABLE" : "SUCCESS");
    assert.equal(await response.text(), status === 204 ? "" : sentinel);
  }
});

test("진단 미설치 때 진단 시계·sink를 호출하지 않는다", async () => {
  const { send, records } = setup({ diagnostics: undefined, diagnosticNow: () => { assert.fail("clock without logger"); } });
  assert.equal((await send()).status, 200);
  assert.equal(records.length, 0);
});

test("logger throw·rejection·pending이 HTTP 응답이나 DB 실행을 막지 않는다", async () => {
  for (const mode of ["throw", "reject", "pending"] as const) {
    let writes = 0;
    const diagnostics: DiagnosticLogger = { write() { writes++; if (mode === "throw") throw new Error(sentinel); return mode === "reject" ? Promise.reject(new Error(sentinel)) : new Promise(() => {}); } };
    const { send, calls } = setup({ diagnostics });
    const response = await send();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.value, sentinel);
    assert.equal(writes, 1);
    assert.equal(calls(), 1);
  }
});

test("불량·역행·예외 시계는 로그만 생략하고 HTTP 결과를 보존한다", async () => {
  for (const values of [[NaN, 1], [1, NaN], [1, Infinity], [2, 1], [1, "3"], ["1", 3], [new Error(sentinel), 1], [1, new Error(sentinel)]]) {
    let index = 0;
    const { send, records, calls } = setup({ diagnosticNow: () => { const value = values[index++]; if (value instanceof Error) throw value; return value as number; } });
    const response = await send();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.value, sentinel);
    assert.equal(records.length, 0);
    assert.equal(calls(), 1);
  }
});
