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

test('실제 내부 RPC transport와 capability 저장소를 연결하고 exact read DTO만 허용한다',async()=>{
 const {createVerifiedKopisRepository}=await import('../../../backend/supabase/functions/_shared/db/repositories/events.ts');
 const {createPublicClient}=await import('../../../backend/supabase/functions/_shared/db/public-client.ts');
 const {createInternalClient}=await import('../../../backend/supabase/functions/_shared/db/internal-client.ts');
 const {loadRuntimeConfig}=await import('../../../backend/supabase/functions/_shared/config/env.ts');
 const cfg=loadRuntimeConfig(k=>({SUPABASE_URL:'https://fixture.invalid',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service',INTERNAL_WORKER_SECRET:'x'.repeat(40),ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'8192',UPSTREAM_TIMEOUT_MS:'1000'})[k]);
 const unavailable={status:'unavailable',mode:'musical',sourceName:'KOPIS',period:null,collectedAt:null,items:[],officialUrl:'https://www.kopis.or.kr/por/boxoffice/boxoffice.do',checkedAt:null,refreshDelayed:false};
 const calls=[];let answer;
 const db=createInternalClient(cfg,async(url,init)=>{calls.push([url,JSON.parse(init.body)]);return Response.json(answer)});
 const repo=createVerifiedKopisRepository(db);
 for(const rpc of ['publish_verified_kopis_snapshot','mark_verified_kopis_refresh_failed','get_verified_kopis_ranking']) {assert.equal(db.supportsRpc(rpc),true);assert.equal(createPublicClient(cfg).supportsRpc(rpc),false);}
 answer={status:'applied'};assert.equal(await repo.save(verified()),'applied');
 assert.match(calls[0][0],/\/rpc\/publish_verified_kopis_snapshot$/);
 answer={status:'recorded'};assert.equal(await repo.refreshFailed('musical',now.toISOString(),null),'recorded');
 answer=unavailable;assert.deepEqual(await repo.read('musical'),unavailable);
 const count=calls.length;await assert.rejects(repo.save(structuredClone(verified())));await assert.rejects(repo.read('bogus'));assert.equal(calls.length,count);
 for(const bad of [{...unavailable,extra:true},{...unavailable,mode:'all'},{...unavailable,items:[{rank:1}]},{...unavailable,status:'available'}]) {answer=bad;await assert.rejects(repo.read('musical'));}
 const snapshot=verified();answer={...unavailable,status:'available',period:snapshot.responsePeriod,collectedAt:snapshot.collectedAt,checkedAt:snapshot.officialComparison.checkedAt,items:snapshot.items,refreshDelayed:true};
 assert.equal((await repo.read('musical')).refreshDelayed,true);
 answer={...answer,items:[{...snapshot.items[0],rawXml:'secret'}]};await assert.rejects(repo.read('musical'));
});

test('저장 공개 DTO의 기간·시각 오류는 일관되게 거절하고 PostgreSQL 정밀도를 보존한다',async()=>{
 const {createVerifiedKopisRepository}=await import('../../../backend/supabase/functions/_shared/db/repositories/events.ts');
 const snapshot=verified();const good={status:'available',mode:'musical',sourceName:'KOPIS',period:snapshot.responsePeriod,collectedAt:snapshot.collectedAt,checkedAt:snapshot.officialComparison.checkedAt,items:snapshot.items,officialUrl:'https://www.kopis.or.kr/por/boxoffice/boxoffice.do',refreshDelayed:false};
 let answer=good;const repo=createVerifiedKopisRepository({rpc:async()=>answer});
 for(const value of ['2026','2026-02-30T00:00:00Z','2026-10-20T24:00:00Z','2026-10-20T00:00:00','2026-10-20T00:00:00-00:00']) for(const key of ['checkedAt','collectedAt']) {
  answer={...good,[key]:value};await assert.rejects(repo.read('musical'),{message:'INVALID_EVENT_REPOSITORY_RESPONSE'});
 }
 answer={...good,period:{start:'2026-02-30',end:'2026-03-06'}};await assert.rejects(repo.read('musical'),{message:'INVALID_EVENT_REPOSITORY_RESPONSE'});
 for(const value of ['2026-10-20T09:00:00.123456+09:00','2026-10-20 00:00:00.123456+00:00','2026-10-20T00:00:00Z']) {
  answer={...good,collectedAt:value,checkedAt:value};assert.equal((await repo.read('musical')).checkedAt,value);
 }
});
