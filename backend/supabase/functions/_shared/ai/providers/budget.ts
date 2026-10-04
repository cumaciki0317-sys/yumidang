/**
 * ModelBudgetPort의 DB 원자 예약 어댑터. generic 및 회원·요약 처리 시작 예약 RPC와 settle_ai_budget를 내부(service) 클라이언트로 호출한다.
 * 단위는 "토큰 상한 단위": 입력은 UTF-8 바이트 수(바이트 단위 토큰화에서 토큰 수 이하), 출력은 요청한 최대 출력 토큰.
 * 원문은 전달하지 않는다. 회원·요약 예약에는 현재 자격 검증에 필요한 서버 범위 식별자만 전달한다. 사용량 불명은 예약 단위 전체를 소비로 유지한다.
 */
import type { JsonValue } from "../../contracts/common.ts";
import type { RpcClient } from "../../db/transport.ts";
import { ModelError } from "./provider-errors.ts";
import { isSourceRevision, isSummaryVersion } from "../../db/repositories/review-summaries.ts";
import type { ModelBudgetPort } from "./provider-adapter.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BUDGET_RPCS = ["reserve_ai_budget", "reserve_ai_chat_model", "reserve_review_summary_model", "settle_ai_budget"] as const;

export function createRpcModelBudget(db: RpcClient, options: { ledgerId: string; promptOverheadBytes: number }): ModelBudgetPort {
  if (!db || typeof db.rpc !== "function" || typeof options?.ledgerId !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(options.ledgerId) ||
      !Number.isSafeInteger(options.promptOverheadBytes) || options.promptOverheadBytes < 0) throw new Error("INVALID_BUDGET_CONFIG");
  const { ledgerId, promptOverheadBytes } = options;
  return {
    async reserve(input) {
      const units = input.inputBytes + promptOverheadBytes + input.maxOutputTokens;
      if (![input.inputBytes, input.maxOutputTokens, units].every((n) => Number.isSafeInteger(n) && n >= 0) || units < 1 ||
          !/^[a-z0-9_.-]{1,32}$/.test(input.providerId)) throw new Error("INVALID_BUDGET_INPUT");
      const scope = input.memberRequest;
      const summary = input.summaryRequest;
      const summaryTask = input.task === "review_chunk" || input.task === "review_merge";
      // 요약은 generic 예산 RPC로 우회할 수 없다. 범위가 없는 호출도 안전 중단한다.
      if (scope && summary || summaryTask !== Boolean(summary) || scope && summaryTask) throw new Error("INVALID_BUDGET_INPUT");
      if (summary && (![summary.jobId, summary.leaseToken, summary.targetUserId, summary.workerRunToken].every(value => typeof value === "string" && uuid.test(value)) ||
          !isSourceRevision(summary.sourceRevision) || !isSummaryVersion(summary.modelVersion) || !isSummaryVersion(summary.promptVersion) ||
          !Array.isArray(summary.sourceReviewIds) || summary.sourceReviewIds.length < 3 || new Set(summary.sourceReviewIds).size !== summary.sourceReviewIds.length ||
          !summary.sourceReviewIds.every(value => typeof value === "string" && uuid.test(value)))) throw new Error("INVALID_BUDGET_INPUT");
      if (scope && ![scope.userId, scope.requestId, scope.leaseToken].every(value => uuid.test(value))) throw new Error("INVALID_BUDGET_INPUT");
      const result: JsonValue = await db.rpc(scope ? "reserve_ai_chat_model" : summary ? "reserve_review_summary_model" : "reserve_ai_budget", {
        p_ledger_id: ledgerId, p_provider_id: input.providerId, p_task: input.task, p_units: units,
        ...(summary ? { p_job_id: summary.jobId, p_lease_token: summary.leaseToken, p_target_user_id: summary.targetUserId,
          p_source_revision: summary.sourceRevision, p_worker_run_token: summary.workerRunToken, p_model_version: summary.modelVersion,
          p_prompt_version: summary.promptVersion, p_source_review_ids: summary.sourceReviewIds, p_contract_version: "2026-10-05" } : {}),
        ...(scope ? { p_user_id: scope.userId, p_request_id: scope.requestId, p_lease_token: scope.leaseToken, p_contract_version: "2026-10-05" } : {}),
      });
      if ((scope || summary) && result && typeof result === "object" && !Array.isArray(result) && Object.keys(result).length === 1) {
        if (summary && ["stale_revision", "insufficient_reviews", "invalid_evidence"].includes(String(result.status))) throw new ModelError("SUMMARY_SOURCE_CHANGED");
        if (result.status === "daily_limit") throw new ModelError("MEMBER_DAILY_LIMIT");
        if (result.status === "consent_revoked") throw new ModelError("AI_CONSENT_REVOKED");
        if (result.status === "lease_lost") throw new ModelError("REQUEST_LEASE_LOST");
      }
      if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 1 ||
          !Object.hasOwn(result, "reservationId")) throw new Error("INVALID_BUDGET_RESPONSE");
      const id = result.reservationId;
      if (id === null) return null;
      if (typeof id !== "string" || !uuid.test(id)) throw new Error("INVALID_BUDGET_RESPONSE");
      return id.toLowerCase();
    },
    async settle(input) {
      if (typeof input.reservationId !== "string" || !uuid.test(input.reservationId)) throw new Error("INVALID_BUDGET_INPUT");
      const reported = input.outcome === "success" && input.usage !== undefined;
      if (input.outcome !== "unknown" && !reported) throw new Error("INVALID_BUDGET_INPUT");
      const result = await db.rpc("settle_ai_budget", {
        p_reservation_id: input.reservationId,
        p_outcome: reported ? "usage_reported" : "usage_unknown",
        p_input_tokens: reported ? input.usage!.inputTokens : null,
        p_output_tokens: reported ? input.usage!.outputTokens : null,
      });
      if (!result || typeof result !== "object" || Array.isArray(result) || result.settled !== true) throw new Error("INVALID_BUDGET_RESPONSE");
    },
  };
}
