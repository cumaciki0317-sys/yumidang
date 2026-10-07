/** 실제 내부 RPC 연결. 공통 allowlist·SQL 미채택이면 원천 요청 전에 안전 중단한다. */
import type { RpcClient } from "../db/transport.ts";
import type { JsonValue } from "../contracts/common.ts";
import {
  type EventCollectionProgress,
  type EventCollectionReference,
  type EventCollectionStore,
  registerDailyEventCollections,
  runEventCollection,
} from "./event-collection.ts";
import {
  EventProviderError,
  type EventProviderPort,
} from "../integrations/events/port.ts";
import {
  parseCalendarDate,
  parseEventInstant,
  seoulCalendarDate,
} from "../integrations/events/normalize.ts";
import { createWorkerRunScope } from "./worker-run.ts";
import { toWireEvent } from "../db/repositories/events.ts";
import {
  type KopisRankingMode,
  kopisRankingPeriod,
  type VerifiedKopisRanking,
} from "../integrations/events/kopis-ranking.ts";
import {
  type EventDetailProviderPort,
  type KopisDetailProviderPort,
} from "../integrations/events/detail.ts";
export const EVENT_COLLECTION_CONTRACT = "2026-10-05";
export const EVENT_RUNTIME_RPCS = [
  "read_event_collection_contract",
  "register_event_collection_jobs",
  "claim_event_collection",
  "commit_event_collection_page",
  "store_event_source_detail",
  "next_event_collection_reference",
  "list_ongoing_event_source_ids",
  "settle_event_collection",
  "complete_event_ranking_collection",
] as const;
const record = (v: unknown): v is Record<string, JsonValue> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v));
/** AbortSignal.any는 먼저 중단한 reason을 보존한다. 부모/자체 예산 타임아웃은 정상 양보, 실제 AbortError 취소는 공급사 취소로 구분한다. */
const exhaustedWorkerBudget = (signal: AbortSignal) =>
  signal.aborted && signal.reason instanceof DOMException &&
  signal.reason.name === "TimeoutError";
