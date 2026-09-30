/**
 * 담당: 종현담당. 내부 행사 수집(한 페이지) HTTP 처리.
 * POST /functions/v1/event-sync(또는 /event-sync), 내부 비밀 인증, 본문 정확히 {provider, period:{start,end}, page}.
 * 한 요청 = 제공처 한 페이지 조회 → (provider, sourceId) upsert. 삭제·다음 페이지 자동 진행·재시도 없음.
 * 외부 실패·정규화 실패·DB 실패를 0건 성공으로 바꾸지 않는다. 24시간 주기 호출은 scheduled-jobs(lane S) 책임이다.
 */
import type { JsonValue } from "../_shared/contracts/common.ts";
import type { EventPeriod } from "../_shared/integrations/events/port.ts";
import { EventProviderError } from "../_shared/integrations/events/port.ts";
import { parseCalendarDate } from "../_shared/integrations/events/normalize.ts";
import { createCors } from "../_shared/http/cors.ts";
import { HttpError, toPublicError } from "../_shared/http/errors.ts";
import { createRequestContext, readJson } from "../_shared/http/request.ts";
import { jsonFailure, jsonSuccess } from "../_shared/http/response.ts";

export interface EventSyncInput {
  provider: string;
  period: EventPeriod;
  page: number;
  signal: AbortSignal;
}
export interface EventSyncResult {
  fetchedCount: number;
  savedCount: number;
  hasMore: boolean;
}
export interface EventSyncDependencies {
  allowedOrigins: readonly string[];
  maxBodyBytes: number;
  authenticateInternal(request: Request): Promise<void>;
  /** EVENT_SYNC_PROVIDERS 허용 목록. */
  providers: readonly string[];
  /** EVENT_SYNC_MAX_PERIOD_DAYS(양 끝 날짜 포함 일수). */
  maxPeriodDays: number;
  /** EVENT_SYNC_MAX_PAGE. */
  maxPage: number;
  sync(input: EventSyncInput): Promise<EventSyncResult>;
}

/** 정규화·저장 전 검사에서 나는 공급사 자료 오류. 자료를 저장하지 않고 일시 장애로 알린다. */
const sourceDataErrors = new Set([
  "INVALID_EVENT_DATE", "INVALID_EVENT_INSTANT", "UNKNOWN_EVENT_TIMEZONE", "INVALID_EVENT_PERIOD", "UNSUPPORTED_EVENT_PRECISION",
  "INVALID_EVENT_ID", "UNSUPPORTED_EVENT_SOURCE_STATUS", "INVALID_EVENT_SOURCE_RECORD", "INVALID_EVENT_PUBLIC_TEXT",
  "INVALID_EVENT_ADMISSION", "INVALID_EVENT_SOURCE_URL", "EVENT_PROVIDER_CONTEXT_MISMATCH", "DUPLICATE_EVENT_IDENTITY",
]);

/** 수집 단계 오류를 공개 오류로 좁힌다. 공급사 코드·본문·키는 응답하지 않는다. */
export function mapEventSyncError(error: unknown): unknown {
  if (error instanceof HttpError) {
    // 인증은 수집 전에 끝났다. 수집 중의 권한 오류는 서버 구성 문제(예: 내부 RPC 허용 목록)이며 호출자 탓이 아니다.
    const code = toPublicError(error).error.code;
    return code === "ACCESS_DENIED" || code === "AUTH_REQUIRED" ? new HttpError("INTERNAL_ERROR") : error;
  }
  if (error instanceof EventProviderError) {
    return new HttpError(error.code === "INVALID_EVENT_REQUEST" ? "INVALID_REQUEST" : "EXTERNAL_UNAVAILABLE");
  }
  if (error instanceof Error && sourceDataErrors.has(error.message)) return new HttpError("EXTERNAL_UNAVAILABLE");
  return new HttpError("INTERNAL_ERROR");
}

function inclusiveDays(period: EventPeriod): number {
  return (parseCalendarDate(period.end).getTime() - parseCalendarDate(period.start).getTime()) / 86_400_000 + 1;
}

function parseBody(body: JsonValue, deps: EventSyncDependencies): { provider: string; period: EventPeriod; page: number } {
  const invalid = (): never => { throw new HttpError("INVALID_REQUEST"); };
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 3 ||
      !Object.hasOwn(body, "provider") || !Object.hasOwn(body, "period") || !Object.hasOwn(body, "page")) return invalid();
  const { provider, period, page } = body;
  if (typeof provider !== "string" || !deps.providers.includes(provider)) return invalid();
  if (!period || typeof period !== "object" || Array.isArray(period) || Object.keys(period).length !== 2 ||
      typeof period.start !== "string" || typeof period.end !== "string") return invalid();
  const start = period.start, end = period.end;
  let days: number;
  try { days = inclusiveDays({ start, end }); } catch { return invalid(); }
  if (!Number.isInteger(days) || days < 1 || days > deps.maxPeriodDays) return invalid();
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 || page > deps.maxPage) return invalid();
  return { provider, period: { start, end }, page };
}

export function createEventSyncHandler(deps: EventSyncDependencies) {
  if (!Number.isSafeInteger(deps.maxBodyBytes) || deps.maxBodyBytes < 1 ||
      !Number.isSafeInteger(deps.maxPeriodDays) || deps.maxPeriodDays < 1 ||
      !Number.isSafeInteger(deps.maxPage) || deps.maxPage < 1 || !Array.isArray(deps.providers) || !deps.providers.length) {
    throw new TypeError("행사 수집 설정이 필요합니다.");
  }
  const cors = createCors({
    allowedOrigins: deps.allowedOrigins, allowedMethods: ["POST"], allowedHeaders: ["authorization", "content-type", "apikey"],
  });
  return async (request: Request): Promise<Response> => {
    const context = createRequestContext();
    const preflight = cors.preflight(request, context);
    if (preflight) return preflight;
    let originAllowed = false;
    try {
      cors.responseHeaders(request);
      originAllowed = true;
      const url = new URL(request.url);
      if (!["/functions/v1/event-sync", "/event-sync"].includes(url.pathname)) throw new HttpError("RESOURCE_NOT_FOUND");
      if (request.method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
      await deps.authenticateInternal(request);
      if (url.search) throw new HttpError("INVALID_REQUEST");
      const input = parseBody(await readJson(request, { maxBytes: deps.maxBodyBytes }), deps);
      let result: EventSyncResult;
      try {
        result = await deps.sync({ ...input, signal: request.signal });
      } catch (error) {
        throw mapEventSyncError(error);
      }
      if (!result || !Number.isSafeInteger(result.fetchedCount) || result.fetchedCount < 0 ||
          !Number.isSafeInteger(result.savedCount) || result.savedCount < 0 || result.savedCount > result.fetchedCount ||
          typeof result.hasMore !== "boolean") {
        throw new HttpError("INTERNAL_ERROR");
      }
      return cors.apply(jsonSuccess({
        status: "synced", provider: input.provider,
        fetchedCount: result.fetchedCount, savedCount: result.savedCount, hasMore: result.hasMore,
      }, context), request);
    } catch (error) {
      const response = jsonFailure(error, context);
      return originAllowed ? cors.apply(response, request) : response;
    }
  };
}
