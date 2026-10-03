/** 민규담당: 검증된 네이버 계정 예약을 Supabase Auth 세션으로 연결한다. */
import type { RuntimeConfig } from "../config/env.ts";
import { fetchJson } from "../db/transport.ts";
import { HttpError } from "../http/errors.ts";

export interface NaverAuthSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly tokenType: "bearer";
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const alias = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@naver\.yumidang\.invalid$/;
const fail = (): never => { throw new HttpError("EXTERNAL_UNAVAILABLE"); };
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const validUuid = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value) && value !== "00000000-0000-0000-0000-000000000000";

function decodePart(part: string): Record<string, unknown> | null {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), (c) => c.charCodeAt(0));
  return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

/**
 * 서버 전용 API다. 호출 전에 네이버 필수 정보·자격 검사와 DB의 계정 별칭 예약이 필요하다.
 * Auth 공식 REST generate_link는 User 필드와 링크 필드를 평면으로 반환한다.
 * https://github.com/supabase/auth/blob/master/internal/api/mail.go
 * 신규 magiclink는 signup verification_type으로 바뀌므로 두 가지 타입만 허용한다.
 * 반환 토큰은 record_naver_session이 auth.sessions의 사용자·예약을 검증하기 전 공개하지 않는다.
 */
export function createNaverSessionBridge(config: RuntimeConfig, fetchImpl: typeof fetch = fetch) {
  const serviceKey = config.supabaseServiceRoleKey;
  try {
    const url = new URL(config.supabaseUrl);
    const local = ["localhost", "127.0.0.1", "[::1]", "kong"].includes(url.hostname);
    if (url.origin !== config.supabaseUrl || url.username || url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      !serviceKey || serviceKey === config.supabaseAnonKey || !config.supabaseAnonKey ||
      !Number.isSafeInteger(config.upstreamTimeoutMs) || config.upstreamTimeoutMs <= 0) return fail();
  } catch { return fail(); }

  return Object.freeze({
    async issue(authEmail: string, expectedUserId: string | null): Promise<NaverAuthSession> {
      if (typeof authEmail !== "string" || !alias.test(authEmail) ||
        (expectedUserId !== null && !validUuid(expectedUserId))) throw new HttpError("INVALID_REQUEST");
      // 실제 이메일·비밀번호·회원 메타데이터·redirect_to는 보내지 않는다.
      const generated = await fetchJson(`${config.supabaseUrl}/auth/v1/admin/generate_link`, {
        method: "POST",
        headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ type: "magiclink", email: authEmail }),
      }, config.upstreamTimeoutMs, fetchImpl);
      const link = object(generated.body);
      if (generated.status !== 200 || !link || !validUuid(link.id) || link.email !== authEmail ||
        (expectedUserId !== null && link.id !== expectedUserId) ||
        (link.verification_type !== "magiclink" && link.verification_type !== "signup") ||
        typeof link.hashed_token !== "string" || !/^[A-Za-z0-9_-]{16,512}$/.test(link.hashed_token)) return fail();

      const verified = await fetchJson(`${config.supabaseUrl}/auth/v1/verify`, {
        method: "POST",
        headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${config.supabaseAnonKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ type: link.verification_type, token_hash: link.hashed_token }),
      }, config.upstreamTimeoutMs, fetchImpl);
      const session = object(verified.body);
      const user = object(session?.user);
      if (verified.status !== 200 || !session || !user || user.id !== link.id || user.email !== authEmail ||
        user.role !== "authenticated" || user.is_anonymous !== false || session.token_type !== "bearer" ||
        typeof session.expires_in !== "number" || !Number.isSafeInteger(session.expires_in) || session.expires_in <= 0 ||
        typeof session.refresh_token !== "string" || !/^[A-Za-z0-9._~-]{1,16384}$/.test(session.refresh_token) ||
        typeof session.access_token !== "string" || session.access_token.length > 16384 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(session.access_token) ||
        session.access_token === serviceKey || session.access_token === config.supabaseAnonKey) return fail();
      let sessionId: string;
      try {
        const [headerPart, payloadPart, signaturePart] = session.access_token.split(".");
        if (signaturePart.length % 4 === 1) return fail();
        const header = decodePart(headerPart), claims = decodePart(payloadPart);
        if (!header || !["HS256", "RS256", "ES256", "EdDSA"].includes(String(header.alg)) ||
          !claims || !validUuid(claims.session_id) || claims.sub !== user.id || claims.role !== "authenticated") return fail();
        // 서명 검증이 아니라 session_id 추출이다. DB에서 실제 Auth 세션과 귀속을 확인한다.
        sessionId = claims.session_id;
      } catch { return fail(); }
      return Object.freeze({ userId: user.id as string, sessionId, accessToken: session.access_token,
        refreshToken: session.refresh_token, expiresIn: session.expires_in, tokenType: "bearer" as const });
    },
  });
}
