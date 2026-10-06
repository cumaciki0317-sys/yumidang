/** 민규: 확정된 신고 종류와 최소 입력. 수량·길이·파일 상한은 기술 방어값이다. */
import type { JsonValue } from "./common.ts";
import { HttpError } from "../http/errors.ts";
export const REPORT_REASONS = ["sexual_harassment", "threat", "money_or_personal_data", "impersonation", "spam", "no_show", "other"] as const;
export interface MemberReportInput {
  clientRequestId: string;
  targetType: "post" | "chat" | "appointment" | "member" | "event";
  targetId: string;
  context: "online" | "offline";
  reasonCodes: string[];
  description: string;
  assetIds: string[];
  hideTarget: boolean;
}
const fail = (): never => { throw new HttpError("INVALID_REQUEST"); };
export function reportObject(value: JsonValue, keys: string[]): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return fail();
  return value;
}
export function reportUuid(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return fail();
  return value;
}
export function parseMemberReport(value: JsonValue): MemberReportInput {
  const input = reportObject(value, ["clientRequestId", "targetType", "targetId", "context", "reasonCodes", "description", "assetIds", "hideTarget"]);
  if (typeof input.targetType !== "string" || typeof input.context !== "string" || !["post", "chat", "appointment", "member", "event"].includes(String(input.targetType)) || !["online", "offline"].includes(String(input.context))) return fail();
  if (["post", "chat", "event"].includes(String(input.targetType)) && input.context !== "online" || input.targetType === "appointment" && input.context !== "offline") return fail();
  if (!Array.isArray(input.reasonCodes) || input.reasonCodes.length < 1 || input.reasonCodes.length > 7 || input.reasonCodes.some((code) => typeof code !== "string" || !(REPORT_REASONS as readonly string[]).includes(code)) || new Set(input.reasonCodes).size !== input.reasonCodes.length) return fail();
  if (typeof input.description !== "string" || input.description.trim() !== input.description || [...input.description].length < 1 || [...input.description].length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input.description)) return fail();
  if (!Array.isArray(input.assetIds) || input.assetIds.length > 5 || new Set(input.assetIds).size !== input.assetIds.length || input.context === "online" && input.assetIds.length === 0 || typeof input.hideTarget !== "boolean") return fail();
  return { clientRequestId: reportUuid(input.clientRequestId), targetType: input.targetType as MemberReportInput["targetType"], targetId: reportUuid(input.targetId), context: input.context as MemberReportInput["context"], reasonCodes: input.reasonCodes as string[], description: input.description, assetIds: input.assetIds.map(reportUuid), hideTarget: input.hideTarget };
}

/** 본인 조치의 대표 사유 코드만 허용한다. 운영 원문 code를 그대로 공개하지 않는다. */
export const SANCTION_PUBLIC_REASONS = ["sexual_harassment", "threat", "money_or_personal_data", "impersonation", "spam", "no_show", "rule_violation", "repeated_cancellation", "other"] as const;
export const SANCTION_KINDS = ["cancel_warning", "cancel_restriction", "general_warning", "general_7d", "general_30d", "permanent"] as const;

/** 본인 회차의 서버 게시/명시 ACK facts. 외부 통지·이의 마감·제재 값이 아니다. */
export const DECISION_NOTICE_REASONS = ["normal", "no_show", "decision_corrected", "spam", "rule_violation", "sexual_harassment", "threat", "violence", "stalking", "privacy_exposure", "sexual_exploitation"] as const;
export const DECISION_MINOR_TYPES = ["spam", "rule_violation"] as const;
export const DECISION_MAJOR_TYPES = ["sexual_harassment", "threat", "violence", "stalking", "privacy_exposure", "sexual_exploitation"] as const;
export interface MemberDecisionNotice {
  noticeId: string;
  appointmentId: string | null;
  appointmentOutcome: "normal" | "no_show" | null;
  violationOutcome: "confirmed" | "invalidated" | null;
  reasonCode: typeof DECISION_NOTICE_REASONS[number];
  violationClass: "none" | "minor" | "major" | null;
  violationType: typeof DECISION_MINOR_TYPES[number] | typeof DECISION_MAJOR_TYPES[number] | null;
  availableAt: string;
  firstReadAt: string | null;
}

/** 취소 이의 해소/계획의 본인 회차 facts. 기존 판정 통지 exact9와 별도 계약이다. */
export interface MemberCancellationNotice {
  noticeId: string;
  appointmentId: string;
  appealState: "reviewing" | "accepted" | "rejected" | null;
  planState: "held" | "applied" | "corrected" | "policy_pending";
  eligibleCount: number | null;
  provisionalCount: number | null;
  hasCancellationWarning: boolean;
  restrictedUntil: string | null;
  availableAt: string;
  firstReadAt: string | null;
}
