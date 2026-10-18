"""익명·다른 인증 문맥 두 건만 검사하는 독립 root 검토 API. CLI는 실행하지 않는다.

제품 기본 config와 기존 lifecycle kernel은 수정하지 않는다. 실제 실행은 새 소스의
커밋·독립 검토·정확한 신규 자원/HTTP 승인 뒤 ReviewedAuthNegativePair로만 조립한다.
"""
import ast
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import threading
import tempfile
import time
from types import SimpleNamespace
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
SCOPE = 'LOCAL_AUTH_ANONYMOUS_AND_FOREIGN_REJECTION_ONLY'
PURPOSE = 'ANONYMOUS_NEGATIVE_TARGET_ONLY'
SELF = 'tools/local/prepare_auth_negative.py'
PROFILE = 'yumidang-minkyu'
CONTEXT = 'colima-yumidang-minkyu'
HOST = 'unix://' + str(Path.home() / '.colima' / PROFILE / 'docker.sock')
ROLES = {'db': 'supabase_db_', 'auth': 'supabase_auth_',
         'rest': 'supabase_rest_', 'gateway': 'supabase_kong_'}
EXCLUDE = 'realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor'
GOTRUE_SOURCE_COMMIT = '0204331ca41a5b49f076b6fa3dc6c0d20b996590'
OFFICIAL_SOURCE = {
    'anonymous': 'https://raw.githubusercontent.com/supabase/auth/0204331ca41a5b49f076b6fa3dc6c0d20b996590/internal/api/anonymous.go',
    'identity': 'https://raw.githubusercontent.com/supabase/auth/0204331ca41a5b49f076b6fa3dc6c0d20b996590/internal/api/signup.go',
    'grant': 'https://raw.githubusercontent.com/supabase/auth/0204331ca41a5b49f076b6fa3dc6c0d20b996590/internal/tokens/service.go',
    'amr': 'https://raw.githubusercontent.com/supabase/auth/0204331ca41a5b49f076b6fa3dc6c0d20b996590/internal/models/amr.go',
    'method': 'https://raw.githubusercontent.com/supabase/auth/0204331ca41a5b49f076b6fa3dc6c0d20b996590/internal/models/factor.go',
    'refresh': 'https://raw.githubusercontent.com/supabase/auth/0204331ca41a5b49f076b6fa3dc6c0d20b996590/internal/models/refresh_token.go',
    'refresh_configuration': 'https://raw.githubusercontent.com/supabase/auth/0204331ca41a5b49f076b6fa3dc6c0d20b996590/internal/conf/configuration.go',
}


def require(value, code):
    if not value:
        raise ValueError(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def exact_json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, 'NEGATIVE_DUPLICATE_JSON')
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=pairs,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NEGATIVE_NONFINITE_JSON')))


def uuid_required(value):
    require(type(value) is str and str(uuid.UUID(value)) == value, 'NEGATIVE_CANONICAL_UUID')
    return value


def secure_private_bytes(path, ai):
    """검토된 private reader에 조상 FD 연결·ctime 검사를 더한다. FIFO는 기존 NONBLOCK로 거절한다."""
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path, 'NEGATIVE_PRIVATE_PATH')
    held = []
    signature = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_ctime_ns)
    try:
        for directory in (path.parent, *path.parent.parents):
            if directory in {Path('/private/tmp'), Path(tempfile.gettempdir()).resolve()}: break
            before = directory.lstat()
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
            opened = os.fstat(fd)
            held.append((directory, fd, opened))
            require(stat.S_ISDIR(opened.st_mode) and opened.st_uid == os.getuid()
                    and stat.S_IMODE(opened.st_mode) == 0o700 and signature(before) == signature(opened),
                    'NEGATIVE_PRIVATE_ANCESTOR')
        else: raise ValueError('NEGATIVE_PRIVATE_BOUNDARY')
        raw = ai.signed_private_read(path)
        for directory, fd, before in held:
            require(signature(before) == signature(os.fstat(fd)) == signature(directory.lstat()),
                    'NEGATIVE_PRIVATE_ANCESTOR_CHANGED')
        for index in range(len(held) - 1):
            child, _, info = held[index]; _, parent_fd, _ = held[index + 1]
            require(signature(os.stat(child.name, dir_fd=parent_fd, follow_symlinks=False)) == signature(info),
                    'NEGATIVE_PRIVATE_ANCESTOR_CONNECTION')
        return raw
    finally:
        for _, fd, _ in held: os.close(fd)


def source_pins(expected_head=None):
    """자기 source와 실제 재사용 helper까지 HEAD bytes를 먼저 검사한다. 모듈 실행 없음."""
    head = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], timeout=15).decode().strip()
    require(re.fullmatch('[a-f0-9]{40}', head) and (expected_head is None or head == expected_head),
            'NEGATIVE_SOURCE_HEAD_CHANGED')
    fixed = {SELF, 'backend/supabase/config.toml', 'tools/local/prepare_database.py', 'tools/local/prepare_migrations.py',
        'tools/local/run_database_tests.py', 'tools/local/observe_isolated.py',
        'tests/integration/jonghyun/isolated_ai_contracts.py',
        'tests/integration/jonghyun/isolated_ai_factory.ts',
        'tests/integration/minkyu/product_connection_restore108_local.py',
        'tests/integration/minkyu/member_cleanup_reconcile_local.py'}
    pending = ['backend/supabase/functions/ai-chat/index.ts']
    pins = {}
    while pending or fixed:
        relative = pending.pop() if pending else min(fixed)
        fixed.discard(relative)
        if relative in pins:
            continue
        path = ROOT / relative
        require(path.resolve() == path and not path.is_symlink(), 'NEGATIVE_SOURCE_PATH')
        raw = subprocess.check_output(['git', '-C', str(ROOT), 'show', head + ':' + relative],
                                      stderr=subprocess.DEVNULL, timeout=15)
        require(path.read_bytes() == raw, 'NEGATIVE_SOURCE_NOT_COMMITTED')
        pins[relative] = digest(raw)
        if relative.startswith('backend/supabase/functions/'):
            for local in re.findall(r'''(?:from\s*|import\s*)["'](\.[^"']+)["']''', raw.decode()):
                child = Path(os.path.abspath(path.parent / local))
                require(child.is_relative_to(ROOT / 'backend/supabase/functions') and child.suffix == '.ts',
                        'NEGATIVE_PRODUCT_IMPORT_OUTSIDE_ROOT')
                pending.append(child.relative_to(ROOT).as_posix())
    return head, pins


