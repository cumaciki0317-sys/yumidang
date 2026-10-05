import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const require = createRequire(new URL("../../../apps/mobile/package.json", import.meta.url));
const { chromium } = require("playwright");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
const base = process.env.MEMBER_WRITES_PREVIEW_URL || "http://127.0.0.1:8092";
const apiOrigin = "https://api.example.test";
const userId = "11111111-1111-4111-8111-111111111111", postId = "22222222-2222-4222-8222-222222222222", requestId = "33333333-3333-4333-8333-333333333333";
const at = "2026-10-05T03:00:00.123456Z";
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.setDefaultTimeout(15000);
const checks = [], calls = [], errors = [], external = [];
let preferenceFailure = true, messageFailure = true, publishFailure = true;
let preferences = { interests: ["전시"], conversationStyles: [], mbti: null, bio: "원래 소개" };
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log("PASS", label); };
const bodyText = () => page.locator("body").innerText();
const click = name => page.getByRole("button", { name, exact: true }).last().click();
const install = async target => { await page.goto(`${base}/test-session?target=${encodeURIComponent(target)}`); await click("Install synthetic session"); if (target === "/publish") { await page.waitForTimeout(100); await click("Install synthetic session"); } await page.waitForURL(url => url.pathname !== "/test-session"); };
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin === new URL(base).origin) return route.continue();
  if (url.origin !== apiOrigin) { external.push(url.origin); return route.abort(); }
  const path = url.pathname.replace("/functions/v1/service-api", "");
  const input = request.postData() ? JSON.parse(request.postData()) : null;
  calls.push({ path, method: request.method(), input, authorization: request.headers().authorization });
  let data, status = 200;
  if (path === "/posts" && request.method() === "POST") { if (publishFailure) status = 503; else data = { postId: input.postId, alreadyCreated: false }; }
  else if (/^\/posts\/[0-9a-f-]{36}$/i.test(path) && request.method() === "GET") status = 503;
  else if (path === "/me") data = { userId, realName: "가상 회원", avatarUrl: null, bio: preferences.bio, sweetness: 15 };
  else if (path === "/me/traits") data = { interests: preferences.interests, conversationStyles: preferences.conversationStyles, mbti: preferences.mbti };
  else if (path === "/me/preferences") { if (preferenceFailure) status = 503; else { preferences = input; data = preferences; } }
  else if (path === `/posts/${postId}/requests`) {
    if (messageFailure) status = 503;
    else data = { id: requestId, post_id: postId, status: "pending", created_at: at, already_existed: false, messageId: input.messageId, messageCreatedAt: at, alreadySent: false };
  } else if (path === `/conversations/${requestId}`) data = [{ request_id: requestId, can_send: true, my_role: "requester", post_title: "가상 동행", post_id: postId, appointment_id: null }];
  else if (path === `/conversations/${requestId}/messages`) data = request.method() === "POST" ? { messageId: input.messageId, createdAt: at, alreadySent: false } : { items: [], nextCursor: null };
  else if (path === `/requests/${requestId}/consent`) data = { consent: null };
  else if (path === "/appointments" || path === "/conversations" || path === "/requests/sent" || path === "/requests/received") data = [];
  else if (["/me/blocks", "/me/reports", "/notifications"].includes(path)) data = { items: [], nextCursor: null };
  else if (path === "/me/safety") data = { permanent: false, restrictedUntil: null, hasWarning: false, sanctions: [] };
  else { external.push(`UNEXPECTED_API:${path}`); return route.abort(); }
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { data, requestId: userId } : { error: { code: "EXTERNAL_UNAVAILABLE", message: "가상 실패", retryable: true }, requestId: userId }) });
});
try {
  await install("/preferences");
  const bio = page.getByRole("textbox", { name: "소개 (최대 300자)", exact: true });
  await bio.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll("textarea,input")].some(input => input.value === "원래 소개"));
  await bio.fill("실패 후에도 남겨야 하는 소개");
  await page.getByRole("textbox", { name: "관심사", exact: true }).fill("전시, 산책");
  await click("저장하기");
  await page.waitForFunction(() => document.body.innerText.includes("다시 시도"));
  check("preferences failure retains edited bio", await bio.inputValue() === "실패 후에도 남겨야 하는 소개");
  check("failed preferences never reports successful navigation", new URL(page.url()).pathname === "/preferences");
  preferenceFailure = false;
  await click("저장하기");
  await page.waitForFunction(() => document.body.innerText.includes("저장했어요") || document.body.innerText.includes("저장됐어요"));
  const saved = calls.filter(c => c.path === "/me/preferences");
  check("four preference fields are sent atomically", saved.length === 2 && Object.keys(saved[1].input).sort().join(",") === "bio,conversationStyles,interests,mbti");
  check("successful preference request contains original input snapshot", saved[1].input.bio === "실패 후에도 남겨야 하는 소개" && saved[1].input.interests.join(",") === "전시,산책");
  await page.reload();
  await install("/preferences");
  await page.waitForFunction(() => [...document.querySelectorAll("textarea,input")].some(input => input.value === "실패 후에도 남겨야 하는 소개"));
  check("saved values are fetched again instead of preview state", (await bodyText()).includes("취향"));

  await install(`/chat?id=${postId}`);
  const first = page.getByRole("textbox", { name: "첫 메시지", exact: true });
  await first.waitFor(); await first.fill("첫 메시지 가상 동행 신청");
  await click("메시지 보내기");
  await page.waitForFunction(() => document.body.innerText.includes("다시 시도"));
  check("failed first message preserves text and application is not locally created", await first.inputValue() === "첫 메시지 가상 동행 신청");
  messageFailure = false; await click("메시지 보내기");
  await page.getByRole("textbox", { name: "메시지", exact: true }).waitFor();
  const applications = calls.filter(c => c.path === `/posts/${postId}/requests`);
  check("first message retry uses the same immutable message id", applications.length === 2 && applications[0].input.messageId === applications[1].input.messageId);
  check("only first-message endpoint creates application", applications.every(c => Object.keys(c.input).sort().join(",") === "message,messageId") && !calls.some(c => c.path.includes("apply")));
  check("successful application opens server request conversation", calls.some(c => c.path === `/conversations/${requestId}`));

  await install("/publish");
  await page.getByText("등록 정보와 공개 범위를 확인했어요.", { exact: true }).click();
  await click("공고 등록하기");
  await page.waitForFunction(() => document.body.innerText.includes("다시 시도"));
  check("failed post publication retains draft and review screen", new URL(page.url()).pathname === "/publish" && (await bodyText()).includes("가상 발행 검증"));
  publishFailure = false;
  await click("공고 등록하기");
  await page.waitForURL(url => url.pathname !== "/publish");
  const posts = calls.filter(c => c.path === "/posts" && c.method === "POST");
  check("post publication retries identical UUID and immutable body", posts.length === 2 && JSON.stringify(posts[0].input) === JSON.stringify(posts[1].input));
  check("post publication remains free and keeps private meeting detail out of public area", posts[1].input.costType === "free" && posts[1].input.amount === 0 && posts[1].input.meetingDetail === "정문 안내대" && posts[1].input.publicArea === "서울 성동구 성수동");
  // The public detail is a separate fixture; publication verification ends at the confirmed server response.
  await install("/account"); await page.getByText("계정 이용 상태", { exact: true }).waitFor();
  check("unprepared retirement does not send an invented endpoint", !calls.some(c => /retire|withdrawal|delete-account/.test(c.path)));
  check("all member HTTP requests use synthetic session only", calls.every(c => c.authorization === "Bearer browser-synthetic-member"));
  check("browser has no page errors or unexpected external requests", errors.length === 0 && external.length === 0);
  console.log(JSON.stringify({ checks: checks.length, requests: calls.length, errors, external, evidence: "temporary test-only session route and fake HTTP; actual Naver/Auth/DB/Storage/provider/device not run" }));
} catch (error) {
  console.error(JSON.stringify({ body: (await bodyText()).slice(-5000), errors, external, calls: calls.map(c => ({ path: c.path, method: c.method })) }));
  throw error;
} finally { await browser.close(); }
