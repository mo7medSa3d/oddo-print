"""Execute the real ownership migration against a small SQL database offline."""
import runpy
import sqlite3
from pathlib import Path

import pytest


MIGRATION = Path(__file__).resolve().parents[1] / (
    "odoo_addons/print_gateway/migrations/19.0.2.14.0/pre-migrate.py"
)


class Cursor:
    def __init__(self):
        self.connection = sqlite3.connect(":memory:")
        self.cursor = self.connection.cursor()

    def execute(self, query):
        if query == "SELECT to_regclass('print_gateway_intent')":
            query = "SELECT (SELECT name FROM sqlite_master WHERE name = 'print_gateway_intent')"
        return self.cursor.execute(query)

    def fetchone(self):
        return self.cursor.fetchone()

    def fetchall(self):
        return self.cursor.fetchall()


@pytest.fixture
def cr():
    cursor = Cursor()
    cursor.connection.executescript("""
        CREATE TABLE print_gateway_intent (id INTEGER PRIMARY KEY, company_id INTEGER,
            print_job_id INTEGER, res_model TEXT, res_id INTEGER);
        CREATE TABLE print_gateway_print_job (id INTEGER PRIMARY KEY, company_id INTEGER);
        CREATE TABLE account_move (id INTEGER PRIMARY KEY, company_id INTEGER);
        CREATE TABLE stock_picking (id INTEGER PRIMARY KEY, company_id INTEGER);
        CREATE TABLE sale_order (id INTEGER PRIMARY KEY, company_id INTEGER);
        CREATE TABLE purchase_order (id INTEGER PRIMARY KEY, company_id INTEGER);
        CREATE TABLE pos_order (id INTEGER PRIMARY KEY, company_id INTEGER);
    """)
    yield cursor
    cursor.connection.close()


def test_company_backfill_preserves_owned_rows_and_uses_durable_job_before_source(cr):
    cr.connection.executescript("""
        INSERT INTO sale_order VALUES (10, 7);
        INSERT INTO print_gateway_print_job VALUES (20, 4);
        INSERT INTO print_gateway_intent VALUES (1, 9, NULL, 'sale.order', 10);
        INSERT INTO print_gateway_intent VALUES (2, NULL, 20, 'sale.order', 10);
        INSERT INTO print_gateway_intent VALUES (3, NULL, NULL, 'sale.order', 10);
    """)
    migrate = runpy.run_path(str(MIGRATION))["migrate"]
    migrate(cr, "19.0.2.13.0")
    migrate(cr, "19.0.2.13.0")
    cr.execute("SELECT id, company_id FROM print_gateway_intent ORDER BY id")
    assert cr.fetchall() == [(1, 9), (2, 4), (3, 7)]


def test_unknown_company_blocks_upgrade_instead_of_guessing_from_policy_or_default(cr):
    cr.execute("INSERT INTO print_gateway_intent VALUES (4, NULL, NULL, 'sale.order', 999)")
    with pytest.raises(RuntimeError, match=r"ids=\[4\]"):
        runpy.run_path(str(MIGRATION))["migrate"](cr, "19.0.2.13.0")


def test_fresh_install_and_pre_intent_schema_are_safe():
    cursor = Cursor()
    try:
        migrate = runpy.run_path(str(MIGRATION))["migrate"]
        migrate(cursor, None)
        migrate(cursor, "19.0.1.1.0")
    finally:
        cursor.connection.close()
