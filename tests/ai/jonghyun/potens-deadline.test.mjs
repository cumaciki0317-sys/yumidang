import test from 'node:test';
import assert from 'node:assert/strict';
import { createPotensModel } from '../../../backend/supabase/functions/_shared/ai/providers/potens-adapter.ts';
import { ModelError } from '../../../backend/supabase/functions/_shared/ai/providers/provider-errors.ts';
import { createConfiguredModel } from '../../../backend/supabase/functions/_shared/ai/providers/runtime.ts';

// 실제 네트워크·공급사·RPC 없이 현재 adapter/router/pool/runtime 소스를 소비한다.
const privateReason = 'PRIVATE_SENTINEL_DO_NOT_COPY';
const uid = '11111111-1111-4111-8111-111111111111';
const rid = '22222222-2222-4222-8222-222222222222';
const memberRequest = { userId: uid, requestId: uid, leaseToken: uid };
const request = { task: 'intent', system: 'synthetic', input: { query: 'synthetic' }, maxOutputTokens: 20, memberRequest };
const usage = { inputTokens: 10, outputTokens: 3 };
const payload = () => ({ message: '{"ok":true}', token_usage: { syntheticInput: 10, syntheticOutput: 3 } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function bounded(promise) {
  let timer;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('LOCAL_TEST_WAIT_EXCEEDED')), 1000); });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}
function model(fetch, extra = {}) {
  return createPotensModel({ apiKey: 'synthetic-key', baseUrl: 'https://ai.potens.ai', model: 'claude-5-sonnet', timeoutMs: 5,
    usageFields: { input: 'syntheticInput', output: 'syntheticOutput' }, fetch, ...extra });
}
function safeFailure(code, dispatchState = 'sent', expectedUsage = null) {
  return error => {
    assert.ok(error instanceof ModelError);
    assert.equal(error.code, code);
    assert.equal(error.dispatchState, dispatchState);
    assert.deepEqual(error.usage, expectedUsage);
    assert.equal(error.cause, undefined);
    assert.equal((error.message + error.stack + JSON.stringify(error)).includes(privateReason), false);
    for (const key of ['dispatchState', 'usage']) {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      assert.equal(descriptor.enumerable, false);
      assert.equal(descriptor.writable, false);
      assert.equal(descriptor.configurable, false);
    }
    if (error.usage) assert.equal(Object.isFrozen(error.usage), true);
    return true;
  };
}
function response(json, cancelled = () => {}) { return { status: 200, json, body: { cancel: async () => { cancelled(); } } }; }

test('사전 취소·인코더 중 취소는 원문 없는 CANCELLED/not_sent이며 공급사 함수 진입0', async () => {
  for (const stage of ['before', 'encoder-return', 'encoder-throw']) {
    const controller = new AbortController();
    let sends = 0;
    if (stage === 'before') controller.abort(privateReason);
    const adapter = model(async () => { sends++; return Response.json(payload()); }, {
      outputLimit: { decisionId: 'synthetic', apply: body => {
        controller.abort(privateReason);
        if (stage === 'encoder-throw') throw new Error(privateReason);
        return body;
      } },
    });
    await assert.rejects(adapter.generate({ ...request, signal: controller.signal }), safeFailure('CANCELLED', 'not_sent'));
    assert.equal(sends, 0);
  }
});

test('취소 신호를 무시하는 fetch도 마감에 종료하고 늦은 응답 JSON을 읽지 않고 body 취소를 요청', async () => {
  const late = deferred();
  let sends = 0, jsonCalls = 0, cancellations = 0, signal;
  const adapter = model((_url, init) => { sends++; signal = init.signal; return late.promise; });
  await assert.rejects(bounded(adapter.generate(request)), safeFailure('TIMEOUT'));
  assert.equal(signal.aborted, true);
  assert.equal(sends, 1);
  late.resolve(response(async () => { jsonCalls++; return payload(); }, () => { cancellations++; }));
  await pause(0);
  assert.equal(jsonCalls, 0);
  assert.equal(cancellations, 1);
});

test('JSON 대기가 취소를 무시해도 총 마감 뒤 usage 필드를 소비하지 않음', async () => {
  const late = deferred();
  let sends = 0, jsonCalls = 0, usageReads = 0, cancellations = 0;
  const adapter = model(async () => { sends++; return response(() => { jsonCalls++; return late.promise; }, () => { cancellations++; }); });
  await assert.rejects(bounded(adapter.generate(request)), safeFailure('TIMEOUT'));
  const value = payload();
  Object.defineProperty(value, 'token_usage', { get() { usageReads++; return { syntheticInput: 10, syntheticOutput: 3 }; } });
  late.resolve(value);
  await pause(0);
  assert.equal(sends, 1);
  assert.equal(jsonCalls, 1);
  assert.equal(usageReads, 0);
  assert.ok(cancellations >= 1);
});

