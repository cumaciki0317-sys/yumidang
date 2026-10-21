"""D03 실행 순서 및 실제 SQL 포트. 기본 CLI NOT_RUN, root만 새 격리 대상에 조립한다.

기존 SignedRunner.prepare()는 AI 활성화 쓰기를 하므로 호출하지 않는다.
root가 원본 Auth6/HEAD/manifest/180table/13controls/VM memory·identity를 고정한
runtime을 주입해야 한다. 이 모듈은 새로운 Auth/사진/동의/운영 권한을 만들지 않는다.
"""
from dataclasses import dataclass
import json
import re
import time
from uuid import UUID


def need(value, code):
    if not value:
        raise ValueError(code)


def uid(value):
    need(type(value) is str and str(UUID(value)) == value, 'CANONICAL_UUID')
    return "'" + value + "'::uuid"


@dataclass(frozen=True)
class ReviewedDeadlineExecution:
    decision_id: str
    source_head: str
    source_pins_sha: str
    binding_sha: str
    original_receipt_sha: str
    scope_id: str
    author_id: str
    reviewer_id: str
    appointment_id: str
    post_id: str
    request_id: str
    original_session_id: str

    def validate(self):
        need(type(self.decision_id) is str and re.fullmatch('[A-Za-z0-9_.:-]{1,128}', self.decision_id), 'ROOT_DECISION')
        need(type(self.source_head) is str and re.fullmatch('[a-f0-9]{40}', self.source_head), 'EXACT_HEAD')
        for value in (self.source_pins_sha, self.binding_sha, self.original_receipt_sha):
            need(type(value) is str and re.fullmatch('[a-f0-9]{64}', value), 'EXACT_INPUT_SHA')
        need(type(self.scope_id) is str and re.fullmatch('[a-f0-9]{32}', self.scope_id), 'SCOPE_ID')
        ids = [self.author_id, self.reviewer_id, self.appointment_id, self.post_id, self.request_id, self.original_session_id]
        for value in ids: uid(value)
        need(len(set(ids)) == len(ids), 'DISTINCT_FIXTURE_IDS')


def fixture_sql(review):
    """업무 행만 생성한다. 원본 Auth/사진/프로필·기존 자원은 수정하지 않는다."""
    review.validate()
    p, j, a, author, reviewer = map(uid, (review.post_id, review.request_id, review.appointment_id, review.author_id, review.reviewer_id))
    return f"""begin;
set local statement_timeout='5s';set local lock_timeout='1s';set local plpgsql.check_asserts=on;
do $d03$ declare d timestamptz:=clock_timestamp()+interval '300 seconds';begin
 assert not exists(select 1 from public.posts where id={p}), 'd03_post_collision';
 assert not exists(select 1 from public.join_requests where id={j}), 'd03_request_collision';
 assert not exists(select 1 from public.appointments where id={a}), 'd03_appointment_collision';
 assert (select not enabled from private.content_inspection_control where singleton), 'd03_ticket_lane_not_reviewed';
 insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
 values({p},{author},'합성 D03 잠금 관측','새 격리 검증 전용','산책',d-interval '9 days',d-interval '8 days',d-interval '10 days','서울특별시 강남구 역삼동','closed');
 insert into public.join_requests(id,post_id,requester_id,message,status)
 values({j},{p},{reviewer},'합성 D03 관계','matched');
 insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
 values({a},{p},{j},'completed',d-interval '7 days','automatic',d-interval '7 days',d-interval '6 days',d);
 assert private.can_submit_appointment_review({a},{reviewer},clock_timestamp()), 'd03_not_eligible';
end $d03$;commit;"""


def waiter_sql(review, holder_pid):
    review.validate(); need(type(holder_pid) is int and holder_pid > 0, 'EXACT_HOLDER_PID')
    # query text만으로 귀속하지 않는다. 원 JWT user/session과 정확한 holder를 함께 검증한다.
    return f"""select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'backendStart',backend_start,
 'queryStartUs',(extract(epoch from query_start)*1000000)::bigint,
 'xactStartUs',(extract(epoch from xact_start)*1000000)::bigint,
 'observedUs',(extract(epoch from clock_timestamp())*1000000)::bigint,
 'waitEventType',wait_event_type,'blockingPids',pg_blocking_pids(pid))), '[]'::jsonb)
 from pg_stat_activity where datname=current_database() and pid<>{holder_pid}
 and state='active' and wait_event_type='Lock' and pg_blocking_pids(pid)=array[{holder_pid}]
 and query like '%submit_appointment_review%';"""


