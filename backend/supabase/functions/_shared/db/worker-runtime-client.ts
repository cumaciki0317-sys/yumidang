/** 최소 intent 포트. observed_response를 원격 종결이나 재전송 허가로 해석하지 않는다. */
import type { RpcClient } from './transport.ts';
import { HttpError } from '../http/errors.ts';
export type WorkerIntentOperation='cycle'|'due_enqueue'|'job_claim'|'cancellation_process'|'report_task_claim'|'report_storage'|'report_task_complete'|'job_settlement'|'terminal_maintenance';
export type WorkerIntentState='prepared'|'unknown'|'observed_response';
export interface WorkerIntentInput { requestId:string;operation:WorkerIntentOperation;globalToken:string;scope:Readonly<Record<string,string|number>>;parentTicket?:string; }
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
function result(v:unknown):{ticket:string;state:WorkerIntentState}{
 if(!v||typeof v!=='object'||Array.isArray(v))throw new HttpError('EXTERNAL_UNAVAILABLE');
 const row=v as Record<string,unknown>;
 if(Object.keys(row).length!==2||!uuid(row.ticket)||!['prepared','unknown','observed_response'].includes(String(row.state)))throw new HttpError('EXTERNAL_UNAVAILABLE');
 return{ticket:row.ticket,state:row.state as WorkerIntentState};
}
export function createWorkerRuntimeJournal(db:RpcClient){return{
 async prepare(input:WorkerIntentInput){
  if(!uuid(input.requestId)||!uuid(input.globalToken)||input.parentTicket!==undefined&&!uuid(input.parentTicket))throw new HttpError('INVALID_REQUEST');
  return result(await db.rpc('prepare_worker_runtime_intent',{p_request_id:input.requestId,p_operation:input.operation,p_global_token:input.globalToken,p_scope:input.scope,p_parent_ticket:input.parentTicket??null}));
 },
 async observe(requestId:string,observed:boolean){
  if(!uuid(requestId)||typeof observed!=='boolean')throw new HttpError('INVALID_REQUEST');
  return result(await db.rpc('observe_worker_runtime_intent',{p_request_id:requestId,p_observed:observed}));
 },
 async hasPending(){
  const value=await db.rpc('read_worker_runtime_pending',{});
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||typeof value.hasPending!=='boolean')throw new HttpError('EXTERNAL_UNAVAILABLE');
  return value.hasPending;
 },
};}

/** SQL102 typed operation boundary. Stored results are evidence, never a fresh dispatch permit. */
import type { JsonValue } from '../contracts/common.ts';
export type WorkerRuntimeOperationInput =
 | { operation:'due_enqueue'; input:{kind:'cancellation_safety'|'report_retention';limit:number} }
 | { operation:'job_claim'; input:{workerId:string;leaseSeconds:180;supportedKinds:readonly ('review_summary'|'cancellation_safety'|'report_retention')[]} }
 | { operation:'cancellation_process'; input:{identityId:string;generation:number;jobId:string;jobLeaseToken:string} }
 | { operation:'report_task_claim'; input:{jobId:string;jobLeaseToken:string} }
 | { operation:'report_delete_begin'; input:{taskId:string;taskLeaseToken:string;jobId:string;jobLeaseToken:string;objectId:string} }
 | { operation:'report_delete_ack'; input:{taskId:string;taskLeaseToken:string;jobId:string;jobLeaseToken:string;objectId:string;ackSha256:string} }
 | { operation:'report_task_complete'; input:{taskId:string;taskLeaseToken:string;jobId:string;jobLeaseToken:string;objectId:string|null;evidenceSha256:string} }
 | { operation:'job_settlement'; input:{jobId:string;jobLeaseToken:string}&(
   {status:'succeeded'|'superseded'}|{status:'failed';errorCode:WorkerErrorCode}|
   {status:'queued';availableAt:string|null}|{status:'retry_wait';availableAt:string;errorCode:WorkerErrorCode}) }
 | { operation:'terminal_maintenance'; input:{limit:number} };
