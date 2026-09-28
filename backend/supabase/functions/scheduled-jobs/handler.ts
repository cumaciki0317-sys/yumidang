/** 종현: 내부 인증 후 민규 maintenance HTTP를 호출한다. 시간·공개 정책은 DB에 둔다. */
import type { JsonValue } from "../_shared/contracts/common.ts";
import { createCors } from "../_shared/http/cors.ts";
import { HttpError } from "../_shared/http/errors.ts";
import { createRequestContext, readJson } from "../_shared/http/request.ts";
import { jsonFailure, jsonSuccess } from "../_shared/http/response.ts";

export interface ScheduledJobsDependencies {
  allowedOrigins: readonly string[];
  maxBodyBytes: number;
  authenticateInternal(request: Request): Promise<void>;
  maintenance(limit: number): Promise<JsonValue>;
}

export function createScheduledJobsHandler(deps: ScheduledJobsDependencies) {
  if (!Number.isSafeInteger(deps.maxBodyBytes) || deps.maxBodyBytes < 1) {
    throw new TypeError("본문 크기 제한이 필요합니다.");
  }
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
      if (!["/functions/v1/scheduled-jobs", "/scheduled-jobs"].includes(url.pathname)) throw new HttpError("RESOURCE_NOT_FOUND");
      if (request.method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
      await deps.authenticateInternal(request);
      if (url.search) throw new HttpError("INVALID_REQUEST");
      const body = await readJson(request, { maxBytes: deps.maxBodyBytes });
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !Object.hasOwn(body, "limit") ||
          typeof body.limit !== "number" || !Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 100) {
        throw new HttpError("INVALID_REQUEST");
      }
      // limit은 명시적 입력이다. 기본 주기·배치·자동 재시도를 만들지 않는다.
      return cors.apply(jsonSuccess(await deps.maintenance(body.limit), context), request);
    } catch (error) {
      const response = jsonFailure(error, context);
      return originAllowed ? cors.apply(response, request) : response;
    }
  };
}
