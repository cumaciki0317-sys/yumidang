/** 민규담당. 고정 RPC만 호출하며 사용자 ID·권한 판정은 DB에서 수행한다. */
import type { RpcClient } from "../transport.ts";
import type { ReviewSubmission } from "../../contracts/reviews.ts";
export const getReviewState = (db: RpcClient, id: string) => db.rpc("get_appointment_review_state", { p_appointment_id: id });
export const submitReview = (db: RpcClient, id: string, review: ReviewSubmission) => db.rpc("submit_appointment_review", { p_appointment_id: id, p_rating: review.rating, p_comment: review.comment, p_experience: review.experience, p_praises: review.praises });
export const getPublicReviews = (db: RpcClient, id: string, limit: number, before: string | null) => db.rpc("get_public_profile_reviews", { p_profile_id: id, p_limit: limit, p_before: before });
export const processDueReviewPublications = (db: RpcClient, limit: number) => db.rpc("process_due_review_publications", { p_limit: limit });
export const processReviewSummaryRefresh = (db: RpcClient, limit: number, modelVersion: string, promptVersion: string) => db.rpc("process_review_summary_refresh", { p_limit: limit, p_model_version: modelVersion, p_prompt_version: promptVersion });
