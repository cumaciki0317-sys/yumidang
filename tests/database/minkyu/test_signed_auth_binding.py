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
from unittest.mock import patch
import uuid

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

    def test_original_python_functions_exact(self):
        old=subprocess.run(['git','show','HEAD:tests/integration/jonghyun/isolated_ai_contracts.py'],cwd=REPO,capture_output=True,text=True,check=True).stdout
        before=ast.parse(old);after=ast.parse(RUNNER.read_text())
        current={node.name:node for node in after.body if isinstance(node,(ast.FunctionDef,ast.ClassDef))}
        for node in before.body:
            if isinstance(node,(ast.FunctionDef,ast.ClassDef)):
                self.assertEqual(ast.dump(node,include_attributes=False),ast.dump(current[node.name],include_attributes=False),node.name)

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

if __name__=='__main__':unittest.main()
