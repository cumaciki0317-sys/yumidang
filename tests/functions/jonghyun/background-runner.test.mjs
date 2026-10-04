import test from "node:test";
import assert from "node:assert/strict";
import { createBackgroundQueueScheduler } from "../../../backend/supabase/functions/_shared/jobs/background.mjs";
import { createWorkerRunScope } from "../../../backend/supabase/functions/_shared/jobs/worker-run.ts";
import {
  QUEUE_RUNNER_RPCS,
  readQueueRunnerConfig,
} from "../../../backend/supabase/functions/scheduled-jobs/queue-runner.mjs";
const now = "2026-10-05T00:00:00Z",
  token = "00000000-0000-4000-8000-000000000001";
const lease = { token, expiresAt: "2026-10-05T00:03:00Z" };
test("실패10분/예산1시간 기한을 DB 시계로 예약한다", async () => {
  for (
    const [next, delay] of [["2026-10-05T00:10:00Z", 600000], [
      "2026-10-05T01:00:00Z",
      3600000,
    ]]
  ) {
    const timers = [];
    let calls = 0;
    const scheduler = createBackgroundQueueScheduler({
      repository: {
        async schedule() {
          return {
            serverNow: now,
            nextKind: "review_summary",
            nextDueAt: next,
          };
        },
      },
      invoke: async () => {
        calls++;
      },
      setTimer: (fn, ms) => {
        timers.push(ms);
        return 1;
      },
      clearTimer: () => {},
      elapsed: () => 123,
    });
    await scheduler.wake();
    assert.deepEqual(timers, [delay]);
    assert.equal(calls, 0);
    await scheduler.stop();
  }
});
test("한 실행 후 due 양보 작업을 다시 실행하고 매번 전역 lease 해제", async () => {
  let n = 0, released = 0;
  const scheduler = createBackgroundQueueScheduler({
    repository: {
      async schedule() {
        return {
          serverNow: now,
          nextKind: "review_summary",
          nextDueAt: n < 2 ? now : null,
        };
      },
      async acquire() {
        return lease;
      },
      async release() {
        released++;
        return "applied";
      },
    },
    async invoke() {
      n++;
      return { status: "ran", stopReason: "max_jobs", counts: { claimed: 10 } };
    },
  });
  await scheduler.wake();
  assert.equal(n, 2);
  assert.equal(released, 2);
  await scheduler.stop();
});
test("동시 wake는 중복 실행하지 않고 stop은 진행 중 해제까지 기다린다", async () => {
  let unlock, n = 0, released = 0;
  const pending = new Promise((r) => unlock = r);
  const scheduler = createBackgroundQueueScheduler({
    repository: {
      async schedule() {
        return {
          serverNow: now,
          nextKind: "review_summary",
          nextDueAt: n ? null : now,
        };
      },
      async acquire() {
        return lease;
      },
      async release() {
        released++;
        return "applied";
      },
    },
    async invoke() {
      n++;
      await pending;
      return { status: "ran", stopReason: "idle", counts: { claimed: 0 } };
    },
  });
  const first = scheduler.wake();
  await new Promise((r) => setImmediate(r));
  await scheduler.wake();
  let stopped = false;
  const stopping = scheduler.stop().then(() => stopped = true);
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, false);
  unlock();
  await first;
  await stopping;
  assert.equal(n, 1);
  assert.equal(released, 1);
});
test("not_enabled는 계속 재시도하거나 작업 실패로 집계하지 않는다", async () => {
  let n = 0;
  const errors = [];
  const scheduler = createBackgroundQueueScheduler({
    repository: {
      async schedule({ excludeKinds }) {
        return {
          serverNow: now,
          nextKind: "review_summary",
          nextDueAt: excludeKinds.length ? null : now,
        };
      },
      async acquire() {
        return lease;
      },
      async release() {
        return "applied";
      },
    },
    onError: (code) => errors.push(code),
    async invoke() {
      n++;
      return { status: "not_enabled" };
    },
  });
  await scheduler.wake();
  assert.equal(n, 1);
  assert.deepEqual(errors, []);
  await scheduler.stop();
});
test("runner 기존 lease 검증은 내부 worker가 해제하지 않는다", async () => {
  const calls = [];
  const scope = createWorkerRunScope({
    async rpc(name, args) {
      calls.push([name, args]);
      return name === "acquire_worker_run"
        ? { token, expiresAt: lease.expiresAt }
        : { status: "applied" };
    },
  });
  const borrowed = await scope.open(token);
  assert.equal(borrowed.owned, false);
  await scope.close(borrowed);
  assert.equal(calls.length, 1);
  const owned = await scope.open();
  await scope.close(owned);
  assert.equal(calls.at(-1)[0], "release_worker_run");
  await assert.rejects(() => scope.open("invalid"));
});
test("완료 전용2RPC 권한을 확장하지 않는 별도 runner 설정", () => {
  assert.deepEqual(QUEUE_RUNNER_RPCS, [
    "read_worker_queue_schedule",
    "acquire_worker_run",
    "release_worker_run",
  ]);
  assert.throws(() => readQueueRunnerConfig({}));
  assert.throws(() =>
    readQueueRunnerConfig({
      WORKER_QUEUE_DATABASE_URL: "https://project.supabase.co",
    })
  );
});

