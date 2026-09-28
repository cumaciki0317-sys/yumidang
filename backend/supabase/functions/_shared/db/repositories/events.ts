/** 실제 DB/RPC는 민규 연결 계약 확정 후 주입한다. 테이블명·권한을 가정하지 않는다. */
import type { EventProviderPort, EventQuery, EventFetchRequest, SourceEventRecord, StoredEventRecord } from "../../integrations/events/port.ts";
import { assertSourceEventRecord } from "../../integrations/events/normalize.ts";
import { selectEvents } from "../../services/event-service.ts";

export interface EventRepositoryPort {
  /** provider + sourceId 유일 제약으로 upsert. 제공처가 다른 유사 행사는 자동 병합하지 않는다. */
  upsertBySourceIdentity(events: readonly SourceEventRecord[]): Promise<{ savedCount: number }>;
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
  if (Object.keys(query).some((key) => !["mode", "now", "period", "ongoingOnly", "region", "category", "query"].includes(key))) {
    throw new Error("UNSUPPORTED_EVENT_FILTER");
  }
  for (const field of ["region", "category"] as const) {
    if (query[field] !== undefined && (typeof query[field] !== "string" || !query[field].trim())) {
      throw new Error("INVALID_EVENT_FILTER");
    }
  }
  const { query: rawQuery, region, category, ...timingQuery } = query;
  const keyword = normalizeEventKeyword(rawQuery === undefined ? "" : rawQuery);
  selectEvents([], timingQuery); // 잘못된 필터를 실제 DB 요청 전에 거절한다.
  const events = await repository.listCandidates({ ...query, query: keyword });
  return selectEvents(events, timingQuery).filter((event) =>
    matchesEventKeyword(event, keyword) &&
    (region === undefined || event.region === region) && (category === undefined || event.category === category)
  );
}

/** 한 페이지 단위 저장. provider 장애/정규화 실패 시 저장을 시작하지 않는다. */
export async function syncEventPage(provider: EventProviderPort, repository: EventRepositoryPort, request: EventFetchRequest) {
  request.signal?.throwIfAborted();
  const page = await provider.fetchPage(request);
  request.signal?.throwIfAborted();
  for (const event of page.events) {
    assertSourceEventRecord(event);
    if (event.provider !== provider.provider) throw new Error("EVENT_PROVIDER_CONTEXT_MISMATCH");
  }
  const saved = await repository.upsertBySourceIdentity(page.events);
  return { ...saved, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) };
}
