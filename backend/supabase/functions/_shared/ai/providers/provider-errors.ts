import type { ModelUsage } from "./model-port.ts";
/** 제공사 원문 오류·요청 본문을 서비스 오류로 복사하지 않는다. */
const codes = new Set(["NOT_CONFIGURED", "RETENTION_REVIEW_PENDING", "DAILY_QUOTA_EXHAUSTED", "BUDGET_EXHAUSTED", "CANCELLED",
  "MEMBER_DAILY_LIMIT", "AI_CONSENT_REVOKED", "REQUEST_LEASE_LOST", "SUMMARY_SOURCE_CHANGED", "INVALID_MODEL_RESPONSE", "MODEL_UNAVAILABLE", "PROVIDER_REJECTED", "RATE_LIMITED", "TIMEOUT"]);
/** RATE_LIMITED는 단순 429다. 공급사 일일 한도 소진의 기계 판독 근거가 없으면 DAILY_QUOTA_EXHAUSTED로 추정하지 않는다. */
export type ModelErrorCode = "NOT_CONFIGURED" | "RETENTION_REVIEW_PENDING" | "DAILY_QUOTA_EXHAUSTED" | "BUDGET_EXHAUSTED" | "CANCELLED" |
  "MEMBER_DAILY_LIMIT" | "AI_CONSENT_REVOKED" | "REQUEST_LEASE_LOST" | "SUMMARY_SOURCE_CHANGED" | "INVALID_MODEL_RESPONSE" | "MODEL_UNAVAILABLE" | "PROVIDER_REJECTED" | "RATE_LIMITED" | "TIMEOUT";
export type ModelDispatchState = "not_sent" | "sent" | "unknown";
/** 서버 내부 증거만 허용한다. 원문·HTTP body·키를 담지 않는다. */
export interface ModelFailureEvidence { dispatchState?: ModelDispatchState; usage?: ModelUsage | null }
export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly dispatchState!: ModelDispatchState;
  readonly usage!: Readonly<ModelUsage> | null;
  constructor(code: ModelErrorCode, evidence: ModelFailureEvidence = {}) {
    const safe = codes.has(code) ? code : "MODEL_UNAVAILABLE";
    super(safe); this.name = "ModelError"; this.code = safe;
    const dispatchState = ["not_sent", "sent"].includes(evidence.dispatchState ?? "") ? evidence.dispatchState! : "unknown";
    const raw = evidence.usage;
    const usage = dispatchState === "sent" && raw && Number.isSafeInteger(raw.inputTokens) && raw.inputTokens >= 0 &&
      Number.isSafeInteger(raw.outputTokens) && raw.outputTokens >= 0 && Number.isSafeInteger(raw.inputTokens + raw.outputTokens)
      ? Object.freeze({ inputTokens: raw.inputTokens, outputTokens: raw.outputTokens }) : null;
    Object.defineProperties(this, { dispatchState: { value: dispatchState, enumerable: false, writable: false, configurable: false }, usage: { value: usage, enumerable: false, writable: false, configurable: false } });
  }
}
export function safeModelError(error: unknown): ModelError {
  return error instanceof ModelError && codes.has(error.code)
    ? new ModelError(error.code, { dispatchState: error.dispatchState, usage: error.usage })
    : new ModelError("MODEL_UNAVAILABLE");
}

/** 회원 요청 전체에서 한 번만, 미전송이 확인된 일시 실패를 같은 예약 안에서 다시 준비한다. */
export async function generateWithPreDispatchRetry<T>(attempt: () => Promise<T>, options: {
  memberScope?: object; retriedRequests: WeakSet<object>; signal?: AbortSignal;
}): Promise<T> {
  try { return await attempt(); }
  catch (error) {
    const safe = safeModelError(error);
    if (!options.memberScope || options.retriedRequests.has(options.memberScope) || options.signal?.aborted ||
        safe.dispatchState !== "not_sent" || !["MODEL_UNAVAILABLE", "TIMEOUT"].includes(safe.code)) throw safe;
    options.retriedRequests.add(options.memberScope);
    return await attempt();
  }
}
