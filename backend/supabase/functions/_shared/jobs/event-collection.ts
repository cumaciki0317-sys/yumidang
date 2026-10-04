/** 행사 수집의 영속 진행 포트. DB RPC 채택 전에는 메모리 진행을 운영 성공으로 대신하지 않는다. */
import { kopisRankingPeriod } from "../integrations/events/kopis-ranking.ts";
import type {
  EventPeriod,
  EventProviderPort,
  SourceEventRecord,
} from "../integrations/events/port.ts";
import {
  addCalendarDays,
  addCalendarMonths,
  assertSourceEventRecord,
  parseCalendarDate,
  seoulCalendarDate,
} from "../integrations/events/normalize.ts";

export type EventCollectionLane =
  | "initial_history"
  | "future"
  | "ongoing"
  | "ranking_all"
  | "ranking_musical"
  | "detail";
export interface EventCollectionReference {
  provider: string;
  lane: EventCollectionLane;
  /** 등록한 날짜의 범위. 재개 도중 오늘 날짜로 바꾸지 않는다. */
  period: EventPeriod;
  /** 상세 lane만 사용하며 원문은 작업 payload에 넣지 않는다. */
  sourceId?: string;
  sourceCollectedAt?: string;
}
export interface EventCollectionProgress extends EventCollectionReference {
  jobId: string;
  leaseToken: string;
  nextPage: number;
  cursor?: string;
  collectedPages: number;
  /** ongoing은 진행 중 원천 ID를 별도 조회·갱신하는 제공처별 포트를 사용한다. */
}
export interface EventCollectionStore {
  /** DB가 현재 lease와 영속 진행을 반환. 원천 내용을 작업 payload에 넣지 않는다. */
  load(
    reference: EventCollectionReference,
  ): Promise<EventCollectionProgress | "not_claimed">;
  /** 원천 upsert + 다음 진행 + 종결을 같은 DB 트랜잭션에서 적용. 오래된 lease는 거절한다. */
  commitPage(input: {
    progress: EventCollectionProgress;
    events: readonly SourceEventRecord[];
    next: { page: number; cursor?: string } | null;
  }): Promise<"applied" | "lease_lost">;
}
export interface EventCollectionResult {
  status: "complete" | "partial" | "lease_lost" | "not_claimed" | "not_enabled";
  pages: number;
  fetchedCount: number;
  nextPage?: number;
  reason?:
    | "PERSISTENCE_NOT_CONNECTED"
    | "ONGOING_PROVIDER_NOT_CONNECTED"
    | "PROVIDER_PAGE_LIMIT";
}

/** 최근 한 달은 달력상 한 달이며 공급사별 요청 기간 31일 이내로 분할한다. */
export function eventCollectionPlan(
  now: Date,
  provider: string,
  maxPeriodDays = 31,
): EventCollectionReference[] {
  if (
    !/^[a-z0-9-]{1,32}$/.test(provider) ||
    !Number.isSafeInteger(maxPeriodDays) || maxPeriodDays < 1 ||
    maxPeriodDays > 31
  ) {
    throw new Error("INVALID_EVENT_COLLECTION_PLAN");
  }
  const today = seoulCalendarDate(now);
  const references: EventCollectionReference[] = [];
  function split(lane: EventCollectionLane, start: string, end: string) {
    while (start <= end) {
      const windowEnd = addCalendarDays(start, maxPeriodDays - 1);
      const last = windowEnd < end ? windowEnd : end;
      references.push({ provider, lane, period: { start, end: last } });
      start = addCalendarDays(last, 1);
    }
  }
  split(
    "initial_history",
    addCalendarMonths(today, -1),
    addCalendarDays(today, -1),
  );
  split("future", today, addCalendarDays(today, 30));
  references.push({
    provider,
    lane: "ongoing",
    period: { start: today, end: today },
  });
  if (provider === "kopis") {
    const period = kopisRankingPeriod(now);
    references.push({ provider, lane: "ranking_all", period }, {
      provider,
      lane: "ranking_musical",
      period,
    });
  }
  return references;
}

function validateProgress(
  progress: EventCollectionProgress,
  reference: EventCollectionReference,
) {
  if (
    progress.provider !== reference.provider ||
    progress.lane !== reference.lane ||
    progress.period.start !== reference.period.start ||
    progress.period.end !== reference.period.end ||
    !progress.jobId?.trim() || !progress.leaseToken?.trim() ||
    !Number.isSafeInteger(progress.nextPage) || progress.nextPage < 1 ||
    !Number.isSafeInteger(progress.collectedPages) ||
    progress.collectedPages < 0 ||
    (progress.cursor !== undefined &&
      (typeof progress.cursor !== "string" || !progress.cursor.trim()))
  ) throw new Error("INVALID_EVENT_COLLECTION_PROGRESS");
}

