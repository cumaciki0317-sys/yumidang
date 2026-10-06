/** 민규: 고정 독립 로컬 provider의 실제 DELETE 검증. DB fence/ack 포트는 합성이며 운영 연결 증명이 아니다. */
import assert from "node:assert/strict";
import { readFileSync, lstatSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { createMemberCleanupAdapter, processMemberCleanupTask, type MemberCleanupTask, type MemberCleanupPorts } from "../../../backend/supabase/functions/_shared/auth/member-cleanup.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";

const statusFile = process.argv[2];
assert.equal(statusFile, "/private/tmp/yumidang-drift-catalog-44g9wt_e/current52-local-status.json");
for (const [path, mode] of [[statusFile, 0o600], [dirname(statusFile), 0o700]] as const) {
  const stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.uid, process.getuid!()); assert.equal(stat.mode & 0o777, mode);
}
const settings = JSON.parse(readFileSync(statusFile, "utf8"));
assert.equal(settings.API_URL, "http://127.0.0.1:56531");
const origin = settings.API_URL as string, service = settings.SERVICE_ROLE_KEY as string, anon = settings.ANON_KEY as string;
assert.equal(typeof service, "string"); assert.notEqual(service, anon);
const artifact = mkdtempSync(join(tmpdir(), "yumidang-cleanup-provider-"));
const report: Record<string, unknown> = { scope: "isolated_local_provider", dbFence: "SYNTHETIC", observations: [], checks: [] };
const observations = report.observations as unknown[]; const checks = report.checks as string[];
const users: string[] = []; const objects: { userId: string; name: string }[] = [];
const host = "unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock";
const uid = /^[a-f0-9-]{36}$/;
const image = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooA//2Q==", "base64");

