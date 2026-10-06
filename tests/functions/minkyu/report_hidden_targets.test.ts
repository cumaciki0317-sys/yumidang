import {test}from'node:test';
import assert from'node:assert/strict';
import {createServiceApi}from'../../../backend/supabase/functions/service-api/handler.ts';
import {HttpError}from'../../../backend/supabase/functions/_shared/http/errors.ts';
import type{JsonValue}from'../../../backend/supabase/functions/_shared/contracts/common.ts';
const target='11111111-1111-4111-8111-111111111111';
function setup(){
 const calls:Array<{name:string;args:unknown}>=[];let result:JsonValue|undefined;
 const handler=createServiceApi({allowedOrigins:[],maxBodyBytes:8192,authenticateUser:async request=>{
  if(request.headers.get('authorization')!=='Bearer fixture')throw new HttpError('AUTH_REQUIRED');
  return{rpc:async(name,args)=>{calls.push({name,args});return result??(name==='list_my_hidden_targets'?{items:[{targetType:'post',targetId:target}],nextCursor:null}:{targetType:args.p_target_type,targetId:args.p_target_id,hidden:false});}};
 },authenticateInternal:async()=>{throw Error('internal must not be used');}});
 return{calls,set:(v:JsonValue)=>result=v,send:(path:string,body?:unknown,auth=true)=>handler(new Request('https://fixture.test/functions/v1/service-api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:auth?'Bearer fixture':'','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}))};
}
test('본인 최소 목록·명시 해제는 회원 RPC만 호출한다',async()=>{
 const s=setup();assert.equal((await s.send('/me/hidden-targets?limit=2')).status,200);assert.deepEqual(s.calls[0],{name:'list_my_hidden_targets',args:{p_limit:2,p_before:null}});
 const response=await s.send('/me/hidden-targets/unhide',{targetType:'post',targetId:target});assert.equal(response.status,200);assert.deepEqual((await response.json()).data,{targetType:'post',targetId:target,hidden:false});assert.deepEqual(s.calls[1],{name:'unhide_my_report_target',args:{p_target_type:'post',p_target_id:target}});
});
test('인증·사칭 인자·알 수 없는 대상·잘못된 페이지는 무전송 거절',async()=>{
 const s=setup();assert.equal((await s.send('/me/hidden-targets',undefined,false)).status,401);
 for(const body of[{targetType:'unknown',targetId:target},{targetType:'post',targetId:'invalid'},{targetType:'post',targetId:target,identityId:target}])assert.equal((await s.send('/me/hidden-targets/unhide',body)).status,400);
 assert.equal((await s.send('/me/hidden-targets?limit=0')).status,400);assert.equal(s.calls.length,0);
});
test('목록의 원문·타인정보·중복·잘못된 DTO를 공개하지 않는다',async()=>{
 for(const value of[{items:[{targetType:'post',targetId:target,description:'private detail'}],nextCursor:null},{items:[{targetType:'post',targetId:target},{targetType:'post',targetId:target}],nextCursor:null},{items:[{targetType:'unknown',targetId:target}],nextCursor:null},{items:[],nextCursor:target}]){const s=setup();s.set(value);const response=await s.send('/me/hidden-targets');assert.equal(response.status,503);assert.equal(JSON.stringify(await response.json()).includes('private detail'),false);}
});
test('해제 결과의 다른 대상·추가필드·hidden true는 성공으로 처리하지 않는다',async()=>{
 for(const value of[{targetType:'chat',targetId:target,hidden:false},{targetType:'post',targetId:target,hidden:true},{targetType:'post',targetId:target,hidden:false,reportId:target}]){const s=setup();s.set(value);assert.equal((await s.send('/me/hidden-targets/unhide',{targetType:'post',targetId:target})).status,503);}
});
