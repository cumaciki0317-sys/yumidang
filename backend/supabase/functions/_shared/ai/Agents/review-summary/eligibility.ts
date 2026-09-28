import type { PublicTextReview } from "../../../db/repositories/review-summaries.ts";

export const MIN_PUBLIC_TEXT_REVIEWS = 3;
/** 입력의 공개 자격은 DB 계약이 보장한다. 여기서는 공백/평가만 있는 행을 제외한다. */
export function eligibleTextReviews(reviews: readonly PublicTextReview[]): PublicTextReview[] {
  const seen = new Set<string>();
  const eligible: PublicTextReview[] = [];
  for (const review of reviews) {
    if (!review || typeof review.evidenceId !== "string" || !review.evidenceId.trim() ||
        (review.comment !== null && typeof review.comment !== "string")) {
      throw new Error("INVALID_REVIEW_SOURCE");
    }
    if (seen.has(review.evidenceId)) throw new Error("DUPLICATE_REVIEW_SOURCE");
    seen.add(review.evidenceId);
    if (review.comment?.trim()) eligible.push({ evidenceId: review.evidenceId, comment: review.comment.trim() });
  }
  return eligible.sort((a, b) => a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0);
}
