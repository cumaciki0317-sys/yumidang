#!/usr/bin/env python3
"""승인된 새 종현 대상의 생성 명령·전후 관찰을 기록한다. 기본 CLI는 실행하지 않는다."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import time

import run_database_tests as guard
from prepare_database import isolated_config
from prepare_migrations import inspect_migrations

REPO = Path(__file__).resolve().parents[2]
PRODUCER = 'tools/local/start_owned_validation.py'
PROFILE = 'jonghyun-backend100'
CONTEXT = 'colima-jonghyun-backend100'
HOST = 'unix://' + str(Path.home() / '.colima' / PROFILE / 'docker.sock')
MINIMUM_KIB = 1048576
CLI_VERSION = '2.116.0'
# 이 작업의 기존 임시 CLI 바이트를 고정한다. PATH의 다른 버전이나 새 다운로드로 대체하지 않는다.
CLI_SHA256 = '42a9fe8b8a266bc0fbde804c08efb75cc0653480e91ba3f20fba1c3c27a7b49a'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def require(value, code):
    if not value:
        raise ValueError('OWNED_CREATION_' + code)


def save(root, name, raw):
    require(Path(name).name == name, 'FILE_NAME')
    with os.fdopen(os.open(root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        stream.write(raw)


def prepared_bytes(root, relative):
    """실제 CLI가 읽을 설정/SQL 사본도 비공개 일반 파일과 원 SHA로 검사한다."""
    require(relative == 'supabase/config.toml' or re.fullmatch(r'supabase/migrations/[0-9]+_[A-Za-z0-9_-]+\.sql', relative), 'PREPARED_PATH')
    path = root / relative
    require(path.resolve() == path, 'PREPARED_SYMLINK')
    current = path.parent
    while current != root.parent:
        value = current.lstat()
        require(stat.S_ISDIR(value.st_mode) and value.st_uid == os.getuid() and stat.S_IMODE(value.st_mode) == 0o700, 'PREPARED_DIRECTORY')
        current = current.parent
    before = path.lstat()
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        opened = os.fstat(stream.fileno())
        identity = lambda x: (x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns, x.st_ctime_ns, x.st_nlink)
        require(stat.S_ISREG(opened.st_mode) and opened.st_uid == os.getuid() and stat.S_IMODE(opened.st_mode) == 0o600
                and opened.st_nlink == 1 and opened.st_size <= 4 * 1024 * 1024 and identity(before) == identity(opened), 'PREPARED_FILE')
        raw = stream.read(4 * 1024 * 1024 + 1)
        require(len(raw) == opened.st_size and identity(opened) == identity(os.fstat(stream.fileno()))
                and identity(opened) == identity(path.lstat()), 'PREPARED_CHANGED')
        return raw


def docker(args):
    result = subprocess.run(['docker', '--host', HOST, *args], capture_output=True, timeout=15)
    require(result.returncode == 0, 'OBSERVATION_FAILED')
    return result.stdout.decode()


def memory():
    result = subprocess.run(['colima', 'ssh', '--profile', PROFILE, '--', 'cat', '/proc/meminfo'],
                            capture_output=True, text=True, timeout=3)
    values = re.findall(r'^MemAvailable:\s+([0-9]+) kB$', result.stdout, re.M)
    require(result.returncode == 0 and len(values) == 1, 'MEMORY_UNPROVEN')
    return int(values[0])


def inventory():
    ids = sorted(docker(['ps', '-a', '--no-trunc', '--format', '{{.ID}}']).splitlines())
    require(len(ids) == len(set(ids)) and all(re.fullmatch('[a-f0-9]{64}', x) for x in ids), 'IDS')
    values = json.loads(docker(['inspect', *ids])) if ids else []
    containers = []
    for item in values:
        containers.append({'id': item['Id'], 'name': item['Name'].removeprefix('/'), 'image': item['Image'],
                           'configSha256': sha(canonical(item['Config'])),
                           'hostConfigSha256': sha(canonical(item['HostConfig'])),
                           'mountsSha256': sha(canonical(item['Mounts'])),
                           'project': (item['Config'].get('Labels') or {}).get('com.supabase.cli.project'),
                           'running': item['State']['Running'], 'oomKilled': item['State']['OOMKilled']})
    networks = [json.loads(x) for x in docker(['network', 'ls', '--no-trunc', '--format', '{{json .}}']).splitlines()]
    nets = []
    for item in networks:
        if item['Name'] in ('bridge', 'host', 'none'):
            continue
        value = json.loads(docker(['network', 'inspect', item['ID']]))[0]
        nets.append({'id': value['Id'], 'name': value['Name'], 'inspectionSha256': sha(canonical(value))})
    volumes = []
    for name in docker(['volume', 'ls', '--format', '{{.Name}}']).splitlines():
        value = json.loads(docker(['volume', 'inspect', name]))[0]
        volumes.append({'name': name, 'inspectionSha256': sha(canonical(value))})
    return {'containers': sorted(containers, key=lambda x: x['id']),
            'networks': sorted(nets, key=lambda x: x['id']),
            'volumes': sorted(volumes, key=lambda x: x['name'])}


def creation_delta(before, after, project):
    """전후 목록의 실제 원행을 보존한다. 생성 flag나 현재 inspect만으로 추정하지 않는다."""
    require(re.fullmatch('jonghyun-backend100-[a-f0-9]{8}', project) is not None, 'PROJECT')
    added = {}
    for kind, key in [('containers', 'id'), ('networks', 'id'), ('volumes', 'name')]:
        old = {x[key]: x for x in before[kind]}
        new = {x[key]: x for x in after[kind]}
        require(len(old) == len(before[kind]) and len(new) == len(after[kind]), 'DUPLICATE')
        require(all(new.get(k) == v for k, v in old.items()), 'EXISTING_CHANGED')
        values = [v for k, v in new.items() if k not in old]
        require(all(v['name'].startswith('supabase_') and v['name'].endswith('_' + project) for v in values), 'FOREIGN_DELTA')
        if kind == 'containers':
            require(all(v['project'] == project and v['running'] is True and v['oomKilled'] is False for v in values), 'NEW_CONTAINER_STATE')
        added[kind] = values
    require(len(added['containers']) == 6 and len(added['networks']) == 1 and len(added['volumes']) == 2, 'SIX_TARGET_INCOMPLETE')
    require({x['name'].removesuffix('_' + project) for x in added['containers']} ==
            {'supabase_db', 'supabase_auth', 'supabase_rest', 'supabase_kong', 'supabase_storage', 'supabase_inbucket'}, 'TARGET_ROLES')
    return added


def listening_ports(raw):
    rows = raw.splitlines()
    require(rows and 'local_address' in rows[0], 'VM_PORT_FORMAT')
    found = set()
    for row in rows[1:]:
        fields = row.split()
        require(len(fields) >= 4 and re.fullmatch('[A-Fa-f0-9]+:[A-Fa-f0-9]{4}', fields[1]), 'VM_PORT_ROW')
        if fields[3] == '0A':
            found.add(int(fields[1].split(':')[1], 16))
    return found


def preflight_ports(overlay, project, before):
    """새 대상의 포트를 읽기/일시 bind로 확인한다. CLI까지 예약하는 것은 아니다."""
    require(not any(x.get('project') == project or x['name'].endswith('_' + project)
                    for kind in before.values() for x in kind), 'PROJECT_ALREADY_EXISTS')
    ports = sorted({value for key, value in overlay.items() if key.endswith('.port') or key.endswith('_port')})
    require(ports and all(type(x) is int and 1025 <= x <= 65535 for x in ports), 'PORT_SET')
    ids = [x['id'] for x in before['containers']]
    current = json.loads(docker(['inspect', *ids])) if ids else []
    require(sorted(x['Id'] for x in current) == sorted(ids), 'PORT_INVENTORY')
    bound = set()
    for item in current:
        for values in (item['HostConfig'].get('PortBindings') or {}).values():
            for value in values or []:
                require(re.fullmatch('[0-9]+', value['HostPort']), 'DOCKER_PORT_FORMAT')
                bound.add(int(value['HostPort']))
    require(not bound.intersection(ports), 'DOCKER_PORT_OCCUPIED')
    vm_ports = set()
    for path in ('/proc/net/tcp', '/proc/net/tcp6'):
        observation = subprocess.run(['colima', 'ssh', '--profile', PROFILE, '--', 'cat', path],
                                     capture_output=True, text=True, timeout=3)
        require(observation.returncode == 0, 'VM_PORT_UNPROVEN')
        vm_ports.update(listening_ports(observation.stdout))
    require(not vm_ports.intersection(ports), 'VM_PORT_OCCUPIED')
    # listen/접속/패킷 전송 없이 host의 중복 bind를 거절한다.
    try:
        for port in ports:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind(('0.0.0.0', port))
            if socket.has_ipv6:
                with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as probe:
                    probe.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                    probe.bind(('::', port))
    except OSError as error:
        raise ValueError('OWNED_CREATION_HOST_PORT_UNAVAILABLE') from error
    return {'ports': ports, 'dockerBindings': 'FREE', 'vmListeners': 'FREE', 'hostBind': 'FREE',
            'reservation': False, 'observedAt': time.time()}


def wait_creation(command, root, env):
    """발급한 프로세스·PID 기록·대기를 같은 정리 경계로 묶는다."""
    process = None
    pending = []
    old_handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    with os.fdopen(os.open(root / 'creation-stdout-private.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as out, \
            os.fdopen(os.open(root / 'creation-stderr-private.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as err:
        try:
            # Popen 반환과 handle 할당 사이의 중단도 놓치지 않도록 잠깐 기록만 한다.
            for sig in old_handlers:
                signal.signal(sig, lambda signum, _frame: pending.append(signum))
            try:
                process = subprocess.Popen(command, stdout=out, stderr=err, env=env, start_new_session=True)
            finally:
                for sig, handler in old_handlers.items():
                    signal.signal(sig, handler)
            if pending:
                raise ValueError('OWNED_CREATION_INTERRUPTED')
            save(root, 'creation-process-private.json', canonical({'pid': process.pid, 'command': command}))
            return process.wait()
        except BaseException:
            if process is not None and process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
            # PID 기록의 저장 실패가 실제 소유 프로세스 종료를 막지 않게 한다.
            try:
                save(root, 'creation-interrupted-private.json', canonical({'pid': process.pid if process else None,
                     'commandExit': process.returncode if process else None, 'resources': 'UNCONFIRMED_REQUIRES_OBSERVATION'}))
            except OSError:
                pass
            raise
        finally:
            for sig, handler in old_handlers.items():
                signal.signal(sig, handler)


def start(root, cli_path):
    root = Path(root)
    require(root.is_absolute() and root.resolve() == root, 'CANONICAL_ROOT')
    read = lambda name: guard.preserved_private_bytes(root, name)
    manifest = json.loads(read('database-manifest.json'))
    intent_raw = read('execution-intent.json')
    intent = json.loads(intent_raw)
    project = intent.get('project')
    require(intent.get('version') == 2 and intent.get('context') == CONTEXT and intent.get('dockerHost') == HOST
            and intent.get('scope') == 'new-synthetic-only', 'INTENT')
    require(json.loads(read('owned-containers.json')) == [] and json.loads(read('owned-networks.json')) == []
            and json.loads(read('owned-volumes.json')) == [], 'ALREADY_CREATED_NO_RETRY')
    head = subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], text=True).strip()
    original = subprocess.check_output(['git', '-C', str(REPO), 'show', head + ':' + PRODUCER])
    require(original == Path(__file__).read_bytes(), 'PRODUCER_NOT_COMMITTED')
    cli_path = Path(cli_path)
    require(cli_path.is_absolute() and cli_path.resolve() == cli_path and cli_path.is_file()
            and cli_path.stat().st_uid == os.getuid() and os.access(cli_path, os.X_OK)
            and sha(cli_path.read_bytes()) == CLI_SHA256, 'CLI_BINARY')
    source = json.loads(read('creation-source-pins.json'))
    require(set(source) == {'head', 'sourceFiles'} and source['head'] == head and isinstance(source['sourceFiles'], dict)
            and source['sourceFiles'] and PRODUCER in source['sourceFiles'], 'SOURCE_PINS')
    for name, expected in source['sourceFiles'].items():
        path = Path(name)
        require(not path.is_absolute() and not any(x in ('.', '..') for x in path.parts)
                and name.startswith(('backend/', 'apps/mobile/', 'tests/', 'tools/local/'))
                and re.fullmatch('[a-f0-9]{64}', str(expected)), 'SOURCE_PATH')
        committed = subprocess.check_output(['git', '-C', str(REPO), 'show', head + ':' + name])
        require(sha(committed) == expected and (REPO / path).resolve() == REPO / path
                and (REPO / path).read_bytes() == committed, 'SOURCE_CHANGED')
    require(manifest['migrations'] == inspect_migrations(REPO)['migrations'], 'MIGRATION_SET')
    expected_sql = {Path(x['path']).name for x in manifest['migrations']}
    require({p.name for p in (root / 'supabase/migrations').iterdir()} == expected_sql, 'PREPARED_SQL_SET')
    prepared_sql = {Path(x['path']).name: prepared_bytes(root, 'supabase/migrations/' + Path(x['path']).name)
                    for x in manifest['migrations']}
    require(all(sha(prepared_sql[Path(x['path']).name]) == x['sha256'] for x in manifest['migrations']), 'PREPARED_SQL_SHA')
    overlay = manifest['config_overlay']
    config, expected_overlay = isolated_config((REPO / 'backend/supabase/config.toml').read_bytes(), project, overlay['api.port'])
    require(overlay == expected_overlay and prepared_bytes(root, 'supabase/config.toml') == config
            and manifest['config_sha256'] == sha(config)
            and manifest['source_config_sha256'] == sha((REPO / 'backend/supabase/config.toml').read_bytes())
            and manifest['sql_execution'] == 'NOT_RUN', 'CONFIG')
    require(docker(['context', 'inspect', CONTEXT, '--format', '{{.Endpoints.docker.Host}}']).strip() == HOST, 'SOCKET')
    pins = guard.preserved_resource_pins(root, intent)
    guard.verify_preserved_resources(root, HOST, project, docker, pins)
    before = inventory()
    initial_owned = {name: read(name) for name in ('owned-containers.json', 'owned-networks.json', 'owned-volumes.json')}
    available = memory()
    require(available >= MINIMUM_KIB, 'START_HEADROOM')
    port_receipt = preflight_ports(overlay, project, before)
    command = [str(cli_path), 'start', '--workdir', str(root), '-x', 'realtime,imgproxy']
    save(root, 'creation-intent-private.json', canonical({'head': head, 'producerSha256': sha(original), 'command': command,
                                                       'intentSha256': sha(intent_raw), 'before': before,
                                                       'availableKiB': available, 'portPreflight': port_receipt,
                                                       'startedAt': time.time()}))
    env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR')}
    env['DOCKER_HOST'] = HOST
    env['SUPABASE_TELEMETRY_DISABLED'] = 'true'
    # 원 stdout/stderr에는 비밀이 포함될 수 있어 비공개 파일에만 저장한다.
    code = wait_creation(command, root, env)
    after = inventory()
    save(root, 'creation-terminal-private.json', canonical({'commandExit': code, 'after': after, 'observedAt': time.time()}))
    require(code == 0, 'COMMAND_FAILED_PRESERVE_NO_RETRY')
    require(subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], text=True).strip() == head
            and Path(__file__).read_bytes() == original and sha(cli_path.read_bytes()) == CLI_SHA256
            and read('execution-intent.json') == intent_raw
            and prepared_bytes(root, 'supabase/config.toml') == config
            and all(prepared_bytes(root, 'supabase/migrations/' + name) == raw for name, raw in prepared_sql.items()), 'POST_SOURCE_CHANGED')
    added = creation_delta(before, after, project)
    owned = added['containers']
    # 최종 inventory를 고정한 뒤 기존 v2 guard로 실제 보호 자원을 다시 대조한다.
    for name, value in [('owned-containers.json', owned), ('owned-networks.json', [{'id': x['id'], 'name': x['name']} for x in added['networks']]),
                        ('owned-volumes.json', [{'name': x['name']} for x in added['volumes']])]:
        path = root / name
        require(read(name) == initial_owned[name], 'OWNED_INPUT_CHANGED')
        path.write_bytes(canonical(value))
    updated_intent = json.loads(read('execution-intent.json'))
    guard.verify_preserved_resources(root, HOST, project, docker, guard.preserved_resource_pins(root, updated_intent))
    creation = {'version': 1, 'scenario': 'OWNED_RESOURCES_CREATION_V1', 'head': head, 'producerPath': PRODUCER,
                'producerSha256': sha(original), 'preparedRoot': str(root), 'project': project, 'context': CONTEXT,
                'dockerHost': HOST, 'intentBeforeSha256': sha(intent_raw), 'protectedBaselineSha256': pins['baselineSha256'],
                'command': command, 'cli': {'path': str(cli_path), 'sha256': CLI_SHA256, 'version': CLI_VERSION},
                'commandExit': code, 'commandStdoutSha256': sha(read('creation-stdout-private.log')),
                'commandStderrSha256': sha(read('creation-stderr-private.log')), 'before': before, 'after': after, 'owned': added}
    save(root, 'owned-resource-creation-receipt.json', canonical(creation))
    storage = next(x for x in owned if x['name'] == 'supabase_storage_' + project)
    receipt = {'version': 1, 'scenario': 'OWNED_STORAGE_CREATION_V1', 'head': head, 'producerPath': PRODUCER,
               'producerSha256': sha(original), 'preparedRoot': str(root), 'project': project, 'context': CONTEXT, 'dockerHost': HOST,
               'originalCreationReceiptPath': str(root / 'owned-resource-creation-receipt.json'),
               'originalCreationReceiptSha256': sha(canonical(creation)), 'ownedContainersSha256': sha(read('owned-containers.json')),
               'storage': {k: storage[k] for k in ('id', 'name', 'image', 'configSha256', 'hostConfigSha256', 'mountsSha256')}}
    save(root, 'owned-storage-creation-receipt.json', canonical(receipt))
    return {'status': 'NEW_OWNED_CREATION_OBSERVED', 'project': project, 'storageReceiptSha256': sha(canonical(receipt)),
            'actualAuth': 'NOT_RUN', 'actualConnectionTests': 'NOT_RUN', 'wholeExistingBytes': 'NOT_VERIFIED'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepared-root', type=Path)
    parser.add_argument('--supabase-binary', type=Path)
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args()
    if not args.run:
        print(json.dumps({'status': 'NOT_RUN', 'resourceChanges': 0}))
        return 0
    def interrupted(_signum, _frame):
        raise ValueError('OWNED_CREATION_INTERRUPTED')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        require(args.prepared_root is not None and args.supabase_binary is not None, 'ROOT_AND_CLI_REQUIRED')
        print(json.dumps(start(args.prepared_root, args.supabase_binary)))
        return 0
    except Exception:
        print(json.dumps({'status': 'NOT_CLOSED', 'privateEvidencePreserved': True, 'automaticRetry': False}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
