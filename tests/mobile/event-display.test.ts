import assert from "node:assert/strict";
import test from "node:test";
import {
  eventAdmissionLabel, eventCategoryLabel, eventDateLabel,
  eventLocationLabel, eventStatusLabel, eventProviderLabel,
  type EventDisplayInput,
} from "../../apps/mobile/src/presentation/events/event-display.ts";

const fixture: EventDisplayInput = {
  title: "합성 행사", category: null, region: null, placeName: null,
  publicAddress: null, state: "upcoming", sourceStatus: "active",
  admission: { kind: "unknown" }, provider: "kopis",
  collectedAt: "2026-10-20T00:00:00Z", precision: "date",
  startsOn: "2026-10-24", endsOn: "2026-10-24",
};

test("period labels distinguish a day, same-year and cross-year ranges", () => {
  assert.equal(eventDateLabel(fixture), "2026.10.24");
  assert.equal(eventDateLabel({ ...fixture, endsOn: "2026-10-25" }), "2026.10.24 ~ 10.25");
  assert.equal(eventDateLabel({ ...fixture, endsOn: "2027-01-10" }), "2026.10.24 ~ 2027.01.10");
});

test("instant dates use Korea calendar date instead of UTC or device timezone", () => {
  const { startsOn: _start, endsOn: _end, ...common } = fixture;
  assert.equal(eventDateLabel({ ...common, precision: "instant", startsAt: "2026-10-24T15:30:00Z", endsAt: "2026-10-24T16:30:00Z" }), "2026.10.25");
});

test("unknown fee never becomes free and mixed prices never become a single amount", () => {
  assert.equal(eventAdmissionLabel({ kind: "unknown" }), "요금 정보 없음");
  assert.equal(eventAdmissionLabel({ kind: "free" }), "무료");
  assert.equal(eventAdmissionLabel({ kind: "described", text: "무료" }), "무료");
  assert.equal(eventAdmissionLabel({ kind: "described", text: " 무료 " }), "무료");
  assert.equal(eventAdmissionLabel({ kind: "described", text: "10,000원" }), "입장료 10,000원");
  for (const text of ["성인 10,000원·청소년 5,000원", "일부 무료·체험 유료", "무료(체험 유료)", "10,000원~", "예매처 확인"]) {
    assert.equal(eventAdmissionLabel({ kind: "described", text }), "요금 상세 확인");
  }
  assert.equal(eventAdmissionLabel({ kind: "described", text: " " }), "요금 정보 없음");
});

test("provider labels match actual source namespaces and retain unknown source names", () => {
  assert.equal(eventProviderLabel("kopis"), "KOPIS");
  assert.equal(eventProviderLabel("tour-api"), "한국관광공사 TourAPI");
  assert.equal(eventProviderLabel("seoul-open-data"), "서울 열린데이터");
  assert.equal(eventProviderLabel("new-provider"), "new-provider");
});

test("source cancellation overrides period while unknown source does not mean cancellation", () => {
  assert.equal(eventStatusLabel({ state: "ongoing", sourceStatus: "cancelled" }), "행사 취소");
  assert.equal(eventStatusLabel({ state: "ongoing", sourceStatus: "unknown" }), "행사 정보 확인 필요");
  assert.equal(eventStatusLabel({ state: "ended", sourceStatus: "active" }), "종료");
});

test("category names only use agreed equivalences; broad and missing classifications stay broad", () => {
  assert.equal(eventCategoryLabel("서양음악(클래식)"), "클래식");
  assert.equal(eventCategoryLabel("한국음악(국악)"), "국악");
  assert.equal(eventCategoryLabel("무용(서양/한국무용)"), "무용");
  assert.equal(eventCategoryLabel("행사/공연/축제"), "행사");
  assert.equal(eventCategoryLabel(null), "행사");
  assert.equal(eventCategoryLabel("음악이 있는 밤"), "음악이 있는 밤");
});

test("location fallback never substitutes an address for a venue", () => {
  assert.equal(eventLocationLabel({ region: "서울 종로구", placeName: "세종문화회관" }), "서울 종로구 · 세종문화회관");
  assert.equal(eventLocationLabel({ region: "서울", placeName: null }), "서울 · 행사장 정보 없음");
  assert.equal(eventLocationLabel({ region: null, placeName: "문화센터" }), "문화센터");
  assert.equal(eventLocationLabel({ region: null, placeName: null }), "장소 정보 확인 필요");
});
