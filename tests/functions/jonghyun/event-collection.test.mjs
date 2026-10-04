import test from "node:test";
import assert from "node:assert/strict";
import {
  eventCollectionPlan,
  runEventCollection,
} from "../../../backend/supabase/functions/_shared/jobs/event-collection.ts";
const reference = {
  provider: "kopis",
  lane: "future",
  period: { start: "2026-10-05", end: "2026-11-04" },
};
const initial = () => ({
  ...reference,
  jobId: "job",
  leaseToken: "lease",
  nextPage: 1,
  collectedPages: 0,
});
function fixture(total = 7) {
  let progress = initial();
  const seen = [];
  return {
    seen,
    provider: {
      provider: "kopis",
      async fetchPage({ page }) {
        seen.push(page);
        return {
          events: [],
          ...(page < total ? { nextCursor: String(page + 1) } : {}),
        };
      },
    },
    store: {
      async load() {
        return structuredClone(progress);
      },
      async commitPage({ next }) {
        if (next) {
          progress = {
            ...progress,
            nextPage: next.page,
            cursor: next.cursor,
            collectedPages: progress.collectedPages + 1,
          };
        }
        return "applied";
      },
    },
    progress: () => progress,
  };
}
test("최초 과거는 달력1개월, 미래31일, 진행 중 별도 작업", () => {
  const plan = eventCollectionPlan(new Date("2026-03-30T15:01:00Z"), "kopis");
  assert.deepEqual(plan[0].period, { start: "2026-02-28", end: "2026-03-30" });
  assert.deepEqual(plan[1].period, { start: "2026-03-31", end: "2026-04-30" });
  assert.equal(plan[2].lane, "ongoing");
});
test("5쪽 partial 뒤 새 실행은 영속6쪽에서 재개한다", async () => {
  const f = fixture();
  const input = { reference, ...f, maxPages: 5, providerMaxPage: 999 };
  const first = await runEventCollection(input);
  assert.equal(first.status, "partial");
  assert.equal(first.nextPage, 6);
  const second = await runEventCollection(input);
  assert.equal(second.status, "complete");
  assert.deepEqual(f.seen, [1, 2, 3, 4, 5, 6, 7]);
});
test("저장/점유 실패는 페이지를 전진시키지 않는다", async () => {
  const f = fixture();
  await assert.rejects(() =>
    runEventCollection({
      reference,
      ...f,
      store: {
        ...f.store,
        async commitPage() {
          throw new Error("DB_UNAVAILABLE");
        },
      },
      maxPages: 5,
      providerMaxPage: 999,
    })
  );
  assert.equal(f.progress().nextPage, 1);
  const lost = await runEventCollection({
    reference,
    ...f,
    store: {
      ...f.store,
      async commitPage() {
        return "lease_lost";
      },
    },
    maxPages: 5,
    providerMaxPage: 999,
  });
  assert.equal(lost.status, "lease_lost");
  assert.equal(lost.pages, 0);
});
test("영속/진행 중 포트 없으면 0건 완료로 가장하지 않는다", async () => {
  const f = fixture();
  assert.equal(
    (await runEventCollection({
      reference,
      provider: f.provider,
      maxPages: 5,
      providerMaxPage: 999,
    })).status,
    "not_enabled",
  );
  assert.equal(
    (await runEventCollection({
      reference: { ...reference, lane: "ongoing" },
      ...f,
      maxPages: 5,
      providerMaxPage: 999,
    })).reason,
    "ONGOING_PROVIDER_NOT_CONNECTED",
  );
  assert.equal(f.seen.length, 0);
});
test("공급사 절대 상한 도달은 실행5쪽 상한과 별개 partial", async () => {
  const f = fixture(10);
  const r = await runEventCollection({
    reference,
    ...f,
    maxPages: 5,
    providerMaxPage: 3,
  });
  assert.equal(r.reason, "PROVIDER_PAGE_LIMIT");
  assert.equal(r.nextPage, 4);
  assert.deepEqual(f.seen, [1, 2, 3]);
});

test("매일 등록은 DB의 최초 과거 완료 표식을 사용하고 예약 중복 성공을 구분한다", async () => {
  const { registerDailyEventCollections } = await import(
    "../../../backend/supabase/functions/_shared/jobs/event-collection.ts"
  );
  let initialized = false;
  const calls = [];
  const registration = {
    async register(input) {
      calls.push(input);
      const first = !initialized;
      initialized = true;
      return {
        status: "registered",
        createdCount: first ? 3 : 2,
        existingCount: first ? 0 : 1,
        initialHistory: first ? "registered" : "already_registered",
      };
    },
  };
  const input = {
    providers: ["kopis"],
    maxPeriodDays: 31,
    registration,
    now: new Date("2026-10-04T15:01:00Z"),
  };
  assert.equal((await registerDailyEventCollections(input)).createdCount, 3);
  assert.equal(
    (await registerDailyEventCollections({
      ...input,
      now: new Date("2026-10-05T15:01:00Z"),
    })).existingCount,
    1,
  );
  assert.equal(calls[0].registeredOn, "2026-10-05");
  assert.equal(calls[1].registeredOn, "2026-10-06");
  assert.equal(
    (await registerDailyEventCollections({ ...input, registration: undefined }))
      .status,
    "not_enabled",
  );
});
