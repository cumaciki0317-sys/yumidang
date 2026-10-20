"""AI24 영속 계약의 함수 검사. 실제 인증·DB·자정 실행은 하지 않는다."""
from concurrent.futures import ThreadPoolExecutor
import ast
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

REPO = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('ai24_binding', REPO / 'tools/local/prepare_isolated_midnight.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class LiveBindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        self.prepared = self.root / 'prepared'
        self.evidence = self.root / 'evidence'
        self.prepared.mkdir(mode=0o700)
        self.evidence.mkdir(mode=0o700)
        self.now = datetime(2026, 10, 11, 14, 30, tzinfo=timezone.utc)
        self.resume = datetime(2026, 10, 11, 14, 59, tzinfo=timezone.utc)
        self.pins = {'tests/integration/jonghyun/isolated_ai_contracts.py': 'a' * 64}
        self.signed = {
            'version': 1, 'kind': m.SIGNED_KIND, 'preparedRoot': str(self.prepared),
            'databaseManifestSha256': 'b' * 64, 'origin': 'http://127.0.0.1:54321',
            'jwtIssuer': 'http://127.0.0.1:54321/auth/v1',
            'containers': {name: {'id': hex(i)[2:] * 64, 'name': 'own-' + name,
                                 'image': 'sha256:' + 'c' * 64, 'configSha256': 'd' * 64,
                                 'hostConfigSha256': 'e' * 64, 'mountsSha256': 'f' * 64}
                           for i, name in enumerate(('db', 'auth', 'rest', 'gateway'), 1)},
            'credentials': {'anon': 'RAW_PRIVATE_ANON', 'service': 'RAW_PRIVATE_SERVICE'},
            'accounts': [{'userId': str(uuid.uuid4()), 'sessionId': str(uuid.uuid4()),
                          'accessToken': 'RAW_PRIVATE_TOKEN_' + str(i),
                          'expiresAt': int(self.resume.timestamp()) + 600,
                          'authEmail': 'RAW_PRIVATE_EMAIL_' + str(i) + '@example.test'} for i in range(6)],
            'evidenceRoot': str(self.evidence),
            'sourcePins': self.pins, 'approvedByRoot': False, 'dockerSlotReady': False,
        }
        self.input = self.root / 'signed.json'
        self.write_input()
        evidence = {'aiRunnerSha256': 'a' * 64}
        self.plan = m.build_plan({'project': 'own-project', 'id': '1' * 64,
                                  'image': 'sha256:' + 'c' * 64}, evidence, self.pins, self.now)
        # 호출자가 검토한 세 계정을 명시한다. 준비 도구가 자동 선택하지 않는다.
        self.plan['ownedIntent']['memberIds'] = [x['userId'] for x in self.signed['accounts'][:3]]

    def tearDown(self):
        self.temp.cleanup()

    def write_input(self):
        self.input.write_text(json.dumps(self.signed))
        self.input.chmod(0o600)

    def persist(self):
        return m.persist_live_contract(self.root, self.plan, self.input, self.prepared, self.now)

    def test_contract_and_resume_are_not_execution_or_auth_proof(self):
        digest = self.persist()
        value = m.load_live_contract(self.root, digest, self.pins)
        self.assertFalse(value['executorAllowed'])
        self.assertFalse(value['executionAllowed'])
        self.assertFalse(value['preprovisionedAuthAccountsAreCleanupOwned'])
        self.assertEqual(value['actualMidnight'], 'NOT_RUN')
        self.assertEqual(value['signedAuthInput']['actualSignedVerification'], 'NOT_OBSERVED')
        self.assertEqual(value['sourcePins'], self.pins)
        self.assertEqual(value['target'], self.plan['target'])
        self.assertEqual(value['baselineContract']['protectedTables'], list(m.PROTECTED))
        self.assertTrue(value['cleanupContract']['onlyCreatedIdsWithReceipts'])
        m.record_resume_intent(self.root, digest, self.pins, self.resume)
        intent = json.loads((self.root / 'ai24-resume-intent.json').read_bytes())
        self.assertFalse(intent['executorAllowed'])
        self.assertEqual(intent['status'], 'RESUME_INTENT_ONLY')
        for name in ('ai24-live-contract.json', 'ai24-resume-intent.json'):
            self.assertNotIn('RAW_PRIVATE', (self.root / name).read_text())
            self.assertEqual((self.root / name).stat().st_mode & 0o777, 0o600)

    def test_concurrent_resume_consumes_exactly_one_durable_intent(self):
        digest = self.persist()
        def consume():
            try:
                m.record_resume_intent(self.root, digest, self.pins, self.resume)
                return 'written'
            except FileExistsError:
                return 'refused'
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertCountEqual(list(pool.map(lambda _: consume(), range(2))), ['written', 'refused'])

    def test_expired_resume_never_creates_intent(self):
        digest = self.persist()
        for remaining in (5, 0, -1, 121):
            boundary = m.boundary_time(self.plan['naturalTimingPlan']['nextKstMidnight'])
            with self.assertRaisesRegex(ValueError, 'NATURAL_WINDOW_REQUIRED'):
                m.record_resume_intent(self.root, digest, self.pins, boundary - timedelta(seconds=remaining))
        self.assertFalse((self.root / 'ai24-resume-intent.json').exists())

    def test_fresh_day_does_not_roll_expired_contract_forward(self):
        digest = self.persist()
        with self.assertRaises(ValueError):
            m.record_resume_intent(self.root, digest, self.pins, self.resume + timedelta(days=1))

    def test_drift_and_changed_current_pins_refuse_before_resume(self):
        digest = self.persist()
        with self.assertRaisesRegex(ValueError, 'CURRENT_SOURCE_PINS_CHANGED'):
            m.load_live_contract(self.root, digest, dict(self.pins, other='a' * 64))
        with (self.root / 'ai24-live-contract.json').open('ab') as stream:
            stream.write(b' ')
        with self.assertRaisesRegex(ValueError, 'LIVE_CONTRACT_CHANGED'):
            m.record_resume_intent(self.root, digest, self.pins, self.resume)
        self.assertFalse((self.root / 'ai24-resume-intent.json').exists())

    def test_changed_signed_input_is_not_rebound_at_resume(self):
        digest = self.persist()
        self.signed['accounts'][0]['accessToken'] = 'RAW_CHANGED'
        self.write_input()
        with self.assertRaisesRegex(ValueError, 'SIGNED_INPUT_CHANGED'):
            m.record_resume_intent(self.root, digest, self.pins, self.resume)

    def test_wrong_target_and_source_pin_digest_refuse(self):
        self.plan['target']['containerId'] = '9' * 64
        with self.assertRaisesRegex(ValueError, 'SIGNED_TARGET_CHANGED'):
            self.persist()
        self.plan['sourcePinsSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'SOURCE_PINS_CHANGED'):
            self.persist()

    def test_non_kst_boundary_and_wrong_prepare_window_refuse(self):
        self.plan['naturalTimingPlan']['nextKstMidnight'] = '2026-10-11T15:00:00+00:00'
        with self.assertRaisesRegex(ValueError, 'EXACT_KST_MIDNIGHT_REQUIRED'):
            self.persist()
        self.plan['naturalTimingPlan']['nextKstMidnight'] = '2026-10-12T00:00:00+09:00'
        with self.assertRaisesRegex(ValueError, 'NATURAL_WINDOW_REQUIRED'):
            m.persist_live_contract(self.root, self.plan, self.input, self.prepared, self.resume)

    def test_protected_contract_and_owned_member_scope_cannot_be_weakened(self):
        self.plan['baselineContract']['protectedTables'] = []
        with self.assertRaisesRegex(ValueError, 'PROTECTED_BASELINE_CONTRACT_REQUIRED'):
            self.persist()
        self.plan['ownedIntent']['memberIds'][1] = self.plan['ownedIntent']['memberIds'][0]
        with self.assertRaisesRegex(ValueError, 'EXACT_OWNED_MEMBERS_REQUIRED'):
            self.persist()

    def test_input_privacy_modes_links_and_duplicates_refuse(self):
        self.input.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'PRIVATE_REGULAR_FILE_REQUIRED'):
            self.persist()
        self.input.chmod(0o600)
        os.link(self.input, self.root / 'alias')
        with self.assertRaisesRegex(ValueError, 'PRIVATE_REGULAR_FILE_REQUIRED'):
            self.persist()
        (self.root / 'alias').unlink()
        self.input.write_text('{"version":1,"version":1}')
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_BINDING_KEY'):
            self.persist()

    def test_input_symlink_and_contract_hardlink_refuse(self):
        actual = self.root / 'actual.json'
        self.input.rename(actual)
        self.input.symlink_to(actual)
        with self.assertRaisesRegex(ValueError, 'CANONICAL_SIGNED_INPUT_REQUIRED'):
            self.persist()
        self.input.unlink()
        actual.rename(self.input)
        digest = self.persist()
        os.link(self.root / 'ai24-live-contract.json', self.root / 'copy')
        with self.assertRaisesRegex(ValueError, 'PRIVATE_REGULAR_FILE_REQUIRED'):
            m.record_resume_intent(self.root, digest, self.pins, self.resume)

    def test_remote_origin_duplicate_session_or_credential_echo_refuse(self):
        self.signed['origin'] = 'https://example.com/auth/v1'
        self.write_input()
        with self.assertRaisesRegex(ValueError, 'EXACT_LOOPBACK_ENDPOINT_REQUIRED'):
            self.persist()
        self.signed['origin'] = 'http://127.0.0.1:54321'
        self.signed['accounts'][1]['sessionId'] = self.signed['accounts'][0]['sessionId']
        self.write_input()
        with self.assertRaisesRegex(ValueError, 'DISTINCT_SIGNED_ACCOUNTS_REQUIRED'):
            self.persist()

    def test_partial_durable_write_is_preserved_and_never_replayed(self):
        with patch.object(m.os, 'fsync', side_effect=OSError('fixed test failure')):
            with self.assertRaises(OSError):
                self.persist()
        self.assertTrue((self.root / 'ai24-live-contract.json').exists())
        with self.assertRaises(FileExistsError):
            self.persist()

    def test_declared_expiry_and_signed_pin_must_cover_original_boundary(self):
        self.signed['accounts'][0]['expiresAt'] = int(self.resume.timestamp())
        self.write_input()
        with self.assertRaisesRegex(ValueError, 'DECLARED_EXPIRY_DOES_NOT_COVER_BOUNDARY'):
            self.persist()
        self.signed['accounts'][0]['expiresAt'] = True
        self.write_input()
        with self.assertRaisesRegex(ValueError, 'DECLARED_TOKEN_EXPIRY_REQUIRED'):
            self.persist()
        self.signed['accounts'][0]['expiresAt'] = int(self.resume.timestamp()) + 600
        self.signed['sourcePins'] = {'unreviewed.py': 'a' * 64}
        self.write_input()
        with self.assertRaisesRegex(ValueError, 'SIGNED_SOURCE_PINS_CHANGED'):
            self.persist()

    def test_input_approval_flags_are_never_executor_authority(self):
        self.signed['approvedByRoot'] = self.signed['dockerSlotReady'] = True
        self.write_input()
        digest = self.persist()
        value = m.load_live_contract(self.root, digest, self.pins)
        self.assertEqual(value['signedAuthInput']['inputApprovalProvenance'],
                         {'approvedByRoot': True, 'dockerSlotReady': True})
        self.assertFalse(value['executionAllowed'])
        self.assertFalse(value['executorAllowed'])

    def test_partial_resume_is_not_retried_and_resource_policy_is_fixed(self):
        digest = self.persist()
        self.assertEqual(m.load_live_contract(self.root, digest, self.pins)['resources'], m.RESOURCES)
        with patch.object(m.os, 'fsync', side_effect=OSError('fixed test failure')):
            with self.assertRaises(OSError):
                m.record_resume_intent(self.root, digest, self.pins, self.resume)
        with self.assertRaises(FileExistsError):
            m.record_resume_intent(self.root, digest, self.pins, self.resume)

    def test_unselected_random_members_are_not_mapped_to_signed_auth_implicitly(self):
        self.plan['ownedIntent']['memberIds'] = [str(uuid.uuid4()) for _ in range(3)]
        with self.assertRaisesRegex(ValueError, 'EXPLICIT_AI24_SIGNED_MEMBER_SELECTION_REQUIRED'):
            self.persist()

    def signed_plan(self, members=None, pins=None, target=None):
        return m.build_signed_plan(
            target or {'project': 'own-project', 'id': '1' * 64, 'image': 'sha256:' + 'c' * 64},
            {'aiRunnerSha256': 'a' * 64}, self.pins if pins is None else pins, self.now,
            self.input, self.prepared,
            [x['userId'] for x in self.signed['accounts'][:3]] if members is None else members)

    def test_signed_plan_preserves_explicit_original_order_and_can_persist(self):
        selected = [self.signed['accounts'][index]['userId'] for index in (5, 1, 3)]
        self.plan = self.signed_plan(selected)
        self.assertEqual(self.plan['ownedIntent']['memberIds'], selected)
        self.assertEqual(self.plan['baselineContract']['memberStartedRequestsRequiredBeforeBoundary'], [3, 20, 3])
        selected.reverse()
        self.assertNotEqual(self.plan['ownedIntent']['memberIds'], selected)
        digest = self.persist()
        contract = m.load_live_contract(self.root, digest, self.pins)
        self.assertEqual(contract['signedSelectedUserIds'], self.plan['ownedIntent']['memberIds'])
        self.assertFalse(contract['executionAllowed'])
        self.assertFalse(contract['executorAllowed'])

    def test_signed_plan_never_selects_foreign_duplicate_or_noncanonical_members(self):
        ids = [x['userId'] for x in self.signed['accounts'][:3]]
        for selected in ([], ids[:2], [ids[0], ids[0], ids[1]], [str(uuid.uuid4()), *ids[1:]],
                         [ids[0].replace('-', ''), *ids[1:]], [None, *ids[1:]], 'choose-three'):
            with self.subTest(selected=selected), self.assertRaises(ValueError):
                self.signed_plan(selected)
        self.assertFalse((self.root / 'ai24-live-contract.json').exists())

    def test_signed_plan_rejects_target_image_and_signed_source_pin_drift(self):
        for target in ({'project': 'own-project', 'id': '9' * 64, 'image': 'sha256:' + 'c' * 64},
                       {'project': 'own-project', 'id': '1' * 64, 'image': 'sha256:' + '9' * 64}):
            with self.assertRaisesRegex(ValueError, 'SIGNED_TARGET_CHANGED'):
                self.signed_plan(target=target)
        with self.assertRaisesRegex(ValueError, 'SIGNED_SOURCE_PINS_CHANGED'):
            self.signed_plan(pins={'tests/integration/jonghyun/isolated_ai_contracts.py': '9' * 64})
        with self.assertRaisesRegex(ValueError, 'AI_EVIDENCE_SOURCE_CHANGED'):
            m.build_signed_plan({'project': 'own-project', 'id': '1' * 64, 'image': 'sha256:' + 'c' * 64},
                                {'aiRunnerSha256': '9' * 64}, self.pins, self.now, self.input,
                                self.prepared, [x['userId'] for x in self.signed['accounts'][:3]])

    def test_signed_plan_keeps_all_six_declared_boundary_expiries(self):
        boundary = m.boundary_time(m.natural_windows(self.now)['nextKstMidnight'])
        self.signed['accounts'][5]['expiresAt'] = int(boundary.timestamp()) + 299
        self.write_input()
        with self.assertRaisesRegex(ValueError, 'DECLARED_EXPIRY_DOES_NOT_COVER_BOUNDARY'):
            self.signed_plan()
        self.signed['accounts'][5]['expiresAt'] += 1
        self.write_input()
        self.assertEqual(len(self.signed_plan()['ownedIntent']['memberIds']), 3)
        self.signed['accounts'][5]['expiresAt'] = True
        self.write_input()
        with self.assertRaisesRegex(ValueError, 'DECLARED_TOKEN_EXPIRY_REQUIRED'):
            self.signed_plan()

    def test_signed_plan_is_private_sanitized_metadata_without_approval_promotion(self):
        self.signed['approvedByRoot'] = self.signed['dockerSlotReady'] = True
        self.write_input()
        plan = self.signed_plan()
        self.assertFalse(plan['executionAllowed'])
        self.assertEqual(plan['actualMidnight'], 'NOT_RUN')
        self.assertEqual(plan['signedPlanBinding']['actualSignedVerification'], 'NOT_OBSERVED')
        self.assertEqual(plan['signedPlanBinding']['sha256'], hashlib.sha256(self.input.read_bytes()).hexdigest())
        serialized = json.dumps(plan)
        for forbidden in ('RAW_PRIVATE', 'accessToken', 'authEmail', 'credentials', 'approvedByRoot', 'dockerSlotReady'):
            self.assertNotIn(forbidden, serialized)
        self.assertEqual(m.build_plan({'project': 'own-project', 'id': '1' * 64,
                                      'image': 'sha256:' + 'c' * 64}, {'aiRunnerSha256': 'a' * 64},
                                     self.pins, self.now)['scope'], 'CURRENT_SOURCE_SYNTHETIC_AI24_PLANNING_ONLY')

    def test_signed_plan_custody_rejects_changed_original_input_and_present_invalid_binding(self):
        self.plan = self.signed_plan()
        original_binding = self.plan['signedPlanBinding']
        self.signed['accounts'][0]['accessToken'] = 'CHANGED_ORIGINAL_TOKEN'
        self.write_input()
        with self.assertRaisesRegex(ValueError, 'SIGNED_PLAN_BINDING_CHANGED'):
            self.persist()
        self.assertFalse((self.root / 'ai24-live-contract.json').exists())
        self.plan = self.signed_plan()
        for invalid in (None, {}, original_binding):
            self.plan['signedPlanBinding'] = invalid
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, 'SIGNED_PLAN_BINDING_CHANGED'):
                self.persist()
        self.assertFalse((self.root / 'ai24-live-contract.json').exists())


