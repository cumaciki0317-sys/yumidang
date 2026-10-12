import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import subprocess
import signal

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools/local'))
import observe_isolated as observer


class ObserverTests(unittest.TestCase):
    def test_observer_sigterm_enters_exception_cleanup_path(self):
        with self.assertRaisesRegex(ValueError, '^OBSERVER_INTERRUPTED$'):
            observer.interrupted(signal.SIGTERM, None)

    def test_natural_exit_between_poll_and_signal_is_reaped(self):
        process = Mock(pid=123)
        process.poll.return_value = None
        with patch.object(observer.os, 'killpg', side_effect=ProcessLookupError):
            observer.terminate(process)
        process.wait.assert_called_once_with(timeout=45)

    def test_cleanup_grace_then_kill_and_reap(self):
        process = Mock(pid=123)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired('child', 45), 0]
        def signal_group(_pid, sig):
            if sig == 0: raise ProcessLookupError
        with patch.object(observer.os, 'killpg', side_effect=signal_group) as kill:
            observer.terminate(process)
        self.assertEqual(kill.call_args_list[0].args, (123, signal.SIGTERM))
        self.assertEqual(kill.call_args_list[1].args, (123, signal.SIGKILL))
        self.assertEqual([call.kwargs['timeout'] for call in process.wait.call_args_list], [45, 5])

    def test_probe_requires_exact_single_available_field(self):
        self.assertEqual(observer.available_memory('MemAvailable: 1048576 kB\n'), 1048576)
        for value in ['', 'MemFree: 9999999 kB', 'MemAvailable: -1 kB',
                      'MemAvailable: 1048576 kB\nMemAvailable: 1048576 kB']:
            with self.assertRaises(ValueError): observer.available_memory(value)

    def test_receipt_and_log_are_readable_private_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'proof'
            with observer.exclusive_file(path) as file:
                file.write('safe'); file.flush(); file.seek(0)
                self.assertEqual(file.read(), 'safe')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError): observer.exclusive_file(path)
            self.assertEqual(path.read_text(), 'safe')


