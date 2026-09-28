/**
 * 종현: 원문 없는 지표 생성기. 서버 구성의 sink/버전 목록만 주입한다.
 * 실제 logger·DB·보관 정책·호출부 연결은 포함하지 않는다.
 */
const FEATURES = new Set(["search", "places", "events", "event_sync", "ai_chat", "review_summary", "scheduled_jobs"]);
const RESULT_CODES = new Set([
  "SUCCESS", "EMPTY", "NEEDS_CLARIFICATION", "INVALID_INPUT", "FORBIDDEN", "UNAVAILABLE",
  "CANCELLED", "BUDGET_EXHAUSTED", "QUOTA_EXHAUSTED", "FAILED", "YIELDED", "SUPERSEDED",
  "LEASE_LOST", "INSUFFICIENT_REVIEWS",
]);
export type MetricFeature = "search" | "places" | "events" | "event_sync" | "ai_chat" | "review_summary" | "scheduled_jobs";
export type MetricResultCode =
  | "SUCCESS" | "EMPTY" | "NEEDS_CLARIFICATION" | "INVALID_INPUT" | "FORBIDDEN" | "UNAVAILABLE"
  | "CANCELLED" | "BUDGET_EXHAUSTED" | "QUOTA_EXHAUSTED" | "FAILED" | "YIELDED" | "SUPERSEDED"
  | "LEASE_LOST" | "INSUFFICIENT_REVIEWS";
export interface MetricUsage { inputTokens: number; outputTokens: number }
/** 값은 서버가 확인한 실행 결과/사용량이어야 한다. 클라이언트 요청을 그대로 전달하지 않는다. */
export interface MetricFinishInput {
  resultCode: MetricResultCode;
  retryCount: number;
  modelVersion?: string;
  promptVersion?: string;
  usage?: MetricUsage;
}
export interface MetricRecord extends MetricFinishInput {
  requestId: string;
  feature: MetricFeature;
  durationMs: number;
}
export interface MetricsSink { write(record: Readonly<MetricRecord>): Promise<void> }
export type MetricWriteResult =
  | { status: "recorded" }
  | { status: "ignored"; code: "ALREADY_FINISHED" }
  | { status: "rejected"; code: "INVALID_METRIC" }
  | { status: "unavailable"; code: "METRICS_SINK_UNAVAILABLE" };
export interface MetricSpan {
  readonly requestId: string;
  finish(input: MetricFinishInput): Promise<MetricWriteResult>;
}
export interface MetricsRecorder { begin(feature: MetricFeature): MetricSpan }
export interface MetricsOptions {
  sink: MetricsSink;
  /** 서버가 배포 설정으로 승인한 버전만 전달한다. 요청 본문으로 이 목록을 구성하지 않는다. */
  modelVersions: readonly string[];
  promptVersions: readonly string[];
  /** 테스트용 시계 주입. 실서비스에서는 기본 단조 시계를 사용한다. */
  now?: () => number;
}

function configuredVersions(values: readonly string[]): Set<string> {
  if (!Array.isArray(values) || values.some((value) =>
    typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value))) throw new Error("INVALID_METRICS_CONFIG");
  return new Set(values);
}
/** getter/추가 metadata도 받지 않아 필드 우회로 원문을 기록하지 않는다. */
function dataFields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_METRIC");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new Error("INVALID_METRIC");
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) throw new Error("INVALID_METRIC");
    fields[key] = descriptor.value;
  }
  return fields;
}
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function sanitizeFinish(input: MetricFinishInput, models: Set<string>, prompts: Set<string>): MetricFinishInput {
  const fields = dataFields(input, ["resultCode", "retryCount", "modelVersion", "promptVersion", "usage"]);
  if (typeof fields.resultCode !== "string" || !RESULT_CODES.has(fields.resultCode) || !isCount(fields.retryCount)) throw new Error("INVALID_METRIC");
  const safe: MetricFinishInput = { resultCode: fields.resultCode as MetricResultCode, retryCount: fields.retryCount };
  if (fields.modelVersion !== undefined) {
    if (typeof fields.modelVersion !== "string" || !models.has(fields.modelVersion)) throw new Error("INVALID_METRIC");
    safe.modelVersion = fields.modelVersion;
  }
  if (fields.promptVersion !== undefined) {
    if (typeof fields.promptVersion !== "string" || !prompts.has(fields.promptVersion)) throw new Error("INVALID_METRIC");
    safe.promptVersion = fields.promptVersion;
  }
  if (fields.usage !== undefined) {
    const usage = dataFields(fields.usage, ["inputTokens", "outputTokens"]);
    if (!safe.modelVersion || !isCount(usage.inputTokens) || !isCount(usage.outputTokens)) throw new Error("INVALID_METRIC");
    safe.usage = Object.freeze({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
  }
  return safe;
}

/**
 * 요청 ID는 여기서 생성한다. 요청 본문/헤더의 임의 ID·오류 객체·대상 회원 ID를 받지 않는다.
 * span 하나는 sink를 최대 한 번 호출한다. sink 실패 후 자동 재시도/오류 원문 출력은 하지 않는다.
 */
export function createMetricsRecorder(options: MetricsOptions): MetricsRecorder {
  let models: Set<string>;
  let prompts: Set<string>;
  let write: MetricsSink["write"];
  let now: () => number;
  try {
    models = configuredVersions(options.modelVersions);
    prompts = configuredVersions(options.promptVersions);
    if (typeof options.sink?.write !== "function" || (options.now !== undefined && typeof options.now !== "function")) throw new Error("INVALID_METRICS_CONFIG");
    write = options.sink.write.bind(options.sink);
    now = options.now ?? (() => performance.now());
  } catch {
    throw new Error("INVALID_METRICS_CONFIG");
  }
  return Object.freeze({
    begin(feature: MetricFeature): MetricSpan {
      if (typeof feature !== "string" || !FEATURES.has(feature)) throw new Error("INVALID_METRIC_FEATURE");
      let started: number;
      let requestId: string;
      try {
        started = now();
        if (!Number.isFinite(started)) throw new Error("INVALID_CLOCK");
        requestId = crypto.randomUUID();
      } catch {
        throw new Error("METRICS_START_UNAVAILABLE");
      }
      let finished = false;
      return Object.freeze({
        requestId,
        async finish(input: MetricFinishInput): Promise<MetricWriteResult> {
          if (finished) return { status: "ignored", code: "ALREADY_FINISHED" };
          let record: Readonly<MetricRecord>;
          try {
            const safe = sanitizeFinish(input, models, prompts);
            const durationMs = now() - started;
            if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error("INVALID_CLOCK");
            record = Object.freeze({ requestId, feature, durationMs, ...safe });
          } catch {
            return { status: "rejected", code: "INVALID_METRIC" };
          }
          finished = true;
          try {
            await write(record);
            return { status: "recorded" };
          } catch {
            return { status: "unavailable", code: "METRICS_SINK_UNAVAILABLE" };
          }
        },
      });
    },
  });
}
