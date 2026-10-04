/**
 * 종현: 24시간 주기 실행 묶음(설계 5.6). 한 번의 호출에서 단계별로 독립 실행하고 결과를 단계별 상태로 반환한다.
 *   1) 후기 공개 정리 + 새 요약 작업 등록(기존 maintenance, 모델 설정과 무관하게 공개 실행)
 *   2) 행사 갱신: 영속 수집 등록·진행 저장 포트로 초기 과거/미래/진행 중을 처리
 *   3) 요약 worker: 등록 직후 한 번 호출. 남은 due 작업은 별도 background runner가 처리
 * 실행 시각·시간대 등록(cron)은 운영 설정이며 이 모듈은 주기를 만들지 않는다. 수치는 모두 명시 환경값이다.
 * 중복 방지는 각 단계의 DB 계약이 맡는다(작업 dedupe 키, 행사 제공처+원천 ID upsert, 작업 점유).
 */
import type { JsonValue } from "../contracts/common.ts";
import type { EnvReader } from "../config/env.ts";
import { toPublicError } from "../http/errors.ts";
import { requiredPositiveInt, SettingError } from "./settings.ts";

/** 설정 변수 이름(값은 서버 환경에서만 주입). 기본값 없음. */
export const DAILY_ENV = {
  eventProviders: "EVENT_SYNC_DAILY_PROVIDERS",
  eventTimeZone: "EVENT_SYNC_DAILY_TIME_ZONE",
  eventWindowDays: "EVENT_SYNC_DAILY_WINDOW_DAYS",
  eventMaxPages: "EVENT_SYNC_DAILY_MAX_PAGES",
  eventTimeoutMs: "EVENT_SYNC_DAILY_TIMEOUT_MS",
  summaryMaxInvocations: "DAILY_SUMMARY_WORKER_MAX_INVOCATIONS",
  summaryTimeoutMs: "DAILY_SUMMARY_WORKER_TIMEOUT_MS",
} as const;
const PROVIDER = /^[a-z0-9-]{1,32}$/;

/** timeoutMs: 호출 한 번의 HTTP 대기 한도. worker는 자체 실행 시간 한도보다 길게 설정해야 결과를 받는다. */
export interface EventDailySettings { providers: string[]; timeZone: string; windowDays: number; maxPages: number; timeoutMs: number }
export interface DailySettings {
  events: EventDailySettings | "not_configured" | "configuration_error";
  summaryWorker: { maxInvocations: number; timeoutMs: number } | "not_configured" | "configuration_error";
}
function raw(read: EnvReader, key: string): string | undefined | null {
  try { const value = read(key); return value === "" ? undefined : value; } catch { return null; }
}
export function loadDailySettings(read: EnvReader): DailySettings {
  let events: DailySettings["events"];
  const providers = raw(read, DAILY_ENV.eventProviders);
  if (providers === undefined) events = "not_configured";
  else {
    try {
      if (providers === null) throw new SettingError();
      const list = providers.split(",");
      if (!list.length || list.some((item) => !PROVIDER.test(item)) || new Set(list).size !== list.length) throw new SettingError();
      const timeZone = raw(read, DAILY_ENV.eventTimeZone);
      if (typeof timeZone !== "string" || timeZone.length > 64) throw new SettingError();
      // 잘못된 IANA 시간대는 RangeError. 기본 시간대로 대체하지 않는다.
      new Intl.DateTimeFormat("en-CA", { timeZone });
      events = {
        providers: list, timeZone,
        windowDays: requiredPositiveInt(read, DAILY_ENV.eventWindowDays, 31),
        maxPages: requiredPositiveInt(read, DAILY_ENV.eventMaxPages, 5),
        timeoutMs: requiredPositiveInt(read, DAILY_ENV.eventTimeoutMs, 15_000),
      };
    } catch { events = "configuration_error"; }
  }
  let summaryWorker: DailySettings["summaryWorker"];
  const invocations = raw(read, DAILY_ENV.summaryMaxInvocations);
  if (invocations === undefined) summaryWorker = "not_configured";
  else {
    try {
      summaryWorker = {
        maxInvocations: requiredPositiveInt(read, DAILY_ENV.summaryMaxInvocations, 1),
        timeoutMs: requiredPositiveInt(read, DAILY_ENV.summaryTimeoutMs, 75_000),
      };
    }
    catch { summaryWorker = "configuration_error"; }
  }
  return { events, summaryWorker };
}

