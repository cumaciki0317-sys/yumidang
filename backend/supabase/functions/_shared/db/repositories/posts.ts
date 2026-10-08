/** 민규담당. 분리된 검색 주소·만남 상세를 공통 RPC로 전달한다. */
import type { RpcClient } from "../transport.ts";
import type { FreePostInput } from "../../contracts/posts.ts";
export const getPost = (db: RpcClient, id: string) => db.rpc("get_service_post", { p_post_id: id });
export const createPost = (db: RpcClient, id: string, input: FreePostInput) => db.rpc("create_service_post", { p_post_id: id, p_input: { ...input } });
export const updatePost = (db: RpcClient, id: string, input: FreePostInput, expectedUpdatedAt: string) => db.rpc("update_service_post", { p_post_id: id, p_input: { ...input }, p_expected_updated_at: expectedUpdatedAt });
export const closePost = (db: RpcClient, id: string) => db.rpc("close_service_post", { p_post_id: id });
export const deletePost = (db: RpcClient, id: string) => db.rpc("delete_service_post", { p_post_id: id });

/** 취소 처리와 모집 재개는 독립 요청이다. */
export const reopenPost = (db: RpcClient, id: string) => db.rpc("reopen_service_post", { p_post_id: id });

export const listMyPosts = (db: RpcClient, limit: number, before: string | null) => db.rpc("list_my_service_posts", { p_limit: limit, p_before: before });
