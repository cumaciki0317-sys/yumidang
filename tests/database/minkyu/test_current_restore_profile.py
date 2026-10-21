"""현재124 복원 준비/증거 소비 계약의 합성 검사. 실제 복원 증거가 아니다."""
import hashlib
import json
from pathlib import Path
import sys
import unittest

LOCAL = Path(__file__).resolve().parents[3] / 'tools/local'
sys.path.insert(0, str(LOCAL))
import verify_restoration_readiness as subject


def raw(value):
    return subject.canonical(value)


def sha(value):
    return hashlib.sha256(raw(value)).hexdigest()


def profile_value():
    return {'version': 1, 'scope': 'CURRENT124_DATABASE_RESTORE_REVIEW_ONLY',
            'sourceHead': 'a' * 40, 'migrationsSha256': 'b' * 64,
            'captureId': '12345678-1234-4234-8234-123456789abc',
            'sourceIdentity': {'id': 'c' * 64, 'name': 'synthetic-source', 'image': 'd' * 64},
            'targetProject': 'jonghyun-backend100-1234abcd',
            'relations': ['private.ai_budget_reservations', 'public.profiles'],
            'roles': ['authenticated', 'postgres'], 'sequences': ['public.example_id_seq'],
            'unknownIds': ['23456789-1234-4234-8234-123456789abc'],
            'deletionPlan': [{'relation': 'public.profiles', 'rowIdentity': 'reviewed-synthetic-row'}],
            'sourceStateSha256': sha(state()), 'reappliedStateSha256': sha(state(deleted=True)),
            'storageMetadata': 45, 'storageOriginals': 6, 'storageMissing': 39}


def state(deleted=False):
    return {'snapshot': {'rows': {'private.ai_budget_reservations': '1:' + '1' * 32,
                                  'public.profiles': ('0:' + '2' * 32) if deleted else '1:' + '3' * 32},
                         'catalog': 'synthetic full catalog',
                         'roles': {'roles': [{'rolname': 'authenticated'}, {'rolname': 'postgres'}],
                                   'memberships': []}},
            'rawAuthority': {'database': [], 'schemas': [], 'relations': [], 'columns': [],
                             'functions': [], 'defaults': [], 'dbRoleSettings': []},
            'effectivePrivileges': [['synthetic']], 'sequences': {'public.example_id_seq': [9, True]}}


