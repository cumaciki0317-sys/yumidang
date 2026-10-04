import test from "node:test";
import assert from "node:assert/strict";
import {
  createEventOperations,
  createKopisOngoingProvider,
} from "../../../backend/supabase/functions/_shared/jobs/event-runtime.ts";
import { createEventSyncRuntime } from "../../../backend/supabase/functions/event-sync/index.ts";
const token = "00000000-0000-4000-8000-000000000001";
const reference = {
  provider: "kopis",
  lane: "future",
  period: { start: "2026-10-05", end: "2026-11-04" },
};
const now = new Date("2026-10-05T00:01:00Z");
function fixture() {
  let page = 6, complete = false;
  const calls = [], fetched = [];
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      switch (name) {
        case "read_event_collection_contract":
          return {
            version: "2026-10-05",
            capabilities: [
              "collection",
              "rankings",
              "details",
              "detail_jobs",
              "collection_details",
            ],
          };
        case "acquire_worker_run":
          return { token, expiresAt: "2099-01-01T00:00:00Z" };
        case "release_worker_run":
          return { status: "applied" };
        case "register_event_collection_jobs":
          return {
            status: "registered",
            createdCount: 3,
            existingCount: 0,
            initialHistory: "registered",
          };
        case "next_event_collection_reference":
          return complete || args.p_excluded_references.length
            ? null
            : reference;
        case "claim_event_collection":
          return {
            ...reference,
            jobId: token,
            leaseToken: token,
            nextPage: page,
            collectedPages: 5,
            cursor: String(page),
          };
        case "commit_event_collection_page":
          if (args.p_next) page = args.p_next.page;
          else complete = true;
          return { status: "applied" };
        case "store_verified_kopis_top10_snapshot":
        case "store_event_source_detail":
          return { status: "applied" };
        default:
          throw new Error("UNEXPECTED_RPC");
      }
    },
  };
  const provider = {
    provider: "kopis",
    async fetchPage(input) {
      fetched.push(input.page);
      return {
        events: [],
        ...(input.page < 7 ? { nextCursor: String(input.page + 1) } : {}),
      };
    },
  };
  const operations = createEventOperations({
    db,
    providers: new Map([["kopis", provider]]),
    providerMaxPage: 999,
    maxPages: 5,
    now: () => now,
    rankingProvider: {
      async collect() {
        return {
          mode: "all",
          periodVerification: "verified",
          requestedPeriod: { start: "2026-09-28", end: "2026-10-04" },
          responsePeriod: { start: "2026-09-28", end: "2026-10-04" },
          collectedAt: now.toISOString(),
          items: [],
        };
      },
    },
    detailProviders: new Map([["kopis", {
      provider: "kopis",
      async fetchDetail(sourceId) {
        return {
          provider: "kopis",
          sourceId,
          collectedAt: now.toISOString(),
          admission: { kind: "unknown" },
          operatingInfo: null,
          description: null,
          posterUrl: null,
        };
      },
    }]]),
  });
  return { db, operations, calls, fetched };
}
test("실RPC 계약 없으면 원천 전에 안전 중단", async () => {
  let external = 0;
  const operations = createEventOperations({
    db: {
      async rpc() {
        throw new Error("DB_RPC_NOT_ALLOWED");
      },
    },
    providers: new Map([["kopis", {
      provider: "kopis",
      async fetchPage() {
        external++;
      },
    }]]),
    providerMaxPage: 999,
    maxPages: 5,
    now: () => now,
  });
  assert.equal(
    (await operations.register(["kopis"], 31)).status,
    "not_enabled",
  );
  assert.equal((await operations.collect(reference)).status, "not_enabled");
  assert.equal(external, 0);
});
test("영속6쪽 재개와 원자 페이지 커밋에 전역 token 전달", async () => {
  const f = fixture();
  assert.equal((await f.operations.collect(reference)).status, "complete");
  assert.deepEqual(f.fetched, [6, 7]);
  const commits = f.calls.filter((c) =>
    c[0] === "commit_event_collection_page"
  );
  assert.equal(commits[0][1].p_expected_next_page, 6);
  assert.equal(commits[0][1].p_worker_run_token, token);
  assert.equal(commits[1][1].p_next, null);
});
test("등록/실행/공식순위/원천상세는 실제 RPC로 연결되며 큐 worker집계는 실제 처리수", async () => {
  const f = fixture();
  assert.equal((await f.operations.register(["kopis"], 31)).createdCount, 3);
  const result = await f.operations.worker();
  assert.equal(result.status, "ran");
  assert.equal(result.counts.claimed, 1);
  assert.equal(result.counts.succeeded, 1);
  assert.equal((await f.operations.ranking("all")).status, "not_enabled");
  assert.equal(
    (await f.operations.detail("kopis", "PF1")).status,
    "registered",
  );
  assert.equal(
    f.calls.some((c) => c[0] === "store_verified_kopis_top10_snapshot"),
    false,
  );
  assert.equal(
    f.calls.some((c) => c[0] === "store_event_source_detail"),
    false,
  );
  assert.deepEqual(
    f.calls.filter((c) => c[0] === "register_event_collection_jobs").at(-1)[1]
      .p_detail_source_ids,
    ["PF1"],
  );
});
test("진행 중은 저장원천ID를 별도 조회한 후 실제 상세를 갱신한다", async () => {
  const ids = [];
  const provider = createKopisOngoingProvider({
    async rpc(name, args) {
      assert.equal(name, "list_ongoing_event_source_ids");
      assert.equal(args.p_limit, 10);
      return { sourceIds: ["PF1", "PF2"], nextCursor: null };
    },
  }, {
    provider: "kopis",
    async fetchSourceEvent(id) {
      ids.push(id);
      return { sourceId: id };
    },
  });
  const result = await provider.fetchPage({ page: 1 });
  assert.deepEqual(ids, ["PF1", "PF2"]);
  assert.equal(result.events.length, 2);
});
test("event-sync 등록 HTTP는 인증 먼저, 실제 버전 확인→등록 RPC까지 연결", async () => {
  const f = fixture(), secret = "s".repeat(40);
  const env = {
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_ANON_KEY: "synthetic-anon",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-service",
    INTERNAL_WORKER_SECRET: secret,
    UPSTREAM_TIMEOUT_MS: "1000",
    MAX_REQUEST_BYTES: "4096",
    ALLOWED_ORIGINS: "[]",
    KOPIS_API_KEY: "SYNTHETIC",
    EVENT_SYNC_PROVIDERS: "kopis",
    EVENT_SYNC_MAX_PERIOD_DAYS: "31",
    EVENT_SYNC_MAX_PAGE: "999",
    EVENT_SYNC_PAGE_ROWS: "100",
  };
  const handler = createEventSyncRuntime((k) => env[k], async () => {
    throw new Error("EXTERNAL_NOT_EXPECTED");
  }, { createRpcClient: () => f.db, rpcAvailable: () => true, now: () => now });
  const request = (authorization = secret) =>
    new Request("http://localhost/functions/v1/event-sync/register", {
      method: "POST",
      headers: {
        authorization: "Bearer " + authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ providers: ["kopis"], maxPeriodDays: 31 }),
    });
  assert.equal((await handler(request("invalid"))).status, 403);
  assert.equal(f.calls.length, 0);
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, "registered");
  assert.equal(f.calls[0][0], "read_event_collection_contract");
});

