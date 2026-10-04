// 요약 worker 가상 검사(총괄 작성, lane S 중단 후 이어받음). 모델·DB는 주입값이며 실제 모델·Edge·DB가 아니다.
import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import { runReviewSummaryStep } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/orchestrator.ts";
import { REVIEW_SUMMARY_PROMPT_VERSION } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/prompts.ts";
import { ModelError } from "../../../backend/supabase/functions/_shared/ai/providers/provider-errors.ts";
import { createReviewSummaryHandler } from "../../../backend/supabase/functions/_shared/jobs/registry.ts";
import { runNextJob } from "../../../backend/supabase/functions/_shared/jobs/lease.ts";
import { runSummaryWorkerBatch } from "../../../backend/supabase/functions/review-summary-worker/handler.ts";
import { createReviewSummaryWorkerRuntime, REVIEW_SUMMARY_WORKER_ENV } from "../../../backend/supabase/functions/review-summary-worker/index.ts";

const versions = { modelVersion: "potens.claude-5-sonnet", promptVersion: REVIEW_SUMMARY_PROMPT_VERSION };
const job = { jobId: "job-1", leaseToken: "lease-1", targetUserId: "user-1", sourceRevision: "7", ...versions };
const settings = { maxInputChars: 20000, maxReviewsPerChunk: 2, mergeFanIn: 2, maxOutputTokens: 200, maxOutputChars: 2000, maxCallsPerStep: 3 };
function repo(count = 5) {
  const state = { checkpoint: null, discarded: 0, saved: 0 };
  return { state, repository: {
    async loadSource() { return { targetUserId: "user-1", sourceRevision: "7", publicTextReviews: Array.from({ length: count }, (_, i) => ({ evidenceId: "r" + i, comment: "가상 후기 " + i })) }; },
    async loadCheckpoint() { return structuredClone(state.checkpoint); },
    async saveCheckpoint(_job, checkpoint) { state.checkpoint = structuredClone(checkpoint); state.saved++; return "applied"; },
    async publish() { return "applied"; }, async markInsufficient() { return "applied"; },
    async discardCheckpoint() { state.discarded++; state.checkpoint = null; return "applied"; },
  } };
}
const safety = { async check() { return true; } };
function chunkModel(failOnCall) {
  let calls = 0;
  return { get calls() { return calls; }, async generate(request) {
    calls++;
    if (calls === failOnCall) throw new ModelError("BUDGET_EXHAUSTED");
    return { value: { claims: [{ text: "가상 주장", evidenceIds: request.input.reviews.map((r) => r.evidenceId) }] }, modelVersion: "potens.claude-5-sonnet", usage: null };
  } };
}

test("예산 소진은 실패가 아닌 budget_exhausted: 추가 모델 호출 없이 멈추고 중간 저장을 보존", async () => {
  const { state, repository } = repo(5);
  const model = chunkModel(2);
  const result = await runReviewSummaryStep(job, { repository, model, safety, settings, versions });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(model.calls, 2, "소진 뒤 다음 호출 없음");
  assert.equal(state.saved, 1);
  assert.equal(state.checkpoint.nextReviewIndex, 2, "처리한 묶음은 보존");
  assert.equal(state.discarded, 0, "중간 저장 폐기 없음");
});

test("예산 소진 → 명시 지연이 있으면 deferred(queued+retryAt), 실패 횟수 증가 전이를 쓰지 않음", async () => {
  const settles = [];
  const now = new Date("2026-10-01T00:00:00Z");
  const handler = createReviewSummaryHandler({ repository: repo(5).repository, model: chunkModel(1), safety, settings, versions },
    { budgetDeferMs: 60_000, now: () => now });
  const claimed = { jobId: "job-1", leaseToken: "lease-1", leaseUntil: "2026-10-01T01:00:00.000Z", failedAttempts: 2,
    reference: { kind: "review_summary", targetUserId: "user-1", sourceRevision: "7", ...versions } };
  const result = await runNextJob({ workerId: "w", registry: { review_summary: handler }, now: () => now,
    settings: { leaseDurationMs: 1000, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } },
    repository: { async claim() { return claimed; }, async settle(input) { settles.push(input); return "applied"; }, async enqueue() { throw new Error(); } } });
  assert.equal(result.status, "queued");
  assert.equal(result.reason, "budget_exhausted");
  assert.deepEqual(settles.map((s) => [s.status, s.retryAt]), [["queued", "2026-10-01T00:01:00.000Z"]]);
  const noDefer = createReviewSummaryHandler({ repository: repo(5).repository, model: chunkModel(1), safety, settings, versions });
  assert.deepEqual(await noDefer(claimed), { status: "yielded", reason: "budget_exhausted" });
});

