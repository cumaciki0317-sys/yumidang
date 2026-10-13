"""서명 입력·실제 factory의 오프라인 모형 검증. Auth/DB 실제 연결 증거는 아니다."""
import ast
import base64
import copy
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
import uuid
from contextlib import ExitStack

REPO=Path(__file__).resolve().parents[3]
RUNNER=REPO/'tests/integration/jonghyun/isolated_ai_contracts.py'
spec=importlib.util.spec_from_file_location('signed_runner_test',RUNNER)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def jwt(claims):
    enc=lambda value:base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    return enc({'alg':'HS256'})+'.'+enc(claims)+'.synthetic_signature'

class BindingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='signed-binding-',dir='/private/tmp')
        self.root=Path(self.temp.name);self.root.chmod(0o700)
        self.manifest=self.root/'database-manifest.json'
        self.write(self.manifest,json.dumps({'config_overlay':{'api.port':56541}}).encode())
        self.target={'project':'jonghyun-backend100-12345678','id':'1'*64,'image':'sha256:'+'a'*64,'host':'unix:///fixed/socket'}
        origin='http://127.0.0.1:56541'
        containers={k:{'id':str(i)*64,'name':n+self.target['project'],'image':'sha256:'+'a'*64,
            'configSha256':'b'*64,'hostConfigSha256':'c'*64,'mountsSha256':'d'*64}
            for i,(k,n)in enumerate({'db':'supabase_db_','auth':'supabase_auth_','rest':'supabase_rest_','gateway':'supabase_kong_'}.items(),1)}
        accounts=[]
        for i in range(6):
            u,s=str(uuid.uuid4()),str(uuid.uuid4());email=f'synthetic-ai-{i}@example.invalid'
            accounts.append({'userId':u,'sessionId':s,'expiresAt':2000000000,'authEmail':email,
                'accessToken':jwt({'sub':u,'session_id':s,'iss':origin+'/auth/v1','role':'authenticated','exp':2000000000,'email':email,'is_anonymous':False})})
        self.value={'version':1,'kind':module.SIGNED_KIND,'preparedRoot':str(self.root),
            'databaseManifestSha256':hashlib.sha256(self.manifest.read_bytes()).hexdigest(),'origin':origin,'jwtIssuer':origin+'/auth/v1',
            'containers':containers,'credentials':{'anon':jwt({'role':'anon'}),'service':jwt({'role':'service_role'})},
            'accounts':accounts,'evidenceRoot':str(self.root/('signed-auth-'+'e'*32)),
            'sourcePins':{'fixed':'f'*64},'approvedByRoot':False,'dockerSlotReady':False}

    def tearDown(self):self.temp.cleanup()
    def write(self,path,data):
        with path.open('xb')as stream:stream.write(data)
        path.chmod(0o600)
    def validate(self,value=None):
        with patch.object(module,'signed_source_pins',return_value={'fixed':'f'*64}):
            return module.validate_signed_binding(value or self.value,self.root,self.target,now=1900000000)

    def test_valid_is_metadata_only(self):
        self.assertIs(self.validate(),self.value)
        self.assertFalse(self.value['approvedByRoot'])

    def test_mutations_fail_closed(self):
        mutations=[lambda v:v.update(version=True),lambda v:v.update(extra=True),lambda v:v.update(origin='https://outside.invalid'),
            lambda v:v.update(origin=v['origin']+'?query=1'),lambda v:v.update(jwtIssuer='http://127.0.0.1:9/auth/v1'),
            lambda v:v.update(databaseManifestSha256='0'*64),lambda v:v.update(sourcePins={}),
            lambda v:v.update(approvedByRoot=1),lambda v:v['containers']['auth'].update(id='1'*64),
            lambda v:v['containers']['db'].update(id='9'*64),lambda v:v['containers']['auth'].update(name='protected-source'),
            lambda v:v['credentials'].update(service=jwt({'role':'anon'})),lambda v:v['accounts'].pop(),
            lambda v:v['accounts'][1].update(v['accounts'][0]),lambda v:v['accounts'][0].update(expiresAt=True),
            lambda v:v['accounts'][0].update(sessionId=str(uuid.uuid4())),lambda v:v['accounts'][0].update(authEmail='real@example.com'),
            lambda v:v.update(evidenceRoot=str(self.root.parent/'outside'))]
        for mutation in mutations:
            with self.subTest(mutation=mutations.index(mutation)):
                value=copy.deepcopy(self.value);mutation(value)
                with self.assertRaises((ValueError,TypeError)):self.validate(value)

    def test_expired_and_anonymous_metadata_rejected(self):
        for delta in ({'exp':1900000000},{'is_anonymous':True},{'role':'anon'},{'sub':str(uuid.uuid4())}):
            with self.subTest(delta=delta):
                value=copy.deepcopy(self.value);claims=module.signed_claims(value['accounts'][0]['accessToken']);claims.update(delta)
                value['accounts'][0]['accessToken']=jwt(claims)
                with self.assertRaises(ValueError):self.validate(value)

    def test_private_permissions_links_and_content(self):
        private=self.root/'input.json';self.write(private,b'{"fixed":true}')
        self.assertEqual(module.signed_private_read(private),b'{"fixed":true}')
        private.chmod(0o644)
        with self.assertRaises(ValueError):module.signed_private_read(private)
        private.chmod(0o600);linked=self.root/'hardlink.json';os.link(private,linked)
        with self.assertRaises(ValueError):module.signed_private_read(private)
        linked.unlink();link=self.root/'symlink.json';link.symlink_to(private)
        with self.assertRaises(ValueError):module.signed_private_read(link)

    def test_private_open_fd_change_detected(self):
        private=self.root/'changing.json';self.write(private,b'{}');original=os.fstat;calls=0
        def changed(fd):
            nonlocal calls
            calls+=1
            if calls==2:
                with private.open('ab')as stream:stream.write(b' ')
            return original(fd)
        with patch.object(module.os,'fstat',side_effect=changed):
            with self.assertRaisesRegex(ValueError,'SIGNED_PRIVATE_CHANGED'):module.signed_private_read(private)

    def test_private_path_replaced_after_fd_read_detected(self):
        private=self.root/'replaced.json';self.write(private,b'{}');original=os.fstat;calls=0
        def replaced(fd):
            nonlocal calls
            calls+=1
            if calls==2:private.unlink();self.write(private,b'{}')
            return original(fd)
        with patch.object(module.os,'fstat',side_effect=replaced):
            with self.assertRaisesRegex(ValueError,'SIGNED_PRIVATE_CHANGED'):module.signed_private_read(private)

    def test_duplicate_json_keys_and_constants_rejected(self):
        for raw in ('{"kind":"first","kind":"second"}','{"nested":{"role":"anon","role":"authenticated"}}','{"value":NaN}'):
            with self.subTest(raw=raw),self.assertRaises(ValueError):module.signed_exact_json(raw)
        self.assertEqual(module.signed_exact_json('{"one":1}'),{'one':1})
        payload=base64.urlsafe_b64encode(b'{"role":"anon","role":"authenticated"}').decode().rstrip('=')
        with self.assertRaises(ValueError):module.signed_claims('header.'+payload+'.signature')

    def midnight_runner(self):
        evidence=self.root/'midnight-evidence';evidence.mkdir(mode=0o700)
        with patch.object(module,'signed_prepared_target',return_value=self.target),patch.object(module,'signed_source_pins',return_value={'fixed':'f'*64}):
            return module.SignedMidnightRunner(self.root,self.value,[a['userId']for a in self.value['accounts'][:3]],evidence,'scope-fixed',2000000000)

    def test_midnight_explicit_scope_default_closed(self):
        runner=self.midnight_runner()
        self.assertEqual(runner.all_users,[a['userId']for a in self.value['accounts'][:3]])
        with patch.object(runner,'signed_identity',side_effect=AssertionError('resource called')):
            with self.assertRaisesRegex(ValueError,'SIGNED_APPROVAL_SLOT_REQUIRED'):runner.validate_original_accounts()
        with self.assertRaisesRegex(ValueError,'MIDNIGHT_ACTIVATION_REQUIRED'):runner.prepare_units()

    def test_midnight_body_exact_existing_function(self):
        source=(REPO/'tests/integration/minkyu/content_inspection_http_local.ts').read_text()
        copied=(REPO/'tests/integration/jonghyun/isolated_ai_factory.ts').read_text()
        start='async function aiMidnightHttpCase('
        body=source[source.index(start):source.index('\n/** 합성 사용량',source.index(start))]
        self.assertIn(body,copied);self.assertEqual(copied.count(start),1)

    def test_midnight_read_timeout_is_one_end_to_end_call(self):
        runner=self.midnight_runner();runner.base=['docker','--host','unix:///fixed/socket']
        with patch.object(runner,'identity',side_effect=AssertionError('slow nested identity')),patch.object(module.subprocess,'run')as run:
            run.return_value=subprocess.CompletedProcess([],0,'proof','')
            self.assertEqual(runner.read_sql('select 1;',timeout=.75),'proof')
            self.assertEqual(run.call_args.kwargs['timeout'],.75)
            self.assertIn("statement_timeout='375ms'",run.call_args.kwargs['input']);self.assertIn('begin read only;',run.call_args.kwargs['input'])
            self.assertIn(self.target['id'],run.call_args.args[0]);self.assertEqual(run.call_count,1)
        for query in ('commit;update private.ai_processing_guard set external_processing_allowed=true;','select 1;commit;','\\! command','select 1 -- comment'):
            with self.subTest(query=query),patch.object(module.subprocess,'run',side_effect=AssertionError('resource called')):
                with self.assertRaises(ValueError):runner.read_sql(query,timeout=.75)

    def test_midnight_created_metadata_failure_closes_exact_child(self):
        runner=self.midnight_runner();fixture=dict(runner.fixture)
        with patch.object(runner,'validate_original_accounts',return_value=[]),patch.object(runner,'save_signed')as save,patch.object(module.subprocess,'Popen')as popen:
            child=popen.return_value;child.pid=42;child.poll.side_effect=[None,0];child.returncode=0;child.communicate.return_value=(b'',b'')
            save.side_effect=lambda name,value:(_ for _ in()).throw(OSError('fixed'))if name.endswith('-created.json')else None
            with self.assertRaises(OSError):runner.start_factory(fixture,'prepare-limits')
            child.terminate.assert_called_once();child.kill.assert_not_called();self.assertEqual(len(runner.children),1)

    def test_midnight_cleanup_continues_after_one_child_failure(self):
        runner=self.midnight_runner();runner.children=[{'phase':'one'},{'phase':'two'}];seen=[]
        def cancel(handle):
            seen.append(handle['phase'])
            if handle['phase']=='one':raise RuntimeError('fixed')
            return {'exited':True,'pid':42}
        with patch.object(runner,'cancel_factory',side_effect=cancel),patch.object(runner,'clean')as clean:
            with self.assertRaisesRegex(ValueError,'MIDNIGHT_CLEANUP_FAILED'):runner.cleanup_owned()
            clean.assert_called_once()
        self.assertEqual(seen,['one','two']);proof=json.loads((runner.evidence/'midnight-cleanup.json').read_bytes())
        self.assertEqual(proof['status'],'FAIL');self.assertFalse(proof['containerLifecycleMutation'])

    def midnight_original_state(self,runner):
        runner.changed=True
        runner.accounts=[{'account_id':a,'account_order':n,'registered':False,'unit_limit':3200000}
            for n,a in enumerate(('yumi','jonghyun','minkyu','sungho'),1)]
        runner.baseline='a'*32;runner.catalog='b'*32+'\n'+'c'*32
        runner.protected={t:{'d'*32:'d'*32}for t in module.PROTECTED_BUDGET}
        runner.snapshot_original_rows={'private.'+t:{}for t in module.PROTECTED_BUDGET}
        hashed={t:hashlib.sha256(b'{}').hexdigest()for t in runner.snapshot_original_rows}
        runner.fixture_baseline={'rows':hashed,'catalogSha256':'e'*64,'rolesAclSha256':'f'*64,
            'unknownRows':{'private.'+t:hashed['private.'+t]for t in module.PROTECTED_BUDGET[1:3]},'sequence':'NOT_VERIFIED','physical':'NOT_VERIFIED'}
        return runner.export_resume_state()

    def test_midnight_partial_activation_state_hydrates_without_resources(self):
        runner=self.midnight_runner();state=self.midnight_original_state(runner)
        runner.changed=False;del runner.accounts
        with patch.object(module.subprocess,'run',side_effect=AssertionError('resource call')):
            restored=runner.restore_resume_state(state)
        self.assertEqual(restored['resourceCalls'],0);self.assertTrue(runner.changed)
        self.assertEqual([a['registered']for a in runner.accounts],[False]*4)
        self.assertFalse(runner.prepared_units_complete)
        with self.assertRaisesRegex(ValueError,'PREPARE_REPLAY_FORBIDDEN'):runner.activate_fixture_registration()
        with patch.object(runner,'clean')as clean:
            result=runner.cleanup_owned();clean.assert_called_once()
        self.assertEqual(result['originalUnknownRows'],'NOT_RUN')
        self.assertEqual(runner.all_users,runner.users)

    def test_midnight_resume_state_mutations_do_not_change_memory(self):
        runner=self.midnight_runner();state=self.midnight_original_state(runner);runner.changed=False
        from datetime import datetime,timedelta,timezone
        next_day=datetime.fromtimestamp(runner.boundary_epoch,timezone(timedelta(hours=9))).date()
        state['fixtureMetadata'].update(aiMidnightScenario=True,midnightDir=str(runner.evidence),midnightEpoch=runner.boundary_epoch,
            originalDay=str(next_day-timedelta(days=1)),nextDay=str(next_day))
        mutations=[lambda s:s.update(scopeId='different'),lambda s:s.update(version=True),
            lambda s:s['target'].update(id='9'*64),lambda s:s.update(bindingCanonicalSha256='0'*64),
            lambda s:s['accounts'][0].update(unit_limit=1),lambda s:s['accounts'][0].update(registered=1),
            lambda s:s['fixtureBaseline']['unknownRows'].update({'private.ai_budget_reservations':'0'*64}),
            lambda s:s['originalRows']['private.'+module.PROTECTED_BUDGET[0]].update({'a'*64:1}),
            lambda s:s['fixtureMetadata'].update(originalDay='2000-01-01'),
            lambda s:s['fixtureMetadata'].update(nextDay='2000-01-02'),lambda s:s['fixtureMetadata'].update(aiMidnightScenario=1),
            lambda s:s['fixtureMetadata'].pop('originalDay'),lambda s:s.update(preparedUnitsComplete=True)]
        for mutation in mutations:
            with self.subTest(mutation=mutations.index(mutation)):
                value=copy.deepcopy(state);mutation(value)
                with patch.object(module.subprocess,'run',side_effect=AssertionError('resource call')):
                    with self.assertRaises((ValueError,TypeError)):runner.restore_resume_state(value)
                self.assertFalse(runner.changed);self.assertFalse(getattr(runner,'resumed_state',False))

    def test_midnight_prepared_unknown_resume_provenance(self):
        runner=self.midnight_runner();self.midnight_original_state(runner)
        from datetime import datetime,timedelta,timezone
        next_day=datetime.fromtimestamp(runner.boundary_epoch,timezone(timedelta(hours=9))).date()
        ledger='signed-midnight-'+runner.scope_id;identifier=str(uuid.uuid4());runner.ledgers=[ledger]
        rows={'ai_budget_reservations':json.dumps({'id':identifier,'ledger_id':ledger}),
            'ai_account_budget_reservations':json.dumps({'reservation_id':identifier,'ledger_id':ledger,'unknown_at':'synthetic','settled_at':None})}
        runner.midnight_unknown=(identifier,rows);runner.prepared_units_complete=True
        runner.prepare_creation_receipts=[{'table':'ai_account_budget_reservations','id':identifier,'scopeId':runner.scope_id}]
        runner.fixture.update(aiMidnightScenario=True,aiLedgerId=ledger,midnightDir=str(runner.evidence),midnightEpoch=runner.boundary_epoch,
            originalDay=str(next_day-timedelta(days=1)),nextDay=str(next_day))
        state=runner.export_resume_state();runner.changed=False
        bad=copy.deepcopy(state);bad['unknown'][1]['ai_account_budget_reservations']=json.dumps({'reservation_id':identifier,'ledger_id':'other','unknown_at':'synthetic','settled_at':None})
        with self.assertRaisesRegex(ValueError,'UNKNOWN_PROVENANCE'):runner.restore_resume_state(bad)
        self.assertFalse(runner.changed)
        runner.restore_resume_state(state)
        self.assertEqual(runner.midnight_unknown,(identifier,rows))
        with patch.object(runner,'unknown_rows',return_value=rows):self.assertEqual(len(runner.fixture_unknown_rows()),2)
        with patch.object(runner,'unknown_rows',return_value={**rows,'ai_budget_reservations':'{}'}),patch.object(runner,'clean')as clean:
            with self.assertRaisesRegex(ValueError,'MIDNIGHT_CLEANUP_FAILED'):runner.cleanup_owned()
            clean.assert_called_once()

    def test_midnight_activation_durable_state_before_ambiguous_update(self):
        runner=self.midnight_runner();self.midnight_original_state(runner);runner.changed=False
        runner.target['versions']=['fixed'];original=runner.export_resume_state();events=[]
        def sql(query):
            if query.startswith('begin;do '):
                guard=query.index("raise exception 'MIDNIGHT_ACTIVATION_TX_WINDOW'")
                self.assertLess(query.index('clock_timestamp()'),guard)
                self.assertLess(guard,query.index('update private.ai_budget_accounts'))
                self.assertLess(guard,query.index('update private.ai_processing_guard'))
                self.assertIn(str(runner.boundary_epoch)+"-extract(epoch from observed)not between 600 and 3600",query)
                self.assertIn("using errcode='55000'",query)
                self.assertIn("at time zone'Asia/Seoul'",query)
                self.assertTrue(query.endswith('commit;'))
                saved=module.signed_exact_json((runner.evidence/'midnight-activation-resume-state-private.json').read_bytes())
                self.assertTrue(saved['changed']);self.assertEqual(saved['accounts'],original['accounts'])
                self.assertEqual(saved['originalRows'],original['originalRows']);self.assertIsNone(saved['unknown'])
                events.append('attempted-update');raise subprocess.TimeoutExpired('fixed',2)
            if 'schema_migrations'in query:return '["fixed"]'
            if 'current_setting'in query:return 'f\noff'
            if 'json_agg(to_jsonb(a)'in query:return json.dumps(original['accounts'])
            if 'pg_proc'in query:return original['catalog']
            return '0'
        clock=json.dumps({'epoch':runner.boundary_epoch-900,'midnightEpoch':runner.boundary_epoch})
        with patch.object(runner,'validate_original_accounts',return_value=[]),patch.object(runner,'read_sql',return_value=clock),\
                patch.object(runner,'snapshot',return_value=original['fixtureBaseline']),patch.object(runner,'digest',return_value=original['baseline']),\
                patch.object(runner,'protected_rows',return_value=original['protected']),patch.object(runner,'sql',side_effect=sql):
            with self.assertRaises(subprocess.TimeoutExpired):runner.activate_fixture_registration()
        self.assertEqual(events,['attempted-update']);self.assertTrue(runner.changed)
        saved=module.signed_exact_json((runner.evidence/'midnight-activation-resume-state-private.json').read_bytes())
        runner.changed=False;runner.restore_resume_state(saved);self.assertTrue(runner.changed)

    def test_midnight_activation_refresh_rejects_late_window_before_update(self):
        runner=self.midnight_runner();state=self.midnight_original_state(runner);runner.changed=False;runner.target['versions']=['fixed']
        calls=[]
        def sql(query):
            calls.append(query)
            if 'schema_migrations'in query:return '["fixed"]'
            if 'current_setting'in query:return 'f\noff'
            if 'json_agg(to_jsonb(a)'in query:return json.dumps(state['accounts'])
            if 'pg_proc'in query:return state['catalog']
            return '0'
        clocks=[json.dumps({'epoch':runner.boundary_epoch-900,'midnightEpoch':runner.boundary_epoch}),
            json.dumps({'epoch':runner.boundary_epoch-500,'midnightEpoch':runner.boundary_epoch})]
        with patch.object(runner,'validate_original_accounts',return_value=[]),patch.object(runner,'read_sql',side_effect=clocks),\
                patch.object(runner,'snapshot',return_value=state['fixtureBaseline']),patch.object(runner,'digest',return_value=state['baseline']),\
                patch.object(runner,'protected_rows',return_value=state['protected']),patch.object(runner,'sql',side_effect=sql):
            with self.assertRaisesRegex(ValueError,'PRE_MUTATION_WINDOW_EXPIRED'):runner.activate_fixture_registration()
        self.assertFalse(runner.changed);self.assertFalse(any(q.startswith('begin;do ')for q in calls))
        self.assertFalse((runner.evidence/'midnight-activation-resume-state-private.json').exists())

    def test_midnight_held_warm_capability_no_slow_auth_in_window(self):
        runner=self.midnight_runner();runner.changed=True;runner.prepared_units_complete=True;runner.midnight_unknown=('fixed',{})
        key='tests/integration/jonghyun/isolated_ai_factory.ts';pins={key:hashlib.sha256((REPO/key).read_bytes()).hexdigest()}
        runner.binding['sourcePins']=pins
        fixture={**runner.fixture,'aiMidnightScenario':True,'midnightPhase':'held','midnightDir':str(runner.evidence),'midnightEpoch':runner.boundary_epoch}
        with patch.object(runner,'validate_original_accounts',return_value=[]),patch.object(module,'signed_source_pins',return_value=pins):
            capability=runner.warm_factory(fixture)
        with patch.object(runner,'validate_original_accounts',side_effect=AssertionError('slow auth in held window')),patch.object(module.subprocess,'Popen')as popen:
            popen.return_value.pid=42
            handle=runner.start_factory(fixture,'held',capability)
            self.assertEqual(handle['phase'],'held');self.assertEqual(popen.call_count,1)
            with self.assertRaisesRegex(ValueError,'HELD_NOT_WARMED'):runner.start_factory(fixture,'held',capability)

    def test_midnight_held_stale_or_rebound_capability_launches_zero(self):
        runner=self.midnight_runner();runner.changed=True;runner.prepared_units_complete=True;runner.midnight_unknown=('fixed',{})
        key='tests/integration/jonghyun/isolated_ai_factory.ts';pins={key:hashlib.sha256((REPO/key).read_bytes()).hexdigest()};runner.binding['sourcePins']=pins
        fixture={**runner.fixture,'aiMidnightScenario':True,'midnightPhase':'held','midnightDir':str(runner.evidence),'midnightEpoch':runner.boundary_epoch}
        for case in ('stale','copied','target','source'):
            with self.subTest(case=case),patch.object(runner,'validate_original_accounts',return_value=[]),patch.object(module,'signed_source_pins',return_value=pins):
                capability=runner.warm_factory(fixture)
                if case=='stale':runner.held_warm_time-=61
                if case=='copied':capability=dict(capability)
                if case=='target':runner.target={**runner.target,'id':'9'*64}
                if case=='source':runner.held_warm_sources[key]=(0,0,0,0,0)
                with patch.object(module.subprocess,'Popen',side_effect=AssertionError('child launched')):
                    with self.assertRaisesRegex(ValueError,'HELD_'):runner.start_factory(fixture,'held',capability)

    def test_inspect_binds_original_bytes_not_sanitized_metadata(self):
        private=self.root/'binding.json';data=json.dumps(self.value,indent=2).encode();self.write(private,data)
        with patch.object(module,'signed_prepared_target',return_value=self.target),patch.object(module,'signed_source_pins',return_value={'fixed':'f'*64}):
            result=module.inspect_signed_binding(private,self.root)
        self.assertEqual(result['bindingSha256'],hashlib.sha256(data).hexdigest())
        self.assertFalse(result['executionAllowed']);self.assertEqual(result['actualAuth'],'NOT_RUN')
        public=json.dumps(result)
        for account in self.value['accounts']:self.assertNotIn(account['accessToken'],public);self.assertNotIn(account['authEmail'],public)

    def test_missing_input_both_aliases_zero_calls(self):
        for flag in ('--signed-auth','--signed-local-auth'):
            with patch.object(sys,'argv',['runner',flag,'--prepared-root',str(self.root),'--run']),patch.object(module,'signed_prepared_target',side_effect=AssertionError('resource called')),patch('builtins.print')as output:
                module.signed_main()
            result=json.loads(output.call_args[0][0]);self.assertEqual(result['status'],'NOT_RUN');self.assertEqual(result['actualCalls'],0)

    def prepared_inputs(self,context):
        from prepare_database import isolated_config
        source=(REPO/'backend/supabase/config.toml').read_bytes()
        config,overlay=isolated_config(source,self.target['project'],56541)
        (self.root/'supabase').mkdir(mode=0o700);(self.root/'supabase/migrations').mkdir(mode=0o700)
        self.write(self.root/'supabase/config.toml',config)
        manifest={'config_overlay':overlay,'config_sha256':hashlib.sha256(config).hexdigest(),
            'source_config_sha256':hashlib.sha256(source).hexdigest(),'sql_execution':'NOT_RUN','migrations':[]}
        self.manifest.unlink();self.write(self.manifest,json.dumps(manifest).encode())
        profile={'colima-yumidang-minkyu':'yumidang-minkyu','colima-jonghyun-backend100':'jonghyun-backend100'}[context]
        intent={'context':context,'dockerHost':'unix://'+str(Path.home()/'.colima'/profile/'docker.sock'),
            'project':self.target['project'],'scope':'new-synthetic-only','existingContainers':[],'existingNetworks':[]}
        self.write(self.root/'execution-intent.json',json.dumps(intent).encode())
        self.write(self.root/'owned-containers.json',json.dumps([{'id':self.target['id'],'image':self.target['image'],'name':'supabase_db_'+self.target['project']}]).encode())
        return intent

    def test_m_prepared_target_does_not_change_j_helper(self):
        self.prepared_inputs('colima-yumidang-minkyu')
        with patch('prepare_migrations.inspect_migrations',return_value={'migrations':[]}),patch.object(module,'isolated_prepared_target',side_effect=AssertionError('old helper called')):
            target=module.signed_prepared_target(self.root)
        self.assertEqual(target['context'],'colima-yumidang-minkyu');self.assertEqual(target['id'],self.target['id'])

    def test_prepared_socket_and_scope_cannot_be_retargeted(self):
        intent=self.prepared_inputs('colima-yumidang-minkyu');path=self.root/'execution-intent.json'
        for changes in ({'dockerHost':'unix:///outside/docker.sock'},{'context':'colima-other'},{'scope':'operating'},{'existingContainers':['protected-id']}):
            with self.subTest(changes=changes),patch('prepare_migrations.inspect_migrations',return_value={'migrations':[]}):
                path.unlink();self.write(path,json.dumps({**intent,**changes}).encode())
                with self.assertRaises(ValueError):module.signed_prepared_target(self.root)

    def cleanup_runner(self):
        runner=module.SignedRunner.__new__(module.SignedRunner)
        runner.changed=True;runner.all_users=[a['userId']for a in self.value['accounts']]
        runner.accounts=[{'account_id':a,'registered':False}for a in ('yumi','jonghyun','minkyu','sungho')]
        runner.evidence=Path(self.value['evidenceRoot']);runner.evidence.mkdir(mode=0o700)
        runner.baseline='baseline';runner.catalog='catalog';runner.protected={t:{'whole-old-row':'whole-old-row'}for t in module.PROTECTED_BUDGET}
        runner.protected_rows=lambda:copy.deepcopy(runner.protected);runner.digest=lambda:'baseline';runner.signed_identity=lambda:None
        return runner

    def test_cleanup_independent_after_guard_failure_and_no_auth_delete(self):
        runner=self.cleanup_runner();calls=[]
        def sql(statement):
            calls.append(statement)
            if statement.startswith('update private.ai_processing_guard'):raise RuntimeError('fixed-error')
            return 'catalog'
        runner.sql=sql
        with self.assertRaisesRegex(ValueError,'SIGNED_CLEANUP_FAILED'):runner.clean()
        self.assertEqual(sum('set registered='in s for s in calls),4)
        self.assertTrue(any('delete from private.ai_chat_requests'in s for s in calls))
        self.assertFalse(any('delete from auth.'in s or 'delete from public.profiles'in s for s in calls))
        result=json.loads((runner.evidence/'cleanup.json').read_bytes());self.assertEqual(result['status'],'FAIL')
        self.assertEqual(result['sequence'],'NOT_VERIFIED')

    def test_cleanup_whole_original_unknown_mutation_rejects(self):
        runner=self.cleanup_runner();runner.sql=lambda statement:'catalog'
        changed=copy.deepcopy(runner.protected);changed['ai_account_budget_reservations']={}
        runner.protected_rows=lambda:changed
        with self.assertRaisesRegex(ValueError,'SIGNED_CLEANUP_FAILED'):runner.clean()
        result=json.loads((runner.evidence/'cleanup.json').read_bytes())
        self.assertFalse(result['originalProtectedRowsPreserved']);self.assertEqual(result['protectedBudgetDelta'],'COMMITTED_NOT_ROLLED_BACK')

    def assert_original_python_preserved(self,before,after):
        before=copy.deepcopy(before)
        original_paths=('tests/integration/jonghyun/isolated_ai_contracts.py','tests/integration/jonghyun/isolated_ai_factory.ts',
            'tools/local/run_database_tests.py','tools/local/prepare_database.py','tools/local/prepare_migrations.py')
        additions=('tests/integration/minkyu/product_connection_restore108_local.py','tests/integration/minkyu/member_cleanup_reconcile_local.py')
        history=ast.parse("if json.loads(self.sql('select json_agg(version order by version)from supabase_migrations.schema_migrations;'))!=self.target['versions']:\n raise ValueError('APPLIED_HISTORY_CHANGED')").body[0]
        replacement=ast.parse('signed_verify_history(self)').body[0]
        old_negative=ast.parse("proof.append({'scenario':'SIGNED_AUTH_NEGATIVE','cases':negative['cases']})").body[0]
        new_negative=ast.parse('proof.append(signed_negative_receipt(negative))').body[0]
        dump=lambda node:ast.dump(node,include_attributes=False)
        for node in before.body:
            if isinstance(node,ast.FunctionDef)and node.name=='run_signed_auth_lifecycle':
                old_gate=ast.parse("if reviewed.binding_path!=root/'signed-ai-binding-private.json' or reviewed.input_path!=root/('auth-lifecycle-input-'+value['scopeId']+'.json'):\n raise ValueError('LIFECYCLE_REVIEWED_PRIVATE_PATH')").body[0]
                new_gate=ast.parse('validate_lifecycle_reviewed_paths(reviewed,value)').body[0]
                matches=[i for i,n in enumerate(node.body)if dump(n)==dump(old_gate)]
                if matches:
                    self.assertEqual(len(matches),1);node.body[matches[0]]=copy.deepcopy(new_gate)
                else:self.assertEqual(sum(dump(n)==dump(new_gate)for n in node.body),1)
                capsule_attach=ast.parse("authority=getattr(reviewed,'dispatch_authority',None)\nif type(authority)is ReviewedLifecycleDispatch:\n lifecycle_dispatch_capsule(authority);r.dispatch_authority=authority").body
                if not any(dump(n)==dump(capsule_attach[0])for n in node.body):
                    at=[i for i,n in enumerate(node.body)if dump(n)==dump(ast.parse('r.reviewed_head=source_head').body[0])]
                    self.assertEqual(len(at),1);node.body[at[0]+1:at[0]+1]=copy.deepcopy(capsule_attach)
            if isinstance(node,ast.ClassDef)and node.name=='SignedAuthLifecycleRunner':
                method=next(n for n in node.body if isinstance(n,ast.FunctionDef)and n.name=='invoke_case')
                override=ast.parse('code_root,factory_path=lifecycle_runner_factory_paths(self)').body[0]
                if not any(dump(n)==dump(override)for n in method.body):
                    fixture=next(n for n in method.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='fixture'for t in n.targets))
                    i=next(i for i,k in enumerate(fixture.value.keys)if isinstance(k,ast.Constant)and k.value=='codeRoot')
                    self.assertEqual(dump(fixture.value.values[i]),dump(ast.parse('str(REPO)',mode='eval').body))
                    fixture.value.values[i]=ast.parse('str(code_root)',mode='eval').body
                    method.body.insert(method.body.index(fixture),copy.deepcopy(override))
                    argv=next(n for n in method.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='argv'for t in n.targets))
                    self.assertEqual(dump(argv.value.elts[2]),dump(ast.parse("str(Path(__file__).with_name('isolated_ai_factory.ts'))",mode='eval').body))
                    argv.value.elts[2]=ast.parse('str(factory_path)',mode='eval').body
                    cleanup=next(n for n in method.body if isinstance(n,ast.Try))
                    old_save=cleanup.finalbody.pop()
                    self.assertIsInstance(old_save,ast.Expr)
                    cleanup.finalbody.append(ast.Try(body=[old_save],handlers=[],orelse=[],finalbody=ast.parse('lifecycle_runner_factory_paths(self)').body))
            if isinstance(node,ast.FunctionDef)and node.name=='signed_main':
                class NegativeReceipt(ast.NodeTransformer):
                    def visit_Expr(inner,expression):
                        return copy.deepcopy(new_negative)if dump(expression)==dump(old_negative)else inner.generic_visit(expression)
                node=NegativeReceipt().visit(node)
            if isinstance(node,ast.FunctionDef)and node.name=='signed_source_pins':
                assignments=[n for n in node.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='paths'for t in n.targets)]
                self.assertEqual(len(assignments),1)
                paths=ast.literal_eval(assignments[0].value)
                self.assertIn(paths,(original_paths,original_paths+additions))
                if paths==original_paths:assignments[0].value=ast.parse(repr(original_paths+additions),mode='eval').body
            if isinstance(node,ast.ClassDef)and node.name in ('SignedRunner','SignedMidnightRunner'):
                name='prepare'if node.name=='SignedRunner'else'activate_fixture_registration'
                method=next(n for n in node.body if isinstance(n,ast.FunctionDef)and n.name==name)
                matching=[i for i,n in enumerate(method.body)if dump(n)==dump(history)]
                if matching:
                    self.assertEqual(len(matching),1);method.body[matching[0]]=copy.deepcopy(replacement)
                else:self.assertEqual(sum(dump(n)==dump(replacement)for n in method.body),1)
        # AI24의 승인된 typed overlay만 정확한 AST로 확인한 뒤 제거한다.
        # 나머지 전체 클래스/메서드는 기존 canonical 본문과 계속 동일해야 한다.
        before=copy.deepcopy(before);after=copy.deepcopy(after)
        approved={'warm': "if getattr(self, 'midnight_custody', None) is not None:\n    self.held_custody = self.midnight_custody.descriptor()\n    self.held_custody_signatures = midnight_warm_signatures(self)", 'held': "if getattr(self, 'midnight_custody', None) is not None:\n    midnight_warm_recheck(self)", 'cancel': "if handle.get('typedCustody'):\n    try:\n        self.midnight_terminate(process)\n        if process.poll() is None:\n            raise ValueError('MIDNIGHT_CHILD_EXIT_UNPROVEN')\n    finally:\n        midnight_custody_proof(self)\n    return {'exited': True, 'pid': process.pid, 'exitCode': process.returncode, 'ownedGroupClosed': True, 'sourceCustody': 'SEALED_PIN_RECHECKED'}", 'restore': "if getattr(self, 'midnight_custody', None) is not None:\n    if not isinstance(value, dict) or value.get('sourceCustody') != current['sourceCustody'] or value.get('sourceCustodySha256') != current['sourceCustodySha256']:\n        raise ValueError('MIDNIGHT_RESUME_CUSTODY_BINDING')\n    midnight_custody_proof(self)", 'export': "{'sourceCustody': self.midnight_custody.descriptor(), 'sourceCustodySha256': hashlib.sha256(self.midnight_custody._data.encode()).hexdigest()} if getattr(self, 'midnight_custody', None) is not None else {}"}
        additions={'typed': "typed = getattr(self, 'midnight_custody', None)", 'node': "node = str(typed.node_path) if typed is not None else shutil.which('node')", 'factory': "factory = Path(typed.descriptor()['capsuleRoot']) / 'tests/integration/jonghyun/isolated_ai_factory.ts' if typed is not None else Path(__file__).with_name('isolated_ai_factory.ts')", 'command': "command = [node, '--experimental-strip-types', str(factory), str(self.evidence / filename), mode]", 'options': "options = {'env': midnight_minimal_env(self.evidence), 'cwd': str(self.evidence), 'start_new_session': True} if typed is not None else {}", 'popen': 'process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options)', 'handle': "handle = {'process': process, 'phase': phase, 'fixture': fixture, 'typedCustody': typed is not None}"}
        def exact_remove(body,source):
            wanted=ast.parse(source).body
            self.assertEqual(len(wanted),1)
            matches=[i for i,n in enumerate(body)if dump(n)==dump(wanted[0])]
            self.assertEqual(len(matches),1,source)
            return body.pop(matches[0])
        for revision in (before,after):
            for candidate in revision.body:
                if isinstance(candidate,ast.ClassDef)and candidate.name=='SignedMidnightRunner':
                    methods={n.name:n for n in candidate.body if isinstance(n,ast.FunctionDef)}
                    if not any(isinstance(n,ast.Name)and n.id=='midnight_warm_signatures'for n in ast.walk(methods['warm_factory'])):continue
                    # 새 method를 무시하지 않으며 원 method 집합이 그대로여야 한다.
                    oldclass=next(n for n in before.body if isinstance(n,ast.ClassDef)and n.name==candidate.name)
                    self.assertEqual(set(methods),{n.name for n in oldclass.body if isinstance(n,ast.FunctionDef)})
                    exact_remove(methods['warm_factory'].body,approved['warm'])
                    exact_remove(methods['cancel_factory'].body,approved['cancel'])
                    exact_remove(methods['restore_resume_state'].body,approved['restore'])
                    result=methods['export_resume_state'].body[-1].value
                    self.assertIsNone(result.keys[-1]);self.assertEqual(dump(result.values[-1]),dump(ast.parse(approved['export'],mode='eval').body))
                    result.keys.pop();result.values.pop()
                    start=methods['start_factory']
                    held=next(n for n in start.body if isinstance(n,ast.If)and dump(n.test)==dump(ast.parse("phase=='held'",mode='eval').body))
                    exact_remove(held.body,approved['held'])
                    self.assertEqual(dump(held.orelse[0]),dump(ast.parse('midnight_custody_proof(self)').body[0]));held.orelse.pop(0)
                    replacements={
                        'node':"node=shutil.which('node')",
                        'command':"command=[node,'--experimental-strip-types',str(Path(__file__).with_name('isolated_ai_factory.ts')),str(self.evidence/filename),mode]",
                        'popen':"process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)",
                        'handle':"handle={'process':process,'phase':phase,'fixture':fixture}",
                    }
                    for name in ('typed','factory','options'):exact_remove(start.body,additions[name])
                    for name,original in replacements.items():
                        old=exact_remove(start.body,additions[name])
                        # 원문 위치도 보존한다. canonical 흐름에서 statement를 재배치하지 않는다.
                        assignment=ast.parse(original).body[0]
                        target=assignment.targets[0].id
                        anchors={'node':'filename','command':'mode','process':'command','handle':'process'}
                        anchor=anchors[target]
                        at=next(i for i,n in enumerate(start.body)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id==anchor for t in n.targets))
                        if target=='node':at+=1 # filename 다음 save()도 원 순서로 유지
                        if target=='process':at+=1 # command 다음 intent도 원 순서로 유지
                        start.body.insert(at+1,assignment)
        for candidate in after.body:
            if isinstance(candidate,ast.FunctionDef)and candidate.name=='lifecycle_dispatch_capsule'and any(isinstance(n,ast.FunctionDef)and n.name==candidate.name for n in before.body):
                original=next(n for n in before.body if isinstance(n,ast.FunctionDef)and n.name==candidate.name)
                cutoffs=[i for i,n in enumerate(original.body)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='expected_directories'for t in n.targets)]
                if not cutoffs:
                    self.assertEqual(dump(candidate),dump(original));continue
                self.assertEqual(len(cutoffs),1);cutoff=cutoffs[0]
                self.assertEqual(dump(ast.Module(body=candidate.body,type_ignores=[])),dump(ast.Module(body=original.body[:cutoff]+ast.parse('return sealed_runtime_capsule(reviewed.source_head,root,pins,expected)').body,type_ignores=[])))
                shared=next(n for n in after.body if isinstance(n,ast.FunctionDef)and n.name=='sealed_runtime_capsule')
                class GenericHead(ast.NodeTransformer):
                    def visit_Attribute(inner,n):
                        return ast.Name(id='source_head',ctx=ast.Load())if dump(n)==dump(ast.parse('reviewed.source_head',mode='eval').body)else inner.generic_visit(n)
                tail=GenericHead().visit(ast.Module(body=copy.deepcopy(original.body[cutoff:]),type_ignores=[])).body
                prefix=ast.parse('"""Lifecycle와 AI24가 같은 source-only reader와 inventory 검사를 사용한다."""\nfactory = \'tests/integration/jonghyun/isolated_ai_factory.ts\'\nif not root.is_absolute() or root.resolve() != root or root == REPO or (not isinstance(pins, dict)) or (not 1 <= len(pins) <= 256) or any((pins.get(k) != v for k, v in expected.items())):\n    raise ValueError(\'MIDNIGHT_CUSTODY_CAPSULE\')').body
                self.assertEqual(dump(ast.Module(body=shared.body,type_ignores=[])),dump(ast.Module(body=prefix+tail,type_ignores=[])))
                candidate.body=copy.deepcopy(original.body)
        # 승인된 native119 v1/v2 전체 함수 AST만 예외로 묶는다. 다른 변경은 허용하지 않는다.
        history_hashes={'fb5b103065382ffe8c759c57c0a3e30fe543866305071f28ba56632dca3e935e','31ec8172bb801ca0857fb4cc60a5ce4b97fb5a16e2135315806d31fe23d6c01c'}
        old_history=next((n for n in before.body if isinstance(n,ast.FunctionDef)and n.name=='signed_verify_history'),None)
        if old_history is not None:
            new_history=next(n for n in after.body if isinstance(n,ast.FunctionDef)and n.name=='signed_verify_history')
            for n in(old_history,new_history):self.assertIn(hashlib.sha256(dump(n).encode()).hexdigest(),history_hashes)
            new_history.body=copy.deepcopy(old_history.body)
        current={node.name:node for node in after.body if isinstance(node,(ast.FunctionDef,ast.ClassDef))}
        for node in before.body:
            if isinstance(node,(ast.FunctionDef,ast.ClassDef)):
                self.assertEqual(dump(node),dump(current[node.name]),node.name)

    def test_original_python_functions_exact(self):
        old=subprocess.run(['git','show','HEAD:tests/integration/jonghyun/isolated_ai_contracts.py'],cwd=REPO,capture_output=True,text=True,check=True).stdout
        self.assert_original_python_preserved(ast.parse(old),ast.parse(RUNNER.read_text()))
        self.assert_original_python_preserved(ast.parse(RUNNER.read_text()),ast.parse(RUNNER.read_text()))
        extra=ast.parse(RUNNER.read_text())
        cls=next(n for n in extra.body if isinstance(n,ast.ClassDef)and n.name=='SignedMidnightRunner')
        method=next(n for n in cls.body if isinstance(n,ast.FunctionDef)and n.name=='start_factory')
        mode=next(n for n in method.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='mode'for t in n.targets))
        mode.value=ast.Constant(value='unreviewed-mode')
        with self.assertRaises(AssertionError):self.assert_original_python_preserved(ast.parse(old),extra)
        with self.assertRaises(AssertionError):self.assert_original_python_preserved(ast.parse(RUNNER.read_text()),extra)

    def test_reviewed_helper_pins_and_history_only_against_root7898(self):
        old=subprocess.run(['git','show','7898a83:tests/integration/jonghyun/isolated_ai_contracts.py'],cwd=REPO,capture_output=True,text=True,check=True).stdout
        before=ast.parse(old);after=ast.parse(RUNNER.read_text())
        self.assert_original_python_preserved(before,after)
        extra=copy.deepcopy(after)
        pins=next(n for n in extra.body if isinstance(n,ast.FunctionDef)and n.name=='signed_source_pins')
        paths=next(n for n in pins.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='paths'for t in n.targets))
        paths.value.elts.append(ast.Constant(value='unreviewed/helper.py'))
        with self.assertRaises(AssertionError):self.assert_original_python_preserved(before,extra)
        altered=copy.deepcopy(after)
        runner=next(n for n in altered.body if isinstance(n,ast.ClassDef)and n.name=='SignedRunner')
        next(n for n in runner.body if isinstance(n,ast.FunctionDef)and n.name=='clean').body.append(ast.Pass())
        with self.assertRaises(AssertionError):self.assert_original_python_preserved(before,altered)

    def test_native_v2_preservation_exception_refuses_other_history_mutation(self):
        current=ast.parse(RUNNER.read_text());changed=copy.deepcopy(current)
        fn=next(n for n in changed.body if isinstance(n,ast.FunctionDef)and n.name=='signed_verify_history')
        fn.body.append(ast.Pass())
        with self.assertRaises(AssertionError):self.assert_original_python_preserved(current,changed)

    def test_original_ts_units_byte_exact(self):
        path='tests/integration/jonghyun/isolated_ai_factory.ts'
        before=subprocess.run(['git','show','HEAD:'+path],cwd=REPO,capture_output=True,text=True,check=True).stdout
        after=(REPO/path).read_text();start='async function aiLimitsHttpCase('
        self.assertEqual(before[before.index(start):],after[after.index(start):])

    def test_actual_factory_negative_model_no_network(self):
        node=shutil.which('node')
        if not node:self.skipTest('cached node absent')
        fixture={'signedLocalAuth':True,'codeRoot':str(REPO),'origin':self.value['origin'],
            'productManifest':module.product_graph(),'anon':self.value['credentials']['anon'],'service':self.value['credentials']['service'],
            'accounts':[{'userId':a['userId'],'token':a['accessToken']}for a in self.value['accounts']]}
        path=self.root/'factory.json';self.write(path,json.dumps(fixture).encode())
        # 실제 factory를 실행하되 Auth 응답만 메모리에서 제공한다. 네트워크 증거로 집계하지 않는다.
        preload="globalThis.fetch=async(input,init)=>{const u=new URL(String(input));if(u.origin!=='http://127.0.0.1:56541'||u.pathname!=='/auth/v1/user'||init.method!=='GET')throw Error('UNEXPECTED_TRANSPORT');return new Response(JSON.stringify({code:401}),{status:401,headers:{'content-type':'application/json'}})};"
        uri='data:text/javascript;base64,'+base64.b64encode(preload.encode()).decode()
        result=subprocess.run([node,'--experimental-strip-types','--import',uri,str(REPO/'tests/integration/jonghyun/isolated_ai_factory.ts'),str(path),'--signed-auth-negative'],capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,'offline factory failed: '+str(result.returncode))
        proof=json.loads(result.stdout);self.assertEqual(proof['status'],'PASS');self.assertEqual(len(proof['cases']),4)
        self.assertEqual([c['actualAuthReads']for c in proof['cases']],[0,0,1,0]);self.assertEqual(proof['nativeExternalAttempts'],0)
        retained=module.signed_negative_receipt(proof)
        for key in ('expiredBearer','revokedSession','anonymousBearer','memberChanged','differentOriginalContext','fullLifecycleCoverage'):
            self.assertEqual(retained[key],'NOT_RUN')

    def test_partial_negative_receipt_never_promotes_unverified_lifecycle(self):
        proof={'status':'PASS','nativeExternalAttempts':0,'cases':[{'case':name,'status':'PASS','httpStatus':401,
            'actualAuthReads':reads,'rpcCalls':0,'providerCalls':0}for name,reads in (('missing',0),('malformed',0),('invalid_signature',1),('service_principal',0))],
            **{key:'NOT_RUN'for key in ('expiredBearer','revokedSession','anonymousBearer','memberChanged','differentOriginalContext')}}
        result=module.signed_negative_receipt(proof)
        self.assertEqual(result['fullLifecycleCoverage'],'NOT_RUN')
        for mutation in (lambda v:v.pop('expiredBearer'),lambda v:v.update(expiredBearer='PASS'),
                lambda v:v.update(nativeExternalAttempts=1),lambda v:v.update(nativeExternalAttempts=False),lambda v:v.update(nativeExternalAttempts=0.0),lambda v:v['cases'].append(copy.deepcopy(v['cases'][0])),
                lambda v:v['cases'][1].update(case='missing'),lambda v:v['cases'][2].update(rpcCalls=1),
                lambda v:v['cases'][2].update(providerCalls=True),lambda v:v['cases'][0].update(extra='raw-content')):
            value=copy.deepcopy(proof);mutation(value)
            with self.subTest(index=mutation),self.assertRaises(ValueError):module.signed_negative_receipt(value)

    def lifecycle_value(self):
        scope='1a'*16;accounts={}
        for case in('expiredBearer','revokedSession','memberChanged'):
            user,session=str(uuid.uuid4()),str(uuid.uuid4());email='synthetic-auth-lifecycle-'+scope+'-'+case.lower()+'@example.invalid'
            claims={'sub':user,'session_id':session,'iss':self.value['jwtIssuer'],'role':'authenticated','is_anonymous':False,
                    'email':email,'iat':1999999900,'exp':2000000000}
            accounts[case]={'userId':user,'sessionId':session,'accessToken':jwt(claims),'expiresAt':2000000000,
                'authEmail':email,'issuanceReceiptSha256':'8'*64}
        accounts['anonymousBearer']=None
        return {'version':1,'kind':module.LIFECYCLE_KIND,'scopeId':scope,'preparedRoot':str(self.root),
            'signedBindingSha256':'9'*64,'sourcePins':{'fixed':'f'*64},'evidenceRoot':str(self.root/('auth-lifecycle-'+scope)),
            'accounts':accounts,'foreign':None,'approvedByRoot':False,'dockerSlotReady':False}

    def lifecycle_runner(self,value=None):
        value=value or self.lifecycle_value()
        with patch.object(module,'signed_prepared_target',return_value=self.target):
            runner=module.SignedAuthLifecycleRunner(self.root,self.value,value)
        runner.evidence.mkdir(mode=0o700,exist_ok=True)
        return runner

    def test_lifecycle_input_is_separate_and_never_authenticates_from_json(self):
        value=self.lifecycle_value()
        with patch.object(module,'signed_source_pins',return_value={'fixed':'f'*64}),patch.object(module.subprocess,'run',side_effect=AssertionError('resource')):
            self.assertIs(module.validate_lifecycle_input(value,self.root,self.value,'9'*64),value)
            for change in(lambda v:v['accounts']['revokedSession'].update(userId=self.value['accounts'][0]['userId']),
                    lambda v:v['accounts']['memberChanged'].update(sessionId=self.value['accounts'][0]['sessionId']),
                    lambda v:v['accounts'].update(expiredBearer=None),lambda v:v.update(extra=True),lambda v:v.update(approvedByRoot=1),
                    lambda v:v.update(signedBindingSha256='0'*64),lambda v:v['accounts']['expiredBearer'].update(expiresAt=True)):
                broken=copy.deepcopy(value);change(broken)
                with self.subTest(change=change),self.assertRaises(ValueError):module.validate_lifecycle_input(broken,self.root,self.value,'9'*64)
        Path(value['evidenceRoot']).mkdir(mode=0o700)
        with patch.object(module,'signed_source_pins',return_value={'fixed':'f'*64}),self.assertRaisesRegex(ValueError,'LIFECYCLE_PREVIOUS_ATTEMPT'):
            module.validate_lifecycle_input(value,self.root,self.value,'9'*64)

    def test_lifecycle_issuance_requires_pinned_private_original_response(self):
        value=self.lifecycle_value();case='revokedSession';account=value['accounts'][case]
        directory=self.root/('auth-lifecycle-provision-'+value['scopeId']);directory.mkdir(mode=0o700)
        response={'access_token':account['accessToken'],'token_type':'bearer','user':{'id':account['userId'],'is_anonymous':False}}
        response_path=directory/(case+'-issued-response-private.json');self.write(response_path,json.dumps(response).encode())
        response_sha=hashlib.sha256(response_path.read_bytes()).hexdigest()
        receipt={'version':1,'kind':'GOTRUE_ORIGINAL_TOKEN_ISSUED','scopeId':value['scopeId'],'case':case,'userId':account['userId'],
            'sessionId':account['sessionId'],'tokenSha256':hashlib.sha256(account['accessToken'].encode()).hexdigest(),
            'origin':self.value['origin'],'authContainerId':self.value['containers']['auth']['id'],'authImage':self.value['containers']['auth']['image'],
            'issuedAt':1999999900,'expiresAt':account['expiresAt'],'httpStatus':200,'responseSha256':response_sha,'wire':'POST /token?grant_type=password'}
        path=directory/(case+'-issued.json');self.write(path,json.dumps(receipt).encode())
        account['issuanceReceiptSha256']=hashlib.sha256(path.read_bytes()).hexdigest()
        reviewed=Mock(issuance_proofs={case:{'receiptSha256':account['issuanceReceiptSha256'],'responseSha256':response_sha}})
        self.assertEqual(module.lifecycle_issuance(self.root,self.value,value,case,reviewed),receipt)
        with patch.object(module.SignedRunner,'auth_user',side_effect=AssertionError('network')):
            with response_path.open('ab')as stream:stream.write(b' ')
            with self.assertRaisesRegex(ValueError,'LIFECYCLE_ISSUANCE_RESPONSE_CHANGED'):module.lifecycle_issuance(self.root,self.value,value,case,reviewed)
        # 새로운 JSON 성공 플래그만 추가하거나 검토된 원 응답의 다른 토큰으로 바꾸어도 거절한다.
        response_path.unlink();self.write(response_path,json.dumps({**response,'access_token':'replacement'}).encode())
        reviewed.issuance_proofs[case]['responseSha256']=hashlib.sha256(response_path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'LIFECYCLE_ISSUANCE_ORIGINAL_RESPONSE'):module.lifecycle_issuance(self.root,self.value,value,case,reviewed)

    def test_lifecycle_original_token_requires_actual_auth_and_database(self):
        runner=self.lifecycle_runner();case='revokedSession';account=runner.lifecycle['accounts'][case]
        user={'id':account['userId'],'role':'authenticated','is_anonymous':False,
              'user_metadata':{'fixture_scope_id':runner.lifecycle['scopeId'],'fixture_case':case}}
        with patch.object(runner,'http',return_value=(200,user))as http,patch.object(runner,'read_sql',return_value='t')as sql:
            proof=runner.verify_token(case,account);self.assertTrue(proof['actualDatabaseSession'])
            http.assert_called_once_with('GET','/user',account['accessToken']);self.assertIn(account['sessionId'],sql.call_args.args[0])
        for status,body,db in((403,user,'t'),(200,{**user,'id':str(uuid.uuid4())},'t'),(200,{**user,'is_anonymous':True},'t'),
                (200,{**user,'user_metadata':{}},'t'),(200,user,'f')):
            with self.subTest(status=status,body=body),patch.object(runner,'http',return_value=(status,body)),patch.object(runner,'read_sql',return_value=db),self.assertRaises(ValueError):
                runner.verify_token(case,account)

    def test_lifecycle_http_no_general_mutation_paths(self):
        runner=self.lifecycle_runner();token=runner.lifecycle['accounts']['revokedSession']['accessToken']
        with patch.object(module.urllib.request,'build_opener',side_effect=AssertionError('network')):
            for method,path,payload,credential in(('DELETE','/admin/users/'+runner.lifecycle['accounts']['memberChanged']['userId'],None,runner.binding['credentials']['service']),
                    ('POST','/logout?scope=global',{},token),('POST','/logout?scope=local',{},runner.binding['accounts'][0]['accessToken']),
                    ('PUT','/admin/users/'+str(uuid.uuid4()),{'ban_duration':'1h'},runner.binding['credentials']['service']),
                    ('PUT','/admin/users/'+runner.lifecycle['accounts']['memberChanged']['userId'],{'role':'service_role'},runner.binding['credentials']['service'])):
                with self.subTest(path=path),self.assertRaisesRegex(ValueError,'LIFECYCLE_HTTP_SCOPE'):runner.http(method,path,credential,payload)

    def test_lifecycle_ambiguous_local_logout_has_durable_no_replay(self):
        runner=self.lifecycle_runner()
        with patch.object(runner,'live'),patch.object(runner,'verify_token'),patch.object(runner,'http',side_effect=ValueError('LIFECYCLE_HTTP_OUTCOME_UNKNOWN'))as http:
            with self.assertRaisesRegex(ValueError,'LIFECYCLE_HTTP_OUTCOME_UNKNOWN'):runner.mutate_once('revokedSession')
            with self.assertRaisesRegex(ValueError,'LIFECYCLE_MUTATION_REPLAY'):runner.mutate_once('revokedSession')
            self.assertEqual(http.call_count,1)
        outcome=json.loads((runner.evidence/'revokedsession-mutation-outcome.json').read_bytes())
        self.assertEqual(outcome['status'],'UNKNOWN');self.assertFalse(outcome['retryAllowed'])
        intent=(runner.evidence/'revokedsession-mutation-intent.json').read_bytes()
        self.assertNotIn(runner.lifecycle['accounts']['revokedSession']['accessToken'].encode(),intent)
        self.assertEqual((runner.evidence/'revokedsession-mutation-intent.json').stat().st_mode&0o777,0o600)

    def test_lifecycle_natural_expiry_is_bounded_original_token(self):
        account={'expiresAt':100.5,'accessToken':'unchanged-original'};clock=[100.0];waits=[]
        def sleep(seconds):waits.append(seconds);clock[0]+=seconds
        module.lifecycle_natural_expiry(account,now=lambda:clock[0],sleep=sleep)
        self.assertEqual(account['accessToken'],'unchanged-original');self.assertEqual(sum(waits),.5)
        for current in(101,0):
            with self.assertRaisesRegex(ValueError,'LIFECYCLE_NATURAL_EXPIRY_WINDOW'):module.lifecycle_natural_expiry(account,now=lambda:current,sleep=sleep)

    def test_lifecycle_reviewed_object_rereads_exact_private_files_before_calls(self):
        value=self.lifecycle_value();value['approvedByRoot']=True;value['dockerSlotReady']=True
        binding=copy.deepcopy(self.value);binding['approvedByRoot']=True;binding['dockerSlotReady']=True
        binding_path=self.root/'signed-ai-binding-private.json';self.write(binding_path,json.dumps(binding).encode())
        value['signedBindingSha256']=hashlib.sha256(binding_path.read_bytes()).hexdigest()
        input_path=self.root/('auth-lifecycle-input-'+value['scopeId']+'.json');self.write(input_path,json.dumps(value).encode())
        reviewed=module.ReviewedSignedAuthLifecycle('reviewed-fixture',self.root,binding_path,input_path,
            value['signedBindingSha256'],hashlib.sha256(input_path.read_bytes()).hexdigest(),binding['sourcePins'],binding['containers'])
        with patch.object(module,'provisioning_source_check',side_effect=AssertionError('source execution')):
            with input_path.open('ab')as stream:stream.write(b' ')
            with self.assertRaisesRegex(ValueError,'LIFECYCLE_REVIEWED_PRIVATE_BYTES_CHANGED'):
                module.run_signed_auth_lifecycle(reviewed,binding,value,shutil.which('node'))
            with self.assertRaisesRegex(ValueError,'LIFECYCLE_REVIEWED_CODE_REQUIRED'):
                module.run_signed_auth_lifecycle({'approvedByRoot':True},binding,value,shutil.which('node'))

    def test_lifecycle_missing_reviewed_issuance_refuses_before_resource(self):
        value=self.lifecycle_value();value.update(approvedByRoot=True,dockerSlotReady=True)
        binding=copy.deepcopy(self.value);binding.update(approvedByRoot=True,dockerSlotReady=True)
        binding_path=self.root/'signed-ai-binding-private.json';self.write(binding_path,json.dumps(binding).encode())
        value['signedBindingSha256']=hashlib.sha256(binding_path.read_bytes()).hexdigest()
        path=self.root/('auth-lifecycle-input-'+value['scopeId']+'.json');self.write(path,json.dumps(value).encode())
        reviewed=module.ReviewedSignedAuthLifecycle('reviewed-fixture',self.root,binding_path,path,value['signedBindingSha256'],hashlib.sha256(path.read_bytes()).hexdigest(),binding['sourcePins'],binding['containers'])
        with patch.object(module,'signed_prepared_target',return_value=self.target),patch.object(module,'signed_source_pins',return_value=binding['sourcePins']),patch.object(module,'provisioning_source_check',side_effect=AssertionError('resource')):
            with self.assertRaisesRegex(ValueError,'LIFECYCLE_REVIEWED_ACTUAL_ISSUANCE_REQUIRED'):module.run_signed_auth_lifecycle(reviewed,binding,value,shutil.which('node'))

    def test_lifecycle_audit_nullable_fields_remain_in_preservation_bag(self):
        # SQLite 모델로 같은 SQL NULL 논리를 검증한다. 실제 PostgreSQL 연결 증거는 아니다.
        import sqlite3
        from contextlib import closing
        runner=self.lifecycle_runner();queries=[]
        def read(query,timeout=5):
            if 'from pg_tables' in query:return json.dumps([['auth','audit_log_entries']])
            queries.append(query);return '{}'
        with patch.object(runner,'read_sql',side_effect=read):runner.preservation_rows()
        self.assertEqual(len(queries),1)
        condition=queries[0].split(' r where ',1)[1].rsplit(' group by 1)',1)[0]
        revoke=runner.lifecycle['accounts']['revokedSession']['userId']
        ban=runner.lifecycle['accounts']['memberChanged']['userId']
        unowned=[{}, {'action':None}, {'action':'logout'}, {'action':'user_modified'},
                 {'action':'user_modified','traits':{}}, {'action':'logout','actor_id':'other'},
                 {'action':'user_modified','traits':{'user_id':'other'}}]
        owned=[{'action':'logout','actor_id':revoke},{'action':'user_modified','traits':{'user_id':ban}}]
        payloads=[json.dumps(v,sort_keys=True)for v in unowned+owned]
        with closing(sqlite3.connect(':memory:'))as db:
            query='with samples(payload)as(values '+','.join('(?)'for _ in payloads)+')select payload from samples r where '+condition
            retained=[row[0]for row in db.execute(query,payloads)]
        self.assertEqual(retained,payloads[:len(unowned)])

    def test_lifecycle_cascade_and_no_mutation_original_bags(self):
        runner=self.lifecycle_runner();baseline={'authoritySha256':'a','constraintsSha256':'b'};rows={'auth.users':{'old':1},'private.ai_budget_reservations':{'unknown':1}}
        state={'user':{'id':runner.lifecycle['accounts']['memberChanged']['userId'],'banned_until':None,'updated_at':1},'revokedSession':{'id':'owned'},
               'revokedRefreshCount':1,'revokedAmrCount':1,'logoutAudit':0,'banAudit':0,'banActive':False}
        dependent={'refresh_tokens':{'original-refresh':1},'mfa_amr_claims':{'original-amr':1}}
        with patch.object(runner,'live'),patch.object(runner,'snapshot',return_value=baseline),patch.object(runner,'preservation_rows',return_value=rows),patch.object(runner,'mutation_state',return_value=state),patch.object(runner,'dependent_rows',return_value=dependent):
            runner.verify_final(baseline,rows,state,dependent)
            with patch.object(runner,'dependent_rows',return_value={'refresh_tokens':{},'mfa_amr_claims':{}}),self.assertRaisesRegex(ValueError,'LIFECYCLE_ORIGINAL_SESSION_CHANGED'):runner.verify_final(baseline,rows,state,dependent)
        runner.mutations={'revokedSession'};after={**state,'revokedSession':None,'revokedRefreshCount':0,'revokedAmrCount':0,'logoutAudit':1};empty={'refresh_tokens':{},'mfa_amr_claims':{}}
        with patch.object(runner,'live'),patch.object(runner,'snapshot',return_value=baseline),patch.object(runner,'preservation_rows',return_value=rows),patch.object(runner,'mutation_state',return_value=after),patch.object(runner,'dependent_rows',return_value=empty):
            runner.verify_final(baseline,rows,state,dependent)
            with patch.object(runner,'dependent_rows',return_value=dependent),self.assertRaisesRegex(ValueError,'LIFECYCLE_REVOCATION_CASCADE_UNPROVEN'):runner.verify_final(baseline,rows,state,dependent)
            with patch.object(runner,'snapshot',return_value={**baseline,'constraintsSha256':'drift'}),self.assertRaisesRegex(ValueError,'LIFECYCLE_ORIGINAL_ROWS_AUTHORITY_CHANGED'):runner.verify_final(baseline,rows,state,dependent)
            with patch.object(runner,'preservation_rows',return_value={**rows,'private.ai_budget_reservations':{}}),self.assertRaisesRegex(ValueError,'LIFECYCLE_ORIGINAL_ROWS_AUTHORITY_CHANGED'):runner.verify_final(baseline,rows,state,dependent)

    def test_lifecycle_cli_is_never_mutation_authority(self):
        with patch.object(module.sys,'argv',['runner','--signed-auth-lifecycle','--run']),patch.object(module,'signed_prepared_target',side_effect=AssertionError('resource')),patch.object(module,'run_signed_auth_lifecycle',side_effect=AssertionError('mutation')):
            from contextlib import redirect_stdout
            import io
            output=io.StringIO()
            with redirect_stdout(output):module.signed_auth_lifecycle_main()
        value=json.loads(output.getvalue());self.assertEqual(value['status'],'NOT_RUN');self.assertEqual(value['actualCalls'],0)

    def test_actual_lifecycle_factory_model_denies_only_real_auth_contract(self):
        node=shutil.which('node')
        if not node:self.skipTest('cached node absent')
        a=self.lifecycle_value()['accounts']['expiredBearer'];factory=REPO/'tests/integration/jonghyun/isolated_ai_factory.ts'
        fixture={'signedLocalAuth':True,'authLifecycleScenario':True,'codeRoot':str(REPO),'origin':self.value['origin'],
            'productManifest':module.product_graph(),'anon':self.value['credentials']['anon'],'service':self.value['credentials']['service'],
            'originalToken':a['accessToken'],'originalUserId':a['userId'],'aiLedgerId':'synthetic-lifecycle-never-reserved'}
        for case in module.LIFECYCLE_CASES:
            fixture['lifecycleCase']=case;path=self.root/(case+'-factory.json');self.write(path,json.dumps(fixture).encode())
            user={'id':a['userId'],'role':'authenticated','is_anonymous':True}
            preload="globalThis.fetch=async(input,init)=>{if(String(input)!==%s+'/auth/v1/user'||init.method!=='GET'||new Headers(init.headers).get('authorization')!==%s)throw Error('UNEXPECTED_TRANSPORT');return new Response(JSON.stringify(%s),{status:%s,headers:{'content-type':'application/json'}})};"%(json.dumps(fixture['origin']),json.dumps('Bearer '+a['accessToken']),json.dumps(user if case=='anonymousBearer'else{'code':'bad_jwt'}),'200'if case=='anonymousBearer'else'403')
            uri='data:text/javascript;base64,'+base64.b64encode(preload.encode()).decode()
            completed=subprocess.run([node,'--experimental-strip-types','--import',uri,str(factory),str(path),'--signed-auth-lifecycle-case'],capture_output=True,text=True,timeout=20)
            self.assertEqual(completed.returncode,0,'offline lifecycle factory model failed: '+case)
            proof=json.loads(completed.stdout);self.assertEqual(proof['case'],case);self.assertEqual(proof['rpcCalls'],0);self.assertEqual(proof['providerCalls'],0)
        # 실제 만료·철회 대신 정상 Auth200을 주면 이 검사도 실패해야 한다.
        fixture['lifecycleCase']='expiredBearer';path=self.root/'active-factory.json';self.write(path,json.dumps(fixture).encode())
        preload="globalThis.fetch=async()=>new Response(JSON.stringify(%s),{status:200,headers:{'content-type':'application/json'}});"%json.dumps({**user,'is_anonymous':False})
        uri='data:text/javascript;base64,'+base64.b64encode(preload.encode()).decode()
        failed=subprocess.run([node,'--experimental-strip-types','--import',uri,str(factory),str(path),'--signed-auth-lifecycle-case'],capture_output=True,text=True,timeout=20)
        self.assertNotEqual(failed.returncode,0)

    def test_real_factory_positive_original_bearer_model(self):
        node=shutil.which('node')
        if not node:self.skipTest('cached node absent')
        user=self.value['accounts'][0];token=user['accessToken']
        script="""import assert from 'node:assert/strict';import {createAiChatRuntime} from %s;
const token=%s,uid=%s;let calls=0;
const env={SUPABASE_URL:'http://127.0.0.1:56541',SUPABASE_ANON_KEY:'synthetic-anon',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000'};
const handler=createAiChatRuntime(k=>env[k],async(url,init)=>{assert.equal(url,'http://127.0.0.1:56541/auth/v1/user');assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+token);calls++;return new Response(JSON.stringify({id:uid,role:'authenticated',is_anonymous:false}),{status:200,headers:{'content-type':'application/json'}})});
const response=await handler(new Request('http://127.0.0.1:56541/functions/v1/ai-chat',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({clientRequestId:'syntheticrequest',messages:[{role:'user',content:'합성 입력'}],currentFilters:{target:'posts'}})}));assert.equal(calls,1);assert.equal(response.status,200);const value=await response.json();assert.equal(value.data.status,'unavailable');console.log('PASS_AUTH_FORWARD_MODEL');
"""%(json.dumps((REPO/'backend/supabase/functions/ai-chat/index.ts').as_uri()),json.dumps(token),json.dumps(user['userId']))
        result=subprocess.run([node,'--experimental-strip-types','--input-type=module','-e',script],capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,'offline bearer model failed: '+str(result.returncode));self.assertEqual(result.stdout.strip(),'PASS_AUTH_FORWARD_MODEL')


