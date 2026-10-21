"""오프라인 경계·증거 거절 검사. 자연 자정 실행 증거로 계산하지 않는다."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timezone

REPO = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('midnight_prepare', REPO / 'tools/local/prepare_isolated_midnight.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MidnightPreparationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name).resolve()
        self.root.chmod(0o700)
        self.observer = 'ai-observer-123.json'
        self.log = 'ai-public-123.log'
        result = {'status': 'PASS', 'scope': 'PRODUCT_HTTP_FACTORY_REAL_SQL_RPC_SYNTHETIC_AUTH_BRIDGE_AND_MODEL',
                  'naturalMidnight': 'NOT_RUN', 'actualAuthPostgrestNaver': 'NOT_RUN', 'externalProvider': 'NOT_RUN',
                  'memberFixtureRowsRestored': True, 'protectedBudgetMetadata': 'PRESERVED_WITH_UNKNOWN',
                  'checks': [{'scenario': 'AI22', 'observations': 28, 'dailyCounts': [3, 20, 3], 'unknownPreserved': True},
                             {'scenario': 'AI23', 'observations': 6, 'globalCap': 12800000, 'eachAccountCap': 3200000, 'unknownPreserved': True}]}
        self.put(self.log, result)
        self.put(self.observer, {'status': 'PASS', 'mode': 'ai', 'childExitCode': 0, 'observerFailure': None,
                                'publicLogSha256': hashlib.sha256((self.root / self.log).read_bytes()).hexdigest(),
                                'sourceSha256': 'a' * 64})
        self.reindex()

    def tearDown(self):
        self.directory.cleanup()

    def put(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def reindex(self, duplicate=False):
        entries = [{'file': n, 'bytes': (self.root / n).stat().st_size,
                    'sha256': hashlib.sha256((self.root / n).read_bytes()).hexdigest()}
                   for n in (self.observer, self.log)]
        if duplicate:
            entries.append(entries[0])
        self.put('preservation-manifest.json', {'files': entries})

    def test_valid_public_evidence_never_opens_auth_fixture(self):
        # Deliberately unreadable credential fixture; it is outside the allowlist.
        (self.root / 'ai-factory-fixture.json').mkdir()
        evidence = m.inspect_evidence(self.root)
        self.assertEqual(len(evidence['publicEvidenceSha256']), 2)
        self.assertEqual(evidence['priorLiveBudgetDay'], 'NOT_OBSERVED')
        self.assertEqual(evidence['productGraphMatchToCurrent'], 'NOT_VERIFIED')
        self.assertEqual(evidence['targetBinding'], 'MANIFEST_ONLY_LIVE_NOT_OBSERVED')

    def test_tampered_public_log_is_rejected(self):
        with (self.root / self.log).open('a') as stream:
            stream.write(' ')
        with self.assertRaisesRegex(ValueError, 'EVIDENCE_HASH_CHANGED'):
            m.inspect_evidence(self.root)

    def test_duplicate_manifest_entries_are_rejected(self):
        self.reindex(True)
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_EVIDENCE'):
            m.inspect_evidence(self.root)

    def test_failed_observer_cannot_prepare(self):
        value = json.loads((self.root / self.observer).read_text())
        value['childExitCode'] = 1
        self.put(self.observer, value)
        self.reindex()
        with self.assertRaisesRegex(ValueError, 'AI_OBSERVER_NOT_PASS'):
            m.inspect_evidence(self.root)

    def test_changed_daily_counts_do_not_pass(self):
        result = json.loads((self.root / self.log).read_text())
        result['checks'][0]['dailyCounts'] = [3, 19, 3]
        self.put(self.log, result)
        observer = json.loads((self.root / self.observer).read_text())
        observer['publicLogSha256'] = hashlib.sha256((self.root / self.log).read_bytes()).hexdigest()
        self.put(self.observer, observer)
        self.reindex()
        with self.assertRaisesRegex(ValueError, 'AI22_AI23_CONTRACT_CHANGED'):
            m.inspect_evidence(self.root)

    def test_private_mode_and_hardlink_are_required(self):
        path = self.root / self.log
        path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'PRIVATE_REGULAR_FILE_REQUIRED'):
            m.inspect_evidence(self.root)
        path.chmod(0o600)
        os.link(path, self.root / 'alias')
        with self.assertRaisesRegex(ValueError, 'PRIVATE_REGULAR_FILE_REQUIRED'):
            m.inspect_evidence(self.root)

    def test_symlink_public_evidence_is_rejected(self):
        path = self.root / self.log
        path.rename(self.root / 'real-log')
        path.symlink_to(self.root / 'real-log')
        with self.assertRaises(OSError):
            m.inspect_evidence(self.root)

    def test_traversal_private_name_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'EXACT_FILE_REQUIRED'):
            m.private_bytes(self.root, '../credential')

    def test_plan_never_claims_live_readiness_or_resets_full_cap(self):
        evidence = m.inspect_evidence(self.root)
        pins = {'tests/integration/jonghyun/isolated_ai_contracts.py': 'a' * 64}
        plan = m.build_plan({'project': 'synthetic', 'id': 'owned', 'image': 'pinned'}, evidence, pins,
                            datetime(2026, 10, 11, 14, 40, tzinfo=timezone.utc))
        self.assertFalse(plan['executionAllowed'])
        self.assertEqual(plan['actualMidnight'], 'NOT_RUN')
        baseline = plan['baselineContract']
        self.assertFalse(baseline['dbObserved'])
        self.assertTrue(baseline['newLedgerDoesNotResetSharedDayBudget'])
        self.assertEqual(baseline['protectedTables'], list(m.PROTECTED))
        self.assertEqual(baseline['liveNaturalDayHeadroom'], 'NOT_OBSERVED')
        self.assertTrue(plan['cleanupContract']['noBulkDeleteNoTimeShiftNoRefundNoLimitChange'])
        ids = plan['ownedIntent']['memberIds']
        self.assertEqual(len(set(ids)), 3)
        self.assertEqual(plan['ownedIntent']['creationReceipts'], 'NOT_CREATED')

    def test_changed_evidence_runner_pin_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'AI_EVIDENCE_SOURCE_CHANGED'):
            m.build_plan({}, m.inspect_evidence(self.root), {}, datetime.now(timezone.utc))

    def test_kst_next_boundary_and_strict_resume_cutoff(self):
        value = m.natural_windows(datetime(2026, 10, 11, 14, 0, tzinfo=timezone.utc))
        self.assertEqual(value['nextKstMidnight'], '2026-10-12T00:00:00+09:00')
        self.assertEqual(value['initialPrepareThrough'], '2026-10-11T23:40:00+09:00')
        self.assertEqual(value['resumeBeforeExclusive'], '2026-10-11T23:59:55+09:00')
        # At natural midnight the next target moves to the following day.
        next_value = m.natural_windows(datetime(2026, 10, 11, 15, 0, tzinfo=timezone.utc))
        self.assertEqual(next_value['nextKstMidnight'], '2026-10-13T00:00:00+09:00')

    def test_naive_clock_cannot_silently_use_local_timezone(self):
        with self.assertRaisesRegex(ValueError, 'OFFSET_CLOCK_REQUIRED'):
            m.natural_windows(datetime(2026, 10, 11))

    def test_live_windows_keep_original_exclusive_cutoffs(self):
        from datetime import timedelta
        boundary = m.boundary_time('2026-10-12T00:00:00+09:00')
        for phase, accepted, rejected in [
            ('initial', 1200, 1199), ('fixture', 600, 599),
            ('fixture_finish', 300, 299), ('resume', 120, 5),
            ('final_idle', 60, 3), ('pre_boundary', 2.1, 2.2),
            ('post_boundary', -1.9, -2),
        ]:
            m.check_window(boundary - timedelta(seconds=accepted), boundary, phase)
            with self.assertRaisesRegex(ValueError, 'NATURAL_WINDOW_REQUIRED'):
                m.check_window(boundary - timedelta(seconds=rejected), boundary, phase)



class MidnightCapturedCustodyTests(unittest.TestCase):
    """MODELED: 실제 Node/Docker/Auth/자정 실행 없이 고정 포트 경계를 검증한다."""
    @classmethod
    def setUpClass(cls):
        import sys
        path=REPO/'tests/integration/jonghyun/isolated_ai_contracts.py'
        spec=importlib.util.spec_from_file_location('ai24_custody_modeled_runner',path)
        cls.r=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.r)

    def setUp(self):
        from unittest.mock import Mock, patch
        self.Mock,self.patch=Mock,patch
        self.temp=tempfile.TemporaryDirectory(prefix='ai24-custody-model-',dir='/private/tmp')
        self.root=Path(self.temp.name);self.root.chmod(0o700)
        self.live=self.root/'live';self.live.mkdir(mode=0o700)
        self.tree=self.root/'sealed';self.tree.mkdir(mode=0o700)
        self.factory='tests/integration/jonghyun/isolated_ai_factory.ts'
        self.product='backend/supabase/functions/ai-chat/index.ts'
        self.raw={self.factory:b'// MODELED factory, never evaluated\n',self.product:b'// MODELED product, never evaluated\n'}
        self.pins={name:hashlib.sha256(raw).hexdigest()for name,raw in self.raw.items()}
        for root in (self.live,self.tree):
            for name,raw in self.raw.items():
                path=root/name;path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);path.write_bytes(raw)
                path.chmod(0o400 if root==self.tree else 0o600)
        for path in sorted([self.tree,*[p for p in self.tree.rglob('*')if p.is_dir()]],key=lambda p:len(p.parts),reverse=True):path.chmod(0o500)
        self.node=self.root/'node';self.node.write_bytes(b'MODELED_NODE_NOT_EXECUTED');self.node.chmod(0o700)
        self.observer=(REPO/'tools/local/observe_isolated.py').read_bytes()
        op=self.live/'tools/local/observe_isolated.py';op.parent.mkdir(parents=True);op.write_bytes(self.observer)
        self.head='1'*40;self.scope='custody-modeled'
        self.authority=self.r.TypedMidnightCustody(self.head,self.scope,self.tree,self.pins,self.pins[self.factory],self.node,
            hashlib.sha256(self.node.read_bytes()).hexdigest(),hashlib.sha256(self.observer).hexdigest())
        self.runner=object.__new__(self.r.SignedMidnightRunner)
        for key,value in {'scope_id':self.scope,'root':self.root,'evidence':self.root,'target':{},'base':[],
            'binding':{'sourcePins':{self.factory:self.pins[self.factory]}},'users':[], 'changed':False,'children':[],
            'prepared_units_complete':False,'ledgers':[],'boundary_epoch':1800000000,
            'fixture':{'codeRoot':str(self.live),'aiQuery':'synthetic-absent-'+'a'*32}}.items():setattr(self.runner,key,value)
        self.runner.validate_original_accounts=self.Mock()
        self.saved=[];self.runner.save_signed=lambda name,value:self.saved.append((name,value))
        self.git=self.patch.object(self.r.subprocess,'run',side_effect=self.git_read);self.git.start()
        self.repo=self.patch.object(self.r,'REPO',self.live);self.repo.start()
        self.graph=self.patch.object(self.r,'product_graph',return_value={self.product:self.pins[self.product]});self.graph.start()

    def tearDown(self):
        self.graph.stop();self.repo.stop();self.git.stop()
        for path in [self.tree,*self.tree.rglob('*')]:
            if path.is_dir():path.chmod(0o700)
            else:path.chmod(0o600)
        self.temp.cleanup()

    def git_read(self,argv,**kwargs):
        import subprocess
        if argv[0]!='git':raise AssertionError('RESOURCE_CALL_FORBIDDEN')
        if argv[-1]=='HEAD':return subprocess.CompletedProcess(argv,0,(self.head+'\n').encode(),b'')
        if argv[-1].endswith(':tools/local/observe_isolated.py'):return subprocess.CompletedProcess(argv,0,self.observer,b'')
        if argv[-1]=='--batch':
            body=b''
            for request in kwargs['input'].decode().splitlines():
                raw=self.raw[request.split(':',1)[1]]
                body+=b'a'*40+b' blob '+str(len(raw)).encode()+b'\n'+raw+b'\n'
            return subprocess.CompletedProcess(argv,0,body,b'')
        raise AssertionError('UNREVIEWED_COMMAND')

    def bind(self):return self.r.midnight_bind_custody(self.runner,self.authority)

    def test_real_sealed_reader_and_full_inventory(self):
        proof=self.bind()
        self.assertEqual(proof['actualMidnight'],'NOT_RUN')
        self.assertEqual(self.runner.fixture['codeRoot'],str(self.tree))
        self.assertEqual(self.r.midnight_custody_proof(self.runner),self.authority.descriptor())

    def test_json_never_creates_typed_authority(self):
        with self.assertRaisesRegex(ValueError,'BIND_ONCE'):self.r.midnight_bind_custody(self.runner,self.authority.descriptor())
        with self.assertRaisesRegex(ValueError,'TYPED_CUSTODY'):m.bind_fixed_execution(self.root,'a'*64,{},None,custody={})

    def test_authority_is_immutable_and_deep_copies_pins(self):
        self.pins[self.product]='0'*64
        self.assertNotEqual(self.authority.descriptor()['capsulePins'][self.product],self.pins[self.product])
        with self.assertRaises(AttributeError):self.authority._data='{}'

    def test_source_modes_and_extra_inventory_refuse(self):
        for kind in ('mode','extra','symlink'):
            with self.subTest(kind=kind):
                self.tree.chmod(0o700)
                if kind=='mode':path=self.tree/self.product;path.chmod(0o600)
                elif kind=='extra':path=self.tree/'extra.ts';path.write_bytes(b'');path.chmod(0o400)
                else:path=self.tree/'alias';path.symlink_to(self.tree/self.product)
                self.tree.chmod(0o500)
                self.runner.midnight_custody=self.authority
                with self.assertRaises(ValueError):self.r.midnight_custody_proof(self.runner)
                self.tree.chmod(0o700)
                if kind=='mode':path.chmod(0o400)
                else:path.unlink()
                self.tree.chmod(0o500)

    def test_node_hash_drift_refuses_before_launch(self):
        self.bind();self.node.write_bytes(b'CHANGED')
        with self.assertRaisesRegex(ValueError,'DISPATCH_NODE'):self.runner.start_factory(dict(self.runner.fixture),'prepare-limits')
        self.runner.validate_original_accounts.assert_not_called()

    def test_current_head_mismatch_refuses(self):
        self.runner.midnight_custody=self.authority;self.head='2'*40
        with self.assertRaisesRegex(ValueError,'CUSTODY_HEAD'):self.r.midnight_custody_proof(self.runner)

    def test_uncommitted_product_bytes_refuse(self):
        self.bind();(self.live/self.product).write_bytes(b'UNCOMMITTED')
        with self.assertRaisesRegex(ValueError,'CAPSULE'):self.r.midnight_custody_proof(self.runner)

    def test_all_four_phases_use_same_captured_argv_minimal_env_and_session(self):
        self.bind()
        for phase in ('prepare-limits','prepare-recovery','held','new-day'):
            with self.subTest(phase=phase):
                fixture=dict(self.runner.fixture)
                capability=None
                if phase in ('held','new-day'):
                    self.runner.prepared_units_complete=True;self.runner.changed=True;self.runner.midnight_unknown=('id',{})
                    fixture.update(aiMidnightScenario=True,midnightDir=str(self.root),midnightEpoch=self.runner.boundary_epoch,midnightPhase=phase)
                if phase=='held':
                    with self.patch.object(self.r,'signed_source_pins',return_value=self.runner.binding['sourcePins']):capability=self.runner.warm_factory(fixture)
                process=self.Mock();process.pid=123456;process.poll.return_value=None
                with self.patch.object(self.r.subprocess,'Popen',return_value=process)as popen:
                    handle=self.runner.start_factory(fixture,phase,capability)
                args,kw=popen.call_args
                self.assertEqual(args[0][0],str(self.node));self.assertEqual(args[0][2],str(self.tree/self.factory))
                self.assertTrue(kw['start_new_session']);self.assertEqual(kw['env'],self.r.midnight_minimal_env(self.root))
                self.assertNotIn('NODE_OPTIONS',kw['env']);self.assertTrue(handle['typedCustody'])

    def test_held_start_does_not_full_hash_inside_critical_window(self):
        self.bind();self.runner.changed=True;self.runner.prepared_units_complete=True;self.runner.midnight_unknown=('id',{})
        fixture={**self.runner.fixture,'aiMidnightScenario':True,'midnightDir':str(self.root),'midnightEpoch':self.runner.boundary_epoch,'midnightPhase':'held'}
        with self.patch.object(self.r,'signed_source_pins',return_value=self.runner.binding['sourcePins']):cap=self.runner.warm_factory(fixture)
        with self.patch.object(self.r,'midnight_custody_proof',side_effect=AssertionError('SLOW_FULL_HASH')), \
             self.patch.object(self.r.subprocess,'Popen',return_value=self.Mock()):
            self.runner.start_factory(fixture,'held',cap)

    def test_warmed_node_metadata_drift_refuses(self):
        self.bind();self.runner.held_custody=self.authority.descriptor();self.runner.held_custody_signatures=self.r.midnight_warm_signatures(self.runner)
        self.node.write_bytes(b'CHANGED')
        with self.assertRaisesRegex(ValueError,'HELD_SOURCE'):self.r.midnight_warm_recheck(self.runner)

    def test_minimal_env_preserves_existing_home_path_locale_and_excludes_injection(self):
        allowed={'PATH':'modeled-original-path','HOME':'/modeled-original-home','LANG':'modeled-locale',
            'LC_ALL':'modeled-all','LC_CTYPE':'modeled-ctype'}
        hazardous={'NODE_OPTIONS':'modeled-preload','NODE_PATH':'modeled-module-path','PYTHONPATH':'modeled-python',
            'HTTP_PROXY':'modeled-proxy','HTTPS_PROXY':'modeled-proxy','ALL_PROXY':'modeled-proxy',
            'SUPABASE_SERVICE_ROLE_KEY':'modeled-secret','TMPDIR':'modeled-temp','LC_UNKNOWN_SECRET':'modeled-secret'}
        with self.patch.dict(os.environ,{**allowed,**hazardous},clear=True):
            self.assertEqual(self.r.midnight_minimal_env(self.root),allowed)
            self.assertNotEqual(self.r.midnight_minimal_env(self.root)['HOME'],str(self.root))

    def test_minimal_env_does_not_synthesize_missing_home_or_locale(self):
        with self.patch.dict(os.environ,{},clear=True):self.assertEqual(self.r.midnight_minimal_env(self.root),{})

    def test_warm_directory_change_refuses_before_popen(self):
        self.bind();self.runner.held_custody=self.authority.descriptor();self.runner.held_custody_signatures=self.r.midnight_warm_signatures(self.runner)
        self.tree.chmod(0o700)
        with self.assertRaisesRegex(ValueError,'HELD_SOURCE'):self.r.midnight_warm_recheck(self.runner)
        self.tree.chmod(0o500)

    def test_warm_hash_and_signature_cannot_adopt_changed_bytes(self):
        self.bind()
        def swap_after_proof(runner):
            self.node.write_bytes(b'CHANGED')
            return self.authority.descriptor()
        with self.patch.object(self.r,'midnight_custody_proof',side_effect=swap_after_proof):
            with self.assertRaisesRegex(ValueError,'CUSTODY_WARM'):self.r.midnight_warm_signatures(self.runner)

    def test_post_launch_artifact_failure_closes_owned_group(self):
        self.bind();process=self.Mock();process.pid=123456;process.poll.return_value=0
        self.runner.midnight_terminate=self.Mock()
        def save(name,value):
            if name.endswith('node-created.json'):raise OSError('MODELED_PRIVATE_WRITE_FAILURE')
        self.runner.save_signed=save
        with self.patch.object(self.r.subprocess,'Popen',return_value=process):
            with self.assertRaises(OSError):self.runner.start_factory(dict(self.runner.fixture),'prepare-limits')
        self.runner.midnight_terminate.assert_called_once_with(process)
        self.assertEqual(len(self.runner.children),1)

    def test_closure_rechecks_captured_source_even_when_child_closure_fails(self):
        self.bind();process=self.Mock();handle={'process':process,'typedCustody':True};self.runner.children=[handle]
        self.runner.midnight_terminate=self.Mock(side_effect=ValueError('MODELED_GROUP_NOT_CLOSED'))
        with self.patch.object(self.r,'midnight_custody_proof',wraps=self.r.midnight_custody_proof)as proof:
            with self.assertRaisesRegex(ValueError,'GROUP_NOT_CLOSED'):self.runner.cancel_factory(handle)
        proof.assert_called_once_with(self.runner)

    def test_successful_child_with_final_capsule_drift_cannot_pass(self):
        self.bind();process=self.Mock();process.poll.return_value=0;process.returncode=0;process.pid=123456
        process.communicate.return_value=(b'{"status":"PASS","nativeExternalAttempts":0}',b'')
        handle={'process':process,'phase':'prepare-limits','typedCustody':True};self.runner.children=[handle]
        self.runner.midnight_terminate=self.Mock()
        self.tree.chmod(0o700);extra=self.tree/'unexpected';extra.write_bytes(b'');extra.chmod(0o400);self.tree.chmod(0o500)
        with self.assertRaisesRegex(ValueError,'CAPSULE'):self.runner.finish_factory(handle)
        self.runner.midnight_terminate.assert_called_once_with(process)

    def test_resume_is_sha_bound_to_exact_source_root_node_and_typed_object(self):
        self.bind();state=self.runner.export_resume_state()
        for field in ('capsuleRoot','nodePath','nodeSha256','sourceHead','scopeId'):
            changed=json.loads(json.dumps(state));changed['sourceCustody'][field]='changed'
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'RESUME_CUSTODY'):self.runner.restore_resume_state(changed)
        changed=json.loads(json.dumps(state));changed['sourceCustodySha256']='0'*64
        with self.assertRaisesRegex(ValueError,'RESUME_CUSTODY'):self.runner.restore_resume_state(changed)
        changed=json.loads(json.dumps(state));changed.pop('sourceCustody')
        with self.assertRaisesRegex(ValueError,'RESUME_CUSTODY'):self.runner.restore_resume_state(changed)
        self.assertEqual(self.runner.restore_resume_state(state)['resourceCalls'],0)

    def test_resumed_json_without_root_typed_object_refuses(self):
        self.bind();state=self.runner.export_resume_state();del self.runner.midnight_custody
        with self.assertRaisesRegex(ValueError,'RESUME_STATE_FIELDS'):self.runner.restore_resume_state(state)

    def test_legacy_untyped_start_preserves_canonical_popen_and_state(self):
        process=self.Mock()
        with self.patch.object(self.r.shutil,'which',return_value='/legacy/node'),self.patch.object(self.r.subprocess,'Popen',return_value=process)as popen:
            self.runner.start_factory(dict(self.runner.fixture),'prepare-limits')
        self.assertNotIn('env',popen.call_args.kwargs);self.assertNotIn('start_new_session',popen.call_args.kwargs)
        self.assertEqual(popen.call_args.args[0][2],str(Path(self.r.__file__).with_name('isolated_ai_factory.ts')))
        self.assertNotIn('sourceCustody',self.runner.export_resume_state())

if __name__ == '__main__':
    unittest.main()


class CurrentMidnightAccountAndRowsTests(unittest.TestCase):
    """MODELED: 현재3×2 원 입력과 전체 table-set 소비 검사. 발급·DB 호출 없음."""
    @classmethod
    def setUpClass(cls):
        path=REPO/'tests/integration/jonghyun/isolated_ai_contracts.py'
        spec=importlib.util.spec_from_file_location('current_midnight_accounts_modeled',path)
        cls.r=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.r)

    def setUp(self):
        import base64, uuid
        self.accounts=[];members=[]
        self.now=1800000000
        issuer='http://127.0.0.1:54321/auth/v1'
        def token(claims):
            encode=lambda x:base64.urlsafe_b64encode(json.dumps(x).encode()).decode().rstrip('=')
            return encode({'alg':'HS256'})+'.'+encode(claims)+'.MODELED_SIGNATURE_ONLY'
        self.token=token
        for i in range(3):
            user=str(uuid.uuid4());sessions=[str(uuid.uuid4()),str(uuid.uuid4())]
            members.append(dict(userId=user,primarySessionId=sessions[0],secondarySessionId=sessions[1]))
            for session in sessions:
                claims=dict(sub=user,session_id=session,iat=self.now,exp=self.now+3600,iss=issuer,
                    role='authenticated',email='synthetic-ai-modeled-'+str(i)+'@example.invalid')
                self.accounts.append(dict(userId=user,sessionId=session,accessToken=token(claims),
                    expiresAt=claims['exp'],authEmail=claims['email']))
        self.tables=sorted(['auth.users','public.profiles','private.ai_budget_reservations',
            'private.ai_account_budget_reservations','storage.objects','cron.job','vault.secrets'])
        self.profile=self.r.ReviewedCurrentMidnightProfile(dict(sourceHead='a'*40,migrationEntriesSha256='b'*64,
            versions=['20261020100000','20261020130000'],expectedTables=self.tables,
            fullTableSetSha256=hashlib.sha256(json.dumps(self.tables,separators=(',',':')).encode()).hexdigest(),memberSessions=members))

    def test_current_account_pairs_require_exact_original_session_and_3600_claims(self):
        import copy,uuid
        self.r.validate_current_midnight_accounts(self.accounts,self.profile)
        for change in ('session','shortened','duplicate','email'):
            accounts=copy.deepcopy(self.accounts)
            if change=='session':accounts[0]['sessionId']=str(uuid.uuid4())
            if change=='duplicate':accounts[1]=accounts[0].copy()
            if change=='email':accounts[1]['authEmail']='synthetic-ai-other@example.invalid'
            if change=='shortened':
                claims=self.r.signed_claims(accounts[0]['accessToken']);claims['iat']+=1;accounts[0]['accessToken']=self.token(claims)
            with self.subTest(change=change),self.assertRaises(ValueError):self.r.validate_current_midnight_accounts(accounts,self.profile)
        with self.assertRaisesRegex(ValueError,'TYPED_PROFILE'):
            self.r.validate_current_midnight_accounts(self.accounts,self.profile.descriptor())

    def test_current_generic_binding_preserves_full_shared_checks_and_historical_lane(self):
        import copy,tempfile
        from unittest.mock import patch
        with tempfile.TemporaryDirectory(prefix='current-midnight-binding-',dir='/private/tmp')as directory:
            root=Path(directory).resolve();project='modeled-project';manifest=json.dumps({'config_overlay':{'api.port':54321}}).encode()
            containers={k:dict(id=str(i)*64,name=prefix+project,image='sha256:'+'c'*64,
                configSha256='d'*64,hostConfigSha256='e'*64,mountsSha256='f'*64)
                for i,(k,prefix)in enumerate([('db','supabase_db_'),('auth','supabase_auth_'),('rest','supabase_rest_'),('gateway','supabase_kong_')],1)}
            binding=dict(version=1,kind=self.r.CURRENT_MIDNIGHT_KIND,preparedRoot=str(root),
                databaseManifestSha256=hashlib.sha256(manifest).hexdigest(),origin='http://127.0.0.1:54321',
                jwtIssuer='http://127.0.0.1:54321/auth/v1',containers=containers,
                credentials={'anon':self.token({'role':'anon'}),'service':self.token({'role':'service_role'})},
                accounts=self.accounts,evidenceRoot=str(root/('signed-auth-'+'a'*32)),sourcePins={'modeled':'a'*64},
                approvedByRoot=False,dockerSlotReady=False)
            target=dict(id=containers['db']['id'],image=containers['db']['image'],project=project,versions=self.profile.descriptor()['versions'])
            with patch.object(self.r,'signed_private_read',return_value=manifest),patch.object(self.r,'signed_source_pins',return_value=binding['sourcePins']):
                self.assertEqual(self.r.validate_signed_binding(binding,root,target,now=self.now,current_midnight=self.profile),binding)
                with self.assertRaisesRegex(ValueError,'BINDING_KIND'):self.r.validate_signed_binding(binding,root,target,now=self.now)
                for key,value in [('jwtIssuer','http://127.0.0.1:54322/auth/v1'),('databaseManifestSha256','0'*64),
                                  ('sourcePins',{'wrong':'a'*64}),('credentials',{'anon':self.token({'role':'service_role'}),'service':binding['credentials']['service']})]:
                    with self.subTest(key=key),self.assertRaises(ValueError):
                        self.r.validate_signed_binding({**binding,key:value},root,target,now=self.now,current_midnight=self.profile)
                with self.assertRaisesRegex(ValueError,'VERSIONS'):
                    self.r.validate_signed_binding(binding,root,{**target,'versions':target['versions'][::-1]},now=self.now,current_midnight=self.profile)

    def test_current_row_collector_requires_exact_six_schema_inventory_and_bag_multiplicity(self):
        obj=object.__new__(self.r.SignedMidnightRunner);obj.current_midnight_profile=self.profile
        inventory=[t.split('.',1)for t in self.tables];calls=[]
        def read(sql,timeout):
            calls.append(sql)
            return json.dumps(inventory if 'pg_tables'in sql else {'a'*64:2})
        obj.read_sql=read
        rows=obj.original_rows();self.assertEqual(sorted(rows),self.tables)
        self.assertTrue(all(bag=={'a'*64:2}for bag in rows.values()))
        self.assertIn("'cron','vault'",calls[0]);self.assertEqual(len(calls),len(self.tables)+1)
        inventory[0]=['auth','replacement'];calls.clear()
        with self.assertRaisesRegex(ValueError,'EXACT_TABLES'):obj.original_rows()
        self.assertEqual(len(calls),1)
