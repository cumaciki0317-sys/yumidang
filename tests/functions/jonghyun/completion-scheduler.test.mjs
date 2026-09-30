import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCompletionScheduler } from "../../../backend/supabase/functions/_shared/jobs/completion-scheduler.mjs";
import { readCompletionConfig, startCompletionRunner } from "../../../backend/supabase/functions/scheduled-jobs/completion-runner.mjs";

const id = "10000000-0000-4000-8000-000000000001";
const generation = "20000000-0000-4000-8000-000000000001";
const at = Date.parse("2026-09-29T00:00:00Z");
const row = (due = at + 60_000) => ({ appointmentId: id, generation, dueAt: new Date(due).toISOString() });
function harness(initial = [row()]) {
  let rows = initial, now = at;
  const timers = new Map(), executions = [], errors = [];
  let reads = 0;
  const scheduler = createCompletionScheduler({
    repository: {
      list: async () => { reads++; return { serverNow: new Date(now).toISOString(), reservations: rows }; },
      execute: async (...args) => { executions.push(args); rows = []; return { status: "completed" }; },
    },
    setTimer: (fn, ms) => { const key = {}; timers.set(key, { fn, ms }); return key; },
    clearTimer: (key) => timers.delete(key), monotonicNow: () => 0,
    onError: (code) => errors.push(code),
  });
  return { scheduler, timers, executions, errors, get reads() { return reads; },
    update(next, clock = now) { rows = next; now = clock; },
    async fire() { const [key, value] = [...timers][0]; timers.delete(key); value.fn(); await tick(); },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("no reservations creates no recurring poll, upcoming reservation arms one due-time wakeup", async () => {
  const h = harness([]); await h.scheduler.wake();
  assert.equal(h.timers.size, 0); assert.equal(h.reads, 1);
  h.update([row()]); await h.scheduler.wake();
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, 60_000);
  assert.deepEqual(h.executions, []); await h.scheduler.stop(); assert.equal(h.timers.size, 0);
});
test("due wake executes that reservation and generation, then becomes idle", async () => {
  const h = harness(); await h.scheduler.wake(); h.update([row()], at + 60_000);
  await h.fire(); assert.deepEqual(h.executions, [[id, generation]]);
  await h.fire(); assert.equal(h.timers.size, 0); await h.scheduler.stop();
});
test("change notification replaces timer; cancellation removes it", async () => {
  const h = harness(); await h.scheduler.wake();
  h.update([row(at + 120_000)]); await h.scheduler.wake();
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, 120_000);
  h.update([]); await h.scheduler.wake(); assert.equal(h.timers.size, 0);
  assert.deepEqual(h.executions, []); await h.scheduler.stop();
});
test("restart loads overdue reservation and completes it without waiting for periodic scan", async () => {
  const h = harness([row(at - 1)]); await h.scheduler.wake();
  assert.deepEqual(h.executions, [[id, generation]]); await h.scheduler.stop();
});
test("invalid snapshot stops with a fixed error code and exposes no source data", async () => {
  const h = harness([row(), row()]); await h.scheduler.wake();
  assert.deepEqual(h.errors, ["COMPLETION_SCHEDULER_UNAVAILABLE"]);
  assert.deepEqual(h.executions, []); assert.equal(h.timers.size, 0);
});
test("notification while snapshot is loading is not lost", async () => {
  let resolveFirst, reads = 0;
  const timers = new Map();
  const s = createCompletionScheduler({ repository: {
    list: async () => { reads++; if (reads === 1) return new Promise((resolve) => { resolveFirst = resolve; }); return { serverNow: new Date(at).toISOString(), reservations: [row()] }; },
    execute: async () => assert.fail("not due"),
  }, setTimer: (f, ms) => { const k = {}; timers.set(k, ms); return k; }, clearTimer: (k) => timers.delete(k), monotonicNow: () => 0 });
  const first = s.wake(); s.wake(); resolveFirst({ serverNow: new Date(at).toISOString(), reservations: [] });
  await first; assert.equal(reads, 2); assert.equal([...timers.values()][0], 60_000); await s.stop();
});
test("configuration has explicit reconnect/query limits and no remote TLS downgrade", () => {
  const env = { COMPLETION_DATABASE_URL: "postgres://worker:secret@localhost:55422/postgres", COMPLETION_RECONNECT_MS: "10", COMPLETION_QUERY_TIMEOUT_MS: "1000" };
  assert.equal(readCompletionConfig(env).reconnectMs, 10);
  assert.throws(() => readCompletionConfig({ ...env, COMPLETION_RECONNECT_MS: undefined }));
  assert.throws(() => readCompletionConfig({ ...env, COMPLETION_DATABASE_URL: "postgres://worker:secret@db.example/postgres?sslmode=disable" }));
  assert.throws(() => readCompletionConfig({ ...env, COMPLETION_DATABASE_URL: "postgres://worker:secret@localhost/postgres?host=db.example" }));
  assert.deepEqual(readCompletionConfig({ ...env, COMPLETION_DATABASE_URL: "postgres://worker:secret@db.example/postgres" }).ssl, { rejectUnauthorized: true });
});
test("runner LISTENs before snapshot and reconnects with a fresh snapshot", async () => {
  const clients = [], calls = [], reports = [];
  class Client extends EventEmitter {
    constructor() { super(); clients.push(this); }
    async connect() { calls.push("connect"); }
    async query(text) { calls.push(text.startsWith("LISTEN") ? "listen" : "snapshot"); return { rows: [{ result: { serverNow: new Date(at).toISOString(), reservations: [] } }] }; }
    async end() { this.emit("end"); }
  }
  const runner = startCompletionRunner({ Client, config: { databaseUrl: "unused", reconnectMs: 2, queryTimeoutMs: 100 }, report: (c) => reports.push(c) });
  await runner.ready; assert.deepEqual(calls.slice(0, 3), ["connect", "listen", "snapshot"]);
  clients[0].emit("error", new Error("SECRET must not appear"));
  for (let n = 0; clients.length < 2 && n < 30; n++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(clients.length, 2); assert.deepEqual(calls.slice(3, 6), ["connect", "listen", "snapshot"]);
  assert.ok(reports.includes("COMPLETION_CONNECTION_UNAVAILABLE")); assert.ok(!JSON.stringify(reports).includes("SECRET"));
  await runner.stop();
});
