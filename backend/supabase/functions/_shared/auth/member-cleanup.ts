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
  beginDelete?(fence: CleanupFence, signal?: AbortSignal): Promise<unknown>;
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
/** SQL115 전용 복구. 일반 claim/dispatch/DELETE/ACK 쓰기를 노출하지 않는다. */
export interface MemberCleanupReconcileBinding {
  readonly recoveryRequestId: string;
  readonly invocationRequestId: string;
  readonly taskId: string;
  readonly recoveryGlobalToken: string;
}
export interface MemberCleanupReconcilePorts {
  readonly binding: MemberCleanupReconcileBinding;
  begin(signal?: AbortSignal): Promise<unknown>;
  get(signal?: AbortSignal): Promise<unknown>;
  assertCurrent(fence: CleanupFence, signal?: AbortSignal): Promise<unknown>;
  getDeleteAck(fence: CleanupFence, signal?: AbortSignal): Promise<unknown>;
  finish(evidenceSha256: string, signal?: AbortSignal): Promise<unknown>;
}
export interface MemberCleanupReconcileProof {
  readonly recoveryRequestId: string; readonly invocationRequestId: string; readonly taskId: string;
  readonly state: "prepared" | "completed" | "superseded";
  readonly original: { readonly withdrawalId: string; readonly objectId: string | null; readonly dispatchId: string;
    readonly globalToken: string; readonly jobLeaseToken: string; readonly ackReceiptId: string; readonly ackSha256: string };
  readonly recovery: { readonly globalToken: string; readonly leaseToken: string; readonly expiresAt: string };
  readonly evidenceSha256: string | null; readonly closedAt: string | null;
}
export type MemberCleanupReconcileResult =
  | { readonly status: "pending" | "superseded" }
  | { readonly status: "applied"; readonly evidenceSha256: string };
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
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const v = record(value);
  if (!v || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) return fail();
  return Object.fromEntries(keys.map(k => [k, v[k]]));
}
const validHash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const validInstant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
export function decodeMemberCleanupReconcileProof(value: unknown, binding: MemberCleanupReconcileBinding): MemberCleanupReconcileProof {
  const v = exactRecord(value, ["recoveryRequestId", "invocationRequestId", "taskId", "state", "original", "recovery", "evidenceSha256", "closedAt"]);
  const original = exactRecord(v.original, ["withdrawalId", "objectId", "dispatchId", "globalToken", "jobLeaseToken", "ackReceiptId", "ackSha256"]);
  const recovery = exactRecord(v.recovery, ["globalToken", "leaseToken", "expiresAt"]);
  if (v.recoveryRequestId !== binding.recoveryRequestId || v.invocationRequestId !== binding.invocationRequestId || v.taskId !== binding.taskId ||
    !["prepared", "completed", "superseded"].includes(String(v.state)) || recovery.globalToken !== binding.recoveryGlobalToken ||
    !validId(recovery.leaseToken) || !validInstant(recovery.expiresAt) ||
    ["withdrawalId", "dispatchId", "globalToken", "jobLeaseToken", "ackReceiptId"].some(k => !validId(original[k])) ||
    !(original.objectId === null || validId(original.objectId)) || !validHash(original.ackSha256) ||
    (v.state === "completed" ? !validHash(v.evidenceSha256) : v.evidenceSha256 !== null) ||
    (v.state === "prepared" ? v.closedAt !== null : !validInstant(v.closedAt))) return fail();
  return Object.freeze({ ...v, original: Object.freeze({ ...original }), recovery: Object.freeze({ ...recovery }) }) as unknown as MemberCleanupReconcileProof;
}

