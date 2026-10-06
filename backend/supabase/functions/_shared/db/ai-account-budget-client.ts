/** 민규: 종현 AccountReservationPort와 원자 RPC 연결. 키·원문은 전달하지 않는다. */
import type {RpcClient} from './transport.ts';
import type {AccountReservationPort} from '../ai/providers/account-pool.ts';
import {ModelError} from '../ai/providers/provider-errors.ts';
import {isSourceRevision,isSummaryVersion} from './repositories/review-summaries.ts';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const accounts=['yumi','jonghyun','minkyu','sungho'];
const validDay=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
export function createRpcAccountBudget(db:RpcClient,options:{ledgerId:string;promptOverheadBytes:number}):AccountReservationPort {
 if(!db||typeof db.rpc!=='function'||!/^[A-Za-z0-9_.:-]{1,64}$/.test(options?.ledgerId)||!integer(options.promptOverheadBytes))throw new ModelError('NOT_CONFIGURED');
 const {ledgerId,promptOverheadBytes}=options;
 return {
  async reserve(input){
   const member=input.memberRequest,summary=input.summaryRequest;
   const units=input.inputBytes+promptOverheadBytes+input.maxOutputTokens;
   if(!accounts.includes(input.accountId)||!integer(input.inputBytes)||!integer(input.maxOutputTokens)||input.maxOutputTokens<1||!integer(units)||units<1||Boolean(member)===Boolean(summary)||!['intent','preference_match','explanation','review_chunk','review_merge'].includes(input.task)||['review_chunk','review_merge'].includes(input.task)!==Boolean(summary))throw new ModelError('INVALID_MODEL_RESPONSE');
   if(member&&![member.userId,member.requestId,member.leaseToken].every(uuid))throw new ModelError('INVALID_MODEL_RESPONSE');
   if(summary&&(![summary.jobId,summary.leaseToken,summary.targetUserId,summary.workerRunToken].every(uuid)||!isSourceRevision(summary.sourceRevision)||!isSummaryVersion(summary.modelVersion)||!isSummaryVersion(summary.promptVersion)||!Array.isArray(summary.sourceReviewIds)||summary.sourceReviewIds.length<3||!summary.sourceReviewIds.every(uuid)||new Set(summary.sourceReviewIds).size!==summary.sourceReviewIds.length))throw new ModelError('INVALID_MODEL_RESPONSE');
   const result=await db.rpc(member?'reserve_ai_chat_account_model':'reserve_review_summary_account_model',{
    p_ledger_id:ledgerId,p_provider_id:'potens',p_task:input.task,p_units:units,p_account_id:input.accountId,p_contract_version:'2026-10-05',
    ...(member?{p_user_id:member.userId,p_request_id:member.requestId,p_lease_token:member.leaseToken}:{}),
    ...(summary?{p_job_id:summary.jobId,p_lease_token:summary.leaseToken,p_target_user_id:summary.targetUserId,p_source_revision:summary.sourceRevision,p_worker_run_token:summary.workerRunToken,p_model_version:summary.modelVersion,p_prompt_version:summary.promptVersion,p_source_review_ids:[...summary.sourceReviewIds]}:{})
   });
   if(!result||typeof result!=='object'||Array.isArray(result))throw new ModelError('INVALID_MODEL_RESPONSE');
   if(Object.keys(result).length===1&&summary&&['stale_revision','insufficient_reviews','invalid_evidence'].includes(String(result.status)))throw new ModelError('SUMMARY_SOURCE_CHANGED');
   if(Object.keys(result).length===1&&result.status==='consent_revoked')throw new ModelError('AI_CONSENT_REVOKED');
   if(Object.keys(result).length===1&&result.status==='daily_limit')throw new ModelError('MEMBER_DAILY_LIMIT');
   if(Object.keys(result).length===1&&result.status==='lease_lost')throw new ModelError('REQUEST_LEASE_LOST');
   if(result.status==='account_budget_denied'||result.status==='global_budget_denied'){
    if(Object.keys(result).length!==2||result.reservationId!==null)throw new ModelError('INVALID_MODEL_RESPONSE');
    return {status:result.status};
   }
   if(result.status!=='reserved'||Object.keys(result).length!==4||result.accountId!==input.accountId||!uuid(result.reservationId)||!validDay(result.accountDay))throw new ModelError('INVALID_MODEL_RESPONSE');
   return {status:'reserved',reservation:{accountId:result.accountId,reservationId:result.reservationId,accountDay:result.accountDay}};
  },
  async settle(input){
   const r=input.reservation,usage=input.usage;
   if(!r||!accounts.includes(r.accountId)||!uuid(r.reservationId)||!validDay(r.accountDay)||!['usage_reported','usage_unknown'].includes(input.outcome)||input.confirmedDepletion!==undefined||input.outcome==='usage_unknown'&&usage!==undefined||input.outcome==='usage_reported'&&(!usage||!integer(usage.inputTokens)||!integer(usage.outputTokens)||!integer(usage.inputTokens+usage.outputTokens)))throw new ModelError('INVALID_MODEL_RESPONSE');
   const result=await db.rpc('settle_ai_account_budget',{p_reservation_id:r.reservationId,p_account_id:r.accountId,p_account_day:r.accountDay,p_outcome:input.outcome,p_input_tokens:usage?.inputTokens??null,p_output_tokens:usage?.outputTokens??null});
   if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).length!==2||result.settled!==(input.outcome==='usage_reported')||result.pending!==(input.outcome==='usage_unknown'))throw new ModelError('INVALID_MODEL_RESPONSE');
  }
 };
}
