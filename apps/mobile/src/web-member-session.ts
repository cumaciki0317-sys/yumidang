import { ApiError, ServiceApiClient, checkAbort, requestSignal } from "./api.ts";
import { fields, string, timestamp, wire, uuid } from "./member-service.ts";
import { internalPath, publicApiKey, sessionResult, signupState, type MemberSessionPort, type SessionResult } from "./member-session.ts";

export interface WebSessionOptions {
  signupUrl: string;
  supabaseUrl: string;
  publicApiKey: string;
  callbackUrl: string;
  browser: Pick<Window, "location" | "history" | "sessionStorage" | "crypto">;
  fetcher?: typeof fetch;
  now?: () => number;
}
/** Web only. Native callback is a separate approved contract, never a spoofed browser Origin. */
export function createWebMemberSessionPort(options: WebSessionOptions): MemberSessionPort {
  publicApiKey(options.publicApiKey);
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
    if (now() < expiresAt) return active.accessToken;
    if (refreshing) return refreshing;
    const currentGeneration = generation;
    refreshing = (async () => {
      const result = wire(await authFetch("/token?grant_type=refresh_token", { refresh_token: refreshToken }, null));
      if (generation !== currentGeneration || !active) return null;
      const user = wire(result.user);
      if (user.id !== active.userId || !Number.isSafeInteger(result.expires_in) || (result.expires_in as number) <= 0) throw new ApiError(502, "INVALID_SESSION_RESPONSE");
      active = sessionResult({ ...active, accessToken: string(result.access_token) });
      refreshToken = string(result.refresh_token); expiresAt = now() + (result.expires_in as number) * 1000;
      return active.accessToken;
    })().catch(error => { if (generation === currentGeneration) { active = null; refreshToken = null; generation++; } throw error; }).finally(() => { refreshing = null; });
    return refreshing;
  }
  return {
    accessToken: getAccessToken,
    async login(returnTo, signal) {
      internalPath(returnTo);
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
      active = null; refreshToken = null; expiresAt = 0; generation++;
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
}
