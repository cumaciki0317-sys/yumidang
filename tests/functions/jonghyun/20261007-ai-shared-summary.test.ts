import assert from "node:assert/strict";import test from "node:test";
import {createReviewSummaryWorkerExecution,REVIEW_SUMMARY_WORKER_ENV} from "../../../backend/supabase/functions/review-summary-worker/index.ts";
import {HttpError} from "../../../backend/supabase/functions/_shared/http/errors.ts";
const token="11111111-1111-4111-8111-111111111111",at="2026-10-07T00:00:00Z";
const base={SUPABASE_URL:"https://project.example.invalid",SUPABASE_ANON_KEY:"synthetic-anon",SUPABASE_SERVICE_ROLE_KEY:"synthetic-service",INTERNAL_WORKER_SECRET:"synthetic_"+"x".repeat(32),ALLOWED_ORIGINS:"[]",UPSTREAM_TIMEOUT_MS:"1000",MAX_REQUEST_BYTES:"1024",REVIEW_SUMMARY_MODEL_VERSION:"potens.claude-5-sonnet",REVIEW_SUMMARY_PROMPT_VERSION:"review-summary-v1"};
const settings=Object.fromEntries(Object.values(REVIEW_SUMMARY_WORKER_ENV).map(key=>[key,"5"]));Object.assign(settings,{REVIEW_SUMMARY_LEASE_SECONDS:"180",REVIEW_SUMMARY_WORKER_TIME_BUDGET_MS:"1000",REVIEW_SUMMARY_MAX_INPUT_CHARS:"12000",REVIEW_SUMMARY_MAX_OUTPUT_CHARS:"300",REVIEW_SUMMARY_MERGE_FAN_IN:"4",REVIEW_SUMMARY_MAX_CALLS_PER_STEP:"3",REVIEW_SUMMARY_RETRY_MAX_ATTEMPTS:"3",REVIEW_SUMMARY_RETRY_BASE_DELAY_MS:"600000",REVIEW_SUMMARY_RETRY_MAX_DELAY_MS:"21600000",REVIEW_SUMMARY_BUDGET_DEFER_MS:"3600000"});
function setup(onRpc?:(name:string)=>void, jobs=false){const calls:{name:string;args:any}[]=[],env:Record<string,string>={...base,...settings};let elapsed=0;
 const run=createReviewSummaryWorkerExecution(key=>env[key],{elapsedMs:()=>elapsed,now:()=>new Date(at),privacy:{decisionId:"synthetic",async check(){return true}},safety:{async check(){return true}},createModel:()=>({status:"ready",modelVersion:base.REVIEW_SUMMARY_MODEL_VERSION,model:{async generate(){throw Error("no model")}}}),createDb:()=>({async rpc(name,args){calls.push({name,args});onRpc?.(name);if(name==="acquire_worker_run")return{token,expiresAt:"2026-10-07T00:03:00Z"};if(name==="claim_job")return{job:jobs?{jobId:token,kind:"review_summary",payload:{profileId:token,sourceRevision:"1",modelVersion:base.REVIEW_SUMMARY_MODEL_VERSION,promptVersion:base.REVIEW_SUMMARY_PROMPT_VERSION},leaseToken:token,leaseExpiresAt:"2026-10-07T00:03:00Z",attempt:1,failedAttempts:0}:null};
 if(name==="load_review_summary_source"&&args.p_job_id===token)return{status:"already_published"};if(name==="complete_job")return{jobId:token,status:"succeeded"};if(["yield_job","fail_job","supersede_job"].includes(name))throw new HttpError("STATE_CONFLICT");return{status:"lease_lost"};}})});
 return{run,calls,advance:(ms:number)=>{elapsed+=ms;}};
}
test("shared invalid/zero/aborted limits do not probe/acquire/claim",async()=>{
 for(const opts of [{maxJobsPerRun:0,timeBudgetMs:20,signal:new AbortController().signal},{maxJobsPerRun:2,timeBudgetMs:0,signal:new AbortController().signal},{maxJobsPerRun:-1,timeBudgetMs:20,signal:new AbortController().signal},{maxJobsPerRun:2,timeBudgetMs:20,signal:AbortSignal.abort()}]){const s=setup();await s.run(token,opts);assert.equal(s.calls.length,0);}
 const s=setup();await s.run(undefined,{maxJobsPerRun:2,timeBudgetMs:20,signal:new AbortController().signal});assert.equal(s.calls.length,0);
});
test("shared execution validates existing token and never acquires a fresh/release token",async()=>{
 const s=setup();const result=await s.run(token,{maxJobsPerRun:1,timeBudgetMs:20,signal:new AbortController().signal});assert.equal(result.status,"ran");
 assert.deepEqual(s.calls.find(c=>c.name==="acquire_worker_run")?.args,{p_lease_seconds:180,p_existing_token:token});
 assert.equal(s.calls.filter(c=>c.name==="acquire_worker_run").length,1);assert.equal(s.calls.filter(c=>c.name==="release_worker_run").length,0);assert.equal(s.calls.filter(c=>c.name==="claim_job").length,1);
});
test("external cancellation during probes prevents token validation and claim",async()=>{
 const controller=new AbortController();const s=setup(name=>{if(name==="load_review_summary_source")controller.abort();});await s.run(token,{maxJobsPerRun:2,timeBudgetMs:20,signal:controller.signal});assert.equal(s.calls.filter(c=>c.name==="acquire_worker_run"||c.name==="claim_job").length,0);
});
test("probe elapsed time consumes shared budget before acquiring",async()=>{
 let s:ReturnType<typeof setup>;s=setup(name=>{if(name==="load_review_summary_source")s.advance(25);});const result=await s.run(token,{maxJobsPerRun:2,timeBudgetMs:20,signal:new AbortController().signal});assert.equal(result.status,"ran");assert.equal(s.calls.filter(c=>c.name==="acquire_worker_run"||c.name==="claim_job").length,0);
});

