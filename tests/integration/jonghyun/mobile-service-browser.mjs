import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const require = createRequire(
  new URL("../../../apps/mobile/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined);
const base = process.env.SERVICE_PREVIEW_URL || "http://127.0.0.1:8089";
const id = "11111111-1111-4111-8111-111111111111";
const card = {
  id,
  title: "실제응답 가을전시",
  authorDisplayName: null,
  publicArea: "서울특별시 종로구 종로1가",
  startsAt: "2026-10-05T03:00:00Z",
  endsAt: "2026-10-05T04:00:00Z",
  cost: { kind: "free" },
  state: "recruiting",
  canApply: false,
};
const detail = {
  postId: id,
  title: card.title,
  description: "공개 소개",
  category: "전시",
  startsAt: card.startsAt,
  endsAt: card.endsAt,
  recruitmentEndsAt: card.startsAt,
  updatedAt: card.startsAt,
  publicArea: card.publicArea,
  status: "recruiting",
  costType: "free",
  amount: 0,
  preferenceNote: null,
  tags: [],
  eventId: null,
  linkedEvent: null,
  authorDisplayName: null,
};
const event = {
  id,
  provider: "kopis",
  sourceId: "PF123456",
  sourceStatus: "active",
  title: "공식응답 음악공연",
  category: "서양음악(클래식)",
  region: "서울특별시",
  placeName: "공식 공연장",
  publicAddress: null,
  admission: { kind: "free" },
  sourceUrl: null,
  collectedAt: card.startsAt,
  state: "ongoing",
  precision: "date",
  startsOn: "2026-10-05",
  endsOn: "2026-10-31",
  performanceGenre: "concert",
  description: "공식 소개",
  operatingInfo: "공식 운영 안내",
  posterUrl: null,
};
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const checks = [], errors = [], calls = [];
let searchState = "okay";
const check = (label, condition) => {
  assert.ok(condition, label);
  checks.push(label);
  console.log("PASS", label);
};
page.on("pageerror", (e) => errors.push(e.message));
await page.route("https://api.example.test/**", async (route) => {
  const request = route.request(), url = new URL(request.url());
  calls.push({
    path: url.pathname,
    query: url.searchParams,
    headers: request.headers(),
  });
  let data;
  let status = 200;
  if (url.pathname.endsWith("/posts")) {
    if (searchState === "failed") status = 503;
    data = {
      status: "results",
      posts: [
        searchState === "leak"
          ? { ...card, authorDisplayName: "노출금지실명" }
          : card,
      ],
      nextCursor: null,
    };
  } else if (url.pathname.endsWith(`/posts/${id}`)) data = detail;
  else if (url.pathname.endsWith("/events/filters")) {
    data = {
      regions: [{ provider: "kopis", value: "서울특별시", count: 1 }],
      categories: [{ provider: "kopis", value: "서양음악(클래식)", count: 1 }],
    };
  } else if (url.pathname.endsWith("/events/rankings")) {
    data = {
      status: "unavailable",
      mode: url.searchParams.get("mode"),
      sourceName: "KOPIS",
      period: null,
      collectedAt: null,
      items: [],
    };
  } else if (url.pathname.endsWith(`/events/${id}`)) data = event;
  else if (url.pathname.endsWith("/events")) {
    data = { events: [event], nextCursor: null };
  } else status = 404;
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(
      status === 200 ? { data, requestId: "browser-fixture" } : {
        error: {
          code: status === 503 ? "EXTERNAL_UNAVAILABLE" : "RESOURCE_NOT_FOUND",
          message: "조회 실패",
        },
        requestId: "browser-fixture",
      },
    ),
  });
});
const text = () => page.locator("body").innerText();
const click = async (name) =>
  page.getByRole("button", { name, exact: true }).last().click();
try {
  await page.goto(`${base}/explore`);
  await page.getByText(card.title, { exact: true }).last().waitFor();
  check(
    "service list reads HTTP response instead of preview fixtures",
    (await text()).includes(card.title) && !(await text()).includes("박수빈"),
  );
  check(
    "anonymous requests contain no bearer token",
    calls.filter((c) => c.path.endsWith("/posts")).every((c) =>
      !c.headers.authorization
    ),
  );
  check(
    "search starts with product page size10",
    calls.some((c) => c.query.get("limit") === "10"),
  );
  await page.goto(`${base}/post?id=${id}`);
  await page.getByText("동행인은 로그인 후 확인할 수 있어요", { exact: true })
    .last().waitFor();
  check(
    "anonymous detail uses neutral placeholder without private DOM",
    !(await text()).includes("종합안내 데스크 앞") &&
      !(await text()).includes("박수빈"),
  );
  searchState = "failed";
  await page.goto(`${base}/explore`);
  await page.getByText(/불러오지 못했어요/).last().waitFor();
  check(
    "API failure stays distinct from empty search",
    !(await text()).includes("조건에 맞는 동행이 없어요"),
  );
  searchState = "leak";
  await page.goto(`${base}/explore`);
  await page.getByText(/불러오지 못했어요/).last().waitFor();
  check(
    "unexpected author disclosure rejects response and never enters DOM",
    !(await text()).includes("노출금지실명"),
  );
  searchState = "okay";
  await page.goto(`${base}/events`);
  await page.getByText(event.title, { exact: true }).last().waitFor();
  check(
    "real source category and region are available",
    (await text()).includes("서양음악(클래식)") &&
      (await text()).includes("서울특별시"),
  );
  await click("콘서트");
  await page.waitForTimeout(150);
  check(
    "concert choice sends server genre filter",
    calls.some((c) => c.query.get("performanceGenre") === "concert"),
  );
  await click("진행 중인 행사도 포함");
  await page.waitForTimeout(150);
  check(
    "ongoing inclusion is separate from ongoing-only",
    calls.some((c) =>
      c.query.get("includeOngoing") === "true" && !c.query.has("ongoingOnly")
    ),
  );
  await page.goto(`${base}/event?id=${id}`);
  await page.getByText("공식 운영 안내", { exact: true }).last().waitFor();
  check(
    "detail uses actual admission and optional source fields",
    (await text()).includes("무료 입장") &&
      (await text()).includes("공식 소개"),
  );
  const before = calls.length;
  await page.goto(`${base}/profile?id=${id}`);
  await page.getByText("동행인은 로그인 후 확인할 수 있어요", { exact: true })
    .last().waitFor();
  await page.goto(`${base}/ai`);
  await page.getByText("AI 탐색은 로그인 후 이용할 수 있어요", { exact: true })
    .last().waitFor();
  check(
    "anonymous profile and AI are guarded without member API calls",
    calls.length === before,
  );
  check("service mode has no runtime page errors", errors.length === 0);
  console.log(
    JSON.stringify({
      checks: checks.length,
      errors,
      apiRequests: calls.length,
      evidence:
        "local browser with synthetic HTTP responses; actual Auth/DB/provider not run",
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      body: (await text()).slice(-6000),
      errors,
      calls: calls.map((c) => ({ path: c.path, query: String(c.query) })),
    }),
  );
  throw error;
} finally {
  await browser.close();
}
