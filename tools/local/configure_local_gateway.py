#!/usr/bin/env python3
"""전용 로컬 Kong의 functions-v1 CORS 하나만 제거한다. 기본 검사, 적용은 --apply.

원본은 메모리에만 보관한다. 키/원문/ID/응답/예외를 출력하거나 파일로 저장하지 않는다.
Supabase CLI 재시작으로 Kong 설정이 재생성되면 이 검사를 다시 수행한다.
"""

import argparse
import copy
import json
import math
from pathlib import Path
import re
import subprocess
import sys

CONTEXT = "colima-yumidang-minkyu"
PROJECT = "yumidang-minkyu-gateway"
CONTAINER = "supabase_kong_" + PROJECT
MAX_BYTES = 2097152
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
YAML_TO_JSON = r'''
def inspect_node(node)
  raise 'alias' if node.is_a?(Psych::Nodes::Alias)
  raise 'anchor' if node.respond_to?(:anchor) && node.anchor
  if node.is_a?(Psych::Nodes::Mapping)
    keys = []
    node.children.each_slice(2) do |key, value|
      raise 'key' unless key.is_a?(Psych::Nodes::Scalar)
      raise 'duplicate' if keys.include?(key.value)
      keys << key.value
      inspect_node(value)
    end
  elsif node.respond_to?(:children) && node.children
    node.children.each { |child| inspect_node(child) }
  end
end
begin
  raw = STDIN.read
  raise 'size' if raw.bytesize > 2097152
  ast = Psych.parse_stream(raw)
  raise 'documents' unless ast.children.length == 1
  inspect_node(ast)
  value = Psych.safe_load(raw, [], [], false)
  raise 'root' unless value.is_a?(Hash)
  STDOUT.write(JSON.generate(value))
rescue Exception
  exit 1
end
'''


class GatewayError(ValueError):
    def __init__(self, code="LOCAL_GATEWAY_REJECTED", *, metadata=None):
        super().__init__(code)
        self.metadata = metadata or {}


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # 알 수 없는 argv에 비밀값이 있어도 argparse 원문 오류로 출력하지 않는다.
        reject()


def reject():
    raise GatewayError()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            reject()
        result[key] = value
    return result


def strict_json(payload):
    if not isinstance(payload, bytes) or not payload or len(payload) > MAX_BYTES:
        reject()
    try:
        value = json.loads(payload, object_pairs_hook=unique_object,
                           parse_constant=lambda _: reject())
        count = 0
        def check(item, depth=0):
            nonlocal count
            count += 1
            if depth > 64 or count > 50000:
                reject()
            if item is None or type(item) in (str, bool):
                return
            if type(item) in (int, float):
                if not math.isfinite(item) or abs(item) > 9007199254740991:
                    reject()
            elif isinstance(item, list):
                for child in item:
                    check(child, depth + 1)
            elif isinstance(item, dict):
                for key, child in item.items():
                    if not isinstance(key, str):
                        reject()
                    check(child, depth + 1)
            else:
                reject()
        check(value)
        return value
    except Exception:
        reject()


def command(args, payload=None, run=subprocess.run):
    try:
        result = run(args, input=payload, capture_output=True, check=False, timeout=20)
        if result.returncode != 0:
            raise GatewayError(metadata={"commandExit": result.returncode if 0 <= result.returncode <= 255 else -1})
        if not isinstance(result.stdout, bytes) or len(result.stdout) > MAX_BYTES + 8:
            reject()
        return result.stdout
    except GatewayError:
        raise
    except Exception:
        reject()


def parse_export(payload, run=subprocess.run):
    envelope = strict_json(payload)
    if not isinstance(envelope, dict) or set(envelope) != {"config"} or not isinstance(envelope["config"], str):
        reject()
    raw = envelope["config"].encode("utf-8")
    if len(raw) > MAX_BYTES:
        reject()
    converted = command(["/usr/bin/ruby", "-rjson", "-rpsych", "-e", YAML_TO_JSON], raw, run)
    document = strict_json(converted)
    if not isinstance(document, dict) or document.get("_format_version") != "2.1" or document.get("_transform") is not False:
        reject()
    return document