test("실행당 한도: 정상 양보는 같은 실행에서 이어가고, 한도·예산·유휴에서 멈춤", async () => {
  const seq = (list) => { let i = 0; return async () => list[i++] ?? { status: "idle" }; };
  const signal = new AbortController().signal;
  let t = 0; const elapsedMs = () => t;
  let r = await runSummaryWorkerBatch({ maxJobsPerRun: 3, timeBudgetMs: 1000, elapsedMs, signal,
    runOne: seq([{ status: "queued" }, { status: "queued" }, { status: "succeeded" }, { status: "queued" }]) });
  assert.deepEqual([r.stopReason, r.hasMore, r.counts.yielded, r.counts.succeeded, r.counts.failed], ["max_jobs", true, 2, 1, 0]);
  r = await runSummaryWorkerBatch({ maxJobsPerRun: 9, timeBudgetMs: 1000, elapsedMs, signal,
    runOne: seq([{ status: "queued" }, { status: "queued", reason: "budget_exhausted" }, { status: "succeeded" }]) });
  assert.deepEqual([r.stopReason, r.hasMore, r.counts.claimed, r.counts.deferred], ["budget_exhausted", false, 2, 1]);
  r = await runSummaryWorkerBatch({ maxJobsPerRun: 9, timeBudgetMs: 10, elapsedMs, signal,
    runOne: async () => { t += 20; return { status: "queued" }; } });
  assert.deepEqual([r.stopReason, r.hasMore, r.counts.claimed], ["time_budget", true, 1]);
  r = await runSummaryWorkerBatch({ maxJobsPerRun: 9, timeBudgetMs: 1000, elapsedMs, signal, runOne: seq([]) });
  assert.deepEqual([r.stopReason, r.hasMore, r.counts.claimed], ["idle", false, 0]);
  await assert.rejects(runSummaryWorkerBatch({ maxJobsPerRun: 1, timeBudgetMs: 1, elapsedMs, signal, runOne: async () => { throw new Error("db"); } }));
  let n = 0;
  r = await runSummaryWorkerBatch({ maxJobsPerRun: 9, timeBudgetMs: 1000, elapsedMs, signal,
    runOne: async () => { if (n++ === 0) return { status: "succeeded" }; throw new Error("db"); } });
  assert.deepEqual([r.stopReason, r.hasMore, r.counts.succeeded], ["dependency_unavailable", false, 1]);
});

const secret = "fixture_worker_" + "b".repeat(32);
const baseEnv = {
  SUPABASE_URL: "https://project.example.invalid", SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
  INTERNAL_WORKER_SECRET: secret, ALLOWED_ORIGINS: "[]", UPSTREAM_TIMEOUT_MS: "1000", MAX_REQUEST_BYTES: "1024",
  REVIEW_SUMMARY_MODEL_VERSION: "potens.claude-5-sonnet", REVIEW_SUMMARY_PROMPT_VERSION: REVIEW_SUMMARY_PROMPT_VERSION,
};
// 가상 수치(합성 검사 전용, 운영값 아님).
const workerEnv = Object.fromEntries(Object.values(REVIEW_SUMMARY_WORKER_ENV).map((key) => [key, "5"]));
workerEnv[REVIEW_SUMMARY_WORKER_ENV.leaseSeconds] = "180"; workerEnv[REVIEW_SUMMARY_WORKER_ENV.timeBudgetMs] = "1000";
workerEnv[REVIEW_SUMMARY_WORKER_ENV.maxInputChars] = "12000"; workerEnv[REVIEW_SUMMARY_WORKER_ENV.maxOutputChars] = "300";
workerEnv[REVIEW_SUMMARY_WORKER_ENV.mergeFanIn] = "4";
workerEnv[REVIEW_SUMMARY_WORKER_ENV.maxCallsPerStep] = "3";
workerEnv[REVIEW_SUMMARY_WORKER_ENV.retryMaxAttempts] = "3";
workerEnv[REVIEW_SUMMARY_WORKER_ENV.retryBaseDelayMs] = "600000";
workerEnv[REVIEW_SUMMARY_WORKER_ENV.retryMaxDelayMs] = "21600000";
workerEnv[REVIEW_SUMMARY_WORKER_ENV.budgetDeferMs] = "3600000";
const post = (body = {}, token = secret) => new Request("https://project.example.invalid/functions/v1/review-summary-worker",
  { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body) });
function runtime(env, overrides) {
  const calls = [];
  const handler = createReviewSummaryWorkerRuntime((key) => env[key], { fetch: async (...a) => { calls.push(a[0]); throw new Error("no network"); }, ...overrides });
  return { handler, calls };
}

