"""Migration contract guards for the 21-table License-Only Control Plane Drizzle schema."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SQL = ROOT / "drizzle/0000_initial_schema.sql"


def test_initial_migration_contains_odoo_installation_tables_and_excludes_legacy_relay():
    sql = SQL.read_text(encoding="utf-8")
    assert 'CREATE TABLE "odoo_installations"' in sql
    assert 'CREATE TABLE "odoo_installation_credentials"' in sql
    assert 'CREATE TABLE "odoo_v2_operations"' not in sql
    assert 'CREATE TABLE "odoo_legacy_resolutions"' not in sql
    assert '"odoo_idempotency_mode"' in sql
    assert "DROP TABLE" not in sql


def test_installation_tables_have_database_level_uniqueness_and_tenant_fks():
    sql = SQL.read_text(encoding="utf-8")
    assert 'CONSTRAINT "odoo_installations_tenant_id_unique" UNIQUE("tenant_id", "id")' in sql
    assert 'PRIMARY KEY("tenant_id", "installation_id", "api_key_id")' in sql
    assert 'REFERENCES "public"."tenants"' in sql


def test_initial_migration_registered_in_drizzle_journal():
    doc = json.loads((ROOT / "drizzle/meta/_journal.json").read_text(encoding="utf-8"))
    tags = [row["tag"] for row in doc["entries"]]
    assert tags == ["0000_initial_schema"]
    assert tags == [p.stem for p in sorted((ROOT / "drizzle").glob("*.sql"))]
    assert (ROOT / "drizzle/meta/0000_initial_schema_snapshot.json").is_file()


def test_rotation_preserves_installation_ownership():
    source = (ROOT / "src/app/api/odoo/keys/[id]/rotate/route.ts").read_text(encoding="utf-8")
    assert "INSERT INTO odoo_installation_credentials" in source
    assert "SELECT tenant_id, installation_id" in source
    assert "api_key_id" in source


def test_legacy_resolutions_route_returns_410_gone():
    source = (ROOT / "src/app/api/odoo/installations/resolutions/route.ts").read_text(encoding="utf-8")
    assert "status: 410" in source
    assert "odoo_v2_operations" not in source


def test_auto_enrollment_requires_explicit_legacy_cutover_and_api_keys_can_be_shared():
    schema = (ROOT / "src/db/schema.ts").read_text(encoding="utf-8")
    endpoint = (ROOT / "src/app/api/odoo/installations/auto/route.ts").read_text(encoding="utf-8")
    assert 'tenant.rows[0].mode !== "strict_v2"' in endpoint
    assert 'return "legacy_workspace" as const' in endpoint
    assert 'code: "RECONCILIATION_REQUIRED"' in endpoint
    assert "FOR UPDATE" in endpoint
    assert "UPDATE tenants SET odoo_idempotency_mode" not in endpoint
    assert 'odooIdempotencyMode: text("odoo_idempotency_mode").notNull().default("strict_v2")' in schema
    assert "odoo_installation_credentials_tenant_api_key_unique" not in schema
