/** NIL probe의 최소 거절 계약 회귀. 실제 SQL·모델 승인 증거가 아니다. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeSummaryWorkerRpcs } from '../../../backend/supabase/functions/review-summary-worker/handler.ts';
import { HttpError } from '../../../backend/supabase/functions/_shared/http/errors.ts';
import type { JsonValue } from '../../../backend/supabase/functions/_shared/contracts/common.ts';
const nil = '00000000-0000-0000-0000-000000000000';
test('NIL 대상의 동의 선행 거절은 RPC 존재 확인이며 실제 승인·예약으로 처리하지 않는다', async () => {
  for (const status of ['consent_revoked', 'lease_lost']) {
    const calls: string[] = [];
    const ready = await probeSummaryWorkerRpcs({ async rpc(name, args) {
      calls.push(name); assert.equal(args.p_job_id, nil); assert.equal(args.p_worker_run_token, nil);
      if (['yield_job', 'fail_job', 'supersede_job'].includes(name)) throw new HttpError('STATE_CONFLICT');
      return { status: name === 'reserve_review_summary_model' ? status : 'lease_lost' };
    } });
    assert.equal(ready, 'ready'); assert.equal(calls.length, 10);
    assert.equal(calls.includes('claim_job'), false); assert.equal(calls.includes('reserve_ai_budget'), false);
  }
});
test('예약 성공·추가 필드·다른 RPC의 동의 거절은 준비 완료로 인정하지 않는다', async () => {
  for (const body of [{ status: 'reserved' }, { status: 'consent_revoked', ledgerId: 'probe' }, null]) {
    let calls = 0;
    assert.equal(await probeSummaryWorkerRpcs({ async rpc() { calls++; return body as JsonValue; } }), 'DB_RPC_UNAVAILABLE');
    assert.equal(calls, 1);
  }
  let calls = 0;
  assert.equal(await probeSummaryWorkerRpcs({ async rpc() { calls++; return { status: 'consent_revoked' }; } }), 'DB_RPC_UNAVAILABLE');
  assert.equal(calls, 2);
});
test('권한 거절·미적용 RPC는 작업 점유 전에 닫힌다', async () => {
  for (const [code, expected] of [['ACCESS_DENIED', 'DB_RPC_NOT_ALLOWED'], ['RESOURCE_NOT_FOUND', 'DB_RPC_UNAVAILABLE']] as const) {
    let calls = 0;
    assert.equal(await probeSummaryWorkerRpcs({ async rpc() { calls++; throw new HttpError(code); } }), expected);
    assert.equal(calls, 1);
  }
});
