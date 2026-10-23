"""current 전용 독립 종료 관측. 실제 host Python만 사용하며 Docker/Auth0."""
import importlib.util
import sys
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[3]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(spec);sys.modules[name]=m;spec.loader.exec_module(m);return m
m=load('current_observer_kernel','tests/integration/jonghyun/isolated_ai_contracts.py')
pure=load('current_observer_transport','tests/integration/minkyu/deadline_readonly_transport.py')
class ObserverTests(unittest.TestCase):
 def port(self,guard=lambda:None):
  p=object.__new__(m._CurrentAI2223SQL);p.pure=pure;p.core=SimpleNamespace(active=guard);p.saved={};p.save=lambda k,v:p.saved.__setitem__(k,v);return p
 def run_child(self,p,code,timeout=.3):return p.child([sys.executable,'-c',code],b'',timeout,'local',65536,65536)
 def test_group_permission_failure_remains_unproven_and_sticky(self):
  fixtures=load('current_permission_existing_tests','tests/database/minkyu/test_current_ai2223_execution.py')
  with tempfile.TemporaryDirectory()as directory:
   port,saved,_=fixtures.StickySqlTests().make(Path(directory).resolve());real=subprocess.Popen
   def spawn(argv,**kwargs):return real([sys.executable,'-c',"print('done')"],**kwargs)
   with patch.object(m.subprocess,'Popen',side_effect=spawn)as launched,patch.object(port.pure,'close_group',side_effect=PermissionError()):
    with self.assertRaisesRegex(ValueError,'D03_READ_PG_UNPROVEN'):port.execute('select 1;')
    with self.assertRaisesRegex(ValueError,'STICKY'):port.execute('select 2;')
    self.assertEqual(launched.call_count,1)
   raw=saved['current-sql-00001-raw-private.json'];self.assertEqual(raw['closureFailure'],{'type':'PERMISSION_ERROR','code':'PERMISSION_DENIED'});self.assertTrue(port.sticky)
 def test_late_native_bootstrap_cannot_double_close_after_fallback_claim(self):
  import threading
  release=threading.Event();real_thread=threading.Thread;threads=[]
  class DelayedThread:
   ident=None
   def __init__(self,target,daemon):
    self.thread=real_thread(target=lambda:(release.wait(2),target()),daemon=True);threads.append(self.thread)
   def start(self):self.thread.start();raise RuntimeError('NATIVE_ALREADY_CREATED')
   def is_alive(self):return self.thread.is_alive()
  p=self.port();original=pure.close_group
  with patch.object(m.threading,'Thread',DelayedThread),patch.object(pure,'close_group',wraps=original)as closed:
   try:
    with self.assertRaisesRegex(RuntimeError,'NATIVE_ALREADY_CREATED'):self.run_child(p,'import time;time.sleep(5)')
    self.assertEqual(closed.call_count,1);release.set()
    for thread in threads:thread.join(2);self.assertFalse(thread.is_alive())
    self.assertEqual(closed.call_count,1)
   finally:
    release.set()
    for thread in threads:thread.join(2)
  raw=p.saved['local-raw-private.json'];self.assertTrue(raw['fallbackOwnershipClaimed']);self.assertEqual(raw['processOwner'],'fallback');self.assertFalse(raw['watcherClosed'])
 def test_thread_constructor_failure_closes_spawned_child_and_saves_raw(self):
  p=self.port()
  with patch.object(m.threading,'Thread',side_effect=RuntimeError('THREAD_CONSTRUCTOR_TEST')):
   with self.assertRaisesRegex(RuntimeError,'THREAD_CONSTRUCTOR_TEST'):self.run_child(p,'import time;time.sleep(5)')
  raw=p.saved['local-raw-private.json'];self.assertTrue(raw['fallbackOwnershipClaimed']);self.assertTrue(raw['closure']['closed']);self.assertEqual(raw['processOwner'],'fallback')
 def test_thread_start_failure_closes_exact_child_saves_raw_and_sticks(self):
  fixtures=load('current_observer_existing_tests','tests/database/minkyu/test_current_ai2223_execution.py')
  with tempfile.TemporaryDirectory()as directory:
   port,saved,_=fixtures.StickySqlTests().make(Path(directory).resolve());real=subprocess.Popen
   def spawn(argv,**kwargs):return real([sys.executable,'-c','import time;time.sleep(5)'],**kwargs)
   with patch.object(m.subprocess,'Popen',side_effect=spawn)as launched,patch.object(m.threading.Thread,'start',side_effect=RuntimeError('THREAD_START_TEST')):
    with self.assertRaisesRegex(RuntimeError,'THREAD_START_TEST'):port.execute('select 1;')
    with self.assertRaisesRegex(ValueError,'STICKY'):port.execute('select 2;')
    self.assertEqual(launched.call_count,1)
   raw=saved['current-sql-00001-raw-private.json'];self.assertTrue(raw['fallbackOwnershipClaimed']);self.assertTrue(raw['closure']['closed']);self.assertTrue(port.sticky)
 def test_early_exit_is_observed_independently_of_slow_guard(self):
  p=self.port(lambda:time.sleep(.4));self.assertEqual(self.run_child(p,"print('ok')"),b'ok\n')
  proof=p.saved['local-raw-private.json'];self.assertTrue(proof['onTime']);self.assertLess(proof['exitObservedMonotonic'],proof['deadlineMonotonic']);self.assertTrue(proof['watcherClosed']);self.assertTrue(proof['closure']['closed'])
 def test_late_exit_is_rejected_even_when_guard_blocks(self):
  p=self.port(lambda:time.sleep(.4))
  with self.assertRaisesRegex(ValueError,'D03_READ_PROCESS_TIMEOUT'):self.run_child(p,'import time;time.sleep(2)')
  self.assertFalse(p.saved['local-raw-private.json']['onTime']);self.assertTrue(p.saved['local-raw-private.json']['closure']['closed'])
 def test_late_guard_failure_is_not_promoted_by_early_exit(self):
  def bad():time.sleep(.15);raise ValueError('TEST_GUARD_FAILED')
  p=self.port(bad)
  with self.assertRaisesRegex(ValueError,'TEST_GUARD_FAILED'):self.run_child(p,"print('ok')")
  self.assertTrue(p.saved['local-raw-private.json']['closure']['closed'])
 def test_output_limit_is_rejected_and_raw_is_saved(self):
  p=self.port()
  with self.assertRaises(ValueError):p.child([sys.executable,'-c',"print('x'*10000)"],b'',.5,'local',64,64)
  self.assertIn('local-raw-private.json',p.saved)
 def test_unproven_group_closure_never_returns_success(self):
  p=self.port()
  with patch.object(pure,'close_group',return_value={'closed':False,'leaderReaped':True,'processGroupAbsent':False}):
   with self.assertRaisesRegex(ValueError,'D03_READ_PG_UNPROVEN'):self.run_child(p,"print('ok')")
  self.assertFalse(p.saved['local-raw-private.json']['streams']['stdout']['wholeProven'])
 def test_grandchild_group_is_closed_after_timeout(self):
  p=self.port()
  with self.assertRaisesRegex(ValueError,'D03_READ_PROCESS_TIMEOUT'):
   self.run_child(p,"import subprocess,sys,time,signal;child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(5)']);signal.signal(signal.SIGTERM,lambda *_:(child.wait(),sys.exit(0)));time.sleep(5)",timeout=1)
  self.assertTrue(p.saved['local-raw-private.json']['closure']['closed'])
