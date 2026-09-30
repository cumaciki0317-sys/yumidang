// 행사 AI 탐색 포트·링크 없는 행사 카드(Q4-A)·일부 결과(Q1-A) 가상 검사. 저장소·모델은 주입값이다.
import test from "node:test";
import assert from "node:assert/strict";
import { createEventDiscovery, eventQueryFromFilters, toAiEventCard } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/event-discovery.ts";
import { projectCards } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/result-builder.ts";
import { runChat } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/orchestrator.ts";

const item = (n, extra = {}) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, provider: "kopis", sourceId: "PF" + n, sourceStatus: "active",
  title: "가상 공연 " + n, category: "연극", region: "서울특별시", placeName: "가상 극장", publicAddress: null,
  admission: { kind: "unknown" }, sourceUrl: null, collectedAt: "2026-10-01T00:00:00.000Z", precision: "date",
  startsOn: "2026-10-05", endsOn: "2026-10-11", state: "upcoming", ...extra });
function source(items, pageSize) {
  const calls = [];
  return { calls, async listPage(query, cursor, limit) {
    calls.push({ query, cursor, limit });
    const start = cursor ? Number(cursor) : 0;
    const page = items.slice(start, start + limit);
    return { events: page, nextCursor: start + limit < items.length ? String(start + limit) : null };
  } };
}
const limits = { pageSize: 2, maxSearchPages: 5, recheckMaxPages: 5, maxResultCards: 10 };

test("저장소 순서·조회 모드를 그대로 쓰고, 기간은 한국 달력 날짜(양 끝 포함)로 전달", async () => {
  assert.deepEqual(eventQueryFromFilters({ target: "events", query: "공연", newThisWeek: true },
    { startsAt: "2026-10-10T00:00:00+09:00", endsAt: "2026-10-12T00:00:00+09:00" }),
    { mode: "new_this_week", query: "공연", period: { start: "2026-10-10", end: "2026-10-11" } });
  const s = source([item(1), item(2), item(3)]);
  const port = createEventDiscovery({ source: s, limits });
  const found = await port.search({ filters: { target: "events" }, now: new Date() });
  assert.equal(found.coverage, "exhausted");
  assert.deepEqual(found.cards.map((c) => c.title), ["가상 공연 1", "가상 공연 2", "가상 공연 3"]);
  assert.equal(s.calls.length, 2);
});

test("공식 링크가 없는 KOPIS 행사: sourceUrl null + 출처 이름 KOPIS, 입장료 미상은 무료로 표시하지 않음", () => {
  const card = toAiEventCard(item(1));
  assert.deepEqual([card.sourceUrl, card.sourceName, card.costLabel, card.canApply], [null, "KOPIS", "입장료 정보 없음", false]);
  const projected = projectCards([card], { target: "events" });
  assert.equal(projected[0].sourceUrl, null);
  assert.equal(projected[0].sourceName, "KOPIS");
  assert.throws(() => projectCards([{ ...card, sourceName: undefined }], { target: "events" }), /MISSING_EVENT_SOURCE/);
  assert.throws(() => projectCards([{ ...card, sourceUrl: "javascript:alert(1)" }], { target: "events" }), /INVALID_EVENT_SOURCE/);
  assert.throws(() => toAiEventCard(item(2, { provider: "unknown-provider" })), /UNKNOWN_EVENT_SOURCE/);
});

test("행사도 한도에 닿으면 찾은 카드를 partial로 보여주고, 0건이면 unavailable", async () => {
  const model = { async generate() { return { value: { status: "search", filters: { target: "events", query: "공연" } }, modelVersion: "fake", usage: null }; } };
  const chatLimits = { maxMessages: 5, maxMessageChars: 200, maxTotalChars: 500, maxOutputTokens: 50 };
  const input = { clientRequestId: "r", messages: [{ role: "user", content: "공연 찾아줘" }], currentFilters: { target: "events" } };
  const principal = { userId: "u1" };
  const noPosts = { async search() { throw new Error("no"); }, async recheck() { throw new Error("no"); } };
  const limited = createEventDiscovery({ source: source([item(1), item(2), item(3)]), limits: { ...limits, maxSearchPages: 1 } });
  const r = await runChat(input, principal, { model, discovery: noPosts, events: limited, limits: chatLimits, now: () => new Date("2026-10-01T00:00:00Z") }, "req");
  assert.equal(r.status, "results"); assert.equal(r.partial, true); assert.equal(r.cards.length, 2);
  assert.match(r.notice, /일부만 확인/);
  const empty = createEventDiscovery({ source: { async listPage() { return { events: [], nextCursor: "2" }; } }, limits: { ...limits, maxSearchPages: 1 } });
  const e = await runChat(input, principal, { model, discovery: noPosts, events: empty, limits: chatLimits, now: () => new Date("2026-10-01T00:00:00Z") }, "req");
  assert.equal(e.status, "unavailable"); assert.equal(e.partial, undefined);
});
