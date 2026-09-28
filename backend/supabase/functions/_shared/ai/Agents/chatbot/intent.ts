import { AiInputError } from "../../../contracts/ai.ts";
import type { AiFilters, DateSelection } from "../../../contracts/ai.ts";
import { parseCalendarDate } from "../../../integrations/events/normalize.ts";
const keys = new Set(["target","query","category","region","cost","availability","date","mbti","ongoingOnly","newThisWeek"]);
export function validateFilters(value: unknown): AiFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AiInputError("INVALID_FILTER");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !keys.has(k)) || !["posts","events"].includes(v.target as string)) throw new AiInputError("INVALID_FILTER");
  const f: AiFilters = { target: v.target as AiFilters["target"] };
  for (const key of ["query","category","region"] as const) { if (v[key] !== undefined) { if (typeof v[key] !== "string") throw new AiInputError("INVALID_FILTER"); f[key] = v[key]; } }
  if (v.cost !== undefined) { if (!["all","free","paid"].includes(v.cost as string)) throw new AiInputError("INVALID_FILTER"); f.cost=v.cost as AiFilters["cost"]; }
  if (v.availability !== undefined) { if (!["all","recruiting"].includes(v.availability as string)) throw new AiInputError("INVALID_FILTER"); f.availability=v.availability as AiFilters["availability"]; }
  for (const key of ["ongoingOnly","newThisWeek"] as const) { if(v[key] !== undefined) { if(typeof v[key] !== "boolean") throw new AiInputError("INVALID_FILTER"); f[key]=v[key]; } }
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
  if (f.target === "events" && (f.mbti !== undefined || f.availability !== undefined || f.cost !== undefined)) throw new AiInputError("UNSUPPORTED_FILTER");
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
