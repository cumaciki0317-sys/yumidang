/** 민규담당. 사용자 JWT로 private 사진을 읽고 HEAD로 권한을 재확인한다. signed URL/서비스 키/원문 로그 없음. */
import type { RuntimeConfig } from "../_shared/config/env.ts";
import type { FetchLike } from "../_shared/db/transport.ts";
import { requirePrincipal, getPrincipalToken } from "../_shared/auth/principal.ts";
import { HttpError } from "../_shared/http/errors.ts";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const IMAGE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.jpg";
const pathPattern = new RegExp("^" + UUID + "/" + IMAGE + "$", "u");
export const MAX_PROFILE_IMAGE_BYTES = 2097152;
export function profileImageRoutePath(url: URL): string | null {
  const prefix = ["/functions/v1/service-api/profile-images/", "/service-api/profile-images/"].find(value => url.pathname.startsWith(value));
  return prefix ? url.pathname.slice(prefix.length) : null;
}
async function readImage(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "image/jpeg") throw new HttpError("EXTERNAL_UNAVAILABLE");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) < 1 || Number(length) > MAX_PROFILE_IMAGE_BYTES)) throw new HttpError("EXTERNAL_UNAVAILABLE");
  if (!response.body) throw new HttpError("EXTERNAL_UNAVAILABLE");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new HttpError("EXTERNAL_UNAVAILABLE");
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PROFILE_IMAGE_BYTES) throw new HttpError("EXTERNAL_UNAVAILABLE");
      chunks.push(next.value);
    }
    if (size < 4 || (length !== null && Number(length) !== size)) throw new HttpError("EXTERNAL_UNAVAILABLE");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    // HTTP 전송 손상만 검출한다. 원본 사진 픽셀 디코딩/재인코딩은 업로드 계약의 별도 조건이다.
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes[size-2] !== 255 || bytes[size-1] !== 217) throw new HttpError("EXTERNAL_UNAVAILABLE");
    return bytes;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function createProfileImageExecutor(config: RuntimeConfig, fetchImpl: FetchLike = fetch) {
  return async (request: Request, path: string): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== "GET") throw new HttpError("METHOD_NOT_ALLOWED");
    if (!pathPattern.test(path) || url.search || url.hash || request.body !== null || request.headers.has("range")) throw new HttpError("INVALID_REQUEST");
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(config.upstreamTimeoutMs)]);
    const scopedFetch: FetchLike = (input, init) => fetchImpl(input, { ...init, signal });
    let upstream: Response | null = null;
    try {
      if (signal.aborted) throw new HttpError("EXTERNAL_UNAVAILABLE");
      const principal = await requirePrincipal(request, config, scopedFetch);
      const token = getPrincipalToken(principal);
      const target = config.supabaseUrl + "/storage/v1/object/authenticated/profile-images/" + path;
      const headers = { apikey: config.supabaseAnonKey, Authorization: "Bearer " + token, Accept: "image/jpeg" };
      upstream = await scopedFetch(target, { method: "GET", headers, redirect: "error", cache: "no-store" });
      if ([400,401,403,404].includes(upstream.status)) throw new HttpError("RESOURCE_NOT_FOUND");
      const bytes = await readImage(upstream, signal);
      // GET 이후 탈퇴·대표사진 교체로 권한이 바뀌면 bytes를 응답에 넣지 않는다.
      const recheck = await scopedFetch(target, { method: "HEAD", headers, redirect: "error", cache: "no-store" });
      await recheck.body?.cancel();
      if ([400,401,403,404].includes(recheck.status)) throw new HttpError("RESOURCE_NOT_FOUND");
      if (recheck.status !== 200 || signal.aborted) throw new HttpError("EXTERNAL_UNAVAILABLE");
      return new Response(new Uint8Array(bytes).buffer, { status: 200, headers: {
        "Content-Type": "image/jpeg", "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, no-store", "Pragma": "no-cache", "Expires": "0",
        "Vary": "Authorization, Origin", "X-Content-Type-Options": "nosniff",
      } });
    } catch (error) {
      await upstream?.body?.cancel().catch(() => {});
      if (error instanceof HttpError) throw error;
      throw new HttpError("EXTERNAL_UNAVAILABLE");
    }
  };
}
