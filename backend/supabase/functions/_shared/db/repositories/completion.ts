/** 민규담당. 고정 RPC만 호출하며 사용자 ID·권한 판정은 DB에서 수행한다. */
import type { RpcClient } from "../transport.ts";
import type { AppointmentScheduleProposal, AppointmentScheduleResponse, AppointmentCancellation } from "../../contracts/matching.ts";
export const listAppointments = (db: RpcClient) => db.rpc("list_my_appointments", {});
export const getAppointment = (db: RpcClient, id: string) => db.rpc("get_appointment_state", { p_appointment_id: id });
export const confirmCompletion = (db: RpcClient, id: string) => db.rpc("confirm_appointment_completion", { p_appointment_id: id });
export const processDueCompletions = (db: RpcClient, limit: number) => db.rpc("process_due_completions", { p_limit: limit });
export const getAppointmentChangeState = (db: RpcClient, id: string) => db.rpc("get_appointment_change_state", { p_appointment_id: id });
export const proposeAppointmentScheduleChange = (db: RpcClient, id: string, input: AppointmentScheduleProposal) => db.rpc("propose_appointment_schedule_change", {
  p_appointment_id: id, p_change_id: input.changeId, p_starts_at: input.startsAt, p_ends_at: input.endsAt, p_expected_updated_at: input.expectedUpdatedAt,
  ...(input.location === undefined ? {} : { p_location: { ...input.location } }),
});
export const acceptAppointmentScheduleChange = (db: RpcClient, id: string, input: AppointmentScheduleResponse) => db.rpc("accept_appointment_schedule_change", {
  p_appointment_id: id, p_change_id: input.changeId, p_condition_version: input.conditionVersion,
});
export const declineAppointmentScheduleChange = (db: RpcClient, id: string, input: AppointmentScheduleResponse) => db.rpc("decline_appointment_schedule_change", {
  p_appointment_id: id, p_change_id: input.changeId, p_condition_version: input.conditionVersion,
});
export const withdrawAppointmentScheduleChange = (db: RpcClient, id: string, input: AppointmentScheduleResponse) => db.rpc("withdraw_appointment_schedule_change", {
  p_appointment_id: id, p_change_id: input.changeId, p_condition_version: input.conditionVersion,
});
export const cancelAppointment = (db: RpcClient, id: string, input: AppointmentCancellation) => db.rpc("cancel_appointment", {
  p_appointment_id: id, p_cancellation_id: input.cancellationId, p_reason: input.reason,
});
/** 유지보수의 내부 client만 허용하며 모델 설정과 별개로 만료를 처리한다. */
export const expireAppointmentChanges = (db: RpcClient, limit: number) => db.rpc("expire_appointment_changes", { p_limit: limit });

