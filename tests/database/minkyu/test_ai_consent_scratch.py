"""격리 SQL 검사 입력·기존 자원 보존·새 대상 전이 검증. Docker 호출 없음."""
import importlib.util
from pathlib import Path
import unittest

P=Path(__file__).resolve().parents[3]/'tools/local/run_ai_consent_scratch.py'
class GuardTests(unittest.TestCase):
 def setUp(self):
  spec=importlib.util.spec_from_file_location('scratch',P);self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
 def test_first_private_read_allows_access_time_update(self):
  import os,tempfile
  with tempfile.TemporaryDirectory() as root:
   p=Path(root)/'review.json';p.write_bytes(b'private');p.chmod(0o600);os.utime(p,(1,1))
   self.assertEqual(self.m.private_raw(p),b'private')
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
