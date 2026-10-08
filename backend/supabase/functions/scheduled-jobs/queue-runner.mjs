/** 별도 Node 큐 실행기. completion DB 자격증명/권한을 재사용하거나 확대하지 않는다.
 * 아래3개 schedule/lease RPC는 민규 채택 전 연결 계약이며 함수 누락/권한 거절 시 READY를 보고하지 않는다.
 */
import { pathToFileURL } from "node:url";
import { X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import { createBackgroundQueueScheduler, createSharedBackgroundQueueScheduler, createDueMaintenanceGroup, QUEUE_KINDS } from "../_shared/jobs/background.mjs";
const CHANNEL = "yumidang_worker_jobs";
const QUEUE_ROLE = "yumidang_worker_queue";
export const QUEUE_RUNNER_RPCS = [
  "read_worker_queue_schedule",
  "acquire_worker_run",
  "release_worker_run",
];

/** 실제 DB 포트+기존 종류 소비자가 모두 제공된 경우만 5종/helpful runtime을 조립한다.
 * CLI가 계약/자격증명/영속 journal을 자동 생성하지 않는다. HTTP 구 worker 대체 경로도 없다.
 */
export function createSharedQueueRuntime({ schedule, contracts, maintenanceProviders, invokeSafety, invokeExisting, supportedKinds = QUEUE_KINDS, elapsed }) {
  if (typeof schedule !== "function" || typeof invokeSafety !== "function" || typeof invokeExisting !== "function" ||
    !contracts?.decisionId?.trim() || typeof contracts.readBudget !== "function" ||
    ["hasPending", "begin", "confirm", "unknown"].some(k => typeof contracts.journal?.[k] !== "function") ||
    !Array.isArray(supportedKinds) || !supportedKinds.length || new Set(supportedKinds).size !== supportedKinds.length || supportedKinds.some(k => !QUEUE_KINDS.includes(k))) throw new Error("SHARED_QUEUE_CONTRACT_NOT_READY");
  const maintenance = createDueMaintenanceGroup(maintenanceProviders, elapsed);
  return Object.freeze({ schedule, invokeSafety, invokeExisting, supportedKinds: Object.freeze([...supportedKinds]),
    contracts: Object.freeze({ ...contracts, maintenance,
      unitsFor(kind, result) {
        if (kind === null) return result.processedItems;
        if (result.status === "not_enabled") return 0;
        return ["cancellation_safety", "report_retention"].includes(kind) ? result.counts.processedItems : result.counts.claimed;
      },
    }),
  });
}

export function readQueueRunnerConfig(env) {
  let db, url;
  try {
    db = new URL(env.WORKER_QUEUE_DATABASE_URL);
    url = new URL(env.WORKER_QUEUE_FUNCTION_URL);
  } catch {
    throw new Error("QUEUE_RUNNER_NOT_CONFIGURED");
  }
  const ca = env.WORKER_QUEUE_DB_CA_PEM;
  try {
    if (typeof ca !== "string") throw new Error();
    const certificates = [...ca.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)];
    if (!certificates.length || ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) throw new Error();
    // OpenSSL의 CA store는 손상된 PEM을 조용히 무시할 수 있으므로 각 인증서를 먼저 파싱한다.
    for (const [pem] of certificates) new X509Certificate(pem);
    createSecureContext({ ca });
  } catch {
    throw new Error("QUEUE_RUNNER_NOT_CONFIGURED");
  }
  if (
    !["postgres:", "postgresql:"].includes(db.protocol) || db.search ||
    db.hash || !db.username || !db.password || !db.hostname ||
    url.protocol !== "https:" || url.username || url.password || url.search ||
    url.hash ||
    url.pathname !== "/functions/v1/review-summary-worker" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(env.WORKER_QUEUE_DB_CONTRACT_ID ?? "") ||
    !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(env.WORKER_QUEUE_DB_LOGIN_ROLE ?? "") ||
    env.WORKER_QUEUE_DB_LOGIN_ROLE === QUEUE_ROLE ||
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
    // 로컬도 승인된 CA와 호스트 이름을 TLS handshake에서 검증한다.
    ssl: { rejectUnauthorized: true, ca },
    contractId: env.WORKER_QUEUE_DB_CONTRACT_ID,
    expectedLoginRole: env.WORKER_QUEUE_DB_LOGIN_ROLE,
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
    // 5kind는 공통 계약 확정 뒤에만 조립한다. CLI는 준비 포트를 자동 생성하지 않는다.
    sharedRuntime,
  },
) {
  // 테스트/호출자의 직접 주입도 TLS와 고정 목적지 검사를 생략할 수 없다.
  if (!config?.ssl || config.ssl.rejectUnauthorized !== true || config.leaseSeconds !== 180) {
    throw new Error("QUEUE_RUNNER_NOT_CONFIGURED");
  }
  config = readQueueRunnerConfig({
    WORKER_QUEUE_DATABASE_URL: config.databaseUrl,
    WORKER_QUEUE_FUNCTION_URL: config.functionUrl,
    WORKER_QUEUE_DB_CA_PEM: config.ssl.ca,
    WORKER_QUEUE_DB_CONTRACT_ID: config.contractId,
    WORKER_QUEUE_DB_LOGIN_ROLE: config.expectedLoginRole,
    INTERNAL_WORKER_SECRET: config.workerSecret,
    WORKER_QUEUE_QUERY_TIMEOUT_MS: String(config.queryTimeoutMs),
    WORKER_QUEUE_RECONNECT_MS: String(config.reconnectMs),
    WORKER_QUEUE_HTTP_TIMEOUT_MS: String(config.timeoutMs),
  });
  if (sharedRuntime !== undefined && (!sharedRuntime || typeof sharedRuntime.schedule !== "function" ||
    typeof sharedRuntime.invokeSafety !== "function" || typeof sharedRuntime.invokeExisting !== "function" ||
    !sharedRuntime.contracts)) throw new Error("SHARED_QUEUE_CONTRACT_NOT_READY");
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
        if ((message.channel === CHANNEL || sharedRuntime && message.channel === "yumidang_cancellation_due") && !stopped && !current.failed && !current.closed) {
          void current.scheduler?.wake();
        }
      });
      try {
        await client.connect();
        if (stopped || current.failed || current.closed) {
          await dispose(current);
          return;
        }
        await client.query(`SET ROLE ${QUEUE_ROLE}`);
        if (stopped || current.failed || current.closed) {
          await dispose(current);
          return;
        }
        const identity = (await client.query(
          'SELECT current_user AS "currentRole", session_user AS "loginRole"',
        )).rows;
        if (stopped || current.failed || current.closed) {
          await dispose(current);
          return;
        }
        if (identity?.length !== 1 || identity[0].currentRole !== QUEUE_ROLE ||
          identity[0].loginRole !== config.expectedLoginRole) {
          throw new Error("QUEUE_IDENTITY_UNAVAILABLE");
        }
        const schedulerOptions = {
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
            const paths = {
              review_summary: "/functions/v1/review-summary-worker",
              event_sync: "/functions/v1/event-sync/worker",
              member_cleanup: "/functions/v1/service-api/internal/member-cleanup",
            };
            if (!Object.hasOwn(paths, kind)) {
              const error = new Error("QUEUE_INVOKE_UNAVAILABLE");
              error.releasePermitted = true; // 아직 HTTP 요청을 시작하지 않았다.
              throw error;
            }
            const controller = new AbortController();
            const timer = setTimer(() => controller.abort(), config.timeoutMs);
            try {
              const target = new URL(paths[kind], config.functionUrl).href;
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
                controller.signal.aborted || response.status !== 200 || !body || body.error || !body.data ||
                !["ran", "not_enabled"].includes(body.data.status)
              ) throw new Error("QUEUE_INVOKE_UNAVAILABLE");
              const data = body.data;
              if (kind === "member_cleanup") {
                const keys = Object.keys(data);
                if (data.status !== "ran" || keys.length !== 3 ||
                  !keys.every((key) => ["status", "claimed", "succeeded"].includes(key)) ||
                  !Number.isSafeInteger(data.claimed) || data.claimed < 0 || data.claimed > 20 ||
                  !Number.isSafeInteger(data.succeeded) || data.succeeded < 0 || data.succeeded > data.claimed) throw new Error();
                return { status: "ran", counts: { claimed: data.claimed, succeeded: data.succeeded } };
              }
              if (data.status === "not_enabled") {
                if (typeof data.reason !== "string" || !data.reason.trim()) throw new Error();
                return { status: "not_enabled", reason: data.reason };
              }
              const count = (n) => Number.isSafeInteger(n) && n >= 0;
              if (!data.counts || typeof data.counts !== "object" || Array.isArray(data.counts) ||
                !count(data.counts.claimed) || !Object.values(data.counts).every(count) ||
                !["idle", "max_jobs", "time_budget", "budget_exhausted", "dependency_unavailable"].includes(data.stopReason) ||
                typeof data.hasMore !== "boolean") throw new Error();
              return data;
            } catch {
              // 응답 소실/잘못된 DTO/시간 초과는 원격 종료를 증명하지 않는다.
              const error = new Error("QUEUE_INVOKE_UNAVAILABLE");
              error.releasePermitted = false;
              throw error;
            } finally {
              clearTimer(timer);
            }
          },
          onError: () => failed(current),
          setTimer,
          clearTimer,
        };
        if (sharedRuntime) {
          schedulerOptions.repository.schedule = sharedRuntime.schedule;
          schedulerOptions.contracts = sharedRuntime.contracts;
          if (sharedRuntime.supportedKinds) schedulerOptions.supportedKinds = sharedRuntime.supportedKinds;
          schedulerOptions.queryTimeoutMs = config.queryTimeoutMs;
          // 구 HTTP worker는 현재 공유 limit/signal을 소비하지 않는다. 해당 소비자 어댑터도 명시 제공해야 한다.
          schedulerOptions.invoke = (token, kind, options) =>
            ["cancellation_safety", "report_retention"].includes(kind)
              ? sharedRuntime.invokeSafety(token, kind, options)
              : sharedRuntime.invokeExisting(token, kind, options);
          current.scheduler = createSharedBackgroundQueueScheduler(schedulerOptions);
        } else current.scheduler = createBackgroundQueueScheduler(schedulerOptions);
        await client.query(`LISTEN ${CHANNEL}`);
        if (sharedRuntime) await client.query("LISTEN yumidang_cancellation_due");
        if (stopped || current.failed || current.closed) {
          await dispose(current);
          return;
        }
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
      // 초기 wake도 connect() 안에서 기다린다. 연결 promise보다 먼저 drain을 중단해
      // 진행 중 HTTP의 종결 뒤 새 due 작업을 시작하지 않도록 한다.
      await session?.scheduler?.stop();
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
