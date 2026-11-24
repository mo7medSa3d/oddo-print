#!/usr/bin/env python3
"""Generate a private Odoo config; never pass passwords in the process argv."""
import base64
import configparser
import os
import pathlib
import re
import sys
import tempfile


def secret(environ, name):
    filename = environ.get(name + "_FILE", "").strip()
    if filename:
        value = pathlib.Path(filename).read_text().strip()
    else:
        value = environ.get(name, "").strip()
    if not value:
        raise ValueError(name + " or " + name + "_FILE is required")
    return value


def build_config(environ, directory=None):
    database = environ.get("PGDATABASE", "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,62}", database):
        raise ValueError("PGDATABASE must be a single explicit database name")
    for name in ("PGHOST", "PGUSER"):
        if not environ.get(name, "").strip():
            raise ValueError(name + " is required")
    port = environ.get("PGPORT", "5432")
    if not port.isdigit() or not 1 <= int(port) <= 65535:
        raise ValueError("PGPORT must be 1..65535")
    version_name = "ODOO_PRINT_GATEWAY_CREDENTIAL_ACTIVE_VERSION"
    version = secret(environ, version_name) if (environ.get(version_name, "").strip() or environ.get(version_name + "_FILE", "").strip()) else "1"
    if not re.fullmatch(r"[1-9][0-9]*", version):
        raise ValueError("Invalid active credential encryption key version")
    key = secret(environ, "ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V" + version + "_B64")
    try:
        if len(base64.b64decode(key, validate=True)) != 32:
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("Active credential encryption key must encode exactly 32 bytes") from None
    configuration = configparser.ConfigParser(interpolation=None)
    if environ.get("ODOO_CONFIG_FILE"):
        with open(environ["ODOO_CONFIG_FILE"]) as source:
            configuration.read_file(source)
    if not configuration.has_section("options"):
        configuration.add_section("options")
    options = configuration["options"]
    options.update({
        "db_host": environ["PGHOST"], "db_port": port, "db_user": environ["PGUSER"],
        "db_password": secret(environ, "PGPASSWORD"), "db_name": database,
        "dbfilter": "^" + re.escape(database) + "$", "list_db": "False",
        "admin_passwd": secret(environ, "ODOO_ADMIN_PASSWORD"),
        "addons_path": "/opt/odoo/odoo/addons,/opt/odoo/addons,/opt/yaseir-addons,/mnt/extra-addons",
        "data_dir": "/var/lib/odoo",
    })
    # Explicit bounds; operators can supply reviewed worker/resource settings
    # in ODOO_CONFIG_FILE. They must be validated by the staged workload.
    defaults = {"db_maxconn": "32", "workers": "2", "max_cron_threads": "1", "limit_time_cpu": "120", "limit_time_real": "180", "limit_memory_soft": "536870912", "limit_memory_hard": "671088640"}
    for name, value in defaults.items():
        options.setdefault(name, value)
    fd, filename = tempfile.mkstemp(prefix="yaseir-odoo-", suffix=".conf", dir=directory)
    with os.fdopen(fd, "w") as target:
        configuration.write(target)
    return filename


def main():
    os.umask(0o077)
    try:
        filename = build_config(os.environ)
    except configparser.Error:
        # ConfigParser's exception includes the offending source line. An
        # operator configuration may contain passwords, so never reflect it.
        raise SystemExit("Odoo runtime configuration refused: invalid ODOO_CONFIG_FILE") from None
    except (OSError, ValueError) as error:
        # The messages identify missing setting names, never secret contents.
        raise SystemExit("Odoo runtime configuration refused: " + str(error)) from None
    os.execv("/opt/yaseir-venv/bin/python", ["/opt/yaseir-venv/bin/python", "/opt/odoo/odoo-bin", "--config=" + filename, *sys.argv[1:]])


if __name__ == "__main__":
    main()
