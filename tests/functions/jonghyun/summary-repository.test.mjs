import assert from "node:assert/strict";
import test from "node:test";
import { createRpcJobRepository, normalizeDbInstant, JOB_ERROR_TO_DB } from "../../../backend/supabase/functions/_shared/db/repositories/jobs.ts";
import { createRpcReviewSummaryRepository } from "../../../backend/supabase/functions/_shared/db/repositories/review-summaries.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";

// 가상 RPC 응답만 사용한다. 실제 DB 동작은 tests/database/jonghyun/review_summary_worker.sql이 검사한다.
const JOB = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const WORKER = "33333333-3333-4333-8333-333333333333";
const PROFILE = "44444444-4444-4444-8444-444444444444";
const R = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003"];
const BIG = "9007199254740993";
const job = { jobId: JOB, leaseToken: TOKEN, targetUserId: PROFILE, sourceRevision: BIG, modelVersion: "potens.synthetic", promptVersion: "review-summary-v1" };

function fakeDb(responses) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args: structuredClone(args) });
      const next = responses[name];
      const value = typeof next === "function" ? next(args) : next;
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
  };
}
const claimRow = (overrides = {}) => ({ job: {
  jobId: JOB, kind: "review_summary", leaseToken: TOKEN, leaseExpiresAt: "2026-09-29T13:08:00.123456+00:00",
  attempt: 3, failedAttempts: 1,
  payload: { profileId: PROFILE, sourceRevision: BIG, modelVersion: "potens.synthetic", promptVersion: "review-summary-v1" },
  ...overrides,
} });

test("claim은 DB 이름을 내부 계약으로 명시 변환하고 큰 revision을 문자열로 유지한다", async () => {
  const db = fakeDb({ claim_job: claimRow() });
  const claimed = await createRpcJobRepository(db).claim({ workerId: WORKER, kinds: ["review_summary"], leaseDurationMs: 60_000 });
  assert.deepEqual(db.calls, [{ name: "claim_job", args: { p_worker_id: WORKER, p_lease_seconds: 60 } }]);
  assert.deepEqual(claimed, {
    jobId: JOB, leaseToken: TOKEN, leaseUntil: "2026-09-29T13:08:00.123Z", failedAttempts: 1,
    reference: { kind: "review_summary", targetUserId: PROFILE, sourceRevision: BIG, modelVersion: "potens.synthetic", promptVersion: "review-summary-v1" },
  });
});

test("claim은 빈 결과·요청하지 않은 kind·잘못된 wire를 구분한다", async () => {
  assert.equal(await createRpcJobRepository(fakeDb({ claim_job: { job: null } })).claim({ workerId: WORKER, kinds: ["review_summary"], leaseDurationMs: 1000 }), null);
  const untouched = fakeDb({ claim_job: claimRow() });
  assert.equal(await createRpcJobRepository(untouched).claim({ workerId: WORKER, kinds: ["event_sync"], leaseDurationMs: 1000 }), null);
  assert.equal(untouched.calls.length, 0, "DB가 지원하지 않는 kind만 요청하면 점유하지 않는다");
  for (const bad of [
    claimRow({ failedAttempts: -1 }), claimRow({ failedAttempts: "1" }), claimRow({ extra: "RAW" }),
    claimRow({ payload: { profileId: PROFILE, sourceRevision: 7, modelVersion: "m", promptVersion: "p" } }),
    claimRow({ leaseExpiresAt: "tomorrow" }), claimRow({ kind: "event_sync" }),
  ]) {
    await assert.rejects(createRpcJobRepository(fakeDb({ claim_job: bad })).claim({ workerId: WORKER, kinds: ["review_summary"], leaseDurationMs: 1000 }), /INVALID_JOB_RESPONSE/);
  }
  for (const input of [{ workerId: "worker", kinds: ["review_summary"], leaseDurationMs: 1000 },
    { workerId: WORKER, kinds: ["review_summary"], leaseDurationMs: 1500 }, { workerId: WORKER, kinds: ["review_summary"], leaseDurationMs: 0 }]) {
    await assert.rejects(createRpcJobRepository(fakeDb({})).claim(input), /INVALID_CLAIM_INPUT/);
  }
});

