/**
 * 한국관광공사 TourAPI(국문 관광정보 KorService2) 행사·축제 목록 제공처. 두 번째 행사 공급사(2026-09-30 사용자 결정 U10).
 * 고정 HTTPS 목적지 `https://apis.data.go.kr/B551011/KorService2/searchFestival2`, JSON 응답.
 * 2026-09-30 확인: 발급 키는 인코딩 대상 문자가 없어 encoded/decoded 두 방식 모두 결과 코드 0000 → 로컬 `TOUR_API_KEY_FORMAT=decoded`.
 * 전화번호·좌표·이미지·지도 수준은 저장하지 않는다. 공식 상세 링크 필드가 없어 sourceUrl은 null이다.
 */
import { createEventProviderAdapter, type EventProviderTransport } from "./adapter.ts";
import { parseCalendarDate } from "./normalize.ts";
import { EventProviderError } from "./port.ts";
import type { EventFetchRequest, EventProviderPort, SourceEventRecord } from "./port.ts";
import type { TourApiKeyFormat } from "../../config/providers.ts";

export const TOUR_API_PROVIDER = "tour-api";
const endpoint = "https://apis.data.go.kr/B551011/KorService2/searchFestival2";
/** 요청 크기의 기술 상한(공급사 최대치 문서 미확인 → KOPIS와 같은 보수 값). 운영 수집량은 환경값으로 정한다. */
export const TOUR_API_MAX_PERIOD_DAYS = 31;
export const TOUR_API_MAX_ROWS = 100;
export const TOUR_API_MAX_PAGE = 999;
/** TourAPI 콘텐츠 유형 15의 공식 이름. 개별 분류 코드(lclsSystm)는 이름이 아닌 코드라 표시 값으로 쓰지 않는다. */
export const TOUR_API_CATEGORY = "행사/공연/축제";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export interface TourApiEventConfig {
  serviceKey: string;
  keyFormat: TourApiKeyFormat;
  timeoutMs: number;
  rows: number;
  fetch: FetchLike;
}
export interface TourApiFestivalItem {
  contentid: string;
  title: string;
  eventstartdate: string;
  eventenddate: string;
  addr1?: string;
  addr2?: string;
}

function tourDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) throw new Error("INVALID_EVENT_DATE");
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  parseCalendarDate(iso);
  return iso;
}
function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || /<[^>]*>/.test(value)) throw new Error("INVALID_EVENT_PUBLIC_TEXT");
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed ? trimmed : null;
}

export function normalizeTourApiFestival(raw: TourApiFestivalItem, context: { provider: string; collectedAt: string }): SourceEventRecord {
  const title = text(raw.title);
  if (typeof raw.contentid !== "string" || !/^\d{1,20}$/.test(raw.contentid) || title === null) throw new Error("INVALID_EVENT_SOURCE_RECORD");
  const address = text(raw.addr1);
  return {
    provider: context.provider, sourceId: raw.contentid, sourceStatus: "active", precision: "date",
    startsOn: tourDate(raw.eventstartdate), endsOn: tourDate(raw.eventenddate), title,
    category: TOUR_API_CATEGORY,
    // 공식 주소의 첫 단어(시·도)만 지역으로 쓴다. 다른 제공처 값과 매핑·병합하지 않는다.
    region: address ? address.split(" ")[0] : null,
    placeName: text(raw.addr2), publicAddress: address,
    admission: { kind: "unknown" }, sourceUrl: null, collectedAt: context.collectedAt,
  };
}

/** 200 응답 안의 공급사 오류도 실패다. data.go.kr 공통 오류는 XML(returnReasonCode)로 올 수 있다. */
export function classifyTourApiResponse(body: string, rows: number, page: number): { items: TourApiFestivalItem[]; hasMore: boolean } {
  let json: unknown;
  try { json = JSON.parse(body); } catch {
    const code = /<returnReasonCode>(\d+)<\/returnReasonCode>/.exec(body)?.[1];
    if (code === "30" || code === "31" || code === "32") throw new EventProviderError("SOURCE_AUTH_REJECTED");
    if (code === "22") throw new EventProviderError("SOURCE_RATE_LIMITED");
    throw new EventProviderError(code ? "SOURCE_REJECTED" : "SOURCE_INVALID_RESPONSE");
  }
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const response = record(json) ? json.response : undefined;
  if (!record(response) || !record(response.header) || typeof response.header.resultCode !== "string") {
    throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  }
  if (response.header.resultCode !== "0000") throw new EventProviderError("SOURCE_REJECTED");
  const bodyPart = response.body;
  if (!record(bodyPart)) throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  const rawTotal = bodyPart.totalCount;
  // 숫자 또는 명시적인 정수 문자열만 받는다. null/빈 문자열/boolean을 0으로 바꾸지 않는다.
  if (typeof rawTotal !== "number" && !(typeof rawTotal === "string" && /^(0|[1-9][0-9]*)$/.test(rawTotal))) {
    throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  }
  const total = Number(rawTotal);
  if (!Number.isSafeInteger(total) || total < 0) throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  const container = bodyPart.items;
  // 정상 빈 응답의 items:""와 item:[]는 유지한다. 누락·잘못된 컨테이너를 빈 배열로 대체하지 않는다.
  let rawItems: unknown[];
  if (container === "") rawItems = [];
  else if (record(container) && Object.hasOwn(container, "item")) {
    if (Array.isArray(container.item)) rawItems = container.item;
    else if (record(container.item)) rawItems = [container.item];
    else throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  } else throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  const remaining = Math.max(0, total - (page - 1) * rows);
  if (rawItems.length > Math.min(rows, remaining) || (remaining > 0 && rawItems.length === 0)) {
    throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  }
  const seen = new Set<string>();
  const items = rawItems.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new EventProviderError("SOURCE_INVALID_RESPONSE");
    const r = item as Record<string, unknown>;
    if (typeof r.contentid !== "string" || seen.has(r.contentid)) throw new EventProviderError("SOURCE_INVALID_RESPONSE");
    seen.add(r.contentid);
    return { contentid: r.contentid, title: r.title as string, eventstartdate: r.eventstartdate as string, eventenddate: r.eventenddate as string,
      ...(r.addr1 !== undefined ? { addr1: r.addr1 as string } : {}), ...(r.addr2 !== undefined ? { addr2: r.addr2 as string } : {}) };
  });
  return { items, hasMore: page * rows < total && page < TOUR_API_MAX_PAGE };
}

