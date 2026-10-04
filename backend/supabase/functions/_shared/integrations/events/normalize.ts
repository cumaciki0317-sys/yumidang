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

/** 서비스 월별 표기: 목요일 귀속. ISO가 월별 주차를 직접 정의한다는 뜻은 아니다. */
export function seoulMonthWeek(today: string): { year: number; month: number; week: number; label: string; monday: string; nextMonday: string } {
  const window = seoulWeekWindow(today);
  const thursday = parseCalendarDate(addCalendarDays(window.monday, 3));
  const year = thursday.getUTCFullYear(), month = thursday.getUTCMonth() + 1;
  const first = parseCalendarDate(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`);
  const firstThursday = 1 + ((4 - first.getUTCDay() + 7) % 7);
  const week = 1 + Math.floor((thursday.getUTCDate() - firstThursday) / 7);
  return { ...window, year, month, week, label: `${month}월 ${week}주차` };
}

/** 달력상 한 달 이동하며 없는 날짜는 대상 월 마지막 날로 제한한다. */
export function addCalendarMonths(value: string, months: number): string {
  const original = parseCalendarDate(value);
  if (!Number.isSafeInteger(months)) throw new Error("INVALID_EVENT_DATE");
  const target = new Date(original); target.setUTCDate(1); target.setUTCMonth(target.getUTCMonth() + months);
  const last = new Date(target); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
  target.setUTCDate(Math.min(original.getUTCDate(), last.getUTCDate()));
  const result = target.toISOString().slice(0, 10); parseCalendarDate(result); return result;
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
  for (const value of [event.operatingInfo, event.description]) {
    if (value != null && (typeof value !== "string" || value.length > 10000 || /[<>\u0000-\u001f]/u.test(value))) throw new Error("INVALID_EVENT_PUBLIC_TEXT");
  }
  if (event.posterUrl != null) {
    let poster: URL;
    try { poster = new URL(event.posterUrl); } catch { throw new Error("INVALID_EVENT_SOURCE_URL"); }
    if (poster.protocol !== "https:" || poster.username || poster.password || poster.search || poster.hash || !["kopis.or.kr", "www.kopis.or.kr"].includes(poster.hostname) || !poster.pathname.startsWith("/upload/")) throw new Error("INVALID_EVENT_SOURCE_URL");
  }
  // 공식 상세 주소 규칙이 확인되지 않은 제공처는 null이다. 값이 있으면 자격 증명 없는 http(s) 주소만 허용한다.
  if (event.sourceUrl === null) return;
  let url: URL;
  try { url = new URL(event.sourceUrl); } catch { throw new Error("INVALID_EVENT_SOURCE_URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("INVALID_EVENT_SOURCE_URL");
  }
}

/** 확정 시·도 이름의 명시적 별칭만 통합한다. 구·동 이름으로 시·도를 추측하지 않는다. */
const EVENT_REGION_ALIASES: Record<string, string> = Object.fromEntries([
  ["서울특별시", "서울"], ["부산광역시", "부산"], ["대구광역시", "대구"], ["인천광역시", "인천"],
  ["광주광역시", "광주"], ["대전광역시", "대전"], ["울산광역시", "울산"], ["세종특별자치시", "세종"],
  ["경기도", "경기"], ["강원특별자치도", "강원"], ["충청북도", "충북"], ["충청남도", "충남"],
  ["전북특별자치도", "전북"], ["전라남도", "전남"], ["경상북도", "경북"], ["경상남도", "경남"],
  ["제주특별자치도", "제주"],
].flatMap(([official, short]) => [[official, official], [short, official]]));
export function normalizeEventRegion(value: string | null): string | null {
  if (value === null) return null;
  return EVENT_REGION_ALIASES[value] ?? value;
}

export type PerformanceGenre = "concert" | "musical" | "play";
/** 최신 사용자 확정: 콘서트는 대중음악·클래식·국악. 원천 장르 자체는 보존한다. */
export function performanceGenreForSource(provider: string, category: string | null): PerformanceGenre | null {
  if (provider !== "kopis") return null;
  if (["대중음악", "서양음악(클래식)", "한국음악(국악)"].includes(category ?? "")) return "concert";
  return category === "뮤지컬" ? "musical" : category === "연극" ? "play" : null;
}
