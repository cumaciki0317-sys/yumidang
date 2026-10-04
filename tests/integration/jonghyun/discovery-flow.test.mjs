import test from "node:test";
import assert from "node:assert/strict";
import {runChat} from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/orchestrator.ts";
import {searchPublicPosts} from "../../../backend/supabase/functions/_shared/services/search-service.ts";
import {createInMemoryPublicPostSearchRepository} from "../../../backend/supabase/functions/_shared/db/repositories/search.ts";
import {queryStoredEvents} from "../../../backend/supabase/functions/_shared/db/repositories/events.ts";
import {eventStateAt} from "../../../backend/supabase/functions/_shared/services/event-service.ts";
import {createAiChatHandler} from "../../../backend/supabase/functions/ai-chat/handler.ts";
import {createPostDiscovery} from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/discovery.ts";
import {loadMyPreferences} from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/traits.ts";

// 실제 서비스 코어끼리 연결하되 저장소·모델·인증 주체는 모두 합성이다.
const now=new Date("2026-10-02T20:00:00+09:00");
const limits={maxMessages:5,maxMessageChars:300,maxTotalChars:1000,maxOutputTokens:300};
const principal={userId:"synthetic-member"};
const request={clientRequestId:"c1",messages:[{role:"user",content:"이번 주말 전시"}],currentFilters:{target:"posts",region:"서울특별시"}};
const response=value=>({value,modelVersion:"synthetic",usage:{inputTokens:10,outputTokens:10}});
function asPost(c){return {kind:"post",id:c.id,title:c.title,locationLabel:c.publicArea,startsAtOrDate:c.startsAt,endsAtOrDate:c.endsAt,costLabel:c.cost.kind==="unknown"?"비용 미확인":c.cost.kind==="free"?"무료":String(c.cost.amount),state:c.state,canApply:c.canApply};}
test("AI 조건→검색 기본 등록일순→공개 동 보존·비공개 입력 제거→재조회 순서 보존",async()=>{
  const row={id:"friday",title:"가상 전시",anonymousAlias:"별칭",maskedName:"김*현",publicAreaDistrict:"서울특별시 종로구 종로1가",startsAt:"2026-10-02T18:00:00+09:00",endsAt:"2026-10-03T02:00:00+09:00",createdAt:"2026-10-01T00:00:00+09:00",cost:{kind:"free"},state:"recruiting",eligibleToApply:true,rawRealName:"PRIVATE_REAL_NAME",privateMeetingPoint:"PRIVATE_MEETING_POINT"};
  const candidates=[row,{...row,id:"saturday",startsAt:"2026-10-03T12:00:00+09:00",endsAt:"2026-10-03T14:00:00+09:00",state:"closed",createdAt:"2026-09-29T00:00:00Z"}].map(publicRow=>({publicRow,index:{title:publicRow.title,registeredPlaceName:"가상 전시장",registeredAddress:"PRIVATE_REGISTERED_ADDRESS"},category:"전시"}));
  const repo=createInMemoryPublicPostSearchRepository(candidates); let latest; let searchCalls=0; const calls=[];
  const discovery={async search(q){latest=q;searchCalls+=1;return {cards:(await searchPublicPosts(repo,{caller:"member",query:q.filters.query,period:q.period,availability:q.filters.availability})).posts.map(asPost),coverage:"exhausted"};},async recheck(){return {cards:(await this.search(latest)).cards.reverse(),complete:true};}};
  const model={async generate(q){calls.push(q);return response(q.task==="intent" ? {status:"search",filters:{target:"posts",query:"전시",date:{kind:"this_weekend"}}} : {explanations:[]});}};
  const r=await runChat(request,principal,{model,discovery,limits,now:()=>now,verifyExplanation:async()=>true},"r1");
  assert.equal(r.status,"results"); assert.deepEqual(r.cards.map(c=>c.id),["friday","saturday"]);
  assert.equal(r.cards[0].canApply,true);assert.equal(r.cards[1].canApply,false);
  assert.equal(r.cards[0].locationLabel,"서울특별시 종로구 종로1가");
  assert.equal(searchCalls,2);assert.equal(latest.filters.sort,undefined);assert.equal(latest.filters.authorAge,undefined);
  for (const marker of ["PRIVATE_REGISTERED_ADDRESS","PRIVATE_REAL_NAME","PRIVATE_MEETING_POINT"]) {
    assert.equal(JSON.stringify(calls).includes(marker),false);assert.equal(JSON.stringify(r).includes(marker),false);
  }
});
test("비용 미확인 공고를 AI 카드와 설명 입력에 무료나 신청 가능으로 전달하지 않는다", async () => {
  const row = {id:"historical-unknown",title:"가상 공고",anonymousAlias:"별칭",maskedName:"김*현",publicAreaDistrict:"서울특별시 종로구 종로1가",startsAt:"2026-10-03T12:00:00+09:00",endsAt:"2026-10-03T14:00:00+09:00",createdAt:"2026-10-01T00:00:00Z",cost:{kind:"unknown"},state:"recruiting",eligibleToApply:true};
  const repo = createInMemoryPublicPostSearchRepository([{publicRow:row,index:{title:row.title},category:"전시"}]);
  let latest;
  const discovery = {
    async search(q) { latest=q; return {cards:(await searchPublicPosts(repo,{caller:"member",cost:q.filters.cost})).posts.map(asPost),coverage:"exhausted"}; },
    async recheck() { return {cards:(await this.search(latest)).cards,complete:true}; },
  };
  const calls=[];
  const model={async generate(q) {calls.push(q);return response(q.task==="intent"?{status:"search",filters:{target:"posts",cost:"all"}}:{explanations:[]});}};
  const result=await runChat(request,principal,{model,discovery,limits,now:()=>now,verifyExplanation:async()=>true},"unknown-cost-request");
  assert.equal(result.status,"results");
  assert.equal(result.cards.length,1);
  assert.equal(result.cards[0].costLabel,"비용 미확인");
  assert.equal(result.cards[0].canApply,false);
  const explanation=calls.find((call)=>call.task==="explanation");
  assert.ok(explanation);
  assert.equal(explanation.input.cards[0].costLabel,"비용 미확인");
  assert.equal(explanation.input.cards[0].canApply,false);
  assert.equal(JSON.stringify(result.cards).includes("undefined"),false);
});

