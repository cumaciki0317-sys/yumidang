/** event-sync의 내부 전용 영속 수집/등록/공식 순위/상세 진입점. 원천 본문은 응답하지 않는다. */
import { createRequestContext, readJson } from "../_shared/http/request.ts";
import { jsonFailure, jsonSuccess } from "../_shared/http/response.ts";
import { HttpError } from "../_shared/http/errors.ts";
import type { createEventOperations } from "../_shared/jobs/event-runtime.ts";
import type { EventCollectionReference } from "../_shared/jobs/event-collection.ts";
import type { JsonValue } from "../_shared/contracts/common.ts";
export function withEventOperations(
  base: (r: Request) => Promise<Response>,
  options: {
    authenticate: (r: Request) => Promise<void>;
    maxBytes: number;
    operations: ReturnType<typeof createEventOperations>;
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
        result = await options.operations.worker(
          request.headers.get("x-worker-run-token") ?? undefined,
          request.signal,
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
