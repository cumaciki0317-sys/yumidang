import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../../apps/mobile/src/api.ts";
import { createWebMemberSessionPort, discardWebMemberSession, subscribeWebMemberSessionDiscard } from "../../../apps/mobile/src/web-member-session.ts";
import { deferred, otherWithdrawal, secondUser, setupRetirement, signal, withdrawal } from "./mobile_retirement_fixture.ts";
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
test("기본 미설치는 retire 없음·승인 literal/HTTPS origin/path 변조 거절", () => {
  const s = setupRetirement({ enabled: false }); assert.equal(s.port.retire, undefined);
  for (const change of [{ retirementContract: "unknown" }, { supabaseUrl: "http://project.example" }, { signupUrl: "https://evil.example/functions/v1/signup" }, { signupUrl: "https://project.example/functions/v1/signup?raw=1" }]) assert.throws(() => createWebMemberSessionPort({ ...s.configuration, ...change } as any));
});
test("최초 POST는 원 회원 JWT·같은 origin 실제 service-api와 canonical ID만", async () => {
  const s = setupRetirement(); await s.login();
  assert.deepEqual(await s.port.retire!(withdrawal.toUpperCase(), signal()), { withdrawalId: withdrawal, status: "processing", memberAccessRevoked: true });
  const call = s.retirementCalls()[0]; assert.equal(call.url, "https://project.example/functions/v1/service-api/me/retirement"); assert.equal(call.method, "POST"); assert.deepEqual(call.body, { withdrawalId: withdrawal }); assert.equal(call.headers.get("authorization"), "Bearer " + s.originalToken()); assert.equal(call.headers.has("Origin"), false);
  assert.equal(await s.port.accessToken!(), null); assert.equal(await s.port.restore(signal()), null); assert.equal(s.data.size, 0);
});
test("응답 유실은 자동 재전송0·새 ID0·같은 ID/원 JWT 수동 조회와 완료 재생", async () => {
  const s = setupRetirement(); await s.login(); const original = s.originalToken();
  s.setRetirement(async () => { throw new Error("SYNTHETIC_RESPONSE_LOST"); });
  await assert.rejects(s.port.retire!(withdrawal, signal()), code("SERVICE_UNAVAILABLE")); assert.equal(s.retirementCalls().length, 1); assert.equal(await s.port.accessToken!(), original);
  await assert.rejects(s.port.retire!(otherWithdrawal, signal()), code("RETIREMENT_REQUEST_CHANGED")); assert.equal(s.retirementCalls().length, 1);
  s.setRetirement(async body => Response.json({ data: { ...body, status: "processing", memberAccessRevoked: true } })); assert.equal((await s.port.retire!(withdrawal, signal()) as any).status, "processing");
  s.setRetirement(async body => Response.json({ data: { ...body, status: "completed", memberAccessRevoked: true } }));
  assert.equal((await s.port.retire!(withdrawal, signal()) as any).status, "completed"); assert.equal((await s.port.retire!(withdrawal, signal()) as any).status, "completed");
  assert.equal(s.retirementCalls().length, 4); assert.ok(s.retirementCalls().every(c => c.body.withdrawalId === withdrawal && c.headers.get("authorization") === "Bearer " + original)); assert.equal(s.calls.filter(c => c.url.includes("/token?")).length, 0); assert.equal(s.data.size, 0);
});
test("틀린 ID·상태·회수 여부·추가 필드 영수증은 정상 세션을 지우지 않음", async () => {
  for (const bad of [{ withdrawalId: otherWithdrawal, status: "processing", memberAccessRevoked: true }, { withdrawalId: withdrawal, status: "queued", memberAccessRevoked: true }, { withdrawalId: withdrawal, status: "processing", memberAccessRevoked: false }, { withdrawalId: withdrawal, status: "completed", memberAccessRevoked: true, privateProfile: "forbidden" }]) {
    const s = setupRetirement(); await s.login(); s.setRetirement(async () => Response.json({ data: bad })); await assert.rejects(s.port.retire!(withdrawal, signal()), code("INVALID_SERVICE_RESPONSE")); assert.equal(await s.port.accessToken!(), s.originalToken()); assert.equal(s.retirementCalls().length, 1);
  }
});
test("원 JWT 만료 후 같은 ID도 닫힘·refresh/새 요청0", async () => {
  const s = setupRetirement(); await s.login(); s.setRetirement(async () => { throw new Error("SYNTHETIC_RESPONSE_LOST"); }); await assert.rejects(s.port.retire!(withdrawal, signal())); s.advance();
  await assert.rejects(s.port.retire!(withdrawal, signal()), code("RETIREMENT_TOKEN_EXPIRED")); assert.equal(await s.port.accessToken!(), null); assert.equal(s.retirementCalls().length, 1); assert.equal(s.calls.filter(c => c.url.includes("/token?")).length, 0);
});
test("미서명/다른 UID/익명·service JWT/만료 JWT는 최초 POST0", async () => {
  for (const options of [{ token: "opaque" }, { alg: "none" }, { claims: { sub: secondUser } }, { claims: { role: "service_role" } }, { claims: { is_anonymous: true } }, { claims: { exp: 1 } }, { expiresIn: 1 }]) {
    const s = setupRetirement(options); await s.login(); if (options.expiresIn) s.advance(1001); await assert.rejects(s.port.retire!(withdrawal, signal()), code("AUTH_REQUIRED")); assert.equal(s.retirementCalls().length, 0);
  }
});
test("로그아웃·새 사용자 로그인은 원 token/영수증 폐기·옛 ID를 새 user로 전송0", async () => {
  const s = setupRetirement(); await s.login(); await s.port.retire!(withdrawal, signal()); await s.port.logout(signal()); await s.login(secondUser);
  await assert.rejects(s.port.retire!(withdrawal, signal()), code("SESSION_CHANGED")); assert.equal(s.retirementCalls().length, 1); await s.port.retire!(otherWithdrawal, signal()); assert.equal(s.retirementCalls()[1].headers.get("authorization"), "Bearer " + s.originalToken()); assert.deepEqual(s.retirementCalls()[1].body, { withdrawalId: otherWithdrawal });
});
test("대기 HTTP 중 새 로그인 응답은 옛 영수증을 적용하지 않고 새 세션 유지", async () => {
  const s = setupRetirement(); await s.login(); const response = deferred<Response>(), sent = deferred<void>(); s.setRetirement(async () => { sent.resolve(); return response.promise; });
  const pending = s.port.retire!(withdrawal, signal()); await sent.promise; await s.login(secondUser); const current = s.originalToken(); response.resolve(Response.json({ data: { withdrawalId: withdrawal, status: "completed", memberAccessRevoked: true } }));
  await assert.rejects(pending, code("SESSION_CHANGED")); assert.equal(await s.port.accessToken!(), current); await assert.rejects(s.port.retire!(withdrawal, signal()), code("SESSION_CHANGED")); assert.equal(s.retirementCalls().length, 1);
});
test("동시 같은 ID는 HTTP 한 번·포트 폐기 뒤 늦은 응답 버림", async () => {
  const s = setupRetirement(); await s.login(); const response = deferred<Response>(), sent = deferred<void>(); s.setRetirement(async () => { sent.resolve(); return response.promise; });
  const pending = s.port.retire!(withdrawal, signal()); await sent.promise; await assert.rejects(s.port.retire!(withdrawal, signal()), code("RETIREMENT_IN_PROGRESS")); discardWebMemberSession(s.port);
  response.resolve(Response.json({ data: { withdrawalId: withdrawal, status: "completed", memberAccessRevoked: true } })); await assert.rejects(pending, code("SESSION_CHANGED")); assert.equal(await s.port.accessToken!(), null); assert.equal(s.retirementCalls().length, 1);
});
test("전송 전 logout 세대 변경은 옛 retire HTTP0", async () => {
  const s = setupRetirement(); await s.login(); const pending = s.port.retire!(withdrawal, signal()); await s.port.logout(signal()); await assert.rejects(pending); assert.equal(s.retirementCalls().length, 0);
});
test("취소는 자동 재전송0·같은 ID 수동 조회만 허용", async () => {
  const s = setupRetirement(); await s.login(); const controller = new AbortController(); controller.abort(); await assert.rejects(s.port.retire!(withdrawal, controller.signal), code("CANCELLED")); assert.equal(s.retirementCalls().length, 0); await assert.rejects(s.port.retire!(otherWithdrawal, signal()), code("RETIREMENT_REQUEST_CHANGED")); await s.port.retire!(withdrawal, signal()); assert.equal(s.retirementCalls().length, 1);
});
test("완료 영수증은 processing으로 되돌리지 않으며 정상 권한 되살림0", async () => {
  const s = setupRetirement(); await s.login(); s.setRetirement(async body => Response.json({ data: { ...body, status: "completed", memberAccessRevoked: true } })); await s.port.retire!(withdrawal, signal()); s.setRetirement(async body => Response.json({ data: { ...body, status: "processing", memberAccessRevoked: true } })); await assert.rejects(s.port.retire!(withdrawal, signal()), code("INVALID_SERVICE_RESPONSE")); assert.equal(await s.port.accessToken!(), null);
});
test("새 로그인/포트 폐기 알림은 비밀 없는 신호이며 구독 해제 가능", async () => {
  const s = setupRetirement(); let count = 0; const stop = subscribeWebMemberSessionDiscard(s.port, () => { count++; }); await s.login(); assert.equal(count, 1); discardWebMemberSession(s.port); assert.equal(count, 2); stop(); discardWebMemberSession(s.port); assert.equal(count, 2);
});
test("새 로그인은 이전 대기 refresh를 승계하지 않고 늦은 토큰으로 권한 되살림0", async () => {
  const s = setupRetirement(); await s.login(); const oldToken = s.originalToken(), response = deferred<Response>(), sent = deferred<void>();
  s.setRefresh(async () => { sent.resolve(); return response.promise; }); s.advance(); const refreshing = s.port.accessToken!(); await sent.promise;
  await s.login(secondUser); const current = s.originalToken(); await s.port.retire!(otherWithdrawal, signal()); assert.equal(s.retirementCalls()[0].headers.get("authorization"), "Bearer " + current);
  response.resolve(Response.json({ access_token: oldToken, refresh_token: "synthetic_refresh", expires_in: 3600, user: { id: "11111111-1111-4111-8111-111111111111" } }));
  assert.equal(await refreshing, null); assert.equal(await s.port.accessToken!(), null); assert.equal(s.retirementCalls().length, 1);
});
test("전송 중 원 토큰 만료는 늦은 성공을 완료로 적용하지 않고 재전송0", async () => {
  const s = setupRetirement(); await s.login(); const response = deferred<Response>(), sent = deferred<void>(); s.setRetirement(async () => { sent.resolve(); return response.promise; });
  const pending = s.port.retire!(withdrawal, signal()); await sent.promise; s.advance(); response.resolve(Response.json({ data: { withdrawalId: withdrawal, status: "completed", memberAccessRevoked: true } }));
  await assert.rejects(pending, code("RETIREMENT_TOKEN_EXPIRED")); assert.equal(s.retirementCalls().length, 1); assert.equal(await s.port.accessToken!(), null); assert.equal(s.calls.filter(c => c.url.includes("/token?")).length, 0);
});
test("폐기된 포트의 이전 로그인 callback은 pending verifier를 재사용해 권한 되살림0", async () => {
  const s = setupRetirement(); await s.port.login("/account", signal()); assert.equal(s.data.size, 1); discardWebMemberSession(s.port); assert.equal(s.data.size, 0);
  await assert.rejects(s.port.callback!("https://app.example/auth-callback?code=synthetic&state=" + "a".repeat(64), signal()), code("INVALID_LOGIN_CALLBACK"));
  assert.equal(s.calls.filter(c => c.url.endsWith("/naver/callback")).length, 0); assert.equal(await s.port.accessToken!(), null);
});
