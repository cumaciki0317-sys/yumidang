/** 실제 HTTP 조립·인증·SDK/adapter의 모형 연결. 실제 DB/외부 삭제 증거가 아니다. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfig } from '../../../backend/supabase/functions/_shared/config/env.ts';
import { createMemberCleanupReconcileExecutor } from '../../../backend/supabase/functions/service-api/member-cleanup-reconcile-http.ts';
import { createRuntimeHandler } from '../../../backend/supabase/functions/service-api/index.ts';
const values: Record<string, string> = { SUPABASE_URL: 'https://recovery.example.invalid', SUPABASE_ANON_KEY: 'synthetic-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', INTERNAL_WORKER_SECRET: 'synthetic_worker_secret_longer_than_32_chars',
  UPSTREAM_TIMEOUT_MS: '1000', MAX_REQUEST_BYTES: '65536', ALLOWED_ORIGINS: '[]' };
const config = loadRuntimeConfig(k => values[k]);
const id = (n: number) => `a1150000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const body = { recoveryRequestId: id(1), invocationRequestId: id(2), taskId: id(3) };
function request(options: { secret?: string; body?: unknown; token?: string; method?: string; signal?: AbortSignal; search?: string } = {}) {
  const method = options.method ?? 'POST';
  return new Request('https://recovery.example.invalid/service-api/internal/member-cleanup/reconcile' + (options.search ?? ''), {
    method, headers: { authorization: `Bearer ${options.secret ?? values.INTERNAL_WORKER_SECRET}`, 'content-type': 'application/json',
      'x-worker-run-token': options.token ?? id(4) }, ...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? body) }), signal: options.signal });
}
function fixture(options: { fresh?: boolean; beginLoss?: boolean; finishLoss?: boolean; budgetFailure?: boolean; externalStatus?: number; maxMs?: number } = {}) {
  const calls: string[] = [], external: string[] = [];
  const task = { taskId: id(3), leaseToken: id(5), expiresAt: '2099-01-01T00:00:00Z', kind: 'auth_user', profileId: id(6), bucketId: null, objectName: null, objectId: null };
  const saved = { ...body, state: 'prepared', original: { withdrawalId: id(7), objectId: null, dispatchId: id(8), globalToken: id(9), jobLeaseToken: id(10), ackReceiptId: id(11), ackSha256: 'a'.repeat(64) },
    recovery: { globalToken: id(4), leaseToken: id(5), expiresAt: task.expiresAt }, evidenceSha256: null as string | null, closedAt: null as string | null };
  const handle = createMemberCleanupReconcileExecutor(config, { approved: true, decisionId: 'synthetic115', maxExecutionMs: options.maxMs ?? 1000 }, async (url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-service');
    const pathname = new URL(String(url)).pathname;
    if (pathname.startsWith('/auth/')) {
      assert.equal(init?.method, 'GET'); external.push(pathname);
      assert.equal(pathname, `/auth/v1/admin/users/${id(6)}`);
      return new Response(null, { status: options.externalStatus ?? 404 });
    }
    const name = pathname.split('/').at(-1)!; calls.push(name);
    assert.equal(init?.method, 'POST');
    const args = JSON.parse(String(init?.body));
    if (name === 'read_worker_run_budget') {
      assert.deepEqual(args, { p_worker_run_token: id(4) });
      return options.budgetFailure ? Response.json({ code: '42501', message: 'private detail' }, { status: 403 }) : Response.json({ remainingMs: 180000 });
    }
    if (name === 'begin_member_cleanup_reconcile') {
      assert.deepEqual(args, { p_recovery_request_id: id(1), p_invocation_request_id: id(2), p_task_id: id(3), p_recovery_global_token: id(4) });
      if (options.beginLoss) throw new Error('synthetic response lost');
      return Response.json({ recoveryRequestId: id(1), state: saved.state, fresh: options.fresh !== false, task: options.fresh === false ? null : task });
    }
    if (name === 'get_member_cleanup_reconcile') { assert.deepEqual(args, { p_recovery_request_id: id(1) }); return Response.json(saved); }
    if (name === 'check_member_cleanup_task') return Response.json(task);
    if (name === 'get_member_cleanup_delete_ack') return Response.json({ receiptId: id(11), taskId: id(3), kind: 'auth_user', objectId: null, evidenceSha256: 'a'.repeat(64) });
    if (name === 'finish_member_cleanup_reconcile') {
      saved.state = 'completed'; saved.evidenceSha256 = args.p_evidence_sha256; saved.closedAt = '2026-10-09T00:00:00Z';
      if (options.finishLoss) throw new Error('synthetic finish lost');
      return Response.json(saved);
    }
    assert.fail('unexpected claim/dispatch/ACK/outer-complete: ' + name);
  });
  return { handle, calls, external, saved };
}
test('내부 인증은 잘못된 본문·token·method 확인보다 먼저이며 회원 호출은 RPC0이다', async () => {
  const f = fixture();
  for (const r of [request({ secret: 'synthetic-member', body: { approved: true }, token: 'bad' }), request({ secret: 'synthetic-member', method: 'GET' })]) {
    assert.equal((await f.handle(r)).status, 403);
  }
  assert.equal(f.calls.length + f.external.length, 0);
});
test('승인 미설정·틀린 배정은 실행기 생성 단계에서 닫힌다', () => {
  for (const approval of [undefined, { approved: false, decisionId: 'x', maxExecutionMs: 10 }, { approved: true, decisionId: '', maxExecutionMs: 10 }, { approved: true, decisionId: 'x', maxExecutionMs: 60001 }]) {
    assert.throws(() => createMemberCleanupReconcileExecutor(config, approval as never));
  }
});
test('본문 승인값·다른 scope·미정 token·query·method는 budget과 begin 전에 거절한다', async () => {
  const f = fixture();
  for (const r of [request({ body: { ...body, approved: true } }), request({ body: { ...body, taskId: 'bad' } }), request({ token: 'bad' }), request({ search: '?approved=true' }), request({ method: 'GET' })]) {
    assert.ok([400, 405].includes((await f.handle(r)).status));
  }
  assert.equal(f.calls.length + f.external.length, 0);
});
test('실제 SDK·adapter를 거쳐 DB budget·원 ACK·Auth GET-only·finish 저장 proof를 연결한다', async () => {
  const f = fixture({ finishLoss: true }), r = await f.handle(request()), envelope = await r.json();
  assert.equal(r.status, 200); assert.equal(envelope.data.status, 'applied'); assert.match(envelope.data.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(envelope.data.evidenceSha256, f.saved.evidenceSha256);
  assert.equal(envelope.requestId, r.headers.get('x-request-id'));
  assert.equal(f.calls[0], 'read_worker_run_budget'); assert.equal(f.calls.filter(x => x === 'finish_member_cleanup_reconcile').length, 1);
  assert.equal(f.external.length, 1); assert.equal(f.saved.original.ackSha256, 'a'.repeat(64));
});
test('이미 시작한 키·begin 응답 유실은 pending 최소 조회이며 외부 GET과 finish0이다', async () => {
  for (const options of [{ fresh: false }, { beginLoss: true }]) {
    const f = fixture(options), r = await f.handle(request());
    assert.equal(r.status, 200); assert.deepEqual((await r.json()).data, { status: 'pending' });
    assert.deepEqual(f.calls, ['read_worker_run_budget', 'begin_member_cleanup_reconcile', 'get_member_cleanup_reconcile']);
    assert.equal(f.external.length, 0);
  }
});
test('닫힌 예산 권한·외부 권한 실패를 완료로 바꾸지 않으며 원문을 응답하지 않는다', async () => {
  const f = fixture({ budgetFailure: true }), r = await f.handle(request());
  assert.equal(r.status, 403); assert.equal((await r.text()).includes('private detail'), false);
  assert.deepEqual(f.calls, ['read_worker_run_budget']);
  const g = fixture({ externalStatus: 403 }); assert.equal((await g.handle(request())).status, 503);
  assert.equal(g.calls.includes('finish_member_cleanup_reconcile'), false);
});
test('취소를 무시하는 budget transport도 서버 마감에 종료하며 늦은 응답은 begin0이다', async () => {
  let calls = 0;
  const handle = createMemberCleanupReconcileExecutor(config, { approved: true, decisionId: 'synthetic115', maxExecutionMs: 10 }, async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 40)); return Response.json({ remainingMs: 180000 });
  });
  assert.equal((await handle(request())).status, 409);
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(calls, 1);
});
test('이미 중단된 요청은 내부 인증 이후 새 DB 조회도 시작하지 않는다', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  assert.equal((await f.handle(request({ signal: abort.signal }))).status, 400); assert.equal(f.calls.length + f.external.length, 0);
});
test('실제 factory의 복구 경로는 기본 닫힘이며 서버 승인만 별도 내부 포트에 연결한다', async (t) => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; assert.fail('인증·입력 거절 전에는 transport를 호출하지 않는다'); };
  t.after(() => { globalThis.fetch = original; });
  const closed = createRuntimeHandler(k => values[k]);
  for (const prefix of ['', '/functions/v1']) {
    const r = await closed(new Request(`https://recovery.example.invalid${prefix}/service-api/internal/member-cleanup/reconcile`, {
      method: 'POST', body: JSON.stringify({ ...body, approved: true }), headers: { authorization: 'Bearer synthetic-member' } }));
    assert.equal(r.status, 404);
  }
  assert.throws(() => createRuntimeHandler(k => values[k], { memberCleanupReconcile: { approved: false, decisionId: 'x', maxExecutionMs: 10 } as never }));
  // fresh 삭제·회원 탈퇴 옵션 없이 복구만 준비할 수 있다.
  const recovery = createRuntimeHandler(k => values[k], { memberCleanupReconcile: { approved: true, decisionId: 'synthetic115', maxExecutionMs: 1000 } });
  for (const prefix of ['', '/functions/v1']) {
    const url = `https://recovery.example.invalid${prefix}/service-api/internal/member-cleanup/reconcile`;
    const r = await recovery(new Request(url, { method: 'POST', headers: { authorization: 'Bearer synthetic-member' }, body: '{}' }));
    const envelope = await r.json(); assert.equal(r.status, 403); assert.equal(envelope.requestId, r.headers.get('x-request-id'));
    const bad = await recovery(new Request(url, { method: 'POST', headers: { authorization: `Bearer ${values.INTERNAL_WORKER_SECRET}`, 'content-type': 'application/json', 'x-worker-run-token': id(4) }, body: JSON.stringify({ ...body, approved: true }) }));
    assert.equal(bad.status, 400);
  }
  assert.equal(calls, 0);
});
