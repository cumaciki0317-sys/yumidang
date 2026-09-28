/** 종현 작업 저장소 포트. 모든 시간·점유·멱등성의 원자적 판정은 실제 DB RPC 책임이다. */
export type JobReference =
  | { kind: "review_summary"; targetUserId: string; sourceRevision: number }
  | { kind: "event_sync"; provider: string; windowStart: string; windowEnd: string }
  | { kind: "auto_complete"; appointmentId: string; expectedDueAt: string }
  | { kind: "review_release"; appointmentId: string; expectedDueAt: string };
export type JobKind = JobReference["kind"];
export interface EnqueuedJob {
  reference: JobReference;
  idempotencyKey: string;
  runAt: string;
}
export interface ClaimedJob {
  jobId: string;
  leaseToken: string;
  leaseUntil: string;
  reference: JobReference;
  /** 이전 실패 횟수. 정상 분할 실행(yielded)은 이 횟수를 증가시키지 않는다. */
  failedAttempts: number;
}
export interface JobSettlement {
  jobId: string;
  leaseToken: string;
  status: "succeeded" | "queued" | "retry_wait" | "failed" | "superseded";
  retryAt?: string;
  errorCode?: string;
}
export interface JobRepository {
  /** 별도 수동/예약 등록용. 원문 변경에 따른 enqueue는 원문 DB 트랜잭션 안에서 해야 한다. */
  enqueue(input: EnqueuedJob): Promise<{ jobId: string; created: boolean }>;
  /** DB 시계 기준 due/점유 만료 검사 + 현재 토큰 발급을 원자적으로 처리한다. */
  claim(input: { workerId: string; kinds: JobKind[]; leaseDurationMs: number }): Promise<ClaimedJob | null>;
  /**
   * token/만료 재확인 후 전이. retry_wait/failed는 실패 횟수 증가; queued는 증가하지 않는다.
   * failed/superseded 종결 시 해당 요약 작업의 checkpoint도 원자적으로 폐기한다.
   */
  settle(input: JobSettlement): Promise<"applied" | "lease_lost">;
}
