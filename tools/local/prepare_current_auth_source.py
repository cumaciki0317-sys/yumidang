#!/usr/bin/env python3
"""현행 Auth 4역할 새 source 파일 준비. 기본 NOT_RUN, Docker/Auth 실행 API 없음.

실행 adapter는 이 계약의 HEAD/전체 SQL/도구 핀을 재확인하고 기존 lifecycle
kernel에 exact 신규 ID 4개를 바인딩해야 한다. 준비 결과를 실제 Auth PASS로 보지 않는다.
"""
import argparse
import copy
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[2]
SELF = 'tools/local/prepare_current_auth_source.py'
CONFIG = 'backend/supabase/config.toml'
HELPERS = ('prepare_migrations', 'prepare_database', 'prepare_edge', 'prepare_current_policy')
HELPER_PATHS = tuple('tools/local/' + name + '.py' for name in HELPERS)
HOST = 'unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock'
DAEMON = '879401ec-e2b7-4ad8-9915-0a16ea74e3f5'
ROLES = {'db': 'supabase_db_', 'auth': 'supabase_auth_', 'rest': 'supabase_rest_', 'gateway': 'supabase_kong_'}
SCOPE = 'CURRENT_AUTH_FOUR_ROLE_PREPARATION_ONLY'
MATCHING126_SCOPE = 'MATCHING126_AUTH_FOUR_ROLE_PREPARATION_ONLY'
MATCHING126_PROFILE = 'matching_db_entry_126'


def need(ok, code):
    if not ok:
        raise ValueError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.DEVNULL, timeout=15)


def regular_bytes(repo, relative):
    path = repo / relative
    need(path.resolve() == path and path.is_file() and not path.is_symlink(), 'SOURCE_PATH')
    before = path.stat()
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'SOURCE_REGULAR')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        opened = os.fstat(stream.fileno())
        signature = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_size, s.st_nlink, s.st_mtime_ns, s.st_ctime_ns)
        need(signature(before) == signature(opened), 'SOURCE_RACE')
        raw = stream.read()
        need(signature(opened) == signature(os.fstat(stream.fileno())) == signature(path.stat()), 'SOURCE_RACE')
    return raw


def verify_review(repo, head, pins):
    need(type(head) is str and re.fullmatch('[a-f0-9]{40}', head), 'HEAD_FORMAT')
    need(git(repo, 'rev-parse', 'HEAD').decode().strip() == head, 'HEAD_CHANGED')
    need(type(pins) is dict and {SELF, CONFIG, *HELPER_PATHS} <= set(pins), 'REVIEW_SOURCE_SET')
    need(git(repo, 'config', 'yumidang.actor').decode().strip() == 'minkyu', 'ACTOR')
    need(git(repo, 'config', 'core.hooksPath').decode().strip() == '.githooks', 'HOOK')
    payloads = {}
    for relative, pin in pins.items():
        need(type(relative) is str and not Path(relative).is_absolute() and '..' not in Path(relative).parts
             and type(pin) is str and re.fullmatch('[a-f0-9]{64}', pin), 'SOURCE_PIN')
        raw = regular_bytes(repo, relative)
        need(sha(raw) == pin and git(repo, 'show', head + ':' + relative) == raw, 'SOURCE_NOT_COMMITTED')
        payloads[relative] = raw
    return payloads


@contextmanager
def load_support(repo, payloads):
    """검토한 tracked helper bytes만 실행한다. 임시 driver나 sys.path 탐색에 의존하지 않는다."""
    saved = {name: sys.modules.get(name) for name in HELPERS}
    modules = {}
    try:
        for name, relative in zip(HELPERS, HELPER_PATHS):
            module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader=None))
            module.__file__ = str(repo / relative)
            sys.modules[name] = module
            exec(compile(payloads[relative], module.__file__, 'exec'), module.__dict__)
            modules[name] = module
        yield modules['prepare_current_policy'], modules['prepare_database']
    finally:
        for name, previous in saved.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous


def runtime_config(raw, project, port, database):
    rendered, overlay = database.isolated_config(raw, project, port)
    original = tomllib.loads(rendered.decode())
    auth = original.get('auth', {})
    need('jwt_expiry' not in auth or type(auth['jwt_expiry']) is int and auth['jwt_expiry'] == 3600, 'AUTH_LIFETIME_CHANGED')
    expected = copy.deepcopy(original)
    expected['auth']['jwt_expiry'] = 3600
    if 'jwt_expiry' not in auth:
        rendered = re.sub(rb'(?m)^\[auth\](\r?\n)', rb'[auth]\1jwt_expiry = 3600\1', rendered, count=1)
    need(tomllib.loads(rendered.decode()) == expected, 'AUTH_CONFIG_CHANGED')
    return rendered, {**overlay, 'auth.jwt_expiry': 3600}


