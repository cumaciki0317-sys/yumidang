/**
 * 합성 평가 실행기 (설계 5.2·5.7). 서버에 고정된 tests/fixtures/jonghyun/synthetic-eval-cases.json만 입력으로 쓴다.
 * 외부 요청자가 입력을 넣거나 '가상'이라고 표시해 보관 검토를 우회하는 경로가 없다(HTTP 진입점 없음).
 *
 *   node tests/ai/jonghyun/synthetic-eval.mjs            # 기본: dry-run. 모델 호출 없음, 호출 계획·예산 단위만 출력
 *   node tests/ai/jonghyun/synthetic-eval.mjs --live     # 실제 포텐스닷 호출. 아래 환경값을 모두 명시해야 한다.
 *
 * --live 필수 환경값(운영자가 셸에 직접 주입, .env 자동 읽기 없음, 기본값 없음):
 *   POTENS_API_KEY, POTENS_API_BASE_URL, POTENS_MODEL, UPSTREAM_TIMEOUT_MS  — 민규 loadPotensLlmConfig 계약
 *   AI_COST_EVIDENCE_ID            — 추가 유료 지출 0원을 확인한 계정 근거 식별자
 *   SYNTHETIC_EVAL_MAX_CALLS       — 이번 실행 전체 호출 상한
 *   SYNTHETIC_EVAL_MAX_UNITS       — 이번 실행 전체 예산 단위 상한(입력 바이트+고정 prompt+최대 출력)
 *   SYNTHETIC_EVAL_MAX_OUTPUT_TOKENS — 호출당 요청 최대 출력 토큰(공급사 강제 여부는 미확인)
 *   선택: POTENS_USAGE_INPUT_FIELD / POTENS_USAGE_OUTPUT_FIELD (확인된 token_usage 필드명)
 * 결과는 표준 출력에만 쓰며 저장소에 자동 저장하지 않는다. 결과는 '합성 사례의 제한된 관찰'이며 품질 합격 판정이 아니다.
 */
import { readFileSync } from "node:fs";
import { loadPotensLlmConfig } from "../../../backend/supabase/functions/_shared/config/providers.ts";
import { createPotensModel, POTENS_PROMPT_OVERHEAD_BYTES } from "../../../backend/supabase/functions/_shared/ai/providers/potens-adapter.ts";
import { createModelRouter } from "../../../backend/supabase/functions/_shared/ai/providers/provider-adapter.ts";
import { judgePreferences, evaluatePreferenceCondition } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/preference-match.ts";
import { PREFERENCE_MATCH_PROMPT } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/prompts.ts";
import { REVIEW_CHUNK_SYSTEM } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/prompts.ts";
import { createConservativePrivacyCheck } from "../../../backend/supabase/functions/_shared/ai/providers/privacy.ts";
import { ModelError, safeModelError } from "../../../backend/supabase/functions/_shared/ai/providers/provider-errors.ts";
import { createConservativeSummarySafety, checkSummaryOutput } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/output-check.ts";

/** 이 실행기가 쓰는 보관 검토 근거: 2026-09-29 사용자 결정 '외부 보관 검토 전에는 합성 입력만 사용'. 제품 경로 승인이 아니다. */
export const SYNTHETIC_ONLY_DECISION = "user-decision-2026-09-29-synthetic-inputs-only";
const encoder = new TextEncoder();

export function loadCases(path = new URL("../../fixtures/jonghyun/synthetic-eval-cases.json", import.meta.url)) {
  const cases = JSON.parse(readFileSync(path, "utf8"));
  if (cases.status !== "SYNTHETIC_ONLY" || !Array.isArray(cases.preferenceMatch) || !Array.isArray(cases.reviewSummary)) {
    throw new Error("SYNTHETIC_FIXTURE_REQUIRED");
  }
  return cases;
}

