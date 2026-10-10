/** 민규담당: 승인된 내부 RPC만 제공. 요청 헤더/사용자 ID로 서비스 역할을 선택하지 않는다. */
import { requireInternalConfig, type RuntimeConfig } from "../config/env.ts";
import { createRpcTransport, type FetchLike, type RpcClient } from "./transport.ts";
// 최신 AI 원자 RPC는 실제 SQL 검증을 거쳤다. SQL111·112 행사 기본 8개 RPC는 격리 DB 검증을 거쳤으며 실제 제어·권한은 기본 닫힘이다.
// supportsRpc는 이 목록만 반영하며 이름이 요청됐다는 이유로 능력을 선언하지 않는다.
const internalRpcs = new Set([
  // SQL118 최소 UNKNOWN 회원 부모 조회. 발견은 실행 허가가 아니며 실제 EXEC/guard는 기본 닫힘이다.
  "read_member_cleanup_unknown_invocations",
  "purge_worker_runtime_details_scoped", "prepare_queue_invocation", "claim_queue_invocation_dispatch", "get_queue_invocation", "complete_queue_invocation", "mark_queue_invocation_unknown",
  // SQL101 전송 목록만 허용. EXECUTE·journal 제어는 기본 닫힘이다.
  "prepare_worker_runtime_intent", "observe_worker_runtime_intent", "read_worker_runtime_pending", "get_worker_runtime_intent",
  // SQL114 격리 DB 검증: 원 invocation에 묶인 실행·확정만 전송한다. 실제 제어와 EXECUTE는 기본 닫힘이다.
  "prepare_worker_invocation_intent", "execute_worker_invocation_operation", "confirm_worker_runtime_intent",
  // SQL116 발급 전송. 검사 제어·issuer EXEC는 기본 닫힘이며 실제 승인 조립에서만 사용한다.
  "issue_content_inspection_ticket",
  "read_worker_runtime_pending_v2", "read_worker_runtime_maintenance_schedule", "read_ai_feedback_maintenance_schedule", "purge_ai_feedback_scoped",
  "record_ai_chat_result_available", "get_ai_feedback_readiness", "submit_ai_feedback", "purge_expired_ai_feedback",
  "reserve_ai_chat_account_model", "reserve_review_summary_account_model", "settle_ai_account_budget",
  // 공식 순위 완료는 공급사 근거가 보류되어 계속 제외한다.
  "read_event_collection_contract", "register_event_collection_jobs", "claim_event_collection", "commit_event_collection_page",
  "store_event_source_detail", "next_event_collection_reference", "list_ongoing_event_source_ids", "settle_event_collection",
  "upsert_source_events_v1", "list_event_candidates_v1",
  "enqueue_job", "claim_job", "complete_job", "retry_job",
  "execute_worker_runtime_operation", "get_worker_runtime_operation", "read_worker_runtime_slots", "read_worker_runtime_recovery", "read_worker_runtime_retention_schedule", "purge_worker_runtime_details",
  "acquire_worker_run", "release_worker_run", "read_worker_run_budget",
  // 전송 허용만 선언한다. 실제 DB execute 권한·due guard·dispatcher 연결은 별도이며 아직 닫혀 있다.
  "enqueue_cancellation_safety_due", "process_cancellation_safety_due",
  // 전송 목록만 추가한다. 실제 report guard/execute·예약·dispatcher 준비를 의미하지 않는다.
  "enqueue_report_retention_purges", "claim_report_retention_task", "check_report_retention_task",
  "get_report_retention_delete_ack", "record_report_retention_delete_ack", "complete_report_retention_task",
  "purge_report_retention_terminal_receipts", "claim_supported_job", "begin_report_retention_delete",
  "set_review_publication",
  "set_post_search_location", "expire_match_consents", "process_due_review_publications", "process_review_summary_refresh",
  "expire_appointment_changes",
  "acquire_ai_chat_request", "finish_ai_chat_request", "reserve_ai_chat_model", "reserve_review_summary_model",
  "settle_ai_budget", "yield_job", "fail_job", "supersede_job",
  "load_review_summary_source", "load_review_summary_checkpoint", "save_review_summary_checkpoint", "discard_review_summary_checkpoint",
  "mark_review_summary_insufficient", "publish_review_summary_for_job", "upsert_events",
  "store_kopis_top10_snapshot", "get_kopis_top10_snapshot",
]);
/** HTTP 호출부는 requireInternalCaller 성공 뒤에만 생성한다. 내부 워커도 같은 제한을 받는다. */
export function createInternalClient(config: RuntimeConfig, fetchImpl: FetchLike = fetch): RpcClient {
  const { serviceKey } = requireInternalConfig(config);
  return createRpcTransport(config, serviceKey, serviceKey, internalRpcs, fetchImpl);
}
