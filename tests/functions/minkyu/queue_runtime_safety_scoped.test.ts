import test from 'node:test';
import assert from 'node:assert/strict';
import {createConfiguredQueueRuntime,type ApprovedSafetyQueueReadiness} from '../../../backend/supabase/functions/_shared/jobs/runtime.ts';
import type {RpcClient} from '../../../backend/supabase/functions/_shared/db/transport.ts';
import type {JsonValue} from '../../../backend/supabase/functions/_shared/contracts/common.ts';
import {HttpError} from '../../../backend/supabase/functions/_shared/http/errors.ts';
const id=(n:number)=>`ef114200-0000-4000-8000-${String(n).padStart(12,'0')}`,token=id(1),jobId=id(2),lease=id(3),identity=id(4);
const values:Record<string,string>={SUPABASE_URL:'https://local.invalid',SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',INTERNAL_WORKER_SECRET:'s'.repeat(32),UPSTREAM_TIMEOUT_MS:'1000',MAX_REQUEST_BYTES:'65536',ALLOWED_ORIGINS:'[]'};
const queueConfig={contractId:'sql114-test',workerSecret:values.INTERNAL_WORKER_SECRET,functionUrl:'https://local.invalid/functions/v1/review-summary-worker'};
const approval=():ApprovedSafetyQueueReadiness=>({approved:true,decisionId:queueConfig.contractId,kind:'cancellation_safety',maxJobsPerRun:1,timeBudgetMs:60000,readiness:{scopedClaim:true,sharedBudgetContract:true,durableJournalContract:true,cancellationGuardAndAcl:true,reportGuardAndAcl:false,reportTerminalScheduleContract:false,storageProviderApproved:false},retry:{maxAttempts:3,baseDelayMs:1000,maxDelayMs:5000}});
function fixture(mode:'success'|'idle'|'held'|'lost_child'|'lost_complete'|'closed'|'cas_loser'|'unknown'='success'){
 const calls:Array<[string,Record<string,JsonValue>]> = [];let expected:Record<string,JsonValue>={requestId:id(6),globalToken:token,kind:'cancellation_safety',limit:1,remainingMs:60000},settled=false,claims=0,processed=false,state=mode==='unknown'?'unknown':'prepared',complete:JsonValue=null,dispatch=false;
 const intents=new Map<string,Record<string,JsonValue>>(),results=new Map<string,JsonValue>();
 const receipt=()=>({...expected,state,result:complete,closedAt:state==='completed'?'2026-10-09T00:00:00Z':null});
 const db:RpcClient={async rpc(name,args){calls.push([name,structuredClone(args)]);
  if(['prepare_worker_invocation_intent','execute_worker_invocation_operation','confirm_worker_runtime_intent'].includes(name)&&args.p_request_id===null){if(mode==='closed')throw new HttpError('ACCESS_DENIED');throw new HttpError('INVALID_REQUEST');}
  if(name==='read_worker_runtime_pending_v2')return{hasPending:false};
  if(name==='read_worker_run_budget')return{remainingMs:60000};
  if(name==='prepare_queue_invocation'){expected={requestId:args.p_request_id,globalToken:args.p_global_token,kind:args.p_kind,limit:args.p_limit,remainingMs:args.p_remaining_ms};state=mode==='unknown'?'unknown':'prepared';return{requestId:args.p_request_id,state,fresh:true};}
  if(name==='get_queue_invocation'){if(args.p_request_id==='00000000-0000-0000-0000-000000000000')throw new HttpError('RESOURCE_NOT_FOUND');return receipt();}
  if(name==='claim_queue_invocation_dispatch'){if(mode==='cas_loser'||dispatch)return{claimed:false};dispatch=true;return{claimed:true};}
  if(name==='prepare_worker_invocation_intent'){const key=String(args.p_request_id);intents.set(key,{requestId:args.p_request_id,ticket:args.p_request_id,globalToken:token,parentTicket:null,operation:args.p_operation,scope:args.p_scope,state:'prepared'});assert.equal(args.p_parent_invocation_id,expected.requestId);return{ticket:args.p_request_id,state:'prepared',fresh:true};}
  if(name==='execute_worker_invocation_operation'){
   assert.equal(args.p_parent_request_id,expected.requestId);assert.equal(args.p_global_token,token);const input=args.p_input as Record<string,JsonValue>;let result:JsonValue;
   switch(args.p_operation){case'due_enqueue':result={enqueued:mode==='idle'?0:1};break;case'job_claim':claims++;result={job:mode==='idle'?null:{jobId,leaseToken:lease,leaseExpiresAt:'2099-01-01T00:00:00Z',attempt:1,failedAttempts:0,kind:'cancellation_safety',payload:{identityId:identity,generation:1}}};break;case'cancellation_process':processed=true;result={status:mode==='held'?'policy_pending':'applied',generation:1,changed:mode!=='held'};break;case'job_settlement':settled=true;assert.equal(input.jobId,jobId);assert.equal(input.jobLeaseToken,lease);result={jobId,status:input.status};break;default:assert.fail('unexpected atomic operation');}
   const out={requestId:args.p_request_id,state:'completed',result,closedAt:'2026-10-09T00:00:00Z',replayed:false};results.set(String(args.p_request_id),out);if(mode==='lost_child'&&args.p_operation==='cancellation_process')throw new Error('lost response');return out;
  }
  if(name==='get_worker_runtime_intent')return intents.get(String(args.p_request_id))!;
  if(name==='get_worker_runtime_operation'){const out=results.get(String(args.p_request_id));assert.ok(out&&typeof out==='object'&&!Array.isArray(out));return{...out,replayed:true};}
  if(name==='confirm_worker_runtime_intent'){const row=intents.get(String(args.p_request_id))!;assert.ok(results.has(String(args.p_request_id)));row.state='confirmed';return{ticket:row.ticket,state:'confirmed'};}
  if(name==='complete_queue_invocation'){
   if(mode==='cas_loser'||!claims||mode!=='idle'&&(!settled||!processed))throw new Error('unproven DB audit');
   complete={status:'ran',counts:{claimed:mode==='idle'?0:1,succeeded:mode==='idle'?0:1,retried:0,failed:0,superseded:0,yielded:0}};state='completed';if(mode==='lost_complete')throw new Error('lost completion response');return receipt();
  }
  if(name==='mark_queue_invocation_unknown'){if(state==='prepared')state='unknown';return receipt();}
  if(name==='observe_worker_runtime_intent')return{ticket:args.p_request_id,state:'unknown'};
  throw new Error('unexpected RPC '+name);
 }};
 const runtime=createConfiguredQueueRuntime(values,queueConfig,{db,safety:[approval()],fetch:async(url)=>{assert.equal(new URL(String(url)).pathname,'/rest/v1/rpc/read_worker_run_budget');return Response.json({remainingMs:60000});}});
 async function run(){const key=mode==='unknown'?id(6):await runtime.contracts.journal.begin({globalToken:token,kind:'cancellation_safety',limit:1,remainingMs:60000});return runtime.invokeSafety(token,'cancellation_safety',{requestId:key,limit:1,remainingMs:60000,signal:new AbortController().signal});}
 return{runtime,db,calls,run,state:()=>state};
}
test('default and incomplete approval keep safety lanes closed without any request',()=>{
 for(const safety of[undefined,[{...approval(),readiness:{...approval().readiness,durableJournalContract:false}}],[{...approval(),kind:'report_retention' as const}]]){let calls=0;const runtime=createConfiguredQueueRuntime(values,queueConfig,{db:{rpc:async()=>{calls++;return null;}},safety});assert.deepEqual(runtime.supportedKinds,[]);assert.equal(calls,0);}
 const db:RpcClient={supportsRpc:()=>false,rpc:async()=>assert.fail('no RPC')};assert.deepEqual(createConfiguredQueueRuntime(values,queueConfig,{db,safety:[approval()]}).supportedKinds,[]);
});
test('readiness preflight is guard/ACL proof only and cannot create an intent',async()=>{
 const f=fixture();assert.ok("preflight" in f.runtime && typeof f.runtime.preflight === "function");await f.runtime.preflight();assert.equal(f.calls.filter(([n])=>n==='prepare_queue_invocation').length,0);const probes=f.calls.filter(([n])=>['prepare_worker_invocation_intent','execute_worker_invocation_operation','confirm_worker_runtime_intent'].includes(n));assert.equal(probes.length,3);assert.ok(probes.every(([,a])=>a.p_request_id===null));
 const closed=fixture('closed');assert.ok("preflight" in closed.runtime && typeof closed.runtime.preflight === "function");await assert.rejects(closed.runtime.preflight(),/QUEUE_KIND_NOT_READY/);await assert.rejects(closed.run(),/QUEUE_KIND_NOT_READY/);assert.equal(closed.calls.filter(([n])=>n==='prepare_queue_invocation').length,0);
});
test('actual safety factory uses one outer CAS, immutable parent/global and stored DB counts',async()=>{
 const f=fixture(),result=await f.run();assert.equal(result.status,'ran');assert.equal(result.counts.claimed,1);assert.equal(f.calls.filter(([n])=>n==='claim_queue_invocation_dispatch').length,1);assert.equal(f.calls.filter(([n,a])=>n==='execute_worker_invocation_operation'&&a.p_request_id!==null).length,4);assert.equal(f.calls.filter(([n])=>n==='mark_queue_invocation_unknown').length,0);
 const outer=f.calls.find(([n])=>n==='prepare_queue_invocation')![1].p_request_id;const children=f.calls.filter(([n,a])=>n==='prepare_worker_invocation_intent'&&a.p_request_id!==null);assert.ok(children.every(([,a])=>a.p_parent_invocation_id===outer));const mutation=f.calls.filter(([n,a])=>n==='execute_worker_invocation_operation'&&a.p_request_id!==null);assert.ok(mutation.every(([,a])=>a.p_parent_request_id===outer&&a.p_global_token===token));
 const claim=children.find(([,a])=>a.p_operation==='job_claim')![1].p_request_id;assert.ok(f.calls.filter(([n,a])=>n==='confirm_worker_runtime_intent'&&a.p_request_id===claim).length>=2); // reserveItem rechecks original slot proof.
});
test('idle claim closes only proven DB audit and counts zero jobs',async()=>{const f=fixture('idle'),result=await f.run();assert.equal(result.counts.claimed,0);assert.equal(f.calls.filter(([n,a])=>n==='execute_worker_invocation_operation'&&a.p_request_id!==null).length,2);assert.equal(f.state(),'completed');});
test('child response loss gets original result and completes without duplicate mutation',async()=>{const f=fixture('lost_child');assert.equal((await f.run()).counts.succeeded,1);assert.equal(f.calls.filter(([n,a])=>n==='execute_worker_invocation_operation'&&a.p_operation==='cancellation_process'&&a.p_request_id!==null).length,1);assert.ok(f.calls.some(([n])=>n==='get_worker_runtime_operation'));});
test('outer completion response loss is recovered by GET-only proof',async()=>{const f=fixture('lost_complete');assert.equal((await f.run()).counts.succeeded,1);assert.equal(f.calls.filter(([n])=>n==='complete_queue_invocation').length,1);assert.equal(f.calls.filter(([n])=>n==='mark_queue_invocation_unknown').length,0);});
test('policy pending held has no settlement proof and preserves UNKNOWN',async()=>{const f=fixture('held');await assert.rejects(f.run(),/QUEUE_RECONCILIATION_REQUIRED/);assert.equal(f.state(),'unknown');assert.equal(f.calls.filter(([n,a])=>n==='execute_worker_invocation_operation'&&a.p_operation==='job_settlement'&&a.p_request_id!==null).length,0);assert.equal(f.calls.filter(([n])=>n==='mark_queue_invocation_unknown').length,1);});
test('CAS loser and existing UNKNOWN never execute or interfere with another dispatcher',async()=>{
 const loser=fixture('cas_loser');await assert.rejects(loser.run(),/QUEUE_RECONCILIATION_REQUIRED/);assert.equal(loser.calls.filter(([n,a])=>n==='execute_worker_invocation_operation'&&a.p_request_id!==null).length,0);assert.equal(loser.calls.filter(([n])=>n==='mark_queue_invocation_unknown').length,0);
 const unknown=fixture('unknown');await assert.rejects(unknown.run(),/QUEUE_RECONCILIATION_REQUIRED/);assert.equal(unknown.calls.filter(([n])=>n==='claim_queue_invocation_dispatch').length,0);
});
