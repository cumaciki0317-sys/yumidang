import test from "node:test";
import assert from "node:assert/strict";
import { createBackgroundQueueScheduler } from "../../../backend/supabase/functions/_shared/jobs/background.mjs";
import { createWorkerRunScope } from "../../../backend/supabase/functions/_shared/jobs/worker-run.ts";
import {
  QUEUE_RUNNER_RPCS,
  readQueueRunnerConfig,
} from "../../../backend/supabase/functions/scheduled-jobs/queue-runner.mjs";
const ca = `-----BEGIN CERTIFICATE-----\nMIIDITCCAgmgAwIBAgIUDbz2MaXCMv42TCUGEZXspLS9Jy8wDQYJKoZIhvcNAQEL\nBQAwIDEeMBwGA1UEAwwVeXVtaWRhbmctdGVzdC1vbmx5LWNhMB4XDTI2MTAwNTEy\nNDU1MloXDTI2MTEwNDEyNDU1MlowIDEeMBwGA1UEAwwVeXVtaWRhbmctdGVzdC1v\nbmx5LWNhMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArSs99/MrTJ51\neXei6CRx9SlNUEmBUcyJm8Ee/JKaSyvo38fNj1RqKrTxYC0bhwQfGsCJOb+L4v+v\nOEVxomgotcJ025j6JVZqzCeINo+tgUM8es/olKP42yObcrdzeGQ9FkXGyrjHy9ye\nLloGrBwlscSdArcCf4O50DfizfMVVy0OfPdaeIsi+93gzU8zxnuf5dkWSfgNHXzY\ns/mZ9aSf6GZXQHha6VM+EIyl57JcfGb9Cga1BnlFzczdcbIifign7rCDqtu0yWNP\nIFpi0RpFw/yw89TjGlW+rl8L95belmdr+vVgA3SLFkGriEVySMcsJllPJU2JJVnU\nenlU/vzjYwIDAQABo1MwUTAdBgNVHQ4EFgQUaI0vWy0WFHwJuqi0nJbJ0RhL7bww\nHwYDVR0jBBgwFoAUaI0vWy0WFHwJuqi0nJbJ0RhL7bwwDwYDVR0TAQH/BAUwAwEB\n/zANBgkqhkiG9w0BAQsFAAOCAQEAOx1HgMZJhqQZyk1L8GvSFXrXyPu7We/CqA+m\n/Y96gwOQEW5OWPUVlMkvQ325Umx8V/3nk0AA+orKa0vaygfuHh2maBiDT5hduLEN\n0LbxLBMnBcD/A1h6jb0x6awfNs6hTnSPX1xBNgtNtP1m8vQcdxopYqci7yaxqKsP\nnLhhemnbaNkBOSouvyC9P9g+mWM12qil6CQvVRQIXQ7XCrSwSZrC80vBIGNCPA1J\nIp4WIk+3uMMbOx79Ovj7wju+b/MkERHtocMpA26WcABWKdk+B03F1LiS+bZYsnsc\nba2Hy5qRO9sTFmhtbY004q0og0afdUuVDYqgdL754JgJz1DAug==\n-----END CERTIFICATE-----\n`;
const runnerConfig = {
  databaseUrl: "postgres://queue_login:synthetic@localhost:5432/fixture",
  ssl: { rejectUnauthorized: true, ca },
  contractId: "synthetic-contract", expectedLoginRole: "queue_login",
  functionUrl: "https://project.invalid/functions/v1/review-summary-worker",
  workerSecret: "SYNTHETIC_INTERNAL_SECRET_1234567890",
  queryTimeoutMs: 1000, reconnectMs: 500, timeoutMs: 75000, leaseSeconds: 180,
};
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
      if (sql.includes("current_user")) return { rows: [{ currentRole: "yumidang_worker_queue", loginRole: "queue_login" }] };
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
  const config = runnerConfig;
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
        data: { status: "ran", stopReason: "idle", hasMore: false, counts: { claimed: 0 } },
      });
    },
  });
  await runner.ready;
  assert.equal(reports[0], "WORKER_QUEUE_READY");
  assert.match(clients[0].calls[0], /^SET ROLE yumidang_worker_queue$/);
  assert.match(clients[0].calls[1], /current_user/);
  assert.match(clients[0].calls[2], /^LISTEN yumidang_worker_jobs$/);
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
  assert.match(clients[1].calls[0], /^SET ROLE/);
  assert.match(clients[1].calls[1], /current_user/);
  assert.match(clients[1].calls[2], /^LISTEN/);
  assert.match(clients[1].calls[3], /read_worker_queue_schedule/);
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
    config: runnerConfig,
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
          nextDueAt: excludeKinds.length >= 2 ? null : now,
          nextKind: excludeKinds.length >= 2 ? null : excludeKinds.includes("review_summary")
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

