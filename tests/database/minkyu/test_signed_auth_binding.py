"""서명 입력·실제 factory의 오프라인 모형 검증. Auth/DB 실제 연결 증거는 아니다."""
import ast
import base64
import copy
import hashlib
import importlib.util
import json
import os
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
        dump=lambda node:ast.dump(node,include_attributes=False)
        for node in before.body:
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
        current={node.name:node for node in after.body if isinstance(node,(ast.FunctionDef,ast.ClassDef))}
        for node in before.body:
            if isinstance(node,(ast.FunctionDef,ast.ClassDef)):
                self.assertEqual(dump(node),dump(current[node.name]),node.name)

    def test_original_python_functions_exact(self):
        old=subprocess.run(['git','show','HEAD:tests/integration/jonghyun/isolated_ai_contracts.py'],cwd=REPO,capture_output=True,text=True,check=True).stdout
        self.assert_original_python_preserved(ast.parse(old),ast.parse(RUNNER.read_text()))

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

if __name__=='__main__':unittest.main()