/** 한 실행 최대5쪽. 제한 도달은 partial이고 다음 실제 공급사 페이지부터 재개한다. */
export async function runEventCollection(input: {
  reference: EventCollectionReference;
  provider: EventProviderPort;
  /** 진행 중 조회는 일반 시작일 검색과 다른 원천 조회다. 없으면 성공 빈 목록으로 바꾸지 않는다. */
  ongoingProvider?: EventProviderPort;
  store?: EventCollectionStore;
  maxPages: number;
  providerMaxPage: number;
  signal?: AbortSignal;
}): Promise<EventCollectionResult> {
  const { reference, store, signal } = input;
  parseCalendarDate(reference.period.start);
  parseCalendarDate(reference.period.end);
  if (
    !/^[a-z0-9-]{1,32}$/.test(reference.provider) ||
    !["initial_history", "future", "ongoing"].includes(reference.lane) ||
    reference.period.end < reference.period.start ||
    reference.period.end > addCalendarDays(reference.period.start, 30) ||
    !Number.isSafeInteger(input.maxPages) || input.maxPages < 1 ||
    input.maxPages > 5 ||
    !Number.isSafeInteger(input.providerMaxPage) || input.providerMaxPage < 1
  ) throw new Error("INVALID_EVENT_COLLECTION_SETTINGS");
  const base = { pages: 0, fetchedCount: 0 };
  if (!store) {
    return {
      ...base,
      status: "not_enabled",
      reason: "PERSISTENCE_NOT_CONNECTED",
    };
  }
  const provider = reference.lane === "ongoing"
    ? input.ongoingProvider
    : input.provider;
  if (!provider) {
    return {
      ...base,
      status: "not_enabled",
      reason: "ONGOING_PROVIDER_NOT_CONNECTED",
    };
  }
  if (provider.provider !== reference.provider) {
    throw new Error("EVENT_PROVIDER_CONTEXT_MISMATCH");
  }
  signal?.throwIfAborted();
  let progress = await store.load(reference);
  if (progress === "not_claimed") return { ...base, status: "not_claimed" };
  validateProgress(progress, reference);
  let pages = 0, fetchedCount = 0;
  while (pages < input.maxPages) {
    signal?.throwIfAborted();
    if (progress.nextPage > input.providerMaxPage) {
      return {
        status: "partial",
        pages,
        fetchedCount,
        nextPage: progress.nextPage,
        reason: "PROVIDER_PAGE_LIMIT",
      };
    }
    const page = await provider.fetchPage({
      period: reference.period,
      page: progress.nextPage,
      ...(progress.cursor !== undefined ? { cursor: progress.cursor } : {}),
      signal,
    });
    signal?.throwIfAborted();
    if (
      !page || !Array.isArray(page.events) ||
      (page.nextCursor !== undefined &&
        (typeof page.nextCursor !== "string" || !page.nextCursor.trim() ||
          page.nextCursor === progress.cursor))
    ) {
      throw new Error("INVALID_EVENT_COLLECTION_PAGE");
    }
    const seen = new Set<string>();
    for (const event of page.events) {
      assertSourceEventRecord(event);
      if (event.provider !== reference.provider || seen.has(event.sourceId)) {
        throw new Error("EVENT_PROVIDER_CONTEXT_MISMATCH");
      }
      seen.add(event.sourceId);
    }
    const next: { page: number; cursor: string } | null =
      page.nextCursor === undefined
        ? null
        : { page: progress.nextPage + 1, cursor: page.nextCursor };
    const saved = await store.commitPage({
      progress,
      events: page.events,
      next,
    });
    if (saved === "lease_lost") {
      return { status: "lease_lost", pages, fetchedCount };
    }
    if (saved !== "applied") {
      throw new Error("INVALID_EVENT_COLLECTION_STORE_RESPONSE");
    }
    pages += 1;
    fetchedCount += page.events.length;
    if (!next) return { status: "complete", pages, fetchedCount };
    progress = {
      ...progress,
      nextPage: next.page,
      cursor: next.cursor,
      collectedPages: progress.collectedPages + 1,
    };
  }
  return {
    status: "partial",
    pages,
    fetchedCount,
    nextPage: progress.nextPage,
  };
}

export interface EventCollectionRegistrationPort {
  /** DB 트랜잭션으로 최초 과거 등록 여부를 판정하고 중복 없는 예약을 만든다. */
  register(
    input: {
      provider: string;
      registeredOn: string;
      references: EventCollectionReference[];
    },
  ): Promise<{
    status: "registered";
    createdCount: number;
    existingCount: number;
    initialHistory: "registered" | "already_registered";
  }>;
}
/** 등록 자체가 한 공급사 트랜잭션이어야 한다. 최초 과거 수집은 매일 새 초기화하지 않는다. */
export async function registerDailyEventCollections(input: {
  now: Date;
  providers: string[];
  maxPeriodDays: number;
  registration?: EventCollectionRegistrationPort;
}): Promise<
  {
    status: "registered" | "not_enabled";
    reason?: string;
    createdCount: number;
    existingCount: number;
  }
> {
  if (
    !Array.isArray(input.providers) || !input.providers.length ||
    new Set(input.providers).size !== input.providers.length
  ) throw new Error("INVALID_EVENT_COLLECTION_PLAN");
  // 등록 포트가 미연결이면 원천 호출·임시 진행 저장을 하지 않는다.
  if (!input.registration) {
    return {
      status: "not_enabled",
      reason: "EVENT_COLLECTION_REGISTRATION_NOT_CONNECTED",
      createdCount: 0,
      existingCount: 0,
    };
  }
  let createdCount = 0, existingCount = 0;
  for (const provider of input.providers) {
    const result = await input.registration.register({
      provider,
      registeredOn: seoulCalendarDate(input.now),
      references: eventCollectionPlan(input.now, provider, input.maxPeriodDays),
    });
    if (
      !result || result.status !== "registered" ||
      !Number.isSafeInteger(result.createdCount) || result.createdCount < 0 ||
      !Number.isSafeInteger(result.existingCount) || result.existingCount < 0 ||
      !["registered", "already_registered"].includes(result.initialHistory)
    ) throw new Error("INVALID_EVENT_COLLECTION_REGISTRATION");
    createdCount += result.createdCount;
    existingCount += result.existingCount;
  }
  return { status: "registered", createdCount, existingCount };
}
