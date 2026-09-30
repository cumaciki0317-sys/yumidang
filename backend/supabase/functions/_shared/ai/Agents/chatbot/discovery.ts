/**
 * 공고 AI 탐색의 실제 PublicDiscoveryPort. 요청 회원의 RpcClient(JWT·RLS 유지)로만 동작한다.
 * 1) 기존 검색 코어(search_public_posts_v2)에 일반 조건·정렬을 먼저 적용하고 DB 순서를 그대로 따른다.
 * 2) 요청한 성향 조건이 있으면 페이지의 작성자 성향(get_post_author_traits)을 읽어 MBTI는 정확 일치,
 *    관심사·대화 방식은 C 방식 의미 판단으로 거른다. 유사도로 재정렬하지 않는다.
 * 3) 반환 분량을 채우거나 후보를 끝까지 확인할 때까지 다음 페이지를 처리하고, 설정 한도에 먼저 닿으면 incomplete.
 * 한도는 모두 명시 설정값이며 기본값이 없다. 원본 성향·판단 근거는 반환하지 않는다.
 */
import type { AiCard, AiFilters, CardConditionStatus, ConditionState } from "../../../contracts/ai.ts";
import type { PublicPostCard, PublicPostListInput } from "../../../contracts/search.ts";
import type { RpcClient } from "../../../db/transport.ts";
import { createRpcPublicPostSearchRepository } from "../../../db/repositories/search.ts";
import { searchPublicPosts } from "../../../services/search-service.ts";
import type { ModelPort } from "../../providers/model-port.ts";
import { ModelError } from "../../providers/provider-errors.ts";
import { judgePreferences, PREFERENCE_FIELDS, preferenceFieldState, PreferenceJudgmentError,
  type PreferenceField, type PreferenceJudgeCandidate } from "./preference-match.ts";
import { AUTHOR_TRAITS_MAX_IDS, fetchPostAuthorTraits, type AuthorTraits } from "./traits.ts";
import { matchesExplicitMbti, type DiscoveredCard, type DiscoveryResult, type PublicDiscoveryPort } from "./tools.ts";

export interface DiscoveryLimits {
  /** 검색 v2 한 페이지 크기(1~50). */
  pageSize: number;
  /** 한 탐색에서 읽을 최대 검색 페이지 수. */
  maxSearchPages: number;
  /** 응답 직전 재확인에서 읽을 최대 검색 페이지 수. */
  recheckMaxPages: number;
  /** 한 응답의 최대 카드 수. */
  maxResultCards: number;
  /** 의미 판단 한 번에 보낼 최대 후보 수. */
  matchBatchSize: number;
  /** 한 탐색의 최대 의미 판단 호출 수. */
  maxMatchCalls: number;
  /** 의미 판단 호출의 최대 출력 토큰. */
  matchMaxOutputTokens: number;
}
export function assertDiscoveryLimits(limits: DiscoveryLimits): void {
  const values = [limits?.pageSize, limits?.maxSearchPages, limits?.recheckMaxPages, limits?.maxResultCards,
    limits?.matchBatchSize, limits?.maxMatchCalls, limits?.matchMaxOutputTokens];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1) || limits.pageSize > AUTHOR_TRAITS_MAX_IDS) {
    throw new Error("DISCOVERY_LIMITS_NOT_CONFIGURED");
  }
}