test("작업 claim/settle도 전역 token을 DB 원자 검사로 전달한다", async () => {
  const { createRpcJobRepository } = await import(
    "../../../backend/supabase/functions/_shared/db/repositories/jobs.ts"
  );
  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      return name === "claim_job"
        ? { job: null }
        : { jobId: token, status: "succeeded" };
    },
  };
  const repository = createRpcJobRepository(db, { workerRunToken: token });
  await repository.claim({
    workerId: token,
    kinds: ["review_summary"],
    leaseDurationMs: 180000,
  });
  await repository.settle({
    jobId: token,
    leaseToken: token,
    status: "succeeded",
  });
  assert.equal(calls[0][1].p_worker_run_token, token);
  assert.equal(calls[1][1].p_worker_run_token, token);
  assert.throws(() =>
    createRpcJobRepository(db, { workerRunToken: "invalid" })
  );
});

test("실행기 시작·연결 복구는 LISTEN 뒤 due를 재조회하고 기존 lease로 내부 호출", async () => {
  const { EventEmitter } = await import("node:events");
  const { startQueueRunner } = await import(
    "../../../backend/supabase/functions/scheduled-jobs/queue-runner.mjs"
  );
  const clients = [], timers = [], reports = [], requests = [];
  let due = false;
  class Client extends EventEmitter {
    constructor() {
      super();
      this.calls = [];
      clients.push(this);
    }
    async connect() {}
    async end() {}
    async query(sql, args) {
      this.calls.push(sql);
      if (sql.includes("read_worker_queue_schedule")) {
        return {
          rows: [{
            result: {
              serverNow: now,
              nextKind: "review_summary",
              nextDueAt: due ? now : null,
            },
          }],
        };
      }
      if (sql.includes("acquire_worker_run")) {
        return { rows: [{ result: lease }] };
      }
      if (sql.includes("release_worker_run")) {
        due = false;
        return { rows: [{ result: { status: "applied" } }] };
      }
      return { rows: [] };
    }
  }
  const config = {
    databaseUrl: "postgres://fixture",
    ssl: false,
    functionUrl: "https://project.invalid/functions/v1/review-summary-worker",
    workerSecret: "SYNTHETIC",
    queryTimeoutMs: 1000,
    reconnectMs: 500,
    timeoutMs: 75000,
    leaseSeconds: 180,
  };
  const runner = startQueueRunner({
    Client,
    config,
    report: (v) => reports.push(v),
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: () => {},
    fetchImpl: async (url, init) => {
      requests.push(init);
      return Response.json({
        data: { status: "ran", stopReason: "idle", counts: { claimed: 0 } },
      });
    },
  });
  await runner.ready;
  assert.equal(reports[0], "WORKER_QUEUE_READY");
  assert.match(clients[0].calls[0], /^LISTEN yumidang_worker_jobs$/);
  due = true;
  clients[0].emit("notification", { channel: "yumidang_worker_jobs" });
  await new Promise((r) => setImmediate(r));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers["x-worker-run-token"], token);
  clients[0].emit("error", new Error("PRIVATE_CONNECTION_SECRET"));
  await new Promise((r) => setImmediate(r));
  const retry = timers.find((t) => t.ms === 500);
  assert.ok(retry);
  retry.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(clients.length, 2);
  assert.match(clients[1].calls[0], /^LISTEN/);
  assert.match(clients[1].calls[1], /read_worker_queue_schedule/);
  assert.ok(reports.every((v) => !v.includes("PRIVATE")));
  await runner.stop();
});

