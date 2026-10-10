/** 종현: 서버가 명시 주입한 sink에만 최소 요청 진단을 전달한다. 기본 console/DB/외부 저장 없음. */
import { sanitizeRequestDiagnostic, type RequestDiagnostic } from "./redaction.ts";

export type DiagnosticWriteResult =
  | { status: "recorded" }
  | { status: "rejected"; code: "INVALID_DIAGNOSTIC" }
  | { status: "unavailable"; code: "DIAGNOSTICS_SINK_UNAVAILABLE" };
export interface DiagnosticLogger { write(value: unknown): Promise<DiagnosticWriteResult> }
export interface DiagnosticSink { write(record: Readonly<RequestDiagnostic>): void | Promise<void> }

/** 보관30일·접근·삭제 조건은 호스트의 별도 검증 대상이며 이 factory로 승인하지 않는다. */
export function createDiagnosticLogger(sink: DiagnosticSink): DiagnosticLogger {
  let write: DiagnosticSink["write"];
  try {
    if (typeof sink?.write !== "function") throw new Error();
    write = sink.write.bind(sink);
  } catch { throw new Error("INVALID_DIAGNOSTICS_CONFIG"); }
  return Object.freeze({
    async write(value: unknown): Promise<DiagnosticWriteResult> {
      const record = sanitizeRequestDiagnostic(value);
      if (!record) return { status: "rejected", code: "INVALID_DIAGNOSTIC" };
      try {
        await write(record);
        return { status: "recorded" };
      } catch {
        // 오류 원문·원 record를 다른 logger로 보내거나 자동 재시도하지 않는다.
        return { status: "unavailable", code: "DIAGNOSTICS_SINK_UNAVAILABLE" };
      }
    },
  });
}
