import { ApiError, ServiceApiClient } from "./api.ts";
import type { Filters } from "./types.ts";
import type { PlaceLookupResult } from "../../../backend/supabase/functions/_shared/integrations/places/port.ts";
import { CATEGORIES } from "./domain.ts";
import type {
  PostRegion,
  PublicPostCard,
  PublicPostCost,
  PublicPostPageResult,
} from "../../../backend/supabase/functions/_shared/contracts/search.ts";
import type {
  AiCard,
  AiChatResult,
  AiFeedbackInput,
  AiFeedbackResult,
  ChatInput,
} from "../../../backend/supabase/functions/_shared/contracts/ai.ts";
import type {
  EventPage,
  EventPageQuery as ServerEventPageQuery,
  PublicEventItem,
} from "../../../backend/supabase/functions/_shared/db/repositories/events.ts";

export type EventPageQuery = ServerEventPageQuery & {
  includeOngoing?: boolean;
  freeOnly?: boolean;
  performanceGenre?: "concert" | "musical" | "play";
};
export type { AiChatResult, ChatInput, EventPage, PublicPostPageResult };
export interface ServiceOptions {
  serviceApiUrl: string;
  aiChatUrl?: string;
  placesUrl?: string;
  accessToken: () => Promise<string | null>;
  fetcher?: typeof fetch;
}
export interface PublicProfile {
  profileId: string;
  displayName: string;
  age: number;
  gender: "female";
  avatarPath: string | null;
  bio: string | null;
  interests: string[];
  conversationStyles: string[];
  mbti: string | null;
  completedCount: number;
  sweetness?: number;
}
export interface ProfileReviews {
  reviews: {
    reviewId: string;
    rating: number;
    experience: "positive" | "neutral" | "negative";
    text: string | null;
    praises: string[];
    submittedAt: string;
  }[];
  praisesTop5: { code: string; label: string; count: number }[];
  nextCursor: string | null;
  completedCount: number;
}
export interface PublicEventFilters {
  regions: { provider: string; value: string; count: number }[];
  categories: { provider: string; value: string; count: number }[];
}
export interface ProfileSummary {
  status: "available" | "pending" | "insufficient_reviews" | "withdrawn";
  processingAllowed: boolean;
  sourceRevision: string;
  summary: {
    summaryId: string;
    text: string;
    sourceCount: number;
    updatedAt: string;
  } | null;
}
export interface PerformanceRankings {
  status: "available" | "unavailable";
  mode: "all" | "musical";
  sourceName: "KOPIS";
  period: { start: string; end: string } | null;
  collectedAt: string | null;
  items: {
    rank: number;
    sourceId: string;
    title: string;
    genre: string | null;
    performancePeriodText: string | null;
    placeName: string | null;
    region: string | null;
  }[];
}
export interface PostDetails {
  postId: string;
  title: string;
  description: string;
  category: string;
  startsAt: string;
  endsAt: string;
  recruitmentEndsAt: string;
  updatedAt: string;
  publicArea: string;
  status: string;
  costType: "free" | "paid_request" | "paid_offer" | null;
  amount: number | null;
  preferenceNote: string | null;
  tags: string[];
  eventId: string | null;
  linkedEvent: PublicEventItem | null;
  authorDisplayName: string | null;
  /** Only server-authorized owner/confirmed-party responses may include these fields. */
  privateDetails?: {
    registeredPlaceName: string | null;
    registeredAddress: string;
    meetingDetail: string;
  } | null;
  participantNames?: { userId: string; realName: string }[] | null;
}

