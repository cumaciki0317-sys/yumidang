#!/usr/bin/env python3
"""민규: 운영 이식 순서·해시 준비. DB 연결·배포·권한 활성화는 수행하지 않는다."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import os
import subprocess
import stat
from check_api_env import read_env, parse_env, InputError
import prepare_current_policy as current
from compare_schema_catalog import CatalogError, compare_catalogs, read_private_catalog
from prepare_migrations import PreparationError
PROJECT_ID = 'bndguguarijmghnkenvt'
QUEUE_ENTRY = 'backend/supabase/functions/scheduled-jobs/queue-runner.mjs'
# 검토한 고정 import만 허용한다. JSON/환경은 모듈 선택이나 승인으로 사용하지 않는다.
DYNAMIC_MODULES = {
    QUEUE_ENTRY: {'../_shared/jobs/runtime.ts', 'pg'},
    'backend/supabase/functions/_shared/ai/Agents/review-summary/output-check.ts': {'../../providers/privacy.ts'},
    'backend/supabase/functions/_shared/db/repositories/jobs.ts': {'../worker-runtime-client.ts'},
}
REVIEWED_DOCUMENTS = {
    'docs/collaboration/requests/minkyu/2026-10-10-retirement-worker-e2e-plan.md':
        '82b8dbdb071f20df71aa67a7f45aec0f916a7b4a83cd0bcf098aa7e8e4e6fbc3',
}
FINAL_EVIDENCE = {
    'five_kind_actual_final_graph': 'TODO_NOT_RUN',
    'public_retirement_to_automatic_finalization': 'TODO_NOT_RUN',
    'final_source_sql_receipt_binding': 'TODO_NOT_RUN',
    'supplier_conditions': 'NOT_RUN',
    'real_member_flow': 'NOT_RUN',
    'operating_activation': 'NOT_RUN',
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def module_imports(data, suffix):
    """Node 내장 parser로 정적 import/re-export 전체를 읽는다. link는 합성 namespace뿐이며 evaluate하지 않는다."""
    script = """import{SourceTextModule,SyntheticModule}from'node:vm';