test('fetch와 JSON은 각각 새 마감을 받지 않고 하나의 총 예산을 사용', async () => {
  let jsonCalls = 0;
  const adapter = model(async () => {
    await pause(30);
    return response(async () => { jsonCalls++; await pause(30); return payload(); });
  }, { timeoutMs: 50 });
  await assert.rejects(bounded(adapter.generate(request)), safeFailure('TIMEOUT'));
  assert.equal(jsonCalls, 1);
});

test('전송 후 caller 취소는 비협조 JSON에서도 sent/null이며 리스너를 제거', async () => {
  const controller = new AbortController(), started = deferred(), late = deferred();
  const signal = controller.signal;
  let added = 0, removed = 0, sends = 0;
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { added++; return add(...args); };
  signal.removeEventListener = (...args) => { removed++; return remove(...args); };
  const adapter = model(async () => { sends++; return response(() => { started.resolve(); return late.promise; }); }, { timeoutMs: 1000 });
  const pending = adapter.generate({ ...request, signal });
  await started.promise;
  controller.abort(privateReason);
  await assert.rejects(bounded(pending), safeFailure('CANCELLED'));
  late.resolve(payload());
  await pause(0);
  assert.equal(sends, 1);
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test('공급사 함수의 동기 예외와 자체 not_sent 주장은 진입 후 sent로 고정', async () => {
  for (const failure of [new Error(privateReason), new ModelError('TIMEOUT', { dispatchState: 'not_sent' })]) {
    let sends = 0;
    const adapter = model(() => { sends++; throw failure; }, { timeoutMs: 1000 });
    await assert.rejects(adapter.generate(request), safeFailure('MODEL_UNAVAILABLE'));
    assert.equal(sends, 1);
  }
});

test('마감 전 확인 usage는 형식 실패·그 뒤 취소에서 불변 metadata로 보존', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController(), value = payload();
    Object.defineProperty(value, 'message', { get() {
      if (cancel) controller.abort(privateReason);
      return 'synthetic-invalid-json';
    } });
    const adapter = model(async () => response(async () => value), { timeoutMs: 1000 });
    await assert.rejects(adapter.generate({ ...request, signal: controller.signal }), safeFailure(cancel ? 'CANCELLED' : 'INVALID_MODEL_RESPONSE', 'sent', usage));
  }
});

test('usage 필드 확인이 마감을 넘으면 늦은 usage를 확정 근거로 남기지 않음', async () => {
  const value = payload();
  Object.defineProperty(value, 'token_usage', { get() {
    const until = performance.now() + 15;
    while (performance.now() < until) { /* 합성 동기 응답 검증 지연 */ }
    return { syntheticInput: 10, syntheticOutput: 3 };
  } });
  await assert.rejects(model(async () => response(async () => value)).generate(request), safeFailure('TIMEOUT'));
});

test('정상 조기 완료는 timer·listener를 정리하고 이후 caller 취소로 결과를 바꾸지 않음', async () => {
  const controller = new AbortController();
  let removed = 0, cancellations = 0;
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.removeEventListener = (...args) => { removed++; return remove(...args); };
  const result = await model(async () => response(async () => payload(), () => { cancellations++; }), { timeoutMs: 1000 })
    .generate({ ...request, signal: controller.signal });
  controller.abort(privateReason);
  assert.deepEqual(result.usage, usage);
  assert.deepEqual(result.value, { ok: true });
  assert.equal(removed, 1);
  assert.equal(cancellations, 1);
});