const unavailable = () => ({
  status: "not_enabled" as const,
  reason: "EVENT_COLLECTION_PERSISTENCE_NOT_CONNECTED",
});
/** 각 새 기능은 DB가 버전·capability를 선언해야 활성화한다. 선언 자체가 실제 외부 검증을 뜻하지 않는다. */
export function createEventOperations(
  options: {
    db: RpcClient;
    providers: Map<string, EventProviderPort>;
    providerMaxPage: number;
    providerMaxPages?: Map<string, number>;
    maxPages: number;
    now: () => Date;
    rpcAvailable?: (name: string) => boolean;
    ongoingProviders?: Map<string, EventProviderPort>;
    rankingProvider?: {
      collect(
        mode: KopisRankingMode,
        signal?: AbortSignal,
      ): Promise<VerifiedKopisRanking>;
    };
    detailProviders?: Map<string, EventDetailProviderPort>;
  },
) {
  const ready = async (capability: string) => {
    const required = capability === "ranking_jobs"
      ? [
        "read_event_collection_contract",
        "claim_event_collection",
        "complete_event_ranking_collection",
        "settle_event_collection",
        "acquire_worker_run",
        "release_worker_run",
      ]
      : capability === "detail_jobs"
      ? [
        "read_event_collection_contract",
        "register_event_collection_jobs",
        "claim_event_collection",
        "store_event_source_detail",
        "settle_event_collection",
        "acquire_worker_run",
        "release_worker_run",
      ]
      : [
        "read_event_collection_contract",
        "register_event_collection_jobs",
        "claim_event_collection",
        "commit_event_collection_page",
        "settle_event_collection",
        "next_event_collection_reference",
        "acquire_worker_run",
        "release_worker_run",
      ];
    if (
      options.rpcAvailable &&
      required.some((name) => !options.rpcAvailable!(name))
    ) return false;

    try {
      const r = await options.db.rpc("read_event_collection_contract", {});
      return record(r) && r.version === EVENT_COLLECTION_CONTRACT &&
        Array.isArray(r.capabilities) && r.capabilities.includes(capability);
    } catch {
      return false;
    }
  };
  const registration = {
    async register(
      input: {
        provider: string;
        registeredOn: string;
        references: EventCollectionReference[];
      },
    ) {
      const result = await options.db.rpc("register_event_collection_jobs", {
        p_provider: input.provider,
        p_registered_on: input.registeredOn,
        p_references: json(input.references),
        p_detail_provider:
          options.detailProviders?.has(input.provider) === true,
        p_detail_source_ids: null,
      });
      if (!record(result)) {
        throw new Error("INVALID_EVENT_COLLECTION_REGISTRATION");
      }
      return result as unknown as {
        status: "registered";
        createdCount: number;
        existingCount: number;
        initialHistory: "registered" | "already_registered";
      };
    },
  };
  const collectRanking = async (
    reference: EventCollectionReference,
    token?: string,
    signal?: AbortSignal,
  ) => {
    if (
      reference.provider !== "kopis" ||
      !["ranking_all", "ranking_musical"].includes(reference.lane)
    ) throw new Error("INVALID_EVENT_RANKING_REFERENCE");
    if (!await ready("ranking_jobs") || !options.rankingProvider) {
      return {
        status: "not_enabled" as const,
        reason: "RANKING_JOBS_NOT_CONNECTED",
      };
    }
    const mode = reference.lane === "ranking_all" ? "all" : "musical";
    const scope = createWorkerRunScope(options.db),
      lease = await scope.open(token);
    if (!lease) return { status: "not_claimed" as const };
    let claim: Record<string, JsonValue> | null = null;
    const settle = async (
      outcome: "superseded" | "yielded" | "provider_failed",
      code: string | null,
      retryable: boolean,
    ) => {
      if (!claim) throw new Error("INVALID_EVENT_RANKING_CLAIM");
      const raw = await options.db.rpc("settle_event_collection", {
        p_job_id: claim.jobId,
        p_lease_token: claim.leaseToken,
        p_worker_run_token: lease.token,
        p_outcome: outcome,
        p_error_code: code,
        p_retryable: retryable,
        p_retry_floor_seconds: 600,
        p_retry_cap_seconds: 21600,
      });
      if (
        !record(raw) ||
        !["queued", "retry_wait", "failed", "superseded", "lease_lost"]
          .includes(raw.status as string)
      ) throw new Error("INVALID_EVENT_RANKING_SETTLEMENT");
      return raw.status as
        | "queued"
        | "retry_wait"
        | "failed"
        | "superseded"
        | "lease_lost";
    };
    const timeout = AbortSignal.timeout(
        Math.max(1, Math.min(60000, Date.parse(lease.expiresAt) - Date.now())),
      ),
      runSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const raw = await options.db.rpc("claim_event_collection", {
        p_provider: "kopis",
        p_lane: reference.lane,
        p_period: json(reference.period),
        p_worker_run_token: lease.token,
        p_lease_seconds: 180,
      });
      if (raw === null) return { status: "not_claimed" as const };
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (
        !record(raw) || typeof raw.jobId !== "string" ||
        !uuid.test(raw.jobId) || typeof raw.leaseToken !== "string" ||
        !uuid.test(raw.leaseToken) || raw.provider !== reference.provider ||
        raw.lane !== reference.lane || !record(raw.period) ||
        raw.period.start !== reference.period.start ||
        raw.period.end !== reference.period.end
      ) throw new Error("INVALID_EVENT_RANKING_CLAIM");
      claim = raw;
      const current = kopisRankingPeriod(options.now());
      if (
        reference.period.start !== current.start ||
        reference.period.end !== current.end
      ) {
        if (reference.period.end >= current.end) {
          throw new Error("INVALID_EVENT_RANKING_REFERENCE");
        }
        return { status: await settle("superseded", null, false) };
      }
      runSignal.throwIfAborted();
      const snapshot = await options.rankingProvider.collect(mode, runSignal);
      runSignal.throwIfAborted();
      const latest = kopisRankingPeriod(options.now());
      if (
        latest.start !== reference.period.start ||
        latest.end !== reference.period.end
      ) return { status: await settle("superseded", null, false) };
      if (
        snapshot.mode !== mode || snapshot.periodVerification !== "verified" ||
        snapshot.requestedPeriod.start !== reference.period.start ||
        snapshot.requestedPeriod.end !== reference.period.end ||
        snapshot.responsePeriod.start !== reference.period.start ||
        snapshot.responsePeriod.end !== reference.period.end
      ) throw new EventProviderError("SOURCE_INVALID_RESPONSE");
      const result = await options.db.rpc("complete_event_ranking_collection", {
        p_job_id: claim.jobId,
        p_lease_token: claim.leaseToken,
        p_worker_run_token: lease.token,
        p_period: json(reference.period),
        p_snapshot: json(snapshot),
      });
      if (
        !record(result) ||
        !["applied", "stale", "superseded", "lease_lost"].includes(
          result.status as string,
        )
      ) throw new Error("INVALID_EVENT_RANKING_STORE_RESPONSE");
      return {
        status: result.status === "applied" || result.status === "stale"
          ? "complete" as const
          : result.status as "superseded" | "lease_lost",
      };
    } catch (error) {
      if (!claim) throw error;
      const timedOut = exhaustedWorkerBudget(runSignal),
        providerError = error instanceof EventProviderError ? error : null;
      const status = await settle(
        timedOut ? "yielded" : "provider_failed",
        timedOut ? null : providerError?.code ?? "EVENT_RANKING_UNAVAILABLE",
        timedOut ? false : providerError?.retryable ?? false,
      );
      return { status: status === "queued" ? "partial" as const : status };
    } finally {
      await scope.close(lease);
    }
  };
  const collectDetail = async (
    reference: EventCollectionReference,
    token?: string,
    signal?: AbortSignal,
  ) => {
    if (
      reference.lane !== "detail" ||
      !["kopis", "tour-api"].includes(reference.provider) ||
      !(reference.provider === "kopis" ? /^PF[0-9A-Za-z]+$/ : /^\d{1,20}$/)
        .test(reference.sourceId ?? "") ||
      typeof reference.sourceCollectedAt !== "string"
    ) throw new Error("INVALID_EVENT_DETAIL_REFERENCE");
    parseEventInstant(reference.sourceCollectedAt);
    parseCalendarDate(reference.period.start);
    if (
      reference.period.start !== reference.period.end ||
      reference.period.start !==
        seoulCalendarDate(new Date(reference.sourceCollectedAt))
    ) throw new Error("INVALID_EVENT_DETAIL_REFERENCE");
    const port = options.detailProviders?.get(reference.provider);
    if (!await ready("detail_jobs") || !port) {
      return {
        status: "not_enabled" as const,
        reason: "DETAIL_JOBS_NOT_CONNECTED",
      };
    }
    const scope = createWorkerRunScope(options.db),
      lease = await scope.open(token);
    if (!lease) return { status: "not_claimed" as const };
    let claim: Record<string, JsonValue> | null = null;
    const timeout = AbortSignal.timeout(
        Math.max(1, Math.min(60000, Date.parse(lease.expiresAt) - Date.now())),
      ),
      runSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const raw = await options.db.rpc("claim_event_collection", {
        p_provider: reference.provider,
        p_lane: "detail",
        p_period: json(reference.period),
        p_source_id: reference.sourceId!,
        p_source_collected_at: reference.sourceCollectedAt!,
        p_worker_run_token: lease.token,
        p_lease_seconds: 180,
      });
      if (raw === null) return { status: "not_claimed" as const };
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (
        !record(raw) || typeof raw.jobId !== "string" ||
        !uuid.test(raw.jobId) || typeof raw.leaseToken !== "string" ||
        !uuid.test(raw.leaseToken) || raw.provider !== reference.provider ||
        raw.lane !== "detail" || raw.sourceId !== reference.sourceId ||
        raw.sourceCollectedAt !== reference.sourceCollectedAt ||
        !record(raw.period) || raw.period.start !== reference.period.start ||
        raw.period.end !== reference.period.end
      ) throw new Error("INVALID_EVENT_DETAIL_CLAIM");
      claim = raw;
      runSignal.throwIfAborted();
      const detail = await port.fetchDetail(reference.sourceId!, runSignal);
      runSignal.throwIfAborted();
      if (
        detail.provider !== reference.provider ||
        detail.sourceId !== reference.sourceId
      ) throw new EventProviderError("SOURCE_INVALID_RESPONSE");
      parseEventInstant(detail.collectedAt);
      // null/누락은 삭제 명령이 아니다. 알려진 원천 가격도 unknown 응답으로 지우지 않는다.
      const payload: Record<string, JsonValue> = {
        provider: detail.provider,
        sourceId: detail.sourceId,
        collectedAt: detail.collectedAt,
      };
      if (
        !detail.admission ||
        !["unknown", "free", "described"].includes(detail.admission.kind) ||
        (detail.admission.kind === "described" &&
          (typeof detail.admission.text !== "string" ||
            !detail.admission.text.trim() ||
            detail.admission.text.length > 10000 ||
            /[<>\u0000-\u001f]/u.test(detail.admission.text)))
      ) throw new EventProviderError("SOURCE_INVALID_RESPONSE");
      if (detail.admission.kind !== "unknown") {
        payload.admission = json(detail.admission);
      }
      for (
        const key of ["operatingInfo", "description", "posterUrl"] as const
      ) {
        const value = detail[key];
        if (value == null || value === "") continue;
        if (
          typeof value !== "string" || value.length > 10000 ||
          /[<>\u0000-\u001f]/u.test(value)
        ) throw new EventProviderError("SOURCE_INVALID_RESPONSE");
        if (key === "posterUrl") {
          const url = new URL(value);
          if (
            url.protocol !== "https:" || url.username || url.password ||
            url.search || url.hash ||
            !["kopis.or.kr", "www.kopis.or.kr"].includes(url.hostname) ||
            !url.pathname.startsWith("/upload/")
          ) throw new EventProviderError("SOURCE_INVALID_RESPONSE");
        }
        payload[key] = value;
      }
      runSignal.throwIfAborted();
      const result = await options.db.rpc("store_event_source_detail", {
        p_detail: payload,
        p_job_id: claim.jobId,
        p_lease_token: claim.leaseToken,
        p_worker_run_token: lease.token,
        p_source_collected_at: reference.sourceCollectedAt!,
        p_preserve_missing: true,
      });
      if (
        !record(result) ||
        !["applied", "stale", "superseded", "lease_lost"].includes(
          result.status as string,
        )
      ) throw new Error("INVALID_DETAIL_STORE_RESPONSE");
      return {
        status: result.status === "applied" || result.status === "stale"
          ? "complete" as const
          : result.status as "superseded" | "lease_lost",
      };
    } catch (error) {
      if (!claim) throw error;
      const yielded = exhaustedWorkerBudget(runSignal),
        providerError = error instanceof EventProviderError ? error : null;
      const result = await options.db.rpc("settle_event_collection", {
        p_job_id: claim.jobId,
        p_lease_token: claim.leaseToken,
        p_worker_run_token: lease.token,
        p_outcome: yielded ? "yielded" : "provider_failed",
        p_error_code: yielded
          ? null
          : providerError?.code ?? "EVENT_DETAIL_UNAVAILABLE",
        p_retryable: yielded ? false : providerError?.retryable ?? false,
        p_retry_floor_seconds: 600,
        p_retry_cap_seconds: 21600,
      });
      if (
        !record(result) ||
        !["queued", "retry_wait", "failed", "lease_lost"].includes(
          result.status as string,
        )
      ) throw new Error("INVALID_EVENT_DETAIL_SETTLEMENT");
      return {
        status: result.status === "queued"
          ? "partial" as const
          : result.status as "retry_wait" | "failed" | "lease_lost",
      };
    } finally {
      await scope.close(lease);
    }
  };
  const operations = {
    async register(providers: string[], maxPeriodDays: number) {
      if (!await ready("collection")) return unavailable();
      if (providers.some((p) => !options.providers.has(p))) {
        throw new Error("INVALID_EVENT_PROVIDER");
      }
      if (
        providers.some((p) => options.detailProviders?.has(p)) &&
        !await ready("collection_details")
      ) return unavailable();
      return registerDailyEventCollections({
        now: options.now(),
        providers,
        maxPeriodDays,
        registration,
      });
    },
    async collect(
      reference: EventCollectionReference,
      token?: string,
      signal?: AbortSignal,
    ) {
      if (!await ready("collection")) return unavailable();
      if (reference.lane === "detail") {
        return collectDetail(reference, token, signal);
      }
      if (["ranking_all", "ranking_musical"].includes(reference.lane)) {
        return collectRanking(reference, token, signal);
      }
      if (
        options.detailProviders?.has(reference.provider) &&
        !await ready("collection_details")
      ) return unavailable();
      const provider = options.providers.get(reference.provider);
      if (!provider) throw new Error("INVALID_EVENT_PROVIDER");
      // 진행 중 공급사 연결 없음은 점유·원천 호출 전에 표시한다.
      if (
        reference.lane === "ongoing" &&
        !options.ongoingProviders?.has(reference.provider)
      ) {
        return {
          status: "not_enabled",
          reason: "ONGOING_PROVIDER_NOT_CONNECTED",
        };
      }
      const scope = createWorkerRunScope(options.db),
        lease = await scope.open(token);
      if (!lease) return { status: "not_claimed" };
      let claimed: EventCollectionProgress | null = null;
      const store: EventCollectionStore = {
        async load(ref) {
          const value = await options.db.rpc("claim_event_collection", {
            p_provider: ref.provider,
            p_lane: ref.lane,
            p_period: json(ref.period),
            p_worker_run_token: lease.token,
            p_lease_seconds: 180,
          });
          if (value === null) return "not_claimed";
          if (!record(value)) {
            throw new Error(
              "INVALID_EVENT_COLLECTION_PROGRESS",
            );
          }
          claimed = {
            ...value,
            ...(value.cursor === null ? { cursor: undefined } : {}),
          } as unknown as EventCollectionProgress;
          return claimed;
        },
        async commitPage({ progress, events, next }) {
          const result = await options.db.rpc("commit_event_collection_page", {
            p_job_id: progress.jobId,
            p_lease_token: progress.leaseToken,
            p_worker_run_token: lease.token,
            p_expected_next_page: progress.nextPage,
            p_events: events.map(toWireEvent),
            p_preserve_missing: true,
            p_detail_references: json(
              events.filter((event) =>
                options.detailProviders?.has(event.provider)
              ).map((event) => ({
                provider: event.provider,
                lane: "detail",
                sourceId: event.sourceId,
                sourceCollectedAt: event.collectedAt,
                period: {
                  start: seoulCalendarDate(new Date(event.collectedAt)),
                  end: seoulCalendarDate(new Date(event.collectedAt)),
                },
              })),
            ),
            p_next: json(next),
          });
          if (
            !record(result) ||
            !["applied", "lease_lost"].includes(result.status as string)
          ) throw new Error("INVALID_EVENT_COLLECTION_STORE_RESPONSE");
          return result.status as "applied" | "lease_lost";
        },
      };
      const timeout = AbortSignal.timeout(
        Math.max(1, Math.min(60_000, Date.parse(lease.expiresAt) - Date.now())),
      );
      const runSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const settle = async (
        outcome: "yielded" | "provider_failed",
        errorCode: string | null,
        retryable: boolean,
      ) => {
        if (!claimed) throw new Error("INVALID_EVENT_COLLECTION_PROGRESS");
        const result = await options.db.rpc("settle_event_collection", {
          p_job_id: claimed.jobId,
          p_lease_token: claimed.leaseToken,
          p_worker_run_token: lease.token,
          p_outcome: outcome,
          p_error_code: errorCode,
          p_retryable: retryable,
          p_retry_floor_seconds: 600,
          p_retry_cap_seconds: 21600,
        });
        if (
          !record(result) ||
          !["queued", "retry_wait", "failed", "lease_lost"].includes(
            result.status as string,
          )
        ) throw new Error("INVALID_EVENT_COLLECTION_STORE_RESPONSE");
        return result.status as
          | "queued"
          | "retry_wait"
          | "failed"
          | "lease_lost";
      };
      try {
        const result = await runEventCollection({
          reference,
          provider,
          ongoingProvider: options.ongoingProviders?.get(reference.provider),
          store,
          maxPages: options.maxPages,
          providerMaxPage: options.providerMaxPages?.get(reference.provider) ??
            options.providerMaxPage,
          signal: runSignal,
        });
        if (result.status === "partial") {
          const status = await settle(
            result.reason === "PROVIDER_PAGE_LIMIT"
              ? "provider_failed"
              : "yielded",
            result.reason ?? null,
            false,
          );
          if (status === "lease_lost") {
            return { ...result, status: "lease_lost" as const };
          }
          if (status === "failed") {
            return { ...result, status: "failed" as const };
          }
        }
        return result;
      } catch (error) {
        if (!claimed) throw error;
        const timedOut = exhaustedWorkerBudget(runSignal);
        const providerError = error instanceof EventProviderError
          ? error
          : null;
        const outcome = timedOut ? "yielded" : "provider_failed",
          code = timedOut
            ? null
            : providerError?.code ?? "EVENT_COLLECTION_UNAVAILABLE";
        const status = await settle(
          outcome,
          code,
          timedOut ? false : providerError?.retryable ?? false,
        );
        return {
          status: status === "retry_wait"
            ? "retry_wait"
            : status === "lease_lost"
            ? "lease_lost"
            : status === "queued"
            ? "partial"
            : "failed",
          pages: 0,
          fetchedCount: 0,
        };
      } finally {
        await scope.close(lease);
      }
    },
    /** 내부 조립용 배정 한도. 공유 단위를 작업 수로 변환하는 책임은 승인된 호출자 계약에 있다.
     * HTTP body를 확장하지 않으며 기본 실행 한도(10작업/60초)를 늘리지 않는다. */
    async worker(token?: string, signal?: AbortSignal, execution?: { maxJobsPerRun: number; timeBudgetMs: number }) {
      if (execution && (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token) || !Number.isSafeInteger(execution.maxJobsPerRun) || execution.maxJobsPerRun < 0 ||
        !Number.isSafeInteger(execution.timeBudgetMs) || execution.timeBudgetMs < 0)) throw new Error("INVALID_EVENT_WORKER_LIMITS");
      const maxJobs = Math.min(10, execution?.maxJobsPerRun ?? 10);
      const timeBudget = Math.min(60_000, execution?.timeBudgetMs ?? 60_000);
      const empty = (stopReason: string) => ({ status: "ran" as const, stopReason, hasMore: true,
        counts: { claimed: 0, succeeded: 0, yielded: 0, deferred: 0, retryWait: 0, failed: 0, superseded: 0, leaseLost: 0 } });
      if (maxJobs === 0) return empty("max_jobs");
      if (timeBudget === 0 || signal?.aborted) return empty("time_budget");
      const started = performance.now();
      if (!await ready("collection")) return unavailable();
      if (signal?.aborted || performance.now() - started >= timeBudget) return empty("time_budget");
      const scope = createWorkerRunScope(options.db),
        lease = await scope.open(token);
      if (!lease) {
        return { status: "not_enabled", reason: "WORKER_ALREADY_RUNNING" };
      }
      const counts = {
        claimed: 0,
        succeeded: 0,
        yielded: 0,
        deferred: 0,
        retryWait: 0,
        failed: 0,
        superseded: 0,
        leaseLost: 0,
      };
      const timeout = AbortSignal.timeout(
          Math.max(
            1,
            Math.floor(Math.min(timeBudget - (performance.now() - started), Date.parse(lease.expiresAt) - Date.now())),
          ),
        ),
        runSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const seen: EventCollectionReference[] = [];
      let stopReason = "idle", hasMore = false;
      try {
        while (counts.claimed < maxJobs && performance.now() - started < timeBudget) {
          if (runSignal.aborted) {
            stopReason = "time_budget";
            hasMore = true;
            break;
          }
          const raw = await options.db.rpc("next_event_collection_reference", {
            p_worker_run_token: lease.token,
            p_excluded_references: json(seen),
          });
          if (runSignal.aborted) { stopReason = "time_budget"; hasMore = true; break; }
          if (raw === null) break;
          if (
            !record(raw) || typeof raw.provider !== "string" ||
            ![
              "initial_history",
              "future",
              "ongoing",
              "ranking_all",
              "ranking_musical",
              "detail",
            ].includes(
              raw.lane as string,
            ) || !record(raw.period) || typeof raw.period.start !== "string" ||
            typeof raw.period.end !== "string"
          ) throw new Error("INVALID_EVENT_COLLECTION_PROGRESS");
          const reference = raw as unknown as EventCollectionReference;
          if (
            seen.some((r) =>
              r.provider === reference.provider && r.lane === reference.lane &&
              r.period.start === reference.period.start &&
              r.period.end === reference.period.end &&
              r.sourceId === reference.sourceId &&
              r.sourceCollectedAt === reference.sourceCollectedAt
            )
          ) throw new Error("INVALID_EVENT_COLLECTION_PROGRESS");
          seen.push(reference);
          const result = await operations.collect(
            reference,
            lease.token,
            runSignal,
          );
          if (execution && runSignal.aborted) throw new Error("EVENT_WORKER_OUTCOME_UNKNOWN");
          if (result.status === "not_enabled") {
            stopReason = "dependency_unavailable";
            hasMore = true;
            continue;
          }
          if (result.status === "not_claimed") continue;
          counts.claimed++;
          if (result.status === "complete") counts.succeeded++;
          else if (result.status === "partial") {
            counts.yielded++;
            hasMore = true;
          } else if (result.status === "retry_wait") counts.retryWait++;
          else if (result.status === "failed") counts.failed++;
          else if (result.status === "superseded") counts.superseded++;
          else counts.leaseLost++;
        }
        if (counts.claimed >= maxJobs) {
          stopReason = "max_jobs";
          hasMore = true;
        } else if (performance.now() - started >= timeBudget) {
          stopReason = "time_budget";
          hasMore = true;
        }
        return { status: "ran", stopReason, hasMore, counts };
      } finally {
        await scope.close(lease);
      }
    },
    /** 내부 수동 요청도 같은 영속 작업 점유/원자 완료 경로를 거친다. 성공한 작업을 다시 수집하지 않는다. */
    async ranking(mode: KopisRankingMode, signal?: AbortSignal) {
      return collectRanking(
        {
          provider: "kopis",
          lane: mode === "all" ? "ranking_all" : "ranking_musical",
          period: kopisRankingPeriod(options.now()),
        },
        undefined,
        signal,
      );
    },
    /** 수동 상세 요청도 등록만 수행한다. 실제 수집은 같은 영속 worker에서 점유한다. */
    async detail(provider: string, sourceId: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (
        !["kopis", "tour-api"].includes(provider) ||
        !(provider === "kopis" ? /^PF[0-9A-Za-z]+$/ : /^\d{1,20}$/).test(
          sourceId,
        )
      ) {
        throw new Error("INVALID_EVENT_DETAIL_REFERENCE");
      }
      if (
        !await ready("detail_jobs") || !await ready("collection_details") ||
        !options.detailProviders?.has(provider)
      ) return { status: "not_enabled", reason: "DETAIL_JOBS_NOT_CONNECTED" };
      const result = await options.db.rpc("register_event_collection_jobs", {
        p_provider: provider,
        p_registered_on: seoulCalendarDate(options.now()),
        p_references: [],
        p_detail_provider: true,
        p_detail_source_ids: [sourceId],
      });
      if (!record(result) || result.status !== "registered") {
        throw new Error("INVALID_EVENT_DETAIL_REGISTRATION");
      }
      return {
        status: "registered",
        createdCount: result.createdCount,
        existingCount: result.existingCount,
      };
    },
  };
  return operations;
}

