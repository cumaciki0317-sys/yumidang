"""합성 catalog만으로 차이 검출·엄격 입력·비공개 출력 경계를 검사한다."""
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/local"))
import compare_schema_catalog as comparison


def fixture():
    acl = [{"grantor": "postgres", "grantee": "authenticated", "privilege": "EXECUTE", "isGrantable": False},
           {"grantor": "postgres", "grantee": "postgres", "privilege": "EXECUTE", "isGrantable": False}]
    table = {"schema": "public", "table": "posts", "kind": "r", "owner": "postgres", "rls": True, "forceRls": False}
    column = {"schema": "public", "table": "posts", "column": "id", "position": 1, "type": "uuid", "notNull": True,
              "identity": "", "generated": "", "collation": None, "defaultMd5": "1" * 32}
    function = {"schema": "public", "name": "get_post", "identityArguments": "p_id uuid", "result": "jsonb",
                "argumentsMd5": "2" * 32, "kind": "f", "language": "plpgsql", "owner": "postgres", "volatility": "s",
                "definer": True, "strict": False, "parallel": "u", "bodyMd5": "3" * 32, "searchPath": '""',
                "configurationMd5": "9" * 32, "acl": acl}
    policy = {"schema": "public", "table": "posts", "name": "read_posts", "command": "r", "permissive": True,
              "roles": ["anon", "authenticated"], "usingMd5": "4" * 32, "checkMd5": None}
    grant = {"grantor": "postgres", "grantee": "authenticated", "privilege": "SELECT", "isGrantable": False}
    return {"formatVersion": 1, "context": {"serverVersionNum": 170006, "serverVersion": "17.6", "deparseSearchPath": "pg_catalog"},
            "operational": {"cron": [{"name": "yumidang-auto-complete-appointments", "schedule": "* * * * *", "active": True, "commandMd5": "5" * 32}]},
            "static": {
                "schemas": [{"schema": "private", "owner": "postgres"}, {"schema": "public", "owner": "postgres"}],
                "tables": [table], "columns": [column, {**column, "column": "title", "position": 2, "type": "text", "defaultMd5": None}],
                "indexes": [{"schema": "public", "table": "posts", "name": "posts_pkey", "method": "btree", "unique": True,
                             "primary": True, "valid": True, "ready": True, "keyCount": 1, "definitionMd5": "6" * 32}],
                "constraints": [{"schema": "public", "table": "posts", "name": "posts_pkey", "type": "p", "validated": True,
                                 "deferrable": False, "initiallyDeferred": False, "definitionMd5": "7" * 32, "foreignTarget": None}],
                "policies": [policy], "storagePolicies": [{**policy, "schema": "storage", "table": "objects", "name": "profile_images_insert_own"}],
                "triggers": [{"schema": "public", "table": "posts", "name": "posts_changed", "enabled": "O", "definitionMd5": "8" * 32}],
                "functions": [function, {**function, "name": "no_arguments", "identityArguments": "", "searchPath": None, "configurationMd5": None, "acl": []}],
                "schemaGrants": [{"schema": "public", **grant, "privilege": "USAGE"}],
                "tableGrants": [{"schema": "public", "table": "posts", **grant}],
                "columnGrants": [{"schema": "public", "table": "posts", "column": "title", **grant}],
                "defaultGrants": [{"owner": "postgres", "schema": None, "objectType": "r", **grant},
                                  {"owner": "postgres", "schema": "public", "objectType": "r", **grant}],
                "migrationVersions": ["20260916080335", "20260916101123"],
            }}


