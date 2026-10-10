/** 민규: cleanup 전용6개 RPC만 연결한다. 운영 SQL guard/ACL을 열거나 전역 lease를 갱신하지 않는다. */
import { decodeMemberCleanupReconcileProof, type MemberCleanupPorts, type CleanupFence, type CleanupExecutionBudget,
  type MemberCleanupReconcileBinding, type MemberCleanupReconcilePorts, type MemberCleanupReconcileProof } from "../../auth/member-cleanup.ts";
import { requireInternalConfig, type RuntimeConfig } from "../../config/env.ts";
import { createRpcTransport, type FetchLike } from "../transport.ts";
import type { JsonValue } from "../../contracts/common.ts";
import { HttpError } from "../../http/errors.ts";

const cleanupRpcs = new Set(["begin_member_cleanup_delete", "claim_member_cleanup_task", "check_member_cleanup_task",
  "get_member_cleanup_delete_ack", "record_member_cleanup_delete_ack", "complete_member_cleanup_task"]);
function fenceArguments(fence: CleanupFence): Record<string, JsonValue> {
  return { p_task_id: fence.taskId, p_lease_token: fence.leaseToken,
    p_worker_run_token: fence.workerRunToken, p_object_id: fence.objectId };
}
export function createMemberCleanupPorts(config: RuntimeConfig, fetchImpl: FetchLike = fetch): MemberCleanupPorts {
  const { serviceKey } = requireInternalConfig(config);
  const rpc = (name: string, args: Record<string, JsonValue>, signal?: AbortSignal) => {
    if (signal?.aborted) return Promise.reject(new HttpError("STATE_CONFLICT"));
    const scopedFetch: FetchLike = (url, init) => fetchImpl(url, {
      ...init, signal: signal ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal,
    });
    return createRpcTransport(config, serviceKey, serviceKey, cleanupRpcs, scopedFetch).rpc(name, args);
  };
  return Object.freeze({
    beginDelete: (fence: CleanupFence, signal?: AbortSignal) => rpc("begin_member_cleanup_delete", fenceArguments(fence), signal),
    claim: (workerRunToken: string, signal?: AbortSignal) => rpc("claim_member_cleanup_task", { p_worker_run_token: workerRunToken }, signal),
    assertCurrent: (fence: CleanupFence, signal?: AbortSignal) => rpc("check_member_cleanup_task", fenceArguments(fence), signal),
    getDeleteAck: (fence: CleanupFence, signal?: AbortSignal) => rpc("get_member_cleanup_delete_ack", fenceArguments(fence), signal),
    recordDeleteAck: (fence: CleanupFence & { readonly ackSha256: string }, signal?: AbortSignal) => rpc("record_member_cleanup_delete_ack",
      { ...fenceArguments(fence), p_ack_sha256: fence.ackSha256 }, signal),
    complete: (fence: CleanupFence & { readonly evidenceSha256: string }, signal?: AbortSignal) => rpc("complete_member_cleanup_task",
      { ...fenceArguments(fence), p_evidence_sha256: fence.evidenceSha256 }, signal),
  });
}

