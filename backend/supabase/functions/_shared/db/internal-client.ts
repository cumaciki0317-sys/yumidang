/** 민규담당: 승인된 내부 RPC만 제공. 요청 헤더/사용자 ID로 서비스 역할을 선택하지 않는다. */
import { requireInternalConfig, type RuntimeConfig } from "../config/env.ts";
import { createRpcTransport, type FetchLike, type RpcClient } from "./transport.ts";
const internalRpcs = new Set([
  "enqueue_job", "claim_job", "complete_job", "retry_job",
  "load_public_review_snapshot", "publish_review_summary", "set_review_publication",
  "set_post_search_location", "process_due_review_publications", "process_review_summary_refresh",
]);
/** HTTP 호출부는 requireInternalCaller 성공 뒤에만 생성한다. 내부 워커도 같은 제한을 받는다. */
export function createInternalClient(config: RuntimeConfig, fetchImpl: FetchLike = fetch): RpcClient {
  const { serviceKey } = requireInternalConfig(config);
  return createRpcTransport(config, serviceKey, serviceKey, internalRpcs, fetchImpl);
}
