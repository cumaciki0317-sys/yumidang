/** 민규담당. 공개 검색만 허용하며 익명 키 외의 사용자·서비스 자격 증명을 사용하지 않는다. */
import type { RuntimeConfig } from "../config/env.ts";
import { createRpcTransport, type FetchLike, type RpcClient } from "./transport.ts";

const publicRpcs = new Set(["search_public_posts_v2"]);

export function createPublicClient(config: RuntimeConfig, fetchImpl: FetchLike = fetch): RpcClient {
  return createRpcTransport(config, config.supabaseAnonKey, config.supabaseAnonKey, publicRpcs, fetchImpl);
}