/** 실행 시각의 설정 시간대 날짜부터 windowDays일(시작·종료 포함). 공급사 호출 계약은 YYYY-MM-DD다. */
export function dailyPeriod(now: Date, timeZone: string, windowDays: number): { start: string; end: string } {
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(windowDays) || windowDays < 1) throw new Error("INVALID_DAILY_PERIOD");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const startUtc = Date.UTC(get("year"), get("month") - 1, get("day"));
  if (!Number.isFinite(startUtc)) throw new Error("INVALID_DAILY_PERIOD");
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { start: iso(startUtc), end: iso(startUtc + (windowDays - 1) * 86_400_000) };
}

export interface EventSyncPageResult { status: "synced"; provider: string; fetchedCount: number; savedCount: number; hasMore: boolean }
export type WorkerInvocationResult =
  | { status: "not_enabled"; reason: string }
  | { status: "ran"; stopReason: string; hasMore: boolean; counts: Record<string, number> };
export interface DailyDependencies {
  /** 기존 maintenance 투영 결과({status:"ok"|"partial", ...}). 실패는 예외. */
  maintenance(): Promise<{ status: "ok" | "partial" } & Record<string, JsonValue>>;
  eventSync(input: { provider: string; period: { start: string; end: string }; page: number }, timeoutMs: number): Promise<EventSyncPageResult>;
  invokeSummaryWorker(timeoutMs: number): Promise<WorkerInvocationResult>;
  /** 초기 과거·미래·진행 중 등록/재개와 원자 진행 저장. DB 연결이 없으면 일일 수집을 시작하지 않는다. */
  runEventCollections?(settings: EventDailySettings, now: Date): Promise<Record<string, JsonValue>>;
  now(): Date;
}

type StepStatus = "ok" | "partial" | "failed" | "not_configured" | "configuration_error" | "not_enabled";
const errorCode = (error: unknown) => toPublicError(error).error.code;

async function maintenanceStep(deps: DailyDependencies): Promise<Record<string, JsonValue>> {
  try {
    return { ...(await deps.maintenance()) };
  } catch (error) {
    return { status: "failed", code: errorCode(error) };
  }
}

async function eventsStep(deps: DailyDependencies, settings: DailySettings["events"]): Promise<Record<string, JsonValue>> {
  if (typeof settings === "string") return { status: settings };
  if (!deps.runEventCollections) return { status: "not_enabled", reason: "EVENT_COLLECTION_PERSISTENCE_NOT_CONNECTED" };
  if (settings.timeZone !== "Asia/Seoul" || settings.maxPages < 1 || settings.maxPages > 5 || settings.windowDays > 31 || settings.timeoutMs > 15_000) {
    return { status: "configuration_error" };
  }
  try { return await deps.runEventCollections(settings, deps.now()); }
  catch (error) { return { status: "failed", code: errorCode(error) }; }
}

