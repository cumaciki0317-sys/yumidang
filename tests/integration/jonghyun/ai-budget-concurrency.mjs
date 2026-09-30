/**
 * 제안 01_ai_budget.sql이 적용된 전용 로컬 DB에서만 실행하는 실제 다중 세션 검사.
 * 가상 원장만 커밋하고 finally에서 제거한다. 원격 DB URL을 받지 않는다.
 *   AI_BUDGET_TEST_DATABASE_URL=postgresql://postgres:<로컬>@127.0.0.1:55422/postgres node --test tests/integration/jonghyun/ai-budget-concurrency.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const { Client } = createRequire(new URL("../../../backend/package.json", import.meta.url))("pg");
const databaseUrl = process.env.AI_BUDGET_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("EXPLICIT_LOCAL_TEST_DATABASE_REQUIRED");
const target = new URL(databaseUrl);
if (!["postgres:", "postgresql:"].includes(target.protocol) || target.hostname !== "127.0.0.1" ||
    target.port !== "55422" || target.pathname !== "/postgres" || target.search || target.hash) {
  throw new Error("DEDICATED_LOCAL_DATABASE_ONLY");
}

test("동시 예약은 원장 한도를 넘지 않고, 같은 예약의 동시 정산은 한 번만 성립", { timeout: 30_000 }, async () => {
  const ledger = "synthetic-concurrency-" + randomUUID().slice(0, 8);
  const admin = new Client({ connectionString: databaseUrl, ssl: false, statement_timeout: 5000 });
  const sessions = Array.from({ length: 8 }, () => new Client({ connectionString: databaseUrl, ssl: false, statement_timeout: 5000 }));
  await admin.connect();
  try {
    await Promise.all(sessions.map(async (client) => { await client.connect(); await client.query("set role service_role"); }));
    // 가상 한도: 단위 100씩 최대 3건. 운영 한도가 아니다.
    await admin.query("select public.configure_ai_budget_ledger($1, 300, 100)", [ledger]);
    // 같은 순간에 8세션이 예약한다. 원장 행 잠금으로 직렬화되어 정확히 3건만 성공해야 한다.
    await admin.query("begin");
    await admin.query("select 1 from private.ai_budget_ledgers where ledger_id=$1 for update", [ledger]);
    const pending = sessions.map((client) => client.query("select public.reserve_ai_budget($1,'potens','preference_match',100) as r", [ledger]));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await admin.query("commit");
    const reserved = (await Promise.all(pending)).map((result) => result.rows[0].r.reservationId).filter(Boolean);
    assert.equal(reserved.length, 3);
    let state = (await admin.query("select public.get_ai_budget_ledger($1) as s", [ledger])).rows[0].s;
    assert.equal(Number(state.reservedUnits), 300);
    assert.equal(Number(state.openCalls), 3);
    // 같은 예약을 두 세션이 동시에 정산하면 한 번만 성공한다(이중 환불·이중 소비 없음).
    const race = await Promise.allSettled([
      sessions[0].query("select public.settle_ai_budget($1,'usage_unknown',null,null)", [reserved[0]]),
      sessions[1].query("select public.settle_ai_budget($1,'usage_reported',10,5)", [reserved[0]]),
    ]);
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(race.find((r) => r.status === "rejected").reason.code, "P0001");
    await sessions[2].query("select public.settle_ai_budget($1,'usage_reported',40,20)", [reserved[1]]);
    state = (await admin.query("select public.get_ai_budget_ledger($1) as s", [ledger])).rows[0].s;
    assert.equal(Number(state.openCalls), 1);
    assert.equal(Number(state.reservedUnits), 100);
    assert.ok([160, 115].includes(Number(state.chargedUnits)), String(state.chargedUnits)); // unknown 100+60 또는 reported 15+60
  } finally {
    await admin.query("rollback").catch(() => {});
    await admin.query("delete from private.ai_budget_ledgers where ledger_id=$1", [ledger]).catch(() => {});
    const left = await admin.query("select count(*)::int as n from private.ai_budget_ledgers where ledger_id=$1", [ledger]).catch(() => ({ rows: [{ n: -1 }] }));
    await Promise.all(sessions.map((client) => client.end().catch(() => {})));
    await admin.end();
    assert.equal(left.rows[0].n, 0, "synthetic ledger cleanup");
  }
});
