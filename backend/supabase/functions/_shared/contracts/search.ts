/**
 * 공개 검색의 내부 입력과 공개 카드 계약.
 * 실제 인증·DB 필드·RPC·HTTP 오류 형식은 민규 담당 계약과 연결 전이다.
 */
export type SearchCaller = "anonymous" | "member";
export type PostAvailability = "all" | "recruiting";
export type PostDisplayState = "recruiting" | "confirmed" | "closed" | "expired";
export type PostCostFilter = "all" | "free" | "paid";

export type PostCost =
  | { kind: "free" }
  | { kind: "paid_request"; amount: number }
  | { kind: "paid_offer"; amount: number };

/** 지급 방향은 유형에서 계산하며 계좌·인증 원문은 포함하지 않는다. */
export type PublicPostCost =
  | { kind: "free" }
  | { kind: "paid_request"; amount: number; direction: "author_to_applicant" }
  | { kind: "paid_offer"; amount: number; direction: "applicant_to_author" };

/** 입력 계층이 한국 달력 날짜를 변환한 [시작, 종료) 시각 구간. */
export interface PostSearchPeriod {
  startsAt: string;
  endsAt: string;
}

/** 검색 저장소가 권한을 적용해 내놓는 값. 검색에 쓰인 주소는 포함하지 않는다. */
export interface PublicPostSearchRow {
  id: string;
  title: string;
  anonymousAlias: string;
  maskedName: string;
  publicAreaDistrict: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  cost: PostCost;
  state: PostDisplayState;
  /** 인증·공고 상태 외의 신청 조건은 저장소가 판정한다. */
  eligibleToApply: boolean;
}

export interface PublicPostCard {
  id: string;
  title: string;
  authorDisplayName: string;
  publicArea: string;
  startsAt: string;
  endsAt: string;
  cost: PublicPostCost;
  state: PostDisplayState;
  canApply: boolean;
}

export interface PublicPostListInput {
  /** 공통 인증 계층이 정한다. 클라이언트가 보낸 회원 표시를 신뢰하지 않는다. */
  caller: SearchCaller;
  availability?: PostAvailability;
  query?: string;
  period?: PostSearchPeriod;
  /** 공통 서비스의 카테고리 식별자와 완전 일치. 자체 enum을 만들지 않는다. */
  category?: string;
  cost?: PostCostFilter;
}

export interface NormalizedPublicPostListInput extends PublicPostListInput {
  availability: PostAvailability;
  query: string;
  cost: PostCostFilter;
}

export interface PublicPostListResult {
  status: "results" | "no_results";
  posts: PublicPostCard[];
}

/** 시간대 없는 시각과 Date.parse가 자동 보정하는 잘못된 달력 날짜를 거절한다. */
export function parseSearchTimestamp(value: string): number {
  if (typeof value !== "string") throw new Error("INVALID_SEARCH_TIMESTAMP");
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) throw new Error("INVALID_SEARCH_TIMESTAMP");
  const [, y, m, d, h, min, sec, zone] = parts;
  const year = Number(y), month = Number(m), day = Number(d);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day || Number(h) > 23 || Number(min) > 59 || Number(sec) > 59 ||
    (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    throw new Error("INVALID_SEARCH_TIMESTAMP");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("INVALID_SEARCH_TIMESTAMP");
  return timestamp;
}

/** 미지원 조건을 조용히 무시하지 않는다. 나이·커서·주변 검색은 연결 계약 후 추가한다. */
export function normalizePublicPostListInput(input: PublicPostListInput): NormalizedPublicPostListInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_FILTER");
  const allowed = new Set(["caller", "availability", "query", "period", "category", "cost"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("UNSUPPORTED_FILTER");
  if (input.caller !== "anonymous" && input.caller !== "member") throw new Error("INVALID_CALLER");
  const availability = input.availability === undefined ? "all" : input.availability;
  if (availability !== "all" && availability !== "recruiting") throw new Error("INVALID_FILTER");
  const cost = input.cost === undefined ? "all" : input.cost;
  if (cost !== "all" && cost !== "free" && cost !== "paid") throw new Error("INVALID_FILTER");
  const query = input.query === undefined ? "" : input.query;
  if (typeof query !== "string") throw new Error("INVALID_FILTER");
  if (input.category !== undefined && (typeof input.category !== "string" || !input.category.trim())) {
    throw new Error("INVALID_FILTER");
  }
  let period: PostSearchPeriod | undefined;
  if (input.period !== undefined) {
    if (!input.period || typeof input.period !== "object" || Array.isArray(input.period) ||
      Object.keys(input.period).some((key) => key !== "startsAt" && key !== "endsAt")) {
      throw new Error("INVALID_FILTER");
    }
    const start = parseSearchTimestamp(input.period.startsAt);
    const end = parseSearchTimestamp(input.period.endsAt);
    if (start >= end) throw new Error("INVALID_SEARCH_PERIOD");
    period = { startsAt: input.period.startsAt, endsAt: input.period.endsAt };
  }
  return {
    caller: input.caller,
    availability,
    query,
    cost,
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(period ? { period } : {}),
  };
}
