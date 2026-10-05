/** 민규: 실제 조립 factory·내부 인증·전용 transport 연결. 합성 fetch이며 실제 DB/삭제 증거가 아니다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
const values: Record<string, string> = { SUPABASE_URL: "https://cleanup.example.invalid", SUPABASE_ANON_KEY: "fixture-anon",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service", INTERNAL_WORKER_SECRET: "fixture_worker_secret_longer_than_32_characters",
  ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "1000" };
const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function request(secret = values.INTERNAL_WORKER_SECRET) {
  return new Request("https://cleanup.example.invalid/functions/v1/service-api/internal/member-cleanup", {
    method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-worker-run-token": token }, body: "{}",
  });
}
test("실제 runtime의 명시 옵션은 내부 인증 뒤 budget→기존 cleanup claim을 조립한다", async () => {
  const original = globalThis.fetch, calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    const name = String(url).split("/").at(-1)!; calls.push(name);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-service");
    assert.deepEqual(JSON.parse(init!.body as string), { p_worker_run_token: token });
    assert.ok(["read_worker_run_budget", "claim_member_cleanup_task"].includes(name));
    return new Response(name === "read_worker_run_budget" ? '{"remainingMs":180000}' : "null");
  };
  try {
    const handler = createRuntimeHandler(k => values[k], { memberCleanup: true });
    const result = await handler(request()); assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).data, { status: "ran", claimed: 0, succeeded: 0 });
    assert.deepEqual(calls, ["read_worker_run_budget", "claim_member_cleanup_task"]);
  } finally { globalThis.fetch = original; }
});
test("runtime는 회원·잘못된 내부 비밀을 budget/삭제 RPC 전에 거절한다", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("null"); };
  try {
    const handler = createRuntimeHandler(k => values[k], { memberCleanup: true });
    assert.equal((await handler(request("fixture-member-jwt"))).status, 403);
    assert.equal(calls, 0);
    assert.equal((await createRuntimeHandler(k => values[k])(request())).status, 404);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
test("실제 budget 권한 거절은 성공이나 빈 큐로 대체하지 않으며 claim을 호출하지 않는다", async () => {
  const original = globalThis.fetch, calls: string[] = [];
  globalThis.fetch = async url => {
    calls.push(String(url).split("/").at(-1)!);
    return new Response(JSON.stringify({ code: "42501", message: "private database detail" }), { status: 403 });
  };
  try {
    const result = await createRuntimeHandler(k => values[k], { memberCleanup: true })(request());
    assert.equal(result.status, 403); const body = await result.json(); assert.equal(body.error.code, "ACCESS_DENIED");
    assert.equal(JSON.stringify(body).includes("private database detail"), false);
    assert.deepEqual(calls, ["read_worker_run_budget"]);
  } finally { globalThis.fetch = original; }
});


test("trusted runtime의 로컬 상한은 HTTP 입력 없이 budget만 조회하고60초 미만이면 claim하지 않는다", async () => {
  const original = globalThis.fetch, calls: string[] = [];
  globalThis.fetch = async url => {
    calls.push(String(url).split("/").at(-1)!); return new Response('{"remainingMs":180000}');
  };
  try {
    const handler = createRuntimeHandler(k => values[k], { memberCleanup: true, memberCleanupExecution: { maxExecutionMs: 59000 } });
    const result = await handler(request()); assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).data, { status: "ran", claimed: 0, succeeded: 0 });
    assert.deepEqual(calls, ["read_worker_run_budget"]);
  } finally { globalThis.fetch = original; }
});
