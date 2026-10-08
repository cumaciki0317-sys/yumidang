/** 민규: AI 결과 증거와 신고자료 준비 상태. 원문·공급사 호출을 받지 않는다. */
import type { RpcClient } from './transport.ts';
import { HttpError } from '../http/errors.ts';
import type { ReportEvidenceHandlingPort } from '../ai/Agents/chatbot/feedback.ts';
import type { MemberModelRequest } from '../ai/providers/model-port.ts';
export function createAiReportEvidenceHandling(db: RpcClient): ReportEvidenceHandlingPort {
  return { async isReady() {
    const value = await db.rpc('get_ai_feedback_readiness', {});
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
      value.contractVersion !== '2026-10-05' || value.helpfulReady !== true || typeof value.reportReady !== 'boolean') {
      throw new HttpError('EXTERNAL_UNAVAILABLE');
    }
    return value.reportReady;
  } };
}
export async function recordAiResultAvailable(db: RpcClient, scope: MemberModelRequest): Promise<void> {
  const value = await db.rpc('record_ai_chat_result_available', {
    p_user_id: scope.userId, p_request_id: scope.requestId, p_lease_token: scope.leaseToken,
  });
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
    value.requestId !== scope.requestId || typeof value.availableAt !== 'string' || !Number.isFinite(Date.parse(value.availableAt))) {
    throw new HttpError('EXTERNAL_UNAVAILABLE');
  }
}
