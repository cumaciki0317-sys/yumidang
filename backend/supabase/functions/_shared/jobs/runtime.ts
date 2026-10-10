/** 실제 공통 DB 포트를 조립한다. 영속 cycle 증거와 각 지원 종류의 슬롯 연결이 준비되지 않으면 CLI를 시작하지 않는다. */
import { loadRuntimeConfig, requireInternalConfig } from "../config/env.ts";
import { createMemberParentFinalizationScanner, type ApprovedMemberParentFinalization } from "../db/member-cleanup-finalization.ts";
import { createInternalClient } from "../db/internal-client.ts";
import { createWorkerConnectionPorts, createWorkerInvocationRuntime, createWorkerScopedIntentRuntime, type WorkerScopedInvocationPort, type WorkerScopedRequest, type WorkerInvocationInput } from "../db/worker-runtime-client.ts";
import type { RpcClient, FetchLike } from "../db/transport.ts";
import { createSafetyWorkerInvocation, type SafetyReadiness, type SafetyExecutionBudget } from "./safety-consumers.ts";
import { validateRetrySettings, type RetrySettings } from "./retry.ts";
import { toPublicError } from "../http/errors.ts";
import { createAiFeedbackMaintenance, type FeedbackMaintenancePorts } from "./ai-feedback-maintenance.ts";
import { createSharedQueueRuntime } from "../../scheduled-jobs/queue-runner.mjs";

export interface ApprovedReviewQueueReadiness {
  /** 운영 환경 문자열이나 HTTP 요청이 아닌, 실제 handler·검사기 검토를 끝낸 서버 조립값. 기본값은 없다. */
  approved: true;
  decisionId: string;
  maxJobsPerRun: number;
  timeBudgetMs: number;
}
export interface ApprovedExistingQueueReadiness extends ApprovedReviewQueueReadiness {
  kind: "event_sync" | "member_cleanup";
}
export interface ApprovedSafetyQueueReadiness extends ApprovedReviewQueueReadiness {
  kind: "cancellation_safety" | "report_retention";
  /** 검토된 DB114·guard/ACL·Storage 서버 조립 증거. 환경/요청 boolean을 사용하지 않는다. */
  readiness: SafetyReadiness;
  retry: RetrySettings;
}
export interface QueueInvocationOptions { limit: number; remainingMs: number; signal: AbortSignal; requestId?: string }
export interface DurableQueueRuntimePorts {
  /** 검토된 DB 계약 식별자와 실제 다섯 종류의 원자 slot 연결 증거. 환경 문자열만으로 승인하지 않는다. */
  decisionId: string;
  capabilities: Readonly<Record<string, boolean>>;
  allocate?(kind: string, remainingJobs: number, remainingMs: number): { limit: number; timeBudgetMs: number };
  schedule(input: { excludeKinds: string[]; afterKind: string | null; globalToken: string | null }): Promise<unknown>;
  journal: {
    hasPending(signal?: AbortSignal): Promise<boolean>;
    begin(input: { globalToken: string; kind: string | null; limit: number; remainingMs: number }): Promise<string>;
    /** DB 확정 결과/원 ACK 검증만 true. observed_response나 lease 만료는 false다. */
    confirm(requestId: string): Promise<boolean>;
    unknown(requestId: string | null): Promise<void>;
  };
  feedback: Omit<FeedbackMaintenancePorts, "readSchedule" | "readResult">;
  /** runtime 종결 상세·신고 종결 증거는 공급한 개별 배정을 쓰며 helpful과도 슬롯을 합산하지 않는다. */
  terminalProviders: readonly { readSchedule(token: string | null): Promise<unknown>; run(token: string, options: QueueInvocationOptions): Promise<unknown> }[];
  invokeSafety(token: string, kind: string, options: QueueInvocationOptions): Promise<unknown>;
  invokeExisting(token: string, kind: string, options: QueueInvocationOptions): Promise<unknown>;
}

