/** 민규담당: 검증된 사용자의 원래 JWT로만 RPC를 실행해 RLS/auth.uid()를 유지한다. */
import type { RuntimeConfig } from "../config/env.ts";
import { getPrincipalToken, type Principal } from "../auth/principal.ts";
import { createRpcTransport, type FetchLike, type RpcClient } from "./transport.ts";
const userRpcs = new Set([
  "get_naver_signup_state", "complete_naver_signup", "withdraw_my_ai_processing",
  "list_my_hidden_targets", "unhide_my_report_target", "reserve_report_capture", "confirm_report_capture", "cancel_report_capture", "submit_member_report", "list_my_reports", "get_my_report", "get_my_safety_state", "list_my_sanctions", "list_my_decision_notices", "read_my_decision_notice", "list_my_cancellation_notices", "read_my_cancellation_notice",
  "block_member", "unblock_member", "list_my_blocks",
  "get_my_profile_traits", "set_my_profile_traits", "set_my_profile_preferences", "get_post_author_traits",
  "list_event_candidates_v1",
  "list_public_events", "list_event_filter_values", "get_public_profile",
  "search_public_posts_v2",
  "list_my_appointments", "get_appointment_state", "confirm_appointment_completion",
  "get_my_appointment_cancel_appeal", "submit_appointment_cancel_appeal", "submit_appointment_cancel_appeal_with_report",
  "get_appointment_change_state", "propose_appointment_schedule_change", "accept_appointment_schedule_change", "decline_appointment_schedule_change", "withdraw_appointment_schedule_change", "cancel_appointment",
  "get_appointment_review_state", "submit_appointment_review", "get_public_profile_reviews",
  "get_review_praise_catalog",
  "get_my_profile", "set_my_profile_avatar", "list_my_notifications", "mark_my_notification_read", "mark_all_my_notifications_read",
  "list_conversations", "get_conversation", "leave_conversation", "list_conversation_messages", "send_conversation_message",
  "get_service_post", "create_service_post", "request_service_post", "list_sent_join_requests",
  "update_service_post", "close_service_post", "reopen_service_post", "delete_service_post", "withdraw_match_consent", "decline_match_consent",
  "list_received_join_requests", "withdraw_join_request", "decline_join_request", "propose_match", "accept_match", "get_match_consent",
]);
export function createUserClient(config: RuntimeConfig, principal: Principal, fetchImpl: FetchLike = fetch): RpcClient {
  return createRpcTransport(config, config.supabaseAnonKey, getPrincipalToken(principal), userRpcs, fetchImpl);
}
