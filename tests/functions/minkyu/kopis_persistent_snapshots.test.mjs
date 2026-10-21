import test from 'node:test';
import assert from 'node:assert/strict';
import { createKopisRankingRpcStore, verifyKopisOfficialRanking, kopisRankingPeriod } from '../../../backend/supabase/functions/_shared/integrations/events/kopis-ranking.ts';
const now = new Date('2026-10-20T00:00:00Z');
const period = kopisRankingPeriod(now);
const xml = '<boxofs><boxof><rnum>1</rnum><mt20id>PF1</mt20id><cate>뮤지컬</cate><prfnm>공연</prfnm><prfpd>2026.10.01~2026.11.01</prfpd><prfplcnm>극장</prfplcnm><area>서울</area></boxof></boxofs>';
const verified = () => verifyKopisOfficialRanking(xml,'musical',period,now,{mode:'musical',period,checkedAt:now.toISOString(),officialUrl:'https://www.kopis.or.kr/por/boxoffice/boxoffice.do',officialCondition:'뮤지컬',order:'official_display',items:[{sourceId:'PF1',rank:1}]});
test('caller boolean or JSON copy cannot invoke trusted persistence', async()=>{
 let calls=0;const store=createKopisRankingRpcStore({rpc:async()=>{calls++;return {data:{status:'applied'},error:null}}});
 const snapshot=verified();
 for(const fake of [{verified:true},structuredClone(snapshot),JSON.parse(JSON.stringify(snapshot))]) await assert.rejects(store.save(fake));
 assert.equal(calls,0);
});
test('capability is consumed into exact public projection without raw source',async()=>{
 let invocation;const store=createKopisRankingRpcStore({rpc:async(name,input)=>{invocation={name,input};return {data:{status:'applied'},error:null}}});
 assert.equal(await store.save(verified()),'applied');assert.equal(invocation.name,'publish_verified_kopis_snapshot');
 const data=invocation.input.p_snapshot;assert.deepEqual(data.period,period);assert.equal(data.apiPeriodVerified,false);assert.equal(data.officialCondition,'뮤지컬');
 assert.equal(data.items[0].sourceId,'PF1');assert.equal('rawXml'in data,false);
});
test('stale and failures never masquerade as applied; failure marking has no replacement snapshot',async()=>{
 const calls=[];const store=createKopisRankingRpcStore({rpc:async(name,input)=>{calls.push([name,input]);return {data:{status:name==='mark_verified_kopis_refresh_failed'?'recorded':'stale'},error:null}}});
 assert.equal(await store.save(verified()),'stale');await store.refreshFailed('musical',now.toISOString(),now.toISOString());
 assert.deepEqual(calls[1],['mark_verified_kopis_refresh_failed',{p_mode:'musical',p_attempt_started_at:now.toISOString(),p_expected_checked_at:now.toISOString()}]);
 await assert.rejects(createKopisRankingRpcStore({rpc:async()=>({data:null,error:{code:'x'}})}).save(verified()));
 await assert.rejects(store.refreshFailed('made_up',now.toISOString(),null));
});

test('RPC responses require exact status object and invalid failure evidence dispatches zero calls',async()=>{
 for(const data of [null,{},[],{status:'applied',extra:true},{status:'recorded',extra:true},{status:'invented'}]) {
  const store=createKopisRankingRpcStore({rpc:async()=>({data,error:null})});
  await assert.rejects(store.save(verified()));
  await assert.rejects(store.refreshFailed('all',now.toISOString(),null));
 }
 let calls=0;const store=createKopisRankingRpcStore({rpc:async()=>{calls++;return {data:{status:'stale'},error:null}}});
 await assert.rejects(store.refreshFailed('all','invalid',null));assert.equal(calls,0);
 assert.equal(await store.refreshFailed('all',now.toISOString(),null),'stale');
});

test('inherited status cannot substitute for an own response key',async()=>{
 const data=Object.assign(Object.create({status:'applied'}),{other:true});
 const store=createKopisRankingRpcStore({rpc:async()=>({data,error:null})});
 await assert.rejects(store.save(verified()));
 const failure=Object.assign(Object.create({status:'recorded'}),{other:true});
 await assert.rejects(createKopisRankingRpcStore({rpc:async()=>({data:failure,error:null})}).refreshFailed('all',now.toISOString(),null));
});
