import assert from "node:assert/strict";
import test from "node:test";
import { runReviewSummaryStep } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/orchestrator.ts";
import { publishSummary } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/publisher.ts";
import { eligibleTextReviews } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/eligibility.ts";

const job = { jobId: "job-1", leaseToken: "lease-1", targetUserId: "user-1", sourceRevision: 7 };
const reviews = (count) => Array.from({ length: count }, (_, i) => ({ evidenceId: "r-" + (i + 1), comment: "RAW_COMMENT_" + (i + 1) }));
const settings = {
  maxInputChars: 20000, maxReviewsPerChunk: 2, mergeFanIn: 2,
  maxOutputTokens: 200, maxOutputChars: 2000, maxCallsPerStep: 1,
};

function harness(count = 5) {
  const state = {
    token: job.leaseToken, revision: 7, reviews: reviews(count), checkpoint: null,
    published: null, insufficient: false, snapshots: [], beforePublish: null,
  };
  const current = (input, checkRevision = true) =>
    input.leaseToken !== state.token ? "lease_lost" :
      checkRevision && input.sourceRevision !== state.revision ? "stale_revision" : "applied";
  const repository = {
    async loadSource(input) {
      if (current(input, false) === "lease_lost") return "lease_lost";
      return structuredClone({ targetUserId: "user-1", sourceRevision: state.revision, publicTextReviews: state.reviews });
    },
    async loadCheckpoint(input) {
      return current(input, false) === "lease_lost" ? "lease_lost" : structuredClone(state.checkpoint);
    },
    async saveCheckpoint(input, checkpoint) {
      const valid = current(input);
      if (valid !== "applied") return valid;
      state.checkpoint = structuredClone(checkpoint);
      state.snapshots.push(structuredClone(checkpoint));
      return "applied";
    },
    async publish(input) {
      state.beforePublish?.();
      const valid = current(input);
      if (valid !== "applied") return valid;
      const ids = eligibleTextReviews(state.reviews).map((review) => review.evidenceId);
      if (ids.length < 3) return "insufficient_reviews";
      if (input.sourceReviewCount !== ids.length || input.sourceReviewIds.length !== ids.length ||
          new Set(input.sourceReviewIds).size !== ids.length || input.sourceReviewIds.some((id) => !ids.includes(id))) return "invalid_evidence";
      state.published = structuredClone(input);
      state.checkpoint = null;
      return "applied";
    },
    async markInsufficient(input) {
      const valid = current(input);
      if (valid !== "applied") return valid;
      if (eligibleTextReviews(state.reviews).length >= 3) return "invalid_evidence";
      state.insufficient = true;
      state.published = null;
      state.checkpoint = null;
      return "applied";
    },
    async discardCheckpoint(input) {
      const valid = current(input, false);
      if (valid !== "applied") return valid;
      if (state.checkpoint?.sourceRevision === input.sourceRevision) state.checkpoint = null;
      return "applied";
    },
  };
  const calls = [];
  const model = {
    async generate(request) {
      calls.push(structuredClone({ ...request, signal: undefined }));
      const records = request.input.reviews ?? request.input.summaries;
      return {
        modelVersion: "synthetic-model",
        value: { claims: records.map((item) => ({ text: "가상 경험 " + item.evidenceId, evidenceIds: [item.evidenceId] })) },
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  };
  return { state, calls, deps: { repository, model, safety: { check: async () => true }, settings } };
}
async function finish(h) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await runReviewSummaryStep(job, h.deps);
    if (result.status !== "yielded") return result;
  }
  throw new Error("TEST_DID_NOT_FINISH");
}

test("공개 원문 집합의 공백/평가만 있는 행은 제외하며 3개 미만이면 모델을 호출하지 않는다", async () => {
  const h = harness(2);
  h.state.reviews.push({ evidenceId: "blank", comment: "  \n " }, { evidenceId: "rating-only", comment: null });
  const result = await runReviewSummaryStep(job, h.deps);
  assert.equal(result.status, "insufficient_reviews");
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.insufficient, true);
});

test("모든 후기 묶음을 여러 실행에 걸쳐 요약하고 raw 원문 없이 중간 생성 결과만 저장한다", async () => {
  const h = harness(5);
  const first = await runReviewSummaryStep(job, h.deps);
  assert.equal(first.status, "yielded");
  assert.equal(h.calls.length, 1);
  assert.equal(h.state.checkpoint.nextReviewIndex, 2);
  assert.equal(JSON.stringify(h.state.checkpoint).includes("RAW_COMMENT"), false);
  const result = await finish(h);
  assert.equal(result.status, "published");
  assert.equal(h.calls.filter((call) => call.task === "review_chunk").length, 3);
  assert.equal(h.calls.filter((call) => call.task === "review_merge").length, 2);
  assert.equal(h.state.published.sourceReviewCount, 5);
  assert.deepEqual([...h.state.published.sourceReviewIds].sort(), reviews(5).map((review) => review.evidenceId));
  assert.equal(h.state.published.leaseToken, "lease-1");
  assert.equal(h.state.checkpoint, null);
  assert.equal(h.state.snapshots.every((snapshot) => !JSON.stringify(snapshot).includes("RAW_COMMENT")), true);
});

test("공개되지 않은 후기는 DB 공개 조회 계약에서 제외되어 모델에 전달되지 않는다", async () => {
  const h = harness(3);
  // 가상 공개 조회 경계; 실제 DB RLS 검증이 아니다.
  const all = [...reviews(3).map((review) => ({ ...review, profilePublic: true })),
    { evidenceId: "private", comment: "PRIVATE_REVIEW", profilePublic: false }];
  h.state.reviews = all.filter((review) => review.profilePublic).map(({ evidenceId, comment }) => ({ evidenceId, comment }));
  assert.equal((await finish(h)).status, "published");
  assert.equal(JSON.stringify(h.calls).includes("PRIVATE_REVIEW"), false);
});