export function createTourApiTransport(config: TourApiEventConfig): EventProviderTransport<TourApiFestivalItem> {
  if (!config || typeof config.serviceKey !== "string" || !config.serviceKey || /[\s\u0000-\u001f\u007f]/u.test(config.serviceKey) ||
      (config.keyFormat !== "encoded" && config.keyFormat !== "decoded") || typeof config.fetch !== "function" ||
      !Number.isInteger(config.rows) || config.rows < 1 || config.rows > TOUR_API_MAX_ROWS ||
      !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2_147_483_647) {
    // 키 형식 unknown은 요청하지 않는다(민규 설정 계약).
    throw new EventProviderError("EVENT_PROVIDER_UNCONFIGURED");
  }
  const { serviceKey, keyFormat, timeoutMs, rows, fetch: transport } = config;
  return {
    async fetchPage(request: EventFetchRequest) {
      if (!request || request.cursor !== undefined || !request.period ||
          !Number.isInteger(request.page) || request.page! < 1 || request.page! > TOUR_API_MAX_PAGE) throw new EventProviderError("INVALID_EVENT_REQUEST");
      const page = request.page!;
      let start: Date, end: Date;
      try { start = parseCalendarDate(request.period.start); end = parseCalendarDate(request.period.end); }
      catch { throw new EventProviderError("INVALID_EVENT_REQUEST"); }
      const days = (end.getTime() - start.getTime()) / 86_400_000 + 1;
      if (!Number.isInteger(days) || days < 1 || days > TOUR_API_MAX_PERIOD_DAYS) throw new EventProviderError("INVALID_EVENT_REQUEST");
      const params = new URLSearchParams({ MobileOS: "ETC", MobileApp: "yumidang", _type: "json", numOfRows: String(rows), pageNo: String(page),
        eventStartDate: request.period.start.replaceAll("-", ""), eventEndDate: request.period.end.replaceAll("-", "") });
      // decoded는 URLSearchParams가 한 번 인코딩한다. encoded는 이미 인코딩된 값을 그대로 붙여 이중 인코딩하지 않는다.
      const keyPart = keyFormat === "decoded" ? new URLSearchParams({ serviceKey }).toString() : `serviceKey=${serviceKey}`;
      const url = `${endpoint}?${keyPart}&${params.toString()}`;
      const controller = new AbortController();
      let timedOut = false;
      const cancel = () => controller.abort();
      request.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        if (request.signal?.aborted) throw new EventProviderError("CANCELLED");
        const response = await transport(url, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal,
          redirect: "error", credentials: "omit", cache: "no-store" });
        if (response.status === 401 || response.status === 403) throw new EventProviderError("SOURCE_AUTH_REJECTED");
        if (response.status === 429) throw new EventProviderError("SOURCE_RATE_LIMITED");
        if (response.status >= 500) throw new EventProviderError("SOURCE_UNAVAILABLE");
        if (response.status !== 200) throw new EventProviderError("SOURCE_REJECTED");
        const { items, hasMore } = classifyTourApiResponse(await response.text(), rows, page);
        return { items, ...(hasMore ? { nextCursor: String(page + 1) } : {}) };
      } catch (error) {
        if (controller.signal.aborted) throw new EventProviderError(timedOut ? "SOURCE_TIMEOUT" : "CANCELLED");
        if (error instanceof EventProviderError) throw error;
        // 주소·키가 담긴 원문 오류를 전달하지 않는다.
        throw new EventProviderError("SOURCE_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", cancel);
      }
    },
  };
}

export function createTourApiEventProvider(config: TourApiEventConfig & { now: () => Date }): EventProviderPort {
  return createEventProviderAdapter({
    provider: TOUR_API_PROVIDER, transport: createTourApiTransport(config), normalize: normalizeTourApiFestival, now: config.now,
  });
}