export type WorkerErrorCode='UPSTREAM_UNAVAILABLE'|'RATE_LIMITED'|'TIMEOUT'|'STATE_CHANGED'|'INTERNAL_ERROR';
export interface WorkerRuntimeOutcome { requestId:string;state:'completed'|'external_pending'|'purged';result:JsonValue;closedAt:string|null;replayed:boolean; }
function outcome(value:JsonValue,requestId:string):WorkerRuntimeOutcome {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==5||value.requestId!==requestId||
 !['completed','external_pending','purged'].includes(String(value.state))||!Object.hasOwn(value,'result')||typeof value.replayed!=='boolean'||
 !(value.closedAt===null||typeof value.closedAt==='string'&&Number.isFinite(Date.parse(value.closedAt)))||
 (value.state==='external_pending'&&value.closedAt!==null)||(value.state!=='external_pending'&&value.closedAt===null)||
 (value.state==='purged'&&value.result!==null))throw new HttpError('EXTERNAL_UNAVAILABLE');
 return value as unknown as WorkerRuntimeOutcome;
}
export function createWorkerAtomicRuntime(db:RpcClient){return Object.freeze({
 async execute(requestId:string,globalToken:string,operation:WorkerRuntimeOperationInput):Promise<WorkerRuntimeOutcome>{
  if(!uuid(requestId)||!uuid(globalToken))throw new HttpError('INVALID_REQUEST');
  return outcome(await db.rpc('execute_worker_runtime_operation',{p_request_id:requestId,p_global_token:globalToken,p_operation:operation.operation,p_input:operation.input as unknown as JsonValue}),requestId);
 },
 async get(requestId:string):Promise<WorkerRuntimeOutcome>{
  if(!uuid(requestId))throw new HttpError('INVALID_REQUEST');
  return outcome(await db.rpc('get_worker_runtime_operation',{p_request_id:requestId}),requestId);
 },
 async recovery(afterRequestId:string|null=null,limit=20):Promise<JsonValue>{
  if(afterRequestId!==null&&!uuid(afterRequestId)||!Number.isInteger(limit)||limit<1||limit>20)throw new HttpError('INVALID_REQUEST');
  const r=await db.rpc('read_worker_runtime_recovery',{p_after_request_id:afterRequestId,p_limit:limit});
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==2||!Array.isArray(r.pending)||r.pending.length>limit||!(r.nextCursor===null||uuid(r.nextCursor)))throw new HttpError('EXTERNAL_UNAVAILABLE');
  for(const row of r.pending){if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==5||!uuid(row.requestId)||!uuid(row.globalToken)||row.operation!=='report_delete_begin'||!row.input||typeof row.input!=='object'||Array.isArray(row.input)||Object.keys(row.input).sort().join(',')!=='jobId,jobLeaseToken,objectId,taskId,taskLeaseToken'||Object.values(row.input).some(v=>!uuid(v))||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt)))throw new HttpError('EXTERNAL_UNAVAILABLE');}
  return r;
 },
 async slots(globalToken:string):Promise<{used:number;remaining:number}>{
  if(!uuid(globalToken))throw new HttpError('INVALID_REQUEST');
  const r=await db.rpc('read_worker_runtime_slots',{p_global_token:globalToken});
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==2||!Number.isInteger(r.used)||!Number.isInteger(r.remaining)||
    typeof r.used!=='number'||typeof r.remaining!=='number'||r.used<0||r.used>20||r.remaining!==20-r.used)throw new HttpError('EXTERNAL_UNAVAILABLE');
  return{used:r.used,remaining:r.remaining};
 },
});}
/** Caller must only dispatch after a fresh, exact begin acknowledgement. Recovery is read-only. */
export function canDispatchReportDelete(result:WorkerRuntimeOutcome):boolean{
 const v=result.result;
 return result.state==='external_pending'&&!result.replayed&&!!v&&typeof v==='object'&&!Array.isArray(v)&&
 Object.keys(v).length===3&&uuid(v.taskId)&&uuid(v.dispatchId)&&v.alreadyApplied===false;
}

