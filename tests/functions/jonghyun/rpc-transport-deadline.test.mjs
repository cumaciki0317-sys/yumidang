// 실제 공통 transport/runtime과 합성 FetchLike의 책임 검사. 실제 DB/Auth/공급사 호출0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { fetchJson, createRpcTransport } from '../../../backend/supabase/functions/_shared/db/transport.ts';
import { toPublicError } from '../../../backend/supabase/functions/_shared/http/errors.ts';
import { createConfiguredModel } from '../../../backend/supabase/functions/_shared/ai/providers/runtime.ts';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('TEST_OBSERVATION_EXPIRED')), 1000); })]); } finally { clearTimeout(timer); } }
const unavailable = error => {
  assert.equal(toPublicError(error).error.code, 'EXTERNAL_UNAVAILABLE');
  assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /SYNTHETIC_PRIVATE_(REASON|BODY|KEY)|not_sent/);
  assert.equal(error.cause, undefined); return true;
};
const url = 'https://synthetic.invalid/rpc';

test('사전 caller 취소와 잘못된 timeout은 fetch0·고정 오류이며 사유를 노출하지 않음', async () => {
  const controller = new AbortController(); controller.abort('SYNTHETIC_PRIVATE_REASON'); let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ ok: true }); };
  await assert.rejects(fetchJson(url, { signal: controller.signal }, 10, fetcher), unavailable);
  for (const timeout of [0, -1, NaN, Infinity, 1.5]) await assert.rejects(fetchJson(url, {}, timeout, fetcher), unavailable);
  assert.equal(calls, 0);
});

test('비협조 fetch 마감 뒤 늦은 응답은 JSON0·body 취소만이며 추가 전송0', async () => {
  const late = deferred(); let calls = 0, json = 0, cancel = 0, signal;
  const run = fetchJson(url, {}, 5, async (_url, init) => { calls++; signal = init.signal; return late.promise; });
  await assert.rejects(bounded(run), unavailable);
  late.resolve({ status: 200, json: async () => { json++; return {}; }, body: { cancel() { cancel++; return Promise.reject(Error('SYNTHETIC_PRIVATE_BODY')); } } });
  await pause(5);
  assert.equal(signal.aborted, true); assert.equal(getEventListeners(signal, 'abort').length, 0);
  assert.equal(calls, 1); assert.equal(json, 0); assert.equal(cancel, 1);
});

test('비협조 JSON 대기는 마감에 종료하고 늦은 값·cleanup 미완료가 응답을 바꾸지 않음', async () => {
  const late = deferred(); let json = 0, cancel = 0, reads = 0;
  await assert.rejects(bounded(fetchJson(url, {}, 5, async () => ({ status: 200, json() { json++; return late.promise; }, body: { cancel() { cancel++; return new Promise(() => {}); } } }))), unavailable);
  const value = {}; Object.defineProperty(value, 'late', { get() { reads++; return 'SYNTHETIC_PRIVATE_BODY'; } });
  late.resolve(value); await pause(5);
  assert.equal(json, 1); assert.equal(reads, 0); assert.equal(cancel, 1);
});

test('도중 caller 취소를 원 transport에 전달하고 늦은 거절을 안전하게 소비', async () => {
  const controller = new AbortController(), entered = deferred(), late = deferred(); let signal, calls = 0;
  const run = fetchJson(url, { signal: controller.signal }, 1000, async (_url, init) => { calls++; signal = init.signal; entered.resolve(); return late.promise; });
  await entered.promise; controller.abort('SYNTHETIC_PRIVATE_REASON'); await assert.rejects(bounded(run), unavailable);
  late.reject(Error('SYNTHETIC_PRIVATE_KEY')); await pause(5);
  assert.equal(signal.aborted, true); assert.equal(getEventListeners(signal, 'abort').length, 0); assert.equal(calls, 1);
});

test('fetch와 JSON에 같은 총 예산을 적용하며 두 번째 마감을 새로 시작하지 않음', async () => {
  let json = 0;
  await assert.rejects(bounded(fetchJson(url, {}, 80, async () => { await pause(40); return { status: 200, async json() { json++; await pause(60); return {}; } }; })), unavailable);
  assert.equal(json, 1);
});

test('204는 JSON0·null이고 정상 JSON 배열/스칼라/null ABI와 redirect:error 유지', async () => {
  let json = 0;
  assert.deepEqual(await fetchJson(url, {}, 1000, async (_url, init) => { assert.equal(init.redirect, 'error'); return { status: 204, json() { json++; throw Error('MUST_NOT_READ'); }, body: { cancel() { return Promise.resolve(); } } }; }), { status: 204, body: null });
  assert.equal(json, 0);
  for (const value of [null, [1, 'synthetic'], false, 3, 'synthetic']) assert.deepEqual(await fetchJson(url, {}, 1000, async () => Response.json(value)), { status: 200, body: value });
});

test('정상 완료 뒤 caller 취소는 반환값을 바꾸지 않으며 원 fetch/JSON 오류는 비공개', async () => {
  const controller = new AbortController(); let signal;
  const result = await fetchJson(url, { signal: controller.signal }, 1000, async (_url, init) => { signal = init.signal; return Response.json({ ok: true }); });
  controller.abort('SYNTHETIC_PRIVATE_REASON'); assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  for (const json of [false, true]) await assert.rejects(fetchJson(url, {}, 1000, async () => { if (!json) throw Error('SYNTHETIC_PRIVATE_KEY'); return { status: 200, json() { throw Error('SYNTHETIC_PRIVATE_BODY'); } }; }), unavailable);
});

