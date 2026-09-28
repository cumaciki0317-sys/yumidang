import test from "node:test";
import assert from "node:assert/strict";
import {runChat} from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/orchestrator.ts";
import {searchPublicPosts} from "../../../backend/supabase/functions/_shared/services/search-service.ts";
import {createInMemoryPublicPostSearchRepository} from "../../../backend/supabase/functions/_shared/db/repositories/search.ts";
import {queryStoredEvents} from "../../../backend/supabase/functions/_shared/db/repositories/events.ts";
import {eventStateAt} from "../../../backend/supabase/functions/_shared/services/event-service.ts";

// 실제 서비스 코어끼리 연결하되 저장소·모델·인증 주체는 모두 합성이다.
const now=new Date("2026-10-02T20:00:00+09:00");
const limits={maxMessages:5,maxMessageChars:300,maxTotalChars:1000,maxOutputTokens:300};
const principal={userId:"synthetic-member"};
const request={clientRequestId:"c1",messages:[{role:"user",content:"이번 주말 전시"}],currentFilters:{target:"posts"}};
const response=value=>({value,modelVersion:"synthetic",usage:{inputTokens:10,outputTokens:10}});
function asPost(c){return {kind:"post",id:c.id,title:c.title,locationLabel:c.publicArea,startsAtOrDate:c.startsAt,endsAtOrDate:c.endsAt,costLabel:c.cost.kind==="free"?"무료":String(c.cost.amount),state:c.state,canApply:c.canApply};}
test("AI 조건→실제 검색 코어→권한 필드 제거→기간 우선 정렬→재조회",async()=>{
  const row={id:"friday",title:"가상 전시",anonymousAlias:"별칭",maskedName:"김*현",publicAreaDistrict:"서울 종로구",startsAt:"2026-10-02T18:00:00+09:00",endsAt:"2026-10-03T02:00:00+09:00",createdAt:"2026-10-01T00:00:00+09:00",cost:{kind:"free"},state:"recruiting",eligibleToApply:true};
  const candidates=[row,{...row,id:"saturday",startsAt:"2026-10-03T12:00:00+09:00",endsAt:"2026-10-03T14:00:00+09:00",state:"closed"}].map(publicRow=>({publicRow,index:{title:publicRow.title,registeredPlaceName:"가상 전시장",registeredAddress:"PRIVATE_REGISTERED_ADDRESS"},category:"exhibition"}));
  const repo=createInMemoryPublicPostSearchRepository(candidates); let latest; const calls=[];
  const discovery={async search(q){latest=q;return (await searchPublicPosts(repo,{caller:"member",query:q.filters.query,period:q.period,availability:q.filters.availability})).posts.map(asPost);},async recheck(){return (await this.search(latest)).reverse();}};
  const model={async generate(q){calls.push(q);return response(q.task==="intent" ? {status:"search",filters:{target:"posts",query:"전시",date:{kind:"this_weekend"}}} : {explanations:[]});}};
  const r=await runChat(request,principal,{model,discovery,limits,now:()=>now,verifyExplanation:async()=>true},"r1");
  assert.equal(r.status,"results"); assert.deepEqual(r.cards.map(c=>c.id),["saturday","friday"]);assert.equal(r.cards[0].canApply,false);
  assert.equal(JSON.stringify(calls).includes("PRIVATE_REGISTERED_ADDRESS"),false);
});
test("AI 주말·키워드→행사 코어는 장소 부분 일치·기간/지역/종류 교집합·출처 보존",async()=>{
  const base={provider:"synthetic",sourceId:"s",sourceStatus:"active",title:"가상 전시",category:"exhibition",region:"seoul",placeName:"Art  Hall",publicAddress:"서울",admission:{kind:"unknown"},sourceUrl:"https://example.invalid/event",collectedAt:"2026-10-01T00:00:00Z",precision:"date",startsOn:"2026-09-01",endsOn:"2026-10-10"};
  const events=[{...base,id:"long"},{...base,id:"ended",endsOn:"2026-10-02"},{...base,id:"cancelled",sourceStatus:"cancelled"},{...base,id:"other",region:"busan"},{...base,id:"no-keyword",placeName:"Museum"}];
  const repo={async listCandidates(){return events;}};
  let latest;
  const discovery={async search(q){latest=q;const found=await queryStoredEvents(repo,{mode:"overlapping",now:q.now,period:{start:q.period.startsAt.slice(0,10),end:"2026-10-04"},region:q.filters.region,category:q.filters.category,query:q.filters.query});return found.map(e=>({kind:"event",id:e.id,title:e.title,locationLabel:e.publicAddress,startsAtOrDate:e.startsOn,endsAtOrDate:e.endsOn,costLabel:"입장료 확인 필요",state:eventStateAt(e,q.now),canApply:false,sourceUrl:e.sourceUrl}));},async recheck(){return this.search(latest);}};
  const model={async generate(){return response({status:"search",filters:{target:"events",query:"art hall",region:"seoul",category:"exhibition",date:{kind:"this_weekend"}}});}};
  const r=await runChat({...request,currentFilters:{target:"events"}},principal,{model,discovery,limits,now:()=>now},"r2");
  assert.equal(r.status,"results");assert.deepEqual(r.cards.map(c=>c.id),["long"]);assert.equal(r.cards[0].sourceUrl,base.sourceUrl);assert.equal(r.cards[0].canApply,false);
});
