// 현재 계약/DB reader/내부 transport의 합성 검사. native SQL/Auth/DB 실행 증거가 아니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAiResultState, AiInputError } from '../../../backend/supabase/functions/_shared/contracts/ai.ts';
import { createRpcAiResultStateReader } from '../../../backend/supabase/functions/_shared/db/ai-feedback-client.ts';
import { createInternalClient } from '../../../backend/supabase/functions/_shared/db/internal-client.ts';
import { toPublicError, HttpError } from '../../../backend/supabase/functions/_shared/http/errors.ts';
import { getEventListeners } from 'node:events';
const userId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const available = { requestId, status: 'available', availableAt: '2026-10-14T20:00:00.123456+00:00', helpfulAllowed: true };
const invalid = error => { assert.ok(error instanceof AiInputError); assert.equal(error.message, 'INVALID_AI_RESULT_STATE'); return true; };
const code = expected => error => { assert.equal(toPublicError(error).error.code, expected); return true; };

test('원 결과 ID의 정확한 세 상태만 읽고 pending/unavailable은 평가 허용·준비시각이 없다', () => {
  assert.deepEqual(readAiResultState(available, requestId), available);
  for (const status of ['pending', 'unavailable']) {
    const row = { requestId, status, availableAt: null, helpfulAllowed: false };
    assert.deepEqual(readAiResultState(row, requestId), row);
  }
  assert.throws(() => readAiResultState(available, other), invalid);
});
test('공통 parser는 숨은 상태 주장·원문·여분 필드·날짜/권한 모순을 거절한다', () => {
  for (const row of [null, [], {}, { ...available, body: 'PRIVATE_BODY' }, { ...available, seen: true },
    { ...available, status: { toString: () => 'available' } }, { ...available, helpfulAllowed: 'true' },
    { ...available, availableAt: null }, { ...available, availableAt: '2026-02-30T00:00:00Z' },
    { ...available, availableAt: '2026-10-14T25:00:00Z' }, { ...available, availableAt: 'PRIVATE_BODY' },
    { ...available, status: 'pending' }, { ...available, status: 'unavailable', helpfulAllowed: false },
    { ...available, status: 'finished' }, { ...available, requestId: other }]) {
    assert.throws(() => readAiResultState(row, requestId), invalid);
  }
});
test('표준 PG 마이크로초·시간대와 윤년을 허용하며 getter 예외를 고정 입력 오류로 감싼다', () => {
  for (const availableAt of ['2024-02-29T23:59:59Z', '2026-10-14T20:00:00.123456+09:00']) {
    assert.equal(readAiResultState({ ...available, availableAt }, requestId).availableAt, availableAt);
  }
  const row = { ...available };
  let reads = 0;
  Object.defineProperty(row, 'status', { enumerable: true, get() { reads++; throw Error('PRIVATE_BODY'); } });
  assert.throws(() => readAiResultState(row, requestId), invalid);
  assert.equal(reads, 0);
  for (const key of ['hidden', Symbol('hidden')]) {
    const hidden = { ...available };
    Object.defineProperty(hidden, key, { value: 'PRIVATE_BODY' });
    assert.throws(() => readAiResultState(hidden, requestId), invalid);
  }
});
test('DB reader는 인증 문맥의 user/원request만 RPC1회에 전달하고 새 HTTP context를 요구하지 않는다', async () => {
  const calls = [];
  const reader = createRpcAiResultStateReader({ async rpc(name, args) { calls.push({ name, args }); return available; } });
  assert.deepEqual(await reader.get(userId.toUpperCase(), requestId.toUpperCase()), available);
  assert.deepEqual(calls, [{ name: 'get_ai_result_state', args: { p_user_id: userId, p_request_id: requestId } }]);
  await assert.rejects(reader.get('invalid', requestId), code('AUTH_REQUIRED'));
  await assert.rejects(reader.get(userId, 'invalid'), code('INVALID_REQUEST'));
  assert.equal(calls.length, 1);
});
test('DB reader는 parser 실패만503으로 정규화하고 원404/transport유실을 반복하지 않는다', async () => {
  for (const row of [{ ...available, requestId: other }, { ...available, helpfulAllowed: false }, { ...available, transcript: 'PRIVATE_BODY' }]) {
    await assert.rejects(createRpcAiResultStateReader({ rpc: async () => row }).get(userId, requestId), code('EXTERNAL_UNAVAILABLE'));
  }
  for (const expected of ['RESOURCE_NOT_FOUND', 'EXTERNAL_UNAVAILABLE']) {
    let calls = 0;
    const error = new HttpError(expected);
    const reader = createRpcAiResultStateReader({ async rpc() { calls++; throw error; } });
    await assert.rejects(reader.get(userId, requestId), value => value === error);
    assert.equal(calls, 1);
  }
});
test('읽기 caller 취소는 사전RPC0·진입후RPC1이며 늦은 DTO/본문을 소비하지 않는다', async () => {
  let calls = 0, resolve, entered, reads = 0;
  const controller = new AbortController();
  const started = new Promise(done => { entered = done; });
  const late = new Promise(done => { resolve = done; });
  const reader = createRpcAiResultStateReader({ async rpc() { calls++; entered(); return late; } });
  const before = new AbortController(); before.abort('PRIVATE_BODY');
  await assert.rejects(reader.get(userId, requestId, before.signal), code('EXTERNAL_UNAVAILABLE'));
  assert.equal(calls, 0);
  const pending = reader.get(userId, requestId, controller.signal);
  await started; controller.abort('PRIVATE_BODY');
  await assert.rejects(pending, code('EXTERNAL_UNAVAILABLE'));
  const row = { ...available };
  Object.defineProperty(row, 'status', { enumerable: true, get() { reads++; return 'available'; } });
  resolve(row); await new Promise(done => setTimeout(done, 0));
  assert.equal(calls, 1); assert.equal(reads, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
test('실제 내부 allowlist/transport는새읽기만전달하고POST RPC body에원문·모델범위가없다', async () => {
  const calls = [];
  const db = createInternalClient({ supabaseUrl: 'https://synthetic.invalid', supabaseAnonKey: 'synthetic-anon',
    supabaseServiceRoleKey: 'synthetic-service', internalWorkerSecret: 'synthetic_worker_secret_longer_than_32_chars', upstreamTimeoutMs: 1000 }, async (url, init) => {
    calls.push({ url: String(url), method: init.method, args: JSON.parse(init.body) });
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-service');
    return Response.json(available);
  });
  assert.equal(db.supportsRpc('get_ai_result_state'), true);
  assert.deepEqual(await createRpcAiResultStateReader(db).get(userId, requestId), available);
  assert.deepEqual(calls, [{ url: 'https://synthetic.invalid/rest/v1/rpc/get_ai_result_state', method: 'POST',
    args: { p_user_id: userId, p_request_id: requestId } }]);
  await assert.rejects(db.rpc('get_any_ai_result', {}), code('ACCESS_DENIED'));
  assert.equal(calls.length, 1);
});
