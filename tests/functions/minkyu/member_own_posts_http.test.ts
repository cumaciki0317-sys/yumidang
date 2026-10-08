/** 민규: 차단 관리는 원래 회원 JWT만 사용하며 약속 취소를 함께 실행하지 않는다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";

const target = "11111111-1111-4111-8111-111111111111";
function setup() {
  const calls: Array<{ name: string; args: Record<string, JsonValue> }> = [];
  let internal = 0;
  const handler = createServiceApi({ allowedOrigins: [], maxBodyBytes: 8192,
    authenticateUser: async (request) => {
      if (request.headers.get("authorization") !== "Bearer synthetic-member") throw new HttpError("AUTH_REQUIRED");
      return { rpc: async (name, args) => { calls.push({ name, args }); return { acknowledged: true }; } };
    }, authenticateInternal: async () => { internal++; throw new HttpError("ACCESS_DENIED"); } });
  return { calls, internal: () => internal,
    send: (path: string, method = "POST", body: unknown = {}, member = true) => handler(new Request(`https://api.example.invalid/service-api${path}`, {
      method, headers: { authorization: `Bearer ${member ? "synthetic-member" : "anonymous"}`, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    })) };
}

test("본인 공고 목록은 회원 전용 페이지 인수만 허용하고 임의 target 필터는 보내지 않는다", async () => {
  const { calls, send } = setup();
  assert.equal((await send("/me/posts", "GET")).status, 200);
  assert.deepEqual(calls.at(-1), { name: "list_my_service_posts", args: { p_limit: 20, p_before: null } });
  assert.equal((await send(`/me/posts?limit=100&before=${target}`, "GET")).status, 200);
  assert.deepEqual(calls.at(-1), { name: "list_my_service_posts", args: { p_limit: 100, p_before: target } });
  for (const query of ["limit=101", "limit=0", "limit=01", "limit=1&limit=2", "before=invalid", `userId=${target}`]) {
    assert.equal((await send(`/me/posts?${query}`, "GET")).status, 400);
  }
  assert.equal(calls.length, 2);
});