const configEnv = () => ({
  WORKER_QUEUE_DATABASE_URL: runnerConfig.databaseUrl,
  WORKER_QUEUE_DB_CA_PEM: ca,
  WORKER_QUEUE_FUNCTION_URL: runnerConfig.functionUrl,
  WORKER_QUEUE_DB_CONTRACT_ID: runnerConfig.contractId,
  WORKER_QUEUE_DB_LOGIN_ROLE: runnerConfig.expectedLoginRole,
  INTERNAL_WORKER_SECRET: runnerConfig.workerSecret,
  WORKER_QUEUE_QUERY_TIMEOUT_MS: "1000",
  WORKER_QUEUE_RECONNECT_MS: "500",
  WORKER_QUEUE_HTTP_TIMEOUT_MS: "75000",
});
test("로컬도 승인 CA 검증 TLS가 필수이며 잘못된 CA/config를 거부", () => {
  const valid = readQueueRunnerConfig(configEnv());
  assert.equal(valid.ssl.rejectUnauthorized, true);
  assert.equal(valid.ssl.ca, ca);
  assert.equal(valid.leaseSeconds, 180);
  for (const change of [
    { WORKER_QUEUE_DB_CA_PEM: "" },
    { WORKER_QUEUE_DB_CA_PEM: "not-a-certificate" },
    { WORKER_QUEUE_DB_CA_PEM: "-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----" },
    { WORKER_QUEUE_DB_CA_PEM: "-----BEGIN CERTIFICATE-----" },
    { WORKER_QUEUE_FUNCTION_URL: "https://project.invalid/other" },
    { WORKER_QUEUE_DATABASE_URL: "postgres://queue_login:p@localhost/db?sslmode=disable" },
    { WORKER_QUEUE_HTTP_TIMEOUT_MS: "75001" },
  ]) assert.throws(() => readQueueRunnerConfig({ ...configEnv(), ...change }));
});

test("세 종류 미준비/빈 실행은 각 drain에서 한 번씩 확인", async () => {
  const kinds = ["review_summary", "event_sync", "member_cleanup"], calls = [], scopes = [];
  const scheduler = createBackgroundQueueScheduler({
    repository: {
      async schedule({ excludeKinds, afterKind }) {
        scopes.push({ excludeKinds: [...excludeKinds], afterKind });
        const kind = kinds.find(k => !excludeKinds.includes(k));
        return { serverNow: now, nextDueAt: kind ? now : null, nextKind: kind ?? null };
      },
      async acquire() { return lease; },
      async release() { return "applied"; },
    },
    async invoke(_token, kind) {
      calls.push(kind);
      return kind === "review_summary" ? { status: "not_enabled" } : { status: "ran", counts: { claimed: 0 } };
    },
  });
  await scheduler.wake();
  assert.deepEqual(calls, kinds);
  await scheduler.wake();
  assert.deepEqual(calls, [...kinds, ...kinds]);
  await scheduler.stop();
});

for (const failure of ["timeout", "network", "invalid-dto"]) {
  test(`원격 ${failure} 이후 조기 release 없이 DB 기한 재조회`, async () => {
    let acquired = 0, released = 0, schedules = 0;
    const delays = [], errors = [];
    const scheduler = createBackgroundQueueScheduler({
      repository: {
        async schedule() {
          schedules++;
          return { serverNow: now, nextDueAt: schedules === 1 ? now : lease.expiresAt, nextKind: "member_cleanup" };
        },
        async acquire() { acquired++; return lease; },
        async release() { released++; return "applied"; },
      },
      async invoke() {
        if (failure === "invalid-dto") return { status: "ran", counts: { claimed: -1 } };
        throw new Error(failure);
      },
      setTimer: (_fn, ms) => { delays.push(ms); return 1; },
      clearTimer: () => {}, elapsed: () => 100,
      onError: code => errors.push(code),
    });
    await scheduler.wake();
    assert.equal(acquired, 1);
    assert.equal(released, 0);
    assert.equal(schedules, 2);
    assert.deepEqual(delays, [180000]);
    assert.deepEqual(errors, ["WORKER_QUEUE_UNAVAILABLE"]);
    await scheduler.stop();
  });
}

