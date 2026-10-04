/** 일일 즉시 호출과 별도 큐 실행기가 공유하는 전역 실행 점유. 민규 RPC 연결 전에는 예외로 중단한다. */
import type { RpcClient } from "../db/transport.ts";
import { normalizeDbInstant } from "../db/repositories/jobs.ts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface WorkerRunLease {
  token: string;
  expiresAt: string;
  owned: boolean;
}
export interface WorkerRunScope {
  open(token?: string): Promise<WorkerRunLease | null>;
  close(lease: WorkerRunLease): Promise<"applied" | "lease_lost">;
}
export function createWorkerRunScope(db: RpcClient): WorkerRunScope {
  if (!db || typeof db.rpc !== "function") {
    throw new Error("INVALID_WORKER_RUN_DB");
  }
  return {
    async open(token) {
      if (
        token !== undefined && (typeof token !== "string" || !UUID.test(token))
      ) throw new Error("INVALID_WORKER_RUN_TOKEN");
      const result = await db.rpc("acquire_worker_run", {
        p_lease_seconds: 180,
        p_existing_token: token?.toLowerCase() ?? null,
      });
      if (result === null) return null;
      if (
        !result || typeof result !== "object" || Array.isArray(result) ||
        Object.keys(result).length !== 2 ||
        typeof result.token !== "string" || !UUID.test(result.token) ||
        typeof result.expiresAt !== "string" ||
        (token !== undefined &&
          result.token.toLowerCase() !== token.toLowerCase())
      ) throw new Error("INVALID_WORKER_RUN_RESPONSE");
      return {
        token: result.token.toLowerCase(),
        expiresAt: normalizeDbInstant(result.expiresAt),
        owned: token === undefined,
      };
    },
    async close(lease) {
      if (
        !lease || typeof lease.token !== "string" || !UUID.test(lease.token)
      ) throw new Error("INVALID_WORKER_RUN_TOKEN");
      if (!lease.owned) return "applied";
      const result = await db.rpc("release_worker_run", {
        p_token: lease.token,
      });
      if (
        !result || typeof result !== "object" || Array.isArray(result) ||
        Object.keys(result).length !== 1 ||
        !["applied", "lease_lost"].includes(result.status as string)
      ) throw new Error("INVALID_WORKER_RUN_RESPONSE");
      return result.status as "applied" | "lease_lost";
    },
  };
}
