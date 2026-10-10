/** 내부 HTTP·RPC SDK 모형 검증. 실제 DB/Storage/운영 완료 증거가 아니다. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfig } from '../../../backend/supabase/functions/_shared/config/env.ts';
import { createMemberCleanupFinalizationExecutor } from '../../../backend/supabase/functions/service-api/member-cleanup-reconcile-http.ts';
import { createRuntimeHandler } from '../../../backend/supabase/functions/service-api/index.ts';

const values: Record<string, string> = { SUPABASE_URL: 'https://finalize.example.invalid', SUPABASE_ANON_KEY: 'synthetic-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', INTERNAL_WORKER_SECRET: 'synthetic_worker_secret_longer_than_32_chars',
  UPSTREAM_TIMEOUT_MS: '1000', MAX_REQUEST_BYTES: '65536', ALLOWED_ORIGINS: '[]' };
const config = loadRuntimeConfig(k => values[k]);
const id = (n: number) => `a1150000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const counts = { claimed: 1, succeeded: 1, retried: 0, failed: 0, superseded: 0, yielded: 0 };
const approval = { approved: true as const, decisionId: 'synthetic-finalize115', maxExecutionMs: 1000 };
const row = (state = 'unknown') => ({ requestId: id(1), globalToken: id(2), kind: 'member_cleanup', limit: 10, remainingMs: 180000,
  state, result: state === 'completed' ? { status: 'ran', counts } : null, closedAt: state === 'completed' ? '2026-10-09T00:00:00Z' : null });
function request(options: { secret?: string; body?: unknown; method?: string; search?: string; signal?: AbortSignal } = {}) {
  const method = options.method ?? 'POST';
  return new Request('https://finalize.example.invalid/service-api/internal/member-cleanup/reconcile/finalize' + (options.search ?? ''), {
    method, headers: { authorization: `Bearer ${options.secret ?? values.INTERNAL_WORKER_SECRET}`, 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? { invocationRequestId: id(1) }) }), signal: options.signal });
}
type Options = { initial?: Record<string, unknown>; final?: Record<string, unknown>; complete?: Record<string, unknown>;
  loss?: boolean; refused?: boolean; maxMs?: number; delayAt?: number; neverAt?: number; abort?: AbortController };
function fixture(options: Options = {}) {
  const calls: string[] = [], signals: AbortSignal[] = [];
  let reads = 0;
  const handle = createMemberCleanupFinalizationExecutor(config, { ...approval, maxExecutionMs: options.maxMs ?? 1000 }, async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, values.SUPABASE_URL);
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-service');
    assert.equal(new Headers(init?.headers).get('apikey'), 'synthetic-service');
    assert.deepEqual(JSON.parse(String(init?.body)), { p_request_id: id(1) });
    const name = parsed.pathname.split('/').at(-1)!;
    assert.ok(['get_queue_invocation', 'complete_queue_invocation'].includes(name));
    calls.push(name); signals.push(init!.signal!);
    if (calls.length === options.neverAt) return await new Promise<Response>(() => {});
    if (calls.length === options.delayAt) await new Promise(resolve => setTimeout(resolve, 70));
    if (name === 'get_queue_invocation') return Response.json(++reads === 1 ? options.initial ?? row() : options.final ?? row('completed'));
    if (options.abort) options.abort.abort();
    if (options.loss) throw new Error('synthetic lost response with private detail');
    if (options.refused) return Response.json({ code: '55000', message: 'private detail' }, { status: 400 });
    return Response.json(options.complete ?? row('completed'));
  });
  return { handle, calls, signals };
}
test('내부 인증이 method·본문보다 먼저이며 회원 호출은 RPC0이다', async () => {
  const f = fixture();
  for (const r of [request({ secret: 'synthetic-member', body: { approved: true } }), request({ secret: 'synthetic-member', method: 'GET' })]) {
    assert.equal((await f.handle(r)).status, 403);
  }
  assert.deepEqual(f.calls, []);
});
test('서버 승인 없거나 배정이 잘못되면 생성 단계에서 거절한다', () => {
  for (const readiness of [undefined, { ...approval, approved: false }, { ...approval, decisionId: '' },
    { ...approval, maxExecutionMs: 0 }, { ...approval, maxExecutionMs: 60001 }, { ...approval, maxExecutionMs: 1.5 }]) {
    assert.throws(() => createMemberCleanupFinalizationExecutor(config, readiness as never));
  }
});
test('exact body·canonical ID·POST·query 검증은 RPC 전에 수행한다', async () => {
  const f = fixture();
  for (const r of [request({ body: {} }), request({ body: { invocationRequestId: id(1), approved: true } }),
    request({ body: { invocationRequestId: id(1).toUpperCase() } }), request({ body: { invocationRequestId: '00000000-0000-0000-0000-000000000000' } }),
    request({ body: { invocationRequestId: id(1).replace('-8000-', '-1000-') } }), request({ body: [] }),
    request({ method: 'GET' }), request({ search: '?approved=true' })]) assert.ok([400, 405].includes((await f.handle(r)).status));
  assert.deepEqual(f.calls, []);
});
test('이미 completed인 원 부모는 저장 counts만 반환하고 complete0이다', async () => {
  const f = fixture({ initial: row('completed') }), r = await f.handle(request());
  assert.equal(r.status, 200); assert.deepEqual((await r.json()).data, { status: 'completed', counts });
  assert.deepEqual(f.calls, ['get_queue_invocation']);
});
test('UNKNOWN은 get/complete/get이며 과거 global로 예산·점유·외부 호출 없이 닫는다', async () => {
  const f = fixture(), r = await f.handle(request()), envelope = await r.json();
  assert.equal(r.status, 200); assert.deepEqual(envelope.data, { status: 'completed', counts });
  assert.equal(envelope.requestId, r.headers.get('x-request-id'));
  assert.deepEqual(f.calls, ['get_queue_invocation', 'complete_queue_invocation', 'get_queue_invocation']);
  assert.deepEqual(Object.keys(envelope.data).sort(), ['counts', 'status']);
});
test('완료 응답 유실은 같은 original ID GET의 실제 저장 completed만 인정한다', async () => {
  const f = fixture({ loss: true }), r = await f.handle(request());
  assert.equal(r.status, 200); assert.deepEqual((await r.json()).data, { status: 'completed', counts });
  assert.deepEqual(f.calls, ['get_queue_invocation', 'complete_queue_invocation', 'get_queue_invocation']);
});
test('성공 응답만으로 완료되지 않으며 미완료 task·DB 거절·응답 유실 후 UNKNOWN은 pending이다', async () => {
  for (const options of [{}, { refused: true }, { loss: true }]) {
    const f = fixture({ ...options, final: row() }), r = await f.handle(request());
    assert.equal(r.status, 200); assert.deepEqual((await r.json()).data, { status: 'pending' });
    assert.equal(f.calls.filter(name => name === 'complete_queue_invocation').length, 1);
  }
});
test('다른 kind·prepared·잘못된 stored DTO는 완료 호출 전에 거절한다', async () => {
  for (const initial of [{ ...row(), kind: 'review_summary' }, row('prepared'), { ...row(), requestId: id(3) },
    { ...row(), inputSha256: 'a'.repeat(64) }, { ...row('completed'), result: { status: 'ran', counts: { ...counts, claimed: 2 } } }]) {
    const f = fixture({ initial }); assert.ok((await f.handle(request())).status >= 400); assert.deepEqual(f.calls, ['get_queue_invocation']);
  }
});
test('마지막 GET의 원 request/global/kind/limit/remainingMs 불변을 대조한다', async () => {
  for (const changed of [{ requestId: id(3) }, { globalToken: id(3) }, { kind: 'review_summary' }, { limit: 9 }, { remainingMs: 179999 }]) {
    const f = fixture({ final: { ...row('completed'), ...changed } }), r = await f.handle(request());
    assert.equal(r.status, 503); assert.equal((await r.text()).includes('synthetic-service'), false);
    assert.equal(f.calls.filter(name => name === 'complete_queue_invocation').length, 1);
  }
});
test('완료 응답의 유효 DTO에 원 배정 변조가 있으면 저장 완료로 덮어 성공시키지 않는다', async () => {
  const f = fixture({ complete: { ...row('completed'), globalToken: id(3) } }), r = await f.handle(request());
  assert.equal(r.status, 503); assert.deepEqual(f.calls, ['get_queue_invocation', 'complete_queue_invocation']);
});
test('완료 호출 뒤 read 실패·비정상 상태도 완료로 바꾸지 않는다', async () => {
  for (const final of [row('prepared'), { ...row('completed'), closedAt: null }, { ...row('completed'), result: null }]) {
    const f = fixture({ final }); assert.ok((await f.handle(request())).status >= 400);
  }
});
test('취소 무시 transport의 늦은 최초 GET은 마감 후 complete0이다', async () => {
  const f = fixture({ maxMs: 15, delayAt: 1 }), r = await f.handle(request());
  assert.equal(r.status, 409);
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.deepEqual(f.calls, ['get_queue_invocation']); assert.equal(f.signals[0].aborted, true);
});
test('취소 무시 complete 전송은 마감 후 GET·재전송0이며 미해결 GET도 서버 마감에 종료한다', async () => {
  for (const options of [{ delayAt: 2 }, { neverAt: 1 }]) {
    const f = fixture({ ...options, maxMs: 15 }), r = await f.handle(request());
    assert.equal(r.status, 409);
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal(f.calls.length, options.delayAt ? 2 : 1);
  }
});
test('요청 취소는 추가 조회를 막고 처음부터 중단된 요청은 RPC0이다', async () => {
  const abort = new AbortController(), f = fixture({ abort });
  assert.equal((await f.handle(request({ signal: abort.signal }))).status, 409);
  assert.deepEqual(f.calls, ['get_queue_invocation', 'complete_queue_invocation']);
  const stopped = new AbortController(); stopped.abort(); const g = fixture();
  assert.equal((await g.handle(request({ signal: stopped.signal }))).status, 400); assert.deepEqual(g.calls, []);
});
test('승인값 복사 후 호출자 변경은 기존 서버 마감을 늘리지 못한다', async () => {
  const readiness = { ...approval, maxExecutionMs: 15 }; let calls = 0;
  const handle = createMemberCleanupFinalizationExecutor(config, readiness, async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 70)); return Response.json(row());
  });
  readiness.maxExecutionMs = 60000; readiness.approved = false as never;
  assert.equal((await handle(request())).status, 409);
  await new Promise(resolve => setTimeout(resolve, 90)); assert.equal(calls, 1);
});
test('실제 factory는 기본 종결404이며 승인된 내부 두 경로에만 원 저장 결과를 연결한다', async (t) => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(new URL(String(url)).pathname, '/rest/v1/rpc/get_queue_invocation');
    assert.equal(init?.method, 'POST'); assert.deepEqual(JSON.parse(String(init?.body)), { p_request_id: id(1) });
    return Response.json(row('completed'));
  };
  t.after(() => { globalThis.fetch = original; });
  const closed = createRuntimeHandler(k => values[k]);
  const enabled = createRuntimeHandler(k => values[k], { memberCleanupReconcile: approval });
  for (const prefix of ['', '/functions/v1']) {
    const path = `https://finalize.example.invalid${prefix}/service-api/internal/member-cleanup/reconcile/finalize`;
    const make = (secret = values.INTERNAL_WORKER_SECRET) => new Request(path, { method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ invocationRequestId: id(1) }) });
    assert.equal((await closed(make())).status, 404);
    assert.equal((await enabled(make('synthetic-member'))).status, 403);
    const r = await enabled(make()), envelope = await r.json();
    assert.equal(r.status, 200); assert.deepEqual(envelope.data, { status: 'completed', counts });
    assert.equal(envelope.requestId, r.headers.get('x-request-id'));
  }
  assert.equal(calls, 2);
});

// Header completion must not detach the parent cancellation before JSON body completion.
test('본문 읽기 대기 중에도 서버 마감은 전송을 취소하고 추가 RPC를 막는다', async () => {
  let signal: AbortSignal | undefined;
  let calls = 0;
  const handle = createMemberCleanupFinalizationExecutor(config, { ...approval, maxExecutionMs: 15 }, async (_url, init) => {
    calls++; signal = init!.signal!;
    const response = Response.json(row());
    response.json = async () => await new Promise(() => {});
    return response;
  });
  const result = await handle(request());
  assert.equal(result.status, 409);
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
});
