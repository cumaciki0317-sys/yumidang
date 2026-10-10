/** 민규담당: JSON RPC 전송. 원문 오류/토큰/DB 상세를 반환하거나 기록하지 않는다. */
import type { JsonValue } from "../contracts/common.ts";
import type { RuntimeConfig } from "../config/env.ts";
import { HttpError } from "../http/errors.ts";
export type FetchLike = typeof fetch;
export interface RpcClient {
  rpc(name: string, args: Record<string, JsonValue>): Promise<JsonValue>;
  /** 전송 허용 여부만 확인한다. 배포 DB 함수·버전·권한 준비는 별도 RPC로 검증한다. */
  supportsRpc?(name: string): boolean;
}
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
  // SQL109의 원 실행 배정 거절만 충돌로 분류한다. 다른 준비/공급사 오류는 그대로 닫는다.
  if (code === "55000" && body && typeof body === "object" && !Array.isArray(body) &&
      body.message === "invocation_not_dispatchable") throw new HttpError("STATE_CONFLICT");
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
  // 호출자가 나중에 원래 Set을 수정해 허용 범위를 넓히지 못하게 한다.
  const allowedNames = new Set(names);
  const supportsRpc = (name: string): boolean => /^[a-z][a-z0-9_]*$/.test(name) && allowedNames.has(name);
  return Object.freeze({
    supportsRpc,
    async rpc(name: string, args: Record<string, JsonValue>): Promise<JsonValue> {
      if (!supportsRpc(name)) throw new HttpError("ACCESS_DENIED");
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
