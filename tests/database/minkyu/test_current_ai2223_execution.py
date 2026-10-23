"""현재 AI22/23 목적별 승인·보존·capture의 오프라인 회귀. Docker/Auth/API0."""
import ast
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[3]
SOURCE=ROOT/'tests/integration/jonghyun/isolated_ai_contracts.py'
spec=importlib.util.spec_from_file_location('current_ai2223_kernel',SOURCE)
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
REFERENCE='be92ff397d723e45ac33ebeb008a25c2583c28d4'

def packet(root):
    return dict(decisionId='root-offline',purpose='CURRENT_AUTH6_AI22_23_SYNTHETIC_ONLY',root=str(root),sourceHead='a'*40,
        sourcePins={'tests/integration/jonghyun/isolated_ai_contracts.py':'b'*64},bindingSha256='c'*64,auth6Receipt=str(root/('auth-provision-'+'1'*32)/'receipt.json'),auth6ReceiptSha256='d'*64,
        containers={r:{'id':str(n)*64}for n,r in enumerate(('db','auth','rest','gateway'),1)},sessions=[str(__import__('uuid').UUID(int=n))for n in range(1,7)],
        daemonId='879401ec-e2b7-4ad8-9915-0a16ea74e3f5',scopeId='e'*32,approvalExpiresAt=int(time.time())+1200,
        nodePath='/usr/local/bin/node',nodeSha256='f'*64,capsuleRoot='/private/tmp/offline-parent/capsule',migrationVersions=['20261020100000'],
        expectedTables=sorted(['private.table_'+str(n).zfill(3)for n in range(182)]))

