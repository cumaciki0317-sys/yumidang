import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, ServiceApiClient } from '../../apps/mobile/src/api.ts';
import { MemberService } from '../../apps/mobile/src/member-service.ts';
import { aiConsentRevision, aiConsentMutationPending } from '../../apps/mobile/src/ai-consent-state.ts';
const initial = { exploration: false, summary_view: false, summary_generate: false, summary_source: false };
const eligible = { estimatedEligible: true, reason: null, remaining: 20, kstDay: '2026-10-24', checkedAt: '2026-10-24T00:00:00Z', resetsAt: '2026-10-24T15:00:00Z', requestAuthoritative: true };
function setup(result, token = 'synthetic-member') {
  const calls = [];
  const service = new MemberService(new ServiceApiClient('https://synthetic.example/service-api', async () => token, async (url, options) => {
    calls.push({ url, options, body: options.body && JSON.parse(options.body) });
    return Response.json({ data: typeof result === 'function' ? await result() : result });
  }));
  return { service, calls };
}
test('independent consent uses authenticated GET and exact kind/boolean POST without a member ID', async () => {
  const h = setup(initial);
  assert.deepEqual(await h.service.aiConsents(), initial);
  assert.equal(h.calls[0].url, 'https://synthetic.example/service-api/me/ai-consents');
  for (const kind of Object.keys(initial)) {
    await h.service.setAiConsent(kind, false);
    assert.deepEqual(h.calls.at(-1).body, { kind, allowed: false });
    assert.equal(h.calls.at(-1).options.headers.Authorization, 'Bearer synthetic-member');
  }
});
test('legacy or malformed consent arguments never start a request', async () => {
  const h = setup(initial);
  for (const [kind, allowed] of [['review_summary', false], ['summary_view', 'false'], ['summary_source', null]]) await assert.rejects(h.service.setAiConsent(kind, allowed), ApiError);
  assert.equal(h.calls.length, 0);
});
test('unknown or malformed server consent values stay unconfirmed', async () => {
  for (const value of [{ ...initial, summary_view: 'true' }, { exploration: true }, { ...initial, userId: 'unexpected' }]) await assert.rejects(setup(value).service.aiConsents(), { code: 'INVALID_SERVICE_RESPONSE' });
});
test('mutations invalidate old summaries before dispatch and after a lost response', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = setup(async () => { await pending; throw Error('synthetic response loss'); });
  const revision = aiConsentRevision();
  const request = h.service.setAiConsent('summary_source', false);
  assert.equal(aiConsentMutationPending(), true);
  assert.ok(aiConsentRevision() > revision);
  release();
  await assert.rejects(request);
  assert.equal(aiConsentMutationPending(), false);
  assert.ok(aiConsentRevision() >= revision + 2);
});
test('availability consumes the server reason, remaining and times, without a model request', async () => {
  for (const reason of [null, 'processing_disabled', 'consent_required', 'concurrent', 'daily_limit']) {
    const value = { ...eligible, estimatedEligible: reason === null, reason, remaining: reason === 'daily_limit' ? 0 : 19 };
    const h = setup(value);
    assert.deepEqual(await h.service.aiAvailability(), value);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, 'https://synthetic.example/service-api/me/ai-availability');
  }
});
test('malformed availability cannot enable sending', async () => {
  for (const patch of [{ remaining: 21 }, { reason: 'unknown' }, { estimatedEligible: false }, { requestAuthoritative: false }, { kstDay: '2026-02-30' }, { resetsAt: eligible.checkedAt }]) await assert.rejects(setup({ ...eligible, ...patch }).service.aiAvailability(), { code: 'INVALID_SERVICE_RESPONSE' });
  await assert.rejects(setup(eligible, null).service.aiAvailability(), { code: 'AUTH_REQUIRED' });
});
