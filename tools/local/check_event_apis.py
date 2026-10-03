#!/usr/bin/env python3
"""KOPIS·서울 API 최소 진단. 기본은 NOT_RUN이며 키·URL·응답 원문을 출력하지 않는다."""
from datetime import datetime
import json
import re
import subprocess
from urllib.parse import urlencode, urlsplit
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo

from check_api_env import SafeParser, read_env, parse_env

KOPIS_ENDPOINT = "https://kopis.or.kr/openApi/restful/pblprfr"
MAX_BODY = 131072
MARKER = b"\n__EVENT_API_STATUS__"


def fetch_kopis(url):
    """자격 증명은 stdin config에만 전달. redirect·HTTP·curlrc·원문 출력 금지."""
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.netloc != "kopis.or.kr" or parsed.path != "/openApi/restful/pblprfr"
            or parsed.fragment or any(character in url for character in ('"', "\\", "\r", "\n"))):
        return {"transport": "DESTINATION_REJECTED", "http_status": None, "body": b""}
    command = ["/usr/bin/curl", "--disable", "--silent", "--proto", "=https", "--proto-redir", "=https",
               "--max-redirs", "0", "--connect-timeout", "5", "--max-time", "15",
               "--max-filesize", str(MAX_BODY), "--write-out", MARKER.decode() + "%{http_code} %{ssl_verify_result}",
               "--config", "-"]
    try:
        result = subprocess.run(command, input=('url = "' + url + '"\n').encode(),
                                capture_output=True, timeout=18, env={"PATH": "/usr/bin:/bin"})
    except Exception:
        return {"transport": "TRANSPORT_EXCEPTION", "http_status": None, "body": b""}
    # stderr는 URL·응답을 포함할 수 있어 검사 결과에 복사하지 않는다.
    if len(result.stdout) > MAX_BODY + 100:
        return {"transport": "BODY_TOO_LARGE", "http_status": None, "body": b""}
    body, separator, suffix = result.stdout.rpartition(MARKER)
    status = None
    if separator and re.fullmatch(rb"[0-9]{3} [0-9]+", suffix):
        code, tls = suffix.split()
        status = int(code) if 100 <= int(code) <= 599 else None
    else:
        return {"transport": "INVALID_TRANSPORT_METADATA", "http_status": None, "body": b""}
    if result.returncode != 0:
        failure = {28: "TIMEOUT", 35: "TLS_FAILED", 60: "TLS_FAILED", 63: "BODY_TOO_LARGE"}.get(result.returncode, "TRANSPORT_FAILED")
        return {"transport": failure, "http_status": status, "body": b""}
    if tls != b"0":
        return {"transport": "TLS_FAILED", "http_status": status, "body": b""}
    return {"transport": "OK", "http_status": status, "body": body}


def inspect_kopis(status, body):
    """XML 행 구조만 검사한다. 공급사 원문 오류/행 데이터는 반환하지 않는다."""
    if status != 200:
        return {"status": "FAIL", "result": "REDIRECT_NOT_FOLLOWED" if status and 300 <= status < 400 else "HTTP_ERROR"}
    if len(body) > MAX_BODY:
        return {"status": "FAIL", "result": "BODY_TOO_LARGE"}
    if b"<!DOCTYPE" in body.upper() or b"<!ENTITY" in body.upper():
        return {"status": "FAIL", "result": "UNSAFE_XML"}
    try:
        root = ET.fromstring(body)
    except (ET.ParseError, ValueError):
        return {"status": "FAIL", "result": "MALFORMED_XML"}
    if root.tag != "dbs":
        return {"status": "FAIL", "result": "PROVIDER_ERROR_OR_UNEXPECTED_ENVELOPE"}
    if any(child.tag != "db" for child in root):
        return {"status": "FAIL", "result": "PROVIDER_ERROR_OR_UNEXPECTED_ENVELOPE"}
    rows = list(root)
    if len(rows) == 0:
        # 공급사가 키 오류도 빈 dbs로 표시할 가능성을 성공으로 숨기지 않는다.
        return {"status": "FAIL", "result": "EMPTY_RESPONSE_NOT_VERIFIED", "rows": 0}
    if len(rows) != 1 or any(not (rows[0].findtext(field) or "").strip() for field in ("mt20id", "prfnm", "prfpdfrom", "prfpdto")):
        return {"status": "FAIL", "result": "INVALID_ROW_SHAPE"}
    return {"status": "PASS", "result": "VALID_XML_ROW", "rows": 1}


