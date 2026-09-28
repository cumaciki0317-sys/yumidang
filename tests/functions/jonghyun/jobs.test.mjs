import assert from "node:assert/strict";
import test from "node:test";
import { enqueueJob } from "../../../backend/supabase/functions/_shared/jobs/enqueue.ts";
import { runNextJob } from "../../../backend/supabase/functions/_shared/jobs/lease.ts";
import { createJobRegistry, createReviewSummaryHandler } from "../../../backend/supabase/functions/_shared/jobs/registry.ts";
import { decideRetry, JobExecutionError } from "../../../backend/supabase/functions/_shared/jobs/retry.ts";

const reference = { kind: "auto_complete", appointmentId: "appointment-1", expectedDueAt: "2026-09-23T00:00:00Z" };
const settings = { leaseDurationMs: 1000, retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 } };
// 명시적인 테스트 수치이며 운영 기본값이 아니다.
function fakeJobs() {
  let clock = Date.parse("2026-09-23T01:00:00Z");
  let token = 0;
  const rows = [];
  const writes = [];
  const repo = {
    async enqueue(input) {
      const duplicate = rows.find((row) => row.idempotencyKey === input.idempotencyKey);
      if (duplicate) return { jobId: duplicate.jobId, created: false };
      const row = { ...structuredClone(input), jobId: "job-" + (rows.length + 1), state: "queued", failedAttempts: 0 };
      rows.push(row);
      return { jobId: row.jobId, created: true };
    },
    async claim(input) {
      const row = rows.find((row) => input.kinds.includes(row.reference.kind) && Date.parse(row.runAt) <= clock &&
        (["queued", "retry_wait"].includes(row.state) || (row.state === "running" && Date.parse(row.leaseUntil) <= clock)));
      if (!row) return null;
      row.state = "running";
      row.leaseToken = "token-" + (++token);
      row.leaseUntil = new Date(clock + input.leaseDurationMs).toISOString();
      return structuredClone({
        jobId: row.jobId, reference: row.reference, leaseToken: row.leaseToken,
        leaseUntil: row.leaseUntil, failedAttempts: row.failedAttempts,
      });
    },
    async settle(input) {
      const row = rows.find((row) => row.jobId === input.jobId);
      if (!row || row.leaseToken !== input.leaseToken || Date.parse(row.leaseUntil) <= clock || row.state !== "running") return "lease_lost";
      writes.push(structuredClone(input));
      row.state = input.status;
      if (input.retryAt) row.runAt = input.retryAt;
      if (input.status === "retry_wait" || input.status === "failed") row.failedAttempts++;
      return "applied";
    },
  };
  return { repo, rows, writes, now: () => new Date(clock), advance: (ms) => { clock += ms; } };
}
function run(h, registry) {
  return runNextJob({ workerId: "worker", repository: h.repo, registry, settings, now: h.now });
}
async function add(h, ref = reference) { return enqueueJob(h.repo, ref, "2026-09-23T00:00:00Z"); }

test("동일 작업 등록은 중복되지 않고 원문·임의 필드는 저장 payload에서 제외한다", async () => {
  const h = fakeJobs();
  const first = await add(h, { ...reference, rawReview: "PRIVATE", command: "arbitrary" });
  const second = await add(h, { ...reference, expectedDueAt: "2026-09-23T09:00:00+09:00" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(h.rows.length, 1);
  assert.equal(JSON.stringify(h.rows).includes("PRIVATE"), false);
  assert.deepEqual(h.rows[0].reference, { ...reference, expectedDueAt: "2026-09-23T00:00:00.000Z" });
});

test("허용되지 않은 작업 종류·잘못된 날짜는 등록하지 않는다", async () => {
  const h = fakeJobs();
  await assert.rejects(() => add(h, { kind: "run_sql", sql: "select 1" }), /INVALID_JOB_REFERENCE/);
  await assert.rejects(() => add(h, { ...reference, expectedDueAt: "tomorrow" }), /INVALID_JOB_REFERENCE/);
  await assert.rejects(() => add(h, { ...reference, expectedDueAt: "2026-02-30T01:00:00Z" }), /INVALID_JOB_REFERENCE/);
  await assert.rejects(() => add(h, { ...reference, expectedDueAt: "2026-09-23T24:00:00Z" }), /INVALID_JOB_REFERENCE/);
  assert.equal(h.rows.length, 0);
});

test("동시 워커는 하나만 점유하고 만료 후 재점유한 토큰만 완료할 수 있다", async () => {
  const h = fakeJobs();
  await add(h);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const registry = { auto_complete: async () => { calls++; if (calls === 1) await held; return { status: "succeeded" }; } };
  const first = run(h, registry);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await run(h, registry)).status, "idle");
  h.advance(1001);
  assert.equal((await run(h, registry)).status, "succeeded");
  release();
  assert.equal((await first).status, "lease_lost");
  assert.equal(h.writes.length, 1);
});