test("AI 주말·키워드→행사 코어는 장소 부분 일치·기간/지역/종류 교집합·출처 보존",async()=>{
  const base={provider:"synthetic",sourceId:"s",sourceStatus:"active",title:"가상 전시",category:"전시",region:"서울특별시",placeName:"Art  Hall",publicAddress:"서울",admission:{kind:"unknown"},sourceUrl:"https://example.invalid/event",collectedAt:"2026-10-01T00:00:00Z",precision:"date",startsOn:"2026-09-01",endsOn:"2026-10-10"};
  const events=[{...base,id:"long"},{...base,id:"ended",endsOn:"2026-10-02"},{...base,id:"cancelled",sourceStatus:"cancelled"},{...base,id:"other",region:"부산광역시"},{...base,id:"no-keyword",placeName:"Museum"}];
  const repo={async listCandidates(){return events;}};
  let latest;
  const eventPort={async search(q){latest=q;const found=await queryStoredEvents(repo,{mode:"overlapping",now:q.now,period:{start:q.period.startsAt.slice(0,10),end:"2026-10-04"},region:q.filters.region,category:q.filters.category,query:q.filters.query});return {cards:found.map(e=>({kind:"event",id:e.id,title:e.title,locationLabel:e.publicAddress,startsAtOrDate:e.startsOn,endsAtOrDate:e.endsOn,costLabel:"입장료 확인 필요",state:eventStateAt(e,q.now),canApply:false,sourceUrl:e.sourceUrl,sourceName:"합성 제공처"})),coverage:"exhausted"};},async recheck(){return {cards:(await this.search(latest)).cards,complete:true};}};
  const discovery={async search(){throw new Error("posts port must not run for events");},async recheck(){throw new Error("no");}};
  const model={async generate(){return response({status:"search",filters:{target:"events",query:"art hall",region:"서울특별시",category:"전시",date:{kind:"this_weekend"}}});}};
  const r=await runChat({...request,currentFilters:{target:"events",region:"서울특별시"}},principal,{model,discovery,events:eventPort,limits,now:()=>now},"r2");
  assert.equal(r.status,"results");assert.deepEqual(r.cards.map(c=>c.id),["long"]);assert.equal(r.cards[0].sourceUrl,base.sourceUrl);assert.equal(r.cards[0].sourceName,"합성 제공처");assert.equal(r.cards[0].canApply,false);
});

