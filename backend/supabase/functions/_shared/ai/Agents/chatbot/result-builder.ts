import type { AiCard, AiFilters } from "../../../contracts/ai.ts";
/** DB 검색 결과에서도 명시된 공개 필드만 복사한다. 추가 필드는 모델에 보내지 않는다. */
export function projectCards(rows: AiCard[], filters: AiFilters): AiCard[] {
  if(!Array.isArray(rows)) throw new Error("INVALID_CARDS");
  const seen = new Set<string>();
  return rows.flatMap(row => {
    if(!row || !["post","event"].includes(row.kind) || (filters.target==="posts" ? row.kind!=="post" : row.kind!=="event") ||
      [row.id,row.title,row.locationLabel,row.startsAtOrDate,row.endsAtOrDate,row.costLabel,row.state].some(v=>typeof v!=="string") || !row.id || typeof row.canApply!=="boolean") throw new Error("INVALID_CARD");
    if (row.kind === "event") {
      if (typeof row.sourceUrl !== "string") throw new Error("MISSING_EVENT_SOURCE");
      const url = new URL(row.sourceUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("INVALID_EVENT_SOURCE");
    }
    const key=`${row.kind}:${row.id}`; if(seen.has(key)) throw new Error("DUPLICATE_CARD"); seen.add(key);
    if(filters.mbti && !["match","missing","mismatch"].includes(row.preferenceMatch ?? "")) throw new Error("PREFERENCE_MATCH_NOT_PROVIDED");
    if (row.kind === "post" && filters.availability === "recruiting" && row.state !== "recruiting") return [];
    if(filters.mbti && row.preferenceMatch==="mismatch") return [];
    return [{kind:row.kind,id:row.id,title:row.title,locationLabel:row.locationLabel,startsAtOrDate:row.startsAtOrDate,endsAtOrDate:row.endsAtOrDate,costLabel:row.costLabel,state:row.state,canApply:row.kind==="post" && row.state==="recruiting" && row.canApply,...(row.kind === "event" ? {sourceUrl:row.sourceUrl} : {}),...(filters.mbti ? {preferenceMatch:row.preferenceMatch} : {})}];
  });
}
