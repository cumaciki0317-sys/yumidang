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
type PhotoWait = <T>(operation: () => Promise<T>, late?: (value: T) => void) => Promise<T>;
function cancelPhotoBody(response: Response | null) {
  try { if (response?.body) void response.body.cancel().catch(() => {}); } catch { /* best-effort, 외부 종료 증거가 아니다. */ }
}
function releasePhotoReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try { void reader.cancel().catch(() => {}); } catch { /* 정리가 HTTP 종료를 막지 않는다. */ }
  try { reader.releaseLock(); } catch { /* 진행 중인 read는 늦은 완료 때 다시 해제한다. */ }
}
async function readImage(response: Response, live: () => void, wait: PhotoWait): Promise<Uint8Array> {
  if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "image/jpeg") throw new HttpError("EXTERNAL_UNAVAILABLE");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) < 1 || Number(length) > MAX_PROFILE_IMAGE_BYTES)) throw new HttpError("EXTERNAL_UNAVAILABLE");
  if (!response.body) throw new HttpError("EXTERNAL_UNAVAILABLE");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      live();
      const next = await wait(() => reader.read(), () => releasePhotoReader(reader)); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PROFILE_IMAGE_BYTES) throw new HttpError("EXTERNAL_UNAVAILABLE");
      chunks.push(next.value);
    }
    if (size < 4 || (length !== null && Number(length) !== size)) throw new HttpError("EXTERNAL_UNAVAILABLE");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    // HTTP 전송 손상만 검출한다. 원본 사진 픽셀 디코딩/재인코딩은 업로드 계약의 별도 조건이다.
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes[size-2] !== 255 || bytes[size-1] !== 217) throw new HttpError("EXTERNAL_UNAVAILABLE");
    live(); return bytes;
  } finally {
    try { await wait(() => reader.cancel()); }
    catch (error) { releasePhotoReader(reader); throw error; }
    finally { try { reader.releaseLock(); } catch { /* 늦은 read 완료 때 다시 해제한다. */ } }
  }
}
export function createProfileImageExecutor(config: RuntimeConfig, fetchImpl: FetchLike = fetch) {
  return async (request: Request, path: string): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== "GET") throw new HttpError("METHOD_NOT_ALLOWED");
    if (!pathPattern.test(path) || url.search || url.hash || request.body !== null || request.headers.has("range")) throw new HttpError("INVALID_REQUEST");
    const controller = new AbortController();
    const deadline = performance.now() + config.upstreamTimeoutMs;
    const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const live = () => { if (signal.aborted || performance.now() >= deadline) throw new HttpError("EXTERNAL_UNAVAILABLE"); };
    // 신고 사진 executor와 같은 단일 deadline 패턴이다. signal을 무시하는 포트도 응답을 붙잡지 못한다.
    const wait: PhotoWait = (operation, late) => new Promise((resolve, reject) => {
      let settled = false;
      const dispose = () => signal.removeEventListener("abort", expired);
      const expired = () => { if (settled) return; settled = true; dispose(); reject(new HttpError("EXTERNAL_UNAVAILABLE")); };
      signal.addEventListener("abort", expired, { once: true });
      Promise.resolve().then(() => { live(); return operation(); }).then(value => {
        if (settled) { late?.(value); return; }
        try { live(); } catch { expired(); late?.(value); return; }
        settled = true; dispose(); resolve(value);
      }).catch(error => { if (settled) return; settled = true; dispose(); reject(error); });
    });
    const scopedFetch: FetchLike = (input, init) => wait(() => fetchImpl(input, {
      ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    }), cancelPhotoBody);
    let upstream: Response | null = null;
    try {
      live();
      const principal = await wait(() => requirePrincipal(request, config, scopedFetch));
      const token = getPrincipalToken(principal);
      const target = config.supabaseUrl + "/storage/v1/object/authenticated/profile-images/" + path;
      const headers = { apikey: config.supabaseAnonKey, Authorization: "Bearer " + token, Accept: "image/jpeg" };
      upstream = await scopedFetch(target, { method: "GET", headers, redirect: "error", cache: "no-store" });
      if ([400,401,403,404].includes(upstream.status)) throw new HttpError("RESOURCE_NOT_FOUND");
      const bytes = await readImage(upstream, live, wait);
      // GET 이후 탈퇴·대표사진 교체로 권한이 바뀌면 bytes를 응답에 넣지 않는다.
      const recheck = await scopedFetch(target, { method: "HEAD", headers, redirect: "error", cache: "no-store" });
      await wait(async () => { await recheck.body?.cancel(); });
      if ([400,401,403,404].includes(recheck.status)) throw new HttpError("RESOURCE_NOT_FOUND");
      if (recheck.status !== 200) throw new HttpError("EXTERNAL_UNAVAILABLE");
      live();
      return new Response(new Uint8Array(bytes).buffer, { status: 200, headers: {
        "Content-Type": "image/jpeg", "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, no-store", "Pragma": "no-cache", "Expires": "0",
        "Vary": "Authorization, Origin", "X-Content-Type-Options": "nosniff",
      } });
    } catch (error) {
      cancelPhotoBody(upstream);
      if (error instanceof HttpError) throw error;
      throw new HttpError("EXTERNAL_UNAVAILABLE");
    } finally { clearTimeout(timer); controller.abort(); }
  };
}
