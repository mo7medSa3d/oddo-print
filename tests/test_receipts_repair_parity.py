"""Column-level parity between the schema.ts receipts table and its
forward-repair DDL.

``print_job_receipts`` is created by ``AUDIT_REPAIRS`` in
``scripts/db-migrate.ts`` (the audit may not add versioned migration files),
not by a ``drizzle/*.sql`` file. Table-name parity is already enforced by
``scripts/check-db-docs.py``; this test pins column/constraint parity so the
two definitions cannot drift silently (a missing column in either direction
breaks fresh installs or drizzle-kit diffs).
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "src" / "db" / "schema.ts"
REPAIRS = ROOT / "scripts" / "db-migrate.ts"

EXPECTED_COLUMNS = [
    "id",
    "tenant_id",
    "idempotency_key",
    "fingerprint",
    "printer_id",
    "agent_id",
    "api_key_id",
    "destination",
    "document_type",
    "requested_by",
    "status",
    "error",
    "closed_claim_token_hash",
    "delivered_at",
    "acked_at",
    "created_at",
    "updated_at",
]


def _receipts_block() -> str:
    text = SCHEMA.read_text()
    start = text.index('pgTable("print_job_receipts"')
    end = text.index("}));", start)
    return text[start:end]


def test_schema_receipts_columns_all_expected():
    block = _receipts_block()
    for column in EXPECTED_COLUMNS:
        assert f'"{column}"' in block, f"schema.ts receipts table lost column {column}"


def test_repair_ddl_covers_every_schema_column():
    repairs = REPAIRS.read_text()
    create_at = repairs.index("CREATE TABLE IF NOT EXISTS print_job_receipts")
    ddl = repairs[create_at : repairs.index(";", create_at)]
    for column in EXPECTED_COLUMNS:
        assert re.search(rf"\b{column}\b", ddl), f"AUDIT_REPAIRS receipts DDL missing column {column}"


def test_repair_ddl_preserves_constraints():
    repairs = REPAIRS.read_text()
    assert "print_job_receipts_tenant_idempotency_unique" in repairs
    # The repair DDL declares the status CHECK inline (auto-named by PG)
    # while schema.ts names it print_job_receipts_status_check: equivalent
    # enforcement, different catalog name (drizzle-kit cosmetic drift only;
    # repairs are content-hashed so historical DDL is immutable).
    create_at = repairs.index("CREATE TABLE IF NOT EXISTS print_job_receipts")
    ddl = repairs[create_at : repairs.index(";", create_at)]
    for status in ("success", "failed", "expired"):
        assert status in ddl
    # Historical rows may carry NULL requesters; the v2 repair keeps the
    # column nullable to match schema.ts (requestedBy without .notNull()).
    assert "ALTER TABLE print_job_receipts ALTER COLUMN requested_by DROP NOT NULL" in repairs
    schema_requested_by = re.search(r'requestedBy:\s*text\("requested_by"\)([^\n,]*)', _receipts_block())
    assert schema_requested_by and ".notNull()" not in schema_requested_by.group(1)
