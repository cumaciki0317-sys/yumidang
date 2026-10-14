// 실제 handler/runtime과 합성 Auth/RPC의 읽기 책임 검사. 실제 DB/Auth/모델 호출0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiChatHandler } from '../../../backend/supabase/functions/ai-chat/handler.ts';
import { createAiChatRuntime } from '../../../backend/supabase/functions/ai-chat/index.ts';
import { HttpError } from '../../../backend/supabase/functions/_shared/http/errors.ts';
const uid = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222';
const origin = 'https://app.synthetic.test', base = 'https://api.synthetic.test';
const state = status => ({ requestId: id, status, availableAt: status === 'available' ? '2026-10-14T00:00:00.000000Z' : null, helpfulAllowed: status === 'available' });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const req = (suffix = '', init = {}) => new Request(base + '/ai-chat/results/' + id + suffix, { headers: { authorization: 'Bearer synthetic.member', origin }, ...init });
function fixture(overrides = {}) {
  const calls = { auth: 0, reads: [], mutations: 0 };
  const forbidden = () => { calls.mutations++; throw Error('MUTATION_MUST_NOT_RUN'); };
  const handler = createAiChatHandler({ allowedOrigins: [origin], maxBodyBytes: 1024, engine: { status: 'unavailable', code: 'SYNTHETIC_HOLD' },
    authenticate: async () => { calls.auth++; return { userId: uid }; }, getResultState: async (userId, requestId) => { calls.reads.push([userId, requestId]); return state('available'); },
    openSession: forbidden, requestGate: { acquire: forbidden, finish: forbidden }, recordResultAvailable: forbidden, feedback: { submit: forbidden }, ...overrides });
  return { handler, calls };
}
function privateHeaders(response) { assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.ok(response.headers.get('vary').includes('Authorization')); assert.ok(response.headers.get('vary').includes('Origin')); }

test('원 결과 ID와 새 HTTP ID를 구분하며 unavailable 모델에서도 metadata GET만 허용', async () => {
  for (const prefix of ['/ai-chat/', '/functions/v1/ai-chat/']) for (const status of ['available', 'pending', 'unavailable']) {
    const f = fixture({ getResultState: async (userId, requestId) => { assert.equal(userId, uid); assert.equal(requestId, id); return state(status); } });
    const response = await f.handler(new Request(base + prefix + 'results/' + id.toUpperCase(), { headers: { origin } }));
    assert.equal(response.status, 200); privateHeaders(response);
    const body = await response.json(); assert.deepEqual(body.data, state(status)); assert.notEqual(body.requestId, id);
    assert.equal(response.headers.get('x-request-id'), body.requestId); assert.equal(f.calls.auth, 1); assert.equal(f.calls.mutations, 0);
    assert.deepEqual(Object.keys(body.data).sort(), ['availableAt', 'helpfulAllowed', 'requestId', 'status']);
  }
});

test('경로·UUID·query/hash/body/range·메서드 거절은 인증/DB 전에 종료', async () => {
  const cases = [req('?userId=' + uid), req('#private'), req('/extra'), new Request(base + '/ai-chat/results/bad'), req('', { headers: { range: 'bytes=0-1' } })];
  for (const request of cases) { const f = fixture(), response = await f.handler(request); assert.equal(response.status, 400); privateHeaders(response); assert.equal(f.calls.auth, 0); assert.equal(f.calls.reads.length, 0); }
  const f = fixture(); assert.equal((await f.handler(req('', { method: 'POST', body: 'PRIVATE_BODY' }))).status, 405); assert.equal(f.calls.auth, 0);
});

test('인증 실패·포트 부재·본인 아닌 요청/만료는 안전한 실패이며 원문·쓰기0', async () => {
  for (const [code, expected] of [['AUTH_REQUIRED', 401], ['ACCESS_DENIED', 403], ['EXTERNAL_UNAVAILABLE', 503]]) {
    const f = fixture({ authenticate: async () => { throw new HttpError(code); } }), response = await f.handler(req());
    assert.equal(response.status, expected); privateHeaders(response); assert.equal(f.calls.reads.length, 0); assert.equal(f.calls.mutations, 0);
  }
  for (const getResultState of [undefined, async () => { throw new HttpError('RESOURCE_NOT_FOUND'); }, async () => { throw Error('PRIVATE_BODY'); }]) {
    const f = fixture({ getResultState }), response = await f.handler(req()); assert.equal(response.status, getResultState === undefined ? 503 : (await response.clone().json()).error.code === 'RESOURCE_NOT_FOUND' ? 404 : 503);
    privateHeaders(response); assert.equal((await response.text()).includes('PRIVATE_BODY'), false); assert.equal(f.calls.mutations, 0);
  }
});

