/** 종현 J1: 현재 서버 계약을 소비하는 준비 포트. 기본 운영 등록·외부 전송·복구를 하지 않는다. */
import type { RuntimeConfig } from "../config/env.ts";
import type { JsonValue } from "../contracts/common.ts";
import type { FetchLike } from "../db/transport.ts";
import { createInternalClient } from "../db/internal-client.ts";
import { createReportRetentionStoragePorts, createReportRetentionMaintenancePort } from "../db/report-retention-client.ts";
import { createReportRetentionStorageAdapter } from "../services/report-retention-storage.ts";
import { enqueueSafetyDue, type SafetyDueEnqueuePort } from "./enqueue.ts";
import { createRpcJobRepository, type SafetyClaimJournal, type SafetySettlementJournal, type JobRepository } from "../db/repositories/jobs.ts";
import { runNextJob } from "./lease.ts";
import type { ClaimedJob } from "../db/repositories/jobs.ts";
import { normalizeDbInstant } from "../db/repositories/jobs.ts";
import type { ReportRetentionTask } from "../services/report-retention-storage.ts";
import type { JobHandler, JobRegistry } from "./registry.ts";
import type { RetrySettings } from "./retry.ts";
import { JobExecutionUnknown, validateRetrySettings } from "./retry.ts";
import { HttpError, toPublicError } from "../http/errors.ts";

export interface SafetyExecutionBudget {
  readonly globalToken: string;
  readonly signal: AbortSignal;
  /** exact {remainingMs}, 현재 token만 조회. 새 점유·연장 없음. */
  readRemaining(): Promise<unknown>;
  /** 단위·총량은 승인된 공유 예산 계약이 판단한다. 소비자가 20 단위를 새로 정의하지 않는다. */
  reserve(operation: "cancellation_process" | "report_task_claim" | "report_task_complete" | "report_storage" | "due_enqueue" | "job_claim" | "job_complete"): Promise<boolean>;
  elapsed(): number;
}
export interface SafetyJournalIntent {
  readonly requestId: string;
  readonly phase: "process" | "task_claim" | "complete";
  readonly jobId: string;
  readonly jobLeaseToken: string;
  readonly globalToken: string;
  readonly taskId?: string;
  readonly taskLeaseToken?: string;
  readonly evidenceSha256?: string;
}
export interface SafetyJournalPort {
  /** 전송 전에 원자 영속 저장. 원문·키·Storage 경로를 저장하지 않는다. */
  prepare(intent: SafetyJournalIntent): Promise<void>;
  /** 자동 복구 mutation 없이 미확정 표시를 영속화한다. 원 intent는 보존한다. */
  unknown(requestId: string): Promise<void>;
  confirmed(requestId: string): Promise<void>;
}
export interface SafetyReadiness {
  readonly scopedClaim: boolean;
  readonly sharedBudgetContract: boolean;
  readonly durableJournalContract: boolean;
  readonly cancellationGuardAndAcl: boolean;
  readonly reportGuardAndAcl: boolean;
  readonly reportTerminalScheduleContract: boolean;
  readonly storageProviderApproved: boolean;
}
export interface SafetyConsumerPorts {
  readonly readiness: SafetyReadiness;
  readonly budget: SafetyExecutionBudget;
  readonly journal: SafetyJournalPort;
  cancellationProcess(input: { identityId: string; generation: number; jobId: string; jobLeaseToken: string; globalToken: string }, signal: AbortSignal): Promise<unknown>;
  reportClaim(input: { jobId: string; jobLeaseToken: string; globalToken: string }, signal: AbortSignal): Promise<unknown>;
  /** 승인된 기존 Storage adapter/ACK를 사용하고 완성된 증거 해시만 전달한다. */
  reportStorage(task: ReportRetentionTask, job: ClaimedJob, signal: AbortSignal): Promise<{ evidenceSha256: string }>;
  metadataEvidence(task: ReportRetentionTask, job: ClaimedJob): Promise<string>;
  reportComplete(input: { task: ReportRetentionTask; jobId: string; jobLeaseToken: string; globalToken: string; evidenceSha256: string }, signal: AbortSignal): Promise<unknown>;
}
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v) && v !== "00000000-0000-0000-0000-000000000000";
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function exact(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw new Error("INVALID_SAFETY_RESPONSE");
  return v as Record<string, unknown>;
}
const taskKeys = ["taskId", "taskLeaseToken", "taskExpiresAt", "reportId", "closureRevision", "kind", "assetId", "bucketId", "objectName", "objectId", "retentionDueAt", "closureProofId"];
export function decodeReportRetentionTask(value: unknown, job: ClaimedJob): ReportRetentionTask {
  const t = exact(value, taskKeys);
  if (job.reference.kind !== "report_retention" || t.reportId !== job.reference.reportId || t.closureProofId !== job.reference.closureProofId ||
      !uuid(t.taskId) || !uuid(t.taskLeaseToken) || !Number.isSafeInteger(t.closureRevision) || Number(t.closureRevision) < 1 ||
      typeof t.taskExpiresAt !== "string" || typeof t.retentionDueAt !== "string") throw new Error("INVALID_RETENTION_TASK");
  normalizeDbInstant(t.taskExpiresAt); normalizeDbInstant(t.retentionDueAt);
  if (Date.parse(t.taskExpiresAt) > Date.parse(job.leaseUntil)) throw new Error("INVALID_RETENTION_TASK");
  if (t.kind === "report_metadata") {
    if ([t.assetId, t.bucketId, t.objectName, t.objectId].some(v => v !== null)) throw new Error("INVALID_RETENTION_TASK");
  } else if (t.kind === "storage_object") {
    if (!uuid(t.assetId) || !uuid(t.objectId) || t.bucketId !== "report-evidence" || typeof t.objectName !== "string") throw new Error("INVALID_RETENTION_TASK");
    const parts = t.objectName.split("/");
    if (parts.length !== 2 || !uuid(parts[0]) || !new RegExp("^" + t.assetId + "\\.(jpg|png|webp)$").test(parts[1])) throw new Error("INVALID_RETENTION_TASK");
  } else throw new Error("INVALID_RETENTION_TASK");
  return Object.freeze({ ...t }) as unknown as ReportRetentionTask;
}

