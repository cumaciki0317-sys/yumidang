/** 민규: 탈퇴 요청은 접근 회수와 외부 삭제 완료를 구분한다. 실제 삭제 연결 전 HTTP에는 노출하지 않는다. */
import type { JsonValue } from "../contracts/common.ts";
import type { RpcClient, FetchLike } from "../db/transport.ts";
import { HttpError } from "../http/errors.ts";
import type { RuntimeConfig } from "../config/env.ts";
import { createMemberCleanupAdapter, processMemberCleanupTask, type CleanupExecutionBudget } from "../auth/member-cleanup.ts";
import { createMemberCleanupBudgetReader, createMemberCleanupPorts } from "../db/repositories/member-cleanup.ts";

export interface RetirementResult {
  withdrawalId: string;
  status: "processing" | "completed";
  memberAccessRevoked: true;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseRetirementRequest(body: JsonValue): string {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
      typeof body.withdrawalId !== "string" || !uuid.test(body.withdrawalId)) throw new HttpError("INVALID_REQUEST");
  return body.withdrawalId.toLowerCase();
}
export async function retireMyAccount(db: RpcClient, withdrawalId: string): Promise<RetirementResult> {
  // 직접 호출도 동일한 입력 경계를 적용하고 본문 actor/Auth/Storage 경로는 받지 않는다.
  const id = parseRetirementRequest({ withdrawalId });
  const value = await db.rpc("retire_my_account", { p_withdrawal_id: id });
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3 ||
      value.withdrawalId !== id || value.memberAccessRevoked !== true ||
      (value.status !== "processing" && value.status !== "completed")) throw new HttpError("EXTERNAL_UNAVAILABLE");
  return { withdrawalId: id, status: value.status, memberAccessRevoked: true };
}

/** 신뢰할 로컬 조립 옵션. 회원 입력·HTTP body/header에서 받지 않는다. */
export interface MemberCleanupExecutionOptions { readonly maxExecutionMs?: number; }

/** 내부 실행 계약. 입력·전역 점유 발급/해제·권한 활성화는 기존 runner 책임이다. */
export async function drainMemberCleanupTasks(workerRunToken: string,
  readBudget: (token: string, signal?: AbortSignal) => Promise<CleanupExecutionBudget>,
  processTask: (token: string, budget: CleanupExecutionBudget) => Promise<{ readonly status: "idle" | "applied" }>,
  signal?: AbortSignal, options: MemberCleanupExecutionOptions = {}): Promise<{ status: "ran"; claimed: number; succeeded: number }> {
  if (typeof workerRunToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workerRunToken)) throw new HttpError("INVALID_REQUEST");
  if (signal?.aborted) throw new HttpError("STATE_CONFLICT");
  const startedAt = Date.now(), startedMonotonic = performance.now();
  const maxExecutionMs = options.maxExecutionMs;
  if (maxExecutionMs !== undefined && (!Number.isSafeInteger(maxExecutionMs) || maxExecutionMs <= 0)) throw new HttpError("INVALID_REQUEST");
  const localMs = Math.min(180000, maxExecutionMs ?? 180000);
  const localWallDeadline = startedAt + localMs;
  const abort = new AbortController();
  const readSignal = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
  // 명시적인 로컬 상한은 budget 조회 시간부터 포함한다. abort는 실제 provider 종료 증거가 아니다.
  const readTimer = maxExecutionMs === undefined ? undefined : setTimeout(() => abort.abort(), localMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const budget = await readBudget(workerRunToken.toLowerCase(), readSignal);
    if (readSignal.aborted || performance.now() >= startedMonotonic + localMs || Date.now() >= localWallDeadline) throw new HttpError("STATE_CONFLICT");
    if (!budget || !Number.isSafeInteger(budget.deadlineAt)) throw new HttpError("EXTERNAL_UNAVAILABLE");
    const wallDeadline = Math.min(budget.deadlineAt!, localWallDeadline);
    const remainingWall = wallDeadline - Date.now();
    if (remainingWall <= 0) throw new HttpError("STATE_CONFLICT");
    // 반환 전후 시계 이동도 전역 budget을 늘리지 못하도록 monotonic 상한을 함께 유지한다.
    const monotonicDeadline = Math.min(startedMonotonic + localMs,
      startedMonotonic + Math.max(0, budget.deadlineAt! - startedAt), performance.now() + remainingWall);
    const combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : []), ...(budget.signal ? [budget.signal] : [])]);
    timer = setTimeout(() => abort.abort(), Math.max(0, Math.ceil(monotonicDeadline - performance.now())));
    let succeeded = 0;
    while (succeeded < 20) {
      if (combined.aborted || performance.now() >= monotonicDeadline) throw new HttpError("STATE_CONFLICT");
      // 한 task의 전체60초 상한을 확보하지 못하면 새 claim을 시작하지 않고 다른 종류에 양보한다.
      const remaining = Math.min(Math.floor(monotonicDeadline - performance.now()), wallDeadline - Date.now());
      if (remaining <= 0) throw new HttpError("STATE_CONFLICT");
      if (remaining < 60000) break;
      const deadlineAt = Math.min(wallDeadline, Date.now() + remaining);
      if (deadlineAt <= Date.now()) throw new HttpError("STATE_CONFLICT");
      const result = await processTask(workerRunToken.toLowerCase(), { deadlineAt, signal: combined });
      if (combined.aborted || performance.now() >= monotonicDeadline || Date.now() >= wallDeadline) throw new HttpError("STATE_CONFLICT");
      if (!result || typeof result !== "object" || Object.keys(result).length !== 1 || !["idle", "applied"].includes(result.status)) throw new HttpError("EXTERNAL_UNAVAILABLE");
      if (result.status === "idle") break;
      succeeded++;
    }
    return { status: "ran", claimed: succeeded, succeeded };
  } finally { clearTimeout(timer); clearTimeout(readTimer); }
}

/** 기존 삭제 처리만 조립하며 승인이나 점유 갱신을 수행하지 않는다. */
export function createMemberCleanupExecutor(config: RuntimeConfig, fetchImpl: FetchLike = fetch, options: MemberCleanupExecutionOptions = {}) {
  const readBudget = createMemberCleanupBudgetReader(config, fetchImpl);
  const ports = createMemberCleanupPorts(config, fetchImpl), adapter = createMemberCleanupAdapter(config, fetchImpl);
  return (token: string, signal?: AbortSignal) => drainMemberCleanupTasks(token, readBudget,
    (workerRunToken, budget) => processMemberCleanupTask(workerRunToken, ports, adapter, budget), signal, options);
}