def support(reviewed):
    require(type(reviewed) is ReviewedAuthNegativePair, 'NEGATIVE_TYPED_REVIEW_REQUIRED')
    head, pins = source_pins(reviewed.source_head)
    require(pins == reviewed.pins, 'NEGATIVE_SOURCE_CHANGED')
    path = ROOT / 'tests/integration/jonghyun/isolated_ai_contracts.py'
    raw = path.read_bytes()
    spec = importlib.util.spec_from_loader('reviewed_negative_ai', loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__file__ = str(path)
    sys.path.insert(0, str(ROOT / 'tools/local'))
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    require(all(pins.get(key) == value for key, value in module.signed_source_pins().items()),
            'NEGATIVE_SIGNED_SOURCE_SUBSET_CHANGED')
    return module


class ReviewedAuthNegativePair:
    """실제 root 검토 객체. JSON·CLI flags·임의 callback으로 실행 권한을 주지 않는다."""
    def __init__(self, decision_id, pair_root, anonymous_project, anonymous_port, anonymous_subnet,
                 foreign_project, foreign_port, foreign_subnet, source_head, pins,
                 cli_path, cli_sha256, node_path, node_sha256, images, refresh_mode,
                 daemon_id,
                 approved_operations):
        require(type(decision_id) is str and re.fullmatch('[A-Za-z0-9_.:-]{1,128}', decision_id),
                'NEGATIVE_REVIEW_DECISION')
        root = Path(pair_root)
        require(root.is_absolute() and root.resolve() == root and root != Path(tempfile.gettempdir()).resolve()
                and Path(tempfile.gettempdir()).resolve() in root.parents and not root.is_relative_to(ROOT), 'NEGATIVE_PRIVATE_ROOT')
        projects, ports, networks = set(), set(), set()
        contexts = {}
        for key, project, port, subnet in (
                ('anonymous', anonymous_project, anonymous_port, anonymous_subnet),
                ('foreign', foreign_project, foreign_port, foreign_subnet)):
            require(type(project) is str and re.fullmatch('jonghyun-backend100-[a-f0-9]{8}', project)
                    and project not in projects and type(port) is int and 1025 <= port <= 65527,
                    'NEGATIVE_CONTEXT_IDENTITY')
            block = set(range(port - 1, port + 9))
            network = ipaddress.ip_network(subnet, strict=True)
            require(not block & ports and network.version == 4 and network.prefixlen == 24
                    and network.subnet_of(ipaddress.ip_network('10.253.0.0/16'))
                    and all(not network.overlaps(old) for old in networks), 'NEGATIVE_CONTEXT_COLLISION')
            projects.add(project); ports.update(block); networks.add(network)
            contexts[key] = {'root': str(root / key), 'project': project, 'port': port, 'subnet': str(network)}
        require(type(source_head) is str and re.fullmatch('[a-f0-9]{40}', source_head)
                and type(pins) is dict and pins and all(re.fullmatch('[a-f0-9]{64}', x) for x in pins.values()),
                'NEGATIVE_SOURCE_REVIEW')
        require(set(images) == set(ROLES)
                and all(re.fullmatch('sha256:[a-f0-9]{64}', x) for x in images.values()), 'NEGATIVE_IMAGE_REVIEW')
        # 현재 정식 Auth6 producer가 검증한 legacy 분기만 실행한다. mode2를 관측 후 승인하지 않는다.
        require(refresh_mode == 'legacy_v1', 'NEGATIVE_FIXED_REFRESH_MODE')
        require(type(daemon_id) is str and str(uuid.UUID(daemon_id)) == daemon_id, 'NEGATIVE_DAEMON_ID')
        operations = frozenset(approved_operations)
        require(operations <= {'prepare', 'create', 'issue', 'dispatch', 'close'}, 'NEGATIVE_APPROVAL_SCOPE')
        self._sealed = canonical({'decisionId': decision_id, 'root': str(root), 'contexts': contexts,
            'sourceHead': source_head, 'pins': pins, 'cliPath': str(cli_path), 'cliSha256': cli_sha256,
            'nodePath': str(node_path), 'nodeSha256': node_sha256, 'images': images,
            'daemonId': daemon_id,
            'refreshMode': refresh_mode, 'operations': sorted(operations)})

    def descriptor(self):
        return exact_json(self._sealed)

    @property
    def source_head(self):
        return self.descriptor()['sourceHead']

    @property
    def pins(self):
        return self.descriptor()['pins']


def operation_review(reviewed, operation):
    require(type(reviewed) is ReviewedAuthNegativePair, 'NEGATIVE_TYPED_REVIEW_REQUIRED')
    value = reviewed.descriptor()
    require(operation in value['operations'], 'NEGATIVE_OPERATION_NOT_APPROVED')
    return value


def anonymous_account(response, origin, scope, claims, now):
    """원 응답은 private에만 보존한다. 선언 claims만으로 실제 인증을 대신하지 않는다."""
    require(type(response) is dict and response.get('token_type') == 'bearer'
            and type(response.get('access_token')) is str and type(response.get('refresh_token')) is str,
            'NEGATIVE_ORIGINAL_RESPONSE')
    user = response.get('user')
    require(type(user) is dict and user.get('is_anonymous') is True and user.get('role') == 'authenticated'
            and user.get('email', '') in ('', None) and user.get('identities', []) == []
            and user.get('user_metadata') == {'fixture_scope_id': scope, 'fixture_case': 'anonymousBearer'},
            'NEGATIVE_ORIGINAL_ANONYMOUS_USER')
    uid = uuid_required(user['id']); session = uuid_required(claims.get('session_id'))
    require(claims.get('sub') == uid and claims.get('iss') == origin + '/auth/v1'
            and claims.get('aud') == 'authenticated' and claims.get('role') == 'authenticated'
            and claims.get('is_anonymous') is True and claims.get('email') == ''
            and claims.get('user_metadata') == user['user_metadata']
            and type(claims.get('iat')) is int and type(claims.get('exp')) is int
            and claims['iat'] <= now and claims['exp'] - claims['iat'] == 3600
            and claims['exp'] > now + 300, 'NEGATIVE_ORIGINAL_ANONYMOUS_CLAIMS')
    return {'userId': uid, 'sessionId': session, 'accessToken': response['access_token'],
            'expiresAt': claims['exp'], 'authEmail': ''}


def verify_anonymous_delta(before, after, rows, account, scope, refresh_mode, refresh_token):
    """v2.196.0: 신규 user/session/anonymous AMR, refresh 방식별 정확한0/1행. audit/identity0."""
    require(set(before) == set(after) == {'rows', 'authoritySha256', 'constraintsSha256', 'catalogSha256'}
            and all(before[k] == after[k] for k in before if k != 'rows')
            and set(before['rows']) == set(after['rows']), 'NEGATIVE_ANONYMOUS_AUTHORITY_CHANGED')
    names = {'auth.users', 'auth.sessions', 'auth.refresh_tokens', 'auth.mfa_amr_claims'}
    require(set(rows) == names and all(type(v) is list for v in rows.values()), 'NEGATIVE_ANONYMOUS_ROW_SET')
    require(len(rows['auth.users']) == len(rows['auth.sessions']) == len(rows['auth.mfa_amr_claims']) == 1
            and refresh_mode == 'legacy_v1' and len(rows['auth.refresh_tokens']) == 1,
            'NEGATIVE_ANONYMOUS_EXACT_COUNTS')
    expected = {table: dict(bag) for table, bag in before['rows'].items()}
    for table, entries in rows.items():
        for entry in entries:
            require(type(entry) is dict and set(entry) == {'sha256', 'row'}
                    and type(entry['row']) is dict and re.fullmatch('[a-f0-9]{64}', entry['sha256']),
                    'NEGATIVE_ANONYMOUS_ROW_PROOF')
            require(entry['sha256'] not in before['rows'][table], 'NEGATIVE_ANONYMOUS_ROW_NOT_NEW')
            expected[table][entry['sha256']] = 1
    user = rows['auth.users'][0]['row']; session = rows['auth.sessions'][0]['row']
    amr = rows['auth.mfa_amr_claims'][0]['row']
    require(user.get('id') == account['userId'] and user.get('is_anonymous') is True
            and user.get('email') in ('', None) and user.get('role') == 'authenticated'
            and user.get('phone') in ('', None) and user.get('encrypted_password') in ('', None)
            and user.get('banned_until') is None and user.get('deleted_at') is None
            and user.get('raw_user_meta_data') == {'fixture_scope_id': scope, 'fixture_case': 'anonymousBearer'}
            and session.get('id') == account['sessionId'] and session.get('user_id') == account['userId']
            and amr.get('session_id') == account['sessionId'] and amr.get('authentication_method') == 'anonymous',
            'NEGATIVE_ANONYMOUS_ROW_OWNER')
    refresh = rows['auth.refresh_tokens'][0]['row']
    require(session.get('refresh_token_hmac_key') is None and session.get('refresh_token_counter') is None
            and refresh.get('user_id') == account['userId'] and refresh.get('session_id') == account['sessionId']
            and refresh.get('revoked') is False and refresh.get('token') == refresh_token
            and refresh.get('parent') in ('', None), 'NEGATIVE_ANONYMOUS_LEGACY_REFRESH')
    require(after['rows'] == expected, 'NEGATIVE_ANONYMOUS_UNOWNED_ROW_CHANGED')


def rejection_proof(raw, case, token_sha):
    value = exact_json(raw)
    require(type(value) is dict, 'NEGATIVE_FACTORY_OBJECT')
    expected = {'status': 'PASS', 'case': case, 'httpStatus': 401,
        'authHttpStatus': value.get('authHttpStatus'), 'actualAuthReads': 1, 'rpcCalls': 0,
        'providerCalls': 0, 'nativeExternalAttempts': 0, 'originalTokenSha256': token_sha,
        'actualNaver': 'NOT_RUN', 'externalProvider': 'NOT_RUN'}
    require(case in ('anonymousBearer', 'differentOriginalContext') and value == expected
            and value['authHttpStatus'] in ((200,) if case == 'anonymousBearer' else (401, 403))
            and all(type(value[k]) is int for k in ('httpStatus', 'authHttpStatus', 'actualAuthReads',
                'rpcCalls', 'providerCalls', 'nativeExternalAttempts')), 'NEGATIVE_FACTORY_EXACT_PROOF')
    return value


def metadata_summary(raw, host=HOST):
    """기존 guard와 동일한 안정 metadata만 요약한다. 기존 DB/Storage는 읽지 않는다."""
    containers, networks, volumes = raw
    hashed = lambda value: digest(canonical(value))
    def mounts(value):
        return hashed(sorted(value, key=lambda item: canonical(item)))
    result = {'version': 1, 'scope': 'OBSERVED_EXISTING_RESOURCES_METADATA_ONLY',
        'profile': PROFILE, 'dockerHost': host,
        'containers': [{'id': c['Id'], 'name': c['Name'].removeprefix('/'), 'image': c['Image'],
            'labelsSha256': hashed(c['Config']['Labels']), 'configSha256': hashed(c['Config']),
            'hostConfigSha256': hashed(c['HostConfig']), 'mountsSha256': mounts(c['Mounts']),
            'state': {'running': c['State']['Running'], 'status': c['State']['Status'],
                      'oomKilled': c['State']['OOMKilled']}} for c in sorted(containers, key=lambda c: c['Id'])],
        'customNetworks': [{'id': n['Id'], 'name': n['Name'], 'inspectionSha256': hashed(n)}
                          for n in sorted(networks, key=lambda n: n['Id'])],
        'volumes': [{'name': v['Name'], 'inspectionSha256': hashed(v)}
                    for v in sorted(volumes, key=lambda v: v['Name'])],
        'existingDatabaseOrStorageRead': 'NOT_RUN', 'existingMutationCommands': 'NOT_RUN',
        'wholeStoredBytesPreserved': 'NOT_VERIFIED'}
    result['baselineMetadataSha256'] = hashed({k: result[k] for k in ('containers', 'customNetworks', 'volumes')})
    return result


def pair_inventory(before, after, contexts, images, final=False):
    """기존 exact inventory를 완화하지 않고 별도 승인한 두 project 추가만 확인한다."""
    added = {}
    for kind, key in (('containers', 'id'), ('customNetworks', 'id'), ('volumes', 'name')):
        old = {x[key]: x for x in before[kind]}; now = {x[key]: x for x in after[kind]}
        require(len(old) == len(before[kind]) and len(now) == len(after[kind])
                and all(now.get(identifier) == entry for identifier, entry in old.items()),
                'NEGATIVE_EXISTING_METADATA_CHANGED')
        added[kind] = [entry for identifier, entry in now.items() if identifier not in old]
    expected = {ROLES[role] + c['project']: images[role] for c in contexts.values() for role in ROLES}
    require(len(contexts) in (1, 2) and len(added['containers']) == 4 * len(contexts)
            and {x['name'] for x in added['containers']} == set(expected)
            and all(x['image'] == expected[x['name']] for x in added['containers']), 'NEGATIVE_EXACT_EIGHT_SERVICES')
    require({x['name'] for x in added['customNetworks']} == {'supabase_network_' + c['project'] for c in contexts.values()}
            and len(added['customNetworks']) == len(contexts)
            and {x['name'] for x in added['volumes']} == {'supabase_db_' + c['project'] for c in contexts.values()}
            and len(added['volumes']) == len(contexts), 'NEGATIVE_EXACT_PAIR_NETWORK_VOLUME')
    require(all(x['state']['oomKilled'] is False and x['state']['running'] is (not final)
                for x in added['containers']), 'NEGATIVE_PAIR_RUNNING_STATE')
    return added


def cleanup_inventory(before, after, contexts, images):
    """생성 실패도 읽기로 해결하되 승인된 새 이름/이미지/정확 ID 이외는 정리하지 않는다."""
    expected = {ROLES[role] + ctx['project']: images[role] for ctx in contexts.values() for role in ROLES}
    allowed = {'containers': set(expected),
        'customNetworks': {'supabase_network_' + ctx['project'] for ctx in contexts.values()},
        'volumes': {'supabase_db_' + ctx['project'] for ctx in contexts.values()}}
    added = {}
    for kind, key in (('containers', 'id'), ('customNetworks', 'id'), ('volumes', 'name')):
        old = {x[key]: x for x in before[kind]}; now = {x[key]: x for x in after[kind]}
        require(len(old) == len(before[kind]) and len(now) == len(after[kind])
                and all(now.get(identifier) == value for identifier, value in old.items()),
                'NEGATIVE_EXISTING_METADATA_CHANGED')
        entries = [value for identifier, value in now.items() if identifier not in old]
        require(len({x['name'] for x in entries}) == len(entries)
                and {x['name'] for x in entries} <= allowed[kind], 'NEGATIVE_UNOWNED_CLEANUP_RESOURCE')
        if kind == 'containers':
            require(all(x['image'] == expected[x['name']] for x in entries), 'NEGATIVE_CLEANUP_IMAGE_CHANGED')
        added[kind] = entries
    return added


def fixed_created_ids(owned, frozen):
    """정리 도중에도 처음 보존한 생성 ID 집합이 바뀌면 중단한다. 네트워크 endpoint 변화는 ID와 분리한다."""
    for kind, keys in (('containers', ('id', 'name', 'image')), ('customNetworks', ('id', 'name')),
                       ('volumes', ('name',))):
        projection = lambda entries: sorted(tuple(entry[key] for key in keys) for entry in entries)
        require(projection(owned[kind]) == projection(frozen[kind]), 'NEGATIVE_CLEANUP_CREATED_IDS_CHANGED')


class FixedPair:
    """검토된 기존 도구를 좁게 재사용하는 실제 포트. 일반 실행 callback/JSON 선택 없음."""
    def __init__(self, reviewed):
        self.reviewed = reviewed; self.value = reviewed.descriptor(); self.root = Path(self.value['root'])
        self.ai = support(reviewed)
        self.ai.private_temp_root(self.root)
        self.contexts = self.value['contexts']; self.base = ['docker', '--host', HOST]
        self.ports = {}; self.done = threading.Event(); self.failures = []; self.child = None
        self.samples = []; self.thread = None

    def save_bytes(self, root, name, raw):
        # 기존 LCP writer는 /private/tmp만 허용하므로 두 공식 temp 경계의 새 목적 writer를 사용한다.
        root = Path(root)
        require(re.fullmatch(r'[A-Za-z0-9-]+\.json', name) and type(raw) is bytes
                and len(raw) <= 2 * 1024 * 1024, 'NEGATIVE_PRIVATE_OUTPUT')
        self.ai.private_temp_root(root)
        before = root.lstat()
        parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            opened = os.fstat(parent)
            signature = lambda x: (x.st_dev, x.st_ino, x.st_mode, x.st_uid)
            require(signature(before) == signature(opened), 'NEGATIVE_OUTPUT_PARENT_CHANGED')
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK,
                         0o600, dir_fd=parent)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
            os.fsync(parent)
            require(signature(opened) == signature(root.lstat()), 'NEGATIVE_OUTPUT_PARENT_CHANGED')
        finally:
            os.close(parent)
        saved = self.private(root / name)
        require(saved == raw, 'NEGATIVE_PRIVATE_OUTPUT_CHANGED')
        return digest(saved)

    def save(self, root, name, value):
        return self.save_bytes(root, name, canonical(value))

    def private(self, path):
        return secure_private_bytes(Path(path), self.ai)

    def read(self, root, name):
        return self.ai.signed_exact_json(secure_private_bytes(Path(root) / name, self.ai))

    def call(self, arguments, data=None, timeout=25):
        result = subprocess.run(self.base + arguments, input=data, text=True, capture_output=True, timeout=timeout)
        require(result.returncode == 0, 'NEGATIVE_DOCKER_COMMAND_FAILED')
        return result.stdout.strip()

    def inventory(self):
        require(self.call(['context', 'inspect', CONTEXT, '--format', '{{.Endpoints.docker.Host}}']) == HOST,
                'NEGATIVE_SOCKET_CHANGED')
        require(self.call(['info', '--format', '{{.ID}}']) == self.value['daemonId'], 'NEGATIVE_DAEMON_CHANGED')
        ids = self.call(['ps', '-a', '--no-trunc', '--format', '{{.ID}}']).splitlines()
        containers = exact_json(self.call(['inspect', *ids])) if ids else []
        networks = [exact_json(x) for x in self.call(['network', 'ls', '--no-trunc', '--format', '{{json .}}']).splitlines()]
        net_ids = [n['ID'] for n in networks if n['Name'] not in ('bridge', 'host', 'none')]
        networks = exact_json(self.call(['network', 'inspect', *net_ids])) if net_ids else []
        names = self.call(['volume', 'ls', '--format', '{{.Name}}']).splitlines()
        volumes = exact_json(self.call(['volume', 'inspect', *names])) if names else []
        return containers, networks, volumes

    def memory(self, minimum):
        started = time.monotonic()
        result = subprocess.run(['colima', 'ssh', '--profile', PROFILE, '--', 'cat', '/proc/meminfo'],
                                capture_output=True, text=True, timeout=3)
        values = re.findall(r'^MemAvailable:\s+([0-9]+) kB$', result.stdout, re.M)
        require(result.returncode == 0 and len(values) == 1 and time.monotonic() - started <= 3,
                'NEGATIVE_MEMORY_READ')
        value = int(values[0]); self.samples.append(value)
        require(value >= minimum, 'NEGATIVE_MEMORY_LIMIT')
        return value

    def monitor(self):
        while not self.done.is_set():
            began = time.monotonic()
            try:
                self.memory(786432)
            except BaseException:
                self.failures.append('NEGATIVE_MONITOR_FAILED')
                return
            self.done.wait(max(0, began + 3 - time.monotonic()))

    def healthy(self):
        require(not self.failures and not self.done.is_set(), 'NEGATIVE_MONITOR_FAILED')

    def start_monitor(self):
        self.memory(1048576)
        self.thread = threading.Thread(target=self.monitor, daemon=True); self.thread.start()

    def finish_monitor(self):
        self.done.set()
        if self.thread is not None:
            self.thread.join(timeout=4)
            require(not self.thread.is_alive(), 'NEGATIVE_MONITOR_NOT_CLOSED')
        require(not self.failures, 'NEGATIVE_MONITOR_FAILED')

    def binary(self, path, expected, name):
        require(type(expected) is str and re.fullmatch('[a-f0-9]{64}', expected), 'NEGATIVE_BINARY_SHA')
        path = Path(path)
        require(path.is_absolute() and path.resolve() == path and path.name == name, 'NEGATIVE_BINARY_PATH')
        before = path.lstat()
        require(stat.S_ISREG(before.st_mode), 'NEGATIVE_BINARY_FILE')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            opened = os.fstat(fd)
            require(stat.S_ISREG(opened.st_mode) and opened.st_uid in (0, os.getuid())
                    and opened.st_nlink == 1 and not opened.st_mode & 0o022 and opened.st_mode & 0o111
                    and opened.st_size <= 256 * 1024 * 1024, 'NEGATIVE_BINARY_FILE')
            h = hashlib.sha256(); started = time.monotonic()
            while True:
                require(time.monotonic() - started <= 15, 'NEGATIVE_BINARY_TIMEOUT')
                block = os.read(fd, 1048576)
                if not block: break
                h.update(block)
            signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode)
            require(signature(before) == signature(opened) == signature(os.fstat(fd)) == signature(path.lstat())
                    and h.hexdigest() == expected, 'NEGATIVE_BINARY_CHANGED')
        finally:
            os.close(fd)

    def source(self):
        require(source_pins(self.reviewed.source_head)[1] == self.reviewed.pins, 'NEGATIVE_SOURCE_CHANGED')
        self.healthy()

    def prepare(self):
        operation_review(self.reviewed, 'prepare')
        require(not any(Path(c['root']).exists() for c in self.contexts.values()), 'NEGATIVE_PREVIOUS_PREPARATION')
        from prepare_database import prepare_database, anonymous_negative_config
        from prepare_migrations import prepare
        for kind, ctx in self.contexts.items():
            if kind == 'foreign':
                prepare_database(ROOT, Path(ctx['root']), project_id=ctx['project'], port_base=ctx['port'])
            else:
                report = prepare(ROOT, Path(ctx['root'])); root = Path(report['output_root'])
                root.chmod(0o700)
                source = (ROOT / 'backend/supabase/config.toml').read_bytes()
                config, overlay = anonymous_negative_config(source, ctx['project'], ctx['port'])
                with (root / 'supabase/config.toml').open('xb') as stream: stream.write(config)
                report.update(pending=[], config_sha256=digest(config), source_config_sha256=digest(source),
                    config_overlay=overlay, total_count=report['count'], auth_negative_purpose=PURPOSE,
                    runtime_readiness='NOT_VERIFIED', port_availability='NOT_VERIFIED')
                self.save(root, 'database-manifest.json', report)
            root = Path(ctx['root']); root.chmod(0o700)
            for path in root.rglob('*'):
                path.chmod(0o700 if path.is_dir() else 0o600)
        self.save(self.root, 'pair-prepared.json', {'scope': SCOPE, 'status': 'PREPARED_NOT_EXECUTED',
            'reviewSha256': digest(self.reviewed._sealed), 'sourceHead': self.reviewed.source_head,
            'sourcePins': self.reviewed.pins, 'contexts': self.contexts,
            'anonymousOnlyOverlay': PURPOSE, 'actualAuth': 'NOT_RUN', 'fullLifecycleCoverage': 'NOT_RUN'})

    def create(self):
        operation_review(self.reviewed, 'create'); self.source()
        require(self.read(self.root, 'pair-prepared.json')['reviewSha256'] == digest(self.reviewed._sealed),
                'NEGATIVE_PREPARED_REVIEW_CHANGED')
        before = metadata_summary(self.inventory())
        projects = {c['project'] for c in self.contexts.values()}
        require(not any(x['name'].endswith(tuple(projects)) for k in ('containers', 'customNetworks', 'volumes')
                        for x in before[k]), 'NEGATIVE_FRESH_PROJECT_REQUIRED')
        self.save(self.root, 'pair-before-private.json', before)
        self.save(self.root, 'pair-create-intent.json', {'scope': SCOPE, 'sourceHead': self.reviewed.source_head,
            'reviewSha256': digest(self.reviewed._sealed), 'beforeSha256': digest(canonical(before)),
            'contexts': self.contexts, 'exactServices': 8, 'noReplay': True})
        self.binary(self.value['cliPath'], self.value['cliSha256'], 'supabase')
        for image in self.value['images'].values():
            captured = exact_json(self.call(['image', 'inspect', image]))
            require(len(captured) == 1 and captured[0]['Id'] == image, 'NEGATIVE_CACHED_IMAGE_REQUIRED')
        auth_image = exact_json(self.call(['image', 'inspect', self.value['images']['auth']]))[0]
        require(any(tag.endswith('/gotrue:v2.196.0') for tag in auth_image.get('RepoTags') or []),
                'NEGATIVE_GOTRUE_FIXED_VERSION')
        completed = {}
        for key, ctx in self.contexts.items():
            self.source(); self.memory(1048576)
            network = self.call(['network', 'create', '--subnet', ctx['subnet'], '--label',
                'com.supabase.cli.project=' + ctx['project'], 'supabase_network_' + ctx['project']])
            self.save(ctx['root'], 'network-created.json', {'id': network, 'name': 'supabase_network_' + ctx['project']})
            env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR')}
            env.update(DOCKER_HOST=HOST, DOCKER_CONTEXT=CONTEXT, SUPABASE_TELEMETRY_DISABLED='true')
            log_path = Path(ctx['root']) / 'startup-private.log'
            with os.fdopen(os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as log:
                child = subprocess.Popen([self.value['cliPath'], 'start', '--network-id', network,
                    '--workdir', ctx['root'], '--exclude', EXCLUDE], stdout=log, stderr=subprocess.STDOUT,
                    env=env, start_new_session=True)
                self.child = child
                self.wait_child(child, 240)
                require(child.returncode == 0, 'NEGATIVE_CREATE_FAILED_NO_REPLAY')
                self.close_child(ctx['root'], 'startup')
            current = metadata_summary(self.inventory())
            # 모든 기존 객체는 생성 중에도 동일해야 한다. 신규는 최종 exact pair 검사에서 닫는다.
            for kind, identity in (('containers', 'id'), ('customNetworks', 'id'), ('volumes', 'name')):
                now = {x[identity]: x for x in current[kind]}
                require(all(now.get(x[identity]) == x for x in before[kind]), 'NEGATIVE_EXISTING_METADATA_CHANGED')
            completed[key] = ctx
            pair_inventory(before, current, completed, self.value['images'])
        raw = self.inventory(); after = metadata_summary(raw)
        added = pair_inventory(before, after, self.contexts, self.value['images'])
        self.save(self.root, 'pair-created-private.json', {'scope': SCOPE, 'before': before, 'after': after, 'added': added})
        # 상대 context를 포함하는 baseline/intent는 여기에서 처음 고정한다. 기존 intent를 재작성하지 않는다.
        for key, ctx in self.contexts.items():
            project = ctx['project']; root = Path(ctx['root'])
            own_c = [x for x in after['containers'] if x['name'].endswith('_' + project)]
            own_n = [x for x in after['customNetworks'] if x['name'].endswith('_' + project)]
            own_v = [x for x in after['volumes'] if x['name'].endswith('_' + project)]
            baseline = metadata_summary(([x for x in raw[0] if x['Id'] not in {c['id'] for c in own_c}],
                [x for x in raw[1] if x['Id'] not in {n['id'] for n in own_n}],
                [x for x in raw[2] if x['Name'] not in {v['name'] for v in own_v}]))
            baseline_sha = self.save(root, 'protected-resource-baseline.json', baseline)
            self.save(root, 'owned-containers.json', [{k: x[k] for k in ('id', 'name', 'image')} for x in own_c])
            self.save(root, 'owned-networks.json', [{k: x[k] for k in ('id', 'name')} for x in own_n])
            self.save(root, 'owned-volumes.json', [{'name': x['name']} for x in own_v])
            self.save(root, 'execution-intent.json', {'version': 2, 'context': CONTEXT, 'dockerHost': HOST,
                'project': project, 'scope': 'new-synthetic-only', 'preservedBaselineSha256': baseline_sha,
                'existingContainers': [{k: x[k] for k in ('id', 'name')} for x in baseline['containers']],
                'existingNetworks': [{k: x[k] for k in ('id', 'name')} for x in baseline['customNetworks']]})
            containers = {role: {'id': item['id'], 'name': item['name'], 'image': item['image'],
                'configSha256': item['configSha256'], 'hostConfigSha256': item['hostConfigSha256'],
                'mountsSha256': item['mountsSha256']} for role in ROLES
                for item in own_c if item['name'] == ROLES[role] + project}
            env = {'PATH': os.environ.get('PATH', ''), 'HOME': str(Path.home()), 'DOCKER_HOST': HOST,
                   'DOCKER_CONTEXT': CONTEXT, 'SUPABASE_TELEMETRY_DISABLED': 'true'}
            status = subprocess.run([self.value['cliPath'], 'status', '--workdir', ctx['root'], '-o', 'json'],
                capture_output=True, env=env, timeout=20)
            require(status.returncode == 0, 'NEGATIVE_STATUS_FAILED')
            credentials = exact_json(status.stdout)
            self.save(root, 'reviewed-runtime-private.json', {'containers': containers,
                'credentials': {'anon': credentials['ANON_KEY'], 'service': credentials['SERVICE_ROLE_KEY']},
                'sourcePins': self.ai.signed_source_pins(), 'pairReviewSha256': digest(self.reviewed._sealed)})
        self.bind_ports()
        for key, port in self.ports.items():
            ctx = self.contexts[key]; db = port.target['id']
            self.live(identity_only=True)
            self.save(ctx['root'], 'closed-cron-intent.json', {'scope': SCOPE, 'targetId': db,
                'sql': "ALTER SYSTEM SET cron.launch_active_jobs='off'", 'singleAttempt': True})
            self.call(['exec', '-i', db, 'psql', '-XqAt', '-h', '/var/run/postgresql', '-U', 'supabase_admin',
                '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
                "ALTER SYSTEM SET cron.launch_active_jobs='off';select pg_reload_conf();")
            for _ in range(20):
                if port.read_sql("select current_setting('cron.launch_active_jobs');") == 'off': break
                time.sleep(.2)
            else: raise ValueError('NEGATIVE_CRON_NOT_CLOSED')
        self.live()
        self.save(self.root, 'pair-history.json', {'scope': SCOPE, 'contexts': self.history(),
            'sourceHead': self.reviewed.source_head})
        self.live()
        self.save(self.root, 'pair-ready.json', {'scope': SCOPE, 'status': 'PASS_PAIR_CREATED_NOT_ISSUED',
            'reviewSha256': digest(self.reviewed._sealed), 'sourceHead': self.reviewed.source_head})

    def anonymous_target(self, root):
        from prepare_database import anonymous_negative_config
        from prepare_migrations import inspect_migrations
        manifest = self.read(root, 'database-manifest.json'); overlay = manifest['config_overlay']
        ctx = self.contexts['anonymous']
        require(Path(ctx['root']) == root and overlay['project_id'] == ctx['project']
                and overlay['api.port'] == ctx['port'], 'NEGATIVE_ANONYMOUS_REVIEW_TARGET')
        source = (ROOT / 'backend/supabase/config.toml').read_bytes()
        expected, expected_overlay = anonymous_negative_config(source, overlay['project_id'], overlay['api.port'])
        require(manifest.get('auth_negative_purpose') == PURPOSE and overlay == expected_overlay
                and manifest['config_sha256'] == digest(expected)
                and manifest['source_config_sha256'] == digest(source)
                and self.private(root / 'supabase/config.toml') == expected
                and manifest['sql_execution'] == 'NOT_RUN', 'NEGATIVE_ANONYMOUS_CONFIG')
        history = inspect_migrations(ROOT)
        require(manifest['migrations'] == history['migrations'] and len(history['migrations']) == 121,
                'NEGATIVE_CURRENT_HISTORY')
        directory = root / 'supabase/migrations'
        require({p.name for p in directory.iterdir()} == {Path(e['path']).name for e in history['migrations']},
                'NEGATIVE_MIGRATION_SET')
        for entry in history['migrations']:
            require(digest(self.private(directory / Path(entry['path']).name)) == entry['sha256'],
                    'NEGATIVE_MIGRATION_CHANGED')
        from run_database_tests import preserved_contract, preserved_resource_pins
        intent = self.read(root, 'execution-intent.json'); own = self.read(root, 'owned-containers.json')
        require(intent['project'] == overlay['project_id'] and intent['context'] == CONTEXT
                and intent['dockerHost'] == HOST, 'NEGATIVE_PREPARED_AUTHORITY')
        preserved_contract(root, intent, own, HOST, intent['project'])
        db = [x for x in own if x['name'] == ROLES['db'] + intent['project']]
        require(len(db) == 1, 'NEGATIVE_EXACT_DATABASE')
        return {'context': CONTEXT, 'host': HOST, 'project': intent['project'], 'container': db[0]['name'],
            'id': db[0]['id'], 'image': db[0]['image'], 'versions': [e['version'] for e in history['migrations']],
            'preservedResourcePins': preserved_resource_pins(root, intent)}

    def anonymous_negative_ports(self, reviewed, root):
        """표준 closed target과 분리한 exact-purpose typed adapter constructor. SQL/HTTP 전 검사한다."""
        require(type(reviewed) is self.ai.ReviewedSignedProvisioning and reviewed.prepared_root == root,
                'NEGATIVE_ANONYMOUS_TYPED_PORTS')
        target = self.anonymous_target(root)
        origin = 'http://127.0.0.1:' + str(self.contexts['anonymous']['port'])
        self.ai.provisioning_metadata(reviewed, target, origin)
        ai = self.ai; base = self.base
        class AnonymousNegativePorts(ai.FixedLifecycleProvisioningPorts):
            def __init__(adapter):
                # 부모 constructor의 일반 closed config 검사는 이 별도 목적의 검사를 대신하지 않는다.
                adapter.reviewed = reviewed; adapter.target = target; adapter.base = base; adapter.origin = origin
                adapter.runner = object.__new__(ai.SignedRunner)
                adapter.runner.root = root; adapter.runner.target = target; adapter.runner.base = base
                adapter.runner.binding = {'containers': reviewed.containers, 'sourcePins': reviewed.source_pins}
        return AnonymousNegativePorts()

    def bind_ports(self):
        for key, ctx in self.contexts.items():
            root = Path(ctx['root']); packet = self.read(root, 'reviewed-runtime-private.json')
            require(packet['pairReviewSha256'] == digest(self.reviewed._sealed)
                    and packet['sourcePins'] == self.ai.signed_source_pins(), 'NEGATIVE_RUNTIME_REVIEW')
            reviewed = self.ai.ReviewedSignedProvisioning(self.value['decisionId'], root,
                packet['sourcePins'], packet['containers'], packet['credentials'], int(time.time()) + 301)
            if key == 'foreign':
                port = self.ai.FixedLifecycleProvisioningPorts(reviewed)
                self.ai.provisioning_metadata(reviewed, port.target, 'http://127.0.0.1:' + str(ctx['port']))
            else:
                port = self.anonymous_negative_ports(reviewed, root)
            port.origin = 'http://127.0.0.1:' + str(ctx['port'])
            self.ports[key] = port

    def live(self, identity_only=False):
        self.source(); self.memory(786432)
        require(self.call(['info', '--format', '{{.ID}}']) == self.value['daemonId'], 'NEGATIVE_DAEMON_CHANGED')
        for key, port in self.ports.items():
            require(port.identity() == port.reviewed.containers, 'NEGATIVE_IDENTITY_CHANGED')
            auth = exact_json(self.call(['inspect', port.reviewed.containers['auth']['id']]))[0]
            env = auth['Config']['Env']
            expected = {'GOTRUE_JWT_EXP': '3600', 'GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED': 'true' if key == 'anonymous' else 'false',
                        'GOTRUE_DISABLE_SIGNUP': 'false' if key == 'anonymous' else 'true'}
            if key == 'anonymous': expected['GOTRUE_EXTERNAL_EMAIL_ENABLED'] = 'false'
            for name, value in expected.items():
                require([x.split('=', 1)[1] for x in env if x.startswith(name + '=')] == [value],
                        'NEGATIVE_FIXED_AUTH_SETTINGS')
            modes = [x.split('=', 1)[1] for x in env if x.startswith('GOTRUE_SECURITY_REFRESH_TOKEN_ALGORITHM_VERSION=')]
            require(self.value['refreshMode'] == 'legacy_v1' and modes in ([], ['0'], ['1']),
                    'NEGATIVE_REVIEWED_REFRESH_MODE_CHANGED')
            if not identity_only:
                controls = port.closed_controls()
                require(set(controls) == set(self.ai.PROVISION_CLOSED_CONTROLS) | {'cronLaunchActiveJobs'}
                        and controls['cronLaunchActiveJobs'] == 'off'
                        and all(controls[k] is False for k in self.ai.PROVISION_CLOSED_CONTROLS),
                        'NEGATIVE_CLOSED_CONTROLS_REQUIRED')

    def history(self):
        # 정식 121 사본뿐 아니라 실제 DB 이력을 매 증거 수집 전후 대조한다.
        values = {}
        require(set(self.ports) == {'anonymous', 'foreign'}, 'NEGATIVE_BOTH_CONTEXTS_REQUIRED')
        for key, port in self.ports.items():
            require(len(port.target['versions']) == 121 and len(set(port.target['versions'])) == 121,
                    'NEGATIVE_CURRENT_HISTORY')
            proof = port.history()
            require(proof == {'method': 'SUPABASE_DB_HISTORY', 'native': 'NOT_RUN'},
                    'NEGATIVE_ACTUAL_DB_HISTORY_REQUIRED')
            values[key] = {'proof': proof, 'versionCount': 121,
                'versionsSha256': digest(canonical(port.target['versions']))}
        return values

    def snapshots(self):
        self.live(); before_history = self.history()
        values = {key: self.ai.lcp_snapshot(port.snapshot()) for key, port in self.ports.items()}
        require(self.history() == before_history, 'NEGATIVE_ACTUAL_DB_HISTORY_CHANGED')
        self.live()
        return values

    def request(self, key, method, path, token, body=None):
        require((method == 'POST' and key == 'anonymous' and path == '/signup'
                 and body == {'data': {'fixture_scope_id': self.scope, 'fixture_case': 'anonymousBearer'}})
                or (method == 'GET' and path == '/user' and body is None), 'NEGATIVE_EXACT_HTTP_SCOPE')
        self.live(); port = self.ports[key]
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args): return None
        request = urllib.request.Request(port.origin + '/auth/v1' + path,
            data=None if body is None else canonical(body), method=method,
            headers={'authorization': 'Bearer ' + token, 'apikey': port.reviewed.credentials['anon'],
                     'content-type': 'application/json'})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            try:
                with opener.open(request, timeout=5) as response: status, raw = response.status, response.read(65537)
            except urllib.error.HTTPError as error: status, raw = error.code, error.read(65537)
            require(len(raw) <= 65536, 'NEGATIVE_HTTP_SIZE')
            return status, raw, exact_json(raw)
        finally:
            self.live()

    def anonymous_rows(self, account):
        q = self.ai.quote; uid = q(account['userId']) + '::uuid'; sid = q(account['sessionId']) + '::uuid'
        predicates = {'auth.users': 'r.id=' + uid, 'auth.sessions': 'r.id=' + sid + ' and r.user_id=' + uid,
            'auth.refresh_tokens': 'r.session_id=' + sid + ' and r.user_id::uuid=' + uid,
            'auth.mfa_amr_claims': 'r.session_id=' + sid}
        fields = []
        for table, predicate in predicates.items():
            fields.extend((q(table), "(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(r),'sha256',encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex'))order by to_jsonb(r)::text),'[]'::jsonb)from " + table + ' r where ' + predicate + ')'))
        return exact_json(self.ports['anonymous'].read_sql('select jsonb_build_object(' + ','.join(fields) + ');', timeout=5))

    def issue(self):
        operation_review(self.reviewed, 'issue'); self.bind_ports(); self.live()
        require(self.read(self.root, 'create-monitor.json')['status'] == 'PASS', 'NEGATIVE_CREATE_MONITOR_REQUIRED')
        require(self.read(self.root, 'pair-ready.json')['reviewSha256'] == digest(self.reviewed._sealed),
                'NEGATIVE_READY_REVIEW_CHANGED')
        self.scope = uuid.uuid4().hex
        before = self.snapshots()
        self.save(self.root, 'issue-intent.json', {'scope': SCOPE, 'scopeId': self.scope,
            'sourceHead': self.reviewed.source_head, 'noReplay': True, 'noResend': True})
        self.save(self.root, 'before-issuance-private.json', before)
        after = None; completed = False
        try:
            foreign = self.ports['foreign']; ctx = self.contexts['foreign']
            reviewed = self.ai.ReviewedSignedProvisioning(self.value['decisionId'], Path(ctx['root']),
                foreign.reviewed.source_pins, foreign.reviewed.containers, foreign.reviewed.credentials,
                int(time.time()) + 900)
            foreign_receipt = self.ai.provision_signed_accounts(Path(ctx['root']), reviewed)
            require(foreign_receipt['status'] == 'PASS_LOCAL_AUTH6_PROVISION_ONLY'
                    and type(foreign_receipt['accounts']) is int and foreign_receipt['accounts'] == 6
                    and foreign_receipt['originalRowsPreserved'] is True
                    and foreign_receipt['actualGoTrueAndDatabaseSessions'] is True
                    and foreign_receipt['actualNaver'] == 'NOT_RUN', 'NEGATIVE_FOREIGN_FORMAL_AUTH6_REQUIRED')
            binding_raw = self.private(Path(ctx['root']) / 'signed-ai-binding-private.json')
            require(digest(binding_raw) == foreign_receipt['bindingSha256'], 'NEGATIVE_FOREIGN_BINDING_SHA')
            binding = exact_json(binding_raw); account = binding['accounts'][0]
            self.ai.validate_signed_binding(binding, Path(ctx['root']), foreign.target)
            foreign_after = self.snapshots()
            require(foreign_after['anonymous'] == before['anonymous'], 'NEGATIVE_OTHER_CONTEXT_CHANGED')
            self.live(); self.memory(1048576)
            body = {'data': {'fixture_scope_id': self.scope, 'fixture_case': 'anonymousBearer'}}
            self.save(self.root, 'anonymous-signup-intent.json', {'scope': SCOPE, 'scopeId': self.scope,
                'method': 'POST', 'path': '/signup', 'body': body, 'singleAttempt': True, 'noResend': True})
            status, raw, response = self.request('anonymous', 'POST', '/signup',
                self.ports['anonymous'].reviewed.credentials['anon'], body)
            self.save_bytes(self.root, 'anonymous-issued-response-private.json', raw)
            require(status == 200, 'NEGATIVE_ANONYMOUS_ISSUANCE_FAILED')
            anonymous = anonymous_account(response, self.ports['anonymous'].origin, self.scope,
                self.ai.signed_claims(response.get('access_token')), time.time())
            status, _, user = self.request('anonymous', 'GET', '/user', anonymous['accessToken'])
            require(status == 200 and user.get('id') == anonymous['userId']
                    and user.get('is_anonymous') is True and user.get('role') == 'authenticated',
                    'NEGATIVE_ACTUAL_ANONYMOUS_AUTH_REQUIRED')
            after = self.snapshots(); rows = self.anonymous_rows(anonymous)
            self.save(self.root, 'after-issuance-private.json', {'snapshots': after, 'anonymousRows': rows})
            require(after['foreign'] == foreign_after['foreign'], 'NEGATIVE_FOREIGN_ROWS_CHANGED')
            verify_anonymous_delta(foreign_after['anonymous'], after['anonymous'], rows, anonymous,
                self.scope, self.value['refreshMode'], response['refresh_token'])
            self.save(self.root, 'anonymous-issued.json', {'scope': SCOPE, 'scopeId': self.scope,
                'sourceHead': self.reviewed.source_head, 'userId': anonymous['userId'],
                'sessionId': anonymous['sessionId'], 'tokenSha256': digest(anonymous['accessToken'].encode()),
                'responseSha256': digest(raw), 'expiresAt': anonymous['expiresAt'],
                'origin': self.ports['anonymous'].origin,
                'authContainerId': self.ports['anonymous'].reviewed.containers['auth']['id'],
                'refreshMode': self.value['refreshMode'], 'wire': 'POST /signup', 'actualAuth200': True,
                'officialVersion': 'v2.196.0'})
            self.save(self.root, 'negative-input-private.json', {'scope': SCOPE, 'scopeId': self.scope,
                'sourceHead': self.reviewed.source_head, 'reviewSha256': digest(self.reviewed._sealed),
                'anonymous': anonymous, 'foreign': account, 'foreignAuth6Receipt': foreign_receipt,
                'foreignBindingSha256': digest(binding_raw), 'selectedForeignIndex': 0,
                'anonymousResponseSha256': digest(raw), 'baseline': after})
            self.live(); completed = True
            self.save(self.root, 'issuance-receipt.json', {'scope': SCOPE,
                'status': 'PASS_ORIGINAL_ANONYMOUS_AND_FOREIGN_INPUTS_ONLY',
                'inputSha256': digest(self.private(self.root / 'negative-input-private.json')),
                'actualCases': 'NOT_RUN', 'fullLifecycleCoverage': 'NOT_RUN'})
        except BaseException:
            self.save(self.root, 'issue-failure.json', {'scope': SCOPE, 'status': 'UNKNOWN',
                'noResend': True, 'noReplay': True, 'readOnlyResolutionRequired': True})
            raise
        finally:
            record = {'scope': SCOPE, 'status': 'UNAVAILABLE_NOT_PROOF'}
            try:
                record.update(status='CAPTURED_NOT_PROOF', snapshots=self.snapshots())
            except BaseException:
                pass
            self.save(self.root, 'issuance-final-private.json', record)
            if completed:
                require(record['status'] == 'CAPTURED_NOT_PROOF' and record['snapshots'] == after,
                        'NEGATIVE_ISSUANCE_FINAL_PRESERVATION_UNPROVEN')
                self.live()

    def wait_child(self, child, timeout):
        began = time.monotonic()
        while True:
            self.healthy()
            remaining = timeout - (time.monotonic() - began)
            require(remaining > 0, 'NEGATIVE_OWN_CHILD_TIMEOUT')
            try:
                return child.communicate(timeout=min(.25, remaining))
            except subprocess.TimeoutExpired:
                continue

    def close_child(self, root, label):
        if self.child is None: return
        observer_path = ROOT / 'tools/local/observe_isolated.py'
        require(digest(observer_path.read_bytes()) == self.reviewed.pins['tools/local/observe_isolated.py'],
                'NEGATIVE_OBSERVER_SOURCE_CHANGED')
        # 원 고정 helper 세 개만 선택한다. loader/JSON으로 다른 실행 함수를 주입하지 않는다.
        names = {'group_alive', 'verify_group_closed', 'terminate'}
        nodes = [n for n in ast.parse(observer_path.read_bytes()).body if isinstance(n, ast.FunctionDef) and n.name in names]
        require({n.name for n in nodes} == names, 'NEGATIVE_TERMINATOR_SET')
        namespace = {'os': os, 'signal': signal, 'subprocess': subprocess, 'time': time}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(observer_path), 'exec'), namespace)
        process = self.child; namespace['terminate'](process)
        require(process.poll() is not None and not namespace['group_alive'](process), 'NEGATIVE_OWN_CHILD_NOT_CLOSED')
        self.save(root, label + '-closed.json', {'scope': SCOPE, 'exited': True,
            'exitCode': process.returncode, 'ownedGroupClosed': True, 'signalsOnlyExactNewSession': True})
        self.child = None

    def capsule(self):
        cap = self.read(self.root, 'capsule-review.json')
        expected = {**self.ai.product_graph(), 'tests/integration/jonghyun/isolated_ai_factory.ts':
            self.reviewed.pins['tests/integration/jonghyun/isolated_ai_factory.ts']}
        require(Path(cap['capsuleRoot']).is_relative_to(self.root) and cap['capsulePins'] == expected
                and cap['nodePath'] == self.value['nodePath'] and cap['nodeSha256'] == self.value['nodeSha256'],
                'NEGATIVE_CAPSULE_REVIEW')
        self.ai.sealed_runtime_capsule(self.reviewed.source_head, Path(cap['capsuleRoot']), expected, expected)
        self.binary(cap['nodePath'], cap['nodeSha256'], 'node')
        return cap

    def dispatch(self):
        operation_review(self.reviewed, 'dispatch'); self.bind_ports(); self.live()
        require(self.read(self.root, 'issue-monitor.json')['status'] == 'PASS', 'NEGATIVE_ISSUE_MONITOR_REQUIRED')
        receipt = self.read(self.root, 'issuance-receipt.json')
        raw = self.private(self.root / 'negative-input-private.json')
        require(receipt['status'] == 'PASS_ORIGINAL_ANONYMOUS_AND_FOREIGN_INPUTS_ONLY'
                and receipt['inputSha256'] == digest(raw), 'NEGATIVE_ISSUANCE_CHAIN')
        value = exact_json(raw); self.scope = value['scopeId']
        require(value['reviewSha256'] == digest(self.reviewed._sealed)
                and value['sourceHead'] == self.reviewed.source_head and value['selectedForeignIndex'] == 0,
                'NEGATIVE_ORIGINAL_INPUT_CHANGED')
        foreign_root = Path(self.contexts['foreign']['root'])
        binding_raw = self.private(foreign_root / 'signed-ai-binding-private.json')
        self.ai.validate_signed_binding(exact_json(binding_raw), foreign_root, self.ports['foreign'].target)
        foreign_receipt = value['foreignAuth6Receipt']
        require(foreign_receipt['status'] == 'PASS_LOCAL_AUTH6_PROVISION_ONLY'
                and type(foreign_receipt['accounts']) is int and foreign_receipt['accounts'] == 6
                and foreign_receipt['originalRowsPreserved'] is True
                and foreign_receipt['actualGoTrueAndDatabaseSessions'] is True
                and foreign_receipt['actualNaver'] == 'NOT_RUN', 'NEGATIVE_FOREIGN_FORMAL_AUTH6_REQUIRED')
        require(digest(binding_raw) == value['foreignBindingSha256'] == value['foreignAuth6Receipt']['bindingSha256']
                and self.read(foreign_root / ('auth-provision-' + value['foreignAuth6Receipt']['scopeId']), 'receipt.json')
                    == value['foreignAuth6Receipt']
                and exact_json(binding_raw)['accounts'][0] == value['foreign'], 'NEGATIVE_FOREIGN_ORIGINAL_PROVENANCE')
        response_raw = self.private(self.root / 'anonymous-issued-response-private.json')
        response = exact_json(response_raw)
        require(digest(response_raw) == value['anonymousResponseSha256'], 'NEGATIVE_ANONYMOUS_RESPONSE_CHANGED')
        require(anonymous_account(response, self.ports['anonymous'].origin, self.scope,
                self.ai.signed_claims(response['access_token']), time.time()) == value['anonymous'],
                'NEGATIVE_ANONYMOUS_ORIGINAL_ACCOUNT_CHANGED')
        issued = self.read(self.root, 'anonymous-issued.json')
        require(issued['scope'] == SCOPE and issued['scopeId'] == self.scope
                and issued['responseSha256'] == digest(response_raw)
                and issued['userId'] == value['anonymous']['userId']
                and issued['sessionId'] == value['anonymous']['sessionId']
                and issued['tokenSha256'] == digest(value['anonymous']['accessToken'].encode())
                and issued['origin'] == self.ports['anonymous'].origin
                and issued['authContainerId'] == self.ports['anonymous'].reviewed.containers['auth']['id'],
                'NEGATIVE_ANONYMOUS_ISSUANCE_RECEIPT_CHANGED')
        cap = self.capsule(); baseline = self.snapshots()
        require(baseline == value['baseline'], 'NEGATIVE_ORIGINAL_BASELINE_CHANGED')
        self.save(self.root, 'dispatch-intent.json', {'scope': SCOPE, 'sourceHead': self.reviewed.source_head,
            'inputSha256': digest(raw), 'noReplay': True, 'cases': ['anonymousBearer', 'differentOriginalContext']})
        self.save(self.root, 'before-cases-private.json', baseline)
        proofs = {}; errors = []; final_preserved = False
        try:
            for case, key in (('anonymousBearer', 'anonymous'), ('differentOriginalContext', 'foreign')):
                account = value[key]
                require(type(account['expiresAt']) is int and account['expiresAt'] > time.time() + 300,
                        'NEGATIVE_ORIGINAL_TOKEN_HEADROOM')
                status, _, user = self.request(key, 'GET', '/user', account['accessToken'])
                require(status == 200 and user.get('id') == account['userId']
                        and user.get('is_anonymous') is (key == 'anonymous'), 'NEGATIVE_ACTUAL_ORIGINAL_AUTH')
                if key == 'anonymous':
                    # 기존 session_proof는 normal Auth6 전용(not is_anonymous)이므로 정확 익명 조건으로 읽는다.
                    q = self.ai.quote
                    query = ('select exists(select 1 from auth.users u join auth.sessions s on s.user_id=u.id '
                             'where u.id=' + q(account['userId']) + '::uuid and s.id='
                             + q(account['sessionId']) + '::uuid and u.is_anonymous and u.raw_user_meta_data='
                             + q(json.dumps({'fixture_scope_id': self.scope, 'fixture_case': 'anonymousBearer'}))
                             + '::jsonb);')
                    require(self.ports[key].read_sql(query) == 't', 'NEGATIVE_ORIGINAL_ANONYMOUS_SESSION')
                if key == 'foreign':
                    a, f = self.ports['anonymous'], self.ports['foreign']
                    require(a.origin != f.origin and all(a.reviewed.containers[k]['id'] != f.reviewed.containers[k]['id']
                            for k in ('db', 'auth')) and self.ports['anonymous'].read_sql(
                            'select not exists(select 1 from auth.users where id=' + self.ai.quote(account['userId']) + '::uuid);') == 't',
                            'NEGATIVE_FOREIGN_CONTEXT_NOT_DISTINCT')
                    require(self.ports['foreign'].session_proof(account), 'NEGATIVE_FOREIGN_ORIGINAL_SESSION')
                self.capsule(); self.live(); self.memory(1048576)
                fixture = {'codeRoot': cap['capsuleRoot'], 'origin': self.ports['anonymous'].origin,
                    'anon': self.ports['anonymous'].reviewed.credentials['anon'],
                    'service': self.ports['anonymous'].reviewed.credentials['service'],
                    'signedLocalAuth': True, 'authLifecycleScenario': True, 'lifecycleCase': case,
                    'originalUserId': account['userId'], 'originalToken': account['accessToken'],
                    'productManifest': self.ai.product_graph(), 'aiLedgerId': 'synthetic-lifecycle-never-reserved'}
                name = case.lower(); self.save(self.root, name + '-factory-private.json', fixture)
                self.save(self.root, name + '-factory-intent.json', {'scope': SCOPE, 'case': case,
                    'tokenSha256': digest(account['accessToken'].encode()), 'singleAttempt': True, 'noReplay': True})
                self.healthy()
                self.child = subprocess.Popen([self.value['nodePath'], '--experimental-strip-types',
                    str(Path(cap['capsuleRoot']) / 'tests/integration/jonghyun/isolated_ai_factory.ts'),
                    str(self.root / (name + '-factory-private.json')), '--signed-auth-lifecycle-case'],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                    env=self.ai.midnight_minimal_env(self.root))
                try:
                    output, error = self.wait_child(self.child, 30)
                    self.save(self.root, name + '-factory-outcome.json', {'scope': SCOPE,
                        'exitCode': self.child.returncode, 'stdoutSha256': digest(output), 'stderrSha256': digest(error)})
                    require(self.child.returncode == 0 and len(output) <= 65536, 'NEGATIVE_FACTORY_EXIT')
                    proofs[case] = rejection_proof(output, case, digest(account['accessToken'].encode()))
                    require(account['expiresAt'] > time.time(), 'NEGATIVE_TOKEN_EXPIRED_DURING_CASE')
                    self.save(self.root, name + '-proof.json', {'scope': SCOPE, 'proof': proofs[case]})
                finally:
                    self.close_child(self.root, name + '-factory')
                self.live(); self.capsule()
        except BaseException:
            errors.append('NEGATIVE_CASE_UNKNOWN_NO_REPLAY')
        finally:
            try:
                if self.child is not None: self.close_child(self.root, 'final-child')
            except BaseException:
                errors.append('NEGATIVE_CHILD_CLOSURE_UNPROVEN')
            final_record = {'scope': SCOPE, 'status': 'UNAVAILABLE_NOT_PROOF'}
            saved = False
            try:
                final = self.snapshots(); final_record.update(status='CAPTURED_NOT_YET_COMPARED', snapshots=final)
                self.save(self.root, 'final-private.json', final_record); saved = True
                require(final == baseline == value['baseline'], 'NEGATIVE_CASE_ROWS_OR_BUDGET_CHANGED')
                require(self.private(self.root / 'negative-input-private.json') == raw
                        and self.private(foreign_root / 'signed-ai-binding-private.json') == binding_raw,
                        'NEGATIVE_ORIGINAL_INPUT_CHANGED')
                self.live(); self.capsule(); final_preserved = True
            except BaseException:
                errors.append('NEGATIVE_FINAL_PRESERVATION_UNPROVEN')
                if not saved:
                    self.save(self.root, 'final-private.json', final_record)
            require(set(proofs) == {'anonymousBearer', 'differentOriginalContext'} or errors,
                    'NEGATIVE_TWO_CASES_MISSING')
            result = {'scope': SCOPE, 'status': 'FAIL' if errors else 'PASS_CASES_REQUIRES_PHASE_MONITOR', 'cases': proofs,
                'fixedFailures': errors, 'sourceHead': self.reviewed.source_head, 'inputSha256': digest(raw),
                'originalRowsAndAuthorityPreserved': final_preserved, 'reservationBudgetDelta': 0 if final_preserved else 'NOT_PROVEN',
                'fullLifecycleCoverage': 'NOT_RUN', 'oldCasesReplayed': False, 'actualNaver': 'NOT_RUN',
                'externalProvider': 'NOT_RUN', 'naturalMidnight': 'NOT_RUN', 'noReplay': True}
            self.save(self.root, 'case-receipt.json', result)
        require(not errors, 'NEGATIVE_CASES_FAILED_PRIVATE_EVIDENCE_PRESERVED')
        return result

    def close(self):
        """성공·실패 모두 정확 신규 ID만 중지한다. Auth/SQL 재전송·삭제·상태 복구 없음."""
        operation_review(self.reviewed, 'close'); self.source()
        before = self.read(self.root, 'pair-before-private.json')
        intent = self.read(self.root, 'pair-create-intent.json')
        require(intent['reviewSha256'] == digest(self.reviewed._sealed) and intent['contexts'] == self.contexts
                and intent['beforeSha256'] == digest(canonical(before)), 'NEGATIVE_CLEANUP_CREATION_INTENT')
        frozen = self.read(self.root, 'create-final-private.json')
        require(frozen['status'] == 'CAPTURED_CREATED_IDS_ONLY' and frozen['reviewSha256'] == digest(self.reviewed._sealed),
                'NEGATIVE_CLEANUP_IDS_UNPROVEN')
        current = metadata_summary(self.inventory())
        added = cleanup_inventory(before, current, self.contexts, self.value['images'])
        require(all([{k: v for k, v in x.items() if k != 'state'} for x in added[kind]]
                    == [{k: v for k, v in x.items() if k != 'state'} for x in frozen['owned'][kind]]
                    for kind in ('containers', 'customNetworks', 'volumes')), 'NEGATIVE_CLEANUP_CREATED_IDS_CHANGED')
        self.save(self.root, 'pair-before-close-private.json', {'scope': SCOPE, 'metadata': current,
            'resolvedOwned': added, 'storedDatabaseBytes': 'NOT_VERIFIED'})
        self.save(self.root, 'pair-close-intent.json', {'scope': SCOPE, 'ownedIds':
            [x['id'] for x in added['containers']], 'noReplay': True, 'ownDataRetained': True})
        results, errors = [], []
        for item in added['containers']:
            try:
                self.source()
                fixed_created_ids(cleanup_inventory(before, metadata_summary(self.inventory()),
                    self.contexts, self.value['images']), frozen['owned'])
                live = exact_json(self.call(['inspect', item['id']]))[0]
                require(live['Id'] == item['id'] and live['Name'] == '/' + item['name']
                        and live['Image'] == item['image'] and live['Config']['Labels'].get('com.supabase.cli.project')
                            in {x['project'] for x in self.contexts.values()}, 'NEGATIVE_CLOSE_TARGET_CHANGED')
                if live['State']['Running']:
                    self.call(['stop', '--time', '30', item['id']], timeout=40)
                state = exact_json(self.call(['inspect', item['id']]))[0]['State']
                require(state['Running'] is False and state['OOMKilled'] is False and state['ExitCode'] == 0,
                        'NEGATIVE_OWN_STOP_FAILED')
                results.append({'id': item['id'], 'stopped': True, 'exitCode': 0, 'oomKilled': False})
            except BaseException:
                errors.append(item['id'])
                results.append({'id': item['id'], 'stopped': 'UNKNOWN', 'retryAllowed': False})
        final = metadata_summary(self.inventory())
        self.save(self.root, 'pair-after-close-private.json', {'scope': SCOPE, 'metadata': final})
        closed = cleanup_inventory(before, final, self.contexts, self.value['images'])
        fixed_created_ids(closed, frozen['owned'])
        remaining = [x['id'] for x in closed['containers'] if x['state']['running'] is not False
                     or x['state']['oomKilled'] is not False]
        self.save(self.root, 'pair-closure.json', {'scope': SCOPE,
            'status': 'FAIL' if errors or remaining else 'PASS_OWN_CREATED_STOPPED_EXISTING_METADATA_PRESERVED',
            'remainingIds': sorted(set(errors + remaining)), 'containers': results,
            'createdContainerCount': len(added['containers']), 'expectedCompletePairCount': 8,
            'volumesAndNetworksRetained': True, 'existingStoredBytes': 'NOT_VERIFIED', 'vmStopped': False,
            'authCaseCompletion': 'READ_CASE_AND_PHASE_RECEIPTS_SEPARATELY'})
        require(not errors and not remaining, 'NEGATIVE_OWN_CLEANUP_UNPROVEN')


