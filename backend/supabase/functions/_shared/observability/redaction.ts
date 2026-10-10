/** 종현: 요청 원문을 받지 않는 진단 allowlist. 정규식으로 원문을 가려 기록하지 않는다. */
import type { PublicErrorCode } from "../contracts/common.ts";

export type DiagnosticResultCode = PublicErrorCode | "SUCCESS" | "PREFLIGHT";
export interface RequestDiagnostic {
  requestId: string;
  resultCode: DiagnosticResultCode;
  status: number;
  /** 단조 시계 기준 handler 응답 생성까지. body 전송 완료 시각이 아니다. */
  durationMs: number;
}

/** HTTP 상태 기반 분류이며 adapter 내부 오류·도메인 성공을 추정하지 않는다. */
export function diagnosticResultCode(status: number): DiagnosticResultCode {
  if (status >= 200 && status < 300) return "SUCCESS";
  switch (status) {
    case 400: return "INVALID_REQUEST";
    case 401: return "AUTH_REQUIRED";
    case 403: return "ACCESS_DENIED";
    case 404: return "RESOURCE_NOT_FOUND";
    case 405: return "METHOD_NOT_ALLOWED";
    case 409: return "STATE_CONFLICT";
    case 413: return "PAYLOAD_TOO_LARGE";
    case 415: return "UNSUPPORTED_MEDIA_TYPE";
    case 503: return "EXTERNAL_UNAVAILABLE";
    default: return "INTERNAL_ERROR";
  }
}

/** accessor/toJSON/추가 metadata를 실행하거나 직렬화하지 않고 새 primitive record만 만든다. */
export function sanitizeRequestDiagnostic(value: unknown): Readonly<RequestDiagnostic> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const fields = ["requestId", "resultCode", "status", "durationMs"];
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) return null;
    if (fields.some(key => !descriptors[key] || !("value" in descriptors[key]) || !descriptors[key].enumerable)) return null;
    const requestId = descriptors.requestId.value;
    const resultCode = descriptors.resultCode.value;
    const status = descriptors.status.value;
    const durationMs = descriptors.durationMs.value;
    if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
        typeof status !== "number" || !Number.isSafeInteger(status) || status < 100 || status > 599 ||
        (resultCode !== diagnosticResultCode(status) && !(status === 204 && resultCode === "PREFLIGHT")) ||
        typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return null;
    return Object.freeze({ requestId, resultCode, status, durationMs });
  } catch { return null; }
}