test("실제 공급사 실패는 원문 없는 코드로 DB 재시도 전이에 전달하며 페이지는 전진하지 않는다", async () => {
  const { EventProviderError } = await import(
    "../../../backend/supabase/functions/_shared/integrations/events/port.ts"
  );
  const calls = [];
  const f = fixture();
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === "settle_event_collection") return { status: "retry_wait" };
      return f.db.rpc(name, args);
    },
  };
  const operations = createEventOperations({
    db,
    providers: new Map([["kopis", {
      provider: "kopis",
      async fetchPage() {
        throw new EventProviderError("SOURCE_UNAVAILABLE");
      },
    }]]),
    providerMaxPage: 999,
    maxPages: 5,
    now: () => now,
  });
  const result = await operations.collect(reference);
  assert.equal(result.status, "retry_wait");
  const settled = calls.find((c) => c[0] === "settle_event_collection")[1];
  assert.equal(settled.p_error_code, "SOURCE_UNAVAILABLE");
  assert.equal(settled.p_retryable, true);
  assert.equal(settled.p_retry_floor_seconds, 600);
  assert.equal(settled.p_retry_cap_seconds, 21600);
  assert.equal(
    calls.some((c) => c[0] === "commit_event_collection_page"),
    false,
  );
});

test("Top10 전체/뮤지컬을 고정7일 별도작업으로 등록하고 실패모드만 재시도한다", async () => {
  const { EventProviderError } = await import(
    "../../../backend/supabase/functions/_shared/integrations/events/port.ts"
  );
  const period = { start: "2026-09-28", end: "2026-10-04" },
    jobs = ["ranking_all", "ranking_musical"].map((lane, i) => ({
      reference: { provider: "kopis", lane, period },
      jobId: `00000000-0000-4000-8000-00000000000${i + 2}`,
      status: "queued",
    }));
  const calls = [], sourceCalls = [], rankCalls = [];
  let retryEligible = false, failed = false;
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === "read_event_collection_contract") {
        return {
          version: "2026-10-05",
          capabilities: ["collection", "rankings", "ranking_jobs"],
        };
      }
      if (name === "register_event_collection_jobs") {
        return {
          status: "registered",
          createdCount: 2,
          existingCount: 3,
          initialHistory: "already_registered",
        };
      }
      if (name === "acquire_worker_run") {
        return {
          token,
          expiresAt: "2099-01-01T00:00:00Z",
        };
      }
      if (name === "release_worker_run") return { status: "applied" };
      if (name === "next_event_collection_reference") {
        return jobs.find((j) =>
          (j.status === "queued" ||
            retryEligible && j.status === "retry_wait") &&
          !args.p_excluded_references.some((r) => r.lane === j.reference.lane)
        )?.reference ?? null;
      }
      if (name === "claim_event_collection") {
        const job = jobs.find((j) => j.reference.lane === args.p_lane);
        return {
          ...job.reference,
          jobId: job.jobId,
          leaseToken: token,
          nextPage: 1,
          collectedPages: 0,
          cursor: null,
        };
      }
      if (name === "complete_event_ranking_collection") {
        assert.deepEqual(args.p_period, period);
        assert.equal(args.p_worker_run_token, token);
        jobs.find((j) => j.jobId === args.p_job_id).status = "succeeded";
        return { status: "applied" };
      }
      if (name === "settle_event_collection") {
        jobs.find((j) => j.jobId === args.p_job_id).status = "retry_wait";
        return { status: "retry_wait" };
      }
      throw new Error("UNEXPECTED_RPC");
    },
  };
  const rankingProvider = {
    async collect(mode) {
      rankCalls.push(mode);
      if (mode === "musical" && !failed) {
        failed = true;
        throw new EventProviderError("SOURCE_UNAVAILABLE");
      }
      return {
        mode,
        requestedPeriod: period,
        responsePeriod: period,
        periodVerification: "verified",
        collectedAt: now.toISOString(),
        items: [{
          rank: 1,
          sourceId: "PF1",
          title: "가상공연",
          genre: "뮤지컬",
          performancePeriodText: "2026.10.01 ~ 2026.10.10",
          placeName: "가상극장",
          region: "서울특별시",
        }],
      };
    },
  };
  const operations = createEventOperations({
    db,
    providers: new Map([["kopis", {
      provider: "kopis",
      async fetchPage() {
        sourceCalls.push("unexpected");
        throw new Error("NO_RECOLLECTION");
      },
    }]]),
    providerMaxPage: 999,
    maxPages: 5,
    now: () => now,
    rankingProvider,
  });
  await operations.register(["kopis"], 31);
  const registered =
    calls.find((c) => c[0] === "register_event_collection_jobs")[1]
      .p_references;
  assert.equal(registered.length, 5);
  assert.deepEqual(
    registered.filter((r) => r.lane.startsWith("ranking")).map((r) => r.period),
    [period, period],
  );
  const first = await operations.worker();
  assert.equal(first.counts.succeeded, 1);
  assert.equal(first.counts.retryWait, 1);
  assert.deepEqual(rankCalls, ["all", "musical"]);
  retryEligible = true;
  const retry = await operations.worker();
  assert.equal(retry.counts.succeeded, 1);
  assert.deepEqual(rankCalls, ["all", "musical", "musical"]);
  assert.deepEqual(sourceCalls, []);
  assert.equal(
    calls.filter((c) => c[0] === "complete_event_ranking_collection").length,
    2,
  );
});

