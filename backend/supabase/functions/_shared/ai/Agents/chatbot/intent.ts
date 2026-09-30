import { AiInputError } from "../../../contracts/ai.ts";
import { POST_CATEGORIES } from "../../../contracts/search.ts";
import type { AiFilters, DateSelection, PreferenceCondition } from "../../../contracts/ai.ts";
import { parseCalendarDate } from "../../../integrations/events/normalize.ts";
const keys = new Set(["target","query","category","region","cost","availability","date","mbti","ongoingOnly","newThisWeek","sort","authorAge","interests","conversationStyles"]);
/**
 * AI 요청 조건의 기술 상한(제품 정책 아님): 한 조건의 요청 값 수·값 길이. 모델 입력/출력 크기와 판정 배열 길이를 제한하기 위한 값이며
 * 등록 성향 상한(값 40자, Q9-A로 제품 기준)과 맞춘다. 운영 정책으로 바뀌면 설정값으로 옮긴다.
 */
export const PREFERENCE_VALUES_TECHNICAL_CAP = 10;
export const PREFERENCE_TEXT_TECHNICAL_MAX_CHARS = 40;
/** 앞뒤 공백 제거·연속 공백 1칸. 의미 보정·동의어 치환은 하지 않는다. */
export function normalizePreferenceText(value: unknown): string {
  if (typeof value !== "string") throw new AiInputError("INVALID_FILTER");
  const text = value.trim().replace(/\s+/gu, " ");
  if (!text || [...text].length > PREFERENCE_TEXT_TECHNICAL_MAX_CHARS || /[\u0000-\u001f\u007f]/u.test(text)) throw new AiInputError("INVALID_FILTER");
  return text;
}
function validatePreferenceCondition(value: unknown): PreferenceCondition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AiInputError("INVALID_FILTER");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => k !== "values" && k !== "combine") || !Array.isArray(v.values) ||
    v.values.length < 1 || v.values.length > PREFERENCE_VALUES_TECHNICAL_CAP) throw new AiInputError("INVALID_FILTER");
  const seen = new Set<string>();
  const values = v.values.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new AiInputError("INVALID_FILTER");
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some(k => k !== "text" && k !== "polarity") || !["include","exclude"].includes(row.polarity as string)) throw new AiInputError("INVALID_FILTER");
    const text = normalizePreferenceText(row.text);
    // 같은 값의 포함/제외 동시 요청은 모순이므로 임의 해석하지 않는다.
    if (seen.has(text.toLowerCase())) throw new AiInputError("INVALID_FILTER");
    seen.add(text.toLowerCase());
    return { text, polarity: row.polarity as "include" | "exclude" };
  });
  if (v.combine !== undefined && v.combine !== "any" && v.combine !== "all") throw new AiInputError("INVALID_FILTER");
  // 원하는 값(include)이 여럿이면 AND/OR는 사용자가 밝힌 경우에만 확정한다. 누락이면 추정하지 않는다.
  // exclude 값은 결합 방식과 무관하게 모두 적용하므로 결합 방식이 필요하지 않다(서버 계산 규칙).
  if (values.filter(item => item.polarity === "include").length > 1 && v.combine === undefined) throw new AiInputError("PREFERENCE_COMBINE_REQUIRED");
  return { values, ...(v.combine !== undefined ? { combine: v.combine as "any" | "all" } : {}) };
}
export function validateFilters(value: unknown): AiFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AiInputError("INVALID_FILTER");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !keys.has(k)) || !["posts","events"].includes(v.target as string)) throw new AiInputError("INVALID_FILTER");
  const f: AiFilters = { target: v.target as AiFilters["target"] };
  for (const key of ["query","category","region"] as const) { if (v[key] !== undefined) { if (typeof v[key] !== "string") throw new AiInputError("INVALID_FILTER"); f[key] = v[key]; } }
  // 공고 분류는 검색 v2 고정 목록만 허용한다. 목록 밖 값을 검색 단계 장애로 넘기지 않고 입력 오류로 드러낸다.
  if (f.target === "posts" && f.category !== undefined && !(POST_CATEGORIES as readonly string[]).includes(f.category)) throw new AiInputError("INVALID_FILTER");
  if (v.cost !== undefined) { if (!["all","free","paid"].includes(v.cost as string)) throw new AiInputError("INVALID_FILTER"); f.cost=v.cost as AiFilters["cost"]; }
  if (v.availability !== undefined) { if (!["all","recruiting"].includes(v.availability as string)) throw new AiInputError("INVALID_FILTER"); f.availability=v.availability as AiFilters["availability"]; }
  for (const key of ["ongoingOnly","newThisWeek"] as const) { if(v[key] !== undefined) { if(typeof v[key] !== "boolean") throw new AiInputError("INVALID_FILTER"); f[key]=v[key]; } }
  if (v.sort !== undefined) { if (!["created_desc","starts_asc"].includes(v.sort as string)) throw new AiInputError("INVALID_FILTER"); f.sort=v.sort as AiFilters["sort"]; }
  if (v.authorAge !== undefined) { if (!["all","20s","30s","40plus"].includes(v.authorAge as string)) throw new AiInputError("INVALID_FILTER"); f.authorAge=v.authorAge as AiFilters["authorAge"]; }
  for (const key of ["interests","conversationStyles"] as const) { if (v[key] !== undefined) f[key]=validatePreferenceCondition(v[key]); }
  if (v.mbti !== undefined) { if(typeof v.mbti !== "string" || !/^[IE][NS][TF][JP]$/i.test(v.mbti)) throw new AiInputError("INVALID_FILTER"); f.mbti=v.mbti.toUpperCase(); }
  if (v.date !== undefined) {
    const d=v.date as Record<string,unknown>;
    if(!d || typeof d!=="object" || Array.isArray(d)) throw new AiInputError("INVALID_DATE_RANGE");
    if(d.kind === "dates") {
      if (Object.keys(d).some(k=>!["kind","startsOn","endsOn"].includes(k)) || typeof d.startsOn!=="string" || typeof d.endsOn!=="string") throw new AiInputError("INVALID_DATE_RANGE");
      parseCalendarDate(d.startsOn); parseCalendarDate(d.endsOn);
      if(d.endsOn<d.startsOn) throw new AiInputError("INVALID_DATE_RANGE");
      f.date={kind:"dates",startsOn:d.startsOn,endsOn:d.endsOn};
    } else {
      if (Object.keys(d).some(k=>k!=="kind") || !["today","tomorrow","this_week","this_weekend"].includes(d.kind as string)) throw new AiInputError("INVALID_DATE_RANGE");
      f.date={kind:d.kind} as DateSelection;
    }
  }
  // 서로 다른 카드 종류에 잘못된 필터를 적용하거나 조용히 버리지 않는다.
  if (f.target === "events" && (f.mbti !== undefined || f.availability !== undefined || f.cost !== undefined || f.sort !== undefined ||
    f.authorAge !== undefined || f.interests !== undefined || f.conversationStyles !== undefined)) throw new AiInputError("UNSUPPORTED_FILTER");
  if (f.target === "posts" && (f.ongoingOnly !== undefined || f.newThisWeek !== undefined || f.region !== undefined)) throw new AiInputError("UNSUPPORTED_FILTER");
  return f;
}
export type InterpretedIntent = { status: "search"; filters: AiFilters } | { status: "clarify"; filters: AiFilters; question: string };
export function parseIntent(raw: unknown): InterpretedIntent {
  if(!raw || typeof raw!=="object" || Array.isArray(raw)) throw new AiInputError("INVALID_INTENT");
  const v=raw as Record<string,unknown>;
  if(Object.keys(v).some(k=>!["status","filters","question"].includes(k))) throw new AiInputError("INVALID_INTENT");
  const filters=validateFilters(v.filters);
  if(v.status==="search" && v.question === undefined) return {status:"search",filters};
  if(v.status==="clarify" && typeof v.question==="string" && v.question.trim()) return {status:"clarify",filters,question:v.question};
  throw new AiInputError("INVALID_INTENT");
}
