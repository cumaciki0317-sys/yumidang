"""126 named source API의 분리·고정 guard 회귀. 실제 Docker/Auth/SQL은 실행하지 않는다."""
from contextlib import nullcontext
import copy
import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent))
import test_current_auth_source as preparation_fixture
import test_current_auth_runner as runtime_fixture

PROFILE = 'matching_db_entry_126'
PREP_SCOPE = 'MATCHING126_AUTH_FOUR_ROLE_PREPARATION_ONLY'
RUN_SCOPE = 'REVIEWED_MATCHING126_AUTH_FOUR_NEW_SERVICES_ONLY'


class Matching126PreparationTests(unittest.TestCase):
    def setUp(self):
        self.base = preparation_fixture.PreparationTests('test_source_artifact_pins_manifest_and_four_roles_without_execution')
        self.base.setUp(); self.addCleanup(self.base.doCleanups)
        self.m = self.base.m
        del self.base.payloads[str(self.base.sqlpath)]
        rows = []
        sql = {}
        for i in range(126):
            path = Path('backend/supabase/migrations/' + str(20261001000000 + i) + '_fixture.sql')
            raw = ('begin; select ' + str(i) + '; commit;').encode()
            sql[path] = raw
            self.base.payloads[str(path)] = raw
            rows.append({'path': str(path), 'version': str(20261001000000 + i),
                         'sha256': self.m.sha(raw), 'bytes': len(raw)})
        self.base.history = {'entries': rows}
        self.base.pins = {name: self.m.sha(raw) for name, raw in self.base.payloads.items()}
        self.base.policy.inspect_reviewed_matching126_migrations = Mock(return_value=(self.base.history, sql))
        self.base.policy.inspect_reviewed_current_migrations = Mock(side_effect=ValueError('LEGACY125_INSPECTOR_REFUSED'))
        self.args = dict(head=self.base.head, manifest_sha256='b' * 64, pins=self.base.pins,
            project='jonghyun-backend100-a1261023', port=58321, subnet='10.253.251.0/24')

    def support(self):
        return patch.object(self.m, 'load_support', side_effect=lambda *a: nullcontext((self.base.policy, self.base.database)))

    def prepare(self, **changes):
        with patch.object(self.m, 'verify_review', return_value=self.base.payloads), self.support():
            return self.m.prepare_matching126(self.base.repo, self.base.output, **{**self.args, **changes})

    def load(self, matching=True):
        path = self.base.output / 'current-auth-source-manifest.json'
        fn = self.m.load_prepared_matching126_source if matching else self.m.load_prepared_source
        with patch.object(self.m, 'verify_review', return_value=self.base.payloads), self.support():
            return fn(self.base.repo, self.base.output, manifest_sha256=self.m.sha(path.read_bytes()),
                head=self.base.head, pins=self.base.pins)

    def test_named126_writes_exact_private_profile_and_invokes_only126_inspector(self):
        report = self.prepare()
        self.assertEqual((report['scope'], report['migrationProfile']), (PREP_SCOPE, PROFILE))
        self.assertEqual((report['migrationCount'], report['execution']), (126, 'NOT_RUN'))
        self.assertEqual((report['target']['jwtExpirySeconds'], report['target']['expectedNewContainerCount']), (3600, 4))
        self.assertEqual((report['target']['startMinimumAvailableKiB'], report['target']['maintainMinimumAvailableKiB']), (1048576, 786432))
        self.assertEqual(report['migrations'], self.base.history['entries'])
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in self.base.output.rglob('*') if p.is_file()))
        self.base.policy.inspect_reviewed_current_migrations.assert_not_called()
        self.assertEqual(self.base.policy.inspect_reviewed_matching126_migrations.call_count, 2)

    def test_named126_loader_rechecks_exact_profile_and_source_twice(self):
        report = self.prepare()
        self.base.policy.inspect_reviewed_matching126_migrations.reset_mock()
        self.assertEqual(self.load(), report)
        self.assertEqual(self.base.policy.inspect_reviewed_matching126_migrations.call_count, 2)
        self.base.policy.inspect_reviewed_current_migrations.assert_not_called()

    def test_legacy125_loader_rejects126_before_source_loading(self):
        self.prepare()
        with self.assertRaisesRegex(ValueError, 'PREPARED_BINDING'):
            self.load(matching=False)
        self.base.policy.inspect_reviewed_current_migrations.assert_not_called()

    def test_named126_loader_rejects_legacy_scope_missing_or_different_profile(self):
        report = self.prepare()
        path = self.base.output / 'current-auth-source-manifest.json'
        cases = [dict(report, scope=self.m.SCOPE), dict(report, migrationProfile='current125'),
                 dict(report, migrationCount=125),
                 {key: value for key, value in report.items() if key != 'migrationProfile'}]
        for value in cases:
            with self.subTest(value=value.get('migrationProfile')):
                path.write_bytes(self.m.canonical(value))
                with self.assertRaisesRegex(ValueError, 'MATCHING126_PREPARED_BINDING'):
                    self.load()

    def test_named126_preparer_rejects_wrong_count_before_output(self):
        self.base.history['entries'] = self.base.history['entries'][:-1]
        with self.assertRaisesRegex(ValueError, 'MATCHING126_HISTORY_REQUIRED'):
            self.prepare()
        self.assertFalse(self.base.output.exists())

    def test_source_commit_and_head_checks_cannot_be_skipped(self):
        with patch.object(self.m, 'verify_review', side_effect=ValueError('SOURCE_NOT_COMMITTED')) as verify:
            with self.assertRaisesRegex(ValueError, 'SOURCE_NOT_COMMITTED'):
                self.m.prepare_matching126(self.base.repo, self.base.output, **self.args)
        verify.assert_called_once_with(self.base.repo, self.base.head, self.base.pins)
        self.assertFalse(self.base.output.exists())

    def test_named126_loader_rejects_modified_sql_and_unreviewed_artifact(self):
        self.prepare()
        path = self.base.output / str(Path(self.base.history['entries'][0]['path'])).removeprefix('backend/')
        raw = path.read_bytes(); path.write_bytes(raw + b'-- changed')
        with self.assertRaisesRegex(ValueError, 'PREPARED_BYTES_CHANGED'): self.load()
        path.write_bytes(raw)
        extra = self.base.output / 'unreviewed'; extra.write_bytes(b'foreign'); extra.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'PREPARED_FILE_SET'): self.load()

    def test_named126_loader_never_follows_a_changed_manifest_hash(self):
        self.prepare()
        with self.assertRaisesRegex(ValueError, 'PREPARED_MANIFEST_CHANGED'):
            self.m.load_prepared_matching126_source(self.base.repo, self.base.output,
                manifest_sha256='0' * 64, head=self.base.head, pins=self.base.pins)


