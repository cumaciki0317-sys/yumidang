/**
 * 담당: 종현담당. 내부 행사 수집 런타임 진입점. import는 환경을 읽거나 서버를 시작하지 않는다.
 * 필수 환경값(기본값 없음):
 *  - EVENT_SYNC_PROVIDERS: 쉼표로 구분한 허용 제공처. 현재 구현은 kopis만 있다.
 *  - EVENT_SYNC_MAX_PERIOD_DAYS / EVENT_SYNC_MAX_PAGE / EVENT_SYNC_PAGE_ROWS: 허용한 제공처 규격 상한 이하.
 *  - 제공처 키: KOPIS_API_KEY(loadKopisConfig), 공통 SUPABASE_*·INTERNAL_WORKER_SECRET·UPSTREAM_TIMEOUT_MS 등.
 * DB 저장은 내부 RPC 클라이언트(createInternalClient)로 upsert_events를 호출한다. 민규 허용 목록에 upsert_events가
 * 추가되기 전에는 저장 단계가 500(INTERNAL_ERROR)으로 실패하며 0건 성공으로 바꾸지 않는다.
 * 테스트는 createRpcClient를 주입한다. 운영 코드는 자체 transport를 만들어 허용 목록을 우회하지 않는다.
 */
import { loadRuntimeConfig, requireInternalConfig, type EnvReader, type RuntimeConfig } from "../_shared/config/env.ts";
import { loadKopisConfig, loadTourApiConfig } from "../_shared/config/providers.ts";
import { createTourApiEventProvider, TOUR_API_MAX_PAGE, TOUR_API_MAX_PERIOD_DAYS, TOUR_API_MAX_ROWS, TOUR_API_PROVIDER } from "../_shared/integrations/events/tourapi.ts";
import { requireInternalCaller } from "../_shared/auth/internal-caller.ts";
import { createInternalClient } from "../_shared/db/internal-client.ts";
import type { FetchLike, RpcClient } from "../_shared/db/transport.ts";
import { createRpcEventRepository, syncEventPage } from "../_shared/db/repositories/events.ts";
import { HttpError } from "../_shared/http/errors.ts";
import { createRequestContext } from "../_shared/http/request.ts";
import { jsonFailure } from "../_shared/http/response.ts";
import {
  createKopisEventProvider, KOPIS_MAX_PAGE, KOPIS_MAX_PERIOD_DAYS, KOPIS_MAX_ROWS, KOPIS_PROVIDER,
} from "../_shared/integrations/events/kopis.ts";
import type { EventProviderPort } from "../_shared/integrations/events/port.ts";
import { requiredPositiveInt, requiredToken } from "../_shared/jobs/settings.ts";
import { createEventSyncHandler } from "./handler.ts";

interface ProviderDefinition {
  maxPeriodDays: number;
  maxPage: number;
  maxRows: number;
  create(read: EnvReader, settings: { rows: number; timeoutMs: number; fetch: FetchLike; now: () => Date }): EventProviderPort;
}
/** HTTPS·응답 형식을 실제 확인한 제공처만 등록한다. 서울 열린데이터(HTTPS 없음)는 없다. TourAPI는 2026-09-30 키 형식 확인 후 추가(U10). */
const registry: Readonly<Record<string, ProviderDefinition>> = Object.freeze({
  [KOPIS_PROVIDER]: {
    maxPeriodDays: KOPIS_MAX_PERIOD_DAYS, maxPage: KOPIS_MAX_PAGE, maxRows: KOPIS_MAX_ROWS,
    create: (read, settings) => createKopisEventProvider({
      apiKey: loadKopisConfig(read).apiKey, timeoutMs: settings.timeoutMs, rows: settings.rows,
      fetch: (url, init) => settings.fetch(url, init), now: settings.now,
    }),
  },
  [TOUR_API_PROVIDER]: {
    maxPeriodDays: TOUR_API_MAX_PERIOD_DAYS, maxPage: TOUR_API_MAX_PAGE, maxRows: TOUR_API_MAX_ROWS,
    create: (read, settings) => {
      const tour = loadTourApiConfig(read);
      return createTourApiEventProvider({
        serviceKey: tour.serviceKey, keyFormat: tour.keyFormat, timeoutMs: settings.timeoutMs, rows: settings.rows,
        fetch: (url, init) => settings.fetch(url, init), now: settings.now,
      });
    },
  },
});

