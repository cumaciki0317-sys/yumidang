import type { JobReference, JobRepository } from "../db/repositories/jobs.ts";

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
    case "review_summary":
      if (!validString(value.targetUserId) || !Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 0) break;
      return { kind: value.kind, targetUserId: value.targetUserId, sourceRevision: value.sourceRevision };
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
  if (!validInstant(runAt)) throw new Error("INVALID_JOB_RUN_AT");
  return repository.enqueue({
    reference: normalized,
    idempotencyKey: JSON.stringify(normalized),
    runAt: new Date(runAt).toISOString(),
  });
}