function formatWon(amount: number): string {
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
/** 공개 카드의 비용을 표시 문구로만 바꾼다. 비용 미확인을 무료로 추정하지 않는다. */
export function postCostLabel(cost: PublicPostCard["cost"]): string {
  switch (cost.kind) {
    case "free": return "무료";
    case "unknown": return "비용 미확인";
    case "paid_request": return `유료 ${formatWon(cost.amount)}원 (작성자→신청자)`;
    case "paid_offer": return `유료 ${formatWon(cost.amount)}원 (신청자→작성자)`;
    default: throw new Error("INVALID_POST_COST");
  }
}
export function toAiPostCard(card: PublicPostCard): AiCard {
  return { kind: "post", id: card.id, title: card.title, locationLabel: card.publicArea, startsAtOrDate: card.startsAt,
    endsAtOrDate: card.endsAt, costLabel: postCostLabel(card.cost), state: card.state, canApply: card.canApply };
}

type Period = { startsAt: string; endsAt: string } | undefined;
function searchInput(filters: AiFilters, period: Period, limit: number, cursor?: string): PublicPostListInput {
  return {
    caller: "member", limit,
    ...(filters.query !== undefined ? { query: filters.query } : {}),
    ...(filters.category !== undefined ? { category: filters.category } : {}),
    ...(filters.cost !== undefined ? { cost: filters.cost } : {}),
    ...(filters.availability !== undefined ? { availability: filters.availability } : {}),
    ...(filters.sort !== undefined ? { sort: filters.sort } : {}),
    ...(filters.authorAge !== undefined ? { authorAge: filters.authorAge } : {}),
    ...(period ? { period } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}
function requestedTraitFields(filters: AiFilters): PreferenceField[] {
  return PREFERENCE_FIELDS.filter((field) => filters[field] !== undefined);
}
function needsTraits(filters: AiFilters): boolean {
  return filters.mbti !== undefined || requestedTraitFields(filters).length > 0;
}

interface Entry {
  card: AiCard;
  traits?: AuthorTraits;
  status: CardConditionStatus;
  /** 의미 판단이 필요한 종류(요청했고 등록값이 있음). */
  judgeFields: PreferenceField[];
  excluded: boolean;
}

export function createPostDiscovery(deps: { db: RpcClient; model: ModelPort; limits: DiscoveryLimits }): PublicDiscoveryPort {
  assertDiscoveryLimits(deps.limits);
  const repository = createRpcPublicPostSearchRepository(deps.db);
  const { limits } = deps;
  const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("CANCELLED"); };

  /** 페이지 카드의 성향 상태를 정한다. MBTI 불일치는 즉시 제외, 미입력은 확인 필요. */
  function prepare(cards: AiCard[], filters: AiFilters, traits: Map<string, AuthorTraits> | undefined): Entry[] {
    const fields = requestedTraitFields(filters);
    const entries: Entry[] = [];
    for (const card of cards) {
      if (!traits) { entries.push({ card, status: {}, judgeFields: [], excluded: false }); continue; }
      const found = traits.get(card.id);
      // 검색과 성향 조회 사이에 보이지 않게 된 공고는 판단하지 않는다.
      if (!found) continue;
      const status: CardConditionStatus = {};
      if (filters.mbti !== undefined) {
        const mbti = matchesExplicitMbti(filters.mbti, found.mbti);
        if (mbti === "mismatch") continue;
        status.mbti = mbti === "match" ? "match" : "needs_check";
      }
      const judgeFields: PreferenceField[] = [];
      for (const field of fields) {
        if (found[field].length) judgeFields.push(field);
        else status[field] = "needs_check";
      }
      entries.push({ card, traits: found, status, judgeFields, excluded: false });
    }
    return entries;
  }

  async function judge(batch: Entry[], filters: AiFilters, signal?: AbortSignal): Promise<void> {
    const requested: { interests?: string[]; conversationStyles?: string[] } = {};
    const candidates: PreferenceJudgeCandidate[] = batch.map((entry, index) => {
      const candidate: PreferenceJudgeCandidate = { ref: `c${index + 1}` };
      for (const field of entry.judgeFields) {
        requested[field] ??= filters[field]!.values.map((value) => value.text);
        candidate[field] = [...entry.traits![field]];
      }
      return candidate;
    });
    const judgments = await judgePreferences(deps.model, { requested, candidates },
      { maxOutputTokens: limits.matchMaxOutputTokens, signal });
    batch.forEach((entry, index) => {
      const result = judgments.get(`c${index + 1}`);
      if (!result) throw new PreferenceJudgmentError();
      for (const field of entry.judgeFields) {
        const state = preferenceFieldState(filters[field]!, entry.traits![field], result[field]);
        if (state === "mismatch") entry.excluded = true;
        else entry.status[field] = state as ConditionState;
      }
    });
  }

  function accept(entry: Entry): DiscoveredCard {
    const status = Object.keys(entry.status).length ? { conditionStatus: { ...entry.status } } : {};
    return { ...entry.card, ...status, ...(entry.traits ? { traitsVersion: entry.traits.traitsVersion } : {}) };
  }

  return {
    async search({ filters, period, signal }): Promise<DiscoveryResult> {
      if (filters.target !== "posts") throw new Error("UNSUPPORTED_TARGET");
      const withTraits = needsTraits(filters);
      const accepted: DiscoveredCard[] = [];
      let matchCalls = 0;
      let cursor: string | undefined;
      for (let page = 1; page <= limits.maxSearchPages; page += 1) {
        cancelled(signal);
        const result = await searchPublicPosts(repository, searchInput(filters, period, limits.pageSize, cursor));
        cancelled(signal);
        const cards = result.posts.map(toAiPostCard);
        const traits = withTraits && cards.length ? await fetchPostAuthorTraits(deps.db, cards.map((card) => card.id)) : undefined;
        const entries = prepare(cards, filters, withTraits ? traits ?? new Map() : undefined);
        let index = 0;
        while (index < entries.length) {
          // DB 순서의 연속 구간을 묶어 판단한다. 구간 안의 모든 후보가 결정된 뒤 순서대로 채택한다.
          const batch: Entry[] = [];
          let end = index;
          while (end < entries.length && batch.length < limits.matchBatchSize) {
            if (entries[end].judgeFields.length) batch.push(entries[end]);
            end += 1;
          }
          if (batch.length) {
            if (matchCalls >= limits.maxMatchCalls) return { cards: accepted, coverage: "incomplete" };
            matchCalls += 1;
            cancelled(signal);
            try {
              await judge(batch, filters, signal);
            } catch (error) {
              // 예산 소진 전에 확정한 카드만 재확인 단계로 보낸다. 미판정 묶음은 포함하지 않는다.
              cancelled(signal);
              if (error instanceof ModelError && error.code === "BUDGET_EXHAUSTED") return { cards: accepted, coverage: "incomplete" };
              throw error;
            }
          }
          for (let k = index; k < end; k += 1) {
            if (entries[k].excluded) continue;
            accepted.push(accept(entries[k]));
            if (accepted.length >= limits.maxResultCards) return { cards: accepted, coverage: "filled" };
          }
          index = end;
        }
        if (result.nextCursor === null) return { cards: accepted, coverage: "exhausted" };
        cursor = result.nextCursor;
      }
      // 페이지 한도에 먼저 닿았다. 남은 후보를 확인하지 않았으므로 결과 없음/완료로 표시하지 않는다.
      return { cards: accepted, coverage: "incomplete" };
    },

    async recheck({ filters, period, cards, signal }) {
      if (filters.target !== "posts" || cards.some((card) => card.kind !== "post")) throw new Error("UNSUPPORTED_TARGET");
      const remaining = new Set(cards.map((card) => card.id));
      const found = new Map<string, AiCard>();
      let exhausted = false;
      let cursor: string | undefined;
      for (let page = 1; page <= limits.recheckMaxPages && remaining.size; page += 1) {
        cancelled(signal);
        const result = await searchPublicPosts(repository, searchInput(filters, period, limits.pageSize, cursor));
        for (const post of result.posts) {
          if (remaining.delete(post.id)) found.set(post.id, toAiPostCard(post));
        }
        if (result.nextCursor === null) { exhausted = true; break; }
        cursor = result.nextCursor;
      }
      // 한도 안에 찾지 못한 카드는 보이는지 확인하지 못한 것이다. 사라진 것으로 단정하지 않는다.
      if (remaining.size && !exhausted) return { cards: [], complete: false };
      let traits: Map<string, AuthorTraits> | undefined;
      if (needsTraits(filters) && found.size) {
        cancelled(signal);
        traits = await fetchPostAuthorTraits(deps.db, [...found.keys()]);
      }
      const fresh: AiCard[] = [];
      for (const target of cards) {
        const card = found.get(target.id);
        if (!card) continue;
        if (needsTraits(filters)) {
          const current = traits?.get(target.id);
          // 판정에 쓴 성향이 바뀌었거나 보이지 않으면 옛 판정으로 반환하지 않는다.
          if (!current || typeof target.traitsVersion !== "string" || current.traitsVersion !== target.traitsVersion) continue;
          fresh.push({ ...card, ...(target.conditionStatus ? { conditionStatus: { ...target.conditionStatus } } : {}) });
        } else fresh.push(card);
      }
      return { cards: fresh, complete: true };
    },
  };
}
