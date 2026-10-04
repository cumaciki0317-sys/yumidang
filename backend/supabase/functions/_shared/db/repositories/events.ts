/**
 * 행사 저장소. 순수 조회 helper(queryStoredEvents/syncEventPage)와 제안 SQL 04_events.sql의 RPC 어댑터.
 * RPC(upsert_events/list_public_events)는 민규 채택 전 제안이며 정식 마이그레이션·클라이언트 허용 목록 반영 전이다.
 */
import type {
  EventPeriod, EventProviderPort, EventQuery, EventFetchRequest, EventState, SourceEventRecord, StoredEventRecord,
} from "../../integrations/events/port.ts";
import { normalizeEventRegion, performanceGenreForSource, type PerformanceGenre } from "../../integrations/events/normalize.ts";
import { assertSourceEventRecord, parseCalendarDate, queryPeriodInterval } from "../../integrations/events/normalize.ts";
import { selectEvents } from "../../services/event-service.ts";
import type { JsonValue } from "../../contracts/common.ts";
import type { RpcClient } from "../transport.ts";

export interface EventSaveResult {
  savedCount: number;
  insertedCount?: number;
  updatedCount?: number;
  /** 더 최근 수집본이 이미 있어 덮어쓰지 않은 건수. */
  staleCount?: number;
}

export interface EventRepositoryPort {
  /** provider + sourceId 유일 제약으로 upsert. 제공처가 다른 유사 행사는 자동 병합하지 않는다. */
  upsertBySourceIdentity(events: readonly SourceEventRecord[]): Promise<EventSaveResult>;
  /** 필터·정렬 전 후보 전체. DB 페이지네이션은 같은 조회 정책/정렬을 보장할 때 연결한다. */
  listCandidates(query: EventQuery): Promise<readonly StoredEventRecord[]>;
}

export interface EventSearchIndexFields {
  title: string;
  placeName?: string | null;
  publicAddress?: string | null;
}

export function normalizeEventKeyword(value: string): string {
  if (typeof value !== "string") throw new Error("INVALID_EVENT_QUERY");
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

/** 공개 행사 정보만 검색한다. 필드를 이어 붙이거나 설명·비공개 만남 지점을 검색하지 않는다. */
export function matchesEventKeyword(fields: EventSearchIndexFields, rawQuery: string): boolean {
  const keyword = normalizeEventKeyword(rawQuery);
  if (!fields || typeof fields.title !== "string" ||
      [fields.placeName, fields.publicAddress].some((value) => value != null && typeof value !== "string")) {
    throw new Error("INVALID_EVENT_SEARCH_INDEX");
  }
  if (!keyword) return true;
  return [fields.title, fields.placeName, fields.publicAddress]
    .some((value) => value != null && normalizeEventKeyword(value).includes(keyword));
}

export async function queryStoredEvents(repository: EventRepositoryPort, query: EventQuery): Promise<StoredEventRecord[]> {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new Error("INVALID_EVENT_QUERY");
  if (Object.keys(query).some((key) => !["mode", "now", "period", "ongoingOnly", "includeOngoing", "freeOnly", "performanceGenre", "region", "category", "query"].includes(key))) {
    throw new Error("UNSUPPORTED_EVENT_FILTER");
  }
  for (const field of ["region", "category"] as const) {
    if (query[field] !== undefined && (typeof query[field] !== "string" || !query[field].trim())) {
      throw new Error("INVALID_EVENT_FILTER");
    }
  }
  if (query.performanceGenre !== undefined && !["concert", "musical", "play"].includes(query.performanceGenre)) throw new Error("INVALID_EVENT_FILTER");
  if (query.freeOnly !== undefined && typeof query.freeOnly !== "boolean") throw new Error("INVALID_EVENT_FILTER");
  const { query: rawQuery, region, category, performanceGenre, freeOnly, ...timingQuery } = query;
  const keyword = normalizeEventKeyword(rawQuery === undefined ? "" : rawQuery);
  selectEvents([], timingQuery); // 잘못된 필터를 실제 DB 요청 전에 거절한다.
  const events = await repository.listCandidates({ ...query, query: keyword });
  return selectEvents(events, timingQuery).filter((event) =>
    matchesEventKeyword(event, keyword) &&
    (region === undefined || normalizeEventRegion(event.region) === normalizeEventRegion(region)) && (category === undefined || event.category === category) &&
    (performanceGenre === undefined || performanceGenreForSource(event.provider, event.category) === performanceGenre) && (!freeOnly || event.admission.kind === "free")
  );
}

/** 한 페이지 단위 저장. provider 장애/정규화 실패 시 저장을 시작하지 않는다. */
export async function syncEventPage(
  provider: EventProviderPort,
  repository: Pick<EventRepositoryPort, "upsertBySourceIdentity">,
  request: EventFetchRequest,
) {
  request.signal?.throwIfAborted();
  const page = await provider.fetchPage(request);
  request.signal?.throwIfAborted();
  for (const event of page.events) {
    assertSourceEventRecord(event);
    if (event.provider !== provider.provider) throw new Error("EVENT_PROVIDER_CONTEXT_MISMATCH");
  }
  const saved = await repository.upsertBySourceIdentity(page.events);
  return { fetchedCount: page.events.length, ...saved, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) };
}


