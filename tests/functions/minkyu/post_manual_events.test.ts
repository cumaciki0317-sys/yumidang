import { HttpError } from '../../../backend/supabase/functions/_shared/http/errors.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServiceApi } from '../../../backend/supabase/functions/service-api/handler.ts';
import { contentInspectionInput } from '../../../backend/supabase/functions/_shared/services/content-inspection.ts';
const POST='11111111-1111-4111-8111-111111111111', OP='22222222-2222-4222-8222-222222222222';
const input={postId:POST,title:'행사 동행',description:'합성 안내',category:'공연',startsAt:'2099-01-01T10:00:00Z',endsAt:'2099-01-01T12:00:00Z',publicArea:'서울특별시 강남구 역삼동',registeredAddress:'비공개 만남 주소',meetingDetail:'비공개 입구',costType:'free',amount:0};
const manual={title:'직접 입력 행사',placeName:'공개 행사장',publicAddress:'서울특별시 중구 가상로 1',publicAddressConfirmed:true};
function setup(){const calls:any[]=[]; const handler=createServiceApi({allowedOrigins:[],maxBodyBytes:8192,authenticateUser:async()=>({rpc:async(name,args)=>{calls.push({name,args});return {ok:true};}}),authenticateInternal:async()=>{throw Error('internal forbidden');}});return {calls,send:(body:unknown,path='/posts')=>handler(new Request('https://test.invalid/service-api'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}))};}
test('공고 전용 직접입력만 기존생성RPC에 전달하고 공용행사등록0',async()=>{
 const {send,calls}=setup();assert.equal((await send({...input,manualEvent:manual})).status,200);
 assert.equal(calls[0].name,'create_service_post');assert.deepEqual(calls[0].args.p_input.manualEvent,manual);assert.equal(calls.length,1);
});
test('배타·주소공개확인·형태·공백제목·추가필드는 RPC0으로 거절',async()=>{
 for(const patch of [{eventId:OP,manualEvent:manual},{manualEvent:{...manual,publicAddressConfirmed:false}},{manualEvent:{...manual,title:'  '}},{manualEvent:{...manual,title:'<script>'}},{manualEvent:{...manual,meetingDetail:'private'}},{eventChangeId:OP}]){
  const {send,calls}=setup();assert.equal((await send({...input,...patch})).status,400);assert.equal(calls.length,0);
 }
});
test('생략/명시삭제/확정후제안ID는구별하여전달',async()=>{
 const {send,calls}=setup();const {postId,...edit}=input;
 for(const patch of [{},{manualEvent:null,eventId:null},{manualEvent:manual,eventChangeId:OP}])assert.equal((await send({...edit,...patch,expectedUpdatedAt:'2098-12-31T00:00:00Z'},`/posts/${POST}/update`)).status,200);
 assert.equal('manualEvent' in calls[0].args.p_input,false);
 assert.equal(calls[1].args.p_input.manualEvent,null);
 assert.equal(calls[2].args.p_input.eventChangeId,OP);
});
test('공개 직접입력 3필드는 검사에 포함하고 비공개만남위치는 제외',()=>{
 const p={...input,manualEvent:manual,preferenceNote:null,registeredPlaceName:null,tags:[]};
 const binding=contentInspectionInput('create_service_post',{p_post_id:POST,p_input:p},POST,OP);
 assert.deepEqual(binding.inspection.fields.filter(x=>x.name.startsWith('manualEvent.')).map(x=>x.text),[manual.title,manual.placeName,manual.publicAddress]);
 assert.equal(binding.inspection.fields.some(x=>x.text==='비공개 만남 주소'),false);
 assert.deepEqual(binding.scope.input.p_input,p);
});
test('행사명시수락은conditionVersion과행사fingerprint를모두요구',async()=>{
 const {send,calls}=setup();const path=`/appointments/${POST}/schedule-change/accept-event`;
 assert.equal((await send({changeId:OP,conditionVersion:'current'},path)).status,400);assert.equal(calls.length,0);
 assert.equal((await send({changeId:OP,conditionVersion:'current',eventFingerprint:'a'.repeat(64)},path)).status,200);
 assert.equal(calls[0].name,'accept_appointment_event_change');
});
test('행사 확장은 명시적인 별도 공개 상세 경로로만 조회한다', async()=>{
 const calls:any[]=[];let userAuth=0;let publicAuth=0;
 const legacy={postId:POST,title:'기존 응답',eventId:null,linkedEvent:null};
 const extension={postId:POST,eventId:null,manualEvent:manual,linkedEvent:null,eventLinkState:'manual'};
 const handler=createServiceApi({allowedOrigins:[],maxBodyBytes:8192,
  authenticateUser:async()=>{userAuth++;throw Error('public selection required');},
  authenticateInternal:async()=>{throw Error('internal forbidden');},
  publicPostDetails:{authenticate:async(req)=>{publicAuth++;if(req.headers.has('authorization'))throw new HttpError('AUTH_REQUIRED');
   return {caller:'anonymous',db:{rpc:async(name,args)=>{calls.push({name,args});return name==='get_service_post'?legacy:extension;}}};}},
 });
 const read=(path:string,headers?:HeadersInit)=>handler(new Request('https://test.invalid/service-api'+path,{headers}));
 assert.deepEqual((await (await read(`/posts/${POST}`)).json()).data,legacy);
 assert.deepEqual((await (await read(`/posts/${POST}/event-link`)).json()).data,extension);
 assert.deepEqual(calls.map(x=>x.name),['get_service_post','get_service_post_event_link']);
 assert.equal((await read(`/posts/${POST}/event-link`,{authorization:'Bearer invalid'})).status,401);
 assert.equal(calls.length,2);assert.equal(userAuth,0);assert.equal(publicAuth,3);
 assert.equal((await read(`/posts/${POST}/event-link?userId=other`)).status,400);
 assert.equal(publicAuth,3);
});
