/** Pure account pipeline. Runtime remains disabled until M supplies atomic ports and existing approvals.
 * Keys, account limits, order and dates never come from requests or defaults here.
 * reserve must atomically apply account/global budgets and the existing member/summary scope.
 * Date reset must preserve pending reservations; settlement always uses their original identity.
 */
import type { ModelPort, ModelRequest, ModelResponse, ModelUsage } from './model-port.ts';
import { ModelError, safeModelError } from './provider-errors.ts';

export interface AccountReservation {
  readonly accountId: string;
  readonly reservationId: string;
  /** DB budget date, not a host-clock date. */
  readonly accountDay: string;
}
export type AccountReserveResult =
  | { status: 'reserved'; reservation: AccountReservation }
  | { status: 'account_budget_denied' }
  | { status: 'global_budget_denied' };
export interface AccountReservationPort {
  reserve(input: {
    accountId: string; task: ModelRequest['task']; inputBytes: number; maxOutputTokens: number;
    memberRequest?: ModelRequest['memberRequest']; summaryRequest?: ModelRequest['summaryRequest'];
  }): Promise<AccountReserveResult>;
  /** unknown retains the whole reservation, even after cancellation or a date reset. */
  settle(input: {
    reservation: AccountReservation; outcome: 'usage_reported' | 'usage_unknown'; usage?: ModelUsage;
    confirmedDepletion?: { decisionId: string; code: string };
  }): Promise<void>;
}
export interface ConfirmedDepletionCheck {
  decisionId: string;
  /** Only approved machine-readable evidence. HTTP status/body keywords alone are insufficient. */
  classify(error: unknown): string | null;
}
const id = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/;
const usageValid = (value: unknown): value is ModelUsage => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Number.isSafeInteger(v.inputTokens) && (v.inputTokens as number) >= 0 &&
    Number.isSafeInteger(v.outputTokens) && (v.outputTokens as number) >= 0;
};

