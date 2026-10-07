/**
 * 종현: 기존 공통 설정·내부 인증을 사용하는 maintenance·일일 묶음 연결. import는 실행/예약 등록을 하지 않는다.
 * 호출 목적지는 설정된 Supabase의 고정 함수 경로뿐이며 요청으로 바꿀 수 없다.
 */
import { loadRuntimeConfig, requireInternalConfig, type EnvReader } from "../_shared/config/env.ts";
import { requireInternalCaller } from "../_shared/auth/internal-caller.ts";
import { fetchJson, type FetchLike } from "../_shared/db/transport.ts";
import type { JsonValue } from "../_shared/contracts/common.ts";
import { HttpError } from "../_shared/http/errors.ts";
import { loadDailySettings, runDaily, type EventSyncPageResult, type WorkerInvocationResult, type EventDailySettings } from "../_shared/jobs/daily.ts";
import { createScheduledJobsHandler } from "./handler.ts";

const unavailable = (): never => { throw new HttpError("EXTERNAL_UNAVAILABLE"); };
function record(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
  return value;
}
function count(value: JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return unavailable();
  return value;
}
const PUBLIC_CODES = new Set(["AUTH_REQUIRED", "ACCESS_DENIED", "RESOURCE_NOT_FOUND", "INVALID_REQUEST", "STATE_CONFLICT",
  "EXTERNAL_UNAVAILABLE", "INTERNAL_ERROR", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "METHOD_NOT_ALLOWED"]);
function exact(value: JsonValue | undefined, keys: readonly string[]): Record<string, JsonValue> {
  const body = record(value);
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) return unavailable();
  return body;
}
/** 내부 함수의 오류 envelope에서 공개 코드만 옮긴다. 원문 메시지는 버린다. */
function upstreamFailure(body: JsonValue): never {
  const code = body && typeof body === "object" && !Array.isArray(body) && body.error && typeof body.error === "object" &&
    !Array.isArray(body.error) ? body.error.code : null;
  throw new HttpError(typeof code === "string" && PUBLIC_CODES.has(code) ? code as never : "EXTERNAL_UNAVAILABLE");
}
/** lane E event-sync 계약: {status:"synced", provider, fetchedCount, savedCount, hasMore}. 0건 성공을 만들지 않는다. */
function projectEventSync(body: JsonValue, provider: string): EventSyncPageResult {
  const data = exact(exact(body, ["data", "requestId"]).data, ["status", "provider", "fetchedCount", "savedCount", "hasMore"]);
  if (data.status !== "synced" || data.provider !== provider || typeof data.hasMore !== "boolean") return unavailable();
  return { status: "synced", provider, fetchedCount: count(data.fetchedCount), savedCount: count(data.savedCount), hasMore: data.hasMore };
}
const WORKER_COUNTS = ["claimed", "succeeded", "yielded", "deferred", "retryWait", "failed", "superseded", "leaseLost"];
const WORKER_STOPS = new Set(["idle", "max_jobs", "time_budget", "budget_exhausted", "dependency_unavailable"]);
function projectWorker(body: JsonValue): WorkerInvocationResult {
  const data = record(exact(body, ["data", "requestId"]).data);
  if (data.status === "not_enabled") {
    const value = exact(data, ["status", "reason"]);
    if (typeof value.reason !== "string" || !/^[A-Z_]{1,64}$/.test(value.reason)) return unavailable();
    return { status: "not_enabled", reason: value.reason };
  }
  const value = exact(data, ["status", "stopReason", "hasMore", "counts"]);
  if (value.status !== "ran" || typeof value.stopReason !== "string" || !WORKER_STOPS.has(value.stopReason) ||
      typeof value.hasMore !== "boolean") return unavailable();
  const counts = exact(value.counts, WORKER_COUNTS);
  return { status: "ran", stopReason: value.stopReason, hasMore: value.hasMore,
    counts: Object.fromEntries(WORKER_COUNTS.map((key) => [key, count(counts[key])])) };
}
/** 민규 API의 집계와 정형 상태만 반환한다. 임의 upstream 필드·원문은 전달하지 않는다. */
function projectMaintenance(body: JsonValue): JsonValue {
  const envelope = record(body);
  if (Object.hasOwn(envelope, "error")) return unavailable();
  const data = record(envelope.data);
  const completion = record(data.completion), reviews = record(data.reviews), summary = record(data.summary);
  if (completion.status !== "managed_by_reservation" || reviews.status !== "published") return unavailable();
  let projectedSummary: JsonValue;
  if (summary.status === "queued") {
    if (data.status !== "ok") return unavailable();
    projectedSummary = { status: "queued", processedCount: count(summary.processedCount), enqueuedCount: count(summary.enqueuedCount) };
  } else {
    if (data.status !== "partial") return unavailable();
    if (summary.status === "pending_configuration" || summary.status === "configuration_error") {
      projectedSummary = { status: summary.status };
    } else if (summary.status === "failed") {
      const codes = new Set(["AUTH_REQUIRED", "ACCESS_DENIED", "RESOURCE_NOT_FOUND", "INVALID_REQUEST", "STATE_CONFLICT",
        "EXTERNAL_UNAVAILABLE", "INTERNAL_ERROR", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "METHOD_NOT_ALLOWED"]);
      if (typeof summary.code !== "string" || !codes.has(summary.code) || typeof summary.retryable !== "boolean") return unavailable();
      projectedSummary = { status: "failed", code: summary.code, retryable: summary.retryable };
    } else return unavailable();
  }
  return {
    status: data.status,
    completion: { status: "managed_by_reservation" },
    reviews: { status: "published", publishedCount: count(reviews.publishedCount) },
    summary: projectedSummary,
  };
}