class SignedObserverTests(unittest.TestCase):
    def test_profile_maps_only_verified_exact_context_socket(self):
        for profile in ('yumidang-minkyu', 'jonghyun-backend100'):
            target={'context':'colima-'+profile,'host':'unix://'+str(Path.home()/'.colima'/profile/'docker.sock')}
            self.assertEqual(observer.signed_memory_profile(target),profile)
            for changed in ({'context':'colima-outside'}, {'host':'unix:///outside/docker.sock'},
                            {'host':target['host']+'?profile=outside'}, {'host':'tcp://127.0.0.1:2375'}):
                with self.subTest(profile=profile,changed=changed),self.assertRaises(ValueError):
                    observer.signed_memory_profile({**target,**changed})

    def test_probe_fixed_profile_arguments_and_default_unchanged(self):
        for profile in (None,'yumidang-minkyu','jonghyun-backend100'):
            with patch.object(observer.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'MemAvailable: 1048576 kB\n',''))as run:
                self.assertEqual(observer.probe()if profile is None else observer.probe(profile),1048576)
                self.assertEqual(run.call_args.args[0],['colima','ssh','--profile',profile or 'jonghyun-backend100','--','cat','/proc/meminfo'])
                self.assertEqual(run.call_args.kwargs['timeout'],3)
        with patch.object(observer.subprocess,'run')as run:
            with self.assertRaisesRegex(ValueError,'MEMORY_PROFILE_INVALID'):observer.probe('unverified')
            run.assert_not_called()

    def test_signed_observe_uses_verified_m_target_for_all_samples(self):
        import json
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory).resolve();binding=root/'signed-auth-binding.json'
            proof={'bindingSha256':'a'*64,'memoryProfile':'yumidang-minkyu','target':{'id':'b'*64,'host':'fixed-verified'}}
            good={'status':'PASS','scope':'SIGNED_LOCAL_AUTH_AI22_23','actualAuthPostgrest':'PASS',
                'actualNaver':'NOT_RUN','externalProvider':'NOT_RUN','naturalMidnight':'NOT_RUN','tls':'NOT_RUN_LOCAL_HTTP'}
            source=observer.ROOT/'tests/integration/jonghyun/isolated_ai_contracts.py'
            process=Mock(returncode=0);process.poll.side_effect=[None,0];process.wait.return_value=0
            def popen(_command,**kwargs):
                kwargs['stdout'].write(json.dumps(good));return process
            with patch.object(observer,'source_pins',return_value={'fixed':'c'*64}),\
                    patch.object(observer,'inspect_observed_signed_binding',return_value=proof)as inspect,\
                    patch.object(observer,'isolated_prepared_target',side_effect=AssertionError('old J target called')),\
                    patch.object(observer.subprocess,'run',return_value=subprocess.CompletedProcess([],0,source.read_bytes(),b'')),\
                    patch.object(observer.subprocess,'Popen',side_effect=popen),patch.object(observer,'probe',return_value=1048576)as probe,\
                    patch.object(observer,'terminate'),patch.object(observer.time,'sleep'),patch.object(observer.signal,'signal'),\
                    patch('builtins.print'):
                self.assertEqual(observer.observe(root,'ai-signed',binding),0)
                self.assertEqual([call.args for call in probe.call_args_list],[('yumidang-minkyu',),('yumidang-minkyu',)])
                self.assertEqual(inspect.call_count,2)

    def test_signed_target_drift_retains_failed_receipt(self):
        import json
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory).resolve();binding=root/'signed-auth-binding.json'
            before={'bindingSha256':'a'*64,'memoryProfile':'yumidang-minkyu','target':{'id':'b'*64}}
            after={**before,'target':{'id':'c'*64}}
            source=observer.ROOT/'tests/integration/jonghyun/isolated_ai_contracts.py'
            process=Mock(returncode=0);process.poll.return_value=0;process.wait.return_value=0
            with patch.object(observer,'source_pins',return_value={'fixed':'c'*64}),\
                    patch.object(observer,'inspect_observed_signed_binding',side_effect=[before,after]),\
                    patch.object(observer.subprocess,'run',return_value=subprocess.CompletedProcess([],0,source.read_bytes(),b'')),\
                    patch.object(observer.subprocess,'Popen',return_value=process),patch.object(observer,'probe',return_value=1048576),\
                    patch.object(observer,'terminate')as terminate,patch.object(observer.signal,'signal'),patch('builtins.print'):
                self.assertEqual(observer.observe(root,'ai-signed',binding),1);terminate.assert_called_once_with(process)
            receipt=json.loads(next(root.glob('*-observer-*.json')).read_text())
            self.assertEqual(receipt['status'],'FAIL');self.assertNotIn('actualAuthPostgrest',receipt)

    def test_explicit_signed_mode_uses_only_fixed_runner(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); binding = root / 'signed-auth-binding.json'
            command = observer.observed_command(root, 'ai-signed', binding)
            self.assertEqual(command[-3:], ['--signed-auth', '--signed-auth-binding', str(binding)])
            self.assertIn(str(observer.ROOT / 'tests/integration/jonghyun/isolated_ai_contracts.py'), command)
            self.assertNotIn('--signed-auth', observer.observed_command(root, 'ai'))

    def test_missing_binding_or_other_mode_binding_cannot_start(self):
        for mode, binding in [('ai-signed', None), ('ai', Path('/tmp/input')),
                              ('summary', Path('/tmp/input')), ('user-module', None)]:
            with self.assertRaises(ValueError):
                observer.observed_command(Path('/tmp/scope'), mode, binding)

    def test_other_scope_and_symlink_binding_cannot_start(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); target = root / 'input'; target.write_text('{}')
            link = root / 'link'; link.symlink_to(target)
            for path in [link, root.parent / 'outside.json', Path('relative.json')]:
                with self.assertRaises(ValueError):
                    observer.observed_command(root, 'ai-signed', path)

    def test_exit_zero_or_synthetic_pass_does_not_prove_signed_auth(self):
        import json
        good = {'status':'PASS','scope':'SIGNED_LOCAL_AUTH_AI22_23','actualAuthPostgrest':'PASS',
                'actualNaver':'NOT_RUN','externalProvider':'NOT_RUN','naturalMidnight':'NOT_RUN',
                'tls':'NOT_RUN_LOCAL_HTTP'}
        observer.validate_signed_result(json.dumps(good))
        for key in good:
            bad = dict(good); bad[key] = 'UNPROVEN'
            with self.assertRaises(ValueError): observer.validate_signed_result(json.dumps(bad))
        for value in ['', 'PASS', '{}', '[]', '{"status":"PASS"}', json.dumps(good)+'\n'+json.dumps(good)]:
            with self.assertRaises(ValueError): observer.validate_signed_result(value)


