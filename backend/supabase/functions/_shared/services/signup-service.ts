/** 민규담당. 영속 일회용 state → 네이버 검증 → 제한된 Auth 세션 → DB 귀속 확인. 원문 기록 없음. */
import type { JsonValue } from "../contracts/common.ts";
import type { SignupStatus } from "../contracts/signup.ts";
import { parseNaverStart, parseNaverCallback, parseSignupCompletion, parseReturnTo, parseProfileTraits } from "../contracts/signup.ts";
import type { NaverIdentityPort } from "../integrations/identity/port.ts";
import type { RpcClient } from "../db/transport.ts";
import type { createNaverSessionBridge } from "../auth/session-bridge.ts";
import { HttpError } from "../http/errors.ts";
export interface SignupDependencies {
  identity: NaverIdentityPort;
  internalDb: RpcClient;
  bridge: ReturnType<typeof createNaverSessionBridge>;
  stateTtlSeconds: number;
}
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
const upstream = (): never => { throw new HttpError("EXTERNAL_UNAVAILABLE"); };
const statuses: SignupStatus[] = ["information_required", "ineligible", "photo_required", "completion_required", "ready"];
function row(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return upstream();
  return value;
}
function status(value: JsonValue | undefined): SignupStatus {
  if (!statuses.includes(value as SignupStatus)) return upstream();
  return value as SignupStatus;
}
function uuid(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return upstream();
  return value;
}
function signupState(value: JsonValue): JsonValue {
  const data = row(value);
  try {
    if (data.avatarPath !== null) parseSignupCompletion({ avatarPath: data.avatarPath! });
    const traits = parseProfileTraits({ interests: data.interests!, conversationStyles: data.conversationStyles!, mbti: data.mbti! });
    return { status: status(data.status), avatarPath: data.avatarPath!, ...traits };
  } catch { return upstream(); }
}
export function createSignupService(dependencies: SignupDependencies) {
  const { identity, internalDb, bridge, stateTtlSeconds } = dependencies;
  if (!Number.isSafeInteger(stateTtlSeconds) || stateTtlSeconds < 1 || stateTtlSeconds > 3600) return upstream();
  return {
    async start(body: JsonValue, origin: string): Promise<JsonValue> {
      const input = parseNaverStart(body);
      const state = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const stored = row(await internalDb.rpc("begin_naver_login", {
        p_state_hash: await sha256(state), p_verifier_hash: input.codeChallenge,
        p_return_to: input.returnTo, p_expires_seconds: stateTtlSeconds, p_origin: origin,
      }));
      if (typeof stored.expiresAt !== "string" || !Number.isFinite(Date.parse(stored.expiresAt))) return upstream();
      return { authorizationUrl: identity.authorizationUrl(state), expiresAt: stored.expiresAt };
    },
    async callback(body: JsonValue, origin: string): Promise<JsonValue> {
      const input = parseNaverCallback(body);
      const consumed = row(await internalDb.rpc("consume_naver_login", {
        p_state_hash: await sha256(input.state), p_verifier_hash: await sha256(input.codeVerifier), p_origin: origin,
      }));
      let returnTo: string;
      try { returnTo = parseReturnTo(consumed.returnTo); } catch { return upstream(); }
      const profile = await identity.exchange(input.code, input.state);
      const account = row(await internalDb.rpc("resolve_naver_account", {
        p_subject: profile.subject, p_name: profile.name, p_gender: profile.gender, p_birth_date: profile.birthDate,
      }));
      const current = status(account.status);
      if (account.authEmail === null) {
        if (account.userId !== null || !["information_required", "ineligible"].includes(current)) return upstream();
        return { status: current, returnTo, session: null, userId: null };
      }
      if (typeof account.authEmail !== "string") return upstream();
      const expectedUserId = account.userId === null ? null : uuid(account.userId);
      const session = await bridge.issue(account.authEmail, expectedUserId);
      const recorded = row(await internalDb.rpc("record_naver_session", {
        p_subject: profile.subject, p_user_id: session.userId, p_session_id: session.sessionId,
      }));
      if (uuid(recorded.userId) !== session.userId || recorded.authEmail !== account.authEmail) return upstream();
      return { status: status(recorded.status), returnTo, userId: session.userId, session: {
        accessToken: session.accessToken, refreshToken: session.refreshToken,
        expiresIn: session.expiresIn, tokenType: session.tokenType,
      } };
    },
    async state(db: RpcClient): Promise<JsonValue> { return signupState(await db.rpc("get_naver_signup_state", {})); },
    async complete(db: RpcClient, body: JsonValue): Promise<JsonValue> {
      const input = parseSignupCompletion(body);
      return signupState(await db.rpc("complete_naver_signup", { p_avatar_path: input.avatarPath,
        p_interests: input.interests, p_conversation_styles: input.conversationStyles, p_mbti: input.mbti }));
    },
  };
}
