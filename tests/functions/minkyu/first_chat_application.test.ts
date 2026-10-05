import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const postId="11111111-1111-4111-8111-111111111111", messageId="22222222-2222-4222-8222-222222222222";
function setup() {
  const calls:Array<{name:string;args:Record<string,JsonValue>}>=[];
  const handler=createServiceApi({allowedOrigins:[],maxBodyBytes:8192,
    authenticateUser:async(request)=>{
      if(request.headers.get("authorization")!=="Bearer fixture-member") throw new HttpError("AUTH_REQUIRED");
      return {rpc:async(name,args)=>{calls.push({name,args});return {id:postId};}};
    },authenticateInternal:async()=>{throw new HttpError("ACCESS_DENIED");}});
  return {calls,send:(body:unknown,token="fixture-member")=>handler(new Request(`https://api.example.invalid/service-api/posts/${postId}/requests`,
    {method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)}))};
}
test("첫 채팅 신청은 UUID와 1~1000자 본문만 고정 RPC에 전달한다",async()=>{
  const {calls,send}=setup();
  for(const message of ["안","가".repeat(1000)]) assert.equal((await send({messageId,message})).status,200);
  assert.deepEqual(calls[0],{name:"request_service_post",args:{p_post_id:postId,p_message_id:messageId,p_message:"안"}});
});
test("구형 별도 신청·잘못된 ID·빈 본문·초과·사용자 주입은 RPC 전에 거절한다",async()=>{
  const {calls,send}=setup();
  for(const body of [{message:"소개문"},{messageId:"invalid",message:"안"},{messageId,message:" "},
    {messageId,message:"가".repeat(1001)},{messageId,message:"안",requesterId:postId}]) {
    assert.equal((await send(body)).status,400);
  }
  assert.equal(calls.length,0);
});
test("비로그인 첫 채팅은 신청 RPC를 실행하지 않는다",async()=>{
  const {calls,send}=setup();
  assert.equal((await send({messageId,message:"안"},"invalid")).status,401);
  assert.equal(calls.length,0);
});