test("등록집계기간이 지난 Top10은 원천재호출 없이 superseded로 종결하고 신규기간을 오래된 작업에 저장하지 않는다", async () => {
  let external = 0;
  const calls = [];
  const reference = {
    provider: "kopis",
    lane: "ranking_all",
    period: { start: "2026-09-27", end: "2026-10-03" },
  };
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === "read_event_collection_contract") {
        return {
          version: "2026-10-05",
          capabilities: ["collection", "ranking_jobs"],
        };
      }
      if (name === "acquire_worker_run") {
        return { token, expiresAt: "2099-01-01T00:00:00Z" };
      }
      if (name === "release_worker_run") return { status: "applied" };
      if (name === "claim_event_collection") {
        return { ...reference, jobId: token, leaseToken: token };
      }
      if (name === "settle_event_collection") {
        assert.equal(args.p_outcome, "superseded");
        return { status: "superseded" };
      }
      throw new Error("UNEXPECTED_RPC");
    },
  };
  const operations = createEventOperations({
    db,
    providers: new Map([["kopis", { provider: "kopis" }]]),
    providerMaxPage: 999,
    maxPages: 5,
    now: () => now,
    rankingProvider: {
      async collect() {
        external++;
      },
    },
  });
  assert.equal((await operations.collect(reference)).status, "superseded");
  assert.equal(external, 0);
  assert.equal(
    calls.some((c) => c[0] === "complete_event_ranking_collection"),
    false,
  );
});

