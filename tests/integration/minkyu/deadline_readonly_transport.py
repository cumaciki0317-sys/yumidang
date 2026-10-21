"""D03 전용 유한 읽기 포트. 기존 kernel/readonly 기본 포트는 변경하지 않는다."""
import hashlib
import json
import os
import re
import signal
import subprocess
import tempfile
import time

STDOUT_LIMIT = 4 * 1024 * 1024
CHUNK_BYTES = 512 * 1024
STDERR_LIMIT = 65536


def need(value, code):
    if not value:
        raise ValueError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def close_group(child, terminate=False):
    """직접 자식 회수와 원 PG 부재를 모두 확인한다. 조회 오류는 성공이 아니다."""
    def alive():
        try:
            os.killpg(child.pid, 0)
            return True
        except ProcessLookupError:
            return False
    observations = []
    try:
        for sig, seconds in ((signal.SIGTERM, .5), (signal.SIGKILL, 1.0)):
            live = alive(); observations.append({'signal': int(sig), 'groupPresent': live})
            if live:
                os.killpg(child.pid, sig)
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                child.poll()
                if not alive():
                    break
                time.sleep(.01)
            if not alive():
                break
        child.wait(timeout=1)
        closed = child.poll() is not None and not alive()
        return {'closed': closed, 'leaderReaped': child.poll() is not None,
                'processGroupAbsent': not alive(), 'observations': observations}
    finally:
        # PG 조회/신호 권한 오류도 성공으로 바꾸지 않는다. 원 직접 자식은 별도로 회수한다.
        if child.poll() is None:
            child.kill()
        child.wait(timeout=1)


