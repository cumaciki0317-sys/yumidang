import assert from "node:assert/strict";
import test from "node:test";
import { createWebMemberSessionPort } from "../../../apps/mobile/src/web-member-session.ts";
const user = "11111111-1111-4111-8111-111111111111", state = "a".repeat(64);
function setup(options: { callback?: unknown; redirect?: string; expire?: number; signupState?: () => unknown | Promise<unknown>; retirement?: boolean } = {}) {
  let now = Date.parse("2026-10-05T00:00:00Z"), navigation = "", cleaned = "";
  const data = new Map<string,string>(); const calls: { url: string; body: unknown; headers: unknown }[] = [];
  const browser = { crypto: globalThis.crypto, location: { origin: "https://app.example", assign: (url: string) => { navigation = url; } }, history: { replaceState: (_: unknown, __: string, url: string) => { cleaned = url; } }, sessionStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } } as unknown as Pick<Window,"location"|"history"|"sessionStorage"|"crypto">;
  const port = createWebMemberSessionPort({ signupUrl: "https://project.example/functions/v1/signup", supabaseUrl: "https://project.example", publicApiKey: "sb_publishable_test", callbackUrl: "https://app.example/auth-callback", browser, ...(options.retirement ? { retirementContract: "2026-10-09-retirement-receipt" as const } : {}), now: () => now, fetcher: async (url, init) => {
    const path = String(url); calls.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : null, headers: init?.headers });
    if (path.endsWith("/naver/start")) return Response.json({ data: { authorizationUrl: options.redirect ?? `https://nid.naver.com/oauth2.0/authorize?state=${state}&redirect_uri=${encodeURIComponent("https://app.example/auth-callback")}`, expiresAt: "2026-10-05T00:10:00Z" } });
    if (path.endsWith("/naver/callback")) return Response.json({ data: options.callback ?? { status: "photo_required", userId: user, returnTo: "/post?id=1", session: { accessToken: "verified-access", refreshToken: "refresh", expiresIn: options.expire ?? 3600, tokenType: "bearer" } } });
    if (path.includes("/token?")) return Response.json({ access_token: "refreshed-access", refresh_token: "refreshed-refresh", expires_in: 3600, user: { id: user } });
    if (path.includes("/logout?")) return new Response(null, { status: 204 });
    if (path.includes("/me/retirement")) return Response.json({ error: { code: "SYNTHETIC_UNAVAILABLE" } }, { status: 503 });
    return Response.json({ data: options.signupState ? await options.signupState() : { status: "photo_required", avatarPath: null, interests: [], conversationStyles: [], mbti: null } });
  } });
  return { port, calls, data, navigation: () => navigation, cleaned: () => cleaned, advance: () => { now += 3600_000; } };
}
test("웹 start는실제서버 challenge와 state별 verifier만탭저장하고 token없음", async () => {
  const s = setup(); assert.equal(await s.port.login("/post?id=1", new AbortController().signal), null);
  assert.match((s.calls[0].body as {codeChallenge:string}).codeChallenge, /^[a-f0-9]{64}$/);
  assert.match(s.navigation(), /^https:\/\/nid\.naver\.com\//);
  assert.equal(Object.keys(s.calls[0].headers as object).includes("Origin"), false);
  assert.equal(Array.from(s.data.values()).some(v => v.includes("accessToken")), false);
});
test("callback은 state를확인하고쿼리와verifier폐기후서버세션을설치", async () => {
  const s = setup(); await s.port.login("/post?id=1", new AbortController().signal);
  const result = await s.port.callback!(`https://app.example/auth-callback?code=naver-code&state=${state}`, new AbortController().signal);
  assert.equal(result.userId, user); assert.equal(result.status, "photo_required"); assert.equal(s.cleaned(), "/auth-callback"); assert.equal(s.data.size, 0);
  assert.equal(await s.port.accessToken!(), "verified-access");
  assert.equal((s.calls[1].body as {code:string}).code, "naver-code");
});
test("상태불일치callback은서버교환없이거절하고재사용불가", async () => {
  const s = setup(); await s.port.login("/", new AbortController().signal);
  await assert.rejects(s.port.callback!(`https://app.example/auth-callback?code=x&state=${"b".repeat(64)}`, new AbortController().signal));
  assert.equal(s.calls.length, 1); assert.equal(s.data.size, 0);
});
test("토큰없는부적격/정보누락 응답은세션을생성하지않음", async () => {
  for (const status of ["ineligible", "information_required"]) {
    const s = setup({ callback: { status, returnTo: "/", userId: null, session: null } });
    await s.port.login("/", new AbortController().signal);
    await assert.rejects(s.port.callback!(`https://app.example/auth-callback?code=x&state=${state}`, new AbortController().signal)); assert.equal(await s.port.accessToken!(), null);
  }
});
test("refresh동시요청은한번, 동일서버UID확인,logoutlocal뒤메모리비움", async () => {
  const s = setup(); await s.port.login("/", new AbortController().signal); await s.port.callback!(`https://app.example/auth-callback?code=x&state=${state}`, new AbortController().signal);
  s.advance(); assert.deepEqual(await Promise.all([s.port.accessToken!(), s.port.accessToken!()]), ["refreshed-access", "refreshed-access"]);
  const refresh = s.calls.filter(c => c.url.includes("/token?")); assert.equal(refresh.length, 1); assert.deepEqual(refresh[0].body, { refresh_token: "refresh" });
  await s.port.logout(new AbortController().signal); assert.equal(await s.port.accessToken!(), null); assert.match(s.calls.at(-1)!.url, /\/logout\?scope=local$/);
});
test("공식네이버외부호스트·다른callback·다른signup origin구성거절", async () => {
  const s = setup({ redirect: "https://evil.example/authorize" }); await assert.rejects(s.port.login("/", new AbortController().signal));
  assert.throws(() => createWebMemberSessionPort({ signupUrl: "https://evil.example/functions/v1/signup", supabaseUrl: "https://project.example", publicApiKey: "public", callbackUrl: "https://app.example/auth-callback", browser: { location: { origin: "https://app.example" } } as any }));
});
test("무한/비정수 세션기간은서버성공으로수용하지않음", async () => {
  const s = setup({ expire: 1.5 }); await s.port.login("/", new AbortController().signal);
  await assert.rejects(s.port.callback!(`https://app.example/auth-callback?code=x&state=${state}`, new AbortController().signal));
});

const readyState = () => ({ status: "ready", avatarPath: null, interests: [], conversationStyles: [], mbti: null });
test("가입 재조회 ready는 포트 내부의 기존 검증 세션에도 반영한다", async () => {
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encoded({ alg: "HS256" })}.${encoded({ sub: user, role: "authenticated", exp: Date.parse("2026-10-05T01:00:00Z") / 1000 })}.synthetic`;
  const s = setup({ retirement: true, signupState: readyState, callback: { status: "photo_required", userId: user, returnTo: "/", session: { accessToken: token, refreshToken: "refresh", expiresIn: 3600, tokenType: "bearer" } } });
  await s.port.login("/", new AbortController().signal);
  await s.port.callback!(`https://app.example/auth-callback?code=x&state=${state}`, new AbortController().signal);
  assert.equal((await s.port.signupState(new AbortController().signal)).status, "ready");
  await assert.rejects(s.port.retire!("22222222-2222-4222-8222-222222222222", new AbortController().signal), (error: any) => error.status === 503);
  assert.equal(s.calls.filter(call => call.url.includes("/me/retirement")).length, 1);
});

test("로그아웃 뒤 도착한 가입 상태는 폐기하며 기존 권한을 복원하지 않는다", async () => {
  let resolve!: (value: unknown) => void;
  const waiting = new Promise<unknown>(yes => { resolve = yes; });
  const s = setup({ signupState: () => waiting });
  await s.port.login("/", new AbortController().signal);
  await s.port.callback!(`https://app.example/auth-callback?code=x&state=${state}`, new AbortController().signal);
  const request = s.port.signupState(new AbortController().signal);
  await new Promise<void>(yes => setImmediate(yes));
  await s.port.logout(new AbortController().signal);
  resolve(readyState());
  await assert.rejects(request, (error: any) => error.code === "SESSION_CHANGED");
  assert.equal(await s.port.accessToken!(), null);
});
