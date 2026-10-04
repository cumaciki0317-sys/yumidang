/**
 * 검색 저장소의 순수 일치 규칙·가상 어댑터와 v2 RPC 주입 어댑터.
 * 정책 버전 인수를 요구하는 v2 계약을 사용한다. 민규의 새 SQL 시그니처·HTTP 연결이 필요하다.
 * 등록 주소는 이 경계에서 일치 판단에만 쓰며 서비스·AI에 전달하지 않는다.
 */
import {
  normalizePublicPostListInput,
  encodePublicPostCursor,
  decodePublicPostCursor,
  parseSearchTimestampMicroseconds,
} from "../../contracts/search.ts";
import { projectPublicPostCard } from "../../services/search-service.ts";
import type { RpcClient } from "../transport.ts";
import type {
  PublicPostListInput,
  PublicPostSearchRow,
  PublicPostCard,
  PublicPostSearchPage,
} from "../../contracts/search.ts";

export interface PostSearchIndexFields {
  title: string;
  registeredPlaceName?: string | null;
  registeredAddress?: string | null;
  linkedEventName?: string | null;
}

/** DB 내부 검색 후보. 상세 만남 지점·기존 exact_location을 추가하지 않는다. */
export interface PostSearchCandidate {
  publicRow: PublicPostSearchRow;
  index: PostSearchIndexFields;
  category: string;
  /** 가상 검색 내부 검증용. 실제 만 나이는 DB 한국 날짜 기준으로 계산한다. */
  authorAge?: number;
  region?: string;
}

/**
 * 조회 결과는 호출자의 공개 범위를 적용한 행만 허용한다.
 * 가상 저장소 전용 전체 일치 집합이다. 운영용 페이지는 별도 searchPage 계약을 사용한다.
 */
export interface PublicPostSearchRepository {
  search(input: PublicPostListInput): Promise<readonly PublicPostSearchRow[]>;
}