/* ---------- RPC 저장소: 제안 04_events.sql(upsert_events / list_public_events) ---------- */

export interface EventPageQuery {
  mode: "overlapping" | "new_this_week" | "post_selection";
  period?: EventPeriod;
  ongoingOnly?: boolean;
  includeOngoing?: boolean;
  performanceGenre?: PerformanceGenre;
  freeOnly?: boolean;
  /** 행사명·장소명·공개 주소 중 한 필드 부분 일치. 빈 검색어는 다른 필터만 적용한다. */
  query?: string;
  region?: string;
  category?: string;
}
export type PublicEventItem = StoredEventRecord & { state: EventState; performanceGenre?: PerformanceGenre | null; operatingInfo?: string | null; description?: string | null; posterUrl?: string | null };
export interface EventPage {
  events: PublicEventItem[];
  /** 다음 페이지 불투명 커서. 같은 조건에서만 유효하다. */
  nextCursor: string | null;
}
export interface RpcEventRepository {
  upsertBySourceIdentity(events: readonly SourceEventRecord[]): Promise<Required<EventSaveResult>>;
  /** 조회 기준 시각은 DB now()다. 필터·정렬 후 keyset 페이지를 반환한다. */
  listPage(query: EventPageQuery, cursor: string | undefined, limit: number): Promise<EventPage>;
}
/** SQL과 같은 기술 한도. 기존 search_public_posts_v2의 1..50을 따랐으며 운영 정책 값이 아니다. */
export const EVENT_PAGE_MAX_LIMIT = 50;

interface CanonicalEventFilters {
  mode: EventPageQuery["mode"];
  period: EventPeriod | null;
  ongoingOnly: boolean;
  includeOngoing: boolean;
  performanceGenre: PerformanceGenre | null;
  freeOnly: boolean;
  query: string;
  region: string | null;
  category: string | null;
}
interface EventCursorPosition { rank: 0 | 1 | 2; key: string; id: string }

const invalidResponse = (): never => { throw new Error("INVALID_EVENT_REPOSITORY_RESPONSE"); };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const providerPattern = /^[a-z0-9][a-z0-9-]{0,31}$/;
const cursorKeyPattern = /^-?[0-9]{1,12}(\.[0-9]{1,6})?$/;
const stateRank: Record<EventState, 0 | 1 | 2> = { ongoing: 0, upcoming: 1, ended: 2 };

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** 조회 조건을 고정 순서의 정규형으로 만든다. 커서 지문과 RPC 인자가 같은 값을 사용한다. */
export function normalizeEventPageQuery(query: EventPageQuery): CanonicalEventFilters {
  if (!isObject(query)) throw new Error("INVALID_EVENT_QUERY");
  if (Object.keys(query).some((key) => !["mode", "period", "ongoingOnly", "includeOngoing", "freeOnly", "performanceGenre", "query", "region", "category"].includes(key))) {
    throw new Error("UNSUPPORTED_EVENT_FILTER");
  }
  if (!["overlapping", "new_this_week", "post_selection"].includes(query.mode as string)) throw new Error("INVALID_EVENT_MODE");
  let period: EventPeriod | null = null;
  if (query.period !== undefined) {
    if (!isObject(query.period) || !hasExactKeys(query.period, ["start", "end"])) throw new Error("INVALID_QUERY_PERIOD");
    queryPeriodInterval(query.period as unknown as EventPeriod);
    period = { start: query.period.start as string, end: query.period.end as string };
  }
  if (query.ongoingOnly !== undefined && typeof query.ongoingOnly !== "boolean") throw new Error("INVALID_EVENT_FILTER");
  if (query.includeOngoing !== undefined && typeof query.includeOngoing !== "boolean") throw new Error("INVALID_EVENT_FILTER");
  if (query.includeOngoing && (query.ongoingOnly || query.mode !== "new_this_week")) throw new Error("INVALID_EVENT_FILTER");
  if (query.performanceGenre !== undefined && !["concert", "musical", "play"].includes(query.performanceGenre)) throw new Error("INVALID_EVENT_FILTER");
  if (query.freeOnly !== undefined && typeof query.freeOnly !== "boolean") throw new Error("INVALID_EVENT_FILTER");
  const filters: CanonicalEventFilters = {
    mode: query.mode, period, ongoingOnly: query.ongoingOnly === true, includeOngoing: query.includeOngoing === true,
    performanceGenre: query.performanceGenre ?? null, freeOnly: query.freeOnly === true,
    query: normalizeEventKeyword(query.query === undefined ? "" : query.query),
    region: null, category: null,
  };
  for (const field of ["region", "category"] as const) {
    const value = query[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) throw new Error("INVALID_EVENT_FILTER");
    filters[field] = field === "region" ? normalizeEventRegion(value) : value;
  }
  return filters;
}

