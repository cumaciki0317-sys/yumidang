/** 민규: 가상 Auth 응답으로 세션 연결 경계를 검증한다. 실제 계정·네이버 호출은 하지 않는다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNaverSessionBridge } from "../../../backend/supabase/functions/_shared/auth/session-bridge.ts";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";

const values: Record<string, string> = {
  SUPABASE_URL: "https://auth.example.invalid", SUPABASE_ANON_KEY: "fixture-anon",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service", ALLOWED_ORIGINS: "[]",
  UPSTREAM_TIMEOUT_MS: "1000", MAX_REQUEST_BYTES: "8192",
};
const config = loadRuntimeConfig((name) => values[name]);
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const authEmail = "cccccccc-cccc-4ccc-8ccc-cccccccccccc@naver.yumidang.invalid";
const hash = "0123456789abcdef".repeat(4);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: Record<string, unknown> = {}, alg = "HS256") =>
  `${encode({ alg, typ: "JWT" })}.${encode({ session_id: sessionId, sub: userId, role: "authenticated", ...claims })}.c2lnbmF0dXJl`;
const link = (verification_type = "magiclink") => ({ id: userId, email: authEmail, hashed_token: hash, verification_type });
const session = () => ({ access_token: jwt(), refresh_token: "fixture-refresh", token_type: "bearer", expires_in: 3600,
  user: { id: userId, email: authEmail, role: "authenticated", is_anonymous: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const safeUnavailable = (error: unknown) => {
  assert.equal(toPublicError(error).error.code, "EXTERNAL_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(toPublicError(error)), /fixture-|private|sensitive|0123456789abcdef|naver\.yumidang/);
  return true;
};

for (const verificationType of ["signup", "magiclink"]) {
  test(`${verificationType}: 평면 Auth 응답, 자격 증명 분리, 고정 URL·POST를 사용한다`, async () => {
    const calls: string[] = [];
    const bridge = createNaverSessionBridge(config, async (url, init) => {
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("content-type"), "application/json");
      calls.push(String(url));
      if (calls.length === 1) {
        assert.equal(url, `${config.supabaseUrl}/auth/v1/admin/generate_link`);
        assert.equal(headers.get("apikey"), "fixture-service");
        assert.equal(headers.get("authorization"), "Bearer fixture-service");
        assert.deepEqual(JSON.parse(String(init?.body)), { type: "magiclink", email: authEmail });
        return json(link(verificationType));
      }
      assert.equal(url, `${config.supabaseUrl}/auth/v1/verify`);
      assert.equal(headers.get("apikey"), "fixture-anon");
      assert.equal(headers.get("authorization"), "Bearer fixture-anon");
      assert.deepEqual(JSON.parse(String(init?.body)), { type: verificationType, token_hash: hash });
      assert.doesNotMatch(JSON.stringify(init), /fixture-service/);
      return json(session());
    });
    assert.deepEqual(await bridge.issue(authEmail, verificationType === "signup" ? null : userId), {
      userId, sessionId, accessToken: jwt(), refreshToken: "fixture-refresh", expiresIn: 3600, tokenType: "bearer",
    });
    assert.equal(calls.length, 2);
  });
}

test("실제 이메일·비 UUID 별칭·예상 UID 오류는 Auth 네트워크 전에 거절한다", async () => {
  let calls = 0;
  const bridge = createNaverSessionBridge(config, async () => { calls++; return json(link()); });
  for (const email of ["person@naver.com", "member@naver.yumidang.invalid", authEmail.toUpperCase(), authEmail + "\n", "https://attacker.invalid"]) {
    await assert.rejects(bridge.issue(email, null), (error: unknown) => toPublicError(error).error.code === "INVALID_REQUEST");
  }
  for (const id of ["", "not-uuid", "00000000-0000-0000-0000-000000000000"]) {
    await assert.rejects(bridge.issue(authEmail, id), (error: unknown) => toPublicError(error).error.code === "INVALID_REQUEST");
  }
  assert.equal(calls, 0);
});

test("설정 누락·동일 키·안전하지 않은 Auth URL은 bridge 생성 단계에서 거절한다", () => {
  for (const override of [
    { supabaseServiceRoleKey: undefined }, { supabaseServiceRoleKey: config.supabaseAnonKey },
    { supabaseUrl: "http://attacker.invalid" }, { supabaseUrl: "https://auth.example.invalid/path" },
    { supabaseUrl: "https://service:secret@auth.example.invalid" }, { supabaseUrl: config.supabaseUrl + "?target=private" },
    { upstreamTimeoutMs: 0 },
  ]) assert.throws(() => createNaverSessionBridge({ ...config, ...override }), safeUnavailable);
});

test("계정 변경·비정상 generate_link 응답은 verify 전에 거절한다", async () => {
  for (const invalid of [null, [], { user: link(), properties: { hashed_token: hash } },
    { ...link(), id: sessionId }, { ...link(), email: "private@naver.com" },
    { ...link(), verification_type: "recovery" }, { ...link(), hashed_token: "" },
    { ...link(), hashed_token: "secret\nprivate" }, { ...link(), id: "00000000-0000-0000-0000-000000000000" },
  ]) {
    let calls = 0;
    const bridge = createNaverSessionBridge(config, async () => { calls++; return json(invalid); });
    await assert.rejects(bridge.issue(authEmail, userId), safeUnavailable);
    assert.equal(calls, 1);
  }
});

test("Auth 세션 사용자·권한·익명 여부·토큰 누락은 발급 결과로 반환하지 않는다", async () => {
  const good = session();
  for (const invalid of [null, [], { ...good, user: null },
    { ...good, user: { ...good.user, id: sessionId } }, { ...good, user: { ...good.user, email: "private@naver.com" } },
    { ...good, user: { ...good.user, role: "service_role" } }, { ...good, user: { ...good.user, is_anonymous: true } },
    { ...good, user: { ...good.user, is_anonymous: undefined } }, { ...good, token_type: "Basic" },
    { ...good, expires_in: 0 }, { ...good, expires_in: "3600" }, { ...good, expires_in: 1.5 },
    { ...good, refresh_token: "" }, { ...good, refresh_token: "private\nsecret" }, { ...good, access_token: "fixture-anon" },
  ]) {
    let calls = 0;
    const bridge = createNaverSessionBridge(config, async () => json(++calls === 1 ? link() : invalid));
    await assert.rejects(bridge.issue(authEmail, userId), safeUnavailable);
    assert.equal(calls, 2);
  }
});

test("JWT는 구조와 연결 claims만 확인하고 잘못된 session_id·sub·role·alg는 거절한다", async () => {
  for (const token of ["invalid", "e30.e30.c2ln", "_.__.sig", jwt().replace(/\.[^.]+$/, ".A"), jwt({ session_id: null }), jwt({ session_id: "" }),
    jwt({ session_id: "00000000-0000-0000-0000-000000000000" }), jwt({ sub: sessionId }), jwt({ role: "service_role" }), jwt({}, "none"),
  ]) {
    let calls = 0;
    const bridge = createNaverSessionBridge(config, async () => json(++calls === 1 ? link() : { ...session(), access_token: token }));
    await assert.rejects(bridge.issue(authEmail, null), safeUnavailable);
  }
  for (const alg of ["RS256", "ES256", "EdDSA"]) {
    let calls = 0;
    const bridge = createNaverSessionBridge(config, async () => json(++calls === 1 ? link() : { ...session(), access_token: jwt({}, alg) }));
    assert.equal((await bridge.issue(authEmail, null)).sessionId, sessionId);
  }
});

test("Auth 오류·redirect·네트워크·JSON 오류 원문과 키는 공개 오류에 포함하지 않는다", async () => {
  for (const stage of [1, 2]) {
    for (const status of [302, 400, 401, 403, 429, 500]) {
      let calls = 0;
      const bridge = createNaverSessionBridge(config, async () => ++calls === stage
        ? json({ message: "private fixture-service sensitive-token" }, status) : json(link()));
      await assert.rejects(bridge.issue(authEmail, null), safeUnavailable);
    }
  }
  for (const fetcher of [async () => { throw new Error("private fixture-service network"); },
    async () => new Response("sensitive-token private"),
  ]) await assert.rejects(createNaverSessionBridge(config, fetcher).issue(authEmail, null), safeUnavailable);
});

test("타임아웃은 abort하고 안전한 공개 오류로 변환한다", async () => {
  const bridge = createNaverSessionBridge({ ...config, upstreamTimeoutMs: 5 }, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("private fixture-service timed out")), { once: true });
  }));
  await assert.rejects(bridge.issue(authEmail, null), safeUnavailable);
});