class FakeMidnightPorts:
    """현재 인증/DB/모델 성공을 주장하지 않는 함수 시험용 포트다."""
    def __init__(self, case, contract):
        self.case, self.contract = case, contract
        self.now = case.now
        self.boundary = m.boundary_time(contract['boundary'])
        self.elapsed = 0.0
        self.calls, self.cleanups = [], 0
        self.memory = 1100000
        self.baseline = {
            'rows': {**{'private.' + t: 'a' * 64 for t in m.PROTECTED},
                     'auth.users': 'b' * 64, 'public.profiles': 'c' * 64,
                     'storage.objects': 'd' * 64},
            'catalogSha256': 'e' * 64, 'rolesAclSha256': 'f' * 64,
            'unknownRows': {'private.ai_budget_reservations': '1' * 64,
                            'private.ai_account_budget_reservations': '2' * 64}}
        self.prepared = {'scopeId': contract['scopeId'], 'counts': [3, 20, 3], 'nextCounts': [0, 0, 0],
                         'baseline': self.baseline, 'budget': {'global': {}, 'accounts': {}},
                         'fixtureUnknownRows': {'private.ai_budget_reservations': '4' * 64,
                                                'private.ai_account_budget_reservations': '5' * 64},
                         'portStateSha256': '6' * 64,
                         'creationReceipts': [{'table': 'private.ai_chat_requests',
                                               'id': str(uuid.uuid4()), 'scopeId': contract['scopeId']}]}
        self.result = None

    def current_pins(self): return self.contract['sourcePins']
    def identity(self):
        a = self.contract['signedAuthInput']
        return {'containers': a['containers'], 'databaseManifestSha256': a['databaseManifestSha256']}
    def monotonic(self): return self.elapsed
    def memory_kib(self): return self.memory
    def verify_signed_auth(self):
        return [{**x, 'gotrueUserId': x['userId'], 'databaseSessionUserId': x['userId']}
                for x in self.contract['signedAuthInput']['accounts']]
    def clock(self, **kwargs):
        return {'epoch': self.now.timestamp(), 'day': self.now.astimezone(m.KST).date().isoformat(),
                'midnightEpoch': self.boundary.timestamp(), 'nextDay': self.boundary.date().isoformat()}
    def snapshot(self): return self.baseline
    def original_rows(self): return self.baseline
    def headroom(self):
        return {'accounts': {x: {'registered': True, 'cap': 3200000, 'reserved': 7, 'charged': 11}
                             for x in ('yumi', 'jonghyun', 'minkyu', 'sungho')},
                'global': {'cap': 12800000, 'reserved': 28, 'charged': 44}, 'requiredUnits': 1000}
    def prepare_fixture(self, intent):
        self.calls.append('prepare')
        return self.prepared
    def activate_fixture_registration(self, intent): self.calls.append('register')
    def hydrate_prepared(self, digest):
        if digest != self.prepared['portStateSha256']: raise ValueError('PORT_STATE_CHANGED')
    def warm_factory(self, phase): pass
    def counts(self): return {'before': [3, 20, 3], 'after': [0, 0, 0]}
    def wait(self, seconds):
        self.elapsed += seconds
        self.now += timedelta(seconds=seconds)
    def start_factory(self, phase, intent): self.calls.append('start-' + phase)
    def wait_provider_marker(self, timeout):
        self.now = self.boundary - timedelta(seconds=1)
        self.marker = {'requestId': str(uuid.uuid4()), 'reservationId': str(uuid.uuid4()),
                'userId': self.contract['signedSelectedUserIds'][0], 'accountId': 'yumi',
                'day': self.now.date().isoformat(), 'leaseSha256': '3' * 64, 'units': 800,
                'pending': True, 'startedEpoch': self.now.timestamp()}
        return self.marker
    def reservation_proof(self, marker, **kwargs): return marker.copy()
    def finish_factory(self, phase, timeout): self.calls.append('finish-' + phase)
    def cancel_factory(self): self.calls.append('cancel')
    def effect_proof(self):
        if not hasattr(self, 'marker'): self.wait_provider_marker(2.5)
        effects = []
        budget = {'global': {}, 'accounts': {}}
        for i, uid in enumerate(self.contract['signedSelectedUserIds']):
            day = (self.boundary - timedelta(days=1)).date().isoformat() if i == 0 else self.boundary.date().isoformat()
            effects.append({'requestId': self.marker['requestId'] if i == 0 else str(uuid.uuid4()),
                            'reservationId': self.marker['reservationId'] if i == 0 else str(uuid.uuid4()),
                            'userId': uid, 'accountId': 'yumi', 'day': day, 'finished': True,
                            'originalLeaseSha256': '3' * 64, 'storedLeaseSha256': '3' * 64,
                            'usage': [1, 1], 'resultCount': 1, 'settledEpoch': self.boundary.timestamp() + .1})
            for scope, key in (('global', day), ('accounts', 'yumi:' + day)):
                values = budget[scope].get(key, [0, 0])
                budget[scope][key] = [values[0], values[1] + 2]
        self.result = {'dailyBefore': [4, 20, 3], 'dailyAfter': [0, 1, 1], 'effects': effects,
                       'budget': budget, 'originalRows': self.baseline,
                       'fixtureUnknownRows': self.prepared['fixtureUnknownRows'],
                       'nativeExternalAttempts': 0, 'rawPersistedRows': 0}
        return self.result
    def cleanup_owned(self, intent): self.cleanups += 1
    def cleanup_proof(self):
        return {'originalRows': self.baseline, 'childrenExited': True, 'ownedOnly': True,
                'preservedBudget': self.result['budget']}


