/** 민규: 인증 뒤 일반 콘텐츠 검사·애매 채팅 확인을 연결한다. 실제 저장 승인은 SQL116이 원자로 소비한다. */
import type {RuntimeConfig} from '../_shared/config/env.ts';
import type {RequestContext,JsonValue} from '../_shared/contracts/common.ts';
import {requirePrincipal} from '../_shared/auth/principal.ts';
import type {FetchLike} from '../_shared/db/transport.ts';
import {createContentTicketIssuer,createContentTicketReader} from '../_shared/db/content-inspection-client.ts';
import {contentInspectionInput,createContentInspection,type ContentClassifier,type ContentInspectionReadiness} from '../_shared/services/content-inspection.ts';
import {HttpError} from '../_shared/http/errors.ts';
import {createRequestContext,readJson} from '../_shared/http/request.ts';
import {jsonFailure,jsonSuccess} from '../_shared/http/response.ts';
const object=(v:JsonValue):v is Record<string,JsonValue>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** 실행기 설치는 서버의 승인된 조립값에 한한다. 회원 본문/헤더로 검사기를 활성화하지 않는다. */
export function createContentInspectionExecutor(config:RuntimeConfig,readiness:ContentInspectionReadiness|undefined,classifier:ContentClassifier,fetchImpl:FetchLike=fetch){
 const inspection=createContentInspection(readiness,classifier,createContentTicketIssuer(config,fetchImpl));
 const reviewed=!!readiness&&readiness.approved===true&&[readiness.decisionId,readiness.policyVersion,readiness.scannerVersion].every(v=>/^[A-Za-z0-9_.:-]{1,80}$/.test(v));
 return async(request:Request,path:'inspect'|'confirm',context:RequestContext=createRequestContext()):Promise<Response>=>{
  try{
   if(request.method!=='POST')throw new HttpError('METHOD_NOT_ALLOWED');
   const principal=await requirePrincipal(request,config,fetchImpl);
   if(new URL(request.url).search||request.signal.aborted)throw new HttpError('INVALID_REQUEST');
   const body=await readJson(request,{maxBytes:config.maxRequestBytes});
   const keys=path==='inspect'?['input','operationId','rpc']:['input','operationId','rpc','ticketId'];
   if(!object(body)||Object.keys(body).sort().join(',')!==keys.sort().join(',')||typeof body.rpc!=='string'||typeof body.operationId!=='string'||!object(body.input))throw new HttpError('INVALID_REQUEST');
   const binding=contentInspectionInput(body.rpc,body.input,principal.userId,body.operationId);
   if(path==='inspect'){
    const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),config.upstreamTimeoutMs);
    try{
     const result=await inspection.inspect(body.rpc,body.input,principal.userId,body.operationId,AbortSignal.any([request.signal,deadline.signal]));
     return jsonSuccess({...result,reasons:[...result.reasons],operationId:body.operationId,action:binding.scope.action,targetId:binding.scope.targetId},context);
    }finally{clearTimeout(timer);}
   }
   if(!reviewed)throw new HttpError('EXTERNAL_UNAVAILABLE');
   if(typeof body.ticketId!=='string')throw new HttpError('INVALID_REQUEST');
   // DB는 confirm_required인 정확한 원 채팅만 확인한다. block/다른 입력/만료는 해제할 수 없다.
   const reader=createContentTicketReader(config,principal,request.signal,fetchImpl);
   const receipt=await reader.confirm(body.ticketId,binding.scope);
   return jsonSuccess(receipt,context);
  }catch(error){return jsonFailure(error,context);}
 };
}
