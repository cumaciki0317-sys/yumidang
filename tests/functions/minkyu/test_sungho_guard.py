"""Real isolated Git hook and trusted base policy checks for sungho."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]

class SunghoGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.env = {k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
        self.git('init', '--quiet', '--template=')
        self.git('config', 'user.name', 'Guard Fixture')
        self.git('config', 'user.email', 'guard@example.invalid')
        for p in ['backend/ownership.json', 'tools/collaboration/check_ownership.py',
                  'tools/collaboration/setup_actor.py', '.githooks/pre-commit']:
            dst=self.repo/p; dst.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(ROOT/p,dst)
        self.write('backend/core.ts','original\n')
        self.write('apps/mobile/src/api.ts','original\n')
        self.write('apps/mobile/assets/sungho/icon.txt','original\n')
        self.git('add','--all'); self.git('commit','--quiet','-m','Fixture baseline')
        self.base=self.git('rev-parse','HEAD').stdout.strip()
        self.git('switch','-c','sungho/ui-test')
        result=self.setup('sungho');self.assertEqual(result.returncode,0,result.stderr)

    def git(self,*args,check=True):
        result=subprocess.run(['git','-C',str(self.repo),*args],env=self.env,text=True,capture_output=True)
        if check:self.assertEqual(result.returncode,0,result.stderr)
        return result

    def write(self,p,text):
        target=self.repo/p;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(text)

    def setup(self,actor):
        return subprocess.run([sys.executable,str(self.repo/'tools/collaboration/setup_actor.py'),'--actor',actor],env=self.env,text=True,capture_output=True)

    def check(self,*args):
        return subprocess.run([sys.executable,str(self.repo/'tools/collaboration/check_ownership.py'),'--actor','sungho',*args],env=self.env,text=True,capture_output=True)

    def test_ui_commit_allowed_real_hook(self):
        self.write('apps/mobile/assets/sungho/icon.txt','improved\n')
        self.git('add','--','apps/mobile/assets/sungho/icon.txt')
        self.git('commit','-m','Own UI asset')
        self.assertNotEqual(self.git('rev-parse','HEAD').stdout.strip(),self.base)

    def test_backend_and_unassigned_blocked_before_edit_check(self):
        for p in ['backend/core.ts','apps/mobile/src/api.ts','apps/mobile/src/ui.tsx',
                  'apps/mobile/package.json','.env','new-unassigned.txt']:
            with self.subTest(path=p):self.assertEqual(self.check('--paths',p).returncode,1)

    def test_allowed_symlink_cannot_edit_forbidden_target(self):
        link=self.repo/'apps/mobile/assets/sungho/link.ts'
        link.symlink_to(self.repo/'backend/core.ts')
        self.assertEqual(self.check('--paths',str(link.relative_to(self.repo))).returncode,1)

    def test_backend_actual_commit_blocked(self):
        self.write('backend/core.ts','not allowed\n');self.git('add','--','backend/core.ts')
        result=self.git('commit','-m','Forbidden backend',check=False)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('거절',result.stderr)
        self.assertEqual(self.git('rev-parse','HEAD').stdout.strip(),self.base)

    def test_policy_tampering_cannot_grant_permission(self):
        p=self.repo/'backend/ownership.json';policy=json.loads(p.read_text())
        policy['rules'].append({'path':'backend/core.ts','owner':'sungho'});p.write_text(json.dumps(policy))
        self.write('backend/core.ts','forbidden\n');self.git('add','--','backend/core.ts','backend/ownership.json')
        self.assertEqual(self.check('--staged').returncode,1)
        self.assertNotEqual(self.git('commit','-m','Tampered ownership',check=False).returncode,0)

    def test_rename_to_api_checks_destination(self):
        self.git('mv','apps/mobile/assets/sungho/icon.txt','apps/mobile/src/new-api.ts')
        self.assertEqual(self.check('--staged').returncode,1)

    def test_setup_refuses_other_actor_or_custom_hook(self):
        self.git('config','yumidang.actor','jonghyun')
        self.assertEqual(self.setup('sungho').returncode,1)
        self.assertEqual(self.git('config','yumidang.actor').stdout.strip(),'jonghyun')
        self.git('config','yumidang.actor','sungho');self.git('config','core.hooksPath','custom-hooks')
        self.assertEqual(self.setup('sungho').returncode,1)
        self.assertEqual(self.git('config','core.hooksPath').stdout.strip(),'custom-hooks')

    def test_trusted_base_diff_rejects_forbidden_head(self):
        self.write('backend/core.ts','forbidden head\n');self.git('add','--','backend/core.ts')
        tree=self.git('write-tree').stdout.strip()
        head=self.git('commit-tree',tree,'-p',self.base,'-m','Synthetic forbidden PR').stdout.strip()
        result=self.check('--diff',self.base,head)
        self.assertEqual(result.returncode,1)
        self.assertIn('backend/core.ts',result.stderr)

if __name__=='__main__':unittest.main()