class CurrentRestoreTests(unittest.TestCase):
    def profile(self):
        return subject.ReviewedCurrentRestoreProfile(raw(profile_value()))

    def test_plain_mapping_is_not_review(self):
        with self.assertRaises(subject.VerificationError):
            subject.verify_current_restore_evidence({}, {}, lambda _: b'')

    def test_profile_and_nested_values_are_immutable_bytes(self):
        p = self.profile()
        value = p.value()
        value['roles'].append('foreign')
        self.assertEqual(p.value(), profile_value())

    def test_profile_rejects_unknown_fields_duplicate_roster_and_storage_claim(self):
        for mutate in (lambda v: v.update(executionAllowed=True),
                       lambda v: v['relations'].append(v['relations'][0]),
                       lambda v: v.update(storageMissing=0),
                       lambda v: v.update(sourceHead='wrong')):
            value = profile_value()
            mutate(value)
            with self.subTest(value=value):
                with self.assertRaises(subject.VerificationError):
                    subject.ReviewedCurrentRestoreProfile(raw(value))

    def packet(self):
        p = self.profile()
        binding = {'profileSha256': p.sha256, 'sourceHead': 'a' * 40,
                   'migrationsSha256': 'b' * 64, 'captureId': p.value()['captureId'],
                   'sourceIdentity': p.value()['sourceIdentity'],
                   'targetProject': p.value()['targetProject'], 'targetId': 'e' * 64,
                   'intentId': '34567890-1234-4234-8234-123456789abc'}
        unknown = [{'id': p.value()['unknownIds'][0], 'status': 'UNKNOWN',
                    'fullReservationAndLedgerRows': {'synthetic': ['unchanged', 1]}}]
        bodies = {'sourceState': state(), 'restoredState': state(),
                  'reappliedState': state(True), 'sourceUnknown': unknown,
                  'restoredUnknown': unknown, 'reappliedUnknown': unknown,
                  'deletionPlan': p.value()['deletionPlan']}
        data = {}
        refs = {}
        for kind, payload in bodies.items():
            path = '/private/tmp/synthetic-restore-proof/' + kind + '.json'
            data[path] = raw({'kind': kind, 'binding': binding, 'payload': payload})
            refs[kind] = {'path': path, 'sha256': hashlib.sha256(data[path]).hexdigest()}
        packet = {'version': 1, 'binding': binding, 'artifacts': refs,
                  'originalReceipts': {'capture': {'path': '/private/tmp/synthetic-restore-proof/capture.json',
                                                   'sha256': 'f' * 64},
                                       'restore': {'path': '/private/tmp/synthetic-restore-proof/restore.json',
                                                   'sha256': 'f' * 64},
                                       'deletionReapply': {'path': '/private/tmp/synthetic-restore-proof/reapply.json',
                                                          'sha256': 'f' * 64}}}
        # 원 producer 영수증은 별도 root 검토 해시로만 연결한다. 소비기가 실행 PASS로 승격하지 않는다.
        for ref in packet['originalReceipts'].values():
            data[ref['path']] = b'{"syntheticReceipt":true}'
            ref['sha256'] = hashlib.sha256(data[ref['path']]).hexdigest()
        return p, packet, data

    def test_exact_current_evidence_is_offline_database_only(self):
        p, packet, data = self.packet()
        result = subject.verify_current_restore_evidence(
            p, subject.ReviewedCurrentRestoreEvidence(raw(packet)), data.__getitem__)
        self.assertEqual(result['status'], 'CURRENT124_OFFLINE_EVIDENCE_MATCHED')
        self.assertFalse(result['executionAllowed'])
        self.assertFalse(result['fullRestore'])
        self.assertEqual(result['runtimeValidation'], 'NOT_INDEPENDENTLY_EXECUTED')
        self.assertEqual(result['storageMissing'], 39)

    def test_wrong_binding_missing_reference_and_changed_bytes_rejected(self):
        for mutation in ('target', 'capture', 'head', 'omit', 'bytes'):
            p, packet, data = self.packet()
            if mutation == 'target': packet['binding']['targetId'] = '0' * 64
            if mutation == 'capture': packet['binding']['captureId'] = '45678901-1234-4234-8234-123456789abc'
            if mutation == 'head': packet['binding']['sourceHead'] = '0' * 40
            if mutation == 'omit': del packet['artifacts']['restoredUnknown']
            if mutation == 'bytes': data[packet['artifacts']['sourceState']['path']] += b' '
            with self.subTest(mutation=mutation), self.assertRaises(subject.VerificationError):
                subject.verify_current_restore_evidence(
                    p, subject.ReviewedCurrentRestoreEvidence(raw(packet)), data.__getitem__)

    def test_acl_roles_sequence_unknown_and_unplanned_deletion_rejected(self):
        for kind, mutate in (
            ('restoredState', lambda v: v['rawAuthority'].update(database=['changed'])),
            ('restoredState', lambda v: v['snapshot']['roles']['memberships'].append('changed')),
            ('restoredState', lambda v: v['sequences'].update({'public.example_id_seq': [10, True]})),
            ('restoredUnknown', lambda v: v[0].update(status='RELEASED')),
            ('reappliedState', lambda v: v['snapshot']['rows'].update({'private.ai_budget_reservations': '0:' + '0' * 32})),
            ('deletionPlan', lambda v: v.append({'relation': 'public.profiles', 'rowIdentity': 'unreviewed'}))):
            p, packet, data = self.packet()
            ref = packet['artifacts'][kind]
            value = json.loads(data[ref['path']])
            mutate(value['payload'])
            data[ref['path']] = raw(value)
            ref['sha256'] = hashlib.sha256(data[ref['path']]).hexdigest()
            with self.subTest(kind=kind), self.assertRaises(subject.VerificationError):
                subject.verify_current_restore_evidence(
                    p, subject.ReviewedCurrentRestoreEvidence(raw(packet)), data.__getitem__)


    def test_preparation_requires_exact124_and_full_source_closure(self):
        import prepare_database_restore as core
        migrations = [{'path': 'reviewed/' + str(i) + '.sql', 'sha256': '1' * 64}
                      for i in range(124)]
        value = profile_value()
        value['migrationsSha256'] = sha(migrations)
        profile = subject.ReviewedCurrentRestoreProfile(raw(value))
        files = {name: '2' * 64 for name in
                 core.FILES | {'tools/local/prepare_restore_source_manifest.py'}}
        prepared = {'scope': 'CURRENT_RESTORE_SOURCE_PREPARATION_ONLY',
                    'sourceHead': value['sourceHead'], 'migrationsSha256': sha(migrations),
                    'policyProfileVerified': True, 'committedSourceVerified': True,
                    'executionAllowed': False, 'runnable': False, 'fullRestore': False,
                    'migrations': migrations, 'migrationCount': 124,
                    'sourceFiles': files, 'sourceFilesSha256': sha(files)}
        result = core.prepare_current124_restore_review(profile, prepared)
        self.assertEqual(result['status'], 'PREPARED_NOT_RUN')
        self.assertNotIn('targetId', result)
        self.assertNotIn('intentId', result)
        self.assertFalse(result['executionAllowed'])
        import copy
        for mutate in (lambda v: v['migrations'].pop(),
                       lambda v: v['migrations'][0].update(sha256='3' * 64),
                       lambda v: v['sourceFiles'].pop(next(iter(files))),
                       lambda v: v.update(sourceHead='0' * 40),
                       lambda v: v.update(executionAllowed=True),
                       lambda v: v.update(policyProfileVerified=False)):
            candidate = copy.deepcopy(prepared)
            mutate(candidate)
            with self.subTest(candidate=candidate), self.assertRaises(subject.VerificationError):
                core.prepare_current124_restore_review(profile, candidate)

    def test_evidence_replacement_during_consumption_rejected(self):
        p, packet, data = self.packet()
        calls = {}
        def reader(path):
            calls[path] = calls.get(path, 0) + 1
            return data[path] + (b' ' if calls[path] > 1 else b'')
        with self.assertRaisesRegex(subject.VerificationError, 'CHANGED_DURING_READ'):
            subject.verify_current_restore_evidence(
                p, subject.ReviewedCurrentRestoreEvidence(raw(packet)), reader)

    def test_real_private_reader_checks_modes_and_links(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
            os.chmod(directory, 0o700)
            path = Path(directory) / 'proof.json'
            path.write_bytes(b'{}')
            os.chmod(path, 0o600)
            self.assertEqual(subject.read_bytes(path), b'{}')
            os.chmod(path, 0o644)
            with self.assertRaises(subject.VerificationError):
                subject.read_bytes(path)
            os.chmod(path, 0o600)
            link = Path(directory) / 'link.json'
            link.symlink_to(path)
            with self.assertRaises((subject.VerificationError, OSError)):
                subject.read_bytes(link)


    def test_captured_support_late_import_ignores_ambient_and_restores_it(self):
        import os
        import subprocess
        import tempfile
        import types
        import prepare_restore_source_manifest as preparation
        names = ('prepare_migrations', 'prepare_database', 'prepare_edge', 'prepare_current_policy')
        old = {name: sys.modules.get(name) for name in names}
        try:
            with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
                repo = Path(directory)
                os.chmod(repo, 0o700)
                def git(*args):
                    return subprocess.check_output(['git', '-C', str(repo), *args],
                                                   stderr=subprocess.DEVNULL)
                git('init', '-q')
                git('config', 'user.name', 'Synthetic review')
                git('config', 'user.email', 'fixture@example.invalid')
                for name in names:
                    path = repo / 'tools/local' / (name + '.py')
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("PIN = 'captured'\n" if name == 'prepare_migrations' else
                                    "def late():\n    from prepare_migrations import PIN\n    return PIN\n")
                git('add', 'tools')
                git('commit', '-qm', 'synthetic helper bytes')
                head = git('rev-parse', 'HEAD').decode().strip()
                poison = types.ModuleType('prepare_migrations')
                poison.PIN = 'ambient-unreviewed'
                sys.modules['prepare_migrations'] = poison
                with preparation._reviewed_current_restore_support(repo, head):
                    self.assertEqual(sys.modules['prepare_current_policy'].late(), 'captured')
                    self.assertIsNot(sys.modules['prepare_migrations'], poison)
                self.assertIs(sys.modules['prepare_migrations'], poison)
                with self.assertRaisesRegex(RuntimeError, 'synthetic failure'):
                    with preparation._reviewed_current_restore_support(repo, head):
                        raise RuntimeError('synthetic failure')
                self.assertIs(sys.modules['prepare_migrations'], poison)
                with self.assertRaisesRegex(preparation.ManifestRefused, 'SUPPORT_CHANGED'):
                    with preparation._reviewed_current_restore_support(repo, head):
                        (repo / 'tools/local/prepare_migrations.py').write_text("PIN='changed'\n")
                self.assertIs(sys.modules['prepare_migrations'], poison)
        finally:
            for name, module in old.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module


if __name__ == '__main__':
    unittest.main()
