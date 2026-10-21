/** 합성 transport만 사용한다. 실제 키·API·회원 원문·비용은 사용하지 않는다. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { loadGeminiLlmConfig as load } from '../../../backend/supabase/functions/_shared/config/providers.ts';
import { createGeminiModel as create, type GeminiAdapterConfig } from '../../../backend/supabase/functions/_shared/ai/providers/gemini-adapter.ts';
import { ModelError } from '../../../backend/supabase/functions/_shared/ai/providers/provider-errors.ts';
import { createModelRouter } from '../../../backend/supabase/functions/_shared/ai/providers/provider-adapter.ts';
import type { ModelRequest } from '../../../backend/supabase/functions/_shared/ai/providers/model-port.ts';
const key = 'synthetic-private-gemini-key';
const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({ task: 'intent', system: '가상 조건을 JSON으로 반환', input: { text: '가상 산책' }, maxOutputTokens: 800, ...extra });
const payload = (extra: Record<string, unknown> = {}) => ({ candidates: [{ content: { role: 'model', parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 }, modelVersion: 'gemini-3.5-flash-lite', ...extra });
const model = (fetch: GeminiAdapterConfig['fetch'] = async () => Response.json(payload()), extra: Partial<GeminiAdapterConfig> = {}) => { assert.equal(typeof create, 'function'); return create({ apiKey: key, model: 'gemini-3.5-flash-lite', timeoutMs: 1000, fetch, ...extra }); };
const failure = (code: string, dispatch = 'sent', usage: unknown = null) => (error: unknown) => {
  assert.ok(error instanceof ModelError); assert.equal(error.code, code); assert.equal(error.dispatchState, dispatch); assert.deepEqual(error.usage, usage);
  assert.doesNotMatch(inspect(error), /synthetic-private|가상 산책|provider-secret/); return true;
};

test('Gemini loader와 wire adapter가 독립 포트로 제공된다', () => { assert.equal(typeof load, 'function'); assert.equal(typeof create, 'function'); });
test('loader는 명시3키만 읽고 로그와 열거에서 비밀을 숨긴다', () => {
  const accessed: string[] = []; const values: Record<string,string> = { GEMINI_API_KEY: key, GEMINI_MODEL: 'gemini-3.5-flash-lite', UPSTREAM_TIMEOUT_MS: '1000' };
  const config = load((name: string) => { accessed.push(name); return values[name]; });
  assert.deepEqual(accessed, ['GEMINI_API_KEY', 'GEMINI_MODEL', 'UPSTREAM_TIMEOUT_MS']); assert.equal(config.apiKey, key);
  assert.deepEqual(Object.keys(config), ['provider']); assert.deepEqual(JSON.parse(JSON.stringify(config)), { provider: 'gemini', configured: true });
  assert.doesNotMatch(inspect(config), /synthetic-private/); assert.ok(Object.isFrozen(config));
  for (const [field, value] of [['GEMINI_API_KEY',''], ['GEMINI_API_KEY','x\ny'], ['GEMINI_MODEL','models/gemini-3.5-flash-lite'], ['GEMINI_MODEL','other-model'], ['UPSTREAM_TIMEOUT_MS','0']]) {
    assert.throws(() => load((name: string) => name === field ? value : values[name]));
  }
});
test('고정 HTTPS POST header와 system/input 및 요청 출력상한을 wire에 전달한다', async () => {
  let calls=0;
  const result=await model(async (url: string, init: RequestInit) => {
    calls++; assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    assert.equal(init.method,'POST'); assert.equal(init.redirect,'error'); assert.equal(init.credentials,'omit'); assert.equal(init.cache,'no-store');
    assert.equal(new Headers(init.headers).get('x-goog-api-key'), key); assert.doesNotMatch(url, /key/);
    const body=JSON.parse(init.body as string); assert.deepEqual(body, { systemInstruction:{parts:[{text:'가상 조건을 JSON으로 반환'}]}, contents:[{role:'user',parts:[{text:'{"text":"가상 산책"}'}]}], generationConfig:{candidateCount:1,maxOutputTokens:600,responseMimeType:'application/json'} });
    return Response.json(payload());
  }).generate(request({task:'preference_match',maxOutputTokens:600}));
  assert.equal(calls,1); assert.deepEqual(result.value,{ok:true}); assert.deepEqual(result.usage,{inputTokens:100,outputTokens:50}); assert.equal(result.reportedModel,'gemini-3.5-flash-lite');
});
test('요청 모델·타임아웃·키와 task별 출력 한도 오류는 전송0이다', async () => {
  for (const config of [{model:'other'}, {apiKey:'x y'}, {timeoutMs:0}]) assert.throws(() => model(undefined,config as Partial<GeminiAdapterConfig>), failure('NOT_CONFIGURED','unknown'));
  let calls=0; const m=model(async()=>{calls++;return Response.json(payload());});
  for (const extra of [{maxOutputTokens:0},{maxOutputTokens:801},{task:'preference_match',maxOutputTokens:601},{task:'unknown',maxOutputTokens:1},{maxOutputTokens:1.1}]) await assert.rejects(m.generate(request(extra as any)),failure('INVALID_MODEL_RESPONSE','not_sent'));
  assert.equal(calls,0);
});
for (const [name,usage,want] of [
  ['cache는 prompt의 부분량이며 이중 합산하지 않음',{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:30,totalTokenCount:150,cachedContentTokenCount:80},{inputTokens:100,outputTokens:50}],
  ['thinking 없는 완전한 합',{promptTokenCount:100,candidatesTokenCount:20,totalTokenCount:120},{inputTokens:100,outputTokens:20}],
  ['thinking 내역 없이 합이 남으면 추정하지 않음',{promptTokenCount:100,candidatesTokenCount:20,totalTokenCount:150},null],
  ['누락 metadata',undefined,null], ['누락 prompt',{candidatesTokenCount:20,totalTokenCount:120},null],
  ['합 불일치',{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:30,totalTokenCount:149},null],
  ['음수',{promptTokenCount:-1,candidatesTokenCount:20,totalTokenCount:19},null], ['boolean',{promptTokenCount:true,candidatesTokenCount:20,totalTokenCount:21},null],
  ['정수 overflow',{promptTokenCount:Number.MAX_SAFE_INTEGER,candidatesTokenCount:20,totalTokenCount:Number.MAX_SAFE_INTEGER+20},null],
  ['cache 초과',{promptTokenCount:100,candidatesTokenCount:20,totalTokenCount:120,cachedContentTokenCount:101},null],
  ['미허용 tool 사용량',{promptTokenCount:100,candidatesTokenCount:20,totalTokenCount:121,toolUsePromptTokenCount:1},null],
] as const) test(`usage: ${name}`, async()=>{assert.deepEqual((await model(async()=>Response.json(payload({usageMetadata:usage}))).generate(request())).usage,want);});
test('MAX_TOKENS·차단·잘못된 JSON도 확인된 사용량은 실패 증거로 보존한다', async()=>{
  for (const candidates of [[],[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{'}]}}],[{finishReason:'STOP',content:{parts:[{text:'provider-secret-not-json'}]}}],[{finishReason:'STOP',content:{parts:[{functionCall:{name:'x'}}]}}]]) {
    await assert.rejects(model(async()=>Response.json(payload({candidates}))).generate(request()),failure('INVALID_MODEL_RESPONSE','sent',{inputTokens:100,outputTokens:50}));
  }
});
test('보고 출력이 요청 상한을 넘으면 실제 보고량을 남기고 거절한다', async()=>{
  await assert.rejects(model().generate(request({maxOutputTokens:32})),failure('INVALID_MODEL_RESPONSE','sent',{inputTokens:100,outputTokens:50}));
});
test('응답 유실·429·오류·redirect는 전송1회 UNKNOWN이며 재시도하지 않는다', async()=>{
  for (const [transport,code] of [[()=>{throw new Error('provider-secret');},'MODEL_UNAVAILABLE'],[()=>new Response('',{status:429}),'RATE_LIMITED'],[()=>new Response('',{status:500}),'MODEL_UNAVAILABLE'],[()=>new Response('',{status:302,headers:{Location:'https://evil.invalid'}}),'PROVIDER_REJECTED'],[()=>new Response('badjson'),'INVALID_MODEL_RESPONSE']] as const) {
    let calls=0; await assert.rejects(model(async()=>{calls++;return transport();}).generate(request()),failure(code)); assert.equal(calls,1);
  }
});
test('fetch가 반환한 redirected 응답도 본문을 사용하지 않는다', async()=>{
  const response=Response.json(payload()); Object.defineProperty(response,'redirected',{value:true});
  await assert.rejects(model(async()=>response).generate(request()),failure('PROVIDER_REJECTED'));
});
test('header 대기와 body 대기를 포함한 총 마감은 무응답 transport에도 종료한다', async()=>{
  for (const fetch of [()=>new Promise(()=>{}),async()=>new Response(new ReadableStream({start(){}}))]) {
    let calls=0; await assert.rejects(model((...args: any[])=>{calls++;return (fetch as any)(...args);},{timeoutMs:20}).generate(request()),failure('TIMEOUT')); assert.equal(calls,1);
  }
});
test('선취소는 전송0, 전송뒤 취소는 sent UNKNOWN이다', async()=>{
  const before=new AbortController();before.abort();let calls=0;
  await assert.rejects(model(async()=>{calls++;return Response.json(payload());}).generate(request({signal:before.signal})),failure('CANCELLED','not_sent'));assert.equal(calls,0);
  const after=new AbortController();await assert.rejects(model(async()=>{calls++;after.abort();return Response.json(payload());}).generate(request({signal:after.signal})),failure('CANCELLED'));assert.equal(calls,1);
});
test('응답 최대바이트를 초과하면 sent UNKNOWN으로 거절한다',async()=>{
  await assert.rejects(model(async()=>new Response('x'.repeat(1_048_577))).generate(request()),failure('INVALID_MODEL_RESPONSE'));
});
test('기존 router는 전송유실 UNKNOWN 정산1회와 재전송0을 유지한다',async()=>{
  let calls=0; const settled:any[]=[];
  const router=createModelRouter({primary:{id:'gemini',retentionReview:{status:'approved',decisionId:'synthetic-only'},model:model(async()=>{calls++;throw new Error('lost');})},budget:{reserve:async()=> 'synthetic-reservation',settle:async(value:any)=>{settled.push(value);}}});
  await assert.rejects(router.generate(request({memberRequest:{userId:'synthetic',requestId:'synthetic',leaseToken:'synthetic'}})),failure('MODEL_UNAVAILABLE'));
  assert.equal(calls,1);assert.deepEqual(settled,[{reservationId:'synthetic-reservation',outcome:'unknown'}]);
});
test('호출자가 요청 객체를 변경해도 wire 원출력 상한을 높이지 못한다',async()=>{
  const original=request({maxOutputTokens:32});
  await assert.rejects(model(async()=>{original.maxOutputTokens=800;return Response.json(payload());}).generate(original),failure('INVALID_MODEL_RESPONSE','sent',{inputTokens:100,outputTokens:50}));
});
