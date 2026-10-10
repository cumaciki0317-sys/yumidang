/** 민규담당. Request → 호출자 인증 → 엄격한 입력 → 서비스 → RPC 연결. 원문 로그 없음. */
import type { JsonValue, RequestContext } from "../_shared/contracts/common.ts";
import type { RetirementReceiptClient } from "../_shared/db/user-client.ts";
import type { RpcClient } from "../_shared/db/transport.ts";
import { createWorkerInvocationRuntime } from "../_shared/db/worker-runtime-client.ts";
import { createCors } from "../_shared/http/cors.ts";
import { HttpError } from "../_shared/http/errors.ts";
import { createRequestContext, readJson } from "../_shared/http/request.ts";
import { reportOperatorRoute, type ReportOperatorRoute } from "./report-operator-http.ts";
import { profileImageRoutePath } from "./profile-image-http.ts";
import { jsonFailure, jsonSuccess } from "../_shared/http/response.ts";
import { mapPublicPostSearchError, parsePublicPostSearchQuery, type PublicPostSearchExecutor } from "./search-http.ts";
import { resolveRouteForMethod, type MaintenanceConfig } from "./routes.ts";
import { parseRetirementRequest, retireMyAccount, getOwnRetirementReceipt } from "../_shared/services/member-lifecycle-service.ts";
import { assertEventFilterQuery, mapEventHttpError, parseEventQuery, type PublicEventExecutor, type EventFilterExecutor } from "./events-http.ts";

/** DB의 정확한 영속 배정 확인·CAS 뒤에만 실행기로 전달하는 상한이다. */
export interface MemberCleanupInvocationAllocation {
  readonly requestId: string;
  readonly limit: number;
  readonly remainingMs: number;
}