test("명시적 dispatch 전 실패만 안전 해제", async () => {
  let released = 0;
  const scheduler = createBackgroundQueueScheduler({
    repository: {
      async schedule() { return { serverNow: now, nextDueAt: now, nextKind: "event_sync" }; },
      async acquire() { return lease; },
      async release() { released++; return "applied"; },
    },
    async invoke() { throw Object.assign(new Error("PRE_DISPATCH"), { releasePermitted: true }); },
    onError: () => {},
  });
  await scheduler.wake();
  assert.equal(released, 1);
  await scheduler.stop();
});

async function exerciseRunner({ kind = "member_cleanup", data = { status: "ran", claimed: 0, succeeded: 0 },
  response, role = "yumidang_worker_queue", loginRole = "queue_login", failRole = false, fetcher } = {}) {
  const { EventEmitter } = await import("node:events");
  const { startQueueRunner } = await import("../../../backend/supabase/functions/scheduled-jobs/queue-runner.mjs");
  const calls = [], requests = [], reports = [], timers = [];
  let releases = 0, dispatched = false, clientOptions;
  class Client extends EventEmitter {
    constructor(options) { super(); clientOptions = options; }
    async connect() {}
    async end() {}
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql.startsWith("SET ROLE") && failRole) throw new Error("PRIVATE_ROLE_ERROR");
      if (sql.includes("current_user")) return { rows: [{ currentRole: role, loginRole }] };
      if (sql.includes("read_worker_queue_schedule")) return { rows: [{ result: {
        serverNow: now, nextDueAt: releases || args[0].includes(kind) ? null : dispatched ? lease.expiresAt : now,
        nextKind: releases || args[0].includes(kind) ? null : kind,
      } }] };
      if (sql.includes("acquire_worker_run")) return { rows: [{ result: lease }] };
      if (sql.includes("release_worker_run")) { releases++; return { rows: [{ result: { status: "applied" } }] }; }
      return { rows: [] };
    }
  }
  const runner = startQueueRunner({
    Client, config: runnerConfig, report: v => reports.push(v),
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: () => {},
    fetchImpl: async (url, init) => {
      dispatched = true; requests.push({ url, init });
      return fetcher ? fetcher(url, init, timers) : response ?? Response.json({ data });
    },
  });
  await runner.ready;
  await new Promise(resolve => setImmediate(resolve));
  await runner.stop();
  return { calls, requests, reports, timers, releases, clientOptions };
}

test("실제 runner 분기의 cleanup 고정 경로·본문·token·최상위 DTO 검증", async () => {
  const r = await exerciseRunner();
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].url, "https://project.invalid/functions/v1/service-api/internal/member-cleanup");
  assert.equal(r.requests[0].init.body, "{}");
  assert.equal(r.requests[0].init.method, "POST");
  assert.equal(r.requests[0].init.redirect, "error");
  assert.equal(r.requests[0].init.headers["x-worker-run-token"], token);
  assert.equal(r.clientOptions.ssl.rejectUnauthorized, true);
  assert.equal(r.releases, 1);
  assert.ok(r.reports.includes("WORKER_QUEUE_READY"));
  const acquire = r.calls.find(c => c.sql.includes("acquire_worker_run"));
  assert.deepEqual(acquire.args, [180]);
  assert.match(acquire.sql, /null::uuid/);
});

for (const data of [
  { status: "ran", claimed: 21, succeeded: 0 },
  { status: "ran", claimed: 1, succeeded: 2 },
  { status: "ran", claimed: 0.5, succeeded: 0 },
  { status: "ran", claimed: -1, succeeded: 0 },
  { status: "ran", counts: { claimed: 0, succeeded: 0 } },
  { status: "not_enabled", reason: "NOT_READY" },
  { status: "ran", claimed: 0, succeeded: 0, unexpected: true },
]) test(`cleanup 부정 DTO는 종결로 처리하지 않음 ${JSON.stringify(data)}`, async () => {
  const r = await exerciseRunner({ data });
  assert.equal(r.releases, 0);
  assert.ok(!r.reports.includes("WORKER_QUEUE_READY"));
  assert.ok(r.reports.includes("WORKER_QUEUE_UNAVAILABLE"));
});

