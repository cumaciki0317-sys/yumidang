import test from "node:test";
import assert from "node:assert/strict";
import { selectEvents } from "../../../backend/supabase/functions/_shared/services/event-service.ts";
import {
  addCalendarMonths,
  normalizeEventRegion,
  performanceGenreForSource,
  seoulMonthWeek,
} from "../../../backend/supabase/functions/_shared/integrations/events/normalize.ts";
import { normalizeKakaoPostalSelection } from "../../../backend/supabase/functions/_shared/integrations/places/postal.ts";
import {
  classifySeoulCultureResponse,
  createSeoulEventProvider,
  normalizeSeoulCultureItem,
} from "../../../backend/supabase/functions/_shared/integrations/events/seoul.ts";
import {
  createKopisRankingProvider,
  kopisRankingPeriod,
  parseKopisRankingXml,
  publicKopisRanking,
} from "../../../backend/supabase/functions/_shared/integrations/events/kopis-ranking.ts";
const now = new Date("2026-10-04T15:01:00Z");
const event = (id, startsOn, endsOn) => ({
  id,
  startsOn,
  endsOn,
  precision: "date",
  sourceStatus: "active",
});
test("includeOngoing은 이번 주 신규 미종료와 이전 주 진행 중 합집합", () => {
  const items = [
    event("old", "2026-09-01", "2026-10-10"),
    event("new", "2026-10-07", "2026-10-08"),
    event("ended", "2026-10-01", "2026-10-04"),
    event("later", "2026-10-15", "2026-10-16"),
  ];
  assert.deepEqual(
    selectEvents(items, { mode: "new_this_week", includeOngoing: true, now })
      .map((x) => x.id),
    ["old", "new"],
  );
  assert.deepEqual(
    selectEvents(items, { mode: "new_this_week", now }).map((x) => x.id),
    ["new"],
  );
  assert.throws(() =>
    selectEvents(items, { mode: "overlapping", includeOngoing: true, now })
  );
});
test("목요일 귀속 월별 주차·달력 한 달·공식 지역 별칭", () => {
  assert.deepEqual([
    seoulMonthWeek("2027-01-01").year,
    seoulMonthWeek("2027-01-01").month,
    seoulMonthWeek("2027-01-01").week,
  ], [2026, 12, 5]);
  assert.equal(seoulMonthWeek("2026-10-01").label, "10월 1주차");
  assert.equal(seoulMonthWeek("2026-09-01").label, "9월 1주차");
  assert.equal(addCalendarMonths("2024-03-31", -1), "2024-02-29");
  assert.equal(normalizeEventRegion("서울"), "서울특별시");
  assert.equal(normalizeEventRegion("수원"), "수원");
});
test("카카오 실제 우편번호 선택만 수용하고 추정 선택·HTML·우회필드는 공개 투영에서 제외", () => {
  const value = {
    zonecode: "12345",
    userSelectedType: "R",
    address: "서울시 가상로 1",
    roadAddress: "서울시 가상로 1",
    jibunAddress: "서울시 가상동 1",
    sido: "서울",
    sigungu: "가상구",
    bname: "가상동",
    noSelected: "N",
    secret: "exclude",
  };
  const result = normalizeKakaoPostalSelection(value);
  assert.equal(result.addressType, "road");
  assert.equal("secret" in result, false);
  for (
    const bad of [
      { ...value, noSelected: "Y" },
      { ...value, zonecode: "123" },
      { ...value, address: "<b>주소</b>" },
    ]
  ) assert.throws(() => normalizeKakaoPostalSelection(bad));
});
test("서울은 원천 상세 코드로 식별하며 HTTPS 포트가 없으면 수집하지 않는다", async () => {
  const result = normalizeSeoulCultureItem({
    TITLE: "가상행사",
    STRTDATE: "2026-10-01 00:00:00.0",
    END_DATE: "2026-10-05",
    GUNAME: "강남구",
    HMPG_ADDR:
      "https://culture.seoul.go.kr/culture/culture/cultureEvent/view.do?cultcode=12345",
  }, { provider: "seoul-open-data", collectedAt: now.toISOString() });
  assert.equal(result.sourceId, "12345");
  assert.equal(result.region, "서울특별시");
  assert.equal(result.admission.kind, "unknown");
  await assert.rejects(
    () => createSeoulEventProvider({ now: () => now }).fetchPage({ page: 1 }),
    /EVENT_PROVIDER_UNCONFIGURED/,
  );
  assert.deepEqual(
    classifySeoulCultureResponse({ RESULT: { CODE: "INFO-200" } }, 100),
    { items: [], total: 0 },
  );
  assert.throws(() =>
    classifySeoulCultureResponse({ RESULT: { CODE: "ERROR-500" } }, 100)
  );
});
const item = (rank = 1, id = "PF1", genre = "뮤지컬") =>
  `<boxof><rnum>${rank}</rnum><mt20id>${id}</mt20id><cate>${genre}</cate><prfnm>가상공연</prfnm><prfpd>2026.10.01~2026.10.10</prfpd><prfplcnm>가상극장</prfplcnm><area>서울</area></boxof>`;
