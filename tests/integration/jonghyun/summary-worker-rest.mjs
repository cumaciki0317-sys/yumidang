/**
 * 실제 로컬 DB + 실제 PostgREST(RPC) + 가상 모델로 요약 worker 전체 흐름을 실행한다(제안 03 적용 DB 전용).
 * - DB 연결은 민규 createRpcTransport에 새 요약 RPC를 넣은 **테스트 전용 허용 목록**으로 만든다. 운영 코드는 민규
 *   internal-client 허용 목록 반영 전까지 DB_RPC_NOT_ALLOWED로 멈춘다(우회하지 않음).
 * - 모델·안전 검사는 가상이다. 실제 모델 품질·Edge 실행 검증이 아니다.
 * 필요한 환경(로컬 값, 출력 금지): SUMMARY_REST_DATABASE_URL(127.0.0.1:55422), SUMMARY_REST_SUPABASE_URL(http://127.0.0.1:55421),
 *   SUMMARY_REST_ANON_KEY, SUMMARY_REST_SERVICE_ROLE_KEY
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createRpcTransport } from "../../../backend/supabase/functions/_shared/db/transport.ts";
import { JOB_RPCS } from "../../../backend/supabase/functions/_shared/db/repositories/jobs.ts";
import { createReviewSummaryWorkerRuntime, REVIEW_SUMMARY_WORKER_ENV } from "../../../backend/supabase/functions/review-summary-worker/index.ts";
import { REVIEW_SUMMARY_PROMPT_VERSION } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/prompts.ts";
const { Client } = createRequire(new URL("../../../backend/package.json", import.meta.url))("pg");
const env = process.env;
for (const key of ["SUMMARY_REST_DATABASE_URL", "SUMMARY_REST_SUPABASE_URL", "SUMMARY_REST_ANON_KEY", "SUMMARY_REST_SERVICE_ROLE_KEY"]) {
  if (!env[key]) throw new Error("EXPLICIT_LOCAL_SETTING_REQUIRED");
}
const db = new URL(env.SUMMARY_REST_DATABASE_URL), api = new URL(env.SUMMARY_REST_SUPABASE_URL);
if (db.hostname !== "127.0.0.1" || db.port !== "55422" || api.hostname !== "127.0.0.1" || api.port !== "55421") throw new Error("DEDICATED_LOCAL_ONLY");

const SUMMARY_RPCS = ["load_review_summary_source", "load_review_summary_checkpoint", "save_review_summary_checkpoint",
  "discard_review_summary_checkpoint", "mark_review_summary_insufficient", "publish_review_summary_for_job"];

test("실제 DB·PostgREST: 등록 → 분할 요약 정상 양보·재개 → 원자 게시 → 완료, 실패 횟수 0", { timeout: 60_000 }, async () => {
  const admin = new Client({ connectionString: env.SUMMARY_REST_DATABASE_URL, ssl: false, statement_timeout: 10000 });
  const author = randomUUID(), target = randomUUID(), appointments = [];
  await admin.connect();
  try {
    assert.equal(Number((await admin.query("select count(*) n from private.worker_jobs")).rows[0].n), 0, "빈 작업 큐에서만 실행");
    await admin.query("begin");
    await admin.query("insert into auth.users(id) values($1),($2)", [author, target]);
    await admin.query("insert into public.profiles(id,real_name,birth_date) values($1,'가상작성자','1990-01-01'),($2,'가상대상자','1990-01-01')", [author, target]);
    for (let i = 0; i < 4; i++) {
      const post = randomUUID(), request = randomUUID(), ap = randomUUID(); appointments.push(ap);
      await admin.query(`insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)
        values($1,$2,'REST 검증','가상 검사','산책',now()-interval '4 days',now()-interval '3 days',now()-interval '5 days','서울특별시 강남구 역삼동')`, [post, author]);
      await admin.query("insert into public.join_requests(id,post_id,requester_id,message,status) values($1,$2,$3,'가상 REST 신청입니다','matched')", [request, post, target]);
      await admin.query(`insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
        values($1,$2,$3,'completed',now()-interval '2 days','automatic',now()-interval '2 days',now()-interval '1 day',now()+interval '5 days')`, [ap, post, request]);
      await admin.query("insert into public.appointment_reviews(appointment_id,reviewer_id,rating,comment) values($1,$2,5,$3)", [ap, author, "가상 REST 후기 " + i]);
    }
    await admin.query("commit");
    // 일일 등록 경로와 같은 DB 함수로 작업을 만든다(모델 설정과 분리된 공개 처리 뒤).
    await admin.query("set role service_role");
    const registered = (await admin.query("select public.process_review_summary_refresh(100,'potens.claude-5-sonnet',$1) r", [REVIEW_SUMMARY_PROMPT_VERSION])).rows[0].r;
    await admin.query("reset role");
    assert.ok(registered.enqueuedCount >= 1, JSON.stringify(registered));

    const secret = randomBytes(24).toString("hex");
    const runtimeEnv = {
      SUPABASE_URL: api.origin, SUPABASE_ANON_KEY: env.SUMMARY_REST_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: env.SUMMARY_REST_SERVICE_ROLE_KEY,
      INTERNAL_WORKER_SECRET: secret, ALLOWED_ORIGINS: "[]", UPSTREAM_TIMEOUT_MS: "5000", MAX_REQUEST_BYTES: "1024",
      REVIEW_SUMMARY_MODEL_VERSION: "potens.claude-5-sonnet", REVIEW_SUMMARY_PROMPT_VERSION,
      // 가상 수치(합성 검사 전용): 묶음 2개·실행 단계당 호출 1회 → 정상 양보가 여러 번 일어난다.
      [REVIEW_SUMMARY_WORKER_ENV.maxJobsPerRun]: "10", [REVIEW_SUMMARY_WORKER_ENV.timeBudgetMs]: "30000",
      [REVIEW_SUMMARY_WORKER_ENV.leaseSeconds]: "60", [REVIEW_SUMMARY_WORKER_ENV.retryMaxAttempts]: "3",
      [REVIEW_SUMMARY_WORKER_ENV.retryBaseDelayMs]: "1000", [REVIEW_SUMMARY_WORKER_ENV.retryMaxDelayMs]: "2000",
      [REVIEW_SUMMARY_WORKER_ENV.budgetDeferMs]: "60000", [REVIEW_SUMMARY_WORKER_ENV.maxInputChars]: "20000",
      [REVIEW_SUMMARY_WORKER_ENV.maxReviewsPerChunk]: "2", [REVIEW_SUMMARY_WORKER_ENV.mergeFanIn]: "2",
      [REVIEW_SUMMARY_WORKER_ENV.maxOutputTokens]: "200", [REVIEW_SUMMARY_WORKER_ENV.maxOutputChars]: "2000",
      [REVIEW_SUMMARY_WORKER_ENV.maxCallsPerStep]: "1",
    };
    let modelCalls = 0;
    const model = { async generate(request) {
      modelCalls++;
      const ids = request.task === "review_merge" ? request.input.summaries.map((s) => s.evidenceId) : request.input.reviews.map((r) => r.evidenceId);
      return { value: { claims: [{ text: "가상 요약 주장", evidenceIds: ids }] }, modelVersion: "potens.claude-5-sonnet", usage: null };
    } };
    const handler = createReviewSummaryWorkerRuntime((key) => runtimeEnv[key], {
      createDb: (config) => createRpcTransport(config, config.supabaseServiceRoleKey, config.supabaseServiceRoleKey,
        new Set([...JOB_RPCS, ...SUMMARY_RPCS])),
      createModel: () => ({ status: "ready", model, modelVersion: "potens.claude-5-sonnet" }),
      safety: { async check() { return true; } },
    });
    const response = await handler(new Request(api.origin + "/functions/v1/review-summary-worker",
      { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + secret }, body: "{}" }));
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body.error ?? {}));
    const result = body.data;
    assert.equal(result.status, "ran");
    assert.equal(result.stopReason, "idle");
    assert.equal(result.counts.succeeded, 1);
    assert.ok(result.counts.yielded >= 2, "정상 분할은 같은 실행에서 이어 처리: " + JSON.stringify(result.counts));
    assert.equal(result.counts.failed + result.counts.retryWait, 0);
    assert.equal(modelCalls, 3, "묶음 2회 + 병합 1회, 중복 호출 없음");
    const job = (await admin.query("select status, attempt, failed_attempts from private.worker_jobs where payload->>'profileId'=$1", [target])).rows[0];
    assert.deepEqual([job.status, Number(job.failed_attempts)], ["succeeded", 0]);
    assert.ok(Number(job.attempt) >= 3, "점유 횟수는 실패 횟수와 별개로 증가");
    const state = (await admin.query(`select s.summary_text, s.source_revision::text rev, st.revision::text cur,
      (select count(*) from private.review_summary_checkpoints c where c.job_id in (select id from private.worker_jobs where payload->>'profileId'=$2::text)) cps
      from private.review_summary_state st join private.review_summaries s on s.id=st.visible_summary_id where st.profile_id=$1::uuid`, [target, target])).rows[0];
    assert.equal(state.rev, state.cur);
    assert.equal(Number(state.cps), 0);
    assert.doesNotMatch(JSON.stringify(result), /가상 REST 후기|가상 요약 주장/);
  } finally {
    await admin.query("rollback").catch(() => {});
    await admin.query("reset role").catch(() => {});
    await admin.query("delete from private.worker_jobs where payload->>'profileId'=$1", [target]).catch(() => {});
    await admin.query("delete from public.appointments where id=any($1::uuid[])", [appointments]).catch(() => {});
    await admin.query("delete from auth.users where id=any($1::uuid[])", [[author, target]]).catch(() => {});
    const left = await admin.query("select count(*) n from auth.users where id=any($1::uuid[])", [[author, target]]);
    await admin.end();
    assert.equal(Number(left.rows[0].n), 0, "synthetic cleanup");
  }
});
