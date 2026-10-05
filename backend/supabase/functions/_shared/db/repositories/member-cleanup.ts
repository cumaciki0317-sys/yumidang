/** 민규: cleanup 전용5개 RPC만 연결한다. 운영 SQL guard/ACL을 열거나 전역 lease를 갱신하지 않는다. */
import type { MemberCleanupPorts, CleanupFence, CleanupExecutionBudget } from "../../auth/member-cleanup.ts";
import { requireInternalConfig, type RuntimeConfig } from "../../config/env.ts";
import { createRpcTransport, type FetchLike } from "../transport.ts";
import type { JsonValue } from "../../contracts/common.ts";
import { HttpError } from "../../http/errors.ts";

const cleanupRpcs = new Set(["claim_member_cleanup_task", "check_member_cleanup_task",
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