export function createScheduledJobsRuntime(read: EnvReader, fetchImpl: FetchLike = fetch, options: {
  now?: () => Date;
  /** 테스트/전용 연결 주입. 기본 운영은 event-sync/register의 계약 확인 뒤 영속 예약한다. */
  runEventCollections?: (settings: EventDailySettings, now: Date) => Promise<Record<string, JsonValue>>;
} = {}) {
  const config = loadRuntimeConfig(read);
  const { workerSecret } = requireInternalConfig(config);
  const post = (path: string, body: JsonValue, timeoutMs: number) => fetchJson(`${config.supabaseUrl}/functions/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${workerSecret}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs, fetchImpl);
  const maintenance = async (limit: number) => {
    // 공개는 모델 설정과 무관하다. 요약 설정의 대기·오류 상태는 API가 공개 후 판정한다.
    const result = await post("service-api/internal/maintenance", { limit }, config.upstreamTimeoutMs);
    if (result.status !== 200) return unavailable();
    return projectMaintenance(result.body);
  };
  return createScheduledJobsHandler({
    allowedOrigins: config.allowedOrigins,
    maxBodyBytes: config.maxRequestBytes,
    authenticateInternal: (request) => requireInternalCaller(request, config),
    maintenance,
    daily: async (limit) => runDaily({
      maintenance: async () => maintenance(limit) as Promise<{ status: "ok" | "partial" } & Record<string, JsonValue>>,
      eventSync: async (input, timeoutMs) => {
        const result = await post("event-sync", input, timeoutMs);
        if (result.status !== 200) return upstreamFailure(result.body);
        return projectEventSync(result.body, input.provider);
      },
      invokeSummaryWorker: async (timeoutMs) => {
        const result = await post("review-summary-worker", {}, timeoutMs);
        if (result.status !== 200) return upstreamFailure(result.body);
        return projectWorker(result.body);
      },
      now: options.now ?? (() => new Date()),
      runEventCollections: options.runEventCollections ?? (async (settings): Promise<Record<string, JsonValue>> => {
        const result = await post("event-sync/register", { providers: settings.providers, maxPeriodDays: settings.windowDays }, settings.timeoutMs);
        if (result.status !== 200) return upstreamFailure(result.body);
        const value = record(exact(result.body, ["requestId", "data"]).data);
        if (value.status === "not_enabled") {
          const data = exact(value, ["status", "reason"]);
          if (typeof data.reason !== "string" || !/^[A-Z_]{1,64}$/.test(data.reason)) return unavailable();
          return { status: "not_enabled", reason: data.reason };
        }
        const data = exact(value, ["status", "createdCount", "existingCount"]);
        if (data.status !== "registered") return unavailable();
        return { status: "ok", registration: "registered", createdCount: count(data.createdCount), existingCount: count(data.existingCount) };
      }),
    }, loadDailySettings(read)),
  });
}

let handler: ReturnType<typeof createScheduledJobsRuntime> | undefined;
const entrypoint = {
  fetch(request: Request): Promise<Response> {
    handler ??= createScheduledJobsRuntime((key) => Deno.env.get(key));
    return handler(request);
  },
};
export default entrypoint;
if (import.meta.main) Deno.serve(entrypoint.fetch);

/** 로컬 준비 소비자만 공개. HTTP 경로·운영 기본 등록은 민규 연결 계약 확정 전 추가하지 않는다. */
export { createSafetyConsumerRegistry, createRpcSafetyConsumerPorts, createSafetyWorkerInvocation } from "../_shared/jobs/safety-consumers.ts";
