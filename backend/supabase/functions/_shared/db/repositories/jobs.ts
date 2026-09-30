/** 종현 작업 저장소 포트. 모든 시간·점유·멱등성의 원자적 판정은 실제 DB RPC 책임이다. */
import type { JsonValue } from "../../contracts/common.ts";
import { toPublicError } from "../../http/errors.ts";
import type { RpcClient } from "../transport.ts";

export type JobReference =
  | { kind: "review_summary"; targetUserId: string; sourceRevision: string; modelVersion: string; promptVersion: string }
  | { kind: "event_sync"; provider: string; windowStart: string; windowEnd: string }
  | { kind: "auto_complete"; appointmentId: string; expectedDueAt: string }
  | { kind: "review_release"; appointmentId: string; expectedDueAt: string };
export type JobKind = JobReference["kind"];
export interface EnqueuedJob {
  reference: JobReference;
  idempotencyKey: string;
  runAt: string;
}
export interface ClaimedJob {
  jobId: string;
  leaseToken: string;
  leaseUntil: string;
  reference: JobReference;
  /** 이전 실패 횟수. DB의 claim 횟수 attempt와 별개이며, 정상 분할 실행(yielded)은 증가시키지 않는다. */
  failedAttempts: number;
}
export interface JobSettlement {
  jobId: string;
  leaseToken: string;
  status: "succeeded" | "queued" | "retry_wait" | "failed" | "superseded";
  retryAt?: string;
  errorCode?: string;
}
export interface JobRepository {
  /** 별도 등록용. 원문 변경은 DB가 같은 트랜잭션에 outbox를 기록하고 maintenance가 enqueue한다. */
  enqueue(input: EnqueuedJob): Promise<{ jobId: string; created: boolean }>;
  /** DB 시계 기준 due/점유 만료 검사 + 현재 토큰 발급. */
  claim(input: { workerId: string; kinds: JobKind[]; leaseDurationMs: number }): Promise<ClaimedJob | null>;
  /**
   * token/만료 재확인 후 전이. retry_wait/failed는 실패 횟수 증가; queued는 증가하지 않는다.
   * failed/superseded 종결 시 해당 요약 작업의 checkpoint도 원자적으로 폐기한다.
   */
  settle(input: JobSettlement): Promise<"applied" | "lease_lost">;
}

// ---- 실제 DB RPC 어댑터(제안 SQL 03 적용 전제) -------------------------------------------------
/** 내부 클라이언트 허용 목록에 필요한 작업 RPC. yield/fail/supersede는 민규 허용 목록 추가가 필요하다. */
export const JOB_RPCS = ["enqueue_job", "claim_job", "complete_job", "retry_job", "yield_job", "fail_job", "supersede_job"] as const;
/** 현재 DB kind CHECK가 허용하는 유일한 작업 종류. 다른 kind는 DB 계약 확장 전까지 RPC로 보내지 않는다. */
const DB_KINDS: ReadonlySet<JobKind> = new Set(["review_summary"]);
/**
 * 실행기 오류 코드 → DB last_error_code. DB 허용 목록은 5개이므로 명시적으로 축약한다(손실 있음).
 * 반대 방향 읽기는 현재 RPC가 반환하지 않으므로 제공하지 않는다.
 */
export const JOB_ERROR_TO_DB: Readonly<Record<string, "UPSTREAM_UNAVAILABLE" | "INTERNAL_ERROR">> = Object.freeze({
  DEPENDENCY_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
  MODEL_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
  INVALID_JOB: "INTERNAL_ERROR",
  HANDLER_FAILED: "INTERNAL_ERROR",
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION = /^(0|[1-9][0-9]{0,18})$/;
const VERSION = /^[A-Za-z0-9_.-]{1,64}$/;
const DEDUPE = /^[A-Za-z0-9_.:-]{1,512}$/;

export class JobWireError extends Error {
  constructor() { super("INVALID_JOB_RESPONSE"); this.name = "JobWireError"; }
}
const wire = (): never => { throw new JobWireError(); };
function object(value: JsonValue | undefined, keys: readonly string[]): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return wire();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) return wire();
  return value;
}
function count(value: JsonValue | undefined, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) return wire();
  return value;
}
/**
 * PostgreSQL timestamptz JSON(마이크로초 가능)을 밀리초 ISO로 변환한다.
 * 소수점 이하를 버리므로 결과는 실제 만료 이하(보수적)다.
 */
export function normalizeDbInstant(value: JsonValue | undefined): string {
  if (typeof value !== "string") return wire();
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(value);
  if (!match) return wire();
  const offset = match[4] === "Z" ? "Z" : match[4].length === 3 ? match[4] + ":00" : match[4].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const millis = (match[3] ?? "").padEnd(3, "0").slice(0, 3);
  const parsed = new Date(`${match[1]}T${match[2]}.${millis}${offset}`);
  if (!Number.isFinite(parsed.getTime())) return wire();
  return parsed.toISOString();
}
function isStateConflict(error: unknown): boolean {
  return toPublicError(error).error.code === "STATE_CONFLICT";
}

/**
 * 제안 SQL 03의 작업 RPC 연결. payload.profileId ↔ reference.targetUserId, leaseExpiresAt → leaseUntil 등
 * DB 계약과 내부 계약의 이름 차이를 명시적으로 변환한다. RPC 'state_conflict'는 lease_lost로 바꾼다.
 */