class CurrentApprovalTests(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();os.chmod(self.root,0o700)
    def tearDown(self):self.temp.cleanup()
    def test_new_review_exists_and_is_sealed_not_a_legacy_flag(self):
        self.assertTrue(hasattr(m,'ReviewedCurrentAI2223Execution'),'현재 목적별 typed review가 없다')
        value=packet(self.root);r=m.ReviewedCurrentAI2223Execution(value);value['purpose']='changed'
        self.assertEqual(r.descriptor()['purpose'],'CURRENT_AUTH6_AI22_23_SYNTHETIC_ONLY')
        r.descriptor()['purpose']='changed';self.assertEqual(r.descriptor()['purpose'],'CURRENT_AUTH6_AI22_23_SYNTHETIC_ONLY')
    def test_wrong_purpose_flags_head_sessions_and_table_scope_reject(self):
        original=packet(self.root)
        for field,value in [('purpose','SIGNED_LOCAL_AUTH_AI22_23'),('sourceHead','not-a-head'),('sessions',['same']*6),('expectedTables',original['expectedTables'][:-1]),('approvalExpiresAt',int(time.time())-1),('containers',{'db':{'id':'1'*64}})]:
            with self.subTest(field=field):
                v=copy.deepcopy(original);v[field]=value
                with self.assertRaises(ValueError):m.ReviewedCurrentAI2223Execution(v)
        v=copy.deepcopy(original);v['allowRetry']=True
        with self.assertRaises(ValueError):m.ReviewedCurrentAI2223Execution(v)
    def test_original_false_binding_is_not_mutated_by_separate_approval(self):
        v=packet(self.root);b={'preparedRoot':str(self.root),'sourcePins':v['sourcePins'],'containers':v['containers'],'accounts':[{'sessionId':s,'expiresAt':int(time.time())+900}for s in v['sessions']],'approvedByRoot':False,'dockerSlotReady':False}
        raw=json.dumps(b).encode();v['bindingSha256']=hashlib.sha256(raw).hexdigest();r=m.ReviewedCurrentAI2223Execution(v)
        m.validate_current_ai2223_approval(r,raw);self.assertEqual(json.loads(raw)['approvedByRoot'],False);self.assertEqual(b['dockerSlotReady'],False)
        with self.assertRaises(ValueError):m.validate_current_ai2223_approval(r,raw+b' ')
        with patch.object(m.time,'time',return_value=time.time()+1000):
            with self.assertRaises(ValueError):m.validate_current_ai2223_approval(r,raw)
    def test_legacy_runner_prove_clean_prepare_ast_unchanged(self):
        old=ast.parse(subprocess.check_output(['git','-C',str(ROOT),'show',REFERENCE+':'+str(SOURCE.relative_to(ROOT))]));new=ast.parse(SOURCE.read_text())
        for name in ('Runner','SignedRunner'):
            original=next(n for n in old.body if isinstance(n,ast.ClassDef)and n.name==name);current=next(n for n in new.body if isinstance(n,ast.ClassDef)and n.name==name)
            self.assertEqual(ast.dump(current,include_attributes=False),ast.dump(original,include_attributes=False))
    def test_shared_cases_and_cleanup_are_exact_original_ast(self):
        old=ast.parse(subprocess.check_output(['git','-C',str(ROOT),'show',REFERENCE+':'+str(SOURCE.relative_to(ROOT))]));legacy=next(n for n in old.body if isinstance(n,ast.FunctionDef)and n.name=='signed_main')
        start=next(i for i,n in enumerate(legacy.body)if isinstance(n,ast.Try)and any(isinstance(x,ast.Expr)and isinstance(x.value,ast.Call)and isinstance(x.value.func,ast.Attribute)and x.value.func.attr=='prepare'for x in n.body))
        new=next(n for n in ast.parse(SOURCE.read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='_signed_ai2223_cases')
        self.assertEqual(ast.dump(ast.Module(body=new.body[1:-1],type_ignores=[]),include_attributes=False),ast.dump(ast.Module(body=legacy.body[start:],type_ignores=[]),include_attributes=False))
        self.assertEqual(ast.dump(new.body[-1],include_attributes=False),ast.dump(ast.parse('return result').body[0],include_attributes=False))

    def test_capsule_input_copies_only_code_root_and_rejects_changed_original_graph(self):
        fixture={'codeRoot':str(ROOT),'signedLocalAuth':True,'productManifest':{'owned.ts':'a'*64},'opaque':'preserved'};original=copy.deepcopy(fixture)
        with patch.object(m,'product_graph',return_value=fixture['productManifest']):
            dispatched=m.current_ai2223_factory_input(fixture,Path('/private/tmp/fixed/capsule'))
            self.assertEqual(fixture,original);self.assertEqual(dispatched,{**original,'codeRoot':'/private/tmp/fixed/capsule'})
            with self.assertRaises(ValueError):m.current_ai2223_factory_input({**fixture,'productManifest':{}},Path('/private/tmp/fixed/capsule'))

class AdapterConstructionTests(unittest.TestCase):
    def owner(self):
        import base64
        def token(role):
            raw=base64.urlsafe_b64encode(json.dumps({'role':role}).encode()).decode().rstrip('=')
            return 'eyJhbGciOiJIUzI1NiJ9.'+raw+'.synthetic'
        project='fresh-only';target={'project':project,'id':'1'*64,'image':'sha256:'+'a'*64}
        containers={role:{'id':str(n)*64,'name':prefix+project,'image':'sha256:'+'a'*64,'configSha256':'b'*64,'hostConfigSha256':'c'*64,'mountsSha256':'d'*64}for n,(role,prefix)in enumerate({'db':'supabase_db_','auth':'supabase_auth_','rest':'supabase_rest_','gateway':'supabase_kong_'}.items(),1)}
        binding={'sourcePins':{},'containers':containers,'credentials':{'anon':token('anon'),'service':token('service_role')},'origin':'http://127.0.0.1:57601'}
        owner=SimpleNamespace(root=Path('/private/tmp/fake-owned'),binding=binding,value={'decisionId':'root-offline'},evidence=Path('/private/tmp/fake-owned/evidence'),active=lambda:None)
        class Runner:
            sql_calls=[];auth_calls=[]
            def __init__(self,root,binding):self.target=target
            def sql(self,statement):self.sql_calls.append(statement);return 'read'
            def auth_user(self,token):self.auth_calls.append(token);return {'id':'synthetic'}
            def clean(self):self.sql_calls.append('parent cleanup SQL');return None
        class Sql:
            def __init__(self,owner):self.owner=owner
            def execute(self,statement,**kw):
                self.owner.active();Runner.sql_calls.append(statement);self.owner.active();return 'read'
        owner.sql_factory=Sql
        return owner,Runner,target
    def test_named_current_adapter_calls_original_metadata_before_port_construction(self):
        owner,runner,target=self.owner()
        with patch.object(m,'SignedRunner',runner),patch.object(m,'FixedLifecycleProvisioningPorts',return_value=SimpleNamespace(read_sql=lambda *_a,**_k:'read',runner=SimpleNamespace())),patch.object(m,'_CurrentAI2223SQL',side_effect=owner.sql_factory)as ports:
            m._CurrentAI2223Run.prepare_ports(owner)
        self.assertEqual(owner.r.target,target);ports.assert_called_once()
    def test_wrong_db_duplicate_role_and_credential_role_reject_before_ports(self):
        for mutate in ('db','duplicate','credential'):
            owner,runner,_=self.owner()
            if mutate=='db':owner.binding['containers']['db']['id']='9'*64
            elif mutate=='duplicate':owner.binding['containers']['auth']['id']=owner.binding['containers']['db']['id']
            else:owner.binding['credentials']['anon']=owner.binding['credentials']['service']
            with self.subTest(mutate=mutate),patch.object(m,'SignedRunner',runner),patch.object(m,'FixedLifecycleProvisioningPorts')as ports:
                with self.assertRaises(ValueError):m._CurrentAI2223Run.prepare_ports(owner)
                ports.assert_not_called()

class MutationBoundaryTests(unittest.TestCase):
    owner=AdapterConstructionTests.owner
    def test_memory_failure_blocks_new_sql_and_auth_before_parent_transport(self):
        owner,runner,_=self.owner()
        with patch.object(m,'SignedRunner',runner),patch.object(m,'FixedLifecycleProvisioningPorts',return_value=SimpleNamespace(read_sql=lambda *_a,**_k:'read',runner=SimpleNamespace())),patch.object(m,'_CurrentAI2223SQL',side_effect=owner.sql_factory):
            m._CurrentAI2223Run.prepare_ports(owner)
        def fail():raise ValueError('MEMORY_FAILURE')
        owner.active=fail
        with self.assertRaisesRegex(ValueError,'MEMORY_FAILURE'):owner.r.sql('select 1;')
        with self.assertRaisesRegex(ValueError,'MEMORY_FAILURE'):owner.r.auth_user('synthetic')
        self.assertEqual(runner.sql_calls,[]);self.assertEqual(runner.auth_calls,[])
    def test_monitor_failure_after_sql_never_returns_success(self):
        owner,runner,_=self.owner()
        with patch.object(m,'SignedRunner',runner),patch.object(m,'FixedLifecycleProvisioningPorts',return_value=SimpleNamespace(read_sql=lambda *_a,**_k:'read',runner=SimpleNamespace())),patch.object(m,'_CurrentAI2223SQL',side_effect=owner.sql_factory):
            m._CurrentAI2223Run.prepare_ports(owner)
        calls=[0]
        def active():
            calls[0]+=1
            if calls[0]>2:raise ValueError('MEMORY_FAILURE')
        owner.active=active
        with self.assertRaisesRegex(ValueError,'MEMORY_FAILURE'):owner.r.sql('select 1;')
        self.assertEqual(runner.sql_calls,['select 1;'])
    def test_other_open_http_transaction_is_saved_and_refuses_cleanup_gate(self):
        saved={};rows=[{'pid':2345,'backendStart':'fixed','state':'active'}]
        owner=SimpleNamespace(r=SimpleNamespace(sql=lambda _:json.dumps(rows)),children=[],save=lambda n,v:saved.__setitem__(n,v))
        with self.assertRaisesRegex(ValueError,'HTTP_TRANSACTION_NOT_CLOSED'):m._CurrentAI2223Run.verify_http_closed(owner)
        self.assertEqual(saved['http-transactions-before-cleanup-private.json']['otherOpenClientTransactions'],rows)
    def test_child_group_unknown_refuses_all_parent_cleanup_sql(self):
        owner,runner,_=self.owner();owner.children=[SimpleNamespace(child=object())]
        with patch.object(m,'SignedRunner',runner),patch.object(m,'FixedLifecycleProvisioningPorts',return_value=SimpleNamespace(read_sql=lambda *_a,**_k:'read',runner=SimpleNamespace())),patch.object(m,'_CurrentAI2223SQL',side_effect=owner.sql_factory):
            m._CurrentAI2223Run.prepare_ports(owner)
        with self.assertRaisesRegex(ValueError,'LIVE_CHILD_CLEANUP_DEFERRED'):owner.r.clean()
        self.assertEqual(runner.sql_calls,[])

class CleanupGuardTests(unittest.TestCase):
    def test_cleaning_never_bypasses_memory_deadline_done_freshness_or_approval(self):
        import threading
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory).resolve();root.chmod(0o700);v=packet(root)
            binding={'preparedRoot':str(root),'sourcePins':v['sourcePins'],'containers':v['containers'],'accounts':[{'sessionId':x,'expiresAt':int(time.time())+1800}for x in v['sessions']],'approvedByRoot':False,'dockerSlotReady':False}
            raw=json.dumps(binding).encode();v['bindingSha256']=hashlib.sha256(raw).hexdigest();review=m.ReviewedCurrentAI2223Execution(v)
            guard=SimpleNamespace(root=root,value=v,reviewed=review,raw=raw,receipt_raw=b'original receipt',files=SimpleNamespace(private=lambda p:raw if Path(p).name=='signed-ai-binding-private.json'else b'original receipt'),sources=lambda:None,r=None,cleaning=True)
            def reset():guard.failures=[];guard.done=threading.Event();guard.deadline=time.monotonic()+300;guard.memory_last=time.monotonic()
            for condition in ('failure','deadline','done','stale','approval','token'):
                reset();owner,runner,_=AdapterConstructionTests().owner();owner.children=[]
                owner.active=lambda:m._CurrentAI2223Run.active(guard)
                owner.verify_http_closed=lambda:owner.r.sql('select 1;')
                owner.save=lambda *_:None;owner.snapshot=lambda:{}
                with patch.object(m,'SignedRunner',runner),patch.object(m,'FixedLifecycleProvisioningPorts',return_value=SimpleNamespace(runner=SimpleNamespace())),patch.object(m,'_CurrentAI2223SQL',side_effect=owner.sql_factory):
                    m._CurrentAI2223Run.prepare_ports(owner)
                if condition=='failure':guard.failures=['MEMORY_FAILURE']
                elif condition=='deadline':guard.deadline=time.monotonic()-1
                elif condition=='done':guard.done.set()
                elif condition=='stale':guard.memory_last=time.monotonic()-4
                shifted=time.time()+ (1201 if condition=='approval' else 1501 if condition=='token' else 0)
                if condition=='token':
                    # approval는 여전히 유효하지만 원 JWT의 300초 headroom은 소진됐다.
                    shifted=time.time()+1501;v2={**v,'approvalExpiresAt':int(time.time())+3500};guard.reviewed=m.ReviewedCurrentAI2223Execution(v2);guard.value=v2
                else:guard.reviewed=review;guard.value=v
                with self.subTest(condition=condition),patch.object(m.time,'time',return_value=shifted):
                    with self.assertRaises(ValueError):owner.r.clean()
                    with self.assertRaises(ValueError):owner.r.auth_user('original-token')
                    self.assertEqual(runner.sql_calls,[]);self.assertEqual(runner.auth_calls,[])
    def test_cleaning_with_all_current_guards_valid_is_permitted(self):
        import threading
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory).resolve();root.chmod(0o700);v=packet(root)
            binding={'preparedRoot':str(root),'sourcePins':v['sourcePins'],'containers':v['containers'],'accounts':[{'sessionId':x,'expiresAt':int(time.time())+1800}for x in v['sessions']],'approvedByRoot':False,'dockerSlotReady':False}
            raw=json.dumps(binding).encode();v['bindingSha256']=hashlib.sha256(raw).hexdigest()
            owner=SimpleNamespace(root=root,value=v,reviewed=m.ReviewedCurrentAI2223Execution(v),raw=raw,receipt_raw=b'receipt',files=SimpleNamespace(private=lambda p:raw if Path(p).name=='signed-ai-binding-private.json'else b'receipt'),sources=lambda:None,r=None,cleaning=True,failures=[],done=threading.Event(),deadline=time.monotonic()+300,memory_last=time.monotonic())
            m._CurrentAI2223Run.active(owner)