test("ROLE 거절·다른 역할은 LISTEN/HTTP/READY보다 먼저 닫힘", async () => {
  for (const change of [{ failRole: true }, { role: "postgres" }, { loginRole: "wrong_login" }]) {
    const r = await exerciseRunner(change);
    assert.equal(r.requests.length, 0);
    assert.ok(!r.calls.some(c => c.sql.startsWith("LISTEN")));
    assert.ok(!r.reports.includes("WORKER_QUEUE_READY"));
    assert.ok(r.reports.every(v => !v.includes("PRIVATE")));
  }
});

test("pooler URL 사용자명과 기대 LOGIN 역할을 명시적으로 구분", () => {
  const config = readQueueRunnerConfig({ ...configEnv(),
    WORKER_QUEUE_DATABASE_URL: "postgres://queue_login.project_ref:synthetic@localhost/fixture",
    WORKER_QUEUE_DB_LOGIN_ROLE: "queue_login",
  });
  assert.equal(config.expectedLoginRole, "queue_login");
  assert.throws(() => readQueueRunnerConfig({ ...configEnv(), WORKER_QUEUE_DB_LOGIN_ROLE: "" }));
});

test("caller 중단을 무시한 지연 응답도 성공으로 해제하지 않음", async () => {
  const r = await exerciseRunner({ fetcher: async (_url, init, timers) => {
    timers.find(t => t.ms === 75000).fn();
    assert.equal(init.signal.aborted, true);
    return Response.json({ data: { status: "ran", claimed: 1, succeeded: 1 } });
  } });
  assert.equal(r.releases, 0);
  assert.ok(!r.reports.includes("WORKER_QUEUE_READY"));
});

test("응답 JSON 소실과 네트워크 예외는 점유 유지", async () => {
  for (const fetcher of [
    async () => new Response("broken-json", { status: 200 }),
    async () => { throw new Error("PRIVATE_HTTP_ERROR"); },
  ]) {
    const r = await exerciseRunner({ fetcher });
    assert.equal(r.releases, 0);
    assert.ok(r.reports.every(v => !v.includes("PRIVATE")));
  }
});

test("세 종류 계속 due여도 afterKind로 교대하고 회원 정리를 굶기지 않음", async () => {
  const kinds = ["review_summary", "event_sync", "member_cleanup"], left = Object.fromEntries(kinds.map(k => [k, 2])), calls = [];
  const scheduler = createBackgroundQueueScheduler({
    repository: {
      async schedule({ excludeKinds, afterKind }) {
        const start = kinds.indexOf(afterKind) + 1;
        const ordered = [...kinds.slice(start), ...kinds.slice(0, start)];
        const kind = ordered.find(k => left[k] > 0 && !excludeKinds.includes(k));
        return { serverNow: now, nextDueAt: kind ? now : null, nextKind: kind ?? null };
      },
      async acquire() { return lease; },
      async release() { return "applied"; },
    },
    async invoke(_token, kind) { calls.push(kind); left[kind]--; return { status: "ran", counts: { claimed: 1 } }; },
  });
  await scheduler.wake();
  assert.deepEqual(calls, [...kinds, ...kinds]);
  await scheduler.stop();
});

test("stop 중 응답 소실은 진행 중 점유를 해제하지 않음", async () => {
  let rejectRequest, released = 0;
  const pending = new Promise((_resolve, reject) => { rejectRequest = reject; });
  const scheduler = createBackgroundQueueScheduler({
    repository: {
      async schedule() { return { serverNow: now, nextDueAt: now, nextKind: "member_cleanup" }; },
      async acquire() { return lease; },
      async release() { released++; return "applied"; },
    },
    async invoke() { return pending; }, onError: () => {},
  });
  const running = scheduler.wake();
  await new Promise(resolve => setImmediate(resolve));
  const stopping = scheduler.stop();
  rejectRequest(new Error("response-lost"));
  await Promise.all([running, stopping]);
  assert.equal(released, 0);
});