def validate_target(endpoint, container):
    try:
        if endpoint != "unix://" + str(Path.home()) + "/.colima/yumidang-minkyu/docker.sock":
            reject()
        if (container["Name"] != "/" + CONTAINER or container["State"]["Running"] is not True
                or container["Config"]["Labels"]["com.supabase.cli.project"] != PROJECT
                or container["Config"]["Image"] != "public.ecr.aws/supabase/kong:2.8.1"):
            reject()
        raw_env = container["Config"]["Env"]
        if not isinstance(raw_env, list) or any(not isinstance(item, str) or "=" not in item for item in raw_env):
            reject()
        env = unique_object(item.split("=", 1) for item in raw_env)
        if env.get("KONG_DATABASE") != "off" or env.get("KONG_DECLARATIVE_CONFIG") != "/home/kong/kong.yml":
            reject()
        if "KONG_ADMIN_LISTEN" in env and env["KONG_ADMIN_LISTEN"] not in ("0.0.0.0:8001", "127.0.0.1:8001"):
            reject()
        if container.get("NetworkSettings", {}).get("Ports", {}).get("8001/tcp"):
            reject()
        if container.get("HostConfig", {}).get("PortBindings", {}).get("8001/tcp"):
            reject()
    except Exception:
        reject()


def transform_document(document):
    # functions-v1의 ID 관계로만 대상을 정하고 나머지 설정·credential은 보존한다.
    if not isinstance(document, dict) or document.get("_format_version") != "2.1" or document.get("_transform") is not False:
        reject()
    services, plugins = document.get("services"), document.get("plugins")
    if not isinstance(services, list) or not isinstance(plugins, list) or any(not isinstance(item, dict) for item in services + plugins):
        reject()
    targets = [service for service in services if service.get("name") == "functions-v1"]
    if len(targets) != 1 or not isinstance(targets[0].get("id"), str) or not UUID.fullmatch(targets[0]["id"]):
        reject()
    service_id = targets[0]["id"]
    matches = [index for index, plugin in enumerate(plugins) if plugin.get("name") == "cors"
               and plugin.get("service") in (service_id, {"id": service_id})]
    if len(matches) > 1:
        reject()
    result = copy.deepcopy(document)
    if matches:
        del result["plugins"][matches[0]]
    return result, bool(matches)


def admin_request(method, payload=None, run=subprocess.run):
    if method not in ("GET", "POST") or (method == "GET" and payload is not None):
        reject()
    if method == "POST" and (not isinstance(payload, bytes) or len(payload) > MAX_BYTES):
        reject()
    script = (("local b=io.read('*a');if not b or #b==0 then os.exit(2) end;" if method == "POST" else "")
              + "local h=require('resty.http').new();h:set_timeout(5000);"
              "local r=h:request_uri('http://127.0.0.1:8001/config',{method='" + method + "',"
              "headers={['Accept']='application/json',['Content-Type']='application/json'}"
              + (",body=b" if method == "POST" else "")
              + "});if not r then os.exit(1) end;io.write(tostring(r.status)..'\\n'..(r.body or ''))")
    raw = command(["docker", "--context", CONTEXT, "exec", "-i", CONTAINER,
                   "/usr/local/bin/resty", "-e", script], payload, run)
    status, separator, body = raw.partition(b"\n")
    if not separator or not re.fullmatch(b"[0-9]{3}", status):
        reject()
    if not 200 <= int(status) < 300:
        metadata = {"upstreamStatus": int(status)}
        try:
            error = strict_json(body)
            if isinstance(error, dict) and type(error.get("code")) is int and 0 <= error["code"] <= 999:
                metadata["upstreamCode"] = error["code"]
            # 스키마 필드명만 알려진 이름으로 제한한다. 오류 설명/입력값/동적 ID 키는 출력하지 않는다.
            allowed = {"services", "routes", "plugins", "consumers", "basicauth_credentials", "keyauth_credentials",
                       "jwt_secrets", "acls", "name", "id", "service", "route", "config", "hosts", "headers",
                       "methods", "paths", "protocols", "port", "host", "url", "enabled", "consumer", "key",
                       "secret", "username", "password", "algorithm", "credentials", "tags", "fields"}
            names = set()
            def fields(value):
                if isinstance(value, dict):
                    for key, child in value.items():
                        if key in allowed:
                            names.add(key)
                        fields(child)
                elif isinstance(value, list):
                    for child in value:
                        fields(child)
            if isinstance(error, dict):
                fields(error.get("fields"))
            if names:
                metadata["validationFields"] = sorted(names)[:20]
        except Exception:
            pass
        raise GatewayError(metadata=metadata)
    return body


