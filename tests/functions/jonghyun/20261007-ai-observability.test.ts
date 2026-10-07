import assert from "node:assert/strict";import test from "node:test";
import {createMetricsRecorder} from "../../../backend/supabase/functions/_shared/observability/metrics.ts";
import {beginAiObservation} from "../../../backend/supabase/functions/_shared/ai/providers/observability.ts";
import {createAiChatHandler} from "../../../backend/supabase/functions/ai-chat/handler.ts";
import {createReviewSummaryWorkerExecution} from "../../../backend/supabase/functions/review-summary-worker/index.ts";
const body={clientRequestId:"private-client",messages:[{role:"user",content:"PRIVATE_ORIGINAL 전시"}],currentFilters:{target:"posts",region:"서울특별시"}};
const request=()=>new Request("https://synthetic.invalid/ai-chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
function recorder(write:(record:any)=>Promise<void>){return createMetricsRecorder({sink:{write},modelVersions:["synthetic","other"],promptVersions:["review-summary-v1"]});}
function handler(metrics:any,ready=false,privacy?:any,onGenerate?:()=>void,usageIncludesAllAttempts?:boolean){return createAiChatHandler({metrics,allowedOrigins:[],maxBodyBytes:4096,authenticate:async()=>({userId:"PRIVATE_MEMBER"}),engine:ready?{status:"ready",privacy,usageIncludesAllAttempts,model:{async generate(){onGenerate?.();return{value:{status:"search",filters:{target:"posts",region:"서울특별시"}},modelVersion:"synthetic",usage:{inputTokens:2,outputTokens:3}};}},limits:{maxMessages:6,maxMessageChars:500,maxTotalChars:1000,maxOutputTokens:100},now:()=>new Date("2026-10-07T00:00:00Z")}:{status:"unavailable",code:"synthetic"},openSession:()=>({loadPreferences:async()=>({}),discovery:{search:async()=>({cards:[],coverage:"exhausted"})}})});}
test("AI HTTP ready/unavailable 기록은 실제정형 결과·확인usage만; 원문/회원ID0",async()=>{
 for(const ready of [false,true]){const records:any[]=[];const response=await handler(recorder(async record=>{records.push(record)}),ready)(request());assert.equal(response.status,200);assert.equal(records.length,1);assert.equal(records[0].feature,"ai_chat");assert.equal(records[0].resultCode,ready?"EMPTY":"UNAVAILABLE");assert.equal(JSON.stringify(records).includes("PRIVATE"),false);assert.equal(JSON.stringify(records).includes("private-client"),false);if(ready)assert.deepEqual(records[0].usage,{inputTokens:2,outputTokens:3});else assert.equal(Object.hasOwn(records[0],"usage"),false);}
});
test("sink failure/무응답와 recorder 시작 예외는 응답 지연/변경 없음",async()=>{
 for(const metrics of [recorder(async()=>{throw Error("PRIVATE raw sink")}),recorder(async()=>new Promise(()=>{})),{begin(){throw Error("PRIVATE begin")}}]){
 let timer:any;const timed=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("product delayed")),100)});try{const response=await Promise.race([handler(metrics)(request()),timed]) as Response;assert.equal(response.status,200);}finally{clearTimeout(timer)}
 }
});
test("AI observer는 사용량 불명/실패호출/mixedmodel이면 totalusage 기록 안함",async()=>{
 for(const kind of ["unknown","failed","mixed"]){const records:any[]=[],observation=beginAiObservation(recorder(async r=>{records.push(r)}),"ai_chat");observation.response({value:{private:"ignored"},modelVersion:"synthetic",usage:{inputTokens:2,outputTokens:3}});if(kind==="failed")observation.modelUnknown();else observation.response({value:null,modelVersion:kind==="mixed"?"other":"synthetic",usage:kind==="unknown"?null:{inputTokens:2,outputTokens:3}});observation.finish("UNAVAILABLE");await Promise.resolve();assert.equal(records.length,1);assert.equal(Object.hasOwn(records[0],"usage"),false);if(kind==="mixed")assert.equal(Object.hasOwn(records[0],"modelVersion"),false);}
});
test("AI observer는 한번만 기록하고 확인usage를 합산",async()=>{
 const records:any[]=[],observation=beginAiObservation(recorder(async r=>{records.push(r)}),"review_summary","review-summary-v1");for(let i=0;i<2;i++)observation.response({value:{private:"ignored"},modelVersion:"synthetic",usage:{inputTokens:2,outputTokens:3}});observation.finish("SUCCESS");observation.finish("FAILED");await Promise.resolve();assert.equal(records.length,1);assert.deepEqual(records[0].usage,{inputTokens:4,outputTokens:6});assert.equal(records[0].retryCount,0);
});
test("요약 execution 미설정 관측도 원문없이 단일 outcome",async()=>{
 const records:any[]=[],env:Record<string,string>={SUPABASE_URL:"https://synthetic.invalid",SUPABASE_ANON_KEY:"synthetic-anon",SUPABASE_SERVICE_ROLE_KEY:"synthetic-service",INTERNAL_WORKER_SECRET:"synthetic_"+"x".repeat(32),ALLOWED_ORIGINS:"[]",UPSTREAM_TIMEOUT_MS:"1000",MAX_REQUEST_BYTES:"1024"};const run=createReviewSummaryWorkerExecution(key=>env[key],{metrics:recorder(async r=>{records.push(r)})});assert.deepEqual(await run(),{status:"not_enabled",reason:"WORKER_NOT_CONFIGURED"});assert.equal(records.length,1);assert.equal(records[0].feature,"review_summary");assert.equal(records[0].resultCode,"UNAVAILABLE");assert.equal(Object.hasOwn(records[0],"usage"),false);
});

test("입력 개인정보검사 await 중 취소하면 새로운 모델 전송0·관측 CANCELLED",async()=>{
 const controller=new AbortController(),records:any[]=[];let checked=0,sends=0;
 const privacy={decisionId:"synthetic",async check(){if(++checked===2)controller.abort();return true;}};
 const req=new Request("https://synthetic.invalid/ai-chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:controller.signal});
 await handler(recorder(async r=>{records.push(r)}),true,privacy,()=>{sends++;})(req);
 assert.equal(sends,0);assert.ok(checked>=2);assert.equal(records.length,1);assert.equal(records[0].resultCode,"CANCELLED");
});

test("내부 재시도 usage완전성 미확인 엔진은 최종 usage가 있어도 합계 생략",async()=>{
 const records:any[]=[];assert.equal((await handler(recorder(async r=>{records.push(r)}),true,undefined,undefined,false)(request())).status,200);assert.equal(records.length,1);assert.equal(Object.hasOwn(records[0],"usage"),false);
});
