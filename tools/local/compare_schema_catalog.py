"""민규: 비공개 catalog JSON 두 개만 비교한다. DB·네트워크·SQL 실행과 원문 출력은 없다."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


class CatalogError(Exception):
    """입력 원문이나 경로를 포함하지 않는 고정 오류 코드."""


def require(value, code="INVALID_CATALOG"):
    if not value:
        raise CatalogError(code)


def object_keys(value, keys):
    require(type(value) is dict and set(value) == set(keys))


def duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def forbidden_number(_):
    raise CatalogError("INVALID_JSON_NUMBER")


def parse_catalog(data):
    require(type(data) is bytes and len(data) <= 8388608, "INVALID_INPUT_FILE")
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=duplicate_keys,
                          parse_constant=forbidden_number, parse_float=forbidden_number)
    except CatalogError:
        raise
    except (ValueError, UnicodeError, RecursionError):
        raise CatalogError("INVALID_JSON") from None


def read_private_catalog(filename):
    """권한600·소유자·단일 링크 파일을 권한700 디렉터리의 열린 fd로 읽는다."""
    path = Path(filename)
    require(path.is_absolute(), "INVALID_INPUT_FILE")
    directory = descriptor = None
    try:
        require(path.parent.resolve() == path.parent, "INVALID_INPUT_FILE")
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        parent = os.fstat(directory)
        require(stat.S_ISDIR(parent.st_mode) and stat.S_IMODE(parent.st_mode) == 0o700
                and parent.st_uid == os.getuid(), "INVALID_INPUT_FILE")
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and stat.S_IMODE(before.st_mode) == 0o600
                and before.st_uid == os.getuid() and before.st_nlink == 1
                and before.st_size <= 8388608, "INVALID_INPUT_FILE")
        chunks, size = [], 0
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            size += len(chunk)
            require(size <= 8388608, "INVALID_INPUT_FILE")
            chunks.append(chunk)
        after = os.fstat(descriptor)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                "INPUT_FILE_CHANGED")
        return parse_catalog(b"".join(chunks))
    except CatalogError:
        raise
    except (OSError, ValueError, RuntimeError):
        raise CatalogError("INVALID_INPUT_FILE") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if directory is not None:
            os.close(directory)


def field(value, kind):
    if kind.startswith("?"):
        if value is None:
            return None
        kind = kind[1:]
    if kind == "text":
        require(type(value) is str and 0 < len(value) <= 8192 and "\x00" not in value)
    elif kind == "emptyText":
        require(type(value) is str and len(value) <= 8192 and "\x00" not in value)
    elif kind == "bool":
        require(type(value) is bool)
    elif kind == "int":
        require(type(value) is int and 0 <= value <= 2147483647)
    elif kind == "position":
        require(type(value) is int and 1 <= value <= 2147483647)
    elif kind == "md5":
        require(type(value) is str and re.fullmatch("[0-9a-f]{32}", value) is not None)
    elif kind == "version":
        require(type(value) is str and re.fullmatch("[0-9]{14}", value) is not None)
    elif kind == "textSet":
        require(type(value) is list and len(value) <= 100000)
        for item in value:
            field(item, "text")
        require(len(set(value)) == len(value), "DUPLICATE_IDENTITY")
        return sorted(value)
    elif kind == "acl":
        return normalize_entries(value, "functionAcl")
    else:
        raise CatalogError("INVALID_FORMAT_SPECIFICATION")
    return value


# formatVersion1 producer의 exact keys·types·identity를 고정한다.
GRANT = {"grantor": "text", "grantee": "text", "privilege": "text", "isGrantable": "bool"}
POLICY = {"schema": "text", "table": "text", "name": "text", "command": "text", "permissive": "bool",
          "roles": "textSet", "usingMd5": "?md5", "checkMd5": "?md5"}
SPECS = {
    "schemas": {"schema": "text", "owner": "text"},
    "tables": {"schema": "text", "table": "text", "kind": "text", "owner": "text", "rls": "bool", "forceRls": "bool"},
    "columns": {"schema": "text", "table": "text", "column": "text", "position": "position", "type": "text",
                "notNull": "bool", "identity": "emptyText", "generated": "emptyText", "collation": "?text", "defaultMd5": "?md5"},
    "indexes": {"schema": "text", "table": "text", "name": "text", "method": "text", "unique": "bool", "primary": "bool",
                "valid": "bool", "ready": "bool", "keyCount": "position", "definitionMd5": "md5"},
    "constraints": {"schema": "text", "table": "text", "name": "text", "type": "text", "validated": "bool",
                    "deferrable": "bool", "initiallyDeferred": "bool", "definitionMd5": "md5", "foreignTarget": "?text"},
    "policies": POLICY,
    "storagePolicies": POLICY,
    "triggers": {"schema": "text", "table": "text", "name": "text", "enabled": "text", "definitionMd5": "md5"},
    "functions": {"schema": "text", "name": "text", "identityArguments": "emptyText", "result": "text", "argumentsMd5": "md5",
                  "kind": "text", "language": "text", "owner": "text", "volatility": "text", "definer": "bool", "strict": "bool",
                  "parallel": "text", "bodyMd5": "md5", "searchPath": "?emptyText", "configurationMd5": "?md5", "acl": "acl"},
    "schemaGrants": {"schema": "text", **GRANT},
    "tableGrants": {"schema": "text", "table": "text", **GRANT},
    "columnGrants": {"schema": "text", "table": "text", "column": "text", **GRANT},
    "defaultGrants": {"owner": "text", "schema": "?text", "objectType": "text", **GRANT},
    "functionAcl": GRANT,
    "cron": {"name": "text", "schedule": "text", "active": "bool", "commandMd5": "md5"},
}
STATIC_CATEGORIES = tuple(key for key in SPECS if key not in ("functionAcl", "cron")) + ("migrationVersions",)
GRANT_ID = ("grantor", "grantee", "privilege")
IDENTITIES = {
    "schemas": ("schema",), "tables": ("schema", "table"), "columns": ("schema", "table", "column"),
    "indexes": ("schema", "table", "name"), "constraints": ("schema", "table", "name"),
    "policies": ("schema", "table", "name"), "storagePolicies": ("schema", "table", "name"),
    "triggers": ("schema", "table", "name"), "functions": ("schema", "name", "identityArguments"),
    "schemaGrants": ("schema",) + GRANT_ID, "tableGrants": ("schema", "table") + GRANT_ID,
    "columnGrants": ("schema", "table", "column") + GRANT_ID,
    "defaultGrants": ("owner", "schema", "objectType") + GRANT_ID,
    "functionAcl": GRANT_ID, "cron": ("name",),
}


def normalize_entries(values, category):
    require(type(values) is list and len(values) <= 100000)
    if category == "migrationVersions":
        versions = [field(value, "version") for value in values]
        require(len(set(versions)) == len(versions), "DUPLICATE_IDENTITY")
        return sorted(versions)
    spec = SPECS[category]
    normalized, identities = [], set()
    for value in values:
        object_keys(value, spec)
        entry = {key: field(value[key], kind) for key, kind in spec.items()}
        identity = tuple(entry[key] for key in IDENTITIES[category])
        require(identity not in identities, "DUPLICATE_IDENTITY")
        identities.add(identity)
        normalized.append(entry)
    if category == "columns":
        positions = [(value["schema"], value["table"], value["position"]) for value in normalized]
        require(len(set(positions)) == len(positions), "DUPLICATE_IDENTITY")
    return sorted(normalized, key=lambda value: json.dumps([value[key] for key in IDENTITIES[category]], separators=(",", ":")))


def normalize_catalog(value):
    object_keys(value, ["formatVersion", "static", "context", "operational"])
    require(type(value["formatVersion"]) is int and value["formatVersion"] == 1)
    object_keys(value["static"], STATIC_CATEGORIES)
    object_keys(value["context"], ["serverVersionNum", "serverVersion", "deparseSearchPath"])
    object_keys(value["operational"], ["cron"])
    context = {"serverVersionNum": field(value["context"]["serverVersionNum"], "position"),
               "serverVersion": field(value["context"]["serverVersion"], "text"),
               "deparseSearchPath": field(value["context"]["deparseSearchPath"], "text")}
    require(context["deparseSearchPath"] == "pg_catalog")
    return {"formatVersion": 1,
            "static": {category: normalize_entries(entries, category) for category, entries in value["static"].items()},
            "context": context,
            "operational": {"cron": normalize_entries(value["operational"]["cron"], "cron")}}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def category_diff(local, remote, category):
    def indexed(entries):
        if category == "migrationVersions":
            return {entry: entry for entry in entries}
        return {tuple(entry[key] for key in IDENTITIES[category]): entry for entry in entries}
    left, right = indexed(local), indexed(remote)
    changed = sum(left[key] != right[key] for key in left.keys() & right.keys())
    return {"match": left == right, "localCount": len(left), "remoteCount": len(right),
            "localOnlyCount": len(left.keys() - right.keys()), "remoteOnlyCount": len(right.keys() - left.keys()),
            "changedCount": changed, "localSha256": digest(local), "remoteSha256": digest(remote)}


def compare_catalogs(local, remote):
    left, right = normalize_catalog(local), normalize_catalog(remote)
    categories = {key: category_diff(left["static"][key], right["static"][key], key) for key in sorted(left["static"])}
    match = all(value["match"] for value in categories.values())
    return {"status": "STATIC_MATCH" if match else "STATIC_DIFFERENT", "formatVersion": 1,
            "semanticAssessment": "NOT_ASSESSED",
            "static": {"match": match, "localSha256": digest(left["static"]), "remoteSha256": digest(right["static"]), "categories": categories},
            "context": {"match": left["context"] == right["context"],
                        "changedCount": sum(left["context"][key] != right["context"][key] for key in left["context"]),
                        "localSha256": digest(left["context"]), "remoteSha256": digest(right["context"])},
            "operational": {"cron": category_diff(left["operational"]["cron"], right["operational"]["cron"], "cron")}}


def main(argv=None):
    parser = argparse.ArgumentParser(description="비공개 스키마 catalog 메타데이터 비교")
    parser.add_argument("--local", required=True)
    parser.add_argument("--remote", required=True)
    args = parser.parse_args(argv)
    try:
        result = compare_catalogs(read_private_catalog(args.local), read_private_catalog(args.remote))
    except CatalogError as error:
        print(json.dumps({"status": "INVALID_INPUT", "code": str(error)}))
        return 2
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0 if result["static"]["match"] else 1


if __name__ == "__main__":
    sys.exit(main())
