import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfiguredQueueRuntime } from '../../../backend/supabase/functions/_shared/jobs/runtime.ts';
import { createSharedBackgroundQueueScheduler } from '../../../backend/supabase/functions/_shared/jobs/background.mjs';
import { createMemberParentFinalizationScanner } from '../../../backend/supabase/functions/_shared/db/member-cleanup-finalization.ts';
import { createRpcTransport, type RpcClient } from '../../../backend/supabase/functions/_shared/db/transport.ts';
import { loadRuntimeConfig } from '../../../backend/supabase/functions/_shared/config/env.ts';
import type { JsonValue } from '../../../backend/supabase/functions/_shared/contracts/common.ts';
const key = 'a1000000-0000-4000-8000-000000000001', token = 'a1000000-0000-4000-8000-000000000002';
const secret = 'x'.repeat(32), now = '2026-10-09T01:00:00Z';
const values = { SUPABASE_URL: 'https://local.invalid', SUPABASE_ANON_KEY: 'synthetic-anon', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', INTERNAL_WORKER_SECRET: secret, ALLOWED_ORIGINS: '[]', UPSTREAM_TIMEOUT_MS: '1000', MAX_REQUEST_BYTES: '65536' };
const queue = { contractId: 'contract-118', workerSecret: secret, functionUrl: 'https://local.invalid/functions/v1/review-summary-worker' };
const approval = { approved: true as const, decisionId: queue.contractId, maxExecutionMs: 1000 };
function fixture(incomplete = false, unrelated = false) {
  const calls: string[] = []; let completed = false;
  const outcome = (): JsonValue => ({ requestId: key, globalToken: token, kind: 'member_cleanup', limit: 10, remainingMs: 120000,
    state: completed ? 'completed' : 'unknown', closedAt: completed ? now : null,
    result: completed ? { status: 'ran', counts: { claimed: 1, succeeded: 1, retried: 0, failed: 0, superseded: 0, yielded: 0 } } : null });
  const db: RpcClient = { async rpc(name, args) {
    calls.push(name);
    if (name === 'read_member_cleanup_unknown_invocations') return { items: completed || args.p_after_request_id !== null ? [] : [{ invocationRequestId: key }], nextAfterRequestId: completed || args.p_after_request_id !== null ? null : key };
    if (name === 'get_queue_invocation') return outcome();
    if (name === 'complete_queue_invocation') { if (incomplete) throw Error('INCOMPLETE_PROOF'); completed = true; return outcome(); }
    if (name === 'read_worker_runtime_pending_v2') return { hasPending: unrelated || !completed };
    assert.fail('global/claim/DELETE/ACK를 호출하지 않는다');
  } };
  return { db, calls, completed: () => completed };
}
test('default assembly never invokes SQL118 or parent completion', async () => {
  const f = fixture(), runtime = createConfiguredQueueRuntime(values, queue, { db: f.db });
  assert.equal(await runtime.contracts.journal.hasPending(), true);
  assert.deepEqual(f.calls, ['read_worker_runtime_pending_v2']);
});
test('pre-existing common pending cannot short-circuit approved discovery; only stored completion clears member pending', async () => {
  const f = fixture(), runtime = createConfiguredQueueRuntime(values, queue, { db: f.db, memberParentFinalization: approval });
  assert.equal(await runtime.contracts.journal.hasPending(), false); assert.equal(f.completed(), true);
  assert.equal(f.calls[0], 'read_member_cleanup_unknown_invocations');
  assert.ok(f.calls.indexOf('complete_queue_invocation') < f.calls.indexOf('read_worker_runtime_pending_v2'));
  assert.equal(f.calls.filter(name => name === 'complete_queue_invocation').length, 1);
});
test('incomplete member or unrelated legacy pending remains blocked after the scan', async () => {
  for (const f of [fixture(true), fixture(false, true)]) {
    const runtime = createConfiguredQueueRuntime(values, queue, { db: f.db, memberParentFinalization: approval });
    assert.equal(await runtime.contracts.journal.hasPending(), true);
    assert.ok(f.calls.includes('read_member_cleanup_unknown_invocations'));
  }
});
test('approval mismatch fails before any RPC', () => {
  const f = fixture(); assert.throws(() => createConfiguredQueueRuntime(values, queue, { db: f.db, memberParentFinalization: { ...approval, decisionId: 'wrong' } })); assert.equal(f.calls.length, 0);
});
test('dedicated transport receives the scan signal and stop blocks a later complete despite ignored abort', async () => {
  const config = loadRuntimeConfig(name => values[name as keyof typeof values]); let started!: () => void, release!: (response: Response) => void;
  const entered = new Promise<void>(resolve => { started = resolve; }); let received: AbortSignal | null | undefined;
  const paths: string[] = [];
  const makeDb = (signal: AbortSignal) => createRpcTransport(config, 'synthetic-api', 'synthetic-token', new Set(['read_member_cleanup_unknown_invocations', 'get_queue_invocation', 'complete_queue_invocation']), async (url, init) => {
    const path = new URL(String(url)).pathname; paths.push(path); received = init?.signal;
    assert.ok(received instanceof AbortSignal);
    // 실제 runtime의 scoped fetch와 같은 방식으로 transport의 독립 timeout signal과 결합한다.
    const combined = AbortSignal.any([signal, received]); received = combined;
    if (path.endsWith('/read_member_cleanup_unknown_invocations')) return Response.json({ items: [{ invocationRequestId: key }], nextAfterRequestId: key });
    started(); return await new Promise<Response>(resolve => { release = resolve; });
  });
  const db: RpcClient = { supportsRpc: () => true, rpc: async () => assert.fail('반드시 scoped transport 사용') };
  const stop = new AbortController(), pending = createMemberParentFinalizationScanner(db, approval, queue.contractId, makeDb).scan(stop.signal);
  await entered; stop.abort(); await assert.rejects(pending); assert.equal((received as AbortSignal | null | undefined)?.aborted, true);
  release(Response.json({ requestId: key, globalToken: token, kind: 'member_cleanup', limit: 10, remainingMs: 120000, state: 'unknown', result: null, closedAt: null }));
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(paths.length, 2); assert.ok(paths.every(path => !path.endsWith('/complete_queue_invocation')));
});
test('scheduler stop passes its read cancellation to approved finalization and acquires no global', async () => {
  const f = fixture(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const db: RpcClient = { rpc(name, args) {
    if (name !== 'get_queue_invocation') return f.db.rpc(name, args);
    f.calls.push(name); entered(); return new Promise<JsonValue>(() => {});
  } };
  const runtime = createConfiguredQueueRuntime(values, queue, { db, memberParentFinalization: approval }); let acquires = 0;
  const scheduler = createSharedBackgroundQueueScheduler({ queryTimeoutMs: 1000, supportedKinds: ['member_cleanup'],
    repository: { schedule: async () => ({ serverNow: now, nextDueAt: null, nextKind: null }), acquire: async () => { acquires++; return null; }, release: async () => 'applied' },
    contracts: { ...runtime.contracts, maintenance: { readSchedule: async () => ({ serverNow: now, nextDueAt: null }), run: async () => assert.fail('중단 후 유지관리 없음') } },
    invoke: async () => assert.fail('중단 후 전송 없음'), onError: () => {},
  });
  const wake = scheduler.wake(); await started; await scheduler.stop(); await wake;
  assert.equal(acquires, 0); assert.equal(f.calls.filter(name => name === 'complete_queue_invocation').length, 0);
});
