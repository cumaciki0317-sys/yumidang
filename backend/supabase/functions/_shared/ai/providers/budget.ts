/**
 * ModelBudgetPort의 DB 원자 예약 어댑터. 제안 RPC reserve_ai_budget/settle_ai_budget를 내부(service) 클라이언트로 호출한다.
 * 단위는 "토큰 상한 단위": 입력은 UTF-8 바이트 수(바이트 단위 토큰화에서 토큰 수 이하), 출력은 요청한 최대 출력 토큰.
 * 원문·사용자 ID를 전달하지 않는다. 사용량 불명은 예약 단위 전체를 소비로 유지한다.
 */
import type { JsonValue } from "../../contracts/common.ts";
import type { RpcClient } from "../../db/transport.ts";
import type { ModelBudgetPort } from "./provider-adapter.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BUDGET_RPCS = ["reserve_ai_budget", "settle_ai_budget"] as const;

export function createRpcModelBudget(db: RpcClient, options: { ledgerId: string; promptOverheadBytes: number }): ModelBudgetPort {
  if (!db || typeof db.rpc !== "function" || typeof options?.ledgerId !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(options.ledgerId) ||
      !Number.isSafeInteger(options.promptOverheadBytes) || options.promptOverheadBytes < 0) throw new Error("INVALID_BUDGET_CONFIG");
  const { ledgerId, promptOverheadBytes } = options;
  return {
    async reserve(input) {
      const units = input.inputBytes + promptOverheadBytes + input.maxOutputTokens;
      if (![input.inputBytes, input.maxOutputTokens, units].every((n) => Number.isSafeInteger(n) && n >= 0) || units < 1 ||
          !/^[a-z0-9_.-]{1,32}$/.test(input.providerId)) throw new Error("INVALID_BUDGET_INPUT");
      const result: JsonValue = await db.rpc("reserve_ai_budget", {
        p_ledger_id: ledgerId, p_provider_id: input.providerId, p_task: input.task, p_units: units,
      });
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
