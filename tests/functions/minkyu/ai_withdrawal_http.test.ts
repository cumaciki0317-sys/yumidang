/** 민규: 철회는 본인 회원 RPC이며 계정 탈퇴·외부 전송을 실행하지 않는다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
function setup() {
  const calls: Array<{ name: string; args: Record<string, JsonValue> }> = [];
  let internalCalls = 0;
  const handler = createServiceApi({ allowedOrigins: [], maxBodyBytes: 8192,
    authenticateUser: async (request) => {
      if (request.headers.get("authorization") !== "Bearer synthetic-member") throw new HttpError("AUTH_REQUIRED");
      return { rpc: async (name, args) => { calls.push({ name, args }); return { withdrawn: true }; } };
    }, authenticateInternal: async () => { internalCalls++; throw new HttpError("ACCESS_DENIED"); } });
  return { calls, internalCalls: () => internalCalls,
    send: (body: unknown, token = "synthetic-member", method = "POST") => handler(new Request("https://api.example.invalid/service-api/me/ai-processing/withdraw", {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    })) };
}
test("두 AI 철회는 해당 종류만 본인 RPC로 전달하고 별도 내부 client를 만들지 않는다", async () => {
  const { calls, send, internalCalls } = setup();
  for (const kind of ["exploration", "review_summary"]) {
    const response = await send({ kind });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { withdrawn: true });
    assert.deepEqual(calls.at(-1), { name: "withdraw_my_ai_processing", args: { p_kind: kind } });
  }
  assert.equal(internalCalls(), 0);
});
test("철회에 다른 회원·동의 활성화·본문·알 수 없는 종류를 주입할 수 없다", async () => {
  const { calls, send } = setup();
  for (const body of [{}, { kind: "all" }, { kind: null }, { kind: "exploration", userId: "other-user" },
    { kind: "review_summary", allowed: true }, { kind: "exploration", text: "저장 금지 원문" }]) assert.equal((await send(body)).status, 400);
  assert.equal(calls.length, 0);
});
test("회원 인증과 POST를 거치지 않는 철회는 RPC를 실행하지 않는다", async () => {
  const { calls, send } = setup();
  assert.equal((await send({ kind: "exploration" }, "anonymous")).status, 401);
  assert.equal((await send(undefined, "synthetic-member", "GET")).status, 405);
  assert.equal(calls.length, 0);
});
