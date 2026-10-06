/** 민규: DB 잔여시간 조회 전용 transport와 보수적 host budget 변환. 실제 DB 권한 검증은 별도다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { createMemberCleanupBudgetReader } from "../../../backend/supabase/functions/_shared/db/repositories/member-cleanup.ts";
import { createInternalClient } from "../../../backend/supabase/functions/_shared/db/internal-client.ts";
import { createPublicClient } from "../../../backend/supabase/functions/_shared/db/public-client.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
const values: Record<string, string> = { SUPABASE_URL: "https://cleanup.example.invalid", SUPABASE_ANON_KEY: "fixture-anon",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service", INTERNAL_WORKER_SECRET: "fixture_worker_secret_longer_than_32_characters",
  ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "1000" };
const config = loadRuntimeConfig(key => values[key]);
const token = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const code = (expected: string) => (error: unknown) => toPublicError(error).error.code === expected;
async function clockRun(afterWall: number, afterMonotonic: number, work: (finish: () => void) => Promise<void>) {
  const originalDate = Date.now, originalPerformance = Object.getOwnPropertyDescriptor(performance, "now");
  let finished = false;
  Date.now = () => finished ? afterWall : 1000;
  Object.defineProperty(performance, "now", { configurable: true, value: () => finished ? afterMonotonic : 0 });
  try { await work(() => { finished = true; }); }
  finally {
    Date.now = originalDate;
    if (originalPerformance) Object.defineProperty(performance, "now", originalPerformance);
    else Reflect.deleteProperty(performance, "now");
  }
}
test("잔여시간은 service 전용 단일 RPC로 조회하고 전체 왕복시간을 차감한다", async () => {
  await clockRun(1500, 500, async finish => {
    const read = createMemberCleanupBudgetReader(config, async (url, init) => {
      assert.equal(String(url), "https://cleanup.example.invalid/rest/v1/rpc/read_worker_run_budget");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-service");
      assert.deepEqual(JSON.parse(init!.body as string), { p_worker_run_token: token.toLowerCase() });
      finish(); return new Response(JSON.stringify({ remainingMs: 10000 }));
    });
    const result = await read(token); assert.deepEqual(result, { deadlineAt: 11000 }); assert.ok(Object.isFrozen(result));
    assert.equal(result.deadlineAt! - Date.now(), 9500);
  });
});
test("host 시계가 뒤로 이동해도 실제 잔여시간을 늘리지 않고 앞으로 이동하면 중단한다", async () => {
  await clockRun(500, 500, async finish => {
    const read = createMemberCleanupBudgetReader(config, async () => { finish(); return new Response('{"remainingMs":10000}'); });
    assert.equal((await read(token)).deadlineAt, 10000);
    assert.equal(10000 - Date.now(), 9500);
  });
  await clockRun(30000, 500, async finish => {
    const read = createMemberCleanupBudgetReader(config, async () => { finish(); return new Response('{"remainingMs":10000}'); });
    await assert.rejects(() => read(token), code("STATE_CONFLICT"));
  });
});
test("DB budget은 exact 단일 필드·양의 정수·180초 상한만 인정한다", async () => {
  for (const body of [null, [], {}, { remainingMs: 0 }, { remainingMs: -1 }, { remainingMs: 180001 },
    { remainingMs: 10.5 }, { remainingMs: "1000" }, { remainingMs: 1000, token }]) {
    const read = createMemberCleanupBudgetReader(config, async () => new Response(JSON.stringify(body)));
    await assert.rejects(() => read(token), code("EXTERNAL_UNAVAILABLE"));
  }
  await clockRun(11000, 10000, async finish => {
    const read = createMemberCleanupBudgetReader(config, async () => { finish(); return new Response('{"remainingMs":10000}'); });
    await assert.rejects(() => read(token), code("STATE_CONFLICT"));
  });
});
test("취소된 요청·잘못된 토큰·누락 설정은 네트워크 전에 중단한다", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response('{"remainingMs":1000}'); };
  const read = createMemberCleanupBudgetReader(config, fetcher);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(() => read(token, abort.signal), code("STATE_CONFLICT"));
  await assert.rejects(() => read("bad"), code("INVALID_REQUEST"));
  assert.throws(() => createMemberCleanupBudgetReader(loadRuntimeConfig(key => key === "SUPABASE_SERVICE_ROLE_KEY" ? undefined : values[key]), fetcher));
  assert.equal(calls, 0);
});
test("budget은 내부 허용 목록에만 있으며 공개 RPC로 제공하지 않는다", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response("null"); };
  assert.equal(createInternalClient(config, fetcher).supportsRpc!("read_worker_run_budget"), true);
  for (const db of [createPublicClient(config, fetcher)]) {
    assert.equal(db.supportsRpc!("read_worker_run_budget"), false);
    await assert.rejects(() => db.rpc("read_worker_run_budget", { p_worker_run_token: token }), code("ACCESS_DENIED"));
  }
  assert.equal(calls, 0);
});
test("실행 중 취소는 DB 응답 후에도 성공으로 처리하지 않는다", async () => {
  const abort = new AbortController();
  const read = createMemberCleanupBudgetReader(config, async (_url, init) => {
    assert.ok(init?.signal); abort.abort(); assert.equal(init.signal.aborted, true);
    return new Response('{"remainingMs":1000}');
  });
  await assert.rejects(() => read(token, abort.signal), code("STATE_CONFLICT"));
});