class CatalogComparisonTests(unittest.TestCase):
    def setUp(self):
        self.local = fixture()
        self.remote = copy.deepcopy(self.local)
        self.temporary = tempfile.TemporaryDirectory(dir="/private/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.base.chmod(0o700)

    def result(self):
        return comparison.compare_catalogs(self.local, self.remote)

    def write(self, name, value):
        path = self.base / name
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        return path

    def cli(self, local, remote):
        output = io.StringIO()
        with redirect_stdout(output):
            code = comparison.main(["--local", str(local), "--remote", str(remote)])
        return code, json.loads(output.getvalue()), output.getvalue()

    def test_object_keys_inventory_and_set_order_are_ignored(self):
        def reorder(value):
            if isinstance(value, dict):
                return {key: reorder(item) for key, item in reversed(list(value.items()))}
            if isinstance(value, list):
                return [reorder(item) for item in reversed(value)]
            return value
        self.remote = reorder(self.remote)
        result = self.result()
        self.assertEqual(result["status"], "STATIC_MATCH")
        self.assertTrue(result["context"]["match"])
        self.assertTrue(result["operational"]["cron"]["match"])
        self.assertEqual(result["static"]["localSha256"], result["static"]["remoteSha256"])

    def test_hash_changes_detect_body_defaults_policies_and_definitions(self):
        for category, key in [("functions", "bodyMd5"), ("functions", "argumentsMd5"), ("columns", "defaultMd5"),
                              ("indexes", "definitionMd5"), ("constraints", "definitionMd5"), ("policies", "usingMd5"),
                              ("storagePolicies", "usingMd5"), ("triggers", "definitionMd5")]:
            with self.subTest(category=category, key=key):
                self.remote = copy.deepcopy(self.local)
                self.remote["static"][category][0][key] = "a" * 32
                result = self.result()
                self.assertEqual(result["status"], "STATIC_DIFFERENT")
                self.assertEqual(result["static"]["categories"][category]["changedCount"], 1)
                self.assertEqual(result["semanticAssessment"], "NOT_ASSESSED")

    def test_grant_roles_and_grant_options_are_not_ignored(self):
        for category in ("schemaGrants", "tableGrants", "columnGrants", "defaultGrants"):
            with self.subTest(category=category):
                self.remote = copy.deepcopy(self.local)
                self.remote["static"][category][0]["grantee"] = "unexpected_role"
                result = self.result()["static"]["categories"][category]
                self.assertFalse(result["match"])
                self.assertEqual((result["localOnlyCount"], result["remoteOnlyCount"]), (1, 1))
                self.remote = copy.deepcopy(self.local)
                self.remote["static"][category][0]["isGrantable"] = True
                self.assertEqual(self.result()["static"]["categories"][category]["changedCount"], 1)

    def test_function_search_path_configuration_acl_and_owner_change(self):
        for change in [{"searchPath": "public", "configurationMd5": "a" * 32},
                       {"configurationMd5": "b" * 32},
                       {"owner": "different_owner"}, {"definer": False}, {"acl": []}]:
            with self.subTest(change=list(change)):
                self.remote = copy.deepcopy(self.local)
                self.remote["static"]["functions"][0].update(change)
                self.assertEqual(self.result()["static"]["categories"]["functions"]["changedCount"], 1)

    def test_column_position_is_meaningful_even_when_input_order_changes(self):
        self.remote["static"]["columns"][0]["position"] = 2
        self.remote["static"]["columns"][1]["position"] = 1
        self.remote["static"]["columns"].reverse()
        self.assertEqual(self.result()["static"]["categories"]["columns"]["changedCount"], 2)

    def test_additional_storage_policy_and_removed_function_are_inventory_differences(self):
        additional = {**self.remote["static"]["storagePolicies"][0], "name": "additional_public_policy"}
        self.remote["static"]["storagePolicies"].append(additional)
        self.remote["static"]["functions"].pop()
        result = self.result()["static"]["categories"]
        self.assertEqual(result["storagePolicies"]["remoteOnlyCount"], 1)
        self.assertEqual(result["functions"]["localOnlyCount"], 1)

    def test_duplicate_identities_rejected_in_all_inventories(self):
        for category in comparison.STATIC_CATEGORIES:
            with self.subTest(category=category):
                self.remote = copy.deepcopy(self.local)
                self.remote["static"][category].append(copy.deepcopy(self.remote["static"][category][0]))
                with self.assertRaisesRegex(comparison.CatalogError, "DUPLICATE_IDENTITY"):
                    self.result()
        self.remote = copy.deepcopy(self.local)
        self.remote["operational"]["cron"] *= 2
        with self.assertRaisesRegex(comparison.CatalogError, "DUPLICATE_IDENTITY"):
            self.result()

    def test_duplicate_positions_roles_and_function_acl_rejected(self):
        for mutate in [lambda s: s["columns"][1].update(position=1),
                       lambda s: s["policies"][0]["roles"].append("anon"),
                       lambda s: s["functions"][0]["acl"].append(copy.deepcopy(s["functions"][0]["acl"][0]))]:
            self.remote = copy.deepcopy(self.local)
            mutate(self.remote["static"])
            with self.assertRaisesRegex(comparison.CatalogError, "DUPLICATE_IDENTITY"):
                self.result()

    def test_missing_or_unexpected_keys_and_wrong_types_fail_closed(self):
        mutations = [lambda v: v.pop("operational"), lambda v: v.update(capturedAt="2026-10-03T00:00:00Z"),
                     lambda v: v["static"].pop("columnGrants"), lambda v: v["static"].update(extra=[]),
                     lambda v: v["static"]["functions"][0].pop("searchPath"),
                     lambda v: v["static"]["functions"][0].update(body="private SQL body"),
                     lambda v: v["static"]["functions"][0].update(configuration=["app.api_key=private_key_marker"]),
                     lambda v: v["static"]["functions"][0].update(configurationMd5="private_key_marker"),
                     lambda v: v["static"]["columns"][0].update(position=True),
                     lambda v: v["static"]["tables"][0].update(rls=1),
                     lambda v: v["static"]["functions"][0].update(bodyMd5="raw SQL text"),
                     lambda v: v["static"]["columns"][0].update(column=None),
                     lambda v: v["static"].update(tables={}), lambda v: v.update(formatVersion=True),
                     lambda v: v["context"].update(serverVersionNum=False),
                     lambda v: v["context"].update(deparseSearchPath="public")]
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index):
                self.remote = copy.deepcopy(self.local)
                mutate(self.remote)
                with self.assertRaises(comparison.CatalogError):
                    self.result()

    def test_json_duplicate_keys_floats_nan_and_invalid_utf8_rejected(self):
        for value in [b'{"formatVersion":1,"formatVersion":1}', b'{"a":1.0}', b'{"a":NaN}', b'\xff', b'[] trailing']:
            with self.subTest(dataLength=len(value)), self.assertRaises(comparison.CatalogError):
                comparison.parse_catalog(value)

    def test_context_and_operational_changes_are_reported_separately(self):
        self.remote["context"].update(serverVersionNum=170007, serverVersion="17.7")
        self.remote["operational"]["cron"][0].update(schedule="0 0 * * *", commandMd5="f" * 32)
        result = self.result()
        self.assertEqual(result["status"], "STATIC_MATCH")
        self.assertEqual(result["context"]["changedCount"], 2)
        self.assertEqual(result["operational"]["cron"]["changedCount"], 1)

    def test_cli_exit_codes_and_output_exclude_input_names_paths_and_body(self):
        local = self.write("local.json", self.local)
        remote = self.write("remote.json", self.remote)
        code, result, text = self.cli(local, remote)
        self.assertEqual((code, result["status"]), (0, "STATIC_MATCH"))
        self.remote["static"]["tables"][0]["owner"] = "private_owner_marker"
        remote.write_text(json.dumps(self.remote))
        code, result, text = self.cli(local, remote)
        self.assertEqual((code, result["status"]), (1, "STATIC_DIFFERENT"))
        for secret in ["private_owner_marker", str(self.base), "posts", "postgres", "profile_images_insert_own"]:
            self.assertNotIn(secret, text)
        self.remote["static"]["functions"][0]["body"] = "private_body_marker"
        remote.write_text(json.dumps(self.remote))
        code, result, text = self.cli(local, remote)
        self.assertEqual((code, result["status"]), (2, "INVALID_INPUT"))
        self.assertNotIn("private_body_marker", text)

    def test_private_file_permissions_symlinks_and_hardlinks_rejected(self):
        path = self.write("catalog.json", self.local)
        self.assertEqual(comparison.read_private_catalog(path), self.local)
        path.chmod(0o644)
        with self.assertRaises(comparison.CatalogError):
            comparison.read_private_catalog(path)
        path.chmod(0o600)
        symlink = self.base / "symlink.json"
        symlink.symlink_to(path)
        with self.assertRaises(comparison.CatalogError):
            comparison.read_private_catalog(symlink)
        hardlink = self.base / "hardlink.json"
        os.link(path, hardlink)
        with self.assertRaises(comparison.CatalogError):
            comparison.read_private_catalog(path)
        hardlink.unlink()
        self.base.chmod(0o755)
        with self.assertRaises(comparison.CatalogError):
            comparison.read_private_catalog(path)
        self.base.chmod(0o700)


if __name__ == "__main__":
    unittest.main()
