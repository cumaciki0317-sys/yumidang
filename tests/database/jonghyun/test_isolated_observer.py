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
        with patch.object(observer.os, 'killpg') as kill:
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


if __name__ == '__main__': unittest.main()
