"""Static regression for a narrow cron transaction fence (no Odoo runtime here).

This is intentionally marked as a *source-contract check*, not a live Odoo
integration test; a PostgreSQL/Odoo staging deployment must exercise the
savepoint rollback behavior and the fallback job-status lookup end to end.
"""
import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway/models/print_job.py"


def test_missing_gateway_job_reconciliation_isolated_before_batch_fallback():
    tree = ast.parse(SRC.read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "PrintGatewayJob")
    cron = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "cron_sync_status")
    calls = [n for n in ast.walk(cron) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "_mark_gateway_job_missing"]
    assert len(calls) == 1
    with_nodes = [n for n in ast.walk(cron) if isinstance(n, ast.With) and any(
        isinstance(item.context_expr, ast.Call) and isinstance(item.context_expr.func, ast.Attribute) and
        item.context_expr.func.attr == "savepoint" for item in n.items
    )]
    assert any(w.lineno < calls[0].lineno <= w.end_lineno for w in with_nodes)
