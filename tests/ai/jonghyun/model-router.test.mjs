import test from "node:test";
import assert from "node:assert/strict";
import {createModelRouter} from "../../../backend/supabase/functions/_shared/ai/providers/provider-adapter.ts";
import {createPotensModel} from "../../../backend/supabase/functions/_shared/ai/providers/potens-adapter.ts";
import {ModelError} from "../../../backend/supabase/functions/_shared/ai/providers/provider-errors.ts";
const req={task:"intent",system:"rules",input:{messages:"PRIVATE_BODY"},maxOutputTokens:20};
const result={value:{ok:true},modelVersion:"synthetic",usage:{inputTokens:10,outputTokens:5}};
function setup() {
 const reservations=[],settlements=[]; let remaining=2;
 const budget={async reserve(x){reservations.push(x); return remaining-->0 ? `r${remaining}` : null;},async settle(x){settlements.push(x);}};
 const primary={id:"primary",retentionReview:{status:"approved",decisionId:"synthetic-team-decision"},model:{async generate(){return result;}}};
 const fallback={id:"fallback",retentionReview:{status:"approved",decisionId:"synthetic-team-decision"},model:{async generate(){return result;}}};
 return {primary,fallback,budget,reservations,settlements};
}
test("보관 기준 미정·검토 근거 누락은 예산 예약과 원문 전송 전에 차단",async()=>{
 for (const review of [undefined,{status:"pending"},{status:"approved",decisionId:"  "},{status:"approved"}]) {
  const s=setup();let called=0;s.primary.retentionReview=review;s.primary.zeroRetentionVerified=true;
  s.primary.model.generate=async()=>{called++;return result;};
  await assert.rejects(createModelRouter(s).generate(req),/RETENTION_REVIEW_PENDING/);
  assert.equal(s.reservations.length,0);assert.equal(called,0);
 }
});
test("팀 결정 참조가 있는 합성 구성은 특정 미보관 정책을 코드로 강제하지 않음",async()=>{
 const s=setup();assert.equal(await createModelRouter(s).generate(req).then(x=>x.modelVersion),"synthetic");
 assert.equal(Object.hasOwn(s.primary,"zeroRetentionVerified"),false);
});
test("전송 후 또는 미확인 일일 한도 오류도 자동 대체 제공사로 전환하지 않음",async()=>{
 for(const dispatchState of ["sent","unknown","not_sent"]){
  const s=setup();let fallbackCalls=0;
  s.primary.model.generate=async()=>{throw new ModelError("DAILY_QUOTA_EXHAUSTED",{dispatchState});};
  s.fallback.model.generate=async()=>{fallbackCalls++;return result;};
  await assert.rejects(createModelRouter(s).generate(req),/DAILY_QUOTA_EXHAUSTED/);
  assert.equal(fallbackCalls,0);assert.deepEqual(s.reservations.map(x=>x.providerId),["primary"]);
  assert.equal(s.settlements[0].outcome,"unknown");
 }
});
test("알 수 없는 429/오류는 일일 한도로 추정하지 않고 원문 오류도 제거",async()=>{
 const s=setup();s.primary.model.generate=async()=>{throw new Error("429 PRIVATE_BODY");};
 await assert.rejects(createModelRouter(s).generate(req),e=>e.message==="MODEL_UNAVAILABLE");assert.equal(s.reservations.length,1);
});
test("예산 소진은 제공사를 호출하지 않고 대체도 차단",async()=>{
 const s=setup();let called=0;s.budget.reserve=async()=>null;s.primary.model.generate=async()=>{called++;return result;};
 await assert.rejects(createModelRouter(s).generate(req),/BUDGET_EXHAUSTED/);assert.equal(called,0);
});
test("취소·잘못된 사용량은 안전하게 종료하고 실패 예약을 무조건 환불하지 않음",async()=>{
 const s=setup();const c=new AbortController();c.abort();await assert.rejects(createModelRouter(s).generate({...req,signal:c.signal}),/CANCELLED/);
 s.primary.model.generate=async()=>({...result,usage:{inputTokens:1,outputTokens:999}});
 // 출력 한도 초과 응답은 거절하지만 공급사가 보고한 실제 소비량(예약보다 큼)으로 정산한다.
 await assert.rejects(createModelRouter(s).generate(req),/INVALID_MODEL_RESPONSE/);
 assert.deepEqual(s.settlements[0],{reservationId:s.settlements[0].reservationId,outcome:"success",usage:{inputTokens:1,outputTokens:999}});
});
test("사용량 미보고(null)는 성공 응답이어도 unknown 정산으로 예약 전체를 유지하고 0으로 채우지 않음",async()=>{
 const s=setup();s.primary.model.generate=async()=>({...result,usage:null});
 const response=await createModelRouter(s).generate(req);
 assert.equal(response.usage,null);assert.deepEqual(s.settlements,[{reservationId:s.settlements[0].reservationId,outcome:"unknown"}]);
 assert.equal(typeof s.reservations[0].inputBytes,"number");assert.ok(s.reservations[0].inputBytes>=s.reservations[0].inputChars);
 s.primary.model.generate=async()=>({...result,usage:{inputTokens:-1,outputTokens:1}});
 await assert.rejects(createModelRouter(s).generate(req),/INVALID_MODEL_RESPONSE/);assert.equal(s.settlements.at(-1).outcome,"unknown");
});

