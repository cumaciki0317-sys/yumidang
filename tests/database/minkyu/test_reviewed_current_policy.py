"""새 committed policy profile 준비 회귀. SQL/Auth/Docker 실행 없음."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools/local'))
sys.path.insert(0, str(Path(__file__).parent))
import prepare_current_policy as current
import prepare_migrations
import test_current_policy_preparation as fixtures

class ReviewedCurrentPolicyTests(unittest.TestCase):
    def setUp(self):
        self.registered_extensions = dict(current.CURRENT_EXTENSION_REVIEWED)
        self.fixture = fixtures.CurrentPolicyPreparationTests('test_new_queue_tail_requires_exact_reviewed_bytes')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.repo, self.output = self.fixture.repo, self.fixture.output
        self.extra = Path('backend/supabase/migrations/20261020100000_ai_independent_consents.sql')
        (self.repo / self.extra).write_text('begin; select 99999; commit;\n')
        self.extension = {str(self.extra): hashlib.sha256((self.repo/self.extra).read_bytes()).hexdigest()}
        p = patch.object(current, 'CURRENT_EXTENSION_REVIEWED', self.extension)
        p.start(); self.addCleanup(p.stop)
        self.commit()
        self.head = current.git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        entries = prepare_migrations.inspect_migrations(self.repo)['migrations']
        self.pin = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()

    def commit(self):
        self.fixture.fixture.git('add', '.')
        self.fixture.fixture.git('-c', 'user.name=Reviewed fixture', '-c', 'user.email=fixture@example.invalid',
                                 '-c', 'commit.gpgsign=false', 'commit', '-qm', 'committed reviewed profile')

    def inspect(self):
        return current.inspect_reviewed_current_migrations(self.repo, self.head, self.pin)

    def test_exact_committed_profile_builds_real_gateway_artifacts(self):
        report = current.prepare_current_policy(self.repo, self.output, gateway_probe=True,
                                                reviewed_head=self.head, reviewed_manifest_sha256=self.pin)
        self.assertEqual((report['migration_count'], report['canonical_count'], report['pending_count']), (122, 122, 0))
        self.assertEqual(report['sql_execution'], 'NOT_RUN')
        self.assertEqual(report['source_head'], self.head)
        self.assertEqual((self.output/'supabase/migrations'/self.extra.name).read_bytes(), (self.repo/self.extra).read_bytes())
        self.assertTrue((self.output/'supabase/functions/service-api/index.ts').is_file())
        self.assertTrue((self.output/'base-database-manifest.json').is_file())
        manifest=json.loads((self.output/'migration-manifest.json').read_text())
        self.assertEqual(len(manifest['migrations']), 122)

    def test_historical_default_rejects_current_extension(self):
        with self.assertRaises(current.PreparationError):
            current.inspect_current_migrations(self.repo)

    def test_two_explicit_extensions_keep_full_list_and_reject_third(self):
        second=Path('backend/supabase/migrations/20261020130000_post_private_events.sql')
        (self.repo/second).write_text('begin; select 99998; commit;\n')
        current.CURRENT_EXTENSION_REVIEWED[str(second)]=hashlib.sha256((self.repo/second).read_bytes()).hexdigest()
        self.commit();self.head=current.git(self.repo,'rev-parse','HEAD').decode().strip()
        entries=prepare_migrations.inspect_migrations(self.repo)['migrations']
        self.pin=hashlib.sha256(json.dumps(entries,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
        history,payloads=self.inspect()
        self.assertEqual(len(history['entries']),123)
        self.assertEqual(payloads[second],(self.repo/second).read_bytes())
        (self.repo/'backend/supabase/migrations/20261021100000_unreviewed.sql').write_text('select 99997;')
        with self.assertRaisesRegex(current.PreparationError,'UNREVIEWED_SQL_PRESENT'):self.inspect()

    def test_three_reviewed_extensions_require_exact_124_manifest_and_reject_fourth_or_mutation(self):
        third = Path('backend/supabase/migrations/20261021120000_kopis_verified_snapshots.sql')
        reviewed_sha = '77f14ec4d7bcd4e6d5ad35d2c6a1338f935c598fb801b173b9469ed32353a2bd'
        self.assertEqual(self.registered_extensions.get(str(third)), reviewed_sha)
        self.assertEqual(hashlib.sha256((ROOT/third).read_bytes()).hexdigest(), reviewed_sha)
        second = Path('backend/supabase/migrations/20261020130000_post_private_events.sql')
        for path, sql in ((second, 'begin; select 99998; commit;\n'),
                          (third, 'begin; select 99997; commit;\n')):
            (self.repo/path).write_text(sql)
            current.CURRENT_EXTENSION_REVIEWED[str(path)] = hashlib.sha256((self.repo/path).read_bytes()).hexdigest()
        def commit_review():
            self.commit(); self.head = current.git(self.repo, 'rev-parse', 'HEAD').decode().strip()
            entries = prepare_migrations.inspect_migrations(self.repo)['migrations']
            self.pin = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        commit_review()
        history, payloads = self.inspect()
        self.assertEqual(len(history['entries']), 124)
        self.assertEqual(payloads[third], (self.repo/third).read_bytes())
        original = (self.repo/third).read_bytes()
        (self.repo/third).write_bytes(original+b'-- unreviewed mutation\n')
        commit_review()
        with self.assertRaisesRegex(current.PreparationError, 'EXACT_REVIEWED_CURRENT_PROFILE_REQUIRED'):
            self.inspect()
        (self.repo/third).write_bytes(original)
        fourth = Path('backend/supabase/migrations/20261021130000_unreviewed.sql')
        (self.repo/fourth).write_text('select 99996;\n')
        commit_review()
        with self.assertRaisesRegex(current.PreparationError, 'EXACT_REVIEWED_CURRENT_PROFILE_REQUIRED'):
            self.inspect()

    def test_both_explicit_review_values_required(self):
        for head, pin in ((None,self.pin),(self.head,None),('main',self.pin)):
            with self.assertRaises(current.PreparationError):
                current.inspect_reviewed_current_migrations(self.repo,head,pin)

    def test_reviewed_head_cannot_follow_new_commit(self):
        (self.repo/'unrelated.txt').write_text('new head')
        self.commit()
        with self.assertRaisesRegex(current.PreparationError,'REVIEWED_HEAD_CHANGED'):self.inspect()

    def test_reviewed_whole_list_pin_required(self):
        with self.assertRaisesRegex(current.PreparationError,'REVIEWED_MANIFEST_CHANGED'):
            current.inspect_reviewed_current_migrations(self.repo,self.head,'0'*64)

    def test_untracked_manual_event_not_automatically_approved(self):
        (self.repo/'backend/supabase/migrations/20261020130000_manual_event.sql').write_text('select 99998;')
        with self.assertRaisesRegex(current.PreparationError,'UNREVIEWED_SQL_PRESENT'):self.inspect()

    def test_committed_extra_not_approved_even_with_new_list_pin(self):
        (self.repo/'backend/supabase/migrations/20261020130000_manual_event.sql').write_text('select 99998;')
        self.commit();self.head=current.git(self.repo,'rev-parse','HEAD').decode().strip()
        with self.assertRaisesRegex(current.PreparationError,'EXACT_REVIEWED_CURRENT_PROFILE_REQUIRED'):self.inspect()

    def test_extension_bytes_changed_is_rejected(self):
        (self.repo/self.extra).write_text('unreviewed SQL')
        with self.assertRaises(current.PreparationError):self.inspect()

    def test_edge_working_tree_not_promoted_to_committed_profile(self):
        path=self.repo/'backend/supabase/functions/service-api/index.ts'
        path.write_text(path.read_text()+'\n// uncommitted\n')
        with self.assertRaisesRegex(current.PreparationError,'CURRENT_EDGE_SOURCE_NOT_COMMITTED'):
            current.prepare_current_policy(self.repo,self.output,gateway_probe=True,
                reviewed_head=self.head,reviewed_manifest_sha256=self.pin)
        self.assertFalse(self.output.exists())

if __name__=='__main__':unittest.main()
