/** 민규담당. 공개 공고 검색·상세·행사 후보 조회만 허용하며 익명 키를 사용한다. */
import type { RuntimeConfig } from "../config/env.ts";
import { createRpcTransport, type FetchLike, type RpcClient } from "./transport.ts";

const publicRpcs = new Set(["search_public_posts_v2", "get_service_post", "list_event_candidates_v1", "get_public_event", "get_public_event_ranking_state", "list_public_events", "list_event_filter_values"]);

export function createPublicClient(config: RuntimeConfig, fetchImpl: FetchLike = fetch): RpcClient {
  return createRpcTransport(config, config.supabaseAnonKey, config.supabaseAnonKey, publicRpcs, fetchImpl);
}