def encode_document(document):
    try:
        payload = json.dumps(document, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > MAX_BYTES:
            reject()
        return payload
    except Exception:
        reject()


def semantic_equal(expected, observed):
    """Kong이 재출력하는 3개 entity 목록 순서와 증가하는 관리 시각만 정규화한다."""
    if not isinstance(expected, dict) or not isinstance(observed, dict):
        return False
    left, right = copy.deepcopy(expected), copy.deepcopy(observed)
    for collection in ("services", "routes", "plugins"):
        if (collection in left) != (collection in right):
            return False
        if collection not in left:
            continue
        def indexed(rows):
            if not isinstance(rows, list) or any(not isinstance(row, dict) or not isinstance(row.get("id"), str)
                                                 or not UUID.fullmatch(row["id"]) for row in rows):
                return None
            result = {row["id"]: row for row in rows}
            return result if len(result) == len(rows) else None
        old, new = indexed(left[collection]), indexed(right[collection])
        if old is None or new is None or set(old) != set(new):
            return False
        for identity, old_row in old.items():
            new_row = new[identity]
            if ("updated_at" in old_row) != ("updated_at" in new_row):
                return False
            if "updated_at" in old_row:
                old_at, new_at = old_row["updated_at"], new_row["updated_at"]
                if type(old_at) is not int or type(new_at) is not int or not 0 <= old_at <= new_at <= 9007199254740991:
                    return False
                del old_row["updated_at"]; del new_row["updated_at"]
        left[collection] = [old[identity] for identity in sorted(old)]
        right[collection] = [new[identity] for identity in sorted(new)]
    # config 안의 배열 순서, bool/number/null 형식, credential·ID·기본값은 모두 엄격히 비교한다.
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def configure_local_gateway(apply=False, run=subprocess.run):
    endpoint = strict_json(command(["docker", "--context", CONTEXT, "context", "inspect", CONTEXT,
                                    "--format", "{{json .Endpoints.docker.Host}}"], run=run))
    targets = strict_json(command(["docker", "--context", CONTEXT, "inspect", CONTAINER], run=run))
    if not isinstance(targets, list) or len(targets) != 1:
        reject()
    validate_target(endpoint, targets[0])
    original = parse_export(admin_request("GET", run=run), run)
    desired, changed = transform_document(original)
    if not apply or not changed:
        return {"status": "READY", "scope": "local_gateway", "mode": "check" if not apply else "apply",
                "changeRequired": changed, "applied": False}
    desired_payload, original_payload = encode_document(desired), encode_document(original)
    stage = "apply_post"
    try:
        # Kong POST /config는 전체 JSON 문서를 받는다. credential 변환을 재적용하지 않는다.
        admin_request("POST", desired_payload, run)
        stage = "verify_get"
        observed = parse_export(admin_request("GET", run=run), run)
        stage = "verify_compare"
        if not semantic_equal(desired, observed):
            reject()
    except Exception as error:
        restored = False
        rollback_metadata = {}
        try:
            admin_request("POST", original_payload, run)
            restored = semantic_equal(original, parse_export(admin_request("GET", run=run), run))
        except Exception as rollback_error:
            if isinstance(rollback_error, GatewayError):
                rollback_metadata = rollback_error.metadata
        return {"status": "FAIL", "scope": "local_gateway", "code": "LOCAL_GATEWAY_APPLY_FAILED",
                "restored": restored, "applied": False, "failedStage": stage,
                **(error.metadata if isinstance(error, GatewayError) else {}),
                "rollbackMetadata": rollback_metadata}
    return {"status": "PASS", "scope": "local_gateway", "mode": "apply", "changeRequired": False, "applied": True}


def main():
    parser = SafeArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="검증한 CORS 하나 제거를 명시적으로 적용")
    try:
        args = parser.parse_args()
        report = configure_local_gateway(args.apply)
    except Exception:
        report = {"status": "FAIL", "scope": "local_gateway", "code": "LOCAL_GATEWAY_REJECTED"}
    print(json.dumps(report, ensure_ascii=False))
    return 1 if report["status"] == "FAIL" else 0


if __name__ == "__main__":
    sys.exit(main())
