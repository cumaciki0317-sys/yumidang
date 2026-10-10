import { ApiError, ServiceApiClient, checkAbort, requestSignal } from "./api.ts";
import { fields, string, timestamp, wire, uuid } from "./member-service.ts";
import { internalPath, publicApiKey, retirementResult, sessionResult, signupState, type MemberSessionPort, type SessionResult } from "./member-session.ts";

export interface WebSessionOptions {
  signupUrl: string;
  supabaseUrl: string;
  publicApiKey: string;
  callbackUrl: string;
  browser: Pick<Window, "location" | "history" | "sessionStorage" | "crypto">;
  /** 검토한 실제 배포 계약만 신뢰된 초기화 코드에서 지정한다. URL/환경 문자열로 추론하지 않는다. */
  messageReadContract?: "2026-10-08-individual-message-read";
  fetcher?: typeof fetch;
  now?: () => number;
  /** 배포된 SQL117 원 JWT 영수증 계약을 확인한 초기화 코드만 설치한다. */
  retirementContract?: "2026-10-09-retirement-receipt";
}
const discarders = new WeakMap<MemberSessionPort, () => void>();
const discardListeners = new WeakMap<MemberSessionPort, Set<() => void>>();
/** 세션 교체 알림에는 UID·토큰·영수증을 담지 않는다. */
export function subscribeWebMemberSessionDiscard(port: MemberSessionPort, listener: () => void) {
  const listeners = discardListeners.get(port);
  listeners?.add(listener);
  return () => { listeners?.delete(listener); };
}
/** 포트 교체 때 이전 메모리 세션·탈퇴 토큰을 폐기한다. Auth 요청을 추가하지 않는다. */
export function discardWebMemberSession(port: MemberSessionPort | null) { if (port) discarders.get(port)?.(); }
/** Web only. Native callback is a separate approved contract, never a spoofed browser Origin. */
export function createWebMemberSessionPort(options: WebSessionOptions): MemberSessionPort {
  publicApiKey(options.publicApiKey);
  if (options.retirementContract !== undefined && options.retirementContract !== "2026-10-09-retirement-receipt") throw new ApiError(400, "INVALID_RETIREMENT_CONFIGURATION");
  const retirementEnabled = options.retirementContract === "2026-10-09-retirement-receipt";
  const { browser } = options;
  const callback = new URL(options.callbackUrl), project = new URL(options.supabaseUrl), signup = new URL(options.signupUrl);
  if (callback.protocol !== "https:" || callback.origin !== browser.location.origin || callback.search || callback.hash || callback.username || callback.password || callback.pathname !== "/auth-callback" || project.protocol !== "https:" || project.username || project.password || project.search || project.hash || !["", "/"].includes(project.pathname) || !options.publicApiKey) throw new ApiError(400, "INVALID_SESSION_CONFIGURATION");
  if (signup.origin !== project.origin || signup.pathname !== "/functions/v1/signup" || signup.search || signup.hash || signup.username || signup.password) throw new ApiError(400, "INVALID_SESSION_CONFIGURATION");
  let active: SessionResult | null = null;
  let refreshToken: string | null = null;
  let expiresAt = 0;
  let generation = 0;
  let refreshing: Promise<string | null> | null = null;
  const fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now;
  const client = new ServiceApiClient(options.signupUrl, async () => getAccessToken(), fetcher);
  const temporaryKey = "yumidang.naver.pending";
  type Receipt = ReturnType<typeof retirementResult>;
  type Retirement = { id: string; userId: string; token: string; expiresAt: number; generation: number; busy: boolean; receipt: Receipt | null };
  let retirement: Retirement | null = null;
  // 폐기된 요청을 새 로그인 회원의 최초 요청으로 바꾸지 않는다. 토큰·영수증은 남기지 않는다.
  const discardedIds = new Set<string>();
  function discardRetirement() { if (retirement) discardedIds.add(retirement.id); retirement = null; }
  function discardSession() { discardRetirement(); browser.sessionStorage.removeItem(temporaryKey); active = null; refreshToken = null; expiresAt = 0; refreshing = null; generation++; discardListeners.get(port)?.forEach(listener => listener()); }
  function originalTokenExpiry(token: string, userId: string) {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token === options.publicApiKey) throw new ApiError(401, "AUTH_REQUIRED");
    try {
      const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
      const header = decode(token.split(".")[0]), claims = decode(token.split(".")[1]);
      if (typeof header.alg !== "string" || header.alg.toLowerCase() === "none" || claims.role !== "authenticated" || claims.is_anonymous === true || typeof claims.sub !== "string" || claims.sub.toLowerCase() !== userId.toLowerCase() || !Number.isSafeInteger(claims.exp) || claims.exp <= now() / 1000) throw new Error();
      // 서명 검증은 기존 HTTPS 백엔드가 담당한다. 여기서는 원 세션의 UID·만료 경계만 확인한다.
      return Math.min(expiresAt, claims.exp * 1000);
    } catch { throw new ApiError(401, "AUTH_REQUIRED"); }
  }
  function checkRetirement(scope: Retirement) {
    if (retirement !== scope || scope.generation !== generation) throw new ApiError(401, "SESSION_CHANGED");
    if (now() >= scope.expiresAt) throw new ApiError(401, "RETIREMENT_TOKEN_EXPIRED");
  }
  async function retire(withdrawalId: string, signal: AbortSignal) {
    const id = uuid(withdrawalId).toLowerCase();
    if (discardedIds.has(id)) throw new ApiError(401, "SESSION_CHANGED");
    if (!retirement) {
      if (!active || active.status !== "ready" || refreshing || now() >= expiresAt) throw new ApiError(401, "AUTH_REQUIRED");
      const token = active.accessToken, userId = active.userId;
      retirement = { id, userId, token, expiresAt: originalTokenExpiry(token, userId), generation, busy: false, receipt: null };
    }
    const scope = retirement;
    if (scope.id !== id) throw new ApiError(409, "RETIREMENT_REQUEST_CHANGED");
    checkRetirement(scope);
    if (scope.busy) throw new ApiError(409, "RETIREMENT_IN_PROGRESS");
    scope.busy = true;
    try {
      // 최초 전송 전에 원 JWT+ID를 잡고 모든 수동 재조회에도 같은 값만 쓴다. refresh/익명/자동 재전송 없음.
      const receiptClient = new ServiceApiClient(project.origin + "/functions/v1/service-api", async () => { checkRetirement(scope); return scope.token; }, async (url, init) => { checkRetirement(scope); return fetcher(url, init); });
      const result = retirementResult(await receiptClient.request("/me/retirement", { method: "POST", body: { withdrawalId: id }, signal }), id);
      checkRetirement(scope);
      if (scope.receipt?.status === "completed" && result.status !== "completed") throw new ApiError(502, "INVALID_SERVICE_RESPONSE");
      scope.receipt = Object.freeze(result);
      if (active) { active = null; refreshToken = null; expiresAt = 0; generation++; scope.generation = generation; }
      return { ...scope.receipt };
    } finally { scope.busy = false; }
  }
  async function authFetch(path: string, body: unknown, token: string | null, signal?: AbortSignal) {
    const request = requestSignal([signal]);
    const combined = request.signal;
    try {
      const response = await fetcher(`${project.origin}/auth/v1${path}`, { method: "POST", headers: { apikey: options.publicApiKey, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: combined, redirect: "error", cache: "no-store" });
      checkAbort(combined);
      if (!response.ok) throw new ApiError(response.status, "AUTH_REQUEST_FAILED", response.status >= 500);
      const result = response.status === 204 ? null : await response.json(); checkAbort(combined); return result;
    } finally { request.dispose(); }
  }
  async function getAccessToken(): Promise<string | null> {
    if (!active || !refreshToken) return null;
    if (retirement) return now() < Math.min(expiresAt, retirement.expiresAt) ? active.accessToken : null;
    if (now() < expiresAt) return active.accessToken;
    if (refreshing) return refreshing;
    const currentGeneration = generation;
    const pending = (async () => {
      const result = wire(await authFetch("/token?grant_type=refresh_token", { refresh_token: refreshToken }, null));
      if (generation !== currentGeneration || !active) return null;
      const user = wire(result.user);
      if (user.id !== active.userId || !Number.isSafeInteger(result.expires_in) || (result.expires_in as number) <= 0) throw new ApiError(502, "INVALID_SESSION_RESPONSE");
      active = sessionResult({ ...active, accessToken: string(result.access_token) });
      refreshToken = string(result.refresh_token); expiresAt = now() + (result.expires_in as number) * 1000;
      return active.accessToken;
    })().catch(error => { if (generation === currentGeneration) { active = null; refreshToken = null; generation++; } throw error; }).finally(() => { if (refreshing === pending) refreshing = null; });
    refreshing = pending;
    return pending;
  }
  const port: MemberSessionPort = {
    accessToken: getAccessToken,
    ...(retirementEnabled ? { retire } : {}),
    async login(returnTo, signal) {
      internalPath(returnTo);
      if (retirementEnabled) discardSession();
      // The verifier is browser-tab scoped; access/refresh tokens are never persisted here.
      const random = browser.crypto.getRandomValues(new Uint8Array(32));
      const verifier = btoa(String.fromCharCode(...random)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const digest = await browser.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const challenge = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
      const result = fields(await client.request("/naver/start", { method: "POST", auth: "anonymous", body: { codeChallenge: challenge, returnTo }, signal }), ["authorizationUrl", "expiresAt"]);
      const authorization = new URL(string(result.authorizationUrl));
      const state = authorization.searchParams.get("state");
      if (authorization.origin !== "https://nid.naver.com" || authorization.pathname !== "/oauth2.0/authorize" || authorization.username || authorization.password || authorization.hash || !state || !/^[0-9a-f]{64}$/.test(state) || authorization.searchParams.get("redirect_uri") !== options.callbackUrl) throw new ApiError(502, "INVALID_SESSION_RESPONSE");
      const expiration = timestamp(result.expiresAt);
      if (Date.parse(expiration) <= now()) throw new ApiError(408, "LOGIN_EXPIRED");
      checkAbort(signal);
      browser.sessionStorage.setItem(temporaryKey, JSON.stringify({ state, verifier, expiresAt: expiration }));
      browser.location.assign(authorization.toString());
      return null;
    },
    async callback(url, signal) {
      const currentGeneration = generation;
      const actual = new URL(url);
      const pending = browser.sessionStorage.getItem(temporaryKey);
      browser.sessionStorage.removeItem(temporaryKey);
      browser.history.replaceState(null, "", callback.pathname);
      if (actual.origin !== callback.origin || actual.pathname !== callback.pathname || actual.hash || !pending) throw new ApiError(400, "INVALID_LOGIN_CALLBACK");
      let parsed: unknown; try { parsed = JSON.parse(pending); } catch { throw new ApiError(400, "INVALID_LOGIN_CALLBACK"); }
      const p = fields(parsed, ["state", "verifier", "expiresAt"]);
      const state = string(p.state), code = actual.searchParams.get("code");
      if (actual.searchParams.get("error") || actual.searchParams.getAll("state").length !== 1 || actual.searchParams.getAll("code").length !== 1 || actual.searchParams.get("state") !== state || !code || Date.parse(timestamp(p.expiresAt)) <= now()) throw new ApiError(400, "INVALID_LOGIN_CALLBACK");
      const result = fields(await client.request("/naver/callback", { method: "POST", auth: "anonymous", body: { code, state, codeVerifier: string(p.verifier) }, signal }), ["status", "returnTo", "userId", "session"]);
      if (result.session === null) {
        if (result.userId !== null || !["information_required", "ineligible"].includes(string(result.status))) throw new ApiError(502, "INVALID_SESSION_RESPONSE");
        throw new ApiError(403, result.status === "ineligible" ? "NAVER_INELIGIBLE" : "NAVER_INFORMATION_REQUIRED");
      }
      const session = fields(result.session, ["accessToken", "refreshToken", "expiresIn", "tokenType"]);
      if (!Number.isSafeInteger(session.expiresIn) || (session.expiresIn as number) <= 0 || string(session.tokenType).toLowerCase() !== "bearer") throw new ApiError(502, "INVALID_SESSION_RESPONSE");
      const verified = sessionResult({ userId: uuid(result.userId), accessToken: string(session.accessToken), status: result.status, returnTo: result.returnTo });
      checkAbort(signal);
      if (generation !== currentGeneration) throw new ApiError(401, "SESSION_CHANGED");
      if (retirementEnabled) discardRetirement();
      active = verified; refreshToken = string(session.refreshToken); expiresAt = now() + (session.expiresIn as number) * 1000; generation++;
      return verified;
    },
    async restore(signal) {
      const currentGeneration = generation;
      if (!await getAccessToken() || !active) return null;
      const state = signupState(await client.request("/state", { signal }));
      if (generation !== currentGeneration || !active) throw new ApiError(401, "SESSION_CHANGED");
      active = { ...active, status: state.status }; return active;
    },
    async logout(signal) {
      const access = active?.accessToken;
      discardSession();
      browser.sessionStorage.removeItem(temporaryKey);
      if (access) await authFetch("/logout?scope=local", {}, access, signal);
    },
    async signupState(signal) { return signupState(await client.request("/state", { signal })); },
    async complete(input, signal) {
      const currentGeneration = generation;
      const state = signupState(await client.request("/complete", { method: "POST", body: input, signal }));
      if (generation !== currentGeneration || !active) throw new ApiError(401, "SESSION_CHANGED");
      active = { ...active, status: state.status }; return state;
    },
  };
  discarders.set(port, discardSession);
  discardListeners.set(port, new Set());
  return port;
}
