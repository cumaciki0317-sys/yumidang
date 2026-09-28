/**
 * 종현: 요약 저장소 연결 계약. 구현은 민규의 권한·원자성 RPC를 주입한다.
 * 이 인터페이스만으로 실제 DB/RLS·트랜잭션 검증이 끝난 것은 아니다.
 */
export interface ReviewSummaryJob {
  jobId: string;
  leaseToken: string;
  targetUserId: string;
  sourceRevision: number;
}
export interface PublicTextReview { evidenceId: string; comment: string | null }
export interface ReviewSourceSnapshot {
  targetUserId: string;
  sourceRevision: number;
  /** DB가 회원 공개 자격을 확인한 집합. 당사자 released와 다르다. */
  publicTextReviews: PublicTextReview[];
}
export interface SummaryClaim { text: string; evidenceIds: string[] }
export interface SummaryNode {
  sourceReviewIds: string[];
  claims: SummaryClaim[];
  modelVersions: string[];
}
export interface SummaryCheckpoint {
  schemaVersion: 1;
  targetUserId: string;
  sourceRevision: number;
  promptVersion: string;
  /** 입력을 자르지 않고 모든 원문을 처리했는지 검증하는 전체 집합. */
  sourceReviewIds: string[];
  nextReviewIndex: number;
  nodes: SummaryNode[];
}
export type SummaryWriteResult =
  | "applied" | "lease_lost" | "stale_revision" | "insufficient_reviews" | "invalid_evidence";
export interface SummaryPublishInput extends ReviewSummaryJob {
  summaryText: string;
  claims: SummaryClaim[];
  sourceReviewIds: string[];
  sourceReviewCount: number;
  promptVersion: string;
  modelVersions: string[];
}
export interface ReviewSummaryRepository {
  /** 조회·모든 쓰기는 현재 점유 토큰과 revision을 확인한다. 원문은 일관된 snapshot. */
  loadSource(job: ReviewSummaryJob): Promise<ReviewSourceSnapshot | "lease_lost">;
  loadCheckpoint(job: ReviewSummaryJob): Promise<SummaryCheckpoint | null | "lease_lost">;
  /** private 저장, raw 원문 없음. 저장 시 token/revision/근거집합을 원자적으로 재확인. */
  saveCheckpoint(job: ReviewSummaryJob, checkpoint: SummaryCheckpoint): Promise<SummaryWriteResult>;
  /**
   * 게시와 checkpoint 삭제를 한 트랜잭션에서 수행. 현재 공개 전체집합과 정확히 일치해야 함.
   * 작업 settle은 별도 호출이므로 (jobId, sourceRevision)의 게시 효과는 멱등이어야 한다.
   * 게시 후 settle 전 중단되어 재실행해도 원래 게시 결과/시각을 다시 쓰거나 알림을 중복 생성하지 않는다.
   * 멱등 재호출도 현재 leaseToken/revision/공개 자격을 검사한 후 applied를 반환한다.
   */
  publish(input: SummaryPublishInput): Promise<SummaryWriteResult>;
  /** 3개 미만 상태와 checkpoint 삭제. DB가 실제 개수·revision·점유를 재확인. */
  markInsufficient(job: ReviewSummaryJob): Promise<SummaryWriteResult>;
  /** 현재 소유자만 해당 작업의 checkpoint를 삭제; 다른 revision의 새 작업에 영향 금지. */
  discardCheckpoint(job: ReviewSummaryJob): Promise<"applied" | "lease_lost">;
}
// 공개 집합 변경의 revision 증가 + 요약 무효화 + checkpoint 삭제 + enqueue는
// 원문 변경 DB 트랜잭션에 속한다. 이 포트로 순차 호출해 흉내 내지 않는다.