test("shared maxJobs=1 stops after one claimed existing summary without token release",async()=>{
 const s=setup(undefined,true),result=await s.run(token,{maxJobsPerRun:1,timeBudgetMs:50,signal:new AbortController().signal});
 assert.equal(result.status,"ran");if(result.status!=="ran")return;
 assert.equal(result.stopReason,"max_jobs");assert.equal(result.counts.claimed,1);assert.equal(result.counts.succeeded,1);
 assert.equal(s.calls.filter(c=>c.name==="claim_job").length,1);assert.equal(s.calls.filter(c=>c.name==="release_worker_run").length,0);
});

test("fractional monotonic elapsed preserves integer batch budget",async()=>{
 let s:ReturnType<typeof setup>;s=setup(name=>{if(name==="load_review_summary_source")s.advance(0.5);});const result=await s.run(token,{maxJobsPerRun:2,timeBudgetMs:20,signal:new AbortController().signal});assert.equal(result.status,"ran");
});

test("prior success 뒤 external abort/late success는 aggregate 성공 응답이 되지 않음",async()=>{
 const controller=new AbortController();let completed=0;
 const s=setup(name=>{if(name==="complete_job"&&++completed===2)controller.abort();},true);
 await assert.rejects(s.run(token,{maxJobsPerRun:3,timeBudgetMs:50,signal:controller.signal}),{message:"SHARED_SUMMARY_EXECUTION_UNKNOWN"});
 assert.equal(completed,2);assert.equal(s.calls.filter(c=>c.name==="release_worker_run").length,0);
});
test("prior success 뒤 외부 runOne 예외는 batch dependency_unavailable로 삼켜지지 않음",async()=>{
 let claimed=0;const s=setup(name=>{if(name==="claim_job"&&++claimed===2)throw Error("synthetic lost claim");},true);
 await assert.rejects(s.run(token,{maxJobsPerRun:3,timeBudgetMs:50,signal:new AbortController().signal}),{message:"SHARED_SUMMARY_EXECUTION_UNKNOWN"});
 assert.equal(claimed,2);assert.equal(s.calls.filter(c=>c.name==="release_worker_run").length,0);
});
