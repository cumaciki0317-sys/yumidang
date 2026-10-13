"""J01 Root 프로세스 경계 책임 모형. Node만 실행하며 SQL/Auth/HTTP/VM은 호출하지 않는다."""
import importlib.util
import json
from pathlib import Path
import selectors
import shutil
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

CALLER = Path(__file__).resolve().parents[3] / 'tests/integration/jonghyun/j01-root-boundary.py'
spec = importlib.util.spec_from_file_location('tested_j01_root_boundary', CALLER)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NODE = shutil.which('node')
RUN = '00000000-0000-4000-8000-000000000001'
PROGRAM = r"""
import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin,crlfDelay:Infinity})[Symbol.asyncIterator]();
const first=JSON.parse((await lines.next()).value);
process.stdout.write(JSON.stringify({type:'result',requestId:first.requestId,sequence:0,
 proof:{scope:'ROOT_TYPED_BOUNDARY_CHECKS_ONLY',executionEvidence:'ROOT_ATTESTATION_REQUIRED',modelOnly:true}})+'\n');
// 실제 bridge처럼 readline이 열린 stdin을 소유한다. EOF를 받아야 정상 종료한다.
while(!(await lines.next()).done){}
"""


@unittest.skipUnless(NODE, '로컬 Node 실행 파일 필요')
class J01RootProcessTests(unittest.TestCase):
    def boundary(self):
        b = m.RootJ01Boundary.__new__(m.RootJ01Boundary)
        b.node = Path(NODE)
        b.run_id = RUN
        b.sequence = 0
        b.input = {'scope': 'LOCAL_PROCESS_MODEL_ONLY'}
        b.h = SimpleNamespace(signed_exact_json=json.loads)
        b.observations = []
        b.dispatch = lambda _: self.fail('terminal 이후 callback 호출 금지')
        return b

    def test_open_stdin_blocks_exit_then_eof_closes_node(self):
        child = subprocess.Popen([NODE, '--input-type=module', '-e', PROGRAM],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        selector = selectors.DefaultSelector()
        try:
            child.stdin.write(json.dumps({'requestId': RUN}) + '\n')
            child.stdin.flush()
            selector.register(child.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(timeout=5))
            self.assertEqual(json.loads(child.stdout.readline())['requestId'], RUN)
            with self.assertRaises(subprocess.TimeoutExpired):
                child.wait(timeout=0.1)
            child.stdin.close()
            self.assertEqual(child.wait(timeout=5), 0)
        finally:
            selector.close()
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            child.stdin.close()
            child.stdout.close()

    def test_root_valid_terminal_sends_eof_and_waits_for_real_exit(self):
        b = self.boundary()
        with patch.object(m, 'NODE_PROGRAM', PROGRAM):
            proof = b.invoke_node()
        self.assertTrue(proof['modelOnly'])
        self.assertEqual(proof['executionEvidence'], 'ROOT_ATTESTATION_REQUIRED')
        self.assertEqual(b.child.poll(), 0)
        self.assertTrue(b.child.stdin.closed)
        self.assertTrue(b.child.stdout.closed)
        self.assertEqual(b.observations, [])

    def test_root_rejects_fake_live_terminal_and_reaps_owned_child(self):
        b = self.boundary()
        with patch.object(m, 'NODE_PROGRAM', PROGRAM.replace('ROOT_ATTESTATION_REQUIRED', 'LIVE_PASS')):
            with self.assertRaisesRegex(ValueError, '^J01_ROOT_NO_FAKE_LIVE_PASS$'):
                b.invoke_node()
        self.assertIsNotNone(b.child.poll())
        self.assertTrue(b.child.stdin.closed)
        self.assertTrue(b.child.stdout.closed)


if __name__ == '__main__':
    unittest.main()
