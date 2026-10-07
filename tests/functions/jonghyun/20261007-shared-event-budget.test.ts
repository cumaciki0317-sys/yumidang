import test from "node:test";
import assert from "node:assert/strict";
import { createEventOperations } from "../../../backend/supabase/functions/_shared/jobs/event-runtime.ts";
const token = "00000000-0000-4000-8000-000000000001";
function fixture(controller?: AbortController) {
  const calls: string[] = [];
  let n = 0;
  const db = { async rpc(name: string) {
    calls.push(name);
    if (name === "read_event_collection_contract") return { version: "2026-10-05", capabilities: ["collection"] };
    if (name === "acquire_worker_run") return { token, expiresAt: "2099-01-01T00:00:00Z" };
    if (name === "next_event_collection_reference") {
      controller?.abort();
      return { provider: "kopis", lane: "future", period: { start: `2026-10-${String(++n).padStart(2, "0")}`, end: "2026-11-04" } };
    }
    throw new Error(name);
  } };
  const operations = createEventOperations({ db, providers: new Map(), providerMaxPage: 999, maxPages: 5, now: () => new Date() });
  // 배정된 worker 반복만 격리한다. 원천/DB 점유 자체의 기존 검사는 event-runtime.test.mjs에서 검증한다.
  let collected = 0;
  operations.collect = async () => { collected++; return { status: "complete" } as Awaited<ReturnType<typeof operations.collect>>; };
  return { operations, calls, collected: () => collected };
}
test("공유 배정1개는 기존10개보다 먼저 멈추고 원 토큰을 해제하지 않는다", async () => {
  const f = fixture(); const r = await f.operations.worker(token, undefined, { maxJobsPerRun: 1, timeBudgetMs: 60000 });
  assert.equal(r.status, "ran"); if (r.status !== "ran") throw new Error();
  assert.equal(r.counts.claimed, 1); assert.equal(r.stopReason, "max_jobs"); assert.equal(f.collected(), 1);
  assert.equal(f.calls.filter(n => n === "acquire_worker_run").length, 1);
  assert.equal(f.calls.includes("release_worker_run"), false);
});
test("0/잘못된 배정과 사전 중단은 계약조회/점유/원천 요청0", async () => {
  for (const execution of [{ maxJobsPerRun: 0, timeBudgetMs: 60000 }, { maxJobsPerRun: 1, timeBudgetMs: 0 }]) {
    const f = fixture(); await f.operations.worker(token, undefined, execution); assert.deepEqual(f.calls, []);
  }
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await f.operations.worker(token, controller.signal, { maxJobsPerRun: 1, timeBudgetMs: 100 });
  await assert.rejects(f.operations.worker(token, undefined, { maxJobsPerRun: -1, timeBudgetMs: 100 }), /INVALID_EVENT_WORKER_LIMITS/);
  assert.deepEqual(f.calls, []);
});
test("예약 조회 중 부모가 중단되면 새 소비자 점유/원천 요청0", async () => {
  const controller = new AbortController(); const f = fixture(controller);
  const r = await f.operations.worker(token, controller.signal, { maxJobsPerRun: 1, timeBudgetMs: 60000 });
  assert.equal(r.status, "ran"); if (r.status !== "ran") throw new Error();
  assert.equal(r.counts.claimed, 0); assert.equal(r.stopReason, "time_budget"); assert.equal(f.collected(), 0);
});

test("공유 실행은 원 토큰 없이 새 점유하지 않으며 늦은 성공은 성공으로 집계하지 않는다", async () => {
  const f = fixture();
  await assert.rejects(f.operations.worker(undefined, undefined, { maxJobsPerRun: 1, timeBudgetMs: 100 }), /INVALID_EVENT_WORKER_LIMITS/);
  assert.deepEqual(f.calls, []);
  const controller = new AbortController();
  f.operations.collect = async () => { controller.abort(); return { status: "complete" } as Awaited<ReturnType<typeof f.operations.collect>>; };
  await assert.rejects(f.operations.worker(token, controller.signal, { maxJobsPerRun: 1, timeBudgetMs: 60000 }), /EVENT_WORKER_OUTCOME_UNKNOWN/);
  assert.equal(f.calls.includes("release_worker_run"), false);
});
