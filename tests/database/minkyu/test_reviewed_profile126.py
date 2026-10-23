"""정확126 추가 준비의 합성 Git 회귀. SQL/Auth/Docker 실행은 하지 않는다."""
import ast
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools/local'))
sys.path.insert(0, str(Path(__file__).parent))
import prepare_current_policy as current
import prepare_migrations
import test_reviewed_current_policy as fixtures

PATH126 = 'backend/supabase/migrations/20261023050324_matching_db_entry_deadlines.sql'
SHA126 = '05d0f9a100a946afc8a25b04206cd656d53185904db5ef9f7ac6cb97154c530a'


class ReviewedProfile126Tests(unittest.TestCase):
    def setUp(self):
        self.base = fixtures.ReviewedCurrentPolicyTests('test_reviewed_whole_list_pin_required')
        self.base.setUp()
        self.addCleanup(self.base.doCleanups)
        self.repo, self.output = self.base.repo, self.base.output
        for name in self.base.registered_extensions:
            if name not in current.CURRENT_EXTENSION_REVIEWED:
                raw = (ROOT / name).read_bytes()
                (self.repo / name).write_bytes(raw)
                current.CURRENT_EXTENSION_REVIEWED[name] = hashlib.sha256(raw).hexdigest()
        self.commit()
        self.head125, self.pin125 = self.review()
        # 등록된 SQL의 내용 자체를 실행하지 않는 모형 바이트 계약이다.
        self.raw126 = b'begin; select 126000; commit;\n'
        self.registered = dict(current.MATCHING126_REVIEWED)
        p = patch.object(current, 'MATCHING126_REVIEWED', {PATH126: hashlib.sha256(self.raw126).hexdigest()})
        p.start(); self.addCleanup(p.stop)

    def commit(self):
        self.base.commit()

    def review(self):
        head = current.git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        entries = prepare_migrations.inspect_migrations(self.repo)['migrations']
        pin = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        return head, pin

    def add126(self):
        (self.repo / PATH126).write_bytes(self.raw126)
        self.commit()
        return self.review()

    def inspect126(self, head=None, pin=None):
        if head is None:
            head, pin = self.review()
        return current.inspect_reviewed_matching126_migrations(self.repo, head, pin)

    def test_registered_exact_path_and_reviewed_sha_only(self):
        self.assertEqual(self.registered, {PATH126: SHA126})

    def test_named126_rejects125_and_legacy125_still_accepts125(self):
        history, _ = current.inspect_reviewed_current_migrations(self.repo, self.head125, self.pin125)
        self.assertEqual(len(history['entries']), 125)
        with self.assertRaisesRegex(current.PreparationError, 'EXACT_REVIEWED_CURRENT_PROFILE_REQUIRED'):
            self.inspect126(self.head125, self.pin125)

    def test_named126_accepts_exact_committed_set_and_legacy125_rejects126(self):
        head, pin = self.add126()
        history, payloads = self.inspect126(head, pin)
        self.assertEqual((len(history['entries']), len(history['canonical']), history['pending']), (126, 126, []))
        self.assertEqual(payloads[Path(PATH126)], self.raw126)
        with self.assertRaisesRegex(current.PreparationError, 'EXACT_REVIEWED_CURRENT_PROFILE_REQUIRED'):
            current.inspect_reviewed_current_migrations(self.repo, head, pin)
        with self.assertRaises(current.PreparationError):
            current.inspect_current_migrations(self.repo)

    def test_named_preparer_writes126_exact_files_and_not_run_manifest(self):
        head, pin = self.add126()
        report = current.prepare_reviewed_matching126(self.repo, self.output, gateway_probe=True,
            reviewed_head=head, reviewed_manifest_sha256=pin)
        self.assertEqual((report['migration_count'], report['canonical_count'], report['pending_count']), (126, 126, 0))
        self.assertEqual((report['sql_execution'], report['edge_execution']), ('NOT_RUN', 'NOT_RUN'))
        self.assertEqual(report['reviewed_profile'], 'matching_db_entry_126')
        self.assertEqual((self.output / 'supabase/migrations' / Path(PATH126).name).read_bytes(), self.raw126)
        manifest = json.loads((self.output / 'migration-manifest.json').read_text())
        self.assertEqual(len(manifest['migrations']), 126)
        self.assertEqual(manifest['reviewed_profile'], 'matching_db_entry_126')
        self.assertEqual({row['path'] for row in manifest['migrations']}, {row['path'] for row in prepare_migrations.inspect_migrations(self.repo)['migrations']})

    def test126_requires_gateway_and_explicit_review_before_output(self):
        head, pin = self.add126()
        for kwargs in ({'reviewed_head': head, 'reviewed_manifest_sha256': pin},
                       {'gateway_probe': True}, {'gateway_probe': True, 'reviewed_head': head},
                       {'gateway_probe': True, 'reviewed_manifest_sha256': pin}):
            with self.subTest(kwargs=kwargs), self.assertRaises(current.PreparationError):
                current.prepare_reviewed_matching126(self.repo, self.output, **kwargs)
            self.assertFalse(self.output.exists())

    def test_unapproved127_committed_or_untracked_never_selected(self):
        self.add126()
        extra = self.repo / 'backend/supabase/migrations/20261023050325_unreviewed.sql'
        extra.write_text('select 127000;\n')
        with self.assertRaisesRegex(current.PreparationError, 'UNREVIEWED_SQL_PRESENT'):
            self.inspect126()
        self.commit()
        with self.assertRaisesRegex(current.PreparationError, 'EXACT_REVIEWED_CURRENT_PROFILE_REQUIRED'):
            self.inspect126()

    def test_wrong126_bytes_even_new_head_and_manifest_rejected(self):
        self.add126()
        (self.repo / PATH126).write_bytes(self.raw126 + b'-- changed\n')
        self.commit()
        with self.assertRaisesRegex(current.PreparationError, 'EXACT_REVIEWED_CURRENT_PROFILE_REQUIRED'):
            self.inspect126()

    def test_uncommitted126_or_missing125_entry_rejected(self):
        (self.repo / PATH126).write_bytes(self.raw126)
        with self.assertRaises(current.PreparationError):
            self.inspect126(self.head125, self.pin125)
        self.commit()
        (self.repo / self.base.extra).unlink()
        self.commit()
        with self.assertRaisesRegex(current.PreparationError, 'EXACT_REVIEWED_CURRENT_PROFILE_REQUIRED'):
            self.inspect126()

    def test_head_or_manifest_mismatch_rejected(self):
        head, pin = self.add126()
        for wrong_head, wrong_pin, code in ((self.head125, pin, 'REVIEWED_HEAD_CHANGED'),
                                            (head, self.pin125, 'REVIEWED_MANIFEST_CHANGED')):
            with self.subTest(code=code), self.assertRaisesRegex(current.PreparationError, code):
                self.inspect126(wrong_head, wrong_pin)

    def test_edge_uncommitted_and_sql_changed_during_prepare_rejected(self):
        head, pin = self.add126()
        path = self.repo / 'backend/supabase/functions/service-api/index.ts'
        original = path.read_bytes()
        path.write_bytes(original + b'\n// uncommitted\n')
        with self.assertRaisesRegex(current.PreparationError, 'CURRENT_EDGE_SOURCE_NOT_COMMITTED'):
            current.prepare_reviewed_matching126(self.repo, self.output, gateway_probe=True,
                reviewed_head=head, reviewed_manifest_sha256=pin)
        self.assertFalse(self.output.exists())
        path.write_bytes(original)
        real = current.inspect_reviewed_matching126_migrations
        calls = []
        def changed(*args):
            result = real(*args)
            calls.append(None)
            if len(calls) == 1:
                (self.repo / PATH126).write_bytes(self.raw126 + b'-- changed during preparation\n')
            return result
        with patch.object(current, 'inspect_reviewed_matching126_migrations', side_effect=changed):
            with self.assertRaises(current.PreparationError):
                current.prepare_reviewed_matching126(self.repo, self.output, gateway_probe=True,
                    reviewed_head=head, reviewed_manifest_sha256=pin)
        self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
