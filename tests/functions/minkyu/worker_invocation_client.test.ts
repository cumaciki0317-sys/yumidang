import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerInvocationRuntime} from '../../../backend/supabase/functions/_shared/db/worker-runtime-client.ts';
const requestId='11111111-1111-1111-1111-111111111111',globalToken='22222222-2222-2222-2222-222222222222';
const input={requestId,globalToken,kind:'review_summary' as const,limit:2,remainingMs:4000};
const complete={...input,state:'completed',closedAt:'2026-10-09T01:00:00Z',result:{status:'ran',counts:{claimed:2,succeeded:1,retried:1,failed:0,superseded:0,yielded:0}}};
function port(value:unknown){const calls:{name:string;args:unknown}[]=[];return {calls,runtime:createWorkerInvocationRuntime({rpc:async(name:string,args:unknown)=>{calls.push({name,args});return value as never;}})};}
test('prepared replay stays nonfresh; one-time dispatch uses exact DB allocation',async()=>{
 const p=port({requestId,state:'prepared',fresh:false});assert.deepEqual(await p.runtime.prepareQueueInvocation(input),{requestId,state:'prepared',fresh:false});
 assert.deepEqual(p.calls[0],{name:'prepare_queue_invocation',args:{p_request_id:requestId,p_global_token:globalToken,p_kind:'review_summary',p_limit:2,p_remaining_ms:4000}});
 const d=port({claimed:false});assert.equal(await d.runtime.claimQueueInvocationDispatch(input),false);assert.equal(d.calls[0].name,'claim_queue_invocation_dispatch');
});
test('GET preserves stored completion and cannot reexecute a mutation',async()=>{
 const p=port(complete);assert.deepEqual(await p.runtime.getQueueInvocation(requestId),complete);assert.equal(p.calls[0].name,'get_queue_invocation');
});
test('counts must reconcile with claimed items and allocation',async()=>{
 const bad={...complete,result:{status:'ran',counts:{...complete.result.counts,succeeded:2}}};await assert.rejects(port(bad).runtime.completeQueueInvocation(requestId));
 await assert.rejects(port({...complete,limit:1}).runtime.getQueueInvocation(requestId));
 await assert.rejects(port({...complete,result:{status:'ran',counts:{...complete.result.counts,extra:0}}}).runtime.getQueueInvocation(requestId));
});
test('unproven or unknown completion fails closed without HTTP counts',async()=>{
 const pending={...input,state:'unknown',result:null,closedAt:null};assert.deepEqual(await port(pending).runtime.getQueueInvocation(requestId),pending);
 await assert.rejects(port(pending).runtime.completeQueueInvocation(requestId));
 await assert.rejects(port({...pending,result:complete.result}).runtime.getQueueInvocation(requestId));
 await assert.rejects(port({requestId,state:'unknown',fresh:true}).runtime.prepareQueueInvocation(input));
});
test('maintenance counts derive only from bounded stored provider result',async()=>{
 const good={...complete,kind:'helpful_maintenance',result:{purged:0,processedItems:2}};assert.deepEqual(await port(good).runtime.completeQueueInvocation(requestId),good);
 await assert.rejects(port({...good,result:{purged:0,processedItems:1}}).runtime.completeQueueInvocation(requestId));
 await assert.rejects(port({...good,result:{purged:3,processedItems:2}}).runtime.completeQueueInvocation(requestId));
});
test('unsupported lane or impossible deadline performs no RPC',async()=>{
 const p=port(null);await assert.rejects(p.runtime.prepareQueueInvocation({...input,kind:'unsupported_kind' as never}));
 await assert.rejects(p.runtime.prepareQueueInvocation({...input,remainingMs:180001}));assert.equal(p.calls.length,0);
});

test('verified member and event lanes enforce their own DB allocation before any RPC',async()=>{
 for(const kind of ['member_cleanup','event_sync'] as const){
  const i={...input,kind,limit:10,remainingMs:60000};
  const p=port({requestId,state:'prepared',fresh:true});
  await p.runtime.prepareQueueInvocation(i);assert.equal(p.calls[0].name,'prepare_queue_invocation');
  const no=port(null);await assert.rejects(no.runtime.prepareQueueInvocation({...i,limit:11}));
  await assert.rejects(no.runtime.claimQueueInvocationDispatch({...i,limit:11}));assert.equal(no.calls.length,0);
  await assert.rejects(port({...complete,kind,limit:11}).runtime.getQueueInvocation(requestId));
 }
 const no=port(null);await assert.rejects(no.runtime.prepareQueueInvocation({...input,kind:'event_sync',remainingMs:60001}));
 await assert.rejects(no.runtime.claimQueueInvocationDispatch({...input,kind:'event_sync',remainingMs:60001}));assert.equal(no.calls.length,0);
 await assert.rejects(port({...complete,kind:'event_sync',remainingMs:60001}).runtime.getQueueInvocation(requestId));
});
