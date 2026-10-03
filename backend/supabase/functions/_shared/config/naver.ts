/** 민규담당. 네이버 전용 서버 설정. 필수 운영 수치는 기본값으로 결정하지 않는다. */
import type { EnvReader } from "./env.ts";
import { HttpError } from "../http/errors.ts";

export interface NaverConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly upstreamTimeoutMs: number;
  readonly stateTtlSeconds: number;
}
const fail = (): never => { throw new HttpError("EXTERNAL_UNAVAILABLE"); };
function required(read: EnvReader, key: string): string {
  const value = read(key);
  if (typeof value !== "string" || !value || value.trim() !== value || /\p{Cc}/u.test(value)) return fail();
  return value;
}
function positive(read: EnvReader, key: string, maximum: number): number {
  const raw = required(read, key);
  if (!/^[1-9][0-9]*$/.test(raw)) return fail();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) return fail();
  return value;
}
export function loadNaverConfig(read: EnvReader, allowedOrigins: readonly string[]): NaverConfig {
  try {
    const redirectUri = required(read, "NAVER_REDIRECT_URI");
    const url = new URL(redirectUri);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      url.username || url.password || /[?#]/u.test(redirectUri) || url.href !== redirectUri ||
      !allowedOrigins.includes(url.origin)) return fail();
    const fields: NaverConfig = {
      clientId: required(read, "NAVER_CLIENT_ID"),
      clientSecret: required(read, "NAVER_CLIENT_SECRET"),
      redirectUri,
      upstreamTimeoutMs: positive(read, "UPSTREAM_TIMEOUT_MS", 2147483647),
      // 3600은 기술상한이며 실제 운영 TTL은 환경에서 명시해야 한다.
      stateTtlSeconds: positive(read, "NAVER_STATE_TTL_SECONDS", 3600),
    };
    const result = Object.create(null);
    for (const [name, value] of Object.entries(fields)) Object.defineProperty(result, name, { value });
    const summary = () => ({ provider: "naver", configured: true });
    Object.defineProperty(result, "toJSON", { value: summary });
    Object.defineProperty(result, Symbol.for("nodejs.util.inspect.custom"), { value: summary });
    Object.defineProperty(result, Symbol.for("Deno.customInspect"), { value: summary });
    return Object.freeze(result) as NaverConfig;
  } catch { return fail(); }
}
