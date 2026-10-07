/**
 * 종현담당: AI 탐색 HTTP 처리. POST /functions/v1/ai-chat, /ai-chat.
 * 로그인 회원만 사용한다. 인증 주체는 공통 인증(requirePrincipal)만 인정하고 본문의 userId·권한 주장은 받지 않는다.
 * 대화 본문은 요청 메모리에서만 사용하며 로그·오류·응답 헤더에 남기지 않는다(이 모듈은 로그를 쓰지 않는다).
 * 모델이 준비되지 않았거나(보관 검토·지출 근거·설정 누락) 한도 설정이 없으면 검색을 호출하지 않고 200 unavailable로 알린다.
 */
import type { AiChatResult, ChatInput, ChatLimits, TrustedChatContext } from "../_shared/contracts/ai.ts";
import { AiInputError } from "../_shared/contracts/ai.ts";
import type { JsonValue } from "../_shared/contracts/common.ts";
import { createCors } from "../_shared/http/cors.ts";
import { HttpError, toPublicError } from "../_shared/http/errors.ts";
import { createRequestContext, readJson } from "../_shared/http/request.ts";
import { jsonFailure, jsonSuccess } from "../_shared/http/response.ts";
import type { ModelPort } from "../_shared/ai/providers/model-port.ts";
import { runChat } from "../_shared/ai/Agents/chatbot/orchestrator.ts";
import { assertLimits } from "../_shared/ai/Agents/chatbot/context.ts";
import { validateFilters } from "../_shared/ai/Agents/chatbot/intent.ts";
import type { ExplanationCheck } from "../_shared/ai/Agents/chatbot/output-check.ts";
import { assertPrivacy, AiPrivacyError, type ApprovedPrivacyCheck } from "../_shared/ai/providers/privacy.ts";
import type { AiChatRequestGate, RequestOutcome } from "../_shared/ai/providers/member-request.ts";
import type { MemberModelRequest } from "../_shared/ai/providers/model-port.ts";
import { readAiFeedbackInput, type AiFeedbackPort } from "../_shared/ai/Agents/chatbot/feedback.ts";
import { beginAiObservation } from "../_shared/ai/providers/observability.ts";
import type { MetricsRecorder, MetricResultCode } from "../_shared/observability/metrics.ts";
import type { PublicDiscoveryPort } from "../_shared/ai/Agents/chatbot/tools.ts";

export interface AiChatPrincipal { readonly userId: string }
/** 요청 회원 단위의 의존성. 회원 JWT의 RpcClient로 만든다. */
export interface AiChatSession {
  discovery: PublicDiscoveryPort;
  events?: PublicDiscoveryPort;
  /** 본인 성향(get_my_profile_traits). 실패하면 해석 문맥을 임의로 비우지 않고 unavailable로 처리한다. */
  loadPreferences(): Promise<NonNullable<TrustedChatContext["preferences"]>>;
}
export type AiChatEngine =
  | { status: "ready"; model: ModelPort; limits: ChatLimits; now: () => Date; usageIncludesAllAttempts?: boolean; verifyExplanation?: ExplanationCheck; privacy?: ApprovedPrivacyCheck }
  | { status: "unavailable"; code: string };
export interface AiChatHandlerDependencies {
  metrics?: MetricsRecorder;
  allowedOrigins: readonly string[];
  maxBodyBytes: number;
  authenticate(request: Request): Promise<AiChatPrincipal>;
  engine: AiChatEngine;
  /** 운영 런타임은 필수 연결. 단위 테스트는 가상 포트를 주입한다. */
  requestGate?: AiChatRequestGate;
  /** 별도 모델/일일 차감 없이 최소 평가·신고 포트만 호출한다. */
  feedback?: AiFeedbackPort;
  openSession(principal: AiChatPrincipal, model: ModelPort): AiChatSession;
}

export const AI_CHAT_UNAVAILABLE_NOTICE = "AI 탐색을 지금 사용할 수 없습니다. 일반 탐색을 이용해주세요.";
const bodyKeys = ["clientRequestId", "messages", "currentFilters"];

/** 본문은 세 필드만 허용한다. userId·role·권한 주장 등 여분 필드는 400. 세부 내용 검사는 탐색 코어가 한다. */
function readChatInput(body: JsonValue): ChatInput {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => ![...bodyKeys, "outputRetryOf"].includes(key)) ||
    bodyKeys.some((key) => !Object.hasOwn(body, key))) throw new HttpError("INVALID_REQUEST");
  if (typeof body.clientRequestId !== "string" || !body.clientRequestId.trim() || body.clientRequestId.length > 128 ||
    !Array.isArray(body.messages) || (body.outputRetryOf !== undefined && (typeof body.outputRetryOf !== "string" || !/^[0-9a-f-]{36}$/i.test(body.outputRetryOf)))) throw new HttpError("INVALID_REQUEST");
  return body as unknown as ChatInput;
}

