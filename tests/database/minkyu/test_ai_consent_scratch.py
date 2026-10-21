"""격리 SQL 검사 입력·기존 자원 보존·새 대상 전이 검증. Docker 호출 없음."""
import importlib.util
from pathlib import Path
import unittest

P=Path(__file__).resolve().parents[3]/'tools/local/run_ai_consent_scratch.py'
class GuardTests(unittest.TestCase):
 def setUp(self):
  spec=importlib.util.spec_from_file_location('scratch',P);self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
 def test_review_rejects_missing_or_extra_sql_before_file_reads(self):
  from unittest.mock import patch
  expected={self.m.SELF,*self.m.MIGRATIONS,*self.m.TESTS,*self.m.ADDITIONAL_SOURCES}
  for names in [expected-{self.m.MIGRATIONS[-1]},expected|{'unreviewed.sql'}]:
   with patch.object(self.m.subprocess,'check_output',return_value='a'*40+'\n'):
    with self.assertRaisesRegex(ValueError,'SOURCE_SET_CHANGED'):
     self.m.source_review('a'*40,dict.fromkeys(names,'b'*64))
 def test_kopis_and_deadline_mandatory_in_four_migrations_six_checks_and_pinned_bytes(self):
  import tempfile
  from unittest.mock import Mock,patch
  migration='backend/supabase/migrations/20261021120000_kopis_verified_snapshots.sql'
  check='tests/database/minkyu/kopis_verified_snapshots.sql'
  deadline='backend/supabase/migrations/20261021142140_review_db_entry_deadline.sql'
  deadline_check='tests/database/minkyu/review_db_entry_deadline_fixture.sql'
  self.assertEqual(self.m.sha((self.m.ROOT/deadline).read_bytes()),'85f4faa8892e1b304117ea08fffe42f9d7b7e5daca25a8fb977870b91755d101')
  self.assertEqual(self.m.sha((self.m.ROOT/deadline_check).read_bytes()),'b4e7e06497fbf054981909b2f5a0e4bc2e1d252103c4d727e382ae66d60025d1')
  self.assertEqual(self.m.MIGRATIONS,[self.m.SQL,'backend/supabase/migrations/20261020130000_post_private_events.sql',migration,deadline])
  self.assertEqual(self.m.TESTS,['tests/database/minkyu/post_manual_events.sql','tests/database/minkyu/ai_independent_consents.sql','tests/database/minkyu/current_summary_fences.sql','tests/database/minkyu/current_completion_consent_policy.sql',check,deadline_check])
  expected={self.m.SELF,*self.m.MIGRATIONS,*self.m.TESTS,*self.m.ADDITIONAL_SOURCES}
  for omitted in (migration,check,deadline,deadline_check):
   with patch.object(self.m.subprocess,'check_output',return_value='a'*40+'\n')as git:
    with self.assertRaisesRegex(ValueError,'SOURCE_SET_CHANGED'):
     self.m.source_review('a'*40,dict.fromkeys(expected-{omitted},'b'*64))
    self.assertEqual(git.call_count,1)  # HEAD만 확인하고 파일/추가 Git 소비 전 거절
  for name in (migration,check,deadline,deadline_check):
   with self.subTest(name=name),tempfile.TemporaryDirectory()as root:
    repo=Path(root).resolve();path=repo/name;path.parent.mkdir(parents=True)
    raw=b'-- exact reviewed KOPIS fixture bytes\nselect 1;\n';path.write_bytes(raw)
    runner=self.m.Scratch({'pins':{name:self.m.sha(raw)}},repo)
    runner.target='c'*64;runner.guard=Mock();runner.own=Mock();runner.docker=Mock(return_value=(b'ok',0))
    with patch.object(self.m,'ROOT',repo):
     self.assertEqual(runner.read_source(name),raw)
     path.write_bytes(raw+b'-- unreviewed mutation\n')
     with self.assertRaisesRegex(ValueError,'SOURCE_CHANGED'):runner.read_source(name)
     runner.docker.assert_not_called()
 def test_sql_input_is_the_exact_pinned_bytes(self):
  import tempfile
  from unittest.mock import Mock,patch
  with tempfile.TemporaryDirectory() as root:
   repo=Path(root).resolve();name=self.m.TESTS[0];p=repo/name;p.parent.mkdir(parents=True)
   raw=b'-- exact synthetic input\nselect 1;\n';p.write_bytes(raw)
   runner=self.m.Scratch({'pins':{name:self.m.sha(raw)}},repo)
   runner.target='c'*64;runner.guard=Mock();runner.own=Mock()
   runner.docker=Mock(return_value=(b'ok',0))
   with patch.object(self.m,'ROOT',repo):
    consumed=runner.read_source(name)
    p.write_bytes(b'select 2;')
    runner.sql(consumed)
    self.assertIs(runner.docker.call_args.args[1],consumed)
    self.assertEqual(runner.docker.call_args.args[1],raw)
    with self.assertRaisesRegex(ValueError,'SOURCE_CHANGED'):runner.read_source(name)
 def test_first_private_read_allows_access_time_update(self):
  import os,tempfile
  with tempfile.TemporaryDirectory() as root:
   p=Path(root).resolve()/'review.json';p.write_bytes(b'private');p.chmod(0o600);os.utime(p,(1,1))
   self.assertEqual(self.m.private_raw(p),b'private')
 def test_mount_order_only_uses_exact_bag(self):
  a={'Source':'/one','Destination':'/data','RW':False,'Propagation':'rprivate'}
  b={'Source':'/two','Destination':'/conf','RW':True,'Propagation':'rshared'}
  self.assertEqual(self.m.mount_digest([a,b]),self.m.mount_digest([b,a]))
  self.assertNotEqual(self.m.mount_digest([a,b,a]),self.m.mount_digest([b,a]))
 def test_mount_field_changes_are_not_normalized(self):
  a={'Source':'/one','Destination':'/data','RW':False,'Propagation':'rprivate'}
  for k,v in [('Source','/other'),('Destination','/other'),('RW',True),('Propagation','rshared')]:
   self.assertNotEqual(self.m.mount_digest([a]),self.m.mount_digest([{**a,k:v}]))
 def test_existing_unchanged(self):
  self.m.assert_preserved({'containers':[{'id':'old'}],'networks':[],'volumes':[]},{'containers':[{'id':'old'},{'id':'new'}],'networks':[],'volumes':[]},'new')
 def test_existing_change_rejected(self):
  with self.assertRaises(ValueError):self.m.assert_preserved({'containers':[{'id':'old'}],'networks':[],'volumes':[]},{'containers':[{'id':'old','running':True}],'networks':[],'volumes':[]},'new')
 def test_foreign_delta_rejected(self):
  with self.assertRaises(ValueError):self.m.assert_preserved({'containers':[],'networks':[],'volumes':[]},{'containers':[{'id':'other'}],'networks':[],'volumes':[]},'new')
 def test_new_volume_rejected(self):
  with self.assertRaises(ValueError):self.m.assert_preserved({'containers':[],'networks':[],'volumes':[]},{'containers':[],'networks':[],'volumes':[{'name':'new'}]},'new')
 def test_first_start_only_transition(self):
  self.assertEqual(self.m.check_host_transition({'Memory':512,'OomKillDisable':False},{'Memory':512,'OomKillDisable':None},first_start=True),{'Memory':512,'OomKillDisable':None})
 def test_other_transition_rejected(self):
  with self.assertRaises(ValueError):self.m.check_host_transition({'Memory':512,'OomKillDisable':False},{'Memory':1024,'OomKillDisable':None},first_start=True)
 def test_restart_transition_rejected(self):
  with self.assertRaises(ValueError):self.m.check_host_transition({'OomKillDisable':False},{'OomKillDisable':None},first_start=False)

