"""실제 Docker/DB 없이 전용 실행 대상과 커밋 이후 로컬 준비 경계를 검증한다."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools/local'))
import run_database_tests as runner
import prepare_database as preparation

# 이전 단계의 추가 SQL이 모두 HEAD에 들어간 상황을 재현한다.
# 도구의 선택 목록을 가져오지 않아야 다시 고정 목록을 도입하는 회귀를 잡는다.
FORMER_PENDING = (
    '20260923090000_worker_jobs.sql',
    '20260923091000_public_post_search.sql',
    '20260923092000_review_summary_storage.sql',
    '20260923100000_bilateral_completion.sql',
    '20260923101000_review_automation.sql',
    '20260923102000_core_service_api.sql',
)


class RuntimeBoundaryTests(unittest.TestCase):
    def test_only_dedicated_local_running_container_is_allowed(self):
        endpoint = 'unix://' + str(Path.home() / '.colima/yumidang-minkyu/docker.sock')
        container = {'Config': {'Labels': {'com.supabase.cli.project': runner.PROJECT}}, 'State': {'Running': True}}
        runner.validate_target(endpoint, container)
        for other in ['tcp://remote:2376', 'unix:///var/run/docker.sock', 'ssh://remote']:
            with self.assertRaises(ValueError):
                runner.validate_target(other, container)
        for change in ['wrong_project', 'stopped']:
            altered = copy.deepcopy(container)
            if change == 'wrong_project':
                altered['Config']['Labels']['com.supabase.cli.project'] = 'another-project'
            else:
                altered['State']['Running'] = False
            with self.assertRaises(ValueError):
                runner.validate_target(endpoint, altered)


class CommittedDatabasePreparationTests(unittest.TestCase):
    def setUp(self):
        # 프로젝트 Git 설정·hook·인덱스에 닿지 않는 임시 저장소만 사용한다.
        isolated = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        isolated.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull})
        environment = patch.dict(os.environ, isolated, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.repo = self.base / 'repo'
        self.migrations = self.repo / 'backend/supabase/migrations'
        self.migrations.mkdir(parents=True)
        self.config = self.repo / 'backend/supabase/config.toml'
        self.config_bytes = b'project_id = "fixture"\n[db]\nport = 55422\n'
        self.config.write_bytes(self.config_bytes)
        self.names = tuple(f'20260101{i:06d}_baseline_{i}.sql' for i in range(20)) + FORMER_PENDING
        for index, name in enumerate(self.names):
            (self.migrations / name).write_text(f'select {index + 1};\n', encoding='utf-8')
        self.git('init', '-q')
        self.commit_all()
        self.output = self.base / 'output'

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args],
                              capture_output=True, check=True, timeout=10)

    def commit_all(self):
        self.git('add', '.')
        self.git('-c', 'user.name=Local fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-qm', 'fixture')

    def source_snapshot(self):
        return {path.name: path.read_bytes() for path in self.migrations.iterdir()}

    def assert_blocked_before_copy(self):
        with self.assertRaises(preparation.PreparationError):
            preparation.prepare_database(self.repo, self.output)
        self.assertFalse(self.output.exists())

    def test_committed_26_migrations_are_copied_once_with_matching_manifests(self):
        before = self.source_snapshot()
        report = preparation.prepare_database(self.repo, self.output)
        copied = self.output / 'supabase/migrations'
        self.assertEqual({path.name for path in copied.iterdir()}, set(self.names))
        self.assertEqual(len(report['migrations']), 26)
        self.assertEqual(report['count'], 26)
        self.assertEqual(report['total_count'], 26)
        self.assertEqual(report['pending'], [])
        self.assertEqual(report['sql_execution'], 'NOT_RUN')
        self.assertEqual(len({entry['version'] for entry in report['migrations']}), 26)
        for entry in report['migrations']:
            name = Path(entry['path']).name
            self.assertEqual((copied / name).read_bytes(), before[name])
            self.assertEqual(entry['sha256'], hashlib.sha256(before[name]).hexdigest())
        self.assertEqual((self.output / 'supabase/config.toml').read_bytes(), self.config_bytes)
        self.assertEqual(report['config_sha256'], hashlib.sha256(self.config_bytes).hexdigest())
        database_manifest = json.loads((self.output / 'database-manifest.json').read_text())
        migration_manifest = json.loads((self.output / 'migration-manifest.json').read_text())
        self.assertEqual(database_manifest, report)
        self.assertEqual(migration_manifest['migrations'], report['migrations'])
        self.assertEqual(migration_manifest['sql_execution'], 'NOT_RUN')
        self.assertEqual(self.source_snapshot(), before)
        self.assertEqual(self.config.read_bytes(), self.config_bytes)
        self.assertEqual(self.git('status', '--porcelain').stdout, b'')

    def test_tracked_and_untracked_copies_and_untracked_sql_are_preserved_but_excluded(self):
        tracked_copy = self.migrations / '20260101000000_baseline_0 2.sql'
        tracked_copy.write_bytes((self.migrations / self.names[0]).read_bytes())
        self.commit_all()
        tracked_copy.write_text('changed copy must stay untouched', encoding='utf-8')
        untracked_copy = self.migrations / '20260101000001_baseline_1 2.sql'
        untracked_copy.write_text('untracked copy must stay untouched', encoding='utf-8')
        untracked_sql = self.migrations / '20990101000000_unreviewed.sql'
        untracked_sql.write_text('select 999;\n', encoding='utf-8')
        before = self.source_snapshot()
        status_before = self.git('status', '--porcelain', '--untracked-files=all').stdout
        report = preparation.prepare_database(self.repo, self.output)
        self.assertEqual({path.name for path in (self.output / 'supabase/migrations').iterdir()}, set(self.names))
        self.assertEqual(set(report['excluded']), {
            str(path.relative_to(self.repo)) for path in (tracked_copy, untracked_copy, untracked_sql)
        })
        self.assertEqual(report['total_count'], 26)
        self.assertEqual(self.source_snapshot(), before)
        self.assertEqual(self.git('status', '--porcelain', '--untracked-files=all').stdout, status_before)

    def test_newly_committed_migration_is_included_without_a_fixed_pending_list(self):
        next_migration = self.migrations / '20260928090000_followup.sql'
        next_migration.write_text('select 27;\n', encoding='utf-8')
        self.commit_all()
        report = preparation.prepare_database(self.repo, self.output)
        self.assertEqual(report['total_count'], 27)
        self.assertEqual(report['pending'], [])
        self.assertEqual((self.output / 'supabase/migrations' / next_migration.name).read_bytes(), next_migration.read_bytes())

    def test_staged_new_sql_is_rejected_without_changing_the_source(self):
        new_file = self.migrations / '20260928090000_not_committed.sql'
        new_file.write_text('select 27;\n', encoding='utf-8')
        self.git('add', str(new_file.relative_to(self.repo)))
        before = self.source_snapshot()
        self.assert_blocked_before_copy()
        self.assertEqual(self.source_snapshot(), before)

    def test_unstaged_and_staged_sql_modifications_are_rejected(self):
        changed = self.migrations / FORMER_PENDING[0]
        changed.write_text('select 777;\n', encoding='utf-8')
        before = self.source_snapshot()
        for staged in (False, True):
            with self.subTest(staged=staged):
                if staged:
                    self.git('add', str(changed.relative_to(self.repo)))
                self.assert_blocked_before_copy()
                self.assertEqual(self.source_snapshot(), before)

    def test_missing_or_directory_config_is_rejected_before_copy(self):
        self.config.unlink()
        self.assert_blocked_before_copy()
        self.config.mkdir()
        self.assert_blocked_before_copy()
        self.assertTrue(self.config.is_dir())

    def test_symlink_config_is_rejected_without_touching_its_target(self):
        external = self.base / 'external-config.toml'
        external.write_bytes(self.config_bytes)
        self.config.unlink()
        self.config.symlink_to(external)
        self.assert_blocked_before_copy()
        self.assertTrue(self.config.is_symlink())
        self.assertEqual(external.read_bytes(), self.config_bytes)

    def test_empty_or_invalid_toml_config_is_rejected_before_copy(self):
        for data in (b'', b'  \n', b'# comments only\n', b'project_id = [', b'\xff'):
            with self.subTest(data=data):
                self.config.write_bytes(data)
                self.assert_blocked_before_copy()
                self.assertEqual(self.config.read_bytes(), data)

    def test_nonempty_output_and_prepared_output_are_not_overwritten(self):
        self.output.mkdir()
        marker = self.output / 'keep.txt'
        marker.write_text('existing data', encoding='utf-8')
        with self.assertRaises(preparation.PreparationError):
            preparation.prepare_database(self.repo, self.output)
        self.assertEqual(list(self.output.iterdir()), [marker])
        self.assertEqual(marker.read_text(), 'existing data')
        prepared = self.base / 'prepared'
        preparation.prepare_database(self.repo, prepared)
        before = {str(path.relative_to(prepared)): path.read_bytes()
                  for path in prepared.rglob('*') if path.is_file()}
        with self.assertRaises(preparation.PreparationError):
            preparation.prepare_database(self.repo, prepared)
        self.assertEqual({str(path.relative_to(prepared)): path.read_bytes()
                          for path in prepared.rglob('*') if path.is_file()}, before)


if __name__ == '__main__':
    unittest.main()