export function createAccountPoolModel(options: {
  orderedAccountIds: readonly string[];
  reservations: AccountReservationPort;
  /** Server-only factory of already approved provider ports. Never returns credentials. */
  modelForAccount(accountId: string): ModelPort;
  confirmedDepletion?: ConfirmedDepletionCheck;
}): ModelPort {
  if (!options || !Array.isArray(options.orderedAccountIds) || !options.orderedAccountIds.length ||
      options.orderedAccountIds.some(v => typeof v !== 'string' || !id.test(v)) ||
      new Set(options.orderedAccountIds).size !== options.orderedAccountIds.length ||
      typeof options.reservations?.reserve !== 'function' || typeof options.reservations?.settle !== 'function' ||
      typeof options.modelForAccount !== 'function' ||
      options.confirmedDepletion && (!id.test(options.confirmedDepletion.decisionId) || typeof options.confirmedDepletion.classify !== 'function')) {
    throw new ModelError('NOT_CONFIGURED');
  }
  const accounts = [...options.orderedAccountIds];
  const reserve = options.reservations.reserve.bind(options.reservations);
  const settle = options.reservations.settle.bind(options.reservations);
  const factory = options.modelForAccount;
  const depletion = options.confirmedDepletion ? { ...options.confirmedDepletion } : undefined;
  return { async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted) throw new ModelError('CANCELLED');
    let inputBytes: number;
    try {
      if (typeof request.system !== 'string' || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 ||
          !['intent','preference_match','explanation','review_chunk','review_merge'].includes(request.task) ||
          request.memberRequest && request.summaryRequest ||
          ['review_chunk','review_merge'].includes(request.task) !== Boolean(request.summaryRequest)) throw new Error();
      const member = request.memberRequest, summary = request.summaryRequest;
      const nonempty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
      if (!summary && !member || member && ![member.userId, member.requestId, member.leaseToken].every(nonempty) ||
          summary && (![summary.jobId, summary.leaseToken, summary.targetUserId, summary.sourceRevision,
            summary.workerRunToken, summary.modelVersion, summary.promptVersion].every(nonempty) ||
            !Array.isArray(summary.sourceReviewIds) || !summary.sourceReviewIds.length || !summary.sourceReviewIds.every(nonempty))) throw new Error();
      const memberSnapshot = member ? Object.freeze({ userId: member.userId, requestId: member.requestId, leaseToken: member.leaseToken }) : undefined;
      const sourceReviewIds = summary ? [...summary.sourceReviewIds] : undefined;
      if (sourceReviewIds) Object.freeze(sourceReviewIds);
      const summarySnapshot = summary ? Object.freeze({ jobId: summary.jobId, leaseToken: summary.leaseToken,
        targetUserId: summary.targetUserId, sourceRevision: summary.sourceRevision, workerRunToken: summary.workerRunToken,
        modelVersion: summary.modelVersion, promptVersion: summary.promptVersion, sourceReviewIds: sourceReviewIds! }) : undefined;
      // Scope is a server capability, not request content; ports share this frozen copy.
      request = Object.freeze({ ...request,
        ...(memberSnapshot ? { memberRequest: memberSnapshot } : {}),
        ...(summarySnapshot ? { summaryRequest: summarySnapshot } : {}) });
      const serialized = JSON.stringify(request.input);
      if (typeof serialized !== 'string') throw new Error();
      inputBytes = new TextEncoder().encode(request.system).length + new TextEncoder().encode(serialized).length;
    } catch { throw new ModelError('INVALID_MODEL_RESPONSE'); }
    for (const accountId of accounts) {
      if (request.signal?.aborted) throw new ModelError('CANCELLED');
      let result: AccountReserveResult;
      try { result = await reserve({ accountId, task: request.task, inputBytes, maxOutputTokens: request.maxOutputTokens,
        ...(request.memberRequest ? { memberRequest: request.memberRequest } : {}),
        ...(request.summaryRequest ? { summaryRequest: request.summaryRequest } : {}) }); }
      catch (error) { throw safeModelError(error); }
      if (result?.status === 'account_budget_denied' && Object.keys(result).length === 1) continue;
      if (result?.status === 'global_budget_denied' && Object.keys(result).length === 1) throw new ModelError('BUDGET_EXHAUSTED');
      const identity = result?.status === 'reserved' ? result.reservation : undefined;
      if (!identity || Object.keys(result).length !== 2 || Object.keys(identity).length !== 3 || identity.accountId !== accountId ||
          typeof identity.reservationId !== 'string' || !id.test(identity.reservationId) ||
          typeof identity.accountDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(identity.accountDay)) throw new ModelError('MODEL_UNAVAILABLE');
      const reservation = Object.freeze({ accountId, reservationId: identity.reservationId, accountDay: identity.accountDay });
      let response: ModelResponse;
      try {
        if (request.signal?.aborted) throw new ModelError('CANCELLED');
        const model = factory(accountId);
        if (!model || typeof model.generate !== 'function') throw new ModelError('NOT_CONFIGURED');
        response = await model.generate(request);
      } catch (error) {
        let confirmedDepletion: { decisionId: string; code: string } | undefined;
        if (depletion) {
          try { const code = depletion.classify(error); if (typeof code === 'string' && id.test(code)) confirmedDepletion = { decisionId: depletion.decisionId, code }; }
          catch { /* Classification uncertainty never triggers account switching. */ }
        }
        try { await settle({ reservation, outcome: 'usage_unknown', ...(confirmedDepletion ? { confirmedDepletion } : {}) }); }
        catch { throw new ModelError('MODEL_UNAVAILABLE'); }
        if (request.signal?.aborted) throw new ModelError('CANCELLED');
        throw safeModelError(error); // No post-dispatch retry or account rotation.
      }
      const usage = usageValid(response?.usage) ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : null;
      try { await settle(usage ? { reservation, outcome: 'usage_reported', usage } : { reservation, outcome: 'usage_unknown' }); }
      catch { throw new ModelError('MODEL_UNAVAILABLE'); }
      if (request.signal?.aborted) throw new ModelError('CANCELLED');
      if (!response || typeof response.modelVersion !== 'string' || !response.modelVersion.trim() ||
          response.usage !== null && !usage || usage && usage.outputTokens > request.maxOutputTokens) throw new ModelError('INVALID_MODEL_RESPONSE');
      return { value: response.value, modelVersion: response.modelVersion, usage,
        ...(typeof response.reportedModel === 'string' && response.reportedModel.trim() ? { reportedModel: response.reportedModel } : {}) };
    }
    throw new ModelError('BUDGET_EXHAUSTED');
  } };
}