class ExecutorFunctionTests(unittest.TestCase):
    setUp = LiveBindingTests.setUp
    tearDown = LiveBindingTests.tearDown
    persist = LiveBindingTests.persist
    write_input = LiveBindingTests.write_input

    def assembled(self):
        digest = self.persist()
        contract = m.load_live_contract(self.root, digest, self.pins)
        ports = FakeMidnightPorts(self, contract)
        assembly = m.ReviewedMidnightAssembly(digest, contract['scopeId'], contract['boundary'],
                                            'reviewed-function-test-only', ports)
        return digest, ports, assembly

    def prepare(self):
        digest, ports, assembly = self.assembled()
        prepared = m.prepare_live_execution(self.root, digest, self.pins, assembly)
        ports.now = self.resume
        return digest, prepared, ports, assembly

    def test_function_kernel_crosses_original_boundary_once_without_claiming_live_adapter(self):
        digest, prepared, ports, assembly = self.prepare()
        sha = m.execute_live_midnight(self.root, digest, prepared, self.pins, assembly)
        raw = m.private_bytes(self.root, 'ai24-natural-boundary-receipt.json')
        self.assertEqual(hashlib.sha256(raw).hexdigest(), sha)
        self.assertEqual(ports.calls, ['register', 'prepare', 'start-held', 'finish-held', 'start-new-day', 'finish-new-day'])
        self.assertEqual(ports.cleanups, 1)
        self.assertFalse(m.executor_status()['executorAllowed'])
        self.assertEqual(m.executor_status()['signedMidnightFactoryAdapter'],
                         'IMPLEMENTED_NOT_INTEGRATED_OR_ACTUALLY_VERIFIED')
        self.assertNotIn(b'RAW_PRIVATE', raw)
        with self.assertRaises(FileExistsError):
            ports.now = self.resume
            m.execute_live_midnight(self.root, digest, prepared, self.pins, assembly)
        self.assertEqual(ports.calls.count('start-held'), 1)

    def test_contract_json_approval_or_missing_assembly_never_dispatches(self):
        digest, ports, assembly = self.assembled()
        for value in (None, {'approved': True, 'ports': ports}, True):
            with self.assertRaisesRegex(ValueError, 'REVIEWED_EXECUTOR_ASSEMBLY_REQUIRED'):
                m.prepare_live_execution(self.root, digest, self.pins, value)
        self.assertFalse((self.root / 'ai24-fixture-intent.json').exists())
        self.assertEqual(ports.calls, [])

    def test_live_auth_wrong_session_expiry_target_and_memory_refuse_before_fixture(self):
        digest, ports, assembly = self.assembled()
        auth = ports.verify_signed_auth()
        auth[0]['databaseSessionUserId'] = str(uuid.uuid4())
        with patch.object(ports, 'verify_signed_auth', return_value=auth):
            with self.assertRaisesRegex(ValueError, 'ACTUAL_SIGNED_SESSION'):
                m.prepare_live_execution(self.root, digest, self.pins, assembly)
        with patch.object(ports, 'identity', return_value={}):
            with self.assertRaisesRegex(ValueError, 'CURRENT_LIVE_TARGET_CHANGED'):
                m.prepare_live_execution(self.root, digest, self.pins, assembly)
        ports.memory = 1048575
        with self.assertRaisesRegex(ValueError, 'STARTUP_RESOURCE_GUARD_REQUIRED'):
            m.prepare_live_execution(self.root, digest, self.pins, assembly)
        self.assertEqual(ports.calls, [])
        self.assertFalse((self.root / 'ai24-fixture-intent.json').exists())

    def test_missing_protected_schema_unknown_and_shared_headroom_fail_closed(self):
        digest, ports, assembly = self.assembled()
        for mutation in ('schema', 'unknown'):
            original = json.loads(json.dumps(ports.baseline))
            if mutation == 'schema': ports.baseline['rows'].pop('storage.objects')
            if mutation == 'unknown': ports.baseline['unknownRows'].clear()
            headroom = ports.headroom()
            with patch.object(ports, 'headroom', return_value=headroom):
                with self.assertRaises(ValueError):
                    m.prepare_live_execution(self.root, digest, self.pins, assembly)
            ports.baseline = original
        self.assertEqual(ports.calls, [])

    def test_rejected_actual_headroom_restores_journaled_registration(self):
        digest, ports, assembly = self.assembled()
        headroom = ports.headroom(); headroom['global']['cap'] = 0
        with patch.object(ports, 'headroom', return_value=headroom):
            with self.assertRaisesRegex(ValueError, 'REGISTERED_GLOBAL_HEADROOM_EXHAUSTED'):
                m.prepare_live_execution(self.root, digest, self.pins, assembly)
        self.assertEqual(ports.calls, ['register', 'cancel'])
        self.assertEqual(ports.cleanups, 1)
        self.assertFalse((self.root / 'ai24-live-prepared.json').exists())

    def test_prepare_partial_failure_calls_owned_cleanup_and_consumes_intent(self):
        digest, ports, assembly = self.assembled()
        with patch.object(ports, 'prepare_fixture', side_effect=RuntimeError('fixture')):
            with self.assertRaises(RuntimeError):
                m.prepare_live_execution(self.root, digest, self.pins, assembly)
        self.assertEqual(ports.cleanups, 1)
        self.assertTrue((self.root / 'ai24-fixture-intent.json').exists())
        with self.assertRaises(FileExistsError):
            m.prepare_live_execution(self.root, digest, self.pins, assembly)
        self.assertFalse((self.root / 'ai24-live-prepared.json').exists())

    def test_resume_scope_expiry_and_existing_intent_block_dispatch(self):
        digest, prepared, ports, assembly = self.prepare()
        ports.now = ports.boundary - timedelta(seconds=5)
        with self.assertRaisesRegex(ValueError, 'NATURAL_WINDOW_REQUIRED'):
            m.execute_live_midnight(self.root, digest, prepared, self.pins, assembly)
        self.assertEqual(ports.calls, ['register', 'prepare'])
        ports.now = self.resume
        m.record_resume_intent(self.root, digest, self.pins, self.resume)
        with self.assertRaises(FileExistsError):
            m.execute_live_midnight(self.root, digest, prepared, self.pins, assembly)
        self.assertEqual(ports.calls, ['register', 'prepare'])

    def test_wrong_pending_owner_never_releases_or_dispatches_new_day(self):
        digest, prepared, ports, assembly = self.prepare()
        original = ports.wait_provider_marker
        def wrong(timeout):
            marker = original(timeout)
            marker['userId'] = str(uuid.uuid4())
            return marker
        with patch.object(ports, 'wait_provider_marker', side_effect=wrong):
            with self.assertRaisesRegex(ValueError, 'ORIGINAL_PENDING_RESERVATION_REQUIRED'):
                m.execute_live_midnight(self.root, digest, prepared, self.pins, assembly)
        self.assertFalse((self.root / 'midnight-provider-release.json').exists())
        self.assertNotIn('start-new-day', ports.calls)
        self.assertEqual(ports.cleanups, 1)

    def test_lost_held_reply_is_not_retried_and_no_success_receipt(self):
        digest, prepared, ports, assembly = self.prepare()
        with patch.object(ports, 'finish_factory', side_effect=TimeoutError('reply')):
            with self.assertRaises(TimeoutError):
                m.execute_live_midnight(self.root, digest, prepared, self.pins, assembly)
        self.assertEqual(ports.calls.count('start-held'), 1)
        self.assertNotIn('start-new-day', ports.calls)
        self.assertEqual(ports.cleanups, 1)
        self.assertFalse((self.root / 'ai24-natural-boundary-receipt.json').exists())

    def test_valid_120_second_resume_waits_for_original_final_idle_window(self):
        digest, prepared, ports, assembly = self.prepare()
        ports.now = ports.boundary - timedelta(seconds=120)
        m.execute_live_midnight(self.root, digest, prepared, self.pins, assembly)
        self.assertEqual(ports.calls.count('start-held'), 1)
        self.assertGreater(ports.elapsed, 100)

    def test_original_day_owner_lease_unknown_and_reserved_budget_cannot_be_rewritten(self):
        digest, prepared, ports, assembly = self.prepare()
        result = ports.effect_proof()
        for field, value in (('day', ports.boundary.date().isoformat()),
                             ('storedLeaseSha256', '4' * 64), ('userId', str(uuid.uuid4()))):
            changed = json.loads(json.dumps(result)); changed['effects'][0][field] = value
            with self.assertRaises(ValueError):
                m.verify_midnight_effects(ports.prepared, changed, ports.boundary,
                                          ports.contract['signedSelectedUserIds'], ports.marker)
        for mutation in ('unknown', 'reserved', 'duplicate', 'raw'):
            changed = json.loads(json.dumps(result))
            if mutation == 'unknown': changed['originalRows']['unknownRows']['private.ai_budget_reservations'] = '9' * 64
            if mutation == 'reserved': changed['budget']['global'][result['effects'][0]['day']][0] = 0 - 1
            if mutation == 'duplicate': changed['effects'][1]['requestId'] = changed['effects'][0]['requestId']
            if mutation == 'raw': changed['rawPersistedRows'] = 1
            with self.assertRaises(ValueError):
                m.verify_midnight_effects(ports.prepared, changed, ports.boundary,
                                          ports.contract['signedSelectedUserIds'], ports.marker)

    def test_held_marker_exact_identity_binds_the_first_stored_effect(self):
        digest, prepared, ports, assembly = self.prepare()
        result = ports.effect_proof()
        for key in ('requestId', 'reservationId', 'userId', 'accountId', 'day', 'originalLeaseSha256'):
            changed = json.loads(json.dumps(result))
            changed['effects'][0][key] = 'sungho' if key == 'accountId' else str(uuid.uuid4())
            with self.assertRaisesRegex(ValueError, 'HELD_ORIGINAL_EFFECT_BINDING_CHANGED'):
                m.verify_midnight_effects(ports.prepared, changed, ports.boundary,
                                          ports.contract['signedSelectedUserIds'], ports.marker)

    def test_slow_snapshot_and_resume_reads_cannot_use_stale_sql_windows(self):
        digest, ports, assembly = self.assembled()
        ports.now = ports.boundary - timedelta(seconds=601)
        def slow_snapshot():
            ports.wait(2)
            return ports.baseline
        with patch.object(ports, 'snapshot', side_effect=slow_snapshot):
            with self.assertRaisesRegex(ValueError, 'NATURAL_WINDOW_REQUIRED'):
                m.prepare_live_execution(self.root, digest, self.pins, assembly)
        self.assertEqual(ports.calls, [])
        ports.now = self.now
        prepared = m.prepare_live_execution(self.root, digest, self.pins, assembly)
        ports.now = ports.boundary - timedelta(seconds=6)
        def slow_original():
            ports.wait(2)
            return ports.baseline
        with patch.object(ports, 'original_rows', side_effect=slow_original):
            with self.assertRaisesRegex(ValueError, 'NATURAL_WINDOW_REQUIRED'):
                m.execute_live_midnight(self.root, digest, prepared, self.pins, assembly)
        self.assertFalse((self.root / 'ai24-resume-intent.json').exists())
        self.assertNotIn('start-held', ports.calls)

    def test_cleanup_failure_cannot_retry_cleanup_or_write_pass(self):
        digest, prepared, ports, assembly = self.prepare()
        with patch.object(ports, 'cleanup_owned', side_effect=RuntimeError('cleanup')) as cleanup:
            with self.assertRaises(RuntimeError):
                m.execute_live_midnight(self.root, digest, prepared, self.pins, assembly)
            self.assertEqual(cleanup.call_count, 1)
        self.assertFalse((self.root / 'ai24-natural-boundary-receipt.json').exists())