/** DB 전역 잔여 예산에서 왕복 시간을 차감한다. task/job fence의 만료 판정은 각 RPC가 한다. */
function bounded<T>(signal: AbortSignal, phase: ConstructorParameters<typeof JobExecutionUnknown>[0], operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new JobExecutionUnknown(phase));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new JobExecutionUnknown(phase));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new JobExecutionUnknown(phase);
      return operation();
    }).then(value => signal.aborted ? abort() : resolve(value), reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function budgetScope(b: SafetyExecutionBudget, operation: Parameters<SafetyExecutionBudget["reserve"]>[0], task?: ReportRetentionTask) {
  if (b.signal.aborted) return null;
  const reserved = await bounded(b.signal, "process", () => b.reserve(operation));
  if (typeof reserved !== "boolean") throw new Error("INVALID_WORKER_BUDGET");
  if (!reserved) return null;
  const started = b.elapsed();
  const raw = exact(await bounded(b.signal, "process", () => b.readRemaining()), ["remainingMs"]);
  const spent = b.elapsed() - started;
  if (!Number.isSafeInteger(raw.remainingMs) || Number(raw.remainingMs) < 0 || Number(raw.remainingMs) > 180000 || !Number.isFinite(spent) || spent < 0) throw new Error("INVALID_WORKER_BUDGET");
  // task 만료·권한은 각 DB RPC가 검사하며 전역 예산 조회로 task lease를 연장하지 않는다.
  const remaining = Number(raw.remainingMs) - spent;
  if (remaining <= 0 || b.signal.aborted) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  return { signal: AbortSignal.any([b.signal, controller.signal]), close: () => clearTimeout(timer), task };
}
async function mutation<T>(p: SafetyConsumerPorts, job: ClaimedJob, phase: SafetyJournalIntent["phase"], signal: AbortSignal, operation: () => Promise<unknown>, decode: (v: unknown) => T, task?: ReportRetentionTask, evidenceSha256?: string): Promise<T> {
  const requestId = crypto.randomUUID();
  try { await bounded(signal, "journal", () => p.journal.prepare({ requestId, phase, jobId: job.jobId, jobLeaseToken: job.leaseToken, globalToken: p.budget.globalToken,
    ...(task ? { taskId: task.taskId, taskLeaseToken: task.taskLeaseToken } : {}), ...(evidenceSha256 ? { evidenceSha256 } : {}) })); }
  catch { throw new JobExecutionUnknown("journal"); }
  let returned = false;
  try {
    const raw = await bounded(signal, phase, operation);
    returned = true;
    const result = decode(raw);
    await bounded(signal, phase, () => p.journal.confirmed(requestId));
    return result;
  } catch (error) {
    const code = toPublicError(error).error.code;
    // 원 RPC의 명확한 거절만 확정 오류다. 성공 후 journal 오류와 중단은 종료 증거가 아니다.
    if (!returned && !signal.aborted && ["AUTH_REQUIRED", "ACCESS_DENIED", "STATE_CONFLICT"].includes(code)) throw error;
    try { await bounded(signal, "journal", () => p.journal.unknown(requestId)); } catch { /* prepare에 저장한 원 intent를 지우지 않는다. */ }
    throw new JobExecutionUnknown(phase);
  }
}
export function createSafetyConsumerRegistry(p: SafetyConsumerPorts): JobRegistry {
  if (!uuid(p.budget.globalToken)) throw new Error("INVALID_WORKER_RUN_TOKEN");
  const r = p.readiness;
  if (!r.scopedClaim || !r.sharedBudgetContract || !r.durableJournalContract) return Object.freeze({});
  const cancellation: JobHandler = async job => {
    if (job.reference.kind !== "cancellation_safety") throw new HttpError("INVALID_REQUEST");
    const scope = await budgetScope(p.budget, "cancellation_process");
    if (!scope) return { status: "held" };
    try {
      const ref = job.reference;
      const result = await mutation(p, job, "process", scope.signal, () => p.cancellationProcess({ identityId: ref.identityId, generation: ref.generation, jobId: job.jobId, jobLeaseToken: job.leaseToken, globalToken: p.budget.globalToken }, scope.signal), raw => {
        const v = exact(raw, ["status", "generation", "changed"]);
        if (!["not_due", "policy_pending", "held", "applied"].includes(String(v.status)) || v.generation !== ref.generation || typeof v.changed !== "boolean") throw new Error("INVALID_CANCELLATION_RESULT");
        return v;
      });
      return { status: result.status === "applied" ? "succeeded" : "held" };
    } finally { scope.close(); }
  };
  const retention: JobHandler = async job => {
    if (job.reference.kind !== "report_retention") throw new HttpError("INVALID_REQUEST");
    while (true) {
      const scope = await budgetScope(p.budget, "report_task_claim");
      if (!scope) return { status: "held" };
      let task: ReportRetentionTask | null;
      try { task = await mutation(p, job, "task_claim", scope.signal, () => p.reportClaim({ jobId: job.jobId, jobLeaseToken: job.leaseToken, globalToken: p.budget.globalToken }, scope.signal), raw => raw === null ? null : decodeReportRetentionTask(raw, job)); }
      finally { scope.close(); }
      if (!task) return { status: "held" };
      const completeScope = await budgetScope(p.budget, task.kind === "storage_object" ? "report_storage" : "report_task_complete", task);
      if (!completeScope) return { status: "held" };
      try {
        const evidenceSha256 = task.kind === "storage_object"
          ? await mutation(p, job, "process", completeScope.signal, () => p.reportStorage(task!, job, completeScope.signal), raw => {
            const value = exact(raw, ["evidenceSha256"]);
            if (!hash(value.evidenceSha256)) throw new Error("INVALID_RETENTION_EVIDENCE");
            return value.evidenceSha256;
          }, task)
          : await bounded(completeScope.signal, "process", () => p.metadataEvidence(task!, job));
        if (!hash(evidenceSha256)) throw new Error("INVALID_RETENTION_EVIDENCE");
        await mutation(p, job, "complete", completeScope.signal, () => p.reportComplete({ task: task!, jobId: job.jobId, jobLeaseToken: job.leaseToken, globalToken: p.budget.globalToken, evidenceSha256 }, completeScope.signal), raw => {
          const v = exact(raw, ["taskId", "status", "alreadyApplied"]);
          if (v.taskId !== task!.taskId || v.status !== "completed" || typeof v.alreadyApplied !== "boolean") throw new Error("INVALID_RETENTION_COMPLETION");
          return v;
        }, task, evidenceSha256);
        if (task.kind === "report_metadata") return { status: "completed_by_handler" };
      } finally { completeScope.close(); }
    }
  };
  return Object.freeze({ ...(r.cancellationGuardAndAcl ? { cancellation_safety: cancellation } : {}),
    ...(r.reportGuardAndAcl && r.reportTerminalScheduleContract && r.storageProviderApproved ? { report_retention: retention } : {}) });
}

/** 현재 민규 공통 모듈의 실제 wire 조립. factory 생성은 외부 요청·준비조건 활성화를 하지 않는다. */
export function createRpcSafetyConsumerPorts(config: RuntimeConfig, options: {
  readiness: SafetyReadiness;
  budget: Omit<SafetyExecutionBudget, "readRemaining">;
  journal: SafetyJournalPort;
}, fetchImpl: FetchLike = fetch): {
  consumers: SafetyConsumerPorts;
  dueEnqueue: SafetyDueEnqueuePort;
  terminalMaintenance: ReturnType<typeof createReportRetentionMaintenancePort>;
} {
  if (!uuid(options.budget.globalToken) || !(options.budget.signal instanceof AbortSignal)) throw new Error("INVALID_WORKER_RUN_TOKEN");
  // 운영 비밀을 새로 고르거나 사용자 JWT로 대체하지 않는다.
  createInternalClient(config, fetchImpl);
  const globalToken = options.budget.globalToken, parentSignal = options.budget.signal;
  const rpc = (name: string, args: Record<string, JsonValue>, signal: AbortSignal, phase: "process" | "task_claim" | "complete" = "process") => {
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), config.upstreamTimeoutMs);
    const combined = AbortSignal.any([parentSignal, signal, timeout.signal]);
    const scopedFetch: FetchLike = (url, init) => fetchImpl(url, {
      ...init, signal: AbortSignal.any([combined, ...(init?.signal ? [init.signal] : [])]),
    });
    return bounded(combined, phase, () => createInternalClient(config, scopedFetch).rpc(name, args)).finally(() => clearTimeout(timer));
  };
  const context = (job: ClaimedJob) => ({ jobId: job.jobId, jobLeaseToken: job.leaseToken, globalToken });
  const fence = (task: ReportRetentionTask, job: ClaimedJob) => ({ p_task_id: task.taskId, p_task_lease_token: task.taskLeaseToken,
    p_job_id: job.jobId, p_job_lease_token: job.leaseToken, p_global_token: globalToken, p_object_id: task.objectId });
  const evidence = async (task: ReportRetentionTask, job: ClaimedJob, receipt?: { receiptId: string; ackSha256: string }) => {
    const value = { version: 1, taskId: task.taskId, taskLeaseToken: task.taskLeaseToken, jobId: job.jobId, jobLeaseToken: job.leaseToken,
      globalToken, reportId: task.reportId, closureProofId: task.closureProofId, closureRevision: task.closureRevision, assetId: task.assetId,
      objectId: task.objectId, kind: task.kind, ...(receipt ? { receiptId: receipt.receiptId, ackSha256: receipt.ackSha256, authenticatedAbsenceVerified: true } : { metadataOnly: true }) };
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(bytes), v => v.toString(16).padStart(2, "0")).join("");
  };
  const adapter = createReportRetentionStorageAdapter(config, fetchImpl);
  const consumers: SafetyConsumerPorts = {
    readiness: Object.freeze({ ...options.readiness }), journal: options.journal,
    budget: { ...options.budget, globalToken, signal: parentSignal, readRemaining: () => rpc("read_worker_run_budget", { p_worker_run_token: globalToken }, parentSignal) },
    cancellationProcess: (input, signal) => {
      if (input.globalToken !== globalToken) throw new HttpError("STATE_CONFLICT");
      return rpc("process_cancellation_safety_due", { p_identity_id: input.identityId, p_expected_generation: input.generation,
        p_job_id: input.jobId, p_job_lease_token: input.jobLeaseToken, p_worker_run_token: globalToken }, signal);
    },
    reportClaim: (input, signal) => {
      if (input.globalToken !== globalToken) throw new HttpError("STATE_CONFLICT");
      return rpc("claim_report_retention_task", { p_job_id: input.jobId, p_job_lease_token: input.jobLeaseToken, p_global_token: globalToken }, signal, "task_claim");
    },
    reportStorage: async (task, job, signal) => {
      const verified = await adapter.deleteExact(task, createReportRetentionStoragePorts(config, context(job), fetchImpl), AbortSignal.any([parentSignal, signal]));
      return { evidenceSha256: await evidence(task, job, verified.ack) };
    },
    metadataEvidence: (task, job) => {
      if (task.kind !== "report_metadata") throw new HttpError("INVALID_REQUEST");
      return evidence(task, job);
    },
    reportComplete: (input, signal) => {
      if (input.globalToken !== globalToken || !hash(input.evidenceSha256)) throw new HttpError("INVALID_REQUEST");
      const job = { jobId: input.jobId, leaseToken: input.jobLeaseToken } as ClaimedJob;
      return rpc("complete_report_retention_task", { ...fence(input.task, job), p_evidence_sha256: input.evidenceSha256 }, signal, "complete");
    },
  };
  const dueEnqueue: SafetyDueEnqueuePort = {
    enqueueCancellation: (limit, token, signal) => {
      if (token !== globalToken) throw new HttpError("STATE_CONFLICT");
      return rpc("enqueue_cancellation_safety_due", { p_limit: limit, p_worker_run_token: globalToken }, signal);
    },
    enqueueReportRetention: (limit, token, signal) => {
      if (token !== globalToken) throw new HttpError("STATE_CONFLICT");
      return rpc("enqueue_report_retention_purges", { p_limit: limit, p_global_token: globalToken }, signal);
    },
  };
  const maintenance = createReportRetentionMaintenancePort(config, fetchImpl);
  return Object.freeze({ consumers: Object.freeze(consumers), dueEnqueue: Object.freeze(dueEnqueue),
    terminalMaintenance: (token: string, limit: number, signal: AbortSignal) => {
      if (token !== globalToken) throw new HttpError("STATE_CONFLICT");
      return maintenance(globalToken, limit, AbortSignal.any([parentSignal, signal]));
    } });
}