def run_reviewed_phase(reviewed, phase):
    """실제 root가 검토 객체로 한 단계만 실행한다. NO_REPLAY 파일이 다음 실행을 차단한다."""
    require(phase in ('prepare', 'create', 'issue', 'dispatch', 'close'), 'NEGATIVE_PHASE')
    operation_review(reviewed, phase)
    runtime = FixedPair(reviewed)
    runtime.save(runtime.root, phase + '-attempt.json', {'scope': SCOPE, 'phase': phase,
        'reviewSha256': digest(reviewed._sealed), 'sourceHead': reviewed.source_head, 'noReplay': True})
    previous = signal.signal(signal.SIGTERM,
        lambda *_: (_ for _ in ()).throw(RuntimeError('NEGATIVE_INTERRUPTED')))
    errors = []
    try:
        if phase not in ('prepare', 'close'):
            runtime.start_monitor()
        result = getattr(runtime, phase)()
    except BaseException:
        errors.append('NEGATIVE_PHASE_FAILED_NO_REPLAY')
        try:
            runtime.save(runtime.root, phase + '-failure.json', {'scope': SCOPE, 'status': 'UNKNOWN',
                'noReplay': True, 'noResend': True, 'phase': phase, 'readOnlyResolutionRequired': True})
        except BaseException:
            errors.append('NEGATIVE_FAILURE_SAVE_UNPROVEN')
        raise
    finally:
        try:
            if runtime.child is not None: runtime.close_child(runtime.root, phase + '-interrupted-child')
        except BaseException:
            errors.append('NEGATIVE_CHILD_CLOSURE_UNPROVEN')
        if phase == 'create':
            record = {'scope': SCOPE, 'status': 'UNAVAILABLE_NOT_PROOF',
                'reviewSha256': digest(reviewed._sealed), 'noReplay': True}
            try:
                require(runtime.child is None, 'NEGATIVE_CREATED_IDS_CHILD_STILL_RUNNING')
                before = runtime.read(runtime.root, 'pair-before-private.json')
                observed = metadata_summary(runtime.inventory())
                owned = cleanup_inventory(before, observed, runtime.contexts, runtime.value['images'])
                record.update(status='CAPTURED_CREATED_IDS_ONLY', metadata=observed, owned=owned)
            except BaseException:
                errors.append('NEGATIVE_CREATED_IDS_CAPTURE_UNPROVEN')
            try:
                runtime.save(runtime.root, 'create-final-private.json', record)
            except BaseException:
                errors.append('NEGATIVE_CREATED_IDS_SAVE_UNPROVEN')
        try:
            if phase not in ('prepare', 'close'):
                runtime.finish_monitor()
        except BaseException:
            errors.append('NEGATIVE_MONITOR_CLOSURE_UNPROVEN')
        try:
            runtime.save(runtime.root, phase + '-monitor.json', {'scope': SCOPE,
                'status': 'FAIL' if errors else 'PASS', 'memorySamples': runtime.samples,
                'memoryScope': 'NO_AUTH_EXECUTION_PREPARE_OR_OWNED_CLEANUP_ONLY' if phase in ('prepare', 'close') else 'START_1G_RUNNING_768M',
                'fixedFailures': errors, 'ownedChildClosed': runtime.child is None, 'sourceHead': reviewed.source_head,
                'reviewSha256': digest(reviewed._sealed), 'phase': phase,
                'fullLifecycleCoverage': 'NOT_RUN'})
        finally:
            signal.signal(signal.SIGTERM, previous)
        require(not errors, 'NEGATIVE_PHASE_FAILED_PRIVATE_EVIDENCE_PRESERVED')
    return result


if __name__ == '__main__':
    print(json.dumps({'scope': SCOPE, 'status': 'NOT_RUN', 'actualCalls': 0,
        'reason': 'ROOT_REVIEWED_TYPED_PAIR_REQUIRED', 'fullLifecycleCoverage': 'NOT_RUN'}))
