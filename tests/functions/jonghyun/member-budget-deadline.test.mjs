// 실제 drain/factory 코드와 합성 예산 포트의 검사. 실제 DB/Auth/Storage 호출은0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { drainMemberCleanupTasks, createMemberCleanupExecutor } from '../../../backend/supabase/functions/_shared/services/member-lifecycle-service.ts';
import { HttpError, toPublicError } from '../../../backend/supabase/functions/_shared/http/errors.ts';
const token = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const conflict = error => { assert.equal(toPublicError(error).error.code, 'STATE_CONFLICT'); assert.doesNotMatch(String(error.stack), /SYNTHETIC_PRIVATE_REASON/); return true; };
async function bounded(promise) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('TEST_OBSERVATION_EXPIRED')), 500); })]); } finally { clearTimeout(timer); } }

test('비협조 예산 조회는 로컬 마감에 종료하고 늦은 예산을 task 근거로 쓰지 않는다', async () => {
  const late = deferred(); let signal, tasks = 0, reads = 0;
  const run = drainMemberCleanupTasks(token, async (id, value) => { reads++; assert.equal(id, token.toLowerCase()); signal = value; return late.promise; }, async () => { tasks++; return { status: 'applied' }; }, undefined, { maxExecutionMs: 5 });
  await assert.rejects(bounded(run), conflict);
  assert.equal(signal.aborted, true); assert.equal(getEventListeners(signal, 'abort').length, 0);
  late.resolve({ deadlineAt: Date.now() + 180000 }); await pause(5);
  assert.equal(reads, 1); assert.equal(tasks, 0);
});

test('조회 중 호출자 취소는 즉시 종료하고 늦은 거절도 새 조회·task로 연결하지 않는다', async () => {
  const late = deferred(), entered = deferred(), caller = new AbortController(); let signal, reads = 0, tasks = 0;
  const run = drainMemberCleanupTasks(token, async (_id, value) => { reads++; signal = value; entered.resolve(); return late.promise; }, async () => { tasks++; return { status: 'applied' }; }, caller.signal);
  await entered.promise; caller.abort('SYNTHETIC_PRIVATE_REASON');
  await assert.rejects(bounded(run), conflict);
  late.reject(Error('SYNTHETIC_PRIVATE_REASON')); await pause(5);
  assert.equal(getEventListeners(signal, 'abort').length, 0); assert.equal(reads, 1); assert.equal(tasks, 0);
});

test('명시 옵션이 없어도 예산 조회부터 기본180초 상한을 적용한다', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const late = deferred(), entered = deferred(); let signal, tasks = 0, terminal = false;
  const run = drainMemberCleanupTasks(token, async (_id, value) => { signal = value; entered.resolve(); return late.promise; }, async () => { tasks++; return { status: 'applied' }; });
  const checked = assert.rejects(run, conflict).then(() => { terminal = true; });
  await entered.promise; t.mock.timers.tick(179999); await Promise.resolve(); assert.equal(terminal, false); assert.equal(signal.aborted, false);
  t.mock.timers.tick(1); await checked;
  assert.equal(signal.aborted, true); assert.equal(tasks, 0); assert.equal(getEventListeners(signal, 'abort').length, 0);
  late.resolve({ deadlineAt: Date.now() + 180000 });
});

for (const mode of ['fetch', 'json']) test(`실제 factory의 합성 ${mode} 지연도 로컬 마감 뒤 claim/DELETE/ACK0`, async () => {
  const late = deferred(), calls = []; let signal;
  const config = { supabaseUrl: 'https://cleanup.example.invalid', supabaseAnonKey: 'synthetic-anon', supabaseServiceRoleKey: 'synthetic-service', internalWorkerSecret: 'synthetic_worker_secret_longer_than_32_characters', upstreamTimeoutMs: 1000 };
  const run = createMemberCleanupExecutor(config, async (url, init) => {
    calls.push(String(url).split('/').at(-1)); signal = init.signal;
    assert.equal(calls.at(-1), 'read_worker_run_budget');
    if (mode === 'fetch') return late.promise;
    return { status: 200, json: () => late.promise };
  }, { maxExecutionMs: 5 });
  await assert.rejects(bounded(run(token)), conflict);
  assert.equal(signal.aborted, true);
  late.resolve(mode === 'fetch' ? Response.json({ remainingMs: 180000 }) : { remainingMs: 180000 });
  await pause(5); assert.deepEqual(calls, ['read_worker_run_budget']);
});

test('정상 예산 또는 원 예산 오류에서 리스너를 해제하고 오류 계약을 유지한다', async () => {
  let signal, tasks = 0;
  assert.deepEqual(await drainMemberCleanupTasks(token, async (_id, value) => { signal = value; return { deadlineAt: Date.now() + 59000 }; }, async () => { tasks++; return { status: 'applied' }; }), { status: 'ran', claimed: 0, succeeded: 0 });
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  const original = new HttpError('ACCESS_DENIED');
  await assert.rejects(drainMemberCleanupTasks(token, async (_id, value) => { signal = value; throw original; }, async () => { tasks++; return { status: 'applied' }; }), error => error === original);
  assert.equal(getEventListeners(signal, 'abort').length, 0); assert.equal(tasks, 0);
});

test('사전 취소는 예산 조회·task0이며 원문 사유를 공개 오류에 넣지 않는다', async () => {
  const controller = new AbortController(); controller.abort('SYNTHETIC_PRIVATE_REASON'); let reads = 0, tasks = 0;
  await assert.rejects(drainMemberCleanupTasks(token, async () => { reads++; return {}; }, async () => { tasks++; return { status: 'applied' }; }, controller.signal), conflict);
  assert.equal(reads, 0); assert.equal(tasks, 0);
});
