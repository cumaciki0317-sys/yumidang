/** helpful 만료 예약용 준비 소비자. DB schedule/원자 항목 예약이 주입되기 전 운영 연결하지 않는다. */
import type { RuntimeConfig } from "../config/env.ts";
import type { FetchLike } from "../db/transport.ts";
import { requireInternalConfig } from "../config/env.ts";
import { JobExecutionUnknown } from "./retry.ts";
export interface DueMaintenanceOptions { limit: number; remainingMs: number; signal: AbortSignal; requestId?: string }
export interface FeedbackMaintenancePorts {
  /** 실제 endpoint가 같은 globalToken을 원자 검증한다는 공통 계약 확인. header만으로 증명되지 않는다. */
  readonly scopedEndpointReady: boolean;
  /** DB 시계와 helpful 접수+90일의 다음 만료.
   * globalToken=null이면 경쟁 전역 점유의 만료까지 실행가능 시각을 조정해야 한다.
   * 자기 token이면 자기 점유 때문에 만료가 밀리지 않아야 한다.
   * acquire=null 뒤에도 미래 재개 시각을 반환해야 하며 종결 알림만 믿지 않는다. */
  readSchedule(globalToken?: string | null): Promise<{ serverNow: string; nextDueAt: string | null }>;
  /** 최초 전송 전에 요청키·token·배정량을 영속 준비한다. HTTP 전송은 이 완료 뒤 한 번만 한다. */
  prepare(input: { requestId: string; globalToken: string; limit: number; remainingMs: number }, signal: AbortSignal): Promise<{ fresh: boolean }>;
  /** 저장된 SQL105 결과만 조회한다. 없거나 다른 request 결과는 성공으로 바꾸지 않는다. */
  readResult(requestId: string, signal: AbortSignal): Promise<unknown>;
  unknown(requestId: string, signal?: AbortSignal): Promise<void>;
}
export function createAiFeedbackMaintenance(config: RuntimeConfig, ports: FeedbackMaintenancePorts, fetchImpl: FetchLike = fetch) {
  requireInternalConfig(config);
  const origin = new URL(config.supabaseUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
    ports?.scopedEndpointReady !== true || typeof ports?.readSchedule !== "function" || typeof ports?.prepare !== "function" || typeof ports?.readResult !== "function" || typeof ports?.unknown !== "function") throw new Error("AI_FEEDBACK_MAINTENANCE_NOT_READY");
  return Object.freeze({
    readSchedule: ports.readSchedule,
    async run(globalToken: string, input: DueMaintenanceOptions) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(globalToken) ||
        !Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 20 || !Number.isFinite(input.remainingMs) || input.remainingMs < 0 || input.remainingMs > 180000 || !(input.signal instanceof AbortSignal)) throw new Error("INVALID_FEEDBACK_MAINTENANCE_INPUT");
      if (input.limit === 0 || input.remainingMs < 1 || input.signal.aborted) return { purged: 0, processedItems: 0 };
      const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), Math.min(input.remainingMs, config.upstreamTimeoutMs));
      const signal = AbortSignal.any([input.signal, controller.signal]);
      const bounded = <T>(operation: () => Promise<T>) => new Promise<T>((resolve, reject) => {
        const abort = () => reject(new JobExecutionUnknown("process"));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => { if (signal.aborted) throw new JobExecutionUnknown("process"); return operation(); })
          .then(value => signal.aborted ? abort() : resolve(value), reject).finally(() => signal.removeEventListener("abort", abort));
      });
      try {
        const reserved = input.limit;
        const requestId = input.requestId ?? crypto.randomUUID();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) throw new JobExecutionUnknown("journal");
        // 최초 전송 전에 영속 준비가 완료되지 않으면 HTTP를 시작하지 않는다.
        const prepared = await bounded(() => ports.prepare({ requestId, globalToken, limit: reserved, remainingMs: Math.floor(input.remainingMs) }, signal));
        if (!prepared || Object.keys(prepared).length !== 1 || typeof prepared.fresh !== "boolean") throw new JobExecutionUnknown("journal");
        // 기존 의도가 있으면 새 전송을 만들지 않고 저장 결과만 조회한다.
        if (!prepared.fresh) return decodeFeedbackStoredResult(await bounded(() => ports.readResult(requestId, signal)), requestId, reserved);
        try {
        const response = await bounded(() => fetchImpl(`${origin.origin}/functions/v1/service-api/internal/ai-feedback-maintenance`, {
          method: "POST", headers: { Authorization: `Bearer ${config.internalWorkerSecret}`, "Content-Type": "application/json", "x-worker-run-token": globalToken, "x-worker-request-id": requestId, "x-worker-time-budget-ms": String(Math.floor(input.remainingMs)) },
          body: JSON.stringify({ limit: reserved }), signal, redirect: "error", credentials: "omit",
        }));
        const envelope = await bounded(() => response.json());
        const data = envelope?.data;
        if (response.status !== 200 || envelope.error || !data || Object.keys(data).length !== 1 ||
          !Number.isSafeInteger(data.deletedCount) || data.deletedCount < 0 || data.deletedCount > reserved) throw new JobExecutionUnknown("process");
        // 예약한 항목은 확정 응답 때만 상위 journal로 종결하며 빈 삭제도 예약을 임의 반환하지 않는다.
        // 성공 HTTP만으로 journal을 닫지 않는다. 실제 저장 결과를 다시 읽어 일치해야 한다.
        const saved = await bounded(() => ports.readResult(requestId, signal));
        const recovered = decodeFeedbackStoredResult(saved, requestId, reserved);
        if (recovered.purged !== data.deletedCount) throw new JobExecutionUnknown("process");
        return recovered;
        } catch {
          if (!signal.aborted) {
            try { return decodeFeedbackStoredResult(await bounded(() => ports.readResult(requestId, signal)), requestId, reserved); }
            catch { /* 저장 결과가 확정되지 않으면 새 키나 HTTP 재전송 없이 UNKNOWN 보존 */ }
          }
          // 중단된 실행 신호로 새 작업을 시작하지 않는다. 최소 UNKNOWN 기록만 기존 RPC timeout 안에서 보존한다.
          let unknownTimer: ReturnType<typeof setTimeout> | undefined;
          const unknownController = new AbortController();
          try {
            await Promise.race([ports.unknown(requestId, unknownController.signal), new Promise<void>((_, reject) => {
              unknownTimer = setTimeout(() => { unknownController.abort(); reject(new JobExecutionUnknown("journal")); }, config.upstreamTimeoutMs);
            })]);
          } catch { /* 최초 영속 요청은 보존 */ }
          finally { clearTimeout(unknownTimer); }
          throw new JobExecutionUnknown("process");
        }
      } catch { throw new JobExecutionUnknown("process"); }
      finally { clearTimeout(deadline); }
    },
  });
}

/** SQL102 get_worker_runtime_operation으로 읽은 SQL105 completed 결과의 정확한 검사. */
export function decodeFeedbackStoredResult(value: unknown, requestId: string, limit: number) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new JobExecutionUnknown("process");
  const v = value as Record<string, unknown>, r = v.result as Record<string, unknown> | null;
  if (Object.keys(v).length !== 5 || v.requestId !== requestId || v.state !== "completed" ||
      typeof v.closedAt !== "string" || !Number.isFinite(Date.parse(v.closedAt)) || typeof v.replayed !== "boolean" ||
      !r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).length !== 1 ||
      !Number.isSafeInteger(r.deletedCount) || Number(r.deletedCount) < 0 || Number(r.deletedCount) > limit) throw new JobExecutionUnknown("process");
  return { purged: Number(r.deletedCount), processedItems: limit };
}
