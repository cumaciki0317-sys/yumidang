import type { ModelPort, ModelRequest, ModelResponse } from "./model-port.ts";
import { ModelError, safeModelError } from "./provider-errors.ts";

/** 실제 API 어댑터는 계정별 규격 확인 후 주입한다. OpenAI 호환을 가정하지 않는다. */
/** 서버 구성에서만 전달한다. approved는 팀의 보관 기준 검토 완료이며 ZDR을 뜻하지 않는다. */
export type RetentionReview = { status: "pending" } | { status: "approved"; decisionId: string };
export interface ReviewedProvider { id: string; retentionReview: RetentionReview; model: ModelPort; }
export interface ModelBudgetPort {
  /** 동시 호출까지 원자적으로 예약한다. 원문이나 사용자 입력을 저장하지 않는다. */
  reserve(input: { providerId: string; task: ModelRequest["task"]; inputChars: number; maxOutputTokens: number }): Promise<string | null>;
  /** 사용량을 모르는 실패에서는 예약을 무조건 환불하지 않는다. */
  settle(input: { reservationId: string; outcome: "success" | "unknown"; usage?: ModelResponse["usage"] }): Promise<void>;
}
export function createModelRouter(config: { primary: ReviewedProvider; fallback?: ReviewedProvider; budget: ModelBudgetPort }): ModelPort {
  async function call(provider: ReviewedProvider, request: ModelRequest): Promise<ModelResponse> {
    const review = provider.retentionReview;
    if (review?.status !== "approved" || typeof review.decisionId !== "string" || !review.decisionId.trim()) {
      throw new ModelError("RETENTION_REVIEW_PENDING");
    }
    if (request.signal?.aborted) throw new ModelError("CANCELLED");
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) throw new ModelError("NOT_CONFIGURED");
    let inputChars: number;
    try { inputChars = request.system.length + JSON.stringify(request.input).length; }
    catch { throw new ModelError("INVALID_MODEL_RESPONSE"); }
    let reservationId: string | null;
    try { reservationId = await config.budget.reserve({ providerId: provider.id, task: request.task, inputChars, maxOutputTokens: request.maxOutputTokens }); }
    catch { throw new ModelError("MODEL_UNAVAILABLE"); }
    if (!reservationId) throw new ModelError("BUDGET_EXHAUSTED");
    let result: ModelResponse;
    try {
      if (request.signal?.aborted) throw new ModelError("CANCELLED");
      result = await provider.model.generate(request);
      if (!result || typeof result.modelVersion !== "string" || !result.modelVersion.trim() ||
          !Number.isSafeInteger(result.usage?.inputTokens) || result.usage.inputTokens < 0 ||
          !Number.isSafeInteger(result.usage?.outputTokens) || result.usage.outputTokens < 0 ||
          result.usage.outputTokens > request.maxOutputTokens) throw new ModelError("INVALID_MODEL_RESPONSE");
    } catch (error) {
      try { await config.budget.settle({ reservationId, outcome: "unknown" }); }
      catch { throw new ModelError("MODEL_UNAVAILABLE"); }
      if (request.signal?.aborted) throw new ModelError("CANCELLED");
      throw safeModelError(error);
    }
    try { await config.budget.settle({ reservationId, outcome: "success", usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } }); }
    catch { throw new ModelError("MODEL_UNAVAILABLE"); }
    if (request.signal?.aborted) throw new ModelError("CANCELLED");
    return { value: result.value, modelVersion: result.modelVersion, usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } };
  }
  return { async generate(request) {
    try { return await call(config.primary, request); }
    catch (error) {
      if (error instanceof ModelError && error.code === "DAILY_QUOTA_EXHAUSTED" && config.fallback) return call(config.fallback, request);
      throw safeModelError(error);
    }
  } };
}
