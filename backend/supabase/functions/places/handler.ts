/**
 * 담당: 종현담당. 공고 작성용 장소 검색 HTTP 처리.
 * GET /functions/v1/places(또는 /places)?query=...&page=N. 로그인 회원만 사용한다.
 * 응답은 PlaceLookupResult(source/sourceId/placeName/address/roadAddress, nextPage)만 반환한다.
 * 좌표·반경·거리순·전화번호 입력/출력이 없다. 검색어·키·공급사 원문을 로그·오류에 넣지 않는다.
 */
import type { JsonValue } from "../_shared/contracts/common.ts";
import { createCors } from "../_shared/http/cors.ts";
import { HttpError } from "../_shared/http/errors.ts";
import { createRequestContext } from "../_shared/http/request.ts";
import { jsonFailure, jsonSuccess } from "../_shared/http/response.ts";
import { PlaceLookupError } from "../_shared/integrations/places/port.ts";
import type { PlaceLookupContext, PlaceLookupInput, PlaceLookupResult } from "../_shared/integrations/places/port.ts";

export interface PlacesDependencies {
  allowedOrigins: readonly string[];
  /** 공통 Supabase Auth 검증. 실패는 HttpError(AUTH_REQUIRED 등)로 던진다. */
  authenticate(request: Request): Promise<{ userId: string }>;
  lookup(input: PlaceLookupInput, context: PlaceLookupContext): Promise<PlaceLookupResult>;
}

/** Kakao 키워드 검색의 page 규격 1..45. */
const MAX_PAGE = 45;
/** 기존 공고 검색 HTTP 경계(search-http.ts)의 검색어 길이 기술 한도를 따른다. 운영 정책 값이 아니다. */
const MAX_QUERY_LENGTH = 300;

function parseInput(url: URL): PlaceLookupInput {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.includes("query") || !keys.includes("page")) {
    throw new HttpError("INVALID_REQUEST");
  }
  const query = url.searchParams.get("query")!;
  const rawPage = url.searchParams.get("page")!;
  if (!query.trim() || [...query].length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/u.test(query)) {
    throw new HttpError("INVALID_REQUEST");
  }
  if (!/^[1-9][0-9]?$/.test(rawPage) || Number(rawPage) > MAX_PAGE) throw new HttpError("INVALID_REQUEST");
  return { query, page: Number(rawPage) };
}

/** 장소 어댑터 오류를 공개 오류로 좁힌다. 공급사 인증 거절·설정 누락도 사용자에게는 일시 장애다. */
export function mapPlaceError(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if (error instanceof PlaceLookupError) {
    if (error.code === "INVALID_PLACE_INPUT") return new HttpError("INVALID_REQUEST");
    if (error.code === "UNAUTHENTICATED") return new HttpError("AUTH_REQUIRED");
    return new HttpError("EXTERNAL_UNAVAILABLE");
  }
  return new HttpError("INTERNAL_ERROR");
}

function project(result: PlaceLookupResult): JsonValue {
  if (!result || (result.status !== "results" && result.status !== "no_results") || !Array.isArray(result.places) ||
      (result.nextPage !== null && (!Number.isInteger(result.nextPage) || result.nextPage < 2 || result.nextPage > MAX_PAGE))) {
    throw new HttpError("EXTERNAL_UNAVAILABLE");
  }
  return {
    status: result.status,
    places: result.places.map((place) => ({
      source: place.source, sourceId: place.sourceId, placeName: place.placeName,
      address: place.address, roadAddress: place.roadAddress,
    })),
    nextPage: result.nextPage,
  };
}

export function createPlacesHandler(deps: PlacesDependencies) {
  const cors = createCors({
    allowedOrigins: deps.allowedOrigins, allowedMethods: ["GET"], allowedHeaders: ["authorization", "apikey"],
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
      if (!["/functions/v1/places", "/places"].includes(url.pathname)) throw new HttpError("RESOURCE_NOT_FOUND");
      if (request.method !== "GET") throw new HttpError("METHOD_NOT_ALLOWED");
      const principal = await deps.authenticate(request);
      const input = parseInput(url);
      const result = await deps.lookup(input, {
        principal: { kind: "member", userId: principal.userId }, signal: request.signal,
      });
      return cors.apply(jsonSuccess(project(result), context), request);
    } catch (error) {
      const response = jsonFailure(mapPlaceError(error), context);
      return originAllowed ? cors.apply(response, request) : response;
    }
  };
}
