/** KOPIS v5.0 boxoffice 공식 순위. 자체 집계나 시작일 정렬을 순위로 대신하지 않는다. */
import { type FetchLike, parseFlatDbsXml } from "./kopis.ts";
import {
  addCalendarDays,
  normalizeEventRegion,
  parseCalendarDate,
  seoulCalendarDate,
} from "./normalize.ts";
import { type EventPeriod, EventProviderError } from "./port.ts";
export type KopisRankingMode = "all" | "musical";
export interface KopisRankingItem {
  rank: number;
  sourceId: string;
  title: string;
  genre: string;
  performancePeriodText: string;
  placeName: string;
  region: string;
}
export interface VerifiedKopisRanking {
  mode: KopisRankingMode;
  requestedPeriod: EventPeriod;
  responsePeriod: EventPeriod;
  periodVerification: "verified";
  collectedAt: string;
  items: KopisRankingItem[];
}
export interface PublicKopisRanking {
  status: "available" | "unavailable";
  mode: KopisRankingMode;
  sourceName: "KOPIS";
  period: EventPeriod | null;
  collectedAt: string | null;
  items: KopisRankingItem[];
}
export function kopisRankingPeriod(now: Date): EventPeriod {
  const end = addCalendarDays(seoulCalendarDate(now), -1);
  return { start: addCalendarDays(end, -6), end };
}
const invalid = (): never => {
  throw new EventProviderError("SOURCE_INVALID_RESPONSE");
};
const plain = (v: unknown): string => {
  if (typeof v !== "string" || !v.trim() || /[<>\u0000-\u001f]/u.test(v)) {
    return invalid();
  }
  return v.trim();
};
export function parseKopisRankingXml(
  xml: string,
  mode: KopisRankingMode,
  period: EventPeriod,
  now: Date,
): VerifiedKopisRanking {
  parseCalendarDate(period.start);
  parseCalendarDate(period.end);
  if (
    !["all", "musical"].includes(mode) ||
    (period.start !== kopisRankingPeriod(now).start ||
      period.end !== kopisRankingPeriod(now).end)
  ) return invalid();
  // 루트의 basedate만 추출한다. 나머지는 기존 엄격 XML 파서로 검사하며 주석/속성/중첩을 허용하지 않는다.
  const match =
    /^(<\?xml[^?]*\?>\s*)?<boxofs>\s*<basedate>(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})<\/basedate>([\s\S]*)<\/boxofs>\s*$/
      .exec(xml);
  if (!match || match[2] !== period.start || match[3] !== period.end) {
    return invalid();
  }
  const converted = `${match[1] ?? ""}<dbs>${
    match[4].replace(/<boxof>/g, "<db>").replace(/<\/boxof>/g, "</db>")
  }</dbs>`;
  const records = parseFlatDbsXml(converted);
  if (!records.length || records.length > 1000) return invalid();
  const allowed = new Set([
    "cate",
    "rnum",
    "prfnm",
    "prfpd",
    "prfplcnm",
    "seatcnt",
    "prfdtcnt",
    "area",
    "poster",
    "mt20id",
  ]);
  const seen = new Set<string>();
  const items = records.map((raw, i) => {
    if (
      Object.keys(raw).some((key) => !allowed.has(key)) ||
      raw.rnum !== String(i + 1) ||
      !/^PF[0-9A-Za-z]+$/.test(raw.mt20id ?? "") || seen.has(raw.mt20id)
    ) return invalid();
    seen.add(raw.mt20id);
    const genre = plain(raw.cate);
    if (mode === "musical" && genre !== "뮤지컬") return invalid();
    const dates = /^(\d{4})\.(\d{2})\.(\d{2})\s*~\s*(\d{4})\.(\d{2})\.(\d{2})$/
      .exec(raw.prfpd ?? "");
    if (!dates) return invalid();
    const start = `${dates[1]}-${dates[2]}-${dates[3]}`,
      end = `${dates[4]}-${dates[5]}-${dates[6]}`;
    parseCalendarDate(start);
    parseCalendarDate(end);
    if (end < start) return invalid();
    return {
      rank: i + 1,
      sourceId: raw.mt20id,
      title: plain(raw.prfnm),
      genre,
      performancePeriodText: `${start.replaceAll("-", ".")} ~ ${
        end.replaceAll("-", ".")
      }`,
      placeName: plain(raw.prfplcnm),
      region: normalizeEventRegion(plain(raw.area))!,
    };
  }).slice(0, 10);
  return {
    mode,
    requestedPeriod: period,
    responsePeriod: { start: match[2], end: match[3] },
    periodVerification: "verified",
    collectedAt: now.toISOString(),
    items,
  };
}
export function createKopisRankingProvider(
  options: {
    apiKey: string;
    timeoutMs: number;
    fetch: FetchLike;
    now: () => Date;
  },
) {
  if (
    !/^[A-Za-z0-9_-]{1,512}$/.test(options.apiKey) ||
    !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
    options.timeoutMs > 15000
  ) throw new EventProviderError("INVALID_EVENT_REQUEST");
  return {
    async collect(
      mode: KopisRankingMode,
      signal?: AbortSignal,
    ): Promise<VerifiedKopisRanking> {
      if (!["all", "musical"].includes(mode)) {
        throw new EventProviderError("INVALID_EVENT_REQUEST");
      }
      signal?.throwIfAborted();
      const now = options.now(), period = kopisRankingPeriod(now);
      const url = new URL("https://kopis.or.kr/openApi/restful/boxoffice");
      url.searchParams.set("service", options.apiKey);
      url.searchParams.set("stdate", period.start.replaceAll("-", ""));
      url.searchParams.set("eddate", period.end.replaceAll("-", ""));
      if (mode === "musical") url.searchParams.set("catecode", "GGGA");
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
        const contentType = response.headers.get("content-type") ?? "";
        if (!/(?:text|application)\/xml/i.test(contentType)) return invalid();
        const text = await response.text();
        signal?.throwIfAborted();
        if (text.length > 2_000_000) return invalid();
        return parseKopisRankingXml(text, mode, period, now);
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
    },
  };
}
/** 안전한 공개 투영. 기존 requested_only DB 스냅샷은 검증 완료로 승격하지 않는다. */
export function publicKopisRanking(
  snapshot: VerifiedKopisRanking | null,
  mode: KopisRankingMode,
  now: Date,
): PublicKopisRanking {
  const empty: PublicKopisRanking = {
    status: "unavailable",
    mode,
    sourceName: "KOPIS",
    period: null,
    collectedAt: null,
    items: [],
  };
  if (
    !snapshot || snapshot.mode !== mode ||
    snapshot.periodVerification !== "verified" ||
    snapshot.responsePeriod.start !== kopisRankingPeriod(now).start ||
    snapshot.responsePeriod.end !== kopisRankingPeriod(now).end
  ) return empty;
  return {
    status: "available",
    mode,
    sourceName: "KOPIS",
    period: { ...snapshot.responsePeriod },
    collectedAt: snapshot.collectedAt,
    items: snapshot.items.map((
      {
        rank,
        sourceId,
        title,
        genre,
        performancePeriodText,
        placeName,
        region,
      },
    ) => ({
      rank,
      sourceId,
      title,
      genre,
      performancePeriodText,
      placeName,
      region,
    })),
  };
}

export interface KopisRankingStore {
  /** 원천 응답의 실제 집계기간 검증 결과까지 저장한다. 기존 requested_only 스키마만으로는 활성화하지 않는다. */
  save(snapshot: VerifiedKopisRanking): Promise<"applied" | "stale">;
}
export async function collectKopisRanking(input: {
  mode: KopisRankingMode;
  provider: {
    collect(
      mode: KopisRankingMode,
      signal?: AbortSignal,
    ): Promise<VerifiedKopisRanking>;
  };
  store?: KopisRankingStore;
  signal?: AbortSignal;
}): Promise<{ status: "applied" | "stale" | "not_enabled"; reason?: string }> {
  if (!input.store) {
    return {
      status: "not_enabled",
      reason: "RANKING_VERIFIED_PERSISTENCE_NOT_CONNECTED",
    };
  }
  const snapshot = await input.provider.collect(input.mode, input.signal);
  input.signal?.throwIfAborted();
  if (
    snapshot.mode !== input.mode || snapshot.periodVerification !== "verified"
  ) return invalid();
  const status = await input.store.save(snapshot);
  if (!["applied", "stale"].includes(status)) return invalid();
  return { status };
}
