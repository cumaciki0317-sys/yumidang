/**
 * 성향 RPC 응답 검사(제안 SQL 02_profile_traits.sql). 회원 본인 JWT의 RpcClient로만 호출한다.
 * 작성자 ID·실명은 받지 않으며 여분 필드가 섞인 응답은 거절한다. 원본 성향 목록은 모델 판단 입력에만 쓰고 응답에 넣지 않는다.
 */
import type { JsonValue } from "../../../contracts/common.ts";
import type { TrustedChatContext } from "../../../contracts/ai.ts";
import type { RpcClient } from "../../../db/transport.ts";

/** 등록 성향 상한: 한 종류 최대 20개, 값 1~40자. 2026-09-30 사용자 결정(Q9-A)으로 기술 상한을 제품 기준으로 채택했다. */
export const TRAIT_VALUES_TECHNICAL_CAP = 20;
export const TRAIT_TEXT_TECHNICAL_MAX_CHARS = 40;
/** get_post_author_traits 한 번의 최대 ID 수. 검색 v2 페이지 최대(50)와 같다. */
export const AUTHOR_TRAITS_MAX_IDS = 50;
export interface AuthorTraits { interests: string[]; conversationStyles: string[]; mbti: string | null; traitsVersion: string }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function invalid(): never { throw new Error("INVALID_TRAITS_RESPONSE"); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}
function traitList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > TRAIT_VALUES_TECHNICAL_CAP) return invalid();
  return value.map((item) => {
    if (typeof item !== "string" || !item || item.trim() !== item || [...item].length > TRAIT_TEXT_TECHNICAL_MAX_CHARS) return invalid();
    return item;
  });
}
function mbti(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[EI][NS][TF][JP]$/.test(value)) return invalid();
  return value;
}

/** 요청 ID 중 현재 회원에게 보이지 않는(삭제 등) 공고는 결과에 없다. 호출자가 후보에서 제외한다. */
export async function fetchPostAuthorTraits(db: RpcClient, postIds: readonly string[]): Promise<Map<string, AuthorTraits>> {
  const ids = postIds.map((id) => id.toLowerCase());
  if (!ids.length) return new Map();
  if (ids.length > AUTHOR_TRAITS_MAX_IDS || new Set(ids).size !== ids.length || ids.some((id) => !uuid.test(id))) throw new Error("INVALID_TRAITS_REQUEST");
  const body = exact(await db.rpc("get_post_author_traits", { p_post_ids: ids as JsonValue[] }), ["items"]);
  if (!Array.isArray(body.items) || body.items.length > ids.length) return invalid();
  const requested = new Set(ids);
  const result = new Map<string, AuthorTraits>();
  for (const raw of body.items) {
    const item = exact(raw, ["postId", "interests", "conversationStyles", "mbti", "traitsVersion"]);
    if (typeof item.postId !== "string") return invalid();
    const postId = item.postId.toLowerCase();
    if (!requested.has(postId) || result.has(postId) || typeof item.traitsVersion !== "string" || !/^[0-9a-f]{32}$/.test(item.traitsVersion)) return invalid();
    result.set(postId, { interests: traitList(item.interests), conversationStyles: traitList(item.conversationStyles),
      mbti: mbti(item.mbti), traitsVersion: item.traitsVersion });
  }
  return result;
}

/** 요청 회원 본인의 성향. 본문 userId가 아니라 인증 JWT(auth.uid())로 DB가 결정한다. */
export async function loadMyPreferences(db: RpcClient): Promise<NonNullable<TrustedChatContext["preferences"]>> {
  const body = exact(await db.rpc("get_my_profile_traits", {}), ["interests", "conversationStyles", "mbti"]);
  const interests = traitList(body.interests);
  const conversationStyles = traitList(body.conversationStyles);
  const value = mbti(body.mbti);
  return { ...(interests.length ? { interests } : {}), ...(conversationStyles.length ? { conversationStyles } : {}),
    ...(value ? { mbti: value } : {}) };
}