def inspect_seoul(status, body):
    """향후 공식 HTTPS 확인 후 사용할 응답 검사. 현재 실키 요청 경로는 없다."""
    if status != 200:
        return {"status": "FAIL", "result": "HTTP_ERROR"}
    if len(body) > MAX_BODY:
        return {"status": "FAIL", "result": "BODY_TOO_LARGE"}
    try:
        payload = json.loads(body)
        envelope = payload.get("culturalEventInfo", payload)
        if not isinstance(envelope, dict) or not isinstance(envelope.get("RESULT"), dict):
            raise ValueError()
        if envelope["RESULT"].get("CODE") != "INFO-000":
            return {"status": "FAIL", "result": "PROVIDER_ERROR"}
        rows = envelope.get("row")
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict) or not rows[0].get("TITLE"):
            return {"status": "FAIL", "result": "INVALID_ROW_SHAPE"}
        return {"status": "PASS", "result": "VALID_JSON_ROW", "rows": 1}
    except (ValueError, AttributeError, TypeError):
        return {"status": "FAIL", "result": "MALFORMED_JSON_OR_ENVELOPE"}


def main(argv=None):
    parser = SafeParser(prog="check_event_apis.py", description=__doc__, epilog=
        "--run과 --provider를 명시해야 호출합니다. KOPIS는 Asia/Seoul 오늘 하루·1행만 요청합니다. "
        "서울은 확인된 HTTPS API가 없어 실키 요청을 하지 않습니다. "
        "종료코드 0=최소응답 PASS, 2=NOT_RUN, 1=검증실패. 서비스 adapter·저장·배포는 검증 범위가 아닙니다.")
    parser.add_argument("--provider", choices=("kopis", "seoul"), required=True)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--env-file", metavar="PATH")
    provider = "unknown"
    attempted = False
    try:
        args = parser.parse_args(argv)
        provider = args.provider
        if not args.run:
            result = {"status": "NOT_RUN", "result": "EXPLICIT_RUN_REQUIRED"}
        elif provider == "seoul":
            result = {"status": "NOT_RUN", "result": "OFFICIAL_HTTPS_UNVERIFIED"}
        elif not args.env_file:
            result = {"status": "NOT_RUN", "result": "ENV_FILE_REQUIRED"}
        else:
            values = parse_env(read_env(args.env_file))
            key = values.get("KOPIS_API_KEY", "")
            if not key or key != key.strip() or any(ord(char) < 32 or ord(char) == 127 for char in key):
                result = {"status": "NOT_RUN", "result": "KEY_MISSING_OR_INVALID"}
            else:
                day = datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y%m%d")
                url = KOPIS_ENDPOINT + "?" + urlencode({"service": key, "stdate": day, "eddate": day, "cpage": 1, "rows": 1})
                attempted = True
                response = fetch_kopis(url)
                result = inspect_kopis(response["http_status"], response["body"]) if response["transport"] == "OK" else {
                    "status": "FAIL", "result": response["transport"]}
                result["http_status"] = response["http_status"]
    except Exception:
        # 파일명·XML/JSON 오류·URL 포함 예외를 stderr나 JSON에 기록하지 않는다.
        result = {"status": "FAIL", "result": "INPUT_OR_CHECK_FAILED"}
    result.update(provider=provider, keyed_request_attempted=attempted, service_integration="NOT_RUN")
    print(json.dumps(result))
    return 0 if result["status"] == "PASS" else 2 if result["status"] == "NOT_RUN" else 1


if __name__ == "__main__":
    raise SystemExit(main())
