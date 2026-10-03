"""민규: 합성 Kong snapshot과 주입한 명령만으로 로컬 CORS 설정 도구의 핵심 경계를 검사한다."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/local"))
import configure_local_gateway as gateway

FUNCTIONS = "11000000-0000-4000-8000-000000000001"
AUTH = "11000000-0000-4000-8000-000000000002"
REST = "11000000-0000-4000-8000-000000000003"
CONTEXT = "colima-yumidang-minkyu"
PROJECT = "yumidang-minkyu-gateway"


def fixture():
    return {
        "_format_version": "2.1", "_transform": False,
        "services": [{"id": FUNCTIONS, "name": "functions-v1", "host": "edge-runtime", "port": 9000, "protocol": "http"},
                     {"id": AUTH, "name": "auth-v1", "host": "auth", "port": 9999, "protocol": "http"},
                     {"id": REST, "name": "rest-v1", "host": "rest", "port": 3000, "protocol": "http"}],
        "routes": [{"id": "12000000-0000-4000-8000-000000000001", "name": "functions-v1", "paths": ["/functions/v1/"], "service": {"id": FUNCTIONS}},
                   {"id": "12000000-0000-4000-8000-000000000002", "name": "auth-v1", "paths": ["/auth/v1/"], "service": {"id": AUTH}}],
        "plugins": [{"id": "13000000-0000-4000-8000-000000000001", "name": "cors", "service": {"id": FUNCTIONS}, "config": {"origins": ["*"], "credentials": True}},
                    {"id": "13000000-0000-4000-8000-000000000002", "name": "cors", "service": {"id": AUTH}, "config": {"origins": ["*"]}},
                    {"id": "13000000-0000-4000-8000-000000000003", "name": "cors", "service": {"id": REST}, "config": {"origins": ["*"]}},
                    {"id": "13000000-0000-4000-8000-000000000004", "name": "request-transformer", "service": {"id": FUNCTIONS}, "config": {"add": {"headers": ["x-synthetic:true"]}}}],
        "consumers": [{"id": "14000000-0000-4000-8000-000000000001", "username": "synthetic-anon"}],
        "keyauth_credentials": [{"id": "15000000-0000-4000-8000-000000000001", "consumer": {"id": "14000000-0000-4000-8000-000000000001"}, "key": "synthetic-credential-preserved"}],
    }


def exported(doc):
    # JSON text is valid YAML and preserves synthetic arrays/maps/bools without adding dependencies.
    return json.dumps({"config": json.dumps(doc)}).encode()


def container():
    return {"Name": "/supabase_kong_" + PROJECT, "State": {"Running": True},
            "Config": {"Image": "public.ecr.aws/supabase/kong:2.8.1", "Labels": {"com.supabase.cli.project": PROJECT},
                       "Env": ["KONG_DATABASE=off", "KONG_DECLARATIVE_CONFIG=/home/kong/kong.yml"]},
            "HostConfig": {"PortBindings": {"8000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "56521"}]}},
            "NetworkSettings": {"Ports": {"8001/tcp": None}}}


class CommandFixture:
    def __init__(self, mismatch=False, native_export=False):
        self.original = fixture()
        self.current = copy.deepcopy(self.original)
        self.posts = []
        self.reads = 0
        self.mismatch = mismatch
        self.native_export = native_export

    def __call__(self, args, **kwargs):
        if args[0] == "/usr/bin/ruby":
            # Only the fixed parser consumes synthetic YAML; no Docker/network operation is executed.
            assert args[:4] == ["/usr/bin/ruby", "-rjson", "-rpsych", "-e"]
            return subprocess.run(args, **kwargs)
        self.assert_safe(args, kwargs)
        if "context" in args:
            output = json.dumps("unix://" + str(Path.home()) + "/.colima/yumidang-minkyu/docker.sock").encode()
        elif "inspect" in args:
            output = json.dumps([container()]).encode()
        elif "/usr/local/bin/resty" in args:
            payload = kwargs.get("input")
            if payload is not None:
                self.current = json.loads(payload)
                self.posts.append(copy.deepcopy(self.current))
                output = b"201\n{}"
            else:
                self.reads += 1
                value = copy.deepcopy(self.current)
                if self.native_export:
                    for collection in ("services", "routes", "plugins"):
                        value[collection].reverse()
                        for item in value[collection]:
                            item["updated_at"] = 1700000000 + self.reads
                if self.mismatch and len(self.posts) == 1:
                    if self.mismatch == "credential":
                        value["keyauth_credentials"][0]["key"] = "synthetic-changed-credential"
                    elif self.mismatch == "id":
                        value["routes"][0]["id"] = "12000000-0000-4000-8000-000000000099"
                    elif self.mismatch == "config":
                        value["plugins"][0]["config"] = {"changed": True}
                    else:
                        value["services"][0]["host"] = "synthetic-semantic-mismatch"
                output = b"200\n" + exported(value)
        else:
            raise AssertionError("unapproved command in fixture")
        return subprocess.CompletedProcess(args, 0, stdout=output, stderr=b"")

    @staticmethod
    def assert_safe(args, kwargs):
        assert args[:3] == ["docker", "--context", CONTEXT]
        assert kwargs.get("capture_output") is True
        assert kwargs.get("timeout") == 20
        assert not any("synthetic-credential-preserved" in part for part in args)


class LocalGatewayConfigTests(unittest.TestCase):
    def test_ruby_parser_preserves_json_types(self):
        value = fixture()
        value["plugins"][0]["config"].update({"empty_list": [], "empty_map": {}, "unset": None, "enabled": False})
        result = gateway.parse_export(exported(value))
        self.assertEqual(result, value)
        self.assertIsInstance(result["plugins"][0]["config"]["empty_list"], list)
        self.assertIsInstance(result["plugins"][0]["config"]["empty_map"], dict)
        self.assertIsNone(result["plugins"][0]["config"]["unset"])
        self.assertIs(result["_transform"], False)

    def test_yaml_alias_duplicates_and_multiple_documents_rejected(self):
        prefix = "_format_version: '2.1'\n_transform: false\n"
        for value in [prefix + "a: &shared []\nb: *shared\n", prefix + "a: 1\na: 2\n", "---\n" + prefix + "---\n" + prefix]:
            with self.subTest(kind=value.splitlines()[0]):
                with self.assertRaises(gateway.GatewayError):
                    gateway.parse_export(json.dumps({"config": value}).encode())

    def test_only_function_cors_removed_and_other_values_preserved(self):
        original = fixture()
        before = copy.deepcopy(original)
        transformed, changed = gateway.transform_document(original)
        expected = copy.deepcopy(before)
        del expected["plugins"][0]
        self.assertTrue(changed)
        self.assertEqual(transformed, expected)
        self.assertEqual(original, before)
        self.assertEqual(transformed["keyauth_credentials"], before["keyauth_credentials"])
        self.assertEqual(transformed["_transform"], False)
        repeated, changed = gateway.transform_document(transformed)
        self.assertFalse(changed)
        self.assertEqual(repeated, transformed)
        snapshot = copy.deepcopy(transformed)
        for collection in ("services", "routes", "plugins"):
            for item in snapshot[collection]:
                item["updated_at"] = 10
        observed = copy.deepcopy(snapshot)
        for collection in ("services", "routes", "plugins"):
            observed[collection].reverse()
            for item in observed[collection]:
                item["updated_at"] = 11
        self.assertTrue(gateway.semantic_equal(snapshot, observed))
        for invalid in (9, True, "11", 11.0):
            altered = copy.deepcopy(observed)
            altered["services"][0]["updated_at"] = invalid
            self.assertFalse(gateway.semantic_equal(snapshot, altered))

    def test_ambiguous_cors_project_or_plugin_shape_rejected(self):
        duplicate = fixture(); duplicate["plugins"].append(copy.deepcopy(duplicate["plugins"][0]))
        invalid = fixture(); invalid["plugins"][1] = "not-a-plugin"
        missing_service = fixture(); missing_service["services"] = [item for item in missing_service["services"] if item["id"] != FUNCTIONS]
        for value in [duplicate, invalid, missing_service]:
            with self.assertRaises(gateway.GatewayError): gateway.transform_document(value)
        endpoint = "unix://" + str(Path.home()) + "/.colima/yumidang-minkyu/docker.sock"
        gateway.validate_target(endpoint, container())
        for field in ["project", "image", "admin_binding"]:
            value = container()
            if field == "project": value["Config"]["Labels"]["com.supabase.cli.project"] = "other-project"
            elif field == "image": value["Config"]["Image"] = "public.ecr.aws/supabase/kong:other"
            else: value["HostConfig"]["PortBindings"]["8001/tcp"] = [{"HostIp": "0.0.0.0", "HostPort": "8001"}]
            with self.assertRaises(gateway.GatewayError): gateway.validate_target(endpoint, value)

    def test_dry_run_never_posts_or_leaks_snapshot(self):
        command = CommandFixture()
        report = gateway.configure_local_gateway(run=command)
        self.assertEqual(command.posts, [])
        self.assertGreaterEqual(command.reads, 1)
        self.assertNotIn("synthetic-credential-preserved", json.dumps(report))
        self.assertNotIn(FUNCTIONS, json.dumps(report))
        self.assertEqual(command.current, command.original)

    def test_semantic_mismatch_restores_original_snapshot(self):
        native = CommandFixture(native_export=True)
        report = gateway.configure_local_gateway(apply=True, run=native)
        self.assertEqual(report["status"], "PASS")
        self.assertTrue(report["applied"])
        self.assertEqual(len(native.posts), 1)
        for mutation in ("host", "credential", "id", "config"):
            with self.subTest(mutation=mutation):
                command = CommandFixture(mismatch=mutation, native_export=True)
                report = gateway.configure_local_gateway(apply=True, run=command)
                self.assertEqual(report["status"], "FAIL")
                self.assertTrue(report["restored"])
                self.assertEqual(len(command.posts), 2)
                expected_original = copy.deepcopy(command.original)
                for collection in ("services", "routes", "plugins"):
                    expected_original[collection].reverse()
                    for item in expected_original[collection]:
                        item["updated_at"] = 1700000001
                self.assertEqual(command.posts[0], gateway.transform_document(expected_original)[0])
                self.assertEqual(command.posts[1], expected_original)
                self.assertEqual(command.current, expected_original)
                self.assertGreaterEqual(command.reads, 3)
                self.assertNotIn("synthetic-credential-preserved", json.dumps(report))


if __name__ == "__main__":
    unittest.main()
