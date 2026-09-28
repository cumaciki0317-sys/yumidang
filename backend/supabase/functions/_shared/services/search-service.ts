/**
 * 권한이 적용된 검색 행의 시간·상태·정렬·공개 카드 투영.
 * 인증, 검색용 주소의 SQL/RPC 조회, DB 권한·페이지 연결은 공통 계약 이후에 한다.
 */
import {
  normalizePublicPostListInput,
  parseSearchTimestamp,
} from "../contracts/search.ts";
import type {
  PublicPostCard,
  PublicPostCost,
  PublicPostListInput,
  PublicPostListResult,
  PublicPostSearchRow,
} from "../contracts/search.ts";
import type { PublicPostSearchRepository } from "../db/repositories/search.ts";

const displayStates = new Set(["recruiting", "confirmed", "closed", "expired"]);

function publicCost(row: PublicPostSearchRow): PublicPostCost {
  if (!row.cost || typeof row.cost !== "object") throw new Error("INVALID_POST_COST");
  if (row.cost.kind === "free") return { kind: "free" };
  if (!["paid_request", "paid_offer"].includes(row.cost.kind) ||
    typeof row.cost.amount !== "number" || !Number.isFinite(row.cost.amount) || row.cost.amount <= 0) {
    throw new Error("INVALID_POST_COST");
  }
  return row.cost.kind === "paid_request"
    ? { kind: "paid_request", amount: row.cost.amount, direction: "author_to_applicant" }
    : { kind: "paid_offer", amount: row.cost.amount, direction: "applicant_to_author" };
}

export function toPublicPostCard(
  row: PublicPostSearchRow,
  caller: PublicPostListInput["caller"],
): PublicPostCard {
  if (caller !== "anonymous" && caller !== "member") throw new Error("INVALID_CALLER");
  if (!row || !displayStates.has(row.state)) throw new Error("INVALID_POST_STATE");
  if ([row.id, row.title, row.publicAreaDistrict, row.anonymousAlias, row.maskedName]
      .some((value) => typeof value !== "string" || !value.trim()) ||
    typeof row.eligibleToApply !== "boolean") {
    throw new Error("INVALID_PUBLIC_PROJECTION");
  }
  if (parseSearchTimestamp(row.startsAt) >= parseSearchTimestamp(row.endsAt)) {
    throw new Error("INVALID_POST_PERIOD");
  }
  parseSearchTimestamp(row.createdAt);

  // 객체와 중첩 비용도 필드를 하나씩 고른다. 여분의 민감 필드를 복사하지 않는다.
  return {
    id: row.id,
    title: row.title,
    authorDisplayName: caller === "anonymous" ? row.anonymousAlias : row.maskedName,
    publicArea: row.publicAreaDistrict,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    cost: publicCost(row),
    state: row.state,
    canApply: caller === "member" && row.state === "recruiting" && row.eligibleToApply,
  };
}

/**
 * 키워드·카테고리·비용 일치는 저장소에서 끝난 행을 받는다.
 * 상태/일정은 전체 일치 집합에서 필터·정렬하며 원본 배열을 변경하지 않는다.
 */
export function listProjectedPublicPosts(
  rows: readonly PublicPostSearchRow[],
  input: PublicPostListInput,
): PublicPostListResult {
  const filters = normalizePublicPostListInput(input);
  const periodStart = filters.period ? parseSearchTimestamp(filters.period.startsAt) : undefined;
  const periodEnd = filters.period ? parseSearchTimestamp(filters.period.endsAt) : undefined;
  const ids = new Set<string>();
  const selected = rows.map((row) => {
    const card = toPublicPostCard(row, filters.caller);
    if (ids.has(card.id)) throw new Error("DUPLICATE_POST_ID");
    ids.add(card.id);
    return {
      card,
      startsAt: parseSearchTimestamp(row.startsAt),
      endsAt: parseSearchTimestamp(row.endsAt),
      createdAt: parseSearchTimestamp(row.createdAt),
    };
  }).filter(({ card, startsAt, endsAt }) =>
    (filters.availability === "all" || card.state === "recruiting") &&
    (periodStart === undefined || periodEnd === undefined ||
      (startsAt < periodEnd && endsAt > periodStart))
  );

  selected.sort((a, b) => {
    // 기간 안에 시작하는 그룹이 이전부터 겹치는 그룹보다 우선한다.
    if (periodStart !== undefined) {
      const groupDifference = Number(a.startsAt < periodStart) - Number(b.startsAt < periodStart);
      if (groupDifference) return groupDifference;
    }
    const aRecruiting = a.card.state === "recruiting";
    const bRecruiting = b.card.state === "recruiting";
    if (aRecruiting !== bRecruiting) return aRecruiting ? -1 : 1;
    const timeDifference = aRecruiting ? a.startsAt - b.startsAt : b.createdAt - a.createdAt;
    if (timeDifference) return timeDifference;
    return a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0;
  });
  const posts = selected.map(({ card }) => card);
  return { status: posts.length ? "results" : "no_results", posts };
}

/** 주입한 저장소를 일반 검색·AI가 공유한다. 실제 인증된 호출자 정보는 진입점이 제공한다. */
export async function searchPublicPosts(
  repository: PublicPostSearchRepository,
  input: PublicPostListInput,
): Promise<PublicPostListResult> {
  const filters = normalizePublicPostListInput(input);
  const rows = await repository.search(filters);
  return listProjectedPublicPosts(rows, filters);
}