class CurrentMonitorTests(unittest.TestCase):
    def owner(self,memory):
        path='tests/integration/minkyu/deadline_readonly_transport.py';transport=m._current_ai2223_module(path,{path:hashlib.sha256((ROOT/path).read_bytes()).hexdigest()})
        path='tests/integration/minkyu/ai_positive_discovery_local.py';positive=m._current_ai2223_module(path,{path:hashlib.sha256((ROOT/path).read_bytes()).hexdigest()})
        class Done:
            def __init__(self):self.waits=[]
            def is_set(self):return len(self.waits)>=2
            def wait(self,seconds):self.waits.append(seconds)
        return SimpleNamespace(done=Done(),failures=[],memory=memory,transport=transport,positive=positive,memory_error=None)
    def test_current_monitor_one_second_cadence_keeps_existing_maintain_threshold(self):
        probes=[];owner=self.owner(lambda minimum:probes.append(minimum))
        m._CurrentAI2223Run.monitor(owner)
        self.assertEqual(probes,[786432,786432]);self.assertTrue(all(0<=n<=1 for n in owner.done.waits));self.assertFalse(owner.failures)
    def test_monitor_failure_retains_fixed_safe_code_and_stops_new_probes(self):
        probes=[]
        def memory(minimum):probes.append(minimum);raise ValueError('POSITIVE_MEMORY_PROBE')
        owner=self.owner(memory);m._CurrentAI2223Run.monitor(owner)
        self.assertEqual(probes,[786432]);self.assertEqual(owner.failures,['CURRENT_AI2223_MEMORY_MONITOR'])
        self.assertEqual(owner.memory_error,{'type':'VALUE_ERROR','code':'POSITIVE_MEMORY_PROBE'});self.assertFalse(owner.done.waits)