const xml = (content = item(), period = "2026-09-28~2026-10-04") =>
  `<boxofs><basedate>${period}</basedate>${content}</boxofs>`;
test("KOPIS 공식 응답 기간 검증·순위 보존·공개 최소 필드", () => {
  assert.deepEqual(kopisRankingPeriod(now), {
    start: "2026-09-28",
    end: "2026-10-04",
  });
  const data = parseKopisRankingXml(
    xml(),
    "musical",
    kopisRankingPeriod(now),
    now,
  );
  assert.equal(data.items[0].region, "서울특별시");
  assert.equal(
    publicKopisRanking({ ...data, secret: "exclude" }, "musical", now).status,
    "available",
  );
  assert.equal("secret" in publicKopisRanking(data, "musical", now), false);
  assert.equal(
    publicKopisRanking(
      { ...data, periodVerification: "requested_only" },
      "musical",
      now,
    ).status,
    "unavailable",
  );
  for (
    const bad of [
      xml(item(2)),
      xml(item(1) + item(2)),
      xml(item(), "2026-09-27~2026-10-03"),
      xml(item(1, "PF1", "연극")),
      xml().replace("<basedate>", '<basedate secret="x">'),
    ]
  ) {
    assert.throws(() =>
      parseKopisRankingXml(bad, "musical", kopisRankingPeriod(now), now)
    );
  }
});
test("Top10 전국 요청은 지역을 보내지 않고 뮤지컬만 공식 GGGA 코드", async () => {
  const calls = [];
  const provider = createKopisRankingProvider({
    apiKey: "SYNTHETIC",
    timeoutMs: 1000,
    now: () => now,
    fetch: async (url, init) => {
      calls.push([new URL(url), init]);
      return new Response(xml(), { headers: { "content-type": "text/xml" } });
    },
  });
  await provider.collect("all");
  await provider.collect("musical");
  assert.equal(calls[0][0].searchParams.has("area"), false);
  assert.equal(calls[0][0].searchParams.has("catecode"), false);
  assert.equal(calls[1][0].searchParams.get("catecode"), "GGGA");
  assert.equal(calls[0][1].redirect, "error");
});

test("확정 콘서트 범위3장르, 뮤지컬/연극의 원천 대응만 사용", () => {
  for (const genre of ["대중음악", "서양음악(클래식)", "한국음악(국악)"]) {
    assert.equal(performanceGenreForSource("kopis", genre), "concert");
  }
  assert.equal(performanceGenreForSource("kopis", "뮤지컬"), "musical");
  assert.equal(performanceGenreForSource("kopis", "연극"), "play");
  assert.equal(performanceGenreForSource("kopis", "복합"), null);
  assert.equal(performanceGenreForSource("seoul-open-data", "뮤지컬"), null);
});

test("세종의 공식 빈 시군구는 수용하며 다른 시도/누락 시군구는 거절", () => {
  const selected = {
    zonecode: "12345",
    userSelectedType: "R",
    noSelected: "N",
    address: "가상로 1",
    roadAddress: "가상로 1",
    sido: "세종특별자치시",
    sigungu: "",
    bname: "가상동",
  };
  assert.equal(normalizeKakaoPostalSelection(selected).district, "");
  assert.equal(
    normalizeKakaoPostalSelection({ ...selected, sido: "세종" }).district,
    "",
  );
  assert.throws(() =>
    normalizeKakaoPostalSelection({ ...selected, sido: "서울" })
  );
  assert.throws(() =>
    normalizeKakaoPostalSelection({ ...selected, sigungu: undefined })
  );
});

test("첫 줄 기본주소와 다른 두 번째 지번주소를 선택해도 공식 실제 선택을 사용", () => {
  const result = normalizeKakaoPostalSelection({
    zonecode: "12345",
    userSelectedType: "J",
    noSelected: "N",
    address: "서울시 도로명 1",
    roadAddress: "서울시 도로명 1",
    jibunAddress: "서울시 법정동 2",
    sido: "서울",
    sigungu: "가상구",
    bname: "법정동",
  });
  assert.equal(result.address, "서울시 법정동 2");
  assert.equal(result.addressType, "jibun");
});
