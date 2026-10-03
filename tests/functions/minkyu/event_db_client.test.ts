/** 민규: 행사 RPC의 읽기/쓰기 자격 증명과 실패 경계를 검증한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { requirePrincipal } from "../../../backend/supabase/functions/_shared/auth/principal.ts";
import { createPublicClient } from "../../../backend/supabase/functions/_shared/db/public-client.ts";
import { createUserClient } from "../../../backend/supabase/functions/_shared/db/user-client.ts";
import { createInternalClient } from "../../../backend/supabase/functions/_shared/db/internal-client.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { FetchLike } from "../../../backend/supabase/functions/_shared/db/transport.ts";

const values: Record<string, string> = {
  SUPABASE_URL: "https://events.example.invalid", SUPABASE_ANON_KEY: "fixture-anon",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service", INTERNAL_WORKER_SECRET: "fixture_worker_secret_longer_than_32_characters",
  ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "1000",
};
const config = loadRuntimeConfig((key) => values[key]);
const token = "fixture.user.signature";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const principal = () => requirePrincipal(new Request("https://app.example.invalid", {
  headers: { Authorization: `Bearer ${token}` },
}), config, async () => json({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "authenticated", is_anonymous: false }));

test("공개 행사 후보 조회는 내부 설정 없이 anon 자격 증명과 명시 필터만 전송한다", async () => {
  const publicConfig = loadRuntimeConfig((key) => /SERVICE_ROLE|WORKER_SECRET/.test(key) ? undefined : values[key]);
  const client = createPublicClient(publicConfig, async (url, init) => {
    assert.equal(url, `${config.supabaseUrl}/rest/v1/rpc/list_event_candidates_v1`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), "fixture-anon");
    assert.equal(headers.get("authorization"), "Bearer fixture-anon");
    assert.equal(init?.body, JSON.stringify({ p_region: "서울", p_category: null }));
    assert.equal(init?.redirect, "error");
    return json([]);
  });
  assert.deepEqual(await client.rpc("list_event_candidates_v1", { p_region: "서울", p_category: null }), []);
});

test("회원 행사 후보 조회는 검증한 사용자 JWT를 유지한다", async () => {
  const client = createUserClient(config, await principal(), async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    assert.equal(new Headers(init?.headers).get("apikey"), "fixture-anon");
    assert.doesNotMatch(JSON.stringify(init), /fixture-service|fixture_worker/);
    return json([]);
  });
  assert.deepEqual(await client.rpc("list_event_candidates_v1", {}), []);
});

test("익명·회원은 행사 저장을 네트워크 요청 전에 거절한다", async () => {
  let calls = 0;
  const fetcher: FetchLike = async () => { calls++; return json({ savedCount: 1 }); };
  for (const client of [createPublicClient(config, fetcher), createUserClient(config, await principal(), fetcher)]) {
    await assert.rejects(client.rpc("upsert_source_events_v1", { p_events: [] }), (error: unknown) => {
      assert.equal(toPublicError(error).error.code, "ACCESS_DENIED"); return true;
    });
  }
  assert.equal(calls, 0);
});

test("내부 행사 수집은 기존 내부 설정을 요구하며 service 자격 증명만 사용한다", async () => {
  assert.throws(() => createInternalClient({ ...config, internalWorkerSecret: undefined }));
  const client = createInternalClient(config, async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-service");
    assert.equal(new Headers(init?.headers).get("apikey"), "fixture-service");
    assert.doesNotMatch(JSON.stringify(init), /fixture_worker/);
    return json(String(url).endsWith("upsert_source_events_v1") ? { savedCount: 0 } : []);
  });
  assert.deepEqual(await client.rpc("upsert_source_events_v1", { p_events: [] }), { savedCount: 0 });
  assert.deepEqual(await client.rpc("list_event_candidates_v1", {}), []);
});

test("행사 후보 초과·공급 DB 오류는 원문이나 정상 빈 결과로 바꾸지 않는다", async () => {
  for (const status of [400, 500]) {
    const client = createPublicClient(config, async () => json({
      code: "54000", message: "EVENT_CANDIDATE_LIMIT_EXCEEDED private-record fixture-service",
      details: "sensitive-sql",
    }, status));
    await assert.rejects(client.rpc("list_event_candidates_v1", {}), (error: unknown) => {
      const exposed = toPublicError(error);
      assert.equal(exposed.error.code, status === 500 ? "EXTERNAL_UNAVAILABLE" : "INTERNAL_ERROR");
      assert.doesNotMatch(JSON.stringify(exposed), /private-record|fixture-service|sensitive-sql|54000/);
      return true;
    });
  }
});
