"""동일 kernel exact bridge·역사 custody 보존 합성 회귀. 실제 DB/Auth/자정 실행 없음."""
import ast
import subprocess
import tempfile
import time
import threading
import hashlib
import copy
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tools/local'))
spec=importlib.util.spec_from_file_location('current_custody_kernel_test',ROOT/'tests/integration/jonghyun/isolated_ai_contracts.py')
k=importlib.util.module_from_spec(spec);spec.loader.exec_module(k)
sys.path.pop(0)

class Review:
    operation=None
    def __init__(self,value):self.value=value
    def descriptor(self):return copy.deepcopy(self.value)
class Operation:pass
class Database:
    allowed=True
    def __init__(self,*args):
        self.preparation_status={'executionAllowed':self.allowed};self.sticky=False;self.calls=[]
    def assert_closed_state(self):
        if self.sticky:raise ValueError('STICKY')
    def read_sql(self,*args):self.calls.append(args);return 'fixed'

class BridgeTests(unittest.TestCase):
    def setUp(self):
        k._CURRENT_DATABASE_PAIRS.clear();k._CURRENT_DATABASE_BRIDGE_SEALS.clear();Database.allowed=True
        self.module=types.SimpleNamespace(ReviewedCurrentAI24Database=Review,MidnightOperation=Operation,CurrentDatabase=Database)
        Review.operation=Operation
    def fixture(self):
        r=object.__new__(k.CurrentSignedMidnightRunner);r.root=Path('/private/tmp/current-test');r.scope_id='scope';r.boundary_epoch=123;r.users=['00000000-0000-4000-8000-00000000000'+str(i)for i in range(1,4)];r.changed=False;r.children=[];r.target={'id':'1'*64};r.evidence=r.root/'evidence';r.current_database_pins={'x':'hash'}
        sessions=[{'userId':u,'primarySessionId':'10000000-0000-4000-8000-00000000000'+str(i),'secondarySessionId':'20000000-0000-4000-8000-00000000000'+str(i)}for i,u in enumerate(r.users,1)]
        profile={'sourceHead':'a'*40,'migrationEntriesSha256':'b'*64,'versions':[],'expectedTables':[],'fullTableSetSha256':'c'*64,'memberSessions':sessions}
        r.current_midnight_profile=types.SimpleNamespace(descriptor=lambda:copy.deepcopy(profile))
        r.binding={'approvedByRoot':False,'dockerSlotReady':False,'containers':{x:{'id':str(i)*64}for i,x in enumerate(['db','auth','rest','gateway'],1)},'accounts':[{'userId':m['userId'],'sessionId':m[z],'expiresAt':int(time.time())+3600,'accessToken':'synthetic'}for m in sessions for z in ['primarySessionId','secondarySessionId']]}
        value=dict(sourceHead=profile['sourceHead'],pins=r.current_database_pins,profile={k:v for k,v in profile.items()if k!='memberSessions'},root=str(r.root),scopeId=r.scope_id,boundaryEpoch=r.boundary_epoch,containers=r.binding['containers'],users=r.users)
        r.current_cancelled=threading.Event();r.current_cleanup_active=False
        return r,Review(value)
    def approval(self,r,**changes):
        data=dict(decision_id='root-exec',source_head='a'*40,prepared_root=r.root,scope_id=r.scope_id,
            binding_sha256=hashlib.sha256(json.dumps(r.binding).encode()).hexdigest(),containers=r.binding['containers'],
            member_sessions=r.current_midnight_profile.descriptor()['memberSessions'],daemon_id='879401ec-e2b7-4ad8-9915-0a16ea74e3f5',expires_at=int(time.time())+600)
        data.update(changes);return k.ReviewedCurrentMidnightExecutionApproval(**data)
    def bind(self,r,v,approval=None):
        approval=self.approval(r)if approval is None else approval
        with patch.object(k,'current_midnight_database_module',return_value=self.module),patch.object(k,'signed_private_read',return_value=json.dumps(r.binding).encode()),patch.object(k.ReviewedCurrentMidnightDatabaseBridge,'execution_guard'):
            return k.bind_current_midnight_database(r,v,approval)
    def test_normal_exact_pair_delegates_finite_read(self):
        r,v=self.fixture();b=self.bind(r,v);self.assertIs(r.bridge(),b);self.assertEqual(r.read_sql('fixed'), 'fixed')
    def test_real_database_constructor_same_kernel_typed_bridge(self):
        # 실제 DB 포트 생성자/registry를 연결한다. Git 봉인·외부 inspect는 별도 회귀 경계다.
        ds=importlib.util.spec_from_file_location('custody_actual_database',ROOT/'tools/local/current_ai24_database.py')
        db=importlib.util.module_from_spec(ds);ds.loader.exec_module(db)
        ps=importlib.util.spec_from_file_location('custody_captured_prepare',ROOT/'tools/local/prepare_isolated_midnight.py')
        prepared=importlib.util.module_from_spec(ps);ps.loader.exec_module(prepared)
        r,_=self.fixture();r.base=('docker','--host','fixture');r.all_users=list(r.users)
        r.boundary_epoch=1761058800
        paths=(db.SELF,db.PURE,db.KERNEL,'tools/local/provision_current_midnight.py','tools/local/prepare_isolated_midnight.py')
        r.current_database_pins={p:db.sha((ROOT/p).read_bytes())for p in paths}
        tables=sorted('public.t'+str(n)for n in range(182))
        profile=dict(sourceHead='a'*40,migrationEntriesSha256='b'*64,
            versions=[str(20261020000000+n)for n in range(124)],expectedTables=tables,fullTableSetSha256=db.sha(db.canonical(tables)))
        sessions=r.current_midnight_profile.descriptor()['memberSessions']
        r.current_midnight_profile=types.SimpleNamespace(descriptor=lambda:dict(profile,memberSessions=copy.deepcopy(sessions)))
        review=db.ReviewedCurrentAI24Database('root-db',db.MidnightOperation(),'a'*40,r.current_database_pins,
            profile,r.root,r.scope_id,r.binding['containers'],r.users,boundary_epoch=r.boundary_epoch)
        approval=self.approval(r);before=copy.deepcopy(r.binding)
        # 정상 prepare 생성자 프레임이 제공하는 원 namespace만 재현한다. 함수 code/AST는 원본 그대로다.
        prepared.__dict__['_test_bind']=k.bind_current_midnight_database
        exec('def _synthetic_constructor_context(r,review,approval):\n return _test_bind(r,review,approval)',prepared.__dict__)
        with patch.object(k,'current_midnight_database_module',return_value=db),patch.object(k,'signed_private_read',return_value=json.dumps(r.binding).encode()),patch.object(k.ReviewedCurrentMidnightDatabaseBridge,'execution_guard'),patch.object(db,'checked_source',side_effect=lambda repo,p,head,pins:(ROOT/p).read_bytes()),patch.object(k.Runner,'call',return_value=json.dumps([{'Id':r.target['id'],'HostConfig':{'PidMode':''}}]))as inspect:
            bridge=prepared._synthetic_constructor_context(r,review,approval)
        self.assertIs(type(bridge.database),db.CurrentDatabase)
        self.assertIs(bridge.database.reviewed,review)
        self.assertTrue(bridge.database.preparation_status['executionAllowed'])
        self.assertEqual(bridge.database.preparation_status['coverageVersion'],'CURRENT124_FIXED_SQL_V1')
        self.assertRegex(bridge.database.preparation_status['fixedOperationManifestSha256'],'^[a-f0-9]{64}$')
        self.assertEqual(r.binding,before);self.assertFalse(r.binding['approvedByRoot'])
        self.assertFalse(r.binding['dockerSlotReady']);self.assertEqual(inspect.call_count,1)
        self.assertIs(r.bridge(),bridge)
        # 같은 review도 prepare의 캡처 namespace 없이 직접 연결하면 coverage를 승격하지 않는다.
        k._CURRENT_DATABASE_PAIRS.clear();k._CURRENT_DATABASE_BRIDGE_SEALS.clear()
        with patch.object(k,'current_midnight_database_module',return_value=db),patch.object(k,'signed_private_read',return_value=json.dumps(r.binding).encode()),patch.object(k.ReviewedCurrentMidnightDatabaseBridge,'execution_guard'),patch.object(db,'checked_source',side_effect=lambda repo,p,head,pins:(ROOT/p).read_bytes()),patch.object(k.Runner,'call')as external:
            with self.assertRaisesRegex(ValueError,'CAPTURED_COVERAGE_INCOMPLETE'):
                k.bind_current_midnight_database(r,review,approval)
            external.assert_not_called()
        self.assertNotIn(r,k._CURRENT_DATABASE_PAIRS)
    def test_unbound_subclass_plain_json_foreign_review_refused(self):
        r,v=self.fixture()
        with self.assertRaisesRegex(ValueError,'UNBOUND'):r.read_sql('fixed')
        for fake in [v.descriptor(),types.SimpleNamespace(descriptor=v.descriptor),type('ForeignReview',(Review,),{})(v.value)]:
            r,_=self.fixture()
            with self.assertRaisesRegex(ValueError,'EXACT_REVIEW'):self.bind(r,fake)
        foreign=object.__new__(type('ForeignRunner',(k.CurrentSignedMidnightRunner,),{}))
        with self.assertRaisesRegex(ValueError,'BIND_ONCE'):k.bind_current_midnight_database(foreign,v,self.approval(r))
    def test_typed_execution_approval_does_not_mutate_false_flags(self):
        r,v=self.fixture();before=copy.deepcopy(r.binding);self.bind(r,v)
        self.assertEqual(r.binding,before);self.assertFalse(r.binding['approvedByRoot']);self.assertFalse(r.binding['dockerSlotReady'])
        for bad in [{},types.SimpleNamespace(),object.__new__(type('ForeignApproval',(k.ReviewedCurrentMidnightExecutionApproval,),{}))]:
            r,v=self.fixture()
            with self.assertRaisesRegex(ValueError,'TYPED_APPROVAL'):self.bind(r,v,bad)
    def test_execution_approval_wrong_root_scope_head_slot_and_expiry(self):
        for changes in [{'prepared_root':'/private/tmp/foreign'},{'scope_id':'foreign'},{'source_head':'b'*40},{'containers':{x:{'id':str(i+4)*64}for i,x in enumerate(['db','auth','rest','gateway'],1)}}]:
            r,v=self.fixture();a=self.approval(r,**changes)
            with self.assertRaisesRegex(ValueError,'APPROVAL_BINDING'):self.bind(r,v,a)
        r,v=self.fixture()
        with self.assertRaisesRegex(ValueError,'APPROVAL_FIELDS'):self.approval(r,expires_at=int(time.time())-1)
        a=self.approval(r);r,v=self.fixture()
        with patch.object(k.time,'time',return_value=a.descriptor()['expiresAt']+1):
            with self.assertRaisesRegex(ValueError,'APPROVAL_BINDING'):self.bind(r,v,a)
    def test_legacy_false_approval_still_refused_and_current_expiry_is_live(self):
        old=object.__new__(k.SignedMidnightRunner);old.binding={'approvedByRoot':False,'dockerSlotReady':False}
        with self.assertRaisesRegex(ValueError,'SIGNED_APPROVAL_SLOT_REQUIRED'):old.validate_original_accounts()
        r,v=self.fixture();b=self.bind(r,v)
        with patch.object(k.time,'time',return_value=b.approval.descriptor()['expiresAt']+1):
            with self.assertRaisesRegex(ValueError,'APPROVAL_CHANGED'):r.read_sql('fixed')
        self.assertEqual(b.database.calls,[])
        r,v=self.fixture();a=self.approval(r,expires_at=int(time.time())+7200)
        with self.assertRaisesRegex(ValueError,'APPROVAL_BINDING'):self.bind(r,v,a)
    def test_root_scope_users_containers_profile_pins_mismatch(self):
        for field,value in [('root','/private/tmp/foreign'),('scopeId','foreign'),('boundaryEpoch',124),('users',['foreign']),('containers',{}),('profile',{}),('pins',{})]:
            r,v=self.fixture();v.value[field]=value
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'REVIEW_BINDING'):self.bind(r,v)
    def test_exact_six_sessions_not_just_three_users(self):
        r,v=self.fixture();r.binding['accounts'].pop()
        with self.assertRaisesRegex(ValueError,'REVIEW_BINDING'):self.bind(r,v)
        r,v=self.fixture();r.binding['accounts'].append({'userId':r.users[0],'sessionId':'extra','expiresAt':int(time.time())+3600})
        with self.assertRaisesRegex(ValueError,'REVIEW_BINDING'):self.bind(r,v)
    def test_coverage_false_never_binds_or_creates_custody(self):
        r,v=self.fixture();Database.allowed=False
        with self.assertRaisesRegex(ValueError,'COVERAGE'):self.bind(r,v)
        self.assertNotIn(r,k._CURRENT_DATABASE_PAIRS)
        self.assertFalse(hasattr(r,'midnight_custody'))
    def test_rebind_changed_and_children_refused(self):
        r,v=self.fixture();self.bind(r,v)
        with self.assertRaisesRegex(ValueError,'BIND_ONCE'):self.bind(r,v)
        for field,value in [('changed',True),('children',[object()])]:
            r,v=self.fixture();setattr(r,field,value)
            with self.assertRaisesRegex(ValueError,'BIND_ONCE'):self.bind(r,v)
    def test_copied_token_does_not_copy_pair_authority(self):
        r,v=self.fixture();b=self.bind(r,v);forged=copy.copy(b)
        with self.assertRaisesRegex(ValueError,'PAIR_CHANGED'):forged.assert_pair()
    def test_monkeypatch_and_later_binding_changes_refused(self):
        r,v=self.fixture();b=self.bind(r,v)
        with self.assertRaisesRegex(ValueError,'METHOD_OVERRIDE'):r.sql=lambda q:None
        object.__setattr__(r,'sql',lambda q:None)
        with self.assertRaisesRegex(ValueError,'PAIR_CHANGED'):b.assert_pair()
        r,v=self.fixture();b=self.bind(r,v);r.binding['accounts'][0]['sessionId']='different'
        with self.assertRaisesRegex(ValueError,'PAIR_BINDING'):b.assert_pair()
        r,v=self.fixture();b=self.bind(r,v);b._data='{}'
        with self.assertRaisesRegex(ValueError,'PAIR_CHANGED'):b.assert_pair()
    def test_sticky_blocks_before_read_dispatch(self):
        r,v=self.fixture();b=self.bind(r,v);b.database.sticky=True
        with self.assertRaisesRegex(ValueError,'STICKY'):r.read_sql('fixed')
        self.assertEqual(b.database.calls,[])
        with patch.object(k.Runner,'call')as metadata:
            with self.assertRaisesRegex(ValueError,'STICKY'):b.execution_guard()
            metadata.assert_not_called()
    def test_actual_auth_six_loop_preserved_without_promoting_original_flags(self):
        r,v=self.fixture();b=self.bind(r,v);before=copy.deepcopy(r.binding)
        users=[{'id':a['userId'],'role':'authenticated','is_anonymous':False}for a in r.binding['accounts']]
        with patch.object(type(b),'execution_guard'),patch.object(type(b),'memory'),patch.object(k,'validate_signed_binding')as validation,patch.object(k.SignedRunner,'signed_identity'),patch.object(k.SignedRunner,'auth_user',side_effect=users)as auth,patch.object(Database,'read_sql',return_value='t')as sql:
            result=r.validate_original_accounts()
        self.assertEqual(len(result),6);self.assertEqual(auth.call_count,6);self.assertEqual(sql.call_count,6)
        self.assertEqual(r.binding,before);self.assertFalse(r.binding['approvedByRoot']);self.assertFalse(r.binding['dockerSlotReady'])
        validation.assert_called_once_with(r.binding,r.root,r.target,current_midnight=r.current_midnight_profile)
        r,v=self.fixture();b=self.bind(r,v)
        with patch.object(type(b),'execution_guard'),patch.object(type(b),'memory'),patch.object(k,'validate_signed_binding'),patch.object(k.SignedRunner,'signed_identity'),patch.object(k.SignedRunner,'auth_user',return_value={'id':'wrong'}):
            with self.assertRaisesRegex(ValueError,'ORIGINAL_AUTH'):r.validate_original_accounts()
    def test_original_auth_loop_ast_matches_legacy(self):
        tree=ast.parse((ROOT/'tests/integration/jonghyun/isolated_ai_contracts.py').read_bytes())
        def loop(name):
            cls=next(x for x in tree.body if isinstance(x,ast.ClassDef)and x.name==name)
            fn=next(x for x in cls.body if isinstance(x,ast.FunctionDef)and x.name=='validate_original_accounts')
            return next(x for x in fn.body if isinstance(x,ast.For))
        self.assertEqual(ast.dump(loop('SignedMidnightRunner')),ast.dump(loop('CurrentSignedMidnightRunner')))
    def test_real_execution_guard_wrong_daemon_and_memory_refused(self):
        r,v=self.fixture();b=self.bind(r,v);raw=json.dumps(r.binding).encode()
        with patch.object(k,'signed_private_read',return_value=raw),patch.object(k.Runner,'call',return_value='foreign'):
            with self.assertRaisesRegex(ValueError,'DAEMON'):b.execution_guard()
        with patch.object(k,'signed_private_read',return_value=raw),patch.object(k.Runner,'call',return_value=b.approval.descriptor()['daemonId']),patch.object(k.SignedRunner,'signed_identity'),patch.object(k.FixedSignedProvisioningPorts,'memory_kib',return_value=1048575):
            with self.assertRaisesRegex(ValueError,'MEMORY'):b.execution_guard(start=True)
        with patch.object(k,'signed_private_read',return_value=raw),patch.object(k.Runner,'call',return_value=b.approval.descriptor()['daemonId']),patch.object(k.SignedRunner,'signed_identity'),patch.object(k.FixedSignedProvisioningPorts,'memory_kib',return_value=1048576),patch.object(k,'lcp_save')as save:
            b.execution_guard(start=True);self.assertEqual(save.call_args.args[2]['minimumKiB'],1048576)
    def test_resume_requires_same_root_typed_pair_and_descriptor(self):
        r,v=self.fixture();b=self.bind(r,v)
        with patch.object(k.SignedMidnightRunner,'export_resume_state',return_value={'history':'old'}):
            state=r.export_resume_state()
        with patch.object(k.SignedMidnightRunner,'restore_resume_state',return_value='restored')as old:
            self.assertEqual(r.restore_resume_state(state),'restored');old.assert_called_once_with({'history':'old'})
        for bad in [{'history':'old'},{**state,'currentDatabaseBridgeSha256':'0'*64}]:
            with self.assertRaisesRegex(ValueError,'RESUME_BINDING'):r.restore_resume_state(bad)
    def test_old_custody_body_ast_unchanged_after_narrow_type_extension(self):
        rel='tests/integration/jonghyun/isolated_ai_contracts.py'
        old=ast.parse(subprocess.check_output(['git','-C',str(ROOT),'show','HEAD:'+rel]))
        new=ast.parse((ROOT/rel).read_bytes())
        old=next(n for n in old.body if isinstance(n,ast.FunctionDef)and n.name=='midnight_bind_custody')
        new=next(n for n in new.body if isinstance(n,ast.FunctionDef)and n.name=='midnight_bind_custody')
        first=new.body.pop(0)
        self.assertEqual(ast.unparse(first.test),'type(runner) is CurrentSignedMidnightRunner')
        self.assertEqual(ast.unparse(first.body[0]),'runner.bridge()')
        self.assertEqual(ast.unparse(new.body[0].test.values[0]),'type(runner) not in (SignedMidnightRunner, CurrentSignedMidnightRunner)')
        new.body[0].test.values[0]=copy.deepcopy(old.body[0].test.values[0])
        self.assertEqual(ast.dump(old),ast.dump(new))
    def test_exact_bound_current_reaches_original_custody_proof_only(self):
        r,v=self.fixture();self.bind(r,v);authority=object.__new__(k.TypedMidnightCustody)
        with patch.object(k,'midnight_custody_proof',side_effect=RuntimeError('ORIGINAL_PROOF_REQUIRED')):
            with self.assertRaisesRegex(RuntimeError,'ORIGINAL_PROOF_REQUIRED'):k.midnight_bind_custody(r,authority)
        self.assertIs(r.midnight_custody,authority)
    def test_kernel_owned_loader_caches_same_class_and_rejects_bad_pins(self):
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory).resolve();db=root/k._CURRENT_DATABASE_PATH;db.parent.mkdir(parents=True)
            db.write_text('class ReviewedCurrentAI24Database: pass\n')
            kernel=root/'tests/integration/jonghyun/isolated_ai_contracts.py';kernel.parent.mkdir(parents=True);kernel.write_text('# captured kernel\n')
            head='a'*40;pins={str(x.relative_to(root)):hashlib.sha256(x.read_bytes()).hexdigest()for x in [db,kernel]}
            def git(args,**kwargs):
                if 'rev-parse'in args:return head+'\n'
                return (root/args[-1].split(':',1)[1]).read_bytes()
            with patch.object(k,'REPO',root),patch.object(k.subprocess,'check_output',side_effect=git):
                k._CURRENT_DATABASE_MODULES.clear();a=k.current_midnight_database_module(head,pins);b=k.current_midnight_database_module(head,pins)
                self.assertIs(a,b);self.assertIs(a.ReviewedCurrentAI24Database,b.ReviewedCurrentAI24Database)
                with self.assertRaisesRegex(ValueError,'SOURCE_CHANGED'):k.current_midnight_database_module(head,{**pins,k._CURRENT_DATABASE_PATH:'0'*64})
    def test_construction_state_and_class_monkeypatch_refused(self):
        r,v=self.fixture();b=self.bind(r,v);b.constructing=True
        with self.assertRaisesRegex(ValueError,'CONSTRUCTION_STATE'):b.assert_pair()
        r,v=self.fixture();b=self.bind(r,v)
        with patch.object(k.CurrentSignedMidnightRunner,'read_sql',lambda *args:None):
            with self.assertRaisesRegex(ValueError,'PAIR_CHANGED'):b.assert_pair()
            with self.assertRaisesRegex(ValueError,'METHOD_OVERRIDE'):r.read_sql('fixed')
    def test_custody_rejects_unbound_current_and_foreign_old(self):
        r,v=self.fixture()
        with self.assertRaisesRegex(ValueError,'UNBOUND'):k.midnight_bind_custody(r,{})
        old=object.__new__(k.SignedMidnightRunner);old.changed=False;old.children=[]
        with self.assertRaisesRegex(ValueError,'BIND_ONCE'):k.midnight_bind_custody(old,{})
        self.assertNotIn(old,k._CURRENT_DATABASE_PAIRS)

if __name__=='__main__':unittest.main()
