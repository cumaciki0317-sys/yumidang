import type { SummaryClaim } from "../../../db/repositories/review-summaries.ts";

export function sameEvidence(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length &&
    new Set(expected).size === expected.length && actual.every((id) => expected.includes(id));
}
/** ID 존재/전체 포함의 구조 검사. 주장의 의미가 사실이라는 보장은 별도 safety 포트에 맡긴다. */
export function checkEvidence(claims: readonly SummaryClaim[], expected: readonly string[]): void {
  if (!expected.length || new Set(expected).size !== expected.length) throw new Error("INVALID_EVIDENCE");
  const allowed = new Set(expected);
  const covered = new Set<string>();
  for (const claim of claims) {
    if (!claim.evidenceIds.length || new Set(claim.evidenceIds).size !== claim.evidenceIds.length ||
        claim.evidenceIds.some((id) => !allowed.has(id))) throw new Error("INVALID_EVIDENCE");
    claim.evidenceIds.forEach((id) => covered.add(id));
  }
  if (!sameEvidence([...covered], expected)) throw new Error("INCOMPLETE_EVIDENCE");
}