test("순위 원자완료 SQL capability 미준비이면 점유/공급사 전송 없이 안전 중단", async () => {
  const f = fixture();
  let external = 0;
  const operations = createEventOperations({
    db: f.db,
    providers: new Map([["kopis", { provider: "kopis" }]]),
    providerMaxPage: 999,
    maxPages: 5,
    now: () => now,
    rankingProvider: {
      async collect() {
        external++;
      },
    },
  });
  assert.equal(
    (await operations.collect({
      provider: "kopis",
      lane: "ranking_all",
      period: { start: "2026-09-28", end: "2026-10-04" },
    })).status,
    "not_enabled",
  );
  assert.equal(external, 0);
  assert.equal(f.calls.some((c) => c[0] === "claim_event_collection"), false);
});

test("원자 순위완료 RPC가 client허용목록에서 빠졌으면 capability가 있어도 원천/점유 전에 중단", async () => {
  let calls = 0;
  const operations = createEventOperations({
    db: {
      async rpc() {
        calls++;
        return {
          version: "2026-10-05",
          capabilities: ["collection", "ranking_jobs"],
        };
      },
    },
    rpcAvailable: (name) => name !== "complete_event_ranking_collection",
    providers: new Map([["kopis", { provider: "kopis" }]]),
    providerMaxPage: 999,
    maxPages: 5,
    now: () => now,
    rankingProvider: {
      async collect() {
        throw new Error("NO_EXTERNAL");
      },
    },
  });
  assert.equal(
    (await operations.collect({
      provider: "kopis",
      lane: "ranking_all",
      period: { start: "2026-09-28", end: "2026-10-04" },
    })).status,
    "not_enabled",
  );
  assert.equal(
    calls,
    1,
    "collection 준비만 확인하고 순위 점유·외부 호출은 생략",
  );
});