def target_plan(project, port, subnet):
    import ipaddress
    need(type(project) is str and re.fullmatch('jonghyun-backend100-[a-f0-9]{8}', project), 'PROJECT')
    need(type(port) is int and 1025 <= port <= 65527, 'PORT')
    network = ipaddress.ip_network(subnet, strict=True)
    need(network.version == 4 and network.prefixlen == 24 and network.subnet_of(ipaddress.ip_network('10.253.0.0/16')), 'SUBNET')
    return {'host': HOST, 'context': 'colima-yumidang-minkyu', 'daemonId': DAEMON,
        'projectId': project, 'portBase': port, 'subnet': str(network),
        'newContainerNames': {role: prefix + project for role, prefix in ROLES.items()},
        'expectedNewContainerCount': 4, 'newIds': None,
        'startMinimumAvailableKiB': 1048576, 'maintainMinimumAvailableKiB': 786432,
        'jwtExpirySeconds': 3600, 'runtime': 'NOT_RUN', 'actualAuth': 'NOT_RUN',
        'existingPreservation': 'NOT_VERIFIED', 'cleanup': 'NOT_RUN',
        'executionAdapter': 'NOT_IMPLEMENTED',
        'requiredExecutionChecks': ['SOURCE_HEAD_AND_MANIFEST_RECHECK', 'FIXED_HOST_DAEMON',
            'EXACT_NEW_FOUR_IDS_AND_IMAGES', 'EXISTING_INVENTORY_BEFORE_AFTER',
            'LOOPBACK_PORTS_AND_FRESH_NETWORK', 'START_AND_CONTINUOUS_MEMORY',
            'AUTH_ISSUED_3600_SECONDS', 'SOURCE_BOUND_SIGNED_PROVISIONING',
            'PERSIST_FAILURE_EVIDENCE_BEFORE_VERDICT', 'CLEAN_ONLY_EXACT_NEW_IDS',
            'KEEP_OLD_RESOURCES_AND_UNKNOWN', 'NO_AUTOMATIC_REPLAY']}


def private_destination(repo, output):
    output = Path(output)
    need(output.is_absolute() and output.parent.resolve() == output.parent and not output.exists()
         and not output.is_symlink() and not output.is_relative_to(repo), 'FRESH_OUTPUT')
    parent = output.parent
    boundaries = {Path('/private/tmp'), Path(tempfile.gettempdir()).resolve()}
    while parent not in boundaries:
        info = parent.lstat()
        need(not parent.is_symlink() and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
             and stat.S_IMODE(info.st_mode) == 0o700, 'PRIVATE_PARENT')
        need(parent.parent != parent, 'PRIVATE_BOUNDARY')
        parent = parent.parent
    need(output.parent not in boundaries, 'PRIVATE_PARENT_REQUIRED')
    return output


def private_directories(root, directory):
    current = root
    for part in directory.relative_to(root).parts:
        current = current / part
        if not current.exists():
            current.mkdir(mode=0o700)
        info = current.lstat()
        need(not current.is_symlink() and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
             and stat.S_IMODE(info.st_mode) == 0o700, 'PRIVATE_ARTIFACT_DIRECTORY')


def load_prepared_source(repo, output, *, manifest_sha256, head, pins):
    """후속 실행 adapter의 읽기 전용 연결점. 이 반환값은 실행 승인/검증 PASS가 아니다."""
    repo, output = Path(repo), Path(output)
    private_destination(repo, output / '.uncreated-loader-check')
    raw = regular_bytes(output, 'current-auth-source-manifest.json')
    need(sha(raw) == manifest_sha256, 'PREPARED_MANIFEST_CHANGED')
    report = json.loads(raw)
    need(report.get('status') == 'READY_PREPARATION_ONLY' and report.get('scope') == SCOPE
         and report.get('execution') == 'NOT_RUN' and report.get('sourceHead') == head
         and report.get('sourcePins') == pins, 'PREPARED_BINDING')
    payloads = verify_review(repo, head, pins)
    with load_support(repo, payloads) as (policy, database):
        return _load_bound(repo, output, report, head, pins, payloads, policy, database)


