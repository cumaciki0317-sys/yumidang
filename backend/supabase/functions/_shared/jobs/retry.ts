export interface RetrySettings { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }
export type JobErrorCode = "DEPENDENCY_UNAVAILABLE" | "MODEL_UNAVAILABLE" | "INVALID_JOB" | "HANDLER_FAILED";

const JOB_ERROR_CODES: ReadonlySet<string> = new Set([
  "DEPENDENCY_UNAVAILABLE", "MODEL_UNAVAILABLE", "INVALID_JOB", "HANDLER_FAILED",
]);
function isJobErrorCode(value: unknown): value is JobErrorCode {
  return typeof value === "string" && JOB_ERROR_CODES.has(value);
}

export class JobExecutionError extends Error {
  readonly code: JobErrorCode;
  readonly retryable: boolean;
  constructor(code: JobErrorCode, retryable: boolean) {
    const validCode = isJobErrorCode(code);
    super(validCode ? code : "HANDLER_FAILED");
    this.code = validCode ? code : "HANDLER_FAILED";
    this.retryable = validCode && retryable === true;
  }
}
export function validateRetrySettings(settings: RetrySettings) {
  if (!settings || ![settings.maxAttempts, settings.baseDelayMs, settings.maxDelayMs]
    .every((n) => Number.isSafeInteger(n) && n > 0) || settings.maxDelayMs < settings.baseDelayMs) throw new Error("INVALID_RETRY_SETTINGS");
}
export function decideRetry(input: {
  failedAttempts: number; now: Date; error: unknown; settings: RetrySettings;
}): { status: "retry_wait"; retryAt: string; errorCode: JobErrorCode } | { status: "failed"; errorCode: JobErrorCode } {
  if (isJobExecutionUnknown(input.error)) throw input.error;
  validateRetrySettings(input.settings);
  if (!Number.isSafeInteger(input.failedAttempts) || input.failedAttempts < 0 || !Number.isFinite(input.now.getTime())) throw new Error("INVALID_RETRY_INPUT");
  const executionError = input.error instanceof JobExecutionError ? input.error : null;
  // JS는 readonly 필드를 변조할 수 있으므로 기록 직전에도 allowlist로 재확인한다.
  const candidateCode = executionError?.code;
  const validCode = isJobErrorCode(candidateCode);
  const errorCode = validCode ? candidateCode : "HANDLER_FAILED";
  if (!validCode || executionError?.retryable !== true || input.failedAttempts + 1 >= input.settings.maxAttempts) return { status: "failed", errorCode };
  const exponent = Math.min(input.failedAttempts, Math.ceil(Math.log2(input.settings.maxDelayMs / input.settings.baseDelayMs)));
  const delay = Math.min(input.settings.maxDelayMs, input.settings.baseDelayMs * 2 ** exponent);
  const retry = new Date(input.now.getTime() + delay);
  if (!Number.isFinite(retry.getTime())) throw new Error("INVALID_RETRY_INPUT");
  return { status: "retry_wait", retryAt: retry.toISOString(), errorCode };
}

/** 원격 종결 미확인은 일반 retry/fail 상태가 아니다. 원 요청을 보존하고 상위 실행을 중단한다. */
export class JobExecutionUnknown extends Error {
  readonly terminal = true;
  readonly phase: "claim" | "process" | "task_claim" | "complete" | "journal";
  constructor(phase: "claim" | "process" | "task_claim" | "complete" | "journal") {
    super("JOB_REMOTE_COMPLETION_UNKNOWN"); this.name = "JobExecutionUnknown"; this.phase = phase;
  }
}
export function isJobExecutionUnknown(error: unknown): boolean {
  return error instanceof JobExecutionUnknown || (error instanceof Error &&
    (error as Error & { terminal?: unknown }).terminal === true &&
    ["ReportRetentionStorageUnknown", "ReportRetentionMaintenanceUnknown"].includes(error.name));
}
