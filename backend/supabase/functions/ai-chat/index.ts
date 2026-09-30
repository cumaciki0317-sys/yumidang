/**
 * 종현담당: AI 탐색 런타임 진입점. 공통 설정·인증·회원 DB 클라이언트와 모델 런타임을 조립한다.
 * import 자체는 환경을 읽거나 서버를 시작하지 않는다. 설정·키·대화 원문을 출력하지 않는다.
 * 모델은 createConfiguredModel이 ready일 때만 사용하며(보관 검토·추가 지출 0원 근거·예산 원장 필요) 그 전에는 unavailable이다.
 */
import { loadRuntimeConfig, type EnvReader } from "../_shared/config/env.ts";
import { requirePrincipal } from "../_shared/auth/principal.ts";
import { createUserClient } from "../_shared/db/user-client.ts";
import { createInternalClient } from "../_shared/db/internal-client.ts";
import type { FetchLike, RpcClient } from "../_shared/db/transport.ts";
import { createConfiguredModel } from "../_shared/ai/providers/runtime.ts";
import { loadAiChatSettings } from "../_shared/ai/Agents/chatbot/settings.ts";
import { createPostDiscovery } from "../_shared/ai/Agents/chatbot/discovery.ts";
import { createEventDiscovery } from "../_shared/ai/Agents/chatbot/event-discovery.ts";
import { createRpcEventRepository } from "../_shared/db/repositories/events.ts";
import { loadMyPreferences } from "../_shared/ai/Agents/chatbot/traits.ts";
import type { PublicDiscoveryPort } from "../_shared/ai/Agents/chatbot/tools.ts";
import { createAiChatHandler, type AiChatEngine } from "./handler.ts";

export interface AiChatRuntimeOptions {
  /** 행사 탐색 포트 교체(테스트용). 생략하면 행사 저장소(list_public_events) 기반 기본 포트를 쓴다. */
  events?: (db: RpcClient) => PublicDiscoveryPort;
  now?: () => Date;
}

export function createAiChatRuntime(read: EnvReader, fetchImpl: FetchLike = fetch, options: AiChatRuntimeOptions = {}) {
  const config = loadRuntimeConfig(read);
  let engine: AiChatEngine;
  let discoveryLimits: ReturnType<typeof loadAiChatSettings>["discovery"] | undefined;
  try {
    const settings = loadAiChatSettings(read);
    discoveryLimits = settings.discovery;
    // 예산 RPC는 service role 전용이다. 내부 설정이 없으면 모델을 만들지 않는다.
    const budgetDb = createInternalClient(config, fetchImpl);
    const model = createConfiguredModel(read, { budgetDb, fetch: fetchImpl });
    engine = model.status === "ready"
      ? { status: "ready", model: model.model, limits: settings.limits, now: options.now ?? (() => new Date()) }
      : { status: "unavailable", code: model.code };
  } catch {
    engine = { status: "unavailable", code: "NOT_CONFIGURED" };
  }
  return createAiChatHandler({
    allowedOrigins: config.allowedOrigins,
    maxBodyBytes: config.maxRequestBytes,
    authenticate: (request) => requirePrincipal(request, config, fetchImpl),
    engine,
    openSession: (principal, model) => {
      // 검색·성향 조회는 요청 회원 JWT로만 실행한다(RLS·auth.uid() 유지). service role을 쓰지 않는다.
      const db = createUserClient(config, principal as Parameters<typeof createUserClient>[1], fetchImpl);
      return {
        discovery: createPostDiscovery({ db, model, limits: discoveryLimits! }),
        // 행사 조회도 회원 JWT client로 실행한다. 민규 user-client 허용 목록에 list_public_events가 없으면 unavailable.
        events: options.events ? options.events(db) : createEventDiscovery({ source: createRpcEventRepository(db), limits: discoveryLimits! }),
        loadPreferences: () => loadMyPreferences(db),
      };
    },
  });
}

let handler: ReturnType<typeof createAiChatRuntime> | undefined;
const entrypoint = {
  fetch(request: Request): Promise<Response> {
    handler ??= createAiChatRuntime((key) => Deno.env.get(key));
    return handler(request);
  },
};
export default entrypoint;
if (import.meta.main) Deno.serve(entrypoint.fetch);
