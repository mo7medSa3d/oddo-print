"""Schema parity between src/db/schema.ts (21 tables) and drizzle/0000_initial_schema.sql."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "src" / "db" / "schema.ts"
INITIAL_SQL = ROOT / "drizzle" / "0000_initial_schema.sql"

EXPECTED_TABLES = sorted([
    "api_keys",
    "audit_events",
    "auth_rate_limits",
    "email_verification_tokens",
    "gateway_metrics",
    "manager_sessions",
    "odoo_installation_credentials",
    "odoo_installations",
    "password_reset_tokens",
    "plans",
    "platform_session_security",
    "platform_sessions",
    "refresh_tokens",
    "subscription_changes",
    "subscription_requests",
    "tenant_invitations",
    "tenant_subscriptions",
    "tenant_users",
    "tenants",
    "users",
    "workspace_session_security",
])

DROPPED_TABLES = [
    "agents",
    "printers",
    "print_jobs",
    "print_job_receipts",
    "print_monthly_usage",
    "job_events",
    "discovered_devices",
    "discovery_sessions",
    "odoo_v2_operations",
    "odoo_legacy_resolutions",
    "tenant_domains",
]


def test_print_job_receipts_and_legacy_tables_removed():
    schema = SCHEMA.read_text(encoding="utf-8")
    sql = INITIAL_SQL.read_text(encoding="utf-8")
    for table in DROPPED_TABLES:
        assert f'pgTable("{table}"' not in schema, f"schema.ts still defines dropped table {table}"
        assert f'CREATE TABLE "{table}"' not in sql, f"0000_initial_schema.sql still defines dropped table {table}"


def test_initial_ddl_covers_all_21_schema_tables():
    schema = SCHEMA.read_text(encoding="utf-8")
    sql = INITIAL_SQL.read_text(encoding="utf-8")
    schema_tables = sorted(re.findall(r'pgTable\("([^"]+)"', schema))
    sql_tables = sorted(re.findall(r'CREATE TABLE "([^"]+)"', sql))
    assert schema_tables == EXPECTED_TABLES
    assert sql_tables == EXPECTED_TABLES
    assert len(sql_tables) == 21


def test_initial_ddl_has_no_legacy_print_triggers():
    sql = INITIAL_SQL.read_text(encoding="utf-8")
    assert "print_job_receipts_tenant_idempotency_unique" not in sql
    assert "ON print_jobs" not in sql
