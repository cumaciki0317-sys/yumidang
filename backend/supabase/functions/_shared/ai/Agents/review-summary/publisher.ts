import type { ReviewSummaryRepository, SummaryPublishInput } from "../../../db/repositories/review-summaries.ts";
import { MIN_PUBLIC_TEXT_REVIEWS } from "./eligibility.ts";
import { checkEvidence, sameEvidence } from "./evidence-check.ts";
import { validateSummaryJob } from "./source-loader.ts";

export async function publishSummary(repo: ReviewSummaryRepository, input: SummaryPublishInput, expectedIds: string[]) {
  validateSummaryJob(input);
  if (input.sourceReviewCount < MIN_PUBLIC_TEXT_REVIEWS || input.sourceReviewCount !== expectedIds.length ||
      !sameEvidence(input.sourceReviewIds, expectedIds) || !input.promptVersion ||
      !input.modelVersions.length || input.modelVersions.some((v) => typeof v !== "string" || !v.trim()) ||
      input.summaryText !== input.claims.map((claim) => claim.text).join(" ")) throw new Error("INVALID_SUMMARY_PUBLICATION");
  checkEvidence(input.claims, expectedIds);
  return repo.publish(input); // DB가 token/revision/현재 공개 집합을 원자적으로 재검사한다.
}