class ConcreteAdapterFunctionTests(unittest.TestCase):
    setUp = LiveBindingTests.setUp
    tearDown = LiveBindingTests.tearDown
    persist = LiveBindingTests.persist
    write_input = LiveBindingTests.write_input

    def bare_adapter(self):
        digest = self.persist()
        ports = object.__new__(m.FixedSignedMidnightPorts)
        ports.contract = m.load_live_contract(self.root, digest, self.pins)
        ports.root = self.root
        return ports

    def test_fixed_sql_clock_keeps_original_midnight_after_actual_crossing(self):
        ports = self.bare_adapter()
        boundary = m.boundary_time(ports.contract['boundary'])
        observed = []
        current = [boundary - timedelta(seconds=1)]
        def read(query, timeout):
            import re
            found = re.search(r"'midnightEpoch',([0-9]+),'nextDay','([0-9-]+)'", query)
            self.assertIsNotNone(found)
            self.assertIn('clock_timestamp()', query)
            self.assertNotIn('::date+1', query)
            observed.append(query)
            return json.dumps({'epoch': current[0].timestamp(), 'day': current[0].date().isoformat(),
                               'midnightEpoch': int(found[1]), 'nextDay': found[2]})
        ports.runner = SimpleNamespace(read_sql=read)
        m.check_window(m.sql_clock(ports.clock(), boundary), boundary, 'pre_boundary')
        current[0] = boundary + timedelta(seconds=1)
        m.check_window(m.sql_clock(ports.clock(), boundary), boundary, 'post_boundary')
        self.assertEqual(observed[0], observed[1])

    def test_live_reader_refuses_path_replacement_even_when_old_fd_stays_valid(self):
        path = self.root / 'live.json'; path.write_bytes(b'fixed'); path.chmod(0o600)
        replacement = self.root / 'replacement.json'; replacement.write_bytes(b'fixed'); replacement.chmod(0o600)
        native = os.fdopen
        class ReplacingReader:
            def __init__(self, fd, *args, **kwargs): self.reader = native(fd, *args, **kwargs)
            def __enter__(self): return self
            def __exit__(self, *args): return self.reader.__exit__(*args)
            def read(self, size):
                raw = self.reader.read(size)
                os.replace(replacement, path)
                return raw
        with patch.object(m.os, 'fdopen', ReplacingReader):
            with self.assertRaisesRegex(ValueError, 'LIVE_PRIVATE_PATH_CHANGED'):
                m.live_private_bytes(self.root, 'live.json')

    def test_authority_queries_include_membership_relation_and_column_acl(self):
        ports = self.bare_adapter(); calls = []
        def read(query, timeout): calls.append(query); return 'a' * 64
        ports.runner = SimpleNamespace(read_sql=read)
        self.assertEqual(ports.authority_hashes(), {'catalogSha256': 'a' * 64, 'rolesAclSha256': 'a' * 64})
        self.assertIn('pg_auth_members', calls[1]); self.assertIn('c.relacl', calls[1])
        self.assertIn('a.attacl', calls[1]); self.assertIn('pg_default_acl', calls[1])
        self.assertIn('pg_trigger', calls[0]); self.assertIn('pg_constraint', calls[0])

    def test_authority_only_drift_cannot_return_recorded_baseline(self):
        ports = self.bare_adapter()
        ports.baseline = {'catalogSha256': 'a' * 64, 'rolesAclSha256': 'b' * 64}
        for key in ('catalogSha256', 'rolesAclSha256'):
            current = dict(ports.baseline); current[key] = 'c' * 64
            with patch.object(ports, 'authority_hashes', return_value=current):
                with self.assertRaisesRegex(ValueError, 'FULL_CATALOG_OR_AUTHORITY_CHANGED'):
                    ports.original_rows()

    def test_whole_relation_inventory_rejects_reduced_snapshot(self):
        ports = self.bare_adapter()
        reduced = {'rows': {'auth.users': 'a' * 64}}
        ports.runner = SimpleNamespace(snapshot=lambda: reduced,
                                       read_sql=lambda query, timeout: json.dumps(['auth.users', 'storage.objects']))
        with self.assertRaisesRegex(ValueError, 'FULL_TARGET_RELATION_SET_REQUIRED'):
            ports.snapshot()

    def test_owned_ledger_and_retained_reservations_reject_unreceipted_additions(self):
        ports = self.bare_adapter()
        ledger = 'signed-midnight-' + ports.contract['scopeId']
        unknown = str(uuid.uuid4())
        ids = [str(uuid.uuid4()) for _ in range(3)]
        row = {'ledger_id': ledger, 'unit_limit': 100000000, 'call_limit': 1000,
               'reserved_units': 800, 'charged_units': 50, 'open_calls': 1, 'settled_calls': 25,
               'unknown_usage_calls': 0, 'updated_at': '2026-10-11T23:00:00+09:00'}
        old_unknown = {'reservation_id': unknown, 'ledger_id': ledger, 'unknown_at': 'fixed'}
        ports.owned_baseline = {'ai_budget_ledgers': {ledger: row}, 'ai_budget_reservations': {unknown: {'id': unknown}},
                                'ai_account_budget_reservations': {unknown: old_unknown}}
        ports.creation_receipts = [{'id': unknown, 'table': 'private.ai_account_budget_reservations'}]
        ports.observations = [{'reservations': [{'reservationId': rid, 'accountId': 'yumi',
                                                'accountDay': '2026-10-12', 'units': 800}]} for rid in ids]
        after = json.loads(json.dumps(ports.owned_baseline))
        after['ai_budget_ledgers'][ledger].update(charged_units=56, settled_calls=28, updated_at='2026-10-12T00:00:01+09:00')
        for rid in ids:
            after['ai_account_budget_reservations'][rid] = {
                'reservation_id': rid, 'ledger_id': ledger, 'account_id': 'yumi', 'account_day': '2026-10-12',
                'reserved_units': 800, 'unknown_at': None, 'input_tokens': 1, 'output_tokens': 1,
                'settled_at': '2026-10-12T00:00:01+09:00'}
        ports.runner = SimpleNamespace(fixture={'aiLedgerId': ledger})
        with patch.object(ports, 'owned_metadata', return_value=after): ports.verify_owned_metadata()
        for mutation in ('ledger', 'reservation', 'reset', 'unknown'):
            changed = json.loads(json.dumps(after))
            if mutation == 'ledger': changed['ai_budget_ledgers']['foreign'] = row
            if mutation == 'reservation': changed['ai_account_budget_reservations'][str(uuid.uuid4())] = old_unknown
            if mutation == 'reset': changed['ai_budget_ledgers'][ledger]['reserved_units'] = 0
            if mutation == 'unknown': changed['ai_budget_reservations'][unknown]['changed'] = True
            with patch.object(ports, 'owned_metadata', return_value=changed):
                with self.assertRaises(ValueError): ports.verify_owned_metadata()


