"""운영 이식 준비가 미확인 이력이나 활성화를 허용하지 않는지 검증한다."""
import sys
from pathlib import Path
import unittest
import tempfile
import hashlib
import json
import os
import subprocess
import io
from contextlib import redirect_stdout
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'tools/local'))
import prepare_production_backend as preparation
from prepare_production_backend import build_plan, inspect_product_sources, inspect_runtime_env, PreparationError, prepare_closed_artifact, verify_closed_artifact

class ProductionPreparation(unittest.TestCase):
    def setUp(self):
        self.reviewed={'backend/supabase/migrations/20260916080335_create_profiles.sql':'a'*64,
                       'backend/supabase/migrations/20261008083002_member_cleanup_ack_recovery.sql':'b'*64}
        self.remote={'migrations':[{'version':'20260916080335','name':'create_profiles'}]}
    def test_ordered_missing_migrations_never_imply_activation(self):
        result=build_plan(self.reviewed,self.remote,'ac06f86')
        self.assertEqual(result['pendingCount'],1)
        self.assertEqual(result['pending'][0]['version'],'20261008083002')
        self.assertFalse(result['activationAllowed']);self.assertFalse(result['operatingChanged'])
    def test_duplicate_unknown_or_renamed_remote_history_blocks(self):
        for entries in [self.remote['migrations']*2,[{'version':'20261008083003','name':'unknown'}],
                        [{'version':'20260916080335','name':'renamed'}],[]]:
            with self.assertRaises(PreparationError):build_plan(self.reviewed,{'migrations':entries},'ac06f86')
    def test_additional_input_is_rejected(self):
        with self.assertRaises(PreparationError):build_plan(self.reviewed,{**self.remote,'activate':True},'ac06f86')
