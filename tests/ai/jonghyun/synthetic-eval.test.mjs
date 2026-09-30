// 합성 평가 실행기의 가상 검사. 가짜 모델 결과는 실제 모델 품질이 아니다.
import test from "node:test";
import assert from "node:assert/strict";
import { loadCases, runSyntheticEval, createRunBudget, preferencePlan } from "./synthetic-eval.mjs";
import { createModelRouter } from "../../../backend/supabase/functions/_shared/ai/providers/provider-adapter.ts";

test("고정 가상 사례만 사용하고 미입력 사례는 모델에 보내지 않음", async () => {
  const cases = loadCases();
  const sent = [];
  const model = { async generate(request) {
    sent.push(request);
    if (request.task === "preference_match") {
      const c = request.input.candidates[0]; const field = Object.keys(request.input.requested)[0];
      return { value: { judgments: [{ ref: c.ref, [field]: request.input.requested[field].map(() => "different") }] }, modelVersion: "fake", usage: null };
    }
    return { value: { claims: [{ text: "가상 요약", evidenceIds: request.input.reviews.map((r) => r.evidenceId) }] }, modelVersion: "fake", usage: null };
  } };
  const rows = await runSyntheticEval({ model, cases, maxOutputTokens: 10 });
  assert.equal(rows.length, cases.preferenceMatch.length + cases.reviewSummary.length);
  assert.match(rows.find((r) => r.id === "pm-missing").observed, /needs_check/);
  assert.equal(sent.filter((r) => r.task === "preference_match").length, cases.preferenceMatch.length - 1);
  for (const request of sent.filter((r) => r.task === "preference_match")) {
    assert.deepEqual(Object.keys(request.input.candidates[0]).filter((k) => k !== "ref").length, 1);
  }
  assert.equal(rows.find((r) => r.id === "pm-negation").conditionSatisfied, true, "exclude + different → 조건 충족");
  assert.match(rows.find((r) => r.id === "rs-contradiction-injection").observed, /rejected:UNSAFE|가상 요약/);
});

test("실행 예산은 호출·단위 상한 밖 호출을 공급사에 보내지 않음", async () => {
  const budget = createRunBudget(2, 1_000_000); let reached = 0;
  const router = createModelRouter({ budget, primary: { id: "potens", retentionReview: { status: "approved", decisionId: "synthetic" },
    model: { async generate() { reached++; return { value: { judgments: [] }, modelVersion: "fake", usage: null }; } } } });
  const plan = preferencePlan(loadCases().preferenceMatch[0]);
  for (let i = 0; i < 3; i++) await router.generate({ task: "preference_match", system: "s", input: plan.input, maxOutputTokens: 5 }).catch(() => {});
  assert.equal(reached, 2);
  assert.equal(budget.stats().unknownUsageCalls, 2);
});
