/** 실제 키·외부 호출 없이 네이버 요청 경계와 실패 처리를 검증한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { loadNaverConfig } from "../../../backend/supabase/functions/_shared/config/naver.ts";
import { createNaverIdentityAdapter } from "../../../backend/supabase/functions/_shared/integrations/identity/adapter.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";

const env: Record<string, string | undefined> = {
  NAVER_CLIENT_ID: "fixture-client", NAVER_CLIENT_SECRET: "fixture-private-secret",
  NAVER_REDIRECT_URI: "https://frontend.example.invalid/auth/naver",
  NAVER_STATE_TTL_SECONDS: "300", UPSTREAM_TIMEOUT_MS: "100",
};
const config = (patch: Record<string, string | undefined> = {}) => {
  const values = { ...env, ...patch };
  return loadNaverConfig((key) => values[key], ["https://frontend.example.invalid", "http://localhost:3000", "http://127.0.0.1:3000"]);
};
const safe = (code: string) => (error: unknown) => {
  assert.equal(toPublicError(error).error.code, code);
  assert.doesNotMatch(String(error) + JSON.stringify(toPublicError(error)), /fixture-private|fixture-token|external-raw|fixture-code/);
  assert.equal((error as Error).cause, undefined);
  return true;
};
const token = { access_token: "fixture-token+/=", token_type: "bearer", expires_in: "3600", refresh_token: "fixture-private-refresh" };
const profile = (fields: Record<string, unknown>) => ({ resultcode: "00", response: { id: "fixture-subject", ...fields } });
function fake(...responses: Response[]): typeof fetch {
  return (async () => { const response = responses.shift(); assert.ok(response); return response; }) as typeof fetch;
}
const adapterFor = (fields: Record<string, unknown>) => createNaverIdentityAdapter(config(), fake(Response.json(token), Response.json(profile(fields))));

test("필수 설정·명시된 TTL·기술상한 검사와 비밀 직렬화 보호", () => {
  const settings = config();
  assert.equal(settings.clientSecret, "fixture-private-secret");
  assert.equal(settings.stateTtlSeconds, 300);
  assert.ok(Object.isFrozen(settings));
  assert.deepEqual(Object.keys(settings), []);
  assert.deepEqual({ ...settings }, {});
  assert.deepEqual(JSON.parse(JSON.stringify(settings)), { provider: "naver", configured: true });
  assert.doesNotMatch(inspect(settings) + inspect({ settings }), /fixture-private/);
  for (const key of Object.keys(env)) {
    for (const value of [undefined, "", " x", "x ", "x\0", "x\u0085"]) assert.throws(() => config({ [key]: value }), safe("EXTERNAL_UNAVAILABLE"));
  }
  for (const value of ["0", "01", "1e2", "1.5", "3601", "9007199254740992"]) {
    assert.throws(() => config({ NAVER_STATE_TTL_SECONDS: value }), safe("EXTERNAL_UNAVAILABLE"));
  }
  assert.throws(() => config({ UPSTREAM_TIMEOUT_MS: "2147483648" }), safe("EXTERNAL_UNAVAILABLE"));
  assert.throws(() => loadNaverConfig(() => { throw new Error("external-raw fixture-private-secret"); }, []), safe("EXTERNAL_UNAVAILABLE"));
});

test("콜백은 허용 origin·정확 URL·HTTPS 또는 명시된 로컬 HTTP만 허용", () => {
  for (const redirect of ["http://localhost:3000/auth/naver", "http://127.0.0.1:3000/auth/naver"]) assert.equal(config({ NAVER_REDIRECT_URI: redirect }).redirectUri, redirect);
  for (const redirect of [
    "https://evil.example.invalid/auth/naver", "http://frontend.example.invalid/auth/naver",
    "https://user:fixture-private-secret@frontend.example.invalid/auth/naver",
    "https://frontend.example.invalid/auth/naver?code=x", "https://frontend.example.invalid/auth/naver?",
    "https://frontend.example.invalid/auth/naver#", "https://frontend.example.invalid/a/../auth/naver",
    "https://frontend.example.invalid\\auth/naver", "https://frontend.example.invalid:443/auth/naver",
    "javascript:alert(1)", "//frontend.example.invalid/auth/naver",
  ]) assert.throws(() => config({ NAVER_REDIRECT_URI: redirect }), safe("EXTERNAL_UNAVAILABLE"));
});

test("인증 URL·토큰 POST·프로필 Bearer 요청은 공식 고정 endpoint만 사용", async () => {
  let call = 0;
  const provider = createNaverIdentityAdapter(config(), (async (url, init) => {
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    if (call++ === 0) {
      assert.equal(url, "https://nid.naver.com/oauth2.0/token");
      assert.equal(init?.method, "POST");
      assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
      assert.doesNotMatch(String(url), /fixture-private|fixture-code/);
      const form = new URLSearchParams(init?.body as URLSearchParams);
      assert.equal(form.get("client_secret"), "fixture-private-secret");
      assert.equal(form.get("code"), "fixture-code+&");
      assert.equal(form.get("state"), "state+&");
      assert.equal(form.get("redirect_uri"), env.NAVER_REDIRECT_URI);
      return Response.json(token);
    }
    assert.equal(url, "https://openapi.naver.com/v1/nid/me");
    assert.equal(init?.method, "GET");
    assert.equal(headers.get("authorization"), "Bearer fixture-token+/=");
    return Response.json(profile({ name: "민규", gender: "F", birthyear: "2000", birthday: "02-29", email: "ignored@example.invalid" }));
  }) as typeof fetch);
  const authorize = new URL(provider.authorizationUrl("state+&"));
  assert.equal(authorize.origin + authorize.pathname, "https://nid.naver.com/oauth2.0/authorize");
  assert.equal(authorize.searchParams.get("state"), "state+&");
  assert.equal(authorize.searchParams.get("redirect_uri"), env.NAVER_REDIRECT_URI);
  assert.doesNotMatch(authorize.href, /fixture-private/);
  assert.deepEqual(await provider.exchange("fixture-code+&", "state+&"), { subject: "fixture-subject", name: "민규", gender: "F", birthDate: "2000-02-29" });
  assert.equal(call, 2);
});

test("누락 정보는 null로 보존하고 달력 날짜만 변환하며 나이·가입 자격은 판정하지 않는다", async () => {
  assert.deepEqual(await adapterFor({}).exchange("code", "state"), { subject: "fixture-subject", name: null, gender: null, birthDate: null });
  for (const [year, birthday, expected] of [
    ["1900", "02-29", null], ["2000", "02-29", "2000-02-29"], ["2004", "04-31", null],
    ["2004", "12-31", "2004-12-31"], ["2026", "10-02", "2026-10-02"],
    ["0000", "01-01", null], ["2000", "13-01", null], ["2000", "00-01", null],
    ["2000", "01-00", null], [2000, "01-01", null], ["2000", "1-01", null],
  ]) {
    assert.equal((await adapterFor({ birthyear: year, birthday, gender: "U", name: " " }).exchange("code", "state")).birthDate, expected);
  }
  assert.equal((await adapterFor({ gender: "unknown", name: "민\0규" }).exchange("code", "state")).gender, null);
});

test("잘못된 응답·id·토큰·리다이렉트는 외부 원문 없이 503", async () => {
  for (const response of [
    Response.json([]), Response.json({ ...token, access_token: "fixture-token\r\nsecret" }),
    Response.json({ ...token, token_type: "MAC" }), Response.json({ error: "server_error", error_description: "external-raw" }),
    new Response("external-raw"), new Response(null, { status: 302, headers: { location: "https://evil.example.invalid" } }),
    Response.json({ padding: "x".repeat(65537) }),
  ]) await assert.rejects(createNaverIdentityAdapter(config(), fake(response)).exchange("code", "state"), safe("EXTERNAL_UNAVAILABLE"));
  for (const value of [null, {}, "", " ", "bad\0id", "x".repeat(256)]) {
    await assert.rejects(adapterFor({ id: value }).exchange("code", "state"), safe("EXTERNAL_UNAVAILABLE"));
  }
  await assert.rejects(createNaverIdentityAdapter(config(), fake(Response.json(token), Response.json({ resultcode: "99", message: "external-raw" }))).exchange("code", "state"), safe("EXTERNAL_UNAVAILABLE"));
  await assert.rejects(createNaverIdentityAdapter(config(), (async () => { throw new Error("external-raw fixture-token"); }) as typeof fetch).exchange("code", "state"), safe("EXTERNAL_UNAVAILABLE"));
});

test("요청 오류·인증 실패는 안전한 공개 코드로 변환하고 invalid input은 외부 호출하지 않는다", async () => {
  for (const [error, expected] of [["invalid_request", "INVALID_REQUEST"], ["invalid_grant", "AUTH_REQUIRED"], ["unauthorized_client", "AUTH_REQUIRED"]]) {
    await assert.rejects(createNaverIdentityAdapter(config(), fake(Response.json({ error, error_description: "external-raw fixture-private-secret" }, { status: 400 }))).exchange("code", "state"), safe(expected));
  }
  await assert.rejects(createNaverIdentityAdapter(config(), fake(Response.json(token), Response.json({ resultcode: "024" }, { status: 401 }))).exchange("code", "state"), safe("AUTH_REQUIRED"));
  const provider = createNaverIdentityAdapter(config(), (async () => { assert.fail("외부 호출 금지"); }) as typeof fetch);
  for (const value of ["", "bad\nstate", "x".repeat(4097)]) {
    assert.throws(() => provider.authorizationUrl(value), safe("INVALID_REQUEST"));
    await assert.rejects(provider.exchange(value, "state"), safe("INVALID_REQUEST"));
    await assert.rejects(provider.exchange("code", value), safe("INVALID_REQUEST"));
  }
});

test("응답 헤더 또는 body가 멈춰도 timeout·abort 후 안전한 503", async () => {
  let signal: AbortSignal | null | undefined;
  const settings = config({ UPSTREAM_TIMEOUT_MS: "10" });
  const never = createNaverIdentityAdapter(settings, ((_url, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  }) as typeof fetch);
  await assert.rejects(never.exchange("code", "state"), safe("EXTERNAL_UNAVAILABLE"));
  assert.equal(signal?.aborted, true);
  const stalled = createNaverIdentityAdapter(settings, fake(new Response(new ReadableStream({ start() {} }))));
  await assert.rejects(stalled.exchange("code", "state"), safe("EXTERNAL_UNAVAILABLE"));
});