class DeadlineExecutor:
    """runtime은 root 검토한 고정 포트다. 자유 SQL/HTTP를 CLI에서 받지 않는다.

    필수 포트: guard(review,cleanup=False), save(name,value), verify_original_auth(review),
    snapshot(), sql(fixed_sql), verify_delta(before,after,review,cleanup), open_holder(review),
    start_original_http(review), close_owned_children(), verify_owned_backends_absent().
    holder: identity()/release_after_deadline()/close(); request: finish()/close().
    모든 raw 출력은 포트 안에서 판정 전 저장하고, save 실패도 finally 정리를 통과한다.
    """
    def __init__(self, review, runtime):
        need(type(review) is ReviewedDeadlineExecution, 'TYPED_ROOT_REVIEW_REQUIRED')
        review.validate(); self.review = review; self.runtime = runtime

    def run(self):
        r, v = self.runtime, self.review
        holder = request = None; before = None; intent = False; attempted = False; result = None; original_error = None
        try:
            r.guard(v)
            # 단일 실행 intent는 O_EXCL/fsync·0600 실제 저장으로 구현되어야 한다.
            r.save('d03-intent.json', {'sourceHead': v.source_head, 'scopeId': v.scope_id,
                    'decisionId': v.decision_id, 'noReplay': True, 'actualNaver': 'NOT_RUN'})
            intent = True
            r.verify_original_auth(v)
            before = r.snapshot(); r.save('d03-before-private.json', before)
            r.guard(v)
            # 모호한 COMMIT 성공 뒤에도 cleanup을 시도하도록 호출 전에 표시한다.
            attempted = True
            r.sql(fixture_sql(v)); r.guard(v)
            after = r.snapshot(); r.save('d03-fixture-private.json', after)
            r.verify_delta(before, after, v, cleanup=False)
            holder = r.open_holder(v)
            holder_id = holder.identity(); r.save('d03-holder-private.json', holder_id)
            need(type(holder_id) is dict and type(holder_id.get('pid')) is int
                 and holder_id['pid'] > 0 and type(holder_id.get('backendStart')) is str, 'HOLDER_IDENTITY')
            r.guard(v)
            request = r.start_original_http(v)
            end = time.monotonic() + 210
            sample = None; sample_index = 0
            while time.monotonic() < end:
                worker_error=getattr(request,'error',None)
                if worker_error is not None:raise worker_error
                r.guard(v)
                raw = r.sql(waiter_sql(v, holder_id['pid']))
                # 원시 출력부터 보존한다. 다중 waiter를 하나 선택하지 않는다.
                sample_index += 1
                r.save(f'd03-wait-sample-{sample_index:03d}-private.json', {'raw': raw})
                rows = json.loads(raw)
                need(type(rows) is list and len(rows) <= 1, 'AMBIGUOUS_DB_WAITER')
                if rows:
                    sample = rows[0]; break
                time.sleep(.05)
            need(sample is not None, 'EXACT_DB_WAITER_NOT_OBSERVED')
            r.verify_waiter_binding(v, holder_id, sample)
            release = holder.release_after_deadline()
            r.save('d03-release-private.json', release)
            response = request.finish()
            r.save('d03-response-private.json', response)
            result = {'status': 'RAW_D03_EXECUTION_COLLECTED_ONLY', 'policyComplete': False,
                      'httpIngressProven': False, 'DBJWTclaimDirectObserved': False, 'scope': 'CORRELATED_POSTGREST_DB_ENTRY_ONLY', 'response': response, 'sample': sample, 'release': release}
        except BaseException as error:
            original_error=error
            try:r.save('d03-original-failure-private.json',{'failureType':type(error).__name__,
                    'fixtureSetupAttempted':attempted,'successfulResultProduced':False})
            except BaseException as save_error:error.add_note('D03_ORIGINAL_FAILURE_SAVE_UNPROVEN:'+type(save_error).__name__)
            raise
        finally:
            # 메모리 부족을 성공으로 처리하지 않는다. cleanup에서도 source/identity guard는 필수다.
            errors = []
            for child in (request, holder):
                if child is not None:
                    try: child.close()
                    except BaseException as e: errors.append(type(e).__name__)
            if intent:
                try:
                    r.close_owned_children(); r.guard(v, cleanup=True)
                    r.verify_owned_backends_absent()
                    if attempted:
                        r.cleanup_fixture(v)
                    final = r.snapshot(); r.save('d03-cleanup-private.json', final)
                    if before is not None: r.verify_delta(before, final, v, cleanup=True)
                except BaseException as e: errors.append(type(e).__name__)
                if errors:
                    raise ValueError('D03_CLEANUP_UNPROVEN:' + ','.join(errors)) from original_error
        return result


if __name__ == '__main__':
    print(json.dumps({'status': 'NOT_RUN', 'reason': 'root의 freshsource 고정 runtime 조립 필요'}, ensure_ascii=False))


def review_payload_bytes(review):
    review.validate()
    return json.dumps({'p_appointment_id':review.appointment_id,'p_rating':3,'p_comment':None,
                       'p_experience':'neutral','p_praises':[]},sort_keys=True,separators=(',',':')).encode()