test("settle은 상태별 RPC로 나누고 정상 양보는 실패 횟수 RPC를 쓰지 않는다", async () => {
  const cases = [
    [{ status: "succeeded" }, "complete_job", {}],
    [{ status: "queued" }, "yield_job", { p_available_at: null }],
    [{ status: "queued", retryAt: "2026-09-30T00:00:00Z" }, "yield_job", { p_available_at: "2026-09-30T00:00:00.000Z" }],
    [{ status: "retry_wait", retryAt: "2026-09-30T00:00:00Z", errorCode: "MODEL_UNAVAILABLE" }, "retry_job",
      { p_available_at: "2026-09-30T00:00:00.000Z", p_error_code: "UPSTREAM_UNAVAILABLE" }],
    [{ status: "failed", errorCode: "HANDLER_FAILED" }, "fail_job", { p_error_code: "INTERNAL_ERROR" }],
    [{ status: "superseded" }, "supersede_job", {}],
  ];
  for (const [input, name, extra] of cases) {
    const expectedStatus = input.status;
    const db = fakeDb({ [name]: { jobId: JOB, status: expectedStatus } });
    assert.equal(await createRpcJobRepository(db).settle({ jobId: JOB, leaseToken: TOKEN, ...input }), "applied");
    assert.deepEqual(db.calls, [{ name, args: { p_job_id: JOB, p_lease_token: TOKEN, ...extra } }]);
  }
  assert.deepEqual(Object.keys(JOB_ERROR_TO_DB).sort(), ["DEPENDENCY_UNAVAILABLE", "HANDLER_FAILED", "INVALID_JOB", "MODEL_UNAVAILABLE"]);
});

test("settle의 state_conflict만 lease_lost이며 다른 오류·잘못된 응답·원문 코드는 숨기지 않는다", async () => {
  const lost = fakeDb({ complete_job: new HttpError("STATE_CONFLICT") });
  assert.equal(await createRpcJobRepository(lost).settle({ jobId: JOB, leaseToken: TOKEN, status: "succeeded" }), "lease_lost");
  await assert.rejects(createRpcJobRepository(fakeDb({ complete_job: new HttpError("EXTERNAL_UNAVAILABLE") }))
    .settle({ jobId: JOB, leaseToken: TOKEN, status: "succeeded" }));
  await assert.rejects(createRpcJobRepository(fakeDb({ complete_job: { jobId: JOB, status: "queued" } }))
    .settle({ jobId: JOB, leaseToken: TOKEN, status: "succeeded" }), /INVALID_JOB_RESPONSE/);
  const raw = fakeDb({});
  await assert.rejects(createRpcJobRepository(raw).settle({ jobId: JOB, leaseToken: TOKEN, status: "failed", errorCode: "PRIVATE RAW" }), /INVALID_SETTLEMENT/);
  await assert.rejects(createRpcJobRepository(raw).settle({ jobId: JOB, leaseToken: TOKEN, status: "retry_wait", errorCode: "DEPENDENCY_UNAVAILABLE" }), /INVALID_SETTLEMENT/);
  assert.equal(raw.calls.length, 0);
});

test("enqueue는 targetUserId를 profileId로 바꾸고 원문·임의 필드를 보내지 않는다", async () => {
  const db = fakeDb({ enqueue_job: { jobId: JOB, deduplicated: true, status: "queued" } });
  const reference = { kind: "review_summary", targetUserId: PROFILE, sourceRevision: BIG, modelVersion: "m1", promptVersion: "p1" };
  const result = await createRpcJobRepository(db).enqueue({ reference: { ...reference, rawReview: "PRIVATE" }, idempotencyKey: "review_summary:x:1:m1:p1", runAt: "2026-09-29T00:00:00Z" });
  assert.deepEqual(result, { jobId: JOB, created: false });
  assert.deepEqual(db.calls[0].args.p_payload, { profileId: PROFILE, sourceRevision: BIG, modelVersion: "m1", promptVersion: "p1" });
  assert.equal(JSON.stringify(db.calls).includes("PRIVATE"), false);
  await assert.rejects(createRpcJobRepository(db).enqueue({ reference: { kind: "event_sync", provider: "kopis", windowStart: "x", windowEnd: "y" }, idempotencyKey: "k", runAt: "2026-09-29T00:00:00Z" }), /UNSUPPORTED_JOB_KIND/);
});