/** 기존5포트와 분리한 읽기 전용 budget RPC. DB 권한·guard·점유를 변경하지 않는다. */
export function createMemberCleanupBudgetReader(config: RuntimeConfig, fetchImpl: FetchLike = fetch) {
  const { serviceKey } = requireInternalConfig(config);
  const names = new Set(["read_worker_run_budget"]);
  return async (workerRunToken: string, signal?: AbortSignal): Promise<CleanupExecutionBudget> => {
    if (typeof workerRunToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workerRunToken)) throw new HttpError("INVALID_REQUEST");
    if (signal?.aborted) throw new HttpError("STATE_CONFLICT");
    const startedAt = Date.now(), startedMonotonic = performance.now();
    const scopedFetch: FetchLike = (url, init) => fetchImpl(url, {
      ...init, signal: signal ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal,
    });
    const value = await createRpcTransport(config, serviceKey, serviceKey, names, scopedFetch).rpc("read_worker_run_budget", {
      p_worker_run_token: workerRunToken.toLowerCase(),
    });
    if (signal?.aborted) throw new HttpError("STATE_CONFLICT");
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 ||
      typeof value.remainingMs !== "number" || !Number.isSafeInteger(value.remainingMs) || value.remainingMs < 1 || value.remainingMs > 180000) throw new HttpError("EXTERNAL_UNAVAILABLE");
    // DB/host 절대 시각을 비교하지 않는다. 전체 왕복시간을 보수적으로 차감한다.
    const elapsed = Math.ceil(performance.now() - startedMonotonic);
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= value.remainingMs) throw new HttpError("STATE_CONFLICT");
    const now = Date.now();
    // 뒤로 이동한 host 시계도 실제 남은 실행시간을 늘릴 수 없다. 앞으로 이동하면 조기 중단한다.
    const deadlineAt = Math.min(startedAt + value.remainingMs, now + value.remainingMs - elapsed);
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= now) throw new HttpError("STATE_CONFLICT");
    return Object.freeze({ deadlineAt, ...(signal ? { signal } : {}) });
  };
}

/** SQL108 legacy 복구만 연결한다. SQL110 tracked UNKNOWN 완료에는 아래 SQL115 reconcile 포트를 사용한다. */
export function createMemberCleanupAckRecoveryPorts(config: RuntimeConfig, taskId: string, fetchImpl: FetchLike = fetch): MemberCleanupPorts {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) throw new HttpError("INVALID_REQUEST");
  const base = createMemberCleanupPorts(config, fetchImpl);
  const { serviceKey } = requireInternalConfig(config);
  const denied = () => Promise.reject(new HttpError("STATE_CONFLICT"));
  return Object.freeze({ ...base,
    claim: (workerRunToken: string, signal?: AbortSignal) => {
      if (signal?.aborted) return denied();
      const scoped: FetchLike = (url, init) => fetchImpl(url, { ...init, signal: signal ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal });
      return createRpcTransport(config, serviceKey, serviceKey, new Set(["claim_member_cleanup_ack_recovery"]), scoped).rpc("claim_member_cleanup_ack_recovery", { p_task_id: taskId.toLowerCase(), p_worker_run_token: workerRunToken });
    }, beginDelete: denied, recordDeleteAck: denied,
  });
}