test('잘못된 metadata·원문 추가·다른 원 ID·상충 상태는503으로 닫힘', async () => {
  for (const value of [{ ...state('available'), requestId: uid }, { ...state('available'), message: 'PRIVATE_BODY' }, { ...state('pending'), helpfulAllowed: true }, { ...state('available'), availableAt: null }, { ...state('available'), availableAt: '2026-02-30T00:00:00Z' }]) {
    const f = fixture({ getResultState: async () => value }), response = await f.handler(req()); assert.equal(response.status, 503); assert.equal((await response.text()).includes('PRIVATE_BODY'), false); assert.equal(f.calls.mutations, 0);
  }
});

test('GET CORS 사전 요청과 잘못된 Origin은 인증·읽기0이며 Vary/비공개 유지', async () => {
  const f = fixture(), response = await f.handler(req('', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } }));
  assert.equal(response.status, 204); privateHeaders(response); assert.equal(response.headers.get('access-control-allow-methods'), 'GET'); assert.ok(response.headers.get('vary').includes('Access-Control-Request-Method'));
  assert.equal((await f.handler(req('', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } }))).status, 405);
  assert.equal((await f.handler(req('', { headers: { origin: 'https://other.synthetic.test' } }))).status, 403); assert.equal(f.calls.auth, 0); assert.equal(f.calls.reads.length, 0);
});

test('비협조 Auth/metadata는 총 마감에 끝나고 늦은 결과로 읽기/쓰기 추가0', async () => {
  for (const phase of ['auth', 'state']) {
    const late = deferred(); let reads = 0;
    const f = fixture({ resultReadTimeoutMs: 5, ...(phase === 'auth' ? { authenticate: () => late.promise } : {}), getResultState: async () => { reads++; return late.promise; } });
    const response = await f.handler(req()); assert.equal(response.status, 503); privateHeaders(response);
    late.resolve(phase === 'auth' ? { userId: uid } : state('available')); await pause(5);
    assert.equal(reads, phase === 'auth' ? 0 : 1); assert.equal(f.calls.mutations, 0);
  }
  const controller = new AbortController(); controller.abort('PRIVATE_BODY'); const f = fixture(); assert.equal((await f.handler(req('', { signal: controller.signal }))).status, 503); assert.equal(f.calls.auth, 0);
});

test('실제 runtime은 원 회원 JWT Auth 뒤 service RPC 두 인자만 읽고 모델/점유0', async () => {
  const calls = [], env = { SUPABASE_URL: 'https://db.synthetic.test', SUPABASE_ANON_KEY: 'synthetic-public', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', INTERNAL_WORKER_SECRET: 'synthetic_worker_secret_longer_than_32_characters', ALLOWED_ORIGINS: JSON.stringify([origin]), MAX_REQUEST_BYTES: '8192', UPSTREAM_TIMEOUT_MS: '1000' };
  const runtime = createAiChatRuntime(key => env[key], async (input, init) => {
    const url = String(input); calls.push(url); const headers = new Headers(init.headers);
    if (url.endsWith('/auth/v1/user')) { assert.equal(headers.get('authorization'), 'Bearer synthetic.member.jwt'); return Response.json({ id: uid, role: 'authenticated', is_anonymous: false }); }
    assert.equal(url, env.SUPABASE_URL + '/rest/v1/rpc/get_ai_result_state'); assert.equal(headers.get('authorization'), 'Bearer synthetic-service'); assert.deepEqual(JSON.parse(init.body), { p_user_id: uid, p_request_id: id }); return Response.json(state('available'));
  });
  const response = await runtime(req('', { headers: { authorization: 'Bearer synthetic.member.jwt', origin } })); assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, state('available')); assert.equal(calls.length, 2);
});