async function request(path: string, method = "GET", body?: unknown, token = service, binary = false) {
  assert.equal(new URL(origin + path).origin, origin);
  return await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { apikey: token === service ? service : anon, Authorization: `Bearer ${token}`, "Content-Type": binary ? "image/jpeg" : "application/json" },
    ...(body === undefined ? {} : { body: binary ? body as Buffer : JSON.stringify(body) }) });
}
async function json(response: Response): Promise<Record<string, unknown>> {
  assert.equal(response.status, 200, "provider status"); const body = await response.json(); assert.ok(body && typeof body === "object"); return body;
}
const tracedFetch: typeof fetch = async (url, init) => {
  assert.equal(new URL(String(url)).origin, origin);
  const response = await fetch(url, init); const clone = response.clone();
  let body: Record<string, unknown> | null = null;
  try { body = await clone.json(); } catch { await clone.body?.cancel().catch(() => {}); }
  const path = new URL(String(url)).pathname;
  observations.push({ route: path.startsWith("/auth") ? "auth_admin_user" : path.includes("/info/") ? "storage_info" : "storage_object",
    method: init?.method, httpStatus: response.status, keys: body ? Object.keys(body).sort() : [],
    code: typeof body?.code === "string" && /^[A-Za-z_]{1,64}$/.test(body.code) ? body.code : null,
    semanticStatus: typeof body?.statusCode === "string" && /^\d{3}$/.test(body.statusCode) ? body.statusCode : null });
  return response;
};
function fixturePorts(task: MemberCleanupTask): { ports: MemberCleanupPorts; completed: unknown[] } {
  const completed: unknown[] = []; let receipt: unknown = null;
  return { completed, ports: {
    async claim() { return task; }, async assertCurrent() { return task; }, async getDeleteAck() { return receipt; },
    async recordDeleteAck(args) { receipt = { receiptId: randomUUID(), taskId: task.taskId, kind: task.kind, objectId: task.objectId, evidenceSha256: args.ackSha256 }; return receipt; },
    async complete(args) { completed.push(args); return { status: "applied" }; },
  } };
}
function sql(query: string): string {
  return execFileSync("docker", ["--host", host, "exec", "-i", "supabase_db_yumidang-minkyu-drift", "psql", "-XqAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: query, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
}
function countFiles(id: string): number {
  assert.match(id, uid);
  const output = execFileSync("docker", ["--host", host, "exec", "supabase_storage_yumidang-minkyu-drift", "find", "/var/lib/storage", "-type", "f", "-path", `*${id}*`], { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  return output ? output.split("\n").length : 0;
}
let failed = false;
try {
  const bucket = await json(await request("/storage/v1/bucket/profile-images")); assert.equal(bucket.id, "profile-images");
  const user = await json(await request("/auth/v1/admin/users", "POST", { email: `cleanup-provider-${randomUUID()}@fixture.invalid`, password: randomBytes(32).toString("base64url"), email_confirm: true }));
  assert.equal(typeof user.id, "string"); assert.match(user.id as string, uid); users.push(user.id as string);
  const userId = user.id as string;
  const config = { supabaseUrl: origin, supabaseAnonKey: anon, supabaseServiceRoleKey: service, upstreamTimeoutMs: 10000, maxRequestBytes: 8192, allowedOrigins: [] };
  const adapter = createMemberCleanupAdapter(config, tracedFetch);
  let task!: MemberCleanupTask;
  for (const filename of [`${randomUUID()}.jpg`, "legacy photo?.jpeg"]) {
  const name = `${userId}/${filename}`, path = name.split("/").map(encodeURIComponent).join("/"); objects.push({ userId, name });
  const uploaded = await json(await request(`/storage/v1/object/profile-images/${path}`, "POST", image, service, true));
  assert.equal(typeof uploaded.Id, "string"); assert.match(uploaded.Id as string, uid);
  const before = await request(`/storage/v1/object/authenticated/profile-images/${path}`); assert.equal(before.status, 200);
  assert.equal(createHash("sha256").update(Buffer.from(await before.arrayBuffer())).digest("hex"), createHash("sha256").update(image).digest("hex"));
  assert.equal(countFiles(userId), 1); checks.push("actual_binary_upload_and_backend_read");
  const control = await request(`/storage/v1/object/authenticated/profile-images/${path}`, "GET", undefined, "invalid-test-token");
  assert.ok([400, 401, 403].includes(control.status)); const controlBody = await control.json();
  report.invalidAuthControl = { httpStatus: control.status, code: typeof controlBody.code === "string" && /^[A-Za-z_]{1,64}$/.test(controlBody.code) ? controlBody.code : null }; checks.push("invalid_auth_control_denied");
  task = { taskId: randomUUID(), leaseToken: randomUUID(), expiresAt: new Date(Date.now() + 60000).toISOString(),
    kind: "storage_object", profileId: userId, bucketId: "profile-images", objectName: name, objectId: uploaded.Id as string };
  const mismatch = fixturePorts({ ...task, objectId: randomUUID() });
  await assert.rejects(processMemberCleanupTask(randomUUID(), mismatch.ports, adapter)); assert.equal(countFiles(userId), 1);
  checks.push("actual_info_object_id_mismatch_no_delete");
  const fenced = fixturePorts(task); fenced.ports.assertCurrent = async () => { throw new HttpError("STATE_CONFLICT"); };
  const observed = observations.length;
  await assert.rejects(processMemberCleanupTask(randomUUID(), fenced.ports, adapter)); assert.equal(observations.length, observed); assert.equal(countFiles(userId), 1);
  checks.push("synthetic_db_fence_denial_before_actual_request");
  const storage = fixturePorts(task);
  let storagePassed = false;
  try { assert.deepEqual(await processMemberCleanupTask(randomUUID(), storage.ports, adapter), { status: "applied" }); storagePassed = true; }
  catch (error) { report.storageFailure = toPublicError(error).error.code; }
  report.storageAdapter = storagePassed ? "PASS" : "FAIL";
  assert.ok(storagePassed, "Storage provider contract mismatch"); assert.equal(storage.completed.length, 1);
  assert.equal(countFiles(userId), 0, "immediate backend deletion"); checks.push("actual_storage_delete_immediate_backend_zero");
  }
  for (const filename of ["percent%.jpg", "fragment#.jpg"]) {
    const name = `${userId}/${filename}`, path = name.split("/").map(encodeURIComponent).join("/");
    const denied = await request(`/storage/v1/object/profile-images/${path}`, "POST", image, service, true);
    assert.equal(denied.status, 400); assert.equal((await denied.json()).code, "InvalidKey");
    assert.equal(countFiles(userId), 0); checks.push("actual_encoded_percent_or_fragment_provider_denial");
  }
  // Storage 실패가 있어도 Auth의 독립 provider 계약은 확인하고 finally에서 전부 정리한다.
  const auth = fixturePorts({ ...task, taskId: randomUUID(), leaseToken: randomUUID(), kind: "auth_user", bucketId: null, objectName: null, objectId: null });
  assert.deepEqual(await processMemberCleanupTask(randomUUID(), auth.ports, adapter), { status: "applied" });
  assert.equal(auth.completed.length, 1); checks.push("actual_auth_hard_delete_requery");
} catch { failed = true; report.result = "FAIL"; }
finally {
  try {
    for (const { name } of objects) { const r = await request("/storage/v1/object/profile-images", "DELETE", { prefixes: [name] }); assert.equal(r.status, 200); await r.body?.cancel(); }
    for (const id of users) { const r = await request(`/auth/v1/admin/users/${id}`, "DELETE", { should_soft_delete: false }); assert.ok([200, 404].includes(r.status)); await r.body?.cancel(); }
    let remaining = users.reduce((n, id) => n + countFiles(id), 0);
    for (let attempt = 0; remaining && attempt < 30; attempt++) { await new Promise((resolve) => setTimeout(resolve, 1000)); remaining = users.reduce((n, id) => n + countFiles(id), 0); }
    assert.equal(remaining, 0, "backend files cleanup");
    for (const id of users) { assert.match(id, uid); assert.equal(sql(`select (select count(*) from auth.users where id='${id}'::uuid)+(select count(*) from storage.objects where name like '${id}/%');`), "0"); }
    report.cleanup = { authUsers: 0, storageObjects: 0, backendFiles: 0 }; checks.push("actual_fixture_cleanup_zero");
  } catch { failed = true; report.cleanup = "FAILED"; }
  if (!failed) report.result = "PASS";
  writeFileSync(join(artifact, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ result: report.result, cleanup: report.cleanup, artifact: join(artifact, "result.json") }));
}
if (failed) process.exitCode = 1;