/** SQL115 전용 수동 복구 bridge. 생성은 부작용 없으며 runtime/HTTP에 기본 설치하지 않는다. */
export function createMemberCleanupReconcilePorts(config: RuntimeConfig, input: MemberCleanupReconcileBinding,
  fetchImpl: FetchLike = fetch): MemberCleanupReconcilePorts {
  const keys = ["recoveryRequestId", "invocationRequestId", "taskId", "recoveryGlobalToken"];
  const id = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) && v !== "00000000-0000-0000-0000-000000000000";
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length || keys.some(k => !Object.hasOwn(input, k))) throw new HttpError("INVALID_REQUEST");
  const binding = Object.freeze({ ...input });
  if (Object.values(binding).some(v => !id(v))) throw new HttpError("INVALID_REQUEST");
  const { serviceKey } = requireInternalConfig(config);
  const names = new Set(["begin_member_cleanup_reconcile", "get_member_cleanup_reconcile", "finish_member_cleanup_reconcile", "check_member_cleanup_task", "get_member_cleanup_delete_ack"]);
  let beginAttempted = false, freshBegin = false, finishAttempted = false, baseline: MemberCleanupReconcileProof | undefined;
  const rpc = async (name: string, args: Record<string, JsonValue>, signal?: AbortSignal) => {
    if (signal?.aborted) throw new HttpError("STATE_CONFLICT");
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), config.upstreamTimeoutMs);
    const combined = signal ? AbortSignal.any([timeout.signal, signal]) : timeout.signal;
    const scoped: FetchLike = (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.any([combined, ...(init?.signal ? [init.signal] : [])]) });
    let remove = () => {};
    try {
      return await new Promise<JsonValue>((resolve, reject) => {
        const stop = () => reject(new HttpError("EXTERNAL_UNAVAILABLE"));
        combined.addEventListener("abort", stop, { once: true }); remove = () => combined.removeEventListener("abort", stop);
        Promise.resolve().then(() => {
          if (combined.aborted) throw new HttpError("STATE_CONFLICT");
          return createRpcTransport(config, serviceKey, serviceKey, names, scoped).rpc(name, args);
        }).then(value => combined.aborted ? stop() : resolve(value), reject);
      });
    } finally { clearTimeout(timer); remove(); }
  };
  const get = async (signal?: AbortSignal) => {
    const proof = decodeMemberCleanupReconcileProof(await rpc("get_member_cleanup_reconcile", { p_recovery_request_id: binding.recoveryRequestId }, signal), binding);
    if (baseline && JSON.stringify({ original: proof.original, recovery: proof.recovery }) !== JSON.stringify({ original: baseline.original, recovery: baseline.recovery })) throw new HttpError("EXTERNAL_UNAVAILABLE");
    baseline ??= proof;
    return proof;
  };
  const checkFence = (fence: CleanupFence) => {
    const fields = ["taskId", "leaseToken", "workerRunToken", "objectId"];
    if (!freshBegin || !baseline || baseline.state !== "prepared" || !fence || typeof fence !== "object" || Array.isArray(fence) || Object.keys(fence).length !== 4 || fields.some(k => !Object.hasOwn(fence, k))) throw new HttpError("STATE_CONFLICT");
    const snapshot = Object.freeze({ ...fence });
    if (snapshot.taskId !== binding.taskId || snapshot.workerRunToken !== binding.recoveryGlobalToken || snapshot.leaseToken !== baseline.recovery.leaseToken || snapshot.objectId !== baseline.original.objectId) throw new HttpError("STATE_CONFLICT");
    return fenceArguments(snapshot);
  };
  return Object.freeze({ binding, get,
    begin: async (signal?: AbortSignal) => {
      if (beginAttempted) throw new HttpError("STATE_CONFLICT");
      beginAttempted = true;
      const value = await rpc("begin_member_cleanup_reconcile", { p_recovery_request_id: binding.recoveryRequestId, p_invocation_request_id: binding.invocationRequestId, p_task_id: binding.taskId, p_recovery_global_token: binding.recoveryGlobalToken }, signal);
      freshBegin = !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === "fresh,recoveryRequestId,state,task" && value.recoveryRequestId === binding.recoveryRequestId && value.state === "prepared" && value.fresh === true && !!value.task && typeof value.task === "object" && !Array.isArray(value.task);
      return value;
    },
    assertCurrent: (fence: CleanupFence, signal?: AbortSignal) => rpc("check_member_cleanup_task", checkFence(fence), signal),
    getDeleteAck: (fence: CleanupFence, signal?: AbortSignal) => rpc("get_member_cleanup_delete_ack", checkFence(fence), signal),
    finish: (evidenceSha256: string, signal?: AbortSignal) => {
      if (!freshBegin || !baseline || baseline.state !== "prepared" || typeof evidenceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidenceSha256) || finishAttempted) return Promise.reject(new HttpError("STATE_CONFLICT"));
      finishAttempted = true;
      return rpc("finish_member_cleanup_reconcile", { p_recovery_request_id: binding.recoveryRequestId, p_evidence_sha256: evidenceSha256 }, signal);
    },
  });
}

/** Minimal recovery listing grants no execution permission and never returns object paths. */
export function createMemberCleanupRecoveryReader(config: RuntimeConfig, fetchImpl: FetchLike = fetch) {
  const { serviceKey } = requireInternalConfig(config);
  const db = createRpcTransport(config, serviceKey, serviceKey, new Set(["read_member_cleanup_recovery"]), fetchImpl);
  return (afterId: string | null = null, limit = 20) => {
    if ((afterId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(afterId)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError("INVALID_REQUEST");
    return db.rpc("read_member_cleanup_recovery", { p_after_id: afterId?.toLowerCase() ?? null, p_limit: limit });
  };
}
