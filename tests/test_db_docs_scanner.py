"""Regression checks for qualified archive DDL in the database-doc scanner."""

from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_db_docs", ROOT / "scripts" / "check-db-docs.py")
assert SPEC and SPEC.loader
SCANNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCANNER)


def test_qualified_archive_schema_is_not_misread_as_public_table():
    sql = "CREATE TABLE IF NOT EXISTS legacy_printing.${table} (id text)"
    assert list(SCANNER.CREATE_RE.finditer(sql)) == []


def test_unqualified_and_explicit_public_tables_remain_detected():
    for sql in (
        "CREATE TABLE IF NOT EXISTS print_jobs (id text)",
        "CREATE TABLE IF NOT EXISTS public.print_jobs (id text)",
    ):
        match = SCANNER.CREATE_RE.search(sql)
        assert match is not None
        assert SCANNER.object_name(match) == ("public", "print_jobs")


def test_named_archive_table_retains_its_schema():
    match = SCANNER.CREATE_RE.search("CREATE TABLE IF NOT EXISTS legacy_printing.print_jobs (id text)")
    assert match is not None
    assert SCANNER.object_name(match) == ("legacy_printing", "print_jobs")
