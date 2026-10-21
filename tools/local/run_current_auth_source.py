#!/usr/bin/env python3
"""검토된 현행 Auth 새 4역할 source start/configure/close adapter. CLI 기본 NOT_RUN.

JSON/플래그로 실행하지 않는다. root가 코드에서 ReviewedCurrentAuthSource를 조립하고
run_phase를 호출한다. Auth6 발급은 별도 기존 signed kernel 연결점까지만 제공한다.
"""
from contextlib import contextmanager
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
SELF = 'tools/local/run_current_auth_source.py'
PREP = 'tools/local/prepare_current_auth_source.py'
SUPPORT = {'run_database_tests': 'tools/local/run_database_tests.py',
    'isolated_ai_contracts': 'tests/integration/jonghyun/isolated_ai_contracts.py',
    'prepare_auth_negative': 'tools/local/prepare_auth_negative.py'}
HOST = 'unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock'
DAEMON = '879401ec-e2b7-4ad8-9915-0a16ea74e3f5'
CONTEXT = 'colima-yumidang-minkyu'
ROLES = {'db': 'supabase_db_', 'auth': 'supabase_auth_', 'rest': 'supabase_rest_', 'gateway': 'supabase_kong_'}
EXCLUDE = 'realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor'
SCOPE = 'REVIEWED_CURRENT_AUTH_FOUR_NEW_SERVICES_ONLY'
NETWORK_OPTIONS = {'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1'}


def need(ok, code):
    if not ok:
        raise ValueError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], stderr=subprocess.DEVNULL, timeout=15)


def checked_sources(value):
    need(git('rev-parse', 'HEAD').decode().strip() == value['head'], 'SOURCE_HEAD_CHANGED')
    captured = {}
    for relative, pin in value['pins'].items():
        path = ROOT / relative
        need(path.resolve() == path and path.is_file() and not path.is_symlink(), 'SOURCE_PATH')
        raw = path.read_bytes()
        need(sha(raw) == pin and git('show', value['head'] + ':' + relative) == raw, 'SOURCE_NOT_COMMITTED')
        captured[relative] = raw
    return captured


class ReviewedCurrentAuthSource:
    """정확한 새 source와 실행 범위를 root 검토 코드가 고정한다. JSON은 실행 권한이 아니다."""
    def __init__(self, *, decision_id, prepared_root, prepared_manifest_sha256, prepared_pins,
                 execution_root, head, pins, cli_path, cli_sha256, images, image_refs, host_limits,
                 operations=('start', 'configure', 'close')):
        need(type(decision_id) is str and re.fullmatch('[A-Za-z0-9_.:-]{1,128}', decision_id), 'DECISION')
        need(type(head) is str and re.fullmatch('[a-f0-9]{40}', head), 'HEAD')
        need(type(pins) is dict and {SELF, PREP, *SUPPORT.values()} <= set(pins), 'RUNTIME_PIN_SET')
        need(type(prepared_pins) is dict and prepared_pins.items() <= pins.items(), 'PREPARED_PIN_SUBSET')
        need(all(type(k) is str and not Path(k).is_absolute() and '..' not in Path(k).parts
                 and type(v) is str and re.fullmatch('[a-f0-9]{64}', v) for k, v in pins.items()), 'PIN_FORMAT')
        need(all(type(v) is str and re.fullmatch('[a-f0-9]{64}', v) for v in (prepared_manifest_sha256, cli_sha256)), 'SHA')
        prepared, execution = Path(prepared_root), Path(execution_root)
        need(all(p.is_absolute() and p.resolve() == p and p.is_relative_to(Path('/private/tmp')) for p in (prepared, execution))
             and prepared != execution and not prepared.is_relative_to(execution) and not execution.is_relative_to(prepared)
             and not execution.is_relative_to(ROOT) and not ROOT.is_relative_to(execution)
             and re.fullmatch('yumidang-current-auth-[a-f0-9]{8,32}', execution.name), 'NEW_EXECUTION_PATH')
        binary = Path(cli_path)
        need(binary.is_absolute() and binary.resolve() == binary and binary.name == 'supabase', 'CLI_PATH')
        need(type(images) is dict and type(image_refs) is dict and set(images) == set(image_refs) == set(ROLES)
             and all(type(x) is str and re.fullmatch('sha256:[a-f0-9]{64}', x) for x in images.values())
             and all(type(x) is str and re.fullmatch('public[.]ecr[.]aws/supabase/[a-z0-9._/-]+:[A-Za-z0-9._-]+', x) for x in image_refs.values())
             and image_refs['auth'].endswith('/gotrue:v2.196.0'), 'IMAGES')
        need(type(host_limits) is dict and set(host_limits) == set(ROLES), 'HOST_LIMIT_ROLES')
        for limits in host_limits.values():
            need(type(limits) is dict and set(limits) == {'Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit'}
                 and all(type(limits[k]) is int and limits[k] >= 0 for k in ('Memory', 'NanoCpus'))
                 and type(limits['MemorySwap']) is int and limits['MemorySwap'] >= -1
                 and (limits['PidsLimit'] is None or type(limits['PidsLimit']) is int and limits['PidsLimit'] >= -1), 'HOST_LIMITS')
        need(set(operations) <= {'start', 'configure', 'close'}, 'OPERATIONS')
        self._sealed = canonical(dict(scope=SCOPE, decisionId=decision_id, preparedRoot=str(prepared),
            preparedManifestSha256=prepared_manifest_sha256, preparedPins=prepared_pins,
            root=str(execution), head=head, pins=pins, cliPath=str(binary), cliSha256=cli_sha256,
            cliVersion='2.116.0', images=images, imageRefs=image_refs, hostLimits=host_limits, operations=sorted(set(operations))))

    def descriptor(self):
        return json.loads(self._sealed)


