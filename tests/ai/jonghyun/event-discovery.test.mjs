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
  const input = { clientRequestId: "r", messages: [{ role: "user", content: "공연 찾아줘" }], currentFilters: { target: "events", region: "서울특별시" } };
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

test("서울 원천 카드의 출처 이름·비신청 상태와 진행 중 포함·콘서트 그룹을 전달한다", () => {
  const card = toAiEventCard(item(1, { provider: "seoul-open-data", sourceId: "seoul-1" }));
  assert.equal(card.sourceName, "서울 열린데이터광장"); assert.equal(card.canApply, false);
  assert.deepEqual(eventQueryFromFilters({ target: "events", includeOngoing: true, performanceGenre: "concert" }),
    { mode: "new_this_week", includeOngoing: true, performanceGenre: "concert" });
});

test("무료 행사만 DB 조건으로 전달하며 미확인 입장료와 유료 추정 조건으로 조회하지 않는다", () => {
  assert.deepEqual(eventQueryFromFilters({ target: "events", cost: "free" }), { mode: "overlapping", freeOnly: true });
  assert.throws(() => eventQueryFromFilters({ target: "events", cost: "paid" }), /UNSUPPORTED_FILTER/);
});

test("행사 재조회도 확인한 부분집합을 반환하고 확인하지 못한 카드를 넣지 않는다", async () => {
  const items = [1, 2, 3].map(n => item(n));
  const discovery = createEventDiscovery({ source: source(items), limits: { ...limits, recheckMaxPages: 1 } });
  const result = await discovery.recheck({ principal: { userId: "synthetic" }, filters: { target: "events" }, now: new Date(),
    cards: items.map(event => ({ kind: "event", id: event.id })) });
  assert.equal(result.complete, false); assert.deepEqual(result.cards.map(card => card.id), items.slice(0, 2).map(event => event.id));
});

test("무료 조건을 무시한 저장소 응답을 후단 제거로 정상 페이지처럼 보이지 않는다", async () => {
  for (const admission of [{ kind: "unknown" }, { kind: "described", text: "무료" }]) {
    const discovery = createEventDiscovery({ source: source([item(1, { admission })]), limits });
    await assert.rejects(discovery.search({ principal: { userId: "synthetic" }, filters: { target: "events", cost: "free" }, now: new Date() }), /EVENT_COST_FILTER_NOT_APPLIED/);
  }
  const discovery = createEventDiscovery({ source: source([item(1, { admission: { kind: "free" } })]), limits });
  const found = await discovery.search({ principal: { userId: "synthetic" }, filters: { target: "events", cost: "free" }, now: new Date() });
  assert.equal(found.cards[0].costLabel, "무료");
});
