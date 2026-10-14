// SDK 읽기 포트와 합성 API. 화면·본문 보관/실제 Auth·DB 연결 검사가 아니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { YumidangService } from '../../../apps/mobile/src/service.ts';
const id = '22222222-2222-4222-8222-222222222222';
const ready = { requestId: id, status: 'available', availableAt: '2026-10-14T00:00:00Z', helpfulAllowed: true };
function fixture(value = ready) {
  const calls = [], service = new YumidangService({ serviceApiUrl: 'https://api.synthetic.test/service-api', aiChatUrl: 'https://api.synthetic.test/functions/v1/ai-chat/', accessToken: async () => 'synthetic.member', fetcher: async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ data: value, requestId: '11111111-1111-4111-8111-111111111111' }); } });
  return { service, calls };
}
test('SDK는 원 ID GET만 보내며 actor/본문/차감/feedback 없이 정확 상태를 반환', async () => {
  const f = fixture(); assert.deepEqual(await f.service.getAiResultState(id.toUpperCase()), ready); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://api.synthetic.test/functions/v1/ai-chat/results/' + id); assert.equal(f.calls[0].init.method, 'GET'); assert.equal(f.calls[0].init.body, undefined); assert.equal(new Headers(f.calls[0].init.headers).get('authorization'), 'Bearer synthetic.member');
});
test('없는 메모리 답변을 복원하지 않으며 pending/unavailable metadata만 반환', async () => {
  for (const status of ['pending', 'unavailable']) { const expected = { requestId: id, status, availableAt: null, helpfulAllowed: false }; const f = fixture(expected); assert.deepEqual(await f.service.getAiResultState(id), expected); assert.equal(f.calls.length, 1); }
});
test('bad 입력은 전송0, 다른 ID/원문/모순/잘못된 시각 metadata는 거절', async () => {
  const f = fixture(); await assert.rejects(f.service.getAiResultState('../secret')); assert.equal(f.calls.length, 0);
  for (const value of [{ ...ready, requestId: '11111111-1111-4111-8111-111111111111' }, { ...ready, messages: ['PRIVATE_BODY'] }, { ...ready, helpfulAllowed: false }, { ...ready, availableAt: 'yesterday' }]) { const bad = fixture(value); await assert.rejects(bad.service.getAiResultState(id), error => error.code === 'INVALID_SERVICE_RESPONSE'); }
});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
test('사전 취소는 토큰/HTTP0, 토큰 대기 중 취소는 늦은 전송0', async () => {
  for (const preabort of [true, false]) {
    const controller = new AbortController(), late = deferred(), entered = deferred(); let tokens = 0, calls = 0;
    const service = new YumidangService({ serviceApiUrl: 'https://api.synthetic.test/service-api', aiChatUrl: 'https://api.synthetic.test/ai-chat', accessToken: () => { tokens++; entered.resolve(); return late.promise; }, fetcher: async () => { calls++; return Response.json({ data: ready }); } });
    if (preabort) controller.abort();
    const result = service.getAiResultState(id, controller.signal);
    if (!preabort) { await entered.promise; controller.abort(); }
    await assert.rejects(result, error => error.code === 'CANCELLED');
    late.resolve('synthetic.member'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(tokens, preabort ? 0 : 1); assert.equal(calls, 0);
  }
});
test('비협조 토큰은 총15초 마감, 늦은 토큰으로 HTTP 시작0', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const late = deferred(), entered = deferred(); let calls = 0;
  const service = new YumidangService({ serviceApiUrl: 'https://api.synthetic.test/service-api', aiChatUrl: 'https://api.synthetic.test/ai-chat', accessToken: () => { entered.resolve(); return late.promise; }, fetcher: async () => { calls++; return Response.json({ data: ready }); } });
  const result = service.getAiResultState(id); await entered.promise;
  t.mock.timers.tick(15000); await assert.rejects(result, error => error.code === 'REQUEST_TIMEOUT');
  late.resolve('synthetic.member'); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0);
});
test('비협조 HTTP도 호출자 취소에 끝나고 늦은 metadata는 반환하지 않음', async () => {
  const controller = new AbortController(), late = deferred(), entered = deferred(); let calls = 0;
  const service = new YumidangService({ serviceApiUrl: 'https://api.synthetic.test/service-api', aiChatUrl: 'https://api.synthetic.test/ai-chat', accessToken: async () => 'synthetic.member', fetcher: () => { calls++; entered.resolve(); return late.promise; } });
  const result = service.getAiResultState(id, controller.signal); await entered.promise; controller.abort();
  await assert.rejects(result, error => error.code === 'CANCELLED'); late.resolve(Response.json({ data: ready }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});
