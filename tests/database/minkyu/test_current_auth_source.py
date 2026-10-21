"""현행 Auth source 준비만 검사. Docker·Auth·SQL 실행 없음."""
import importlib.util
from contextlib import nullcontext
import sys
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[3] / 'tools/local/prepare_current_auth_source.py'


class PreparationTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('current_auth_prepare', SOURCE)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        self.tmp = tempfile.TemporaryDirectory(dir='/private/tmp')
        self.addCleanup(self.tmp.cleanup)
        self.parent = Path(self.tmp.name).resolve()
        self.parent.chmod(0o700)
        self.repo = self.parent / 'repo'
        self.repo.mkdir(mode=0o700)
        self.output = self.parent / 'fresh'
        self.head = 'a' * 40
        self.sqlpath = Path('backend/supabase/migrations/20261020100000_fixture.sql')
        self.codepath = Path('backend/supabase/functions/service-api/index.ts')
        self.payloads = {name: b'helper' for name in (self.m.SELF, *self.m.HELPER_PATHS)}
        self.payloads.update({self.m.CONFIG: b'[auth]\nenabled = true\n', str(self.sqlpath): b'begin;commit;', str(self.codepath): b'export {};'} )
        self.pins = {name: self.m.sha(raw) for name, raw in self.payloads.items()}
        self.history = {'entries': [{'path': str(self.sqlpath), 'sha256': self.pins[str(self.sqlpath)]}]}
        self.policy = SimpleNamespace(inspect_reviewed_current_migrations=Mock(return_value=(self.history, {self.sqlpath: self.payloads[str(self.sqlpath)]})),
            edge=SimpleNamespace(source_snapshot=Mock(return_value={self.codepath: self.payloads[str(self.codepath)]})))
        self.database = SimpleNamespace(isolated_config=Mock(side_effect=lambda raw, project, port: (raw, {'project_id': project, 'api.port': port})))

    def run_prepare(self, **changes):
        args = dict(head=self.head, manifest_sha256='b' * 64, pins=self.pins,
            project='jonghyun-backend100-1234abcd', port=57001, subnet='10.253.101.0/24')
        args.update(changes)
        with patch.object(self.m, 'verify_review', return_value=self.payloads), patch.object(self.m, 'load_support', side_effect=lambda *args: nullcontext((self.policy, self.database))):
            return self.m.prepare(self.repo, self.output, **args)

    def test_default_cli_never_prepares_or_starts(self):
        result = subprocess.run(['python3', str(SOURCE)], capture_output=True, check=True, text=True)
        self.assertEqual(json.loads(result.stdout)['status'], 'NOT_RUN')
        self.assertEqual(list(self.parent.iterdir()), [self.repo])

    def test_source_artifact_pins_manifest_and_four_roles_without_execution(self):
        result = self.run_prepare()
        self.assertEqual(result['status'], 'READY_PREPARATION_ONLY')
        target = result['target']
        self.assertEqual(len(target['newContainerNames']), 4)
        self.assertIsNone(target['newIds'])
        self.assertEqual(target['host'], self.m.HOST)
        self.assertEqual(target['daemonId'], self.m.DAEMON)
        self.assertEqual((target['startMinimumAvailableKiB'], target['maintainMinimumAvailableKiB']), (1048576, 786432))
        self.assertEqual(target['jwtExpirySeconds'], 3600)
        self.assertEqual(target['executionAdapter'], 'NOT_IMPLEMENTED')
        self.assertEqual(result['execution'], 'NOT_RUN')
        self.assertEqual(result['providerCalls'], 0)
        self.assertEqual((self.output / 'supabase/migrations' / self.sqlpath.name).read_bytes(), self.payloads[str(self.sqlpath)])
        self.assertEqual((self.output / 'supabase/functions/service-api/index.ts').read_bytes(), self.payloads[str(self.codepath)])
        self.assertEqual(json.loads((self.output / 'current-auth-source-manifest.json').read_bytes()), result)
        self.assertIn(b'jwt_expiry = 3600', (self.output / 'supabase/config.toml').read_bytes())
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in self.output.rglob('*') if p.is_file()))

    def test_execution_adapter_loader_rechecks_bytes_and_current_source(self):
        result = self.run_prepare()
        digest = self.m.sha((self.output / 'current-auth-source-manifest.json').read_bytes())
        def load():
            with patch.object(self.m, 'verify_review', return_value=self.payloads), patch.object(self.m, 'load_support', side_effect=lambda *args: nullcontext((self.policy, self.database))):
                return self.m.load_prepared_source(self.repo, self.output, manifest_sha256=digest, head=self.head, pins=self.pins)
        self.assertEqual(load(), result)
        target = self.output / 'supabase/functions/service-api/index.ts'
        target.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'PREPARED_BYTES_CHANGED'):
            load()
        target.write_bytes(self.payloads[str(self.codepath)])
        (self.output / 'foreign').write_bytes(b'not reviewed')
        (self.output / 'foreign').chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'PREPARED_FILE_SET'):
            load()

    def test_loader_rejects_symlink_directory_and_public_artifacts(self):
        self.run_prepare()
        digest = self.m.sha((self.output / 'current-auth-source-manifest.json').read_bytes())
        def load():
            with patch.object(self.m, 'verify_review', return_value=self.payloads), patch.object(self.m, 'load_support', side_effect=lambda *args: nullcontext((self.policy, self.database))):
                return self.m.load_prepared_source(self.repo, self.output, manifest_sha256=digest, head=self.head, pins=self.pins)
        link = self.output / 'foreign-dir'
        link.symlink_to(self.repo, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'PREPARED_PRIVATE'):
            load()
        link.unlink()
        (self.output / 'supabase/config.toml').chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'PREPARED_PRIVATE'):
            load()

    def test_real_helpers_keep_late_import_bound_until_consumer_finishes(self):
        # 실제 tracked helper bytes와 작은 실제 Git fixture를 사용한다.
        root = SOURCE.parents[2]
        payloads = {relative: (root / relative).read_bytes() for relative in self.m.HELPER_PATHS}
        sql = self.repo / self.sqlpath
        sql.parent.mkdir(parents=True)
        sql.write_bytes(b'begin;commit;')
        for args in [('init', '-q'), ('add', '.'), ('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
                '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')]:
            subprocess.run(['git', '-C', str(self.repo), *args], check=True, capture_output=True)
        head = subprocess.check_output(['git', '-C', str(self.repo), 'rev-parse', 'HEAD']).decode().strip()
        poison = SimpleNamespace(inspect_migrations=Mock(side_effect=RuntimeError('UNREVIEWED_MODULE_EXECUTED')))
        saved = sys.modules.get('prepare_migrations')
        sys.modules['prepare_migrations'] = poison
        try:
            with self.m.load_support(self.repo, payloads) as (policy, database):
                self.assertIsNot(sys.modules['prepare_migrations'], poison)
                # 늦은 import와 실제 migration 검사까지 실행하고 고정122목록과 달라 정확 거절한다.
                with self.assertRaisesRegex(ValueError, 'EXACT_REVIEWED_CURRENT_PROFILE_REQUIRED'):
                    policy.inspect_reviewed_current_migrations(self.repo, head, 'b' * 64)
                poison.inspect_migrations.assert_not_called()
            self.assertIs(sys.modules['prepare_migrations'], poison)
        finally:
            if saved is None:
                sys.modules.pop('prepare_migrations', None)
            else:
                sys.modules['prepare_migrations'] = saved

    def test_loader_rejects_disk_snapshot_outside_pinned_payloads(self):
        self.run_prepare()
        digest = self.m.sha((self.output / 'current-auth-source-manifest.json').read_bytes())
        self.policy.edge.source_snapshot.return_value = {self.codepath: b'changed after source review'}
        with patch.object(self.m, 'verify_review', return_value=self.payloads), patch.object(self.m, 'load_support', side_effect=lambda *args: nullcontext((self.policy, self.database))):
            with self.assertRaisesRegex(ValueError, 'SOURCE_PAYLOAD_CHANGED'):
                self.m.load_prepared_source(self.repo, self.output, manifest_sha256=digest, head=self.head, pins=self.pins)

    def test_loader_rechecks_source_immediately_before_return(self):
        self.run_prepare()
        digest = self.m.sha((self.output / 'current-auth-source-manifest.json').read_bytes())
        # 최초 검사/중간 검사까지 같아도 반환 직전 변경을 거절한다.
        with patch.object(self.m, 'verify_review', side_effect=[self.payloads, self.payloads, {}]), patch.object(self.m, 'load_support', side_effect=lambda *args: nullcontext((self.policy, self.database))):
            with self.assertRaisesRegex(ValueError, 'SOURCE_CHANGED_DURING_LOAD'):
                self.m.load_prepared_source(self.repo, self.output, manifest_sha256=digest, head=self.head, pins=self.pins)

    def test_unregistered_current_migration_is_not_automatically_promoted(self):
        self.policy.inspect_reviewed_current_migrations.side_effect = ValueError('EXACT_REVIEWED_CURRENT_PROFILE_REQUIRED')
        with self.assertRaisesRegex(ValueError, 'EXACT_REVIEWED_CURRENT'):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_extra_source_is_rejected_before_output(self):
        with self.assertRaisesRegex(ValueError, 'EXACT_SOURCE_SET'):
            self.run_prepare(pins={**self.pins, 'unreviewed.ts': 'f' * 64})
        self.assertFalse(self.output.exists())

    def test_source_payload_drift_is_rejected(self):
        self.policy.edge.source_snapshot.return_value = {self.codepath: b'changed'}
        with self.assertRaisesRegex(ValueError, 'SOURCE_PAYLOAD_CHANGED'):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_source_change_during_prepare_records_failed_receipt(self):
        args = dict(head=self.head, manifest_sha256='b' * 64, pins=self.pins,
            project='jonghyun-backend100-1234abcd', port=57001, subnet='10.253.101.0/24')
        with patch.object(self.m, 'verify_review', side_effect=[self.payloads, {}]), patch.object(self.m, 'load_support', side_effect=lambda *args: nullcontext((self.policy, self.database))):
            with self.assertRaisesRegex(ValueError, 'SOURCE_CHANGED_DURING'):
                self.m.prepare(self.repo, self.output, **args)
        receipt = json.loads((self.output / 'current-auth-source-manifest.json').read_bytes())
        self.assertEqual(receipt['status'], 'FAIL_CLOSED')
        self.assertEqual(receipt['execution'], 'NOT_RUN')

    def test_existing_output_is_preserved(self):
        self.output.mkdir(mode=0o700)
        keep = self.output / 'keep'
        keep.write_bytes(b'existing')
        with self.assertRaisesRegex(ValueError, 'FRESH_OUTPUT'):
            self.run_prepare()
        self.assertEqual(keep.read_bytes(), b'existing')
        self.assertEqual(list(self.output.iterdir()), [keep])

    def test_unsafe_parent_is_rejected(self):
        self.parent.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'PRIVATE_PARENT'):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_symlink_output_is_rejected(self):
        self.output.symlink_to(self.repo, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'FRESH_OUTPUT'):
            self.run_prepare()

    def test_invalid_target_project_port_subnet(self):
        for change in [{'project': 'existing'}, {'port': True}, {'subnet': '192.168.0.0/24'}, {'subnet': '10.253.1.0/25'}]:
            with self.assertRaises(ValueError):
                self.run_prepare(**change)
        self.assertFalse(self.output.exists())

    def test_auth_expiry_cannot_be_shortened(self):
        self.database.isolated_config.side_effect = None
        self.database.isolated_config.return_value = (b'[auth]\njwt_expiry = 60\n', {})
        with self.assertRaisesRegex(ValueError, 'AUTH_LIFETIME_CHANGED'):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_explicit_3600_auth_expiry_is_preserved(self):
        raw = b'[auth]\njwt_expiry = 3600\n'
        self.database.isolated_config.side_effect = None
        self.database.isolated_config.return_value = (raw, {})
        rendered, _ = self.m.runtime_config(raw, 'project', 57001, self.database)
        self.assertEqual(rendered, raw)

    def test_source_reader_rejects_symlink_and_hardlink(self):
        path = self.repo / 'file'
        path.write_bytes(b'reviewed')
        link = self.repo / 'link'
        link.symlink_to(path)
        with self.assertRaisesRegex(ValueError, 'SOURCE_PATH'):
            self.m.regular_bytes(self.repo, 'link')
        link.unlink()
        os.link(path, link)
        with self.assertRaisesRegex(ValueError, 'SOURCE_REGULAR'):
            self.m.regular_bytes(self.repo, 'file')

    def test_verify_review_rejects_head_pin_actor_and_hook_drift(self):
        for name, raw in self.payloads.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        def call(repo, *args):
            if args == ('rev-parse', 'HEAD'):
                return self.head.encode()
            if args == ('config', 'yumidang.actor'):
                return b'minkyu'
            if args == ('config', 'core.hooksPath'):
                return b'.githooks'
            return self.payloads[args[1].split(':', 1)[1]]
        with patch.object(self.m, 'git', side_effect=call):
            self.assertEqual(self.m.verify_review(self.repo, self.head, self.pins), self.payloads)
            with self.assertRaisesRegex(ValueError, 'HEAD_CHANGED'):
                self.m.verify_review(self.repo, 'c' * 40, self.pins)
            with self.assertRaisesRegex(ValueError, 'SOURCE_NOT_COMMITTED'):
                self.m.verify_review(self.repo, self.head, {**self.pins, self.m.SELF: 'd' * 64})
        for config, code in [('yumidang.actor', 'ACTOR'), ('core.hooksPath', 'HOOK')]:
            def bad(repo, *args):
                return b'wrong' if args == ('config', config) else call(repo, *args)
            with patch.object(self.m, 'git', side_effect=bad), self.assertRaisesRegex(ValueError, code):
                self.m.verify_review(self.repo, self.head, self.pins)


if __name__ == '__main__':
    unittest.main()
