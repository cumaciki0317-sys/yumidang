// 예산 RPC 어댑터·런타임 조립 가상 검사. RpcClient·fetch는 주입값이며 실제 DB·공급사 호출이 아니다.
import test from "node:test";
import assert from "node:assert/strict";
import { createRpcModelBudget } from "../../../backend/supabase/functions/_shared/ai/providers/budget.ts";
import { createConfiguredModel, AI_RUNTIME_ENV } from "../../../backend/supabase/functions/_shared/ai/providers/runtime.ts";
import { createModelRouter } from "../../../backend/supabase/functions/_shared/ai/providers/provider-adapter.ts";

const RID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function rpcRecorder(handlers) {
  const calls = [];
  return { calls, rpc: async (name, args) => { calls.push({ name, args }); return handlers[name](args); } };
}

test("예약 단위 = 입력 UTF-8 바이트 + prompt 고정 바이트 + 최대 출력 토큰, 원문·사용자 ID 미전달", async () => {
  const db = rpcRecorder({ reserve_ai_budget: () => ({ reservationId: RID.toUpperCase() }), settle_ai_budget: () => ({ settled: true }) });
  const budget = createRpcModelBudget(db, { ledgerId: "synthetic-ledger", promptOverheadBytes: 7 });
  const id = await budget.reserve({ providerId: "potens", task: "preference_match", inputChars: 10, inputBytes: 30, maxOutputTokens: 100 });
  assert.equal(id, RID);
  assert.deepEqual(db.calls[0], { name: "reserve_ai_budget", args: { p_ledger_id: "synthetic-ledger", p_provider_id: "potens", p_task: "preference_match", p_units: 137 } });
  await budget.settle({ reservationId: id, outcome: "success", usage: { inputTokens: 5, outputTokens: 6 } });
  await budget.settle({ reservationId: id, outcome: "unknown" });
  assert.deepEqual(db.calls.slice(1).map((c) => c.args), [
    { p_reservation_id: RID, p_outcome: "usage_reported", p_input_tokens: 5, p_output_tokens: 6 },
    { p_reservation_id: RID, p_outcome: "usage_unknown", p_input_tokens: null, p_output_tokens: null },
  ]);
});

test("한도 초과 null은 예약 실패로 반환하고, 알 수 없는 응답 형식은 오류(성공으로 숨기지 않음)", async () => {
  const exhausted = createRpcModelBudget(rpcRecorder({ reserve_ai_budget: () => ({ reservationId: null }) }), { ledgerId: "l", promptOverheadBytes: 0 });
  assert.equal(await exhausted.reserve({ providerId: "potens", task: "intent", inputChars: 1, inputBytes: 1, maxOutputTokens: 1 }), null);
  for (const bad of [{}, { reservationId: "x" }, { reservationId: RID, extra: 1 }, null, []]) {
    const budget = createRpcModelBudget(rpcRecorder({ reserve_ai_budget: () => bad }), { ledgerId: "l", promptOverheadBytes: 0 });
    await assert.rejects(budget.reserve({ providerId: "potens", task: "intent", inputChars: 1, inputBytes: 1, maxOutputTokens: 1 }), /INVALID_BUDGET_RESPONSE/);
  }
  const settleBad = createRpcModelBudget(rpcRecorder({ settle_ai_budget: () => ({ settled: false }) }), { ledgerId: "l", promptOverheadBytes: 0 });
  await assert.rejects(settleBad.settle({ reservationId: RID, outcome: "unknown" }), /INVALID_BUDGET_RESPONSE/);
  await assert.rejects(settleBad.settle({ reservationId: RID, outcome: "success" }), /INVALID_BUDGET_INPUT/);
});

