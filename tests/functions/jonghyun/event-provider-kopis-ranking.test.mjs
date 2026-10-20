/** KOPIS 순위 transport 책임 시험. 전부 합성 fetch/stream이며 외부 호출·키·DB·VM은0이다. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createKopisRankingProvider,collectKopisRanking,publicKopisRanking,verifyKopisOfficialRanking} from '../../../backend/supabase/functions/_shared/integrations/events/kopis-ranking.ts';
import {EventProviderError} from '../../../backend/supabase/functions/_shared/integrations/events/port.ts';

const now=new Date('2026-10-05T12:00:00+09:00'),key='SYNTHETIC_PRIVATE_KEY_SENTINEL',privateReason='SYNTHETIC_PRIVATE_BODY_URL_SENTINEL';
const xml=(title='합성 한국어 공연')=>`<boxofs><basedate>2026-09-28~2026-10-04</basedate><boxof><rnum>1</rnum><mt20id>PF1</mt20id><cate>뮤지컬</cate><prfnm>${title}</prfnm><prfpd>2026.10.01~2026.10.10</prfpd><prfplcnm>합성 공연장</prfplcnm><area>서울</area></boxof></boxofs>`;
const encode=s=>new TextEncoder().encode(s);
const typed=(code,retryable=false)=>error=>error instanceof EventProviderError&&error.code===code&&error.message===code&&error.retryable===retryable&&error.cause===undefined&&![key,privateReason].some(v=>String(error.stack).includes(v));
const provider=(fetch,timeoutMs=1000)=>createKopisRankingProvider({apiKey:key,timeoutMs,now:()=>now,fetch});
function streamResponse(chunks,{status=200,mime='application/xml',stall=false,headers={}}={}){
 const state={pulls:0,cancels:0};let index=0;
 const body=new ReadableStream({pull(controller){state.pulls++;if(stall)return new Promise(()=>{});if(index<chunks.length)controller.enqueue(chunks[index++]);else controller.close();},cancel(){state.cancels++;}},{highWaterMark:0});
 const response=new Response(body,{status,headers:{'content-type':mime,...headers}});
 response.text=()=>{throw Error('전체 text 소비 금지');};return {response,state,body};
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('모형 호출의 마감 미준수')),1000);})]);}finally{clearTimeout(timer);}}

test('순위 정상 요청은 정확HTTPS/GET·자격증명 생략·원 기간/장르만 쓰고 자동 재전송0이다',async()=>{
 for(const mode of ['all','musical']){
  let calls=0;const p=provider(async(url,init)=>{calls++;const u=new URL(url);assert.equal(u.origin,'https://kopis.or.kr');assert.equal(u.pathname,'/openApi/restful/boxoffice');assert.equal(u.searchParams.get('service'),key);assert.equal(u.searchParams.get('stdate'),'20260928');assert.equal(u.searchParams.get('eddate'),'20261004');assert.equal(u.searchParams.get('catecode'),mode==='musical'?'GGGA':null);assert.equal(u.searchParams.has('date'),false);assert.equal(u.searchParams.has('ststype'),false);assert.equal(u.searchParams.has('area'),false);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.equal(new Headers(init.headers).get('accept'),'application/xml, text/xml');return new Response(xml(),{headers:{'content-type':'application/xml'}});});
  const result=await p.collect(mode);assert.equal(result.periodVerification,'verified');assert.equal(result.items[0].title,'합성 한국어 공연');assert.equal(result.items[0].rank,1);assert.equal(calls,1);
 }
});

test('순위 HTTP 상태는 인증·횟수·서버·요청 거절을 구분하고 오류 본문은 소비/공개하지 않는다',async()=>{
 for(const [status,code,retryable]of [[201,'SOURCE_REJECTED',false],[302,'SOURCE_REJECTED',false],[400,'SOURCE_REJECTED',false],[401,'SOURCE_AUTH_REJECTED',false],[403,'SOURCE_AUTH_REJECTED',false],[404,'SOURCE_REJECTED',false],[429,'SOURCE_RATE_LIMITED',true],[500,'SOURCE_UNAVAILABLE',true],[503,'SOURCE_UNAVAILABLE',true]]){
  const body=streamResponse([encode(privateReason)],{status});let calls=0;
  await assert.rejects(provider(async()=>{calls++;return body.response;}).collect('all'),typed(code,retryable));assert.equal(calls,1);assert.equal(body.state.pulls,0);assert.ok(body.state.cancels>=1);assert.equal(body.body.locked,false);
 }
});

test('순위 XML MIME은 정확한 두 타입과 문법상 파라미터만 허용한다',async()=>{
 for(const mime of ['application/xml','text/xml; charset=UTF-8','Application/XML; charset="utf-8"; profile="a;b"'])assert.equal((await provider(async()=>new Response(xml(),{headers:{'content-type':mime}})).collect('all')).items.length,1);
 for(const mime of ['', 'application/xml-malicious','text/xmlanything','prefixapplication/xml','application/xml, text/xml','application/xml; wrong','application/json']){
  const body=streamResponse([encode(privateReason)],{mime});await assert.rejects(provider(async()=>body.response).collect('all'),typed('SOURCE_INVALID_RESPONSE'));assert.equal(body.state.pulls,0);assert.ok(body.state.cancels>=1);
 }
});

test('순위 UTF8 문자는 chunk 경계를 넘어 보존하고 잘못되거나 끝이 잘린 UTF8은 거절한다',async()=>{
 const bytes=encode(xml('합성 🎭 한국어')),body=streamResponse(Array.from(bytes,byte=>new Uint8Array([byte])));
 assert.equal((await provider(async()=>body.response).collect('all')).items[0].title,'합성 🎭 한국어');assert.equal(body.body.locked,false);
 for(const bytes of [new Uint8Array([0xc3]),new Uint8Array([0xc3,0x28])]){const bad=streamResponse([bytes]);await assert.rejects(provider(async()=>bad.response).collect('all'),typed('SOURCE_INVALID_RESPONSE'));assert.equal(bad.body.locked,false);}
});

test('순위 reader 시작/중간 I/O 실패는 형식오류와 구분하며 원문 없이 재시도가능 오류를 보존한다',async()=>{
 const before=streamResponse([encode(xml())]);before.body.getReader=()=>{throw Error(privateReason);};let firstCalls=0;
 await assert.rejects(provider(async()=>{firstCalls++;return before.response;}).collect('all'),typed('SOURCE_UNAVAILABLE',true));assert.equal(firstCalls,1);assert.ok(before.state.cancels>=1);assert.equal(before.body.locked,false);
 let pulls=0,calls=0;const body=new ReadableStream({pull(controller){if(++pulls===1)controller.enqueue(encode('<boxofs>'));else controller.error(Error(privateReason));}},{highWaterMark:0});
 await assert.rejects(provider(async()=>{calls++;return new Response(body,{headers:{'content-type':'application/xml'}});}).collect('all'),typed('SOURCE_UNAVAILABLE',true));assert.equal(calls,1);assert.equal(pulls,2);assert.equal(body.locked,false);
});

test('순위 제한은 문자수/Content-Length 주장 대신 실제 stream UTF8바이트다',async()=>{
 const bytes=encode(xml('가'.repeat(800000)));assert.ok(bytes.length>2000000);assert.ok(xml('가'.repeat(800000)).length<2000000);
 const chunks=[];for(let i=0;i<bytes.length;i+=65536)chunks.push(bytes.slice(i,i+65536));
 const body=streamResponse(chunks,{headers:{'content-length':'1'}});await assert.rejects(provider(async()=>body.response).collect('all'),typed('SOURCE_INVALID_RESPONSE'));assert.ok(body.state.pulls<chunks.length);assert.ok(body.state.cancels>=1);assert.equal(body.body.locked,false);
});

test('순위 사전 취소는 임의 reason/stack을 전달하지 않고 fetch0이다',async()=>{
 const controller=new AbortController();controller.abort(privateReason);let calls=0;
 await assert.rejects(provider(async()=>{calls++;assert.fail();}).collect('all',controller.signal),typed('CANCELLED'));assert.equal(calls,0);
});

test('중단을 무시한 순위 fetch도 timeout으로 대기를 닫고 늦은 body를 읽지 않고 취소 요청한다',async()=>{
 let resolveFetch,requestSignal,calls=0;const late=streamResponse([encode(xml())]);
 const pending=provider((_url,init)=>{calls++;requestSignal=init.signal;return new Promise(resolve=>{resolveFetch=resolve;});},5).collect('all');
 await assert.rejects(bounded(pending),typed('SOURCE_TIMEOUT',true));assert.equal(calls,1);assert.equal(requestSignal.aborted,true);
 resolveFetch(late.response);await delay(0);assert.equal(late.state.pulls,0);assert.ok(late.state.cancels>=1);assert.equal(late.body.locked,false);
});

test('순위 호출자 취소는 무시된 fetch 대기도 닫고 원 reason과 늦은 성공을 노출하지 않는다',async()=>{
 const controller=new AbortController();let resolveFetch;
 const pending=provider(()=>new Promise(resolve=>{resolveFetch=resolve;})).collect('all',controller.signal);await delay(0);controller.abort(privateReason);
 await assert.rejects(bounded(pending),typed('CANCELLED'));const late=streamResponse([encode(xml())]);resolveFetch(late.response);await delay(0);assert.equal(late.state.pulls,0);assert.ok(late.state.cancels>=1);
});

test('순위 body 정체에도 총 deadline/취소를 적용하고 reader lock을 해제한다',async()=>{
 for(const cancel of [false,true]){
  const controller=new AbortController(),body=streamResponse([],{stall:true});const pending=provider(async()=>body.response,cancel?1000:5).collect('all',controller.signal);
  if(cancel){await delay(0);controller.abort(privateReason);}
  await assert.rejects(bounded(pending),typed(cancel?'CANCELLED':'SOURCE_TIMEOUT',!cancel));assert.ok(body.state.cancels>=1);assert.equal(body.body.locked,false);
 }
});

test('순위 종료 뒤 호출자 listener/마감 timer를 정리하고 늦은 abort로 결과를 바꾸지 않는다',async()=>{
 const controller=new AbortController(),signal=controller.signal;let adds=0,removes=0,passed;
 const add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);signal.addEventListener=(...args)=>{adds++;return add(...args);};signal.removeEventListener=(...args)=>{removes++;return remove(...args);};
 passed=await provider(async()=>new Response(xml(),{headers:{'content-type':'application/xml'}}),20).collect('all',signal);assert.equal(adds,1);assert.equal(removes,1);controller.abort(privateReason);await delay(25);assert.equal(passed.items.length,1);
});

test('순위 fetch 원문 실패/잘못된 본문은 안전한 typed 오류이며 basedate·0건 보류는 유지한다',async()=>{
 await assert.rejects(provider(async()=>{throw Error(privateReason);}).collect('all'),typed('SOURCE_UNAVAILABLE',true));
 for(const body of ['<boxofs/>',xml().replace('<basedate>2026-09-28~2026-10-04</basedate>',''),'<boxofs><basedate>2026-09-28~2026-10-04</basedate></boxofs>',xml().replace('2026-09-28~2026-10-04','2026-09-27~2026-10-03')])await assert.rejects(provider(async()=>new Response(body,{headers:{'content-type':'application/xml'}})).collect('all'),typed('SOURCE_INVALID_RESPONSE'));
 for(const date of ['2026.02.30','2026.13.01'])await assert.rejects(provider(async()=>new Response(xml().replace('2026.10.01',date),{headers:{'content-type':'application/xml'}})).collect('all'),typed('SOURCE_INVALID_RESPONSE'));
 assert.equal(publicKopisRanking(null,'all',now).status,'unavailable');
});

test('순위 wrapper의 수집후 취소도 typed CANCELLED/store0이며 store없음은 계속 미활성이다',async()=>{
 const pre=new AbortController();pre.abort(privateReason);let entered=0;
 await assert.rejects(collectKopisRanking({mode:'all',signal:pre.signal,provider:{async collect(){entered++;assert.fail();}},store:{async save(){entered++;assert.fail();}}}),typed('CANCELLED'));assert.equal(entered,0);
 const controller=new AbortController();let stored=0;
 await assert.rejects(collectKopisRanking({mode:'all',signal:controller.signal,provider:{async collect(){controller.abort(privateReason);return {};}},store:{async save(){stored++;return 'applied';}}}),typed('CANCELLED'));assert.equal(stored,0);
 let fetched=0;assert.deepEqual(await collectKopisRanking({mode:'all',provider:{async collect(){fetched++;assert.fail();}}}),{status:'not_enabled',reason:'RANKING_VERIFIED_PERSISTENCE_NOT_CONNECTED'});assert.equal(fetched,0);
});

test('순위 store 진입 뒤 취소는 저장 전송0이나 취소확정으로 바꾸지 않는다',async()=>{
 const controller=new AbortController();let fetched=0,stored=0;
 const result=await collectKopisRanking({mode:'all',signal:controller.signal,provider:{async collect(){fetched++;return verifyKopisOfficialRanking(xml(),'all',{start:'2026-09-28',end:'2026-10-04'},now,{mode:'all',period:{start:'2026-09-28',end:'2026-10-04'},checkedAt:now.toISOString(),officialUrl:'https://www.kopis.or.kr/por/boxoffice/boxoffice.do',officialCondition:'전체 공연',order:'official_display',items:[{sourceId:'PF1',rank:1}]});}},store:{async save(){stored++;controller.abort(privateReason);return 'applied';}}});
 assert.deepEqual(result,{status:'applied'});assert.equal(fetched,1);assert.equal(stored,1);
});