test("생성 도중 revision이 바뀌면 결과를 폐기하고 게시하지 않는다", async () => {
  const h = harness(3);
  const generate = h.deps.model.generate;
  h.deps.model.generate = async (request) => {
    const response = await generate(request);
    h.state.revision++;
    h.state.reviews.pop();
    return response;
  };
  assert.equal((await runReviewSummaryStep(job, h.deps)).status, "superseded");
  assert.equal(h.state.published, null);
  assert.equal(h.state.checkpoint, null);
});

test("revision이 같아도 점유 토큰을 잃은 워커는 checkpoint/게시를 할 수 없다", async () => {
  const h = harness(3);
  const generate = h.deps.model.generate;
  h.deps.model.generate = async (request) => {
    const response = await generate(request);
    h.state.token = "new-worker-token";
    return response;
  };
  assert.equal((await runReviewSummaryStep(job, h.deps)).status, "lease_lost");
  assert.equal(h.state.published, null);
  assert.equal(h.state.checkpoint, null);
});

test("게시 직전 원문 변경도 원자 게시 포트가 거절한다", async () => {
  const h = harness(3);
  h.state.beforePublish = () => { h.state.revision++; };
  assert.equal((await finish(h)).status, "superseded");
  assert.equal(h.state.published, null);
  assert.equal(h.state.checkpoint, null);
});

test("모델 장애 원문 오류는 노출하지 않고 기존 checkpoint에서 재개한다", async () => {
  const h = harness(3);
  await runReviewSummaryStep(job, h.deps);
  const snapshot = structuredClone(h.state.checkpoint);
  const generate = h.deps.model.generate;
  h.deps.model.generate = async () => { throw new Error("RAW_COMMENT SECRET user@example.com"); };
  const failed = await runReviewSummaryStep(job, h.deps);
  assert.deepEqual(failed, { status: "unavailable", code: "MODEL_UNAVAILABLE" });
  assert.deepEqual(h.state.checkpoint, snapshot);
  h.deps.model.generate = generate;
  assert.equal((await finish(h)).status, "published");
});

test("가짜·누락·중복 근거 ID는 폐기하고 게시하지 않는다", async () => {
  for (const evidenceIds of [["foreign"], ["r-1"], ["r-1", "r-1", "r-2"]]) {
    const h = harness(3);
    h.deps.model.generate = async () => ({ modelVersion: "bad-model", value: { claims: [{ text: "가상 주장", evidenceIds }] } });
    const result = await runReviewSummaryStep(job, h.deps);
    assert.equal(result.status, "failed");
    assert.equal(h.state.published, null);
    assert.equal(h.state.checkpoint, null);
  }
});

test("ID가 맞아도 의미·개인정보 검사기가 거절하면 게시하지 않는다", async () => {
  const h = harness(3);
  h.deps.safety.check = async () => false;
  assert.deepEqual(await runReviewSummaryStep(job, h.deps), { status: "failed", code: "UNSAFE_SUMMARY_OUTPUT" });
  assert.equal(h.state.published, null);
});

test("잘못된 checkpoint를 신뢰하지 않고 삭제한다", async () => {
  const h = harness(3);
  await runReviewSummaryStep(job, h.deps);
  h.state.checkpoint.sourceReviewIds[0] = "foreign";
  assert.deepEqual(await runReviewSummaryStep(job, h.deps), { status: "failed", code: "INVALID_SUMMARY_CHECKPOINT" });
  assert.equal(h.state.checkpoint, null);
  assert.equal(h.calls.length, 1);
});

test("한도를 넘는 단일 후기를 자르거나 일부 제외하지 않는다", async () => {
  const h = harness(3);
  h.state.reviews[0].comment = "긴 후기 ".repeat(10000);
  assert.deepEqual(await runReviewSummaryStep(job, h.deps), { status: "failed", code: "SUMMARY_INPUT_TOO_LARGE" });
  assert.equal(h.calls.length, 0);
});

test("게시 인자의 실제 사용 수·중복 근거 불일치를 DB 호출 전에 거절한다", async () => {
  const h = harness(3);
  const valid = {
    ...job, summaryText: "가상 요약", claims: [{ text: "가상 요약", evidenceIds: ["r-1", "r-2", "r-3"] }],
    sourceReviewIds: ["r-1", "r-2", "r-3"], sourceReviewCount: 3, promptVersion: "v1", modelVersions: ["synthetic"],
  };
  await assert.rejects(() => publishSummary(h.deps.repository, { ...valid, sourceReviewCount: 4 }, ["r-1", "r-2", "r-3"]), /INVALID_SUMMARY_PUBLICATION/);
  await assert.rejects(() => publishSummary(h.deps.repository, { ...valid, sourceReviewIds: ["r-1", "r-1", "r-3"] }, ["r-1", "r-2", "r-3"]), /INVALID_SUMMARY_PUBLICATION/);
  assert.equal(h.state.published, null);
});

test("취소된 실행은 새 모델 호출 없이 이어할 상태로 남긴다", async () => {
  const h = harness(3);
  h.deps.signal = AbortSignal.abort();
  assert.equal((await runReviewSummaryStep(job, h.deps)).status, "yielded");
  assert.equal(h.calls.length, 0);
});

test("운영 수치는 명시 설정이 없으면 실행하지 않는다", async () => {
  const h = harness(3);
  h.deps.settings = { ...settings, maxCallsPerStep: undefined };
  await assert.rejects(() => runReviewSummaryStep(job, h.deps), /INVALID_SUMMARY_SETTINGS/);
});