class LifecycleTests(unittest.TestCase):
 def setUp(self):
  import copy,tempfile
  self.copy=copy.deepcopy;self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  spec=importlib.util.spec_from_file_location('scratch_lifecycle',P);self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
  self.r=self.m.Scratch({'head':'a'*40,'pins':{},'name':'yumidang-ai-consent-scratch-1234abcd'},Path(self.temp.name));self.r.init='safe-init';self.r.target='b'*64
  self.x={'Id':self.r.target,'Image':self.m.IMAGE,'Name':'/'+self.r.review['name'],'Mounts':[],'RestartCount':0,'NetworkSettings':{'Networks':{'none':{'IPAddress':'','Gateway':''}}},
   'Config':{'User':'postgres','Entrypoint':['sh'],'Cmd':['-c',self.r.init],'Healthcheck':{'Test':['NONE']},'Labels':{'yumidang.owner':'minkyu','yumidang.scope':'AI_CONSENT_ARCHIVE_SCRATCH','yumidang.review':self.m.sha(self.m.canon(self.r.review))}},
   'HostConfig':{'NetworkMode':'none','PortBindings':{},'Memory':536870912,'MemorySwap':536870912,'PidsLimit':128,'NanoCpus':500000000,'LogConfig':{'Type':'none'},'AutoRemove':False,'RestartPolicy':{'Name':'no'},'OomKillDisable':False},
   'State':{'Status':'created','StartedAt':'0001-01-01T00:00:00Z','Running':False,'OOMKilled':False,'Restarting':False,'ExitCode':0}}
  self.r.created=self.copy(self.x);self.r.before={'containers':[],'networks':[],'volumes':[]}
  self.r.docker=lambda args,**kw:(self.m.canon([self.x]),0)
 def test_explicit_isolation_rejects_ports_mounts_and_unlimited_memory(self):
  self.r.validate_created(self.x)
  for group,key,value in [('HostConfig','PortBindings',{'5432/tcp':[{'HostPort':'5432'}]}),('HostConfig','Memory',0),('Config','User','root')]:
   x=self.copy(self.x);x[group][key]=value
   with self.assertRaises(ValueError):self.r.validate_created(x)
  x=self.copy(self.x);x['Mounts']=[{'Source':'existing'}]
  with self.assertRaises(ValueError):self.r.validate_created(x)
 def test_same_id_stop_start_rejected_even_restart_count_zero(self):
  self.x['State'].update(Status='running',StartedAt='2026-10-20T10:00:00Z',Running=True);self.x['HostConfig']['OomKillDisable']=None
  self.r.own(first=True);self.x['State']['StartedAt']='2026-10-20T10:01:00Z'
  with self.assertRaisesRegex(ValueError,'INCARNATION'):self.r.own()
 def test_oom_and_unexpected_stop_rejected(self):
  self.x['State'].update(Status='running',StartedAt='2026-10-20T10:00:00Z',Running=True);self.r.own(first=True)
  self.x['State']['Running']=False
  with self.assertRaises(ValueError):self.r.own()
  self.x['State'].update(Running=True,OOMKilled=True)
  with self.assertRaises(ValueError):self.r.own()
 def test_memory_failure_saves_raw_before_verdict_and_ends_child(self):
  from unittest.mock import Mock,patch
  child=Mock();child.poll.return_value=None;child.returncode=-15;child.pid=12345
  calls=[None,ValueError('MEMORY_LOW')]
  self.r.memory=Mock(side_effect=calls)
  with patch.object(self.m.subprocess,'Popen',return_value=child),patch.object(self.m.os,'killpg') as kill:
   with self.assertRaisesRegex(ValueError,'MEMORY_LOW'):self.m.Scratch.docker(self.r,['exec','own','psql'])
   child.wait.assert_called_once();kill.assert_called_once()
  self.assertTrue((self.r.output/'command-0001.stdout').exists());self.assertTrue((self.r.output/'command-0001.stderr').exists());self.assertTrue((self.r.output/'command-0001.json').exists())

