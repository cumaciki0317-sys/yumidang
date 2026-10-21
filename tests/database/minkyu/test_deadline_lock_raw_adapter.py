"""봉인 원시 bytes 합성 회귀. 실제 HTTP/DB/정리 실행이 아니다."""
from dataclasses import replace
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import sys
import unittest

P = Path(__file__).resolve().parents[2] / 'integration/minkyu/deadline_lock_raw_adapter.py'
S = importlib.util.spec_from_file_location('d03_raw_adapter_test', P)
m = importlib.util.module_from_spec(S); sys.modules[S.name] = m; S.loader.exec_module(m)


class RawAdapterTests(unittest.TestCase):
    def docs(self):
        common = {'databaseIdentity': 'synthetic-target', 'requestId': 'synthetic-request'}
        projection = {'rows': {'public.original': []}, 'roles': ['pinned'], 'unknown': ['retained'], 'catalog': ['pinned']}
        predicates = [{'table': 'public.reviews', 'id': 'synthetic-only'}]
        return {
            'binding': dict(common, originalJwtVerified=True, eligibleBeforeLock=True),
            'before': dict(common, preservedProjection=projection, ownPredicates=predicates),
            'blocked': dict(common, holderBackendStart='holder-start', waiterBackendStart='waiter-start',
                            holderPid=10, waiterPid=20, queryStartUs=80, observedUs=90, deadlineUs=100,
                            blockingPids=[10], matchingWaiterCount=1, waitEventType='Lock'),
            'release': dict(common, holderBackendStart='holder-start', holderPid=10, releasedUs=110),
            'response': dict(common, transport='POSTGREST_ORIGINAL_HTTP', status=400, bodyComplete=True,
                             transportClosed=True, body={'code': '22023', 'message': 'review_unavailable', 'details': None, 'hint': None}),
            'after': dict(common, preservedProjection=projection, unexpectedRows=[]),
            'cleanup': dict(common, remainingOwnBackendsScope='RAW_PSQL_OWNED_ONLY',
                            postgrestTransactionClosure={'requestTransactionClosed':True,'pooledBackendRetained':True,'backendTerminated':False,'ownership':'POSTGREST_POOL_NOT_OWNED_BACKEND'}, preservedProjection=projection, unexpectedRows=[], remainingOwnRows=[],
                            remainingOwnBackends=[], ownedHostGroupsClosed=True, deletedPredicates=predicates),
        }

    def seal(self, docs=None):
        raw = {k: json.dumps(v, sort_keys=True).encode() for k, v in (docs or self.docs()).items()}
        seal = m.ReviewedRawSeal('a'*64, {k: sha256(v).hexdigest() for k, v in raw.items()},
                                 'synthetic-target', 'synthetic-request', 'holder-start', 'waiter-start')
        return raw, seal

    def test_exact_raw_input_is_only_sealed_db_entry_classification(self):
        result = m.classify_raw(*self.seal())
        self.assertEqual(result['status'], 'REPRODUCED_DB_ENTRY_ONLY')
        for key in ('httpIngressProven', 'policyComplete', 'runtimeExecutedByAdapter', 'collectorAuthenticityProven'):
            self.assertFalse(result[key])

    def test_any_changed_byte_rejected_before_decoding(self):
        raw, seal = self.seal(); raw['blocked'] += b' '
        with self.assertRaisesRegex(ValueError, 'RAW_HASH_MISMATCH'): m.classify_raw(raw, seal)

    def test_no_missing_or_additional_phase_or_pin(self):
        raw, seal = self.seal()
        for key in ('raw', 'seal'):
            a, b = dict(raw), replace(seal, phase_sha=dict(seal.phase_sha))
            (a if key == 'raw' else b.phase_sha).pop('release')
            with self.assertRaises(ValueError): m.classify_raw(a, b)

    def test_duplicate_json_and_nonfinite_rejected_even_if_sealed(self):
        for bad in (b'{"requestId":1,"requestId":2}', b'{"value":NaN}'):
            raw, seal = self.seal(); raw['blocked'] = bad
            pins = dict(seal.phase_sha); pins['blocked'] = sha256(bad).hexdigest()
            with self.assertRaises(ValueError): m.classify_raw(raw, replace(seal, phase_sha=pins))

    def test_mixed_run_or_database_or_reused_pid_rejected(self):
        for phase, key, value in [('after', 'requestId', 'other'), ('response', 'databaseIdentity', 'other'),
                                  ('blocked', 'waiterBackendStart', 'reused'), ('release', 'holderPid', 11)]:
            docs = self.docs(); docs[phase][key] = value
            with self.assertRaises(ValueError): m.classify_raw(*self.seal(docs))

    def test_service_error_cannot_be_promoted_to_original_sqlstate(self):
        for changes in ({'transport': 'SERVICE_API'}, {'status': 503}, {'bodyComplete': False}, {'transportClosed': False},
                        {'body': {'error': {'code': 'INVALID_REQUEST'}}}):
            docs = self.docs(); docs['response'].update(changes)
            with self.assertRaises(ValueError): m.classify_raw(*self.seal(docs))

    def test_timeout_and_other_business_error_are_inconclusive(self):
        for code, message in [('57014', 'statement timeout'), ('22023', 'invalid_review')]:
            docs = self.docs(); docs['response']['body'].update(code=code, message=message)
            self.assertEqual(m.classify_raw(*self.seal(docs))['status'], 'INCONCLUSIVE')

    def test_cleanup_and_foreign_delta_fail_closed(self):
        for changes in ({'remainingOwnRows': ['row']}, {'remainingOwnBackends': [20]},
                        {'ownedHostGroupsClosed': False}, {'deletedPredicates': []}, {'unexpectedRows': ['foreign']},
                        {'preservedProjection': {'changed': True}}):
            docs = self.docs(); docs['cleanup'].update(changes)
            with self.assertRaises(ValueError): m.classify_raw(*self.seal(docs))

    def test_empty_projection_and_unverified_jwt_rejected(self):
        docs = self.docs(); docs['before']['preservedProjection'] = {}
        with self.assertRaises(ValueError): m.classify_raw(*self.seal(docs))
        docs = self.docs(); docs['binding']['originalJwtVerified'] = False
        with self.assertRaises(ValueError): m.classify_raw(*self.seal(docs))

    def test_observation_must_precede_deadline_and_exact_lock_wait(self):
        for changes in ({'observedUs': 100}, {'blockingPids': [10, 11]}, {'matchingWaiterCount': 2}):
            docs = self.docs(); docs['blocked'].update(changes)
            self.assertEqual(m.classify_raw(*self.seal(docs))['status'], 'INCONCLUSIVE')


    def test_ownership_scope_never_treats_postgrest_pool_as_owned_backend(self):
        docs=self.docs();docs['cleanup']['remainingOwnBackendsScope']='ALL_DATABASE_BACKENDS'
        with self.assertRaisesRegex(ValueError,'RAW_PSQL_OWNERSHIP_SCOPE'):m.classify_raw(*self.seal(docs))
        docs=self.docs();docs['cleanup']['postgrestTransactionClosure']['requestTransactionClosed']=False
        with self.assertRaisesRegex(ValueError,'TRANSACTION_CLOSURE'):m.classify_raw(*self.seal(docs))
        docs=self.docs();docs['cleanup']['postgrestTransactionClosure']['backendTerminated']=True
        with self.assertRaisesRegex(ValueError,'TRANSACTION_CLOSURE'):m.classify_raw(*self.seal(docs))
        result=m.classify_raw(*self.seal())
        self.assertTrue(result['pooledBackendRetained']);self.assertFalse(result['backendTerminated'])
        self.assertEqual(result['remainingOwnBackendsScope'],'RAW_PSQL_OWNED_ONLY')

if __name__ == '__main__': unittest.main()
