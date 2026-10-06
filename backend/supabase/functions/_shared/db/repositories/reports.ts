/** 민규: 회원 JWT 전용 고정 RPC. 신고자 ID·운영 판정·외부 첨부 URL을 전달하지 않는다. */
import type { RpcClient } from "../transport.ts";
import { SANCTION_PUBLIC_REASONS, SANCTION_KINDS, DECISION_NOTICE_REASONS, DECISION_MINOR_TYPES, DECISION_MAJOR_TYPES } from "../../contracts/reports.ts";
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

/** 본인 이력의 좁은 읽기 계약. 이의 마감은 권위 있는 관계가 연결될 때까지 NULL이다. */
export async function listMySanctions(db: RpcClient, limit: number, before: string | null): Promise<JsonValue> {
  const result = exact(await db.rpc("list_my_sanctions", { p_limit: limit, p_before: before }), ["items", "nextCursor"]);
  const timestamp = (value: JsonValue): value is string => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
    if (Number(value.slice(11,13))>23 || Number(value.slice(14,16))>59 || Number(value.slice(17,19))>59) return false;
    return new Date(`${value.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10) === value.slice(0,10);
  };
  const optionalTimestamp = (value: JsonValue) => value === null || timestamp(value);
  const reason = (value: JsonValue) => typeof value === "string" && (SANCTION_PUBLIC_REASONS as readonly string[]).includes(value);
  if (!Array.isArray(result.items) || result.items.length > limit || (result.nextCursor !== null && !validUuid(result.nextCursor))) return unavailable();
  let previous = before?.toLowerCase() ?? "";
  for (const value of result.items) {
    const item = exact(value, ["sanctionId","kind","status","reasonCode","correctionReasonCode","appliedAt","expiresAt","notifiedAt","revokedAt","appealPolicy","appealDeadlineAt","appealState"]);
    if (!validUuid(item.sanctionId) || typeof item.sanctionId !== "string" || item.sanctionId !== item.sanctionId.toLowerCase() || item.sanctionId <= previous || typeof item.kind !== "string" || !(SANCTION_KINDS as readonly string[]).includes(item.kind) || !reason(item.reasonCode)) return unavailable();
    previous = item.sanctionId;
    if (!timestamp(item.appliedAt) || !optionalTimestamp(item.expiresAt) || !optionalTimestamp(item.notifiedAt) || !optionalTimestamp(item.revokedAt)) return unavailable();
    const corrected = item.revokedAt !== null;
    if (corrected ? item.status !== "corrected" || !reason(item.correctionReasonCode) || Date.parse(item.revokedAt as string) < Date.parse(item.appliedAt) : !["active","ended"].includes(String(item.status)) || typeof item.status !== "string" || item.correctionReasonCode !== null) return unavailable();
    const timed = ["cancel_restriction","general_7d","general_30d"].includes(item.kind);
    if (timed ? item.expiresAt === null || Date.parse(item.expiresAt as string) <= Date.parse(item.appliedAt) : item.expiresAt !== null || item.status === "ended") return unavailable();
    const cancellation = item.kind.startsWith("cancel_");
    if (item.appealPolicy !== (cancellation ? "cancellation_24h" : "general_7d") || item.appealDeadlineAt !== null || (item.appealState !== null && (typeof item.appealState !== "string" || !["reviewing","accepted","rejected"].includes(item.appealState))) || (cancellation && item.appealState !== null)) return unavailable();
  }
  if (result.nextCursor !== null && (result.items.length !== limit || result.nextCursor !== previous)) return unavailable();
  return result;
}

/** 본인 통지 exact9만 허용한다. 상대 위반·원문·추정 배송/기한을 전달하지 않는다. */
function decisionNotice(value: JsonValue): Record<string, JsonValue> {
  const item = exact(value, ["noticeId", "appointmentId", "appointmentOutcome", "violationOutcome", "reasonCode", "violationClass", "violationType", "availableAt", "firstReadAt"]);
  const timestamp = (v: JsonValue): v is string => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v))) return false;
    if (Number(v.slice(11,13))>23 || Number(v.slice(14,16))>59 || Number(v.slice(17,19))>59) return false;
    return new Date(`${v.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10) === v.slice(0,10);
  };
  if (!validUuid(item.noticeId) || typeof item.noticeId !== "string" || item.noticeId !== item.noticeId.toLowerCase()
      || (item.appointmentId !== null && (!validUuid(item.appointmentId) || typeof item.appointmentId !== "string" || item.appointmentId !== item.appointmentId.toLowerCase()))
      || (item.appointmentOutcome !== null && item.appointmentOutcome !== "normal" && item.appointmentOutcome !== "no_show")
      || (item.violationOutcome !== null && item.violationOutcome !== "confirmed" && item.violationOutcome !== "invalidated")
      || typeof item.reasonCode !== "string" || !(DECISION_NOTICE_REASONS as readonly string[]).includes(item.reasonCode)
      || !timestamp(item.availableAt) || (item.firstReadAt !== null && (!timestamp(item.firstReadAt) || Date.parse(item.firstReadAt) < Date.parse(item.availableAt)))) return unavailable();
  if (item.appointmentOutcome !== null && item.appointmentId === null) return unavailable();
  if (item.violationOutcome === null) {
    if (item.appointmentOutcome === null || item.violationClass !== null || item.violationType !== null || item.reasonCode !== item.appointmentOutcome) return unavailable();
  } else if (item.violationOutcome === "invalidated") {
    if (item.violationClass !== null || item.violationType !== null || item.reasonCode !== "decision_corrected") return unavailable();
  } else if (item.violationClass === "none") {
    if (item.violationType !== null || item.appointmentOutcome !== "no_show" || item.reasonCode !== "no_show") return unavailable();
  } else {
    if (typeof item.violationType !== "string" || item.reasonCode !== item.violationType
        || (item.violationClass === "minor" ? !(DECISION_MINOR_TYPES as readonly string[]).includes(item.violationType)
          : item.violationClass === "major" ? !(DECISION_MAJOR_TYPES as readonly string[]).includes(item.violationType) : true)) return unavailable();
  }
  return item;
}
export async function listMyDecisionNotices(db: RpcClient, limit: number, before: string | null): Promise<JsonValue> {
  const result = exact(await db.rpc("list_my_decision_notices", { p_limit: limit, p_before: before }), ["items", "nextCursor"]);
  if (!Array.isArray(result.items) || result.items.length > limit || (result.nextCursor !== null && !validUuid(result.nextCursor))) return unavailable();
  let previous = before?.toLowerCase() ?? "";
  for (const value of result.items) {
    const item = decisionNotice(value);
    if (typeof item.noticeId !== "string" || item.noticeId <= previous) return unavailable();
    previous = item.noticeId;
  }
  if (result.nextCursor !== null && (result.items.length !== limit || result.nextCursor !== previous)) return unavailable();
  return result;
}
export async function readMyDecisionNotice(db: RpcClient, id: string): Promise<JsonValue> {
  const result = decisionNotice(await db.rpc("read_my_decision_notice", { p_notice_id: id }));
  if (result.noticeId !== id.toLowerCase() || result.firstReadAt === null) return unavailable();
  return result;
}