class Matching126RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.base = runtime_fixture.RunnerTests('test_typed_review_fixes_scope_images_and_operations')
        self.base.setUp(); self.addCleanup(self.base.doCleanups)
        self.m = self.base.m
        self.base.prep.load_prepared_matching126_source = Mock(return_value={'scope': PREP_SCOPE,
            'migrationProfile': PROFILE, 'target': self.base.prep.load_prepared_source.return_value['target']})

    def review(self, **changes):
        return self.m.ReviewedMatching126AuthSource(**{**self.base.args, **changes})

    def runner(self):
        return self.m.Matching126AuthSource(self.review(), (self.base.prep, self.base.private, SimpleNamespace(), self.base.ai))

    def test_explicit126_review_is_distinct_sealed_type_and_fixed_profile(self):
        review = self.review(); value = review.descriptor()
        self.assertEqual((value['scope'], value['migrationProfile']), (RUN_SCOPE, PROFILE))
        self.assertIsNot(type(review), self.m.ReviewedCurrentAuthSource)
        original = self.base.review().descriptor()
        self.assertNotIn('migrationProfile', original)
        self.assertEqual(original['scope'], self.m.SCOPE)
        del value['migrationProfile']
        self.assertEqual(review.descriptor()['migrationProfile'], PROFILE)

    def test126_and125_reviews_cannot_cross_phase_or_runner_entries(self):
        pairs = [(self.m.run_phase, self.review()), (self.m.run_matching126_phase, self.base.review())]
        with patch.object(self.m, 'runtime_support') as support:
            for fn, value in pairs:
                with self.subTest(fn=fn.__name__), self.assertRaisesRegex(ValueError, 'TYPED_PHASE_REQUIRED'):
                    fn(value, 'start')
            support.assert_not_called()
        for cls, review in ((self.m.CurrentAuthSource, self.review()), (self.m.Matching126AuthSource, self.base.review())):
            with self.assertRaisesRegex(ValueError, 'TYPED_REVIEW_REQUIRED'):
                cls(review, (self.base.prep, self.base.private, SimpleNamespace(), self.base.ai))

    def test_named_runner_calls_only126_loader_with_original_head_and_pins(self):
        runner = self.runner()
        with patch.object(self.m, 'checked_sources') as checked:
            result = runner.source()
        checked.assert_called_once_with(runner.v)
        self.base.prep.load_prepared_matching126_source.assert_called_once_with(self.m.ROOT,
            self.base.prepared, manifest_sha256='b' * 64, head='c' * 40, pins=self.base.args['prepared_pins'])
        self.base.prep.load_prepared_source.assert_not_called()
        self.assertEqual(result['migrationProfile'], PROFILE)

    def test_named_review_preserves_all_existing_authority_constraints(self):
        for change in ({'head': 'bad'}, {'operations': ('provision',)}, {'execution_root': self.base.prepared},
                       {'images': {'db': 'sha256:' + '1' * 64}}):
            with self.subTest(change=change), self.assertRaises(ValueError): self.review(**change)

    def test_named_intent_has126_scope_and_no_replay(self):
        runner = self.runner(); runner.source = Mock(); runner.read = Mock(return_value=runner.v)
        written = {}
        def save(name, value):
            if name in written: raise FileExistsError(name)
            written[name] = value
        runner.save = save
        runner.intent('start')
        self.assertEqual(written['start-intent.json']['scope'], RUN_SCOPE)
        self.assertTrue(written['start-intent.json']['noReplay'])
        with self.assertRaises(FileExistsError): runner.intent('start')
        runner.read.return_value = self.base.review().descriptor()
        with self.assertRaisesRegex(ValueError, 'REVIEW_BINDING_CHANGED'): runner.intent('configure')

    def test_old_runner_still_calls_only125_loader(self):
        runner = self.base.runner()
        with patch.object(self.m, 'checked_sources'): runner.source()
        self.base.prep.load_prepared_source.assert_called_once()
        self.base.prep.load_prepared_matching126_source.assert_not_called()

    def test_named_phase_uses_fixed126_runner_without_actual_commands(self):
        review = self.review(); runner = Mock()
        runner.done = Mock(); runner.thread = None; runner.v = review.descriptor()
        with patch.object(self.m, 'runtime_support', return_value=nullcontext('fixed-support')) as support, \
                patch.object(self.m, 'Matching126AuthSource', return_value=runner) as factory:
            self.m.run_matching126_phase(review, 'configure')
        support.assert_called_once_with(review)
        factory.assert_called_once_with(review, 'fixed-support')
        runner.configure.assert_called_once(); runner.done.set.assert_called_once()


if __name__ == '__main__': unittest.main()