test("일시 오류는 설정대로 재시도하고 최대 횟수에 도달하면 실패로 끝난다", async () => {
  const h = fakeJobs();
  await add(h);
  const registry = { auto_complete: async () => { throw new JobExecutionError("DEPENDENCY_UNAVAILABLE", true); } };
  assert.equal((await run(h, registry)).status, "retry_wait");
  assert.equal(h.rows[0].runAt, "2026-09-23T01:00:00.100Z");
  assert.equal((await run(h, registry)).status, "idle");
  h.advance(100);
  assert.equal((await run(h, registry)).status, "retry_wait");
  assert.equal(h.rows[0].runAt, "2026-09-23T01:00:00.300Z");
  h.advance(200);
  assert.equal((await run(h, registry)).status, "failed");
  assert.equal(h.rows[0].failedAttempts, 3);
});

test("알 수 없는 오류 본문은 상태에 저장하지 않고 영구 실패로 분류한다", async () => {
  const h = fakeJobs();
  await add(h);
  const registry = { auto_complete: async () => { throw new Error("PRIVATE_REVIEW secret user@example.com"); } };
  assert.equal((await run(h, registry)).status, "failed");
  assert.equal(h.writes[0].errorCode, "HANDLER_FAILED");
  assert.equal(JSON.stringify(h.writes).includes("PRIVATE_REVIEW"), false);
});

test("정상 분할 실행은 실패 횟수를 늘리지 않고 다시 점유할 수 있다", async () => {
  const h = fakeJobs();
  await add(h, { kind: "review_summary", targetUserId: "user-1", sourceRevision: 7 });
  let calls = 0;
  const registry = { review_summary: async () => ({ status: ++calls < 5 ? "yielded" : "succeeded" }) };
  for (let i = 0; i < 4; i++) assert.equal((await run(h, registry)).status, "queued");
  assert.equal(h.rows[0].failedAttempts, 0);
  assert.equal((await run(h, registry)).status, "succeeded");
});

test("공통 RPC의 지연 요청은 지정 시각에 재개하고 실패로 세지 않는다", async () => {
  const h = fakeJobs();
  await add(h);
  const registry = { auto_complete: async () => ({ status: "deferred", retryAt: "2026-09-23T02:00:00Z" }) };
  assert.equal((await run(h, registry)).status, "queued");
  assert.equal(h.rows[0].runAt, "2026-09-23T02:00:00.000Z");
  assert.equal(h.rows[0].failedAttempts, 0);
  assert.equal((await run(h, registry)).status, "idle");
});

test("자동 완료와 후기 공개는 예정 시각·현재 토큰을 공통 RPC에 전달한다", async () => {
  const h = fakeJobs();
  const calls = [];
  const registry = createJobRegistry({
    reviewSummary: async () => ({ status: "succeeded" }),
    eventSync: async () => ({ status: "succeeded" }),
    common: {
      autoComplete: async (input) => { calls.push(["complete", input]); return { status: "succeeded" }; },
      releaseReviews: async (input) => { calls.push(["release", input]); return { status: "succeeded" }; },
    },
  });
  await add(h);
  assert.equal((await run(h, registry)).status, "succeeded");
  await add(h, { ...reference, kind: "review_release" });
  assert.equal((await run(h, registry)).status, "succeeded");
  assert.equal(calls[0][0], "complete");
  assert.equal(calls[1][0], "release");
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ["appointmentId", "expectedDueAt", "jobId", "leaseToken"]);
  assert.equal(calls[0][1].expectedDueAt, "2026-09-23T00:00:00.000Z");
  assert.equal("completedAt" in calls[0][1], false);
  assert.equal("manualConfirmation" in calls[0][1], false);
});

