/** 민규: 신고 목적 Storage만 처리한다. 실제 DB 예약 trigger/권한/guard 검증 전 external ready는 false다.
 * check 콜백의 값만으로 이름 기반 DELETE가 objectId 조건부 삭제라고 주장하지 않는다.
 * 호출자는 deleteExact dispatch 전에 원 task/fence intent를 영속화해야 하며 unknown 후 자동 mutation을 금지한다.
 * 회원 탈퇴/Auth 삭제·직원 원JWT 열람·최종 종결 판단은 이 어댑터 책임이 아니다. */
import type { RuntimeConfig } from "../config/env.ts";
import { requireInternalConfig } from "../config/env.ts";
import { HttpError } from "../http/errors.ts";
export interface ReportRetentionTask {
 readonly taskId:string;readonly taskLeaseToken:string;readonly taskExpiresAt:string;readonly reportId:string;readonly closureRevision:number;
 readonly kind:"storage_object"|"report_metadata";readonly assetId:string|null;readonly bucketId:"report-evidence"|null;
 readonly objectName:string|null;readonly objectId:string|null;readonly retentionDueAt:string;readonly closureProofId:string;
}
export interface ReportRetentionDeleteAck {readonly receiptId:string;readonly taskId:string;readonly assetId:string;readonly objectId:string;readonly ackSha256:string;}
export interface ReportRetentionStoragePorts {
 /** 실제 current DB reservation/목적·task/job/global fence와 DBclock을 검사하고 exact12를 반환해야 한다. */
 check(task:ReportRetentionTask,signal:AbortSignal):Promise<unknown>;
 /** 최초 alreadyApplied=false만 새DELETE 허가다. 중복/유실은 자동 재전송하지 않는다. */
 begin(task:ReportRetentionTask,signal:AbortSignal):Promise<unknown>;
 getAck(task:ReportRetentionTask,signal:AbortSignal):Promise<unknown>;
 recordAck(task:ReportRetentionTask,ackSha256:string,signal:AbortSignal):Promise<unknown>;
}
/** 전송 의도·DELETE 또는 ACK 결과가 불확실하면 자동 재DELETE/완료/cleanup을 금지하고 durable journal을 보존한다. */
export class ReportRetentionStorageUnknown extends Error {
 readonly terminal=true;
 readonly phase:"dispatch"|"delete"|"ack";
 constructor(phase:"dispatch"|"delete"|"ack"){super("REPORT_RETENTION_REMOTE_COMPLETION_UNKNOWN");this.name="ReportRetentionStorageUnknown";this.phase=phase;}
}
const keys=["taskId","taskLeaseToken","taskExpiresAt","reportId","closureRevision","kind","assetId","bucketId","objectName","objectId","retentionDueAt","closureProofId"]as const;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const rec=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
const id=(v:unknown):v is string=>typeof v==="string"&&uuid.test(v)&&v!=="00000000-0000-0000-0000-000000000000";
const fail=():never=>{throw new HttpError("EXTERNAL_UNAVAILABLE");};
function timestamp(v:unknown):boolean{if(typeof v!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v)||!Number.isFinite(Date.parse(v)))return false;return new Date(v).toISOString().slice(0,19)===v.slice(0,19);}
function task(value:unknown):ReportRetentionTask{
 const v=rec(value);if(!v||Object.keys(v).length!==12||keys.some(k=>!Object.hasOwn(v,k))||!id(v.taskId)||!id(v.taskLeaseToken)||!id(v.reportId)||!id(v.closureProofId)||!timestamp(v.taskExpiresAt)||!timestamp(v.retentionDueAt)||!Number.isSafeInteger(v.closureRevision)||Number(v.closureRevision)<1)return fail();
 if(v.kind==="storage_object"){
  if(!id(v.assetId)||!id(v.objectId)||v.bucketId!=="report-evidence"||typeof v.objectName!=="string")return fail();
  const parts=v.objectName.split("/");if(parts.length!==2||!id(parts[0])||!new RegExp("^"+v.assetId+"\\.(jpg|png|webp)$").test(parts[1]))return fail();
 }else if(v.kind!=="report_metadata"||[v.assetId,v.bucketId,v.objectName,v.objectId].some(v=>v!==null))return fail();
 return Object.freeze({...v})as unknown as ReportRetentionTask;
}
function ack(v:unknown,t:ReportRetentionTask):ReportRetentionDeleteAck{
 const r=rec(v),k=["receiptId","taskId","assetId","objectId","ackSha256"];if(!r||Object.keys(r).length!==5||k.some(k=>!Object.hasOwn(r,k))||!id(r.receiptId)||r.taskId!==t.taskId||r.assetId!==t.assetId||r.objectId!==t.objectId||typeof r.ackSha256!=="string"||!/^[a-f0-9]{64}$/.test(r.ackSha256))return fail();return Object.freeze({...r})as unknown as ReportRetentionDeleteAck;
}
function absent(r:{status:number;value:unknown}):boolean{return r.status===404||(r.status===400&&rec(r.value)?.code==="NoSuchKey"&&rec(r.value)?.statusCode==="404");}
async function sha(value:unknown):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value))))).map(v=>v.toString(16).padStart(2,"0")).join("");}
function bounded<T>(signal:AbortSignal,operation:()=>Promise<T>):Promise<T>{
 if(signal.aborted)return Promise.reject(new HttpError("STATE_CONFLICT"));
 return new Promise((resolve,reject)=>{const stop=()=>reject(new HttpError("STATE_CONFLICT"));signal.addEventListener("abort",stop,{once:true});Promise.resolve().then(()=>{if(signal.aborted)throw new HttpError("STATE_CONFLICT");return operation();}).then(v=>signal.aborted?stop():resolve(v),reject).finally(()=>signal.removeEventListener("abort",stop));});
}
export function createReportRetentionStorageAdapter(config:RuntimeConfig,fetchImpl:typeof fetch=fetch){
 const {serviceKey}=requireInternalConfig(config);try{const u=new URL(config.supabaseUrl);if(u.origin!==config.supabaseUrl||u.username||u.password||(u.protocol!=="https:"&&!(u.protocol==="http:"&&["localhost","127.0.0.1","[::1]","kong"].includes(u.hostname)))||!Number.isSafeInteger(config.upstreamTimeoutMs)||config.upstreamTimeoutMs<1)return fail();}catch{return fail();}
 async function request(path:string,method:"GET"|"DELETE",signal:AbortSignal,body?:unknown,read=true){
  if(signal.aborted)throw new HttpError("STATE_CONFLICT");const local=new AbortController(),timer=setTimeout(()=>local.abort(),config.upstreamTimeoutMs),combined=AbortSignal.any([signal,local.signal]);
  try{return await bounded(combined,async()=>{const r=await fetchImpl(config.supabaseUrl+path,{method,redirect:"error",signal:combined,headers:{apikey:serviceKey,authorization:"Bearer "+serviceKey,"content-type":"application/json",accept:"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});let value:unknown=null;
   if((read&&r.status===200)||r.status===400){if(!r.body)return fail();const reader=r.body.getReader();let n=0;const chunks:Uint8Array[]=[];try{while(true){const part=await reader.read();if(part.done)break;n+=part.value.length;if(n>65536)return fail();chunks.push(part.value);}}finally{await reader.cancel();}const bytes=new Uint8Array(n);let p=0;for(const c of chunks){bytes.set(c,p);p+=c.length;}value=JSON.parse(new TextDecoder().decode(bytes));}else await r.body?.cancel();return {status:r.status,value};});}finally{clearTimeout(timer);}
 }
 const path=(t:ReportRetentionTask)=>t.objectName!.split("/").map(encodeURIComponent).join("/");
 async function verifyAbsentBytes(value:unknown,signal:AbortSignal){const t=task(value);if(t.kind!=="storage_object")return fail();for(const endpoint of["info/authenticated/","authenticated/"]){if(!absent(await request("/storage/v1/object/"+endpoint+"report-evidence/"+path(t),"GET",signal,undefined,false)))return fail();}}
 async function deleteExact(value:unknown,ports:ReportRetentionStoragePorts,signal:AbortSignal):Promise<{status:"verified";ack:ReportRetentionDeleteAck}>{
  const t=task(value);if(t.kind!=="storage_object"||!(signal instanceof AbortSignal)||!ports||[ports.check,ports.getAck,ports.recordAck,ports.begin].some(v=>typeof v!=="function"))return fail();
  const check=async()=>{const current=task(await bounded(signal,()=>ports.check(t,signal)));if(keys.some(k=>current[k]!==t[k]))throw new HttpError("STATE_CONFLICT");};
  await check();const existing=await bounded(signal,()=>ports.getAck(t,signal));if(existing!==null){const a=ack(existing,t);await verifyAbsentBytes(t,signal);await check();return {status:"verified",ack:a};}
  const info=await request("/storage/v1/object/info/authenticated/report-evidence/"+path(t),"GET",signal);const found=rec(info.value);const extension=t.objectName!.split(".").at(-1),mime={jpg:"image/jpeg",png:"image/png",webp:"image/webp"}[extension as "jpg"|"png"|"webp"];
  if(info.status!==200||found?.id!==t.objectId||found?.name!==t.objectName||found?.bucket_id!==t.bucketId||found?.content_type!==mime||!Number.isSafeInteger(found?.size)||Number(found?.size)<1||Number(found?.size)>5242880)return fail();
  await check();
  try{const d=rec(await bounded(signal,()=>ports.begin(t,signal)));if(!d||Object.keys(d).length!==3||!["taskId","dispatchId","alreadyApplied"].every(k=>Object.hasOwn(d,k))||d.taskId!==t.taskId||!id(d.dispatchId)||d.alreadyApplied!==false)throw new Error("UNCONFIRMED_DELETE_INTENT");await check();}catch{throw new ReportRetentionStorageUnknown("dispatch");}
  let response:{status:number;value:unknown};try{response=await request("/storage/v1/object/report-evidence","DELETE",signal,{prefixes:[t.objectName]});const rows=response.value;if(response.status!==200||!Array.isArray(rows)||rows.length!==1||rec(rows[0])?.id!==t.objectId||rec(rows[0])?.name!==t.objectName||(rec(rows[0])?.bucket_id!==undefined&&rec(rows[0])?.bucket_id!==t.bucketId)||signal.aborted)throw new Error("UNVERIFIED_DELETE_ACK");}catch{throw new ReportRetentionStorageUnknown("delete");}
  let a:ReportRetentionDeleteAck;try{await check();const h=await sha({version:1,taskId:t.taskId,reportId:t.reportId,closureRevision:t.closureRevision,assetId:t.assetId,objectId:t.objectId,deleteAcknowledged:true});a=ack(await bounded(signal,()=>ports.recordAck(t,h,signal)),t);if(a.ackSha256!==h)return fail();}catch{throw new ReportRetentionStorageUnknown("ack");}
  await verifyAbsentBytes(t,signal);await check();return {status:"verified",ack:a};
 }
 async function verifyAbsent(value:unknown,ports:ReportRetentionStoragePorts,signal:AbortSignal){
  const t=task(value);if(t.kind!=="storage_object"||!(signal instanceof AbortSignal)||!ports||[ports.check,ports.getAck,ports.recordAck].some(v=>typeof v!=="function"))return fail();
  const check=async()=>{const current=task(await bounded(signal,()=>ports.check(t,signal)));if(keys.some(k=>current[k]!==t[k]))throw new HttpError("STATE_CONFLICT");};
  await check();const prior=await bounded(signal,()=>ports.getAck(t,signal));if(prior===null)throw new HttpError("STATE_CONFLICT");const a=ack(prior,t);await verifyAbsentBytes(t,signal);await check();return {status:"verified"as const,ack:a};
 }
 return Object.freeze({deleteExact,verifyAbsent});
}
