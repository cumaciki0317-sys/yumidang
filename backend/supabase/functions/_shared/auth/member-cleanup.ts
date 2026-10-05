/** 민규담당: 승인된 탈퇴 작업의 정확한 외부 삭제·재조회 증거를 연결한다. 운영 연결은 아직 하지 않는다. */
import type { RuntimeConfig } from "../config/env.ts";
import { HttpError } from "../http/errors.ts";

export interface MemberCleanupTask {
  readonly taskId: string; readonly leaseToken: string; readonly expiresAt: string;
  readonly kind: "storage_object" | "auth_user"; readonly profileId: string;
  readonly bucketId: "profile-images" | null; readonly objectName: string | null; readonly objectId: string | null;
}
export interface CleanupFence {
  readonly taskId: string; readonly leaseToken: string; readonly workerRunToken: string; readonly objectId: string | null;
}
export interface MemberCleanupPorts {
  claim(workerRunToken: string, signal?: AbortSignal): Promise<unknown>;
  /** DB가 승인 guard·작업·전역 토큰·현재 lease·objectId를 다시 검사해야 한다. 대체 성공 구현 금지. */
  assertCurrent(fence: CleanupFence, signal?: AbortSignal): Promise<unknown>;
  getDeleteAck(fence: CleanupFence, signal?: AbortSignal): Promise<unknown>;
  recordDeleteAck(fence: CleanupFence & { readonly ackSha256: string }, signal?: AbortSignal): Promise<unknown>;
  complete(fence: CleanupFence & { readonly evidenceSha256: string }, signal?: AbortSignal): Promise<unknown>;
}
export interface CleanupExecutionBudget {
  /** 실행기가 확인한 전역 점유 마감 등. DB fence를 대체하지 않는다. */
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
}
function withinBudget<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new HttpError("STATE_CONFLICT"));
  return new Promise((resolve, reject) => {
    const expired = () => reject(new HttpError("STATE_CONFLICT"));
    signal.addEventListener("abort", expired, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new HttpError("STATE_CONFLICT");
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", expired));
  });
}
interface DeleteAck { readonly receiptId: string; readonly taskId: string; readonly kind: MemberCleanupTask["kind"];
  readonly objectId: string | null; readonly evidenceSha256: string; }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validId = (v: unknown): v is string => typeof v === "string" && uuid.test(v) && v !== "00000000-0000-0000-0000-000000000000";
const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const fail = (): never => { throw new HttpError("EXTERNAL_UNAVAILABLE"); };
// Storage v1.70.3의 일반 REST error handler는 의미상 404를 HTTP400으로 감싼다.
// NoSuchBucket/JWT/권한/다른 400은 부재 증거가 아니다. Auth에는 이 정규화를 사용하지 않는다.
const storageAbsent = (r: { status: number; value: unknown }): boolean => r.status === 404 ||
  (r.status === 400 && record(r.value)?.code === "NoSuchKey" && record(r.value)?.statusCode === "404");