test("라우터+DB 예산: 동시 호출은 원장 순서대로 예약되고 한도 밖 호출은 공급사에 도달하지 않음", async () => {
  // 원장 동작을 흉내 낸 가상 RPC. 실제 원자성은 DB 검사(tests/database/jonghyun/ai_budget.sql)와 동시 세션 검사로 확인한다.
  let used = 0; const limit = 250; let n = 0; const open = new Map();
  const db = { rpc: async (name, args) => {
    if (name === "reserve_ai_budget") {
      if (used + args.p_units > limit) return { reservationId: null };
      used += args.p_units; const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`; open.set(id, args.p_units); return { reservationId: id };
    }
    const units = open.get(args.p_reservation_id); open.delete(args.p_reservation_id);
    if (args.p_outcome === "usage_reported") used += args.p_input_tokens + args.p_output_tokens - units;
    return { settled: true };
  } };
  let providerCalls = 0;
  const router = createModelRouter({
    primary: { id: "potens", retentionReview: { status: "approved", decisionId: "synthetic-inputs-only" },
      model: { async generate() { providerCalls++; await new Promise((r) => setTimeout(r, 5)); return { value: {}, modelVersion: "potens.synthetic", usage: null }; } } },
    budget: createRpcModelBudget(db, { ledgerId: "synthetic", promptOverheadBytes: 0 }),
  });
  const request = { task: "intent", system: "s", input: { a: "가" }, maxOutputTokens: 100 };
  const results = await Promise.allSettled([1, 2, 3].map(() => router.generate(request)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.match(results.find((r) => r.status === "rejected").reason.message, /BUDGET_EXHAUSTED/);
  assert.equal(providerCalls, 2);
  assert.equal(open.size, 0);
});

const env = (values) => (key) => values[key];
const potensEnv = { POTENS_API_KEY: "synthetic_key", POTENS_API_BASE_URL: "https://ai.potens.ai", POTENS_MODEL: "claude-5-sonnet", UPSTREAM_TIMEOUT_MS: "1000" };

test("보관 검토 결정·추가 지출 0원 근거·원장이 없으면 모델을 만들지 않음(disabled)", () => {
  const budgetDb = { rpc: async () => { throw new Error("must not call"); } };
  assert.deepEqual(createConfiguredModel(env(potensEnv), { budgetDb }), { status: "disabled", code: "RETENTION_REVIEW_PENDING" });
  assert.deepEqual(createConfiguredModel(env({ ...potensEnv, [AI_RUNTIME_ENV.retentionDecisionId]: "team-decision-1" }), { budgetDb }),
    { status: "disabled", code: "COST_EVIDENCE_MISSING" });
  assert.deepEqual(createConfiguredModel(env({ ...potensEnv, [AI_RUNTIME_ENV.retentionDecisionId]: "team-decision-1", [AI_RUNTIME_ENV.costEvidenceId]: "evidence-1" }), { budgetDb }),
    { status: "disabled", code: "NOT_CONFIGURED" });
  assert.deepEqual(createConfiguredModel(env({ ...potensEnv, [AI_RUNTIME_ENV.retentionDecisionId]: "bad value!" }), { budgetDb }),
    { status: "disabled", code: "NOT_CONFIGURED" });
  const partialUsage = { ...potensEnv, AI_RETENTION_DECISION_ID: "d", AI_COST_EVIDENCE_ID: "e", AI_BUDGET_LEDGER_ID: "l", POTENS_USAGE_INPUT_FIELD: "in" };
  assert.deepEqual(createConfiguredModel(env(partialUsage), { budgetDb }), { status: "disabled", code: "NOT_CONFIGURED" });
});

test("모든 명시 설정이 있으면 예산 예약 후 포텐스닷으로 호출(가상 fetch)", async () => {
  const calls = [];
  const budgetDb = { rpc: async (name) => name === "reserve_ai_budget" ? { reservationId: RID } : { settled: true } };
  const runtime = createConfiguredModel(env({ ...potensEnv, AI_RETENTION_DECISION_ID: "d", AI_COST_EVIDENCE_ID: "e", AI_BUDGET_LEDGER_ID: "l", AI_PROCESSING_LEGAL_DECISION_ID:"synthetic", AI_MEMBER_TRANSMISSION_APPROVAL_ID:"synthetic" }), {
    budgetDb, outputLimit: { decisionId: "synthetic-only", apply: (body, limit) => ({ ...body, synthetic_max_tokens: limit }) }, fetch: async (url, init) => { calls.push(url); return Response.json({ message: "{\"ok\":true}", token_usage: {} }); },
  });
  assert.equal(runtime.status, "ready");
  const response = await runtime.model.generate({ task: "intent", system: "s", input: {}, maxOutputTokens: 5 });
  assert.deepEqual(response.value, { ok: true });
  assert.equal(response.usage, null);
  assert.deepEqual(calls, ["https://ai.potens.ai/api/chat"]);
  assert.equal(JSON.stringify(runtime).includes("synthetic_key"), false);
});