export function createConfiguredQueueRuntime(env: Record<string, string | undefined>, queueConfig: { contractId: string; workerSecret: string; functionUrl: string; timeoutMs?: number }, options: {
  ports?: DurableQueueRuntimePorts;
  review?: ApprovedReviewQueueReadiness;
  existing?: readonly ApprovedExistingQueueReadiness[];
  safety?: readonly ApprovedSafetyQueueReadiness[];
  memberParentFinalization?: ApprovedMemberParentFinalization;
  db?: RpcClient;
  fetch?: FetchLike;
} = {}) {
  const config = loadRuntimeConfig(key => env[key]);
  requireInternalConfig(config);
  const target = new URL(queueConfig.functionUrl);
  if (target.origin !== config.supabaseUrl || queueConfig.workerSecret !== config.internalWorkerSecret) throw new Error("SHARED_QUEUE_CONTRACT_NOT_READY");
  const db = options.db ?? createInternalClient(config, options.fetch);
  const defaultAssembly = options.ports ? null : createMaintenanceOnlyPorts(config, queueConfig, db, options.fetch, options.db !== undefined, options.review, options.existing, options.safety);
  const ports = options.ports ?? defaultAssembly!.ports;
  // 지원별 DB cycle·slot 연결을 명시한다. 지원되지 않는 종류로 조용히 내려가지 않는다.
  if (!ports || ports.decisionId !== queueConfig.contractId || !ports.capabilities || !Array.isArray(ports.terminalProviders) || !ports.terminalProviders.length) throw new Error("SHARED_QUEUE_CONTRACT_NOT_READY");
  const kinds = ["review_summary", "event_sync", "member_cleanup", "cancellation_safety", "report_retention"];
  if (Object.keys(ports.capabilities).some(kind => !kinds.includes(kind)) || Object.values(ports.capabilities).some(v => typeof v !== "boolean")) throw new Error("SHARED_QUEUE_CONTRACT_NOT_READY");
  const supportedKinds = kinds.filter(kind => ports.capabilities[kind] === true);
  if (supportedKinds.length && typeof ports.allocate !== "function") throw new Error("SHARED_QUEUE_CONTRACT_NOT_READY");

  const connection = createWorkerConnectionPorts(db);
  // 서버 고정 승인만 허용한다. 기본 구성은 SQL118 조회조차 호출하지 않는다.
  const pendingDb = (signal?: AbortSignal) => !signal || options.db ? db : createInternalClient(config, (url, init) => {
    if (signal.aborted) throw new Error("QUEUE_PORT_UNAVAILABLE");
    return (options.fetch ?? fetch)(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
  });
  const memberFinalization = options.memberParentFinalization ? createMemberParentFinalizationScanner(db, options.memberParentFinalization, queueConfig.contractId, pendingDb) : null;
  const feedback = createAiFeedbackMaintenance(config, {
    ...ports.feedback, readSchedule: connection.feedbackSchedule,
    readResult: (requestId, signal) => signal.aborted ? Promise.reject(new Error("QUEUE_DEADLINE_UNKNOWN")) : defaultAssembly ? defaultAssembly.readFeedbackResult(requestId, signal) : connection.atomic.get(requestId),
  }, options.fetch);
  const shared = createSharedQueueRuntime({
    schedule: ports.schedule, supportedKinds, maintenanceProofVerified: true,
    contracts: {
      allocate: ports.allocate,
      decisionId: ports.decisionId,
      readSlots: connection.atomic.slots,
      async readBudget(token: string) { return db.rpc("read_worker_run_budget", { p_worker_run_token: token }); },
      // 양쪽 영속 기록을 확인하며 legacy observed_response는 자동 종결하지 않는다.
      journal: { ...ports.journal, async hasPending(signal?: AbortSignal) {
        // 공통 pending OR의 앞에 둔다. 기존 UNKNOWN이 true여도 발견/원 부모 종결은 건너뛰지 않는다.
        await memberFinalization?.scan(signal);
        if (signal?.aborted) throw new Error("QUEUE_PORT_UNAVAILABLE");
        const common = await createWorkerConnectionPorts(pendingDb(signal)).hasPending();
        if (signal?.aborted) throw new Error("QUEUE_PORT_UNAVAILABLE");
        return common || await ports.journal.hasPending(signal);
      } },
    },
    maintenanceProviders: [feedback, ...ports.terminalProviders],
    invokeSafety: ports.invokeSafety, invokeExisting: ports.invokeExisting,
  });
  return defaultAssembly ? Object.freeze({ ...shared, scheduleForClient: defaultAssembly.scheduleForClient, preflight: defaultAssembly.preflight }) : shared;
}

/** 운영 기본 조립은 회원 AI capability를 자동 활성화하지 않는다. 실제DB109 유지관리 증거부터 연결한다. */
function createMaintenanceOnlyPorts(config: ReturnType<typeof loadRuntimeConfig>, queueConfig: { contractId: string; workerSecret: string; functionUrl: string; timeoutMs?: number }, db: RpcClient, fetchImpl: FetchLike = fetch, suppliedDb = false, review?: ApprovedReviewQueueReadiness, existing: readonly ApprovedExistingQueueReadiness[] = [], safety: readonly ApprovedSafetyQueueReadiness[] = []) {
  const approved = new Map<string, ApprovedReviewQueueReadiness>();
  const add = (kind: string, value: ApprovedReviewQueueReadiness, maxTime: number) => {
    if (approved.has(kind) || value.approved !== true || value.decisionId !== queueConfig.contractId ||
        !Number.isSafeInteger(value.maxJobsPerRun) || value.maxJobsPerRun < 1 || value.maxJobsPerRun > 10 ||
        !Number.isSafeInteger(value.timeBudgetMs) || value.timeBudgetMs < 1 || value.timeBudgetMs > maxTime) throw new Error("SHARED_QUEUE_CONTRACT_NOT_READY");
    approved.set(kind, Object.freeze({ ...value }));
  };
  if (review) add("review_summary", review, 60000);
  if (!Array.isArray(existing)) throw new Error("SHARED_QUEUE_CONTRACT_NOT_READY");
  for (const value of existing) {
    if (!value || !["member_cleanup", "event_sync"].includes(value.kind)) throw new Error("SHARED_QUEUE_CONTRACT_NOT_READY");
    add(value.kind, value, value.kind === "event_sync" ? 60000 : 180000);
  }
  const safetyApproved = new Map<string, Readonly<ApprovedSafetyQueueReadiness>>();
  const requiredSafetyRpcs = ["prepare_worker_invocation_intent", "execute_worker_invocation_operation", "confirm_worker_runtime_intent", "get_worker_runtime_intent", "observe_worker_runtime_intent", "get_worker_runtime_operation"];
  if (!Array.isArray(safety)) throw new Error("SHARED_QUEUE_CONTRACT_NOT_READY");
  for (const value of safety) {
    if (!value || !["cancellation_safety", "report_retention"].includes(value.kind) || safetyApproved.has(value.kind)) throw new Error("SHARED_QUEUE_CONTRACT_NOT_READY");
    const r = value.readiness;
    // Missing readiness/transport never enables a lane. Required bits vary by kind.
    if (!r || Object.values(r).some(v => typeof v !== "boolean") || !r.scopedClaim || !r.sharedBudgetContract || !r.durableJournalContract ||
        (value.kind === "cancellation_safety" ? !r.cancellationGuardAndAcl : !r.reportGuardAndAcl || !r.reportTerminalScheduleContract || !r.storageProviderApproved) ||
        db.supportsRpc && requiredSafetyRpcs.some(name => !db.supportsRpc!(name))) continue;
    validateRetrySettings(value.retry);
    add(value.kind, value, 60000);
    safetyApproved.set(value.kind, Object.freeze({ ...value, readiness: Object.freeze({ ...r }), retry: Object.freeze({ ...value.retry }) }));
  }
  async function verifySafetyPorts(kind: string) {
    if (!safetyApproved.has(kind)) throw new Error("QUEUE_KIND_NOT_READY");
    // NULL is rejected after114 guards and before every lookup/mutation. A missing
    // function, closed control or denied EXEC cannot masquerade as this result.
    const probes = [
      ["prepare_worker_invocation_intent", { p_request_id: null, p_parent_invocation_id: null, p_operation: "job_claim", p_scope: null, p_predecessor_request_id: null }],
      ["execute_worker_invocation_operation", { p_request_id: null, p_parent_request_id: null, p_global_token: null, p_operation: "job_claim", p_input: null }],
      ["confirm_worker_runtime_intent", { p_request_id: null }],
    ] as const;
    for (const [name, args] of probes) {
      try { await db.rpc(name, args); }
      catch (error) { if (toPublicError(error).error.code === "INVALID_REQUEST") continue; throw new Error("QUEUE_KIND_NOT_READY"); }
      throw new Error("QUEUE_KIND_NOT_READY");
    }
  }
  const boundedApproval = (kind: string | null, limit: number, remainingMs: number) => {
    const value = kind === null ? undefined : approved.get(kind);
    if (!value || !Number.isSafeInteger(limit) || limit < 1 || limit > value.maxJobsPerRun ||
        !Number.isSafeInteger(remainingMs) || remainingMs < 1 || remainingMs > value.timeBudgetMs) throw new Error("QUEUE_KIND_NOT_READY");
    return value;
  };
  let queueClient: { query(sql: string, args?: unknown[]): Promise<{ rows: Array<{ result: unknown }> }> } | null = null;
  const connection = createWorkerConnectionPorts(db), invocation = createWorkerInvocationRuntime(db);
  const alive = (signal: AbortSignal) => { if (signal.aborted) throw new Error("QUEUE_DEADLINE_UNKNOWN"); };
  const scopedDb = (signal: AbortSignal) => suppliedDb ? db : createInternalClient(config, (url, init) => {
    alive(signal);
    return fetchImpl(url, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
  });
  const scope = (value: Awaited<ReturnType<typeof invocation.getQueueInvocation>>, expected: WorkerInvocationInput) => {
    if (value.requestId !== expected.requestId || value.globalToken !== expected.globalToken || value.kind !== expected.kind || value.limit !== expected.limit || value.remainingMs !== expected.remainingMs) throw new Error("QUEUE_INVOCATION_CONFLICT");
    return value;
  };
  const requireSession = () => { if (!queueClient) throw new Error("QUEUE_SESSION_NOT_READY"); return queueClient; };
  const ports: DurableQueueRuntimePorts = {
    decisionId: queueConfig.contractId,
    capabilities: { review_summary: approved.has("review_summary"), event_sync: approved.has("event_sync"), member_cleanup: approved.has("member_cleanup"), cancellation_safety: safetyApproved.has("cancellation_safety"), report_retention: safetyApproved.has("report_retention") },
    allocate(kind, remainingJobs, remainingMs) {
      const value = approved.get(kind);
      if (!value) throw new Error("QUEUE_KIND_NOT_READY");
      return { limit: Math.min(remainingJobs, value.maxJobsPerRun), timeBudgetMs: Math.min(remainingMs, value.timeBudgetMs) };
    },
    schedule: async () => { throw new Error("QUEUE_SESSION_NOT_READY"); },
    journal: { hasPending: (signal?: AbortSignal) => createWorkerConnectionPorts(signal ? scopedDb(signal) : db).hasPending(),
      async begin(input) {
        boundedApproval(input.kind, input.limit, input.remainingMs);
        if (input.kind && safetyApproved.has(input.kind)) await verifySafetyPorts(input.kind);
        const requestId = crypto.randomUUID();
        const prepared = await invocation.prepareQueueInvocation({ ...input, kind: input.kind as WorkerInvocationInput["kind"], requestId });
        if (!prepared.fresh || prepared.state !== "prepared") throw new Error("QUEUE_RECONCILIATION_REQUIRED");
        return requestId;
      },
      async confirm(requestId) { return (await invocation.completeQueueInvocation(requestId)).state === "completed"; },
      unknown: async id => { if (id !== null) await invocation.markQueueInvocationUnknown(id); },
    },
    feedback: {
      scopedEndpointReady: true,
      async prepare(input, signal) {
        alive(signal);
        const runtime = createWorkerInvocationRuntime(scopedDb(signal));
        const prepared = await runtime.prepareQueueInvocation({ ...input, kind: "helpful_maintenance" });
        return { fresh: prepared.fresh };
      },
      async unknown(id, signal) { await createWorkerInvocationRuntime(signal ? scopedDb(signal) : db).markQueueInvocationUnknown(id); },
    },
    terminalProviders: [{
      async readSchedule(globalToken) {
        const raw = (await requireSession().query("select public.read_report_terminal_maintenance_schedule_v2($1::uuid) as result", [globalToken])).rows[0]?.result;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_MAINTENANCE_SCHEDULE");
        const value = raw as Record<string, unknown>;
        if (Object.keys(value).sort().join(",") !== "nextDueAt,ready,serverNow" || typeof value.ready !== "boolean") throw new Error("INVALID_MAINTENANCE_SCHEDULE");
        return { serverNow: value.serverNow, nextDueAt: value.ready ? value.nextDueAt : null };
      },
      run: (globalToken, options) => runDirectMaintenance("terminal_maintenance", globalToken, options),
    }, {
      readSchedule: connection.runtimeSchedule,
      run: (globalToken, options) => runDirectMaintenance("runtime_maintenance", globalToken, options),
    }],
    async invokeSafety(globalToken, kind, options) {
      boundedApproval(kind, options.limit, options.remainingMs);
      const approvedSafety = safetyApproved.get(kind);
      if (!approvedSafety || !options.requestId) throw new Error("QUEUE_KIND_NOT_READY");
      alive(options.signal);
      const expected: WorkerInvocationInput = { requestId: options.requestId, globalToken, kind: kind as WorkerInvocationInput["kind"], limit: options.limit, remainingMs: Math.floor(options.remainingMs) };
      const runtime = createWorkerInvocationRuntime(scopedDb(options.signal));
      const prepared = scope(await runtime.getQueueInvocation(expected.requestId), expected);
      if (prepared.state === "completed" && prepared.result && "status" in prepared.result) return prepared.result;
      if (prepared.state !== "prepared") throw new Error("QUEUE_RECONCILIATION_REQUIRED");
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), expected.remainingMs);
      const signal = AbortSignal.any([options.signal, controller.signal]);
      let dispatchedByThisCall = false;
      try {
        const claimed = await runtime.claimQueueInvocationDispatch(expected);
        if (claimed) {
          dispatchedByThisCall = true;
          alive(signal);
          const real = createWorkerScopedIntentRuntime(scopedDb(signal), { parentRequestId: expected.requestId, globalToken }, signal);
          const claims = new Map<string, Readonly<{ request: WorkerScopedRequest; leaseToken: string }>>();
          const atomic: WorkerScopedInvocationPort = Object.freeze({ ...real,
            async run(request: WorkerScopedRequest) {
              const original = structuredClone(request), result = await real.run(original);
              if (original.operation === "job_claim" && result.state === "completed" && result.result && typeof result.result === "object" && !Array.isArray(result.result)) {
                const job = result.result.job;
                if (job && typeof job === "object" && !Array.isArray(job) && typeof job.jobId === "string" && typeof job.leaseToken === "string" && job.kind === kind) claims.set(job.jobId, Object.freeze({ request: original, leaseToken: job.leaseToken }));
              }
              return result;
            },
          });
          const reserve: (token: string, operation: Parameters<SafetyExecutionBudget["reserve"]>[0]) => Promise<boolean> = async (token, _operation) => {
            if (token !== globalToken || signal.aborted) return false;
            const current = scope(await runtime.getQueueInvocation(expected.requestId), expected);
            if (current.state !== "prepared") return false;
            const budget = await db.rpc("read_worker_run_budget", { p_worker_run_token: globalToken });
            if (!budget || typeof budget !== "object" || Array.isArray(budget) || Object.keys(budget).length !== 1 || !Number.isSafeInteger(budget.remainingMs) || Number(budget.remainingMs) < 0 || Number(budget.remainingMs) > 180000) throw new Error("QUEUE_BUDGET_UNPROVEN");
            return !signal.aborted && Number(budget.remainingMs) > 0;
          };
          const invoke = createSafetyWorkerInvocation(config, {
            readiness: approvedSafety.readiness, atomicInvocation: atomic,
            allocate: () => ({ maxJobsPerRun: expected.limit, enqueueLimit: expected.limit }), reserve,
            async reserveItem(token, item, itemSignal) {
              if (token !== globalToken || item.kind !== kind || itemSignal.aborted || signal.aborted) return false;
              const proof = claims.get(item.jobId);
              if (!proof) return false;
              const stored = await real.get(proof.request);
              if (stored.state !== "completed" || !stored.result || typeof stored.result !== "object" || Array.isArray(stored.result)) return false;
              const job = stored.result.job;
              if (!job || typeof job !== "object" || Array.isArray(job) || job.jobId !== item.jobId || job.leaseToken !== proof.leaseToken || job.kind !== kind) return false;
              await real.confirm(proof.request); // SQL114 proves the original unique slot/parent lease.
              return !itemSignal.aborted && !signal.aborted;
            },
            elapsed: () => performance.now(), workerId: crypto.randomUUID(), jobLeaseDurationMs: 180000,
            retry: approvedSafety.retry, now: () => new Date(),
          }, fetchImpl);
          try { await invoke(globalToken, kind as "cancellation_safety" | "report_retention", { limit: expected.limit, remainingMs: expected.remainingMs, signal }); }
          catch { /* Only GET/complete of stored evidence follows. No second dispatch. */ }
        }
        alive(signal);
        const current = scope(await runtime.getQueueInvocation(expected.requestId), expected);
        let completed = current;
        if (completed.state !== "completed") {
          try { completed = scope(await runtime.completeQueueInvocation(expected.requestId), expected); }
          catch { completed = scope(await runtime.getQueueInvocation(expected.requestId), expected); }
        }
        if (completed.state !== "completed" || !completed.result || !("status" in completed.result)) throw new Error("QUEUE_INVOCATION_UNPROVEN");
        return completed.result;
      } catch {
        try { if (dispatchedByThisCall) await invocation.markQueueInvocationUnknown(expected.requestId); } catch { /* Retain the original request and lease for reconciliation. */ }
        throw new Error("QUEUE_RECONCILIATION_REQUIRED");
      } finally { clearTimeout(timer); }
    },
    async invokeExisting(globalToken, kind, options) {
      boundedApproval(kind, options.limit, options.remainingMs);
      if (!options.requestId) throw new Error("QUEUE_KIND_NOT_READY");
      alive(options.signal);
      const expected: WorkerInvocationInput = { requestId: options.requestId, globalToken, kind: kind as WorkerInvocationInput["kind"], limit: options.limit, remainingMs: Math.floor(options.remainingMs) };
      const runtime = createWorkerInvocationRuntime(scopedDb(options.signal));
      const prepared = scope(await runtime.getQueueInvocation(expected.requestId), expected);
      if (prepared.state !== "prepared") {
        if (prepared.state === "completed" && prepared.result) return prepared.result;
        throw new Error("QUEUE_RECONCILIATION_REQUIRED");
      }
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(queueConfig.timeoutMs ?? options.remainingMs, options.remainingMs));
      const signal = AbortSignal.any([options.signal, controller.signal]);
      try {
        try {
          const endpoint = kind === "review_summary" ? queueConfig.functionUrl :
            `${config.supabaseUrl}/functions/v1/${kind === "event_sync" ? "event-sync/worker" : "service-api/internal/member-cleanup"}`;
          const response = await fetchImpl(endpoint, {
            method: "POST", headers: { Authorization: `Bearer ${queueConfig.workerSecret}`, "Content-Type": "application/json",
              "x-worker-run-token": globalToken, "x-worker-request-id": expected.requestId,
              "x-worker-max-jobs": String(expected.limit), "x-worker-time-budget-ms": String(expected.remainingMs) },
            body: "{}", signal, redirect: "error", credentials: "omit",
          });
          const envelope = await response.json();
          if (signal.aborted || response.status !== 200 || !envelope || envelope.error || !envelope.data || !["ran", "not_enabled"].includes(envelope.data.status)) throw new Error("QUEUE_HTTP_UNKNOWN");
        } catch { /* 원 HTTP 응답은 DB 완료 근거를 대신하지 않는다. 재전송하지 않는다. */ }
        alive(options.signal);
        const current = scope(await runtime.getQueueInvocation(expected.requestId), expected);
        const completed = current.state === "completed" ? current : scope(await runtime.completeQueueInvocation(expected.requestId), expected);
        if (!completed.result || !("status" in completed.result)) throw new Error("QUEUE_INVOCATION_UNPROVEN");
        return completed.result;
      } finally { clearTimeout(timer); }
    },
  };
  async function runDirectMaintenance(kind: "terminal_maintenance" | "runtime_maintenance", globalToken: string, options: QueueInvocationOptions) {
    alive(options.signal);
    const requestId = crypto.randomUUID(), input: WorkerInvocationInput = { requestId, globalToken, kind: kind as WorkerInvocationInput["kind"], limit: options.limit, remainingMs: Math.floor(options.remainingMs) };
    const runtime = createWorkerInvocationRuntime(scopedDb(options.signal)), connection = createWorkerConnectionPorts(scopedDb(options.signal));
    try {
      const prepared = await runtime.prepareQueueInvocation(input);
      alive(options.signal);
      if (prepared.fresh) {
        const claimed = await runtime.claimQueueInvocationDispatch(input);
        alive(options.signal);
        if (claimed) {
          try {
            if (kind === "runtime_maintenance") await connection.purgeRuntime(requestId, globalToken, options.limit);
            else await connection.atomic.execute(requestId, globalToken, { operation: "terminal_maintenance", input: { limit: options.limit } });
          } catch { alive(options.signal); await connection.atomic.get(requestId); }
        }
      }
      alive(options.signal);
      const result = scope(await runtime.completeQueueInvocation(requestId), input);
      if (result.state !== "completed" || !result.result || !("purged" in result.result)) throw new Error("QUEUE_MAINTENANCE_UNPROVEN");
      return result.result;
    } catch {
      try { await invocation.markQueueInvocationUnknown(requestId); } catch { /* 최초 영속 요청을 보존 */ }
      throw new Error("QUEUE_MAINTENANCE_UNKNOWN");
    }
  }
  return {
    ports,
    async preflight() {
      // 존재하지 않는 UUID 조회로 실제109 제어·service EXEC를 검증한다. intent/dispatch를 만들지 않는다.
      try { await invocation.getQueueInvocation("00000000-0000-0000-0000-000000000000"); }
      catch (error) {
        if (toPublicError(error).error.code === "RESOURCE_NOT_FOUND") {
          for (const kind of safetyApproved.keys()) await verifySafetyPorts(kind);
          return;
        }
        throw new Error("SHARED_QUEUE_CONTRACT_NOT_READY");
      }
      throw new Error("SHARED_QUEUE_CONTRACT_NOT_READY");
    },
    scheduleForClient(client: NonNullable<typeof queueClient>) {
      queueClient = client;
      return async ({ excludeKinds, afterKind, globalToken }: { excludeKinds: string[]; afterKind: string | null; globalToken: string | null }) =>
        (await client.query(globalToken === null ? "select public.read_worker_queue_schedule($1::text[],$2::text) as result" : "select public.read_worker_owned_queue_schedule($3::uuid,$1::text[],$2::text) as result", [excludeKinds, afterKind, ...(globalToken === null ? [] : [globalToken])])).rows[0]?.result;
    },
    async readFeedbackResult(requestId: string, signal: AbortSignal) {
      alive(signal);
      const runtime = createWorkerInvocationRuntime(scopedDb(signal)), current = await runtime.getQueueInvocation(requestId);
      if (current.kind !== "helpful_maintenance") throw new Error("QUEUE_INVOCATION_CONFLICT");
      const saved = await createWorkerConnectionPorts(scopedDb(signal)).atomic.get(requestId);
      alive(signal);
      const completed = scope(await runtime.completeQueueInvocation(requestId), current);
      if (!completed.result || !("purged" in completed.result) || !saved.result || typeof saved.result !== "object" || Array.isArray(saved.result) || completed.result.purged !== saved.result.deletedCount) throw new Error("QUEUE_MAINTENANCE_UNPROVEN");
      return saved;
    },
  };
}
