/** 승인된 소량 공개 HTTPS 읽기. 키는 JSON stdin으로만 공급하며 본문/URL을 출력하지 않는다. */
import { createKakaoPlacesAdapter } from '../../../backend/supabase/functions/_shared/integrations/places/adapter.ts';
import { createKopisEventProvider, parseFlatDbsXml } from '../../../backend/supabase/functions/_shared/integrations/events/kopis.ts';
import { createKopisDetailProvider } from '../../../backend/supabase/functions/_shared/integrations/events/detail.ts';
import { createKopisRankingProvider, kopisRankingPeriod } from '../../../backend/supabase/functions/_shared/integrations/events/kopis-ranking.ts';
import { createTourApiEventProvider, createTourApiDetailProvider } from '../../../backend/supabase/functions/_shared/integrations/events/tourapi.ts';
import { seoulCalendarDate } from '../../../backend/supabase/functions/_shared/integrations/events/normalize.ts';

const codes = new Set(['SOURCE_AUTH_REJECTED', 'SOURCE_RATE_LIMITED', 'SOURCE_REJECTED', 'SOURCE_UNAVAILABLE', 'SOURCE_INVALID_RESPONSE', 'SOURCE_TIMEOUT', 'CANCELLED', 'INVALID_EVENT_REQUEST', 'INVALID_PLACE_CONFIG', 'INVALID_PLACE_INPUT', 'PLACE_PROVIDER_UNCONFIGURED', 'EVENT_PROVIDER_UNCONFIGURED']);
const allowed = {
  kakao: { origin: 'https://dapi.kakao.com', paths: [/^\/v2\/local\/search\/keyword\.json$/] },
  kopis: { origin: 'https://kopis.or.kr', paths: [/^\/openApi\/restful\/pblprfr(?:\/PF[0-9A-Za-z]+)?$/, /^\/openApi\/restful\/boxoffice$/] },
  tour: { origin: 'https://apis.data.go.kr', paths: [/^\/B551011\/KorService2\/(searchFestival2|detailCommon2|detailIntro2)$/] },
};
type Provider = keyof typeof allowed;
const calls: Record<Provider, number> = { kakao: 0, kopis: 0, tour: 0 };
const http: Record<Provider, number[]> = { kakao: [], kopis: [], tour: [] };
const resume = process.argv[2] === '--resume-network-check';
const finish = process.argv[2] === '--finish-approved-details';
const fullDiagnostic = process.argv[2] === '--diagnose-ranking-full';
const diagnostic = process.argv[2] === '--diagnose-ranking' || fullDiagnostic;
let retainedRankingBody: string | undefined;
// 이전 샌드박스 DNS 실패 시도까지 누적 예산에 포함한다.
const prior: Record<Provider, number> = finish ? { kakao: 1, kopis: 1, tour: 1 } : resume ? { kakao: 1, kopis: 2, tour: 1 } : { kakao: 0, kopis: 0, tour: 0 };
const limits: Record<Provider, number> = diagnostic ? { kakao: 0, kopis: 1, tour: 0 } : finish ? { kakao: 1, kopis: 4, tour: 4 } : { kakao: 3, kopis: 3, tour: 3 };
let halted = false;
let failed = false;
function transport(provider: Provider) {
  return async (address: string, init: RequestInit): Promise<Response> => {
    const url = new URL(address);
    const rule = allowed[provider];
    if (halted || url.origin !== rule.origin || url.username || url.password || url.hash ||
      !rule.paths.some(path => path.test(url.pathname)) || init.method !== 'GET' || init.body != null ||
      calls[provider] + prior[provider] >= limits[provider] || Object.values(calls).reduce((a, b) => a + b, 0) + Object.values(prior).reduce((a, b) => a + b, 0) >= 9) {
      halted = true;
      throw Object.assign(new Error(''), { code: 'TRANSPORT_GUARD_REJECTED' });
    }
    calls[provider]++;
    const signal = AbortSignal.any([AbortSignal.timeout(10000), ...(init.signal ? [init.signal] : [])]);
    const response = await fetch(url, { ...init, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    http[provider].push(response.status);
    if (response.status === 401 || response.status === 403) halted = true;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 524288) {
            await reader.cancel();
            throw Object.assign(new Error(''), { code: 'RESPONSE_TOO_LARGE' });
          }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
    }
    const body = Buffer.concat(chunks);
    if (diagnostic) {
      const xml = body.toString('utf8');
      const contentType = response.headers.get('content-type') ?? '';
      const root = /^\s*(?:<\?xml[^?]*\?>\s*)?<([A-Za-z_][A-Za-z0-9_]*)\b/.exec(xml)?.[1];
      const basedate = /<basedate>([\s\S]*?)<\/basedate>/.exec(xml)?.[1];
      if (fullDiagnostic) {
        retainedRankingBody = xml;
        const looseDate = /<basedate\b([^>]*)>([\s\S]*?)<\/basedate\s*>/.exec(xml);
        const dateText = looseDate?.[2].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim();
        const dateParts = dateText ? /^(\d{4}[-.]\d{2}[-.]\d{2})\s*~\s*(\d{4}[-.]\d{2}[-.]\d{2})$/.exec(dateText) : null;
        const requested = kopisRankingPeriod(new Date());
        const boxofs = [...xml.matchAll(/<boxof\b([^>]*)(?:>([\s\S]*?)<\/boxof\s*>|\/\s*>)/g)];
        const fields = new Set(['cate','rnum','prfnm','prfpd','prfplcnm','seatcnt','prfdtcnt','area','poster','mt20id']);
        let unknownFieldCount = 0, missingRequiredCount = 0, rankSequence = true, datesValidFormat = true, idsValid = true;
        const ids = new Set<string>();
        for (const [i, item] of boxofs.entries()) {
          const tags = [...(item[2] ?? '').matchAll(/<([A-Za-z_][A-Za-z0-9_]*)\b[^>]*>([\s\S]*?)<\/\1\s*>/g)];
          const row = Object.fromEntries(tags.map(tag => [tag[1], tag[2].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim()]));
          unknownFieldCount += tags.filter(tag => !fields.has(tag[1])).length;
          missingRequiredCount += ['cate','rnum','prfnm','prfpd','prfplcnm','area','mt20id'].filter(key => !row[key]).length;
          rankSequence &&= row.rnum === String(i + 1);
          datesValidFormat &&= /^\d{4}\.\d{2}\.\d{2}\s*~\s*\d{4}\.\d{2}\.\d{2}$/.test(row.prfpd ?? '');
          idsValid &&= /^PF[0-9A-Za-z]+$/.test(row.mt20id ?? '') && !ids.has(row.mt20id);
          ids.add(row.mt20id);
        }
        console.log(JSON.stringify({ provider:'kopis', operation:'ranking_full_shape', looseBasedatePresent: !!looseDate, basedateWhitespace: !!looseDate && /\s/.test(looseDate[1]), basedateAttributes: !!looseDate && !!looseDate[1].trim(), basedateCdata: !!looseDate && /<!\[CDATA\[/.test(looseDate[2]), basedateFlexibleDateFormat: !!dateParts, flexiblePeriodMatches: !!dateParts && dateParts[1].replaceAll('.', '-') === requested.start && dateParts[2].replaceAll('.', '-') === requested.end, rootHasAttributes: /^\s*(?:<\?xml[^?]*\?>\s*)?<boxofs\s+[^>]*\S[^>]*>/.test(xml), rootSelfClosing: /<boxofs\s*\/>/.test(xml), boxofCount:boxofs.length, itemAttributes:boxofs.some(item=>!!item[1].trim()), anyCdata:/<!\[CDATA\[/.test(xml), anyComments:/<!--/.test(xml), anyDoctype:/<!DOCTYPE/i.test(xml), leadingBom:xml.startsWith('\ufeff'), unknownFieldCount, missingRequiredCount, rankSequence:boxofs.length > 0 && rankSequence, datesValidFormat:boxofs.length > 0 && datesValidFormat, idsValid:boxofs.length > 0 && idsValid }));
      }
      const format = basedate ? /^(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})$/.exec(basedate) : null;
      const period = kopisRankingPeriod(new Date());
      const envelope = /^(<\?xml[^?]*\?>\s*)?<boxofs>\s*<basedate>(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})<\/basedate>([\s\S]*)<\/boxofs>\s*$/.exec(xml);
      let flatParsed = false, itemShape = false;
      let count = 0;
      if (envelope) {
        try {
          const rows = parseFlatDbsXml(`${envelope[1] ?? ''}<dbs>${envelope[4].replace(/<boxof>/g, '<db>').replace(/<\/boxof>/g, '</db>')}</dbs>`);
          flatParsed = true;
          count = rows.length;
          const fields = new Set(['cate','rnum','prfnm','prfpd','prfplcnm','seatcnt','prfdtcnt','area','poster','mt20id']);
          itemShape = count > 0 && rows.every((row, i) => Object.keys(row).every(key => fields.has(key)) && row.rnum === String(i + 1) && /^PF[0-9A-Za-z]+$/.test(row.mt20id ?? '') && /^(\d{4})\.(\d{2})\.(\d{2})\s*~\s*(\d{4})\.(\d{2})\.(\d{2})$/.test(row.prfpd ?? ''));
        } catch { /* 원문과 예외는 출력하지 않는다. */ }
      }
      console.log(JSON.stringify({ provider: 'kopis', operation: 'ranking_diagnostic', http: response.status, contentTypeXml: /(?:text|application)\/xml/i.test(contentType), contentTypeHtml: /text\/html/i.test(contentType), rootTag: ['boxofs','dbs','response','html'].includes(root ?? '') ? root : 'OTHER', basedatePresent: basedate !== undefined, basedateExpectedFormat: !!format, periodMatches: !!format && format[1] === period.start && format[2] === period.end, strictEnvelopeMatches: !!envelope, flatParsed, itemShape, count }));
    }
    return new Response(body, { status: response.status, headers: response.headers });
  };
}
async function probe(provider: Provider, operation: string, run: () => Promise<Record<string, unknown>>) {
  if (halted) {
    console.log(JSON.stringify({ provider, operation, status: 'NOT_RUN', reason: 'PREVIOUS_SECURITY_OR_AUTH_FAILURE' }));
    return null;
  }
  const before = calls[provider];
  try {
    const result = await run();
    console.log(JSON.stringify({ provider, operation, status: 'PASS', ...result, calls: calls[provider] - before, http: http[provider].slice(before) }));
    return result;
  } catch (error) {
    failed = true;
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
    if (code === 'SOURCE_AUTH_REJECTED' || code === 'TRANSPORT_GUARD_REJECTED') halted = true;
    console.log(JSON.stringify({ provider, operation, status: 'FAIL', code: codes.has(code) || ['TRANSPORT_GUARD_REJECTED', 'RESPONSE_TOO_LARGE'].includes(code) ? code : 'UNCLASSIFIED_FAILURE', calls: calls[provider] - before, http: http[provider].slice(before) }));
    return null;
  }
}
async function main() {
  if (process.argv[2] !== '--run' && !resume && !finish && !diagnostic) {
    console.log(JSON.stringify({ status: 'NOT_RUN', reason: 'EXPLICIT_RUN_REQUIRED' }));
    return;
  }
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk.toString();
    if (raw.length > 8192) throw new Error('INPUT_REJECTED');
  }
  const keys = JSON.parse(raw);
  raw = '';
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) ||
    Object.keys(keys).length !== 4 ||
    !['KAKAO_REST_API_KEY', 'KOPIS_API_KEY', 'TOUR_API_SERVICE_KEY', 'TOUR_API_KEY_FORMAT'].every(k => Object.hasOwn(keys, k)) ||
    !['KAKAO_REST_API_KEY', 'KOPIS_API_KEY', 'TOUR_API_SERVICE_KEY'].every(k => typeof keys[k] === 'string' && keys[k].length > 0 && keys[k].length <= 1024 && !/\s|example|placeholder|your[_ -]|replace|synthetic|changeme/iu.test(keys[k])) ||
    !['encoded', 'decoded'].includes(keys.TOUR_API_KEY_FORMAT)) throw new Error('INPUT_REJECTED');
  const now = () => new Date();
  const date = seoulCalendarDate(now());
  const period = { start: date, end: date };
  if (diagnostic) {
    await probe('kopis', 'ranking_all', async () => {
      const result = await createKopisRankingProvider({ apiKey: keys.KOPIS_API_KEY, timeoutMs: 10000, fetch: transport('kopis'), now }).collect('all');
      return { count: result.items.length, periodVerification: result.periodVerification };
    });
    process.exitCode = failed ? 1 : 0;
    if (fullDiagnostic && retainedRankingBody) {
      for (let pass = 0; pass < 4; pass++) {
        await new Promise(resolve => setTimeout(resolve, 15000));
        try {
          const local = await import(`../../../backend/supabase/functions/_shared/integrations/events/kopis-ranking.ts?memory-recheck=${pass}`);
          const result = local.parseKopisRankingXml(retainedRankingBody, 'all', kopisRankingPeriod(now()), now());
          console.log(JSON.stringify({ operation: 'same_body_local_recheck', status:'PASS', count:result.items.length }));
        } catch { console.log(JSON.stringify({ operation:'same_body_local_recheck', status:'FAIL', code:'SOURCE_INVALID_RESPONSE' })); }
      }
      retainedRankingBody = undefined;
    }
    return;
  }
  const kakao = createKakaoPlacesAdapter({ apiKey: keys.KAKAO_REST_API_KEY, timeoutMs: 10000, pageSize: 1, fetch: transport('kakao') });
  if (!finish) await probe('kakao', 'public_place_lookup', async () => {
    const result = await kakao.lookup({ query: '국립중앙박물관', page: 1 }, { principal: { kind: 'member', userId: 'synthetic-adapter-input-only' } });
    return { count: result.places.length, empty: result.places.length === 0 };
  });
  else console.log(JSON.stringify({ provider: 'kakao', operation: 'public_place_lookup', status: 'NOT_RUN', reason: 'PREVIOUS_LIVE_PASS_NO_REPEAT' }));
  const kopisOptions = { apiKey: keys.KOPIS_API_KEY, timeoutMs: 10000, rows: 1, fetch: transport('kopis'), now };
  let kopisId: string | undefined;
  await probe('kopis', 'list', async () => {
    const result = await createKopisEventProvider(kopisOptions).fetchPage({ period, page: 1 });
    kopisId = result.events[0]?.sourceId;
    return { count: result.events.length, empty: result.events.length === 0 };
  });
  if (kopisId && !resume) await probe('kopis', 'detail', async () => {
    await createKopisDetailProvider(kopisOptions).fetchDetail(kopisId!);
    return { count: 1 };
  });
  else console.log(JSON.stringify({ provider: 'kopis', operation: 'detail', status: 'NOT_RUN', reason: resume ? 'CUMULATIVE_CALL_BUDGET' : 'NO_VERIFIED_LIST_ID' }));
  if (!resume) await probe('kopis', 'ranking_all', async () => {
    const result = await createKopisRankingProvider(kopisOptions).collect('all');
    return { count: result.items.length, periodVerification: result.periodVerification };
  });
  else console.log(JSON.stringify({ provider: 'kopis', operation: 'ranking_all', status: 'NOT_RUN', reason: 'CUMULATIVE_CALL_BUDGET' }));
  const tourOptions = { serviceKey: keys.TOUR_API_SERVICE_KEY, keyFormat: keys.TOUR_API_KEY_FORMAT, timeoutMs: 10000, rows: 1, fetch: transport('tour'), now };
  let tourId: string | undefined;
  await probe('tour', 'list', async () => {
    const result = await createTourApiEventProvider(tourOptions).fetchPage({ period, page: 1 });
    tourId = result.events[0]?.sourceId;
    return { count: result.events.length, empty: result.events.length === 0 };
  });
  if (tourId && !resume) await probe('tour', 'detail_common_and_intro', async () => {
    await createTourApiDetailProvider(tourOptions).fetchDetail(tourId!);
    return { count: 1 };
  });
  else console.log(JSON.stringify({ provider: 'tour', operation: 'detail_common_and_intro', status: 'NOT_RUN', reason: resume ? 'ADAPTER_REQUIRES_TWO_CALLS_EXCEEDING_CUMULATIVE_BUDGET' : 'NO_VERIFIED_LIST_ID' }));
  console.log(JSON.stringify({ status: failed ? 'PARTIAL_FAILURE' : 'COMPLETED', calls, cumulativeAttempts: Object.fromEntries(Object.keys(calls).map(key => [key, calls[key as Provider] + prior[key as Provider]])), priorDnsFailuresExcluded: finish ? { kakao: 1, kopis: 2, tour: 1 } : undefined, remoteDatabaseWrites: 0, actualMemberDataSent: false }));
  process.exitCode = failed ? 1 : 0;
}
main().catch(() => {
  console.log(JSON.stringify({ status: 'FAIL', code: 'SAFE_INPUT_OR_SETUP_FAILURE' }));
  process.exitCode = 1;
});