test("JS 경계에서 변조한 오류 코드는 고정 오류로 치환",async()=>{
 const s=setup();s.primary.model.generate=async()=>{const e=new ModelError("MODEL_UNAVAILABLE");e.code="PRIVATE_BODY";throw e;};
 await assert.rejects(createModelRouter(s).generate(req),e=>e.message==="MODEL_UNAVAILABLE");
 assert.equal(new ModelError("PRIVATE_BODY").message,"MODEL_UNAVAILABLE");
});

test("형식 실패도 공급사 보고 사용량만 원 예약에 정산하고 원문을 전달하지 않음",async()=>{
 const s=setup();s.primary.model.generate=async()=>{throw new ModelError("INVALID_MODEL_RESPONSE",{dispatchState:"sent",usage:{inputTokens:12,outputTokens:3}});};
 await assert.rejects(createModelRouter(s).generate(req),e=>e.code==="INVALID_MODEL_RESPONSE"&&e.usage.inputTokens===12);
 assert.deepEqual(s.settlements,[{reservationId:"r1",outcome:"success",usage:{inputTokens:12,outputTokens:3}}]);
});
test("형식 사용량·미전송 사용량은 UNKNOWN으로 보존",async()=>{
 for(const evidence of [{dispatchState:"sent",usage:{inputTokens:-1,outputTokens:2}},{dispatchState:"not_sent",usage:{inputTokens:2,outputTokens:1}}]){
  const s=setup();s.primary.model.generate=async()=>{throw new ModelError("INVALID_MODEL_RESPONSE",evidence);};
  await assert.rejects(createModelRouter(s).generate(req));assert.equal(s.settlements[0].outcome,"unknown");
 }
});

test("실제 어댑터→라우터 실패 경계는 호출후 재전송0과 보고usage 정산을 함께 보장",async()=>{
 for(const kind of ["parse","transport","rate","server"]){
  const s=setup();let sends=0;
  s.primary.model=createPotensModel({apiKey:"synthetic",baseUrl:"https://ai.potens.ai",model:"synthetic",timeoutMs:1000,usageFields:{input:"in",output:"out"},fetch:async()=>{
   sends++;if(kind==="transport")throw new ModelError("MODEL_UNAVAILABLE",{dispatchState:"not_sent"});
   return new Response(JSON.stringify({message:"PRIVATE_BODY invalid json",token_usage:{in:10,out:3}}),{status:kind==="rate"?429:kind==="server"?503:200});
  }});
  await assert.rejects(createModelRouter(s).generate({...req,memberRequest:{userId:"u",requestId:"r",leaseToken:"l"}}));
  assert.equal(sends,1);assert.equal(s.reservations.length,1);assert.equal(s.settlements.length,1);
  assert.equal(s.settlements[0].outcome,kind==="parse"?"success":"unknown");
 }
});
