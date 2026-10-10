import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ServiceApiClient} from '../../../apps/mobile/src/api.ts';
import {MemberService} from '../../../apps/mobile/src/member-service.ts';
const target='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',reportId='33333333-3333-4333-8333-333333333333';
const input={clientRequestId:requestId,targetType:'appointment' as const,targetId:target,context:'offline' as const,reasonCodes:['other'],description:'합성 신고 설명',assetIds:[],hideTarget:true};
function fixture(reply:unknown,status=200){const calls:any[]=[];const service=new MemberService(new ServiceApiClient('https://service.example.invalid/functions/v1/service-api',async()=> 'synthetic-token',async(url,init)=>{calls.push({url:String(url),body:JSON.parse(String(init?.body))});return Response.json({data:reply,error:null},{status});}));return {calls,service};}
test('신고 숨김 선택을 원 요청에 결합하고 같은 서버 영수증만 성공으로 인정한다',async()=>{
 const f=fixture({reportId,status:'submitted',alreadySubmitted:false,hideTarget:true});const r=await f.service.report(input);
 assert.equal(r.hideTarget,true);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,input);assert.ok(f.calls[0].url.endsWith('/reports'));
 const ordinary=fixture({reportId,status:'submitted',alreadySubmitted:false,hideTarget:false});assert.equal((await ordinary.service.report({...input,hideTarget:false})).hideTarget,false);
});
test('숨김 불일치·추가 원문·틀린 영수증은 성공이나 숨김 효과로 바꾸지 않는다',async()=>{
 for(const reply of [{reportId,status:'submitted',alreadySubmitted:false,hideTarget:false},{reportId,status:'submitted',alreadySubmitted:false,hideTarget:true,description:'원문'},{reportId:'bad',status:'submitted',alreadySubmitted:false,hideTarget:true}]){const f=fixture(reply);await assert.rejects(f.service.report(input));assert.equal(f.calls.length,1);}
});
test('숨김 접수 응답 실패 후 다른 키나 추가 숨김 요청을 자동 전송하지 않는다',async()=>{
 const f=fixture(null,503);await assert.rejects(f.service.report(input));assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.clientRequestId,requestId);
});
