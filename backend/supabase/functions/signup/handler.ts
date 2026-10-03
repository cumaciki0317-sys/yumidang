/** 민규담당. 네이버 시작/코드 교환과 JWT 기반 가입 상태/완료 HTTP 진입점. */
import type { createSignupService } from "../_shared/services/signup-service.ts";
import type { RpcClient } from "../_shared/db/transport.ts";
import { createCors } from "../_shared/http/cors.ts";
import { HttpError } from "../_shared/http/errors.ts";
import { createRequestContext, readJson } from "../_shared/http/request.ts";
import { jsonFailure, jsonSuccess } from "../_shared/http/response.ts";
export function createSignupHandler(dependencies: {
  allowedOrigins: readonly string[];
  maxBodyBytes: number;
  service(): ReturnType<typeof createSignupService>;
  authenticateUser(request: Request): Promise<RpcClient>;
}) {
  const cors = createCors({ allowedOrigins: dependencies.allowedOrigins, allowedMethods: ["GET", "POST"], allowedHeaders: ["authorization", "content-type", "apikey"] });
  return async (request: Request): Promise<Response> => {
    const context = createRequestContext();
    const preflight = cors.preflight(request, context);
    if (preflight) return preflight;
    let originAllowed = false;
    try {
      cors.responseHeaders(request); originAllowed = true;
      const url = new URL(request.url);
      const prefix = ["/functions/v1/signup/", "/signup/"].find((item) => url.pathname.startsWith(item));
      if (!prefix || url.search || url.hash) throw new HttpError("RESOURCE_NOT_FOUND");
      const path = url.pathname.slice(prefix.length);
      if (!["naver/start", "naver/callback", "state", "complete"].includes(path)) throw new HttpError("RESOURCE_NOT_FOUND");
      if (request.method !== (path === "state" ? "GET" : "POST")) throw new HttpError("METHOD_NOT_ALLOWED");
      if (path.startsWith("naver/") && !request.headers.has("origin")) throw new HttpError("ACCESS_DENIED");
      const db = path === "state" || path === "complete" ? await dependencies.authenticateUser(request) : null;
      const body = request.method === "POST" ? await readJson(request, { maxBytes: dependencies.maxBodyBytes }) : null;
      const service = dependencies.service();
      const result = path === "naver/start" ? await service.start(body, request.headers.get("origin")!) : path === "naver/callback" ? await service.callback(body, request.headers.get("origin")!)
        : path === "state" ? await service.state(db!) : await service.complete(db!, body);
      return cors.apply(jsonSuccess(result, context), request);
    } catch (error) {
      const response = jsonFailure(error, context);
      return originAllowed ? cors.apply(response, request) : response;
    }
  };
}
