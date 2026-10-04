/**
 * 행사 AI 탐색의 PublicDiscoveryPort. 별도 검색을 만들지 않고 행사 저장소(list_public_events)의 조회 모드·정렬·페이지를 그대로 쓴다.
 * 행사에는 성향 판단이 없다. 카드 사실 필드는 저장소 값에서만 만들며 모델이 만들지 않는다.
 * 2026-09-30 사용자 결정(Q4-A): 공식 링크가 없는 제공처는 sourceUrl null + 출처 이름만 표시한다.
 */
import type { AiCard, AiFilters } from "../../../contracts/ai.ts";
import type { EventPage, EventPageQuery, PublicEventItem } from "../../../db/repositories/events.ts";
import { addCalendarDays } from "../../../integrations/events/normalize.ts";
import type { DiscoveryLimits } from "./discovery.ts";
import type { DiscoveryResult, PublicDiscoveryPort } from "./tools.ts";

export interface EventListSource { listPage(query: EventPageQuery, cursor: string | undefined, limit: number): Promise<EventPage> }
/** 제공처 표시 이름. 목록에 없는 제공처는 식별자를 그대로 쓰지 않고 카드 생성을 거절한다. */
const SOURCE_NAMES: Readonly<Record<string, string>> = Object.freeze({ kopis: "KOPIS", "tour-api": "한국관광공사", "seoul-open-data": "서울 열린데이터광장" });

function admissionLabel(item: PublicEventItem): string {
  switch (item.admission.kind) {
    case "free": return "무료";
    case "described": return item.admission.text;
    case "unknown": return "입장료 정보 없음";
    default: throw new Error("INVALID_EVENT_ADMISSION");
  }
}
export function toAiEventCard(item: PublicEventItem): AiCard {
  const sourceName = SOURCE_NAMES[item.provider];
  if (!sourceName) throw new Error("UNKNOWN_EVENT_SOURCE");
  const location = item.placeName ?? item.publicAddress ?? item.region;
  return {
    kind: "event", id: item.id, title: item.title, locationLabel: location ?? "장소 정보 없음",
    startsAtOrDate: item.precision === "date" ? item.startsOn : item.startsAt,
    endsAtOrDate: item.precision === "date" ? item.endsOn : item.endsAt,
    costLabel: admissionLabel(item), state: item.state, canApply: false,
    sourceUrl: item.sourceUrl ?? null, sourceName,
  };
}

/** AI 조건을 행사 조회 조건으로 바꾼다. 기간은 한국 달력 날짜(양 끝 포함)다. */
export function eventQueryFromFilters(filters: AiFilters, period: { startsAt: string; endsAt: string } | undefined): EventPageQuery {
  if (filters.cost === "paid") throw new Error("UNSUPPORTED_FILTER");
  if (filters.target !== "events") throw new Error("UNSUPPORTED_TARGET");
  return {
    mode: filters.newThisWeek || filters.includeOngoing ? "new_this_week" : "overlapping",
    ...(filters.cost === "free" ? { freeOnly: true } : {}),
    ...(filters.includeOngoing !== undefined ? { includeOngoing: filters.includeOngoing } : {}),
    ...(filters.performanceGenre !== undefined ? { performanceGenre: filters.performanceGenre } : {}),
    ...(filters.ongoingOnly !== undefined ? { ongoingOnly: filters.ongoingOnly } : {}),
    ...(filters.query !== undefined ? { query: filters.query } : {}),
    ...(filters.region !== undefined ? { region: filters.region } : {}),
    ...(filters.category !== undefined ? { category: filters.category } : {}),
    ...(period ? { period: { start: period.startsAt.slice(0, 10), end: addCalendarDays(period.endsAt.slice(0, 10), -1) } } : {}),
  };
}

export function createEventDiscovery(deps: { source: EventListSource; limits: Pick<DiscoveryLimits, "pageSize" | "maxSearchPages" | "recheckMaxPages" | "maxResultCards"> }): PublicDiscoveryPort {
  const { source, limits } = deps;
  if (!source || typeof source.listPage !== "function" ||
      [limits?.pageSize, limits?.maxSearchPages, limits?.recheckMaxPages, limits?.maxResultCards].some((n) => !Number.isSafeInteger(n) || n < 1)) {
    throw new Error("DISCOVERY_LIMITS_NOT_CONFIGURED");
  }
  const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("CANCELLED"); };
  return {
    async search({ filters, period, signal }): Promise<DiscoveryResult> {
      const query = eventQueryFromFilters(filters, period);
      const cards: AiCard[] = [];
      let cursor: string | undefined;
      for (let page = 1; page <= limits.maxSearchPages; page += 1) {
        cancelled(signal);
        const result = await source.listPage(query, cursor, limits.pageSize);
        if (filters.cost === "free" && result.events.some(item => item.admission.kind !== "free")) throw new Error("EVENT_COST_FILTER_NOT_APPLIED");
        for (const item of result.events) {
          cards.push(toAiEventCard(item));
          if (cards.length >= limits.maxResultCards) return { cards, coverage: "filled" };
        }
        if (result.nextCursor === null) return { cards, coverage: "exhausted" };
        cursor = result.nextCursor;
      }
      return { cards, coverage: "incomplete" };
    },
    async recheck({ filters, period, cards, signal }) {
      if (cards.some((card) => card.kind !== "event")) throw new Error("UNSUPPORTED_TARGET");
      const query = eventQueryFromFilters(filters, period);
      const remaining = new Set(cards.map((card) => card.id));
      const found = new Map<string, AiCard>();
      let exhausted = false;
      let cursor: string | undefined;
      for (let page = 1; page <= limits.recheckMaxPages && remaining.size; page += 1) {
        cancelled(signal);
        const result = await source.listPage(query, cursor, limits.pageSize);
        if (filters.cost === "free" && result.events.some(item => item.admission.kind !== "free")) throw new Error("EVENT_COST_FILTER_NOT_APPLIED");
        for (const item of result.events) if (remaining.delete(item.id)) found.set(item.id, toAiEventCard(item));
        if (result.nextCursor === null) { exhausted = true; break; }
        cursor = result.nextCursor;
      }
      // 한도 안에 확인하지 못한 카드는 사라졌다고 단정하지 않는다.
      return { cards: cards.flatMap((card) => found.has(card.id) ? [found.get(card.id)!] : []), complete: !remaining.size || exhausted };
    },
  };
}
