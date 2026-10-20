/** 민규: 합성 HTTP 계약만 검증한다. 실제 DB/회원 동의 증거와 구분한다. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServiceApi } from '../../../backend/supabase/functions/service-api/handler.ts';
import { HttpError } from '../../../backend/supabase/functions/_shared/http/errors.ts';
const kinds=['exploration','summary_view','summary_generate','summary_source'];
function setup(){
 const calls:unknown[]=[];
 const handler=createServiceApi({allowedOrigins:[],maxBodyBytes:8192,
  authenticateUser:async(req)=>{if(req.headers.get('authorization')!=='Bearer synthetic')throw new HttpError('AUTH_REQUIRED');
   return {rpc:async(name,args)=>{calls.push({name,args});return {exploration:false,summary_view:false,summary_generate:false,summary_source:false};}};},
  authenticateInternal:async()=>{throw new Error('internal auth forbidden');}});
 return {calls,send:(path:string,body?:unknown,token='synthetic')=>handler(new Request('https://test.invalid/service-api/me/ai-consents'+path,
  {method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}))};
}
test('독립 동의와 거절을 원 JWT 본인 RPC에만 전달한다',async()=>{
 const {calls,send}=setup();assert.equal((await send('')).status,200);
 for(const kind of kinds)for(const allowed of [true,false]){
  assert.equal((await send('/set',{kind,allowed})).status,200);
  assert.deepEqual(calls.at(-1),{name:'set_my_ai_consent',args:{p_kind:kind,p_allowed:allowed}});
 }
 assert.deepEqual(calls[0],{name:'get_my_ai_consents',args:{}});
});
test('전체동의·회원 ID·내용·암묵적 true 주입은 거절하고 RPC0',async()=>{
 const {calls,send}=setup();
 for(const body of [{kind:'all',allowed:true},{kind:'review_summary',allowed:true},{kind:'summary_view',allowed:1},
 {kind:'summary_view',allowed:true,userId:'other'},{kind:'exploration'},{kind:'summary_source',allowed:true,text:'private'}])
  assert.equal((await send('/set',body)).status,400);
 assert.equal(calls.length,0);
});
test('인증 거절·쿼리 주입에는 RPC0',async()=>{
 const {calls,send}=setup();assert.equal((await send('',undefined,'anonymous')).status,401);
 assert.equal((await send('?userId=other')).status,400);assert.equal(calls.length,0);
});

test('서버 이용 사전 상태는 본인 읽기 RPC만 호출하고 예약·모델·다른 ID를 받지 않는다',async()=>{
 const calls:unknown[]=[];
 const handler=createServiceApi({allowedOrigins:[],maxBodyBytes:8192,
 authenticateUser:async()=>({rpc:async(name,args)=>{calls.push({name,args});return {estimatedEligible:false,reason:'daily_limit',remaining:0,requestAuthoritative:true};}}),
 authenticateInternal:async()=>{throw new Error('internal forbidden');}});
 const send=(suffix='')=>handler(new Request('https://test.invalid/service-api/me/ai-availability'+suffix));
 const res=await send();assert.equal(res.status,200);
 assert.deepEqual((await res.json()).data,{estimatedEligible:false,reason:'daily_limit',remaining:0,requestAuthoritative:true});
 assert.deepEqual(calls,[{name:'get_my_ai_availability',args:{}}]);
 assert.equal((await send('?userId=other')).status,400);assert.equal(calls.length,1);
});
