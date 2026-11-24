"""O-6: automation intent history must not be deletable (audit trail)."""
from pathlib import Path

CSV = Path(__file__).resolve().parent.parent / "odoo_addons" / "print_gateway" / "security" / "ir.model.access.csv"


def _row(prefix):
    for line in CSV.read_text(encoding="utf-8").splitlines():
        if line.startswith(prefix + ","):
            return line
    raise AssertionError(f"missing ACL row {prefix}")


def test_intent_admin_cannot_unlink():
    row = _row("access_print_gateway_intent_admin")
    assert row.rstrip().endswith(",1,1,1,0"), f"intent admin must have perm_unlink=0, got: {row}"


def test_print_job_admin_cannot_unlink():
    row = _row("access_print_gateway_print_job_admin")
    assert row.rstrip().endswith(",1,1,1,0"), f"print_job admin must have perm_unlink=0, got: {row}"
