/** 민규 C: 본인 통지 HTTP 모형. 실제 DB 신원·통지 배송·화면 읽기 증거와 구분한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { requirePrincipal } from "../../../backend/supabase/functions/_shared/auth/principal.ts";
import { createUserClient } from "../../../backend/supabase/functions/_shared/db/user-client.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const id="11111111-1111-4111-8111-111111111111",other="22222222-2222-4222-8222-222222222222",ap="33333333-3333-4333-8333-333333333333";
const oldNotice={noticeId:id,appointmentId:ap,appointmentOutcome:"no_show",violationOutcome:null,reasonCode:"no_show",violationClass:null,violationType:null,availableAt:"2026-10-06T12:00:00.123456+00:00",firstReadAt:null};
const notice={...oldNotice,appointmentOutcome:"normal",violationOutcome:"confirmed",reasonCode:"spam",violationClass:"minor",violationType:"spam"};
const receipt={deliveryId:other,notice,providedAt:null,deadlineAt:null,appealPolicy:"general_7d"};
function setup(value:JsonValue={items:[notice],nextCursor:null},error?:HttpError){
 const calls:Array<{name:string;args:Record<string,JsonValue>}>=[];
 const handler=createServiceApi({allowedOrigins:[],maxBodyBytes:8192,authenticateUser:async request=>{
  if(request.headers.get("authorization")!=="Bearer synthetic-member")throw new HttpError("AUTH_REQUIRED");
  return{rpc:async(name,args)=>{calls.push({name,args});if(error)throw error;return value;}};
 },authenticateInternal:async()=>assert.fail("통지 조회는 내부/직원 권한으로 fallback하지 않는다")});
 return{calls,send:(path="/decision-notices",method="GET",body:JsonValue={},member=true)=>handler(new Request(`https://example.invalid/functions/v1/service-api${path}`,{method,headers:{authorization:member?"Bearer synthetic-member":"Bearer invalid","content-type":"application/json"},...(method==="POST"?{body:JSON.stringify(body)}:{})}))};
}
test("전달 준비는 시각 없는 exact 응답과 고정 RPC",async()=>{
 const {send,calls}=setup(receipt);const r=await send(`/decision-notices/${id}/prepare-delivery`,"POST");assert.equal(r.status,200);assert.equal(r.headers.get("cache-control"),"no-store");assert.deepEqual(calls,[{name:"prepare_my_general_notice_delivery",args:{p_notice_id:id}}]);
});
test("성공 제공 ACK는 nonce만 받고 7일 응답 검증",async()=>{
 const value={...receipt,providedAt:"2026-10-06T12:00:00Z",deadlineAt:"2026-10-13T12:00:00Z"};
 const {send,calls}=setup(value);assert.equal((await send(`/decision-notices/${id}/provided`,"POST",{deliveryId:other})).status,200);assert.deepEqual(calls,[{name:"acknowledge_my_general_notice_provided",args:{p_notice_id:id,p_delivery_id:other}}]);
 for(const bad of[{...value,deadlineAt:null},{...value,deadlineAt:"2026-10-14T12:00:00Z"},{...value,deliveryId:ap},{...value,raw:"private"},receipt])assert.equal((await setup(bad).send(`/decision-notices/${id}/provided`,"POST",{deliveryId:other})).status,503);
});
test("클라이언트 시각·대리 회원·query 입력은 RPC 이전 차단",async()=>{
 const {send,calls}=setup(receipt);for(const body of[{deliveryId:other,providedAt:"now"},{deliveryId:other,identityId:ap},{},null])assert.equal((await send(`/decision-notices/${id}/provided`,"POST",body)).status,400);
 assert.equal((await send(`/decision-notices/${id}/prepare-delivery?time=now`,"POST")).status,400);
 assert.equal((await send(`/decision-notices/${id}/prepare-delivery`,"POST",{},false)).status,401);assert.equal(calls.length,0);
});