const uid = '11111111-1111-4111-8111-111111111111', rid = '22222222-2222-4222-8222-222222222222';
const request = { task: 'intent', system: 'synthetic', input: { query: 'synthetic' }, maxOutputTokens: 20, memberRequest: { userId: uid, requestId: uid, leaseToken: uid } };
const env = { AI_RETENTION_DECISION_ID: 'synthetic', AI_COST_EVIDENCE_ID: 'synthetic', AI_PROCESSING_LEGAL_DECISION_ID: 'synthetic', AI_MEMBER_TRANSMISSION_APPROVAL_ID: 'synthetic', AI_BUDGET_LEDGER_ID: 'synthetic', POTENS_ACCOUNT_ORDER: 'yumi,jonghyun', POTENS_API_KEY_YUMI: 'synthetic-yumi', POTENS_API_KEY_JONGHYUN: 'synthetic-jonghyun', POTENS_ACCOUNT_TOKEN_BUDGET: '3200000', POTENS_RESET_TIMEZONE: 'Asia/Seoul', POTENS_MODEL: 'synthetic-model', POTENS_API_BASE_URL: 'https://ai.potens.ai', UPSTREAM_TIMEOUT_MS: '1000', POTENS_USAGE_INPUT_FIELD: 'syntheticInput', POTENS_USAGE_OUTPUT_FIELD: 'syntheticOutput' };
for (const pooled of [false, true]) for (const phase of ['reserve', 'settle']) test(`실제 transport→runtime ${pooled ? 'pool' : '단일'} ${phase} 응답 유실은 원 요청 재전송·계정전환0`, async () => {
  const late = deferred(), calls = [], wire = [], durable = { reservation: null, settlement: null };
  const reserve = pooled ? 'reserve_ai_chat_account_model' : 'reserve_ai_chat_model', settle = pooled ? 'settle_ai_account_budget' : 'settle_ai_budget';
  const db = createRpcTransport({ supabaseUrl: 'https://db.synthetic.invalid', upstreamTimeoutMs: 10 }, 'synthetic-service', 'synthetic-service', new Set([reserve, settle]), async (input, init) => {
    const name = String(input).split('/').at(-1), args = JSON.parse(init.body); calls.push({ name, args });
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    if (name === reserve) {
      durable.reservation = { id: rid, account: pooled ? 'yumi' : null, day: pooled ? '2026-10-06' : null };
      if (phase === 'reserve') return late.promise;
      return Response.json(pooled ? { status: 'reserved', accountId: 'yumi', reservationId: rid, accountDay: '2026-10-06' } : { reservationId: rid });
    }
    assert.equal(name, settle); durable.settlement = { ...args }; return late.promise;
  });
  const read = key => key === 'POTENS_MODEL' ? 'claude-5-sonnet' : key === 'POTENS_API_KEY' ? 'synthetic-single' : !pooled && (key.startsWith('POTENS_ACCOUNT_') || key.startsWith('POTENS_API_KEY_') || key === 'POTENS_RESET_TIMEZONE') ? undefined : env[key];
  const runtime = createConfiguredModel(read, { budgetDb: db, outputLimit: { decisionId: 'synthetic', apply: body => body }, fetch: async (_url, init) => { wire.push(init.headers.Authorization); return Response.json({ message: '{"ok":true}', token_usage: { syntheticInput: 10, syntheticOutput: 3 } }); } });
  assert.equal(runtime.status, 'ready'); // 합성 승인 포트 조립이며 실제 준비 증거가 아니다.
  await assert.rejects(bounded(runtime.model.generate(request)), error => {
    assert.equal(error.code, 'MODEL_UNAVAILABLE');
    assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /SYNTHETIC_PRIVATE_(BODY|KEY|REASON)/);
    return true;
  });
  assert.deepEqual(calls.map(call => call.name), phase === 'reserve' ? [reserve] : [reserve, settle]);
  assert.equal(wire.length, phase === 'reserve' ? 0 : 1); assert.equal(durable.reservation.id, rid);
  assert.equal(calls[0].args.p_user_id, uid); assert.equal(calls[0].args.p_request_id, uid); assert.equal(calls[0].args.p_lease_token, uid);
  if (pooled) { assert.equal(calls[0].args.p_account_id, 'yumi'); assert.equal(durable.reservation.day, '2026-10-06'); }
  if (phase === 'settle') { assert.equal(durable.settlement.p_reservation_id, rid); assert.equal(durable.settlement.p_outcome, 'usage_reported'); assert.equal(durable.settlement.p_input_tokens, 10); if (pooled) assert.equal(durable.settlement.p_account_day, '2026-10-06'); }
  late.resolve(Response.json(phase === 'reserve' ? (pooled ? { status: 'reserved', accountId: 'yumi', reservationId: rid, accountDay: '2026-10-06' } : { reservationId: rid }) : { settled: true, pending: false }));
  await pause(5); assert.equal(calls.length, phase === 'reserve' ? 1 : 2); assert.equal(wire.length, phase === 'reserve' ? 0 : 1);
});