// UTC 마이크로초를 보존하여 같은 밀리초 안의 역순/ACK 시각도 거절한다.
function cancellationNoticeTime(value: JsonValue): bigint | null {
  if (typeof value!=="string") return null;
  const m=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|\+00:00)$/.exec(value);
  if (!m || Number(m[2])>23 || Number(m[3])>59 || Number(m[4])>59) return null;
  const ms=Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10)!==m[1]) return null;
  return BigInt(ms)*1000n+BigInt((m[5]??"").padEnd(6,"0"));
}
function cancellationNotice(value: JsonValue): Record<string, JsonValue> {
  const v=exact(value,["noticeId","appointmentId","appealState","planState","eligibleCount","provisionalCount","hasCancellationWarning","restrictedUntil","availableAt","firstReadAt"]);
  const lowerUuid=(x:JsonValue)=>typeof x==="string" && x===x.toLowerCase() && validUuid(x);
  const count=(x:JsonValue)=>typeof x==="number" && Number.isSafeInteger(x) && x>=0;
  const available=cancellationNoticeTime(v.availableAt), read=v.firstReadAt===null?null:cancellationNoticeTime(v.firstReadAt);
  if (!lowerUuid(v.noticeId) || !lowerUuid(v.appointmentId) || (v.appealState!==null && (typeof v.appealState!=="string" || !["reviewing","accepted","rejected"].includes(v.appealState))) || typeof v.planState!=="string" || !["held","applied","corrected","policy_pending"].includes(v.planState) || typeof v.hasCancellationWarning!=="boolean" || available===null || (v.firstReadAt!==null && (read===null || read<available)) || (v.restrictedUntil!==null && cancellationNoticeTime(v.restrictedUntil)===null)) return unavailable();
  if (v.eligibleCount===null || v.provisionalCount===null) {
    if (v.eligibleCount!==null || v.provisionalCount!==null || v.planState!=="policy_pending") return unavailable();
  } else if (!count(v.eligibleCount) || !count(v.provisionalCount)) return unavailable();
  return v;
}
export async function listMyCancellationNotices(db: RpcClient, limit: number, before: string | null): Promise<JsonValue> {
  const v=exact(await db.rpc("list_my_cancellation_notices",{p_limit:limit,p_before:before}),["items","nextCursor"]);
  if (!Array.isArray(v.items) || v.items.length>limit || (v.nextCursor!==null && (typeof v.nextCursor!=="string" || v.nextCursor!==v.nextCursor.toLowerCase() || !validUuid(v.nextCursor)))) return unavailable();
  let previous:Record<string,JsonValue>|null=null;
  const ids=new Set<string>();
  for (const raw of v.items) {
    const item=cancellationNotice(raw), id=item.noticeId as string;
    if (ids.has(id) || id===before?.toLowerCase()) return unavailable();
    if (previous) {
      const time=cancellationNoticeTime(item.availableAt)!, prev=cancellationNoticeTime(previous.availableAt)!;
      if (time>prev || (time===prev && id>=(previous.noticeId as string))) return unavailable();
    }
    ids.add(id);previous=item;
  }
  if (v.nextCursor!==null && (v.items.length!==limit || v.nextCursor!==previous?.noticeId)) return unavailable();
  return v;
}
export async function readMyCancellationNotice(db: RpcClient, id: string): Promise<JsonValue> {
  const v=cancellationNotice(await db.rpc("read_my_cancellation_notice",{p_notice_id:id}));
  if (v.noticeId!==id.toLowerCase() || v.firstReadAt===null) return unavailable();
  return v;
}

