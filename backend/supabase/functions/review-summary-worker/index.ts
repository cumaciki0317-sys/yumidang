/**
 * 담당: 종현담당
 * 역할: 요약 worker 런타임 조립. 내부 인증 → 명시 설정 → 모델(createConfiguredModel) → 승인된 안전 검사 →
 * DB RPC 접근 확인 → 실행당 한도 안의 runNextJob 반복. 어느 전제라도 없으면 작업을 점유하지 않고 not_enabled를 반환한다.
 * import는 실행·예약 등록을 하지 않는다. 실제 Edge 배포·일일 호출 등록은 별도 운영 작업이다.
 */
import { inspectReviewSummaryConfig, loadRuntimeConfig, requireInternalConfig, type EnvReader, type RuntimeConfig } from "../_shared/config/env.ts";
import { requireInternalCaller } from "../_shared/auth/internal-caller.ts";
import { createInternalClient } from "../_shared/db/internal-client.ts";
import type { FetchLike, RpcClient } from "../_shared/db/transport.ts";
import { createRpcJobRepository } from "../_shared/db/repositories/jobs.ts";
import { createRpcReviewSummaryRepository } from "../_shared/db/repositories/review-summaries.ts";
import { createWorkerRunScope } from "../_shared/jobs/worker-run.ts";
import { toPublicError } from "../_shared/http/errors.ts";
import { assertPrivacy, AiPrivacyError, type ApprovedPrivacyCheck } from "../_shared/ai/providers/privacy.ts";
import type { PotensOutputLimit } from "../_shared/ai/providers/potens-adapter.ts";
import { createConfiguredModel, type ModelRuntime } from "../_shared/ai/providers/runtime.ts";
import { REVIEW_SUMMARY_PROMPT_VERSION } from "../_shared/ai/Agents/review-summary/prompts.ts";
import type { SummarySafetyPort } from "../_shared/ai/Agents/review-summary/output-check.ts";
import type { ReviewSummarySettings } from "../_shared/ai/Agents/review-summary/orchestrator.ts";
import { runNextJob } from "../_shared/jobs/lease.ts";
import { createReviewSummaryRegistry } from "../_shared/jobs/registry.ts";
import { validateRetrySettings, type RetrySettings } from "../_shared/jobs/retry.ts";
import { requiredPositiveInt, SettingError } from "../_shared/jobs/settings.ts";
import {
  createReviewSummaryWorkerHandler, probeSummaryWorkerRpcs, runSummaryWorkerBatch,
  type WorkerNotEnabledReason, type WorkerRunResult,
} from "./handler.ts";

/** 설정 변수 이름(값은 서버 환경에서만 주입). 모두 필수이며 기본값이 없다. */
export const REVIEW_SUMMARY_WORKER_ENV = {
  maxJobsPerRun: "REVIEW_SUMMARY_WORKER_MAX_JOBS_PER_RUN",
  timeBudgetMs: "REVIEW_SUMMARY_WORKER_TIME_BUDGET_MS",
  leaseSeconds: "REVIEW_SUMMARY_LEASE_SECONDS",
  retryMaxAttempts: "REVIEW_SUMMARY_RETRY_MAX_ATTEMPTS",
  retryBaseDelayMs: "REVIEW_SUMMARY_RETRY_BASE_DELAY_MS",
  retryMaxDelayMs: "REVIEW_SUMMARY_RETRY_MAX_DELAY_MS",
  budgetDeferMs: "REVIEW_SUMMARY_BUDGET_DEFER_MS",
  maxInputChars: "REVIEW_SUMMARY_MAX_INPUT_CHARS",
  maxReviewsPerChunk: "REVIEW_SUMMARY_MAX_REVIEWS_PER_CHUNK",
  mergeFanIn: "REVIEW_SUMMARY_MERGE_FAN_IN",
  maxOutputTokens: "REVIEW_SUMMARY_MAX_OUTPUT_TOKENS",
  maxOutputChars: "REVIEW_SUMMARY_MAX_OUTPUT_CHARS",
  maxCallsPerStep: "REVIEW_SUMMARY_MAX_CALLS_PER_STEP",
} as const;

/**
 * 제품 요약 공개 전에 필요한 의미·개인정보 검사기. 검사 방법·품질 기준은 첫 합성 결과 공동 검토 후 정한다(미정).
 * 승인된 검사기가 없으므로 운영 기본값은 null이며 worker는 작업을 점유하지 않는다. 가짜 검사기로 대체하지 않는다.
 */
