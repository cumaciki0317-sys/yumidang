import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerScopedIntentRuntime,canDispatchReportDelete,type WorkerScopedRequest} from '../../../backend/supabase/functions/_shared/db/worker-runtime-client.ts';
import type {JsonValue} from '../../../backend/supabase/functions/_shared/contracts/common.ts';
import type {RpcClient} from '../../../backend/supabase/functions/_shared/db/transport.ts';
const id=(n:number)=>`ef114000-0000-4000-8000-${String(n).padStart(12,'0')}`,parent=id(1),globalToken=id(2),ticket=id(3),key=id(4);
const request=():WorkerScopedRequest=>({requestId:key,operation:'job_claim',input:{workerId:id(5),leaseSeconds:180,supportedKinds:['report_retention']}});
function fixture(options:{lost?:boolean;existing?:boolean;missing?:boolean;scopeMismatch?:boolean;falseConfirmation?:boolean;purged?:boolean;begin?:boolean;prepareFail?:boolean}={}){
 const calls:Array<[string,Record<string,JsonValue>]> = [];let original:Record<string,JsonValue>|undefined,complete=false;
 const db:RpcClient={async rpc(name,args){calls.push([name,structuredClone(args)]);
  if(name==='prepare_worker_invocation_intent'){if(options.prepareFail)throw new Error('prepare failed');original={...args};return{ticket,state:'prepared',fresh:!options.existing};}
  if(name==='execute_worker_invocation_operation'){complete=true;if(options.lost)throw new Error('response lost');return saved(false);}
  if(name==='get_worker_runtime_intent')return{ticket,requestId:key,globalToken,operation:original!.p_operation,parentTicket:null,scope:options.scopeMismatch?{workerId:id(99),leaseSeconds:180,supportedKinds:['report_retention']}:original!.p_scope,state:'prepared'};
  if(name==='get_worker_runtime_operation'){if(options.missing||!complete&&!options.existing)throw new Error('result missing');return saved(true);}
  if(name==='confirm_worker_runtime_intent')return{ticket:options.falseConfirmation?id(99):ticket,state:'confirmed'};
  if(name==='observe_worker_runtime_intent')return{ticket,state:'unknown'};
  throw new Error('unexpected RPC');
 }};
 function saved(replayed:boolean):JsonValue{return options.purged?{requestId:key,state:'purged',result:null,closedAt:'2026-10-09T00:00:00Z',replayed}:{requestId:key,state:options.begin?'external_pending':'completed',result:options.begin?{taskId:id(9),dispatchId:id(10),alreadyApplied:false}:{job:null},closedAt:options.begin?null:'2026-10-09T00:00:00Z',replayed};}
 return{db,calls};
}
test('full immutable input and same key pass prepare/scoped execute/DB confirm',async()=>{
 const{db,calls}=fixture(),context={parentRequestId:parent,globalToken},r=request(),port=createWorkerScopedIntentRuntime(db,context);
 const pending=port.run(r);context.globalToken=id(99);(r.input as unknown as {supportedKinds:string[]}).supportedKinds.push('review_summary');
 assert.equal((await pending).state,'completed');
 assert.deepEqual(calls.map(([n])=>n),['prepare_worker_invocation_intent','execute_worker_invocation_operation','get_worker_runtime_intent','get_worker_runtime_operation','get_worker_runtime_intent','confirm_worker_runtime_intent']);
 assert.equal(calls[0][1].p_request_id,key);assert.equal(calls[1][1].p_request_id,key);assert.equal(calls[1][1].p_global_token,globalToken);assert.equal(calls[1][1].p_parent_request_id,parent);
 assert.deepEqual(calls[0][1].p_scope,{workerId:id(5),leaseSeconds:180,supportedKinds:['report_retention']});assert.deepEqual(calls[1][1].p_input,calls[0][1].p_scope);
});
test('response loss performs one dispatch then GET and exact confirmation',async()=>{
 const{db,calls}=fixture({lost:true}),result=await createWorkerScopedIntentRuntime(db,{parentRequestId:parent,globalToken}).run(request());
 assert.equal(result.replayed,true);assert.equal(calls.filter(([n])=>n==='execute_worker_invocation_operation').length,1);assert.equal(calls.filter(([n])=>n==='get_worker_runtime_operation').length,1);assert.equal(calls.filter(([n])=>n==='confirm_worker_runtime_intent').length,1);
});
test('existing prepared request is GET-only, never a fresh dispatch permit',async()=>{
 const{db,calls}=fixture({existing:true});await createWorkerScopedIntentRuntime(db,{parentRequestId:parent,globalToken}).run(request());assert.equal(calls.filter(([n])=>n==='execute_worker_invocation_operation').length,0);
});
test('missing result after a late rejected effect remains unknown without a second dispatch',async()=>{
 const{db,calls}=fixture({lost:true,missing:true});await assert.rejects(createWorkerScopedIntentRuntime(db,{parentRequestId:parent,globalToken}).run(request()));assert.equal(calls.filter(([n])=>n==='execute_worker_invocation_operation').length,1);assert.equal(calls.at(-1)?.[0],'observe_worker_runtime_intent');assert.equal(calls.filter(([n])=>n==='confirm_worker_runtime_intent').length,0);
});
test('false fullscope and false confirmation cannot become success',async()=>{
 for(const options of[{scopeMismatch:true,lost:true},{falseConfirmation:true},{purged:true}]){const{db,calls}=fixture(options);await assert.rejects(createWorkerScopedIntentRuntime(db,{parentRequestId:parent,globalToken}).run(request()));assert.equal(calls.at(-1)?.[0],'observe_worker_runtime_intent');if(options.scopeMismatch)assert.equal(calls.filter(([n])=>n==='confirm_worker_runtime_intent').length,0);}
});
test('failed prepare and already aborted signal send no mutation',async()=>{
 const{db,calls}=fixture({prepareFail:true});await assert.rejects(createWorkerScopedIntentRuntime(db,{parentRequestId:parent,globalToken}).run(request()));assert.equal(calls.length,1);
 const stopped=new AbortController();stopped.abort();const f=fixture();await assert.rejects(createWorkerScopedIntentRuntime(f.db,{parentRequestId:parent,globalToken},stopped.signal).run(request()));assert.equal(f.calls.length,0);
});
test('BEGIN is external pending, and lost BEGIN acknowledgement cannot authorize DELETE',async()=>{
 const begin:WorkerScopedRequest={requestId:key,operation:'report_storage',input:{taskId:id(9),taskLeaseToken:id(6),jobId:id(7),jobLeaseToken:id(8),objectId:id(11)}};
 for(const lost of[false,true]){const{db,calls}=fixture({begin:true,lost});const result=await createWorkerScopedIntentRuntime(db,{parentRequestId:parent,globalToken}).run(begin);assert.equal(canDispatchReportDelete(result),!lost);assert.equal(calls.filter(([n])=>n==='confirm_worker_runtime_intent').length,0);assert.equal(calls.filter(([n])=>n==='execute_worker_invocation_operation').length,1);}
});
test('ACK full hash and exact predecessor key cross the typed scoped boundary',async()=>{
 const f=fixture();const r:WorkerScopedRequest={requestId:key,operation:'report_storage_ack',predecessorRequestId:id(10),input:{taskId:id(9),taskLeaseToken:id(6),jobId:id(7),jobLeaseToken:id(8),objectId:id(11),ackSha256:'a'.repeat(64)}};
 await createWorkerScopedIntentRuntime(f.db,{parentRequestId:parent,globalToken}).run(r);assert.equal(f.calls[0][1].p_predecessor_request_id,id(10));assert.deepEqual(f.calls[1][1].p_input,r.input);
});
test('incomplete or additional operation input keys fail before any request',async()=>{
 const f=fixture(),port=createWorkerScopedIntentRuntime(f.db,{parentRequestId:parent,globalToken});
 await assert.rejects(port.run({...request(),input:{workerId:id(5)}}as WorkerScopedRequest));await assert.rejects(port.run({...request(),input:{...request().input,rawText:'forbidden'}}as unknown as WorkerScopedRequest));assert.equal(f.calls.length,0);
});