@contextmanager
def runtime_support(review):
    value = review.descriptor()
    captured = checked_sources(value)
    spec = importlib.util.spec_from_loader('current_auth_preparation', loader=None)
    prep = importlib.util.module_from_spec(spec)
    prep.__file__ = str(ROOT / PREP)
    exec(compile(captured[PREP], prep.__file__, 'exec'), prep.__dict__)
    previous = {name: sys.modules.get(name) for name in SUPPORT}
    old_path = list(sys.path)
    try:
        # policy의 늦은 imports를 포함해 실행 operation 전체에 고정 helper 바인딩을 유지한다.
        with prep.load_support(ROOT, captured):
            modules = {}
            for name, relative in SUPPORT.items():
                module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader=None))
                module.__file__ = str(ROOT / relative)
                sys.modules[name] = module
                exec(compile(captured[relative], module.__file__, 'exec'), module.__dict__)
                modules[name] = module
            ai = modules['isolated_ai_contracts']
            signed = ai.signed_source_pins()
            need(signed.items() <= value['pins'].items(), 'SIGNED_SOURCE_SUBSET')
            need(set(value['pins']) == {SELF, PREP, *SUPPORT.values(), *value['preparedPins'], *signed}, 'EXACT_RUNTIME_SOURCE_SET')
            yield prep, modules['prepare_auth_negative'], modules['run_database_tests'], ai
    finally:
        sys.path[:] = old_path
        for name, old in previous.items():
            if old is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = old


def check_owned_network(first, now, details, owned_ids):
    """중지한 자기 endpoint의 IP 반환만 허용하고 원 관측을 변경하지 않는다."""
    need(type(now) is dict and {k: v for k, v in now.items() if k not in ('Containers', 'Status')}
         == {k: v for k, v in first.items() if k not in ('Containers', 'Status')}, 'OWNED_NETWORK_CHANGED')
    endpoints = first.get('Containers')
    need(type(endpoints) is dict and set(endpoints) <= owned_ids and owned_ids <= set(details)
         and all(type(details[i].get('State', {}).get('Running')) is bool for i in owned_ids), 'OWNED_NETWORK_ENDPOINT_BINDING')
    live = {i for i in owned_ids if details[i]['State']['Running']}
    need(live <= set(endpoints) and now.get('Containers') == {i: endpoints[i] for i in live}, 'OWNED_NETWORK_ENDPOINT_CHANGED')
    released = len(set(endpoints) - live)
    expected = json.loads(canonical(first.get('Status')))
    need(type(expected) is dict and type(expected.get('IPAM')) is dict
         and type(expected['IPAM'].get('Subnets')) is dict, 'OWNED_NETWORK_STATUS_EVIDENCE')
    subnets = [entry.get('Subnet') for entry in first.get('IPAM', {}).get('Config', [])]
    need(len(subnets) == 1 and type(subnets[0]) is str and set(expected['IPAM']['Subnets']) == set(subnets), 'OWNED_NETWORK_STATUS_SUBNET')
    stats = expected['IPAM']['Subnets'][subnets[0]]
    need(type(stats) is dict and all(type(stats.get(k)) is int and stats[k] >= 0
         for k in ('IPsInUse', 'DynamicIPsAvailable')) and stats['IPsInUse'] >= released, 'OWNED_NETWORK_STATUS_COUNTER')
    stats['IPsInUse'] -= released
    stats['DynamicIPsAvailable'] += released
    current_status = now.get('Status')
    need(type(current_status) is dict and type(current_status.get('IPAM')) is dict
         and type(current_status['IPAM'].get('Subnets')) is dict
         and set(current_status['IPAM']['Subnets']) == set(subnets), 'OWNED_NETWORK_STATUS_EVIDENCE')
    current_stats = current_status['IPAM']['Subnets'][subnets[0]]
    need(type(current_stats) is dict and all(type(current_stats.get(k)) is int and current_stats[k] >= 0
         for k in ('IPsInUse', 'DynamicIPsAvailable')), 'OWNED_NETWORK_STATUS_COUNTER')
    need(current_status == expected, 'OWNED_NETWORK_STATUS_CHANGED')


def existing_incarnations(raw):
    return {x['Id']: {'startedAt': x['State']['StartedAt'], 'restartCount': x['RestartCount']}
            for x in raw[0]}


def assert_incarnations(before, raw):
    current = existing_incarnations(raw)
    need(all(current.get(k) == v for k, v in before.items()), 'EXISTING_INCARNATION_CHANGED')


def assert_subnet_ports(raw, project, subnet, port):
    need(not any(x['Name'].removeprefix('/').endswith(project) for group in raw for x in group), 'PROJECT_EXISTS')
    wanted = ipaddress.ip_network(subnet)
    for network in raw[1]:
        for entry in network.get('IPAM', {}).get('Config') or []:
            if entry.get('Subnet'):
                need(not wanted.overlaps(ipaddress.ip_network(entry['Subnet'], strict=False)), 'SUBNET_COLLISION')
    for number in range(port - 1, port + 9):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', number))


BASE_CAPTURE_LIMIT = 512 * 1024
INVENTORY_CAPTURE_LIMIT = 16 * 1024**2


def output_limits(argv, data=None):
    """고정 socket의 읽기 전용 inspect 세 형태만 기존 대규모 inventory 상한을 사용한다."""
    if data is None and argv[:3] == ['docker', '--host', HOST]:
        args = argv[3:]
        ids = None
        if len(args) >= 2 and args[0] == 'inspect':
            ids = args[1:]
        elif len(args) >= 3 and args[:2] == ['network', 'inspect']:
            ids = args[2:]
        if ids and all(type(value) is str and re.fullmatch('[a-f0-9]{64}', value) for value in ids):
            return INVENTORY_CAPTURE_LIMIT, BASE_CAPTURE_LIMIT
        if len(args) >= 3 and args[:2] == ['volume', 'inspect'] and all(
                type(value) is str and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value) for value in args[2:]):
            return INVENTORY_CAPTURE_LIMIT, BASE_CAPTURE_LIMIT
    return BASE_CAPTURE_LIMIT, BASE_CAPTURE_LIMIT


def capture_stream(stream, limit):
    """관측한 전체 파일 extent를 해시하고 보존 원문은 상한까지만 유지한다."""
    stream.flush()
    size = os.fstat(stream.fileno()).st_size
    stream.seek(0)
    digest = hashlib.sha256(); captured = bytearray(); remaining = size
    while remaining:
        raw = stream.read(min(65536, remaining))
        need(raw, 'OUTPUT_EXTENT_CHANGED')
        digest.update(raw); remaining -= len(raw)
        if len(captured) < limit:
            captured.extend(raw[:limit - len(captured)])
    stable = os.fstat(stream.fileno()).st_size == size
    return bytes(captured), {'totalBytes': size, 'capturedBytes': len(captured),
        'sha256': digest.hexdigest(), 'extentStable': stable, 'limit': limit}