test("페이지 저장과 상세등록은 단일커밋이고 상세실패만 영속재시도하며 성공목록은 재수집하지 않는다", async () => {
  const { EventProviderError } = await import(
    "../../../backend/supabase/functions/_shared/integrations/events/port.ts"
  );
  const source = {
    provider: "kopis",
    sourceId: "PF123",
    sourceStatus: "active",
    precision: "date",
    startsOn: "2026-10-05",
    endsOn: "2026-11-04",
    title: "합성공연",
    category: "뮤지컬",
    region: "서울특별시",
    placeName: null,
    publicAddress: null,
    admission: { kind: "unknown" },
    sourceUrl: null,
    collectedAt: now.toISOString(),
  };
  const calls = [], jobs = [{ reference, status: "queued" }];
  let pages = 0, details = 0, retry = false;
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === "read_event_collection_contract") {
        return {
          version: "2026-10-05",
          capabilities: ["collection", "collection_details", "detail_jobs"],
        };
      }
      if (name === "acquire_worker_run") {
        return {
          token,
          expiresAt: "2099-01-01T00:00:00Z",
        };
      }
      if (name === "release_worker_run") return { status: "applied" };
      if (name === "next_event_collection_reference") {
        return jobs.find((j) =>
          (j.status === "queued" || retry && j.status === "retry_wait") &&
          !args.p_excluded_references.some((r) =>
            r.lane === j.reference.lane && r.sourceId === j.reference.sourceId
          )
        )?.reference ?? null;
      }
      if (name === "claim_event_collection") {
        const j = jobs.find((j) => j.reference.lane === args.p_lane);
        return {
          ...j.reference,
          jobId: token,
          leaseToken: token,
          nextPage: 1,
          collectedPages: 0,
          cursor: null,
        };
      }
      if (name === "commit_event_collection_page") {
        assert.equal(args.p_preserve_missing, true);
        assert.equal(args.p_detail_references.length, 1);
        jobs[0].status = "succeeded";
        jobs.push({ reference: args.p_detail_references[0], status: "queued" });
        return { status: "applied" };
      }
      if (name === "settle_event_collection") {
        assert.equal(args.p_retry_floor_seconds, 600);
        assert.equal(args.p_worker_run_token, token);
        jobs[1].status = "retry_wait";
        return { status: "retry_wait" };
      }
      if (name === "store_event_source_detail") {
        assert.equal(args.p_source_collected_at, source.collectedAt);
        assert.equal(args.p_worker_run_token, token);
        assert.equal(args.p_preserve_missing, true);
        assert.equal(Object.hasOwn(args.p_detail, "posterUrl"), false);
        assert.equal(Object.hasOwn(args.p_detail, "admission"), false);
        assert.equal(args.p_detail.description, "실제 원천 줄거리");
        jobs[1].status = "succeeded";
        return { status: "applied" };
      }
      throw new Error(name);
    },
  };
  const operations = createEventOperations({
    db,
    providers: new Map([["kopis", {
      provider: "kopis",
      async fetchPage() {
        pages++;
        return { events: [source] };
      },
    }]]),
    detailProviders: new Map([["kopis", {
      provider: "kopis",
      async fetchDetail(sourceId) {
        details++;
        if (details === 1) throw new EventProviderError("SOURCE_UNAVAILABLE");
        return {
          provider: "kopis",
          sourceId,
          collectedAt: now.toISOString(),
          admission: { kind: "unknown" },
          description: "실제 원천 줄거리",
          operatingInfo: null,
          posterUrl: null,
        };
      },
    }]]),
    now: () => now,
    maxPages: 5,
    providerMaxPage: 999,
  });
  const first = await operations.worker();
  assert.equal(first.counts.succeeded, 1);
  assert.equal(first.counts.retryWait, 1);
  assert.equal(first.counts.claimed, 2);
  retry = true;
  const second = await operations.worker();
  assert.equal(second.counts.succeeded, 1);
  assert.equal(pages, 1);
  assert.equal(details, 2);
  assert.equal(jobs[1].status, "succeeded");
});
test("상세작업 capability가 없으면 원천과 점유 모두 차단한다", async () => {
  let requests = 0;
  const operations = createEventOperations({
    db: {
      async rpc(name) {
        assert.equal(name, "read_event_collection_contract");
        return { version: "2026-10-05", capabilities: ["collection"] };
      },
    },
    providers: new Map(),
    detailProviders: new Map([["kopis", {
      provider: "kopis",
      async fetchDetail() {
        requests++;
      },
    }]]),
    now: () => now,
    maxPages: 5,
    providerMaxPage: 999,
  });
  assert.equal(
    (await operations.collect({
      provider: "kopis",
      lane: "detail",
      period: { start: "2026-10-05", end: "2026-10-05" },
      sourceId: "PF123",
      sourceCollectedAt: now.toISOString(),
    })).status,
    "not_enabled",
  );
  assert.equal(requests, 0);
});

