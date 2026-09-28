import type { EventPeriod, EventTiming, NormalizedEvent, SourceEventRecord } from "./port.ts";

export function parseCalendarDate(value: string): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("INVALID_EVENT_DATE");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.toISOString().slice(0, 10) !== value) throw new Error("INVALID_EVENT_DATE");
  return date;
}

export function addCalendarDays(value: string, days: number): string {
  const date = parseCalendarDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  const next = date.toISOString().slice(0, 10);
  parseCalendarDate(next);
  return next;
}

export function seoulCalendarDate(now: Date): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("INVALID_NOW");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  const result = `${value("year")}-${value("month")}-${value("day")}`;
  parseCalendarDate(result);
  return result;
}

/** 월별 주차 번호 없이 월요일 포함, 다음 월요일 제외 주간을 반환한다. */
export function seoulWeekWindow(today: string): { monday: string; nextMonday: string } {
  const date = parseCalendarDate(today);
  const monday = addCalendarDays(today, -((date.getUTCDay() + 6) % 7));
  return { monday, nextMonday: addCalendarDays(monday, 7) };
}

export function assertDateOnlyEvent(startsOn: string, endsOn: string): void {
  parseCalendarDate(startsOn);
  parseCalendarDate(endsOn);
  if (endsOn < startsOn) throw new Error("INVALID_EVENT_PERIOD");
}

/** 시간대 없는 문자열이나 Date.parse의 잘못된 날짜 자동 보정을 허용하지 않는다. */
export function parseEventInstant(value: string): number {
  if (typeof value !== "string") throw new Error("INVALID_EVENT_INSTANT");
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error("INVALID_EVENT_INSTANT");
  parseCalendarDate(match[1]);
  if (+match[2] > 23 || +match[3] > 59 || +match[4] > 59) throw new Error("INVALID_EVENT_INSTANT");
  const zone = match[6];
  if (zone === "-00:00") throw new Error("UNKNOWN_EVENT_TIMEZONE");
  if (zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4, 6) > 59)) {
    throw new Error("INVALID_EVENT_INSTANT");
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new Error("INVALID_EVENT_INSTANT");
  return instant;
}

/** 날짜 정밀도의 내부 검색 경계. 화면에 알려진 시작 시각으로 표시하지 않는다. */
export function seoulDateStart(value: string): number {
  parseCalendarDate(value);
  return Date.parse(`${value}T00:00:00+09:00`);
}

export function eventInterval(event: EventTiming): { start: number; endExclusive: number } {
  if (event.precision === "date") {
    assertDateOnlyEvent(event.startsOn, event.endsOn);
    return { start: seoulDateStart(event.startsOn), endExclusive: seoulDateStart(addCalendarDays(event.endsOn, 1)) };
  }
  if (event.precision === "instant") {
    const start = parseEventInstant(event.startsAt);
    const endExclusive = parseEventInstant(event.endsAt);
    if (endExclusive <= start) throw new Error("INVALID_EVENT_PERIOD");
    return { start, endExclusive };
  }
  throw new Error("UNSUPPORTED_EVENT_PRECISION");
}

export function queryPeriodInterval(period: EventPeriod): { start: number; endExclusive: number } {
  parseCalendarDate(period.start);
  parseCalendarDate(period.end);
  if (period.end < period.start) throw new Error("INVALID_QUERY_PERIOD");
  return { start: seoulDateStart(period.start), endExclusive: seoulDateStart(addCalendarDays(period.end, 1)) };
}

export function assertNormalizedEvent(event: NormalizedEvent): void {
  if (typeof event.id !== "string" || event.id.trim() === "") throw new Error("INVALID_EVENT_ID");
  if (event.sourceStatus !== "active" && event.sourceStatus !== "cancelled") {
    throw new Error("UNSUPPORTED_EVENT_SOURCE_STATUS");
  }
  eventInterval(event);
}

export function assertSourceEventRecord(event: SourceEventRecord): void {
  for (const value of [event.provider, event.sourceId, event.title]) {
    if (typeof value !== "string" || value.trim() === "") throw new Error("INVALID_EVENT_SOURCE_RECORD");
  }
  assertNormalizedEvent({ ...event, id: event.sourceId });
  parseEventInstant(event.collectedAt);
  for (const value of [event.category, event.region, event.placeName, event.publicAddress]) {
    if (value !== null && (typeof value !== "string" || /<[^>]*>/.test(value))) {
      throw new Error("INVALID_EVENT_PUBLIC_TEXT");
    }
  }
  if (/<[^>]*>/.test(event.title)) throw new Error("INVALID_EVENT_PUBLIC_TEXT");
  if (!event.admission || !["unknown", "free", "described"].includes(event.admission.kind)) {
    throw new Error("INVALID_EVENT_ADMISSION");
  }
  if (event.admission.kind === "described" && (
    typeof event.admission.text !== "string" || event.admission.text.trim() === "" || /<[^>]*>/.test(event.admission.text)
  )) throw new Error("INVALID_EVENT_ADMISSION");
  let url: URL;
  try { url = new URL(event.sourceUrl); } catch { throw new Error("INVALID_EVENT_SOURCE_URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("INVALID_EVENT_SOURCE_URL");
  }
}
