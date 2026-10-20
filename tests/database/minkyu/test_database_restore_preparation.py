"""현재121 실제 입력과 기존 비교 계약의 오프라인 회귀. Docker/DB 실행 없음."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'tools/local'))
import prepare_database_restore as restore


def state_fixture():
    return {'snapshot': {'rows': {
        'private.ai_account_budget_reservations': '2:account-original',
        'private.ai_budget_reservations': '2:legacy-original',
        'private.member_cleanup_dispatches': '1:dispatch-original',
        'private.member_cleanup_delete_acks': '1:ack-original',
        'private.member_cleanup_tasks': '1:task-original',
        'private.ai_account_daily_budget': '1:budget-original'},
        'roles': {'roles': [{'rolname': 'supabase_admin', 'rolsuper': True},
                            {'rolname': 'minkyu_fixture', 'rolcanlogin': False}],
                  'memberships': [['supabase_admin', 'minkyu_fixture', 'supabase_admin', False, True, True]]},
        'catalog': 'CREATE TABLE private.fixture (id integer);'},
        'rawAuthority': {'database': ['postgres', 'supabase_admin', 'UTF8', 'C.UTF-8',
                                     'C.UTF-8', 'c', None, None, -1, True, False, 'pg_default', None, [], None],
            'schemas': [['private', 'supabase_admin', ['supabase_admin=UC/supabase_admin']]],
            'relations': [], 'columns': [], 'functions': [], 'defaults': [], 'dbRoleSettings': []},
        'effectivePrivileges': [['minkyu_fixture', 'schema', 'private', 'USAGE', False]],
        'sequences': {'private.restore121_seq_12345678': [41, True]}}


def locale_fixture(state=None):
    database = (state or state_fixture())['rawAuthority']['database']
    return {'encoding': database[2], 'collate': database[3], 'ctype': database[4],
            'provider': database[5], 'locale': database[6], 'version': database[7],
            'actualVersion': database[7], 'icuRules': None}


class DatabaseRestorePreparationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.migrations = restore.current_manifest(REPO)
        cls.recovery, cls.old_helper = restore.load_existing(REPO)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='yumidang-restore121-test-')
        self.root = Path(self.tmp.name).resolve(); self.root.chmod(0o700)
        self.prepared = self.root / 'source'; self.prepared.mkdir(mode=0o700)
        self.project = 'jonghyun-backend100-aabbccdd'; self.source_id = 'a' * 64
        self.fixture = {'kind': 'SYNTHETIC_DB_SEED', 'sourceId': self.source_id,
            'ledgerId': 'restore121-' + 'a' * 32,
            'reservationIds': ['11111111-1111-4111-8111-111111111111',
                               '22222222-2222-4222-8222-222222222222'],
            'day': '2100-01-01', 'sequence': 'restore121_seq_12345678',
            'beforeUnknownCount': 0, 'afterUnknownCount': 2, 'productTransmission': 'NOT_RUN'}
        self.fixture['seedSqlSha256'] = restore.sha(restore.synthetic_seed_sql(
            self.fixture['ledgerId'], self.fixture['reservationIds'], self.fixture['day'], self.fixture['sequence']).encode())
        fixture_path = self.root / 'fixture.json'
        fixture_sha = restore.write_private(self.root, 'fixture.json', self.fixture)
        host = 'unix://' + str(Path.home() / '.colima/yumidang-minkyu/docker.sock')
        baseline = {'version': 1, 'scope': 'OBSERVED_EXISTING_RESOURCES_METADATA_ONLY',
            'profile': 'yumidang-minkyu', 'dockerHost': host, 'containers': [],
            'customNetworks': [], 'volumes': [], 'existingDatabaseOrStorageRead': 'NOT_RUN',
            'existingMutationCommands': 'NOT_RUN', 'wholeStoredBytesPreserved': 'NOT_VERIFIED',
            'baselineMetadataSha256': '0' * 64}
        baseline_sha = restore.write_private(self.prepared, 'protected-resource-baseline.json', baseline)
        intent = {'version': 2, 'context': 'colima-yumidang-minkyu', 'dockerHost': host,
            'project': self.project, 'scope': 'new-synthetic-only', 'existingContainers': [],
            'existingNetworks': [], 'preservedBaselineSha256': baseline_sha}
        owned = [{'id': self.source_id, 'name': 'supabase_db_' + self.project, 'image': 'sha256:' + 'b' * 64}]
        self.network = {'id': '6' * 64, 'name': 'supabase_network_' + self.project}
        for name, value in [('execution-intent.json', intent), ('owned-containers.json', owned),
                            ('owned-networks.json', [self.network]), ('owned-volumes.json', [])]:
            restore.write_private(self.prepared, name, value)
        self.source = {'preparedRoot': str(self.prepared),
            'preservedPins': restore.guards.preserved_resource_pins(self.prepared, intent),
            'context': intent['context'], 'host': host, 'project': self.project,
            'id': self.source_id, 'name': owned[0]['name'], 'image': owned[0]['image'],
            'configSha256': '1' * 64, 'hostConfigSha256': '2' * 64,
            'startedAt': '2026-10-19T00:00:00Z', 'restartCount': 0,
            'mountsSha256': restore.guards.preserved_mounts_sha([]), 'unknownCount': 2,
            'fixtureReceipt': {'path': str(fixture_path), 'sha256': fixture_sha}}
        phase = self.prepared / 'positive'; phase.mkdir(mode=0o700)
        before = restore.write_private(phase, 'before-private.json', {'synthetic': 'before'})
        final = restore.write_private(phase, 'final-private.json', {'synthetic': 'final'})
        proof = restore.write_private(phase, 'positive-factory-proof.json', {'synthetic': 'product-proof'})
        binding = restore.write_private(self.prepared, 'signed-ai-binding-private.json', {'synthetic': 'binding'})
        positive = {'scope': 'SIGNED_POSITIVE_DISCOVERY_ONLY', 'status': 'PASS', 'fixedFailures': [],
            'sourceHead': restore.head(REPO), 'database': {'id': self.source_id, 'project': self.project,
                'preparedRoot': str(self.prepared)}, 'root': str(self.prepared), 'ownedChildClosed': True,
            'modelScope': 'SYNTHETIC_IN_MEMORY_ONLY', 'actualNaver': 'NOT_RUN', 'actualProviderQuality': 'NOT_RUN',
            'priorNegativeCasesReplayed': False, 'noReplay': True, 'sourcePinsSha256': '0' * 64,
            'reviewSha256': '1' * 64, 'originalAuth6ReceiptSha256': '2' * 64, 'originalBindingSha256': binding,
            'auth6RowsRetained': 'PASS', 'budgetRowsRetained': 'PASS',
            'fixtureCleanup': {'status': 'PASS', 'finalSnapshotPath': str(phase / 'final-private.json'),
                'finalSnapshotSha256': final, 'beforeSnapshotSha256': before,
                'baselineReservationsSha256': '3' * 64, 'finalReservationsSha256': '4' * 64},
            'originalRowsPreserved': {'status': 'PASS', 'beforeSnapshotSha256': before, 'finalSnapshotSha256': final},
            'unknownPreserved': {'status': 'PASS', 'baselineReservationsSha256': '3' * 64, 'finalReservationsSha256': '4' * 64},
            'actualPhaseReceipt': {'path': str(phase / 'positive-factory-proof.json'), 'sha256': proof}}
        digest = restore.write_private(phase, 'positive-receipt.json', positive)
        self.source['phaseReceipt'] = {'path': str(phase / 'positive-receipt.json'), 'sha256': digest}
        self.fixture['positiveReceiptSha256'] = digest
        fixture_path.write_bytes(restore.canonical(self.fixture))
        self.source['fixtureReceipt']['sha256'] = restore.sha(restore.canonical(self.fixture))
        self.graph = {'version': 1, 'scope': restore.SCOPE, 'phase': 'CAPTURE',
            'reviewedByRoot': False, 'dockerSlotReady': False, 'repo': str(REPO),
            'sourceHead': restore.head(REPO), 'sourceFiles': restore.source_files(REPO),
            'migrations': copy.deepcopy(self.migrations), 'migrationManifestSha256': restore.secure.CURRENT_MANIFEST,
            'source': self.source, 'targetProject': 'jonghyun-backend100-eeeeffff',
            'baseline': None, 'minimumAvailableMiB': 1024, 'activationAllowed': False,
            'fullRestore': False, 'storage39': 'UNRESOLVED', 'productDeleteAck': 'NOT_RUN'}

    def tearDown(self):
        self.tmp.cleanup()

    def packet(self):
        packet = self.root / 'packet'; packet.mkdir(mode=0o700)
        approved = copy.deepcopy(self.graph)
        approved['reviewedByRoot'] = approved['dockerSlotReady'] = True
        values = {'source-state.json': state_fixture(), 'source.dump': b'synthetic-archive-not-executed',
                  'roles.sql': b'CREATE ROLE minkyu_fixture;\n', 'history.json':
                  [[x['version'], Path(x['path']).stem.split('_', 1)[1]] for x in self.migrations],
                  'archive-metadata.json': {}}
        values['database-locale.json'] = locale_fixture()
        files = {name: restore.write_private(packet, name, value) for name, value in values.items()}
        receipt = {'scope': restore.SCOPE, 'source': self.source, 'sourceHead': self.graph['sourceHead'],
            'sourceFiles': self.graph['sourceFiles'], 'migrations': self.migrations,
            'graphSha256': restore.sha(restore.canonical(approved)), 'files': files,
            'sourceUnchanged': True, 'actualRestore': 'NOT_RUN'}
        digest = restore.write_private(packet, 'capture-receipt.json', receipt)
        graph = approved; graph['phase'] = 'RESTORE'
        graph['baseline'] = {'root': str(packet), 'receiptSha256': digest}
        graph['reviewedByRoot'] = graph['dockerSlotReady'] = True
        return graph, packet

    def test_actual_current121_reviewed_inventory(self):
        self.assertEqual(len(self.migrations), 121)
        self.assertEqual(self.migrations[-2]['version'], '20261014010000')
        self.assertEqual(self.migrations[-1]['version'], '20261014020000')
        self.assertEqual(restore.verify_graph(self.graph), self.graph)

    def test_120_wrong_order_changed_sha_and_extra_rejected(self):
        for change in ('120', 'order', 'sha', 'extra'):
            g = copy.deepcopy(self.graph)
            if change == '120': g['migrations'].pop()
            elif change == 'order': g['migrations'][0], g['migrations'][1] = g['migrations'][1], g['migrations'][0]
            elif change == 'sha': g['migrations'][0]['sha256'] = '0' * 64
            else: g['migrations'].append(copy.deepcopy(g['migrations'][0]))
            with self.subTest(change=change), self.assertRaisesRegex(restore.RestoreError, 'CURRENT121_GRAPH_CHANGED'):
                restore.verify_graph(g)

    def test_unreviewed_run_has_no_constructor_or_command(self):
        with mock.patch.object(restore, 'load_existing') as loader:
            with self.assertRaisesRegex(restore.RestoreError, 'ROOT_REVIEW_AND_SLOT_REQUIRED'):
                restore.DatabaseRestore(self.graph, self.root)
            loader.assert_not_called()

    def test_external_graph_pin_is_required(self):
        restore.write_private(self.root, 'graph.json', self.graph)
        with self.assertRaisesRegex(restore.RestoreError, 'INPUT_CHANGED'):
            restore.load_graph(self.root / 'graph.json', '0' * 64)
        self.assertEqual(restore.load_graph(self.root / 'graph.json', restore.sha(restore.canonical(self.graph))), self.graph)

    def test_restore_packet_binds_current_source_and_all_bytes(self):
        graph, packet = self.packet()
        self.assertEqual(restore.verify_graph(graph), graph)
        (packet / 'source.dump').write_bytes(b'changed')
        with self.assertRaisesRegex(restore.RestoreError, 'INPUT_CHANGED'):
            restore.verify_graph(graph)

    def test_positive_database_scope_and_cleanup_must_match_actual_receipt(self):
        path = Path(self.source['phaseReceipt']['path']); value = json.loads(path.read_bytes())
        value['database']['id'] = '9' * 64
        path.write_bytes(restore.canonical(value)); digest = restore.sha(restore.canonical(value))
        self.source['phaseReceipt']['sha256'] = digest
        self.fixture['positiveReceiptSha256'] = digest
        Path(self.source['fixtureReceipt']['path']).write_bytes(restore.canonical(self.fixture))
        self.source['fixtureReceipt']['sha256'] = restore.sha(restore.canonical(self.fixture))
        with self.assertRaisesRegex(restore.RestoreError, 'POSITIVE_PHASE_NOT_FINAL'): restore.verify_graph(self.graph)

    def test_capture_graph_binding_cannot_be_replaced(self):
        graph, packet = self.packet()
        graph['minimumAvailableMiB'] = 1536
        with self.assertRaisesRegex(restore.RestoreError, 'CAPTURE_GRAPH_BINDING'): restore.verify_graph(graph)

    def test_old_source_unowned_and_same_target_rejected(self):
        for kind in ('old', 'same'):
            g = copy.deepcopy(self.graph)
            if kind == 'old': g['source']['id'] = '9' * 64
            else: g['targetProject'] = g['source']['project']
            with self.subTest(kind=kind), self.assertRaises(restore.RestoreError): restore.verify_graph(g)

    def test_fixture_cannot_claim_product_unknown_and_sql_is_insert_only(self):
        sql = restore.synthetic_seed_sql(self.fixture['ledgerId'], self.fixture['reservationIds'],
                                         self.fixture['day'], self.fixture['sequence'])
        self.assertNotIn('on conflict', sql.lower()); self.assertNotIn('update ', sql.lower())
        self.assertIn('nextval', sql); self.assertIn('unknown_at', sql)
        self.fixture['kind'] = 'PRODUCT_TRANSMISSION_UNKNOWN'
        (self.root / 'fixture.json').write_bytes(restore.canonical(self.fixture))
        self.source['fixtureReceipt']['sha256'] = restore.sha(restore.canonical(self.fixture))
        with self.assertRaisesRegex(restore.RestoreError, 'SYNTHETIC_SEED_ONLY'): restore.verify_graph(self.graph)

    def test_history_is_exact121_name_and_version(self):
        history = [[x['version'], Path(x['path']).stem.split('_', 1)[1]] for x in self.migrations]
        restore.verify_history(self.migrations, history)
        for bad in (history[:-1], list(reversed(history)), [[history[0][0], 'other']] + history[1:]):
            with self.assertRaisesRegex(restore.RestoreError, 'ACTUAL121_HISTORY_REQUIRED'):
                restore.verify_history(self.migrations, bad)

    def test_existing_full_state_comparison_is_reused_and_not119_scoped(self):
        state = state_fixture()
        value = self.recovery.native_restore_compare(state, copy.deepcopy(state), restore.sha(restore.canonical(state)))
        self.assertTrue(value['allRowsRolesRawAclEffectiveSequencesExact'])

    def test_icu_locale_options_preserve_exact_source_and_libc_categories(self):
        state = state_fixture(); state['rawAuthority']['database'][3:8] = [
            'en_US.UTF-8', 'en_US.UTF-8', 'i', 'en-US', '153.121']
        original = copy.deepcopy(state); proof = locale_fixture(state)
        self.assertEqual(restore.database_locale_options(state, proof),
            '--locale-provider=icu --icu-locale=en-US --lc-collate=en_US.UTF-8 --lc-ctype=en_US.UTF-8')
        self.assertEqual(state, original)
        self.assertEqual(restore.database_locale_options(state_fixture(), locale_fixture()),
            '--locale-provider=libc --lc-collate=C.UTF-8 --lc-ctype=C.UTF-8')

    def test_locale_unsafe_provider_rules_and_version_mismatch_are_rejected(self):
        state = state_fixture(); state['rawAuthority']['database'][3:8] = [
            'en_US.UTF-8', 'en_US.UTF-8', 'i', 'en-US', '153.121']
        for change in ('provider', 'empty_icu', 'shell_icu', 'shell_collate', 'rules', 'empty_rules', 'version', 'missing_version'):
            source = copy.deepcopy(state); proof = locale_fixture(source)
            if change == 'provider': source['rawAuthority']['database'][5] = proof['provider'] = 'b'
            elif change == 'empty_icu': source['rawAuthority']['database'][6] = proof['locale'] = ''
            elif change == 'shell_icu': source['rawAuthority']['database'][6] = proof['locale'] = 'en-US;exit'
            elif change == 'shell_collate': source['rawAuthority']['database'][3] = proof['collate'] = '$(env)'
            elif change == 'rules': proof['icuRules'] = '&a<b'
            elif change == 'empty_rules': proof['icuRules'] = ''
            elif change == 'version': proof['actualVersion'] = '154.1'
            else: source['rawAuthority']['database'][7] = proof['version'] = proof['actualVersion'] = None
            with self.subTest(change=change), self.assertRaises(restore.RestoreError):
                restore.database_locale_options(source, proof)

    def test_actual_locale_proof_requires_every_original_field_and_rules(self):
        state = state_fixture(); proof = locale_fixture(state)
        self.assertEqual(restore.verify_database_locale(state, proof), proof)
        for key in proof:
            changed = copy.deepcopy(proof); changed[key] = 'unreviewed'
            with self.subTest(key=key), self.assertRaises(restore.RestoreError):
                restore.verify_database_locale(state, changed)

    def test_icu_create_prepares_exact_options_before_memory_gate_and_no_creation(self):
        state = state_fixture(); state['rawAuthority']['database'][3:8] = [
            'en_US.UTF-8', 'en_US.UTF-8', 'i', 'en-US', '153.121']
        runner = object.__new__(restore.DatabaseRestore)
        runner.root = self.root; runner.source = self.source; runner.graph = self.graph; runner.target = None
        runner.locale_proof = locale_fixture(state)
        runner.command = mock.Mock(return_value=restore.canonical([
            {'Id': self.source['image'], 'Config': {'Volumes': None}}]))
        runner.initialize_guard = mock.Mock(); runner.guard = mock.Mock(); runner.raw = mock.Mock()
        runner.memory = mock.Mock(side_effect=restore.RestoreError('MEMORY_LOW_NO_NEW_WORK'))
        with self.assertRaisesRegex(restore.RestoreError, 'MEMORY_LOW'): runner.create_target(state)
        self.assertIn('--locale-provider=icu --icu-locale=en-US', runner.target_init)
        self.assertIn('--lc-collate=en_US.UTF-8 --lc-ctype=en_US.UTF-8', runner.target_init)
        runner.raw.assert_not_called(); self.assertIsNone(runner.target)

    def test_failure_code_uses_whitelist_and_never_sql_or_secret_text(self):
        self.assertEqual(restore.failure_code(restore.RestoreError('DATABASE_LOCALE_UNSUPPORTED')), 'DATABASE_LOCALE_UNSUPPORTED')
        for error in (restore.RestoreError('SQL secret raw text'), RuntimeError('DATABASE_LOCALE_UNSUPPORTED')):
            self.assertEqual(restore.failure_code(error), 'RESTORE_FAILED')
        self.assertEqual(restore.stage_code('database_locale_preflight'), 'database_locale_preflight')
        self.assertEqual(restore.stage_code('SQL secret raw text'), 'restore')

    def test_locale_original_packet_is_required_and_changed_bytes_are_rejected(self):
        graph, packet = self.packet()
        self.assertEqual(set(json.loads((packet / 'capture-receipt.json').read_bytes())['files']), restore.PACKET_FILES)
        original = (packet / 'database-locale.json').read_bytes()
        (packet / 'database-locale.json').write_bytes(original + b' ')
        with self.assertRaisesRegex(restore.RestoreError, 'INPUT_CHANGED'): restore.verify_graph(graph)
        (packet / 'database-locale.json').write_bytes(original)
        receipt = json.loads((packet / 'capture-receipt.json').read_bytes()); receipt['files'].pop('database-locale.json')
        raw = restore.canonical(receipt); (packet / 'capture-receipt.json').write_bytes(raw)
        graph['baseline']['receiptSha256'] = restore.sha(raw)
        with self.assertRaisesRegex(restore.RestoreError, 'CAPTURE_FILES_REQUIRED'): restore.verify_graph(graph)

    def test_actual_source_and_target_locale_reads_use_original_state(self):
        state = state_fixture(); state['rawAuthority']['database'][3:8] = [
            'en_US.UTF-8', 'en_US.UTF-8', 'i', 'en-US', '153.121']
        runner = object.__new__(restore.DatabaseRestore); runner.root = self.root
        runner.sql = mock.Mock(return_value=restore.canonical(locale_fixture(state)))
        for name, observation in ((self.source_id, 'restore_source_before'), ('c' * 64, 'target_initial')):
            self.assertEqual(runner.read_database_locale(name, state, observation=observation), locale_fixture(state))
            runner.sql.assert_called_with(name, restore.DATABASE_LOCALE_SQL)
        changed = locale_fixture(state); changed['actualVersion'] = '154.1'
        runner.sql.return_value = restore.canonical(changed)
        with self.assertRaisesRegex(restore.RestoreError, 'DATABASE_COLLATION_VERSION_MISMATCH'):
            runner.read_database_locale('c' * 64, state, observation='target_final')

    def test_invalid_actual_icu_version_preserves_raw_before_rejection(self):
        state = state_fixture(); state['rawAuthority']['database'][3:8] = [
            'en_US.UTF-8', 'en_US.UTF-8', 'i', 'en-US', '153.121']
        changed = locale_fixture(state); changed['actualVersion'] = '154.1'
        raw = b'  ' + restore.canonical(changed) + b'\n'
        runner = object.__new__(restore.DatabaseRestore); runner.root = self.root
        runner.sql = mock.Mock(return_value=raw)
        with self.assertRaisesRegex(restore.RestoreError, 'DATABASE_COLLATION_VERSION_MISMATCH'):
            runner.read_database_locale(self.source_id, state, observation='restore_source_before')
        path = self.root / 'source-before-locale-raw.json'
        self.assertEqual(path.read_bytes(), raw); self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_unsupported_icu_rules_preserves_raw_before_rejection_and_forbids_filename(self):
        state = state_fixture(); state['rawAuthority']['database'][3:8] = [
            'en_US.UTF-8', 'en_US.UTF-8', 'i', 'en-US', '153.121']
        changed = locale_fixture(state); changed['icuRules'] = '&a<b'
        raw = restore.canonical(changed) + b'\n'
        runner = object.__new__(restore.DatabaseRestore); runner.root = self.root
        runner.sql = mock.Mock(return_value=raw)
        with self.assertRaisesRegex(restore.RestoreError, 'DATABASE_ICU_RULES_UNSUPPORTED'):
            runner.read_database_locale('c' * 64, state, observation='target_initial')
        self.assertEqual((self.root / 'target-initial-locale-raw.json').read_bytes(), raw)
        runner.sql.reset_mock()
        with self.assertRaisesRegex(restore.RestoreError, 'FIXED_LOCALE_OBSERVATION_REQUIRED'):
            runner.read_database_locale('c' * 64, state, observation='../arbitrary.json')
        runner.sql.assert_not_called()

    def test_initial_icu_target_is_checked_before_role_or_archive_writes(self):
        state = state_fixture(); state['rawAuthority']['database'][3:8] = [
            'en_US.UTF-8', 'en_US.UTF-8', 'i', 'en-US', '153.121']
        runner = object.__new__(restore.DatabaseRestore)
        runner.root = self.root; runner.source = self.source; runner.graph = self.graph; runner.target = None
        runner.locale_proof = locale_fixture(state); runner.target_pins = {'configSha256': '1' * 64, 'hostConfigSha256': '2' * 64}
        runner.guard_root = self.root / 'guard'; runner.guard_root.mkdir(mode=0o700)
        restore.write_private(runner.guard_root, 'owned-containers.json', [])
        restore.write_private(runner.guard_root, 'execution-intent.json', {})
        runner.initialize_guard = mock.Mock(); runner.guard = mock.Mock(); runner.memory = mock.Mock()
        runner.own = mock.Mock(return_value={'State': {'Running': True}})
        runner.command = mock.Mock(return_value=restore.canonical([
            {'Id': self.source['image'], 'Config': {'Volumes': None}}]))
        runner.raw = mock.Mock(return_value=('c' * 64).encode())
        changed = locale_fixture(state); changed['locale'] = 'en_US'
        runner.sql = mock.Mock(side_effect=lambda name, query, **kw: b'1' if query == 'select 1;' else restore.canonical(changed))
        with mock.patch.object(restore.guards, 'preserved_resource_pins', return_value={}):
            with self.assertRaisesRegex(restore.RestoreError, 'DATABASE_LOCALE_CHANGED'): runner.create_target(state)
        create = runner.raw.call_args.args[0]
        self.assertEqual(create[:2], ['create', '--pull=never'])
        self.assertIn('--locale-provider=icu --icu-locale=en-US', create[-1])
        self.assertEqual(runner.stage, 'target_locale_preflight')
        self.assertEqual([call.args[1] for call in runner.sql.call_args_list], ['select 1;', restore.DATABASE_LOCALE_SQL])

    def test_unknown_dispatch_ack_task_budget_bag_changes_rejected(self):
        source = state_fixture()
        for table in source['snapshot']['rows']:
            changed = copy.deepcopy(source); changed['snapshot']['rows'][table] += '-other-same-count'
            with self.subTest(table=table), self.assertRaisesRegex(AssertionError, 'SNAPSHOT_MISMATCH'):
                self.recovery.native_restore_compare(source, changed, restore.sha(restore.canonical(source)))

    def test_sequence_is_called_role_grantor_and_privileges_changes_rejected(self):
        source = state_fixture()
        for kind in ('sequence', 'role', 'grantor', 'acl', 'effective'):
            changed = copy.deepcopy(source)
            if kind == 'sequence': changed['sequences']['private.restore121_seq_12345678'][1] = False
            elif kind == 'role': changed['snapshot']['roles']['roles'][1]['rolcanlogin'] = True
            elif kind == 'grantor': changed['snapshot']['roles']['memberships'][0][2] = 'minkyu_fixture'
            elif kind == 'acl': changed['rawAuthority']['schemas'][0][2] = None
            else: changed['effectivePrivileges'][0][4] = True
            with self.subTest(kind=kind), self.assertRaises(AssertionError):
                self.recovery.native_restore_compare(source, changed, restore.sha(restore.canonical(source)))

    def test_existing_collector_reads_sequence_last_value_and_is_called(self):
        state = state_fixture(); queries = []
        def query(name, sql):
            queries.append((name, sql))
            if sql == self.recovery.NATIVE_BACKUP_ACL_QUERY: return restore.canonical(state['rawAuthority'])
            if 'json_agg(json_build_array' in sql: return b'[["private","restore121_seq_12345678"]]'
            if 'last_value,is_called' in sql: return b'[41,true]'
            self.fail('unexpected collector query')
        with mock.patch.object(self.recovery, 'native_backup_permissions', return_value=state['effectivePrivileges']) as permissions:
            observed = self.recovery.native_backup_state(query,
                restore.SimpleNamespace(normalized_snapshot=lambda name: copy.deepcopy(state['snapshot'])), self.source_id)
        self.assertEqual(observed, state); permissions.assert_called_once()
        self.assertEqual(len(queries), 3)

    def test_target_existing_id_is_rejected_before_inspection(self):
        runner = object.__new__(restore.DatabaseRestore)
        runner.target = self.source_id; runner.source = self.source; runner.existing_ids = {self.source_id}
        runner.raw = mock.Mock()
        with self.assertRaisesRegex(restore.RestoreError, 'NEW_TARGET_ID_REQUIRED'): runner.own()
        runner.raw.assert_not_called()

    def test_source_identity_binds_config_image_mounts(self):
        config = {'Labels': {'com.supabase.cli.project': self.project}}
        host = {'Memory': 512 * 1024**2}
        self.source['configSha256'] = restore.sha(restore.canonical(config))
        self.source['hostConfigSha256'] = restore.sha(restore.canonical(host))
        x = {'Id': self.source_id, 'Name': '/' + self.source['name'], 'Image': self.source['image'],
             'State': {'Running': True, 'OOMKilled': False, 'StartedAt': self.source['startedAt']},
             'RestartCount': 0, 'Config': config, 'HostConfig': host, 'Mounts': [],
             'NetworkSettings': {'Networks': {self.network['name']: {'NetworkID': self.network['id']}}}}
        restore.verify_identity(self.source, x)
        x['Config']['Labels']['unexpected'] = 'changed'
        with self.assertRaisesRegex(restore.RestoreError, 'SOURCE_IDENTITY_CHANGED'): restore.verify_identity(self.source, x)

    def test_source_extra_or_replaced_actual_network_rejected(self):
        config = {'Labels': {'com.supabase.cli.project': self.project}}; host = {}
        self.source['configSha256'] = restore.sha(restore.canonical(config))
        self.source['hostConfigSha256'] = restore.sha(restore.canonical(host))
        x = {'Id': self.source_id, 'Name': '/' + self.source['name'], 'Image': self.source['image'],
             'State': {'Running': True, 'OOMKilled': False, 'StartedAt': self.source['startedAt']},
             'RestartCount': 0, 'Config': config, 'HostConfig': host, 'Mounts': [],
             'NetworkSettings': {'Networks': {self.network['name']: {'NetworkID': self.network['id']}}}}
        restore.verify_identity(self.source, x)
        for kind in ('added', 'replaced'):
            changed = copy.deepcopy(x)
            if kind == 'added': changed['NetworkSettings']['Networks']['other'] = {'NetworkID': '7' * 64}
            else: changed['NetworkSettings']['Networks'][self.network['name']]['NetworkID'] = '7' * 64
            with self.subTest(kind=kind), self.assertRaisesRegex(restore.RestoreError, 'SOURCE_NETWORK_CHANGED'):
                restore.verify_identity(self.source, changed)

    def test_source_write_is_refused_before_any_command(self):
        runner = object.__new__(restore.DatabaseRestore)
        runner.source = self.source; runner.target = None; runner.command = mock.Mock()
        with self.assertRaisesRegex(restore.RestoreError, 'SOURCE_WRITE_REFUSED'):
            runner.sql(self.source_id, 'delete from private.fixture;', write=True)
        runner.command.assert_not_called()

    def test_memory_floor_and_head_drift_fail_closed(self):
        runner = object.__new__(restore.DatabaseRestore)
        runner.source = self.source; runner.graph = self.graph; runner.repo = REPO
        runner.raw = mock.Mock(return_value=b'MemAvailable: 786431 kB\n')
        with self.assertRaisesRegex(restore.RestoreError, 'MEMORY_LOW'): runner.memory()
        self.assertEqual(runner.raw.call_args.kwargs['timeout'], 3)
        with mock.patch.object(restore, 'head', return_value='0' * 40):
            with self.assertRaisesRegex(restore.RestoreError, 'SOURCE_FILES_CHANGED'): runner.guard()

    def test_memory_probe_stale_success_is_rejected(self):
        runner = object.__new__(restore.DatabaseRestore)
        runner.source = self.source; runner.graph = self.graph; runner.memory_samples = []
        runner.raw = mock.Mock(return_value=b'MemAvailable: 2000000 kB\n')
        with mock.patch.object(restore.time, 'monotonic', side_effect=[10, 13.01]):
            with self.assertRaisesRegex(restore.RestoreError, 'MEMORY_PROBE_STALE'): runner.memory()
        self.assertEqual(runner.memory_samples, [])

    def test_failure_stores_final_state_and_stops_only_owned_target(self):
        graph, packet = self.packet(); output = self.root / 'failed'; output.mkdir(mode=0o700)
        runner = object.__new__(restore.DatabaseRestore)
        runner.graph = graph; runner.root = output; runner.source = self.source
        runner.recovery = self.recovery; runner.target = None
        runner.closed = mock.Mock(); runner.guard = mock.Mock(); runner.memory = mock.Mock()
        runner.state = mock.Mock(return_value=state_fixture())
        runner.sql = mock.Mock(side_effect=lambda name, query, **kw: restore.canonical(locale_fixture())
            if query == restore.DATABASE_LOCALE_SQL else (packet / 'history.json').read_bytes())
        target = 'c' * 64; running = [True]
        def create(state):
            runner.target = target
            raise restore.RestoreError('INJECTED_AFTER_CREATE')
        runner.create_target = create
        runner.own = lambda: {'State': {'Running': running[0]}}
        def raw(args):
            self.assertEqual(args, ['stop', '--time', '10', target]); running[0] = False
            return b''
        runner.raw = mock.Mock(side_effect=raw)
        with self.assertRaisesRegex(restore.RestoreError, 'FAILED_CLOSED'): runner.restore()
        result = json.loads((output / 'restore-receipt.json').read_bytes())
        self.assertEqual(result['status'], 'FAIL_CLOSED'); self.assertEqual(result['remainingIds'], [])
        self.assertTrue(result['sourceUnchanged']); self.assertFalse(result['fullRestore'])
        self.assertEqual(result['failureCode'], 'RESTORE_FAILED')
        self.assertEqual(result['stage'], 'source_preflight')
        self.assertEqual(result['storage39'], 'UNRESOLVED')
        self.assertTrue((output / 'source-after-private.json').exists()); runner.raw.assert_called_once()

    def test_fifo_reader_refuses_without_open_wait(self):
        fifo = self.root / 'fifo'; os.mkfifo(fifo, 0o600)
        with self.assertRaises(restore.secure.VerificationError): restore.read_pin(fifo, '0' * 64)

    def test_private_writer_never_overwrites_existing_packet(self):
        restore.write_private(self.root, 'once.json', {'once': 1})
        with self.assertRaises(FileExistsError): restore.write_private(self.root, 'once.json', {'once': 2})

    def test_declared_image_volume_refused_before_any_target_creation(self):
        runner = object.__new__(restore.DatabaseRestore)
        runner.source = self.source
        runner.command = mock.Mock(return_value=restore.canonical([
            {'Id': self.source['image'], 'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}]))
        runner.initialize_guard = mock.Mock()
        with self.assertRaisesRegex(restore.RestoreError, 'IMAGE_DECLARED_VOLUME_REFUSED'):
            runner.create_target(state_fixture())
        runner.initialize_guard.assert_not_called()

    def test_capture_failure_persists_before_and_final_without_success_receipt(self):
        output = self.root / 'capture-failed'; output.mkdir(mode=0o700)
        runner = object.__new__(restore.DatabaseRestore)
        runner.graph = self.graph; runner.root = output; runner.source = self.source
        runner.graph = copy.deepcopy(self.graph)
        runner.graph['reviewedByRoot'] = runner.graph['dockerSlotReady'] = True
        runner.guard = mock.Mock(); runner.closed = mock.Mock(); runner.recovery = self.recovery; runner.memory = mock.Mock()
        runner.state = mock.Mock(return_value=state_fixture())
        history = [[x['version'], Path(x['path']).stem.split('_', 1)[1]] for x in self.migrations]
        runner.sql = mock.Mock(side_effect=lambda name, query, **kw: restore.canonical(locale_fixture())
            if query == restore.DATABASE_LOCALE_SQL else restore.canonical(history))
        runner.command = mock.Mock(side_effect=restore.RestoreError('DUMP_FAILED'))
        with self.assertRaisesRegex(restore.RestoreError, 'CAPTURE_FAILED_CLOSED'): runner.capture()
        self.assertTrue((output / 'source-state.json').exists())
        self.assertTrue((output / 'source-final.json').exists())
        for name in ('capture-source-before-locale-raw.json', 'capture-source-final-locale-raw.json'):
            self.assertEqual((output / name).read_bytes(), restore.canonical(locale_fixture()))
            self.assertEqual((output / name).stat().st_mode & 0o777, 0o600)
        self.assertFalse((output / 'capture-receipt.json').exists())
        final = json.loads((output / 'capture-finalization.json').read_bytes())
        self.assertTrue(final['sourceUnchanged']); self.assertFalse(final['completePacket'])

    def test_restore_reservation_blocks_new_output_replay(self):
        graph, packet = self.packet()
        restore.write_private(packet, 'restore-reservation.json', {'attempt': 1})
        output = self.root / 'retry'; output.mkdir(mode=0o700)
        runner = object.__new__(restore.DatabaseRestore)
        runner.graph = graph; runner.root = output; runner.source = self.source
        runner.create_target = mock.Mock()
        with self.assertRaises(FileExistsError): runner.restore()
        runner.create_target.assert_not_called()

    def test_cleanup_failure_retains_exact_remaining_id(self):
        graph, packet = self.packet(); output = self.root / 'cleanup-failed'; output.mkdir(mode=0o700)
        runner = object.__new__(restore.DatabaseRestore)
        runner.graph = graph; runner.root = output; runner.source = self.source
        runner.recovery = self.recovery; runner.target = None
        runner.closed = mock.Mock(); runner.guard = mock.Mock(); runner.memory = mock.Mock()
        runner.state = mock.Mock(return_value=state_fixture())
        runner.sql = mock.Mock(side_effect=lambda name, query, **kw: restore.canonical(locale_fixture())
            if query == restore.DATABASE_LOCALE_SQL else (packet / 'history.json').read_bytes())
        target = 'd' * 64
        def create(state):
            runner.target = target
            raise restore.RestoreError('INJECTED_AFTER_CREATE')
        runner.create_target = create; runner.own = lambda: {'State': {'Running': True}}
        runner.raw = mock.Mock(side_effect=restore.RestoreError('STOP_FAILED'))
        with self.assertRaisesRegex(restore.RestoreError, 'FAILED_CLOSED'): runner.restore()
        result = json.loads((output / 'restore-receipt.json').read_bytes())
        self.assertEqual(result['remainingIds'], [target]); self.assertFalse(result['targetStopped'])
        self.assertFalse(result['actualRoleSequenceUnknownDatabaseRestore'])
        self.assertEqual(result['unknownOrigin'], 'SYNTHETIC_DB_SEED_NOT_PRODUCT_TRANSMISSION')

    def test_capture_guard_failure_records_stage_without_more_sql(self):
        output = self.root / 'preflight-failed'; output.mkdir(mode=0o700)
        runner = object.__new__(restore.DatabaseRestore)
        runner.graph = self.graph; runner.root = output; runner.source = self.source
        runner.guard = mock.Mock(side_effect=restore.RestoreError('HEAD_CHANGED'))
        runner.closed = mock.Mock(); runner.sql = mock.Mock(); runner.state = mock.Mock()
        with self.assertRaisesRegex(restore.RestoreError, 'CAPTURE_PREFLIGHT_FAILED'): runner.capture()
        result = json.loads((output / 'capture-finalization.json').read_bytes())
        self.assertEqual(result['sourceUnchanged'], 'NOT_PROVEN'); self.assertEqual(result['stage'], 'guard')
        runner.closed.assert_not_called(); runner.sql.assert_not_called(); runner.state.assert_not_called()

    def test_actual_child_failure_saves_private_raw_outputs_and_closed_group(self):
        runner = object.__new__(restore.DatabaseRestore)
        runner.root = self.root; runner.repo = REPO; runner.graph = self.graph
        runner.command_monitor = []; runner.memory_samples = []
        runner.group_helpers = restore.group_helpers(REPO, restore.source_files(REPO)['tools/local/observe_isolated.py'])
        runner.docker = [sys.executable, '-c', "import sys;sys.stdout.write('private-out');sys.stderr.write('private-err');sys.exit(7)"]
        with self.assertRaisesRegex(restore.RestoreError, 'DOCKER_COMMAND_FAILED'):
            runner.raw(['exec', 'psql'])
        metadata = list(self.root.glob('failure-command-*.json')); self.assertEqual(len(metadata), 1)
        result = json.loads(metadata[0].read_bytes()); self.assertTrue(result['closed'])
        self.assertEqual(result['exitCode'], 7); self.assertFalse(result['failureOutput']['truncated'])
        out = list(self.root.glob('failure-command-*.stdout'))[0]
        err = list(self.root.glob('failure-command-*.stderr'))[0]
        self.assertEqual(out.read_bytes(), b'private-out'); self.assertEqual(err.read_bytes(), b'private-err')
        self.assertEqual(out.stat().st_mode & 0o777, 0o600)

    def test_target_caps_config_hash_and_connected_network_drift_rejected(self):
        for kind in ('network', 'cpu', 'privileged', 'user', 'cmd', 'environment'):
            output = self.root / kind; output.mkdir(mode=0o700)
            runner, x, _ = self.transition_runner(output=output)
            runner.own(); changed = copy.deepcopy(x)
            if kind == 'network': changed['NetworkSettings']['Networks']['bridge'] = {'IPAddress': '10.0.0.2'}
            elif kind == 'cpu': changed['HostConfig']['NanoCpus'] = 1000000000
            elif kind == 'privileged': changed['HostConfig']['Privileged'] = True
            elif kind == 'user': changed['Config']['User'] = 'root'
            elif kind == 'cmd': changed['Config']['Cmd'] = ['-c', 'other']
            else: changed['Config']['Env'] = ['UNREVIEWED=true']
            runner.raw = mock.Mock(return_value=restore.canonical([changed]))
            with self.subTest(kind=kind), self.assertRaises(restore.RestoreError): runner.own()

    def transition_runner(self, *, graph=None, output=None):
        runner = object.__new__(restore.DatabaseRestore)
        runner.graph = graph or self.graph; runner.source = self.source
        runner.root = output or self.root; runner.target = 'c' * 64
        runner.existing_ids = {self.source_id}; runner.target_init = 'fixed-init'; runner.target_pins = None
        runner.guard = mock.Mock(); runner.memory = mock.Mock()
        x = {'Id': runner.target, 'Name': '/supabase_db_' + runner.graph['targetProject'], 'Image': self.source['image'],
            'Config': {'Labels': {'com.supabase.cli.project': runner.graph['targetProject'], 'yumidang.scope': restore.SCOPE,
                'yumidang.owner': 'minkyu', 'yumidang.graph': restore.sha(restore.canonical(runner.graph))},
                'Healthcheck': {'Test': ['NONE']}, 'User': 'postgres', 'Entrypoint': ['sh'],
                'Cmd': ['-c', 'fixed-init'], 'Env': []},
            'HostConfig': {'PortBindings': {}, 'NetworkMode': 'none', 'Memory': 512 * 1024**2,
                'MemorySwap': 512 * 1024**2, 'PidsLimit': 128, 'NanoCpus': 500000000,
                'Privileged': False, 'CapAdd': None, 'LogConfig': {'Type': 'none'}, 'OomKillDisable': False},
            'Mounts': [], 'State': {'OOMKilled': False, 'Running': False, 'Status': 'created',
                'StartedAt': '0001-01-01T00:00:00Z', 'Restarting': False},
            'RestartCount': 0, 'NetworkSettings': {'Networks': {'none': {'IPAddress': ''}}}}
        commands = []
        def raw(args, data=None):
            commands.append(args)
            if args == ['inspect', runner.target]: return b'  ' + restore.canonical([x]) + b'\n'
            if args == ['start', runner.target]:
                x['HostConfig']['OomKillDisable'] = None
                x['State'].update(Running=True, Status='running', StartedAt='2026-10-20T00:00:00Z')
                return b''
            if args == ['stop', '--time', '10', runner.target]:
                x['State'].update(Running=False, Status='exited'); return b''
            raise AssertionError('unexpected command')
        runner.raw = mock.Mock(side_effect=raw)
        return runner, x, commands

    def test_exact_start_false_to_null_preserves_raw_and_original_pins(self):
        runner, x, commands = self.transition_runner()
        original_raw = b'  ' + restore.canonical([x]) + b'\n'
        runner.own(); original = dict(runner.target_pins)
        runner.command(['start', runner.target])
        self.assertEqual((self.root / 'target-created-inspect-private.json').read_bytes(), original_raw)
        self.assertEqual((self.root / 'target-before-start-inspect-private.json').read_bytes(), original_raw)
        after = (self.root / 'target-after-start-inspect-private.json').read_bytes()
        self.assertEqual(after, b'  ' + restore.canonical([x]) + b'\n')
        proof = json.loads((self.root / 'target-hostconfig-transition.json').read_bytes())
        self.assertEqual(proof['afterInspectSha256'], restore.sha(after))
        self.assertEqual(proof['beforePins'], original); self.assertEqual(runner.target_pins, original)
        self.assertNotEqual(proof['afterPins']['hostConfigSha256'], original['hostConfigSha256'])
        runner.own(); self.assertEqual(commands.count(['start', runner.target]), 1)
        self.assertGreaterEqual(runner.guard.call_count, 2)

    def test_unstarted_null_change_is_rejected_and_created_raw_is_saved_before_verdict(self):
        runner, x, _ = self.transition_runner(); runner.own()
        x['HostConfig']['OomKillDisable'] = None
        with self.assertRaisesRegex(restore.RestoreError, 'TARGET_CONFIGURATION_CHANGED'): runner.own()
        self.assertFalse((self.root / 'target-hostconfig-transition.json').exists())
        self.assertTrue((self.root / 'target-created-inspect-private.json').exists())

    def test_start_transition_rejects_other_host_change_and_preserves_failed_raw(self):
        runner, x, commands = self.transition_runner(); runner.own()
        original = runner.raw.side_effect
        def changed(args, data=None):
            result = original(args, data)
            if args == ['start', runner.target]: x['HostConfig']['ReadonlyRootfs'] = True
            return result
        runner.raw.side_effect = changed
        with self.assertRaisesRegex(restore.RestoreError, 'TARGET_CONFIGURATION_CHANGED'):
            runner.command(['start', runner.target])
        after = (self.root / 'target-after-start-inspect-private.json').read_bytes()
        self.assertTrue(json.loads(after)[0]['HostConfig']['ReadonlyRootfs'])
        self.assertFalse((self.root / 'target-hostconfig-transition.json').exists())
        self.assertFalse(runner.target_start_pending)
        self.assertEqual(commands.count(['start', runner.target]), 1)

    def test_started_transition_reverse_and_second_start_are_rejected(self):
        runner, x, commands = self.transition_runner(); runner.own(); runner.command(['start', runner.target])
        with self.assertRaisesRegex(restore.RestoreError, 'TARGET_START_NO_REPLAY'):
            runner.command(['start', runner.target])
        self.assertEqual(commands.count(['start', runner.target]), 1)
        x['HostConfig']['OomKillDisable'] = False
        with self.assertRaisesRegex(restore.RestoreError, 'TARGET_CONFIGURATION_CHANGED'): runner.own()

    def test_invalid_initial_oom_metadata_is_saved_before_rejection(self):
        for value in (True, 'missing'):
            output = self.root / str(value); output.mkdir(mode=0o700)
            runner, x, _ = self.transition_runner(output=output)
            if value == 'missing': del x['HostConfig']['OomKillDisable']
            else: x['HostConfig']['OomKillDisable'] = value
            with self.subTest(value=value), self.assertRaisesRegex(restore.RestoreError, 'TARGET_IDENTITY_CHANGED'):
                runner.own()
            raw = (output / 'target-created-inspect-private.json').read_bytes()
            self.assertEqual(json.loads(raw)[0], x); self.assertIsNone(runner.target_pins)
            self.assertEqual((output / 'target-created-inspect-private.json').stat().st_mode & 0o777, 0o600)

    def test_initial_null_metadata_stays_exact_without_transition_exception(self):
        runner, x, _ = self.transition_runner(); x['HostConfig']['OomKillDisable'] = None
        runner.own(); original = dict(runner.target_pins); runner.command(['start', runner.target]); runner.own()
        self.assertEqual(runner.target_pins, original)
        self.assertFalse((self.root / 'target-hostconfig-transition.json').exists())
        self.assertIsNone(getattr(runner, 'target_runtime_pins', None))

    def test_transition_evidence_tamper_and_actual_network_change_are_rejected(self):
        runner, x, _ = self.transition_runner(); runner.own(); runner.command(['start', runner.target])
        path = self.root / 'target-after-start-inspect-private.json'; original = path.read_bytes()
        path.write_bytes(original + b' ')
        with self.assertRaisesRegex(restore.RestoreError, 'INPUT_CHANGED'): runner.own()
        path.write_bytes(original)
        x['NetworkSettings']['Networks']['bridge'] = {'IPAddress': '10.0.0.2'}
        with self.assertRaisesRegex(restore.RestoreError, 'TARGET_IDENTITY_CHANGED'): runner.own()

    def test_transition_cleanup_stops_only_exact_new_id_and_links_original_runtime_pins(self):
        graph, packet = self.packet(); output = self.root / 'transition-cleanup'; output.mkdir(mode=0o700)
        runner, x, commands = self.transition_runner(graph=graph, output=output)
        target = runner.target; runner.target = None
        runner.recovery = self.recovery; runner.closed = mock.Mock(); runner.state = mock.Mock(return_value=state_fixture())
        runner.sql = lambda name, query, **kw: restore.canonical(locale_fixture()) if query == restore.DATABASE_LOCALE_SQL else (packet / 'history.json').read_bytes()
        def create(state):
            runner.target = target; runner.own(); runner.command(['start', target])
            raise restore.RestoreError('ARCHIVE_CHANGED')
        runner.create_target = create
        with self.assertRaisesRegex(restore.RestoreError, 'RESTORE_FAILED_CLOSED'): runner.restore()
        receipt = json.loads((output / 'restore-receipt.json').read_bytes())
        self.assertEqual(receipt['status'], 'FAIL_CLOSED'); self.assertEqual(receipt['failureCode'], 'ARCHIVE_CHANGED')
        self.assertEqual(receipt['remainingIds'], []); self.assertTrue(receipt['targetStopped'])
        self.assertTrue(receipt['sourceUnchanged']); self.assertTrue(receipt['existingMetadataPreserved'])
        self.assertEqual([cmd for cmd in commands if cmd[0] == 'stop'], [['stop', '--time', '10', target]])
        evidence = receipt['targetConfigurationEvidence']
        self.assertEqual(evidence['originalPins'], runner.target_pins)
        self.assertEqual(evidence['runtimePins'], runner.target_runtime_pins)
        self.assertEqual(evidence['transitionSha256'], restore.sha((output / 'target-hostconfig-transition.json').read_bytes()))
        identity_raw = (output / 'target-started-identity.json').read_bytes()
        self.assertEqual(evidence['startedIdentitySha256'], restore.sha(identity_raw))
        self.assertEqual(x['State']['StartedAt'], json.loads(identity_raw)['startedAt'])
        self.assertTrue((output / 'target-before-stop-inspect-private.json').exists())
        self.assertFalse(x['State']['Running'])

    def test_pinned_pure_inspection_has_no_writes_or_transition_exception(self):
        runner, x, _ = self.transition_runner(); x['HostConfig']['OomKillDisable'] = None
        pins = {'configSha256': restore.sha(restore.canonical(x['Config'])),
                'hostConfigSha256': restore.sha(restore.canonical(x['HostConfig']))}
        checker = restore.SimpleNamespace(source=self.source, graph=self.graph, target=runner.target,
            existing_ids={self.source_id}, target_init='fixed-init', target_pins=pins,
            raw=mock.Mock(return_value=restore.canonical([x])))
        with mock.patch.object(restore, 'write_private', side_effect=AssertionError('pure inspection wrote')), \
             mock.patch.object(restore, 'read_pin', side_effect=AssertionError('pure inspection read evidence')):
            self.assertEqual(restore.DatabaseRestore.own(checker), x)
            original_h = dict(x['HostConfig']); original_h['OomKillDisable'] = False
            checker.target_pins = {**pins, 'hostConfigSha256': restore.sha(restore.canonical(original_h))}
            checker.target_start_pending = True
            with self.assertRaisesRegex(restore.RestoreError, 'TARGET_CONFIGURATION_CHANGED'):
                restore.DatabaseRestore.own(checker)
            checker.raw.reset_mock()
            with self.assertRaisesRegex(restore.RestoreError, 'EXACT_PINNED_INSPECTION_REQUIRED'):
                restore.DatabaseRestore.own(checker, observation='after_start')
            checker.raw.assert_not_called()

    def test_transition_cleanup_refuses_changed_target_and_retains_exact_remaining_id(self):
        graph, packet = self.packet(); output = self.root / 'changed-cleanup'; output.mkdir(mode=0o700)
        runner, x, commands = self.transition_runner(graph=graph, output=output)
        target = runner.target; runner.target = None
        runner.recovery = self.recovery; runner.closed = mock.Mock(); runner.state = mock.Mock(return_value=state_fixture())
        runner.sql = lambda name, query, **kw: restore.canonical(locale_fixture()) if query == restore.DATABASE_LOCALE_SQL else (packet / 'history.json').read_bytes()
        def create(state):
            runner.target = target; runner.own(); runner.command(['start', target])
            x['HostConfig']['ReadonlyRootfs'] = True
            raise restore.RestoreError('ARCHIVE_CHANGED')
        runner.create_target = create
        with self.assertRaisesRegex(restore.RestoreError, 'RESTORE_FAILED_CLOSED'): runner.restore()
        receipt = json.loads((output / 'restore-receipt.json').read_bytes())
        self.assertEqual(receipt['remainingIds'], [target]); self.assertFalse(receipt['targetStopped'])
        self.assertTrue(receipt['sourceUnchanged']); self.assertTrue(receipt['existingMetadataPreserved'])
        self.assertEqual([cmd for cmd in commands if cmd[0] == 'stop'], [])
        self.assertTrue(x['State']['Running'])

    def test_created_raw_is_saved_even_when_inspect_json_is_invalid(self):
        runner, _, _ = self.transition_runner(); raw = b'not-json-private-inspect\n'
        runner.raw = mock.Mock(return_value=raw)
        with self.assertRaises(Exception): runner.own()
        self.assertEqual((self.root / 'target-created-inspect-private.json').read_bytes(), raw)
        self.assertIsNone(runner.target_pins)

    def test_same_configuration_manual_restart_is_rejected_with_raw_before_verdict(self):
        for initial in (False, None):
            output = self.root / str(initial); output.mkdir(mode=0o700)
            runner, x, _ = self.transition_runner(output=output)
            x['HostConfig']['OomKillDisable'] = initial
            runner.own(); runner.command(['start', runner.target])
            proof = json.loads((output / 'target-started-identity.json').read_bytes())
            self.assertEqual(proof['startedAt'], x['State']['StartedAt'])
            self.assertEqual(proof['restartCount'], 0)
            config = restore.canonical([x['Config'], x['HostConfig']])
            x['State']['StartedAt'] = '2026-10-20T00:00:01Z'
            self.assertEqual(x['RestartCount'], 0)
            with self.subTest(initial=initial), self.assertRaisesRegex(restore.RestoreError, 'TARGET_START_IDENTITY_CHANGED'):
                runner.own()
            observed = output / 'target-incarnation-rejected-inspect-private.json'
            self.assertEqual(json.loads(observed.read_bytes())[0], x)
            self.assertEqual(observed.stat().st_mode & 0o777, 0o600)
            self.assertEqual(restore.canonical([x['Config'], x['HostConfig']]), config)

    def test_first_started_at_must_be_nonempty_and_raw_is_preserved_on_failure(self):
        for started in (None, '', '0001-01-01T00:00:00Z'):
            output = self.root / ('bad-time-' + str(len(list(self.root.iterdir())))); output.mkdir(mode=0o700)
            runner, x, _ = self.transition_runner(output=output); runner.own()
            original = runner.raw.side_effect
            def raw(args, data=None):
                result = original(args, data)
                if args == ['start', runner.target]: x['State']['StartedAt'] = started
                return result
            runner.raw.side_effect = raw
            with self.subTest(started=started), self.assertRaisesRegex(restore.RestoreError, 'TARGET_START_IDENTITY_CHANGED'):
                runner.command(['start', runner.target])
            self.assertEqual(json.loads((output / 'target-after-start-inspect-private.json').read_bytes())[0]['State']['StartedAt'], started)
            self.assertFalse((output / 'target-started-identity.json').exists())

    def test_sealed_start_rejects_restarting_and_restart_count_with_original_raw(self):
        for key, value in (('Restarting', True), ('RestartCount', 1)):
            output = self.root / key; output.mkdir(mode=0o700)
            runner, x, _ = self.transition_runner(output=output); runner.own(); runner.command(['start', runner.target])
            if key == 'Restarting': x['State'][key] = value
            else: x[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(restore.RestoreError, 'TARGET_START_IDENTITY_CHANGED'):
                runner.own()
            self.assertEqual(json.loads((output / 'target-incarnation-rejected-inspect-private.json').read_bytes())[0], x)

    def test_complete_adapter_uses_existing_comparison_and_stops_one_target(self):
        graph, packet = self.packet(); output = self.root / 'success'; output.mkdir(mode=0o700)
        runner = object.__new__(restore.DatabaseRestore)
        runner.graph = graph; runner.root = output; runner.source = self.source
        runner.recovery = self.recovery; runner.target = None
        runner.closed = mock.Mock(); runner.guard = mock.Mock(); runner.memory = mock.Mock()
        runner.state = mock.Mock(return_value=state_fixture())
        runner.helper = restore.SimpleNamespace(roles=lambda name: copy.deepcopy(state_fixture()['snapshot']['roles']))
        history = (packet / 'history.json').read_bytes(); commands = []; running = [True]
        runner.sql = lambda name, query, **kw: restore.canonical(locale_fixture()) if query == restore.DATABASE_LOCALE_SQL else history if query == restore.HISTORY_SQL else b'0'
        def create(state): runner.target = 'c' * 64
        runner.create_target = create
        runner.own = lambda: {'State': {'Running': running[0]}}
        def command(args, data=None): commands.append(args); return b'synthetic-toc'
        runner.command = command
        def raw(args):
            self.assertEqual(args, ['stop', '--time', '10', 'c' * 64]); running[0] = False
            return b''
        runner.raw = mock.Mock(side_effect=raw)
        with mock.patch.object(self.recovery, 'native_backup_database_archive', return_value={}) as archive, \
             mock.patch.object(self.recovery, 'native_restore_compare', wraps=self.recovery.native_restore_compare) as compare:
            result = runner.restore()
        self.assertEqual(result['status'], 'PASS_DB121_ONLY'); self.assertFalse(result['fullRestore'])
        self.assertEqual(result['storage39'], 'UNRESOLVED'); self.assertEqual(result['productDeleteAck'], 'NOT_RUN')
        self.assertTrue(result['targetStopped']); self.assertEqual(result['remainingIds'], [])
        self.assertEqual(compare.call_count, 3); archive.assert_called_once(); runner.raw.assert_called_once()
        self.assertTrue(any('dropdb' in cmd for cmd in commands))
        self.assertTrue(any('pg_restore' in cmd and '--exit-on-error' in cmd for cmd in commands))
        for name in ('source-before-locale.json', 'source-after-locale.json',
                     'target-restored-locale.json', 'target-final-locale.json'):
            self.assertEqual(json.loads((output / name).read_bytes()), locale_fixture())
        for name in ('source-before-locale-raw.json', 'source-after-locale-raw.json',
                     'target-restored-locale-raw.json', 'target-final-locale-raw.json'):
            self.assertEqual((output / name).read_bytes(), restore.canonical(locale_fixture()))
            self.assertEqual((output / name).stat().st_mode & 0o777, 0o600)

    def test_maintenance_768_boundary_and_stricter_start_boundary(self):
        runner = object.__new__(restore.DatabaseRestore)
        runner.source = self.source; runner.graph = self.graph; runner.memory_samples = []
        runner.raw = mock.Mock(return_value=b'MemAvailable: 786432 kB\n')
        self.assertEqual(runner.memory(), 786432)
        with self.assertRaisesRegex(restore.RestoreError, 'MEMORY_LOW'): runner.memory(start=True)
        runner.raw.return_value = b'MemAvailable: 786431 kB\n'
        with self.assertRaisesRegex(restore.RestoreError, 'MEMORY_LOW'): runner.memory()
        runner.raw.return_value = b'MemAvailable: 1048576 kB\n'
        self.assertEqual(runner.memory(start=True), 1048576)

    def test_start_below_1gb_never_creates_or_discovers_target(self):
        runner = object.__new__(restore.DatabaseRestore)
        runner.root = self.root; runner.source = self.source; runner.graph = self.graph
        runner.target = None; runner.memory_samples = []; runner.locale_proof = locale_fixture()
        runner.command = mock.Mock(return_value=restore.canonical([
            {'Id': self.source['image'], 'Config': {'Volumes': None}}]))
        runner.guard = mock.Mock(); runner.initialize_guard = mock.Mock()
        runner.raw = mock.Mock(return_value=b'MemAvailable: 1048575 kB\n')
        with self.assertRaisesRegex(restore.RestoreError, 'MEMORY_LOW'): runner.create_target(state_fixture())
        self.assertEqual(len(runner.raw.call_args_list), 1)
        self.assertEqual(runner.raw.call_args.args[0], ['exec', self.source_id, 'cat', '/proc/meminfo'])
        self.assertIsNone(runner.target)

    def test_existing_unicode_metadata_matches_original_resource_guard(self):
        runner = object.__new__(restore.DatabaseRestore)
        runner.source = self.source; runner.graph = self.graph; runner.root = self.root
        runner.guard = mock.Mock()
        x = {'Id': 'e' * 64, 'Name': '/existing-preserved', 'Image': 'sha256:' + 'f' * 64,
             'Config': {'Labels': {'설명': '기존 자원'}, 'Env': ['NOTE=한글']},
             'HostConfig': {'Binds': ['/tmp/한글:/data']}, 'Mounts': [],
             'State': {'Running': False, 'Status': 'exited', 'OOMKilled': False}}
        def raw(args):
            if args[:2] == ['context', 'inspect']: return self.source['host'].encode()
            if args[0] == 'ps': return ('e' * 64 + '\n').encode()
            if args[0] == 'inspect': return restore.canonical([x])
            if args[:2] in (['network', 'ls'], ['volume', 'ls']): return b''
            self.fail('unexpected resource observation')
        runner.raw = raw; runner.initialize_guard()
        restore.guards.verify_preserved_resources(runner.guard_root, self.source['host'],
            self.graph['targetProject'], lambda args: raw(args).decode(), runner.guard_pins)

    def test_direct_target_restore_drop_and_start_check_own_before_execution(self):
        for args in (['exec', 'c' * 64, 'dropdb', 'postgres'],
                     ['exec', '-i', 'c' * 64, 'pg_restore', '--create', '--exit-on-error'],
                     ['start', 'c' * 64]):
            runner = object.__new__(restore.DatabaseRestore)
            runner.source = self.source; runner.target = 'c' * 64
            runner.guard = mock.Mock(); runner.memory = mock.Mock(); runner.raw = mock.Mock()
            runner.own = mock.Mock(side_effect=restore.RestoreError('TARGET_CONFIGURATION_CHANGED'))
            with self.subTest(args=args), self.assertRaisesRegex(restore.RestoreError, 'TARGET_CONFIGURATION_CHANGED'):
                runner.command(args)
            runner.raw.assert_not_called(); runner.memory.assert_not_called()

    def test_direct_target_command_always_rechecks_own_and_source_afterward(self):
        runner = object.__new__(restore.DatabaseRestore)
        runner.source = self.source; runner.target = 'c' * 64
        runner.guard = mock.Mock(); runner.memory = mock.Mock(); runner.raw = mock.Mock(return_value=b'list')
        runner.own = mock.Mock(side_effect=[{}, restore.RestoreError('TARGET_IDENTITY_CHANGED')])
        with self.assertRaisesRegex(restore.RestoreError, 'TARGET_IDENTITY_CHANGED'):
            runner.command(['exec', '-i', runner.target, 'pg_restore', '--create', '--list'], b'archive')
        self.assertEqual(runner.own.call_count, 2); self.assertEqual(runner.guard.call_count, 2)
        runner.raw.assert_called_once()

    def test_direct_exec_to_other_container_or_source_write_is_refused(self):
        runner = object.__new__(restore.DatabaseRestore)
        runner.source = self.source; runner.target = 'c' * 64; runner.raw = mock.Mock()
        runner.guard = mock.Mock()
        for args in (['exec', 'e' * 64, 'psql'], ['exec', self.source_id, 'dropdb', 'postgres'],
                     ['exec', '-i', self.source_id, 'psql']):
            with self.subTest(args=args), self.assertRaises(restore.RestoreError): runner.command(args, b'delete;')
        runner.raw.assert_not_called(); runner.guard.assert_not_called()


if __name__ == '__main__':
    unittest.main()
