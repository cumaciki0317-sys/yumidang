"""원시 DB-entry 관측 판정 회귀. 실제 SQL/Auth/HTTP 검증이 아니다."""
from dataclasses import replace
import importlib.util
from pathlib import Path
import sys
import unittest

PATH = Path(__file__).resolve().parents[2] / "integration/minkyu/deadline_lock_evidence.py"
SPEC = importlib.util.spec_from_file_location("deadline_lock_evidence", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

class DeadlineEvidenceTests(unittest.TestCase):
    def baseline(self):
        return MODULE.ReviewDeadlineObservation(
            deadline_us=100, query_start_us=80, observed_us=90, released_us=110,
            holder_pid=10, waiter_pid=20, blocking_pids=(10,), matching_waiter_count=1,
            wait_event_type="Lock", sqlstate="22023", message="review_unavailable",
            original_jwt=True, eligible_before_lock=True, source_sha="a"*64,
            binding_sha="b"*64, before_sha="c"*64, blocked_sample_sha="d"*64,
            response_sha="e"*64, after_sha="f"*64, cleanup_sha="0"*64,
            own_fixture_only=True, preserved=True, cleanup_complete=True)

    def reject(self, **changes):
        result = MODULE.classify_review_deadline(replace(self.baseline(), **changes))
        self.assertEqual("INCONCLUSIVE", result["status"])
        self.assertFalse(result["policyComplete"])

    def test_exact_crossing_is_only_db_entry_reproduction(self):
        result = MODULE.classify_review_deadline(self.baseline())
        self.assertEqual("REPRODUCED_DB_ENTRY_ONLY", result["status"])
        self.assertFalse(result["httpIngressProven"])
        self.assertFalse(result["runtimeExecutedByClassifier"])
        self.assertFalse(result["policyComplete"])

    def test_observation_at_deadline_is_not_timely(self):
        self.reject(observed_us=100)

    def test_release_at_deadline_counts_as_crossing(self):
        result = MODULE.classify_review_deadline(replace(self.baseline(), released_us=100))
        self.assertEqual("REPRODUCED_DB_ENTRY_ONLY", result["status"])

    def test_release_before_deadline_does_not_reproduce(self):
        self.reject(released_us=99)

    def test_query_not_started_at_observation(self):
        self.reject(query_start_us=91)

    def test_clock_bool_or_float_rejected(self):
        for value in (True, 90.0, -1, 0):
            with self.subTest(value=value): self.reject(observed_us=value)

    def test_exact_holder_only_required(self):
        for blockers in ((), (11,), (10, 11), (10, 10)):
            with self.subTest(blockers=blockers): self.reject(blocking_pids=blockers)

    def test_backend_identity_must_be_distinct(self):
        self.reject(waiter_pid=10)
        self.reject(holder_pid=True)
        self.reject(waiter_pid=0)

    def test_ambiguous_waiter_rejected(self):
        for count in (0, 2, True):
            with self.subTest(count=count): self.reject(matching_waiter_count=count)

    def test_timeout_is_not_business_failure(self):
        self.reject(sqlstate="57014", message="canceling statement due to statement timeout")

    def test_other_validation_error_not_deadline_failure(self):
        self.reject(message="invalid_review")
        self.reject(sqlstate="28000", message="login_required")

    def test_lock_wait_required(self):
        self.reject(wait_event_type="Client")

    def test_auth_and_eligibility_required(self):
        self.reject(original_jwt=False)
        self.reject(eligible_before_lock=False)

    def test_every_raw_phase_reference_required(self):
        for field in ("source_sha", "binding_sha", "before_sha", "blocked_sample_sha",
                      "response_sha", "after_sha", "cleanup_sha"):
            with self.subTest(field=field): self.reject(**{field: ""})
        self.reject(response_sha="A"*64)

    def test_scope_cleanup_and_preservation_required(self):
        self.reject(own_fixture_only=False)
        self.reject(preserved=False)
        self.reject(cleanup_complete=False)

if __name__ == "__main__": unittest.main()
