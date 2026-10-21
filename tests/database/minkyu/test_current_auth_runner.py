"""현재 source adapter의 검토·격리·실패 정리 계약. 실제 Docker/Auth 실행 없음."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[3] / 'tools/local/run_current_auth_source.py'


class RunnerTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('current_auth_runner', SOURCE)
        self.m = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.m)
        self.temp = tempfile.TemporaryDirectory(dir='/private/tmp'); self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name).resolve(); self.parent.chmod(0o700)
        self.prepared = self.parent / 'prepared'; self.prepared.mkdir(mode=0o700)
        self.execution = self.parent / 'yumidang-current-auth-1234abcd'
        self.pins = {name: 'a' * 64 for name in (self.m.SELF, self.m.PREP, *self.m.SUPPORT.values())}
        self.images = {name: 'sha256:' + str(i) * 64 for i, name in enumerate(self.m.ROLES, 1)}
        self.refs = {name: 'public.ecr.aws/supabase/' + ('gotrue:v2.196.0' if name == 'auth' else name + ':test') for name in self.m.ROLES}
        self.args = dict(decision_id='root-fixture', prepared_root=self.prepared, prepared_manifest_sha256='b' * 64,
            prepared_pins={self.m.PREP: 'a' * 64}, execution_root=self.execution, head='c' * 40,
            pins=self.pins, cli_path='/private/tmp/supabase', cli_sha256='d' * 64,
            images=self.images, image_refs=self.refs, host_limits={role: {'Memory': 0, 'MemorySwap': 0, 'NanoCpus': 0, 'PidsLimit': None} for role in self.m.ROLES})
        # 읽기 전용 실제 tracked guard의 inventory/cleanup/binary 로직 재사용.
        support_path = SOURCE.parents[2] / 'tools/local/prepare_auth_negative.py'
        spec = importlib.util.spec_from_file_location('current_fixture_negative', support_path)
        self.private = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.private)
        self.prep = SimpleNamespace(load_prepared_source=Mock(return_value={'target': {'projectId': 'jonghyun-backend100-1234abcd',
            'portBase': 57001, 'subnet': '10.253.101.0/24'}}))
        self.ai = SimpleNamespace()

    def review(self, **changes):
        return self.m.ReviewedCurrentAuthSource(**{**self.args, **changes})

    def runner(self):
        runner = self.m.CurrentAuthSource(self.review(), (self.prep, self.private, SimpleNamespace(), self.ai))
        runner.root.mkdir(mode=0o700, exist_ok=True)
        runner.phase = 'test'; runner.plan = self.prep.load_prepared_source.return_value['target']
        return runner

    def test_cli_is_not_an_execution_entrypoint(self):
        result = subprocess.run(['python3', str(SOURCE)], capture_output=True, check=True, text=True)
        value = json.loads(result.stdout)
        self.assertEqual(value['status'], 'NOT_RUN')
        self.assertEqual(value['actualAuth'], 'NOT_RUN')
        self.assertEqual(value['cliExecution'], 'DISABLED_USE_TYPED_ROOT_REVIEW')

    def test_typed_review_fixes_scope_images_and_operations(self):
        value = self.review().descriptor()
        self.assertEqual(value['images'], self.images)
        self.assertEqual(value['operations'], ['close', 'configure', 'start'])
        self.assertEqual(value['preparedPins'], self.args['prepared_pins'])
        self.assertEqual(value['cliVersion'], '2.116.0')
        with self.assertRaisesRegex(ValueError, 'TYPED_PHASE_REQUIRED'):
            self.m.run_phase(value, 'start')

    def test_review_rejects_old_target_pin_drift_and_scope_expansion(self):
        for change in [dict(execution_root=self.prepared), dict(head='bad'), dict(operations=['provision']),
                dict(images={**self.images, 'extra': self.images['db']}), dict(prepared_pins={'unknown': 'f' * 64}),
                dict(image_refs={**self.refs, 'auth': 'public.ecr.aws/supabase/gotrue:latest'})]:
            with self.assertRaises(ValueError):
                self.review(**change)

    def test_descriptor_is_immutable_after_external_dict_changes(self):
        review = self.review()
        self.images['db'] = 'changed'
        self.assertNotEqual(review.descriptor()['images']['db'], 'changed')

    def test_existing_restart_is_detected_even_if_running_config_unchanged(self):
        raw = ([{'Id': 'old', 'State': {'StartedAt': 'before'}, 'RestartCount': 0}], [], [])
        before = self.m.existing_incarnations(raw)
        self.m.assert_incarnations(before, raw)
        changed = copy.deepcopy(raw); changed[0][0]['State']['StartedAt'] = 'after'
        with self.assertRaisesRegex(ValueError, 'EXISTING_INCARNATION_CHANGED'):
            self.m.assert_incarnations(before, changed)

    def test_existing_project_and_overlapping_subnet_rejected_without_start(self):
        with self.assertRaisesRegex(ValueError, 'PROJECT_EXISTS'):
            self.m.assert_subnet_ports(([{'Name': '/supabase_db_project'}], [], []), 'project', '10.253.1.0/24', 57001)
        with self.assertRaisesRegex(ValueError, 'SUBNET_COLLISION'):
            self.m.assert_subnet_ports(([], [{'Name': 'other', 'IPAM': {'Config': [{'Subnet': '10.253.0.0/16'}]}}], []), 'project', '10.253.1.0/24', 57001)

    def test_port_probe_is_loopback_and_covers_full_bundle(self):
        socket = Mock(); socket.__enter__ = Mock(return_value=socket); socket.__exit__ = Mock()
        with patch.object(self.m.socket, 'socket', return_value=socket):
            self.m.assert_subnet_ports(([], [], []), 'project', '10.253.1.0/24', 57001)
        self.assertEqual(socket.bind.call_args_list[0].args[0], ('127.0.0.1', 57000))
        self.assertEqual(socket.bind.call_args_list[-1].args[0], ('127.0.0.1', 57009))
        self.assertEqual(socket.bind.call_count, 10)

    def test_memory_threshold_and_probe_cardinality(self):
        runner = self.runner()
        with patch.object(self.m.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'MemAvailable: 1048576 kB\n')):
            self.assertEqual(runner.memory(1048576), 1048576)
        with patch.object(self.m.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'MemAvailable: 786431 kB\n')):
            with self.assertRaisesRegex(ValueError, 'MEMORY_LOW'):
                runner.memory(786432)
        with patch.object(self.m.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'MemAvailable: 1048576 kB\nMemAvailable: 1048576 kB\n')):
            with self.assertRaisesRegex(ValueError, 'MEMORY_UNPROVEN'):
                runner.memory(1048576)

    def test_command_uses_exact_stdin_bytes_and_saves_evidence_before_failure(self):
        runner = self.runner(); runner.memory = Mock(); runner.healthy = Mock()
        saved = []
        runner.writer.save_bytes = lambda root, name, raw: saved.append((name, raw))
        runner.save = lambda name, value: saved.append((name, value))
        captured = {}
        child = Mock(); child.poll.return_value = 1; child.returncode = 1; child.wait.return_value = 1
        def popen(argv, **kw):
            captured['argv'] = argv; captured['stdin'] = kw['stdin'].read()
            kw['stderr'].write(b'synthetic failure')
            return child
        with patch.object(self.m.subprocess, 'Popen', side_effect=popen), patch.object(self.m, 'process_group_state', return_value={'state': 'absent', 'error': None}):
            with self.assertRaisesRegex(ValueError, 'COMMAND_FAILED'):
                runner.command(['fixed-command'], b'actual-reviewed-bytes')
        self.assertEqual(captured['stdin'], b'actual-reviewed-bytes')
        self.assertEqual(saved[-1][1]['stdinSha256'], self.m.sha(b'actual-reviewed-bytes'))
        self.assertTrue(saved[-1][1]['childClosed'])
        self.assertEqual(len(saved), 5)

    def test_child_monitor_failure_terminates_owned_child_before_cleanup(self):
        runner = self.runner(); runner.memory = Mock(); runner.healthy = Mock(side_effect=[None, ValueError('MEMORY_MONITOR_FAILED')])
        runner.writer.save_bytes = Mock(); runner.save = Mock()
        child = Mock(); child.pid = 12345; child.returncode = -15
        child.poll.return_value = None; child.wait.return_value = -15
        with patch.object(self.m.subprocess, 'Popen', return_value=child), patch.object(self.m.os, 'killpg') as kill, patch.object(self.m, 'process_group_state', side_effect=[{'state': 'present', 'error': None}, {'state': 'absent', 'error': None}]):
            with self.assertRaisesRegex(ValueError, 'MEMORY_MONITOR_FAILED'):
                runner.command(['fixed-command'])
        kill.assert_called_once_with(12345, self.m.signal.SIGTERM)
        self.assertFalse(runner.unclosed_child)
        self.assertEqual(runner.save.call_count, 3)

    def test_stop_refuses_any_mutation_while_child_closure_unproven(self):
        runner = self.runner(); runner.unclosed_child = True; runner.save = Mock(); runner.call = Mock()
        with self.assertRaisesRegex(ValueError, 'STOP_WITH_LIVE_CHILD_REFUSED'):
            runner.stop_owned('failure', monitor=False)
        runner.call.assert_not_called(); runner.save.assert_not_called()

    def test_phase_intent_checks_original_review_and_never_replays(self):
        runner = self.runner(); runner.source = Mock(); runner.read = Mock(return_value=runner.v)
        written = {}
        def save(name, value):
            if name in written:
                raise FileExistsError(name)
            written[name] = value
        runner.save = save
        runner.intent('configure')
        with self.assertRaises(FileExistsError):
            runner.intent('configure')
        runner.read.return_value = {'different': 'review'}
        with self.assertRaisesRegex(ValueError, 'REVIEW_BINDING_CHANGED'):
            runner.intent('close')

    def first_binding_fixture(self):
        runner = self.runner(); runner.save = Mock()
        project = runner.plan['projectId']; network_id = 'e' * 64; container_id = 'f' * 64
        labels = {'com.supabase.cli.project': project, 'yumidang.scope': self.m.SCOPE,
            'yumidang.review': self.m.sha(runner.review._sealed)}
        network = {'Id': network_id, 'Name': 'supabase_network_' + project, 'Labels': labels,
            'IPAM': {'Config': [{'Subnet': runner.plan['subnet']}]}}
        volume = {'Name': self.m.ROLES['db'] + project, 'Labels': {'com.supabase.cli.project': project}}
        container = {'Id': container_id, 'Name': '/' + self.m.ROLES['db'] + project,
            'Config': {'Labels': {'com.supabase.cli.project': project}}, 'RestartCount': 0,
            'HostConfig': {**runner.v['hostLimits']['db'], 'PortBindings': {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '57002'}]}},
            'NetworkSettings': {'Networks': {network['Name']: {'NetworkID': network_id}}},
            'Mounts': [{'Type': 'volume', 'Name': volume['Name']}]}
        owned = {'containers': [{'id': container_id, 'name': container['Name'][1:], 'image': runner.v['images']['db']}],
            'customNetworks': [{'id': network_id, 'name': network['Name']}], 'volumes': [{'name': volume['Name']}]}
        return runner, owned, ([container], [network], [volume])

    def test_failure_discovery_requires_review_label_network_and_own_mounts(self):
        runner, owned, raw = self.first_binding_fixture()
        runner.bind_first(owned, raw, partial=True)
        for change, code in [('review', 'NEW_NETWORK_BINDING'), ('network', 'EXACT_REVIEW_NETWORK'),
                ('memory', 'EXACT_HOST_LIMITS'), ('mount', 'OWNED_MOUNTS_ONLY'), ('port', 'NON_LOOPBACK_BINDING'),
                ('volume', 'NEW_VOLUME_BINDING')]:
            changed = copy.deepcopy(raw)
            if change == 'review':
                changed[1][0]['Labels']['yumidang.review'] = 'changed'
            elif change == 'network':
                next(iter(changed[0][0]['NetworkSettings']['Networks'].values()))['NetworkID'] = 'changed'
            elif change == 'memory':
                changed[0][0]['HostConfig']['Memory'] = 1
            elif change == 'mount':
                changed[0][0]['Mounts'] = [{'Type': 'bind', 'Source': '/Users/minkyu'}]
            elif change == 'volume':
                changed[2][0]['Labels']['com.supabase.cli.project'] = 'other'
            else:
                changed[0][0]['HostConfig']['PortBindings']['5432/tcp'][0]['HostIp'] = '0.0.0.0'
            with self.assertRaisesRegex(ValueError, code):
                runner.bind_first(owned, changed, partial=True)
        runner.save.reset_mock()
        with self.assertRaisesRegex(ValueError, 'REVIEW_NETWORK_UNPROVEN'):
            runner.bind_first(owned, (raw[0], [], raw[2]), partial=True)
        runner.save.assert_not_called()

    def test_unclosed_original_group_blocks_later_inventory_and_stop(self):
        runner = self.runner(); runner.unclosed_child = True
        runner.memory = Mock(); runner.save = Mock()
        with patch.object(self.m.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'PRIOR_PROCESS_GROUP_UNCLOSED'):
                runner.inventory(monitor=False)
            spawn.assert_not_called()
        self.assertTrue(runner.unclosed_child)
        with self.assertRaisesRegex(ValueError, 'STOP_WITH_LIVE_CHILD_REFUSED'):
            runner.stop_owned('failure', monitor=False)
        runner.save.assert_not_called()

    def test_missing_closure_after_durable_command_intent_also_blocks_recovery(self):
        runner = self.runner(); runner.root.mkdir(mode=0o700, exist_ok=True)
        (runner.root / 'start-command-1-intent.json').write_text('{"singleAttempt":true}')
        with patch.object(self.m.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'PRIOR_PROCESS_GROUP_UNCLOSED'):
                runner.inventory(monitor=False)
            spawn.assert_not_called()
        self.assertTrue(runner.unclosed_child)

    def test_new_phase_object_cannot_forget_persisted_unclosed_group(self):
        runner = self.runner(); runner.root.mkdir(mode=0o700, exist_ok=True)
        (runner.root / 'start-command-1-closure.json').write_text('{"closed":false,"groupAbsent":false}')
        runner.read = lambda name: json.loads((runner.root / name).read_text())
        with patch.object(self.m.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'PRIOR_PROCESS_GROUP_UNCLOSED'):
                runner.inventory(monitor=False)
            spawn.assert_not_called()
        self.assertTrue(runner.unclosed_child)
        runner.save = Mock()
        with self.assertRaisesRegex(ValueError, 'STOP_WITH_LIVE_CHILD_REFUSED'):
            runner.stop_owned('failure', monitor=False)
        runner.save.assert_not_called()

    def test_owned_mount_guard_allows_order_only_and_keeps_fields_and_duplicates(self):
        runner, _, raw = self.first_binding_fixture()
        container = raw[0][0]
        container.update(Image=runner.v['images']['db'], State={'StartedAt': 'first', 'Running': True,
            'Status': 'running', 'OOMKilled': False, 'Restarting': False})
        container['Mounts'] = [{'Type': 'volume', 'Name': raw[2][0]['Name'], 'Source': '/var/lib/one', 'RW': True, 'Propagation': 'rprivate'},
            {'Type': 'volume', 'Name': raw[2][0]['Name'], 'Source': '/var/lib/two', 'RW': False, 'Propagation': 'rprivate'}]
        baseline = self.private.metadata_summary(([], [], []))
        frozen = self.private.cleanup_inventory(baseline, self.private.metadata_summary(raw),
            {'source': {'project': runner.plan['projectId']}}, runner.v['images'])
        records = {'protected-resource-baseline.json': baseline, 'owned-first-inspection.json': copy.deepcopy(raw[0]),
            'owned-network-first-inspection.json': copy.deepcopy(raw[1]), 'owned-volume-first-inspection.json': copy.deepcopy(raw[2])}
        runner.read = lambda name: records[name]
        reordered = copy.deepcopy(raw); reordered[0][0]['Mounts'].reverse()
        runner.check_owned(frozen, reordered, running=True)
        for field, value in [('Source', '/different'), ('RW', False), ('Propagation', 'rshared')]:
            changed = copy.deepcopy(raw); changed[0][0]['Mounts'][0][field] = value
            with self.assertRaisesRegex(ValueError, 'OWNED_INCARNATION_CHANGED'):
                runner.check_owned(frozen, changed, running=True)
        changed = copy.deepcopy(raw); changed[0][0]['Mounts'].append(copy.deepcopy(changed[0][0]['Mounts'][0]))
        with self.assertRaisesRegex(ValueError, 'OWNED_INCARNATION_CHANGED'):
            runner.check_owned(frozen, changed, running=True)

    def test_leader_exit_with_term_ignoring_descendant_requires_kill_and_group_absence(self):
        child = Mock(); child.pid = 12345; child.wait.return_value = 0
        states = [{'state': 'present', 'error': None}, {'state': 'present', 'error': None}, {'state': 'absent', 'error': None}]
        with patch.object(self.m, 'process_group_state', side_effect=states), patch.object(self.m.os, 'killpg') as kill:
            proof = self.m.close_process_group(child, terminate=False, grace=.001)
        self.assertTrue(proof['closed'] and proof['leaderReaped'] and proof['groupAbsent'])
        self.assertEqual([call.args for call in kill.call_args_list], [(12345, self.m.signal.SIGTERM), (12345, self.m.signal.SIGKILL)])
        self.assertEqual(len(proof['observations']), 5)

    def test_group_query_permission_error_is_unknown_never_absent(self):
        with patch.object(self.m.os, 'killpg', side_effect=PermissionError()):
            self.assertEqual(self.m.process_group_state(12345), {'state': 'unknown', 'error': 'PermissionError'})
            child = Mock(); child.pid = 12345; child.wait.return_value = 0
            proof = self.m.close_process_group(child, terminate=False, grace=0)
        self.assertFalse(proof['closed']); self.assertFalse(proof['groupAbsent'])
        self.assertTrue(proof['leaderReaped'])

    def test_real_local_process_success_is_reaped_and_group_absent(self):
        # 외부 앱/Docker 없이 이 테스트가 생성한 짧은 자체 프로세스만 실행한다.
        child = subprocess.Popen(['python3', '-c', 'pass'], start_new_session=True)
        child.wait(timeout=3)
        proof = self.m.close_process_group(child, terminate=False, grace=.01)
        self.assertTrue(proof['closed'] and proof['leaderReaped'] and proof['groupAbsent'])

    def test_unclosed_descendant_keeps_raw_proof_and_refuses_docker_cleanup(self):
        runner = self.runner(); runner.memory = Mock(); runner.healthy = Mock()
        saved = {}; runner.writer.save_bytes = lambda root, name, value: saved.update({name: value})
        runner.save = lambda name, value: saved.update({name: value})
        child = Mock(); child.pid = 12345; child.poll.return_value = 0; child.returncode = 0
        proof = {'closed': False, 'leaderReaped': True, 'groupAbsent': False, 'observations': [{'state': 'present'}]}
        with patch.object(self.m.subprocess, 'Popen', return_value=child), patch.object(self.m, 'close_process_group', return_value=proof):
            with self.assertRaisesRegex(ValueError, 'CHILD_CLOSURE_UNPROVEN'):
                runner.command(['fixed-command'])
        self.assertEqual(saved['test-command-1-closure.json'], proof)
        self.assertIn('test-command-1-stdout.json', saved)
        self.assertIn('test-command-1-stderr.json', saved)
        self.assertFalse(saved['test-command-1-result.json']['childClosed'])
        runner.call = Mock()
        with self.assertRaisesRegex(ValueError, 'STOP_WITH_LIVE_CHILD_REFUSED'):
            runner.stop_owned('failure', monitor=False)
        runner.call.assert_not_called()

    def captured_command_fixture(self, argv, output):
        runner = self.runner(); runner.memory = Mock(); runner.healthy = Mock()
        records = {}; sizes = []
        def private_save(root, name, value):
            self.assertLessEqual(len(value), 2 * 1024**2)
            parsed = json.loads(value)
            sizes.append(len(parsed.get('rawHex', '')) // 2)
            records[name] = {key: val for key, val in parsed.items() if key != 'rawHex'}
        runner.writer.save_bytes = private_save
        runner.save = lambda name, value: records.update({name: value})
        child = Mock(); child.pid = 12345; child.poll.return_value = 0; child.returncode = 0; child.wait.return_value = 0
        def popen(args, **kw):
            kw['stdout'].write(output)
            return child
        def invoke():
            with patch.object(self.m.subprocess, 'Popen', side_effect=popen), patch.object(self.m, 'process_group_state', return_value={'state': 'absent', 'error': None}):
                return runner.command(argv)
        return runner, records, sizes, invoke

    def test_four_megabyte_read_only_inventory_accepts_whole_bytes(self):
        raw = b'x' * 4386312
        argv = ['docker', '--host', self.m.HOST, 'inspect', 'a' * 64]
        _, records, sizes, invoke = self.captured_command_fixture(argv, raw)
        self.assertEqual(invoke(), raw)
        result = records['test-command-1-result.json']
        self.assertEqual(result['stdoutSha256'], self.m.sha(raw))
        self.assertEqual(result['stdout']['totalBytes'], len(raw))
        self.assertEqual(result['stdout']['capturedBytes'], len(raw))
        self.assertEqual(sum(sizes), len(raw))
        self.assertTrue(all(size <= self.m.BASE_CAPTURE_LIMIT for size in sizes))
        self.assertEqual(records['test-command-1-intent.json']['stdoutLimit'], 16 * 1024**2)

    def test_inventory_limit_overflow_saves_bounded_raw_and_hashes_entire_output(self):
        raw = b'x' * (self.m.INVENTORY_CAPTURE_LIMIT + 1)
        argv = ['docker', '--host', self.m.HOST, 'network', 'inspect', 'a' * 64]
        _, records, sizes, invoke = self.captured_command_fixture(argv, raw)
        with self.assertRaisesRegex(ValueError, 'COMMAND_OUTPUT_LIMIT'):
            invoke()
        result = records['test-command-1-result.json']
        self.assertEqual(result['stdoutSha256'], self.m.sha(raw))
        self.assertEqual(result['stdout']['totalBytes'], len(raw))
        self.assertEqual(sum(sizes), self.m.INVENTORY_CAPTURE_LIMIT)
        self.assertTrue(result['childClosed'])
        self.assertIn('test-command-1-closure.json', records)

    def test_no_other_command_or_stdin_expands_the_half_megabyte_limit(self):
        prefix = ['docker', '--host', self.m.HOST]
        for args in [['exec', 'a' * 64, 'psql'], ['inspect', '--format', '{{json .}}', 'a' * 64],
                ['network', 'create', 'name'], ['volume', 'inspect', '--format'], ['start', 'a' * 64]]:
            self.assertEqual(self.m.output_limits(prefix + args), (512 * 1024, 512 * 1024))
        for args in [['inspect', 'a' * 64], ['network', 'inspect', 'a' * 64], ['volume', 'inspect', 'supabase_db_fixture']]:
            self.assertEqual(self.m.output_limits(prefix + args), (16 * 1024**2, 512 * 1024))
            self.assertEqual(self.m.output_limits(prefix + args, b'unexpected stdin'), (512 * 1024, 512 * 1024))
        self.assertEqual(self.m.output_limits(['docker', '--host', 'unix:///foreign', 'inspect', 'a' * 64]), (512 * 1024, 512 * 1024))
        raw = b'x' * (512 * 1024 + 1)
        _, records, sizes, invoke = self.captured_command_fixture(prefix + ['exec', 'a' * 64, 'psql'], raw)
        with self.assertRaisesRegex(ValueError, 'COMMAND_OUTPUT_LIMIT'):
            invoke()
        self.assertEqual(sum(sizes), 512 * 1024)
        self.assertEqual(records['test-command-1-result.json']['stdoutSha256'], self.m.sha(raw))

    def test_cli_home_is_new_private_scope_and_home_is_never_redefined(self):
        runner = self.runner()
        ambient = {'HOME': '/Users/minkyu', 'PATH': '/fixed/bin', 'LANG': 'ko_KR.UTF-8',
            'SUPABASE_HOME': '/Users/minkyu/.supabase', 'SUPABASE_ACCESS_TOKEN': 'private-not-inherited',
            'SUPABASE_PROFILE': '/Users/minkyu/private-profile', 'SUPABASE_TELEMETRY_DISABLED': 'false',
            'DO_NOT_TRACK': '0', 'DOCKER_HOST': 'unix:///foreign', 'HTTP_PROXY': 'http://ambient',
            'GOTRUE_JWT_EXP': '1', 'SUPABASE_AUTH_JWT_EXP': '1', 'OTHER_SECRET': 'not-inherited'}
        with patch.dict(os.environ, ambient, clear=True):
            env = runner.cli_env()
        self.assertEqual(env['HOME'], ambient['HOME'])
        self.assertEqual(env['SUPABASE_HOME'], str(runner.root / 'cli-home'))
        self.assertEqual(env['SUPABASE_TELEMETRY_DISABLED'], '1')
        self.assertEqual(env['DO_NOT_TRACK'], '1')
        self.assertEqual(env['DOCKER_HOST'], self.m.HOST)
        self.assertEqual(set(env), {'HOME','PATH','LANG','DOCKER_HOST','DOCKER_CONTEXT','SUPABASE_HOME','SUPABASE_TELEMETRY_DISABLED','DO_NOT_TRACK'})
        self.assertEqual((runner.root / 'cli-home').stat().st_mode & 0o777, 0o700)
        self.assertEqual(runner.cli_home(), str(runner.root / 'cli-home'))

    def test_cli_home_rejects_public_mode_symlink_and_non_directory(self):
        runner = self.runner(); home = runner.root / 'cli-home'
        home.mkdir(mode=0o755)
        with self.assertRaisesRegex(ValueError, 'CLI_HOME_PRIVATE'):
            runner.cli_env()
        home.rmdir(); home.symlink_to(self.prepared, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'CLI_HOME_PRIVATE'):
            runner.cli_env()
        home.unlink(); home.write_bytes(b'not a directory')
        with self.assertRaisesRegex(ValueError, 'CLI_HOME_PRIVATE'):
            runner.cli_env()

    def test_cli_home_rejects_nonprivate_execution_ancestor(self):
        runner = self.runner(); self.parent.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'CLI_HOME_PRIVATE_ANCESTOR'):
            runner.cli_env()
        self.assertFalse((runner.root / 'cli-home').exists())

    def test_actual_kernel_history_has_no_121_override_in_adapter(self):
        raw = SOURCE.read_text()
        self.assertNotIn('==121', raw)
        self.assertNotIn("replace('121'", raw)
        self.assertIn('len(target[\'versions\'])', raw)


if __name__ == '__main__':
    unittest.main()