/** Product injection boundary. Maintenance has its own existing allocation, not queue slots. */
export function createWorkerConnectionPorts(db:RpcClient) {
 const atomic=createWorkerAtomicRuntime(db);
 const scheduleResult=(r:JsonValue)=>{
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==2||typeof r.serverNow!=='string'||!Number.isFinite(Date.parse(r.serverNow))||!(r.nextDueAt===null||typeof r.nextDueAt==='string'&&Number.isFinite(Date.parse(r.nextDueAt))))throw new HttpError('EXTERNAL_UNAVAILABLE');
  return r as {serverNow:string;nextDueAt:string|null};
 };
 return Object.freeze({atomic,
  async hasPending(){const r=await db.rpc('read_worker_runtime_pending_v2',{});if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==1||typeof r.hasPending!=='boolean')throw new HttpError('EXTERNAL_UNAVAILABLE');return r.hasPending;},
  async runtimeSchedule(token:string|null=null){if(token!==null&&!uuid(token))throw new HttpError('INVALID_REQUEST');return scheduleResult(await db.rpc('read_worker_runtime_maintenance_schedule',{p_global_token:token}));},
  async feedbackSchedule(token:string|null=null){if(token!==null&&!uuid(token))throw new HttpError('INVALID_REQUEST');return scheduleResult(await db.rpc('read_ai_feedback_maintenance_schedule',{p_global_token:token}));},
  async purgeRuntime(requestId:string,token:string,limit:number){if(!uuid(requestId)||!uuid(token)||!Number.isInteger(limit)||limit<1||limit>20)throw new HttpError('INVALID_REQUEST');const r=await db.rpc('purge_worker_runtime_details_scoped',{p_request_id:requestId,p_global_token:token,p_limit:limit});if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==1||!bounded(r.purged,0,limit))throw new HttpError('EXTERNAL_UNAVAILABLE');return{purged:r.purged,processedItems:limit};},
  async purgeFeedback(requestId:string,token:string,limit:number){if(!uuid(requestId)||!uuid(token)||!Number.isInteger(limit)||limit<1||limit>20)throw new HttpError('INVALID_REQUEST');const r=await db.rpc('purge_ai_feedback_scoped',{p_request_id:requestId,p_global_token:token,p_limit:limit});if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==1||typeof r.deletedCount!=='number'||!Number.isSafeInteger(r.deletedCount)||r.deletedCount<0||r.deletedCount>limit)throw new HttpError('EXTERNAL_UNAVAILABLE');return{purged:r.deletedCount,processedItems:limit};},
 });
}