/** 한 사례를 제품과 같은 판단 입력(불투명 ref, 요청·등록값만)으로 바꾼다. 미입력 사례는 모델에 보내지 않는다. */
export function preferencePlan(item) {
  const values = item.requestedAll ?? [item.requested];
  const condition = { values: values.map((text) => ({ text, polarity: item.polarity ?? "include" })),
    ...(values.length > 1 ? { combine: item.combine } : {}) };
  if (!item.registered.length) return { id: item.id, kind: item.kind, condition, skip: "needs_check(미입력은 모델에 보내지 않음)" };
  return { id: item.id, kind: item.kind, condition,
    input: { requested: { [item.field]: values }, candidates: [{ ref: "c1", [item.field]: [...item.registered] }] } };
}
export function summaryPlan(item) {
  return { id: item.id, input: { reviews: item.reviews.map((r) => ({ evidenceId: r.evidenceId, comment: r.comment })) },
    expectedIds: item.reviews.map((r) => r.evidenceId) };
}
export function estimateUnits(system, input, maxOutputTokens) {
  return encoder.encode(system).length + encoder.encode(JSON.stringify(input)).length + POTENS_PROMPT_OVERHEAD_BYTES + maxOutputTokens;
}

/** 프로세스 안의 원자 예산(단일 실행기). 한도 밖 호출은 공급사에 도달하지 않는다. 사용량 불명은 예약 전체를 소비로 유지한다. */
export function createRunBudget(maxCalls, maxUnits) {
  let calls = 0, units = 0, unknown = 0; const open = new Map(); let seq = 0;
  return {
    stats: () => ({ calls, units, unknownUsageCalls: unknown }),
    async reserve({ inputBytes, maxOutputTokens }) {
      const need = inputBytes + POTENS_PROMPT_OVERHEAD_BYTES + maxOutputTokens;
      if (calls + 1 > maxCalls || units + need > maxUnits) return null;
      calls += 1; units += need; const id = String(++seq); open.set(id, need); return id;
    },
    async settle({ reservationId, outcome, usage }) {
      const need = open.get(reservationId); open.delete(reservationId);
      if (outcome === "success" && usage) units += usage.inputTokens + usage.outputTokens - need;
      else unknown += 1;
    },
  };
}

/** 외부 오류 message는 출력하지 않는다. 고정 모델 코드/평가 코드만 기록한다. */
function evaluationCode(error) {
  if (error instanceof ModelError) return safeModelError(error).code;
  const allowed = new Set(["INVALID_SUMMARY_OUTPUT", "SUMMARY_OUTPUT_TOO_LARGE", "UNSAFE_SUMMARY_OUTPUT", "INVALID_EVIDENCE", "INCOMPLETE_EVIDENCE"]);
  return error instanceof Error && allowed.has(error.message) ? error.message : "EVALUATION_FAILED";
}
/** 고정 합성 자료만 쓰는 로컬 규칙 평가. 공급사·DB·운영 승인·품질 임계값 판정이 아니다. */
export async function runConservativeChecks(cases = loadCases()) {
  const rows = [];
  for (const item of cases.conservativeChecks ?? []) {
    const privacy = createConservativePrivacyCheck({ decisionId: "synthetic-fixture-review-only", approvedStrings: item.approvedStrings });
    const allowed = await createConservativeSummarySafety(privacy).check({ claims: item.claims, publicTextReviews: item.reviews });
    rows.push({ id: item.id, allowed, expectedAllowed: item.expectedAllowed, matchesExpected: allowed === item.expectedAllowed });
  }
  return rows;
}