class MemoryTests(unittest.TestCase):
 def runner(self):
  import threading
  r=object.__new__(m._CurrentAI2223Run);r.sources=lambda:None;r.raw=b'binding';r.receipt_raw=b'receipt';r.root=Path('/private/tmp/fake-current')
  r.files=SimpleNamespace(private=lambda p:b'binding'if Path(p).name=='signed-ai-binding-private.json'else b'receipt')
  r.value={'auth6Receipt':'/private/tmp/receipt','containers':{'db':{'id':'fixed-db'}},'daemonId':'daemon','decisionId':'root'};r.binding={'sourcePins':{},'containers':{},'credentials':{}}
  r.reviewed=object();r.done=threading.Event();r.failures=[];r.deadline=time.monotonic()+300;r.samples=[];r.memory_last=None;r.transport=pure;r.saved=[];r.save=lambda k,v:r.saved.append(v)
  return r
 def invoke(self,r,value=2099652,db='fixed-db',daemon='daemon',error=None,inspect_change=None,stop_during=False):
  import hashlib,json
  current={'Id':db,'Name':'/own-db','Image':'sha256:fixed','State':{'Running':True,'OOMKilled':False},'Config':{'Labels':{'com.supabase.cli.project':'fixed-project'}},'HostConfig':{'PidMode':''},'Mounts':[]}
  item={'id':'fixed-db','name':'own-db','image':'sha256:fixed'}
  for field,key in(('Config','configSha256'),('HostConfig','hostConfigSha256'),('Mounts','mountsSha256')):item[key]=hashlib.sha256(json.dumps(current[field],sort_keys=True,separators=(',',':')).encode()).hexdigest()
  r.value['containers']['db']=item;r.memory_target_raw=json.dumps({'id':'fixed-db','host':'unix:///fixed','project':'fixed-project'}).encode()
  if inspect_change:inspect_change(current)
  def run(argv,stdout,stderr,timeout):
   stdout.write(daemon.encode()if 'info'in argv else json.dumps([current]).encode());return SimpleNamespace(returncode=0)
  def probe(_):
   if stop_during:r.done.set()
   if error:raise error
   return value
  with patch.object(m,'validate_current_ai2223_approval'),patch.object(m.subprocess,'run',side_effect=run),patch.object(m.FixedSignedProvisioningPorts,'memory_kib',side_effect=probe):m._CurrentAI2223Run.memory(r,786432)
 def test_initial_no_runner_or_port_uses_exact_db_without_recursive_active(self):
  r=self.runner();r.active=lambda:(_ for _ in()).throw(AssertionError('recursive active'));self.invoke(r)
  self.assertEqual(r.samples,[2099652]);self.assertIsNotNone(r.memory_last);self.assertEqual(r.saved[0]['transport'],'EXACT_OWNED_DB_MEMINFO')
 def test_wrong_db_daemon_low_value_and_probe_exception_reject(self):
  for options in ({'db':'foreign'},{'daemon':'foreign'},{'value':786431},{'error':subprocess.TimeoutExpired(['SECRET'],3)},{'inspect_change':lambda c:c['State'].update(Running=False)},{'inspect_change':lambda c:c['HostConfig'].update(PidMode='host')}):
   r=self.runner()
   with self.subTest(options=list(options)),self.assertRaises((ValueError,subprocess.TimeoutExpired)):self.invoke(r,**options)
   self.assertIsNone(r.memory_last);self.assertEqual(len(r.saved),1);self.assertNotIn('SECRET',str(r.saved))
 def test_probe_longer_than_three_seconds_is_rejected(self):
  r=self.runner()
  with patch.object(m.time,'monotonic',side_effect=[0,0,0,4,4]):
   with self.assertRaisesRegex(ValueError,'CURRENT_AI2223_MEMORY_PROBE'):self.invoke(r)
  self.assertIsNone(r.memory_last);self.assertEqual(r.saved[0]['probeElapsedSeconds'],4)
 def test_monitor_normal_stop_during_guard_has_no_false_failure(self):
  import threading
  r=self.runner();entered=threading.Event();release=threading.Event()
  def sources():entered.set();release.wait(2)
  r.sources=sources;r.memory=lambda minimum:self.invoke(r)
  thread=threading.Thread(target=r.monitor);thread.start();self.assertTrue(entered.wait(1));r.done.set();release.set();thread.join(2)
  self.assertFalse(thread.is_alive());self.assertEqual(r.failures,[]);self.assertIsNone(r.memory_last);self.assertTrue(r.saved[0]['cancelledBeforeProbe'])
 def test_normal_stop_before_probe_is_not_a_memory_failure(self):
  r=self.runner();r.sources=lambda:r.done.set();self.invoke(r)
  self.assertIsNone(r.memory_last);self.assertTrue(r.saved[0]['cancelledBeforeProbe']);self.assertEqual(r.failures,[])
 def test_stop_during_probe_does_not_hide_probe_error(self):
  r=self.runner()
  with self.assertRaisesRegex(ValueError,'CURRENT_AI2223_MEMORY_PROBE'):self.invoke(r,value=786431,stop_during=True)
  self.assertTrue(r.done.is_set());self.assertEqual(r.saved[0]['failure']['code'],'CURRENT_AI2223_MEMORY_PROBE');self.assertFalse(r.saved[0]['cancelledBeforeProbe'])
 def test_preexisting_failure_is_not_cleared_by_memory_probe(self):
  r=self.runner();r.failures=['earlier']
  with self.assertRaisesRegex(ValueError,'CURRENT_AI2223_MEMORY_OR_DEADLINE'):self.invoke(r)
  self.assertEqual(r.failures,['earlier']);self.assertIsNone(r.memory_last)
if __name__=='__main__':unittest.main()
