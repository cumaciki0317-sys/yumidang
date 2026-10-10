/** 민규: 승인 검사기의 ticket 발급과 원 사용자 JWT의 저장 경계를 연결한다. 원문 기록·자동 재전송 없음. */
import type { RuntimeConfig } from '../config/env.ts';
import type { Principal } from '../auth/principal.ts';
import { getPrincipalToken } from '../auth/principal.ts';
import type { JsonValue } from '../contracts/common.ts';
import { HttpError } from '../http/errors.ts';
import { createRpcTransport,type FetchLike,type RpcClient } from './transport.ts';
import { createUserClient } from './user-client.ts';
import { createInternalClient } from './internal-client.ts';
import { contentInspectionInput,type ContentTicketIssuer,type ContentScope } from '../services/content-inspection.ts';
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!=='00000000-0000-0000-0000-000000000000';
const exact=(v:unknown,keys:string[]):v is Record<string,JsonValue>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
const writes=new Set(['create_service_post','update_service_post','set_my_profile_traits','set_my_profile_preferences','complete_naver_signup','submit_appointment_review','request_service_post','send_conversation_message']);
function scopedFetch(fetchImpl:FetchLike,signal:AbortSignal,headers?:Readonly<Record<string,string>>):FetchLike{
 return (url,init)=>{if(signal.aborted)throw new HttpError('STATE_CONFLICT');const h=new Headers(init?.headers);for(const [key,value]of Object.entries(headers??{}))h.set(key,value);return fetchImpl(url,{...init,headers:h,signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])});};
}
export function createContentTicketIssuer(config:RuntimeConfig,fetchImpl:FetchLike=fetch):ContentTicketIssuer{
 return Object.freeze({async issue(input:Parameters<ContentTicketIssuer["issue"]>[0],signal:AbortSignal){
  if(signal.aborted)throw new HttpError('STATE_CONFLICT');
  const db=createInternalClient(config,scopedFetch(fetchImpl,signal));
  const r=await db.rpc('issue_content_inspection_ticket',{p_user_id:input.userId,p_operation_id:input.operationId,p_action:input.action,p_target_id:input.targetId,p_input:input.input as Record<string,JsonValue>,p_decision:input.decision,p_policy_version:input.policyVersion,p_scanner_version:input.scannerVersion});
  if(signal.aborted||!exact(r,['ticketId','userId','operationId','action','targetId'])||!id(r.ticketId)||r.userId!==input.userId||r.operationId!==input.operationId||r.action!==input.action||r.targetId!==input.targetId)throw new HttpError('EXTERNAL_UNAVAILABLE');
  return {ticketId:r.ticketId,userId:input.userId,operationId:input.operationId,action:input.action,targetId:input.targetId};
 }});
}
export interface ContentTicketReceipt {ticketId:string;userId:string;operationId:string;action:ContentScope['action'];targetId:string;decision:'allow'|'block'|'confirm_required';confirmed:boolean;consumed:boolean;expiresAt:string;}
/** 조회·확인은 두 전용 사용자 RPC만 허용한다. 서비스 자격이나 decoded sub를 대체 호출자로 사용하지 않는다. */
export function createContentTicketReader(config:RuntimeConfig,principal:Principal,signal:AbortSignal,fetchImpl:FetchLike=fetch){
 const token=getPrincipalToken(principal);
 const db=createRpcTransport(config,config.supabaseAnonKey,token,new Set(['get_my_content_inspection_ticket','confirm_my_content_inspection_ticket']),scopedFetch(fetchImpl,signal));
 return Object.freeze({
  async get(ticketId:string,operationId:string):Promise<ContentTicketReceipt>{
   if(!id(ticketId)||!id(operationId))throw new HttpError('INVALID_REQUEST');
   const r=await db.rpc('get_my_content_inspection_ticket',{p_ticket_id:ticketId,p_operation_id:operationId});
   if(signal.aborted||!exact(r,['ticketId','userId','operationId','action','targetId','decision','confirmed','consumed','expiresAt'])||r.ticketId!==ticketId||r.operationId!==operationId||r.userId!==principal.userId||!id(r.targetId)||!['post_create','post_update','profile_traits','profile_preferences','signup_traits','review','application_message','chat_message'].includes(String(r.action))||!['allow','block','confirm_required'].includes(String(r.decision))||typeof r.confirmed!=='boolean'||typeof r.consumed!=='boolean'||typeof r.expiresAt!=='string'||!Number.isFinite(Date.parse(r.expiresAt)))throw new HttpError('EXTERNAL_UNAVAILABLE');
   return r as unknown as ContentTicketReceipt;
  },
  async confirm(ticketId:string,scope:ContentScope){
   if(!id(ticketId)||scope.userId!==principal.userId||!id(scope.operationId)||!id(scope.targetId)||!['application_message','chat_message'].includes(scope.action))throw new HttpError('INVALID_REQUEST');
   const r=await db.rpc('confirm_my_content_inspection_ticket',{p_ticket_id:ticketId,p_operation_id:scope.operationId,p_action:scope.action,p_target_id:scope.targetId,p_input:scope.input as Record<string,JsonValue>});
   if(signal.aborted||!exact(r,['ticketId','userId','operationId','action','targetId'])||r.ticketId!==ticketId||r.userId!==principal.userId||r.operationId!==scope.operationId||r.action!==scope.action||r.targetId!==scope.targetId)throw new HttpError('EXTERNAL_UNAVAILABLE');
   return {ticketId,operationId:scope.operationId};
  },
 });
}
/** 실제 검사·소비자 검토를 끝낸 서버 조립에서만 설치한다. 헤더는 승인값이 아니라 DB 결합용 키다. */
export function createContentWriteClient(config:RuntimeConfig,principal:Principal,request:Request,fetchImpl:FetchLike=fetch):RpcClient{
 const ticketId=request.headers.get('x-content-inspection-ticket'),operationId=request.headers.get('x-content-operation-id');
 const read=createContentTicketReader(config,principal,request.signal,fetchImpl);
 const ordinary=createUserClient(config,principal,scopedFetch(fetchImpl,request.signal));
 return Object.freeze({supportsRpc:ordinary.supportsRpc,async rpc(name:string,args:Record<string,JsonValue>){
  if(!writes.has(name))return ordinary.rpc(name,args);
  if(!id(ticketId)||!id(operationId))throw new HttpError('INVALID_REQUEST');
  const binding=contentInspectionInput(name,args,principal.userId,operationId);
  const receipt=await read.get(ticketId,operationId);
  if(receipt.action!==binding.scope.action||receipt.targetId!==binding.scope.targetId)throw new HttpError('STATE_CONFLICT');
  if(receipt.decision==='block')throw new HttpError('ACCESS_DENIED');
  if(receipt.decision==='confirm_required'&&!receipt.confirmed)throw new HttpError('STATE_CONFLICT');
  if(!receipt.consumed&&Date.parse(receipt.expiresAt)<=Date.now())throw new HttpError('STATE_CONFLICT');
  if(request.signal.aborted)throw new HttpError('STATE_CONFLICT');
  const writer=createUserClient(config,principal,scopedFetch(fetchImpl,request.signal,{'x-content-inspection-ticket':ticketId,'x-content-operation-id':operationId}));
  // SQL116 rechecks digest/actor/target/version/deadline and consumes in the actual write transaction.
  return writer.rpc(name,binding.scope.input as Record<string,JsonValue>);
 }});
}