class SignedImportAndClosureTests(unittest.TestCase):
    def test_captured_signed_module_supplies_profile_and_db_binding(self):
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory).resolve();source=root/'tests/integration/jonghyun/isolated_ai_contracts.py'
            source.parent.mkdir(parents=True)
            for profile,mismatch in [('yumidang-minkyu',False),('jonghyun-backend100',False),('yumidang-minkyu',True)]:
                with self.subTest(profile=profile,mismatch=mismatch):
                    target={'context':'colima-'+profile,'host':'unix://'+str(Path.home()/'.colima'/profile/'docker.sock'),'id':'b'*64}
                    metadata={'bindingSha256':'a'*64,'containerIds':{'db':('c'if mismatch else'b')*64}}
                    code=('def inspect_signed_binding(path,root):\n return '+repr(metadata)+'\n'
                        +'def signed_prepared_target(root):\n return '+repr(target)+'\n').encode()
                    source.write_bytes(code)
                    with patch.object(observer,'ROOT',root),patch.object(observer.subprocess,'run',
                            return_value=subprocess.CompletedProcess([],0,code,b''))as run:
                        if mismatch:
                            with self.assertRaisesRegex(ValueError,'SIGNED_OBSERVER_TARGET_CHANGED'):
                                observer.inspect_observed_signed_binding(root/'binding',root)
                        else:
                            value=observer.inspect_observed_signed_binding(root/'binding',root)
                            self.assertEqual(value,{'bindingSha256':'a'*64,'target':target,'memoryProfile':profile})
                        self.assertEqual(run.call_count,1);self.assertEqual(run.call_args.args[0][0],'git')

    def test_drifted_runner_top_level_is_never_evaluated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); source = root / 'tests/integration/jonghyun/isolated_ai_contracts.py'
            source.parent.mkdir(parents=True); marker = root / 'executed'
            source.write_text("from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('bad')\n")
            with patch.object(observer, 'ROOT', root), patch.object(observer.subprocess, 'run',
                    return_value=subprocess.CompletedProcess([], 0, b'# different committed bytes', b'')):
                with self.assertRaisesRegex(ValueError, 'OBSERVER_SOURCE_NOT_COMMITTED'):
                    observer.inspect_observed_signed_binding(root / 'binding', root)
            self.assertFalse(marker.exists())

    def test_source_pins_rejection_happens_before_signed_import(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with patch.object(observer, 'source_pins', side_effect=ValueError('OBSERVER_SOURCE_NOT_COMMITTED')), \
                 patch.object(observer, 'inspect_observed_signed_binding') as inspect:
                with self.assertRaisesRegex(ValueError, 'OBSERVER_SOURCE_NOT_COMMITTED'):
                    observer.observe(root, 'ai-signed', root / 'binding')
                inspect.assert_not_called()

    def test_exited_leader_still_closes_owned_child_group(self):
        process = Mock(pid=123); process.poll.return_value = 0
        with patch.object(observer, 'group_alive', side_effect=[True, False, False]), \
             patch.object(observer.os, 'killpg') as kill:
            observer.terminate(process)
        kill.assert_called_once_with(123, signal.SIGTERM)
        process.wait.assert_not_called()

    def test_unconfirmed_child_group_cannot_be_reported_closed(self):
        process = Mock(pid=123); process.poll.return_value = 0
        with patch.object(observer, 'group_alive', return_value=True), \
             patch.object(observer.time, 'monotonic', side_effect=[0, 46, 46, 52]), \
             patch.object(observer.os, 'killpg') as kill:
            with self.assertRaises(subprocess.TimeoutExpired): observer.terminate(process)
        self.assertEqual([c.args[1] for c in kill.call_args_list], [signal.SIGTERM, signal.SIGKILL])


if __name__ == '__main__': unittest.main()
