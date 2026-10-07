import type { ClaimedJob, JobRepository, JobKind, JobSettlement } from "../db/repositories/jobs.ts";
import type { JobRegistry, JobHandlerResult, JobStopReason } from "./registry.ts";
import { normalizeJobReference, validInstant } from "./enqueue.ts";
import { decideRetry, validateRetrySettings, JobExecutionError, JobExecutionUnknown, isJobExecutionUnknown } from "./retry.ts";
import { toPublicError } from "../http/errors.ts";
import type { RetrySettings } from "./retry.ts";

const kinds: JobKind[] = ["review_summary", "event_sync", "auto_complete", "review_release", "cancellation_safety", "report_retention"];
export interface JobRunnerSettings { leaseDurationMs: number; retry: RetrySettings }
/** reason은 handler가 알린 정형 중단 사유(예: 예산 소진)이며 settle 결과와 함께 반환한다. */
export type JobRunResult = {
  status: "held" | "idle" | "lease_lost" | "succeeded" | "queued" | "retry_wait" | "failed" | "superseded";
  jobId?: string;
  reason?: JobStopReason;
};

function settlementFor(result: JobHandlerResult, now: Date): Pick<JobSettlement, "status" | "retryAt"> {
  switch (result?.status) {
    case "succeeded": case "superseded": return { status: result.status };
    case "yielded": return { status: "queued" };
    case "deferred":
      if (validInstant(result.retryAt) && Date.parse(result.retryAt) > now.getTime()) return { status: "queued", retryAt: new Date(result.retryAt).toISOString() };
  }
  throw new JobExecutionError("HANDLER_FAILED", false);
}

/** 실행 한 번에 작업 하나. Cron/HTTP 인증은 공통 계층에서 연결해야 한다. */
export async function runNextJob(input: {
  workerId: string; repository: JobRepository; registry: JobRegistry; settings: JobRunnerSettings; now: () => Date;
}): Promise<JobRunResult> {
  const { repository, registry, settings } = input;
  validateRetrySettings(settings.retry);
  if (!input.workerId?.trim() || !Number.isSafeInteger(settings.leaseDurationMs) || settings.leaseDurationMs < 1) throw new Error("INVALID_RUNNER_SETTINGS");
  const enabled = Object.keys(registry).filter((key): key is JobKind => kinds.includes(key as JobKind) && typeof registry[key as JobKind] === "function");
  if (!enabled.length) return { status: "idle" };
  let job: ClaimedJob | null;
  try {
    job = await repository.claim({ workerId: input.workerId, kinds: enabled, leaseDurationMs: settings.leaseDurationMs });
  } catch (error) {
    if (isJobExecutionUnknown(error)) throw error;
    throw new JobExecutionError("DEPENDENCY_UNAVAILABLE", true);
  }
  if (!job) return { status: "idle" };
  if (!job.jobId?.trim() || !job.leaseToken?.trim() || !validInstant(job.leaseUntil) ||
      !Number.isSafeInteger(job.failedAttempts) || job.failedAttempts < 0) throw new Error("INVALID_JOB_CLAIM");
  const now = input.now();
  if (!Number.isFinite(now.getTime())) throw new Error("INVALID_RUNNER_CLOCK");
  if (Date.parse(job.leaseUntil) <= now.getTime()) return { status: "lease_lost", jobId: job.jobId };
  let transition: Pick<JobSettlement, "status" | "retryAt" | "errorCode">;
  let reason: JobStopReason | undefined;
  try {
    const reference = normalizeJobReference(job.reference);
    const handler = registry[reference.kind];
    if (!enabled.includes(reference.kind) || typeof handler !== "function") throw new JobExecutionError("INVALID_JOB", false);
    const handled = await handler({
      jobId: job.jobId, leaseToken: job.leaseToken, leaseUntil: job.leaseUntil,
      failedAttempts: job.failedAttempts, reference,
    });
    if (handled?.status === "lease_lost") return { status: "lease_lost", jobId: job.jobId };
    if (handled?.status === "completed_by_handler") return { status: "succeeded", jobId: job.jobId };
    if (handled?.status === "held") return { status: "held", jobId: job.jobId };
    transition = settlementFor(handled, input.now());
    if ((handled.status === "yielded" || handled.status === "deferred") && handled.reason === "budget_exhausted") reason = handled.reason;
  } catch (error) {
    if (isJobExecutionUnknown(error)) throw error;
    if (job.reference.kind === "cancellation_safety" || job.reference.kind === "report_retention") {
      if (toPublicError(error).error.code === "STATE_CONFLICT") return { status: "lease_lost", jobId: job.jobId };
      throw new JobExecutionUnknown("process");
    }
    transition = decideRetry({ failedAttempts: job.failedAttempts, now: input.now(), error, settings: settings.retry });
  }
  let written: "applied" | "lease_lost";
  try {
    written = await repository.settle({ jobId: job.jobId, leaseToken: job.leaseToken, ...transition });
  } catch {
    if (job.reference.kind === "cancellation_safety" || job.reference.kind === "report_retention") throw new JobExecutionUnknown("complete");
    throw new JobExecutionError("DEPENDENCY_UNAVAILABLE", true);
  }
  if (written === "lease_lost") return { status: "lease_lost", jobId: job.jobId };
  return reason ? { status: transition.status, jobId: job.jobId, reason } : { status: transition.status, jobId: job.jobId };
}
