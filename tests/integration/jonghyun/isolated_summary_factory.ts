/** Fresh SQL119 portability scope. Product execution factory, real RPC and SQL109
 * dispatch; model/privacy/safety are explicit synthetic adapters. Old source112,
 * gateway/Auth deployment and private source evidence are NOT_RUN. */
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const check=(v:unknown,code:string)=>{if(!v)throw new Error('SUMMARY_CHECK_'+code);};
async function main(){
 check(process.argv.length===3,'ARGUMENTS');
 const f=JSON.parse(readFileSync(process.argv[2],'utf8'));
 check(f.scope==='CURRENT119_SUMMARY14_SYNTHETIC'&&new URL(f.origin).hostname==='127.0.0.1','SCOPE');
 for(const [file,sha]of Object.entries(f.manifest))check(createHash('sha256').update(readFileSync(f.codeRoot+'/'+file)).digest('hex')===sha,'SOURCE_PIN');
 const native=globalThis.fetch;let externalAttempts=0,modelCalls=0;
 const local=async(path:string,body:any)=>{
  const response=await native(f.origin+path,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer synthetic-service'},body:JSON.stringify(body)});
  check(response.status===200,'BRIDGE_RESPONSE');return response.json();
 };
 globalThis.fetch=async(input:any,init?:RequestInit)=>{
  const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(u.origin!==f.origin){externalAttempts++;throw new Error('SUMMARY_NATIVE_EXTERNAL_FORBIDDEN');}
  return native(input,{...init,redirect:'error'});
 };
 try{
  const {createReviewSummaryWorkerExecution}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/review-summary-worker/index.ts').href);
  const {REVIEW_SUMMARY_PROMPT_VERSION}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/_shared/ai/Agents/review-summary/prompts.ts').href);
  const {HttpError}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/_shared/http/errors.ts').href);
  const env:Record<string,string>={SUPABASE_URL:f.origin,SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',INTERNAL_WORKER_SECRET:'synthetic_summary_internal_secret_32_chars',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'10000',REVIEW_SUMMARY_MODEL_VERSION:'synthetic-summary-v1',REVIEW_SUMMARY_PROMPT_VERSION,
   REVIEW_SUMMARY_WORKER_MAX_JOBS_PER_RUN:'1',REVIEW_SUMMARY_WORKER_TIME_BUDGET_MS:'60000',REVIEW_SUMMARY_LEASE_SECONDS:'180',REVIEW_SUMMARY_RETRY_MAX_ATTEMPTS:'3',REVIEW_SUMMARY_RETRY_BASE_DELAY_MS:'600000',REVIEW_SUMMARY_RETRY_MAX_DELAY_MS:'21600000',REVIEW_SUMMARY_BUDGET_DEFER_MS:'3600000',REVIEW_SUMMARY_MAX_INPUT_CHARS:'12000',REVIEW_SUMMARY_MAX_REVIEWS_PER_CHUNK:'2',REVIEW_SUMMARY_MERGE_FAN_IN:'2',REVIEW_SUMMARY_MAX_OUTPUT_TOKENS:'200',REVIEW_SUMMARY_MAX_OUTPUT_CHARS:'300',REVIEW_SUMMARY_MAX_CALLS_PER_STEP:'3'};
  let reached!:()=>void,release!:()=>void,held=false,barrierUsed=false,observedScope:any;
  const scopedCounts:Record<string,Record<string,number>>={};const readinessCounts:Record<string,number>={};
  const returnedStatuses:Record<string,Record<string,Record<string,number>>>={};
  const leases:Record<string,string>={};let latest:any;
  let latestJobId:string|undefined;
  const arrived=new Promise<void>(r=>{reached=r;}),released=new Promise<void>(r=>{release=()=>{held=false;r();};});
  const db={supportsRpc:(name:string)=>f.rpcs.includes(name),async rpc(name:string,args:any){
   check(f.rpcs.includes(name),'RPC_ALLOWLIST');
   if(args.p_job_id==='00000000-0000-0000-0000-000000000000')readinessCounts[name]=(readinessCounts[name]??0)+1;
   else if(args.p_job_id){
    check(args.p_job_id===f.jobId||args.p_job_id===latestJobId,'COUNTED_OWN_JOB_ONLY');
    const counts=scopedCounts[args.p_job_id]??={};counts[name]=(counts[name]??0)+1;
   }
   if(name==='mark_review_summary_insufficient'&&args.p_job_id!=='00000000-0000-0000-0000-000000000000')check(latest&&args.p_job_id===latest.jobId&&args.p_source_revision===latest.sourceRevision&&args.p_worker_run_token===latest.runToken&&args.p_lease_token===leases[latest.jobId]&&args.p_contract_version==='2026-10-05','INSUFFICIENT_MARK_EXACT_SCOPE');
   const selected=f.phase==='checkpoint'?'save_review_summary_checkpoint':'publish_review_summary_for_job';
   if(!barrierUsed&&name===selected&&args.p_job_id===f.jobId){
    barrierUsed=true;held=true;observedScope={jobId:args.p_job_id,leaseToken:args.p_lease_token,workerRunToken:args.p_worker_run_token,sourceRevision:args.p_source_revision,contractVersion:args.p_contract_version,parent:f.requestId};
    reached();await released;
   }
   const response=await native(f.origin+'/rpc/'+name,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer synthetic-service'},body:JSON.stringify(args)});
   const value=await response.json();
   if(response.status===409&&value.code==='STATE_CONFLICT')throw new HttpError('STATE_CONFLICT');
   check(response.status===200,'REAL_RPC_RESPONSE');
   if((name==='claim_job'||name==='claim_supported_job')&&value.job)leases[value.job.jobId]=value.job.leaseToken;
   if(args.p_job_id&&args.p_job_id!=='00000000-0000-0000-0000-000000000000'&&typeof value.status==='string'){
    const job=returnedStatuses[args.p_job_id]??={};const statuses=job[name]??={};statuses[value.status]=(statuses[value.status]??0)+1;
   }
   return value;
  }};
  const allowed=new Set(['합성 검증 중간 요약','합성 검증 최종 요약']);
  const run=createReviewSummaryWorkerExecution((key:string)=>env[key],{createDb:()=>db,
   createModel:()=>({status:'ready',modelVersion:'synthetic-summary-v1',usageIncludesAllAttempts:true,model:{async generate(request:any){
    modelCalls++;check(request.summaryRequest.workerRunToken===f.runToken,'MODEL_FENCE');
    const source=request.task==='review_chunk'?request.input.reviews:request.task==='review_merge'?request.input.summaries:null;
    check(Array.isArray(source)&&source.length>0,'MODEL_SOURCE');
    if(request.task==='review_chunk')check(source.every((r:any)=>f.reviewIds.includes(r.evidenceId)&&r.comment===f.comment),'RAW_SYNTHETIC_ONLY');
    else check(source.every((r:any)=>/^group-[0-9]+$/.test(r.evidenceId)&&allowed.has(r.text)),'MERGE_SYNTHETIC_ONLY');
    return {value:{claims:[{text:request.task==='review_chunk'?'합성 검증 중간 요약':'합성 검증 최종 요약',evidenceIds:source.map((r:any)=>r.evidenceId)}]},modelVersion:'synthetic-summary-v1',usage:null};
   }}}),privacy:{decisionId:'synthetic-local-only',check:async()=>true},
   safety:{async check(input:any){const ids=new Set(input.publicTextReviews.map((r:any)=>r.evidenceId));return input.publicTextReviews.every((r:any)=>f.reviewIds.includes(r.evidenceId)&&r.comment===f.comment)&&input.claims.length>0&&input.claims.every((c:any)=>allowed.has(c.text)&&c.evidenceIds.length>0&&c.evidenceIds.every((id:string)=>ids.has(id)));}}});
  const external={maxJobsPerRun:1,timeBudgetMs:60000,signal:new AbortController().signal};
  const running=run(f.runToken,external);
  // Both the active worker and committed mutation use distinct SQL connections.
  // A held promise prevents checkpoint/publish until the second connection proves
  // revision invalidation with the same unexpired invocation/lease/fence scope.
  let timer:any;try{
   await Promise.race([arrived,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SUMMARY_BARRIER_TIMEOUT')),15000);})]);
   check(held&&barrierUsed,'BARRIER_HELD');
   await local('/control/mutate',{scope:observedScope});check(held,'MUTATION_WHILE_HELD');
  }finally{clearTimeout(timer);release();}
  const result=await running;
  check(result.status==='ran'&&result.counts.claimed===1&&result.counts.superseded===1&&result.counts.failed===0&&result.counts.succeeded===0,'SUPERSEDED_RESULT');
  const selected=f.phase==='checkpoint'?'save_review_summary_checkpoint':'publish_review_summary_for_job';
  check(scopedCounts[f.jobId]?.[selected]===1&&returnedStatuses[f.jobId]?.[selected]?.stale_revision===1,'RACE_SELECTED_WIRE_ONCE_STALE_ONCE');
  if(f.phase==='checkpoint')check((scopedCounts[f.jobId]?.publish_review_summary_for_job??0)===0,'CHECKPOINT_RACE_NO_PUBLISH');
  await local('/control/complete',{requestId:f.requestId,result});
  let insufficient=false;
  if(f.mutation!=='edit'){
   const next=await local('/control/insufficient',{});latest=next;latestJobId=next.jobId;const before=modelCalls;
   const finished=await run(next.runToken,external);
   check(finished.status==='ran'&&finished.counts.claimed===1&&finished.counts.succeeded===1&&finished.counts.superseded===0&&finished.counts.failed===0&&modelCalls===before,'INSUFFICIENT_NO_MODEL');
   const counts=scopedCounts[next.jobId]??{};
   check(counts.mark_review_summary_insufficient===1,'INSUFFICIENT_MARK_ONCE');
   check(returnedStatuses[next.jobId]?.mark_review_summary_insufficient?.applied===1,'INSUFFICIENT_MARK_APPLIED_ONCE');
   for(const name of ['load_review_summary_checkpoint','save_review_summary_checkpoint','discard_review_summary_checkpoint','publish_review_summary_for_job','reserve_review_summary_model'])check((counts[name]??0)===0,'INSUFFICIENT_NO_'+name.toUpperCase());
   await local('/control/complete',{requestId:next.requestId,result:finished});insufficient=true;
  }
  await local('/control/prove',{insufficient,modelCalls});
  check(externalAttempts===0,'EXTERNAL_ZERO');
  console.log(JSON.stringify({status:'PASS',mutation:f.mutation,phase:f.phase,races:1,insufficient:Number(insufficient),modelCalls,externalAttempts,scopedCounts:Object.values(scopedCounts),readinessCounts,scope:f.scope,originalSource112PrivateEvidence:'NOT_RUN',realAuthConsentFiveJwtNegativeControls:'NOT_RUN',realAuthGatewayProviderBudgetSafetyApproval:'NOT_RUN'}));
 }finally{globalThis.fetch=native;}
}
try{await main();}catch(error){
 const message=error instanceof Error?error.message:'';
 const code=/^(?:SUMMARY_CHECK_[A-Z0-9_]+|SUMMARY_BARRIER_TIMEOUT)$/.test(message)?message:'ISOLATED_SUMMARY_CONTRACT_FAILED';
 console.log(JSON.stringify({status:'FAIL',code}));process.exitCode=1;
}
