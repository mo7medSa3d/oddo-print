# -*- coding: utf-8 -*-
"""Database-backed UTC clock for deterministic Odoo scheduling decisions."""

def db_now_utc(cr):
    """Return PostgreSQL's current UTC timestamp as a naive UTC datetime."""
    cr.execute("SELECT NOW() AT TIME ZONE 'UTC'")
    row = cr.fetchone()
    if not row or row[0] is None:
        raise RuntimeError("Unable to read the PostgreSQL UTC clock.")
    return row[0]
