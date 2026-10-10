/** 민규담당(2026-10-09 사용자 재배정). 내부 행사 진입점은 원천 본문을 응답하지 않는다. */
import { createRequestContext, readJson } from "../_shared/http/request.ts";
import { jsonFailure, jsonSuccess } from "../_shared/http/response.ts";
import { HttpError } from "../_shared/http/errors.ts";
import type { createEventOperations } from "../_shared/jobs/event-runtime.ts";
import type { EventCollectionReference } from "../_shared/jobs/event-collection.ts";
import type { JsonValue } from "../_shared/contracts/common.ts";
export interface EventWorkerRequest { requestId: string; globalToken: string; maxJobsPerRun: number; timeBudgetMs: number; }
const executionHeaders = ["x-worker-request-id", "x-worker-max-jobs", "x-worker-time-budget-ms"] as const;
const workerUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function positiveHeader(value: string | null, maximum: number) {
  if (!value || !/^[1-9][0-9]{0,5}$/.test(value)) throw new HttpError("INVALID_REQUEST");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > maximum) throw new HttpError("INVALID_REQUEST");
  return n;
}
export function withEventOperations(
  base: (r: Request) => Promise<Response>,
  options: {
    authenticate: (r: Request) => Promise<void>;
    maxBytes: number;
    operations: ReturnType<typeof createEventOperations>;
    /** 내부 인증 뒤 DB의 영속 요청·최초 실행 CAS를 확인한다. 헤더는 승인 근거가 아니다. */
    resolveSharedExecution?(input: EventWorkerRequest): Promise<{ maxJobsPerRun: number; timeBudgetMs: number }>;
  },
) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url),
      operation = url.pathname.replace(/^\/functions\/v1/, "").replace(
        /^\/event-sync\//,
        "",
      );
    if (
      !["register", "collect", "rankings", "detail", "worker"].includes(
        operation,
      )
    ) return base(request);
    const context = createRequestContext();
    try {
      await options.authenticate(request);
      if (request.method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
      if (url.search) throw new HttpError("INVALID_REQUEST");
      const body = await readJson(request, { maxBytes: options.maxBytes });
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError("INVALID_REQUEST");
      }
      const exact = (keys: string[]) => {
        if (
          Object.keys(body).length !== keys.length ||
          keys.some((k) => !Object.hasOwn(body, k))
        ) throw new HttpError("INVALID_REQUEST");
      };
      let result: unknown;
      if (operation === "worker") {
        exact([]);
        const token = request.headers.get("x-worker-run-token") ?? undefined;
        if (token !== undefined && !workerUuid.test(token)) throw new HttpError("INVALID_REQUEST");
        let execution: { maxJobsPerRun: number; timeBudgetMs: number } | undefined;
        if (executionHeaders.some(header => request.headers.has(header))) {
          if (!token || !executionHeaders.every(header => request.headers.has(header))) throw new HttpError("INVALID_REQUEST");
          const requestId = request.headers.get("x-worker-request-id")!;
          if (!workerUuid.test(requestId)) throw new HttpError("INVALID_REQUEST");
          const maxJobsPerRun = positiveHeader(request.headers.get("x-worker-max-jobs"), 10);
          const timeBudgetMs = positiveHeader(request.headers.get("x-worker-time-budget-ms"), 60_000);
          if (!options.resolveSharedExecution) throw new HttpError("EXTERNAL_UNAVAILABLE");
          if (request.signal.aborted) throw new HttpError("STATE_CONFLICT");
          execution = await options.resolveSharedExecution({ requestId, globalToken: token, maxJobsPerRun, timeBudgetMs });
          if (!execution || Object.keys(execution).sort().join(",") !== "maxJobsPerRun,timeBudgetMs" ||
              !Number.isSafeInteger(execution.maxJobsPerRun) || execution.maxJobsPerRun < 1 || execution.maxJobsPerRun > maxJobsPerRun ||
              !Number.isSafeInteger(execution.timeBudgetMs) || execution.timeBudgetMs < 1 || execution.timeBudgetMs > timeBudgetMs) throw new HttpError("EXTERNAL_UNAVAILABLE");
          if (request.signal.aborted) throw new HttpError("STATE_CONFLICT");
        }
        result = await options.operations.worker(
          token,
          request.signal,
          execution,
        );
      } else if (operation === "register") {
        exact(["providers", "maxPeriodDays"]);
        if (
          !Array.isArray(body.providers) || body.providers.some((p) =>
            typeof p !== "string"
          ) || !Number.isSafeInteger(body.maxPeriodDays) ||
          Number(body.maxPeriodDays) < 1 || Number(body.maxPeriodDays) > 31
        ) throw new HttpError("INVALID_REQUEST");
        result = await options.operations.register(
          body.providers as string[],
          body.maxPeriodDays as number,
        );
      } else if (operation === "collect") {
        exact(
          body.lane === "detail"
            ? ["provider", "lane", "period", "sourceId", "sourceCollectedAt"]
            : ["provider", "lane", "period"],
        );
        if (
          body.lane === "detail" &&
          (typeof body.sourceId !== "string" ||
            typeof body.sourceCollectedAt !== "string")
        ) throw new HttpError("INVALID_REQUEST");
        if (
          typeof body.provider !== "string" ||
          ![
            "initial_history",
            "future",
            "ongoing",
            "ranking_all",
            "ranking_musical",
            "detail",
          ].includes(
            body.lane as string,
          ) || !body.period || typeof body.period !== "object" ||
          Array.isArray(body.period) || Object.keys(body.period).length !== 2 ||
          typeof body.period.start !== "string" ||
          typeof body.period.end !== "string"
        ) throw new HttpError("INVALID_REQUEST");
        result = await options.operations.collect(
          body as unknown as EventCollectionReference,
          request.headers.get("x-worker-run-token") ?? undefined,
          request.signal,
        );
      } else if (operation === "rankings") {
        exact(["mode"]);
        if (!["all", "musical"].includes(body.mode as string)) {
          throw new HttpError("INVALID_REQUEST");
        }
        result = await options.operations.ranking(
          body.mode as "all" | "musical",
          request.signal,
        );
      } else {
        exact(["provider", "sourceId"]);
        if (
          typeof body.provider !== "string" || typeof body.sourceId !== "string"
        ) throw new HttpError("INVALID_REQUEST");
        result = await options.operations.detail(
          body.provider,
          body.sourceId,
          request.signal,
        );
      }
      return jsonSuccess(
        JSON.parse(JSON.stringify(result)) as JsonValue,
        context,
      );
    } catch (error) {
      return jsonFailure(
        error instanceof HttpError
          ? error
          : new HttpError("EXTERNAL_UNAVAILABLE"),
        context,
      );
    }
  };
}
