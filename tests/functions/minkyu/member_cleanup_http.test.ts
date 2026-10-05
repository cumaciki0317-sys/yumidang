/** 민규: 내부 cleanup HTTP 경계. 실제 삭제/큐 생존 검증과 구분한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi, type ServiceApiDependencies } from "../../../backend/supabase/functions/service-api/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
const token = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
function setup(result: unknown = { status: "ran", claimed: 1, succeeded: 1 }, enabled = true) {
  let users = 0, internal = 0;
  const calls: Array<{ token: string; signal: AbortSignal }> = [];
  const db = { rpc: async () => { throw new Error("unexpected generic RPC"); } };
  const handler = createServiceApi({ allowedOrigins: [], maxBodyBytes: 1024,
    authenticateUser: async () => { users++; throw new HttpError("AUTH_REQUIRED"); },
    authenticateInternal: async (r) => { internal++; if (r.headers.get("authorization") !== "Bearer synthetic-worker") throw new HttpError("ACCESS_DENIED"); return db; },
    ...(enabled ? { memberCleanup: { execute: async (received, workerToken, signal) => {
      assert.equal(received, db); calls.push({ token: workerToken, signal });
      if (result instanceof Error) throw result;
      return result as Awaited<ReturnType<NonNullable<ServiceApiDependencies["memberCleanup"]>["execute"]>>;
    } } } : {}),
  });
  const send = (body: unknown = {}, opts: { method?: string; auth?: string; header?: string | null; path?: string; signal?: AbortSignal } = {}) => {
    const method = opts.method ?? "POST", headers = new Headers({ authorization: opts.auth ?? "Bearer synthetic-worker", "content-type": "application/json" });
    if (opts.header !== null) headers.set("x-worker-run-token", opts.header ?? token);
    return handler(new Request("https://api.example.invalid" + (opts.path ?? "/service-api/internal/member-cleanup"), {
      method, headers, signal: opts.signal, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }));
  };
  return { send, calls, auth: () => ({ users, internal }) };
}
test("cleanup은 내부 인증 뒤 정규화한 점유 토큰과 취소 신호만 전달한다", async () => {
  const x = setup();
  for (const path of ["/service-api/internal/member-cleanup", "/functions/v1/service-api/internal/member-cleanup"]) {
    const r = await x.send({}, { path }); assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).data, { status: "ran", claimed: 1, succeeded: 1 });
  }
  assert.equal(x.calls.length, 2); assert.equal(x.calls[0].token, token.toLowerCase());
  assert.ok(x.calls[0].signal instanceof AbortSignal); assert.deepEqual(x.auth(), { users: 0, internal: 2 });
});
test("회원 JWT와 잘못된 내부 비밀은 삭제 callback을 실행하지 않는다", async () => {
  const x = setup();
  for (const auth of ["Bearer synthetic-member", "Bearer invalid", ""]) assert.equal((await x.send({}, { auth })).status, 403);
  assert.equal(x.calls.length, 0); assert.equal(x.auth().users, 0);
});
test("외부 입력으로 대상·한도·마감·토큰을 주입하거나 HTTP 경계를 우회할 수 없다", async () => {
  const x = setup();
  for (const b of [null, [], { userId: token }, { limit: 20 }, { deadlineAt: Date.now() + 180000 }, { workerRunToken: token }]) assert.equal((await x.send(b)).status, 400);
  for (const header of [null, "bad", token + "," + token]) assert.equal((await x.send({}, { header })).status, 400);
  assert.equal((await x.send({}, { path: "/service-api/internal/member-cleanup?limit=20" })).status, 400);
  assert.equal((await x.send({}, { method: "GET" })).status, 405);
  assert.equal((await x.send({}, { path: "/evil/service-api/internal/member-cleanup" })).status, 404);
  const controller = new AbortController(); controller.abort();
  assert.equal((await x.send({}, { signal: controller.signal })).status, 409);
  assert.equal(x.calls.length, 0);
});
test("집계는20건 상한과 성공≤점유를 검사하고 내부 증거를 노출하지 않는다", async () => {
  for (const result of [null, { status: "completed", claimed: 1, succeeded: 1 }, { status: "ran", claimed: 21, succeeded: 21 },
    { status: "ran", claimed: 0, succeeded: 1 }, { status: "ran", claimed: 1.5, succeeded: 1 },
    { status: "ran", claimed: 1, succeeded: -1 }, { status: "ran", claimed: 1, succeeded: 1, objectName: "private" }]) {
    const r = await setup(result).send(); assert.equal(r.status, 503); assert.equal((await r.text()).includes("private"), false);
  }
  assert.equal((await setup({ status: "ran", claimed: 0, succeeded: 0 }).send()).status, 200);
});
test("실제 삭제 callback 실패는 성공 집계로 대체하지 않는다", async () => {
  const r = await setup(new HttpError("STATE_CONFLICT")).send();
  assert.equal(r.status, 409); assert.equal((await r.json()).error.code, "STATE_CONFLICT");
});
test("실행기를 연결하지 않은 기본 API는 cleanup 경로를 열지 않는다", async () => {
  const x = setup(undefined, false); assert.equal((await x.send()).status, 404);
  assert.deepEqual(x.auth(), { users: 0, internal: 0 }); assert.equal(x.calls.length, 0);
});
