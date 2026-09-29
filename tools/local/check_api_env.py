#!/usr/bin/env python3
"""외부 API의 로컬 입력 상태만 확인한다. 연결·키 유효성 검증은 실행하지 않는다."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import unicodedata
from urllib.parse import urlsplit

MAX_BYTES = 1024 * 1024
KEYS = {
    "kakao": "KAKAO_REST_API_KEY",
    "kopis": "KOPIS_API_KEY",
    "seoul": "SEOUL_OPEN_DATA_API_KEY",
    "tour": "TOUR_API_SERVICE_KEY",
    "potens": "POTENS_API_KEY",
}
POTENS_FIELDS = {
    "base_url": "POTENS_API_BASE_URL",
    "model": "POTENS_MODEL",
    "docs_url": "POTENS_API_DOCS_URL",
    "purpose": "POTENS_API_PURPOSE",
}


class InputError(Exception):
    """고정 코드만 보관한다. 경로·원문·외부 예외 메시지는 보관하지 않는다."""


class SafeParser(argparse.ArgumentParser):
    def error(self, _message):
        raise InputError("INVALID_ARGUMENTS")


def read_env(path):
    """일반 파일만 읽는다. symlink·특수파일·과대파일과 변경 경쟁은 거절한다."""
    candidate = Path(os.path.abspath(path))
    if any(part.is_symlink() for part in (candidate, *candidate.parents)):
        raise InputError("SYMLINK_NOT_ALLOWED")
    before = candidate.stat()
    if not stat.S_ISREG(before.st_mode):
        raise InputError("REGULAR_FILE_REQUIRED")
    if before.st_size > MAX_BYTES:
        raise InputError("FILE_TOO_LARGE")
    fd = os.open(candidate, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode) or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise InputError("FILE_CHANGED")
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise InputError("FILE_TOO_LARGE")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise InputError("INVALID_ENCODING") from None


def parse_env(text):
    """엄격한 단일행 dotenv. 실행·변수 치환·escape 해석을 하지 않는다."""
    text = text.replace("\r\n", "\n")
    if any(character != "\n" and unicodedata.category(character) in {"Cc", "Cf", "Zl", "Zp"} for character in text):
        raise InputError("CONTROL_CHARACTER")
    values = {}
    for raw in text.split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise InputError("INVALID_ASSIGNMENT")
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise InputError("INVALID_IDENTIFIER")
        if key in values:
            raise InputError("DUPLICATE_KEY")
        if value.startswith(("'", '"')):
            quote = value[0]
            end = value.find(quote, 1)
            if end < 0 or (value[end + 1:].strip() and not value[end + 1:].strip().startswith("#")):
                raise InputError("INVALID_QUOTE")
            value = value[1:end]
        else:
            value = "" if value.startswith("#") else re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
            if "'" in value or '"' in value:
                raise InputError("INVALID_QUOTE")
        values[key] = value
    return values


def report(values):
    def presence(key):
        return "present" if values.get(key, "").strip() else "missing"

    def required(key, valid=lambda _value: True):
        value = values.get(key, "")
        if not value.strip():
            return "missing"
        return "present" if value == value.strip() and valid(value) else "invalid"

    def origin_only(value):
        try:
            parsed = urlsplit(value)
            host = parsed.hostname or ""
            host = "[" + host + "]" if ":" in host else host.encode("idna").decode("ascii")
            port = parsed.port
            origin = "https://" + host + (":" + str(port) if port not in (None, 443) else "")
            return bool(host) and parsed.scheme == "https" and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and value in (origin, origin + "/") and not re.search(r"\s", value)
        except (ValueError, UnicodeError):
            return False

    providers = {provider: {"api_key": required(key)} for provider, key in KEYS.items()}
    encoding = values.get("TOUR_API_KEY_FORMAT", "")
    if encoding not in ("", "unknown", "encoded", "decoded"):
        raise InputError("INVALID_TOUR_KEY_FORMAT")
    providers["tour"]["key_format"] = encoding or "unknown"
    providers["potens"].update({field: presence(key) for field, key in POTENS_FIELDS.items()})
    providers["potens"].update({
        "base_url": required("POTENS_API_BASE_URL", origin_only),
        "model": required("POTENS_MODEL", lambda value: re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}", value) is not None),
        "timeout": required("UPSTREAM_TIMEOUT_MS", lambda value: re.fullmatch(r"[1-9][0-9]{0,9}", value) is not None and int(value) <= 2147483647),
    })
    complete = all(value["api_key"] == "present" for value in providers.values()) and encoding in ("encoded", "decoded")
    complete = complete and all(providers["potens"][field] == "present" for field in ("base_url", "model", "timeout"))
    invalid = any("invalid" in value.values() for value in providers.values())
    return {
        "version": 1, "status": "INVALID_INPUT" if invalid else "INPUTS_PRESENT" if complete else "INCOMPLETE", "offline": True,
        "validation": "OFFLINE_SYNTAX_ONLY", "connection_check": "NOT_RUN", "providers": providers,
        "note": "키 입력은 실제 연결 검증이 아닙니다. 값·URL·파일 경로는 출력하지 않습니다.",
    }


def main(argv=None):
    parser = SafeParser(prog="check_api_env.py", description=__doc__, epilog=
        "KEY=value 또는 단일/이중 따옴표의 단일행 값과 # 주석만 지원합니다. "
        "export·다중행·escape 해석·환경변수 치환은 지원하지 않습니다. "
        "종료 코드: 0=입력 존재(연결 NOT_RUN), 2=필수 입력 부족, 1=파일/형식/인수 오류.")
    parser.add_argument("--env-file", required=True, metavar="PATH", help="읽기 전용으로 확인할 로컬 .env 파일을 명시")
    try:
        args = parser.parse_args(argv)
        result = report(parse_env(read_env(args.env_file)))
    except InputError as error:
        result = {"version": 1, "status": "INVALID_INPUT", "offline": True,
                  "connection_check": "NOT_RUN", "error": error.args[0]}
    except (OSError, ValueError, TypeError):
        result = {"version": 1, "status": "INVALID_INPUT", "offline": True,
                  "connection_check": "NOT_RUN", "error": "FILE_READ_FAILED"}
    except Exception:
        # 예상하지 못한 내부 예외도 stderr traceback으로 설정 원문을 유출하지 않는다.
        result = {"version": 1, "status": "INVALID_INPUT", "offline": True,
                  "connection_check": "NOT_RUN", "error": "CHECK_FAILED"}
    print(json.dumps(result, ensure_ascii=False))
    return 1 if result["status"] == "INVALID_INPUT" else 2 if result["status"] == "INCOMPLETE" else 0


if __name__ == "__main__":
    raise SystemExit(main())