test("전제 미충족은 작업을 점유하지 않고 not_enabled(설정·모델·안전 검사·RPC 허용 목록)", async () => {
  const readyModel = () => ({ status: "ready", model: chunkModel(99), modelVersion: "potens.claude-5-sonnet" });
  const cases = [
    [baseEnv, {}, "WORKER_NOT_CONFIGURED"],
    [{ ...baseEnv, ...workerEnv }, {}, "MODEL_RETENTION_REVIEW_PENDING"],
    [{ ...baseEnv, ...workerEnv }, { createModel: readyModel }, "SAFETY_CHECK_NOT_APPROVED"],
    [{ ...baseEnv, ...workerEnv, REVIEW_SUMMARY_MODEL_VERSION: "other-model" }, { createModel: readyModel, safety }, "MODEL_VERSION_MISMATCH"],
    // 기본 민규 내부 클라이언트는 새 요약 RPC를 허용 목록에 두지 않았다 → 전송 전 거절, 점유 없음.
    [{ ...baseEnv, ...workerEnv }, { createModel: readyModel, safety }, "PRIVACY_CHECK_NOT_APPROVED"],
  ];
  for (const [env, overrides, reason] of cases) {
    const { handler, calls } = runtime(env, overrides);
    const response = await handler(post());
    assert.equal(response.status, 200, reason);
    assert.deepEqual((await response.json()).data, { status: "not_enabled", reason });
    assert.equal(calls.some(url => url.endsWith("/claim_job")), false, "claim 호출 없음: " + reason);
    if (reason !== "DB_RPC_UNAVAILABLE") assert.equal(calls.length, 0);
  }
});

test("요청은 실행 설정을 바꿀 수 없음: 비어 있지 않은 본문 400, 잘못된 내부 비밀 거절", async () => {
  const { handler } = runtime({ ...baseEnv, ...workerEnv }, {});
  assert.equal((await handler(post({ maxJobs: 999 }))).status, 400);
  assert.equal((await handler(post({ model: "x" }))).status, 400);
  assert.equal((await handler(post({}, "wrong_secret_" + "c".repeat(32)))).status, 403);
});

test("일일 직접 호출·상주 실행기 토큰 재사용은 같은 전역 점유를 검증하고 소유한 점유만 해제한다", async () => {
  const token = "00000000-0000-4000-8000-000000000001";
  const privacy = { decisionId: "synthetic-only", check: async () => true };
  for (const existing of [undefined, token]) {
    const calls = [];
    const db = { rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "acquire_worker_run") return { token, expiresAt: new Date(Date.now() + 180_000).toISOString() };
      if (name === "release_worker_run") return { status: "applied" };
      if (name === "claim_job") return { job: null };
      if (["yield_job", "fail_job", "supersede_job"].includes(name)) throw new HttpError("STATE_CONFLICT");
      return { status: "lease_lost" };
    } };
    const { handler } = runtime({ ...baseEnv, ...workerEnv }, { createDb: () => db,
      createModel: () => ({ status: "ready", model: chunkModel(99), modelVersion: versions.modelVersion }), safety, privacy });
    const req = post();
    if (existing) req.headers.set("x-worker-run-token", existing);
    const result = (await (await handler(req)).json()).data;
    assert.equal(result.status, "ran"); assert.equal(result.stopReason, "idle");
    const acquire = calls.find(call => call.name === "acquire_worker_run");
    assert.deepEqual(acquire.args, { p_lease_seconds: 180, p_existing_token: existing ?? null });
    assert.equal(calls.filter(call => call.name === "release_worker_run").length, existing ? 0 : 1);
    assert.equal(calls.find(call => call.name === "claim_job").args.p_worker_run_token, token);
  }
});

test("전역 점유 충돌·미허용 RPC·잘못된 토큰에서는 작업 claim을 시작하지 않는다", async () => {
  const privacy = { decisionId: "synthetic-only", check: async () => true };
  for (const blocked of ["busy", "denied"]) {
    let claims = 0;
    const db = { rpc: async name => {
      if (name === "acquire_worker_run") { if (blocked === "busy") return null; throw new HttpError("ACCESS_DENIED"); }
      if (name === "claim_job") claims++;
      if (["yield_job", "fail_job", "supersede_job"].includes(name)) throw new HttpError("STATE_CONFLICT");
      return { status: "lease_lost" };
    } };
    const { handler } = runtime({ ...baseEnv, ...workerEnv }, { createDb: () => db,
      createModel: () => ({ status: "ready", model: chunkModel(99), modelVersion: versions.modelVersion }), safety, privacy });
    const result = (await (await handler(post())).json()).data;
    assert.deepEqual(result, { status: "not_enabled", reason: blocked === "busy" ? "WORKER_RUN_BUSY" : "DB_RPC_NOT_ALLOWED" });
    assert.equal(claims, 0);
    const req = post(); req.headers.set("x-worker-run-token", "untrusted");
    assert.equal((await handler(req)).status, 400);
  }
});