test("지수 재시도 지연은 명시 상한에 묶이고 영구 오류는 즉시 끝난다", () => {
  const now = new Date("2026-09-23T00:00:00Z");
  const custom = { maxAttempts: 20, baseDelayMs: 100, maxDelayMs: 500 };
  assert.equal(decideRetry({ failedAttempts: 10, now, error: new JobExecutionError("MODEL_UNAVAILABLE", true), settings: custom }).retryAt,
    "2026-09-23T00:00:00.500Z");
  assert.equal(decideRetry({ failedAttempts: 0, now, error: new JobExecutionError("INVALID_JOB", false), settings: custom }).status, "failed");
});

test("저장소 장애 메시지는 실행기 밖으로 원문 그대로 전파하지 않는다", async () => {
  const h = fakeJobs();
  h.repo.claim = async () => { throw new Error("PRIVATE RAW request"); };
  await assert.rejects(() => run(h, { auto_complete: async () => ({ status: "succeeded" }) }),
    (error) => error.message === "DEPENDENCY_UNAVAILABLE");
});

function summaryDependencies(h, count = 3) {
  const state = {
    revision: 7, checkpoint: null, published: null, publishEffects: 0, modelCalls: 0,
    reviews: Array.from({ length: count }, (_, i) => ({ evidenceId: "r-" + i, comment: "RAW " + i })),
  };
  const current = (job, checkRevision = true) => {
    const row = h.rows.find((row) => row.jobId === job.jobId);
    if (!row || row.leaseToken !== job.leaseToken || row.state !== "running" || Date.parse(row.leaseUntil) <= h.now().getTime()) return "lease_lost";
    if (checkRevision && job.sourceRevision !== state.revision) return "stale_revision";
    return "applied";
  };
  const repository = {
    async loadSource(job) {
      if (current(job, false) === "lease_lost") return "lease_lost";
      return { targetUserId: job.targetUserId, sourceRevision: state.revision, publicTextReviews: structuredClone(state.reviews) };
    },
    async loadCheckpoint(job) {
      return current(job, false) === "lease_lost" ? "lease_lost" : structuredClone(state.checkpoint);
    },
    async saveCheckpoint(job, value) {
      const valid = current(job);
      if (valid === "applied") state.checkpoint = structuredClone(value);
      return valid;
    },
    async publish(input) {
      const valid = current(input);
      if (valid !== "applied") return valid;
      assert.equal(input.sourceReviewCount, state.reviews.length);
      assert.deepEqual([...input.sourceReviewIds].sort(), state.reviews.map((review) => review.evidenceId).sort());
      if (!state.published) {
        state.published = { ...structuredClone(input), generatedAt: h.now().toISOString() };
        state.publishEffects++;
      }
      state.checkpoint = null;
      return "applied";
    },
    async markInsufficient(job) {
      const valid = current(job);
      if (valid === "applied") state.checkpoint = null;
      return valid;
    },
    async discardCheckpoint(job) {
      const valid = current(job, false);
      if (valid === "applied") state.checkpoint = null;
      return valid;
    },
  };
  const model = {
    async generate(request) {
      state.modelCalls++;
      const records = request.input.reviews ?? request.input.summaries;
      return {
        modelVersion: "synthetic-only", usage: { inputTokens: 1, outputTokens: 1 },
        value: { claims: records.map((record) => ({ text: "가상 경험 " + record.evidenceId, evidenceIds: [record.evidenceId] })) },
      };
    },
  };
  const deps = {
    repository, model, safety: { check: async () => true },
    settings: { maxInputChars: 20000, maxReviewsPerChunk: 1, mergeFanIn: 2, maxOutputTokens: 200, maxOutputChars: 2000, maxCallsPerStep: 1 },
  };
  return { state, deps };
}
function withSummary(deps) {
  return createJobRegistry({
    reviewSummary: createReviewSummaryHandler(deps),
    eventSync: async () => ({ status: "succeeded" }),
    common: {
      autoComplete: async () => ({ status: "succeeded" }),
      releaseReviews: async () => ({ status: "succeeded" }),
    },
  });
}

test("실행기에서 요약 handler를 거쳐 분할·재점유·게시·완료까지 연결한다", async () => {
  const h = fakeJobs();
  const summary = summaryDependencies(h);
  await add(h, { kind: "review_summary", targetUserId: "user-1", sourceRevision: 7 });
  const registry = withSummary(summary.deps);
  for (let i = 0; i < 4; i++) assert.equal((await run(h, registry)).status, "queued");
  assert.equal((await run(h, registry)).status, "succeeded");
  assert.equal(summary.state.publishEffects, 1);
  assert.equal(summary.state.published.sourceReviewCount, 3);
  assert.equal(summary.state.checkpoint, null);
  assert.equal(summary.state.modelCalls, 5);
  assert.equal(h.rows[0].failedAttempts, 0);
});

