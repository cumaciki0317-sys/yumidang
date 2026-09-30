/** 종현: 기존 공통 설정·내부 인증을 사용하는 maintenance 연결. import는 실행/예약 등록을 하지 않는다. */
import { loadRuntimeConfig, requireInternalConfig, type EnvReader } from "../_shared/config/env.ts";
import { requireInternalCaller } from "../_shared/auth/internal-caller.ts";
import { fetchJson, type FetchLike } from "../_shared/db/transport.ts";
import type { JsonValue } from "../_shared/contracts/common.ts";
import { HttpError } from "../_shared/http/errors.ts";
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

export function createScheduledJobsRuntime(read: EnvReader, fetchImpl: FetchLike = fetch) {
  const config = loadRuntimeConfig(read);
  const { workerSecret } = requireInternalConfig(config);
  return createScheduledJobsHandler({
    allowedOrigins: config.allowedOrigins,
    maxBodyBytes: config.maxRequestBytes,
    authenticateInternal: (request) => requireInternalCaller(request, config),
    maintenance: async (limit) => {
      // 공개는 모델 설정과 무관하다. 요약 설정의 대기·오류 상태는 API가 공개 후 판정한다.
      const result = await fetchJson(`${config.supabaseUrl}/functions/v1/service-api/internal/maintenance`, {
        method: "POST",
        headers: { Authorization: `Bearer ${workerSecret}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ limit }),
      }, config.upstreamTimeoutMs, fetchImpl);
      if (result.status !== 200) return unavailable();
      return projectMaintenance(result.body);
    },
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
