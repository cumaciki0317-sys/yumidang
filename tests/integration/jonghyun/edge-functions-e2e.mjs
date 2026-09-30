/**
 * 로컬 Supabase gateway(`/functions/v1/*`) → 실제 Edge 런타임(Deno)으로 종현 함수 5개를 호출한다.
 * 임시 실행 폴더에서만 edge_runtime을 켜고 합성 설정값만 주입한 상태를 전제로 한다(외부 공급사·모델 키 없음).
 * 따라서 기대 결과는 “인증·입력 검사·안전한 비활성 응답”이다: 모델 미승인 → unavailable/not_enabled, 외부 키 없음 → 503.
 * 환경(로컬 값, 출력 금지): EDGE_BASE_URL(http://127.0.0.1:55421), EDGE_ANON_KEY, EDGE_SERVICE_ROLE_KEY, EDGE_WORKER_SECRET, EDGE_ALLOWED_ORIGIN
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
const env = process.env;
for (const key of ["EDGE_BASE_URL", "EDGE_ANON_KEY", "EDGE_SERVICE_ROLE_KEY", "EDGE_WORKER_SECRET", "EDGE_ALLOWED_ORIGIN"]) {
  if (!env[key]) throw new Error("EXPLICIT_LOCAL_SETTING_REQUIRED");
}
const base = new URL(env.EDGE_BASE_URL);
if (base.hostname !== "127.0.0.1" || base.port !== "55421") throw new Error("DEDICATED_LOCAL_ONLY");
const secrets = [env.EDGE_ANON_KEY, env.EDGE_SERVICE_ROLE_KEY, env.EDGE_WORKER_SECRET];
const fn = (path) => base.origin + "/functions/v1/" + path;
async function call(path, init = {}) {
  const response = await fetch(fn(path), init);
  const text = await response.text();
  for (const secret of secrets) assert.equal(text.includes(secret), false, "응답에 키·비밀이 없어야 함");
  let body = null; try { body = JSON.parse(text); } catch {}
  return { status: response.status, body, headers: response.headers };
}
const json = (token, body, extra = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...extra }, body: JSON.stringify(body) });

test("실제 Edge: 종현 함수 5개의 인증·입력 검사·비활성 응답·함수 간 호출", { timeout: 120_000 }, async (t) => {
  const admin = { apikey: env.EDGE_SERVICE_ROLE_KEY, authorization: "Bearer " + env.EDGE_SERVICE_ROLE_KEY, "content-type": "application/json" };
  const email = `synthetic-${randomUUID()}@example.invalid`, password = randomBytes(18).toString("hex");
  const created = await fetch(base.origin + "/auth/v1/admin/users", { method: "POST", headers: admin, body: JSON.stringify({ email, password, email_confirm: true }) });
  assert.equal(created.status, 200);
  const userId = (await created.json()).id;
  try {
    const session = await fetch(base.origin + "/auth/v1/token?grant_type=password", { method: "POST",
      headers: { apikey: env.EDGE_ANON_KEY, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    const jwt = (await session.json()).access_token;
    const chat = { clientRequestId: "edge-1", messages: [{ role: "user", content: "합성 요청: 전시 같이 볼 사람" }], currentFilters: { target: "posts" } };

    await t.test("ai-chat", async () => {
      assert.equal((await call("ai-chat", json(null, chat))).status, 401);
      const ok = await call("ai-chat", json(jwt, chat));
      assert.equal(ok.status, 200);
      assert.equal(ok.body.data.status, "unavailable", "보관 검토 결정 없음 → 모델 비활성");
      assert.equal(ok.body.requestId, ok.headers.get("x-request-id"));
      assert.equal((await call("ai-chat", json(jwt, { ...chat, userId: "spoof" }))).status, 400);
      assert.equal((await call("ai-chat", json(jwt, { ...chat, messages: [{ role: "user", content: "가".repeat(20000) }] }))).status, 413);
    });
    await t.test("places", async () => {
      assert.equal((await call("places?query=%EC%84%9C%EC%9A%B8%EC%97%AD&page=1")).status, 401);
      const r = await call("places?query=%EC%84%9C%EC%9A%B8%EC%97%AD&page=1", { headers: { authorization: "Bearer " + jwt } });
      assert.equal(r.status, 503, "Kakao 키 미주입 → 외부 서비스 미설정");
      assert.equal(r.body.error.code, "EXTERNAL_UNAVAILABLE");
    });
    await t.test("event-sync", async () => {
      const body = { provider: "kopis", period: { start: "2099-01-01", end: "2099-01-02" }, page: 1 };
      assert.equal((await call("event-sync", json("wrong_" + "x".repeat(40), body))).status, 403);
      // KOPIS 키 미주입: 인증을 통과한 호출자에게만, 본문 검사 전에 503(0건 성공이 아님).
      const r = await call("event-sync", json(env.EDGE_WORKER_SECRET, body));
      assert.equal(r.status, 503);
      assert.equal(r.body.error.code, "EXTERNAL_UNAVAILABLE");
    });
    await t.test("review-summary-worker", async () => {
      assert.equal((await call("review-summary-worker", json("wrong_" + "x".repeat(40), {}))).status, 403);
      const r = await call("review-summary-worker", json(env.EDGE_WORKER_SECRET, {}));
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data, { status: "not_enabled", reason: "MODEL_RETENTION_REVIEW_PENDING" });
    });
    await t.test("scheduled-jobs/daily → service-api maintenance·worker 함수 간 호출", async () => {
      const r = await call("scheduled-jobs/daily", json(env.EDGE_WORKER_SECRET, { limit: 10 }));
      assert.equal(r.status, 200, JSON.stringify(r.body?.error ?? {}));
      assert.equal(r.body.data.maintenance.reviews.status, "published");
      assert.equal(r.body.data.maintenance.completion.status, "managed_by_reservation");
      assert.deepEqual(r.body.data.events, { status: "not_configured" });
      assert.deepEqual(r.body.data.summaryWorker, { status: "not_enabled", reason: "MODEL_RETENTION_REVIEW_PENDING" });
    });
    await t.test("CORS 관찰(판정은 기록만)", async () => {
      const pre = await fetch(fn("ai-chat"), { method: "OPTIONS", headers: { origin: env.EDGE_ALLOWED_ORIGIN,
        "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
      const bad = await fetch(fn("ai-chat"), { method: "OPTIONS", headers: { origin: "https://evil.example",
        "access-control-request-method": "POST" } });
      console.log(JSON.stringify({ cors: { allowed: { status: pre.status, allowOrigin: pre.headers.get("access-control-allow-origin") },
        disallowed: { status: bad.status, allowOrigin: bad.headers.get("access-control-allow-origin") } } }));
    });
  } finally {
    await fetch(base.origin + "/auth/v1/admin/users/" + userId, { method: "DELETE", headers: admin });
  }
});
