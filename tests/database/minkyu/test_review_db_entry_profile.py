"""125 exact 등록 준비 회귀. 임시Git만 사용, 실제SQL/Docker/운영0."""
import hashlib
import json
from pathlib import Path
import sys
import unittest
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tools/local'));sys.path.insert(0,str(Path(__file__).parent))
import prepare_current_policy as current
import prepare_migrations
import test_reviewed_current_policy as base
PATH='backend/supabase/migrations/20261021142140_review_db_entry_deadline.sql'
PIN='85f4faa8892e1b304117ea08fffe42f9d7b7e5daca25a8fb977870b91755d101'

class ReviewDeadlineProfileTests(unittest.TestCase):
 def setUp(self):
  self.case=base.ReviewedCurrentPolicyTests('test_both_explicit_review_values_required');self.case.setUp();self.addCleanup(self.case.doCleanups)
  self.repo=self.case.repo
  for path in ('backend/supabase/migrations/20261020130000_post_private_events.sql','backend/supabase/migrations/20261021120000_kopis_verified_snapshots.sql',PATH):
   payload=(ROOT/path).read_bytes();(self.repo/path).write_bytes(payload);current.CURRENT_EXTENSION_REVIEWED[path]=hashlib.sha256(payload).hexdigest()
  self.seal()
 def seal(self):
  self.case.commit();self.head=current.git(self.repo,'rev-parse','HEAD').decode().strip();entries=prepare_migrations.inspect_migrations(self.repo)['migrations'];self.manifest=hashlib.sha256(json.dumps(entries,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
 def inspect(self,head=None,pin=None):return current.inspect_reviewed_current_migrations(self.repo,head or self.head,pin or self.manifest)
 def test_literal_registration_and_exact125(self):
  self.assertEqual(self.case.registered_extensions[PATH],PIN);self.assertEqual(hashlib.sha256((ROOT/PATH).read_bytes()).hexdigest(),PIN)
  report,payloads=self.inspect();self.assertEqual(len(report['entries']),125);self.assertEqual(report['pending'],[]);self.assertEqual(payloads[Path(PATH)],(ROOT/PATH).read_bytes())
 def test_126_does_not_register_by_count(self):
  (self.repo/'backend/supabase/migrations/20261021150000_unreviewed.sql').write_text('select 126;');self.seal()
  with self.assertRaisesRegex(current.PreparationError,'EXACT_REVIEWED_CURRENT_PROFILE_REQUIRED'):self.inspect()
 def test_mutated125_refused_even_with_new_head_and_manifest(self):
  (self.repo/PATH).write_bytes((self.repo/PATH).read_bytes()+b'-- mutation\n');self.seal()
  with self.assertRaisesRegex(current.PreparationError,'EXACT_REVIEWED_CURRENT_PROFILE_REQUIRED'):self.inspect()
 def test_wrong_head_or_manifest_refused(self):
  with self.assertRaisesRegex(current.PreparationError,'REVIEWED_HEAD_CHANGED'):self.inspect(head='0'*40)
  with self.assertRaisesRegex(current.PreparationError,'REVIEWED_MANIFEST_CHANGED'):self.inspect(pin='0'*64)
 def test_historical121_default_stays_closed(self):
  with self.assertRaises(current.PreparationError):current.inspect_current_migrations(self.repo)

if __name__=='__main__':unittest.main()
