/**
 * 담당: 종현담당
 * 역할: 내부 후기 요약 worker의 HTTP 처리와 실행당 한도 안의 반복.
 * 요청 본문은 빈 객체만 허용한다. 모델·외부 목적지·점유 토큰·worker ID를 요청이 정하지 못한다.
 * 실행 한도는 index.ts가 명시 환경값으로만 만든다(기본값 없음). 기준: 260929_종현담당_PLAN.md 5.5·5.6.
 */
import type { JsonValue } from "../_shared/contracts/common.ts";
import type { RpcClient } from "../_shared/db/transport.ts";
import { createCors } from "../_shared/http/cors.ts";
import { HttpError, toPublicError } from "../_shared/http/errors.ts";
import { createRequestContext, readJson } from "../_shared/http/request.ts";
import { jsonFailure, jsonSuccess } from "../_shared/http/response.ts";
import type { JobRunResult } from "../_shared/jobs/lease.ts";

export const REVIEW_SUMMARY_WORKER_PATHS = ["/functions/v1/review-summary-worker", "/review-summary-worker"] as const;

/** not_enabled는 작업을 점유하지 않았다는 뜻이다(대기 작업·실패 횟수 변화 없음). */
export type WorkerNotEnabledReason =
  | "WORKER_NOT_CONFIGURED" | "WORKER_SETTINGS_INVALID"
  | "SUMMARY_VERSIONS_NOT_CONFIGURED" | "SUMMARY_VERSIONS_INVALID" | "SUMMARY_PROMPT_UNSUPPORTED"
  | "MODEL_RETENTION_REVIEW_PENDING" | "MODEL_COST_EVIDENCE_MISSING" | "MODEL_NOT_CONFIGURED" | "MODEL_VERSION_MISMATCH"
  | "SAFETY_CHECK_NOT_APPROVED" | "DB_RPC_NOT_ALLOWED" | "DB_RPC_UNAVAILABLE";
/**
 * idle: 지금 처리할 작업 없음. max_jobs/time_budget: 실행당 한도 도달(남은 작업은 다음 실행에서 이어감).
 * budget_exhausted: AI 예산·공급사 한도 소진(추가 모델 호출 없이 중단, 실패 아님).
 * dependency_unavailable: 큐/DB 전이 실패로 중단(일부 처리 후 발생 가능).
 */
export type WorkerStopReason = "idle" | "max_jobs" | "time_budget" | "budget_exhausted" | "dependency_unavailable";
export interface WorkerCounts {
  claimed: number; succeeded: number; yielded: number; deferred: number;
  retryWait: number; failed: number; superseded: number; leaseLost: number;
}
export type WorkerRunResult =
  | { status: "not_enabled"; reason: WorkerNotEnabledReason }
  | { status: "ran"; stopReason: WorkerStopReason; hasMore: boolean; counts: WorkerCounts };

export interface WorkerBatchInput {
  maxJobsPerRun: number;
  timeBudgetMs: number;
  /** 단조 증가 ms 시계. 테스트는 가상 시계를 주입한다. */
  elapsedMs(): number;
  signal: AbortSignal;
  runOne(): Promise<JobRunResult>;
}

/**
 * 실행당 한도 안에서 runNextJob을 반복한다. 정상 양보(queued)는 한도가 남으면 같은 실행에서 이어간다.
 * 무한 즉시 재점유를 막기 위해 점유 횟수·시간 한도를 매 반복 전에 확인한다.
 */
export async function runSummaryWorkerBatch(input: WorkerBatchInput): Promise<WorkerRunResult> {
  if (!Number.isSafeInteger(input.maxJobsPerRun) || input.maxJobsPerRun < 1 ||
      !Number.isSafeInteger(input.timeBudgetMs) || input.timeBudgetMs < 1) throw new Error("INVALID_WORKER_LIMITS");
  const counts: WorkerCounts = { claimed: 0, succeeded: 0, yielded: 0, deferred: 0, retryWait: 0, failed: 0, superseded: 0, leaseLost: 0 };
  const started = input.elapsedMs();
  let stopReason: WorkerStopReason;
  for (;;) {
    if (counts.claimed >= input.maxJobsPerRun) { stopReason = "max_jobs"; break; }
    if (input.signal.aborted || input.elapsedMs() - started >= input.timeBudgetMs) { stopReason = "time_budget"; break; }
    let result: JobRunResult;
    try {
      result = await input.runOne();
    } catch {
      // 첫 점유 전 실패면 아무것도 처리하지 않은 것이므로 HTTP 오류로 알린다.
      if (counts.claimed === 0) throw new HttpError("EXTERNAL_UNAVAILABLE");
      stopReason = "dependency_unavailable";
      break;
    }
    if (result.status === "idle") { stopReason = "idle"; break; }
    counts.claimed += 1;
    switch (result.status) {
      case "succeeded": counts.succeeded += 1; break;
      case "queued": if (result.reason) counts.deferred += 1; else counts.yielded += 1; break;
      case "retry_wait": counts.retryWait += 1; break;
      case "failed": counts.failed += 1; break;
      case "superseded": counts.superseded += 1; break;
      case "lease_lost": counts.leaseLost += 1; break;
    }
    if (result.reason === "budget_exhausted") { stopReason = "budget_exhausted"; break; }
  }
  return { status: "ran", stopReason, hasMore: stopReason === "max_jobs" || stopReason === "time_budget", counts };
}

