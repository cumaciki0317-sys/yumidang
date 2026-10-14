import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportOperatorExecutor } from '../../../backend/supabase/functions/service-api/report-operator-http.ts';
import { toPublicError } from '../../../backend/supabase/functions/_shared/http/errors.ts';

// 실제 직원·Storage·RPC가 없는 합성 포트다. 현재 executor 소스만 소비한다.
const uid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', reportId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const assetId='cccccccc-cccc-4ccc-8ccc-cccccccccccc', objectId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const origin='https://capture.example.test', token='header.synthetic_staff.signature', privateReason='PRIVATE_CAPTURE_REASON';
const jpeg=new Uint8Array([255,216,255,224,0,255,217]);
const metadata={reportId,assetId,bucket:'report-evidence',path:uid+'/'+assetId+'.jpg',objectId,mimeType:'image/jpeg',byteSize:jpeg.length};
const route={kind:'capture',reportId,assetId};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function bounded(promise){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('LOCAL_WAIT_EXCEEDED')),1000);})]).finally(()=>clearTimeout(timer));}
function unavailable(error){assert.equal(toPublicError(error).error.code,'EXTERNAL_UNAVAILABLE');assert.equal(error.cause,undefined);assert.equal((String(error)+error.stack+JSON.stringify(toPublicError(error))).includes(privateReason),false);return true;}
function captureResponse(options={}){
 let index=0;
 return {status:200,headers:new Headers({'content-type':'image/jpeg','content-length':String(jpeg.length)}),body:{
  cancel:options.bodyCancel??(async()=>{}),
  getReader(){return{read:options.read??(async()=>index++===0?{done:false,value:jpeg}:{done:true}),
   cancel:options.cancel??(async()=>{}),releaseLock:options.release??(()=>{})};},
 }};
}
function setup(options={}){
 const calls=[],signal=new AbortController();let refs=0;
 const config={supabaseUrl:origin,supabaseAnonKey:'synthetic-public',supabaseServiceRoleKey:'synthetic-private',internalWorkerSecret:'synthetic-internal',maxRequestBytes:8192,upstreamTimeoutMs:options.timeout??40};
 const fetcher=async(input,init={})=>{
  const url=String(input),headers=new Headers(init.headers);
  assert.equal(headers.get('authorization'),'Bearer '+token);
  assert.equal(headers.get('apikey'),'synthetic-public');
  assert.equal(init.redirect,'error');
  if(url===origin+'/auth/v1/user'){calls.push('auth');return Response.json({id:uid,role:'authenticated',is_anonymous:false});}
  if(url===origin+'/rest/v1/rpc/get_assigned_report_capture'){
   assert.deepEqual(JSON.parse(init.body),{p_report_id:reportId,p_asset_id:assetId});refs++;calls.push('metadata');
   return options.metadata?options.metadata(refs,init):Response.json(metadata);
  }
  assert.equal(url,origin+'/storage/v1/object/authenticated/report-evidence/'+metadata.path);
  assert.equal(init.cache,'no-store');
  assert.equal(headers.get('accept'),'image/jpeg');
  calls.push(init.method);
  if(init.method==='GET')return options.get?options.get(init):captureResponse(options.reader);
  assert.equal(init.method,'HEAD');
  return options.head?options.head(init):new Response(null,{status:200});
 };
 const run=()=>createReportOperatorExecutor(config,fetcher)(new Request('https://service.example.test/functions/v1/service-api/operator/reports/'+reportId+'/captures/'+assetId,{headers:{authorization:'Bearer '+token},signal:signal.signal}),route);
 return{run,calls,signal};
}

test('정상 직원 캡처는 정확한 원JWT GET→배정 재확인→HEAD와 private 바이트 응답을 유지',async()=>{
 let cancelled=0,released=0;
 const s=setup({timeout:1000,reader:{cancel:async()=>{cancelled++;},release:()=>{released++;}}});
 const result=await s.run();assert.equal(result.status,200);assert.deepEqual(new Uint8Array(await result.arrayBuffer()),jpeg);
 assert.deepEqual(s.calls,['auth','metadata','GET','metadata','HEAD']);
 assert.equal(result.headers.get('cache-control'),'private, no-store');assert.equal(result.headers.get('vary'),'Authorization, Origin');
 assert.equal(result.headers.get('x-content-type-options'),'nosniff');assert.equal(result.headers.get('content-length'),String(jpeg.length));
 assert.equal(cancelled,1);assert.equal(released,1);
});

