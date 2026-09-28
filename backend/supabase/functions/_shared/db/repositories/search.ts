/**
 * 검색 저장소의 순수 일치 규칙과 가상 어댑터. 실제 SQL/RPC는 연결하지 않았다.
 * 등록 주소는 이 경계에서 일치 판단에만 쓰며 서비스·AI에 전달하지 않는다.
 */
import { normalizePublicPostListInput } from "../../contracts/search.ts";
import type {
  PublicPostListInput,
  PublicPostSearchRow,
} from "../../contracts/search.ts";

export interface PostSearchIndexFields {
  title: string;
  registeredPlaceName?: string | null;
  registeredAddress?: string | null;
}

/** DB 내부 검색 후보. 상세 만남 지점·기존 exact_location을 추가하지 않는다. */
export interface PostSearchCandidate {
  publicRow: PublicPostSearchRow;
  index: PostSearchIndexFields;
  category: string;
}

/**
 * 조회 결과는 호출자의 공개 범위를 적용한 행만 허용한다.
 * 현재 코어는 전체 일치 집합을 정렬한다. 페이지/커서는 실제 DB 정렬 계약 후 연결한다.
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
    [fields.registeredPlaceName, fields.registeredAddress]
      .some((value) => value != null && typeof value !== "string")) {
    throw new Error("INVALID_SEARCH_INDEX");
  }
  if (!query) return true;
  return [fields.title, fields.registeredPlaceName, fields.registeredAddress]
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
  return candidates.filter((candidate) => {
    if (!candidate?.publicRow || !candidate.index ||
      candidate.index.title !== candidate.publicRow.title ||
      typeof candidate.category !== "string" || !candidate.category.trim()) {
      throw new Error("INVALID_SEARCH_SOURCE");
    }
    const matchesQuery = matchesPostKeyword(candidate.index, filters.query);
    return matchesQuery &&
      (filters.category === undefined || candidate.category === filters.category) &&
      (filters.cost === "all" || (filters.cost === "free"
        ? candidate.publicRow.cost.kind === "free"
        : ["paid_request", "paid_offer"].includes(candidate.publicRow.cost.kind)));
  }).map(({ publicRow }) => ({
    id: publicRow.id,
    title: publicRow.title,
    anonymousAlias: publicRow.anonymousAlias,
    maskedName: publicRow.maskedName,
    publicAreaDistrict: publicRow.publicAreaDistrict,
    startsAt: publicRow.startsAt,
    endsAt: publicRow.endsAt,
    createdAt: publicRow.createdAt,
    cost: publicRow.cost.kind === "free"
      ? { kind: "free" }
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