def load_prepared_matching126_source(repo, output, *, manifest_sha256, head, pins):
    """고정126 준비 산출물만 소비한다.125 loader의 허용 범위는 변경하지 않는다."""
    repo, output = Path(repo), Path(output)
    private_destination(repo, output / '.uncreated-loader-check')
    raw = regular_bytes(output, 'current-auth-source-manifest.json')
    need(sha(raw) == manifest_sha256, 'PREPARED_MANIFEST_CHANGED')
    report = json.loads(raw)
    need(report.get('status') == 'READY_PREPARATION_ONLY' and report.get('scope') == MATCHING126_SCOPE
         and report.get('migrationProfile') == MATCHING126_PROFILE and report.get('migrationCount') == 126
         and report.get('execution') == 'NOT_RUN' and report.get('sourceHead') == head
         and report.get('sourcePins') == pins, 'MATCHING126_PREPARED_BINDING')
    payloads = verify_review(repo, head, pins)
    with load_support(repo, payloads) as (policy, database):
        return _load_profile_bound(repo, output, report, head, pins, payloads, policy, database,
                                   MATCHING126_PROFILE)


def _inspect_profile(policy, repo, head, manifest_sha256, profile):
    if profile is None:
        return policy.inspect_reviewed_current_migrations(repo, head, manifest_sha256)
    need(profile == MATCHING126_PROFILE, 'MATCHING126_EXACT_PROFILE_REQUIRED')
    history, sql = policy.inspect_reviewed_matching126_migrations(repo, head, manifest_sha256)
    need(len(history['entries']) == 126, 'MATCHING126_HISTORY_REQUIRED')
    return history, sql


def _load_bound(repo, output, report, head, pins, payloads, policy, database):
    return _load_profile_bound(repo, output, report, head, pins, payloads, policy, database, None)


def _load_profile_bound(repo, output, report, head, pins, payloads, policy, database, profile):
    history, sql = _inspect_profile(policy, repo, head, report['migrationManifestSha256'], profile)
    sources = policy.edge.source_snapshot(repo)
    expected_sources = {SELF, CONFIG, *HELPER_PATHS, *(str(path) for path in sql), *(str(path) for path in sources)}
    need(set(pins) == expected_sources, 'EXACT_SOURCE_SET')
    need(all(payloads[str(path)] == raw for path, raw in {**sql, **sources}.items()), 'SOURCE_PAYLOAD_CHANGED')
    need(report['migrations'] == history['entries'], 'PREPARED_MIGRATIONS_CHANGED')
    plan = report['target']
    need(plan == target_plan(plan['projectId'], plan['portBase'], plan['subnet']), 'PREPARED_TARGET_CHANGED')
    config, overlay = runtime_config(payloads[CONFIG], plan['projectId'], plan['portBase'], database)
    expected = {str(path).removeprefix('backend/'): raw for path, raw in {**sql, **sources}.items()}
    expected['supabase/config.toml'] = config
    need(report['configOverlay'] == overlay and report['configSha256'] == sha(config), 'PREPARED_CONFIG_CHANGED')
    actual = set()
    for path in output.rglob('*'):
        info = path.lstat()
        need(not path.is_symlink() and info.st_uid == os.getuid(), 'PREPARED_PRIVATE')
        if path.is_dir():
            need(stat.S_IMODE(info.st_mode) == 0o700, 'PREPARED_PRIVATE')
        else:
            need(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600, 'PREPARED_PRIVATE')
            actual.add(path.relative_to(output).as_posix())
    need(actual == {*expected, 'current-auth-source-manifest.json'}, 'PREPARED_FILE_SET')
    for relative, data in expected.items():
        need(regular_bytes(output, relative) == data, 'PREPARED_BYTES_CHANGED')
    need(verify_review(repo, head, pins) == payloads, 'SOURCE_CHANGED_DURING_LOAD')
    current, current_sql = _inspect_profile(policy, repo, head, report['migrationManifestSha256'], profile)
    need(current == history and current_sql == sql, 'SQL_CHANGED_DURING_LOAD')
    need(policy.edge.source_snapshot(repo) == sources, 'SOURCE_SNAPSHOT_CHANGED_DURING_LOAD')
    need(verify_review(repo, head, pins) == payloads, 'SOURCE_CHANGED_DURING_LOAD')
    return report


def prepare(repo, output, *, head, manifest_sha256, pins, project, port, subnet):
    repo = Path(repo)
    need(repo.is_absolute() and repo.resolve() == repo, 'REPO_PATH')
    plan = target_plan(project, port, subnet)
    payloads = verify_review(repo, head, pins)
    with load_support(repo, payloads) as (policy, database):
        return _prepare_bound(repo, output, head, manifest_sha256, pins, plan, payloads, policy, database)


