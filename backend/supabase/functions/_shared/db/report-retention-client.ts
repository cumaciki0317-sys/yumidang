/** 민규: 신고 Storage 파기 task의 서비스 역할 RPC port. 전송 허용은 실제 guard/execute/예약·Provider 준비와 별개다.
 * 자동 enqueue/claim/complete/DELETE를 수행하지 않는다. 호출자는 ACK dispatch intent를 먼저 영속화해야 한다. */
import type { RuntimeConfig } from "../config/env.ts";
import type { ReportRetentionTask, ReportRetentionStoragePorts } from "../services/report-retention-storage.ts";
import { ReportRetentionStorageUnknown } from "../services/report-retention-storage.ts";
import { HttpError } from "../http/errors.ts";
import { createInternalClient } from "./internal-client.ts";
import type { FetchLike } from "./transport.ts";
export interface ReportRetentionJobContext { readonly jobId:string; readonly jobLeaseToken:string; readonly globalToken:string; }
const taskKeys=["taskId","taskLeaseToken","taskExpiresAt","reportId","closureRevision","kind","assetId","bucketId","objectName","objectId","retentionDueAt","closureProofId"]as const;
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
const id=(v:unknown):v is string=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)&&v!=="00000000-0000-0000-0000-000000000000";
const invalid=():never=>{throw new HttpError("INVALID_REQUEST");};
function timestamp(v:unknown):boolean{return typeof v==="string"&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,19)===v.slice(0,19);}
function task(value:unknown):ReportRetentionTask{
 const v=object(value);if(!v||Object.keys(v).length!==12||taskKeys.some(k=>!Object.hasOwn(v,k))||!id(v.taskId)||!id(v.taskLeaseToken)||!id(v.reportId)||!id(v.closureProofId)||!timestamp(v.taskExpiresAt)||!timestamp(v.retentionDueAt)||!Number.isSafeInteger(v.closureRevision)||Number(v.closureRevision)<1||v.kind!=="storage_object"||!id(v.assetId)||!id(v.objectId)||v.bucketId!=="report-evidence"||typeof v.objectName!=="string")return invalid();
 const p=v.objectName.split("/");if(p.length!==2||!id(p[0])||!new RegExp("^"+v.assetId+"\\.(jpg|png|webp)$").test(p[1]))return invalid();
 return Object.freeze({...v})as unknown as ReportRetentionTask;
}
function bound<T>(signal:AbortSignal,op:()=>Promise<T>,failure:()=>Error):Promise<T>{
 if(signal.aborted)return Promise.reject(failure());
 return new Promise((resolve,reject)=>{const abort=()=>reject(failure());signal.addEventListener("abort",abort,{once:true});Promise.resolve().then(()=>{if(signal.aborted)throw failure();return op();}).then(v=>signal.aborted?abort():resolve(v),reject).finally(()=>signal.removeEventListener("abort",abort));});
}
export function createReportRetentionStoragePorts(config:RuntimeConfig,context:ReportRetentionJobContext,fetchImpl:FetchLike=fetch):ReportRetentionStoragePorts{
 const c=object(context);if(!c||Object.keys(c).length!==3||["jobId","jobLeaseToken","globalToken"].some(k=>!id(c[k])))return invalid();
 const frozen=Object.freeze({...context});
 if(!Number.isSafeInteger(config.upstreamTimeoutMs)||config.upstreamTimeoutMs<1)return invalid();
 // 내부 설정을 확인한다. 사용자 JWT client fallback을 추가하지 않는다.
 createInternalClient(config,fetchImpl);
 async function invoke(name:string,value:ReportRetentionTask,signal:AbortSignal,hash?:string):Promise<unknown>{
  const t=task(value);if(!(signal instanceof AbortSignal)||(name==="record_report_retention_delete_ack"&&(typeof hash!=="string"||!/^[a-f0-9]{64}$/.test(hash))))return invalid();
  if(signal.aborted)throw new HttpError("STATE_CONFLICT");
  const local=new AbortController(),timer=setTimeout(()=>local.abort(),config.upstreamTimeoutMs),combined=AbortSignal.any([signal,local.signal]);let dispatched=false,rejected=false;
  const failure=()=>new HttpError(signal.aborted?"STATE_CONFLICT":"EXTERNAL_UNAVAILABLE");
  const wrapped:FetchLike=async(url,init)=>{
   if(combined.aborted)throw failure();const transport=init?.signal;const joined=transport?AbortSignal.any([combined,transport]):combined;
   if(joined.aborted)throw failure();dispatched=true;
   const response=await fetchImpl(url,{...init,signal:joined});if(combined.aborted){await response.body?.cancel();throw failure();}// 전송 의도/ACK 처리 뒤 proxy 5xx일 수 있으므로 명확한 인증·권한 거절만 확정 실패로 본다.
   rejected=response.status===401||response.status===403;return response;
  };
  const args={p_task_id:t.taskId,p_task_lease_token:t.taskLeaseToken,p_job_id:frozen.jobId,p_job_lease_token:frozen.jobLeaseToken,p_global_token:frozen.globalToken,p_object_id:t.objectId!,...(hash===undefined?{}:{p_ack_sha256:hash})};
  try{
   const result=await bound(combined,()=>createInternalClient(config,wrapped).rpc(name,args),failure);
   if(name==="check_report_retention_task"){
    let current:ReportRetentionTask;try{current=task(result);}catch{throw new HttpError("EXTERNAL_UNAVAILABLE");}
    if(taskKeys.some(k=>current[k]!==t[k]))throw new HttpError("STATE_CONFLICT");return current;
   }
   if(name==="begin_report_retention_delete"){
    const d=object(result);if(!d||Object.keys(d).length!==3||!["taskId","dispatchId","alreadyApplied"].every(k=>Object.hasOwn(d,k))||d.taskId!==t.taskId||!id(d.dispatchId)||typeof d.alreadyApplied!=="boolean")throw new HttpError("EXTERNAL_UNAVAILABLE");return Object.freeze({...d});
   }
   if(result===null&&name==="get_report_retention_delete_ack")return null;
   const r=object(result),keys=["receiptId","taskId","assetId","objectId","ackSha256"];
   if(!r||Object.keys(r).length!==5||keys.some(k=>!Object.hasOwn(r,k))||!id(r.receiptId)||r.taskId!==t.taskId||r.assetId!==t.assetId||r.objectId!==t.objectId||typeof r.ackSha256!=="string"||!/^[a-f0-9]{64}$/.test(r.ackSha256)||(hash!==undefined&&r.ackSha256!==hash))throw new HttpError("EXTERNAL_UNAVAILABLE");
   return Object.freeze({...r});
  }catch(error){if((name==="record_report_retention_delete_ack"||name==="begin_report_retention_delete")&&dispatched&&!rejected)throw new ReportRetentionStorageUnknown(name==="begin_report_retention_delete"?"dispatch":"ack");throw error;}finally{clearTimeout(timer);}
 }
 return Object.freeze({begin:(t:ReportRetentionTask,s:AbortSignal)=>invoke("begin_report_retention_delete",t,s),check:(t:ReportRetentionTask,s:AbortSignal)=>invoke("check_report_retention_task",t,s),getAck:(t:ReportRetentionTask,s:AbortSignal)=>invoke("get_report_retention_delete_ack",t,s),recordAck:(t:ReportRetentionTask,h:string,s:AbortSignal)=>invoke("record_report_retention_delete_ack",t,s,h)});
}

