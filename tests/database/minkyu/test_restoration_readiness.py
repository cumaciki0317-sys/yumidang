"""오프라인 합성 증거만 사용한다. 실제 DB/컨테이너/원본 private 증거는 읽지 않는다."""
from __future__ import annotations

import copy
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

REPOSITORY = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY / 'tools/local'))
import verify_restoration_readiness as verification


class RestorationReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='yumidang-restoration-model-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.repo = self.root / 'repo'
        self.repo.mkdir(mode=0o700)
        self.ready_path = self.repo / verification.DOC / '2026-10-17-restoration-readiness.json'
        self.runtime_path = self.repo / verification.DOC / '2026-10-17-runtime-evidence.json'
        self.ready = json.loads((REPOSITORY / verification.DOC /
                                 '2026-10-17-restoration-readiness.json').read_bytes())
        self.runtime = json.loads((REPOSITORY / verification.DOC /
                                   '2026-10-17-runtime-evidence.json').read_bytes())
        for name in verification.SOURCE_PATHS:
            self.write(self.repo / name, (REPOSITORY / name).read_bytes())
        # 최신 정책 동기화로 아래 두 문서의 실제 bytes가 역사 readiness SHA와
        # 달라졌다. 현재 소스를 복사하는 합성 정상 fixture의 핀만 맞춘다.
        # 원본 readiness JSON과 실제 실행 검증기의 핀/거절은 변경하지 않는다.
        synthetic_current_documents = {
            str(Path(verification.DOC) / '2026-10-13-auth-lifecycle-execution.md'),
            str(Path(verification.DOC) / '2026-10-10-final-schema-storage-restore-static.md'),
        }
        for entry in self.ready['sourceInputs']:
            if entry['path'] in synthetic_current_documents:
                entry['sha256'] = verification.digest((self.repo / entry['path']).read_bytes())
        for entry in self.ready['currentMigrationInventory']['migrations']:
            name = entry['path']
            self.write(self.repo / name, (REPOSITORY / name).read_bytes())
        self.coverage_path = self.repo / verification.DOC / '2026-10-13-auth-lifecycle-coverage.json'
        self.coverage = json.loads(self.coverage_path.read_bytes())
        # 고정된 문서가 가리키는 역사 원본 부재와, 존재하는 한 원본의 해시검증을 함께 모델링한다.
        self.historical_path = self.root / 'historical' / 'strict-native119-comparison.json'
        raw = self.write(self.historical_path, {'scope': 'SIMULATED_SQL_JWT_DATABASE_ONLY',
                                              'rows': {'a' * 64: 2}, 'roles': ['owner'],
                                              'sequences': [['s', 9, True]]})
        old = self.coverage['actualSql120C20']['receipts']['strict-native119-comparison.json']
        old.update(path=str(self.historical_path), sha256=verification.digest(raw), bytes=len(raw))
        self.flush_coverage()
        self.make_artifact()
        self.make_runtime()
        self.flush()

    def write(self, path, value):
        path = Path(path)
        for parent in reversed(path.parents):
            if self.root == parent or self.root in parent.parents:
                parent.mkdir(mode=0o700, exist_ok=True)
                os.chmod(parent, 0o700)
        raw = value if isinstance(value, bytes) else verification.canonical(value)
        path.write_bytes(raw)
        os.chmod(path, 0o600)
        return raw

    def flush_coverage(self):
        raw = self.write(self.coverage_path, self.coverage)
        for entry in self.ready['sourceInputs']:
            if entry['path'] == str(self.coverage_path.relative_to(self.repo)):
                entry['sha256'] = verification.digest(raw)

    def make_artifact(self):
        self.artifact = self.root / 'prepared'
        for entry in self.ready['currentMigrationInventory']['migrations']:
            self.write(self.artifact / 'supabase/migrations' / Path(entry['path']).name,
                       (self.repo / entry['path']).read_bytes())
        self.prepared_result = {
            'status': 'READY', 'source_head': self.ready['sourceHead'],
            'source_mode': 'working_tree_snapshot', 'migration_count': 121,
            'canonical_count': 121, 'pending_count': 0, 'base_migration_count': 41,
            'policy_migration_count': 80, 'sql_execution': 'NOT_RUN',
            'edge_execution': 'NOT_RUN', 'output_root': str(self.artifact),
        }
        self.manifest = {**self.prepared_result, 'count': 121,
                         'migrations': copy.deepcopy(self.ready['currentMigrationInventory']['migrations'])}
        self.artifact_receipt = self.root / 'preparation' / 'receipt.json'
        self.flush_artifact()

    def flush_artifact(self):
        self.write(self.artifact / 'migration-manifest.json', self.manifest)
        self.write(self.artifact / 'current-policy-manifest.json', self.prepared_result)
        raw = self.write(self.artifact_receipt,
                         {'artifactRoot': str(self.artifact), 'result': self.prepared_result})
        mapping = self.ready['productionPreparationMapping']
        mapping['actualArtifactReceipt'] = str(self.artifact_receipt)
        mapping['artifactReceiptSha256'] = verification.digest(raw)

    def make_runtime(self):
        self.payloads = {}
        for run, group in self.runtime['runs'].items():
            group['privateRoot'] = str(self.root / run)
            for entry in group['evidence']:
                self.payloads[run, entry['file']] = copy.deepcopy(entry['summary'])
        run = 'd017a004'
        self.live = Path(self.runtime['runs'][run]['privateRoot'])
        name = next(name for r, name in self.payloads
                    if r == run and name.startswith('auth-provision-') and name.endswith('/receipt.json'))
        self.provision_name = name
        provision = self.payloads[run, name]
        self.scope = provision['scopeId']
        self.provision = self.live / name.split('/')[0]
        self.signed_name = 'signed-auth-' + self.scope
        binding = self.write(self.live / 'signed-ai-binding-private.json', b'synthetic-secret-original')
        reviewed = self.write(self.live / 'signed-ai-reviewed-binding-private.json', b'synthetic-secret-reviewed')
        before = self.write(self.provision / 'baseline-private.json',
                            {'authoritySha256': 'a' * 64, 'rows': {'private.canary': {'b' * 64: 2}}})
        after = self.write(self.provision / 'final-private.json',
                           {'authoritySha256': 'a' * 64, 'rows': {'private.canary': {'b' * 64: 2}}})
        provision.update(bindingSha256=verification.digest(binding),
                         creationReceiptRoot=str(self.provision),
                         signedEvidenceRoot=str(self.live / self.signed_name),
                         baselineSha256=verification.digest(before), finalSha256=verification.digest(after))
        review = self.payloads[run, 'signed-ai-root-review.json']
        review.update(originalBindingSha256=verification.digest(binding),
                      reviewedBindingSha256=verification.digest(reviewed))
        self.flush_runtime()

    def flush_runtime(self):
        for run, group in self.runtime['runs'].items():
            for entry in group['evidence']:
                value = self.payloads[run, entry['file']]
                raw = self.write(Path(group['privateRoot']) / entry['file'], value)
                entry.update(sha256=verification.digest(raw), bytes=len(raw), summary=copy.deepcopy(value))

    def flush(self):
        self.ready_sha = verification.digest(self.write(self.ready_path, self.ready))
        self.runtime_sha = verification.digest(self.write(self.runtime_path, self.runtime))

    def verify(self):
        return verification.verify(self.repo, self.ready_path,
                                   expected_readiness_sha256=self.ready_sha,
                                   runtime_evidence_path=self.runtime_path,
                                   expected_runtime_sha256=self.runtime_sha)

    def rejected(self, code=None):
        with self.assertRaises(verification.VerificationError) as error:
            self.verify()
        if code:
            self.assertEqual(str(error.exception), code)

    def repin_source(self, name, transform):
        path = self.repo / name
        raw = self.write(path, transform(path.read_bytes()))
        next(entry for entry in self.ready['sourceInputs'] if entry['path'] == name)['sha256'] = verification.digest(raw)
        self.flush()

    def test_current121_reviewed_artifact_and_source16_exact(self):
        result = self.verify()
        self.assertEqual(result['status'], 'PREPARATION_VERIFIED_WITH_HOLDS')
        self.assertEqual(result['sourceInputCount'], 16)
        self.assertEqual(result['current121']['artifactSqlExact'], 121)
        self.assertEqual(result['runtime']['receiptCount'], 42)
        self.assertTrue(result['runtime']['bindingChainVerified'])
        self.assertEqual(result['runtime']['unknownReservationsRetained'], 2)
        self.assertEqual(result['historical']['presentBytesVerified'], 1)

    def test_119_receipt_cannot_claim_current121_full_restore(self):
        result = self.verify()
        self.assertEqual(result['fullRestore'], 'NOT_RUN')
        self.assertFalse(result['roleSequenceActualRestoreVerified'])
        self.assertEqual(result['historical']['current121ActualRestore'], 'NOT_RUN')
        self.ready['rootIntegration']['actualFullRestore'] = 'PASS'
        self.flush(); self.rejected('READINESS_SCOPE')

    def test_sql_tamper_missing_extra_duplicate_and_wrong_version_rejected(self):
        name = self.ready['currentMigrationInventory']['migrations'][0]['path']
        path = self.repo / name
        original = path.read_bytes()
        for mode in ('tamper', 'missing', 'extra', 'duplicate', 'version', 'artifact'):
            with self.subTest(mode=mode):
                if mode == 'tamper': self.write(path, original + b'\n-- drift')
                elif mode == 'missing': path.unlink()
                elif mode == 'extra': self.write(path.parent / '20261018010000_unreviewed.sql', b'select 1;')
                elif mode == 'duplicate': self.ready['currentMigrationInventory']['migrations'][1] = copy.deepcopy(self.ready['currentMigrationInventory']['migrations'][0])
                elif mode == 'version': self.ready['currentMigrationInventory']['migrations'][0]['version'] = '20261018000000'
                else: self.write(self.artifact / 'supabase/migrations' / path.name, b'select 0;')
                self.flush(); self.rejected()
                self.write(path, original)
                (path.parent / '20261018010000_unreviewed.sql').unlink(missing_ok=True)
                self.ready['currentMigrationInventory']['migrations'] = copy.deepcopy(self.manifest['migrations'])
                self.write(self.artifact / 'supabase/migrations' / path.name, original)
        self.flush(); self.verify()

    def test_working_supplement_is_exact_and_never_claimed_committed(self):
        entry = next(x for x in self.ready['sourceInputs'] if x['path'].endswith('/prepare_current_policy.py'))
        entry['origin'] = 'COMMITTED_AT_SOURCE_HEAD'
        self.flush(); self.rejected('SOURCE_ORIGIN_INVALID')

    def test_missing_historical_input_is_hold_and_never_current_pass(self):
        self.historical_path.unlink()
        result = self.verify()
        self.assertEqual(result['historical']['status'], 'HISTORICAL_PINNED_NOT_REVALIDATED')
        self.assertGreater(result['historical']['missingOriginalInputs'], 0)
        self.assertFalse(result['historical']['pastPassRevoked'])
        self.assertFalse(result['historical']['roleSequenceActualRestoreVerified'])

    def test_historical_raw_role_row_sequence_mutation_is_failure_not_hold(self):
        original = json.loads(self.historical_path.read_bytes())
        for field, replacement in [('roles', ['stronger_owner']), ('rows', {'a' * 64: 1}),
                                   ('sequences', [['s', 10, False]])]:
            with self.subTest(field=field):
                value = {**original, field: replacement}
                self.write(self.historical_path, value)
                self.rejected('INPUT_SHA_MISMATCH')
        self.write(self.historical_path, original); self.verify()

    def test_reviewed_role_permission_contract_cannot_change_even_with_document_repin(self):
        self.repin_source('tests/integration/minkyu/product_connection_restore108_local.py',
                          lambda raw: raw.replace(b'NATIVE_RESTORE_FULL_STATE_MISMATCH', b'IGNORED_PERMISSION_DRIFT'))
        self.rejected('EXISTING_RESTORE_CONTRACT_CHANGED')

    def test_sequence_contract_removal_is_rejected(self):
        self.repin_source('tests/integration/minkyu/product_connection_restore108_local.py',
                          lambda raw: raw.replace(b"for key in('rawAuthority','effectivePrivileges','sequences')",
                                                  b"for key in('rawAuthority','effectivePrivileges')"))
        self.rejected('EXISTING_RESTORE_CONTRACT_CHANGED')

    def test_unknown2_and_original_row_bag_duplicate_count_cannot_change(self):
        path = self.provision / 'baseline-private.json'
        self.write(path, {'authoritySha256': 'a' * 64, 'rows': {'private.canary': {'b' * 64: 1}}})
        self.rejected('INPUT_SHA_MISMATCH')
        self.write(path, {'authoritySha256': 'a' * 64, 'rows': {'private.canary': {'b' * 64: 2}}})
        self.payloads['d017a004', 'before-stop-synthetic-state.json']['unknownReservations'] = 0
        self.flush_runtime(); self.flush(); self.rejected('UNKNOWN2_NOT_PRESERVED')

    def test_known_delete_reapply_contract_cannot_drop_absence_witness(self):
        self.repin_source('tests/integration/minkyu/product_connection_restore108_local.py',
                          lambda raw: raw.replace(b'NATIVE_BACKUP_REAPPLY_NOT_ABSENT', b'SKIPPED_ABSENCE_CHECK'))
        self.rejected('EXISTING_RESTORE_CONTRACT_CHANGED')

    def test_direct_synthetic_delete_is_not_product_ack_proof(self):
        result = self.verify()
        self.assertEqual(result['historical']['productAckDeleteDispatch'], 'NOT_RUN')
        self.assertIn('NOT_CURRENT121', result['historical']['confirmedDeletionReapplication'])
        bindings = result['historical']['preparationContractBindings']
        self.assertIn('run_native_final_backup', bindings['confirmed_deletion_reapplication']['functionAstSha256'])

    def test_storage_partition_scope_and_original_metadata_link_cannot_mix(self):
        original = copy.deepcopy(self.ready['storageScopes'])
        for field, value in [('missingOriginalBytesObjects', 0), ('metadataObjects', 2),
                             ('lastMappingReceiptSha256', '0' * 64), ('missingListSha256', '0' * 64)]:
            with self.subTest(field=field):
                self.ready['storageScopes'] = copy.deepcopy(original)
                self.ready['storageScopes']['originalSql108'][field] = value
                self.flush(); self.rejected('STORAGE_SCOPE_MIXED')
        self.ready['storageScopes'] = original
        self.ready['storageScopes']['syntheticNative119']['storageMetadataRowsInHistoricalSource'] = 45
        self.flush(); self.rejected('STORAGE_SCOPE_MIXED')

    def test_missing_baseline_or_binding_cannot_be_satisfied_by_summary_only(self):
        path = self.provision / 'baseline-private.json'
        original = path.read_bytes(); path.unlink(); self.rejected('INPUT_UNAVAILABLE_OR_UNSAFE')
        self.write(path, original)
        (self.live / 'signed-ai-reviewed-binding-private.json').unlink()
        self.rejected('INPUT_UNAVAILABLE_OR_UNSAFE')

    def test_historical_operating_snapshot_cannot_claim_current_pending(self):
        self.ready['historicalOperatingInputs']['historyComparison']['comparisonAtCurrentSourceAgainstHistoricalInputOnly']['currentOperatingPendingCount'] = 101
        self.flush(); self.rejected('OPERATING_SNAPSHOT_SCOPE')

    def test_activation_stage6_unknown_fields_and_version_fail_closed(self):
        for mutation in ('activation', 'operating', 'stage6', 'version'):
            with self.subTest(mutation=mutation):
                ready = copy.deepcopy(self.ready)
                if mutation == 'activation': self.ready['activationAllowed'] = True
                elif mutation == 'operating': self.ready['operatingChanged'] = True
                elif mutation == 'stage6': self.ready['stage6Complete'] = True
                else: self.ready['version'] = 2
                self.flush(); self.rejected()
                self.ready = ready
        self.flush(); self.verify()

    def test_private_links_mode_ancestor_duplicate_json_and_size_rejected(self):
        path = self.live / 'signed-ai-binding-private.json'
        raw = path.read_bytes()
        for kind in ('symlink', 'hardlink', 'mode', 'ancestor'):
            with self.subTest(kind=kind):
                other = self.live / 'other-private'
                if kind in ('symlink', 'hardlink'):
                    self.write(other, raw); path.unlink()
                    if kind == 'symlink': path.symlink_to(other)
                    else: os.link(other, path)
                elif kind == 'mode': os.chmod(path, 0o644)
                else: os.chmod(self.live, 0o755)
                self.rejected()
                if path.is_symlink(): path.unlink()
                elif kind == 'hardlink': path.unlink()
                if other.exists(): other.unlink()
                self.write(path, raw); os.chmod(self.live, 0o700)
        with self.assertRaises(verification.VerificationError):
            verification.read_bytes(path, limit=1)
        for raw_json in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":1e999}'):
            with self.assertRaises(verification.VerificationError): verification.parse(raw_json)

    def test_private_owner_and_inflight_metadata_change_rejected(self):
        path = self.live / 'signed-ai-binding-private.json'
        original = os.fstat
        for problem in ('owner', 'changed'):
            calls = [0]
            def changed(descriptor):
                result = original(descriptor)
                if not verification.stat.S_ISREG(result.st_mode):
                    return result
                calls[0] += 1
                values = {key: getattr(result, key) for key in (
                    'st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns',
                    'st_uid', 'st_nlink', 'st_mode')}
                if problem == 'owner': values['st_uid'] += 1
                elif calls[0] == 2: values['st_mtime_ns'] += 1
                return types.SimpleNamespace(**values)
            with self.subTest(problem=problem), mock.patch.object(os, 'fstat', changed):
                with self.assertRaises(verification.VerificationError) as error:
                    verification.read_bytes(path)
                self.assertEqual(str(error.exception),
                                 'INVALID_INPUT_FILE' if problem == 'owner' else 'INPUT_CHANGED')

    def test_same_bytes_file_swap_rejected_even_when_open_fd_metadata_stays_stable(self):
        path = self.live / 'signed-ai-binding-private.json'
        raw = path.read_bytes()
        actual_read, actual_fstat = os.read, os.fstat
        first_file_stat, swapped = [None], [False]
        def stable_fd(descriptor):
            info = actual_fstat(descriptor)
            if verification.stat.S_ISREG(info.st_mode):
                if first_file_stat[0] is None: first_file_stat[0] = info
                return first_file_stat[0]
            return info
        def swap(descriptor, size):
            chunk = actual_read(descriptor, size)
            if chunk and not swapped[0]:
                swapped[0] = True
                path.rename(path.with_name('old-binding-private.json'))
                self.write(path, raw)
            return chunk
        with mock.patch.object(os, 'read', swap), mock.patch.object(os, 'fstat', stable_fd):
            with self.assertRaisesRegex(verification.VerificationError, 'INPUT_PATH_CHANGED'):
                verification.read_bytes(path)
        self.assertTrue(swapped[0])

    def test_private_and_repository_ancestor_swap_same_bytes_rejected(self):
        actual_read = os.read
        for private in (True, False):
            with self.subTest(private=private):
                base = (self.root if private else self.repo) / 'swappable'
                path = base / 'nested' / 'reader-input.json'
                raw = self.write(path, b'same reviewed bytes')
                swapped = [False]
                def swap(descriptor, size):
                    chunk = actual_read(descriptor, size)
                    if chunk and not swapped[0]:
                        swapped[0] = True
                        base.rename(base.with_name('renamed-old-ancestor'))
                        self.write(path, raw)
                    return chunk
                with mock.patch.object(os, 'read', swap):
                    with self.assertRaisesRegex(verification.VerificationError, 'INPUT_PATH_CHANGED'):
                        verification.read_bytes(path, repo=None if private else self.repo)
                self.assertTrue(swapped[0])

    def test_fifo_rejected_without_waiting_for_writer(self):
        path = self.live / 'fifo-private'
        os.mkfifo(path, mode=0o600)
        # 이전 blocking open 회귀도 테스트 전체를 멈추지 않도록 별도 프로세스의 기한을 둔다.
        script = ("import sys;from pathlib import Path;"
                  "sys.path.insert(0,sys.argv[1]);import verify_restoration_readiness as v\n"
                  "try:v.read_bytes(Path(sys.argv[2]))\n"
                  "except v.VerificationError as e:sys.exit(0 if str(e)=='INVALID_INPUT_FILE' else 4)\n"
                  "sys.exit(3)\n")
        result = subprocess.run([sys.executable, '-B', '-c', script,
                                 str(REPOSITORY / 'tools/local'), str(path)],
                                capture_output=True, timeout=2)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_only_named_nonsecret_preparation_summary_accepts_trusted_temp_boundary(self):
        flat = self.root / 'yumidang-wbs-current121-preparation-result.json'
        raw = self.write(flat, self.artifact_receipt.read_bytes())
        mapping = self.ready['productionPreparationMapping']
        mapping.update(actualArtifactReceipt=str(flat), artifactReceiptSha256=verification.digest(raw))
        self.flush()
        with mock.patch.object(verification.tempfile, 'gettempdir', return_value=str(self.root)):
            with self.assertRaisesRegex(verification.VerificationError, 'PRIVATE_DIRECTORY_REQUIRED'):
                verification.read_bytes(flat)
            self.verify()
            self.write(self.root / 'other-private.json', b'not a preparation receipt')
            with self.assertRaisesRegex(verification.VerificationError, 'PREPARATION_BOUNDARY_FILENAME'):
                verification.read_bytes(self.root / 'other-private.json', boundary_metadata=True)
            value = json.loads(raw)
            value['result']['credentials'] = 'synthetic-secret'
            changed = self.write(flat, value)
            mapping['artifactReceiptSha256'] = verification.digest(changed)
            self.flush(); self.rejected('PREPARATION_RESULT_SCHEMA')

    def test_missing_history_through_symlink_is_not_downgraded_to_absent(self):
        self.historical_path.unlink()
        parent = self.historical_path.parent
        parent.rmdir()
        parent.symlink_to(self.root / 'never-created', target_is_directory=True)
        self.rejected('INPUT_ANCESTOR_LINK')

    def test_stdout_only_summary_no_secret_paths_or_raw_rows(self):
        out = io.StringIO()
        with mock.patch('sys.stdout', out):
            status = verification.main(['--repo', str(self.repo), '--readiness', str(self.ready_path),
                                        '--expected-readiness-sha256', self.ready_sha,
                                        '--runtime-evidence', str(self.runtime_path),
                                        '--expected-runtime-sha256', self.runtime_sha])
        self.assertEqual(status, 0)
        text = out.getvalue()
        self.assertNotIn(str(self.root), text)
        self.assertNotIn('synthetic-secret', text)
        self.assertNotIn('private.canary', text)
        self.assertFalse(json.loads(text)['activationAllowed'])
        storage = json.loads(text)['historical']['storage']
        self.assertEqual(storage['matchedOriginalFiles'], 6)
        self.assertEqual(storage['missingOriginalObjects'], 39)
        self.assertFalse(storage['currentOriginalFileBytesRevalidated'])
        self.assertIn('HISTORICAL', storage['countScope'])
        self.assertEqual(json.loads(text)['historical']['preparationContractBindings']
                         ['roles_and_privileges']['preparationCheck'],
                         'SOURCE_CONTRACT_VERIFIED_INPUTS_CLASSIFIED')

    def test_no_process_socket_or_execution_capability_used(self):
        with mock.patch.object(subprocess, 'run', side_effect=AssertionError('process forbidden')), \
             mock.patch.object(subprocess, 'Popen', side_effect=AssertionError('process forbidden')), \
             mock.patch.object(socket, 'socket', side_effect=AssertionError('network forbidden')), \
             mock.patch.object(os, 'system', side_effect=AssertionError('shell forbidden')):
            self.verify()

    def test_expected_sha_change_source_order_and_runtime_link_omission_rejected(self):
        self.ready_sha = '0' * 64; self.rejected('INPUT_SHA_MISMATCH')
        self.flush()
        entries = self.ready['currentMigrationInventory']['migrations']
        entries[0], entries[1] = entries[1], entries[0]
        self.flush(); self.rejected('MIGRATION_ORDER')
        entries[0], entries[1] = entries[1], entries[0]
        self.flush()
        self.runtime['runs']['d017a004']['evidence'].pop()
        self.flush(); self.rejected('RUNTIME_RECEIPT_INVENTORY')


if __name__ == '__main__':
    unittest.main()
