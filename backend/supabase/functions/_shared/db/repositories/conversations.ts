/** 민규담당. 고정 RPC만 호출하며 사용자 ID·권한 판정은 DB에서 수행한다. */
import type { RpcClient } from "../transport.ts";
export const listConversations = (db: RpcClient) => db.rpc("list_conversations_with_read_state", {});
export const getConversation = (db: RpcClient, id: string) => db.rpc("get_conversation_with_read_state", { p_request_id: id });
export const leaveConversation = (db: RpcClient, id: string) => db.rpc("leave_conversation", { p_request_id: id });
export const listMessages = (db: RpcClient, id: string, limit: number, before: string | null) => db.rpc("list_conversation_messages", { p_request_id: id, p_limit: limit, p_before: before });
export const sendMessage = (db: RpcClient, id: string, messageId: string, content: string) => db.rpc("send_conversation_message", { p_request_id: id, p_message_id: messageId, p_content: content });

export const markConversationRead = (db: RpcClient, id: string, messageId: string) => db.rpc("mark_conversation_read", { p_request_id: id, p_last_read_message_id: messageId });

export const markConversationMessagesRead = (db: RpcClient, id: string, messageIds: string[]) => db.rpc("mark_conversation_messages_read", { p_request_id: id, p_message_ids: messageIds });
