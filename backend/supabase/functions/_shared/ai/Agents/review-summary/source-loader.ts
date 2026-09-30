import { isSourceRevision, isSummaryVersion } from "../../../db/repositories/review-summaries.ts";
import type { ReviewSummaryJob, ReviewSummaryRepository } from "../../../db/repositories/review-summaries.ts";
import { eligibleTextReviews } from "./eligibility.ts";

export function validateSummaryJob(job: ReviewSummaryJob): void {
  if (!job || ![job.jobId, job.leaseToken, job.targetUserId].every((v) => typeof v === "string" && v.trim()) ||
    !isSourceRevision(job.sourceRevision) || !isSummaryVersion(job.modelVersion) || !isSummaryVersion(job.promptVersion)) {
    throw new Error("INVALID_SUMMARY_JOB");
  }
}
export async function loadReviewSource(repo: ReviewSummaryRepository, job: ReviewSummaryJob) {
  validateSummaryJob(job);
  const source = await repo.loadSource(job);
  if (source === "lease_lost" || source === "already_published" || source === "stale_revision") return source;
  if (!source || source.targetUserId !== job.targetUserId || !isSourceRevision(source.sourceRevision) ||
    !Array.isArray(source.publicTextReviews)) throw new Error("INVALID_REVIEW_SOURCE");
  if (source.sourceRevision !== job.sourceRevision) return "stale_revision" as const;
  return { ...source, publicTextReviews: eligibleTextReviews(source.publicTextReviews) };
}