export async function runSyntheticEval({ model, cases, maxOutputTokens, now = () => performance.now() }) {
  const rows = [];
  for (const item of cases.preferenceMatch) {
    const plan = preferencePlan(item);
    if (plan.skip) { rows.push({ id: item.id, kind: item.kind, observed: plan.skip, expectation: item.reviewerExpectation }); continue; }
    const started = now();
    try {
      const judgments = await judgePreferences(model, plan.input, { maxOutputTokens });
      const similarities = judgments.get("c1")[item.field];
      rows.push({ id: item.id, kind: item.kind, observed: similarities.join(","),
        conditionSatisfied: evaluatePreferenceCondition(plan.condition, similarities), expectation: item.reviewerExpectation, ms: Math.round(now() - started) });
    } catch (error) {
      rows.push({ id: item.id, kind: item.kind, observed: "judgment_failed:" + evaluationCode(error), expectation: item.reviewerExpectation, ms: Math.round(now() - started) });
    }
  }
  for (const item of cases.reviewSummary) {
    const plan = summaryPlan(item);
    const started = now();
    try {
      const response = await model.generate({ task: "review_chunk", system: REVIEW_CHUNK_SYSTEM, input: plan.input, maxOutputTokens });
      const claims = checkSummaryOutput(response.value, plan.expectedIds, 4000);
      const privacy = createConservativePrivacyCheck({ decisionId: "synthetic-fixture-review-only", approvedStrings: item.approvedStrings ?? [] });
      if (!await createConservativeSummarySafety(privacy).check({ claims, publicTextReviews: plan.input.reviews })) throw new Error("UNSAFE_SUMMARY_OUTPUT");
      rows.push({ id: item.id, kind: "review_summary", observed: claims.map((c) => `${c.text} [${c.evidenceIds.join(",")}]`).join(" / "),
        expectation: item.reviewerExpectation, usage: response.usage, ms: Math.round(now() - started) });
    } catch (error) {
      rows.push({ id: item.id, kind: "review_summary", observed: "rejected:" + evaluationCode(error), expectation: item.reviewerExpectation, ms: Math.round(now() - started) });
    }
  }
  return rows;
}

function required(key) {
  const value = process.env[key];
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error("SYNTHETIC_EVAL_SETTING_REQUIRED:" + key);
  return Number(value);
}

if (import.meta.main) {
  const cases = loadCases();
  if (process.argv.includes("--checks")) {
    console.log(JSON.stringify({ mode: "LOCAL_SYNTHETIC_RULE_CHECKS", modelCalls: 0, note: "합성 규칙 평가이며 운영 승인·실제 모델 품질 검증 아님", rows: await runConservativeChecks(cases) }, null, 2));
  } else if (!process.argv.includes("--live")) {
    const assumedOutput = 1; // 계획 출력용 표시값. 실제 상한은 --live의 명시 설정을 쓴다.
    const plans = [...cases.preferenceMatch.map(preferencePlan).map((p) => ({ id: p.id, call: !p.skip,
      inputUnitsExcludingOutput: p.skip ? 0 : estimateUnits(PREFERENCE_MATCH_PROMPT, p.input, assumedOutput) - assumedOutput })),
      ...cases.reviewSummary.map(summaryPlan).map((p) => ({ id: p.id, call: true,
        inputUnitsExcludingOutput: estimateUnits(REVIEW_CHUNK_SYSTEM, p.input, assumedOutput) - assumedOutput }))];
    console.log(JSON.stringify({ mode: "DRY_RUN_NO_MODEL_CALL", plannedCalls: plans.filter((p) => p.call).length, plans }, null, 2));
  } else {
    if (!process.env.AI_COST_EVIDENCE_ID) throw new Error("AI_COST_EVIDENCE_ID_REQUIRED");
    const maxOutputTokens = required("SYNTHETIC_EVAL_MAX_OUTPUT_TOKENS");
    const budget = createRunBudget(required("SYNTHETIC_EVAL_MAX_CALLS"), required("SYNTHETIC_EVAL_MAX_UNITS"));
    const potens = loadPotensLlmConfig((key) => process.env[key]);
    const input = process.env.POTENS_USAGE_INPUT_FIELD, output = process.env.POTENS_USAGE_OUTPUT_FIELD;
    const model = createModelRouter({ budget, primary: { id: "potens", retentionReview: { status: "approved", decisionId: SYNTHETIC_ONLY_DECISION },
      model: createPotensModel({ apiKey: potens.apiKey, baseUrl: potens.baseUrl, model: potens.model, timeoutMs: potens.upstreamTimeoutMs,
        ...(input && output ? { usageFields: { input, output } } : {}), fetch: (url, init) => fetch(url, init) }) } });
    const rows = await runSyntheticEval({ model, cases, maxOutputTokens });
    console.log(JSON.stringify({ mode: "LIVE_SYNTHETIC_ONLY", note: "합성 사례의 제한된 관찰. 품질 합격 판정 아님.", budget: budget.stats(), rows }, null, 2));
  }
}
