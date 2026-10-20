import assert from "node:assert/strict";
import test from "node:test";
import { canSelectEvent, eventCreateReturnPath, eventSelectionQuery, eventSelectionUnavailableLabel } from "../../apps/mobile/src/presentation/events/event-selection.ts";

test("selection queries cover all available dates with optional keyword only", () => {
  assert.deepEqual(eventSelectionQuery(""), { mode: "post_selection" });
  assert.deepEqual(eventSelectionQuery("  가을 공연  "), { mode: "post_selection", query: "가을 공연" });
  assert.deepEqual(eventSelectionQuery("  "), { mode: "post_selection" });
});

test("only active upcoming and ongoing DTO events can be newly selected", () => {
  for (const state of ["upcoming", "ongoing"]) assert.equal(canSelectEvent({ sourceStatus: "active", state }), true);
  for (const sourceStatus of ["cancelled", "unknown", "missing", ""]) {
    assert.equal(canSelectEvent({ sourceStatus, state: "upcoming" }), false);
  }
  assert.equal(canSelectEvent({ sourceStatus: "active", state: "ended" }), false);
  assert.equal(canSelectEvent({ sourceStatus: "active", state: "invalid" }), false);
});

test("unavailable selection labels distinguish official cancellation and ended events", () => {
  assert.equal(eventSelectionUnavailableLabel({ sourceStatus: "cancelled", state: "ended" }), "취소된 행사예요");
  assert.equal(eventSelectionUnavailableLabel({ sourceStatus: "active", state: "ended" }), "종료된 행사예요");
  assert.equal(eventSelectionUnavailableLabel({ sourceStatus: "unknown", state: "upcoming" }), "현재 연결할 수 없는 행사예요");
});

test("login return path preserves the selected event in a fixed local create route", () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const url = new URL(eventCreateReturnPath(id), "https://local.invalid");
  assert.equal(url.pathname, "/create");
  assert.equal(url.searchParams.get("id"), `event:${id}`);
  const unexpected = new URL(eventCreateReturnPath("x&returnPath=https://evil.invalid"), "https://local.invalid");
  assert.equal(unexpected.searchParams.size, 1);
  assert.equal(unexpected.pathname, "/create");
});
