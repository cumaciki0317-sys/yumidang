"""실제 host 자식의 유한 원문·PG 종결 회귀. Docker/Auth/SQL 호출 0."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PATH=Path(__file__).resolve().parents[3]/'tests/integration/minkyu/deadline_readonly_transport.py'
spec=importlib.util.spec_from_file_location('readonly_transport_host_process',PATH)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class HostProcessTests(unittest.TestCase):
    def owner(self,active=lambda:None):
        saved={}
        def save(name,value):
            if name in saved:raise ValueError('REPLAY')
            saved[name]=value
        return SimpleNamespace(core=SimpleNamespace(active=active),save=save),saved
    def test_real_fast_exit_repeated_has_full_raw_and_closed_group(self):
        owner,saved=self.owner()
        for index in range(64):
            name='fast-'+str(index)
            raw=m.ReviewedDeadlineReadonlyTransport.child(owner,[sys.executable,'-I','-S','-c','print("fast")'],b'',2,name,1024,1024)
            self.assertEqual(raw,b'fast\n');proof=saved[name+'-raw-private.json']
            self.assertTrue(proof['closure']['closed']);self.assertTrue(proof['closure']['leaderReaped']);self.assertTrue(proof['closure']['processGroupAbsent'])
            self.assertTrue(all(v['wholeProven']for v in proof['streams'].values()))
    def test_real_timeout_preserves_partial_raw_and_closed_group(self):
        owner,saved=self.owner()
        with self.assertRaisesRegex(ValueError,'PROCESS_TIMEOUT'):
            m.ReviewedDeadlineReadonlyTransport.child(owner,[sys.executable,'-I','-S','-c','import time;print("partial",flush=True);time.sleep(5)'],b'',.1,'timeout',1024,1024)
        proof=saved['timeout-raw-private.json'];self.assertTrue(proof['closure']['closed']);self.assertEqual(proof['streams']['stdout']['capturedBytes'],8)
    def test_real_nonzero_exit_preserves_raw_and_failure(self):
        owner,saved=self.owner()
        with self.assertRaisesRegex(ValueError,'COMMAND_FAILED'):
            m.ReviewedDeadlineReadonlyTransport.child(owner,[sys.executable,'-I','-S','-c','import sys;print("partial");sys.exit(7)'],b'',2,'exit',1024,1024)
        proof=saved['exit-raw-private.json'];self.assertEqual(proof['returnCode'],7);self.assertTrue(proof['closure']['closed'])

class DiagnosticAndSignalRaceTests(unittest.TestCase):
    owner=HostProcessTests.owner
    def test_original_and_closure_errors_are_separate_without_message_leak(self):
        def stopped():raise ValueError('CURRENT_AI2223_MEMORY_OR_DEADLINE')
        owner,saved=self.owner(stopped);original=m.close_group
        def close_then_fail(child,terminate=False):
            original(child,terminate);raise ProcessLookupError('SIMULATED_PRIVATE_ERROR_TEXT')
        with patch.object(m,'close_group',close_then_fail):
            with self.assertRaisesRegex(ValueError,'PG_UNPROVEN'):
                m.ReviewedDeadlineReadonlyTransport.child(owner,[sys.executable,'-I','-S','-c','import time;time.sleep(5)'],b'',1,'both',1024,1024)
        proof=saved['both-raw-private.json'];self.assertEqual(proof['originalFailure']['code'],'CURRENT_AI2223_MEMORY_OR_DEADLINE')
        self.assertEqual(proof['closureFailure']['code'],'PROCESS_LOOKUP');self.assertNotIn('SIMULATED_PRIVATE_ERROR_TEXT',json.dumps(proof))
        self.assertIsNone(proof['closure']);self.assertFalse(proof['streams']['stdout']['wholeProven'])
    def test_actual_reaped_child_signal_esrch_requires_fresh_absence(self):
        child=subprocess.Popen([sys.executable,'-I','-S','-c','import time;time.sleep(.05)'],start_new_session=True);real=m.os.killpg;signal_calls=[]
        def race(pid,sig):
            if sig:
                signal_calls.append(sig);child.wait(timeout=2)
            return real(pid,sig)
        with patch.object(m.os,'killpg',side_effect=race):result=m.close_group(child,True)
        self.assertTrue(signal_calls);self.assertTrue(result['closed']);self.assertTrue(result['leaderReaped']);self.assertTrue(result['processGroupAbsent'])
    def test_process_lookup_without_actual_absence_cannot_pass(self):
        child=subprocess.Popen([sys.executable,'-I','-S','-c','import time;time.sleep(5)'],start_new_session=True);real=m.os.killpg
        def false_race(pid,sig):
            if sig:raise ProcessLookupError('SIMULATED_PRIVATE_ERROR_TEXT')
            return real(pid,sig)
        with patch.object(m.os,'killpg',side_effect=false_race):
            with self.assertRaisesRegex(ValueError,'SIGNAL_RACE_UNPROVEN'):m.close_group(child,True)
        self.assertIsNotNone(child.poll())
    def test_permission_is_never_absence_or_pass(self):
        owner,saved=self.owner(lambda:(_ for _ in()).throw(ValueError('CURRENT_AI2223_MEMORY_OR_DEADLINE')))
        with patch.object(m.os,'killpg',side_effect=PermissionError('SIMULATED_PRIVATE_ERROR_TEXT')):
            with self.assertRaisesRegex(ValueError,'PG_UNPROVEN'):
                m.ReviewedDeadlineReadonlyTransport.child(owner,[sys.executable,'-I','-S','-c','import time;time.sleep(5)'],b'',1,'permission',1024,1024)
        proof=saved['permission-raw-private.json'];self.assertEqual(proof['closureFailure']['code'],'PERMISSION_DENIED');self.assertNotIn('SIMULATED_PRIVATE_ERROR_TEXT',json.dumps(proof));self.assertIsNone(proof['closure'])
    def test_unknown_message_is_not_exported_as_error_code(self):
        proof=m.safe_error(ValueError('SIMULATED_PRIVATE_ERROR_TEXT'))
        self.assertEqual(proof,{'type':'VALUE_ERROR','code':'UNCLASSIFIED_FAILURE'});self.assertNotIn('SIMULATED_PRIVATE_ERROR_TEXT',json.dumps(proof))

if __name__=='__main__':unittest.main()
