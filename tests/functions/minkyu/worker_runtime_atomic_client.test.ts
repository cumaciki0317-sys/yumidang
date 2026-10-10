import {test} from 'node:test';import assert from 'node:assert/strict';
import {createWorkerAtomicRuntime,canDispatchReportDelete,type WorkerRuntimeOutcome} from '../../../backend/supabase/functions/_shared/db/worker-runtime-client.ts';
import type {JsonValue} from '../../../backend/supabase/functions/_shared/contracts/common.ts';
const id='ab102000-0000-4000-8000-000000000001';
const result:WorkerRuntimeOutcome={requestId:id,state:'external_pending',result:{taskId:id,dispatchId:id,alreadyApplied:false},closedAt:null,replayed:false};
test('새 dispatch만 허용하고 재조회·기존 dispatch를 거절',()=>{
 assert.equal(canDispatchReportDelete(result),true);
 assert.equal(canDispatchReportDelete({...result,replayed:true}),false);
 assert.equal(canDispatchReportDelete({...result,result:{taskId:id,dispatchId:id,alreadyApplied:true}}),false);
 assert.equal(canDispatchReportDelete({...result,state:'purged',result:null}),false);
});
test('응답 유실 시 자동 재전송 없이 get은 읽기 RPC만 호출',async()=>{
 let calls=0;const port=createWorkerAtomicRuntime({rpc:async(name)=>{calls++;if(name==='get_worker_runtime_operation')return{...result,replayed:true};throw new Error('lost');}});
 await assert.rejects(port.execute(id,id,{operation:'job_claim',input:{workerId:id,leaseSeconds:180,supportedKinds:['review_summary']}}));
 assert.equal(calls,1);assert.deepEqual(await port.get(id),{...result,replayed:true});assert.equal(calls,2);
});
test('extra response fields and invalid slot totals fail closed',async()=>{
 const p=createWorkerAtomicRuntime({rpc:async(name):Promise<JsonValue>=>name==='get_worker_runtime_operation'?{...result,extra:'raw'}:{used:20,remaining:1}});
 await assert.rejects(p.get(id));await assert.rejects(p.slots(id));
});

test('UNKNOWN 복구 조회는 dispatch를 호출하지 않고 추가 봉투 필드를 거절한다',async()=>{
 let calls:string[]=[];
 const good={pending:[{requestId:id,globalToken:id,operation:'report_delete_begin',input:{taskId:id,taskLeaseToken:id,jobId:id,jobLeaseToken:id,objectId:id},createdAt:'2026-10-08T00:00:00Z'}],nextCursor:null};
 const p=createWorkerAtomicRuntime({rpc:async(name):Promise<JsonValue>=>{calls.push(name);return good;}});
 assert.deepEqual(await p.recovery(null,20),good);assert.deepEqual(calls,['read_worker_runtime_recovery']);
 const bad=createWorkerAtomicRuntime({rpc:async():Promise<JsonValue>=>({...good,raw:'forbidden'})});await assert.rejects(bad.recovery(null,20));
});