class CurrentCasesTests(unittest.TestCase):
    @staticmethod
    def execute(failure=False):
        import contextlib,io
        class Runner:
            def __init__(self):self.users=['u0','u1','u2'];self.ledgers=[];self.cleaned=0;self.proved=0;self.saved={}
            def prepare(self):pass
            def clean(self):self.cleaned+=1
            def prove(self,f,observations):self.proved+=len(observations)
            def protected_rows(self):return {t:{}for t in m.PROTECTED_BUDGET}
            def save_signed(self,name,value):self.saved[name]=value
            def sql(self,q):
                if 'json_agg(coalesce'in q:return '[3,20,3]'
                if 'jsonb_object_agg(account_id'in q:return '{}'
                if 'reserved_units+charged_units from private.ai_global'in q:return '12800000'
                if "select(clock_timestamp()"in q:return '2026-10-21'
                return ''
        r=Runner();b={'origin':'http://127.0.0.1:57601','credentials':{'anon':'synthetic','service':'synthetic'},'accounts':[{'userId':'u'+str(i),'accessToken':'synthetic'}for i in range(6)],'sourcePins':{}}
        def invoke(f,mode):
            if mode=='--signed-auth-negative':return {'status':'PASS','nativeExternalAttempts':0,'cases':[{'case':name,'status':'PASS','httpStatus':401,'actualAuthReads':n,'rpcCalls':0,'providerCalls':0}for name,n in [('missing',0),('malformed',0),('invalid_signature',1),('service_principal',0)]],**{k:'NOT_RUN'for k in('expiredBearer','revokedSession','anonymousBearer','memberChanged','differentOriginalContext')}}
            if failure:raise ValueError('MODEL_STOP')
            return {'observations':[{'reservations':[{'units':10}]}for _ in range(14 if mode=='--ai-limits' else 3)]}
        with patch.object(m,'product_graph',return_value={}),patch.object(m,'signed_source_pins',return_value={}),contextlib.redirect_stdout(io.StringIO()):
            result=m._signed_ai2223_cases(r,b,invoke)
        return r,result
    def test_real_shared_cases_returns_consumable_result_after_34_and_cleanup(self):
        r,result=self.execute();self.assertIsInstance(result,dict);self.assertEqual(r.proved,34);self.assertEqual(r.cleaned,1)
        self.assertEqual([x['scenario']for x in result['checks']],['SIGNED_AUTH_NEGATIVE','AI22','AI23'])
        self.assertEqual(m._verify_current_ai2223_cases(result),{'AI22':28,'AI23':6,'negativeCases':4})
    def test_new_case_filter_never_treats_negative_receipt_as_an_observation_array(self):
        _,result=self.execute();self.assertEqual(m._verify_current_ai2223_cases(result)['negativeCases'],4)
        bad=copy.deepcopy(result);bad['checks'][0]['cases'][0]['rpcCalls']=1
        with self.assertRaises(ValueError):m._verify_current_ai2223_cases(bad)
        bad=copy.deepcopy(result);bad['checks'].append(copy.deepcopy(result['checks'][1]))
        with self.assertRaises(ValueError):m._verify_current_ai2223_cases(bad)
    def test_real_shared_cases_failure_does_not_skip_finally_cleanup(self):
        with self.assertRaisesRegex(ValueError,'MODEL_STOP'):self.execute(True)

class CurrentSnapshotTests(unittest.TestCase):
    def test_sequence_wire_projection_includes_log_count(self):
        rows={t:{}for t in set(m.LCP_TABLES)|{'private.'+x for x in m.PROTECTED_BUDGET}}
        state={'rows':rows,'authoritySha256':'a'*64,'constraintsSha256':'b'*64,'catalogSha256':'c'*64}
        def read(q):
            if "jsonb_agg(jsonb_build_array(n.nspname"in q:return '[["public","test_seq"]]'
            return '{"public.test_seq":[41,true,0]}'if 'log_cnt'in q else'{"public.test_seq":[41,true]}'
        owner=SimpleNamespace(active=lambda:None,port=SimpleNamespace(history=lambda:{'method':'SUPABASE_DB_HISTORY','native':'NOT_RUN'},snapshot=lambda:copy.deepcopy(state),read_sql=read),value={'expectedTables':sorted(rows)})
        result=m._CurrentAI2223Run.snapshot(owner);self.assertEqual(result['sequences'],{'public.test_seq':[41,True,0]})
    def test_log_count_only_drift_rejects(self):
        before=WholeStateTests().state();after=copy.deepcopy(before);before['sequences']={'public.seq':[41,True,0]};after['sequences']={'public.seq':[41,True,1]}
        with self.assertRaises(ValueError):m.verify_current_ai2223_state(before,after,{})

class WholeStateTests(unittest.TestCase):
    def state(self):return dict(rows={'public.keep':{'a'*64:2},'private.ai_budget_ledgers':{},'private.ai_budget_reservations':{},'private.ai_account_budget_reservations':{},'private.ai_account_daily_budget':{},'private.ai_global_daily_budget':{}},authoritySha256='a'*64,constraintsSha256='b'*64,catalogSha256='c'*64,sequences={'public.synthetic_seq':[41,True]})
    def test_only_planned_budget_rows_additive_and_other_whole_state_exact(self):
        before=self.state();after=copy.deepcopy(before);after['rows']['private.ai_budget_ledgers']={'d'*64:1}
        m.verify_current_ai2223_state(before,after,{'private.ai_budget_ledgers':{'d'*64:1}})
        for field in ('authoritySha256','constraintsSha256','catalogSha256','sequences'):
            bad=copy.deepcopy(after);bad[field]={}if field=='sequences'else'f'*64
            with self.subTest(field=field),self.assertRaises(ValueError):m.verify_current_ai2223_state(before,bad,{'private.ai_budget_ledgers':{'d'*64:1}})
    def test_unapproved_budget_row_old_unknown_loss_and_bag_count_change_reject(self):
        before=self.state();before['rows']['private.ai_budget_reservations']={'e'*64:1}
        for table,bag in [('public.keep',{'a'*64:1}),('private.ai_budget_reservations',{}),('private.ai_budget_ledgers',{'f'*64:1})]:
            after=copy.deepcopy(before);after['rows'][table]=bag
            with self.subTest(table=table),self.assertRaises(ValueError):m.verify_current_ai2223_state(before,after,{})


class CaptureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.modules={}
        for name,path in [('positive','tests/integration/minkyu/ai_positive_discovery_local.py'),('private','tools/local/prepare_auth_negative.py'),('observer','tools/local/observe_isolated.py')]:
            cls.modules[name]=m._current_ai2223_module(path,{path:hashlib.sha256((ROOT/path).read_bytes()).hexdigest()})
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();os.chmod(self.root,0o700)
        self.files=m._CurrentAI2223Files(self.modules['private'])
        self.owner=SimpleNamespace(evidence=self.root,files=self.files,positive=self.modules['positive'],observer=self.modules['observer'],value={'nodePath':'/fixed/node','capsuleRoot':'/fixed/capsule'},active=lambda:None,check_capsule_and_node=lambda:None)
    def tearDown(self):self.temp.cleanup()
    def invoke(self,script,mode='--ai-limits'):
        capture=m._CurrentAI2223Capture(self.owner,'fixed');real=subprocess.Popen
        def start(argv,**kw):
            self.assertEqual(argv[-1],mode);self.assertTrue(kw['start_new_session']);return real([sys.executable,'-c',script],**kw)
        with patch.object(m.subprocess,'Popen',side_effect=start):return capture,capture.invoke({'synthetic':True},mode)
    def test_real_child_raw_streams_are_durable_and_group_closed_before_success(self):
        capture,result=self.invoke('import sys;print(\'{"status":"PASS","nativeExternalAttempts":0}\');sys.stderr.write("synthetic diagnostic")')
        self.assertEqual(result['status'],'PASS');self.assertIsNone(capture.child)
        out=self.files.private(capture.evidence/'positive-factory-stdout-private.json');err=self.files.private(capture.evidence/'positive-factory-stderr-private.json')
        outcome=json.loads(self.files.private(capture.evidence/'positive-factory-outcome.json'))
        self.assertEqual(err,b'synthetic diagnostic');self.assertEqual(outcome['stdoutSha256'],hashlib.sha256(out).hexdigest());self.assertEqual(outcome['stderrSha256'],hashlib.sha256(err).hexdigest())
        self.assertTrue(json.loads((capture.evidence/'current-child-closed.json').read_bytes())['closed'])
    def test_final_raw_outcome_or_child_artifact_change_is_not_hidden(self):
        capture,_=self.invoke('print(\'{"status":"PASS","nativeExternalAttempts":0}\')')
        self.assertTrue(hasattr(capture,'verify_evidence'),'최종 command evidence 재검사가 없다')
        capture.verify_evidence()
        path=capture.evidence/'positive-factory-stdout-private.json';path.write_bytes(b'tampered')
        with self.assertRaises(ValueError):capture.verify_evidence()
    def test_live_stream_overflow_is_bounded_and_never_promoted(self):
        with self.assertRaises(ValueError):self.invoke('import sys;sys.stdout.write("x"*1200000);sys.stdout.flush()')
        evidence=self.root/'factory-fixed';raw=self.files.private(evidence/'positive-factory-stdout-private.json')
        self.assertEqual(len(raw),1048576);outcome=json.loads((evidence/'positive-factory-outcome.json').read_bytes());self.assertIn('POSITIVE_CAPTURE_LIMIT',outcome['streamFailures']);self.assertTrue(json.loads((evidence/'current-child-closed.json').read_bytes())['closed'])
    def test_failure_after_child_start_saves_partial_raw_and_closes_exact_group(self):
        calls=[0]
        def active():
            calls[0]+=1
            if calls[0]>3:raise ValueError('MEMORY_STOP')
        self.owner.active=active
        with self.assertRaisesRegex(ValueError,'MEMORY_STOP'):self.invoke('import sys,time;print("partial",flush=True);time.sleep(5)')
        evidence=self.root/'factory-fixed';self.assertTrue((evidence/'positive-factory-outcome.json').is_file());self.assertTrue(json.loads((evidence/'current-child-closed.json').read_bytes())['closed'])
    def test_error_exit_and_malformed_proof_reject_with_raw(self):
        with self.assertRaises(ValueError):self.invoke('import sys;print("partial");sys.stderr.write("fixed error");sys.exit(7)')
        outcome=json.loads((self.root/'factory-fixed/positive-factory-outcome.json').read_bytes());self.assertEqual(outcome['exitCode'],7)
    def test_unclosed_group_is_sticky_and_refuses_success(self):
        with patch.object(self.modules['observer'],'group_alive',return_value=True),patch.object(self.modules['observer'],'terminate',return_value=None):
            with self.assertRaisesRegex(ValueError,'CHILD_CLOSURE_UNPROVEN'):self.invoke('print(\'{"status":"PASS","nativeExternalAttempts":0}\')')
        self.assertFalse(json.loads((self.root/'factory-fixed/current-child-closed.json').read_bytes())['closed'])
    def test_two_dispatches_cannot_reuse_same_private_command(self):
        self.invoke('print(\'{"status":"PASS","nativeExternalAttempts":0}\')')
        with self.assertRaises(FileExistsError):m._CurrentAI2223Capture(self.owner,'fixed')

