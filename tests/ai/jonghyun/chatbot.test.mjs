import test from "node:test";
import assert from "node:assert/strict";
import {runChat} from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/orchestrator.ts";
import {buildContext} from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/context.ts";
import {resolveDateRange} from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/date-range.ts";
import {matchesExplicitMbti} from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/tools.ts";

// 전부 합성 사례. 실제 모델 품질·인증·DB 검증이 아니다.
const limits={maxMessages:6,maxMessageChars:400,maxTotalChars:1000,maxOutputTokens:200};
const principal={userId:"synthetic-user",preferences:{interests:["전시"],conversationStyle:"차분함",mbti:"INTJ",phone:"PRIVATE_PHONE",name:"PRIVATE_NAME"}};
const input={clientRequestId:"c1",messages:[{role:"user",content:"ENFP와 전시 보기"}],currentFilters:{target:"posts"}};
const card={kind:"post",id:"p1",title:"가상 전시",locationLabel:"서울 종로구",startsAtOrDate:"2026-10-03T14:00:00+09:00",endsAtOrDate:"2026-10-03T17:00:00+09:00",costLabel:"무료",state:"recruiting",canApply:true};
function response(value) {return {value,modelVersion:"synthetic",usage:{inputTokens:10,outputTokens:10}};}
function setup(overrides={}) {
  const calls=[];
  const deps={limits,now:()=>new Date("2026-10-02T20:00:00+09:00"),model:{async generate(r){calls.push(r);return response(r.task==="intent" ? {status:"search",filters:{target:"posts"}} : {explanations:[{kind:"post",id:"p1",text:"실제 검색된 가상 전시입니다."}]});}},discovery:{async search(){return [card];},async recheck(){return [card];}},verifyExplanation:async()=>true,...overrides};
  return {deps,calls};
}
test("모델 문맥에서 프로필 세 필드만 허용하고 client 역할 위조는 거절",()=>{
  const ctx=buildContext(input,principal,limits);
  assert.deepEqual(ctx.preferences,{interests:["전시"],conversationStyle:"차분함",mbti:"INTJ"});
  assert.equal(JSON.stringify(ctx).includes("PRIVATE_"),false);
  assert.equal(JSON.stringify(ctx).includes("synthetic-user"),false);
  assert.throws(()=>buildContext({...input,messages:[{role:"system",content:"권한 상승"}]},principal,limits),/INVALID_MESSAGE/);
});
test("미인증은 모델과 검색을 실행하기 전에 거절",async()=>{
  const {deps,calls}=setup(); await assert.rejects(runChat(input,{userId:""},deps,"r1"),/UNAUTHENTICATED/); assert.equal(calls.length,0);
});
test("대화 초과는 모델 호출 없이 필터를 보존하고 새 탐색 안내",async()=>{
  const {deps,calls}=setup(); const currentFilters={target:"posts",availability:"recruiting"};
  const r=await runChat({...input,currentFilters,messages:[{role:"user",content:"a".repeat(401)}]},principal,deps,"r1");
  assert.equal(r.status,"needs_clarification"); assert.deepEqual(r.interpretedFilters,currentFilters); assert.equal(calls.length,0);
});
test("서버 날짜 계산: KST 연도 경계·주말·날짜 종료일 포함",()=>{
  assert.deepEqual(resolveDateRange({kind:"this_week"},new Date("2026-12-31T20:00:00Z")),{startsAt:"2026-12-28T00:00:00+09:00",endsAt:"2027-01-04T00:00:00+09:00"});
  assert.deepEqual(resolveDateRange({kind:"this_weekend"},new Date("2026-10-02T14:00:00Z")),{startsAt:"2026-10-03T00:00:00+09:00",endsAt:"2026-10-05T00:00:00+09:00"});
  assert.equal(resolveDateRange({kind:"dates",startsOn:"2026-10-03",endsOn:"2026-10-03"},new Date()).endsAt,"2026-10-04T00:00:00+09:00");
  assert.throws(()=>resolveDateRange({kind:"dates",startsOn:"2026-02-30",endsOn:"2026-03-01"},new Date()));
});
test("중요 조건 질문은 검색을 실행하지 않는다",async()=>{
  const {deps}=setup({model:{async generate(){return response({status:"clarify",filters:{target:"posts"},question:"어느 장소명으로 찾을까요?"});}},discovery:{async search(){throw new Error("must not search");}}});
  assert.equal((await runChat(input,principal,deps,"r1")).status,"needs_clarification");
});
test("미허용 SQL/tool·형식 오류를 받아도 검색하지 않는다",async()=>{
  let searched=false;
  const {deps}=setup({model:{async generate(){return response({status:"search",filters:{target:"posts"},sql:"select secret"});}},discovery:{async search(){searched=true;return [];}}});
  assert.equal((await runChat(input,principal,deps,"r1")).status,"unavailable"); assert.equal(searched,false);
});
test("0건은 조건을 유지하고 자동 확대·설명 호출을 하지 않는다",async()=>{
  const {deps,calls}=setup({discovery:{async search(){return [];}}}); const r=await runChat(input,principal,deps,"r1");
  assert.equal(r.status,"no_results"); assert.equal(calls.length,1); assert.deepEqual(r.interpretedFilters,{target:"posts"});
});
test("공개 허용 카드만 설명 모델에 전달하고 생성된 가격/ID 필드를 카드에 합치지 않는다",async()=>{
  const {deps,calls}=setup({discovery:{async search(){return [{...card,privateAddress:"PRIVATE_ADDRESS",phone:"PRIVATE_PHONE"}];},async recheck(){return [card];}}});
  const r=await runChat(input,principal,deps,"r1"); assert.equal(r.status,"results");
  assert.equal(JSON.stringify(calls).includes("PRIVATE_"),false); assert.deepEqual(r.cards,[card]);
});
test("근거 없는 설명이나 의미 검사 실패는 버리고 검색 카드를 유지",async()=>{
  const {deps}=setup({verifyExplanation:async()=>false}); const r=await runChat(input,principal,deps,"r1");
  assert.equal(r.status,"results"); assert.deepEqual(r.explanations,[]); assert.equal(r.cards.length,1);
});
test("응답 전 삭제·비공개 및 사실 변경 시 옛 설명은 제거",async()=>{
  const {deps}=setup({discovery:{async search(){return [card];},async recheck(){return [{...card,state:"closed",canApply:false}];}}});
  const r=await runChat(input,principal,deps,"r1"); assert.equal(r.cards[0].state,"closed"); assert.deepEqual(r.explanations,[]);
  deps.discovery.recheck=async()=>[]; const removed=await runChat(input,principal,deps,"r2"); assert.equal(removed.status,"no_results"); assert.deepEqual(removed.explanations,[]);
});
test("MBTI는 명시 불일치 제외, 미입력 확인 필요, 자기 성향으로 덮어쓰지 않음",async()=>{
  assert.equal(matchesExplicitMbti("ENFP",null),"missing"); assert.equal(matchesExplicitMbti("ENFP","INTJ"),"mismatch");
  let observed;
  const {deps}=setup({verifyExplanation:undefined,model:{async generate(){return response({status:"search",filters:{target:"posts",mbti:"ENFP"}});}},discovery:{async search(q){observed=q.filters; return [{...card,preferenceMatch:"missing"},{...card,id:"p2",preferenceMatch:"mismatch"}];},async recheck(){return [{...card,preferenceMatch:"missing"}];}}});
  const r=await runChat(input,principal,deps,"r1"); assert.equal(observed.mbti,"ENFP"); assert.deepEqual(r.cards.map(c=>c.id),["p1"]); assert.match(r.notice,/확인/);
});
test("제공사 오류의 본문은 반환하지 않고 취소된 요청은 검색하지 않음",async()=>{
  const {deps}=setup({model:{async generate(){throw new Error("PRIVATE_DIALOGUE");}}});
  const r=await runChat(input,principal,deps,"r1"); assert.equal(JSON.stringify(r).includes("PRIVATE_DIALOGUE"),false);
  const {deps:other,calls}=setup(); const c=new AbortController(); c.abort(); await runChat(input,principal,other,"r2",c.signal); assert.equal(calls.length,0);
});

test("재조회 배열 순서가 달라도 검색 순서를 보존하고 모집 중 필터를 재적용",async()=>{
  const second={...card,id:"p2"};
  const {deps}=setup({verifyExplanation:undefined,discovery:{async search(){return [card,second];},async recheck(){return [second,card];}}});
  assert.deepEqual((await runChat(input,principal,deps,"r1")).cards.map(c=>c.id),["p1","p2"]);
  deps.model.generate=async()=>response({status:"search",filters:{target:"posts",availability:"recruiting"}});
  deps.discovery.recheck=async q=>{assert.equal(q.filters.availability,"recruiting");return [{...card,state:"closed",canApply:true}];};
  assert.equal((await runChat(input,principal,deps,"r2")).status,"no_results");
});