/** 30일 완료 증거 정리의 불확실한 결과. 호출자는 자동 반복·성공 집계·점유 해제를 하지 않는다. */
export class ReportRetentionMaintenanceUnknown extends Error {
 readonly terminal=true;
 constructor(){super("REPORT_RETENTION_MAINTENANCE_UNKNOWN");this.name="ReportRetentionMaintenanceUnknown";}
}
/** 이미 확보한 공유 예산·호출 수 안에서 단일 batch만 처리한다. 예약/점유/권한을 열지 않는다. */
export function createReportRetentionMaintenancePort(config:RuntimeConfig,fetchImpl:FetchLike=fetch){
 createInternalClient(config,fetchImpl);
 return async(globalToken:string,limit:number,signal:AbortSignal):Promise<Readonly<{purged:number}>>=>{
  if(!id(globalToken)||!Number.isSafeInteger(limit)||limit<1||limit>20||!(signal instanceof AbortSignal))return invalid();
  if(signal.aborted)throw new HttpError("STATE_CONFLICT");
  const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),config.upstreamTimeoutMs);
  const combined=AbortSignal.any([signal,timeout.signal]);let dispatched=false,rejected=false;
  const failure=()=>new HttpError(signal.aborted?"STATE_CONFLICT":"EXTERNAL_UNAVAILABLE");
  const wrapped:FetchLike=async(url,init)=>{
   if(combined.aborted)throw failure();
   const joined=AbortSignal.any([combined,...(init?.signal?[init.signal]:[])]);
   if(joined.aborted)throw failure();dispatched=true;
   const response=await fetchImpl(url,{...init,signal:joined});
   if(combined.aborted){await response.body?.cancel();throw failure();}
   rejected=response.status===401||response.status===403;return response;
  };
  try{
   const result=await bound(combined,()=>createInternalClient(config,wrapped).rpc("purge_report_retention_terminal_receipts",{p_global_token:globalToken,p_limit:limit}),failure);
   const value=object(result);
   if(!value||Object.keys(value).length!==1||!Object.hasOwn(value,"purged")||!Number.isSafeInteger(value.purged)||Number(value.purged)<0||Number(value.purged)>limit)throw new HttpError("EXTERNAL_UNAVAILABLE");
   return Object.freeze({purged:Number(value.purged)});
  }catch(error){if(dispatched&&!rejected)throw new ReportRetentionMaintenanceUnknown();throw error;}
  finally{clearTimeout(timer);}
 };
}
