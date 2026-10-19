/** 실제 제공처 factory와 영속 collector의 조합 회귀. fetch는 합성 응답만 반환한다. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runEventCollection } from '../../../backend/supabase/functions/_shared/jobs/event-collection.ts';
import { createKopisEventProvider } from '../../../backend/supabase/functions/_shared/integrations/events/kopis.ts';
import { createTourApiEventProvider } from '../../../backend/supabase/functions/_shared/integrations/events/tourapi.ts';

const period = { start: '2026-10-05', end: '2026-10-11' };
function fixture(provider, total) {
  const requested = [], applied = new Set();
  let commits = 0;
  let progress = { provider, lane: 'future', period, jobId: 'synthetic-job', leaseToken: 'synthetic-lease', nextPage: 1, collectedPages: 0 };
  const fetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.protocol, 'https:'); assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.ok(init.signal instanceof AbortSignal);
    const number = Number(url.searchParams.get(provider === 'kopis' ? 'cpage' : 'pageNo'));
    requested.push(number);
    const ids = Array.from({ length: Math.max(0, Math.min(2, total - (number - 1) * 2)) }, (_, i) => (number - 1) * 2 + i + 1);
    if (provider === 'kopis') {
      assert.equal(url.origin + url.pathname, 'https://kopis.or.kr/openApi/restful/pblprfr');
      const rows = ids.map(id => `<db><mt20id>PF${id}</mt20id><prfnm>합성 공연 ${id}</prfnm><prfpdfrom>2026.10.05</prfpdfrom><prfpdto>2026.10.11</prfpdto><prfstate>공연예정</prfstate></db>`).join('');
      return new Response(`<dbs>${rows}</dbs>`, { headers: { 'content-type': 'application/xml' } });
    }
    assert.equal(url.origin + url.pathname, 'https://apis.data.go.kr/B551011/KorService2/searchFestival2');
    const items = ids.map(id => ({ contentid: String(id), title: `합성 행사 ${id}`, eventstartdate: '20261005', eventenddate: '20261011' }));
    return Response.json({ response: { header: { resultCode: '0000' }, body: { totalCount: total, numOfRows: 2, pageNo: number, items: items.length ? { item: items } : '' } } });
  };
  const common = { rows: 2, timeoutMs: 1000, fetch, now: () => new Date('2026-10-05T01:00:00Z') };
  const port = provider === 'kopis' ? createKopisEventProvider({ ...common, apiKey: 'synthetic-key' })
    : createTourApiEventProvider({ ...common, serviceKey: 'synthetic-key', keyFormat: 'decoded' });
  const store = {
    async load() { return structuredClone(progress); },
    async commitPage(input) {
      assert.equal(input.progress.nextPage, progress.nextPage);
      for (const event of input.events) {
        assert.equal(event.provider, provider); assert.equal(applied.has(event.sourceId), false);
        applied.add(event.sourceId);
      }
      commits++;
      if (input.next) progress = { ...progress, nextPage: input.next.page, cursor: input.next.cursor, collectedPages: progress.collectedPages + 1 };
      return 'applied';
    },
  };
  return { port, store, requested, applied, get commits() { return commits; },
    get progress() { return structuredClone(progress); }, set progress(value) { progress = value; },
    run: () => runEventCollection({ reference: { provider, lane: 'future', period }, provider: port, store, maxPages: 5, providerMaxPage: 999 }) };
}

for (const provider of ['kopis', 'tour-api']) {
  test(`${provider}: 실제 factory의 2쪽을 collector가 중복 효과 없이 수집`, async () => {
    const f = fixture(provider, 3);
    assert.deepEqual(await f.run(), { status: 'complete', pages: 2, fetchedCount: 3 });
    assert.deepEqual(f.requested, [1, 2]); assert.equal(f.applied.size, 3); assert.equal(f.commits, 2);
  });
  test(`${provider}: 5쪽 yield의 영속 page/cursor로 다음 실행에서 6쪽부터 재개`, async () => {
    const f = fixture(provider, 13);
    assert.deepEqual(await f.run(), { status: 'partial', pages: 5, fetchedCount: 10, nextPage: 6 });
    assert.equal(f.progress.nextPage, 6); assert.equal(f.progress.cursor, '6');
    assert.deepEqual(await f.run(), { status: 'complete', pages: 2, fetchedCount: 3 });
    assert.deepEqual(f.requested, [1, 2, 3, 4, 5, 6, 7]); assert.equal(f.applied.size, 13); assert.equal(f.commits, 7);
  });
  test(`${provider}: page와 다른 저장 cursor는 실제 transport 호출·효과 전에 거절`, async () => {
    for (const cursor of ['3', '02', 'opaque']) {
      const f = fixture(provider, 3); f.progress = { ...f.progress, nextPage: 2, cursor };
      await assert.rejects(f.run(), /INVALID_EVENT_COLLECTION_PROGRESS/);
      assert.equal(f.requested.length, 0); assert.equal(f.commits, 0);
    }
  });
  test(`${provider}: 실제 transport 자체의 cursor 거절 계약 유지`, async () => {
    const f = fixture(provider, 3);
    await assert.rejects(f.port.fetchPage({ page: 2, cursor: '2', period }), /INVALID_EVENT_REQUEST/);
    assert.equal(f.requested.length, 0);
  });
}

test('페이지 방식 공급사가 건너뛰는 nextCursor를 반환하면 영속 commit 전에 거절', async () => {
  const f = fixture('kopis', 3);
  await assert.rejects(runEventCollection({ reference: { provider: 'kopis', lane: 'future', period },
    provider: { provider: 'kopis', fetchPage: async () => ({ events: [], nextCursor: '3' }) },
    store: f.store, maxPages: 5, providerMaxPage: 999 }), /INVALID_EVENT_COLLECTION_PAGE/);
  assert.equal(f.commits, 0);
});

test('진행 중 목록의 opaque 원천ID cursor는 그대로 전달', async () => {
  const f = fixture('kopis', 0), seen = [];
  f.progress = { ...f.progress, lane: 'ongoing' };
  const result = await runEventCollection({ reference: { provider: 'kopis', lane: 'ongoing', period },
    provider: f.port, ongoingProvider: { provider: 'kopis', async fetchPage(request) {
      seen.push(request.cursor); return { events: [], ...(request.cursor === undefined ? { nextCursor: 'PF-tail' } : {}) };
    } }, store: f.store, maxPages: 5, providerMaxPage: 999 });
  assert.equal(result.status, 'complete'); assert.deepEqual(seen, [undefined, 'PF-tail']); assert.equal(f.requested.length, 0);
});

for (const provider of ['kopis', 'tour-api']) {
  test(`${provider}: 실제 공급사 상한999쪽의 미수집 범위는 완료 대신 partial로 보존`, async () => {
    const f = fixture(provider, 2000);
    f.progress = { ...f.progress, nextPage: 999, cursor: '999', collectedPages: 998 };
    assert.deepEqual(await f.run(), { status: 'partial', pages: 1, fetchedCount: 2,
      nextPage: 1000, reason: 'PROVIDER_PAGE_LIMIT' });
    assert.deepEqual(f.requested, [999]); assert.equal(f.commits, 1);
    assert.equal(f.progress.nextPage, 1000); assert.equal(f.progress.cursor, '1000');
    // 재개해도 공급사의 범위 밖 요청이나 완료로 바꾸지 않는다.
    assert.deepEqual(await f.run(), { status: 'partial', pages: 0, fetchedCount: 0,
      nextPage: 1000, reason: 'PROVIDER_PAGE_LIMIT' });
    await assert.rejects(f.port.fetchPage({ page: 1000, period }), /INVALID_EVENT_REQUEST/);
    assert.deepEqual(f.requested, [999]); assert.equal(f.commits, 1);
  });
}
