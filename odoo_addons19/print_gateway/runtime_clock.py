# -*- coding: utf-8 -*-
"""Database-backed wall-clock UTC for Odoo timeout and retry decisions.

PostgreSQL NOW() freezes at transaction start; print leases and backoff must not.
"""

def db_now_utc(cr):
    """Return PostgreSQL's current UTC timestamp as a naive UTC datetime."""
    cr.execute("SELECT clock_timestamp() AT TIME ZONE 'UTC'")
    row = cr.fetchone()
    if not row or row[0] is None:
        raise RuntimeError("Unable to read the PostgreSQL UTC clock.")
    return row[0]
