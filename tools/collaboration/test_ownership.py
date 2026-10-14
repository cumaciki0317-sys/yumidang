"""Run with: python3 -m unittest discover -s tools/collaboration -p 'test_*.py'."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import check_ownership as checker


def sample_policy():
    return {
        "version": 1,
        "protected_paths": ["backend/", "AGENTS.md"],
        "rules": [
            {"path": "backend/core/", "owner": "minkyu"},
            {"path": "backend/ai/", "owner": "jonghyun"},
            {"path": "backend/ai/shared.ts", "owner": "minkyu"},
            {"path": "backend/ownership.json", "owner": "minkyu"},
            {"path": "AGENTS.md", "owner": "minkyu"},
        ],
    }


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = checker.validate_policy(sample_policy())

    def test_longest_exact_rule_wins_over_directory(self):
        self.assertEqual(checker.violations(self.policy, "minkyu", ["backend/ai/shared.ts"]), [])
        self.assertEqual(checker.violations(self.policy, "jonghyun", ["backend/ai/shared.ts"]),
                         [("backend/ai/shared.ts", "minkyu")])

    def test_other_owner_and_unassigned_are_denied(self):
        self.assertEqual(checker.violations(self.policy, "jonghyun", ["backend/core/auth.ts", "backend/new.ts"]),
                         [("backend/core/auth.ts", "minkyu"), ("backend/new.ts", None)])

    def test_unprotected_paths_are_ignored_and_prefix_has_boundary(self):
        self.assertEqual(checker.violations(self.policy, "jonghyun", ["frontend/app.ts", "backend-other/file.ts"]), [])
        self.assertEqual(checker.violations(self.policy, "minkyu", ["backend/ai-other/test.ts"]),
                         [("backend/ai-other/test.ts", None)])

    def test_invalid_paths_and_policy_fail_closed(self):
        for path in ["../secret", "backend/../core/x", "/outside/file", "", "."]:
            with self.subTest(path=path), self.assertRaises(checker.CheckError):
                checker.normalize_path(path, repo=Path("/repo"))
        bad = sample_policy()
        bad["rules"].append({"path": "backend/ai/", "owner": "minkyu"})
        with self.assertRaises(checker.CheckError):
            checker.validate_policy(bad)

    def test_korean_spaces_and_copy_rename_paths_preserved(self):
        raw = "R100\0backend/core/이전 파일.ts\0backend/ai/새 파일.ts\0C100\0backend/core/원본.ts\0backend/ai/사본.ts\0".encode()
        paths = checker.parse_name_status(raw)
        self.assertEqual(paths, ["backend/core/이전 파일.ts", "backend/ai/새 파일.ts", "backend/core/원본.ts", "backend/ai/사본.ts"])
        self.assertEqual(len(checker.violations(self.policy, "jonghyun", paths)), 2)

    def test_malformed_git_output_is_error(self):
        for raw in [b"M\0path", b"R100\0only-source\0", b"?\0file\0"]:
            with self.subTest(raw=raw), self.assertRaises(checker.CheckError):
                checker.parse_name_status(raw)

    def test_inactive_owner_is_readable_without_reactivating_actor(self):
        legacy = sample_policy()
        legacy["rules"].append({"path": "backend/legacy-ui/", "owner": "sungho"})
        policy = checker.validate_policy(legacy)
        self.assertIn("sungho", checker.POLICY_OWNERS)
        self.assertNotIn("sungho", checker.ACTORS)
        self.assertEqual(checker.violations(policy, "minkyu", ["backend/legacy-ui/app.ts"]),
                         [("backend/legacy-ui/app.ts", "sungho")])

    def test_yumi_has_only_explicit_ut_paths(self):
        proposed = sample_policy()
        proposed["protected_paths"].append("docs/planning/ut/")
        proposed["rules"].append({"path": "docs/planning/ut/", "owner": "yumi"})
        policy = checker.validate_policy(proposed)
        self.assertEqual(checker.violations(policy, "yumi", ["docs/planning/ut/result.md"]), [])
        self.assertEqual(checker.violations(policy, "yumi", ["frontend/app.ts", "backend/core/auth.ts"]),
                         [("frontend/app.ts", None), ("backend/core/auth.ts", "minkyu")])

    def test_common_qa_is_not_a_shared_file_owner(self):
        for owner in ["common", ["minkyu", "jonghyun", "yumi"]]:
            bad = sample_policy()
            bad["rules"].append({"path": "tests/qa/", "owner": owner})
            with self.subTest(owner=owner), self.assertRaises(checker.CheckError):
                checker.validate_policy(bad)


class GitIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="yumidang-ownership-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        # No inherited Git variables may redirect writes into the real repository.
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        self.git("init", "--quiet", "--template=")
        scripts = self.repo / "tools/collaboration"
        scripts.mkdir(parents=True)
        shutil.copy2(Path(checker.__file__), scripts / "check_ownership.py")
        self.script = scripts / "check_ownership.py"
        self.write("backend/ownership.json", json.dumps(sample_policy()))

    def git(self, *args):
        result = subprocess.run(
            ["git", "-C", str(self.repo), "-c", "core.hooksPath=/dev/null",
             "-c", "commit.gpgSign=false", "-c", "user.name=Ownership Test",
             "-c", "user.email=ownership-test@example.invalid", *args],
            env=self.env, capture_output=True, check=True,
        )
        return result.stdout

    def write(self, path, contents):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(contents, encoding="utf-8")

    def commit(self):
        self.git("add", "--all")
        self.git("commit", "--quiet", "-m", "Test fixture")

    def run_check(self, actor, *args):
        return subprocess.run(
            [sys.executable, str(self.script), "--actor", actor, *args],
            cwd=self.temp.name, env=self.env, capture_output=True, text=True, check=False,
        )

    def test_initial_manifest_fallback_and_prospective_paths(self):
        result = self.run_check("jonghyun", "--paths", "backend/ai/새 파일.ts")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("HEAD에 담당 정책이 없어", result.stderr)
        self.assertEqual(self.run_check("jonghyun", "--paths", "backend/core/auth.ts").returncode, 1)

    def test_existing_head_without_manifest_uses_bootstrap_policy(self):
        self.git("add", "tools/")
        self.git("commit", "--quiet", "-m", "Without policy")
        result = self.run_check("minkyu", "--paths", "backend/core/new.ts")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("작업 폴더 정책", result.stderr)

    def test_staged_add_default_delete_and_spaces(self):
        self.write("backend/core/삭제 대상.ts", "old")
        self.commit()
        (self.repo / "backend/core/삭제 대상.ts").unlink()
        self.write("backend/ai/새 파일.ts", "new")
        self.git("add", "--all")
        denied = self.run_check("jonghyun")
        self.assertEqual(denied.returncode, 1, denied.stderr)
        self.assertIn("삭제 대상.ts", denied.stderr)
        self.assertEqual(self.run_check("minkyu", "--staged").returncode, 1)

    def test_rename_checks_source_and_destination(self):
        self.write("backend/core/원본 파일.ts", "unique identical contents for rename\n")
        self.commit()
        (self.repo / "backend/ai").mkdir()
        self.git("mv", "backend/core/원본 파일.ts", "backend/ai/이동 파일.ts")
        for actor, denied_path in [("minkyu", "이동 파일.ts"), ("jonghyun", "원본 파일.ts")]:
            with self.subTest(actor=actor):
                result = self.run_check(actor, "--staged")
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn(denied_path, result.stderr)

    def test_staged_policy_edit_cannot_grant_ownership(self):
        self.commit()
        replacement = sample_policy()
        for rule in replacement["rules"]:
            rule["owner"] = "jonghyun"
        self.write("backend/ownership.json", json.dumps(replacement))
        self.write("backend/core/auth.ts", "unauthorized")
        self.git("add", "--all")
        result = self.run_check("jonghyun", "--staged")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("backend/ownership.json", result.stderr)
        self.assertIn("backend/core/auth.ts", result.stderr)
        # Even an invalid working policy cannot replace committed policy.
        self.write("backend/ownership.json", "{invalid")
        result = self.run_check("jonghyun", "--paths", "backend/ai/new.ts")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("HEAD:backend/ownership.json", result.stdout)

    def test_deleted_policy_still_uses_head(self):
        self.commit()
        self.git("rm", "backend/ownership.json")
        self.assertEqual(self.run_check("jonghyun", "--staged").returncode, 1)

    def test_invalid_config_and_external_paths_exit_two(self):
        for path in ["../escape.ts", "/outside/test.ts", "backend/../test.ts", "backend/", "backend"]:
            with self.subTest(path=path):
                self.assertEqual(self.run_check("minkyu", "--paths", path).returncode, 2)
        self.write("backend/ownership.json", "not json")
        self.assertEqual(self.run_check("minkyu", "--staged").returncode, 2)

    def test_clean_staged_tree_passes_and_absolute_inside_is_supported(self):
        self.commit()
        self.assertEqual(self.run_check("minkyu", "--staged").returncode, 0)
        result = self.run_check("jonghyun", "--paths", str(self.repo / "backend/ai/new.ts"))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_legacy_committed_policy_remains_readable_but_actor_is_inactive(self):
        policy = sample_policy()
        policy["rules"].append({"path": "backend/legacy-ui/", "owner": "sungho"})
        self.write("backend/ownership.json", json.dumps(policy))
        self.commit()
        self.assertEqual(self.run_check("minkyu", "--paths", "backend/core/auth.ts").returncode, 0)
        self.assertEqual(self.run_check("sungho", "--paths", "backend/legacy-ui/app.ts").returncode, 2)

    def test_yumi_staged_check_cannot_touch_other_owner_or_unprotected_path(self):
        policy = sample_policy()
        policy["protected_paths"].append("docs/planning/ut/")
        policy["rules"].append({"path": "docs/planning/ut/", "owner": "yumi"})
        self.write("backend/ownership.json", json.dumps(policy))
        self.commit()
        self.write("docs/planning/ut/result.md", "UT result")
        self.git("add", "docs/planning/ut/result.md")
        self.assertEqual(self.run_check("yumi", "--staged").returncode, 0)
        self.write("frontend/app.ts", "not assigned to yumi")
        self.git("add", "frontend/app.ts")
        self.assertEqual(self.run_check("yumi", "--staged").returncode, 1)

    def test_precommit_accepts_explicit_yumi_work_and_rejects_inactive_actor(self):
        policy = sample_policy()
        policy["protected_paths"].append("docs/planning/ut/")
        policy["rules"].append({"path": "docs/planning/ut/", "owner": "yumi"})
        self.write("backend/ownership.json", json.dumps(policy))
        self.commit()
        self.write("docs/planning/ut/result.md", "UT result")
        self.git("add", "docs/planning/ut/result.md")
        hook = Path(checker.__file__).resolve().parents[2] / ".githooks/pre-commit"
        for actor, expected in [("yumi", 0), ("sungho", 1)]:
            with self.subTest(actor=actor):
                self.git("config", "--local", "yumidang.actor", actor)
                result = subprocess.run(["sh", str(hook)], cwd=self.repo,
                                        env=self.env, capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, expected, result.stderr)


class RoleEntryPointTests(unittest.TestCase):
    def test_setup_rejects_inactive_actor_before_configuration(self):
        script = Path(checker.__file__).with_name("setup_actor.py")
        result = subprocess.run([sys.executable, str(script), "--actor", "sungho"],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_legacy_backend_start_is_blocked_before_package_or_clone_work(self):
        script = Path(checker.__file__).with_name("start_jonghyun.py")
        for arguments in [[], ["--prepare-only"], ["--prepare-only", "--package", "/missing/package"]]:
            with self.subTest(arguments=arguments):
                result = subprocess.run([sys.executable, str(script), *arguments],
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("현재 종현 담당은 FE·UX/UI·앱 서비스 연동", result.stderr)
                self.assertIn("BE·AI는 민규 전담", result.stderr)


if __name__ == "__main__":
    unittest.main()
