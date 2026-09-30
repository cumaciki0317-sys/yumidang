/**
 * 실제 로컬 PostgREST·DB(제안 04 적용)로 행사 AI 탐색 포트(createEventDiscovery)와 runChat을 실행한다.
 * 저장(service)·조회(anon)는 민규 createRpcTransport에 **테스트 전용 허용 목록**을 넣어 만든다(운영은 민규 반영 전 unavailable).
 * 모델은 조건 해석만 돌려주는 가상 모델이다. 가상 행사만 커밋하고 finally에서 삭제한다.
 * 환경(로컬 값, 출력 금지): EVENTS_REST_DATABASE_URL, EVENTS_REST_SUPABASE_URL, EVENTS_REST_ANON_KEY, EVENTS_REST_SERVICE_ROLE_KEY
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createRpcTransport } from "../../../backend/supabase/functions/_shared/db/transport.ts";
import { createRpcEventRepository } from "../../../backend/supabase/functions/_shared/db/repositories/events.ts";
import { createEventDiscovery } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/event-discovery.ts";
import { runChat } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/orchestrator.ts";
const { Client } = createRequire(new URL("../../../backend/package.json", import.meta.url))("pg");
const env = process.env;
for (const key of ["EVENTS_REST_DATABASE_URL", "EVENTS_REST_SUPABASE_URL", "EVENTS_REST_ANON_KEY", "EVENTS_REST_SERVICE_ROLE_KEY"]) {
  if (!env[key]) throw new Error("EXPLICIT_LOCAL_SETTING_REQUIRED");
}
const api = new URL(env.EVENTS_REST_SUPABASE_URL);
if (api.hostname !== "127.0.0.1" || api.port !== "55421" || new URL(env.EVENTS_REST_DATABASE_URL).port !== "55422") throw new Error("DEDICATED_LOCAL_ONLY");
const config = { supabaseUrl: api.origin, supabaseAnonKey: env.EVENTS_REST_ANON_KEY, upstreamTimeoutMs: 5000 };

test("실제 DB: 행사 AI 탐색 순서·출처 KOPIS·링크 null·입장료 미상, 한도 도달 시 partial, 재확인", { timeout: 30_000 }, async () => {
  const admin = new Client({ connectionString: env.EVENTS_REST_DATABASE_URL, ssl: false });
  await admin.connect();
  const tag = "합성" + randomUUID().slice(0, 6);
  try {
    const service = createRpcEventRepository(createRpcTransport(config, env.EVENTS_REST_SERVICE_ROLE_KEY, env.EVENTS_REST_SERVICE_ROLE_KEY, new Set(["upsert_events"])));
    const collectedAt = new Date().toISOString();
    const event = (i, extra = {}) => ({ provider: "kopis", sourceId: `${tag}-${i}`, sourceStatus: "active", title: `${tag} 공연 ${i}`,
      category: "연극", region: "서울특별시", placeName: "가상 극장", publicAddress: null, admission: { kind: "unknown" }, sourceUrl: null,
      collectedAt, precision: "date", startsOn: `2099-01-0${i}`, endsOn: `2099-01-0${i + 1}`, ...extra });
    await service.upsertBySourceIdentity([event(1), event(2), event(3), event(4, { sourceStatus: "cancelled" })]);
    const source = createRpcEventRepository(createRpcTransport(config, env.EVENTS_REST_ANON_KEY, env.EVENTS_REST_ANON_KEY, new Set(["list_public_events"])));
    // 가상 한도(합성 검사 전용).
    const limits = { pageSize: 1, maxSearchPages: 10, recheckMaxPages: 10, maxResultCards: 10 };
    const port = createEventDiscovery({ source, limits });
    const filters = { target: "events", query: tag };
    const found = await port.search({ filters, now: new Date() });
    assert.equal(found.coverage, "exhausted");
    assert.deepEqual(found.cards.map((c) => c.title), [`${tag} 공연 1`, `${tag} 공연 2`, `${tag} 공연 3`], "예정 행사 빠른 시작순, 취소 제외");
    assert.ok(found.cards.every((c) => c.sourceName === "KOPIS" && c.sourceUrl === null && c.costLabel === "입장료 정보 없음" && c.canApply === false));
    const rechecked = await port.recheck({ filters, now: new Date(), cards: found.cards.map((c) => ({ kind: "event", id: c.id })) });
    assert.equal(rechecked.complete, true); assert.equal(rechecked.cards.length, 3);

    const model = { async generate() { return { value: { status: "search", filters }, modelVersion: "fake", usage: null }; } };
    const chatLimits = { maxMessages: 5, maxMessageChars: 200, maxTotalChars: 500, maxOutputTokens: 50 };
    const input = { clientRequestId: "r", messages: [{ role: "user", content: "공연 찾아줘" }], currentFilters: { target: "events" } };
    const posts = { async search() { throw new Error("posts port must not run"); }, async recheck() { throw new Error("no"); } };
    const full = await runChat(input, { userId: "u" }, { model, discovery: posts, events: port, limits: chatLimits, now: () => new Date() }, "req");
    assert.equal(full.status, "results"); assert.equal(full.partial, undefined); assert.equal(full.cards.length, 3);
    const limited = createEventDiscovery({ source, limits: { ...limits, maxSearchPages: 2 } });
    const part = await runChat(input, { userId: "u" }, { model, discovery: posts, events: limited, limits: chatLimits, now: () => new Date() }, "req");
    assert.equal(part.status, "results"); assert.equal(part.partial, true); assert.equal(part.cards.length, 2);
    assert.match(part.notice, /일부만 확인/);
  } finally {
    let left = -1;
    try {
      await admin.query("delete from private.events where provider='kopis' and source_id like $1", [tag + "-%"]);
      left = Number((await admin.query("select count(*) n from private.events where source_id like $1", [tag + "-%"])).rows[0].n);
    } finally {
      await admin.end(); // 스키마가 없거나 정리 조회가 실패해도 연결을 닫아 프로세스가 멈추지 않게 한다.
    }
    assert.equal(left, 0, "synthetic cleanup");
  }
});
