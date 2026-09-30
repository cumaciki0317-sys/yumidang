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
  | { status: "ready"; model: ModelPort; limits: ChatLimits; now: () => Date; verifyExplanation?: ExplanationCheck }
  | { status: "unavailable"; code: string };
export interface AiChatHandlerDependencies {
  allowedOrigins: readonly string[];
  maxBodyBytes: number;
  authenticate(request: Request): Promise<AiChatPrincipal>;
  engine: AiChatEngine;
  openSession(principal: AiChatPrincipal, model: ModelPort): AiChatSession;
}

export const AI_CHAT_UNAVAILABLE_NOTICE = "AI 탐색을 지금 사용할 수 없습니다. 일반 탐색을 이용해주세요.";
const bodyKeys = ["clientRequestId", "messages", "currentFilters"];

/** 본문은 세 필드만 허용한다. userId·role·권한 주장 등 여분 필드는 400. 세부 내용 검사는 탐색 코어가 한다. */
function readChatInput(body: JsonValue): ChatInput {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== bodyKeys.length ||
    bodyKeys.some((key) => !Object.hasOwn(body, key))) throw new HttpError("INVALID_REQUEST");
  if (typeof body.clientRequestId !== "string" || !body.clientRequestId.trim() || body.clientRequestId.length > 128 ||
    !Array.isArray(body.messages)) throw new HttpError("INVALID_REQUEST");
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
    let originAllowed = false;
    try {
      cors.responseHeaders(request);
      originAllowed = true;
      const url = new URL(request.url);
      if (!["/functions/v1/ai-chat", "/ai-chat"].includes(url.pathname)) throw new HttpError("RESOURCE_NOT_FOUND");
      if (request.method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
      if (url.search) throw new HttpError("INVALID_REQUEST");
      const principal = await deps.authenticate(request);
      const input = readChatInput(await readJson(request, { maxBytes: deps.maxBodyBytes }));
      let result: AiChatResult;
      if (deps.engine.status !== "ready") {
        // 모델 미준비: 검색·성향 조회를 호출하지 않는다. 받은 조건은 형식 검사 후 보존한다.
        result = { requestId: context.requestId, status: "unavailable", interpretedFilters: validateFilters(input.currentFilters),
          cards: [], explanations: [], notice: AI_CHAT_UNAVAILABLE_NOTICE };
      } else {
        const engine = deps.engine;
        const session = deps.openSession(principal, engine.model);
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
            { model: engine.model, discovery: session.discovery, ...(session.events ? { events: session.events } : {}),
              limits: engine.limits, now: engine.now, ...(engine.verifyExplanation ? { verifyExplanation: engine.verifyExplanation } : {}) },
            context.requestId, request.signal);
        }
      }
      return cors.apply(jsonSuccess(result as unknown as JsonValue, context), request);
    } catch (error) {
      // 입력 오류 코드·메시지 원문을 응답에 넣지 않는다.
      const response = jsonFailure(error instanceof AiInputError ? new HttpError("INVALID_REQUEST") : error, context);
      return originAllowed ? cors.apply(response, request) : response;
    }
  };
}