for (const lane of ["future", "ranking_all", "detail"]) {
  test(`${lane}: 부모 작업시간 소진은 공급사 영구실패 대신 yielded로 재개하고 실제 취소와 구분한다`, async () => {
    const { EventProviderError } = await import(
      "../../../backend/supabase/functions/_shared/integrations/events/port.ts"
    );
    const ref = lane === "future" ? reference : lane === "ranking_all"
      ? {
        provider: "kopis",
        lane,
        period: { start: "2026-09-28", end: "2026-10-04" },
      }
      : {
        provider: "kopis",
        lane,
        period: { start: "2026-10-05", end: "2026-10-05" },
        sourceId: "PF123",
        sourceCollectedAt: now.toISOString(),
      };
    for (const budget of [true, false]) {
      const calls = [];
      const db = {
        async rpc(name, args) {
          calls.push([name, args]);
          if (name === "read_event_collection_contract") {
            return {
              version: "2026-10-05",
              capabilities: [
                "collection",
                "collection_details",
                "detail_jobs",
                "ranking_jobs",
              ],
            };
          }
          if (name === "acquire_worker_run") {
            return { token, expiresAt: "2099-01-01T00:00:00Z" };
          }
          if (name === "release_worker_run") return { status: "applied" };
          if (name === "claim_event_collection") {
            return {
              ...ref,
              jobId: token,
              leaseToken: token,
              nextPage: 1,
              collectedPages: 0,
              cursor: null,
            };
          }
          if (name === "settle_event_collection") {
            return {
              status: args.p_outcome === "yielded" ? "queued" : "failed",
            };
          }
          throw new Error("MUST_NOT_WRITE_AFTER_ABORT:" + name);
        },
      };
      const abortingSource = async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        throw new EventProviderError(budget ? "SOURCE_TIMEOUT" : "CANCELLED");
      };
      const operations = createEventOperations({
        db,
        providers: new Map([["kopis", {
          provider: "kopis",
          fetchPage: abortingSource,
        }]]),
        rankingProvider: { collect: abortingSource },
        detailProviders: lane === "detail"
          ? new Map([["kopis", {
            provider: "kopis",
            fetchDetail: abortingSource,
          }]])
          : undefined,
        now: () => now,
        maxPages: 5,
        providerMaxPage: 999,
      });
      const controller = new AbortController(),
        signal = budget ? AbortSignal.timeout(5) : controller.signal;
      const cancel = budget ? null : setTimeout(() =>
        controller.abort(
          new DOMException("실제 외부 요청 취소", "AbortError"),
        ), 5);
      try {
        const result = await operations.collect(ref, undefined, signal);
        assert.equal(result.status, budget ? "partial" : "failed");
        const settled = calls.find((c) =>
          c[0] === "settle_event_collection"
        )[1];
        assert.equal(settled.p_outcome, budget ? "yielded" : "provider_failed");
        assert.equal(settled.p_error_code, budget ? null : "CANCELLED");
        assert.equal(settled.p_retryable, false);
        assert.equal(settled.p_worker_run_token, token);
        assert.equal(
          calls.some((c) =>
            [
              "commit_event_collection_page",
              "store_event_source_detail",
              "complete_event_ranking_collection",
            ].includes(c[0])
          ),
          false,
        );
      } finally {
        if (cancel) clearTimeout(cancel);
      }
    }
  });
}
