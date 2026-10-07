import assert from "node:assert/strict";
import test from "node:test";
import { createConfiguredModel } from "../../../backend/supabase/functions/_shared/ai/providers/runtime.ts";
import type { RpcClient } from "../../../backend/supabase/functions/_shared/db/transport.ts";
const uid="11111111-1111-4111-8111-111111111111",rid="22222222-2222-4222-8222-222222222222";
const env: Record<string,string>={AI_RETENTION_DECISION_ID:"synthetic",AI_COST_EVIDENCE_ID:"synthetic",AI_PROCESSING_LEGAL_DECISION_ID:"synthetic",AI_MEMBER_TRANSMISSION_APPROVAL_ID:"synthetic",AI_BUDGET_LEDGER_ID:"synthetic",POTENS_ACCOUNT_ORDER:"yumi,jonghyun",POTENS_API_KEY_YUMI:"synthetic-yumi",POTENS_API_KEY_JONGHYUN:"synthetic-jonghyun",POTENS_ACCOUNT_TOKEN_BUDGET:"3200000",POTENS_RESET_TIMEZONE:"Asia/Seoul",POTENS_MODEL:"claude-5-sonnet",POTENS_API_BASE_URL:"https://ai.potens.ai",UPSTREAM_TIMEOUT_MS:"1000"};
const request={task:"intent" as const,system:"synthetic",input:{query:"synthetic"},maxOutputTokens:20,memberRequest:{userId:uid,requestId:uid,leaseToken:uid}};
const outputLimit={decisionId:"synthetic-output-limit",apply:(body:any)=>body};
test("runtime 다중계정: 사전 계정 거절만 다음으로, 단일예산 중첩 없음, 미확인 사용량 보존",async()=>{
 const calls:{name:string;args:any}[]=[], dispatched:string[]=[];
 const db:RpcClient={async rpc(name,args){calls.push({name,args});if(name==="reserve_ai_chat_account_model")return args.p_account_id==="yumi"?{status:"account_budget_denied",reservationId:null}:{status:"reserved",accountId:"jonghyun",reservationId:rid,accountDay:"2026-10-06"};if(name==="settle_ai_account_budget")return{settled:false,pending:true};throw Error("unexpected RPC");}};
 const runtime=createConfiguredModel(key=>env[key],{budgetDb:db,outputLimit,fetch:async(_url,init)=>{dispatched.push((init.headers as Record<string,string>).Authorization);return new Response(JSON.stringify({message:'{"ok":true}'}));}});
 assert.equal(runtime.status,"ready");if(runtime.status!=="ready")return;
 assert.equal(runtime.usageIncludesAllAttempts,true);const result=await runtime.model.generate(request);assert.equal(result.usage,null);assert.deepEqual(dispatched,["Bearer synthetic-jonghyun"]);
 assert.deepEqual(calls.map(c=>c.name),["reserve_ai_chat_account_model","reserve_ai_chat_account_model","settle_ai_account_budget"]);
 const settlement=calls[2].args;assert.equal(settlement.p_account_day,"2026-10-06");assert.equal(settlement.p_outcome,"usage_unknown");assert.equal(settlement.p_input_tokens,null);
});
test("runtime 429 후 타계정 재전송 없음; 미확인 정산",async()=>{
 const calls:any[]=[], db:RpcClient={async rpc(name,args){calls.push({name,args});return name==="settle_ai_account_budget"?{settled:false,pending:true}:{status:"reserved",accountId:"yumi",reservationId:rid,accountDay:"2026-10-06"};}};
 let sends=0;const runtime=createConfiguredModel(key=>env[key],{budgetDb:db,outputLimit,fetch:async()=>{sends++;return new Response("synthetic",{status:429});}});
 assert.equal(runtime.status,"ready");if(runtime.status!=="ready")return;await assert.rejects(runtime.model.generate(request));assert.equal(sends,1);assert.equal(calls.length,2);assert.equal(calls[1].args.p_outcome,"usage_unknown");
});
test("runtime 기존 승인/출력제한 hold 및 잘못된 pool이 단일키 fallback하지 않음",()=>{
 const db:RpcClient={async rpc(){throw Error("must not call");}};
 for(const missing of ["AI_RETENTION_DECISION_ID","AI_PROCESSING_LEGAL_DECISION_ID","AI_MEMBER_TRANSMISSION_APPROVAL_ID"]){assert.equal(createConfiguredModel(key=>key===missing?undefined:env[key],{budgetDb:db,outputLimit}).status,"disabled");}
 assert.deepEqual(createConfiguredModel(key=>env[key],{budgetDb:db}),{status:"disabled",code:"OUTPUT_LIMIT_NOT_VERIFIED"});
 assert.deepEqual(createConfiguredModel(key=>key==="POTENS_ACCOUNT_ORDER"?"jonghyun,yumi":key==="POTENS_API_KEY"?"synthetic-legacy":env[key],{budgetDb:db,outputLimit}),{status:"disabled",code:"NOT_CONFIGURED"});
});
test("runtime 보고된 사용량 원예약 날짜 정산, 정산 응답 유실은 재전송/타계정 전환 없음",async()=>{
 for(const lost of [false,true]){
  const calls:any[]=[], db:RpcClient={async rpc(name,args){calls.push({name,args});if(name==="settle_ai_account_budget"){if(lost)throw Error("synthetic lost");return{settled:true,pending:false};}return{status:"reserved",accountId:"yumi",reservationId:rid,accountDay:"2026-10-06"};}};
  let sends=0;const runtime=createConfiguredModel(key=>key==="POTENS_USAGE_INPUT_FIELD"?"syntheticInput":key==="POTENS_USAGE_OUTPUT_FIELD"?"syntheticOutput":env[key],{budgetDb:db,outputLimit,fetch:async()=>{sends++;return new Response(JSON.stringify({message:'{"ok":true}',token_usage:{syntheticInput:10,syntheticOutput:3}}));}});
  assert.equal(runtime.status,"ready");if(runtime.status!=="ready")return;
  if(lost)await assert.rejects(runtime.model.generate(request));else assert.deepEqual((await runtime.model.generate(request)).usage,{inputTokens:10,outputTokens:3});
  assert.equal(sends,1);assert.equal(calls.length,2);assert.equal(calls[1].args.p_account_day,"2026-10-06");assert.equal(calls[1].args.p_input_tokens,10);
 }
});
test("runtime 후기 scope는 전용 원자 계정RPC를 사용",async()=>{
 const calls:any[]=[], db:RpcClient={async rpc(name,args){calls.push({name,args});return name==="settle_ai_account_budget"?{settled:false,pending:true}:{status:"reserved",accountId:"yumi",reservationId:rid,accountDay:"2026-10-06"};}};
 const runtime=createConfiguredModel(key=>env[key],{budgetDb:db,outputLimit,fetch:async()=>new Response(JSON.stringify({message:'{"claims":[]}'}))});
 assert.equal(runtime.status,"ready");if(runtime.status!=="ready")return;
 await runtime.model.generate({task:"review_chunk",system:"synthetic",input:{reviews:[]},maxOutputTokens:20,summaryRequest:{jobId:uid,leaseToken:uid,targetUserId:uid,workerRunToken:uid,sourceRevision:"1",modelVersion:"potens.claude-5-sonnet",promptVersion:"synthetic",sourceReviewIds:[uid,rid,"33333333-3333-4333-8333-333333333333"]}});
 assert.deepEqual(calls.map(c=>c.name),["reserve_review_summary_account_model","settle_ai_account_budget"]);
});
