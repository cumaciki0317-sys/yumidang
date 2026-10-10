/** 민규담당: 일반 콘텐츠 검사 연결 포트. 분류 기준·DB 소비·운영 승인을 대신하지 않는다. */
import type { JsonValue } from '../contracts/common.ts';
import { HttpError } from '../http/errors.ts';
export type ContentAction='post_create'|'post_update'|'profile_preferences'|'profile_traits'|'signup_traits'|'review'|'application_message'|'chat_message';
export type ContentDecision='allow'|'confirm_required'|'block';
export type ContentReason='PERSONAL_DATA'|'PROHIBITED_CONTENT'|'HIGH_RISK'|'AMBIGUOUS_RISK';
export interface ContentScope {userId:string;operationId:string;action:ContentAction;targetId:string;input:Readonly<Record<string,JsonValue>>;}
export interface ContentInspectionReadiness {approved:true;decisionId:string;policyVersion:string;scannerVersion:string;}
export interface ContentClassifier {
 inspect(input:{surface:'public'|'chat';fields:readonly {name:string;text:string}[]},signal:AbortSignal):Promise<{decision:ContentDecision;reasons:readonly ContentReason[]}>;
}
export interface ContentTicketIssuer {
 /** 실제 저장 RPC와 동일한 입력 전체를 DB에서 결합한다. 입력 원문을 ticket/log에 저장하지 않는다. */
 issue(input:ContentScope&{decision:ContentDecision;policyVersion:string;scannerVersion:string},signal:AbortSignal):Promise<{ticketId:string;userId:string;operationId:string;action:ContentAction;targetId:string}>;
}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!=='00000000-0000-0000-0000-000000000000';
const version=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(v);
const exact=(v:unknown,keys:readonly string[]):v is Record<string,JsonValue>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const definitions:Readonly<Record<string,{action:ContentAction;keys:readonly string[];target:string|null;text:string[];arrays:string[];surface:'public'|'chat'}>>=Object.freeze({
 create_service_post:{action:'post_create',keys:['p_post_id','p_input'],target:'p_post_id',text:[],arrays:[],surface:'public'},
 update_service_post:{action:'post_update',keys:['p_post_id','p_input','p_expected_updated_at'],target:'p_post_id',text:[],arrays:[],surface:'public'},
 set_my_profile_preferences:{action:'profile_preferences',keys:['p_interests','p_conversation_styles','p_mbti','p_bio'],target:null,text:['p_bio'],arrays:['p_interests','p_conversation_styles'],surface:'public'},
 set_my_profile_traits:{action:'profile_traits',keys:['p_interests','p_conversation_styles','p_mbti'],target:null,text:[],arrays:['p_interests','p_conversation_styles'],surface:'public'},
 complete_naver_signup:{action:'signup_traits',keys:['p_avatar_path','p_interests','p_conversation_styles','p_mbti'],target:null,text:[],arrays:['p_interests','p_conversation_styles'],surface:'public'},
 submit_appointment_review:{action:'review',keys:['p_appointment_id','p_rating','p_comment','p_experience','p_praises'],target:'p_appointment_id',text:['p_comment'],arrays:[],surface:'public'},
 request_service_post:{action:'application_message',keys:['p_post_id','p_message_id','p_message'],target:'p_post_id',text:['p_message'],arrays:[],surface:'chat'},
 send_conversation_message:{action:'chat_message',keys:['p_request_id','p_message_id','p_content'],target:'p_request_id',text:['p_content'],arrays:[],surface:'chat'},
});
/** 등록 주소/상세 지점·사진 경로·회원 UUID·시각을 텍스트 검사 범위에 섞지 않는다. 전체 입력은 DB 결합에만 사용한다. */
export function contentInspectionInput(rpc:string,args:Record<string,JsonValue>,userId:string,operationId:string){
 const d=definitions[rpc];
 if(!d||!id(userId)||!id(operationId)||!exact(args,d.keys))throw new HttpError('INVALID_REQUEST');
 const targetId=d.target?args[d.target]:userId;
 if(!id(targetId))throw new HttpError('INVALID_REQUEST');
 if(d.surface==='chat'&&args.p_message_id!==operationId)throw new HttpError('INVALID_REQUEST');
 const fields:{name:string;text:string}[]=[];
 const add=(name:string,v:JsonValue|undefined)=>{if(v===null)return;if(typeof v!=='string')throw new HttpError('INVALID_REQUEST');fields.push({name,text:v});};
 if(d.action==='post_create'||d.action==='post_update'){
  const p=args.p_input;
  if(!p||typeof p!=='object'||Array.isArray(p))throw new HttpError('INVALID_REQUEST');
  for(const name of ['title','description','preferenceNote','publicArea','registeredPlaceName'])add(name,p[name]);
  if(!Array.isArray(p.tags)||p.tags.some(v=>typeof v!=='string'))throw new HttpError('INVALID_REQUEST');
  p.tags.forEach((v,i)=>add(`tags.${i}`,v));
 }else{
  for(const name of d.text)add(name,args[name]);
  for(const name of d.arrays){const v=args[name];if(!Array.isArray(v)||v.some(x=>typeof x!=='string'))throw new HttpError('INVALID_REQUEST');v.forEach((x,i)=>add(`${name}.${i}`,x));}
 }
 // 원 입력의 변경으로 검사/발급이 서로 다른 본문을 승인하는 것을 막는다.
 const input=JSON.parse(JSON.stringify(args)) as Record<string,JsonValue>;
 const freeze=(value:JsonValue):void=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};
 freeze(input);
 return Object.freeze({scope:Object.freeze({userId,operationId,action:d.action,targetId,input}),inspection:Object.freeze({surface:d.surface,fields:Object.freeze(fields.map(v=>Object.freeze(v)))})});
}
function withinSignal<T>(signal:AbortSignal,operation:()=>Promise<T>):Promise<T>{
 if(signal.aborted)return Promise.reject(new HttpError('STATE_CONFLICT'));
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(new HttpError('STATE_CONFLICT'));
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(()=>{if(signal.aborted)throw new HttpError('STATE_CONFLICT');return operation();})
   .then(value=>signal.aborted?abort():resolve(value),reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
export function createContentInspection(readiness:ContentInspectionReadiness|undefined,classifier:ContentClassifier,issuer:ContentTicketIssuer){
 // 신뢰된 서버 조립값만 받는다. HTTP 입력·환경 문자열로 승인하지 않는다.
 const reviewed=readiness&&readiness.approved===true&&version(readiness.decisionId)&&version(readiness.policyVersion)&&version(readiness.scannerVersion)?Object.freeze({...readiness}):undefined;
 return Object.freeze({async inspect(rpc:string,args:Record<string,JsonValue>,userId:string,operationId:string,signal:AbortSignal){
  if(!reviewed)throw new HttpError('EXTERNAL_UNAVAILABLE');
  if(signal.aborted)throw new HttpError('STATE_CONFLICT');
  const binding=contentInspectionInput(rpc,args,userId,operationId);
  let result:Awaited<ReturnType<ContentClassifier['inspect']>>;
  try{result=await withinSignal(signal,()=>classifier.inspect(binding.inspection,signal));}catch{throw new HttpError('EXTERNAL_UNAVAILABLE');}
  if(signal.aborted)throw new HttpError('STATE_CONFLICT');
  if(!exact(result,['decision','reasons'])||!['allow','confirm_required','block'].includes(result.decision)||!Array.isArray(result.reasons)||new Set(result.reasons).size!==result.reasons.length)throw new HttpError('EXTERNAL_UNAVAILABLE');
  const allowed=binding.inspection.surface==='chat'?['HIGH_RISK','AMBIGUOUS_RISK']:['PERSONAL_DATA','PROHIBITED_CONTENT'];
  if(result.reasons.some(r=>!allowed.includes(r))||result.decision==='allow'&&result.reasons.length!==0||result.decision!=='allow'&&result.reasons.length===0||
   result.decision==='confirm_required'&&(binding.inspection.surface!=='chat'||result.reasons.length!==1||result.reasons[0]!=='AMBIGUOUS_RISK')||
   result.decision==='block'&&binding.inspection.surface==='chat'&&result.reasons.some(r=>r!=='HIGH_RISK'))throw new HttpError('EXTERNAL_UNAVAILABLE');
  let ticket:Awaited<ReturnType<ContentTicketIssuer['issue']>>;
  try{ticket=await withinSignal(signal,()=>issuer.issue({...binding.scope,decision:result.decision,policyVersion:reviewed.policyVersion,scannerVersion:reviewed.scannerVersion},signal));}catch{throw new HttpError('EXTERNAL_UNAVAILABLE');}
  if(signal.aborted)throw new HttpError('STATE_CONFLICT');
  if(!exact(ticket,['ticketId','userId','operationId','action','targetId'])||!id(ticket.ticketId)||ticket.userId!==userId||ticket.operationId!==operationId||ticket.action!==binding.scope.action||ticket.targetId!==binding.scope.targetId)throw new HttpError('EXTERNAL_UNAVAILABLE');
  return Object.freeze({decision:result.decision,reasons:Object.freeze([...result.reasons]),ticketId:ticket.ticketId});
 }});
}