/** SQL109: DB 감사 결과만 완료로 반환한다. unknown/prepared 재사용은 dispatch 허가가 아니다. */
export type WorkerInvocationKind='member_cleanup'|'event_sync'|'review_summary'|'cancellation_safety'|'report_retention'|'helpful_maintenance'|'terminal_maintenance'|'runtime_maintenance';
export interface WorkerInvocationInput {requestId:string;globalToken:string;kind:WorkerInvocationKind;limit:number;remainingMs:number;}
export type WorkerInvocationCounts={claimed:number;succeeded:number;retried:number;failed:number;superseded:number;yielded:number};
export type WorkerInvocationResult={status:'ran';counts:WorkerInvocationCounts}|{purged:number;processedItems:number};
export interface WorkerInvocationOutcome extends WorkerInvocationInput {state:'prepared'|'unknown'|'completed';result:WorkerInvocationResult|null;closedAt:string|null;}
const invocationKinds:readonly string[]=['member_cleanup','event_sync','review_summary','cancellation_safety','report_retention','helpful_maintenance','terminal_maintenance','runtime_maintenance'];
const bounded=(v:unknown,min:number,max:number):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
function invocationAllocation(kind:unknown,limit:unknown,remainingMs:unknown):boolean {
 return invocationKinds.includes(String(kind))&&bounded(limit,1,kind==='member_cleanup'||kind==='event_sync'?10:20)&&bounded(remainingMs,1,kind==='event_sync'?60000:180000);
}
function invocationOutcome(v:JsonValue,id:string):WorkerInvocationOutcome {
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='closedAt,globalToken,kind,limit,remainingMs,requestId,result,state'||v.requestId!==id||!uuid(v.globalToken)||!invocationAllocation(v.kind,v.limit,v.remainingMs)||!['prepared','unknown','completed'].includes(String(v.state)))throw new HttpError('EXTERNAL_UNAVAILABLE');
 if(v.state!=='completed'){if(v.result!==null||v.closedAt!==null)throw new HttpError('EXTERNAL_UNAVAILABLE');}
 else {
  if(typeof v.closedAt!=='string'||!Number.isFinite(Date.parse(v.closedAt))||!v.result||typeof v.result!=='object'||Array.isArray(v.result))throw new HttpError('EXTERNAL_UNAVAILABLE');
  const r=v.result;
  if(String(v.kind).endsWith('_maintenance')){
   if(Object.keys(r).sort().join(',')!=='processedItems,purged'||r.processedItems!==v.limit||!bounded(r.purged,0,v.limit as number))throw new HttpError('EXTERNAL_UNAVAILABLE');
  }else{
   if(Object.keys(r).sort().join(',')!=='counts,status'||r.status!=='ran'||!r.counts||typeof r.counts!=='object'||Array.isArray(r.counts)||Object.keys(r.counts).sort().join(',')!=='claimed,failed,retried,succeeded,superseded,yielded')throw new HttpError('EXTERNAL_UNAVAILABLE');
   const c=r.counts;if(Object.values(c).some(n=>!bounded(n,0,v.limit as number))||c.claimed!==Number(c.succeeded)+Number(c.retried)+Number(c.failed)+Number(c.superseded)+Number(c.yielded))throw new HttpError('EXTERNAL_UNAVAILABLE');
  }
 }
 return v as unknown as WorkerInvocationOutcome;
}
export function createWorkerInvocationRuntime(db:RpcClient){return Object.freeze({
 async prepareQueueInvocation(i:WorkerInvocationInput):Promise<{requestId:string;state:WorkerInvocationOutcome['state'];fresh:boolean}>{
  if(!uuid(i.requestId)||!uuid(i.globalToken)||!invocationAllocation(i.kind,i.limit,i.remainingMs))throw new HttpError('INVALID_REQUEST');
  const r=await db.rpc('prepare_queue_invocation',{p_request_id:i.requestId,p_global_token:i.globalToken,p_kind:i.kind,p_limit:i.limit,p_remaining_ms:i.remainingMs});
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join(',')!=='fresh,requestId,state'||r.requestId!==i.requestId||!['prepared','unknown','completed'].includes(String(r.state))||typeof r.fresh!=='boolean'||r.fresh&&r.state!=='prepared')throw new HttpError('EXTERNAL_UNAVAILABLE');
  return r as unknown as {requestId:string;state:WorkerInvocationOutcome['state'];fresh:boolean};
 },
 async claimQueueInvocationDispatch(i:WorkerInvocationInput):Promise<boolean>{
  if(!uuid(i.requestId)||!uuid(i.globalToken)||!invocationAllocation(i.kind,i.limit,i.remainingMs))throw new HttpError('INVALID_REQUEST');
  const r=await db.rpc('claim_queue_invocation_dispatch',{p_request_id:i.requestId,p_global_token:i.globalToken,p_kind:i.kind,p_limit:i.limit,p_remaining_ms:i.remainingMs});
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==1||typeof r.claimed!=='boolean')throw new HttpError('EXTERNAL_UNAVAILABLE');return r.claimed;
 },
 async getQueueInvocation(id:string){if(!uuid(id))throw new HttpError('INVALID_REQUEST');return invocationOutcome(await db.rpc('get_queue_invocation',{p_request_id:id}),id);},
 async completeQueueInvocation(id:string){if(!uuid(id))throw new HttpError('INVALID_REQUEST');const r=invocationOutcome(await db.rpc('complete_queue_invocation',{p_request_id:id}),id);if(r.state!=='completed')throw new HttpError('EXTERNAL_UNAVAILABLE');return r;},
 async markQueueInvocationUnknown(id:string){if(!uuid(id))throw new HttpError('INVALID_REQUEST');return invocationOutcome(await db.rpc('mark_queue_invocation_unknown',{p_request_id:id}),id);},
 });}

/** SQL114. Parent/global are immutable constructor inputs, never ambient keys. */
export type WorkerScopedOperationInput =
 | Exclude<WorkerRuntimeOperationInput,{operation:'report_delete_begin'|'report_delete_ack'|'terminal_maintenance'}>
 | {operation:'report_storage';input:Extract<WorkerRuntimeOperationInput,{operation:'report_delete_begin'}>['input']}
 | {operation:'report_storage_ack';input:Extract<WorkerRuntimeOperationInput,{operation:'report_delete_ack'}>['input']};
