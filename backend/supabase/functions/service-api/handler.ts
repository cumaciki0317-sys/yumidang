/** 민규담당. Request → 호출자 인증 → 엄격한 입력 → 서비스 → RPC 연결. 원문 로그 없음. */
import type { JsonValue } from "../_shared/contracts/common.ts";
import type { RpcClient } from "../_shared/db/transport.ts";
import { createCors } from "../_shared/http/cors.ts";
import { HttpError } from "../_shared/http/errors.ts";
import { createRequestContext, readJson } from "../_shared/http/request.ts";
import { jsonFailure, jsonSuccess } from "../_shared/http/response.ts";
import { mapPublicPostSearchError, parsePublicPostSearchQuery, type PublicPostSearchExecutor } from "./search-http.ts";
import { resolveRouteForMethod, type MaintenanceConfig } from "./routes.ts";
import { assertEventFilterQuery, mapEventHttpError, parseEventQuery, type PublicEventExecutor, type EventFilterExecutor } from "./events-http.ts";

export interface ServiceApiDependencies {
  allowedOrigins: readonly string[];
  maxBodyBytes: number;
  authenticateUser(request: Request): Promise<RpcClient>;
  authenticateInternal(request: Request): Promise<RpcClient>;
  maintenance?: MaintenanceConfig;
  /** 명시적으로 준비한 내부 실행기만 연결한다. runtime 기본 설정은 아직 연결하지 않는다. */
  memberCleanup?: {
    execute(db: RpcClient, workerRunToken: string, signal: AbortSignal): Promise<{
      status: "ran"; claimed: number; succeeded: number;
    }>;
  };
  /** 정책 갱신·검증을 마친 검색 코어만 명시적으로 연결한다. 생략 시 기존 경로 동작을 유지한다. */
  publicSearch?: {
    authenticate(request: Request): Promise<{ db: RpcClient; caller: "anonymous" | "member" }>;
    execute: PublicPostSearchExecutor;
  };
  publicEvents?: {
    authenticate(request: Request): Promise<{ db: RpcClient; caller: "anonymous" | "member" }>;
    execute: PublicEventExecutor;
    filters: EventFilterExecutor;
  };
  /** 명시적으로 연결한 공고 상세 GET만 헤더 없는 익명 요청을 허용한다. 생략 시 기존 회원 인증을 쓴다. */
  publicPostDetails?: {
    authenticate(request: Request): Promise<{ db: RpcClient; caller: "anonymous" | "member" }>;
  };
}
export function createServiceApi(dependencies: ServiceApiDependencies) {
  if (!Number.isSafeInteger(dependencies.maxBodyBytes) || dependencies.maxBodyBytes < 1) throw new TypeError("본문 크기 제한이 필요합니다.");
  const cors = createCors({ allowedOrigins: dependencies.allowedOrigins, allowedMethods: ["GET", "POST"], allowedHeaders: ["authorization", "content-type", "apikey"] });
  return async (request: Request): Promise<Response> => {
    const context = createRequestContext();
    const preflight = cors.preflight(request, context);
    if (preflight) return preflight;
    let originAllowed = false;
    try {
      cors.responseHeaders(request);
      originAllowed = true;
      const url = new URL(request.url);
      if (dependencies.publicEvents && ["/service-api/events", "/functions/v1/service-api/events", "/service-api/events/filters", "/functions/v1/service-api/events/filters"].includes(url.pathname)) {
        try {
          if (request.method !== "GET") throw new HttpError("METHOD_NOT_ALLOWED");
          if (request.body !== null) throw new HttpError("INVALID_REQUEST");
          const { db } = await dependencies.publicEvents.authenticate(request);
          let data;
          if (url.pathname.endsWith("/filters")) {
            assertEventFilterQuery(url);
            data = await dependencies.publicEvents.filters(db);
          } else data = await dependencies.publicEvents.execute(db, parseEventQuery(url));
          return cors.apply(jsonSuccess(data as unknown as JsonValue, context), request);
        } catch (error) { throw mapEventHttpError(error); }
      }
      if (request.method === "GET" && dependencies.publicSearch &&
        ["/service-api/posts", "/functions/v1/service-api/posts"].includes(url.pathname)) {
        try {
          if (request.body !== null) throw new HttpError("INVALID_REQUEST");
          const { db, caller } = await dependencies.publicSearch.authenticate(request);
          const input = parsePublicPostSearchQuery(url, caller);
          const data = await dependencies.publicSearch.execute(db, input);
          // 주입된 검색 코어의 공개 투영 결과만 공통 envelope에 담는다.
          return cors.apply(jsonSuccess(data as unknown as JsonValue, context), request);
        } catch (error) {
          throw mapPublicPostSearchError(error);
        }
      }
      if (dependencies.memberCleanup && ["/service-api/internal/member-cleanup", "/functions/v1/service-api/internal/member-cleanup"].includes(url.pathname)) {
        if (request.method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
        // 인증 실패를 사용자 JWT로 재시도하지 않는다. 외부 실행 전에 모든 입력을 검사한다.
        const db = await dependencies.authenticateInternal(request);
        const token = request.headers.get("x-worker-run-token");
        if (url.search || !token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
          throw new HttpError("INVALID_REQUEST");
        }
        const body = await readJson(request, { maxBytes: dependencies.maxBodyBytes });
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) throw new HttpError("INVALID_REQUEST");
        if (request.signal.aborted) throw new HttpError("STATE_CONFLICT");
        // callback은 실제 DB budget과 기존 cleanup 5포트를 사용해야 한다. 요청에서 마감/한도/대상을 받지 않는다.
        const data = await dependencies.memberCleanup.execute(db, token.toLowerCase(), request.signal);
        if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== 3 ||
          data.status !== "ran" || !Number.isSafeInteger(data.claimed) || data.claimed < 0 || data.claimed > 20 ||
          !Number.isSafeInteger(data.succeeded) || data.succeeded < 0 || data.succeeded > data.claimed) throw new HttpError("EXTERNAL_UNAVAILABLE");
        if (request.signal.aborted) throw new HttpError("STATE_CONFLICT");
        // 영수증/경로/토큰/Provider 응답은 envelope에 포함하지 않는다.
        return cors.apply(jsonSuccess({ status: data.status, claimed: data.claimed, succeeded: data.succeeded }, context), request);
      }
      const route = resolveRouteForMethod(url, request.method);
      if (route.publicPostDetail && dependencies.publicPostDetails) {
        if (request.body !== null) throw new HttpError("INVALID_REQUEST");
        // 잘못된 토큰·Auth 장애는 그대로 오류다. 회원 인증 실패를 익명으로 재시도하지 않는다.
        const { db } = await dependencies.publicPostDetails.authenticate(request);
        const data = await route.execute({ db, url, body: null, maintenance: dependencies.maintenance });
        return cors.apply(jsonSuccess(data, context), request);
      }
      // 내부 secret 경로와 사용자 JWT 경로 사이에 인증 fallback을 하지 않는다.
      const db = await (route.internal ? dependencies.authenticateInternal(request) : dependencies.authenticateUser(request));
      if (request.method === "GET" && request.body !== null) throw new HttpError("INVALID_REQUEST");
      const body = request.method === "POST" ? await readJson(request, { maxBytes: dependencies.maxBodyBytes }) : null;
      const data = await route.execute({ db, url, body, maintenance: dependencies.maintenance });
      return cors.apply(jsonSuccess(data, context), request);
    } catch (error) {
      const response = jsonFailure(error, context);
      return originAllowed ? cors.apply(response, request) : response;
    }
  };
}