test("DB 마이크로초 시각은 밀리초로 내림 변환한다(만료 이후로 늘리지 않음)", () => {
  assert.equal(normalizeDbInstant("2026-09-29T13:08:00.999999+00:00"), "2026-09-29T13:08:00.999Z");
  assert.equal(normalizeDbInstant("2026-09-29T22:08:00+09:00"), "2026-09-29T13:08:00.000Z");
  assert.equal(normalizeDbInstant("2026-09-29T13:08:00.5Z"), "2026-09-29T13:08:00.500Z");
  assert.throws(() => normalizeDbInstant("2026-09-29"), /INVALID_JOB_RESPONSE/);
});

test("loadSource는 reviewId→evidenceId, text→comment, profileId→targetUserId로 변환한다", async () => {
  const db = fakeDb({ load_review_summary_source: {
    status: "applied", profileId: PROFILE, sourceRevision: BIG, eligibleCount: 3,
    reviews: R.map((reviewId, i) => ({ reviewId, text: "가상 후기 " + i })),
  } });
  const repo = createRpcReviewSummaryRepository(db);
  assert.deepEqual(await repo.loadSource(job), {
    targetUserId: PROFILE, sourceRevision: BIG,
    publicTextReviews: R.map((evidenceId, i) => ({ evidenceId, comment: "가상 후기 " + i })),
  });
  assert.deepEqual(db.calls[0], { name: "load_review_summary_source", args: { p_job_id: JOB, p_lease_token: TOKEN } });
  for (const status of ["lease_lost", "already_published", "stale_revision"]) {
    assert.equal(await createRpcReviewSummaryRepository(fakeDb({ load_review_summary_source: { status } })).loadSource(job), status);
  }
  for (const bad of [
    { status: "applied", profileId: PROFILE, sourceRevision: 7, eligibleCount: 0, reviews: [] },
    { status: "applied", profileId: PROFILE, sourceRevision: BIG, eligibleCount: 2, reviews: [{ reviewId: R[0], text: "x" }] },
    { status: "applied", profileId: PROFILE, sourceRevision: BIG, eligibleCount: 1, reviews: [{ reviewId: R[0], text: "x", reviewer: "PRIVATE" }] },
    { status: "applied", profileId: "other", sourceRevision: BIG, eligibleCount: 0, reviews: [] },
    { status: "surprise" },
  ]) {
    await assert.rejects(createRpcReviewSummaryRepository(fakeDb({ load_review_summary_source: bad })).loadSource(job), /INVALID_SUMMARY_RESPONSE/);
  }
});

