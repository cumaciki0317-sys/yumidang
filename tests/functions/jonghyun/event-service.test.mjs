import assert from "node:assert/strict";
import test from "node:test";
import { selectDateOnlyEvents, selectEvents, eventStateAt } from "../../../backend/supabase/functions/_shared/services/event-service.ts";
import {
  parseCalendarDate, seoulCalendarDate, seoulWeekWindow, parseEventInstant, eventInterval,
} from "../../../backend/supabase/functions/_shared/integrations/events/normalize.ts";
import { createEventProviderAdapter, unconfiguredEventProvider } from "../../../backend/supabase/functions/_shared/integrations/events/adapter.ts";
import { queryStoredEvents, syncEventPage, matchesEventKeyword } from "../../../backend/supabase/functions/_shared/db/repositories/events.ts";

const now = new Date("2026-10-01T03:00:00Z");
const dateEvent = (id, startsOn, endsOn, sourceStatus = "active") => ({ id, precision: "date", startsOn, endsOn, sourceStatus });
const timedEvent = (id, startsAt, endsAt, sourceStatus = "active") => ({ id, precision: "instant", startsAt, endsAt, sourceStatus });
const ids = (events) => events.map((event) => event.id);
const events = [
  dateEvent("old-long", "2026-09-20", "2026-10-20"),
  dateEvent("new-active", "2026-10-01", "2026-10-04"),
  dateEvent("new-ended", "2026-09-28", "2026-09-29"),
  dateEvent("friday-end", "2026-09-20", "2026-10-02"),
  dateEvent("future", "2026-10-08", "2026-10-10"),
];
const list = (items, options = {}) => selectEvents(items, { mode: "overlapping", now, ...options });

test("이번 주 신규는 한국 월요일 주간의 시작일로 판정하고 이미 끝난 행사는 숨긴다", () => {
  assert.deepEqual(ids(selectEvents(events, { mode: "new_this_week", now })), ["new-active"]);
  assert.deepEqual(seoulWeekWindow("2026-10-01"), { monday: "2026-09-28", nextMonday: "2026-10-05" });
});

test("한국 월요일 자정과 연도 경계에서 주간을 계산한다", () => {
  assert.equal(seoulCalendarDate(new Date("2026-10-04T14:59:59Z")), "2026-10-04");
  assert.equal(seoulCalendarDate(new Date("2026-10-04T15:00:00Z")), "2026-10-05");
  assert.deepEqual(seoulWeekWindow("2026-10-05"), { monday: "2026-10-05", nextMonday: "2026-10-12" });
  assert.deepEqual(seoulWeekWindow("2027-01-01"), { monday: "2026-12-28", nextMonday: "2027-01-04" });
});

test("날짜 기간 겹침은 종료 날짜를 포함하고 금요일 종료 행사를 주말에서 제외한다", () => {
  assert.deepEqual(ids(list(events, { period: { start: "2026-10-03", end: "2026-10-04" } })), ["new-active", "old-long"]);
  assert.deepEqual(ids(list(events, { period: { start: "2026-10-02", end: "2026-10-02" } })), ["new-active", "friday-end", "old-long"]);
});

test("공고 선택은 진행 중·예정만 허용하고 신규 주간을 강제하지 않는다", () => {
  const selected = selectEvents(events, { mode: "post_selection", now: new Date("2026-10-02T03:00:00Z") });
  assert.deepEqual(ids(selected), ["new-active", "friday-end", "old-long", "future"]);
});

test("일반 목록은 종료 행사도 포함하고 진행 중·예정·종료 순서로 정렬한다", () => {
  const selected = list(events);
  assert.deepEqual(ids(selected), ["new-active", "friday-end", "old-long", "future", "new-ended"]);
  assert.deepEqual(ids(events), ["old-long", "new-active", "new-ended", "friday-end", "future"]);
});

