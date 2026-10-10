/** 민규: 내부 허용 능력과 최신 행사 runtime의 외부 호출 전 중단을 검증한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { createInternalClient } from "../../../backend/supabase/functions/_shared/db/internal-client.ts";
import { createPublicClient } from "../../../backend/supabase/functions/_shared/db/public-client.ts";
import { createRpcTransport } from "../../../backend/supabase/functions/_shared/db/transport.ts";
import { createEventOperations, EVENT_RUNTIME_RPCS } from "../../../backend/supabase/functions/_shared/jobs/event-runtime.ts";
import { createWorkerRunScope } from "../../../backend/supabase/functions/_shared/jobs/worker-run.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";

const values: Record<string, string> = {
  SUPABASE_URL: "https://rpc.example.invalid", SUPABASE_ANON_KEY: "fixture-anon",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service", INTERNAL_WORKER_SECRET: "fixture_worker_secret_longer_than_32_characters",
  ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "1000",
};
const config = loadRuntimeConfig((key) => values[key]);
const pending = [
  "complete_event_ranking_collection",
];
const aiRpcs = ["acquire_ai_chat_request", "finish_ai_chat_request", "reserve_ai_chat_model", "reserve_review_summary_model"];
const closedRpcs = ["reserve_ai_budget", "load_public_review_snapshot", "publish_review_summary"];

test("정확한 실행 배정 거절만 충돌이고 다른 준비 오류와 권한 거절은 유지한다", async () => {
  const cases = [
    { status: 400, body: { code: "55000", message: "invocation_not_dispatchable" }, expected: "STATE_CONFLICT" },
    { status: 400, body: { code: "55000" }, expected: "INTERNAL_ERROR" },
    { status: 500, body: { code: "55000", message: "other_dependency" }, expected: "EXTERNAL_UNAVAILABLE" },
    { status: 400, body: { code: "55000", message: "invocation_not_dispatchable " }, expected: "INTERNAL_ERROR" },
    { status: 500, body: { code: "XX000", message: "invocation_not_dispatchable" }, expected: "EXTERNAL_UNAVAILABLE" },
    { status: 403, body: { code: "55000", message: "invocation_not_dispatchable" }, expected: "ACCESS_DENIED" },
    { status: 401, body: { code: "55000", message: "invocation_not_dispatchable" }, expected: "AUTH_REQUIRED" },
  ];
  for (const item of cases) {
    let calls = 0;
    const db = createInternalClient(config, async () => { calls++; return Response.json(item.body, { status: item.status }); });
    await assert.rejects(db.rpc("mark_review_summary_insufficient", {}), (error: unknown) => {
      const result = toPublicError(error);
      assert.equal(result.error.code, item.expected);
      assert.ok(!JSON.stringify(result).includes("invocation_not_dispatchable"));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("실제 내부 허용 목록만 능력으로 선언하고 조회는 네트워크를 호출하지 않는다", () => {
  let calls = 0;
  const db = createInternalClient(config, async () => { calls++; return new Response("null"); });
  assert.equal(db.supportsRpc!("settle_ai_budget"), true);
  assert.equal(db.supportsRpc!("acquire_worker_run"), true);
  assert.equal(db.supportsRpc!("release_worker_run"), true);
  assert.equal(db.supportsRpc!("upsert_events"), true);
  for (const name of EVENT_RUNTIME_RPCS.filter(name => !pending.includes(name))) {
    assert.equal(db.supportsRpc!(name), true, name);
    assert.equal(createPublicClient(config).supportsRpc!(name), false, name);
  }
  for (const name of [...aiRpcs, "prepare_worker_invocation_intent", "execute_worker_invocation_operation", "confirm_worker_runtime_intent", "get_worker_runtime_intent", "get_worker_runtime_operation"]) {
    assert.equal(db.supportsRpc!(name), true, name);
    assert.equal(createPublicClient(config).supportsRpc!(name), false, name);
  }
  for (const name of [...pending, ...closedRpcs, "../upsert_events", "UPsert_events", "upsert_events\n", "create_service_post"]) {
    assert.equal(db.supportsRpc!(name), false, name);
  }
  assert.equal(calls, 0);
  assert.equal(createPublicClient(config).supportsRpc!("upsert_events"), false);
});

test("미연결 신규 RPC는 호출해도 외부 요청 전에 ACCESS_DENIED다", async () => {
  let calls = 0;
  const db = createInternalClient(config, async () => { calls++; return new Response("null"); });
  for (const name of [...pending,...closedRpcs]) {
    await assert.rejects(db.rpc(name, {}), (error: unknown) => toPublicError(error).error.code === "ACCESS_DENIED");
  }
  assert.equal(calls, 0);
});

test("생성 뒤 원본 Set을 수정해 전송 권한을 확대하거나 축소할 수 없다", async () => {
  let calls = 0;
  const names = new Set(["get_public_profile"]);
  const db = createRpcTransport(config, "fixture-anon", "fixture-anon", names,
    async () => { calls++; return new Response("null"); });
  names.add("reserve_ai_chat_model");
  names.delete("get_public_profile");
  assert.equal(db.supportsRpc!("get_public_profile"), true);
  assert.equal(db.supportsRpc!("reserve_ai_chat_model"), false);
  await assert.rejects(db.rpc("reserve_ai_chat_model", {}));
  await db.rpc("get_public_profile", {});
  assert.equal(calls, 1);
});

test("닫힌 행사 계약은 조회만 하고 등록·공급사 호출 전에 중단한다", async () => {
  const calls: string[] = [];
  const db = createInternalClient(config, async (url) => { calls.push(String(url).split("/").at(-1)!); return new Response(JSON.stringify({capabilities:[]})); });
  const operations = createEventOperations({ db, providers: new Map(), providerMaxPage: 10, maxPages: 10,
    now: () => new Date("2026-10-05T00:00:00Z"), rpcAvailable: (name) => db.supportsRpc!(name) });
  const result = await operations.register(["kopis"], 31);
  assert.equal(result.status, "not_enabled");
  assert.deepEqual(calls, ["read_event_collection_contract"]);
});

test("전역 점유 RPC는 내부 자격으로 J 워커 계약을 전달하고 재사용 점유를 해제하지 않는다", async () => {
  const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const calls: Array<{ name: string; args: unknown }> = [];
  const db = createInternalClient(config, async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-service");
    const name = String(url).split("/").at(-1)!;
    calls.push({ name, args: JSON.parse(init?.body as string) });
    return new Response(JSON.stringify(name === "acquire_worker_run"
      ? { token, expiresAt: "2026-10-05T00:03:00Z" } : { status: "applied" }));
  });
  const scope = createWorkerRunScope(db);
  const owned = await scope.open();
  assert.equal(owned?.owned, true);
  const shared = await scope.open(token);
  assert.equal(shared?.owned, false);
  assert.equal(await scope.close(shared!), "applied");
  assert.equal(calls.length, 2);
  assert.equal(await scope.close(owned!), "applied");
  assert.deepEqual(calls, [
    { name: "acquire_worker_run", args: { p_lease_seconds: 180, p_existing_token: null } },
    { name: "acquire_worker_run", args: { p_lease_seconds: 180, p_existing_token: token } },
    { name: "release_worker_run", args: { p_token: token } },
  ]);
});