export interface EventSyncRuntimeOptions {
  /** 테스트용 RPC 주입. 생략하면 민규 createInternalClient를 사용한다. */
  createRpcClient?: (config: RuntimeConfig) => RpcClient;
  now?: () => Date;
}

export function createEventSyncRuntime(read: EnvReader, fetchImpl: FetchLike = fetch, options: EventSyncRuntimeOptions = {}) {
  const config = loadRuntimeConfig(read);
  requireInternalConfig(config);
  const now = options.now ?? (() => new Date());
  const makeClient = options.createRpcClient ?? ((runtime: RuntimeConfig) => createInternalClient(runtime, fetchImpl));
  let providers: Map<string, EventProviderPort>;
  let maxPeriodDays: number, maxPage: number;
  try {
    const names = requiredToken(read, "EVENT_SYNC_PROVIDERS", /^[a-z0-9-]{1,32}(,[a-z0-9-]{1,32}){0,15}$/).split(",");
    if (new Set(names).size !== names.length || names.some((name) => !Object.hasOwn(registry, name))) throw new Error();
    const definitions = names.map((name) => registry[name]);
    maxPeriodDays = requiredPositiveInt(read, "EVENT_SYNC_MAX_PERIOD_DAYS", Math.min(...definitions.map((d) => d.maxPeriodDays)));
    maxPage = requiredPositiveInt(read, "EVENT_SYNC_MAX_PAGE", Math.min(...definitions.map((d) => d.maxPage)));
    const rows = requiredPositiveInt(read, "EVENT_SYNC_PAGE_ROWS", Math.min(...definitions.map((d) => d.maxRows)));
    providers = new Map(names.map((name) => [name, registry[name].create(read, {
      rows, timeoutMs: config.upstreamTimeoutMs, fetch: fetchImpl, now,
    })]));
  } catch {
    // 설정 이름·값·키 원문을 응답/로그에 넣지 않는다. 공급사 설정이 없다는 사실도 내부 인증을 통과한
    // 호출자에게만 503으로 알린다(인증 전 503은 설정 상태를 드러낸다 — 2026-09-30 실제 Edge 검사에서 발견).
    return createEventSyncHandler({
      allowedOrigins: config.allowedOrigins,
      maxBodyBytes: config.maxRequestBytes,
      authenticateInternal: async (request) => {
        await requireInternalCaller(request, config);
        throw new HttpError("EXTERNAL_UNAVAILABLE");
      },
      // authenticateInternal이 항상 끝내므로 아래 값은 본문 검사·수집에 쓰이지 않는다(생성자 형식 검사용 자리표시).
      providers: ["unconfigured"], maxPeriodDays: 1, maxPage: 1,
      sync: async () => { throw new HttpError("EXTERNAL_UNAVAILABLE"); },
    });
  }
  return createEventSyncHandler({
    allowedOrigins: config.allowedOrigins,
    maxBodyBytes: config.maxRequestBytes,
    authenticateInternal: (request) => requireInternalCaller(request, config),
    providers: [...providers.keys()],
    maxPeriodDays,
    maxPage,
    sync: async ({ provider, period, page, signal }) => {
      const port = providers.get(provider);
      if (!port) throw new HttpError("INVALID_REQUEST");
      // 내부 RPC 클라이언트는 내부 인증 성공 뒤에만 만든다.
      const repository = createRpcEventRepository(makeClient(config));
      const result = await syncEventPage(port, repository, { period, page, signal });
      return { fetchedCount: result.fetchedCount, savedCount: result.savedCount, hasMore: result.nextCursor !== undefined };
    },
  });
}

let runtimeHandler: ((request: Request) => Promise<Response>) | undefined;
const entrypoint = {
  fetch(request: Request): Promise<Response> {
    try {
      runtimeHandler ??= createEventSyncRuntime((key) => Deno.env.get(key));
    } catch (error) {
      return Promise.resolve(jsonFailure(error instanceof HttpError ? error : new HttpError("EXTERNAL_UNAVAILABLE"), createRequestContext()));
    }
    return runtimeHandler(request);
  },
};
export default entrypoint;
if (import.meta.main) Deno.serve(entrypoint.fetch);
