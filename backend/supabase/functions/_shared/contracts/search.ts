/** 공개 검색 계약. caller는 HTTP query가 아니라 검증된 공통 인증 문맥에서만 받는다. */
export type SearchCaller = "anonymous" | "member";
export type PostAvailability = "all" | "recruiting";
export type PostSort = "created_desc" | "starts_asc";
export type PostDisplayState = "recruiting" | "confirmed" | "closed" | "expired";
export type PostCostFilter = "all" | "free" | "paid";
export type AuthorAgeFilter = "all" | { min: number; max: number };
export const POST_SEARCH_PAGE_SIZE = 10;
export const POST_REGIONS = ["서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시", "대전광역시", "울산광역시", "세종특별자치시", "경기도", "강원특별자치도", "충청북도", "충청남도", "전북특별자치도", "전라남도", "경상북도", "경상남도", "제주특별자치도"] as const;
export type PostRegion = typeof POST_REGIONS[number];

export type PostCost =
  | { kind: "unknown" }
  | { kind: "free" }
  | { kind: "paid_request"; amount: number }
  | { kind: "paid_offer"; amount: number };

/** unknown은 과거 비용 미확인이다. 무료로 추정하거나 신청 가능하게 바꾸지 않는다. */
export type PublicPostCost =
  | { kind: "unknown" }
  | { kind: "free" }
  | { kind: "paid_request"; amount: number; direction: "author_to_applicant" }
  | { kind: "paid_offer"; amount: number; direction: "applicant_to_author" };

export interface PostSearchPeriod { startsAt: string; endsAt: string; }

/** 기존 순수 코어·가상 저장소용 행. 실제 RPC는 단일 표시 이름의 PublicPostCard를 반환한다. */
export interface PublicPostSearchRow {
  id: string;
  title: string;
  anonymousAlias?: string;
  maskedName: string | null;
  /** 기존 내부 필드명. 값은 DB public_area와 같은 동·읍·면·가까지의 공개 지역이다. */
  publicAreaDistrict: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  cost: PostCost;
  state: PostDisplayState;
  eligibleToApply: boolean;
}

export interface PublicPostCard {
  id: string;
  title: string;
  authorDisplayName: string | null;
  publicArea: string;
  startsAt: string;
  endsAt: string;
  cost: PublicPostCost;
  state: PostDisplayState;
  canApply: boolean;
}

export interface PublicPostListInput {
  caller: SearchCaller;
  availability?: PostAvailability;
  sort?: PostSort;
  query?: string;
  period?: PostSearchPeriod;
  category?: string;
  region?: PostRegion;
  cost?: PostCostFilter;
  authorAge?: AuthorAgeFilter;
  cursor?: string;
  limit?: number;
}
export interface NormalizedPublicPostListInput extends PublicPostListInput {
  availability: PostAvailability;
  sort: PostSort;
  query: string;
  cost: PostCostFilter;
  authorAge: AuthorAgeFilter;
  limit: number;
}
export interface PublicPostListResult { status: "results" | "no_results"; posts: PublicPostCard[]; }
export interface PublicPostSearchPage { items: PublicPostCard[]; nextCursor: string | null; }
export interface PublicPostPageResult extends PublicPostListResult { nextCursor: string | null; }

/** DB가 계산한 마지막 정렬 위치. 권한 토큰이나 데이터 snapshot이 아니다. */
export interface PublicPostCursorPosition {
  sortAt: string;
  id: string;
}
/** 정책의 16개 분류. 민규 SQL·HTTP도 이 목록으로 연결하며 AI 조건 해석은 같은 값을 사용한다. */
export const POST_CATEGORIES = ["지금이당", "전시", "축제", "팝업", "공연", "영화", "맛집", "카페", "쇼핑", "여행", "운동", "산책", "게임", "반려동물", "스터디", "기타"] as const;
const categories: ReadonlySet<string> = new Set(POST_CATEGORIES);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxCursorLength = 4096;

/** PostgreSQL의 마이크로초를 반올림하지 않고 비교한다. 외부 반환은 원문 ISO 시각을 유지한다. */
export function parseSearchTimestampMicroseconds(value: string): bigint {
  if (typeof value !== "string") throw new Error("INVALID_SEARCH_TIMESTAMP");
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) throw new Error("INVALID_SEARCH_TIMESTAMP");
  const [, y, m, d, h, min, sec, fraction = "", zone] = parts;
  const year = Number(y), month = Number(m), day = Number(d);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (year < 1 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day || Number(h) > 23 || Number(min) > 59 || Number(sec) > 59 ||
    (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    throw new Error("INVALID_SEARCH_TIMESTAMP");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("INVALID_SEARCH_TIMESTAMP");
  return BigInt(timestamp) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3));
}
/** 기존 밀리초 helper 호환. 정렬·기간·커서의 정밀 비교는 위 bigint 함수를 사용한다. */
export function parseSearchTimestamp(value: string): number {
  parseSearchTimestampMicroseconds(value);
  return Date.parse(value);
}

