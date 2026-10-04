/** 별도 Node 큐 실행기. completion DB 자격증명/권한을 재사용하거나 확대하지 않는다.
 * 아래3개 schedule/lease RPC는 민규 채택 전 연결 계약이며 함수 누락/권한 거절 시 READY를 보고하지 않는다.
 */
import { pathToFileURL } from "node:url";
import { createBackgroundQueueScheduler } from "../_shared/jobs/background.mjs";
const CHANNEL = "yumidang_worker_jobs";
export const QUEUE_RUNNER_RPCS = [
  "read_worker_queue_schedule",
  "acquire_worker_run",
  "release_worker_run",
];

export function readQueueRunnerConfig(env) {
  let db, url;
  try {
    db = new URL(env.WORKER_QUEUE_DATABASE_URL);
    url = new URL(env.WORKER_QUEUE_FUNCTION_URL);
  } catch {
    throw new Error("QUEUE_RUNNER_NOT_CONFIGURED");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(db.hostname);
  if (
    !["postgres:", "postgresql:"].includes(db.protocol) || db.search ||
    db.hash ||
    url.protocol !== "https:" || url.username || url.password || url.search ||
    url.hash ||
    url.pathname !== "/functions/v1/review-summary-worker" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(env.WORKER_QUEUE_DB_CONTRACT_ID ?? "") ||
    !/^[A-Za-z0-9_-]{32,512}$/.test(env.INTERNAL_WORKER_SECRET ?? "")
  ) throw new Error("QUEUE_RUNNER_NOT_CONFIGURED");
  const positive = (key, maximum) => {
    const raw = env[key];
    if (!/^[1-9][0-9]*$/.test(raw ?? "")) {
      throw new Error("QUEUE_RUNNER_NOT_CONFIGURED");
    }
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n > maximum) {
      throw new Error("QUEUE_RUNNER_NOT_CONFIGURED");
    }
    return n;
  };
  return {
    databaseUrl: db.href,
    ssl: local ? false : { rejectUnauthorized: true },
    functionUrl: url.href,
    workerSecret: env.INTERNAL_WORKER_SECRET,
    queryTimeoutMs: positive("WORKER_QUEUE_QUERY_TIMEOUT_MS", 10_000),
    reconnectMs: positive("WORKER_QUEUE_RECONNECT_MS", 2_147_483_647),
    timeoutMs: positive("WORKER_QUEUE_HTTP_TIMEOUT_MS", 75_000),
    leaseSeconds: 180,
  };
}

/** 준비/재접속 때 LISTEN을 먼저 복원한 뒤 due/만료 작업을 조회한다. */
export function startQueueRunner(
  {
    Client,
    config,
    fetchImpl = fetch,
    report = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  },
) {
  let stopped = false, session = null, connecting = null, retryTimer = null;
  function retry() {
    if (!stopped && retryTimer === null) {
      retryTimer = setTimer(() => {
        retryTimer = null;
        void connect();
      }, config.reconnectMs);
    }
  }
  async function dispose(current) {
    if (current.closed) return;
    current.closed = true;
    if (session === current) session = null;
    await current.scheduler?.stop();
    try {
      await current.client.end();
    } catch { /* 비밀/DB 오류 원문 출력 없음 */ }
  }
  function failed(current) {
    if (current.failed || current.closed) return;
    current.failed = true;
    report("WORKER_QUEUE_UNAVAILABLE");
    queueMicrotask(() => {
      void dispose(current).finally(retry);
    });
  }
  async function connect() {
    if (stopped || session || connecting) return;
    connecting = (async () => {
      const client = new Client({
        connectionString: config.databaseUrl,
        ssl: config.ssl,
        connectionTimeoutMillis: config.queryTimeoutMs,
        query_timeout: config.queryTimeoutMs,
        statement_timeout: config.queryTimeoutMs,
        application_name: "yumidang-worker-queue",
      });
      const current = { client, scheduler: null, failed: false, closed: false };
      session = current;
      client.on("error", () => failed(current));
      client.on("end", () => {
        if (!current.closed) failed(current);
      });
      client.on("notification", (message) => {
        if (message.channel === CHANNEL && !current.failed) {
          void current.scheduler?.wake();
        }
      });
      try {
        await client.connect();
        if (stopped || current.failed) {
          await dispose(current);
          return;
        }
        current.scheduler = createBackgroundQueueScheduler({
          repository: {
            async schedule({ excludeKinds, afterKind }) {
              return (await client.query(
                "select public.read_worker_queue_schedule($1::text[],$2::text) as result",
                [excludeKinds, afterKind],
              )).rows[0]?.result;
            },
            async acquire() {
              return (await client.query(
                "select public.acquire_worker_run($1::integer,null::uuid) as result",
                [config.leaseSeconds],
              )).rows[0]?.result;
            },
            async release(token) {
              return (await client.query(
                "select public.release_worker_run($1::uuid) as result",
                [token],
              )).rows[0]?.result?.status;
            },
          },
          async invoke(token, kind) {
            const controller = new AbortController();
            const timer = setTimer(() => controller.abort(), config.timeoutMs);
            try {
              const target = kind === "event_sync"
                ? new URL("/functions/v1/event-sync/worker", config.functionUrl)
                  .href
                : config.functionUrl;
              const response = await fetchImpl(target, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${config.workerSecret}`,
                  "Content-Type": "application/json",
                  "x-worker-run-token": token,
                },
                body: "{}",
                redirect: "error",
                credentials: "omit",
                signal: controller.signal,
              });
              const body = await response.json();
              if (
                response.status !== 200 || !body || body.error || !body.data ||
                !["ran", "not_enabled"].includes(body.data.status)
              ) throw new Error("QUEUE_INVOKE_UNAVAILABLE");
              return body.data;
            } finally {
              clearTimer(timer);
            }
          },
          onError: () => failed(current),
          setTimer,
          clearTimer,
        });
        await client.query(`LISTEN ${CHANNEL}`);
        await current.scheduler.wake();
        if (!current.failed && !stopped) report("WORKER_QUEUE_READY");
      } catch {
        failed(current);
      }
    })().finally(() => {
      connecting = null;
    });
    await connecting;
  }
  const ready = connect();
  return {
    ready,
    async stop() {
      stopped = true;
      if (retryTimer !== null) clearTimer(retryTimer);
      await connecting;
      if (session) await dispose(session);
    },
  };
}

if (
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const config = readQueueRunnerConfig(process.env);
    const { Client } = await import("pg");
    const runner = startQueueRunner({
      Client,
      config,
      report: (code) => process.stderr.write(`${code}\n`),
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        void runner.stop();
      });
    }
    await runner.ready;
  } catch {
    process.stderr.write("WORKER_QUEUE_NOT_CONFIGURED\n");
    process.exitCode = 1;
  }
}
