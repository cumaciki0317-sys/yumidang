"""D03 원시 관측의 순수 판정. 실행·연결·시계 변경·증거 생성 권한은 없다.

모든 시각은 동일 PostgreSQL 서버의 epoch microseconds다. HTTP 최초 접수나
정책 전체 충족을 판정하지 않는다. 입력 SHA는 수집자가 저장한 원시 자료의 참조다.
"""
from dataclasses import dataclass
import re

SHA = re.compile(r"[a-f0-9]{64}\Z")

@dataclass(frozen=True)
class ReviewDeadlineObservation:
    deadline_us: int
    query_start_us: int
    observed_us: int
    released_us: int
    holder_pid: int
    waiter_pid: int
    blocking_pids: tuple[int, ...]
    matching_waiter_count: int
    wait_event_type: str
    sqlstate: str
    message: str
    original_jwt: bool
    eligible_before_lock: bool
    source_sha: str
    binding_sha: str
    before_sha: str
    blocked_sample_sha: str
    response_sha: str
    after_sha: str
    cleanup_sha: str
    own_fixture_only: bool
    preserved: bool
    cleanup_complete: bool


def classify_review_deadline(o: ReviewDeadlineObservation) -> dict:
    """특정 업무 거절만 재현으로 인정하고 부족/오염 관측은 fail closed한다."""
    reasons = []
    times = (o.query_start_us, o.observed_us, o.deadline_us, o.released_us)
    if any(type(t) is not int or t <= 0 for t in times):
        reasons.append("invalid_database_clock")
    elif not (o.query_start_us <= o.observed_us < o.deadline_us <= o.released_us):
        reasons.append("deadline_not_crossed_under_lock")
    if (type(o.holder_pid) is not int or type(o.waiter_pid) is not int
            or o.holder_pid <= 0 or o.waiter_pid <= 0 or o.holder_pid == o.waiter_pid
            or o.blocking_pids != (o.holder_pid,)
            or type(o.matching_waiter_count) is not int or o.matching_waiter_count != 1
            or o.wait_event_type != "Lock"):
        reasons.append("unproven_exact_blocking_backend")
    if o.sqlstate != "22023" or o.message != "review_unavailable":
        reasons.append("not_expected_business_rejection")
    if o.original_jwt is not True or o.eligible_before_lock is not True:
        reasons.append("authentication_or_eligibility_unproven")
    if any(not isinstance(s, str) or not SHA.fullmatch(s) for s in
           (o.source_sha, o.binding_sha, o.before_sha, o.blocked_sample_sha,
            o.response_sha, o.after_sha, o.cleanup_sha)):
        reasons.append("missing_raw_evidence_reference")
    if o.own_fixture_only is not True or o.preserved is not True or o.cleanup_complete is not True:
        reasons.append("scope_preservation_or_cleanup_unproven")
    return {"status": "INCONCLUSIVE" if reasons else "REPRODUCED_DB_ENTRY_ONLY",
            "scope": "REVIEW_DB_ENTRY_ONLY", "reasons": reasons,
            "httpIngressProven": False, "policyComplete": False,
            "runtimeExecutedByClassifier": False}