export const APPROVED_SUMMARY_SAFETY_CHECKER: SummarySafetyPort | null = null;

export interface WorkerSettings {
  maxJobsPerRun: number; timeBudgetMs: number; leaseSeconds: number; budgetDeferMs: number;
  retry: RetrySettings; summary: ReviewSummarySettings;
}
export function loadWorkerSettings(read: EnvReader): WorkerSettings | WorkerNotEnabledReason {
  const e = REVIEW_SUMMARY_WORKER_ENV;
  let settings: WorkerSettings;
  try {
    settings = {
      maxJobsPerRun: requiredPositiveInt(read, e.maxJobsPerRun, 10),
      timeBudgetMs: requiredPositiveInt(read, e.timeBudgetMs, 60000),
      leaseSeconds: requiredPositiveInt(read, e.leaseSeconds, 180),
      budgetDeferMs: requiredPositiveInt(read, e.budgetDeferMs, 3600000),
      retry: {
        maxAttempts: requiredPositiveInt(read, e.retryMaxAttempts, 3),
        baseDelayMs: requiredPositiveInt(read, e.retryBaseDelayMs, 600000),
        maxDelayMs: requiredPositiveInt(read, e.retryMaxDelayMs, 21600000),
      },
      summary: {
        maxInputChars: requiredPositiveInt(read, e.maxInputChars, 12000),
        maxReviewsPerChunk: requiredPositiveInt(read, e.maxReviewsPerChunk, 20),
        mergeFanIn: requiredPositiveInt(read, e.mergeFanIn, 4),
        maxOutputTokens: requiredPositiveInt(read, e.maxOutputTokens, 800),
        maxOutputChars: requiredPositiveInt(read, e.maxOutputChars, 300),
        maxCallsPerStep: requiredPositiveInt(read, e.maxCallsPerStep, 3),
      },
    };
  } catch (error) {
    if (error instanceof SettingError) return "WORKER_NOT_CONFIGURED";
    throw error;
  }
  try { validateRetrySettings(settings.retry); } catch { return "WORKER_SETTINGS_INVALID"; }
  // 정책14의 고정 점유/첫 재시도/예산 재확인 주기는 낮은 값으로도 바꾸지 않는다.
  if (settings.leaseSeconds !== 180 || settings.retry.baseDelayMs !== 600_000 || settings.budgetDeferMs !== 3_600_000) {
    return "WORKER_SETTINGS_INVALID";
  }
  // max 설정의 더 낮은 값은 허용하지만 관계가 모순되면 실행 전에 거절한다.
  if (settings.leaseSeconds * 1000 <= settings.timeBudgetMs || settings.summary.mergeFanIn < 2) return "WORKER_SETTINGS_INVALID";
  return settings;
}

export interface WorkerRuntimeOverrides {
  fetch?: FetchLike;
  /** 테스트용 DB 주입. 운영은 민규 내부 클라이언트(createInternalClient)만 사용한다. */
  createDb?(config: RuntimeConfig): RpcClient;
  createModel?(read: EnvReader, deps: { budgetDb: RpcClient; fetch?: FetchLike }): ModelRuntime;
  safety?: SummarySafetyPort | null;
  outputLimit?: PotensOutputLimit;
  privacy?: ApprovedPrivacyCheck;
  now?(): Date;
  elapsedMs?(): number;
  workerId?(): string;
}