class ProductSourcePreparation(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.repo=Path(self.temp.name).resolve()
        for name,value in {'backend/package.json':'{}','backend/package-lock.json':'{}',
                           'backend/supabase/config.toml':'project_id="test"',
                           'backend/supabase/functions/service-api/index.ts':'export {};',
                           'backend/supabase/functions/scheduled-jobs/queue-runner.mjs':'export {};',
                           'backend/supabase/functions/service-api/index 2.ts':'preserved copy'}.items():
            p=self.repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(value)
    def test_source_changes_invalidate_snapshot_including_uncommitted_product(self):
        before=inspect_product_sources(self.repo)
        (self.repo/'backend/supabase/functions/scheduled-jobs/queue-runner.mjs').write_text('export const changed=true;')
        after=inspect_product_sources(self.repo)
        self.assertNotEqual(before['sha256'],after['sha256'])
        self.assertEqual(before['mode'],'working_tree_snapshot');self.assertFalse(before['deploymentVerified'])
        self.assertEqual(len(before['excludedCopies']),1)
    def test_symlink_and_missing_artifact_are_rejected(self):
        p=self.repo/'backend/package-lock.json';p.unlink();p.symlink_to(self.repo/'backend/package.json')
        with self.assertRaises(PreparationError):inspect_product_sources(self.repo)
        p.unlink()
        with self.assertRaises(PreparationError):inspect_product_sources(self.repo)
    def test_shared_readable_secret_input_is_rejected_before_process(self):
        p=self.repo/'secret.env';p.write_text('PASSWORD=synthetic');p.chmod(0o644)
        with self.assertRaisesRegex(PreparationError,'PRIVATE_ENV_MODE_REQUIRED'):inspect_runtime_env(self.repo,p)

class ClosedArtifactPreparation(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/private/tmp');self.addCleanup(self.temp.cleanup)
        self.parent=Path(self.temp.name).resolve();self.repo=self.parent/'repo';self.repo.mkdir(mode=0o700)
        self.output=self.parent/'closed'
        self.entry=preparation.QUEUE_ENTRY
        self.document='docs/collaboration/requests/minkyu/review.md'
        self.sql='backend/supabase/migrations/20261009024414_test.sql'
        self.put('backend/package.json',json.dumps({'engines':{'node':'>=22.18.0'},'dependencies':{'pg':'8.22.0'}}))
        self.put('backend/package-lock.json',json.dumps({'packages':{'node_modules/pg':{'version':'8.22.0'}}}))
        self.put('backend/supabase/config.toml','project_id="synthetic"')
        self.put(self.entry,'export async function runQueueRunnerCli(){throw new Error("CLI_CALLED")}')
        self.put(self.document,'검토 계획이며 actual PASS가 아니다.')
        self.put(self.sql,'-- 합성 SQL 바이트. 실행하지 않는다.')
        self.reviewed={self.sql:self.digest(self.sql)}
        self.plan={'sourceHead':'synthetic-head','catalogInputSha256':{'baseline':'a'*64,'operating':'b'*64,'history':'c'*64}}
        mock=patch.object(preparation,'REVIEWED_DOCUMENTS',{self.document:self.digest(self.document)})
        mock.start();self.addCleanup(mock.stop)
    def put(self,name,text):
        p=self.repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
    def digest(self,name):return hashlib.sha256((self.repo/name).read_bytes()).hexdigest()
    def prepare(self,sources=None):
        return prepare_closed_artifact(self.repo,self.output,sources or inspect_product_sources(self.repo),self.reviewed,self.plan)
    def test_closed_scope_and_provenance_never_promote_historic_receipts(self):
        result=self.prepare();manifest=verify_closed_artifact(self.output,result['bindingSha256']);binding=manifest['binding']
        self.assertFalse(result['activationAllowed']);self.assertEqual(result['execution'],'NOT_RUN');self.assertIsNone(binding['scope'])
        self.assertEqual(binding['actualReceipts'],[]);self.assertEqual(binding['finalEvidence'],preparation.FINAL_EVIDENCE)
        self.assertEqual(binding['reviewEvidence'][0]['scope'],'REVIEWED_PLAN_ONLY');self.assertEqual(binding['reviewEvidence'][0]['actualReceipt'],'NOT_RUN')
        self.assertEqual(binding['catalogInputSha256'],self.plan['catalogInputSha256'])
        for p in self.output.rglob('*'):
            self.assertEqual(p.stat().st_mode&0o777,0o700 if p.is_dir()else 0o600)
        self.assertNotIn('approved: true',(self.output/'queue-launcher.closed.mjs').read_text())
    def test_import_and_execution_ignore_json_env_and_make_zero_cli_calls(self):
        result=self.prepare()
        script="""const m=await import(process.argv[1]);const failures=[];for(const x of [undefined,{scope:{approved:true}},{module:'pg'}])try{await m.startClosedQueue(x)}catch(e){failures.push(e.message)}process.stdout.write(JSON.stringify({failures,binding:m.bindingSha256}));"""
        env={**os.environ,'WORKER_QUEUE_APPROVED':'true','WORKER_QUEUE_MODULE':'pg','WORKER_QUEUE_ASSEMBLY':'{"approved":true}'}
        child=subprocess.run(['node','--input-type=module','-e',script,(self.output/'queue-launcher.closed.mjs').as_uri()],env=env,capture_output=True,timeout=10)
        self.assertEqual(child.returncode,0);value=json.loads(child.stdout)
        self.assertEqual(value,{'failures':['PRODUCTION_SCOPE_NOT_APPROVED']*3,'binding':result['bindingSha256']})
    def test_stale_source_sql_and_review_document_fail_before_output(self):
        for name in [self.entry,self.sql,self.document]:
            old=(self.repo/name).read_bytes();sources=inspect_product_sources(self.repo);(self.repo/name).write_bytes(old+b'\nchanged')
            with self.assertRaises(PreparationError):self.prepare(sources)
            self.assertFalse(self.output.exists());(self.repo/name).write_bytes(old)
    def test_existing_output_and_public_parent_are_rejected(self):
        self.prepare()
        with self.assertRaises(PreparationError):self.prepare()
        self.output=self.parent/'second';self.parent.chmod(0o755)
        try:
            with self.assertRaises(PreparationError):self.prepare()
        finally:self.parent.chmod(0o700)
        self.assertFalse(self.output.exists())
    def test_output_symlink_and_private_parent_alias_are_rejected(self):
        self.output.symlink_to(self.repo,target_is_directory=True)
        with self.assertRaises(PreparationError):self.prepare()
        self.output.unlink();alias=self.parent/'alias';alias.symlink_to(self.repo,target_is_directory=True)
        self.output=alias/'new'
        with self.assertRaises(PreparationError):self.prepare()
        self.assertFalse((self.repo/'new').exists())
    def test_main_keeps_default_json_contract_and_artifact_is_explicit_only(self):
        # catalog/SQL 판정의 기존 포트를 모형화한다. actual DB 성공 증거로 집계하지 않는다.
        version=Path(self.sql).name[:14]
        remote={'migrations':[{'version':version,'name':'test'}]}
        reader=lambda path,with_bytes=False: (remote if path.name=='history'else {},b'{}')
        common=['prepare_production_backend.py','--repo',str(self.repo),'--remote-history',str(self.parent/'history'),'--baseline-catalog',str(self.parent/'baseline'),'--remote-catalog',str(self.parent/'operating')]
        reports=[]
        for optional in [False,True]:
            output=self.parent/('optional.json'if optional else 'default.json')
            args=common+['--output',str(output)]+(['--closed-artifact-dir',str(self.output)]if optional else [])
            with patch.object(sys,'argv',args),patch.object(preparation.current,'inspect_current_migrations',return_value=({'source_head':'synthetic-head'},None)),patch.object(preparation.current.edge,'GATEWAY_REVIEWED_MIGRATIONS',self.reviewed),patch.object(preparation.current,'CURRENT_POLICY_REVIEWED',{}),patch.object(preparation,'read_private_catalog',reader),patch.object(preparation,'compare_catalogs',return_value={'status':'STATIC_MATCH'}),redirect_stdout(io.StringIO()):
                self.assertEqual(preparation.main(),0)
            reports.append(json.loads(output.read_text()))
            if not optional:self.assertFalse(self.output.exists())
        self.assertNotIn('closedLauncherArtifact',reports[0]);self.assertEqual(set(reports[1])-set(reports[0]),{'closedLauncherArtifact'})
        self.assertEqual({k:v for k,v in reports[1].items()if k!='closedLauncherArtifact'},reports[0])
        self.assertEqual(reports[1]['closedLauncherArtifact']['status'],'PREPARED_CLOSED_NOT_APPROVED')
    def test_missing_symlink_and_unreviewed_import_fail_before_output(self):
        sources=inspect_product_sources(self.repo)
        for text in ['import "./missing.mjs";', 'await import(process.env.MODULE);', 'await import("pg");await import("./extra.mjs");', 'import "https://evil.invalid/module.mjs";', 'import/* hidden */("./extra.mjs");','import "./es\\u0063ape.mjs";', 'import {x} from /* c */ "file:///outside/snapshot.mjs";', 'import {x} from // c\n "file:///outside/snapshot.mjs";', 'export {x} from /* c */ "file:///outside/snapshot.mjs";', 'import {x} from /* c */ "./es\\u0063ape.mjs";']:
            self.put(self.entry,text+'\nexport async function runQueueRunnerCli(){}')
            with self.assertRaises(PreparationError):self.prepare()
            self.assertFalse(self.output.exists())
        self.put(self.entry,'import "./link.mjs";\nexport async function runQueueRunnerCli(){}')
        self.put('backend/supabase/functions/scheduled-jobs/real.mjs','export {};')
        link=self.repo/'backend/supabase/functions/scheduled-jobs/link.mjs';link.symlink_to(link.with_name('real.mjs'))
        with self.assertRaises(PreparationError):self.prepare()
        self.assertFalse(self.output.exists())
    def test_native_parser_covers_commented_relative_import_and_reexport(self):
        self.put(self.entry,'import { x } from /* fixed comment */ "./dependency.mjs";\nexport { x } from // comment\n "./dependency.mjs";\nexport async function runQueueRunnerCli(){}')
        self.put('backend/supabase/functions/scheduled-jobs/dependency.mjs','export const x=1;')
        result=self.prepare();binding=verify_closed_artifact(self.output,result['bindingSha256'])['binding']
        self.assertIn('backend/supabase/functions/scheduled-jobs/dependency.mjs',binding['queueGraph']['files'])
    def test_import_words_in_normal_string_template_regex_and_comments_are_not_static_edges(self):
        self.put(self.entry,'const a="import x from file:///outside.mjs";const b=`export x from file:///outside.mjs`;const c=/import.*from/;/* import x from "file:///outside.mjs"; */\nexport async function runQueueRunnerCli(){}')
        result=self.prepare();binding=verify_closed_artifact(self.output,result['bindingSha256'])['binding']
        self.assertEqual(set(binding['queueGraph']['files']),{self.entry})
    def test_missing_named_cli_export_is_not_a_prepared_contract(self):
        self.put(self.entry,'export function stockLegacyEntry(){}')
        with self.assertRaisesRegex(PreparationError,'QUEUE_ENTRY_ABI_MISSING'):self.prepare()
        self.assertFalse(self.output.exists())
    def test_direct_launcher_entry_fails_closed_and_emits_only_fixed_error(self):
        self.prepare()
        child=subprocess.run(['node',str(self.output/'queue-launcher.closed.mjs'),'--activate','--module','pg'],env={**os.environ,'WORKER_QUEUE_APPROVED':'true'},capture_output=True,timeout=10)
        self.assertEqual(child.returncode,1);self.assertEqual(child.stdout,b'');self.assertEqual(child.stderr,b'PRODUCTION_SCOPE_NOT_APPROVED\n')
    def test_external_binding_is_required_and_self_rehash_cannot_reduce_inventory(self):
        result=self.prepare()
        with self.assertRaises(TypeError):verify_closed_artifact(self.output)
        for digest in [None,'',True,'not-a-digest']:
            with self.assertRaisesRegex(PreparationError,'EXTERNAL_BINDING_REQUIRED'):verify_closed_artifact(self.output,digest)
        manifest=json.loads((self.output/'launcher-manifest.json').read_text())
        manifest['binding']['copiedFiles'].pop(self.sql);(self.output/self.sql).unlink()
        manifest['bindingSha256']=preparation.sha256(preparation.canonical(manifest['binding']))
        launcher=preparation.closed_launcher(manifest['bindingSha256']);(self.output/'queue-launcher.closed.mjs').write_bytes(launcher)
        manifest['launcherSha256']=preparation.sha256(launcher);(self.output/'launcher-manifest.json').write_bytes(preparation.canonical(manifest))
        with self.assertRaises(PreparationError):verify_closed_artifact(self.output,result['bindingSha256'])
        # 바꾼 digest를 전달해도 strict graph/source/SQL 결합이 누락을 거절한다.
        with self.assertRaises(PreparationError):verify_closed_artifact(self.output,manifest['bindingSha256'])
    def test_strict_provenance_rejects_self_rehashed_status_and_graph_promotions(self):
        result=self.prepare();original=json.loads((self.output/'launcher-manifest.json').read_text())
        for name,value in [('execution','PASS'),('deploymentVerified',True),('operatingChanged',True),('reviewEvidence',[]),('queueGraph',{'entrypoint':self.entry,'files':{},'packages':[],'packageInstallation':'NOT_RUN'}),('extraApproval',True)]:
            manifest=json.loads(json.dumps(original));manifest['binding'][name]=value
            manifest['bindingSha256']=preparation.sha256(preparation.canonical(manifest['binding']))
            launcher=preparation.closed_launcher(manifest['bindingSha256']);(self.output/'queue-launcher.closed.mjs').write_bytes(launcher)
            manifest['launcherSha256']=preparation.sha256(launcher);(self.output/'launcher-manifest.json').write_bytes(preparation.canonical(manifest))
            with self.assertRaises(PreparationError):verify_closed_artifact(self.output,result['bindingSha256'])
            with self.assertRaises(PreparationError):verify_closed_artifact(self.output,manifest['bindingSha256'])
    def test_duplicate_json_provenance_keys_are_rejected(self):
        result=self.prepare();p=self.output/'launcher-manifest.json'
        text=p.read_text();self.assertIn('"execution":"NOT_RUN"',text)
        p.write_text(text.replace('"execution":"NOT_RUN"','"execution":"PASS","execution":"NOT_RUN"'))
        with self.assertRaises(PreparationError):verify_closed_artifact(self.output,result['bindingSha256'])
    def test_import_outside_functions_and_package_drift_are_rejected(self):
        self.put('backend/outside.mjs','export {};');self.put(self.entry,'import "../../../outside.mjs";\nexport async function runQueueRunnerCli(){}')
        with self.assertRaises(PreparationError):self.prepare()
        self.put(self.entry,'export async function runQueueRunnerCli(){}')
        self.put('backend/package.json','{"dependencies":{"pg":"latest"}}')
        with self.assertRaises(PreparationError):self.prepare()
        self.assertFalse(self.output.exists())
    def test_fixed_dynamic_runtime_is_copied_but_never_loaded_by_closed_scope(self):
        self.put(self.entry,'export async function runQueueRunnerCli(){await import("../_shared/jobs/runtime.ts");await import("pg")}')
        self.put('backend/supabase/functions/_shared/jobs/runtime.ts','throw new Error("RUNTIME_LOADED");')
        prepared=self.prepare();binding=verify_closed_artifact(self.output,prepared['bindingSha256'])['binding']
        self.assertIn('backend/supabase/functions/_shared/jobs/runtime.ts',binding['queueGraph']['files']);self.assertEqual(binding['queueGraph']['packages'],['pg'])
        script='const m=await import(process.argv[1]);try{await m.startClosedQueue()}catch(e){process.stdout.write(e.message)}'
        child=subprocess.run(['node','--input-type=module','-e',script,(self.output/'queue-launcher.closed.mjs').as_uri()],capture_output=True,timeout=10)
        self.assertEqual(child.returncode,0);self.assertEqual(child.stdout,b'PRODUCTION_SCOPE_NOT_APPROVED')
    def test_changed_artifact_extra_file_and_expected_binding_are_rejected(self):
        result=self.prepare();launcher=self.output/'queue-launcher.closed.mjs';old=launcher.read_bytes();launcher.write_bytes(old+b'\n')
        with self.assertRaises(PreparationError):verify_closed_artifact(self.output,result['bindingSha256'])
        launcher.write_bytes(old)
        with self.assertRaises(PreparationError):verify_closed_artifact(self.output,'0'*64)
        extra=self.output/'unreviewed.json';extra.write_text('{"approved":true}');extra.chmod(0o600)
        with self.assertRaises(PreparationError):verify_closed_artifact(self.output,result['bindingSha256'])
        extra.unlink();target=self.output/self.sql;target.write_text('-- changed')
        with self.assertRaises(PreparationError):verify_closed_artifact(self.output,result['bindingSha256'])
    def test_source_race_after_copy_never_returns_prepared(self):
        real=preparation.inspect_product_sources;calls=0
        def racing(repo):
            nonlocal calls
            calls+=1
            if calls==2:self.put(self.entry,'export const race=true;')
            return real(repo)
        sources=real(self.repo)
        with patch.object(preparation,'inspect_product_sources',racing):
            with self.assertRaisesRegex(PreparationError,'SOURCE_CHANGED_DURING_PREPARATION'):self.prepare(sources)
        self.assertTrue(self.output.exists())  # 실패 산출물은 덮어쓰지 않는다.
    def test_real_cli_import_and_closed_start_have_no_product_side_effects(self):
        # 실제 제품 graph의 import 효과를 검사한다. DB/환경 loader의 성공을 모형화하지 않는다.
        real=Path(__file__).resolve().parents[3]
        snapshot=inspect_product_sources(real)
        graph=preparation.queue_source_graph(real,{row['path'] for row in snapshot['files']})
        for name in graph['files']:
            self.put(name,(real/name).read_text())
        for name in ['backend/package.json','backend/package-lock.json']:
            self.put(name,(real/name).read_text())
        self.prepare()
        script="""import{registerHooks}from'node:module';
const calls={timer:0,fetch:0,productEnv:0,dbOrRuntimeImport:0};
const oldEnv=process.env,oldTimeout=globalThis.setTimeout,oldInterval=globalThis.setInterval,oldFetch=globalThis.fetch;
process.env=new Proxy(oldEnv,{get(t,k){if(typeof k==='string'&&/^(WORKER_|SUPABASE_|INTERNAL_|REVIEW_SUMMARY_|POTENS_)/.test(k))calls.productEnv++;return Reflect.get(t,k)}});
globalThis.setTimeout=globalThis.setInterval=()=>{calls.timer++;throw Error('TIMER_FORBIDDEN')};globalThis.fetch=()=>{calls.fetch++;throw Error('FETCH_FORBIDDEN')};
const hooks=registerHooks({resolve(s,c,next){if(s==='pg'||s.endsWith('/runtime.ts')){calls.dbOrRuntimeImport++;throw Error('RUNTIME_IMPORT_FORBIDDEN')}return next(s,c)}});
let code;try{const m=await import(process.argv[1]);try{await m.startClosedQueue()}catch(e){code=e.message}}finally{hooks.deregister();process.env=oldEnv;globalThis.setTimeout=oldTimeout;globalThis.setInterval=oldInterval;globalThis.fetch=oldFetch}
process.stdout.write(JSON.stringify({code,calls}));"""
        child=subprocess.run(['node','--input-type=module','-e',script,(self.output/'queue-launcher.closed.mjs').as_uri()],capture_output=True,timeout=10)
        self.assertEqual(child.returncode,0);self.assertEqual(json.loads(child.stdout),{'code':'PRODUCTION_SCOPE_NOT_APPROVED','calls':{'timer':0,'fetch':0,'productEnv':0,'dbOrRuntimeImport':0}})

if __name__=='__main__':unittest.main()