if __name__=='__main__':unittest.main()

class ConcurrentAdditionalTests(unittest.TestCase):
 def setUp(self):
  helper=Path(__file__).resolve().parents[3]/'tests/integration/minkyu/ai_consent_concurrent_local.py'
  spec=importlib.util.spec_from_file_location('concurrent_helper_unit',helper);self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
 def rows(self):
  return [{'application':self.m.APPS[0],'pid':101,'state':'active','query':"select public.withdraw_my_ai_processing('review_summary') as withdrawal;",'queryStart':'2026-10-21T00:00:00Z','backendStart':'2026-10-20T23:59:59Z','waitType':'Timeout','blockers':[]},
   {'application':self.m.APPS[1],'pid':202,'state':'active','query':"select public.withdraw_my_ai_processing('review_summary') as withdrawal;",'queryStart':'2026-10-21T00:00:00Z','backendStart':'2026-10-20T23:59:59Z','waitType':'Lock','blockers':[101]}]
 def test_actual_lock_overlap_requires_both_fixed_queries_and_exact_pids(self):
  self.assertEqual(self.m.concurrency_proof([self.rows()],[101,202])['status'],'PASS_SYNTHETIC_SQL_CONCURRENCY_ONLY')
  import copy
  for field,value in [('pid',999),('state','idle'),('query','select 1;'),('blockers',[303]),('waitType','Timeout')]:
   rows=copy.deepcopy(self.rows());rows[1][field]=value
   with self.assertRaisesRegex(ValueError,'CONCURRENT_LOCK_NOT_PROVEN'):self.m.concurrency_proof([rows],[101,202])
 def test_sequential_or_missing_blocking_evidence_never_passes(self):
  with self.assertRaises(ValueError):self.m.concurrency_proof([[self.rows()[0]],[self.rows()[1]]],[101,202])
  with self.assertRaises(ValueError):self.m.concurrency_proof([],[101,101])
 def test_group_absence_requires_reap_and_unknown_is_not_absent(self):
  from unittest.mock import Mock,patch
  child=Mock(pid=12345);child.wait.return_value=0
  with patch.object(self.m,'group_state',return_value='absent'):self.assertTrue(self.m.close_group(child)['closed'])
  with patch.object(self.m.os,'killpg',side_effect=PermissionError()):self.assertEqual(self.m.group_state(12345),'unknown')
 def test_helper_has_no_standalone_docker_runner_or_configurable_target(self):
  raw=Path(self.m.__file__).read_text()
  self.assertNotIn('if __name__',raw);self.assertNotIn('argparse',raw)
  self.assertIn('scratch.guard();scratch.own()',raw)
  self.assertIn('scratch.concurrent_unclosed=True',raw)
  self.assertIn('after==baseline',raw)
 def test_phase_rejects_arbitrary_name_before_dispatch(self):
  from unittest.mock import Mock
  runner=Mock()
  with self.assertRaisesRegex(ValueError,'FIXED_PHASE'):self.m.phase(runner,b'bytes','arbitrary')
  runner.docker.assert_not_called()
 def harness(self):
  from unittest.mock import Mock
  class Fake:
   __module_host__='unix:///fixed-review.sock'
  r=Fake();r.target='a'*64;r.concurrent_unclosed=False;r.seq=0;r.read_source=Mock(return_value=b'pinned-fixture')
  r.guard=Mock();r.own=Mock();r.memory=Mock();r.saved={};r.save=lambda name,value:r.saved.__setitem__(name,value)
  return r
 def test_run_dispatches_two_once_keeps_raw_evidence_and_restores_full_baseline(self):
  from unittest.mock import Mock,patch
  r=self.harness();children=[]
  def popen(args,**kwargs):
   i=len(children);child=Mock(pid=1000+i,returncode=0);child.poll.side_effect=[None,0,0,0] if i==0 else [0,0,0]
   kwargs['stdout'].write(f'{(101,202)[i]}|2026-10-21 00:00:00+00\n{{"withdrawn": true}}\n'.encode());children.append(child);return child
  with patch.object(self.m.subprocess,'Popen',side_effect=popen),patch.object(self.m,'snapshot',return_value={'rows':{},'catalogue':{},'sequences':{}}),patch.object(self.m,'phase') as phase,patch.object(self.m,'observe',return_value=self.rows()),patch.object(self.m,'observe_exact_backends',return_value=[]),patch.object(self.m,'close_group',return_value={'closed':True,'observations':[]}),patch.object(self.m.time,'sleep'):
   result=self.m.run(r)
  self.assertEqual(result['status'],'PASS_SYNTHETIC_SQL_CONCURRENCY_ONLY');self.assertEqual(len(children),2)
  self.assertEqual([call.args[2] for call in phase.call_args_list],['setup','verify','cleanup'])
  self.assertFalse(r.concurrent_unclosed);self.assertTrue(r.saved['consent-concurrency-receipt.json']['baselineRestored'])
  self.assertIn('consent-actor-a-stdout.raw',r.saved);self.assertIn('consent-actor-b-stderr.raw',r.saved)
 def test_actor_window_is_fixed_bounded_without_changing_cleanup_deadline(self):
  import inspect
  source=inspect.getsource(self.m.run)
  self.assertIn('deadline=time.monotonic()+180',source)
  self.assertIn('deadline=time.monotonic()+15',source)
  self.assertIn("need(time.monotonic()<deadline,'CONCURRENT_TIMEOUT')",source)

 def test_missing_stdout_pid_with_withdrawn_body_is_not_proven(self):
  from unittest.mock import Mock,patch
  r=self.harness();children=[]
  def popen(args,**kwargs):
   i=len(children);child=Mock(pid=1000+i,returncode=0);child.poll.side_effect=[None,0,0,0] if i==0 else [0,0,0]
   kwargs['stdout'].write(b'{"withdrawn": true}\n');children.append(child);return child
  with patch.object(self.m.subprocess,'Popen',side_effect=popen),patch.object(self.m,'snapshot',return_value={}),patch.object(self.m,'phase') as phase,patch.object(self.m,'observe',return_value=self.rows()),patch.object(self.m,'observe_exact_backends',return_value=[]),patch.object(self.m,'close_group',return_value={'closed':True,'observations':[]}),patch.object(self.m.time,'sleep'):
   with self.assertRaisesRegex(ValueError,'CONSENT_CONCURRENCY_NOT_PROVEN'):self.m.run(r)
  self.assertEqual(r.saved['consent-concurrency-receipt.json']['status'],'NOT_PROVEN')
  self.assertTrue(r.saved['consent-concurrency-receipt.json']['backendsClosed'])
  self.assertEqual([call.args[2] for call in phase.call_args_list],['setup','cleanup'])

 def test_unclosed_actor_refuses_fixture_cleanup_and_keeps_scratch_stop_blocked(self):
  from unittest.mock import Mock,patch
  r=self.harness();count=0
  def popen(args,**kwargs):
   nonlocal count
   count+=1;return Mock(pid=1000+count,returncode=0,poll=Mock(return_value=0))
  with patch.object(self.m.subprocess,'Popen',side_effect=popen),patch.object(self.m,'snapshot',return_value={}),patch.object(self.m,'phase') as phase,patch.object(self.m,'close_group',return_value={'closed':False,'observations':[{'group':'unknown'}]}):
   with self.assertRaisesRegex(ValueError,'CONSENT_CONCURRENCY_NOT_PROVEN'):self.m.run(r)
  self.assertTrue(r.concurrent_unclosed);self.assertEqual([c.args[2] for c in phase.call_args_list],['setup'])
  self.assertEqual(r.saved['consent-concurrency-receipt.json']['status'],'NOT_PROVEN')

 def test_sequence_snapshot_batches_41_exact_relations_in_one_sql(self):
  from unittest.mock import Mock
  import json
  names=[['private','fixture_seq_'+str(i)] for i in range(41)]
  values={'.'.join(row):{'last_value':7,'log_cnt':0,'is_called':True} for row in names}
  runner=Mock();runner.sql.return_value=json.dumps(values).encode()
  self.assertEqual(self.m.sequence_values(runner,names),values);self.assertEqual(runner.sql.call_count,1)
  query=runner.sql.call_args.args[0].decode();self.assertEqual(query.count(' union all '),40)
  self.assertIn('from "private"."fixture_seq_0" s',query)
  self.assertNotIn('row_to_json',query)
  self.assertEqual(query.count("jsonb_build_object('last_value',s.last_value,'log_cnt',s.log_cnt,'is_called',s.is_called)"),41)
  runner.sql.reset_mock()
  with self.assertRaises(ValueError):self.m.sequence_values(runner,[['private','bad;drop']])
  runner.sql.assert_not_called()
  runner.sql.return_value=b'{}'
  with self.assertRaisesRegex(ValueError,'SEQUENCE_KEYSET'):self.m.sequence_values(runner,names)
 def test_exact_pid_surviving_local_application_reset_is_not_closed(self):
  bindings=[{'pid':101,'backendStart':'original'}]
  self.assertFalse(self.m.exact_backends_absent([{'pid':101,'backendStart':'original','application':'','state':'idle'}],bindings))
  self.assertTrue(self.m.exact_backends_absent([],bindings))
  self.assertTrue(self.m.exact_backends_absent([{'pid':101,'backendStart':'new-incarnation','application':'other'}],bindings))
 def test_missing_pid_and_nonunique_observation_refuse_cleanup_identity(self):
  with self.assertRaisesRegex(ValueError,'ACTOR_BACKEND_IDENTITY_UNPROVEN'):self.m.actor_bindings([b''],[],1)
  rows=self.rows();rows[0]['pid']=999
  with self.assertRaisesRegex(ValueError,'ACTOR_PID_MISMATCH'):self.m.actor_bindings([b'101|time\n'],[rows],1)
  binding=self.m.actor_bindings([b''],[self.rows()],1)
  self.assertEqual(binding[0]['pidSource'],'unique_observation')
 def test_application_reset_with_original_backend_alive_blocks_cleanup_and_stop(self):
  from unittest.mock import Mock,patch
  import itertools
  r=self.harness();children=[]
  def popen(args,**kwargs):
   i=len(children);child=Mock(pid=1000+i,returncode=0);child.poll.side_effect=[None,0,0,0] if i==0 else [0,0,0]
   kwargs['stdout'].write(f'{(101,202)[i]}|2026-10-21 00:00:00+00\n{{"withdrawn": true}}\n'.encode());children.append(child);return child
  alive=[{'pid':101,'backendStart':'2026-10-20T23:59:59Z','application':'','state':'idle'}]
  clock=iter(itertools.count())
  with patch.object(self.m.subprocess,'Popen',side_effect=popen),patch.object(self.m,'snapshot',return_value={}),patch.object(self.m,'phase') as phase,patch.object(self.m,'observe',return_value=self.rows()),patch.object(self.m,'observe_exact_backends',return_value=alive),patch.object(self.m,'close_group',return_value={'closed':True,'observations':[]}),patch.object(self.m.time,'sleep'),patch.object(self.m.time,'monotonic',side_effect=lambda:next(clock)):
   with self.assertRaisesRegex(ValueError,'CONSENT_CONCURRENCY_NOT_PROVEN'):self.m.run(r)
  self.assertTrue(r.concurrent_unclosed);self.assertEqual([c.args[2] for c in phase.call_args_list],['setup'])
  self.assertFalse(r.saved['consent-concurrency-receipt.json']['backendsClosed'])
