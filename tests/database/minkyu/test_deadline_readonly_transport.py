"""D03 읽기 포트의 실제 로컬 PG 종결과 실패 경계를 검증한다. Docker 호출은 없다."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import types
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[3] / 'tests/integration/minkyu/deadline_readonly_transport.py'
spec = importlib.util.spec_from_file_location('deadline_readonly_transport', PATH)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.saved = {}; self.checks = []; self.commands = []; self.original_popen = subprocess.Popen; self.children=[]
        class Reviewed: pass
        class Ports:
            template=None
            def __init__(self):
                if self.template is not None:self.__dict__.update(self.template)
            def snapshot(self): return self.read_sql('select 9')
        self.ai = types.SimpleNamespace(ReviewedSignedProvisioning=Reviewed, FixedLifecycleProvisioningPorts=Ports)
        self.ai.verify_preserved_resources = lambda *args: self.checks.append('preserve')
        containers = {k: {'id': str(i)*64} for i,k in enumerate(('db','auth','rest','gateway'), 1)}
        review = Reviewed(); review.prepared_root=Path('/private/tmp/example'); review.source_pins={'a':'b'}; review.containers=containers
        original = Ports(); original.reviewed=review; original.target={'id':containers['db']['id'],'host':'unix:///fixed','project':'fixed'}
        original.base=['docker','--host','unix:///fixed']; original.runner=types.SimpleNamespace(root=review.prepared_root, call=lambda *a: None)
        core=types.SimpleNamespace(ai=self.ai,root=review.prepared_root,binding={'containers':containers,'sourcePins':{'a':'b'}},
            target={'host':'unix:///fixed'},port=original,active=lambda:None)
        self.runtime=types.SimpleNamespace(core=core,raw_sticky=[],save=self.save,
            mark_raw_unclosed=lambda name,error:self.runtime.raw_sticky.append(name))
        core.r=types.SimpleNamespace(call=lambda argv:json.dumps([{'Id':containers['db']['id'],'HostConfig':{'PidMode':''}}]))
        original.binding=core.binding
        Ports.template=dict(original.__dict__)
        self.core=core
        self.port=m.bind_deadline_readonly_port(self.ai,core,self.runtime)
        self.t=self.port.deadline_transport
    def tearDown(self):
        for child in self.children:
            if child.poll() is None:child.kill()
            child.wait(timeout=2)
    def save(self,name,value):
        if name in self.saved: raise ValueError('REPLAY')
        self.saved[name]=value
    def popen(self,argv,**kwargs):
        self.commands.append(argv)
        if 'psql' in argv:
            output=json.dumps({'pid':123,'backendStart':'2026-10-21T00:00:00Z'})+'\n9\n'
        else: output='ABSENT'
        child=self.original_popen([sys.executable,'-c','import sys;sys.stdout.write('+repr(output)+')'],**kwargs)
        self.children.append(child);return child
    def test_actual_local_children_and_inherited_snapshot(self):
        with patch.object(m.subprocess,'Popen',self.popen):
            self.assertEqual(self.port.snapshot(),'9')
        self.assertEqual(self.checks,['preserve','preserve'])
        self.assertEqual(len(self.commands),2)
        raw=self.saved['d03-read-00001-raw-private.json']
        self.assertTrue(raw['closure']['leaderReaped']);self.assertTrue(raw['closure']['processGroupAbsent'])
        self.assertTrue(self.saved['d03-read-00001-backend-closed.json']['backendAbsent'])
        self.assertFalse(self.t.sticky)
    def test_bad_queries_dispatch_zero(self):
        for query in ('delete from a','select 1; select 2','select 1 --x','select 1\\g'):
            with self.assertRaises(ValueError): self.port.read_sql(query)
        self.assertFalse(self.commands);self.assertFalse(self.saved)
    def test_timeout_contract(self):
        for timeout in (True,0,6,float('nan')):
            with self.assertRaises(ValueError):self.port.read_sql('select 1',timeout)
    def test_save_failure_is_sticky_before_spawn(self):
        self.runtime.save=lambda *a: (_ for _ in ()).throw(OSError('save'))
        with patch.object(m.subprocess,'Popen')as spawn:
            with self.assertRaises(OSError):self.port.read_sql('select 1')
            with self.assertRaises(ValueError):self.port.read_sql('select 1')
        spawn.assert_not_called();self.assertTrue(self.t.sticky);self.assertEqual(len(self.checks),1)
    def test_raw_save_failure_blocks_metadata_and_sql(self):
        def save(name,value):
            if 'raw-private' in name:raise OSError('rawsave')
            self.saved[name]=value
        self.runtime.save=save
        with patch.object(m.subprocess,'Popen',self.popen):
            with self.assertRaises(OSError):self.port.read_sql('select 1')
            count=len(self.commands)
            with self.assertRaises(ValueError):self.t.preserve()
            with self.assertRaises(ValueError):self.port.read_sql('select 1')
        self.assertEqual(count,1);self.assertEqual(len(self.checks),1)
    def test_unclosed_pg_blocks_observer(self):
        original=m.close_group
        def unproven(child,terminate=False):
            result=original(child,terminate);result['closed']=False;return result
        with patch.object(m.subprocess,'Popen',self.popen),patch.object(m,'close_group',unproven):
            with self.assertRaisesRegex(ValueError,'PG_UNPROVEN'):self.port.read_sql('select 1')
        self.assertEqual(len(self.commands),1);self.assertTrue(self.t.sticky)
    def test_non_sql_observer_pg_failure_sticky(self):
        original=m.close_group;calls=[]
        def close(child,terminate=False):
            result=original(child,terminate);calls.append(1)
            if len(calls)==2:result['closed']=False
            return result
        with patch.object(m.subprocess,'Popen',self.popen),patch.object(m,'close_group',close):
            with self.assertRaisesRegex(ValueError,'PG_UNPROVEN'):self.port.read_sql('select 1')
        self.assertEqual(len(self.commands),2);self.assertTrue(self.t.sticky)
        self.assertNotIn('d03-read-00001-closed.json',self.saved)
    def test_exact_context_rejects_plain_object(self):
        self.core.port.reviewed=types.SimpleNamespace()
        with self.assertRaises(ValueError):m.bind_deadline_readonly_port(self.ai,self.core,self.runtime)
    def test_rebound_database_blocks_all_calls(self):
        self.core.binding['containers']['db']['id']='f'*64
        with self.assertRaises(ValueError):self.port.read_sql('select 1')
        self.assertFalse(self.saved);self.assertFalse(self.checks)
    def test_success_output_overflow_raw_bounded(self):
        with patch.object(m.subprocess,'Popen',self.popen),patch.object(m,'STDOUT_LIMIT',4):
            with self.assertRaises(ValueError):self.port.read_sql('select 1')
        stream=self.saved['d03-read-00001-raw-private.json']['streams']['stdout']
        self.assertLessEqual(stream['capturedBytes'],5);self.assertFalse(stream['wholeProven'])
    def test_real_process_group_closure(self):
        child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'],start_new_session=True)
        try:
            time.sleep(.05)
            try:
                result=m.close_group(child,True)
            except PermissionError:
                # sandbox가 소멸한 PG 조회도 EPERM으로 반환하면 성공 증명은 하지 않는다.
                self.assertIsNotNone(child.poll())
            else:
                self.assertTrue(result['closed']);self.assertTrue(result['processGroupAbsent'])
        finally:
            if child.poll() is None:child.terminate()
            child.wait(timeout=2)
    def test_pg_permission_error_reaps_leader_but_keeps_sticky(self):
        real_killpg=m.os.killpg
        def forbidden(pid,sig):raise PermissionError('proof unavailable')
        with patch.object(m.subprocess,'Popen',self.popen),patch.object(m.os,'killpg',forbidden):
            with self.assertRaisesRegex(ValueError,'PG_UNPROVEN'):self.port.read_sql('select 1')
        self.assertTrue(all(c.poll()is not None for c in self.children))
        self.assertTrue(self.t.sticky);self.assertEqual(len(self.commands),1)
        with self.assertRaises(ValueError):self.t.preserve()
    def test_private_namespace_required(self):
        self.core.r.call=lambda argv:json.dumps([{'Id':self.t.db,'HostConfig':{'PidMode':'host'}}])
        with self.assertRaisesRegex(ValueError,'PRIVATE_PID_NAMESPACE'):
            m.bind_deadline_readonly_port(self.ai,self.core,self.runtime)
    def test_large_routine_response_saved_in_bounded_chunks(self):
        output=json.dumps({'pid':123,'backendStart':'2026-10-21T00:00:00Z'})+'\n'+'x'*1128225+'\n'
        def spawn(argv,**kwargs):
            self.commands.append(argv)
            # 큰 argv 대신 자식이 고정 크기 합성 문자열을 출력한다.
            code=('import sys;sys.stdout.write('+repr(output[:output.index('\n')+1])+');sys.stdout.write("x"*1128225+"\\n")') if 'psql' in argv else 'print("ABSENT",end="")'
            child=self.original_popen([sys.executable,'-c',code],**kwargs)
            self.children.append(child);return child
        with patch.object(m.subprocess,'Popen',spawn):
            self.assertEqual(len(self.port.read_sql('select 1')),1128225)
        proof=self.saved['d03-read-00001-raw-private.json']['streams']['stdout']
        chunks=proof['chunks'];self.assertEqual(len(chunks),3)
        raw=b''.join(bytes.fromhex(self.saved[c['path']]['rawHex'])for c in chunks)
        self.assertEqual(m.sha(raw),proof['sha256'])
        self.assertTrue(all(len(json.dumps(v).encode())<2*1024*1024 for v in self.saved.values()))
    def test_statement_and_timeout_fixed_in_saved_intent(self):
        with patch.object(m.subprocess,'Popen',self.popen):self.port.read_sql('select 1',2)
        body=self.saved['d03-read-00001-intent.json']['sqlUtf8']
        self.assertIn("begin read only",body);self.assertIn("statement_timeout='1000ms'",body)
        self.assertIn("lock_timeout='1500ms'",body);self.assertIn('pg_backend_pid()',body)

if __name__=='__main__': unittest.main()
