/** Explicit local-only PostgreSQL integration; commits synthetic data and removes it in finally. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { startCompletionRunner } from "../../../backend/supabase/functions/scheduled-jobs/completion-runner.mjs";
const { Client } = createRequire(new URL("../../../backend/package.json", import.meta.url))("pg");
const databaseUrl = process.env.REVIEW_POLICY_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("EXPLICIT_LOCAL_TEST_DATABASE_REQUIRED");
const target = new URL(databaseUrl);
if (!["postgres:", "postgresql:"].includes(target.protocol) || target.hostname !== "127.0.0.1" ||
    target.port !== "55422" || target.pathname !== "/postgres" || target.search || target.hash) {
  throw new Error("DEDICATED_LOCAL_DATABASE_ONLY");
}

test("real DB notifications, due timers, reschedule/cancel, reconnect, races and immediate review reads", { timeout: 30_000 }, async (t) => {
  const db = new Client({ connectionString: databaseUrl, ssl: false, statement_timeout: 5000 });
  const second = new Client({ connectionString: databaseUrl, ssl: false, statement_timeout: 5000 });
  const author = randomUUID(), peer = randomUUID(), appointments = [], reports = [], workerClients = [];
  let runner;
  class WorkerClient extends Client {
    constructor(config) { super(config); workerClients.push(this); }
    async connect() { await super.connect(); await this.query("set role service_role"); }
  }
  const start = () => startCompletionRunner({ Client: WorkerClient,
    // Test timing values only; production values must be explicitly configured.
    config: { databaseUrl, ssl: false, reconnectMs: 100, queryTimeoutMs: 2000 },
    report: (code) => reports.push(code) });
  async function until(check) {
    const end = performance.now() + 6000;
    while (performance.now() < end) { const value = await check(); if (value) return value; await delay(20); }
    assert.fail("local integration condition timed out");
  }
  async function fixture(dueMs) {
    const post = randomUUID(), request = randomUUID(), id = randomUUID(); appointments.push(id);
    await db.query("begin");
    try {
      await db.query(`insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)
        values($1,$2,'예약 실행 검증','가상 로컬 검증','산책',clock_timestamp()-interval '3 days',
          clock_timestamp()-interval '24 hours'+$3*interval '1 millisecond',clock_timestamp()-interval '4 days','서울특별시 강남구 역삼동')`, [post, author, dueMs]);
      await db.query("insert into public.join_requests(id,post_id,requester_id,message,status) values($1,$2,$3,'가상 예약 검증 신청입니다','matched')", [request, post, peer]);
      await db.query("insert into public.appointments(id,post_id,join_request_id,status) values($1,$2,$3,'confirmed')", [id, post, request]);
      const reservation = (await db.query("select * from private.completion_reservations where appointment_id=$1", [id])).rows[0];
      await db.query("commit");
      return { id, post, request, ...reservation };
    } catch (error) { await db.query("rollback"); throw error; }
  }
  const completed = async (id) => (await db.query("select * from public.appointments where id=$1 and status='completed'", [id])).rows[0];
  const assertNotifications = async (request) => assert.equal(Number((await db.query(
    "select count(*) n from public.notifications where kind='appointment_completed' and join_request_id=$1", [request])).rows[0].n), 2);
  try {
    await db.connect(); await second.connect();
    // This suite requires the isolated test database, never shared participant data.
    assert.equal(Number((await db.query("select count(*) n from auth.users")).rows[0].n), 0);
    await db.query("insert into auth.users(id) values($1),($2)", [author, peer]);
    await db.query("insert into public.profiles(id,real_name,birth_date) values($1,'예약작성자','1990-01-01'),($2,'예약상대방','1990-01-01')", [author, peer]);
    runner = start(); await runner.ready;
    assert.ok(reports.includes("COMPLETION_SCHEDULER_READY"));
    let timed;
    await t.test("committed reservation wakes LISTEN worker and completes at due time", async () => {
      timed = await fixture(500);
      const result = await until(() => completed(timed.id));
      assert.ok(result.completed_at >= timed.due_at);
      assert.equal(result.review_deadline_at - result.completed_at, 7 * 86400_000);
      assert.equal(+result.completion_notified_at, +result.completed_at);
      await assertNotifications(timed.request);
    });
    await t.test("reschedule rejects old generation; cancellation and dispute remove reservations", async () => {
      const moved = await fixture(500), cancelled = await fixture(500), disputed = await fixture(500);
      await db.query("update public.posts set ends_at=clock_timestamp()-interval '24 hours'+interval '1 second' where id=$1", [moved.post]);
      const stale = (await db.query("select public.execute_completion_reservation($1,$2) result", [moved.id, moved.generation])).rows[0].result;
      assert.equal(stale.status, "stale");
      await db.query("update public.appointments set status='cancelled' where id=$1", [cancelled.id]);
      await db.query("insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining) values($1,$2,'가상 분쟁 예약 차단',interval '1 day')", [disputed.id, peer]);
      await until(() => completed(moved.id));
      assert.equal(await completed(cancelled.id), undefined); assert.equal(await completed(disputed.id), undefined);
      assert.equal(Number((await db.query("select count(*) n from private.completion_reservations where appointment_id=any($1::uuid[])", [[cancelled.id, disputed.id]])).rows[0].n), 0);
    });
    await t.test("connection loss resubscribes and recovers overdue committed reservation", async () => {
      const readyCount = reports.filter((code) => code === "COMPLETION_SCHEDULER_READY").length;
      await db.query("select pg_terminate_backend($1)", [workerClients.at(-1).processID]);
      const overdue = await fixture(-1000);
      await until(() => completed(overdue.id));
      await until(async () => reports.filter((code) => code === "COMPLETION_SCHEDULER_READY").length > readyCount);
      assert.ok(reports.includes("COMPLETION_CONNECTION_UNAVAILABLE")); await assertNotifications(overdue.request);
    });
    await runner.stop(); runner = undefined;
    await t.test("appointment creation waits for concurrent end-time update and reserves the committed time", async () => {
      const item = await fixture(100_000);
      await db.query("delete from public.appointments where id=$1", [item.id]);
      await db.query("begin");
      let insertion;
      try {
        await db.query("update public.posts set ends_at=ends_at+interval '1 hour' where id=$1", [item.post]);
        insertion = second.query("insert into public.appointments(id,post_id,join_request_id,status) values($1,$2,$3,'confirmed')", [item.id, item.post, item.request]);
        await until(async () => (await db.query("select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1", [second.processID])).rows[0]?.waiting);
        await db.query("commit"); await insertion;
        assert.equal((await db.query(`select r.due_at=p.ends_at+interval '24 hours' matched
          from private.completion_reservations r join public.appointments a on a.id=r.appointment_id
          join public.posts p on p.id=a.post_id where a.id=$1`, [item.id])).rows[0].matched, true);
        await db.query("update public.appointments set status='cancelled' where id=$1", [item.id]);
      } finally { await db.query("rollback"); await insertion?.catch(() => {}); }
    });
    await t.test("two sessions execute same reservation only once", async () => {
      const due = await fixture(-1000);
      const results = await Promise.all([db, second].map(async (client) => (await client.query(
        "select public.execute_completion_reservation($1,$2) result", [due.id, due.generation])).rows[0].result.status));
      assert.deepEqual(results.sort(), ["completed", "stale"]); await assertNotifications(due.request);
    });
    await t.test("both real submissions release immediately; post-hold submission also releases without maintenance", async () => {
      const submit = async (uid, id) => {
        await db.query("set role authenticated");
        await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]);
        return (await db.query("select public.submit_appointment_review($1,5,'가상 후기 원문','neutral','{}') result", [id])).rows[0].result;
      };
      await submit(author, timed.id);
      assert.equal((await db.query("select released from public.get_appointment_review_state($1)", [timed.id])).rows[0].released, false);
      await submit(peer, timed.id);
      const state = (await db.query("select * from public.get_appointment_review_state($1)", [timed.id])).rows[0];
      assert.equal(state.released, true); assert.equal(state.release_reason, "mutual"); assert.ok(state.peer_review);
      assert.ok(state.hold_until > new Date());
      await db.query("reset role");
      const late = await fixture(-1000);
      await db.query("select public.execute_completion_reservation($1,$2)", [late.id, late.generation]);
      await db.query(`update public.appointments set completed_at=statement_timestamp()-interval '2 days',
        completion_notified_at=statement_timestamp()-interval '2 days',dispute_deadline_at=statement_timestamp()-interval '1 day',
        review_deadline_at=statement_timestamp()+interval '5 days' where id=$1`, [late.id]);
      await submit(author, late.id);
      const lateState = (await db.query("select * from public.get_appointment_review_state($1)", [late.id])).rows[0];
      assert.equal(lateState.released, true); assert.equal(lateState.release_reason, "hold_elapsed");
      await db.query("reset role");
      await db.query(`update public.appointments set completed_at=statement_timestamp()-interval '8 days',
        completion_notified_at=statement_timestamp()-interval '8 days',dispute_deadline_at=statement_timestamp()-interval '7 days',
        review_deadline_at=statement_timestamp()-interval '1 day' where id=$1`, [late.id]);
      await assert.rejects(submit(peer, late.id), (error) => error.code === "22023" && error.message === "review_unavailable");
      await db.query("reset role");
    });
    await t.test("process restart recovers reservations committed while stopped", async () => {
      const due = await fixture(-1000);
      runner = start(); await runner.ready;
      await until(() => completed(due.id)); await assertNotifications(due.request);
    });
  } finally {
    await runner?.stop();
    try {
      await db.query("reset role"); await db.query("rollback");
      await db.query("delete from public.appointments where id=any($1::uuid[])", [appointments]);
      await db.query("delete from auth.users where id=any($1::uuid[])", [[author, peer]]);
      assert.equal(Number((await db.query("select count(*) n from auth.users where id=any($1::uuid[])", [[author, peer]])).rows[0].n), 0);
    } finally { await Promise.allSettled([db.end(), second.end()]); }
  }
});
