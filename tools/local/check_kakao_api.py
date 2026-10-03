#!/usr/bin/env python3
"""Kakao 공식 장소 조회 1건을 명시 실행하고 원문 없이 오류 원인만 분류한다."""
import json
import re
import subprocess
from check_api_env import InputError, SafeParser, parse_env, read_env

URL = "https://dapi.kakao.com/v2/local/search/keyword.json?query=%EC%84%9C%EC%9A%B8%EC%97%AD&page=1&size=1"
MAX_BODY = 65536
# 공식 REST 공통 에러 코드의 고정 대응. 공급사 원문은 결과에 복사하지 않는다.
CODES = {-3: "FEATURE_OR_API_NOT_ENABLED", -4: "ACCOUNT_RESTRICTED", -5: "API_PERMISSION_REQUIRED",
         -12: "APP_OR_ACCOUNT_RESTRICTED", -401: "INVALID_AUTHENTICATION", -2: "INVALID_REQUEST",
         -8: "INVALID_HEADER", -10: "QUOTA_EXCEEDED", -11: "PAID_API_LIMIT_EXCEEDED",
         -13: "APP_DORMANT"}


def summary(classification, *, execution="FAIL", http_status=None, upstream_code=None):
    result = {"provider": "kakao", "execution": execution, "classification": classification}
    if http_status is not None:
        result["http_status"] = http_status
    if upstream_code is not None:
        result["upstream_code"] = upstream_code
    return result


def classify(status, body):
    if len(body) > MAX_BODY:
        return summary("RESPONSE_TOO_LARGE", http_status=status)
    try:
        parsed = json.loads(body)
    except (ValueError, UnicodeError):
        parsed = None
    if status == 200:
        if isinstance(parsed, dict) and isinstance(parsed.get("documents"), list) and len(parsed["documents"]) <= 1 and isinstance(parsed.get("meta"), dict):
            return summary("PUBLIC_QUERY_SUCCEEDED", execution="PASS", http_status=status)
        return summary("INVALID_RESPONSE", http_status=status)
    if isinstance(parsed, dict):
        code = parsed.get("code")
        known = code if type(code) is int and code in CODES else None
        # App 이름은 임의 문자열이므로 절대 출력하지 않고 완전 일치하는 고정 문구만 분류한다.
        if status == 403 and parsed.get("errorType") == "NotAuthorizedError" and isinstance(parsed.get("message"), str) and re.fullmatch(r"App\([^\r\n]{1,200}\) disabled OPEN_MAP_AND_LOCAL service\.", parsed["message"]):
            return summary("MAP_LOCAL_SERVICE_DISABLED", http_status=status, upstream_code=known)
        if known is not None:
            return summary(CODES[known], http_status=status, upstream_code=known)
    classification = {401: "AUTHENTICATION_REJECTED", 403: "FORBIDDEN_UNCLASSIFIED", 429: "QUOTA_EXCEEDED"}.get(status)
    if classification is None:
        classification = "REDIRECT_REFUSED" if 300 <= status < 400 else "PROVIDER_UNAVAILABLE" if status >= 500 else "HTTP_ERROR"
    return summary(classification, http_status=status)


def diagnose(env_file, run=False, transport=None):
    try:
        values = parse_env(read_env(env_file))
        key = values.get("KAKAO_REST_API_KEY", "")
        # curl config 인용/헤더 주입을 막는다. 실제 키 형식이나 유효성을 추측하지 않는다.
        if not key or len(key) > 4096 or not re.fullmatch(r"[A-Za-z0-9_-]+", key):
            return summary("INVALID_LOCAL_KEY", execution="NOT_RUN")
        if not run:
            return summary("EXPLICIT_RUN_REQUIRED", execution="NOT_RUN")
        config = f'header = "Authorization: KakaoAK {key}"\n'
        command = ["/usr/bin/curl", "--disable", "--config", "-", "--silent", "--proto", "=https",
                   "--proto-redir", "=https", "--max-redirs", "0", "--connect-timeout", "5", "--max-time", "15",
                   "--max-filesize", str(MAX_BODY), "--write-out", "\n%{http_code}", URL]
        invoke = transport or subprocess.run
        response = invoke(command, input=config.encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          timeout=20, check=False)
        if response.returncode:
            return summary({28: "NETWORK_TIMEOUT", 60: "TLS_VERIFICATION_FAILED", 63: "RESPONSE_TOO_LARGE"}.get(response.returncode, "NETWORK_FAILED"))
        if not isinstance(response.stdout, bytes) or len(response.stdout) > MAX_BODY + 4:
            return summary("RESPONSE_TOO_LARGE")
        body, separator, code = response.stdout.rpartition(b"\n")
        if not separator or not re.fullmatch(rb"[1-5][0-9]{2}", code):
            return summary("INVALID_RESPONSE")
        return classify(int(code), body)
    except subprocess.TimeoutExpired:
        return summary("NETWORK_TIMEOUT")
    except (InputError, OSError, ValueError, TypeError):
        return summary("LOCAL_INPUT_OR_EXECUTION_FAILED", execution="NOT_RUN")
    except Exception:
        # 예외 원문과 traceback에는 키/응답이 포함될 수 있으므로 보관·출력하지 않는다.
        return summary("CHECK_FAILED")


def main(argv=None):
    parser = SafeParser(prog="check_kakao_api.py", description=__doc__)
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--run", action="store_true")
    try:
        args = parser.parse_args(argv)
        result = diagnose(args.env_file, args.run)
    except Exception:
        result = summary("INVALID_ARGUMENTS", execution="NOT_RUN")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["execution"] == "PASS" or result["classification"] == "EXPLICIT_RUN_REQUIRED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