test("행사 포트가 연결되지 않으면 행사 요청은 unavailable이며 공고 검색으로 대체하지 않는다",async()=>{
  let searched=false;
  const discovery={async search(){searched=true;return {cards:[],coverage:"exhausted"};},async recheck(){return {cards:[],complete:true};}};
  const model={async generate(){return response({status:"search",filters:{target:"events",query:"전시"}});}};
  const r=await runChat({...request,currentFilters:{target:"events",region:"서울특별시"}},principal,{model,discovery,limits,now:()=>now},"r3");
  assert.equal(r.status,"unavailable");assert.match(r.notice,/행사/);assert.equal(searched,false);
  assert.deepEqual(r.interpretedFilters,{target:"events",region:"서울특별시",query:"전시"});
});

test("HTTP→해석→검색 v2 RPC→작성자 성향 RPC→C 의미 판단→재확인: 회원 RpcClient 하나로 연결", async()=>{
  // 가상 회원 RpcClient: 공통 허용 목록 추가 전이므로 실제 전송 계층 대신 wire 형식만 흉내 낸다(NOT 실제 DB).
  const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
  const rows=[1,2,3].map(n=>({id:id(n),title:`가상 공고 ${n}`,authorDisplayName:"김*현",publicArea:"서울특별시 종로구 종로1가",
    startsAt:"2026-10-10T01:00:00.000000Z",endsAt:"2026-10-10T03:00:00.000000Z",cost:n===3?null:{kind:"free"},state:"recruiting",canApply:true}));
  const traits={[id(1)]:{interests:["필름카메라"]},[id(2)]:{interests:["요리"]},[id(3)]:{}};
  const rpcCalls=[];
  const db={async rpc(name,args){rpcCalls.push(name);
    if(name==="get_my_profile_traits") return {interests:["사진"],conversationStyles:[],mbti:null};
    if(name==="search_public_posts_v2") return {items:rows,nextCursor:null};
    if(name==="get_post_author_traits") return {items:args.p_post_ids.map(p=>({postId:p,interests:traits[p].interests??[],conversationStyles:[],mbti:null,traitsVersion:"0".repeat(31)+p.slice(-1)}))};
    throw new Error("unexpected");}};
  const modelCalls=[];
  const model={async generate(q){modelCalls.push(q);
    if(q.task==="intent") return response({status:"search",filters:{target:"posts",interests:{values:[{text:q.input.preferences.interests[0],polarity:"include"}]}}});
    return response({judgments:q.input.candidates.map(c=>({ref:c.ref,interests:[c.interests.includes("필름카메라")?"similar":"different"]}))});}};
  const handler=createAiChatHandler({allowedOrigins:["https://app.synthetic.test"],maxBodyBytes:4096,
    authenticate:async()=>({userId:"synthetic-member"}),
    engine:{status:"ready",model,limits,now:()=>now},
    openSession:(principal,m)=>({discovery:createPostDiscovery({db,model:m,limits:{pageSize:10,maxSearchPages:2,recheckMaxPages:2,maxResultCards:5,matchBatchSize:5,maxMatchCalls:2,matchMaxOutputTokens:50}}),loadPreferences:()=>loadMyPreferences(db)})});
  const res=await handler(new Request("https://edge.synthetic.test/functions/v1/ai-chat",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer a.b.c"},
    body:JSON.stringify({clientRequestId:"c1",messages:[{role:"user",content:"나랑 관심사 비슷한 사람"}],currentFilters:{target:"posts",region:"서울특별시"}})}));
  assert.equal(res.status,200);
  const {data}=await res.json();
  assert.equal(data.status,"results");
  assert.deepEqual(data.cards.map(c=>[c.id,c.conditionStatus.interests,c.costLabel,c.canApply]),[[id(1),"match","무료",true],[id(3),"needs_check","비용 미확인",false]]);
  assert.deepEqual(rpcCalls,["get_my_profile_traits","search_public_posts_v2","get_post_author_traits","search_public_posts_v2","get_post_author_traits"]);
  assert.equal(modelCalls.filter(c=>c.task==="preference_match").length,1);
  assert.equal(JSON.stringify(data).includes("필름카메라"),false);
});
