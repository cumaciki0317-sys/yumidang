import assert from "node:assert/strict";
import test from "node:test";
import {
  clearEventPatch, eventDraftError, manualEventError, manualEventPatch,
  previewEventError, safeManualEvent, selectedEventPatch,
} from "../../apps/mobile/src/presentation/events/event-draft.ts";
import type { EventItem, ManualEvent } from "../../apps/mobile/src/types.ts";

const manual: ManualEvent = { title: "주말 취미 합주 공연", placeName: "", publicAddress: "", publicAddressConfirmed: false };
const event: EventItem = { id: "event-1", title: "합성 행사", category: "공연", placeName: "문화센터", publicArea: "서울", startsAt: 100, endsAt: 200, image: "", price: "", sourceName: "합성", description: "" };

test("direct input requires only a title; venue/address are optional", () => {
  assert.equal(manualEventError(manual), null);
  assert.ok(manualEventError({ ...manual, title: " " }));
  assert.equal(manualEventError({ ...manual, placeName: "○○공방" }), null);
});

test("public address requires explicit public-venue confirmation and permits omission", () => {
  assert.ok(manualEventError({ ...manual, publicAddress: "서울 종로구 세종대로 175" }));
  assert.equal(manualEventError({ ...manual, publicAddress: "서울 종로구 세종대로 175", publicAddressConfirmed: true }), null);
  assert.equal(manualEventError({ ...manual, publicAddress: "" }), null);
});

test("existing sensitive-input checks apply to event title, venue and public address", () => {
  for (const key of ["title", "placeName", "publicAddress"]) {
    assert.ok(manualEventError({ ...manual, [key]: "문의 010-1234-5678", publicAddressConfirmed: true }));
  }
  assert.ok(manualEventError({ ...manual, title: "<script>문자</script>" }));
});

test("restored unknown shape or unconfirmed public text is never display-approved", () => {
  for (const value of [null, [], "공연", {}, { title: "공연" }, { ...manual, publicAddressConfirmed: "yes" }]) {
    assert.ok(manualEventError(value));
    assert.equal(safeManualEvent(value), null);
  }
  assert.equal(safeManualEvent(undefined), null);
});

test("switching source/direct/none clears the other relation without changing meeting fields", () => {
  const draft = { eventId: "old", startsAt: "2026-11-10T10:00", title: "공고 제목", manualEvent: undefined as ManualEvent | undefined };
  const direct = { ...draft, ...manualEventPatch(manual) };
  assert.equal(direct.eventId, undefined);
  assert.equal(direct.manualEvent?.title, manual.title);
  const selected = { ...direct, ...selectedEventPatch("new") };
  assert.equal(selected.eventId, "new");
  assert.equal(selected.manualEvent, undefined);
  const cleared = { ...selected, ...clearEventPatch() };
  assert.equal(cleared.eventId, undefined);
  assert.equal(cleared.manualEvent, undefined);
  assert.equal(cleared.startsAt, draft.startsAt);
  assert.equal(cleared.title, draft.title);
});

test("direct input and source link cannot coexist and JSON draft roundtrip preserves direct info", () => {
  assert.ok(eventDraftError({ eventId: "event-1", manualEvent: manual }));
  const restored = JSON.parse(JSON.stringify({ ...manualEventPatch(manual), eventSectionPosition: "bottom" }));
  assert.equal(eventDraftError(restored), null);
  assert.deepEqual(safeManualEvent(restored.manualEvent), manual);
  assert.equal(restored.eventSectionPosition, "bottom");
});

test("preview eligibility checks event existence and end, never meeting date overlap", () => {
  const outsideMeeting = { eventId: event.id, startsAt: "2099-01-01T10:00", endsAt: "2099-01-01T12:00" };
  assert.equal(previewEventError(outsideMeeting, [event], 150), null);
  assert.ok(previewEventError({ eventId: event.id }, [event], 200));
  assert.ok(previewEventError({ eventId: "missing" }, [event], 150));
  assert.equal(previewEventError({ manualEvent: manual }, [], 150), null);
});