class FailureReceiptTests(unittest.TestCase):
    def test_prebaseline_failure_never_claims_whole_state_preserved(self):
        import threading
        saved={}
        state=WholeStateTests().state()
        owner=SimpleNamespace(transport=SimpleNamespace(safe_error=lambda e:None if e is None else{'type':'VALUE_ERROR','code':'UNCLASSIFIED_FAILURE'}),memory_error=None,samples=[2000000],memory=lambda _:None,thread=None,monitor=lambda:None,active=lambda:None,
            prepare_ports=lambda:None,r=SimpleNamespace(signed_identity=lambda:None),port=SimpleNamespace(settings=lambda:{},read_sql=lambda _: 'f'),children=[],cleaning=False,
            before=None,snapshot=lambda:state,save=lambda k,v:saved.__setitem__(k,v),sources=lambda **_:None,done=threading.Event(),failures=[],
            sql_port=None,value={'sourceHead':'a'*40,'bindingSha256':'b'*64},deadline=time.monotonic()+300)
        with patch.object(m,'_CurrentAI2223Run',return_value=owner):
            with self.assertRaises(ValueError):m.run_current_ai2223(object())
        self.assertEqual(saved['current-execution-receipt.json']['status'],'FAIL');self.assertEqual(saved['current-execution-receipt.json']['preservation'],'NOT_PROVEN')


    def test_original_and_final_failure_codes_are_separate_in_final_receipt(self):
        import threading
        saved={};path='tests/integration/minkyu/deadline_readonly_transport.py'
        transport=m._current_ai2223_module(path,{path:hashlib.sha256((ROOT/path).read_bytes()).hexdigest()})
        def failed_snapshot():raise ValueError('CURRENT_AI2223_MEMORY_OR_DEADLINE')
        owner=SimpleNamespace(transport=transport,memory_error={'type':'VALUE_ERROR','code':'POSITIVE_MEMORY_PROBE'},samples=[2000000],memory=lambda _:None,thread=None,monitor=lambda:None,active=lambda:None,
            prepare_ports=lambda:None,r=SimpleNamespace(signed_identity=lambda:None),port=SimpleNamespace(settings=lambda:{},read_sql=lambda _:'f'),children=[],cleaning=False,
            before=None,snapshot=failed_snapshot,save=lambda k,v:saved.__setitem__(k,v),sources=lambda **_:None,done=threading.Event(),failures=[],
            sql_port=None,value={'sourceHead':'a'*40,'bindingSha256':'b'*64},deadline=time.monotonic()+300)
        with patch.object(m,'_CurrentAI2223Run',return_value=owner):
            with self.assertRaisesRegex(ValueError,'AUTH_SETTINGS'):m.run_current_ai2223(object())
        receipt=saved['current-execution-receipt.json']
        self.assertEqual(receipt['status'],'FAIL');self.assertEqual(receipt['preservation'],'NOT_PROVEN')
        self.assertEqual(receipt['originalFailure'],{'type':'VALUE_ERROR','code':'UNCLASSIFIED_FAILURE'})
        self.assertEqual(receipt['memoryFailure'],{'type':'VALUE_ERROR','code':'POSITIVE_MEMORY_PROBE'})
        self.assertEqual(receipt['finalFailureDetails'],[{'stage':'FINAL','failure':{'type':'VALUE_ERROR','code':'CURRENT_AI2223_MEMORY_OR_DEADLINE'}}])
        self.assertEqual(saved['final-unavailable-private.json']['failure'],receipt['finalFailureDetails'][0]['failure'])


class OverallDeadlineTests(unittest.TestCase):
    def test_full_proof_after_original_300_seconds_is_fail_even_when_cleanup_succeeds(self):
        import threading
        saved={};state=WholeStateTests().state()
        def read_sql(sql):
            if 'unknown_at is not null'in sql:return '[{},{}]'
            if "select(clock_timestamp()"in sql:return '2026-10-21'
            return 'f'
        owner=SimpleNamespace(transport=SimpleNamespace(safe_error=lambda e:None if e is None else{'type':'VALUE_ERROR','code':'UNCLASSIFIED_FAILURE'}),memory_error=None,samples=[2000000],memory=lambda _:None,thread=None,monitor=lambda:None,active=lambda:None,prepare_ports=lambda:None,
            r=SimpleNamespace(signed_identity=lambda:None,ledgers=['synthetic-a','synthetic-b']),port=SimpleNamespace(settings=lambda:{'jwtExpirySeconds':3600,'anonymousEnabled':False,'signupDisabled':True},closed_controls=lambda:{**{k:False for k in m.PROVISION_CLOSED_CONTROLS},'cronLaunchActiveJobs':'off'},read_sql=read_sql),
            check_capsule_and_node=lambda:None,snapshot=lambda:copy.deepcopy(state),save=lambda k,v:saved.__setitem__(k,v),added_budget_rows=lambda:{},children=[],cleaning=False,before=None,
            sources=lambda **_:None,done=threading.Event(),failures=[],sql_port=None,value={'sourceHead':'a'*40,'bindingSha256':'b'*64},binding={},invoke=lambda *_:None,deadline=time.monotonic()-1)
        _,proof=CurrentCasesTests.execute()
        with patch.object(m,'_CurrentAI2223Run',return_value=owner),patch.object(m,'_signed_ai2223_cases',return_value=proof):
            with self.assertRaisesRegex(ValueError,'FINAL_UNPROVEN'):m.run_current_ai2223(object())
        self.assertEqual(saved['current-execution-receipt.json']['status'],'FAIL');self.assertIn('final-private.json',saved)