def prepare_matching126(repo, output, *, head, manifest_sha256, pins, project, port, subnet):
    """고정126 전용 새 source 파일 준비. root 별도 typed 실행 승인을 대신하지 않는다."""
    repo = Path(repo)
    need(repo.is_absolute() and repo.resolve() == repo, 'REPO_PATH')
    plan = target_plan(project, port, subnet)
    payloads = verify_review(repo, head, pins)
    with load_support(repo, payloads) as (policy, database):
        return _prepare_profile_bound(repo, output, head, manifest_sha256, pins, plan, payloads,
                                      policy, database, MATCHING126_PROFILE)


def _prepare_bound(repo, output, head, manifest_sha256, pins, plan, payloads, policy, database):
    return _prepare_profile_bound(repo, output, head, manifest_sha256, pins, plan, payloads,
                                  policy, database, None)


def _prepare_profile_bound(repo, output, head, manifest_sha256, pins, plan, payloads, policy, database, profile):
    project, port = plan['projectId'], plan['portBase']
    history, sql = _inspect_profile(policy, repo, head, manifest_sha256, profile)
    scope = SCOPE if profile is None else MATCHING126_SCOPE
    sources = policy.edge.source_snapshot(repo)
    expected = {SELF, CONFIG, *HELPER_PATHS, *(str(path) for path in sql), *(str(path) for path in sources)}
    need(set(pins) == expected, 'EXACT_SOURCE_SET')
    need(all(payloads[str(path)] == raw for path, raw in {**sql, **sources}.items()), 'SOURCE_PAYLOAD_CHANGED')
    rendered, overlay = runtime_config(payloads[CONFIG], project, port, database)
    output = private_destination(repo, output)
    # 모든 검증을 끝낸 뒤 새 private 루트만 생성한다. 실행 실패 정리는 adapter의 별도 책임이다.
    output.mkdir(mode=0o700)
    receipt = {'status': 'FAIL_CLOSED', 'scope': scope, 'execution': 'NOT_RUN'}
    try:
        for path, raw in {**sql, **sources}.items():
            relative = str(path).removeprefix('backend/')
            target = output / relative
            private_directories(output, target.parent)
            with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stream:
                stream.write(raw)
        target = output / 'supabase/config.toml'
        private_directories(output, target.parent)
        with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stream:
            stream.write(rendered)
        need(verify_review(repo, head, pins) == payloads, 'SOURCE_CHANGED_DURING_PREPARATION')
        current, current_sql = _inspect_profile(policy, repo, head, manifest_sha256, profile)
        need(current == history and current_sql == sql, 'SQL_CHANGED_DURING_PREPARATION')
        receipt = {'status': 'READY_PREPARATION_ONLY', 'scope': scope, 'sourceHead': head,
            'sourcePins': pins, 'migrationManifestSha256': manifest_sha256,
            'migrations': history['entries'], 'migrationCount': len(history['entries']),
            'configSha256': sha(rendered), 'configOverlay': overlay, 'target': plan,
            'execution': 'NOT_RUN', 'providerCalls': 0, 'realMembers': False,
            'operatingChanged': False, 'automaticReplay': False}
        if profile is not None:
            receipt['migrationProfile'] = profile
        return receipt
    finally:
        with os.fdopen(os.open(output / 'current-auth-source-manifest.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stream:
            stream.write(canonical(receipt))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--review', type=Path)
    parser.add_argument('--review-sha256')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not args.prepare:
        print(json.dumps({'status': 'NOT_RUN', 'scope': SCOPE, 'executionAdapter': 'NOT_IMPLEMENTED'}))
        return
    need(args.review and args.review_sha256 and args.output, 'REVIEW_REQUIRED')
    path = args.review
    need(path.is_absolute() and path.resolve() == path, 'REVIEW_PATH')
    private_destination(ROOT, path.parent / (path.name + '.uncreated-path-check'))
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1, 'REVIEW_PRIVATE')
    raw = regular_bytes(path.parent, path.name)
    need(sha(raw) == args.review_sha256, 'REVIEW_CHANGED')
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'REVIEW_DUPLICATE_KEY')
            result[key] = value
        return result
    review = json.loads(raw, object_pairs_hook=pairs)
    need(set(review) == {'head', 'manifestSha256', 'pins', 'project', 'port', 'subnet'}, 'REVIEW_SHAPE')
    print(json.dumps(prepare(ROOT, args.output, head=review['head'], manifest_sha256=review['manifestSha256'],
        pins=review['pins'], project=review['project'], port=review['port'], subnet=review['subnet'])))


if __name__ == '__main__':
    main()
