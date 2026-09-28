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
/** 민규 API의 집계만 반환한다. 임의 upstream 필드·원문·상세 오류는 전달하지 않는다. */
function projectMaintenance(body: JsonValue): JsonValue {
  const envelope = record(body);
  if (Object.hasOwn(envelope, "error")) return unavailable();
  const data = record(envelope.data);
  const completion = record(data.completion), reviews = record(data.reviews);
  return {
    completion: { completedCount: count(completion.completedCount) },
    reviews: {
      publishedCount: count(reviews.publishedCount),
      processedCount: count(reviews.processedCount),
      enqueuedCount: count(reviews.enqueuedCount),
    },
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
      // 기존 API는 두 버전 없이 완료 처리도 시작하지 않는다. 가상 버전으로 우회하지 않는다.
      const version = /^[A-Za-z0-9_.-]{1,64}$/;
      if (!config.reviewSummaryModelVersion || !config.reviewSummaryPromptVersion ||
          !version.test(config.reviewSummaryModelVersion) || !version.test(config.reviewSummaryPromptVersion)) return unavailable();
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