function filtersToRpc(filters: CanonicalEventFilters): Record<string, JsonValue> {
  return {
    mode: filters.mode,
    ongoingOnly: filters.ongoingOnly,
    ...(filters.includeOngoing ? { includeOngoing: true } : {}),
    ...(filters.performanceGenre ? { performanceGenre: filters.performanceGenre } : {}),
    ...(filters.freeOnly ? { freeOnly: true } : {}),
    ...(filters.query ? { query: filters.query } : {}),
    ...(filters.period ? { period: { start: filters.period.start, end: filters.period.end } } : {}),
    ...(filters.region !== null ? { region: filters.region } : {}),
    ...(filters.category !== null ? { category: filters.category } : {}),
  };
}

function base64UrlEncode(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function base64UrlDecode(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function encodeEventCursor(filters: CanonicalEventFilters, position: EventCursorPosition): string {
  return base64UrlEncode(JSON.stringify({ v: 1, filters, position }));
}
/** 다른 조건·변조·구형 커서는 첫 페이지로 바꾸지 않고 INVALID_EVENT_CURSOR로 거절한다. */
export function decodeEventCursor(cursor: string, filters: CanonicalEventFilters): EventCursorPosition {
  const fail = (): never => { throw new Error("INVALID_EVENT_CURSOR"); };
  if (typeof cursor !== "string" || !cursor || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return fail();
  let parsed: unknown;
  try { parsed = JSON.parse(base64UrlDecode(cursor)); } catch { return fail(); }
  if (!isObject(parsed) || !hasExactKeys(parsed, ["v", "filters", "position"]) || parsed.v !== 1) return fail();
  if (JSON.stringify(parsed.filters) !== JSON.stringify(filters)) return fail();
  const position = parsed.position;
  if (!isObject(position) || !hasExactKeys(position, ["rank", "key", "id"]) ||
      (position.rank !== 0 && position.rank !== 1 && position.rank !== 2) ||
      typeof position.key !== "string" || !cursorKeyPattern.test(position.key) ||
      typeof position.id !== "string" || !uuidPattern.test(position.id)) return fail();
  return { rank: position.rank, key: position.key, id: position.id };
}

/** SQL 정렬값(초 단위 epoch, 그룹별 부호)을 밀리초로 계산한다. */
function sortKeyMs(item: PublicEventItem): number {
  const interval = eventIntervalOf(item);
  return item.state === "ongoing" ? -interval.start : item.state === "upcoming" ? interval.start : -interval.endExclusive;
}
function eventIntervalOf(item: StoredEventRecord): { start: number; endExclusive: number } {
  const range = item.precision === "date"
    ? queryPeriodInterval({ start: item.startsOn, end: item.endsOn })
    : { start: Date.parse(item.startsAt), endExclusive: Date.parse(item.endsAt) };
  return range;
}

export function toWireEvent(event: SourceEventRecord): Record<string, JsonValue> {
  assertSourceEventRecord(event);
  if (!providerPattern.test(event.provider)) throw new Error("INVALID_EVENT_SOURCE_RECORD");
  const admission: JsonValue = event.admission.kind === "described"
    ? { kind: "described", text: event.admission.text } : { kind: event.admission.kind };
  const common: Record<string, JsonValue> = {
    provider: event.provider, sourceId: event.sourceId, sourceStatus: event.sourceStatus, title: event.title,
    category: event.category, region: event.region, placeName: event.placeName, publicAddress: event.publicAddress,
    admission, sourceUrl: event.sourceUrl, collectedAt: event.collectedAt, precision: event.precision,
  };
  for (const key of ["operatingInfo", "description", "posterUrl"] as const) {
    if (event[key] != null && event[key] !== "") common[key] = event[key]!;
  }
  return event.precision === "date"
    ? { ...common, startsOn: event.startsOn, endsOn: event.endsOn }
    : { ...common, startsAt: event.startsAt, endsAt: event.endsAt };
}

function count(value: JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalidResponse();
  return value;
}

function parseItem(raw: JsonValue): PublicEventItem {
  if (!isObject(raw)) return invalidResponse();
  const common = ["id", "provider", "sourceId", "sourceStatus", "title", "category", "region", "placeName", "publicAddress",
    "admission", "sourceUrl", "collectedAt", "state", "precision"];
  const timing = raw.precision === "date" ? ["startsOn", "endsOn"] : raw.precision === "instant" ? ["startsAt", "endsAt"] : null;
  const extras = ["operatingInfo", "description", "posterUrl", "performanceGenre"].filter((key) => Object.hasOwn(raw, key));
  if (!timing || !hasExactKeys(raw, [...common, ...timing, ...extras])) return invalidResponse();
  for (const key of extras.filter((key) => key !== "performanceGenre")) {
    const value = raw[key];
    if (value !== null && (typeof value !== "string" || value.length > 10000 || /[<>\u0000-\u001f]/u.test(value))) return invalidResponse();
  }
  if (raw.posterUrl != null) {
    let url: URL; try { url = new URL(raw.posterUrl as string); } catch { return invalidResponse(); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return invalidResponse();
  }
  if (typeof raw.id !== "string" || !uuidPattern.test(raw.id) || typeof raw.provider !== "string" || !providerPattern.test(raw.provider) ||
      raw.sourceStatus !== "active" || typeof raw.state !== "string" || !Object.hasOwn(stateRank, raw.state)) return invalidResponse();
  for (const field of ["category", "region", "placeName", "publicAddress", "sourceUrl"] as const) {
    if (raw[field] !== null && typeof raw[field] !== "string") return invalidResponse();
  }
  const admission = raw.admission;
  if (!isObject(admission) || !(
    ((admission.kind === "unknown" || admission.kind === "free") && hasExactKeys(admission, ["kind"])) ||
    (admission.kind === "described" && hasExactKeys(admission, ["kind", "text"]) && typeof admission.text === "string")
  )) return invalidResponse();
  const item = { ...raw } as unknown as PublicEventItem;
  try {
    assertSourceEventRecord(item);
    if (item.precision === "date") { parseCalendarDate(item.startsOn); parseCalendarDate(item.endsOn); }
  } catch { return invalidResponse(); }
  const performanceGenre = performanceGenreForSource(item.provider, item.category);
  if (Object.hasOwn(raw, "performanceGenre") && raw.performanceGenre !== performanceGenre) return invalidResponse();
  return { ...item, performanceGenre };
}

/** 행사 필터 값(제공처 원문). 2026-09-30 사용자 결정 U9-A: 값마다 제공처를 함께 둬 섞여도 구분한다. */
export interface EventFilterValue { provider: string; value: string; count: number }
export interface EventFilterValues { regions: EventFilterValue[]; categories: EventFilterValue[] }
/** 제안 05_event_filter_values.sql의 list_event_filter_values 응답을 엄격 검사한다. */
export async function listEventFilterValues(db: RpcClient): Promise<EventFilterValues> {
  const body = await db.rpc("list_event_filter_values", {});
  if (!isObject(body) || !hasExactKeys(body, ["regions", "categories"])) return invalidResponse();
  const list = (raw: JsonValue | undefined): EventFilterValue[] => {
    if (!Array.isArray(raw)) return invalidResponse();
    const seen = new Set<string>();
    return raw.map((item) => {
      if (!isObject(item) || !hasExactKeys(item, ["provider", "value", "count"]) || typeof item.provider !== "string" ||
          !providerPattern.test(item.provider) || typeof item.value !== "string" || !item.value.trim() || /<[^>]*>/.test(item.value)) return invalidResponse();
      const key = JSON.stringify([item.provider, item.value]);
      if (seen.has(key)) return invalidResponse();
      seen.add(key);
      return { provider: item.provider, value: item.value, count: count(item.count) };
    });
  };
  return { regions: list(body.regions), categories: list(body.categories) };
}

export function createRpcEventRepository(db: RpcClient): RpcEventRepository {
  if (!db || typeof db.rpc !== "function") throw new TypeError("RPC 클라이언트가 필요합니다.");
  return {
    async upsertBySourceIdentity(events) {
      if (!Array.isArray(events)) throw new Error("INVALID_EVENT_SOURCE_RECORD");
      const identities = new Set<string>();
      const wire = events.map((event) => {
        const item = toWireEvent(event);
        const identity = JSON.stringify([event.provider, event.sourceId]);
        if (identities.has(identity)) throw new Error("DUPLICATE_EVENT_IDENTITY");
        identities.add(identity);
        return item;
      });
      const body = await db.rpc("upsert_events", { p_events: wire });
      if (!isObject(body) || !hasExactKeys(body, ["receivedCount", "insertedCount", "updatedCount", "staleCount"])) {
        return invalidResponse();
      }
      const received = count(body.receivedCount), insertedCount = count(body.insertedCount);
      const updatedCount = count(body.updatedCount), staleCount = count(body.staleCount);
      if (received !== wire.length || insertedCount + updatedCount + staleCount !== received) return invalidResponse();
      return { savedCount: insertedCount + updatedCount, insertedCount, updatedCount, staleCount };
    },

    async listPage(query, cursor, limit) {
      const filters = normalizeEventPageQuery(query);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVENT_PAGE_MAX_LIMIT) throw new Error("INVALID_EVENT_LIMIT");
      const position = cursor === undefined ? null : decodeEventCursor(cursor, filters);
      const body = await db.rpc("list_public_events", {
        p_filters: filtersToRpc(filters),
        p_cursor: position ? { rank: position.rank, key: position.key, id: position.id } : null,
        p_limit: limit,
      });
      if (!isObject(body) || !hasExactKeys(body, ["items", "nextCursor"]) || !Array.isArray(body.items) ||
          body.items.length > limit) return invalidResponse();
      const period = filters.period ? queryPeriodInterval(filters.period) : null;
      const ids = new Set<string>();
      let previous: [number, number, string] | null = position
        ? [position.rank, Math.round(Number(position.key) * 1000), position.id] : null;
      const events = body.items.map((raw) => {
        const item = parseItem(raw);
        if (ids.has(item.id)) return invalidResponse();
        ids.add(item.id);
        // DB가 요청 조건을 지켰는지 확인한다. 조건 밖 행을 조용히 걸러 성공으로 만들지 않는다.
        if ((filters.mode !== "overlapping" && item.state === "ended") || (filters.ongoingOnly && item.state !== "ongoing") ||
            (filters.region !== null && normalizeEventRegion(item.region) !== filters.region) ||
            (filters.performanceGenre !== null && performanceGenreForSource(item.provider, item.category) !== filters.performanceGenre) ||
            (filters.freeOnly && item.admission.kind !== "free") ||
            (filters.category !== null && item.category !== filters.category) ||
            !matchesEventKeyword(item, filters.query)) return invalidResponse();
        const interval = eventIntervalOf(item);
        if (period && !(interval.start < period.endExclusive && interval.endExclusive > period.start)) return invalidResponse();
        const current: [number, number, string] = [stateRank[item.state], sortKeyMs(item), item.id];
        if (previous && !(current[0] > previous[0] || (current[0] === previous[0] &&
            (current[1] > previous[1] || (current[1] === previous[1] && current[2] > previous[2]))))) return invalidResponse();
        previous = current;
        return item;
      });
      let nextCursor: string | null = null;
      if (body.nextCursor !== null) {
        const next = body.nextCursor;
        const last = events.at(-1);
        if (!isObject(next) || !hasExactKeys(next, ["rank", "key", "id"]) || !last || events.length !== limit ||
            next.id !== last.id || next.rank !== stateRank[last.state] ||
            typeof next.key !== "string" || !cursorKeyPattern.test(next.key) ||
            Math.round(Number(next.key) * 1000) !== sortKeyMs(last)) return invalidResponse();
        nextCursor = encodeEventCursor(filters, { rank: stateRank[last.state], key: next.key, id: last.id });
      }
      return { events, nextCursor };
    },
  };
}
