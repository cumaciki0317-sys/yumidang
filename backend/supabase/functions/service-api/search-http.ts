/** 민규담당. 공개 검색의 HTTP 형식만 처리한다. 정규화·커서·공개 투영은 종현 코어 책임이다. */
import type { PublicPostListInput, PublicPostPageResult, SearchCaller } from "../_shared/contracts/search.ts";
import type { RpcClient } from "../_shared/db/transport.ts";
import { HttpError } from "../_shared/http/errors.ts";

/** HTTP 입력은 종현의 v2 검색 계약과 동일하며 caller만 검증된 인증 문맥에서 채운다. */
export type HttpPostSearchInput = PublicPostListInput;
export type PublicPostSearchExecutor = (db: RpcClient, input: HttpPostSearchInput) => Promise<PublicPostPageResult>;
const allowedKeys = new Set(["query", "category", "cost", "availability", "periodStart", "periodEnd", "authorAge", "sort", "cursor", "limit"]);
const categories = ["지금", "전시", "축제", "식사", "운동", "여행", "클래스", "산책", "스터디", "공연", "쇼핑", "기타"] as const;
const invalid = (): never => { throw new HttpError("INVALID_REQUEST"); };

/** caller는 인증 결과로만 전달한다. URL의 중복 키·알 수 없는 키·caller 주입은 거절한다. */
export function parsePublicPostSearchQuery(url: URL, caller: SearchCaller): HttpPostSearchInput {
  if (caller !== "anonymous" && caller !== "member") throw new HttpError("INTERNAL_ERROR");
  const params = url.searchParams;
  const keys = [...params.keys()];
  if (keys.some((key) => !allowedKeys.has(key)) || new Set(keys).size !== keys.length) invalid();
  function choice<T extends string>(key: string, values: readonly T[]): T | undefined {
    const value = params.get(key);
    if (value === null) return undefined;
    if (!values.includes(value as T)) return invalid();
    return value as T;
  }
  function text(key: string, min: number, max: number): string | undefined {
    const value = params.get(key);
    if (value === null) return undefined;
    const length = [...value].length;
    if (length < min || length > max) return invalid();
    return value;
  }
  const query = text("query", 0, 300);
  const category = choice("category", categories);
  const cost = choice("cost", ["all", "free", "paid"] as const);
  const availability = choice("availability", ["all", "recruiting"] as const);
  const authorAge = choice("authorAge", ["all", "20s", "30s", "40plus"] as const);
  const sort = choice("sort", ["created_desc", "starts_asc"] as const) ?? "created_desc";
  const cursor = text("cursor", 1, 4096);
  const startsAt = text("periodStart", 20, 35);
  const endsAt = text("periodEnd", 20, 35);
  if ((startsAt === undefined) !== (endsAt === undefined)) invalid();
  const rawLimit = params.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    if (!/^[1-9]\d*$/.test(rawLimit)) invalid();
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) invalid();
  }
  if (caller === "anonymous" && authorAge !== undefined && authorAge !== "all") throw new HttpError("AUTH_REQUIRED");
  return {
    caller, sort,
    ...(query !== undefined ? { query } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(availability !== undefined ? { availability } : {}),
    ...(authorAge !== undefined ? { authorAge } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(startsAt !== undefined && endsAt !== undefined ? { period: { startsAt, endsAt } } : {}),
  };
}

const inputErrors = new Set(["INVALID_FILTER", "UNSUPPORTED_FILTER", "INVALID_CURSOR", "INVALID_SEARCH_TIMESTAMP", "INVALID_SEARCH_PERIOD"]);
/** 코어의 명시적 입력 오류만 공개 오류로 변환한다. 원문·SQL·stack·외부 code는 응답하지 않는다. */
export function mapPublicPostSearchError(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if (error instanceof Error) {
    if (error.message === "AUTH_REQUIRED") return new HttpError("AUTH_REQUIRED");
    if (inputErrors.has(error.message)) return new HttpError("INVALID_REQUEST");
  }
  return new HttpError("INTERNAL_ERROR");
}
