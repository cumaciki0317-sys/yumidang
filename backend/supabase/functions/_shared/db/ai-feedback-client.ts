/** 민규: AI 결과 증거와 신고자료 준비 상태. 원문·공급사 호출을 받지 않는다. */
import type { RpcClient } from './transport.ts';
import { HttpError } from '../http/errors.ts';
import type { ReportEvidenceHandlingPort } from '../ai/Agents/chatbot/feedback.ts';
import type { MemberModelRequest } from '../ai/providers/model-port.ts';
import { readAiResultState, type AiResultState } from '../contracts/ai.ts';

/** 인증 문맥의 회원과 원 requestId만 받는다. 점유/기록/finish/평가 쓰기를 수행하지 않는다. */
export function createRpcAiResultStateReader(db: RpcClient): { get(userId: string, requestId: string, signal?: AbortSignal): Promise<AiResultState> } {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return { async get(userId, requestId, signal) {
    if (typeof userId !== 'string' || !uuid.test(userId)) throw new HttpError('AUTH_REQUIRED');
    if (typeof requestId !== 'string' || !uuid.test(requestId)) throw new HttpError('INVALID_REQUEST');
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new HttpError('INVALID_REQUEST');
    const expected = requestId.toLowerCase();
    const read = () => db.rpc('get_ai_result_state', { p_user_id: userId.toLowerCase(), p_request_id: expected });
    const value = signal ? await new Promise<import('../contracts/common.ts').JsonValue>((resolve, reject) => {
      let settled = false;
      const remove = () => signal.removeEventListener('abort', stop);
      const stop = () => { if (!settled) { settled = true; remove(); reject(new HttpError('EXTERNAL_UNAVAILABLE')); } };
      if (signal.aborted) { stop(); return; }
      signal.addEventListener('abort', stop, { once: true });
      Promise.resolve().then(() => { if (signal.aborted) throw new HttpError('EXTERNAL_UNAVAILABLE'); return read(); }).then(result => {
        if (settled) return;
        if (signal.aborted) { stop(); return; }
        settled = true; remove(); resolve(result);
      }, error => { if (!settled) { if (signal.aborted) stop(); else { settled = true; remove(); reject(error); } } });
    }) : await read();
    try { return readAiResultState(value, expected); }
    catch { throw new HttpError('EXTERNAL_UNAVAILABLE'); }
  } };
}
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
