/** 제공사 원문 오류·요청 본문을 서비스 오류로 복사하지 않는다. */
const codes = new Set(["NOT_CONFIGURED", "RETENTION_REVIEW_PENDING", "DAILY_QUOTA_EXHAUSTED", "BUDGET_EXHAUSTED", "CANCELLED", "INVALID_MODEL_RESPONSE", "MODEL_UNAVAILABLE"]);
export type ModelErrorCode = "NOT_CONFIGURED" | "RETENTION_REVIEW_PENDING" | "DAILY_QUOTA_EXHAUSTED" | "BUDGET_EXHAUSTED" | "CANCELLED" | "INVALID_MODEL_RESPONSE" | "MODEL_UNAVAILABLE";
export class ModelError extends Error {
  readonly code: ModelErrorCode;
  constructor(code: ModelErrorCode) {
    const safe = codes.has(code) ? code : "MODEL_UNAVAILABLE";
    super(safe); this.name = "ModelError"; this.code = safe;
  }
}
export function safeModelError(error: unknown): ModelError {
  return new ModelError(error instanceof ModelError && codes.has(error.code) ? error.code : "MODEL_UNAVAILABLE");
}