import{stripTypeScriptTypes}from'node:module';
let source='';for await(const chunk of process.stdin){source+=chunk;if(Buffer.byteLength(source)>1048576)throw Error()}
try{
 const code=process.argv[1]==='.ts'?stripTypeScriptTypes(source,{mode:'strip'}):source;
 const module=new SourceTextModule(code,{identifier:'closed-source-review'});
 const words=[...new Set(['default',...(code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g)??[])])];
 await module.link(()=>new SyntheticModule(words,()=>{}));
 process.stdout.write(JSON.stringify({imports:module.dependencySpecifiers,exports:Reflect.ownKeys(module.namespace).filter(x=>typeof x==='string')}));
}catch{process.stdout.write(JSON.stringify({error:'MODULE_GRAPH_PARSE_FAILED'}));process.exitCode=2}
"""
    try:
        result = subprocess.run(['node', '--experimental-vm-modules', '--input-type=module', '-e', script, suffix], input=data, capture_output=True, timeout=15)
        value = json.loads(result.stdout)
        if result.returncode != 0 or set(value) != {'imports', 'exports'} or any(not isinstance(x, str) for xs in value.values() for x in xs):
            raise PreparationError('UNREVIEWED_QUEUE_IMPORT')
        return value
    except (OSError, subprocess.SubprocessError, ValueError):
        raise PreparationError('UNREVIEWED_QUEUE_IMPORT') from None


def queue_source_graph(repo, source_paths):
    """실행 없이 고정 상대 import graph를 읽는다. 모호한 import는 별도 검토 대상이다."""
    pending, graph, packages = [QUEUE_ENTRY], {}, set()
    # type-only import는 strip 때 없어지므로 지원 문법을 제한해 별도로 고정한다.
    type_import = re.compile(r'^\s*import\s+type\b[^;]+;', re.MULTILINE)
    type_spec = re.compile(r'\bfrom\s*([\'"])([^\'"\r\n\\]+)\1\s*;\s*$')
    dynamic = re.compile(r'\bimport\s*\(\s*([\'"])([^\'"\r\n\\]+)\1\s*\)')
    while pending:
        path = pending.pop()
        if path in graph:
            continue
        if path not in source_paths:
            raise PreparationError('UNSNAPSHOTTED_QUEUE_IMPORT')
        data = current.edge.read_regular(repo, Path(path))
        text = data.decode('utf-8')
        parsed = module_imports(data, Path(path).suffix)
        if path == QUEUE_ENTRY and ('runQueueRunnerCli' not in parsed['exports'] or not re.search(r'^\s*export\s+(?:async\s+)?function\s+runQueueRunnerCli\s*\(', text, re.MULTILINE)):
            raise PreparationError('QUEUE_ENTRY_ABI_MISSING')
        commented_literal = re.compile(r'\b(?:from|import)(?:\s|/\*[\s\S]*?\*/|//[^\n]*(?:\n|$))*([\'"])([^\r\n]*?)\1')
        if any('\\' in match.group(2) for match in commented_literal.finditer(text)):
            raise PreparationError('UNREVIEWED_QUEUE_IMPORT')
        literals = list(dynamic.finditer(text))
        # 주석 삽입·표현식·escape로 임의 import를 숨기는 경로는 허용하지 않는다.
        if len(literals) != len(re.findall(r'\bimport\s*\(', text)) or re.search(r'\bimport\s*/|\b(?:require|eval|Function)\s*\(|\bcreateRequire\b|\b(?:from|import)\s*[\'"][^\'"\r\n]*\\', text):
            raise PreparationError('UNREVIEWED_QUEUE_IMPORT')
        specs = list(parsed['imports'])
        for match in type_import.finditer(text):
            found = type_spec.search(match.group())
            if found is None:
                raise PreparationError('UNREVIEWED_QUEUE_IMPORT')
            specs.append(found.group(2))
        for match in literals:
            if match.group(2) not in DYNAMIC_MODULES.get(path, set()):
                raise PreparationError('UNREVIEWED_QUEUE_IMPORT')
            specs.append(match.group(2))
        graph[path] = sha256(data)
        for specifier in specs:
            if specifier in {'node:url', 'node:crypto', 'node:tls'}:
                continue
            if specifier == 'pg' and path == QUEUE_ENTRY:
                packages.add(specifier);continue
            if not specifier.startswith('.') or '\\' in specifier:
                raise PreparationError('UNREVIEWED_QUEUE_IMPORT')
            raw = repo / Path(path).parent / specifier
            if any(p.is_symlink() for p in (raw, *raw.parents) if p.is_relative_to(repo) and p != repo):
                raise PreparationError('QUEUE_IMPORT_SYMLINK')
            resolved = raw.resolve()
            if not resolved.is_relative_to(repo / 'backend/supabase/functions'):
                raise PreparationError('QUEUE_IMPORT_OUTSIDE_SNAPSHOT')
            pending.append(str(resolved.relative_to(repo)))
    package = json.loads(current.edge.read_regular(repo, Path('backend/package.json')))
    lock = json.loads(current.edge.read_regular(repo, Path('backend/package-lock.json')))
    if package.get('engines', {}).get('node') != '>=22.18.0' or package.get('dependencies') != {'pg': '8.22.0'} or lock.get('packages', {}).get('node_modules/pg', {}).get('version') != '8.22.0':
        raise PreparationError('QUEUE_PACKAGE_CONTRACT_MISMATCH')
    return {'entrypoint': QUEUE_ENTRY, 'files': dict(sorted(graph.items())),
            'packages': sorted(packages), 'packageInstallation': 'NOT_RUN'}


def closed_launcher(binding):
    # stock CLI도 유지관리를 포함한다. 닫힘은 CLI 호출 이전에 적용한다.
    return ("import { pathToFileURL } from 'node:url';\n"
            "import { runQueueRunnerCli } from './" + QUEUE_ENTRY + "';\n"
            "export const bindingSha256 = '" + binding + "';\n"
            "const scope = null;\n"
            "export async function startClosedQueue() {\n"
            "  if (scope === null) throw new Error('PRODUCTION_SCOPE_NOT_APPROVED');\n"
            "  return runQueueRunnerCli();\n"
            "}\n"
            "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {\n"
            "  process.stderr.write('PRODUCTION_SCOPE_NOT_APPROVED\\n');\n"
            "  process.exitCode = 1;\n"
            "}\n").encode()


def verify_closed_artifact(directory, expected_binding):
    """외부에 별도 보관한 digest로 검증한다. 산출물 자체 digest를 신뢰 근거로 가져오지 않는다."""
    if not isinstance(expected_binding, str) or not re.fullmatch('[0-9a-f]{64}', expected_binding):
        raise PreparationError('EXTERNAL_BINDING_REQUIRED')
    if directory.is_symlink() or directory.resolve() != directory or not directory.is_dir() or stat.S_IMODE(directory.stat().st_mode) != 0o700 or directory.stat().st_uid != os.getuid():
        raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    def read(name):
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid() or path.stat().st_nlink != 1 or stat.S_IMODE(path.stat().st_mode) != 0o600:
            raise PreparationError('CLOSED_ARTIFACT_CHANGED')
        return current.edge.read_regular(directory, Path(name))
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise PreparationError('CLOSED_ARTIFACT_CHANGED')
            result[key] = value
        return result
    manifest = json.loads(read('launcher-manifest.json'), object_pairs_hook=unique_keys)
    if not isinstance(manifest,dict):
        raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    binding = manifest.get('binding')
    keys = {'status','scope','activationAllowed','operatingChanged','sourceHead','productSourcesSha256','productSources','migrationManifestSha256','reviewedMigrations','catalogInputSha256','queueGraph','copiedFiles','reviewEvidence','reviewEvidenceSha256','finalEvidence','actualReceipts','historicReceipts','preparationToolSha256','launcherTemplateSha256','execution','deploymentVerified'}
    if set(manifest) != {'binding','bindingSha256','launcherSha256'} or not isinstance(binding, dict) or set(binding) != keys or manifest.get('bindingSha256') != sha256(canonical(binding)) or manifest['bindingSha256'] != expected_binding:
        raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    if binding.get('scope') is not None or binding.get('activationAllowed') is not False or binding.get('operatingChanged') is not False or binding.get('deploymentVerified') is not False or binding.get('execution') != 'NOT_RUN' or binding.get('status') != 'PREPARED_CLOSED_NOT_APPROVED' or binding.get('finalEvidence') != FINAL_EVIDENCE or binding.get('actualReceipts') != [] or binding.get('historicReceipts') != 'NOT_REVALIDATED_FINAL_GRAPH_NOT_PROVEN':
        raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    evidence = [{'path':name,'sha256':digest,'scope':'REVIEWED_PLAN_ONLY','actualReceipt':'NOT_RUN','activationAllowed':False} for name,digest in REVIEWED_DOCUMENTS.items()]
    if binding['reviewEvidence'] != evidence or binding['reviewEvidenceSha256'] != sha256(canonical(evidence)) or binding['launcherTemplateSha256'] != sha256(closed_launcher('0'*64)) or binding['preparationToolSha256'] != sha256(Path(__file__).read_bytes()):
        raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    migrations = binding['reviewedMigrations']
    if not isinstance(migrations,dict) or not migrations or any(not re.fullmatch(r'backend/supabase/migrations/[0-9]{14}_[A-Za-z0-9_-]+\.sql',name) or not isinstance(digest,str) or not re.fullmatch('[0-9a-f]{64}',digest) for name,digest in migrations.items()) or binding['migrationManifestSha256'] != sha256(canonical(migrations)):
        raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    catalogs = binding['catalogInputSha256']
    if not isinstance(catalogs,dict) or set(catalogs) != {'baseline','operating','history'} or any(not isinstance(d,str) or not re.fullmatch('[0-9a-f]{64}',d) for d in catalogs.values()) or not isinstance(binding['sourceHead'],str) or not binding['sourceHead']:
        raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    launcher = closed_launcher(manifest['bindingSha256'])
    if read('queue-launcher.closed.mjs') != launcher or manifest.get('launcherSha256') != sha256(launcher):
        raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    if not isinstance(binding['copiedFiles'],dict):
        raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    for name, digest in binding['copiedFiles'].items():
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or not name.startswith(('backend/', 'docs/')) or sha256(read(name)) != digest:
            raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    expected = set(binding['copiedFiles']) | {'queue-launcher.closed.mjs', 'launcher-manifest.json'}
    for path in directory.rglob('*'):
        if path.is_dir() and (path.is_symlink() or stat.S_IMODE(path.stat().st_mode) != 0o700 or path.stat().st_uid != os.getuid()):
            raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    if {str(p.relative_to(directory)) for p in directory.rglob('*') if p.is_file() or p.is_symlink()} != expected:
        raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    sources = binding['productSources']
    if not isinstance(sources,dict) or set(sources) != {'mode','sha256','files','excludedCopies','deploymentVerified'} or sources['mode'] != 'working_tree_snapshot' or sources['deploymentVerified'] is not False:
        raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    actual = inspect_product_sources(directory)
    if sources['files'] != actual['files'] or sources['sha256'] != actual['sha256'] or binding['productSourcesSha256'] != actual['sha256']:
        raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    combined = {entry['path']:entry['sha256'] for entry in actual['files']}
    if set(combined)&set(migrations) or set(combined)&set(REVIEWED_DOCUMENTS) or binding['copiedFiles'] != {**combined,**migrations,**REVIEWED_DOCUMENTS} or binding['queueGraph'] != queue_source_graph(directory,combined):
        raise PreparationError('CLOSED_ARTIFACT_CHANGED')
    return manifest


def prepare_closed_artifact(repo, directory, sources, reviewed, preparation):
    """검토 가능한 닫힌 소스 묶음만 만든다. 실제 receipt/PASS 승격은 없다."""
    if not directory.is_absolute() or not directory.is_relative_to('/private/tmp') or directory.parent.resolve() != directory.parent or directory.exists() or directory.is_symlink():
        raise PreparationError('NEW_PRIVATE_ARTIFACT_REQUIRED')
    parent = directory.parent.stat()
    if stat.S_IMODE(parent.st_mode) != 0o700 or parent.st_uid != os.getuid():
        raise PreparationError('PRIVATE_ARTIFACT_DIRECTORY_REQUIRED')
    expected = {entry['path']: entry['sha256'] for entry in sources['files']}
    if sources != inspect_product_sources(repo):
        raise PreparationError('SOURCE_CHANGED_DURING_PREPARATION')
    graph = queue_source_graph(repo, expected)
    if any(expected[path] != digest for path, digest in graph['files'].items()):
        raise PreparationError('SOURCE_CHANGED_DURING_PREPARATION')
    copied, evidence = {}, []
    for name, digest in {**expected, **reviewed, **REVIEWED_DOCUMENTS}.items():
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or not name.startswith(('backend/', 'docs/')):
            raise PreparationError('INVALID_CLOSED_SOURCE_PATH')
        data = current.edge.read_regular(repo, path)
        if sha256(data) != digest:
            raise PreparationError('CLOSED_SOURCE_HASH_MISMATCH')
        copied[name] = data
    for name, digest in REVIEWED_DOCUMENTS.items():
        evidence.append({'path': name, 'sha256': digest, 'scope': 'REVIEWED_PLAN_ONLY',
                         'actualReceipt': 'NOT_RUN', 'activationAllowed': False})
    binding = {'status': 'PREPARED_CLOSED_NOT_APPROVED', 'scope': None,
               'activationAllowed': False, 'operatingChanged': False,
               'sourceHead': preparation['sourceHead'], 'productSourcesSha256': sources['sha256'],
               'productSources': sources, 'reviewedMigrations': dict(reviewed),
               'migrationManifestSha256': sha256(canonical(reviewed)),
               'catalogInputSha256': preparation['catalogInputSha256'],
               'queueGraph': graph, 'copiedFiles': {name: sha256(data) for name, data in sorted(copied.items())},
               'reviewEvidence': evidence, 'reviewEvidenceSha256': sha256(canonical(evidence)),
               'finalEvidence': dict(FINAL_EVIDENCE), 'actualReceipts': [],
               'historicReceipts': 'NOT_REVALIDATED_FINAL_GRAPH_NOT_PROVEN',
               'preparationToolSha256': sha256(Path(__file__).read_bytes()),
               'launcherTemplateSha256': sha256(closed_launcher('0' * 64)),
               'execution': 'NOT_RUN', 'deploymentVerified': False}
    digest = sha256(canonical(binding))
    launcher = closed_launcher(digest)
    manifest = {'binding': binding, 'bindingSha256': digest, 'launcherSha256': sha256(launcher)}
    os.mkdir(directory, 0o700)
    for name, data in {**copied, 'queue-launcher.closed.mjs': launcher,
                       'launcher-manifest.json': canonical(manifest)}.items():
        target = directory / name
        parent = directory
        for part in Path(name).parts[:-1]:
            parent = parent / part
            if not parent.exists():
                os.mkdir(parent, 0o700)
            if parent.is_symlink() or not parent.is_dir() or stat.S_IMODE(parent.stat().st_mode) != 0o700 or parent.stat().st_uid != os.getuid():
                raise PreparationError('CLOSED_ARTIFACT_CHANGED')
        with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stream:
            stream.write(data)
    if sources != inspect_product_sources(repo) or any(current.edge.read_regular(repo, Path(name)) != data for name, data in copied.items()):
        raise PreparationError('SOURCE_CHANGED_DURING_PREPARATION')
    verify_closed_artifact(directory, digest)
    return {'status': binding['status'], 'bindingSha256': digest,
            'launcherSha256': sha256(launcher), 'manifestSha256': sha256(canonical(manifest)),
            'activationAllowed': False, 'execution': 'NOT_RUN'}

def build_plan(reviewed, remote, head):
    if not isinstance(remote, dict) or set(remote) != {'migrations'} or not isinstance(remote['migrations'], list):
        raise PreparationError('INVALID_REMOTE_HISTORY')
    by_version = {Path(path).name[:14]: (path, sha) for path, sha in reviewed.items()}
    seen = set()
    for entry in remote['migrations']:
        if not isinstance(entry, dict) or set(entry) != {'version', 'name'}:
            raise PreparationError('INVALID_REMOTE_HISTORY')
        version = entry['version']
        if not isinstance(version, str) or not re.fullmatch(r'[0-9]{14}', version) or version in seen or version not in by_version:
            raise PreparationError('REMOTE_HISTORY_CONFLICT')
        if entry['name'] != Path(by_version[version][0]).name[15:-4]:
            raise PreparationError('REMOTE_HISTORY_CONFLICT')
        seen.add(version)
    if not seen:
        raise PreparationError('REMOTE_HISTORY_REQUIRED')
    pending = [{'version': version, 'path': path, 'sha256': sha}
               for version, (path, sha) in sorted(by_version.items()) if version not in seen]
    return {'status': 'PREPARED_NOT_ACTIVATED', 'projectId': PROJECT_ID, 'sourceHead': head,
            'reviewedCount': len(reviewed), 'operatingAppliedCount': len(seen), 'pendingCount': len(pending),
            'pending': pending, 'operatingChanged': False, 'activationAllowed': False,
            'requiredGates': ['final_backup_and_restore', 'product_cli_two_process_recovery',
                              'product_helpful_periodic_cleanup', 'eligible_naver_two_members',
                              'railway_current_configuration', 'supplier_and_feature_scope']}

def inspect_product_sources(repo):
    """배포 소스 현재 바이트를 고정한다. Git HEAD·실행/공유 완료와 구분한다."""
    paths = {Path('backend/package.json'), Path('backend/package-lock.json'),
             Path('backend/supabase/config.toml')}
    functions = repo / 'backend/supabase/functions'
    excluded = []
    for candidate in functions.rglob('*'):
        if candidate.suffix not in {'.ts', '.mjs', '.json'} or 'node_modules' in candidate.parts:
            continue
        relative = candidate.relative_to(repo)
        if re.search(r' [0-9]+\.(?:ts|mjs|json)$', candidate.name):
            excluded.append(str(relative));continue
        paths.add(relative)
    files = []
    for path in sorted(paths):
        data = current.edge.read_regular(repo, path)
        files.append({'path':str(path), 'sha256':hashlib.sha256(data).hexdigest(), 'bytes':len(data)})
    digest = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {'mode':'working_tree_snapshot', 'sha256':digest, 'files':files,
            'excludedCopies':sorted(excluded), 'deploymentVerified':False}


def inspect_runtime_env(repo, env_file, queue_ca_file=None):
    """비밀은 stdin 메모리로만 전달하고 기존 Node runtime loader를 재사용한다."""
    if env_file.stat().st_mode & 0o077:
        raise PreparationError('PRIVATE_ENV_MODE_REQUIRED')
    values = parse_env(read_env(env_file))
    if queue_ca_file is not None:
        if values.get('WORKER_QUEUE_DB_CA_PEM'):
            raise PreparationError('AMBIGUOUS_QUEUE_CA_INPUT')
        values['WORKER_QUEUE_DB_CA_PEM'] = read_env(queue_ca_file)
    try:
        child = subprocess.run(['node',
                                str(repo/'tools/local/check_production_runtime.mjs')],
                               input=json.dumps(values).encode(), capture_output=True, timeout=15)
        if child.returncode not in (0, 2):
            raise PreparationError('RUNTIME_CONFIG_CHECK_FAILED')
        result = json.loads(child.stdout)
        # Never forward child stderr, config values, or unexpected output.
        expected = {'status','checks','offline','connectionCheck','databaseEffectivePrivileges','tlsHandshake',
                    'productCli','supplierApproval','activationAllowed','operatingChanged'}
        if set(result) != expected or result['activationAllowed'] is not False or result['operatingChanged'] is not False:
            raise PreparationError('RUNTIME_CONFIG_CHECK_FAILED')
        return result
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise PreparationError('RUNTIME_CONFIG_CHECK_FAILED') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--remote-history', type=Path, required=True)
    parser.add_argument('--baseline-catalog', type=Path, required=True)
    parser.add_argument('--remote-catalog', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--runtime-env-file', type=Path)
    parser.add_argument('--queue-ca-file', type=Path, help='다중행 PEM을 별도 파일에서 읽어 offline 검사에만 전달')
    parser.add_argument('--closed-artifact-dir', type=Path, help='새 private 디렉터리에 실행이 차단된 검토 산출물만 준비')
    args = parser.parse_args()
    try:
        inspection = current.inspect_current_migrations(args.repo)
        history = inspection[0]
        sources = inspect_product_sources(args.repo)
        if args.queue_ca_file and not args.runtime_env_file:
            raise PreparationError('RUNTIME_ENV_REQUIRED_FOR_CA')
        inputs = {name:read_private_catalog(path, with_bytes=True) for name,path in [('baseline',args.baseline_catalog),('operating',args.remote_catalog),('history',args.remote_history)]}
        comparison = compare_catalogs(inputs['baseline'][0], inputs['operating'][0])
        if comparison['status'] != 'STATIC_MATCH':
            raise PreparationError('OPERATING_SCHEMA_DRIFT')
        remote = inputs['history'][0]
        # Bind to bytes reviewed by the existing preparation tool, including uncommitted followups.
        reviewed = {**current.edge.GATEWAY_REVIEWED_MIGRATIONS, **current.CURRENT_POLICY_REVIEWED}
        result = build_plan(reviewed, remote, history['source_head'])
        result['catalogFreshness'] = 'INPUT_COLLECTION_TIME_NOT_VERIFIED'
        result['catalogInputSha256'] = {name:hashlib.sha256(value[1]).hexdigest() for name,value in inputs.items()}
        result['schemaComparison'] = comparison
        result['productSources'] = sources
        result['migrationManifestSha256'] = hashlib.sha256(json.dumps(reviewed, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        result['runtimeConfiguration'] = inspect_runtime_env(args.repo, args.runtime_env_file, args.queue_ca_file) if args.runtime_env_file else {'status':'NOT_RUN','activationAllowed':False}
        if inspect_product_sources(args.repo) != sources or current.inspect_current_migrations(args.repo)[0] != history:
            raise PreparationError('SOURCE_CHANGED_DURING_PREPARATION')
        if args.output.exists() or args.output.parent.resolve() != args.output.parent or not args.output.is_relative_to('/private/tmp'):
            raise PreparationError('NEW_PRIVATE_OUTPUT_REQUIRED')
        if args.output.parent.stat().st_mode & 0o077:
            raise PreparationError('PRIVATE_OUTPUT_DIRECTORY_REQUIRED')
        if args.closed_artifact_dir is not None:
            result['closedLauncherArtifact'] = prepare_closed_artifact(args.repo, args.closed_artifact_dir, sources, reviewed, result)
        with os.fdopen(os.open(args.output, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600),'w') as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
        args.output.chmod(0o600)
        print(json.dumps({key: result[key] for key in ['status','projectId','reviewedCount','operatingAppliedCount','pendingCount','activationAllowed','operatingChanged']}))
    except (PreparationError, CatalogError, InputError, ValueError, OSError) as exc:
        print(json.dumps({'status': 'BLOCKED', 'operatingChanged': False, 'error': str(exc) if isinstance(exc, (PreparationError, CatalogError, InputError)) else 'PREPARATION_INPUT_FAILED'}));return 1
    return 0
if __name__ == '__main__':
    raise SystemExit(main())