def mount_bag(mounts):
    """전체 항목과 중복 개수를 보존하고 inspect 배열 순서만 제거한다."""
    need(type(mounts) is list and all(type(item) is dict for item in mounts), 'MOUNT_BAG_SHAPE')
    return sorted(canonical(item) for item in mounts)


def process_group_state(pgid):
    try:
        os.killpg(pgid, 0)
        return {'state': 'present', 'error': None}
    except ProcessLookupError:
        return {'state': 'absent', 'error': None}
    except OSError as error:
        return {'state': 'unknown', 'error': type(error).__name__}


def close_process_group(child, *, terminate, grace=3):
    """leader 회수와 같은 PG 전체 부재를 모두 증명한다. 조회 오류는 부재가 아니다."""
    observations = []
    leader_reaped = False
    def observe():
        nonlocal leader_reaped
        try:
            result = child.wait(timeout=0)
            leader_reaped = type(result) is int
        except subprocess.TimeoutExpired:
            leader_reaped = False
        except OSError as error:
            observations.append({'action': 'reap', 'error': type(error).__name__})
            leader_reaped = False
        state = process_group_state(child.pid)
        observations.append({'action': 'observe', 'leaderReaped': leader_reaped, **state})
        return leader_reaped and state['state'] == 'absent'
    def send(sig):
        try:
            os.killpg(child.pid, sig)
            observations.append({'action': 'signal', 'signal': int(sig), 'error': None})
        except ProcessLookupError:
            observations.append({'action': 'signal', 'signal': int(sig), 'error': 'ProcessLookupError'})
        except OSError as error:
            observations.append({'action': 'signal', 'signal': int(sig), 'error': type(error).__name__})
    closed = observe()
    if not closed:
        # 정상 leader 종료도 남아 있는 자손 PG가 있으면 같은 정리 절차를 거친다.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            send(sig)
            deadline = time.monotonic() + grace
            while time.monotonic() < deadline:
                if observe():
                    closed = True
                    break
                time.sleep(.05)
            if closed:
                break
    last = next((item for item in reversed(observations) if item['action'] == 'observe'), {})
    return {'closed': closed, 'leaderReaped': leader_reaped, 'groupAbsent': last.get('state') == 'absent',
        'pgid': child.pid, 'terminationRequested': terminate, 'observations': observations}


