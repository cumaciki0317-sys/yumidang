/** 민규: 실제 Provider 삭제와 구분한 batch 예산·상한·실패 전파 검증. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { drainMemberCleanupTasks, createMemberCleanupExecutor } from "../../../backend/supabase/functions/_shared/services/member-lifecycle-service.ts";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { HttpError, toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { CleanupExecutionBudget } from "../../../backend/supabase/functions/_shared/auth/member-cleanup.ts";
const token = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const code = (expected: string) => (error: unknown) => toPublicError(error).error.code === expected;
test("한 실행은 전역 점유를 갱신하지 않고 최대20개 완료 후 양보한다", async () => {
  let reads = 0, tasks = 0;
  const deadline = Date.now() + 180000;
  const result = await drainMemberCleanupTasks(token, async t => { reads++; assert.equal(t, token.toLowerCase()); return { deadlineAt: deadline }; }, async (t, budget) => {
    tasks++; assert.equal(t, token.toLowerCase()); assert.ok(budget.deadlineAt! <= deadline);
    assert.ok(budget.signal instanceof AbortSignal); return { status: "applied" };
  });
  assert.deepEqual(result, { status: "ran", claimed: 20, succeeded: 20 }); assert.equal(reads, 1); assert.equal(tasks, 20);
});
test("idle에서 멈추고 잔여60초를 확보하지 못하면 새 claim을 시작하지 않는다", async () => {
  let tasks = 0;
  assert.deepEqual(await drainMemberCleanupTasks(token, async () => ({ deadlineAt: Date.now() + 180000 }), async () => { tasks++; return { status: "idle" }; }), { status: "ran", claimed: 0, succeeded: 0 });
  assert.equal(tasks, 1);
  await drainMemberCleanupTasks(token, async () => ({ deadlineAt: Date.now() + 59000 }), async () => { tasks++; return { status: "applied" }; });
  assert.equal(tasks, 1);
});
test("실제 처리 실패는 이전 완료나 다음 작업의 가짜 성공으로 바꾸지 않는다", async () => {
  let tasks = 0;
  await assert.rejects(() => drainMemberCleanupTasks(token, async () => ({ deadlineAt: Date.now() + 180000 }), async () => {
    if (++tasks === 2) throw new HttpError("STATE_CONFLICT"); return { status: "applied" };
  }), code("STATE_CONFLICT"));
  assert.equal(tasks, 2);
});
test("취소·잘못된 token·만료 budget은 task 실행 전에 중단한다", async () => {
  let reads = 0, tasks = 0;
  const read = async () => { reads++; return { deadlineAt: Date.now() - 1 }; };
  const task = async () => { tasks++; return { status: "applied" as const }; };
  await assert.rejects(() => drainMemberCleanupTasks("bad", read, task), code("INVALID_REQUEST"));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(() => drainMemberCleanupTasks(token, read, task, abort.signal), code("STATE_CONFLICT"));
  await assert.rejects(() => drainMemberCleanupTasks(token, read, task), code("STATE_CONFLICT"));
  assert.equal(reads, 1); assert.equal(tasks, 0);
});
test("실행 중 취소 신호는 처리에 전달되며 취소 후 성공 집계를 응답하지 않는다", async () => {
  const abort = new AbortController();
  await assert.rejects(() => drainMemberCleanupTasks(token, async () => ({ deadlineAt: Date.now() + 180000 }), async (_t, budget) => {
    abort.abort(); assert.equal(budget.signal!.aborted, true); return { status: "applied" };
  }, abort.signal), code("STATE_CONFLICT"));
});
test("잘못된 처리 응답은20건 집계로 포장하지 않는다", async () => {
  await assert.rejects(() => drainMemberCleanupTasks(token, async () => ({ deadlineAt: Date.now() + 180000 }),
    async () => ({ status: "applied", objectName: "private" })), code("EXTERNAL_UNAVAILABLE"));
  await assert.rejects(() => drainMemberCleanupTasks(token, async () => ({ deadlineAt: "invalid" } as unknown as CleanupExecutionBudget),
    async () => ({ status: "idle" })), code("EXTERNAL_UNAVAILABLE"));
});
test("실제 factory는 budget 조회 뒤 기존5포트의 claim만 쓰고 빈 큐에서 종료한다", async () => {
  const values: Record<string, string> = { SUPABASE_URL: "https://cleanup.example.invalid", SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", INTERNAL_WORKER_SECRET: "fixture_worker_secret_longer_than_32_characters",
    ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "1000" };
  const calls: string[] = [];
  const run = createMemberCleanupExecutor(loadRuntimeConfig(k => values[k]), async url => {
    const name = String(url).split("/").at(-1)!; calls.push(name);
    assert.ok(["read_worker_run_budget", "claim_member_cleanup_task"].includes(name));
    return new Response(name === "read_worker_run_budget" ? '{"remainingMs":180000}' : "null");
  });
  assert.deepEqual(await run(token), { status: "ran", claimed: 0, succeeded: 0 });
  assert.deepEqual(calls, ["read_worker_run_budget", "claim_member_cleanup_task"]);
  calls.length = 0;
  const limited = createMemberCleanupExecutor(loadRuntimeConfig(k => values[k]), async url => {
    calls.push(String(url).split("/").at(-1)!); return new Response('{"remainingMs":180000}');
  }, { maxExecutionMs: 59000 });
  assert.deepEqual(await limited(token), { status: "ran", claimed: 0, succeeded: 0 });
  assert.deepEqual(calls, ["read_worker_run_budget"]);
});

test("batch 중 host 시계가 뒤로 이동해도 monotonic 잔여60초 조건을 완화하지 않는다", async () => {
  const originalDate = Date.now, originalPerformance = Object.getOwnPropertyDescriptor(performance, "now");
  let wall = 1000000, monotonic = 0, tasks = 0;
  Date.now = () => wall;
  Object.defineProperty(performance, "now", { configurable: true, value: () => monotonic });
  try {
    const result = await drainMemberCleanupTasks(token, async () => ({ deadlineAt: wall + 180000 }), async () => {
      tasks++; wall -= 3600000; monotonic = 120001; return { status: "applied" };
    });
    assert.equal(tasks, 1); assert.deepEqual(result, { status: "ran", claimed: 1, succeeded: 1 });
  } finally {
    Date.now = originalDate;
    if (originalPerformance) Object.defineProperty(performance, "now", originalPerformance);
    else Reflect.deleteProperty(performance, "now");
  }
});

test("batch 중 host 시계가 앞으로 이동해 wall 잔여60초 미만이면 새 claim을 시작하지 않는다", async () => {
  const originalDate = Date.now, originalPerformance = Object.getOwnPropertyDescriptor(performance, "now");
  let wall = 1000000, monotonic = 0, tasks = 0;
  Date.now = () => wall;
  Object.defineProperty(performance, "now", { configurable: true, value: () => monotonic });
  try {
    const result = await drainMemberCleanupTasks(token, async () => ({ deadlineAt: wall + 180000 }), async () => {
      tasks++; wall += 150001; monotonic = 1; return { status: "applied" };
    });
    assert.equal(tasks, 1); assert.deepEqual(result, { status: "ran", claimed: 1, succeeded: 1 });
  } finally {
    Date.now = originalDate;
    if (originalPerformance) Object.defineProperty(performance, "now", originalPerformance);
    else Reflect.deleteProperty(performance, "now");
  }
});

async function withCleanupClocks(run: (advance: (wallDelta: number, monotonicDelta: number) => void) => Promise<void>) {
  const originalDate = Date.now, originalPerformance = Object.getOwnPropertyDescriptor(performance, "now");
  let wall = 1000000, monotonic = 0;
  Date.now = () => wall;
  Object.defineProperty(performance, "now", { configurable: true, value: () => monotonic });
  try { await run((wallDelta, monotonicDelta) => { wall += wallDelta; monotonic += monotonicDelta; }); }
  finally {
    Date.now = originalDate;
    if (originalPerformance) Object.defineProperty(performance, "now", originalPerformance);
    else Reflect.deleteProperty(performance, "now");
  }
}
test("로컬 실행 상한은 budget 조회 지연부터 차감하고60초 미만이면 claim하지 않는다", async () => {
  await withCleanupClocks(async advance => {
    let tasks = 0;
    const result = await drainMemberCleanupTasks(token, async () => {
      advance(6001, 6001); return { deadlineAt: Date.now() + 180000 };
    }, async () => { tasks++; return { status: "applied" }; }, undefined, { maxExecutionMs: 65000 });
    assert.equal(tasks, 0); assert.deepEqual(result, { status: "ran", claimed: 0, succeeded: 0 });
  });
});
test("로컬 상한과 DB 예산 중 작은 값 적용 후 추가 claim을 하지 않는다", async () => {
  await withCleanupClocks(async advance => {
    let tasks = 0;
    const result = await drainMemberCleanupTasks(token, async () => ({ deadlineAt: Date.now() + 180000 }), async (_t, budget) => {
      assert.ok(budget.deadlineAt! <= 1120000); tasks++; advance(61001, 61001); return { status: "applied" };
    }, undefined, { maxExecutionMs: 120000 });
    assert.equal(tasks, 1); assert.equal(result.succeeded, 1);
    await drainMemberCleanupTasks(token, async () => ({ deadlineAt: Date.now() + 59000 }), async () => {
      tasks++; return { status: "applied" };
    }, undefined, { maxExecutionMs: 300000 });
    assert.equal(tasks, 1);
  });
});
test("budget 조회 중 wall 앞뒤 변화는 명시적 로컬 상한을 연장하지 않는다", async () => {
  for (const wallDelta of [-3600000, 3600000]) {
    await withCleanupClocks(async advance => {
      let tasks = 0;
      await assert.rejects(() => drainMemberCleanupTasks(token, async () => {
        advance(wallDelta, 65001); return { deadlineAt: Date.now() + 180000 };
      }, async () => { tasks++; return { status: "applied" }; }, undefined, { maxExecutionMs: 65000 }), code("STATE_CONFLICT"));
      assert.equal(tasks, 0);
    });
  }
});
test("로컬 옵션의 잘못된 상한은 budget 조회 전에 거절한다", async () => {
  for (const maxExecutionMs of [0, -1, 1.5, Infinity, NaN]) {
    let reads = 0;
    await assert.rejects(() => drainMemberCleanupTasks(token, async () => { reads++; return {}; }, async () => ({ status: "idle" }),
      undefined, { maxExecutionMs }), code("INVALID_REQUEST"));
    assert.equal(reads, 0);
  }
});
test("주입한 task Promise가 abort를 무시하면 batch는 반환 후 취소를 검사한다", async () => {
  const abort = new AbortController(); let settled = false, release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const run = drainMemberCleanupTasks(token, async () => ({ deadlineAt: Date.now() + 180000 }), async (_t, budget) => {
    entered(); await pending; assert.equal(budget.signal!.aborted, true); return { status: "applied" };
  }, abort.signal, { maxExecutionMs: 120000 });
  const checked = assert.rejects(run, code("STATE_CONFLICT")).finally(() => { settled = true; });
  await started; abort.abort(); await Promise.resolve(); assert.equal(settled, false);
  release(); await checked; assert.equal(settled, true);
});

test("명시적 로컬 timer는 budget 조회 중에도 abort를 전달하며 claim 전에 중단한다", async () => {
  let tasks = 0;
  await assert.rejects(() => drainMemberCleanupTasks(token, async (_t, signal) => {
    await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
    // 조회 구현이 abort 후 결과를 반환해도 task 처리로 넘어가지 않는다.
    return { deadlineAt: Date.now() + 180000 };
  }, async () => { tasks++; return { status: "applied" }; }, undefined, { maxExecutionMs: 1 }), code("STATE_CONFLICT"));
  assert.equal(tasks, 0);
});
