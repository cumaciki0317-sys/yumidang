/** 회원 전용 AI 평가/최소 첨부 신고. 공급사·모델·전체 대화 저장 포트를 호출하지 않는다. */
import type { AiFeedbackAttachment, AiFeedbackInput, AiFeedbackResult } from "../../../contracts/ai.ts";
import type { JsonValue } from "../../../contracts/common.ts";
import type { RpcClient } from "../../../db/transport.ts";
import { HttpError, toPublicError } from "../../../http/errors.ts";

export interface ReportEvidenceHandlingPort {
  /** 정책13의 소유권·ACL·접근기록·최종종결+90일 정리가 실제 연결됐는지 확인한다. */
  isReady(): Promise<boolean>;
}
export interface AiFeedbackPort { submit(userId: string, input: AiFeedbackInput): Promise<AiFeedbackResult> }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function readAiFeedbackInput(body: JsonValue): AiFeedbackInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError("INVALID_REQUEST");
  const keys = body.action === "helpful" ? ["clientRequestId", "requestId", "action"] :
    ["clientRequestId", "requestId", "action", "confirmed", "attachment"];
  if (!exact(body, keys) || typeof body.clientRequestId !== "string" || !body.clientRequestId.trim() || body.clientRequestId.length > 128 ||
      typeof body.requestId !== "string" || !uuid.test(body.requestId) || !["helpful", "report"].includes(String(body.action))) {
    throw new HttpError("INVALID_REQUEST");
  }
  if (body.action === "helpful") return { clientRequestId: body.clientRequestId, requestId: body.requestId, action: "helpful" };
  const attachment = body.attachment;
  if (body.confirmed !== true || !attachment || typeof attachment !== "object" || Array.isArray(attachment)) throw new HttpError("INVALID_REQUEST");
  let selected: AiFeedbackAttachment;
  if (exact(attachment, ["kind", "text"]) && attachment.kind === "answer" && typeof attachment.text === "string" &&
      attachment.text.trim() && [...attachment.text].length <= 500) {
    selected = { kind: "answer", text: attachment.text };
  } else if (exact(attachment, ["kind", "assetId"]) && attachment.kind === "capture" && typeof attachment.assetId === "string" && uuid.test(attachment.assetId)) {
    selected = { kind: "capture", assetId: attachment.assetId };
  } else throw new HttpError("INVALID_REQUEST");
  return { clientRequestId: body.clientRequestId, requestId: body.requestId, action: "report", confirmed: true, attachment: selected };
}

export function createRpcAiFeedback(db: RpcClient, handling?: ReportEvidenceHandlingPort): AiFeedbackPort {
  return { async submit(userId, untrusted) {
    // HTTP 이외 직접 호출도 같은 형태를 검사한다. userId는 인증 문맥에서만 공급한다.
    const input = readAiFeedbackInput(untrusted as unknown as JsonValue);
    if (typeof userId !== "string" || !uuid.test(userId)) throw new HttpError("AUTH_REQUIRED");
    if (input.action === "report") {
      if (typeof handling?.isReady !== "function") return { status: "not_enabled", reason: "AI_REPORT_EVIDENCE_HANDLING_NOT_CONNECTED" };
      try {
        if (await handling.isReady() !== true) return { status: "not_enabled", reason: "AI_REPORT_EVIDENCE_HANDLING_NOT_CONNECTED" };
      } catch { return { status: "not_enabled", reason: "AI_REPORT_EVIDENCE_HANDLING_NOT_CONNECTED" }; }
    }
    let result: JsonValue;
    try {
      result = await db.rpc("submit_ai_feedback", { p_user_id: userId, p_request_id: input.requestId,
        p_client_request_id: input.clientRequestId, p_action: input.action,
        p_attachment: input.action === "report" ? input.attachment as unknown as JsonValue : null,
        p_contract_version: "2026-10-05" });
    } catch (error) {
      const code = toPublicError(error).error.code;
      if (["AUTH_REQUIRED", "RESOURCE_NOT_FOUND", "STATE_CONFLICT"].includes(code)) throw error;
      return { status: "not_enabled", reason: "AI_FEEDBACK_STORAGE_NOT_CONNECTED" };
    }
    if (exact(result, ["status"])) {
      if (result.status === "request_not_owned" || result.status === "asset_not_owned") throw new HttpError("ACCESS_DENIED");
      if (result.status === "idempotency_conflict") throw new HttpError("STATE_CONFLICT");
    }
    if (!exact(result, ["status", "feedbackId", "hideAnswer"]) || result.status !== "accepted" ||
        typeof result.feedbackId !== "string" || !uuid.test(result.feedbackId) || result.hideAnswer !== (input.action === "report")) {
      throw new HttpError("EXTERNAL_UNAVAILABLE");
    }
    return { status: "accepted", feedbackId: result.feedbackId.toLowerCase(), hideAnswer: result.hideAnswer as boolean };
  } };
}