class ReviewedDeadlineReadonlyTransport:
    """동일한 loaded kernel·core·runtime에만 연결되는 실행 객체."""
    def __init__(self, ai, core, runtime, original):
        need(core.ai is ai and runtime.core is core and core.port is original,
             'D03_READ_PORT_CONTEXT')
        reviewed = original.reviewed
        need(type(reviewed) is ai.ReviewedSignedProvisioning
             and isinstance(original, ai.FixedLifecycleProvisioningPorts)
             and reviewed.prepared_root == core.root
             and reviewed.source_pins == core.binding['sourcePins']
             and reviewed.containers == core.binding['containers'], 'D03_READ_TYPED_REVIEW')
        containers = core.binding['containers']
        need(set(containers) == {'db', 'auth', 'rest', 'gateway'}
             and len({v['id'] for v in containers.values()}) == 4
             and all(re.fullmatch('[a-f0-9]{64}', v['id']) for v in containers.values()),
             'D03_READ_EXACT_FOUR')
        need(original.target['id'] == containers['db']['id']
             and original.target['host'] == core.target['host']
             and original.base == ['docker', '--host', core.target['host']], 'D03_READ_EXACT_DATABASE')
        observed = json.loads(core.r.call(['inspect', containers['db']['id']]))
        need(type(observed) is list and len(observed) == 1
             and observed[0]['Id'] == containers['db']['id']
             and observed[0]['HostConfig']['PidMode'] == '', 'D03_READ_PRIVATE_PID_NAMESPACE')
        self.ai, self.core, self.runtime, self.original = ai, core, runtime, original
        self.db = containers['db']['id']; self.base = tuple(original.base)
        self.target_pin = json.dumps(original.target, sort_keys=True, separators=(',', ':'))
        self.root = core.root
        self.pins = dict(reviewed.source_pins)
        self.counter = 0; self.sticky = False

    def available(self):
        need(not self.sticky and not self.runtime.raw_sticky, 'D03_READ_CLOSURE_STICKY')
        need(self.core.ai is self.ai and self.runtime.core is self.core
             and self.core.binding['sourcePins'] == self.pins
             and self.core.binding['containers']['db']['id'] == self.db
             and tuple(self.original.base) == self.base and self.core.root == self.root
             and self.core.target['host'] == self.base[2]
             and json.dumps(self.original.target, sort_keys=True, separators=(',', ':')) == self.target_pin,
             'D03_READ_BINDING_CHANGED')
        self.core.active()

    def assert_closed_state(self):
        need(not self.sticky and not self.runtime.raw_sticky, 'D03_READ_CLOSURE_STICKY')

    def preserve(self):
        self.available()
        t = self.original.target
        self.ai.verify_preserved_resources(self.original.runner.root, t['host'], t['project'],
            self.original.runner.call, t.get('preservedResourcePins'))

    def save(self, name, value):
        self.runtime.save(name, value)

    def child(self, argv, body, timeout, prefix, out_limit, err_limit):
        """원문은 유한 snapshot만 읽는다. 미종결/저장실패는 caller sticky를 유지한다."""
        process = None; failure = None; closure = None
        with tempfile.TemporaryFile() as inp, tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            inp.write(body); inp.seek(0)
            try:
                process = subprocess.Popen(argv, stdin=inp, stdout=out, stderr=err, start_new_session=True)
                began = time.monotonic()
                while process.poll() is None:
                    self.core.active()
                    need(time.monotonic() - began < timeout, 'D03_READ_PROCESS_TIMEOUT')
                    need(os.fstat(out.fileno()).st_size <= out_limit
                         and os.fstat(err.fileno()).st_size <= err_limit, 'D03_READ_OUTPUT_LIMIT')
                    time.sleep(.01)
            except BaseException as error:
                failure = error
            finally:
                if process is not None:
                    try: closure = close_group(process, failure is not None)
                    except BaseException as error:
                        if failure is None: failure = error
                streams = {}; captured = {}
                for label, stream, limit in (('stdout', out, out_limit), ('stderr', err, err_limit)):
                    before = os.fstat(stream.fileno())
                    count = min(before.st_size, limit + 1)
                    raw = os.pread(stream.fileno(), count, 0)
                    after = os.fstat(stream.fileno())
                    whole = bool(closure and closure['closed'] and len(raw) == before.st_size
                        and before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns
                        and before.st_ctime_ns == after.st_ctime_ns)
                    captured[label] = raw; chunks = []
                    for offset in range(0, len(raw), CHUNK_BYTES):
                        piece = raw[offset:offset+CHUNK_BYTES]
                        name = prefix + '-' + label + '-' + str(offset//CHUNK_BYTES).zfill(4) + '-private.json'
                        self.save(name, {'rawHex': piece.hex(), 'bytes': len(piece), 'sha256': sha(piece), 'offset': offset})
                        chunks.append({'path': name, 'bytes': len(piece), 'sha256': sha(piece), 'offset': offset})
                    streams[label] = {'chunks': chunks, 'capturedBytes': len(raw),
                        'observedBytes': before.st_size, 'sha256': sha(raw), 'wholeProven': whole}
                self.save(prefix + '-raw-private.json', {'streams': streams, 'closure': closure,
                    'returnCode': None if process is None else process.returncode,
                    'failureType': None if failure is None else type(failure).__name__})
        need(process is not None and closure and closure['closed'], 'D03_READ_PG_UNPROVEN')
        if failure is not None: raise failure
        need(process.returncode == 0, 'D03_READ_COMMAND_FAILED')
        need(all(v['wholeProven'] and v['observedBytes'] <= limit for v, limit in
            ((streams['stdout'], out_limit), (streams['stderr'], err_limit))), 'D03_READ_STREAM_UNPROVEN')
        return captured['stdout']

    def absent(self, marker, prefix):
        # 동일한 DB의 private PID namespace. 새 SQL observer는 만들지 않는다.
        argv = list(self.base) + ['exec', self.db, '/bin/sh', '-c',
            'if [ -d /proc/' + str(marker['pid']) + ' ]; then printf PRESENT; else printf ABSENT; fi']
        observations = []; end = time.monotonic() + 3
        while True:
            need(time.monotonic() < end, 'D03_READ_BACKEND_STILL_PRESENT')
            index = len(observations) + 1
            raw = self.child(argv, b'', min(2, max(.01, end-time.monotonic())),
                prefix + '-proc-' + str(index), 16, 65536)
            observations.append(raw.decode('ascii'))
            if raw == b'ABSENT':
                self.save(prefix + '-backend-closed.json', {'backend': marker,
                    'observations': observations, 'backendAbsent': True,
                    'sameOwnedDatabasePrivatePidNamespace': True, 'recursiveSqlObserver': False})
                return
            need(raw == b'PRESENT', 'D03_READ_PROC_RESPONSE')
            time.sleep(.02)

    def read_sql(self, query, timeout=3):
        self.available()
        need(type(query) is str and query and type(timeout) in (int, float) and 0 < timeout <= 5,
             'D03_READ_ARGUMENT')
        statement = query.strip().removesuffix(';').strip()
        need(len(query) <= 262144 and re.match(r'(?i)^(select|with)\b', statement)
             and not any(x in statement for x in (';', '--', '/*', '\\')), 'D03_READ_FIXED_STATEMENT')
        self.preserve(); self.counter += 1; prefix = 'd03-read-' + str(self.counter).zfill(5)
        self.sticky = True
        try:
            argv = list(self.base) + ['exec', '-i', self.db, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres',
                '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-f', '-']
            body = ("begin read only;set local statement_timeout='" + str(max(1, int(timeout*500)))
                + "ms';set local lock_timeout='1500ms';select json_build_object('pid',pg_backend_pid(),"
                "'backendStart',(select backend_start from pg_stat_activity where pid=pg_backend_pid()));\n"
                + statement + ';\nrollback;').encode()
            self.save(prefix + '-intent.json', {'argv': argv, 'sqlSha256': sha(body),
                'sqlUtf8': body.decode(), 'singleAttempt': True, 'timeoutSeconds': timeout})
            raw = self.child(argv, body, timeout, prefix, STDOUT_LIMIT, STDERR_LIMIT)
            marker_raw, separator, result = raw.partition(b'\n')
            need(separator, 'D03_READ_MARKER_MISSING')
            marker = json.loads(marker_raw)
            need(type(marker) is dict and set(marker) == {'pid', 'backendStart'}
                 and type(marker['pid']) is int and 1 < marker['pid'] < 2147483648
                 and type(marker['backendStart']) is str and marker['backendStart'], 'D03_READ_BACKEND_MARKER')
            self.absent(marker, prefix)
            self.save(prefix + '-closed.json', {'localProcessGroupClosed': True, 'backendAbsent': True,
                'resultSha256': sha(result), 'resultBytes': len(result)})
            self.sticky = False
            self.preserve()
            return result.decode().strip()
        except BaseException as error:
            self.sticky = True
            self.runtime.mark_raw_unclosed(prefix, error)
            raise


def bind_deadline_readonly_port(ai, core, runtime):
    """상속 메서드의 self.read_sql까지 안전 포트로 전달한다. 일반 플래그는 제공하지 않는다."""
    original = core.port
    transport = ReviewedDeadlineReadonlyTransport(ai, core, runtime, original)
    class DeadlineReadonlyPort(type(original)):
        def read_sql(self, query, timeout=3): return transport.read_sql(query, timeout)
        def sql(self, query): return transport.read_sql(query)
        def assert_closed_state(self): return transport.assert_closed_state()
    port = DeadlineReadonlyPort()
    need(port.reviewed is original.reviewed and port.target == original.target
         and port.base == original.base and port.runner.root == original.runner.root
         and port.binding is core.binding, 'D03_READ_NORMAL_CONSTRUCTOR_CHANGED')
    port.deadline_transport = transport
    return port
