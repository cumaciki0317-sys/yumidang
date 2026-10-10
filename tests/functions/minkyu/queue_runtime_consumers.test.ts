import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiFeedbackMaintenance} from '../../../backend/supabase/functions/_shared/jobs/ai-feedback-maintenance.ts';
import {createSafetyConsumerRegistry,type SafetyConsumerPorts} from '../../../backend/supabase/functions/_shared/jobs/safety-consumers.ts';
import {loadRuntimeConfig} from '../../../backend/supabase/functions/_shared/config/env.ts';
import {HttpError} from '../../../backend/supabase/functions/_shared/http/errors.ts';
import {JobExecutionUnknown} from '../../../backend/supabase/functions/_shared/jobs/retry.ts';
import {createConfiguredQueueRuntime} from '../../../backend/supabase/functions/_shared/jobs/runtime.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,token=id(8),requestId=id(9);
const values={SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service',INTERNAL_WORKER_SECRET:'x'.repeat(32),UPSTREAM_TIMEOUT_MS:'1000',MAX_REQUEST_BYTES:'65536',ALLOWED_ORIGINS:'[]'};
const config=loadRuntimeConfig(k=>(values as Record<string,string>)[k]);
const saved=(key=requestId,count=2)=>({requestId:key,state:'completed',result:{deletedCount:count},closedAt:'2026-10-09T00:00:00Z',replayed:true});
const input=()=>({limit:3,remainingMs:1000,signal:new AbortController().signal,requestId});
function feedbackPorts(events:string[]) {return{scopedEndpointReady:true,readSchedule:async()=>({serverNow:'2026-10-09T00:00:00Z',nextDueAt:null}),prepare:async({requestId:key,limit}:any)=>{assert.equal(key,requestId);assert.equal(limit,3);events.push('prepare');return{fresh:true};},readResult:async(key:string)=>{events.push('get');return saved(key);},unknown:async()=>{events.push('unknown');}};}
test('helpful requestId is durable before first HTTP and exact saved result is required',async()=>{
 const events:string[]=[];const worker=createAiFeedbackMaintenance(config,feedbackPorts(events),async(_url,init)=>{events.push('http');assert.equal(new Headers(init?.headers).get('x-worker-request-id'),requestId);assert.equal(new Headers(init?.headers).get('x-worker-run-token'),token);assert.deepEqual(JSON.parse(String(init?.body)),{limit:3});return Response.json({data:{deletedCount:2}});});
 assert.deepEqual(await worker.run(token,input()),{purged:2,processedItems:3});assert.deepEqual(events,['prepare','http','get']);
});
test('response loss recovers stored result with one HTTP and no new request key',async()=>{
 const events:string[]=[];let sends=0;const worker=createAiFeedbackMaintenance(config,feedbackPorts(events),async()=>{sends++;throw new Error('lost');});
 assert.deepEqual(await worker.run(token,input()),{purged:2,processedItems:3});assert.equal(sends,1);assert.deepEqual(events,['prepare','get']);
});
test('missing or mismatched stored result remains UNKNOWN without retransmission',async()=>{
 const events:string[]=[];let sends=0;const ports={...feedbackPorts(events),readResult:async()=>saved(id(99))};const worker=createAiFeedbackMaintenance(config,ports,async()=>{sends++;throw new Error('lost');});
 await assert.rejects(worker.run(token,input()),JobExecutionUnknown);assert.equal(sends,1);assert.ok(events.includes('unknown'));
});
test('failed durable prepare starts no HTTP',async()=>{
 let sends=0;const worker=createAiFeedbackMaintenance(config,{...feedbackPorts([]),prepare:async()=>{throw new Error('lost');}},async()=>{sends++;return Response.json({data:{deletedCount:0}});});await assert.rejects(worker.run(token,input()),JobExecutionUnknown);assert.equal(sends,0);
});
test('queue CLI default enables verified maintenance without automatically enabling member AI',()=>{let rpc=0;const runtime=createConfiguredQueueRuntime(values,{contractId:'contract',workerSecret:values.INTERNAL_WORKER_SECRET,functionUrl:'https://example.supabase.co/functions/v1/review-summary-worker'},{db:{rpc:async()=>{rpc++;return null;}}});assert.deepEqual(runtime.supportedKinds,[]);assert.equal(runtime.contracts.maintenance.durableProofReady,true);assert.equal(rpc,0);});
test('one queue job with multiple attachments and metadata reserves exactly one slot',async()=>{
 const reportId=id(3),proof=id(4),job={jobId:id(1),leaseToken:id(2),leaseUntil:'2099-01-01T00:00:00Z',failedAttempts:0,reference:{kind:'report_retention' as const,reportId,closureProofId:proof}};
 const meta={taskId:id(5),taskLeaseToken:id(6),taskExpiresAt:'2098-01-01T00:00:00Z',reportId,closureRevision:1,kind:'report_metadata',assetId:null,bucketId:null,objectName:null,objectId:null,retentionDueAt:'2026-01-01T00:00:00Z',closureProofId:proof};
 const tasks=[10,11,12].map(n=>({...meta,kind:'storage_object',taskId:id(n),assetId:id(n+10),objectId:id(n+20),bucketId:'report-evidence',objectName:`${reportId}/${id(n+10)}.jpg`}));tasks.push(meta as any);
 const reservations:any[]=[],known=new Set<string>();let deletes=0,completes=0;
 const ports:SafetyConsumerPorts={readiness:{scopedClaim:true,sharedBudgetContract:true,durableJournalContract:true,cancellationGuardAndAcl:true,reportGuardAndAcl:true,reportTerminalScheduleContract:true,storageProviderApproved:true},budget:{globalToken:token,signal:new AbortController().signal,elapsed:()=>0,readRemaining:async()=>({remainingMs:10000}),reserve:async()=>true,hasItemCapacity:jobId=>known.has(jobId??'')||known.size<1,reserveItem:async item=>{reservations.push(item);known.add(item.jobId);return true;}},journal:{prepare:async()=>{},confirmed:async()=>{},unknown:async()=>{}},cancellationProcess:async()=>null,reportClaim:async()=>tasks.shift()??null,reportStorage:async()=>{deletes++;return{evidenceSha256:'a'.repeat(64)};},metadataEvidence:async()=> 'a'.repeat(64),reportComplete:async({task})=>{completes++;return{taskId:task.taskId,status:'completed',alreadyApplied:false};}};
 assert.equal((await createSafetyConsumerRegistry(ports).report_retention!(job)).status,'completed_by_handler');assert.equal(deletes,3);assert.equal(completes,4);assert.deepEqual(reservations,[{kind:'report_retention',jobId:job.jobId}]);
});

test('existing helpful intent is get-only even if a caller repeats its requestId',async()=>{
 let sends=0;const events:string[]=[];const worker=createAiFeedbackMaintenance(config,{...feedbackPorts(events),prepare:async()=>({fresh:false})},async()=>{sends++;throw new Error('no HTTP');});assert.deepEqual(await worker.run(token,input()),{purged:2,processedItems:3});assert.equal(sends,0);assert.deepEqual(events,['get']);
});

test('deadline abort cannot return a late helpful HTTP success or retransmit',async()=>{
 let sends=0,reads=0;const events:string[]=[];const short={...config,upstreamTimeoutMs:10};
 const worker=createAiFeedbackMaintenance(short,{...feedbackPorts(events),readResult:async()=>{reads++;return saved();}},async()=>{sends++;return new Promise<Response>(()=>{});});
 await assert.rejects(worker.run(token,input()),JobExecutionUnknown);assert.equal(sends,1);assert.equal(reads,0);assert.ok(events.includes('unknown'));
});

test('default direct runtime maintenance binds one109 key through CAS, purge and DB proof',async()=>{
 const calls:Array<[string,any]>=[];let prepared:any;
 const db={rpc:async(name:string,args:any)=>{calls.push([name,args]);
  if(name==='read_ai_feedback_maintenance_schedule')return{serverNow:'2026-10-09T00:00:00Z',nextDueAt:null};
  if(name==='read_worker_runtime_maintenance_schedule')return{serverNow:'2026-10-09T00:00:00Z',nextDueAt:'2026-10-09T00:00:00Z'};
  if(name==='prepare_queue_invocation'){prepared={requestId:args.p_request_id,globalToken:args.p_global_token,kind:args.p_kind,limit:args.p_limit,remainingMs:args.p_remaining_ms};return{requestId:args.p_request_id,state:'prepared',fresh:true};}
  if(name==='claim_queue_invocation_dispatch')return{claimed:true};
  if(name==='purge_worker_runtime_details_scoped')return{purged:3};
  if(name==='complete_queue_invocation')return{...prepared,state:'completed',result:{purged:3,processedItems:20},closedAt:'2026-10-09T00:00:00Z'};
  throw new Error('unexpected '+name);
 }};
 const runtime=createConfiguredQueueRuntime(values,{contractId:'sql109',workerSecret:values.INTERNAL_WORKER_SECRET,functionUrl:'https://example.supabase.co/functions/v1/review-summary-worker'},{db,fetch:async()=>assert.fail('no external HTTP')});
 runtime.scheduleForClient!({query:async()=>({rows:[{result:{serverNow:'2026-10-09T00:00:00Z',nextDueAt:null,ready:false}}]})});
 assert.deepEqual(await runtime.contracts.maintenance.run(token,{limit:20,remainingMs:1000,signal:new AbortController().signal}),{purged:3,processedItems:20});
 const mutationCalls=calls.filter(([n])=>['prepare_queue_invocation','claim_queue_invocation_dispatch','purge_worker_runtime_details_scoped','complete_queue_invocation'].includes(n));
 assert.deepEqual(mutationCalls.map(([n])=>n),['prepare_queue_invocation','claim_queue_invocation_dispatch','purge_worker_runtime_details_scoped','complete_queue_invocation']);assert.equal(new Set(mutationCalls.map(([,a])=>a.p_request_id)).size,1);assert.equal(prepared.kind,'runtime_maintenance');
});

test('direct purge response loss reads the original stored result without retransmitting purge',async()=>{
 let prepared:any,purges=0,reads=0;
 const db={rpc:async(name:string,args:any)=>{
  if(name==='read_ai_feedback_maintenance_schedule')return{serverNow:'2026-10-09T00:00:00Z',nextDueAt:null};
  if(name==='read_worker_runtime_maintenance_schedule')return{serverNow:'2026-10-09T00:00:00Z',nextDueAt:'2026-10-09T00:00:00Z'};
  if(name==='prepare_queue_invocation'){prepared={requestId:args.p_request_id,globalToken:args.p_global_token,kind:args.p_kind,limit:args.p_limit,remainingMs:args.p_remaining_ms};return{requestId:args.p_request_id,state:'prepared',fresh:true};}
  if(name==='claim_queue_invocation_dispatch')return{claimed:true};
  if(name==='purge_worker_runtime_details_scoped'){purges++;throw new Error('response lost');}
  if(name==='get_worker_runtime_operation'){reads++;assert.equal(args.p_request_id,prepared.requestId);return{requestId:prepared.requestId,state:'completed',result:{purged:2},closedAt:'2026-10-09T00:00:00Z',replayed:true};}
  if(name==='complete_queue_invocation')return{...prepared,state:'completed',result:{purged:2,processedItems:20},closedAt:'2026-10-09T00:00:00Z'};
  throw new Error('unexpected '+name);
 }};
 const runtime=createConfiguredQueueRuntime(values,{contractId:'sql109',workerSecret:values.INTERNAL_WORKER_SECRET,functionUrl:'https://example.supabase.co/functions/v1/review-summary-worker'},{db});
 runtime.scheduleForClient!({query:async()=>({rows:[{result:{serverNow:'2026-10-09T00:00:00Z',nextDueAt:null,ready:false}}]})});
 assert.deepEqual(await runtime.contracts.maintenance.run(token,{limit:20,remainingMs:1000,signal:new AbortController().signal}),{purged:2,processedItems:20});assert.equal(purges,1);assert.equal(reads,1);
});

test('approved review bridge carries exact preparation allocation and recovers only DB proof after HTTP loss',async()=>{
 let prepared:any,closed=false,sends=0;const calls:string[]=[];
 const db={rpc:async(name:string,args:any)=>{calls.push(name);
  if(name==='prepare_queue_invocation'){prepared={requestId:args.p_request_id,globalToken:args.p_global_token,kind:args.p_kind,limit:args.p_limit,remainingMs:args.p_remaining_ms};return{requestId:prepared.requestId,state:'prepared',fresh:true};}
  if(name==='get_queue_invocation'||name==='complete_queue_invocation'){if(name==='complete_queue_invocation')closed=true;return{...prepared,state:closed?'completed':'prepared',result:closed?{status:'ran',counts:{claimed:1,succeeded:1,retried:0,failed:0,superseded:0,yielded:0}}:null,closedAt:closed?'2026-10-09T00:00:00Z':null};}
  throw new Error('unexpected '+name);
 }};
 const runtime=createConfiguredQueueRuntime(values,{contractId:'review-test',workerSecret:values.INTERNAL_WORKER_SECRET,functionUrl:'https://example.supabase.co/functions/v1/review-summary-worker'},{db,review:{approved:true,decisionId:'review-test',maxJobsPerRun:2,timeBudgetMs:1000},fetch:async(_url,init)=>{sends++;const h=new Headers(init?.headers);assert.equal(h.get('x-worker-request-id'),prepared.requestId);assert.equal(h.get('x-worker-run-token'),token);assert.equal(h.get('x-worker-max-jobs'),'2');assert.equal(h.get('x-worker-time-budget-ms'),'1000');assert.equal(init?.body,'{}');throw new Error('response lost');}});
 assert.deepEqual(runtime.supportedKinds,['review_summary']);assert.deepEqual(runtime.contracts.allocate('review_summary',20,180000),{limit:2,timeBudgetMs:1000});
 const requestId=await runtime.contracts.journal.begin({globalToken:token,kind:'review_summary',limit:2,remainingMs:1000});
 const result=await runtime.invokeExisting(token,'review_summary',{requestId,limit:2,remainingMs:1000,signal:new AbortController().signal});
 assert.equal(result.counts.succeeded,1);assert.equal(sends,1);assert.deepEqual(calls,['prepare_queue_invocation','get_queue_invocation','get_queue_invocation','complete_queue_invocation']);
});

test('review HTTP success without audited DB completion remains unproven',async()=>{
 let prepared:any,sends=0;
 const db={rpc:async(name:string,args:any)=>{
  if(name==='prepare_queue_invocation'){prepared={requestId:args.p_request_id,globalToken:args.p_global_token,kind:args.p_kind,limit:args.p_limit,remainingMs:args.p_remaining_ms};return{requestId:prepared.requestId,state:'prepared',fresh:true};}
  if(name==='get_queue_invocation')return{...prepared,state:'prepared',result:null,closedAt:null};
  if(name==='complete_queue_invocation')throw new Error('no stored DB effect');
  throw new Error('unexpected '+name);
 }};
 const runtime=createConfiguredQueueRuntime(values,{contractId:'review-test',workerSecret:values.INTERNAL_WORKER_SECRET,functionUrl:'https://example.supabase.co/functions/v1/review-summary-worker'},{db,review:{approved:true,decisionId:'review-test',maxJobsPerRun:1,timeBudgetMs:1000},fetch:async()=>{sends++;return Response.json({data:{status:'ran',counts:{claimed:1,succeeded:1}}});}});
 const requestId=await runtime.contracts.journal.begin({globalToken:token,kind:'review_summary',limit:1,remainingMs:1000});await assert.rejects(runtime.invokeExisting(token,'review_summary',{requestId,limit:1,remainingMs:1000,signal:new AbortController().signal}));assert.equal(sends,1);
});

test('CLI preflight accepts only the gated109 missing-row proof and creates no intent',async()=>{
 const names:string[]=[];
 const runtime=createConfiguredQueueRuntime(values,{contractId:'sql109',workerSecret:values.INTERNAL_WORKER_SECRET,functionUrl:'https://example.supabase.co/functions/v1/review-summary-worker'},{db:{rpc:async(name,args)=>{names.push(name);assert.equal(args.p_request_id,'00000000-0000-0000-0000-000000000000');throw new HttpError('RESOURCE_NOT_FOUND');}}});
 await runtime.preflight!();assert.deepEqual(names,['get_queue_invocation']);
 for(const code of ['ACCESS_DENIED','EXTERNAL_UNAVAILABLE','INTERNAL_ERROR'] as const){
  const blocked=createConfiguredQueueRuntime(values,{contractId:'sql109',workerSecret:values.INTERNAL_WORKER_SECRET,functionUrl:'https://example.supabase.co/functions/v1/review-summary-worker'},{db:{rpc:async()=>{throw new HttpError(code);}}});await assert.rejects(blocked.preflight!(),/SHARED_QUEUE_CONTRACT_NOT_READY/);
 }
});

for (const kind of ['member_cleanup','event_sync'] as const) test(`${kind} bridge preserves original allocation and fixed endpoint on response loss`,async()=>{
 let prepared:any,closed=false,sends=0;const calls:string[]=[];
 const db={rpc:async(name:string,args:any)=>{calls.push(name);
  if(name==='prepare_queue_invocation'){prepared={requestId:args.p_request_id,globalToken:args.p_global_token,kind:args.p_kind,limit:args.p_limit,remainingMs:args.p_remaining_ms};return{requestId:prepared.requestId,state:'prepared',fresh:true};}
  if(name==='get_queue_invocation'||name==='complete_queue_invocation'){if(name==='complete_queue_invocation')closed=true;return{...prepared,state:closed?'completed':'prepared',result:closed?{status:'ran',counts:{claimed:1,succeeded:1,retried:0,failed:0,superseded:0,yielded:0}}:null,closedAt:closed?'2026-10-09T00:00:00Z':null};}
  throw new Error('unexpected '+name);
 }};
 const runtime=createConfiguredQueueRuntime(values,{contractId:'existing-test',workerSecret:values.INTERNAL_WORKER_SECRET,functionUrl:'https://example.supabase.co/functions/v1/review-summary-worker'},
 {db,existing:[{kind,approved:true,decisionId:'existing-test',maxJobsPerRun:2,timeBudgetMs:1000}],fetch:async(url,init)=>{
  sends++;assert.equal(String(url),`https://example.supabase.co/functions/v1/${kind==='event_sync'?'event-sync/worker':'service-api/internal/member-cleanup'}`);
  const h=new Headers(init?.headers);assert.equal(h.get('x-worker-request-id'),prepared.requestId);assert.equal(h.get('x-worker-max-jobs'),'2');assert.equal(h.get('x-worker-time-budget-ms'),'1000');assert.equal(init?.body,'{}');throw new Error('response lost');
 }});
 assert.deepEqual(runtime.supportedKinds,[kind]);
 const requestId=await runtime.contracts.journal.begin({globalToken:token,kind,limit:2,remainingMs:1000});
 const result=await runtime.invokeExisting(token,kind,{requestId,limit:2,remainingMs:1000,signal:new AbortController().signal});
 assert.equal(result.counts.succeeded,1);assert.equal(sends,1);assert.deepEqual(calls,['prepare_queue_invocation','get_queue_invocation','get_queue_invocation','complete_queue_invocation']);
 await assert.rejects(runtime.contracts.journal.begin({globalToken:token,kind,limit:3,remainingMs:1000}));assert.equal(calls.length,4);
});
test('unapproved, duplicate and over-limit existing lanes never create runtime or send',()=>{
 const base={kind:'event_sync',approved:true,decisionId:'existing-test',maxJobsPerRun:1,timeBudgetMs:1000};
 for(const existing of [[{...base,approved:false}],[base,base],[{...base,kind:'cancellation_safety'}],[{...base,timeBudgetMs:60001}],[{...base,maxJobsPerRun:11}],[{...base,decisionId:'other'}]]){
  assert.throws(()=>createConfiguredQueueRuntime(values,{contractId:'existing-test',workerSecret:values.INTERNAL_WORKER_SECRET,functionUrl:'https://example.supabase.co/functions/v1/review-summary-worker'},{db:{rpc:async()=>assert.fail()},existing:existing as never,fetch:async()=>assert.fail()}),/SHARED_QUEUE_CONTRACT_NOT_READY/);
 }
});
