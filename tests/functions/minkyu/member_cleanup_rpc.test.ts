/** 민규: 실제 DB가 아닌 전용 cleanup HTTP transport 계약 검증. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { createMemberCleanupPorts, createMemberCleanupAckRecoveryPorts, createMemberCleanupRecoveryReader } from "../../../backend/supabase/functions/_shared/db/repositories/member-cleanup.ts";
import { createPublicClient } from "../../../backend/supabase/functions/_shared/db/public-client.ts";
import { createInternalClient } from "../../../backend/supabase/functions/_shared/db/internal-client.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
const values: Record<string, string> = { SUPABASE_URL: "https://cleanup.example.invalid", SUPABASE_ANON_KEY: "fixture-anon",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service", INTERNAL_WORKER_SECRET: "fixture_worker_secret_longer_than_32_characters",
  ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "1000" };
const config = loadRuntimeConfig(key => values[key]);
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fence = { taskId: id, leaseToken: id, workerRunToken: id, objectId: null };
test("cleanup 전용포트는 고정6개 RPC에 전역·작업토큰과 hash만 전달한다", async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const ports = createMemberCleanupPorts(config, async (url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer fixture-service");
    assert.equal(headers.get("apikey"), "fixture-service");
    calls.push({ name: String(url).split("/").at(-1)!, args: JSON.parse(init!.body as string) });
    return new Response("null");
  });
  await ports.claim(id);await ports.assertCurrent(fence);await ports.getDeleteAck(fence);await ports.beginDelete!(fence);
  await ports.recordDeleteAck({ ...fence, ackSha256: "a".repeat(64) });
  await ports.complete({ ...fence, evidenceSha256: "b".repeat(64) });
  const args = { p_task_id: id, p_lease_token: id, p_worker_run_token: id, p_object_id: null };
  assert.deepEqual(calls, [
    { name: "claim_member_cleanup_task", args: { p_worker_run_token: id } },
    { name: "check_member_cleanup_task", args }, { name: "get_member_cleanup_delete_ack", args },
    { name: "begin_member_cleanup_delete", args },
    { name: "record_member_cleanup_delete_ack", args: { ...args, p_ack_sha256: "a".repeat(64) } },
    { name: "complete_member_cleanup_task", args: { ...args, p_evidence_sha256: "b".repeat(64) } },
  ]);
  assert.equal(Object.isFrozen(ports), true);
  assert.deepEqual(Object.keys(ports).sort(), ["assertCurrent", "beginDelete", "claim", "complete", "getDeleteAck", "recordDeleteAck"].sort());
});
test("DB guard·ACL 닫힘을 cleanup 성공으로 대체하지 않는다", async () => {
  const ports = createMemberCleanupPorts(config, async () => new Response(JSON.stringify({ code: "42501", message: "private SQL detail" }), { status: 403 }));
  for (const call of [() => ports.claim(id), () => ports.getDeleteAck(fence), () => ports.complete({ ...fence, evidenceSha256: "a".repeat(64) })]) {
    await assert.rejects(call, (error: unknown) => toPublicError(error).error.code === "ACCESS_DENIED");
  }
});
test("삭제 연결 설정이 없으면 네트워크 전에 중단한다", () => {
  let calls = 0;
  const missing = loadRuntimeConfig(key => key === "SUPABASE_SERVICE_ROLE_KEY" ? undefined : values[key]);
  assert.throws(() => createMemberCleanupPorts(missing, async () => { calls++;return new Response("null"); }));
  assert.equal(calls, 0);
});

test("공개·기존 일반 내부 클라이언트로 삭제 RPC를 우회할 수 없다", async () => {
  let calls = 0;
  const fetcher = async () => { calls++;return new Response("null"); };
  for (const db of [createPublicClient(config, fetcher), createInternalClient(config, fetcher)]) {
    for (const name of ["claim_member_cleanup_task", "check_member_cleanup_task", "get_member_cleanup_delete_ack",
      "record_member_cleanup_delete_ack", "complete_member_cleanup_task", "begin_member_cleanup_delete"]) {
      assert.equal(db.supportsRpc!(name), false);
      await assert.rejects(() => db.rpc(name, {}), (error: unknown) => toPublicError(error).error.code === "ACCESS_DENIED");
    }
  }
  assert.equal(calls, 0);
});

test("ACK 복구 전용포트는 원 task 점유만 요청하고 신규 DELETE·ACK 기록은 전송 전 차단한다", async () => {
  const calls: Array<{name:string;args:unknown}> = [];
  const ports = createMemberCleanupAckRecoveryPorts(config, id, async (url, init) => {
    calls.push({name:String(url).split("/").at(-1)!,args:JSON.parse(init!.body as string)});return new Response("null");
  });
  await ports.claim(id);
  assert.deepEqual(calls,[{name:"claim_member_cleanup_ack_recovery",args:{p_task_id:id,p_worker_run_token:id}}]);
  await assert.rejects(ports.beginDelete!(fence));await assert.rejects(ports.recordDeleteAck({...fence,ackSha256:"a".repeat(64)}));
  assert.equal(calls.length,1);
});
test("최소 복구 조회는 입력을 검증하고 점유·삭제 RPC를 호출하지 않는다", async () => {
  const calls:string[]=[];
  const read=createMemberCleanupRecoveryReader(config,async url=>{calls.push(String(url).split("/").at(-1)!);return new Response("[]");});
  assert.throws(()=>read(id,101));assert.throws(()=>read("invalid",20));assert.equal(calls.length,0);
  assert.deepEqual(await read(null,20),[]);assert.deepEqual(calls,["read_member_cleanup_recovery"]);
});
