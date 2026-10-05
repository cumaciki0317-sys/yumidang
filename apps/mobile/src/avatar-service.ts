import { ApiError, checkAbort, requestSignal } from "./api.ts";
import type { MemberService } from "./member-service.ts";
import { publicApiKey } from "./member-session.ts";

export const ORIGINAL_PHOTO_MAX_BYTES = 10_000_000;
export const STORED_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export interface PhotoInput { uri: string; mimeType: string; originalBytes: number; }
export interface PhotoStoragePort {
  /** Decode and re-encode JPEG; remove EXIF; return actual binary size/MIME, not renamed source. */
  encode(input: PhotoInput, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: "image/jpeg" }>;
  upload(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  remove(path: string, signal: AbortSignal): Promise<void>;
  /** Resolve private image to an authenticated/revocable display URI. */
  display(path: string, signal: AbortSignal): Promise<string>;
}
export function validateOriginalPhoto(input: PhotoInput) {
  if (!/^(file:|content:|blob:|data:image\/)/i.test(input.uri) || !["image/jpeg", "image/png"].includes(input.mimeType) || !Number.isSafeInteger(input.originalBytes) || input.originalBytes <= 0 || input.originalBytes > ORIGINAL_PHOTO_MAX_BYTES) throw new ApiError(400, "INVALID_PHOTO");
}
export function ownedPhoto(path: string, userId: string) {
  return path.startsWith(`${userId}/`) && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/i.test(path);
}
export async function uploadPhoto(input: PhotoInput, path: string, userId: string, storage: PhotoStoragePort, signal: AbortSignal) {
  validateOriginalPhoto(input);
  if (!ownedPhoto(path, userId)) throw new ApiError(400, "INVALID_PHOTO_PATH");
  const output = await storage.encode(input, signal);
  checkAbort(signal);
  if (output.mimeType !== "image/jpeg" || !(output.bytes instanceof Uint8Array) || output.bytes.byteLength < 1 || output.bytes.byteLength > STORED_PHOTO_MAX_BYTES || jpegHasExif(output.bytes)) throw new ApiError(400, "INVALID_PHOTO");
  await storage.upload(path, output.bytes, signal); checkAbort(signal);
  return path;
}
/** Uncertain swap is reconciled before deleting. Stale/current objects are never removed blindly. */
export async function replacePhoto(input: PhotoInput, path: string, userId: string, storage: PhotoStoragePort, service: MemberService, signal: AbortSignal) {
  await uploadPhoto(input, path, userId, storage, signal);
  let previous: string | null = null;
  try { previous = (await service.avatar(path, signal)).previousPath; }
  catch (error) {
    // No cleanup after logout/abort; current session no longer authorizes reconciliation.
    if (signal.aborted) throw error;
    let current;
    try { current = await service.profile(signal); } catch { throw error; }
    if (current.userId !== userId) throw error;
    if (current.avatarUrl !== path) {
      if (error instanceof ApiError && [400, 401, 403, 404, 409, 413].includes(error.status)) {
        try { await storage.remove(path, signal); } catch { /* Current-object protection remains authoritative. */ }
        throw error;
      }
      // An earlier pointer read does not prove that a delayed swap cannot still commit.
      throw new ApiError(503, "PHOTO_SWAP_UNCERTAIN", true);
    }
  }
  checkAbort(signal);
  let cleanupPending = false;
  if (previous && previous !== path && ownedPhoto(previous, userId)) {
    try {
      const current = await service.profile(signal);
      if (current.userId !== userId || current.avatarUrl === previous) cleanupPending = true;
      else await storage.remove(previous, signal);
    } catch { cleanupPending = true; }
  } else if (previous && previous !== path) cleanupPending = true;
  const current = await service.profile(signal);
  if (current.userId !== userId) throw new ApiError(401, "SESSION_CHANGED");
  return { avatarPath: current.avatarUrl, cleanupPending, previousPath: cleanupPending ? previous : null };
}
export async function reconcilePhoto(path: string, userId: string, service: MemberService, signal: AbortSignal) {
  const current = await service.profile(signal);
  if (current.userId !== userId || !ownedPhoto(path, userId)) throw new ApiError(401, "SESSION_CHANGED");
  return { status: current.avatarUrl === path ? "applied" as const : "pending" as const, avatarPath: current.avatarUrl };
}
/** SDK57 context API. Original checks run before any decode; bounded JPEG retries never alter original. */
export async function encodePhoto(input: PhotoInput, signal: AbortSignal) {
  validateOriginalPhoto(input);
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  const context = ImageManipulator.manipulate(input.uri);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      checkAbort(signal);
      const rendered = await context.renderAsync();
      try {
        const result = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: Math.max(0.35, 0.9 - attempt * 0.15), base64: true });
        checkAbort(signal);
        if (!result.base64) throw new ApiError(400, "INVALID_PHOTO");
        const bytes = stripJpegMetadata(Uint8Array.from(atob(result.base64), c => c.charCodeAt(0)));
        if (bytes.byteLength > 0 && bytes.byteLength <= STORED_PHOTO_MAX_BYTES && !jpegHasExif(bytes)) return { bytes, mimeType: "image/jpeg" as const };
        context.resize({ width: Math.min(result.width, Math.max(1, Math.floor(result.width * 0.75))), height: null });
      } finally { rendered.release(); }
    }
    throw new ApiError(400, "INVALID_PHOTO");
  } finally { context.release(); }
}
function inspectJpeg(bytes: Uint8Array): { valid: boolean; metadata: [number, number][] } {
  const metadata: [number, number][] = [];
  const invalid = () => ({ valid: false, metadata });
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return invalid();
  let i = 2, frame = false, scan = false;
  while (i < bytes.length) {
    const start = i;
    if (bytes[i++] !== 0xff) return invalid();
    while (bytes[i] === 0xff) i++;
    const marker = bytes[i++];
    if (marker === 0xd9) return { valid: frame && scan && i === bytes.length, metadata };
    if (marker === 0 || marker === 0xd8) return invalid();
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (i + 2 > bytes.length) return invalid();
    const size = bytes[i] * 256 + bytes[i + 1];
    if (size < 2 || i + size > bytes.length) return invalid();
    // iOS 재인코더가 붙이는 EXIF/XMP·IPTC·주석을 제거하고 색상/화소 구간은 보존한다.
    if ([0xe1, 0xed, 0xfe].includes(marker)) metadata.push([start, i + size]);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) frame = true;
    if (marker === 0xda) {
      if (size < 6) return invalid();
      scan = true; i += size;
      // FF00와 restart를 포함한 실제 화소 스트림은 그대로 둔다.
      while (i < bytes.length) {
        if (bytes[i] !== 0xff) { i++; continue; }
        const next = bytes[i + 1];
        if (next === 0 || next >= 0xd0 && next <= 0xd7) { i += 2; continue; }
        break;
      }
      continue;
    }
    i += size;
  }
  return invalid();
}
export function jpegHasExif(bytes: Uint8Array) {
  const result = inspectJpeg(bytes);
  return !result.valid || result.metadata.length > 0;
}
export function stripJpegMetadata(bytes: Uint8Array) {
  const result = inspectJpeg(bytes);
  if (!result.valid) throw new ApiError(400, "INVALID_PHOTO");
  if (!result.metadata.length) return bytes;
  const output = new Uint8Array(bytes.length - result.metadata.reduce((size, [start, end]) => size + end - start, 0));
  let source = 0, target = 0;
  for (const [start, end] of result.metadata) {
    output.set(bytes.subarray(source, start), target);
    target += start - source; source = end;
  }
  output.set(bytes.subarray(source), target);
  if (jpegHasExif(output)) throw new ApiError(400, "INVALID_PHOTO");
  return output;
}
export interface StorageOptions {
  supabaseUrl: string;
  publicApiKey: string;
  accessToken: () => Promise<string | null>;
  fetcher?: typeof fetch;
  encoder?: PhotoStoragePort["encode"];
}
/** Fixed private buckets, no admin credential, no public/signed URL with delayed revocation. */
export function createPhotoStoragePort(options: StorageOptions): PhotoStoragePort {
  const storage = createPrivateStorage(options);
  return {
    encode: options.encoder ?? encodePhoto,
    upload: async (path, bytes, signal) => {
      try { await storage.upload("profile-images", path, bytes, "image/jpeg", signal); }
      catch (error) {
        if (signal.aborted) throw error;
        const existing = await storage.download("profile-images", path, signal);
        if (existing.length !== bytes.length || existing.some((b, i) => b !== bytes[i])) throw error;
      }
    },
    remove: (path, signal) => storage.remove("profile-images", path, signal),
    display: async (path, signal) => {
      const bytes = await storage.download("profile-images", path, signal);
      let binary = ""; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return `data:image/jpeg;base64,${btoa(binary)}`;
    },
  };
}
export function createPrivateStorage(options: StorageOptions) {
  const url = new URL(options.supabaseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname) || !options.publicApiKey || /[\r\n]/.test(options.publicApiKey)) throw new ApiError(400, "INVALID_STORAGE_CONFIGURATION");
  publicApiKey(options.publicApiKey);
  const fetcher = options.fetcher ?? fetch;
  const path = (bucket: string, name: string) => {
    if (!["profile-images", "report-evidence"].includes(bucket) || !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/i.test(name)) throw new ApiError(400, "INVALID_PHOTO_PATH");
    return `${url.origin}/storage/v1/object/${bucket}/${name}`;
  };
  const headers = async () => {
    const token = await options.accessToken();
    if (!token || /[\r\n]/.test(token)) throw new ApiError(401, "AUTH_REQUIRED");
    return { apikey: options.publicApiKey, Authorization: `Bearer ${token}` };
  };
  async function checked(url: string, input: RequestInit, signal: AbortSignal) {
    checkAbort(signal);
    const request = requestSignal([signal]);
    const combined = request.signal;
    try {
      const response = await fetcher(url, { ...input, signal: combined, redirect: "error", cache: "no-store" });
      checkAbort(combined);
      if (!response.ok) throw new ApiError(response.status, "STORAGE_REQUEST_FAILED", response.status >= 500);
      // Consume while cancellation/deadline still apply; callers never use a late response body.
      const data = await response.arrayBuffer(); checkAbort(combined);
      return data;
    } finally { request.dispose(); }
  }
  return {
    async upload(bucket: string, name: string, bytes: Uint8Array, mime: string, signal: AbortSignal) {
      const maximum = bucket === "profile-images" ? STORED_PHOTO_MAX_BYTES : 5 * 1024 * 1024;
      if (!bytes.byteLength || bytes.byteLength > maximum || !["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new ApiError(400, "INVALID_PHOTO");
      await checked(path(bucket, name), { method: "POST", headers: { ...await headers(), "Content-Type": mime, "x-upsert": "false" }, body: bytes.slice().buffer }, signal);
    },
    async remove(bucket: string, name: string, signal: AbortSignal) {
      path(bucket, name);
      await checked(`${url.origin}/storage/v1/object/${bucket}`, { method: "DELETE", headers: { ...await headers(), "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [name] }) }, signal);
    },
    async download(bucket: string, name: string, signal: AbortSignal) {
      const data = await checked(path(bucket, name).replace("/object/", "/object/authenticated/"), { headers: await headers() }, signal);
      const bytes = new Uint8Array(data); checkAbort(signal); return bytes;
    },
  };
}
export interface ReportCaptureInput {
  asset: { uri: string; mimeType?: string; fileSize?: number; file?: Blob; };
  assetId: string;
  userId: string;
  signal: AbortSignal;
}
export function createMemberReportCaptureUpload(options: StorageOptions, service: MemberService) {
  const storage = createPrivateStorage(options);
  return async ({ asset, assetId, userId, signal }: ReportCaptureInput): Promise<{ assetId: string }> => {
    const mime = asset.mimeType;
    const extension = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : null;
    const size = asset.fileSize ?? asset.file?.size;
    if (!extension || !size || size > 5 * 1024 * 1024 || !/^(file:|content:|blob:|data:image\/)/i.test(asset.uri)) throw new ApiError(400, "INVALID_CAPTURE");
    const reservation = await service.reserveReportCapture(assetId, extension, signal);
    const path = `${userId}/${assetId}.${extension}`;
    if (reservation.path !== path) throw new ApiError(502, "INVALID_SERVICE_RESPONSE");
    const bytes = asset.file ? new Uint8Array(await asset.file.arrayBuffer()) : new Uint8Array(await (await (options.fetcher ?? fetch)(asset.uri, { signal })).arrayBuffer());
    checkAbort(signal);
    if (bytes.length !== size || bytes.length > 5 * 1024 * 1024) throw new ApiError(400, "INVALID_CAPTURE");
    const valid = extension === "jpg" ? bytes[0] === 0xff && bytes[1] === 0xd8 : extension === "png" ? bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 : new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
    if (!valid) throw new ApiError(400, "INVALID_CAPTURE");
    if (reservation.state === "reserved") {
      try { await storage.upload("report-evidence", path, bytes, mime!, signal); }
      catch (error) {
        if (signal.aborted) throw error;
        // Create-only replay: only the exact same authenticated stored bytes are acceptable.
        const stored = await storage.download("report-evidence", path, signal);
        if (stored.length !== bytes.length || stored.some((b, i) => b !== bytes[i])) throw error;
      }
    }
    await service.confirmReportCapture(assetId, signal);
    return { assetId };
  };
}
export async function cancelMemberReportCapture(assetId: string, path: string, service: MemberService, options: StorageOptions, signal: AbortSignal) {
  if (path.split("/")[1]?.split(".")[0] !== assetId) throw new ApiError(400, "INVALID_CAPTURE");
  const cancelled = await service.cancelReportCapture(assetId, signal);
  if (cancelled.storageDeletionRequired) await createPrivateStorage(options).remove("report-evidence", path, signal);
}
