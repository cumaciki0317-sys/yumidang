/** 격리된 실제 Node 두 프로세스·HTTPS·SQL 원증거를 검증한다.
 * 서버 승인은 전용 launcher의 고정값이며 제품 운영 승인을 뜻하지 않는다.
 * 5종 추가 시 제공사·모델·회원은 새 로컬 합성 fixture만 사용한다.
 */
import assert from 'node:assert/strict';
import {loadRuntimeConfig} from '../../../../minkyu-foundation/backend/supabase/functions/_shared/config/env.ts';
import {createInternalClient} from '../../../../minkyu-foundation/backend/supabase/functions/_shared/db/internal-client.ts';
import {createWorkerInvocationRuntime,createWorkerAtomicRuntime} from '../../../../minkyu-foundation/backend/supabase/functions/_shared/db/worker-runtime-client.ts';
import {createWorkerRunScope} from '../../../../minkyu-foundation/backend/supabase/functions/_shared/jobs/worker-run.ts';
import {createEventSyncRuntime} from '../../../../minkyu-foundation/backend/supabase/functions/event-sync/index.ts';
import {createReviewSummaryWorkerRuntime} from '../../../../minkyu-foundation/backend/supabase/functions/review-summary-worker/index.ts';
import {createRuntimeHandler} from '../../../../minkyu-foundation/backend/supabase/functions/service-api/index.ts';
import {createModelRouter} from '../../../../minkyu-foundation/backend/supabase/functions/_shared/ai/providers/provider-adapter.ts';
import {createRpcModelBudget} from '../../../../minkyu-foundation/backend/supabase/functions/_shared/ai/providers/budget.ts';
import {createConservativePrivacyCheck} from '../../../../minkyu-foundation/backend/supabase/functions/_shared/ai/providers/privacy.ts';
import type {ModelPort} from '../../../../minkyu-foundation/backend/supabase/functions/_shared/ai/providers/model-port.ts';
import {HttpError,toPublicError} from '../../../../minkyu-foundation/backend/supabase/functions/_shared/http/errors.ts';
assert.equal(Deno.args.length,4);assert.equal(Deno.args[0],'--scenario');assert.equal(Deno.args[2],'--revision');
const scenario=Deno.args[1],revision=Deno.args[3];
if(scenario==='legacy-observed-pending'){await legacyObservedMain(revision);Deno.exit(0);}
const summaryRaces:Record<string,{mutation:'edit'|'consent'|'hide'|'delete';phase:'checkpoint'|'publish';short:string}>={};
for(const[mutation,short]of [['edit','e'],['consent','c'],['hide','h'],['delete','d']]as const){
 for(const[phase,suffix]of [['checkpoint','c'],['publish','p']]as const)summaryRaces['five-kind-summary-'+mutation+'-'+phase]={mutation,phase,short:'summary-'+short+suffix};
}
const summaryRace=Object.hasOwn(summaryRaces,scenario)?summaryRaces[scenario]:undefined;
let summaryRaceCommitted=false,summaryRaceWireCalls=0;
const summaryRaceEvidence:{phase:string;mutation:string;status?:string;count?:number;revisionChanged?:boolean}[]=[];
const reviewLaneMode=['review-lease-reassignment','review-unsupported-due'].includes(scenario),reassignmentMode=scenario==='review-lease-reassignment';
const budgetMode=scenario==='cancellation-budget-maintenance',cancellationMode=['cancellation','cancellation-budget-maintenance','review-unsupported-due'].includes(scenario);
assert.ok(['cancellation','cancellation-budget-maintenance','review-lease-reassignment','review-unsupported-due','report-metadata','report-storage-success','report-storage-delete-loss','five-kind-smoke','five-kind-overflow','five-kind-response-loss','five-kind-storage-reconcile','five-kind-auth-reconcile','five-kind-retire-storage','five-kind-retire-auth',...Object.keys(summaryRaces)].includes(scenario));assert.match(revision,/^v[1-9][0-9]?$/);
const root='/private/tmp/yumidang-safety114-http-'+scenario+'-'+revision;
const f=JSON.parse(await Deno.readTextFile(root+'/connection-private.json'));
const shortScenario:Record<string,string>={'cancellation-budget-maintenance':'cancel-budget-maint',...Object.fromEntries(Object.entries(summaryRaces).map(([name,value])=>[name,value.short])),'five-kind-storage-reconcile':'five-storage-reconcile','five-kind-auth-reconcile':'five-auth-reconcile','five-kind-retire-storage':'five-retire-storage','five-kind-retire-auth':'five-retire-auth'};
assert.equal(f.clone,'yumidang-minkyu-safety114-http-'+(shortScenario[scenario]??scenario)+'-'+revision);assert.ok(f.clone.length<=63);
assert.equal(f.source,'yumidang-minkyu-invocation109-20261009-v1');
const harnessRepo=new URL('../../../',import.meta.url).pathname.replace(/\/$/,'');
const repo='/Users/minkyu/Documents/GitHub/yumidang/.worktrees/minkyu-foundation';
const controlPath=harnessRepo+'/tests/integration/minkyu/worker_safety_http_local.py';
const fiveMode=scenario.startsWith('five-kind-'),storageMode=scenario.startsWith('report-storage-')||fiveMode,deleteLoss=scenario==='report-storage-delete-loss';
const retirementMode=['five-kind-retire-storage','five-kind-retire-auth'].includes(scenario);
const recoveryKind:Record<string,string>={'five-kind-storage-reconcile':'storage_object','five-kind-auth-reconcile':'auth_user','five-kind-retire-storage':'storage_object','five-kind-retire-auth':'auth_user'};
const interruptedKind=recoveryKind[scenario];
const recoveryMode=Object.hasOwn(recoveryKind,scenario);
let interruptedOrigin:any;let blockedTaskComplete=0;let recoveryEvidence:any;
let automaticParentOnly=false;
const forceOperationLoss=(!fiveMode&&!budgetMode&&!reviewLaneMode)||scenario==='five-kind-response-loss';
const fullKinds=['review_summary','event_sync','member_cleanup','cancellation_safety','report_retention'];
const authConfig=fiveMode?JSON.parse(await Deno.readTextFile(root+'/auth-connection-private.json')):null;
let fixture:any;
let memberStorageDeleteCalls=0,memberAuthDeleteCalls=0,providerListCalls=0,providerDetailCalls=0,modelCalls=0,actualReservations=0;
// 합성 검증의 고정 단계·수치만 기록한다. 원 input/output·예외 메시지는 보존하지 않는다.
const modelDiagnostics:{stage:string;passed:boolean;count?:number}[]=[];
let publicSession:any;
let retirementCalls=0,retirementReceiptCalls=0,publicPostCalls=0,publicResponseLost=false,retirementAuthUnavailable=false;
const publicAuthStatuses:number[]=[];
const retirementEvidence:{phase:string;status?:number;count?:number;unchanged?:boolean;clientStatus?:number|'UNKNOWN';gatewayStatus?:number;lossAt?:'fetch'|'body'}[]=[];
const approvedSyntheticComment='대화가 편안했고 함께한 시간이 즐거웠어요.';
const approvedSyntheticSummary='세 후기에서 편안한 대화와 즐거운 시간을 공통으로 언급합니다.';
// 로컬 합성 의미만 검증한다. 실제 제공사·운영 의미 검사 승인을 대체하지 않는다.
function syntheticSummarySafe(input:unknown,approvedIds:readonly string[]):boolean{
 try{
  const value=input as {claims:{text:string;evidenceIds:string[]}[];publicTextReviews:{evidenceId:string;comment:string}[]};
  const keys=(item:unknown,expected:string[])=>Boolean(item&&typeof item==='object'&&!Array.isArray(item)&&JSON.stringify(Object.keys(item).sort())===JSON.stringify(expected.sort()));
  const same=(ids:string[])=>ids.length===3&&new Set(ids).size===3&&approvedIds.length===3&&new Set(approvedIds).size===3&&JSON.stringify([...ids].sort())===JSON.stringify([...approvedIds].sort());
  if(!keys(value,['claims','publicTextReviews'])||!Array.isArray(value.claims)||value.claims.length!==1||!Array.isArray(value.publicTextReviews)||value.publicTextReviews.length!==3)return false;
  const claim=value.claims[0];
  return keys(claim,['text','evidenceIds'])&&claim.text===approvedSyntheticSummary&&Array.isArray(claim.evidenceIds)&&same(claim.evidenceIds)&&
   value.publicTextReviews.every(review=>keys(review,['evidenceId','comment'])&&review.comment===approvedSyntheticComment)&&same(value.publicTextReviews.map(review=>review.evidenceId));
 }catch{return false;}
}
let rawCopyRejectionChecked=false;
function rejectedNullSafetyProbe(name:string,args:unknown,status:number,body:unknown):boolean{
 const contracts:Record<string,Record<string,null|string>>={
  prepare_worker_invocation_intent:{p_request_id:null,p_parent_invocation_id:null,p_operation:'job_claim',p_scope:null,p_predecessor_request_id:null},
  execute_worker_invocation_operation:{p_request_id:null,p_parent_request_id:null,p_global_token:null,p_operation:'job_claim',p_input:null},
  confirm_worker_runtime_intent:{p_request_id:null},
 };
 const exact=(value:unknown,keys:string[])=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort()));
 const expected=Object.hasOwn(contracts,name)?contracts[name]:undefined;
 if(!expected||status!==400||!exact(args,Object.keys(expected))||Object.entries(expected).some(([key,value])=>(args as Record<string,unknown>)[key]!==value))return false;
 const response=body as Record<string,unknown>;
 // SQLState만 안전 metadata로 보존한다. 오류 메시지·details/hint 원문은 저장하지 않는다.
 if(exact(response,['code','details','hint','message'])&&response.code==='22023'&&typeof response.message==='string'&&
  (response.details===null||typeof response.details==='string')&&(response.hint===null||typeof response.hint==='string'))return true;
 const error=response?.error as Record<string,unknown>;
 return exact(response,['error'])&&exact(error,['code','message','retryable'])&&error.code==='INVALID_REQUEST'&&error.retryable===false&&typeof error.message==='string';
}
const nilReserveProbes:string[]=[];
const globalLeaseProofs:any[]=[];
const actualFunctionCalls:any[]=[];
const memberAbsenceReads:{kind:string;absent:boolean}[]=[];
const memberLeaseProofs:any[]=[];
let functionHandlers:Record<string,(request:Request)=>Promise<Response>>={};
const storageConfig=storageMode?JSON.parse(await Deno.readTextFile(root+'/storage-connection-private.json')):null;
let deleteCalls=0;
let expectedJobs=reviewLaneMode?1:fiveMode?(scenario==='five-kind-overflow'?33:9):storageMode?1:20;
const kind=cancellationMode?'cancellation_safety':'report_retention';
await Deno.stat(repo+'/backend/node_modules/pg/package.json');
const client=Deno.createHttpClient({caCerts:[await Deno.readTextFile(root+'/ca.crt')]});
const realFetch=globalThis.fetch;
let externalCalls=0,lost=false,unexpectedRoutes=0,lostRequestId:string|null=null,lossLeaseMs:number|null=null;
interface Event {name:string;requestId:string|null;parent:string|null;token:string|null;operation:string|null;caller:string|null;claimed?:boolean;status?:string;forwarded?:boolean;resultState?:string;httpStatus?:number;publicCode?:string;sqlCode?:string;nullSafetyProbeRejected?:boolean;pending?:boolean;jobId?:string;sourceRevision?:string;nilYieldProbeRejected?:boolean}
const events:Event[]=[];
const recoveryReads=['get_queue_invocation','read_member_cleanup_unknown_invocations','read_worker_runtime_pending_v2','read_ai_feedback_maintenance_schedule','read_worker_runtime_maintenance_schedule'];
function recoveryObservationAllowed(event:Event,parent:string,allowBlockedAcquire=false):boolean{
 // exact NULL ABI와 실제 거절 응답의 검증 후 기록한 metadata만 사전검사로 분류한다.
 if(event.nullSafetyProbeRejected===true)return event.requestId===null&&event.parent===null&&event.token===null&&event.httpStatus===400&&
  ['prepare_worker_invocation_intent','execute_worker_invocation_operation','confirm_worker_runtime_intent'].includes(event.name)&&
  event.operation===(event.name==='confirm_worker_runtime_intent'?null:'job_claim')&&
  (event.sqlCode==='22023'&&event.publicCode===undefined||event.publicCode==='INVALID_REQUEST'&&event.sqlCode===undefined);
 return recoveryReads.includes(event.name)||event.name==='complete_queue_invocation'&&event.requestId===parent||
  allowBlockedAcquire&&event.name==='acquire_worker_run'&&event.forwarded===false;
}
async function control(action:string,signal?:AbortSignal){
 signal?.throwIfAborted();
 const output=await new Deno.Command('python3',{signal,args:[controlPath,action,'--scenario',scenario,'--revision',revision],cwd:repo,stdout:'piped',stderr:'piped'}).output();
 if(output.code!==0){await Deno.writeFile(root+'/control-failure-'+crypto.randomUUID()+'.log',new Uint8Array([...output.stdout,...output.stderr]),{mode:0o600,createNew:true});throw Error('ISOLATED_CONTROL_FAILED');}
 return new TextDecoder().decode(output.stdout);
}
const snapshot=async()=>JSON.parse(await control('--snapshot'));
const reviewLaneProof=async(signal?:AbortSignal)=>JSON.parse(await control('--review-lane-proof',signal));
const reviewClaims:{jobId:string;lease:string;parent:string;token:string;expiresAt:string}[]=[];
let oldLeaseFenceCalls=0;
function reviewClaimScope(job:any,proof:any,previous:typeof reviewClaims){
 assert.equal(job.jobId,fixture.jobId);assert.equal(job.kind,'review_summary');assert.equal(job.payload.sourceRevision,fixture.revision);
 assert.equal(proof.status,'running');assert.equal(proof.sourceRevision,fixture.revision);assert.equal(proof.currentLease,job.leaseToken);
 assert.equal(proof.slotRows,1);assert.equal(proof.parents.length,1);assert.equal(proof.audit.length,previous.length+1);
 const row=proof.parents[0],parent=row.stored,last=proof.audit.at(-1);
 assert.equal(parent.state,'prepared');assert.equal(parent.kind,'review_summary');assert.equal(parent.limit,10);
 assert.ok(parent.remainingMs>0&&parent.remainingMs<=60000);assert.ok(Date.parse(row.deadline)>Date.parse(proof.serverNow));
 assert.ok(Date.parse(row.deadline)<=Date.parse(proof.lease.expiresAt));assert.ok(Date.parse(proof.lease.expiresAt)-Date.parse(row.createdAt)>0&&Date.parse(proof.lease.expiresAt)-Date.parse(row.createdAt)<=180000);
 assert.equal(parent.globalToken,proof.lease.token);assert.deepEqual(proof.slotTokens,[parent.globalToken]);
 assert.equal(last.parent,parent.requestId);assert.equal(last.lease,job.leaseToken);assert.equal(last.claimSeq,previous.length+1);assert.equal(last.settled,null);assert.equal(last.effect,null);
 assert.ok(!previous.some(item=>item.lease===job.leaseToken));
 for(const item of previous){assert.equal(item.jobId,job.jobId);assert.equal(item.parent,parent.requestId);assert.equal(item.token,parent.globalToken);assert.equal(item.expiresAt,proof.lease.expiresAt);}
 for(const audit of proof.audit.slice(0,-1)){assert.equal(audit.settled,'queued');assert.equal(audit.effect,null);}
 assert.equal(proof.checkpointRows,previous.length?1:0);assert.equal(proof.publicationRows,0);assert.equal(proof.visibleCurrent,false);
 assert.equal(proof.checkpointIndex,previous.length===0?null:previous.length===1?'2':'3');
 return{jobId:job.jobId,lease:job.leaseToken,parent:parent.requestId,token:parent.globalToken,expiresAt:proof.lease.expiresAt};
}
function reviewYieldInventory(rows:Event[],token:string,jobId:string){
 const yields=rows.filter(e=>e.name==='yield_job'),normal=yields.filter(e=>e.token===token),nil=yields.filter(e=>e.token==='00000000-0000-0000-0000-000000000000');
 assert.equal(yields.length,normal.length+nil.length,'FOREIGN_OR_MISSING_YIELD_TOKEN');
 assert.equal(normal.length,2,'ORIGINAL_GLOBAL_NORMAL_YIELD_COUNT');assert.equal(nil.length,1,'EXACT_NIL_YIELD_PROBE_COUNT');
 assert.ok(normal.every(e=>e.forwarded===true&&e.httpStatus===200&&e.status==='queued'&&e.jobId===jobId),'NORMAL_YIELD_EFFECT_SCOPE_REQUIRED');
 assert.ok(nil.every(e=>e.forwarded===true&&e.nilYieldProbeRejected===true&&e.httpStatus===500&&e.sqlCode==='40001'&&e.jobId==='00000000-0000-0000-0000-000000000000'),'NIL_YIELD_REJECTION_REQUIRED');
 return{total:yields.length,normal:normal.length,nilRejected:nil.length};
}
function oldLeaseNoEffect(before:any,after:any,responseStatus:number,result:unknown){
 assert.equal(responseStatus,200);assert.deepEqual(result,{status:'lease_lost'});
 for(const key of ['jobHash','currentLease','leaseExpiresAt','checkpointRows','checkpointIndex','publicationRows','visibleCurrent','slotRows','slotTokens','audit','parents','lease','budget','reservationRows','protectionDigest'])assert.deepEqual(after[key],before[key], 'OLD_LEASE_EFFECT_CHANGED_'+key);
}
async function reviewClaimResponse(name:string,args:any,request:Request,response:Response){
 if(!reassignmentMode||!['claim_job','claim_supported_job'].includes(name))return;
 assert.equal(name,'claim_job','REVIEW_ONLY_UNEXPECTED_CLAIM_RPC');
 assert.ok(request.headers.get('authorization')==='Bearer '+f.serviceKey,'REVIEW_CLAIM_AUTH_REQUIRED');
 assert.ok(request.headers.get('apikey')===f.serviceKey,'REVIEW_CLAIM_APIKEY_REQUIRED');
 assert.equal(request.method,'POST');assert.equal(response.status,200,'REVIEW_CLAIM_RESPONSE_REQUIRED');
 assert.deepEqual(Object.keys(args).sort(),['p_lease_seconds','p_worker_id','p_worker_run_token']);
 const id=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 assert.ok(id.test(args.p_worker_id)&&id.test(args.p_worker_run_token),'REVIEW_CLAIM_SCOPE_REQUIRED');assert.equal(args.p_lease_seconds,180);
 const data=await response.clone().json();assert.deepEqual(Object.keys(data),['job']);
 await reviewClaimGate(data.job,request,args.p_worker_run_token);
}
async function reviewClaimGate(job:any,request:Request,token:string){
 if(!reassignmentMode||job===null)return;
 request.signal.throwIfAborted();assert.ok(reviewClaims.length<3);const before=await reviewLaneProof(request.signal);
 const scope=reviewClaimScope(job,before,reviewClaims);assert.equal(scope.token,token,'REVIEW_CLAIM_GLOBAL_SCOPE_MISMATCH');
 if(reviewClaims.length===1){
  assert.equal(oldLeaseFenceCalls,0);request.signal.throwIfAborted();
  const first=reviewClaims[0],args={p_job_id:first.jobId,p_lease_token:first.lease,p_source_revision:fixture.revision,p_evidence_review_ids:fixture.approvedReviewIds,p_summary:fixture.summary,p_model_version:'synthetic-summary-v1',p_prompt_version:'review-summary-v1',p_worker_run_token:first.token,p_contract_version:'2026-10-05'};
  oldLeaseFenceCalls++;
  const rejection=await safeFetch('http://127.0.0.1:'+f.restPort+'/rpc/publish_review_summary_for_job',{method:'POST',headers:request.headers,body:JSON.stringify(args),signal:request.signal,redirect:'error'});
  const result=await rejection.json();request.signal.throwIfAborted();const after=await reviewLaneProof(request.signal);oldLeaseNoEffect(before,after,rejection.status,result);
  modelDiagnostics.push({stage:'old_lease_publish_rejected_without_effect',passed:true,count:1});
 }
 request.signal.throwIfAborted();reviewClaims.push(scope);
}
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until(check:()=>Promise<boolean>,code:string,ms=30000){const end=performance.now()+ms;do{if(await check())return;await delay(100);}while(performance.now()<end);throw Error(code);}
function summaryRaceScope(name:string,args:Record<string,any>,proof:any,jobId:string,phase:'checkpoint'|'publish'){
 const operation=phase==='checkpoint'?'save_review_summary_checkpoint':'publish_review_summary_for_job';assert.equal(name,operation);
 const keys=['p_job_id','p_lease_token','p_source_revision','p_worker_run_token','p_contract_version',...(phase==='checkpoint'?['p_checkpoint']:['p_evidence_review_ids','p_summary','p_model_version','p_prompt_version'])];
 assert.deepEqual(Object.keys(args).sort(),keys.sort(),'SUMMARY_RACE_EXACT_RPC_ABI_REQUIRED');
 assert.equal(args.p_job_id,jobId);assert.equal(proof.jobId,jobId);assert.equal(proof.dispatchable,true);assert.equal(proof.jobStatus,'running');assert.equal(proof.settledStatus,null);
 assert.equal(proof.scope.jobId,args.p_job_id);assert.equal(proof.scope.leaseToken,args.p_lease_token);assert.equal(proof.scope.workerRunToken,args.p_worker_run_token);assert.equal(proof.scope.sourceRevision,args.p_source_revision);assert.equal(proof.scope.contractVersion,args.p_contract_version);
 assert.match(proof.scope.parent,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
 assert.equal(proof.revision,args.p_source_revision);assert.equal(proof.eligibleCount,3);assert.equal(proof.publicReviewCount,3);assert.equal(proof.authorConsent,true);
 assert.equal(proof.visibleNull,true);assert.equal(proof.published,0);assert.equal(proof.checkpoints,phase==='publish'?1:0);
 return{...proof.scope,phase};
}
async function summaryRaceGate(name:string,args:Record<string,any>,signal:AbortSignal){
 if(!summaryRace||name!==(summaryRace.phase==='checkpoint'?'save_review_summary_checkpoint':'publish_review_summary_for_job')||args.p_job_id==='00000000-0000-0000-0000-000000000000')return;
 signal.throwIfAborted();
 assert.equal(summaryRaceCommitted,false,'SUMMARY_RACE_DUPLICATE_WIRE');assert.equal(summaryRaceWireCalls,0);assert.equal(rawCopyRejectionChecked,true);
 assert.equal(modelCalls,1);assert.equal(actualReservations,1);assert.ok(fixture.reviewJobId);
 const before=JSON.parse(await control('--summary-race-proof',signal));
 const context={...summaryRaceScope(name,args,before,fixture.reviewJobId,summaryRace.phase),mutation:summaryRace.mutation};
 signal.throwIfAborted();
 await Deno.writeTextFile(root+'/summary-race-gate-private.json',JSON.stringify(context),{mode:0o600,createNew:true});
 signal.throwIfAborted();
 const changed=JSON.parse(await control('--summary-race-mutate',signal));
 assert.deepEqual(changed,{status:'FIXTURE_MUTATION_COMMITTED',mutations:1,revisionChanged:true,checkpointRemoved:true});
 signal.throwIfAborted();
 const after=JSON.parse(await control('--summary-race-proof',signal));assert.deepEqual(after.scope,before.scope);assert.ok(BigInt(after.revision)>BigInt(before.revision));assert.equal(after.visibleNull,true);assert.equal(after.checkpoints,0);assert.equal(after.published,0);
 summaryRaceCommitted=true;summaryRaceWireCalls++;summaryRaceEvidence.push({phase:summaryRace.phase,mutation:summaryRace.mutation,count:1,revisionChanged:true});
}
const safeFetch:typeof fetch=(input,init)=>{
 const url=new URL(input instanceof Request?input.url:String(input));
 if(url.hostname!=='127.0.0.1'||url.protocol!=='http:'||Number(url.port)!==f.restPort&&(!storageMode||Number(url.port)!==storageConfig.port)&&(!fiveMode||Number(url.port)!==authConfig.port)){externalCalls++;throw Error('EXTERNAL_DESTINATION_DISABLED');}
 return realFetch(input,{...init,client} as unknown as RequestInit);
};
const server=Deno.serve({hostname:'127.0.0.1',port:0,cert:await Deno.readTextFile(root+'/server.crt'),key:await Deno.readTextFile(root+'/server.key'),onListen(){},onError:()=>new Response(null,{status:503})},async request=>{
 const url=new URL(request.url);
 if(fiveMode&&url.pathname.startsWith('/synthetic-provider/')){
  assert.ok(fixture);assert.equal(request.method,'GET');
  const providerPath=url.pathname.slice('/synthetic-provider'.length);
  assert.equal(url.searchParams.get('service'),'synthetic-local-fixture-key');
  const today=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Seoul'}));
  const date=(add:number)=>{const d=new Date(Date.UTC(today.getFullYear(),today.getMonth(),today.getDate()+add));return d.toISOString().slice(0,10).replaceAll('-','.');};
  let xml:string;
  if(providerPath==='/openApi/restful/pblprfr'){
   assert.equal(url.searchParams.get('cpage'),'1');assert.equal(url.searchParams.get('rows'),'10');providerListCalls++;
   const current=date(0).replaceAll('.','');
   xml=url.searchParams.get('stdate')===current?'<dbs><db><mt20id>'+fixture.eventSourceId+'</mt20id><prfnm>합성 행사</prfnm><prfpdfrom>'+date(1)+'</prfpdfrom><prfpdto>'+date(2)+'</prfpdto><prfstate>공연예정</prfstate></db></dbs>':'<dbs/>';
  }else{
   assert.equal(providerPath,'/openApi/restful/pblprfr/'+fixture.eventSourceId);providerDetailCalls++;
   xml='<dbs><db><mt20id>'+fixture.eventSourceId+'</mt20id><prfpdfrom>'+date(1)+'</prfpdfrom><prfpdto>'+date(2)+'</prfpdto><sty>합성 상세</sty></db></dbs>';
  }
  return new Response(xml,{headers:{'content-type':'application/xml'}});
 }
 if((fiveMode||budgetMode||reassignmentMode)&&url.pathname.startsWith('/functions/v1/')){
  const handler=functionHandlers[url.pathname];if(!handler){unexpectedRoutes++;return new Response(null,{status:403});}
  const call={requestId:request.headers.get('x-worker-request-id'),token:request.headers.get('x-worker-run-token'),limit:Number(request.headers.get('x-worker-max-jobs')),remainingMs:Number(request.headers.get('x-worker-time-budget-ms')),path:url.pathname};
  if(budgetMode){assert.equal(url.pathname,'/functions/v1/service-api/internal/ai-feedback-maintenance');assert.equal(budgetCommitted,true,'EARLY_HELPFUL_MAINTENANCE_NOT_ALLOWED');assert.deepEqual(await request.clone().json(),{limit:20});assert.equal(call.token,budgetContext.globalToken);assert.ok(call.remainingMs>0&&call.remainingMs<=180000);actualFunctionCalls.push({...call,limit:20});}
  if(['/functions/v1/event-sync/worker','/functions/v1/review-summary-worker','/functions/v1/service-api/internal/member-cleanup'].includes(url.pathname)){assert.equal(await request.clone().text(),'{}');actualFunctionCalls.push(call);}
  if(retirementMode&&url.pathname==='/functions/v1/service-api/me/retirement'){
   publicPostCalls++;assert.equal(request.method,'POST');for(const header of ['x-worker-run-token','x-worker-request-id','x-worker-max-jobs','x-worker-time-budget-ms'])assert.equal(request.headers.get(header),null);
   const response=await handler(request);
   if(!publicResponseLost&&retirementCalls===1&&response.status===200){
    assert.ok(JSON.stringify((await response.clone().json()).data)===JSON.stringify({withdrawalId:fixture.cleanupWithdrawal,status:'processing',memberAccessRevoked:true}),'PUBLIC_PROCESSING_ENVELOPE_MISMATCH');
    await response.arrayBuffer();publicResponseLost=true;retirementEvidence.push({phase:'first_response_lost_after_commit',status:200,count:1});
    return new Response(new ReadableStream({start(controller){controller.error(Error('SYNTHETIC_PUBLIC_RETIREMENT_RESPONSE_LOSS'));}}));
   }
   return response;
  }
  return handler(request);
 }
 if(retirementMode&&url.pathname==='/auth/v1/user'){
  assert.equal(request.method,'GET');assert.equal(url.search,'');
  assert.equal(request.headers.get('apikey'),f.anonKey);
  assert.ok(publicSession);assert.ok([publicSession.token,...Object.values(publicSession.negativeTokens)].some(token=>request.headers.get('authorization')==='Bearer '+token));
  if(retirementAuthUnavailable)return new Response(JSON.stringify({error:{code:'EXTERNAL_UNAVAILABLE'}}),{status:503,headers:{'content-type':'application/json'}});
  const response=await safeFetch('http://127.0.0.1:'+authConfig.port+'/user',{method:'GET',headers:request.headers,redirect:'error'});publicAuthStatuses.push(response.status);return response;
 }
 if(fiveMode&&url.pathname.startsWith('/auth/v1/admin/users/')){
  assert.ok(fixture);const path=url.pathname.slice('/auth/v1'.length);assert.equal(path,'/admin/users/'+fixture.cleanupMember);
  assert.ok(['GET','DELETE'].includes(request.method));if(request.method==='DELETE')memberAuthDeleteCalls++;
  const response=await safeFetch('http://127.0.0.1:'+authConfig.port+path,{method:request.method,headers:request.headers,redirect:'error'});if(request.method==='GET')memberAbsenceReads.push({kind:'auth_user',absent:response.status===404});return response;
 }
 if(storageMode&&url.pathname.startsWith('/storage/v1/object/')){
  const path=url.pathname.slice('/storage/v1'.length);
  let requestBody=request.method==='GET'?undefined:await request.text();
  if(request.method==='DELETE'){
   if(path==='/object/report-evidence'){deleteCalls++;}
   else{assert.equal(fiveMode,true);assert.equal(path,'/object/profile-images');assert.ok(JSON.stringify(JSON.parse(requestBody!).prefixes)===JSON.stringify([fixture.cleanupObjectName]),'UNAPPROVED_SYNTHETIC_DELETE_SCOPE');memberStorageDeleteCalls++;}
  }
  const response=await safeFetch('http://127.0.0.1:'+storageConfig.port+path,{method:request.method,headers:request.headers,body:requestBody,redirect:'error'});
  if(fiveMode&&request.method==='GET'&&path.includes('/profile-images/')){const data=response.ok?null:await response.clone().json();memberAbsenceReads.push({kind:path.startsWith('/object/info/')?'storage_info':'storage_bytes',absent:[400,404].includes(response.status)&&[404,'404'].includes(data?.statusCode)});}
  if(deleteLoss&&request.method==='DELETE'&&!lost&&response.ok){await response.arrayBuffer();await until(async()=>(await snapshot()).queueSessions===2,'TWO_REAL_NODE_SESSIONS_REQUIRED',5000);lost=true;return new Response(new ReadableStream({start(c){c.error(Error('SYNTHETIC_DELETE_RESPONSE_LOSS'));}}));}
  return response;
 }
 if(!url.pathname.startsWith('/rest/v1/rpc/')){unexpectedRoutes++;return new Response(null,{status:403});}
 const name=url.pathname.split('/').at(-1)!;assert.match(name,/^[a-z][a-z0-9_]*$/);
 if(retirementMode&&name==='get_my_retirement_receipt'){
  assert.equal(request.method,'GET');assert.equal(await request.text(),'');assert.ok(publicSession);
  assert.deepEqual([...url.searchParams.keys()].sort(),['p_request_fingerprint','p_withdrawal_id']);
  assert.ok([fixture.cleanupWithdrawal,publicSession.otherWithdrawalId].includes(url.searchParams.get('p_withdrawal_id')));assert.match(url.searchParams.get('p_request_fingerprint')!,/^[a-f0-9]{64}$/);
  assert.ok(url.searchParams.get('p_request_fingerprint')===await retirementDigest(url.searchParams.get('p_withdrawal_id')!),'PUBLIC_RECEIPT_FINGERPRINT_MISMATCH');
  assert.ok([publicSession.token,...Object.values(publicSession.negativeTokens)].some(token=>request.headers.get('authorization')==='Bearer '+token));
  assert.equal(request.headers.get('apikey'),f.anonKey);retirementReceiptCalls++;
  return safeFetch('http://127.0.0.1:'+f.restPort+'/rpc/'+name+url.search,{method:'GET',headers:request.headers,redirect:'error'});
 }
 const body=await request.text(),args=JSON.parse(body);
 if(retirementMode&&name==='retire_my_account'){
  assert.equal(request.method,'POST');assert.equal(url.search,'');assert.deepEqual(Object.keys(args),['p_withdrawal_id']);assert.equal(args.p_withdrawal_id,fixture.cleanupWithdrawal);
  assert.equal(request.headers.get('authorization'),'Bearer '+publicSession.token);assert.equal(request.headers.get('apikey'),f.anonKey);assert.equal(retirementCalls,0);retirementCalls++;
  return safeFetch('http://127.0.0.1:'+f.restPort+'/rpc/'+name,{method:'POST',headers:request.headers,body,redirect:'error'});
 }
const event:Event={name,requestId:args.p_request_id??args.p_recovery_request_id??null,parent:args.p_parent_request_id??args.p_parent_invocation_id??args.p_invocation_request_id??null,token:args.p_global_token??args.p_worker_run_token??args.p_recovery_global_token??null,operation:args.p_operation??null,caller:request.headers.get('x-isolated-queue-origin')};events.push(event);
 if(summaryRace&&typeof args.p_job_id==='string'){event.jobId=args.p_job_id;if(typeof args.p_source_revision==='string')event.sourceRevision=args.p_source_revision;}
 if(automaticParentOnly&&name==='acquire_worker_run'){
  // 자동 종결 증거 구간만 분리한다. 새 global 요청은 DB에 전달하지 않는 명시적 네트워크 실패다.
  event.forwarded=false;return new Response(JSON.stringify({error:{code:'EXTERNAL_UNAVAILABLE'}}),{status:503,headers:{'content-type':'application/json'}});
 }
 if(recoveryMode&&!interruptedOrigin&&name==='complete_member_cleanup_task'){
  const wanted=interruptedKind;
  const claim=memberLeaseProofs.find(p=>p.taskId===args.p_task_id&&p.kind===wanted);
  if(claim){
   const proof=await snapshot(),original=proof.five.memberOrigins.find((o:{taskId:string})=>o.taskId===claim.taskId);
   assert.ok(original);assert.equal(original.state,'running');assert.equal(original.jobStatus,'running');assert.equal(original.parent,claim.parent);assert.equal(original.parentToken,claim.token);assert.equal(original.originalLease,claim.leaseToken);
   // 원 DELETE와 ACK는 commit됐다. 이 최초 완료 요청은 DB에 전달하지 않으며 UUID 재발신을 허용하지 않는다.
   interruptedOrigin=original;blockedTaskComplete++;event.forwarded=false;
   await Deno.writeTextFile(root+'/member-original-unknown-private.json',JSON.stringify(original),{mode:0o600,createNew:true});
   return new Response(JSON.stringify({error:{code:'EXTERNAL_UNAVAILABLE'}}),{status:503,headers:{'content-type':'application/json'}});
  }
 }
 event.forwarded=true;
 if(fiveMode&&name==='save_review_summary_checkpoint'&&args.p_job_id!=='00000000-0000-0000-0000-000000000000'&&!rawCopyRejectionChecked){
  assert.ok(fixture);assert.equal(args.p_checkpoint.nodes.length,1);assert.equal(args.p_checkpoint.nodes[0].claims[0].text,approvedSyntheticSummary);
  const before=await snapshot();assert.equal(before.five.checkpointRows,0);
  const bad=structuredClone(args);bad.p_checkpoint.nodes[0].claims[0].text=approvedSyntheticComment;
  const rejection=await safeFetch('http://127.0.0.1:'+f.restPort+'/rpc/'+name,{method:request.method,headers:request.headers,body:JSON.stringify(bad),redirect:'error'});
  assert.equal(rejection.status,200);assert.deepEqual(await rejection.json(),{status:'invalid_evidence'});
  assert.equal((await snapshot()).five.checkpointRows,0);
  rawCopyRejectionChecked=true;modelDiagnostics.push({stage:'db_raw_copy_rejected_without_checkpoint',passed:true});
 }
 let nilYieldBefore:any;
 if(reassignmentMode&&name==='yield_job'){
  event.jobId=args.p_job_id;
  if(event.token==='00000000-0000-0000-0000-000000000000'){
   assert.deepEqual(args,{p_job_id:event.token,p_lease_token:event.token,p_worker_run_token:event.token,p_available_at:null});
   nilYieldBefore=await reviewLaneProof(request.signal);
  }
 }
 await summaryRaceGate(name,args,request.signal);
 const response=await safeFetch('http://127.0.0.1:'+f.restPort+'/rpc/'+name,{method:request.method,headers:request.headers,body,redirect:'error'});
 if(reassignmentMode&&name==='yield_job'){
  const result=await response.clone().json();event.httpStatus=response.status;
  if(nilYieldBefore){
   assert.equal(response.status,500);assert.deepEqual(Object.keys(result).sort(),['code','details','hint','message']);assert.equal(result.code,'40001');assert.ok(result.message==='state_conflict'&&result.details===null&&result.hint===null,'EXACT_NIL_YIELD_STATE_CONFLICT_REQUIRED');
   const after=await reviewLaneProof(request.signal);for(const key of ['jobHash','audit','parents','lease','budget','reservationRows','protectionDigest','slotRows','slotTokens','checkpointRows','publicationRows','visibleCurrent'])assert.deepEqual(after[key],nilYieldBefore[key],'NIL_YIELD_EFFECT_CHANGED_'+key);
   event.sqlCode='40001';event.nilYieldProbeRejected=true;
  }else{
   assert.equal(response.status,200);assert.deepEqual(result,{jobId:fixture.jobId,status:'queued'});event.status='queued';
  }
 }
 if(reassignmentMode&&['claim_job','claim_supported_job'].includes(name))await reviewClaimResponse(name,args,request,response);
 if((fiveMode||budgetMode||reviewLaneMode)&&['prepare_worker_invocation_intent','execute_worker_invocation_operation','confirm_worker_runtime_intent'].includes(name)){
  const result=await response.clone().json().catch(()=>null);
  if(rejectedNullSafetyProbe(name,args,response.status,result)){
   event.nullSafetyProbeRejected=true;event.httpStatus=response.status;
   if(result.code==='22023')event.sqlCode='22023';else event.publicCode='INVALID_REQUEST';
  }
 }
 if((fiveMode||budgetMode||reviewLaneMode)&&name==='read_worker_runtime_pending_v2'&&response.ok){
  const result=await response.clone().json();assert.equal(response.status,200);assert.deepEqual(Object.keys(result),['hasPending']);assert.equal(typeof result.hasPending,'boolean');event.pending=result.hasPending;event.httpStatus=200;
 }
 if((fiveMode||reviewLaneMode)&&['load_review_summary_source','load_review_summary_checkpoint','save_review_summary_checkpoint','discard_review_summary_checkpoint','mark_review_summary_insufficient','publish_review_summary_for_job','reserve_review_summary_model','settle_ai_budget'].includes(name)){
  event.httpStatus=response.status;
  const value=await response.clone().json().catch(()=>null);
  const states=['applied','lease_lost','already_published','stale_revision','invalid_evidence','insufficient_reviews','consent_revoked'];
  if(states.includes(value?.status))event.status=value.status;
  if(summaryRace&&name===(summaryRace.phase==='checkpoint'?'save_review_summary_checkpoint':'publish_review_summary_for_job')&&args.p_job_id===fixture?.reviewJobId){assert.equal(response.status,200);assert.deepEqual(value,{status:'stale_revision'});summaryRaceEvidence.push({phase:'original_write_rejected',mutation:summaryRace.mutation,status:value.status,count:1});}
  if(['22023','40001','42501','55000','23514'].includes(value?.code))event.sqlCode=value.code;
  if(['STATE_CONFLICT','ACCESS_DENIED','INVALID_INPUT','EXTERNAL_UNAVAILABLE','INTERNAL_ERROR'].includes(value?.error?.code))event.publicCode=value.error.code;
 }
 if((fiveMode||reviewLaneMode)&&response.ok&&name==='prepare_queue_invocation'){
  const proof=await snapshot(),parent=proof.invocations.find((r:{requestId:string})=>r.requestId===event.requestId);
  assert.ok(parent);assert.equal(parent.token,proof.lease.token);assert.equal(parent.token,event.token);
  const remaining=Date.parse(proof.lease.expiresAt)-Date.parse(proof.serverNow);assert.ok(remaining>0&&remaining<=180000);assert.ok(Date.parse(parent.deadline)<=Date.parse(proof.lease.expiresAt));
  globalLeaseProofs.push({requestId:parent.requestId,token:parent.token,expiresAt:proof.lease.expiresAt,serverNow:proof.serverNow,remainingMs:remaining,parentDeadline:parent.deadline});
 }
 if(fiveMode&&response.ok&&name==='claim_member_cleanup_task'){
  const task=await response.clone().json();if(task!==null){assert.ok(task.taskId&&task.expiresAt);const proof=(await snapshot()).five.memberClaimEvidence.find((p:{taskId:string})=>p.taskId===task.taskId);assert.ok(proof);assert.equal(proof.exact,true);assert.equal(Date.parse(proof.expiresAt),Date.parse(task.expiresAt));assert.ok(proof.limitMs>0&&proof.limitMs<=60000);memberLeaseProofs.push(proof);}
 }
 if((fiveMode||reassignmentMode)&&response.ok&&name==='reserve_review_summary_model'){
  const result=await response.clone().json();
  if(args.p_job_id==='00000000-0000-0000-0000-000000000000'){assert.deepEqual(Object.keys(result),['status']);assert.ok(['consent_revoked','lease_lost'].includes(result.status));nilReserveProbes.push(result.status);}
  else{assert.deepEqual(Object.keys(result),['reservationId']);assert.match(result.reservationId,/^[0-9a-f-]{36}$/);actualReservations++;}
 }
 if(fiveMode&&name==='execute_worker_invocation_operation'&&response.ok){const result=await response.clone().json();event.status=result.result?.status;}
 if(name==='claim_queue_invocation_dispatch'&&response.ok)event.claimed=(await response.clone().json()).claimed;
 if(['get_queue_invocation','complete_queue_invocation'].includes(name)&&response.ok)event.resultState=(await response.clone().json()).state;
 if(budgetMode&&response.ok&&name==='read_worker_runtime_slots'){
  const slots=await response.clone().json();assert.deepEqual(Object.keys(slots).sort(),['remaining','used']);assert.equal(slots.remaining,20-slots.used);assert.ok(slots.used>=0&&slots.used<=20);
  if(budgetCommitted){assert.equal(event.token,budgetContext.globalToken);assert.deepEqual(slots,{used:20,remaining:0});}
  budgetTrace.push({phase:'ACTUAL_SLOT_READ',token:event.token,used:slots.used,remaining:slots.remaining});
 }
 if(budgetMode&&response.ok&&name==='read_worker_run_budget'){
  const budget=await response.clone().json();assert.deepEqual(Object.keys(budget),['remainingMs']);assert.ok(budget.remainingMs>=0&&budget.remainingMs<=180000);
  if(budgetCommitted)assert.equal(event.token,budgetContext.globalToken);budgetTrace.push({phase:'ACTUAL_REMAINING_BUDGET_READ',token:event.token,remainingMs:budget.remainingMs});
 }
 if(budgetMode&&budgetCommitted&&response.ok&&['prepare_queue_invocation','claim_queue_invocation_dispatch','purge_ai_feedback_scoped','purge_worker_runtime_details_scoped','execute_worker_runtime_operation'].includes(name)){
  assert.equal(event.token,budgetContext.globalToken);const proof=JSON.parse(await control('--budget-proof',request.signal));assert.equal(proof.originalDigest,budgetContext.originalDigest);assert.deepEqual([...proof.slotIds].sort(),budgetContext.jobIds);assert.deepEqual(proof.lease,{token:budgetContext.globalToken,expiresAt:budgetContext.expiresAt});
  budgetTrace.push({phase:name,token:event.token,requestId:event.requestId,used:20,remaining:0,expiresAt:proof.lease.expiresAt});
 }
 if(budgetMode&&name==='complete_queue_invocation'&&response.ok)await budgetQueueGate(await response.clone().json(),request.signal);
 const lossOperation=cancellationMode?'cancellation_process':storageMode?'report_storage_ack':'report_task_complete';
 if(forceOperationLoss&&!deleteLoss&&!lost&&name==='execute_worker_invocation_operation'&&event.operation===lossOperation&&response.ok){
  await response.arrayBuffer();await until(async()=> (await snapshot()).queueSessions===2,'TWO_REAL_NODE_SESSIONS_REQUIRED',5000);const proof=await snapshot();lossLeaseMs=Date.parse(proof.lease.expiresAt)-Date.parse(proof.invocations.find((x:{requestId:string})=>x.requestId===event.parent).createdAt);lostRequestId=event.requestId;lost=true;
  return new Response(new ReadableStream({start(c){c.error(Error('SYNTHETIC_RESPONSE_LOSS'));}}));
 }
 return response;
});
const origin='https://127.0.0.1:'+server.addr.port;
const values:Record<string,string>={SUPABASE_URL:origin,SUPABASE_ANON_KEY:f.anonKey,SUPABASE_SERVICE_ROLE_KEY:f.serviceKey,INTERNAL_WORKER_SECRET:f.internalSecret,ALLOWED_ORIGINS:'[]',UPSTREAM_TIMEOUT_MS:'15000',MAX_REQUEST_BYTES:'65536'};
const config=loadRuntimeConfig(k=>values[k]);
// Harness DB calls are also forced through the recorded HTTPS proxy/REST port.
const harnessFetch:typeof fetch=(input,init)=>{
 const url=new URL(input instanceof Request?input.url:String(input));assert.equal(url.origin,origin);assert.ok(url.pathname.startsWith('/rest/v1/rpc/'));
 return realFetch(input,{...init,client}as unknown as RequestInit);
};
async function assembleFiveHandlers(){
 fixture=JSON.parse(await Deno.readTextFile(root+'/five-fixture-private.json'));assert.equal(fixture.expectedJobs,retirementMode?null:expectedJobs);assert.deepEqual(fixture.expectedKinds,fullKinds);
 if(retirementMode){publicSession=JSON.parse(await Deno.readTextFile(root+'/public-retirement-session-private.json'));assert.equal(publicSession.member,fixture.cleanupMember);assert.equal(publicSession.withdrawalId,fixture.cleanupWithdrawal);assert.equal(publicSession.actualSession,true);assert.equal(fixture.cleanupTasksSeeded,0);}
 const read=(key:string)=>values[key];
 // 제공사 목적지만 전용 HTTPS 합성 endpoint로 이동한다. 실제 제품 XML 정규화·DB 저장은 그대로 사용한다.
 const productFetch:typeof fetch=(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.origin==='https://kopis.or.kr'&&url.pathname.startsWith('/openApi/restful/pblprfr')){
   return realFetch(origin+'/synthetic-provider'+url.pathname+url.search,{...init,client}as unknown as RequestInit);
  }
  assert.equal(url.origin,origin,'EXTERNAL_DESTINATION_DISABLED');
  assert.ok(['/rest/v1/rpc/','/storage/v1/object/','/auth/v1/admin/users/'].some(p=>url.pathname.startsWith(p))||retirementMode&&url.pathname==='/auth/v1/user','UNAPPROVED_PRODUCT_DESTINATION');
  return realFetch(input,{...init,client}as unknown as RequestInit);
 };
 globalThis.fetch=productFetch;
 Object.assign(values,{EVENT_SYNC_PROVIDERS:'kopis',EVENT_SYNC_MAX_PERIOD_DAYS:'31',EVENT_SYNC_MAX_PAGE:'999',EVENT_SYNC_PAGE_ROWS:'10',KOPIS_API_KEY:'synthetic-local-fixture-key',
  REVIEW_SUMMARY_MODEL_VERSION:'synthetic-summary-v1',REVIEW_SUMMARY_PROMPT_VERSION:'review-summary-v1',
  REVIEW_SUMMARY_WORKER_MAX_JOBS_PER_RUN:'10',REVIEW_SUMMARY_WORKER_TIME_BUDGET_MS:'60000',REVIEW_SUMMARY_LEASE_SECONDS:'180',REVIEW_SUMMARY_RETRY_MAX_ATTEMPTS:'3',REVIEW_SUMMARY_RETRY_BASE_DELAY_MS:'600000',REVIEW_SUMMARY_RETRY_MAX_DELAY_MS:'21600000',REVIEW_SUMMARY_BUDGET_DEFER_MS:'3600000',REVIEW_SUMMARY_MAX_INPUT_CHARS:'12000',REVIEW_SUMMARY_MAX_REVIEWS_PER_CHUNK:'3',REVIEW_SUMMARY_MERGE_FAN_IN:'2',REVIEW_SUMMARY_MAX_OUTPUT_TOKENS:'200',REVIEW_SUMMARY_MAX_OUTPUT_CHARS:'300',REVIEW_SUMMARY_MAX_CALLS_PER_STEP:'1'});
 // 승인 문자열은 DB 응답에서 만들지 않고 사전에 작성한 합성 fixture 계획만 사용한다.
 assert.equal(fixture.approvedComment,approvedSyntheticComment);assert.equal(fixture.approvedSummary,approvedSyntheticSummary);
 const privacy=createConservativePrivacyCheck({decisionId:'isolated-synthetic-five-only',approvedStrings:['reviews','evidenceId','comment','claims','text','evidenceIds',approvedSyntheticComment,approvedSyntheticSummary,...fixture.approvedReviewIds]});
 const syntheticSafety={async check(input:unknown){const passed=syntheticSummarySafe(input,fixture.approvedReviewIds);modelDiagnostics.push({stage:'synthetic_semantic_safety',passed});return passed;}};
 const localModel:ModelPort={async generate(request){
  const check=(stage:string,test:()=>void,count?:number)=>{try{test();modelDiagnostics.push({stage,passed:true,...(count===undefined?{}:{count})});}catch(error){modelDiagnostics.push({stage,passed:false});throw error;}};
  check('task',()=>assert.equal(request.task,'review_chunk'));
  check('scope_present',()=>assert.ok(request.summaryRequest));
  check('actual_reservation',()=>assert.equal(actualReservations,modelCalls+1,'MODEL_BEFORE_ACTUAL_DB_RESERVATION'),actualReservations);
  check('target',()=>assert.equal(request.summaryRequest!.targetUserId,fixture.reviewTarget));
  check('evidence_set',()=>assert.deepEqual([...request.summaryRequest!.sourceReviewIds].sort(),[...fixture.approvedReviewIds].sort()),request.summaryRequest!.sourceReviewIds.length);
  // 제품 eligibility.ts가 evidenceId 오름차순으로 정렬한다. 고정 fixture 기대 순서는 그대로 검증한다.
  check('input_exact',()=>assert.ok(JSON.stringify(request.input)===JSON.stringify({reviews:fixture.approvedReviewIds.map((evidenceId:string)=>({evidenceId,comment:fixture.approvedComment}))}),'UNEXPECTED_SYNTHETIC_SUMMARY_INPUT'));
  modelDiagnostics.push({stage:'response_created',passed:true});
  modelCalls++;return{value:{claims:[{text:approvedSyntheticSummary,evidenceIds:[...fixture.approvedReviewIds]}]},modelVersion:'synthetic-summary-v1',usage:null};
 }};
 functionHandlers={
  '/functions/v1/event-sync/worker':createEventSyncRuntime(read,productFetch),
  '/functions/v1/review-summary-worker':createReviewSummaryWorkerRuntime(read,{fetch:productFetch,privacy,safety:syntheticSafety,createModel:(_read,{budgetDb})=>({status:'ready',modelVersion:'synthetic-summary-v1',usageIncludesAllAttempts:true,model:createModelRouter({primary:{id:'synthetic-local',retentionReview:{status:'approved',decisionId:'isolated-synthetic-only-no-provider-approval'},model:localModel},budget:createRpcModelBudget(budgetDb,{ledgerId:fixture.ledgerId,promptOverheadBytes:0})})})}),
  '/functions/v1/service-api/internal/member-cleanup':createRuntimeHandler(read,{memberCleanup:true,memberCleanupExecution:{limit:10,maxExecutionMs:120000}}),
 };
 if(recoveryMode){
  const recovery=createRuntimeHandler(read,{memberCleanup:true,memberCleanupExecution:{limit:10,maxExecutionMs:120000},memberCleanupReconcile:{approved:true,decisionId:'isolated-original115-only',maxExecutionMs:60000}});
  functionHandlers['/functions/v1/service-api/internal/member-cleanup/reconcile']=recovery;
 };
 if(retirementMode)functionHandlers['/functions/v1/service-api/me/retirement']=createRuntimeHandler(read,{memberCleanup:true,memberRetirement:true,memberCleanupExecution:{limit:10,maxExecutionMs:120000}});
}
const invocation=createWorkerInvocationRuntime(createInternalClient(config,harnessFetch));
function reviewLaneSafe(input:unknown,plan:any):boolean{
 try{
  const value=input as {claims:{text:string;evidenceIds:string[]}[];publicTextReviews:{evidenceId:string;comment:string}[]};
  const exact=(item:unknown,keys:string[])=>Boolean(item&&typeof item==='object'&&!Array.isArray(item)&&JSON.stringify(Object.keys(item).sort())===JSON.stringify([...keys].sort()));
  if(!exact(value,['claims','publicTextReviews'])||!Array.isArray(value.claims)||value.claims.length!==1||!Array.isArray(value.publicTextReviews))return false;
  const claim=value.claims[0];if(!exact(claim,['text','evidenceIds'])||!Array.isArray(claim.evidenceIds))return false;
  const allowed=[{ids:plan.approvedReviewIds.slice(0,2),text:plan.chunkTwo},{ids:plan.approvedReviewIds.slice(2),text:plan.chunkOne},{ids:plan.approvedReviewIds,text:plan.summary}];
  const same=(a:string[],b:string[])=>a.length===b.length&&new Set(a).size===a.length&&JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
  const match=allowed.find(row=>row.text===claim.text&&same(claim.evidenceIds,row.ids));
  return Boolean(match&&value.publicTextReviews.every(review=>exact(review,['evidenceId','comment'])&&review.comment===plan.comment)&&same(value.publicTextReviews.map(review=>review.evidenceId),match.ids));
 }catch{return false;}
}
function reviewModelStep(index:number,plan:any){
 assert.ok(index>=0&&index<3&&Number.isSafeInteger(index),'EXTRA_SYNTHETIC_MODEL_CALL');
 if(index<2){const ids=index===0?plan.approvedReviewIds.slice(0,2):plan.approvedReviewIds.slice(2);return{task:'review_chunk',input:{reviews:ids.map((evidenceId:string)=>({evidenceId,comment:plan.comment}))},value:{claims:[{text:index===0?plan.chunkTwo:plan.chunkOne,evidenceIds:ids}]}};}
 return{task:'review_merge',input:{summaries:[{evidenceId:'group-0',text:plan.chunkTwo},{evidenceId:'group-1',text:plan.chunkOne}]},value:{claims:[{text:plan.summary,evidenceIds:['group-0','group-1']}]}};
}
async function assembleReviewLaneHandler(){
 fixture=JSON.parse(await Deno.readTextFile(root+'/review-lane-fixture-private.json'));
 assert.equal(fixture.comment,approvedSyntheticComment);assert.equal(fixture.summary,approvedSyntheticSummary);
 Object.assign(values,{REVIEW_SUMMARY_MODEL_VERSION:'synthetic-summary-v1',REVIEW_SUMMARY_PROMPT_VERSION:'review-summary-v1',REVIEW_SUMMARY_WORKER_MAX_JOBS_PER_RUN:'10',REVIEW_SUMMARY_WORKER_TIME_BUDGET_MS:'60000',REVIEW_SUMMARY_LEASE_SECONDS:'180',REVIEW_SUMMARY_RETRY_MAX_ATTEMPTS:'3',REVIEW_SUMMARY_RETRY_BASE_DELAY_MS:'600000',REVIEW_SUMMARY_RETRY_MAX_DELAY_MS:'21600000',REVIEW_SUMMARY_BUDGET_DEFER_MS:'3600000',REVIEW_SUMMARY_MAX_INPUT_CHARS:'12000',REVIEW_SUMMARY_MAX_REVIEWS_PER_CHUNK:'2',REVIEW_SUMMARY_MERGE_FAN_IN:'2',REVIEW_SUMMARY_MAX_OUTPUT_TOKENS:'200',REVIEW_SUMMARY_MAX_OUTPUT_CHARS:'300',REVIEW_SUMMARY_MAX_CALLS_PER_STEP:'1'});
 const privacy=createConservativePrivacyCheck({decisionId:'isolated-stage3-synthetic-only',approvedStrings:['reviews','evidenceId','comment','claims','text','evidenceIds','summaries','group-0','group-1',fixture.comment,fixture.chunkTwo,fixture.chunkOne,fixture.summary,...fixture.approvedReviewIds]});
 const productFetch:typeof fetch=(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));assert.equal(url.origin,origin);assert.ok(url.pathname.startsWith('/rest/v1/rpc/'));return realFetch(input,{...init,client}as unknown as RequestInit);};
 globalThis.fetch=productFetch;
 const localModel:ModelPort={async generate(request){
  request.signal?.throwIfAborted();const step=reviewModelStep(modelCalls,fixture);
  assert.equal(actualReservations,modelCalls+1);assert.equal(request.task,step.task);assert.deepEqual(request.input,step.input);
  const scope=request.summaryRequest;assert.ok(scope);assert.equal(scope.targetUserId,fixture.target);assert.equal(scope.jobId,fixture.jobId);assert.equal(scope.sourceRevision,fixture.revision);
  assert.deepEqual(scope.sourceReviewIds,fixture.approvedReviewIds);assert.ok(reviewClaims.length>0,'REVIEW_MODEL_WITHOUT_CAPTURED_CLAIM');assert.equal(scope.workerRunToken,reviewClaims[0].token);assert.equal(scope.leaseToken,reviewClaims.at(-1)!.lease);
  modelDiagnostics.push({stage:'exact_synthetic_review_step',passed:true,count:modelCalls+1});modelCalls++;
  return{value:step.value,modelVersion:'synthetic-summary-v1',usage:null};
 }};
 functionHandlers['/functions/v1/review-summary-worker']=createReviewSummaryWorkerRuntime(key=>values[key],{fetch:productFetch,privacy,safety:{async check(input){return reviewLaneSafe(input,fixture);}},createModel:(_read,{budgetDb})=>({status:'ready',modelVersion:'synthetic-summary-v1',usageIncludesAllAttempts:true,model:createModelRouter({primary:{id:'synthetic-local',retentionReview:{status:'approved',decisionId:'isolated-local-no-provider-approval'},model:localModel},budget:createRpcModelBudget(budgetDb,{ledgerId:fixture.ledgerId,promptOverheadBytes:0})})})});
}
const atomic=createWorkerAtomicRuntime(createInternalClient(config,harnessFetch));
const approvedDecisionId='isolated-safety114-reviewed-20261009';
const env:Record<string,string>={...values,WORKER_QUEUE_DATABASE_URL:'postgresql://'+f.login+':'+f.password+'@127.0.0.1:'+f.dbPort+'/postgres',WORKER_QUEUE_FUNCTION_URL:origin+'/functions/v1/review-summary-worker',WORKER_QUEUE_DB_CA_PEM:await Deno.readTextFile(root+'/ca.crt'),WORKER_QUEUE_DB_CONTRACT_ID:approvedDecisionId,WORKER_QUEUE_DB_LOGIN_ROLE:f.login,WORKER_QUEUE_QUERY_TIMEOUT_MS:'3000',WORKER_QUEUE_RECONNECT_MS:'1000',WORKER_QUEUE_HTTP_TIMEOUT_MS:'60000',NODE_EXTRA_CA_CERTS:root+'/ca.crt'};
const cliURL=new URL('backend/supabase/functions/scheduled-jobs/queue-runner.mjs',new URL('file://'+repo+'/')).href;
const pgClientURL=new URL('backend/node_modules/pg/lib/index.js',new URL('file://'+repo+'/')).href;
const launcher=root+'/trusted-server-launcher.mjs';
const finalizationLauncher=root+'/automatic-finalizer-launcher.mjs';
const directAcquireCounter=root+'/automatic-direct-acquire-private.jsonl';
// 자동 종결의 격리 구간만 busy로 고정한다. 제품의 정상 scheduler 중지 기능이 아니다.
const finalizationClientFactoryCode=String.raw`function finalizationOnlyClient(RealClient,onBlocked){return class extends RealClient{
 query(...args){
  if(args.length===2&&args[0]==='select public.acquire_worker_run($1::integer,null::uuid) as result'&&Array.isArray(args[1])&&args[1].length===1&&args[1][0]===180){
   onBlocked();return Promise.resolve({rows:[{result:null}]});
  }
  return super.query(...args);
 }
};}`;
// 검토된 고정 승인 코드와 격리 transport만 전달한다. 기동·preflight·신호 종료는 제품 CLI 진입점을 공유한다.
const launcherSource=(finalizationOnly:boolean)=>`import {runQueueRunnerCli}from ${JSON.stringify(cliURL)};
async function main(){
const finalizationOnly=${finalizationOnly};
${finalizationClientFactoryCode}
const original=globalThis.fetch;const expected=new URL(process.env.SUPABASE_URL);
const safe=(input,init)=>{const u=new URL(input instanceof Request?input.url:String(input));if(u.origin!==expected.origin||!(u.pathname.startsWith('/rest/v1/rpc/')||${budgetMode}&&u.pathname==='/functions/v1/service-api/internal/ai-feedback-maintenance'||${storageMode}&&u.pathname.startsWith('/storage/v1/object/')||${reassignmentMode}&&u.pathname==='/functions/v1/review-summary-worker'||${fiveMode}&&['/functions/v1/event-sync/worker','/functions/v1/review-summary-worker','/functions/v1/service-api/internal/member-cleanup'].includes(u.pathname)))throw Error('EXTERNAL_DESTINATION_DISABLED');const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));headers.set('x-isolated-queue-origin','approved-launcher');return original(input,{...init,headers});};
const approvals=${reassignmentMode?JSON.stringify({review:{approved:true,decisionId:approvedDecisionId,maxJobsPerRun:10,timeBudgetMs:60000}}):fiveMode?JSON.stringify({review:{approved:true,decisionId:approvedDecisionId,maxJobsPerRun:10,timeBudgetMs:60000},existing:[{approved:true,decisionId:approvedDecisionId,kind:'event_sync',maxJobsPerRun:10,timeBudgetMs:60000},{approved:true,decisionId:approvedDecisionId,kind:'member_cleanup',maxJobsPerRun:10,timeBudgetMs:120000}],safety:['cancellation_safety','report_retention'].map(kind=>({approved:true,decisionId:approvedDecisionId,kind,maxJobsPerRun:10,timeBudgetMs:60000,readiness:{scopedClaim:true,sharedBudgetContract:true,durableJournalContract:true,cancellationGuardAndAcl:kind==='cancellation_safety',reportGuardAndAcl:kind==='report_retention',reportTerminalScheduleContract:kind==='report_retention',storageProviderApproved:kind==='report_retention'},retry:{maxAttempts:3,baseDelayMs:1000,maxDelayMs:5000}}))}):JSON.stringify({safety:[{approved:true,decisionId:approvedDecisionId,kind,maxJobsPerRun:10,timeBudgetMs:60000,readiness:{scopedClaim:true,sharedBudgetContract:true,durableJournalContract:true,cancellationGuardAndAcl:cancellationMode,reportGuardAndAcl:!cancellationMode,reportTerminalScheduleContract:!cancellationMode,storageProviderApproved:!cancellationMode},retry:{maxAttempts:3,baseDelayMs:1000,maxDelayMs:5000}}]})};
const memberParentFinalization=${recoveryMode?JSON.stringify({approved:true,decisionId:approvedDecisionId,maxExecutionMs:60000}):'undefined'};
const loadClient=async()=>{const pg=await import(${JSON.stringify(pgClientURL)});const Client=pg.default.Client;const{appendFileSync}=await import('node:fs');return finalizationOnlyClient(Client,()=>appendFileSync(${JSON.stringify(directAcquireCounter)},JSON.stringify({phase:'DIRECT_ACQUIRE_BUSY',pid:process.pid})+'\\n',{mode:0o600}));};
await runQueueRunnerCli({trustedAssembly:{...approvals,...(memberParentFinalization?{memberParentFinalization}:{})},dependencies:{fetchImpl:safe,...(finalizationOnly?{loadClient}:{})}});
}void main().catch(()=>{process.stderr.write('WORKER_QUEUE_NOT_CONFIGURED\\n');process.exitCode=1;});
`;
await Deno.writeTextFile(launcher,launcherSource(false),{mode:0o600,createNew:true});
if(recoveryMode)await Deno.writeTextFile(finalizationLauncher,launcherSource(true),{mode:0o600,createNew:true});
for(const path of recoveryMode?[launcher,finalizationLauncher]:[launcher]){
 const checked=await new Deno.Command('node',{args:['--check',path],stdout:'piped',stderr:'piped'}).output();
 assert.equal(checked.code,0,'NATIVE_GENERATED_LAUNCHER_SYNTAX_REQUIRED');
}
interface Running {child:Deno.ChildProcess;output:Promise<Deno.CommandOutput>;name:string}
const children:Running[]=[];
function launch(name:string,finalizationOnly=false){if(finalizationOnly)assert.ok(recoveryMode&&['queue-auto-finalization-a','queue-auto-finalization-b'].includes(name));const child=new Deno.Command('node',{args:[finalizationOnly?finalizationLauncher:launcher],cwd:repo+'/backend',env,clearEnv:true,stdout:'piped',stderr:'piped'}).spawn();const running={child,output:child.output(),name};children.push(running);return running;}
async function stop(r:Running){try{r.child.kill('SIGTERM');}catch{}let timer:ReturnType<typeof setTimeout>|undefined;
 const output=await Promise.race([r.output,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{try{r.child.kill('SIGKILL');}catch{}reject(Error('CLI_STOP_TIMEOUT'));},10000);})]).finally(()=>clearTimeout(timer));
 await Deno.writeFile(root+'/'+r.name+'-private.log',new Uint8Array([...output.stdout,...output.stderr]),{mode:0o600,createNew:true});
 assert.equal(output.code,0,'ACTUAL_NODE_RUNNER_FAILED');const codes=new TextDecoder().decode(output.stderr).trim().split(/\s+/).filter(Boolean);assert.ok(codes.includes('WORKER_QUEUE_READY'));assert.ok(codes.every(x=>['WORKER_QUEUE_READY','WORKER_QUEUE_RECONCILIATION_REQUIRED'].includes(x)));children.splice(children.indexOf(r),1);
}
async function retirementDigest(id:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('retirement:v1:'+id));return[...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('');}
const retirementState=async()=>JSON.parse(await control('--retirement-proof'));
function retirementRequest(token:string|undefined,body:unknown){return new Request(origin+'/functions/v1/service-api/me/retirement',{method:'POST',headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json'},body:JSON.stringify(body)});}
async function firstPublicResponseLoss(send:()=>Promise<Response>,proof:()=>{gatewayExact200:boolean;lost:boolean;mutationCalls:number;publicPosts:number}){
 let response:Response|undefined,clientStatus:number|'UNKNOWN'='UNKNOWN',lossAt:'fetch'|'body'|undefined;
 try{response=await send();}catch(error){assert.ok(error instanceof TypeError,'FIRST_PUBLIC_FETCH_FAILURE_TYPE_NOT_ALLOWED');lossAt='fetch';}
 if(response){
  clientStatus=response.status;assert.equal(clientStatus,200,'FIRST_PUBLIC_CLIENT_NON200_NOT_LOSS');
  try{await response.json();}catch{lossAt='body';}
 }
 const stored=proof();assert.equal(stored.gatewayExact200,true,'EXACT_PROCESSING_GATEWAY_200_REQUIRED');assert.equal(stored.lost,true,'CONTROLLED_PUBLIC_RESPONSE_LOSS_REQUIRED');assert.equal(stored.mutationCalls,1);assert.equal(stored.publicPosts,1);assert.ok(lossAt,'FIRST_PUBLIC_RESPONSE_WAS_NOT_LOST');
 // 수신하지 못한 status는 UNKNOWN이다. 실제 gateway의 검증된 200과 소비자 관찰을 구분한다.
 return{clientStatus,gatewayStatus:200,lossAt};
}
async function publicRetirementStart(){
 assert.ok(retirementMode&&publicSession);const initial=await retirementState();assert.equal(initial.retirements,0);assert.equal(initial.tasks,0);assert.equal(initial.acks,0);assert.equal(initial.dispatches,0);assert.equal(initial.authUsers,1);assert.ok(initial.authSessions>0);assert.equal(initial.memberBytesPresent,true);
 const disabled=createRuntimeHandler(key=>values[key]);const callCounts=[retirementCalls,retirementReceiptCalls,publicAuthStatuses.length];const denied=await disabled(retirementRequest(publicSession.token,{withdrawalId:fixture.cleanupWithdrawal}));assert.equal(denied.status,404);assert.deepEqual([retirementCalls,retirementReceiptCalls,publicAuthStatuses.length],callCounts);
 retirementEvidence.push({phase:'default_factory_closed',status:404,count:0});
 const user=await realFetch(origin+'/auth/v1/user',{method:'GET',headers:{authorization:'Bearer '+publicSession.token,apikey:f.anonKey},client}as unknown as RequestInit);assert.equal(user.status,200);assert.equal((await user.json()).id,fixture.cleanupMember);
 const first=await firstPublicResponseLoss(()=>realFetch(retirementRequest(publicSession.token,{withdrawalId:fixture.cleanupWithdrawal}),{client}as unknown as RequestInit),()=>({gatewayExact200:retirementEvidence.filter(e=>e.phase==='first_response_lost_after_commit'&&e.status===200&&e.count===1).length===1,lost:publicResponseLost,mutationCalls:retirementCalls,publicPosts:publicPostCalls}));assert.equal(retirementReceiptCalls,0);retirementEvidence.push({phase:'first_client_response_loss_confirmed',...first,count:1});
 const processing=await retirementState();assert.equal(processing.retirements,1);assert.equal(processing.state,'pending_cleanup');assert.equal(processing.fingerprint,await retirementDigest(fixture.cleanupWithdrawal));assert.equal(processing.episodeMatches,true);assert.equal(processing.profileScrubbed,true);assert.equal(processing.activeEpisodes,0);assert.equal(processing.naverLinked,0);assert.equal(processing.authSessions,0);assert.equal(processing.authUsers,1);assert.equal(processing.memberBytesPresent,true);assert.equal(processing.canaryUnchanged,true);assert.equal(processing.tasks,2);assert.deepEqual(processing.tasksByKind,{auth_user:1,storage_object:1});assert.equal(processing.tasksPending,2);assert.equal(processing.acks,0);assert.equal(processing.dispatches,0);assert.equal(processing.memberJobCount,0);
 // 실제 입력·생성 task 수로 계산하고 제품 효과는 후속 DB 감사로 확인한다. 상세 수집 하나는 고정 합성 제공사 응답에 속한다.
 assert.equal(processing.nonMemberSeededJobs,4);assert.equal(processing.dueCancellationInputs,fixture.cancelCount);assert.equal(processing.dueReports,1);
 expectedJobs=processing.nonMemberSeededJobs+processing.dueCancellationInputs+processing.dueReports+1+processing.tasks;
 const retry=await realFetch(retirementRequest(publicSession.token,{withdrawalId:fixture.cleanupWithdrawal}),{client}as unknown as RequestInit);assert.equal(retry.status,200);assert.ok(JSON.stringify((await retry.json()).data)===JSON.stringify({withdrawalId:fixture.cleanupWithdrawal,status:'processing',memberAccessRevoked:true}),'PUBLIC_PROCESSING_RECEIPT_MISMATCH');assert.equal(retirementCalls,1);assert.equal(retirementReceiptCalls,1);assert.ok([401,403].includes(publicAuthStatuses.at(-1)!));
 const after=await retirementState();assert.deepEqual(after,processing);assert.deepEqual([memberStorageDeleteCalls,memberAuthDeleteCalls],[0,0]);retirementEvidence.push({phase:'manual_same_key_processing_get_only',status:200,count:1,unchanged:true});
 const cases:[string,string|undefined,unknown,number][]=[
  ['different_id',publicSession.token,{withdrawalId:publicSession.otherWithdrawalId},401],
  ['extra_field',publicSession.token,{withdrawalId:fixture.cleanupWithdrawal,extra:true},400],
  ['no_token',undefined,{withdrawalId:fixture.cleanupWithdrawal},401],
  ...['expired','wrong_signature','wrong_issuer','wrong_audience','wrong_sub','anonymous'].map(name=>[name,publicSession.negativeTokens[name],{withdrawalId:fixture.cleanupWithdrawal},401]as[string,string,unknown,number]),
 ];
 for(const[name,token,body,status]of cases){const mutationCount:number=retirementCalls;const response=await realFetch(retirementRequest(token,body),{client}as unknown as RequestInit);assert.equal(response.status,status);await response.body?.cancel();assert.equal(retirementCalls,mutationCount);retirementEvidence.push({phase:'negative_'+name,status,unchanged:true});}
 const receiptsBefore=retirementReceiptCalls;retirementAuthUnavailable=true;
 try{const response=await realFetch(retirementRequest(publicSession.token,{withdrawalId:fixture.cleanupWithdrawal}),{client}as unknown as RequestInit);assert.equal(response.status,503);assert.equal((await response.json()).error.code,'EXTERNAL_UNAVAILABLE');assert.equal(retirementReceiptCalls,receiptsBefore);assert.equal(retirementCalls,1);retirementEvidence.push({phase:'auth_unavailable_no_receipt',status:503,count:0});}finally{retirementAuthUnavailable=false;}
 assert.deepEqual(await retirementState(),processing);await Deno.writeTextFile(root+'/public-retirement-processing-proof.json',JSON.stringify({processing,firstResponse:first,expectedJobs,mutationCalls:retirementCalls,seededTasks:0,memberDeleteCalls:0}),{mode:0o600,createNew:true});
}
async function publicRetirementCompleted(){
 assert.ok(retirementMode);const before=await retirementState();assert.equal(before.state,'completed');assert.equal(before.tasksCompleted,2);assert.equal(before.memberJobsSucceeded,2);assert.equal(before.authUsers,0);assert.equal(before.authSessions,0);assert.equal(before.memberBytesAbsent,true);assert.equal(before.canaryUnchanged,true);assert.equal(before.profileScrubbed,true);assert.equal(before.episodeMatches,true);
 const memberAckCount=()=>events.filter(event=>event.name==='record_member_cleanup_delete_ack').length;
 assert.equal(memberAckCount(),2);assert.equal(before.acks,2);assert.equal(before.dispatches,2);
 const counters=[retirementCalls,memberStorageDeleteCalls,memberAuthDeleteCalls,memberAckCount()];const receiptBefore=retirementReceiptCalls;const response=await realFetch(retirementRequest(publicSession.token,{withdrawalId:fixture.cleanupWithdrawal}),{client}as unknown as RequestInit);assert.equal(response.status,200);assert.ok(JSON.stringify((await response.json()).data)===JSON.stringify({withdrawalId:fixture.cleanupWithdrawal,status:'completed',memberAccessRevoked:true}),'PUBLIC_COMPLETED_RECEIPT_MISMATCH');assert.ok([401,403].includes(publicAuthStatuses.at(-1)!));assert.deepEqual([retirementCalls,memberStorageDeleteCalls,memberAuthDeleteCalls,memberAckCount()],counters);assert.equal(retirementReceiptCalls,receiptBefore+1);assert.equal(retirementCalls,1);assert.deepEqual(await retirementState(),before);retirementEvidence.push({phase:'manual_same_key_completed_get_only',status:200,unchanged:true});
 await Deno.writeTextFile(root+'/public-retirement-completed-proof.json',JSON.stringify({completed:before,mutationCalls:1,extraDeleteAck:0,originalSessionReceipt:true,expectedJobs}),{mode:0o600,createNew:true});
}
let budgetAttempted=false,budgetCommitted=false;
let budgetContext:any,budgetStoredGate:any;
const budgetQueueCompletions=new Map<string,string>();
const budgetTrace:{phase:string;token:string|null;used?:number;remaining?:number;remainingMs?:number;expiresAt?:string|null;requestId?:string|null}[]=[];
function budgetScope(proof:any,slots:any){
 const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
 const keys=(v:any,expected:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&JSON.stringify(Object.keys(v).sort())===JSON.stringify([...expected].sort());
 assert.ok(keys(proof,['serverNow','lease','jobs','slotIds','slotGlobals','expectedIdentityIds','parents','unconfirmed','originalDigest','dueCounts','effects']));
 assert.ok(keys(slots,['used','remaining']));assert.deepEqual(slots,{used:20,remaining:0});
 assert.ok(keys(proof.lease,['token','expiresAt'])&&uuid(proof.lease.token));
 const expiry=Date.parse(proof.lease.expiresAt),now=Date.parse(proof.serverNow);assert.ok(Number.isFinite(expiry)&&Number.isFinite(now)&&expiry>now);
 assert.match(proof.originalDigest,/^[0-9a-f]{64}$/);assert.equal(proof.unconfirmed,0);assert.deepEqual(proof.dueCounts,{helpful:0,terminal:0,runtime:0});
 assert.equal(proof.parents.length,2);assert.equal(new Set(proof.parents.map((r:any)=>r.requestId)).size,2);
 for(const r of proof.parents){
  assert.ok(uuid(r.requestId));assert.equal(r.token,proof.lease.token);assert.equal(r.kind,'cancellation_safety');assert.equal(r.state,'completed');assert.equal(r.dispatchStarted,true);assert.equal(r.limit,10);assert.equal(r.claimCalls,10);assert.equal(r.auditClaims,10);assert.equal(r.auditSucceeded,10);
  assert.deepEqual(r.result,{status:'ran',counts:{claimed:10,succeeded:10,retried:0,failed:0,superseded:0,yielded:0}});
  assert.ok(Number.isInteger(r.remainingMs)&&r.remainingMs>0&&r.remainingMs<=60000);assert.ok(Date.parse(r.deadline)<=expiry&&Date.parse(r.deadline)>Date.parse(r.createdAt)&&Date.parse(r.deadline)-Date.parse(r.createdAt)<=r.remainingMs);
 }
 assert.equal(proof.jobs.length,20);assert.ok(proof.jobs.every((j:any)=>uuid(j.jobId)&&uuid(j.identityId)&&j.status==='succeeded'));
 const jobIds=proof.jobs.map((j:any)=>j.jobId).sort();assert.equal(new Set(jobIds).size,20);assert.deepEqual([...proof.slotIds].sort(),jobIds);
 const identities=proof.jobs.map((j:any)=>j.identityId).sort();assert.equal(new Set(identities).size,20);assert.deepEqual(identities,[...proof.expectedIdentityIds].sort());assert.deepEqual(proof.slotGlobals,[proof.lease.token]);
 assert.ok(keys(proof.effects,['expiredHelpful','canaryHelpful','expiredTerminal','canaryTerminal','expiredRuntime','canaryRuntime']));assert.ok(Object.values(proof.effects).every(v=>v===null));
 return{parentIds:proof.parents.map((r:any)=>r.requestId).sort(),globalToken:proof.lease.token,expiresAt:proof.lease.expiresAt,originalDigest:proof.originalDigest,jobIds,slotProof:slots};
}
function budgetPreparedCas(requestId:string){
 const prepared=events.findIndex(e=>e.name==='prepare_queue_invocation'&&e.requestId===requestId);
 const claims=events.filter(e=>e.name==='claim_queue_invocation_dispatch'&&e.requestId===requestId);
 assert.equal(claims.length,1);assert.equal(claims[0].claimed,true);
 assert.ok(prepared>=0&&events.indexOf(claims[0])>prepared,'ACTUAL_PREPARE_BEFORE_SINGLE_CAS_REQUIRED');
 return claims[0];
}
async function budgetQueueGate(value:any,signal:AbortSignal){
 if(!budgetMode||value.kind!=='cancellation_safety'||value.state!=='completed'||budgetCommitted||budgetAttempted||budgetQueueCompletions.has(value.requestId))return;
 const live=()=>{if(signal.aborted)throw Error('BUDGET_GATE_ABORTED_NO_NEXT_CALL');};live();
 assert.equal(value.limit,10);assert.deepEqual(value.result,{status:'ran',counts:{claimed:10,succeeded:10,retried:0,failed:0,superseded:0,yielded:0}});budgetQueueCompletions.set(value.requestId,value.globalToken);
 const proof=JSON.parse(await control('--budget-proof',signal));live();
 assert.deepEqual(proof.dueCounts,{helpful:0,terminal:0,runtime:0});
 if(budgetQueueCompletions.size===1){assert.equal(proof.jobs.length,10);assert.equal(proof.slotIds.length,10);assert.equal(proof.parents.length,1);return;}
 assert.equal(budgetQueueCompletions.size,2);assert.equal(new Set(budgetQueueCompletions.values()).size,1);
 const slots=await atomic.slots(value.globalToken);live();const context=budgetScope(proof,slots);
 assert.deepEqual(context.parentIds,[...budgetQueueCompletions.keys()].sort());
 for(const id of context.parentIds)budgetPreparedCas(id);
 live();budgetAttempted=true;budgetContext=Object.freeze(context);
 await Deno.writeTextFile(root+'/budget-gate-context-private.json',JSON.stringify(context),{mode:0o600,createNew:true});live();
 const committed=JSON.parse(await control('--budget-insert',signal));live();assert.deepEqual(committed,{status:'EXPIRED_FIXTURES_COMMITTED',fixtureMutations:1,originalScopeUnchanged:true,used:20,remaining:0});
 budgetStoredGate=JSON.parse(await Deno.readTextFile(root+'/budget-gate-stored-proof-private.json'));live();
 assert.equal(budgetStoredGate.after.originalDigest,context.originalDigest);assert.deepEqual(budgetStoredGate.after.lease,proof.lease);assert.deepEqual(budgetStoredGate.after.dueCounts,{helpful:1,terminal:1,runtime:1});
 budgetCommitted=true;budgetTrace.push({phase:'SECOND_PARENT_STORED_20_GATE_COMMITTED',token:context.globalToken,used:20,remaining:0,expiresAt:context.expiresAt});
}
async function reconcileOriginalMember(first:Running,second:Running):Promise<[Running,Running]>{
 await until(async()=>{const p=await snapshot();return !!interruptedOrigin&&p.invocations.some((r:any)=>r.requestId===interruptedOrigin.parent&&r.state==='unknown');},'PHYSICAL_MEMBER_ACK_UNKNOWN_REQUIRED',60000);
 assert.equal(blockedTaskComplete,1);const before=await snapshot();assert.equal(before.queueSessions,2);
 assert.equal(before.five.memberOriginalAcks,interruptedKind==='storage_object'?1:2);
 assert.equal(before.five.memberOriginalDispatches,before.five.memberOriginalAcks);
 assert.equal(memberStorageDeleteCalls,1);assert.equal(memberAuthDeleteCalls,interruptedKind==='storage_object'?0:1);
 assert.equal(events.filter(e=>e.name==='complete_member_cleanup_task'&&e.forwarded&&e.token===interruptedOrigin.parentToken).length,interruptedKind==='storage_object'?0:1);
 await stop(first);await stop(second);
 const eventCount=events.length,counters=[deleteCalls,memberStorageDeleteCalls,memberAuthDeleteCalls,providerListCalls,providerDetailCalls,modelCalls];
 const restarted=launch('queue-original-unknown-restart');await until(async()=>(await snapshot()).queueSessions===1,'ORIGINAL_UNKNOWN_RESTART_REQUIRED');await delay(1200);
 assert.deepEqual([deleteCalls,memberStorageDeleteCalls,memberAuthDeleteCalls,providerListCalls,providerDetailCalls,modelCalls],counters);
 const idle=events.slice(eventCount);assert.ok(idle.some(e=>e.name==='read_worker_runtime_pending_v2'&&e.pending===true&&e.httpStatus===200&&e.caller==='approved-launcher'));
 assert.ok(idle.every(e=>recoveryObservationAllowed(e,interruptedOrigin.parent)));
 const stillUnknown=await snapshot();assert.deepEqual(stillUnknown.invocations,before.invocations);assert.deepEqual(stillUnknown.intents,before.intents);assert.deepEqual(stillUnknown.five.memberOrigins,before.five.memberOrigins);
 await stop(restarted);
 // 원 기한을 바꾸지 않는다. 짧은 간격의 DB 조회와 30초 진행 표식으로 자연 만료를 기다린다.
 let last=performance.now();await until(async()=>{const p=await snapshot();if(performance.now()-last>=30000){console.log('ORIGINAL_MEMBER_DEADLINE_WAIT_GET_ONLY');last=performance.now();}return Date.parse(p.lease.expiresAt)<=Date.parse(p.serverNow);},'ORIGINAL_GLOBAL_NATURAL_EXPIRY_REQUIRED',185000);
 const expired=await snapshot();assert.equal(expired.lease.token,interruptedOrigin.parentToken);
 const originalUnchanged=(p:any)=>{const o=p.five.memberOrigins.find((v:any)=>v.taskId===interruptedOrigin.taskId);assert.ok(o);for(const k of ['scopeHash','parent','parentToken','dispatchHash','ackHash','originalLease','originalAckSha256','claimCalls'])assert.equal(o[k],interruptedOrigin[k],k);return o;};originalUnchanged(expired);
 await control('--recovery-open');
 await until(async()=>{const response=await harnessFetch(origin+'/rest/v1/rpc/get_member_cleanup_reconcile',{method:'POST',headers:{authorization:'Bearer '+f.serviceKey,apikey:f.serviceKey,'content-type':'application/json'},body:JSON.stringify({p_recovery_request_id:'00000000-0000-0000-0000-000000000000'})});const value=await response.json();return response.status===404&&value.code==='PT404';},'RECOVERY_GET_ONLY_RPC_PREFLIGHT_REQUIRED',10000);
 const runScope=createWorkerRunScope(createInternalClient(config,harnessFetch)),lease=await runScope.open();assert.ok(lease);assert.equal(lease.owned,true);assert.notEqual(lease.token,interruptedOrigin.parentToken);
 const recoveryRequestId=crypto.randomUUID();
 await Deno.writeTextFile(root+'/member-recovery-request-private.json',JSON.stringify({recoveryRequestId,invocationRequestId:interruptedOrigin.parent,taskId:interruptedOrigin.taskId,recoveryGlobalToken:lease.token}),{mode:0o600,createNew:true});
 const absenceBefore=memberAbsenceReads.length,recoveryBefore=events.length,physicalBefore=[deleteCalls,memberStorageDeleteCalls,memberAuthDeleteCalls];
 const response=await realFetch(origin+'/functions/v1/service-api/internal/member-cleanup/reconcile',{method:'POST',headers:{authorization:'Bearer '+f.internalSecret,'content-type':'application/json','x-worker-run-token':lease.token},body:JSON.stringify({recoveryRequestId,invocationRequestId:interruptedOrigin.parent,taskId:interruptedOrigin.taskId}),client}as unknown as RequestInit);
 assert.equal(response.status,200);const envelope=await response.json();assert.equal(envelope.data.status,'applied');assert.match(envelope.data.evidenceSha256,/^[a-f0-9]{64}$/);
 const reconciled=await snapshot();originalUnchanged(reconciled);assert.equal((await invocation.getQueueInvocation(interruptedOrigin.parent)).state,'unknown');
 const row=reconciled.five.recoveries.find((r:any)=>r.requestId===recoveryRequestId);assert.ok(row);assert.equal(row.state,'completed');assert.equal(row.parent,interruptedOrigin.parent);assert.equal(row.taskId,interruptedOrigin.taskId);assert.equal(row.originalToken,interruptedOrigin.parentToken);assert.equal(row.originalLease,interruptedOrigin.originalLease);assert.equal(row.ackSha256,interruptedOrigin.originalAckSha256);assert.equal(row.targetHash,interruptedOrigin.scopeHash);assert.equal(row.token,lease.token);assert.ok(row.limitMs>0&&row.limitMs<=60000);assert.ok(Date.parse(row.expiresAt)<=Date.parse(lease.expiresAt));assert.notEqual(row.lease,row.originalLease);assert.equal(row.evidenceSha256,envelope.data.evidenceSha256);
 const recoveryEvents=events.slice(recoveryBefore);assert.equal(recoveryEvents.filter(e=>e.name==='begin_member_cleanup_reconcile').length,1);assert.equal(recoveryEvents.filter(e=>e.name==='finish_member_cleanup_reconcile').length,1);assert.ok(recoveryEvents.some(e=>e.name==='get_member_cleanup_delete_ack'));assert.ok(recoveryEvents.filter(e=>e.name==='get_member_cleanup_reconcile').length>=2);assert.ok(recoveryEvents.every(e=>!['begin_member_cleanup_delete','record_member_cleanup_delete_ack','complete_member_cleanup_task','claim_member_cleanup_task'].includes(e.name)));
 assert.deepEqual([deleteCalls,memberStorageDeleteCalls,memberAuthDeleteCalls],physicalBefore);
 const absence=memberAbsenceReads.slice(absenceBefore);for(const kind of interruptedKind==='storage_object'?['storage_info','storage_bytes']:['auth_user'])assert.ok(absence.some(r=>r.kind===kind&&r.absent));
 // 수동 known-ID finalizer 없이 재시작한 실제 큐의 승인된 SQL118 scan이 원 부모만 종결한다.
 assert.equal(await runScope.close(lease),'applied');
 const beforeAutomatic=await snapshot();assert.equal(beforeAutomatic.lease.token,null);
 automaticParentOnly=true;
 const finalizationStart=events.length,finalizers:[Running,Running]=[launch('queue-auto-finalization-a',true),launch('queue-auto-finalization-b',true)];
 await until(async()=>{const p=await snapshot();return p.invocations.some((v:any)=>v.requestId===interruptedOrigin.parent&&v.state==='completed');},'AUTOMATIC_SQL118_PARENT_FINALIZATION_REQUIRED',10000);
 await until(async()=>events.slice(finalizationStart).some(e=>e.caller==='approved-launcher'&&e.name==='get_queue_invocation'&&e.requestId===interruptedOrigin.parent&&e.resultState==='completed'),'AUTOMATIC_STORED_PARENT_GET_REQUIRED',10000);
 await until(async()=>{try{return(await Deno.readTextFile(directAcquireCounter)).trim().split('\n').filter(Boolean).length>=2;}catch{return false;}},'DIRECT_ACQUIRE_BUSY_OBSERVED_REQUIRED',5000);
 const blockedDirectAcquire=(await Deno.readTextFile(directAcquireCounter)).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 for(const entry of blockedDirectAcquire){assert.deepEqual(Object.keys(entry).sort(),['phase','pid']);assert.equal(entry.phase,'DIRECT_ACQUIRE_BUSY');assert.ok(Number.isSafeInteger(entry.pid)&&entry.pid>0);}
 assert.equal(new Set(blockedDirectAcquire.map(entry=>entry.pid)).size,2,'BOTH_AUTOMATIC_FINALIZERS_MUST_BLOCK_DIRECT_ACQUIRE');
 assert.deepEqual([...new Set(blockedDirectAcquire.map(entry=>entry.pid))].sort((a,b)=>a-b),finalizers.map(r=>r.child.pid).sort((a,b)=>a-b),'DIRECT_ACQUIRE_PID_SET_MUST_MATCH_ACTUAL_FINALIZERS');
 const automatic=events.slice(finalizationStart).filter(e=>e.caller==='approved-launcher');
 assert.ok(automatic.some(e=>e.name==='read_member_cleanup_unknown_invocations'));
 assert.ok(automatic.some(e=>e.name==='get_queue_invocation'&&e.requestId===interruptedOrigin.parent));
 assert.ok(automatic.some(e=>e.name==='complete_queue_invocation'&&e.requestId===interruptedOrigin.parent&&e.resultState==='completed'));
 assert.ok(automatic.every(e=>recoveryObservationAllowed(e,interruptedOrigin.parent,true)));
 assert.ok(automatic.filter(e=>e.name==='acquire_worker_run').every(e=>e.forwarded===false));
 const afterAutomatic=await snapshot();assert.deepEqual(afterAutomatic.lease,beforeAutomatic.lease);assert.deepEqual(afterAutomatic.intents,beforeAutomatic.intents);assert.equal(afterAutomatic.invocations.length,beforeAutomatic.invocations.length);
 assert.deepEqual(afterAutomatic.invocations.filter((r:any)=>r.requestId!==interruptedOrigin.parent),beforeAutomatic.invocations.filter((r:any)=>r.requestId!==interruptedOrigin.parent));
 assert.deepEqual(afterAutomatic.five.memberOrigins,beforeAutomatic.five.memberOrigins);assert.equal(afterAutomatic.five.memberOriginalAcks,beforeAutomatic.five.memberOriginalAcks);assert.equal(afterAutomatic.five.memberOriginalDispatches,beforeAutomatic.five.memberOriginalDispatches);
 const original=await invocation.getQueueInvocation(interruptedOrigin.parent);assert.equal(original.state,'completed');assert.equal(original.globalToken,interruptedOrigin.parentToken);assert.ok(original.result&&'counts'in original.result);assert.equal(original.result.counts.succeeded,interruptedKind==='storage_object'?1:2);originalUnchanged(await snapshot());
 assert.deepEqual([deleteCalls,memberStorageDeleteCalls,memberAuthDeleteCalls],physicalBefore);
 await stop(finalizers[0]);await stop(finalizers[1]);automaticParentOnly=false;
 recoveryEvidence={original:interruptedOrigin,recovery:row,originalParentStoredResult:original.result,recoveryWireEvents:recoveryEvents,automaticParentEvents:automatic.filter(e=>['read_member_cleanup_unknown_invocations','get_queue_invocation','complete_queue_invocation'].includes(e.name)),automaticScope:'SQL118_ISOLATED_DIRECT_ACQUIRE_BUSY',blockedDirectAcquire:blockedDirectAcquire.length,manualKnownIdFinalization:0,actualAbsentReads:absence,naturalExpiryServerNow:expired.serverNow,newRecoveryGlobalToken:lease.token,subsequentUnclaimedAuthSeparateCycle:interruptedKind==='storage_object'};
 return[launch('queue-after-recovery-a'),launch('queue-after-recovery-b')];
}
async function runBudgetMaintenance(first:Running,second:Running){
 const kinds=['helpful_maintenance','terminal_maintenance','runtime_maintenance'];
 await until(async()=>{const p=await snapshot();return budgetCommitted&&p.succeeded===20&&kinds.every(kind=>p.invocations.some((r:any)=>r.kind===kind&&r.state==='completed'));},'REAL20_ZERO_REMAINING_MAINTENANCE_NOT_PROVEN',90000);
 const p=await snapshot(),stored=JSON.parse(await control('--budget-proof'));assert.equal(p.queueSessions,2);assert.equal(p.jobs,20);assert.equal(p.succeeded,20);assert.equal(p.slots,20);assert.equal(p.maxSlots,20);assert.equal(stored.originalDigest,budgetContext.originalDigest);assert.deepEqual([...stored.slotIds].sort(),budgetContext.jobIds);
 assert.equal(p.invocations.length,5);assert.equal(p.intents.every((r:any)=>r.state==='confirmed'&&r.confirmed&&r.dispatched),true);
 assert.equal(new Set(p.invocations.map((r:any)=>r.token)).size,1);assert.ok(p.invocations.every((r:any)=>r.token===budgetContext.globalToken&&r.state==='completed'));
 const queue=p.invocations.filter((r:any)=>r.kind==='cancellation_safety');assert.equal(queue.length,2);
 for(const r of queue){assert.equal(r.limit,10);assert.equal(r.result.counts.claimed,10);assert.equal(r.result.counts.succeeded,10);}
 const results=[];
 for(const kind of kinds){
  const rows=p.invocations.filter((r:any)=>r.kind===kind);assert.equal(rows.length,1);const r=rows[0];assert.equal(r.limit,20);assert.deepEqual(r.result,{purged:1,processedItems:20});assert.ok(r.remainingMs>0&&r.remainingMs<=180000);assert.ok(Date.parse(r.deadline)<=Date.parse(budgetContext.expiresAt));
  budgetPreparedCas(r.requestId);
  const requestName=kind==='helpful_maintenance'?'purge_ai_feedback_scoped':kind==='runtime_maintenance'?'purge_worker_runtime_details_scoped':'execute_worker_runtime_operation';
  const sends=events.filter(e=>e.name===requestName&&e.requestId===r.requestId);assert.equal(sends.length,1);assert.equal(sends[0].token,budgetContext.globalToken);
  const original=await atomic.get(r.requestId);assert.equal(original.requestId,r.requestId);assert.equal(original.state,'completed');assert.deepEqual(original.result,kind==='helpful_maintenance'?{deletedCount:1}:{purged:1});
  const confirmed=await invocation.getQueueInvocation(r.requestId);assert.equal(confirmed.state,'completed');assert.equal(confirmed.globalToken,budgetContext.globalToken);assert.deepEqual(confirmed.result,r.result);results.push({kind,requestId:r.requestId,limit:r.limit,remainingMs:r.remainingMs,result:r.result});
 }
 assert.equal(actualFunctionCalls.length,1);assert.equal(actualFunctionCalls[0].path,'/functions/v1/service-api/internal/ai-feedback-maintenance');assert.equal(actualFunctionCalls[0].requestId,results.find(r=>r.kind==='helpful_maintenance')!.requestId);
 assert.equal(stored.effects.expiredHelpful,null);assert.equal(stored.effects.expiredTerminal,null);
 for(const key of['canaryHelpful','canaryTerminal','canaryRuntime'])assert.deepEqual(stored.effects[key],budgetStoredGate.after.effects[key]);
 const old=budgetStoredGate.after.effects.expiredRuntime,current=stored.effects.expiredRuntime;assert.ok(current);assert.equal(current.state,'purged');assert.equal(current.input,null);assert.equal(current.result,null);assert.ok(current.purged_at);for(const key of['request_id','global_token','operation','fingerprint','created_at','closed_at'])assert.equal(current[key],old[key]);
 const limits=results.map(r=>r.remainingMs);assert.ok(limits.every((v,i)=>i===0||v<=limits[i-1]));assert.ok(budgetTrace.filter(t=>t.phase==='ACTUAL_SLOT_READ'&&t.used===20&&t.remaining===0).length>=4);
 for(const child of p.intents){const writes=events.filter(e=>e.name==='execute_worker_invocation_operation'&&e.requestId===child.requestId);assert.equal(writes.length,1);assert.ok(queue.some((r:any)=>r.requestId===child.parent&&r.token===child.globalToken));}
 assert.deepEqual([deleteCalls,memberStorageDeleteCalls,memberAuthDeleteCalls,providerListCalls,providerDetailCalls,modelCalls,externalCalls,unexpectedRoutes],[0,0,0,0,0,0,0,0]);assert.equal(lost,false);
 await stop(first);await stop(second);await until(async()=>(await snapshot()).lease.token===null,'ORIGINAL_GLOBAL_RELEASE_REQUIRED');
 const final=JSON.parse(await control('--budget-proof'));assert.equal(final.originalDigest,budgetContext.originalDigest);assert.deepEqual([...final.slotIds].sort(),budgetContext.jobIds);
 await Deno.writeTextFile(root+'/budget-maintenance-evidence-private.json',JSON.stringify({context:budgetContext,gate:budgetStoredGate,storedFinal:final,trace:budgetTrace,results,functionCalls:actualFunctionCalls,historicalProducer:'SYNTHETIC_FIXTURE_NOT_ACTUAL_PRODUCER'}),{mode:0o600,createNew:true});
 await control('--close');
 const receipt={status:'PASS',scope:'ISOLATED_STAGE2_REAL_QUEUE20_SAME_GLOBAL_ZERO_REMAINING_MAINTENANCE',scenario,revision,actualCancellationJobs:20,actualQueueParents:2,actualClaimsPerParent:10,uniqueJobSlots:20,remainingQueueSlots:0,manualJobOrSlotInserts:0,initialMaintenanceDue:0,fixtureGateMutations:1,sameOriginalGlobal:true,originalGlobalExpiryUnchanged:true,originalJobSlotScopeUnchanged:true,maintenanceKinds:kinds,maintenanceAllocationPerKind:20,maintenanceActualPurgedPerKind:1,maintenanceTotalProcessedReservations:60,maintenanceQueueSlots:0,parentCasOnce:true,twoRealNodeProcesses:true,sharedProductCliEntry:true,stockDefaultApproval:'MAINTENANCE_ONLY',verifyFullTlsAndMinimumLogin:true,storageAuthContainers:0,realProvider:'NOT_RUN',realMemberLogin:'NOT_RUN',sourceDatabaseChanged:false,operatingChanged:false,externalRequests:0};
 await Deno.writeTextFile(root+'/receipt.json',JSON.stringify(receipt,null,2),{mode:0o600,createNew:true});console.log(JSON.stringify(receipt));
}
function summaryInsufficientScope(context:any,proof:any){
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
 assert.deepEqual(Object.keys(context).sort(),['originalScope','target','sourceRevision','eligibleCount','jobId'].sort());
 assert.deepEqual(Object.keys(context.originalScope).sort(),['jobId','leaseToken','workerRunToken','sourceRevision','contractVersion','parent'].sort());
 for(const key of ['jobId','leaseToken','workerRunToken','parent'])assert.match(context.originalScope[key],uuid);assert.equal(context.originalScope.contractVersion,'2026-10-05');assert.match(context.originalScope.sourceRevision,/^[0-9]+$/);
 assert.ok([0,2].includes(context.eligibleCount));assert.match(context.jobId,uuid);assert.match(context.target,uuid);assert.notEqual(context.jobId,context.originalScope.jobId);
 assert.match(context.sourceRevision,/^[0-9]+$/);assert.ok(BigInt(context.sourceRevision)>BigInt(context.originalScope.sourceRevision));
 assert.equal(proof.jobId,context.jobId);assert.equal(proof.target,context.target);assert.equal(proof.jobRevision,context.sourceRevision);assert.equal(proof.revision,context.sourceRevision);
 assert.equal(proof.eligibleCount,context.eligibleCount);assert.equal(proof.jobStatus,'succeeded');assert.equal(proof.settledStatus,'succeeded');assert.equal(proof.effect,'insufficient');assert.equal(proof.auditClaims,1);
 assert.equal(proof.slotExact,true);assert.equal(proof.visibleNull,true);assert.equal(proof.checkpoints,0);assert.equal(proof.published,0);assert.match(proof.leaseToken,uuid);
 const parent=proof.parent;assert.deepEqual(Object.keys(parent).sort(),['requestId','globalToken','kind','limit','remainingMs','state','result','closedAt'].sort());
 assert.match(parent.requestId,uuid);assert.match(parent.globalToken,uuid);assert.notEqual(parent.requestId,context.originalScope.parent);assert.equal(parent.kind,'review_summary');assert.equal(parent.state,'completed');assert.ok(parent.closedAt);
 assert.ok(Number.isInteger(parent.limit)&&parent.limit>=1&&parent.limit<=10);assert.ok(Number.isInteger(parent.remainingMs)&&parent.remainingMs>=1&&parent.remainingMs<=60000);
 assert.deepEqual(parent.result,{status:'ran',counts:{claimed:1,succeeded:1,retried:0,failed:0,superseded:0,yielded:0}});
 return parent;
}
async function summaryInsufficientFollowup(original:any){
 if(!summaryRace||summaryRace.mutation==='edit')return{status:'NOT_APPLICABLE_ELIGIBLE3'};
 const signal=AbortSignal.timeout(60000),counters=[modelCalls,actualReservations,providerListCalls,providerDetailCalls,deleteCalls,memberStorageDeleteCalls,memberAuthDeleteCalls],offset=events.length,callOffset=actualFunctionCalls.length;
 signal.throwIfAborted();const context=JSON.parse(await control('--summary-insufficient-enqueue',signal));
 assert.deepEqual(context.originalScope,original.summaryRace.scope);assert.equal(context.target,fixture.reviewTarget);assert.equal(context.sourceRevision,original.summaryRace.revision);assert.equal(context.eligibleCount,summaryRace.mutation==='consent'?0:2);
 let proof:any;
 await until(async()=>{signal.throwIfAborted();proof=JSON.parse(await control('--summary-insufficient-proof',signal));return proof.jobStatus==='succeeded'&&proof.parent?.state==='completed';},'LATEST_INSUFFICIENT_PRODUCT_COMPLETION_REQUIRED',60000);
 signal.throwIfAborted();const parent=summaryInsufficientScope(context,proof),stored=await invocation.getQueueInvocation(parent.requestId);signal.throwIfAborted();assert.deepEqual(stored,parent);
 assert.deepEqual([modelCalls,actualReservations,providerListCalls,providerDetailCalls,deleteCalls,memberStorageDeleteCalls,memberAuthDeleteCalls],counters,'LATEST_INSUFFICIENT_EXTRA_PROVIDER_OR_DELETE');
 const calls=events.slice(offset),marks=calls.filter(e=>e.name==='mark_review_summary_insufficient'&&e.jobId===context.jobId);
 assert.equal(marks.length,1);assert.equal(marks[0].sourceRevision,context.sourceRevision);assert.equal(marks[0].token,parent.globalToken);assert.equal(marks[0].httpStatus,200);assert.equal(marks[0].status,'applied');
 assert.equal(calls.filter(e=>e.jobId===context.jobId&&['reserve_review_summary_model','save_review_summary_checkpoint','publish_review_summary_for_job'].includes(e.name)).length,0);
 assert.equal(calls.filter(e=>e.name==='claim_queue_invocation_dispatch'&&e.requestId===parent.requestId&&e.claimed===true).length,1);
 const prepare=calls.findIndex(e=>e.name==='prepare_queue_invocation'&&e.requestId===parent.requestId),cas=calls.findIndex(e=>e.name==='claim_queue_invocation_dispatch'&&e.requestId===parent.requestId);assert.ok(prepare>=0&&cas>prepare);
 const actual=actualFunctionCalls.slice(callOffset);assert.equal(actual.length,1);assert.equal(actual[0].requestId,parent.requestId);assert.equal(actual[0].token,parent.globalToken);assert.equal(actual[0].limit,parent.limit);assert.equal(actual[0].remainingMs,parent.remainingMs);
 signal.throwIfAborted();const after=await snapshot();signal.throwIfAborted();assert.equal(after.jobs,expectedJobs+1);assert.equal(after.succeeded,expectedJobs);assert.ok(after.maxSlots<=20);assert.equal(after.slots,original.slots+1);
 for(const row of original.invocations)assert.deepEqual(after.invocations.find((r:any)=>r.requestId===row.requestId),row);
 assert.deepEqual(after.intents,original.intents);assert.deepEqual(after.ackProofs,original.ackProofs);assert.deepEqual(after.five.memberOrigins,original.five.memberOrigins);assert.deepEqual(after.five.budget,original.five.budget);
 signal.throwIfAborted();assert.deepEqual(JSON.parse(await control('--summary-race-proof',signal)),original.summaryRace);
 const evidence={status:'PASS_LATEST_REVISION_INSUFFICIENT_LOCAL',eligiblePublicTextReviews:context.eligibleCount,actualNewJobs:1,totalActualQueueJobs:after.jobs,maxObservedSlots:after.maxSlots,modelDispatches:0,reservations:0,checkpointWrites:0,publishWrites:0,actualInsufficientEffects:1,actualSucceeded:1,originalSupersededUnchanged:true,context,storedProof:proof};
 await Deno.writeTextFile(root+'/summary-insufficient-evidence-private.json',JSON.stringify(evidence),{mode:0o600,createNew:true});return evidence;
}
function unsupportedReviewUnchanged(before:any,after:any){
 assert.equal(before.status,'queued');assert.equal(before.due,true);assert.equal(before.eligibleCount,3);
 for(const key of ['jobHash','currentLease','leaseExpiresAt','checkpointRows','checkpointIndex','publicationRows','visibleCurrent','slotRows','slotTokens','audit','parents','budget','reservationRows','protectionDigest'])assert.deepEqual(after[key],before[key],'UNSUPPORTED_REVIEW_CHANGED_'+key);
 assert.equal(after.status,'queued');assert.equal(after.due,true);assert.equal(after.slotRows,0);assert.deepEqual(after.audit,[]);assert.deepEqual(after.parents,[]);
}
async function runReviewLane(first:Running,second:Running){
 const initial=JSON.parse(await Deno.readTextFile(root+'/review-lane-initial-private.json'));
 await until(async()=>(await snapshot()).queueSessions===2,'TWO_REAL_NODE_SESSIONS_REQUIRED');
 let completed:any;
 if(reassignmentMode){
  await until(async()=>{const proof=await reviewLaneProof();return proof.status==='succeeded'&&proof.parents.length===1&&proof.parents[0].stored.state==='completed';},'SAME_JOB_REASSIGNMENT_NOT_PROVEN',60000);
  completed=await reviewLaneProof();assert.equal(reviewClaims.length,3);assert.equal(new Set(reviewClaims.map(claim=>claim.lease)).size,3);
  assert.equal(new Set(reviewClaims.map(claim=>claim.jobId)).size,1);assert.equal(new Set(reviewClaims.map(claim=>claim.token)).size,1);assert.equal(new Set(reviewClaims.map(claim=>claim.parent)).size,1);
  assert.equal(completed.slotRows,1);assert.deepEqual(completed.slotTokens,[reviewClaims[0].token]);assert.equal(completed.sourceRevision,initial.sourceRevision);
  assert.deepEqual(completed.audit.map((row:any)=>row.lease),reviewClaims.map(claim=>claim.lease));assert.deepEqual(completed.audit.map((row:any)=>row.settled),['queued','queued','succeeded']);assert.deepEqual(completed.audit.map((row:any)=>row.effect),[null,null,'published']);
  assert.equal(completed.checkpointRows,0);assert.equal(completed.publicationRows,1);assert.equal(completed.visibleCurrent,true);assert.equal(oldLeaseFenceCalls,1);assert.equal(modelCalls,3);assert.equal(actualReservations,3);
  assert.deepEqual(completed.budget,{openCalls:0,settledCalls:3,unknownCalls:3,reservedUnits:0});assert.equal(completed.reservationRows,0);
  const row=completed.parents[0],parent=row.stored;assert.equal(row.claimCalls,4);assert.equal(row.idleSeen,true);assert.equal(parent.globalToken,reviewClaims[0].token);
  assert.deepEqual(parent.result,{status:'ran',counts:{claimed:1,succeeded:1,retried:0,failed:0,superseded:0,yielded:0}});
  const cas=events.filter(e=>e.name==='claim_queue_invocation_dispatch'&&e.requestId===parent.requestId);assert.equal(cas.length,1);assert.equal(cas[0].claimed,true);
  const prepared=events.findIndex(e=>e.name==='prepare_queue_invocation'&&e.requestId===parent.requestId);assert.ok(prepared>=0&&prepared<events.indexOf(cas[0]));
  const call=actualFunctionCalls.filter(call=>call.requestId===parent.requestId);assert.equal(call.length,1);assert.equal(call[0].token,parent.globalToken);assert.equal(call[0].limit,10);assert.equal(call[0].remainingMs,parent.remainingMs);
  assert.equal(events.filter(e=>e.name==='save_review_summary_checkpoint'&&e.status==='applied').length,3);reviewYieldInventory(events,parent.globalToken,fixture.jobId);assert.equal(events.filter(e=>e.name==='publish_review_summary_for_job'&&e.status==='applied').length,1);assert.equal(events.filter(e=>e.name==='complete_job').length,1);
 }else{
  // 유효한 due review 행을 취소-only 승인 조립이 점유하지 않는 실제 관찰 구간이다.
  await delay(1500);completed=await reviewLaneProof();unsupportedReviewUnchanged(initial,completed);
  assert.equal(modelCalls,0);assert.equal(actualReservations,0);assert.equal(reviewClaims.length,0);assert.equal(actualFunctionCalls.length,0);
  assert.equal(events.filter(e=>['prepare_queue_invocation','claim_queue_invocation_dispatch','claim_supported_job','claim_job','publish_review_summary_for_job'].includes(e.name)&&!e.nullSafetyProbeRejected).length,0);
 }
 assert.equal(completed.protectionDigest,initial.protectionDigest);assert.equal(lost,false);assert.deepEqual([deleteCalls,memberStorageDeleteCalls,memberAuthDeleteCalls],[0,0,0]);
 await stop(first);await stop(second);await until(async()=>(await snapshot()).lease.token===null,'LEASE_RELEASE_REQUIRED');
 // 별도 합성 UNKNOWN의 재시작 차단만 검사한다. 만료된 UNKNOWN의 재점유 증거가 아니다.
 await control('--unknown');const originalUnknown=await invocation.getQueueInvocation(f.unknownId);assert.equal(originalUnknown.state,'unknown');
 const before=await snapshot(),beforeLane=await reviewLaneProof(),start=events.length,counters=[modelCalls,actualReservations,oldLeaseFenceCalls];
 const restarted=launch('queue-restarted');await until(async()=>(await snapshot()).queueSessions===1,'RESTART_CONNECTION_REQUIRED');await delay(1200);
 const after=await snapshot(),afterLane=await reviewLaneProof();assert.deepEqual(after.invocations,before.invocations);assert.deepEqual(after.intents,before.intents);assert.deepEqual(after.ackProofs,before.ackProofs);
 for(const key of ['dispatches','deleteAcks','externalPending','succeeded','slots','maxSlots'])assert.equal(after[key],before[key]);
 for(const key of ['jobHash','audit','parents','budget','reservationRows','protectionDigest','slotRows','slotTokens','publicationRows','checkpointRows','visibleCurrent'])assert.deepEqual(afterLane[key],beforeLane[key]);
 assert.deepEqual([modelCalls,actualReservations,oldLeaseFenceCalls],counters);
 const restart=events.slice(start);assert.ok(restart.some(e=>e.name==='read_worker_runtime_pending_v2'&&e.pending===true&&e.httpStatus===200&&e.caller==='approved-launcher'));
 assert.ok(restart.every(e=>e.nullSafetyProbeRejected===true||['get_queue_invocation','read_worker_runtime_pending_v2','read_ai_feedback_maintenance_schedule','read_worker_runtime_maintenance_schedule'].includes(e.name)));
 assert.deepEqual(await invocation.getQueueInvocation(f.unknownId),originalUnknown);await stop(restarted);
 assert.equal(externalCalls,0);assert.equal(unexpectedRoutes,0);await control('--close');
 const receipt={status:'PASS',scope:reassignmentMode?'ISOLATED_REVIEW_NORMAL_YIELD_SAME_JOB_LEASE_REASSIGNMENT':'ISOLATED_VALID_REVIEW_DUE_UNSUPPORTED_BY_CANCELLATION_ONLY_ASSEMBLY',scenario,revision,twoNodeProcesses:true,sharedProductCliEntry:true,serverLiteralApprovedAssembly:reassignmentMode?'REVIEW_ONLY':'CANCELLATION_ONLY',stockDefaultCli:'MAINTENANCE_ONLY',schemaChecksUnchanged:true,queueJobs:1,actualDistinctJobClaims:reassignmentMode?1:0,actualLeaseClaims:reviewClaims.length,uniqueJobSlots:completed.slotRows,globalLeaseCapMs:180000,kindAllocationCapMs:60000,normalYieldSettlements:reassignmentMode?2:0,originalGlobalExpiryUnchanged:true,oldLeasePublishRejectedWithoutEffect:oldLeaseFenceCalls,summaryPublications:completed.publicationRows,localSyntheticModelCalls:modelCalls,unknownRestartNewDispatch:0,expiredUnknownReassignment:'NOT_RUN',sourceDatabaseChanged:false,operatingChanged:false,deleteAndAckCalls:0,fullFiveKinds:'NOT_RUN',realProvider:'NOT_RUN',realAiQuality:'NOT_RUN',realMemberLogin:'NOT_RUN'};
 await Deno.writeTextFile(root+'/review-lane-evidence-private.json',JSON.stringify({initial,completed,claims:reviewClaims,globalLeases:globalLeaseProofs,functionCalls:actualFunctionCalls}),{mode:0o600,createNew:true});
 await Deno.writeTextFile(root+'/receipt.json',JSON.stringify(receipt,null,2),{mode:0o600,createNew:true});console.log(JSON.stringify(receipt));
}
async function runFive(first:Running,second:Running){
 await until(async()=>{const p=await snapshot();return p.queueSessions===2&&p.succeeded===expectedJobs-(summaryRace?1:0)&&p.five.unfinishedJobs===(summaryRace?1:0)&&(!summaryRace||p.summaryRace.jobStatus==='superseded'&&p.summaryRace.settledStatus==='superseded')&&fullKinds.every(kind=>p.invocations.some((r:{kind:string;state:string})=>r.kind===kind&&r.state==='completed'));},'ACTUAL_FIVE_KIND_EFFECTS_NOT_PROVEN',180000);
 const p=await snapshot();assert.equal(p.queueSessions,2);assert.equal(p.jobs,expectedJobs);assert.equal(p.succeeded,expectedJobs-(summaryRace?1:0));assert.equal(p.slots,expectedJobs+(recoveryMode?1:0));assert.ok(p.maxSlots<=20);
 const rows=p.invocations.filter((r:{kind:string})=>fullKinds.includes(r.kind));
 for(const kind of fullKinds){
  const group=rows.filter((r:{kind:string})=>r.kind===kind);assert.ok(group.length>0);
  const expected=kind==='event_sync'?4:kind==='member_cleanup'?2:kind==='cancellation_safety'?fixture.cancelCount:1;
  assert.equal(group.reduce((n:number,r:any)=>n+r.result.counts.succeeded,0),summaryRace&&kind==='review_summary'?0:expected);
  if(summaryRace&&kind==='review_summary'){assert.equal(group.reduce((n:number,r:any)=>n+r.result.counts.superseded,0),1);assert.equal(group.reduce((n:number,r:any)=>n+r.result.counts.claimed,0),1);}
 }
 const tokens=new Set(rows.map((r:any)=>r.token));
 if(scenario==='five-kind-overflow'){assert.ok(tokens.size>=2);assert.equal(p.maxSlots,20);}else if(recoveryMode){assert.ok(tokens.size>=(interruptedKind==='storage_object'?2:1));}else{assert.equal(tokens.size,1);assert.equal(p.maxSlots,expectedJobs);}
 for(const row of rows){
  assert.equal(row.state,'completed');assert.equal(row.result.status,'ran');assert.ok(row.dispatchStarted);
  const cap=row.kind==='member_cleanup'?120000:60000;
  assert.ok(row.limit>=1&&row.limit<=10);assert.ok(row.remainingMs>0&&row.remainingMs<=cap);assert.ok(Date.parse(row.deadline)-Date.parse(row.createdAt)<=cap);
  for(const name of ['failed','retried','superseded','yielded'])assert.equal(row.result.counts[name],summaryRace&&row.requestId===p.summaryRace.scope.parent&&name==='superseded'?1:0);
  const cas=events.filter(e=>e.name==='claim_queue_invocation_dispatch'&&e.requestId===row.requestId);assert.equal(cas.length,1);assert.equal(cas[0].claimed,true);
  assert.ok(events.findIndex(e=>e.name==='prepare_queue_invocation'&&e.requestId===row.requestId)<events.indexOf(cas[0]));
  assert.ok(events.some(e=>e.name==='complete_queue_invocation'&&e.requestId===row.requestId));
  const lease=globalLeaseProofs.filter(p=>p.requestId===row.requestId);assert.equal(lease.length,1);assert.equal(lease[0].token,row.token);
  if(['review_summary','event_sync','member_cleanup'].includes(row.kind)){
   const calls=actualFunctionCalls.filter(c=>c.requestId===row.requestId);assert.equal(calls.length,1);assert.equal(calls[0].token,row.token);assert.equal(calls[0].limit,row.limit);assert.equal(calls[0].remainingMs,row.remainingMs);
  }
 }
 for(const child of p.intents){
  assert.equal(child.state,'confirmed');assert.equal(child.confirmed,true);assert.equal(child.dispatched,true);
  const parent=rows.find((r:any)=>r.requestId===child.parent);assert.ok(parent);assert.equal(child.globalToken,parent.token);
  const writes=events.filter(e=>e.name==='execute_worker_invocation_operation'&&e.requestId===child.requestId);assert.equal(writes.length,1,'CHILD_MUTATION_RETRANSMITTED');assert.equal(writes[0].parent,parent.requestId);assert.equal(writes[0].token,parent.token);
  assert.ok(events.some(e=>e.name==='get_worker_runtime_operation'&&e.requestId===child.requestId));
  if(child.operation==='cancellation_process')assert.equal(writes[0].status,'applied','HELD_IS_NOT_SUCCESS');
 }
 assert.ok(p.intents.length>0);
 const proof=p.five;assert.equal(proof.jobsByKind.review_summary,summaryRace?undefined:1);assert.equal(proof.jobsByKind.event_sync,4);assert.equal(proof.jobsByKind.member_cleanup,2);assert.equal(proof.jobsByKind.cancellation_safety,fixture.cancelCount);assert.equal(proof.jobsByKind.report_retention,1);
 assert.equal(modelCalls,1);assert.equal(actualReservations,1);assert.equal(proof.reservations,0);assert.equal(rawCopyRejectionChecked,true);assert.ok(nilReserveProbes.length>=1);assert.ok(nilReserveProbes.every(status=>['consent_revoked','lease_lost'].includes(status)));
 assert.equal(proof.budget.openCalls,0);assert.equal(proof.budget.settledCalls,1);assert.equal(proof.budget.unknownCalls,1);assert.equal(proof.budget.reservedUnits,0);assert.ok(proof.budget.chargedUnits>0);
 assert.equal(proof.summaryPublished,summaryRace?0:1);assert.equal(proof.summaryVisible,summaryRace?0:1);assert.equal(proof.checkpointRows,0);
 assert.equal(proof.eventRows,1);assert.equal(proof.eventDetails,1);assert.ok(providerListCalls>=2);assert.equal(providerDetailCalls,1);
 assert.equal(proof.auditEffects.filter((a:any)=>a.kind==='review_summary'&&a.effect==='published'&&a.status==='succeeded').length,summaryRace?0:1);
 if(summaryRace){
  assert.equal(summaryRaceCommitted,true);assert.equal(summaryRaceWireCalls,1);assert.equal(summaryRaceEvidence.filter(e=>e.phase==='original_write_rejected'&&e.status==='stale_revision').length,1);
  const race=p.summaryRace;assert.equal(race.jobId,fixture.reviewJobId);assert.equal(race.jobStatus,'superseded');assert.equal(race.settledStatus,'superseded');assert.equal(race.effect,null);assert.equal(race.visibleNull,true);assert.equal(race.checkpoints,0);assert.equal(race.published,0);assert.ok(BigInt(race.revision)>BigInt(race.jobRevision));
  const row=rows.find((r:any)=>r.requestId===race.scope.parent);assert.ok(row);assert.equal(row.token,race.scope.workerRunToken);assert.equal(row.kind,'review_summary');assert.equal(row.result.counts.succeeded,0);assert.equal(row.result.counts.superseded,1);
  assert.equal(race.eligibleCount,{edit:3,hide:2,delete:2,consent:0}[summaryRace.mutation]);assert.equal(race.publicReviewCount,['hide','delete'].includes(summaryRace.mutation)?2:3);assert.equal(race.authorProfilePresent,true);assert.equal(race.originalAppointments,5);
  if(summaryRace.mutation==='consent'){assert.equal(race.authorConsent,false);assert.equal(race.authorWithdrawn,true);}
  if(summaryRace.phase==='checkpoint')assert.equal(events.filter(e=>e.name==='publish_review_summary_for_job'&&e.status==='stale_revision').length,0);
 }
 assert.equal(proof.auditEffects.filter((a:any)=>a.kind==='event_sync'&&a.effect==='event_page_complete'&&a.status==='succeeded').length,3);
 assert.equal(proof.auditEffects.filter((a:any)=>a.kind==='event_sync'&&a.effect==='event_detail_applied'&&a.status==='succeeded').length,1);
 assert.equal(proof.memberCompleted,2);assert.equal(proof.memberOriginalAcks,2);assert.equal(proof.memberOriginalDispatches,2);assert.equal(proof.memberAckChain,2);
 assert.equal(memberLeaseProofs.length,2);assert.equal(new Set(memberLeaseProofs.map(p=>p.taskId)).size,2);
 for(const lease of memberLeaseProofs){assert.equal(lease.exact,true);assert.ok(lease.limitMs>0&&lease.limitMs<=60000);assert.ok(rows.some((r:any)=>r.requestId===lease.parent&&r.kind==='member_cleanup'&&r.token===lease.token));}
 assert.equal(memberStorageDeleteCalls,1);assert.equal(memberAuthDeleteCalls,1);assert.equal(deleteCalls,1);
 assert.equal(p.reportDetails,0);assert.equal(p.deleteAcks,0);assert.equal(p.dispatches,0);assert.equal(p.externalPending,0);assert.equal(p.terminalReceipts,1);assert.equal(p.ackProofs.length,1);
 for(const ack of p.ackProofs){assert.equal(ack.exactInput,true);assert.equal(ack.confirmed,true);assert.equal(ack.lineage,true);assert.equal(ack.state,'completed');assert.equal(ack.result.ackSha256,ack.ackSha256);const original=await atomic.get(ack.requestId);assert.equal(original.state,'completed');assert.deepEqual(original.result,ack.result);}
 const bytes=JSON.parse(await control('--storage-proof'));assert.equal(bytes.deletedBytesAbsent,true);assert.equal(bytes.canaryUnchanged,true);assert.equal(bytes.sourceStorageUnchanged,true);
 const member=JSON.parse(await control('--five-proof'));assert.ok(Object.values(member).every(v=>v===true));
 const summaryLatest=summaryRace?await summaryInsufficientFollowup(p):undefined;
 if(retirementMode)await publicRetirementCompleted();
 if(scenario==='five-kind-response-loss'){assert.equal(lost,true);assert.ok(lostRequestId);assert.ok(lossLeaseMs!==null&&lossLeaseMs>0&&lossLeaseMs<=180000);assert.equal(events.filter(e=>e.name==='execute_worker_invocation_operation'&&e.requestId===lostRequestId).length,1);assert.ok(events.findIndex(e=>e.name==='get_worker_runtime_operation'&&e.requestId===lostRequestId)>events.findIndex(e=>e.name==='execute_worker_invocation_operation'&&e.requestId===lostRequestId));}else assert.equal(lost,false);
 await stop(first);await stop(second);await until(async()=>(await snapshot()).lease.token===null,'LEASE_RELEASE_REQUIRED');
 await control('--unknown');const originalUnknown=await invocation.getQueueInvocation(f.unknownId);assert.equal(originalUnknown.state,'unknown');
 const before=await snapshot(),eventCount=events.length,counters=[deleteCalls,memberStorageDeleteCalls,memberAuthDeleteCalls,providerListCalls,providerDetailCalls,modelCalls];
 const restarted=launch('queue-restarted');await until(async()=>(await snapshot()).queueSessions===1,'RESTART_CONNECTION_REQUIRED');await delay(1200);const after=await snapshot();
 assert.deepEqual(after.invocations,before.invocations);assert.deepEqual(after.intents,before.intents);assert.deepEqual(after.ackProofs,before.ackProofs);assert.deepEqual(after.five.memberOrigins,before.five.memberOrigins);
 for(const key of['dispatches','deleteAcks','externalPending','succeeded','slots','maxSlots'])assert.equal(after[key],before[key]);
 assert.deepEqual(after.five.jobsByKind,before.five.jobsByKind);assert.deepEqual(after.five.auditEffects,before.five.auditEffects);
 assert.deepEqual([deleteCalls,memberStorageDeleteCalls,memberAuthDeleteCalls,providerListCalls,providerDetailCalls,modelCalls],counters);
 const restartEvents=events.slice(eventCount);assert.ok(restartEvents.some(e=>e.name==='read_worker_runtime_pending_v2'&&e.pending===true&&e.httpStatus===200&&e.caller==='approved-launcher'));
 // 실제400/22023 거절이 입증된 정확NULL 사전검사만 제외한다. 나머지 준비·실행·ACK는 신규 전송이다.
 const pendingReads=['get_queue_invocation','read_worker_runtime_pending_v2','read_ai_feedback_maintenance_schedule','read_worker_runtime_maintenance_schedule','read_member_cleanup_unknown_invocations'];
 assert.ok(restartEvents.every(e=>e.nullSafetyProbeRejected===true||pendingReads.includes(e.name)));
 assert.equal(restartEvents.filter(e=>e.nullSafetyProbeRejected===true).length,6);
 assert.deepEqual(await invocation.getQueueInvocation(f.unknownId),originalUnknown);await stop(restarted);
 assert.equal(externalCalls,0);assert.equal(unexpectedRoutes,0);await control('--close');
 const receipt={status:'PASS',scope:summaryRace?'ISOLATED_FIVE_KIND_SUMMARY_RACE_LOCAL_SYNTHETIC':'ISOLATED_FIVE_KIND_LOCAL_SYNTHETIC_PRODUCT_RUNNER',scenario,revision,serverLiteralApprovedAssembly:true,stockDefaultCli:'MAINTENANCE_ONLY',twoNodeProcesses:true,actualQueueJobs:expectedJobs,queueSlotLimit:20,maxObservedSlots:p.maxSlots,globalLeaseMaxMs:180000,memberBatchCapMs:120000,memberTaskCapMs:60000,eventReviewSafetyCapMs:60000,parentCasOnce:true,immutableParentGlobal:true,allFiveDbEffects:!summaryRace,summaryRace:summaryRace?{...summaryRace,mutationCalls:1,originalSummarySuperseded:1,staleRevision:true,noOldVisible:true,checkpointRows:0,signedConsentRpc:summaryRace.mutation==='consent',summarySucceeded:0,otherSucceeded:expectedJobs-1}:undefined,originalStorageAckProofAfterCascade:true,childResponseLostAndOriginalKeyRead:scenario==='five-kind-response-loss',unknownRestartNewDispatch:0,memberStorageDeletes:1,memberAuthDeletes:1,reportStorageDeletes:1,realProvider:'NOT_RUN',realAiQuality:'NOT_RUN',realMemberLogin:'NOT_RUN',physicalOriginal115Recovery:recoveryMode?'PASS':'NOT_RUN',recoveryEvidence:recoveryMode?{taskKind:interruptedOrigin.kind,originalParent:interruptedOrigin.parent,taskCompleteWireBlocked:1,originalScopeUnchanged:true,extraDeleteAndAck:0,naturalDeadlineExpiry:true}:undefined,publicMemberRetirementPipeline:retirementMode?'PASS_LOCAL_SIGNED_POST_PHYSICAL_RECOVERY_AUTO_PARENT_COMPLETED_RECEIPT':'NOT_RUN_MANUALLY_SEEDED_CLEANUP',publicRetirement:retirementMode?{actualLocalSignedSession:true,expectedIssuerFromAuthConfig:true,mutationCalls:retirementCalls,receiptGetCalls:retirementReceiptCalls,publicPostCalls,firstResponseLost:publicResponseLost,taskSeeds:0,manualKnownIdFinalization:0,negativeControls:retirementEvidence.filter(e=>e.phase.startsWith('negative_')).length,noAckContrast:{origin:'SYNTHETIC_SQL_NO_ACK',receiptSha256:'9e1a4b4c3e2a45cafcd10840df5869689b5e07d2f92b94de1be0e9a4e0eface7',sameRecipe:'NOT_RUN'}}:undefined,sourceDatabaseChanged:false,sourceStorageChanged:false,operatingChanged:false,externalRequests:0};
 if(summaryRace){Object.assign(receipt,{latestRevisionInsufficient:summaryLatest,wallclockMidnightBoundary:'NOT_RUN'});await Deno.writeTextFile(root+'/summary-race-evidence-private.json',JSON.stringify({scenario,stages:summaryRaceEvidence,storedProof:p.summaryRace,latestRevisionInsufficient:summaryLatest}),{mode:0o600,createNew:true});}
 if(recoveryMode)await Deno.writeTextFile(root+'/member-recovery-evidence-private.json',JSON.stringify(recoveryEvidence),{mode:0o600,createNew:true});
 await Deno.writeTextFile(root+'/five-claim-evidence-private.json',JSON.stringify({memberTaskLeases:memberLeaseProofs,globalLeases:globalLeaseProofs,functionCalls:actualFunctionCalls}),{mode:0o600,createNew:true});
 await Deno.writeTextFile(root+'/receipt.json',JSON.stringify(receipt,null,2),{mode:0o600,createNew:true});console.log(JSON.stringify(receipt));
}
try{
 await control('--fixture');assert.ok(Object.values(JSON.parse(await Deno.readTextFile(root+'/tls-role-evidence.json'))).every(x=>x===true));
 if(fiveMode)await assembleFiveHandlers();
 if(reviewLaneMode){fixture=JSON.parse(await Deno.readTextFile(root+'/review-lane-fixture-private.json'));if(reassignmentMode)await assembleReviewLaneHandler();}
 if(budgetMode)functionHandlers['/functions/v1/service-api/internal/ai-feedback-maintenance']=createRuntimeHandler(k=>values[k]);
 if(retirementMode)await publicRetirementStart();
 await until(async()=>{try{await invocation.getQueueInvocation('00000000-0000-0000-0000-000000000000');}catch(e){return e instanceof HttpError&&toPublicError(e).error.code==='RESOURCE_NOT_FOUND';}return false;},'HTTP_PREFLIGHT_REQUIRED');
 const first=launch('queue-a'),second=launch('queue-b');
 if(fiveMode){
  if(recoveryMode){const continued=await reconcileOriginalMember(first,second);await runFive(continued[0],continued[1]);}else await runFive(first,second);
 }else if(reviewLaneMode){await runReviewLane(first,second);
 }else if(budgetMode){await runBudgetMaintenance(first,second);
 }else if(deleteLoss){
  await until(async()=>{const p=await snapshot();return lost&&p.externalPending===1&&p.invocations.some((r:{state:string})=>r.state==='unknown');},'DELETE_LOSS_MUST_PRESERVE_UNKNOWN',30000);
  const proof=await snapshot();assert.equal(proof.queueSessions,2);assert.equal(deleteCalls,1);assert.equal(proof.deleteAcks,0);assert.equal(proof.succeeded,0);assert.equal(proof.slots,1);assert.equal(proof.dispatches,1);
  assert.equal(events.filter(x=>x.name==='execute_worker_invocation_operation'&&['report_storage_ack','report_task_complete'].includes(x.operation??'')&&x.requestId!==null).length,0);
  const bytes=JSON.parse(await control('--storage-proof'));assert.equal(bytes.deletedBytesAbsent,true);assert.equal(bytes.canaryUnchanged,true);
  await stop(first);await stop(second);const before=await snapshot(),eventCount=events.length;
  const restarted=launch('queue-restarted');await until(async()=>(await snapshot()).queueSessions===1,'DELETE_LOSS_RESTART_REQUIRED');await delay(1200);const after=await snapshot();
  assert.equal(after.invocations.length,before.invocations.length);assert.equal(after.intents.length,before.intents.length);assert.equal(after.deleteAcks,0);assert.equal(deleteCalls,1);assert.equal(after.externalPending,1);
  assert.ok(events.slice(eventCount).some(x=>x.name==='read_worker_runtime_pending_v2'));
  assert.ok(events.slice(eventCount).every(x=>x.requestId===null||!['prepare_queue_invocation','claim_queue_invocation_dispatch','prepare_worker_invocation_intent','execute_worker_invocation_operation'].includes(x.name)));
  await stop(restarted);assert.equal(externalCalls,0);assert.equal(unexpectedRoutes,0);await control('--close');
  const receipt={status:'PASS',scope:'ISOLATED_STORAGE114_DELETE_RESPONSE_LOSS',scenario,revision,twoNodeProcesses:true,stockDefaultCli:'MAINTENANCE_ONLY_TRUSTED_SERVER_TEST_ASSEMBLY',actualDeletedBytes:1,originalDispatches:1,originalDeleteCalls:1,restartedExtraDelete:0,ackWrites:0,taskCompleteWrites:0,externalPendingRetained:true,unknownRetained:true,queueSlots:1,unrelatedCanaryUnchanged:true,sourceStorageUnchanged:true,sourceDatabaseChanged:false,operatingChanged:false,fullFiveKinds:'NOT_RUN',realMemberLogin:'NOT_RUN'};
  await Deno.writeTextFile(root+'/receipt.json',JSON.stringify(receipt,null,2),{mode:0o600,createNew:true});console.log(JSON.stringify(receipt));
 }else{
 await until(async()=>{const p=await snapshot();return p.succeeded===expectedJobs&&p.invocations.some((x:{kind:string;state:string})=>x.kind===kind&&x.state==='completed');},'ACTUAL_SAFETY_EFFECT_AND_COMPLETION_NOT_PROVEN',60000);
 const proof=await snapshot();assert.equal(proof.queueSessions,2);assert.equal(lost,true);assert.ok(lossLeaseMs!==null&&lossLeaseMs>0&&lossLeaseMs<=180000);assert.ok(lostRequestId);assert.equal(events.filter(x=>x.name==='execute_worker_invocation_operation'&&x.requestId===lostRequestId).length,1);assert.ok(events.findIndex(x=>x.name==='get_worker_runtime_operation'&&x.requestId===lostRequestId)>events.findIndex(x=>x.name==='execute_worker_invocation_operation'&&x.requestId===lostRequestId));assert.equal(proof.jobs,expectedJobs);assert.equal(proof.maxSlots,expectedJobs);assert.equal(proof.slots,expectedJobs);if(scenario!=='cancellation')assert.equal(proof.reportDetails,0);
 const rows=proof.invocations.filter((x:{kind:string})=>x.kind===kind);assert.ok(rows.length>=(storageMode?1:2));assert.equal(new Set(rows.map((x:{token:string})=>x.token)).size,1,'COMPETITION_CREATED_TWO_CYCLES');
 for(const row of rows){assert.equal(row.state,'completed');assert.ok(row.limit>=1&&row.limit<=10);assert.ok(row.remainingMs>0&&row.remainingMs<=60000);assert.ok(Date.parse(row.deadline)-Date.parse(row.createdAt)<=60000);const cas=events.filter(x=>x.name==='claim_queue_invocation_dispatch'&&x.requestId===row.requestId);assert.equal(cas.length,1);assert.equal(cas[0].claimed,true);assert.ok(events.findIndex(x=>x.name==='prepare_queue_invocation'&&x.requestId===row.requestId)<events.indexOf(cas[0]));}
 assert.equal(rows.reduce((n:number,x:{result:{counts:{claimed:number}}})=>n+x.result.counts.claimed,0),expectedJobs);
 assert.ok(proof.intents.length>0);for(const child of proof.intents){assert.equal(child.state,'confirmed');assert.equal(child.confirmed,true);assert.equal(child.dispatched,true);const parent=rows.find((x:{requestId:string})=>x.requestId===child.parent);assert.ok(parent);assert.equal(child.globalToken,parent.token);const exec=events.filter(x=>x.name==='execute_worker_invocation_operation'&&x.requestId===child.requestId);assert.equal(exec.length,1,'CHILD_MUTATION_RETRANSMITTED');assert.equal(exec[0].parent,parent.requestId);assert.equal(exec[0].token,parent.token);assert.ok(events.some(x=>x.name==='get_worker_runtime_operation'&&x.requestId===child.requestId));}
 if(storageMode){
  assert.equal(deleteCalls,2);assert.equal(proof.deleteAcks,0);assert.equal(proof.dispatches,0);assert.equal(proof.externalPending,0);assert.equal(proof.terminalReceipts,1);
  assert.equal(proof.ackProofs.length,2);
  for(const ack of proof.ackProofs){
   assert.equal(ack.exactInput,true);assert.equal(ack.confirmed,true);assert.equal(ack.lineage,true);assert.equal(ack.state,'completed');assert.ok(ack.closedAt);
   assert.equal(ack.result.ackSha256,ack.ackSha256);
   // cascade 이후에도 최초 ACK 원키의 실제102 GET과 확정된 predecessor 사슬을 검사한다.
   const original=await atomic.get(ack.requestId);assert.equal(original.requestId,ack.requestId);assert.equal(original.state,'completed');assert.ok(original.closedAt);assert.deepEqual(original.result,ack.result);
   const wire=events.filter(x=>x.name==='execute_worker_invocation_operation'&&x.operation==='report_storage_ack'&&x.requestId===ack.requestId);assert.equal(wire.length,1);assert.equal(wire[0].parent,ack.parent);assert.equal(wire[0].token,ack.globalToken);
  }
  const bytes=JSON.parse(await control('--storage-proof'));assert.equal(bytes.deletedBytesAbsent,true);assert.equal(bytes.canaryUnchanged,true);
 }
 await stop(first);await stop(second);await until(async()=>(await snapshot()).lease.token===null,'LEASE_RELEASE_REQUIRED');
 await control('--unknown');assert.equal((await invocation.getQueueInvocation(f.unknownId)).state,'unknown');const before=(await snapshot()),eventCount=events.length;
 const restarted=launch('queue-restarted');await until(async()=>(await snapshot()).queueSessions===1,'RESTART_CONNECTION_REQUIRED');await delay(1200);const after=await snapshot();assert.equal(after.invocations.length,before.invocations.length);assert.equal(after.intents.length,before.intents.length);
 const restartEvents=events.slice(eventCount);assert.ok(restartEvents.some(x=>x.name==='read_worker_runtime_pending_v2'));assert.ok(restartEvents.every(x=>x.requestId===null||!['prepare_queue_invocation','claim_queue_invocation_dispatch','prepare_worker_invocation_intent','execute_worker_invocation_operation'].includes(x.name)));assert.equal((await invocation.getQueueInvocation(f.unknownId)).state,'unknown');await stop(restarted);
 assert.equal(externalCalls,0);assert.equal(unexpectedRoutes,0);await control('--close');
 const receipt={status:'PASS',scope:'ISOLATED_SAFETY114_HTTPS_NODE_PRODUCT_RUNNER',scenario,revision,serverLiteralApprovedAssembly:true,stockDefaultCli:'MAINTENANCE_ONLY_SEPARATE_V5_EVIDENCE',twoNodeProcesses:true,actualQueueJobs:expectedJobs,uniqueGlobalSlots:expectedJobs,globalLeaseSeconds:180,maxKindAllocationMs:60000,parentCasOnce:true,immutableParentGlobal:true,allChildrenConfirmedByDbProof:true,childResponseLostAndOriginalKeyRead:true,unknownRestartNewDispatch:0,verifyFullTlsAndMinimumLogin:true,sourceDatabaseChanged:false,operatingChanged:false,externalRequests:0,memberModelCalls:0,storageBytes:storageMode?'PASS':'NOT_RUN',storageDeleteCalls:deleteCalls,storageAcks:storageMode?2:0,unrelatedCanaryUnchanged:storageMode,fullFiveKinds:'NOT_RUN',realMemberLogin:'NOT_RUN'};
 await Deno.writeTextFile(root+'/receipt.json',JSON.stringify(receipt,null,2),{mode:0o600,createNew:true});console.log(JSON.stringify(receipt));
 }
}finally{if(retirementMode)await Deno.writeTextFile(root+'/public-retirement-stage-private.json',JSON.stringify({stages:retirementEvidence,authStatuses:publicAuthStatuses,retirementCalls,retirementReceiptCalls,publicPostCalls}),{mode:0o600,createNew:true});await Deno.writeTextFile(root+'/model-stage-private.json',JSON.stringify({stages:modelDiagnostics,modelCalls,actualReservations}),{mode:0o600,createNew:true});await Deno.writeTextFile(root+'/http-events-private.json',JSON.stringify(events),{mode:0o600,createNew:true});for(const r of[...children]){try{await stop(r);}catch{}}try{await control('--close');}finally{globalThis.fetch=realFetch;await server.shutdown();client.close();}}

// SQL101 잔존 기록을 현재 stock CLI로만 읽는다. 합성 fixture는 공개 producer 성공 증거가 아니다.
function legacyObservedLauncher(cliURL:string,pgURL:string,trace:string):string{
 return String.raw`import {runQueueRunnerCli}from ${JSON.stringify(cliURL)};
import {openSync,closeSync,fsyncSync,fstatSync,writeSync,constants}from 'node:fs';
const trace=${JSON.stringify(trace)};let sequence=0,pending=false,dbPid=null;
function record(value){const fd=openSync(trace,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW);try{const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid()||(info.mode&0o777)!==0o600)throw Error('PRIVATE_TRACE_REQUIRED');writeSync(fd,JSON.stringify({sequence:++sequence,nodePid:process.pid,dbPid,...value})+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
const original=globalThis.fetch,expected=new URL(process.env.SUPABASE_URL);
const reads=['get_queue_invocation','read_worker_runtime_pending_v2','read_ai_feedback_maintenance_schedule','read_worker_runtime_maintenance_schedule'];
const fetchImpl=async(input,init)=>{
 const u=new URL(input instanceof Request?input.url:String(input));const name=u.pathname.slice('/rest/v1/rpc/'.length);
 if(u.origin!==expected.origin||!u.pathname.startsWith('/rest/v1/rpc/')||!reads.includes(name)||u.search){record({code:'UNEXPECTED_TRANSPORT'});throw Error('EXTERNAL_OR_MUTATING_TRANSPORT_DISABLED');}
 const response=await original(input,init),json=response.json.bind(response);
 response.json=async()=>{const value=await json();
  if(name==='read_worker_runtime_pending_v2'){if(response.status!==200||!value||Object.keys(value).join(',')!=='hasPending'||value.hasPending!==true)throw Error('ACTUAL_PENDING_TRUE_REQUIRED');pending=true;record({code:'PENDING_CONSUMED',status:response.status,hasPending:true});}
  else if(pending&&response.status===200&&['read_ai_feedback_maintenance_schedule','read_worker_runtime_maintenance_schedule'].includes(name)){record({code:'SCHEDULE_CONSUMED',name,status:response.status,serverNow:value.serverNow,nextDueAt:value.nextDueAt});}
  return value;};return response;
};
const loadClient=async()=>{const pg=await import(${JSON.stringify(pgURL)});return class extends pg.default.Client{
 async query(...args){const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
  if(typeof sql!=='string'||!(/^(SET ROLE yumidang_worker_queue|LISTEN yumidang_worker_jobs|LISTEN yumidang_cancellation_due)$/.test(sql)||sql==='SELECT current_user AS "currentRole", session_user AS "loginRole"'||sql==='select public.read_worker_queue_schedule($1::text[],$2::text) as result'||sql==='select public.read_report_terminal_maintenance_schedule_v2($1::uuid) as result')){record({code:'UNEXPECTED_DIRECT_QUERY'});throw Error('MUTATING_OR_UNREVIEWED_DIRECT_QUERY_DISABLED');}
  const result=await super.query(...args);dbPid=this.processID;
  if(pending&&['select public.read_worker_queue_schedule($1::text[],$2::text) as result','select public.read_report_terminal_maintenance_schedule_v2($1::uuid) as result'].includes(sql)){
   const value=result.rows[0]?.result;record({code:'SCHEDULE_CONSUMED',name:sql.includes('read_worker_queue_schedule')?'queue':'terminal',status:200,serverNow:value.serverNow,nextDueAt:sql.includes('terminal')&&!value.ready?null:value.nextDueAt});}
  return result;
 }
};};
const report=code=>{if(!['WORKER_QUEUE_READY','WORKER_QUEUE_RECONCILIATION_REQUIRED','WORKER_QUEUE_NOT_CONFIGURED','WORKER_QUEUE_UNAVAILABLE'].includes(code))throw Error('UNREVIEWED_CLI_CODE');record({code});process.stderr.write(code+'\n');};
await runQueueRunnerCli({dependencies:{fetchImpl,loadClient,report}});
`;
}
function legacyObservedBarrier(rows:any[],nodePid:number){
 const first=rows.find((r:any)=>r.code==='PENDING_CONSUMED'&&r.status===200&&r.hasPending===true&&r.nodePid===nodePid);
 if(!first)return null;
 const names=['queue','terminal','read_ai_feedback_maintenance_schedule','read_worker_runtime_maintenance_schedule'];
 const schedules=names.map(name=>rows.find((r:any)=>r.code==='SCHEDULE_CONSUMED'&&r.name===name&&r.sequence>first.sequence&&r.nodePid===nodePid));
 if(schedules.some(value=>!value))return null;
 assert.ok(Number.isSafeInteger(first.dbPid)&&first.dbPid>0,'ACTUAL_QUEUE_DB_PID_REQUIRED');
 for(const schedule of schedules){assert.equal(schedule.dbPid,first.dbPid);assert.equal(schedule.status,200);assert.ok(Number.isFinite(Date.parse(schedule.serverNow)));assert.ok(schedule.nextDueAt===null||Number.isFinite(Date.parse(schedule.nextDueAt)));}
 const future=schedules.some(r=>r.nextDueAt!==null&&Date.parse(r.nextDueAt)>Date.parse(r.serverNow));
 assert.ok(schedules.some(r=>r.name==='read_ai_feedback_maintenance_schedule'&&r.nextDueAt!==null&&Date.parse(r.nextDueAt)<Date.parse(r.serverNow)),'ACTUAL_BLOCKED_DUE_MAINTENANCE_REQUIRED');
 if(!rows.some(r=>r.code==='WORKER_QUEUE_READY'&&r.nodePid===nodePid))return null;
 if(!future&&!rows.some(r=>r.code==='WORKER_QUEUE_RECONCILIATION_REQUIRED'&&r.sequence>schedules[schedules.length-1].sequence&&r.nodePid===nodePid))return null;
 return{nodePid,dbPid:first.dbPid,pendingConsumed:true,future,scheduleNames:names,reconciliationCodeRequired:!future};
}
async function legacyObservedPrivateText(root:string,name:string,appendable=false):Promise<string>{
 assert.match(name,/^[a-z0-9.-]+$/);const directory=await Deno.lstat(root);
 assert.ok(directory.isDirectory&&!directory.isSymlink);assert.equal(directory.uid,Deno.uid());assert.equal(directory.mode!&0o777,0o700);assert.equal(await Deno.realPath(root),root);
 const path=root+'/'+name,before=await Deno.lstat(path);assert.ok(before.isFile&&!before.isSymlink);const file=await Deno.open(path,{read:true});
 try{
  const info=await file.stat();assert.ok(info.isFile);assert.equal(info.nlink,1);assert.equal(info.uid,directory.uid);assert.equal(info.mode!&0o777,0o600);assert.equal(info.ino,before.ino);assert.equal(info.dev,before.dev);
  const parts:Uint8Array[]=[];let size=0;while(true){const buffer=new Uint8Array(65536),n=await file.read(buffer);if(n===null)break;size+=n;assert.ok(size<=32*1024*1024,'PRIVATE_INPUT_TOO_LARGE');parts.push(buffer.slice(0,n));}
  const after=await file.stat(),last=await Deno.lstat(path);assert.ok(last.isFile&&!last.isSymlink);assert.equal(after.nlink,1);assert.equal(after.uid,info.uid);assert.equal(after.mode,info.mode);assert.equal(last.ino,info.ino);assert.equal(last.dev,info.dev);assert.equal(after.ino,info.ino);assert.equal(after.dev,info.dev);
  if(!appendable){assert.equal(after.size,info.size);assert.equal(after.mtime?.getTime(),info.mtime?.getTime());}
  const data=new Uint8Array(size);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.length;}return new TextDecoder().decode(data);
 }finally{file.close();}
}
async function legacyObservedMain(revision:string){
 assert.match(revision,/^v[1-9][0-9]?$/);
 const scenario='legacy-observed-pending',root='/private/tmp/yumidang-safety114-http-'+scenario+'-'+revision;
 const repo='/Users/minkyu/Documents/GitHub/yumidang/.worktrees/minkyu-foundation';
 const controlPath=new URL('./worker_safety_http_local.py',import.meta.url).pathname;
 const readPrivate=async(name:string)=>JSON.parse(await legacyObservedPrivateText(root,name));
 const f=await readPrivate('connection-private.json'),prepared=await readPrivate('legacy-prepared-private.json');
 assert.equal(prepared.status,'PREPARED_NOT_RUN');assert.equal(f.clone,'yumidang-minkyu-safety114-http-legacy-observed-'+revision);
 const digest=async(bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer))].map(n=>n.toString(16).padStart(2,'0')).join('');
 for(const[path,hash]of Object.entries(prepared.files))assert.equal(await digest(await Deno.readFile(repo+'/'+path)),hash);
 assert.equal(await digest(await Deno.readFile(new URL('./worker_safety_http_local.py',import.meta.url))),prepared.pythonSha256);assert.equal(await digest(await Deno.readFile(new URL(import.meta.url))),prepared.typescriptSha256);
 const outputNames=new Set<string>();
 async function save(name:string,value:unknown){assert.ok(!outputNames.has(name));const path=root+'/'+name;await Deno.writeTextFile(path,JSON.stringify(value),{mode:0o600,createNew:true});outputNames.add(name);const file=await Deno.open(path,{read:true});try{await file.sync();}finally{file.close();}}
 async function control(action:string){const output=await new Deno.Command('python3',{args:[controlPath,action,'--scenario',scenario,'--revision',revision],cwd:repo,stdout:'piped',stderr:'piped'}).output();if(output.code!==0){await save('legacy-control-failure-'+crypto.randomUUID()+'.json',{status:'FAILED',action,stdoutSha256:await digest(output.stdout),stderrSha256:await digest(output.stderr)});throw Error('LEGACY_CONTROL_FAILED');}return new TextDecoder().decode(output.stdout);}
 const ca=await Deno.readTextFile(root+'/ca.crt'),client=Deno.createHttpClient({caCerts:[ca]});
 const allowed=new Set(['get_queue_invocation','read_worker_runtime_pending_v2','read_ai_feedback_maintenance_schedule','read_worker_runtime_maintenance_schedule']);
 const events:{name:string;status:number;pending?:boolean}[]=[];let rejectedRoutes=0;let server:Deno.HttpServer|undefined;
 const children:{child:Deno.ChildProcess;output:Promise<Deno.CommandOutput>;stopped:boolean}[]=[];
 const phases:any[]=[];let status='FAILED';
 try{
  const launcher=root+'/legacy-stock-launcher.mjs',tracePaths=[root+'/legacy-node-1-private.jsonl',root+'/legacy-node-2-private.jsonl'];
  const cliURL=new URL('backend/supabase/functions/scheduled-jobs/queue-runner.mjs','file://'+repo+'/').href,pgURL=new URL('backend/node_modules/pg/lib/index.js','file://'+repo+'/').href;
  // 두 launcher의 실제 평가 결과를 모두 구문 검사한 뒤 최초 fixture를 시작한다.
  const launchers:string[]=[];
  for(let i=0;i<2;i++){await Deno.writeTextFile(tracePaths[i],'',{mode:0o600,createNew:true});const path=launcher+'.'+i+'.mjs';await Deno.writeTextFile(path,legacyObservedLauncher(cliURL,pgURL,tracePaths[i]),{mode:0o600,createNew:true});const checked=await new Deno.Command('node',{args:['--check',path],stdout:'piped',stderr:'piped'}).output();await save('legacy-launcher-'+i+'-syntax.json',{status:checked.code===0?'PASS':'FAILED',sourceSha256:await digest(await Deno.readFile(path)),stderrSha256:await digest(checked.stderr)});assert.equal(checked.code,0,'ACTUAL_GENERATED_NODE_SYNTAX_REQUIRED');launchers.push(path);}
  await control('--fixture');const original=JSON.parse(await control('--legacy-proof'));
  server=Deno.serve({hostname:'127.0.0.1',port:0,cert:await Deno.readTextFile(root+'/server.crt'),key:await Deno.readTextFile(root+'/server.key'),onListen(){}},async request=>{
   const url=new URL(request.url),name=url.pathname.slice('/rest/v1/rpc/'.length);
   if(request.method!=='POST'||url.search||!url.pathname.startsWith('/rest/v1/rpc/')||!allowed.has(name)||request.headers.get('authorization')!=='Bearer '+f.serviceKey){rejectedRoutes++;return new Response(JSON.stringify({error:{code:'ISOLATED_ROUTE_DISABLED'}}),{status:503});}
   const args=await request.clone().json();const expected=name==='get_queue_invocation'?{p_request_id:'00000000-0000-0000-0000-000000000000'}:name==='read_worker_runtime_pending_v2'?{}:{p_global_token:null};
   assert.deepEqual(args,expected,'EXACT_READ_ONLY_RPC_ARGUMENTS_REQUIRED');
   const response=await fetch('http://127.0.0.1:'+f.restPort+'/rpc/'+name,{method:'POST',headers:{authorization:'Bearer '+f.serviceKey,apikey:f.serviceKey,'content-type':'application/json'},body:JSON.stringify(args),redirect:'error'});
   const value=await response.clone().json();if(name==='get_queue_invocation')assert.equal(response.status,404);else assert.equal(response.status,200);
   events.push({name,status:response.status,...(name==='read_worker_runtime_pending_v2'?{pending:value.hasPending}:{})});return response;
  });
  const origin='https://127.0.0.1:'+(server.addr as Deno.NetAddr).port;
  const env={SUPABASE_URL:origin,SUPABASE_ANON_KEY:f.anonKey,SUPABASE_SERVICE_ROLE_KEY:f.serviceKey,INTERNAL_WORKER_SECRET:f.internalSecret,ALLOWED_ORIGINS:'[]',UPSTREAM_TIMEOUT_MS:'15000',MAX_REQUEST_BYTES:'65536',WORKER_QUEUE_DATABASE_URL:'postgresql://'+f.login+':'+f.password+'@127.0.0.1:'+f.dbPort+'/postgres',WORKER_QUEUE_FUNCTION_URL:origin+'/functions/v1/review-summary-worker',WORKER_QUEUE_DB_CA_PEM:ca,WORKER_QUEUE_DB_CONTRACT_ID:'isolated-safety114-reviewed-20261009',WORKER_QUEUE_DB_LOGIN_ROLE:f.login,WORKER_QUEUE_QUERY_TIMEOUT_MS:'3000',WORKER_QUEUE_RECONNECT_MS:'1000',WORKER_QUEUE_HTTP_TIMEOUT_MS:'60000',NODE_EXTRA_CA_CERTS:root+'/ca.crt'};
  for(let i=0;i<2;i++){
   const begin=events.length,child=new Deno.Command('node',{args:[launchers[i]],cwd:repo+'/backend',env,clearEnv:true,stdout:'piped',stderr:'piped'}).spawn();const running={child,output:child.output(),stopped:false};children.push(running);
   let barrier:any=null;const deadline=Date.now()+30000;
   while(!barrier){assert.ok(Date.now()<deadline,'LEGACY_ACTUAL_PENDING_CONSUMPTION_BARRIER_TIMEOUT');const info=await Deno.lstat(tracePaths[i]);assert.ok(info.isFile&&!info.isSymlink);assert.equal(info.nlink,1);assert.equal(info.mode!&0o777,0o600);const lines=(await legacyObservedPrivateText(root,'legacy-node-'+(i+1)+'-private.jsonl',true)).split('\n').filter(Boolean);try{const rows=lines.map(line=>JSON.parse(line));assert.equal(rows.some(r=>r.code==='UNEXPECTED_TRANSPORT'||r.code==='UNEXPECTED_DIRECT_QUERY'||r.code==='WORKER_QUEUE_NOT_CONFIGURED'||r.code==='WORKER_QUEUE_UNAVAILABLE'),false);barrier=legacyObservedBarrier(rows,child.pid);}catch(error){if(error instanceof SyntaxError){}else throw error;}if(!barrier)await new Promise(resolve=>setTimeout(resolve,50));}
   assert.deepEqual(JSON.parse(await control('--legacy-proof')),original);child.kill('SIGTERM');
   let timer:ReturnType<typeof setTimeout>|undefined;const output=await Promise.race([running.output,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}reject(Error('LEGACY_NODE_STOP_TIMEOUT'));},10000);})]).finally(()=>clearTimeout(timer));running.stopped=true;assert.equal(output.code,0);assert.equal(output.stdout.length,0);const codes=new TextDecoder().decode(output.stderr).trim().split(/\s+/).filter(Boolean);assert.ok(codes.includes('WORKER_QUEUE_READY'));assert.ok(codes.every(c=>['WORKER_QUEUE_READY','WORKER_QUEUE_RECONCILIATION_REQUIRED'].includes(c)));assert.deepEqual(JSON.parse(await control('--legacy-proof')),original);assert.equal(rejectedRoutes,0);assert.ok(events.slice(begin).some(e=>e.name==='read_worker_runtime_pending_v2'&&e.status===200&&e.pending===true));phases.push({...barrier,exitCode:output.code,extraEffects:0,originalRowExact:true});
  }
  assert.notEqual(phases[0].nodePid,phases[1].nodePid);assert.notEqual(phases[0].dbPid,phases[1].dbPid);status='PASS';
  await save('receipt.json',{status,scope:'MANUAL_LEGACY101_COEXISTING_INHERITED_PENDING_CURRENT_STOCK_CLI_TWO_STARTS',scenario,revision,phases,legacyRowSha256:original.journalSha256,legacyState:original.state,noModernReceipt:true,stockDefaultAssembly:'MAINTENANCE_ONLY',mutatingRpcCalls:0,directAcquireCalls:0,deleteSendAckCalls:0,falseCompleted:0,obsoleteObserveCalls:0,sourceDatabaseChanged:false,operatingChanged:false,publicProducerFlow:'NOT_RUN',fullFiveKinds:'NOT_RUN',realProvider:'NOT_RUN'});
 }finally{
  for(const running of children)if(!running.stopped){try{running.child.kill('SIGTERM');}catch{}let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([running.output,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{try{running.child.kill('SIGKILL');}catch{}reject(Error('LEGACY_FINAL_CHILD_TIMEOUT'));},10000);})]);running.stopped=true;}finally{clearTimeout(timer);if(!running.stopped)await running.output;}}
  if(server)await server.shutdown();client.close();await save('legacy-node-final-private.json',{status,children:children.map(r=>({pid:r.child.pid,stopped:r.stopped})),rejectedRoutes});
 }
}