test("호스트 wall clock 점프는 DB 미래 기한을 조기 실행하지 않음", async () => {
  const original = Date.now, delays = [];
  let invoked = 0;
  const scheduler = createBackgroundQueueScheduler({
    repository: {
      async schedule() {
        Date.now = () => original() + 3600000;
        return { serverNow: now, nextDueAt: lease.expiresAt, nextKind: "review_summary" };
      },
    },
    async invoke() { invoked++; },
    setTimer: (_fn, ms) => { delays.push(ms); return 1; }, clearTimer: () => {},
  });
  try {
    await scheduler.wake();
    assert.equal(invoked, 0);
    assert.equal(delays.length, 1);
    assert.ok(delays[0] > 179000 && delays[0] <= 180000);
  } finally { Date.now = original; await scheduler.stop(); }
});

for (const stage of ["SET ROLE", "current_user", "LISTEN"]) {
  test(`runner ${stage} 연결 도중 stop은 새 due/HTTP 실행을 막음`, async () => {
    const { EventEmitter } = await import("node:events");
    const { startQueueRunner } = await import("../../../backend/supabase/functions/scheduled-jobs/queue-runner.mjs");
    let unlock, reached, requests = 0;
    const gate = new Promise(resolve => { unlock = resolve; });
    const started = new Promise(resolve => { reached = resolve; });
    const calls = [];
    class Client extends EventEmitter {
      async connect() {}
      async end() {}
      async query(sql) {
        calls.push(sql);
        if (sql.includes(stage)) { reached(); await gate; }
        if (sql.includes("current_user")) return { rows: [{ currentRole: "yumidang_worker_queue", loginRole: "queue_login" }] };
        if (sql.includes("read_worker_queue_schedule")) return { rows: [{ result: { serverNow: now, nextDueAt: now, nextKind: "member_cleanup" } }] };
        if (sql.includes("acquire_worker_run")) return { rows: [{ result: lease }] };
        return { rows: [] };
      }
    }
    const reports = [];
    const runner = startQueueRunner({ Client, config: runnerConfig, report: v => reports.push(v),
      fetchImpl: async () => { requests++; return Response.json({ data: { status: "ran", claimed: 0, succeeded: 0 } }); },
    });
    await started;
    const stopping = runner.stop();
    unlock();
    await Promise.all([runner.ready, stopping]);
    assert.equal(requests, 0);
    assert.ok(!calls.some(sql => sql.includes("read_worker_queue_schedule")));
    assert.ok(!reports.includes("WORKER_QUEUE_READY"));
  });
}

test("직접 주입 config도 TLS 검증 우회가 불가능", async () => {
  const { startQueueRunner } = await import("../../../backend/supabase/functions/scheduled-jobs/queue-runner.mjs");
  class Client { constructor() { throw new Error("must not connect"); } }
  for (const ssl of [false, { rejectUnauthorized: false, ca }, { rejectUnauthorized: true, ca: "invalid" }]) {
    assert.throws(() => startQueueRunner({ Client, config: { ...runnerConfig, ssl } }), /QUEUE_RUNNER_NOT_CONFIGURED/);
  }
});

test("READY 전 첫 HTTP 도중 stop은 다음 due를 시작하지 않음", { timeout: 2000 }, async () => {
  const { EventEmitter } = await import("node:events");
  const { startQueueRunner } = await import("../../../backend/supabase/functions/scheduled-jobs/queue-runner.mjs");
  let unblock, entered, requests = 0, releases = 0;
  const pending = new Promise(resolve => { unblock = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  class Client extends EventEmitter {
    async connect() {}
    async end() {}
    async query(sql) {
      if (sql.includes("current_user")) return { rows: [{ currentRole: "yumidang_worker_queue", loginRole: "queue_login" }] };
      if (sql.includes("read_worker_queue_schedule")) return { rows: [{ result: { serverNow: now, nextDueAt: now, nextKind: "member_cleanup" } }] };
      if (sql.includes("acquire_worker_run")) return { rows: [{ result: lease }] };
      if (sql.includes("release_worker_run")) { releases++; return { rows: [{ result: { status: "applied" } }] }; }
      return { rows: [] };
    }
  }
  const runner = startQueueRunner({ Client, config: runnerConfig,
    setTimer: () => 1, clearTimer: () => {},
    fetchImpl: async () => { requests++; entered(); await pending; return Response.json({ data: { status: "ran", claimed: 1, succeeded: 1 } }); },
  });
  await started;
  const stopping = runner.stop();
  unblock();
  await Promise.all([runner.ready, stopping]);
  assert.equal(requests, 1);
  assert.equal(releases, 1);
});
