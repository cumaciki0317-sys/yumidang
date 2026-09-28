import test from "node:test";
import assert from "node:assert/strict";
import {createModelRouter} from "../../../backend/supabase/functions/_shared/ai/providers/provider-adapter.ts";
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
test("대체 제공사의 보관 검토도 별도 확인하고 미정이면 원문 전송 차단",async()=>{
 const s=setup();let called=0;s.primary.model.generate=async()=>{throw new ModelError("DAILY_QUOTA_EXHAUSTED");};
 s.fallback.retentionReview={status:"pending"};s.fallback.model.generate=async()=>{called++;return result;};
 await assert.rejects(createModelRouter(s).generate(req),/RETENTION_REVIEW_PENDING/);
 assert.equal(called,0);assert.deepEqual(s.reservations.map(x=>x.providerId),["primary"]);
});
test("일일 한도 소진만 승인 대체 모델로 전환하고 예약에는 원문을 넘기지 않음",async()=>{
 const s=setup();s.primary.model.generate=async()=>{throw new ModelError("DAILY_QUOTA_EXHAUSTED");};
 await createModelRouter(s).generate(req);assert.deepEqual(s.reservations.map(x=>x.providerId),["primary","fallback"]); assert.equal(JSON.stringify(s.reservations).includes("PRIVATE_BODY"),false);assert.equal(s.settlements[0].outcome,"unknown");
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
 await assert.rejects(createModelRouter(s).generate(req),/INVALID_MODEL_RESPONSE/);assert.equal(s.settlements[0].outcome,"unknown");
});

test("JS 경계에서 변조한 오류 코드는 고정 오류로 치환",async()=>{
 const s=setup();s.primary.model.generate=async()=>{const e=new ModelError("MODEL_UNAVAILABLE");e.code="PRIVATE_BODY";throw e;};
 await assert.rejects(createModelRouter(s).generate(req),e=>e.message==="MODEL_UNAVAILABLE");
 assert.equal(new ModelError("PRIVATE_BODY").message,"MODEL_UNAVAILABLE");
});
