/** 민규담당: 비공개 DB의 네이버 근거를 해석한다. 실제 활동 허용은 RPC가 다시 검사한다. */
import { getPrincipalToken, type Principal } from "./principal.ts";
export type EligibilityState = "verification_required" | "photo_required" | "completion_required" | "eligible";
/** 신뢰된 공급사 어댑터/비공개 DB 조회가 제공해야 한다. 요청 본문·user_metadata에는 사용 금지. */
export interface TrustedSignupProof {
  readonly source: "naver";
  readonly userId: string;
  readonly qualificationVerified: boolean;
  readonly accountLinked: boolean;
  readonly profilePhotoPresent: boolean;
  readonly signupCompleted: boolean;
}
/** 요청 본문·user_metadata·옛 PASS/수기 기록은 신뢰된 네이버 증거가 아니다. */
export function evaluateTrustedEligibility(principal: Principal, proof: TrustedSignupProof | null): EligibilityState {
  getPrincipalToken(principal);
  if (!proof || proof.source !== "naver" || proof.userId !== principal.userId || proof.qualificationVerified !== true || proof.accountLinked !== true) return "verification_required";
  if (proof.profilePhotoPresent !== true) return "photo_required";
  return proof.signupCompleted === true ? "eligible" : "completion_required";
}
