/** 민규담당. 고정 RPC만 호출하며 사용자 ID·권한 판정은 DB에서 수행한다. */
import type { RpcClient } from "../transport.ts";
export const createRequest = (db: RpcClient, postId: string, messageId: string, message: string) => db.rpc("request_service_post", { p_post_id: postId, p_message_id: messageId, p_message: message });
export const listSentRequests = (db: RpcClient) => db.rpc("list_sent_join_requests", {});
export const listReceivedRequests = (db: RpcClient) => db.rpc("list_received_join_requests", {});
export const withdrawRequest = (db: RpcClient, id: string) => db.rpc("withdraw_join_request", { p_request_id: id });
export const declineRequest = (db: RpcClient, id: string) => db.rpc("decline_join_request", { p_request_id: id });
export const proposeMatch = (db: RpcClient, id: string) => db.rpc("propose_match", { p_request_id: id });
export const acceptMatch = (db: RpcClient, id: string, version: string) => db.rpc("accept_match", { p_request_id: id, p_condition_version: version });
export const getMatchConsent = (db: RpcClient, id: string) => db.rpc("get_match_consent", { p_request_id: id });
export const withdrawMatchConsent = (db: RpcClient, id: string, version: string) => db.rpc("withdraw_match_consent", { p_request_id: id, p_condition_version: version });
export const declineMatchConsent = (db: RpcClient, id: string, version: string) => db.rpc("decline_match_consent", { p_request_id: id, p_condition_version: version });
/** 별도 내부 인증 클라이언트만 이 RPC를 허용한다. */
export const expireMatchConsents = (db: RpcClient, limit: number) => db.rpc("expire_match_consents", { p_limit: limit });
