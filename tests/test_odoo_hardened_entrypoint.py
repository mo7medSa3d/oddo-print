import base64
import configparser
import importlib.util
import pathlib
import stat
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("odoo_hardened_entrypoint", ROOT / "scripts/odoo-hardened-entrypoint.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class OdooHardenedEntrypointTest(unittest.TestCase):
    def environment(self, directory):
        environment = {"PGHOST": "synthetic-postgres", "PGPORT": "5432", "PGUSER": "synthetic", "PGDATABASE": "synthetic_odoo", "ODOO_PRINT_GATEWAY_CREDENTIAL_ACTIVE_VERSION": "1"}
        for name, value in {"PGPASSWORD": "synthetic-db-password", "ODOO_ADMIN_PASSWORD": "synthetic-admin-password", "ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V1_B64": base64.b64encode(b"x" * 32).decode()}.items():
            file = pathlib.Path(directory) / name
            file.write_text(value)
            environment[name + "_FILE"] = str(file)
        return environment

    def test_private_config_keeps_secret_values_out_of_arguments_and_fences_database(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = MODULE.build_config(self.environment(directory), directory)
            self.assertEqual(stat.S_IMODE(pathlib.Path(filename).stat().st_mode), 0o600)
            config = configparser.ConfigParser(interpolation=None)
            config.read(filename)
            self.assertEqual(config["options"]["db_password"], "synthetic-db-password")
            self.assertEqual(config["options"]["dbfilter"], "^synthetic_odoo$")
            self.assertEqual(config["options"]["list_db"], "False")
            self.assertEqual(config["options"]["data_dir"], "/var/lib/odoo")
            self.assertIn("/opt/yaseir-addons", config["options"]["addons_path"])

    def test_database_list_and_wildcard_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = self.environment(directory)
            for database in ("", ".*", "db,other", "db\nadmin_passwd=bad"):
                with self.subTest(database=database), self.assertRaises(ValueError):
                    MODULE.build_config(dict(environment, PGDATABASE=database), directory)

    def test_missing_or_invalid_credential_key_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = self.environment(directory)
            for key in ("not-base64", base64.b64encode(b"x" * 31).decode()):
                pathlib.Path(environment["ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V1_B64_FILE"]).write_text(key)
                with self.assertRaisesRegex(ValueError, "exactly 32 bytes"):
                    MODULE.build_config(environment, directory)

    def test_missing_database_secret_fails_without_secret_value_in_message(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = self.environment(directory)
            del environment["PGPASSWORD_FILE"]
            with self.assertRaisesRegex(ValueError, "PGPASSWORD"):
                MODULE.build_config(environment, directory)

    def test_operator_resource_limits_are_preserved_but_identity_is_pinned(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = self.environment(directory)
            config = pathlib.Path(directory) / "reviewed.conf"
            config.write_text("[options]\nworkers=3\nlimit_time_real=60\ndbfilter=.*\n")
            filename = MODULE.build_config(dict(environment, ODOO_CONFIG_FILE=str(config)), directory)
            parsed = configparser.ConfigParser(interpolation=None); parsed.read(filename)
            self.assertEqual(parsed["options"]["workers"], "3")
            self.assertEqual(parsed["options"]["limit_time_real"], "60")
            self.assertEqual(parsed["options"]["dbfilter"], "^synthetic_odoo$")

    def test_malformed_operator_config_never_reflects_its_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = self.environment(directory)
            config = pathlib.Path(directory) / "malformed.conf"
            sentinel = "synthetic-secret-that-must-not-appear-in-diagnostics"
            config.write_text("admin_passwd=" + sentinel + "\n")
            environment["ODOO_CONFIG_FILE"] = str(config)
            old_umask = MODULE.os.umask(0o077)
            try:
                with patch.dict(MODULE.os.environ, environment, clear=True):
                    with self.assertRaises(SystemExit) as refused:
                        MODULE.main()
            finally:
                MODULE.os.umask(old_umask)
            self.assertNotIn(sentinel, str(refused.exception))
            self.assertIn("invalid ODOO_CONFIG_FILE", str(refused.exception))

    def test_file_backed_active_key_version_takes_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = self.environment(directory)
            del environment["ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V1_B64_FILE"]
            version = pathlib.Path(directory) / "active-version"
            version.write_text("2\n")
            key = pathlib.Path(directory) / "version-two-key"
            key.write_text(base64.b64encode(b"y" * 32).decode())
            environment["ODOO_PRINT_GATEWAY_CREDENTIAL_ACTIVE_VERSION_FILE"] = str(version)
            environment["ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V2_B64_FILE"] = str(key)
            filename = MODULE.build_config(environment, directory)
            self.assertEqual(stat.S_IMODE(pathlib.Path(filename).stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