class FakeProvisioningPorts:
    """모형 Auth/DB만 사용한다. 실제 계정·HTTP·도커 생성 0이다."""
    def __init__(self, value):
        self.value=value;self.calls=[];self.users={};self.empty=True;self.memory=1100000
        self.lose_create=False;self.lose_login=False;self.lose_delete=False;self.wrong_jwt=False
        self.session_ok=True;self.authority_changed=False;self.links=[];self.accounts=[];self.extra_row=False;self.controls_open=False
    def identity(self):return self.value['containers']
    def empty_auth(self):return self.empty
    def memory_kib(self):return self.memory
    def snapshot(self):
        rows={t:{}for t in module.PROVISION_OWNED_TABLES};rows.update({'storage.objects':{},'private.worker_invocations':{}})
        for table,entries in self.added_rows(rows,self.accounts).items():
            rows[table]={e['rowSha256']:1 for e in entries.values()}
        if self.extra_row:rows['private.worker_invocations']['f'*64]=1
        return {'rows':rows,'authoritySha256':'b'*64 if self.authority_changed and self.users else'a'*64}
    def closed_controls(self):return {**{k:False for k in module.PROVISION_CLOSED_CONTROLS},'cronLaunchActiveJobs':'off',**({'worker_invocation_control':True}if self.controls_open else{})}
    def added_rows(self,baseline,accounts):
        result={t:{}for t in module.PROVISION_OWNED_TABLES}
        for account in accounts:
            for table in result:
                for operation in (('login','user_signedup')if table=='auth.audit_log_entries'else('row',)):
                    key=hashlib.sha256((table+account['userId']+operation).encode()).hexdigest()
                    result[table][key[:32]]={'rowSha256':key,'ownerUserId':account['userId'],'operation':operation}
        return result
    def resolve_email(self,email):return self.users.get(email,{}).get('id')
    def session_proof(self,account):return self.session_ok
    def link_profile(self,identifier):self.links.append(identifier);return True
    def unlink_profile(self,identifier):self.links=[u for u in self.links if u!=identifier]
    def verify_population(self,accounts):self.accounts=accounts;return len(self.users)==len(self.links)==len(accounts)==6
    def request(self,method,path,payload=None,token=None,admin=False):
        self.calls.append((method,path))
        if method=='POST'and path=='/admin/users':
            user={'id':str(uuid.uuid4()),'email':payload['email'],'role':'authenticated','is_anonymous':False};self.users[user['email']]=user
            if self.lose_create:raise ValueError('PROVISION_HTTP_OUTCOME_UNKNOWN')
            return 200,user
        if method=='POST':
            import time
            user=self.users[payload['email']]
            if self.lose_login:raise ValueError('PROVISION_HTTP_OUTCOME_UNKNOWN')
            claims={'sub':user['id'],'session_id':str(uuid.uuid4()),'exp':int(time.time())+3600,'email':user['email'],
                    'iss':self.value['origin']+'/auth/v1','aud':'authenticated','role':'authenticated','is_anonymous':False}
            if self.wrong_jwt:claims['iss']='https://outside.invalid'
            return 200,{'user':user,'access_token':jwt(claims)}
        if path=='/user':
            claims=module.signed_claims(token);return 200,self.users[claims['email']]
        identifier=path.rsplit('/',1)[1]
        matching=next((u for u in self.users.values()if u['id']==identifier),None)
        if method=='DELETE':
            if matching:self.users.pop(matching['email'])
            if self.lose_delete:raise ValueError('PROVISION_HTTP_OUTCOME_UNKNOWN')
            return 200,{}
        return (200,matching)if matching else(404,{})


