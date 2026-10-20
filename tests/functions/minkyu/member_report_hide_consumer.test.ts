import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ServiceApiClient} from '../../../apps/mobile/src/api.ts';
import {MemberService} from '../../../apps/mobile/src/member-service.ts';
const target='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',reportId='33333333-3333-4333-8333-333333333333';
const input={clientRequestId:requestId,targetType:'appointment' as const,targetId:target,context:'offline' as const,reasonCodes:['other'],description:'합성 신고 설명',assetIds:[],hideTarget:true};
function fixture(reply:unknown,status=200){const calls:any[]=[];const service=new MemberService(new ServiceApiClient('https://service.example.invalid/functions/v1/service-api',async()=> 'synthetic-token',async(url,init)=>{calls.push({url:String(url),body:init?.body ? JSON.parse(String(init.body)) : null});return Response.json({data:reply,error:null},{status});}));return {calls,service};}
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

test('차단 해제는 신고 숨김을 해제하는 요청을 함께 전송하지 않는다', async () => {
 const f=fixture({targetId:target,blocked:false,alreadyApplied:false});
 await f.service.block(target,false);
 assert.equal(f.calls.length,1);
 assert.ok(f.calls[0].url.endsWith(`/profiles/${target}/unblock`));
 assert.deepEqual(f.calls[0].body,{});
});
test('명시적 숨김 해제는 같은 대상의 hidden:false 영수증만 성공으로 인정한다', async () => {
 const hidden={targetType:'post' as const,targetId:target};
 const f=fixture({...hidden,hidden:false});
 await f.service.unhide(hidden);
 assert.equal(f.calls.length,1);
 assert.ok(f.calls[0].url.endsWith('/me/hidden-targets/unhide'));
 assert.deepEqual(f.calls[0].body,hidden);
 for(const reply of [ {...hidden,hidden:true}, {...hidden,targetType:'member',hidden:false}, {...hidden,targetId:reportId,hidden:false}, {...hidden,hidden:false,description:'원문'} ]) {
  const invalid=fixture(reply); await assert.rejects(invalid.service.unhide(hidden));
  assert.equal(invalid.calls.length,1);
 }
});
test('숨김 해제 실패는 성공으로 처리하거나 추가 요청을 자동 전송하지 않는다', async () => {
 const f=fixture(null,503);
 await assert.rejects(f.service.unhide({targetType:'chat',targetId:target}));
 assert.equal(f.calls.length,1);
});
test('같은 내용의 명시적 신고 재시도는 기존 clientRequestId를 보존한다', async () => {
 const calls:unknown[]=[];
 const service=new MemberService(new ServiceApiClient('https://service.example.invalid/functions/v1/service-api',async()=> 'synthetic-token',async(_url,init)=>{
  calls.push(JSON.parse(String(init?.body)));
  if(calls.length===1) throw new TypeError('response lost');
  return Response.json({data:{reportId,status:'received',alreadySubmitted:true,hideTarget:true},error:null});
 }));
 await assert.rejects(service.report(input));
 assert.equal(calls.length,1);
 const result=await service.report(input);
 assert.equal(result.alreadySubmitted,true);
 assert.equal(calls.length,2);assert.deepEqual(calls,[input,input]);
});


test('숨김 목록은 최소 대상 식별자만 수락하고 원문·미확인 종류·중복은 거절한다', async () => {
 const item={targetType:'post',targetId:target};
 const f=fixture({items:[item],nextCursor:null});
 assert.deepEqual(await f.service.hiddenTargets(),{items:[item],nextCursor:null});
 assert.ok(f.calls[0].url.endsWith('/me/hidden-targets?limit=20'));
 for(const items of [[{...item,description:'신고 원문'}],[{...item,targetType:'unknown'}],[item,item]]) {
  const invalid=fixture({items,nextCursor:null});
  await assert.rejects(invalid.service.hiddenTargets());
 }
});
