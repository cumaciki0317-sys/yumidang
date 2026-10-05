/** 민규담당. 고정 RPC만 호출하며 사용자 ID·권한 판정은 DB에서 수행한다. */
import type { ProfilePreferences } from "../../contracts/signup.ts";
import type { RpcClient } from "../transport.ts";
export const getOwnProfile = (db: RpcClient) => db.rpc("get_my_profile", {});
export const getPublicProfile = (db: RpcClient, id: string) => db.rpc("get_public_profile", { p_profile_id: id });
export const setProfileAvatar = (db: RpcClient, path: string) => db.rpc("set_my_profile_avatar", { p_avatar_path: path });

export const blockMember = (db: RpcClient, id: string) => db.rpc("block_member", { p_target_id: id });
export const unblockMember = (db: RpcClient, id: string) => db.rpc("unblock_member", { p_target_id: id });
export const listMyBlocks = (db: RpcClient, limit: number, before: string | null) => db.rpc("list_my_blocks", { p_limit: limit, p_before: before });

export const setProfilePreferences = (db: RpcClient, input: ProfilePreferences) => db.rpc("set_my_profile_preferences", {
  p_interests: input.interests, p_conversation_styles: input.conversationStyles, p_mbti: input.mbti, p_bio: input.bio,
});
