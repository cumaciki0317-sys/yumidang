/** React 구독만 메모리 대체한다. 실제 화면 렌더링/네이버/회원/HTTP 검증으로 집계하지 않는다. */
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError } from "../../../apps/mobile/src/api.ts";
import { deferred, otherWithdrawal, secondUser, setupRetirement, signal, withdrawal } from "./mobile_retirement_fixture.ts";
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "react") return { url: "data:text/javascript,export function useSyncExternalStore(subscribe,get){return get()}", shortCircuit: true };
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      if (!/\.[a-z]+$/i.test(url.pathname)) for (const suffix of [".ts", ".tsx"]) if (existsSync(fileURLToPath(url) + suffix)) return next(url.href + suffix, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith("/remote.tsx")) return { format: "module", source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8")), shortCircuit: true };
    return next(url, context);
  },
});
process.env.EXPO_PUBLIC_DATA_MODE = "service";
process.env.EXPO_PUBLIC_SERVICE_API_URL = "https://project.example/functions/v1/service-api";
// 설치 당시의 실제 ServiceApiClient 전송만 메모리 대체한다. 외부 HTTP는 허용하지 않는다.
const originalFetch = globalThis.fetch;
const readCalls: { url: string; body: unknown; headers: Headers }[] = [];
globalThis.fetch = async (url, init) => {
  const path = String(url);
  if (!path.match(/^https:\/\/project\.example\/functions\/v1\/service-api\/conversations\/[0-9a-f-]+\/read\/messages$/)) throw new Error("UNEXPECTED_TRANSPORT");
  const body = JSON.parse(String(init?.body));
  readCalls.push({ url: path, body, headers: new Headers(init?.headers) });
  return Response.json({ data: { messageIds: body.messageIds, unreadCount: 1 } });
};
const remote = await import("../../../apps/mobile/src/remote.tsx");
globalThis.fetch = originalFetch;
beforeEach(() => { remote.installMemberSessionPort(null); remote.installMemberSessionDetails(null); remote.installMessageReadPort(null); readCalls.length = 0; });
async function connect(options: Parameters<typeof setupRetirement>[0] = {}) { const s = setupRetirement(options); remote.installMemberSessionPort(s.port); remote.installMemberSessionDetails(await s.login()); return s; }
const errorCode = (expected: string) => (e: unknown) => e instanceof ApiError && e.code === expected;
test("미설치 port는 요청0·최소 store도 생성하지 않음", async () => {
  const s = await connect({ enabled: false }); await assert.rejects(remote.requestMemberRetirement(withdrawal), errorCode("RETIREMENT_NOT_CONFIGURED")); assert.equal(remote.memberRetirementSnapshot(), null); assert.equal(s.retirementCalls().length, 0);
});
test("응답 유실은 정상 세션 유지·같은 ID 수동 조회 뒤 processing/completed 분리", async () => {
  const s = await connect(); s.setRetirement(async () => { throw new Error("SYNTHETIC_RESPONSE_LOST"); }); await assert.rejects(remote.requestMemberRetirement(withdrawal));
  const lost = remote.memberRetirementSnapshot()!; assert.deepEqual(lost, { withdrawalId: withdrawal, receipt: null, busy: false, errorCode: "RETIREMENT_STATUS_UNCONFIRMED" }); assert.equal(await remote.serviceAccessToken(), s.originalToken());
  await assert.rejects(remote.requestMemberRetirement(otherWithdrawal), errorCode("RETIREMENT_REQUEST_CHANGED")); assert.equal(s.retirementCalls().length, 1);
  s.setRetirement(async body => Response.json({ data: { ...body, status: "processing", memberAccessRevoked: true } })); await remote.requestMemberRetirement(withdrawal); assert.equal(remote.memberRetirementSnapshot()!.receipt!.status, "processing"); assert.equal(await remote.serviceAccessToken(), null); assert.equal(remote.useMemberSessionDetails(), null);
  s.setRetirement(async body => Response.json({ data: { ...body, status: "completed", memberAccessRevoked: true } })); await remote.requestMemberRetirement(withdrawal); assert.equal(remote.memberRetirementSnapshot()!.receipt!.status, "completed"); assert.equal(s.retirementCalls().length, 3); assert.ok(s.retirementCalls().every(c => c.body.withdrawalId === withdrawal)); assert.equal(s.data.size, 0);
});
test("검증되지 않은 영수증은 권한 회수로 만들지 않고 UI에 원문/JWT/UID0", async () => {
  const s = await connect(); s.setRetirement(async () => Response.json({ data: { withdrawalId: withdrawal, status: "completed", memberAccessRevoked: false, private: "never-return" } })); await assert.rejects(remote.requestMemberRetirement(withdrawal)); assert.equal(await remote.serviceAccessToken(), s.originalToken());
  const serialized = JSON.stringify(remote.memberRetirementSnapshot()); assert.equal(serialized.includes(s.originalToken()), false); assert.equal(serialized.includes("never-return"), false); assert.equal(serialized.includes("11111111-1111-4111-8111-111111111111"), false); assert.equal(remote.memberRetirementSnapshot()!.receipt, null);
});
test("확인된 최소 영수증은 일반 세션 밖에서 보존·수정해도 내부 상태 불변", async () => {
  const s = await connect(); const result = await remote.requestMemberRetirement(withdrawal); result.status = "completed"; const snapshot = remote.useMemberRetirement()!;
  assert.equal(snapshot.receipt!.status, "processing"); assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(snapshot.receipt), true); assert.equal(remote.useServiceSession().authenticated, false); assert.equal(await remote.serviceAccessToken(), null); assert.equal(await s.port.restore(signal()), null); assert.equal(s.retirementCalls().length, 1);
});
test("처리 중 중복 요청은 전송 한 번이며 완료 전 성공 영수증 없음", async () => {
  const s = await connect(), response = deferred<Response>(), sent = deferred<void>(); s.setRetirement(async () => { sent.resolve(); return response.promise; });
  const pending = remote.requestMemberRetirement(withdrawal); await sent.promise; assert.equal(remote.memberRetirementSnapshot()!.busy, true); assert.equal(remote.memberRetirementSnapshot()!.receipt, null); await assert.rejects(remote.requestMemberRetirement(withdrawal), errorCode("RETIREMENT_IN_PROGRESS"));
  response.resolve(Response.json({ data: { withdrawalId: withdrawal, status: "processing", memberAccessRevoked: true } })); await pending; assert.equal(s.retirementCalls().length, 1);
});
test("포트 교체는 이전 adapter 원 토큰 폐기·늦은 영수증으로 새 세션 회수0", async () => {
  const s = await connect(), response = deferred<Response>(), sent = deferred<void>(); s.setRetirement(async () => { sent.resolve(); return response.promise; });
  const pending = remote.requestMemberRetirement(withdrawal); await sent.promise;
  const next = setupRetirement(); remote.installMemberSessionPort(next.port); remote.installMemberSessionDetails(await next.login(secondUser)); const nextToken = next.originalToken(); assert.equal(remote.memberRetirementSnapshot(), null);
  response.resolve(Response.json({ data: { withdrawalId: withdrawal, status: "completed", memberAccessRevoked: true } })); await assert.rejects(pending, errorCode("SESSION_CHANGED")); assert.equal(await remote.serviceAccessToken(), nextToken); assert.equal(await s.port.accessToken!(), null); await assert.rejects(s.port.retire!(withdrawal, signal()), errorCode("SESSION_CHANGED")); assert.equal(s.retirementCalls().length, 1);
});
test("새 로그인 시작 즉시 이전 최소 영수증/token 폐기·old ID를 새 사용자로 전송0", async () => {
  const s = await connect(); await remote.requestMemberRetirement(withdrawal); const login = s.login(secondUser); assert.equal(remote.memberRetirementSnapshot(), null); assert.equal(await remote.serviceAccessToken(), null);
  remote.installMemberSessionDetails(await login); await assert.rejects(remote.requestMemberRetirement(withdrawal), errorCode("SESSION_CHANGED")); assert.equal(s.retirementCalls().length, 1); assert.equal(remote.memberRetirementSnapshot(), null); assert.equal(await remote.serviceAccessToken(), s.originalToken());
  await remote.requestMemberRetirement(otherWithdrawal); assert.equal(s.retirementCalls().length, 2); assert.equal(remote.memberRetirementSnapshot()!.withdrawalId, otherWithdrawal);
});
test("유실 뒤 logout은 store 폐기·같은 ID 수동 호출도 로그인 필요", async () => {
  const s = await connect(); s.setRetirement(async () => { throw new Error("SYNTHETIC_RESPONSE_LOST"); }); await assert.rejects(remote.requestMemberRetirement(withdrawal)); await s.port.logout(signal()); assert.equal(remote.memberRetirementSnapshot(), null); assert.equal(await remote.serviceAccessToken(), null); await assert.rejects(remote.requestMemberRetirement(withdrawal), errorCode("AUTH_REQUIRED")); assert.equal(s.retirementCalls().length, 1);
});
test("원 토큰 만료는 refresh0·같은 ID metadata 유지·완료로 바꾸지 않음", async () => {
  const s = await connect(); s.setRetirement(async () => { throw new Error("SYNTHETIC_RESPONSE_LOST"); }); await assert.rejects(remote.requestMemberRetirement(withdrawal)); s.advance(); assert.equal(await remote.serviceAccessToken(), null); assert.equal(remote.memberRetirementSnapshot()!.withdrawalId, withdrawal);
  await assert.rejects(remote.requestMemberRetirement(withdrawal), errorCode("RETIREMENT_TOKEN_EXPIRED")); assert.deepEqual(remote.memberRetirementSnapshot(), { withdrawalId: withdrawal, receipt: null, busy: false, errorCode: "AUTH_REQUIRED" }); assert.equal(s.calls.filter(c => c.url.includes("/token?")).length, 0); assert.equal(s.retirementCalls().length, 1);
});
test("완료 영수증 뒤 후퇴 응답은 기존 완료 metadata 유지·권한 재설치0", async () => {
  const s = await connect(); s.setRetirement(async body => Response.json({ data: { ...body, status: "completed", memberAccessRevoked: true } })); await remote.requestMemberRetirement(withdrawal);
  s.setRetirement(async body => Response.json({ data: { ...body, status: "processing", memberAccessRevoked: true } })); await assert.rejects(remote.requestMemberRetirement(withdrawal), errorCode("INVALID_SERVICE_RESPONSE")); assert.equal(remote.memberRetirementSnapshot()!.receipt!.status, "completed"); assert.equal(await remote.serviceAccessToken(), null);
});
test("승인 설정은 배포 service-api와 같은 HTTPS origin/정확 경로일 때만 설치", async () => {
  const s = await connect(); const originalUrl = process.env.EXPO_PUBLIC_SERVICE_API_URL;
  for (const url of ["https://evil.example/functions/v1/service-api", "https://project.example/service-api", "http://project.example/functions/v1/service-api", "https://project.example/functions/v1/service-api?x=1"]) { process.env.EXPO_PUBLIC_SERVICE_API_URL = url; assert.throws(() => remote.installWebMemberConnection(s.configuration), errorCode("INVALID_RETIREMENT_CONFIGURATION")); }
  process.env.EXPO_PUBLIC_SERVICE_API_URL = originalUrl; remote.installWebMemberConnection(s.configuration); assert.equal(typeof remote.useMemberPorts().session!.retire, "function");
});
test("store 구독은 최소 상태만 보고 해제 뒤 알림0", async () => {
  const s = await connect(); let count = 0; const stop = remote.subscribeMemberRetirement(() => { count++; }); await remote.requestMemberRetirement(withdrawal); assert.ok(count >= 3); stop(); const before = count; remote.installMemberSessionDetails(null); assert.equal(count, before); assert.equal(await s.port.accessToken!(), null);
});
test("두 승인 계약을 함께 설치해 본 집합만 읽음 처리·탈퇴 확인 후 일반 요청0", async () => {
  const s = setupRetirement(), state = "a".repeat(64), room = "33333333-3333-4333-8333-333333333333", seen = "44444444-4444-4444-8444-444444444444";
  remote.installWebMemberConnection({ ...s.configuration, messageReadContract: "2026-10-08-individual-message-read" });
  const port = remote.useMemberPorts().session!;
  assert.equal(typeof port.retire, "function");
  assert.notEqual(remote.useMessageReadPort(), null);
  await port.login("/account", signal());
  remote.installMemberSessionDetails(await port.callback!(`https://app.example/auth-callback?code=synthetic&state=${state}`, signal()));
  const result = await remote.useMessageReadPort()!.markVisible(room, [seen], signal());
  assert.deepEqual(result, { confirmedMessageIds: [seen], unreadCount: 1 });
  assert.equal(readCalls.length, 1);
  assert.equal(readCalls[0].url, `https://project.example/functions/v1/service-api/conversations/${room}/read/messages`);
  assert.deepEqual(readCalls[0].body, { messageIds: [seen] });
  assert.equal(readCalls[0].headers.get("authorization"), "Bearer " + s.originalToken());
  await remote.requestMemberRetirement(withdrawal);
  assert.equal(remote.memberRetirementSnapshot()!.receipt!.status, "processing");
  await assert.rejects(remote.useMessageReadPort()!.markVisible(room, [seen], signal()), errorCode("AUTH_REQUIRED"));
  assert.equal(readCalls.length, 1);
  assert.equal(s.retirementCalls().length, 1);
  remote.installWebMemberConnection(s.configuration);
  assert.equal(remote.useMessageReadPort(), null);
  assert.equal(remote.memberRetirementSnapshot(), null);
  assert.equal(await port.accessToken!(), null);
});
test("기본 미승인 연결은 읽음/탈퇴 모두 미설치·이전 읽음 포트 제거", async () => {
  const s = setupRetirement({ enabled: false });
  remote.installMessageReadPort({ markVisible: async () => { throw new Error("OLD_PORT_USED"); } });
  remote.installWebMemberConnection(s.configuration);
  assert.equal(remote.useMessageReadPort(), null);
  assert.equal(remote.useMemberPorts().session!.retire, undefined);
  assert.equal(s.calls.length, 0);
  assert.equal(readCalls.length, 0);
});
test.after(() => { globalThis.fetch = originalFetch; hooks.deregister(); });
