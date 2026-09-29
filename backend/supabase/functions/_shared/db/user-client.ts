/** 민규담당: 검증된 사용자의 원래 JWT로만 RPC를 실행해 RLS/auth.uid()를 유지한다. */
import type { RuntimeConfig } from "../config/env.ts";
import { getPrincipalToken, type Principal } from "../auth/principal.ts";
import { createRpcTransport, type FetchLike, type RpcClient } from "./transport.ts";
const userRpcs = new Set([
  "search_public_posts_v2",
  "list_my_appointments", "get_appointment_state", "confirm_appointment_completion",
  "get_appointment_review_state", "submit_appointment_review", "get_public_profile_reviews",
  "get_my_profile", "set_my_profile_avatar", "list_my_notifications", "mark_my_notification_read", "mark_all_my_notifications_read",
  "list_conversations", "get_conversation", "list_conversation_messages", "send_conversation_message",
  "get_service_post", "create_service_post", "request_service_post", "list_sent_join_requests",
  "list_received_join_requests", "withdraw_join_request", "decline_join_request", "propose_match", "accept_match", "get_match_consent",
]);
export function createUserClient(config: RuntimeConfig, principal: Principal, fetchImpl: FetchLike = fetch): RpcClient {
  return createRpcTransport(config, config.supabaseAnonKey, getPrincipalToken(principal), userRpcs, fetchImpl);
}