export function normalizePostKeyword(value: string): string {
  if (typeof value !== "string") throw new Error("INVALID_QUERY");
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

/** 빈 검색어는 다른 선택 조건 내 전체 목록을 뜻한다. 필드들을 이어 붙이지 않는다. */
export function matchesPostKeyword(fields: PostSearchIndexFields, rawQuery: string): boolean {
  const query = normalizePostKeyword(rawQuery);
  if (!fields || typeof fields.title !== "string" ||
    [fields.registeredPlaceName, fields.registeredAddress, fields.linkedEventName]
      .some((value) => value != null && typeof value !== "string")) {
    throw new Error("INVALID_SEARCH_INDEX");
  }
  if (!query) return true;
  return [fields.title, fields.registeredPlaceName, fields.registeredAddress, fields.linkedEventName]
    .some((value) => value != null && normalizePostKeyword(value).includes(query));
}

/**
 * 검색 비공개 필드는 이 함수 밖으로 반환하지 않는다.
 * publicRow 이름·지역의 권한 처리는 실제 저장소가 보장해야 하며 가상 데이터는 검증 증거가 아니다.
 */
export function filterPostSearchCandidates(
  candidates: readonly PostSearchCandidate[],
  input: PublicPostListInput,
): PublicPostSearchRow[] {
  const filters = normalizePublicPostListInput(input);
  if (filters.cursor !== undefined) throw new Error("UNSUPPORTED_FILTER");
  return candidates.filter((candidate) => {
    if (!candidate?.publicRow || !candidate.index ||
      candidate.index.title !== candidate.publicRow.title ||
      typeof candidate.category !== "string" || !candidate.category.trim()) {
      throw new Error("INVALID_SEARCH_SOURCE");
    }
    if (filters.authorAge !== "all" && (!Number.isSafeInteger(candidate.authorAge) || candidate.authorAge! < 0)) {
      throw new Error("INVALID_SEARCH_SOURCE");
    }
    if (filters.region !== undefined && typeof candidate.region !== "string") throw new Error("INVALID_SEARCH_SOURCE");
    const matchesQuery = matchesPostKeyword(candidate.index, filters.query);
    return matchesQuery &&
      (filters.category === undefined || candidate.category === filters.category) &&
      (filters.region === undefined || candidate.region === filters.region) &&
      (filters.authorAge === "all" || (candidate.authorAge! >= filters.authorAge.min && candidate.authorAge! <= filters.authorAge.max)) &&
      (filters.cost === "all" || (filters.cost === "free"
        ? candidate.publicRow.cost.kind === "free"
        : ["paid_request", "paid_offer"].includes(candidate.publicRow.cost.kind)));
  }).map(({ publicRow }) => ({
    id: publicRow.id,
    title: publicRow.title,
    maskedName: filters.caller === "anonymous" ? null : publicRow.maskedName,
    publicAreaDistrict: publicRow.publicAreaDistrict,
    startsAt: publicRow.startsAt,
    endsAt: publicRow.endsAt,
    createdAt: publicRow.createdAt,
    cost: publicRow.cost.kind === "free" || publicRow.cost.kind === "unknown"
      ? { kind: publicRow.cost.kind }
      : { kind: publicRow.cost.kind, amount: publicRow.cost.amount },
    state: publicRow.state,
    eligibleToApply: publicRow.eligibleToApply,
  }));
}

/** 로컬 가상 테스트용. 실제 DB 권한 검사나 운영용 전체 자료 메모리 로드를 대신하지 않는다. */
export function createInMemoryPublicPostSearchRepository(
  candidates: readonly PostSearchCandidate[],
): PublicPostSearchRepository {
  return {
    async search(input) {
      return filterPostSearchCandidates(candidates, input);
    },
  };
}

/** DB에서 권한·필터·안정 정렬·페이지 절단을 끝낸 결과. 이 경계에서 재정렬하지 않는다. */
export interface PagedPublicPostSearchRepository {
  searchPage(input: PublicPostListInput): Promise<PublicPostSearchPage>;
}

const cardFields = [
  "id", "title", "authorDisplayName", "publicArea", "startsAt", "endsAt", "cost", "state", "canApply",
] as const;
function wireObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== fields.length ||
      fields.some((field) => !Object.prototype.hasOwnProperty.call(value, field))) {
    throw new Error("INVALID_SEARCH_RESPONSE");
  }
  return value as Record<string, unknown>;
}

/** NULL은 기존 자료의 확인된 비용 미상이다. 누락·잘못된 enum은 미상으로 숨기지 않는다. */
function wireCard(value: unknown, caller: PublicPostListInput["caller"]): PublicPostCard {
  const raw = wireObject(value, cardFields);
  if (typeof raw.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.id)) {
    throw new Error("INVALID_SEARCH_RESPONSE");
  }
  if (caller === "anonymous" && raw.authorDisplayName !== null) throw new Error("INVALID_SEARCH_RESPONSE");
  let cost: PublicPostCard["cost"];
  if (raw.cost === null) {
    cost = { kind: "unknown" };
  } else {
    if (!raw.cost || typeof raw.cost !== "object" || Array.isArray(raw.cost)) throw new Error("INVALID_SEARCH_RESPONSE");
    const kind = (raw.cost as Record<string, unknown>).kind;
    if (kind === "free") wireObject(raw.cost, ["kind"]);
    else if (kind === "paid_request" || kind === "paid_offer") {
      const paid = wireObject(raw.cost, ["kind", "amount", "direction"]);
      if (paid.direction !== (kind === "paid_request" ? "author_to_applicant" : "applicant_to_author")) {
        throw new Error("INVALID_SEARCH_RESPONSE");
      }
    }
    else throw new Error("INVALID_SEARCH_RESPONSE");
    cost = raw.cost as PublicPostCard["cost"];
  }
  // DB 카드의 날짜·지역·상태 투영 실패는 사용자 입력 오류(INVALID_SEARCH_TIMESTAMP 등, 400)가 아니라
  // 내부 응답 오류다. 투영 검증만 좁게 감싸며 입력 정규화·커서·db.rpc 오류는 여기서 바꾸지 않는다.
  try {
    return projectPublicPostCard({
      id: raw.id.toLowerCase(), title: raw.title, authorDisplayName: raw.authorDisplayName,
      publicArea: raw.publicArea, startsAt: raw.startsAt, endsAt: raw.endsAt,
      cost, state: raw.state, canApply: raw.canApply,
    } as PublicPostCard, caller);
  } catch {
    throw new Error("INVALID_SEARCH_RESPONSE");
  }
}