/** fresh begin만 기존 작업 처리기를 재사용한다. 같은 키의 재호출·응답 유실은 최소 GET으로만 확인한다. */
export async function processMemberCleanupReconciliation(ports: MemberCleanupReconcilePorts,
  adapter: ReturnType<typeof createMemberCleanupAdapter>, budget: CleanupExecutionBudget = {}): Promise<MemberCleanupReconcileResult> {
  if (!ports || typeof ports.begin !== "function" || typeof ports.get !== "function" || typeof ports.finish !== "function" ||
    typeof ports.assertCurrent !== "function" || typeof ports.getDeleteAck !== "function") return fail();
  const b = exactRecord(ports.binding, ["recoveryRequestId", "invocationRequestId", "taskId", "recoveryGlobalToken"]);
  if (Object.values(b).some(v => !validId(v))) throw new HttpError("INVALID_REQUEST");
  const binding = Object.freeze({ ...b }) as unknown as MemberCleanupReconcileBinding;
  if (!budget || typeof budget !== "object" || Array.isArray(budget) || Object.keys(budget).some(k => !["deadlineAt", "signal"].includes(k)) ||
    budget.deadlineAt !== undefined && !Number.isSafeInteger(budget.deadlineAt) || budget.signal !== undefined && !(budget.signal instanceof AbortSignal)) throw new HttpError("INVALID_REQUEST");
  const controller = new AbortController(), signal = budget.signal ? AbortSignal.any([controller.signal, budget.signal]) : controller.signal;
  const deadlineAt = Math.min(Date.now() + 60000, budget.deadlineAt ?? Infinity);
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
  try {
    if (Date.now() >= deadlineAt || signal.aborted) throw new HttpError("STATE_CONFLICT");
    return await withinBudget(signal, async () => {
      let begin: unknown;
      try { begin = await ports.begin(signal); } catch {
        // 미확정 begin에는 원 task 주소·lease가 없다. 조회 성공도 실행 허가로 바꾸지 않는다.
        const proof = decodeMemberCleanupReconcileProof(await ports.get(signal), binding);
        return recoveredStatus(proof);
      }
      const started = exactRecord(begin, ["recoveryRequestId", "state", "fresh", "task"]);
      if (started.recoveryRequestId !== binding.recoveryRequestId || typeof started.fresh !== "boolean" || !["prepared", "completed", "superseded"].includes(String(started.state))) return fail();
      const proof = decodeMemberCleanupReconcileProof(await ports.get(signal), binding);
      if (proof.state !== started.state) return fail();
      if (!started.fresh) { if (started.task !== null) return fail(); return recoveredStatus(proof); }
      if (proof.state !== "prepared") return fail();
      const task = decode(started.task);
      if (task.taskId !== binding.taskId || task.leaseToken !== proof.recovery.leaseToken || task.objectId !== proof.original.objectId ||
        task.expiresAt !== proof.recovery.expiresAt || task.leaseToken === proof.original.jobLeaseToken) return fail();
      let claimed = false;
      const denied = () => Promise.reject(new HttpError("STATE_CONFLICT"));
      const fixedOrigin = JSON.stringify({ original: proof.original, recovery: proof.recovery });
      const getProof = async () => {
        const current = decodeMemberCleanupReconcileProof(await ports.get(signal), binding);
        if (JSON.stringify({ original: current.original, recovery: current.recovery }) !== fixedOrigin) return fail();
        return current;
      };
      const taskPorts: MemberCleanupPorts = {
        claim: async token => { if (claimed || token !== binding.recoveryGlobalToken) throw new HttpError("STATE_CONFLICT"); claimed = true; return task; },
        assertCurrent: ports.assertCurrent.bind(ports),
        getDeleteAck: async fence => {
          const ack = decodeAck(await ports.getDeleteAck(fence, signal), task);
          if (ack.receiptId !== proof.original.ackReceiptId || ack.evidenceSha256 !== proof.original.ackSha256) return fail();
          return ack;
        },
        beginDelete: denied, recordDeleteAck: denied,
        complete: async fence => {
          // finish의 HTTP 응답은 성공 근거가 아니다. 원 recovery 키의 저장 증거를 다시 읽는다.
          try { await ports.finish(fence.evidenceSha256, signal); } catch { /* GET-only */ }
          const current = await getProof();
          if (current.state !== "completed" || current.evidenceSha256 !== fence.evidenceSha256) return fail();
          return { status: "applied" };
        },
      };
      const result = await processMemberCleanupTask(binding.recoveryGlobalToken, taskPorts, adapter, { deadlineAt, signal });
      if (result.status !== "applied") return fail();
      return recoveredStatus(await getProof());
    });
  } catch (error) { if (error instanceof HttpError) throw error; return fail(); }
  finally { clearTimeout(timer); }
}
function recoveredStatus(proof: MemberCleanupReconcileProof): MemberCleanupReconcileResult {
  return proof.state === "completed" ? Object.freeze({ status: "applied", evidenceSha256: proof.evidenceSha256! }) : Object.freeze({ status: proof.state === "superseded" ? "superseded" : "pending" });
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
  else await adapter.deleteAndVerify(task, async () => {
    await assertCurrent();
    if (!ports.beginDelete) return fail();
    const dispatch = record(await ports.beginDelete(fence, signal));
    if (!dispatch || Object.keys(dispatch).length !== 2 || !validId(dispatch.dispatchId) || dispatch.alreadyDispatched !== false) return fail();
    if (expired()) throw new HttpError("STATE_CONFLICT");
  }, async () => {
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

/** Shared scheduler allocation may tighten the existing member cleanup limit, never raise it. */
export async function processMemberCleanupBatch(workerRunToken:string,ports:MemberCleanupPorts,
 adapter:ReturnType<typeof createMemberCleanupAdapter>,allocation:{limit:number;deadlineAt:number;signal:AbortSignal}):Promise<{processed:number;stopReason:'idle'|'limit'|'aborted'|'deadline'}>{
 if(!validId(workerRunToken)||!allocation||Object.keys(allocation).length!==3||
 !Number.isSafeInteger(allocation.limit)||allocation.limit<0||allocation.limit>10||
 !Number.isSafeInteger(allocation.deadlineAt)||!(allocation.signal instanceof AbortSignal))throw new HttpError('INVALID_REQUEST');
 let processed=0;
 while(processed<allocation.limit){
  if(allocation.signal.aborted)return{processed,stopReason:'aborted'};
  if(Date.now()>=allocation.deadlineAt)return{processed,stopReason:'deadline'};
  const r=await processMemberCleanupTask(workerRunToken,ports,adapter,{deadlineAt:allocation.deadlineAt,signal:allocation.signal});
  if(r.status==='idle')return{processed,stopReason:'idle'};
  processed++;
 }
 return{processed,stopReason:'limit'};
}
