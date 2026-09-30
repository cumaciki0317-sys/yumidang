/**
 * 담당: 종현담당. 장소 검색 런타임 진입점. import는 환경을 읽거나 서버를 시작하지 않는다.
 * 공통 설정(loadRuntimeConfig)·Auth(requirePrincipal)·Kakao 설정(loadKakaoConfig)을 조립한다.
 * PLACES_PAGE_SIZE(1..15)는 명시 환경값이며 기본값이 없다. Kakao 키·페이지 크기 누락은 인증된 요청에서 503이다.
 */
import { loadRuntimeConfig, type EnvReader } from "../_shared/config/env.ts";
import { loadKakaoConfig } from "../_shared/config/providers.ts";
import { requirePrincipal } from "../_shared/auth/principal.ts";
import type { FetchLike } from "../_shared/db/transport.ts";
import { HttpError } from "../_shared/http/errors.ts";
import { createRequestContext } from "../_shared/http/request.ts";
import { jsonFailure } from "../_shared/http/response.ts";
import { createKakaoPlacesAdapter } from "../_shared/integrations/places/adapter.ts";
import type { PlaceLookupPort } from "../_shared/integrations/places/port.ts";
import { requiredPositiveInt } from "../_shared/jobs/settings.ts";
import { createPlacesHandler } from "./handler.ts";

export function createPlacesRuntime(read: EnvReader, fetchImpl: FetchLike = fetch): (request: Request) => Promise<Response> {
  const config = loadRuntimeConfig(read);
  let adapter: PlaceLookupPort | undefined;
  // 장소 공급사 설정은 장소 요청에서만 필요하다. 성공한 조립만 재사용하고 실패는 매 요청 다시 검사한다.
  const provider = (): PlaceLookupPort => {
    if (adapter) return adapter;
    let apiKey: string;
    let pageSize: number;
    try {
      apiKey = loadKakaoConfig(read).apiKey;
      pageSize = requiredPositiveInt(read, "PLACES_PAGE_SIZE", 15);
    } catch {
      throw new HttpError("EXTERNAL_UNAVAILABLE");
    }
    adapter = createKakaoPlacesAdapter({
      apiKey, timeoutMs: config.upstreamTimeoutMs, pageSize, fetch: (url, init) => fetchImpl(url, init),
    });
    return adapter;
  };
  return createPlacesHandler({
    allowedOrigins: config.allowedOrigins,
    authenticate: (request) => requirePrincipal(request, config, fetchImpl),
    lookup: (input, context) => provider().lookup(input, context),
  });
}

let runtimeHandler: ((request: Request) => Promise<Response>) | undefined;
const entrypoint = {
  fetch(request: Request): Promise<Response> {
    try {
      runtimeHandler ??= createPlacesRuntime((key) => Deno.env.get(key));
    } catch (error) {
      // 공통 설정 누락은 원문 없이 503으로 응답한다. 실패한 조립은 캐시하지 않는다.
      return Promise.resolve(jsonFailure(error instanceof HttpError ? error : new HttpError("EXTERNAL_UNAVAILABLE"), createRequestContext()));
    }
    return runtimeHandler(request);
  },
};
export default entrypoint;
if (import.meta.main) Deno.serve(entrypoint.fetch);
