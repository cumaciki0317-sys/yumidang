/** 민규담당. Deno/Supabase 런타임 진입점. 설정·원문·자격 증명을 출력하지 않는다. */
import { loadRuntimeConfig, type EnvReader } from "../_shared/config/env.ts";
import { requireOptionalPrincipal, requirePrincipal } from "../_shared/auth/principal.ts";
import { requireInternalCaller } from "../_shared/auth/internal-caller.ts";
import { createPublicClient } from "../_shared/db/public-client.ts";
import type { PublicPostSearchExecutor } from "./search-http.ts";
import { createUserClient } from "../_shared/db/user-client.ts";
import { createInternalClient } from "../_shared/db/internal-client.ts";
import { createServiceApi } from "./handler.ts";
import { createRpcPublicPostSearchRepository } from "../_shared/db/repositories/search.ts";
import { searchPublicPosts } from "../_shared/services/search-service.ts";
import { createRpcEventRepository, listEventFilterValues } from "../_shared/db/repositories/events.ts";

/** 실제 실행과 통합 검증이 같은 설정·인증·DB 의존성 조립을 사용한다. */
export function createRuntimeHandler(
  read: EnvReader,
  options: { publicPostSearch?: PublicPostSearchExecutor } = {},
): (request: Request) => Promise<Response> {
  const config = loadRuntimeConfig(read);
  const authenticatePublic = async (request: Request) => {
    const principal = await requireOptionalPrincipal(request, config);
    return principal
      ? { db: createUserClient(config, principal), caller: "member" as const }
      : { db: createPublicClient(config), caller: "anonymous" as const };
  };
  return createServiceApi({
    allowedOrigins: config.allowedOrigins,
    maxBodyBytes: config.maxRequestBytes,
    publicSearch: {
      authenticate: authenticatePublic,
      execute: options.publicPostSearch ?? ((db, input) =>
        searchPublicPosts(createRpcPublicPostSearchRepository(db), input)),
    },
    publicEvents: {
      authenticate: authenticatePublic,
      execute: (db, input) => createRpcEventRepository(db).listPage(input.query, input.cursor, input.limit),
      filters: listEventFilterValues,
    },
    publicPostDetails: { authenticate: authenticatePublic },
    authenticateUser: async (request) => createUserClient(config, await requirePrincipal(request, config)),
    authenticateInternal: async (request) => {
      await requireInternalCaller(request, config);
      return createInternalClient(config);
    },
    maintenance: { modelVersion: config.reviewSummaryModelVersion, promptVersion: config.reviewSummaryPromptVersion },
  });
}

// 공개 검색은 종현 검색 서비스·RPC repository를 거쳐 공통 인증 client로 실행한다.
// 호스팅 런타임이 모듈을 import해도 fetch 진입점이 존재한다.
// import 자체는 환경을 읽거나 서버를 시작하지 않아 factory 기반 검증과 분리된다.
let runtimeHandler: ((request: Request) => Promise<Response>) | undefined;
const entrypoint = {
  fetch(request: Request): Promise<Response> {
    runtimeHandler ??= createRuntimeHandler((key) => Deno.env.get(key));
    return runtimeHandler(request);
  },
};
export default entrypoint;

if (import.meta.main) Deno.serve(entrypoint.fetch);
