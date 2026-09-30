/**
 * 실제 로컬 PostgREST·DB(제안 04 적용)로 행사 저장소 어댑터를 실행한다. 가상 행사만 커밋하고 finally에서 삭제한다.
 * 저장은 service 키, 조회는 anon 키이며 둘 다 **테스트 전용 허용 목록**의 민규 createRpcTransport다
 * (운영 internal/public client 허용 목록 반영 전까지 event-sync 저장은 500, 공개 조회 경로는 미연결).
 * 환경(로컬 값, 출력 금지): EVENTS_REST_DATABASE_URL, EVENTS_REST_SUPABASE_URL, EVENTS_REST_ANON_KEY, EVENTS_REST_SERVICE_ROLE_KEY
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createRpcTransport } from "../../../backend/supabase/functions/_shared/db/transport.ts";
import { createRpcEventRepository } from "../../../backend/supabase/functions/_shared/db/repositories/events.ts";
const { Client } = createRequire(new URL("../../../backend/package.json", import.meta.url))("pg");
const env = process.env;
for (const key of ["EVENTS_REST_DATABASE_URL", "EVENTS_REST_SUPABASE_URL", "EVENTS_REST_ANON_KEY", "EVENTS_REST_SERVICE_ROLE_KEY"]) {
  if (!env[key]) throw new Error("EXPLICIT_LOCAL_SETTING_REQUIRED");
}
const api = new URL(env.EVENTS_REST_SUPABASE_URL);
if (api.hostname !== "127.0.0.1" || api.port !== "55421" || new URL(env.EVENTS_REST_DATABASE_URL).port !== "55422") throw new Error("DEDICATED_LOCAL_ONLY");
const config = { supabaseUrl: api.origin, supabaseAnonKey: env.EVENTS_REST_ANON_KEY, upstreamTimeoutMs: 5000 };

test("service 저장 두 번 중복 없음·취소 숨김·비용 미상 보존, anon 조회 페이지 커서", { timeout: 30_000 }, async () => {
  const admin = new Client({ connectionString: env.EVENTS_REST_DATABASE_URL, ssl: false });
  await admin.connect();
  const provider = "synthetic-" + randomUUID().slice(0, 8);
  try {
    const service = createRpcEventRepository(createRpcTransport(config, env.EVENTS_REST_SERVICE_ROLE_KEY, env.EVENTS_REST_SERVICE_ROLE_KEY, new Set(["upsert_events"])));
    const anon = createRpcEventRepository(createRpcTransport(config, env.EVENTS_REST_ANON_KEY, env.EVENTS_REST_ANON_KEY, new Set(["list_public_events"])));
    const collectedAt = new Date().toISOString();
    const event = (i, extra = {}) => ({ provider, sourceId: "s" + i, sourceStatus: "active", title: "가상 행사 " + i, category: "연극",
      region: "서울특별시", placeName: "가상 극장", publicAddress: null, admission: { kind: "unknown" }, sourceUrl: null, collectedAt,
      precision: "date", startsOn: "2099-01-0" + i, endsOn: "2099-01-0" + (i + 1), ...extra });
    const page = [event(1), event(2), event(3, { sourceStatus: "cancelled" })];
    const first = await service.upsertBySourceIdentity(page);
    const second = await service.upsertBySourceIdentity(page);
    assert.equal(first.savedCount, 3);
    assert.equal(second.savedCount + (second.staleCount ?? 0), 3);
    assert.equal(Number((await admin.query("select count(*) n from private.events where provider=$1", [provider])).rows[0].n), 3, "재저장 중복 없음");
    const query = { mode: "overlapping", query: "가상 행사" };
    const p1 = await anon.listPage(query, undefined, 1);
    assert.equal(p1.events.length, 1);
    assert.ok(p1.nextCursor);
    const p2 = await anon.listPage(query, p1.nextCursor, 1);
    assert.equal(p2.events.length, 1);
    assert.notEqual(p1.events[0].sourceId, p2.events[0].sourceId);
    const all = [...p1.events, ...p2.events];
    assert.ok(all.every((e) => e.sourceStatus === "active" && e.admission.kind === "unknown"), "취소 숨김·비용 미상 보존");
    await assert.rejects(createRpcTransport(config, env.EVENTS_REST_ANON_KEY, env.EVENTS_REST_ANON_KEY, new Set(["upsert_events"]))
      .rpc("upsert_events", { p_events: [] }), "anon은 저장 불가");
  } finally {
    await admin.query("delete from private.events where provider=$1", [provider]).catch(() => {});
    const left = await admin.query("select count(*) n from private.events where provider=$1", [provider]);
    await admin.end();
    assert.equal(Number(left.rows[0].n), 0, "synthetic cleanup");
  }
});