function decode(value: unknown): MemberCleanupTask {
  const t = record(value);
  const keys = ["taskId", "leaseToken", "expiresAt", "kind", "profileId", "bucketId", "objectName", "objectId"];
  if (!t || Object.keys(t).length !== keys.length || keys.some((k) => !Object.hasOwn(t, k)) ||
    !validId(t.taskId) || !validId(t.leaseToken) || !validId(t.profileId) ||
    typeof t.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(t.expiresAt) || !Number.isFinite(Date.parse(t.expiresAt))) return fail();
  if (t.kind === "storage_object") {
    // 이름을 바꾸거나 prefix를 추측하지 않는다. 소유권은 필수 DB check의 exact row 검사에 맡긴다.
    if (t.bucketId !== "profile-images" || !validId(t.objectId) || typeof t.objectName !== "string" ||
      new TextEncoder().encode(t.objectName).byteLength < 1 || new TextEncoder().encode(t.objectName).byteLength > 1024 ||
      /[\p{Cc}\\\uD800-\uDFFF]/u.test(t.objectName) || t.objectName.split("/").some((p) => !p || p === "." || p === "..")) return fail();
  } else if (t.kind !== "auth_user" || t.bucketId !== null || t.objectName !== null || t.objectId !== null) return fail();
  return Object.freeze({ ...t }) as unknown as MemberCleanupTask;
}
function decodeAck(value: unknown, task: MemberCleanupTask): DeleteAck {
  const r = record(value); const keys = ["receiptId", "taskId", "kind", "objectId", "evidenceSha256"];
  if (!r || Object.keys(r).length !== keys.length || keys.some((k) => !Object.hasOwn(r, k)) || !validId(r.receiptId) ||
    r.taskId !== task.taskId || r.kind !== task.kind || r.objectId !== task.objectId ||
    typeof r.evidenceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.evidenceSha256)) return fail();
  return Object.freeze({ ...r }) as unknown as DeleteAck;
}
async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 네트워크 오류/응답 원문/키를 반환하거나 기록하지 않는다. 실제 파일 삭제 통합 증명은 별도 필요하다. */
export function createMemberCleanupAdapter(config: RuntimeConfig, fetchImpl: typeof fetch = fetch) {
  const key = config.supabaseServiceRoleKey;
  try {
    const u = new URL(config.supabaseUrl);
    if (u.origin !== config.supabaseUrl || u.username || u.password ||
      (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "kong"].includes(u.hostname))) ||
      !key || key.trim() !== key || /[\r\n]/.test(key) || key === config.supabaseAnonKey || !config.supabaseAnonKey ||
      !Number.isSafeInteger(config.upstreamTimeoutMs) || config.upstreamTimeoutMs <= 0) return fail();
  } catch { return fail(); }
  async function request(path: string, method: "GET" | "DELETE", body?: unknown, readJson = true, signal?: AbortSignal) {
    if (signal?.aborted) throw new HttpError("STATE_CONFLICT");
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), config.upstreamTimeoutMs);
    try {
      const response = await fetchImpl(`${config.supabaseUrl}${path}`, { method, redirect: "error", signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
        headers: { apikey: key!, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      // 400은 구조화한 code/statusCode만 검사한다. message/error 원문을 성공 기준으로 쓰지 않는다.
      let value: unknown = null;
      if ((readJson && response.status === 200) || response.status === 400) value = await response.json();
      else await response.body?.cancel();
      return { status: response.status, value };
    } catch { return fail(); } finally { clearTimeout(timeout); }
  }
  return Object.freeze({
    async deleteAndVerify(value: MemberCleanupTask, beforeDelete: () => Promise<void>, afterDelete: () => Promise<void>, signal?: AbortSignal): Promise<void> {
      const task = decode(value);
      if (typeof beforeDelete !== "function" || typeof afterDelete !== "function") return fail();
      if (task.kind === "storage_object") {
        const name = task.objectName!;
        const path = name.split("/").map(encodeURIComponent).join("/");
        const info = await request(`/storage/v1/object/info/authenticated/profile-images/${path}`, "GET", undefined, true, signal);
        const found = record(info.value);
        if (info.status !== 200 || found?.id !== task.objectId || found?.name !== name || found?.bucket_id !== task.bucketId) return fail();
        await beforeDelete();
        const deleted = await request("/storage/v1/object/profile-images", "DELETE", { prefixes: [name] }, true, signal);
        const rows = deleted.value;
        if (deleted.status !== 200 || !Array.isArray(rows) || rows.length !== 1 || record(rows[0])?.id !== task.objectId || record(rows[0])?.name !== name) return fail();
        await afterDelete();
        const after = await request(`/storage/v1/object/authenticated/profile-images/${path}`, "GET", undefined, false, signal);
        if (!storageAbsent(after)) return fail();
      } else {
        const path = `/auth/v1/admin/users/${task.profileId}`;
        const before = await request(path, "GET", undefined, true, signal);
        if (before.status !== 200 || record(before.value)?.id !== task.profileId) return fail();
        await beforeDelete();
        const deleted = await request(path, "DELETE", { should_soft_delete: false }, true, signal);
        const acknowledgement = record(deleted.value);
        if (deleted.status !== 200 || !acknowledgement || Object.keys(acknowledgement).length !== 0) return fail();
        await afterDelete();
        if ((await request(path, "GET", undefined, false, signal)).status !== 404) return fail();
      }
    },
    async verifyAbsent(value: MemberCleanupTask, signal?: AbortSignal): Promise<void> {
      const task = decode(value);
      if (task.kind === "storage_object") {
        const path = task.objectName!.split("/").map(encodeURIComponent).join("/");
        if (!storageAbsent(await request(`/storage/v1/object/info/authenticated/profile-images/${path}`, "GET", undefined, false, signal)) ||
          !storageAbsent(await request(`/storage/v1/object/authenticated/profile-images/${path}`, "GET", undefined, false, signal))) return fail();
      } else if ((await request(`/auth/v1/admin/users/${task.profileId}`, "GET", undefined, false, signal)).status !== 404) return fail();
    },
  });
}

/** J 실행기는 필수 DB fence를 연결한 뒤 호출한다. 토큰 갱신·운영 승인·RPC 권한 변경을 하지 않는다. */
export async function processMemberCleanupTask(workerRunToken: string, ports: MemberCleanupPorts,
  adapter: ReturnType<typeof createMemberCleanupAdapter>, budget: CleanupExecutionBudget = {}): Promise<{ readonly status: "idle" | "applied" }> {
  if (!budget || typeof budget !== "object" || Array.isArray(budget) || Object.keys(budget).some((k) => !["deadlineAt", "signal"].includes(k)) ||
    (budget.deadlineAt !== undefined && !Number.isSafeInteger(budget.deadlineAt)) ||
    (budget.signal !== undefined && !(budget.signal instanceof AbortSignal))) throw new HttpError("INVALID_REQUEST");
  const abort = new AbortController();
  const signal = budget.signal ? AbortSignal.any([abort.signal, budget.signal]) : abort.signal;
  let deadline = Math.min(Date.now() + 60000, budget.deadlineAt ?? Infinity);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tighten = (at: number) => {
    deadline = Math.min(deadline, at);
    clearTimeout(timer);
    if (deadline <= Date.now()) abort.abort();
    else timer = setTimeout(() => abort.abort(), deadline - Date.now());
  };
  tighten(deadline);
  const expired = () => signal.aborted || Date.now() >= deadline;
  try {
    const result = await withinBudget(signal, () => processTask(workerRunToken, ports, adapter, signal, tighten, expired));
    if (expired()) throw new HttpError("STATE_CONFLICT");
    return result;
  }
  catch (error) { if (error instanceof HttpError) throw error; return fail(); }
  finally { clearTimeout(timer); }
}
async function processTask(workerRunToken: string, ports: MemberCleanupPorts,
  adapter: ReturnType<typeof createMemberCleanupAdapter>, signal: AbortSignal, tighten: (at: number) => void,
  expired: () => boolean): Promise<{ readonly status: "idle" | "applied" }> {
  if (!validId(workerRunToken)) throw new HttpError("INVALID_REQUEST");
  if (!ports || typeof ports.claim !== "function" || typeof ports.assertCurrent !== "function" || typeof ports.complete !== "function" ||
    typeof ports.getDeleteAck !== "function" || typeof ports.recordDeleteAck !== "function" ||
    !adapter || typeof adapter.deleteAndVerify !== "function" || typeof adapter.verifyAbsent !== "function") return fail();
  const claimed = await ports.claim(workerRunToken, signal);
  if (claimed === null) return { status: "idle" };
  const task = decode(claimed);
  tighten(Date.parse(task.expiresAt));
  const fence = Object.freeze({ taskId: task.taskId, leaseToken: task.leaseToken, workerRunToken, objectId: task.objectId });
  // 프로세스 시계는 보조 검사다. DB의 현재 lease 검사를 대체하지 않는다.
  const assertCurrent = async () => {
    if (expired() || Date.parse(task.expiresAt) <= Date.now()) throw new HttpError("STATE_CONFLICT");
    const current = decode(await ports.assertCurrent(fence, signal));
    if ((Object.keys(task) as (keyof MemberCleanupTask)[]).some((k) => current[k] !== task[k])) throw new HttpError("STATE_CONFLICT");
    if (expired() || Date.parse(task.expiresAt) <= Date.now()) throw new HttpError("STATE_CONFLICT");
  };
  await assertCurrent();
  const existing = await ports.getDeleteAck(fence, signal);
  let receipt: DeleteAck | null = existing === null ? null : decodeAck(existing, task);
  if (receipt) await adapter.verifyAbsent(task, signal);
  else await adapter.deleteAndVerify(task, assertCurrent, async () => {
    await assertCurrent();
    const ackSha256 = await hash({ version: 1, ...fence, kind: task.kind, deleteAcknowledged: true });
    receipt = decodeAck(await ports.recordDeleteAck({ ...fence, ackSha256 }, signal), task);
    if (receipt.evidenceSha256 !== ackSha256) return fail();
  }, signal);
  await assertCurrent();
  // 원문 응답·키·경로를 원장에 저장하지 않는다. 같은 task/lease의 고정 증거 봉투만 해시한다.
  if (!receipt) return fail();
  const evidenceSha256 = await hash({ version: 2, ...fence, kind: task.kind,
    receiptId: (receipt as DeleteAck).receiptId, ackSha256: (receipt as DeleteAck).evidenceSha256, requeryStatus: 404 });
  if (expired()) throw new HttpError("STATE_CONFLICT");
  const result = record(await ports.complete({ ...fence, evidenceSha256 }, signal));
  if (!result || Object.keys(result).length !== 1 || result.status !== "applied") return fail();
  return { status: "applied" };
}