/** 기존 1페이지 HTTP 수집 도구. 영속 진행 없는 일일 자동 실행에는 쓰지 않는다. */
export async function runEventPages(deps: DailyDependencies, settings: EventDailySettings): Promise<Record<string, JsonValue>> {
  if (settings.timeZone !== "Asia/Seoul" || !Number.isSafeInteger(settings.maxPages) || settings.maxPages < 1 || settings.maxPages > 5 || !Number.isSafeInteger(settings.windowDays) || settings.windowDays < 1 || settings.windowDays > 31) throw new Error("INVALID_EVENT_COLLECTION_SETTINGS");
  const period = dailyPeriod(deps.now(), settings.timeZone, settings.windowDays);
  const providers: JsonValue[] = [];
  let synced = 0, failed = 0;
  for (const provider of settings.providers) {
    let pages = 0, fetchedCount = 0, savedCount = 0, hasMore = true;
    let failure: string | null = null;
    // 공급사별로 명시 최대 페이지까지. hasMore=false면 멈춘다. 실패한 공급사는 다른 공급사 처리를 막지 않는다.
    while (hasMore && pages < settings.maxPages) {
      try {
        const page = await deps.eventSync({ provider, period, page: pages + 1 }, settings.timeoutMs);
        pages += 1; fetchedCount += page.fetchedCount; savedCount += page.savedCount; hasMore = page.hasMore;
      } catch (error) {
        failure = errorCode(error);
        break;
      }
    }
    if (failure) {
      failed += 1;
      providers.push({ provider, status: "failed", code: failure, pages, fetchedCount, savedCount });
    } else {
      synced += 1;
      providers.push({ provider, status: hasMore ? "partial" : "synced", pages, fetchedCount, savedCount, hasMore });
    }
  }
  const status: StepStatus = failed === 0 ? providers.some((item) => (item as Record<string, JsonValue>).hasMore === true) ? "partial" : "ok" : synced === 0 ? "failed" : "partial";
  return { status, period, providers };
}

const COUNT_KEYS = ["claimed", "succeeded", "yielded", "deferred", "retryWait", "failed", "superseded", "leaseLost"] as const;
async function summaryStep(deps: DailyDependencies, settings: DailySettings["summaryWorker"]): Promise<Record<string, JsonValue>> {
  if (typeof settings === "string") return { status: settings };
  if (settings.maxInvocations !== 1 || settings.timeoutMs > 75_000) return { status: "configuration_error" };
  const counts: Record<string, number> = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
  let invocations = 0;
  let stopReason: string | null = null;
  let hasMore = false;
  while (invocations < settings.maxInvocations) {
    let result: WorkerInvocationResult;
    try {
      result = await deps.invokeSummaryWorker(settings.timeoutMs);
    } catch (error) {
      return { status: "failed", code: errorCode(error), invocations: invocations + 1, counts, stopReason };
    }
    invocations += 1;
    if (result.status === "not_enabled") {
      // 전제 미충족(모델·안전 검사·권한). 작업을 점유하지 않았으며 실패로 세지 않는다.
      return invocations === 1
        ? { status: "not_enabled", reason: result.reason }
        : { status: "partial", reason: result.reason, invocations, counts, stopReason };
    }
    for (const key of COUNT_KEYS) counts[key] += result.counts[key];
    stopReason = result.stopReason;
    hasMore = result.hasMore;
    if (!hasMore) break;
  }
  const status: StepStatus = stopReason === "dependency_unavailable" ? "failed" : "ok";
  return { status, invocations, stopReason, hasMore, counts };
}

/**
 * 단계는 서로의 실패와 무관하게 순서대로 실행한다. 공개 정리 실패가 행사·요약을 막지 않으며,
 * 요약·행사 실패가 공개 결과를 되돌리거나 0건 성공으로 바꾸지 않는다.
 */
export async function runDaily(deps: DailyDependencies, settings: DailySettings): Promise<Record<string, JsonValue>> {
  const maintenance = await maintenanceStep(deps);
  const events = await eventsStep(deps, settings.events);
  const summaryWorker = await summaryStep(deps, settings.summaryWorker);
  const statuses = [maintenance.status, events.status, summaryWorker.status] as StepStatus[];
  const executed = statuses.filter((value) => value !== "not_configured" && value !== "not_enabled");
  const problems = executed.filter((value) => value !== "ok");
  const status = problems.length === 0 ? "ok" : problems.every((value) => value === "failed" || value === "configuration_error") &&
    problems.length === executed.length ? "failed" : "partial";
  return { status, maintenance, events, summaryWorker };
}
