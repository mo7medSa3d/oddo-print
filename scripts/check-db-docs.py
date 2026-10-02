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

CREATE_RE = re.compile(r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?', re.I)
DROP_RE = re.compile(r'DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?', re.I)
PGTABLE_RE = re.compile(r"pgTable\(\s*['\"]([A-Za-z0-9_]+)['\"]")


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
    for sql in sorted(MIGRATIONS.glob("*.sql")):
        text = sql.read_text()
        for name in CREATE_RE.findall(text):
            created.setdefault(name, sql.name)
        dropped.update(DROP_RE.findall(text))

    current = set(created) - dropped

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

    print(f"schema.ts tables     : {len(schema_tables)}")
    print(f"migration files      : {len(list(MIGRATIONS.glob('*.sql')))}")
    print(f"tables created       : {len(created)}")
    print(f"legacy tables dropped: {len(dropped)}")
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
