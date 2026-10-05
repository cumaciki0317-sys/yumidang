/** 민규: 회원 JWT 전용 고정 RPC. 신고자 ID·운영 판정·외부 첨부 URL을 전달하지 않는다. */
import type { RpcClient } from "../transport.ts";
import type { MemberReportInput } from "../../contracts/reports.ts";
import type { JsonValue } from "../../contracts/common.ts";
import { HttpError } from "../../http/errors.ts";
const unavailable = (): never => { throw new HttpError("EXTERNAL_UNAVAILABLE"); };
function exact(value: JsonValue, keys: string[]): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return unavailable();
  return value;
}
const validUuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export async function reserveReportCapture(db: RpcClient, id: string, extension: string): Promise<JsonValue> {
  const result = exact(await db.rpc("reserve_report_capture", { p_asset_id: id, p_extension: extension }), ["assetId", "bucket", "path", "state"]);
  if (result.assetId !== id.toLowerCase() || result.bucket !== "report-evidence" || typeof result.path !== "string" || !validUuid(result.path.split("/")[0]) || result.path !== `${result.path.split("/")[0]}/${id.toLowerCase()}.${extension}` || (typeof result.state !== "string" || !["reserved", "uploaded", "attached"].includes(result.state))) return unavailable();
  return result;
}
export async function confirmReportCapture(db: RpcClient, id: string): Promise<JsonValue> {
  const result = exact(await db.rpc("confirm_report_capture", { p_asset_id: id }), ["assetId", "state"]);
  if (result.assetId !== id.toLowerCase() || (typeof result.state !== "string" || !["uploaded", "attached"].includes(result.state))) return unavailable();
  return result;
}
export async function cancelReportCapture(db: RpcClient, id: string): Promise<JsonValue> {
  const result = exact(await db.rpc("cancel_report_capture", { p_asset_id: id }), ["assetId", "state", "storageDeletionRequired"]);
  if (result.assetId !== id.toLowerCase() || result.state !== "cancelled" || typeof result.storageDeletionRequired !== "boolean") return unavailable();
  return result;
}
export async function submitMemberReport(db: RpcClient, input: MemberReportInput): Promise<JsonValue> {
  const result = exact(await db.rpc("submit_member_report", {
    p_client_request_id: input.clientRequestId, p_target_type: input.targetType, p_target_id: input.targetId, p_context: input.context,
    p_reason_codes: input.reasonCodes, p_description: input.description, p_asset_ids: input.assetIds, p_hide_target: input.hideTarget,
  }), ["reportId", "status", "alreadySubmitted", "hideTarget"]);
  if (!validUuid(result.reportId) || (typeof result.status !== "string" || !["received", "reviewing", "more_evidence", "resolved"].includes(result.status)) || typeof result.alreadySubmitted !== "boolean" || result.hideTarget !== input.hideTarget) return unavailable();
  return result;
}
export const listMyReports = (db: RpcClient, limit: number, before: string | null) => db.rpc("list_my_reports", { p_limit: limit, p_before: before });
export const getMyReport = (db: RpcClient, id: string) => db.rpc("get_my_report", { p_report_id: id });

/** 본인의 현재 유효 제재만 반환한다. 원문·타인 식별자·추정 이의 마감은 전달하지 않는다. */
export async function getMySafetyState(db: RpcClient): Promise<JsonValue> {
  const result = exact(await db.rpc("get_my_safety_state", {}), ["permanent", "restrictedUntil", "hasWarning", "sanctions"]);
  const timestamp = (value: JsonValue): boolean => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
    if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return false;
    return new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
  };
  const optionalTimestamp = (value: JsonValue) => value === null || timestamp(value);
  if (typeof result.permanent !== "boolean" || typeof result.hasWarning !== "boolean" || !optionalTimestamp(result.restrictedUntil) || !Array.isArray(result.sanctions)) return unavailable();
  const kinds = ["cancel_warning", "cancel_restriction", "general_warning", "general_7d", "general_30d", "permanent"];
  for (const value of result.sanctions) {
    const sanction = exact(value, ["sanctionId", "kind", "appliedAt", "expiresAt", "notifiedAt"]);
    if (!validUuid(sanction.sanctionId) || typeof sanction.kind !== "string" || !kinds.includes(sanction.kind) || !timestamp(sanction.appliedAt) || !optionalTimestamp(sanction.expiresAt) || !optionalTimestamp(sanction.notifiedAt)) return unavailable();
  }
  return result;
}
