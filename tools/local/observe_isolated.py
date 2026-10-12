"""승인된 새 합성 환경의 고정 검사만 관찰한다. 원 오류 출력 없음."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from run_database_tests import isolated_prepared_target, ROOT


def available_memory(output):
    values = re.findall(r"^MemAvailable:\s+([0-9]+) kB$", output, re.M)
    if len(values) != 1:
        raise ValueError("MEMORY_PROBE_INVALID")
    return int(values[0])


def probe(profile="jonghyun-backend100"):
    if profile not in ("jonghyun-backend100", "yumidang-minkyu"):
        raise ValueError("MEMORY_PROFILE_INVALID")
    started = time.monotonic()
    result = subprocess.run(["colima", "ssh", "--profile", profile, "--", "cat", "/proc/meminfo"],
                            capture_output=True, text=True, timeout=3)
    if result.returncode or time.monotonic() - started > 3:
        raise ValueError("MEMORY_PROBE_FAILED")
    return available_memory(result.stdout)


def exclusive_file(path):
    return os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600), "w+")


def interrupted(_signal, _frame):
    raise ValueError('OBSERVER_INTERRUPTED')


def group_alive(process):
    try:
        os.killpg(process.pid, 0)
        return True
    except ProcessLookupError:
        return False


def verify_group_closed(process):
    if group_alive(process):
        # 기존 authority는 start_new_session=True로 만든 이 작업 그룹 한 개다.
        os.killpg(process.pid, signal.SIGTERM)
        deadline = time.monotonic() + 45
        while group_alive(process) and time.monotonic() < deadline:
            time.sleep(0.05)
        if group_alive(process):
            os.killpg(process.pid, signal.SIGKILL)
            deadline = time.monotonic() + 5
            while group_alive(process) and time.monotonic() < deadline:
                time.sleep(0.05)
            if group_alive(process):
                raise subprocess.TimeoutExpired('owned-process-group', 5)


def terminate(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            # SQL fixture cleanup can require several bounded database calls.
            process.wait(timeout=45)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
    verify_group_closed(process)


def source_pins():
    paths = subprocess.check_output(['git', '-C', str(ROOT), 'ls-files', '-z'], timeout=15).decode().split('\0')
    pins = {}
    for relative in paths:
        if not (relative.startswith('backend/supabase/functions/') and relative.endswith(('.ts', '.mjs'))
                or relative.startswith('tools/local/') and relative.endswith('.py')
                or relative.startswith('tests/integration/jonghyun/isolated_') and relative.endswith(('.py', '.ts'))
                or relative.startswith('tests/database/') and '/current_' in relative and relative.endswith('.sql')
                or relative in ['tests/integration/minkyu/content_inspection_http_local.ts',
                                'tests/integration/minkyu/worker_safety_http.ts',
                                'tests/integration/minkyu/worker_safety_http_local.py']):
            continue
        committed = subprocess.check_output(['git', '-C', str(ROOT), 'show', 'HEAD:' + relative], timeout=15)
        if committed != (ROOT / relative).read_bytes():
            raise ValueError('OBSERVER_SOURCE_NOT_COMMITTED')
        pins[relative] = hashlib.sha256(committed).hexdigest()
    return pins


def observed_command(root, mode, signed_binding=None):
    commands = {
        "sql": [sys.executable, "-B", str(ROOT / "tools/local/run_database_tests.py"), "--current-ai"],
        "ai": [sys.executable, "-B", str(ROOT / "tests/integration/jonghyun/isolated_ai_contracts.py")],
        "ai-signed": [sys.executable, "-B", str(ROOT / "tests/integration/jonghyun/isolated_ai_contracts.py")],
        "summary": [sys.executable, "-B", str(ROOT / "tests/integration/jonghyun/isolated_summary_contracts.py")],
    }
    if mode not in commands:
        raise ValueError('OBSERVER_MODE_INVALID')
    if (mode == 'ai-signed') != (signed_binding is not None):
        raise ValueError('SIGNED_BINDING_MODE_REQUIRED')
    command = commands[mode] + ["--prepared-root", str(root), "--run"]
    if mode == 'ai-signed':
        original = Path(signed_binding)
        if (original != original.absolute() or original.resolve() != original
                or original.parent != Path(root).resolve()):
            raise ValueError('SIGNED_BINDING_SCOPE_REQUIRED')
        command += ['--signed-auth', '--signed-auth-binding', str(original)]
    return command


def inspect_observed_signed_binding(path, root):
    # 검토된 고정 모듈만 불러온다. JSON 입력으로 코드를 선택하지 않는다.
    source = ROOT / 'tests/integration/jonghyun/isolated_ai_contracts.py'
    relative = str(source.relative_to(ROOT))
    captured = source.read_bytes()
    committed = subprocess.run(['git', '-C', str(ROOT), 'show', 'HEAD:' + relative],
                               capture_output=True, timeout=15)
    if committed.returncode or captured != committed.stdout:
        raise ValueError('OBSERVER_SOURCE_NOT_COMMITTED')
    spec = importlib.util.spec_from_loader('observed_signed_auth_contract', loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__file__ = str(source)
    exec(compile(captured, str(source), 'exec'), module.__dict__)
    binding = module.inspect_signed_binding(Path(path), Path(root))
    digest = binding.get("bindingSha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("SIGNED_BINDING_DIGEST_UNPROVEN")
    target = module.signed_prepared_target(Path(root))
    if target.get('id') != binding.get('containerIds', {}).get('db'):
        raise ValueError('SIGNED_OBSERVER_TARGET_CHANGED')
    return {'bindingSha256': digest, 'target': target,
            'memoryProfile': signed_memory_profile(target)}


def signed_memory_profile(target):
    # 서명 JSON이나 환경 변수로 profile을 선택하지 않는다. 검증된 소유 socket만 매핑한다.
    for context, profile in (('colima-yumidang-minkyu', 'yumidang-minkyu'),
                             ('colima-jonghyun-backend100', 'jonghyun-backend100')):
        host = 'unix://' + str(Path.home() / '.colima' / profile / 'docker.sock')
        if target.get('context') == context and target.get('host') == host:
            return profile
    raise ValueError('SIGNED_OBSERVER_SOCKET_UNPROVEN')


def validate_signed_result(content):
    try:
        value = json.loads(content)
    except (ValueError, TypeError):
        raise ValueError('SIGNED_RESULT_INVALID') from None
    expected = {'status': 'PASS', 'scope': 'SIGNED_LOCAL_AUTH_AI22_23',
                'actualAuthPostgrest': 'PASS', 'actualNaver': 'NOT_RUN',
                'externalProvider': 'NOT_RUN', 'naturalMidnight': 'NOT_RUN',
                'tls': 'NOT_RUN_LOCAL_HTTP'}
    if not isinstance(value, dict) or any(value.get(k) != v for k, v in expected.items()):
        raise ValueError('SIGNED_RESULT_SCOPE_UNPROVEN')


def observe(root, mode, signed_binding=None):
    command = observed_command(root, mode, signed_binding)
    # 고정 dependency 전체를 검사한 뒤에만 signed 검증 모듈을 평가한다.
    pins = source_pins()
    if mode == 'ai-signed':
        signed_proof = inspect_observed_signed_binding(signed_binding, root)
        binding_digest = signed_proof['bindingSha256']
        memory_profile = signed_proof['memoryProfile']
    else:
        isolated_prepared_target(root)
        binding_digest = None
        memory_profile = None
    source = Path(command[2]); relative = str(source.relative_to(ROOT))
    committed = subprocess.run(["git", "-C", str(ROOT), "show", "HEAD:" + relative], capture_output=True, timeout=15)
    if committed.returncode or committed.stdout != source.read_bytes():
        raise ValueError("OBSERVER_SOURCE_NOT_COMMITTED")
    if pins != source_pins():
        raise ValueError('OBSERVER_SOURCE_CHANGED')
    stamp = str(time.time_ns())
    result_path = root / (mode + "-observer-" + stamp + ".json")
    with exclusive_file(result_path) as receipt, exclusive_file(root / (mode + "-public-" + stamp + ".log")) as log:
        process = None
        report = {"status": "FAIL", "mode": mode, "sourceSha256": hashlib.sha256(committed.stdout).hexdigest(),
                  "observerFailure": None, "childExitCode": None, "samples": [], "naturalMidnight": "NOT_RUN"}
        report['sourcePinsSha256'] = hashlib.sha256(json.dumps(pins, sort_keys=True).encode()).hexdigest()
        report['pinnedFiles'] = len(pins)
        started = time.monotonic()
        try:
            first = probe(memory_profile) if memory_profile is not None else probe()
            report["samples"].append(first)
            if first < 1048576:
                raise ValueError("MEMORY_PREFLIGHT_FAILED")
            process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.DEVNULL, start_new_session=True)
            while process.poll() is None:
                available = probe(memory_profile) if memory_profile is not None else probe()
                report["samples"].append(available)
                if available < 786432:
                    raise ValueError("MEMORY_RUNNING_FAILED")
                if time.monotonic() - started > (900 if mode == 'summary' else 300):
                    raise ValueError("OBSERVER_TIME_LIMIT")
                time.sleep(1)
            report["childExitCode"] = process.wait(timeout=5)
            if pins != source_pins():
                raise ValueError("OBSERVER_SOURCE_CHANGED")
            if mode == 'ai-signed':
                if signed_proof != inspect_observed_signed_binding(signed_binding, root):
                    raise ValueError('SIGNED_BINDING_CHANGED')
                log.flush(); log.seek(0)
                validate_signed_result(log.read())
                report['signedBindingSha256'] = binding_digest
                report['actualAuthPostgrest'] = 'PASS'
                report['actualNaver'] = 'NOT_RUN'
                report['externalProvider'] = 'NOT_RUN'
                report['tls'] = 'NOT_RUN_LOCAL_HTTP'
            else:
                isolated_prepared_target(root)
            report["status"] = "PASS" if report["childExitCode"] == 0 else "FAIL"
        except (OSError, ValueError, subprocess.SubprocessError):
            report["observerFailure"] = "OBSERVER_FIXED_FAILURE"
        finally:
            previous_signal = signal.signal(signal.SIGTERM, signal.SIG_IGN)
            if process is not None:
                try:
                    terminate(process)
                except (OSError, subprocess.SubprocessError):
                    report['status'] = 'FAIL'
                    report['observerFailure'] = 'OBSERVER_TERMINATION_UNCONFIRMED'
                report["childExitCode"] = process.returncode
            try:
                try:
                    log.flush(); log.seek(0)
                    report["publicLogSha256"] = hashlib.sha256(log.read().encode()).hexdigest()
                except OSError:
                    report['status'] = 'FAIL'
                    report['observerFailure'] = 'OBSERVER_LOG_UNCONFIRMED'
                report["elapsedSeconds"] = round(time.monotonic() - started, 2)
                json.dump(report, receipt); receipt.flush(); os.fsync(receipt.fileno())
            finally:
                signal.signal(signal.SIGTERM, previous_signal)
        print(json.dumps({**report, "receipt": result_path.name}))
        return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepared-root", type=Path, required=True)
    parser.add_argument("--mode", choices=["sql", "ai", "ai-signed", "summary"], required=True)
    parser.add_argument("--signed-auth-binding", type=Path)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    if not args.run:
        print('{"status":"NOT_RUN"}')
    else:
        signal.signal(signal.SIGTERM, interrupted)
        try:
            raise SystemExit(observe(args.prepared_root, args.mode, args.signed_auth_binding))
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            print('{"status":"FAIL","error":"OBSERVER_INPUT_FAILED"}')
            raise SystemExit(1)