const NIL = "00000000-0000-0000-0000-000000000000";
/**
 * 부작용 없는 접근 확인. 존재하지 않는 작업 ID로 호출하면 DB는 lease_lost/state_conflict만 반환한다.
 * 허용 목록에 없는 RPC(ACCESS_DENIED)나 미적용 함수가 있으면 작업을 점유하기 전에 멈춘다.
 */
export async function probeSummaryWorkerRpcs(db: RpcClient): Promise<"ready" | "DB_RPC_NOT_ALLOWED" | "DB_RPC_UNAVAILABLE"> {
  const job = { p_job_id: NIL, p_lease_token: NIL };
  const withRevision = { ...job, p_source_revision: "0" };
  const probes: Array<[string, Record<string, JsonValue>, "lease_lost" | "state_conflict"]> = [
    ["load_review_summary_source", job, "lease_lost"],
    ["load_review_summary_checkpoint", withRevision, "lease_lost"],
    ["save_review_summary_checkpoint", { ...withRevision, p_checkpoint: { schemaVersion: 1, sourceReviewIds: [], nextReviewIndex: 0, nodes: [] } }, "lease_lost"],
    ["discard_review_summary_checkpoint", withRevision, "lease_lost"],
    ["mark_review_summary_insufficient", withRevision, "lease_lost"],
    ["publish_review_summary_for_job", { ...withRevision, p_evidence_review_ids: [], p_summary: "probe", p_model_version: "probe", p_prompt_version: "probe" }, "lease_lost"],
    ["yield_job", { ...job, p_available_at: null }, "state_conflict"],
    ["fail_job", { ...job, p_error_code: "INTERNAL_ERROR" }, "state_conflict"],
    ["supersede_job", job, "state_conflict"],
  ];
  for (const [name, args, expected] of probes) {
    try {
      const body = await db.rpc(name, args);
      if (expected !== "lease_lost" || !body || typeof body !== "object" || Array.isArray(body) || body.status !== "lease_lost") {
        return "DB_RPC_UNAVAILABLE";
      }
    } catch (error) {
      const code = toPublicError(error).error.code;
      if (code === "ACCESS_DENIED") return "DB_RPC_NOT_ALLOWED";
      if (!(expected === "state_conflict" && code === "STATE_CONFLICT")) return "DB_RPC_UNAVAILABLE";
    }
  }
  return "ready";
}

export interface ReviewSummaryWorkerDependencies {
  allowedOrigins: readonly string[];
  maxBodyBytes: number;
  authenticateInternal(request: Request): Promise<void>;
  run(): Promise<WorkerRunResult>;
}

export function createReviewSummaryWorkerHandler(deps: ReviewSummaryWorkerDependencies) {
  if (!Number.isSafeInteger(deps.maxBodyBytes) || deps.maxBodyBytes < 1) throw new TypeError("본문 크기 제한이 필요합니다.");
  const cors = createCors({ allowedOrigins: deps.allowedOrigins, allowedMethods: ["POST"], allowedHeaders: ["authorization", "content-type", "apikey"] });
  return async (request: Request): Promise<Response> => {
    const context = createRequestContext();
    const preflight = cors.preflight(request, context);
    if (preflight) return preflight;
    let originAllowed = false;
    try {
      cors.responseHeaders(request);
      originAllowed = true;
      const url = new URL(request.url);
      if (!(REVIEW_SUMMARY_WORKER_PATHS as readonly string[]).includes(url.pathname)) throw new HttpError("RESOURCE_NOT_FOUND");
      if (request.method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
      await deps.authenticateInternal(request);
      if (url.search) throw new HttpError("INVALID_REQUEST");
      const body = await readJson(request, { maxBytes: deps.maxBodyBytes });
      // 실행 설정은 서버 환경에서만 읽는다. 요청 본문으로 한도·모델·토큰을 바꾸지 못한다.
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) throw new HttpError("INVALID_REQUEST");
      const result = await deps.run();
      return cors.apply(jsonSuccess(result as unknown as JsonValue, context), request);
    } catch (error) {
      const response = jsonFailure(error, context);
      return originAllowed ? cors.apply(response, request) : response;
    }
  };
}
