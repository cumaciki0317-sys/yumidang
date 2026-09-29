/** 민규담당: Supabase Auth 검증 결과만 호출자로 인정한다. PASS 가입 증명과 별개다. */
import type { RuntimeConfig } from "../config/env.ts";
import { fetchJson, type FetchLike } from "../db/transport.ts";
import { HttpError } from "../http/errors.ts";
export interface Principal { readonly userId: string }
const tokens = new WeakMap<Principal, string>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function readBearer(request: Request): string {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer ([A-Za-z0-9._~-]+)$/i);
  if (!match || match[1].length > 16384) throw new HttpError("AUTH_REQUIRED");
  return match[1];
}
export async function requirePrincipal(request: Request, config: RuntimeConfig, fetchImpl: FetchLike = fetch): Promise<Principal> {
  const token = readBearer(request);
  if (token === config.supabaseAnonKey || token === config.supabaseServiceRoleKey || token === config.internalWorkerSecret || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new HttpError("AUTH_REQUIRED");
  const { status, body } = await fetchJson(`${config.supabaseUrl}/auth/v1/user`, {
    method: "GET", headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${token}`, Accept: "application/json" },
  }, config.upstreamTimeoutMs, fetchImpl);
  if (status === 401 || status === 403) throw new HttpError("AUTH_REQUIRED");
  if (status < 200 || status >= 300) throw new HttpError("EXTERNAL_UNAVAILABLE");
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.id !== "string" || !uuid.test(body.id) || body.role !== "authenticated" || body.is_anonymous === true) throw new HttpError("AUTH_REQUIRED");
  const principal = Object.freeze({ userId: body.id });
  tokens.set(principal, token);
  return principal;
}
/** 공개 경로에서는 Authorization 헤더가 아예 없는 요청만 비로그인으로 취급한다. */
export async function requireOptionalPrincipal(request: Request, config: RuntimeConfig, fetchImpl: FetchLike = fetch): Promise<Principal | null> {
  if (!request.headers.has("authorization")) return null;
  // 빈 헤더·만료·잘못된 토큰·Auth 장애를 익명 조회로 강등하지 않는다.
  return requirePrincipal(request, config, fetchImpl);
}

/** 프런트 입력으로 구성한 Principal 객체는 이 함수를 통과할 수 없다. */
export function getPrincipalToken(principal: Principal): string {
  const token = tokens.get(principal);
  if (!token) throw new HttpError("AUTH_REQUIRED");
  return token;
}
