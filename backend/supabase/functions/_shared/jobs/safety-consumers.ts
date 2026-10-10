/** 민규: SQL114 exact intent/operation 조립. 운영 준비·Storage 공급사 승인을 자동으로 열지 않는다. */
import type { RuntimeConfig } from "../config/env.ts";
import type { JsonValue } from "../contracts/common.ts";
import type { FetchLike } from "../db/transport.ts";
import { canDispatchReportDelete, type WorkerScopedInvocationPort, type WorkerScopedRequest } from "../db/worker-runtime-client.ts";
import { ReportRetentionStorageUnknown } from "../services/report-retention-storage.ts";
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
  /** RPC별 허가/별도 계수. 공유 처리항목 20에서 차감하지 않는다. */
  reserve(operation: "cancellation_process" | "report_task_claim" | "report_task_complete" | "report_storage" | "due_enqueue" | "job_claim" | "job_complete"): Promise<boolean>;
  /** 고유 queue jobId 예약. 같은 작업의 첨부·metadata·ACK·완료는 추가 슬롯을 쓰지 않는다. */
  reserveItem(input: { kind: "cancellation_safety" | "report_retention"; jobId: string; taskId?: string }): Promise<boolean>;
  /** 현재 invocation에 배정된 잔여 항목 검사. DB 원자 예약을 대체하지 않는다. */
  hasItemCapacity(jobId?: string): boolean;
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
  readonly journal?: SafetyJournalPort;
  readonly atomicInvocation?: WorkerScopedInvocationPort;
  cancellationProcess(input: { identityId: string; generation: number; jobId: string; jobLeaseToken: string; globalToken: string; requestId?: string }, signal: AbortSignal): Promise<unknown>;
  reportClaim(input: { jobId: string; jobLeaseToken: string; globalToken: string; requestId?: string }, signal: AbortSignal): Promise<unknown>;
  /** 승인된 기존 Storage adapter/ACK를 사용하고 완성된 증거 해시만 전달한다. */
  reportStorage(task: ReportRetentionTask, job: ClaimedJob, signal: AbortSignal, requestId?: string): Promise<{ evidenceSha256: string }>;
  metadataEvidence(task: ReportRetentionTask, job: ClaimedJob): Promise<string>;
  reportComplete(input: { task: ReportRetentionTask; jobId: string; jobLeaseToken: string; globalToken: string; evidenceSha256: string; requestId?: string }, signal: AbortSignal): Promise<unknown>;
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
async function mutation<T>(p: SafetyConsumerPorts, job: ClaimedJob, phase: SafetyJournalIntent["phase"], signal: AbortSignal, operation: (requestId: string) => Promise<unknown>, decode: (v: unknown) => T, task?: ReportRetentionTask, evidenceSha256?: string): Promise<T> {
  const requestId = crypto.randomUUID();
  try { if (!p.atomicInvocation) { if (!p.journal) throw new JobExecutionUnknown("journal"); await bounded(signal, "journal", () => p.journal!.prepare({ requestId, phase, jobId: job.jobId, jobLeaseToken: job.leaseToken, globalToken: p.budget.globalToken,
    ...(task ? { taskId: task.taskId, taskLeaseToken: task.taskLeaseToken } : {}), ...(evidenceSha256 ? { evidenceSha256 } : {}) })); } }
  catch { throw new JobExecutionUnknown("journal"); }
  let returned = false;
  try {
    const raw = await bounded(signal, phase, () => operation(requestId));
    returned = true;
    const result = decode(raw);
    if (!p.atomicInvocation) await bounded(signal, phase, () => p.journal!.confirmed(requestId));
    return result;
  } catch (error) {
    const code = toPublicError(error).error.code;
    // 원 RPC의 명확한 거절만 확정 오류다. 성공 후 journal 오류와 중단은 종료 증거가 아니다.
    if (!returned && !signal.aborted && ["AUTH_REQUIRED", "ACCESS_DENIED", "STATE_CONFLICT"].includes(code)) throw error;
    try { if (p.atomicInvocation) await p.atomicInvocation.unknown(requestId); else await bounded(signal, "journal", () => p.journal!.unknown(requestId)); } catch { /* prepare에 저장한 원 intent를 지우지 않는다. */ }
    throw new JobExecutionUnknown(phase);
  }
}
async function reserveProcessingItem(p: SafetyConsumerPorts, input: Parameters<SafetyExecutionBudget["reserveItem"]>[0], signal: AbortSignal): Promise<boolean> {
  try {
    const reserved = await bounded(signal, "process", () => p.budget.reserveItem(input));
    if (typeof reserved !== "boolean") throw new JobExecutionUnknown("process");
    return reserved;
  } catch { throw new JobExecutionUnknown("process"); }
}
export function createSafetyConsumerRegistry(p: SafetyConsumerPorts): JobRegistry {
  if (!uuid(p.budget.globalToken)) throw new Error("INVALID_WORKER_RUN_TOKEN");
  const r = p.readiness;
  if (!r.scopedClaim || !r.sharedBudgetContract || !r.durableJournalContract || typeof p.budget.reserveItem !== "function" || typeof p.budget.hasItemCapacity !== "function") return Object.freeze({});
  const cancellation: JobHandler = async job => {
    if (job.reference.kind !== "cancellation_safety") throw new HttpError("INVALID_REQUEST");
    if (!p.budget.hasItemCapacity(job.jobId)) return { status: "held" };
    const scope = await budgetScope(p.budget, "cancellation_process");
    if (!scope) return { status: "held" };
    try {
      const reserved = await reserveProcessingItem(p, { kind: "cancellation_safety", jobId: job.jobId }, scope.signal);
      if (typeof reserved !== "boolean") throw new JobExecutionUnknown("process");
      if (!reserved) return { status: "held" };
      const ref = job.reference;
      const result = await mutation(p, job, "process", scope.signal, requestId => p.cancellationProcess({ requestId, identityId: ref.identityId, generation: ref.generation, jobId: job.jobId, jobLeaseToken: job.leaseToken, globalToken: p.budget.globalToken }, scope.signal), raw => {
        const v = exact(raw, ["status", "generation", "changed"]);
        if (!["not_due", "policy_pending", "held", "applied"].includes(String(v.status)) || v.generation !== ref.generation || typeof v.changed !== "boolean") throw new Error("INVALID_CANCELLATION_RESULT");
        return v;
      });
      return { status: result.status === "applied" ? "succeeded" : "held" };
    } finally { scope.close(); }
  };
  const retention: JobHandler = async job => {
    if (job.reference.kind !== "report_retention") throw new HttpError("INVALID_REQUEST");
    if (!p.budget.hasItemCapacity(job.jobId)) return { status: "held" };
    // 첨부를 claim하기 전에 부모 jobId를 한번만 예약한다.
    if (!await reserveProcessingItem(p, { kind: "report_retention", jobId: job.jobId }, p.budget.signal)) return { status: "held" };
    while (true) {
      if (!p.budget.hasItemCapacity(job.jobId)) return { status: "held" };
      const scope = await budgetScope(p.budget, "report_task_claim");
      if (!scope) return { status: "held" };
      let task: ReportRetentionTask | null;
      try { task = await mutation(p, job, "task_claim", scope.signal, requestId => p.reportClaim({ requestId, jobId: job.jobId, jobLeaseToken: job.leaseToken, globalToken: p.budget.globalToken }, scope.signal), raw => raw === null ? null : decodeReportRetentionTask(raw, job)); }
      finally { scope.close(); }
      if (!task) return { status: "held" };
      const completeScope = await budgetScope(p.budget, task.kind === "storage_object" ? "report_storage" : "report_task_complete", task);
      if (!completeScope) return { status: "held" };
      try {
        const evidenceSha256 = task.kind === "storage_object"
          ? await mutation(p, job, "process", completeScope.signal, requestId => p.reportStorage(task!, job, completeScope.signal, requestId), raw => {
            const value = exact(raw, ["evidenceSha256"]);
            if (!hash(value.evidenceSha256)) throw new Error("INVALID_RETENTION_EVIDENCE");
            return value.evidenceSha256;
          }, task)
          : await bounded(completeScope.signal, "process", () => p.metadataEvidence(task!, job));
        if (!hash(evidenceSha256)) throw new Error("INVALID_RETENTION_EVIDENCE");
        await mutation(p, job, "complete", completeScope.signal, requestId => p.reportComplete({ requestId, task: task!, jobId: job.jobId, jobLeaseToken: job.leaseToken, globalToken: p.budget.globalToken, evidenceSha256 }, completeScope.signal), raw => {
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
  journal?: SafetyJournalPort;
  atomicInvocation?: WorkerScopedInvocationPort;
}, fetchImpl: FetchLike = fetch): {
  consumers: SafetyConsumerPorts;
  dueEnqueue: SafetyDueEnqueuePort;
  terminalMaintenance: ReturnType<typeof createReportRetentionMaintenancePort>;
} {
  if (!uuid(options.budget.globalToken) || !(options.budget.signal instanceof AbortSignal)) throw new Error("INVALID_WORKER_RUN_TOKEN");
  // 운영 비밀을 새로 고르거나 사용자 JWT로 대체하지 않는다.
  createInternalClient(config, fetchImpl);
  const globalToken = options.budget.globalToken, parentSignal = options.budget.signal, atomic = options.atomicInvocation;
  if (atomic && atomic.globalToken !== globalToken) throw new Error("INVALID_ATOMIC_SAFETY_CONTEXT");
  const storageChains = new Map<string, Readonly<{ begin: Extract<WorkerScopedRequest, { operation: "report_storage" }>; ack: Extract<WorkerScopedRequest, { operation: "report_storage_ack" }> }>>();
  const rpc = (name: string, args: Record<string, JsonValue>, signal: AbortSignal, phase: "process" | "task_claim" | "complete" = "process") => {
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), config.upstreamTimeoutMs);
    const combined = AbortSignal.any([parentSignal, signal, timeout.signal]);
    const scopedFetch: FetchLike = (url, init) => fetchImpl(url, {
      ...init, signal: AbortSignal.any([combined, ...(init?.signal ? [init.signal] : [])]),
    });
    return bounded(combined, phase, () => createInternalClient(config, scopedFetch).rpc(name, args)).finally(() => clearTimeout(timer));
  };
  const context = (job: ClaimedJob) => ({ jobId: job.jobId, jobLeaseToken: job.leaseToken, globalToken });
  const evidence = async (task: ReportRetentionTask, job: ClaimedJob, receipt?: { receiptId: string; ackSha256: string }) => {
    const value = { version: 1, taskId: task.taskId, taskLeaseToken: task.taskLeaseToken, jobId: job.jobId, jobLeaseToken: job.leaseToken,
      globalToken, reportId: task.reportId, closureProofId: task.closureProofId, closureRevision: task.closureRevision, assetId: task.assetId,
      objectId: task.objectId, kind: task.kind, ...(receipt ? { receiptId: receipt.receiptId, ackSha256: receipt.ackSha256, authenticatedAbsenceVerified: true } : { metadataOnly: true }) };
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(bytes), v => v.toString(16).padStart(2, "0")).join("");
  };
  const adapter = createReportRetentionStorageAdapter(config, fetchImpl);
  const consumers: SafetyConsumerPorts = {
    readiness: Object.freeze({ ...options.readiness, durableJournalContract: options.readiness.durableJournalContract && !!atomic }), journal: options.journal, atomicInvocation: atomic,
    budget: { ...options.budget, globalToken, signal: parentSignal, readRemaining: () => rpc("read_worker_run_budget", { p_worker_run_token: globalToken }, parentSignal) },
    cancellationProcess: (input, signal) => {
      if (!atomic) throw new JobExecutionUnknown("journal");
      if (input.globalToken !== globalToken) throw new HttpError("STATE_CONFLICT");
      return bounded(signal, "process", () => atomic.run({ requestId: input.requestId ?? crypto.randomUUID(), operation: "cancellation_process", input: { identityId: input.identityId, generation: input.generation, jobId: input.jobId, jobLeaseToken: input.jobLeaseToken } })).then(v => { if (v.state !== "completed") throw new JobExecutionUnknown("process"); return v.result; });
    },
    reportClaim: async (input, signal) => {
      if (!atomic) throw new JobExecutionUnknown("journal");
      if (input.globalToken !== globalToken) throw new HttpError("STATE_CONFLICT");
      if (atomic) {
        const stored = await bounded(signal, "task_claim", () => atomic.run({ requestId: input.requestId ?? crypto.randomUUID(), operation: "report_task_claim", input: { jobId: input.jobId, jobLeaseToken: input.jobLeaseToken } }));
        if (stored.state !== "completed") throw new JobExecutionUnknown("task_claim");
        if (stored.result === null) return null;
        const keys = taskKeys.filter(k => k !== "bucketId" && k !== "objectName"), saved = exact(stored.result, keys);
        if (!uuid(saved.taskId) || !uuid(saved.taskLeaseToken) || !(saved.objectId === null || uuid(saved.objectId))) throw new Error("INVALID_RETENTION_TASK");
        const current = exact(await rpc("check_report_retention_task", { p_task_id: saved.taskId, p_task_lease_token: saved.taskLeaseToken, p_job_id: input.jobId, p_job_lease_token: input.jobLeaseToken, p_global_token: globalToken, p_object_id: saved.objectId }, signal, "task_claim"), taskKeys);
        if (keys.some(k => current[k] !== saved[k])) throw new Error("INVALID_RETENTION_TASK");
        return current; // Transient exact original task; never persist restored addresses.
      }
    },
    reportStorage: async (task, job, signal, requestId) => {
      if (!atomic) throw new JobExecutionUnknown("journal");
      const readPorts = createReportRetentionStoragePorts(config, context(job), fetchImpl);
      let begin: Extract<WorkerScopedRequest, { operation: "report_storage" }> | undefined, ack: Extract<WorkerScopedRequest, { operation: "report_storage_ack" }> | undefined;
      const ports = { check: readPorts.check, getAck: readPorts.getAck,
        begin: async () => {
          begin = Object.freeze({ requestId: requestId ?? crypto.randomUUID(), operation: "report_storage" as const, input: Object.freeze({ taskId: task.taskId, taskLeaseToken: task.taskLeaseToken, jobId: job.jobId, jobLeaseToken: job.leaseToken, objectId: task.objectId! }) });
          const result = await atomic.run(begin);
          if (!canDispatchReportDelete(result)) throw new ReportRetentionStorageUnknown("dispatch");
          return result.result;
        },
        recordAck: async (_task: ReportRetentionTask, ackSha256: string) => {
          if (!begin) throw new ReportRetentionStorageUnknown("ack");
          ack = Object.freeze({ requestId: crypto.randomUUID(), operation: "report_storage_ack" as const, predecessorRequestId: begin.requestId, input: Object.freeze({ ...begin.input as Extract<WorkerScopedRequest, { operation: "report_storage" }>["input"], ackSha256 }) });
          const result = await atomic.run(ack);
          if (result.state !== "completed") throw new ReportRetentionStorageUnknown("ack");return result.result;
        } };
      const verified = await adapter.deleteExact(task, ports, AbortSignal.any([parentSignal, signal]));
      if (atomic) {
        if (!begin || !ack) throw new ReportRetentionStorageUnknown("ack"); // Existing ACK never authorizes a new child chain.
        storageChains.set(task.taskId, Object.freeze({ begin, ack }));
      }
      return { evidenceSha256: await evidence(task, job, verified.ack) };
    },
    metadataEvidence: (task, job) => {
      if (task.kind !== "report_metadata") throw new HttpError("INVALID_REQUEST");
      return evidence(task, job);
    },
    reportComplete: async (input, signal) => {
      if (!atomic) throw new JobExecutionUnknown("journal");
      if (input.globalToken !== globalToken || !hash(input.evidenceSha256)) throw new HttpError("INVALID_REQUEST");
      if (atomic) {
        const chain = storageChains.get(input.task.taskId);
        if (input.task.kind === "storage_object" && (!chain || chain.begin.input.jobId !== input.jobId || chain.begin.input.jobLeaseToken !== input.jobLeaseToken || chain.begin.input.taskLeaseToken !== input.task.taskLeaseToken || chain.begin.input.objectId !== input.task.objectId)) throw new JobExecutionUnknown("complete");
        const result = await bounded(signal, "complete", () => atomic.run({ requestId: input.requestId ?? crypto.randomUUID(), operation: "report_task_complete", input: { taskId: input.task.taskId, taskLeaseToken: input.task.taskLeaseToken, jobId: input.jobId, jobLeaseToken: input.jobLeaseToken, objectId: input.task.objectId, evidenceSha256: input.evidenceSha256 }, ...(chain ? { predecessorRequestId: chain.ack.requestId } : {}) }));
        if (result.state !== "completed") throw new JobExecutionUnknown("complete");
        if (chain) { await atomic.confirm(chain.begin); storageChains.delete(input.task.taskId); }
        return result.result;
      }
    },
  };
  const enqueueAtomic = async (kind: "cancellation_safety" | "report_retention", limit: number, token: string, signal: AbortSignal) => {
    if (!atomic) throw new JobExecutionUnknown("journal");
    if (token !== globalToken) throw new HttpError("STATE_CONFLICT");
    const stored = await bounded(signal, "process", () => atomic.run({ requestId: crypto.randomUUID(), operation: "due_enqueue", input: { kind, limit } }));
    if (stored.state !== "completed") throw new JobExecutionUnknown("process");return stored.result;
  };
  const dueEnqueue: SafetyDueEnqueuePort = {
    enqueueCancellation: (limit, token, signal) => {
      if (token !== globalToken) throw new HttpError("STATE_CONFLICT");
      return enqueueAtomic("cancellation_safety", limit, token, signal);
    },
    enqueueReportRetention: (limit, token, signal) => {
      if (token !== globalToken) throw new HttpError("STATE_CONFLICT");
      return enqueueAtomic("report_retention", limit, token, signal);
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
  journal?: SafetyJournalPort;
  claimJournal?: SafetyClaimJournal;
  settlementJournal?: SafetySettlementJournal;
  enqueueJournal?: SafetyEnqueueJournal;
  atomicInvocation?: WorkerScopedInvocationPort;
  allocate(kind: "cancellation_safety" | "report_retention", sharedLimit: number): { maxJobsPerRun: number; enqueueLimit: number };
  reserve(globalToken: string, operation: Parameters<SafetyExecutionBudget["reserve"]>[0]): Promise<boolean>;
  reserveItem(globalToken: string, input: Parameters<SafetyExecutionBudget["reserveItem"]>[0], signal: AbortSignal): Promise<boolean>;
  elapsed(): number;
  workerId: string;
  jobLeaseDurationMs: number;
  retry: RetrySettings;
  now(): Date;
}, fetchImpl: FetchLike = fetch) {
  if (!uuid(deps.workerId) || !Number.isSafeInteger(deps.jobLeaseDurationMs) || deps.jobLeaseDurationMs < 1000 || deps.jobLeaseDurationMs > 86400000 || deps.jobLeaseDurationMs % 1000 !== 0) throw new Error("INVALID_SAFETY_WORKER_SETTINGS");
  if (deps.atomicInvocation && deps.jobLeaseDurationMs !== 180000) throw new Error("INVALID_ATOMIC_CLAIM_LEASE");
  validateRetrySettings(deps.retry);
  createInternalClient(config, fetchImpl); // 설정만 검증하며 요청하지 않는다.
  return async (globalToken: string, kind: "cancellation_safety" | "report_retention", input: { limit: number; remainingMs: number; signal: AbortSignal }) => {
    if (!uuid(globalToken) || !["cancellation_safety", "report_retention"].includes(kind) || !Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 20 || !Number.isFinite(input.remainingMs) || input.remainingMs < 0 || input.remainingMs > 180000 || !(input.signal instanceof AbortSignal)) throw new Error("INVALID_SAFETY_WORKER_INPUT");
    const reservedJobs = new Set<string>();
    const counts = { claimed: 0, succeeded: 0, held: 0, leaseLost: 0, processedItems: 0 };
    const finish = (stopReason: "idle" | "max_jobs" | "held" | "lease_lost" | "time_budget") => ({ status: "ran" as const, stopReason, hasMore: stopReason !== "idle", counts });
    if (input.limit === 0) return finish("max_jobs");
    if (input.remainingMs === 0 || input.signal.aborted) return finish("time_budget");
    const allocation = deps.allocate(kind, input.limit);
    if (!allocation || !Number.isSafeInteger(allocation.maxJobsPerRun) || allocation.maxJobsPerRun < 0 || allocation.maxJobsPerRun > input.limit || !Number.isSafeInteger(allocation.enqueueLimit) || allocation.enqueueLimit < 1 || allocation.enqueueLimit > input.limit) throw new Error("INVALID_SAFETY_WORKER_ALLOCATION");
    if (typeof deps.reserveItem !== "function") return { status: "not_enabled" as const, reason: "SHARED_ITEM_RESERVATION_NOT_READY" };
    if (allocation.maxJobsPerRun === 0) return finish("max_jobs");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(60000, Math.floor(input.remainingMs))));
    const signal = AbortSignal.any([input.signal, controller.signal]);
    try {
    const atomic = deps.atomicInvocation;
    if (atomic && atomic.globalToken !== globalToken) throw new Error("INVALID_ATOMIC_SAFETY_CONTEXT");
    const wired = createRpcSafetyConsumerPorts(config, { readiness: deps.readiness, journal: deps.journal, atomicInvocation: atomic,
      budget: { globalToken, signal, reserve: operation => deps.reserve(globalToken, operation), elapsed: deps.elapsed,
        hasItemCapacity: jobId => (!!jobId && reservedJobs.has(jobId)) || reservedJobs.size < input.limit,
        reserveItem: async item => {
          if (signal.aborted) return false;
          if (reservedJobs.has(item.jobId)) return true;
          if (reservedJobs.size >= input.limit) return false;
          // 응답 유실은 원자 예약 여부 미확인: 재전송 없이 상위 journal을 보존한다.
          let reserved: boolean;
          try { reserved = await bounded(signal, "process", () => deps.reserveItem(globalToken, item, signal)); }
          catch { throw new JobExecutionUnknown("process"); }
          if (typeof reserved !== "boolean") throw new JobExecutionUnknown("process");
          if (reserved) { reservedJobs.add(item.jobId); counts.processedItems = reservedJobs.size; }
          return reserved;
        } } }, fetchImpl);
    const registry = createSafetyConsumerRegistry(wired.consumers);
    if (typeof registry[kind] !== "function") return { status: "not_enabled" as const, reason: "SAFETY_CONTRACT_NOT_READY" };
    const scopedFetch: FetchLike = (url, init) => {
      const joined = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]);
      return bounded(joined, "process", () => fetchImpl(url, { ...init, signal: joined }));
    };
    const repository = createRpcJobRepository(createInternalClient(config, scopedFetch), { workerRunToken: globalToken, supportedClaim: true,
      claimJournal: deps.claimJournal, settlementJournal: deps.settlementJournal, signal, atomicInvocation: atomic });
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
        if (!atomic) await bounded(dueScope.signal, "journal", () => deps.enqueueJournal!.prepare({ requestId, kind, globalToken, limit: allocation.enqueueLimit }));
        dispatched = true;
        if (atomic) {
          const result = await bounded(dueScope.signal, "process", () => atomic.run({ requestId, operation: "due_enqueue", input: { kind, limit: allocation.enqueueLimit } }));
          const body = exact(result.result, ["enqueued"]);
          if (result.state !== "completed" || !Number.isSafeInteger(body.enqueued) || Number(body.enqueued) < 0 || Number(body.enqueued) > allocation.enqueueLimit) throw new JobExecutionUnknown("process");
        } else await bounded(dueScope.signal, "process", () => enqueueSafetyDue(wired.dueEnqueue, kind, allocation.enqueueLimit, globalToken, dueScope.signal));
        returned = true;
        if (!atomic) await bounded(dueScope.signal, "process", () => deps.enqueueJournal!.confirmed(requestId));
      } catch (error) {
        const code = toPublicError(error).error.code;
        if (dispatched && !returned && !dueScope.signal.aborted && ["AUTH_REQUIRED", "ACCESS_DENIED", "STATE_CONFLICT"].includes(code)) throw error;
        try { if (atomic) await atomic.unknown(requestId); else await bounded(dueScope.signal, "journal", () => deps.enqueueJournal!.unknown(requestId)); } catch { /* 원 intent 보존 */ }
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