class IntentBoundaryTests(unittest.TestCase):
    def test_global_intent_is_consumed_before_any_port_and_second_scope_is_rejected(self):
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory).resolve();root.chmod(0o700);v=packet(root)
            b={'preparedRoot':str(root),'sourcePins':v['sourcePins'],'containers':v['containers'],'accounts':[{'sessionId':x,'expiresAt':int(time.time())+900}for x in v['sessions']],
                'approvedByRoot':False,'dockerSlotReady':False,'evidenceRoot':str(root/('signed-auth-'+'1'*32))}
            raw=json.dumps(b).encode();v['bindingSha256']=hashlib.sha256(raw).hexdigest();(root/'signed-ai-binding-private.json').write_bytes(raw);(root/'signed-ai-binding-private.json').chmod(0o600)
            receipt={'status':'PASS_LOCAL_AUTH6_PROVISION_ONLY','accounts':6,'bindingSha256':v['bindingSha256'],'actualGoTrueAndDatabaseSessions':True,'originalRowsPreserved':True,'authAccountsRetained':True,
                'actualAI22AI23AI24':'NOT_RUN','actualNaver':'NOT_RUN','creationReceiptRoot':str(Path(v['auth6Receipt']).parent)}
            receipt_path=Path(v['auth6Receipt']);receipt_path.parent.mkdir(mode=0o700);receipt_raw=json.dumps(receipt).encode();receipt_path.write_bytes(receipt_raw);receipt_path.chmod(0o600);v['auth6ReceiptSha256']=hashlib.sha256(receipt_raw).hexdigest()
            target={'versions':v['migrationVersions'],'context':'colima-yumidang-minkyu'}
            real=m._current_ai2223_module
            def helper(path,pins):return real(path,{path:hashlib.sha256((ROOT/path).read_bytes()).hexdigest()})
            with patch.object(m._CurrentAI2223Run,'sources',return_value=None),patch.object(m,'_current_ai2223_module',side_effect=helper),patch.object(m,'signed_prepared_target',return_value=target),patch.object(m,'validate_signed_binding',return_value=b),patch.object(m,'FixedLifecycleProvisioningPorts')as ports:
                m._CurrentAI2223Run(m.ReviewedCurrentAI2223Execution(v));ports.assert_not_called()
                intent=root/'current-ai2223-execution-intent.json';saved=intent.read_bytes();self.assertEqual(intent.stat().st_mode&0o777,0o600)
                v['scopeId']='2'*32
                with self.assertRaises(FileExistsError):m._CurrentAI2223Run(m.ReviewedCurrentAI2223Execution(v))
                self.assertEqual(intent.read_bytes(),saved);self.assertEqual((root/'signed-ai-binding-private.json').read_bytes(),raw);ports.assert_not_called()
    def test_working_source_bytes_and_head_still_reject(self):
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory).resolve();p=root/'owned.py';p.write_bytes(b'original')
            owner=SimpleNamespace(value={'sourceHead':'a'*40,'sourcePins':{'owned.py':hashlib.sha256(b'original').hexdigest()}})
            with patch.object(m,'REPO',root),patch.object(m.subprocess,'check_output',return_value='a'*40):
                m._CurrentAI2223Run.sources(owner);p.write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError,'SOURCE_CHANGED'):m._CurrentAI2223Run.sources(owner)
            with patch.object(m,'REPO',root),patch.object(m.subprocess,'check_output',return_value='b'*40):
                with self.assertRaisesRegex(ValueError,'HEAD_CHANGED'):m._CurrentAI2223Run.sources(owner)

class SourceClosureTests(unittest.TestCase):
    def test_signed_extra_helper_cannot_be_uncommitted_outside_observer_subset(self):
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory).resolve();head='a'*40
            tracked=b'original';blob={p:b'pass\n'for p in m._CURRENT_AI2223_SUPPORT}
            blob[m._CURRENT_AI2223_SUPPORT[0]]=('def source_pins():\n    return '+repr({'tracked.py':hashlib.sha256(tracked).hexdigest()})+'\n').encode()
            blob.update({'tracked.py':tracked,'signed-extra.py':b'original extra'})
            for name,raw in blob.items():p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
            def git(argv,**_kw):return head if argv[-2:]==['rev-parse','HEAD']else blob[argv[-1].split(':',1)[1]]
            def extra():return {'signed-extra.py':hashlib.sha256((root/'signed-extra.py').read_bytes()).hexdigest()}
            with patch.object(m,'REPO',root),patch.object(m.subprocess,'check_output',side_effect=git),patch.object(m,'signed_source_pins',side_effect=extra):
                result=m.current_ai2223_source_pins(head);self.assertIn('signed-extra.py',result)
                (root/'signed-extra.py').write_bytes(b'uncommitted extra')
                with self.assertRaisesRegex(ValueError,'SOURCE_NOT_COMMITTED'):m.current_ai2223_source_pins(head)
    def test_exact_source_set_cannot_omit_an_existing_dependency(self):
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory).resolve();(root/'owned.py').write_bytes(b'original')
            owner=SimpleNamespace(value={'sourceHead':'a'*40,'sourcePins':{'owned.py':hashlib.sha256(b'original').hexdigest()}})
            with patch.object(m,'REPO',root),patch.object(m.subprocess,'check_output',return_value='a'*40),patch.object(m,'current_ai2223_source_pins',return_value={**owner.value['sourcePins'],'missing.py':'b'*64}):
                with self.assertRaisesRegex(ValueError,'EXACT_SOURCE_SET'):m._CurrentAI2223Run.sources(owner,initial=True)
    def test_raw_authority_argument_cannot_reach_resource_ports(self):
        with patch.object(m,'signed_prepared_target')as target:
            with self.assertRaisesRegex(ValueError,'TYPED_REVIEW'):m.run_current_ai2223({})
            target.assert_not_called()

