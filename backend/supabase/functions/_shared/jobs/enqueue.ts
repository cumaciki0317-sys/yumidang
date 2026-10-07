import { decodeSafetyJobPayload } from "../db/repositories/jobs.ts";
import type { JobReference, JobRepository } from "../db/repositories/jobs.ts";
import { isSourceRevision, isSummaryVersion } from "../db/repositories/review-summaries.ts";

const validString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export function validInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 ||
      (match[5] !== undefined && (Number(match[5]) > 23 || Number(match[6]) > 59))) return false;
  const calendar = new Date(match[1] + "T00:00:00Z");
  return Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === match[1] && Number.isFinite(Date.parse(value));
}
/** allowlist로 새 객체를 만든다. 원문/연락처/임의 명령을 작업 payload에 복제하지 않는다. */
export function normalizeJobReference(value: JobReference): JobReference {
  if (!value || typeof value !== "object") throw new Error("INVALID_JOB_REFERENCE");
  switch (value.kind) {
    case "cancellation_safety":
      if (Object.keys(value).length !== 3) break;
      return decodeSafetyJobPayload(value.kind, { identityId: value.identityId, generation: value.generation });
    case "report_retention":
      if (Object.keys(value).length !== 3) break;
      return decodeSafetyJobPayload(value.kind, { reportId: value.reportId, closureProofId: value.closureProofId });
    case "review_summary":
      if (!validString(value.targetUserId) || !isSourceRevision(value.sourceRevision) ||
          !isSummaryVersion(value.modelVersion) || !isSummaryVersion(value.promptVersion)) break;
      return {
        kind: value.kind, targetUserId: value.targetUserId, sourceRevision: value.sourceRevision,
        modelVersion: value.modelVersion, promptVersion: value.promptVersion,
      };
    case "event_sync":
      if (!validString(value.provider) || !validInstant(value.windowStart) || !validInstant(value.windowEnd) ||
          Date.parse(value.windowStart) >= Date.parse(value.windowEnd)) break;
      return { kind: value.kind, provider: value.provider, windowStart: new Date(value.windowStart).toISOString(), windowEnd: new Date(value.windowEnd).toISOString() };
    case "auto_complete":
    case "review_release":
      if (!validString(value.appointmentId) || !validInstant(value.expectedDueAt)) break;
      return { kind: value.kind, appointmentId: value.appointmentId, expectedDueAt: new Date(value.expectedDueAt).toISOString() };
  }
  throw new Error("INVALID_JOB_REFERENCE");
}
export async function enqueueJob(repository: JobRepository, reference: JobReference, runAt: string) {
  const normalized = normalizeJobReference(reference);
  if (normalized.kind === "cancellation_safety" || normalized.kind === "report_retention") throw new Error("DEDICATED_DUE_ENQUEUE_REQUIRED");
  if (!validInstant(runAt)) throw new Error("INVALID_JOB_RUN_AT");
  // DB v2 요청용 명시 키. UUID 대상이면 최대201자이며 현재 DB의512자/허용문자 범위에 들어간다.
  // 나머지 kind의 JSON 키는 기존 가상 코어 호환용이며 실제 DB 등록에 사용하지 않는다.
  const idempotencyKey = normalized.kind === "review_summary"
    ? ["review_summary", normalized.targetUserId, normalized.sourceRevision, normalized.modelVersion, normalized.promptVersion].join(":")
    : JSON.stringify(normalized);
  if (normalized.kind === "review_summary" &&
      (idempotencyKey.length > 512 || !/^[A-Za-z0-9_.:-]+$/.test(idempotencyKey))) throw new Error("INVALID_JOB_REFERENCE");
  return repository.enqueue({
    reference: normalized,
    idempotencyKey,
    runAt: new Date(runAt).toISOString(),
  });
}

/** due 등록은 DB가 payload/세대를 결정한다. generic enqueue나 소비자 생성 job으로 대체하지 않는다. */
export interface SafetyDueEnqueuePort {
  enqueueCancellation(limit: number, globalToken: string, signal: AbortSignal): Promise<unknown>;
  enqueueReportRetention(limit: number, globalToken: string, signal: AbortSignal): Promise<unknown>;
}
export async function enqueueSafetyDue(port: SafetyDueEnqueuePort, kind: "cancellation_safety" | "report_retention", limit: number, globalToken: string, signal: AbortSignal): Promise<{ enqueued: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(globalToken) || signal.aborted) throw new Error("INVALID_SAFETY_ENQUEUE");
  const raw = kind === "cancellation_safety" ? await port.enqueueCancellation(limit, globalToken, signal) : await port.enqueueReportRetention(limit, globalToken, signal);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, "enqueued") ||
      !Number.isSafeInteger((raw as { enqueued: unknown }).enqueued) || Number((raw as { enqueued: unknown }).enqueued) < 0 || Number((raw as { enqueued: unknown }).enqueued) > limit) throw new Error("INVALID_SAFETY_ENQUEUE_RESULT");
  return { enqueued: Number((raw as { enqueued: unknown }).enqueued) };
}
