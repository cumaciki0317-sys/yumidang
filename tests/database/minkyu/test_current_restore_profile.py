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



class CurrentCaptureTests(unittest.TestCase):
    def capture_fixture(self, root):
        import contextlib
        import prepare_database_restore as core
        p = subject.ReviewedCurrentRestoreProfile(raw(profile_value()))
        identity = {'daemonId': core.CURRENT_CAPTURE_DAEMON,
                    'ownIds': dict(zip(('db', 'auth', 'rest', 'gateway'), ('c'*64, 'd'*64, 'e'*64, 'f'*64))),
                    'dbIncarnation': {'startedAt': '2026-10-21T00:00:00Z', 'restartCount': 0}}
        identity['containers'] = {
            role: {'id': cid, 'name': 'synthetic-source' if role == 'db' else role,
                   'image': 'd'*64, 'configSha256': '1'*64, 'hostConfigSha256': '2'*64,
                   'mountsSha256': '3'*64, 'startedAt': identity['dbIncarnation']['startedAt'],
                   'restartCount': 0, 'networkIds': {'source-net': '4'*64}, 'running': True}
            for role, cid in identity['ownIds'].items()}
        unknown = [{'id': p.value()['unknownIds'][0], 'status': 'UNKNOWN',
                    'fullReservationAndLedgerRows': {'synthetic': True}}]
        migrations = [{'path': 'backend/supabase/migrations/' + str(20261021000000+x) + '_fixture.sql',
                       'version': str(20261021000000+x), 'sha256': '1'*64} for x in range(124)]
        v = p.value(); v['migrationsSha256'] = sha(migrations)
        p = subject.ReviewedCurrentRestoreProfile(raw(v))
        review = {'scope': 'CURRENT124_READONLY_SOURCE_CAPTURE', 'profileSha256': p.sha256,
                  'toolRepo': str(LOCAL.parents[1]), 'toolHead': '2'*40,
                  'toolPins': {name: '3'*64 for name in core.CURRENT_CAPTURE_TOOLS},
                  'sourceRepo': str(LOCAL.parents[1]), 'sourceHead': 'a'*40,
                  'sourcePins': {core.RECOVERY: '4'*64, core.HELPER: '5'*64,
                                 **{x['path']: x['sha256'] for x in migrations}},
                  'migrations': migrations, 'captureId': p.value()['captureId'],
                  'output': str(root / ('yumidang-current124-capture-' + p.value()['captureId'])),
                  'ownIds': identity['ownIds'], 'daemonId': core.CURRENT_CAPTURE_DAEMON,
                  'identitySha256': sha(identity), 'dbIncarnation': identity['dbIncarnation'],
                  'metadataSha256': sha({'oldResources': 'all unchanged'}),
                  'closedControlsSha256': sha({'allClosed': True}), 'unknownRowsSha256': sha(unknown),
                  'portAuthorityPath': str(root / 'authority.py'), 'portAuthoritySha256': '6'*64}
        ports = core.CurrentRestoreCaptureReadPorts(source_context=contextlib.nullcontext,
                    identity=lambda: identity, metadata=lambda: {'oldResources': 'all unchanged'},
                    closed_controls=lambda: {'allClosed': True}, state=state,
                    unknown_rows=lambda: unknown,
                    sql=lambda q: json.dumps([[x['version'], 'fixture'] for x in migrations]) if q == core.HISTORY_SQL else '0',
                    memory_kib=lambda: 1048576)
        return core, p, review, ports

    def test_capture_scope_rejects_plain_packets_foreign_id_and_source_pin_omission(self):
        import tempfile
        import copy
        with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
            core, p, review, ports = self.capture_fixture(Path(directory))
            core.ReviewedCurrentRestoreCapture(raw(review))
            with self.assertRaises(subject.VerificationError):
                core.Current124SourceCapture(p, review, ports)
            for mutate in (lambda v: v['ownIds'].update(auth=v['ownIds']['db']),
                           lambda v: v['sourcePins'].pop(core.RECOVERY),
                           lambda v: v['toolPins'].pop(next(iter(v['toolPins']))),
                           lambda v: v.update(daemonId='foreign'),
                           lambda v: v['migrations'].pop(),
                           lambda v: v.update(output='/private/tmp/foreign')):
                candidate = copy.deepcopy(review); mutate(candidate)
                with self.subTest(candidate=candidate), self.assertRaises(subject.VerificationError):
                    core.ReviewedCurrentRestoreCapture(raw(candidate))

    def test_capture_guard_rejects_memory_identity_metadata_and_preserves_raw(self):
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
            root = Path(directory)
            core, p, review, ports = self.capture_fixture(root)
            cap = core.Current124SourceCapture(p, core.ReviewedCurrentRestoreCapture(raw(review)), ports)
            cap.root.mkdir(mode=0o700); cap.created = True
            import time
            cap.started = time.monotonic()
            with mock.patch.object(core, 'verify_current_capture_sources'):
                cap.guard(start=True)
                ports.memory_kib = lambda: 786432
                with self.assertRaisesRegex(subject.VerificationError, 'MEMORY_LOW'):
                    cap.guard(start=True)
                ports.memory_kib = lambda: 1048576
                ports.identity = lambda: {'foreign': True}
                with self.assertRaisesRegex(subject.VerificationError, 'IDENTITY_CHANGED'):
                    cap.guard()
                self.assertTrue((cap.root / 'identity-00002.json').exists())
                _, _, _, valid_ports = self.capture_fixture(root)
                ports.identity = valid_ports.identity
                ports.metadata = lambda: {'changedOldResource': True}
                with self.assertRaisesRegex(subject.VerificationError, 'METADATA_CHANGED'):
                    cap.guard()
                self.assertTrue((cap.root / 'metadata-00003.json').exists())

    def test_fixed_dump_command_real_child_closure_and_no_password_roles_flags(self):
        import tempfile
        import subprocess
        import os
        from unittest import mock
        with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
            core, p, review, ports = self.capture_fixture(Path(directory))
            name = 'tools/local/run_current_auth_source.py'
            review['toolPins'][name] = hashlib.sha256((LOCAL.parents[1] / name).read_bytes()).hexdigest()
            cap = core.Current124SourceCapture(p, core.ReviewedCurrentRestoreCapture(raw(review)), ports)
            cap.root.mkdir(mode=0o700); cap.created = True
            cap.guard = lambda **kwargs: None  # command-local unit; source guard is exercised separately.
            cap._guard_live = cap.guard
            seen = []; original_popen = subprocess.Popen
            def spawn(argv, **kwargs):
                seen.append(argv)
                return original_popen([sys.executable, '-c',
                    "import sys;sys.stdout.buffer.write(b'PGDMPsynthetic')"], **kwargs)
            with mock.patch.object(core.subprocess, 'Popen', side_effect=spawn):
                self.assertEqual(cap.command('database'), b'PGDMPsynthetic')
                self.assertEqual(cap.command('roles'), b'PGDMPsynthetic')
            self.assertEqual(seen[0][:5], ['docker', '--host', core.CURRENT_CAPTURE_HOST, 'exec', '--env'])
            self.assertIn('PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=8000', seen[0])
            self.assertIn('--no-role-passwords', seen[1])
            for kind in ('database', 'roles'):
                closure = json.loads((cap.root / ('command-' + kind + '-closure.json')).read_bytes())
                self.assertTrue(closure['closed'] and closure['leaderReaped'] and closure['groupAbsent'])
                self.assertTrue((cap.root / ('command-' + kind + '-backend-final.json')).exists())
                self.assertEqual((cap.root / ('command-' + kind + '-stdout.bin')).stat().st_mode & 0o777, 0o600)
            self.assertFalse(cap.sticky)

    def test_failed_dump_keeps_raw_and_backend_proof_without_retry(self):
        import tempfile
        import subprocess
        from unittest import mock
        with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
            core, p, review, ports = self.capture_fixture(Path(directory))
            name = 'tools/local/run_current_auth_source.py'
            review['toolPins'][name] = hashlib.sha256((LOCAL.parents[1] / name).read_bytes()).hexdigest()
            cap = core.Current124SourceCapture(p, core.ReviewedCurrentRestoreCapture(raw(review)), ports)
            cap.root.mkdir(mode=0o700); cap.created = True; cap.guard = lambda **kwargs: None
            cap._guard_live = cap.guard
            original_popen = subprocess.Popen
            def spawn(argv, **kwargs):
                return original_popen([sys.executable, '-c',
                    "import sys;sys.stdout.write('partial');sys.stderr.write('synthetic failure');sys.exit(2)"], **kwargs)
            with mock.patch.object(core.subprocess, 'Popen', side_effect=spawn) as child:
                with self.assertRaisesRegex(subject.VerificationError, 'COMMAND_FAILED'):
                    cap.command('database')
                self.assertEqual(child.call_count, 1)
            self.assertEqual((cap.root / 'command-database-stdout.bin').read_bytes(), b'partial')
            self.assertTrue((cap.root / 'command-database-backend-final.json').exists())

    def test_capture_context_includes_late_monitor_and_failure_has_no_success_receipt(self):
        import tempfile
        import contextlib
        from unittest import mock
        for fail_exit in (False, True):
            with self.subTest(fail_exit=fail_exit), tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
                core, p, review, ports = self.capture_fixture(Path(directory))
                cap = core.Current124SourceCapture(p, core.ReviewedCurrentRestoreCapture(raw(review)), ports)
                events = []
                @contextlib.contextmanager
                def context():
                    events.append('enter')
                    try: yield
                    finally:
                        events.append('exit')
                        self.assertTrue(cap.memory_stop.is_set())
                        self.assertFalse(cap.memory_thread.is_alive())
                        if fail_exit: raise ValueError('late source closure failure')
                ports.source_context = context
                cap.command = lambda kind: b'PGDMPsynthetic' if kind == 'database' else b'CREATE ROLE synthetic;'
                with mock.patch.object(core, 'verify_current_capture_sources'):
                    if fail_exit:
                        with self.assertRaisesRegex(ValueError, 'late source closure'):
                            cap.run()
                        self.assertFalse((cap.root / 'capture-receipt.json').exists())
                    else:
                        result = cap.run()
                        self.assertEqual(result['actualRestore'], 'NOT_RUN')
                        self.assertFalse(result['targetCreated'])
                        self.assertEqual(result['storageMissing'], 39)
                        self.assertTrue((cap.root / 'capture-receipt.json').exists())
                self.assertEqual(events, ['enter', 'exit'])
                with self.assertRaisesRegex(subject.VerificationError, 'NO_REPLAY'):
                    cap.run()


    def test_separate_tool_and_source_git_heads_and_full_manifest_are_real_pinned_bytes(self):
        import tempfile
        import os
        import subprocess
        with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
            root = Path(directory); os.chmod(root, 0o700)
            core, p, review, ports = self.capture_fixture(root)
            def git(repo, *args):
                return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.DEVNULL)
            def repository(name, files):
                repo = root / name; repo.mkdir(mode=0o700)
                git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Synthetic capture')
                git(repo, 'config', 'user.email', 'fixture@example.invalid')
                pins = {}
                for relative, value in files.items():
                    path = repo / relative; path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(value); pins[relative] = hashlib.sha256(value).hexdigest()
                git(repo, 'add', '.'); git(repo, 'commit', '-qm', name)
                return repo, git(repo, 'rev-parse', 'HEAD').decode().strip(), pins
            tool, tool_head, tool_pins = repository('tools-repo', {
                name: ('# synthetic tool ' + name).encode() for name in core.CURRENT_CAPTURE_TOOLS})
            source, source_head, source_pins = repository('source-repo', {
                core.RECOVERY: b'# synthetic recovery', core.HELPER: b'# synthetic snapshot',
                **{x['path']: ('select ' + str(i) + ';').encode() for i, x in enumerate(review['migrations'])}})
            review.update(toolRepo=str(tool), toolHead=tool_head, toolPins=tool_pins,
                          sourceRepo=str(source), sourceHead=source_head, sourcePins=source_pins,
                          migrations=core.inspect_migrations(source)['migrations'])
            authority = root / 'authority.py'; authority.write_bytes(b'# synthetic reviewed root assembly')
            os.chmod(authority, 0o600)
            review['portAuthoritySha256'] = hashlib.sha256(authority.read_bytes()).hexdigest()
            checked = core.ReviewedCurrentRestoreCapture(raw(review))
            core.verify_current_capture_sources(checked)
            self.assertNotEqual(tool_head, source_head)
            path = source / core.RECOVERY; path.write_bytes(b'# changed source')
            with self.assertRaisesRegex(subject.VerificationError, 'SOURCE_CHANGED'):
                core.verify_current_capture_sources(checked)
            git(source, 'add', '.'); git(source, 'commit', '-qm', 'new source HEAD')
            with self.assertRaisesRegex(subject.VerificationError, 'HEAD_CHANGED'):
                core.verify_current_capture_sources(checked)
            self.assertEqual(git(tool, 'rev-parse', 'HEAD').decode().strip(), tool_head)

    def test_wrong_actual_history_is_saved_then_refused_before_dump(self):
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
            core, p, review, ports = self.capture_fixture(Path(directory))
            ports.sql = lambda _: '[]'
            cap = core.Current124SourceCapture(p, core.ReviewedCurrentRestoreCapture(raw(review)), ports)
            with mock.patch.object(core, 'verify_current_capture_sources'), mock.patch.object(cap, 'command') as command:
                with self.assertRaisesRegex(subject.VerificationError, 'ACTUAL124_HISTORY'):
                    cap.run()
                command.assert_not_called()
            self.assertTrue((cap.root / 'before-history-raw.json').exists())
            self.assertFalse((cap.root / 'capture-receipt.json').exists())

    def test_late_memory_failure_rejects_result_and_closes_context(self):
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
            core, p, review, ports = self.capture_fixture(Path(directory))
            cap = core.Current124SourceCapture(p, core.ReviewedCurrentRestoreCapture(raw(review)), ports)
            cap.command = lambda kind: b'PGDMPsynthetic' if kind == 'database' else b'CREATE ROLE synthetic;'
            original = cap.checkpoint
            def checkpoint(label):
                result = original(label)
                if label == 'after': cap.memory_failures.append('synthetic late monitor failure')
                return result
            cap.checkpoint = checkpoint
            with mock.patch.object(core, 'verify_current_capture_sources'):
                with self.assertRaisesRegex(subject.VerificationError, 'MEMORY_MONITOR_FAILED'):
                    cap.run()
            self.assertTrue(cap.memory_stop.is_set())
            self.assertFalse(cap.memory_thread.is_alive())
            self.assertFalse((cap.root / 'capture-receipt.json').exists())
            self.assertEqual(json.loads((cap.root / 'capture-finalization.json').read_bytes())['status'], 'FAILED')


    def test_unproven_process_group_is_sticky_and_prevents_backend_sql(self):
        import tempfile
        import subprocess
        from unittest import mock
        with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
            root = Path(directory)
            core, p, review, ports = self.capture_fixture(root)
            helper = root / 'tool-repo/tools/local/run_current_auth_source.py'
            helper.parent.mkdir(parents=True)
            helper.write_text("def process_group_state(pgid): return {}\ndef close_process_group(child, **kwargs): return {'closed': False}\n")
            review['toolRepo'] = str(root / 'tool-repo')
            review['toolPins']['tools/local/run_current_auth_source.py'] = hashlib.sha256(helper.read_bytes()).hexdigest()
            cap = core.Current124SourceCapture(p, core.ReviewedCurrentRestoreCapture(raw(review)), ports)
            cap.root.mkdir(mode=0o700); cap.created = True; cap.guard = lambda **kwargs: None
            cap._guard_live = cap.guard
            original_popen = subprocess.Popen
            ports.sql = mock.Mock(return_value='0')
            def spawn(argv, **kwargs):
                return original_popen([sys.executable, '-c', "print('synthetic')"], **kwargs)
            with mock.patch.object(core.subprocess, 'Popen', side_effect=spawn):
                with self.assertRaisesRegex(core.RestoreError, 'PROCESS_GROUP_UNPROVEN'):
                    cap.command('database')
            self.assertTrue(cap.sticky)
            self.assertEqual(ports.sql.call_count, 1)  # 사전 관측만. 미종결 이후 SQL 추가0.
            self.assertFalse((cap.root / 'command-database-backend-final.json').exists())
            self.assertEqual(json.loads((cap.root / 'command-database-closure.json').read_bytes()), {'closed': False})

    def test_output_limit_keeps_bounded_raw_and_whole_stream_hash_before_refusal(self):
        import tempfile
        import subprocess
        from unittest import mock
        with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
            core, p, review, ports = self.capture_fixture(Path(directory))
            name = 'tools/local/run_current_auth_source.py'
            review['toolPins'][name] = hashlib.sha256((LOCAL.parents[1] / name).read_bytes()).hexdigest()
            cap = core.Current124SourceCapture(p, core.ReviewedCurrentRestoreCapture(raw(review)), ports)
            cap.root.mkdir(mode=0o700); cap.created = True; cap.guard = lambda **kwargs: None
            cap._guard_live = cap.guard
            original_popen = subprocess.Popen
            count = 2 * 1024**2 + 17
            def spawn(argv, **kwargs):
                return original_popen([sys.executable, '-c',
                    "import sys;sys.stderr.buffer.write(b'x' * " + str(count) + ")"], **kwargs)
            with mock.patch.object(core.subprocess, 'Popen', side_effect=spawn):
                with self.assertRaisesRegex(subject.VerificationError, 'OUTPUT_LIMIT'):
                    cap.command('database')
            self.assertEqual((cap.root / 'command-database-stderr.bin').stat().st_size, 2 * 1024**2)
            proof = json.loads((cap.root / 'command-database-streams.json').read_bytes())['stderr']
            self.assertEqual(proof['observedBytes'], count)
            self.assertEqual(proof['wholeStreamSha256'], hashlib.sha256(b'x' * count).hexdigest())
            self.assertTrue(proof['wholeStreamProven'])
            self.assertFalse(proof['storedComplete'])


    def test_raw_or_backend_evidence_save_failure_keeps_sticky_before_any_followup_ports(self):
        import tempfile
        import subprocess
        from unittest import mock
        cases = [('unproven_pg', 'command-database-stdout.bin'),
                 ('closed_pg', 'command-database-stdout.bin'),
                 ('closed_pg', 'command-database-backend-final.json')]
        for mode, failed_name in cases:
            with self.subTest(mode=mode, failed_name=failed_name), tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
                root = Path(directory)
                core, p, review, ports = self.capture_fixture(root)
                name = 'tools/local/run_current_auth_source.py'
                if mode == 'unproven_pg':
                    helper = root / 'tool-repo' / name
                    helper.parent.mkdir(parents=True)
                    helper.write_text("def process_group_state(pgid): return {}\ndef close_process_group(child, **kwargs): return {'closed': False}\n")
                    review['toolRepo'] = str(root / 'tool-repo')
                else:
                    helper = LOCAL.parents[1] / name
                review['toolPins'][name] = hashlib.sha256(helper.read_bytes()).hexdigest()
                cap = core.Current124SourceCapture(p, core.ReviewedCurrentRestoreCapture(raw(review)), ports)
                cap.root.mkdir(mode=0o700); cap.created = True
                cap.guard = lambda **kwargs: None
                cap._guard_live = cap.guard
                real_save = cap.save
                def save(name, value):
                    if name == failed_name: raise OSError('synthetic evidence fsync failure')
                    return real_save(name, value)
                cap.save = save
                real_spawn = subprocess.Popen
                def spawn(argv, **kwargs):
                    return real_spawn([sys.executable, '-c', "print('synthetic raw')"], **kwargs)
                with mock.patch.object(core.subprocess, 'Popen', side_effect=spawn):
                    with self.assertRaisesRegex(OSError, 'fsync failure'):
                        cap.command('database')
                self.assertTrue(cap.sticky)
                cap.guard = core.Current124SourceCapture.guard.__get__(cap)
                for attr in ('identity', 'metadata', 'sql', 'memory_kib'):
                    setattr(ports, attr, mock.Mock(side_effect=AssertionError('followup port must not run')))
                with mock.patch.object(core, 'verify_current_capture_sources',
                                       side_effect=AssertionError('followup source read must not run')) as source_guard:
                    with self.assertRaisesRegex(subject.VerificationError, 'CLOSURE_STICKY'):
                        cap.guard()
                    with self.assertRaisesRegex(subject.VerificationError, 'CLOSURE_STICKY'):
                        cap.command('roles')
                    source_guard.assert_not_called()
                for attr in ('identity', 'metadata', 'sql', 'memory_kib'):
                    getattr(ports, attr).assert_not_called()


    def test_growing_stream_never_drains_to_eof_even_when_closure_is_unproven(self):
        import tempfile
        import os
        import prepare_database_restore as core
        for closed in (False, True):
            with self.subTest(process_group_closed=closed), tempfile.TemporaryFile(dir='/private/tmp') as stream:
                stream.write(b'x' * (4 * 1024**2)); stream.flush()
                initial_size = os.fstat(stream.fileno()).st_size
                class GrowingReader:
                    def __init__(self): self.calls = 0
                    def fileno(self): return stream.fileno()
                    def seek(self, position): return stream.seek(position)
                    def read(self, count):
                        self.calls += 1
                        if self.calls > 8: raise AssertionError('unbounded writer drain')
                        before = os.fstat(stream.fileno()).st_size
                        os.pwrite(stream.fileno(), b'growing' * 200000, before)
                        return stream.read(count)
                reader = GrowingReader()
                stored, proof = core.capture_current_restore_stream(reader, 32, closed)
                self.assertEqual(stored, b'x' * 32)
                self.assertEqual(proof['observedBytes'], initial_size)
                self.assertFalse(proof['wholeStreamProven'])
                self.assertIsNone(proof['wholeStreamSha256'])
                self.assertLessEqual(proof['hashedBytes'], initial_size)
                self.assertEqual(reader.calls, 5 if closed else 1)

    def test_closed_oversize_stream_preserves_only_prefix_without_hashing_huge_file(self):
        import tempfile
        import prepare_database_restore as core
        with tempfile.TemporaryFile(dir='/private/tmp') as stream:
            stream.write(b'prefix'); stream.truncate(128 * 1024**2 + 1); stream.flush()
            stored, proof = core.capture_current_restore_stream(stream, 6, True)
            self.assertEqual(stored, b'prefix')
            self.assertFalse(proof['wholeStreamProven'])
            self.assertEqual(proof['hashedBytes'], 6)
            self.assertIsNone(proof['wholeStreamSha256'])
            with self.assertRaises(subject.VerificationError):
                core.capture_current_restore_stream(stream, -1, True)


if __name__ == '__main__':
    unittest.main()