class CurrentAuthSource:
    def __init__(self, review, support):
        need(type(review) is ReviewedCurrentAuthSource, 'TYPED_REVIEW_REQUIRED')
        self.review = review
        self.v = review.descriptor()
        self.prep, self.private, self.guard, self.ai = support
        self.root = Path(self.v['root'])
        self.writer = object.__new__(self.private.FixedPair)
        self.writer.ai = self.ai
        self.samples, self.failures = [], []
        self.done = threading.Event()
        self.thread = None
        self.sequence = 0
        self.phase = 'unassigned'
        self.started_at = None
        self.unclosed_child = False
        self.phase_started = False
        self.last_memory_observation = None

    def save(self, name, value):
        return self.writer.save(self.root, name, value)

    def read(self, name):
        return self.writer.read(self.root, name)

    def source(self):
        checked_sources(self.v)
        return self.prep.load_prepared_source(ROOT, Path(self.v['preparedRoot']),
            manifest_sha256=self.v['preparedManifestSha256'], head=self.v['head'], pins=self.v['preparedPins'])

    def memory(self, minimum):
        began = time.monotonic()
        def observation(returncode, stdout, stderr, exception=None):
            stdout = stdout if type(stdout) is bytes else b''
            stderr = stderr if type(stderr) is bytes else b''
            self.last_memory_observation = {'method': 'COLIMA_PROC_MEMINFO', 'returnCode': returncode,
                'elapsedSeconds': time.monotonic() - began, 'exceptionType': exception,
                'stdoutHex': stdout[:65536].hex(), 'stderrHex': stderr[:16384].hex(),
                'stdoutBytes': len(stdout), 'stderrBytes': len(stderr),
                'stdoutSha256': sha(stdout), 'stderrSha256': sha(stderr),
                'stdoutComplete': len(stdout) <= 65536, 'stderrComplete': len(stderr) <= 16384}
        try:
            p = subprocess.run(['colima', 'ssh', '--profile', 'yumidang-minkyu', '--', 'cat', '/proc/meminfo'], capture_output=True, timeout=3)
        except BaseException as error:
            observation(None, getattr(error, 'stdout', None), getattr(error, 'stderr', None), type(error).__name__)
            raise
        observation(p.returncode, p.stdout, getattr(p, 'stderr', b''))
        found = re.findall(rb'^MemAvailable:\s+([0-9]+) kB$', p.stdout, re.M)
        need(p.returncode == 0 and len(found) == 1 and time.monotonic() - began <= 3, 'MEMORY_UNPROVEN')
        n = int(found[0]); self.samples.append(n)
        need(n >= minimum, 'MEMORY_LOW')
        return n

    def healthy(self):
        need(not self.failures and not self.done.is_set(), 'MEMORY_MONITOR_FAILED')

    def monitor(self):
        while not self.done.is_set():
            began = time.monotonic()
            try:
                self.memory(786432)
            except BaseException:
                self.failures.append('MEMORY_MONITOR_FAILED')
                return
            self.done.wait(max(0, began + 3 - time.monotonic()))

    def start_monitor(self):
        self.memory(1048576)
        self.thread = threading.Thread(target=self.monitor, daemon=True)
        self.thread.start()

    def command(self, argv, data=None, timeout=30, monitor=True):
        # 이전 PG 미종결은 새 inventory 성공으로 해제할 수 없다. 새 phase 객체도 원 증거를 따른다.
        need(not self.unclosed_child, 'PRIOR_PROCESS_GROUP_UNCLOSED')
        if self.root.exists():
            evidence_names = {path.name for path in self.root.glob('*-command-*-closure.json')}
            for intent in self.root.glob('*-command-*-intent.json'):
                closure_name = intent.name.removesuffix('-intent.json') + '-closure.json'
                if not (self.root / closure_name).exists():
                    self.unclosed_child = True
                    raise ValueError('PRIOR_PROCESS_GROUP_UNCLOSED')
                evidence_names.add(closure_name)
            for name in evidence_names:
                proof = self.read(name)
                if proof.get('closed') is not True:
                    self.unclosed_child = True
                    raise ValueError('PRIOR_PROCESS_GROUP_UNCLOSED')
        if monitor:
            self.healthy(); self.memory(786432)
        stdout_limit, stderr_limit = output_limits(argv, data)
        self.sequence += 1
        self.save(self.phase + '-command-' + str(self.sequence) + '-intent.json',
            {'singleAttempt': True, 'argvSha256': sha(canonical(argv)), 'stdinSha256': None if data is None else sha(data),
             'stdoutLimit': stdout_limit, 'stderrLimit': stderr_limit, 'closureRequiredBeforeNextCommand': True})
        with tempfile.TemporaryFile() as inp, tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            if data is not None:
                inp.write(data); inp.seek(0)
            child = subprocess.Popen(argv, stdin=inp, stdout=out, stderr=err, start_new_session=True, env=self.cli_env())
            self.unclosed_child = True
            start = time.monotonic(); failure = None
            try:
                while child.poll() is None:
                    if monitor:
                        self.healthy()
                    need(time.monotonic() - start < timeout, 'COMMAND_TIMEOUT')
                    need(out.tell() <= stdout_limit and err.tell() <= stderr_limit, 'COMMAND_OUTPUT_LIMIT')
                    time.sleep(.1)
            except BaseException as exc:
                failure = exc
            closure = close_process_group(child, terminate=failure is not None)
            self.unclosed_child = not closure['closed']
            stdout, stdout_proof = capture_stream(out, stdout_limit)
            stderr, stderr_proof = capture_stream(err, stderr_limit)
        # 원문은 개인 파일에만 보존한다. 예외에는 upstream/토큰을 복사하지 않는다.
        self.save_output('stdout', stdout, stdout_proof)
        self.save_output('stderr', stderr, stderr_proof)
        self.save(self.phase + '-command-' + str(self.sequence) + '-closure.json', closure)
        self.save(self.phase + '-command-' + str(self.sequence) + '-result.json', {'exit': child.returncode,
            'childClosed': closure['closed'], 'leaderReaped': closure['leaderReaped'], 'groupAbsent': closure['groupAbsent'], 'stdinSha256': None if data is None else sha(data),
            'stdoutSha256': stdout_proof['sha256'], 'stderrSha256': stderr_proof['sha256'],
            'stdout': stdout_proof, 'stderr': stderr_proof})
        need(closure['closed'], 'CHILD_CLOSURE_UNPROVEN')
        if failure is not None:
            raise failure
        need(stdout_proof['extentStable'] and stderr_proof['extentStable'], 'OUTPUT_EXTENT_CHANGED')
        need(stdout_proof['totalBytes'] <= stdout_limit and stderr_proof['totalBytes'] <= stderr_limit, 'COMMAND_OUTPUT_LIMIT')
        need(child.returncode == 0, 'COMMAND_FAILED')
        return stdout

    def save_output(self, kind, raw, proof):
        prefix = self.phase + '-command-' + str(self.sequence) + '-' + kind
        if len(raw) <= BASE_CAPTURE_LIMIT:
            self.writer.save_bytes(self.root, prefix + '.json', canonical({'rawHex': raw.hex(), **proof}))
            return
        chunks = []
        for index in range(0, len(raw), BASE_CAPTURE_LIMIT):
            part = raw[index:index + BASE_CAPTURE_LIMIT]
            name = prefix + '-part-' + str(index // BASE_CAPTURE_LIMIT + 1) + '.json'
            self.writer.save_bytes(self.root, name, canonical({'rawHex': part.hex()}))
            chunks.append({'name': name, 'rawSha256': sha(part), 'rawBytes': len(part)})
        self.save(prefix + '.json', {**proof, 'chunks': chunks})

    def cli_home(self):
        # 공식 CLI docs/supabase-home.md: 전역 CLI 상태는 SUPABASE_HOME 기준이다.
        # 사용자 HOME는 변경하지 않고 새 실행 root의 개인 하위 디렉터리만 사용한다.
        need(self.root.is_absolute() and self.root.resolve() == self.root, 'CLI_HOME_ROOT_PATH')
        for directory in (self.root, *self.root.parents):
            if directory == Path('/private/tmp'):
                break
            info = directory.lstat()
            need(not directory.is_symlink() and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
                 and stat.S_IMODE(info.st_mode) == 0o700, 'CLI_HOME_PRIVATE_ANCESTOR')
        else:
            raise ValueError('CLI_HOME_BOUNDARY')
        parent = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            parent_info = os.fstat(parent)
            need(parent_info.st_uid == os.getuid() and stat.S_IMODE(parent_info.st_mode) == 0o700, 'CLI_HOME_PARENT')
            try:
                os.mkdir('cli-home', 0o700, dir_fd=parent)
            except FileExistsError:
                pass
            before = os.stat('cli-home', dir_fd=parent, follow_symlinks=False)
            need(stat.S_ISDIR(before.st_mode) and before.st_uid == os.getuid()
                 and stat.S_IMODE(before.st_mode) == 0o700, 'CLI_HOME_PRIVATE')
            child = os.open('cli-home', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                opened = os.fstat(child)
                signature = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_uid)
                path = self.root / 'cli-home'
                need(signature(before) == signature(opened) == signature(path.lstat())
                     and path.resolve() == path and signature(parent_info) == signature(self.root.lstat()), 'CLI_HOME_CHANGED')
            finally:
                os.close(child)
        finally:
            os.close(parent)
        return str(self.root / 'cli-home')

    def cli_env(self):
        env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE')}
        # 공식 docs/analytics.md의 env opt-out 값은 문자열 1이다.
        env.update(DOCKER_HOST=HOST, DOCKER_CONTEXT=CONTEXT, SUPABASE_HOME=self.cli_home(),
                   SUPABASE_TELEMETRY_DISABLED='1', DO_NOT_TRACK='1')
        return env

    def call(self, args, data=None, timeout=25, monitor=True):
        raw = None if data is None else data.encode() if isinstance(data, str) else data
        return self.command(['docker', '--host', HOST, *args], raw, timeout, monitor).decode().strip()

    def inventory(self, monitor=True):
        need(self.call(['context', 'inspect', CONTEXT, '--format', '{{.Endpoints.docker.Host}}'], monitor=monitor) == HOST, 'SOCKET_CHANGED')
        need(self.call(['info', '--format', '{{.ID}}'], monitor=monitor) == DAEMON, 'DAEMON_CHANGED')
        holder = object.__new__(self.private.FixedPair)
        holder.call = lambda args, data=None, timeout=25: self.call(args, data, timeout, monitor)
        holder.value = {'daemonId': DAEMON}
        return self.private.FixedPair.inventory(holder)

    def binary(self):
        self.private.FixedPair.binary(self.writer, self.v['cliPath'], self.v['cliSha256'], 'supabase')
        version = self.command([self.v['cliPath'], '--version'], timeout=10).decode().strip()
        need(version == self.v['cliVersion'], 'CLI_VERSION')

    def baseline_guard(self, monitor=True):
        raw = self.inventory(monitor)
        before = self.read('protected-resource-baseline.json')
        current = self.private.metadata_summary(raw)
        # cleanup_inventory도 원본 컨테이너/네트워크/volume 전체 metadata를 검사한다.
        owned = self.private.cleanup_inventory(before, current, {'source': {'project': self.plan['projectId']}}, self.v['images'])
        assert_incarnations(self.read('existing-incarnations.json'), raw)
        return raw, owned

    def check_owned(self, frozen, raw, running=None):
        current = self.private.cleanup_inventory(self.read('protected-resource-baseline.json'), self.private.metadata_summary(raw),
            {'source': {'project': self.plan['projectId']}}, self.v['images'])
        self.private.fixed_created_ids(current, frozen)
        details = {x['Id']: x for x in raw[0]}
        first_networks = self.read('owned-network-first-inspection.json')
        expected_network_ids = {item['Id'] for item in first_networks}
        for first in first_networks:
            now = next((item for item in raw[1] if item['Id'] == first['Id']), None)
            check_owned_network(first, now, details, {row['id'] for row in frozen['containers']})
        for first in self.read('owned-volume-first-inspection.json'):
            need(first in raw[2], 'OWNED_VOLUME_CHANGED')
        for item in frozen['containers']:
            actual = details[item['id']]
            need(actual['RestartCount'] == 0 and not actual['State']['OOMKilled'] and not actual['State'].get('Restarting'), 'OWNED_STATE')
            if running is not None:
                need(actual['State']['Running'] is running, 'OWNED_RUNNING')
            attached = actual.get('NetworkSettings', {}).get('Networks') or {}
            need(len(attached) == 1 and {x.get('NetworkID') for x in attached.values()} == expected_network_ids, 'OWNED_NETWORK_ATTACHMENT_CHANGED')
            binding = next(x for x in self.read('owned-first-inspection.json') if x['Id'] == item['id'])
            effective_ports = actual.get('NetworkSettings', {}).get('Ports')
            original_ports = binding.get('NetworkSettings', {}).get('Ports')
            if actual['State']['Running']:
                need(effective_ports == original_ports, 'OWNED_EFFECTIVE_PORTS_CHANGED')
            else:
                released = type(effective_ports) is dict and all(value is None or value == [] for value in effective_ports.values())
                need(effective_ports == original_ports or released, 'STOPPED_EFFECTIVE_PORTS_CHANGED')
            need(actual['State']['StartedAt'] == binding['State']['StartedAt'] and actual['Config'] == binding['Config']
                 and actual['HostConfig'] == binding['HostConfig'] and mount_bag(actual['Mounts']) == mount_bag(binding['Mounts']), 'OWNED_INCARNATION_CHANGED')
        return current

    def intent(self, phase):
        need(phase in self.v['operations'], 'OPERATION_NOT_APPROVED')
        self.source()
        need(self.read('review.json') == self.v, 'REVIEW_BINDING_CHANGED')
        self.save(phase + '-intent.json', {'scope': SCOPE, 'reviewSha256': sha(self.review._sealed),
            'head': self.v['head'], 'noReplay': True, 'phase': phase})
        self.phase_started = True

    def derive(self, report):
        source = Path(self.v['preparedRoot'])
        for path in source.rglob('*'):
            if path.is_file() and path.name != 'current-auth-source-manifest.json':
                target = self.root / path.relative_to(source)
                self.prep.private_directories(self.root, target.parent)
                with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stream:
                    stream.write(path.read_bytes())
        raw = self.prep.regular_bytes(ROOT, self.prep.CONFIG)
        # 기존 signed kernel의 엄격한 overlay 계약을 보존한다. 실제 TTL은 configure에서 재확인한다.
        from prepare_database import isolated_config
        config, overlay = isolated_config(raw, self.plan['projectId'], self.plan['portBase'])
        target = self.root / 'supabase/config.toml'
        previous_sha = sha(target.read_bytes())
        target.unlink()
        with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stream:
            stream.write(config)
        self.save('config-derivation.json', {'preparedConfigSha256': previous_sha, 'runtimeConfigSha256': sha(config),
            'reason': 'EXACT_EXISTING_ISOLATED_CONFIG_FOR_SIGNED_KERNEL', 'expectedActualJwtExpirySeconds': 3600})
        self.save('database-manifest.json', {'migrations': report['migrations'], 'config_overlay': overlay,
            'config_sha256': sha(config), 'source_config_sha256': sha(raw), 'sql_execution': 'NOT_RUN'})
        files = {p.relative_to(self.root).as_posix(): sha(p.read_bytes()) for p in (self.root / 'supabase').rglob('*') if p.is_file()}
        self.save('runtime-input-pins.json', files)

    def runtime_source(self):
        self.source()
        for relative, pin in self.read('runtime-input-pins.json').items():
            need(sha(self.prep.regular_bytes(self.root, relative)) == pin, 'RUNTIME_INPUT_CHANGED')

    def inventory_proof(self, raw, first_sequence, last_sequence):
        need(first_sequence <= last_sequence, 'INVENTORY_COMMAND_REFERENCES_REQUIRED')
        references = []
        for sequence in range(first_sequence, last_sequence + 1):
            prefix = self.phase + '-command-' + str(sequence)
            names = [prefix + suffix for suffix in ('-intent.json', '-stdout.json', '-stderr.json', '-closure.json', '-result.json')]
            for name in list(names):
                if name.endswith(('-stdout.json', '-stderr.json')):
                    document = self.read(name)
                    names.extend(part['name'] for part in document.get('chunks', []))
            for name in names:
                need(re.fullmatch(re.escape(prefix) + r'-(intent|stdout|stderr|closure|result)(-part-[1-9][0-9]*)?[.]json', name), 'INVENTORY_REFERENCE_NAME')
                content = self.writer.private(self.root / name)
                references.append({'name': name, 'sha256': sha(content), 'bytes': len(content)})
        return {'firstCommand': first_sequence, 'lastCommand': last_sequence,
                'canonicalInventorySha256': sha(canonical(raw)),
                'metadataSummary': self.private.metadata_summary(raw), 'commandEvidence': references}

    def start(self):
        # 새 private 증거 루트만 먼저 확보한다. source 실패도 실제 자원 생성0으로 기록한다.
        self.prep.private_destination(ROOT, self.root)
        self.root.mkdir(mode=0o700)
        error = None; owned = None; creation_attempted = False; cli_attempted = False; stage = 'REVIEW_RECORD'
        try:
            self.save('review.json', self.v)
            self.save('start-attempt.json', {'scope': SCOPE, 'reviewSha256': sha(self.review._sealed),
                'head': self.v['head'], 'noReplay': True, 'resourceCreation': 'NOT_ATTEMPTED'})
            stage = 'SOURCE_REVIEW'
            report = self.source(); self.plan = report['target']
            stage = 'INTENT'; self.intent('start')
            stage = 'DERIVE'; self.derive(report)
            stage = 'START_MEMORY_MONITOR'; self.start_monitor()
            stage = 'BINARY_REVIEW'; self.binary()
            stage = 'PREFLIGHT_BEFORE_CREATION'
            first_sequence = self.sequence + 1
            before = self.inventory()
            self.save('preflight-inventory-proof.json', self.inventory_proof(before, first_sequence, self.sequence))
            assert_subnet_ports(before, self.plan['projectId'], self.plan['subnet'], self.plan['portBase'])
            stage = 'BASELINE_RECORD'
            baseline = self.private.metadata_summary(before)
            baseline_sha = self.save('protected-resource-baseline.json', baseline)
            self.save('existing-incarnations.json', existing_incarnations(before))
            self.save('execution-intent.json', {'version': 2, 'context': CONTEXT, 'dockerHost': HOST,
                'project': self.plan['projectId'], 'scope': 'new-synthetic-only',
                'existingContainers': [{k: x[k] for k in ('id', 'name')} for x in baseline['containers']],
                'existingNetworks': [{k: x[k] for k in ('id', 'name')} for x in baseline['customNetworks']],
                'preservedBaselineSha256': baseline_sha})
            stage = 'CACHED_IMAGES'
            for role in ROLES:
                images = json.loads(self.call(['image', 'inspect', self.v['imageRefs'][role]]))
                need(len(images) == 1 and images[0]['Id'] == self.v['images'][role], 'CACHED_IMAGE_CHANGED')
            stage = 'RUNTIME_SOURCE_BEFORE_CREATION'
            self.runtime_source(); self.memory(1048576)
            stage = 'NETWORK_CREATE'; creation_attempted = True
            network = self.call(['network', 'create', '-o', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', '--subnet', self.plan['subnet'], '--label',
                'com.supabase.cli.project=' + self.plan['projectId'], '--label', 'yumidang.scope=' + SCOPE,
                '--label', 'yumidang.review=' + sha(self.review._sealed), 'supabase_network_' + self.plan['projectId']])
            need(re.fullmatch('[a-f0-9]{64}', network), 'NETWORK_ID')
            self.save('network-created.json', {'id': network})
            stage = 'BINARY_AND_RUNTIME_BEFORE_CLI_START'
            self.binary(); self.runtime_source(); self.healthy()
            stage = 'CLI_START'; cli_attempted = True
            self.command([self.v['cliPath'], 'start', '--network-id', network, '--workdir', str(self.root), '--exclude', EXCLUDE], timeout=240)
            self.healthy(); self.runtime_source()
            stage = 'FIRST_IDENTITY'
            raw, _ = self.baseline_guard()
            owned = self.private.pair_inventory(baseline, self.private.metadata_summary(raw),
                {'source': {'project': self.plan['projectId']}}, self.v['images'])
            self.bind_first(owned, raw)
        except BaseException as exc:
            error = exc
        finally:
            # join 이후의 늦은 실패까지 receipt 판정에 포함한다. 원 실패는 덮지 않는다.
            self.done.set()
            joined = True
            if self.thread is not None:
                try:
                    self.thread.join(timeout=4)
                    joined = not self.thread.is_alive()
                except BaseException:
                    joined = False
            if not joined or self.failures:
                if error is None:
                    stage = 'MONITOR_FINALIZATION'
                    error = ValueError('MEMORY_MONITOR_FAILED' if joined else 'MEMORY_MONITOR_CLOSURE')
                else:
                    error.add_note('START_MEMORY_MONITOR_FINALIZATION_UNPROVEN')
            monitor = {'started': self.thread is not None, 'joined': joined, 'failures': list(self.failures)}
            if creation_attempted and owned is None and not self.unclosed_child and joined:
                try:
                    raw, owned = self.baseline_guard(monitor=False)
                    self.bind_first(owned, raw, partial=True)
                except BaseException:
                    owned = None
            self.save('start-memory-observation.json', self.last_memory_observation or {'status': 'NOT_OBSERVED'})
            self.save('start-receipt.json', {'scope': SCOPE, 'status': 'PASS_STARTED_ONLY' if error is None else 'FAIL_CLOSED',
                'stage': stage, 'failureType': type(error).__name__ if error is not None else None,
                'failureCode': str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z0-9_]+', str(error))
                    else 'START_FAILED' if error is not None else None,
                'ownedIds': [] if owned is None else [x['id'] for x in owned['containers']],
                'creationAttempted': creation_attempted, 'cliStartAttempted': cli_attempted, 'actualAuth': 'NOT_RUN',
                'memorySamples': self.samples, 'monitor': monitor,
                'initialCreationObservation': 'AFTER_CLI_START' if cli_attempted and owned is not None else 'NOT_OBSERVED',
                'preStartConfiguration': 'NOT_OBSERVED', 'noReplay': True, 'childClosed': not self.unclosed_child})
            if error is not None:
                cleanup = 'NOT_CREATED_NO_RESOURCE_CLEANUP' if not creation_attempted else 'UNPROVEN_OWNED_IDS_OR_CHILD'
                if creation_attempted and owned is not None and not self.unclosed_child and joined:
                    try:
                        self.stop_owned('start-failure', monitor=False)
                        cleanup = 'STOPPED_OWN_IDS_ONLY'
                    except BaseException:
                        cleanup = 'UNPROVEN_STOP'
                self.save('start-failure-cleanup.json', {'status': cleanup, 'otherStops': 0,
                    'remainingIds': [] if owned is None else [x['id'] for x in owned['containers']],
                    'remainingIdsUnproven': creation_attempted and owned is None,
                    'childClosed': not self.unclosed_child, 'monitorJoined': joined})
        if error is not None:
            if not creation_attempted: raise error
            raise ValueError('START_FAILED_NO_REPLAY') from error

    def bind_first(self, owned, raw, partial=False):
        details = [x for x in raw[0] if x['Id'] in {row['id'] for row in owned['containers']}]
        networks = [x for x in raw[1] if x['Id'] in {row['id'] for row in owned['customNetworks']}]
        need(len(networks) == 1, 'REVIEW_NETWORK_UNPROVEN')
        network = networks[0]
        labels = network.get('Labels') or {}
        need(labels.get('com.supabase.cli.project') == self.plan['projectId'] and labels.get('yumidang.scope') == SCOPE
             and labels.get('yumidang.review') == sha(self.review._sealed)
             and [x.get('Subnet') for x in network.get('IPAM', {}).get('Config') or []] == [self.plan['subnet']], 'NEW_NETWORK_BINDING')
        volumes = [x for x in raw[2] if x['Name'] in {row['name'] for row in owned['volumes']}]
        need(all((x.get('Labels') or {}).get('com.supabase.cli.project') == self.plan['projectId'] for x in volumes), 'NEW_VOLUME_BINDING')
        for item in details:
            role = next(role for role, prefix in ROLES.items() if item['Name'] == '/' + prefix + self.plan['projectId'])
            need(re.fullmatch('[a-f0-9]{64}', item['Id']) and item['RestartCount'] == 0
                 and (item['Config'].get('Labels') or {}).get('com.supabase.cli.project') == self.plan['projectId'], 'NEW_ID_LABEL')
            attached = item.get('NetworkSettings', {}).get('Networks') or {}
            need(len(attached) == 1 and {row.get('NetworkID') for row in attached.values()} == {network['Id']}, 'EXACT_REVIEW_NETWORK')
            allowed_volumes = {row['Name'] for row in volumes}
            def own_mount(mount):
                if mount.get('Type') == 'volume':
                    return mount.get('Name') in allowed_volumes
                if mount.get('Type') == 'bind' and type(mount.get('Source')) is str:
                    source = Path(mount['Source'])
                    return source.is_absolute() and source.resolve() == source and source.is_relative_to(self.root)
                return False
            need(all(own_mount(mount) for mount in item['Mounts']), 'OWNED_MOUNTS_ONLY')
            if role == 'db':
                need(any(mount.get('Name') == ROLES['db'] + self.plan['projectId'] for mount in item['Mounts']), 'DB_VOLUME_RELATION')
        self.save('owned-first-inspection.json', details)
        self.save('owned-network-first-inspection.json', networks)
        self.save('owned-volume-first-inspection.json', volumes)
        self.save('owned-resources.json', owned)
        for kind, name in [('containers', 'owned-containers.json'), ('customNetworks', 'owned-networks.json'), ('volumes', 'owned-volumes.json')]:
            keys = ('id', 'name', 'image') if kind == 'containers' else ('id', 'name') if kind == 'customNetworks' else ('name',)
            self.save(name, [{key: row[key] for key in keys} for row in owned[kind]])

        if not partial:
            self.accept_services(details, networks)

    def accept_services(self, details, networks):
        # 정확 cleanup identity는 이미 저장했다. 서비스 수용 실패를 성공으로 바꾸지 않는다.
        need(len(networks) == 1 and (networks[0].get('Options') or {}) == NETWORK_OPTIONS, 'NETWORK_OPTIONS')
        for item in details:
            role = next(role for role, prefix in ROLES.items() if item['Name'] == '/' + prefix + self.plan['projectId'])
            need({key: item['HostConfig'].get(key) for key in self.v['hostLimits'][role]} == self.v['hostLimits'][role], 'EXACT_HOST_LIMITS')
            self.accept_ports(role, item)

    def accept_ports(self, role, item):
        expected = {'5432/tcp': str(self.plan['portBase'] + 1)} if role == 'db' else {'8000/tcp': str(self.plan['portBase'])} if role == 'gateway' else {}
        configured = item['HostConfig'].get('PortBindings')
        effective = item.get('NetworkSettings', {}).get('Ports')
        need(type(configured) is dict and type(effective) is dict, 'PORT_EVIDENCE_REQUIRED')
        configured_published = {k: v for k, v in configured.items() if v is not None and v != []}
        effective_published = {k: v for k, v in effective.items() if v is not None and v != []}
        need(set(configured_published) == set(expected) and set(effective_published) == set(expected), 'EXACT_ROLE_PORTS')
        for port, host_port in expected.items():
            declarations = configured_published[port]; bindings = effective_published[port]
            need(type(declarations) is list and len(declarations) == 1, 'CONFIGURED_PORT_CARDINALITY')
            need(declarations[0].get('HostIp') in ('', '127.0.0.1', '::1') and declarations[0].get('HostPort') == host_port, 'NON_LOOPBACK_BINDING')
            need(type(bindings) is list and 1 <= len(bindings) <= 2, 'EFFECTIVE_PORT_CARDINALITY')
            need(all(type(entry) is dict and set(entry) == {'HostIp', 'HostPort'}
                     and entry['HostIp'] in ('127.0.0.1', '::1') and entry['HostPort'] == host_port for entry in bindings), 'NON_LOOPBACK_EFFECTIVE_BINDING')
            need(len({entry['HostIp'] for entry in bindings}) == len(bindings), 'DUPLICATE_EFFECTIVE_BINDING')

    def guarded_sql(self, statement):
        self.runtime_source(); raw, _ = self.baseline_guard()
        frozen = self.read('owned-resources.json'); self.check_owned(frozen, raw, running=True)
        target = next(x for x in frozen['containers'] if x['name'] == ROLES['db'] + self.plan['projectId'])
        try:
            return self.call(['exec', '-i', target['id'], 'psql', '-XqAt', '-h', '/var/run/postgresql', '-U',
                'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-'], statement)
        finally:
            self.baseline_guard(); self.healthy()

    def configure(self):
        self.plan = self.source()['target']; self.intent('configure')
        need(self.read('start-receipt.json')['status'] == 'PASS_STARTED_ONLY', 'START_PASS_REQUIRED')
        self.start_monitor(); self.binary(); self.runtime_source()
        self.save('cron-close-intent.json', {'singleAttempt': True, 'statement': "ALTER SYSTEM SET cron.launch_active_jobs='off'"})
        self.guarded_sql("ALTER SYSTEM SET cron.launch_active_jobs='off';select pg_reload_conf();")
        for _ in range(20):
            if self.guarded_sql("select current_setting('cron.launch_active_jobs');") == 'off':
                break
            time.sleep(.2)
        else:
            raise ValueError('CRON_NOT_CLOSED')
        raw, _ = self.baseline_guard(); self.check_owned(self.read('owned-resources.json'), raw, running=True)
        containers = {}
        for role, prefix in ROLES.items():
            item = next(x for x in raw[0] if x['Name'] == '/' + prefix + self.plan['projectId'])
            containers[role] = {'id': item['Id'], 'name': item['Name'][1:], 'image': item['Image'],
                'configSha256': sha(canonical(item['Config'])), 'hostConfigSha256': sha(canonical(item['HostConfig'])),
                'mountsSha256': self.guard.preserved_mounts_sha(item['Mounts'])}
        status = json.loads(self.command([self.v['cliPath'], 'status', '--workdir', str(self.root), '-o', 'json'], timeout=20))
        target = self.ai.signed_prepared_target(self.root)
        reviewed = self.ai.ReviewedSignedProvisioning(self.v['decisionId'], self.root, self.ai.signed_source_pins(), containers,
            {'anon': status['ANON_KEY'], 'service': status['SERVICE_ROLE_KEY']}, int(time.time()) + 900)
        self.ai.provisioning_metadata(reviewed, target, 'http://127.0.0.1:' + str(self.plan['portBase']))
        ports = self.ai.FixedLifecycleProvisioningPorts(reviewed)
        ports.origin = 'http://127.0.0.1:' + str(self.plan['portBase'])
        need(ports.settings() == {'jwtExpirySeconds': 3600, 'anonymousEnabled': False, 'signupDisabled': True}, 'ACTUAL_AUTH_SETTINGS')
        need(ports.history() == {'method': 'SUPABASE_DB_HISTORY', 'native': 'NOT_RUN'}, 'APPLIED_CURRENT_HISTORY')
        controls = ports.closed_controls()
        need(controls == {**{name: False for name in self.ai.PROVISION_CLOSED_CONTROLS}, 'cronLaunchActiveJobs': 'off'}, 'CONTROLS_NOT_CLOSED')
        need(ports.empty_auth(), 'AUTH_NOT_EMPTY')
        self.save('signed-provisioning-packet-private.json', {'containers': containers, 'credentials': reviewed.credentials,
            'sourcePins': reviewed.source_pins, 'reviewSha256': sha(self.review._sealed), 'actualAuth': 'NOT_RUN'})
        self.runtime_source(); self.baseline_guard(); self.healthy()
        self.save('configure-receipt.json', {'scope': SCOPE, 'status': 'PASS_EMPTY_CONFIGURED_ONLY',
            'migrationCount': len(target['versions']), 'actualAuth': 'NOT_RUN', 'jwtExpirySeconds': 3600,
            'signedProvisioning': 'READY_FOR_SEPARATE_REVIEWED_KERNEL_CALL'})

    def stop_owned(self, label, monitor=True):
        need(not self.unclosed_child, 'STOP_WITH_LIVE_CHILD_REFUSED')
        self.save(label + '-stop-intent.json', {'singleAttempt': True, 'retainOwnData': True, 'otherStops': 0})
        raw, _ = self.baseline_guard(monitor)
        frozen = self.read('owned-resources.json'); self.check_owned(frozen, raw)
        results = []
        for row in frozen['containers']:
            current, _ = self.baseline_guard(monitor)
            self.check_owned(frozen, current)
            actual = next(x for x in current[0] if x['Id'] == row['id'])
            if actual['State']['Running']:
                self.call(['stop', '--time', '10', row['id']], timeout=20, monitor=monitor)
            results.append(row['id'])
        after, _ = self.baseline_guard(monitor); self.check_owned(frozen, after, running=False)
        self.save(label + '-stop-receipt.json', {'status': 'STOPPED_OWN_IDS_ONLY', 'ids': results,
            'ownNetworksAndVolumesRetained': True, 'wholeStoredBytesPreserved': 'NOT_VERIFIED'})

    def close(self):
        self.plan = self.source()['target']; self.intent('close')
        self.stop_owned('close', monitor=False)


