/** Standalone persistent Node process; do not run long-lived timers in an Edge request. */
import { pathToFileURL } from "node:url";
import { createCompletionScheduler } from "../_shared/jobs/completion-scheduler.mjs";

const CHANNEL = "yumidang_completion_reservations";
export function readCompletionConfig(env) {
  const databaseUrl = env.COMPLETION_DATABASE_URL;
  const parsed = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.hash || parsed.search) throw new Error("INVALID_COMPLETION_CONFIG");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  const requireTls = env.COMPLETION_REQUIRE_TLS;
  if (requireTls !== undefined && requireTls !== "true") throw new Error("INVALID_COMPLETION_CONFIG");
  // pg query parameters can override both host and SSL; only the explicit authority is accepted.
  const positive = (key) => {
    const raw = env[key];
    if (!/^[1-9][0-9]*$/.test(raw ?? "")) throw new Error("INVALID_COMPLETION_CONFIG");
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n > 2_147_483_647) throw new Error("INVALID_COMPLETION_CONFIG");
    return n;
  };
  return { databaseUrl, ssl: local && requireTls === undefined ? false : { rejectUnauthorized: true },
    reconnectMs: positive("COMPLETION_RECONNECT_MS"), queryTimeoutMs: positive("COMPLETION_QUERY_TIMEOUT_MS") };
}

/** Reconnection resubscribes before loading persistent reservations, including overdue ones. */
export function startCompletionRunner({ Client, config, report = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false, reconnectTimer = null, session = null, connecting = null;
  function retry() {
    if (!stopped && reconnectTimer === null) reconnectTimer = setTimer(() => {
      reconnectTimer = null; void connect();
    }, config.reconnectMs);
  }
  async function discard(current) {
    if (current.closed) return;
    current.closed = true;
    if (session === current) session = null;
    // Do not await scheduler.stop from its own error callback.
    await current.scheduler?.stop();
    try { await current.client.end(); } catch { /* Only a fixed result code is reported. */ }
  }
  function failed(current) {
    if (current.failed || current.closed) return;
    current.failed = true;
    report("COMPLETION_CONNECTION_UNAVAILABLE");
    queueMicrotask(() => { void discard(current).finally(retry); });
  }
  async function connect() {
    if (stopped || connecting || session) return;
    connecting = (async () => {
      const client = new Client({ connectionString: config.databaseUrl, ssl: config.ssl,
        connectionTimeoutMillis: config.queryTimeoutMs, query_timeout: config.queryTimeoutMs,
        statement_timeout: config.queryTimeoutMs, keepAlive: true, application_name: "yumidang-completion-scheduler" });
      const current = { client, scheduler: null, closed: false, failed: false };
      session = current;
      client.on("error", () => failed(current));
      client.on("end", () => { if (!current.closed) failed(current); });
      client.on("notification", (message) => {
        if (message.channel === CHANNEL && !current.failed) void current.scheduler?.wake();
      });
      try {
        await client.connect();
        if (stopped || current.failed) { await discard(current); return; }
        current.scheduler = createCompletionScheduler({
          repository: {
            async list() { return (await client.query("select public.list_completion_reservations() as result")).rows[0]?.result; },
            async execute(id, generation) {
              return (await client.query("select public.execute_completion_reservation($1::uuid,$2::uuid) as result", [id, generation])).rows[0]?.result;
            },
          },
          onError: () => failed(current), setTimer, clearTimer,
        });
        await client.query(`LISTEN ${CHANNEL}`);
        if (stopped || current.failed) { await discard(current); return; }
        await current.scheduler.wake();
        if (!current.failed) report("COMPLETION_SCHEDULER_READY");
      } catch { failed(current); }
    })().finally(() => { connecting = null; });
    await connecting;
  }
  const ready = connect();
  return {
    ready,
    async stop() {
      stopped = true;
      if (reconnectTimer !== null) clearTimer(reconnectTimer);
      await connecting;
      if (session) await discard(session);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readCompletionConfig(process.env);
    const { Client } = await import("pg");
    const runner = startCompletionRunner({ Client, config, report: (code) => process.stderr.write(`${code}\n`) });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void runner.stop(); });
    await runner.ready;
  } catch {
    process.stderr.write("COMPLETION_SCHEDULER_NOT_CONFIGURED\n");
    process.exitCode = 1;
  }
}
