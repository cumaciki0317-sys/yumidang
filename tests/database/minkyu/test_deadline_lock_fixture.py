"""D03 순수 계획 회귀. 실제 DB/Auth/HTTP 실행은 포함하지 않는다."""
from datetime import date
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('deadline_fixture', ROOT / 'tests/integration/minkyu/deadline_lock_fixture.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class FixturePlanTests(unittest.TestCase):
    def actors(self):
        return [m.qualified_actor(n, user_id=m.fixture_id(n + 60), session_id=m.fixture_id(n + 40), birth_date=date(1990, 1, 1),
                                 today=date(2026, 10, 21), image_size=100) for n in (1, 2)]

    def pins(self):
        return m.source_pins({p: (ROOT / p).read_bytes() for p in m.SOURCES})

    def plan(self):
        return m.make_plan(self.actors(), self.pins())

    def test_plan_does_not_claim_execution_or_qualification_evidence(self):
        p = self.plan()
        self.assertEqual(p['status'], 'NOT_RUN')
        self.assertFalse(p['executionReady'])
        self.assertFalse(p['sourceReviewApproved'])
        self.assertIn('PENDING_ORIGINAL_JWT_RECEIPT', p['identityBinding'])
        self.assertFalse(p['classifier']['executed'])
        self.assertFalse(p['classifier']['httpIngressProven'])
        self.assertEqual(p['providerCalls'], 0)
        self.assertEqual(len(p['businessRowsCandidate']), 7)
        self.assertEqual(len(p['qualificationRowsCandidate']), 14)
        self.assertIn('actual_catalog_trigger_and_owner_snapshot', p['unresolved'])

    def test_exact_qualification_and_image_contract(self):
        for actor in self.actors():
            self.assertEqual(actor['storage']['owner_id'], actor['userId'])
            self.assertTrue(actor['avatarPath'].startswith(actor['userId'] + '/'))
            self.assertTrue(actor['avatarPath'].endswith('.jpg'))
            self.assertEqual(actor['storage']['metadata']['mimetype'], 'image/jpeg')
            self.assertTrue(actor['completedAtRequired'])
        for size in (0, 2097153, True):
            with self.assertRaises(ValueError):
                m.qualified_actor(1, user_id=m.fixture_id(61), session_id=m.fixture_id(41), birth_date=date(1990, 1, 1), today=date(2026, 1, 1), image_size=size)

    def test_nineteenth_birthday_boundary(self):
        for today, allowed in ((date(2026, 10, 20), False), (date(2026, 10, 21), True)):
            kwargs = dict(user_id=m.fixture_id(61), session_id=m.fixture_id(41), birth_date=date(2007, 10, 21), today=today, image_size=1)
            if allowed:
                self.assertEqual(m.qualified_actor(1, **kwargs)['gender'], 'female')
            else:
                with self.assertRaisesRegex(ValueError, 'UNDERAGE'): m.qualified_actor(1, **kwargs)

    def test_tampered_qualification_or_image_cannot_be_blessed(self):
        for path, value in ((('gender',), 'male'), (('verificationStatus',), 'information_required'),
                            (('completedAtRequired',), False), (('avatarPath',), 'someone/else.jpg'),
                            (('storage', 'owner_id'), m.fixture_id(2))):
            actors = self.actors(); target = actors[0]
            for key in path[:-1]: target = target[key]
            target[path[-1]] = value
            with self.assertRaisesRegex(ValueError, 'QUALIFICATION_TAMPERED'): m.make_plan(actors, self.pins())

    def test_duplicate_session_and_wrong_actor_scope_refused(self):
        actors = self.actors(); actors[1]['sessionId'] = actors[0]['sessionId']
        with self.assertRaisesRegex(ValueError, 'DISTINCT_SESSIONS'): m.make_plan(actors, self.pins())
        actors = self.actors(); actors[0]['userId'] = actors[1]['userId']
        with self.assertRaisesRegex(ValueError, 'DISTINCT_USERS'): m.make_plan(actors, self.pins())

    def test_missing_or_extra_source_is_not_approved(self):
        raw = {p: (ROOT / p).read_bytes() for p in m.SOURCES}
        raw['unknown.sql'] = b'unknown'
        with self.assertRaisesRegex(ValueError, 'SOURCE_SET'): m.source_pins(raw)
        pins = self.pins(); pins.pop(m.SOURCES[0])
        with self.assertRaisesRegex(ValueError, 'SOURCE_PINS'): m.make_plan(self.actors(), pins)

    def test_existing_primary_and_related_rows_always_rejected(self):
        p = self.plan()
        for table, predicate in p['businessRowsCandidate'] + p['qualificationRowsCandidate']:
            with self.assertRaisesRegex(ValueError, 'PREEXISTING_FIXTURE_RELATION'):
                m.validate_absence(p, {table: [predicate]})
        with self.assertRaisesRegex(ValueError, 'UNREVIEWED_RELATION'): m.validate_absence(p, {'public.unknown': []})
        self.assertFalse(m.validate_absence(p, {})['executionReady'])

    def test_cleanup_is_candidate_only_and_not_an_executable_order(self):
        p = self.plan(); cleanup = p['cleanup']
        self.assertEqual(cleanup['predicateSet'], p['businessRowsCandidate'] + p['qualificationRowsCandidate'])
        self.assertNotIn('predicateRows', cleanup)
        self.assertFalse(cleanup['executable'])
        self.assertFalse(cleanup['orderReviewed'])
        self.assertFalse(cleanup['sequenceResetAllowed'])
        self.assertFalse(cleanup['existingRowMutationAllowed'])
        self.assertIn('typed_cleanup_dependency_order', p['unresolved'])
        self.assertIn('exact_pid_backend_start_absent', cleanup['requires'])

    def test_deadline_scope_preserves_clock_and_original_classifier(self):
        p = self.plan()
        self.assertFalse(p['deadline']['clockMutationAllowed'])
        self.assertEqual(p['deadline']['requiredOrder'], 'query_start<=observed<D<=release')
        self.assertEqual(p['actualAuth'], 'NOT_RUN')
        self.assertFalse(p['sqlExecuted'])


if __name__ == '__main__': unittest.main()