export type WorkerScopedRequest = WorkerScopedOperationInput & {requestId:string;predecessorRequestId?:string};
export interface WorkerScopedInvocationPort {
 readonly parentRequestId:string;
 readonly globalToken:string;
 run(request:WorkerScopedRequest):Promise<WorkerRuntimeOutcome>;
 get(request:WorkerScopedRequest):Promise<WorkerRuntimeOutcome>;
 confirm(request:WorkerScopedRequest):Promise<void>;
 unknown(requestId:string):Promise<void>;
}
const scopedStates=['prepared','unknown','observed_response','confirmed'];
function canonical(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
}
function snapshotScoped(request:WorkerScopedRequest):WorkerScopedRequest {
 if(!request||!uuid(request.requestId)||request.predecessorRequestId!==undefined&&!uuid(request.predecessorRequestId))throw new HttpError('INVALID_REQUEST');
 const op=request.operation,v=request.input as unknown as Record<string,unknown>;let keys:string[];
 switch(op){
 case'due_enqueue':keys=['kind','limit'];break;
 case'job_claim':keys=['workerId','leaseSeconds','supportedKinds'];break;
 case'cancellation_process':keys=['identityId','generation','jobId','jobLeaseToken'];break;
 case'report_task_claim':keys=['jobId','jobLeaseToken'];break;
 case'report_storage':keys=['taskId','taskLeaseToken','jobId','jobLeaseToken','objectId'];break;
 case'report_storage_ack':keys=['taskId','taskLeaseToken','jobId','jobLeaseToken','objectId','ackSha256'];break;
 case'report_task_complete':keys=['taskId','taskLeaseToken','jobId','jobLeaseToken','objectId','evidenceSha256'];break;
 case'job_settlement':
  keys=['jobId','jobLeaseToken','status'];if(v?.status==='queued'||v?.status==='retry_wait')keys.push('availableAt');if(v?.status==='failed'||v?.status==='retry_wait')keys.push('errorCode');break;
 default:throw new HttpError('INVALID_REQUEST');
 }
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))throw new HttpError('INVALID_REQUEST');
 for(const[k,x]of Object.entries(v)){
  if(['workerId','identityId','jobId','jobLeaseToken','taskId','taskLeaseToken','objectId'].includes(k)){if(!(k==='objectId'&&op==='report_task_complete'&&x===null)&&!uuid(x))throw new HttpError('INVALID_REQUEST');}
  else if(k==='leaseSeconds'){if(x!==180)throw new HttpError('INVALID_REQUEST');}
  else if(k==='supportedKinds'){if(!Array.isArray(x)||x.length<1||x.length>3||new Set(x).size!==x.length||x.some(v=>!['review_summary','cancellation_safety','report_retention'].includes(v)))throw new HttpError('INVALID_REQUEST');}
  else if(k==='generation'){if(typeof x!=='number'||!Number.isSafeInteger(x)||x<1)throw new HttpError('INVALID_REQUEST');}
  else if(k==='limit'){if(typeof x!=='number'||!Number.isInteger(x)||x<1||x>20)throw new HttpError('INVALID_REQUEST');}
  else if(k==='kind'){if(!['cancellation_safety','report_retention'].includes(String(x)))throw new HttpError('INVALID_REQUEST');}
  else if(k==='ackSha256'||k==='evidenceSha256'){if(typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x))throw new HttpError('INVALID_REQUEST');}
  else if(k==='status'){if(!['succeeded','queued','retry_wait','failed','superseded'].includes(String(x)))throw new HttpError('INVALID_REQUEST');}
  else if(k==='errorCode'){if(!['UPSTREAM_UNAVAILABLE','RATE_LIMITED','TIMEOUT','STATE_CHANGED','INTERNAL_ERROR'].includes(String(x)))throw new HttpError('INVALID_REQUEST');}
  else if(k==='availableAt'){if(!(op==='job_settlement'&&v.status==='queued'&&x===null)&&(typeof x!=='string'||!Number.isFinite(Date.parse(x))))throw new HttpError('INVALID_REQUEST');}
 }
 const copied=JSON.parse(JSON.stringify({requestId:request.requestId,operation:op,input:v,...(request.predecessorRequestId?{predecessorRequestId:request.predecessorRequestId}:{})}));
 if(Array.isArray(copied.input.supportedKinds))Object.freeze(copied.input.supportedKinds);Object.freeze(copied.input);return Object.freeze(copied);
}
export function createWorkerScopedIntentRuntime(db:RpcClient,binding:{parentRequestId:string;globalToken:string},signal?:AbortSignal):WorkerScopedInvocationPort {
 if(!uuid(binding?.parentRequestId)||!uuid(binding?.globalToken)||signal!==undefined&&!(signal instanceof AbortSignal))throw new HttpError('INVALID_REQUEST');
 const parentRequestId=binding.parentRequestId,globalToken=binding.globalToken,atomic=createWorkerAtomicRuntime(db);
 const stop=()=>{if(signal?.aborted)throw new HttpError('STATE_CONFLICT');};
 async function intent(request:WorkerScopedRequest){
  const v=await db.rpc('get_worker_runtime_intent',{p_request_id:request.requestId});
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='globalToken,operation,parentTicket,requestId,scope,state,ticket'||!uuid(v.ticket)||v.requestId!==request.requestId||v.globalToken!==globalToken||v.operation!==request.operation||v.parentTicket!==null||!scopedStates.includes(String(v.state))||canonical(v.scope)!==canonical(request.input))throw new HttpError('EXTERNAL_UNAVAILABLE');
  return v;
 }
 async function confirm(request:WorkerScopedRequest){
  const i=await intent(request),v=await db.rpc('confirm_worker_runtime_intent',{p_request_id:request.requestId});
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='state,ticket'||v.ticket!==i.ticket||v.state!=='confirmed')throw new HttpError('EXTERNAL_UNAVAILABLE');
 }
 async function get(request:WorkerScopedRequest){await intent(request);return atomic.get(request.requestId);}
 async function unknown(requestId:string){
  if(!uuid(requestId))throw new HttpError('INVALID_REQUEST');
  const v=await db.rpc('observe_worker_runtime_intent',{p_request_id:requestId,p_observed:false});
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='state,ticket'||!uuid(v.ticket)||!scopedStates.includes(String(v.state)))throw new HttpError('EXTERNAL_UNAVAILABLE');
 }
 return Object.freeze({parentRequestId,globalToken,
  get:(r:WorkerScopedRequest)=>get(snapshotScoped(r)),confirm:(r:WorkerScopedRequest)=>confirm(snapshotScoped(r)),unknown,
  async run(input:WorkerScopedRequest){
   const r=snapshotScoped(input);stop();
   const p=await db.rpc('prepare_worker_invocation_intent',{p_request_id:r.requestId,p_parent_invocation_id:parentRequestId,p_operation:r.operation,p_scope:r.input as unknown as JsonValue,p_predecessor_request_id:r.predecessorRequestId??null});
   if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).sort().join(',')!=='fresh,state,ticket'||!uuid(p.ticket)||!scopedStates.includes(String(p.state))||typeof p.fresh!=='boolean'||p.fresh&&p.state!=='prepared')throw new HttpError('EXTERNAL_UNAVAILABLE');
   let stored:WorkerRuntimeOutcome;
   try{
    if(p.fresh){
     stop();let acknowledged:WorkerRuntimeOutcome|undefined;
     try{acknowledged=outcome(await db.rpc('execute_worker_invocation_operation',{p_request_id:r.requestId,p_parent_request_id:parentRequestId,p_global_token:globalToken,p_operation:r.operation,p_input:r.input as unknown as JsonValue}),r.requestId);}catch{/* response loss: only the original key is read below */}
     stored=await get(r); // Always use DB stored data, including after successful HTTP.
     if(r.operation==='report_storage'&&acknowledged&&canDispatchReportDelete(acknowledged)&&stored.state===acknowledged.state&&stored.closedAt===acknowledged.closedAt&&canonical(stored.result)===canonical(acknowledged.result))stored={...stored,replayed:false};
    }else stored=await get(r); // Repeated/unknown requests never execute again.
    if(stored.state==='completed'){await confirm(r);return stored;}
    if(r.operation==='report_storage'&&stored.state==='external_pending')return stored; // BEGIN is not success and is confirmed only after task complete.
    throw new HttpError('EXTERNAL_UNAVAILABLE');
   }catch(error){try{await unknown(r.requestId);}catch{/* retain original prepared intent */}throw error;}
  },
 });
}