/** 본인 취소 이의 관리. 접수·마감·회차는 원 JWT의 DB 판정만 사용한다. */
import type { JsonValue } from "../../contracts/common.ts";
import { HttpError } from "../../http/errors.ts";
export interface AppointmentCancelAppealInput { clientRequestId: string; expectedResultRevision: number; reportId: string }
const appealUnavailable = (): never => { throw new HttpError("EXTERNAL_UNAVAILABLE"); };
const appealUuid = (v: JsonValue): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
/** PG microseconds를 보존하여 마감 1µs 직전의 정상 응답도 허용한다. */
function appealTime(v: JsonValue): bigint | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)
      || !Number.isFinite(Date.parse(v)) || Number(v.slice(11,13))>23 || Number(v.slice(14,16))>59 || Number(v.slice(17,19))>59) return null;
  if (new Date(`${v.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10) !== v.slice(0,10)) return null;
  const fraction = v.match(/\.(\d{1,6})(?=Z|[+-])/);
  return BigInt(Date.parse(v.replace(/\.\d{1,6}(?=Z|[+-])/, ""))) * 1000n + BigInt((fraction?.[1] ?? "").padEnd(6, "0"));
}
function appealResult(value: JsonValue, appointmentId: string, submit: boolean): Record<string, JsonValue> {
  const keys = ["appealId","appointmentId","resultRevision","state","cancelledAt","deadlineAt","receivedAt","resolvedAt", ...(submit ? ["alreadyApplied"] : [])];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k=>!Object.hasOwn(value,k))) return appealUnavailable();
  const result = value;
  if (result.appointmentId !== appointmentId.toLowerCase() || !appealUuid(result.appointmentId)
      || typeof result.resultRevision !== "number" || !Number.isSafeInteger(result.resultRevision) || result.resultRevision < 1) return appealUnavailable();
  const cancelled = appealTime(result.cancelledAt), deadline = appealTime(result.deadlineAt);
  if (cancelled === null || deadline === null || deadline - cancelled !== 86_400_000_000n) return appealUnavailable();
  if (!submit && result.appealId === null) {
    if (result.state !== null || result.receivedAt !== null || result.resolvedAt !== null) return appealUnavailable();
  } else {
    if (!appealUuid(result.appealId) || typeof result.state !== "string" || !["reviewing","accepted","rejected"].includes(result.state)) return appealUnavailable();
    const received = appealTime(result.receivedAt);
    if (received === null || received < cancelled || received >= deadline) return appealUnavailable();
    if (result.state === "reviewing") { if (result.resolvedAt !== null) return appealUnavailable(); }
    else { const resolved = appealTime(result.resolvedAt); if (resolved === null || resolved < received) return appealUnavailable(); }
  }
  if (submit && (typeof result.alreadyApplied !== "boolean" || result.state !== "reviewing" || result.resolvedAt !== null)) return appealUnavailable();
  return result;
}
export async function getMyAppointmentCancelAppeal(db: RpcClient, appointmentId: string): Promise<JsonValue> {
  return appealResult(await db.rpc("get_my_appointment_cancel_appeal", { p_appointment_id: appointmentId }), appointmentId, false);
}
export async function submitAppointmentCancelAppeal(db: RpcClient, appointmentId: string, input: AppointmentCancelAppealInput): Promise<JsonValue> {
  const result = appealResult(await db.rpc("submit_appointment_cancel_appeal", {
    p_appointment_id: appointmentId, p_client_request_id: input.clientRequestId,
    p_expected_result_revision: input.expectedResultRevision, p_report_id: input.reportId,
  }), appointmentId, true);
  if (result.resultRevision !== input.expectedResultRevision + 1) return appealUnavailable();
  return result;
}

/** S21 단일 접수. 원문은 기존 신고 RPC 저장소에만 저장하고 접수 시각은 DB가 판정한다. */
import type { MemberReportInput } from "../../contracts/reports.ts";
export type AppointmentCancelAppealWithReportInput = Pick<MemberReportInput, "clientRequestId" | "reasonCodes" | "description" | "assetIds" | "hideTarget"> & { expectedResultRevision: number };
export async function submitAppointmentCancelAppealWithReport(db: RpcClient, appointmentId: string, input: AppointmentCancelAppealWithReportInput): Promise<JsonValue> {
  const value = await db.rpc("submit_appointment_cancel_appeal_with_report", {
    p_appointment_id: appointmentId, p_client_request_id: input.clientRequestId,
    p_expected_result_revision: input.expectedResultRevision, p_reason_codes: input.reasonCodes,
    p_description: input.description, p_asset_ids: input.assetIds, p_hide_target: input.hideTarget,
  });
  if (!value || typeof value !== "object" || Array.isArray(value) || !appealUuid(value.reportId)) return appealUnavailable();
  const { reportId, ...appeal } = value;
  const result = appealResult(appeal, appointmentId, true);
  if (result.resultRevision !== input.expectedResultRevision + 1) return appealUnavailable();
  return { ...result, reportId };
}
