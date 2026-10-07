import assert from "node:assert/strict";
import test from "node:test";
import { createConservativePrivacyCheck, assertPrivacy } from "../../../backend/supabase/functions/_shared/ai/providers/privacy.ts";
import { conservativeExplanationCheck, checkExplanations } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/output-check.ts";
import { createConservativeSummarySafety } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/output-check.ts";
import type { AiCard } from "../../../backend/supabase/functions/_shared/contracts/ai.ts";
const card: AiCard = { kind:"post",id:"synthetic",title:"전시 동행",locationLabel:"성수동",startsAtOrDate:"2026-10-10",endsAtOrDate:"2026-10-10",costLabel:"무료",state:"recruiting",canApply:true };
test("보수적 개인정보: 승인 없는 이름/상세주소와 연락처를 차단, 목록 변경으로 승인 확대 불가",async()=>{
 const strings=["전시 동행","성수동","text"], privacy=createConservativePrivacyCheck({decisionId:"synthetic-review",approvedStrings:strings});
 strings.push("홍길동");
 assert.equal(await privacy.check({text:"전시 동행"}),true);
 for(const text of ["홍길동","서울 성수동 123번지 101호","010-1234-5678","a@example.test"])assert.equal(await privacy.check({text}),false);
 await assert.rejects(assertPrivacy("홍길동",privacy,"output"));
 assert.equal(await privacy.check({"홍길동":true}),false);
 const circular:any={};circular.self=circular;assert.equal(await privacy.check(circular),false);
});
test("카드 설명: 정확 필드 인용만 허용, ID 일치가 과장 설명을 승인하지 않음",async()=>{
 assert.equal(await conservativeExplanationCheck("전시 동행",card),true);
 for(const text of ["전시 동행은 무조건 안전","성수동에서 무료인 전시", "다른 전시"] )assert.equal(await conservativeExplanationCheck(text,card),false);
 await assert.rejects(checkExplanations({explanations:[{kind:"post",id:"synthetic",text:"누구나 안전"}]},[card],conservativeExplanationCheck));
});
test("후기 의미: 부정 삭제/새 주장/다른 근거/개인정보는 게시 불가",async()=>{
 const comment="약속 시간에 도착하지 않았어요.", privacy=createConservativePrivacyCheck({decisionId:"synthetic-review",approvedStrings:[comment]});
 const safety=createConservativeSummarySafety(privacy),publicTextReviews=[{evidenceId:"r1",comment}];
 assert.equal(await safety.check({claims:[{text:comment,evidenceIds:["r1"]}],publicTextReviews}),true);
 for(const text of ["약속 시간에 도착", "시간 약속을 잘 지켜요.","홍길동과 만났어요."] )assert.equal(await safety.check({claims:[{text,evidenceIds:["r1"]}],publicTextReviews}),false);
 assert.equal(await safety.check({claims:[{text:comment,evidenceIds:["r2"]}],publicTextReviews}),false);
 assert.equal(await safety.check({claims:[{text:comment,evidenceIds:["r1","r2"]}],publicTextReviews:[...publicTextReviews,{evidenceId:"r2",comment:"다른 경험"}]}),false);
});
test("개인정보 검사기는 불명 응답/검사 예외/순환 데이터도 privacy 차단으로 반환",async()=>{
 const circular:any={};circular.self=circular;
 for(const value of [circular,undefined,1n])await assert.rejects(assertPrivacy(value,{decisionId:"synthetic",async check(){return true}},"input"),{message:"AI_PRIVACY_BLOCKED",direction:"input"});
 await assert.rejects(assertPrivacy("정상 데이터",{decisionId:"synthetic",async check(){throw new Error("raw private error")}},"output"),{message:"AI_PRIVACY_BLOCKED",direction:"output"});
});
test("JSON 위장 toJSON/getter/숨은 속성/배열 extra와 sparse는 allowlist 검사 불가",async()=>{
 const check=createConservativePrivacyCheck({decisionId:"synthetic",approvedStrings:["text","정상 데이터"]});
 const hidden={text:"정상 데이터"};Object.defineProperty(hidden,"toJSON",{value:()=>({name:"홍길동"})});
 const accessor={};Object.defineProperty(accessor,"text",{enumerable:true,get:()=>"정상 데이터"});
 const extra:any=["정상 데이터"];extra.name="홍길동";
 const sparse=new Array(2);sparse[1]="정상 데이터";
 for(const value of [hidden,accessor,extra,sparse])assert.equal(await check.check(value),false);
 assert.equal(await check.check(["정상 데이터"]),true);
 assert.equal(await check.check({text:"정상 데이터"}),true);
});
test("동일 근거를 두 주장으로 재사용하거나 async 검사 중 바꾼 주장은 거절",async()=>{
 const comment="도착하지 않았어요.",privacy=createConservativePrivacyCheck({decisionId:"synthetic",approvedStrings:[comment]}),safety=createConservativeSummarySafety(privacy);
 const publicTextReviews=[{evidenceId:"r1",comment}];
 assert.equal(await safety.check({claims:[{text:comment,evidenceIds:["r1"]},{text:comment,evidenceIds:["r1"]}],publicTextReviews}),false);
 const claims=[{text:comment,evidenceIds:["r1"]}];
 const mutate=createConservativeSummarySafety({decisionId:"synthetic",async check(){claims[0].text="도착했어요.";return true;}});
 assert.equal(await mutate.check({claims,publicTextReviews}),false);
});
test("설명 구조의 여분 필드/중복카드/다른 카드 근거는 정확 내용이어도 거절",async()=>{
 for(const raw of [
  {explanations:[{kind:"post",id:card.id,text:card.title}],realName:"홍길동"},
  {explanations:[{kind:"post",id:card.id,text:card.title,name:"홍길동"}]},
  {explanations:[{kind:"post",id:card.id,text:card.title},{kind:"post",id:card.id,text:card.title}]},
  {explanations:[{kind:"event",id:card.id,text:card.title}]}
 ])await assert.rejects(checkExplanations(raw,[card],conservativeExplanationCheck));
});
test("범위·조건·부정 보존: 원문 일부/결합/증거 오배정은 거절",async()=>{
 const a="늦는다고 미리 알려줘서 기다리지 않았어요.",b="전시에서는 조용했지만 식사에서는 대화를 많이 했어요.";
 const safety=createConservativeSummarySafety(createConservativePrivacyCheck({decisionId:"synthetic",approvedStrings:[a,b]})),publicTextReviews=[{evidenceId:"a",comment:a},{evidenceId:"b",comment:b}];
 assert.equal(await safety.check({claims:[{text:a,evidenceIds:["a"]},{text:b,evidenceIds:["b"]}],publicTextReviews}),true);
 for(const claims of [
  [{text:"기다리지 않았어요.",evidenceIds:["a"]},{text:b,evidenceIds:["b"]}],
  [{text:a+" "+b,evidenceIds:["a","b"]}],
  [{text:a,evidenceIds:["b"]},{text:b,evidenceIds:["a"]}],
  [{text:"항상 조용해요.",evidenceIds:["a","b"]}]
 ])assert.equal(await safety.check({claims,publicTextReviews}),false);
});
