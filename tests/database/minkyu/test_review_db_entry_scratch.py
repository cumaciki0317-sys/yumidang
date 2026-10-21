"""125 scratch 고정 입력 등록 회귀. 실제Docker/SQL 실행 없음."""
import ast
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[3]
REL='tools/local/run_ai_consent_scratch.py'
s=importlib.util.spec_from_file_location('review_deadline_scratch',ROOT/REL);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
MIGRATION='backend/supabase/migrations/20261021142140_review_db_entry_deadline.sql'
FIXTURE='tests/database/minkyu/review_db_entry_deadline_fixture.sql'
class ReviewDeadlineScratchTests(unittest.TestCase):
 def test_exact_appended125_and_fixture(self):
  self.assertEqual(m.MIGRATIONS[-1],MIGRATION);self.assertEqual(m.TESTS[-1],FIXTURE)
  self.assertEqual(len(m.MIGRATIONS),4);self.assertEqual(len(set(m.MIGRATIONS)),4)
  self.assertEqual(hashlib.sha256((ROOT/MIGRATION).read_bytes()).hexdigest(),'85f4faa8892e1b304117ea08fffe42f9d7b7e5daca25a8fb977870b91755d101')
 def test_missing125_and_arbitrary_sql_refused_before_source_read(self):
  names={m.SELF,*m.MIGRATIONS,*m.TESTS,*m.ADDITIONAL_SOURCES}
  for selected in (names-{MIGRATION},names|{'arbitrary.sql'},names-{FIXTURE}):
   with patch.object(m.subprocess,'check_output',return_value='a'*40+'\n'):
    with self.assertRaisesRegex(ValueError,'SOURCE_SET_CHANGED'):m.source_review('a'*40,dict.fromkeys(selected,'0'*64))
 def test_default_cli_only_reports_not_run(self):
  stream=io.StringIO()
  with patch.object(sys,'argv',['run_ai_consent_scratch.py']),contextlib.redirect_stdout(stream),patch.object(m,'Scratch')as scratch:m.main()
  result=json.loads(stream.getvalue());self.assertEqual(result['status'],'NOT_RUN');self.assertIn(MIGRATION,result['migrationFiles']);self.assertIn(FIXTURE,result['testFiles']);scratch.assert_not_called()
 def test_existing_guards_run_cleanup_ast_unchanged(self):
  old=ast.parse(subprocess.check_output(['git','show','HEAD:'+REL],cwd=ROOT));new=ast.parse((ROOT/REL).read_bytes())
  units=lambda tree:{n.name:ast.dump(n,include_attributes=False)for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
  self.assertEqual(units(old),units(new))
 def test_archive_and_unknown_baseline_remain_literal(self):
  self.assertEqual(m.ARCHIVE_PINS,{'source.dump':'c741bec810faeb83b217a37aa8df865bd6499827e27a7099506d167c593706bf','roles.sql':'e3c775a7e3f96c947d53e72ea9e803e8d0d812b8eb3d4a9286147ed1914cecf3'})
  text=(ROOT/REL).read_text();self.assertIn("baseline.strip()==b'2'",text);self.assertIn("'UNKNOWN_CHANGED'",text)
if __name__=='__main__':unittest.main()
