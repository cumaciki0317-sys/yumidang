"""D03 source seal의 실제 임시 Git/FD 회귀. 프로젝트 Git 변경·Docker·DB 실행 0."""
from contextlib import contextmanager
import ast
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch

ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('d03_source_seal_unit',ROOT/'tests/integration/minkyu/deadline_lock_runtime.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)

class ReviewedFixture:
    def __init__(self,value):self.value=value
    def descriptor(self):return self.value

class SourceSealTests(unittest.TestCase):
    def summary(self):
        users=('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002')
        origin={'epochUs':1000000,'state':[],'outbox':[],'checkpoints':[]}
        observed={'epochUs':3000000,'state':[{'profile_id':u,'revision':1,'fingerprint':None,'visible_summary_id':None}for u in users],
            'outbox':[{'profile_id':u,'requested_at':'1970-01-01T00:00:02+00:00'}for u in users],'checkpoints':[]}
        return users,origin,observed
    def test_summary_cleanup_exact_trigger_payload(self):
        users,origin,observed=self.summary();m.validate_summary_cleanup(origin,observed,users)
        m.validate_summary_cleanup(origin,dict(origin,epochUs=3000000),users)
    def test_summary_cleanup_preexisting_checkpoint_state_or_outbox_refused(self):
        users,origin,observed=self.summary()
        for key in('state','outbox','checkpoints'):
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'ORIGIN_NOT_EMPTY'):
                m.validate_summary_cleanup(dict(origin,**{key:[{}]}),observed,users)
    def test_summary_cleanup_foreign_shape_revision_time_checkpoint_refused(self):
        import copy
        users,origin,observed=self.summary()
        cases=[]
        for field,value in(('revision',2),('fingerprint','foreign'),('visible_summary_id','foreign'),('profile_id','foreign')):
            bad=copy.deepcopy(observed);bad['state'][0][field]=value;cases.append(bad)
        bad=copy.deepcopy(observed);bad['outbox'][0]['requested_at']='1970-01-01T00:00:00+00:00';cases.append(bad)
        bad=copy.deepcopy(observed);bad['checkpoints']=[{}];cases.append(bad)
        for bad in cases:
            with self.subTest(bad=bad),self.assertRaises(ValueError):m.validate_summary_cleanup(origin,bad,users)
    def test_fixture_summary_origin_rejected_before_business_sql(self):
        users,origin,observed=self.summary();r=object.__new__(m.FixedDeadlineRuntime)
        r.review=SimpleNamespace(author_id=users[0],reviewer_id=users[1]);r.executor=SimpleNamespace(fixture_sql=lambda _: 'fixture',uid=lambda u:"'"+u+"'::uuid")
        r.readonly=SimpleNamespace(exact=json.loads);calls=[];r.save=lambda *a:calls.append(('saved',a))
        r._sql_command=lambda sql:(calls.append(('sql',sql))or json.dumps(dict(origin,checkpoints=[{}])))
        with self.assertRaisesRegex(ValueError,'PREEXISTING_ROWS'):r.sql('fixture')
        self.assertEqual(len(calls),1);self.assertNotEqual(calls[0][1],'fixture')
        self.assertFalse(hasattr(r,'summary_fixture_origin'))
    def test_fixture_summary_origin_saved_before_dispatch_and_replay_refused(self):
        users,origin,_=self.summary();r=object.__new__(m.FixedDeadlineRuntime)
        r.review=SimpleNamespace(author_id=users[0],reviewer_id=users[1]);r.executor=SimpleNamespace(fixture_sql=lambda _: 'fixture',uid=lambda u:"'"+u+"'::uuid")
        r.readonly=SimpleNamespace(exact=json.loads);calls=[];r.save=lambda name,value:calls.append(('save',name))
        r._sql_command=lambda sql:(calls.append(('sql',sql))or json.dumps(origin))
        r.sql('fixture');self.assertEqual(calls[1][0],'save');self.assertEqual(calls[2],('sql','fixture'))
        count=len(calls)
        with self.assertRaisesRegex(ValueError,'FIXTURE_REPLAY'):r.sql('fixture')
        self.assertEqual(len(calls),count)
    def cleanup_lane(self,mutation=None,partial_failure=False,save_failure=False):
        import copy,re
        users,origin,generated=self.summary();runtime=object.__new__(m.FixedDeadlineRuntime)
        review=SimpleNamespace(author_id=users[0],reviewer_id=users[1],post_id='post',request_id='request',appointment_id='appointment')
        runtime.review=review;runtime.executor=SimpleNamespace(uid=lambda u:"'"+u+"'::uuid")
        runtime.core=SimpleNamespace(ai=SimpleNamespace(quote=lambda s:"'"+s.replace("'","''")+"'"))
        runtime.readonly=SimpleNamespace(exact=json.loads);runtime.summary_fixture_origin=m.canonical(origin)
        state={'rows':copy.deepcopy(origin),'business':True,'calls':[],'summaryDeleted':False}
        def sql(statement):
            state['calls'].append(statement)
            if statement.startswith('select(select count'):return '0'
            if statement.startswith('select jsonb_build_object'):return json.dumps(state['rows'])
            self.assertTrue(statement.startswith('begin;'));self.assertTrue(statement.endswith('commit;'))
            self.assertNotRegex(statement,r'(?i)\bassert\b')
            self.assertIn('in share row exclusive mode;',statement)
            if '$d03empty$'in statement:
                self.assertEqual(statement.count("then raise exception 'd03_summary_predelete_not_empty'"),3)
                if any(state['rows'][k]for k in('state','outbox','checkpoints')):raise ValueError('predelete_not_empty')
                self.assertLess(statement.index('end $d03empty$;'),statement.index('delete from'))
                self.assertEqual(statement.count('delete from '),7)
                if partial_failure:raise ValueError('partial transaction rollback')
                state['business']=False;state['rows']=copy.deepcopy(generated);return ''
            self.assertIn('$d03summary$',statement)
            self.assertLess(statement.index('end $d03summary$;'),statement.index('delete from'))
            pairs=re.findall(r"from private[.](review_summary_state|review_refresh_outbox|review_summary_checkpoints) t where.*?is distinct from '((?:''|[^'])*)'::jsonb then raise exception",statement)
            self.assertEqual(len(pairs),3)
            mapping={'review_summary_state':'state','review_refresh_outbox':'outbox','review_summary_checkpoints':'checkpoints'}
            for table,payload in pairs:
                if state['rows'][mapping[table]]!=json.loads(payload.replace("''","'")):raise ValueError('payload_changed')
            self.assertEqual(statement.count('delete from '),2)
            state['summaryDeleted']=True;state['rows']=dict(copy.deepcopy(origin),epochUs=4000000);return ''
        def save(name,value):
            if name=='d03-summary-cleanup-candidate-private.json':
                if save_failure:raise OSError('candidate save failed')
                if mutation:mutation(state)
        runtime.sql=sql;runtime.save=save
        return runtime,review,state
    def test_cleanup_lane_success_keeps_fixed_order_and_exact_payload(self):
        runtime,review,state=self.cleanup_lane();runtime.cleanup_fixture(review)
        self.assertFalse(state['business']);self.assertTrue(state['summaryDeleted'])
        self.assertEqual(len(state['calls']),5)
    def test_cleanup_lane_partial_business_failure_rolls_back_and_stops(self):
        runtime,review,state=self.cleanup_lane(partial_failure=True)
        with self.assertRaisesRegex(ValueError,'rollback'):runtime.cleanup_fixture(review)
        self.assertTrue(state['business']);self.assertFalse(state['summaryDeleted']);self.assertEqual(len(state['calls']),2)
    def test_cleanup_lane_candidate_save_failure_never_deletes_summary(self):
        runtime,review,state=self.cleanup_lane(save_failure=True)
        with self.assertRaises(OSError):runtime.cleanup_fixture(review)
        self.assertFalse(state['business']);self.assertFalse(state['summaryDeleted']);self.assertEqual(len(state['calls']),3)
    def test_cleanup_lane_concurrent_payload_or_checkpoint_change_rejects_with_asserts_off(self):
        def state_change(state):state['rows']['state'][0]['revision']=2
        def checkpoint_change(state):state['rows']['checkpoints']=[{'foreign':'checkpoint'}]
        for mutate in(state_change,checkpoint_change):
            with self.subTest(mutate=mutate.__name__):
                runtime,review,state=self.cleanup_lane(mutation=mutate)
                with self.assertRaisesRegex(ValueError,'payload_changed'):runtime.cleanup_fixture(review)
                self.assertFalse(state['summaryDeleted']);self.assertTrue(state['rows']['state'])
    def test_cleanup_lane_preexisting_checkpoint_is_not_deleted_by_appointment_trigger(self):
        runtime,review,state=self.cleanup_lane();state['rows']['checkpoints']=[{'existing':True}]
        with self.assertRaisesRegex(ValueError,'predelete_not_empty'):runtime.cleanup_fixture(review)
        self.assertTrue(state['business']);self.assertFalse(state['summaryDeleted'])
        self.assertEqual(state['rows']['checkpoints'],[{'existing':True}])
    def test_summary_cleanup_sql_has_payload_assertions_and_only_owned_predicates(self):
        import inspect
        source=inspect.getsource(m.FixedDeadlineRuntime.cleanup_fixture)
        self.assertIn('validate_summary_cleanup',source);self.assertIn('d03_summary_payload_changed',source)
        self.assertIn('d03_summary_predelete_not_empty',source);self.assertIn('in share row exclusive mode',source)
        self.assertIn("for table in('review_refresh_outbox','review_summary_state')",source)
        self.assertNotIn('delete from private.review_summary_checkpoints',source)
    @contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
            repo=Path(directory)/'repo';repo.mkdir()
            def git(*args):return subprocess.check_output(['git','-C',str(repo),*args],stderr=subprocess.DEVNULL)
            git('init','-q')
            paths=[*m.OWN_SOURCES,'backend/supabase/migrations/20261021000000_fixture.sql','backend/server/product.ts']
            pins={}
            for n,relative in enumerate(paths):
                path=repo/relative;path.parent.mkdir(parents=True,exist_ok=True);raw=('fixed source '+str(n)+'\n').encode();path.write_bytes(raw);pins[relative]=m.sha(raw)
            (repo/'README.md').write_text('unrelated tracked file\n')
            git('add','.');git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','synthetic fixture')
            head=git('rev-parse','HEAD').decode().strip()
            own={p:pins[p]for p in m.OWN_SOURCES}
            sql_path='backend/supabase/migrations/20261021000000_fixture.sql'
            entries=[{'path':sql_path,'sha256':pins[sql_path],'version':'20261021000000'}]
            service_pins={k:v for k,v in pins.items()if k!=sql_path}
            value={'sourceHead':head,'currentProfile':{'sourceHead':head,'versions':['20261021000000'],
                'migrationEntriesSha256':m.sha(m.canonical(entries))},'pins':service_pins}
            policy=SimpleNamespace(inspect_reviewed_current_migrations=Mock(return_value=({'entries':entries,'excluded':[]},{Path(sql_path):(repo/sql_path).read_bytes()})),COPY=m.re.compile(r' \d+[.]sql$'))
            @contextmanager
            def support(pins):yield policy
            readonly=SimpleNamespace(ReviewedServiceProfileReadonly=ReviewedFixture,current_support=support,source_pins=Mock(return_value=(head,service_pins)))
            with patch.object(m,'ROOT',repo):
                seal=m.ReviewedDeadlineSourceSeal(readonly,ReviewedFixture(value),own)
                try:yield repo,git,seal,readonly,value
                finally:seal.close()
    def test_initial_and_final_full_checks_periodic_fd_checks_not_full_git_blobs(self):
        with self.fixture()as(repo,git,seal,ro,value):
            self.assertEqual(ro.source_pins.call_count,1)
            with patch.object(seal,'git',wraps=seal.git)as calls:
                seal.check();seal.check()
                self.assertFalse(any(c.args[0]=='show'for c in calls.call_args_list))
                self.assertTrue(any(c.args[0]=='ls-files'for c in calls.call_args_list))
            self.assertEqual(ro.source_pins.call_count,1);seal.finish();self.assertEqual(ro.source_pins.call_count,2)
    def test_staged_new_tool_refused(self):
        with self.fixture()as(repo,git,seal,_,value):
            path=repo/'tools/local/new_tool.py';path.parent.mkdir(parents=True,exist_ok=True);path.write_text('new tool')
            git('add','tools/local/new_tool.py')
            with self.assertRaisesRegex(ValueError,'INDEX_CHANGED'):seal.check()
    def test_staged_existing_non_source_change_refused_by_stronger_index_contract(self):
        with self.fixture()as(repo,git,seal,_,value):
            (repo/'README.md').write_text('changed staged doc');git('add','README.md')
            with self.assertRaisesRegex(ValueError,'INDEX_CHANGED'):seal.check()
    def test_untracked_new_sql_and_uppercase_sql_refused(self):
        for name in ('20261022000000_new.sql','20261022000000_new.SQL'):
            with self.subTest(name=name),self.fixture()as(repo,git,seal,_,value):
                (repo/m.ReviewedDeadlineSourceSeal.MIGRATIONS/name).write_text('select 1;')
                with self.assertRaisesRegex(ValueError,'MIGRATION_UNIVERSE'):seal.check()
    def test_untracked_sql_directory_link_refused(self):
        with self.fixture()as(repo,git,seal,_,value):
            (repo/m.ReviewedDeadlineSourceSeal.MIGRATIONS/'external').symlink_to(repo/'backend/server',target_is_directory=True)
            with self.assertRaisesRegex(ValueError,'MIGRATION_SOURCE_LINK'):seal.check()
    def test_same_length_content_edit_and_replacement_refused(self):
        for mode in ('content','replace'):
            with self.subTest(mode=mode),self.fixture()as(repo,git,seal,_,value):
                p=repo/'backend/server/product.ts';raw=p.read_bytes()
                if mode=='content':p.write_bytes(b'x'*len(raw))
                else:p.rename(p.with_name('old.ts'));p.write_bytes(raw)
                with self.assertRaisesRegex(ValueError,'LEAF_CHANGED'):seal.check()
    def test_source_mode_hardlink_and_leaf_symlink_refused(self):
        for mode in ('mode','hardlink','symlink'):
            with self.subTest(mode=mode),self.fixture()as(repo,git,seal,_,value):
                p=repo/'backend/server/product.ts'
                if mode=='mode':p.chmod(0o600)
                elif mode=='hardlink':os.link(p,p.with_name('linked.ts'))
                else:p.rename(p.with_name('old.ts'));p.symlink_to(p.with_name('old.ts'))
                with self.assertRaises((ValueError,OSError)):seal.check()
    def test_parent_rename_permission_change_and_link_refused(self):
        for mode in ('replace','mode','symlink'):
            with self.subTest(mode=mode),self.fixture()as(repo,git,seal,_,value):
                parent=repo/'backend/server'
                if mode=='mode':parent.chmod(0o700)
                else:
                    parent.rename(parent.with_name('old-server'))
                    if mode=='symlink':parent.symlink_to(parent.with_name('old-server'),target_is_directory=True)
                    else:parent.mkdir();shutil.copyfile(parent.with_name('old-server')/'product.ts',parent/'product.ts')
                with self.assertRaisesRegex(ValueError,'PARENT_(PATH|FD)_CHANGED'):seal.check()
    def test_head_change_refused(self):
        with self.fixture()as(repo,git,seal,_,value):
            git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','--allow-empty','-qm','new fixture head')
            with self.assertRaisesRegex(ValueError,'HEAD_CHANGED'):seal.check()
    def test_normal_artifact_additions_concurrent_read_have_no_offset_race(self):
        with self.fixture()as(repo,git,seal,_,value):
            failures=[]
            def produce():
                try:
                    for n in range(50):(repo/('artifact-'+str(n)+'.json')).write_bytes(b'evidence')
                except BaseException as e:failures.append(e)
            thread=threading.Thread(target=produce);thread.start()
            try:
                for _ in range(5):seal.check()
            finally:thread.join()
            self.assertEqual(failures,[]);seal.check()
    def test_final_full_profile_failure_rejected(self):
        with self.fixture()as(repo,git,seal,ro,value):
            ro.source_pins.return_value=(value['sourceHead'],{})
            with self.assertRaisesRegex(ValueError,'FULL_PROFILE_CHANGED'):seal.finish()
    def test_untyped_review_refused_without_git_or_fd(self):
        ro=SimpleNamespace(ReviewedServiceProfileReadonly=ReviewedFixture)
        with patch.object(m.subprocess,'check_output')as git:
            with self.assertRaisesRegex(ValueError,'TYPED_SOURCE'):m.ReviewedDeadlineSourceSeal(ro,{}, {})
            git.assert_not_called()
    def test_initial_uncommitted_blob_refused_even_if_fake_pin_review_matches(self):
        # 실제 source_pins가 거절할 조건을 seal 자체의 Git blob 비교에서도 거절한다.
        with self.fixture()as(repo,git,seal,ro,value):
            p=repo/'backend/server/product.ts';p.write_text('uncommitted source')
            pins=dict(value['pins']);pins['backend/server/product.ts']=m.sha(p.read_bytes())
            new=dict(value,pins=pins);ro.source_pins.return_value=(value['sourceHead'],pins)
            with self.assertRaisesRegex(ValueError,'GIT_BLOB'):m.ReviewedDeadlineSourceSeal(ro,ReviewedFixture(new),seal.own_pins)
    def test_partial_constructor_emfile_closes_all_already_opened_fds(self):
        with self.fixture()as(repo,git,seal,ro,value):
            original_open=os.open;original_close=os.close;opened=set();calls=[]
            def open_limited(*args,**kwargs):
                calls.append(args)
                if len(calls)==7:raise OSError(errno.EMFILE,'synthetic FD limit')
                fd=original_open(*args,**kwargs);opened.add(fd);return fd
            def close_tracked(fd):
                opened.discard(fd);return original_close(fd)
            with patch.object(m.os,'open',side_effect=open_limited),patch.object(m.os,'close',side_effect=close_tracked):
                with self.assertRaises(OSError)as error:m.ReviewedDeadlineSourceSeal(ro,ReviewedFixture(value),seal.own_pins)
                self.assertEqual(error.exception.errno,errno.EMFILE)
            self.assertEqual(opened,set());seal.check()
    def test_shared_parent_fds_are_not_repeated_per_leaf(self):
        with self.fixture()as(repo,git,seal,_,value):
            expected={}
            for relative in seal.pins:
                path=(repo/relative).parent
                while True:
                    expected[path]=True
                    if path==Path('/'):break
                    path=path.parent
            self.assertEqual(set(seal.directories),set(expected))
            self.assertEqual(len(seal.files),len(seal.pins))
    def test_actual_bind_override_installs_real_transport_before_settings(self):
        # 실제 narrow override와 실제 wrapper를 fake kernel/PG에 결합한다. Docker는 생성하지 않는다.
        path=ROOT/m.READONLY_TRANSPORT
        spec=importlib.util.spec_from_file_location('d03_bind_transport_unit',path);transport=importlib.util.module_from_spec(spec);spec.loader.exec_module(transport)
        containers={role:{'id':str(n)*64}for n,role in enumerate(('db','auth','rest','gateway'),1)}
        binding={'sourcePins':{'source':'pin'},'containers':containers,'credentials':{},'origin':'http://127.0.0.1:12345'}
        latest=[];order=[];target={'id':containers['db']['id'],'host':'unix:///synthetic','project':'synthetic'}
        class Reviewed:
            def __init__(self,decision,root,pins,cids,credentials,expires):
                self.prepared_root=root;self.source_pins=pins;self.containers=cids;latest.append(self)
        class Ports:
            def __init__(self):
                self.reviewed=latest[-1];self.target=target;self.base=['docker','--host',target['host']]
                self.runner=SimpleNamespace(root=self.reviewed.prepared_root,call=Mock());self.binding=binding
            def settings(self):
                order.append('settings')
                if not hasattr(self,'deadline_transport'):raise ValueError('wrapper installed too late')
                if not core.thread.is_alive():raise ValueError('monitor not active before settings')
                return {'jwtExpirySeconds':3600,'anonymousEnabled':False,'signupDisabled':True}
            def snapshot(self):return self.read_sql('select 9')
        ai=SimpleNamespace(ReviewedSignedProvisioning=Reviewed,FixedLifecycleProvisioningPorts=Ports,
            provisioning_metadata=Mock(),verify_preserved_resources=Mock())
        ai.SignedRunner=lambda root,binding:SimpleNamespace(call=lambda args:json.dumps([{'Id':containers['db']['id'],'HostConfig':{'PidMode':''}}]))
        ro=SimpleNamespace(exact=json.loads,monitored_read_ports=lambda ai,review,core:Ports())
        core=SimpleNamespace(ai=ai,root=Path('/private/tmp/synthetic'),value={'decisionId':'root','runtimeIdentity':{'path':'runtime.json','sha256':m.sha(b'{}')}},
            read=lambda path:b'{}',live=Mock(side_effect=lambda:order.append('live')),memory=Mock(side_effect=lambda **kw:order.append('memory')),active=Mock(),
            monitor=Mock(side_effect=lambda:order.append('monitor')),thread=None,failures=[])
        owner=SimpleNamespace(core=core,readonly_transport=transport,raw_sticky=[],save=Mock())
        owner.mark_raw_unclosed=lambda name,error:owner.raw_sticky.append(name)
        tree=ast.parse((ROOT/m.SELF).read_bytes())
        cls=next(n for n in ast.walk(tree)if isinstance(n,ast.ClassDef)and n.name=='DeadlineCore')
        method=next(n for n in cls.body if isinstance(n,ast.FunctionDef)and n.name=='bind_ports')
        env={'readonly':ro,'owner':owner,'time':m.time,'need':m.need,'sha':m.sha,'threading':m.threading}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),'<actual-bind-override>','exec'),env)
        class FakeMonitor:
            def __init__(self,target,daemon):self.target=target;self.running=False
            def start(self):self.running=True;self.target()
            def is_alive(self):return self.running
        with patch.object(m.threading,'Thread',FakeMonitor):env['bind_ports'](core,binding,b'raw',target)
        self.assertEqual(order,['live','memory','monitor','settings'])
        self.assertTrue(hasattr(core.port,'assert_closed_state'));core.live.assert_called_once();core.memory.assert_called_once_with(start=True)
        def popen(argv,**kwargs):
            raw=b'{"pid":123,"backendStart":"synthetic"}\n9\n'if 'psql'in argv else b'ABSENT'
            kwargs['stdout'].write(raw);kwargs['stdout'].flush();return SimpleNamespace(poll=lambda:0,returncode=0)
        with patch.object(transport.subprocess,'Popen',side_effect=popen),patch.object(transport,'close_group',return_value={'closed':True,'leaderReaped':True,'processGroupAbsent':True}):
            self.assertEqual(core.port.snapshot(),'9')
        self.assertEqual(ai.verify_preserved_resources.call_count,2);self.assertEqual(owner.raw_sticky,[])
    def test_service_pins_without_sql_capture_manifest_payloads_and_sql_tamper(self):
        with self.fixture()as(repo,git,seal,ro,value):
            self.assertFalse(any(p.endswith('.sql')for p in value['pins']))
            sql='backend/supabase/migrations/20261021000000_fixture.sql'
            self.assertIn(sql,seal.files);self.assertEqual(seal.migrations,[sql])
            (repo/sql).write_bytes(b'changed SQL')
            with self.assertRaisesRegex(ValueError,'LEAF_CHANGED'):seal.check()
    def test_wrong_explicit_migration_manifest_refused(self):
        with self.fixture()as(repo,git,seal,ro,value):
            value['currentProfile']['migrationEntriesSha256']='0'*64
            with self.assertRaisesRegex(ValueError,'MIGRATION_MANIFEST'):m.ReviewedDeadlineSourceSeal(ro,ReviewedFixture(value),seal.own_pins)
    def test_initial_policy_excluded_copy_is_preserved_not_executed(self):
        with self.fixture()as(repo,git,seal,ro,value):
            copy='backend/supabase/migrations/20261021000000_fixture 2.sql';(repo/copy).write_bytes(b'non executed original copy')
            with ro.current_support(value['pins'])as policy:policy.inspect_reviewed_current_migrations.return_value[0]['excluded'].append(copy)
            other=m.ReviewedDeadlineSourceSeal(ro,ReviewedFixture(value),seal.own_pins)
            try:
                self.assertEqual(other.preservation_copies,{copy});other.check()
                (repo/copy).write_bytes(b'copy changed')
                with self.assertRaisesRegex(ValueError,'LEAF_CHANGED'):other.check()
            finally:other.close()
    def test_unknown_excluded_sql_cannot_be_promoted_to_copy(self):
        with self.fixture()as(repo,git,seal,ro,value):
            extra='backend/supabase/migrations/20261022000000_unknown.sql';(repo/extra).write_bytes(b'unreviewed')
            with ro.current_support(value['pins'])as policy:policy.inspect_reviewed_current_migrations.return_value[0]['excluded'].append(extra)
            with self.assertRaisesRegex(ValueError,'UNREVIEWED_EXCLUDED_SQL'):m.ReviewedDeadlineSourceSeal(ro,ReviewedFixture(value),seal.own_pins)
    def test_actual_runtime_bind_creates_evidence_before_first_port_call(self):
        helper=m.load(m.PRIVATE_ANCHOR_HELPER,m.sha((ROOT/m.PRIVATE_ANCHOR_HELPER).read_bytes()))
        with tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
            root=Path(directory);binding=m.canonical({'accounts':[{'expiresAt':m.time.time()+3600}]});receipt=b'{}'
            (root/'signed-ai-binding-private.json').write_bytes(binding);(root/'signed-ai-binding-private.json').chmod(0o600)
            (root/'receipt.json').write_bytes(receipt);(root/'receipt.json').chmod(0o600)
            r=m.FixedDeadlineRuntime.__new__(m.FixedDeadlineRuntime)
            r.value={'bindingSha256':m.sha(binding),'auth6ReceiptSha256':m.sha(receipt),'auth6Receipt':str(root/'receipt.json')}
            r.authority=SimpleNamespace(d03_alias_review_bytes=b'{}');r.private_anchor_helper=helper;r.binding_anchor=None
            ro=SimpleNamespace(exact=json.loads,verify_auth6_receipt=Mock(),verify_target_profile=Mock());r.readonly=ro
            core=SimpleNamespace(root=root,read=lambda path:Path(path).read_bytes(),ai=SimpleNamespace(signed_prepared_target=Mock(return_value={}),validate_signed_binding=Mock()),evidence=root/'evidence',evidence_owned=False)
            r.core=core;events=[]
            def save(name,value):
                self.assertTrue(core.evidence_owned);self.assertTrue(core.evidence.is_dir());events.append(name)
            core.save=save
            def bind_ports(*args):
                r.save('first-port-intent.json',{'synthetic':True});raise ValueError('synthetic first port failure')
            core.bind_ports=bind_ports
            try:
                with patch.object(m,'runtime_alias_policy',return_value='policy'),self.assertRaisesRegex(ValueError,'first port failure'):r.bind()
                self.assertEqual(events,['first-port-intent.json']);self.assertTrue(core.evidence.is_dir())
            finally:
                if r.binding_anchor is not None:r.binding_anchor.close()
    def test_runtime_original_binding_anchor_accepts_artifacts_and_refuses_tamper(self):
        helper=m.load(m.PRIVATE_ANCHOR_HELPER,m.sha((ROOT/m.PRIVATE_ANCHOR_HELPER).read_bytes()))
        with tempfile.TemporaryDirectory(dir='/private/tmp')as directory:
            root=Path(directory);path=root/'binding.json';raw=b'original binding';path.write_bytes(raw);path.chmod(0o600)
            r=m.FixedDeadlineRuntime.__new__(m.FixedDeadlineRuntime);r.value={'bindingSha256':m.sha(raw)};r.original_binding_raw=raw
            r.binding_anchor=helper.PrivateFileAnchor(path,m.sha(raw),lambda p:p.read_bytes())
            try:
                for n in range(20):(root/('artifact-'+str(n))).write_bytes(b'evidence');self.assertEqual(r.original_binding_bytes(),raw)
                path.write_bytes(b'tampered binding')
                with self.assertRaises(ValueError):r.original_binding_bytes()
            finally:r.binding_anchor.close()
    def test_fast_guard_reads_anchored_original_binding_only(self):
        seal=m.FastSourceSeal.__new__(m.FastSourceSeal);review=SimpleNamespace(source_head='a'*40)
        core=SimpleNamespace(failures=[],read=Mock(side_effect=AssertionError('legacy reader called')))
        runtime=SimpleNamespace(review=review,raw_sticky=[],core=core,memory_last=m.time.monotonic(),original_binding_bytes=Mock(return_value=b'original'))
        seal.runtime=runtime;seal.prepared=m.time.monotonic();seal.started=None;seal.sources={};seal.binding_raw=b'original'
        with patch.object(m.subprocess,'check_output',return_value='a'*40):seal.guard(review)
        runtime.original_binding_bytes.assert_called_once();core.read.assert_not_called()
    def test_initial_activity_order_by_is_inside_aggregate_and_bind_consumes_helper(self):
        query=m.initial_activity_sql()
        # 괄호 회귀일 뿐 PostgreSQL parse/실제 SQL PASS 증거가 아니다.
        prefix=query[:query.index('order by pid')]
        quoted=m.re.sub(r"'(?:[^']|'')*'",'',prefix)
        self.assertEqual(quoted.count('(')-quoted.count(')'),2)
        self.assertIn("'query',query)order by pid)",query)
        self.assertIn('datname=current_database()and pid<>pg_backend_pid()',query)
        tree=ast.parse((ROOT/m.SELF).read_bytes());runtime=next(n for n in tree.body if isinstance(n,ast.ClassDef)and n.name=='FixedDeadlineRuntime')
        bind=next(n for n in runtime.body if isinstance(n,ast.FunctionDef)and n.name=='bind')
        calls=[n for n in ast.walk(bind)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and isinstance(n.func.value,ast.Name)and n.func.value.id=='self'and n.func.attr=='sql']
        self.assertEqual(len(calls),1);self.assertIsInstance(calls[0].args[0],ast.Call)
        self.assertEqual(calls[0].args[0].func.id,'initial_activity_sql')
    def test_other_catalog_aggregate_ordering_retains_correct_call_depth(self):
        tree=ast.parse((ROOT/m.SELF).read_bytes())
        queries=[]
        for node in ast.walk(tree):
            if isinstance(node,ast.Constant)and type(node.value)is str and node.value.startswith('select ')and 'jsonb_agg('in node.value:queries.append(node.value)
        self.assertGreaterEqual(len(queries),6)
        for query in queries:
            # 문자열 literal 괄호는 제거한다. aggregate 정렬은 coalesce+agg depth2 안에 있다.
            for match in m.re.finditer(r'order by (?:pid|schemaname|s[.]setdatabase|p[.]oid)',query):
                prefix=m.re.sub(r"'(?:[^']|'')*'",'',query[:match.start()])
                with self.subTest(query=query[:80]):self.assertEqual(prefix.count('(')-prefix.count(')'),2)
    def test_read_port_sticky_blocks_source_and_docker_before_metadata(self):
        r=m.FixedDeadlineRuntime.__new__(m.FixedDeadlineRuntime);r.review='review';r.raw_sticky=[]
        port=SimpleNamespace(assert_closed_state=Mock(side_effect=ValueError('port sticky')))
        r.core=SimpleNamespace(port=port,source_seal=Mock(),fixed_identity=Mock())
        with self.assertRaisesRegex(ValueError,'port sticky'):r.guard('review',cleanup=True)
        r.core.source_seal.check.assert_not_called();r.core.fixed_identity.assert_not_called()
    def test_read_port_sticky_finalization_skips_full_source_but_closes_fds(self):
        r=m.FixedDeadlineRuntime.__new__(m.FixedDeadlineRuntime);r.raw_sticky=[]
        port=SimpleNamespace(assert_closed_state=Mock(side_effect=ValueError('port sticky')))
        seal=Mock();r.core=SimpleNamespace(port=port,source_seal=seal,done=threading.Event(),thread=None,failures=[],evidence_owned=True)
        r.save=Mock()
        with self.assertRaisesRegex(ValueError,'FINALIZATION_UNPROVEN'):r.close()
        seal.finish.assert_not_called();seal.close.assert_called_once()
        self.assertFalse(r.save.call_args.args[1]['successReturnPermitted'])

if __name__=='__main__':unittest.main()