def run_phase(review, phase):
    need(type(review) is ReviewedCurrentAuthSource and phase in {'start', 'configure', 'close'}, 'TYPED_PHASE_REQUIRED')
    with runtime_support(review) as support:
        runner = CurrentAuthSource(review, support)
        runner.phase = phase
        try:
            getattr(runner, phase)()
        except BaseException:
            if phase == 'configure' and runner.phase_started:
                cleanup = 'UNPROVEN_OWNED_IDS_OR_CHILD'
                if not runner.unclosed_child and (runner.root / 'owned-resources.json').exists():
                    try:
                        runner.stop_owned('configure-failure', monitor=False)
                        cleanup = 'STOPPED_OWN_IDS_ONLY'
                    except BaseException:
                        cleanup = 'UNPROVEN_STOP'
                runner.save('configure-failure-receipt.json', {'status': 'FAIL_CLOSED', 'cleanup': cleanup,
                    'actualAuth': 'NOT_RUN', 'childClosed': not runner.unclosed_child, 'otherStops': 0})
            raise
        finally:
            runner.done.set()
            if runner.thread is not None:
                runner.thread.join(timeout=4)
                need(not runner.thread.is_alive(), 'MEMORY_MONITOR_CLOSURE')


def main():
    print(json.dumps({'status': 'NOT_RUN', 'scope': SCOPE, 'phases': ['start', 'configure', 'close'],
        'actualAuth': 'NOT_RUN', 'cliExecution': 'DISABLED_USE_TYPED_ROOT_REVIEW'}))


if __name__ == '__main__':
    main()