def original_review_http(origin, anon, original_jwt, review, guard, save, pre_dispatch=None):
    """실제 원 JWT PostgREST 단일 POST. worker 포트가 호출하며 자동 재시도는 없다.

    원 요청·토큰을 argv나 영수증에 저장하지 않는다. 응답 bytes를 먼저 0600 저장하는
    save는 root runtime의 보안 저장 포트여야 한다. 서버 첫 접수시각은 증명하지 않는다.
    """
    import urllib.request
    import urllib.error
    from urllib.parse import urlsplit
    review.validate()
    parsed = urlsplit(origin)
    need(parsed.scheme == 'http' and parsed.hostname == '127.0.0.1' and parsed.port is not None
         and parsed.username is None and parsed.password is None and parsed.path == ''
         and not parsed.query and not parsed.fragment, 'FIXED_LOOPBACK_ORIGIN')
    need(type(anon) is str and anon and type(original_jwt) is str and original_jwt, 'ORIGINAL_CREDENTIAL_INPUT')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args): return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    body = review_payload_bytes(review)
    request = urllib.request.Request(origin + '/rest/v1/rpc/submit_appointment_review', data=body, method='POST',
        headers={'apikey': anon, 'Authorization': 'Bearer ' + original_jwt, 'Content-Type': 'application/json', 'Accept': 'application/json'})
    guard()
    if pre_dispatch is not None:pre_dispatch()
    try:
        response = opener.open(request, timeout=360)
    except urllib.error.HTTPError as error:
        response = error
    except BaseException:
        # 응답 유실을 성공/재전송으로 바꾸지 않는다.
        save('d03-http-transport-private.json', {'status': 'UNKNOWN_RESPONSE', 'retry': False})
        raise
    try:
        raw = response.read(65537)
        save('d03-http-body-private.bin', raw)
        status = response.code
        complete = len(raw) <= 65536
    finally:
        response.close()
    save('d03-http-transport-closed-private.json',{'transportClosed':True,'httpStatus':status,'bodyComplete':complete})
    guard()
    need(complete, 'D03_HTTP_BODY_LIMIT')
    result = {'transport': 'POSTGREST_ORIGINAL_HTTP', 'status': status, 'body': json.loads(raw),
              'bodyComplete': True, 'transportClosed': True}
    save('d03-http-result-private.json', result)
    return result


def holder_open_sql(review):
    review.validate()
    return "begin;set local statement_timeout='390s';set local idle_in_transaction_session_timeout='390s';set local lock_timeout='3s';" + \
        'select id from public.appointments where id=' + uid(review.appointment_id) + ' for update;\n' + \
        "select json_build_object('pid',pg_backend_pid(),'backendStart',backend_start)from pg_stat_activity where pid=pg_backend_pid();\n"


def holder_release_sql(review):
    review.validate()
    # 잠금 보유 세션의 실제 DB 시계로 기다린다. 서버 시계/GUC를 조작하지 않는다.
    return 'select pg_sleep(greatest(0,extract(epoch from(review_deadline_at-clock_timestamp()))))from public.appointments where id=' + uid(review.appointment_id) + ';\n' + \
        "select json_build_object('releasedUs',(extract(epoch from clock_timestamp())*1000000)::bigint);commit;\n"


class ReviewedFastDeadlineExecutor(DeadlineExecutor):
    """별도 root typed fastphase만 사용한다. 기본/과거 실행기의 FAIL 판정을 바꾸지 않는다."""
    def __init__(self,review,runtime,fast_review):
        super().__init__(review,runtime);self.fast_review=fast_review
    def run(self):
        r,v=self.runtime,self.review;before=None;attempted=False;result=None;original=None
        try:
            r.guard(v);r.save('d03-intent.json',{'scopeId':v.scope_id,'sourceHead':v.source_head,'noReplay':True})
            r.verify_original_auth(v);seal=r.prepare_fast_phase(self.fast_review)
            before=r.snapshot();r.save('d03-before-private.json',before)
            attempted=True;r.sql(fixture_sql(v));after=r.snapshot();r.save('d03-fixture-private.json',after)
            r.verify_delta(before,after,v,cleanup=False)
            result=r.run_fast_phase(seal)
        except BaseException as error:
            original=error
            r.save('d03-fast-not-proven-private.json',{'status':'NOT_PROVEN','errorType':type(error).__name__,'automaticReplay':False})
            result={'status':'NOT_PROVEN','scope':'CORRELATED_POSTGREST_DB_ENTRY_ONLY','policyComplete':False,'httpIngressProven':False}
        finally:
            try:
                r.close_owned_children();r.guard(v,cleanup=True);r.verify_owned_backends_absent()
                if attempted:r.cleanup_fixture(v)
                final=r.snapshot();r.save('d03-cleanup-private.json',final)
                if before is not None:r.verify_delta(before,final,v,cleanup=True)
            except BaseException as cleanup_error:
                raise ValueError('D03_FAST_CLEANUP_UNPROVEN')from(original or cleanup_error)
        return result


def fast_holder_release_sql(review):
    """커밋 완료 뒤의 DB 시각만 실제 lock release의 보수적인 상한으로 사용한다."""
    review.validate()
    return 'select pg_sleep(greatest(0,extract(epoch from(review_deadline_at-clock_timestamp()))))from public.appointments where id='+uid(review.appointment_id)+';\ncommit;\n'+\
        "select json_build_object('releasedUs',(extract(epoch from clock_timestamp())*1000000)::bigint,'actualCommitCompletedUpperBound',true);\n"
