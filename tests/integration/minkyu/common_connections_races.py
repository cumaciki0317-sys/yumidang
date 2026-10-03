#!/usr/bin/env python3
"""빈 ordered 전용 로컬 DB에서 예산·요약 게시/비공개·행사 저장 독립 세션 경합을 검사한다.

외부 모델 호출·원격 URL·CLI 환경 관리는 없으며 고유 합성 자료만 정리한다.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import uuid
import matching_races as local

local.PROJECT = "yumidang-minkyu-ordered"
local.CONTAINER = "supabase_db_yumidang-minkyu-ordered"
stage = "target"


def execute():
    global stage
    local.verify_target()
    local.require(local.sql("select to_regclass('private.ai_budget_ledgers') is not null and "
        "to_regclass('private.review_summary_checkpoints') is not null and "
        "to_regclass('private.source_events') is not null and "
        "(select relkind='v' from pg_class where oid='private.events'::regclass) and "
        "not exists(select 1 from private.worker_jobs) and not exists(select 1 from private.ai_budget_ledgers) and "
        "not exists(select 1 from private.source_events);").stdout.strip() == "t")
    run_id = uuid.uuid4().hex
    author, target = str(uuid.uuid4()), str(uuid.uuid4())
    ledger = "common-race-" + run_id
    provider = "common-" + run_id[:16]
    job_ids = []
    review_ids = []
    service = "set local role service_role;"

    def rpc(query):
        return local.objects(local.sql("begin;" + service + query + "commit;"))[0]

    def race(label, query_a, query_b, key):
        global stage
        phase = stage
        name_a, name_b = "ym_match_common_" + label + "_a", "ym_match_common_" + label + "_b"
        with ThreadPoolExecutor(max_workers=2) as pool, local.Barrier(key) as barrier:
            a = pool.submit(local.sql, "begin;set application_name=" + local.literal(name_a) + ";" + service +
                            query_a + f"select pg_advisory_xact_lock({key});commit;")
            stage = phase + "_first_lock"
            local.wait_locked(name_a)
            b = pool.submit(local.sql, "begin;set application_name=" + local.literal(name_b) + ";" + service + query_b + "commit;")
            stage = phase + "_second_lock"
            local.wait_locked(name_b)
            barrier.release()
            first, second = a.result(), b.result()
            local.require(first.returncode == 0 and second.returncode == 0)
            stage = phase
            return local.objects(first), local.objects(second)

    def summary_job(suffix):
        global stage
        phase = stage
        stage = phase + "_snapshot"
        snapshot = rpc(f"select public.load_public_review_snapshot('{target}');")
        revision = snapshot["sourceRevision"]
        ids = sorted(row["reviewId"] for row in snapshot["reviews"])
        local.require(len(ids) == 3)
        payload = json.dumps({"profileId": target, "sourceRevision": revision, "modelVersion": "common-model", "promptVersion": "common-prompt"})
        job = rpc("select public.enqueue_job('review_summary'," + local.literal(ledger + "-" + suffix) + "," + local.literal(payload) + ",clock_timestamp());")["jobId"]
        job_ids.append(job)
        stage = phase + "_claim"
        claim = rpc(f"select public.claim_job('{uuid.uuid4()}',60);")["job"]
        local.require(claim["jobId"] == job)
        cp = {"schemaVersion": 1, "sourceReviewIds": ids, "nextReviewIndex": 1,
              "nodes": [{"sourceReviewIds": ids[:1], "claims": [{"text": "합성 중간 주장", "evidenceIds": ids[:1]}], "modelVersions": ["potens.synthetic"]}]}
        stage = phase + "_checkpoint"
        saved = rpc(f"select public.save_review_summary_checkpoint('{job}','{claim['leaseToken']}',{local.literal(revision)}," + local.literal(json.dumps(cp, ensure_ascii=False)) + "::jsonb);")
        local.require(saved["status"] == "applied")
        evidence = "array[" + ",".join(local.literal(value) + "::uuid" for value in ids) + "]"
        publish = f"select public.publish_review_summary_for_job('{job}','{claim['leaseToken']}',{local.literal(revision)},{evidence},'합성 공개 요약','common-model','common-prompt');"
        stage = phase
        return job, claim["leaseToken"], publish

    def event(source, title, collected):
        return {"provider": provider, "sourceId": source, "sourceStatus": "active", "title": title,
                "category": "전시", "region": "가상시", "placeName": None, "publicAddress": None,
                "admission": {"kind": "unknown"}, "sourceUrl": None, "collectedAt": collected,
                "precision": "date", "startsOn": "2099-01-01", "endsOn": "2099-01-02"}

    def upsert(records):
        return "select public.upsert_events(" + local.literal(json.dumps(records, ensure_ascii=False)) + "::jsonb);"

    try:
        stage = "atomic_budget_two_reservations"
        rpc(f"select public.configure_ai_budget_ledger('{ledger}',100,10);")
        query = f"select public.reserve_ai_budget('{ledger}','potens','review_chunk',60);"
        a, b = race("budget", query, query, 73114001)
        local.require(a[0]["reservationId"] is not None and b[0]["reservationId"] is None)
        local.require(rpc(f"select public.get_ai_budget_ledger('{ledger}');")["reservedUnits"] == 60)

        stage = "summary_fixture"
        fixture = "begin;do $$ begin perform set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);end $$;"
        fixture += f"insert into auth.users(id) values('{author}'),('{target}');insert into public.profiles(id,real_name,birth_date,gender) values('{author}','합성 요약작성자','1990-01-01','female'),('{target}','합성 요약대상자','1990-01-01','female');"
        for index in range(3):
            post, request, ap, review = [str(uuid.uuid4()) for _ in range(4)]
            review_ids.append(review)
            fixture += f"""insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
            values('{post}','{author}','합성 요약 경합','전용 로컬 검증','산책',now()-interval '4 days',now()-interval '3 days',now()-interval '5 days','서울특별시 강남구 역삼동','closed');
            insert into public.join_requests(id,post_id,requester_id,message,status) values('{request}','{post}','{target}','합성 요약 경합 신청','matched');
            insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
            values('{ap}','{post}','{request}','completed',now()-interval '2 days','automatic',now(),now()+interval '24 hours',now()+interval '5 days');
            insert into public.appointment_reviews(id,appointment_id,reviewer_id,rating,comment,experience)
            values('{review}','{ap}','{author}',5,'COMMON_RACE_SYNTHETIC_{index}','positive');"""
        local.sql(fixture + "commit;")

        stage = "publish_then_hide_invalidates"
        job, token, publish = summary_job("publish-hide")
        first, _ = race("publish", publish, f"select public.set_review_publication('{review_ids[0]}',false);", 73114002)
        stage = "publish_then_hide_result"
        local.require(first[0]["status"] == "applied")
        stage = "publish_then_hide_projection"
        local.require(local.sql(f"select visible_summary_id is null and not exists(select 1 from private.review_summary_checkpoints where job_id='{job}') from private.review_summary_state where profile_id='{target}';").stdout.strip() == "t")
        stage = "publish_then_hide_fixture_restore"
        rpc(f"select public.complete_job('{job}','{token}');")
        local.sql("begin;" + service + f"select public.set_review_publication('{review_ids[0]}',true);commit;")

        stage = "hide_then_publish_stale_revision"
        job, token, publish = summary_job("hide-publish")
        _, second = race("hide", f"select public.set_review_publication('{review_ids[0]}',false);", publish, 73114003)
        local.require(second[0]["status"] == "stale_revision")
        local.require(local.sql(f"select count(*) from private.review_summary_checkpoints where job_id='{job}';").stdout.strip() == "0")
        rpc(f"select public.supersede_job('{job}','{token}');")

        stage = "events_reverse_batch_stale_deduplication"
        old = [event("a", "이전 합성 행사", "2026-10-02T00:00:00.000Z"), event("b", "이전 합성 행사", "2026-10-02T00:00:00.000Z")]
        new = [event("b", "최신 합성 행사", "2026-10-03T00:00:00.000Z"), event("a", "최신 합성 행사", "2026-10-03T00:00:00.000Z")]
        a, b = race("events", upsert(old), upsert(new), 73114004)
        local.require(a[0]["insertedCount"] == 2 and b[0]["updatedCount"] == 2)
        local.require(rpc(upsert(old))["staleCount"] == 2 and rpc(upsert(new))["staleCount"] == 2)
        local.require(local.sql(f"select count(*)=2 and bool_and(record->>'title'='최신 합성 행사') from private.source_events where provider='{provider}';").stdout.strip() == "t")
        return {"status": "PASS", "races": 4, "cleanup": "PASS", "scope": "dedicated_disposable_local_database"}
    finally:
        previous = stage
        stage = "cleanup"
        local.sql(f"""begin;delete from private.worker_jobs where dedupe_key like '{ledger}-%';
        delete from public.posts where author_id in('{author}','{target}');
        delete from auth.users where id in('{author}','{target}');
        delete from private.ai_budget_ledgers where ledger_id='{ledger}';
        delete from private.source_events where provider='{provider}';commit;""")
        local.require(local.sql("""select (select count(*) from auth.users)+(select count(*) from public.profiles)+
        (select count(*) from private.worker_jobs)+(select count(*) from private.ai_budget_ledgers)+
        (select count(*) from private.ai_budget_reservations)+(select count(*) from private.source_events)+
        (select count(*) from private.review_summary_checkpoints)+(select count(*) from private.review_summary_job_publications);""").stdout.strip() == "0")
        stage = previous


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    report = {"status": "NOT_RUN", "result": "EXPLICIT_RUN_REQUIRED"}
    if args.run:
        try:
            local.verify_target()
            with local.Barrier(73114000):
                report = execute()
        except Exception as error:
            safe_codes = {"LOCAL_RACE_CHECK_FAILED", "LOCAL_RACE_BARRIER_TIMEOUT", "LOCAL_SQL_FAILED"}
            code = str(error) if str(error) in safe_codes else type(error).__name__
            report = {"status": "FAIL", "stage": stage, "result": "LOCAL_RACE_OR_TARGET_CHECK_FAILED", "reason": code, **(local.diagnostic or {})}
    print(json.dumps(report))
    return 0 if report["status"] == "PASS" else 2 if report["status"] == "NOT_RUN" else 1


if __name__ == "__main__":
    raise SystemExit(main())
