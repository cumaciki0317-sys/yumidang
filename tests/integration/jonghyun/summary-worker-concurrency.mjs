/**
 * 제안 03_review_summary_worker.sql이 적용된 전용 로컬 DB에서만 실행하는 실제 다중 세션 검사.
 * 가상 사용자·후기만 커밋하고 finally에서 제거한다. 원격 DB URL을 받지 않는다.
 *   SUMMARY_WORKER_TEST_DATABASE_URL=postgresql://postgres:<로컬>@127.0.0.1:55422/postgres node --test tests/integration/jonghyun/summary-worker-concurrency.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const { Client } = createRequire(new URL("../../../backend/package.json", import.meta.url))("pg");
const databaseUrl = process.env.SUMMARY_WORKER_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("EXPLICIT_LOCAL_TEST_DATABASE_REQUIRED");
const target = new URL(databaseUrl);
if (!["postgres:", "postgresql:"].includes(target.protocol) || target.hostname !== "127.0.0.1" ||
    target.port !== "55422" || target.pathname !== "/postgres" || target.search || target.hash) {
  throw new Error("DEDICATED_LOCAL_DATABASE_ONLY");
}

test("두 세션 경쟁: 단일 점유, 동시 중복 게시 멱등, 원문 변경과 게시 경쟁 후 불변식", { timeout: 60_000 }, async () => {
  const admin = new Client({ connectionString: databaseUrl, ssl: false, statement_timeout: 10000 });
  const s1 = new Client({ connectionString: databaseUrl, ssl: false, statement_timeout: 10000 });
  const s2 = new Client({ connectionString: databaseUrl, ssl: false, statement_timeout: 10000 });
  const author = randomUUID(), target = randomUUID(), appointments = [], reviews = [];
  await Promise.all([admin.connect(), s1.connect(), s2.connect()]);
  try {
    assert.equal(Number((await admin.query("select count(*) n from private.worker_jobs")).rows[0].n), 0, "빈 작업 큐에서만 실행");
    await admin.query("begin");
    await admin.query("insert into auth.users(id) values($1),($2)", [author, target]);
    await admin.query("insert into public.profiles(id,real_name,birth_date) values($1,'가상작성자','1990-01-01'),($2,'가상대상자','1990-01-01')", [author, target]);
    for (let i = 0; i < 4; i++) {
      const post = randomUUID(), request = randomUUID(), ap = randomUUID(), rv = randomUUID();
      appointments.push(ap); reviews.push(rv);
      await admin.query(`insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)
        values($1,$2,'동시성 검증','가상 검사','산책',now()-interval '4 days',now()-interval '3 days',now()-interval '5 days','서울특별시 강남구 역삼동')`, [post, author]);
      await admin.query("insert into public.join_requests(id,post_id,requester_id,message,status) values($1,$2,$3,'가상 동시성 신청입니다','matched')", [request, post, target]);
      await admin.query(`insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
        values($1,$2,$3,'completed',now()-interval '2 days','automatic',now()-interval '2 days',now()-interval '1 day',now()+interval '5 days')`, [ap, post, request]);
      await admin.query("insert into public.appointment_reviews(id,appointment_id,reviewer_id,rating,comment) values($1,$2,$3,5,$4)", [rv, ap, author, "가상 후기 " + i]);
    }
    await admin.query("commit");
    await Promise.all([s1, s2].map((c) => c.query("set role service_role")));
    const snapshot = (await s1.query("select public.load_public_review_snapshot($1) s", [target])).rows[0].s;
    const revision = snapshot.sourceRevision;
    assert.equal(snapshot.eligibleCount, 4);
    const ids = snapshot.reviews.map((r) => r.reviewId).sort();
    const payload = { profileId: target, sourceRevision: revision, modelVersion: "model-a", promptVersion: "review-summary-v1" };
    const key = `review_summary:${target}:${revision}:model-a:review-summary-v1`;
    const job = (await s1.query("select public.enqueue_job('review_summary',$1,$2,clock_timestamp()) r", [key, payload])).rows[0].r.jobId;

    // 1) 같은 순간 두 worker가 점유: 정확히 하나만 작업을 받는다(SKIP LOCKED).
    const claims = await Promise.all([s1, s2].map((c, i) => c.query("select public.claim_job($1,60) r",
      [`${i + 1}1111111-1111-4111-8111-111111111111`])));
    const got = claims.map((r) => r.rows[0].r.job).filter(Boolean);
    assert.equal(got.length, 1);
    const token = got[0].leaseToken;

    // 2) 같은 토큰으로 두 세션이 동시에 게시: 둘 다 applied, 요약·게시 표식은 하나, 게시 시각 동일.
    const publish = (c, text) => c.query("select public.publish_review_summary_for_job($1,$2,$3,$4::uuid[],$5,'model-a','review-summary-v1') r",
      [job, token, revision, ids, text]);
    const pubs = (await Promise.all([publish(s1, "가상 요약 A"), publish(s2, "가상 요약 B")])).map((r) => r.rows[0].r);
    assert.deepEqual(pubs.map((p) => p.status), ["applied", "applied"]);
    assert.equal(pubs[0].summaryId, pubs[1].summaryId);
    assert.equal(pubs[0].publishedAt, pubs[1].publishedAt);
    assert.equal(Number((await admin.query("select count(*) n from private.review_summaries where profile_id=$1", [target])).rows[0].n), 1);
    assert.equal(Number((await admin.query("select count(*) n from private.review_summary_job_publications where job_id=$1", [job])).rows[0].n), 1);
    assert.equal((await s1.query("select public.complete_job($1,$2) r", [job, token])).rows[0].r.status, "succeeded");

    // 3) 새 revision 작업의 게시와 원문 비공개 전환이 경쟁: 끝난 뒤 표시 요약은 없거나 현재 revision과 일치해야 한다.
    const snap2 = (await s1.query("select public.load_public_review_snapshot($1) s", [target])).rows[0].s;
    const rev2 = snap2.sourceRevision;
    const key2 = `review_summary:${target}:${rev2}:model-b:review-summary-v1`;
    const job2 = (await s1.query("select public.enqueue_job('review_summary',$1,$2,clock_timestamp()) r",
      [key2, { ...payload, sourceRevision: rev2, modelVersion: "model-b" }])).rows[0].r.jobId;
    const claim2 = (await s1.query("select public.claim_job('31111111-1111-4111-8111-111111111111',60) r")).rows[0].r.job;
    assert.equal(claim2.jobId, job2);
    const ids2 = snap2.reviews.map((r) => r.reviewId).sort();
    const race = await Promise.allSettled([
      s1.query("select public.publish_review_summary_for_job($1,$2,$3,$4::uuid[],'가상 요약 C','model-b','review-summary-v1') r", [job2, claim2.leaseToken, rev2, ids2]),
      s2.query("select public.set_review_publication($1,false)", [reviews[0]]),
    ]);
    assert.equal(race[1].status, "fulfilled");
    const state = (await admin.query(`select st.revision::text revision, s.source_revision::text summary_revision
      from private.review_summary_state st left join private.review_summaries s on s.id=st.visible_summary_id where st.profile_id=$1`, [target])).rows[0];
    assert.ok(state.summary_revision === null || state.summary_revision === state.revision, JSON.stringify(state));
    assert.notEqual(state.revision, rev2, "비공개 전환은 revision을 올린다");
    assert.equal(Number((await admin.query("select count(*) n from private.review_summary_checkpoints where job_id=$1", [job2])).rows[0].n), 0);
    // 옛 revision 게시 재시도는 거절된다.
    const retry = (await s1.query("select public.publish_review_summary_for_job($1,$2,$3,$4::uuid[],'가상 요약 D','model-b','review-summary-v1') r",
      [job2, claim2.leaseToken, rev2, ids2])).rows[0].r;
    assert.ok(["stale_revision", "applied"].includes(retry.status), retry.status);
    if (race[0].status === "fulfilled" && race[0].value.rows[0].r.status === "applied") {
      // 게시가 먼저 커밋됐다면 표식 멱등으로 같은 결과를 돌려주지만 표시는 이미 무효화됐다.
      assert.equal(state.summary_revision, null);
    } else {
      assert.equal(retry.status, "stale_revision");
    }
  } finally {
    await admin.query("rollback").catch(() => {});
    await admin.query("delete from private.worker_jobs where payload->>'profileId'=$1", [target]).catch(() => {});
    await admin.query("delete from public.appointments where id=any($1::uuid[])", [appointments]).catch(() => {});
    await admin.query("delete from auth.users where id=any($1::uuid[])", [[author, target]]).catch(() => {});
    const left = await admin.query(`select (select count(*) from auth.users where id=any($1::uuid[]))
      + (select count(*) from private.worker_jobs where payload->>'profileId'=$2) n`, [[author, target], target]);
    await Promise.allSettled([s1.end(), s2.end()]);
    await admin.end();
    assert.equal(Number(left.rows[0].n), 0, "synthetic cleanup");
  }
});
