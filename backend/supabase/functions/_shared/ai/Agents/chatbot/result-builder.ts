import type { AiCard, AiFilters, CardConditionStatus } from "../../../contracts/ai.ts";
const conditionKeys = ["mbti", "interests", "conversationStyles"] as const;
/** 요청한 성향 조건마다 match/needs_check가 있어야 하며 요청하지 않은 조건의 상태·여분 키는 거절한다. */
function projectConditionStatus(row: AiCard, filters: AiFilters): CardConditionStatus | undefined {
  const requested = conditionKeys.filter((key) => filters[key] !== undefined);
  const raw = (row as { conditionStatus?: unknown }).conditionStatus;
  if (!requested.length) {
    if (raw !== undefined) throw new Error("UNREQUESTED_CONDITION_STATUS");
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("CONDITION_STATUS_NOT_PROVIDED");
  const status = raw as Record<string, unknown>;
  if (Object.keys(status).some((key) => !requested.includes(key as typeof requested[number]))) throw new Error("UNREQUESTED_CONDITION_STATUS");
  const result: CardConditionStatus = {};
  for (const key of requested) {
    if (status[key] !== "match" && status[key] !== "needs_check") throw new Error("CONDITION_STATUS_NOT_PROVIDED");
    result[key] = status[key] as "match" | "needs_check";
  }
  return result;
}
/** DB 검색 결과에서도 명시된 공개 필드만 복사한다. 추가 필드(성향 버전·원본 성향 등)는 모델·응답에 보내지 않는다. */
export function projectCards(rows: AiCard[], filters: AiFilters): AiCard[] {
  if(!Array.isArray(rows)) throw new Error("INVALID_CARDS");
  const seen = new Set<string>();
  return rows.flatMap(row => {
    if(!row || !["post","event"].includes(row.kind) || (filters.target==="posts" ? row.kind!=="post" : row.kind!=="event") ||
      [row.id,row.title,row.locationLabel,row.startsAtOrDate,row.endsAtOrDate,row.costLabel,row.state].some(v=>typeof v!=="string") || !row.id || typeof row.canApply!=="boolean") throw new Error("INVALID_CARD");
    if (row.kind === "event") {
      // 출처 이름은 필수. 링크는 저장소가 준 공식 링크 또는 null(공식 링크 규칙 없음, Q4-A)만 허용한다.
      if (typeof row.sourceName !== "string" || !row.sourceName.trim() || row.sourceName.length > 40) throw new Error("MISSING_EVENT_SOURCE");
      if (row.sourceUrl !== null) {
        if (typeof row.sourceUrl !== "string") throw new Error("MISSING_EVENT_SOURCE");
        const url = new URL(row.sourceUrl);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("INVALID_EVENT_SOURCE");
      }
    }
    const key=`${row.kind}:${row.id}`; if(seen.has(key)) throw new Error("DUPLICATE_CARD"); seen.add(key);
    const conditionStatus = projectConditionStatus(row, filters);
    if (row.kind === "post" && filters.availability === "recruiting" && row.state !== "recruiting") return [];
    return [{kind:row.kind,id:row.id,title:row.title,locationLabel:row.locationLabel,startsAtOrDate:row.startsAtOrDate,endsAtOrDate:row.endsAtOrDate,costLabel:row.costLabel,state:row.state,canApply:row.kind==="post" && row.state==="recruiting" && row.canApply,...(row.kind === "event" ? {sourceUrl:row.sourceUrl ?? null,sourceName:row.sourceName} : {}),...(conditionStatus ? {conditionStatus} : {})}];
  });
}