const categories: readonly string[] = CATEGORIES;
const regions: Record<string, PostRegion> = {
  서울: "서울특별시",
  부산: "부산광역시",
  대구: "대구광역시",
  인천: "인천광역시",
  광주: "광주광역시",
  대전: "대전광역시",
  울산: "울산광역시",
  세종: "세종특별자치시",
  경기: "경기도",
  강원: "강원특별자치도",
  충북: "충청북도",
  충남: "충청남도",
  전북: "전북특별자치도",
  전남: "전라남도",
  경북: "경상북도",
  경남: "경상남도",
  제주: "제주특별자치도",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const publicArea =
  /^(?:세종특별자치시 [가-힣0-9]+(?:동|읍|면|가)|[가-힣]+(?:특별시|광역시|특별자치시|특별자치도|도) [가-힣]+(?:시|군|구)(?: [가-힣]+구)? [가-힣0-9]+(?:동|읍|면|가))$/;
const fail = (): never => {
  throw new ApiError(502, "INVALID_SERVICE_RESPONSE");
};
const invalid = (): never => {
  throw new ApiError(400, "INVALID_REQUEST");
};
export function normalizeMobileRegion(value: string): PostRegion | undefined {
  if (value === "" || value === "전체") return undefined;
  const canonical = regions[value] ??
    Object.values(regions).find((region) => region === value);
  if (!canonical) return invalid();
  return canonical;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail();
  }
  return value as Record<string, unknown>;
}
function exact(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  const object = record(value);
  if (
    required.some((key) => !Object.hasOwn(object, key)) ||
    Object.keys(object).some((key) =>
      !required.includes(key) && !optional.includes(key)
    )
  ) return fail();
  return object;
}
function text(value: unknown, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim())) return fail();
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function id(value: unknown): string {
  const result = text(value);
  if (!uuid.test(result)) return fail();
  return result;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") return fail();
  return value;
}
function date(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) return fail();
  const parsed = new Date(`${result}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== result
  ) return fail();
  return result;
}
function instant(value: unknown): string {
  const result = text(value);
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/
      .exec(result);
  if (
    !match || Number(match[2]) > 23 || Number(match[3]) > 59 ||
    Number(match[4]) > 59 ||
    (match[6] !== "Z" &&
      (Number(match[6].slice(1, 3)) > 23 || Number(match[6].slice(4)) > 59)) ||
    !Number.isFinite(Date.parse(result))
  ) return fail();
  date(match[1]);
  return result;
}
function micros(value: string): bigint {
  const fraction = /\.(\d{1,6})(?:Z|[+-])/.exec(value)?.[1] ?? "";
  return BigInt(Date.parse(value)) * 1000n +
    BigInt(fraction.padEnd(6, "0").slice(3));
}
function copy(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
function cursor(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value);
  if (result.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(result)) return fail();
  return result;
}
function area(value: unknown): string {
  const result = text(value);
  if (result.length > 60 || !publicArea.test(result)) return fail();
  return result;
}
function cost(value: unknown): PublicPostCost {
  const raw = record(value);
  if (raw.kind === "unknown" || raw.kind === "free") {
    exact(raw, ["kind"]);
    return { kind: raw.kind };
  }
  if (raw.kind !== "paid_request" && raw.kind !== "paid_offer") return fail();
  exact(raw, ["kind", "amount", "direction"]);
  if (
    !Number.isSafeInteger(raw.amount) || (raw.amount as number) <= 0 ||
    raw.direction !==
      (raw.kind === "paid_request"
        ? "author_to_applicant"
        : "applicant_to_author")
  ) return fail();
  return raw.kind === "paid_request"
    ? {
      kind: raw.kind,
      amount: raw.amount as number,
      direction: "author_to_applicant",
    }
    : {
      kind: raw.kind,
      amount: raw.amount as number,
      direction: "applicant_to_author",
    };
}
function postCard(value: unknown, anonymous: boolean): PublicPostCard {
  const raw = exact(value, [
    "id",
    "title",
    "authorDisplayName",
    "publicArea",
    "startsAt",
    "endsAt",
    "cost",
    "state",
    "canApply",
  ]);
  const startsAt = instant(raw.startsAt), endsAt = instant(raw.endsAt);
  if (
    micros(startsAt) >= micros(endsAt) ||
    !["recruiting", "confirmed", "closed", "expired"].includes(
      String(raw.state),
    )
  ) return fail();
  const authorDisplayName = nullableText(raw.authorDisplayName);
  if (anonymous ? authorDisplayName !== null : authorDisplayName === null) {
    return fail();
  }
  const parsedCost = cost(raw.cost), canApply = boolean(raw.canApply);
  if (
    canApply &&
    (anonymous || raw.state !== "recruiting" || parsedCost.kind !== "free")
  ) return fail();
  return {
    id: id(raw.id),
    title: text(raw.title),
    authorDisplayName,
    publicArea: area(raw.publicArea),
    startsAt,
    endsAt,
    cost: parsedCost,
    state: raw.state as PublicPostCard["state"],
    canApply,
  };
}
function event(value: unknown, allowCancelled = false): PublicEventItem {
  const raw = record(value),
    timing = raw.precision === "date"
      ? ["startsOn", "endsOn"]
      : raw.precision === "instant"
      ? ["startsAt", "endsAt"]
      : fail();
  exact(raw, [
    "id",
    "provider",
    "sourceId",
    "sourceStatus",
    "title",
    "category",
    "region",
    "placeName",
    "publicAddress",
    "admission",
    "sourceUrl",
    "collectedAt",
    "state",
    "precision",
    ...timing,
  ], ["description", "operatingInfo", "posterUrl", "performanceGenre"]);
  if (
    (raw.sourceStatus !== "active" &&
      !(allowCancelled && raw.sourceStatus === "cancelled")) ||
    !["ongoing", "upcoming", "ended"].includes(String(raw.state)) ||
    !/^[a-z0-9][a-z0-9-]{0,31}$/.test(text(raw.provider))
  ) return fail();
  for (
    const key of [
      "category",
      "region",
      "placeName",
      "publicAddress",
      "sourceUrl",
    ]
  ) nullableText(raw[key]);
  for (const key of ["description", "operatingInfo"] as const) {
    if (Object.hasOwn(raw, key) && raw[key] !== null) {
      const value = text(raw[key]);
      if (/<[^>]*>/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
        return fail();
      }
    }
  }
  if (
    Object.hasOwn(raw, "performanceGenre") && raw.performanceGenre !== null &&
    !["concert", "musical", "play"].includes(String(raw.performanceGenre))
  ) return fail();
  if (Object.hasOwn(raw, "posterUrl") && raw.posterUrl !== null) {
    let url: URL;
    try {
      url = new URL(text(raw.posterUrl));
    } catch {
      return fail();
    }
    if (
      url.protocol !== "https:" || url.username || url.password || url.search ||
      url.hash
    ) return fail();
  }
  if (raw.sourceUrl !== null) {
    let url: URL;
    try {
      url = new URL(text(raw.sourceUrl));
    } catch {
      return fail();
    }
    if (
      url.protocol !== "https:" || url.username || url.password ||
      /(?:servicekey|apikey|api_key|access_token|authorization)=/i.test(
        url.search,
      )
    ) return fail();
  }
  const admission = record(raw.admission);
  if (admission.kind === "free" || admission.kind === "unknown") {
    exact(admission, ["kind"]);
  } else if (admission.kind === "described") {
    exact(admission, ["kind", "text"]);
    text(admission.text);
  } else return fail();
  if (raw.precision === "date") {
    if (date(raw.startsOn) > date(raw.endsOn)) return fail();
  } else if (micros(instant(raw.startsAt)) >= micros(instant(raw.endsAt))) {
    return fail();
  }
  id(raw.id);
  text(raw.sourceId);
  text(raw.title);
  instant(raw.collectedAt);
  // Exact schema validation preserves date precision, unknown admission and nullable provider metadata.
  return copy(raw) as unknown as PublicEventItem;
}
function requestId(value: unknown): string {
  const result = text(value);
  if (result.length > 128) return fail();
  return result;
}
function aiCard(value: unknown): AiCard {
  const raw = exact(value, [
    "kind",
    "id",
    "title",
    "locationLabel",
    "startsAtOrDate",
    "endsAtOrDate",
    "costLabel",
    "state",
    "canApply",
  ], ["sourceUrl", "sourceName", "conditionStatus"]);
  if (raw.kind !== "post" && raw.kind !== "event") return fail();
  id(raw.id);
  for (
    const key of [
      "title",
      "locationLabel",
      "startsAtOrDate",
      "endsAtOrDate",
      "costLabel",
      "state",
    ]
  ) text(raw[key]);
  boolean(raw.canApply);
  if (
    raw.kind === "event" &&
    (raw.canApply !== false || !Object.hasOwn(raw, "sourceName"))
  ) return fail();
  if (raw.kind === "post") {
    area(raw.locationLabel);
    instant(raw.startsAtOrDate);
    instant(raw.endsAtOrDate);
    if (Object.hasOwn(raw, "sourceName") || Object.hasOwn(raw, "sourceUrl")) {
      return fail();
    }
  }
  if (Object.hasOwn(raw, "sourceName")) text(raw.sourceName);
  if (Object.hasOwn(raw, "sourceUrl") && raw.sourceUrl !== null) {
    let url: URL;
    try {
      url = new URL(text(raw.sourceUrl));
    } catch {
      return fail();
    }
    if (
      url.protocol !== "https:" || url.username || url.password ||
      /(?:servicekey|apikey|api_key|access_token|authorization)=/i.test(
        url.search,
      )
    ) return fail();
  }
  if (Object.hasOwn(raw, "conditionStatus")) {
    const conditions = exact(raw.conditionStatus, [], [
      "mbti",
      "interests",
      "conversationStyles",
    ]);
    for (const value of Object.values(conditions)) {
      if (value !== "match" && value !== "needs_check") return fail();
    }
  }
  return copy(raw) as unknown as AiCard;
}
function parseAi(value: unknown): AiChatResult {
  const raw = exact(value, [
    "requestId",
    "status",
    "interpretedFilters",
    "cards",
    "explanations",
  ], ["clarificationQuestion", "notice", "partial", "recovery"]);
  requestId(raw.requestId);
  if (
    !["needs_clarification", "results", "no_results", "unavailable"].includes(
      String(raw.status),
    ) || !Array.isArray(raw.cards) || raw.cards.length > 5 ||
    !Array.isArray(raw.explanations)
  ) return fail();
  exact(raw.interpretedFilters, ["target"], [
    "query",
    "category",
    "region",
    "cost",
    "availability",
    "date",
    "mbti",
    "ongoingOnly",
    "includeOngoing",
    "performanceGenre",
    "newThisWeek",
    "sort",
    "authorAge",
    "interests",
    "conversationStyles",
  ]);
  const filters = record(raw.interpretedFilters);
  if (filters.target !== "posts" && filters.target !== "events") return fail();
  for (const key of ["query", "category", "region", "mbti"]) {
    if (Object.hasOwn(filters, key)) text(filters[key]);
  }
  for (const key of ["ongoingOnly", "includeOngoing", "newThisWeek"]) {
    if (Object.hasOwn(filters, key)) boolean(filters[key]);
  }
  for (
    const [key, values] of [["cost", ["all", "free", "paid"]], [
      "availability",
      ["all", "recruiting"],
    ], ["sort", ["created_desc", "starts_asc"]], ["performanceGenre", ["concert", "musical", "play"]]] as const
  ) {
    if (
      Object.hasOwn(filters, key) &&
      !(values as readonly unknown[]).includes(filters[key])
    ) return fail();
  }
  if (Object.hasOwn(filters, "authorAge") && filters.authorAge !== "all") {
    const ages = exact(filters.authorAge, ["min", "max"]);
    if (
      !Number.isSafeInteger(ages.min) || !Number.isSafeInteger(ages.max) ||
      (ages.min as number) < 19 || (ages.max as number) > 99 ||
      (ages.min as number) > (ages.max as number)
    ) return fail();
  }
  if (Object.hasOwn(filters, "date")) {
    const selection = record(filters.date);
    if (selection.kind === "dates") {
      exact(selection, ["kind", "startsOn", "endsOn"]);
      if (date(selection.startsOn) > date(selection.endsOn)) return fail();
    } else {
      exact(selection, ["kind"]);
      if (
        !["today", "tomorrow", "this_week", "this_weekend"].includes(
          String(selection.kind),
        )
      ) return fail();
    }
  }
  for (const key of ["interests", "conversationStyles"]) {
    if (Object.hasOwn(filters, key)) {
      const preference = exact(filters[key], ["values"], ["combine"]);
      if (!Array.isArray(preference.values) || preference.values.length > 20) {
        return fail();
      }
      for (const value of preference.values) {
        const term = exact(value, ["text", "polarity"]);
        if (
          [...text(term.text)].length > 40 ||
          (term.polarity !== "include" && term.polarity !== "exclude")
        ) return fail();
      }
      if (
        Object.hasOwn(preference, "combine") && preference.combine !== "any" &&
        preference.combine !== "all"
      ) return fail();
    }
  }
  if (Object.hasOwn(raw, "recovery")) {
    const recovery = exact(raw.recovery, ["reason", "retryAllowed"]);
    if (
      ![
        "input_privacy",
        "output_privacy",
        "daily_limit",
        "concurrent",
        "consent",
        "temporary",
      ].includes(String(recovery.reason))
    ) return fail();
    boolean(recovery.retryAllowed);
    if (raw.status !== "unavailable") return fail();
  }
  const cards = raw.cards.map(aiCard);
  if (
    new Set(cards.map((item) => `${item.kind}:${item.id}`)).size !==
      cards.length
  ) return fail();
  const explanations = raw.explanations.map((value) => {
    const item = exact(value, ["id", "kind", "text"]);
    if (!cards.some((card) => card.id === item.id && card.kind === item.kind)) {
      return fail();
    }
    return {
      id: id(item.id),
      kind: item.kind as AiCard["kind"],
      text: text(item.text),
    };
  });
  if (
    raw.status === "results"
      ? cards.length === 0
      : cards.length !== 0 || explanations.length !== 0
  ) return fail();
  for (const key of ["notice", "clarificationQuestion"]) {
    if (Object.hasOwn(raw, key)) text(raw[key]);
  }
  if (
    raw.status === "needs_clarification" &&
    !Object.hasOwn(raw, "clarificationQuestion")
  ) return fail();
  if (
    Object.hasOwn(raw, "partial") &&
    (raw.partial !== true || raw.status !== "results" ||
      !Object.hasOwn(raw, "notice"))
  ) return fail();
  return {
    ...record(copy(raw)),
    cards,
    explanations,
  } as unknown as AiChatResult;
}

/** Proposed summary/ranking HTTP routes require Mingyu's server connection; no mock fallback exists. */
export class YumidangService {
  private readonly options: ServiceOptions;
  constructor(options: ServiceOptions) {
    new ServiceApiClient(
      options.serviceApiUrl,
      options.accessToken,
      options.fetcher,
    );
    if (options.aiChatUrl) {
      new ServiceApiClient(
        options.aiChatUrl,
        options.accessToken,
        options.fetcher,
      );
    }
    if (options.placesUrl) {
      new ServiceApiClient(
        options.placesUrl,
        options.accessToken,
        options.fetcher,
      );
    }
    this.options = options;
  }
  private async read(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; anonymous: boolean }> {
    const token = await this.options.accessToken();
    const client = new ServiceApiClient(
      this.options.serviceApiUrl,
      async () => token,
      this.options.fetcher,
    );
    return {
      data: await client.request<unknown>(path, { auth: "optional", signal }),
      anonymous: token === null,
    };
  }
  /** Existing authenticated Places Edge endpoint; address candidates are draft inputs, not post-card fields. */
  async searchPlaces(
    query: string,
    page = 1,
    signal?: AbortSignal,
  ): Promise<PlaceLookupResult> {
    if (
      typeof query !== "string" || !query.trim() || [...query].length > 300 ||
      /[\u0000-\u001f\u007f]/.test(query) || !Number.isSafeInteger(page) ||
      page < 1 || page > 45
    ) return invalid();
    let endpoint: URL;
    if (this.options.placesUrl) endpoint = new URL(this.options.placesUrl);
    else {
      endpoint = new URL(this.options.serviceApiUrl);
      const pathname = endpoint.pathname.replace(
        /\/service-api\/?$/,
        "/places",
      );
      if (pathname === endpoint.pathname) {
        throw new ApiError(503, "PLACES_NOT_CONFIGURED");
      }
      endpoint.pathname = pathname;
    }
    const parameters = new URLSearchParams({ query, page: String(page) });
    const client = new ServiceApiClient(
      endpoint.origin,
      this.options.accessToken,
      this.options.fetcher,
    );
    const raw = exact(
      await client.request<unknown>(`${endpoint.pathname}?${parameters}`, {
        auth: "required",
        signal,
      }),
      ["status", "places", "nextPage"],
    );
    if (
      !Array.isArray(raw.places) || raw.places.length > 10 ||
      !["results", "no_results"].includes(String(raw.status)) ||
      (raw.status === "results") !== (raw.places.length > 0)
    ) return fail();
    const seen = new Set<string>();
    for (const value of raw.places) {
      const place = exact(value, [
        "source",
        "sourceId",
        "placeName",
        "address",
        "roadAddress",
      ]);
      const sourceId = text(place.sourceId);
      if (place.source !== "kakao" || seen.has(sourceId)) return fail();
      seen.add(sourceId);
      for (const key of ["sourceId", "placeName", "address", "roadAddress"]) {
        if (
          (key === "address" || key === "roadAddress") && place[key] === null
        ) continue;
        if (/<[^>]*>|[\u0000-\u001f\u007f]/.test(text(place[key]))) {
          return fail();
        }
      }
    }
    if (
      raw.nextPage !== null &&
      (!Number.isSafeInteger(raw.nextPage) || raw.nextPage !== page + 1 ||
        (raw.nextPage as number) > 45 || !raw.places.length)
    ) return fail();
    return copy(raw) as PlaceLookupResult;
  }
  async searchPosts(
    filters: Filters,
    next?: string,
    signal?: AbortSignal,
  ): Promise<PublicPostPageResult> {
    if (
      !filters || typeof filters !== "object" ||
      !["created_desc", "starts_asc"].includes(filters.sort) ||
      typeof filters.recruiting !== "boolean"
    ) return invalid();
    const parameters = new URLSearchParams({
      sort: filters.sort,
      availability: filters.recruiting ? "recruiting" : "all",
      limit: "10",
    });
    for (
      const key of [
        "query",
        "category",
        "region",
        "from",
        "to",
        "ageMin",
        "ageMax",
      ] as const
    ) if (typeof filters[key] !== "string") return invalid();
    if (filters.query.trim()) {
      if ([...filters.query].length > 300) return invalid();
      parameters.set("query", filters.query);
    }
    if (filters.category && filters.category !== "전체") {
      if (!categories.includes(filters.category)) return invalid();
      parameters.set("category", filters.category);
    }
    if (filters.region && filters.region !== "전체") {
      const canonical = normalizeMobileRegion(filters.region);
      if (!canonical) return invalid();
      parameters.set("region", canonical);
    }
    if (Boolean(filters.from) !== Boolean(filters.to)) return invalid();
    if (filters.from) {
      let from: string, to: string;
      try {
        from = date(filters.from);
        to = date(filters.to);
      } catch {
        return invalid();
      }
      if (from > to) return invalid();
      const dayAfter = new Date(`${to}T00:00:00Z`);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      parameters.set("periodStart", `${from}T00:00:00+09:00`);
      parameters.set(
        "periodEnd",
        `${dayAfter.toISOString().slice(0, 10)}T00:00:00+09:00`,
      );
    }
    if (filters.ageMin || filters.ageMax) {
      const lower = filters.ageMin || "19", upper = filters.ageMax || "99";
      if (
        !/^\d{1,2}$/.test(lower) || !/^\d{1,2}$/.test(upper) ||
        Number(lower) < 19 || Number(upper) > 99 ||
        Number(lower) > Number(upper)
      ) return invalid();
      parameters.set("ageMin", String(Number(lower)));
      parameters.set("ageMax", String(Number(upper)));
    }
    if (next !== undefined) {
      try {
        parameters.set("cursor", cursor(next)!);
      } catch {
        return invalid();
      }
    }
    const { data, anonymous } = await this.read(`/posts?${parameters}`, signal);
    const raw = exact(data, ["status", "posts", "nextCursor"]);
    if (
      !Array.isArray(raw.posts) || raw.posts.length > 10 ||
      !["results", "no_results"].includes(String(raw.status))
    ) return fail();
    const posts = raw.posts.map((value) => postCard(value, anonymous)),
      nextCursor = cursor(raw.nextCursor);
    if (
      (raw.status === "results") !== (posts.length > 0) ||
      (posts.length === 0 && nextCursor !== null) ||
      new Set(posts.map((post) => post.id)).size !== posts.length
    ) return fail();
    return {
      status: raw.status as PublicPostPageResult["status"],
      posts,
      nextCursor,
    };
  }
  async listEvents(
    query: EventPageQuery,
    next?: string,
    signal?: AbortSignal,
  ): Promise<EventPage> {
    if (
      !query || typeof query !== "object" || Array.isArray(query) ||
      Object.keys(query).some((key) =>
        ![
          "mode",
          "period",
          "ongoingOnly",
          "includeOngoing",
          "freeOnly",
          "performanceGenre",
          "query",
          "region",
          "category",
        ].includes(key)
      ) ||
      !["overlapping", "new_this_week", "post_selection"].includes(query.mode)
    ) return invalid();
    if (
      query.includeOngoing &&
      (query.mode !== "new_this_week" || query.ongoingOnly)
    ) return invalid();
    const parameters = new URLSearchParams({ mode: query.mode, limit: "10" });
    for (const key of ["ongoingOnly", "includeOngoing", "freeOnly"] as const) {
      if (query[key] !== undefined) {
        if (typeof query[key] !== "boolean") return invalid();
        parameters.set(key, String(query[key]));
      }
    }
    if (query.performanceGenre !== undefined) {
      if (!["concert", "musical", "play"].includes(query.performanceGenre)) {
        return invalid();
      }
      parameters.set("performanceGenre", query.performanceGenre);
    }
    for (const key of ["query", "region", "category"] as const) {
      if (query[key] !== undefined) {
        if (typeof query[key] !== "string") return invalid();
        parameters.set(key, query[key]!);
      }
    }
    if (query.period !== undefined) {
      if (
        !query.period || typeof query.period !== "object" ||
        Object.keys(query.period).length !== 2 ||
        Object.keys(query.period).some((key) =>
          key !== "start" && key !== "end"
        )
      ) return invalid();
      try {
        const start = date(query.period.start), end = date(query.period.end);
        if (start > end) return invalid();
        parameters.set("periodStart", start);
        parameters.set("periodEnd", end);
      } catch {
        return invalid();
      }
    }
    if (next !== undefined) {
      try {
        parameters.set("cursor", cursor(next)!);
      } catch {
        return invalid();
      }
    }
    const { data } = await this.read(`/events?${parameters}`, signal);
    const raw = exact(data, ["events", "nextCursor"]);
    if (!Array.isArray(raw.events) || raw.events.length > 10) return fail();
    const events = raw.events.map((value) => event(value)),
      nextCursor = cursor(raw.nextCursor);
    if (
      events.some((item) =>
        (query.freeOnly && item.admission.kind !== "free") ||
        (query.performanceGenre &&
          record(item).performanceGenre !== query.performanceGenre)
      )
    ) return fail();
    if (
      (!events.length && nextCursor !== null) ||
      new Set(events.map((item) => item.id)).size !== events.length
    ) return fail();
    return { events, nextCursor };
  }
  /** Proposed GET /events/:id returns the existing public source schema only. */
  async getEvent(
    eventId: string,
    signal?: AbortSignal,
  ): Promise<PublicEventItem> {
    if (!uuid.test(eventId)) return invalid();
    const { data } = await this.read(`/events/${eventId}`, signal);
    const result = event(data);
    if (result.id.toLowerCase() !== eventId.toLowerCase()) return fail();
    return result;
  }
  async askAi(input: ChatInput, signal?: AbortSignal): Promise<AiChatResult> {
    if (!this.options.aiChatUrl) throw new ApiError(503, "AI_NOT_CONFIGURED");
    const url = new URL(this.options.aiChatUrl);
    const client = new ServiceApiClient(
      url.origin,
      this.options.accessToken,
      this.options.fetcher,
    );
    return parseAi(
      await client.request<unknown>(url.pathname, {
        method: "POST",
        auth: "required",
        body: input,
        signal,
      }),
    );
  }
  async sendAiFeedback(input: AiFeedbackInput, signal?: AbortSignal): Promise<AiFeedbackResult> {
    if (!this.options.aiChatUrl) throw new ApiError(503, "AI_NOT_CONFIGURED");
    // Never submit a transcript or attach material the reporter did not confirm.
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      !["helpful", "report"].includes(input.action) ||
      typeof input.clientRequestId !== "string" || !input.clientRequestId.trim() ||
      input.clientRequestId.length > 128 || !uuid.test(input.requestId)) return invalid();
    const keys = input.action === "helpful"
      ? ["clientRequestId", "requestId", "action"]
      : ["clientRequestId", "requestId", "action", "confirmed", "attachment"];
    if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) return invalid();
    if (input.action === "report") {
      if (input.confirmed !== true || !input.attachment || typeof input.attachment !== "object" || Array.isArray(input.attachment)) return invalid();
      const attachment = input.attachment;
      if (attachment.kind === "answer") {
        if (Object.keys(attachment).length !== 2 || typeof attachment.text !== "string" ||
          !attachment.text.trim() || [...attachment.text].length > 500) return invalid();
      } else if (attachment.kind === "capture") {
        if (Object.keys(attachment).length !== 2 || !uuid.test(attachment.assetId)) return invalid();
      } else return invalid();
    }
    const url = new URL(this.options.aiChatUrl);
    const client = new ServiceApiClient(url.origin, this.options.accessToken, this.options.fetcher);
    const response = await client.request<unknown>(`${url.pathname.replace(/\/$/, "")}/feedback`, {
      method: "POST", auth: "required", body: input, signal,
    });
    if (!response || typeof response !== "object" || Array.isArray(response)) return fail();
    if ((response as Record<string, unknown>).status === "not_enabled") {
      const raw = exact(response, ["status", "reason"]);
      if (!["AI_REPORT_EVIDENCE_HANDLING_NOT_CONNECTED", "AI_FEEDBACK_STORAGE_NOT_CONNECTED"].includes(String(raw.reason))) return fail();
      return copy(raw) as AiFeedbackResult;
    }
    const raw = exact(response, ["status", "feedbackId", "hideAnswer"]);
    if (raw.status !== "accepted" || !uuid.test(String(raw.feedbackId)) || raw.hideAnswer !== (input.action === "report")) return fail();
    return { status: "accepted", feedbackId: String(raw.feedbackId).toLowerCase(), hideAnswer: raw.hideAnswer as boolean };
  }
  async getProfile(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<PublicProfile> {
    if (!uuid.test(profileId)) return invalid();
    const client = new ServiceApiClient(
      this.options.serviceApiUrl,
      this.options.accessToken,
      this.options.fetcher,
    );
    const raw = exact(
      await client.request<unknown>(`/profiles/${profileId}`, {
        auth: "required",
        signal,
      }),
      [
        "profileId",
        "displayName",
        "age",
        "gender",
        "avatarPath",
        "bio",
        "interests",
        "conversationStyles",
        "mbti",
        "completedCount",
      ],
      ["sweetness"],
    );
    if (
      id(raw.profileId).toLowerCase() !== profileId.toLowerCase() ||
      !Number.isSafeInteger(raw.age) || (raw.age as number) < 19 ||
      raw.gender !== "female" || !Number.isSafeInteger(raw.completedCount) ||
      (raw.completedCount as number) < 0
    ) return fail();
    text(raw.displayName);
    nullableText(raw.avatarPath);
    nullableText(raw.bio);
    if (raw.mbti !== null && !/^[EI][NS][TF][JP]$/.test(text(raw.mbti))) {
      return fail();
    }
    for (const key of ["interests", "conversationStyles"] as const) {
      if (!Array.isArray(raw[key]) || raw[key].length > 20) return fail();
      for (const value of raw[key]) {
        if ([...text(value)].length > 40) return fail();
      }
    }
    if (
      Object.hasOwn(raw, "sweetness") &&
      (!Number.isSafeInteger(raw.sweetness) || (raw.sweetness as number) < 0 ||
        (raw.sweetness as number) > 100)
    ) return fail();
    return copy(raw) as PublicProfile;
  }
  async getProfileReviews(
    profileId: string,
    before?: string,
    signal?: AbortSignal,
  ): Promise<ProfileReviews> {
    if (!uuid.test(profileId) || (before !== undefined && !uuid.test(before))) {
      return invalid();
    }
    const parameters = new URLSearchParams({ limit: "5" });
    if (before !== undefined) parameters.set("before", before);
    const client = new ServiceApiClient(
      this.options.serviceApiUrl,
      this.options.accessToken,
      this.options.fetcher,
    );
    const raw = exact(
      await client.request<unknown>(
        `/profiles/${profileId}/reviews?${parameters}`,
        { auth: "required", signal },
      ),
      ["reviews", "praisesTop5", "nextCursor", "completedCount"],
    );
    if (
      !Array.isArray(raw.reviews) || raw.reviews.length > 5 ||
      !Array.isArray(raw.praisesTop5) || raw.praisesTop5.length > 5 ||
      !Number.isSafeInteger(raw.completedCount) ||
      (raw.completedCount as number) < 0
    ) return fail();
    const seen = new Set<string>();
    let previousReviewId: string | undefined;
    for (const value of raw.reviews) {
      const review = exact(value, [
        "reviewId",
        "rating",
        "experience",
        "text",
        "praises",
        "submittedAt",
      ]);
      const reviewId = id(review.reviewId).toLowerCase();
      if (
        seen.has(reviewId) ||
        (before !== undefined && reviewId >= before.toLowerCase()) ||
        (previousReviewId !== undefined && reviewId >= previousReviewId) ||
        !Number.isSafeInteger(review.rating) ||
        (review.rating as number) < 1 || (review.rating as number) > 5 ||
        !["positive", "neutral", "negative"].includes(String(review.experience))
      ) return fail();
      seen.add(reviewId);
      previousReviewId = reviewId;
      nullableText(review.text);
      if (review.text !== null && [...text(review.text)].length > 300) {
        return fail();
      }
      instant(review.submittedAt);
      if (
        !Array.isArray(review.praises) || review.praises.length > 3 ||
        new Set(review.praises).size !== review.praises.length ||
        (review.experience !== "positive" && review.praises.length !== 0)
      ) return fail();
      for (const code of review.praises) text(code);
    }
    const codes = new Set<string>();
    for (const value of raw.praisesTop5) {
      const praise = exact(value, ["code", "label", "count"]),
        code = text(praise.code);
      if (
        codes.has(code) || !Number.isSafeInteger(praise.count) ||
        (praise.count as number) < 1
      ) return fail();
      codes.add(code);
      text(praise.label);
    }
    if (raw.nextCursor !== null) {
      const next = id(raw.nextCursor).toLowerCase();
      if (
        raw.reviews.length === 0 ||
        next !== id(record(raw.reviews.at(-1)).reviewId).toLowerCase() ||
        (before !== undefined && next >= before.toLowerCase())
      ) return fail();
    }
    return copy(raw) as ProfileReviews;
  }
  async getEventFilters(signal?: AbortSignal): Promise<PublicEventFilters> {
    const { data } = await this.read("/events/filters", signal);
    const raw = exact(data, ["regions", "categories"]);
    for (const key of ["regions", "categories"] as const) {
      if (!Array.isArray(raw[key])) return fail();
      const seen = new Set<string>();
      for (const value of raw[key]) {
        const item = exact(value, ["provider", "value", "count"]);
        if (
          !/^[a-z0-9][a-z0-9-]{0,31}$/.test(text(item.provider)) ||
          !Number.isSafeInteger(item.count) || (item.count as number) < 0 ||
          /<[^>]*>|[\u0000-\u001f\u007f]/.test(text(item.value))
        ) return fail();
        const identity = `${item.provider}:${item.value}`;
        if (seen.has(identity)) return fail();
        seen.add(identity);
      }
    }
    return copy(raw) as PublicEventFilters;
  }
  async profileSummary(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<ProfileSummary> {
    if (!uuid.test(profileId)) return invalid();
    const client = new ServiceApiClient(
      this.options.serviceApiUrl,
      this.options.accessToken,
      this.options.fetcher,
    );
    const raw = exact(
      await client.request<unknown>(`/profiles/${profileId}/summary`, {
        auth: "required",
        signal,
      }),
      ["status", "processingAllowed", "sourceRevision", "summary"],
    );
    if (
      !["available", "pending", "insufficient_reviews", "withdrawn"].includes(
        String(raw.status),
      ) || typeof raw.sourceRevision !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(raw.sourceRevision)
    ) return fail();
    const allowed = boolean(raw.processingAllowed);
    if (
      (raw.status === "withdrawn") === allowed ||
      (raw.status === "available") !== (raw.summary !== null)
    ) return fail();
    if (raw.summary !== null) {
      const summary = exact(raw.summary, [
        "summaryId",
        "text",
        "sourceCount",
        "updatedAt",
      ]);
      id(summary.summaryId);
      instant(summary.updatedAt);
      if (
        [...text(summary.text)].length > 300 ||
        !Number.isSafeInteger(summary.sourceCount) ||
        (summary.sourceCount as number) < 3 || !allowed
      ) return fail();
    }
    return copy(raw) as unknown as ProfileSummary;
  }
  async performanceRankings(
    mode: "all" | "musical" = "all",
    signal?: AbortSignal,
  ): Promise<PerformanceRankings> {
    if (mode !== "all" && mode !== "musical") return invalid();
    const { data } = await this.read(`/events/rankings?mode=${mode}`, signal);
    const raw = exact(data, [
      "status",
      "mode",
      "sourceName",
      "period",
      "collectedAt",
      "items",
    ]);
    if (
      (raw.status !== "available" && raw.status !== "unavailable") ||
      raw.mode !== mode || raw.sourceName !== "KOPIS" ||
      !Array.isArray(raw.items) || raw.items.length > 10
    ) return fail();
    if (raw.status === "unavailable") {
      if (raw.items.length || raw.period !== null || raw.collectedAt !== null) {
        return fail();
      }
    } else {
      const period = exact(raw.period, ["start", "end"]);
      if (
        date(period.start) > date(period.end) ||
        new Date(`${period.end}T00:00:00Z`).getTime() -
              new Date(`${period.start}T00:00:00Z`).getTime() !==
          6 * 86400000 ||
        !raw.items.length
      ) return fail();
      instant(raw.collectedAt);
    }
    const ranks = new Set<number>(), sources = new Set<string>();
    for (const value of raw.items) {
      const item = exact(value, [
        "rank",
        "sourceId",
        "title",
        "genre",
        "performancePeriodText",
        "placeName",
        "region",
      ]);
      if (
        !Number.isSafeInteger(item.rank) || (item.rank as number) < 1 ||
        (item.rank as number) > 10 || ranks.has(item.rank as number) ||
        sources.has(text(item.sourceId))
      ) return fail();
      ranks.add(item.rank as number);
      sources.add(text(item.sourceId));
      text(item.title);
      for (
        const key of ["genre", "performancePeriodText", "placeName", "region"]
      ) nullableText(item[key]);
    }
    return copy(raw) as unknown as PerformanceRankings;
  }
  async getPost(postId: string, signal?: AbortSignal): Promise<PostDetails> {
    if (!uuid.test(postId)) return invalid();
    const { data, anonymous } = await this.read(`/posts/${postId}`, signal);
    const raw = exact(data, [
      "postId",
      "title",
      "description",
      "category",
      "startsAt",
      "endsAt",
      "recruitmentEndsAt",
      "updatedAt",
      "publicArea",
      "status",
      "costType",
      "amount",
      "preferenceNote",
      "tags",
      "eventId",
      "linkedEvent",
      "authorDisplayName",
    ], anonymous ? [] : ["privateDetails", "participantNames"]);
    if (
      id(raw.postId).toLowerCase() !== postId.toLowerCase() ||
      !categories.includes(text(raw.category)) ||
      (anonymous
        ? raw.authorDisplayName !== null
        : typeof raw.authorDisplayName !== "string")
    ) return fail();
    text(raw.title);
    text(raw.description);
    area(raw.publicArea);
    instant(raw.recruitmentEndsAt);
    instant(raw.updatedAt);
    if (
      micros(instant(raw.startsAt)) >= micros(instant(raw.endsAt)) ||
      ![
        "recruiting",
        "closed",
        "confirmed",
        "completed",
        "expired",
        "awaiting_consent",
      ].includes(text(raw.status))
    ) return fail();
    nullableText(raw.preferenceNote);
    if (
      !Array.isArray(raw.tags) ||
      raw.tags.some((tag) => typeof tag !== "string")
    ) return fail();
    if (
      raw.costType !== null &&
      !["free", "paid_request", "paid_offer"].includes(String(raw.costType))
    ) return fail();
    if (
      raw.costType === null
        ? raw.amount !== null
        : !Number.isSafeInteger(raw.amount) || (raw.costType === "free"
          ? raw.amount !== 0
          : (raw.amount as number) <= 0)
    ) return fail();
    if (raw.eventId !== null) id(raw.eventId);
    if (raw.linkedEvent !== null) {
      const linked = event(raw.linkedEvent, true);
      if (linked.id !== raw.eventId) return fail();
    } else if (raw.eventId !== null) return fail();
    if (raw.privateDetails != null) {
      const details = exact(raw.privateDetails, [
        "registeredPlaceName",
        "registeredAddress",
        "meetingDetail",
      ]);
      nullableText(details.registeredPlaceName);
      text(details.registeredAddress);
      text(details.meetingDetail);
    }
    if (raw.participantNames != null) {
      if (!Array.isArray(raw.participantNames)) return fail();
      for (const value of raw.participantNames) {
        const participant = exact(value, ["userId", "realName"]);
        id(participant.userId);
        text(participant.realName);
      }
    }
    return copy(raw) as unknown as PostDetails;
  }
}
