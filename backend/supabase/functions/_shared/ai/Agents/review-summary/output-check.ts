import type { SummaryClaim, PublicTextReview } from "../../../db/repositories/review-summaries.ts";
import { checkEvidence } from "./evidence-check.ts";

/** 실제 원문 의미/개인정보/과장 검사 구현을 별도 주입. false이면 게시하지 않는다. */
export interface SummarySafetyPort {
  check(input: { claims: SummaryClaim[]; publicTextReviews: PublicTextReview[] }): Promise<boolean>;
}
export function checkSummaryOutput(value: unknown, expectedIds: string[], maxOutputChars: number): SummaryClaim[] {
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1) throw new Error("INVALID_SUMMARY_SETTINGS");
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "claims")) throw new Error("INVALID_SUMMARY_OUTPUT");
  const raw = (value as { claims?: unknown }).claims;
  if (!Array.isArray(raw) || !raw.length) throw new Error("INVALID_SUMMARY_OUTPUT");
  const claims = raw.map((item): SummaryClaim => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).some((key) => key !== "text" && key !== "evidenceIds") ||
        typeof item.text !== "string" || !item.text.trim() || !Array.isArray(item.evidenceIds) ||
        !item.evidenceIds.every((id: unknown) => typeof id === "string" && id.length > 0)) {
      throw new Error("INVALID_SUMMARY_OUTPUT");
    }
    return { text: item.text.trim(), evidenceIds: [...item.evidenceIds] };
  });
  const text = claims.map((claim) => claim.text).join(" ");
  if ([...text].length > Math.min(maxOutputChars, 300)) throw new Error("SUMMARY_OUTPUT_TOO_LARGE");
  // 명백한 연락처·안전 보장만 방어적으로 검사. 이것만으로 개인정보/의미 검증을 통과시키지 않는다.
  if (/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u.test(text) ||
      /(?:\+82[-\s]?)?0?1[016789][-\s]?\d{3,4}[-\s]?\d{4}/u.test(text) ||
      /(?:100\s*%|절대적으로|무조건)\s*(?:안전|신뢰)/u.test(text)) throw new Error("UNSAFE_SUMMARY_OUTPUT");
  checkEvidence(claims, expectedIds);
  return claims;
}

/**
 * A안: 각 주장이 인용한 모든 공개 후기의 전체 문장과 정확히 같아야 한다.
 * 부분 문자열은 부정·조건을 지울 수 있으므로 허용하지 않는다. 개인정보는 별도 승인 검사로 확인한다.
 */
export function createConservativeSummarySafety(privacy: import("../../providers/privacy.ts").ApprovedPrivacyCheck): SummarySafetyPort {
  return { async check({ claims, publicTextReviews }) {
    try {
      const { assertPrivacy } = await import("../../providers/privacy.ts");
      // 별도 async 검사기가 원본 객체를 변경해도 검증한 주장 snapshot만 판단한다.
      checkSummaryOutput({ claims }, publicTextReviews.map(review => review.evidenceId), 300);
      const sourceSnapshot = publicTextReviews.map(review => ({ evidenceId: review.evidenceId, comment: review.comment }));
      const snapshot = claims.map(claim => ({ text: claim.text, evidenceIds: [...claim.evidenceIds] }));
      checkSummaryOutput({ claims: snapshot }, publicTextReviews.map(review => review.evidenceId), 300);
      const sources = new Map(sourceSnapshot.map(review => [review.evidenceId, review.comment]));
      if (sources.size !== publicTextReviews.length) return false;
      const used = new Set<string>();
      for (const claim of snapshot) {
        if (claim.evidenceIds.some(id => used.has(id))) return false;
        claim.evidenceIds.forEach(id => used.add(id));
        if (!claim.evidenceIds.every(id => typeof sources.get(id) === "string" && sources.get(id) === claim.text)) return false;
        await assertPrivacy(claim.text, privacy, "output");
      }
      // 검사 도중 원본을 바꾸면 이 결과로 게시하지 않는다.
      return JSON.stringify(snapshot) === JSON.stringify(claims) &&
        JSON.stringify(sourceSnapshot) === JSON.stringify(publicTextReviews);
    } catch { return false; }
  } };
}