class StickySqlTests(unittest.TestCase):
    def make(self,root):
        v=packet(root);review=m.ReviewedCurrentAI2223Execution(v);saved={}
        root.chmod(0o700)
        private=m._current_ai2223_module('tools/local/prepare_auth_negative.py',{'tools/local/prepare_auth_negative.py':hashlib.sha256((ROOT/'tools/local/prepare_auth_negative.py').read_bytes()).hexdigest()})
        files=m._CurrentAI2223Files(private)
        def save(name,value):saved[name]=value;return files.save(root,name,value)
        owner=SimpleNamespace(reviewed=review,value=review.descriptor(),root=root,evidence=root,files=files,binding={'containers':v['containers']},active=lambda:None,save=save)
        owner.transport=m._current_ai2223_module('tests/integration/minkyu/deadline_readonly_transport.py',{'tests/integration/minkyu/deadline_readonly_transport.py':hashlib.sha256((ROOT/'tests/integration/minkyu/deadline_readonly_transport.py').read_bytes()).hexdigest()})
        owner.r=SimpleNamespace(base=['docker','--host','unix:///fixed'],target={'id':'1'*64,'host':'unix:///fixed'},signed_identity=lambda:None,call=lambda _:json.dumps([{'Id':'1'*64,'HostConfig':{'PidMode':''}}]))
        return m._CurrentAI2223SQL(owner),saved,owner
    def test_timeout_is_sticky_and_blocks_second_sql_and_cleanup_transport(self):
        with tempfile.TemporaryDirectory()as directory:
            port,saved,_=self.make(Path(directory).resolve())
            with patch.object(port,'child',side_effect=subprocess.TimeoutExpired('fixed',1))as child:
                with self.assertRaises(subprocess.TimeoutExpired):port.execute('select 1;')
                with self.assertRaisesRegex(ValueError,'STICKY'):port.execute('delete from private.ai_member_processing;')
                self.assertEqual(child.call_count,1)
            self.assertTrue(port.sticky);self.assertIn('current-sql-00001-intent.json',saved)
    def test_real_local_timeout_saves_partial_raw_group_proof_and_sticky(self):
        with tempfile.TemporaryDirectory()as directory:
            port,saved,_=self.make(Path(directory).resolve());real=subprocess.Popen
            def start(argv,**kw):
                return real([sys.executable,'-c','import time;print("partial",flush=True);time.sleep(5)'],**kw)
            with patch.object(m.subprocess,'Popen',side_effect=start)as launched:
                with self.assertRaisesRegex(ValueError,'PROCESS_TIMEOUT'):port.execute('select 1;',timeout=.1)
                with self.assertRaisesRegex(ValueError,'STICKY'):port.execute('select 2;')
                self.assertEqual(launched.call_count,1)
            raw=saved['current-sql-00001-raw-private.json'];self.assertTrue(raw['closure']['closed'])
            self.assertEqual(raw['streams']['stdout']['capturedBytes'],8);self.assertTrue(port.sticky)
            self.assertEqual(saved['current-sql-00001-unknown.json']['additionalSqlPermitted'],False)
            self.assertEqual(saved['current-sql-00001-unknown.json']['failure'],{'type':'VALUE_ERROR','code':'D03_READ_PROCESS_TIMEOUT'})
    def test_backend_absence_is_required_before_sticky_clears(self):
        with tempfile.TemporaryDirectory()as directory:
            port,_,_=self.make(Path(directory).resolve())
            with patch.object(port,'child',return_value=b'{"pid":12345,"backendStart":"fixed"}\n1\n'),patch.object(port,'absent',side_effect=ValueError('BACKEND_REMAINS')):
                with self.assertRaisesRegex(ValueError,'BACKEND_REMAINS'):port.execute('select 1;')
            self.assertTrue(port.sticky)
    def test_success_has_exact_backend_marker_and_readonly_transaction(self):
        with tempfile.TemporaryDirectory()as directory:
            port,saved,owner=self.make(Path(directory).resolve());calls=[];real=subprocess.Popen
            def start(argv,**kw):
                calls.append(argv)
                script='print(\'{"pid":12345,"backendStart":"fixed"}\');print("1")'if 'psql'in argv else 'print("ABSENT",end="")'
                return real([sys.executable,'-c',script],**kw)
            with patch.object(m.subprocess,'Popen',side_effect=start):
                self.assertEqual(port.execute('select 1;',timeout=3,read_only=True),'1')
            self.assertFalse(port.sticky);body=saved['current-sql-00001-intent.json']['sqlUtf8'];self.assertIn('begin read only;',body);self.assertIn('rollback;',body)
            self.assertTrue(saved['current-sql-00001-closed.json']['backendAbsent']);self.assertEqual(len(calls),2);port.verify_evidence()
            raw=saved['current-sql-00001-raw-private.json'];self.assertTrue(raw['closure']['closed']);self.assertTrue(all(x['wholeProven']for x in raw['streams'].values()))
    def test_timeout_sticky_blocks_parent_cleanup_before_any_more_sql(self):
        with tempfile.TemporaryDirectory()as directory:
            port,_,_=self.make(Path(directory).resolve())
            owner,runner,_=AdapterConstructionTests().owner()
            owner.children=[];owner.verify_http_closed=lambda:owner.r.sql('select 1;')
            owner.save=lambda *_:None;owner.snapshot=lambda:{}
            with patch.object(m,'SignedRunner',runner),patch.object(m,'FixedLifecycleProvisioningPorts',return_value=SimpleNamespace(runner=SimpleNamespace())),patch.object(m,'_CurrentAI2223SQL',return_value=port):
                m._CurrentAI2223Run.prepare_ports(owner)
            with patch.object(port,'child',side_effect=subprocess.TimeoutExpired('fixed',1))as child:
                with self.assertRaises(subprocess.TimeoutExpired):owner.r.sql('select 1;')
                with self.assertRaisesRegex(ValueError,'STICKY'):owner.r.clean()
                self.assertEqual(child.call_count,1);self.assertEqual(runner.sql_calls,[])
    def test_missing_marker_never_clears_unknown(self):
        with tempfile.TemporaryDirectory()as directory:
            port,_,_=self.make(Path(directory).resolve())
            with patch.object(port,'child',return_value=b'1\n'),patch.object(port,'absent')as absent:
                with self.assertRaises(ValueError):port.execute('select 1;')
                absent.assert_not_called()
            self.assertTrue(port.sticky)
    def test_readonly_port_rejects_write_before_child(self):
        with tempfile.TemporaryDirectory()as directory:
            port,_,_=self.make(Path(directory).resolve())
            with patch.object(port,'child')as child:
                with self.assertRaises(ValueError):port.execute('delete from public.profiles;',timeout=3,read_only=True)
                child.assert_not_called()

if __name__=='__main__':unittest.main()
