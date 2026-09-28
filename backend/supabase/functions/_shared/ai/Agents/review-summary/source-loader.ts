import type { ReviewSummaryJob, ReviewSummaryRepository } from "../../../db/repositories/review-summaries.ts";
import { eligibleTextReviews } from "./eligibility.ts";

export function validateSummaryJob(job: ReviewSummaryJob): void {
  if (!job || ![job.jobId, job.leaseToken, job.targetUserId].every((v) => typeof v === "string" && v.trim()) ||
      !Number.isSafeInteger(job.sourceRevision) || job.sourceRevision < 0) throw new Error("INVALID_SUMMARY_JOB");
}
export async function loadReviewSource(repo: ReviewSummaryRepository, job: ReviewSummaryJob) {
  validateSummaryJob(job);
  const source = await repo.loadSource(job);
  if (source === "lease_lost") return source;
  if (source.targetUserId !== job.targetUserId || !Number.isSafeInteger(source.sourceRevision) ||
      source.sourceRevision < 0 || !Array.isArray(source.publicTextReviews)) throw new Error("INVALID_REVIEW_SOURCE");
  if (source.sourceRevision !== job.sourceRevision) return "stale_revision" as const;
  return { ...source, publicTextReviews: eligibleTextReviews(source.publicTextReviews) };
}