test("checkpoint 저장은 원문 없는 허용 필드만 보내고 조회는 작업 버전과 일치해야 한다", async () => {
  const checkpoint = {
    schemaVersion: 1, targetUserId: PROFILE, sourceRevision: BIG, modelVersion: job.modelVersion, promptVersion: job.promptVersion,
    sourceReviewIds: R, nextReviewIndex: 2,
    nodes: [{ sourceReviewIds: R.slice(0, 2), claims: [{ text: "가상 주장", evidenceIds: R.slice(0, 2), rawComment: "PRIVATE" }], modelVersions: ["potens.synthetic"] }],
  };
  const db = fakeDb({
    save_review_summary_checkpoint: { status: "applied" },
    load_review_summary_checkpoint: { status: "applied", checkpoint: {
      profileId: PROFILE, sourceRevision: BIG, modelVersion: job.modelVersion, promptVersion: job.promptVersion,
      schemaVersion: 1, sourceReviewIds: R, nextReviewIndex: 2,
      nodes: [{ sourceReviewIds: R.slice(0, 2), claims: [{ text: "가상 주장", evidenceIds: R.slice(0, 2) }], modelVersions: ["potens.synthetic"] }],
    } },
  });
  const repo = createRpcReviewSummaryRepository(db);
  assert.equal(await repo.saveCheckpoint(job, checkpoint), "applied");
  const sent = db.calls[0].args;
  assert.deepEqual(Object.keys(sent).sort(), ["p_checkpoint", "p_job_id", "p_lease_token", "p_source_revision"]);
  assert.equal(sent.p_source_revision, BIG);
  assert.deepEqual(Object.keys(sent.p_checkpoint).sort(), ["nextReviewIndex", "nodes", "schemaVersion", "sourceReviewIds"]);
  assert.equal(JSON.stringify(sent).includes("PRIVATE"), false);
  const loaded = await repo.loadCheckpoint(job);
  assert.deepEqual(loaded, { ...checkpoint, nodes: [{ ...checkpoint.nodes[0], claims: [{ text: "가상 주장", evidenceIds: R.slice(0, 2) }] }] });
  await assert.rejects(repo.saveCheckpoint(job, { ...checkpoint, sourceRevision: "1" }), /INVALID_SUMMARY_CHECKPOINT/);
  const stale = fakeDb({ load_review_summary_checkpoint: { status: "stale_revision" }, save_review_summary_checkpoint: { status: "stale_revision" } });
  assert.equal(await createRpcReviewSummaryRepository(stale).loadCheckpoint(job), "stale_revision");
  assert.equal(await createRpcReviewSummaryRepository(stale).saveCheckpoint(job, checkpoint), "stale_revision");
  const other = fakeDb({ load_review_summary_checkpoint: { status: "applied", checkpoint: { ...(await db.rpc("load_review_summary_checkpoint", {})).checkpoint, modelVersion: "other" } } });
  await assert.rejects(createRpcReviewSummaryRepository(other).loadCheckpoint(job), /INVALID_SUMMARY_RESPONSE/);
});

test("publish·부족·폐기는 DB 상태를 안전한 결과로 옮기고 게시 응답을 검사한다", async () => {
  const input = { ...job, summaryText: "가상 요약", claims: [{ text: "가상 요약", evidenceIds: R }], sourceReviewIds: R,
    sourceReviewCount: 3, modelVersions: ["potens.synthetic"] };
  const db = fakeDb({ publish_review_summary_for_job: { status: "applied", summaryId: JOB, sourceRevision: BIG, sourceCount: 3, publishedAt: "2026-09-29T00:00:00+00:00" } });
  assert.equal(await createRpcReviewSummaryRepository(db).publish(input), "applied");
  assert.deepEqual(db.calls[0].args, {
    p_job_id: JOB, p_lease_token: TOKEN, p_source_revision: BIG, p_evidence_review_ids: R, p_summary: "가상 요약",
    p_model_version: job.modelVersion, p_prompt_version: job.promptVersion,
  });
  for (const status of ["lease_lost", "stale_revision", "insufficient_reviews", "invalid_evidence"]) {
    assert.equal(await createRpcReviewSummaryRepository(fakeDb({ publish_review_summary_for_job: { status } })).publish(input), status);
    assert.equal(await createRpcReviewSummaryRepository(fakeDb({ mark_review_summary_insufficient: { status } })).markInsufficient(job), status);
  }
  await assert.rejects(createRpcReviewSummaryRepository(fakeDb({ publish_review_summary_for_job: { status: "applied", summaryId: JOB, sourceRevision: "1", sourceCount: 3, publishedAt: "x" } })).publish(input), /INVALID_SUMMARY_RESPONSE/);
  assert.equal(await createRpcReviewSummaryRepository(fakeDb({ discard_review_summary_checkpoint: { status: "lease_lost" } })).discardCheckpoint(job), "lease_lost");
  await assert.rejects(createRpcReviewSummaryRepository(fakeDb({ discard_review_summary_checkpoint: { status: "stale_revision" } })).discardCheckpoint(job), /INVALID_SUMMARY_RESPONSE/);
  await assert.rejects(createRpcReviewSummaryRepository(fakeDb({})).publish({ ...input, sourceReviewIds: ["r-1", "r-2", "r-3"] }), /INVALID_SUMMARY_JOB|INVALID_SUMMARY_PUBLICATION/);
  await assert.rejects(createRpcReviewSummaryRepository(fakeDb({})).loadSource({ ...job, sourceRevision: 7 }), /INVALID_SUMMARY_JOB/);
});