/** 저장된 진행 중 원천 ID를 별도 keyset으로 읽고 KOPIS 상세에서 실제 종료 변경도 갱신한다. */
export function createKopisOngoingProvider(
  db: RpcClient,
  details: KopisDetailProviderPort,
): EventProviderPort {
  return createStoredOngoingProvider(db, details);
}

export function createStoredOngoingProvider(
  db: RpcClient,
  details: KopisDetailProviderPort,
): EventProviderPort {
  if (!["kopis", "tour-api"].includes(details.provider)) {
    throw new Error("INVALID_EVENT_PROVIDER");
  }
  return {
    provider: details.provider,
    async fetchPage(request) {
      request.signal?.throwIfAborted();
      const raw = await db.rpc("list_ongoing_event_source_ids", {
        p_provider: details.provider,
        p_cursor: request.cursor ?? null,
        p_limit: 10,
      });
      if (
        !record(raw) || !Array.isArray(raw.sourceIds) ||
        raw.sourceIds.length > 10 ||
        raw.sourceIds.some((id) =>
          typeof id !== "string" ||
          !(details.provider === "kopis" ? /^PF[0-9A-Za-z]+$/ : /^\d{1,20}$/)
            .test(id)
        ) || new Set(raw.sourceIds).size !== raw.sourceIds.length ||
        (raw.nextCursor !== null &&
          (typeof raw.nextCursor !== "string" || !raw.nextCursor))
      ) throw new Error("INVALID_EVENT_COLLECTION_PAGE");
      const events = [];
      for (const id of raw.sourceIds) {
        request.signal?.throwIfAborted();
        events.push(
          await details.fetchSourceEvent(id as string, request.signal),
        );
      }
      return {
        events,
        ...(raw.nextCursor !== null
          ? { nextCursor: raw.nextCursor as string }
          : {}),
      };
    },
  };
}
