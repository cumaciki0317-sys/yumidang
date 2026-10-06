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
const notice={noticeId:id,appointmentId:ap,appointmentOutcome:"no_show",violationOutcome:null,reasonCode:"no_show",violationClass:null,violationType:null,availableAt:"2026-10-06T12:00:00.123456+00:00",firstReadAt:null};
function setup(value:JsonValue={items:[notice],nextCursor:null},error?:HttpError){
 const calls:Array<{name:string;args:Record<string,JsonValue>}>=[];
 const handler=createServiceApi({allowedOrigins:[],maxBodyBytes:8192,authenticateUser:async request=>{
  if(request.headers.get("authorization")!=="Bearer synthetic-member")throw new HttpError("AUTH_REQUIRED");
  return{rpc:async(name,args)=>{calls.push({name,args});if(error)throw error;return value;}};
 },authenticateInternal:async()=>assert.fail("통지 조회는 내부/직원 권한으로 fallback하지 않는다")});
 return{calls,send:(path="/decision-notices",method="GET",body:JsonValue={},member=true)=>handler(new Request(`https://example.invalid/functions/v1/service-api${path}`,{method,headers:{authorization:member?"Bearer synthetic-member":"Bearer invalid","content-type":"application/json"},...(method==="POST"?{body:JSON.stringify(body)}:{})}))};
}
const appeal={appealId:other,noticeId:id,state:"reviewing",receivedAt:"2026-10-06T12:00:00Z",deadlineAt:"2026-10-13T12:00:00Z",alreadyApplied:false};
test("일반 이의 접수/본인 조회 고정 RPC",async()=>{
 const {send,calls}=setup(appeal);assert.equal((await send("/me/general-sanction-appeals","POST",{noticeId:id,clientRequestId:ap,reason:"합성 사유"})).status,200);
 assert.deepEqual(calls[0],{name:"submit_my_general_sanction_appeal",args:{p_notice_id:id,p_client_request_id:ap,p_reason:"합성 사유"}});
 assert.equal((await send(`/me/general-sanction-appeals/${other}`)).status,200);
 assert.deepEqual(calls[1],{name:"get_my_general_sanction_appeal",args:{p_appeal_id:other}});
});
test("회원 시각/신원 추가·빈 사유·query·미인증 차단",async()=>{
 const {send,calls}=setup(appeal);const body={noticeId:id,clientRequestId:ap,reason:"합성"};
 for(const value of[{...body,userId:other},{...body,deadlineAt:"now"},{...body,reason:""},{...body,reason:" 공백"}])assert.equal((await send("/me/general-sanction-appeals","POST",value)).status,400);
 assert.equal((await send("/me/general-sanction-appeals?time=now","POST",body)).status,400);assert.equal((await send(`/me/general-sanction-appeals/${other}`,"GET",{},false)).status,401);assert.equal(calls.length,0);
});
test("잘못된 기한/타인/원문 응답은 폐쇄",async()=>{
 for(const value of[{...appeal,deadlineAt:appeal.receivedAt},{...appeal,appealId:ap},{...appeal,reason:"원문"},{...appeal,state:"done"}])assert.equal((await setup(value).send(`/me/general-sanction-appeals/${other}`)).status,503);
});
