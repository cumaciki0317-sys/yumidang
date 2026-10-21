"""D03 생성기의 합성 회귀. Auth/DB/네트워크 호출 없음."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
import subprocess
import uuid

ROOT=Path(__file__).resolve().parents[3]
PATH=ROOT/'tests/integration/minkyu/deadline_qualification_local.py'
spec=importlib.util.spec_from_file_location('d03_qualification_test',PATH);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
TEST_HEAD=subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip()
TEST_PINS={p:m.sha((ROOT/p).read_bytes())for p in (m.KERNEL_PATH,m.KERNEL_SUPPORT_PATH)}
TEST_KERNEL=m.load_reviewed_kernel(TEST_HEAD,TEST_PINS)

class QualificationTests(unittest.TestCase):
 def fixture(self):
  actors=[];old={k:[]for k in ('public.profiles','private.member_episodes','private.profile_traits','private.naver_accounts','private.naver_sessions','private.naver_identity_keys','storage.objects')};new=copy.deepcopy(old);accounts=[]
  def add(target,table,row):target[table].append({'sha256':uuid.uuid4().hex*2,'row':row})
  for i in range(2):
   uid=str(uuid.uuid4());sid=str(uuid.uuid4());oid=str(uuid.uuid4());eid=str(uuid.uuid4());identity=str(uuid.uuid4());subject='synthetic-d03-'+uid
   a={'userId':uid,'sessionId':sid,'subject':subject,'objectId':oid,'jpegPath':'unused','jpegSha256':'a'*64,'storagePath':uid+'/'+str(uuid.uuid4())+'.jpg'};actors.append(a)
   email=str(uuid.uuid4())+'@naver.yumidang.invalid';accounts.append({'userId':uid,'authEmail':email})
   p={'id':uid,'real_name':'before','birth_date':'2000-01-01','gender':'female','avatar_url':None,'bio':None,'sweetness':15,'updated_at':'2026-10-21T00:00:00Z'}
   ep={'id':eid,'profile_id':uid,'identity_id':None,'ended_at':None}
   add(old,'public.profiles',p);add(old,'private.member_episodes',ep)
   add(new,'public.profiles',{**p,'real_name':'합성 D03','birth_date':'1990-01-01','avatar_url':a['storagePath']})
   add(new,'private.member_episodes',{**ep,'identity_id':identity})
   add(new,'private.naver_accounts',{'subject':subject,'user_id':uid,'auth_email':email,'real_name':'합성 D03','birth_date':'1990-01-01','gender':'female','verification_status':'qualified','verified_at':'now','completed_at':'now'})
   add(new,'private.naver_sessions',{'session_id':sid,'user_id':uid,'subject':subject})
   add(new,'private.naver_identity_keys',{'id':identity,'subject':subject})
   add(new,'private.profile_traits',{'profile_id':uid,'interests':[],'conversation_styles':[],'mbti':None})
   add(new,'storage.objects',{'id':oid,'bucket_id':'profile-images','name':a['storagePath'],'owner_id':uid,'metadata':{'mimetype':'image/jpeg','size':4}})
  return {'actors':actors},old,new,{'accounts':accounts}
 def test_exact_two_qualification_has_explicit_non_naver_scope(self):
  v,old,new,b=self.fixture();out=m.validate_qualified_rows(v,old,new,[4,4],b)
  self.assertEqual(out['actualNaver'],'NOT_RUN');self.assertEqual(out['actualStorageAPI'],'NOT_RUN')
 def test_profile_sweetness_bio_other_fields_cannot_change(self):
  for field,value in [('sweetness',100),('bio','changed'),('id',str(uuid.uuid4()))]:
   v,old,new,b=self.fixture();new['public.profiles'][0]['row'][field]=value
   with self.assertRaises(ValueError):m.validate_qualified_rows(v,old,new,[4,4],b)
 def test_account_email_session_identity_and_jpeg_metadata_are_exact(self):
  for table,key,value in [('private.naver_accounts','auth_email','changed'),('private.naver_sessions','user_id','changed'),('private.member_episodes','identity_id',None),('storage.objects','metadata',{'mimetype':'image/png','size':4})]:
   v,old,new,b=self.fixture();new[table][0]['row'][key]=value
   with self.assertRaises(ValueError):m.validate_qualified_rows(v,old,new,[4,4],b)
 def snapshots(self,old,new):
  before={'rows':{k:{r['sha256']:1 for r in rs}for k,rs in old.items()},'authoritySha256':'a','catalogSha256':'b'}
  before['rows']['auth.users']={'original':6};before['rows']['private.ai_budget_reservations']={'unknown':2}
  after=copy.deepcopy(before)
  for table,rows in new.items():after['rows'][table]={r['sha256']:1 for r in rows}
  return before,after
 def test_full_bag_delta_preserves_auth_unknown_and_authority(self):
  v,old,new,b=self.fixture();before,after=self.snapshots(old,new)
  self.assertTrue(m.validate_delta(before,after,old,new)['authRowsUnchanged'])
  for mutate in (lambda a:a['rows']['auth.users'].update(extra=1),lambda a:a['rows']['private.ai_budget_reservations'].clear(),lambda a:a.update(authoritySha256='changed')):
   changed=copy.deepcopy(after);mutate(changed)
   with self.assertRaises(ValueError):m.validate_delta(before,changed,old,new)
 def test_new_unknown_relation_or_own_extra_row_is_not_allowed(self):
  v,old,new,b=self.fixture();before,after=self.snapshots(old,new);after['rows']['new.table']={}
  with self.assertRaises(ValueError):m.validate_delta(before,after,old,new)
  v,old,new,b=self.fixture();new['private.naver_accounts'].append(copy.deepcopy(new['private.naver_accounts'][0]))
  with self.assertRaisesRegex(ValueError,'D03_EXACT_QUALIFIED_ROWS'):m.validate_qualified_rows(v,old,new,[4,4],b)
 def test_untyped_review_never_opens_transport(self):
  with self.assertRaisesRegex(ValueError,'D03_TYPED_QUALIFIER_REQUIRED'):m.run_reviewed({'approved':True})

if __name__=='__main__':unittest.main()

class ProducerTests(unittest.TestCase):
 fixture=QualificationTests.fixture
 snapshots=QualificationTests.snapshots
 def prepared(self):
  import json
  from unittest.mock import Mock
  temp=tempfile.TemporaryDirectory(prefix='yumidang-d03-unit-',dir='/private/tmp');self.addCleanup(temp.cleanup)
  parent=Path(temp.name).resolve();parent.chmod(0o700);root=parent/'source';root.mkdir(mode=0o700)
  v,old,new,b=self.fixture();before,after=self.snapshots(old,new)
  aliases=[str(uuid.uuid4())+'@naver.yumidang.invalid'for _ in range(6)]
  policy=TEST_KERNEL.ReviewedD03AuthEmailAliases('unit',root,aliases)
  for i,a in enumerate(v['actors']):
   p=root/('d03-photo-'+uuid.uuid4().hex+'.jpg');p.write_bytes(b'\xff\xd8\xff\xd9');p.chmod(0o600)
   a.update(jpegPath=str(p),jpegSha256=m.sha(p.read_bytes()))
  binding={'accounts':[{'userId':a['userId'],'sessionId':a['sessionId'],'authEmail':aliases[i],'accessToken':'unit-original'}for i,a in enumerate(v['actors'])]}
  for i,row in enumerate(new['private.naver_accounts']):row['row']['auth_email']=aliases[i]
  binding_raw=m.canonical(binding);(root/'signed-ai-binding-private.json').write_bytes(binding_raw);(root/'signed-ai-binding-private.json').chmod(0o600)
  receipt_root=root/('auth-provision-'+'a'*32);receipt_root.mkdir(mode=0o700)
  receipt={'status':'PASS_LOCAL_AUTH6_PROVISION_ONLY','bindingSha256':m.sha(binding_raw),'actualNaver':'NOT_RUN','d03EmailAliasPolicy':policy.descriptor(),'finalSha256':m.sha(json.dumps(before,sort_keys=True).encode())}
  receipt_path=receipt_root/'receipt.json';receipt_path.write_bytes(m.canonical(receipt));receipt_path.chmod(0o600)
  pins={k:'a'*64 for k in (m.SELF,m.KERNEL_PATH,m.KERNEL_SUPPORT_PATH,'tests/integration/minkyu/service_profile_readonly_local.py','tools/local/run_current_auth_source.py')}
  from unittest.mock import patch
  with patch.object(m,'load_reviewed_kernel',return_value=TEST_KERNEL):
   review=m.ReviewedD03Qualification('unit',root,'a'*40,pins,{'sourceHead':'a'*40},aliases,m.sha(policy._sealed),m.sha(binding_raw),receipt_path,m.sha(receipt_path.read_bytes()),v['actors'])
  ports=Mock();ports.failures=[];ports.unclosed_child=False;ports.snapshot.side_effect=[before,after];ports.inspect_rows.side_effect=[old,new];ports.complete.return_value=(200,b'{}')
  return root,review,ports,binding_raw,receipt_path,receipt_path.read_bytes()
 def invoke(self,review,ports):
  from unittest.mock import patch
  from types import SimpleNamespace
  from contextlib import nullcontext
  readonly=SimpleNamespace(current_support=lambda pins:nullcontext())
  with patch.object(m,'check_sources'),patch.object(m,'load_reviewed_module',return_value=readonly),patch.object(TEST_KERNEL,'signed_prepared_target',return_value={}),patch.object(TEST_KERNEL,'validate_signed_binding'),patch.object(m,'FixedQualificationPorts',return_value=ports):return m.run_reviewed(review)
 def test_success_preserves_original_history_and_replay_dispatches_zero(self):
  import json
  root,review,ports,binding,receipt_path,receipt=self.prepared()
  result=self.invoke(review,ports);self.assertEqual(result['status'],'PASS_SYNTHETIC_QUALIFICATION_ONLY')
  self.assertEqual((root/'signed-ai-binding-private.json').read_bytes(),binding);self.assertEqual(receipt_path.read_bytes(),receipt)
  self.assertEqual(ports.complete.call_count,2);ports.insert_metadata.assert_called_once();ports.close_monitor.assert_called_once()
  ports.reset_mock()
  with self.assertRaisesRegex(ValueError,'D03_QUALIFICATION_PACKET_EXISTS'):self.invoke(review,ports)
  ports.complete.assert_not_called();ports.insert_metadata.assert_not_called()
  stored=json.loads((root/'d03-qualification/receipt.json').read_text());self.assertEqual(stored['actualNaver'],'NOT_RUN')
 def test_first_completion_failure_stops_without_second_or_replay_and_saves_after(self):
  import json
  root,review,ports,*_=self.prepared();ports.complete.return_value=(400,b'{"error":"qualification"}')
  with self.assertRaisesRegex(ValueError,'D03_QUALIFICATION_FAILED_NO_REPLAY'):self.invoke(review,ports)
  self.assertEqual(ports.complete.call_count,1);self.assertTrue((root/'d03-qualification/failure-after-private.json').exists())
  self.assertEqual(json.loads((root/'d03-qualification/receipt.json').read_text())['status'],'FAIL_CLOSED')
 def test_original_baseline_mismatch_writes_no_qualification(self):
  root,review,ports,*_=self.prepared()
  wrong={'rows':{},'authoritySha256':'changed'};ports.snapshot.side_effect=[wrong,wrong]
  with self.assertRaises(ValueError):self.invoke(review,ports)
  ports.insert_metadata.assert_not_called();ports.complete.assert_not_called()
 def test_changed_photo_or_plain_review_never_dispatches(self):
  root,review,ports,*_=self.prepared();photo=Path(review.descriptor()['actors'][0]['jpegPath']);photo.write_bytes(b'changed')
  with self.assertRaisesRegex(ValueError,'D03_SOURCE_JPEG'):self.invoke(review,ports)
  ports.insert_metadata.assert_not_called();ports.complete.assert_not_called()

class FixedPortTests(unittest.TestCase):
 def port(self):
  from unittest.mock import Mock
  p=object.__new__(m.FixedQualificationPorts);p.kernel=TEST_KERNEL;p.base=Mock();p.guard=Mock();p.artifact=Mock();p.failures=[];p.unclosed_child=False
  p.target={'id':'a'*64};p.base.base=['docker','--host','unix:///fixed'];p.v={'pins':{'tools/local/run_current_auth_source.py':'b'*64}}
  return p
 def test_inspect_reads_cross_actual_read_only_boundary_with_five_second_limit(self):
  from unittest.mock import Mock
  p=self.port();p.v['actors']=[{'userId':str(uuid.uuid4()),'sessionId':str(uuid.uuid4()),'subject':'synthetic','objectId':str(uuid.uuid4()),'storagePath':'own/path'}for _ in range(2)]
  def kernel_read(query,timeout):
   self.assertLessEqual(timeout,5);self.assertTrue(query.lower().startswith('select'));return '[]'
  p.base.read_sql.side_effect=kernel_read
  rows=p.inspect_rows();self.assertEqual(len(rows),7);self.assertEqual(p.base.read_sql.call_count,7)
  self.assertIn('profile_id in',p.base.read_sql.call_args_list[2].args[0])
 def test_fixed_metadata_write_uses_separate_process_and_records_raw_before_verdict(self):
  from unittest.mock import Mock,patch
  from types import SimpleNamespace
  p=self.port();p.base.read_sql.side_effect=AssertionError('readonly kernel rejects writes')
  def popen(args,**kwargs):
   self.assertEqual(args[:3],['docker','--host','unix:///fixed'])
   kwargs['stdout'].write(b'raw SQL result');kwargs['stderr'].write(b'raw SQL failure')
   return Mock(pid=123,returncode=1,poll=Mock(return_value=1))
  with patch.object(m,'load_process_guard',return_value=SimpleNamespace(close_process_group=Mock(return_value={'closed':True}))),patch.object(m.subprocess,'Popen',side_effect=popen):
   with self.assertRaisesRegex(ValueError,'D03_METADATA_WRITE_FAILED'):p.write_metadata('begin;insert into private.naver_accounts(subject)values(\'fixed\');commit;')
  p.base.read_sql.assert_not_called()
  self.assertEqual([x.args[0]for x in p.artifact.call_args_list],['metadata-write-intent.json','metadata-write-stdout-private.json','metadata-write-stderr-private.json','metadata-write-result.json'])
 def http_port(self):
  p=self.port();p.binding={'origin':'http://127.0.0.1:57221','credentials':{'anon':'unit'}}
  a={'userId':str(uuid.uuid4()),'storagePath':'own/uuid.jpg'};return p,a,{'accessToken':'original'}
 def test_oversize_http_is_recorded_then_rejected_and_response_closed(self):
  from unittest.mock import Mock,patch
  p,a,account=self.http_port();response=Mock(status=200);response.__enter__=Mock(return_value=response);response.__exit__=Mock();response.read.return_value=b'x'*65537
  opener=Mock();opener.open.return_value=response
  with patch.object(m.urllib.request,'build_opener',return_value=opener):
   with self.assertRaisesRegex(ValueError,'D03_RPC_RESPONSE_UNPROVEN'):p.complete(a,account)
  response.__exit__.assert_called_once();opener.open.assert_called_once()
  proof=p.artifact.call_args.args[1];self.assertTrue(proof['truncated']);self.assertEqual(proof['outcome'],'UNKNOWN_NO_REPLAY');self.assertEqual(len(bytes.fromhex(proof['bodyHex'])),65537)
 def test_http_error_body_is_captured_and_closed_and_transport_unknown_saved(self):
  import io
  from unittest.mock import Mock,patch
  p,a,account=self.http_port();body=io.BytesIO(b'error');error=m.urllib.error.HTTPError('http://127.0.0.1:57221',400,'bad',{},body)
  opener=Mock();opener.open.side_effect=error
  with patch.object(m.urllib.request,'build_opener',return_value=opener):self.assertEqual(p.complete(a,account),(400,b'error'))
  self.assertTrue(body.closed)
  p.artifact.reset_mock();opener.open.side_effect=OSError('unknown')
  with patch.object(m.urllib.request,'build_opener',return_value=opener):
   with self.assertRaises(ValueError):p.complete(a,account)
  self.assertEqual(p.artifact.call_args.args[1]['outcome'],'UNKNOWN_NO_REPLAY')

class FinalGuardTests(unittest.TestCase):
 fixture=QualificationTests.fixture
 snapshots=QualificationTests.snapshots
 prepared=ProducerTests.prepared
 invoke=ProducerTests.invoke
 def test_monitor_failure_during_final_close_cannot_pass(self):
  import json
  root,review,ports,*_=self.prepared();ports.close_monitor.side_effect=lambda:ports.failures.append('late-memory-failure')
  with self.assertRaisesRegex(ValueError,'D03_QUALIFICATION_FAILED_NO_REPLAY'):self.invoke(review,ports)
  self.assertEqual(json.loads((root/'d03-qualification/receipt.json').read_text())['status'],'FAIL_CLOSED')
 def test_failure_after_capture_unavailable_is_explicit(self):
  import json
  root,review,ports,*_=self.prepared();ports.guard.side_effect=ValueError('memory')
  with self.assertRaises(ValueError):self.invoke(review,ports)
  capture=json.loads((root/'d03-qualification/failure-after-capture.json').read_text());self.assertEqual(capture['status'],'UNAVAILABLE')
 def test_literal_policy_can_rebind_under_current_module_without_json_promotion(self):
  root,review,ports,*_=self.prepared();v=review.descriptor()
  foreign=m.load_reviewed_kernel(TEST_HEAD,TEST_PINS);foreign_policy=foreign.ReviewedD03AuthEmailAliases(v['decisionId'],root,v['aliasPolicy']['aliases'])
  with self.assertRaises(ValueError):TEST_KERNEL.validate_d03_email_aliases(foreign_policy,root)
  from unittest.mock import patch
  with patch.object(m,'load_reviewed_kernel',return_value=TEST_KERNEL):
   rebound=m.ReviewedD03Qualification(v['decisionId'],root,v['head'],v['pins'],v['profile'],v['aliasPolicy']['aliases'],m.sha(foreign_policy._sealed),v['bindingSha256'],v['receiptPath'],v['receiptSha256'],v['actors'])
  self.assertIs(type(rebound.alias_policy),TEST_KERNEL.ReviewedD03AuthEmailAliases)
  self.assertEqual(rebound.alias_policy._sealed,foreign_policy._sealed)

class LoaderCustodyTests(unittest.TestCase):
 def test_import_does_not_read_or_execute_kernel_before_root_review(self):
  from unittest.mock import patch
  spec=importlib.util.spec_from_file_location('qualification_import_only',PATH);fresh=importlib.util.module_from_spec(spec)
  with patch.object(Path,'read_bytes',side_effect=AssertionError('UNREVIEWED_KERNEL_READ')) as read:
   spec.loader.exec_module(fresh)
  read.assert_not_called();self.assertFalse(hasattr(fresh,'KERNEL'))
 def test_loader_refuses_wrong_pin_or_committed_bytes_before_exec(self):
  from unittest.mock import patch
  with tempfile.TemporaryDirectory(dir='/private/tmp')as name:
   root=Path(name);path=root/m.KERNEL_PATH;path.parent.mkdir(parents=True);path.write_text("raise RuntimeError('UNVERIFIED_EXECUTION')\n")
   with patch.object(m,'ROOT',root):
    with self.assertRaisesRegex(ValueError,'D03_LOAD_BYTES_CHANGED'):m.load_reviewed_module(m.KERNEL_PATH,'a'*40,{m.KERNEL_PATH:'0'*64})
    pins={m.KERNEL_PATH:m.sha(path.read_bytes())}
    with patch.object(m.subprocess,'check_output',side_effect=['a'*40,b'other committed bytes']):
     with self.assertRaisesRegex(ValueError,'D03_LOAD_NOT_COMMITTED'):m.load_reviewed_module(m.KERNEL_PATH,'a'*40,pins)
 def test_loader_executes_captured_verified_bytes_even_if_path_changes_later(self):
  from unittest.mock import patch
  with tempfile.TemporaryDirectory(dir='/private/tmp')as name:
   root=Path(name);path=root/m.KERNEL_PATH;path.parent.mkdir(parents=True);safe=b'CAPTURED_VERIFIED=True\n';path.write_bytes(safe)
   def git(args,**kwargs):
    if 'rev-parse'in args:return 'a'*40
    path.write_text("raise RuntimeError('LATER_MUTATION')\n");return safe
   with patch.object(m,'ROOT',root),patch.object(m.subprocess,'check_output',side_effect=git):
    module=m.load_reviewed_module(m.KERNEL_PATH,'a'*40,{m.KERNEL_PATH:m.sha(safe)})
   self.assertTrue(module.CAPTURED_VERIFIED)
 def test_full_runtime_context_keeps_pinned_lazy_helpers_through_failure_and_restores_poison(self):
  import sys
  from unittest.mock import patch
  from types import SimpleNamespace
  actual=m.load_reviewed_module(m.READONLY_PATH,TEST_HEAD,{m.READONLY_PATH:m.sha((ROOT/m.READONLY_PATH).read_bytes())})
  pins={p:m.sha((ROOT/p).read_bytes())for p in actual.CURRENT_HELPERS}
  old=sys.modules.get('prepare_database');poison=SimpleNamespace(isolated_config=lambda:(_ for _ in()).throw(AssertionError('AMBIENT_HELPER')))
  sys.modules['prepare_database']=poison
  try:
   for fail in (False,True):
    review=object.__new__(m.ReviewedD03Qualification);review._sealed=m.canonical({'head':TEST_HEAD,'pins':pins})
    checked=[]
    def supported(review):
     try:
      self.assertIsNot(sys.modules['prepare_database'],poison);checked.append('execution')
      if fail:raise RuntimeError('synthetic failure')
     finally:
      self.assertIsNot(sys.modules['prepare_database'],poison);checked.append('failure-finally')
    with patch.object(m,'check_sources'),patch.object(m,'load_reviewed_module',return_value=actual),patch.object(m,'run_supported',side_effect=supported):
     if fail:
      with self.assertRaisesRegex(RuntimeError,'synthetic failure'):m.run_reviewed(review)
     else:m.run_reviewed(review)
    self.assertEqual(checked,['execution','failure-finally']);self.assertIs(sys.modules['prepare_database'],poison)
  finally:
   if old is None:sys.modules.pop('prepare_database',None)
   else:sys.modules['prepare_database']=old

class KernelImportDependencyTests(unittest.TestCase):
 def test_kernel_load_captures_pinned_helper_and_restores_ambient_module(self):
  import sys
  from types import SimpleNamespace
  before=sys.modules.get('run_database_tests');poison=SimpleNamespace(private_temp_root=lambda *_:(_ for _ in()).throw(AssertionError('POISON')))
  sys.modules['run_database_tests']=poison
  try:
   kernel=m.load_reviewed_kernel(TEST_HEAD,TEST_PINS)
   self.assertIsNot(kernel.private_temp_root,poison.private_temp_root)
   self.assertIs(sys.modules['run_database_tests'],poison)
  finally:
   if before is None:sys.modules.pop('run_database_tests',None)
   else:sys.modules['run_database_tests']=before
