import type { ModelPort, ModelRequest, ModelResponse, ModelUsage } from "./model-port.ts";
import { ModelError, safeModelError } from "./provider-errors.ts";

/** 실제 API 어댑터는 계정별 규격 확인 후 주입한다. OpenAI 호환을 가정하지 않는다. */
/** 서버 구성에서만 전달한다. approved는 팀의 보관 기준 검토 완료이며 ZDR을 뜻하지 않는다. */
export type RetentionReview = { status: "pending" } | { status: "approved"; decisionId: string };
export interface ReviewedProvider { id: string; retentionReview: RetentionReview; model: ModelPort; }
export interface ModelBudgetPort {
  /**
   * 동시 호출까지 원자적으로 예약한다. 원문이나 사용자 입력을 저장하지 않는다.
   * inputBytes는 system과 JSON 입력의 UTF-8 바이트 수로, 바이트 단위 토큰화의 입력 토큰 상한 계산에 쓴다.
   */
  reserve(input: { providerId: string; task: ModelRequest["task"]; inputChars: number; inputBytes: number; maxOutputTokens: number; memberRequest?: ModelRequest["memberRequest"]; summaryRequest?: ModelRequest["summaryRequest"] }): Promise<string | null>;
  /** success는 공급사가 사용량을 보고한 경우다. 사용량을 모르는 실패·응답은 unknown이며 예약을 환불하지 않는다. */
  settle(input: { reservationId: string; outcome: "success" | "unknown"; usage?: ModelUsage }): Promise<void>;
}
const encoder = new TextEncoder();
function validUsage(usage: unknown): usage is ModelUsage {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  const value = usage as Record<string, unknown>;
  return Number.isSafeInteger(value.inputTokens) && (value.inputTokens as number) >= 0 &&
    Number.isSafeInteger(value.outputTokens) && (value.outputTokens as number) >= 0;
}
export function createModelRouter(config: { primary: ReviewedProvider; fallback?: ReviewedProvider; budget: ModelBudgetPort }): ModelPort {
  // HTTP handler는 점유에서 받은 같은 scope 객체를 모든 단계에 전달한다.
  // WeakSet은 요청 종료 뒤 회원/요청 식별자를 영구 보관하지 않는다.
  const retriedRequests = new WeakSet<NonNullable<ModelRequest["memberRequest"]>>();
  async function call(provider: ReviewedProvider, request: ModelRequest): Promise<ModelResponse> {
    const review = provider.retentionReview;
    if (review?.status !== "approved" || typeof review.decisionId !== "string" || !review.decisionId.trim()) {
      throw new ModelError("RETENTION_REVIEW_PENDING");
    }
    if (request.signal?.aborted) throw new ModelError("CANCELLED");
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) throw new ModelError("NOT_CONFIGURED");
    let inputChars: number, inputBytes: number;
    try {
      const serialized = JSON.stringify(request.input);
      if (typeof serialized !== "string" || typeof request.system !== "string") throw new Error();
      inputChars = request.system.length + serialized.length;
      inputBytes = encoder.encode(request.system).length + encoder.encode(serialized).length;
    } catch { throw new ModelError("INVALID_MODEL_RESPONSE"); }
    let reservationId: string | null;
    try { reservationId = await config.budget.reserve({ providerId: provider.id, task: request.task, inputChars, inputBytes, maxOutputTokens: request.maxOutputTokens, ...(request.memberRequest ? { memberRequest: request.memberRequest } : {}), ...(request.summaryRequest ? { summaryRequest: request.summaryRequest } : {}) }); }
    catch (error) { throw error instanceof ModelError ? safeModelError(error) : new ModelError("MODEL_UNAVAILABLE"); }
    if (!reservationId) throw new ModelError("BUDGET_EXHAUSTED");
    let result: ModelResponse;
    try {
      if (request.signal?.aborted) throw new ModelError("CANCELLED");
      result = await provider.model.generate(request);
    } catch (error) {
      try { await config.budget.settle({ reservationId, outcome: "unknown" }); }
      catch { throw new ModelError("MODEL_UNAVAILABLE"); }
      if (request.signal?.aborted) throw new ModelError("CANCELLED");
      throw safeModelError(error);
    }
    const usage = result && validUsage(result.usage) ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : null;
    // 보고된 사용량은 응답 형식이 틀려도 실제 소비로 정산한다. 보고가 없거나 형식이 틀리면 예약 전체를 유지한다.
    try { await config.budget.settle(usage ? { reservationId, outcome: "success", usage } : { reservationId, outcome: "unknown" }); }
    catch { throw new ModelError("MODEL_UNAVAILABLE"); }
    if (!result || typeof result.modelVersion !== "string" || !result.modelVersion.trim() ||
        (result.usage !== null && !usage) || (usage && usage.outputTokens > request.maxOutputTokens)) throw new ModelError("INVALID_MODEL_RESPONSE");
    if (request.signal?.aborted) throw new ModelError("CANCELLED");
    return { value: result.value, modelVersion: result.modelVersion, usage,
      ...(typeof result.reportedModel === "string" && result.reportedModel.trim() ? { reportedModel: result.reportedModel } : {}) };
  }
  return { async generate(request) {
    try {
      try { return await call(config.primary, request); }
      catch (error) {
        if (request.memberRequest && !retriedRequests.has(request.memberRequest) && error instanceof ModelError && ["TIMEOUT", "RATE_LIMITED", "MODEL_UNAVAILABLE"].includes(error.code) && !request.signal?.aborted) {
          retriedRequests.add(request.memberRequest);
          return await call(config.primary, request);
        }
        throw error;
      }
    }
    catch (error) {
      if (error instanceof ModelError && error.code === "DAILY_QUOTA_EXHAUSTED" && config.fallback) return call(config.fallback, request);
      throw safeModelError(error);
    }
  } };
}
