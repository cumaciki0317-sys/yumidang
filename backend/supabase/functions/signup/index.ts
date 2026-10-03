/** 민규담당. 설정 누락은 기능을 닫고 실제 네이버 검증 없이 세션을 발급하지 않는다. */
import { loadRuntimeConfig, type EnvReader } from "../_shared/config/env.ts";
import { loadNaverConfig } from "../_shared/config/naver.ts";
import { requirePrincipal } from "../_shared/auth/principal.ts";
import { createNaverSessionBridge } from "../_shared/auth/session-bridge.ts";
import { createUserClient } from "../_shared/db/user-client.ts";
import { createRpcTransport, type FetchLike } from "../_shared/db/transport.ts";
import { createNaverIdentityAdapter } from "../_shared/integrations/identity/adapter.ts";
import { createSignupService } from "../_shared/services/signup-service.ts";
import { HttpError } from "../_shared/http/errors.ts";
import { createSignupHandler } from "./handler.ts";
export function createSignupRuntimeHandler(read: EnvReader, fetchImpl: FetchLike = fetch) {
  const config = loadRuntimeConfig(read);
  return createSignupHandler({ allowedOrigins: config.allowedOrigins, maxBodyBytes: config.maxRequestBytes,
    authenticateUser: async (request) => createUserClient(config, await requirePrincipal(request, config, fetchImpl), fetchImpl),
    service: () => {
      const naver = loadNaverConfig(read, config.allowedOrigins);
      const key = config.supabaseServiceRoleKey;
      if (!key || key === config.supabaseAnonKey) throw new HttpError("EXTERNAL_UNAVAILABLE");
      const internalDb = createRpcTransport(config, key, key, new Set([
        "begin_naver_login", "consume_naver_login", "resolve_naver_account", "record_naver_session",
      ]), fetchImpl);
      return createSignupService({ identity: createNaverIdentityAdapter(naver, fetchImpl),
        bridge: createNaverSessionBridge(config, fetchImpl), internalDb, stateTtlSeconds: naver.stateTtlSeconds });
    },
  });
}
let runtime: ReturnType<typeof createSignupRuntimeHandler> | undefined;
const entrypoint = { fetch(request: Request): Promise<Response> {
  runtime ??= createSignupRuntimeHandler((key) => Deno.env.get(key));
  return runtime(request);
} };
export default entrypoint;
if (import.meta.main) Deno.serve(entrypoint.fetch);
