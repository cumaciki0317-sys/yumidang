import type { ClaimedJob, JobRepository, JobKind, JobSettlement } from "../db/repositories/jobs.ts";
import type { JobRegistry, JobHandlerResult } from "./registry.ts";
import { normalizeJobReference, validInstant } from "./enqueue.ts";
import { decideRetry, validateRetrySettings, JobExecutionError } from "./retry.ts";
import type { RetrySettings } from "./retry.ts";

const kinds: JobKind[] = ["review_summary", "event_sync", "auto_complete", "review_release"];
export interface JobRunnerSettings { leaseDurationMs: number; retry: RetrySettings }
export type JobRunResult = { status: "idle" | "lease_lost" | "succeeded" | "queued" | "retry_wait" | "failed" | "superseded"; jobId?: string };

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
  } catch {
    throw new JobExecutionError("DEPENDENCY_UNAVAILABLE", true);
  }
  if (!job) return { status: "idle" };
  if (!job.jobId?.trim() || !job.leaseToken?.trim() || !validInstant(job.leaseUntil) ||
      !Number.isSafeInteger(job.failedAttempts) || job.failedAttempts < 0) throw new Error("INVALID_JOB_CLAIM");
  const now = input.now();
  if (!Number.isFinite(now.getTime())) throw new Error("INVALID_RUNNER_CLOCK");
  if (Date.parse(job.leaseUntil) <= now.getTime()) return { status: "lease_lost", jobId: job.jobId };
  let transition: Pick<JobSettlement, "status" | "retryAt" | "errorCode">;
  try {
    const reference = normalizeJobReference(job.reference);
    const handler = registry[reference.kind];
    if (!enabled.includes(reference.kind) || typeof handler !== "function") throw new JobExecutionError("INVALID_JOB", false);
    const handled = await handler({
      jobId: job.jobId, leaseToken: job.leaseToken, leaseUntil: job.leaseUntil,
      failedAttempts: job.failedAttempts, reference,
    });
    if (handled?.status === "lease_lost") return { status: "lease_lost", jobId: job.jobId };
    transition = settlementFor(handled, input.now());
  } catch (error) {
    transition = decideRetry({ failedAttempts: job.failedAttempts, now: input.now(), error, settings: settings.retry });
  }
  let written: "applied" | "lease_lost";
  try {
    written = await repository.settle({ jobId: job.jobId, leaseToken: job.leaseToken, ...transition });
  } catch {
    throw new JobExecutionError("DEPENDENCY_UNAVAILABLE", true);
  }
  return { status: written === "lease_lost" ? "lease_lost" : transition.status, jobId: job.jobId };
}
