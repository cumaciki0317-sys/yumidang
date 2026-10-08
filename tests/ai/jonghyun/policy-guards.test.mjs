/** 합성 RPC/검사기/모델 검증. 실제 DB 원자성·개인정보 검사 품질·외부 호출 승인을 증명하지 않는다. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRpcAiChatRequestGate } from "../../../backend/supabase/functions/_shared/ai/providers/member-request.ts";
import { createRpcModelBudget } from "../../../backend/supabase/functions/_shared/ai/providers/budget.ts";
import { createModelRouter } from "../../../backend/supabase/functions/_shared/ai/providers/provider-adapter.ts";
import { ModelError } from "../../../backend/supabase/functions/_shared/ai/providers/provider-errors.ts";
import { probeSummaryWorkerRpcs } from "../../../backend/supabase/functions/review-summary-worker/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import { createConfiguredModel } from "../../../backend/supabase/functions/_shared/ai/providers/runtime.ts";
import { createAiChatHandler } from "../../../backend/supabase/functions/ai-chat/handler.ts";
import { runChat } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/orchestrator.ts";
import { validateFilters } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/intent.ts";
import { checkSummaryOutput } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/output-check.ts";
import { runReviewSummaryStep } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/orchestrator.ts";
import { REVIEW_SUMMARY_PROMPT_VERSION } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/prompts.ts";
import { createRpcReviewSummaryRepository } from "../../../backend/supabase/functions/_shared/db/repositories/review-summaries.ts";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const scope = { userId: id(1), requestId: id(2), leaseToken: id(3) };
const limits = { maxMessages:20,maxMessageChars:500,maxTotalChars:4000,maxOutputTokens:800 };
const privacy = { decisionId:"synthetic-only-do-not-use-in-production", check: async value => !JSON.stringify(value).includes("PRIVATE_NAME") };
const input = {clientRequestId:"new-1",messages:[{role:"user",content:"전시"}],currentFilters:{target:"posts",region:"서울특별시"}};
const response = value => ({ value, modelVersion:"synthetic",usage:null });
const request = body => new Request("https://synthetic.invalid/ai-chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
function handlerHarness(overrides={}) {
  const seen={starts:0,finishes:[],calls:[],prefs:0,receipts:[],lifecycle:[]};
  const gate={async acquire(value){seen.starts++; return {status:"acquired",scope:{...scope,requestId:value.requestId},expiresAt:new Date(Date.now()+60_000).toISOString()};},async finish(s,outcome){seen.lifecycle.push("finish");seen.finishes.push({s,outcome});}};
  const model={async generate(value){seen.calls.push(value);return response({status:"search",filters:{...input.currentFilters}});}};
  const handler=createAiChatHandler({allowedOrigins:[],maxBodyBytes:12000,authenticate:async()=>({userId:scope.userId}),
    engine:{status:"ready",limits,privacy,model,now:()=>new Date()}, requestGate:gate,
    recordResultAvailable:async s=>{seen.lifecycle.push("record");seen.receipts.push({...s});},
    openSession:()=>({loadPreferences:async()=>{seen.prefs++;return {};},discovery:{search:async()=>({cards:[],coverage:"exhausted"}),recheck:async()=>({cards:[],complete:true})}}),...overrides});
  return {handler,seen};
}
test("회원 점유 RPC는 인증ID·요청키만 전송하고 DB 시각의 lease를 보존한다",async()=>{
  const calls=[]; const gate=createRpcAiChatRequestGate({rpc:async(name,args)=>{calls.push({name,args});return name.startsWith("acquire")?{status:"acquired",leaseToken:scope.leaseToken,expiresAt:"2026-10-05T12:00:00Z"}:{finished:true};}});
  const result=await gate.acquire({...scope,clientRequestId:"c1"});
  assert.deepEqual(result.scope,scope);
  await gate.finish(result.scope,"output_privacy");
  assert.deepEqual(calls[0].args,{p_user_id:scope.userId,p_request_id:scope.requestId,p_client_request_id:"c1",p_output_retry_of:null,p_contract_version:"2026-10-05"});
  assert.equal(calls[1].args.p_outcome,"output_privacy");
  assert.equal(JSON.stringify(calls).includes("messages"),false);
});
test("동시·일일한도·철회·재시도초과 거부는 승인으로 바꾸지 않고 잘못된 lease 응답을 거절한다",async()=>{
  for(const status of ["concurrent","daily_limit","consent_revoked","retry_exhausted"]){
    const gate=createRpcAiChatRequestGate({rpc:async()=>({status})});
    assert.deepEqual(await gate.acquire({...scope,clientRequestId:"c1"}),{status});
  }
  for(const value of [{status:"acquired",leaseToken:"x",expiresAt:"2026-10-05"},{status:"acquired",leaseToken:scope.leaseToken,expiresAt:"bad"},{status:"daily_limit",extra:true}]){
    await assert.rejects(createRpcAiChatRequestGate({rpc:async()=>value}).acquire({...scope,clientRequestId:"c1"}),/INVALID_AI_REQUEST_RESPONSE/);
  }
});
test("개인 첫 차감과 전체 예산은 하나의 RPC로 요청하고 내부 호출도 같은 점유키를 유지한다",async()=>{
  const calls=[];
  const budget=createRpcModelBudget({rpc:async(name,args)=>{calls.push({name,args});return {reservationId:id(4)};}},{ledgerId:"synthetic",promptOverheadBytes:7});
  for(const task of ["intent","preference_match","explanation"]){await budget.reserve({providerId:"potens",task,inputChars:3,inputBytes:9,maxOutputTokens:800,memberRequest:scope});}
  assert.deepEqual(calls.map(c=>c.name),Array(3).fill("reserve_ai_chat_model"));
  assert.equal(calls.every(c=>c.args.p_request_id===scope.requestId&&c.args.p_lease_token===scope.leaseToken),true);
  assert.equal(calls[0].args.p_units,816);
  assert.equal(calls.some(c=>c.name==="reserve_ai_budget"),false,"두 독립 예약으로 원자성을 흉내내지 않는다");
});
test("탐색 일시 오류는 자동 1회 재시도하며 내부 재시도에 같은 개인 요청키를 사용한다",async()=>{
  let calls=0;const reserves=[];
  const model=createModelRouter({primary:{id:"synthetic",retentionReview:{status:"approved",decisionId:"synthetic"},model:{generate:async()=>{calls++;if(calls===1)throw new ModelError("TIMEOUT");return response({});}}},
    budget:{reserve:async v=>{reserves.push(v);return id(4);},settle:async()=>{}}});
  await model.generate({task:"intent",system:"s",input:{},maxOutputTokens:800,memberRequest:scope});
  assert.equal(calls,2);assert.deepEqual(reserves.map(r=>r.memberRequest),[scope,scope]);
  calls=0; await assert.rejects(createModelRouter({primary:{id:"synthetic",retentionReview:{status:"approved",decisionId:"synthetic"},model:{generate:async()=>{calls++;throw new ModelError("TIMEOUT");}}},budget:{reserve:async()=>id(4),settle:async()=>{}}}).generate({task:"intent",system:"s",input:{},maxOutputTokens:800,memberRequest:scope}),/TIMEOUT/);
  assert.equal(calls,2);
});
test("요약 작업 호출은 탐색 자동 재시도를 적용하지 않아 단계 호출 상한을 보존한다",async()=>{
  let count=0; const model=createModelRouter({primary:{id:"synthetic",retentionReview:{status:"approved",decisionId:"synthetic"},model:{generate:async()=>{count++;throw new ModelError("TIMEOUT");}}},budget:{reserve:async()=>id(4),settle:async()=>{}}});
  await assert.rejects(model.generate({task:"review_chunk",system:"s",input:{},maxOutputTokens:800}),/TIMEOUT/);assert.equal(count,1);
});
test("입력의 이전 메시지·조건 개인정보도 전송 전 차단하고 선택 구간을 자동 제출하지 않는다",async()=>{
  for(const body of [{...input,messages:[{role:"user",content:"010-1234-5678"},...input.messages]},
    {...input,currentFilters:{...input.currentFilters,query:"a@example.com"}},
    {...input,messages:[{role:"user",content:"PRIVATE_NAME"}]}]){
    const {handler,seen}=handlerHarness(); const payload=await(await handler(request(body))).json();
    assert.equal(payload.data.recovery.reason,"input_privacy");assert.equal(seen.starts,0);assert.equal(seen.calls.length,0);
    assert.equal(JSON.stringify(payload).includes(body.messages[0].content),false);
  }
});
test("출력 개인정보는 카드·설명 전체를 숨기고 첫 요청만 1회 재시도를 안내한다",async()=>{
  for(const retried of [false,true]){
    const {handler,seen}=handlerHarness({engine:{status:"ready",limits,privacy,now:()=>new Date(),model:{generate:async()=>response({status:"clarify",filters:{...input.currentFilters},question:"PRIVATE_NAME"})}}});
    const payload=await(await handler(request({...input,...(retried?{outputRetryOf:id(9)}:{})}))).json();
    assert.equal(payload.data.recovery.reason,"output_privacy");assert.equal(payload.data.recovery.retryAllowed,!retried);
    assert.deepEqual(payload.data.cards,[]);assert.equal(JSON.stringify(payload).includes("PRIVATE_NAME"),false);assert.equal(seen.finishes[0].outcome,"output_privacy");
  }
});
test("동의 철회·동시 요청·일일20회 거부는 성향·모델 조회 없이 반환한다",async()=>{
  for(const status of ["consent_revoked","concurrent","daily_limit"]){
    const {handler,seen}=handlerHarness({requestGate:{acquire:async()=>({status}),finish:async()=>assert.fail()}});
    const payload=await(await handler(request(input))).json();
    assert.equal(payload.data.status,"unavailable");assert.equal(seen.calls.length,0);assert.equal(seen.prefs,0);
  }
});
test("회원 RPC 연결 실패를 일반 예산 포트로 우회하지 않고 모델 전에 멈춘다",async()=>{
  const {handler,seen}=handlerHarness({requestGate:{acquire:async()=>{throw new Error("ACCESS_DENIED");},finish:async()=>assert.fail()}});
  assert.equal((await(await handler(request(input))).json()).data.status,"unavailable");assert.equal(seen.calls.length,0);
});
test("지역 미설정은 모델 없는 질문이고 대화 내용이 잘못됐으면 400이다",async()=>{
  const {handler,seen}=handlerHarness();
  const payload=await(await handler(request({...input,currentFilters:{target:"posts"}}))).json();
  assert.equal(payload.data.status,"needs_clarification");assert.match(payload.data.clarificationQuestion,/지역/);assert.equal(seen.calls.length,0);
  assert.deepEqual(seen.receipts,[{...scope,requestId:payload.requestId}]);
  assert.deepEqual(seen.lifecycle,["record","finish"],"모델 없는 정상 질문도 기록 후 한 번 해제한다");
  assert.equal((await handler(request({...input,messages:[{role:"system",content:"x"}],currentFilters:{target:"posts"}}))).status,400);
  assert.equal(seen.receipts.length,1,"잘못된 입력은 정상 결과 증거를 추가하지 않는다");
});
test("연령은 숫자19~99범위, 공고지역은 공식17시도이며 이전 연령대와 축약지역은 거부한다",()=>{
  assert.deepEqual(validateFilters({...input.currentFilters,authorAge:{min:19,max:99}}).authorAge,{min:19,max:99});
  assert.equal(validateFilters({...input.currentFilters,authorAge:"all"}).authorAge,"all");
  for(const age of ["20s",{min:18,max:99},{min:19,max:100},{min:99,max:19},{min:19,max:20.5}])assert.throws(()=>validateFilters({...input.currentFilters,authorAge:age}));
  assert.throws(()=>validateFilters({target:"posts",region:"서울"}));
});
test("공식 출력 상한 인코더 미확인 상태는 보관·비용 설정이 있어도 disabled이다",()=>{
  const env={AI_RETENTION_DECISION_ID:"synthetic",AI_COST_EVIDENCE_ID:"synthetic",AI_BUDGET_LEDGER_ID:"synthetic",AI_PROCESSING_LEGAL_DECISION_ID:"synthetic",AI_MEMBER_TRANSMISSION_APPROVAL_ID:"synthetic"};
  const result=createConfiguredModel(k=>env[k],{budgetDb:{rpc:async()=>assert.fail()}});
  assert.deepEqual(result,{status:"disabled",code:"OUTPUT_LIMIT_NOT_VERIFIED"});
});
test("공개 요약300자는 Unicode문자 단위로 검사하고301자나 더큰설정으로 우회하지 못한다",()=>{
  const raw=length=>({claims:[{text:"🌸".repeat(length),evidenceIds:["r1"]}]});
  assert.equal(checkSummaryOutput(raw(300),["r1"],300)[0].text.length,600);
  assert.throws(()=>checkSummaryOutput(raw(301),["r1"],2000),/SUMMARY_OUTPUT_TOO_LARGE/);
});
test("요약 RPC는 동의 검사 버전을 요구하고 대상자철회 응답·구버전 응답을 성공으로 쓰지 않는다",async()=>{
  const job={jobId:id(10),leaseToken:id(11),targetUserId:id(12),sourceRevision:"1",modelVersion:"synthetic",promptVersion:"synthetic"};
  const source={status:"applied",profileId:job.targetUserId,sourceRevision:"1",reviews:[],eligibleCount:0,processingAllowed:false};
  let args; const repo=createRpcReviewSummaryRepository({rpc:async(n,a)=>{args=a;return source;}});
  assert.equal(await repo.loadSource(job),"stale_revision");assert.equal(args.p_contract_version,"2026-10-05");
  delete source.processingAllowed;await assert.rejects(repo.loadSource(job),/INVALID_SUMMARY_RESPONSE/);
});
test("요약 분할 사이에 작성자가철회하거나대상자가철회하면 다음 원문 전송 없이 폐기한다",async()=>{
  const job={jobId:"j1",leaseToken:"l1",targetUserId:"u1",sourceRevision:"1",modelVersion:"synthetic",promptVersion:REVIEW_SUMMARY_PROMPT_VERSION};
  const reviews=[1,2,3,4].map(i=>({evidenceId:"r"+i,comment:"가상 후기"+i}));let sourceCalls=0,modelCalls=0,discarded=0;
  const repo={loadSource:async()=>++sourceCalls===3?"stale_revision":{targetUserId:"u1",sourceRevision:"1",processingAllowed:true,publicTextReviews:reviews},loadCheckpoint:async()=>null,saveCheckpoint:async()=>"applied",discardCheckpoint:async()=>{discarded++;return "applied";},publish:async()=>assert.fail(),markInsufficient:async()=>assert.fail()};
  const result=await runReviewSummaryStep(job,{repository:repo,model:{generate:async r=>{modelCalls++;return response({claims:r.input.reviews.map(item=>({text:"경험",evidenceIds:[item.evidenceId]}))});}},safety:{check:async()=>true},settings:{maxInputChars:12000,maxReviewsPerChunk:2,mergeFanIn:4,maxOutputTokens:800,maxOutputChars:300,maxCallsPerStep:3},versions:{modelVersion:job.modelVersion,promptVersion:job.promptVersion}});
  assert.equal(result.status,"superseded");assert.equal(modelCalls,1);assert.equal(discarded,1);
});

test("응답 직전 일부 카드만 검증되면 검증된 최신 부분집합만 partial로 제공한다",async()=>{
  const card=id=>({kind:"post",id,title:"전시",locationLabel:"서울특별시 종로구",startsAtOrDate:"2026-10-10",endsAtOrDate:"2026-10-11",costLabel:"무료",state:"recruiting",canApply:true});
  const initial=[card("p1"),card("p2")];
  const deps={model:{generate:async()=>response({status:"search",filters:{...input.currentFilters}})},limits,now:()=>new Date(),
    discovery:{search:async()=>({cards:initial,coverage:"filled"}),recheck:async()=>({cards:[{...initial[0],title:"변경된 전시"}],complete:false})}};
  const result=await runChat(input,{userId:scope.userId},deps,"r1");
  assert.equal(result.status,"results");assert.equal(result.partial,true);assert.deepEqual(result.cards.map(c=>c.id),["p1"]);
  assert.equal(result.cards[0].title,"변경된 전시");assert.match(result.notice,/일부/);
  deps.discovery.recheck=async()=>({cards:[],complete:false});
  assert.equal((await runChat(input,{userId:scope.userId},deps,"r2")).status,"unavailable");
});

test("철회·개인한도·점유 손실의 예약 거부는 일시 오류 자동 재시도를 하지 않는다",async()=>{
  for(const status of ["consent_revoked","daily_limit","lease_lost"]){
    let attempts=0,providerCalls=0;
    const budget=createRpcModelBudget({rpc:async()=>{attempts++;return {status};}},{ledgerId:"synthetic",promptOverheadBytes:0});
    const model=createModelRouter({primary:{id:"synthetic",retentionReview:{status:"approved",decisionId:"synthetic"},model:{generate:async()=>{providerCalls++;return response({});}}},budget});
    await assert.rejects(model.generate({task:"intent",system:"s",input:{},maxOutputTokens:800,memberRequest:scope}));
    assert.equal(attempts,1);assert.equal(providerCalls,0);
  }
});

test("법적 처리검토와 사용자 실회원전송 승인 근거를 합성 보관설정만으로 대체하지 못한다",()=>{
  const env={AI_RETENTION_DECISION_ID:"synthetic",AI_COST_EVIDENCE_ID:"synthetic",AI_BUDGET_LEDGER_ID:"synthetic"};
  const deps={budgetDb:{rpc:async()=>assert.fail()}};
  assert.deepEqual(createConfiguredModel(k=>env[k],deps),{status:"disabled",code:"LEGAL_REVIEW_PENDING"});
  env.AI_PROCESSING_LEGAL_DECISION_ID="synthetic";
  assert.deepEqual(createConfiguredModel(k=>env[k],deps),{status:"disabled",code:"MEMBER_TRANSMISSION_NOT_APPROVED"});
});

test("유료 행사 조건은 모델이나 검색으로 추정하지 않고 조건을 보존해 지원 범위를 묻는다",async()=>{
  let calls=0; const paid={...input,currentFilters:{target:"events",region:"서울특별시",cost:"paid"}};
  const result=await runChat(paid,{userId:scope.userId},{model:{generate:async()=>{calls++;assert.fail();}},limits,now:()=>new Date(),discovery:{}},"r1");
  assert.equal(result.status,"needs_clarification"); assert.equal(result.interpretedFilters.cost,"paid"); assert.equal(calls,0);
});


test("사용자 요청의 모든 모델 단계가 자동 재시도 한 번을 공유하며 다음 요청은 독립한다", async()=>{
  const attempts = new Map(), reservations=[];
  const router=createModelRouter({primary:{id:"synthetic",retentionReview:{status:"approved",decisionId:"synthetic"},model:{generate:async r=>{
    const key=r.memberRequest.requestId+":"+r.task, count=(attempts.get(key)??0)+1; attempts.set(key,count);
    if(count===1)throw new ModelError("TIMEOUT"); return response({});
  }}},budget:{reserve:async r=>{reservations.push(r);return id(4);},settle:async()=>{}}});
  const first={...scope};
  await router.generate({task:"intent",system:"s",input:{},maxOutputTokens:800,memberRequest:first});
  await assert.rejects(router.generate({task:"explanation",system:"s",input:{},maxOutputTokens:800,memberRequest:first}),/TIMEOUT/);
  assert.equal(attempts.get(first.requestId+":intent"),2);
  assert.equal(attempts.get(first.requestId+":explanation"),1);
  assert.equal(reservations.length,3);
  assert.equal(reservations.every(r=>r.memberRequest===first),true);
  const second={...scope,requestId:id(8)};
  await router.generate({task:"intent",system:"s",input:{},maxOutputTokens:800,memberRequest:second});
  assert.equal(attempts.get(second.requestId+":intent"),2);
});

test("요약 원문 조회 후 개인정보 검사 중 철회·revision 변경·전역 점유 손실은 원자 예약에서 차단한다",async()=>{
  const job={jobId:id(10),leaseToken:id(11),targetUserId:id(12),sourceRevision:"1",modelVersion:"synthetic",promptVersion:REVIEW_SUMMARY_PROMPT_VERSION};
  const reviews=[20,21,22,23].map(n=>({evidenceId:id(n),comment:"합성 공개 후기"}));
  for(const denial of ["consent_revoked","stale_revision","lease_lost","insufficient_reviews","invalid_evidence"]){
    let authorizationChanged=false,providerCalls=0,saves=0,discards=0;const calls=[];
    const budget=createRpcModelBudget({rpc:async(name,args)=>{
      calls.push({name,args}); assert.equal(authorizationChanged,true,"조회 후 검사 동안 변경된 자격을 예약에서 검사");
      return {status:denial};
    }},{ledgerId:"synthetic",promptOverheadBytes:0});
    const router=createModelRouter({primary:{id:"synthetic",retentionReview:{status:"approved",decisionId:"synthetic"},model:{generate:async()=>{providerCalls++;assert.fail("철회 이후 새 전송 금지");}}},budget});
    const model={generate:async r=>{
      await Promise.resolve(); // runtime의 승인된 개인정보 검사 await 동안 자격 변경을 흉내 낸다.
      authorizationChanged=true;return router.generate(r);
    }};
    const repository={loadSource:async()=>({targetUserId:job.targetUserId,sourceRevision:"1",processingAllowed:true,publicTextReviews:reviews}),
      loadCheckpoint:async()=>null,saveCheckpoint:async()=>{saves++;return "applied";},discardCheckpoint:async()=>{discards++;return "applied";},publish:async()=>assert.fail(),markInsufficient:async()=>assert.fail()};
    const result=await runReviewSummaryStep(job,{repository,model,safety:{check:async()=>true},workerRunToken:id(13),
      settings:{maxInputChars:12000,maxReviewsPerChunk:2,mergeFanIn:4,maxOutputTokens:800,maxOutputChars:300,maxCallsPerStep:3},versions:{modelVersion:job.modelVersion,promptVersion:job.promptVersion}});
    assert.equal(result.status,denial==="lease_lost"?"lease_lost":"superseded");
    assert.equal(providerCalls,0);assert.equal(saves,0);assert.equal(discards,denial==="lease_lost"?0:1);
    assert.equal(calls.length,1);assert.equal(calls[0].name,"reserve_review_summary_model");
    assert.equal(calls[0].args.p_job_id,job.jobId);assert.equal(calls[0].args.p_lease_token,job.leaseToken);
    assert.equal(calls[0].args.p_worker_run_token,id(13));assert.equal(calls[0].args.p_source_revision,"1");
    assert.equal(calls[0].args.p_target_user_id,job.targetUserId);assert.equal(calls[0].args.p_contract_version,"2026-10-05");
    assert.deepEqual(calls[0].args.p_source_review_ids,reviews.map(r=>r.evidenceId),"현재 전체 근거를 원자 검사");
    assert.equal(JSON.stringify(calls).includes("합성 공개 후기"),false,"예약에 원문을 보관하지 않는다");
  }
});

test("요약 최종 처리 허가 RPC 미지원·범위 누락은 generic 예산 예약으로 우회하지 않는다",async()=>{
  const summaryRequest={jobId:id(10),leaseToken:id(11),targetUserId:id(12),sourceRevision:"1",workerRunToken:id(13),
    modelVersion:"synthetic",promptVersion:REVIEW_SUMMARY_PROMPT_VERSION,sourceReviewIds:[id(20),id(21),id(22)]};
  let providerCalls=0;const names=[];
  const budget=createRpcModelBudget({rpc:async name=>{names.push(name);throw new Error("RPC_NOT_SUPPORTED");}},{ledgerId:"synthetic",promptOverheadBytes:0});
  const router=createModelRouter({primary:{id:"synthetic",retentionReview:{status:"approved",decisionId:"synthetic"},model:{generate:async()=>{providerCalls++;assert.fail();}}},budget});
  const req={task:"review_chunk",system:"s",input:{reviews:[]},maxOutputTokens:800};
  await assert.rejects(router.generate({...req,summaryRequest}),/MODEL_UNAVAILABLE/);
  assert.deepEqual(names,["reserve_review_summary_model"]);assert.equal(providerCalls,0);
  await assert.rejects(router.generate(req),/MODEL_UNAVAILABLE/);
  assert.equal(names.length,1,"누락 범위는 RPC 전 거부");
  await assert.rejects(router.generate({...req,summaryRequest,memberRequest:scope}),/MODEL_UNAVAILABLE/);
  assert.equal(names.length,1,"두 종류의 처리 허가를 섞지 않는다");
});


test("요약 원자 예약 허가를 받은 호출은 기존 예약 정산을 사용하며 범위를 내부 모델 포트에 그대로 연결한다",async()=>{
  const summaryRequest={jobId:id(10),leaseToken:id(11),targetUserId:id(12),sourceRevision:"1",workerRunToken:id(13),
    modelVersion:"synthetic",promptVersion:REVIEW_SUMMARY_PROMPT_VERSION,sourceReviewIds:[id(20),id(21),id(22)]};
  const calls=[];let received;
  const budget=createRpcModelBudget({rpc:async(name,args)=>{calls.push({name,args});return name==="reserve_review_summary_model"?{reservationId:id(4)}:{settled:true};}},{ledgerId:"synthetic",promptOverheadBytes:0});
  const router=createModelRouter({primary:{id:"synthetic",retentionReview:{status:"approved",decisionId:"synthetic"},model:{generate:async r=>{received=r;return response({claims:[]});}}},budget});
  await router.generate({task:"review_chunk",system:"s",input:{reviews:[]},maxOutputTokens:800,summaryRequest});
  assert.equal(received.summaryRequest,summaryRequest);
  assert.deepEqual(calls.map(c=>c.name),["reserve_review_summary_model","settle_ai_budget"]);
  assert.equal(calls[1].args.p_outcome,"usage_unknown");
});

test("요약 최종 허가 RPC 준비 확인은 없는 작업을 사용하며 미허용·구계약 응답을 ready로 숨기지 않는다",async()=>{
  let seen;
  const denied=await probeSummaryWorkerRpcs({rpc:async(name,args)=>{seen={name,args};throw new HttpError("ACCESS_DENIED");}});
  assert.equal(denied,"DB_RPC_NOT_ALLOWED");assert.equal(seen.name,"reserve_review_summary_model");
  assert.equal(seen.args.p_job_id,"00000000-0000-0000-0000-000000000000");
  assert.equal(seen.args.p_worker_run_token,seen.args.p_job_id);
  assert.equal(seen.args.p_contract_version,"2026-10-05");
  assert.equal(await probeSummaryWorkerRpcs({rpc:async()=>({reservationId:id(4)})}),"DB_RPC_UNAVAILABLE","준비 확인에서 예약 생성 응답은 거부");
});