export function createAiChatHandler(deps: AiChatHandlerDependencies) {
  if (!Number.isSafeInteger(deps.maxBodyBytes) || deps.maxBodyBytes < 1) throw new TypeError("본문 크기 제한이 필요합니다.");
  // 준비된 엔진의 대화 한도는 시작 시 검사한다. 요청 처리 중 설정 오류를 입력 오류(400)로 바꾸지 않는다.
  if (deps.engine.status === "ready") assertLimits(deps.engine.limits);
  const cors = createCors({ allowedOrigins: deps.allowedOrigins, allowedMethods: ["POST"], allowedHeaders: ["authorization", "content-type", "apikey"] });
  return async (request: Request): Promise<Response> => {
    const context = createRequestContext();
    const preflight = cors.preflight(request, context);
    if (preflight) return preflight;
    const observation = beginAiObservation(["/functions/v1/ai-chat", "/ai-chat"].includes(new URL(request.url).pathname) ? deps.metrics : undefined, "ai_chat");
    let metricResult: MetricResultCode = "UNAVAILABLE";
    let originAllowed = false;
    let scope: MemberModelRequest | undefined;
    let outcome: RequestOutcome = "finished";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
    try {
      cors.responseHeaders(request);
      originAllowed = true;
      const url = new URL(request.url);
      const feedbackPath = ["/functions/v1/ai-chat/feedback", "/ai-chat/feedback"].includes(url.pathname);
      if (!feedbackPath && !["/functions/v1/ai-chat", "/ai-chat"].includes(url.pathname)) throw new HttpError("RESOURCE_NOT_FOUND");
      if (request.method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
      if (url.search) throw new HttpError("INVALID_REQUEST");
      const principal = await deps.authenticate(request);
      if (feedbackPath) {
        const input = readAiFeedbackInput(await readJson(request, { maxBytes: deps.maxBodyBytes }));
        const result = deps.feedback ? await deps.feedback.submit(principal.userId, input) :
          { status: "not_enabled", reason: input.action === "report" ? "AI_REPORT_EVIDENCE_HANDLING_NOT_CONNECTED" : "AI_FEEDBACK_STORAGE_NOT_CONNECTED" };
        return cors.apply(jsonSuccess(result as unknown as JsonValue, context), request);
      }
      const input = readChatInput(await readJson(request, { maxBytes: deps.maxBodyBytes }));
      let result: AiChatResult;
      if (deps.engine.status !== "ready") {
        // 모델 미준비: 검색·성향 조회를 호출하지 않는다. 받은 조건은 형식 검사 후 보존한다.
        result = { requestId: context.requestId, status: "unavailable", interpretedFilters: validateFilters(input.currentFilters),
          cards: [], explanations: [], notice: AI_CHAT_UNAVAILABLE_NOTICE };
      } else {
        const engine = deps.engine;
        // 전체 대화·조건을 검사한다. 오탐 문의에 원문을 자동 첨부하거나 최소 구간을 대신 선택하지 않는다.
        if (engine.privacy) {
          try {
            controller.signal.throwIfAborted();
            await assertPrivacy(input, engine.privacy, "input");
            controller.signal.throwIfAborted();
          }
          catch (error) {
            if (!(error instanceof AiPrivacyError)) throw error;
            result = { requestId: context.requestId, status: "unavailable", interpretedFilters: validateFilters(input.currentFilters),
              cards: [], explanations: [], notice: "개인정보가 포함되어 전송하지 않았어요. 내용을 수정하거나 선택한 구간으로 문의해주세요.",
              recovery: { reason: "input_privacy", retryAllowed: false } };
            metricResult = "FORBIDDEN";
            return cors.apply(jsonSuccess(result as unknown as JsonValue, context), request);
          }
        }
        controller.signal.throwIfAborted();
        if (deps.requestGate) {
          let acquired;
          try { acquired = await deps.requestGate.acquire({ userId: principal.userId, requestId: context.requestId,
            clientRequestId: input.clientRequestId, ...(input.outputRetryOf ? { outputRetryOf: input.outputRetryOf } : {}) }); }
          catch { acquired = undefined; }
          if (!acquired || acquired.status !== "acquired") {
            const reason = acquired?.status === "consent_revoked" ? "consent" :
              acquired?.status === "concurrent" ? "concurrent" : acquired?.status === "daily_limit" ? "daily_limit" : "temporary";
            const notice = reason === "consent" ? "AI 동의 철회로 새 전송이 중단됐어요. 일반 탐색을 이용해주세요." :
              reason === "concurrent" ? "앞선 AI 요청이 처리 중이에요. 응답 후 다시 요청해주세요." :
              reason === "daily_limit" ? "오늘의 AI 이용 한도에 도달했어요. 한국시간 자정 이후 다시 이용해주세요." : AI_CHAT_UNAVAILABLE_NOTICE;
            result = { requestId: context.requestId, status: "unavailable", interpretedFilters: validateFilters(input.currentFilters),
              cards: [], explanations: [], notice, recovery: { reason, retryAllowed: false } };
            metricResult = reason === "daily_limit" ? "QUOTA_EXHAUSTED" : reason === "consent" ? "FORBIDDEN" : "UNAVAILABLE";
            return cors.apply(jsonSuccess(result as unknown as JsonValue, context), request);
          }
          scope = acquired.scope;
          const remaining = Date.parse(acquired.expiresAt) - Date.now();
          if (remaining <= 0 || remaining > 2_147_483_647) throw new Error("INVALID_AI_REQUEST_LEASE");
          timer = setTimeout(cancel, remaining);
        }
        const model: ModelPort = { async generate(request) {
          controller.signal.throwIfAborted(); request.signal?.throwIfAborted();
          if (engine.privacy) await assertPrivacy(request.input, engine.privacy, "input");
          controller.signal.throwIfAborted(); request.signal?.throwIfAborted();
          let response;
          try { response = await engine.model.generate({ ...request, ...(scope ? { memberRequest: scope } : {}) }); }
          catch (error) { observation.modelUnknown(); throw error; }
          if (engine.usageIncludesAllAttempts === false) observation.modelUnknown();
          observation.response(response);
          if (engine.privacy) await assertPrivacy(response.value, engine.privacy, "output");
          return response;
        } };
        const session = deps.openSession(principal, model);
        let preferences: NonNullable<TrustedChatContext["preferences"]> | undefined;
        try { preferences = await session.loadPreferences(); }
        catch (error) {
          // 로그인 만료는 401로 알리고, 그 밖의 조회 실패는 성향 없이 진행하지 않는다.
          if (toPublicError(error).status === 401) throw error;
          preferences = undefined;
        }
        if (!preferences) {
          result = { requestId: context.requestId, status: "unavailable", interpretedFilters: validateFilters(input.currentFilters),
            cards: [], explanations: [], notice: AI_CHAT_UNAVAILABLE_NOTICE };
        } else {
          result = await runChat(input, { userId: principal.userId, preferences },
            { model, discovery: session.discovery, ...(session.events ? { events: session.events } : {}),
              limits: engine.limits, now: engine.now, ...(engine.verifyExplanation ? { verifyExplanation: engine.verifyExplanation } : {}) },
            context.requestId, controller.signal);
        }
      }
      if (result.recovery?.reason === "output_privacy") {
        outcome = "output_privacy";
        result.recovery.retryAllowed = input.outputRetryOf === undefined;
      }
      if (deps.engine.status === "ready" && deps.engine.privacy) {
        try { await assertPrivacy(result, deps.engine.privacy, "output"); }
        catch (error) {
          if (!(error instanceof AiPrivacyError)) throw error;
          outcome = "output_privacy";
          result = { requestId: context.requestId, status: "unavailable", interpretedFilters: validateFilters(input.currentFilters), cards: [], explanations: [],
            notice: "개인정보가 포함된 답변을 숨겼어요. 다시 요청하거나 일반 탐색을 이용해주세요.",
            recovery: { reason: "output_privacy", retryAllowed: input.outputRetryOf === undefined } };
        }
      }
      // 재시도 상태 기록·점유 해제 성공을 확인하고 응답한다. DB 실패를 완료로 숨기지 않는다.
      if (scope && deps.requestGate) { await deps.requestGate.finish(scope, outcome); scope = undefined; }
      metricResult = result.status === "results" ? "SUCCESS" : result.status === "no_results" ? "EMPTY" :
        result.status === "needs_clarification" ? "NEEDS_CLARIFICATION" : result.recovery?.reason === "output_privacy" ? "FORBIDDEN" : "UNAVAILABLE";
      return cors.apply(jsonSuccess(result as unknown as JsonValue, context), request);
    } catch (error) {
      // 입력 오류 코드·메시지 원문을 응답에 넣지 않는다.
      const response = jsonFailure(error instanceof AiInputError ? new HttpError("INVALID_REQUEST") : error, context);
      metricResult = response.status === 400 || response.status === 413 ? "INVALID_INPUT" : response.status === 401 || response.status === 403 ? "FORBIDDEN" : "UNAVAILABLE";
      return originAllowed ? cors.apply(response, request) : response;
    } finally {
      observation.finish(controller.signal.aborted ? "CANCELLED" : metricResult);
      if (timer !== undefined) clearTimeout(timer);
      request.signal.removeEventListener("abort", cancel);
      if (scope && deps.requestGate) {
        // 전송 실패 경로도 점유를 해제한다. 해제 실패 시 DB 만료가 복구하며 새 요청은 동시에 실행되지 않는다.
        try { await deps.requestGate.finish(scope, outcome); } catch { /* 원문 오류를 로그에 남기지 않는다. */ }
      }
    }
  };
}
