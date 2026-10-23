"""126 후보의 좁은 SQL 패치 회귀. 실제 SQL/HTTP 실행 증거가 아니다."""
from pathlib import Path
import re
import unittest
ROOT=Path(__file__).resolve().parents[3]
SQL=(ROOT/'backend/supabase/migrations/20261023050324_matching_db_entry_deadlines.sql').read_text()
class MatchingEntryTests(unittest.TestCase):
 def test_only_fixed_deepest_functions_and_unique_anchors(self):
  patches=re.findall(r"select pg_temp.matching_entry_replace\('([^']+)',\$anchor\$(.*?)\$anchor\$,\$replacement\$(.*?)\$replacement\$\);",SQL,re.S)
  self.assertEqual(len(patches),8)
  self.assertEqual(len({sig for sig,_,_ in patches}),3)
  for sig,a,b in patches:
   self.assertNotEqual(a,b);self.assertNotIn('public.',sig)
  self.assertIn("length(body)-length(replace(body,anchor,''))",SQL)
 def test_expiry_target_only_and_no_state_resurrection(self):
  self.assertIn('when request_id=p_request_id then p_received_at else clock_timestamp()end',SQL)
  self.assertIn("status='awaiting_consent'",SQL)
  self.assertNotIn("set status='awaiting_consent'",SQL)
 def test_clock_lower_and_upper_separate(self):
  self.assertIn('p_received_at<c.expires_at',SQL);self.assertIn('p_decision_at>=c.requested_at',SQL)
  self.assertEqual(SQL.count('v_received_at timestamptz:=statement_timestamp()'),3)
  self.assertIn('p.recruitment_ends_at<=v_received_at or p.starts_at<=v_received_at',SQL)
 def test_catalog_and_legacy_helper_protected(self):
  self.assertEqual(SQL.count("'matching_entry_source_changed'"),5)
  for marker in ('p.proacl is distinct from b.proacl','p.proowner<>b.proowner','matching_entry_original_helper_changed','matching_entry_new_helper_acl'):self.assertIn(marker,SQL)
  self.assertNotIn('grant execute',SQL.lower())
 def test_fixture_executes_public_paths_and_state_combinations(self):
  f=(ROOT/'tests/database/minkyu/matching_db_entry_deadlines.sql').read_text()
  for marker in ('other_request_real_clock','location_fingerprint','schedule_fingerprint','open_dispute','restored_conditions','first_message_idempotence','first_message_exact_deadline','first_message_retry_after_deadline','accept_exact_deadline','accept_idempotence','schedule_accept_idempotence'):
   self.assertIn('matching_entry_'+marker,f)
  for rpc in ('public.complete_naver_signup','public.request_service_post','public.propose_match','public.accept_match'):self.assertIn(rpc,f)
  self.assertNotIn('where request_id=request_id',f)
  self.assertNotIn('assert ',f.lower())
 def test_real_sql_fixture_is_rollback_and_not_auth_claim(self):
  f=(ROOT/'tests/database/minkyu/matching_db_entry_deadlines.sql').read_text()
  for m in ('equal_and_strict_upper','predeadline_afterlock','requested_lower','no_resurrection','current_status','matching_entry_acl','target_not_expired','target_exact_expiry','target_never_revived'):self.assertIn(m,f)
  self.assertTrue(f.rstrip().endswith('rollback;'));self.assertNotIn('disable trigger',f.lower())
if __name__=='__main__':unittest.main()