test("미적용 DB RPC는 READY를 보고하지 않고 원문 오류를 숨긴다", async () => {
  const { EventEmitter } = await import("node:events");
  const { startQueueRunner } = await import(
    "../../../backend/supabase/functions/scheduled-jobs/queue-runner.mjs"
  );
  const reports = [];
  class Client extends EventEmitter {
    async connect() {}
    async end() {}
    async query(sql) {
      if (sql.startsWith("LISTEN")) return { rows: [] };
      throw new Error("PRIVATE DATABASE PASSWORD");
    }
  }
  const runner = startQueueRunner({
    Client,
    config: {
      databaseUrl: "postgres://fixture",
      ssl: false,
      functionUrl: "https://project.invalid/functions/v1/review-summary-worker",
      workerSecret: "SYNTHETIC",
      queryTimeoutMs: 1000,
      reconnectMs: 500,
      timeoutMs: 75000,
      leaseSeconds: 180,
    },
    report: (v) => reports.push(v),
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await runner.ready;
  assert.deepEqual(reports, ["WORKER_QUEUE_UNAVAILABLE"]);
  await runner.stop();
});

test("후기 AI 미준비여도 행사 due를 실행하고 다음 wake에서 미준비 종류를 재확인", async () => {
  const calls = [], scopes = [], errors = [];
  let eventsDone = false;
  const scheduler = createBackgroundQueueScheduler({
    repository: {
      async schedule({ excludeKinds, afterKind }) {
        scopes.push({ excludeKinds: [...excludeKinds], afterKind });
        return {
          serverNow: now,
          nextDueAt: !excludeKinds.includes("review_summary") || !eventsDone
            ? now
            : null,
          nextKind: !excludeKinds.includes("review_summary")
            ? "review_summary"
            : "event_sync",
        };
      },
      async acquire() {
        return lease;
      },
      async release() {
        return "applied";
      },
    },
    async invoke(_token, kind) {
      calls.push(kind);
      if (kind === "review_summary") return { status: "not_enabled" };
      eventsDone = true;
      return {
        status: "ran",
        stopReason: "idle",
        hasMore: false,
        counts: { claimed: 1 },
      };
    },
    onError: (code) => errors.push(code),
  });
  await scheduler.wake();
  assert.deepEqual(calls, ["review_summary", "event_sync"]);
  assert.deepEqual(scopes[1].excludeKinds, ["review_summary"]);
  assert.equal(scopes.at(-1).afterKind, "event_sync");
  assert.deepEqual(errors, []);
  await scheduler.wake();
  assert.equal(calls.filter((k) => k === "review_summary").length, 2);
  await scheduler.stop();
});

test("양쪽 미준비이면 각각 한 번만 확인하고 멈추며 다른 종류 제외를 DB가 무시하면 실패로 닫는다", async () => {
  const calls = [], errors = [];
  const scheduler = createBackgroundQueueScheduler({
    repository: {
      async schedule({ excludeKinds }) {
        return {
          serverNow: now,
          nextDueAt: now,
          nextKind: excludeKinds.includes("review_summary")
            ? "event_sync"
            : "review_summary",
        };
      },
      async acquire() {
        return lease;
      },
      async release() {
        return "applied";
      },
    },
    async invoke(_token, kind) {
      calls.push(kind);
      return { status: "not_enabled" };
    },
    onError: (code) => errors.push(code),
  });
  await scheduler.wake();
  assert.deepEqual(calls, ["review_summary", "event_sync"]);
  assert.deepEqual(errors, []);
  await scheduler.stop();
  let n = 0;
  const invalid = createBackgroundQueueScheduler({
    repository: {
      async schedule() {
        return { serverNow: now, nextDueAt: now, nextKind: "review_summary" };
      },
      async acquire() {
        return lease;
      },
      async release() {
        return "applied";
      },
    },
    async invoke() {
      n++;
      return { status: "not_enabled" };
    },
    onError: (code) => errors.push(code),
  });
  await invalid.wake();
  assert.equal(n, 1);
  assert.deepEqual(errors, ["WORKER_QUEUE_UNAVAILABLE"]);
  await invalid.stop();
});

test("같이 due인 두 종류는 afterKind 교대로 선택하여 후기 대량 작업이 행사를 굶기지 않는다", async () => {
  const remaining = { review_summary: 3, event_sync: 3 }, calls = [];
  const scheduler = createBackgroundQueueScheduler({
    repository: {
      async schedule({ excludeKinds, afterKind }) {
        const available = Object.keys(remaining).filter((k) =>
          remaining[k] > 0 && !excludeKinds.includes(k)
        );
        const kind = available.find((k) => k !== afterKind) ?? available[0];
        return {
          serverNow: now,
          nextDueAt: kind ? now : null,
          nextKind: kind ?? null,
        };
      },
      async acquire() {
        return lease;
      },
      async release() {
        return "applied";
      },
    },
    async invoke(_token, kind) {
      calls.push(kind);
      remaining[kind]--;
      return {
        status: "ran",
        stopReason: "max_jobs",
        hasMore: remaining[kind] > 0,
        counts: { claimed: 10 },
      };
    },
  });
  await scheduler.wake();
  assert.deepEqual(calls, [
    "review_summary",
    "event_sync",
    "review_summary",
    "event_sync",
    "review_summary",
    "event_sync",
  ]);
  await scheduler.stop();
});