/**
 * 서버가 인증한 호출자에 맞는 RpcClient를 주입한다. caller를 DB 권한 인수로 전달하지 않는다.
 * search_public_posts_v2 오류나 공통 허용 목록 오류를 가상 자료/기존 RPC로 대체하지 않는다.
 * 새 필수 정책 버전·지역 인수가 구 SQL의 성공을 막는다. 실패를 다른 RPC로 대체하지 않는다.
 * wire: {items: public card[], nextCursor: cursor position|null}; 비용 미상만 cost:null이다.
 */
export function createRpcPublicPostSearchRepository(db: RpcClient): PagedPublicPostSearchRepository {
  if (!db || typeof db.rpc !== "function") throw new Error("INVALID_SEARCH_CLIENT");
  return {
    async searchPage(input) {
      const filters = normalizePublicPostListInput(input);
      const cursor = filters.cursor === undefined ? null : decodePublicPostCursor(filters.cursor, filters);
      const result = await db.rpc("search_public_posts_v2", {
        p_contract_version: "2026-10-05",
        p_region: filters.region ?? null,
        p_filters: {
          query: filters.query,
          category: filters.category ?? null,
          cost: filters.cost,
          availability: filters.availability,
          sort: filters.sort,
          periodStart: filters.period?.startsAt ?? null,
          periodEnd: filters.period?.endsAt ?? null,
          authorAge: filters.authorAge,
        },
        p_cursor: cursor === null ? null : {
          sortAt: cursor.sortAt, id: cursor.id,
        },
        p_limit: filters.limit,
      });
      const page = wireObject(result, ["items", "nextCursor"]);
      if (!Array.isArray(page.items) || page.items.length > filters.limit) throw new Error("INVALID_SEARCH_RESPONSE");
      const items = page.items.map((item) => wireCard(item, filters.caller));
      if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("INVALID_SEARCH_RESPONSE");
      let nextCursor: string | null = null;
      if (page.nextCursor !== null) {
        if (!items.length) throw new Error("INVALID_SEARCH_RESPONSE");
        const next = wireObject(page.nextCursor, ["sortAt", "id"]);
        const last = items[items.length - 1];
        if (typeof next.id !== "string" || next.id.toLowerCase() !== last.id ||
            typeof next.sortAt !== "string") throw new Error("INVALID_SEARCH_RESPONSE");
        const position = { sortAt: next.sortAt, id: next.id.toLowerCase() };
        try {
          const nextTime = parseSearchTimestampMicroseconds(position.sortAt);
          // 등록 시각은 공개 카드에 없다. 시작일 정렬일 때만 마지막 카드 시각과 대조한다.
          if (filters.sort === "starts_asc" && nextTime !== parseSearchTimestampMicroseconds(last.startsAt)) {
            throw new Error("INVALID_SEARCH_RESPONSE");
          }
          if (cursor !== null) {
            const previousTime = parseSearchTimestampMicroseconds(cursor.sortAt);
            const forward = nextTime === previousTime
              ? position.id > cursor.id.toLowerCase()
              : filters.sort === "created_desc" ? nextTime < previousTime : nextTime > previousTime;
            if (!forward) throw new Error("INVALID_SEARCH_RESPONSE");
          }
          // DB 원문 시각을 그대로 전달하여 마이크로초·offset을 보존한다.
          nextCursor = encodePublicPostCursor(filters, position);
        } catch {
          throw new Error("INVALID_SEARCH_RESPONSE");
        }
      }
      return { items, nextCursor };
    },
  };
}
