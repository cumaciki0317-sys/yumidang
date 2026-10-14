"""Current WBS roles checked through isolated real Git hooks and trusted policy."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


class CurrentRoleGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        self.git('init', '--quiet', '--template=')
        self.git('config', 'user.name', 'Guard Fixture')
        self.git('config', 'user.email', 'guard@example.invalid')
        self.git('config', 'commit.gpgSign', 'false')
        for path in ['backend/ownership.json', 'tools/collaboration/check_ownership.py',
                     'tools/collaboration/setup_actor.py', '.githooks/pre-commit']:
            dst = self.repo / path
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / path, dst)
        self.write('backend/core.ts', 'original\n')
        self.write('apps/mobile/src/api.ts', 'original\n')
        self.write('apps/mobile/assets/sungho/icon.txt', 'original\n')
        self.git('add', '--all')
        self.git('commit', '--quiet', '-m', 'Fixture baseline')
        self.base = self.git('rev-parse', 'HEAD').stdout.strip()
        self.git('switch', '-c', 'jonghyun/ui-test')
        result = self.setup('jonghyun')
        self.assertEqual(result.returncode, 0, result.stderr)

    def git(self, *args, check=True):
        result = subprocess.run(['git', '-C', str(self.repo), *args], env=self.env,
                                text=True, capture_output=True)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def write(self, path, text):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def setup(self, actor):
        return subprocess.run([sys.executable, str(self.repo / 'tools/collaboration/setup_actor.py'),
                               '--actor', actor], env=self.env, text=True, capture_output=True)

    def check(self, actor, *args):
        return subprocess.run([sys.executable, str(self.repo / 'tools/collaboration/check_ownership.py'),
                               '--actor', actor, *args], env=self.env, text=True, capture_output=True)

    def test_jonghyun_ui_commit_allowed_real_hook(self):
        self.write('apps/mobile/assets/sungho/icon.txt', 'improved\n')
        self.git('add', '--', 'apps/mobile/assets/sungho/icon.txt')
        self.git('commit', '-m', 'Assigned UI asset')
        self.assertNotEqual(self.git('rev-parse', 'HEAD').stdout.strip(), self.base)

    def test_jonghyun_frontend_ui_and_client_allowed(self):
        for path in ['frontend/src/App.tsx', 'apps/mobile/src/ui.tsx',
                     'apps/mobile/src/screens/RemoteMemberScreens.tsx',
                     'apps/mobile/src/app/account.tsx', 'apps/mobile/src/components/Button.tsx',
                     'apps/mobile/src/api.ts', 'apps/mobile/src/member-service.ts',
                     'apps/mobile/src/web-member-session.ts', 'docs/planning/design/IA.md']:
            with self.subTest(path=path):
                self.assertEqual(self.check('jonghyun', '--paths', path).returncode, 0)

    def test_backend_ai_and_operating_tools_exclusive_to_minkyu(self):
        for path in ['backend/core.ts', 'backend/supabase/functions/ai-chat/handler.ts',
                     'backend/supabase/functions/_shared/ai/providers/runtime.ts',
                     'backend/supabase/functions/event-sync/index.ts',
                     'backend/supabase/migrations/new.sql', 'tools/local/run_database_tests.py',
                     'backend/ownership.json', '.env.example']:
            with self.subTest(path=path):
                self.assertEqual(self.check('minkyu', '--paths', path).returncode, 0)
                self.assertEqual(self.check('jonghyun', '--paths', path).returncode, 1)
                self.assertEqual(self.check('yumi', '--paths', path).returncode, 1)

    def test_removed_sungho_actor_rejected_before_edit_and_setup(self):
        self.assertNotEqual(self.check('sungho', '--paths', 'frontend/src/App.tsx').returncode, 0)
        self.assertNotEqual(self.setup('sungho').returncode, 0)
        self.assertEqual(self.git('config', 'yumidang.actor').stdout.strip(), 'jonghyun')

    def test_removed_actor_cannot_use_real_commit_hook(self):
        self.git('config', 'yumidang.actor', 'sungho')
        self.write('apps/mobile/assets/sungho/icon.txt', 'forbidden\n')
        self.git('add', '--', 'apps/mobile/assets/sungho/icon.txt')
        self.assertNotEqual(self.git('commit', '-m', 'Retired actor', check=False).returncode, 0)
        self.assertEqual(self.git('rev-parse', 'HEAD').stdout.strip(), self.base)

    def test_ui_symlink_cannot_edit_backend_target(self):
        link = self.repo / 'apps/mobile/assets/sungho/link.ts'
        link.symlink_to(self.repo / 'backend/core.ts')
        self.assertEqual(self.check('jonghyun', '--paths', str(link.relative_to(self.repo))).returncode, 1)

    def test_backend_actual_commit_blocked_for_frontend_actor(self):
        self.write('backend/core.ts', 'forbidden\n')
        self.git('add', '--', 'backend/core.ts')
        self.assertNotEqual(self.git('commit', '-m', 'Forbidden backend', check=False).returncode, 0)
        self.assertEqual(self.git('rev-parse', 'HEAD').stdout.strip(), self.base)

    def test_policy_tampering_cannot_grant_backend_permission(self):
        path = self.repo / 'backend/ownership.json'
        policy = json.loads(path.read_text())
        policy['rules'].append({'path': 'backend/core.ts', 'owner': 'jonghyun'})
        path.write_text(json.dumps(policy))
        self.write('backend/core.ts', 'forbidden\n')
        self.git('add', '--', 'backend/core.ts', 'backend/ownership.json')
        self.assertEqual(self.check('jonghyun', '--staged').returncode, 1)
        self.assertNotEqual(self.git('commit', '-m', 'Tampered ownership', check=False).returncode, 0)

    def test_rename_to_backend_checks_destination(self):
        self.git('mv', 'apps/mobile/assets/sungho/icon.txt', 'backend/new-api.ts')
        self.assertEqual(self.check('jonghyun', '--staged').returncode, 1)

    def test_setup_preserves_other_actor_or_custom_hook(self):
        self.git('config', 'yumidang.actor', 'minkyu')
        self.assertEqual(self.setup('jonghyun').returncode, 1)
        self.assertEqual(self.git('config', 'yumidang.actor').stdout.strip(), 'minkyu')
        self.git('config', 'yumidang.actor', 'jonghyun')
        self.git('config', 'core.hooksPath', 'custom-hooks')
        self.assertEqual(self.setup('jonghyun').returncode, 1)
        self.assertEqual(self.git('config', 'core.hooksPath').stdout.strip(), 'custom-hooks')

    def test_trusted_base_diff_rejects_forbidden_head(self):
        self.write('backend/core.ts', 'forbidden head\n')
        self.git('add', '--', 'backend/core.ts')
        tree = self.git('write-tree').stdout.strip()
        head = self.git('commit-tree', tree, '-p', self.base, '-m', 'Synthetic forbidden PR').stdout.strip()
        result = self.check('jonghyun', '--diff', self.base, head)
        self.assertEqual(result.returncode, 1)
        self.assertIn('backend/core.ts', result.stderr)


if __name__ == '__main__':
    unittest.main()
