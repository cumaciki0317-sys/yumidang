/**
 * 제안 03_review_summary_worker.sql이 적용된 전용 로컬 DB에서만 실행하는 실제 다중 세션 검사.
 * 가상 사용자·후기만 커밋하고 finally에서 제거한다. 원격 DB URL을 받지 않는다.
 *   SUMMARY_WORKER_TEST_DATABASE_URL=postgresql://postgres:<로컬>@127.0.0.1:55422/postgres node --test tests/integration/jonghyun/summary-worker-concurrency.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const { Client } = createRequire(new URL("../../../../../backend/package.json", import.meta.url))("pg");
const databaseUrl = process.env.SUMMARY_WORKER_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("EXPLICIT_LOCAL_TEST_DATABASE_REQUIRED");
const target = new URL(databaseUrl);
if (!["postgres:", "postgresql:"].includes(target.protocol) || target.hostname !== "127.0.0.1" ||
    target.port !== "55422" || target.pathname !== "/postgres" || target.search || target.hash) {
  throw new Error("DEDICATED_LOCAL_DATABASE_ONLY");
}

test("audit: projection lock wait must recheck expired lease", { timeout: 60_000 }, async () => {
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


    const claim = (await s1.query("select public.claim_job('11111111-1111-4111-8111-111111111111',60) r")).rows[0].r.job;
    const token=claim.leaseToken;
    await admin.query("update private.worker_jobs set lease_expires_at=clock_timestamp()+interval '2 seconds' where id=$1",[job]);
    await admin.query("begin");
    await admin.query("select * from private.review_summary_state where profile_id=$1 for update",[target]);
    const pid=(await s1.query('select pg_backend_pid() p')).rows[0].p;
    const pending=s1.query("select public.publish_review_summary_for_job($1,$2,$3,$4::uuid[],'합성 잠금 대기 요약','model-a','review-summary-v1') r",[job,token,revision,ids]);
    let locked=false;
    for(let i=0;i<40;i++){
      const r=await admin.query("select wait_event_type from pg_stat_activity where pid=$1",[pid]);
      if(r.rows[0]?.wait_event_type==='Lock'){locked=true;break;}
      await new Promise(r=>setTimeout(r,25));
    }
    await admin.query("select pg_sleep(2.2)");
    await admin.query("commit");
    const result=(await pending).rows[0].r;
    const state=(await admin.query("select lease_expires_at<clock_timestamp() expired,(select count(*) from private.review_summaries where profile_id=$2)::int publications from private.worker_jobs where id=$1",[job,target])).rows[0];
    console.log(JSON.stringify({projection_lock_wait_observed:locked,lease_expired:state.expired,status:result.status,publications:state.publications}));
    assert.equal(locked,true);
    assert.equal(result.status,'lease_lost','expired during projection lock wait must reject publication');
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
