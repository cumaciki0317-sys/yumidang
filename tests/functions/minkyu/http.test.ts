/** 담당: 민규담당. Node 내장 실행기로 Web API 기반 공통 HTTP 경계를 검증한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestContext, readJson } from "../../../backend/supabase/functions/_shared/http/request.ts";
import { jsonSuccess, jsonFailure } from "../../../backend/supabase/functions/_shared/http/response.ts";
import { HttpError, toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import { createCors } from "../../../backend/supabase/functions/_shared/http/cors.ts";

function request(body: string | Uint8Array, headers: Record<string, string> = {}): Request {
  return new Request("https://api.example.test", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : new Uint8Array(body).buffer });
}
const expectCode = (code: string) => (error: unknown) => toPublicError(error).error.code === code;

test("서버 ID는 호출마다 새로 생성되며 응답 본문·헤더가 일치한다", async () => {
  const context = createRequestContext();
  assert.notEqual(context.requestId, createRequestContext().requestId);
  assert.ok(Object.isFrozen(context));
  const response = jsonSuccess({ ok: true }, context, 201);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { data: { ok: true }, requestId: context.requestId });
  assert.equal(response.headers.get("x-request-id"), context.requestId);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
});

test("클라이언트 request ID·본문 원문을 새 서버 ID로 사용하지 않는다", async () => {
  const input = request('{"query":"민감 원문"}', { "X-Request-Id": "token-private-user-text" });
  const context = createRequestContext();
  await readJson(input, { maxBytes: 100 });
  const response = jsonFailure(new Error("민감 원문"), context);
  assert.equal(response.headers.get("x-request-id"), context.requestId);
  assert.doesNotMatch(await response.text(), /token-private|민감 원문/);
  assert.throws(() => jsonSuccess(null, { requestId: "raw-user-text" }));
});

test("오류 객체의 code·message·SQL·토큰·cause를 공개하지 않는다", async () => {
  for (const error of [
    new Error("SELECT phone FROM profiles; token=secret; 대화 원문", { cause: "인증 원문" }),
    { code: "ACCESS_DENIED", message: "private", stack: "SQL" },
    "Bearer secret", null,
  ]) {
    const response = jsonFailure(error, createRequestContext());
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.deepEqual(body.error, { code: "INTERNAL_ERROR", message: "요청 처리 중 오류가 발생했습니다.", retryable: false });
    assert.deepEqual(Object.keys(body).sort(), ["error", "requestId"]);
  }
  const error = new HttpError("STATE_CONFLICT");
  error.message = "SQL secret";
  assert.deepEqual(toPublicError(error), { status: 409, error: { code: "STATE_CONFLICT", message: "현재 상태에서 요청을 처리할 수 없습니다.", retryable: false } });
  assert.equal(toPublicError(new HttpError("EXTERNAL_UNAVAILABLE")).error.retryable, true);
});

test("정확한 UTF-8 바이트 한도에서 JSON을 읽는다", async () => {
  const body = '{"text":"가"}';
  const size = new TextEncoder().encode(body).length;
  assert.deepEqual(await readJson(request(body, { "Content-Length": String(size) }), { maxBytes: size }), { text: "가" });
  await assert.rejects(readJson(request(body), { maxBytes: size - 1 }), expectCode("PAYLOAD_TOO_LARGE"));
});

test("Content-Length 없이도 스트림 크기를 제한하고 초과 시 취소한다", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"a":')); controller.enqueue(new TextEncoder().encode('"oversize"}')); },
    cancel() { cancelled = true; },
  });
  const input = new Request("https://api.example.test", { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  await assert.rejects(readJson(input, { maxBytes: 8 }), expectCode("PAYLOAD_TOO_LARGE"));
  assert.equal(cancelled, true);
});

test("거짓·잘못된 Content-Length와 스트림 오류는 안전한 오류가 된다", async () => {
  await assert.rejects(readJson(request("{}", { "Content-Length": "1" }), { maxBytes: 10 }), expectCode("INVALID_REQUEST"));
  await assert.rejects(readJson(request("{}", { "Content-Length": "-1" }), { maxBytes: 10 }), expectCode("INVALID_REQUEST"));
  await assert.rejects(readJson(request("{}", { "Content-Length": "99999999999999999999" }), { maxBytes: 10 }), expectCode("PAYLOAD_TOO_LARGE"));
  const body = new ReadableStream({ start(controller) { controller.error(new Error("SQL secret")); } });
  const input = new Request("https://api.example.test", { method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half" } as RequestInit);
  await assert.rejects(readJson(input, { maxBytes: 10 }), expectCode("INVALID_REQUEST"));
});

test("잘못된 JSON·빈 본문·UTF-8은 원문 없이 거절한다", async () => {
  for (const body of ["", "{private", new Uint8Array([0x22, 0xff, 0x22])]) {
    await assert.rejects(readJson(request(body), { maxBytes: 100 }), expectCode("INVALID_REQUEST"));
  }
  await assert.rejects(readJson(new Request("https://api.example.test", { headers: { "Content-Type": "application/json" } }), { maxBytes: 100 }), expectCode("INVALID_REQUEST"));
});

test("미지원 미디어·압축 및 잘못된 서버 한도는 거절한다", async () => {
  await assert.rejects(readJson(request("{}", { "Content-Type": "text/plain" }), { maxBytes: 10 }), expectCode("UNSUPPORTED_MEDIA_TYPE"));
  await assert.rejects(readJson(request("{}", { "Content-Encoding": "gzip" }), { maxBytes: 10 }), expectCode("UNSUPPORTED_MEDIA_TYPE"));
  await assert.rejects(readJson(request("{}"), { maxBytes: 0 }), expectCode("INTERNAL_ERROR"));
  assert.deepEqual(await readJson(request("{}", { "Content-Type": "Application/JSON; charset=UTF-8" }), { maxBytes: 2 }), {});
});

const cors = createCors({ allowedOrigins: ["https://app.example.test"], allowedMethods: ["POST"], allowedHeaders: ["Content-Type", "Authorization"] });
function preflight(origin: string, method = "POST", headers = "content-type, authorization") {
  return new Request("https://api.example.test", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": headers } });
}

test("정확히 허용된 출처의 preflight만 통과한다", () => {
  const response = cors.preflight(preflight("https://app.example.test"), createRequestContext())!;
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.test");
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  assert.equal(response.headers.get("access-control-allow-headers"), "content-type, authorization");
  assert.match(response.headers.get("vary")!, /Access-Control-Request-Headers/);
  for (const origin of ["https://app.example.test.evil.test", "null", "https://other.example.test"]) {
    const denied = cors.preflight(preflight(origin), createRequestContext())!;
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  }
});

test("preflight 메서드·헤더와 실제 응답 CORS를 별도로 처리한다", async () => {
  assert.equal(cors.preflight(preflight("https://app.example.test", "DELETE"), createRequestContext())!.status, 405);
  assert.equal(cors.preflight(preflight("https://app.example.test", "POST", "x-secret"), createRequestContext())!.status, 403);
  const input = new Request("https://api.example.test", { headers: { Origin: "https://app.example.test" } });
  assert.equal(cors.preflight(input, createRequestContext()), null);
  const response = cors.apply(jsonFailure(new HttpError("AUTH_REQUIRED"), createRequestContext()), input);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "AUTH_REQUIRED");
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.test");
  assert.throws(() => cors.apply(jsonSuccess(null, createRequestContext()), new Request("https://api.example.test", { headers: { Origin: "https://other.example.test" } })), expectCode("ACCESS_DENIED"));
});

test("Origin 없는 요청에는 CORS 허가를 부여하지 않으며 허용 목록은 인증이 아니다", () => {
  const headers = cors.responseHeaders(new Request("https://api.example.test"));
  assert.equal(headers.get("access-control-allow-origin"), null);
  assert.equal(headers.get("vary"), "Origin");
  const config = { allowedOrigins: ["https://app.example.test"], allowedMethods: ["POST"], allowedHeaders: [] as string[] };
  const local = createCors(config);
  config.allowedOrigins.push("https://other.example.test");
  assert.throws(() => local.responseHeaders(preflight("https://other.example.test")), expectCode("ACCESS_DENIED"));
  assert.throws(() => createCors({ ...config, allowedOrigins: ["*"] }));
  assert.throws(() => createCors({ ...config, allowedOrigins: ["https://app.example.test/path"] }));
});
