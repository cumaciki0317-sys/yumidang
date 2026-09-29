/** 민규담당: JSON RPC 전송. 원문 오류/토큰/DB 상세를 반환하거나 기록하지 않는다. */
import type { JsonValue } from "../contracts/common.ts";
import type { RuntimeConfig } from "../config/env.ts";
import { HttpError } from "../http/errors.ts";
export type FetchLike = typeof fetch;
export interface RpcClient { rpc(name: string, args: Record<string, JsonValue>): Promise<JsonValue> }
export async function fetchJson(url: string, init: RequestInit, timeoutMs: number, fetchImpl: FetchLike = fetch): Promise<{ status: number; body: JsonValue }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: "error" });
    const body = response.status === 204 ? null : await response.json() as JsonValue;
    return { status: response.status, body };
  } catch { throw new HttpError("EXTERNAL_UNAVAILABLE"); }
  finally { clearTimeout(timer); }
}
function rpcFailure(status: number, body: JsonValue): never {
  const code = body && typeof body === "object" && !Array.isArray(body) ? body.code : null;
  // PostgREST는 로그인 필요 SQLSTATE도 HTTP 403으로 반환할 수 있다.
  if (status === 401 || code === "28000") throw new HttpError("AUTH_REQUIRED");
  if (status === 403) throw new HttpError("ACCESS_DENIED");
  switch (code) {
    case "PT404": throw new HttpError("RESOURCE_NOT_FOUND");
    case "PT503": throw new HttpError("EXTERNAL_UNAVAILABLE");
    case "42501": throw new HttpError("ACCESS_DENIED");
    case "22023": case "22P02": case "23502": case "23514": throw new HttpError("INVALID_REQUEST");
    case "23505": case "P0001": case "40001": throw new HttpError("STATE_CONFLICT");
    case "P0002": throw new HttpError("RESOURCE_NOT_FOUND");
    case "40P01": throw new HttpError("EXTERNAL_UNAVAILABLE");
    default: throw new HttpError(status >= 500 || status === 429 ? "EXTERNAL_UNAVAILABLE" : "INTERNAL_ERROR");
  }
}
export function createRpcTransport(config: RuntimeConfig, apiKey: string, token: string, names: ReadonlySet<string>, fetchImpl: FetchLike = fetch): RpcClient {
  return Object.freeze({
    async rpc(name: string, args: Record<string, JsonValue>): Promise<JsonValue> {
      if (!names.has(name) || !/^[a-z][a-z0-9_]*$/.test(name)) throw new HttpError("ACCESS_DENIED");
      let payload: string;
      try { payload = JSON.stringify(args); } catch { throw new HttpError("INVALID_REQUEST"); }
      const { status, body } = await fetchJson(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
        method: "POST", headers: { apikey: apiKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Accept": "application/json" }, body: payload,
      }, config.upstreamTimeoutMs, fetchImpl);
      if (status < 200 || status >= 300) return rpcFailure(status, body);
      return body;
    },
  });
}
