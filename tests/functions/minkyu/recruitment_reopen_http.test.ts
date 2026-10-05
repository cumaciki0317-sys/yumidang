/** 민규: 작성자의 명시 재개를 취소와 분리하고 복원 대상·시간 판정은 DB가 맡는다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const postId = "22222222-2222-4222-8222-222222222222";
function setup(fail = false) {
  const calls: Array<{ name: string; args: Record<string, JsonValue> }> = [];
  const handler = createServiceApi({ allowedOrigins: [], maxBodyBytes: 8192,
    authenticateUser: async (request) => {
      if (request.headers.get("authorization") !== "Bearer synthetic-member") throw new HttpError("AUTH_REQUIRED");
      return { rpc: async (name, args) => {
        calls.push({ name, args });
        if (fail) throw new HttpError("STATE_CONFLICT");
        return { postId, status: "recruiting", restoredCount: 2, alreadyReopened: false };
      } };
    }, authenticateInternal: async () => { throw new Error("internal client forbidden"); } });
  return { calls, send: (body: unknown = {}, method = "POST", member = true, query = "") => handler(new Request(`https://api.example.invalid/service-api/posts/${postId}/reopen${query}`, {
    method, headers: { authorization: `Bearer ${member ? "synthetic-member" : "anonymous"}`, "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  })) };
}
test("명시 재개는 공고 ID만 전달하고 복원 수·취소 처리를 HTTP가 결정하지 않는다", async () => {
  const { calls, send } = setup();
  const response = await send();
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { postId, status: "recruiting", restoredCount: 2, alreadyReopened: false });
  assert.deepEqual(calls, [{ name: "reopen_service_post", args: { p_post_id: postId } }]);
});
test("복원 대상·작성자·마감 자동 연장 주입과 비회원·다른 메서드를 거절한다", async () => {
  const { calls, send } = setup();
  for (const body of [{ restoredCount: 10 }, { authorId: postId }, { requestIds: [postId] }, { recruitmentEndsAt: "2099-01-01T00:00:00Z" }, null, []]) {
    assert.equal((await send(body)).status, 400);
  }
  assert.equal((await send({}, "POST", true, "?restoreAll=true")).status, 400);
  assert.equal((await send({}, "POST", false)).status, 401);
  assert.equal((await send({}, "GET")).status, 405);
  assert.equal(calls.length, 0);
});
test("재개 불가 상태는 성공으로 꾸미거나 다른 RPC로 우회하지 않는다", async () => {
  const { calls, send } = setup(true);
  const response = await send();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "STATE_CONFLICT");
  assert.equal(calls.length, 1);
});
