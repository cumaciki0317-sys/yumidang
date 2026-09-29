/** 민규담당. 서버 전용 기능별 설정이며 로딩만으로 공급사 호출·공식 모델 확인을 수행하지 않는다. */
import type { EnvReader } from "./env.ts";
import { HttpError } from "../http/errors.ts";

export interface ApiKeyConfig<P extends string> {
  readonly provider: P;
  readonly apiKey: string;
}
export type TourApiKeyFormat = "unknown" | "encoded" | "decoded";
export interface TourApiConfig {
  readonly provider: "tour-api";
  readonly serviceKey: string;
  readonly keyFormat: TourApiKeyFormat;
}
export interface PotensLlmConfig extends ApiKeyConfig<"potens"> {
  readonly baseUrl: string;
  /** 설정된 provider model ID다. 공식 지원 여부·사용 권한을 검증했다는 뜻이 아니다. */
  readonly model: string;
  readonly upstreamTimeoutMs: number;
}

const fail = (): never => { throw new HttpError("EXTERNAL_UNAVAILABLE"); };
function required(read: EnvReader, key: string): string {
  const value = read(key);
  if (typeof value !== "string" || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return fail();
  return value;
}
function safely<T>(load: () => T): T {
  // EnvReader/URL 예외에도 키·설정 원문이나 외부 오류 cause를 붙이지 않는다.
  try { return load(); } catch { return fail(); }
}
function protectedConfig<T extends { readonly provider: string }>(fields: T): Readonly<T> {
  const result = Object.create(null);
  const summary = () => ({ provider: fields.provider, configured: true });
  for (const [name, value] of Object.entries(fields)) {
    Object.defineProperty(result, name, { value, enumerable: name === "provider" });
  }
  Object.defineProperty(result, "toJSON", { value: summary });
  Object.defineProperty(result, Symbol.for("nodejs.util.inspect.custom"), { value: summary });
  Object.defineProperty(result, Symbol.for("Deno.customInspect"), { value: summary });
  return Object.freeze(result) as Readonly<T>;
}

export function loadKakaoConfig(read: EnvReader): ApiKeyConfig<"kakao"> {
  return safely(() => protectedConfig({ provider: "kakao" as const, apiKey: required(read, "KAKAO_REST_API_KEY") }));
}
export function loadKopisConfig(read: EnvReader): ApiKeyConfig<"kopis"> {
  return safely(() => protectedConfig({ provider: "kopis" as const, apiKey: required(read, "KOPIS_API_KEY") }));
}
export function loadSeoulOpenDataConfig(read: EnvReader): ApiKeyConfig<"seoul-open-data"> {
  return safely(() => protectedConfig({ provider: "seoul-open-data" as const, apiKey: required(read, "SEOUL_OPEN_DATA_API_KEY") }));
}
export function loadTourApiConfig(read: EnvReader): TourApiConfig {
  return safely(() => {
    const serviceKey = required(read, "TOUR_API_SERVICE_KEY");
    const rawFormat = read("TOUR_API_KEY_FORMAT");
    const keyFormat = rawFormat === undefined || rawFormat === "" ? "unknown" : rawFormat;
    if (keyFormat !== "unknown" && keyFormat !== "encoded" && keyFormat !== "decoded") return fail();
    // %, +, /, = 등을 검사해 형태를 추측하거나 encode/decode하지 않는다.
    // unknown은 입력 수집 상태다. 호출 어댑터에서 인코딩 방식을 확인하기 전 요청을 보내지 않는다.
    return protectedConfig({ provider: "tour-api" as const, serviceKey, keyFormat });
  });
}
export function loadPotensLlmConfig(read: EnvReader): PotensLlmConfig {
  return safely(() => {
    const apiKey = required(read, "POTENS_API_KEY");
    const baseUrl = required(read, "POTENS_API_BASE_URL");
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== "/" || (baseUrl !== parsed.origin && baseUrl !== `${parsed.origin}/`)) return fail();
    const model = required(read, "POTENS_MODEL");
    // 모델명을 추정하거나 사용자 희망 명칭을 공급사 ID로 변환하지 않는다.
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model)) return fail();
    const rawTimeout = required(read, "UPSTREAM_TIMEOUT_MS");
    if (!/^[1-9][0-9]*$/.test(rawTimeout)) return fail();
    const upstreamTimeoutMs = Number(rawTimeout);
    if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs > 2147483647) return fail();
    return protectedConfig({ provider: "potens" as const, apiKey, baseUrl, model, upstreamTimeoutMs });
  });
}