test("진행 중만은 현재 시점 기준이며 선택한 과거 기간을 지우지 않는다", () => {
  assert.deepEqual(ids(list(events, { ongoingOnly: true })), ["new-active", "friday-end", "old-long"]);
  assert.deepEqual(list(events, { ongoingOnly: true, period: { start: "2026-09-01", end: "2026-09-10" } }), []);
  assert.deepEqual(ids(list(events, { period: { start: "2026-09-28", end: "2026-09-29" } })), ["friday-end", "old-long", "new-ended"]);
});

test("그룹 내부는 최근 시작·빠른 예정·최근 종료 순이며 같은 시각은 ID 순이다", () => {
  const sorted = list([
    dateEvent("future-late", "2026-12-01", "2026-12-02"),
    dateEvent("ended-old", "2026-07-01", "2026-07-02"),
    dateEvent("future-early", "2026-11-01", "2026-11-02"),
    dateEvent("ended-new", "2026-08-01", "2026-08-02"),
    dateEvent("ongoing-b", "2026-10-01", "2026-10-05"),
    dateEvent("ongoing-a", "2026-10-01", "2026-10-05"),
    dateEvent("ongoing-old", "2026-09-01", "2026-12-05"),
  ]);
  assert.deepEqual(ids(sorted), ["ongoing-a", "ongoing-b", "ongoing-old", "future-early", "future-late", "ended-new", "ended-old"]);
});

test("날짜 종료일 전체를 포함하고 다음 한국 자정부터 종료로 처리한다", () => {
  const event = dateEvent("last-day", "2026-10-01", "2026-10-02");
  assert.equal(eventStateAt(event, new Date("2026-10-02T14:59:59.999Z")), "ongoing");
  assert.equal(eventStateAt(event, new Date("2026-10-02T15:00:00Z")), "ended");
  assert.equal(eventStateAt(event, new Date("2026-09-30T14:59:59.999Z")), "upcoming");
  assert.equal(eventStateAt(event, new Date("2026-09-30T15:00:00Z")), "ongoing");
});

test("시각 행사 종료는 배타적이며 다른 offset도 같은 절대 시각으로 비교한다", () => {
  const event = timedEvent("timed", "2026-10-01T10:00:00+09:00", "2026-10-01T15:00:00+09:00");
  assert.equal(eventStateAt(event, new Date("2026-10-01T05:59:59.999Z")), "ongoing");
  assert.equal(eventStateAt(event, new Date("2026-10-01T06:00:00Z")), "ended");
  assert.deepEqual(eventInterval(event), eventInterval(timedEvent("utc", "2026-10-01T01:00:00Z", "2026-10-01T06:00:00Z")));
  assert.deepEqual(selectEvents([event], { mode: "new_this_week", now: new Date("2026-10-01T06:00:00Z") }), []);
});

test("시각 행사와 날짜 기간은 양끝 경계에서 정확히 겹친다", () => {
  const selected = list([
    timedEvent("ended-at-start", "2026-10-01T00:00:00+09:00", "2026-10-03T00:00:00+09:00"),
    timedEvent("starts-at-end", "2026-10-05T00:00:00+09:00", "2026-10-05T01:00:00+09:00"),
    timedEvent("overlap", "2026-10-04T23:59:00+09:00", "2026-10-05T00:00:00+09:00"),
  ], { period: { start: "2026-10-03", end: "2026-10-04" } });
  assert.deepEqual(ids(selected), ["overlap"]);
});

test("시각의 주간 판정도 한국 월요일을 기준으로 한다", () => {
  const items = [
    timedEvent("before-week", "2026-09-27T14:59:59Z", "2026-10-03T00:00:00Z"),
    timedEvent("at-week", "2026-09-27T15:00:00Z", "2026-10-03T00:00:00Z"),
    timedEvent("next-week", "2026-10-04T15:00:00Z", "2026-10-05T00:00:00Z"),
  ];
  assert.deepEqual(ids(selectEvents(items, { mode: "new_this_week", now })), ["at-week"]);
});

test("취소 행사는 모든 새 조회·선택에서 숨긴다", () => {
  const cancelled = dateEvent("cancelled", "2026-10-01", "2026-10-30", "cancelled");
  for (const mode of ["new_this_week", "overlapping", "post_selection"]) {
    assert.deepEqual(selectEvents([cancelled], { mode, now }), []);
  }
});

