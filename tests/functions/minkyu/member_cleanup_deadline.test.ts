/** 민규: 공통 마감·취소 신호 검증. 실제 provider 삭제 증거와 구분한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemberCleanupAdapter, processMemberCleanupTask, type MemberCleanupPorts, type MemberCleanupTask } from "../../../backend/supabase/functions/_shared/auth/member-cleanup.ts";
import { createMemberCleanupPorts } from "../../../backend/supabase/functions/_shared/db/repositories/member-cleanup.ts";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";

const vars: Record<string, string> = { SUPABASE_URL: "https://cleanup.example.invalid", SUPABASE_ANON_KEY: "fixture-anon",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service", INTERNAL_WORKER_SECRET: "fixture-worker-secret-12345678901234567890",
  ALLOWED_ORIGINS: "[]", UPSTREAM_TIMEOUT_MS: "1000", MAX_REQUEST_BYTES: "8192" };
const config = loadRuntimeConfig(k => vars[k]);
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const task = (): MemberCleanupTask => ({ taskId: id, leaseToken: id, profileId: id, kind: "storage_object", bucketId: "profile-images",
  objectId: id, objectName: `${id}/${id}.jpg`, expiresAt: new Date(Date.now() + 60000).toISOString() });
function fixture(value = task()) {
  const events: string[] = [];
  const ports: MemberCleanupPorts = {
    async claim() { events.push("claim"); return value; },
    async assertCurrent() { events.push("check"); return value; },
    async getDeleteAck() { events.push("getAck"); return null; },
    async recordDeleteAck(args) { events.push("ack"); return { receiptId: id, taskId: id, kind: value.kind, objectId: id, evidenceSha256: args.ackSha256 }; },
    async complete() { events.push("complete"); return { status: "applied" }; },
  };
  return { ports, events };
}
const conflict = (e: unknown) => toPublicError(e).error.code === "STATE_CONFLICT";
test("기한이 이미 지났거나 상위 요청이 취소되면 claim조차 하지 않는다", async () => {
  const f = fixture(); let http = 0;
  const adapter = createMemberCleanupAdapter(config, async () => { http++; return new Response("null"); });
  await assert.rejects(processMemberCleanupTask(id, f.ports, adapter, { deadlineAt: Date.now() - 1 }), conflict);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(processMemberCleanupTask(id, f.ports, adapter, { signal: aborted.signal }), conflict);
  assert.deepEqual(f.events, []); assert.equal(http, 0);
});
test("상위 취소가 provider 요청까지 전달되고 삭제·ack·완료를 시작하지 않는다", async () => {
  const f = fixture(), parent = new AbortController(); let requests = 0; let observed: AbortSignal | undefined;
  const adapter = createMemberCleanupAdapter(config, async (_url, init) => {
    requests++; observed = init?.signal as AbortSignal;
    return await new Promise<Response>((_resolve, reject) => {
      observed!.addEventListener("abort", () => reject(new Error("private provider error")), { once: true });
      queueMicrotask(() => parent.abort());
    });
  });
  await assert.rejects(processMemberCleanupTask(id, f.ports, adapter, { signal: parent.signal }), conflict);
  assert.equal(requests, 1); assert.equal(observed?.aborted, true);
  assert.deepEqual(f.events, ["claim", "check", "getAck"]);
});
test("작업 lease가 상위 마감보다 짧으면 대기 중인 DB포트도 그 lease에서 중단한다", async () => {
  const f = fixture(); let observed: AbortSignal | undefined; let http = 0;
  f.ports.claim = async () => ({ ...task(), expiresAt: new Date(Date.now() + 25).toISOString() });
  let claimed: MemberCleanupTask;
  const claim = f.ports.claim;
  f.ports.claim = async (...args) => { claimed = await claim(...args) as MemberCleanupTask; return claimed; };
  f.ports.assertCurrent = async () => claimed;
  f.ports.getDeleteAck = async (_fence, signal) => { observed = signal; return await new Promise(() => {}); };
  const adapter = createMemberCleanupAdapter(config, async () => { http++; return new Response("null"); });
  await assert.rejects(processMemberCleanupTask(id, f.ports, adapter, { deadlineAt: Date.now() + 10000 }), conflict);
  assert.equal(observed?.aborted, true); assert.equal(http, 0); assert.ok(!f.events.includes("complete"));
});
test("전역 점유 마감이 작업 lease보다 짧으면 ack조회 중 종료하며 lease를 연장하지 않는다", async () => {
  const f = fixture(); let observed: AbortSignal | undefined;
  f.ports.getDeleteAck = async (_fence, signal) => { observed = signal; return await new Promise(() => {}); };
  const adapter = createMemberCleanupAdapter(config, async () => { throw new Error("unexpected provider request"); });
  await assert.rejects(processMemberCleanupTask(id, f.ports, adapter, { deadlineAt: Date.now() + 25 }), conflict);
  assert.equal(observed?.aborted, true); assert.deepEqual(f.events, ["claim", "check"]);
});
test("전용 RPC의 실제 fetch에는 상위 signal과 요청별 timeout 취소가 함께 전달된다", async () => {
  const parent = new AbortController(); let observed: AbortSignal | undefined;
  const ports = createMemberCleanupPorts(config, async (_url, init) => {
    observed = init?.signal as AbortSignal;
    return await new Promise<Response>((_resolve, reject) => {
      observed!.addEventListener("abort", () => reject(new Error("private SQL detail")), { once: true });
      queueMicrotask(() => parent.abort());
    });
  });
  await assert.rejects(ports.claim(id, parent.signal), e => toPublicError(e).error.code === "EXTERNAL_UNAVAILABLE");
  assert.equal(observed?.aborted, true);
  let requests = 0;
  const closed = createMemberCleanupPorts(config, async () => { requests++; return new Response("null"); });
  await assert.rejects(closed.claim(id, parent.signal), conflict); assert.equal(requests, 0);
});
test("마감 옵션의 잘못된 값은 작업 접수 전에 거부한다", async () => {
  const f = fixture(), adapter = createMemberCleanupAdapter(config);
  for (const deadlineAt of [NaN, Infinity, 1.5]) {
    await assert.rejects(processMemberCleanupTask(id, f.ports, adapter, { deadlineAt }), e => toPublicError(e).error.code === "INVALID_REQUEST");
  }
  assert.deepEqual(f.events, []);
});

test("시계가 앞으로 이동해 timer가 아직 실행되지 않아도 전역 마감 뒤 삭제하지 않는다", async () => {
  const original = Date.now, start = original();
  const f = fixture({ ...task(), expiresAt: new Date(start + 60000).toISOString() });
  let http = 0;
  f.ports.assertCurrent = async () => {
    Date.now = () => start + 20000;
    return { ...task(), expiresAt: new Date(start + 60000).toISOString() };
  };
  try {
    const adapter = createMemberCleanupAdapter(config, async () => { http++; return new Response("null"); });
    await assert.rejects(processMemberCleanupTask(id, f.ports, adapter, { deadlineAt: start + 15000 }), conflict);
    assert.equal(http, 0); assert.ok(!f.events.includes("ack")); assert.ok(!f.events.includes("complete"));
  } finally { Date.now = original; }
});

test("삭제 응답 유실 후 영속 dispatch가 같은 작업의 재삭제를 차단한다", async () => {
  const f = fixture(); let dispatched = false, deletes = 0;
  f.ports.beginDelete = async () => {
    const alreadyDispatched = dispatched; dispatched = true;
    return { dispatchId: id, alreadyDispatched };
  };
  const adapter = createMemberCleanupAdapter(config, async (_url, init) => {
    if (init?.method === "DELETE") { deletes++; throw new Error("synthetic response loss"); }
    return new Response(JSON.stringify({ id, name: task().objectName, bucket_id: "profile-images" }));
  });
  await assert.rejects(processMemberCleanupTask(id, f.ports, adapter));
  assert.equal(dispatched, true); assert.equal(deletes, 1);
  await assert.rejects(processMemberCleanupTask(id, f.ports, adapter));
  assert.equal(deletes, 1); assert.ok(!f.events.includes("ack")); assert.ok(!f.events.includes("complete"));
});
test("영속 dispatch 포트가 없으면 외부 DELETE를 전송하지 않는다", async () => {
  const f = fixture(); let deletes = 0;
  const adapter = createMemberCleanupAdapter(config, async (_url, init) => {
    if (init?.method === "DELETE") deletes++;
    return new Response(JSON.stringify({ id, name: task().objectName, bucket_id: "profile-images" }));
  });
  await assert.rejects(processMemberCleanupTask(id, f.ports, adapter));
  assert.equal(deletes, 0); assert.ok(!f.events.includes("ack"));
});
