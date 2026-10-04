import type { AiCard, AiFilters, CardConditionStatus, TrustedChatContext } from "../../../contracts/ai.ts";
/** 판정에 사용한 작성자 성향 버전(내부 전용). 응답·모델 입력에 넣지 않고 응답 직전 재확인에만 쓴다. */
export interface DiscoveredCard extends AiCard { traitsVersion?: string }
/**
 * coverage: exhausted = 조건에 맞는 후보를 끝까지 확인 / filled = 반환 분량을 채워 멈춤 /
 * incomplete = 실행 한도·예산 등으로 확인을 끝내지 못함(부분 결과를 결과 없음이나 완료로 표시하지 않는다).
 */
export interface DiscoveryResult { cards: DiscoveredCard[]; coverage: "exhausted" | "filled" | "incomplete" }
export interface RecheckTarget { kind: AiCard["kind"]; id: string; traitsVersion?: string; conditionStatus?: CardConditionStatus }
/** 검색 및 재확인은 같은 인증 주체·공개 권한으로 실행한다. 재확인은 새 ID를 추가하지 않는다. */
export interface PublicDiscoveryPort {
  search(input: { principal: TrustedChatContext; filters: AiFilters; period?: { startsAt: string; endsAt: string }; now: Date; signal?: AbortSignal }): Promise<DiscoveryResult>;
  /** complete=false는 재확인 한도 안에 모든 카드의 현재 상태를 확인하지 못했다는 뜻이다. cards에는 현재 자격 검증을 마친 부분집합만 담는다. */
  recheck(input: { principal: TrustedChatContext; filters: AiFilters; period?: { startsAt: string; endsAt: string }; now: Date; cards: RecheckTarget[]; signal?: AbortSignal }): Promise<{ cards: AiCard[]; complete: boolean }>;
}
export function matchesExplicitMbti(requested: string, actual: string | null | undefined): "match" | "missing" | "mismatch" {
  if (!/^[IE][NS][TF][JP]$/i.test(requested)) throw new Error("INVALID_MBTI");
  if (actual == null || actual.trim() === "") return "missing";
  if (!/^[IE][NS][TF][JP]$/i.test(actual)) throw new Error("INVALID_MBTI");
  return requested.toUpperCase() === actual.toUpperCase() ? "match" : "mismatch";
}
