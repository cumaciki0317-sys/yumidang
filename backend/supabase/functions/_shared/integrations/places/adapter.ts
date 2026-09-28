/**
 * Kakao 키워드 장소 검색 어댑터. 실제 키·네트워크 연결 검증은 하지 않았다.
 * 공식 규격 확인: https://developers.kakao.com/docs/ko/local/dev-guide#search-by-keyword
 * 조회는 작성 입력용이며 좌표·반경·거리순·전화번호를 입력/출력에 추가하지 않는다.
 */
import { PlaceLookupError } from "./port.ts";
import type {
  PlaceInputCandidate,
  PlaceLookupContext,
  PlaceLookupInput,
  PlaceLookupPort,
  PlaceLookupResult,
  PostalAddressLookupPort,
} from "./port.ts";

export interface KakaoPlacesConfig {
  apiKey: string;
  /** 운영 값은 공통 설정에서 명시한다. 단위: 밀리초. */
  timeoutMs: number;
  /** Kakao 키워드 검색 규격: 1..15. */
  pageSize: number;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

const endpoint = "https://dapi.kakao.com/v2/local/search/keyword.json";

function requireMember(context: PlaceLookupContext): void {
  if (!context?.principal || context.principal.kind !== "member" ||
    typeof context.principal.userId !== "string" || !context.principal.userId.trim()) {
    throw new PlaceLookupError("UNAUTHENTICATED");
  }
  if (context.signal?.aborted) throw new PlaceLookupError("CANCELLED");
}

function validateInput(input: PlaceLookupInput): string {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "query" && key !== "page") ||
    typeof input.query !== "string" || !input.query.trim() ||
    !Number.isInteger(input.page) || input.page < 1 || input.page > 45) {
    throw new PlaceLookupError("INVALID_PLACE_INPUT");
  }
  return input.query.trim();
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapResponse(value: unknown, page: number, pageSize: number): PlaceLookupResult {
  if (!record(value) || !record(value.meta) || typeof value.meta.is_end !== "boolean" ||
    !Array.isArray(value.documents) || value.documents.length > pageSize) {
    throw new PlaceLookupError("SOURCE_INVALID_RESPONSE");
  }
  const seen = new Set<string>();
  const places: PlaceInputCandidate[] = value.documents.map((document: unknown) => {
    if (!record(document) || typeof document.id !== "string" || !document.id.trim() ||
      typeof document.place_name !== "string" || !document.place_name.trim() ||
      typeof document.address_name !== "string" || typeof document.road_address_name !== "string" ||
      (!document.address_name.trim() && !document.road_address_name.trim()) || seen.has(document.id)) {
      throw new PlaceLookupError("SOURCE_INVALID_RESPONSE");
    }
    seen.add(document.id);
    return {
      source: "kakao",
      sourceId: document.id,
      placeName: document.place_name,
      address: document.address_name.trim() ? document.address_name : null,
      roadAddress: document.road_address_name.trim() ? document.road_address_name : null,
    };
  });
  return {
    status: places.length ? "results" : "no_results",
    places,
    nextPage: value.meta.is_end || page === 45 ? null : page + 1,
  };
}

export function createKakaoPlacesAdapter(config: KakaoPlacesConfig): PlaceLookupPort {
  if (!config || typeof config.apiKey !== "string" || !config.apiKey.trim()) {
    throw new PlaceLookupError("PLACE_PROVIDER_UNCONFIGURED");
  }
  if (/\s/u.test(config.apiKey) || typeof config.fetch !== "function" ||
    !Number.isInteger(config.pageSize) || config.pageSize < 1 || config.pageSize > 15 ||
    !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2_147_483_647) {
    throw new PlaceLookupError("INVALID_PLACE_CONFIG");
  }
  // 호출 도중 외부 객체가 바뀌어 endpoint·한도·인증 설정을 바꾸지 못하게 복사한다.
  const { apiKey, timeoutMs, pageSize, fetch: transport } = config;
  return {
    async lookup(input, context) {
      requireMember(context);
      const query = validateInput(input);
      const page = input.page;
      const url = new URL(endpoint);
      url.searchParams.set("query", query);
      url.searchParams.set("page", String(page));
      url.searchParams.set("size", String(pageSize));
      // 좌표를 사용하지 않는 제공사 기본 정확도순을 명시한다.
      url.searchParams.set("sort", "accuracy");
      const controller = new AbortController();
      let timedOut = false;
      const cancel = () => controller.abort();
      context.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new PlaceLookupError(timedOut ? "SOURCE_TIMEOUT" : "CANCELLED"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        if (context.signal?.aborted) controller.abort();
        if (controller.signal.aborted) throw new PlaceLookupError("CANCELLED");
        const request = (async () => {
          const response = await transport(url.toString(), {
            method: "GET",
            headers: { Authorization: `KakaoAK ${apiKey}`, Accept: "application/json" },
            signal: controller.signal,
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
          });
          if (response.status === 401 || response.status === 403) throw new PlaceLookupError("SOURCE_AUTH_REJECTED");
          if (response.status === 429) throw new PlaceLookupError("SOURCE_RATE_LIMITED");
          if (response.status >= 500) throw new PlaceLookupError("SOURCE_UNAVAILABLE");
          if (!response.ok) throw new PlaceLookupError("SOURCE_REJECTED");
          let body: unknown;
          try {
            body = await response.json();
          } catch {
            throw new PlaceLookupError("SOURCE_INVALID_RESPONSE");
          }
          return mapResponse(body, page, pageSize);
        })();
        return await Promise.race([request, aborted]);
      } catch (error) {
        if (controller.signal.aborted) throw new PlaceLookupError(timedOut ? "SOURCE_TIMEOUT" : "CANCELLED");
        if (error instanceof PlaceLookupError) throw error;
        throw new PlaceLookupError("SOURCE_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", cancel);
        controller.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** 우편번호 조회를 카카오 주소/장소 API로 임의 대체하지 않는다. */
export function createUnconfiguredPostalAddressAdapter(): PostalAddressLookupPort {
  return {
    configured: false,
    async lookup(input, context) {
      requireMember(context);
      if (!input || typeof input.query !== "string" || !input.query.trim()) {
        throw new PlaceLookupError("INVALID_PLACE_INPUT");
      }
      return { status: "unavailable", code: "POSTAL_PROVIDER_UNCONFIGURED" };
    },
  };
}
