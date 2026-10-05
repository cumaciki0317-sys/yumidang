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