export interface SafetyEnqueueJournal {
  prepare(input: { requestId: string; kind: "cancellation_safety" | "report_retention"; globalToken: string; limit: number }): Promise<void>;
  confirmed(requestId: string): Promise<void>;
  unknown(requestId: string): Promise<void>;
}
/** scheduler의 공유 단위와 실제 처리 개수의 변환은 승인된 allocate/reserve가 맡는다. */
export function createSafetyWorkerInvocation(config: RuntimeConfig, deps: {
  readiness: SafetyReadiness;
  journal: SafetyJournalPort;
  claimJournal: SafetyClaimJournal;
  settlementJournal: SafetySettlementJournal;
  enqueueJournal: SafetyEnqueueJournal;
  allocate(kind: "cancellation_safety" | "report_retention", sharedLimit: number): { maxJobsPerRun: number; enqueueLimit: number };
  reserve(globalToken: string, operation: Parameters<SafetyExecutionBudget["reserve"]>[0]): Promise<boolean>;
  elapsed(): number;
  workerId: string;
  jobLeaseDurationMs: number;
  retry: RetrySettings;
  now(): Date;
}, fetchImpl: FetchLike = fetch) {
  if (!uuid(deps.workerId) || !Number.isSafeInteger(deps.jobLeaseDurationMs) || deps.jobLeaseDurationMs < 1000 || deps.jobLeaseDurationMs > 86400000 || deps.jobLeaseDurationMs % 1000 !== 0) throw new Error("INVALID_SAFETY_WORKER_SETTINGS");
  validateRetrySettings(deps.retry);
  createInternalClient(config, fetchImpl); // 설정만 검증하며 요청하지 않는다.
  return async (globalToken: string, kind: "cancellation_safety" | "report_retention", input: { limit: number; remainingMs: number; signal: AbortSignal }) => {
    if (!uuid(globalToken) || !["cancellation_safety", "report_retention"].includes(kind) || !Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 20 || !Number.isFinite(input.remainingMs) || input.remainingMs < 0 || input.remainingMs > 180000 || !(input.signal instanceof AbortSignal)) throw new Error("INVALID_SAFETY_WORKER_INPUT");
    const counts = { claimed: 0, succeeded: 0, held: 0, leaseLost: 0 };
    const finish = (stopReason: "idle" | "max_jobs" | "held" | "lease_lost" | "time_budget") => ({ status: "ran" as const, stopReason, hasMore: stopReason !== "idle", counts });
    if (input.limit === 0) return finish("max_jobs");
    if (input.remainingMs === 0 || input.signal.aborted) return finish("time_budget");
    const allocation = deps.allocate(kind, input.limit);
    if (!allocation || !Number.isSafeInteger(allocation.maxJobsPerRun) || allocation.maxJobsPerRun < 0 || allocation.maxJobsPerRun > 20 || !Number.isSafeInteger(allocation.enqueueLimit) || allocation.enqueueLimit < 1 || allocation.enqueueLimit > 20) throw new Error("INVALID_SAFETY_WORKER_ALLOCATION");
    if (allocation.maxJobsPerRun === 0) return finish("max_jobs");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, Math.floor(input.remainingMs)));
    const signal = AbortSignal.any([input.signal, controller.signal]);
    try {
    const wired = createRpcSafetyConsumerPorts(config, { readiness: deps.readiness, journal: deps.journal,
      budget: { globalToken, signal, reserve: operation => deps.reserve(globalToken, operation), elapsed: deps.elapsed } }, fetchImpl);
    const registry = createSafetyConsumerRegistry(wired.consumers);
    if (typeof registry[kind] !== "function") return { status: "not_enabled" as const, reason: "SAFETY_CONTRACT_NOT_READY" };
    const scopedFetch: FetchLike = (url, init) => {
      const joined = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]);
      return bounded(joined, "process", () => fetchImpl(url, { ...init, signal: joined }));
    };
    const repository = createRpcJobRepository(createInternalClient(config, scopedFetch), { workerRunToken: globalToken, supportedClaim: true,
      claimJournal: deps.claimJournal, settlementJournal: deps.settlementJournal, signal });
    let claimBudgetExhausted = false;
    const scopedRepository: JobRepository = {
      enqueue: repository.enqueue,
      claim: async claim => {
        const scope = await budgetScope(wired.consumers.budget, "job_claim");
        if (!scope) { claimBudgetExhausted = true; return null; }
        try { return await bounded(scope.signal, "claim", () => repository.claim(claim)); } catch (error) { if (scope.signal.aborted) controller.abort(); throw error; } finally { scope.close(); }
      },
      settle: async settlement => {
        const scope = await budgetScope(wired.consumers.budget, "job_complete");
        if (!scope) throw new JobExecutionUnknown("complete");
        try { return await bounded(scope.signal, "complete", () => repository.settle(settlement)); } catch (error) { if (scope.signal.aborted) controller.abort(); throw error; } finally { scope.close(); }
      },
    };
      const dueScope = await budgetScope(wired.consumers.budget, "due_enqueue");
      if (!dueScope) return finish("time_budget");
      const requestId = crypto.randomUUID();
      let returned = false, dispatched = false;
      try {
        await bounded(dueScope.signal, "journal", () => deps.enqueueJournal.prepare({ requestId, kind, globalToken, limit: allocation.enqueueLimit }));
        dispatched = true;
        await bounded(dueScope.signal, "process", () => enqueueSafetyDue(wired.dueEnqueue, kind, allocation.enqueueLimit, globalToken, dueScope.signal));
        returned = true;
        await bounded(dueScope.signal, "process", () => deps.enqueueJournal.confirmed(requestId));
      } catch (error) {
        const code = toPublicError(error).error.code;
        if (dispatched && !returned && !dueScope.signal.aborted && ["AUTH_REQUIRED", "ACCESS_DENIED", "STATE_CONFLICT"].includes(code)) throw error;
        try { await bounded(dueScope.signal, "journal", () => deps.enqueueJournal.unknown(requestId)); } catch { /* 원 intent 보존 */ }
        throw new JobExecutionUnknown("process");
      } finally { dueScope.close(); }
      for (let n = 0; n < allocation.maxJobsPerRun; n++) {
        if (signal.aborted) throw new JobExecutionUnknown("process");
        const result = await runNextJob({ workerId: deps.workerId, repository: scopedRepository,
          registry: { [kind]: registry[kind] }, now: deps.now,
          settings: { leaseDurationMs: deps.jobLeaseDurationMs, retry: deps.retry } });
        if (signal.aborted) throw new JobExecutionUnknown("process");
        if (result.status === "idle") return finish(claimBudgetExhausted ? "time_budget" : "idle");
        counts.claimed++;
        if (result.status === "succeeded") counts.succeeded++;
        else if (result.status === "held") { counts.held++; return finish("held"); }
        else if (result.status === "lease_lost") { counts.leaseLost++; return finish("lease_lost"); }
        else throw new JobExecutionUnknown("process");
      }
      return finish("max_jobs");
    } finally { clearTimeout(timer); }
  };
}
