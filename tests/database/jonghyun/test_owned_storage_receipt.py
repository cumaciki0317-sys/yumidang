"""새 생성 관측의 범위/변경 거절만 검사한다. Docker·VM·Storage 실행 없음."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools/local'))
import start_owned_validation as producer


class CreationDeltaTests(unittest.TestCase):
    def setUp(self):
        self.project = 'jonghyun-backend100-a1234567'
        self.before = {'containers': [{'id': 'a' * 64, 'name': 'existing', 'project': None, 'running': True}],
                       'networks': [{'id': 'b' * 64, 'name': 'existing-network'}],
                       'volumes': [{'name': 'existing-volume'}]}
        self.after = copy.deepcopy(self.before)
        self.roles = ('db', 'auth', 'rest', 'kong', 'storage', 'inbucket')
        self.after['containers'] += [{'id': str(i + 1) * 64, 'name': 'supabase_' + role + '_' + self.project,
                                     'project': self.project, 'running': True, 'oomKilled': False}
                                    for i, role in enumerate(self.roles)]
        self.after['networks'].append({'id': 'c' * 64, 'name': 'supabase_network_' + self.project})
        self.after['volumes'] += [{'name': 'supabase_' + role + '_' + self.project} for role in ('db', 'storage')]

    def test_default_cli_is_not_run_and_delta_excludes_existing_resources(self):
        output = subprocess.check_output([sys.executable, '-B', str(ROOT / producer.PRODUCER)], text=True)
        self.assertEqual(json.loads(output), {'status': 'NOT_RUN', 'resourceChanges': 0})
        delta = producer.creation_delta(self.before, self.after, self.project)
        self.assertEqual(len(delta['containers']), 6)
        self.assertNotIn(self.before['containers'][0], delta['containers'])
        self.assertEqual(self.before['containers'][0]['id'], 'a' * 64)

    def test_existing_row_change_deletion_or_duplicate_is_rejected(self):
        for mutate in (lambda x: x['containers'][0].update(running=False),
                       lambda x: x['networks'].pop(0),
                       lambda x: x['volumes'].append(copy.deepcopy(x['volumes'][0]))):
            value = copy.deepcopy(self.after)
            mutate(value)
            with self.assertRaises(ValueError):
                producer.creation_delta(self.before, value, self.project)

    def test_incomplete_foreign_role_wrong_project_and_unhealthy_are_rejected(self):
        for mutate in (lambda x: x['containers'].pop(),
                       lambda x: x['containers'][1].update(name='supabase_other_' + self.project),
                       lambda x: x['containers'][1].update(project='other'),
                       lambda x: x['containers'][1].update(oomKilled=True),
                       lambda x: x['volumes'].append({'name': 'foreign-added-volume'})):
            value = copy.deepcopy(self.after)
            mutate(value)
            with self.assertRaises(ValueError):
                producer.creation_delta(self.before, value, self.project)

    def test_private_journal_never_overwrites_an_existing_observation(self):
        import tempfile
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            producer.save(root, 'intent.json', b'original')
            with self.assertRaises(FileExistsError):
                producer.save(root, 'intent.json', b'changed')
            self.assertEqual((root / 'intent.json').read_bytes(), b'original')
            self.assertEqual((root / 'intent.json').stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                producer.save(root, '../other.json', b'invalid')

    def test_project_label_and_each_port_collision_reject_before_spawn(self):
        from types import SimpleNamespace
        overlay = {'project_id': self.project, 'api.port': 55491, 'db.port': 55492}
        header = '  sl  local_address rem_address   st\n'
        quiet = SimpleNamespace(returncode=0, stdout=header)
        occupied = SimpleNamespace(returncode=0, stdout=header + '0: 00000000:D8C3 00000000:0000 0A\n')
        inspected = [{'Id': 'a' * 64, 'HostConfig': {'PortBindings': {}}}]
        for cause in ('project', 'docker', 'vm', 'host'):
            before = copy.deepcopy(self.before)
            items = copy.deepcopy(inspected)
            if cause == 'project':
                before['containers'][0]['project'] = self.project
            if cause == 'docker':
                items[0]['HostConfig']['PortBindings'] = {'5432/tcp': [{'HostPort': '55491'}]}
            with patch.object(producer, 'docker', return_value=json.dumps(items)), \
                    patch.object(producer.subprocess, 'run', return_value=occupied if cause == 'vm' else quiet), \
                    patch.object(producer.socket, 'socket') as probe, patch.object(producer.subprocess, 'Popen') as spawn:
                if cause == 'host':
                    probe.return_value.__enter__.return_value.bind.side_effect = OSError('MODEL_BUSY')
                with self.assertRaises(ValueError):
                    producer.preflight_ports(overlay, self.project, before)
                spawn.assert_not_called()

    def test_vm_port_parser_distinguishes_listen_and_rejects_bad_observation(self):
        text = 'sl local_address rem_address st\n0: 00000000:D8C3 00000000:0000 0A\n1: 00000000:D8C4 00000000:0000 01\n'
        self.assertEqual(producer.listening_ports(text), {55491})
        with self.assertRaises(ValueError):
            producer.listening_ports('unproven\n')
        with self.assertRaises(ValueError):
            producer.listening_ports('sl local_address rem_address st\ninvalid\n')

    def test_prepared_cli_sql_rejects_symlink_permissions_and_extra_links(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as name:
            root = Path(name).resolve()
            folder = root / 'supabase/migrations'
            folder.mkdir(parents=True)
            for path in (root, root / 'supabase', folder):
                path.chmod(0o700)
            path = folder / '20261014020000_ai_result_state.sql'
            path.write_bytes(b'begin; select 1; rollback;')
            path.chmod(0o600)
            relative = str(path.relative_to(root))
            self.assertEqual(producer.prepared_bytes(root, relative), path.read_bytes())
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                producer.prepared_bytes(root, relative)
            path.chmod(0o600)
            os.link(path, folder / 'extra.sql')
            with self.assertRaises(ValueError):
                producer.prepared_bytes(root, relative)
            (folder / 'extra.sql').unlink()
            path.rename(folder / 'original.sql')
            path.symlink_to(folder / 'original.sql')
            with self.assertRaises(ValueError):
                producer.prepared_bytes(root, relative)

    def test_pid_record_failure_or_spawn_signal_closes_only_the_issued_group(self):
        import tempfile
        class Issued:
            pid = 123456
            returncode = None
            def poll(self):
                return self.returncode
            def wait(self, timeout=None):
                self.returncode = -15
                return self.returncode
        for cause in ('pid_record', 'spawn_signal'):
            with tempfile.TemporaryDirectory() as name:
                root = Path(name)
                old_handlers = {sig: producer.signal.getsignal(sig) for sig in (producer.signal.SIGTERM, producer.signal.SIGINT)}
                issued = Issued()
                original_save = producer.save
                def saved(path, filename, raw):
                    if cause == 'pid_record' and filename == 'creation-process-private.json':
                        raise PermissionError('MODEL_DISK_FAILURE')
                    return original_save(path, filename, raw)
                def spawn(*args, **kwargs):
                    if cause == 'spawn_signal':
                        producer.signal.getsignal(producer.signal.SIGTERM)(producer.signal.SIGTERM, None)
                    return issued
                with patch.object(producer.subprocess, 'Popen', side_effect=spawn), \
                        patch.object(producer.os, 'killpg') as kill, patch.object(producer, 'save', side_effect=saved):
                    with self.assertRaises((PermissionError, ValueError)):
                        producer.wait_creation(['synthetic-command'], root, {})
                    kill.assert_called_once_with(issued.pid, producer.signal.SIGTERM)
                self.assertEqual({sig: producer.signal.getsignal(sig) for sig in old_handlers}, old_handlers)
                report = json.loads((root / 'creation-interrupted-private.json').read_text())
                self.assertEqual(report['pid'], issued.pid)
                self.assertEqual(report['commandExit'], -15)


if __name__ == '__main__':
    unittest.main()
