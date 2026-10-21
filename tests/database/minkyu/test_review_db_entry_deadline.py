"""마이그레이션 경계 정적 회귀. 실제 SQL/동시성 정책 PASS가 아니다."""
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[3]
SQL=(ROOT/'backend/supabase/migrations/20261021142140_review_db_entry_deadline.sql').read_text()
class DeadlineMigrationTests(unittest.TestCase):
 def test_current_hold_and_dispute_guards_preserved(self):
  self.assertIn('not private.appointment_review_held(ap.id)',SQL);self.assertIn("d.status='open' or d.resolution='no_show'",SQL)
 def test_only_upper_bound_uses_received(self):
  self.assertIn('p_received_at<ap.review_deadline_at',SQL);self.assertIn('p_decision_at>=ap.completed_at',SQL);self.assertIn('p_decision_at>=p.ends_at',SQL)
 def test_deepest_patch_is_after_original_duplicate_branch(self):
  self.assertIn('statement_timestamp()',SQL);self.assertIn("anchor:='if not private.can_submit",SQL);self.assertNotIn('delete from',SQL.lower());self.assertNotIn('update public.appointments',SQL.lower())
 def test_exact_source_and_catalog_protected(self):
  self.assertIn('f2ac1dfe9d6f9c519e75977c1115936df05cefddc43265ca12bd7c57978f20c1',SQL);self.assertIn('review_entry_original_catalog_changed',SQL);self.assertIn('p.proacl',SQL);self.assertIn('a.grantee<>p.proowner',SQL)
 def test_sql_regression_prepared_not_executed(self):
  fixture=(ROOT/'tests/database/minkyu/review_db_entry_deadline_fixture.sql').read_text()
  for marker in ('same_time_regression','strict_upper_bound','completion_transition','hold_bypassed','missing_own_confirmation','outsider_on_eligible','confirmed_own_confirmation','manual_one_confirmation','manual_both_confirmations','no_show'):self.assertIn(marker,fixture)
  self.assertLess(fixture.index('review_entry_outsider_on_eligible'),fixture.index('insert into private.appointment_review_holds'))
  self.assertNotIn('create function pg_temp.review_actor',fixture)
  self.assertNotIn('review_probe',fixture)
  self.assertTrue(fixture.rstrip().endswith('rollback;'))
if __name__=='__main__':unittest.main()
