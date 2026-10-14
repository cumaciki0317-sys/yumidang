/** 기존 culturalEventInfo 필드 정규화·응답 분류다. 확인된 HTTPS transport 전에는 호출하지 않는다.
 * 최신 OA-23041은 aiViewCulture를 안내하지만 실제 envelope·HTTPS·ongoing 계약이 미확인이라 신규 수집은 보류한다.
 * 최신 공식 문서: https://data.seoul.go.kr/dataList/openApiView.do?infId=OA-23041&srvType=A
 * 역사 참고 OA-15486: https://data.seoul.go.kr/dataList/OA-15486/A/1/datasetView.do
 */
import {
  createEventProviderAdapter,
  type EventProviderTransport,
} from "./adapter.ts";
import { parseCalendarDate } from "./normalize.ts";
import {
  EventProviderError,
  type EventProviderPort,
  type SourceEventRecord,
} from "./port.ts";
export const SEOUL_PROVIDER = "seoul-open-data";
export const SEOUL_MAX_ROWS = 1000;
export const SEOUL_MAX_PERIOD_DAYS = 31;
/** 절대 페이지 안전 상한이며 공식 총페이지 상한을 주장하지 않는다. 실행당5쪽과 별개다. */
export const SEOUL_MAX_PAGE = 999;
export interface SeoulCultureItem {
  TITLE: string;
  CODENAME?: string;
  GUNAME?: string;
  PLACE?: string;
  STRTDATE: string;
  END_DATE: string;
  IS_FREE?: string;
  USE_FEE?: string;
  HMPG_ADDR: string;
}
export interface ReviewedSeoulTransport
  extends EventProviderTransport<SeoulCultureItem> {
  /** 팀이 확인한 보안 연결 근거. 단순 환경 문자열로 HTTP 주소를 HTTPS로 바꾸지 않는다. */
  securityEvidence: {
    protocol: "https:";
    endpoint: string;
    decisionId: string;
  };
}
function plain(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || /[<>\u0000-\u001f]/u.test(value)) {
    throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  }
  return value.trim().replace(/\s+/gu, " ") || null;
}
function date(value: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?: 00:00:00(?:\.0)?)?$/.test(value)
  ) throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  const result = value.slice(0, 10);
  parseCalendarDate(result);
  return result;
}
export function normalizeSeoulCultureItem(
  raw: SeoulCultureItem,
  context: { provider: string; collectedAt: string },
): SourceEventRecord {
  const title = plain(raw.TITLE);
  if (!title) throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(raw.HMPG_ADDR);
  } catch {
    throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  }
  // 원천 상세URL의 문화행사코드를 그대로 사용. 제목/기간 해시로 수정 때 다른 행사를 만들지 않는다.
  const sourceId = sourceUrl.searchParams.get("cultcode");
  if (
    !["http:", "https:"].includes(sourceUrl.protocol) ||
    sourceUrl.hostname !== "culture.seoul.go.kr" ||
    sourceUrl.pathname !== "/culture/culture/cultureEvent/view.do" ||
    sourceUrl.username || sourceUrl.password ||
    !sourceId || !/^[1-9][0-9]{0,19}$/.test(sourceId)
  ) throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  const fee = plain(raw.USE_FEE);
  return {
    provider: context.provider,
    sourceId,
    sourceStatus: "active",
    title,
    precision: "date",
    startsOn: date(raw.STRTDATE),
    endsOn: date(raw.END_DATE),
    category: plain(raw.CODENAME),
    region: "서울특별시",
    placeName: plain(raw.PLACE),
    publicAddress: null,
    admission: raw.IS_FREE === "무료"
      ? { kind: "free" }
      : fee
      ? { kind: "described", text: fee }
      : { kind: "unknown" },
    sourceUrl: sourceUrl.href,
    collectedAt: context.collectedAt,
  };
}
export function classifySeoulCultureResponse(
  value: unknown,
  rows: number,
): { items: SeoulCultureItem[]; total: number } {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > SEOUL_MAX_ROWS || !object(value)) {
    throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  }
  // 미확인 신규 envelope나 서로 다른 응답 범위를 섞은 본문은 해석하지 않는다.
  const wrapped = Object.hasOwn(value, "culturalEventInfo");
  if (Object.hasOwn(value, "aiViewCulture") || (wrapped && (
    !object(value.culturalEventInfo) || Object.keys(value).length !== 1
  ))) throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  const data = wrapped ? value.culturalEventInfo as Record<string, unknown> : value;
  if (Object.keys(data).some(key => !["RESULT", "list_total_count", "row"].includes(key))) {
    throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  }
  const result = data.RESULT;
  if (!object(result) || typeof result.CODE !== "string") {
    throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  }
  if (result.CODE === "INFO-200") {
    if ((Object.hasOwn(data, "list_total_count") && data.list_total_count !== 0) ||
      (Object.hasOwn(data, "row") && (!Array.isArray(data.row) || data.row.length !== 0))) {
      throw new EventProviderError("SOURCE_INVALID_RESPONSE");
    }
    return { items: [], total: 0 };
  }
  if (result.CODE === "INFO-100") throw new EventProviderError("SOURCE_AUTH_REJECTED");
  if (result.CODE === "ERROR-500" || result.CODE === "ERROR-600") {
    throw new EventProviderError("SOURCE_UNAVAILABLE");
  }
  if (result.CODE !== "INFO-000") {
    throw new EventProviderError("SOURCE_REJECTED");
  }
  if (
    !Number.isSafeInteger(data.list_total_count) ||
    (data.list_total_count as number) < 0 ||
    !Array.isArray(data.row) || data.row.length > rows ||
    (data.list_total_count as number) < data.row.length || !data.row.every(object)
  ) throw new EventProviderError("SOURCE_INVALID_RESPONSE");
  return {
    items: data.row as SeoulCultureItem[],
    total: data.list_total_count as number,
  };
}
export function createSeoulEventProvider(
  options: { transport?: ReviewedSeoulTransport; now: () => Date },
): EventProviderPort {
  const transport = options.transport;
  if (!transport) {
    return {
      provider: SEOUL_PROVIDER,
      async fetchPage() {
        throw new EventProviderError("EVENT_PROVIDER_UNCONFIGURED");
      },
    };
  }
  let endpoint: URL;
  try {
    endpoint = new URL(transport.securityEvidence.endpoint);
  } catch {
    throw new EventProviderError("EVENT_PROVIDER_UNCONFIGURED");
  }
  if (
    endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
    endpoint.hash ||
    transport.securityEvidence.protocol !== "https:" ||
    !transport.securityEvidence.decisionId?.trim()
  ) throw new EventProviderError("EVENT_PROVIDER_UNCONFIGURED");
  return createEventProviderAdapter({
    provider: SEOUL_PROVIDER,
    transport,
    normalize: normalizeSeoulCultureItem,
    now: options.now,
  });
}