const hiddenTypes=["post","chat","appointment","member","event"];
export async function listMyHiddenTargets(db:RpcClient,limit:number,before:string|null):Promise<JsonValue>{
 const result=exact(await db.rpc("list_my_hidden_targets",{p_limit:limit,p_before:before}),["items","nextCursor"]);
 if(!Array.isArray(result.items)||result.items.length>limit||(result.nextCursor!==null&&!validUuid(result.nextCursor)))return unavailable();
 const seen=new Set<string>();
 for(const value of result.items){const item=exact(value,["targetType","targetId"]);
  if(typeof item.targetType!=="string"||!hiddenTypes.includes(item.targetType)||!validUuid(item.targetId))return unavailable();
  const key=item.targetType+":"+String(item.targetId).toLowerCase();if(seen.has(key))return unavailable();seen.add(key);
 }
 if(result.nextCursor!==null&&result.items.length!==limit)return unavailable();return result;
}
export async function unhideMyReportTarget(db:RpcClient,targetType:string,targetId:string):Promise<JsonValue>{
 const result=exact(await db.rpc("unhide_my_report_target",{p_target_type:targetType,p_target_id:targetId}),["targetType","targetId","hidden"]);
 if(result.targetType!==targetType||result.targetId!==targetId.toLowerCase()||result.hidden!==false)return unavailable();return result;
}
