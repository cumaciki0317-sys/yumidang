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

test("읽음은 실제 메시지 식별자만 받으며 클라이언트 시각·회원 ID를 거절한다", async () => {
 const {calls,send}=setup();
 assert.equal((await send(`/conversations/${target}/read`,"POST",{lastReadMessageId:target})).status,200);
 assert.deepEqual(calls[0],{name:"mark_conversation_read",args:{p_request_id:target,p_last_read_message_id:target}});
 for(const body of [{},{lastReadMessageId:"bad"},{lastReadMessageId:target,userId:target},{lastReadMessageId:target,readAt:"2026-10-08"}])
  assert.equal((await send(`/conversations/${target}/read`,"POST",body)).status,400);
 assert.equal((await send(`/conversations/${target}/read`,"POST",{lastReadMessageId:target},false)).status,401);
 assert.equal(calls.length,1);
});
test("대화 조회는 읽음 위치를 반환하는 회원 RPC를 쓰며 읽음을 자동 변경하지 않는다",async()=>{
 const {calls,send}=setup();
 assert.equal((await send('/conversations','GET')).status,200);
 assert.equal((await send(`/conversations/${target}`,'GET')).status,200);
 assert.deepEqual(calls.map(c=>c.name),['list_conversations_with_read_state','get_conversation_with_read_state']);
});
