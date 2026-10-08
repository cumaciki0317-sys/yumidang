/** helpful 만료 예약용 준비 소비자. DB schedule/원자 항목 예약이 주입되기 전 운영 연결하지 않는다. */
import type { RuntimeConfig } from "../config/env.ts";
import type { FetchLike } from "../db/transport.ts";
import { requireInternalConfig } from "../config/env.ts";
import { JobExecutionUnknown } from "./retry.ts";
export interface DueMaintenanceOptions { limit: number; remainingMs: number; signal: AbortSignal }
export interface FeedbackMaintenancePorts {
  /** 실제 endpoint가 같은 globalToken을 원자 검증한다는 공통 계약 확인. header만으로 증명되지 않는다. */
  readonly scopedEndpointReady: boolean;
  /** DB 시계와 helpful 접수+90일의 다음 만료.
   * globalToken=null이면 경쟁 전역 점유의 만료까지 실행가능 시각을 조정해야 한다.
   * 자기 token이면 자기 점유 때문에 만료가 밀리지 않아야 한다.
   * acquire=null 뒤에도 미래 재개 시각을 반환해야 하며 종결 알림만 믿지 않는다. */
  readSchedule(globalToken?: string | null): Promise<{ serverNow: string; nextDueAt: string | null }>;
  /** 삭제 전에 DB 전역 처리항목을 원자 예약. RPC 호출수와 별도로 센다. */
  reserveItems(globalToken: string, limit: number, signal: AbortSignal): Promise<number>;
}
export function createAiFeedbackMaintenance(config: RuntimeConfig, ports: FeedbackMaintenancePorts, fetchImpl: FetchLike = fetch) {
  requireInternalConfig(config);
  const origin = new URL(config.supabaseUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
    ports?.scopedEndpointReady !== true || typeof ports?.readSchedule !== "function" || typeof ports?.reserveItems !== "function") throw new Error("AI_FEEDBACK_MAINTENANCE_NOT_READY");
  return Object.freeze({
    readSchedule: ports.readSchedule,
    async run(globalToken: string, input: DueMaintenanceOptions) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(globalToken) ||
        !Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 20 || !Number.isFinite(input.remainingMs) || input.remainingMs < 0 || input.remainingMs > 180000 || !(input.signal instanceof AbortSignal)) throw new Error("INVALID_FEEDBACK_MAINTENANCE_INPUT");
      if (input.limit === 0 || input.remainingMs === 0 || input.signal.aborted) return { purged: 0, processedItems: 0 };
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
        const reserved = await bounded(() => ports.reserveItems(globalToken, input.limit, signal));
        if (!Number.isSafeInteger(reserved) || reserved < 0 || reserved > input.limit) throw new JobExecutionUnknown("process");
        if (reserved === 0) return { purged: 0, processedItems: 0 };
        const response = await bounded(() => fetchImpl(`${origin.origin}/functions/v1/service-api/internal/ai-feedback-maintenance`, {
          method: "POST", headers: { Authorization: `Bearer ${config.internalWorkerSecret}`, "Content-Type": "application/json", "x-worker-run-token": globalToken },
          body: JSON.stringify({ limit: reserved }), signal, redirect: "error", credentials: "omit",
        }));
        const envelope = await bounded(() => response.json());
        const data = envelope?.data;
        if (response.status !== 200 || envelope.error || !data || Object.keys(data).length !== 1 ||
          !Number.isSafeInteger(data.deletedCount) || data.deletedCount < 0 || data.deletedCount > reserved) throw new JobExecutionUnknown("process");
        // 예약한 항목은 확정 응답 때만 상위 journal로 종결하며 빈 삭제도 예약을 임의 반환하지 않는다.
        return { purged: data.deletedCount, processedItems: reserved };
      } catch { throw new JobExecutionUnknown("process"); }
      finally { clearTimeout(deadline); }
    },
  });
}