test("요약 입력 부족은 작업 성공으로 끝내며 모델을 호출하지 않는다", async () => {
  const h = fakeJobs();
  const summary = summaryDependencies(h, 2);
  await add(h, { kind: "review_summary", targetUserId: "user-1", sourceRevision: 7 });
  assert.equal((await run(h, withSummary(summary.deps))).status, "succeeded");
  assert.equal(summary.state.modelCalls, 0);
});

test("요약 중 점유를 잃으면 실행기가 settle을 시도하지 않는다", async () => {
  const h = fakeJobs();
  const summary = summaryDependencies(h);
  await add(h, { kind: "review_summary", targetUserId: "user-1", sourceRevision: 7 });
  const generate = summary.deps.model.generate;
  summary.deps.model.generate = async (request) => {
    const response = await generate(request);
    h.rows[0].leaseToken = "successor-token";
    return response;
  };
  let settlements = 0;
  const settle = h.repo.settle;
  h.repo.settle = async (input) => { settlements++; return settle(input); };
  assert.equal((await run(h, withSummary(summary.deps))).status, "lease_lost");
  assert.equal(settlements, 0);
  assert.equal(summary.state.publishEffects, 0);
});

test("요약의 최신 revision 대체·일시 모델 장애·출력 거절을 작업 상태로 구분한다", async () => {
  for (const scenario of ["superseded", "unavailable", "failed"]) {
    const h = fakeJobs();
    const summary = summaryDependencies(h);
    await add(h, { kind: "review_summary", targetUserId: "user-1", sourceRevision: 7 });
    if (scenario === "superseded") summary.state.revision++;
    if (scenario === "unavailable") summary.deps.model.generate = async () => { throw new Error("RAW_SECRET"); };
    if (scenario === "failed") summary.deps.model.generate = async () => ({ modelVersion: "bad", value: { claims: [] } });
    const result = await run(h, withSummary(summary.deps));
    assert.equal(result.status, scenario === "unavailable" ? "retry_wait" : scenario);
    if (scenario === "unavailable") assert.equal(h.writes[0].errorCode, "MODEL_UNAVAILABLE");
    if (scenario === "failed") assert.equal(h.writes[0].errorCode, "HANDLER_FAILED");
    assert.equal(JSON.stringify(h.writes).includes("RAW_SECRET"), false);
  }
});

test("게시 후 settle 전 중단되어 재실행해도 게시 효과와 갱신 시각을 중복 변경하지 않는다", async () => {
  const h = fakeJobs();
  const summary = summaryDependencies(h);
  summary.deps.settings.maxCallsPerStep = 10;
  await add(h, { kind: "review_summary", targetUserId: "user-1", sourceRevision: 7 });
  const registry = withSummary(summary.deps);
  const settle = h.repo.settle;
  let first = true;
  h.repo.settle = async (input) => {
    if (first) { first = false; throw new Error("synthetic interruption"); }
    return settle(input);
  };
  await assert.rejects(() => run(h, registry), (error) => error.message === "DEPENDENCY_UNAVAILABLE");
  assert.equal(summary.state.publishEffects, 1);
  const generatedAt = summary.state.published.generatedAt;
  h.advance(settings.leaseDurationMs + 1);
  assert.equal((await run(h, registry)).status, "succeeded");
  assert.equal(summary.state.publishEffects, 1);
  assert.equal(summary.state.published.generatedAt, generatedAt);
});

test("생성자에 주입되거나 나중에 변조된 오류 코드도 원문을 저장하지 않는다", async () => {
  const direct = new JobExecutionError("RAW_SECRET", true);
  assert.equal(direct.message, "HANDLER_FAILED");
  for (const error of [direct, new JobExecutionError("MODEL_UNAVAILABLE", true)]) {
    error.code = "RAW_SECRET";
    const h = fakeJobs();
    await add(h);
    assert.equal((await run(h, { auto_complete: async () => { throw error; } })).status, "failed");
    assert.equal(h.writes[0].errorCode, "HANDLER_FAILED");
    assert.equal(JSON.stringify(h.writes).includes("RAW_SECRET"), false);
  }
});
