/** 민규담당. 고정 RPC만 호출하며 사용자 ID·권한 판정은 DB에서 수행한다. */
import { HttpError } from "../../http/errors.ts";
import type { RpcClient } from "../transport.ts";
import type { ReviewSubmission } from "../../contracts/reviews.ts";
export const getReviewState = (db: RpcClient, id: string) => db.rpc("get_appointment_review_state", { p_appointment_id: id });
export const getPraiseCatalog = (db: RpcClient) => db.rpc("get_review_praise_catalog", {});
export const submitReview = (db: RpcClient, id: string, review: ReviewSubmission) => db.rpc("submit_appointment_review", { p_appointment_id: id, p_rating: review.rating, p_comment: review.comment, p_experience: review.experience, p_praises: review.praises });
export const getPublicReviews = (db: RpcClient, id: string, limit: number, before: string | null) => db.rpc("get_public_profile_reviews", { p_profile_id: id, p_limit: limit, p_before: before });
export const processDueReviewPublications = (db: RpcClient, limit: number) => db.rpc("process_due_review_publications", { p_limit: limit });
export const processReviewSummaryRefresh = (db: RpcClient, limit: number, modelVersion: string, promptVersion: string) => db.rpc("process_review_summary_refresh", { p_limit: limit, p_model_version: modelVersion, p_prompt_version: promptVersion });

/** 현재 공개 revision만 반환한다. 근거 ID·원문·작업/운영자 정보는 공개하지 않는다. */
export async function getVisibleSummary(db: RpcClient,id:string) {
 const value=await db.rpc("get_visible_review_summary",{p_profile_id:id});
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==1||!Object.hasOwn(value,"summary"))throw new HttpError("EXTERNAL_UNAVAILABLE");
 const v=value.summary;
 if(v===null)return value;
 if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==4||["summaryId","text","sourceCount","updatedAt"].some(k=>!Object.hasOwn(v,k))||typeof v.summaryId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.summaryId)||typeof v.text!=="string"||v.text.trim().length<1||[...v.text].length>300||typeof v.sourceCount!=="number"||!Number.isSafeInteger(v.sourceCount)||v.sourceCount<3||typeof v.updatedAt!=="string"||!/^\d{4}-\d{2}-\d{2}T/.test(v.updatedAt)||!Number.isFinite(Date.parse(v.updatedAt)))throw new HttpError("EXTERNAL_UNAVAILABLE");
 return value;
}
