#!/usr/bin/env python3
"""Verify that the Drizzle schema, the SQL migrations and docs/DATABASE.md agree.

This check exists because database documentation rots silently: a table is
added to ``src/db/schema.ts``, a migration is generated, and the reference doc
keeps describing the old world. It runs on the Python standard library alone,
so it works in CI containers that have no Node toolchain installed.

Exit status is non-zero when any of these invariants break:

* every table in ``schema.ts`` is created by exactly one migration;
* no migration creates a table that is neither in ``schema.ts`` nor dropped
  again by a later migration;
* every current table is documented in ``docs/DATABASE.md``.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "src" / "db" / "schema.ts"
MIGRATIONS = ROOT / "drizzle"
DATABASE_DOC = ROOT / "docs" / "DATABASE.md"
ARCHITECTURE_DOC = ROOT / "ARCHITECTURE.md"

# Schema-qualified names are important: moving provider event history into
# legacy_billing is not a new public table or a dropped audit record.
IDENT = r'(?:(?P<schema>"?[A-Za-z_][A-Za-z0-9_]*"?)\s*\.\s*)?(?P<table>"?[A-Za-z_][A-Za-z0-9_]*"?)(?![A-Za-z0-9_$]|\s*\.)'
CREATE_RE = re.compile(r'\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?!IF\b)' + IDENT, re.I)
DROP_RE = re.compile(r'\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?' + IDENT, re.I)
MOVE_RE = re.compile(r'\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?' + IDENT +
                     r'\s+SET\s+SCHEMA\s+"?([A-Za-z_][A-Za-z0-9_]*)"?', re.I)
PGTABLE_RE = re.compile(r"pgTable\(\s*['\"]([A-Za-z0-9_]+)['\"]")

def object_name(match: re.Match[str]) -> tuple[str, str]:
    return (match.group("schema") or "public").strip('"').lower(), match.group("table").strip('"').lower()



def main() -> int:
    problems: list[str] = []

    if not SCHEMA.is_file():
        print(f"FAIL: schema not found at {SCHEMA}")
        return 1

    schema_tables = set(PGTABLE_RE.findall(SCHEMA.read_text()))
    if not schema_tables:
        problems.append("no pgTable() declarations found in schema.ts")

    created: dict[str, str] = {}
    dropped: set[str] = set()
    archived: set[str] = set()
    for sql in sorted(MIGRATIONS.glob("*.sql")):
        text = sql.read_text()
        for match in CREATE_RE.finditer(text):
            schema, name = object_name(match)
            if schema == "public":
                created.setdefault(name, sql.name)
        for match in DROP_RE.finditer(text):
            schema, name = object_name(match)
            if schema == "public":
                dropped.add(name)
        for match in MOVE_RE.finditer(text):
            schema, name = object_name(match)
            destination = match.group(3).lower()
            if schema == "public" and destination == "legacy_billing":
                archived.add(name)

    # Forward repairs retain immutable ledger hashes; this checks DDL in them
    # without treating schema-qualified metadata tables as application tables.
    repairs = (ROOT / "scripts" / "db-migrate.ts").read_text()
    for match in CREATE_RE.finditer(repairs):
        schema, name = object_name(match)
        if schema == "public":
            created.setdefault(name, "scripts/db-migrate.ts")
    current = set(created) - dropped - archived

    for table in sorted(schema_tables - set(created)):
        problems.append(f"{table}: declared in schema.ts but never created by a migration")
    for table in sorted(schema_tables & dropped):
        problems.append(f"{table}: declared in schema.ts but dropped by a migration")
    for table in sorted(current - schema_tables):
        problems.append(f"{table}: created by {created[table]} and never dropped, but missing from schema.ts")

    if DATABASE_DOC.is_file():
        doc = DATABASE_DOC.read_text()
        for table in sorted(current):
            if f"`{table}`" not in doc:
                problems.append(f"{table}: missing from docs/DATABASE.md")
    else:
        problems.append("docs/DATABASE.md is missing")

    if ARCHITECTURE_DOC.is_file():
        architecture = ARCHITECTURE_DOC.read_text()
        schema_line = f"**Schema**: {len(schema_tables)} tables defined in `src/db/schema.ts`"
        migration_files = sorted(MIGRATIONS.glob("*.sql"))
        if schema_line not in architecture:
            problems.append(f"ARCHITECTURE.md: expected schema count line: {schema_line}")
        if migration_files:
            first = migration_files[0].stem.split("_", 1)[0]
            last = migration_files[-1].stem.split("_", 1)[0]
            if len(migration_files) == 1:
                migration_line = f"**Migrations**: 1 clean initial migration (`{first}`) in `drizzle/`"
            else:
                migration_line = f"**Migrations**: {len(migration_files)} forward-only migrations (`{first}`–`{last}`) in `drizzle/`"
            if migration_line not in architecture:
                problems.append(f"ARCHITECTURE.md: expected migration count/range line: {migration_line}")
    else:
        problems.append("ARCHITECTURE.md is missing")

    print(f"schema.ts tables     : {len(schema_tables)}")
    print(f"migration files      : {len(list(MIGRATIONS.glob('*.sql')))}")
    print(f"tables created       : {len(created)}")
    print(f"legacy tables dropped: {len(dropped)}")
    print(f"legacy tables archived: {len(archived)}")
    print(f"current tables       : {len(current)}")

    if problems:
        print("\nDRIFT DETECTED:")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    print("\nOK: schema.ts, migrations and docs/DATABASE.md are in sync.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
