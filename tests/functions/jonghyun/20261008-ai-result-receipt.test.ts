import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { createRpcAiFeedback } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/feedback.ts";
import { recordAiResultAvailable } from "../../../backend/supabase/functions/_shared/db/ai-feedback-client.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
import type { RpcClient } from "../../../backend/supabase/functions/_shared/db/transport.ts";
// UUID 숫자열이 기존 연락처 보조 검사에 우연히 일치할 수 있어 합성 ID를 고정한다.
const originalUuid = crypto.randomUUID;
beforeEach(() => { crypto.randomUUID = () => "33333333-3333-4333-8333-333333333333"; });
afterEach(() => { crypto.randomUUID = originalUuid; });
import { createAiChatHandler, aiChatPrivacyOutput, type AiChatHandlerDependencies } from "../../../backend/supabase/functions/ai-chat/handler.ts";
import { createAiChatRuntime } from "../../../backend/supabase/functions/ai-chat/index.ts";
import { AI_CHAT_ENV } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/settings.ts";
import type { MemberModelRequest } from "../../../backend/supabase/functions/_shared/ai/providers/model-port.ts";
const userId = "11111111-1111-4111-8111-111111111111", leaseToken = "22222222-2222-4222-8222-222222222222";
const card = { kind: "post" as const, id: leaseToken, title: "합성 전시", locationLabel: "서울특별시 종로구 종로1가", startsAtOrDate: "2026-10-09T05:00:00Z", endsAtOrDate: "2026-10-09T07:00:00Z", costLabel: "무료", state: "recruiting", canApply: true };
function request(signal?: AbortSignal, region = true) {
  return new Request("https://synthetic.test/ai-chat", { method: "POST", signal, headers: { "content-type": "application/json", authorization: "Bearer aaa.bbb.ccc" }, body: JSON.stringify({ clientRequestId: "synthetic", messages: [{ role: "user", content: "전시 동행" }], currentFilters: { target: "posts", ...(region ? { region: "서울특별시" } : {}) } }) });
}
function setup(options: { normal?: "results" | "no_results" | "needs_clarification"; failReceipt?: boolean; failFinish?: boolean; privacyBlock?: "input" | "output"; abort?: AbortController; expiresAt?: string; missingReceipt?: boolean; unavailable?: boolean; modelDelayMs?: number; cancelOnFinish?: AbortController; outputTitle?: string; outputCardId?: string; modelQuestion?: string } = {}) {
  const calls: string[] = [], scopes: MemberModelRequest[] = [];
  const normal = options.normal ?? "no_results";
  const outputCard = { ...card, ...(options.outputTitle ? { title: options.outputTitle } : {}), ...(options.outputCardId ? { id: options.outputCardId } : {}) };
  const deps: AiChatHandlerDependencies = {
    allowedOrigins: [], maxBodyBytes: 4096, authenticate: async () => ({ userId }),
    engine: { status: "ready", now: () => new Date("2026-10-08T00:00:00Z"), limits: { maxMessages: 6, maxMessageChars: 500, maxTotalChars: 1000, maxOutputTokens: 100 },
      privacy: { decisionId: "synthetic", async check(value) {
        const v = value as { clientRequestId?: string; status?: string; cards?: unknown[] };
        if (v.clientRequestId) { calls.push("privacy-input"); return options.privacyBlock !== "input"; }
        if (Array.isArray(v.cards)) { calls.push("privacy-final"); options.abort?.abort(); return options.privacyBlock !== "output"; }
        return true;
      } },
      model: { async generate() { if (options.modelDelayMs) await new Promise(resolve => setTimeout(resolve, options.modelDelayMs)); if (options.unavailable) throw Error("synthetic timeout"); return { modelVersion: "synthetic", usage: null, value: normal === "needs_clarification" ? { status: "clarify", filters: { target: "posts", region: "서울특별시" }, question: options.modelQuestion ?? "어떤 전시인가요?" } : { status: "search", filters: { target: "posts", region: "서울특별시" } } }; } } },
    requestGate: { async acquire(input) { calls.push("acquire"); return { status: "acquired", scope: { userId, requestId: input.requestId, leaseToken }, expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000).toISOString() }; }, async finish() { calls.push("finish"); options.cancelOnFinish?.abort(); if (options.failFinish) throw Error("synthetic response loss"); } },
    recordResultAvailable: async (scope) => { calls.push("record"); scopes.push(scope); if (options.failReceipt) throw Error("synthetic receipt failure"); },
    openSession: () => ({ loadPreferences: async () => ({}), discovery: { search: async () => ({ cards: normal === "results" ? [outputCard] : [], coverage: "exhausted" }), recheck: async () => ({ cards: [outputCard], complete: true }) } }),
  };
  if (options.missingReceipt) delete deps.recordResultAvailable;
  return { calls, scopes, handler: createAiChatHandler(deps) };
}
for (const normal of ["results", "no_results", "needs_clarification"] as const) {
  test(`정상 ${normal}: 최종 검사 뒤 기록, finish 전, 서버 scope만 전달`, async () => {
    const { handler, calls, scopes } = setup({ normal }); const response = await handler(request()); const payload = await response.json();
    assert.equal(response.status, 200); assert.equal(payload.data.status, normal);
    assert.deepEqual(calls.slice(-3), ["privacy-final", "record", "finish"]);
    assert.deepEqual(scopes, [{ userId, requestId: payload.requestId, leaseToken }]);
  });
}
for (const options of [{ failReceipt: true }, { missingReceipt: true }, { failFinish: true }]) {
  test(`저장/해제 실패 정상 성공 금지 ${JSON.stringify(options)}`, async () => {
    const { handler, calls } = setup(options); const response = await handler(request());
    assert.ok(response.status >= 500); assert.equal(calls.filter(c => c === "finish").length, 1);
  });
}
for (const options of [{ privacyBlock: "input" as const }, { privacyBlock: "output" as const }, { unavailable: true }, { expiresAt: new Date(0).toISOString() }]) {
  test(`실패·차단·만료 기록 0 ${JSON.stringify(options)}`, async () => {
    const { handler, calls, scopes } = setup(options); await handler(request()); assert.deepEqual(scopes, []); assert.equal(calls.includes("record"), false);
    assert.ok(calls.filter(c => c === "finish").length <= 1);
  });
}
test("최종 개인정보 검사 중 취소한 정상 응답도 기록·성공 0", async () => {
  const abort = new AbortController(); const { handler, scopes } = setup({ abort }); const response = await handler(request(abort.signal));
  assert.ok(response.status >= 500); assert.deepEqual(scopes, []);
});
test("기록 중 취소 시 성공 반환 금지·점유 해제는 한 번", async () => {
  const abort = new AbortController(); const calls: string[] = [];
  const handler = createAiChatHandler({ allowedOrigins: [], maxBodyBytes: 4096, authenticate: async () => ({ userId }), engine: { status: "ready", limits: { maxMessages: 6, maxMessageChars: 500, maxTotalChars: 1000, maxOutputTokens: 100 }, now: () => new Date(), model: { async generate() { throw Error("not reached"); } } }, requestGate: { async acquire(input) { return { status: "acquired", scope: { userId, requestId: input.requestId, leaseToken }, expiresAt: new Date(Date.now() + 60_000).toISOString() }; }, async finish() { calls.push("finish"); } }, recordResultAvailable: async () => { calls.push("record"); abort.abort(); }, openSession: () => ({ loadPreferences: async () => ({}), discovery: { async search() { throw Error("not reached"); }, async recheck() { throw Error("not reached"); } } }) });
  const response = await handler(request(abort.signal, false)); assert.ok(response.status >= 500); assert.deepEqual(calls, ["record", "finish"]);
});
test("런타임 실제 포트 조립: no-region 정상 응답 증거 RPC 뒤 해제, 신고 readiness false 유지", async () => {
  const calls: { name: string; args: any }[] = [];
  const env: Record<string, string> = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_ANON_KEY: "synthetic-anon", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service", INTERNAL_WORKER_SECRET: "synthetic_internal_worker_secret_00000000", UPSTREAM_TIMEOUT_MS: "1000", MAX_REQUEST_BYTES: "4096", ALLOWED_ORIGINS: "[]", AI_RETENTION_DECISION_ID: "synthetic", AI_COST_EVIDENCE_ID: "synthetic", AI_PROCESSING_LEGAL_DECISION_ID: "synthetic", AI_MEMBER_TRANSMISSION_APPROVAL_ID: "synthetic", AI_BUDGET_LEDGER_ID: "synthetic", POTENS_ACCOUNT_ORDER: "yumi,jonghyun", POTENS_API_KEY_YUMI: "synthetic-yumi", POTENS_API_KEY_JONGHYUN: "synthetic-jonghyun", POTENS_ACCOUNT_TOKEN_BUDGET: "3200000", POTENS_RESET_TIMEZONE: "Asia/Seoul", POTENS_MODEL: "claude-5-sonnet", POTENS_API_BASE_URL: "https://ai.potens.ai", ...Object.fromEntries(Object.values(AI_CHAT_ENV).map(k => [k, "3"])) };
  const handler = createAiChatRuntime(key => env[key], async (url, init) => {
    const name = new URL(String(url)).pathname.split("/").at(-1)!;
    const args = init?.body ? JSON.parse(String(init.body)) : {}; calls.push({ name, args });
    const value = name === "user" ? { id: userId, role: "authenticated" } : name === "acquire_ai_chat_request" ? { status: "acquired", leaseToken, expiresAt: new Date(Date.now() + 60_000).toISOString() } : name === "get_my_profile_traits" ? { interests: [], conversationStyles: [], mbti: null } : name === "record_ai_chat_result_available" ? { requestId: args.p_request_id, availableAt: new Date().toISOString() } : name === "finish_ai_chat_request" ? { finished: true } : name === "get_ai_feedback_readiness" ? { contractVersion: "2026-10-05", helpfulReady: true, reportReady: false } : assert.fail(`unexpected ${name}`);
    return new Response(JSON.stringify(value));
  }, { privacy: { decisionId: "synthetic", check: async () => true }, outputLimit: { decisionId: "synthetic", apply: body => body } });
  const response = await handler(request(undefined, false)); assert.equal(response.status, 200); const payload = await response.json(); assert.equal(payload.data.status, "needs_clarification");
  assert.deepEqual(calls.map(c => c.name), ["user", "acquire_ai_chat_request", "get_my_profile_traits", "record_ai_chat_result_available", "finish_ai_chat_request"]);
  assert.deepEqual(calls[3].args, { p_user_id: userId, p_request_id: payload.requestId, p_lease_token: leaseToken });
  const report = await handler(new Request("https://synthetic.test/ai-chat/feedback", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer aaa.bbb.ccc" }, body: JSON.stringify({ clientRequestId: "report", requestId: payload.requestId, action: "report", confirmed: true, attachment: { kind: "answer", text: "합성 답변" } }) }));
  assert.equal((await report.json()).data.status, "not_enabled"); assert.equal(calls.at(-1)?.name, "get_ai_feedback_readiness");
});

test("점유 만료 타이머 중 모델 응답이 늦게 도착해도 기록 0", async () => {
  const { handler, calls, scopes } = setup({ expiresAt: new Date(Date.now() + 30).toISOString(), modelDelayMs: 60 });
  const response = await handler(request()); assert.ok(response.status >= 500); assert.deepEqual(scopes, []); assert.equal(calls.filter(c => c === "finish").length, 1);
});
test("finish 중 취소는 정상 성공 금지·중복 해제 0", async () => {
  const abort = new AbortController(); const { handler, calls } = setup({ cancelOnFinish: abort });
  const response = await handler(request(abort.signal)); assert.ok(response.status >= 500); assert.equal(calls.filter(c => c === "finish").length, 1);
});

for (const state of ["normal", "unavailable", "expired", "withdrawn"] as const) {
  test(`실제 handler/feedback RPC 연결: ${state} helpful 접수 경계`, async () => {
    let receipt: string | undefined; const calls: string[] = [];
    const db: RpcClient = { async rpc(name, args): Promise<JsonValue> {
      calls.push(name);
      if (name === "record_ai_chat_result_available") {
        receipt = String(args.p_request_id); return { requestId: receipt, availableAt: "2026-10-08T00:00:00Z" };
      }
      if (name === "submit_ai_feedback") {
        assert.equal(args.p_user_id, userId); assert.equal(args.p_attachment, null);
        if (!receipt || state === "expired" || state === "withdrawn") throw new HttpError("RESOURCE_NOT_FOUND");
        assert.equal(args.p_request_id, receipt);
        return { status: "accepted", feedbackId: leaseToken, hideAnswer: false };
      }
      assert.fail(`unexpected ${name}`);
    } };
    const handler = createAiChatHandler({ allowedOrigins: [], maxBodyBytes: 4096, authenticate: async () => ({ userId }),
      engine: state === "unavailable" ? { status: "unavailable", code: "synthetic" } : { status: "ready", limits: { maxMessages: 6, maxMessageChars: 500, maxTotalChars: 1000, maxOutputTokens: 100 }, now: () => new Date(), model: { async generate() { throw Error("not reached"); } } },
      requestGate: { async acquire(input) { return { status: "acquired", scope: { userId, requestId: input.requestId, leaseToken }, expiresAt: new Date(Date.now() + 60_000).toISOString() }; }, async finish() {} },
      recordResultAvailable: scope => recordAiResultAvailable(db, scope), feedback: createRpcAiFeedback(db),
      openSession: () => ({ loadPreferences: async () => ({}), discovery: { async search() { throw Error("not reached"); }, async recheck() { throw Error("not reached"); } } }) });
    const payload = await (await handler(request(undefined, false))).json();
    const result = await handler(new Request("https://synthetic.test/ai-chat/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: "helpful", requestId: payload.requestId, action: "helpful" }) }));
    assert.equal(result.status, state === "normal" ? 200 : 404);
    if (state === "normal") assert.equal((await result.json()).data.status, "accepted");
    assert.deepEqual(calls, state === "unavailable" ? ["submit_ai_feedback"] : ["record_ai_chat_result_available", "submit_ai_feedback"]);
  });
}
test("실제 결과 기록 포트는 잘못된 availableAt·requestId·여분 필드에 성공하지 않음", async () => {
  const scope = { userId, requestId: leaseToken, leaseToken };
  const invalidValues: JsonValue[] = [{ requestId: leaseToken, availableAt: "invalid" }, { requestId: userId, availableAt: "2026-10-08T00:00:00Z" }, { requestId: leaseToken, availableAt: "2026-10-08T00:00:00Z", extra: true }];
  for (const value of invalidValues) {
    await assert.rejects(recordAiResultAvailable({ async rpc() { return value; } }, scope));
  }
});

const contactLikeUuid = "a0101234-5678-4abc-8abc-333333333333";
for (const normal of ["results", "no_results", "needs_clarification"] as const) {
  test(`연락처 형태 서버 UUID만 분리: 정상 ${normal} 기록 성공`, async () => {
    crypto.randomUUID = () => contactLikeUuid;
    const { handler, scopes } = setup({ normal }); const response = await handler(request()); const payload = await response.json();
    assert.equal(response.status, 200); assert.equal(payload.data.status, normal); assert.equal(payload.data.requestId, contactLikeUuid);
    assert.equal(scopes[0]?.requestId, contactLikeUuid);
  });
}
test("최종 검사 식별자는 서버와 일치해야 하고 UUID 형태여야 함", () => {
  const base = { requestId: contactLikeUuid, status: "no_results" as const, cards: [], explanations: [], interpretedFilters: { target: "posts" as const } };
  assert.throws(() => aiChatPrivacyOutput({ ...base, requestId: leaseToken }, contactLikeUuid));
  assert.throws(() => aiChatPrivacyOutput({ ...base, requestId: "spoof" }, "spoof"));
  assert.deepEqual(aiChatPrivacyOutput(base, contactLikeUuid), { status: "no_results", cards: [], explanations: [], interpretedFilters: { target: "posts" } });
});
for (const field of ["clientRequestId", "messages"] as const) {
  test(`사용자 ${field} 연락처는 여전히 차단·기록 0`, async () => {
    crypto.randomUUID = () => contactLikeUuid;
    const { handler, scopes, calls } = setup();
    const input = { clientRequestId: field === "clientRequestId" ? "010-1234-5678" : "synthetic", messages: [{ role: "user", content: field === "messages" ? "010-1234-5678" : "전시 동행" }], currentFilters: { target: "posts", region: "서울특별시" } };
    const response = await handler(new Request("https://synthetic.test/ai-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }));
    assert.equal((await response.json()).data.recovery.reason, "input_privacy"); assert.deepEqual(scopes, []); assert.equal(calls.includes("acquire"), false);
  });
}

for (const options of [{ normal: "results" as const, outputTitle: "010-1234-5678" }, { normal: "results" as const, outputCardId: contactLikeUuid }, { normal: "needs_clarification" as const, modelQuestion: "010-1234-5678" }]) {
  test(`출력 내용·카드 UUID·모델 연락처 제외 금지 ${JSON.stringify(options)}`, async () => {
    crypto.randomUUID = () => contactLikeUuid;
    const { handler, scopes } = setup(options); const payload = await (await handler(request())).json();
    assert.equal(payload.data.status, "unavailable"); assert.equal(payload.data.recovery.reason, "output_privacy"); assert.deepEqual(scopes, []);
  });
}
