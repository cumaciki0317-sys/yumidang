import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const require = createRequire(new URL("../../../apps/mobile/package.json", import.meta.url));
const { chromium } = require("playwright");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
const base = process.env.MEMBER_PREVIEW_URL || "http://127.0.0.1:8090";
const id = "11111111-1111-4111-8111-111111111111", feedbackId = "33333333-3333-4333-8333-333333333333";
const userOne = "가상 질문 하나: 지역을 함께 확인해 주세요.";
const question = "가상 확인 질문: 원하는 지역은 어디인가요?";
const excerpt = "가상 확인 질문";
const resultNotice = "가상 결과 안내";
const cardTitle = "가상 AI 공연 카드";
const event = {
  id, provider:"kopis", sourceId:"PF123456", sourceStatus:"active", title:"가상 홈 공연",
  category:"서양음악(클래식)", region:"서울특별시", placeName:"가상 공식 공연장", publicAddress:null,
  admission:{kind:"free"}, sourceUrl:null, collectedAt:"2026-10-05T03:00:00Z", state:"ongoing",precision:"date",
  startsOn:"2026-10-05",endsOn:"2026-10-31",performanceGenre:"concert",
};
const card = {kind:"event",id,title:cardTitle,locationLabel:"가상 공식 공연장",startsAtOrDate:"2026-10-05",endsAtOrDate:"2026-10-31",costLabel:"무료",state:"ongoing",canApply:false,sourceName:"KOPIS",sourceUrl:null};
const browser = await chromium.launch({headless:true,executablePath});
const page = await browser.newPage({viewport:{width:390,height:844}});
page.setDefaultTimeout(15000);
const calls=[],checks=[],errors=[],external=[];
let aiMode="clarify", reportMode="not_enabled", sequence=0, releaseLate=null, lateDelivered=false;
let markLateReady;
const lateReady=new Promise(resolve=>{markLateReady=resolve;});
const check=(label,condition)=>{assert.ok(condition,label);checks.push(label);console.log("PASS",label);};
const text=()=>page.locator("body").innerText();
const click=(name)=>page.getByRole("button",{name,exact:true}).last().click();
const enterAi=()=>page.getByText("AI 동행 탐색",{exact:true}).last().click();
const waitText=(value)=>page.getByText(value,{exact:true}).last().waitFor();
const feedbackCalls=()=>calls.filter(c=>c.path.endsWith("/feedback"));
const aiCalls=()=>calls.filter(c=>c.path.endsWith("/ai-chat"));
const reportCalls=()=>feedbackCalls().filter(c=>c.body.action==="report");
const sendQuestion=async(content)=>{
  await page.getByRole("textbox",{name:"찾고 싶은 동행과 지역을 알려 주세요",exact:true}).fill(content);
  await click("보내기"); await waitText(aiMode==="clarify"?question:cardTitle);
};
const openReport=async()=>{await click("문제 있어요");await page.getByTestId("ai-feedback-text").waitFor();};
const chooseExcerpt=async(value)=>{await page.getByTestId("ai-feedback-text").fill(value);await page.getByTestId("ai-feedback-confirm").click();};
page.on("pageerror",error=>errors.push(error.message));
// This test-only wrapper makes late-response guards observable even when a transport ignores abort.
await page.addInitScript(()=>{
  const original=window.fetch.bind(window);
  window.fetch=(input,init)=>{
    const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;
    if(window.__TEST_IGNORE_FEEDBACK_ABORT===true&&url.endsWith("/feedback")) return original(input,{...init,signal:undefined});
    return original(input,init);
  };
});
await page.route("**/*",async(route)=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===new URL(base).origin) return route.continue();
  if(url.origin!=="https://api.example.test") {external.push(request.url());return route.abort();}
  const body=request.postDataJSON();
  calls.push({path:url.pathname,method:request.method(),body,headers:request.headers()});
  let data,status=200;
  if(url.pathname.endsWith("/ai-chat")) {
    sequence++;
    const requestId=`22222222-2222-4222-8222-${String(sequence).padStart(12,"0")}`;
    data=aiMode==="clarify"?{requestId,status:"needs_clarification",interpretedFilters:{target:"posts"},cards:[],explanations:[],clarificationQuestion:question}
      :{requestId,status:"results",interpretedFilters:{target:"events",region:"서울특별시",performanceGenre:"concert"},cards:[card],explanations:[],notice:resultNotice};
  } else if(url.pathname.endsWith("/ai-chat/feedback")) {
    if(body.action==="helpful") data={status:"not_enabled",reason:"AI_FEEDBACK_STORAGE_NOT_CONNECTED"};
    else if(reportMode==="not_enabled") data={status:"not_enabled",reason:"AI_REPORT_EVIDENCE_HANDLING_NOT_CONNECTED"};
    else if(reportMode==="failed") status=503;
    else {
      if(reportMode==="late") {await new Promise(resolve=>{releaseLate=resolve;markLateReady();});lateDelivered=true;}
      data={status:"accepted",feedbackId,hideAnswer:true};
    }
  } else if(url.pathname.endsWith("/events")) data={events:[event],nextCursor:null};
  else if(url.pathname.endsWith("/posts")) data={status:"no_results",posts:[],nextCursor:null};
  else status=404;
  await route.fulfill({status,contentType:"application/json",body:JSON.stringify(status===200?{data,requestId:"synthetic-ai-browser"}:{error:{code:"EXTERNAL_UNAVAILABLE",message:"가상 실패"},requestId:"synthetic-ai-browser"})});
});
try {
  await page.goto(`${base}/test-session?target=%2F`); await click("Install synthetic session");
  await waitText(event.title);
  check("service home shows real fixture event without a preview empty claim", !(await text()).includes("이번 주 새로 시작하는 미종료 행사가 없어요."));
  await click("동행 공고 작성"); await page.waitForURL(url=>url.pathname==="/create");
  check("verified member home creation action bypasses login guard", (await text()).includes("공고 제목 *")&&!(await text()).includes("로그인 후 공고를 작성해요"));
  await page.goBack();
  await page.waitForURL(url=>url.pathname==="/");
  await enterAi(); await page.waitForURL(url=>url.pathname==="/ai");
  check("verified member home AI action reaches actual service screen", (await text()).includes("찾고 싶은 동행과 지역을 알려 주세요")||await page.getByRole("textbox",{name:"찾고 싶은 동행과 지역을 알려 주세요",exact:true}).count()===1);
  await sendQuestion(userOne);
  check("needs-clarification response renders the question without fabricated cards", (await text()).includes(question)&&!(await text()).includes(cardTitle));
  const quotaCalls=aiCalls().length;
  await click("도움이 됐어요");await waitText("의견 접수 기능을 준비 중이에요. 답변은 숨기지 않았어요.");
  check("unconnected helpful storage preserves answer and never reports acceptance", (await text()).includes(question)&&!(await text()).includes("의견을 접수했어요.")&&!(await text()).includes("의견 접수됨"));
  await openReport();
  check("report starts blank and unconfirmed without automatic transcript attachment", await page.getByTestId("ai-feedback-text").inputValue()===""&&await page.getByTestId("ai-feedback-submit").isDisabled()&&reportCalls().length===0);
  await page.getByTestId("ai-feedback-text").fill("가".repeat(501));
  await waitText("500자 이내의 구간을 직접 선택해 주세요.");
  check("over-500 selected text cannot be confirmed or submitted", await page.getByTestId("ai-feedback-submit").isDisabled()&&reportCalls().length===0);
  await page.getByTestId("ai-feedback-text").fill(excerpt);
  check("valid text still requires explicit confirmation before any request", await page.getByTestId("ai-feedback-submit").isDisabled()&&reportCalls().length===0);
  await page.getByTestId("ai-feedback-confirm").click();
  await page.getByTestId("ai-feedback-submit").click();
  await waitText("의견 접수 기능을 준비 중이에요. 답변은 숨기지 않았어요.");
  check("not-enabled report preserves selected input and displayed answer", await page.getByTestId("ai-feedback-text").inputValue()===excerpt&&(await text()).includes(question));
  const firstReport=reportCalls().at(-1).body;
  check("report request contains only confirmed excerpt and identifiers", Object.keys(firstReport).sort().join(",")==="action,attachment,clientRequestId,confirmed,requestId"&&firstReport.confirmed===true&&JSON.stringify(firstReport.attachment)===JSON.stringify({kind:"answer",text:excerpt})&&!JSON.stringify(firstReport).includes(userOne));
  reportMode="failed";await page.getByTestId("ai-feedback-submit").click();
  await waitText("접수하지 못했어요. 선택한 자료를 유지했으니 다시 시도해 주세요.");
  check("transient report failure keeps excerpt and idempotency key", await page.getByTestId("ai-feedback-text").inputValue()===excerpt&&reportCalls().at(-1).body.clientRequestId===firstReport.clientRequestId);
  reportMode="accepted";await page.getByTestId("ai-feedback-submit").click();
  await page.getByText(question,{exact:true}).waitFor({state:"hidden"});
  check("accepted report hides only targeted assistant content while keeping user message", !(await text()).includes(question)&&(await text()).includes(userOne)&&reportCalls().at(-1).body.clientRequestId===firstReport.clientRequestId);
  check("feedback submissions do not issue additional model requests", aiCalls().length===quotaCalls);

  aiMode="results";await sendQuestion("가상 공연을 확인해 주세요.");
  check("latest performance-genre response schema displays source event cards", (await text()).includes(cardTitle)&&(await text()).includes("출처: KOPIS"));
  await openReport();await click("캡처 한 개");
  await waitText("캡처 업로드가 아직 연결되지 않았어요. 답변 구간으로 접수할 수 있어요.");
  check("unconnected capture picker cannot submit or fabricate uploaded asset", await page.getByTestId("ai-feedback-capture").isDisabled()&&await page.getByTestId("ai-feedback-submit").isDisabled());
  await click("답변 구간 입력");await chooseExcerpt(resultNotice);
  await page.getByTestId("ai-feedback-submit").click();
  await page.getByText(cardTitle,{exact:true}).waitFor({state:"hidden"});
  check("accepted result report removes assistant and its cards without user transcript loss", !(await text()).includes(resultNotice)&&!(await text()).includes(cardTitle)&&(await text()).includes("가상 공연을 확인해 주세요.")&&(await text()).includes(userOne));

  await sendQuestion("가상 지연 신고를 준비해 주세요.");await openReport();await chooseExcerpt(resultNotice);
  reportMode="late";await page.evaluate(()=>{window.__TEST_IGNORE_FEEDBACK_ABORT=true;});
  await page.getByTestId("ai-feedback-submit").click();
  let lateTimer;
  await Promise.race([lateReady,new Promise((_,reject)=>{lateTimer=setTimeout(()=>reject(new Error("Late request did not start")),15000);})]).finally(()=>clearTimeout(lateTimer));
  assert.ok(releaseLate,"late report request was captured");
  await click("뒤로 가기");await page.waitForURL(url=>url.pathname==="/");
  await enterAi();await page.waitForURL(url=>url.pathname==="/ai");
  check("leaving AI clears old conversation before returning", !(await text()).includes(userOne)&&!(await text()).includes("가상 지연 신고를 준비해 주세요.")&&!(await text()).includes(cardTitle));
  await sendQuestion("가상 복귀 후 새 질문");
  releaseLate();await page.waitForTimeout(250);
  check("late accepted feedback cannot hide newly returned screen content", lateDelivered&&(await text()).includes("가상 복귀 후 새 질문")&&(await text()).includes(cardTitle)&&(await text()).includes(resultNotice));
  check("all feedback uses synthetic authenticated requests without unknown external traffic", feedbackCalls().every(c=>c.headers.authorization==="Bearer browser-synthetic-member")&&external.length===0&&errors.length===0);
  console.log(JSON.stringify({checks:checks.length,aiRequests:aiCalls().length,feedbackRequests:feedbackCalls().length,pageErrors:errors,external,evidence:"local test-only auth session and fake HTTP; no real Naver, DB, model, provider, report storage or capture upload"}));
} catch(failure) {
  console.error(JSON.stringify({body:(await text()).slice(-9000),errors,external,calls:calls.map(c=>({path:c.path,method:c.method,body:c.body}))}));throw failure;
} finally { releaseLate?.();await browser.close(); }
