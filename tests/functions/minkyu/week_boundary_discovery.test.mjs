/**
 * 민규: WBS5.2 날짜·주차 경계 회귀. 공개API/FE 변경 없음.
 * 실제 모듈: normalize/date-range/intent/orchestrator/discovery/search-service.
 * RPC·모델은 합성 포트다. 실제 DB SQL·Auth·HTTP·공급사·운영 실행 증거가 아니다.
 * seoulMonthWeek는 표기 helper이며 'N월 M주차' 새 DateSelection API를 만들지 않는다.
 * 실행: node --test tests/functions/minkyu/week_boundary_discovery.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const BASE=fileURLToPath(new URL('../../../backend/supabase/functions/_shared/', import.meta.url));
const load=relative=>import(pathToFileURL(BASE+relative).href);
const { seoulMonthWeek, seoulCalendarDate }=await load('integrations/events/normalize.ts');
const { resolveDateRange }=await load('ai/Agents/chatbot/date-range.ts');
const { validateFilters }=await load('ai/Agents/chatbot/intent.ts');
const { createPostDiscovery }=await load('ai/Agents/chatbot/discovery.ts');
const { runChat }=await load('ai/Agents/chatbot/orchestrator.ts');
const { listProjectedPublicPosts }=await load('services/search-service.ts');
const sourceFiles=['integrations/events/normalize.ts','ai/Agents/chatbot/date-range.ts','ai/Agents/chatbot/intent.ts',
  'ai/Agents/chatbot/discovery.ts','ai/Agents/chatbot/orchestrator.ts','contracts/ai.ts','contracts/search.ts',
  'services/search-service.ts','db/repositories/search.ts'];
const sourcePins=Object.fromEntries(sourceFiles.map(p=>[p,createHash('sha256').update(readFileSync(BASE+p)).digest('hex')]));
const weekCases=[
  ['2026-08-31',2026,9,1,'2026-08-31','2026-09-07'],
  ['2026-09-30',2026,10,1,'2026-09-28','2026-10-05'],
  ['2026-10-01',2026,10,1,'2026-09-28','2026-10-05'],
  ['2026-10-31',2026,10,5,'2026-10-26','2026-11-02'],
  ['2026-11-01',2026,10,5,'2026-10-26','2026-11-02'],
  ['2026-12-31',2026,12,5,'2026-12-28','2027-01-04'],
  ['2027-01-01',2026,12,5,'2026-12-28','2027-01-04'],
  ['2027-01-04',2027,1,1,'2027-01-04','2027-01-11'],
  ['2024-02-29',2024,2,5,'2024-02-26','2024-03-04'],
  ['2024-03-01',2024,2,5,'2024-02-26','2024-03-04'],
];
for(const [day,year,month,week,monday,nextMonday] of weekCases){
  test(`목요일 귀속 표기와 this_week 실제 기간: ${day}`,()=>{
    const now=new Date(day+'T12:00:00+09:00');
    assert.deepEqual(seoulMonthWeek(day),{year,month,week,label:`${month}월 ${week}주차`,monday,nextMonday});
    assert.deepEqual(resolveDateRange({kind:'this_week'},now),{startsAt:monday+'T00:00:00+09:00',endsAt:nextMonday+'T00:00:00+09:00'});
  });
}
for(const [instant,day,monday,nextMonday] of [
  ['2026-10-04T14:59:59.999Z','2026-10-04','2026-09-28','2026-10-05'],
  ['2026-10-04T15:00:00.000Z','2026-10-05','2026-10-05','2026-10-12'],
  ['2027-01-03T14:59:59.999Z','2027-01-03','2026-12-28','2027-01-04'],
  ['2027-01-03T15:00:00.000Z','2027-01-04','2027-01-04','2027-01-11'],
]){
  test(`서울 월요일 경계는 UTC 자정으로 바뀌지 않음: ${instant}`,()=>{
    const now=new Date(instant);assert.equal(seoulCalendarDate(now),day);
    assert.deepEqual(resolveDateRange({kind:'this_week'},now),{startsAt:monday+'T00:00:00+09:00',endsAt:nextMonday+'T00:00:00+09:00'});
  });
}

test('기존 5개 date kind만 지원하고 월별 주차 helper를 새 요청 API로 취급하지 않음',()=>{
  const now=new Date('2027-01-01T00:30:00+09:00');
  const expected={
    today:['2027-01-01','2027-01-02'],tomorrow:['2027-01-02','2027-01-03'],
    this_week:['2026-12-28','2027-01-04'],this_weekend:['2027-01-02','2027-01-04'],dates:['2026-12-31','2027-01-03'],
  };
  for(const [kind,[start,end]] of Object.entries(expected)){
    const date=kind==='dates'?{kind,startsOn:'2026-12-31',endsOn:'2027-01-02'}:{kind};
    const filters=validateFilters({target:'posts',date});
    assert.deepEqual(resolveDateRange(filters.date,now),{startsAt:start+'T00:00:00+09:00',endsAt:end+'T00:00:00+09:00'});
  }
  for(const date of [{kind:'month_week',year:2027,month:1,week:1},{kind:'this_week',month:1,week:1},
    {kind:'dates',startsOn:'2027-02-29',endsOn:'2027-03-01'},{kind:'dates',startsOn:'2027-01-02',endsOn:'2027-01-01'}]){
    assert.throws(()=>validateFilters({target:'posts',date}));
  }
});

const limits={pageSize:5,maxSearchPages:2,recheckMaxPages:2,maxResultCards:5,matchBatchSize:5,maxMatchCalls:1,matchMaxOutputTokens:128};
const chatLimits={maxMessages:10,maxMessageChars:500,maxTotalChars:2000,maxOutputTokens:128};
const ids=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'];
function wireCard(id,period,region='서울특별시'){
  return {id,title:'합성 전시 동행',authorDisplayName:'가*',publicArea:region==='부산광역시'?'부산광역시 해운대구 우동':'서울특별시 강남구 역삼동',
    startsAt:period.startsAt,endsAt:period.startsAt.replace('T00:','T01:'),cost:{kind:'free'},state:'recruiting',canApply:false};
}
const combinations=[
  {name:'기본 조건',extra:{},query:'',category:null,cost:'all',availability:'all',sort:'created_desc',authorAge:'all'},
  {name:'지역·분류·키워드·무료·모집·나이·시작순',extra:{query:'  전시   문화  ',category:'전시',cost:'free',availability:'recruiting',authorAge:{min:19,max:29},sort:'starts_asc'},
    query:'전시 문화',category:'전시',cost:'free',availability:'recruiting',sort:'starts_asc',authorAge:{min:19,max:29}},
  {name:'다른 공식 지역·전체 나이·등록순',extra:{region:'부산광역시',query:'전시',authorAge:'all',sort:'created_desc'},
    query:'전시',category:null,cost:'all',availability:'all',sort:'created_desc',authorAge:'all'},
];
for(const [instant,start,end] of [
  ['2026-10-01T00:00:00+09:00','2026-09-28','2026-10-05'],
  ['2027-01-01T00:00:00+09:00','2026-12-28','2027-01-04'],
]){
  for(const combo of combinations){
    test(`실제 runChat→date-range→discovery의 search/recheck RPC 기간·조합: ${instant} / ${combo.name}`,async()=>{
      const now=new Date(instant),period={startsAt:start+'T00:00:00+09:00',endsAt:end+'T00:00:00+09:00'};
      const filters={target:'posts',region:'서울특별시',date:{kind:'this_week'},...combo.extra};
      const calls=[],modelCalls=[];
      const model={async generate(req){
        modelCalls.push(req.task);assert.equal(req.task,'intent');assert.equal(req.input.referenceTime,now.toISOString());assert.equal(req.input.timeZone,'Asia/Seoul');
        return {value:{status:'search',filters},modelVersion:'synthetic-intent-only',usage:null};
      }};
      const db={async rpc(name,args){
        calls.push({name,args});assert.equal(name,'search_public_posts_v2');
        assert.deepEqual(args,{p_contract_version:'2026-10-05',p_region:filters.region,p_filters:{
          query:combo.query,category:combo.category,cost:combo.cost,availability:combo.availability,sort:combo.sort,
          periodStart:period.startsAt,periodEnd:period.endsAt,authorAge:combo.authorAge},p_cursor:null,p_limit:5});
        return {items:[wireCard(ids[0],period,filters.region)],nextCursor:null};
      }};
      const result=await runChat({clientRequestId:'20000000-0000-4000-8000-000000000001',messages:[{role:'user',content:'이번 주 전시 동행을 찾아주세요'}],currentFilters:filters},
        {userId:'synthetic-member'},{model,discovery:createPostDiscovery({db,model,limits}),limits:chatLimits,now:()=>now},'30000000-0000-4000-8000-000000000001');
      assert.equal(result.status,'results');assert.deepEqual(result.cards.map(c=>c.id),[ids[0]]);
      assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.deepEqual(modelCalls,['intent']);
    });
  }
}

test('연 경계 this_week+MBTI 조합은 같은 기간 RPC를 유지하고 명시 MBTI 불일치를 제외',async()=>{
  const period=resolveDateRange({kind:'this_week'},new Date('2027-01-01T12:00:00+09:00'));
  const filters=validateFilters({target:'posts',region:'서울특별시',date:{kind:'this_week'},mbti:'intj',cost:'free',authorAge:{min:19,max:99}});
  const calls=[];let modelCalls=0;
  const model={async generate(){modelCalls++;throw new Error('MODEL_MUST_NOT_RUN_FOR_EXPLICIT_MBTI');}};
  const db={async rpc(name,args){
    calls.push({name,args});
    if(name==='search_public_posts_v2'){
      assert.equal(args.p_filters.periodStart,'2026-12-28T00:00:00+09:00');assert.equal(args.p_filters.periodEnd,'2027-01-04T00:00:00+09:00');
      assert.equal(args.p_filters.cost,'free');assert.deepEqual(args.p_filters.authorAge,{min:19,max:99});
      assert.equal('mbti' in args.p_filters,false);
      return {items:ids.map(id=>wireCard(id,period)),nextCursor:null};
    }
    assert.equal(name,'get_post_author_traits');
    return {items:args.p_post_ids.map(id=>({postId:id,interests:[],conversationStyles:[],mbti:id===ids[0]?'INTJ':'ENFP',traitsVersion:'a'.repeat(32)}))};
  }};
  const discovery=createPostDiscovery({db,model,limits}),principal={userId:'synthetic-member'};
  const found=await discovery.search({principal,filters,period,now:new Date('2027-01-01T12:00:00+09:00')});
  assert.deepEqual(found.cards.map(c=>c.id),[ids[0]]);assert.equal(found.cards[0].conditionStatus.mbti,'match');
  const checked=await discovery.recheck({principal,filters,period,cards:found.cards,now:new Date('2027-01-01T12:00:00+09:00')});
  assert.equal(checked.complete,true);assert.deepEqual(checked.cards.map(c=>c.id),[ids[0]]);
  assert.equal(modelCalls,0);assert.deepEqual(calls.filter(c=>c.name==='get_post_author_traits').map(c=>c.args.p_post_ids),[ids,[ids[0]]]);
});

test('실제 순수 검색 service는 월·연 경계에서도 반열린 기간과 마이크로초 경계를 지킴(실제 순수 함수, DB 실행0)',()=>{
  const period={startsAt:'2026-12-28T00:00:00+09:00',endsAt:'2027-01-04T00:00:00+09:00'};
  const row=(id,start,end,extra={})=>({id,title:'합성 동행',maskedName:'가*',publicAreaDistrict:'서울특별시 강남구 역삼동',
    startsAt:start,endsAt:end,createdAt:'2026-12-01T00:00:00+09:00',cost:{kind:'free'},state:'recruiting',eligibleToApply:false,...extra});
  const rows=[
    row('ended-at-start','2026-12-27T20:00:00+09:00',period.startsAt),
    row('overlap-one-microsecond','2026-12-27T20:00:00+09:00','2026-12-28T00:00:00.000001+09:00'),
    row('starts-at-start',period.startsAt,'2026-12-28T01:00:00+09:00'),
    row('last-microsecond','2027-01-03T23:59:59.999999+09:00','2027-01-04T01:00:00+09:00'),
    row('starts-at-end',period.endsAt,'2027-01-04T01:00:00+09:00'),
    row('unknown-cost',period.startsAt,'2026-12-28T01:00:00+09:00',{cost:{kind:'unknown'}}),
    row('closed',period.startsAt,'2026-12-28T01:00:00+09:00',{state:'closed'}),
  ];
  const result=listProjectedPublicPosts(rows,{caller:'member',period,cost:'free',availability:'recruiting',sort:'starts_asc'});
  assert.deepEqual(result.posts.map(c=>c.id),['overlap-one-microsecond','starts-at-start','last-microsecond']);
});

test('읽은 실제 모듈 SHA를 결과에 남기며 테스트 종료 시 원 바이트 불변 확인',t=>{
  for(const p of sourceFiles)assert.equal(createHash('sha256').update(readFileSync(BASE+p)).digest('hex'),sourcePins[p]);
  t.diagnostic(JSON.stringify({scope:'WBS52_THIS_WEEK_BOUNDARY_PRIVATE_MODEL_ONLY',sourcePins,actualDB:0,actualAuth:0,actualHTTP:0,
    actualProvider:0,repoWrites:0,newDateSelectionAPI:false,FE:'NOT_RUN',limit:'RPC payload와 실제 순수 모듈 회귀이며 SQL 필터/운영 검증이 아님'}));
});
