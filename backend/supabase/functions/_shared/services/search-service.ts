/** DB 페이지의 순서를 보존하는 검색 서비스와 기존 가상 전체 집합 helper. */
import { decodePublicPostCursor, normalizePublicPostListInput, parseSearchTimestampMicroseconds } from "../contracts/search.ts";
import type { PublicPostCard, PublicPostCost, PublicPostListInput, PublicPostListResult,
  PublicPostPageResult, PublicPostSearchRow, SearchCaller } from "../contracts/search.ts";
import type { PagedPublicPostSearchRepository, PublicPostSearchRepository } from "../db/repositories/search.ts";

const displayStates = new Set(["recruiting", "confirmed", "closed", "expired"]);
/** DB posts_public_area_format과 같은 공개 지역 형식. 원문을 축약하거나 보정하지 않는다. */
const publicArea = /^[가-힣]+(?:특별시|광역시|특별자치시|특별자치도|도) [가-힣]+(?:시|군|구)(?: [가-힣]+구)? [가-힣0-9]+(?:동|읍|면|가)$/;
function publicCost(value: unknown): PublicPostCost {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_POST_COST");
  const cost = value as Record<string, unknown>;
  if (cost.kind === "unknown") return { kind: "unknown" };
  if (cost.kind === "free") return { kind: "free" };
  if ((cost.kind !== "paid_request" && cost.kind !== "paid_offer") ||
    typeof cost.amount !== "number" || !Number.isSafeInteger(cost.amount) || cost.amount <= 0) throw new Error("INVALID_POST_COST");
  return cost.kind === "paid_request"
    ? { kind: "paid_request", amount: cost.amount, direction: "author_to_applicant" }
    : { kind: "paid_offer", amount: cost.amount, direction: "applicant_to_author" };
}

/** RPC가 권한을 적용한 단일 표시 이름을 사용하며 여분의 원문 필드는 복사하지 않는다. */
export function projectPublicPostCard(value: unknown, caller: SearchCaller): PublicPostCard {
  if (caller !== "anonymous" && caller !== "member") throw new Error("INVALID_CALLER");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PUBLIC_PROJECTION");
  const card = value as PublicPostCard;
  if (!displayStates.has(card.state)) throw new Error("INVALID_POST_STATE");
  if ([card.id, card.title, card.publicArea, card.authorDisplayName].some((field) => typeof field !== "string" || !field.trim()) ||
    typeof card.canApply !== "boolean" || card.publicArea.trim() !== card.publicArea ||
    [...card.publicArea].length > 60 || !publicArea.test(card.publicArea)) throw new Error("INVALID_PUBLIC_PROJECTION");
  if (parseSearchTimestampMicroseconds(card.startsAt) >= parseSearchTimestampMicroseconds(card.endsAt)) throw new Error("INVALID_POST_PERIOD");
  const cost = publicCost(card.cost);
  return { id: card.id, title: card.title, authorDisplayName: card.authorDisplayName, publicArea: card.publicArea,
    startsAt: card.startsAt, endsAt: card.endsAt, cost, state: card.state,
    canApply: caller === "member" && card.state === "recruiting" && cost.kind !== "unknown" && card.canApply };
}

export function toPublicPostCard(row: PublicPostSearchRow, caller: SearchCaller): PublicPostCard {
  if (!row || [row.anonymousAlias, row.maskedName].some((value) => typeof value !== "string" || !value.trim()) ||
    typeof row.eligibleToApply !== "boolean") throw new Error("INVALID_PUBLIC_PROJECTION");
  parseSearchTimestampMicroseconds(row.createdAt);
  return projectPublicPostCard({ id: row.id, title: row.title,
    authorDisplayName: caller === "anonymous" ? row.anonymousAlias : row.maskedName,
    publicArea: row.publicAreaDistrict, startsAt: row.startsAt, endsAt: row.endsAt,
    cost: row.cost, state: row.state, canApply: row.eligibleToApply }, caller);
}

/** 기존 가상 전체 집합 helper. 실제 RPC 페이지를 이 함수에 넣지 않는다. */
export function listProjectedPublicPosts(rows: readonly PublicPostSearchRow[], input: PublicPostListInput): PublicPostListResult {
  const filters = normalizePublicPostListInput(input);
  if (filters.authorAge !== "all" || filters.cursor !== undefined) throw new Error("UNSUPPORTED_FILTER");
  const periodStart = filters.period ? parseSearchTimestampMicroseconds(filters.period.startsAt) : undefined;
  const periodEnd = filters.period ? parseSearchTimestampMicroseconds(filters.period.endsAt) : undefined;
  const ids = new Set<string>();
  const selected = rows.map((row) => {
    const card = toPublicPostCard(row, filters.caller);
    if (ids.has(card.id)) throw new Error("DUPLICATE_POST_ID");
    ids.add(card.id);
    return { card, startsAt: parseSearchTimestampMicroseconds(row.startsAt), endsAt: parseSearchTimestampMicroseconds(row.endsAt),
      createdAt: parseSearchTimestampMicroseconds(row.createdAt) };
  }).filter(({ card, startsAt, endsAt }) =>
    (filters.availability === "all" || card.state === "recruiting") &&
    (filters.cost === "all" || (filters.cost === "free" ? card.cost.kind === "free" : card.cost.kind === "paid_request" || card.cost.kind === "paid_offer")) &&
    (periodStart === undefined || periodEnd === undefined || (startsAt < periodEnd && endsAt > periodStart)));
  selected.sort((a, b) => {
    const difference = filters.sort === "starts_asc" ? a.startsAt - b.startsAt : b.createdAt - a.createdAt;
    if (difference !== 0n) return difference < 0n ? -1 : 1;
    return a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0;
  });
  const posts = selected.map(({ card }) => card);
  return { status: posts.length ? "results" : "no_results", posts };
}

export function searchPublicPosts(repository: PagedPublicPostSearchRepository, input: PublicPostListInput): Promise<PublicPostPageResult>;
export function searchPublicPosts(repository: PublicPostSearchRepository, input: PublicPostListInput): Promise<PublicPostListResult>;
export async function searchPublicPosts(repository: PagedPublicPostSearchRepository | PublicPostSearchRepository,
  input: PublicPostListInput): Promise<PublicPostListResult | PublicPostPageResult> {
  const filters = normalizePublicPostListInput(input);
  if ("searchPage" in repository) {
    if (filters.cursor !== undefined) decodePublicPostCursor(filters.cursor, filters);
    const page = await repository.searchPage(filters);
    if (!page || !Array.isArray(page.items) || page.items.length > filters.limit ||
      (page.nextCursor !== null && typeof page.nextCursor !== "string") || (!page.items.length && page.nextCursor !== null)) {
      throw new Error("INVALID_SEARCH_PAGE");
    }
    const ids = new Set<string>();
    const posts = page.items.map((item) => {
      const card = projectPublicPostCard(item, filters.caller);
      if (ids.has(card.id)) throw new Error("DUPLICATE_POST_ID");
      ids.add(card.id);
      return card;
    });
    if (page.nextCursor !== null) decodePublicPostCursor(page.nextCursor, filters);
    return { status: posts.length ? "results" : "no_results", posts, nextCursor: page.nextCursor };
  }
  if (filters.authorAge !== "all" || filters.cursor !== undefined) throw new Error("UNSUPPORTED_FILTER");
  return listProjectedPublicPosts(await repository.search(filters), filters);
}