test("누락/알 수 없는 상태·정밀도는 임의로 활성 행사로 바꾸지 않는다", () => {
  assert.throws(() => list([dateEvent("unknown", "2026-10-01", "2026-10-03", "unknown")]), /UNSUPPORTED_EVENT_SOURCE_STATUS/);
  assert.throws(() => list([{ id: "missing", precision: "date", startsOn: "2026-10-01", endsOn: "2026-10-03" }]), /UNSUPPORTED_EVENT_SOURCE_STATUS/);
  assert.throws(() => list([{ id: "unknown", sourceStatus: "active", precision: "maybe" }]), /UNSUPPORTED_EVENT_PRECISION/);
});

test("잘못된 날짜·시각·역전된 기간·시간대 누락은 결과 없음으로 숨기지 않는다", () => {
  assert.throws(() => parseCalendarDate("2026-02-30"), /INVALID_EVENT_DATE/);
  assert.equal(parseCalendarDate("2028-02-29").toISOString().slice(0, 10), "2028-02-29");
  for (const invalid of ["2026-10-01T10:00:00", "2026-10-01T24:00:00Z", "2026-10-01T10:60:00Z", "2026-10-01T10:00:00+24:00"]) {
    assert.throws(() => parseEventInstant(invalid), /INVALID_EVENT_INSTANT/);
  }
  assert.throws(() => parseEventInstant("2026-10-01T10:00:00-00:00"), /UNKNOWN_EVENT_TIMEZONE/);
  assert.throws(() => parseEventInstant("2026-02-30T10:00:00Z"), /INVALID_EVENT_DATE/);
  assert.throws(() => list([timedEvent("reversed", "2026-10-02T00:00:00Z", "2026-10-01T00:00:00Z")]), /INVALID_EVENT_PERIOD/);
  assert.throws(() => list(events, { period: { start: "2026-10-04", end: "2026-10-03" } }), /INVALID_QUERY_PERIOD/);
  assert.throws(() => list(events, { now: new Date(NaN) }), /INVALID_NOW/);
  assert.throws(() => list(events, { mode: "invented" }), /INVALID_EVENT_MODE/);
  assert.throws(() => list(events, { ongoingOnly: "true" }), /INVALID_EVENT_FILTER/);
});

test("날짜 전용 helper도 확정 정렬과 명시 now를 사용한다", () => {
  const dateOnly = events.map(({ id, startsOn, endsOn }) => ({ id, startsOn, endsOn }));
  assert.deepEqual(ids(selectDateOnlyEvents(dateOnly, { mode: "overlapping", now })), ids(list(events)));
  assert.deepEqual(selectDateOnlyEvents([{ ...dateOnly[0], sourceStatus: "cancelled" }], { mode: "overlapping", now }), []);
});

const sourceRecord = (provider, sourceId) => ({
  provider, sourceId, sourceStatus: "active", precision: "date", startsOn: "2026-10-01", endsOn: "2026-10-04",
  title: "가상 전시", category: null, region: null, placeName: null, publicAddress: null,
  admission: { kind: "unknown" }, sourceUrl: "https://example.invalid/event", collectedAt: now.toISOString(),
});
function memoryRepository() {
  const stored = new Map();
  return {
    stored,
    async upsertBySourceIdentity(items) {
      for (const item of items) {
        const key = JSON.stringify([item.provider, item.sourceId]);
        stored.set(key, { ...item, id: key });
      }
      return { savedCount: items.length };
    },
    async listCandidates() { return [...stored.values()]; },
  };
}

test("주입 어댑터는 수집 문맥을 검증하며 비용 누락을 무료로 바꾸지 않는다", async () => {
  const provider = createEventProviderAdapter({
    provider: "synthetic",
    transport: { async fetchPage() { return { items: ["source-1"], nextCursor: "next" }; } },
    normalize: (sourceId, context) => ({ ...sourceRecord(context.provider, sourceId), collectedAt: context.collectedAt }),
    now: () => now,
  });
  const page = await provider.fetchPage({});
  assert.equal(page.events[0].admission.kind, "unknown");
  assert.equal(page.nextCursor, "next");
  assert.equal(page.events[0].collectedAt, now.toISOString());
});

