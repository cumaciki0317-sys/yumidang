/** 회원 AI 요청의 DB 점유 포트. 대화 원문은 전달하지 않으며 DB 서버 시각·한국시간 날짜를 사용한다. */
import type { RpcClient } from "../../db/transport.ts";
import type { MemberModelRequest } from "./model-port.ts";
export const AI_CHAT_REQUEST_RPCS = ["acquire_ai_chat_request", "finish_ai_chat_request", "reserve_ai_chat_model"] as const;
export type RequestDenial = "concurrent" | "daily_limit" | "consent_revoked" | "retry_exhausted";
export type RequestOutcome = "finished" | "output_privacy";
export interface AiChatRequestGate {
  acquire(input: { userId: string; requestId: string; clientRequestId: string; outputRetryOf?: string }): Promise<
    { status: "acquired"; scope: MemberModelRequest; expiresAt: string } | { status: RequestDenial }>;
  finish(scope: MemberModelRequest, outcome: RequestOutcome): Promise<void>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const states = new Set(["concurrent", "daily_limit", "consent_revoked", "retry_exhausted"]);
export function createRpcAiChatRequestGate(db: RpcClient): AiChatRequestGate {
  return {
    async acquire(input) {
      if (!uuid.test(input.userId) || !uuid.test(input.requestId) || !input.clientRequestId || input.clientRequestId.length > 128 ||
          (input.outputRetryOf !== undefined && !uuid.test(input.outputRetryOf))) throw new Error("INVALID_AI_REQUEST_SCOPE");
      const result = await db.rpc("acquire_ai_chat_request", { p_user_id: input.userId, p_request_id: input.requestId,
        p_client_request_id: input.clientRequestId, p_output_retry_of: input.outputRetryOf ?? null,
        p_contract_version: "2026-10-05" });
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("INVALID_AI_REQUEST_RESPONSE");
      if (typeof result.status === "string" && states.has(result.status) && Object.keys(result).length === 1) {
        return { status: result.status as RequestDenial };
      }
      if (result.status !== "acquired" || Object.keys(result).length !== 3 || typeof result.leaseToken !== "string" ||
          !uuid.test(result.leaseToken) || typeof result.expiresAt !== "string" || !Number.isFinite(Date.parse(result.expiresAt))) {
        throw new Error("INVALID_AI_REQUEST_RESPONSE");
      }
      return { status: "acquired", scope: { userId: input.userId, requestId: input.requestId, leaseToken: result.leaseToken }, expiresAt: result.expiresAt };
    },
    async finish(scope, outcome) {
      if (![scope.userId, scope.requestId, scope.leaseToken].every(value => uuid.test(value))) throw new Error("INVALID_AI_REQUEST_SCOPE");
      const result = await db.rpc("finish_ai_chat_request", { p_user_id: scope.userId, p_request_id: scope.requestId,
        p_lease_token: scope.leaseToken, p_outcome: outcome });
      if (!result || typeof result !== "object" || Array.isArray(result) || result.finished !== true || Object.keys(result).length !== 1) {
        throw new Error("INVALID_AI_REQUEST_RESPONSE");
      }
    },
  };
}