export function createRpcJobRepository(db: RpcClient): JobRepository {
  if (!db || typeof db.rpc !== "function") throw new TypeError("INVALID_JOB_DB");
  // 포트 타입을 명시해 claim 결과의 kind 리터럴 등 계약을 정적 검사한다.
  const repository: JobRepository = {
    async enqueue(input: EnqueuedJob) {
      const reference = input?.reference;
      if (!reference || reference.kind !== "review_summary") throw new Error("UNSUPPORTED_JOB_KIND");
      if (!UUID.test(reference.targetUserId) || !REVISION.test(reference.sourceRevision) ||
          !VERSION.test(reference.modelVersion) || !VERSION.test(reference.promptVersion) ||
          typeof input.idempotencyKey !== "string" || !DEDUPE.test(input.idempotencyKey) ||
          typeof input.runAt !== "string" || !Number.isFinite(Date.parse(input.runAt))) throw new Error("INVALID_JOB_REFERENCE");
      const result = object(await db.rpc("enqueue_job", {
        p_kind: "review_summary", p_dedupe_key: input.idempotencyKey,
        p_payload: {
          profileId: reference.targetUserId, sourceRevision: reference.sourceRevision,
          modelVersion: reference.modelVersion, promptVersion: reference.promptVersion,
        },
        p_available_at: input.runAt,
      }), ["jobId", "deduplicated", "status"]);
      if (typeof result.jobId !== "string" || !UUID.test(result.jobId) || typeof result.deduplicated !== "boolean" ||
          typeof result.status !== "string") return wire();
      return { jobId: result.jobId, created: !result.deduplicated };
    },
    async claim(input) {
      if (!input || typeof input.workerId !== "string" || !UUID.test(input.workerId) || !Array.isArray(input.kinds) ||
          !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1000 || input.leaseDurationMs % 1000 !== 0 ||
          input.leaseDurationMs > 86_400_000) throw new Error("INVALID_CLAIM_INPUT");
      // DB claim_job은 kind 필터가 없다. 요청 kinds에 DB 지원 kind가 없으면 점유하지 않는다.
      if (!input.kinds.some((kind) => DB_KINDS.has(kind))) return null;
      const envelope = object(await db.rpc("claim_job", {
        p_worker_id: input.workerId, p_lease_seconds: input.leaseDurationMs / 1000,
      }), ["job"]);
      if (envelope.job === null) return null;
      const job = object(envelope.job, ["jobId", "kind", "payload", "leaseToken", "leaseExpiresAt", "attempt", "failedAttempts"]);
      const payload = object(job.payload, ["profileId", "sourceRevision", "modelVersion", "promptVersion"]);
      if (typeof job.jobId !== "string" || !UUID.test(job.jobId) || typeof job.leaseToken !== "string" || !UUID.test(job.leaseToken) ||
          job.kind !== "review_summary" || !input.kinds.includes("review_summary") ||
          typeof payload.profileId !== "string" || !UUID.test(payload.profileId) ||
          typeof payload.sourceRevision !== "string" || !REVISION.test(payload.sourceRevision) ||
          typeof payload.modelVersion !== "string" || !VERSION.test(payload.modelVersion) ||
          typeof payload.promptVersion !== "string" || !VERSION.test(payload.promptVersion)) return wire();
      count(job.attempt, 1);
      return {
        jobId: job.jobId, leaseToken: job.leaseToken, leaseUntil: normalizeDbInstant(job.leaseExpiresAt),
        failedAttempts: count(job.failedAttempts, 0),
        reference: {
          kind: "review_summary", targetUserId: payload.profileId, sourceRevision: payload.sourceRevision,
          modelVersion: payload.modelVersion, promptVersion: payload.promptVersion,
        },
      };
    },
    async settle(input) {
      if (!input || typeof input.jobId !== "string" || !UUID.test(input.jobId) ||
          typeof input.leaseToken !== "string" || !UUID.test(input.leaseToken)) throw new Error("INVALID_SETTLEMENT");
      const retryAt = input.retryAt === undefined ? undefined : new Date(input.retryAt);
      if (retryAt && !Number.isFinite(retryAt.getTime())) throw new Error("INVALID_SETTLEMENT");
      const errorCode = (): string => {
        const mapped = typeof input.errorCode === "string" ? JOB_ERROR_TO_DB[input.errorCode] : undefined;
        if (!mapped) throw new Error("INVALID_SETTLEMENT");
        return mapped;
      };
      const base = { p_job_id: input.jobId, p_lease_token: input.leaseToken };
      let name: string;
      let args: Record<string, JsonValue>;
      switch (input.status) {
        case "succeeded": name = "complete_job"; args = base; break;
        // 정상 양보(retryAt 없음)는 DB 현재 시각, 한도 소진 연기는 명시 시각. 실패 횟수를 늘리지 않는다.
        case "queued": name = "yield_job"; args = { ...base, p_available_at: retryAt ? retryAt.toISOString() : null }; break;
        case "retry_wait":
          if (!retryAt) throw new Error("INVALID_SETTLEMENT");
          name = "retry_job"; args = { ...base, p_available_at: retryAt.toISOString(), p_error_code: errorCode() }; break;
        case "failed": name = "fail_job"; args = { ...base, p_error_code: errorCode() }; break;
        case "superseded": name = "supersede_job"; args = base; break;
        default: throw new Error("INVALID_SETTLEMENT");
      }
      let result: JsonValue;
      try {
        result = await db.rpc(name, args);
      } catch (error) {
        if (isStateConflict(error)) return "lease_lost";
        throw error;
      }
      const expected = input.status;
      const body = object(result, ["jobId", "status"]);
      if (body.jobId !== input.jobId || body.status !== expected) return wire();
      return "applied";
    },
  };
  return Object.freeze(repository);
}
