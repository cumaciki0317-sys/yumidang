import type { AiCard, AiFilters, TrustedChatContext } from "../../../contracts/ai.ts";
/** 검색 및 재확인은 같은 인증 주체·공개 권한으로 실행한다. 실제 DB 어댑터는 별도 연결. */
export interface PublicDiscoveryPort {
  search(input: { principal: TrustedChatContext; filters: AiFilters; period?: { startsAt: string; endsAt: string }; now: Date; signal?: AbortSignal }): Promise<AiCard[]>;
  recheck(input: { principal: TrustedChatContext; filters: AiFilters; period?: { startsAt: string; endsAt: string }; now: Date; cards: {kind: AiCard["kind"]; id: string}[]; signal?: AbortSignal }): Promise<AiCard[]>;
}
export function matchesExplicitMbti(requested: string, actual: string | null | undefined): "match" | "missing" | "mismatch" {
  if (!/^[IE][NS][TF][JP]$/i.test(requested)) throw new Error("INVALID_MBTI");
  if (actual == null || actual.trim() === "") return "missing";
  if (!/^[IE][NS][TF][JP]$/i.test(actual)) throw new Error("INVALID_MBTI");
  return requested.toUpperCase() === actual.toUpperCase() ? "match" : "mismatch";
}
