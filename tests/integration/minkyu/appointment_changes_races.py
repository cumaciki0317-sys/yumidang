#!/usr/bin/env python3
"""전용 빈 ordered 로컬 DB의 확정 일정 변경·취소 독립 세션 경합 검사.

CLI 시작/중지·외부 네이버 호출은 하지 않는다. 합성 UUID만 생성/정리한다.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import uuid
import matching_races as local

# 기존의 전용 소켓·프로젝트 label guard/psql/독립 세션 barrier를 재사용한다.
# CLI 입력으로 대상 프로젝트나 URL을 바꿀 수 없다.
local.PROJECT = "yumidang-minkyu-ordered"
local.CONTAINER = "supabase_db_yumidang-minkyu-ordered"
stage = "target"


def execute():
    global stage
    local.verify_target()
    local.require(local.sql("select to_regclass('private.appointment_schedule_changes') is not null and "
                            "to_regclass('private.completion_reservations') is not null and "
                            "to_regprocedure('public.cancel_appointment(uuid,uuid,text)') is not null;").stdout.strip() == "t")
    people = [str(uuid.uuid4()) for _ in range(4)]
    sessions = [str(uuid.uuid4()) for _ in people]
    run_id = uuid.uuid4().hex

    def actor(index):
        claims = json.dumps({"role": "authenticated", "sub": people[index], "session_id": sessions[index]})
        return ("set local role authenticated;do $$ begin perform set_config('request.jwt.claim.sub'," +
                local.literal(people[index]) + ",true);perform set_config('request.jwt.claims'," +
                local.literal(claims) + ",true);end $$;")

    def rpc(index, query):
        return local.objects(local.sql("begin;" + actor(index) + query + "commit;"))[0]

    def appointment(author, peer, day):
        pid = str(uuid.uuid4())
        start = datetime.now(timezone.utc) + timedelta(days=day)
        end = start + timedelta(hours=2)
        data = {"title": "가상 확정 일정 경합", "description": "전용 로컬 합성 데이터", "category": "산책",
                "startsAt": start.isoformat(), "endsAt": end.isoformat(),
                "recruitmentEndsAt": (start-timedelta(hours=1)).isoformat(), "publicArea": "서울특별시 강남구 역삼동",
                "registeredPlaceName": "가상 장소", "registeredAddress": "합성 비공개 주소", "meetingDetail": "가상 입구",
                "preferenceNote": None, "tags": [], "costType": "free", "amount": 0}
        rpc(author, f"select public.create_service_post('{pid}',{local.literal(json.dumps(data, ensure_ascii=False))}::jsonb);")
        request = rpc(peer, f"select public.request_service_post('{pid}','합성 경합 동행 신청');")["id"]
        version = rpc(author, f"select public.propose_match('{request}');")["conditionVersion"]
        apid = rpc(peer, f"select public.accept_match('{request}',{local.literal(version)});")["appointmentId"]
        updated = local.sql(f"select updated_at from public.posts where id='{pid}';").stdout.strip()
        return apid, pid, start, end, updated

    def propose_query(ap, change, start, end):
        return (f"select public.propose_appointment_schedule_change('{ap[0]}','{change}'," +
                local.literal(start.isoformat()) + "::timestamptz," + local.literal(end.isoformat()) +
                "::timestamptz," + local.literal(ap[4]) + "::timestamptz);")

    def accept_query(ap, change, version):
        return f"select public.accept_appointment_schedule_change('{ap[0]}','{change}',{local.literal(version)});"

    def race(label, first_actor, first_query, second_actor, second_query, key):
        name_a, name_b = "ym_match_change_" + label + "_a", "ym_match_change_" + label + "_b"
        with ThreadPoolExecutor(max_workers=2) as pool, local.Barrier(key) as barrier:
            first = pool.submit(local.sql, "begin;set application_name=" + local.literal(name_a) + ";" +
                                actor(first_actor) + first_query + f"select pg_advisory_xact_lock({key});commit;")
            local.wait_locked(name_a)
            second = pool.submit(local.sql, "begin;set application_name=" + local.literal(name_b) + ";" +
                                 actor(second_actor) + second_query + "commit;", True)
            local.wait_locked(name_b)
            barrier.release()
            a, b = first.result(), second.result()
            local.require(a.returncode == 0 and b.returncode != 0 and "40001" in b.stderr)

    try:
        stage = "fixture"
        fixture = "begin;"
        for uid, sid in zip(people, sessions):
            alias, image = str(uuid.uuid4())+"@naver.yumidang.invalid", str(uuid.uuid4())
            subject = "appointment-race-" + run_id + "-" + uid
            path = uid + "/" + image + ".jpg"
            fixture += f"""insert into auth.users(id,email) values('{uid}','{alias}');
            insert into auth.sessions(id,user_id) values('{sid}','{uid}');
            insert into public.profiles(id,real_name,birth_date,gender,avatar_url) values('{uid}','가상 일정 경합회원','1990-01-01','female','{path}');
            insert into storage.objects(bucket_id,name,owner_id,metadata) values('profile-images','{path}','{uid}','{{"mimetype":"image/jpeg","size":128}}');
            insert into private.naver_accounts(subject,auth_email,user_id,real_name,birth_date,gender,verification_status,completed_at)
            values('{subject}','{alias}','{uid}','가상 일정 경합회원','1990-01-01','female','qualified',clock_timestamp());
            insert into private.naver_sessions(session_id,user_id,subject) values('{sid}','{uid}','{subject}');"""
        local.sql(fixture + "commit;")

        stage = "two_proposals_single_pending"
        ap = appointment(0, 2, 5)
        first, second = str(uuid.uuid4()), str(uuid.uuid4())
        race("proposal", 0, propose_query(ap, first, ap[2]+timedelta(days=1), ap[3]+timedelta(days=1)),
             2, propose_query(ap, second, ap[2]+timedelta(days=2), ap[3]+timedelta(days=2)), 73113001)
        local.require(local.sql(f"select count(*) from private.appointment_schedule_changes where appointment_id='{ap[0]}' and status='awaiting_response';").stdout.strip() == "1")

        stage = "cancellation_vs_acceptance"
        ap = appointment(0, 2, 10)
        change, cancel = str(uuid.uuid4()), str(uuid.uuid4())
        proposal = rpc(0, propose_query(ap, change, ap[2]+timedelta(days=1), ap[3]+timedelta(days=1)))
        race("cancel", 0, f"select public.cancel_appointment('{ap[0]}','{cancel}','합성 경합 취소');",
             2, accept_query(ap, change, proposal["conditionVersion"]), 73113002)
        local.require(local.sql(f"select status='cancelled' and not exists(select 1 from private.completion_reservations where appointment_id='{ap[0]}') from public.appointments where id='{ap[0]}';").stdout.strip() == "t")

        stage = "two_acceptances_same_member_overlap"
        a, b = appointment(0, 2, 15), appointment(1, 2, 20)
        target = datetime.now(timezone.utc) + timedelta(days=30)
        ca, cb = str(uuid.uuid4()), str(uuid.uuid4())
        va = rpc(0, propose_query(a, ca, target, target+timedelta(hours=2)))["conditionVersion"]
        vb = rpc(1, propose_query(b, cb, target, target+timedelta(hours=2)))["conditionVersion"]
        race("overlap", 2, accept_query(a, ca, va), 2, accept_query(b, cb, vb), 73113003)
        local.require(local.sql(f"select count(*) from private.appointment_schedule_changes where change_id in('{ca}','{cb}') and status='accepted';").stdout.strip() == "1")
        return {"status": "PASS", "races": 3, "cleanup": "PASS", "scope": "dedicated_disposable_local_database"}
    finally:
        previous = stage
        stage = "cleanup"
        ids = ",".join(local.literal(uid) for uid in people)
        local.sql(f"""begin;set local storage.allow_delete_query='true';
        delete from public.posts where author_id in({ids});
        delete from private.naver_accounts where user_id in({ids});
        delete from public.profiles where id in({ids});
        delete from storage.objects where bucket_id='profile-images' and owner_id in({ids});
        delete from auth.users where id in({ids});commit;""")
        local.require(local.sql("select (select count(*) from auth.users)+(select count(*) from public.profiles)+"
                                "(select count(*) from private.naver_accounts)+(select count(*) from private.naver_sessions);").stdout.strip() == "0")
        stage = previous


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    report = {"status": "NOT_RUN", "result": "EXPLICIT_RUN_REQUIRED"}
    if args.run:
        try:
            local.verify_target()
            with local.Barrier(73113000):
                report = execute()
        except Exception:
            report = {"status": "FAIL", "stage": stage, "result": "LOCAL_RACE_OR_TARGET_CHECK_FAILED", **(local.diagnostic or {})}
    print(json.dumps(report))
    return 0 if report["status"] == "PASS" else 2 if report["status"] == "NOT_RUN" else 1


if __name__ == "__main__":
    raise SystemExit(main())
