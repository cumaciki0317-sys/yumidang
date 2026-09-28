/** 순수 행사 조회 규칙. DB/제공사 조회와 실제 운영일·회차·잔여석 확인을 대신하지 않는다. */
import type { DateOnlyEvent, EventTimingQuery, EventState, NormalizedEvent } from "../integrations/events/port.ts";
import {
  assertNormalizedEvent, eventInterval, queryPeriodInterval, seoulCalendarDate, seoulDateStart, seoulWeekWindow,
} from "../integrations/events/normalize.ts";
export type { EventQuery, EventTimingQuery } from "../integrations/events/port.ts";

export function eventStateAt(event: NormalizedEvent, now: Date): EventState {
  seoulCalendarDate(now);
  const interval = eventInterval(event);
  return now.getTime() < interval.start ? "upcoming" : now.getTime() >= interval.endExclusive ? "ended" : "ongoing";
}

export function selectEvents<T extends NormalizedEvent>(events: readonly T[], query: EventTimingQuery): T[] {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new Error("INVALID_EVENT_QUERY");
  if (Object.keys(query).some((key) => !["mode", "now", "period", "ongoingOnly"].includes(key))) {
    throw new Error("UNSUPPORTED_EVENT_FILTER");
  }
  if (query.period !== undefined && (!query.period || typeof query.period !== "object" || Array.isArray(query.period) ||
      Object.keys(query.period).some((key) => !["start", "end"].includes(key)))) throw new Error("INVALID_QUERY_PERIOD");
  const today = seoulCalendarDate(query.now);
  if (!["overlapping", "new_this_week", "post_selection"].includes(query.mode)) throw new Error("INVALID_EVENT_MODE");
  if (query.ongoingOnly !== undefined && typeof query.ongoingOnly !== "boolean") throw new Error("INVALID_EVENT_FILTER");
  const period = query.period ? queryPeriodInterval(query.period) : undefined;
  const week = seoulWeekWindow(today);
  const weekStart = seoulDateStart(week.monday);
  const weekEnd = seoulDateStart(week.nextMonday);
  const now = query.now.getTime();
  const rank = { ongoing: 0, upcoming: 1, ended: 2 };
  const candidates = events.map((event) => {
    assertNormalizedEvent(event);
    const interval = eventInterval(event);
    const state: EventState = now < interval.start ? "upcoming" : now >= interval.endExclusive ? "ended" : "ongoing";
    return { event, ...interval, state };
  }).filter((item) => {
    if (item.event.sourceStatus === "cancelled") return false;
    if (period && !(item.start < period.endExclusive && item.endExclusive > period.start)) return false;
    if (query.ongoingOnly && item.state !== "ongoing") return false;
    if (query.mode === "post_selection" && item.state === "ended") return false;
    if (query.mode === "new_this_week") {
      return item.start >= weekStart && item.start < weekEnd && item.state !== "ended";
    }
    return true;
  });
  candidates.sort((a, b) => {
    const group = rank[a.state] - rank[b.state];
    if (group) return group;
    const byTime = a.state === "ended" ? b.endExclusive - a.endExclusive
      : a.state === "upcoming" ? a.start - b.start : b.start - a.start;
    return byTime || (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0);
  });
  return candidates.map(({ event }) => event);
}

export type DateOnlyEventQuery = EventTimingQuery;
/** 기존 날짜 전용 후보용 helper. 원천 상태 검증이 필요한 공개 조회에는 selectEvents를 사용한다. */
export function selectDateOnlyEvents<T extends DateOnlyEvent>(events: readonly T[], query: DateOnlyEventQuery): T[] {
  const candidates = events.map((event) => ({
    id: event.id, precision: "date" as const, startsOn: event.startsOn, endsOn: event.endsOn,
    sourceStatus: event.sourceStatus ?? "active", original: event,
  }));
  return selectEvents(candidates, query).map(({ original }) => original);
}