export function createReviewSummaryWorkerRuntime(read: EnvReader, overrides: WorkerRuntimeOverrides = {}) {
  const config = loadRuntimeConfig(read);
  requireInternalConfig(config);
  const fetchImpl = overrides.fetch ?? ((url, init) => fetch(url, init));
  const createDb = overrides.createDb ?? ((value: RuntimeConfig) => createInternalClient(value, fetchImpl));
  const createModel = overrides.createModel ?? createConfiguredModel;
  const safety = overrides.safety === undefined ? APPROVED_SUMMARY_SAFETY_CHECKER : overrides.safety;
  const now = overrides.now ?? (() => new Date());
  const elapsedMs = overrides.elapsedMs ?? (() => performance.now());
  const workerId = overrides.workerId ?? (() => crypto.randomUUID());

  async function run(existingToken?: string): Promise<WorkerRunResult> {
    const notEnabled = (reason: WorkerNotEnabledReason): WorkerRunResult => ({ status: "not_enabled", reason });
    const settings = loadWorkerSettings(read);
    if (typeof settings === "string") return notEnabled(settings);
    const versions = inspectReviewSummaryConfig({
      modelVersion: config.reviewSummaryModelVersion, promptVersion: config.reviewSummaryPromptVersion,
    });
    if (versions.status === "pending_configuration") return notEnabled("SUMMARY_VERSIONS_NOT_CONFIGURED");
    if (versions.status !== "ready") return notEnabled("SUMMARY_VERSIONS_INVALID");
    // 지원하지 않는 prompt 버전으로 점유하면 모든 작업이 영구 실패하므로 점유 전에 멈춘다.
    if (versions.promptVersion !== REVIEW_SUMMARY_PROMPT_VERSION) return notEnabled("SUMMARY_PROMPT_UNSUPPORTED");
    const db = createDb(config);
    const model = createModel(read, { budgetDb: db, fetch: fetchImpl, outputLimit: overrides.outputLimit });
    if (model.status !== "ready") return notEnabled(`MODEL_${model.code}` as WorkerNotEnabledReason);
    // 작업에 기록되는 요청 모델 버전과 실제 조립된 모델 표식이 다르면 다른 모델의 결과를 그 버전으로 게시하게 된다.
    if (model.modelVersion !== versions.modelVersion) return notEnabled("MODEL_VERSION_MISMATCH");
    if (!safety || typeof safety.check !== "function") return notEnabled("SAFETY_CHECK_NOT_APPROVED");
    if (!overrides.privacy?.decisionId || typeof overrides.privacy.check !== "function") return notEnabled("PRIVACY_CHECK_NOT_APPROVED");
    const probe = await probeSummaryWorkerRpcs(db);
    if (probe !== "ready") return notEnabled(probe);

    const scope = createWorkerRunScope(db);
    let lease;
    try { lease = await scope.open(existingToken); }
    catch (error) { return notEnabled(toPublicError(error).error.code === "ACCESS_DENIED" ? "DB_RPC_NOT_ALLOWED" : "DB_RPC_UNAVAILABLE"); }
    if (!lease) return notEnabled("WORKER_RUN_BUSY");
    const protectedModel = { async generate(request: Parameters<typeof model.model.generate>[0]) {
      try {
        if (!request.summaryRequest || request.summaryRequest.workerRunToken !== lease.token) throw new Error("SUMMARY_MODEL_SCOPE_MISSING");
        await assertPrivacy(request.input, overrides.privacy!, "input");
        const response = await model.model.generate(request);
        await assertPrivacy(response.value, overrides.privacy!, "output");
        return response;
      } catch (error) {
        if (error instanceof AiPrivacyError) throw new Error(error.direction === "input" ? "UNSAFE_SUMMARY_INPUT" : "UNSAFE_SUMMARY_OUTPUT");
        throw error;
      }
    } };
    const controller = new AbortController();
    const remaining = Date.parse(lease.expiresAt) - now().getTime();
    const timer = setTimeout(() => controller.abort(), Math.max(0, Math.min(settings.timeBudgetMs, remaining)));
    if (remaining <= 0) controller.abort();
    try {
      const repository = createRpcJobRepository(db, { workerRunToken: lease.token });
      const registry = createReviewSummaryRegistry({
        repository: createRpcReviewSummaryRepository(db, { workerRunToken: lease.token }), model: protectedModel, safety,
        settings: settings.summary, versions: { modelVersion: versions.modelVersion, promptVersion: versions.promptVersion },
        signal: controller.signal, workerRunToken: lease.token,
      }, { budgetDeferMs: settings.budgetDeferMs, now });
      const id = workerId();
      return await runSummaryWorkerBatch({
        maxJobsPerRun: settings.maxJobsPerRun, timeBudgetMs: settings.timeBudgetMs, elapsedMs, signal: controller.signal,
        runOne: () => runNextJob({
          workerId: id, repository, registry, now,
          settings: { leaseDurationMs: settings.leaseSeconds * 1000, retry: settings.retry },
        }),
      });
    } finally {
      clearTimeout(timer);
      await scope.close(lease);
    }
  }

  return createReviewSummaryWorkerHandler({
    allowedOrigins: config.allowedOrigins,
    maxBodyBytes: config.maxRequestBytes,
    authenticateInternal: (request) => requireInternalCaller(request, config),
    run,
  });
}

let handler: ReturnType<typeof createReviewSummaryWorkerRuntime> | undefined;
const entrypoint = {
  fetch(request: Request): Promise<Response> {
    handler ??= createReviewSummaryWorkerRuntime((key) => Deno.env.get(key));
    return handler(request);
  },
};
export default entrypoint;
if (import.meta.main) Deno.serve(entrypoint.fetch);