export interface ServiceApiDependencies {
  allowedOrigins: readonly string[];
  maxBodyBytes: number;
  reportOperator?: { execute(request: Request, route: ReportOperatorRoute, context: RequestContext): Promise<Response> };
  profileImages?: { execute(request: Request, path: string): Promise<Response> };
  contentInspection?: { execute(request: Request, path: "inspect" | "confirm", context: RequestContext): Promise<Response> };
  /** 원 ACK를 가진 SQL115 복구만 허용하는 별도 서버 승인 포트. 기본 미설치. */
  memberCleanupReconcile?: { execute(request: Request, context: RequestContext): Promise<Response>; finalize?(request: Request, context: RequestContext): Promise<Response> };
  authenticateUser(request: Request): Promise<RpcClient>;
  /** 실제 Auth 세션 거절만 분리한다. receipt 포트는 일반 사용자 client가 아니다. */
  authenticateRetirement?(request:Request):Promise<{kind:"active";db:RpcClient}|{kind:"revoked";receipt:RetirementReceiptClient}>;
  authenticateInternal(request: Request): Promise<RpcClient>;
  maintenance?: MaintenanceConfig;
  /** 검증된 삭제 pipeline을 준비한 서버 조립에서만 켠다. HTTP 입력으로 활성화하지 않는다. */
  memberRetirement?: true;
  /** 명시적으로 준비한 내부 실행기만 연결한다. runtime 기본 설정은 아직 연결하지 않는다. */
  memberCleanup?: {
    execute(db: RpcClient, workerRunToken: string, signal: AbortSignal, allocation?: MemberCleanupInvocationAllocation): Promise<{
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
  const cors = createCors({ allowedOrigins: dependencies.allowedOrigins, allowedMethods: ["GET", "POST"], allowedHeaders: ["authorization", "content-type", "apikey", "x-content-operation-id", "x-content-inspection-ticket"] });
  return async (request: Request): Promise<Response> => {
    const context = createRequestContext();
    const preflight = cors.preflight(request, context);
    if (preflight) return preflight;
    let originAllowed = false;
    try {
      cors.responseHeaders(request);
      originAllowed = true;
      const url = new URL(request.url);
      if (["/service-api/internal/member-cleanup/reconcile/finalize", "/functions/v1/service-api/internal/member-cleanup/reconcile/finalize"].includes(url.pathname)) {
        if (!dependencies.memberCleanupReconcile?.finalize) throw new HttpError("RESOURCE_NOT_FOUND");
        return cors.apply(await dependencies.memberCleanupReconcile.finalize(request, context), request);
      }
      if (["/service-api/internal/member-cleanup/reconcile", "/functions/v1/service-api/internal/member-cleanup/reconcile"].includes(url.pathname)) {
        if (!dependencies.memberCleanupReconcile) throw new HttpError("RESOURCE_NOT_FOUND");
        return cors.apply(await dependencies.memberCleanupReconcile.execute(request, context), request);
      }
      const contentPath = /^(?:\/functions\/v1)?\/service-api\/content-inspections(\/confirm)?$/.exec(url.pathname);
      if (contentPath && dependencies.contentInspection) {
        return cors.apply(await dependencies.contentInspection.execute(request, contentPath[1] ? "confirm" : "inspect", context), request);
      }
      const operatorRoute = reportOperatorRoute(url);
      if (operatorRoute !== null && dependencies.reportOperator) {
        const response = await dependencies.reportOperator.execute(request, operatorRoute, context);
        response.headers.set("X-Request-Id", context.requestId);
        return cors.apply(response, request);
      }
      const imagePath = profileImageRoutePath(url);
      if (imagePath !== null && dependencies.profileImages) {
        const response = await dependencies.profileImages.execute(request, imagePath);
        response.headers.set("X-Request-Id", context.requestId);
        return cors.apply(response, request);
      }
      const eventDetail = /^(?:\/functions\/v1)?\/service-api\/events\/([^/]+)$/.exec(url.pathname);
      if (dependencies.publicEvents && eventDetail && eventDetail[1] !== "filters") {
        if (request.method !== "GET") throw new HttpError("METHOD_NOT_ALLOWED");
        if (url.search || request.body !== null) throw new HttpError("INVALID_REQUEST");
        const id = eventDetail[1];
        if (id !== "rankings" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new HttpError("INVALID_REQUEST");
        const { db } = await dependencies.publicEvents.authenticate(request);
        const data = id === "rankings" ? await db.rpc("get_public_event_ranking_state", {}) : await db.rpc("get_public_event", { p_event_id: id });
        return cors.apply(jsonSuccess(data, context), request);
      }
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
      if (["/service-api/me/retirement", "/functions/v1/service-api/me/retirement"].includes(url.pathname)) {
        // 기본 runtime에서는 경로를 열지 않는다. DB의 삭제 승인 guard도 별도로 유지한다.
        if (dependencies.memberRetirement !== true) throw new HttpError("RESOURCE_NOT_FOUND");
        if (request.method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
        const caller=dependencies.authenticateRetirement?await dependencies.authenticateRetirement(request):
          {kind:"active" as const,db:await dependencies.authenticateUser(request)};
        if (url.search || request.signal.aborted) throw new HttpError("INVALID_REQUEST");
        const body = await readJson(request, { maxBytes: dependencies.maxBodyBytes });
        const id = parseRetirementRequest(body);
        const data = caller.kind==="active"?await retireMyAccount(caller.db,id):await getOwnRetirementReceipt(caller.receipt,id);
        // processing은 접근 회수와 후속 작업 접수이며 외부 자료 삭제 완료가 아니다.
        return cors.apply(jsonSuccess({ withdrawalId: data.withdrawalId, status: data.status,
          memberAccessRevoked: data.memberAccessRevoked }, context), request);
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
        const sharedHeaders = ["x-worker-request-id", "x-worker-max-jobs", "x-worker-time-budget-ms"] as const;
        const shared = sharedHeaders.some(name => request.headers.has(name));
        let allocation: MemberCleanupInvocationAllocation | undefined;
        let executionSignal = request.signal;
        let executionDeadline: number | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (shared) {
            if (!sharedHeaders.every(name => request.headers.has(name))) throw new HttpError("INVALID_REQUEST");
            const requestId = request.headers.get("x-worker-request-id")!;
            const max = request.headers.get("x-worker-max-jobs")!, time = request.headers.get("x-worker-time-budget-ms")!;
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ||
                !/^[1-9][0-9]{0,5}$/.test(max) || Number(max) > 10 ||
                !/^[1-9][0-9]{0,5}$/.test(time) || Number(time) > 180000) throw new HttpError("INVALID_REQUEST");
            const limit = Number(max), remainingMs = Number(time), started = performance.now();
            executionDeadline = started + remainingMs;
            const abort = new AbortController();
            executionSignal = AbortSignal.any([request.signal, abort.signal]);
            timer = setTimeout(() => abort.abort(), remainingMs);
            const runtime = createWorkerInvocationRuntime(db);
            const id = requestId.toLowerCase(), globalToken = token.toLowerCase();
            const state = await runtime.getQueueInvocation(id);
            if (executionSignal.aborted || performance.now() >= executionDeadline || state.state !== "prepared" || state.kind !== "member_cleanup" ||
                state.globalToken !== globalToken || state.limit !== limit || state.remainingMs !== remainingMs) throw new HttpError("STATE_CONFLICT");
            if (!await runtime.claimQueueInvocationDispatch({ requestId: id, globalToken, kind: "member_cleanup", limit, remainingMs }) ||
                executionSignal.aborted) throw new HttpError("STATE_CONFLICT");
            const elapsed = Math.ceil(performance.now() - started);
            if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed >= remainingMs) throw new HttpError("STATE_CONFLICT");
            allocation = Object.freeze({ requestId: id, limit, remainingMs: remainingMs - elapsed });
          }
          // 원래 token-only 경로는 유지한다. 공유 헤더는 DB 확인 없이는 실행 상한을 승인하지 않는다.
          const data = await dependencies.memberCleanup.execute(db, token.toLowerCase(), executionSignal, allocation);
          if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== 3 ||
            data.status !== "ran" || !Number.isSafeInteger(data.claimed) || data.claimed < 0 || data.claimed > (allocation?.limit ?? 20) ||
            !Number.isSafeInteger(data.succeeded) || data.succeeded < 0 || data.succeeded > data.claimed) throw new HttpError("EXTERNAL_UNAVAILABLE");
          if (executionSignal.aborted || (executionDeadline !== undefined && performance.now() >= executionDeadline)) throw new HttpError("STATE_CONFLICT");
          // 영수증/경로/토큰/Provider 응답은 envelope에 포함하지 않는다.
          return cors.apply(jsonSuccess({ status: data.status, claimed: data.claimed, succeeded: data.succeeded }, context), request);
        } finally { clearTimeout(timer); }
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
      let worker: { token: string; requestId: string } | undefined;
      if (url.pathname.endsWith("/internal/ai-feedback-maintenance")) {
        const token = request.headers.get("x-worker-run-token"), requestId = request.headers.get("x-worker-request-id");
        const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
        if (url.search || !token || !requestId || !uuid.test(token) || !uuid.test(requestId)) throw new HttpError("INVALID_REQUEST");
        worker = { token: token.toLowerCase(), requestId: requestId.toLowerCase() };
        if (request.headers.has("x-worker-time-budget-ms")) {
          const value = request.headers.get("x-worker-time-budget-ms")!;
          if (!/^[1-9][0-9]{0,5}$/.test(value) || Number(value) > 180_000 ||
              !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
              typeof body.limit !== "number" || !Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 20) throw new HttpError("INVALID_REQUEST");
          if (request.signal.aborted) throw new HttpError("STATE_CONFLICT");
          const runtime = createWorkerInvocationRuntime(db);
          const state = await runtime.getQueueInvocation(worker.requestId);
          if (state.state !== "prepared" || state.kind !== "helpful_maintenance" || state.globalToken !== worker.token ||
              state.limit !== body.limit || state.remainingMs !== Number(value)) throw new HttpError("STATE_CONFLICT");
          if (request.signal.aborted || !await runtime.claimQueueInvocationDispatch({ requestId: worker.requestId,
            globalToken: worker.token, kind: "helpful_maintenance", limit: body.limit, remainingMs: Number(value) })) throw new HttpError("STATE_CONFLICT");
          if (request.signal.aborted) throw new HttpError("STATE_CONFLICT");
        }
      }
      const data = await route.execute({ db, url, body, maintenance: dependencies.maintenance, worker });
      return cors.apply(jsonSuccess(data, context), request);
    } catch (error) {
      const response = jsonFailure(error, context);
      return originAllowed ? cors.apply(response, request) : response;
    }
  };
}