class ProvisioningFunctionTests(unittest.TestCase):
    setUp=BindingTests.setUp
    tearDown=BindingTests.tearDown
    write=BindingTests.write
    def reviewed(self,ports=None):
        import time
        self.ports=ports or FakeProvisioningPorts(self.value)
        return module.ReviewedSignedProvisioning('offline-function-test-only',self.root,self.value['sourcePins'],
            self.value['containers'],self.value['credentials'],int(time.time())+600,self.ports)
    def invoke(self,reviewed=None):
        with patch.object(module,'provisioning_source_check',return_value='a'*40),patch.object(module,'signed_prepared_target',return_value=self.target),patch.object(module,'signed_source_pins',return_value=self.value['sourcePins']):
            return module.provision_signed_accounts(self.root,reviewed or self.reviewed())
    def failure(self):
        paths=list(self.root.glob('auth-provision-*/failure.json'));self.assertEqual(len(paths),1)
        return json.loads(paths[0].read_text())
    def test_six_actual_transport_model_calls_emit_private_original_binding_only(self):
        receipt=self.invoke();binding=self.root/'signed-ai-binding-private.json';value=json.loads(binding.read_bytes())
        self.assertEqual(receipt['status'],'PASS_LOCAL_AUTH6_PROVISION_ONLY')
        self.assertEqual(len(value['accounts']),6);self.assertFalse(value['approvedByRoot']);self.assertFalse(value['dockerSlotReady'])
        self.assertEqual(sum(x==('POST','/admin/users')for x in self.ports.calls),6)
        self.assertEqual(sum(x==('POST','/token?grant_type=password')for x in self.ports.calls),6)
        self.assertEqual(sum(x==('GET','/user')for x in self.ports.calls),6)
        self.assertEqual(binding.stat().st_mode&0o777,0o600)
        self.assertNotIn('accessToken',json.dumps(receipt));self.assertEqual(receipt['actualAI22AI23AI24'],'NOT_RUN')
        for path in self.root.glob('auth-provision-*/*.json'):
            self.assertNotIn('accessToken',path.read_text());self.assertEqual(path.stat().st_mode&0o777,0o600)
    def test_producer_reserves_absent_evidence_then_original_cli_creates_it_once(self):
        self.invoke();binding=self.root/'signed-ai-binding-private.json';value=json.loads(binding.read_bytes())
        evidence=Path(value['evidenceRoot'])
        self.assertEqual(evidence.parent,self.root);self.assertEqual(evidence,evidence.resolve())
        self.assertFalse(evidence.exists());self.assertFalse(evidence.is_symlink())
        creation_roots=list(self.root.glob('auth-provision-*'))
        self.assertEqual(len(creation_roots),1);self.assertEqual(creation_roots[0].stat().st_mode&0o777,0o700)
        # 오프라인 조립의 검토 flag 모형이다. 실제 실행 승인이나 Auth/DB 증거가 아니다.
        value.update(approvedByRoot=True,dockerSlotReady=True);binding.write_text(json.dumps(value))
        original_calls=list(self.ports.calls)
        def stop_before_ports(runner):
            self.assertEqual(runner.evidence,evidence)
            self.assertTrue(evidence.is_dir());self.assertEqual(evidence.stat().st_mode&0o777,0o700)
            raise RuntimeError('MODEL_STOP_BEFORE_RESOURCE_PORTS')
        argv=['isolated_ai_contracts.py','--signed-auth','--signed-auth-binding',str(binding),
            '--prepared-root',str(self.root),'--node',sys.executable,'--run']
        with patch.object(module.sys,'argv',argv),patch.object(module,'signed_prepared_target',return_value=self.target),\
                patch.object(module,'signed_source_pins',return_value=self.value['sourcePins']),\
                patch.object(module.SignedRunner,'prepare',autospec=True,side_effect=stop_before_ports)as prepare,\
                patch.object(module.signal,'signal'),patch.object(module.subprocess,'Popen',side_effect=AssertionError('resource child')):
            with self.assertRaisesRegex(RuntimeError,'MODEL_STOP_BEFORE_RESOURCE_PORTS'):module.signed_main()
            prepare.assert_called_once()
            with self.assertRaises(FileExistsError):module.signed_main()
            prepare.assert_called_once()
        self.assertEqual(self.ports.calls,original_calls)
        self.assertTrue((evidence/'failure.json').is_file());self.assertEqual(evidence.stat().st_mode&0o777,0o700)
    def test_json_boolean_is_not_provisioning_authority(self):
        with self.assertRaisesRegex(ValueError,'PROVISION_REVIEWED_CODE_REQUIRED'):
            self.invoke({'approvedByRoot':True,'dockerSlotReady':True})
    def test_initial_nonempty_target_or_low_headroom_creates_no_accounts(self):
        reviewed=self.reviewed();self.ports.empty=False
        with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        self.assertEqual(self.ports.calls,[]);self.assertEqual(self.failure()['attemptedCount'],0)
    def test_initial_floor_failure_retains_exact_fixed_code_no_http(self):
        reviewed=self.reviewed();self.ports.memory=1048575
        with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        self.assertEqual(self.ports.calls,[]);self.assertEqual(self.failure()['code'],'PROVISION_RESOURCE_GUARD')
    def test_ambiguous_create_get_only_recovery_never_recreates(self):
        reviewed=self.reviewed();self.ports.lose_create=True
        with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        self.assertEqual(self.ports.calls.count(('POST','/admin/users')),1)
        self.assertEqual(self.ports.calls.count(('POST','/token?grant_type=password')),0)
        self.assertEqual(len(self.ports.users),0);self.assertEqual(self.failure()['closedCount'],1)
    def test_ambiguous_login_and_delete_each_have_one_wire_attempt(self):
        reviewed=self.reviewed();self.ports.lose_login=True;self.ports.lose_delete=True
        with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        self.assertEqual(self.ports.calls.count(('POST','/token?grant_type=password')),1)
        self.assertEqual(sum(method=='DELETE'for method,path in self.ports.calls),1)
        self.assertEqual(len(self.ports.users),0);self.assertTrue(self.failure()['noResend'])
    def test_wrong_original_issuer_never_forwards_to_member_factory(self):
        reviewed=self.reviewed();self.ports.wrong_jwt=True
        with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        self.assertEqual(self.ports.calls.count(('GET','/user')),0);self.assertEqual(len(self.ports.users),0)
        self.assertEqual(self.failure()['code'],'PROVISION_ORIGINAL_JWT_METADATA')
    def test_db_session_negative_restores_only_owned_new_user(self):
        reviewed=self.reviewed();self.ports.session_ok=False
        with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        self.assertEqual(self.ports.links,[]);self.assertEqual(len(self.ports.users),0)
        self.assertEqual(self.failure()['closedCount'],1)
    def test_authority_drift_cannot_emit_signed_binding(self):
        reviewed=self.reviewed();self.ports.authority_changed=True
        with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        self.assertFalse((self.root/'signed-ai-binding-private.json').exists());self.assertEqual(len(self.ports.users),0)
        self.assertEqual(self.failure()['closedCount'],6)
    def test_invalid_reviewed_target_binding_rejects_before_any_http(self):
        reviewed=self.reviewed();reviewed.containers=copy.deepcopy(reviewed.containers);reviewed.containers['db']['id']='9'*64
        with self.assertRaisesRegex(ValueError,'PROVISION_DATABASE_BINDING'):self.invoke(reviewed)
        self.assertEqual(self.ports.calls,[])
    def test_cleanup_identity_drift_never_deletes_uncertain_target(self):
        reviewed=self.reviewed();self.ports.lose_login=True
        original=self.ports.identity
        self.ports.identity=lambda: {} if any(path.startswith('/token')for method,path in self.ports.calls)else original()
        with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        self.assertEqual(sum(method=='DELETE'for method,path in self.ports.calls),0)
        self.assertEqual(self.failure()['status'],'UNKNOWN')

    def test_delayed_create_first_absent_read_remains_unknown_not_closed(self):
        reviewed=self.reviewed();self.ports.lose_create=True
        self.ports.resolve_email=lambda email:None
        with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        failure=self.failure();self.assertEqual(failure['status'],'UNKNOWN')
        self.assertEqual(failure['unknownPostCount'],1);self.assertEqual(failure['closedCount'],0)
        self.assertEqual(self.ports.calls.count(('POST','/admin/users')),1)
        self.assertEqual(sum(method=='DELETE'for method,path in self.ports.calls),0)
        self.assertEqual(len(self.ports.users),1)  # 먼저 absent read 뒤 도착할 수 있는 실제 효과의 모형.
    def test_replaced_successful_create_uuid_is_not_adopted_for_cleanup(self):
        reviewed=self.reviewed();self.ports.lose_login=True
        original=self.ports.resolve_email
        def replaced(email):
            if any(path.startswith('/token')for method,path in self.ports.calls):return str(uuid.uuid4())
            return original(email)
        self.ports.resolve_email=replaced
        with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        self.assertEqual(self.failure()['status'],'UNKNOWN')
        self.assertEqual(sum(method=='DELETE'for method,path in self.ports.calls),0)

    def test_unrelated_private_addition_never_emits_signed_binding(self):
        reviewed=self.reviewed()
        original=self.ports.verify_population
        def verified(accounts):self.ports.extra_row=True;return original(accounts)
        self.ports.verify_population=verified
        with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        self.assertFalse((self.root/'signed-ai-binding-private.json').exists())
        self.assertEqual(self.failure()['code'],'PROVISION_UNOWNED_ROW_CHANGED')
    def test_open_database_control_rejects_before_any_create(self):
        reviewed=self.reviewed();self.ports.controls_open=True
        with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        self.assertEqual(self.ports.calls,[]);self.assertEqual(self.failure()['code'],'PROVISION_DATABASE_CONTROLS_OPEN')
    def test_same_prepared_root_cannot_repeat_even_after_failure_cleanup(self):
        reviewed=self.reviewed();self.ports.lose_login=True
        with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        before=list(self.ports.calls)
        with self.assertRaisesRegex(ValueError,'PROVISION_PREVIOUS_ATTEMPT_PRESERVED'):self.invoke(reviewed)
        self.assertEqual(self.ports.calls,before)

    def test_audit_owner_and_operation_proof_cannot_use_unrelated_actor(self):
        reviewed=self.reviewed();uids=[{'userId':str(uuid.uuid4())}for _ in range(6)]
        added=self.ports.added_rows({},uids)
        baseline={t:{}for t in module.PROVISION_OWNED_TABLES}
        current={t:{row['rowSha256']:1 for row in rows.values()}for t,rows in added.items()}
        module.provisioning_added_scope(baseline,current,added,uids)
        for field,replacement in(('ownerUserId',str(uuid.uuid4())),('operation','user_deleted')):
            changed=copy.deepcopy(added);entry=next(iter(changed['auth.audit_log_entries'].values()));entry[field]=replacement
            with self.assertRaisesRegex(ValueError,'PROVISION_ADDED_ROW'):
                module.provisioning_added_scope(baseline,current,changed,uids)
    def test_fixed_audit_sql_uses_admin_traits_pair_and_real_login_actor(self):
        ports=object.__new__(module.FixedSignedProvisioningPorts);queries=[]
        ports.read_sql=lambda query,timeout:(queries.append(query)or'{}')
        accounts=[{'userId':str(uuid.uuid4()),'sessionId':str(uuid.uuid4()),'authEmail':'synthetic-ai-fixed@example.invalid'}]
        ports.added_rows({},accounts)
        audit=next(q for q in queries if'from auth.audit_log_entries'in q)
        self.assertIn("r.payload->'traits'->>'user_id'=a.user_id",audit)
        self.assertIn("r.payload->'traits'->>'user_email'=a.email",audit)
        self.assertIn("r.payload->>'actor_id'=a.user_id",audit)
        self.assertIn("r.payload->>'actor_username'=a.email",audit)
        self.assertNotIn('accessToken',audit)
    def test_create_receipt_save_failure_still_binds_in_memory_original_uuid(self):
        reviewed=self.reviewed();native=module.provisioning_json
        def save(root,name,value):
            if name=='account-0-create-outcome.json':
                self.ports.resolve_email=lambda email:str(uuid.uuid4())
                raise OSError('private failure not retained')
            return native(root,name,value)
        with patch.object(module,'provisioning_json',side_effect=save):
            with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        self.assertEqual(sum(method=='DELETE'for method,path in self.ports.calls),0)
        self.assertEqual(self.failure()['status'],'UNKNOWN')
    def test_unlisted_error_text_is_not_saved_as_code(self):
        reviewed=self.reviewed()
        self.ports.memory_kib=lambda:(_ for _ in()).throw(ValueError('PROVISION_RAW_PRIVATE_SECRET'))
        with self.assertRaisesRegex(ValueError,'PROVISION_FAILED_PRIVATE'):self.invoke(reviewed)
        self.assertEqual(self.failure()['code'],'PROVISION_FAILED')
        self.assertNotIn('RAW_PRIVATE_SECRET',json.dumps(self.failure()))

