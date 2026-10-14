/** 서울 기존 응답 오류 경계 책임 시험. 공급사·HTTP·키·DB·VM은 사용하지 않는다. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {classifySeoulCultureResponse,createSeoulEventProvider} from '../../../backend/supabase/functions/_shared/integrations/events/seoul.ts';
import {EventProviderError} from '../../../backend/supabase/functions/_shared/integrations/events/port.ts';

const sentinel='SYNTHETIC_PRIVATE_MESSAGE_KEY_URL';
const response=(code='INFO-000',extra={list_total_count:1,row:[{TITLE:'합성 행사'}]})=>({RESULT:{CODE:code,MESSAGE:sentinel},...extra});
function error(body,rows=100,code='SOURCE_INVALID_RESPONSE',retryable=false){
 const requestedRows=arguments.length>1?arguments[1]:rows;
 return assert.throws(
  ()=>classifySeoulCultureResponse(body,requestedRows),
  value=>value instanceof EventProviderError&&value.code===code&&value.message===code&&value.retryable===retryable&&!String(value).includes(sentinel),
 );
}

test('서울 기존 정상 wrapper/flat은 전체건수·행수를 유지하고 미확인 날짜/요금 해석을 추가하지 않는다',()=>{
 const row={TITLE:'합성 행사',STRTDATE:'미확인 날짜 형식',END_DATE:null,IS_FREE:'미확인',USE_FEE:sentinel};
 const data=response('INFO-000',{list_total_count:5,row:[row]});
 for(const body of [data,{culturalEventInfo:data}])assert.deepEqual(classifySeoulCultureResponse(body,1),{items:[row],total:5});
 assert.deepEqual(classifySeoulCultureResponse(response('INFO-000',{list_total_count:0,row:[]}),1),{items:[],total:0});
 assert.deepEqual(classifySeoulCultureResponse(response('INFO-000',{list_total_count:5,row:[]}),1),{items:[],total:5});
});

test('서울 rows는1~1000 안전정수이며 없음/오류 응답도 잘못된 rows 설정을 숨기지 않는다',()=>{
 for(const rows of [0,-1,1001,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'100',null,undefined]){
  for(const body of [response(),response('INFO-200',{}),response('INFO-100',{})])error(body,rows);
 }
 const data=response('INFO-000',{list_total_count:1000,row:Array.from({length:1000},()=>({TITLE:'합성'}))});
 assert.equal(classifySeoulCultureResponse(data,1000).items.length,1000);error(data,999);
});

test('서울 잘못된 wrapper·중복 범위·미확인 aiViewCulture는 flat 성공이 같이 있어도 거절한다',()=>{
 for(const culturalEventInfo of [null,undefined,[],1,'잘못된 본문'])error({...response(),culturalEventInfo});
 for(const body of [null,[],{}, {otherWrapper:response()}, {culturalEventInfo:response(),RESULT:{CODE:'INFO-000'}}, {culturalEventInfo:response(),row:[]}, {culturalEventInfo:response(),aiViewCulture:response()}, {aiViewCulture:response()}, {...response(),aiViewCulture:response()}, {culturalEventInfo:{culturalEventInfo:response()}}])error(body);
});

test('서울 INFO200은 생략/0·빈행만 허용하고 실제 행/양수총건수를 없음으로 바꾸지 않는다',()=>{
 for(const extra of [{},{list_total_count:0},{row:[]},{list_total_count:0,row:[]}]){
  const data=response('INFO-200',extra);for(const body of [data,{culturalEventInfo:data}])assert.deepEqual(classifySeoulCultureResponse(body,100),{items:[],total:0});
 }
 for(const extra of [{list_total_count:1},{list_total_count:-1},{list_total_count:'0'},{list_total_count:null},{list_total_count:undefined},{row:[{}]},{row:{}},{row:null},{row:undefined},{row:'[]'}])error(response('INFO-200',extra));
});

test('서울 INFO000은 건수보다 많은 행·비정수총건수·null/스칼라/배열 행을 거절한다',()=>{
 for(const count of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1',null,undefined])error(response('INFO-000',{list_total_count:count,row:[]}));
 error(response('INFO-000',{list_total_count:0,row:[{}]}));
 for(const row of [null,undefined,{},'행', [null], [1], ['행'], [[]]])error(response('INFO-000',{list_total_count:1,row}));
 for(const RESULT of [null,[],{}, {CODE:1}])error({RESULT,list_total_count:0,row:[]});
});

test('서울 키거절/서버·연결오류만 확정 typed 분류를 쓰며 공급사 MESSAGE·주소·키를 노출하지 않는다',()=>{
 error(response('INFO-100',{}),100,'SOURCE_AUTH_REJECTED');
 for(const code of ['ERROR-500','ERROR-600'])error(response(code,{}),100,'SOURCE_UNAVAILABLE',true);
 for(const code of ['ERROR-300','ERROR-301','ERROR-310','ERROR-331','ERROR-332','ERROR-333','ERROR-334','ERROR-335','ERROR-336','ERROR-601','UNREVIEWED',''])error(response(code,{}),100,'SOURCE_REJECTED');
});

test('서울 수집은 기존 비활성이며 HTTP evidence를 주입해도 transport 호출0이다',async()=>{
 await assert.rejects(createSeoulEventProvider({now:()=>new Date('2026-10-14T00:00:00Z')}).fetchPage({page:1}),value=>value instanceof EventProviderError&&value.code==='EVENT_PROVIDER_UNCONFIGURED');
 let calls=0;assert.throws(()=>createSeoulEventProvider({now:()=>new Date('2026-10-14T00:00:00Z'),transport:{securityEvidence:{protocol:'https:',endpoint:'http://openapi.seoul.go.kr:8088/sample/json/aiViewCulture/1/5',decisionId:'synthetic-unreviewed'},async fetchPage(){calls++;return {items:[]};}}}),value=>value instanceof EventProviderError&&value.code==='EVENT_PROVIDER_UNCONFIGURED');
 assert.equal(calls,0);
});
