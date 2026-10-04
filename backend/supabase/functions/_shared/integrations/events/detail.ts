/** 원천 상세 수집 포트. 화면에 없는 내용을 만들거나 상세 지점을 회원 정보와 결합하지 않는다. */
import {
  type FetchLike,
  type KopisListItem,
  normalizeKopisListItem,
  parseFlatDbsXml,
} from "./kopis.ts";
import {
  type EventAdmission,
  EventProviderError,
  type SourceEventRecord,
} from "./port.ts";
import { parseCalendarDate } from "./normalize.ts";
export interface SourceEventDetail {
  provider: string;
  sourceId: string;
  collectedAt: string;
  admission: EventAdmission;
  operatingInfo: string | null;
  description: string | null;
  posterUrl: string | null;
}
export interface EventDetailProviderPort {
  provider: string;
  fetchDetail(
    sourceId: string,
    signal?: AbortSignal,
  ): Promise<SourceEventDetail>;
}
export interface EventDetailStore {
  /** 해당 행사 identity와 수집 시각을 검사한 후 같은 원천 레코드에 저장한다. */
  save(input: SourceEventDetail): Promise<"applied" | "stale">;
}
const invalid = (): never => {
  throw new EventProviderError("SOURCE_INVALID_RESPONSE");
};
const plain = (value: unknown): string | null => {
  if (value === undefined || value === "") return null;
  if (
    typeof value !== "string" || value.length > 10000 ||
    /[<>\u0000-\u001f]/u.test(value)
  ) return invalid();
  return value.trim() || null;
};
function flattenDetailXml(xml: string): string {
  if (typeof xml !== "string" || xml.length > 2000000) return invalid();
  let nested = 0;
  let flattened = xml.replace(
    /<styurls>([\s\S]*?)<\/styurls>/g,
    (_all, body) => {
      nested++;
      if (nested > 1) return invalid();
      const images = body.replace(
        /<styurl>([\s\S]*?)<\/styurl>/g,
        "<db><url>$1</url></db>",
      );
      parseFlatDbsXml(`<dbs>${images}</dbs>`);
      return "";
    },
  );
  let relates = 0;
  flattened = flattened.replace(
    /<relates>([\s\S]*?)<\/relates>/g,
    (_all, body) => {
      if (++relates > 1) return invalid();
      const records = parseFlatDbsXml(
        `<dbs>${
          body.replace(/<relate>/g, "<db>").replace(/<\/relate>/g, "</db>")
        }</dbs>`,
      );
      for (const row of records) {
        if (
          Object.keys(row).some((k) => !["relatenm", "relateurl"].includes(k))
        ) return invalid();
      }
      return "";
    },
  );
  return flattened;
}
/** 공식 중첩 소개이미지·예매처 목록은 검사 후 공개 원천정보에서 제외한다. */
export function parseKopisDetailXml(
  xml: string,
  sourceId: string,
  collectedAt: string,
): SourceEventDetail {
  if (!/^PF[0-9A-Za-z]+$/.test(sourceId)) return invalid();
  const records = parseFlatDbsXml(flattenDetailXml(xml));
  if (records.length !== 1) return invalid();
  const raw = records[0];
  const fields = new Set([
    "mt20id",
    "mt10id",
    "mt13id",
    "prfnm",
    "fcltynm",
    "frstregdt",
    "prfpdfrom",
    "prfpdto",
    "prfcast",
    "prfcrew",
    "prfruntime",
    "prfage",
    "entrpsnm",
    "entrpsnmP",
    "entrpsnmA",
    "entrpsnmH",
    "entrpsnmS",
    "pcseguidance",
    "poster",
    "sty",
    "area",
    "genrenm",
    "openrun",
    "visit",
    "child",
    "daehakro",
    "festival",
    "musicallicense",
    "musicalcreate",
    "updatedate",
    "prfstate",
    "dtguidance",
  ]);
  if (raw.mt20id !== sourceId || Object.keys(raw).some((k) => !fields.has(k))) {
    return invalid();
  }
  for (const key of ["prfpdfrom", "prfpdto"]) {
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(raw[key] ?? "")) return invalid();
    parseCalendarDate(raw[key].replaceAll(".", "-"));
  }
  if (raw.prfpdto < raw.prfpdfrom) return invalid();
  const fee = plain(raw.pcseguidance);
  const poster = plain(raw.poster);
  let posterUrl: string | null = null;
  if (poster) {
    let url: URL;
    try {
      url = new URL(poster);
    } catch {
      return invalid();
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["kopis.or.kr", "www.kopis.or.kr"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith("/upload/")
    ) return invalid();
    // 원천 HTTP 이미지를 임의로 HTTPS로 바꾸지 않는다. HTTPS 원본만 화면에 제공한다.
    if (url.protocol === "https:") posterUrl = url.href;
  }
  if (!Number.isFinite(Date.parse(collectedAt))) return invalid();
  return {
    provider: "kopis",
    sourceId,
    collectedAt,
    admission: fee ? { kind: "described", text: fee } : { kind: "unknown" },
    operatingInfo: plain(raw.dtguidance),
    description: plain(raw.sty),
    posterUrl,
  };
}
export interface KopisDetailProviderPort extends EventDetailProviderPort {
  fetchSourceEvent(
    sourceId: string,
    signal?: AbortSignal,
  ): Promise<SourceEventRecord>;
}
export function createKopisDetailProvider(
  options: {
    apiKey: string;
    timeoutMs: number;
    fetch: FetchLike;
    now: () => Date;
  },
): KopisDetailProviderPort {
  if (
    !/^[A-Za-z0-9_-]{1,512}$/.test(options.apiKey) ||
    !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
    options.timeoutMs > 15000
  ) throw new EventProviderError("INVALID_EVENT_REQUEST");
  const fetchXml = async (sourceId: string, signal?: AbortSignal) => {
    if (!/^PF[0-9A-Za-z]+$/.test(sourceId)) {
      throw new EventProviderError("INVALID_EVENT_REQUEST");
    }
    signal?.throwIfAborted();
    const url = new URL(
      `https://kopis.or.kr/openApi/restful/pblprfr/${sourceId}`,
    );
    url.searchParams.set("service", options.apiKey);
    const timeout = AbortSignal.timeout(options.timeoutMs);
    try {
      const response = await options.fetch(url.href, {
        method: "GET",
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        throw new EventProviderError(
          response.status === 429
            ? "SOURCE_RATE_LIMITED"
            : "SOURCE_UNAVAILABLE",
        );
      }
      if (
        !/(?:application|text)\/xml/i.test(
          response.headers.get("content-type") ?? "",
        )
      ) return invalid();
      const body = await response.text();
      signal?.throwIfAborted();
      if (body.length > 2000000) return invalid();
      return body;
    } catch (error) {
      if (error instanceof EventProviderError) throw error;
      throw new EventProviderError(
        signal?.aborted
          ? "CANCELLED"
          : timeout.aborted
          ? "SOURCE_TIMEOUT"
          : "SOURCE_UNAVAILABLE",
      );
    }
  };
  return {
    provider: "kopis",
    async fetchDetail(sourceId, signal) {
      return parseKopisDetailXml(
        await fetchXml(sourceId, signal),
        sourceId,
        options.now().toISOString(),
      );
    },
    async fetchSourceEvent(sourceId, signal) {
      const xml = await fetchXml(sourceId, signal),
        collectedAt = options.now().toISOString();
      const detail = parseKopisDetailXml(xml, sourceId, collectedAt),
        raw = parseFlatDbsXml(flattenDetailXml(xml))[0];
      const keys = [
        "mt20id",
        "prfnm",
        "prfpdfrom",
        "prfpdto",
        "prfstate",
        "fcltynm",
        "area",
        "genrenm",
      ];
      const normalized = normalizeKopisListItem(
        Object.fromEntries(
          keys.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]),
        ) as unknown as KopisListItem,
        { provider: "kopis", collectedAt },
      );
      return {
        ...normalized,
        admission: detail.admission,
        ...(detail.operatingInfo
          ? { operatingInfo: detail.operatingInfo }
          : {}),
        ...(detail.description ? { description: detail.description } : {}),
        ...(detail.posterUrl ? { posterUrl: detail.posterUrl } : {}),
      };
    },
  };
}
export async function collectEventDetail(
  provider: EventDetailProviderPort,
  sourceId: string,
  store?: EventDetailStore,
  signal?: AbortSignal,
): Promise<{ status: "applied" | "stale" | "not_enabled"; reason?: string }> {
  if (!store) {
    return {
      status: "not_enabled",
      reason: "DETAIL_PERSISTENCE_NOT_CONNECTED",
    };
  }
  const result = await provider.fetchDetail(sourceId, signal);
  signal?.throwIfAborted();
  if (result.provider !== provider.provider || result.sourceId !== sourceId) {
    return invalid();
  }
  const status = await store.save(result);
  if (!["applied", "stale"].includes(status)) return invalid();
  return { status };
}