const env = {
  AI_RETENTION_DECISION_ID: 'synthetic', AI_COST_EVIDENCE_ID: 'synthetic', AI_PROCESSING_LEGAL_DECISION_ID: 'synthetic',
  AI_MEMBER_TRANSMISSION_APPROVAL_ID: 'synthetic', AI_BUDGET_LEDGER_ID: 'synthetic', POTENS_ACCOUNT_ORDER: 'yumi,jonghyun',
  POTENS_API_KEY_YUMI: 'synthetic-yumi', POTENS_API_KEY_JONGHYUN: 'synthetic-jonghyun', POTENS_ACCOUNT_TOKEN_BUDGET: '3200000',
  POTENS_RESET_TIMEZONE: 'Asia/Seoul', POTENS_MODEL: 'claude-5-sonnet', POTENS_API_BASE_URL: 'https://ai.potens.ai', UPSTREAM_TIMEOUT_MS: '5',
  POTENS_USAGE_INPUT_FIELD: 'syntheticInput', POTENS_USAGE_OUTPUT_FIELD: 'syntheticOutput',
};
for (const pooled of [false, true]) for (const summary of [false, true]) {
  test(`실제 runtime→${pooled ? 'pool' : 'router'} ${summary ? '후기' : '회원'} scope는 원 예약 UNKNOWN 정산1·계정 전환0·늦은 JSON 추가 정산0`, async () => {
    const calls = [], wire = [], late = deferred();
    let usageReads = 0;
    const db = { async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'reserve_ai_chat_account_model' || name === 'reserve_review_summary_account_model')
        return { status: 'reserved', accountId: 'yumi', reservationId: rid, accountDay: '2026-10-06' };
      if (name === 'reserve_ai_chat_model' || name === 'reserve_review_summary_model') return { reservationId: rid };
      if (name === 'settle_ai_account_budget') return { settled: false, pending: true };
      if (name === 'settle_ai_budget') return { settled: true };
      throw new Error('UNEXPECTED_SYNTHETIC_RPC');
    } };
    const read = key => key === 'POTENS_API_KEY' ? 'synthetic-single' :
      !pooled && (key.startsWith('POTENS_ACCOUNT_') || key.startsWith('POTENS_API_KEY_') || key === 'POTENS_RESET_TIMEZONE') ? undefined : env[key];
    const runtime = createConfiguredModel(read, { budgetDb: db, outputLimit: { decisionId: 'synthetic', apply: body => body },
      fetch: async (_url, init) => { wire.push(init.headers.Authorization); return response(() => late.promise); } });
    assert.equal(runtime.status, 'ready'); // 합성 설정 조립 결과이며 실제 공급사 준비 증거가 아니다.
    const input = summary ? { task: 'review_chunk', system: 'synthetic', input: { reviews: [] }, maxOutputTokens: 20,
      summaryRequest: { jobId: uid, leaseToken: uid, targetUserId: uid, workerRunToken: uid, sourceRevision: '1',
        modelVersion: 'potens.claude-5-sonnet', promptVersion: 'synthetic', sourceReviewIds: [uid, rid, '33333333-3333-4333-8333-333333333333'] } } : request;
    await assert.rejects(bounded(runtime.model.generate(input)), safeFailure('TIMEOUT'));
    const reserve = summary ? 'reserve_review_summary' : 'reserve_ai_chat';
    assert.deepEqual(calls.map(call => call.name), [reserve + (pooled ? '_account_model' : '_model'), pooled ? 'settle_ai_account_budget' : 'settle_ai_budget']);
    assert.deepEqual(wire, [pooled ? 'Bearer synthetic-yumi' : 'Bearer synthetic-single']);
    if (summary) {
      assert.equal(calls[0].args.p_job_id, input.summaryRequest.jobId);
      assert.equal(calls[0].args.p_lease_token, input.summaryRequest.leaseToken);
      assert.equal(calls[0].args.p_source_revision, input.summaryRequest.sourceRevision);
      assert.deepEqual(calls[0].args.p_source_review_ids, input.summaryRequest.sourceReviewIds);
    } else {
      assert.equal(calls[0].args.p_user_id, memberRequest.userId);
      assert.equal(calls[0].args.p_request_id, memberRequest.requestId);
      assert.equal(calls[0].args.p_lease_token, memberRequest.leaseToken);
    }
    const args = calls[1].args;
    assert.equal(args.p_reservation_id, rid);
    assert.equal(args.p_outcome, 'usage_unknown');
    assert.equal(args.p_input_tokens, null);
    assert.equal(args.p_output_tokens, null);
    if (pooled) {
      assert.equal(args.p_account_id, 'yumi');
      assert.equal(args.p_account_day, '2026-10-06');
    }
    const value = payload();
    Object.defineProperty(value, 'token_usage', { get() { usageReads++; return { syntheticInput: 10, syntheticOutput: 3 }; } });
    late.resolve(value);
    await pause(10);
    assert.equal(usageReads, 0);
    assert.equal(calls.length, 2);
    assert.equal(wire.length, 1);
    assert.equal(JSON.stringify(calls).includes(privateReason), false);
  });
}
