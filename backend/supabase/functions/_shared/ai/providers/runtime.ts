/**
 * 서버 설정으로 제품 모델 포트를 조립한다. 보관 검토 결정·추가 지출 0원 근거·예산 원장 중 하나라도 없으면
 * 모델을 만들지 않고 disabled를 반환한다. 합성 평가 경로는 이 함수를 쓰지 않는다(요청자가 '가상'이라 표시해도 우회 불가).
 */
import type { EnvReader } from "../../config/env.ts";
import { loadPotensLlmConfig } from "../../config/providers.ts";
import type { RpcClient } from "../../db/transport.ts";
import { optionalToken, requiredToken, SettingError } from "../../jobs/settings.ts";
import { createRpcModelBudget } from "./budget.ts";
import type { ModelPort } from "./model-port.ts";
import { createPotensModel, POTENS_PROMPT_OVERHEAD_BYTES, type FetchLike } from "./potens-adapter.ts";
import { createModelRouter } from "./provider-adapter.ts";

export type ModelRuntimeDisabledCode = "RETENTION_REVIEW_PENDING" | "COST_EVIDENCE_MISSING" | "NOT_CONFIGURED";
export type ModelRuntime =
  | { status: "ready"; model: ModelPort; modelVersion: string }
  | { status: "disabled"; code: ModelRuntimeDisabledCode };

/** 설정 변수 이름. 값은 서버 환경에서만 주입하며 저장소·로그에 기록하지 않는다. */
export const AI_RUNTIME_ENV = {
  retentionDecisionId: "AI_RETENTION_DECISION_ID",
  costEvidenceId: "AI_COST_EVIDENCE_ID",
  budgetLedgerId: "AI_BUDGET_LEDGER_ID",
  usageInputField: "POTENS_USAGE_INPUT_FIELD",
  usageOutputField: "POTENS_USAGE_OUTPUT_FIELD",
} as const;

export function createConfiguredModel(read: EnvReader, deps: { budgetDb: RpcClient; fetch?: FetchLike }): ModelRuntime {
  try {
    const decisionId = optionalToken(read, AI_RUNTIME_ENV.retentionDecisionId);
    if (!decisionId) return { status: "disabled", code: "RETENTION_REVIEW_PENDING" };
    if (!optionalToken(read, AI_RUNTIME_ENV.costEvidenceId)) return { status: "disabled", code: "COST_EVIDENCE_MISSING" };
    const ledgerId = requiredToken(read, AI_RUNTIME_ENV.budgetLedgerId);
    const fieldPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
    const input = optionalToken(read, AI_RUNTIME_ENV.usageInputField, fieldPattern);
    const output = optionalToken(read, AI_RUNTIME_ENV.usageOutputField, fieldPattern);
    if ((input === undefined) !== (output === undefined)) return { status: "disabled", code: "NOT_CONFIGURED" };
    const potens = loadPotensLlmConfig(read);
    const model = createPotensModel({
      apiKey: potens.apiKey, baseUrl: potens.baseUrl, model: potens.model, timeoutMs: potens.upstreamTimeoutMs,
      ...(input && output ? { usageFields: { input, output } } : {}),
      fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    });
    const router = createModelRouter({
      primary: { id: "potens", retentionReview: { status: "approved", decisionId }, model },
      budget: createRpcModelBudget(deps.budgetDb, { ledgerId, promptOverheadBytes: POTENS_PROMPT_OVERHEAD_BYTES }),
    });
    return { status: "ready", model: router, modelVersion: "potens." + potens.model };
  } catch (error) {
    if (error instanceof SettingError) return { status: "disabled", code: "NOT_CONFIGURED" };
    return { status: "disabled", code: "NOT_CONFIGURED" };
  }
}