export function normalizePublicPostListInput(input: PublicPostListInput): NormalizedPublicPostListInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_FILTER");
  const allowed = new Set(["caller", "availability", "sort", "query", "period", "category", "region", "cost", "authorAge", "cursor", "limit"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("UNSUPPORTED_FILTER");
  if (input.caller !== "anonymous" && input.caller !== "member") throw new Error("INVALID_CALLER");
  const availability = input.availability === undefined ? "all" : input.availability;
  if (availability !== "all" && availability !== "recruiting") throw new Error("INVALID_FILTER");
  const sort = input.sort === undefined ? "created_desc" : input.sort;
  if (sort !== "created_desc" && sort !== "starts_asc") throw new Error("INVALID_FILTER");
  const cost = input.cost === undefined ? "all" : input.cost;
  if (!["all", "free", "paid"].includes(cost)) throw new Error("INVALID_FILTER");
  let authorAge: AuthorAgeFilter = "all";
  if (input.authorAge !== undefined && input.authorAge !== "all") {
    const age = input.authorAge;
    if (!age || typeof age !== "object" || Array.isArray(age) ||
      Object.keys(age).length !== 2 || Object.keys(age).some((key) => key !== "min" && key !== "max") ||
      !Number.isSafeInteger(age.min) || !Number.isSafeInteger(age.max) ||
      age.min < 19 || age.max > 99 || age.min > age.max) throw new Error("INVALID_FILTER");
    authorAge = { min: age.min, max: age.max };
  }
  const rawQuery = input.query === undefined ? "" : input.query;
  if (typeof rawQuery !== "string" || [...rawQuery].length > 300) throw new Error("INVALID_FILTER");
  const query = rawQuery.trim().replace(/\s+/gu, " ").toLowerCase();
  if (input.category !== undefined && !categories.has(input.category)) throw new Error("INVALID_FILTER");
  if (input.region !== undefined && !POST_REGIONS.includes(input.region)) throw new Error("INVALID_FILTER");
  const limit = input.limit === undefined ? POST_SEARCH_PAGE_SIZE : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("INVALID_FILTER");
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || !input.cursor.length ||
    input.cursor.length > maxCursorLength || !/^[A-Za-z0-9_-]+$/.test(input.cursor))) throw new Error("INVALID_CURSOR");
  let period: PostSearchPeriod | undefined;
  if (input.period !== undefined) {
    if (!input.period || typeof input.period !== "object" || Array.isArray(input.period) ||
      Object.keys(input.period).some((key) => key !== "startsAt" && key !== "endsAt")) throw new Error("INVALID_FILTER");
    if (parseSearchTimestampMicroseconds(input.period.startsAt) >= parseSearchTimestampMicroseconds(input.period.endsAt)) {
      throw new Error("INVALID_SEARCH_PERIOD");
    }
    period = { startsAt: input.period.startsAt, endsAt: input.period.endsAt };
  }
  if (input.caller === "anonymous" && (authorAge !== "all" || period !== undefined)) throw new Error("AUTH_REQUIRED");
  return { caller: input.caller, availability, sort, query, cost, authorAge, limit,
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.region !== undefined ? { region: input.region } : {}),
    ...(period ? { period } : {}), ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) };
}

function cursorFilters(input: NormalizedPublicPostListInput) {
  return { caller: input.caller, region: input.region ?? null, query: input.query, category: input.category ?? null, cost: input.cost,
    availability: input.availability, sort: input.sort, period: input.period ?? null, authorAge: input.authorAge };
}
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}
function cursorPosition(value: unknown): PublicPostCursorPosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_CURSOR");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).length !== 2 || Object.keys(p).some((key) => !["sortAt", "id"].includes(key)) ||
    typeof p.sortAt !== "string" || typeof p.id !== "string" || !uuid.test(p.id)) throw new Error("INVALID_CURSOR");
  try { parseSearchTimestampMicroseconds(p.sortAt); } catch { throw new Error("INVALID_CURSOR"); }
  return { sortAt: p.sortAt, id: p.id.toLowerCase() };
}

/** 필터가 바뀌면 새 목록을 요청한다. 입력한 검색어는 cursor에만 포함되고 로그에 기록하지 않는다. */
export function encodePublicPostCursor(input: PublicPostListInput, position: PublicPostCursorPosition): string {
  const filters = normalizePublicPostListInput(input);
  const value = { v: 3, filters: cursorFilters(filters), position: cursorPosition(position) };
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  if (encoded.length > maxCursorLength) throw new Error("INVALID_CURSOR");
  return encoded;
}
export function decodePublicPostCursor(cursor: string, input: PublicPostListInput): PublicPostCursorPosition {
  const filters = normalizePublicPostListInput(input);
  try {
    if (typeof cursor !== "string" || !cursor.length || cursor.length > maxCursorLength ||
      !/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length % 4 === 1) throw new Error();
    const binary = atob(cursor.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - cursor.length % 4) % 4));
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    const value = decoded as Record<string, unknown>;
    if (Object.keys(value).length !== 3 || !Object.hasOwn(value, "position") || value.v !== 3 ||
      !sameJson(value.filters, cursorFilters(filters))) throw new Error();
    return cursorPosition(value.position);
  } catch { throw new Error("INVALID_CURSOR"); }
}
