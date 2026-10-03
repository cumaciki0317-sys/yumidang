#!/usr/bin/env python3
"""TourAPI 공식 HTTPS에 원문 키를 한 번 직렬화해 최소 조회한다. 기본 NOT_RUN."""
from datetime import date
import json
import os
import re
import selectors
import subprocess
import time
from urllib.parse import urlencode
import xml.etree.ElementTree as ET

from check_api_env import InputError, SafeParser, parse_env, read_env

ENDPOINT = "https://apis.data.go.kr/B551011/KorService2/searchFestival2"
BODY_LIMIT = 65536
SUCCESS_CODES = {"00", "0000"}  # 공식 v4.4 정상코드 표와 실제 응답 예시
CODES = SUCCESS_CODES | {"01", "02", "03", "04", "05", "10", "11", "12", "20", "22", "23", "29", "30", "31", "32", "99"}


def request_url(key, day):
    if not isinstance(key, str) or not key or key != key.strip() or len(key) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in key):
        raise InputError("INVALID_KEY")
    if not re.fullmatch(r"[0-9]{8}", day):
        raise InputError("INVALID_DATE")
    try:
        date(int(day[:4]), int(day[4:6]), int(day[6:]))
    except ValueError:
        raise InputError("INVALID_DATE") from None
    # 명시 raw-input 실험이다. %, + 등을 보고 decode/형식추정/재시도하지 않는다.
    return ENDPOINT + "?" + urlencode({
        "serviceKey": key, "MobileOS": "WEB", "MobileApp": "YumidangValidation",
        "eventStartDate": day, "eventEndDate": day,
        "pageNo": "1", "numOfRows": "1", "_type": "json",
    })


def curl_request(url):
    """키 포함 URL은 stdin만 사용한다. stdout은 메모리에서 제한하며 stderr는 폐기한다."""
    command = ["/usr/bin/curl", "-q", "--silent", "--proto", "=https", "--proto-redir", "=https",
               "--noproxy", "*", "--connect-timeout", "10", "--max-time", "20",
               "--max-redirs", "0", "--max-filesize", str(BODY_LIMIT),
               "--write-out", "\n%{http_code}", "--config", "-"]
    config = ('url = ' + json.dumps(url) + '\n').encode("ascii")
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env={})
    chunks, size, deadline = [], 0, time.monotonic() + 23
    try:
        process.stdin.write(config)
        process.stdin.close()
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise InputError("TRANSPORT_TIMEOUT")
                if not selector.select(remaining):
                    raise InputError("TRANSPORT_TIMEOUT")
                chunk = os.read(process.stdout.fileno(), 8192)
                if not chunk:
                    break
                size += len(chunk)
                if size > BODY_LIMIT + 4:
                    raise InputError("RESPONSE_TOO_LARGE")
                chunks.append(chunk)
        returncode = process.wait(timeout=max(0.1, deadline - time.monotonic()))
        if returncode:
            raise InputError("TRANSPORT_FAILED")
        body, separator, status = b"".join(chunks).rpartition(b"\n")
        if not separator or not re.fullmatch(rb"[0-9]{3}", status):
            raise InputError("TRANSPORT_FAILED")
        return int(status), body
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()
        if not process.stdin.closed:
            process.stdin.close()


def response_report(http_status, body):
    result = {"status": "FAIL", "http_status": http_status}
    if http_status != 200:
        return {**result, "reason": "HTTP_ERROR"}
    if len(body) > BODY_LIMIT:
        return {**result, "reason": "RESPONSE_TOO_LARGE"}
    try:
        payload = json.loads(body)
        response = payload.get("response", payload)
        code = response["header"]["resultCode"]
        if not isinstance(code, str) or code not in SUCCESS_CODES:
            return {**result, "reason": "PROVIDER_ERROR", "provider_code": code if isinstance(code, str) and code in CODES else "UNKNOWN"}
        data = response["body"]
        items = data.get("items")
        if items in (None, ""):
            records = []
        elif isinstance(items, dict):
            records = items.get("item", [])
            if isinstance(records, dict):
                records = [records]
        else:
            raise ValueError()
        if not isinstance(records, list) or len(records) > 1 or any(not isinstance(row, dict) or not row.get("contentid") for row in records):
            raise ValueError()
        total = data.get("totalCount")
        if isinstance(total, str) and re.fullmatch(r"[0-9]+", total):
            total = int(total)
        if type(total) is not int or total < len(records) or (not records and total != 0):
            raise ValueError()
        return {"status": "PASS", "http_status": http_status, "provider_code": code, "returned_count": len(records), "empty": not records}
    except (ValueError, TypeError, KeyError, AttributeError):
        # Gateway 인증 오류는 _type=json이어도 XML일 수 있다. 원문은 출력하지 않는다.
        try:
            if b"<!DOCTYPE" in body.upper() or b"<!ENTITY" in body.upper():
                raise ValueError()
            root = ET.fromstring(body)
            code = root.findtext(".//returnReasonCode") or root.findtext(".//resultCode")
            if code and code not in SUCCESS_CODES:
                return {**result, "reason": "PROVIDER_ERROR", "provider_code": code if code in CODES else "UNKNOWN"}
        except (ValueError, ET.ParseError):
            pass
        return {**result, "reason": "INVALID_RESPONSE"}


def main(argv=None):
    base = {"provider": "tour-api", "serialization": "RAW_INPUT_URLENCODE_ONCE", "key_format_detection": "NOT_RUN", "config_modified": False}
    try:
        parser = SafeParser(description=__doc__)
        parser.add_argument("--run", action="store_true")
        parser.add_argument("--raw-input", action="store_true", help="발급형식을 추정하지 않고 입력 문자열을 쿼리 값으로 한 번 직렬화")
        parser.add_argument("--env-file")
        parser.add_argument("--event-date", default=date.today().strftime("%Y%m%d"))
        args = parser.parse_args(argv)
        if not args.run:
            result = {**base, "status": "NOT_RUN", "connection_check": "NOT_RUN"}
        else:
            if not args.env_file or not args.raw_input:
                raise InputError("EXPLICIT_INPUT_REQUIRED")
            values = parse_env(read_env(args.env_file))
            key_format = values.get("TOUR_API_KEY_FORMAT", "") or "unknown"
            if key_format not in ("unknown", "encoded", "decoded"):
                raise InputError("INVALID_KEY_FORMAT")
            url = request_url(values.get("TOUR_API_SERVICE_KEY"), args.event_date)
            status, body = curl_request(url)
            result = {**base, **response_report(status, body), "connection_check": "RUN", "input_key_format": key_format}
    except InputError:
        # parser/file/transport 원문이나 URL을 예외 문자열로 재노출하지 않는다.
        result = {**base, "status": "FAIL", "reason": "INPUT_OR_TRANSPORT_FAILED"}
    except Exception:
        result = {**base, "status": "FAIL", "reason": "CHECK_FAILED"}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] in ("PASS", "NOT_RUN") else 1


if __name__ == "__main__":
    raise SystemExit(main())
