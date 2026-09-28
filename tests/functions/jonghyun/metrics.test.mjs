import assert from "node:assert/strict";
import test from "node:test";
import { createMetricsRecorder } from "../../../backend/supabase/functions/_shared/observability/metrics.ts";

const modelVersion = "synthetic-model-v1";
const promptVersion = "synthetic-prompt-v1";
function setup(overrides = {}) {
  const records = [];
  let clock = 100;
  const recorder = createMetricsRecorder({
    sink: { write: async (record) => { records.push(record); } },
    modelVersions: [modelVersion], promptVersions: [promptVersion],
    now: () => clock, ...overrides,
  });
  return { recorder, records, advance: (ms) => { clock += ms; } };
}
const valid = { resultCode: "SUCCESS", retryCount: 0 };

test("서버 생성 UUID와 허용된 처리 지표만 기록한다", async () => {
  const h = setup();
  const span = h.recorder.begin("ai_chat");
  assert.match(span.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  h.advance(23.5);
  assert.deepEqual(await span.finish({ ...valid, modelVersion, promptVersion, usage: { inputTokens: 10, outputTokens: 5 } }), { status: "recorded" });
  assert.deepEqual(h.records[0], {
    requestId: span.requestId, feature: "ai_chat", durationMs: 23.5,
    ...valid, modelVersion, promptVersion, usage: { inputTokens: 10, outputTokens: 5 },
  });
  assert.equal(Object.isFrozen(h.records[0]), true);
  assert.equal(Object.isFrozen(h.records[0].usage), true);
  assert.notEqual(h.recorder.begin("search").requestId, span.requestId);
});

test("원문·후기·개인정보·사용자 지정 requestId·metadata 필드는 기록하지 않는다", async () => {
  const h = setup();
  for (const [field, value] of Object.entries({
    message: "PRIVATE_CHAT", review: "PRIVATE_REVIEW", phone: "01012345678",
    location: "PRIVATE_ADDRESS", account: "PRIVATE_ACCOUNT", sessionToken: "SECRET_SESSION",
    requestId: "PRIVATE_REQUEST_ID", targetUserId: "user-1", metadata: { raw: "PRIVATE" },
    error: new Error("PRIVATE_ERROR"),
  })) {
    assert.deepEqual(await h.recorder.begin("search").finish({ ...valid, [field]: value }),
      { status: "rejected", code: "INVALID_METRIC" });
  }
  assert.equal(h.records.length, 0);
});

test("기능명·결과 코드·모델/프롬프트 버전으로 원문을 우회 저장할 수 없다", async () => {
  const h = setup();
  assert.throws(() => h.recorder.begin("PRIVATE_CHAT"), (error) => error.message === "INVALID_METRIC_FEATURE");
  for (const input of [
    { ...valid, resultCode: "PRIVATE_ERROR" },
    { ...valid, resultCode: new String("SUCCESS") },
    { ...valid, modelVersion: "unregistered-version" },
    { ...valid, promptVersion: "PRIVATE_PROMPT_TEXT" },
  ]) {
    assert.deepEqual(await h.recorder.begin("ai_chat").finish(input), { status: "rejected", code: "INVALID_METRIC" });
  }
  assert.equal(h.records.length, 0);
});

test("외부에서 원래 버전 배열을 수정해도 생성된 allowlist는 바뀌지 않는다", async () => {
  const models = [modelVersion];
  const prompts = [promptVersion];
  const h = setup({ modelVersions: models, promptVersions: prompts });
  models.push("PRIVATE_CHAT");
  prompts.push("PRIVATE_REVIEW");
  assert.equal((await h.recorder.begin("ai_chat").finish({ ...valid, modelVersion: "PRIVATE_CHAT" })).status, "rejected");
  assert.equal((await h.recorder.begin("ai_chat").finish({ ...valid, promptVersion: "PRIVATE_REVIEW" })).status, "rejected");
  assert.equal(h.records.length, 0);
});

test("사용량과 재시도는 유효한 개수만 받으며 내부 metadata를 거절한다", async () => {
  const h = setup();
  for (const count of [-1, 0.5, Infinity, NaN, "PRIVATE_COUNT", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await h.recorder.begin("search").finish({ ...valid, retryCount: count })).status, "rejected");
    assert.equal((await h.recorder.begin("ai_chat").finish({ ...valid, modelVersion, usage: { inputTokens: count, outputTokens: 1 } })).status, "rejected");
  }
  assert.equal((await h.recorder.begin("ai_chat").finish({ ...valid, usage: { inputTokens: 1, outputTokens: 1 } })).status, "rejected");
  assert.equal((await h.recorder.begin("ai_chat").finish({
    ...valid, modelVersion, usage: { inputTokens: 1, outputTokens: 1, raw: "PRIVATE" },
  })).status, "rejected");
  assert.equal(h.records.length, 0);
});

test("getter/심벌 필드를 실행하거나 기록하지 않는다", async () => {
  const h = setup();
  let getterCalls = 0;
  const input = { ...valid, get modelVersion() { getterCalls++; throw new Error("PRIVATE"); } };
  assert.equal((await h.recorder.begin("ai_chat").finish(input)).status, "rejected");
  assert.equal(getterCalls, 0);
  assert.equal((await h.recorder.begin("search").finish({ ...valid, [Symbol("PRIVATE")]: "SECRET" })).status, "rejected");
  assert.equal(h.records.length, 0);
});

test("sink 실패는 원문 예외를 노출하지 않고 자동 재시도하지 않는다", async () => {
  let calls = 0;
  const h = setup({ sink: { write: async () => { calls++; throw new Error("PRIVATE_CHAT phone=01012345678"); } } });
  const span = h.recorder.begin("review_summary");
  assert.deepEqual(await span.finish(valid), { status: "unavailable", code: "METRICS_SINK_UNAVAILABLE" });
  assert.deepEqual(await span.finish(valid), { status: "ignored", code: "ALREADY_FINISHED" });
  assert.equal(calls, 1);
});

test("동시에 finish를 호출해도 같은 지표를 두 번 보내지 않는다", async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const h = setup({ sink: { write: async () => { calls++; await wait; } } });
  const span = h.recorder.begin("scheduled_jobs");
  const first = span.finish(valid);
  assert.deepEqual(await span.finish(valid), { status: "ignored", code: "ALREADY_FINISHED" });
  release();
  assert.deepEqual(await first, { status: "recorded" });
  assert.equal(calls, 1);
});

test("잘못된 입력은 sink를 호출하지 않으며 올바른 입력으로 바로잡을 수 있다", async () => {
  const h = setup();
  const span = h.recorder.begin("events");
  assert.equal((await span.finish({ ...valid, resultCode: "PRIVATE" })).status, "rejected");
  assert.equal((await span.finish(valid)).status, "recorded");
  assert.equal(h.records.length, 1);
});

test("시계·설정 오류의 본문을 노출하지 않는다", async () => {
  const h = setup({ now: () => { throw new Error("PRIVATE_CLOCK_DETAIL"); } });
  assert.throws(() => h.recorder.begin("search"), (error) => error.message === "METRICS_START_UNAVAILABLE");
  const backwards = setup();
  const span = backwards.recorder.begin("search");
  backwards.advance(-1);
  assert.equal((await span.finish(valid)).status, "rejected");
  assert.equal(backwards.records.length, 0);
  assert.throws(() => createMetricsRecorder({
    sink: { write: async () => {} }, modelVersions: ["PRIVATE CHAT BODY"], promptVersions: [],
  }), (error) => error.message === "INVALID_METRICS_CONFIG");
});
