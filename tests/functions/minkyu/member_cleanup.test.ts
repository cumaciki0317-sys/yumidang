/** 민규: 합성 HTTP 응답만 사용한다. 실제 Storage/Auth 삭제·운영 활성화를 뜻하지 않는다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemberCleanupAdapter, processMemberCleanupTask, type MemberCleanupTask, type MemberCleanupPorts } from "../../../backend/supabase/functions/_shared/auth/member-cleanup.ts";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { HttpError, toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";

const vars: Record<string, string> = { SUPABASE_URL: "https://cleanup.example.invalid", SUPABASE_ANON_KEY: "fixture-anon",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service", ALLOWED_ORIGINS: "[]", UPSTREAM_TIMEOUT_MS: "1000", MAX_REQUEST_BYTES: "8192" };
const config = loadRuntimeConfig((k) => vars[k]);
const profileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const objectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const taskId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const leaseToken = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const runToken = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const objectName = `${profileId}/${objectId}.jpg`;
const task = (): MemberCleanupTask => ({ taskId, leaseToken, expiresAt: new Date(Date.now() + 60000).toISOString(),
  kind: "storage_object", profileId, bucketId: "profile-images", objectName, objectId });
const authTask = (): MemberCleanupTask => ({ ...task(), kind: "auth_user", bucketId: null, objectName: null, objectId: null });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const info = () => ({ id: objectId, name: objectName, bucket_id: "profile-images", metadata: { private: "fixture-private" } });
const unavailable = (e: unknown) => { assert.equal(toPublicError(e).error.code, "EXTERNAL_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(toPublicError(e)), /fixture-|private|aaaaaaaa|bbbbbbbb/); return true; };
function fixture(value: unknown = task(), failingFence = 0) {
  const events: string[] = []; const completed: unknown[] = []; let fences = 0;
  const ports: MemberCleanupPorts = {
    async claim(token) { assert.equal(token, runToken); events.push("claim"); return value; },
    async assertCurrent(fence) { events.push("fence"); assert.deepEqual(fence, { taskId: (value as MemberCleanupTask).taskId, leaseToken: (value as MemberCleanupTask).leaseToken, workerRunToken: runToken,
      objectId: (value as MemberCleanupTask)?.objectId }); if (++fences === failingFence) throw new HttpError("STATE_CONFLICT"); return value; },
    async getDeleteAck() { events.push("getAck"); return null; },
    // 합성 DB가 정확한 원 fence로 최초 dispatch를 허용한 경우만 삭제한다.
    async beginDelete(fence) { events.push("begin"); assert.deepEqual(fence, { taskId: (value as MemberCleanupTask).taskId,
      leaseToken: (value as MemberCleanupTask).leaseToken, workerRunToken: runToken, objectId: (value as MemberCleanupTask).objectId });
      return { dispatchId: runToken, alreadyDispatched: false }; },
    async recordDeleteAck(args) { events.push("recordAck"); return { receiptId: runToken, taskId, kind: (value as MemberCleanupTask).kind,
      objectId: (value as MemberCleanupTask).objectId, evidenceSha256: args.ackSha256 }; },
    async complete(args) { events.push("complete"); completed.push(args); return { status: "applied" }; },
  };
  return { events, completed, ports };
}
function storageFetch(events: string[], responses = [json(info()), json([{ id: objectId, name: objectName }]), json({}, 404)]): typeof fetch {
  let n = 0;
  return async (url, init) => {
    events.push(`http${++n}`);
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-service");
    assert.equal(new Headers(init?.headers).get("apikey"), "fixture-service");
    assert.equal(url, config.supabaseUrl + [
      `/storage/v1/object/info/authenticated/profile-images/${objectName}`,
      "/storage/v1/object/profile-images",
      `/storage/v1/object/authenticated/profile-images/${objectName}`,
    ][n - 1]);
    assert.equal(init?.method, n === 2 ? "DELETE" : "GET");
    if (n === 2) assert.deepEqual(JSON.parse(String(init?.body)), { prefixes: [objectName] });
    else assert.equal(init?.body, undefined);
    return responses[n - 1];
  };
}

test("Storage 정확 객체 삭제·durable ack·404·네 번 fence 후 5인자 완료 증거만 기록한다", async () => {
  const f = fixture(); const adapter = createMemberCleanupAdapter(config, storageFetch(f.events));
  assert.deepEqual(await processMemberCleanupTask(runToken, f.ports, adapter), { status: "applied" });
  assert.deepEqual(f.events, ["claim", "fence", "getAck", "http1", "fence", "begin", "http2", "fence", "recordAck", "http3", "fence", "complete"]);
  const evidence = f.completed[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(evidence).sort(), ["taskId", "leaseToken", "workerRunToken", "objectId", "evidenceSha256"].sort());
  assert.match(String(evidence.evidenceSha256), /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(evidence), /profile-images|\.jpg|fixture-|metadata/);
});

test("Auth 정확 UID hard delete 후 GET404만 완료한다", async () => {
  const f = fixture(authTask()); let calls = 0;
  const adapter = createMemberCleanupAdapter(config, async (url, init) => {
    assert.equal(url, `${config.supabaseUrl}/auth/v1/admin/users/${profileId}`);
    if (++calls === 1) { assert.equal(init?.method, "GET"); return json({ id: profileId }); }
    if (calls === 2) { assert.equal(init?.method, "DELETE"); assert.deepEqual(JSON.parse(String(init?.body)), { should_soft_delete: false }); return json({}); }
    assert.equal(init?.method, "GET"); return json({}, 404);
  });
  assert.deepEqual(await processMemberCleanupTask(runToken, f.ports, adapter), { status: "applied" });
  assert.equal(calls, 3); assert.equal((f.completed[0] as Record<string, unknown>).objectId, null);
});

test("idle은 삭제·fence·완료 없이 반환한다", async () => {
  const f = fixture(null);
  assert.deepEqual(await processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, async () => assert.fail())), { status: "idle" });
  assert.deepEqual(f.events, ["claim"]);
});

test("위조 task·다른 bucket·경로탈출·Auth 혼합 target은 네트워크 전에 실패한다", async () => {
  for (const bad of [undefined, {}, [], { ...task(), extra: "private" }, { ...task(), bucketId: "report-captures" },
    { ...task(), objectName: `${profileId}/../private.jpg` }, { ...task(), objectName: "a/./b" },
    ...["", "/a", "a/", "a//b", "a\\b", "a\nprivate", "a\u0000b", "a\ud800", "한".repeat(342)].map((objectName) => ({ ...task(), objectName })),
    { ...task(), expiresAt: "2099-01-01" },
    { ...task(), objectId: null }, { ...authTask(), objectId }, { ...authTask(), bucketId: "profile-images" }]) {
    const f = fixture(bad); f.ports.claim = async () => bad; let calls = 0;
    await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, async () => { calls++; return json({}); })), unavailable);
    assert.equal(calls, 0); assert.equal(f.completed.length, 0);
  }
});

test("만료 lease·형식 오류 token·누락 DB fence는 외부 삭제 전에 실패한다", async () => {
  const f = fixture({ ...task(), expiresAt: new Date(Date.now() - 1).toISOString() });
  const adapter = createMemberCleanupAdapter(config, async () => assert.fail());
  await assert.rejects(processMemberCleanupTask(runToken, f.ports, adapter), (e) => toPublicError(e).error.code === "STATE_CONFLICT");
  await assert.rejects(processMemberCleanupTask("private", f.ports, adapter), (e) => toPublicError(e).error.code === "INVALID_REQUEST");
  await assert.rejects(processMemberCleanupTask(runToken, { ...f.ports, assertCurrent: undefined } as unknown as MemberCleanupPorts, adapter), unavailable);
});

test("삭제 직전 fence 거절이면 DELETE 없고 삭제 후 fence 거절이면 완료가 없다", async () => {
  for (const failure of [1, 2, 3, 4]) {
    const f = fixture(task(), failure);
    await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, storageFetch(f.events))),
      (e) => toPublicError(e).error.code === "STATE_CONFLICT");
    assert.equal(f.completed.length, 0);
    assert.equal(f.events.includes("http2"), failure >= 3);
  }
});
test("최초 BEGIN 거절·응답 유실·재전송 표시에는 DELETE와 ACK·완료가 없다", async () => {
  for (const dispatch of [null, {}, { dispatchId: runToken, alreadyDispatched: true }, { dispatchId: "invalid", alreadyDispatched: false },
    { dispatchId: runToken, alreadyDispatched: false, extra: true }, "lost", "denied"]) {
    const f = fixture();
    f.ports.beginDelete = async () => {
      if (dispatch === "lost") throw new Error("synthetic BEGIN response loss");
      if (dispatch === "denied") throw new HttpError("STATE_CONFLICT");
      return dispatch;
    };
    await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, storageFetch(f.events))));
    assert.equal(f.events.includes("http1"), true); assert.equal(f.events.includes("http2"), false);
    assert.equal(f.events.includes("recordAck"), false); assert.equal(f.completed.length, 0);
  }
});

test("check RPC task 재반환 불일치·빈 성공과 원문 DB 오류는 삭제를 허용하지 않는다", async () => {
  for (const changed of [undefined, { ...task(), objectId: profileId }, { ...task(), profileId: objectId, objectName: `${objectId}/${objectId}.jpg` },
    { ...task(), leaseToken: runToken }, { ...task(), expiresAt: new Date(Date.now() + 120000).toISOString() }]) {
    const value = task(); const f = fixture(value); f.ports.assertCurrent = async () => changed;
    await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, async () => assert.fail())),
      (e) => ["STATE_CONFLICT", "EXTERNAL_UNAVAILABLE"].includes(toPublicError(e).error.code));
    assert.equal(f.completed.length, 0);
  }
  const f = fixture(); f.ports.assertCurrent = async () => { throw new Error("fixture-service private target"); };
  await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, async () => assert.fail())), unavailable);
});

test("DB fence 응답을 기다리는 동안 lease가 만료되면 외부 요청하지 않는다", async () => {
  const value = { ...task(), expiresAt: new Date(Date.now() + 15).toISOString() };
  const f = fixture(value);
  f.ports.assertCurrent = async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return value; };
  await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, async () => assert.fail())),
    (e) => toPublicError(e).error.code === "STATE_CONFLICT");
  assert.equal(f.completed.length, 0);
});

test("info 부재·다른 객체·삭제 실패·빈 삭제응답·재조회200/400/401/403/500은 완료하지 않는다", async () => {
  const failures = [
    [json({}, 404)], [json({ ...info(), id: profileId })], [json({ ...info(), name: "private" })],
    [json({ ...info(), bucket_id: "private" })], [json(info()), json({}, 403)],
    [json(info()), json([])], [json(info()), json([{ id: profileId, name: objectName }])],
    ...[200, 400, 401, 403, 500].map((status) => [json(info()), json([{ id: objectId, name: objectName }]), json({ statusCode: 404 }, status)]),
  ];
  for (const responses of failures) {
    const f = fixture();
    await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, storageFetch(f.events, responses))), unavailable);
    assert.equal(f.completed.length, 0);
  }
});

test("Auth 삭제 타깃 불일치·부재·실패·재조회 부재 아닌 응답은 완료하지 않는다", async () => {
  for (const responses of [[json({ id: objectId })], [json({}, 404)], [json({}, 500)],
    ...[200, 400, 401, 403, 500].map((status) => [json({ id: profileId }), json({}), json({}, status)]),
    ...[null, [], { id: profileId }, { id: objectId }, { extra: true }, { error: "private" }].map((v) => [json({ id: profileId }), json(v)])]) {
    const f = fixture(authTask()); let n = 0;
    await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, async () => responses[n++])), unavailable);
    assert.equal(f.completed.length, 0);
  }
});

test("네트워크 원문·잘못된 JSON·리다이렉트 예외·timeout은 안전한 실패이고 완료하지 않는다", async () => {
  for (const fetchImpl of [async () => { throw new Error("fixture-service private"); }, async () => new Response("private", { status: 200 }),
    async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("fixture-service private"))))]) {
    const f = fixture();
    await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter({ ...config, upstreamTimeoutMs: 10 }, fetchImpl)), unavailable);
    assert.equal(f.completed.length, 0);
  }
});

test("완료 RPC가 적용을 반환하지 않으면 처리 성공을 반환하지 않는다", async () => {
  for (const value of [null, { status: "applied", extra: true }, { status: "lease_lost" }]) {
    const f = fixture(); f.ports.complete = async () => value;
    await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, storageFetch(f.events))), unavailable);
  }
  const f = fixture(); f.ports.complete = async () => { throw new HttpError("STATE_CONFLICT"); };
  await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, storageFetch(f.events))),
    (e) => toPublicError(e).error.code === "STATE_CONFLICT");
});

test("비밀키 누락·같은 키·잘못된 origin·timeout 설정은 어댑터 생성 단계에서 실패한다", () => {
  for (const changes of [{ supabaseServiceRoleKey: undefined }, { supabaseServiceRoleKey: config.supabaseAnonKey },
    { supabaseServiceRoleKey: "private\nkey" }, { supabaseUrl: "http://attacker.invalid" },
    { supabaseUrl: config.supabaseUrl + "/path" }, { supabaseUrl: "https://private:key@cleanup.example.invalid" },
    { upstreamTimeoutMs: 0 }]) assert.throws(() => createMemberCleanupAdapter({ ...config, ...changes }), unavailable);
});

const ack = (value = task()) => ({ receiptId: runToken, taskId: value.taskId, kind: value.kind, objectId: value.objectId, evidenceSha256: "1".repeat(64) });
test("기존 durable ack가 있으면 Storage/Auth 재삭제 없이 부재 검증 후 완료한다", async () => {
  for (const value of [task(), authTask()]) {
    const f = fixture(value); f.ports.getDeleteAck = async () => ack(value); let calls = 0;
    f.ports.beginDelete = async () => assert.fail("기존 ACK에는 신규 dispatch 없음");
    f.ports.recordDeleteAck = async () => assert.fail("재기록 없음");
    const adapter = createMemberCleanupAdapter(config, async (url, init) => {
      assert.equal(init?.method, "GET"); calls++;
      if (value.kind === "storage_object") assert.equal(url, config.supabaseUrl + (calls === 1 ?
        `/storage/v1/object/info/authenticated/profile-images/${objectName}` : `/storage/v1/object/authenticated/profile-images/${objectName}`));
      else assert.equal(url, `${config.supabaseUrl}/auth/v1/admin/users/${profileId}`);
      return json({}, 404);
    });
    assert.deepEqual(await processMemberCleanupTask(runToken, f.ports, adapter), { status: "applied" });
    assert.equal(calls, value.kind === "storage_object" ? 2 : 1);
    assert.notEqual((f.completed[0] as Record<string, unknown>).evidenceSha256, ack(value).evidenceSha256);
  }
});

test("durable ack 기록 후 complete 실패는 새 lease에서 재삭제 없이 복구한다", async () => {
  let durable: unknown = null; const first = fixture(); let recordedHash = "";
  first.ports.getDeleteAck = async () => durable;
  first.ports.recordDeleteAck = async (args) => { recordedHash = args.ackSha256; durable = { ...ack(), evidenceSha256: recordedHash }; return durable; };
  first.ports.complete = async () => { throw new HttpError("STATE_CONFLICT"); };
  await assert.rejects(processMemberCleanupTask(runToken, first.ports, createMemberCleanupAdapter(config, storageFetch(first.events))),
    (e) => toPublicError(e).error.code === "STATE_CONFLICT");
  const second = fixture({ ...task(), leaseToken: profileId }); let gets = 0;
  second.ports.getDeleteAck = async () => durable;
  second.ports.recordDeleteAck = async () => assert.fail();
  second.ports.beginDelete = async () => assert.fail("ACK 복구에는 신규 dispatch 없음");
  assert.deepEqual(await processMemberCleanupTask(runToken, second.ports, createMemberCleanupAdapter(config, async (_url, init) => {
    assert.equal(init?.method, "GET"); gets++; return json({}, 404);
  })), { status: "applied" });
  assert.equal(gets, 2); assert.equal((second.completed[0] as Record<string, unknown>).leaseToken, profileId);
  assert.notEqual((second.completed[0] as Record<string, unknown>).evidenceSha256, recordedHash);
});

test("durable record 응답 소실은 같은 task proof를 다음 lease에서 읽어 복구한다", async () => {
  let durable: unknown = null; const first = fixture();
  first.ports.recordDeleteAck = async (args) => { durable = { ...ack(), evidenceSha256: args.ackSha256 }; throw new Error("fixture-private response lost"); };
  await assert.rejects(processMemberCleanupTask(runToken, first.ports, createMemberCleanupAdapter(config, storageFetch(first.events))), unavailable);
  assert.equal(first.events.includes("http3"), false); assert.equal(first.completed.length, 0);
  const second = fixture({ ...task(), leaseToken: profileId }); second.ports.getDeleteAck = async () => durable;
  second.ports.beginDelete = async () => assert.fail("ACK 복구에는 신규 dispatch 없음");
  assert.deepEqual(await processMemberCleanupTask(runToken, second.ports, createMemberCleanupAdapter(config, async (_url, init) => {
    assert.equal(init?.method, "GET"); return json({}, 404);
  })), { status: "applied" });
});

test("ack 기록 실패·반환 hash 불일치면 재조회/complete를 실행하지 않는다", async () => {
  for (const response of [null, { ...ack(), evidenceSha256: "2".repeat(64) }]) {
    const f = fixture(); f.ports.recordDeleteAck = async () => response;
    await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, storageFetch(f.events))), unavailable);
    assert.equal(f.events.includes("http3"), false); assert.equal(f.completed.length, 0);
  }
});

test("다른 task/object/kind 또는 비정상 proof는 네트워크 전에 거절한다", async () => {
  for (const proof of [{ ...ack(), taskId: profileId }, { ...ack(), objectId: profileId }, { ...ack(), kind: "auth_user" },
    { ...ack(), evidenceSha256: "private" }, { ...ack(), receiptId: "private" }, { ...ack(), extra: true }, {}]) {
    const f = fixture(); f.ports.getDeleteAck = async () => proof;
    await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, async () => assert.fail())), unavailable);
    assert.equal(f.completed.length, 0);
  }
});

test("기존 proof가 있어도 객체/UID 재등장 및 재조회 권한/서비스 오류는 재삭제/완료하지 않는다", async () => {
  for (const value of [task(), authTask()]) for (const status of [200, 400, 401, 403, 500]) {
    const f = fixture(value); f.ports.getDeleteAck = async () => ack(value); let requests = 0;
    await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, async (_url, init) => {
      assert.equal(init?.method, "GET"); requests++; return json({ id: profileId }, status);
    })), unavailable);
    assert.equal(requests, 1); assert.equal(f.completed.length, 0);
  }
});

test("Storage HTTP400 exact NoSuchKey/statusCode404만 최초·증거 재시도에서 부재로 정규화한다", async () => {
  const absent = () => json({ code: "NoSuchKey", statusCode: "404", error: "not_found", message: "Object not found" }, 400);
  const first = fixture();
  assert.deepEqual(await processMemberCleanupTask(runToken, first.ports, createMemberCleanupAdapter(config,
    storageFetch(first.events, [json(info()), json([{ id: objectId, name: objectName }]), absent()]))), { status: "applied" });
  const second = fixture(); second.ports.getDeleteAck = async () => ack();
  assert.deepEqual(await processMemberCleanupTask(runToken, second.ports, createMemberCleanupAdapter(config, async (_url, init) => {
    assert.equal(init?.method, "GET"); return absent();
  })), { status: "applied" });
});

test("다른 Storage400·NoSuchBucket·JWT·권한·잘못된body 및 Auth400는 부재가 아니다", async () => {
  for (const body of [null, [], {}, { statusCode: "404" }, { code: "NoSuchKey" }, { code: "NoSuchKey", statusCode: 404 },
    { code: "NoSuchKey", statusCode: "403" }, { code: "NoSuchBucket", statusCode: "404" },
    { code: "InvalidJWT", statusCode: "404" }, { code: "AccessDenied", statusCode: "404" }, { code: "InvalidRequest", statusCode: "404" }]) {
    const f = fixture(); f.ports.getDeleteAck = async () => ack();
    await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, async () => json(body, 400))), unavailable);
    assert.equal(f.completed.length, 0);
  }
  const f = fixture(authTask()); f.ports.getDeleteAck = async () => ack(authTask());
  await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config,
    async () => json({ code: "NoSuchKey", statusCode: "404" }, 400))), unavailable);
  const malformed = fixture(); malformed.ports.getDeleteAck = async () => ack();
  await assert.rejects(processMemberCleanupTask(runToken, malformed.ports, createMemberCleanupAdapter(config,
    async () => new Response("fixture-private malformed", { status: 400 }))), unavailable);
});

test("legacy exact 이름과 %/?/#는 segment 인코딩하고 DELETE 원래 이름 하나만 보낸다", async () => {
  for (const name of [`${profileId}/legacy photo?.jpeg`, `${profileId}/literal%2F#?.png`, "legacy-owned-name.png", `${profileId}/한글.jpeg`]) {
    const f = fixture({ ...task(), objectName: name }); let calls = 0;
    const encoded = name.split("/").map(encodeURIComponent).join("/");
    const adapter = createMemberCleanupAdapter(config, async (url, init) => {
      const target = new URL(String(url)); assert.equal(target.search, ""); assert.equal(target.hash, "");
      if (++calls === 1) { assert.equal(url, `${config.supabaseUrl}/storage/v1/object/info/authenticated/profile-images/${encoded}`);
        return json({ ...info(), name }); }
      if (calls === 2) { assert.equal(url, `${config.supabaseUrl}/storage/v1/object/profile-images`);
        assert.deepEqual(JSON.parse(String(init?.body)), { prefixes: [name] }); return json([{ id: objectId, name }]); }
      assert.equal(url, `${config.supabaseUrl}/storage/v1/object/authenticated/profile-images/${encoded}`); return json({}, 404);
    });
    assert.deepEqual(await processMemberCleanupTask(runToken, f.ports, adapter), { status: "applied" }); assert.equal(calls, 3);
  }
});

test("foreign 소유권 DB check 실패나 같은 prefix 다른 object ID는 DELETE를 허용하지 않는다", async () => {
  const foreign = fixture({ ...task(), objectName: `${profileId}/legacy.png` }); foreign.ports.assertCurrent = async () => { throw new HttpError("STATE_CONFLICT"); };
  await assert.rejects(processMemberCleanupTask(runToken, foreign.ports, createMemberCleanupAdapter(config, async () => assert.fail())),
    (e) => toPublicError(e).error.code === "STATE_CONFLICT");
  const f = fixture(); let requests = 0;
  await assert.rejects(processMemberCleanupTask(runToken, f.ports, createMemberCleanupAdapter(config, async (_url, init) => {
    assert.equal(init?.method, "GET"); requests++; return json({ ...info(), id: profileId });
  })), unavailable);
  assert.equal(requests, 1); assert.equal(f.completed.length, 0);
});
