"""새 복원 source 준비의 목록/HEAD/추가파일 거절 회귀. 실제 Docker/DB 실행 없음."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "tools/local"))
import prepare_restore_source_manifest as preparation

class RestoreSourceManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="restore-source-test-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name).resolve()
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Synthetic fixture")
        for i in range(3):
            self.write(f"backend/supabase/migrations/2026102000000{i}_fixture.sql", f"select {i};")
        for name in preparation.SOURCE_FILES: self.write(name, f"fixture: {name}")
        self.commit()
        self.head = preparation.core.head(self.repo)
        self.pin = preparation.digest(preparation.canonical(
            preparation.inspect_migrations(self.repo)["migrations"]))

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True,
                              capture_output=True).stdout

    def write(self, name, text):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "synthetic source")

    def prepare(self):
        return preparation.prepare_source_manifest(self.repo, self.head, self.pin)

    def test_exact_committed_variable_count_has_no_execution_authority(self):
        result = self.prepare()
        self.assertEqual(3, result["migrationCount"])
        self.assertTrue(result["committedSourceVerified"])
        self.assertFalse(result["runnable"])
        self.assertFalse(result["executionAllowed"])
        self.assertEqual("NOT_REVIEWED", result["consumerCompatibility"])

    def test_untracked_new_migration_is_not_silently_excluded(self):
        self.write("backend/supabase/migrations/20261020100000_new.sql", "select 42;")
        with self.assertRaisesRegex(preparation.ManifestRefused, "UNREVIEWED_SQL_PRESENT"):
            self.prepare()

    def test_old_review_cannot_approve_new_committed_migration(self):
        self.write("backend/supabase/migrations/20261020100000_new.sql", "select 42;")
        self.commit()
        with self.assertRaisesRegex(preparation.ManifestRefused, "REVIEWED_HEAD_CHANGED"):
            self.prepare()

    def test_new_head_still_requires_exact_reviewed_list(self):
        self.write("backend/supabase/migrations/20261020100000_new.sql", "select 42;")
        self.commit()
        self.head = preparation.core.head(self.repo)
        with self.assertRaisesRegex(preparation.ManifestRefused, "REVIEWED_MIGRATIONS_CHANGED"):
            self.prepare()

    def test_modified_committed_source_is_rejected(self):
        self.write("tools/local/prepare_database_restore.py", "modified")
        with self.assertRaisesRegex(preparation.ManifestRefused, "SOURCE_NOT_COMMITTED"):
            self.prepare()

    def test_modified_committed_sql_is_rejected(self):
        self.write("backend/supabase/migrations/20261020000000_fixture.sql", "select 42;")
        with self.assertRaises(ValueError): self.prepare()

    def test_copy_is_preserved_but_not_added_to_manifest(self):
        self.write("backend/supabase/migrations/20261020000000_fixture 2.sql", "select 1;")
        self.assertEqual(3, self.prepare()["migrationCount"])

    def test_nested_unreviewed_sql_is_rejected(self):
        self.write("backend/supabase/migrations/nested/rogue.sql", "select 1;")
        with self.assertRaisesRegex(preparation.ManifestRefused, "UNREVIEWED_SQL_PRESENT"):
            self.prepare()

    def test_malformed_review_values_rejected(self):
        for head, pin in (("main", self.pin), (self.head, "bad")):
            with self.assertRaises(preparation.ManifestRefused):
                preparation.prepare_source_manifest(self.repo, head, pin)

if __name__ == "__main__": unittest.main()
