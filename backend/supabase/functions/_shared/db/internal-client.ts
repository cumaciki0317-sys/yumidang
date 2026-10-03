/** 민규담당: 승인된 내부 RPC만 제공. 요청 헤더/사용자 ID로 서비스 역할을 선택하지 않는다. */
import { requireInternalConfig, type RuntimeConfig } from "../config/env.ts";
import { createRpcTransport, type FetchLike, type RpcClient } from "./transport.ts";
const internalRpcs = new Set([
  "upsert_source_events_v1", "list_event_candidates_v1",
  "enqueue_job", "claim_job", "complete_job", "retry_job",
  "load_public_review_snapshot", "publish_review_summary", "set_review_publication",
  "set_post_search_location", "expire_match_consents", "process_due_review_publications", "process_review_summary_refresh",
  "expire_appointment_changes",
  "reserve_ai_budget", "settle_ai_budget", "yield_job", "fail_job", "supersede_job",
  "load_review_summary_source", "load_review_summary_checkpoint", "save_review_summary_checkpoint", "discard_review_summary_checkpoint",
  "mark_review_summary_insufficient", "publish_review_summary_for_job", "upsert_events",
  "store_kopis_top10_snapshot", "get_kopis_top10_snapshot",
]);
/** HTTP 호출부는 requireInternalCaller 성공 뒤에만 생성한다. 내부 워커도 같은 제한을 받는다. */
export function createInternalClient(config: RuntimeConfig, fetchImpl: FetchLike = fetch): RpcClient {
  const { serviceKey } = requireInternalConfig(config);
  return createRpcTransport(config, serviceKey, serviceKey, internalRpcs, fetchImpl);
}
