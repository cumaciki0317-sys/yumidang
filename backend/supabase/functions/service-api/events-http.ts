/** 민규담당. 행사 HTTP 입력만 변환한다. 정렬·기간·커서·공개 투영은 종현 저장소를 재사용한다. */
import type { EventPage, EventPageQuery, EventFilterValues } from "../_shared/db/repositories/events.ts";
import type { RpcClient } from "../_shared/db/transport.ts";
import { HttpError } from "../_shared/http/errors.ts";

export interface HttpEventQuery { query: EventPageQuery; cursor?: string; limit: number }
export type PublicEventExecutor = (db: RpcClient, input: HttpEventQuery) => Promise<EventPage>;
export type EventFilterExecutor = (db: RpcClient) => Promise<EventFilterValues>;
const allowed = new Set(["mode", "periodStart", "periodEnd", "ongoingOnly", "includeOngoing", "freeOnly", "performanceGenre", "query", "region", "category", "cursor", "limit"]);
const invalid = (): never => { throw new HttpError("INVALID_REQUEST"); };

export function parseEventQuery(url: URL): HttpEventQuery {
  const params = url.searchParams, keys = [...params.keys()];
  if (keys.some(key => !allowed.has(key)) || keys.length !== new Set(keys).size) invalid();
  const mode = params.get("mode") ?? "new_this_week";
  if (mode !== "overlapping" && mode !== "new_this_week" && mode !== "post_selection") return invalid();
  const limit = params.get("limit");
  // 제품의 행사 조회는10개씩이며, HTTP는 기존 기술 범위1..50 안의 명시 limit을 받는다.
  if (limit === null || !/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit)) || Number(limit) > 50) invalid();
  const boolean = (key: string): boolean | undefined => {
    const value = params.get(key);
    if (value === null) return undefined;
    if (value !== "true" && value !== "false") return invalid();
    return value === "true";
  };
  const ongoingOnly = boolean("ongoingOnly"), includeOngoing = boolean("includeOngoing"), freeOnly = boolean("freeOnly");
  if (includeOngoing && (ongoingOnly || mode !== "new_this_week")) invalid();
  const performanceGenre = params.get("performanceGenre");
  if (performanceGenre !== null && !["concert", "musical", "play"].includes(performanceGenre)) invalid();
  const start = params.get("periodStart"), end = params.get("periodEnd");
  if ((start === null) !== (end === null)) invalid();
  if (start !== null && end !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))) invalid();
  const optional = (key: string, allowEmpty = false): string | undefined => {
    const value = params.get(key);
    if (value === null) return undefined;
    if (!allowEmpty && !value.trim()) invalid();
    return value;
  };
  const keyword = optional("query", true), region = optional("region"), category = optional("category"), cursor = optional("cursor");
  return { query: { mode,
    ...(start !== null && end !== null ? { period: { start, end } } : {}),
    ...(ongoingOnly !== undefined ? { ongoingOnly } : {}),
    ...(includeOngoing !== undefined ? { includeOngoing } : {}), ...(freeOnly !== undefined ? { freeOnly } : {}),
    ...(performanceGenre !== null ? { performanceGenre: performanceGenre as EventPageQuery["performanceGenre"] } : {}),
    ...(keyword !== undefined ? { query: keyword } : {}), ...(region !== undefined ? { region } : {}), ...(category !== undefined ? { category } : {}),
  }, ...(cursor !== undefined ? { cursor } : {}), limit: Number(limit) };
}

export function assertEventFilterQuery(url: URL): void { if ([...url.searchParams.keys()].length) invalid(); }
const inputErrors = new Set(["INVALID_EVENT_QUERY", "UNSUPPORTED_EVENT_FILTER", "INVALID_EVENT_MODE", "INVALID_EVENT_FILTER", "INVALID_QUERY_PERIOD", "INVALID_EVENT_CURSOR", "INVALID_EVENT_LIMIT", "INVALID_EVENT_DATE"]);
export function mapEventHttpError(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if (error instanceof Error && inputErrors.has(error.message)) return new HttpError("INVALID_REQUEST");
  return new HttpError("INTERNAL_ERROR");
}