class NativeSignedHistoryTests(unittest.TestCase):
    setUp=BindingTests.setUp
    tearDown=BindingTests.tearDown
    write=BindingTests.write
    def prepare_proofs(self):
        canon=lambda v:json.dumps(v,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
        digest=lambda v:hashlib.sha256(canon(v)).hexdigest()
        self.canonical_root=self.root/'canonical';self.canonical_root.mkdir(mode=0o700)
        self.roles={'roles':[{'rolname':'postgres','rolsuper':False,'rolconfig':None},{'rolname':'supabase_admin','rolsuper':True,'rolconfig':None}],
            'memberships':[['supabase_admin','postgres','supabase_admin',True,True,True]]}
        self.schema='CREATE SCHEMA public;\nCREATE TABLE public.fixture (id uuid);'
        self.state={'snapshot':{'catalog':self.schema,'roles':self.roles,'rows':{'private.fixture_'+str(i):'0:fixed'for i in range(178)}}}
        self.source=self.root/'source-state-private.json';self.write(self.source,canon(self.state));source_sha=digest(self.state)
        self.entries=[{'version':str(20261000000000+i),'path':'backend/supabase/migrations/'+str(20261000000000+i)+'_fixture.sql',
            'sha256':hashlib.sha256(str(i).encode()).hexdigest(),'bytes':i+1}for i in range(119)]
        self.manifest.write_bytes(canon({'config_overlay':{'api.port':56541},'migrations':self.entries}))
        receipt={'status':'PASS_NATIVE_CANONICAL_119_APPLICATION_ONLY','migrationCount':119,'nativeDbId':module.NATIVE_SIGNED_SOURCE_ID,'orderedAppliedMigrations':self.entries}
        self.write(self.canonical_root/'receipt.json',canon(receipt));inventory=[];file_map={}
        for e in self.entries:
            value={'commandExit':0,'nativeDbId':module.NATIVE_SIGNED_SOURCE_ID,'sha256':e['sha256'],'storedIn':'PRIVATE_RECEIPT_NOT_DB_HISTORY','version':e['version']}
            name=e['version']+'-applied.json';raw=canon(value);self.write(self.canonical_root/name,raw);sha=hashlib.sha256(raw).hexdigest();file_map[name]=sha
            inventory.append({'receipt':name,'version':e['version'],'sqlSha256':e['sha256'],'commandExit':0,'receiptSha256':sha})
        self.constants={'NATIVE_SIGNED_SOURCE_STATE':self.source,'NATIVE_SIGNED_SOURCE_STATE_SHA':source_sha,
            'NATIVE_SIGNED_CANONICAL_ROOT':self.canonical_root,'NATIVE_SIGNED_CANONICAL_RECEIPT_SHA':digest(receipt),
            'NATIVE_SIGNED_APPLIED_INVENTORY_SHA':digest(inventory),'NATIVE_SIGNED_APPLIED_FILE_MAP_SHA':digest(file_map)}
        self.pins=module.signed_source_pins();self.value['sourcePins']=self.pins
        self.provenance={'version':1,'kind':'NATIVE119_RUNTIME_PROVENANCE','preparedRoot':str(self.root),'preparedManifestSha256':hashlib.sha256(self.manifest.read_bytes()).hexdigest(),
            'sourceStatePath':str(self.source),'sourceStateSha256':source_sha,'cloneBaselineStateSha256':source_sha,
            'canonicalRoot':str(self.canonical_root),'canonicalReceiptSha256':digest(receipt),'canonicalAppliedInventorySha256':digest(inventory),
            'canonicalAppliedFileMapSha256':digest(file_map),'sourceCatalogSha256':hashlib.sha256(self.schema.encode()).hexdigest(),
            'sourcePortableRolesSha256':digest(self.roles),'database':self.value['containers']['db'],'creatorCodeSha256':'c'*64}
        self.provenance_path=self.root/'native119-runtime-provenance.json';self.write(self.provenance_path,canon(self.provenance))
        self.runner=object.__new__(module.SignedRunner);self.runner.root=self.root;self.runner.binding=self.value
        self.runner.target={**self.target,'versions':[e['version']for e in self.entries]};self.runner.base=['docker','--host','unix:///fixed/socket']
        self.runner.signed_identity=Mock();self.runner.sql=Mock(side_effect=AssertionError('DB history forbidden in native lineage'))
        self.commands=[];self.schema_drift=False;self.role_drift=False;self.helper_drift=False
    def fake_process(self,command,**kwargs):
        self.commands.append(command);self.assertEqual(kwargs['timeout'],5)
        if command[0]=='git':
            data=(module.REPO/command[-1].removeprefix('HEAD:')).read_bytes()
            return subprocess.CompletedProcess(command,0,b'# drift'if self.helper_drift else data,b'')
        self.assertEqual(command[:3],self.runner.base);self.assertIn(self.target['id'],command)
        if 'pg_dump'in command:
            self.assertIn('PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000',command)
            self.assertIn('--schema-only',command);self.assertIn('/var/run/postgresql',command)
            value=self.schema+('\nCREATE TABLE public.drift (id uuid);'if self.schema_drift else'')
            return subprocess.CompletedProcess(command,0,('-- header\n\\restrict fixed\n'+value+'\n\\unrestrict fixed\n').encode(),b'')
        self.assertIn('psql',command);self.assertIn('/var/run/postgresql',command)
        self.assertTrue(kwargs['input'].startswith(b'begin read only;'));self.assertIn(b"statement_timeout='5s'",kwargs['input'])
        self.assertNotIn(b'auth.users',kwargs['input']);self.assertNotIn(b'schema_migrations',kwargs['input'])
        roles=copy.deepcopy(self.roles)
        for i,role in enumerate(roles['roles']):role['oid']=12345+i
        if self.role_drift:roles['memberships'][0][-1]=False
        return subprocess.CompletedProcess(command,0,json.dumps(roles).encode(),b'')
    def verify(self):
        with ExitStack()as stack:
            for k,v in self.constants.items():stack.enter_context(patch.object(module,k,v))
            stack.enter_context(patch.object(module,'signed_source_pins',return_value=self.pins))
            stack.enter_context(patch.object(module.subprocess,'run',side_effect=self.fake_process))
            return module.signed_verify_history(self.runner)
    def test_native_actual_catalog_role_ports_match_without_dbhistory(self):
        self.prepare_proofs();result=self.verify()
        self.assertEqual(result['scope'],'NATIVE119_SCHEMA_ROLE_MATCH_LINEAGE');self.assertEqual(result['migrationReplay'],'NOT_RUN')
        self.runner.sql.assert_not_called();self.runner.signed_identity.assert_called_once()
        self.assertEqual(sum('pg_dump'in cmd for cmd in self.commands),1);self.assertEqual(sum('psql'in cmd for cmd in self.commands),1)
    def test_ordinary_history_exact_and_missing_native_proof_is_no_pass(self):
        runner=object.__new__(module.SignedRunner);runner.root=self.root;runner.target={'versions':['119']};runner.sql=Mock(return_value='["119"]')
        self.assertEqual(module.signed_verify_history(runner)['method'],'SUPABASE_DB_HISTORY')
        runner.sql.assert_called_once_with('select json_agg(version order by version)from supabase_migrations.schema_migrations;')
        runner.sql.return_value='[]'
        with self.assertRaisesRegex(ValueError,'APPLIED_HISTORY_CHANGED'):module.signed_verify_history(runner)
        runner.sql.side_effect=ValueError('NATIVE_DB_HISTORY_ABSENT')
        with self.assertRaisesRegex(ValueError,'NATIVE_DB_HISTORY_ABSENT'):module.signed_verify_history(runner)
    def test_forged_provenance_reaches_no_live_db_ports(self):
        self.prepare_proofs();mutations=[lambda v:v.update(version=True),lambda v:v.update(sourceStatePath='/private/tmp/other'),
            lambda v:v.update(sourceStateSha256='0'*64),lambda v:v.update(canonicalAppliedInventorySha256='0'*64),
            lambda v:v.update(preparedManifestSha256='0'*64),lambda v:v['database'].update(id='9'*64),
            lambda v:v.update(sourceCatalogSha256='0'*64),lambda v:v.update(approvedByRoot=True)]
        for mutate in mutations:
            with self.subTest(index=mutations.index(mutate)):
                v=copy.deepcopy(self.provenance);mutate(v);self.provenance_path.write_text(json.dumps(v));self.commands=[]
                with self.assertRaises(ValueError):self.verify()
                self.assertFalse(any(cmd[0]=='docker'for cmd in self.commands));self.runner.sql.assert_not_called()
    def test_missing_changed_receipt_and_source_fail_closed(self):
        self.prepare_proofs();file=self.canonical_root/(self.entries[0]['version']+'-applied.json');raw=file.read_bytes();file.unlink()
        with self.assertRaisesRegex(ValueError,'APPLIED_SET'):self.verify()
        self.write(file,raw);v=json.loads(raw);v['sha256']='0'*64;file.write_text(json.dumps(v))
        with self.assertRaisesRegex(ValueError,'APPLIED_RECEIPT'):self.verify()
        file.write_bytes(raw);self.source.write_bytes(self.source.read_bytes()+b' ')
        with self.assertRaisesRegex(ValueError,'SOURCE_STATE_CHANGED'):self.verify()
        self.assertFalse(any(cmd[0]=='docker'for cmd in self.commands))
    def test_current_schema_and_membership_drift_rejected(self):
        self.prepare_proofs()
        for kind in ('schema','role'):
            with self.subTest(kind=kind):
                self.schema_drift=kind=='schema';self.role_drift=kind=='role';self.commands=[]
                with self.assertRaisesRegex(ValueError,'CURRENT_SCHEMA_ROLES_CHANGED'):self.verify()
                self.assertEqual(sum('pg_dump'in cmd for cmd in self.commands),1);self.assertEqual(sum('psql'in cmd for cmd in self.commands),1)
    def test_uncommitted_helper_never_evaluated_or_given_live_db_ports(self):
        self.prepare_proofs();self.helper_drift=True
        with self.assertRaisesRegex(ValueError,'HELPER_UNCOMMITTED'):self.verify()
        self.assertFalse(any(cmd[0]=='docker'for cmd in self.commands))


def native_restore_test_pin(v):
    return hashlib.sha256(json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()

def native_restore_test_fixture():
    roles = {'roles': [{'rolname': r} for r in ('owner', 'anon', 'postgres')], 'memberships': []}
    a = {'snapshot': {'rows': {'private.item': '0:d41d8cd98f00b204e9800998ecf8427e'}, 'roles': roles, 'catalog': 'CREATE TABLE private.item (id integer);'}, 'rawAuthority': {'database': ['postgres', 'owner'], 'schemas': [['graphql', 'owner', ['anon=U/owner', 'owner=UC/owner', 'postgres=U*/owner']]], 'relations': [['private', 'item', 'r', 'owner', True, False, ['owner=arwdDxtm/owner']], ['private', 'seq', 'S', 'owner', False, False, ['owner=rwU/owner']]], 'columns': [], 'functions': [], 'defaults': [], 'dbRoleSettings': []}, 'effectivePrivileges': [['anon', 'schema', 'graphql', 'USAGE', True], ['postgres', 'schema', 'graphql', 'USAGE WITH GRANT OPTION', True]], 'sequences': {'private.seq': [1, False]}}
    b = copy.deepcopy(a)
    b['rawAuthority']['schemas'][0][-1] = None
    for x in b['rawAuthority']['relations']:
        x[-1] = None
    for x in b['effectivePrivileges']:
        x[-1] = False
    return (a, b)

class NativeRestoreAclValueTests(unittest.TestCase):

    def setUp(self):
        self.native_restore_source = REPO / 'tests/integration/minkyu/product_connection_restore108_local.py'
        self.native_restore_tree = ast.parse(self.native_restore_source.read_bytes())
        names = {'native_restore_json', 'native_restore_source', 'native_restore_ident', 'native_restore_acl_entries', 'native_restore_catalog', 'native_restore_acl_plan', 'native_restore_schema_grant_lines', 'native_restore_compare'}
        nodes = [n for n in self.native_restore_tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
        self.assertEqual({n.name for n in nodes}, names)
        self.assertEqual(len(nodes), len(names))
        self.native_restore_ns = {'json': json, 'hashlib': hashlib, 're': re}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(self.native_restore_source), 'exec'), self.native_restore_ns)

    def test_missing_acl_plan_preserves_grantor_and_grant_options_and_sequence(self):
        a, b = native_restore_test_fixture()
        p = self.native_restore_ns['native_restore_acl_plan'](a, b, native_restore_test_pin(a))
        sql = p['sql']
        self.assertEqual(p['objects'], 3)
        self.assertIn('SET LOCAL ROLE "owner";', sql)
        self.assertIn('GRANT USAGE ON SCHEMA "graphql" TO "postgres" WITH GRANT OPTION;', sql)
        self.assertIn('GRANT USAGE ON SCHEMA "graphql" TO "anon";', sql)
        self.assertIn('REVOKE ALL ON TABLE "private"."item" FROM PUBLIC;', sql)
        self.assertIn('REVOKE ALL ON SEQUENCE "private"."seq" FROM PUBLIC;', sql)
        self.assertNotIn('pg_class', sql)
        self.assertEqual(sql.count('BEGIN;'), 1)

    def test_wrong_source_pin_refuses(self):
        a, b = native_restore_test_fixture()
        with self.assertRaises(AssertionError):
            self.native_restore_ns['native_restore_acl_plan'](a, b, '0' * 64)

    def test_unsafe_identifier_refuses_before_sql(self):
        a, b = native_restore_test_fixture()
        a['rawAuthority']['schemas'][0][0] = 'graphql;DROP ROLE owner'
        b['rawAuthority']['schemas'][0][0] = a['rawAuthority']['schemas'][0][0]
        with self.assertRaises(AssertionError):
            self.native_restore_ns['native_restore_acl_plan'](a, b, native_restore_test_pin(a))

    def test_invalid_or_duplicate_privileges_refuse(self):
        for acl in ('anon=Z/owner', 'anon=UU/owner', 'anon=*U/owner', 'anon=U**/owner', 'anon=U/absent'):
            a, b = native_restore_test_fixture()
            a['rawAuthority']['schemas'][0][-1][0] = acl
            with self.subTest(acl=acl), self.assertRaises(AssertionError):
                self.native_restore_ns['native_restore_acl_plan'](a, b, native_restore_test_pin(a))

    def test_unknown_grantor_and_owneronly_relation_mutant_refuse(self):
        for acl in ('owner=arwdDxtm/anon', 'anon=r/owner', 'owner=arwdDxt/owner'):
            a, b = native_restore_test_fixture()
            a['rawAuthority']['relations'][0][-1] = [acl]
            with self.subTest(acl=acl), self.assertRaises(AssertionError):
                self.native_restore_ns['native_restore_acl_plan'](a, b, native_restore_test_pin(a))

    def test_non_acl_drift_and_privilege_escalation_refuse(self):
        for kind in ('row', 'role', 'sequence', 'constraint', 'effective'):
            a, b = native_restore_test_fixture()
            if kind == 'row':
                b['snapshot']['rows']['private.item'] = '1:mutant'
            elif kind == 'role':
                b['snapshot']['roles']['roles'][0]['rolsuper'] = True
            elif kind == 'sequence':
                b['sequences']['private.seq'][0] = 2
            elif kind == 'constraint':
                b['snapshot']['catalog'] = 'CREATE TABLE private.item (id bigint);'
            else:
                a['effectivePrivileges'][0][-1] = False
                b['effectivePrivileges'][0][-1] = True
            with self.subTest(kind=kind), self.assertRaises(AssertionError):
                self.native_restore_ns['native_restore_acl_plan'](a, b, native_restore_test_pin(a))

    def test_existing_acl_mutation_cannot_be_repaired(self):
        a, b = native_restore_test_fixture()
        b['rawAuthority']['schemas'][0][-1] = ['owner=UC/owner']
        with self.assertRaises(AssertionError):
            self.native_restore_ns['native_restore_acl_plan'](a, b, native_restore_test_pin(a))

    def test_no_delta_has_no_statement_or_repair(self):
        a, _ = native_restore_test_fixture()
        p = self.native_restore_ns['native_restore_acl_plan'](a, copy.deepcopy(a), native_restore_test_pin(a))
        self.assertEqual(p['objects'], 0)
        self.assertEqual(p['sql'], '')

    def test_known_two_check_regroupings_and_policy_order_compare_equal(self):
        source = "CREATE TABLE private.general_sanction_appeal_receipts (\n    CONSTRAINT general_sanction_appeal_receipts_reason_check CHECK ((((length(reason) >= 1) AND (length(reason) <= 4000)) AND (reason = btrim(reason)) AND (reason !~ '[[:cntrl:]]'::text)))\n);\nCREATE TABLE private.worker_jobs (\n    CONSTRAINT worker_jobs_dedupe_key_check CHECK ((((length(dedupe_key) >= 1) AND (length(dedupe_key) <= 512)) AND (dedupe_key ~ '^[A-Za-z0-9_.:-]+$'::text))),\n    id integer\n);\nCREATE POLICY posts_select_not_deleted ON public.posts FOR SELECT TO authenticated, anon USING ((status <> 'deleted'::text));"
        restored = source.replace('(((length(reason) >= 1) AND (length(reason) <= 4000))', '((length(reason) >= 1) AND (length(reason) <= 4000)').replace('(((length(dedupe_key) >= 1) AND (length(dedupe_key) <= 512))', '((length(dedupe_key) >= 1) AND (length(dedupe_key) <= 512)').replace('TO authenticated, anon', 'TO anon, authenticated')
        self.assertEqual(self.native_restore_ns['native_restore_catalog'](source), self.native_restore_ns['native_restore_catalog'](restored))
        for mutant in (restored.replace('<= 4000', '<= 3999'), restored.replace('AND', 'OR', 1), restored.replace("'deleted'", "'closed'"), restored.replace('TO anon, authenticated', 'TO anon, postgres')):
            self.assertNotEqual(self.native_restore_ns['native_restore_catalog'](source), self.native_restore_ns['native_restore_catalog'](mutant))

    def test_cumulative_default_grants_order_only_no_revoke_or_cross_block(self):
        one = 'ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA graphql GRANT ALL ON TABLES TO anon;'
        two = 'ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA graphql GRANT ALL ON TABLES TO postgres WITH GRANT OPTION;'
        self.assertEqual(self.native_restore_ns['native_restore_catalog'](one + '\n' + two), self.native_restore_ns['native_restore_catalog'](two + '\n' + one))
        self.assertNotEqual(self.native_restore_ns['native_restore_catalog'](one + '\n' + two), self.native_restore_ns['native_restore_catalog'](one + '\n' + two.replace(' WITH GRANT OPTION', '')))
        self.assertNotEqual(self.native_restore_ns['native_restore_catalog'](one + '\nREVOKE ALL ON TABLE private.item FROM PUBLIC;\n' + two), self.native_restore_ns['native_restore_catalog'](two + '\nREVOKE ALL ON TABLE private.item FROM PUBLIC;\n' + one))

    def test_final_comparison_strict_raw_acl_privileges_and_bool_int(self):
        a, _ = native_restore_test_fixture()
        self.assertEqual(self.native_restore_ns['native_restore_compare'](a, copy.deepcopy(a), native_restore_test_pin(a))['status'], 'EXACT_NATIVE_STATE_WITH_NARROW_PRESENTATION')
        for field in ('rawAuthority', 'effectivePrivileges', 'sequences'):
            b = copy.deepcopy(a)
            if field == 'rawAuthority':
                b[field]['schemas'][0][-1] = None
            elif field == 'effectivePrivileges':
                b[field][1][-1] = False
            else:
                b[field]['private.seq'][1] = 0
            with self.subTest(field=field), self.assertRaises(AssertionError):
                self.native_restore_ns['native_restore_compare'](a, b, native_restore_test_pin(a))

    def test_recorded_graphql_extra_grant_only_after_complete_authority_equal(self):
        a, _ = native_restore_test_fixture()
        b = copy.deepcopy(a)
        b['snapshot']['catalog'] += '\nGRANT USAGE ON SCHEMA graphql TO anon;\nGRANT USAGE ON SCHEMA graphql TO postgres WITH GRANT OPTION;'
        self.assertEqual(self.native_restore_ns['native_restore_compare'](a, b, native_restore_test_pin(a))['status'], 'EXACT_NATIVE_STATE_WITH_NARROW_PRESENTATION')
        for line in ('GRANT CREATE ON SCHEMA graphql TO anon;', 'GRANT USAGE ON SCHEMA private TO anon;', 'GRANT USAGE ON SCHEMA graphql TO postgres;'):
            bad = copy.deepcopy(a)
            bad['snapshot']['catalog'] += '\n' + line
            with self.subTest(line=line), self.assertRaises(AssertionError):
                self.native_restore_ns['native_restore_compare'](a, bad, native_restore_test_pin(a))
        b['rawAuthority']['schemas'][0][-1] = None
        with self.assertRaises(AssertionError):
            self.native_restore_ns['native_restore_compare'](a, b, native_restore_test_pin(a))

    def test_schema_grant_text_inside_dollar_or_single_quoted_body_is_not_filtered(self):
        grant = 'GRANT USAGE ON SCHEMA graphql TO anon;'
        for start, end in (('CREATE FUNCTION private.f() RETURNS void LANGUAGE plpgsql AS $body$', '$body$;'), ("CREATE FUNCTION private.f() RETURNS void LANGUAGE plpgsql AS '", "';")):
            a, _ = native_restore_test_fixture()
            a['snapshot']['catalog'] = start + '\n' + grant + '\n' + end
            b = copy.deepcopy(a)
            b['snapshot']['catalog'] = b['snapshot']['catalog'].replace(grant, '')
            with self.subTest(start=start), self.assertRaises(AssertionError):
                self.native_restore_ns['native_restore_compare'](a, b, native_restore_test_pin(a))

    def test_nested_comment_and_parenthesis_grant_text_is_not_filtered(self):
        grant = 'GRANT USAGE ON SCHEMA graphql TO anon;'
        for start, end in (('/* outer /* inner */', '*/'), ('CREATE TABLE private.x (', ');')):
            a, _ = native_restore_test_fixture()
            a['snapshot']['catalog'] = start + '\n' + grant + '\n' + end
            b = copy.deepcopy(a)
            b['snapshot']['catalog'] = b['snapshot']['catalog'].replace(grant, '')
            with self.subTest(start=start), self.assertRaises(AssertionError):
                self.native_restore_ns['native_restore_compare'](a, b, native_restore_test_pin(a))

    def test_default_grant_body_order_and_unknown_check_grouping_remain_strict(self):
        one = 'ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA graphql GRANT ALL ON TABLES TO anon;'
        two = one.replace('TO anon', 'TO postgres')
        a = 'CREATE FUNCTION private.f() RETURNS void LANGUAGE plpgsql AS $$\n' + one + '\n' + two + '\n$$;'
        b = a.replace(one + '\n' + two, two + '\n' + one)
        self.assertNotEqual(self.native_restore_ns['native_restore_catalog'](a), self.native_restore_ns['native_restore_catalog'](b))
        self.assertNotEqual(self.native_restore_ns['native_restore_catalog']('CHECK (((x AND y) AND z))'), self.native_restore_ns['native_restore_catalog']('CHECK ((x AND y AND z))'))

    def test_plain_string_and_identifier_backslash_do_not_escape_closing_quote(self):
        grant = 'GRANT USAGE ON SCHEMA graphql TO anon;'
        for prefix in ("SELECT 'x\\';", 'SELECT "x\\";'):
            with self.subTest(prefix=prefix):
                self.assertEqual(self.native_restore_ns['native_restore_catalog'](prefix + '\n' + grant, (grant,)), self.native_restore_ns['native_restore_catalog'](prefix, (grant,)))
        prefix = "SELECT E'x\\'\n"
        suffix = "\n';"
        self.assertNotEqual(self.native_restore_ns['native_restore_catalog'](prefix + grant + suffix, (grant,)), self.native_restore_ns['native_restore_catalog'](prefix + suffix, (grant,)))

    def test_final_grant_option_and_grantor_mutants_refused_even_same_effective(self):
        a, _ = native_restore_test_fixture()
        for bad_acl in ('postgres=U/owner', 'postgres=U*/anon'):
            b = copy.deepcopy(a)
            b['rawAuthority']['schemas'][0][-1][-1] = bad_acl
            with self.subTest(acl=bad_acl), self.assertRaises(AssertionError):
                self.native_restore_ns['native_restore_compare'](a, b, native_restore_test_pin(a))

    def test_unsupported_off_mode_and_escape_continuation_refuse(self):
        for text in ("SET standard_conforming_strings = off;\nSELECT 'x';", "SELECT E'foo'\n'bar\\baz';", 'CREATE FUNCTION private.f() RETURNS void LANGUAGE SQL BEGIN ATOMIC\nSELECT 1;\nEND;'):
            with self.subTest(text=text), self.assertRaises(AssertionError):
                self.native_restore_ns['native_restore_catalog'](text)

    def test_original_runner_fresh_restore_wired_once_and_not_source(self):
        fn = next((n for n in self.native_restore_tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_native_final_backup'))
        text = ast.get_source_segment(self.native_restore_source.read_text(), fn)
        self.assertIn('native_restore_acl_plan(', text)
        self.assertIn('native_restore_compare(', text)
        self.assertIn("query(target,acl_plan['sql'],write=True)", text)
        self.assertNotIn('query(source,acl_plan', text)

class NativeSignedHistoryV2Tests(unittest.TestCase):
    """실제 호출 없는 v2 모형. 현재 ACL/권한 읽기는 원 선택 helper를 실행한다."""
    setUp=BindingTests.setUp
    tearDown=BindingTests.tearDown
    write=BindingTests.write
    verify=NativeSignedHistoryTests.verify
    def prepare_proofs(self):
        NativeSignedHistoryTests.prepare_proofs(self)
        self.roles['roles'].extend({'rolname':r,'rolsuper':False,'rolconfig':None}for r in('anon','authenticated','service_role'))
        self.roles['roles'].sort(key=lambda r:r['rolname'])
        grants=['=U/postgres','anon=U/postgres','authenticated=U/postgres','postgres=UC/postgres','service_role=U/postgres']
        authority={'database':['postgres','postgres'],
            'schemas':[[n,'postgres',grants.copy()]for n in('graphql','graphql_public')],
            'relations':[],'columns':[],'functions':[],'defaults':[],'dbRoleSettings':[]}
        keys=[('database','postgres',p)for p in('CONNECT','CREATE','TEMPORARY','CONNECT WITH GRANT OPTION','CREATE WITH GRANT OPTION','TEMPORARY WITH GRANT OPTION')]
        keys.extend(('schema',n,'USAGE')for n in('graphql','graphql_public'))
        self.permission_keys=keys;self.permission_roles=sorted([r['rolname']for r in self.roles['roles']]+['public'])
        effective=[[r,*key,True]for r in self.permission_roles for key in keys]
        self.state.update(rawAuthority=authority,effectivePrivileges=effective,sequences={'public.fixture_seq':[4,True]})
        self.state['snapshot']['roles']=copy.deepcopy(self.roles)
        self.source.write_bytes(module.json.dumps(self.state,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode())
        sha=hashlib.sha256(self.source.read_bytes()).hexdigest();self.constants['NATIVE_SIGNED_SOURCE_STATE_SHA']=sha
        self.provenance.update(version=2,sourceStateSha256=sha,sourcePortableRolesSha256=hashlib.sha256(module.json.dumps(self.roles,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest())
        self.baseline=copy.deepcopy(self.state)
        lines=['GRANT USAGE ON SCHEMA '+n+' TO '+r+';'for n in('graphql','graphql_public')for r in('PUBLIC','anon','authenticated','service_role')]
        self.baseline['snapshot']['catalog']=self.schema+'\n'+'\n'.join(lines)
        self.baseline_path=self.root/'native119-clone-baseline-private.json';self.write(self.baseline_path,b'{}')
        self.current_authority=copy.deepcopy(authority);self.current_effective=copy.deepcopy(effective)
        self.live_schema=self.baseline['snapshot']['catalog'];self.calls=[]
        self.persist_baseline();self.persist_provenance()
    def persist_baseline(self):
        raw=json.dumps(self.baseline,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode();self.baseline_path.write_bytes(raw)
        self.provenance.update(cloneBaselineStatePath=str(self.baseline_path),cloneBaselineStateSha256=hashlib.sha256(raw).hexdigest())
    def persist_provenance(self):self.provenance_path.write_text(json.dumps(self.provenance))
    def fake_process(self,command,**kwargs):
        if command[0]=='git':return NativeSignedHistoryTests.fake_process(self,command,**kwargs)
        self.commands.append(command);self.assertEqual(kwargs['timeout'],5);self.assertEqual(command[:3],self.runner.base)
        if 'pg_dump'in command:
            return subprocess.CompletedProcess(command,0,(self.live_schema+('\nCREATE TABLE public.drift (id uuid);'if self.schema_drift else'')).encode(),b'')
        sql=kwargs['input'].decode();self.assertTrue(sql.startswith('begin read only;'));self.assertIn('/var/run/postgresql',command)
        if "'database',(select"in sql:
            value=self.current_authority;self.calls.append('raw')
        elif "json_agg(rolname order by rolname)"in sql:value=self.permission_roles
        elif "to_jsonb(r)-'oid'"in sql:value=self.roles
        elif 'x.allowed'in sql:
            match=__import__('re').search(r"decode\('([a-f0-9]+)','hex'\)",sql);self.assertIsNotNone(match)
            role=bytes.fromhex(match[1]).decode();value=[row for row in self.current_effective if row[0]==role];self.calls.append('effective')
        else:
            value=copy.deepcopy(self.roles)
            for i,r in enumerate(value['roles']):r['oid']=12345+i
            if self.role_drift:value['memberships'][0][-1]=False
        return subprocess.CompletedProcess(command,0,json.dumps(value).encode(),b'')
    def test_v2_verified_baseline_and_live_authority_accept_known_eight_grant_lines(self):
        self.prepare_proofs();result=self.verify()
        self.assertEqual(result['scope'],'NATIVE119_SCHEMA_ROLE_RAW_ACL_EFFECTIVE_MATCH_LINEAGE')
        self.assertEqual(result['creatorAuthorization'],'NOT_GRANTED');self.assertIn('raw',self.calls);self.assertIn('effective',self.calls)
        self.runner.sql.assert_not_called();self.runner.signed_identity.assert_called_once()
    def test_v2_missing_eight_acl_grantor_option_or_effective_change_refused_before_dump_normalization(self):
        self.prepare_proofs()
        for case in('missing8','grantor','option','effective'):
            with self.subTest(case=case):
                self.current_authority=copy.deepcopy(self.state['rawAuthority']);self.current_effective=copy.deepcopy(self.state['effectivePrivileges'])
                if case=='missing8':
                    for row in self.current_authority['schemas']:row[-1]=['postgres=UC/postgres']
                elif case=='grantor':self.current_authority['schemas'][0][-1][1]='anon=U/supabase_admin'
                elif case=='option':self.current_authority['schemas'][0][-1][1]='anon=U*/postgres'
                else:self.current_effective[0][-1]=False
                with self.assertRaisesRegex(ValueError,'CURRENT_AUTHORITY_CHANGED'):self.verify()
    def test_v2_baseline_full_rows_roles_sequences_acl_and_hash_refused(self):
        self.prepare_proofs();original=copy.deepcopy(self.baseline)
        for case in('row','role','sequence','acl','effective','hash'):
            with self.subTest(case=case):
                self.baseline=copy.deepcopy(original)
                if case=='row':self.baseline['snapshot']['rows']['private.fixture_0']='1:changed'
                elif case=='role':self.baseline['snapshot']['roles']['memberships'][0][-1]=False
                elif case=='sequence':self.baseline['sequences']['public.fixture_seq'][0]+=1
                elif case=='acl':self.baseline['rawAuthority']['schemas'][0][-1][1]='anon=U*/postgres'
                elif case=='effective':self.baseline['effectivePrivileges'][0][-1]=False
                self.persist_baseline()
                if case=='hash':self.provenance['cloneBaselineStateSha256']='0'*64
                self.persist_provenance();self.commands=[]
                with self.assertRaises((ValueError,AssertionError)):self.verify()
                self.assertFalse(any(c[0]=='docker'for c in self.commands))
    def test_v2_baseline_path_link_mode_size_and_schema_drift_refused(self):
        self.prepare_proofs()
        original=dict(self.provenance)
        for path in(str(self.source),str(self.root/'other.json'),str(self.root/'sub/../native119-clone-baseline-private.json')):
            self.provenance={**original,'cloneBaselineStatePath':path};self.persist_provenance();self.commands=[]
            with self.assertRaisesRegex(ValueError,'BASELINE_BINDING'):self.verify()
            self.assertFalse(any(c[0]=='docker'for c in self.commands))
        self.provenance=original;self.persist_provenance();raw=self.baseline_path.read_bytes();self.baseline_path.unlink();self.baseline_path.symlink_to(self.source)
        with self.assertRaises((ValueError,AssertionError,OSError)):self.verify()
        self.baseline_path.unlink();self.write(self.baseline_path,raw);self.baseline_path.chmod(0o644)
        with self.assertRaises((ValueError,AssertionError)):self.verify()
        self.baseline_path.chmod(0o600);self.schema_drift=True
        with self.assertRaisesRegex(ValueError,'CURRENT_SCHEMA_ROLES_CHANGED'):self.verify()
    def test_v2_live_role_and_current_helper_drift_refused(self):
        self.prepare_proofs();self.role_drift=True
        with self.assertRaisesRegex(ValueError,'CURRENT_SCHEMA_ROLES_CHANGED'):self.verify()
        self.role_drift=False;self.helper_drift=True;self.commands=[]
        with self.assertRaisesRegex(ValueError,'HELPER_UNCOMMITTED'):self.verify()
        self.assertFalse(any(c[0]=='docker'for c in self.commands))


class FakeLifecycleProvisioningPorts:
    """독립 행 모형. 실제 GoTrue/DB/clock 변경은 없다."""
    def __init__(self, value):
        self.value=value;self.now=1900000000;self.users={};self.accounts=[];self.calls=[];self.memory=1100000
        self.extra=False;self.authority=False;self.constraints=False;self.catalog=False;self.open=False;self.lose=None;self.replaced=False
        self.login_user_changed=False
        self.wrong_jwt=False
        self.server_error=False
        self.rows={t:{} for t in ('auth.users','auth.sessions','auth.identities','auth.refresh_tokens','auth.audit_log_entries',
            'auth.mfa_amr_claims','public.profiles','private.member_episodes','private.ai_budget_ledgers','private.worker_invocations','storage.objects')}
        self.rows.update({t:{}for t in ('private.ai_budget_reservations','private.ai_account_budget_reservations','private.ai_account_daily_budget','private.ai_global_daily_budget')})
    def identity(self):return self.value['containers']
    def memory_kib(self):return self.memory
    def settings(self):return {'jwtExpirySeconds':3600,'anonymousEnabled':False,'signupDisabled':True}
    def history(self):return {'method':'MODEL_ONLY'}
    def closed_controls(self):return {**{k:False for k in module.PROVISION_CLOSED_CONTROLS},'cronLaunchActiveJobs':'off',**({'worker_invocation_control':True}if self.open else{})}
    def empty_auth(self):return not self.users
    def snapshot(self):
        rows=copy.deepcopy(self.rows)
        if self.extra:rows['private.worker_invocations']['f'*64]=1
        return {'rows':rows,'authoritySha256':('b'if self.authority else'a')*64,'constraintsSha256':('d'if self.constraints else'c')*64,'catalogSha256':('f'if self.catalog else'e')*64}
    def added_rows(self, baseline, accounts):
        result={t:{}for t in self.rows if t.startswith('auth.')or t in ('public.profiles','private.member_episodes')}
        for a in accounts:
            for table in result:
                for op in (('user_signedup','login')if table=='auth.audit_log_entries'else('row',)):
                    h=hashlib.sha256((table+a['userId']+op).encode()).hexdigest()
                    result[table][h]={'rowSha256':h,'ownerUserId':a['userId'],'operation':op}
        return result
    def resolve_email(self,email):
        if self.replaced and email in self.users:return str(uuid.uuid4())
        return self.users.get(email,{}).get('id')
    def request_original(self,path,payload):
        self.calls.append(('POST',path))
        if path=='/admin/users':
            u={'id':str(uuid.uuid4()),'email':payload['email'],'role':'authenticated','is_anonymous':False,'user_metadata':{**payload['user_metadata'],'email_verified':True}}
            self.users[u['email']]=u;body=u
        else:
            u=self.users[payload['email']];sid=str(uuid.uuid4())
            body={'user':u,'access_token':jwt({'sub':u['id'],'session_id':sid,'iat':self.now,'exp':self.now+3600,
                'iss':self.value['origin']+'/auth/v1','email':u['email'],'aud':'authenticated','role':'authenticated','is_anonymous':False}),
                'token_type':'bearer','expires_in':3600,'expires_at':self.now+3600,'refresh_token':'model-private-refresh'}
            if self.login_user_changed:body['user']={**u,'last_sign_in_at':'2030-03-17T00:00:00Z'}
            if self.wrong_jwt:
                claims=module.signed_claims(body['access_token']);claims['iss']='https://outside.invalid';body['access_token']=jwt(claims)
            a={'userId':u['id'],'sessionId':sid,'authEmail':u['email'],'accessToken':body['access_token'],'expiresAt':self.now+3600}
            self.accounts.append(a)
        if self.lose==path:raise TimeoutError('RAW_SECRET_MUST_NOT_ESCAPE')
        return (500 if self.server_error else 200),json.dumps(body).encode()
    def request(self,method,path,payload=None,token=None,admin=False):
        self.calls.append((method,path))
        if path=='/user':
            c=module.signed_claims(token);u=self.users.get(c['email']);return (200,u)if u and c['exp']>self.now else(403,{})
        uid=path.rsplit('/',1)[1];u=next((x for x in self.users.values()if x['id']==uid),None)
        if method=='DELETE':
            if u:self.users.pop(u['email'])
            # 현재 모형 cleanup은 원 비소유 bag를 별도로 복원한다. 삭제 audit는 allowed bag다.
            self.rows={t:{}for t in self.rows}
            return 200,{}
        return (200,u)if u else(404,{})
    def link_profile(self,uid):
        added=self.added_rows({},self.accounts)
        self.rows.update({t:{r['rowSha256']:1 for r in entries.values()}for t,entries in added.items()});return True
    def session_proof(self,a):return any(x['userId']==a['userId']and x['sessionId']==a['sessionId']for x in self.accounts)
    def metadata_proof(self,a,scope,case):return self.users[a['authEmail']]['user_metadata']=={'fixture_scope_id':scope,'fixture_case':case,'email_verified':True}
    def unlink_profile(self,uid):pass
    def cleanup_audits(self,created):return {}


class LifecycleProvisioningTests(unittest.TestCase):
    setUp=BindingTests.setUp
    tearDown=BindingTests.tearDown
    write=BindingTests.write
    def context(self):
        return ExitStack()
    def reviewed(self):
        self.ports=FakeLifecycleProvisioningPorts(self.value)
        return module.ReviewedLifecycleProvisioning('offline-staged-model',self.root,self.value['sourcePins'],
            self.value['containers'],self.value['credentials'],'e'*32,self.ports)
    def invoke(self, fn, *args):
        with patch.object(module,'provisioning_source_check',return_value='a'*40),patch.object(module,'signed_prepared_target',return_value=self.target),\
             patch.object(module,'signed_source_pins',return_value=self.value['sourcePins']),patch.object(module.time,'time',side_effect=lambda:self.ports.now):
            return fn(*args)
    def stage(self):
        self.review=self.reviewed();return self.invoke(module.stage_lifecycle_accounts,self.review)
    def late(self):
        stage=self.stage();self.ports.now+=2700
        return self.invoke(module.resume_lifecycle_accounts,self.review,stage['stateSha256'])
    def test_early_original_token_is_durable_and_stage_does_not_wait_or_create_six(self):
        self.assertTrue(hasattr(module,'stage_lifecycle_accounts'),'staged producer not implemented')
        stage=self.stage()
        self.assertEqual(stage['status'],'STAGED_ORIGINAL_TOKEN_NOT_EXECUTED')
        self.assertEqual(self.ports.calls.count(('POST','/admin/users')),1)
        self.assertEqual(self.ports.calls.count(('POST','/token?grant_type=password')),1)
        self.assertEqual(stage['readyNotBefore'],1900003540)
        self.assertFalse((self.root/'signed-ai-binding-private.json').exists())
        state=self.root/('auth-lifecycle-provision-'+'e'*32)/'stage-private.json'
        self.assertEqual(state.stat().st_mode&0o777,0o600)
        self.assertEqual(hashlib.sha256(state.read_bytes()).hexdigest(),stage['stateSha256'])
    def test_fresh_process_late_then_get_only_window_handoff_preserves_expire_identity(self):
        late=self.late();early=copy.deepcopy(self.ports.accounts[0]);posts=list(self.ports.calls)
        self.ports.now=1900003570
        # 새 검토 객체는 원 private state로만 이어지며 expire는 재로그인하지 않는다.
        second=module.ReviewedLifecycleProvisioning('offline-staged-model',self.root,self.value['sourcePins'],
            self.value['containers'],self.value['credentials'],'e'*32,self.ports)
        result=self.invoke(module.bind_lifecycle_accounts,second,late['stateSha256'])
        self.assertEqual(result['status'],'MODEL_LIFECYCLE_INPUT_BOUND_NOT_EXECUTED')
        self.assertEqual(len(self.ports.users),9)
        self.assertEqual([c for c in self.ports.calls if c[0]=='POST'],[c for c in posts if c[0]=='POST'])
        binding=json.loads((self.root/'signed-ai-binding-private.json').read_bytes())
        value=json.loads((self.root/('auth-lifecycle-input-'+'e'*32+'.json')).read_bytes())
        self.assertEqual(value['accounts']['expiredBearer']['userId'],early['userId'])
        self.assertEqual(value['accounts']['expiredBearer']['accessToken'],early['accessToken'])
        self.assertEqual(len(binding['accounts']),6);self.assertFalse(binding['approvedByRoot'])
        self.assertIsNone(value['accounts']['anonymousBearer']);self.assertIsNone(value['foreign'])
        for a in binding['accounts']:self.assertGreater(a['expiresAt']-self.ports.now,300)
        self.assertFalse(Path(value['evidenceRoot']).exists())
        approved=module.ReviewedSignedAuthLifecycle('model',self.root,self.root/'signed-ai-binding-private.json',self.root/('auth-lifecycle-input-'+'e'*32+'.json'),
            result['bindingSha256'],result['inputSha256'],self.value['sourcePins'],self.value['containers'],result['issuanceProofs'])
        for case in ('expiredBearer','revokedSession','memberChanged'):
            module.lifecycle_issuance(self.root,binding,value,case,approved)
        # 원 reviewed API의 경로·private bytes 검사를 실제로 통과하고 closed flag에서 멈춘다.
        with patch.object(module,'signed_prepared_target',return_value=self.target),patch.object(module,'signed_source_pins',return_value=self.value['sourcePins']),\
             patch.object(module.time,'time',return_value=self.ports.now):
            with self.assertRaisesRegex(ValueError,'LIFECYCLE_APPROVAL_SLOT_REQUIRED'):
                module.run_signed_auth_lifecycle(approved,binding,value,sys.executable)
    def test_single_stage_and_resume_never_replay_original_post(self):
        stage=self.stage();before=list(self.ports.calls)
        with self.assertRaises(ValueError):self.invoke(module.stage_lifecycle_accounts,self.review)
        self.assertEqual(self.ports.calls,before)
        self.ports.now+=2700;self.invoke(module.resume_lifecycle_accounts,self.review,stage['stateSha256']);before=list(self.ports.calls)
        with self.assertRaises(ValueError):self.invoke(module.resume_lifecycle_accounts,self.review,stage['stateSha256'])
        self.assertEqual(self.ports.calls,before)
    def test_lost_create_stays_unknown_even_first_lookup_absent_and_blocks_late(self):
        self.review=self.reviewed();self.ports.lose='/admin/users'
        with self.assertRaisesRegex(ValueError,'LCP_FAILED_PRIVATE'):self.invoke(module.stage_lifecycle_accounts,self.review)
        path=self.root/('auth-lifecycle-provision-'+'e'*32)
        failure=json.loads((path/'failure-stage.json').read_bytes())
        self.assertEqual(failure['status'],'UNKNOWN');self.assertEqual(self.ports.calls.count(('POST','/admin/users')),1)
        self.assertNotIn('RAW_SECRET',json.dumps(failure))
        self.assertFalse((path/'stage-private.json').exists())
    def test_source_state_hash_or_original_rows_drift_refuses_before_late_mutation(self):
        stage=self.stage();before=list(self.ports.calls);self.ports.extra=True
        with self.assertRaisesRegex(ValueError,'LCP_FAILED_PRIVATE'):self.invoke(module.resume_lifecycle_accounts,self.review,stage['stateSha256'])
        self.assertEqual([c for c in self.ports.calls if c[0]=='POST'],[c for c in before if c[0]=='POST'])
    def test_window_handoff_rejects_early_and_expired_without_token_renewal(self):
        late=self.late();posts=[c for c in self.ports.calls if c[0]=='POST']
        with self.assertRaises(ValueError):self.invoke(module.bind_lifecycle_accounts,self.review,late['stateSha256'])
        self.assertEqual([c for c in self.ports.calls if c[0]=='POST'],posts)
    def test_closed_controls_and_original_budget_added_rows_are_not_exempt(self):
        review=self.reviewed();self.ports.open=True
        with self.assertRaises(ValueError):self.invoke(module.stage_lifecycle_accounts,review)
        self.assertEqual(self.ports.calls,[])
    def test_json_flags_cannot_create_reviewed_mutation_contract(self):
        with self.assertRaisesRegex(ValueError,'LCP_REVIEWED_CODE_REQUIRED'):
            module.stage_lifecycle_accounts({'approvedByRoot':True})
    def test_actual_login_user_timestamp_update_is_not_a_changed_original_identity(self):
        self.review=self.reviewed();self.ports.login_user_changed=True
        receipt=self.invoke(module.stage_lifecycle_accounts,self.review)
        self.assertEqual(receipt['status'],'STAGED_ORIGINAL_TOKEN_NOT_EXECUTED')
    def test_cleanup_different_uuid_same_email_deletes_nothing_and_retains_unknown(self):
        self.review=self.reviewed();self.ports.lose='/token?grant_type=password'
        with self.assertRaises(ValueError):self.invoke(module.stage_lifecycle_accounts,self.review)
        self.ports.replaced=True
        p=self.root/('auth-lifecycle-provision-'+'e'*32)/'failure-stage.json'
        result=self.invoke(module.cleanup_lifecycle_accounts,self.review,'stage',hashlib.sha256(p.read_bytes()).hexdigest())
        self.assertEqual(result['status'],'UNKNOWN')
        self.assertFalse(any(method=='DELETE'for method,path in self.ports.calls))
    def test_cleanup_original_known_uuid_once_unknown_login_never_resurrects(self):
        self.review=self.reviewed();self.ports.lose='/token?grant_type=password'
        with self.assertRaises(ValueError):self.invoke(module.stage_lifecycle_accounts,self.review)
        p=self.root/('auth-lifecycle-provision-'+'e'*32)/'failure-stage.json'
        digest=hashlib.sha256(p.read_bytes()).hexdigest()
        result=self.invoke(module.cleanup_lifecycle_accounts,self.review,'stage',digest)
        self.assertEqual(result['status'],'UNKNOWN')
        self.assertEqual(sum(method=='DELETE'for method,path in self.ports.calls),1)
        before=list(self.ports.calls)
        with self.assertRaises(ValueError):self.invoke(module.cleanup_lifecycle_accounts,self.review,'stage',digest)
        self.assertEqual(self.ports.calls,before)
    def test_cleanup_zero_known_ids_does_not_clear_inflight_create_uncertainty(self):
        self.review=self.reviewed();self.ports.lose='/admin/users'
        with self.assertRaises(ValueError):self.invoke(module.stage_lifecycle_accounts,self.review)
        self.ports.users={}
        p=self.root/('auth-lifecycle-provision-'+'e'*32)/'failure-stage.json'
        result=self.invoke(module.cleanup_lifecycle_accounts,self.review,'stage',hashlib.sha256(p.read_bytes()).hexdigest())
        self.assertEqual(result['status'],'UNKNOWN');self.assertFalse(result['preservationProven'])
    def test_fresh_startup_floor_is_rechecked_after_slow_preservation_before_late_post(self):
        stage=self.stage();before=[c for c in self.ports.calls if c[0]=='POST']
        self.ports.now+=2700;native=self.ports.snapshot
        def slow_read():
            result=native();self.ports.memory=1048575;return result
        self.ports.snapshot=slow_read
        with self.assertRaises(ValueError):self.invoke(module.resume_lifecycle_accounts,self.review,stage['stateSha256'])
        self.assertEqual([c for c in self.ports.calls if c[0]=='POST'],before)
    def test_known_failed_issuance_cleanup_is_failure_scope_not_lifecycle_pass(self):
        self.review=self.reviewed();self.ports.metadata_proof=lambda *args:False
        with self.assertRaises(ValueError):self.invoke(module.stage_lifecycle_accounts,self.review)
        p=self.root/('auth-lifecycle-provision-'+'e'*32)/'failure-stage.json'
        result=self.invoke(module.cleanup_lifecycle_accounts,self.review,'stage',hashlib.sha256(p.read_bytes()).hexdigest())
        self.assertEqual(result['status'],'FAIL_OWNED_PREPARATION_CLEANUP_PROVEN')
        self.assertTrue(result['preservationProven']);self.assertEqual(result['actualLifecycle'],'NOT_RUN')
    def test_initial_nonzero_budget_refuses_before_any_auth_post(self):
        self.review=self.reviewed();self.ports.rows['private.ai_global_daily_budget']['f'*64]=1
        with self.assertRaises(ValueError):self.invoke(module.stage_lifecycle_accounts,self.review)
        self.assertEqual(self.ports.calls,[])
    def test_authority_or_constraint_drift_never_authorizes_late_issuance(self):
        for field in ('authority','constraints','catalog'):
            with self.subTest(field=field):
                other=LifecycleProvisioningTests();other.setUp()
                try:
                    stage=other.stage();setattr(other.ports,field,True);before=list(other.ports.calls)
                    with self.assertRaises(ValueError):other.invoke(module.resume_lifecycle_accounts,other.review,stage['stateSha256'])
                    self.assertEqual([x for x in other.ports.calls if x[0]=='POST'],[x for x in before if x[0]=='POST'])
                finally:other.tearDown()
    def test_private_stage_hardlink_and_wrong_sha_refuse_before_resume_calls(self):
        stage=self.stage();before=list(self.ports.calls)
        state=self.root/('auth-lifecycle-provision-'+'e'*32)/'stage-private.json'
        os.link(state,state.with_name('extra.json'))
        with self.assertRaises(ValueError):self.invoke(module.resume_lifecycle_accounts,self.review,stage['stateSha256'])
        self.assertEqual(self.ports.calls,before)
    def test_pending_source_head_change_refuses_without_hydrating_any_port(self):
        stage=self.stage();before=list(self.ports.calls)
        with patch.object(module,'provisioning_source_check',return_value='b'*40),patch.object(module,'signed_prepared_target',return_value=self.target):
            with self.assertRaises(ValueError):module.resume_lifecycle_accounts(self.review,stage['stateSha256'])
        self.assertEqual(self.ports.calls,before)
    def test_fixed_ports_preserve_wire_bytes_and_scope_no_anonymous_or_refresh(self):
        ports=object.__new__(module.FixedLifecycleProvisioningPorts)
        for path in('/signup','/token?grant_type=refresh_token','/logout?scope=local'):
            with self.assertRaises(ValueError):ports.request_original(path,{})
        queried=[]
        ports.read_sql=lambda query,timeout=3:(queried.append(query)or'{}')
        with patch.object(module.FixedSignedProvisioningPorts,'added_rows',return_value={t:{}for t in module.PROVISION_OWNED_TABLES}):
            ports.added_rows({},[{'userId':str(uuid.uuid4()),'sessionId':str(uuid.uuid4())}])
        self.assertIn("r.authentication_method='password'",queried[0])
        self.assertIn('r.session_id::text=a.session_id',queried[0])
    def test_post_response_journal_failure_retains_known_uuid_and_never_replays(self):
        self.review=self.reviewed();native=module.lcp_save
        def broken(root,name,value):
            if name=='expiredBearer-created.json':raise OSError('PRIVATE_IO_SECRET')
            return native(root,name,value)
        with patch.object(module,'lcp_save',side_effect=broken):
            with self.assertRaises(ValueError):self.invoke(module.stage_lifecycle_accounts,self.review)
        failure=json.loads((self.root/('auth-lifecycle-provision-'+'e'*32)/'failure-stage.json').read_bytes())
        self.assertEqual(failure['created']['expiredBearer']['userId'],next(iter(self.ports.users.values()))['id'])
        self.assertEqual(failure['status'],'UNKNOWN');self.assertNotIn('PRIVATE_IO_SECRET',json.dumps(failure))
        self.assertEqual(self.ports.calls.count(('POST','/admin/users')),1)
        self.assertFalse(any(path=='/token?grant_type=password'for method,path in self.ports.calls))
    def test_monitor_failure_always_joins_even_when_done_was_already_set(self):
        import threading
        self.review=self.reviewed();created=[];native=module.threading.Thread
        def capture(*args,**kwargs):
            t=native(*args,**kwargs);created.append(t);return t
        self.ports.memory_kib=lambda:1100000 if threading.current_thread()is threading.main_thread()else 786431
        with patch.object(module.threading,'Thread',side_effect=capture):
            with self.assertRaises(ValueError):self.invoke(module.stage_lifecycle_accounts,self.review)
        self.assertEqual(len(created),1);self.assertFalse(created[0].is_alive());self.assertEqual(self.ports.calls,[])
    def test_late_lost_create_is_single_attempt_and_preserves_original_expire_token(self):
        stage=self.stage();original=copy.deepcopy(self.ports.accounts[0]);self.ports.now+=2700;self.ports.lose='/admin/users'
        with self.assertRaises(ValueError):self.invoke(module.resume_lifecycle_accounts,self.review,stage['stateSha256'])
        self.assertEqual(self.ports.accounts[0],original)
        self.assertEqual(self.ports.calls.count(('POST','/admin/users')),2)
        self.assertEqual(self.ports.calls.count(('POST','/token?grant_type=password')),1)
        before=list(self.ports.calls)
        with self.assertRaises(ValueError):self.invoke(module.resume_lifecycle_accounts,self.review,stage['stateSha256'])
        self.assertEqual(self.ports.calls,before)
    def test_confirmed_admin_user_metadata_is_exact_three_fields_and_real_bool(self):
        stage=self.stage();user=next(iter(self.ports.users.values()))
        self.assertEqual(user['user_metadata'],{'fixture_scope_id':'e'*32,'fixture_case':'expiredBearer','email_verified':True})
        self.ports.now+=2700;user['user_metadata']['email_verified']=1
        with self.assertRaises(ValueError):self.invoke(module.resume_lifecycle_accounts,self.review,stage['stateSha256'])
        self.assertEqual(self.ports.calls.count(('POST','/admin/users')),1)
    def test_mid_live_monitor_failure_even_fresh_healthy_memory_sends_no_post(self):
        self.review=self.reviewed();native=module.LifecycleProvisioningContext.live
        def failed_after_read(ctx):
            original=ctx.ports.closed_controls
            def slow_controls():
                result=original();ctx.failures.append('LCP_MONITOR_FAILED');ctx.done.set();return result
            ctx.ports.closed_controls=slow_controls
            try:return native(ctx)
            finally:ctx.ports.closed_controls=original
        with patch.object(module.LifecycleProvisioningContext,'live',failed_after_read):
            with self.assertRaises(ValueError):self.invoke(module.stage_lifecycle_accounts,self.review)
        self.assertEqual(self.ports.calls,[])
    def test_dispatch_guard_rechecks_monitor_after_live_return_before_wire(self):
        self.review=self.reviewed();native=module.LifecycleProvisioningContext.live
        def failure_after_live(ctx):
            result=native(ctx)
            if (ctx.evidence/'expiredBearer-create-intent-private.json').exists():
                ctx.failures.append('LCP_MONITOR_FAILED');ctx.done.set()
            return result
        with patch.object(module.LifecycleProvisioningContext,'live',failure_after_live):
            with self.assertRaises(ValueError):self.invoke(module.stage_lifecycle_accounts,self.review)
        self.assertEqual(self.ports.calls,[])
    def test_server_error_after_create_commit_remains_unknown_and_never_resends(self):
        self.review=self.reviewed();self.ports.server_error=True
        with self.assertRaises(ValueError):self.invoke(module.stage_lifecycle_accounts,self.review)
        failure=json.loads((self.root/('auth-lifecycle-provision-'+'e'*32)/'failure-stage.json').read_bytes())
        self.assertEqual(failure['status'],'UNKNOWN')
        self.assertEqual(self.ports.calls.count(('POST','/admin/users')),1)
        self.assertEqual(len(self.ports.users),1)
    def test_login_500_after_issued_session_never_clears_unknown(self):
        self.review=self.reviewed();native=self.ports.request_original
        def error_reply(path,payload):
            status,raw=native(path,payload)
            return (500 if path=='/token?grant_type=password'else status),raw
        self.ports.request_original=error_reply
        with self.assertRaises(ValueError):self.invoke(module.stage_lifecycle_accounts,self.review)
        failure=json.loads((self.root/('auth-lifecycle-provision-'+'e'*32)/'failure-stage.json').read_bytes())
        self.assertEqual(failure['status'],'UNKNOWN')
        self.assertEqual(self.ports.calls.count(('POST','/token?grant_type=password')),1)
        self.assertEqual(len(self.ports.accounts),1)
    def test_cleanup_delete_audit_is_exact_admin_user_email_not_generic_email(self):
        ports=object.__new__(module.FixedLifecycleProvisioningPorts);queries=[]
        ports.read_sql=lambda q,timeout=3:(queries.append(q)or'{}')
        ports.cleanup_audits({'expiredBearer':{'userId':str(uuid.uuid4()),'authEmail':'synthetic-auth-lifecycle-fixed@example.invalid'}})
        self.assertIn("r.payload->>'action'='user_deleted'and r.payload->'traits'->>'user_id'=a.uid and r.payload->'traits'->>'user_email'=a.email",queries[0])
        self.assertNotIn("r.payload->'traits'->>'email'",queries[0])


class LifecycleDispatchTests(unittest.TestCase):
    setUp=BindingTests.setUp
    def tearDown(self):
        # 모형에서만 만든 봉인 트리를 해제한다. 실제 source/resource에는 적용하지 않는다.
        if hasattr(self,'capsule')and self.capsule.exists():
            self.capsule.chmod(0o700)
            for directory in self.capsule.rglob('*'):
                if directory.is_dir()and not directory.is_symlink():directory.chmod(0o700)
        BindingTests.tearDown(self)
    write=BindingTests.write
    def invoke(self,fn,*args):
        with patch.object(module,'provisioning_source_check',return_value=getattr(self,'source_head','a'*40)),patch.object(module,'signed_prepared_target',return_value=self.target),\
             patch.object(module,'signed_source_pins',return_value=self.value['sourcePins']),patch.object(module.time,'time',side_effect=lambda:self.ports.now),\
             patch.object(module,'FixedLifecycleProvisioningPorts',return_value=self.ports):return fn(*args)
    def prepare(self):
        self.source_head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
        self.capsule=self.root/'captured-code';self.capsule.mkdir(mode=0o700)
        factory='tests/integration/jonghyun/isolated_ai_factory.ts'
        self.capsule_pins={**module.product_graph(),factory:hashlib.sha256((REPO/factory).read_bytes()).hexdigest()}
        self.value['sourcePins'].update(self.capsule_pins)
        for relative,digest in self.capsule_pins.items():
            path=self.capsule/relative
            pending=[];parent=path.parent
            while not parent.exists():pending.append(parent);parent=parent.parent
            for directory in reversed(pending):directory.mkdir(mode=0o700)
            self.write(path,(REPO/relative).read_bytes())
        for path in self.capsule.rglob('*'):
            path.chmod(0o500 if path.is_dir()else 0o400)
        self.capsule.chmod(0o500)
        self.ports=FakeLifecycleProvisioningPorts(self.value)
        self.producer=module.ReviewedLifecycleProvisioning('root-model-only',self.root,self.value['sourcePins'],self.value['containers'],self.value['credentials'],'e'*32)
        staged=self.invoke(module.stage_lifecycle_accounts,self.producer);self.ports.now+=2700
        self.late=self.invoke(module.resume_lifecycle_accounts,self.producer,staged['stateSha256']);self.ports.now=1900003570
        self.bound=self.invoke(module.bind_lifecycle_accounts,self.producer,self.late['stateSha256'])
        self.evidence=self.root/('auth-lifecycle-provision-'+'e'*32)
        self.node=self.root/'node';self.write(self.node,b'OFFLINE_FIXED_EXECUTABLE_NEVER_RUN');self.node.chmod(0o700)
        self.original_binding=(self.root/'signed-ai-binding-private.json').read_bytes()
        self.original_input=(self.root/('auth-lifecycle-input-'+'e'*32+'.json')).read_bytes()
        return module.ReviewedLifecycleDispatch('root-dispatch-model',self.producer,self.source_head,self.late['stateSha256'],
            hashlib.sha256((self.evidence/'handoff-receipt.json').read_bytes()).hexdigest(),self.bound['bindingSha256'],self.bound['inputSha256'],
            self.bound['issuanceProofs'],self.node,hashlib.sha256(self.node.read_bytes()).hexdigest(),
            self.capsule,self.capsule_pins,self.capsule_pins[factory])
    def kernel(self,reviewed,binding,value,node):
        module.validate_lifecycle_reviewed_paths(reviewed,value)
        self.assertEqual(Path(node),self.node)
        self.assertEqual(reviewed.binding_path,self.root/('auth-lifecycle-approved-binding-'+'e'*32+'.json'))
        self.assertEqual(reviewed.input_path,self.root/('auth-lifecycle-approved-input-'+'e'*32+'.json'))
        evidence=Path(value['evidenceRoot']);evidence.mkdir(mode=0o700)
        cases={c:{'status':'NOT_RUN'}for c in module.LIFECYCLE_CASES}
        for case in('expiredBearer','revokedSession','memberChanged'):
            cases[case]={'status':'PASS','case':case,'httpStatus':401,'authHttpStatus':403,'actualAuthReads':1,'rpcCalls':0,'providerCalls':0,
                'nativeExternalAttempts':0,'originalTokenSha256':hashlib.sha256(value['accounts'][case]['accessToken'].encode()).hexdigest(),
                'actualNaver':'NOT_RUN','externalProvider':'NOT_RUN'}
        module.lcp_save(evidence,'receipt.json',{'status':'PASS_PARTIAL','scope':module.LIFECYCLE_KIND,'cases':cases,
            'fullLifecycleCoverage':'NOT_RUN','fixedFailures':[],'authMutationsRetained':['memberChanged','revokedSession'],
            'noSessionResurrection':True,'noMutationReplay':True,'originalBaselineSixPreserved':True,'memberChangedMeaning':'AUTH_USER_BANNED_ONLY',
            'serviceMemberRetirement':'NOT_RUN','consentRevocation':'NOT_RUN','containerLifecycle':'UNCHANGED_NOT_STOPPED_BY_RUNNER',
            'sequence':'NOT_VERIFIED','physical':'NOT_VERIFIED','actualNaver':'NOT_RUN','externalProvider':'NOT_RUN','naturalMidnight':'NOT_RUN'})
    def test_typed_caller_fixed_copies_preserve_original_bytes_and_calls_kernel_once(self):
        self.assertTrue(hasattr(module,'dispatch_lifecycle_accounts'),'typed bridge not implemented')
        reviewed=self.prepare();before=[c for c in self.ports.calls if c[0]=='POST']
        with patch.object(module,'run_signed_auth_lifecycle',side_effect=self.kernel)as kernel:
            result=self.invoke(module.dispatch_lifecycle_accounts,reviewed)
        self.assertEqual(kernel.call_count,1)
        self.assertEqual((self.root/'signed-ai-binding-private.json').read_bytes(),self.original_binding)
        self.assertEqual((self.root/('auth-lifecycle-input-'+'e'*32+'.json')).read_bytes(),self.original_input)
        self.assertEqual(result['kernelStatus'],'PASS_PARTIAL');self.assertEqual(result['fullLifecycleCoverage'],'NOT_RUN')
        self.assertEqual([c for c in self.ports.calls if c[0]=='POST'],before)
        inspected=self.invoke(module.inspect_lifecycle_dispatch,reviewed)
        self.assertEqual(inspected['phase'],'KERNEL_RETURNED_WITH_STORED_PROOF')
        with patch.object(module,'run_signed_auth_lifecycle',side_effect=AssertionError('replay')):
            with self.assertRaises(ValueError):self.invoke(module.dispatch_lifecycle_accounts,reviewed)
    def test_json_flags_and_injected_producer_ports_never_grant_dispatch(self):
        with self.assertRaises(ValueError):module.dispatch_lifecycle_accounts({'approvedByRoot':True})
        reviewed=self.prepare();reviewed.producer.ports=self.ports
        with self.assertRaises(ValueError):self.invoke(module.dispatch_lifecycle_accounts,reviewed)
        self.assertFalse((self.evidence/'dispatch-intent.json').exists())
    def test_source_original_issuance_or_node_drift_refuses_before_approved_copy(self):
        reviewed=self.prepare();self.node.write_bytes(b'CHANGED');self.node.chmod(0o700)
        with patch.object(module,'run_signed_auth_lifecycle',side_effect=AssertionError('kernel')):
            with self.assertRaises(ValueError):self.invoke(module.dispatch_lifecycle_accounts,reviewed)
        self.assertFalse((self.evidence/'dispatch-intent.json').exists())
    def test_partial_copy_failure_and_kernel_loss_are_unknown_no_second_attempt(self):
        reviewed=self.prepare();native=module.lcp_save
        def lost(root,name,value):
            if name.startswith('auth-lifecycle-approved-input-'):raise OSError('PRIVATE_COPY_SECRET')
            return native(root,name,value)
        with patch.object(module,'lcp_save',side_effect=lost),patch.object(module,'run_signed_auth_lifecycle',side_effect=AssertionError('kernel')):
            with self.assertRaises(ValueError):self.invoke(module.dispatch_lifecycle_accounts,reviewed)
        inspected=self.invoke(module.inspect_lifecycle_dispatch,reviewed)
        self.assertEqual(inspected['phase'],'DISPATCH_UNKNOWN_NO_REPLAY')
        self.assertEqual((self.root/'signed-ai-binding-private.json').read_bytes(),self.original_binding)
        with self.assertRaises(ValueError):self.invoke(module.dispatch_lifecycle_accounts,reviewed)
    def test_approved_copy_with_changed_original_token_cannot_pass_kernel_path_gate(self):
        reviewed=self.prepare()
        def changed(child,binding,value,node):
            value=copy.deepcopy(value);value['accounts']['expiredBearer']['accessToken']=self.value['accounts'][0]['accessToken']
            with self.assertRaises(ValueError):module.validate_lifecycle_reviewed_paths(child,value)
            raise RuntimeError('SIMULATED_LOST_KERNEL')
        with patch.object(module,'run_signed_auth_lifecycle',side_effect=changed):
            with self.assertRaises(ValueError):self.invoke(module.dispatch_lifecycle_accounts,reviewed)
        self.assertEqual(self.invoke(module.inspect_lifecycle_dispatch,reviewed)['phase'],'DISPATCH_UNKNOWN_NO_REPLAY')
    def test_kernel_return_without_all_three_real_cases_is_not_a_dispatch_success(self):
        reviewed=self.prepare()
        def incomplete(child,binding,value,node):
            self.kernel(child,binding,value,node)
            path=Path(value['evidenceRoot'])/'receipt.json';body=json.loads(path.read_bytes())
            body['cases']['expiredBearer']={'status':'NOT_RUN'};path.write_text(json.dumps(body));path.chmod(0o600)
        with patch.object(module,'run_signed_auth_lifecycle',side_effect=incomplete):
            with self.assertRaises(ValueError):self.invoke(module.dispatch_lifecycle_accounts,reviewed)
        self.assertEqual(self.invoke(module.inspect_lifecycle_dispatch,reviewed)['phase'],'DISPATCH_UNKNOWN_NO_REPLAY')
    def test_terminal_inspection_cannot_promote_partial_to_full_by_changing_summary(self):
        reviewed=self.prepare()
        with patch.object(module,'run_signed_auth_lifecycle',side_effect=self.kernel):self.invoke(module.dispatch_lifecycle_accounts,reviewed)
        path=self.evidence/'dispatch-receipt.json';body=json.loads(path.read_bytes());body['fullLifecycleCoverage']='PASS'
        path.write_text(json.dumps(body));path.chmod(0o600)
        with self.assertRaises(ValueError):self.invoke(module.inspect_lifecycle_dispatch,reviewed)
    def test_original_input_drift_after_kernel_is_failure_and_never_claims_custody(self):
        reviewed=self.prepare()
        def drift(child,binding,value,node):
            self.kernel(child,binding,value,node)
            path=self.root/('auth-lifecycle-input-'+'e'*32+'.json');path.write_bytes(b'{}');path.chmod(0o600)
        with patch.object(module,'run_signed_auth_lifecycle',side_effect=drift):
            with self.assertRaises(ValueError):self.invoke(module.dispatch_lifecycle_accounts,reviewed)
        failure=json.loads((self.evidence/'dispatch-failure.json').read_bytes())
        self.assertFalse(failure['originalProducerInputsPreserved'])
    def test_kernel_preservation_false_numeric_true_and_scope_expansion_are_refused(self):
        for key,bad in [('originalBaselineSixPreserved',False),('noSessionResurrection',False),('noMutationReplay',1),
                        ('serviceMemberRetirement','PASS'),('consentRevocation','PASS'),('naturalMidnight','PASS')]:
            with self.subTest(key=key):
                other=LifecycleDispatchTests();other.setUp()
                try:
                    reviewed=other.prepare()
                    def expanded(child,binding,value,node):
                        other.kernel(child,binding,value,node);path=Path(value['evidenceRoot'])/'receipt.json'
                        v=json.loads(path.read_bytes());v[key]=bad;path.write_text(json.dumps(v));path.chmod(0o600)
                    with patch.object(module,'run_signed_auth_lifecycle',side_effect=expanded):
                        with self.assertRaises(ValueError):other.invoke(module.dispatch_lifecycle_accounts,reviewed)
                finally:other.tearDown()
    def test_private_capsule_whole_inventory_symlink_and_file_drift_refuse(self):
        self.assertTrue(hasattr(module,'lifecycle_dispatch_capsule'),'capsule override missing')
        reviewed=self.prepare();path=self.capsule/'unreviewed.ts';self.capsule.chmod(0o700)
        self.write(path,b'UNREVIEWED');path.chmod(0o400);self.capsule.chmod(0o500)
        with self.assertRaises(ValueError):self.invoke(module.dispatch_lifecycle_accounts,reviewed)
        self.assertFalse((self.evidence/'dispatch-intent.json').exists())
    def test_capsule_path_override_uses_original_token_and_checks_after_child_failure(self):
        reviewed=self.prepare();r=object.__new__(module.SignedAuthLifecycleRunner)
        r.binding=json.loads(self.original_binding);r.lifecycle=json.loads(self.original_input);r.children=[];r.live=lambda:None
        r.evidence=self.root/'model-factory-evidence';r.evidence.mkdir(mode=0o700);r.dispatch_authority=reviewed
        captured=[];capsule=self.capsule
        class Child:
            returncode=1
            def __init__(self,argv,**kwargs):captured.append(argv)
            def communicate(self,timeout):
                f=json.loads(Path(captured[-1][3]).read_bytes())
                self.asserted=(f['codeRoot']==str(capsule))
                path=capsule/'backend/supabase/functions/ai-chat/index.ts';path.chmod(0o600);path.write_bytes(b'CHANGED_CAPTURE');path.chmod(0o400)
                return b'',b'PRIVATE_NODE_ERROR'
            def poll(self):return 1
        native=module.subprocess.Popen
        def popen(argv,**kwargs):return Child(argv,**kwargs)if argv[0]==str(self.node)else native(argv,**kwargs)
        with patch.object(module.subprocess,'Popen',side_effect=popen):
            with self.assertRaises(ValueError):r.invoke_case('expiredBearer',r.lifecycle['accounts']['expiredBearer'],str(self.node))
        self.assertEqual(captured[0][2],str(self.capsule/'tests/integration/jonghyun/isolated_ai_factory.ts'))
        fixture=json.loads(Path(captured[0][3]).read_bytes())
        self.assertEqual(fixture['codeRoot'],str(self.capsule))
        self.assertEqual(fixture['originalToken'],r.lifecycle['accounts']['expiredBearer']['accessToken'])
        self.assertTrue(list(r.evidence.glob('factory-*-closed.json')))
    def test_capsule_symlink_matching_committed_bytes_is_not_executable_custody(self):
        reviewed=self.prepare();relative='backend/supabase/functions/ai-chat/index.ts'
        path=self.capsule/relative;path.parent.chmod(0o700);path.unlink();path.symlink_to(REPO/relative);path.parent.chmod(0o500)
        with self.assertRaises(ValueError):self.invoke(module.dispatch_lifecycle_accounts,reviewed)
        self.assertFalse((self.evidence/'dispatch-intent.json').exists())
    def test_sealed_source_reader_rejects_mixed_root_directory_and_file_modes(self):
        reviewed=self.prepare();path=self.capsule/'backend/supabase/functions/ai-chat/index.ts'
        self.assertEqual(module.lifecycle_capsule_source_read(path,self.capsule),(REPO/path.relative_to(self.capsule)).read_bytes())
        for target,bad,good in[(self.capsule,0o700,0o500),(path.parent,0o700,0o500),(path,0o600,0o400)]:
            with self.subTest(target=target.name):
                target.chmod(bad)
                try:
                    with self.assertRaises(ValueError):module.lifecycle_capsule_source_read(path,self.capsule)
                finally:target.chmod(good)
    def test_source_reader_requires_private_parent_and_does_not_relax_token_reader(self):
        self.prepare();path=self.capsule/'backend/supabase/functions/ai-chat/index.ts'
        self.root.chmod(0o500)
        try:
            with self.assertRaises(ValueError):module.lifecycle_capsule_source_read(path,self.capsule)
        finally:self.root.chmod(0o700)
        with self.assertRaises(ValueError):module.signed_private_read(path)
    def test_source_reader_rejects_path_replacement_and_hardlinked_bytes(self):
        self.prepare();path=self.capsule/'backend/supabase/functions/ai-chat/index.ts';original=path.read_bytes()
        native=module.os.fstat;calls=[]
        def swapped(fd):
            info=native(fd);calls.append(fd)
            if len(calls)==2:
                path.parent.chmod(0o700);replacement=path.with_name('replacement.ts')
                self.write(replacement,original);replacement.chmod(0o400);replacement.replace(path);path.parent.chmod(0o500)
            return info
        with patch.object(module.os,'fstat',side_effect=swapped):
            with self.assertRaises(ValueError):module.lifecycle_capsule_source_read(path,self.capsule)
        path.parent.chmod(0o700);os.link(path,path.with_name('linked.ts'));path.parent.chmod(0o500)
        with self.assertRaises(ValueError):module.lifecycle_capsule_source_read(path,self.capsule)

    def test_kernel_other_original_token_hash_never_satisfies_selected_case(self):
        reviewed=self.prepare()
        def swapped(child,binding,value,node):
            self.kernel(child,binding,value,node);path=Path(value['evidenceRoot'])/'receipt.json';v=json.loads(path.read_bytes())
            v['cases']['expiredBearer']['originalTokenSha256']=hashlib.sha256(binding['accounts'][0]['accessToken'].encode()).hexdigest()
            path.write_text(json.dumps(v));path.chmod(0o600)
        with patch.object(module,'run_signed_auth_lifecycle',side_effect=swapped):
            with self.assertRaises(ValueError):self.invoke(module.dispatch_lifecycle_accounts,reviewed)
        self.assertEqual(self.invoke(module.inspect_lifecycle_dispatch,reviewed)['phase'],'DISPATCH_UNKNOWN_NO_REPLAY')


if __name__=='__main__':unittest.main()
