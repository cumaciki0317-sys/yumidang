/** 민규담당: 검증된 사용자의 원래 JWT로만 RPC를 실행해 RLS/auth.uid()를 유지한다. */
import type { RuntimeConfig } from "../config/env.ts";
import type { JsonValue } from "../contracts/common.ts";
import { getPrincipalToken, readBearer, type Principal } from "../auth/principal.ts";
import { createRpcTransport, fetchJson, type FetchLike, type RpcClient } from "./transport.ts";
import { HttpError } from "../http/errors.ts";
const userRpcs = new Set([
  "get_naver_signup_state", "complete_naver_signup", "withdraw_my_ai_processing", "retire_my_account",
  "submit_my_general_sanction_appeal", "get_my_general_sanction_appeal", "prepare_my_general_notice_delivery", "acknowledge_my_general_notice_provided", "list_my_hidden_targets", "unhide_my_report_target", "reserve_report_capture", "confirm_report_capture", "cancel_report_capture", "submit_member_report", "list_my_reports", "get_my_report", "get_my_safety_state", "list_my_sanctions", "list_my_decision_notices", "read_my_decision_notice", "list_my_cancellation_notices", "read_my_cancellation_notice",
  "block_member", "unblock_member", "list_my_blocks",
  "get_my_profile_traits", "set_my_profile_traits", "set_my_profile_preferences", "get_post_author_traits",
  "list_event_candidates_v1",
  "get_public_event", "get_public_event_ranking_state", "list_public_events", "list_event_filter_values", "get_public_profile",
  "search_public_posts_v2",
  "list_my_appointments", "get_appointment_state", "confirm_appointment_completion",
  "get_my_appointment_cancel_appeal", "submit_appointment_cancel_appeal", "submit_appointment_cancel_appeal_with_report",
  "get_appointment_change_state", "propose_appointment_schedule_change", "accept_appointment_schedule_change", "decline_appointment_schedule_change", "withdraw_appointment_schedule_change", "cancel_appointment",
  "get_appointment_review_state", "submit_appointment_review", "get_public_profile_reviews", "get_visible_review_summary",
  "get_review_praise_catalog",
  "get_my_profile", "set_my_profile_avatar", "list_my_notifications", "mark_my_notification_read", "mark_all_my_notifications_read",
  "list_conversations_with_read_state", "get_conversation_with_read_state", "mark_conversation_read", "mark_conversation_messages_read", "list_conversations", "get_conversation", "leave_conversation", "list_conversation_messages", "send_conversation_message",
  "list_my_service_posts", "get_service_post", "create_service_post", "request_service_post", "list_sent_join_requests",
  "update_service_post", "close_service_post", "reopen_service_post", "delete_service_post", "withdraw_match_consent", "decline_match_consent",
  "list_received_join_requests", "withdraw_join_request", "decline_join_request", "propose_match", "accept_match", "get_match_consent",
]);
export function createUserClient(config: RuntimeConfig, principal: Principal, fetchImpl: FetchLike = fetch): RpcClient {
  return createRpcTransport(config, config.supabaseAnonKey, getPrincipalToken(principal), userRpcs, fetchImpl);
}

/** 일반 Principal과 분리된, 원 bearer로만 호출하는 단일 GET 전용 포트다. */
export interface RetirementReceiptClient {
  getReceipt(withdrawalId: string, fingerprint: string): Promise<JsonValue>;
}
export function createRetirementReceiptClient(config: RuntimeConfig, request: Request, fetchImpl: FetchLike = fetch): RetirementReceiptClient {
  const token=readBearer(request);
  if(token===config.supabaseAnonKey||token===config.supabaseServiceRoleKey||token===config.internalWorkerSecret||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw new HttpError("AUTH_REQUIRED");
  return Object.freeze({async getReceipt(withdrawalId: string,fingerprint: string){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(withdrawalId)||
      !/^[0-9a-f]{64}$/.test(fingerprint))throw new HttpError("INVALID_REQUEST");
    const query=new URLSearchParams({p_withdrawal_id:withdrawalId,p_request_fingerprint:fingerprint});
    const {status,body}=await fetchJson(`${config.supabaseUrl}/rest/v1/rpc/get_my_retirement_receipt?${query}`,{
      method:"GET",headers:{apikey:config.supabaseAnonKey,Authorization:`Bearer ${token}`,Accept:"application/json"},
    },config.upstreamTimeoutMs,fetchImpl);
    if(status!==200){if(status>=500||status===429)throw new HttpError("EXTERNAL_UNAVAILABLE");throw new HttpError("AUTH_REQUIRED");}
    return body;
  }});
}