test("동일 제공처 원천 ID 재수집은 갱신하며 다른 제공처의 같은 ID는 보존한다", async () => {
  const repository = memoryRepository();
  const provider = (name, title) => ({ provider: name, async fetchPage() { return { events: [{ ...sourceRecord(name, "1"), title }] }; } });
  await syncEventPage(provider("a", "처음 제목"), repository, {});
  await syncEventPage(provider("a", "바뀐 제목"), repository, {});
  await syncEventPage(provider("b", "바뀐 제목"), repository, {});
  assert.equal(repository.stored.size, 2);
  const results = await queryStoredEvents(repository, { mode: "overlapping", now });
  assert.deepEqual(results.map((item) => item.title), ["바뀐 제목", "바뀐 제목"]);
});

test("제공처 문맥 불일치·정규화 실패·취소 요청은 저장하지 않는다", async () => {
  let writes = 0;
  const repository = { async upsertBySourceIdentity() { writes++; return { savedCount: 0 }; }, async listCandidates() { return []; } };
  const mismatch = { provider: "a", async fetchPage() { return { events: [sourceRecord("b", "1")] }; } };
  await assert.rejects(syncEventPage(mismatch, repository, {}), /EVENT_PROVIDER_CONTEXT_MISMATCH/);
  const invalid = { provider: "a", async fetchPage() { return { events: [sourceRecord("a", "1"), { ...sourceRecord("a", "2"), title: "<script>bad</script>" }] }; } };
  await assert.rejects(syncEventPage(invalid, repository, {}), /INVALID_EVENT_PUBLIC_TEXT/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(syncEventPage(mismatch, repository, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(writes, 0);
});

test("미연결 제공사는 정상 빈 목록으로 위장하지 않는다", async () => {
  await assert.rejects(unconfiguredEventProvider("kopis").fetchPage({}), /EVENT_PROVIDER_NOT_CONFIGURED/);
});


test("저장 행사 조회는 정규화 지역·종류의 정확한 일치와 시간 조건을 함께 적용한다", async () => {
  const repository = memoryRepository();
  await repository.upsertBySourceIdentity([
    { ...sourceRecord("synthetic", "a"), region: "서울", category: "전시", startsOn: "2026-09-29" },
    { ...sourceRecord("synthetic", "b"), region: "서울", category: "전시" },
    { ...sourceRecord("synthetic", "c"), region: "서울", category: "공연" },
    { ...sourceRecord("synthetic", "d"), region: "부산", category: "전시" },
    { ...sourceRecord("synthetic", "e"), region: "서울", category: "전시", startsOn: "2026-10-08", endsOn: "2026-10-10" },
    sourceRecord("synthetic", "unknown-metadata"),
  ]);
  const query = { mode: "overlapping", now, region: "서울", category: "전시", ongoingOnly: true };
  const selected = await queryStoredEvents(repository, query);
  assert.deepEqual(selected.map((event) => event.sourceId), ["b", "a"]);
  assert.deepEqual(await queryStoredEvents(repository, { ...query, region: " 서울 " }), []);
  assert.equal((await queryStoredEvents(repository, { mode: "overlapping", now, category: "전시" })).length, 4);
  assert.equal((await queryStoredEvents(repository, { mode: "overlapping", now })).length, 6);
});

test("미지원 행사 필터·잘못된 지역/종류는 DB 호출 전에 거절한다", async () => {
  let called = 0;
  const repository = { async listCandidates() { called++; return []; } };
  const invalidQueries = [
    { keyword: "전시" }, { radius: 10 }, { region: 123 }, { category: " " }, { query: null }, { query: 123 },
    { period: { start: "2026-10-01", end: "2026-10-03", timezone: "UTC" } },
  ];
  for (const filter of invalidQueries) {
    await assert.rejects(queryStoredEvents(repository, { mode: "overlapping", now, ...filter }), /UNSUPPORTED_EVENT_FILTER|INVALID_EVENT_FILTER|INVALID_QUERY_PERIOD|INVALID_EVENT_QUERY/);
  }
  assert.equal(called, 0);
});

test("시간만 가진 helper는 지역·종류·키워드 필터를 조용히 무시하지 않는다", () => {
  for (const filter of [{ region: "서울" }, { category: "전시" }, { keyword: "전시" }, { query: "전시" }]) {
    assert.throws(() => list(events, filter), /UNSUPPORTED_EVENT_FILTER/);
  }
});


test("행사 검색어는 행사명·장소명·공개 주소 한 필드에서 부분 일치하며 대소문자·연속 공백을 무시한다", () => {
  const fields = {
    title: "여름 전시", placeName: "ART  Hall", publicAddress: "서울 종로구 새문안로",
    description: "비공개 소개", exact_location: "3층 좌석", privateAddress: "비공개 만남 주소",
  };
  for (const keyword of ["여름", "전시", "art hall", "ART    HALL", "  Art\t Hall ", "새문안로"]) {
    assert.equal(matchesEventKeyword(fields, keyword), true, keyword);
  }
  for (const keyword of ["전시 Art", "비공개 소개", "3층 좌석", "비공개 만남 주소", "없는 이름"]) {
    assert.equal(matchesEventKeyword(fields, keyword), false, keyword);
  }
  assert.equal(matchesEventKeyword({ title: "전시", placeName: null, publicAddress: null }, "전시"), true);
  assert.equal(matchesEventKeyword({ title: "전시", placeName: null, publicAddress: null }, "장소"), false);
  assert.throws(() => matchesEventKeyword({ title: "전시", placeName: 123 }, "전시"), /INVALID_EVENT_SEARCH_INDEX/);
});

test("행사 검색어·기간·지역·종류·진행 중 필터를 교집합으로 적용하고 결과 정렬을 유지한다", async () => {
  const repository = memoryRepository();
  const common = { ...sourceRecord("synthetic", "base"), region: "서울", category: "전시", placeName: "Art Hall" };
  await repository.upsertBySourceIdentity([
    { ...common, sourceId: "older", startsOn: "2026-09-29" },
    { ...common, sourceId: "recent" },
    { ...common, sourceId: "wrong-region", region: "부산" },
    { ...common, sourceId: "wrong-category", category: "공연" },
    { ...common, sourceId: "future", startsOn: "2026-10-02", endsOn: "2026-10-04" },
    { ...common, sourceId: "outside-period", startsOn: "2026-09-28", endsOn: "2026-09-29" },
    { ...common, sourceId: "unmatched", placeName: null },
  ]);
  const selected = await queryStoredEvents(repository, {
    mode: "overlapping", now, query: "  ART   hall ", region: "서울", category: "전시", ongoingOnly: true,
    period: { start: "2026-10-01", end: "2026-10-03" },
  });
  assert.deepEqual(selected.map((event) => event.sourceId), ["recent", "older"]);
});

test("빈 행사 검색어는 다른 필터를 유지하고 저장소에는 정규화된 검색어를 전달한다", async () => {
  let observed;
  const repository = {
    async listCandidates(query) {
      observed = query;
      return [
        { ...sourceRecord("synthetic", "chosen"), id: "chosen", region: "서울", category: "전시", placeName: "Art Hall" },
        { ...sourceRecord("synthetic", "other"), id: "other", region: "부산", category: "전시" },
      ];
    },
  };
  const filter = { mode: "overlapping", now, region: "서울", category: "전시", ongoingOnly: true };
  for (const keyword of [undefined, "", "   \t\n"]) {
    const selected = await queryStoredEvents(repository, { ...filter, query: keyword });
    assert.deepEqual(selected.map((event) => event.id), ["chosen"]);
    assert.equal(observed.query, "");
  }
  await queryStoredEvents(repository, { ...filter, query: "  ART   HALL  " });
  assert.equal(observed.query, "art hall");
});