class FinalLiveBoundaryTests(unittest.TestCase):
    setUp = LiveBindingTests.setUp
    tearDown = LiveBindingTests.tearDown
    persist = LiveBindingTests.persist
    write_input = LiveBindingTests.write_input
    bare_adapter = ConcreteAdapterFunctionTests.bare_adapter
    # 이 클래스는 실제 포트를 만들거나 호출하지 않는 새 경계 함수만 검사한다.
    def test_contract_graph_never_imports_drifted_runner_before_head_verification(self):
        fake = self.root / 'repository'; runner = fake / m.FixedSignedMidnightPorts.RUNNER_PATH
        runner.parent.mkdir(parents=True)
        marker = self.root / 'untrusted-executed'
        runner.write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').touch()\n')
        with patch.object(m, 'ROOT', fake), patch.object(m, 'verified_product_paths', return_value=set()), \
             patch.object(m.subprocess, 'check_output', return_value=b'committed-safe'):
            with self.assertRaisesRegex(ValueError, 'SOURCE_NOT_COMMITTED'): m.contract_pins()
        self.assertFalse(marker.exists())

    def current_signed_pin_fixture(self):
        # 커밋 원문에서 순수 파일 읽기 함수 두 개만 평가한다. 실제 포트·JWT는 만들지 않는다.
        relative = 'tests/integration/jonghyun/isolated_ai_contracts.py'
        raw = (REPO / relative).read_bytes()
        self.assertEqual(raw, subprocess.check_output(
            ['git', '-C', str(REPO), 'show', 'HEAD:' + relative], timeout=15))
        names = {'product_graph', 'signed_source_pins'}
        selected = [n for n in ast.parse(raw).body if isinstance(n, ast.FunctionDef) and n.name in names]
        self.assertEqual({n.name for n in selected}, names)
        namespace = {'REPO': REPO, 'Path': Path, 'hashlib': hashlib, 're': __import__('re')}
        exec(compile(ast.Module(body=selected, type_ignores=[]), relative, 'exec'), namespace)
        auth_pins = namespace['signed_source_pins']()
        self.assertTrue({'tests/integration/minkyu/member_cleanup_reconcile_local.py',
                         'tests/integration/minkyu/product_connection_restore108_local.py'} <= set(auth_pins))
        fixture = self.root / 'committed-source-fixture'
        fixture.mkdir()
        paths = set(auth_pins) | {'tests/integration/minkyu/content_inspection_http_local.py',
            'tests/integration/minkyu/content_inspection_http_local.ts',
            'tools/local/prepare_isolated_midnight.py'}
        for name in paths:
            target = fixture / name
            target.parent.mkdir(parents=True, exist_ok=True)
            # 후보 모듈의 자기 원문도 임시 fixture에 실제로 커밋한다. 자기 검사를 mock하지 않는다.
            origin = Path(m.__file__) if name == 'tools/local/prepare_isolated_midnight.py' else REPO / name
            target.write_bytes(origin.read_bytes())
        environment = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        environment.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')
        def git(*arguments):
            return subprocess.check_output(['git', '-C', str(fixture),
                '-c', 'user.name=Offline contract fixture',
                '-c', 'user.email=offline-contract@example.invalid',
                '-c', 'commit.gpgsign=false', *arguments], env=environment,
                stderr=subprocess.DEVNULL, timeout=15)
        git('init', '-q')
        git('add', '.')
        git('commit', '-qm', '고정 source 계약 검사 fixture')
        return auth_pins, fixture, git

    def test_current_auth_source_subset_builds_signed_plan_without_caller_pin_union(self):
        auth_pins, fixture, _ = self.current_signed_pin_fixture()
        with patch.object(m, 'ROOT', fixture):
            pins = m.contract_pins()
        self.assertEqual({key: pins.get(key) for key in auth_pins}, auth_pins)
        self.signed['sourcePins'] = auth_pins
        self.write_input()
        plan = m.build_signed_plan(
            {'project': 'own-project', 'id': '1' * 64, 'image': 'sha256:' + 'c' * 64},
            {'aiRunnerSha256': auth_pins['tests/integration/jonghyun/isolated_ai_contracts.py']},
            pins, self.now, self.input, self.prepared,
            [account['userId'] for account in self.signed['accounts'][:3]])
        self.assertEqual(plan['sourcePins'], pins)
        self.assertFalse(plan['executionAllowed'])
        for missing in ('tests/integration/minkyu/member_cleanup_reconcile_local.py',
                        'tests/integration/minkyu/product_connection_restore108_local.py'):
            with self.subTest(missing=missing):
                incomplete = {key: value for key, value in pins.items() if key != missing}
                with self.assertRaisesRegex(ValueError, 'SIGNED_SOURCE_PINS_CHANGED'):
                    m.build_signed_plan({'project': 'own-project', 'id': '1' * 64,
                        'image': 'sha256:' + 'c' * 64}, plan['evidence'], incomplete, self.now,
                        self.input, self.prepared, plan['ownedIntent']['memberIds'])

    def test_added_auth_helpers_and_midnight_self_still_require_committed_bytes(self):
        _, fixture, _ = self.current_signed_pin_fixture()
        for changed in ('tests/integration/minkyu/member_cleanup_reconcile_local.py',
                        'tests/integration/minkyu/product_connection_restore108_local.py',
                        'tools/local/prepare_isolated_midnight.py'):
            with self.subTest(changed=changed):
                path = fixture / changed
                original = path.read_bytes()
                path.write_bytes(original + b'\n# uncommitted source drift\n')
                try:
                    with patch.object(m, 'ROOT', fixture):
                        with self.assertRaisesRegex(ValueError, 'SOURCE_NOT_COMMITTED'):
                            m.contract_pins()
                finally:
                    path.write_bytes(original)

    def test_future_committed_auth_helper_drift_does_not_resume_prior_contract(self):
        auth_pins, fixture, git = self.current_signed_pin_fixture()
        with patch.object(m, 'ROOT', fixture):
            pins = m.contract_pins()
        self.signed['sourcePins'] = auth_pins
        self.write_input()
        plan = m.build_signed_plan(
            {'project': 'own-project', 'id': '1' * 64, 'image': 'sha256:' + 'c' * 64},
            {'aiRunnerSha256': auth_pins['tests/integration/jonghyun/isolated_ai_contracts.py']},
            pins, self.now, self.input, self.prepared,
            [account['userId'] for account in self.signed['accounts'][:3]])
        digest = m.persist_live_contract(self.root, plan, self.input, self.prepared, self.now)
        changed = fixture / 'tests/integration/minkyu/member_cleanup_reconcile_local.py'
        changed.write_bytes(changed.read_bytes() + b'\n# committed future source drift\n')
        git('add', str(changed.relative_to(fixture)))
        git('commit', '-qm', '후속 source 계약 변경 fixture')
        with patch.object(m, 'ROOT', fixture):
            current = m.contract_pins()
        self.assertNotEqual(current, pins)
        with self.assertRaisesRegex(ValueError, 'CURRENT_SOURCE_PINS_CHANGED'):
            m.load_live_contract(self.root, digest, current)
        with self.assertRaisesRegex(ValueError, 'SIGNED_SOURCE_PINS_CHANGED'):
            m.build_signed_plan({'project': 'own-project', 'id': '1' * 64,
                        'image': 'sha256:' + 'c' * 64}, plan['evidence'], current, self.now,
                self.input, self.prepared, plan['ownedIntent']['memberIds'])
        self.assertFalse((self.root / 'ai24-resume-intent.json').exists())

    def test_cancel_covers_prepare_children_and_continues_after_first_failure(self):
        ports = self.bare_adapter(); handles = [object(), object(), object()]; seen = []
        import threading
        ports.cancelled = threading.Event()
        def cancel(handle):
            seen.append(handle)
            if handle is handles[0]: raise OSError('not retained')
        ports.runner = SimpleNamespace(children=handles, cancel_factory=cancel)
        ports.handles = {}  # 준비 자식들은 held/new-day map에 아직 없다.
        with self.assertRaisesRegex(ValueError, 'OWN_CHILD_EXIT_UNPROVEN'): ports.cancel_factory()
        self.assertEqual(seen, handles); self.assertTrue(ports.cancelled.is_set())

    def test_slow_snapshot_requires_fresh_startup_headroom_before_any_fixture_intent(self):
        digest = self.persist(); contract = m.load_live_contract(self.root, digest, self.pins)
        ports = FakeMidnightPorts(self, contract)
        def snapshot(): ports.memory = 900000; return ports.baseline
        ports.snapshot = snapshot
        assembly = m.ReviewedMidnightAssembly(digest, contract['scopeId'], contract['boundary'], 'fake-only', ports)
        with self.assertRaisesRegex(ValueError, 'STARTUP_RESOURCE_GUARD_REQUIRED'):
            m.prepare_live_execution(self.root, digest, self.pins, assembly)
        self.assertEqual(ports.calls, [])
        self.assertFalse((self.root / 'ai24-fixture-intent.json').exists())

    def test_fresh_process_resume_requires_startup_floor_after_slow_reads(self):
        digest = self.persist(); contract = m.load_live_contract(self.root, digest, self.pins)
        ports = FakeMidnightPorts(self, contract)
        assembly = m.ReviewedMidnightAssembly(digest, contract['scopeId'], contract['boundary'], 'fake-only', ports)
        prepared = m.prepare_live_execution(self.root, digest, self.pins, assembly)
        ports.now = self.resume; ports.memory = 900000
        with self.assertRaisesRegex(ValueError, 'STARTUP_RESOURCE_GUARD_REQUIRED'):
            m.execute_live_midnight(self.root, digest, prepared, self.pins, assembly)
        self.assertNotIn('start-held', ports.calls)
        self.assertFalse((self.root / 'ai24-resume-intent.json').exists())

    def test_sql_clock_refuses_other_natural_day_even_with_fixed_boundary(self):
        ports = self.bare_adapter(); boundary = m.boundary_time(ports.contract['boundary'])
        for now in (boundary - timedelta(days=2), boundary + timedelta(days=1)):
            with self.assertRaisesRegex(ValueError, 'SQL_NATURAL_DAY_REQUIRED'):
                m.sql_clock({'epoch': now.timestamp(), 'day': now.date().isoformat(),
                             'midnightEpoch': boundary.timestamp(), 'nextDay': boundary.date().isoformat()}, boundary)

    def test_monitor_failure_cancels_even_when_cancellation_raises(self):
        calls = []
        def cancel(): calls.append('cancel'); raise OSError('raw-not-retained')
        watch = m.ResourceWatch(SimpleNamespace(monotonic=lambda: 0, memory_kib=lambda: 786431,
                                                cancel_factory=cancel))
        watch.observe()
        self.assertEqual(calls, ['cancel'])
        self.assertEqual(watch.failures, ['RESOURCE_MONITOR_FAILED', 'RESOURCE_CANCEL_UNPROVEN'])
        with self.assertRaisesRegex(ValueError, 'RESOURCE_MONITOR_FAILED'): watch.check()

    def test_monitor_cadence_does_not_add_three_seconds_after_probe(self):
        watch = m.ResourceWatch(SimpleNamespace(monotonic=lambda: 0, memory_kib=lambda: 900000,
                                                cancel_factory=lambda: None))
        waits = []
        class Stop:
            def is_set(self): return False
            def wait(self, duration): waits.append(duration); return True
        watch.stopped = Stop()
        with patch.object(m.time, 'monotonic', side_effect=[10, 10, 12, 12]): watch.observe()
        self.assertEqual(waits, [1])

    def test_monitor_rejects_slow_probe(self):
        times = iter((0, 4))
        watch = m.ResourceWatch(SimpleNamespace(monotonic=lambda: next(times), memory_kib=lambda: 900000))
        with self.assertRaisesRegex(ValueError, 'LIVE_RESOURCE_GUARD_REQUIRED'): watch.sample()

    def cleanup_state(self, ports):
        bags = {'private.' + t: {} for t in m.PROTECTED}
        bags.update({'auth.users': {}, 'public.profiles': {}, 'storage.objects': {}})
        baseline = {'rows': {k: m.hashlib.sha256(m.canonical(v)).hexdigest() for k, v in bags.items()},
                    'catalogSha256': 'a' * 64, 'rolesAclSha256': 'b' * 64,
                    'unknownRows': {k: m.hashlib.sha256(m.canonical({})).hexdigest()
                                    for k in ('private.ai_budget_reservations','private.ai_account_budget_reservations')}}
        accounts = [{'account_id': a, 'registered': False, 'account_order': i + 1, 'unit_limit': 3200000}
                    for i, a in enumerate(('yumi','jonghyun','minkyu','sungho'))]
        guard = [{'singleton': True, 'external_processing_allowed': False}]
        value = {'version': 1, 'kind': 'AI24_CLEANUP_BASELINE', 'scopeId': ports.contract['scopeId'],
                 'boundary': ports.contract['boundary'], 'sourcePins': ports.contract['sourcePins'],
                 'signedInputSha256': ports.contract['signedAuthInput']['sha256'], 'baseline': baseline,
                 'baselineRows': bags, 'accountBaseline': accounts, 'guardBaseline': guard}
        activation = {'changed': True, 'preparedUnitsComplete': False, 'accounts': accounts, 'originalRows': bags}
        return value, activation

    def test_cleanup_only_validates_partial_state_without_promoting_budget_or_live_child(self):
        ports = self.bare_adapter(); value, activation = self.cleanup_state(ports)
        hashes = [m.durable_json(self.root, 'ai24-cleanup-baseline.json', value),
                  m.durable_json(self.root, 'midnight-activation-resume-state-private.json', activation)]
        calls = []
        ports.baseline = None; ports.handles = {}; ports.cleanup_result = None
        auth = ports.contract['signedAuthInput']
        ports.runner = SimpleNamespace(restore_resume_state=lambda state: calls.append('hydrate'),
                                      original_rows=lambda: value['baselineRows'])
        def clean(intent): calls.append('cleanup'); ports.cleanup_result = {'status': 'PASS'}
        # 함수 모형은 SQL을 실행하지 않는다. 미완료 node intent는 UNKNOWN으로 남는다.
        m.durable_json(self.root, 'midnight-prepare-limits-node-intent.json', {
            'scopeId': ports.contract['scopeId'], 'phase': 'prepare-limits', 'singleLaunch': True})
        with patch.object(ports, 'current_pins', return_value=self.pins), \
             patch.object(ports, 'identity', return_value={'containers': auth['containers'],
                                                          'databaseManifestSha256': auth['databaseManifestSha256']}), \
             patch.object(ports, 'cleanup_owned', side_effect=clean), \
             patch.object(ports, 'original_rows', return_value=value['baseline']):
            result = ports.recover_cleanup_only(*hashes)
        self.assertEqual(calls, ['hydrate', 'cleanup'])
        self.assertEqual(result['status'], 'UNKNOWN_PARTIAL_BUDGET_PROOF')
        self.assertEqual(result['childClosure'], 'UNKNOWN')
        self.assertFalse(result['prepareReplayAllowed'])

    def test_cleanup_state_wrong_hash_refuses_before_restoration_calls(self):
        ports = self.bare_adapter(); value, activation = self.cleanup_state(ports)
        m.durable_json(self.root, 'ai24-cleanup-baseline.json', value)
        ports.baseline = None; ports.handles = {}
        with self.assertRaisesRegex(ValueError, 'CLEANUP_BASELINE_CHANGED'):
            ports.recover_cleanup_only('0' * 64, '1' * 64)

    def test_hydration_requires_complete_original_unknown_and_receipt_binding(self):
        ports = self.bare_adapter(); value, activation = self.cleanup_state(ports)
        unknown = str(uuid.uuid4())
        runner = dict(activation, unknown=[unknown, {}], creationReceipts=[{
            'table': 'ai_budget_reservations', 'id': unknown, 'scopeId': ports.contract['scopeId']}],
                      preparedUnitsComplete=True)
        state = {**value, 'kind': 'AI24_FIXED_SIGNED_ADAPTER_STATE',
                 'unknownReservationId': unknown, 'creationReceipts': [{**r, 'table': 'private.' + r['table']}
                                                                      for r in runner['creationReceipts']],
                 'ownedBaseline': {}, 'runner': runner}
        calls = []
        ports.runner = SimpleNamespace(restore_resume_state=lambda state: calls.append('hydrate'))
        digest = m.durable_json(self.root, 'ai24-fixed-port-state.json', state)
        ports.hydrate_prepared(digest)
        self.assertEqual(calls, ['hydrate']); self.assertEqual(ports.unknown_id, unknown)
        for change in ('incomplete', 'unknown', 'receipt'):
            changed = json.loads(json.dumps(state))
            if change == 'incomplete': changed['runner']['preparedUnitsComplete'] = False
            if change == 'unknown': changed['runner']['unknown'][0] = str(uuid.uuid4())
            if change == 'receipt': changed['creationReceipts'][0]['id'] = str(uuid.uuid4())
            path = self.root / 'ai24-fixed-port-state.json'; path.unlink()
            digest = m.durable_json(self.root, path.name, changed)
            with self.assertRaisesRegex(ValueError, 'COMPLETE_PREPARED_PORT_STATE_REQUIRED'):
                ports.hydrate_prepared(digest)
        self.assertEqual(calls, ['hydrate'])



if __name__ == '__main__':
    unittest.main()
