/** 민규담당: 기능별 필수 환경을 검사하며 비밀값을 오류에 넣지 않는다. */
import { HttpError } from "../http/errors.ts";

export interface RuntimeConfig {
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly upstreamTimeoutMs: number;
  readonly maxRequestBytes: number;
  readonly allowedOrigins: readonly string[];
  readonly supabaseServiceRoleKey?: string;
  readonly internalWorkerSecret?: string;
  readonly reviewSummaryModelVersion?: string;
  readonly reviewSummaryPromptVersion?: string;
}
export type EnvReader = (key: string) => string | undefined;
const fail = (): never => { throw new HttpError("EXTERNAL_UNAVAILABLE"); };
function required(read: EnvReader, key: string): string {
  const value = read(key);
  if (!value || value.trim() !== value || /[\r\n]/.test(value)) return fail();
  return value;
}
function positive(read: EnvReader, key: string, maximum = 2147483647): number {
  const value = required(read, key);
  if (!/^[1-9][0-9]*$/.test(value)) return fail();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) return fail();
  return number;
}
function optional(read: EnvReader, key: string): string | undefined {
  return read(key) === undefined ? undefined : required(read, key);
}
export function loadRuntimeConfig(read: EnvReader): RuntimeConfig {
  try {
    const parsed = new URL(required(read, "SUPABASE_URL"));
    const local = ["localhost", "127.0.0.1", "[::1]", "kong"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) ||
      parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") return fail();
    const origins: unknown = JSON.parse(required(read, "ALLOWED_ORIGINS"));
    if (!Array.isArray(origins) || origins.some((origin: unknown) => {
      if (typeof origin !== "string") return true;
      const url = new URL(origin);
      return !["http:", "https:"].includes(url.protocol) || url.origin !== origin;
    })) return fail();
    const config: RuntimeConfig = {
      supabaseUrl: parsed.origin,
      supabaseAnonKey: required(read, "SUPABASE_ANON_KEY"),
      upstreamTimeoutMs: positive(read, "UPSTREAM_TIMEOUT_MS"),
      maxRequestBytes: positive(read, "MAX_REQUEST_BYTES"),
      allowedOrigins: Object.freeze([...new Set(origins as string[])]),
      supabaseServiceRoleKey: optional(read, "SUPABASE_SERVICE_ROLE_KEY"),
      internalWorkerSecret: optional(read, "INTERNAL_WORKER_SECRET"),
      // 요약 전용 설정은 공개 처리와 분리한다. 빈 값·잘못된 값도 전용 검사까지 보존한다.
      reviewSummaryModelVersion: read("REVIEW_SUMMARY_MODEL_VERSION"),
      reviewSummaryPromptVersion: read("REVIEW_SUMMARY_PROMPT_VERSION"),
    };
    // 내부 기능의 키 누락은 사용자 전용 기능의 시작을 차단하지 않는다.
    // 키를 출력하는 실수를 줄인다. 기능은 명시적 필드 접근으로만 사용한다.
    Object.defineProperty(config, "toJSON", { value: () => ({ configured: true }) });
    return Object.freeze(config);
  } catch { return fail(); }
}
export type ReviewSummaryConfigState =
  | { status: "ready"; modelVersion: string; promptVersion: string }
  | { status: "pending_configuration" | "configuration_error" };
export function inspectReviewSummaryConfig(config?: { modelVersion?: string; promptVersion?: string }): ReviewSummaryConfigState {
  const values = [config?.modelVersion, config?.promptVersion];
  const version = /^[A-Za-z0-9_.-]{1,64}$/;
  if (values.some((value) => value !== undefined && (typeof value !== "string" || value.trim() !== value || !version.test(value)))) {
    return { status: "configuration_error" };
  }
  if (values.some((value) => value === undefined)) return { status: "pending_configuration" };
  return { status: "ready", modelVersion: config!.modelVersion!, promptVersion: config!.promptVersion! };
}
export function requireInternalConfig(config: RuntimeConfig): { serviceKey: string; workerSecret: string } {
  const serviceKey = config.supabaseServiceRoleKey;
  const workerSecret = config.internalWorkerSecret;
  if (!serviceKey || !workerSecret || workerSecret.length < 32 || workerSecret.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/.test(workerSecret) || workerSecret === serviceKey || workerSecret === config.supabaseAnonKey || serviceKey === config.supabaseAnonKey) return fail();
  return { serviceKey, workerSecret };
}
