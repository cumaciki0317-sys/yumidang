/** 정책11·14와 현재 검색 계약의 환경 상한. 실제 공급사/운영 설정 검증은 아니다. */
import test from "node:test";
import assert from "node:assert/strict";
import {AI_CHAT_ENV,loadAiChatSettings} from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/settings.ts";
import {createReviewSummaryWorkerRuntime,loadWorkerSettings,REVIEW_SUMMARY_WORKER_ENV} from "../../../backend/supabase/functions/review-summary-worker/index.ts";
import {REVIEW_SUMMARY_PROMPT_VERSION} from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/prompts.ts";
const read=env=>key=>env[key];
const chatValues={maxMessages:20,maxMessageChars:500,maxTotalChars:4000,maxOutputTokens:800,pageSize:10,maxSearchPages:3,
 recheckMaxPages:3,maxResultCards:5,matchBatchSize:5,maxMatchCalls:3,matchMaxOutputTokens:600};
const chatEnv=Object.fromEntries(Object.entries(chatValues).map(([key,value])=>[AI_CHAT_ENV[key],String(value)]));
const workerValues={maxJobsPerRun:10,timeBudgetMs:60000,leaseSeconds:180,retryMaxAttempts:3,retryBaseDelayMs:600000,
 retryMaxDelayMs:21600000,budgetDeferMs:3600000,maxInputChars:12000,maxReviewsPerChunk:20,mergeFanIn:4,
 maxOutputTokens:800,maxOutputChars:300,maxCallsPerStep:3};
const workerEnv=Object.fromEntries(Object.entries(workerValues).map(([key,value])=>[REVIEW_SUMMARY_WORKER_ENV[key],String(value)]));
test("탐색 환경은 확정 상한에서 시작하고 각 한도를 하나라도 넘으면 초기 설정에서 거절한다",()=>{
 const allowed=loadAiChatSettings(read(chatEnv));
 assert.equal(allowed.limits.maxOutputTokens,800);assert.equal(allowed.discovery.pageSize,10);
 for(const [key,max] of Object.entries(chatValues)){
  assert.throws(()=>loadAiChatSettings(read({...chatEnv,[AI_CHAT_ENV[key]]:String(max+1)})),/SETTING_NOT_CONFIGURED/,key);
 }
});
test("탐색 max 설정은 낮은 양수 허용·누락/0/비정수는 거부하며 기본값을 만들지 않는다",()=>{
 const lower=Object.fromEntries(Object.keys(chatEnv).map(key=>[key,"1"]));
 assert.equal(loadAiChatSettings(read(lower)).discovery.maxMatchCalls,1);
 for(const key of Object.keys(chatEnv))for(const bad of [undefined,"0","1.5","-1"]){
  assert.throws(()=>loadAiChatSettings(read({...chatEnv,[key]:bad})),/SETTING_NOT_CONFIGURED/);
 }
});
test("요약 설정은 확정 상한에서만 시작하고 모든 환경 상한 초과를 거부한다",()=>{
 const settings=loadWorkerSettings(read(workerEnv));assert.equal(typeof settings,"object");
 assert.equal(settings.leaseSeconds,180);assert.equal(settings.summary.maxOutputChars,300);
 for(const [key,max] of Object.entries(workerValues)){
  assert.equal(loadWorkerSettings(read({...workerEnv,[REVIEW_SUMMARY_WORKER_ENV[key]]:String(max+1)})),"WORKER_NOT_CONFIGURED",key);
 }
});
test("요약 점유180초/첫재시도10분/예산1시간은 고정이며 낮은값도 임의로 쓰지 않는다",()=>{
 for(const key of ["leaseSeconds","retryBaseDelayMs","budgetDeferMs"]){
  assert.equal(loadWorkerSettings(read({...workerEnv,[REVIEW_SUMMARY_WORKER_ENV[key]]:String(workerValues[key]-1)})),"WORKER_SETTINGS_INVALID",key);
 }
});
test("요약 max의 낮은값은 허용하되 병합최소2와 retry 간격 관계는 유지한다",()=>{
 const lower={...workerEnv};
 for(const key of ["maxJobsPerRun","timeBudgetMs","retryMaxAttempts","maxInputChars","maxReviewsPerChunk","maxOutputTokens","maxOutputChars","maxCallsPerStep"]){lower[REVIEW_SUMMARY_WORKER_ENV[key]]="1";}
 lower[REVIEW_SUMMARY_WORKER_ENV.mergeFanIn]="2";lower[REVIEW_SUMMARY_WORKER_ENV.retryMaxDelayMs]="600000";
 assert.equal(typeof loadWorkerSettings(read(lower)),"object");
 assert.equal(loadWorkerSettings(read({...lower,[REVIEW_SUMMARY_WORKER_ENV.mergeFanIn]:"1"})),"WORKER_SETTINGS_INVALID");
 assert.equal(loadWorkerSettings(read({...lower,[REVIEW_SUMMARY_WORKER_ENV.retryMaxDelayMs]:"599999"})),"WORKER_SETTINGS_INVALID");
});
test("요약 상한 초과는 모델 준비 확인·DB생성·작업 점유 전에 not_enabled로 중단한다",async()=>{
 const secret="synthetic_"+"b".repeat(32);
 const base={SUPABASE_URL:"https://project.example.invalid",SUPABASE_ANON_KEY:"synthetic-anon",SUPABASE_SERVICE_ROLE_KEY:"synthetic-service",
  INTERNAL_WORKER_SECRET:secret,ALLOWED_ORIGINS:"[]",UPSTREAM_TIMEOUT_MS:"1000",MAX_REQUEST_BYTES:"1024",
  REVIEW_SUMMARY_MODEL_VERSION:"synthetic",REVIEW_SUMMARY_PROMPT_VERSION:REVIEW_SUMMARY_PROMPT_VERSION};
 for(const [key,max] of Object.entries(workerValues)){
  let db=0,model=0;
  const handler=createReviewSummaryWorkerRuntime(read({...base,...workerEnv,[REVIEW_SUMMARY_WORKER_ENV[key]]:String(max+1)}),
   {createDb:()=>{db++;assert.fail("상한 검사 전 DB 생성 금지");},createModel:()=>{model++;assert.fail("상한 검사 전 모델 생성 금지");}});
  const response=await handler(new Request("https://synthetic.invalid/review-summary-worker",{method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:"{}"}));
  assert.equal(response.status,200);const body=await response.json();assert.equal(body.data.status,"not_enabled");
  assert.equal(body.data.reason,"WORKER_NOT_CONFIGURED");assert.equal(db,0);assert.equal(model,0);
 }
});
