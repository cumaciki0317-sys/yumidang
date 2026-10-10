/** 메모리 Auth/HTTP 모형이다. 서명 검증·실회원·실제 모바일 UI 검증이 아니다. */
import { createWebMemberSessionPort, type WebSessionOptions } from "../../../apps/mobile/src/web-member-session.ts";
export const firstUser = "11111111-1111-4111-8111-111111111111", secondUser = "22222222-2222-4222-8222-222222222222";
export const withdrawal = "abcdefab-1111-4111-8111-111111111111", otherWithdrawal = "abcdefab-2222-4222-8222-222222222222";
export const signal = () => new AbortController().signal;
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
export function setupRetirement(options: { enabled?: boolean; token?: string; claims?: Record<string, unknown>; alg?: string; expiresIn?: number } = {}) {
  let now = Date.parse("2026-10-09T00:00:00Z"), userId = firstUser;
  const state = "a".repeat(64), data = new Map<string, string>(), calls: { url: string; method: string; body: any; headers: Headers; signal?: AbortSignal | null }[] = [];
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = () => options.token ?? encode({ alg: options.alg ?? "HS256", typ: "JWT" }) + "." + encode({ sub: userId, role: "authenticated", exp: Math.floor(now / 1000) + 3600, ...options.claims }) + ".synthetic_signature";
  let originalToken = "";
  let refresh: () => Promise<Response> = async () => { throw new Error("UNEXPECTED_REFRESH"); };
  let retirement: (body: { withdrawalId: string }) => Promise<Response> = async body => Response.json({ data: { ...body, status: "processing", memberAccessRevoked: true }, requestId: "synthetic" });
  const browser = { crypto: globalThis.crypto, location: { origin: "https://app.example", assign() {} }, history: { replaceState() {} }, sessionStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } } as unknown as WebSessionOptions["browser"];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: path, method: init?.method ?? "GET", body, headers: new Headers(init?.headers), signal: init?.signal });
    if (path.endsWith("/me/retirement")) return retirement(body);
    if (path.endsWith("/naver/start")) return Response.json({ data: { authorizationUrl: `https://nid.naver.com/oauth2.0/authorize?state=${state}&redirect_uri=${encodeURIComponent("https://app.example/auth-callback")}`, expiresAt: new Date(now + 600_000).toISOString() } });
    if (path.endsWith("/naver/callback")) { originalToken = token(); return Response.json({ data: { status: "ready", userId, returnTo: "/account", session: { accessToken: originalToken, refreshToken: "synthetic_refresh", expiresIn: options.expiresIn ?? 3600, tokenType: "bearer" } } }); }
    if (path.includes("/logout?")) return new Response(null, { status: 204 });
    if (path.includes("/token?")) return refresh();
    return Response.json({ data: { status: "ready", avatarPath: null, interests: [], conversationStyles: [], mbti: null } });
  };
  const configuration: WebSessionOptions = { signupUrl: "https://project.example/functions/v1/signup", supabaseUrl: "https://project.example", publicApiKey: "sb_publishable_synthetic", callbackUrl: "https://app.example/auth-callback", browser, fetcher, now: () => now, ...(options.enabled === false ? {} : { retirementContract: "2026-10-09-retirement-receipt" }) };
  const port = createWebMemberSessionPort(configuration);
  return { port, configuration, calls, data, originalToken: () => originalToken,
    retirementCalls: () => calls.filter(c => c.url.endsWith("/me/retirement")),
    setRetirement: (run: typeof retirement) => { retirement = run; }, setRefresh: (run: typeof refresh) => { refresh = run; }, advance: (ms = 3_600_001) => { now += ms; },
    login: async (nextUser = userId) => { userId = nextUser; await port.login("/account", signal()); return port.callback!(`https://app.example/auth-callback?code=synthetic&state=${state}`, signal()); } };
}
