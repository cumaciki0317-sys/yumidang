import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const require = createRequire(new URL("../../../apps/mobile/package.json", import.meta.url));
const { chromium } = require("playwright");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
const base = process.env.MEMBER_PREVIEW_URL || "http://127.0.0.1:8090";
const apiOrigin = "https://api.example.test";
const scriptUrl = "https://t1.kakaocdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";
const id = "11111111-1111-4111-8111-111111111111";
const reviewId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-10-05T03:00:00Z";
const kstDate = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const startDay = kstDate(Date.now() + 10 * 86400000);
const endDay = kstDate(Date.now() + 11 * 86400000);
const startInput = `${startDay}T14:00`, endInput = `${endDay}T16:00`;
const rawPostal = {
  zonecode: "13529", noSelected: "N", userSelectedType: "J",
  address: "경기 성남시 분당구 판교역로 166",
  roadAddress: "경기 성남시 분당구 판교역로 166",
  jibunAddress: "경기 성남시 분당구 백현동 532",
  sido: "경기", sigungu: "성남시 분당구", bname: "백현동", bname1: "",
};
const originalReview = "가상 공개 후기 원문: 함께 활동하기 편했어요.";
const summaryText = "가상 요약: 상대의 일정과 대화를 존중했어요.";
const event = {
  id, provider: "kopis", sourceId: "PF123456", sourceStatus: "active",
  title: "가상 작성일정 공연", category: "연극", region: "경기도",
  placeName: "가상 행사장", publicAddress: null, admission: { kind: "free" },
  sourceUrl: null, collectedAt: timestamp, state: "upcoming", precision: "date",
  startsOn: startDay, endsOn: endDay, performanceGenre: "play",
};
const place = (n) => ({ source: "kakao", sourceId: String(n), placeName: `가상장소${n}`, address: rawPostal.jibunAddress, roadAddress: rawPostal.roadAddress });
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.setDefaultTimeout(15000);
const checks = [], errors = [], calls = [], unexpectedExternal = [];
let summaryMode = "failed", placesMode = "results", postcodeScripts = 0;
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log("PASS", label); };
const text = () => page.locator("body").innerText();
const click = (name) => page.getByRole("button", { name, exact: true }).last().click();
const waitText = (value) => page.getByText(value, { exact: true }).last().waitFor();
const install = async (target) => {
  await page.goto(`${base}/test-session?target=${encodeURIComponent(target)}`);
  await click("Install synthetic session");
  await page.waitForURL((url) => url.pathname !== "/test-session");
};
page.on("pageerror", (failure) => errors.push(failure.message));
await page.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin === new URL(base).origin) return route.continue();
  if (request.url() === scriptUrl) {
    postcodeScripts++;
    return route.fulfill({ contentType: "application/javascript", body: `window.kakao={Postcode:function(options){this.embed=function(host){host.replaceChildren();function button(label,data){var b=document.createElement('button');b.textContent=label;b.onclick=function(){options.oncomplete(data)};host.appendChild(b);}button('Synthetic mismatched address',${JSON.stringify({...rawPostal, address: "경기 성남시 분당구 다른로 1", roadAddress: "경기 성남시 분당구 다른로 1", jibunAddress: "경기 성남시 분당구 백현동 999"})});button('Synthetic official J selection',${JSON.stringify(rawPostal)});};}};` });
  }
  if (url.origin !== apiOrigin) { unexpectedExternal.push(request.url()); return route.abort(); }
  calls.push({ path: url.pathname, query: url.searchParams, method: request.method(), headers: request.headers() });
  let data, status = 200;
  if (url.pathname.endsWith(`/profiles/${id}/summary`)) {
    if (summaryMode === "failed") status = 503;
    else data = summaryMode === "withdrawn"
      ? {status:"withdrawn", processingAllowed:false, sourceRevision:"2", summary:null}
      : {status:"available", processingAllowed:true, sourceRevision:"1", summary:{summaryId:reviewId, text:summaryText, sourceCount:3, updatedAt:timestamp}};
  } else if (url.pathname.endsWith(`/profiles/${id}/reviews`)) {
    data = { reviews:[{reviewId,rating:5,experience:"positive",text:originalReview,praises:["respect"],submittedAt:timestamp}], praisesTop5:[{code:"respect",label:"가상 칭찬: 배려했어요",count:3}], nextCursor:null, completedCount:3 };
  } else if (url.pathname.endsWith(`/profiles/${id}`)) {
    data = {profileId:id,displayName:"가상 회원",age:29,gender:"female",avatarPath:null,bio:"가상 소개",interests:["전시"],conversationStyles:["편안한 대화"],mbti:null,completedCount:3};
  } else if (url.pathname.endsWith("/places")) {
    if (placesMode === "failed") status = 503;
    else data = placesMode === "empty" ? {status:"no_results",places:[],nextPage:null}
      : url.searchParams.get("page") === "2" ? {status:"results",places:[place(11)],nextPage:null}
      : {status:"results",places:Array.from({length:10},(_,i)=>place(i+1)),nextPage:2};
  } else if (url.pathname.endsWith("/events")) data = {events:[event],nextCursor:null};
  else if (url.pathname.endsWith("/posts")) data = {status:"no_results",posts:[],nextCursor:null};
  else status = 404;
  return route.fulfill({status,contentType:"application/json",body:JSON.stringify(status === 200 ? {data,requestId:"synthetic-member-browser"} : {error:{code:status===503?"EXTERNAL_UNAVAILABLE":"RESOURCE_NOT_FOUND",message:"가상 조회 실패"},requestId:"synthetic-member-browser"})});
});
try {
  await install(`/profile?id=${id}`);
  await waitText(originalReview);
  await waitText("가상 칭찬: 배려했어요 · 3회");
  await page.getByText(/불러오지 못했어요/).last().waitFor();
  check("profile original review and praises survive independent summary failure", (await text()).includes(originalReview) && (await text()).includes("가상 칭찬: 배려했어요 · 3회") && !(await text()).includes("당도 15"));
  summaryMode = "available";
  await install(`/profile?id=${id}`);
  await page.getByRole("button",{name:"요약 펼치기",exact:true}).waitFor();
  check("collapsed summary text is absent from DOM", !(await text()).includes(summaryText));
  const beforeExpand = calls.filter((c)=>c.path.endsWith("/summary")).length;
  await click("요약 펼치기");
  await waitText(summaryText);
  check("summary expansion performs a fresh server read", calls.filter((c)=>c.path.endsWith("/summary")).length > beforeExpand);
  await click("접기");
  await page.getByRole("button",{name:"요약 펼치기",exact:true}).waitFor();
  summaryMode = "withdrawn";
  const beforeWithdrawn = calls.filter((c)=>c.path.endsWith("/summary")).length;
  await click("요약 펼치기");
  await waitText("후기 요약 제공이 중단되었어요. 공개 후기는 아래에서 확인할 수 있어요.");
  check("withdrawn response removes old summary while preserving original and praises", calls.filter((c)=>c.path.endsWith("/summary")).length > beforeWithdrawn && !(await text()).includes(summaryText) && (await text()).includes(originalReview) && (await text()).includes("가상 칭찬: 배려했어요 · 3회"));

  await install("/create");
  await click("장소명 또는 주소로 찾아보기");
  const searchBox = page.getByRole("textbox",{name:"장소 이름",exact:true}).last();
  await searchBox.fill("가상 장소 검색");
  await click("장소 검색");
  await waitText("가상장소10");
  check("real places adapter displays the first ten input candidates", (await text()).includes("가상장소10") && !(await text()).includes("가상장소11") && !(await text()).includes("프로토타입 장소 목록"));
  await click("장소 10개 더 보기"); await waitText("가상장소11");
  check("place pagination sends next page and retains first candidates", calls.some((c)=>c.path.endsWith("/places")&&c.query.get("page")==="2") && (await text()).includes("가상장소1"));
  placesMode="failed"; await searchBox.fill("가상 실패 검색"); await click("장소 검색");
  await waitText("장소를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
  check("place failure is distinguished from empty result", !(await text()).includes("검색된 장소가 없어요. 다른 검색어로 찾아보세요."));
  placesMode="empty"; await click("장소 조회 다시 시도");
  await waitText("검색된 장소가 없어요. 다른 검색어로 찾아보세요.");
  check("explicit empty source result renders no candidates", !(await text()).includes("가상장소1") && !(await text()).includes("장소를 불러오지 못했어요."));
  placesMode="results"; await searchBox.fill("가상 정상 검색"); await click("장소 검색"); await waitText("가상장소1");
  await page.getByText("가상장소1",{exact:true}).click();
  await page.getByRole("button",{name:"Synthetic mismatched address",exact:true}).waitFor();
  await click("Synthetic mismatched address");
  await waitText("선택한 장소와 같은 주소를 골라주세요. 주소가 다르면 장소를 연결할 수 없어요.");
  check("provider address mismatch cannot attach an unrelated place", (await text()).includes("만남 장소 선택"));
  await click("Synthetic official J selection");
  await waitText("공개 지역 · 경기도 성남시 분당구 백현동");
  await page.getByText("만남 장소 선택",{exact:true}).waitFor({state:"hidden"});
  check("official J callback sets exact selected input and only dong public area", (await text()).includes(rawPostal.jibunAddress) && (await text()).includes("공개 지역 · 경기도 성남시 분당구 백현동") && !(await text()).includes("만남 장소 선택"));
  check("postcode uses local stub of official client script without external call", postcodeScripts===1 && unexpectedExternal.length===0);

  await page.getByRole("textbox",{name:"시작 일시",exact:true}).fill(startInput);
  await page.getByRole("textbox",{name:"예상 종료 일시",exact:true}).fill(endInput);
  await click("연결할 행사 선택하기"); await waitText(event.title);
  const selectionRequest = calls.findLast((c)=>c.path.endsWith("/events"));
  check("event selection requests explicit draft period and product page size", selectionRequest?.query.get("mode")==="post_selection" && selectionRequest.query.get("periodStart")===startDay && selectionRequest.query.get("periodEnd")===endDay && selectionRequest.query.get("limit")==="10");
  await click("이 행사 연결하기");
  check("event attachment leaves the original companion interval intact", await page.getByRole("textbox",{name:"시작 일시",exact:true}).inputValue()===startInput && await page.getByRole("textbox",{name:"예상 종료 일시",exact:true}).inputValue()===endInput);
  const beforeVenue = calls.filter((c)=>c.path.endsWith("/places")).length;
  await click("행사장을 장소 후보로 찾기");
  check("source venue only prefills search without auto query or address selection", await page.getByRole("textbox",{name:"장소 이름",exact:true}).last().inputValue()===event.placeName && calls.filter((c)=>c.path.endsWith("/places")).length===beforeVenue);
  await click("장소 선택 닫기");
  await click("작성 중인 내용 임시저장");
  await waitText("임시저장하지 못했어요. 작성 내용은 화면에 남아 있어요.");
  check("unconnected draft persistence never reports synthetic save success", !(await text()).includes("이 기기에 초안을 임시저장했어요.") && (await text()).includes("공개 지역 · 경기도 성남시 분당구 백현동") && calls.every((c)=>c.method==="GET"));
  check("synthetic member requests carry the test-only bearer token", calls.filter((c)=>/\/profiles\/|\/places$/.test(c.path)).every((c)=>c.headers.authorization==="Bearer browser-synthetic-member"));
  check("member browser flow has no page errors or unknown external requests", errors.length===0 && unexpectedExternal.length===0);
  console.log(JSON.stringify({checks:checks.length,apiRequests:calls.length,postcodeScripts,errors,unexpectedExternal,evidence:"local browser with test-only synthetic session, fake HTTP and official-script stub; actual Naver/Auth/DB/provider/storage not run"}));
} catch (failure) {
  console.error(JSON.stringify({body:(await text()).slice(-8000),errors,calls:calls.map((c)=>({path:c.path,query:String(c.query),method:c.method})),unexpectedExternal}));
  throw failure;
} finally { await browser.close(); }