test('비협조 첫 GET은 마감에 종료하고 늦은 body만 취소하며 JSON/RPC/HEAD를 추가하지 않음',async()=>{
 const late=deferred();let requestSignal,cancelled=0,reads=0;
 const s=setup({get:init=>{requestSignal=init.signal;return late.promise;}});
 await assert.rejects(bounded(s.run()),unavailable);
 assert.equal(requestSignal.aborted,true);assert.deepEqual(s.calls,['auth','metadata','GET']);
 late.resolve(captureResponse({read:async()=>{reads++;return{done:false,value:jpeg};},bodyCancel:async()=>{cancelled++;}}));
 await pause(0);assert.equal(cancelled,1);assert.equal(reads,0);assert.deepEqual(s.calls,['auth','metadata','GET']);
});

test('비협조 read는 마감에 종료하고 늦은 바이트·정리 reject를 공개하지 않음',async()=>{
 const late=deferred();let cancellations=0,releases=0;
 const s=setup({reader:{read:()=>late.promise,cancel:()=>{cancellations++;return Promise.reject(Error(privateReason));},release:()=>{releases++;}}});
 await assert.rejects(bounded(s.run()),unavailable);
 late.resolve({done:false,value:jpeg});await pause(0);
 assert.ok(cancellations>=1);assert.ok(releases>=1);assert.deepEqual(s.calls,['auth','metadata','GET']);
});

test('읽기 뒤 cancel·HEAD body cancel 미완료는 best-effort이며 HTTP 완료를 막지 않음',async()=>{
 let readerCancelled=0,headCancelled=0,released=0;
 const s=setup({timeout:1000,reader:{cancel:()=>{readerCancelled++;return new Promise(()=>{});},release:()=>{released++;}},
  head:()=>({status:200,body:{cancel:()=>{headCancelled++;return new Promise(()=>{});}}})});
 const result=await bounded(s.run());assert.deepEqual(new Uint8Array(await result.arrayBuffer()),jpeg);
 assert.equal(readerCancelled,1);assert.equal(headCancelled,1);assert.equal(released,1);
 assert.deepEqual(s.calls,['auth','metadata','GET','metadata','HEAD']);
});

test('HEAD 미완료는 총 마감에 종료하고 늦은 HEAD body reject를 처리하며 바이트 반환0',async()=>{
 const late=deferred();let requestSignal,cancelled=0;
 const s=setup({head:init=>{requestSignal=init.signal;return late.promise;}});
 await assert.rejects(bounded(s.run()),unavailable);assert.equal(requestSignal.aborted,true);
 late.resolve({status:200,body:{cancel:()=>{cancelled++;return Promise.reject(Error(privateReason));}}});
 await pause(0);assert.equal(cancelled,1);assert.deepEqual(s.calls,['auth','metadata','GET','metadata','HEAD']);
});

test('본문 읽기 중 caller 취소도 미완료 read/cancel과 무관하게 안전 종료·후속 RPC/HEAD0',async()=>{
 const started=deferred(),late=deferred();
 const s=setup({timeout:1000,reader:{read:()=>{started.resolve();return late.promise;},cancel:()=>new Promise(()=>{})}});
 const pending=s.run();await started.promise;s.signal.abort(privateReason);
 await assert.rejects(bounded(pending),unavailable);late.resolve({done:false,value:jpeg});await pause(0);
 assert.deepEqual(s.calls,['auth','metadata','GET']);
});

test('사전 caller 취소는 직원 인증·RPC·Storage 모두0',async()=>{
 const s=setup();s.signal.abort(privateReason);await assert.rejects(s.run(),unavailable);assert.deepEqual(s.calls,[]);
});

test('GET과 본문 읽기는 마감을 다시 시작하지 않는 한 요청의 총 예산',async()=>{
 let read=0;
 const s=setup({timeout:60,get:async()=>{await pause(40);return captureResponse({read:async()=>{read++;await pause(40);return{done:false,value:jpeg};}});}});
 await assert.rejects(bounded(s.run()),unavailable);await pause(50);
 assert.equal(read,1);assert.deepEqual(s.calls,['auth','metadata','GET']);
});

test('늦은 metadata JSON은 조회 마감을 지나도 첫 Storage GET을 허용하지 않음',async()=>{
 const late=deferred();const s=setup({metadata:()=>({status:200,json:()=>late.promise})});
 await assert.rejects(bounded(s.run()),unavailable);late.resolve(metadata);await pause(0);
 assert.deepEqual(s.calls,['auth','metadata']);
});

test('캡처 I/O 원문 오류·cleanup 동기 예외는 원문 비노출이고 후속 조회0',async()=>{
 const s=setup({timeout:1000,reader:{read:()=>Promise.reject(Error(privateReason)),cancel:()=>{throw Error(privateReason);},release:()=>{throw Error(privateReason);},bodyCancel:()=>{throw Error(privateReason);}}});
 await assert.rejects(s.run(),unavailable);assert.deepEqual(s.calls,['auth','metadata','GET']);
});
