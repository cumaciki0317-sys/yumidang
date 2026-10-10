import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberParentFinalizationScanner } from '../../../backend/supabase/functions/_shared/db/member-cleanup-finalization.ts';
import type { RpcClient } from '../../../backend/supabase/functions/_shared/db/transport.ts';
import type { JsonValue } from '../../../backend/supabase/functions/_shared/contracts/common.ts';
const id = (n: number) => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const approval = { approved: true as const, decisionId: 'contract-118', maxExecutionMs: 1000 };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function fixture(count = 1, finish = true) {
  const calls: [string, Record<string, JsonValue>][] = [], keys = Array.from({ length: count }, (_, i) => id(i + 1));
  const completed = new Set<string>();
  let lost = false, scopeChanged = false;
  const row = (key: string): JsonValue => ({ requestId: key, globalToken: scopeChanged && completed.has(key) ? id(102) : id(101),
    kind: 'member_cleanup', limit: 10, remainingMs: 120000, state: completed.has(key) ? 'completed' : 'unknown',
    result: completed.has(key) ? { status: 'ran', counts: { claimed: 1, succeeded: 1, retried: 0, failed: 0, superseded: 0, yielded: 0 } } : null,
    closedAt: completed.has(key) ? '2026-10-09T01:00:00Z' : null });
  const db: RpcClient = { async rpc(name, args) {
    calls.push([name, structuredClone(args)]);
    if (name === 'read_member_cleanup_unknown_invocations') {
      const items = keys.filter(key => !completed.has(key) && (args.p_after_request_id === null || key > String(args.p_after_request_id))).slice(0, Number(args.p_limit));
      return { items: items.map(invocationRequestId => ({ invocationRequestId })), nextAfterRequestId: items.at(-1) ?? null };
    }
    const key = String(args.p_request_id);
    if (name === 'get_queue_invocation') return row(key);
    if (name === 'complete_queue_invocation') {
      if (!finish) throw Error('DB_PROOF_INCOMPLETE');
      completed.add(key); if (lost) throw Error('RESPONSE_LOST'); return row(key);
    }
    assert.fail('외부 효과/claim/global 능력은 없다');
  } };
  return { db, calls, completed, row, lose: () => { lost = true; }, changeScope: () => { scopeChanged = true; } };
}
test('completed task UNKNOWN parent closes only after original GET proof; lost complete response gets same key', async () => {
  const f = fixture(); f.lose(); await createMemberParentFinalizationScanner(f.db, approval, 'contract-118').scan();
  assert.deepEqual(f.calls.slice(0, 4).map(([name]) => name), ['read_member_cleanup_unknown_invocations', 'get_queue_invocation', 'complete_queue_invocation', 'get_queue_invocation']);
  assert.equal(f.calls.filter(([name]) => name === 'complete_queue_invocation').length, 1);
  assert.ok(f.calls.filter(([name]) => name === 'get_queue_invocation').every(([, args]) => args.p_request_id === id(1)));
  assert.equal(f.completed.has(id(1)), true);
});
test('incomplete old parents remain UNKNOWN; bounded cursor makes progress to later IDs and resets only on empty', async () => {
  const f = fixture(12, false), scan = createMemberParentFinalizationScanner(f.db, approval, 'contract-118');
  await scan.scan(); assert.equal(f.calls.filter(([name]) => name === 'complete_queue_invocation').length, 6);
  await scan.scan(); assert.equal(f.calls.filter(([name]) => name === 'complete_queue_invocation').length, 12);
  const pages = f.calls.filter(([name]) => name === 'read_member_cleanup_unknown_invocations'); assert.equal(pages[1][1].p_after_request_id, id(6));
  await scan.scan();
  const wrapped = f.calls.filter(([name]) => name === 'read_member_cleanup_unknown_invocations');
  assert.deepEqual(wrapped.slice(-2).map(([, args]) => args.p_after_request_id), [id(12), null]);
  // 같은 scan에서 비어 있는 tail을 읽은 뒤 head를 이어 읽되 동일 키 complete는 한 번뿐이다.
  assert.equal(f.calls.filter(([name, args]) => name === 'complete_queue_invocation' && args.p_request_id === id(1)).length, 2);
  assert.equal(f.completed.size, 0);
});
test('every nonempty page requires its last ID, strict ascending unique IDs and exact shape', async () => {
  const invalid: JsonValue[] = [
    { items: [{ invocationRequestId: id(1) }], nextAfterRequestId: null },
    { items: [{ invocationRequestId: id(1) }, { invocationRequestId: id(1) }], nextAfterRequestId: id(1) },
    { items: [{ invocationRequestId: id(2) }, { invocationRequestId: id(1) }], nextAfterRequestId: id(1) },
    { items: [{ invocationRequestId: id(1), taskId: id(5) }], nextAfterRequestId: id(1) },
    { items: [], nextAfterRequestId: id(1) }, { items: [], nextAfterRequestId: null, complete: true },
  ];
  for (const value of invalid) {
    let calls = 0; const db: RpcClient = { async rpc() { calls++; return value; } };
    await assert.rejects(createMemberParentFinalizationScanner(db, approval, 'contract-118').scan()); assert.equal(calls, 1);
  }
});
test('changed original ABI scope cannot be accepted as stored completion', async () => {
  const f = fixture(); f.changeScope(); await assert.rejects(createMemberParentFinalizationScanner(f.db, approval, 'contract-118').scan());
  assert.equal(f.calls.filter(([name]) => name === 'complete_queue_invocation').length, 1);
});
test('successful complete response with changed global or limit fails before a valid final GET', async () => {
  const changes: Record<string, JsonValue>[] = [{ globalToken: id(102) }, { limit: 9 }];
  for (const changed of changes) {
    const f = fixture();
    const db: RpcClient = { async rpc(name, args) {
      const value = await f.db.rpc(name, args);
      return name === 'complete_queue_invocation' ? { ...(value as Record<string, JsonValue>), ...changed } : value;
    } };
    await assert.rejects(createMemberParentFinalizationScanner(db, approval, 'contract-118').scan());
    assert.equal(f.completed.has(id(1)), true); // 뒤의 GET은 유효한 원 binding을 반환할 수 있어도 호출하지 않는다.
    assert.equal(f.calls.filter(([name]) => name === 'get_queue_invocation').length, 1);
    assert.equal(f.calls.at(-1)![0], 'complete_queue_invocation');
  }
});
test('denied discovery and missing capability fail closed; approval contract is server bound', async () => {
  let calls = 0; const db: RpcClient = { async rpc() { calls++; throw Error('ACCESS_DENIED'); } };
  await assert.rejects(createMemberParentFinalizationScanner(db, approval, 'contract-118').scan()); assert.equal(calls, 1);
  assert.throws(() => createMemberParentFinalizationScanner({ ...db, supportsRpc: () => false }, approval, 'contract-118'));
  for (const value of [{ ...approval, approved: false }, { ...approval, decisionId: 'wrong' }, { ...approval, maxExecutionMs: 0 }, { ...approval, maxExecutionMs: 60001 }]) {
    assert.throws(() => createMemberParentFinalizationScanner(db, value as typeof approval, 'contract-118'));
  }
});
test('stop signal prevents next complete even when GET transport ignores abort', async () => {
  const f = fixture(); let release!: (value: JsonValue) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const db: RpcClient = { rpc(name, args) {
    if (name !== 'get_queue_invocation') return f.db.rpc(name, args);
    f.calls.push([name, args]); entered(); return new Promise(resolve => { release = resolve; });
  } };
  const stop = new AbortController(), pending = createMemberParentFinalizationScanner(db, approval, 'contract-118').scan(stop.signal);
  await started; stop.abort(); await assert.rejects(pending); release(f.row(id(1))); await tick();
  assert.equal(f.calls.filter(([name]) => name === 'complete_queue_invocation').length, 0);
});
test('own deadline bounds an ignoring transport and single-flight calls share one scan', async () => {
  const f = fixture(); let release!: (value: JsonValue) => void;
  const db: RpcClient = { rpc(name, args) {
    if (name !== 'get_queue_invocation') return f.db.rpc(name, args);
    f.calls.push([name, args]); return new Promise(resolve => { release = resolve; });
  } };
  const scanner = createMemberParentFinalizationScanner(db, { ...approval, maxExecutionMs: 15 }, 'contract-118');
  const a = scanner.scan(), b = scanner.scan(); assert.equal(a, b); await assert.rejects(a); await assert.rejects(b);
  release(f.row(id(1))); await tick(); assert.equal(f.calls.filter(([name]) => name === 'read_member_cleanup_unknown_invocations').length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'complete_queue_invocation').length, 0);
});
