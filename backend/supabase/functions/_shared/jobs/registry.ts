import type { ClaimedJob, JobKind } from "../db/repositories/jobs.ts";
import { runReviewSummaryStep } from "../ai/Agents/review-summary/orchestrator.ts";
import type { ReviewSummaryDependencies } from "../ai/Agents/review-summary/orchestrator.ts";
import { JobExecutionError } from "./retry.ts";

export type JobHandlerResult =
  | { status: "succeeded" | "yielded" | "superseded" | "lease_lost" }
  | { status: "deferred"; retryAt: string };
export type JobHandler = (job: ClaimedJob) => Promise<JobHandlerResult>;
export type JobRegistry = Readonly<Partial<Record<JobKind, JobHandler>>>;

export interface CommonScheduledRpc {
  /** 원자적으로 lease/시간/상태 확인. completedAt은 DB 실제 성공시각, expectedDueAt과 구분. */
  autoComplete(input: { appointmentId: string; expectedDueAt: string; jobId: string; leaseToken: string }): Promise<JobHandlerResult>;
  /** notification availableAt/분쟁/공개 자격은 RPC가 판단. 워커가 날짜 정책을 복제하지 않는다. */
  releaseReviews(input: { appointmentId: string; expectedDueAt: string; jobId: string; leaseToken: string }): Promise<JobHandlerResult>;
}
/** 기존4종 작업의 순수/가상 호환 코어. 현재 실제 DB 실행 등록에 사용하지 않는다. */
export function createJobRegistry(deps: {
  reviewSummary: JobHandler;
  eventSync: JobHandler;
  common: CommonScheduledRpc;
}): JobRegistry {
  return Object.freeze({
    review_summary: deps.reviewSummary,
    event_sync: deps.eventSync,
    auto_complete: async (job: ClaimedJob) => {
      if (job.reference.kind !== "auto_complete") throw new Error("INVALID_JOB_REFERENCE");
      return deps.common.autoComplete({
        appointmentId: job.reference.appointmentId, expectedDueAt: job.reference.expectedDueAt,
        jobId: job.jobId, leaseToken: job.leaseToken,
      });
    },
    review_release: async (job: ClaimedJob) => {
      if (job.reference.kind !== "review_release") throw new Error("INVALID_JOB_REFERENCE");
      return deps.common.releaseReviews({
        appointmentId: job.reference.appointmentId, expectedDueAt: job.reference.expectedDueAt,
        jobId: job.jobId, leaseToken: job.leaseToken,
      });
    },
  });
}

/** 실제 연결 준비용 등록 범위. 완료·후기 공개는 별도 maintenance HTTP 경로가 처리한다. */
export function createReviewSummaryRegistry(deps: ReviewSummaryDependencies): JobRegistry {
  return Object.freeze({ review_summary: createReviewSummaryHandler(deps) });
}

/** 분할 요약 결과를 공통 작업 실행기 상태로 연결한다. 실제 HTTP/DB 연결은 포함하지 않는다. */
export function createReviewSummaryHandler(deps: ReviewSummaryDependencies): JobHandler {
  return async (job) => {
    if (job.reference.kind !== "review_summary") throw new JobExecutionError("INVALID_JOB", false);
    const result = await runReviewSummaryStep({
      jobId: job.jobId, leaseToken: job.leaseToken,
      targetUserId: job.reference.targetUserId, sourceRevision: job.reference.sourceRevision,
      modelVersion: job.reference.modelVersion, promptVersion: job.reference.promptVersion,
    }, deps);
    switch (result.status) {
      case "published": case "insufficient_reviews": return { status: "succeeded" };
      case "yielded": case "superseded": case "lease_lost": return { status: result.status };
      case "unavailable":
        throw new JobExecutionError(result.code === "MODEL_UNAVAILABLE" ? "MODEL_UNAVAILABLE" : "DEPENDENCY_UNAVAILABLE", true);
      case "failed": throw new JobExecutionError("HANDLER_FAILED", false);
    }
  };
}
