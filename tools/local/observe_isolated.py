"""승인된 새 합성 환경의 고정 검사만 관찰한다. 원 오류 출력 없음."""
import argparse
import hashlib
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


def probe():
    started = time.monotonic()
    result = subprocess.run(["colima", "ssh", "--profile", "jonghyun-backend100", "--", "cat", "/proc/meminfo"],
                            capture_output=True, text=True, timeout=3)
    if result.returncode or time.monotonic() - started > 3:
        raise ValueError("MEMORY_PROBE_FAILED")
    return available_memory(result.stdout)


def exclusive_file(path):
    return os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600), "w+")


def interrupted(_signal, _frame):
    raise ValueError('OBSERVER_INTERRUPTED')


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


def source_pins():
    paths = subprocess.check_output(['git', '-C', str(ROOT), 'ls-files', '-z'], timeout=15).decode().split('\0')
    pins = {}
    for relative in paths:
        if not (relative.startswith('backend/supabase/functions/') and relative.endswith(('.ts', '.mjs'))
                or relative.startswith('tools/local/') and relative.endswith('.py')
                or relative.startswith('tests/integration/jonghyun/isolated_') and relative.endswith(('.py', '.ts'))
                or relative.startswith('tests/database/') and '/current_' in relative and relative.endswith('.sql')
                or relative in ['tests/integration/minkyu/content_inspection_http_local.ts',
                                'tests/integration/minkyu/worker_safety_http_local.ts',
                                'tests/integration/minkyu/worker_safety_http_local.py']):
            continue
        committed = subprocess.check_output(['git', '-C', str(ROOT), 'show', 'HEAD:' + relative], timeout=15)
        if committed != (ROOT / relative).read_bytes():
            raise ValueError('OBSERVER_SOURCE_NOT_COMMITTED')
        pins[relative] = hashlib.sha256(committed).hexdigest()
    return pins


def observe(root, mode):
    isolated_prepared_target(root)
    commands = {
        "sql": [sys.executable, "-B", str(ROOT / "tools/local/run_database_tests.py"), "--current-ai"],
        "ai": [sys.executable, "-B", str(ROOT / "tests/integration/jonghyun/isolated_ai_contracts.py")],
        "summary": [sys.executable, "-B", str(ROOT / "tests/integration/jonghyun/isolated_summary_contracts.py")],
    }
    command = commands[mode] + ["--prepared-root", str(root), "--run"]
    source = Path(command[2]); relative = str(source.relative_to(ROOT))
    committed = subprocess.run(["git", "-C", str(ROOT), "show", "HEAD:" + relative], capture_output=True, timeout=15)
    if committed.returncode or committed.stdout != source.read_bytes():
        raise ValueError("OBSERVER_SOURCE_NOT_COMMITTED")
    pins = source_pins()
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
            first = probe(); report["samples"].append(first)
            if first < 1048576:
                raise ValueError("MEMORY_PREFLIGHT_FAILED")
            process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.DEVNULL, start_new_session=True)
            while process.poll() is None:
                available = probe(); report["samples"].append(available)
                if available < 786432:
                    raise ValueError("MEMORY_RUNNING_FAILED")
                if time.monotonic() - started > 300:
                    raise ValueError("OBSERVER_TIME_LIMIT")
                time.sleep(1)
            report["childExitCode"] = process.wait(timeout=5)
            if pins != source_pins():
                raise ValueError("OBSERVER_SOURCE_CHANGED")
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
    parser.add_argument("--mode", choices=["sql", "ai", "summary"], required=True)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    if not args.run:
        print('{"status":"NOT_RUN"}')
    else:
        signal.signal(signal.SIGTERM, interrupted)
        try:
            raise SystemExit(observe(args.prepared_root, args.mode))
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            print('{"status":"FAIL","error":"OBSERVER_INPUT_FAILED"}')
            raise SystemExit(1)
